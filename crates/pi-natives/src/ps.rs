//! N-API bindings for cross-platform process tree management.
//!
//! The platform-specific implementation lives in [`pi_shell::process`]; this
//! module is a thin shim that exposes that crate's `Process` surface to
//! JavaScript and re-exports the termination primitives used by other native
//! modules (e.g. [`crate::pty`]).

use std::time::Duration;

use napi::{
	Env, Result,
	bindgen_prelude::{PromiseRaw, Unknown},
};
use napi_derive::napi;
use pi_shell::process::{
	self as core_process, ProcessObservation as CoreProcessObservation,
	ProcessStatus as CoreProcessStatus,
};
pub use pi_shell::process::{KILL_SIGNAL, TERM_SIGNAL, TerminationTargets, kill_process_group};

use crate::task;

#[derive(Default)]
#[napi(object)]
pub struct ProcessTerminateOptions<'env> {
	/// Also signal the process group when supported by the platform.
	pub group:       Option<bool>,
	/// Milliseconds to wait after polite termination before hard-killing.
	/// Omit to use the default grace period. Pass a negative value to skip the
	/// graceful phase and hard-kill immediately.
	pub graceful_ms: Option<i32>,
	/// Milliseconds to wait after hard-kill for the process tree to exit.
	pub timeout_ms:  Option<u32>,
	/// Abort signal for cancelling termination while waiting.
	pub signal:      Option<Unknown<'env>>,
}

/// Options for waiting on a process exit.
#[derive(Default)]
#[napi(object)]
pub struct ProcessWaitOptions<'env> {
	/// Milliseconds to wait before returning false. Omit to wait indefinitely.
	pub timeout_ms: Option<u32>,
	/// Abort signal for cancelling the wait.
	pub signal:     Option<Unknown<'env>>,
}

/// Current state of a process reference.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[napi(string_enum)]
pub enum ProcessStatus {
	/// The referenced process is still running.
	#[napi(value = "running")]
	Running,
	/// The referenced process has exited or is no longer observable.
	#[napi(value = "exited")]
	Exited,
}

impl From<CoreProcessStatus> for ProcessStatus {
	fn from(value: CoreProcessStatus) -> Self {
		match value {
			CoreProcessStatus::Running => Self::Running,
			CoreProcessStatus::Exited => Self::Exited,
		}
	}
}

/// Read-only, non-mutating observation of whether a pid currently names a
/// verifiable process incarnation.
///
/// `status` discriminates the three outcomes described on
/// [`pi_shell::process::ProcessObservation`]:
/// - `"present"` — `incarnation` is the exact kernel-reported identity
///   evidence.
/// - `"absent"` — the OS positively confirmed no process currently has this
///   pid.
/// - `"unknown"` — `reasonCode` explains why liveness could not be determined
///   (e.g. an invalid pid, a permission denial, or a platform limitation); this
///   is never proof of death.
#[napi(object)]
pub struct NativeProcessObservation {
	#[napi(ts_type = "'present' | 'absent' | 'unknown'")]
	pub status:      String,
	pub incarnation: Option<String>,
	pub reason_code: Option<String>,
}

impl From<CoreProcessObservation> for NativeProcessObservation {
	fn from(value: CoreProcessObservation) -> Self {
		match value {
			CoreProcessObservation::Present { incarnation } => Self {
				status:      "present".to_owned(),
				incarnation: Some(incarnation),
				reason_code: None,
			},
			CoreProcessObservation::Absent => {
				Self { status: "absent".to_owned(), incarnation: None, reason_code: None }
			},
			CoreProcessObservation::Unknown { reason_code } => Self {
				status:      "unknown".to_owned(),
				incarnation: None,
				reason_code: Some(reason_code),
			},
		}
	}
}

/// Stable process reference.
#[napi]
#[derive(Clone)]
pub struct Process {
	inner: core_process::Process,
}

#[napi]
#[allow(clippy::use_self, reason = "napi return types must name the exported class")]
impl Process {
	/// Open a stable process reference from a PID.
	#[napi]
	pub fn from_pid(pid: i32) -> Option<Process> {
		core_process::Process::from_pid(pid).map(Self::from_inner)
	}

	/// Open stable process references whose executable path matches exactly.
	#[napi]
	pub fn from_path(path: String) -> Vec<Process> {
		core_process::Process::from_path(path)
			.into_iter()
			.map(Self::from_inner)
			.collect()
	}

	/// Read-only observation of whether `pid` currently names a verifiable
	/// process incarnation.
	///
	/// Unlike [`Self::from_pid`] returning `null` (which conflates a confirmed-
	/// dead pid with one that simply could not be queried), this keeps positive
	/// OS-reported absence separate from every inconclusive outcome. It never
	/// signals, kills, reaps, waits on, or spawns any process.
	#[napi]
	pub fn observe(pid: f64) -> NativeProcessObservation {
		if !pid.is_finite() || pid.fract() != 0.0 || pid <= 0.0 || pid > f64::from(i32::MAX) {
			return NativeProcessObservation {
				status:      "unknown".to_owned(),
				incarnation: None,
				reason_code: Some("invalid_pid".to_owned()),
			};
		}
		core_process::Process::observe(pid as i32).into()
	}

	/// Operating-system process identifier for this process reference.
	#[napi(getter)]
	pub const fn pid(&self) -> i32 {
		self.inner.pid()
	}

	/// Kernel-derived identity evidence for this exact process incarnation.
	#[napi(getter)]
	pub fn incarnation(&self) -> String {
		self.inner.incarnation()
	}

	/// Parent process id for this process, when available.
	#[napi(getter)]
	pub fn ppid(&self) -> Option<i32> {
		self.inner.ppid()
	}

	/// Launch arguments for this process.
	#[napi]
	pub fn args(&self) -> Vec<String> {
		self.inner.args()
	}

	/// Send `signal` only to this pinned process reference.
	///
	/// On Linux this uses the owned pidfd; on Windows it uses the owned process
	/// handle. macOS has no atomic identity-bound signal primitive, so this
	/// operation deliberately fails closed there. It never discovers descendants
	/// or signals a process group. Returns `false` when the pinned process has
	/// already exited, the platform cannot bind delivery to the process
	/// identity, or the operating system rejects delivery.
	#[napi]
	pub fn signal_root(&self, signal: i32) -> bool {
		self.inner.signal_root(signal)
	}

	/// Send `signal` to this process and its descendants, children first.
	///
	/// On Linux and macOS the signal is forwarded as-is. On Windows there is no
	/// signal abstraction, so the `signal` argument is ignored and the entire
	/// tree is hard-killed via `TerminateProcess`. Defaults to the POSIX
	/// hard-kill signal.
	#[napi]
	pub fn kill_tree(&self, signal: Option<i32>) -> u32 {
		self.inner.kill_tree(signal)
	}

	/// Gracefully terminate this process and its descendants.
	///
	/// By default this waits 1000ms after polite termination before
	/// hard-killing. Pass `graceful_ms < 0` to skip the graceful phase.
	#[napi]
	pub fn terminate<'env>(
		&self,
		env: &'env Env,
		options: Option<ProcessTerminateOptions<'env>>,
	) -> Result<PromiseRaw<'env, bool>> {
		let options = options.unwrap_or_default();
		let group = options.group.unwrap_or(false);
		let graceful_ms = options.graceful_ms.unwrap_or(1000);
		let timeout_ms = options.timeout_ms.unwrap_or(5000);
		let ct = task::CancelToken::new(None, options.signal);
		let process = self.inner.clone();
		task::future(env, "process.terminate", async move {
			process
				.terminate_tree(group, graceful_ms, timeout_ms, ct.into_core())
				.await
				.map_err(|err| napi::Error::from_reason(err.to_string()))
		})
	}

	/// Wait until this process exits.
	///
	/// When `options.timeout_ms` is omitted, waits until the process exits.
	#[napi]
	pub fn wait_for_exit<'env>(
		&self,
		env: &'env Env,
		options: Option<ProcessWaitOptions<'env>>,
	) -> Result<PromiseRaw<'env, bool>> {
		let options = options.unwrap_or_default();
		let ct = task::CancelToken::new(None, options.signal);
		let timeout = options
			.timeout_ms
			.map(|ms| Duration::from_millis(u64::from(ms)));
		let process = self.inner.clone();
		task::future(env, "process.wait_for_exit", async move {
			process
				.wait_for_exit(timeout, ct.into_core())
				.await
				.map_err(|err| napi::Error::from_reason(err.to_string()))
		})
	}

	/// Process group id for this process, when supported by the platform.
	#[napi]
	pub fn group_id(&self) -> Option<i32> {
		self.inner.group_id()
	}

	/// Direct children of this process as stable process references.
	#[napi]
	pub fn children(&self) -> Vec<Process> {
		self
			.inner
			.children()
			.into_iter()
			.map(Self::from_inner)
			.collect()
	}

	/// Current status of this process reference.
	#[napi]
	pub fn status(&self) -> ProcessStatus {
		self.inner.status().into()
	}
}

impl Process {
	const fn from_inner(inner: core_process::Process) -> Self {
		Self { inner }
	}
}
