//! Brush-based shell execution exported via N-API.

use std::{collections::HashMap, sync::Arc};

use napi::{
	Env, Result,
	bindgen_prelude::*,
	threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode},
	tokio::sync::mpsc,
};
use napi_derive::napi;
use pi_shell::{
	MinimizerResult as CoreMinimizerResult, Shell as CoreShell,
	ShellExecuteOptions as CoreShellExecuteOptions, ShellOptions as CoreShellOptions,
	ShellRunOptions as CoreShellRunOptions, ShellRunResult as CoreShellRunResult,
	execute_shell as core_execute_shell,
	fixup::{BashFixupResult as CoreBashFixupResult, apply_bash_fixups as core_apply_bash_fixups},
	minimizer,
};

use crate::task;
const SHELL_CALLBACK_QUEUE_CAPACITY: usize = 1024;

/// N-API opt-in handle for the minimizer.
#[napi(object)]
#[derive(Debug, Clone, Default)]
pub struct MinimizerOptions {
	/// Master switch. Absent / false = disabled.
	pub enabled:           Option<bool>,
	/// Optional path to a TOML settings file whose values override
	/// field-level defaults. `~` is expanded.
	pub settings_path:     Option<String>,
	/// Optional xxHash64 digest (hex) of the settings file contents. When
	/// supplied, the engine refuses to honor a settings file whose hash does
	/// not match — a lightweight trust gate for agent-controllable paths.
	pub settings_hash:     Option<String>,
	/// Opt-in allowlist of program names (e.g. `"git"`). When empty or
	/// absent, all built-in filters are active.
	pub only:              Option<Vec<String>>,
	/// Program names explicitly excluded from minimization.
	pub except:            Option<Vec<String>>,
	/// Maximum captured bytes per command before the engine falls back to
	/// the raw, un-minimized output. Default 4 MiB.
	pub max_capture_bytes: Option<u32>,
}

impl From<MinimizerOptions> for minimizer::MinimizerOptions {
	fn from(value: MinimizerOptions) -> Self {
		Self {
			enabled:           value.enabled,
			settings_path:     value.settings_path,
			settings_hash:     value.settings_hash,
			only:              value.only,
			except:            value.except,
			max_capture_bytes: value.max_capture_bytes,
		}
	}
}

/// Options for configuring a persistent shell session.
#[napi(object)]
pub struct ShellOptions {
	/// Environment variables to apply once per session.
	pub session_env:             Option<HashMap<String, String>>,
	/// Optional snapshot file to source on session creation.
	pub snapshot_path:           Option<String>,
	/// Optional per-command output minimizer configuration.
	pub minimizer:               Option<MinimizerOptions>,
	/// Keep external commands inside the embedding process group. Used only by
	/// an already-isolated shell worker whose parent supervises that group.
	pub contained_process_group: Option<bool>,
	/// Private append-only ownership ledger used by the external guardian.
	pub ownership_ledger_path:   Option<String>,
	/// Authentication key for ownership ledger records.
	pub ownership_ledger_token:  Option<String>,
}

impl From<ShellOptions> for CoreShellOptions {
	fn from(value: ShellOptions) -> Self {
		Self {
			session_env:             value.session_env,
			snapshot_path:           value.snapshot_path,
			minimizer:               value.minimizer.map(Into::into),
			contained_process_group: value.contained_process_group.unwrap_or(false),
			ownership_ledger_path:   value.ownership_ledger_path,
			ownership_ledger_token:  value.ownership_ledger_token,
		}
	}
}

/// Options for running a shell command.
#[napi(object)]
pub struct ShellRunOptions<'env> {
	/// Command string to execute in the shell.
	pub command:    String,
	/// Working directory for the command.
	pub cwd:        Option<String>,
	/// Environment variables to apply for this command only.
	pub env:        Option<HashMap<String, String>>,
	/// Timeout in milliseconds before cancelling the command.
	pub timeout_ms: Option<u32>,
	/// Abort signal for cancelling the operation.
	pub signal:     Option<Unknown<'env>>,
}

/// Options for executing a shell command via brush-core.
#[napi(object)]
pub struct ShellExecuteOptions<'env> {
	/// Command string to execute in the shell.
	pub command:                 String,
	/// Working directory for the command.
	pub cwd:                     Option<String>,
	/// Environment variables to apply for this command only.
	pub env:                     Option<HashMap<String, String>>,
	/// Environment variables to apply once per session.
	pub session_env:             Option<HashMap<String, String>>,
	/// Timeout in milliseconds before cancelling the command.
	pub timeout_ms:              Option<u32>,
	/// Optional snapshot file to source on session creation.
	pub snapshot_path:           Option<String>,
	/// Optional per-command output minimizer configuration.
	pub minimizer:               Option<MinimizerOptions>,
	/// Abort signal for cancelling the operation.
	pub signal:                  Option<Unknown<'env>>,
	/// Keep external commands inside the embedding process group.
	pub contained_process_group: Option<bool>,
}

/// Telemetry for a single minimization.
///
/// Surfaced when the minimizer actually rewrote the command's output. The
/// session layer is expected to persist `original_text` via its
/// `ArtifactManager`, splice the resulting `artifact://<id>` reference
/// into `text`, and replace any previously streamed raw output with the
/// minimized text.
#[napi(object)]
pub struct MinimizerResult {
	/// Dispatch label produced by the minimizer (e.g. `"git"`,
	/// `"pipeline:gradle"`, `"pipeline+builtin"`).
	pub filter:        String,
	/// The minimized replacement text. Callers that streamed raw chunks
	/// during execution should clear and replace their accumulated output
	/// with this text.
	pub text:          String,
	/// The full original capture, before minimization.
	pub original_text: String,
	/// Captured byte length before minimization.
	pub input_bytes:   u32,
	/// Byte length of the minimized text the consumer received.
	pub output_bytes:  u32,
}

impl From<CoreMinimizerResult> for MinimizerResult {
	fn from(value: CoreMinimizerResult) -> Self {
		Self {
			filter:        value.filter,
			text:          value.text,
			original_text: value.original_text,
			input_bytes:   value.input_bytes,
			output_bytes:  value.output_bytes,
		}
	}
}

/// Result of running a shell command.
#[napi(object)]
pub struct ShellRunResult {
	/// Exit code when the command completes normally.
	pub exit_code: Option<i32>,
	/// Whether the command was cancelled via abort.
	pub cancelled: bool,
	/// Whether the command timed out before completion.
	pub timed_out: bool,
	/// When the minimizer rewrote the captured output, this carries the
	/// original buffer + telemetry so the session layer can persist it as
	/// an artifact and splice an `artifact://<id>` reference into the
	/// minimized text shown to the agent. `None` when nothing was rewritten.
	pub minimized: Option<MinimizerResult>,
}

impl From<CoreShellRunResult> for ShellRunResult {
	fn from(value: CoreShellRunResult) -> Self {
		Self {
			exit_code: value.exit_code,
			cancelled: value.cancelled,
			timed_out: value.timed_out,
			minimized: value.minimized.map(Into::into),
		}
	}
}

/// Persistent brush-core shell session.
#[napi]
pub struct Shell {
	inner: Arc<CoreShell>,
}

#[napi]
impl Shell {
	/// Create a new shell session from optional configuration.
	///
	/// The options set session-scoped environment variables and a snapshot path.
	#[napi(constructor)]
	pub fn new(options: Option<ShellOptions>) -> Self {
		Self { inner: Arc::new(CoreShell::new(options.map(Into::into))) }
	}

	/// Run a shell command using the provided options.
	///
	/// The `on_chunk` callback receives streamed stdout/stderr output. Returns
	/// the exit code when the command completes, or flags when cancelled or
	/// timed out.
	#[napi]
	pub fn run<'env>(
		&self,
		env: &'env Env,
		options: ShellRunOptions<'env>,
		#[napi(ts_arg_type = "((error: Error | null, chunk: string) => void) | undefined | null")]
		on_chunk: Option<ThreadsafeFunction<String>>,
	) -> Result<PromiseRaw<'env, ShellRunResult>> {
		let cancel_token = task::CancelToken::new(options.timeout_ms, options.signal);
		let inner = Arc::clone(&self.inner);
		let run_options = CoreShellRunOptions {
			command:    options.command,
			cwd:        options.cwd,
			env:        options.env,
			timeout_ms: options.timeout_ms,
		};
		task::future(env, "shell.run", async move {
			let (chunk_tx, drain_handle) = bridge_chunks(on_chunk);
			let result = inner
				.run(run_options, chunk_tx, cancel_token.into_core())
				.await
				.map(Into::into)
				.map_err(|err| Error::from_reason(err.to_string()));
			if let Some(handle) = drain_handle {
				let _ = handle.await;
			}
			result
		})
	}

	/// Abort all running commands for this shell session.
	///
	/// Returns `Ok(())` even when no commands are running.
	#[napi]
	pub async fn abort(&self) -> Result<()> {
		self.inner.abort().await;
		Ok(())
	}

	/// Abort in-flight commands and release the retained shell session.
	///
	/// `abort` leaves a completed session alive for reuse, so a caller that is
	/// finished with a shell must call this to release the native process and
	/// let the host exit. Returns `Ok(())` even when nothing is retained.
	#[napi]
	pub async fn close(&self) -> Result<()> {
		self.inner.close().await;
		Ok(())
	}
}

/// Execute a brush shell command.
///
/// Creates a fresh session for each call. The `on_chunk` callback receives
/// streamed stdout/stderr output. Returns the exit code when the command
/// completes, or flags when cancelled or timed out.
#[napi]
pub fn execute_shell<'env>(
	env: &'env Env,
	options: ShellExecuteOptions<'env>,
	#[napi(ts_arg_type = "((error: Error | null, chunk: string) => void) | undefined | null")]
	on_chunk: Option<ThreadsafeFunction<String>>,
) -> Result<PromiseRaw<'env, ShellRunResult>> {
	let cancel_token = task::CancelToken::new(options.timeout_ms, options.signal);
	let exec_options = CoreShellExecuteOptions {
		command:                 options.command,
		cwd:                     options.cwd,
		env:                     options.env,
		session_env:             options.session_env,
		timeout_ms:              options.timeout_ms,
		snapshot_path:           options.snapshot_path,
		minimizer:               options.minimizer.map(Into::into),
		contained_process_group: options.contained_process_group.unwrap_or(false),
	};
	task::future(env, "shell.execute", async move {
		let (chunk_tx, drain_handle) = bridge_chunks(on_chunk);
		let result = core_execute_shell(exec_options, chunk_tx, cancel_token.into_core())
			.await
			.map(Into::into)
			.map_err(|err| Error::from_reason(err.to_string()));
		if let Some(handle) = drain_handle {
			let _ = handle.await;
		}
		result
	})
}

fn bridge_chunks(
	on_chunk: Option<ThreadsafeFunction<String>>,
) -> (Option<mpsc::UnboundedSender<String>>, Option<napi::tokio::task::JoinHandle<()>>) {
	let Some(on_chunk) = on_chunk else {
		return (None, None);
	};
	let (tx, mut rx) = mpsc::unbounded_channel::<String>();
	let (bounded_tx, mut bounded_rx) = mpsc::channel::<String>(SHELL_CALLBACK_QUEUE_CAPACITY);
	let handle = napi::tokio::spawn(async move {
		let forwarder = napi::tokio::spawn(async move {
			// The upstream pi_shell sender is unbounded; this bridge re-bounds it so at
			// most SHELL_CALLBACK_QUEUE_CAPACITY chunks are in flight toward the N-API
			// callback. A full queue applies backpressure instead of dropping output:
			// shell chunks are arbitrary byte slices, so discarding one silently
			// corrupts the surviving stream rather than merely shortening it.
			while let Some(chunk) = rx.recv().await {
				if bounded_tx.send(chunk).await.is_err() {
					break;
				}
			}
		});
		while let Some(chunk) = bounded_rx.recv().await {
			if on_chunk.call(Ok(chunk), ThreadsafeFunctionCallMode::NonBlocking) != napi::Status::Ok {
				forwarder.abort();
				break;
			}
		}
		let _ = forwarder.await;
	});
	(Some(tx), Some(handle))
}

/// Result of [`apply_bash_fixups`]: a possibly-rewritten command plus the
/// substrings that were removed (in source order).
#[napi(object)]
pub struct BashFixupResult {
	/// Possibly-rewritten command. Equal to the input when no fixup fired.
	pub command:  String,
	/// Substrings removed, in source order — suitable for a user-facing notice.
	pub stripped: Vec<String>,
}

impl From<CoreBashFixupResult> for BashFixupResult {
	fn from(value: CoreBashFixupResult) -> Self {
		Self { command: value.command, stripped: value.stripped }
	}
}

/// Apply conservative pre-execution rewrites to a bash command.
///
/// Strips trailing `| head|tail [safe-args]` and redundant trailing `2>&1`
/// from each top-level pipeline. The full rules and bail conditions live in
/// `pi_shell::fixup`. Synchronous and cheap (one parse pass over the input).
#[napi]
pub fn apply_bash_fixups(command: String) -> BashFixupResult {
	core_apply_bash_fixups(&command).into()
}

#[cfg(test)]
mod tests {
	use std::time::Duration;

	use pi_shell::{
		ShellRunOptions as CoreShellRunOptions,
		cancel::{AbortReason, CancelToken},
	};
	use tokio::{sync::mpsc, task::yield_now, time};

	use super::{CoreShell, SHELL_CALLBACK_QUEUE_CAPACITY};

	mod child_session_action_tests {
		use pi_shell::{ChildSessionAction, child_session_action};

		#[test]
		fn interactive_with_terminal_stdin_takes_foreground() {
			assert_eq!(child_session_action(true, true, false), ChildSessionAction::TakeForeground);
			assert_eq!(child_session_action(true, true, true), ChildSessionAction::TakeForeground);
		}

		#[test]
		fn non_terminal_stdin_leading_new_pgroup_preserves_session() {
			assert_eq!(child_session_action(true, false, false), ChildSessionAction::None);
			assert_eq!(child_session_action(true, false, true), ChildSessionAction::None);
		}

		#[test]
		fn non_interactive_with_terminal_stdin_does_nothing() {
			assert_eq!(child_session_action(false, true, false), ChildSessionAction::None);
		}

		#[test]
		fn non_interactive_terminal_stdin_in_pipeline_does_nothing() {
			assert_eq!(child_session_action(false, true, true), ChildSessionAction::None);
		}

		#[test]
		fn embedded_host_with_non_terminal_stdin_detaches() {
			assert_eq!(child_session_action(false, false, false), ChildSessionAction::DetachSession);
		}

		#[test]
		fn pipeline_stage_does_not_detach() {
			assert_eq!(child_session_action(false, false, true), ChildSessionAction::None);
		}
	}

	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn embedded_external_command_runs_in_its_own_process_group() {
		let shell = CoreShell::new(None);
		let (tx, mut rx) = mpsc::unbounded_channel::<String>();
		let handle = tokio::spawn(async move {
			shell
				.run(
					CoreShellRunOptions {
						command:    "/bin/sh -c 'printf \"%d\\n\" \"$$\"; sleep 0.5'".to_string(),
						cwd:        None,
						env:        None,
						timeout_ms: None,
					},
					Some(tx),
					CancelToken::default(),
				)
				.await
		});
		let child_pid = time::timeout(Duration::from_secs(5), rx.recv())
			.await
			.expect("timed out waiting for child pid")
			.expect("missing child pid chunk")
			.trim()
			.parse::<i32>()
			.expect("child pid parses");
		// SAFETY: `getsid(0)` only queries the current process session; the
		// return value is checked below.
		let host_sid = unsafe { libc::getsid(0) };
		assert!(host_sid > 0, "getsid(0) failed: {}", std::io::Error::last_os_error());
		// SAFETY: `child_pid` is a live positive PID reported by the child; the
		// return value is checked below.
		let child_sid = unsafe { libc::getsid(child_pid) };
		assert!(child_sid > 0, "getsid({child_pid}) failed: {}", std::io::Error::last_os_error());
		// SAFETY: `child_pid` is live and was reported by the child.
		let child_pgid = unsafe { libc::getpgid(child_pid) };
		let result = handle
			.await
			.expect("shell task panicked")
			.expect("shell run");
		assert_eq!(result.exit_code, Some(0));
		assert_eq!(child_sid, host_sid);
		assert_eq!(child_pgid, child_pid);
	}

	#[tokio::test]
	async fn read_output_stops_when_cancelled_before_pipe_eof() {
		let shell = CoreShell::new(None);
		let mut cancel = CancelToken::default();
		let abort = cancel.emplace_abort_token();
		let handle = tokio::spawn(async move {
			shell
				.run(
					CoreShellRunOptions {
						command:    "sh -c 'sleep 30 & wait'".to_string(),
						cwd:        None,
						env:        None,
						timeout_ms: None,
					},
					None,
					cancel,
				)
				.await
		});

		time::sleep(Duration::from_millis(10)).await;
		abort.abort(AbortReason::Signal);
		let result = time::timeout(Duration::from_secs(3), handle)
			.await
			.expect("shell run should stop after cancellation")
			.expect("shell task should not panic")
			.expect("shell run should return");
		assert!(result.cancelled);
	}

	#[tokio::test]
	async fn full_callback_queue_backpressures_instead_of_dropping_chunks() {
		let (tx, mut rx) = mpsc::channel::<String>(SHELL_CALLBACK_QUEUE_CAPACITY);
		for i in 0..SHELL_CALLBACK_QUEUE_CAPACITY {
			tx.try_send(format!("chunk-{i}"))
				.expect("queue fill should succeed");
		}
		let overflow_sender = tokio::spawn(async move {
			tx.send("chunk-overflow".to_string())
				.await
				.expect("receiver should remain open");
		});

		yield_now().await;
		assert!(!overflow_sender.is_finished(), "overflowing send should wait for capacity");

		let mut received = Vec::new();
		while let Some(chunk) = rx.recv().await {
			let last = chunk == "chunk-overflow";
			received.push(chunk);
			if last {
				break;
			}
		}
		overflow_sender
			.await
			.expect("overflow sender should not panic");

		assert_eq!(received.len(), SHELL_CALLBACK_QUEUE_CAPACITY + 1);
		assert_eq!(received[0], "chunk-0");
		assert_eq!(
			received[SHELL_CALLBACK_QUEUE_CAPACITY - 1],
			format!("chunk-{}", SHELL_CALLBACK_QUEUE_CAPACITY - 1)
		);
		assert_eq!(received[SHELL_CALLBACK_QUEUE_CAPACITY], "chunk-overflow");
	}
}
