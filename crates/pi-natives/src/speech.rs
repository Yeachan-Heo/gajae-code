//! macOS on-device speech recognition exported via N-API.
//!
//! Wraps `SFSpeechRecognizer` + `AVAudioEngine` (Speech / `AVFAudio`
//! frameworks) into a streaming session: live microphone audio is fed to a
//! `SFSpeechAudioBufferRecognitionRequest`, partial transcriptions and input
//! level samples are delivered to a JS callback as they arrive, and `stop()`
//! finalizes the transcription.
//!
//! Design notes for a CLI host (no UI run loop):
//! - Recognition handlers default to the app **main queue**, which a CLI
//!   process never drains. The session pins a private `NSOperationQueue` on the
//!   recognizer so result handlers fire on a background queue instead.
//! - `requestAuthorization` completion-queue behavior is undocumented, so the
//!   exported authorization helper resolves via the callback **or** an
//!   `authorizationStatus` polling fallback, whichever reports a decision
//!   first. The TCC prompt updates the polled status even if the completion
//!   block lands on an undrained queue.
//!
//! On non-macOS platforms every export is a no-op/`None` so higher layers can
//! keep one cross-platform code path (same policy as `appearance.rs` /
//! `power.rs`).

use napi_derive::napi;

/// One streaming event delivered to the JS callback of a
/// [`MacSpeechSession`].
#[napi(object)]
#[derive(Clone)]
pub struct MacSpeechEvent {
	/// `"partial"` | `"final"` | `"level"` | `"error"`.
	pub kind:    String,
	/// Transcription text for `partial` / `final` events.
	pub text:    Option<String>,
	/// Normalized input level (0..1) for `level` events.
	pub level:   Option<f64>,
	/// Human-readable failure description for `error` events.
	pub message: Option<String>,
}

/// Options for starting a [`MacSpeechSession`].
#[napi(object)]
#[derive(Clone)]
pub struct MacSpeechStartOptions {
	/// BCP-47 locale identifier (e.g. `"ko-KR"`). Defaults to the system
	/// locale when omitted.
	pub locale:             Option<String>,
	/// Require on-device recognition (no audio leaves the machine). When the
	/// locale has no on-device support, session start fails with an `error`
	/// event instead of silently falling back to Apple servers. Default: true.
	pub on_device_only:     Option<bool>,
	/// Domain vocabulary (identifiers, file names, product terms) passed to
	/// the recognizer as `contextualStrings` to bias recognition.
	pub contextual_strings: Option<Vec<String>>,
	/// Ask the recognizer to add punctuation (macOS 13+). Default: true.
	pub punctuation:        Option<bool>,
}

/// Locale capability report for the Apple speech backend.
#[napi(object)]
#[derive(Clone)]
pub struct MacSpeechSupport {
	/// Platform is macOS and the recognizer class is present.
	pub platform:  bool,
	/// A recognizer exists for the requested locale.
	pub locale:    bool,
	/// The recognizer currently reports itself available (assets present).
	pub available: bool,
	/// The locale supports on-device (private) recognition.
	pub on_device: bool,
}

#[cfg(target_os = "macos")]
mod platform {
	use std::{
		sync::{
			Arc,
			atomic::{AtomicBool, Ordering},
		},
		thread,
		time::{Duration, Instant},
	};

	use block2::RcBlock;
	use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
	use objc2::{AnyThread, rc::Retained};
	use objc2_avf_audio::{AVAudioEngine, AVAudioInputNode};
	use objc2_foundation::{NSArray, NSLocale, NSOperationQueue, NSString};
	use objc2_speech::{
		SFSpeechAudioBufferRecognitionRequest, SFSpeechRecognitionTask, SFSpeechRecognizer,
		SFSpeechRecognizerAuthorizationStatus,
	};
	use parking_lot::Mutex;

	use super::{MacSpeechEvent, MacSpeechStartOptions, MacSpeechSupport};

	/// Minimum interval between `level` events so the meter never floods the
	/// JS thread (audio taps fire ~40x/s).
	const LEVEL_EVENT_INTERVAL: Duration = Duration::from_millis(80);
	/// Polling cadence for the authorization fallback loop.
	const AUTH_POLL_INTERVAL: Duration = Duration::from_millis(200);
	/// Give up waiting for an authorization decision after this long.
	const AUTH_POLL_TIMEOUT: Duration = Duration::from_mins(5);

	const fn status_label(status: SFSpeechRecognizerAuthorizationStatus) -> &'static str {
		match status {
			SFSpeechRecognizerAuthorizationStatus::Authorized => "authorized",
			SFSpeechRecognizerAuthorizationStatus::Denied => "denied",
			SFSpeechRecognizerAuthorizationStatus::Restricted => "restricted",
			_ => "notDetermined",
		}
	}

	pub fn authorization_status() -> String {
		// SAFETY: Class method with no arguments; safe to call from any thread.
		let status = unsafe { SFSpeechRecognizer::authorizationStatus() };
		status_label(status).to_string()
	}

	/// Resolve an authorization request via completion block OR status
	/// polling, whichever observes a decision first. Exactly one callback
	/// invocation is guaranteed.
	pub fn request_authorization(tsfn: ThreadsafeFunction<String>) {
		let done = Arc::new(AtomicBool::new(false));
		let tsfn = Arc::new(tsfn);

		let emit = {
			let done = done.clone();
			let tsfn = tsfn.clone();
			move |label: &str| {
				if !done.swap(true, Ordering::SeqCst) {
					tsfn.call(Ok(label.to_string()), ThreadsafeFunctionCallMode::NonBlocking);
				}
			}
		};

		// Completion-block path. May land on an undrained queue in a CLI
		// process — the polling fallback below covers that case.
		let block_emit = emit.clone();
		let handler = RcBlock::new(move |status: SFSpeechRecognizerAuthorizationStatus| {
			block_emit(status_label(status));
		});
		// SAFETY: `handler` is a heap block retained by the runtime for the
		// duration of the request; the closure only touches `Arc`ed state.
		unsafe { SFSpeechRecognizer::requestAuthorization(&handler) };

		// Polling fallback: the TCC decision is visible through
		// `authorizationStatus` regardless of where the block is dispatched.
		thread::spawn(move || {
			let start = Instant::now();
			loop {
				if done.load(Ordering::SeqCst) {
					return;
				}
				// SAFETY: See `authorization_status`.
				let status = unsafe { SFSpeechRecognizer::authorizationStatus() };
				if status != SFSpeechRecognizerAuthorizationStatus::NotDetermined {
					emit(status_label(status));
					return;
				}
				if start.elapsed() > AUTH_POLL_TIMEOUT {
					emit("notDetermined");
					return;
				}
				thread::sleep(AUTH_POLL_INTERVAL);
			}
		});
	}

	fn make_recognizer(locale: Option<&str>) -> Option<Retained<SFSpeechRecognizer>> {
		match locale {
			Some(identifier) => {
				let identifier = NSString::from_str(identifier);
				// SAFETY: `initWithLocale:` accepts any locale object and returns
				// nil (None) for unsupported locales.
				unsafe {
					let locale = NSLocale::initWithLocaleIdentifier(NSLocale::alloc(), &identifier);
					SFSpeechRecognizer::initWithLocale(SFSpeechRecognizer::alloc(), &locale)
				}
			},
			// SAFETY: Plain default-locale initializer.
			None => unsafe { SFSpeechRecognizer::init(SFSpeechRecognizer::alloc()) },
		}
	}

	pub fn support(locale: Option<&str>) -> MacSpeechSupport {
		let Some(recognizer) = make_recognizer(locale) else {
			return MacSpeechSupport {
				platform:  true,
				locale:    false,
				available: false,
				on_device: false,
			};
		};
		// SAFETY: Property getters on a live recognizer instance.
		let (available, on_device) =
			unsafe { (recognizer.isAvailable(), recognizer.supportsOnDeviceRecognition()) };
		MacSpeechSupport { platform: true, locale: true, available, on_device }
	}

	/// Shared cross-callback state for one recognition session.
	struct SessionState {
		tsfn:       ThreadsafeFunction<MacSpeechEvent>,
		/// Set by `cancel()` — suppresses further events (including the
		/// recognizer's "canceled" error).
		cancelled:  AtomicBool,
		/// The single terminal `final`/`error` event has been emitted.
		finalized:  AtomicBool,
		/// `stop()` was requested; recognizer errors after this point are
		/// mapped to an empty `final` (e.g. "no speech detected").
		stopping:   AtomicBool,
		last_level: Mutex<Instant>,
	}

	impl SessionState {
		fn emit(&self, event: MacSpeechEvent) {
			if self.cancelled.load(Ordering::SeqCst) {
				return;
			}
			self
				.tsfn
				.call(Ok(event), ThreadsafeFunctionCallMode::NonBlocking);
		}

		fn emit_terminal(&self, event: MacSpeechEvent) {
			if self.finalized.swap(true, Ordering::SeqCst) {
				return;
			}
			self.emit(event);
		}
	}

	pub struct SessionInner {
		engine:      Retained<AVAudioEngine>,
		input:       Retained<AVAudioInputNode>,
		request:     Retained<SFSpeechAudioBufferRecognitionRequest>,
		task:        Retained<SFSpeechRecognitionTask>,
		/// Keeps the recognizer (and its pinned handler queue) alive for the
		/// lifetime of the task.
		_recognizer: Retained<SFSpeechRecognizer>,
		_queue:      Retained<NSOperationQueue>,
		state:       Arc<SessionState>,
		torn_down:   bool,
	}

	/// Root-mean-square of the first channel mapped to 0..1 through a
	/// -50dBFS..0dBFS window — matches how audio meters usually feel.
	fn buffer_level(channel: *const f32, frames: usize, stride: usize) -> f64 {
		if channel.is_null() || frames == 0 {
			return 0.0;
		}
		let mut sum = 0.0f64;
		for i in 0..frames {
			// SAFETY: `channel` points at at least `frames * stride` valid f32
			// samples for the duration of the tap callback.
			let sample = f64::from(unsafe { *channel.add(i * stride) });
			sum = sample.mul_add(sample, sum);
		}
		let rms = (sum / frames as f64).sqrt();
		if rms <= 0.0 {
			return 0.0;
		}
		let db = 20.0 * rms.log10();
		((db + 50.0) / 50.0).clamp(0.0, 1.0)
	}

	impl SessionInner {
		pub fn start(
			options: &MacSpeechStartOptions,
			tsfn: ThreadsafeFunction<MacSpeechEvent>,
		) -> Result<Self, String> {
			let recognizer =
				make_recognizer(options.locale.as_deref()).ok_or("speech_locale_unsupported")?;

			// SAFETY: Property getters/setters on live objects. The dedicated
			// operation queue replaces the default main queue, which a CLI
			// process never drains.
			let queue = unsafe {
				if !recognizer.isAvailable() {
					return Err("speech_recognizer_unavailable".into());
				}
				let queue = NSOperationQueue::new();
				recognizer.setQueue(&queue);
				queue
			};

			let on_device_only = options.on_device_only.unwrap_or(true);
			// SAFETY: Property getter on a live recognizer.
			if on_device_only && !unsafe { recognizer.supportsOnDeviceRecognition() } {
				return Err("speech_on_device_unsupported".into());
			}

			// SAFETY: Request configuration before the task starts; all setters
			// are plain property writes.
			let request = unsafe {
				let request = SFSpeechAudioBufferRecognitionRequest::new();
				request.setShouldReportPartialResults(true);
				request.setRequiresOnDeviceRecognition(on_device_only);
				if options.punctuation.unwrap_or(true) {
					request.setAddsPunctuation(true);
				}
				if let Some(strings) = options.contextual_strings.as_ref()
					&& !strings.is_empty()
				{
					let items: Vec<Retained<NSString>> =
						strings.iter().map(|s| NSString::from_str(s)).collect();
					request.setContextualStrings(&NSArray::from_retained_slice(&items));
				}
				request
			};

			let state = Arc::new(SessionState {
				tsfn,
				cancelled: AtomicBool::new(false),
				finalized: AtomicBool::new(false),
				stopping: AtomicBool::new(false),
				last_level: Mutex::new(Instant::now()),
			});

			// -- Audio engine + level tap ------------------------------------
			// SAFETY: Engine/node graph calls follow the documented AVAudioEngine
			// lifecycle (tap install → prepare → start). The tap block only
			// touches Arc'ed state and objects retained by the block itself.
			let (engine, input) = unsafe {
				let engine = AVAudioEngine::new();
				let input = engine.inputNode();
				let format = input.outputFormatForBus(0);
				if format.sampleRate() <= 0.0 || format.channelCount() == 0 {
					return Err("speech_no_input_device".into());
				}

				let tap_request = request.clone();
				let tap_state = state.clone();
				let tap = RcBlock::new(
					move |buffer: std::ptr::NonNull<objc2_avf_audio::AVAudioPCMBuffer>,
					      _when: std::ptr::NonNull<objc2_avf_audio::AVAudioTime>| {
						// SAFETY: CoreAudio guarantees the buffer stays valid for the
						// duration of the tap callback; append + property reads are
						// documented-safe on a live PCM buffer.
						let buffer_ref = buffer.as_ref();
						tap_request.appendAudioPCMBuffer(buffer_ref);

						let frames = buffer_ref.frameLength() as usize;
						let stride = buffer_ref.stride();
						let channels = buffer_ref.floatChannelData();
						let channel: *const f32 = if channels.is_null() {
							std::ptr::null()
						} else {
							(*channels).as_ptr()
						};
						let now = Instant::now();
						{
							let mut last = tap_state.last_level.lock();
							if now.duration_since(*last) < LEVEL_EVENT_INTERVAL {
								return;
							}
							*last = now;
						}
						let level = buffer_level(channel, frames, stride.max(1));
						tap_state.emit(MacSpeechEvent {
							kind:    "level".into(),
							text:    None,
							level:   Some(level),
							message: None,
						});
					},
				);
				let tap_ptr = (&raw const *tap).cast_mut();
				input.installTapOnBus_bufferSize_format_block(0, 1024, Some(&format), tap_ptr);

				engine.prepare();
				if let Err(err) = engine.startAndReturnError() {
					input.removeTapOnBus(0);
					return Err(format!("speech_audio_engine_failed: {}", err.localizedDescription()));
				}
				(engine, input)
			};

			// -- Recognition task --------------------------------------------
			let handler_state = state.clone();
			let handler = RcBlock::new(
				move |result: *mut objc2_speech::SFSpeechRecognitionResult,
				      error: *mut objc2_foundation::NSError| {
					if !result.is_null() {
						// SAFETY: Non-null result pointer from the recognizer is a live
						// object for the duration of the handler.
						let (text, is_final) = unsafe {
							let result = &*result;
							(result.bestTranscription().formattedString().to_string(), result.isFinal())
						};
						if is_final {
							handler_state.emit_terminal(MacSpeechEvent {
								kind:    "final".into(),
								text:    Some(text),
								level:   None,
								message: None,
							});
						} else {
							handler_state.emit(MacSpeechEvent {
								kind:    "partial".into(),
								text:    Some(text),
								level:   None,
								message: None,
							});
						}
						return;
					}
					if !error.is_null() {
						// SAFETY: Non-null error pointer is a live NSError.
						let message = unsafe { (*error).localizedDescription().to_string() };
						if handler_state.stopping.load(Ordering::SeqCst) {
							// Errors after a graceful stop (e.g. "no speech detected")
							// terminate the session as an empty final result.
							handler_state.emit_terminal(MacSpeechEvent {
								kind:    "final".into(),
								text:    Some(String::new()),
								level:   None,
								message: None,
							});
						} else {
							handler_state.emit_terminal(MacSpeechEvent {
								kind:    "error".into(),
								text:    None,
								level:   None,
								message: Some(message),
							});
						}
					}
				},
			);
			// SAFETY: Both request and handler outlive the task via retains held
			// by the recognizer; the returned task is retained by this session.
			let task =
				unsafe { recognizer.recognitionTaskWithRequest_resultHandler(&request, &handler) };

			Ok(Self {
				engine,
				input,
				request,
				task,
				_recognizer: recognizer,
				_queue: queue,
				state,
				torn_down: false,
			})
		}

		fn teardown_audio(&mut self) {
			if self.torn_down {
				return;
			}
			self.torn_down = true;
			// SAFETY: Documented teardown order — stop engine, remove tap, close
			// the request's audio stream. Idempotence is guarded by `torn_down`.
			unsafe {
				self.engine.stop();
				self.input.removeTapOnBus(0);
				self.request.endAudio();
			}
		}

		/// Graceful stop: close the audio stream and let the recognizer
		/// deliver its final result through the handler.
		pub fn stop(&mut self) {
			self.state.stopping.store(true, Ordering::SeqCst);
			self.teardown_audio();
			// SAFETY: `finish` asks the task to complete with whatever audio it
			// already has; safe on a live task.
			unsafe { self.task.finish() };
		}

		/// Hard cancel: suppress all further events and abort the task.
		pub fn cancel(&mut self) {
			self.state.cancelled.store(true, Ordering::SeqCst);
			self.state.finalized.store(true, Ordering::SeqCst);
			self.teardown_audio();
			// SAFETY: Safe on a live task; repeated cancels are no-ops.
			unsafe { self.task.cancel() };
		}
	}

	impl Drop for SessionInner {
		fn drop(&mut self) {
			if self.state.finalized.load(Ordering::SeqCst) {
				self.teardown_audio();
			} else {
				self.cancel();
			}
		}
	}

	// The session owns Objective-C objects that are only touched from the JS
	// thread (start/stop/cancel) — recognizer callbacks communicate solely
	// through `Arc<SessionState>` + threadsafe functions. N-API class storage
	// requires `Send`, which these retained pointers do not derive
	// automatically.
	//
	// SAFETY: All `Retained` fields are used exclusively from the single JS
	// thread that constructed the session; background queues never receive
	// `self`, only the `Arc`ed state and block-retained objects.
	#[allow(clippy::non_send_fields_in_send_ty, reason = "JS-thread-only usage documented above")]
	unsafe impl Send for SessionInner {}

	/// Channel-backed helper so the napi factory can build the session on the
	/// current thread while keeping the constructor signature synchronous.
	pub fn start_session(
		options: &MacSpeechStartOptions,
		tsfn: ThreadsafeFunction<MacSpeechEvent>,
	) -> Result<SessionInner, String> {
		SessionInner::start(options, tsfn)
	}
}

// ---------------------------------------------------------------------------
// N-API exports
// ---------------------------------------------------------------------------

/// Report Apple speech backend capability for a locale.
/// All fields are `false` on non-macOS platforms.
#[napi(js_name = "macSpeechSupport")]
#[allow(
	clippy::missing_const_for_fn,
	reason = "non-macOS reduction is trivially const; napi macro and the macOS branch are not"
)]
pub fn mac_speech_support(locale: Option<String>) -> MacSpeechSupport {
	#[cfg(target_os = "macos")]
	{
		platform::support(locale.as_deref())
	}
	#[cfg(not(target_os = "macos"))]
	{
		let _ = locale;
		MacSpeechSupport { platform: false, locale: false, available: false, on_device: false }
	}
}

/// Current speech-recognition authorization status:
/// `"authorized" | "denied" | "restricted" | "notDetermined"`.
/// Returns `null` on non-macOS platforms.
#[napi(js_name = "macSpeechAuthorizationStatus")]
#[allow(
	clippy::missing_const_for_fn,
	reason = "non-macOS reduction is trivially const; napi macro and the macOS branch are not"
)]
pub fn mac_speech_authorization_status() -> Option<String> {
	#[cfg(target_os = "macos")]
	{
		Some(platform::authorization_status())
	}
	#[cfg(not(target_os = "macos"))]
	{
		None
	}
}

/// Trigger the speech-recognition permission prompt.
///
/// The callback receives the resolved status exactly once (see module docs
/// for the CLI-safe completion strategy). On non-macOS platforms the
/// callback fires immediately with `"notDetermined"`.
#[napi(js_name = "macSpeechRequestAuthorization")]
pub fn mac_speech_request_authorization(
	#[napi(ts_arg_type = "(err: null | Error, status: string) => void")]
	callback: napi::threadsafe_function::ThreadsafeFunction<String>,
) {
	#[cfg(target_os = "macos")]
	{
		platform::request_authorization(callback);
	}
	#[cfg(not(target_os = "macos"))]
	{
		use napi::threadsafe_function::ThreadsafeFunctionCallMode;
		callback.call(Ok("notDetermined".to_string()), ThreadsafeFunctionCallMode::NonBlocking);
	}
}

/// Streaming on-device speech recognition session (macOS).
///
/// `start()` opens the microphone through `AVAudioEngine`, streams buffers to
/// `SFSpeechRecognizer`, and reports `partial` / `level` events until either
/// `stop()` (graceful — emits one terminal `final` event) or `cancel()`
/// (silent abort). On non-macOS platforms `start()` fails with an error.
#[napi]
pub struct MacSpeechSession {
	#[cfg(target_os = "macos")]
	inner: Option<platform::SessionInner>,
}

#[napi]
impl MacSpeechSession {
	#[napi(factory)]
	pub fn start(
		options: MacSpeechStartOptions,
		#[napi(ts_arg_type = "(err: null | Error, event: MacSpeechEvent) => void")]
		callback: napi::threadsafe_function::ThreadsafeFunction<MacSpeechEvent>,
	) -> napi::Result<Self> {
		#[cfg(target_os = "macos")]
		{
			match platform::start_session(&options, callback) {
				Ok(inner) => Ok(Self { inner: Some(inner) }),
				Err(code) => Err(napi::Error::from_reason(code)),
			}
		}
		#[cfg(not(target_os = "macos"))]
		{
			let _ = (options, callback);
			Err(napi::Error::from_reason("speech_platform_unsupported"))
		}
	}

	/// Graceful stop — the terminal `final` event arrives via the callback.
	#[napi]
	#[allow(clippy::missing_const_for_fn, reason = "napi macro is incompatible with const fn")]
	pub fn stop(&mut self) {
		#[cfg(target_os = "macos")]
		if let Some(inner) = &mut self.inner {
			inner.stop();
		}
	}

	/// Hard cancel — suppresses all further events, including `final`.
	#[napi]
	#[allow(clippy::missing_const_for_fn, reason = "napi macro is incompatible with const fn")]
	pub fn cancel(&mut self) {
		#[cfg(target_os = "macos")]
		if let Some(inner) = &mut self.inner {
			inner.cancel();
			self.inner = None;
		}
	}
}
