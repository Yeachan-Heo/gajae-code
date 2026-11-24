// Adapted from oh-my-pi (MIT) crates/natives/src/file_lock/mod.rs @
// 31ffee513f27a01bba7d4dfbe12bae239cdc646a Modified for gajae-code: typed
// results with a narrow fail-open list, acquire and probe bounded off the JS
// thread, Linux and macOS only (every other target reports unsupported), and
// no Linux abstract-socket shim for older builds.

//! Non-blocking, kernel-backed cross-process file locks.
//!
//! A lock is an exclusive lock on a persistent, empty sidecar file: an
//! open-file-description lock on Linux, `flock(2)` on macOS. Every other
//! target, Windows and the BSDs included, reports `unavailable`. The kernel
//! drops the lock when the holding descriptor closes, including when the
//! process dies, and the descriptor is close-on-exec, so a spawned child never
//! keeps it. Sidecars are never removed: unlinking a lock file can split one
//! lock between the holder of the old inode and the creator of a new one.
//!
//! Acquire and probe run on a blocking thread, and the time budget bounds how
//! long the caller waits, not the thread: a call stuck in a stalled filesystem
//! keeps its thread until the filesystem answers. They use `spawn_blocking`
//! rather than `task::blocking` because a blocked syscall cannot heartbeat a
//! cancel token. `release()` and garbage collection close the descriptor
//! synchronously on the JS thread, with no budget. Only `ENOLCK`,
//! `ENOTSUP`/`EOPNOTSUPP` and an unsupported platform are `unavailable`;
//! every other error is `failed`.

use std::{ffi::CString, time::Duration};

use napi_derive::napi;

mod platform {
	use std::ffi::CStr;

	use super::{Fault, FileLockFailure};

	/// No lock can exist on this target.
	pub enum PlatformLock {}

	fn unsupported() -> Fault {
		let message = format!("native file locks are not supported on {}", std::env::consts::OS);
		Fault::new(FileLockFailure::Unavailable, "unsupported_platform", message)
	}

	pub fn try_acquire(_path: &CStr) -> Result<Option<PlatformLock>, Fault> {
		Err(unsupported())
	}

	pub fn probe(_path: &CStr) -> Result<bool, Fault> {
		Err(unsupported())
	}
}

const DEFAULT_BUDGET_MS: i64 = 2_000;
const MAX_BUDGET_MS: i64 = 60_000;

/// Why a call has no answer.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[napi(string_enum)]
pub enum FileLockFailure {
	/// No lock is possible here; callers may fail open.
	#[napi(value = "unavailable")]
	Unavailable,
	/// The call exceeded its time budget; no lock is held.
	#[napi(value = "timed_out")]
	TimedOut,
	/// Any other error, including permission, ownership and symlink refusals;
	/// callers must fail closed.
	#[napi(value = "failed")]
	Failed,
}

/// Outcome of `tryAcquireFileLock`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[napi(string_enum)]
pub enum FileLockAcquireStatus {
	#[napi(value = "acquired")]
	Acquired,
	/// Another lock handle holds it, in this process or another one.
	#[napi(value = "held")]
	Held,
	#[napi(value = "unavailable")]
	Unavailable,
	#[napi(value = "timed_out")]
	TimedOut,
	#[napi(value = "failed")]
	Failed,
}

impl From<FileLockFailure> for FileLockAcquireStatus {
	fn from(failure: FileLockFailure) -> Self {
		match failure {
			FileLockFailure::Unavailable => Self::Unavailable,
			FileLockFailure::TimedOut => Self::TimedOut,
			FileLockFailure::Failed => Self::Failed,
		}
	}
}

/// State reported by `probeFileLock`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[napi(string_enum)]
pub enum FileLockProbeState {
	#[napi(value = "free")]
	Free,
	/// A lock handle holds it, in this process or another one.
	#[napi(value = "held")]
	Held,
	/// The probe has no answer; see `reason`.
	#[napi(value = "unknown")]
	Unknown,
}

/// A call that produced no answer.
#[derive(Debug)]
pub struct Fault {
	kind:    FileLockFailure,
	code:    String,
	message: String,
}

impl Fault {
	fn new(kind: FileLockFailure, code: impl Into<String>, message: impl Into<String>) -> Self {
		Self { kind, code: code.into(), message: message.into() }
	}
}

/// A held kernel lock. It ends on `release()`, when the handle is garbage
/// collected, or when the process exits. Release closes the descriptor
/// synchronously, with no time budget.
#[napi]
pub struct FileLock {
	inner: Option<platform::PlatformLock>,
}

#[napi]
impl FileLock {
	/// Whether this handle still holds its lock.
	#[napi(getter)]
	#[allow(clippy::missing_const_for_fn, reason = "napi method signature")]
	pub fn held(&self) -> bool {
		self.inner.is_some()
	}

	/// Release the lock. Idempotent.
	#[napi]
	#[allow(clippy::missing_const_for_fn, reason = "napi method signature")]
	pub fn release(&mut self) {
		self.inner = None;
	}
}

/// Result of `tryAcquireFileLock`.
#[napi(object, object_from_js = false)]
pub struct FileLockAcquireResult {
	pub status:  FileLockAcquireStatus,
	/// Present only when `status` is `acquired`.
	pub lock:    Option<FileLock>,
	/// Stable failure code: an errno name such as `EACCES`, or one of
	/// `not_regular_file`, `foreign_owner`, `not_owner_only`, `multiple_links`,
	/// `unsupported_platform`, `timed_out`, `invalid_path`, `panic`.
	pub code:    Option<String>,
	pub message: Option<String>,
}

/// Result of `probeFileLock`.
#[napi(object, object_from_js = false)]
pub struct FileLockProbeResult {
	pub state:   FileLockProbeState,
	/// Present only when `state` is `unknown`.
	pub reason:  Option<FileLockFailure>,
	pub code:    Option<String>,
	pub message: Option<String>,
}

/// The caller's wait: `timeoutMs` truncated to whole milliseconds and clamped
/// to 1..=60000, so a negative or oversized value cannot wrap.
fn budget(timeout_ms: Option<i64>) -> Duration {
	let millis = timeout_ms
		.unwrap_or(DEFAULT_BUDGET_MS)
		.clamp(1, MAX_BUDGET_MS);
	Duration::from_millis(millis.unsigned_abs())
}

/// Run `work` on a blocking thread and stop waiting after `budget`. The thread
/// itself is not stopped. A call that finishes later has its output dropped by
/// the runtime, so a late lock is released at once.
async fn bounded<T, F>(budget: Duration, work: F) -> Result<T, Fault>
where
	T: Send + 'static,
	F: FnOnce() -> Result<T, Fault> + Send + 'static,
{
	match tokio::time::timeout(budget, tokio::task::spawn_blocking(work)).await {
		Ok(Ok(result)) => result,
		Ok(Err(_)) => {
			Err(Fault::new(FileLockFailure::Failed, "panic", "native file lock call panicked"))
		},
		Err(_) => Err(Fault::new(
			FileLockFailure::TimedOut,
			"timed_out",
			format!("native file lock call exceeded its {} ms budget", budget.as_millis()),
		)),
	}
}

fn lock_path(path: &str) -> Result<CString, Fault> {
	CString::new(path).map_err(|_| {
		Fault::new(FileLockFailure::Failed, "invalid_path", "lock path contains a NUL byte")
	})
}

/// Try to take an exclusive lock on the sidecar at `path` without waiting.
///
/// Creates the sidecar (mode 0600) when missing. The sidecar must be a
/// regular file owned by this user, with no group or other permission bits and
/// one link, reached without following a symlink. `timeoutMs` bounds the
/// caller's wait (default 2000, clamped to 1-60000).
#[napi(js_name = "tryAcquireFileLock")]
pub async fn try_acquire_file_lock(path: String, timeout_ms: Option<i64>) -> FileLockAcquireResult {
	let outcome =
		bounded(budget(timeout_ms), move || platform::try_acquire(&lock_path(&path)?)).await;
	let (status, lock) = match outcome {
		Ok(Some(inner)) => (FileLockAcquireStatus::Acquired, Some(FileLock { inner: Some(inner) })),
		Ok(None) => (FileLockAcquireStatus::Held, None),
		Err(fault) => {
			return FileLockAcquireResult {
				status:  fault.kind.into(),
				lock:    None,
				code:    Some(fault.code),
				message: Some(fault.message),
			};
		},
	};
	FileLockAcquireResult { status, lock, code: None, message: None }
}

/// Report whether any lock handle, in any process including this one, holds
/// the lock at `path`, without taking it.
///
/// A missing sidecar is `free` and is not created. The probe is a read-lock
/// query (`F_OFD_GETLK` on Linux, `F_GETLK` on macOS, which also reports
/// `flock` holders there), so it never takes the lock and a shared holder reads
/// as `free`. `timeoutMs` bounds the caller's wait (default 2000, clamped to
/// 1-60000).
#[napi(js_name = "probeFileLock")]
pub async fn probe_file_lock(path: String, timeout_ms: Option<i64>) -> FileLockProbeResult {
	match bounded(budget(timeout_ms), move || platform::probe(&lock_path(&path)?)).await {
		Ok(held) => FileLockProbeResult {
			state:   if held {
				FileLockProbeState::Held
			} else {
				FileLockProbeState::Free
			},
			reason:  None,
			code:    None,
			message: None,
		},
		Err(fault) => FileLockProbeResult {
			state:   FileLockProbeState::Unknown,
			reason:  Some(fault.kind),
			code:    Some(fault.code),
			message: Some(fault.message),
		},
	}
}

#[cfg(test)]
mod tests {
	use std::{sync::mpsc, time::Duration};

	use super::{FileLockFailure, bounded, budget};

	fn runtime() -> tokio::runtime::Runtime {
		tokio::runtime::Builder::new_current_thread()
			.enable_time()
			.build()
			.expect("test runtime")
	}

	#[test]
	fn budget_defaults_truncates_and_clamps() {
		assert_eq!(budget(None), Duration::from_secs(2));
		assert_eq!(budget(Some(0)), Duration::from_millis(1));
		assert_eq!(budget(Some(-5)), Duration::from_millis(1));
		assert_eq!(budget(Some(i64::MIN)), Duration::from_millis(1));
		assert_eq!(budget(Some(250)), Duration::from_millis(250));
		assert_eq!(budget(Some(i64::MAX)), Duration::from_secs(60));
	}

	/// Signals when dropped, so a test can tell when a late result is gone.
	struct DropSignal(mpsc::Sender<()>);

	impl Drop for DropSignal {
		fn drop(&mut self) {
			let _ = self.0.send(());
		}
	}

	/// The runtime stays alive until the late output is dropped, so the
	/// blocking task always runs instead of being discarded at shutdown.
	#[test]
	fn a_call_past_its_budget_times_out_and_its_late_output_is_dropped() {
		let runtime = runtime();
		let (sender, dropped) = mpsc::channel();
		let outcome = runtime.block_on(bounded(Duration::from_millis(20), move || {
			std::thread::sleep(Duration::from_millis(200));
			Ok(DropSignal(sender))
		}));
		assert_eq!(outcome.map(|_| ()).expect_err("times out").kind, FileLockFailure::TimedOut);
		dropped
			.recv_timeout(Duration::from_secs(10))
			.expect("the late output is dropped once the call finishes");
		drop(runtime);
	}

	#[test]
	fn a_call_within_its_budget_returns_its_value() {
		assert_eq!(
			runtime()
				.block_on(bounded(Duration::from_secs(5), || Ok(7)))
				.expect("value"),
			7
		);
	}
}
