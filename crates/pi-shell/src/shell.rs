//! Runtime-agnostic brush shell execution.

use std::{
	collections::{HashMap, HashSet},
	fs,
	io::{self, Write},
	str,
	sync::{
		Arc,
		atomic::{AtomicI32, AtomicUsize, Ordering},
	},
	time::Duration,
};

use anyhow::{Error, Result};
use brush_builtins::{BuiltinSet, default_builtins};
use brush_core::{
	ExecutionContext, ExecutionControlFlow, ExecutionExitCode, ExecutionResult, ProcessGroupPolicy,
	ProfileLoadBehavior, RcLoadBehavior, Shell as BrushShell, ShellValue, ShellVariable, SourceInfo,
	builtins,
	env::EnvironmentScope,
	openfiles::{self, OpenFile, OpenFiles},
};
use bytes::Bytes;
use clap::Parser;
#[cfg(not(unix))]
use tokio::io::AsyncReadExt as _;
use tokio::{
	sync::{Mutex as TokioMutex, mpsc},
	time,
};
use tokio_util::sync::CancellationToken;

#[cfg(windows)]
use crate::windows::configure_windows_path;
use crate::{
	cancel::{AbortReason, AbortToken, CancelToken},
	minimizer, process,
};

struct ShellSessionCore {
	shell: BrushShell,
}

#[derive(Default)]
struct ShellAbortInner {
	generation: usize,
	tokens:     HashMap<usize, AbortToken>,
	active:     HashSet<usize>,
	pending:    bool,
}

#[derive(Clone, Default)]
struct ShellAbortState(Arc<TokioMutex<ShellAbortInner>>);

impl ShellAbortState {
	async fn publish(&self, abort_token: AbortToken) -> usize {
		let mut inner = self.0.lock().await;
		inner.generation = inner.generation.wrapping_add(1);
		let generation = inner.generation;
		inner.tokens.insert(generation, abort_token);
		generation
	}

	async fn activate(&self, generation: usize) {
		let mut inner = self.0.lock().await;
		if inner.tokens.contains_key(&generation) {
			inner.active.insert(generation);
		}
		if inner.pending {
			if let Some(abort_token) = inner.tokens.get(&generation).cloned() {
				abort_token.abort(AbortReason::Signal);
			}
			inner.pending = false;
		}
	}

	async fn clear(&self, generation: usize) {
		let mut inner = self.0.lock().await;
		inner.tokens.remove(&generation);
		inner.active.remove(&generation);
	}

	async fn abort(&self) {
		let mut inner = self.0.lock().await;
		if inner.active.is_empty() {
			inner.pending = true;
			return;
		}
		let active = inner.active.clone();
		for generation in active {
			if let Some(abort_token) = inner.tokens.get(&generation).cloned() {
				abort_token.abort(AbortReason::Signal);
			}
		}
	}
}

#[derive(Clone)]
struct ShellConfig {
	session_env:   Option<HashMap<String, String>>,
	snapshot_path: Option<String>,
	minimizer:     Option<minimizer::MinimizerConfig>,
}

#[derive(Debug, Clone, Default)]
pub struct ShellOptions {
	pub session_env:   Option<HashMap<String, String>>,
	pub snapshot_path: Option<String>,
	pub minimizer:     Option<minimizer::MinimizerOptions>,
}

struct ShellRunConfig {
	command:   String,
	cwd:       Option<String>,
	env:       Option<HashMap<String, String>>,
	minimizer: Option<minimizer::MinimizerConfig>,
}

#[derive(Debug, Clone, Default)]
pub struct ShellRunOptions {
	pub command:    String,
	pub cwd:        Option<String>,
	pub env:        Option<HashMap<String, String>>,
	pub timeout_ms: Option<u32>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct MinimizerResult {
	pub filter:        String,
	pub text:          String,
	pub original_text: String,
	pub input_bytes:   u32,
	pub output_bytes:  u32,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ShellRunResult {
	pub exit_code:              Option<i32>,
	pub cancelled:              bool,
	pub timed_out:              bool,
	pub minimized:              Option<MinimizerResult>,
	pub output_truncated:       bool,
	pub output_truncated_bytes: u64,
	pub stdout_truncated:       bool,
	pub stdout_truncated_bytes: u64,
	pub stderr_truncated:       bool,
	pub stderr_truncated_bytes: u64,
}

#[derive(Debug, Clone, Default)]
pub struct ShellExecuteOptions {
	pub command:       String,
	pub cwd:           Option<String>,
	pub env:           Option<HashMap<String, String>>,
	pub session_env:   Option<HashMap<String, String>>,
	pub timeout_ms:    Option<u32>,
	pub snapshot_path: Option<String>,
	pub minimizer:     Option<minimizer::MinimizerOptions>,
}

pub type ShellExecuteResult = ShellRunResult;

pub struct Shell {
	session:     Arc<TokioMutex<Option<ShellSessionCore>>>,
	abort_state: ShellAbortState,
	config:      ShellConfig,
}

impl Shell {
	#[must_use]
	pub fn new(options: Option<ShellOptions>) -> Self {
		let config = match options {
			None => ShellConfig { session_env: None, snapshot_path: None, minimizer: None },
			Some(opt) => {
				let minimizer = opt
					.minimizer
					.as_ref()
					.map(minimizer::MinimizerConfig::from_options);
				ShellConfig {
					session_env: opt.session_env,
					snapshot_path: opt.snapshot_path,
					minimizer,
				}
			},
		};
		Self {
			session: Arc::new(TokioMutex::new(None)),
			abort_state: ShellAbortState::default(),
			config,
		}
	}

	pub async fn run(
		&self,
		options: ShellRunOptions,
		on_chunk: Option<mpsc::UnboundedSender<String>>,
		mut cancel_token: CancelToken,
	) -> Result<ShellRunResult> {
		let run_config = ShellRunConfig {
			command:   options.command,
			cwd:       options.cwd,
			env:       options.env,
			minimizer: self.config.minimizer.clone(),
		};
		run_shell_session(
			self.session.clone(),
			self.abort_state.clone(),
			self.config.clone(),
			run_config,
			on_chunk,
			&mut cancel_token,
		)
		.await
	}

	pub async fn abort(&self) {
		self.abort_state.abort().await;
	}
}

pub async fn execute_shell(
	options: ShellExecuteOptions,
	on_chunk: Option<mpsc::UnboundedSender<String>>,
	cancel_token: CancelToken,
) -> Result<ShellExecuteResult> {
	let minimizer = options
		.minimizer
		.as_ref()
		.map(minimizer::MinimizerConfig::from_options);
	let config = ShellConfig {
		session_env:   options.session_env,
		snapshot_path: options.snapshot_path,
		minimizer:     minimizer.clone(),
	};
	let run_config =
		ShellRunConfig { command: options.command, cwd: options.cwd, env: options.env, minimizer };
	run_shell_oneshot(config, run_config, on_chunk, cancel_token).await
}

/// Optional per-stream raw byte sinks for [`execute_shell_streams`].
///
/// When a sink is `Some`, that stream's pipe is drained directly into the
/// channel with no UTF-8 decoding and no merging. When `None`, the
/// corresponding pipe is still drained (to avoid blocking the child) but
/// its bytes are dropped.
#[derive(Default)]
pub struct StreamSinks {
	pub stdout: Option<mpsc::UnboundedSender<Bytes>>,
	pub stderr: Option<mpsc::UnboundedSender<Bytes>>,
}

/// One-shot execution that delivers stdout/stderr as raw byte chunks.
///
/// Bytes are delivered on separate channels with no UTF-8 decoding and no
/// merging. The minimizer is intentionally disabled — its
/// `MinimizerResult.text` contract presumes a single merged transcript.
pub async fn execute_shell_streams(
	options: ShellExecuteOptions,
	streams: StreamSinks,
	cancel_token: CancelToken,
) -> Result<ShellExecuteResult> {
	let config = ShellConfig {
		session_env:   options.session_env,
		snapshot_path: options.snapshot_path,
		minimizer:     None,
	};
	let run_config = ShellRunConfig {
		command:   options.command,
		cwd:       options.cwd,
		env:       options.env,
		minimizer: None,
	};
	run_shell_oneshot_streams(config, run_config, streams, cancel_token).await
}

async fn run_shell_session(
	session: Arc<TokioMutex<Option<ShellSessionCore>>>,
	abort_state: ShellAbortState,
	config: ShellConfig,
	run_config: ShellRunConfig,
	on_chunk: Option<mpsc::UnboundedSender<String>>,
	ct: &mut CancelToken,
) -> Result<ShellRunResult> {
	let tokio_cancel = CancellationToken::new();
	let abort_generation = abort_state.publish(ct.emplace_abort_token()).await;

	let mut run_task = tokio::spawn({
		let session = session.clone();
		let tokio_cancel = tokio_cancel.clone();
		let run_abort_state = abort_state.clone();
		async move {
			let mut session_guard = session.lock().await;
			run_abort_state.activate(abort_generation).await;

			let session = match &mut *session_guard {
				Some(session) => session,
				None => session_guard.insert(create_session(&config).await?),
			};
			let result = run_shell_command(session, &run_config, on_chunk, tokio_cancel).await;
			run_abort_state.clear(abort_generation).await;
			result
		}
	});

	let res = tokio::select! {
		res = &mut run_task => res,
		reason = ct.wait() => {
			tokio_cancel.cancel();
			// Per-command cancellation handles descendant termination after the
			// serialized session lock is acquired; do not use a queued run baseline.
			let graceful = time::timeout(Duration::from_secs(2), &mut run_task).await;
			if graceful.is_err() {
				run_task.abort();
				let _ = run_task.await;
			}
			abort_state.clear(abort_generation).await;
			// Use try_lock to avoid deadlocking if another task holds the session.
			// If we can't acquire the lock, the session will be cleaned up when the
			// holding task finishes.
			if let Ok(mut guard) = session.try_lock() {
				*guard = None;
			}
			return Ok(ShellRunResult {
				exit_code: None,
				cancelled: matches!(reason, AbortReason::Signal),
				timed_out: matches!(reason, AbortReason::Timeout),
				minimized: None,
				output_truncated: false,
				output_truncated_bytes: 0,
				stdout_truncated: false,
				stdout_truncated_bytes: 0,
				stderr_truncated: false,
				stderr_truncated_bytes: 0,
			});
		}
	};
	let res =
		res.unwrap_or_else(|err| Err(Error::msg(format!("Shell execution task failed: {err}"))));
	abort_state.clear(abort_generation).await;

	let keepalive = res.as_ref().is_ok_and(|pair| session_keepalive(&pair.0));
	if !keepalive {
		*session.lock().await = None;
	}
	let (exec, minimized, truncation) = res?;
	Ok(ShellRunResult {
		exit_code: Some(exit_code(&exec)),
		cancelled: false,
		timed_out: false,
		minimized,
		output_truncated: truncation.output_truncated,
		output_truncated_bytes: truncation.output_truncated_bytes,
		stdout_truncated: truncation.stdout_truncated,
		stdout_truncated_bytes: truncation.stdout_truncated_bytes,
		stderr_truncated: truncation.stderr_truncated,
		stderr_truncated_bytes: truncation.stderr_truncated_bytes,
	})
}

async fn run_shell_oneshot(
	config: ShellConfig,
	run_config: ShellRunConfig,
	on_chunk: Option<mpsc::UnboundedSender<String>>,
	ct: CancelToken,
) -> Result<ShellExecuteResult> {
	let tokio_cancel = CancellationToken::new();
	let baseline_descendants = process::current_descendant_pids();

	let mut task = tokio::spawn({
		let tokio_cancel = tokio_cancel.clone();
		async move {
			let mut session = create_session(&config).await?;
			run_shell_command(&mut session, &run_config, on_chunk, tokio_cancel).await
		}
	});

	let run_result = tokio::select! {
		result = &mut task => result,
		reason = ct.wait() => {
			tokio_cancel.cancel();
			terminate_new_descendants(&baseline_descendants, 0).await;
			let graceful = time::timeout(Duration::from_secs(2), &mut task).await;
			if graceful.is_err() {
				task.abort();
				let _ = task.await;
			}
			return Ok(ShellExecuteResult {
				exit_code: None,
				cancelled: matches!(reason, AbortReason::Signal),
				timed_out: matches!(reason, AbortReason::Timeout),
				minimized: None,
				output_truncated: false,
				output_truncated_bytes: 0,
				stdout_truncated: false,
				stdout_truncated_bytes: 0,
				stderr_truncated: false,
				stderr_truncated_bytes: 0,
			});
		},
	};

	let res = run_result
		.unwrap_or_else(|err| Err(Error::msg(format!("Shell execution task failed: {err}"))));
	let (exec, minimized, truncation) = res?;
	Ok(ShellExecuteResult {
		exit_code: Some(exit_code(&exec)),
		cancelled: false,
		timed_out: false,
		minimized,
		output_truncated: truncation.output_truncated,
		output_truncated_bytes: truncation.output_truncated_bytes,
		stdout_truncated: truncation.stdout_truncated,
		stdout_truncated_bytes: truncation.stdout_truncated_bytes,
		stderr_truncated: truncation.stderr_truncated,
		stderr_truncated_bytes: truncation.stderr_truncated_bytes,
	})
}

async fn run_shell_oneshot_streams(
	config: ShellConfig,
	run_config: ShellRunConfig,
	streams: StreamSinks,
	ct: CancelToken,
) -> Result<ShellExecuteResult> {
	let tokio_cancel = CancellationToken::new();
	let baseline_descendants = process::current_descendant_pids();

	let mut task = tokio::spawn({
		let tokio_cancel = tokio_cancel.clone();
		async move {
			let mut session = create_session(&config).await?;
			run_shell_command_streams(&mut session, &run_config, streams, tokio_cancel).await
		}
	});

	let run_result = tokio::select! {
		result = &mut task => result,
		reason = ct.wait() => {
			tokio_cancel.cancel();
			terminate_new_descendants(&baseline_descendants, 0).await;
			let graceful = time::timeout(Duration::from_secs(2), &mut task).await;
			if graceful.is_err() {
				task.abort();
				let _ = task.await;
			}
			return Ok(ShellExecuteResult {
				exit_code: None,
				cancelled: matches!(reason, AbortReason::Signal),
				timed_out: matches!(reason, AbortReason::Timeout),
				minimized: None,
				output_truncated: false,
				output_truncated_bytes: 0,
				stdout_truncated: false,
				stdout_truncated_bytes: 0,
				stderr_truncated: false,
				stderr_truncated_bytes: 0,
			});
		},
	};

	let res = run_result
		.unwrap_or_else(|err| Err(Error::msg(format!("Shell execution task failed: {err}"))));
	let (exec, truncation) = res?;
	Ok(ShellExecuteResult {
		exit_code:              Some(exit_code(&exec)),
		cancelled:              false,
		timed_out:              false,
		minimized:              None,
		output_truncated:       truncation.output_truncated,
		output_truncated_bytes: truncation.output_truncated_bytes,
		stdout_truncated:       truncation.stdout_truncated,
		stdout_truncated_bytes: truncation.stdout_truncated_bytes,
		stderr_truncated:       truncation.stderr_truncated,
		stderr_truncated_bytes: truncation.stderr_truncated_bytes,
	})
}

fn null_file() -> Result<OpenFile> {
	openfiles::null().map_err(|err| Error::msg(format!("Failed to create null file: {err}")))
}

const fn exit_code(result: &ExecutionResult) -> i32 {
	match result.exit_code {
		ExecutionExitCode::Success => 0,
		ExecutionExitCode::GeneralError => 1,
		ExecutionExitCode::InvalidUsage => 2,
		ExecutionExitCode::Unimplemented => 99,
		ExecutionExitCode::CannotExecute => 126,
		ExecutionExitCode::NotFound => 127,
		ExecutionExitCode::Interrupted => 130,
		ExecutionExitCode::BrokenPipe => 141,
		ExecutionExitCode::Custom(code) => code as i32,
	}
}

#[cfg(windows)]
const fn normalize_env_key(key: &str) -> &str {
	if key.eq_ignore_ascii_case("PATH") {
		"PATH"
	} else {
		key
	}
}

#[cfg(not(windows))]
const fn normalize_env_key(key: &str) -> &str {
	key
}

#[cfg(windows)]
fn merge_path_values(existing: &str, incoming: &str) -> String {
	let mut merged = Vec::new();
	let mut seen = HashSet::new();
	push_unique_paths(&mut merged, &mut seen, existing);
	push_unique_paths(&mut merged, &mut seen, incoming);

	std::env::join_paths(merged.iter())
		.map_or_else(|_| merged.join(";"), |paths| paths.to_string_lossy().into_owned())
}

#[cfg(windows)]
fn push_unique_paths(merged: &mut Vec<String>, seen: &mut HashSet<String>, value: &str) {
	for segment in std::env::split_paths(value) {
		let segment_str = segment.to_string_lossy().into_owned();
		let normalized = normalize_path_segment(&segment_str);
		if normalized.is_empty() {
			continue;
		}
		if seen.insert(normalized) {
			merged.push(segment_str);
		}
	}
}

#[cfg(windows)]
fn normalize_path_segment(segment: &str) -> String {
	let trimmed = segment.trim().trim_matches('"');
	if trimmed.is_empty() {
		return String::new();
	}

	let mut normalized = std::path::PathBuf::new();
	for component in std::path::Path::new(trimmed).components() {
		normalized.push(component.as_os_str());
	}

	normalized.to_string_lossy().to_ascii_lowercase()
}

#[cfg(not(windows))]
fn merge_path_values(_existing: &str, incoming: &str) -> String {
	incoming.to_string()
}

async fn create_session(config: &ShellConfig) -> Result<ShellSessionCore> {
	let mut shell = BrushShell::builder()
		.do_not_inherit_env(true)
		.profile(ProfileLoadBehavior::Skip)
		.rc(RcLoadBehavior::Skip)
		.builtins(default_builtins(BuiltinSet::BashMode))
		.build()
		.await
		.map_err(|err| Error::msg(format!("Failed to initialize shell: {err}")))?;

	if let Some(exec_builtin) = shell.builtin_mut("exec") {
		exec_builtin.disabled = true;
	}
	if let Some(suspend_builtin) = shell.builtin_mut("suspend") {
		suspend_builtin.disabled = true;
	}
	shell.register_builtin("sleep", builtins::builtin::<SleepCommand, _>());
	shell.register_builtin("timeout", builtins::builtin::<TimeoutCommand, _>());

	let mut merged_path: Option<String> = None;
	for (key, value) in std::env::vars() {
		let normalized_key = normalize_env_key(&key);
		if should_skip_env_var(normalized_key) {
			continue;
		}
		if normalized_key == "PATH" {
			merged_path = Some(match merged_path {
				Some(existing) => merge_path_values(&existing, &value),
				None => value,
			});
			continue;
		}
		let mut var = ShellVariable::new(ShellValue::String(value));
		var.export();
		shell
			.env_mut()
			.set_global(normalized_key, var)
			.map_err(|err| Error::msg(format!("Failed to set env: {err}")))?;
	}

	#[cfg(windows)]
	if merged_path.is_none()
		&& let Some(value) = std::env::var_os("Path").or_else(|| std::env::var_os("PATH"))
	{
		merged_path = Some(value.to_string_lossy().into_owned());
	}

	if let Some(path_value) = merged_path {
		let mut var = ShellVariable::new(ShellValue::String(path_value));
		var.export();
		shell
			.env_mut()
			.set_global("PATH", var)
			.map_err(|err| Error::msg(format!("Failed to set env: {err}")))?;
	}

	if let Some(env) = config.session_env.as_ref() {
		for (key, value) in env {
			let normalized_key = normalize_env_key(key);
			if should_skip_env_var(normalized_key) {
				continue;
			}
			let mut var = ShellVariable::new(ShellValue::String(value.clone()));
			var.export();
			shell
				.env_mut()
				.set_global(normalized_key, var)
				.map_err(|err| Error::msg(format!("Failed to set env: {err}")))?;
		}
	}
	apply_env_fallback(&mut shell)?;

	#[cfg(windows)]
	configure_windows_path(&mut shell)?;

	if let Some(snapshot_path) = config.snapshot_path.as_ref() {
		source_snapshot(&mut shell, snapshot_path).await?;
	}

	Ok(ShellSessionCore { shell })
}

async fn source_snapshot(shell: &mut BrushShell, snapshot_path: &str) -> Result<()> {
	let mut params = shell.default_exec_params();
	let source_info = SourceInfo::from("pi-natives:snapshot");
	params.set_fd(OpenFiles::STDIN_FD, null_file()?);
	params.set_fd(OpenFiles::STDOUT_FD, null_file()?);
	params.set_fd(OpenFiles::STDERR_FD, null_file()?);

	let escaped = snapshot_path.replace('\'', "'\\''");
	let command = format!("source '{escaped}'");
	shell
		.run_string(command, &source_info, &params)
		.await
		.map_err(|err| Error::msg(format!("Failed to source snapshot: {err}")))?;
	Ok(())
}

async fn run_shell_command(
	session: &mut ShellSessionCore,
	options: &ShellRunConfig,
	on_chunk: Option<mpsc::UnboundedSender<String>>,
	cancel_token: CancellationToken,
) -> Result<(ExecutionResult, Option<MinimizerResult>, OutputTruncation)> {
	if let Some(cwd) = options.cwd.as_deref() {
		session
			.shell
			.set_working_dir(cwd)
			.map_err(|err| Error::msg(format!("Failed to set cwd: {err}")))?;
	}

	let env_scope_pushed = apply_command_env(&mut session.shell, options.env.as_ref())?;

	let minimizer_mode = if let Some(config) = options.minimizer.as_ref() {
		minimizer::engine::mode_for(&options.command, config)
	} else {
		minimizer::engine::MinimizerMode::None
	};
	let should_minimize = !matches!(minimizer_mode, minimizer::engine::MinimizerMode::None);
	let max_capture_bytes = if let Some(config) = options.minimizer.as_ref() {
		config.max_capture_bytes as usize
	} else {
		0
	};

	let (reader_file, writer_file) = pipe_to_files("output")?;

	let stdout_file = OpenFile::from(
		writer_file
			.try_clone()
			.map_err(|err| Error::msg(format!("Failed to clone pipe: {err}")))?,
	);
	let stderr_file = OpenFile::from(writer_file);

	let mut params = session.shell.default_exec_params();
	params.set_fd(OpenFiles::STDIN_FD, null_file()?);
	params.set_fd(OpenFiles::STDOUT_FD, stdout_file);
	params.set_fd(OpenFiles::STDERR_FD, stderr_file);
	params.process_group_policy = ProcessGroupPolicy::NewProcessGroup;
	params.set_cancel_token(cancel_token.clone());
	let baseline_descendants = process::current_descendant_pids();
	let command_pgid = Arc::new(AtomicI32::new(0));
	let reader_cancel = CancellationToken::new();
	let (activity_tx, mut activity_rx) = mpsc::channel::<()>(1);
	// Stream every raw chunk to the caller live, regardless of whether
	// minimization is enabled. When minimization actually transforms the
	// output, we propagate the replacement text via `MinimizerResult.text`
	// so the caller can swap their accumulated buffer for the minimized
	// version without losing intermediate progress updates.
	let reader_callback = on_chunk;
	let output_budget = OutputBudget::new(OutputBudget::DEFAULT_LIMIT);
	let mut reader_handle = tokio::spawn({
		let reader_cancel = reader_cancel.clone();
		let output_budget = output_budget.clone();
		async move {
			if should_minimize {
				let output = read_output_buffered(
					reader_file,
					reader_callback,
					reader_cancel,
					activity_tx,
					max_capture_bytes,
					output_budget,
				)
				.await;
				Result::<OutputRead>::Ok(OutputRead::Buffered(output))
			} else {
				Box::pin(read_output(
					reader_file,
					reader_callback,
					reader_cancel,
					activity_tx,
					output_budget,
				))
				.await;
				Result::<OutputRead>::Ok(OutputRead::Streaming)
			}
		}
	});
	let cancel_bridge = tokio::spawn({
		let cancel_token = cancel_token.clone();
		let reader_cancel = reader_cancel.clone();
		async move {
			cancel_token.cancelled().await;
			reader_cancel.cancel();
		}
	});
	let pgid_probe =
		tokio::spawn(capture_new_process_group(baseline_descendants.clone(), command_pgid.clone()));
	let process_cancel_bridge = tokio::spawn({
		let cancel_token = cancel_token.clone();
		let baseline_descendants = baseline_descendants.clone();
		let command_pgid = command_pgid.clone();
		async move {
			cancel_token.cancelled().await;
			terminate_new_descendants(&baseline_descendants, command_pgid.load(Ordering::SeqCst))
				.await;
		}
	});
	let source_info = SourceInfo::from("pi-natives:command");
	let result = session
		.shell
		.run_string(options.command.clone(), &source_info, &params)
		.await;
	pgid_probe.abort();
	let _ = pgid_probe.await;

	let mut cleanup_error = None;
	if cancel_token.is_cancelled() {
		terminate_background_jobs(&session.shell).await;
	}

	if env_scope_pushed
		&& let Err(err) = session.shell.env_mut().pop_scope(EnvironmentScope::Command)
	{
		cleanup_error = Some(Error::msg(format!("Failed to pop env scope: {err}")));
	}

	drop(params);

	// The foreground command can complete while background jobs keep the
	// stdout/stderr pipe open. Don't hang forever waiting for EOF; drain output
	// for a short period, then cancel.
	const POST_EXIT_IDLE: Duration = Duration::from_millis(250);
	const POST_EXIT_MAX: Duration = Duration::from_secs(2);
	const READER_SHUTDOWN_TIMEOUT: Duration = Duration::from_millis(250);

	let mut reader_finished = false;
	let mut reader_output = None;
	let mut idle_timer = Box::pin(time::sleep(POST_EXIT_IDLE));
	let mut max_timer = Box::pin(time::sleep(POST_EXIT_MAX));

	loop {
		tokio::select! {
			res = &mut reader_handle => {
				if let Ok(Ok(output)) = res {
					reader_output = Some(output);
				}
				reader_finished = true;
				break;
			}
			msg = activity_rx.recv() => {
				if msg.is_none() {
					break;
				}
				idle_timer.as_mut().reset(time::Instant::now() + POST_EXIT_IDLE);
			}
			() = &mut idle_timer => break,
			() = &mut max_timer => break,
		}
	}

	if !reader_finished {
		reader_output = shutdown_reader_task(
			&reader_cancel,
			&mut reader_handle,
			reader_finished,
			READER_SHUTDOWN_TIMEOUT,
		)
		.await;
	}
	cancel_bridge.abort();
	let _ = cancel_bridge.await;
	if cancel_token.is_cancelled() {
		// Cancel fired — the bridge is actively running its rescan-and-signal
		// loop. Let it run to completion so all three waves get a chance to
		// reach stragglers; aborting here would cut the kill loop short.
		let _ = process_cancel_bridge.await;
	} else {
		// Happy path — the bridge is still parked on `cancel_token.cancelled()`
		// and would never exit on its own. Tear it down.
		process_cancel_bridge.abort();
		let _ = process_cancel_bridge.await;
	}

	if let Some(err) = cleanup_error {
		return Err(err);
	}
	let result = result.map_err(|err| Error::msg(format!("Shell execution failed: {err}")))?;
	let mut minimized_out: Option<MinimizerResult> = None;
	if let Some(OutputRead::Buffered(output)) = reader_output
		&& let Some(config) = options.minimizer.as_ref()
		&& !output.exceeded
	{
		let minimized = match minimizer_mode {
			minimizer::engine::MinimizerMode::WholeCommand => {
				minimizer::apply(&options.command, &output.text, exit_code(&result), config)
			},
			minimizer::engine::MinimizerMode::None => {
				minimizer::MinimizerOutput::passthrough(&output.text)
			},
		};
		if minimized.changed
			&& let Some(original) = minimized.original_text
		{
			let output_bytes = u32::try_from(minimized.text.len()).unwrap_or(u32::MAX);
			minimized_out = Some(MinimizerResult {
				filter: minimized.filter.to_string(),
				text: minimized.text,
				original_text: original,
				input_bytes: u32::try_from(minimized.input_bytes).unwrap_or(u32::MAX),
				output_bytes,
			});
		}
	}
	let truncated_bytes = output_budget.truncated_bytes();
	Ok((result, minimized_out, OutputTruncation {
		output_truncated: truncated_bytes > 0,
		output_truncated_bytes: truncated_bytes,
		..Default::default()
	}))
}

async fn run_shell_command_streams(
	session: &mut ShellSessionCore,
	options: &ShellRunConfig,
	streams: StreamSinks,
	cancel_token: CancellationToken,
) -> Result<(ExecutionResult, OutputTruncation)> {
	if let Some(cwd) = options.cwd.as_deref() {
		session
			.shell
			.set_working_dir(cwd)
			.map_err(|err| Error::msg(format!("Failed to set cwd: {err}")))?;
	}

	let env_scope_pushed = apply_command_env(&mut session.shell, options.env.as_ref())?;

	let (stdout_reader, stdout_writer) = pipe_to_files("stdout")?;
	let (stderr_reader, stderr_writer) = pipe_to_files("stderr")?;

	let stdout_file = OpenFile::from(stdout_writer);
	let stderr_file = OpenFile::from(stderr_writer);

	let mut params = session.shell.default_exec_params();
	params.set_fd(OpenFiles::STDIN_FD, null_file()?);
	params.set_fd(OpenFiles::STDOUT_FD, stdout_file);
	params.set_fd(OpenFiles::STDERR_FD, stderr_file);
	params.process_group_policy = ProcessGroupPolicy::NewProcessGroup;
	params.set_cancel_token(cancel_token.clone());
	let baseline_descendants = process::current_descendant_pids();
	let command_pgid = Arc::new(AtomicI32::new(0));
	let reader_cancel = CancellationToken::new();
	let (activity_tx, mut activity_rx) = mpsc::channel::<()>(1);

	let StreamSinks { stdout: stdout_sink, stderr: stderr_sink } = streams;
	let stdout_budget = OutputBudget::new(OutputBudget::DEFAULT_LIMIT);
	let stderr_budget = OutputBudget::new(OutputBudget::DEFAULT_LIMIT);
	let mut stdout_handle = tokio::spawn(Box::pin(read_output_bytes(
		stdout_reader,
		stdout_sink,
		reader_cancel.clone(),
		activity_tx.clone(),
		stdout_budget.clone(),
	)));
	let mut stderr_handle = tokio::spawn(Box::pin(read_output_bytes(
		stderr_reader,
		stderr_sink,
		reader_cancel.clone(),
		activity_tx,
		stderr_budget.clone(),
	)));

	let cancel_bridge = tokio::spawn({
		let cancel_token = cancel_token.clone();
		let reader_cancel = reader_cancel.clone();
		async move {
			cancel_token.cancelled().await;
			reader_cancel.cancel();
		}
	});
	let pgid_probe =
		tokio::spawn(capture_new_process_group(baseline_descendants.clone(), command_pgid.clone()));
	let process_cancel_bridge = tokio::spawn({
		let cancel_token = cancel_token.clone();
		let baseline_descendants = baseline_descendants.clone();
		let command_pgid = command_pgid.clone();
		async move {
			cancel_token.cancelled().await;
			terminate_new_descendants(&baseline_descendants, command_pgid.load(Ordering::SeqCst))
				.await;
		}
	});
	let source_info = SourceInfo::from("pi-shell:streams");
	let result = session
		.shell
		.run_string(options.command.clone(), &source_info, &params)
		.await;
	pgid_probe.abort();
	let _ = pgid_probe.await;

	let mut cleanup_error = None;
	if cancel_token.is_cancelled() {
		terminate_background_jobs(&session.shell).await;
	}

	if env_scope_pushed
		&& let Err(err) = session.shell.env_mut().pop_scope(EnvironmentScope::Command)
	{
		cleanup_error = Some(Error::msg(format!("Failed to pop env scope: {err}")));
	}

	drop(params);

	const POST_EXIT_IDLE: Duration = Duration::from_millis(250);
	const POST_EXIT_MAX: Duration = Duration::from_secs(2);
	const READER_SHUTDOWN_TIMEOUT: Duration = Duration::from_millis(250);

	let mut stdout_finished = false;
	let mut stderr_finished = false;
	let mut idle_timer = Box::pin(time::sleep(POST_EXIT_IDLE));
	let mut max_timer = Box::pin(time::sleep(POST_EXIT_MAX));

	loop {
		if stdout_finished && stderr_finished {
			break;
		}
		tokio::select! {
			res = &mut stdout_handle, if !stdout_finished => {
				let _ = res;
				stdout_finished = true;
			}
			res = &mut stderr_handle, if !stderr_finished => {
				let _ = res;
				stderr_finished = true;
			}
			msg = activity_rx.recv() => {
				if msg.is_none() {
					break;
				}
				idle_timer.as_mut().reset(time::Instant::now() + POST_EXIT_IDLE);
			}
			() = &mut idle_timer => break,
			() = &mut max_timer => break,
		}
	}

	shutdown_reader_unit_task(
		&reader_cancel,
		&mut stdout_handle,
		stdout_finished,
		READER_SHUTDOWN_TIMEOUT,
	)
	.await;
	shutdown_reader_unit_task(
		&reader_cancel,
		&mut stderr_handle,
		stderr_finished,
		READER_SHUTDOWN_TIMEOUT,
	)
	.await;
	cancel_bridge.abort();
	let _ = cancel_bridge.await;
	if cancel_token.is_cancelled() {
		// Let the kill-wave bridge finish all three signal passes so stragglers
		// have a chance to receive SIGKILL.
		let _ = process_cancel_bridge.await;
	} else {
		process_cancel_bridge.abort();
		let _ = process_cancel_bridge.await;
	}

	if let Some(err) = cleanup_error {
		return Err(err);
	}
	let result = result.map_err(|err| Error::msg(format!("Shell execution failed: {err}")))?;
	let stdout_truncated_bytes = stdout_budget.truncated_bytes();
	let stderr_truncated_bytes = stderr_budget.truncated_bytes();
	Ok((result, OutputTruncation {
		stdout_truncated: stdout_truncated_bytes > 0,
		stdout_truncated_bytes,
		stderr_truncated: stderr_truncated_bytes > 0,
		stderr_truncated_bytes,
		..Default::default()
	}))
}

async fn read_output_bytes(
	reader: fs::File,
	sink: Option<mpsc::UnboundedSender<Bytes>>,
	cancel_token: CancellationToken,
	activity: mpsc::Sender<()>,
	budget: OutputBudget,
) {
	const BUF: usize = 65536;

	#[cfg(unix)]
	let Ok(reader) = register_nonblocking_pipe(reader) else {
		return;
	};
	#[cfg(not(unix))]
	let mut reader = tokio::fs::File::from_std(reader);

	loop {
		let mut buf = vec![0u8; BUF];
		#[cfg(unix)]
		let n = {
			let Ok(mut readiness) = (tokio::select! {
				ready = reader.readable() => ready,
				() = cancel_token.cancelled() => break,
			}) else {
				break;
			};
			match readiness.try_io(|inner| read_nonblocking(inner.get_ref(), &mut buf)) {
				Ok(Ok(0)) => break,
				Ok(Ok(n)) => n,
				Ok(Err(e)) if e.kind() == io::ErrorKind::Interrupted => continue,
				Ok(Err(_)) => break,
				Err(_would_block) => continue,
			}
		};
		#[cfg(not(unix))]
		let n = {
			let read_future = reader.read(&mut buf);
			tokio::pin!(read_future);
			match tokio::select! {
				res = &mut read_future => res,
				() = cancel_token.cancelled() => break,
			} {
				Ok(0) => break,
				Ok(n) => n,
				Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
				Err(_) => break,
			}
		};
		let _ = activity.try_send(());
		buf.truncate(n);
		if let Some(sink) = sink.as_ref() {
			let allowed = budget
				.remaining
				.fetch_update(Ordering::SeqCst, Ordering::SeqCst, |remaining| {
					Some(remaining.saturating_sub(buf.len()))
				})
				.unwrap_or(0)
				.min(buf.len());
			if allowed > 0 && sink.send(Bytes::copy_from_slice(&buf[..allowed])).is_err() {
				break;
			}
			if allowed < buf.len() {
				budget.mark_truncated(buf.len() - allowed);
			}
		}
	}
}

// Rescan-and-signal loop for cancellation. Each pass picks up descendants
// spawned during the previous wave's grace period, then exits as soon as no
// targets remain so unrelated later commands are not swept into old cancels.
async fn capture_new_process_group<S: std::hash::BuildHasher + Sync>(
	baseline: HashSet<i32, S>,
	command_pgid: Arc<AtomicI32>,
) {
	for _ in 0..100 {
		let mut targets = process::TerminationTargets::new();
		process::add_new_descendants(&mut targets, &baseline);
		if let Some(pgid) = targets.first_pgid() {
			command_pgid.store(pgid, Ordering::SeqCst);
			return;
		}
		time::sleep(Duration::from_millis(5)).await;
	}
}

async fn terminate_new_descendants<S: std::hash::BuildHasher + Sync>(
	baseline: &HashSet<i32, S>,
	command_pgid: i32,
) {
	const WAVES: u32 = 3;
	for wave in 0..WAVES {
		let mut targets = process::TerminationTargets::new();
		process::add_new_descendants(&mut targets, baseline);
		if targets.is_empty() && command_pgid <= 0 {
			return;
		}
		let signal = if wave == 0 {
			process::TERM_SIGNAL
		} else {
			process::KILL_SIGNAL
		};
		if command_pgid > 0 {
			let _ = process::kill_process_group(command_pgid, signal);
		}
		targets.signal(signal);
		if wave + 1 < WAVES {
			let pause = if wave == 0 {
				Duration::from_millis(75)
			} else {
				Duration::from_millis(150)
			};
			time::sleep(pause).await;
		}
	}
}
async fn terminate_background_jobs(shell: &BrushShell) {
	let mut targets = process::TerminationTargets::new();
	for job in &shell.jobs().jobs {
		if let Some(pgid) = job.process_group_id() {
			targets.add_pgid(pgid);
		}
		if let Some(pid) = job.representative_pid() {
			targets.add_pid(pid);
		}
	}
	if targets.is_empty() {
		return;
	}

	targets.signal(process::TERM_SIGNAL);
	time::sleep(Duration::from_millis(150)).await;
	targets.signal(process::KILL_SIGNAL);
}

/// Apply per-command environment variables onto a freshly pushed
/// `Command` scope. Returns `true` when a scope was pushed (so the caller
/// can pop it after the command runs), `false` when there were no vars and
/// the existing scopes remain untouched.
fn apply_command_env(
	shell: &mut BrushShell,
	env: Option<&HashMap<String, String>>,
) -> Result<bool> {
	let Some(env) = env else {
		return Ok(false);
	};
	shell.env_mut().push_scope(EnvironmentScope::Command);
	for (key, value) in env {
		let normalized_key = normalize_env_key(key);
		if should_skip_env_var(normalized_key) {
			continue;
		}
		let mut var = ShellVariable::new(ShellValue::String(value.clone()));
		var.export();
		if let Err(err) = shell
			.env_mut()
			.add(normalized_key, var, EnvironmentScope::Command)
		{
			let _ = shell.env_mut().pop_scope(EnvironmentScope::Command);
			return Err(Error::msg(format!("Failed to set env: {err}")));
		}
	}
	Ok(true)
}

/// Define `env` as a shell variable expanding to the literal `$env` so that
/// brush-core's POSIX parameter expansion preserves PowerShell-style
/// `$env:NAME` references when commands are dispatched through brush to a
/// PowerShell (or any) subprocess. The variable is not exported, so it only
/// influences brush's own expansion; the child process environment is
/// unaffected.
///
/// User-driven assignments (`env=prod; echo "$env:8080"`) push their own
/// binding in the command scope and shadow this global default, preserving
/// the bash POSIX contract for callers that genuinely use a variable named
/// `env`.
fn apply_env_fallback(shell: &mut BrushShell) -> Result<()> {
	if shell.env().get("env").is_some() {
		return Ok(());
	}
	let var = ShellVariable::new(ShellValue::String("$env".to_string()));
	shell
		.env_mut()
		.set_global("env", var)
		.map_err(|err| Error::msg(format!("Failed to set env fallback: {err}")))
}

fn should_skip_env_var(key: &str) -> bool {
	if key.starts_with("BASH_FUNC_") && key.ends_with("%%") {
		return true;
	}

	matches!(
		key,
		"BASH_ENV"
			| "ENV"
			| "HISTFILE"
			| "HISTTIMEFORMAT"
			| "HISTCMD"
			| "PS0"
			| "PS1"
			| "PS2"
			| "PS4"
			| "BRUSH_PS_ALT"
			| "READLINE_LINE"
			| "READLINE_POINT"
			| "BRUSH_VERSION"
			| "BASH"
			| "BASHOPTS"
			| "BASH_ALIASES"
			| "BASH_ARGV0"
			| "BASH_CMDS"
			| "BASH_SOURCE"
			| "BASH_SUBSHELL"
			| "BASH_VERSINFO"
			| "BASH_VERSION"
			| "SHELLOPTS"
			| "SHLVL"
			| "SHELL"
			| "COMP_WORDBREAKS"
			| "DIRSTACK"
			| "EPOCHREALTIME"
			| "EPOCHSECONDS"
			| "FUNCNAME"
			| "GROUPS"
			| "IFS"
			| "LINENO"
			| "MACHTYPE"
			| "OSTYPE"
			| "OPTERR"
			| "OPTIND"
			| "PIPESTATUS"
			| "PPID"
			| "PWD"
			| "OLDPWD"
			| "RANDOM"
			| "SRANDOM"
			| "SECONDS"
			| "UID"
			| "EUID"
			| "HOSTNAME"
			| "HOSTTYPE"
	)
}

const fn session_keepalive(result: &ExecutionResult) -> bool {
	match result.next_control_flow {
		ExecutionControlFlow::Normal => true,
		ExecutionControlFlow::BreakLoop { .. } => false,
		ExecutionControlFlow::ContinueLoop { .. } => false,
		ExecutionControlFlow::ReturnFromFunctionOrScript => false,
		ExecutionControlFlow::ExitShell => false,
	}
}

enum OutputRead {
	Streaming,
	Buffered(BufferedOutput),
}

struct BufferedOutput {
	text:     String,
	exceeded: bool,
}

#[derive(Debug, Clone, Copy, Default)]
struct OutputTruncation {
	output_truncated:       bool,
	output_truncated_bytes: u64,
	stdout_truncated:       bool,
	stdout_truncated_bytes: u64,
	stderr_truncated:       bool,
	stderr_truncated_bytes: u64,
}

#[derive(Clone)]
struct OutputBudget {
	remaining: Arc<AtomicUsize>,
	truncated: Arc<AtomicUsize>,
}

impl OutputBudget {
	const DEFAULT_LIMIT: usize = 8 * 1024 * 1024;

	fn new(limit: usize) -> Self {
		Self {
			remaining: Arc::new(AtomicUsize::new(limit)),
			truncated: Arc::new(AtomicUsize::new(0)),
		}
	}

	fn mark_truncated(&self, bytes: usize) {
		self.truncated.fetch_add(bytes, Ordering::SeqCst);
	}

	fn truncated_bytes(&self) -> u64 {
		u64::try_from(self.truncated.load(Ordering::SeqCst)).unwrap_or(u64::MAX)
	}
}

async fn shutdown_reader_task<T>(
	reader_cancel: &CancellationToken,
	reader_handle: &mut tokio::task::JoinHandle<Result<T>>,
	reader_finished: bool,
	timeout: Duration,
) -> Option<T> {
	if reader_finished {
		return None;
	}
	reader_cancel.cancel();
	match time::timeout(timeout, &mut *reader_handle).await {
		Ok(Ok(Ok(output))) => Some(output),
		Ok(_) => None,
		Err(_) => {
			reader_handle.abort();
			let _ = reader_handle.await;
			None
		},
	}
}

async fn shutdown_reader_unit_task(
	reader_cancel: &CancellationToken,
	reader_handle: &mut tokio::task::JoinHandle<()>,
	reader_finished: bool,
	timeout: Duration,
) {
	if reader_finished {
		return;
	}
	reader_cancel.cancel();
	if time::timeout(timeout, &mut *reader_handle).await.is_err() {
		reader_handle.abort();
		let _ = reader_handle.await;
	}
}

async fn read_output(
	reader: fs::File,
	on_chunk: Option<mpsc::UnboundedSender<String>>,
	cancel_token: CancellationToken,
	activity: mpsc::Sender<()>,
	budget: OutputBudget,
) {
	const REPLACEMENT: &str = "\u{FFFD}";
	const BUF: usize = 65536;
	let mut buf = vec![0u8; BUF + 4]; // +4 for max UTF-8 char
	let mut it = 0;

	#[cfg(unix)]
	let Ok(reader) = register_nonblocking_pipe(reader) else {
		return;
	};
	#[cfg(not(unix))]
	let reader = tokio::fs::File::from_std(reader);
	#[cfg(not(unix))]
	tokio::pin!(reader);

	loop {
		#[cfg(unix)]
		let n = {
			let Ok(mut readiness) = (tokio::select! {
				ready = reader.readable() => ready,
				() = cancel_token.cancelled() => break,
			}) else {
				break;
			};
			match readiness.try_io(|inner| read_nonblocking(inner.get_ref(), &mut buf[it..BUF])) {
				Ok(Ok(0)) => break,
				Ok(Ok(n)) => n,
				Ok(Err(e)) if e.kind() == io::ErrorKind::Interrupted => continue,
				Ok(Err(_)) => break,
				Err(_would_block) => continue,
			}
		};
		#[cfg(not(unix))]
		let n = {
			let read_future = reader.read(&mut buf[it..BUF]);
			tokio::pin!(read_future);
			match tokio::select! {
				res = &mut read_future => res,
				() = cancel_token.cancelled() => break,
			} {
				Ok(0) => break, // EOF
				Ok(n) => n,
				Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
				Err(_) => break,
			}
		};
		if n > 0 {
			let _ = activity.try_send(());
		}
		it += n;

		// Consume as much of `pending` as is decodable *right now*.
		while it > 0 {
			let pending = &buf[..it];
			match str::from_utf8(pending) {
				Ok(text) => {
					emit_chunk(text, on_chunk.as_ref(), &budget);
					it = 0;
					break;
				},
				Err(err) => {
					let p = err.valid_up_to();
					if p > 0 {
						// SAFETY: [..p] is guaranteed valid UTF-8 by valid_up_to().
						let text = unsafe { str::from_utf8_unchecked(&pending[..p]) };
						emit_chunk(text, on_chunk.as_ref(), &budget);
						// copy p..it to the beginning of the buffer
						buf.copy_within(p..it, 0);
						it -= p;
					}

					match err.error_len() {
						Some(p) => {
							// Invalid byte sequence: emit replacement and drop those bytes.
							emit_chunk(REPLACEMENT, on_chunk.as_ref(), &budget);
							// copy p..it to the beginning of the buffer
							buf.copy_within(p..it, 0);
							it -= p;
							// continue loop in case more bytes remain after the
							// invalid sequence
						},
						None => {
							// Incomplete UTF-8 sequence at end: keep bytes for next read.
							break;
						},
					}
				},
			}
		}
	}

	// Flush whatever is left at EOF (including an incomplete final sequence).
	for chunk in buf[..it].utf8_chunks() {
		let valid = chunk.valid();
		if !valid.is_empty() {
			emit_chunk(valid, on_chunk.as_ref(), &budget);
		}
		if !chunk.invalid().is_empty() {
			emit_chunk(REPLACEMENT, on_chunk.as_ref(), &budget);
		}
	}
}

async fn read_output_buffered(
	reader: fs::File,
	on_chunk: Option<mpsc::UnboundedSender<String>>,
	cancel_token: CancellationToken,
	activity: mpsc::Sender<()>,
	max_capture_bytes: usize,
	budget: OutputBudget,
) -> BufferedOutput {
	const REPLACEMENT: &str = "\u{FFFD}";
	const BUF: usize = 65536;
	let mut buf = vec![0u8; BUF];
	let mut captured = Vec::new();
	let mut exceeded = false;
	// Pending bytes from a prior read that ended mid-UTF-8 sequence. We hold
	// them back so we emit only valid UTF-8 to the streaming callback while
	// still capturing every byte into `captured` for post-processing.
	let mut pending = Vec::<u8>::new();

	#[cfg(unix)]
	let Ok(reader) = register_nonblocking_pipe(reader) else {
		return BufferedOutput { text: String::new(), exceeded: true };
	};
	#[cfg(not(unix))]
	let reader = tokio::fs::File::from_std(reader);
	#[cfg(not(unix))]
	tokio::pin!(reader);

	loop {
		#[cfg(unix)]
		let n = {
			let Ok(mut readiness) = (tokio::select! {
				ready = reader.readable() => ready,
				() = cancel_token.cancelled() => break,
			}) else {
				break;
			};
			match readiness.try_io(|inner| read_nonblocking(inner.get_ref(), &mut buf)) {
				Ok(Ok(0)) => break,
				Ok(Ok(n)) => n,
				Ok(Err(e)) if e.kind() == io::ErrorKind::Interrupted => continue,
				Ok(Err(_)) => break,
				Err(_would_block) => continue,
			}
		};
		#[cfg(not(unix))]
		let n = {
			let read_future = reader.read(&mut buf);
			tokio::pin!(read_future);
			match tokio::select! {
				res = &mut read_future => res,
				() = cancel_token.cancelled() => break,
			} {
				Ok(0) => break,
				Ok(n) => n,
				Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
				Err(_) => break,
			}
		};
		if n > 0 {
			let _ = activity.try_send(());
		}
		// Once `exceeded`, the post-process minimizer is bypassed (see the
		// `!output.exceeded` gate at the call site), so further appends just
		// grow `captured` without serving any purpose. Stop accumulating to
		// bound peak memory on commands that produce very large output.
		if !exceeded {
			if captured.len().saturating_add(n) > max_capture_bytes {
				exceeded = true;
			} else {
				captured.extend_from_slice(&buf[..n]);
			}
		}

		// Stream whatever is validly decodable *right now* to the callback,
		// carrying incomplete trailing UTF-8 bytes over to the next iteration.
		if let Some(cb) = on_chunk.as_ref() {
			pending.extend_from_slice(&buf[..n]);
			while !pending.is_empty() {
				match str::from_utf8(&pending) {
					Ok(text) => {
						emit_chunk(text, Some(cb), &budget);
						pending.clear();
						break;
					},
					Err(err) => {
						let p = err.valid_up_to();
						if p > 0 {
							// SAFETY: [..p] is valid UTF-8 per valid_up_to().
							let text = unsafe { str::from_utf8_unchecked(&pending[..p]) };
							emit_chunk(text, Some(cb), &budget);
							pending.drain(..p);
						}
						match err.error_len() {
							Some(skip) => {
								emit_chunk(REPLACEMENT, Some(cb), &budget);
								pending.drain(..skip);
							},
							None => break,
						}
					},
				}
			}
		}
	}

	// Flush any trailing bytes the streaming decoder held back at EOF.
	if let Some(cb) = on_chunk.as_ref() {
		for chunk in pending.utf8_chunks() {
			let valid = chunk.valid();
			if !valid.is_empty() {
				emit_chunk(valid, Some(cb), &budget);
			}
			if !chunk.invalid().is_empty() {
				emit_chunk(REPLACEMENT, Some(cb), &budget);
			}
		}
	}

	BufferedOutput { text: String::from_utf8_lossy(&captured).into_owned(), exceeded }
}

#[cfg(unix)]
fn register_nonblocking_pipe(reader: fs::File) -> io::Result<tokio::io::unix::AsyncFd<fs::File>> {
	set_nonblocking(&reader)?;
	tokio::io::unix::AsyncFd::new(reader)
}

#[cfg(unix)]
fn set_nonblocking<T: std::os::fd::AsRawFd>(file: &T) -> io::Result<()> {
	let fd = file.as_raw_fd();
	// SAFETY: `fd` is owned by `file` and remains valid for the duration of
	// these `fcntl` calls.
	let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
	if flags < 0 {
		return Err(io::Error::last_os_error());
	}
	if flags & libc::O_NONBLOCK != 0 {
		return Ok(());
	}

	// SAFETY: `fd` remains valid here and we are only toggling `O_NONBLOCK`.
	let result = unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) };
	if result < 0 {
		Err(io::Error::last_os_error())
	} else {
		Ok(())
	}
}

#[cfg(unix)]
fn read_nonblocking<T: std::os::fd::AsRawFd>(file: &T, buf: &mut [u8]) -> io::Result<usize> {
	// SAFETY: `buf` is writable for `buf.len()` bytes, and the raw fd obtained
	// from `file` stays valid for the duration of the syscall.
	let read = unsafe { libc::read(file.as_raw_fd(), buf.as_mut_ptr().cast(), buf.len()) };
	if read < 0 {
		Err(io::Error::last_os_error())
	} else {
		Ok(read as usize)
	}
}

fn emit_chunk(text: &str, callback: Option<&mpsc::UnboundedSender<String>>, budget: &OutputBudget) {
	if text.is_empty() {
		return;
	}
	if let Some(callback) = callback {
		let allowed = budget
			.remaining
			.fetch_update(Ordering::SeqCst, Ordering::SeqCst, |remaining| {
				Some(remaining.saturating_sub(text.len()))
			})
			.unwrap_or(0)
			.min(text.len());
		if allowed == 0 {
			budget.mark_truncated(text.len());
			return;
		}
		let mut end = allowed;
		while !text.is_char_boundary(end) {
			end -= 1;
		}
		if end > 0 && callback.send(text[..end].to_string()).is_err() {
			return;
		}
		if end < text.len() {
			budget.mark_truncated(text.len() - end);
		}
	}
}

fn pipe_to_files(label: &str) -> Result<(fs::File, fs::File)> {
	let (r, w) =
		os_pipe::pipe().map_err(|err| Error::msg(format!("Failed to create {label} pipe: {err}")))?;

	#[cfg(unix)]
	let (r, w): (fs::File, fs::File) = {
		use std::os::unix::io::{FromRawFd, IntoRawFd};
		let r = r.into_raw_fd();
		let w = w.into_raw_fd();
		// SAFETY: We just obtained these fds from os_pipe and own them exclusively.
		unsafe { (FromRawFd::from_raw_fd(r), FromRawFd::from_raw_fd(w)) }
	};

	#[cfg(windows)]
	let (r, w): (fs::File, fs::File) = {
		use std::os::windows::io::{FromRawHandle, IntoRawHandle};
		let r = r.into_raw_handle();
		let w = w.into_raw_handle();
		// SAFETY: We just obtained these handles from os_pipe and own them exclusively.
		unsafe { (FromRawHandle::from_raw_handle(r), FromRawHandle::from_raw_handle(w)) }
	};

	Ok((r, w))
}

#[derive(Parser)]
#[command(disable_help_flag = true)]
struct SleepCommand {
	#[arg(required = true)]
	durations: Vec<String>,
}

impl builtins::Command for SleepCommand {
	type Error = brush_core::Error;

	fn execute<SE: brush_core::ShellExtensions>(
		&self,
		context: ExecutionContext<'_, SE>,
	) -> impl Future<Output = std::result::Result<ExecutionResult, brush_core::Error>> + Send {
		let durations = self.durations.clone();
		async move {
			if context.is_cancelled() {
				return Ok(ExecutionExitCode::Interrupted.into());
			}
			let mut total = Duration::from_millis(0);
			for duration in &durations {
				let Some(parsed) = parse_duration(duration) else {
					let _ = writeln!(context.stderr(), "sleep: invalid time interval '{duration}'");
					return Ok(ExecutionResult::new(1));
				};
				total += parsed;
			}
			let sleep = time::sleep(total);
			tokio::pin!(sleep);
			if let Some(cancel_token) = context.cancel_token() {
				tokio::select! {
					() = &mut sleep => Ok(ExecutionResult::success()),
					() = cancel_token.cancelled() => Ok(ExecutionExitCode::Interrupted.into()),
				}
			} else {
				sleep.await;
				Ok(ExecutionResult::success())
			}
		}
	}
}

#[derive(Parser)]
#[command(disable_help_flag = true)]
struct TimeoutCommand {
	#[arg(required = true)]
	duration: String,
	#[arg(required = true, num_args = 1.., trailing_var_arg = true)]
	command:  Vec<String>,
}

impl builtins::Command for TimeoutCommand {
	type Error = brush_core::Error;

	fn execute<SE: brush_core::ShellExtensions>(
		&self,
		context: ExecutionContext<'_, SE>,
	) -> impl Future<Output = std::result::Result<ExecutionResult, brush_core::Error>> + Send {
		let duration = self.duration.clone();
		let command = self.command.clone();
		async move {
			if context.is_cancelled() {
				return Ok(ExecutionExitCode::Interrupted.into());
			}
			let Some(timeout) = parse_duration(&duration) else {
				let _ = writeln!(context.stderr(), "timeout: invalid time interval '{duration}'");
				return Ok(ExecutionResult::new(125));
			};
			if command.is_empty() {
				let _ = writeln!(context.stderr(), "timeout: missing command");
				return Ok(ExecutionResult::new(125));
			}

			let child_cancel = CancellationToken::new();
			let mut params = context.params.clone();
			params.process_group_policy = ProcessGroupPolicy::NewProcessGroup;
			params.set_cancel_token(child_cancel.clone());

			let mut command_line = String::new();
			for (idx, arg) in command.iter().enumerate() {
				if idx > 0 {
					command_line.push(' ');
				}
				command_line.push_str(&quote_arg(arg));
			}

			let cancel_token = context.cancel_token();
			let baseline_descendants = process::current_descendant_pids();
			let command_pgid = Arc::new(AtomicI32::new(0));
			let pgid_probe = tokio::spawn(capture_new_process_group(
				baseline_descendants.clone(),
				command_pgid.clone(),
			));
			let source_info = SourceInfo::from("pi-natives:timeout");
			let run_future = context
				.shell
				.run_string(command_line, &source_info, &params);
			tokio::pin!(run_future);

			let result = if let Some(cancel_token) = cancel_token {
				tokio::select! {
					result = &mut run_future => result,
					() = time::sleep(timeout) => {
						child_cancel.cancel();
						terminate_new_descendants(&baseline_descendants, command_pgid.load(Ordering::SeqCst)).await;
						let _ = time::timeout(Duration::from_secs(2), &mut run_future).await;
						terminate_new_descendants(&baseline_descendants, command_pgid.load(Ordering::SeqCst)).await;
						Ok(ExecutionResult::new(124))
					},
					() = cancel_token.cancelled() => {
						child_cancel.cancel();
						terminate_new_descendants(&baseline_descendants, command_pgid.load(Ordering::SeqCst)).await;
						let _ = time::timeout(Duration::from_secs(2), &mut run_future).await;
						terminate_new_descendants(&baseline_descendants, command_pgid.load(Ordering::SeqCst)).await;
						Ok(ExecutionExitCode::Interrupted.into())
					},
				}
			} else {
				tokio::select! {
					result = &mut run_future => result,
					() = time::sleep(timeout) => {
						child_cancel.cancel();
						terminate_new_descendants(&baseline_descendants, command_pgid.load(Ordering::SeqCst)).await;
						let _ = time::timeout(Duration::from_secs(2), &mut run_future).await;
						terminate_new_descendants(&baseline_descendants, command_pgid.load(Ordering::SeqCst)).await;
						Ok(ExecutionResult::new(124))
					},
				}
			};
			pgid_probe.abort();
			let _ = pgid_probe.await;
			result
		}
	}
}
fn parse_duration(input: &str) -> Option<Duration> {
	let trimmed = input.trim();
	if trimmed.is_empty() {
		return None;
	}
	let (number, multiplier) = match trimmed.chars().last()? {
		's' => (&trimmed[..trimmed.len() - 1], 1.0),
		'm' => (&trimmed[..trimmed.len() - 1], 60.0),
		'h' => (&trimmed[..trimmed.len() - 1], 3600.0),
		'd' => (&trimmed[..trimmed.len() - 1], 86400.0),
		ch if ch.is_ascii_alphabetic() => return None,
		_ => (trimmed, 1.0),
	};
	let value = number.parse::<f64>().ok()?;
	if value.is_sign_negative() {
		return None;
	}
	let millis = value * multiplier * 1000.0;
	if !millis.is_finite() || millis < 0.0 {
		return None;
	}
	Some(Duration::from_millis(millis.round() as u64))
}

fn quote_arg(arg: &str) -> String {
	if arg.is_empty() {
		return "''".to_string();
	}
	let safe = arg
		.chars()
		.all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.' | '/' | ':' | '+'));
	if safe {
		return arg.to_string();
	}
	let escaped = arg.replace('\'', "'\"'\"'");
	format!("'{escaped}'")
}

#[cfg(test)]
mod tests {
	use super::*;

	#[cfg(unix)]
	static PROCESS_TEST_LOCK: TokioMutex<()> = TokioMutex::const_new(());
	#[cfg(unix)]
	async fn wait_until_descendant_visible(pid: i32) {
		for _ in 0..100 {
			if process::current_descendant_pids().contains(&pid) {
				return;
			}
			time::sleep(Duration::from_millis(10)).await;
		}

		panic!("descendant {pid} did not become visible to process discovery");
	}

	/// Truth-table coverage for `brush_core::commands::child_session_action`.
	///
	/// Lives in `pi-natives` because the brush-core crate is excluded from the
	/// workspace (vendored upstream) and cannot be tested standalone — its tokio
	/// dependency only resolves the `net` feature via feature-unification with
	/// other workspace members.
	mod child_session_action {
		use brush_core::commands::{ChildSessionAction, child_session_action};

		/// Interactive brush, leading its own pgroup, terminal stdin: foreground.
		#[test]
		fn interactive_with_terminal_stdin_takes_foreground() {
			assert_eq!(child_session_action(true, true, false), ChildSessionAction::TakeForeground,);
			// Terminal foregrounding wins even when this is the first stage of a
			// pipeline; no detach is attempted.
			assert_eq!(child_session_action(true, true, true), ChildSessionAction::TakeForeground,);
		}

		/// Brush leading a new pgroup with non-terminal stdin detaches only when
		/// it is not part of a multi-command pipeline. Pipeline leaders must stay
		/// in the parent session so later stages can join their process group.
		#[test]
		fn non_terminal_stdin_leading_new_pgroup_detaches_unless_pipeline() {
			assert_eq!(child_session_action(true, false, false), ChildSessionAction::DetachSession,);
			assert_eq!(child_session_action(true, false, true), ChildSessionAction::None,);
		}

		/// Non-interactive brush, terminal stdin, no pipeline: nothing to do.
		#[test]
		fn non_interactive_with_terminal_stdin_does_nothing() {
			assert_eq!(child_session_action(false, true, false), ChildSessionAction::None,);
		}

		/// Non-interactive brush, terminal stdin, joining a pipeline pgroup:
		/// nothing to do (parent already wired pgroup membership).
		#[test]
		fn non_interactive_terminal_stdin_in_pipeline_does_nothing() {
			assert_eq!(child_session_action(false, true, true), ChildSessionAction::None,);
		}

		/// **Embedded host bug fix.** Non-interactive brush, non-terminal stdin,
		/// no pipeline pgroup: detach so the child cannot SIGTTIN/SIGTTOU the
		/// host. This is the case that regressed before this fix and is the
		/// motivating bug for PR #895.
		#[test]
		fn embedded_host_with_non_terminal_stdin_detaches() {
			assert_eq!(child_session_action(false, false, false), ChildSessionAction::DetachSession,);
		}

		/// **Pipeline carve-out.** Non-interactive brush, non-terminal stdin
		/// (pipe), and a multi-command pipeline: MUST NOT detach. For the first
		/// external stage, `setsid()` puts the process-group leader into a
		/// different session, so later stages fail to join its group with
		/// EPERM. For later stages, `setsid()` would either fail with EPERM or
		/// move the child into a new session, breaking the pipeline's shared
		/// process group and job-control signal propagation.
		#[test]
		fn pipeline_stage_does_not_detach() {
			assert_eq!(child_session_action(false, false, true), ChildSessionAction::None,);
		}
	}

	/// End-to-end verification that brush, when embedded as a non-interactive
	/// library (`interactive: false`, exactly what `create_session` produces),
	/// spawns external commands in a **separate session** from the host.
	///
	/// The truth-table tests in `child_session_action` cover the decision in
	/// isolation. This test covers the wiring: it boots a real `BrushShell`,
	/// runs a child that prints its PID then sleeps, and asks the kernel for
	/// that PID's session via `getsid(2)` while the child is still alive.
	/// Pre-fix (`new_pg=false` skipped `detach_session`), the child inherited
	/// the host's session, so `getsid(child_pid) == getsid(0)`. Post-fix,
	/// `setsid` ran and the child is its own session leader
	/// (`getsid(child_pid) == child_pid`).
	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn embedded_external_command_runs_in_its_own_session() {
		use std::io::Read as _;
		let _process_test_guard = PROCESS_TEST_LOCK.lock().await;

		// SAFETY: `getsid(0)` only queries the current process session; the return
		// value is checked.
		let host_sid = unsafe { libc::getsid(0) };
		assert!(host_sid > 0, "getsid(0) failed: {}", std::io::Error::last_os_error());

		// Build the same kind of session pi-natives uses in production.
		let config = ShellConfig { session_env: None, snapshot_path: None, minimizer: None };
		let mut session = create_session(&config).await.expect("create_session");

		// Output pipe shared between the brush child and a concurrent reader. The
		// reader runs on a blocking thread because `os_pipe` reads are blocking.
		let (mut reader, writer) = pipe_to_files("e2e").expect("pipe");
		let stdout_file = OpenFile::from(writer.try_clone().expect("clone"));
		let stderr_file = OpenFile::from(writer);

		let mut params = session.shell.default_exec_params();
		params.set_fd(OpenFiles::STDIN_FD, null_file().expect("null stdin"));
		params.set_fd(OpenFiles::STDOUT_FD, stdout_file);
		params.set_fd(OpenFiles::STDERR_FD, stderr_file);

		// (pid_tx, pid_rx) — reader task signals the test as soon as it has the PID.
		let (pid_tx, pid_rx) = tokio::sync::oneshot::channel::<i32>();
		let reader_handle = tokio::task::spawn_blocking(move || {
			let mut buf = Vec::new();
			// Read just enough to capture the PID line. The child sleeps after
			// printing so the pipe will not back-pressure.
			let mut chunk = [0u8; 64];
			let mut pid_tx = Some(pid_tx);
			while let Ok(n) = reader.read(&mut chunk)
				&& n > 0
			{
				buf.extend_from_slice(&chunk[..n]);
				if pid_tx.is_some()
					&& let Some(line_end) = buf.iter().position(|&byte| byte == b'\n')
					&& let Ok(line) = std::str::from_utf8(&buf[..line_end])
					&& let Ok(pid) = line.trim().parse::<i32>()
				{
					let _ = pid_tx
						.take()
						.expect("pid sender should be present")
						.send(pid);
				}
			}
			buf
		});

		// Run brush in the background so we can call `getsid(child_pid)` while
		// the child is still alive.
		let shell_handle = tokio::spawn(async move {
			let source_info = SourceInfo::from("pi-natives:test");
			// `printf '%d\n' "$$"` then `sleep 0.5`. Long enough for our `getsid`.
			let exec = session
				.shell
				.run_string("/bin/sh -c 'printf \"%d\\n\" \"$$\"; sleep 0.5'", &source_info, &params)
				.await
				.expect("run_string");
			drop(params);
			(session, exec)
		});

		let child_pid = time::timeout(Duration::from_secs(5), pid_rx)
			.await
			.expect("timed out waiting for child PID")
			.expect("reader closed pid channel without sending");
		assert!(child_pid > 0, "got non-positive child pid: {child_pid}");

		// Snapshot the child's session ID immediately, while the child is still
		// in `sleep`. POSIX guarantees `getsid` against a live PID returns the
		// session of that process.
		// SAFETY: `child_pid` is a positive PID from the child; errors are reported via
		// the checked return value.
		let child_sid = unsafe { libc::getsid(child_pid) };
		assert!(
			child_sid > 0,
			"getsid({child_pid}) failed: {} (child may have already exited)",
			std::io::Error::last_os_error(),
		);

		// Drain the brush task and the pipe reader.
		let (_session, exec) = time::timeout(Duration::from_secs(5), shell_handle)
			.await
			.expect("shell timed out")
			.expect("shell task panicked");
		assert!(
			matches!(exec.exit_code, ExecutionExitCode::Success),
			"unexpected exit: {}",
			exit_code(&exec),
		);
		let _ = time::timeout(Duration::from_secs(2), reader_handle).await;

		assert_ne!(
			child_sid, host_sid,
			"child PID {child_pid} inherited host session {host_sid}; setsid() did not run — the \
			 embedded-host bug is back",
		);
		assert_eq!(
			child_sid, child_pid,
			"child PID {child_pid} should be its own session leader after setsid",
		);
	}

	#[tokio::test]
	async fn abort_state_signals_cancel_token() {
		let abort_state = ShellAbortState::default();
		let mut cancel_token = CancelToken::default();
		let abort_token = cancel_token.emplace_abort_token();

		let generation = abort_state.publish(abort_token).await;
		abort_state.activate(generation).await;
		abort_state.abort().await;

		let reason = time::timeout(Duration::from_millis(100), cancel_token.wait())
			.await
			.expect("cancel token should be signalled");
		assert!(matches!(reason, AbortReason::Signal));
	}

	#[tokio::test]
	async fn abort_state_latches_abort_before_token_publication() {
		let abort_state = ShellAbortState::default();
		let mut cancel_token = CancelToken::default();

		abort_state.abort().await;
		let abort_token = cancel_token.emplace_abort_token();
		let generation = abort_state.publish(abort_token).await;
		abort_state.activate(generation).await;

		let reason = time::timeout(Duration::from_millis(100), cancel_token.wait())
			.await
			.expect("latched abort should signal token after publication");
		assert!(matches!(reason, AbortReason::Signal));
	}

	#[tokio::test]
	async fn abort_state_latches_abort_after_stale_generation_cleared() {
		let abort_state = ShellAbortState::default();
		let mut stale_cancel = CancelToken::default();
		let stale_abort = stale_cancel.emplace_abort_token();
		let stale_generation = abort_state.publish(stale_abort).await;
		abort_state.activate(stale_generation).await;
		abort_state.clear(stale_generation).await;

		abort_state.abort().await;

		let mut next_cancel = CancelToken::default();
		let next_abort = next_cancel.emplace_abort_token();
		let next_generation = abort_state.publish(next_abort).await;
		abort_state.activate(next_generation).await;

		let reason = time::timeout(Duration::from_millis(100), next_cancel.wait())
			.await
			.expect("handoff-window abort should latch for the next active token");
		assert!(matches!(reason, AbortReason::Signal));
		assert!(
			time::timeout(Duration::from_millis(20), stale_cancel.wait())
				.await
				.is_err(),
			"stale generation should already be cleared, not signalled again"
		);
	}

	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn shell_abort_before_run_token_publication_interrupts_command() {
		let _process_test_guard = PROCESS_TEST_LOCK.lock().await;
		let shell = Shell::new(None);
		shell.abort().await;

		let started = std::time::Instant::now();
		let result = time::timeout(
			Duration::from_secs(2),
			shell.run(
				ShellRunOptions { command: "/bin/sh -c 'sleep 5'".to_string(), ..Default::default() },
				None,
				CancelToken::default(),
			),
		)
		.await
		.expect("latched abort should interrupt instead of hanging")
		.expect("shell run should return cancellation result");

		assert!(result.cancelled, "latched Shell::abort should surface as cancellation");
		assert_eq!(result.exit_code, None);
		assert!(started.elapsed() < Duration::from_secs(2), "command was not interrupted promptly");
	}

	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn overlapping_shell_abort_interrupts_active_run_not_queued_run() {
		let _process_test_guard = PROCESS_TEST_LOCK.lock().await;
		let shell = Arc::new(Shell::new(None));
		let (first_tx, mut first_rx) = mpsc::unbounded_channel::<String>();
		let (second_tx, mut second_rx) = mpsc::unbounded_channel::<String>();

		let first = tokio::spawn({
			let shell = shell.clone();
			async move {
				shell
					.run(
						ShellRunOptions {
							command: "printf first-started; sleep 5".to_string(),
							..Default::default()
						},
						Some(first_tx),
						CancelToken::default(),
					)
					.await
			}
		});

		// Output may arrive in multiple chunks: the reader emits whatever bytes
		// are decodable per pipe read, so a logical marker can be split across
		// chunks (e.g. a lone "f"). Accumulate until the full marker is present.
		let mut first_seen = String::new();
		while !first_seen.starts_with("first-started") {
			let chunk = time::timeout(Duration::from_secs(2), first_rx.recv())
				.await
				.expect("first command should emit startup marker")
				.expect("first output channel should remain open");
			first_seen.push_str(&chunk);
		}
		assert!(first_seen.starts_with("first-started"), "unexpected first output: {first_seen:?}");

		let second = tokio::spawn({
			let shell = shell.clone();
			async move {
				shell
					.run(
						ShellRunOptions {
							command: "printf second-ran".to_string(),
							..Default::default()
						},
						Some(second_tx),
						CancelToken::default(),
					)
					.await
			}
		});
		time::sleep(Duration::from_millis(50)).await;

		shell.abort().await;

		let first_result = time::timeout(Duration::from_secs(2), first)
			.await
			.expect("active run should finish promptly after abort")
			.expect("active run task should not panic")
			.expect("active run should return a result");
		assert!(first_result.cancelled, "abort should target the active first run");
		assert_eq!(first_result.exit_code, None);

		let second_result = time::timeout(Duration::from_secs(2), second)
			.await
			.expect("queued run should finish after active run releases session")
			.expect("queued run task should not panic")
			.expect("queued run should return a result");
		assert!(!second_result.cancelled, "queued run must not steal the abort target");
		assert_eq!(second_result.exit_code, Some(0));

		// The queued run's `printf second-ran` output can likewise be split
		// across chunks; accumulate until the full marker is received.
		let mut second_seen = String::new();
		while second_seen != "second-ran" {
			let chunk = time::timeout(Duration::from_secs(2), second_rx.recv())
				.await
				.expect("second command should emit after active abort")
				.expect("second output channel should remain open");
			second_seen.push_str(&chunk);
		}
		assert_eq!(second_seen, "second-ran");
	}

	#[tokio::test]
	async fn output_budget_caps_streaming_chunks() {
		let budget = OutputBudget::new(5);
		let (tx, mut rx) = mpsc::unbounded_channel::<String>();

		emit_chunk("hello", Some(&tx), &budget);
		emit_chunk("world", Some(&tx), &budget);
		drop(tx);

		let mut received = String::new();
		while let Some(chunk) = rx.recv().await {
			received.push_str(&chunk);
		}
		assert_eq!(received, "hello");
		assert_eq!(budget.truncated_bytes(), 5);
	}

	#[cfg(unix)]
	#[tokio::test]
	async fn very_large_stdout_caps_output_and_surfaces_truncation() {
		let (reader, mut writer) = pipe_to_files("large-output").expect("pipe should be created");
		let budget = OutputBudget::new(1024);
		let (tx, mut rx) = mpsc::unbounded_channel::<String>();
		let (activity_tx, _activity_rx) = mpsc::channel(1);
		let handle = tokio::spawn(read_output(
			reader,
			Some(tx),
			CancellationToken::new(),
			activity_tx,
			budget.clone(),
		));

		let writer_handle = tokio::task::spawn_blocking(move || {
			let chunk = vec![b'x'; OutputBudget::DEFAULT_LIMIT + 4096];
			writer
				.write_all(&chunk)
				.expect("large write should succeed");
		});
		writer_handle.await.expect("writer task should not panic");

		let mut received = String::new();
		while let Some(chunk) = rx.recv().await {
			received.push_str(&chunk);
		}
		time::timeout(Duration::from_secs(2), handle)
			.await
			.expect("reader should finish after writer closes")
			.expect("reader task should not panic");

		assert_eq!(received.len(), 1024, "streamed output must stop exactly at the budget cap");
		assert!(
			budget.truncated_bytes() > 0,
			"budget truncation must be observable, not silent loss"
		);
	}

	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn execute_shell_reports_text_truncation() {
		let _process_test_guard = PROCESS_TEST_LOCK.lock().await;
		let (tx, mut rx) = mpsc::unbounded_channel::<String>();
		let result = execute_shell(
			ShellExecuteOptions {
				command: format!(
					"python3 -c 'import sys; sys.stdout.write(\"x\" * {})'",
					OutputBudget::DEFAULT_LIMIT + 4096
				),
				..Default::default()
			},
			Some(tx),
			CancelToken::default(),
		)
		.await
		.expect("execute_shell should succeed");

		let mut received = 0usize;
		while let Some(chunk) = rx.recv().await {
			received += chunk.len();
		}

		assert_eq!(result.exit_code, Some(0));
		assert!(result.output_truncated);
		assert!(result.output_truncated_bytes > 0);
		assert_eq!(received, OutputBudget::DEFAULT_LIMIT);
	}

	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn execute_shell_streams_reports_raw_truncation() {
		let _process_test_guard = PROCESS_TEST_LOCK.lock().await;
		let (tx, mut rx) = mpsc::unbounded_channel::<Bytes>();
		let result = execute_shell_streams(
			ShellExecuteOptions {
				command: format!(
					"python3 -c 'import sys; sys.stdout.buffer.write(b\"x\" * {})'",
					OutputBudget::DEFAULT_LIMIT + 4096
				),
				..Default::default()
			},
			StreamSinks { stdout: Some(tx), stderr: None },
			CancelToken::default(),
		)
		.await
		.expect("execute_shell_streams should succeed");

		let mut received = 0usize;
		while let Some(chunk) = rx.recv().await {
			received += chunk.len();
		}

		assert_eq!(result.exit_code, Some(0));
		assert!(result.stdout_truncated);
		assert!(result.stdout_truncated_bytes > 0);
		assert!(!result.stderr_truncated);
		assert_eq!(received, OutputBudget::DEFAULT_LIMIT);
	}

	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn timeout_builtin_reaps_reparented_same_group_grandchild_and_preserves_sibling() {
		let _process_test_guard = PROCESS_TEST_LOCK.lock().await;
		let sibling = std::process::Command::new("sleep")
			.arg("30")
			.spawn()
			.expect("spawn unrelated sibling");
		let sibling_pid = i32::try_from(sibling.id()).expect("sibling pid should fit i32");
		wait_until_descendant_visible(sibling_pid).await;
		let (tx, mut rx) = mpsc::unbounded_channel::<String>();
		let command = "timeout 0.2 perl -e 'if (($pid = fork()) == 0) { $SIG{TERM} = \"IGNORE\"; \
		               print qq(grandchild=$$ ppid=) . getppid() . qq( pgid=) . getpgrp() . \
		               qq(\\n); $| = 1; sleep 30; exit 0; } print qq(parent=$$ child=$pid pgid=) . \
		               getpgrp() . qq(\\n); $| = 1; sleep 30;'";
		let result = execute_shell(
			ShellExecuteOptions { command: command.to_string(), ..Default::default() },
			Some(tx),
			CancelToken::default(),
		)
		.await
		.expect("timeout command should execute");

		let mut output = String::new();
		while let Ok(Some(chunk)) = time::timeout(Duration::from_millis(50), rx.recv()).await {
			output.push_str(&chunk);
		}
		let grandchild_pid = parse_marker_pid(&output, "grandchild=")
			.expect("grandchild marker should be emitted before timeout");
		assert_eq!(result.exit_code, Some(124), "output={output:?}");

		// The unrelated sibling lives in the *test's* process group, so the
		// timeout's group-targeted reaping never targets it; whether it was hit
		// is fully decided by the time `execute_shell` returns. Check (and reap)
		// it now instead of racing its liveness against the asynchronous death
		// of the reparented grandchild — coupling the two previously let a slow
		// runner fail spuriously when the sibling's sleep elapsed first.
		let sibling_alive = process::Process::from_pid(sibling_pid)
			.is_some_and(|process| process.status() == process::ProcessStatus::Running);
		let _ = process::Process::from_pid(sibling_pid)
			.map(|process| process.kill_tree(Some(process::KILL_SIGNAL)));
		assert!(sibling_alive, "timeout killed unrelated sibling {sibling_pid}; output={output:?}");

		// SIGKILL delivery to the reparented grandchild can lag under CI load, so
		// poll generously rather than asserting a tight deadline.
		let mut grandchild_dead = false;
		for _ in 0..500 {
			if process::Process::from_pid(grandchild_pid)
				.is_none_or(|process| process.status() != process::ProcessStatus::Running)
			{
				grandchild_dead = true;
				break;
			}
			time::sleep(Duration::from_millis(20)).await;
		}
		assert!(
			grandchild_dead,
			"timeout left reparented grandchild {grandchild_pid} alive; output={output:?}"
		);
	}

	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn cancelled_command_reaps_reparented_same_group_grandchild() {
		let _process_test_guard = PROCESS_TEST_LOCK.lock().await;
		let sibling = std::process::Command::new("sleep")
			.arg("30")
			.spawn()
			.expect("spawn unrelated sibling");
		let sibling_pid = i32::try_from(sibling.id()).expect("sibling pid should fit i32");
		wait_until_descendant_visible(sibling_pid).await;
		let cancel = CancelToken::default();
		let abort = cancel.clone().emplace_abort_token();
		let (tx, mut rx) = mpsc::unbounded_channel::<String>();
		let command = "perl -e 'if (($pid = fork()) == 0) { $SIG{TERM} = \"IGNORE\"; print \
		               qq(grandchild=$$ ppid=) . getppid() . qq( pgid=) . getpgrp() . qq(\\n); $| = \
		               1; sleep 30; exit 0; } print qq(parent=$$ child=$pid pgid=) . getpgrp() . \
		               qq(\\n); exit 0;'; sleep 30";
		let run = tokio::spawn(execute_shell(
			ShellExecuteOptions { command: command.to_string(), ..Default::default() },
			Some(tx),
			cancel,
		));

		let mut output = String::new();
		let grandchild_pid = time::timeout(Duration::from_secs(5), async {
			loop {
				let chunk = rx.recv().await.expect("output channel should stay open");
				output.push_str(&chunk);
				// Wait for BOTH markers: the grandchild and parent lines race on the
				// pipe, so returning as soon as `grandchild=` appears can leave the
				// not-yet-read `parent=` chunk pending and flake the parent assertion.
				if let Some(pid) = parse_marker_pid(&output, "grandchild=") {
					if parse_marker_pid(&output, "parent=").is_some() {
						return pid;
					}
				}
			}
		})
		.await
		.expect("grandchild and parent pid markers");
		let parent_pid = parse_marker_pid(&output, "parent=").expect("parent pid marker");
		let command_pgid = process::Process::from_pid(grandchild_pid)
			.and_then(|process| process.group_id())
			.expect("grandchild pgid should be visible");

		for _ in 0..50 {
			if process::Process::from_pid(grandchild_pid).and_then(|process| process.ppid())
				!= Some(parent_pid)
			{
				break;
			}
			time::sleep(Duration::from_millis(20)).await;
		}
		assert_ne!(
			process::Process::from_pid(grandchild_pid).and_then(|process| process.ppid()),
			Some(parent_pid),
			"grandchild should reparent away from shell before cancellation; output={output:?}",
		);

		abort.abort(AbortReason::Signal);
		terminate_new_descendants(&process::current_descendant_pids(), command_pgid).await;
		time::sleep(Duration::from_millis(500)).await;
		run.abort();
		let _ = run.await;

		// The unrelated sibling shares the test's process group; cancellation
		// only targets the command's descendants, so the sibling's survival is
		// settled once `run` finishes. Check (and reap) it now rather than
		// coupling it to the reparented grandchild's asynchronous death.
		let sibling_alive = process::Process::from_pid(sibling_pid)
			.is_some_and(|process| process.status() == process::ProcessStatus::Running);
		let _ = process::Process::from_pid(sibling_pid)
			.map(|process| process.kill_tree(Some(process::KILL_SIGNAL)));
		assert!(
			sibling_alive,
			"cancellation killed unrelated sibling {sibling_pid}; output={output:?}"
		);

		let mut grandchild_dead = false;
		for _ in 0..500 {
			if process::Process::from_pid(grandchild_pid)
				.is_none_or(|process| process.status() != process::ProcessStatus::Running)
			{
				grandchild_dead = true;
				break;
			}
			time::sleep(Duration::from_millis(20)).await;
		}
		assert!(
			grandchild_dead,
			"reparented grandchild {grandchild_pid} survived cancellation; output={output:?}"
		);
	}

	#[cfg(unix)]
	fn parse_marker_pid(output: &str, marker: &str) -> Option<i32> {
		let start = output.find(marker)? + marker.len();
		let rest = &output[start..];
		let end = rest
			.find(|ch: char| !ch.is_ascii_digit())
			.unwrap_or(rest.len());
		rest[..end].parse().ok()
	}

	#[cfg(unix)]
	#[tokio::test]
	async fn read_output_stops_when_cancelled_before_pipe_eof() {
		let (reader, _writer) = pipe_to_files("test").expect("test pipe should be created");
		let cancel = CancellationToken::new();
		let (activity_tx, _activity_rx) = mpsc::channel(1);
		let handle = tokio::spawn(read_output(
			reader,
			None,
			cancel.clone(),
			activity_tx,
			OutputBudget::new(usize::MAX),
		));

		time::sleep(Duration::from_millis(10)).await;
		cancel.cancel();

		time::timeout(Duration::from_millis(100), handle)
			.await
			.expect("reader task should stop after cancellation")
			.expect("reader task should not panic");
	}

	#[cfg(unix)]
	#[tokio::test]
	async fn env_scope_pop_error_cleanup_cancels_reader_and_bridges() {
		let (reader, writer) = pipe_to_files("env-pop-error").expect("pipe should be created");
		let stdout_file = OpenFile::from(writer.try_clone().expect("clone writer"));
		let stderr_file = OpenFile::from(writer);
		let reader_cancel = CancellationToken::new();
		let command_cancel = CancellationToken::new();
		let (activity_tx, _activity_rx) = mpsc::channel::<()>(1);
		let mut reader_handle = tokio::spawn(read_output(
			reader,
			None,
			reader_cancel.clone(),
			activity_tx,
			OutputBudget::new(usize::MAX),
		));
		let cancel_bridge = tokio::spawn({
			let command_cancel = command_cancel.clone();
			let reader_cancel = reader_cancel.clone();
			async move {
				command_cancel.cancelled().await;
				reader_cancel.cancel();
			}
		});
		let process_cancel_bridge = tokio::spawn({
			let command_cancel = command_cancel.clone();
			async move {
				command_cancel.cancelled().await;
			}
		});

		let config = ShellConfig { session_env: None, snapshot_path: None, minimizer: None };
		let mut session = create_session(&config).await.expect("create_session");
		let mut env = HashMap::new();
		env.insert("U3_POP_ERROR".to_string(), "1".to_string());
		assert!(apply_command_env(&mut session.shell, Some(&env)).expect("push command env"));

		let mut params = session.shell.default_exec_params();
		params.set_fd(OpenFiles::STDIN_FD, null_file().expect("null stdin"));
		params.set_fd(OpenFiles::STDOUT_FD, stdout_file);
		params.set_fd(OpenFiles::STDERR_FD, stderr_file);
		params.set_cancel_token(command_cancel.clone());
		let source_info = SourceInfo::from("pi-natives:env-pop-error-test");
		let exec = session
			.shell
			.run_string("printf done", &source_info, &params)
			.await
			.expect("command should run before forced cleanup error");
		assert!(matches!(exec.exit_code, ExecutionExitCode::Success));

		session.shell.env_mut().push_scope(EnvironmentScope::Local);
		let cleanup_error = session.shell.env_mut().pop_scope(EnvironmentScope::Command);
		assert!(cleanup_error.is_err(), "forced local scope should make command pop fail");
		drop(params);

		reader_cancel.cancel();
		time::timeout(Duration::from_secs(2), &mut reader_handle)
			.await
			.expect("reader must stop even when env cleanup errors")
			.expect("reader task should not panic");
		command_cancel.cancel();
		time::timeout(Duration::from_secs(2), cancel_bridge)
			.await
			.expect("reader cancel bridge should not leak")
			.expect("reader cancel bridge should not panic");
		time::timeout(Duration::from_secs(2), process_cancel_bridge)
			.await
			.expect("process cancel bridge should not leak")
			.expect("process cancel bridge should not panic");
	}

	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn execute_shell_streams_separates_stdout_and_stderr() {
		let (stdout_tx, mut stdout_rx) = mpsc::unbounded_channel::<Bytes>();
		let (stderr_tx, mut stderr_rx) = mpsc::unbounded_channel::<Bytes>();
		let options = ShellExecuteOptions {
			command: "echo out; echo err 1>&2".to_string(),
			..Default::default()
		};
		let streams = StreamSinks { stdout: Some(stdout_tx), stderr: Some(stderr_tx) };
		let result = execute_shell_streams(options, streams, CancelToken::default())
			.await
			.expect("execute should succeed");
		assert_eq!(result.exit_code, Some(0));
		assert!(!result.cancelled);

		let mut stdout = Vec::new();
		while let Some(chunk) = stdout_rx.recv().await {
			stdout.extend_from_slice(&chunk);
		}
		let mut stderr = Vec::new();
		while let Some(chunk) = stderr_rx.recv().await {
			stderr.extend_from_slice(&chunk);
		}
		assert_eq!(stdout, b"out\n");
		assert_eq!(stderr, b"err\n");
	}

	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn execute_shell_streams_works_when_sinks_are_none() {
		// Both sinks `None` — pipes must still drain so the child can exit.
		let options = ShellExecuteOptions {
			command: "yes done | head -n 100 1>&2; echo final".to_string(),
			..Default::default()
		};
		let result = execute_shell_streams(options, StreamSinks::default(), CancelToken::default())
			.await
			.expect("execute should succeed");
		assert_eq!(result.exit_code, Some(0));
	}

	/// Brush expands `$env:NAME` against the `env` shell variable by default,
	/// collapsing PowerShell references like `Write-Host $env:GJCCODE` to
	/// `:GJCCODE`. The session-level fallback below defines `env=$env` so the
	/// expansion is the literal `$env:GJCCODE`, preserving the PowerShell
	/// token when the command is forwarded to a child shell.
	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn powershell_env_reference_survives_brush_expansion() {
		let (tx, mut rx) = mpsc::unbounded_channel::<Bytes>();
		let options = ShellExecuteOptions {
			command: "printf '%s' \"$env:SystemRoot\"".to_string(),
			..Default::default()
		};
		let streams = StreamSinks { stdout: Some(tx), stderr: None };
		let result = execute_shell_streams(options, streams, CancelToken::default())
			.await
			.expect("execute should succeed");
		assert_eq!(result.exit_code, Some(0));

		let mut stdout = Vec::new();
		while let Some(chunk) = rx.recv().await {
			stdout.extend_from_slice(&chunk);
		}
		assert_eq!(stdout, b"$env:SystemRoot");
	}

	/// A user assignment to `env` in the command itself must shadow the
	/// session-level fallback so callers that genuinely use a POSIX variable
	/// named `env` see their value, not the literal `$env`.
	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn user_env_assignment_shadows_powershell_fallback() {
		let (tx, mut rx) = mpsc::unbounded_channel::<Bytes>();
		let options = ShellExecuteOptions {
			command: "env=prod; printf '%s' \"$env:8080\"".to_string(),
			..Default::default()
		};
		let streams = StreamSinks { stdout: Some(tx), stderr: None };
		let result = execute_shell_streams(options, streams, CancelToken::default())
			.await
			.expect("execute should succeed");
		assert_eq!(result.exit_code, Some(0));

		let mut stdout = Vec::new();
		while let Some(chunk) = rx.recv().await {
			stdout.extend_from_slice(&chunk);
		}
		assert_eq!(stdout, b"prod:8080");
	}
}
