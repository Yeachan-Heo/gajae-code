// Vendored from oh-my-pi (MIT) crates/pi-natives/src/task.rs @
// a85bd5228d9f0f619deade1db78fa49420a721e1 Modified for gajae-code: retained
// catch_unwind→napi::Error and cancellation checks; adapted panic reporting;
// feature-gated Promise rejection probe.

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
#[cfg(feature = "task-panic-test")]
use napi_derive::napi;
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

/// Returns whether a JavaScript abort signal has already been aborted.
///
/// Invalid values are tolerated so optional cancellation never rejects an
/// otherwise valid native operation.
pub fn signal_aborted(signal: &Unknown) -> bool {
	signal
		.coerce_to_object()
		.and_then(|object| object.get_named_property::<bool>("aborted"))
		.unwrap_or(false)
}

impl CancelToken {
	/// Create a new cancel token from optional timeout and abort signal.
	pub fn new(timeout_ms: Option<u32>, signal: Option<Unknown>) -> Self {
		let mut result = Self { core: core_cancel::CancelToken::new(timeout_ms) };
		if let Some(raw_signal) = signal {
			// `on_abort` only fires for a future JS `abort` event. Do not wrap an
			// already-aborted signal: napi's wrapper replaces its `onabort` handler.
			if signal_aborted(&raw_signal) {
				result.emplace_abort_token().abort(AbortReason::Signal);
			} else if let Ok(signal) = AbortSignal::from_unknown(raw_signal) {
				let abort_token = result.emplace_abort_token();
				signal.on_abort(move || abort_token.abort(AbortReason::Signal));
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
		let cancel_token = self.cancel_token.clone();

		// napi-rs invokes `compute` through an `extern "C"` async-work callback.
		// Catch panics here so unwinding never crosses that FFI boundary.
		match catch_unwind(AssertUnwindSafe(move || work(cancel_token))) {
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

	fn reject(&mut self, _env: Env, err: Error) -> Result<Self::JsValue> {
		Err(err)
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
/// Like [`Blocking`], but the work closure fails with a typed domain error
/// that a reject hook converts on the JS thread.
///
/// The hook runs with `Env` access, so rejections can carry a real error
/// object (name/code/custom properties) instead of a bare message string.
pub struct BlockingMapped<T, E>
where
	T: Send + 'static,
	E: Send + 'static,
{
	tag:          &'static str,
	cancel_token: CancelToken,
	work:         Option<MappedWork<T, E>>,
	/// Domain error stashed by `compute` for `reject` to convert with `Env`.
	error:        Option<E>,
	reject_hook:  fn(Env, E) -> Error,
}
/// Boxed work closure for [`BlockingMapped`].
type MappedWork<T, E> = Box<dyn FnOnce(CancelToken) -> std::result::Result<T, E> + Send>;

impl<T, E> Task for BlockingMapped<T, E>
where
	T: ToNapiValue + Send + 'static + TypeName,
	E: Send + 'static,
{
	type JsValue = T;
	type Output = T;

	fn compute(&mut self) -> Result<Self::Output> {
		let _guard = profile_region(self.tag);
		self.cancel_token.heartbeat()?;

		let work = self
			.work
			.take()
			.ok_or_else(|| Error::from_reason("BlockingMapped: work already consumed"))?;
		let cancel_token = self.cancel_token.clone();
		// napi-rs invokes `compute` through an `extern "C"` async-work callback.
		// Keep the same panic-to-error contract as [`Blocking::compute`].
		match catch_unwind(AssertUnwindSafe(move || work(cancel_token))) {
			Ok(Ok(value)) => Ok(value),
			Ok(Err(domain)) => {
				self.error = Some(domain);
				Err(Error::from_reason("BlockingMapped: pending domain error"))
			},
			Err(payload) => Err(Error::from_reason(format!(
				"BlockingTask panic: {}",
				panic_payload_message(payload.as_ref())
			))),
		}
	}

	fn reject(&mut self, env: Env, err: Error) -> Result<Self::JsValue> {
		match self.error.take() {
			Some(domain) => Err((self.reject_hook)(env, domain)),
			None => Err(err),
		}
	}

	fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
		Ok(output)
	}
}

/// Promise type produced by [`blocking_mapped`].
pub type MappedPromise<T, E> = AsyncTask<BlockingMapped<T, E>>;

/// Like [`blocking`], but the closure fails with a typed domain error and
/// `reject_hook` converts it into the JS error on the JS thread (with `Env`),
/// allowing rejections to carry structured properties.
pub fn blocking_mapped<T, E, F>(
	tag: &'static str,
	cancel_token: impl Into<CancelToken>,
	reject_hook: fn(Env, E) -> Error,
	work: F,
) -> MappedPromise<T, E>
where
	F: FnOnce(CancelToken) -> std::result::Result<T, E> + Send + 'static,
	T: ToNapiValue + TypeName + Send + 'static,
	E: Send + 'static,
{
	AsyncTask::new(BlockingMapped {
		tag,
		cancel_token: cancel_token.into(),
		work: Some(Box::new(work)),
		error: None,
		reject_hook,
	})
}

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

#[cfg(feature = "task-panic-test")]
#[napi(js_name = "__gjcTestBlockingPanic")]
pub fn test_blocking_panic() -> Promise<String> {
	blocking("test_task_panic", (), |_| -> Result<String> { panic!("injected blocking task panic") })
}
#[cfg(test)]
mod tests {
	//! Regression coverage for the FFI-boundary panic guard in
	//! [`Blocking::compute`]. These exercise the trait method directly on the
	//! caller thread — libuv's async-work queue isn't running under
	//! `cargo test`, but the guard sits inside `compute`, so calling it
	//! synchronously proves the invariant: a panicking closure MUST NOT unwind
	//! past this method.

	use napi::Status;

	use super::*;
	use crate::testing::SilenceHook;

	fn blocking_task<T, F>(tag: &'static str, work: F) -> Blocking<T>
	where
		T: Send + 'static,
		F: FnOnce(CancelToken) -> Result<T> + Send + 'static,
	{
		Blocking { tag, cancel_token: CancelToken::default(), work: Some(Box::new(work)) }
	}

	#[test]
	fn compute_forwards_ok_result() {
		let mut task = blocking_task("t_ok", |_| Ok(42_u32));
		assert_eq!(task.compute().unwrap(), 42);
	}

	#[test]
	fn compute_forwards_err_result() {
		let mut task = blocking_task::<u32, _>("t_err", |_| Err(Error::from_reason("boom")));
		let err = task.compute().unwrap_err();
		assert_eq!(err.status, Status::GenericFailure);
		assert_eq!(err.reason, "boom");
	}

	#[test]
	fn compute_catches_str_literal_panic() {
		let _silence = SilenceHook::new();
		let mut task = blocking_task::<u32, _>("t_panic_str", |_| panic!("kaboom"));
		let err = task.compute().unwrap_err();
		assert_eq!(err.status, Status::GenericFailure);
		assert!(err.reason.contains("BlockingTask panic"), "reason = {}", err.reason);
		assert!(err.reason.contains("kaboom"), "reason = {}", err.reason);
	}

	#[test]
	fn compute_catches_formatted_panic() {
		let _silence = SilenceHook::new();
		let mut task = blocking_task::<u32, _>("t_panic_fmt", |_| {
			let n = 7;
			panic!("fmt {n}");
		});
		let err = task.compute().unwrap_err();
		assert!(err.reason.contains("fmt 7"), "reason = {}", err.reason);
	}

	#[test]
	fn compute_catches_non_string_panic() {
		let _silence = SilenceHook::new();
		let mut task = blocking_task::<u32, _>("t_panic_any", |_| {
			std::panic::panic_any(0xdead_beef_u32);
		});
		let err = task.compute().unwrap_err();
		assert!(err.reason.contains("unknown panic payload"), "reason = {}", err.reason);
	}

	#[test]
	fn compute_rejects_second_call() {
		let mut task = blocking_task("t_double", |_| Ok(1_u32));
		assert_eq!(task.compute().unwrap(), 1);
		let err = task.compute().unwrap_err();
		assert!(err.reason.contains("work already consumed"), "reason = {}", err.reason);
	}

	#[test]
	fn blocking_compute_rejects_pre_cancelled_token_without_running_work() {
		let mut cancel_token = CancelToken::default();
		let abort_token = cancel_token.emplace_abort_token();
		abort_token.abort(AbortReason::User);
		let work_ran = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
		let work_ran_in_task = std::sync::Arc::clone(&work_ran);
		let mut task = Blocking {
			tag: "test_cancelled",
			cancel_token,
			work: Some(Box::new(move |_| -> Result<String> {
				work_ran_in_task.store(true, std::sync::atomic::Ordering::SeqCst);
				Ok("ran".to_owned())
			})),
		};

		let err = task
			.compute()
			.expect_err("pre-cancelled task should return cancellation error");
		assert!(err.reason.contains("Aborted: User"), "reason = {}", err.reason);
		assert!(!work_ran.load(std::sync::atomic::Ordering::SeqCst));
	}
}
