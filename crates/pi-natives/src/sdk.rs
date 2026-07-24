//! N-API surface for the Gajae-Code SDK.
//!
//! Wraps [`gjc_sdk`] so the TypeScript extension can host a
//! per-session loopback WebSocket notification server in-process. The server
//! runs in **forward mode**: accepted client replies are handed back to
//! TypeScript (via the [`NotificationServer::on_reply`] callback) so TS
//! resolves the real GJC workflow gate, then calls
//! [`NotificationServer::resolve_client`] — guaranteeing `action_resolved` is
//! only broadcast after a genuine resolution.
//!
//! Call order: construct, [`NotificationServer::on_reply`] (optional), then
//! [`NotificationServer::start`]. `on_reply` must be registered before `start`.

use std::{
	path::PathBuf,
	sync::atomic::{AtomicU64, Ordering},
	time::Duration,
};

use gjc_sdk::{
	ActionIdentity, ActionNeeded, ClientMessage, ControlServerConfig, ControlServerHandle,
	LifecycleClientMessage, LifecycleServerMessage, ReplyAnswer, ServerConfig, ServerHandle,
	ServerMessage, Verbosity,
	actions::RetireIfUnclaimed,
	protocol::{
		FileAttachment, SessionReady, TurnPhase, TurnStream, decode_workflow_gate_action_needed,
	},
	start_control,
};
use napi::{
	bindgen_prelude::*,
	threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode},
};
use napi_derive::napi;
use parking_lot::Mutex;

fn saturating_increment(counter: &AtomicU64) {
	let _ = counter.fetch_update(Ordering::Relaxed, Ordering::Relaxed, |value| value.checked_add(1));
}
/// Bound endpoint info returned from [`NotificationServer::start`].
#[napi(object)]
pub struct NotificationEndpoint {
	/// Bind host (loopback).
	pub host:       String,
	/// Bound port.
	pub port:       u32,
	/// `ws://host:port` URL.
	pub url:        String,
	/// The session id this endpoint serves.
	pub session_id: String,
}

/// A client reply forwarded to the TypeScript host for gate resolution.
#[napi(object)]
pub struct ReplyEvent {
	/// The transient action/presentation id being answered. This is not the
	/// durable workflow gate id.
	pub id:               String,
	/// JSON-encoded `ReplyAnswer` (number, string, or `{selected,custom}`).
	pub answer_json:      String,
	/// Optional idempotency key supplied by the client.
	pub idempotency_key:  Option<String>,
	/// One-shot receipt binding this callback to the atomically claimed reply.
	pub reply_receipt_id: String,
}

/// Opaque in-process presentation capability.
///
/// Returned by [`NotificationServer::register_arbitrated_ask`]. Pass it
/// unchanged to [`NotificationServer::retire_if_unclaimed`]; do not construct,
/// persist, inspect, or treat it as workflow-gate authority.
#[napi(object)]
pub struct PresentationLease {
	pub action_id:          String,
	pub registration_epoch: i64,
}

/// Public status of exact direct retirement. Claims and receipts remain native.
#[napi(object)]
pub struct RetireIfUnclaimedResult {
	#[napi(ts_type = "'retired' | 'already_terminal' | 'claimed' | 'stale'")]
	pub status: String,
}

/// Typed terminal acknowledgement result returned by acknowledgement promises.
#[napi(object)]
pub struct AskSelectedAckOutcomeEvent {
	pub status:     String,
	pub message_id: Option<i64>,
	pub reason:     Option<String>,
}

impl From<gjc_sdk::protocol::AskSelectedAckOutcome> for AskSelectedAckOutcomeEvent {
	fn from(outcome: gjc_sdk::protocol::AskSelectedAckOutcome) -> Self {
		use gjc_sdk::protocol::AskSelectedAckOutcome;
		match outcome {
			AskSelectedAckOutcome::Delivered { message_id } => Self {
				status:     "delivered".to_owned(),
				message_id: Some(message_id),
				reason:     None,
			},
			AskSelectedAckOutcome::Failed { reason } => Self {
				status:     "failed".to_owned(),
				message_id: None,
				reason:     Some(
					serde_json::to_value(reason)
						.expect("ack reason serializes")
						.as_str()
						.unwrap_or_default()
						.to_owned(),
				),
			},
			AskSelectedAckOutcome::Unknown { reason } => Self {
				status:     "unknown".to_owned(),
				message_id: None,
				reason:     Some(
					serde_json::to_value(reason)
						.expect("ack reason serializes")
						.as_str()
						.unwrap_or_default()
						.to_owned(),
				),
			},
		}
	}
}

/// An authenticated inbound message forwarded to the TypeScript host: free-text
/// injection, ephemeral side-question request/cancel, in-thread config command,
/// or deterministic control command.
#[napi(object)]
pub struct InboundEvent {
	/// Inbound kind (`user_message`, `ephemeral_turn`,
	/// `ephemeral_turn_cancel`, `config_command`, or `control_command`).
	pub kind:          String,
	/// Server-authenticated identity of the WebSocket connection that delivered
	/// this event.
	pub connection_id: String,
	/// The session this inbound belongs to.
	pub session_id:    String,
	/// Free-text body (`user_message` or `ephemeral_turn` only).
	pub text:          Option<String>,
	/// Telegram update id for dedupe (`user_message`, `ephemeral_turn`, or
	/// `ephemeral_turn_cancel` only).
	pub update_id:     Option<i64>,
	/// Originating thread/topic id (`user_message`, `ephemeral_turn`, or
	/// `ephemeral_turn_cancel` only).
	pub thread_id:     Option<String>,
	/// Originating Telegram message id (`ephemeral_turn` and
	/// `ephemeral_turn_cancel` only).
	pub message_id:    Option<i64>,
	/// Requested verbosity `"lean"|"verbose"` (`config_command` only).
	pub verbosity:     Option<String>,
	/// Requested redaction state (`config_command` only).
	pub redact:        Option<bool>,
	/// Client-generated request id (`ephemeral_turn`, `ephemeral_turn_cancel`,
	/// or `control_command` only).
	pub request_id:    Option<String>,
	/// Cancellation reason (`ephemeral_turn_cancel` only).
	pub reason:        Option<String>,
	/// JSON-encoded command payload (`control_command` only).
	pub command_json:  Option<String>,
	/// Inline image attachments forwarded with the message (`user_message`
	/// only).
	pub images:        Option<Vec<InboundImageEvent>>,
}

/// One inline image attachment forwarded with an inbound user message.
#[napi(object)]
pub struct InboundImageEvent {
	/// Base64-encoded image bytes.
	pub data: String,
	/// MIME type when known (e.g. "image/jpeg").
	pub mime: Option<String>,
}

/// A raw v3 SDK frame paired with its actual WebSocket connection id.
#[napi(object)]
pub struct SdkFrameEvent {
	pub connection_id: String,
	pub json:          String,
}

/// Callback delivering a connection's negotiated v3 capabilities
/// (`connection_id`, `capabilities`) to TypeScript. Aliased to keep the
/// `ThreadsafeFunction` payload out of complex nested type positions
/// (`clippy::type_complexity`).
type NegotiatedCapabilitiesFn = ThreadsafeFunction<(String, Vec<String>)>;

/// In-process notification server handle exposed to TypeScript.
#[napi]
pub struct NotificationServer {
	config: Mutex<Option<ServerConfig>>,
	handle: Mutex<Option<ServerHandle>>,
	/// The one current presentation that may be retired only by its exact lease.
	/// This is private routing state, never workflow-gate authority.
	arbitrated_presentation: Mutex<Option<ActionIdentity>>,
	on_reply: Mutex<Option<ThreadsafeFunction<ReplyEvent>>>,
	on_inbound: Mutex<Option<ThreadsafeFunction<InboundEvent>>>,
	on_frame: Mutex<Option<ThreadsafeFunction<SdkFrameEvent>>>,
	on_negotiated_capabilities: Mutex<Option<NegotiatedCapabilitiesFn>>,
	on_connection_close: Mutex<Option<ThreadsafeFunction<String>>>,
	pump_tasks: Mutex<Vec<tokio::task::JoinHandle<()>>>,
	stop_wait: tokio::sync::Mutex<()>,
	known_good_turn_stream_frames: AtomicU64,
	turn_stream_serde_validation_parses: AtomicU64,
	file_attachment_base64_chars: AtomicU64,
}

/// Observable counters for the internal known-good N-API frame lane.
#[napi(object)]
pub struct KnownGoodFrameStats {
	/// Frames constructed as `TurnStream` without parsing a JSON string.
	pub known_good_turn_stream_frames:       f64,
	/// JSON serde parses of externally supplied `turn_stream` frames.
	pub turn_stream_serde_validation_parses: f64,
	/// Base64 characters encoded in Rust for `file_attachment` frames (the JS
	/// side crosses raw `Buffer` bytes and never allocates the base64 string).
	pub file_attachment_rust_base64_chars:   f64,
}

#[napi]
impl NotificationServer {
	/// Create a server for `session_id` authenticated by `token`.
	///
	/// `state_root` (when given) is where the endpoint discovery file is written
	/// (e.g. `<repo>/.gjc/state`). `resolver_available` defaults to `true`.
	#[napi(constructor)]
	#[must_use]
	pub fn new(
		session_id: String,
		token: String,
		state_root: Option<String>,
		resolver_available: Option<bool>,
	) -> Self {
		let mut config = ServerConfig::new(session_id, token);
		config.state_root = state_root.map(PathBuf::from);
		config.resolver_available = resolver_available.unwrap_or(true);
		// TS always owns gate resolution, so the core forwards replies.
		config.forward_replies = true;
		Self {
			config: Mutex::new(Some(config)),
			handle: Mutex::new(None),
			arbitrated_presentation: Mutex::new(None),
			on_reply: Mutex::new(None),
			on_inbound: Mutex::new(None),
			on_frame: Mutex::new(None),
			on_negotiated_capabilities: Mutex::new(None),
			on_connection_close: Mutex::new(None),
			pump_tasks: Mutex::new(Vec::new()),
			stop_wait: tokio::sync::Mutex::new(()),
			known_good_turn_stream_frames: AtomicU64::new(0),
			turn_stream_serde_validation_parses: AtomicU64::new(0),
			file_attachment_base64_chars: AtomicU64::new(0),
		}
	}

	/// Register the reply callback. Must be called before [`Self::start`].
	#[napi(ts_args_type = "callback: (err: null | Error, reply: ReplyEvent) => void")]
	pub fn on_reply(&self, callback: ThreadsafeFunction<ReplyEvent>) {
		*self.on_reply.lock() = Some(callback);
	}

	/// Register the authenticated inbound-message callback (free-text,
	/// side-question request/cancel, and in-thread config/control commands).
	/// Must be called before [`Self::start`].
	#[napi(ts_args_type = "callback: (err: null | Error, msg: InboundEvent) => void")]
	pub fn on_inbound(&self, callback: ThreadsafeFunction<InboundEvent>) {
		*self.on_inbound.lock() = Some(callback);
	}

	/// Register the raw v3 SDK frame callback. Must be called before
	/// [`Self::start`].
	#[napi(ts_args_type = "callback: (err: null | Error, frame: SdkFrameEvent) => void")]
	pub fn on_sdk_frame(&self, callback: ThreadsafeFunction<SdkFrameEvent>) {
		*self.on_frame.lock() = Some(callback);
	}

	/// Register the negotiated-capabilities callback. Must be called before
	/// [`Self::start`].
	#[napi(ts_args_type = "callback: (err: null | Error, connectionId: string, capabilities: \
	                       string[]) => void")]
	pub fn on_negotiated_capabilities(&self, callback: NegotiatedCapabilitiesFn) {
		*self.on_negotiated_capabilities.lock() = Some(callback);
	}

	/// Register the connection-close callback. Must be called before
	/// [`Self::start`].
	#[napi(ts_args_type = "callback: (err: null | Error, connectionId: string) => void")]
	pub fn on_connection_close(&self, callback: ThreadsafeFunction<String>) {
		*self.on_connection_close.lock() = Some(callback);
	}

	/// Bind the loopback endpoint and start serving. Resolves with the bound
	/// endpoint info once the socket is bound.
	///
	/// # Errors
	/// Fails if already started or the loopback socket cannot be bound.
	#[napi]
	pub async fn start(&self) -> Result<NotificationEndpoint> {
		let mut config = self
			.config
			.lock()
			.take()
			.ok_or_else(|| Error::from_reason("notification server already started"))?;
		if self.on_reply.lock().is_none() {
			config.resolver_available = false;
		}
		let session_id = config.session_id.clone();
		let handle = gjc_sdk::start(config)
			.await
			.map_err(|e| Error::from_reason(format!("bind failed: {e}")))?;

		let endpoint = NotificationEndpoint {
			host: handle.addr().ip().to_string(),
			port: u32::from(handle.addr().port()),
			url: handle.url(),
			session_id,
		};

		// Pump forwarded replies to the TS callback (we are inside the runtime).
		let reply_tsfn = self.on_reply.lock().take();
		if let Some(tsfn) = reply_tsfn {
			let mut rx = handle
				.take_reply_receiver()
				.ok_or_else(|| Error::from_reason("notification reply receiver unavailable"))?;
			let task = napi::tokio::spawn(async move {
				while let Some(reply) = rx.recv().await {
					let event = ReplyEvent {
						id:               reply.reply.id,
						answer_json:      serde_json::to_string(&reply.reply.answer)
							.unwrap_or_else(|_| "null".to_owned()),
						idempotency_key:  reply.reply.idempotency_key,
						reply_receipt_id: reply.reply_receipt_id,
					};
					tsfn.call(Ok(event), ThreadsafeFunctionCallMode::NonBlocking);
				}
			});
			self.pump_tasks.lock().push(task);
		}

		// Pump forwarded inbound messages (injections / config commands) to TS.
		let inbound_tsfn = self.on_inbound.lock().take();
		let inbound_rx = handle.take_inbound_receiver();
		if let (Some(tsfn), Some(mut rx)) = (inbound_tsfn, inbound_rx) {
			let task = napi::tokio::spawn(async move {
				while let Some(gjc_sdk::server::InboundMessage { connection_id, message: msg }) =
					rx.recv().await
				{
					let event = match msg {
						ClientMessage::UserMessage(u) => InboundEvent {
							connection_id,
							kind: "user_message".to_owned(),
							session_id: u.session_id,
							text: Some(u.text),
							update_id: u.update_id,
							thread_id: u.thread_id,
							message_id: None,
							reason: None,
							images: if u.images.is_empty() {
								None
							} else {
								Some(
									u.images
										.into_iter()
										.map(|i| InboundImageEvent { data: i.data, mime: i.mime })
										.collect(),
								)
							},
							verbosity: None,
							redact: None,
							request_id: None,
							command_json: None,
						},
						ClientMessage::EphemeralTurn(turn) => ephemeral_turn_event(connection_id, turn),
						ClientMessage::EphemeralTurnCancel(cancel) => {
							ephemeral_turn_cancel_event(connection_id, cancel)
						},
						ClientMessage::ConfigCommand(c) => InboundEvent {
							connection_id,
							kind: "config_command".to_owned(),
							session_id: c.session_id,
							text: None,
							update_id: None,
							thread_id: None,
							message_id: None,
							reason: None,
							verbosity: c.verbosity.map(|v| match v {
								Verbosity::Lean => "lean".to_owned(),
								Verbosity::Verbose => "verbose".to_owned(),
							}),
							redact: c.redact,
							request_id: None,
							command_json: None,
							images: None,
						},
						ClientMessage::ControlCommand(c) => InboundEvent {
							connection_id,
							kind: "control_command".to_owned(),
							session_id: c.session_id,
							text: None,
							update_id: c.update_id,
							thread_id: c.thread_id,
							message_id: None,
							reason: None,
							verbosity: None,
							redact: None,
							request_id: Some(c.request_id),
							command_json: Some(
								serde_json::to_string(&c.command).unwrap_or_else(|_| "null".to_owned()),
							),
							images: None,
						},
						_ => continue,
					};
					tsfn.call(Ok(event), ThreadsafeFunctionCallMode::NonBlocking);
				}
			});
			self.pump_tasks.lock().push(task);
		}

		let frame_tsfn = self.on_frame.lock().take();
		let frame_rx = handle.take_frame_receiver();
		if let (Some(tsfn), Some(mut rx)) = (frame_tsfn, frame_rx) {
			let task = napi::tokio::spawn(async move {
				while let Some((connection_id, json)) = rx.recv().await {
					tsfn.call(
						Ok(SdkFrameEvent { connection_id, json }),
						ThreadsafeFunctionCallMode::NonBlocking,
					);
				}
			});
			self.pump_tasks.lock().push(task);
		}

		let capability_tsfn = self.on_negotiated_capabilities.lock().take();
		let capability_rx = handle.take_capability_receiver();
		if let (Some(tsfn), Some(mut rx)) = (capability_tsfn, capability_rx) {
			napi::tokio::spawn(async move {
				while let Some(update) = rx.recv().await {
					tsfn.call(
						Ok((update.connection_id, update.capabilities)),
						ThreadsafeFunctionCallMode::NonBlocking,
					);
				}
			});
		}

		let close_tsfn = self.on_connection_close.lock().take();
		let close_rx = handle.take_close_receiver();
		if let (Some(tsfn), Some(mut rx)) = (close_tsfn, close_rx) {
			let task = napi::tokio::spawn(async move {
				while let Some(connection_id) = rx.recv().await {
					tsfn.call(Ok(connection_id), ThreadsafeFunctionCallMode::NonBlocking);
				}
			});
			self.pump_tasks.lock().push(task);
		}

		*self.handle.lock() = Some(handle);
		Ok(endpoint)
	}

	/// Broadcast an `action_needed` ask. `needed_json` is a JSON `ActionNeeded`.
	///
	/// `repliable` should be `true` only when an SDK workflow-gate resolver is
	/// available.
	///
	/// # Errors
	/// Fails if not started or `needed_json` is invalid.
	#[napi]
	pub fn register_ask(&self, needed_json: String, repliable: bool) -> Result<()> {
		let needed = parse_needed(&needed_json)?;
		let handle = self.handle()?;
		ensure_not_current_arbitrated_presentation(
			self.arbitrated_presentation.lock().as_ref(),
			handle.current_identity().as_ref(),
			"registerAsk",
		)?;
		handle
			.try_register_ask(needed, repliable)
			.map_err(|error| Error::from_reason(error.to_string()))?;
		Ok(())
	}

	/// Register a correlated workflow-gate ask. `workflow_json` must be an
	/// `action_needed` wire frame carrying a nonempty `workflowGateId`.
	#[napi]
	pub fn register_workflow_gate_ask(&self, workflow_json: String, repliable: bool) -> Result<()> {
		let workflow = decode_workflow_gate_action_needed(&workflow_json)
			.map_err(|e| Error::from_reason(format!("invalid correlated ActionNeeded: {e}")))?
			.ok_or_else(|| Error::from_reason("workflowGateId is required and must be nonempty"))?;
		let handle = self.handle()?;
		ensure_not_current_arbitrated_presentation(
			self.arbitrated_presentation.lock().as_ref(),
			handle.current_identity().as_ref(),
			"registerWorkflowGateAsk",
		)?;
		handle
			.register_workflow_gate_ask(workflow.action, workflow.workflow_gate_id, repliable)
			.map_err(|error| Error::from_reason(error.to_string()))?;
		Ok(())
	}

	/// Register an ask and return an opaque in-process capability. Pass it
	/// unchanged to [`Self::retire_if_unclaimed`]; do not construct, persist,
	/// inspect, or treat it as workflow-gate authority. A supplied
	/// `workflowGateId` is preserved.

	#[napi]
	pub fn register_arbitrated_ask(
		&self,
		needed_json: String,
		repliable: bool,
	) -> Result<PresentationLease> {
		let workflow = decode_workflow_gate_action_needed(&needed_json)
			.map_err(|e| Error::from_reason(format!("invalid arbitrated ActionNeeded: {e}")))?;
		let handle = self.handle()?;
		let mut arbitrated_presentation = self.arbitrated_presentation.lock();
		if is_current_arbitrated_presentation(
			arbitrated_presentation.as_ref(),
			handle.current_identity().as_ref(),
		) {
			return Err(Error::from_reason(
				"registerArbitratedAsk cannot supersede an active arbitrated presentation; use \
				 retireIfUnclaimed with its exact lease",
			));
		}
		if let Some(workflow) = workflow {
			handle
				.register_workflow_gate_ask(workflow.action, workflow.workflow_gate_id, repliable)
				.map_err(|error| Error::from_reason(error.to_string()))?;
		} else {
			handle
				.try_register_ask(parse_needed(&needed_json)?, repliable)
				.map_err(|error| Error::from_reason(error.to_string()))?;
		}
		let identity = handle.current_identity();
		let lease = presentation_lease(identity.clone())?;
		*arbitrated_presentation = identity;
		Ok(lease)
	}

	/// Atomically terminalize the exact presentation named by an opaque lease.
	/// The typed status proves whether it retired, was already terminal, was
	/// claimed, or became stale without exposing claims, receipts, registration
	/// state, or workflow-gate authority.
	#[napi]
	pub fn retire_if_unclaimed(&self, lease: PresentationLease) -> Result<RetireIfUnclaimedResult> {
		let epoch = u64::try_from(lease.registration_epoch)
			.map_err(|_| Error::from_reason("registrationEpoch must be nonnegative"))?;
		let identity = ActionIdentity { id: lease.action_id, epoch };
		let mut arbitrated_presentation = self.arbitrated_presentation.lock();
		if arbitrated_presentation.as_ref() != Some(&identity) {
			return Ok(RetireIfUnclaimedResult { status: "stale".to_owned() });
		}
		let outcome = self.with_handle(|h| h.terminalize_if_current(&identity))?;
		let status = match &outcome {
			RetireIfUnclaimed::Retired(_) => "retired",
			RetireIfUnclaimed::AlreadyTerminal => "already_terminal",
			RetireIfUnclaimed::Claimed => "claimed",
			RetireIfUnclaimed::Stale => "stale",
		};
		if matches!(outcome, RetireIfUnclaimed::Retired(_) | RetireIfUnclaimed::AlreadyTerminal) {
			*arbitrated_presentation = None;
		}
		Ok(RetireIfUnclaimedResult { status: status.to_owned() })
	}

	/// Broadcast an ephemeral `action_needed` idle ping. `needed_json` is JSON
	/// `ActionNeeded`.
	///
	/// # Errors
	/// Fails if not started or `needed_json` is invalid.
	#[napi]
	pub fn note_idle(&self, needed_json: String) -> Result<()> {
		let needed = parse_needed(&needed_json)?;
		self.with_handle(|h| h.note_idle(needed))
	}

	/// Broadcast an ephemeral threaded-session frame. `frame_json` is a JSON
	/// `ServerMessage` (e.g. `identity_header`, `context_update`, `turn_stream`,
	/// `ephemeral_turn_result`, `image_attachment`, `session_closed`,
	/// `config_update`, `hello`). Not buffered for replay.
	///
	/// # Errors
	/// Fails if not started or `frame_json` is not a valid `ServerMessage`.
	#[napi]
	pub fn push_frame(&self, frame_json: String) -> Result<()> {
		// `ActionNeeded` is rejected at runtime here (see `ServerHandle::push_frame`);
		// action delivery must go through `register_ask`/`note_idle` so it stays
		// capability-gated per connection. Kept as an in-body note so the generated
		// N-API `index.d.ts` signature/docs remain byte-stable for issue #2029.
		let msg: ServerMessage = serde_json::from_str(&frame_json)
			.map_err(|e| Error::from_reason(format!("invalid frame json: {e}")))?;
		if matches!(msg, ServerMessage::TurnStream(_)) {
			saturating_increment(&self.turn_stream_serde_validation_parses);
		}
		self
			.with_handle(|h| h.push_frame(msg))?
			.map_err(|error| Error::from_reason(error.to_string()))
	}

	/// Deliver a frame through every authenticated connection and wait for each
	/// socket writer to settle within `timeout_ms`.
	#[napi]
	pub async fn push_frame_and_wait(&self, frame_json: String, timeout_ms: u32) -> Result<bool> {
		let msg: ServerMessage = serde_json::from_str(&frame_json)
			.map_err(|e| Error::from_reason(format!("invalid frame json: {e}")))?;
		if matches!(msg, ServerMessage::TurnStream(_)) {
			saturating_increment(&self.turn_stream_serde_validation_parses);
		}
		let handle = self.with_handle(Clone::clone)?;
		handle
			.push_frame_and_wait(msg, Duration::from_millis(u64::from(timeout_ms)))
			.await
			.map_err(|error| Error::from_reason(error.to_string()))
	}

	/// Broadcast a TypeScript-constructed turn frame without re-parsing JSON.
	/// External frames must continue through [`Self::push_frame`] for serde
	/// validation.
	#[napi]
	pub fn push_turn_stream_unchecked(
		&self,
		session_id: String,
		phase: String,
		text: String,
		final_answer: Option<bool>,
		message_ref: Option<String>,
	) -> Result<()> {
		let phase = match phase.as_str() {
			"live" => TurnPhase::Live,
			"finalized" => TurnPhase::Finalized,
			_ => return Err(Error::from_reason("invalid turn stream phase")),
		};
		saturating_increment(&self.known_good_turn_stream_frames);
		self
			.with_handle(|h| {
				h.push_frame(ServerMessage::TurnStream(TurnStream {
					session_id,
					phase,
					text,
					final_answer,
					message_ref,
				}))
			})?
			.map_err(|error| Error::from_reason(error.to_string()))
	}

	/// Broadcast a file attachment from raw N-API bytes, encoding the unchanged
	/// base64 wire field only in Rust.
	#[napi]
	pub fn push_file_attachment_unchecked(
		&self,
		session_id: String,
		name: String,
		mime: Option<String>,
		data: Buffer,
		caption: Option<String>,
	) -> Result<()> {
		self
			.with_handle(|h| {
				h.push_frame(ServerMessage::FileAttachment(FileAttachment {
					session_id,
					name,
					mime,
					data: encode_base64(&data, &self.file_attachment_base64_chars),
					caption,
				}))
			})?
			.map_err(|error| Error::from_reason(error.to_string()))
	}

	/// Return counters guarding the known-good frame crossing against
	/// regressions.
	#[napi]
	#[must_use]
	pub fn known_good_frame_stats(&self) -> KnownGoodFrameStats {
		let known_good_turn_stream_frames =
			self.known_good_turn_stream_frames.load(Ordering::Relaxed);
		let turn_stream_serde_validation_parses = self
			.turn_stream_serde_validation_parses
			.load(Ordering::Relaxed);
		let file_attachment_rust_base64_chars =
			self.file_attachment_base64_chars.load(Ordering::Relaxed);
		KnownGoodFrameStats {
			known_good_turn_stream_frames:       known_good_turn_stream_frames as f64,
			turn_stream_serde_validation_parses: turn_stream_serde_validation_parses as f64,
			file_attachment_rust_base64_chars:   file_attachment_rust_base64_chars as f64,
		}
	}

	/// Send a validated, bounded JSON envelope to one connected v3 SDK client.
	#[napi]
	pub fn send_to(&self, connection_id: String, json: String) -> Result<()> {
		let handle = self.handle()?;
		if handle.send_to(&connection_id, json) {
			Ok(())
		} else {
			Err(Error::from_reason(
				"SDK connection is unavailable or directed frame is invalid, oversized, or \
				 unauthorized",
			))
		}
	}

	/// Publish a replayable `session_ready` readiness signal. `ready_json` is a
	/// JSON `SessionReady`. Unlike [`Self::push_frame`], this frame is buffered
	/// and replayed to late-connecting clients, so a lifecycle control client
	/// can wait for readiness deterministically instead of treating WS-open as
	/// readiness.
	///
	/// # Errors
	/// Fails if not started or `ready_json` is not a valid `SessionReady`.
	#[napi]
	pub fn push_session_ready(&self, ready_json: String) -> Result<()> {
		let ready: SessionReady = serde_json::from_str(&ready_json)
			.map_err(|e| Error::from_reason(format!("invalid SessionReady json: {e}")))?;
		self.with_handle(|h| h.push_session_ready(ready))
	}

	/// Resolve a legacy/non-arbitrated action locally (the CLI/TUI answered).
	/// Arbitrated presentations require their opaque exact lease to be passed to
	/// [`Self::retire_if_unclaimed`], so an id-only local resolution fails
	/// closed.
	#[napi]
	pub fn resolve_local(&self, id: String, answer_json: Option<String>) -> Result<()> {
		let answer = parse_answer(answer_json.as_deref())?;
		let handle = self.handle()?;
		ensure_not_current_arbitrated_presentation(
			self.arbitrated_presentation.lock().as_ref(),
			handle.current_identity().as_ref(),
			"resolveLocal",
		)?;
		handle.resolve_local(&id, answer);
		Ok(())
	}

	/// Resolve an unclaimed legacy action. Forward-mode replies are
	/// receipt-bound and must use `resolveClaim` instead.
	///
	/// # Errors
	/// Fails if not started, `answer_json` is invalid, or the action is claimed.
	#[napi]
	pub fn resolve_client(
		&self,
		id: String,
		answer_json: Option<String>,
		idempotency_key: Option<String>,
	) -> Result<()> {
		let answer = parse_answer(answer_json.as_deref())?;
		let handle = self.handle()?;
		ensure_not_current_arbitrated_presentation(
			self.arbitrated_presentation.lock().as_ref(),
			handle.current_identity().as_ref(),
			"resolveClient",
		)?;
		if !handle.resolve_client(&id, answer, idempotency_key) {
			return Err(Error::from_reason("claimed action requires resolveClaim with its receipt"));
		}
		Ok(())
	}

	/// Resolve a reply claim after durable semantic settlement.
	#[napi]
	pub fn resolve_claim(
		&self,
		reply_receipt_id: String,
		answer_json: Option<String>,
		idempotency_key: Option<String>,
	) -> Result<()> {
		let answer = parse_answer(answer_json.as_deref())?;
		if !self.with_handle(|h| h.resolve_claim(&reply_receipt_id, answer, idempotency_key))? {
			return Err(Error::from_reason("claim receipt did not match a pending reply"));
		}
		Ok(())
	}

	/// Close an invalid claim terminally. Retrying must use a fresh action id.
	#[napi]
	pub fn close_claim_invalid(&self, reply_receipt_id: String, _reason: String) -> Result<()> {
		if !self.with_handle(|h| h.close_claim_invalid(&reply_receipt_id))? {
			return Err(Error::from_reason("claim receipt did not match a pending reply"));
		}
		Ok(())
	}

	/// Cancel a claim as part of abort or shutdown cleanup.
	#[napi]
	pub fn cancel_claim(&self, reply_receipt_id: String, _reason: String) -> Result<()> {
		if !self.with_handle(|h| h.cancel_claim(&reply_receipt_id))? {
			return Err(Error::from_reason("claim receipt did not match a pending reply"));
		}
		Ok(())
	}

	/// Unicast an origin-bound live acknowledgement and resolve with its exact
	/// correlated terminal outcome (or native timeout evidence).
	#[napi]
	pub async fn request_ask_selected_ack(
		&self,
		reply_receipt_id: String,
		request_json: String,
	) -> Result<AskSelectedAckOutcomeEvent> {
		let request: gjc_sdk::protocol::AskSelectedAckRequest = serde_json::from_str(&request_json)
			.map_err(|e| {
			Error::from_reason(format!("invalid live acknowledgement request: {e}"))
		})?;
		if !matches!(request, gjc_sdk::protocol::AskSelectedAckRequest::Live { .. }) {
			return Err(Error::from_reason("requestAskSelectedAck requires mode=live"));
		}
		let handle = self.handle()?;
		Ok(handle
			.request_ask_selected_ack(&reply_receipt_id, request)
			.await
			.into())
	}

	/// Select one current capable participant for a recovery acknowledgement and
	/// resolve with its exact terminal outcome.
	#[napi]
	pub async fn request_recovered_ask_selected_ack(
		&self,
		request_json: String,
	) -> Result<AskSelectedAckOutcomeEvent> {
		let request: gjc_sdk::protocol::AskSelectedAckRequest = serde_json::from_str(&request_json)
			.map_err(|e| {
			Error::from_reason(format!("invalid recovery acknowledgement request: {e}"))
		})?;
		if !matches!(request, gjc_sdk::protocol::AskSelectedAckRequest::Recovery { .. }) {
			return Err(Error::from_reason("requestRecoveredAskSelectedAck requires mode=recovery"));
		}
		let handle = self.handle()?;
		Ok(handle
			.request_recovered_ask_selected_ack(request)
			.await
			.into())
	}

	/// Correlate and terminalize an acknowledgement request.
	#[napi]
	pub fn cancel_ask_selected_ack(
		&self,
		request_id: String,
		commit_key: String,
		reason: String,
	) -> Result<AskSelectedAckOutcomeEvent> {
		let reason = serde_json::from_value(serde_json::Value::String(reason)).map_err(|e| {
			Error::from_reason(format!("invalid acknowledgement cancellation reason: {e}"))
		})?;
		let cancel = gjc_sdk::protocol::AskSelectedAckCancel { request_id, commit_key, reason };
		let handle = self.handle()?;
		Ok(handle.cancel_ask_selected_ack(cancel).into())
	}

	/// Reject an unclaimed legacy reply. Claimed forward-mode replies must use
	/// `closeClaimInvalid` with the exact receipt.
	///
	/// # Errors
	/// Fails if not started or the action is claimed.
	#[napi]
	pub fn reject(&self, id: String, reason: Option<String>) -> Result<()> {
		let reason = parse_reason(reason.as_deref());
		if !self.with_handle(|h| h.reject(&id, reason))? {
			return Err(Error::from_reason(
				"claimed action requires closeClaimInvalid with its receipt",
			));
		}
		Ok(())
	}

	/// Update whether the SDK workflow-gate resolver is currently available.
	///
	/// # Errors
	/// Fails if not started.
	#[napi]
	pub fn set_resolver_available(&self, available: bool) -> Result<()> {
		self.with_handle(|h| h.set_resolver_available(available))
	}

	/// Number of currently connected clients.
	#[must_use]
	#[napi]
	pub fn client_count(&self) -> u32 {
		self
			.handle()
			.map_or(0, |handle| u32::try_from(handle.client_count()).unwrap_or(u32::MAX))
	}

	/// Stop the server (idempotent) and remove the endpoint discovery file.
	#[napi]
	pub fn stop(&self) {
		if let Ok(handle) = self.handle() {
			handle.stop();
		}
	}

	/// Stop the server and resolve only after all native socket owners exit.
	#[napi]
	pub async fn stop_and_wait(&self) -> Result<()> {
		let _stop = self.stop_wait.lock().await;
		let handle = self.handle.lock().take();
		if let Some(handle) = handle {
			handle.stop_and_wait().await;
			drop(handle);
		}
		let tasks = std::mem::take(&mut *self.pump_tasks.lock());
		for task in tasks {
			let _ = task.await;
		}
		Ok(())
	}

	fn with_handle<T, F: FnOnce(&ServerHandle) -> T>(&self, f: F) -> Result<T> {
		let handle = self.handle()?;
		Ok(f(&handle))
	}

	fn handle(&self) -> Result<ServerHandle> {
		// Host callbacks may synchronously reenter this object. Keep no native
		// mutex guard alive while invoking an operation that can trigger them.
		self
			.handle
			.lock()
			.as_ref()
			.cloned()
			.ok_or_else(|| Error::from_reason("notification server not started"))
	}
}

/// Bound endpoint info returned from [`NotificationControlServer::start`].
#[napi(object)]
pub struct ControlEndpoint {
	/// Bind host (loopback).
	pub host:     String,
	/// Bound port.
	pub port:     u32,
	/// `ws://host:port` URL.
	pub url:      String,
	/// The daemon owner id this control endpoint serves.
	pub owner_id: String,
}

/// A lifecycle request forwarded to the TypeScript daemon for orchestration.
#[napi(object)]
pub struct LifecycleRequestEvent {
	/// One of `"session_create"`, `"session_close"`, `"session_resume"`.
	pub kind:         String,
	/// The request correlation id to echo in the response.
	pub request_id:   String,
	/// JSON-encoded `LifecycleClientMessage` with the control `token` stripped.
	/// The ingress already authenticated the frame, so the secret is never
	/// forwarded into JS; all other (non-token) fields are preserved.
	pub payload_json: String,
}

/// In-process, session-independent lifecycle **control** server exposed to TS.
///
/// Transport-only: it authenticates (handshake + per-frame), forwards valid
/// lifecycle requests to the TS daemon, and routes TS-produced responses back
/// by request id. All policy/spawn/idempotency/rate-limit/audit lives in TS.
///
/// Call order: construct, [`Self::on_lifecycle_request`] (before start), then
/// [`Self::start`].
#[napi]
pub struct NotificationControlServer {
	config:     Mutex<Option<ControlServerConfig>>,
	handle:     Mutex<Option<ControlServerHandle>>,
	on_request: Mutex<Option<ThreadsafeFunction<LifecycleRequestEvent>>>,
}

#[napi]
impl NotificationControlServer {
	/// Create a control server authenticated by `token` and owned by `owner_id`.
	///
	/// `agent_dir` (when given) is where the control discovery file is written
	/// (e.g. the daemon agent dir).
	#[napi(constructor)]
	#[must_use]
	pub fn new(token: String, owner_id: String, agent_dir: Option<String>) -> Self {
		let mut config = ControlServerConfig::new(token, owner_id);
		config.agent_dir = agent_dir.map(PathBuf::from);
		Self {
			config:     Mutex::new(Some(config)),
			handle:     Mutex::new(None),
			on_request: Mutex::new(None),
		}
	}

	/// Register the lifecycle-request callback. Must be called before
	/// [`Self::start`].
	#[napi(ts_args_type = "callback: (err: null | Error, req: LifecycleRequestEvent) => void")]
	pub fn on_lifecycle_request(&self, callback: ThreadsafeFunction<LifecycleRequestEvent>) {
		*self.on_request.lock() = Some(callback);
	}

	/// Bind the loopback control endpoint and start serving. Resolves with the
	/// bound endpoint info once the socket is bound.
	///
	/// # Errors
	/// Fails if already started, a non-loopback bind is requested, or the socket
	/// cannot be bound.
	#[napi]
	pub async fn start(&self) -> Result<ControlEndpoint> {
		let config = self
			.config
			.lock()
			.take()
			.ok_or_else(|| Error::from_reason("control server already started"))?;
		let owner_id = config.owner_id.clone();
		let handle = start_control(config)
			.await
			.map_err(|e| Error::from_reason(format!("control bind failed: {e}")))?;

		let endpoint = ControlEndpoint {
			host: handle.addr().ip().to_string(),
			port: u32::from(handle.addr().port()),
			url: handle.url(),
			owner_id,
		};

		// Pump forwarded lifecycle requests to the TS daemon callback.
		let tsfn = self.on_request.lock().take();
		let req_rx = handle.take_lifecycle_receiver();
		if let (Some(tsfn), Some(mut rx)) = (tsfn, req_rx) {
			napi::tokio::spawn(async move {
				while let Some(msg) = rx.recv().await {
					let kind = match &msg {
						LifecycleClientMessage::SessionCreate(_) => "session_create",
						LifecycleClientMessage::SessionClose(_) => "session_close",
						LifecycleClientMessage::SessionResume(_) => "session_resume",
						LifecycleClientMessage::Unknown => continue,
					};
					let request_id = msg.request_id().unwrap_or("").to_owned();
					// The control token is authenticated at the ingress; never
					// forward the raw secret into the JS layer (no-token-leak).
					let payload_json = redact_lifecycle_token(&msg);
					let event =
						LifecycleRequestEvent { kind: kind.to_owned(), request_id, payload_json };
					tsfn.call(Ok(event), ThreadsafeFunctionCallMode::NonBlocking);
				}
			});
		}

		*self.handle.lock() = Some(handle);
		Ok(endpoint)
	}

	/// Send a host-produced lifecycle response, routed back to the originating
	/// client by request id. `response_json` is a JSON `LifecycleServerMessage`.
	///
	/// # Errors
	/// Fails if not started or `response_json` is not a valid
	/// `LifecycleServerMessage`.
	#[napi]
	pub fn respond(&self, response_json: String) -> Result<()> {
		let msg: LifecycleServerMessage = serde_json::from_str(&response_json)
			.map_err(|e| Error::from_reason(format!("invalid lifecycle response json: {e}")))?;
		let guard = self.handle.lock();
		let handle = guard
			.as_ref()
			.ok_or_else(|| Error::from_reason("control server not started"))?;
		handle.respond(msg);
		Ok(())
	}

	/// Number of currently connected control clients.
	#[must_use]
	#[napi]
	pub fn client_count(&self) -> u32 {
		self
			.handle
			.lock()
			.as_ref()
			.map_or(0, |h| u32::try_from(h.client_count()).unwrap_or(u32::MAX))
	}

	/// Stop the control server (idempotent) and remove the control discovery
	/// file.
	#[napi]
	pub fn stop(&self) {
		if let Some(handle) = self.handle.lock().as_ref() {
			handle.stop();
		}
	}
}

fn ephemeral_turn_event(
	connection_id: String,
	turn: gjc_sdk::protocol::EphemeralTurn,
) -> InboundEvent {
	InboundEvent {
		connection_id,
		kind: "ephemeral_turn".to_owned(),
		session_id: turn.session_id,
		text: Some(turn.question),
		update_id: Some(turn.update_id),
		thread_id: Some(turn.thread_id),
		message_id: Some(turn.message_id),
		verbosity: None,
		redact: None,
		request_id: Some(turn.request_id),
		reason: None,
		command_json: None,
		images: None,
	}
}

fn ephemeral_turn_cancel_event(
	connection_id: String,
	cancel: gjc_sdk::protocol::EphemeralTurnCancel,
) -> InboundEvent {
	InboundEvent {
		connection_id,
		kind: "ephemeral_turn_cancel".to_owned(),
		session_id: cancel.session_id,
		text: None,
		update_id: Some(cancel.update_id),
		thread_id: Some(cancel.thread_id),
		message_id: Some(cancel.message_id),
		verbosity: None,
		redact: None,
		request_id: Some(cancel.request_id),
		reason: Some("daemon_shutdown".to_owned()),
		command_json: None,
		images: None,
	}
}
fn presentation_lease(identity: Option<ActionIdentity>) -> Result<PresentationLease> {
	let identity =
		identity.ok_or_else(|| Error::from_reason("action registration did not produce a lease"))?;
	let registration_epoch = i64::try_from(identity.epoch).map_err(|_| {
		Error::from_reason("action registration epoch exceeds JavaScript integer range")
	})?;
	Ok(PresentationLease { action_id: identity.id, registration_epoch })
}

fn is_current_arbitrated_presentation(
	arbitrated: Option<&ActionIdentity>,
	current: Option<&ActionIdentity>,
) -> bool {
	matches!((arbitrated, current), (Some(arbitrated), Some(current)) if arbitrated == current)
}

fn ensure_not_current_arbitrated_presentation(
	arbitrated: Option<&ActionIdentity>,
	current: Option<&ActionIdentity>,
	method: &str,
) -> Result<()> {
	if is_current_arbitrated_presentation(arbitrated, current) {
		return Err(Error::from_reason(format!(
			"{method} is unsafe for an arbitrated presentation; use retireIfUnclaimed with its exact \
			 lease"
		)));
	}
	Ok(())
}

#[cfg(test)]
mod tests {
	use super::{
		ActionIdentity, PresentationLease, ensure_not_current_arbitrated_presentation, parse_needed,
	};

	#[test]
	fn ephemeral_turn_mapping_preserves_question_and_tuple_without_token() {
		let event =
			super::ephemeral_turn_event("connection-1".to_owned(), gjc_sdk::protocol::EphemeralTurn {
				session_id: "session".to_owned(),
				token:      "secret".to_owned(),
				request_id: "btw:123e4567-e89b-42d3-a456-426614174000".to_owned(),
				update_id:  7,
				message_id: 9,
				thread_id:  "11".to_owned(),
				question:   "What changed?".to_owned(),
			});
		assert_eq!(event.connection_id, "connection-1");
		assert_eq!(event.kind, "ephemeral_turn");
		assert_eq!(event.session_id, "session");
		assert_eq!(event.text.as_deref(), Some("What changed?"));
		assert_eq!(event.request_id.as_deref(), Some("btw:123e4567-e89b-42d3-a456-426614174000"));
		assert_eq!(event.update_id, Some(7));
		assert_eq!(event.message_id, Some(9));
		assert_eq!(event.thread_id.as_deref(), Some("11"));
		assert_eq!(event.reason, None);
		assert_eq!(event.command_json, None);
		assert!(event.images.is_none());
	}
	#[test]
	fn ephemeral_turn_cancel_mapping_preserves_tuple_without_token_or_question() {
		let event = super::ephemeral_turn_cancel_event(
			"connection-2".to_owned(),
			gjc_sdk::protocol::EphemeralTurnCancel {
				session_id: "session".to_owned(),
				token:      "secret".to_owned(),
				request_id: "btw:123e4567-e89b-42d3-a456-426614174000".to_owned(),
				update_id:  7,
				message_id: 9,
				thread_id:  "11".to_owned(),
				reason:     gjc_sdk::protocol::EphemeralTurnCancelReason::DaemonShutdown,
			},
		);
		assert_eq!(event.connection_id, "connection-2");
		assert_eq!(event.kind, "ephemeral_turn_cancel");
		assert_eq!(event.session_id, "session");
		assert_eq!(event.request_id.as_deref(), Some("btw:123e4567-e89b-42d3-a456-426614174000"));
		assert_eq!(event.update_id, Some(7));
		assert_eq!(event.message_id, Some(9));
		assert_eq!(event.thread_id.as_deref(), Some("11"));
		assert_eq!(event.reason.as_deref(), Some("daemon_shutdown"));
		assert_eq!(event.text, None);
	}

	#[test]
	fn exact_arbitrated_presentation_blocks_local_and_client_id_only_resolution() {
		let arbitrated = ActionIdentity { id: "presentation".to_owned(), epoch: 2 };
		for method in ["resolveLocal", "resolveClient"] {
			let error = ensure_not_current_arbitrated_presentation(
				Some(&arbitrated),
				Some(&arbitrated),
				method,
			)
			.expect_err("exact arbitrated presentation must reject id-only resolution");
			assert!(error.reason.contains(method));
		}
	}
	#[test]
	fn register_ask_input_preserves_recommended_index_and_legacy_omission() {
		let needed = parse_needed(
			r#"{"id":"a1","kind":"ask","sessionId":"session","options":["Yes","No"],"recommendedIndex":4294967295}"#,
		)
		.expect("valid N-API registerAsk input");
		assert_eq!(needed.recommended_index, Some(u32::MAX));
		let roundtrip = serde_json::to_string(&needed).unwrap();
		assert!(roundtrip.contains(r#""recommendedIndex":4294967295"#));
		assert_eq!(parse_needed(&roundtrip).unwrap().recommended_index, Some(u32::MAX));

		let legacy =
			parse_needed(r#"{"id":"legacy","kind":"ask","sessionId":"session","options":["Yes"]}"#)
				.expect("legacy N-API registerAsk input");
		assert_eq!(legacy.recommended_index, None);
		assert!(
			!serde_json::to_string(&legacy)
				.unwrap()
				.contains("recommendedIndex")
		);
	}

	#[test]
	fn register_ask_input_drops_malformed_recommended_index_but_rejects_required_field_failure() {
		for malformed in ["null", "1.5", "-1", r#""1""#, "true", "[]", "{}", "4294967296"] {
			let input = format!(
				r#"{{"id":"a1","kind":"ask","sessionId":"session","options":["Yes"],"recommendedIndex":{malformed}}}"#
			);
			assert_eq!(parse_needed(&input).unwrap().recommended_index, None, "{malformed}");
		}
		assert!(parse_needed(r#"{"kind":"ask","sessionId":"session"}"#).is_err());
	}

	#[test]
	fn stale_or_missing_arbitrated_presentation_does_not_block_legacy_resolution() {
		let arbitrated = ActionIdentity { id: "presentation".to_owned(), epoch: 2 };
		assert!(
			ensure_not_current_arbitrated_presentation(
				Some(&arbitrated),
				Some(&ActionIdentity { id: "presentation".to_owned(), epoch: 3 }),
				"resolveClient",
			)
			.is_ok()
		);
		assert!(
			ensure_not_current_arbitrated_presentation(Some(&arbitrated), None, "resolveLocal")
				.is_ok()
		);
	}

	#[tokio::test]
	async fn active_arbitrated_lease_rejects_legacy_replacement_without_clearing_the_fence() {
		let server =
			super::NotificationServer::new("session".to_owned(), "token".to_owned(), None, Some(true));
		server.start().await.expect("server starts");
		let arbitrated = r#"{"id":"presentation","kind":"ask","sessionId":"session","question":"question","controls":[]}"#;
		let lease = server
			.register_arbitrated_ask(arbitrated.to_owned(), true)
			.expect("initial arbitrated registration succeeds");

		let superseding = r#"{"id":"superseding","kind":"ask","sessionId":"session","question":"question","controls":[]}"#;
		let error = match server.register_arbitrated_ask(superseding.to_owned(), true) {
			Ok(_) => panic!("a distinct arbitrated registration cannot supersede an active lease"),
			Err(error) => error,
		};
		assert!(error.reason.contains("registerArbitratedAsk"));
		assert_eq!(
			server
				.retire_if_unclaimed(PresentationLease {
					action_id:          "presentation".to_owned(),
					registration_epoch: lease.registration_epoch + 1,
				})
				.expect("forged lease is rejected without touching the registry")
				.status,
			"stale"
		);
		assert!(
			server
				.resolve_client("presentation".to_owned(), None, None)
				.is_err(),
			"a forged lease cannot retire the active arbitrated presentation"
		);
		for (method, result) in [
			(
				"registerAsk",
				server.register_ask(
					r#"{"id":"legacy","kind":"ask","sessionId":"session","question":"question","controls":[]}"#.to_owned(),
					true,
				),
			),
			(
				"registerWorkflowGateAsk",
				server.register_workflow_gate_ask(
					r#"{"type":"action_needed","id":"legacy-workflow","kind":"ask","sessionId":"session","question":"question","controls":[],"workflowGateId":"gate"}"#.to_owned(),
					true,
				),
			),
		] {
			let error = result.expect_err("legacy registration cannot replace an active arbitrated lease");
			assert!(error.reason.contains(method));
		}
		assert!(
			server
				.resolve_client("presentation".to_owned(), None, None)
				.is_err(),
			"rejected legacy registrations preserve the arbitrated fence"
		);

		assert_eq!(
			server
				.retire_if_unclaimed(lease)
				.expect("exact lease retires")
				.status,
			"retired"
		);
		server
			.register_ask(
				r#"{"id":"legacy","kind":"ask","sessionId":"session","question":"question","controls":[]}"#.to_owned(),
				true,
			)
			.expect("legacy registration succeeds after the arbitrated lease is no longer active");
		assert!(
			server
				.resolve_client("legacy".to_owned(), None, None)
				.is_ok()
		);
		server.stop();
	}
}

fn parse_needed(json: &str) -> Result<ActionNeeded> {
	let value: serde_json::Value = serde_json::from_str(json)
		.map_err(|e| Error::from_reason(format!("invalid ActionNeeded: {e}")))?;
	if value.get("workflowGateId").is_some() {
		return Err(Error::from_reason(
			"registerAsk does not accept workflowGateId; use registerWorkflowGateAsk",
		));
	}
	serde_json::from_value(value)
		.map_err(|e| Error::from_reason(format!("invalid ActionNeeded: {e}")))
}

/// Serialize a lifecycle request for the JS callback with the raw control token
/// stripped. The ingress already authenticated the frame, so the secret must
/// never cross into the JS layer (or any logging there).
fn redact_lifecycle_token(msg: &LifecycleClientMessage) -> String {
	let Ok(mut value) = serde_json::to_value(msg) else {
		return "null".to_owned();
	};
	if let Some(obj) = value.as_object_mut() {
		obj.remove("token");
	}
	serde_json::to_string(&value).unwrap_or_else(|_| "null".to_owned())
}

fn parse_answer(json: Option<&str>) -> Result<Option<ReplyAnswer>> {
	match json {
		None => Ok(None),
		Some(s) => serde_json::from_str(s)
			.map(Some)
			.map_err(|e| Error::from_reason(format!("invalid ReplyAnswer: {e}"))),
	}
}

fn parse_reason(reason: Option<&str>) -> gjc_sdk::RejectReason {
	use gjc_sdk::RejectReason;
	match reason {
		Some("already_answered") => RejectReason::AlreadyAnswered,
		Some("unknown_action") => RejectReason::UnknownAction,
		Some("resolver_unavailable") => RejectReason::ResolverUnavailable,
		Some("idempotency_conflict") => RejectReason::IdempotencyConflict,
		Some("unauthorized") => RejectReason::Unauthorized,
		_ => RejectReason::InvalidAnswer,
	}
}

/// Encode bytes for the unchanged JSON WebSocket wire schema without allocating
/// a JavaScript base64 string at the N-API boundary.
fn encode_base64(bytes: &[u8], chars_counter: &AtomicU64) -> String {
	const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
	let mut encoded = String::with_capacity(bytes.len().div_ceil(3) * 4);
	for chunk in bytes.chunks(3) {
		let first = chunk[0];
		let second = *chunk.get(1).unwrap_or(&0);
		let third = *chunk.get(2).unwrap_or(&0);
		encoded.push(char::from(TABLE[usize::from(first >> 2)]));
		encoded.push(char::from(TABLE[usize::from((first & 0b0000_0011) << 4 | second >> 4)]));
		encoded.push(if chunk.len() > 1 {
			char::from(TABLE[usize::from((second & 0b0000_1111) << 2 | third >> 6)])
		} else {
			'='
		});
		encoded.push(if chunk.len() > 2 {
			char::from(TABLE[usize::from(third & 0b0011_1111)])
		} else {
			'='
		});
	}
	chars_counter.fetch_add(encoded.len() as u64, Ordering::Relaxed);
	encoded
}
