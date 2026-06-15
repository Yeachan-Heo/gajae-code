//! PTY-backed interactive command execution exported via N-API.
//!
//! # Overview
//! Provides a stateful PTY session that supports streaming output and stdin
//! passthrough while a command is running.

#[cfg(windows)]
use std::sync::atomic::{AtomicBool, Ordering};
use std::{
	collections::HashMap,
	io::{Read, Write},
	str,
	sync::{Arc, Mutex, mpsc},
	time::{Duration, Instant},
};

use napi::{
	bindgen_prelude::*,
	threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode},
};
use napi_derive::napi;
use portable_pty::{Child, CommandBuilder, PtySize, native_pty_system};

use crate::{ps, task};

/// Options for running a command in a PTY session.
#[napi(object)]
pub struct PtyStartOptions<'env> {
	/// Command string to execute.
	pub command: String,
	/// Working directory for command execution.
	pub cwd: Option<String>,
	/// Environment variables for this command.
	pub env: Option<HashMap<String, String>>,
	/// Timeout in milliseconds before cancelling.
	pub timeout_ms: Option<u32>,
	/// Abort signal for cancelling the operation.
	pub signal: Option<Unknown<'env>>,
	/// PTY column count.
	pub cols: Option<u16>,
	/// PTY row count.
	pub rows: Option<u16>,
	/// Shell binary to use (e.g. "sh", "bash", or an absolute path).
	/// Defaults to "sh" if not provided.
	pub shell: Option<String>,
}

/// Result of a PTY command run.
#[napi(object)]
pub struct PtyRunResult {
	/// Exit code when the command completes.
	pub exit_code: Option<i32>,
	/// Whether command was cancelled by signal/user kill.
	pub cancelled: bool,
	/// Whether command timed out.
	pub timed_out: bool,
}

#[derive(Clone)]
struct PtyRunConfig {
	command: String,
	cwd: Option<String>,
	env: Option<HashMap<String, String>>,
	cols: u16,
	rows: u16,
	shell: Option<String>,
}

enum ReaderEvent {
	Chunk(String),
	Loss { dropped_chunks: usize, dropped_bytes: usize },
	Done,
}

enum ControlMessage {
	Input(String),
	Resize { cols: u16, rows: u16 },
	Kill,
}

const CONTROL_MESSAGES_PER_TICK: usize = 64;
const READER_EVENTS_PER_TICK: usize = 256;
const POST_CANCEL_DRAIN_TIMEOUT: Duration = Duration::from_millis(300);
const POST_EXIT_DRAIN_TIMEOUT: Duration = Duration::from_millis(300);
#[cfg(not(windows))]
const FINAL_READER_DRAIN_TIMEOUT: Duration = Duration::from_millis(50);
const READER_EVENT_QUEUE_CAPACITY: usize = 1024;
const READER_LOSS_MARKER_PREFIX: &str = "\n[PTY output truncated: ";
const TERMINATED_REAP_TIMEOUT: Duration = Duration::from_secs(2);
#[cfg(windows)]
static WINDOWS_OPENPTY_IN_FLIGHT: AtomicBool = AtomicBool::new(false);

struct PtySessionCore {
	control_tx: mpsc::Sender<ControlMessage>,
}

impl Drop for PtySessionCore {
	fn drop(&mut self) {
		let _ = self.control_tx.send(ControlMessage::Kill);
	}
}
impl Drop for PtySession {
	fn drop(&mut self) {
		if let Ok(mut guard) = self.core.lock() {
			if let Some(core) = guard.take() {
				let _ = core.control_tx.send(ControlMessage::Kill);
			}
		}
	}
}

/// Stateful PTY session for interactive stdin/stdout passthrough.
#[napi]
pub struct PtySession {
	core: Arc<Mutex<Option<PtySessionCore>>>,
}

impl Default for PtySession {
	fn default() -> Self {
		Self::new()
	}
}

#[napi]
impl PtySession {
	#[napi(constructor)]
	pub fn new() -> Self {
		Self { core: Arc::new(Mutex::new(None)) }
	}

	/// Start a PTY command and stream output chunks via callback.
	#[napi]
	pub fn start<'env>(
		&self,
		env: &'env Env,
		options: PtyStartOptions<'env>,
		#[napi(ts_arg_type = "((error: Error | null, chunk: string) => void) | undefined | null")]
		on_chunk: Option<ThreadsafeFunction<String>>,
	) -> Result<PromiseRaw<'env, PtyRunResult>> {
		let run_config = PtyRunConfig {
			command: options.command,
			cwd: options.cwd,
			env: options.env,
			cols: options.cols.unwrap_or(120).clamp(20, 400),
			rows: options.rows.unwrap_or(40).clamp(5, 200),
			shell: options.shell,
		};
		let ct = task::CancelToken::new(options.timeout_ms, options.signal);
		let core = Arc::clone(&self.core);

		// Register control channel synchronously so write()/kill() work immediately.
		let (control_tx, control_rx) = mpsc::channel::<ControlMessage>();
		{
			let mut guard = core
				.lock()
				.map_err(|_| Error::from_reason("PTY session lock poisoned"))?;
			if guard.is_some() {
				return Err(Error::from_reason("PTY session already running"));
			}
			*guard = Some(PtySessionCore { control_tx });
		}
		let future = task::future(env, "pty.start", async move {
			let run_result =
				tokio::task::spawn_blocking(move || run_pty_sync(run_config, on_chunk, control_rx, ct))
					.await;

			// Always clear core regardless of result.
			let mut guard = core
				.lock()
				.map_err(|_| Error::from_reason("PTY session lock poisoned"))?;
			*guard = None;
			drop(guard);

			match run_result {
				Ok(inner) => inner,
				Err(err) => Err(Error::from_reason(format!("PTY execution task failed: {err}"))),
			}
		});
		if future.is_err() {
			let mut guard = self
				.core
				.lock()
				.map_err(|_| Error::from_reason("PTY session lock poisoned"))?;
			*guard = None;
		}
		future
	}

	/// Write raw input bytes to PTY stdin.
	#[napi]
	pub fn write(&self, data: String) -> Result<()> {
		self.send_control(ControlMessage::Input(data))
	}

	/// Resize the active PTY.
	#[napi]
	pub fn resize(&self, cols: u16, rows: u16) -> Result<()> {
		self.send_control(ControlMessage::Resize {
			cols: cols.clamp(20, 400),
			rows: rows.clamp(5, 200),
		})
	}

	/// Force-kill the active PTY command.
	#[napi]
	pub fn kill(&self) -> Result<()> {
		self.send_control(ControlMessage::Kill)
	}
}

impl PtySession {
	fn send_control(&self, message: ControlMessage) -> Result<()> {
		let guard = self
			.core
			.lock()
			.map_err(|_| Error::from_reason("PTY session lock poisoned"))?;
		let core = guard
			.as_ref()
			.ok_or_else(|| Error::from_reason("PTY session is not running"))?;
		core
			.control_tx
			.send(message)
			.map_err(|_| Error::from_reason("PTY session is no longer available"))
	}
}

fn terminate_pty_processes(
	child: &mut Box<dyn Child + Send + Sync>,
	child_pid: Option<i32>,
	process_group_id: Option<i32>,
) {
	let mut targets = ps::TerminationTargets::new();
	if let Some(pgid) = process_group_id {
		targets.add_pgid(pgid);
	}
	if let Some(pid) = child_pid {
		targets.add_pid(pid);
	}

	targets.signal(ps::TERM_SIGNAL);
	let _ = child.kill();
	targets.signal(ps::KILL_SIGNAL);
}
fn reap_terminated_child(
	child: &mut Box<dyn Child + Send + Sync>,
	deadline: Instant,
) -> Result<Option<i32>> {
	loop {
		if let Some(status) = child
			.try_wait()
			.map_err(|err| Error::from_reason(format!("Failed checking PTY status: {err}")))?
		{
			return Ok(Some(i32::try_from(status.exit_code()).unwrap_or(i32::MAX)));
		}
		if Instant::now() >= deadline {
			return Ok(None);
		}
		std::thread::sleep(Duration::from_millis(10));
	}
}
struct PostSpawnSetupGuard {
	child: Option<Box<dyn Child + Send + Sync>>,
	master: Option<Box<dyn portable_pty::MasterPty + Send>>,
	writer: Option<Box<dyn Write + Send>>,
	child_pid: Option<i32>,
	process_group_id: Option<i32>,
	disarmed: bool,
}

impl PostSpawnSetupGuard {
	fn new(
		child: Box<dyn Child + Send + Sync>,
		master: Box<dyn portable_pty::MasterPty + Send>,
	) -> Self {
		let child_pid = child
			.process_id()
			.and_then(|value| i32::try_from(value).ok());
		#[cfg(unix)]
		let process_group_id = master.process_group_leader().filter(|pgid| *pgid > 0);
		#[cfg(not(unix))]
		let process_group_id = None;
		Self {
			child: Some(child),
			master: Some(master),
			writer: None,
			child_pid,
			process_group_id,
			disarmed: false,
		}
	}

	fn master(&self) -> &dyn portable_pty::MasterPty {
		self
			.master
			.as_ref()
			.expect("setup guard owns PTY master")
			.as_ref()
	}

	fn take_writer(&mut self) -> Result<Box<dyn Write + Send>> {
		let writer = self
			.master()
			.take_writer()
			.map_err(|err| Error::from_reason(format!("Failed to create PTY writer: {err}")))?;
		Ok(writer)
	}

	fn set_writer(&mut self, writer: Box<dyn Write + Send>) {
		self.writer = Some(writer);
	}

	fn try_clone_reader(&self) -> Result<Box<dyn Read + Send>> {
		self
			.master()
			.try_clone_reader()
			.map_err(|err| Error::from_reason(format!("Failed to create PTY reader: {err}")))
	}

	fn disarm(
		mut self,
	) -> (
		Box<dyn Child + Send + Sync>,
		Box<dyn portable_pty::MasterPty + Send>,
		Box<dyn Write + Send>,
		Option<i32>,
		Option<i32>,
	) {
		self.disarmed = true;
		(
			self.child.take().expect("setup guard owns PTY child"),
			self.master.take().expect("setup guard owns PTY master"),
			self.writer.take().expect("setup guard owns PTY writer"),
			self.child_pid,
			self.process_group_id,
		)
	}
}

impl Drop for PostSpawnSetupGuard {
	fn drop(&mut self) {
		if self.disarmed {
			return;
		}
		drop(self.writer.take());
		if let Some(child) = self.child.as_mut() {
			terminate_pty_processes(child, self.child_pid, self.process_group_id);
			let _ = reap_terminated_child(child, Instant::now() + TERMINATED_REAP_TIMEOUT);
		}
		drop(self.master.take());
	}
}

fn loss_marker(dropped_chunks: usize, dropped_bytes: usize) -> String {
	format!("{READER_LOSS_MARKER_PREFIX}{dropped_chunks} chunks / {dropped_bytes} bytes dropped]\n")
}

fn reader_event_len(event: &ReaderEvent) -> usize {
	match event {
		ReaderEvent::Chunk(chunk) => chunk.len(),
		ReaderEvent::Loss { dropped_chunks, dropped_bytes } => {
			loss_marker(*dropped_chunks, *dropped_bytes).len()
		},
		ReaderEvent::Done => 0,
	}
}

fn try_send_reader_event(
	tx: &mpsc::SyncSender<ReaderEvent>,
	event: ReaderEvent,
	dropped_chunks: &mut usize,
	dropped_bytes: &mut usize,
) -> bool {
	if *dropped_chunks > 0 {
		match tx.try_send(ReaderEvent::Loss {
			dropped_chunks: *dropped_chunks,
			dropped_bytes: *dropped_bytes,
		}) {
			Ok(()) => {
				*dropped_chunks = 0;
				*dropped_bytes = 0;
			},
			Err(mpsc::TrySendError::Full(_)) => {},
			Err(mpsc::TrySendError::Disconnected(_)) => return false,
		}
	}
	match tx.try_send(event) {
		Ok(()) => true,
		Err(mpsc::TrySendError::Full(event)) => {
			if !matches!(event, ReaderEvent::Done) {
				*dropped_chunks = dropped_chunks.saturating_add(1);
				*dropped_bytes = dropped_bytes.saturating_add(reader_event_len(&event));
			}
			true
		},
		Err(mpsc::TrySendError::Disconnected(_)) => false,
	}
}

fn send_reader_final_events(
	tx: &mpsc::SyncSender<ReaderEvent>,
	dropped_chunks: &mut usize,
	dropped_bytes: &mut usize,
) -> bool {
	if *dropped_chunks > 0 {
		if tx
			.send(ReaderEvent::Loss { dropped_chunks: *dropped_chunks, dropped_bytes: *dropped_bytes })
			.is_err()
		{
			return false;
		}
		*dropped_chunks = 0;
		*dropped_bytes = 0;
	}
	tx.send(ReaderEvent::Done).is_ok()
}

fn emit_reader_event(event: ReaderEvent, callback: Option<&ThreadsafeFunction<String>>) -> bool {
	match event {
		ReaderEvent::Chunk(chunk) => emit_chunk(&chunk, callback),
		ReaderEvent::Loss { dropped_chunks, dropped_bytes } => {
			emit_chunk(&loss_marker(dropped_chunks, dropped_bytes), callback)
		},
		ReaderEvent::Done => true,
	}
}

#[cfg(windows)]
struct WindowsOpenptyAttempt;

#[cfg(windows)]
impl WindowsOpenptyAttempt {
	fn acquire() -> Result<Self> {
		WINDOWS_OPENPTY_IN_FLIGHT
			.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
			.map(|_| Self)
			.map_err(|_| {
				Error::from_reason(
					"PTY creation is already in progress; refusing to spawn another ConPTY thread",
				)
			})
	}
}

#[cfg(windows)]
impl Drop for WindowsOpenptyAttempt {
	fn drop(&mut self) {
		WINDOWS_OPENPTY_IN_FLIGHT.store(false, Ordering::Release);
	}
}

fn run_pty_sync(
	config: PtyRunConfig,
	on_chunk: Option<ThreadsafeFunction<String>>,
	control_rx: mpsc::Receiver<ControlMessage>,
	ct: task::CancelToken,
) -> Result<PtyRunResult> {
	let pty_system = native_pty_system();
	ct.heartbeat()
		.map_err(|err| Error::from_reason(format!("PTY setup cancelled before openpty: {err}")))?;

	let pair = if cfg!(windows) {
		// Windows ConPTY openpty() can hang indefinitely when the console
		// subsystem isn't properly initialized. Gate attempts process-wide so
		// a hung openpty can leave at most one residual blocked thread behind.
		#[cfg(windows)]
		{
			const PTY_STARTUP_TIMEOUT: Duration = Duration::from_secs(5);
			let attempt = WindowsOpenptyAttempt::acquire()?;
			let (tx, rx) = mpsc::channel();
			let handle = std::thread::spawn(move || {
				let result = pty_system.openpty(PtySize {
					rows: config.rows,
					cols: config.cols,
					pixel_width: 0,
					pixel_height: 0,
				});
				let _ = tx.send(result);
			});
			match rx.recv_timeout(PTY_STARTUP_TIMEOUT) {
				Ok(Ok(pair)) => {
					let _ = handle.join();
					drop(attempt);
					pair
				},
				Ok(Err(e)) => {
					let _ = handle.join();
					return Err(Error::from_reason(format!("Failed to open PTY: {e}")));
				},
				Err(_) => {
					// The worker may be permanently stuck inside ConPTY. Keep the
					// single-flight gate held after timeout so residual leakage is capped
					// to one outstanding openpty thread for the process lifetime.
					std::mem::forget(attempt);
					return Err(Error::from_reason(
						"PTY creation timed out (5s). ConPTY may be unavailable on this system.",
					));
				},
			}
		}
		#[cfg(not(windows))]
		unreachable!()
	} else {
		pty_system
			.openpty(PtySize { rows: config.rows, cols: config.cols, pixel_width: 0, pixel_height: 0 })
			.map_err(|err| Error::from_reason(format!("Failed to open PTY: {err}")))?
	};

	let shell = config.shell.as_deref().unwrap_or("sh");
	let mut cmd = CommandBuilder::new(shell);
	// Use shell-appropriate command execution flags
	let lower = shell.to_lowercase();
	if lower.ends_with("cmd.exe") || lower.ends_with("cmd") {
		cmd.arg("/c");
	} else if lower.contains("powershell") || lower.contains("pwsh") {
		cmd.arg("-Command");
	} else {
		// sh/bash/zsh/fish etc.
		cmd.arg("-lc");
	}
	cmd.arg(&config.command);
	if let Some(cwd) = config.cwd.as_ref() {
		cmd.cwd(cwd);
	}
	if let Some(env) = config.env.as_ref() {
		for (key, value) in env {
			cmd.env(key, value);
		}
	}
	ct.heartbeat()
		.map_err(|err| Error::from_reason(format!("PTY setup cancelled before spawn: {err}")))?;

	let child = pair
		.slave
		.spawn_command(cmd)
		.map_err(|err| Error::from_reason(format!("Failed to spawn PTY command: {err}")))?;
	drop(pair.slave);
	let mut setup_guard = PostSpawnSetupGuard::new(child, pair.master);
	ct.heartbeat()
		.map_err(|err| Error::from_reason(format!("PTY setup cancelled before reader: {err}")))?;

	let writer = setup_guard.take_writer()?;
	// ConPTY sends ESC[6n (cursor position query) and blocks until we reply.
	// Reply with cursor at 1,1 so it unblocks the child spawn.
	// Only needed on Windows; on Unix/macOS this would corrupt stdin.
	#[cfg(windows)]
	let writer = {
		let mut writer = writer;
		let _ = writer.write_all(b"\x1b[1;1R");
		let _ = writer.flush();
		writer
	};
	setup_guard.set_writer(writer);
	let mut reader = setup_guard.try_clone_reader()?;

	let (reader_tx, reader_rx) = mpsc::sync_channel::<ReaderEvent>(READER_EVENT_QUEUE_CAPACITY);
	let reader_thread = std::thread::spawn(move || {
		const REPLACEMENT: &str = "\u{FFFD}";
		const BUF: usize = 65536;
		let mut buf = vec![0u8; BUF + 4];
		let mut it = 0;
		let mut dropped_chunks = 0usize;
		let mut dropped_bytes = 0usize;
		loop {
			match reader.read(&mut buf[it..BUF]) {
				Ok(0) => {
					break;
				},
				Ok(n) => {
					it += n;
					while it > 0 {
						let pending = &buf[..it];
						match str::from_utf8(pending) {
							Ok(text) => {
								if !try_send_reader_event(
									&reader_tx,
									ReaderEvent::Chunk(text.to_string()),
									&mut dropped_chunks,
									&mut dropped_bytes,
								) {
									return;
								}
								it = 0;
								break;
							},
							Err(err) => {
								let valid_up_to = err.valid_up_to();
								if valid_up_to > 0 {
									// SAFETY: [..valid_up_to] is guaranteed valid UTF-8 by valid_up_to().
									let text = unsafe { str::from_utf8_unchecked(&pending[..valid_up_to]) };
									if !try_send_reader_event(
										&reader_tx,
										ReaderEvent::Chunk(text.to_string()),
										&mut dropped_chunks,
										&mut dropped_bytes,
									) {
										return;
									}
									buf.copy_within(valid_up_to..it, 0);
									it -= valid_up_to;
								}
								match err.error_len() {
									Some(invalid_len) => {
										if !try_send_reader_event(
											&reader_tx,
											ReaderEvent::Chunk(REPLACEMENT.to_string()),
											&mut dropped_chunks,
											&mut dropped_bytes,
										) {
											return;
										}
										buf.copy_within(invalid_len..it, 0);
										it -= invalid_len;
									},
									None => {
										break;
									},
								}
							},
						}
					}
				},
				Err(_) => {
					break;
				},
			}
		}
		for chunk in buf[..it].utf8_chunks() {
			let valid = chunk.valid();
			if !valid.is_empty()
				&& !try_send_reader_event(
					&reader_tx,
					ReaderEvent::Chunk(valid.to_string()),
					&mut dropped_chunks,
					&mut dropped_bytes,
				) {
				return;
			}
			if !chunk.invalid().is_empty()
				&& !try_send_reader_event(
					&reader_tx,
					ReaderEvent::Chunk(REPLACEMENT.to_string()),
					&mut dropped_chunks,
					&mut dropped_bytes,
				) {
				return;
			}
		}
		let _ = send_reader_final_events(&reader_tx, &mut dropped_chunks, &mut dropped_bytes);
	});

	let (mut child, master, mut writer, child_pid, process_group_id) = setup_guard.disarm();
	let mut timed_out = false;
	let mut cancelled = false;
	let mut reader_done = false;
	let mut exit_code: Option<i32> = None;
	let mut terminate_requested = false;
	let mut reader_drain_deadline: Option<Instant> = None;
	while exit_code.is_none() || !reader_done {
		if !terminate_requested && let Err(err) = ct.heartbeat() {
			let message = err.to_string();
			timed_out = message.contains("Timeout");
			cancelled = !timed_out;
			terminate_pty_processes(&mut child, child_pid, process_group_id);
			terminate_requested = true;
			reader_drain_deadline = Some(Instant::now() + POST_CANCEL_DRAIN_TIMEOUT);
		}

		for _ in 0..CONTROL_MESSAGES_PER_TICK {
			match control_rx.try_recv() {
				Ok(ControlMessage::Input(data)) => {
					let _ = writer.write_all(data.as_bytes());
					let _ = writer.flush();
				},
				Ok(ControlMessage::Resize { cols, rows }) => {
					let _ = master.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 });
				},
				Ok(ControlMessage::Kill) => {
					cancelled = true;
					if !terminate_requested {
						terminate_pty_processes(&mut child, child_pid, process_group_id);
						terminate_requested = true;
						reader_drain_deadline = Some(Instant::now() + POST_CANCEL_DRAIN_TIMEOUT);
					}
				},
				Err(mpsc::TryRecvError::Empty) => break,
				Err(mpsc::TryRecvError::Disconnected) => break,
			}
		}

		for _ in 0..READER_EVENTS_PER_TICK {
			match reader_rx.try_recv() {
				Ok(ReaderEvent::Done) => {
					reader_done = true;
					break;
				},
				Ok(event) => {
					if !emit_reader_event(event, on_chunk.as_ref()) {
						cancelled = true;
						if !terminate_requested {
							terminate_pty_processes(&mut child, child_pid, process_group_id);
							terminate_requested = true;
							reader_drain_deadline = Some(Instant::now() + POST_CANCEL_DRAIN_TIMEOUT);
						}
						break;
					}
				},
				Err(mpsc::TryRecvError::Empty) => break,
				Err(mpsc::TryRecvError::Disconnected) => {
					reader_done = true;
					break;
				},
			}
		}

		if exit_code.is_none()
			&& let Some(status) = child
				.try_wait()
				.map_err(|err| Error::from_reason(format!("Failed checking PTY status: {err}")))?
		{
			exit_code = Some(i32::try_from(status.exit_code()).unwrap_or(i32::MAX));
			if !reader_done && reader_drain_deadline.is_none() {
				reader_drain_deadline = Some(Instant::now() + POST_EXIT_DRAIN_TIMEOUT);
			}
		}

		if let Some(deadline) = reader_drain_deadline
			&& Instant::now() >= deadline
		{
			break;
		}
		if exit_code.is_none() || !reader_done {
			let wait_duration = reader_drain_deadline.map_or(Duration::from_millis(16), |deadline| {
				deadline
					.saturating_duration_since(Instant::now())
					.min(Duration::from_millis(16))
			});
			match reader_rx.recv_timeout(wait_duration) {
				Ok(ReaderEvent::Done) => reader_done = true,
				Ok(event) => {
					if !emit_reader_event(event, on_chunk.as_ref()) {
						cancelled = true;
						if !terminate_requested {
							terminate_pty_processes(&mut child, child_pid, process_group_id);
							terminate_requested = true;
							reader_drain_deadline = Some(Instant::now() + POST_CANCEL_DRAIN_TIMEOUT);
						}
					}
				},
				Err(mpsc::RecvTimeoutError::Timeout) => {},
				Err(mpsc::RecvTimeoutError::Disconnected) => {
					reader_done = true;
					if exit_code.is_none() {
						std::thread::sleep(wait_duration);
					}
				},
			}
		}
	}
	if exit_code.is_none() {
		if terminate_requested {
			exit_code = reap_terminated_child(&mut child, Instant::now() + TERMINATED_REAP_TIMEOUT)?;
		} else {
			// On Windows, child.wait() can hang indefinitely in ConPTY.
			// Poll try_wait() with a short timeout instead.
			#[cfg(windows)]
			{
				let wait_start = Instant::now();
				while exit_code.is_none() && wait_start.elapsed() < Duration::from_secs(5) {
					if let Some(status) = child
						.try_wait()
						.map_err(|err| Error::from_reason(format!("Failed checking PTY status: {err}")))?
					{
						exit_code = Some(i32::try_from(status.exit_code()).unwrap_or(i32::MAX));
						break;
					}
					std::thread::sleep(Duration::from_millis(50));
				}
			}
			#[cfg(not(windows))]
			{
				let status = child
					.wait()
					.map_err(|err| Error::from_reason(format!("Failed waiting PTY process: {err}")))?;
				exit_code = Some(i32::try_from(status.exit_code()).unwrap_or(i32::MAX));
			}
		}
	}
	// --- Teardown ---

	// Step 1: Close the ConPTY input pipe first.
	// Per Microsoft docs, close the input handle before calling ClosePseudoConsole.
	// This signals to ConPTY that no more input will arrive, allowing its internal
	// I/O threads to finish processing and eventually close the output pipe.
	drop(writer);

	// Step 2: Drain the reader thread.
	// After the child exits and input is closed, ConPTY should flush remaining
	// output and signal EOF on the output pipe, causing the reader thread to exit.
	// On Windows, use a generous timeout to accommodate ConPTY's async teardown.
	if exit_code.is_some() && !terminate_requested && !reader_done {
		terminate_pty_processes(&mut child, child_pid, process_group_id);
	}
	if !reader_done {
		#[cfg(windows)]
		let drain_timeout = Duration::from_millis(500);
		#[cfg(not(windows))]
		let drain_timeout = FINAL_READER_DRAIN_TIMEOUT;
		let finalize_deadline = Instant::now() + drain_timeout;
		while Instant::now() < finalize_deadline {
			let remaining = finalize_deadline.saturating_duration_since(Instant::now());
			let wait_duration = remaining.min(Duration::from_millis(5));
			match reader_rx.recv_timeout(wait_duration) {
				Ok(ReaderEvent::Done) => {
					reader_done = true;
					break;
				},
				Ok(event) => {
					if !emit_reader_event(event, on_chunk.as_ref()) {
						break;
					}
				},
				Err(mpsc::RecvTimeoutError::Timeout) => {},
				Err(mpsc::RecvTimeoutError::Disconnected) => {
					reader_done = true;
					break;
				},
			}
		}
	}

	// Step 3: Drop master (calls ClosePseudoConsole on Windows).
	// ClosePseudoConsole can deadlock if ConPTY tries to flush output
	// while nobody is reading the pipe (microsoft/terminal#1810).
	// Always offload to a background thread on Windows, then wait with
	// a timeout so the thread is reclaimed when ClosePseudoConsole
	// completes cleanly. If it hangs, we walk away — the thread leaks,
	// but the main thread never blocks.
	#[cfg(windows)]
	{
		let (drop_tx, drop_rx) = mpsc::channel::<()>();
		std::thread::spawn(move || {
			drop(master);
			let _ = drop_tx.send(());
		});
		let _ = drop_rx.recv_timeout(Duration::from_secs(2));
	}
	#[cfg(not(windows))]
	{
		drop(master);
	}

	// Step 4: Join reader thread if it finished.
	// A detached descendant can keep the PTY slave open forever; do not block
	// completion waiting on join when the reader thread did not reach EOF.
	if reader_done {
		let _ = reader_thread.join();
	}
	Ok(PtyRunResult { exit_code, cancelled, timed_out })
}

fn emit_chunk(text: &str, callback: Option<&ThreadsafeFunction<String>>) -> bool {
	let Some(callback) = callback else {
		return true;
	};
	callback.call(Ok(text.to_string()), ThreadsafeFunctionCallMode::NonBlocking) == napi::Status::Ok
}

#[cfg(test)]
mod tests {
	use std::{
		fs,
		path::PathBuf,
		sync::{Mutex, mpsc},
		time::{Duration, Instant},
	};

	use super::*;
	static PTY_TEST_LOCK: Mutex<()> = Mutex::new(());

	fn test_config(command: &str) -> PtyRunConfig {
		PtyRunConfig {
			command: command.to_string(),
			cwd: None,
			env: None,
			cols: 80,
			rows: 24,
			shell: Some("sh".to_string()),
		}
	}

	#[cfg(unix)]
	fn process_exists(pid: i32) -> bool {
		unsafe { libc::kill(pid, 0) == 0 }
	}

	#[cfg(unix)]
	fn wait_for_process_exit(pid: i32, timeout: Duration) -> bool {
		let deadline = Instant::now() + timeout;
		while Instant::now() < deadline {
			if !process_exists(pid) {
				return true;
			}
			std::thread::sleep(Duration::from_millis(20));
		}
		!process_exists(pid)
	}

	#[cfg(unix)]
	fn test_path(name: &str) -> PathBuf {
		let mut path = std::env::temp_dir();
		path.push(format!("pi-natives-pty-{name}-{}", std::process::id()));
		let _ = fs::remove_file(&path);
		path
	}
	#[cfg(unix)]
	fn post_spawn_setup_error_after_spawn(command: &str, pid_path: &std::path::Path) -> Result<()> {
		let pty_system = native_pty_system();
		let pair = pty_system
			.openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })
			.map_err(|err| Error::from_reason(format!("Failed to open PTY: {err}")))?;
		let mut cmd = CommandBuilder::new("sh");
		cmd.arg("-lc");
		cmd.arg(command);
		let child = pair
			.slave
			.spawn_command(cmd)
			.map_err(|err| Error::from_reason(format!("Failed to spawn PTY command: {err}")))?;
		drop(pair.slave);
		let setup_guard = PostSpawnSetupGuard::new(child, pair.master);
		if let Some(pid) = setup_guard.child_pid {
			fs::write(pid_path, pid.to_string())
				.map_err(|err| Error::from_reason(format!("Failed to write child pid: {err}")))?;
		}
		Err(Error::from_reason("simulated post-spawn setup failure"))
	}

	#[test]
	fn bounded_reader_channel_reports_success_for_high_output() {
		let _guard = PTY_TEST_LOCK.lock().unwrap_or_else(|err| err.into_inner());
		let (_tx, rx) = mpsc::channel();
		let started = Instant::now();
		let result = run_pty_sync(
			test_config("i=0; while [ $i -lt 200000 ]; do printf '%080d\\n' \"$i\"; i=$((i+1)); done"),
			None,
			rx,
			task::CancelToken::new(Some(20_000), None),
		)
		.expect("high-output PTY run should complete without unbounded buffering");
		assert!(result.exit_code.is_some());
		assert!(!result.cancelled);
		assert!(!result.timed_out);
		assert!(started.elapsed() < Duration::from_secs(20));
	}

	#[test]
	fn final_reader_loss_and_done_are_delivered_when_queue_is_full() {
		let (tx, rx) = mpsc::sync_channel(READER_EVENT_QUEUE_CAPACITY);
		let mut dropped_chunks = 0usize;
		let mut dropped_bytes = 0usize;
		for i in 0..READER_EVENT_QUEUE_CAPACITY {
			assert!(try_send_reader_event(
				&tx,
				ReaderEvent::Chunk(format!("chunk-{i}")),
				&mut dropped_chunks,
				&mut dropped_bytes,
			));
		}
		assert!(try_send_reader_event(
			&tx,
			ReaderEvent::Chunk("dropped-tail".to_string()),
			&mut dropped_chunks,
			&mut dropped_bytes,
		));
		assert_eq!(dropped_chunks, 1);
		let finalizer = std::thread::spawn(move || {
			assert!(send_reader_final_events(&tx, &mut dropped_chunks, &mut dropped_bytes));
		});

		let mut output = String::new();
		let mut saw_done = false;
		while let Ok(event) = rx.recv() {
			match event {
				ReaderEvent::Chunk(chunk) => output.push_str(&chunk),
				ReaderEvent::Loss { dropped_chunks, dropped_bytes } => {
					assert!(dropped_chunks > 0);
					assert!(dropped_bytes > 0);
					output.push_str(&loss_marker(dropped_chunks, dropped_bytes));
				},
				ReaderEvent::Done => {
					saw_done = true;
					break;
				},
			}
		}

		finalizer.join().expect("final sender should not panic");
		assert!(saw_done);
		assert!(output.contains(READER_LOSS_MARKER_PREFIX));
		assert!(output.contains("1 chunks / 12 bytes dropped"));
	}

	#[cfg(unix)]
	#[test]
	fn dropped_session_core_kills_and_reaps_mid_run_child() {
		let _guard = PTY_TEST_LOCK.lock().unwrap_or_else(|err| err.into_inner());
		let pid_path = test_path("drop-pid");
		let command = format!("printf '%s' $$ > {}; trap '' TERM; sleep 30", pid_path.display());
		let (tx, rx) = mpsc::channel();
		let core = PtySessionCore { control_tx: tx };
		let handle = std::thread::spawn(move || {
			run_pty_sync(test_config(&command), None, rx, task::CancelToken::new(Some(10_000), None))
		});
		let deadline = Instant::now() + Duration::from_secs(2);
		while !pid_path.exists() && Instant::now() < deadline {
			std::thread::sleep(Duration::from_millis(20));
		}
		let child_pid: i32 = fs::read_to_string(&pid_path)
			.expect("child pid file should be written")
			.parse()
			.expect("pid file should contain a pid");
		drop(core);
		let result = handle
			.join()
			.expect("PTY worker should not panic")
			.expect("dropped PTY core should return a result");
		assert!(result.cancelled);
		assert!(result.exit_code.is_some());
		assert!(wait_for_process_exit(child_pid, Duration::from_secs(2)));
		let _ = fs::remove_file(pid_path);
	}
	#[cfg(unix)]
	#[test]
	fn dropped_js_pty_session_kills_and_reaps_mid_run_child() {
		let _guard = PTY_TEST_LOCK.lock().unwrap_or_else(|err| err.into_inner());
		let pid_path = test_path("drop-js-session-pid");
		let command = format!("printf '%s' $$ > {}; trap '' TERM; sleep 30", pid_path.display());
		let session = PtySession::new();
		let (tx, rx) = mpsc::channel();
		{
			let mut guard = session.core.lock().expect("session lock");
			*guard = Some(PtySessionCore { control_tx: tx });
		}
		let handle = std::thread::spawn(move || {
			run_pty_sync(test_config(&command), None, rx, task::CancelToken::new(Some(10_000), None))
		});
		let deadline = Instant::now() + Duration::from_secs(2);
		while !pid_path.exists() && Instant::now() < deadline {
			std::thread::sleep(Duration::from_millis(20));
		}
		let child_pid: i32 = fs::read_to_string(&pid_path)
			.expect("child pid file should be written")
			.parse()
			.expect("pid file should contain a pid");
		drop(session);
		let result = handle
			.join()
			.expect("PTY worker should not panic")
			.expect("dropped JS PTY session should return a result");
		assert!(result.cancelled);
		assert!(result.exit_code.is_some());
		assert!(wait_for_process_exit(child_pid, Duration::from_secs(2)));
		let _ = fs::remove_file(pid_path);
	}

	#[cfg(unix)]
	#[test]
	fn post_spawn_setup_error_guard_reaps_child() {
		let _guard = PTY_TEST_LOCK.lock().unwrap_or_else(|err| err.into_inner());
		let pid_path = test_path("post-spawn-error-pid");
		let command = "trap '' TERM; sleep 30";
		let result = post_spawn_setup_error_after_spawn(command, &pid_path);
		assert!(result.is_err());
		let child_pid: i32 = fs::read_to_string(&pid_path)
			.expect("child pid file should be written before injected failure")
			.parse()
			.expect("pid file should contain a pid");
		assert!(wait_for_process_exit(child_pid, Duration::from_secs(2)));
		let _ = fs::remove_file(pid_path);
	}

	#[test]
	fn kill_path_reaps_sigterm_trapping_child() {
		let _guard = PTY_TEST_LOCK.lock().unwrap_or_else(|err| err.into_inner());
		let (tx, rx) = mpsc::channel();
		let handle = std::thread::spawn(move || {
			run_pty_sync(
				test_config("trap '' TERM; printf ready; sleep 30"),
				None,
				rx,
				task::CancelToken::new(Some(10_000), None),
			)
		});
		std::thread::sleep(Duration::from_millis(200));
		let started = Instant::now();
		let _ = tx.send(ControlMessage::Kill);
		let result = handle
			.join()
			.expect("PTY worker should not panic")
			.expect("killed PTY run should return a result");
		assert!(result.cancelled);
		assert!(result.exit_code.is_some());
		assert!(started.elapsed() < TERMINATED_REAP_TIMEOUT + Duration::from_secs(1));
	}

	#[cfg(unix)]
	#[test]
	fn background_grandchild_holding_slave_is_reaped_and_unrelated_sibling_survives() {
		let _guard = PTY_TEST_LOCK.lock().unwrap_or_else(|err| err.into_inner());
		use std::process::{Command, Stdio};

		let mut sibling = Command::new("sh")
			.arg("-c")
			.arg("sleep 30")
			.stdin(Stdio::null())
			.stdout(Stdio::null())
			.stderr(Stdio::null())
			.spawn()
			.expect("spawn unrelated sibling");
		let sibling_pid = i32::try_from(sibling.id()).expect("sibling pid fits i32");
		let pid_path = test_path("background-pid");
		let command = format!("sleep 30 & printf '%s' $! > {}; echo done", pid_path.display());
		let (_tx, rx) = mpsc::channel();
		let result =
			run_pty_sync(test_config(&command), None, rx, task::CancelToken::new(Some(10_000), None))
				.expect("PTY run should complete after reaping background grandchild");
		assert!(result.exit_code.is_some());
		let grandchild_pid: i32 = fs::read_to_string(&pid_path)
			.expect("grandchild pid file should be written")
			.parse()
			.expect("pid file should contain a pid");
		assert!(wait_for_process_exit(grandchild_pid, Duration::from_secs(2)));
		assert!(process_exists(sibling_pid));
		let _ = sibling.kill();
		let _ = sibling.wait();
		let _ = fs::remove_file(pid_path);
	}
}
