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
						Some("response" | "snapshot" | "session" | "fatal")
					) =>
				{
					value
				},
				Ok(_) => return "Engine emitted an invalid frame envelope".into(),
				Err(error) => return format!("Engine emitted invalid JSON: {error}"),
			};
			if let Err(error) = emit(&app, value) {
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
			| "model.set"
			| "settings.get"
			| "settings.set"
			| "auth.setKey"
			| "question.answer"
			| "diff.get"
			| "tools.list"
			| "tools.set"
			| "goal.operate"
			| "shutdown"
	) {
		return Err("Unknown engine method".into());
	}
	let mut bytes = serde_json::to_vec(&request).map_err(|error| error.to_string())?;
	if bytes.len() > MAX_FRAME {
		return Err("Request exceeds 8 MiB".into());
	}
	bytes.push(b'\n');
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

fn main() {
	let app = tauri::Builder::default()
		.plugin(tauri_plugin_dialog::init())
		.invoke_handler(tauri::generate_handler![engine_request, select_project])
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
