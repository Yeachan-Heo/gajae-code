//! Blocking work scheduling for N-API exports.
//!
//! # Overview
//! Runs CPU-bound or blocking Rust work on libuv's thread pool via napi's
//! `Task` trait, with profiling and cancellation support.
//!
//! # Cancellation
//! Pass a `CancelToken` to blocking tasks. Work must check
//! `CancelToken::heartbeat()` periodically to respect cancellation.
//!
//! # Profiling
//! Samples are always collected into a circular buffer. Call
//! `get_work_profile()` to retrieve the last N seconds of data.
//!
//! # Usage
//! ```ignore
//! use crate::work::{blocking_task, CancelToken};
//!
//! #[napi]
//! fn my_heavy_work(signal: Option<AbortSignal>) -> AsyncTask<impl Task<...>> {
//!     let ct = CancelToken::new(None, signal);
//!     blocking_task("my_work", ct, |ct| {
//!         ct.heartbeat()?;
//!         // ... heavy computation ...
//!         Ok(result)
//!     })
//! }
//! ```

use std::{
	future::Future,
	panic::{AssertUnwindSafe, catch_unwind},
};

use napi::{Env, Error, Result, Task, bindgen_prelude::*};
use pi_shell::cancel as core_cancel;

use crate::prof::profile_region;

// ─────────────────────────────────────────────────────────────────────────────
// Cancellation
// ─────────────────────────────────────────────────────────────────────────────

/// Reason for task abortion.
#[derive(Debug, Clone, Copy)]
pub enum AbortReason {
	Unknown,
	Timeout,
	Signal,
	User,
}

impl From<core_cancel::AbortReason> for AbortReason {
	fn from(value: core_cancel::AbortReason) -> Self {
		match value {
			core_cancel::AbortReason::Unknown => Self::Unknown,
			core_cancel::AbortReason::Timeout => Self::Timeout,
			core_cancel::AbortReason::Signal => Self::Signal,
			core_cancel::AbortReason::User => Self::User,
		}
	}
}

impl From<AbortReason> for core_cancel::AbortReason {
	fn from(value: AbortReason) -> Self {
		match value {
			AbortReason::Unknown => Self::Unknown,
			AbortReason::Timeout => Self::Timeout,
			AbortReason::Signal => Self::Signal,
			AbortReason::User => Self::User,
		}
	}
}

/// Token for cooperative cancellation of blocking work.
///
/// Call `heartbeat()` periodically inside long-running work to check for
/// cancellation requests from timeouts or abort signals.
#[derive(Clone, Default)]
pub struct CancelToken {
	core: core_cancel::CancelToken,
}

impl From<()> for CancelToken {
	fn from((): ()) -> Self {
		Self::default()
	}
}

impl CancelToken {
	/// Create a new cancel token from optional timeout and abort signal.
	pub fn new(timeout_ms: Option<u32>, signal: Option<Unknown>) -> Self {
		let mut result = Self { core: core_cancel::CancelToken::new(timeout_ms) };
		if let Some(signal) = signal {
			let object = Object::from_raw(signal.value().env, signal.value().value);
			let aborted = object
				.get_named_property::<bool>("aborted")
				.unwrap_or(false);
			let abort_token = result.emplace_abort_token();
			if let Ok(signal) = AbortSignal::from_unknown(signal) {
				if aborted {
					abort_token.abort(AbortReason::Signal);
				} else {
					signal.on_abort(move || abort_token.abort(AbortReason::Signal));
				}
			} else {
				abort_token.abort(AbortReason::Unknown);
			}
		}
		result
	}

	/// Check if cancellation has been requested.
	///
	/// Returns `Ok(())` if work should continue, or an error if cancelled.
	/// Call this periodically in long-running loops.
	pub fn heartbeat(&self) -> Result<()> {
		self
			.core
			.heartbeat()
			.map_err(|err| Error::from_reason(err.to_string()))
	}

	/// Wait for the cancel token to be aborted.
	pub async fn wait(&self) -> AbortReason {
		self.core.wait().await.into()
	}

	/// Get an abort token for external cancellation.
	pub fn abort_token(&self) -> AbortToken {
		AbortToken(self.core.abort_token())
	}

	/// Emplaces a cancel token if there is none, returns the abort token.
	pub fn emplace_abort_token(&mut self) -> AbortToken {
		AbortToken(self.core.emplace_abort_token())
	}

	/// Check if already aborted (non-blocking).
	pub fn aborted(&self) -> bool {
		self.core.aborted()
	}

	pub fn into_core(self) -> core_cancel::CancelToken {
		self.core
	}
}

/// Token for requesting cancellation from outside the task.
#[derive(Clone, Default)]
pub struct AbortToken(core_cancel::AbortToken);

impl AbortToken {
	/// Request cancellation of the associated task.
	pub fn abort(&self, reason: AbortReason) {
		self.0.abort(reason.into());
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Blocking Task - libuv thread pool integration
// ─────────────────────────────────────────────────────────────────────────────

/// Task that runs blocking work on libuv's thread pool with profiling.
///
/// This implements napi's `Task` trait, running `compute()` on a libuv worker
/// thread and `resolve()` on the main JS thread.
pub struct Blocking<T>
where
	T: Send + 'static,
{
	tag:          &'static str,
	cancel_token: CancelToken,
	work:         Option<Box<dyn FnOnce(CancelToken) -> Result<T> + Send>>,
}

impl<T> Task for Blocking<T>
where
	T: ToNapiValue + Send + 'static + TypeName,
{
	type JsValue = T;
	type Output = T;

	fn compute(&mut self) -> Result<Self::Output> {
		let _guard = profile_region(self.tag);
		self.cancel_token.heartbeat()?;
		let work = self
			.work
			.take()
			.ok_or_else(|| Error::from_reason("BlockingTask: work already consumed"))?;
		match catch_unwind(AssertUnwindSafe(|| work(self.cancel_token.clone()))) {
			Ok(result) => result,
			Err(payload) => Err(Error::from_reason(format!(
				"BlockingTask panic: {}",
				panic_payload_message(payload.as_ref())
			))),
		}
	}

	fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
		Ok(output)
	}
}

fn panic_payload_message(payload: &(dyn std::any::Any + Send)) -> String {
	if let Some(message) = payload.downcast_ref::<&str>() {
		(*message).to_owned()
	} else if let Some(message) = payload.downcast_ref::<String>() {
		message.clone()
	} else {
		"unknown panic payload".to_owned()
	}
}

pub type Promise<T> = AsyncTask<Blocking<T>>;

/// Create an `AsyncTask` that runs blocking work on libuv's thread pool.
///
/// Returns `AsyncTask<BlockingTask<T>>` which can be returned directly from
/// `#[napi]` functions - it becomes `Promise<T>` on the JS side.
///
/// # Arguments
/// - `tag`: Profiling tag for this work (appears in flamegraphs)
/// - `cancel_token`: Token for cooperative cancellation
/// - `work`: Closure that performs the blocking work
///
/// # Example
/// ```ignore
/// #[napi]
/// fn heavy_computation(signal: Option<AbortSignal>) -> AsyncTask<impl Task<...>> {
///     let ct = CancelToken::new(None, signal);
///     blocking_task("heavy_computation", ct, |ct| {
///         for i in 0..1000 {
///             ct.heartbeat()?; // Check for cancellation
///             // ... do work ...
///         }
///         Ok(result)
///     })
/// }
/// ```
pub fn blocking<T, F>(
	tag: &'static str,
	cancel_token: impl Into<CancelToken>,
	work: F,
) -> AsyncTask<Blocking<T>>
where
	F: FnOnce(CancelToken) -> Result<T> + Send + 'static,
	T: ToNapiValue + TypeName + Send + 'static,
{
	AsyncTask::new(Blocking { tag, cancel_token: cancel_token.into(), work: Some(Box::new(work)) })
}

// ─────────────────────────────────────────────────────────────────────────────
// Async Task - Tokio runtime integration
// ─────────────────────────────────────────────────────────────────────────────

/// Run an async task on Tokio's runtime with profiling.
///
/// Use this for operations that need to `.await` (async I/O, `select!`, etc.).
/// For CPU-bound blocking work, use [`blocking_task`] instead.
///
/// # Arguments
/// - `env`: N-API environment (needed for `spawn_future`)
/// - `tag`: Profiling tag for this work
/// - `work`: Async closure that performs the work
///
/// # Example
/// ```ignore
/// #[napi]
/// fn run_async_io<'e>(env: &'e Env) -> Result<PromiseRaw<'e, String>> {
///     async_task(env, "async_io", async move {
///         let data = fetch_data().await?;
///         Ok(data)
///     })
/// }
/// ```
pub fn future<'env, T, Fut>(
	env: &'env Env,
	tag: &'static str,
	work: Fut,
) -> Result<PromiseRaw<'env, T>>
where
	Fut: Future<Output = Result<T>> + Send + 'static,
	T: ToNapiValue + Send + 'static,
{
	env.spawn_future(async move {
		let _guard = profile_region(tag);
		work.await
	})
}

#[cfg(test)]
mod tests {
	use std::sync::{
		Arc,
		atomic::{AtomicBool, Ordering},
	};

	use napi::Task;

	use super::*;

	#[test]
	fn blocking_compute_catches_non_string_panic_as_error() {
		let mut task = Blocking {
			tag:          "test_non_string_panic",
			cancel_token: CancelToken::default(),
			work:         Some(Box::new(|_| -> Result<String> { std::panic::panic_any(42) })),
		};

		let result = task.compute();

		let err = result.expect_err("non-string panic should be converted into a napi error");
		assert!(
			err.reason.contains("BlockingTask panic"),
			"panic should be converted to a napi error, got: {}",
			err.reason
		);
		assert!(
			err.reason.contains("unknown panic payload"),
			"non-string panic payload should be reported without unwinding, got: {}",
			err.reason
		);
	}

	#[test]
	fn blocking_compute_catches_panic_as_error() {
		let mut task = Blocking {
			tag:          "test_panic",
			cancel_token: CancelToken::default(),
			work:         Some(Box::new(|_| -> Result<String> { panic!("native boom") })),
		};

		let result = task.compute();

		let err = result.expect_err("panic should be converted into a napi error");
		assert!(
			err.reason.contains("native boom"),
			"panic payload should be preserved, got: {}",
			err.reason
		);
	}

	#[test]
	fn blocking_compute_catches_string_panic_payload_as_error() {
		let mut task = Blocking {
			tag:          "test_string_panic",
			cancel_token: CancelToken::default(),
			work:         Some(Box::new(|_| -> Result<String> {
				std::panic::panic_any(String::from("owned native boom"))
			})),
		};

		let result = task.compute();

		let err = result.expect_err("String panic should be converted into a napi error");
		assert!(
			err.reason.contains("owned native boom"),
			"String panic payload should be preserved, got: {}",
			err.reason
		);
	}

	#[test]
	fn blocking_compute_rejects_pre_cancelled_token_without_running_work() {
		let mut cancel_token = CancelToken::default();
		let abort_token = cancel_token.emplace_abort_token();
		abort_token.abort(AbortReason::User);
		let work_ran = Arc::new(AtomicBool::new(false));
		let work_ran_in_task = Arc::clone(&work_ran);
		let mut task = Blocking {
			tag: "test_cancelled",
			cancel_token,
			work: Some(Box::new(move |_| -> Result<String> {
				work_ran_in_task.store(true, Ordering::SeqCst);
				Ok("ran".to_owned())
			})),
		};

		let result = task.compute();

		let err = result.expect_err("pre-cancelled task should return cancellation error");
		assert!(
			err.reason.contains("Aborted: User"),
			"cancellation reason should be preserved, got: {}",
			err.reason
		);
		assert!(!work_ran.load(Ordering::SeqCst), "work closure must not run after pre-cancellation");
	}

	#[test]
	fn blocking_compute_observes_token_cancelled_by_heartbeat_mid_work() {
		let mut cancel_token = CancelToken::default();
		let abort_token = cancel_token.emplace_abort_token();
		let work_started = Arc::new(AtomicBool::new(false));
		let work_started_in_task = Arc::clone(&work_started);
		let mut task = Blocking {
			tag: "test_mid_work_cancelled",
			cancel_token,
			work: Some(Box::new(move |token| -> Result<String> {
				work_started_in_task.store(true, Ordering::SeqCst);
				abort_token.abort(AbortReason::User);
				token.heartbeat()?;
				Ok("missed cancellation".to_owned())
			})),
		};

		let result = task.compute();

		let err = result.expect_err("heartbeat should observe mid-work cancellation");
		assert!(
			work_started.load(Ordering::SeqCst),
			"work closure should start before mid-work cancellation"
		);
		assert!(
			err.reason.contains("Aborted: User"),
			"heartbeat cancellation reason should be preserved, got: {}",
			err.reason
		);
	}
}
