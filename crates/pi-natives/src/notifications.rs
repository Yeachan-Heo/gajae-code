//! N-API surface for the notifications SDK.
//!
//! Wraps [`gjc_notifications`] so the TypeScript extension can host a
//! per-session loopback WebSocket notification server in-process. The server
//! runs in **forward mode**: accepted client replies are handed back to
//! TypeScript (via the [`NotificationServer::on_reply`] callback) so TS
//! resolves the real GJC workflow gate, then calls
//! [`NotificationServer::resolve_client`] — guaranteeing `action_resolved` is
//! only broadcast after a genuine resolution.
//!
//! Call order: construct, [`NotificationServer::on_reply`] (optional), then
//! [`NotificationServer::start`]. `on_reply` must be registered before `start`.

use std::path::PathBuf;

use gjc_notifications::{
	ActionNeeded, ClientMessage, ReplyAnswer, ServerConfig, ServerHandle, ServerMessage, Verbosity,
};
use napi::{
	bindgen_prelude::*,
	threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode},
};
use napi_derive::napi;
use parking_lot::Mutex;

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
	/// The action id being answered (the real broker `gate_id` for asks).
	pub id:              String,
	/// JSON-encoded `ReplyAnswer` (number, string, or `{selected,custom}`).
	pub answer_json:     String,
	/// Optional idempotency key supplied by the client.
	pub idempotency_key: Option<String>,
}

/// An inbound message forwarded to the TypeScript host: a free-text injection
/// (`user_message`) or an in-thread config command (`config_command`).
#[napi(object)]
pub struct InboundEvent {
	/// Either `"user_message"` or `"config_command"`.
	pub kind:       String,
	/// The session this inbound belongs to.
	pub session_id: String,
	/// Free-text body (`user_message` only).
	pub text:       Option<String>,
	/// Telegram update id for dedupe (`user_message` only).
	pub update_id:  Option<i64>,
	/// Originating thread/topic id (`user_message` only).
	pub thread_id:  Option<String>,
	/// Requested verbosity `"lean"|"verbose"` (`config_command` only).
	pub verbosity:  Option<String>,
	/// Requested redaction state (`config_command` only).
	pub redact:     Option<bool>,
	/// Inline image attachments forwarded with the message (`user_message`
	/// only).
	pub images:     Option<Vec<InboundImageEvent>>,
}

/// One inline image attachment forwarded with an inbound user message.
#[napi(object)]
pub struct InboundImageEvent {
	/// Base64-encoded image bytes.
	pub data: String,
	/// MIME type when known (e.g. "image/jpeg").
	pub mime: Option<String>,
}

/// In-process notification server handle exposed to TypeScript.
#[napi]
pub struct NotificationServer {
	config:     Mutex<Option<ServerConfig>>,
	handle:     Mutex<Option<ServerHandle>>,
	on_reply:   Mutex<Option<ThreadsafeFunction<ReplyEvent>>>,
	on_inbound: Mutex<Option<ThreadsafeFunction<InboundEvent>>>,
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
			config:     Mutex::new(Some(config)),
			handle:     Mutex::new(None),
			on_reply:   Mutex::new(None),
			on_inbound: Mutex::new(None),
		}
	}

	/// Register the reply callback. Must be called before [`Self::start`].
	#[napi(ts_args_type = "callback: (err: null | Error, reply: ReplyEvent) => void")]
	pub fn on_reply(&self, callback: ThreadsafeFunction<ReplyEvent>) {
		*self.on_reply.lock() = Some(callback);
	}

	/// Register the inbound-message callback (free-text injections and in-thread
	/// config commands). Must be called before [`Self::start`].
	#[napi(ts_args_type = "callback: (err: null | Error, msg: InboundEvent) => void")]
	pub fn on_inbound(&self, callback: ThreadsafeFunction<InboundEvent>) {
		*self.on_inbound.lock() = Some(callback);
	}

	/// Bind the loopback endpoint and start serving. Resolves with the bound
	/// endpoint info once the socket is bound.
	///
	/// # Errors
	/// Fails if already started or the loopback socket cannot be bound.
	#[napi]
	pub async fn start(&self) -> Result<NotificationEndpoint> {
		let config = self
			.config
			.lock()
			.take()
			.ok_or_else(|| Error::from_reason("notification server already started"))?;
		let session_id = config.session_id.clone();
		let handle = gjc_notifications::start(config)
			.await
			.map_err(|e| Error::from_reason(format!("bind failed: {e}")))?;

		let endpoint = NotificationEndpoint {
			host: handle.addr().ip().to_string(),
			port: u32::from(handle.addr().port()),
			url: handle.url(),
			session_id,
		};

		// Pump forwarded replies to the TS callback (we are inside the runtime).
		let tsfn = self.on_reply.lock().take();
		let reply_rx = handle.take_reply_receiver();
		if let (Some(tsfn), Some(mut rx)) = (tsfn, reply_rx) {
			napi::tokio::spawn(async move {
				while let Some(reply) = rx.recv().await {
					let event = ReplyEvent {
						id:              reply.id,
						answer_json:     serde_json::to_string(&reply.answer)
							.unwrap_or_else(|_| "null".to_owned()),
						idempotency_key: reply.idempotency_key,
					};
					tsfn.call(Ok(event), ThreadsafeFunctionCallMode::NonBlocking);
				}
			});
		}

		// Pump forwarded inbound messages (injections / config commands) to TS.
		let inbound_tsfn = self.on_inbound.lock().take();
		let inbound_rx = handle.take_inbound_receiver();
		if let (Some(tsfn), Some(mut rx)) = (inbound_tsfn, inbound_rx) {
			napi::tokio::spawn(async move {
				while let Some(msg) = rx.recv().await {
					let event = match msg {
						ClientMessage::UserMessage(u) => InboundEvent {
							kind:       "user_message".to_owned(),
							session_id: u.session_id,
							text:       Some(u.text),
							update_id:  u.update_id,
							thread_id:  u.thread_id,
							images:     if u.images.is_empty() {
								None
							} else {
								Some(
									u.images
										.into_iter()
										.map(|i| InboundImageEvent { data: i.data, mime: i.mime })
										.collect(),
								)
							},
							verbosity:  None,
							redact:     None,
						},
						ClientMessage::ConfigCommand(c) => InboundEvent {
							kind:       "config_command".to_owned(),
							session_id: c.session_id,
							text:       None,
							update_id:  None,
							thread_id:  None,
							verbosity:  c.verbosity.map(|v| match v {
								Verbosity::Lean => "lean".to_owned(),
								Verbosity::Verbose => "verbose".to_owned(),
							}),
							redact:     c.redact,
							images:     None,
						},
						_ => continue,
					};
					tsfn.call(Ok(event), ThreadsafeFunctionCallMode::NonBlocking);
				}
			});
		}

		*self.handle.lock() = Some(handle);
		Ok(endpoint)
	}

	/// Broadcast an `action_needed` ask. `needed_json` is a JSON `ActionNeeded`.
	///
	/// `repliable` should be `true` only in unattended/RPC mode.
	///
	/// # Errors
	/// Fails if not started or `needed_json` is invalid.
	#[napi]
	pub fn register_ask(&self, needed_json: String, repliable: bool) -> Result<()> {
		let needed = parse_needed(&needed_json)?;
		self.with_handle(|h| h.register_ask(needed, repliable))
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
	/// `image_attachment`, `config_update`, `hello`). Not buffered for replay.
	///
	/// # Errors
	/// Fails if not started or `frame_json` is not a valid `ServerMessage`.
	#[napi]
	pub fn push_frame(&self, frame_json: String) -> Result<()> {
		let msg: ServerMessage = serde_json::from_str(&frame_json)
			.map_err(|e| Error::from_reason(format!("invalid frame json: {e}")))?;
		self.with_handle(|h| h.push_frame(msg))
	}

	/// Resolve an action locally (the CLI/TUI answered). `answer_json` is an
	/// optional JSON `ReplyAnswer`.
	///
	/// # Errors
	/// Fails if not started or `answer_json` is invalid.
	#[napi]
	pub fn resolve_local(&self, id: String, answer_json: Option<String>) -> Result<()> {
		let answer = parse_answer(answer_json.as_deref())?;
		self.with_handle(|h| h.resolve_local(&id, answer))
	}

	/// Resolve an action answered by a remote client, after TS resolved the real
	/// gate. `answer_json` is an optional JSON `ReplyAnswer`.
	///
	/// # Errors
	/// Fails if not started or `answer_json` is invalid.
	#[napi]
	pub fn resolve_client(
		&self,
		id: String,
		answer_json: Option<String>,
		idempotency_key: Option<String>,
	) -> Result<()> {
		let answer = parse_answer(answer_json.as_deref())?;
		self.with_handle(|h| h.resolve_client(&id, answer, idempotency_key))
	}

	/// Reject a forwarded reply after TS failed to resolve its gate. `reason` is
	/// one of the protocol reject reasons (default `invalid_answer`).
	///
	/// # Errors
	/// Fails if not started.
	#[napi]
	pub fn reject(&self, id: String, reason: Option<String>) -> Result<()> {
		let reason = parse_reason(reason.as_deref());
		self.with_handle(|h| h.reject(&id, reason))
	}

	/// Update whether the unattended gate resolver is currently available.
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
			.handle
			.lock()
			.as_ref()
			.map_or(0, |h| u32::try_from(h.client_count()).unwrap_or(u32::MAX))
	}

	/// Stop the server (idempotent) and remove the endpoint discovery file.
	#[napi]
	pub fn stop(&self) {
		if let Some(handle) = self.handle.lock().as_ref() {
			handle.stop();
		}
	}

	fn with_handle<F: FnOnce(&ServerHandle)>(&self, f: F) -> Result<()> {
		let guard = self.handle.lock();
		let handle = guard
			.as_ref()
			.ok_or_else(|| Error::from_reason("notification server not started"))?;
		f(handle);
		Ok(())
	}
}

fn parse_needed(json: &str) -> Result<ActionNeeded> {
	serde_json::from_str(json).map_err(|e| Error::from_reason(format!("invalid ActionNeeded: {e}")))
}

fn parse_answer(json: Option<&str>) -> Result<Option<ReplyAnswer>> {
	match json {
		None => Ok(None),
		Some(s) => serde_json::from_str(s)
			.map(Some)
			.map_err(|e| Error::from_reason(format!("invalid ReplyAnswer: {e}"))),
	}
}

fn parse_reason(reason: Option<&str>) -> gjc_notifications::RejectReason {
	use gjc_notifications::RejectReason;
	match reason {
		Some("already_answered") => RejectReason::AlreadyAnswered,
		Some("unknown_action") => RejectReason::UnknownAction,
		Some("resolver_unavailable") => RejectReason::ResolverUnavailable,
		Some("idempotency_conflict") => RejectReason::IdempotencyConflict,
		Some("unauthorized") => RejectReason::Unauthorized,
		_ => RejectReason::InvalidAnswer,
	}
}
