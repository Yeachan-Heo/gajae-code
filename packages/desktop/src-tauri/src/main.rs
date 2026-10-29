#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
	process::Stdio,
	sync::{
		Arc,
		atomic::{AtomicBool, Ordering},
	},
	time::Duration,
};

use serde_json::{Value, json};
use tauri::{Emitter, Manager};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;
use tokio::{
	io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
	process::{Child, ChildStdin, Command},
	sync::{mpsc, oneshot, watch},
};

const MAX_FRAME: usize = 8 * 1024 * 1024;
const IO_TIMEOUT: Duration = Duration::from_secs(5);
const EXIT_GRACE: Duration = Duration::from_secs(3);

struct WriteRequest {
	bytes: Vec<u8>,
	reply: oneshot::Sender<Result<(), String>>,
}

struct Engine {
	requests: mpsc::Sender<WriteRequest>,
	shutdown: watch::Sender<bool>,
	stopped:  watch::Receiver<bool>,
	quitting: AtomicBool,
	cleaned:  AtomicBool,
}

fn emit(app: &tauri::AppHandle, frame: Value) -> Result<(), String> {
	app.emit_to(tauri::EventTarget::webview_window("main"), "engine-frame", frame)
		.map_err(|error| error.to_string())
}

fn fatal(app: &tauri::AppHandle, error: &str) {
	// Engine failures otherwise exist only in the webview; keep them in the
	// process log so a broken engine can be diagnosed after the app is gone.
	eprintln!("desktop engine fatal: {error}");
	let _ = emit(app, json!({"type": "fatal", "error": error}));
}

fn command() -> Result<Command, String> {
	#[cfg(debug_assertions)]
	{
		let bun = option_env!("GJC_DESKTOP_BUN").ok_or(
			"Set GJC_DESKTOP_BUN to the absolute workspace Bun executable before compiling the \
			 desktop app",
		)?;
		let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
		let mut command = Command::new(bun);
		command.arg(root.join("packages/desktop-host/src/index.ts"));
		command.current_dir(root);
		Ok(command)
	}
	#[cfg(not(debug_assertions))]
	{
		// Tauri externalBin bundles the target-suffixed source beside the app
		// executable.
		let executable = std::env::current_exe().map_err(|error| error.to_string())?;
		let directory = executable
			.parent()
			.ok_or("Cannot locate desktop executable directory")?;
		let binary = if cfg!(windows) {
			"gjc-desktop-host.exe"
		} else {
			"gjc-desktop-host"
		};
		Ok(Command::new(directory.join(binary)))
	}
}

async fn write_frame(stdin: &mut ChildStdin, bytes: &[u8]) -> Result<(), String> {
	tokio::time::timeout(IO_TIMEOUT, stdin.write_all(bytes))
		.await
		.map_err(|_| "Engine write timed out; request outcome is unknown".to_string())?
		.map_err(|error| format!("Engine write failed; request outcome is unknown: {error}"))
}

async fn read_frames(stdout: tokio::process::ChildStdout, app: tauri::AppHandle) -> String {
	read_frames_from(stdout, |value| emit(&app, value)).await
}

/// Frame reader shared by the supervisor and its tests. `deliver` receives one
/// complete frame at a time; the returned string is the terminal error, if any.
async fn read_frames_from<R, F>(stdout: R, mut deliver: F) -> String
where
	R: tokio::io::AsyncRead + Unpin,
	F: FnMut(Value) -> Result<(), String>,
{
	let mut reader = BufReader::new(stdout);
	let mut frame = Vec::new();
	loop {
		let available = match reader.fill_buf().await {
			Ok(bytes) if bytes.is_empty() => return "Engine stdout closed unexpectedly".into(),
			Ok(bytes) => bytes,
			Err(error) => return format!("Engine stdout failed: {error}"),
		};
		let newline = available.iter().position(|byte| *byte == b'\n');
		let count = newline.map_or(available.len(), |index| index);
		if frame.len() + count > MAX_FRAME {
			return "Engine frame exceeds 8 MiB".into();
		}
		frame.extend_from_slice(&available[..count]);
		reader.consume(count + usize::from(newline.is_some()));
		if newline.is_some() {
			let value = match serde_json::from_slice::<Value>(&frame) {
				Ok(value)
					if matches!(
						value.get("type").and_then(Value::as_str),
						Some("response" | "snapshot" | "session" | "auth" | "activity" | "gate" | "operator" | "fatal")
					) =>
				{
					value
				},
				Ok(_) => return "Engine emitted an invalid frame envelope".into(),
				Err(error) => {
					let head = String::from_utf8_lossy(&frame[..frame.len().min(160)]);
					let tail = String::from_utf8_lossy(&frame[frame.len().saturating_sub(160)..]);
					return format!(
						"Engine emitted invalid JSON at {} bytes: {error}; head={head:?} tail={tail:?}",
						frame.len()
					);
				},
			};
			if let Err(error) = deliver(value) {
				return format!("Cannot deliver engine frame: {error}");
			}
			frame.clear();
		}
	}
}

async fn stop_child(child: &mut Child, stdin: &mut ChildStdin) {
	let shutdown = b"{\"id\":\"native-shutdown\",\"method\":\"shutdown\",\"params\":{}}\n";
	let _ = tokio::time::timeout(EXIT_GRACE, async {
		stdin.write_all(shutdown).await?;
		stdin.shutdown().await?;
		child.wait().await
	})
	.await;
	// Kill then reap within a second bounded interval. Tokio's kill-on-drop
	// process guard remains responsible for OS cleanup if that interval expires.
	if !matches!(child.try_wait(), Ok(Some(_))) {
		let _ = child.start_kill();
		match tokio::time::timeout(EXIT_GRACE, child.wait()).await {
			Ok(Ok(_)) => {},
			Ok(Err(error)) => eprintln!("Cannot reap desktop engine: {error}"),
			Err(_) => eprintln!("Desktop engine reap timed out after kill"),
		}
	}
}

async fn supervise(
	app: tauri::AppHandle,
	mut requests: mpsc::Receiver<WriteRequest>,
	mut shutdown: watch::Receiver<bool>,
	stopped: watch::Sender<bool>,
) {
	let first = tokio::select! {
		 biased;
		 _ = shutdown.changed() => None,
		 request = requests.recv() => request,
	};
	let Some(first) = first else {
		let _ = stopped.send(true);
		return;
	};
	let spawned = command().and_then(|mut command| {
		command
			.stdin(Stdio::piped())
			.stdout(Stdio::piped())
			.stderr(Stdio::inherit())
			.kill_on_drop(true)
			.spawn()
			.map_err(|error| format!("Cannot start desktop engine: {error}"))
	});
	let mut child = match spawned {
		Ok(child) => child,
		Err(error) => {
			fatal(&app, &error);
			let _ = first.reply.send(Err(error));
			let _ = stopped.send(true);
			return;
		},
	};
	let Some(mut stdin) = child.stdin.take() else {
		let error = "Engine stdin pipe unavailable";
		fatal(&app, error);
		let _ = first.reply.send(Err(error.into()));
		let _ = child.start_kill();
		let _ = tokio::time::timeout(EXIT_GRACE, child.wait()).await;
		let _ = stopped.send(true);
		return;
	};
	let Some(stdout) = child.stdout.take() else {
		let error = "Engine stdout pipe unavailable";
		fatal(&app, error);
		let _ = first.reply.send(Err(error.into()));
		stop_child(&mut child, &mut stdin).await;
		let _ = stopped.send(true);
		return;
	};
	let mut reader = tauri::async_runtime::spawn(read_frames(stdout, app.clone()));
	let result = write_frame(&mut stdin, &first.bytes).await;
	let mut failure = result.as_ref().err().cloned();
	let _ = first.reply.send(result);
	while failure.is_none() && !*shutdown.borrow() {
		tokio::select! {
			 biased;
			 _ = shutdown.changed() => break,
			 result = &mut reader => failure = Some(match result {
				  Ok(error) => error,
				  Err(error) => format!("Engine stdout reader failed: {error}"),
			 }),
			 status = child.wait() => {
				  failure = Some(match status {
						Ok(status) => format!("Desktop engine exited unexpectedly: {status}"),
						Err(error) => format!("Cannot supervise desktop engine: {error}"),
				  });
			 }
			 request = requests.recv() => {
				  let Some(request) = request else { break; };
				  let result = write_frame(&mut stdin, &request.bytes).await;
				  failure = result.as_ref().err().cloned();
				  let _ = request.reply.send(result);
			 }
		}
	}
	requests.close();
	if let Some(error) = &failure {
		fatal(&app, error);
	}
	while let Ok(request) = requests.try_recv() {
		let _ = request.reply.send(Err(
			failure
				.clone()
				.unwrap_or_else(|| "Desktop engine is shutting down".into()),
		));
	}
	stop_child(&mut child, &mut stdin).await;
	reader.abort();
	let _ = stopped.send(true);
}

fn encode_engine_request(request: &Value) -> Result<Vec<u8>, String> {
	let object = request.as_object().ok_or("Invalid request envelope")?;
	let id = object
		.get("id")
		.and_then(Value::as_str)
		.ok_or("Request id must be a string")?;
	if id.encode_utf16().count() > 128 {
		return Err("Request id exceeds 128 characters".into());
	}
	if !object.get("params").is_some_and(Value::is_object) {
		return Err("Request params must be an object".into());
	}
	let method = object
		.get("method")
		.and_then(Value::as_str)
		.ok_or("Request method must be a string")?;
	if !matches!(
		method,
		"bootstrap"
			| "project.open"
			| "session.create"
			| "session.select"
			| "session.rename"
			| "session.delete"
			| "session.star"
			| "session.fork"
			| "session.compact"
			| "session.retry"
			| "session.export"
			| "prompt"
			| "abort"
			| "models.list"
			| "model.set"
			| "thinking.set"
			| "settings.get"
			| "settings.set"
			| "auth.setKey"
			| "auth.providers"
			| "auth.keyProviders"
			| "auth.login"
			| "auth.state"
			| "auth.answer"
			| "auth.cancel"
			| "question.answer"
			| "command.list"
			| "command.run"
			| "history.get"
			| "activity.get"
			| "activity.detail"
			| "activity.operate"
			| "activity.acknowledge"
			| "preferences.get"
			| "preferences.apply"
			| "gate.present"
			| "gate.presented"
			| "gate.answer"
			| "gate.withdraw"
			| "gate.retired"
			| "operator.execute"
			| "operator.get"
			| "operator.abort"
			| "operator.fold"
			| "btw.open"
			| "btw.get"
			| "btw.submit"
			| "btw.cancel"
			| "btw.close"
			| "mcp.get"
			| "mcp.operate"
			| "session.info"
			| "queue.cancel"
			| "diff.get"
			| "tools.list"
			| "tools.set"
			| "goal.operate"
			| "shutdown"
	) {
		return Err("Unknown engine method".into());
	}
	let mut bytes = serde_json::to_vec(request).map_err(|error| error.to_string())?;
	if bytes.len() > MAX_FRAME {
		return Err("Request exceeds 8 MiB".into());
	}
	bytes.push(b'\n');
	Ok(bytes)
}

#[tauri::command]
async fn engine_request(
	window: tauri::WebviewWindow,
	engine: tauri::State<'_, Arc<Engine>>,
	request: Value,
) -> Result<(), String> {
	if window.label() != "main" {
		return Err("Only the main window may use the engine".into());
	}
	if engine.quitting.load(Ordering::Acquire) {
		return Err("Desktop app is quitting".into());
	}
	let bytes = encode_engine_request(&request)?;
	let (reply, response) = oneshot::channel();
	engine
		.requests
		.try_send(WriteRequest { bytes, reply })
		.map_err(|error| match error {
			mpsc::error::TrySendError::Full(_) => {
				"Engine request queue is full; request was not sent".to_string()
			},
			mpsc::error::TrySendError::Closed(_) => {
				"Engine transport is closed; reopen the application to start a new engine".to_string()
			},
		})?;
	response.await.map_err(|_| {
		"Engine transport stopped before confirming the write; request outcome is unknown".to_string()
	})?
}

fn validate_auth_url(value: &str) -> Result<tauri::Url, String> {
	if value.len() > 8192 || value.chars().any(char::is_control) {
		return Err("Invalid authorization URL".into());
	}
	let url = tauri::Url::parse(value).map_err(|_| "Invalid authorization URL".to_string())?;
	if url.scheme() != "https"
		|| url.host_str().is_none()
		|| !url.username().is_empty()
		|| url.password().is_some()
	{
		return Err("Authorization requires an HTTPS URL without user information".into());
	}
	Ok(url)
}

#[tauri::command]
async fn open_auth_url(
	window: tauri::WebviewWindow,
	app: tauri::AppHandle,
	url: String,
) -> Result<(), String> {
	if window.label() != "main" {
		return Err("Only the main window may open authorization URLs".into());
	}
	let url = validate_auth_url(&url)?;
	app.opener()
		.open_url(url.as_str(), None::<&str>)
		.map_err(|_| "Cannot open authorization browser".to_string())
}

#[tauri::command]
async fn select_project(
	window: tauri::WebviewWindow,
	app: tauri::AppHandle,
) -> Result<Option<String>, String> {
	if window.label() != "main" {
		return Err("Only the main window may select a project".into());
	}
	let (sender, receiver) = oneshot::channel();
	app.dialog()
		.file()
		.set_title("Open project")
		.pick_folder(move |folder| {
			let result = folder
				.map(|path| {
					path
						.into_path()
						.map_err(|error| error.to_string())
						.and_then(|path| {
							path
								.into_os_string()
								.into_string()
								.map_err(|_| "Project path is not UTF-8".to_string())
						})
				})
				.transpose();
			let _ = sender.send(result);
		});
	receiver
		.await
		.map_err(|_| "Folder dialog closed without a result".to_string())?
}

#[cfg(test)]
mod tests {
	use std::{
		pin::Pin,
		task::{Context, Poll},
	};

	use serde_json::{Value, json};
	use tokio::io::{AsyncRead, ReadBuf};

	use super::{encode_engine_request, validate_auth_url};

	/// Feeds at most `limit` bytes per `poll_read`, the way a pipe hands the
	/// reader an 8 KiB `BufReader` fill at a time.
	struct Chunked {
		data:  Vec<u8>,
		at:    usize,
		limit: usize,
	}

	impl AsyncRead for Chunked {
		fn poll_read(
			mut self: Pin<&mut Self>,
			_cx: &mut Context<'_>,
			buf: &mut ReadBuf<'_>,
		) -> Poll<std::io::Result<()>> {
			let remaining = self.data.len() - self.at;
			if remaining == 0 {
				return Poll::Ready(Ok(()));
			}
			let count = remaining.min(self.limit).min(buf.remaining());
			let start = self.at;
			let end = start + count;
			buf.put_slice(&self.data[start..end]);
			self.at = end;
			Poll::Ready(Ok(()))
		}
	}

	/// Fixture streams end with EOF, which the production reader reports as a
	/// closed pipe; tests treat that terminator as a clean end.
	async fn frames(input: &[u8], limit: usize) -> (String, Vec<Value>) {
		let mut delivered = Vec::new();
		let error =
			super::read_frames_from(Chunked { data: input.to_vec(), at: 0, limit }, |value| {
				delivered.push(value);
				Ok(())
			})
			.await;
		let error = if error == "Engine stdout closed unexpectedly" {
			String::new()
		} else {
			error
		};
		(error, delivered)
	}

	#[test]
	fn admits_every_advertised_host_method_through_the_native_encoder() {
		let protocol = include_str!("../../../desktop-host/src/protocol.ts");
		let methods = protocol
			.split_once("export const DESKTOP_METHODS = [")
			.expect("host protocol must declare its method catalog")
			.1
			.split_once("] as const;")
			.expect("host method catalog must have a closing declaration")
			.0;
		let mut count = 0;
		for line in methods
			.lines()
			.map(str::trim)
			.filter(|line| !line.is_empty())
		{
			let method: String = serde_json::from_str(line.trim_end_matches(',')).unwrap();
			let request = json!({"id": "native-contract", "method": method,
				"params": {"sessionId": "native-owner", "text": "/usage", "offset": 0, "limit": 500}});
			let bytes = encode_engine_request(&request).unwrap_or_else(|error| {
				panic!("Advertised method {} was rejected: {error}", request["method"])
			});
			assert_eq!(bytes.last(), Some(&b'\n'));
			assert_eq!(serde_json::from_slice::<Value>(&bytes[..bytes.len() - 1]).unwrap(), request);
			count += 1;
		}
		assert!(count > 0, "method catalog must not be empty");
	}

	#[test]
	fn refuses_unknown_methods_and_invalid_request_envelopes() {
		assert!(
			encode_engine_request(&json!({
				"id": "𠮷".repeat(64), "method": "command.run", "params": {"text": "/usage"}
			}))
			.is_ok()
		);
		for (request, expected) in [
			(
				json!({"id": "native-contract", "method": "untrusted.execute", "params": {}}),
				"Unknown engine method",
			),
			(
				json!({"id": "native-contract", "method": "prompt", "params": []}),
				"Request params must be an object",
			),
			(json!({"id": 1, "method": "prompt", "params": {}}), "Request id must be a string"),
			(
				json!({"id": "𠮷".repeat(65), "method": "prompt", "params": {}}),
				"Request id exceeds 128 characters",
			),
			(
				json!({"id": "native-contract", "method": "prompt", "params": {"text": "x".repeat(super::MAX_FRAME)}}),
				"Request exceeds 8 MiB",
			),
			(json!([]), "Invalid request envelope"),
		] {
			assert_eq!(encode_engine_request(&request).err().as_deref(), Some(expected));
		}
	}

	#[tokio::test]
	async fn preserves_activity_gate_and_operator_frames_in_native_order() {
		let expected = vec![
			json!({"type": "activity", "update": {"sessionId": "owner", "revision": 2,
				"activity": {"available": false, "reason": "unavailable"}}}),
			json!({"type": "gate", "sessionId": "owner", "event": {"type": "presented",
				"presentation": {"id": "surface", "gate": {"kind": "approval"}}}}),
			json!({"type": "gate", "sessionId": "owner", "event": {"type": "retire",
				"presentationId": "surface", "nonce": "exact-retirement"}}),
			json!({"type": "operator", "sessionId": "owner", "event": {"type": "operator.updated",
				"operation": {"operationId": "operation", "status": "running", "output": "확인"}}}),
		];
		let mut input = Vec::new();
		for frame in &expected {
			input.extend(serde_json::to_vec(frame).unwrap());
			input.push(b'\n');
		}
		for limit in [1, 7, 64, input.len()] {
			let (error, delivered) = frames(&input, limit).await;
			assert!(error.is_empty(), "limit {limit}: {error}");
			assert_eq!(delivered, expected, "limit {limit}");
		}
		let (error, delivered) = frames(b"{\"type\":\"untrusted.control\"}\n", 1).await;
		assert_eq!(error, "Engine emitted an invalid frame envelope");
		assert!(delivered.is_empty());
	}

	#[tokio::test]
	async fn delivers_a_frame_larger_than_a_pipe_buffer() {
		let payload = "x".repeat(400_000);
		let frame = json!({"type": "snapshot", "snapshot": {"blob": payload}});
		let mut input = serde_json::to_vec(&frame).unwrap();
		let expected = input.len();
		input.push(b'\n');
		for limit in [1024, 8192, 65_536, expected] {
			let (error, delivered) = frames(&input, limit).await;
			assert!(error.is_empty(), "limit {limit}: {error}");
			assert_eq!(delivered.len(), 1, "limit {limit}");
			assert_eq!(delivered[0], frame, "limit {limit}");
		}
	}

	#[tokio::test]
	async fn keeps_frame_order_and_boundaries() {
		let first = json!({"type": "snapshot", "snapshot": {"blob": "y".repeat(200_000)}});
		let second = json!({"type": "response", "id": "1", "ok": true, "result": null});
		let third = json!({"type": "fatal", "error": "boom"});
		let mut input = Vec::new();
		for frame in [&first, &second, &third] {
			input.extend(serde_json::to_vec(frame).unwrap());
			input.push(b'\n');
		}
		let (error, delivered) = frames(&input, 8192).await;
		assert!(error.is_empty(), "{error}");
		assert_eq!(delivered, vec![first, second, third]);
	}

	#[tokio::test]
	async fn rejects_truncated_json_and_unknown_envelopes() {
		let (error, delivered) =
			frames(b"{\"type\":\"snapshot\",\"snapshot\":{\"blob\"\n", 8192).await;
		assert!(error.starts_with("Engine emitted invalid JSON"), "{error}");
		assert!(delivered.is_empty());
		let (error, _) = frames(b"{\"type\":\"unexpected\"}\n", 8192).await;
		assert_eq!(error, "Engine emitted an invalid frame envelope");
	}

	#[tokio::test]
	async fn rejects_a_frame_over_the_limit() {
		let mut input = b"{\"type\":\"fatal\",\"error\":\"".to_vec();
		input.extend(std::iter::repeat_n(b'z', super::MAX_FRAME + 1));
		input.extend(b"\"}");
		let (error, delivered) = frames(&input, 65_536).await;
		assert_eq!(error, "Engine frame exceeds 8 MiB");
		assert!(delivered.is_empty());
	}

	#[cfg(unix)]
	#[tokio::test]
	async fn shutdown_delivers_protocol_frame_and_reaps_child() {
		let mut child = super::Command::new("/bin/sh")
			.arg("-c")
			.arg(
				r#"IFS= read -r line; case "$line" in *'"method":"shutdown"'*) exit 0;; *) exit 9;; esac"#,
			)
			.stdin(super::Stdio::piped())
			.stdout(super::Stdio::null())
			.stderr(super::Stdio::null())
			.kill_on_drop(true)
			.spawn()
			.unwrap();
		let mut stdin = child.stdin.take().unwrap();
		super::stop_child(&mut child, &mut stdin).await;
		assert_eq!(child.try_wait().unwrap().unwrap().code(), Some(0));
	}

	#[cfg(unix)]
	#[tokio::test]
	async fn shutdown_kills_and_reaps_unresponsive_child() {
		let mut child = super::Command::new("/bin/sleep")
			.arg("60")
			.stdin(super::Stdio::piped())
			.stdout(super::Stdio::null())
			.stderr(super::Stdio::null())
			.kill_on_drop(true)
			.spawn()
			.unwrap();
		let mut stdin = child.stdin.take().unwrap();
		super::stop_child(&mut child, &mut stdin).await;
		assert!(!child.try_wait().unwrap().unwrap().success());
	}

	#[test]
	fn permits_https_provider_authorization_parameters() {
		let url = validate_auth_url("https://auth.example.com/authorize?state=opaque&redirect_uri=http%3A%2F%2Flocalhost%3A1455").unwrap();
		assert_eq!(url.scheme(), "https");
		assert_eq!(url.host_str(), Some("auth.example.com"));
		assert!(url.query().unwrap().contains("state=opaque"));
	}

	#[test]
	fn rejects_non_web_schemes_credentials_and_controls() {
		for value in [
			"http://example.com",
			"file:///etc/passwd",
			"javascript:alert(1)",
			"data:text/html,test",
			"https://user:secret@example.com/",
			"https://example.com/\nnext",
			"not-a-url",
		] {
			assert!(validate_auth_url(value).is_err(), "accepted {value}");
		}
		assert!(validate_auth_url(&format!("https://example.com/{}", "x".repeat(8192))).is_err());
	}
}

fn main() {
	let app = tauri::Builder::default()
		.plugin(tauri_plugin_dialog::init())
		.plugin(tauri_plugin_opener::init())
		.invoke_handler(tauri::generate_handler![engine_request, select_project, open_auth_url])
		.setup(|app| {
			let (requests, receiver) = mpsc::channel(8);
			let (shutdown, shutdown_receiver) = watch::channel(false);
			let (stopped_sender, stopped) = watch::channel(false);
			app.manage(Arc::new(Engine {
				requests,
				shutdown,
				stopped,
				quitting: AtomicBool::new(false),
				cleaned: AtomicBool::new(false),
			}));
			tauri::async_runtime::spawn(supervise(
				app.handle().clone(),
				receiver,
				shutdown_receiver,
				stopped_sender,
			));
			Ok(())
		})
		.on_window_event(|window, event| {
			if window.label() == "main" {
				if let tauri::WindowEvent::CloseRequested { api, .. } = event {
					api.prevent_close();
					let _ = window.hide();
				}
			}
		})
		.build(tauri::generate_context!())
		.expect("Cannot initialize Gajae Code desktop");
	app.run(|app, event| match event {
		tauri::RunEvent::ExitRequested { api, .. } => {
			let engine = app.state::<Arc<Engine>>().inner().clone();
			if engine.cleaned.load(Ordering::Acquire) {
				return;
			}
			api.prevent_exit();
			if engine.quitting.swap(true, Ordering::AcqRel) {
				return;
			}
			let app = app.clone();
			tauri::async_runtime::spawn(async move {
				let _ = engine.shutdown.send(true);
				let mut stopped = engine.stopped.clone();
				while !*stopped.borrow_and_update() {
					if stopped.changed().await.is_err() {
						break;
					}
				}
				engine.cleaned.store(true, Ordering::Release);
				app.exit(0);
			});
		},
		#[cfg(target_os = "macos")]
		tauri::RunEvent::Reopen { .. } => {
			if let Some(window) = app.get_webview_window("main") {
				let _ = window.show();
				let _ = window.set_focus();
			}
		},
		_ => {},
	});
}
