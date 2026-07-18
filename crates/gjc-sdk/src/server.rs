//! Loopback WebSocket server for the Gajae-Code SDK.
//!
//! Owns the network surface: a per-session `ws://127.0.0.1:<port>` endpoint
//! with token auth, a connection registry, fan-out broadcast, replay of the
//! buffered ask to late clients, and reply routing into the [`ActionRegistry`].
//!
//! Lifecycle matches the planned N-API contract:
//! - [`start`] binds the loopback socket and returns the **bound** address
//!   before resolving; the accept loop runs in the background and is never
//!   awaited by the caller.
//! - [`ServerHandle::stop`] is idempotent: it cancels the accept loop and all
//!   per-connection tasks and may be called any number of times.

use std::{
	collections::HashMap,
	net::{IpAddr, Ipv4Addr, SocketAddr},
	path::PathBuf,
	sync::{
		Arc,
		atomic::{AtomicBool, AtomicU64, Ordering},
	},
	time::{Duration, Instant},
};

use futures_util::{SinkExt, StreamExt};
use parking_lot::Mutex;
use tokio::{
	net::{TcpListener, TcpStream},
	sync::{Mutex as AsyncMutex, broadcast, mpsc, oneshot},
	task::{JoinHandle, JoinSet},
	time::{sleep, timeout},
};
use tokio_tungstenite::tungstenite::{
	Error, Message,
	handshake::server::{ErrorResponse, Request, Response},
	http::StatusCode,
	protocol::{CloseFrame, WebSocketConfig, frame::coding::CloseCode},
};
use tokio_util::sync::CancellationToken;

use crate::{
	actions::{
		ActionIdentity, ActionRegistrationError, ActionRegistry, ClaimOutcome, ReplyOutcome,
		RetireIfUnclaimed,
	},
	discovery::EndpointRecord,
	protocol::{
		ActionKind, ActionNeeded, ActionUnavailable, ActionUnavailableReason, AskSelectedAckCancel,
		AskSelectedAckCancelReason, AskSelectedAckFailedReason, AskSelectedAckOutcome,
		AskSelectedAckRequest, AskSelectedAckUnknownReason, ClientMessage, PROTOCOL_VERSION, Pong,
		RejectReason, ReplyAnswer, ReplyRejected, ServerHello, ServerMessage, SessionReady,
		WorkflowGateActionNeeded, WorkflowGateWireDiscriminator, capabilities,
		serialize_workflow_gate_action_needed,
	},
	query::{REQUEST_FRAME_BYTES, RESPONSE_CEILING_BYTES},
};

/// Configuration for a per-session notification server.
#[derive(Debug)]
pub struct ServerConfig {
	/// The session this endpoint belongs to.
	pub session_id:         String,
	/// The per-session token clients must present (as `?token=` on connect).
	pub token:              String,
	/// Bind host. Defaults to loopback via [`ServerConfig::new`].
	pub host:               IpAddr,
	/// Bind port. `0` selects an ephemeral port; the bound port is read back.
	pub port:               u16,
	/// Whether an SDK workflow-gate resolver is available for ask round-trips.
	/// When `false`, asks are notify-only and replies are rejected.
	pub resolver_available: bool,
	/// Optional GJC state root. When set, the server writes/removes the endpoint
	/// discovery file at `<state_root>/sdk/<session_id>.json`.
	pub state_root:         Option<PathBuf>,
	/// When `true`, accepted client replies are forwarded to the host (via
	/// [`ServerHandle::take_reply_receiver`]) instead of resolving internally,
	/// so the host resolves the real gate then calls
	/// [`ServerHandle::resolve_client`].
	pub forward_replies:    bool,
}

impl ServerConfig {
	/// Loopback config with an ephemeral port.
	#[must_use]
	pub fn new(session_id: impl Into<String>, token: impl Into<String>) -> Self {
		Self {
			session_id:         session_id.into(),
			token:              token.into(),
			host:               IpAddr::V4(Ipv4Addr::LOCALHOST),
			port:               0,
			resolver_available: true,
			state_root:         None,
			forward_replies:    false,
		}
	}
}

/// Bounded time a connection may defer controlled delivery while it advertises
/// its capabilities.
const CLIENT_HELLO_GRACE: Duration = Duration::from_secs(1);

/// Grace period for connection tasks to observe server cancellation before
/// forced abort.
const CONNECTION_JOIN_GRACE: Duration = Duration::from_secs(1);

/// Commands serialized through the owning connection task.
#[derive(Debug)]
enum DirectCommand {
	Deliver(Box<ServerMessage>, Option<oneshot::Sender<bool>>),
	DirectedFrame {
		json:                   String,
		connection_generation:  String,
		requires_tool_activity: bool,
	},
	ReevaluateAsk,
}

fn prepare_direct_ack(state: &ServerState, message: &ServerMessage) -> bool {
	let ServerMessage::AskSelectedAckRequest(request) = message else {
		return true;
	};
	state.acks.lock().begin_dispatch(request.request_id())
}

/// Validate the host-to-client directed envelope before it enters a connection
/// writer. The host can only direct typed v3 envelopes; raw WebSocket text is
/// deliberately not an escape hatch around transport policy.
fn validate_directed_frame(json: String) -> Option<(String, bool)> {
	if json.len() > RESPONSE_CEILING_BYTES {
		return None;
	}
	let frame: serde_json::Value = serde_json::from_str(&json).ok()?;
	let object = frame.as_object()?;
	let frame_type = object.get("type").and_then(serde_json::Value::as_str);
	if frame_type != Some("event_replay_result") {
		let requires_tool_activity =
			frame_type.is_some_and(|kind| matches!(kind, "tool_activity" | "reasoning_summary"));
		return Some((json, requires_tool_activity));
	}
	if !object.get("id").is_some_and(serde_json::Value::is_string)
		|| !object.get("ok").is_some_and(serde_json::Value::is_boolean)
		|| !object
			.get("generation")
			.is_some_and(serde_json::Value::is_u64)
		|| !object.get("lastSeq").is_some_and(serde_json::Value::is_u64)
	{
		return None;
	}
	let events = object.get("events")?.as_array()?;
	if !events.iter().all(|event| {
		event.as_object().is_some_and(|event| {
			if event.get("type").and_then(serde_json::Value::as_str) != Some("event") {
				return false;
			}
			let canonical = event
				.get("generation")
				.is_some_and(serde_json::Value::is_u64)
				&& event.get("seq").is_some_and(serde_json::Value::is_u64);
			let legacy = event.get("name").is_some_and(serde_json::Value::is_string)
				&& event
					.get("payload")
					.is_some_and(serde_json::Value::is_object);
			canonical || legacy
		})
	}) {
		return None;
	}
	let requires_tool_activity = events.iter().any(|event| {
		let event = event.as_object();
		let kind = event
			.and_then(|event| event.get("kind"))
			.and_then(serde_json::Value::as_str);
		let name = event
			.and_then(|event| event.get("name"))
			.and_then(serde_json::Value::as_str);
		let payload_type = event
			.and_then(|event| event.get("payload"))
			.and_then(serde_json::Value::as_object)
			.and_then(|payload| payload.get("type"))
			.and_then(serde_json::Value::as_str);
		[kind, name, payload_type]
			.into_iter()
			.flatten()
			.any(|kind| matches!(kind, "tool_activity" | "reasoning_summary"))
	});
	Some((json, requires_tool_activity))
}

fn may_deliver_directed_frame(
	state: &ServerState,
	connection_id: &str,
	connection_generation: &str,
	requires_tool_activity: bool,
) -> bool {
	state
		.connections
		.lock()
		.get(connection_id)
		.is_some_and(|connection| {
			connection.generation == connection_generation
				&& (!requires_tool_activity
					|| connection
						.capabilities
						.iter()
						.any(|capability| capability == capabilities::TOOL_ACTIVITY_V1))
		})
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Negotiation {
	AwaitingHello,
	TimedOut,
	Negotiated,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Presentation {
	Unavailable,
	Full,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Delivered {
	identity:     ActionIdentity,
	presentation: Presentation,
}

#[derive(Debug, Clone)]
struct Connection {
	generation:   String,
	capabilities: Vec<String>,
	negotiation:  Negotiation,
	delivered:    Option<Delivered>,
	tx:           mpsc::UnboundedSender<DirectCommand>,
}

/// A rejected workflow-gate registration.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkflowGateRegistrationError {
	/// Durable workflow-gate correlation cannot be empty.
	EmptyWorkflowGateId,
	/// The generic action id was already registered during this server's
	/// lifetime.
	ActionIdAlreadyRegistered,
	/// The generic action id is already bound to a distinct correlated wire
	/// presentation.
	CorrelatedPresentationCollision,
}

impl std::fmt::Display for WorkflowGateRegistrationError {
	fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		match self {
			Self::EmptyWorkflowGateId => formatter.write_str("workflow gate id must be nonempty"),
			Self::ActionIdAlreadyRegistered => formatter.write_str("action id is already registered"),
			Self::CorrelatedPresentationCollision => {
				formatter.write_str("action id is bound to a distinct correlated wire presentation")
			},
		}
	}
}

impl std::error::Error for WorkflowGateRegistrationError {}

/// Error returned when a caller attempts to broadcast an action through the
/// generic frame API instead of the action lifecycle APIs.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PushFrameError {
	ActionNeededProhibited,
}

impl std::fmt::Display for PushFrameError {
	fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		match self {
			Self::ActionNeededProhibited => {
				formatter.write_str("ActionNeeded must be sent with register_ask or note_idle")
			},
		}
	}
}

impl std::error::Error for PushFrameError {}

type AckOrigin = (String, String);
type FinishedAck = (String, Option<AckOrigin>, bool);

type AckFinish = (AskSelectedAckOutcome, Option<FinishedAck>);

#[derive(Debug)]
struct AckPending {
	commit_key: String,
	origin:     Option<AckOrigin>,
	dispatched: bool,
	waiter:     oneshot::Sender<AskSelectedAckOutcome>,
}

#[derive(Debug, Default)]
struct AckRegistry {
	pending:   HashMap<String, AckPending>,
	commits:   HashMap<String, String>,
	terminal:  HashMap<String, (AskSelectedAckOutcome, Instant)>,
	completed: HashMap<String, (String, AskSelectedAckOutcome, Instant)>,
}

impl AckRegistry {
	fn prune(&mut self) {
		self
			.terminal
			.retain(|_, (_, at)| at.elapsed() < Duration::from_mins(1));
		self
			.completed
			.retain(|_, (_, _, at)| at.elapsed() < Duration::from_mins(1));
	}

	fn finish(&mut self, request_id: &str, outcome: AskSelectedAckOutcome) -> AckFinish {
		let Some(pending) = self.pending.remove(request_id) else {
			let actual = self
				.completed
				.get(request_id)
				.map_or(outcome, |(_, outcome, _)| outcome.clone());
			return (actual, None);
		};
		self.commits.remove(&pending.commit_key);
		self
			.terminal
			.insert(pending.commit_key.clone(), (outcome.clone(), Instant::now()));
		self.completed.insert(
			request_id.to_owned(),
			(pending.commit_key.clone(), outcome.clone(), Instant::now()),
		);
		let finished = (pending.commit_key, pending.origin, pending.dispatched);
		let _ = pending.waiter.send(outcome.clone());
		(outcome, Some(finished))
	}

	fn cancel(
		&mut self,
		request_id: &str,
		commit_key: &str,
		outcome: AskSelectedAckOutcome,
	) -> AckFinish {
		if let Some((completed_commit, completed_outcome, _)) = self.completed.get(request_id) {
			return if completed_commit == commit_key {
				(completed_outcome.clone(), None)
			} else {
				(outcome, None)
			};
		}
		if self
			.pending
			.get(request_id)
			.is_none_or(|pending| pending.commit_key != commit_key)
		{
			return (outcome, None);
		}
		self.finish(request_id, outcome)
	}

	fn begin_dispatch(&mut self, request_id: &str) -> bool {
		let Some(pending) = self.pending.get_mut(request_id) else {
			return false;
		};
		pending.dispatched = true;
		true
	}

	fn settle_result(
		&mut self,
		connection_id: &str,
		generation: &str,
		result: &crate::protocol::AskSelectedAckResult,
	) -> bool {
		let authorized = self.pending.get(&result.request_id).is_some_and(|pending| {
			pending.commit_key == result.commit_key
				&& pending.origin.as_ref() == Some(&(connection_id.to_owned(), generation.to_owned()))
		});
		if !authorized {
			return false;
		}
		self
			.finish(&result.request_id, result.outcome.clone())
			.1
			.is_some()
	}

	fn finish_disconnect(&mut self, request_id: &str) {
		let Some(pending) = self.pending.get(request_id) else {
			return;
		};
		let outcome = if pending.dispatched {
			AskSelectedAckOutcome::Unknown { reason: AskSelectedAckUnknownReason::OriginDisconnected }
		} else {
			AskSelectedAckOutcome::Failed { reason: AskSelectedAckFailedReason::SessionClosed }
		};
		let _ = self.finish(request_id, outcome);
	}
}

/// A negotiated client capability set paired with its connection id.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CapabilityUpdate {
	pub connection_id: String,
	pub capabilities:  Vec<String>,
}

#[derive(Debug)]
struct ServerState {
	token:               String,
	registry:            Mutex<ActionRegistry>,
	tx:                  broadcast::Sender<ServerMessage>,
	resolver_available:  AtomicBool,
	/// Present in forward mode: accepted replies are sent here for the host.
	reply_tx:            Option<mpsc::UnboundedSender<crate::actions::ClaimedReply>>,
	/// Always present: authenticated inbound messages paired with the
	/// server-assigned connection identity that delivered them.
	inbound_tx:          mpsc::UnboundedSender<InboundMessage>,
	/// v3 frames, kept raw so the SDK host owns their protocol semantics.
	frame_tx:            mpsc::UnboundedSender<(String, String)>,
	/// Negotiated capability snapshots for host-side per-connection policy.
	cap_tx:              mpsc::UnboundedSender<CapabilityUpdate>,
	/// Connection lifecycle notifications for provider lease cleanup.
	close_tx:            mpsc::UnboundedSender<String>,
	connections:         Mutex<HashMap<String, Connection>>,
	acks:                Mutex<AckRegistry>,
	closing:             AtomicBool,
	/// Buffered last readiness frame, replayed to late-connecting clients so a
	/// lifecycle control client can wait for readiness deterministically.
	session_ready:       Mutex<Option<SessionReady>>,
	connection_sequence: AtomicU64,
}

/// An authenticated inbound message paired with its server-assigned connection
/// id.
#[derive(Debug)]
pub struct InboundMessage {
	pub connection_id: String,
	pub message:       ClientMessage,
}

pub type InboundReceiver = mpsc::UnboundedReceiver<InboundMessage>;
type FrameReceiver = mpsc::UnboundedReceiver<(String, String)>;
type CapabilityReceiver = mpsc::UnboundedReceiver<CapabilityUpdate>;

/// Handle to a running server. Dropping it does not stop the server; call
/// [`ServerHandle::stop`] (idempotent) for deterministic shutdown.
#[derive(Debug, Clone)]
pub struct ServerHandle {
	addr:          SocketAddr,
	state:         Arc<ServerState>,
	cancel:        CancellationToken,
	accept_task:   Arc<Mutex<Option<JoinHandle<()>>>>,
	shutdown_wait: Arc<AsyncMutex<()>>,
	session_id:    String,
	state_root:    Option<PathBuf>,
	reply_rx: Arc<Mutex<Option<tokio::sync::mpsc::UnboundedReceiver<crate::actions::ClaimedReply>>>>,
	inbound_rx:    Arc<Mutex<Option<InboundReceiver>>>,
	frame_rx:      Arc<Mutex<Option<FrameReceiver>>>,
	capability_rx: Arc<Mutex<Option<CapabilityReceiver>>>,
	close_rx:      Arc<Mutex<Option<mpsc::UnboundedReceiver<String>>>>,
}

impl ServerHandle {
	/// The bound socket address (with the real port when `0` was requested).
	#[must_use]
	pub const fn addr(&self) -> SocketAddr {
		self.addr
	}

	/// The `ws://host:port` URL clients connect to (token passed as `?token=`).
	#[must_use]
	pub fn url(&self) -> String {
		format!("ws://{}", self.addr)
	}

	/// Register an `ask` action and queue a connection-local reevaluation for
	/// every client. Duplicate ids fail closed without reevaluating clients; use
	/// [`Self::try_register_ask`] to observe the typed failure.
	///
	/// `repliable` should be `true` only when the SDK workflow-gate resolver can
	/// actually answer the ask.
	pub fn register_ask(&self, needed: ActionNeeded, repliable: bool) {
		let _ = self.try_register_ask(needed, repliable);
	}

	/// Register an `ask`, returning an error when its id was used previously.
	pub fn try_register_ask(
		&self,
		needed: ActionNeeded,
		repliable: bool,
	) -> Result<(), ActionRegistrationError> {
		self
			.state
			.registry
			.lock()
			.try_register_ask(needed, repliable)?;
		self.reevaluate_asks();
		Ok(())
	}

	/// Register a correlated workflow-gate ask. The correlation is emitted only
	/// by the connection-local action presentation path and is replayable while
	/// this server remains live.
	///
	/// # Errors
	/// Returns a typed error without mutating the action registry when the
	/// workflow-gate id is empty or the action id has already been registered.
	pub fn register_workflow_gate_ask(
		&self,
		needed: ActionNeeded,
		workflow_gate_id: String,
		repliable: bool,
	) -> Result<(), WorkflowGateRegistrationError> {
		self.register_workflow_gate_ask_with_discriminator(
			needed,
			workflow_gate_id,
			WorkflowGateWireDiscriminator::ActionNeeded,
			repliable,
		)
	}

	pub(crate) fn register_workflow_gate_ask_with_discriminator(
		&self,
		needed: ActionNeeded,
		workflow_gate_id: String,
		wire_discriminator: WorkflowGateWireDiscriminator,
		repliable: bool,
	) -> Result<(), WorkflowGateRegistrationError> {
		if workflow_gate_id.is_empty() {
			return Err(WorkflowGateRegistrationError::EmptyWorkflowGateId);
		}
		self
			.state
			.registry
			.lock()
			.try_register_workflow_gate_ask_with_discriminator(
				needed,
				workflow_gate_id,
				wire_discriminator,
				repliable,
			)
			.map_err(|error| match error {
				ActionRegistrationError::ActionIdAlreadyRegistered => {
					WorkflowGateRegistrationError::ActionIdAlreadyRegistered
				},
				ActionRegistrationError::CorrelatedPresentationCollision => {
					WorkflowGateRegistrationError::CorrelatedPresentationCollision
				},
			})?;
		self.reevaluate_asks();
		Ok(())
	}

	fn reevaluate_asks(&self) {
		let connections = self
			.state
			.connections
			.lock()
			.values()
			.map(|connection| connection.tx.clone())
			.collect::<Vec<_>>();
		for connection in connections {
			let _ = connection.send(DirectCommand::ReevaluateAsk);
		}
	}

	/// Read the current workflow correlation without exposing presentation
	/// delivery state, claims, receipts, or its private registration epoch.
	#[must_use]
	pub fn current_workflow_gate_ask(&self) -> Option<WorkflowGateActionNeeded> {
		self
			.state
			.registry
			.lock()
			.current_workflow_gate_ask()
			.map(|(workflow, _)| workflow)
	}

	/// Return the current exact presentation identity for in-process
	/// arbitration.
	#[must_use]
	pub fn current_identity(&self) -> Option<ActionIdentity> {
		self.state.registry.lock().current_identity()
	}

	/// Atomically terminalize an exact current presentation. The status proves
	/// whether the supplied private lease retired, was already terminal, was
	/// claimed, or is stale; only retirement broadcasts a local terminal frame.
	pub fn terminalize_if_current(&self, expected: &ActionIdentity) -> RetireIfUnclaimed {
		let outcome = self.state.registry.lock().retire_if_unclaimed(expected);
		if let RetireIfUnclaimed::Retired(resolved) = &outcome {
			let _ = self
				.state
				.tx
				.send(ServerMessage::ActionResolved(resolved.clone()));
		}
		outcome
	}

	/// Atomically retire an exact unclaimed presentation. Prefer
	/// [`Self::terminalize_if_current`] for typed terminal proof.
	pub fn retire_if_unclaimed(&self, expected: &ActionIdentity) -> RetireIfUnclaimed {
		self.terminalize_if_current(expected)
	}

	/// Broadcast an ephemeral idle ping (not buffered, not repliable).
	pub fn note_idle(&self, needed: ActionNeeded) {
		let msg = self.state.registry.lock().note_idle(needed);
		let _ = self.state.tx.send(ServerMessage::ActionNeeded(msg));
	}

	/// Broadcast an ephemeral threaded-session frame. `ActionNeeded` frames are
	/// prohibited here: use [`ServerHandle::register_ask`] or
	/// [`ServerHandle::note_idle`] so ask delivery remains connection-specific.
	///
	/// Like [`ServerHandle::note_idle`] these frames are not buffered for
	/// replay.
	///
	/// # Errors
	/// Returns [`PushFrameError::ActionNeededProhibited`] for `ActionNeeded`.
	pub fn push_frame(&self, msg: ServerMessage) -> Result<(), PushFrameError> {
		if matches!(msg, ServerMessage::ActionNeeded(_)) {
			return Err(PushFrameError::ActionNeededProhibited);
		}
		let _ = self.state.tx.send(msg);
		Ok(())
	}

	/// Publish a session-readiness signal: buffer it (so late-connecting clients
	/// see it on connect) and broadcast it to currently-connected clients.
	///
	/// Unlike [`ServerHandle::push_frame`], this frame is replayed on reconnect,
	/// so a lifecycle control client can wait for readiness deterministically
	/// instead of treating WS-open as readiness.
	pub fn push_session_ready(&self, ready: SessionReady) {
		*self.state.session_ready.lock() = Some(ready.clone());
		let _ = self.state.tx.send(ServerMessage::SessionReady(ready));
	}

	/// Resolve a pending action locally (e.g. the CLI/TUI answered it).
	///
	/// Broadcasts `action_resolved` so clients mark it non-repliable. A no-op if
	/// the action was already resolved.
	pub fn resolve_local(&self, id: &str, answer: Option<ReplyAnswer>) {
		let resolved = self.state.registry.lock().resolve_local(id, answer);
		if let Some(resolved) = resolved {
			let _ = self.state.tx.send(ServerMessage::ActionResolved(resolved));
		}
	}

	/// Take the receiver of accepted client replies (forward mode only).
	///
	/// Returns the receiver exactly once; subsequent calls return `None`. The
	/// host drains it, resolves the real gate per reply, then calls
	/// [`ServerHandle::resolve_client`] (or [`ServerHandle::reject`] on
	/// failure).
	#[must_use]
	pub fn take_reply_receiver(
		&self,
	) -> Option<tokio::sync::mpsc::UnboundedReceiver<crate::actions::ClaimedReply>> {
		self.reply_rx.lock().take()
	}

	/// Take authenticated inbound messages paired with their server-assigned
	/// connection identity. Returns the receiver exactly once; subsequent calls
	/// return `None`.
	#[must_use]
	pub fn take_inbound_receiver(&self) -> Option<InboundReceiver> {
		self.inbound_rx.lock().take()
	}

	/// Take raw v3 frames paired with their originating connection id.
	#[must_use]
	pub fn take_frame_receiver(&self) -> Option<mpsc::UnboundedReceiver<(String, String)>> {
		self.frame_rx.lock().take()
	}

	/// Take connection-close notifications paired with the disconnected
	/// connection id.
	#[must_use]
	pub fn take_close_receiver(&self) -> Option<mpsc::UnboundedReceiver<String>> {
		self.close_rx.lock().take()
	}

	/// Take negotiated client capability snapshots paired with their connection
	/// id. Returns the receiver exactly once; subsequent calls return `None`.
	#[must_use]
	pub fn take_capability_receiver(&self) -> Option<mpsc::UnboundedReceiver<CapabilityUpdate>> {
		self.capability_rx.lock().take()
	}

	/// Send a validated JSON envelope to one connected v3 SDK client. Returns
	/// false when the destination is no longer current, the envelope is invalid,
	/// or it exceeds the transport frame bound.
	pub fn send_to(&self, connection_id: &str, json: String) -> bool {
		let Some((json, requires_tool_activity)) = validate_directed_frame(json) else {
			return false;
		};
		let sender = self
			.state
			.connections
			.lock()
			.get(connection_id)
			.map(|connection| (connection.tx.clone(), connection.generation.clone()));
		sender.is_some_and(|(sender, connection_generation)| {
			sender
				.send(DirectCommand::DirectedFrame {
					json,
					connection_generation,
					requires_tool_activity,
				})
				.is_ok()
		})
	}

	/// Resolve an unclaimed legacy action. Claimed forward-mode replies require
	/// [`Self::resolve_claim`] with the exact receipt.
	pub fn resolve_client(
		&self,
		id: &str,
		answer: Option<ReplyAnswer>,
		idempotency_key: Option<String>,
	) -> bool {
		let resolved = self
			.state
			.registry
			.lock()
			.resolve_client(id, answer, idempotency_key);
		if let Some(resolved) = resolved {
			let _ = self.state.tx.send(ServerMessage::ActionResolved(resolved));
			true
		} else {
			false
		}
	}

	/// Resolve a claimed reply by its one-shot receipt and broadcast terminal
	/// state.
	pub fn resolve_claim(
		&self,
		receipt_id: &str,
		answer: Option<ReplyAnswer>,
		idempotency_key: Option<String>,
	) -> bool {
		let resolved = self
			.state
			.registry
			.lock()
			.resolve_claim(receipt_id, answer, idempotency_key);
		if let Some(resolved) = resolved {
			let _ = self.state.tx.send(ServerMessage::ActionResolved(resolved));
			true
		} else {
			false
		}
	}

	/// Close an invalid claim terminally; callers must reissue under a fresh id.
	pub fn close_claim_invalid(&self, receipt_id: &str) -> bool {
		let resolved = self.state.registry.lock().close_claim_invalid(receipt_id);
		if let Some(resolved) = resolved {
			let _ = self.state.tx.send(ServerMessage::ActionResolved(resolved));
			true
		} else {
			false
		}
	}

	/// Cancel an outstanding claim during abort or shutdown.
	pub fn cancel_claim(&self, receipt_id: &str) -> bool {
		let resolved = self.state.registry.lock().cancel_claim(receipt_id);
		if let Some(resolved) = resolved {
			let _ = self.state.tx.send(ServerMessage::ActionResolved(resolved));
			true
		} else {
			false
		}
	}

	/// Reject only an unclaimed legacy reply. Claimed forward-mode replies must
	/// be closed by receipt so they cannot remain orphaned.
	pub fn reject(&self, id: &str, reason: RejectReason) -> bool {
		if self.state.registry.lock().has_claim_for_action(id) {
			return false;
		}
		let _ = self
			.state
			.tx
			.send(ServerMessage::ReplyRejected(ReplyRejected { id: id.to_owned(), reason }));
		true
	}

	/// Update whether the SDK workflow-gate resolver is currently available.
	pub fn set_resolver_available(&self, available: bool) {
		self
			.state
			.resolver_available
			.store(available, Ordering::SeqCst);
	}

	/// Unicast a live acknowledgement to the connection that atomically claimed
	/// the source reply, then await its one terminal correlated outcome.
	pub async fn request_ask_selected_ack(
		&self,
		receipt_id: &str,
		request: AskSelectedAckRequest,
	) -> AskSelectedAckOutcome {
		let action_id = match &request {
			AskSelectedAckRequest::Live { action_id, .. } => action_id,
			AskSelectedAckRequest::Recovery { .. } => {
				return AskSelectedAckOutcome::Failed {
					reason: AskSelectedAckFailedReason::Unsupported,
				};
			},
		};
		if self
			.state
			.registry
			.lock()
			.claim_action_id(receipt_id)
			.as_deref()
			!= Some(action_id)
		{
			return AskSelectedAckOutcome::Failed { reason: AskSelectedAckFailedReason::RouteMissing };
		}
		let Some(origin) = self.state.registry.lock().claim_origin(receipt_id) else {
			return AskSelectedAckOutcome::Failed {
				reason: AskSelectedAckFailedReason::SessionClosed,
			};
		};
		match self.state.connections.lock().get(&origin.connection_id) {
			None => {
				return AskSelectedAckOutcome::Failed {
					reason: AskSelectedAckFailedReason::SessionClosed,
				};
			},
			Some(connection) if connection.generation != origin.generation => {
				return AskSelectedAckOutcome::Failed {
					reason: AskSelectedAckFailedReason::SessionClosed,
				};
			},
			Some(connection)
				if !connection
					.capabilities
					.iter()
					.any(|capability| capability == capabilities::ASK_SELECTED_ACK_V1) =>
			{
				return AskSelectedAckOutcome::Failed {
					reason: AskSelectedAckFailedReason::Unsupported,
				};
			},
			Some(_) => {},
		}
		self
			.request_ack(request, Some((origin.connection_id, origin.generation)))
			.await
	}

	/// Select exactly one authenticated acknowledgement-capable participant.
	pub async fn request_recovered_ask_selected_ack(
		&self,
		request: AskSelectedAckRequest,
	) -> AskSelectedAckOutcome {
		match &request {
			AskSelectedAckRequest::Recovery { session_id, .. } if session_id == &self.session_id => {},
			AskSelectedAckRequest::Recovery { .. } => {
				return AskSelectedAckOutcome::Failed {
					reason: AskSelectedAckFailedReason::RouteMissing,
				};
			},
			AskSelectedAckRequest::Live { .. } => {
				return AskSelectedAckOutcome::Failed {
					reason: AskSelectedAckFailedReason::Unsupported,
				};
			},
		}
		let participants: Vec<_> = self
			.state
			.connections
			.lock()
			.iter()
			.filter(|(_, c)| {
				c.capabilities
					.iter()
					.any(|v| v == capabilities::ASK_SELECTED_ACK_V1)
			})
			.map(|(id, c)| (id.clone(), c.generation.clone()))
			.collect();
		match participants.as_slice() {
			[] => AskSelectedAckOutcome::Failed { reason: AskSelectedAckFailedReason::NoParticipant },
			[origin] => self.request_ack(request, Some(origin.clone())).await,
			_ => AskSelectedAckOutcome::Failed {
				reason: AskSelectedAckFailedReason::AmbiguousParticipant,
			},
		}
	}

	async fn request_ack(
		&self,
		request: AskSelectedAckRequest,
		origin: Option<(String, String)>,
	) -> AskSelectedAckOutcome {
		let request_id = request.request_id().to_owned();
		let commit_key = request.commit_key().to_owned();
		let deadline_at = request.deadline_at();
		let now_ms = std::time::SystemTime::now()
			.duration_since(std::time::UNIX_EPOCH)
			.unwrap_or_default()
			.as_millis() as i64;
		let remaining_ms = deadline_at.saturating_sub(now_ms);
		if remaining_ms <= 0 {
			return AskSelectedAckOutcome::Failed { reason: AskSelectedAckFailedReason::Expired };
		}
		let deadline =
			Duration::from_millis(u64::try_from(remaining_ms).unwrap_or_default().min(10_000));
		let (tx, rx) = oneshot::channel();
		{
			let mut acks = self.state.acks.lock();
			acks.prune();
			if self.state.closing.load(Ordering::Acquire) {
				return AskSelectedAckOutcome::Unknown {
					reason: AskSelectedAckUnknownReason::Shutdown,
				};
			}
			if let Some((outcome, _)) = acks.terminal.get(&commit_key) {
				return outcome.clone();
			}
			if acks.commits.contains_key(&commit_key) || acks.pending.contains_key(&request_id) {
				return AskSelectedAckOutcome::Failed { reason: AskSelectedAckFailedReason::Cancelled };
			}
			acks.commits.insert(commit_key.clone(), request_id.clone());
			acks.pending.insert(request_id.clone(), AckPending {
				commit_key,
				origin: origin.clone(),
				dispatched: false,
				waiter: tx,
			});
		}
		let (dispatch_tx, dispatch_rx) = oneshot::channel();
		let direct_tx = origin.as_ref().and_then(|(id, generation)| {
			self
				.state
				.connections
				.lock()
				.get(id)
				.filter(|connection| connection.generation == *generation)
				.map(|connection| connection.tx.clone())
		});
		let queued = direct_tx.is_some_and(|direct_tx| {
			direct_tx
				.send(DirectCommand::Deliver(
					Box::new(ServerMessage::AskSelectedAckRequest(request)),
					Some(dispatch_tx),
				))
				.is_ok()
		});
		if !queued {
			return self.finish_ack(
				&request_id,
				AskSelectedAckOutcome::Failed { reason: AskSelectedAckFailedReason::SessionClosed },
				AskSelectedAckCancelReason::HostTimeout,
			);
		}
		match tokio::time::timeout(deadline, dispatch_rx).await {
			Ok(Ok(true)) => {},
			Ok(Ok(false) | Err(_)) => {
				return self.finish_ack(
					&request_id,
					AskSelectedAckOutcome::Unknown {
						reason: AskSelectedAckUnknownReason::TransportAmbiguous,
					},
					AskSelectedAckCancelReason::HostTimeout,
				);
			},
			Err(_) => {
				return self.finish_ack(
					&request_id,
					AskSelectedAckOutcome::Unknown { reason: AskSelectedAckUnknownReason::HostTimeout },
					AskSelectedAckCancelReason::HostTimeout,
				);
			},
		}
		let now_ms = std::time::SystemTime::now()
			.duration_since(std::time::UNIX_EPOCH)
			.unwrap_or_default()
			.as_millis() as i64;
		let remaining_ms = deadline_at.saturating_sub(now_ms);
		if remaining_ms <= 0 {
			return self.finish_ack(
				&request_id,
				AskSelectedAckOutcome::Unknown { reason: AskSelectedAckUnknownReason::HostTimeout },
				AskSelectedAckCancelReason::HostTimeout,
			);
		}
		match tokio::time::timeout(
			Duration::from_millis(u64::try_from(remaining_ms).unwrap_or_default().min(10_000)),
			rx,
		)
		.await
		{
			Ok(Ok(outcome)) => outcome,
			_ => self.finish_ack(
				&request_id,
				AskSelectedAckOutcome::Unknown { reason: AskSelectedAckUnknownReason::HostTimeout },
				AskSelectedAckCancelReason::HostTimeout,
			),
		}
	}

	fn finish_ack(
		&self,
		request_id: &str,
		outcome: AskSelectedAckOutcome,
		cancel_reason: AskSelectedAckCancelReason,
	) -> AskSelectedAckOutcome {
		let (actual, cancel) = {
			let mut acks = self.state.acks.lock();
			let (actual, finished) = acks.finish(request_id, outcome);
			let cancel = finished.and_then(|(commit_key, origin, dispatched)| {
				dispatched.then_some((commit_key, origin))
			});
			(actual, cancel)
		};
		if let Some((commit_key, Some((id, generation)))) = cancel {
			let direct_tx = self
				.state
				.connections
				.lock()
				.get(&id)
				.filter(|connection| connection.generation == generation)
				.map(|connection| connection.tx.clone());
			if let Some(direct_tx) = direct_tx {
				let _ = direct_tx.send(DirectCommand::Deliver(
					Box::new(ServerMessage::AskSelectedAckCancel(AskSelectedAckCancel {
						request_id: request_id.to_owned(),
						commit_key,
						reason: cancel_reason,
					})),
					None,
				));
			}
		}
		actual
	}

	/// Terminalize a request and unicast the caller-provided cancellation frame
	/// only when the request was actually dispatched.
	pub fn cancel_ask_selected_ack(&self, cancel: AskSelectedAckCancel) -> AskSelectedAckOutcome {
		let outcome = AskSelectedAckOutcome::Failed { reason: AskSelectedAckFailedReason::Cancelled };
		let (actual, dispatched) = {
			let mut acks = self.state.acks.lock();
			let (actual, finished) = acks.cancel(&cancel.request_id, &cancel.commit_key, outcome);
			let dispatched = finished.and_then(|(_, origin, dispatched)| dispatched.then_some(origin));
			(actual, dispatched)
		};
		if let Some(Some((id, generation))) = dispatched {
			let direct_tx = self
				.state
				.connections
				.lock()
				.get(&id)
				.filter(|connection| connection.generation == generation)
				.map(|connection| connection.tx.clone());
			if let Some(direct_tx) = direct_tx {
				let _ = direct_tx.send(DirectCommand::Deliver(
					Box::new(ServerMessage::AskSelectedAckCancel(cancel)),
					None,
				));
			}
		}
		actual
	}

	/// Number of clients currently subscribed to the broadcast channel.
	#[must_use]
	pub fn client_count(&self) -> usize {
		self.state.tx.receiver_count()
	}

	/// Stop the server. Idempotent: cancels the accept loop and all connection
	/// tasks; safe to call multiple times.
	pub fn stop(&self) {
		self.state.closing.store(true, Ordering::Release);
		let ids: Vec<_> = self.state.acks.lock().pending.keys().cloned().collect();
		for id in ids {
			let _ = self.finish_ack(
				&id,
				AskSelectedAckOutcome::Unknown { reason: AskSelectedAckUnknownReason::Shutdown },
				AskSelectedAckCancelReason::SessionShutdown,
			);
		}
		self.cancel.cancel();
		if let Some(root) = self.state_root.as_deref() {
			let _ = crate::discovery::remove_endpoint(root, &self.session_id);
		}
	}

	/// Stop the server and wait until the accept loop and every connection task
	/// have released their sockets. This is the authoritative filesystem
	/// teardown boundary for callers that remove a server-owned state root.
	pub async fn stop_and_wait(&self) {
		self.stop();
		let _shutdown = self.shutdown_wait.lock().await;
		let task = self.accept_task.lock().take();
		if let Some(task) = task {
			let _ = task.await;
		}
	}
}

impl Drop for ServerHandle {
	fn drop(&mut self) {
		if Arc::strong_count(&self.accept_task) == 1 {
			self.cancel.cancel();
		}
	}
}

/// Bind the loopback endpoint and spawn the accept loop in the background.
///
/// Resolves only after the socket is bound; the returned [`ServerHandle::addr`]
/// reflects the real (possibly ephemeral) port.
///
/// # Errors
/// Returns the bind error if the loopback socket cannot be acquired.
pub async fn start(config: ServerConfig) -> std::io::Result<ServerHandle> {
	let listener = TcpListener::bind(SocketAddr::new(config.host, config.port)).await?;
	let addr = listener.local_addr()?;
	let (tx, _rx) = broadcast::channel(256);

	if let Some(state_root) = config.state_root.as_deref() {
		let record = EndpointRecord::new(
			config.session_id.as_str(),
			&addr.ip().to_string(),
			addr.port(),
			config.token.as_str(),
		);
		crate::discovery::write_endpoint(state_root, &record)?;
	}

	let (reply_tx, reply_rx) = if config.forward_replies {
		let (tx, rx) = mpsc::unbounded_channel();
		(Some(tx), Some(rx))
	} else {
		(None, None)
	};
	let (inbound_tx, inbound_rx) = mpsc::unbounded_channel::<InboundMessage>();
	let (frame_tx, frame_rx) = mpsc::unbounded_channel();
	let (cap_tx, cap_rx) = mpsc::unbounded_channel();
	let (close_tx, close_rx) = mpsc::unbounded_channel();
	let state = Arc::new(ServerState {
		token: config.token,
		registry: Mutex::new(ActionRegistry::new()),
		tx,
		resolver_available: AtomicBool::new(config.resolver_available),
		reply_tx,
		inbound_tx,
		frame_tx,
		cap_tx,
		close_tx,
		connections: Mutex::new(HashMap::new()),
		acks: Mutex::new(AckRegistry::default()),
		closing: AtomicBool::new(false),
		session_ready: Mutex::new(None),
		connection_sequence: AtomicU64::new(1),
	});
	let cancel = CancellationToken::new();
	let accept_task = tokio::spawn(accept_loop(listener, Arc::clone(&state), cancel.clone()));
	Ok(ServerHandle {
		addr,
		state,
		cancel,
		accept_task: Arc::new(Mutex::new(Some(accept_task))),
		shutdown_wait: Arc::new(AsyncMutex::new(())),
		session_id: config.session_id,
		state_root: config.state_root,
		reply_rx: Arc::new(Mutex::new(reply_rx)),
		inbound_rx: Arc::new(Mutex::new(Some(inbound_rx))),
		frame_rx: Arc::new(Mutex::new(Some(frame_rx))),
		capability_rx: Arc::new(Mutex::new(Some(cap_rx))),
		close_rx: Arc::new(Mutex::new(Some(close_rx))),
	})
}

async fn accept_loop(listener: TcpListener, state: Arc<ServerState>, cancel: CancellationToken) {
	let mut connections = JoinSet::new();
	loop {
		tokio::select! {
			() = cancel.cancelled() => break,
			joined = connections.join_next(), if !connections.is_empty() => {
				let _ = joined;
			},
			accepted = listener.accept() => {
				let Ok((stream, _peer)) = accepted else { continue };
				connections.spawn(handle_conn(stream, Arc::clone(&state), cancel.clone()));
			}
		}
	}
	cancel.cancel();
	join_connection_tasks(&mut connections).await;
}

async fn join_connection_tasks(connections: &mut JoinSet<()>) {
	if timeout(CONNECTION_JOIN_GRACE, async { while connections.join_next().await.is_some() {} })
		.await
		.is_err()
	{
		connections.abort_all();
		while connections.join_next().await.is_some() {}
	}
}

#[allow(
	clippy::result_large_err,
	reason = "ErrorResponse is the type mandated by tokio-tungstenite's accept_hdr_async callback"
)]
async fn handle_conn(stream: TcpStream, state: Arc<ServerState>, cancel: CancellationToken) {
	let expected = state.token.clone();
	let auth = move |req: &Request, resp: Response| -> Result<Response, ErrorResponse> {
		if token_from_query(req.uri().query()).is_some_and(|t| tokens_match(&t, &expected)) {
			Ok(resp)
		} else {
			let body = ErrorResponse::new(Some("unauthorized".to_owned()));
			let (mut parts, body) = body.into_parts();
			parts.status = StatusCode::UNAUTHORIZED;
			Err(ErrorResponse::from_parts(parts, body))
		}
	};
	// Tungstenite applies the frame ceiling from the frame header, before it
	// accumulates the payload into a message or this server parses/clones it.
	let ws_config = WebSocketConfig {
		max_message_size: Some(REQUEST_FRAME_BYTES),
		max_frame_size: Some(REQUEST_FRAME_BYTES),
		..WebSocketConfig::default()
	};
	let ws = tokio::select! {
		() = cancel.cancelled() => return,
		accepted = tokio_tungstenite::accept_hdr_async_with_config(stream, auth, Some(ws_config)) => {
			let Ok(ws) = accepted else { return };
			ws
		},
	};
	let connection_id =
		format!("connection:{}", state.connection_sequence.fetch_add(1, Ordering::Relaxed));
	let generation = "0".to_owned();
	let (direct_tx, mut direct_rx) = mpsc::unbounded_channel::<DirectCommand>();
	let mut rx = state.tx.subscribe();
	let (mut write, mut read) = ws.split();
	let hello = ServerMessage::Hello(ServerHello {
		protocol_version: PROTOCOL_VERSION,
		capabilities:     vec![
			capabilities::THREADED.into(),
			capabilities::CONTEXT.into(),
			capabilities::TURN_STREAM.into(),
			capabilities::IMAGES.into(),
			capabilities::CONFIG.into(),
			capabilities::CLIENT_PING_PONG.into(),
			capabilities::SESSION_READY.into(),
			capabilities::ASK_CONTROLS_V1.into(),
			capabilities::ASK_SELECTED_ACK_V1.into(),
			capabilities::TOOL_ACTIVITY_V1.into(),
			capabilities::EPHEMERAL_TURN_V1.into(),
		],
		connection_id:    Some(connection_id.clone()),
	});
	if send_msg(&mut write, &hello).await.is_err() {
		return;
	}

	state
		.connections
		.lock()
		.insert(connection_id.clone(), Connection {
			generation:   generation.clone(),
			capabilities: Vec::new(),
			negotiation:  Negotiation::AwaitingHello,
			delivered:    None,
			tx:           direct_tx.clone(),
		});

	// Replay readiness before ask presentation; the ask itself is tailored by the
	// connection task after insertion and never written before ClientHello policy.
	let ready_replay = state.session_ready.lock().clone();
	if let Some(ready) = ready_replay
		&& send_msg(&mut write, &ServerMessage::SessionReady(ready))
			.await
			.is_err()
	{
		state.connections.lock().remove(&connection_id);
		return;
	}
	let _ = direct_tx.send(DirectCommand::ReevaluateAsk);

	let grace = sleep(CLIENT_HELLO_GRACE);
	tokio::pin!(grace);
	let mut awaiting = true;

	loop {
		tokio::select! {
			() = cancel.cancelled() => {
				while let Ok(direct) = direct_rx.try_recv() {
					let sent = match direct {
						DirectCommand::Deliver(message, dispatched) => {
							if !prepare_direct_ack(&state, &message) {
								if let Some(dispatched) = dispatched {
									let _ = dispatched.send(false);
								}
								continue;
							}
							let sent = send_msg(&mut write, &message).await.is_ok();
							if let Some(dispatched) = dispatched {
								let _ = dispatched.send(sent);
							}
							sent
						},
						DirectCommand::DirectedFrame {
							json,
							connection_generation,
							requires_tool_activity,
						} => {
							may_deliver_directed_frame(
								&state,
								&connection_id,
								&connection_generation,
								requires_tool_activity,
							) && write.send(Message::Text(json)).await.is_ok()
						},
						DirectCommand::ReevaluateAsk => true,
					};
					if !sent {
						break;
					}
				}
				break;
			},
			() = &mut grace, if awaiting => {
				awaiting = false;
				if let Some(connection) = state.connections.lock().get_mut(&connection_id) {
					connection.negotiation = Negotiation::TimedOut;
				}
				let _ = direct_tx.send(DirectCommand::ReevaluateAsk);
			},
			incoming = read.next() => {
				match incoming {
					Some(Ok(Message::Text(text))) => {
						if text.len() > REQUEST_FRAME_BYTES
							|| !handle_text(
								text.as_str(),
								&state,
								&mut write,
								&connection_id,
								&generation,
								&mut awaiting,
								&direct_tx,
							).await
						{
							let _ = reject_frame(&mut write, CloseCode::Size, "request frame exceeds 256 KiB").await;
							break;
						}
					},
					Some(Ok(Message::Binary(_))) => {
						let _ = reject_frame(&mut write, CloseCode::Unsupported, "binary protocol frames are unsupported").await;
						break;
					},
					Some(Ok(Message::Ping(payload))) => {
						if write.send(Message::Pong(payload)).await.is_err() {
							break;
						}
					},
					Some(Ok(Message::Close(_))) | None => break,
					Some(Err(Error::Capacity(_))) => {
						let _ = reject_frame(&mut write, CloseCode::Size, "request frame exceeds 256 KiB").await;
						break;
					},
					Some(Ok(_)) => {},
					Some(Err(_)) => break,
				}
			},
			direct = direct_rx.recv() => {
				let Some(direct) = direct else {
					break;
				};
				match direct {
					DirectCommand::Deliver(message, dispatched) => {
						if !prepare_direct_ack(&state, &message) {
							if let Some(dispatched) = dispatched {
								let _ = dispatched.send(false);
							}
							continue;
						}
						let sent = send_msg(&mut write, &message).await.is_ok();
						if let Some(dispatched) = dispatched {
							let _ = dispatched.send(sent);
						}
						if !sent {
							break;
						}
					},
					DirectCommand::DirectedFrame {
						json,
						connection_generation,
						requires_tool_activity,
					} => {
						if may_deliver_directed_frame(
							&state,
							&connection_id,
							&connection_generation,
							requires_tool_activity,
						) && write.send(Message::Text(json)).await.is_err() {
							break;
						}
					},
					DirectCommand::ReevaluateAsk => {
						if !reevaluate_ask(&state, &mut write, &connection_id).await {
							break;
						}
					},
				}
			},
			broadcasted = rx.recv() => {
				match broadcasted {
					Ok(msg) => {
						let allowed = !matches!(
							&msg,
							ServerMessage::ActionNeeded(needed)
								if needed.kind != ActionKind::Idle || !needed.controls.is_empty()
						)
							&& (!matches!(
								&msg,
								ServerMessage::ToolActivity(_) | ServerMessage::ReasoningSummary(_)
							) || state.connections.lock().get(&connection_id).is_some_and(|connection| {
								connection.capabilities.iter().any(|capability| {
									capability == capabilities::TOOL_ACTIVITY_V1
								})
							}));
						if allowed && send_msg(&mut write, &msg).await.is_err() {
							break;
						}
					},
					Err(broadcast::error::RecvError::Lagged(_)) => {},
					Err(broadcast::error::RecvError::Closed) => break,
				}
			},
		}
	}
	state.connections.lock().remove(&connection_id);
	let _ = state.close_tx.send(connection_id.clone());
	let ids: Vec<_> = state
		.acks
		.lock()
		.pending
		.iter()
		.filter(|(_, pending)| {
			pending.origin.as_ref() == Some(&(connection_id.clone(), generation.clone()))
		})
		.map(|(id, _)| id.clone())
		.collect();
	for id in ids {
		state.acks.lock().finish_disconnect(&id);
	}
}

/// Reevaluate the canonical ask inside the connection task so its write is
/// serialized with all broadcast and direct frames. The registry retains only
/// canonical action data; this constant-space record is presentation authority.
async fn reevaluate_ask<S>(state: &Arc<ServerState>, write: &mut S, connection_id: &str) -> bool
where
	S: SinkExt<Message> + Unpin,
{
	let Some((needed, workflow_gate_id, identity)) = state.registry.lock().current_wire_snapshot()
	else {
		return true;
	};

	let Some((negotiation, client_capabilities, delivered)) = state
		.connections
		.lock()
		.get(connection_id)
		.map(|connection| {
			(connection.negotiation, connection.capabilities.clone(), connection.delivered.clone())
		})
	else {
		return false;
	};

	let presentation = if needed.controls.is_empty() {
		Some(Presentation::Full)
	} else {
		match negotiation {
			Negotiation::AwaitingHello => None,
			Negotiation::TimedOut => Some(Presentation::Unavailable),
			Negotiation::Negotiated
				if client_capabilities
					.iter()
					.any(|capability| capability == capabilities::ASK_CONTROLS_V1) =>
			{
				Some(Presentation::Full)
			},
			Negotiation::Negotiated => Some(Presentation::Unavailable),
		}
	};
	let Some(presentation) = presentation else {
		return true;
	};
	if delivered.as_ref().is_some_and(|delivered| {
		delivered.identity == identity
			&& (delivered.presentation == presentation || delivered.presentation == Presentation::Full)
	}) {
		return true;
	}

	// Confirm current identity immediately before the connection writer emits.
	if state.registry.lock().current_identity().as_ref() != Some(&identity) {
		return true;
	}
	let sent = match presentation {
		Presentation::Full => match workflow_gate_id {
			Some(workflow_gate_id) => {
				let Ok(json) = serialize_workflow_gate_action_needed(&needed, &workflow_gate_id) else {
					return false;
				};
				write.send(Message::Text(json)).await.map_err(|_| ())
			},
			None => send_msg(write, &ServerMessage::ActionNeeded(needed)).await,
		},
		Presentation::Unavailable => {
			send_msg(
				write,
				&ServerMessage::ActionUnavailable(ActionUnavailable {
					id:                    needed.id,
					session_id:            needed.session_id,
					reason:                ActionUnavailableReason::MissingCapability,
					required_capabilities: vec![capabilities::ASK_CONTROLS_V1.into()],
				}),
			)
			.await
		},
	};
	if sent.is_err() {
		return false;
	}
	if let Some(connection) = state.connections.lock().get_mut(connection_id) {
		connection.delivered = Some(Delivered { identity, presentation });
	}
	true
}

/// Returns `false` when the connection should close.
async fn handle_text<S>(
	text: &str,
	state: &Arc<ServerState>,
	write: &mut S,
	connection_id: &str,
	generation: &str,
	awaiting: &mut bool,
	direct_tx: &mpsc::UnboundedSender<DirectCommand>,
) -> bool
where
	S: SinkExt<Message> + Unpin,
{
	if is_v3_frame(text) {
		return state
			.frame_tx
			.send((
				connection_id.to_owned(),
				attach_event_replay_capabilities(text, state, connection_id),
			))
			.is_ok();
	}
	let Ok(msg) = serde_json::from_str::<ClientMessage>(text) else {
		// Ignore malformed frames without tearing down the connection.
		return true;
	};
	let reply = match msg {
		ClientMessage::Reply(reply) => reply,
		// Inbound free-text injection / ephemeral side question / in-thread config
		// command: forward to the host (token-authorized) and stop. These are not
		// action replies.
		ClientMessage::UserMessage(u) => {
			if tokens_match(&u.token, &state.token) {
				let _ = state.inbound_tx.send(InboundMessage {
					connection_id: connection_id.to_owned(),
					message:       ClientMessage::UserMessage(u),
				});
			}
			return true;
		},
		ClientMessage::EphemeralTurn(turn) => {
			if tokens_match(&turn.token, &state.token) {
				let _ = state.inbound_tx.send(InboundMessage {
					connection_id: connection_id.to_owned(),
					message:       ClientMessage::EphemeralTurn(turn),
				});
			}
			return true;
		},
		ClientMessage::EphemeralTurnCancel(cancel) => {
			if tokens_match(&cancel.token, &state.token) {
				let _ = state.inbound_tx.send(InboundMessage {
					connection_id: connection_id.to_owned(),
					message:       ClientMessage::EphemeralTurnCancel(cancel),
				});
			}
			return true;
		},
		ClientMessage::ConfigCommand(c) => {
			if tokens_match(&c.token, &state.token) {
				let _ = state.inbound_tx.send(InboundMessage {
					connection_id: connection_id.to_owned(),
					message:       ClientMessage::ConfigCommand(c),
				});
			}
			return true;
		},
		ClientMessage::ControlCommand(c) => {
			if tokens_match(&c.token, &state.token) {
				let _ = state.inbound_tx.send(InboundMessage {
					connection_id: connection_id.to_owned(),
					message:       ClientMessage::ControlCommand(c),
				});
			}
			return true;
		},
		ClientMessage::Ping(p) => {
			return send_msg(write, &ServerMessage::Pong(Pong { nonce: p.nonce }))
				.await
				.is_ok();
		},
		ClientMessage::AskSelectedAckResult(result) => {
			state
				.acks
				.lock()
				.settle_result(connection_id, generation, &result);
			return true;
		},
		ClientMessage::Hello(hello) => {
			*awaiting = false;
			let capabilities =
				if let Some(connection) = state.connections.lock().get_mut(connection_id) {
					for capability in hello.capabilities {
						if !connection.capabilities.contains(&capability) {
							connection.capabilities.push(capability);
						}
					}
					connection.negotiation = Negotiation::Negotiated;
					Some(connection.capabilities.clone())
				} else {
					None
				};
			if let Some(capabilities) = capabilities {
				let _ = state
					.cap_tx
					.send(CapabilityUpdate { connection_id: connection_id.to_owned(), capabilities });
			}
			let _ = direct_tx.send(DirectCommand::ReevaluateAsk);
			return true;
		},
		ClientMessage::Unknown => return true,
	};

	let authorized = tokens_match(&reply.token, &state.token);
	let resolver = state.resolver_available.load(Ordering::SeqCst);
	let delivered = state
		.connections
		.lock()
		.get(connection_id)
		.filter(|connection| connection.generation == generation)
		.and_then(|connection| match &connection.delivered {
			Some(Delivered { identity, presentation: Presentation::Full }) => Some(identity.clone()),
			_ => None,
		});

	// Forward mode: accepted replies go to the host, which must settle the exact
	// claim receipt after resolving the real gate.
	if let Some(reply_tx) = &state.reply_tx {
		let classification = state.registry.lock().claim_reply_if_delivered(
			delivered.as_ref(),
			&reply,
			connection_id,
			generation,
			authorized,
			resolver,
		);
		return match classification {
			ClaimOutcome::Forward(claim) => {
				let receipt_id = claim.reply_receipt_id.clone();
				if reply_tx.send(claim).is_err() {
					let resolved = state.registry.lock().cancel_claim(&receipt_id);
					if let Some(resolved) = resolved {
						let _ = state.tx.send(ServerMessage::ActionResolved(resolved));
					}
				}
				true
			},
			ClaimOutcome::Duplicate => true,
			ClaimOutcome::Reject(reason) => {
				send_msg(write, &ServerMessage::ReplyRejected(ReplyRejected { id: reply.id, reason }))
					.await
					.is_ok()
			},
		};
	}

	let outcome = state.registry.lock().apply_reply_if_delivered(
		delivered.as_ref(),
		&reply,
		authorized,
		resolver,
	);

	match outcome {
		ReplyOutcome::Resolved(resolved) => {
			// Broadcast so every client (including this one) marks it non-repliable.
			let _ = state.tx.send(ServerMessage::ActionResolved(resolved));
			true
		},
		ReplyOutcome::DuplicateAccepted => true,
		ReplyOutcome::Rejected(reason) => {
			// Reply rejections go only to the offending client.
			send_msg(write, &ServerMessage::ReplyRejected(ReplyRejected { id: reply.id, reason }))
				.await
				.is_ok()
		},
	}
}

async fn reject_frame<S>(write: &mut S, code: CloseCode, reason: &'static str) -> Result<(), ()>
where
	S: SinkExt<Message> + Unpin,
{
	write
		.send(Message::Close(Some(CloseFrame { code, reason: reason.into() })))
		.await
		.map_err(|_| ())
}

async fn send_msg<S>(write: &mut S, msg: &ServerMessage) -> Result<(), ()>
where
	S: SinkExt<Message> + Unpin,
{
	let json = serde_json::to_string(msg).map_err(|_| ())?;
	write.send(Message::Text(json)).await.map_err(|_| ())
}

/// Attaches the authoritative, locally negotiated capability set to forwarded
/// `event_replay` frames. Hello is handled before later frames on a connection,
/// so this does not depend on an asynchronously mirrored host cache.
fn attach_event_replay_capabilities(
	text: &str,
	state: &ServerState,
	connection_id: &str,
) -> String {
	let Ok(mut frame) = serde_json::from_str::<serde_json::Value>(text) else {
		return text.to_owned();
	};
	if frame.get("type").and_then(serde_json::Value::as_str) != Some("event_replay") {
		return text.to_owned();
	}
	let capabilities = state
		.connections
		.lock()
		.get(connection_id)
		.map_or_else(Vec::new, |connection| connection.capabilities.clone());
	if let Some(object) = frame.as_object_mut() {
		object.insert(
			"capabilities".to_owned(),
			serde_json::Value::Array(
				capabilities
					.into_iter()
					.map(serde_json::Value::String)
					.collect(),
			),
		);
		return serde_json::to_string(&frame).unwrap_or_else(|_| text.to_owned());
	}
	text.to_owned()
}

fn is_v3_frame(text: &str) -> bool {
	let Ok(value) = serde_json::from_str::<serde_json::Value>(text) else {
		return false;
	};
	matches!(
		value.get("type").and_then(serde_json::Value::as_str),
		Some(
			"control_request"
				| "query_request"
				| "event_replay"
				| "register_provider"
				| "provider_heartbeat"
				| "lease_release"
				| "reverse_response"
		)
	)
}

/// Extract the `token` query parameter value (no percent-decoding; tokens are
/// generated URL-safe).
pub(crate) fn token_from_query(query: Option<&str>) -> Option<String> {
	let query = query?;
	query.split('&').find_map(|pair| {
		let mut it = pair.splitn(2, '=');
		(it.next() == Some("token")).then(|| it.next().unwrap_or("").to_owned())
	})
}

/// Constant-time-ish token comparison (length is allowed to leak).
pub(crate) fn tokens_match(a: &str, b: &str) -> bool {
	let (a, b) = (a.as_bytes(), b.as_bytes());
	if a.len() != b.len() {
		return false;
	}
	let mut diff = 0u8;
	for (x, y) in a.iter().zip(b) {
		diff |= x ^ y;
	}
	diff == 0
}

#[cfg(test)]
mod tests {
	use futures_util::SinkExt;
	use tokio_tungstenite::connect_async;

	use super::*;
	use crate::protocol::{
		ActionKind, AskControl, ClientHello, Ping, Reply, ToolActivity, ToolActivityPhase,
	};

	// Tokio's mock clock is process-global. Acquire the lock before constructing
	// a paused runtime so concurrent libtest workers cannot share its clock.
	static PAUSED_TIME_TEST_LOCK: parking_lot::Mutex<()> = parking_lot::Mutex::new(());

	fn run_paused_test(test: impl std::future::Future<Output = ()>) {
		let _time_guard = PAUSED_TIME_TEST_LOCK.lock();
		tokio::runtime::Builder::new_current_thread()
			.enable_all()
			.start_paused(true)
			.build()
			.expect("paused Tokio runtime")
			.block_on(async {
				// A perpetually runnable task prevents Tokio from automatically
				// advancing mocked time while the test is waiting on socket I/O.
				let keep_runtime_busy = tokio::spawn(async {
					loop {
						tokio::task::yield_now().await;
					}
				});
				test.await;
				keep_runtime_busy.abort();
				let _ = keep_runtime_busy.await;
			});
	}

	#[tokio::test]
	async fn stalled_connection_tasks_are_aborted_after_shutdown_grace() {
		let mut connections = JoinSet::new();
		connections.spawn(async { std::future::pending::<()>().await });
		tokio::time::timeout(
			CONNECTION_JOIN_GRACE + Duration::from_secs(1),
			join_connection_tasks(&mut connections),
		)
		.await
		.expect("connection joins must remain bounded");
		assert!(connections.is_empty());
	}

	fn ask(id: &str) -> ActionNeeded {
		ActionNeeded {
			id:         id.into(),
			kind:       ActionKind::Ask,
			session_id: "s".into(),
			question:   Some("Proceed?".into()),
			options:    Some(vec!["Yes".into(), "No".into()]),
			controls:   vec![],
			summary:    None,
		}
	}

	fn controlled_ask(id: &str) -> ActionNeeded {
		let mut needed = ask(id);
		needed.controls = vec![AskControl {
			id:      "navigation_forward".into(),
			kind:    "navigation".into(),
			label:   "Continue".into(),
			enabled: true,
		}];
		needed
	}

	fn idle(id: &str) -> ActionNeeded {
		ActionNeeded {
			id:         id.into(),
			kind:       ActionKind::Idle,
			session_id: "s".into(),
			question:   None,
			options:    None,
			controls:   vec![],
			summary:    Some("idle".into()),
		}
	}

	async fn send_hello(
		ws: &mut tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<TcpStream>>,
		capabilities: Vec<String>,
	) {
		ws.send(Message::Text(
			serde_json::to_string(&ClientMessage::Hello(ClientHello {
				protocol_version: PROTOCOL_VERSION,
				capabilities,
			}))
			.unwrap(),
		))
		.await
		.unwrap();
	}

	async fn next_server_msg<S>(read: &mut S) -> ServerMessage
	where
		S: StreamExt<Item = Result<Message, tokio_tungstenite::tungstenite::Error>> + Unpin,
	{
		loop {
			let msg = tokio::time::timeout(std::time::Duration::from_secs(2), read.next())
				.await
				.expect("timed out waiting for server message")
				.expect("stream closed")
				.expect("ws error");
			if let Message::Text(t) = msg {
				return serde_json::from_str(t.as_str()).expect("valid server message");
			}
		}
	}

	async fn next_server_msg_after_delivery<S>(read: &mut S) -> ServerMessage
	where
		S: StreamExt<Item = Result<Message, tokio_tungstenite::tungstenite::Error>> + Unpin,
	{
		let msg = read
			.next()
			.await
			.expect("stream closed before controlled delivery")
			.expect("websocket error before controlled delivery");
		let Message::Text(text) = msg else {
			panic!("expected text controlled delivery, got {msg:?}");
		};
		serde_json::from_str(text.as_str()).expect("valid controlled delivery")
	}

	async fn next_server_hello<S>(read: &mut S) -> ServerHello
	where
		S: StreamExt<Item = Result<Message, tokio_tungstenite::tungstenite::Error>> + Unpin,
	{
		match next_server_msg(read).await {
			ServerMessage::Hello(hello) => {
				assert_eq!(hello.protocol_version, PROTOCOL_VERSION);
				assert!(
					hello
						.capabilities
						.contains(&capabilities::CLIENT_PING_PONG.into())
				);
				hello
			},
			other => panic!("expected hello, got {other:?}"),
		}
	}

	async fn connect(
		handle: &ServerHandle,
		token: &str,
	) -> tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<TcpStream>> {
		let url = format!("ws://{}/?token={}", handle.addr(), token);
		let (ws, _resp) = connect_async(url).await.expect("connect");
		ws
	}

	async fn wait_for_controlled_delivery(handle: &ServerHandle) {
		for _ in 0..200 {
			if handle.state.connections.lock().values().any(|connection| {
				connection.negotiation == Negotiation::TimedOut
					&& matches!(
						connection.delivered,
						Some(Delivered { presentation: Presentation::Unavailable, .. })
					)
			}) {
				return;
			}
			tokio::task::yield_now().await;
		}
		panic!("controlled ask was not delivered after hello timeout");
	}

	#[test]
	fn event_replay_is_a_v3_frame() {
		assert!(is_v3_frame(r#"{"type":"event_replay","id":"replay-1"}"#));
	}

	#[tokio::test]
	async fn hello_publishes_negotiated_capabilities() {
		let handle = start(ServerConfig::new("s", "secret")).await.unwrap();
		let mut updates = handle
			.take_capability_receiver()
			.expect("capability receiver");
		let mut ws = connect(&handle, "secret").await;
		next_server_hello(&mut ws).await;
		send_hello(&mut ws, vec![capabilities::TOOL_ACTIVITY_V1.into()]).await;

		let update = tokio::time::timeout(Duration::from_secs(2), updates.recv())
			.await
			.expect("timed out waiting for capability update")
			.expect("capability receiver closed");
		assert_eq!(update.capabilities, vec![capabilities::TOOL_ACTIVITY_V1]);
		assert!(!update.connection_id.is_empty());
		handle.stop();
	}

	#[tokio::test]
	async fn event_replay_forwards_authoritative_capabilities() {
		let handle = start(ServerConfig::new("s", "secret")).await.unwrap();
		let mut frames = handle.take_frame_receiver().expect("frame receiver");
		let mut updates = handle
			.take_capability_receiver()
			.expect("capability receiver");
		let mut ws = connect(&handle, "secret").await;
		next_server_hello(&mut ws).await;
		send_hello(&mut ws, vec![capabilities::TOOL_ACTIVITY_V1.into()]).await;
		updates.recv().await.expect("capability update");
		ws.send(Message::Text(r#"{"type":"event_replay","id":"replay-1"}"#.into()))
			.await
			.unwrap();

		let (_, frame) = tokio::time::timeout(Duration::from_secs(2), frames.recv())
			.await
			.expect("timed out waiting for replay frame")
			.expect("frame receiver closed");
		let frame: serde_json::Value = serde_json::from_str(&frame).unwrap();
		assert_eq!(frame["capabilities"], serde_json::json!([capabilities::TOOL_ACTIVITY_V1]));
		handle.stop();
	}

	#[tokio::test]
	async fn tool_activity_is_sent_only_to_capable_clients() {
		let handle = start(ServerConfig::new("s", "secret")).await.unwrap();
		let mut updates = handle
			.take_capability_receiver()
			.expect("capability receiver");
		let mut non_capable = connect(&handle, "secret").await;
		next_server_hello(&mut non_capable).await;
		send_hello(&mut non_capable, vec![]).await;
		let mut capable = connect(&handle, "secret").await;
		next_server_hello(&mut capable).await;
		send_hello(&mut capable, vec![capabilities::TOOL_ACTIVITY_V1.into()]).await;
		wait_for_clients(&handle, 2).await;
		for _ in 0..2 {
			tokio::time::timeout(Duration::from_secs(2), updates.recv())
				.await
				.expect("timed out waiting for capability update")
				.expect("capability receiver closed");
		}

		handle
			.push_frame(ServerMessage::ToolActivity(ToolActivity {
				session_id:     "s".into(),
				tool_call_id:   "call-1".into(),
				tool_name:      "functions.read".into(),
				phase:          ToolActivityPhase::Started,
				args_summary:   None,
				result_summary: None,
				is_error:       None,
			}))
			.unwrap();

		assert!(matches!(
			next_server_msg(&mut capable).await,
			ServerMessage::ToolActivity(activity) if activity.tool_call_id == "call-1"
		));
		assert!(
			tokio::time::timeout(Duration::from_millis(100), non_capable.next())
				.await
				.is_err()
		);
		handle.stop();
	}

	#[tokio::test]
	async fn start_binds_ephemeral_port() {
		let handle = start(ServerConfig::new("s", "secret")).await.unwrap();
		assert_ne!(handle.addr().port(), 0);
		assert!(handle.addr().ip().is_loopback());
		handle.stop();
	}

	#[tokio::test]
	async fn wrong_token_is_rejected() {
		let handle = start(ServerConfig::new("s", "secret")).await.unwrap();
		let url = format!("ws://{}/?token=wrong", handle.addr());
		assert!(connect_async(url).await.is_err());
		handle.stop();
	}

	#[tokio::test]
	async fn workflow_gate_correlation_survives_same_server_replay() {
		let handle = start(ServerConfig::new("s", "secret")).await.unwrap();
		handle
			.register_workflow_gate_ask(ask("presentation-1"), "gate-1".into(), true)
			.unwrap();

		let mut first = connect(&handle, "secret").await;
		let _ = next_server_hello(&mut first).await;
		let first_raw = first
			.next()
			.await
			.expect("workflow frame")
			.expect("websocket frame");
		let Message::Text(first_raw) = first_raw else {
			panic!("expected workflow text frame")
		};
		let first_workflow = crate::protocol::decode_workflow_gate_action_needed(first_raw.as_str())
			.unwrap()
			.expect("workflow correlation");
		assert_eq!(first_workflow.action.id, "presentation-1");
		assert_eq!(first_workflow.workflow_gate_id, "gate-1");

		let mut replay = connect(&handle, "secret").await;
		let _ = next_server_hello(&mut replay).await;
		let replay_raw = replay
			.next()
			.await
			.expect("replayed workflow frame")
			.expect("websocket frame");
		let Message::Text(replay_raw) = replay_raw else {
			panic!("expected replay text frame")
		};
		let replay_workflow =
			crate::protocol::decode_workflow_gate_action_needed(replay_raw.as_str())
				.unwrap()
				.expect("replayed workflow correlation");
		assert_eq!(replay_workflow, first_workflow);
		handle.stop();
	}

	#[tokio::test]
	async fn empty_workflow_gate_correlation_is_rejected_without_registry_mutation() {
		let handle = start(ServerConfig::new("s", "secret")).await.unwrap();
		handle.register_ask(ask("existing"), true);
		let identity = handle.current_identity();

		assert_eq!(
			handle.register_workflow_gate_ask(ask("replacement"), String::new(), true),
			Err(WorkflowGateRegistrationError::EmptyWorkflowGateId)
		);
		assert_eq!(handle.current_identity(), identity);
		assert!(handle.current_workflow_gate_ask().is_none());
		handle.stop();
	}

	#[tokio::test]
	async fn ask_broadcast_then_reply_resolves() {
		let handle = start(ServerConfig::new("s", "secret")).await.unwrap();
		let mut ws = connect(&handle, "secret").await;
		next_server_hello(&mut ws).await;
		// wait for the client to be subscribed before broadcasting
		wait_for_clients(&handle, 1).await;

		handle.register_ask(ask("a1"), true);
		let got = next_server_msg(&mut ws).await;
		assert!(
			matches!(got, ServerMessage::ActionNeeded(a) if a.id == "a1" && a.kind == ActionKind::Ask)
		);

		let reply = Reply {
			id:              "a1".into(),
			answer:          ReplyAnswer::Index(0),
			token:           "secret".into(),
			idempotency_key: None,
		};
		ws.send(Message::Text(serde_json::to_string(&ClientMessage::Reply(reply)).unwrap()))
			.await
			.unwrap();

		let resolved = next_server_msg(&mut ws).await;
		match resolved {
			ServerMessage::ActionResolved(r) => {
				assert_eq!(r.id, "a1");
				assert_eq!(r.resolved_by, crate::protocol::ResolvedBy::Client);
			},
			other => panic!("expected action_resolved, got {other:?}"),
		}
		handle.stop();
	}

	#[tokio::test]
	async fn mixed_clients_receive_capability_tailored_controlled_presentations() {
		let handle = start(ServerConfig::new("s", "secret")).await.unwrap();
		let mut v2 = connect(&handle, "secret").await;
		next_server_hello(&mut v2).await;
		let mut v3 = connect(&handle, "secret").await;
		next_server_hello(&mut v3).await;
		send_hello(&mut v2, vec![]).await;
		send_hello(&mut v3, vec![capabilities::ASK_CONTROLS_V1.into()]).await;
		wait_for_clients(&handle, 2).await;

		handle.register_ask(controlled_ask("a1"), true);
		assert!(matches!(
			next_server_msg(&mut v2).await,
			ServerMessage::ActionUnavailable(ActionUnavailable { id, reason: ActionUnavailableReason::MissingCapability, .. }) if id == "a1"
		));
		assert!(matches!(
			next_server_msg(&mut v3).await,
			ServerMessage::ActionNeeded(needed) if needed.id == "a1" && !needed.controls.is_empty()
		));
		handle.stop();
	}

	#[test]
	fn controlled_ask_defers_before_hello_then_times_out_unavailable() {
		run_paused_test(async {
			let handle = start(ServerConfig::new("s", "secret")).await.unwrap();
			let mut ws = connect(&handle, "secret").await;
			next_server_hello(&mut ws).await;
			tokio::task::yield_now().await;
			handle.register_ask(controlled_ask("a1"), true);
			tokio::task::yield_now().await;
			assert!(
				handle
					.state
					.connections
					.lock()
					.values()
					.all(|connection| connection.delivered.is_none())
			);

			tokio::time::advance(CLIENT_HELLO_GRACE).await;
			wait_for_controlled_delivery(&handle).await;
			assert!(matches!(
				next_server_msg_after_delivery(&mut ws).await,
				ServerMessage::ActionUnavailable(ActionUnavailable { id, .. }) if id == "a1"
			));
			handle.stop();
		});
	}

	#[test]
	fn hello_timeout_persists_when_idle_for_later_controlled_ask() {
		run_paused_test(async {
			let handle = start(ServerConfig::new("s", "secret")).await.unwrap();
			let mut ws = connect(&handle, "secret").await;
			next_server_hello(&mut ws).await;
			tokio::task::yield_now().await;
			tokio::time::advance(CLIENT_HELLO_GRACE).await;
			tokio::task::yield_now().await;

			handle.register_ask(controlled_ask("a1"), true);
			wait_for_controlled_delivery(&handle).await;
			assert!(matches!(
				next_server_msg_after_delivery(&mut ws).await,
				ServerMessage::ActionUnavailable(ActionUnavailable { id, .. }) if id == "a1"
			));
			handle.stop();
		});
	}

	#[tokio::test]
	async fn unavailable_controlled_ask_upgrades_once_after_capable_hello() {
		let handle = start(ServerConfig::new("s", "secret")).await.unwrap();
		let mut ws = connect(&handle, "secret").await;
		next_server_hello(&mut ws).await;
		send_hello(&mut ws, vec![]).await;
		handle.register_ask(controlled_ask("a1"), true);
		assert!(matches!(
			next_server_msg(&mut ws).await,
			ServerMessage::ActionUnavailable(ActionUnavailable { id, .. }) if id == "a1"
		));

		send_hello(&mut ws, vec![capabilities::ASK_CONTROLS_V1.into()]).await;
		assert!(matches!(
			next_server_msg(&mut ws).await,
			ServerMessage::ActionNeeded(needed) if needed.id == "a1" && !needed.controls.is_empty()
		));
		handle.stop();
	}

	#[tokio::test]
	async fn repeated_reduced_hello_never_downgrades_full_controlled_delivery() {
		let handle = start(ServerConfig::new("s", "secret")).await.unwrap();
		let mut ws = connect(&handle, "secret").await;
		next_server_hello(&mut ws).await;
		send_hello(&mut ws, vec![capabilities::ASK_CONTROLS_V1.into()]).await;
		handle.register_ask(controlled_ask("a1"), true);
		let _ = next_server_msg(&mut ws).await;

		send_hello(&mut ws, vec![]).await;
		tokio::task::yield_now().await;
		let connection = handle.state.connections.lock().values().next().cloned();
		assert!(matches!(
			connection,
			Some(Connection {
				negotiation: Negotiation::Negotiated,
				delivered: Some(Delivered { presentation: Presentation::Full, .. }),
				capabilities,
				..
			}) if capabilities.contains(&capabilities::ASK_CONTROLS_V1.into())
		));
		handle.stop();
	}

	#[tokio::test]
	async fn non_capable_controlled_reply_is_rejected_without_claim() {
		let mut config = ServerConfig::new("s", "secret");
		config.forward_replies = true;
		let handle = start(config).await.unwrap();
		let mut ws = connect(&handle, "secret").await;
		next_server_hello(&mut ws).await;
		send_hello(&mut ws, vec![]).await;
		handle.register_ask(controlled_ask("a1"), true);
		let _ = next_server_msg(&mut ws).await;
		ws.send(Message::Text(
			serde_json::to_string(&ClientMessage::Reply(Reply {
				id:              "a1".into(),
				answer:          ReplyAnswer::Index(0),
				token:           "secret".into(),
				idempotency_key: None,
			}))
			.unwrap(),
		))
		.await
		.unwrap();
		assert!(matches!(
			next_server_msg(&mut ws).await,
			ServerMessage::ReplyRejected(ReplyRejected { id, reason: RejectReason::InvalidAnswer }) if id == "a1"
		));
		assert!(!handle.state.registry.lock().has_claim_for_action("a1"));
		handle.stop();
	}

	#[tokio::test]
	async fn pending_same_id_registration_is_rejected_without_replacing_delivery_identity() {
		let handle = start(ServerConfig::new("s", "secret")).await.unwrap();
		handle.register_ask(controlled_ask("a1"), true);
		let original = handle.current_identity().expect("original identity");

		assert_eq!(
			handle.try_register_ask(controlled_ask("a1"), true),
			Err(ActionRegistrationError::ActionIdAlreadyRegistered)
		);
		assert_eq!(handle.current_identity(), Some(original));
		handle.stop();
	}

	#[tokio::test]
	async fn deferred_stale_reevaluation_never_writes_resolved_or_replaced_ask() {
		let handle = start(ServerConfig::new("s", "secret")).await.unwrap();
		handle.register_ask(controlled_ask("old"), true);
		let mut ws = connect(&handle, "secret").await;
		next_server_hello(&mut ws).await;
		tokio::task::yield_now().await;
		handle.resolve_local("old", None);
		assert!(matches!(
			next_server_msg(&mut ws).await,
			ServerMessage::ActionResolved(resolved) if resolved.id == "old"
		));
		handle.register_ask(controlled_ask("new"), true);
		send_hello(&mut ws, vec![capabilities::ASK_CONTROLS_V1.into()]).await;
		assert!(matches!(
			next_server_msg(&mut ws).await,
			ServerMessage::ActionNeeded(needed) if needed.id == "new"
		));
		handle.stop();
	}

	#[tokio::test]
	async fn reconnect_resets_controlled_delivery_authority_for_the_new_generation() {
		let handle = start(ServerConfig::new("s", "secret")).await.unwrap();
		let mut first = connect(&handle, "secret").await;
		next_server_hello(&mut first).await;
		send_hello(&mut first, vec![capabilities::ASK_CONTROLS_V1.into()]).await;
		handle.register_ask(controlled_ask("a1"), true);
		assert!(matches!(next_server_msg(&mut first).await, ServerMessage::ActionNeeded(_)));
		first.close(None).await.unwrap();
		tokio::time::timeout(Duration::from_secs(1), async {
			loop {
				if handle.state.connections.lock().is_empty() {
					break;
				}
				tokio::task::yield_now().await;
			}
		})
		.await
		.expect("first generation removed");

		let mut second = connect(&handle, "secret").await;
		next_server_hello(&mut second).await;
		let new_connection = handle.state.connections.lock().values().next().cloned();
		assert!(matches!(
			new_connection,
			Some(Connection {
				negotiation: Negotiation::AwaitingHello,
				delivered: None,
				capabilities,
				..
			}) if capabilities.is_empty()
		));

		second
			.send(Message::Text(
				serde_json::to_string(&ClientMessage::Reply(Reply {
					id:              "a1".into(),
					answer:          ReplyAnswer::Index(0),
					token:           "secret".into(),
					idempotency_key: None,
				}))
				.unwrap(),
			))
			.await
			.unwrap();
		assert!(matches!(
			next_server_msg(&mut second).await,
			ServerMessage::ReplyRejected(ReplyRejected { reason: RejectReason::InvalidAnswer, .. })
		));

		send_hello(&mut second, vec![]).await;
		assert!(matches!(
			next_server_msg(&mut second).await,
			ServerMessage::ActionUnavailable(ActionUnavailable { id, .. }) if id == "a1"
		));
		handle.stop();
	}

	#[tokio::test]
	async fn push_frame_broadcasts_threaded_frames_and_preserves_ask() {
		use crate::protocol::{EphemeralTurnResult, IdentityHeader, TurnPhase, TurnStream};
		let handle = start(ServerConfig::new("s", "secret")).await.unwrap();
		let mut ws = connect(&handle, "secret").await;
		next_server_hello(&mut ws).await;
		wait_for_clients(&handle, 1).await;

		handle
			.push_frame(ServerMessage::IdentityHeader(IdentityHeader {
				session_id: "s".into(),
				repo:       "gajae-code".into(),
				branch:     "feat/notification-surface".into(),
				machine:    "m1".into(),
				title:      Some("Session".into()),
			}))
			.unwrap();
		match next_server_msg(&mut ws).await {
			ServerMessage::IdentityHeader(h) => assert_eq!(h.repo, "gajae-code"),
			other => panic!("expected identity_header, got {other:?}"),
		}

		handle
			.push_frame(ServerMessage::TurnStream(TurnStream {
				session_id:   "s".into(),
				phase:        TurnPhase::Finalized,
				text:         "done".into(),
				final_answer: None,
				message_ref:  None,
			}))
			.unwrap();
		match next_server_msg(&mut ws).await {
			ServerMessage::TurnStream(t) => {
				assert_eq!(t.phase, TurnPhase::Finalized);
				assert_eq!(t.text, "done");
			},
			other => panic!("expected turn_stream, got {other:?}"),
		}
		handle
			.push_frame(ServerMessage::EphemeralTurnResult(EphemeralTurnResult {
				session_id: "s".into(),
				request_id: "btw:123e4567-e89b-42d3-a456-426614174000".into(),
				update_id:  7,
				message_id: 8,
				thread_id:  "42".into(),
				status:     crate::protocol::EphemeralTurnStatus::Ok,
				text:       Some("side answer".into()),
			}))
			.unwrap();
		match next_server_msg(&mut ws).await {
			ServerMessage::EphemeralTurnResult(result) => {
				assert_eq!(result.request_id, "btw:123e4567-e89b-42d3-a456-426614174000");
				assert_eq!(result.update_id, 7);
				assert_eq!(result.message_id, 8);
			},
			other => panic!("expected ephemeral_turn_result, got {other:?}"),
		}

		// Asks share the connection-local reevaluation path alongside streaming frames.
		handle.register_ask(ask("a1"), true);
		match next_server_msg(&mut ws).await {
			ServerMessage::ActionNeeded(a) => assert_eq!(a.id, "a1"),
			other => panic!("expected action_needed, got {other:?}"),
		}
		handle.stop();
	}

	#[tokio::test]
	async fn push_frame_rejects_asks_and_egress_filter_allows_only_idle_broadcasts() {
		let handle = start(ServerConfig::new("s", "secret")).await.unwrap();
		let mut ws = connect(&handle, "secret").await;
		next_server_hello(&mut ws).await;
		wait_for_clients(&handle, 1).await;

		assert_eq!(
			handle.push_frame(ServerMessage::ActionNeeded(controlled_ask("blocked"))),
			Err(PushFrameError::ActionNeededProhibited),
		);
		let _ = handle
			.state
			.tx
			.send(ServerMessage::ActionNeeded(controlled_ask("injected")));
		assert!(
			tokio::time::timeout(Duration::from_millis(50), ws.next())
				.await
				.is_err()
		);

		handle.note_idle(idle("idle-1"));
		assert!(matches!(
			next_server_msg(&mut ws).await,
			ServerMessage::ActionNeeded(needed)
				if needed.kind == ActionKind::Idle && needed.id == "idle-1" && needed.controls.is_empty()
		));
		handle.stop();
	}

	#[tokio::test]
	async fn unknown_action_reply_is_rejected_to_sender() {
		let handle = start(ServerConfig::new("s", "secret")).await.unwrap();
		let mut ws = connect(&handle, "secret").await;
		next_server_hello(&mut ws).await;
		wait_for_clients(&handle, 1).await;

		let reply = Reply {
			id:              "ghost".into(),
			answer:          ReplyAnswer::Index(0),
			token:           "secret".into(),
			idempotency_key: None,
		};
		ws.send(Message::Text(serde_json::to_string(&ClientMessage::Reply(reply)).unwrap()))
			.await
			.unwrap();

		let rejected = next_server_msg(&mut ws).await;
		match rejected {
			ServerMessage::ReplyRejected(r) => {
				assert_eq!(r.id, "ghost");
				assert_eq!(r.reason, crate::protocol::RejectReason::UnknownAction);
			},
			other => panic!("expected reply_rejected, got {other:?}"),
		}
		handle.stop();
	}

	#[tokio::test]
	async fn late_client_gets_buffered_ask_replay() {
		let handle = start(ServerConfig::new("s", "secret")).await.unwrap();
		// register before any client connects
		handle.register_ask(ask("a1"), true);
		// connect afterwards: should receive the buffered ask on connect
		let mut ws = connect(&handle, "secret").await;
		next_server_hello(&mut ws).await;
		let got = next_server_msg(&mut ws).await;
		assert!(matches!(got, ServerMessage::ActionNeeded(a) if a.id == "a1"));
		handle.stop();
	}

	#[tokio::test]
	async fn hello_before_replay() {
		let handle = start(ServerConfig::new("s", "secret")).await.unwrap();
		handle.register_ask(ask("a1"), true);

		let mut ws = connect(&handle, "secret").await;
		let hello = next_server_hello(&mut ws).await;
		assert_eq!(hello.capabilities, vec![
			capabilities::THREADED,
			capabilities::CONTEXT,
			capabilities::TURN_STREAM,
			capabilities::IMAGES,
			capabilities::CONFIG,
			capabilities::CLIENT_PING_PONG,
			capabilities::SESSION_READY,
			capabilities::ASK_CONTROLS_V1,
			capabilities::ASK_SELECTED_ACK_V1,
			capabilities::TOOL_ACTIVITY_V1,
			capabilities::EPHEMERAL_TURN_V1,
		]);

		match next_server_msg(&mut ws).await {
			ServerMessage::ActionNeeded(a) => assert_eq!(a.id, "a1"),
			other => panic!("expected replayed action_needed, got {other:?}"),
		}
		handle.stop();
	}

	#[tokio::test]
	async fn ping_gets_pong() {
		let handle = start(ServerConfig::new("s", "secret")).await.unwrap();
		let mut sender = connect(&handle, "secret").await;
		next_server_hello(&mut sender).await;
		let mut other = connect(&handle, "secret").await;
		next_server_hello(&mut other).await;
		wait_for_clients(&handle, 2).await;

		sender
			.send(Message::Text(
				serde_json::to_string(&ClientMessage::Ping(Ping { nonce: "n1".into() })).unwrap(),
			))
			.await
			.unwrap();

		match next_server_msg(&mut sender).await {
			ServerMessage::Pong(p) => assert_eq!(p.nonce, "n1"),
			other => panic!("expected pong, got {other:?}"),
		}
		let broadcast =
			tokio::time::timeout(std::time::Duration::from_millis(300), next_server_msg(&mut other))
				.await;
		assert!(broadcast.is_err(), "pong must not be broadcast");
		handle.stop();
	}

	#[tokio::test]
	async fn resolve_local_broadcasts_resolved() {
		let handle = start(ServerConfig::new("s", "secret")).await.unwrap();
		let mut ws = connect(&handle, "secret").await;
		next_server_hello(&mut ws).await;
		wait_for_clients(&handle, 1).await;
		handle.register_ask(ask("a1"), true);
		let _needed = next_server_msg(&mut ws).await;

		handle.resolve_local("a1", None);
		let resolved = next_server_msg(&mut ws).await;
		match resolved {
			ServerMessage::ActionResolved(r) => {
				assert_eq!(r.id, "a1");
				assert_eq!(r.resolved_by, crate::protocol::ResolvedBy::Local);
			},
			other => panic!("expected action_resolved local, got {other:?}"),
		}
		handle.stop();
	}

	#[tokio::test]
	async fn stop_is_idempotent() {
		let handle = start(ServerConfig::new("s", "secret")).await.unwrap();
		handle.stop();
		handle.stop();
		handle.stop();
	}

	#[tokio::test]
	async fn awaited_stop_joins_half_open_and_established_connections_idempotently() {
		let handle = start(ServerConfig::new("s", "secret")).await.unwrap();
		let half_open = TcpStream::connect(handle.addr()).await.unwrap();
		let mut ws = connect(&handle, "secret").await;
		next_server_hello(&mut ws).await;
		wait_for_clients(&handle, 1).await;

		let left = handle.clone();
		let right = handle.clone();
		tokio::time::timeout(Duration::from_secs(1), async move {
			tokio::join!(left.stop_and_wait(), right.stop_and_wait());
		})
		.await
		.expect("awaited stop joins every accepted connection");

		drop(half_open);
		assert_eq!(handle.client_count(), 0);
		handle.stop_and_wait().await;
	}

	#[tokio::test]
	async fn forward_mode_routes_reply_to_host_then_resolves() {
		let mut config = ServerConfig::new("s", "secret");
		config.forward_replies = true;
		let handle = start(config).await.unwrap();
		let mut rx = handle.take_reply_receiver().expect("forward receiver");
		assert!(handle.take_reply_receiver().is_none(), "receiver is take-once");

		let mut ws = connect(&handle, "secret").await;
		next_server_hello(&mut ws).await;
		wait_for_clients(&handle, 1).await;
		handle.register_ask(ask("a1"), true);
		let _needed = next_server_msg(&mut ws).await;

		let reply = Reply {
			id:              "a1".into(),
			answer:          ReplyAnswer::Index(1),
			token:           "secret".into(),
			idempotency_key: None,
		};
		ws.send(Message::Text(serde_json::to_string(&ClientMessage::Reply(reply)).unwrap()))
			.await
			.unwrap();

		let fwd = tokio::time::timeout(std::time::Duration::from_secs(2), rx.recv())
			.await
			.expect("forward timeout")
			.expect("reply forwarded");
		assert_eq!(fwd.reply.id, "a1");

		assert_eq!(fwd.reply.answer, ReplyAnswer::Index(1));

		assert!(!handle.resolve_client("a1", Some(ReplyAnswer::Index(1)), None));
		assert!(!handle.resolve_claim("stale-receipt", Some(ReplyAnswer::Index(1)), None));
		assert!(!handle.close_claim_invalid("stale-receipt"));
		assert!(!handle.cancel_claim("stale-receipt"));
		assert!(handle.resolve_claim(&fwd.reply_receipt_id, Some(ReplyAnswer::Index(1)), None));
		let resolved = next_server_msg(&mut ws).await;
		assert!(
			matches!(resolved, ServerMessage::ActionResolved(r) if r.id == "a1" && r.resolved_by == crate::protocol::ResolvedBy::Client)
		);
		handle.stop();
	}

	#[tokio::test]
	async fn live_selected_ack_is_origin_bound_and_correlated() {
		let mut config = ServerConfig::new("s", "secret");
		config.forward_replies = true;
		let handle = start(config).await.unwrap();
		let mut replies = handle.take_reply_receiver().expect("forward receiver");
		let mut ws = connect(&handle, "secret").await;
		next_server_hello(&mut ws).await;
		ws.send(Message::Text(
			serde_json::to_string(&ClientMessage::Hello(ClientHello {
				protocol_version: PROTOCOL_VERSION,
				capabilities:     vec![capabilities::ASK_SELECTED_ACK_V1.into()],
			}))
			.unwrap(),
		))
		.await
		.unwrap();
		wait_for_clients(&handle, 1).await;
		handle.register_ask(ask("a1"), true);
		let _ = next_server_msg(&mut ws).await;
		let reply = Reply {
			id:              "a1".into(),
			answer:          ReplyAnswer::Index(0),
			token:           "secret".into(),
			idempotency_key: Some("k1".into()),
		};
		ws.send(Message::Text(serde_json::to_string(&ClientMessage::Reply(reply)).unwrap()))
			.await
			.unwrap();
		let claim = replies.recv().await.expect("claimed reply");
		let request = AskSelectedAckRequest::Live {
			request_id:  "r1".into(),
			commit_key:  "c1".into(),
			action_id:   "a1".into(),
			deadline_at: (std::time::SystemTime::now()
				.duration_since(std::time::UNIX_EPOCH)
				.unwrap()
				.as_millis()
				+ 5_000) as i64,
		};
		let request_task = {
			let handle = handle.clone();
			let receipt = claim.reply_receipt_id.clone();
			tokio::spawn(async move { handle.request_ask_selected_ack(&receipt, request).await })
		};
		assert!(matches!(
			next_server_msg(&mut ws).await,
			ServerMessage::AskSelectedAckRequest(AskSelectedAckRequest::Live { request_id, commit_key, .. })
				if request_id == "r1" && commit_key == "c1"
		));
		let mut wrong_origin = connect(&handle, "secret").await;
		next_server_hello(&mut wrong_origin).await;
		let _ = next_server_msg(&mut wrong_origin).await;
		wrong_origin
			.send(Message::Text(
				serde_json::to_string(&ClientMessage::AskSelectedAckResult(
					crate::protocol::AskSelectedAckResult {
						request_id: "r1".into(),
						commit_key: "c1".into(),
						outcome:    AskSelectedAckOutcome::Delivered { message_id: 99 },
					},
				))
				.unwrap(),
			))
			.await
			.unwrap();
		tokio::time::sleep(Duration::from_millis(20)).await;
		assert!(!request_task.is_finished(), "wrong-origin result settled request");
		ws.send(Message::Text(
			serde_json::to_string(&ClientMessage::AskSelectedAckResult(
				crate::protocol::AskSelectedAckResult {
					request_id: "r1".into(),
					commit_key: "c1".into(),
					outcome:    AskSelectedAckOutcome::Delivered { message_id: 42 },
				},
			))
			.unwrap(),
		))
		.await
		.unwrap();
		assert_eq!(request_task.await.unwrap(), AskSelectedAckOutcome::Delivered { message_id: 42 });
		handle.resolve_claim(&claim.reply_receipt_id, Some(ReplyAnswer::Index(0)), Some("k1".into()));
		assert!(matches!(next_server_msg(&mut ws).await, ServerMessage::ActionResolved(_)));
		handle.stop();
	}

	#[tokio::test]
	async fn dispatched_acknowledgement_disconnect_is_unknown() {
		let mut config = ServerConfig::new("s", "secret");
		config.forward_replies = true;
		let handle = start(config).await.unwrap();
		let mut replies = handle.take_reply_receiver().expect("forward receiver");
		let mut ws = connect(&handle, "secret").await;
		next_server_hello(&mut ws).await;
		ws.send(Message::Text(
			serde_json::to_string(&ClientMessage::Hello(ClientHello {
				protocol_version: PROTOCOL_VERSION,
				capabilities:     vec![capabilities::ASK_SELECTED_ACK_V1.into()],
			}))
			.unwrap(),
		))
		.await
		.unwrap();
		handle.register_ask(ask("a1"), true);
		let _ = next_server_msg(&mut ws).await;
		ws.send(Message::Text(
			serde_json::to_string(&ClientMessage::Reply(Reply {
				id:              "a1".into(),
				answer:          ReplyAnswer::Index(0),
				token:           "secret".into(),
				idempotency_key: Some("k1".into()),
			}))
			.unwrap(),
		))
		.await
		.unwrap();
		let claim = replies.recv().await.expect("claimed reply");
		let task = {
			let handle = handle.clone();
			let receipt = claim.reply_receipt_id.clone();
			tokio::spawn(async move {
				handle
					.request_ask_selected_ack(&receipt, AskSelectedAckRequest::Live {
						request_id:  "disconnect-request".into(),
						commit_key:  "disconnect-commit".into(),
						action_id:   "a1".into(),
						deadline_at: (std::time::SystemTime::now()
							.duration_since(std::time::UNIX_EPOCH)
							.unwrap()
							.as_millis() + 5_000) as i64,
					})
					.await
			})
		};
		assert!(matches!(next_server_msg(&mut ws).await, ServerMessage::AskSelectedAckRequest(_)));
		ws.close(None).await.unwrap();
		assert_eq!(task.await.unwrap(), AskSelectedAckOutcome::Unknown {
			reason: AskSelectedAckUnknownReason::OriginDisconnected,
		});
		handle.stop();
	}

	#[tokio::test]
	async fn stop_terminalizes_pending_acknowledgement_and_preserves_cancel_reason() {
		let handle = start(ServerConfig::new("s", "secret")).await.unwrap();
		let mut ws = connect(&handle, "secret").await;
		next_server_hello(&mut ws).await;
		ws.send(Message::Text(
			serde_json::to_string(&ClientMessage::Hello(ClientHello {
				protocol_version: PROTOCOL_VERSION,
				capabilities:     vec![capabilities::ASK_SELECTED_ACK_V1.into()],
			}))
			.unwrap(),
		))
		.await
		.unwrap();
		wait_for_clients(&handle, 1).await;
		tokio::time::sleep(Duration::from_millis(20)).await;
		let task = {
			let handle = handle.clone();
			tokio::spawn(async move {
				handle
					.request_recovered_ask_selected_ack(AskSelectedAckRequest::Recovery {
						request_id:  "shutdown-request".into(),
						commit_key:  "shutdown-commit".into(),
						session_id:  "s".into(),
						action_id:   "a1".into(),
						deadline_at: (std::time::SystemTime::now()
							.duration_since(std::time::UNIX_EPOCH)
							.unwrap()
							.as_millis() + 5_000) as i64,
					})
					.await
			})
		};
		assert!(matches!(next_server_msg(&mut ws).await, ServerMessage::AskSelectedAckRequest(_)));
		handle.stop();
		assert_eq!(task.await.unwrap(), AskSelectedAckOutcome::Unknown {
			reason: AskSelectedAckUnknownReason::Shutdown,
		});
		assert_eq!(
			handle
				.request_ack(
					AskSelectedAckRequest::Recovery {
						request_id:  "after-stop-request".into(),
						commit_key:  "after-stop-commit".into(),
						session_id:  "s".into(),
						action_id:   "a2".into(),
						deadline_at: (std::time::SystemTime::now()
							.duration_since(std::time::UNIX_EPOCH)
							.unwrap()
							.as_millis() + 5_000) as i64,
					},
					None
				)
				.await,
			AskSelectedAckOutcome::Unknown { reason: AskSelectedAckUnknownReason::Shutdown }
		);
		assert!(matches!(
			next_server_msg(&mut ws).await,
			ServerMessage::AskSelectedAckCancel(AskSelectedAckCancel {
				reason: AskSelectedAckCancelReason::SessionShutdown,
				..
			})
		));
	}

	#[tokio::test]
	async fn live_selected_ack_requires_capability() {
		let mut config = ServerConfig::new("s", "secret");
		config.forward_replies = true;
		let handle = start(config).await.unwrap();
		let mut replies = handle.take_reply_receiver().expect("forward receiver");
		let mut ws = connect(&handle, "secret").await;
		next_server_hello(&mut ws).await;
		wait_for_clients(&handle, 1).await;
		handle.register_ask(ask("a1"), true);
		let _ = next_server_msg(&mut ws).await;
		let reply = Reply {
			id:              "a1".into(),
			answer:          ReplyAnswer::Index(0),
			token:           "secret".into(),
			idempotency_key: None,
		};
		ws.send(Message::Text(serde_json::to_string(&ClientMessage::Reply(reply)).unwrap()))
			.await
			.unwrap();
		let claim = replies.recv().await.expect("claimed reply");
		let outcome = handle
			.request_ask_selected_ack(&claim.reply_receipt_id, AskSelectedAckRequest::Live {
				request_id:  "r1".into(),
				commit_key:  "c1".into(),
				action_id:   "a1".into(),
				deadline_at: 123,
			})
			.await;
		assert_eq!(outcome, AskSelectedAckOutcome::Failed {
			reason: AskSelectedAckFailedReason::Unsupported,
		});
		handle.stop();
	}

	#[tokio::test]
	async fn dropped_host_receiver_terminalizes_claim_instead_of_orphaning_it() {
		let mut config = ServerConfig::new("s", "secret");
		config.forward_replies = true;
		let handle = start(config).await.unwrap();
		drop(handle.take_reply_receiver().expect("forward receiver"));
		let mut ws = connect(&handle, "secret").await;
		next_server_hello(&mut ws).await;
		wait_for_clients(&handle, 1).await;
		handle.register_ask(ask("a1"), true);
		let _ = next_server_msg(&mut ws).await;
		let reply = Reply {
			id:              "a1".into(),
			answer:          ReplyAnswer::Index(0),
			token:           "secret".into(),
			idempotency_key: None,
		};
		ws.send(Message::Text(serde_json::to_string(&ClientMessage::Reply(reply)).unwrap()))
			.await
			.unwrap();
		assert!(matches!(
			next_server_msg(&mut ws).await,
			ServerMessage::ActionResolved(resolved) if resolved.id == "a1" && resolved.answer.is_none()
		));
		handle.stop();
	}

	#[tokio::test]
	async fn forward_mode_rejects_unknown_action_without_host() {
		let mut config = ServerConfig::new("s", "secret");
		config.forward_replies = true;
		let handle = start(config).await.unwrap();
		let _rx = handle.take_reply_receiver();
		let mut ws = connect(&handle, "secret").await;
		next_server_hello(&mut ws).await;
		wait_for_clients(&handle, 1).await;

		let reply = Reply {
			id:              "ghost".into(),
			answer:          ReplyAnswer::Index(0),
			token:           "secret".into(),
			idempotency_key: None,
		};
		ws.send(Message::Text(serde_json::to_string(&ClientMessage::Reply(reply)).unwrap()))
			.await
			.unwrap();
		let rejected = next_server_msg(&mut ws).await;
		assert!(
			matches!(rejected, ServerMessage::ReplyRejected(r) if r.id == "ghost" && r.reason == crate::protocol::RejectReason::UnknownAction)
		);
		handle.stop();
	}

	#[tokio::test]
	async fn writes_and_removes_endpoint_discovery_file() {
		let root = std::env::temp_dir().join(format!(
			"gjc-notif-srv-{}-{}",
			std::process::id(),
			std::time::SystemTime::now()
				.duration_since(std::time::UNIX_EPOCH)
				.unwrap()
				.as_nanos()
		));
		std::fs::create_dir_all(&root).unwrap();

		let mut config = ServerConfig::new("sess-disc", "secret");
		config.state_root = Some(root.clone());
		let handle = start(config).await.unwrap();

		let path = crate::discovery::endpoint_path(&root, "sess-disc");
		let record = crate::discovery::read_endpoint(&path).expect("endpoint file written");
		assert_eq!(record.port, handle.addr().port());
		assert_eq!(record.token, "secret");
		assert!(record.url.starts_with("ws://127.0.0.1:"));

		handle.stop();
		assert!(crate::discovery::read_endpoint(&path).is_none(), "endpoint removed on stop");
		std::fs::remove_dir_all(&root).ok();
	}

	async fn wait_for_clients(handle: &ServerHandle, n: usize) {
		for _ in 0..200 {
			if handle.client_count() >= n {
				return;
			}
			tokio::time::sleep(std::time::Duration::from_millis(10)).await;
		}
		panic!("clients did not subscribe in time");
	}

	#[tokio::test]
	async fn inbound_user_message_forwards_to_host() {
		let handle = start(ServerConfig::new("s", "secret")).await.unwrap();
		let mut inbound = handle.take_inbound_receiver().expect("inbound rx");
		let mut ws = connect(&handle, "secret").await;
		let connection_id = next_server_hello(&mut ws)
			.await
			.connection_id
			.expect("connection id");
		wait_for_clients(&handle, 1).await;
		ws.send(Message::Text(
			serde_json::to_string(&ClientMessage::UserMessage(crate::protocol::UserMessage {
				session_id: "s".into(),
				text:       "keep going".into(),
				token:      "secret".into(),
				update_id:  Some(7),
				thread_id:  Some("topic-1".into()),
				images:     vec![],
			}))
			.unwrap()
			.into(),
		))
		.await
		.unwrap();
		let got = tokio::time::timeout(std::time::Duration::from_secs(2), inbound.recv())
			.await
			.expect("inbound timed out")
			.expect("inbound channel closed");
		assert_eq!(got.connection_id, connection_id);
		match got.message {
			ClientMessage::UserMessage(u) => {
				assert_eq!(u.text, "keep going");
				assert_eq!(u.update_id, Some(7));
				assert_eq!(u.thread_id.as_deref(), Some("topic-1"));
			},
			other => panic!("expected user_message, got {other:?}"),
		}
		handle.stop();
	}

	#[tokio::test]
	async fn authenticated_ephemeral_turn_forwards_only_to_typed_inbound_receiver() {
		let handle = start(ServerConfig::new("s", "secret")).await.unwrap();
		let mut inbound = handle.take_inbound_receiver().expect("inbound receiver");
		let mut frames = handle.take_frame_receiver().expect("frame receiver");
		let mut ws = connect(&handle, "secret").await;
		let connection_id = next_server_hello(&mut ws)
			.await
			.connection_id
			.expect("connection id");
		wait_for_clients(&handle, 1).await;
		ws.send(Message::Text(
			serde_json::json!({
				"type": "ephemeral_turn",
				"sessionId": "s",
				"token": "secret",
				"requestId": "btw:123e4567-e89b-42d3-a456-426614174000",
				"updateId": 7,
				"messageId": 9,
				"threadId": "11",
				"question": "What changed?",
			})
			.to_string()
			.into(),
		))
		.await
		.unwrap();

		let inbound_turn = tokio::time::timeout(std::time::Duration::from_secs(2), inbound.recv())
			.await
			.expect("inbound timed out")
			.expect("inbound channel closed");
		assert_eq!(inbound_turn.connection_id, connection_id);
		match inbound_turn.message {
			ClientMessage::EphemeralTurn(turn) => {
				assert_eq!(turn.session_id, "s");
				assert_eq!(turn.token, "secret");
				assert_eq!(turn.question, "What changed?");
				assert_eq!(turn.request_id, "btw:123e4567-e89b-42d3-a456-426614174000");
				assert_eq!(turn.update_id, 7);
				assert_eq!(turn.message_id, 9);
				assert_eq!(turn.thread_id, "11");
			},
			other => panic!("expected ephemeral_turn, got {other:?}"),
		}

		assert!(
			tokio::time::timeout(std::time::Duration::from_millis(300), frames.recv())
				.await
				.is_err(),
			"authenticated ephemeral turns must not be duplicated to the raw frame receiver"
		);

		for frame in [
			serde_json::json!({
				"type": "ephemeral_turn",
				"sessionId": "s",
				"token": "secret",
				"requestId": "btw:123e4567-e89b-42d3-a456-426614174000",
				"updateId": 7,
				"messageId": 9,
				"threadId": "11",
				"question": "malformed",
				"unexpected": true,
			}),
			serde_json::json!({
				"type": "ephemeral_turn",
				"sessionId": "s",
				"token": "wrong",
				"requestId": "btw:123e4567-e89b-42d3-a456-426614174000",
				"updateId": 7,
				"messageId": 9,
				"threadId": "11",
				"question": "wrong token",
			}),
		] {
			ws.send(Message::Text(frame.to_string().into()))
				.await
				.unwrap();
		}
		assert!(
			tokio::time::timeout(std::time::Duration::from_millis(300), inbound.recv())
				.await
				.is_err(),
			"malformed and wrong-token frames must not reach inbound receiver"
		);
		assert!(
			tokio::time::timeout(std::time::Duration::from_millis(300), frames.recv())
				.await
				.is_err(),
			"malformed and wrong-token frames must not reach frame receiver"
		);
		handle.stop();
	}
	#[tokio::test]
	async fn authenticated_ephemeral_turn_cancel_forwards_full_tuple_to_typed_inbound() {
		let handle = start(ServerConfig::new("s", "secret")).await.unwrap();
		let mut inbound = handle.take_inbound_receiver().expect("inbound rx");
		let mut frames = handle.take_frame_receiver().expect("frame rx");
		let mut ws = connect(&handle, "secret").await;
		next_server_hello(&mut ws).await;
		wait_for_clients(&handle, 1).await;
		ws.send(Message::Text(
			serde_json::json!({
				"type": "ephemeral_turn_cancel",
				"sessionId": "s",
				"token": "secret",
				"requestId": "btw:123e4567-e89b-42d3-a456-426614174000",
				"updateId": 7,
				"messageId": 9,
				"threadId": "11",
				"reason": "daemon_shutdown",
			})
			.to_string()
			.into(),
		))
		.await
		.unwrap();

		let inbound_cancel = tokio::time::timeout(std::time::Duration::from_secs(2), inbound.recv())
			.await
			.expect("cancel timed out")
			.expect("inbound channel closed");
		match inbound_cancel.message {
			ClientMessage::EphemeralTurnCancel(cancel) => {
				assert_eq!(cancel.update_id, 7);
				assert_eq!(cancel.message_id, 9);
				assert_eq!(cancel.thread_id, "11");
			},
			other => panic!("expected ephemeral_turn_cancel, got {other:?}"),
		}
		assert!(
			tokio::time::timeout(std::time::Duration::from_millis(300), frames.recv())
				.await
				.is_err(),
			"authenticated ephemeral turn cancels must not be duplicated to the raw frame receiver"
		);
		ws.send(Message::Text(
			serde_json::json!({
				"type": "ephemeral_turn",
				"sessionId": "s",
				"token": "secret",
				"requestId": "btw:123e4567-e89b-42d3-a456-426614174000",
				"updateId": 7,
				"messageId": 9,
				"threadId": "11",
				"question": "strict",
				"unexpected": true,
			})
			.to_string()
			.into(),
		))
		.await
		.unwrap();
		ws.send(Message::Text(
			serde_json::json!({
				"type": "ephemeral_turn",
				"sessionId": "s",
				"token": "wrong",
				"requestId": "btw:123e4567-e89b-42d3-a456-426614174000",
				"updateId": 7,
				"messageId": 9,
				"threadId": "11",
				"question": "strict",
			})
			.to_string()
			.into(),
		))
		.await
		.unwrap();
		assert!(
			tokio::time::timeout(std::time::Duration::from_millis(300), frames.recv())
				.await
				.is_err()
		);
		handle.stop();
	}
	#[tokio::test]
	async fn inbound_control_command_forwards_to_host() {
		let handle = start(ServerConfig::new("s", "secret")).await.unwrap();
		let mut inbound = handle.take_inbound_receiver().expect("inbound rx");
		let mut ws = connect(&handle, "secret").await;
		let connection_id = next_server_hello(&mut ws)
			.await
			.connection_id
			.expect("connection id");
		wait_for_clients(&handle, 1).await;
		ws.send(Message::Text(
			serde_json::to_string(&ClientMessage::ControlCommand(crate::protocol::ControlCommand {
				session_id: "s".into(),
				token:      "secret".into(),
				request_id: "r1".into(),
				update_id:  Some(8),
				thread_id:  Some("topic-1".into()),
				command:    serde_json::json!({ "name": "context" }),
			}))
			.unwrap()
			.into(),
		))
		.await
		.unwrap();
		let got = tokio::time::timeout(std::time::Duration::from_secs(2), inbound.recv())
			.await
			.expect("inbound timed out")
			.expect("inbound channel closed");
		assert_eq!(got.connection_id, connection_id);
		match got.message {
			ClientMessage::ControlCommand(c) => {
				assert_eq!(c.request_id, "r1");
				assert_eq!(c.update_id, Some(8));
				assert_eq!(c.command["name"], "context");
			},
			other => panic!("expected control_command, got {other:?}"),
		}
		handle.stop();
	}

	#[tokio::test]
	async fn inbound_user_message_wrong_token_is_dropped() {
		let handle = start(ServerConfig::new("s", "secret")).await.unwrap();
		let mut inbound = handle.take_inbound_receiver().expect("inbound rx");
		let mut ws = connect(&handle, "secret").await;
		next_server_hello(&mut ws).await;
		wait_for_clients(&handle, 1).await;
		ws.send(Message::Text(
			serde_json::to_string(&ClientMessage::UserMessage(crate::protocol::UserMessage {
				session_id: "s".into(),
				text:       "x".into(),
				token:      "WRONG".into(),
				update_id:  None,
				thread_id:  None,
				images:     vec![],
			}))
			.unwrap()
			.into(),
		))
		.await
		.unwrap();
		let r = tokio::time::timeout(std::time::Duration::from_millis(300), inbound.recv()).await;
		assert!(r.is_err(), "wrong-token inbound must not forward");
		handle.stop();
	}

	#[tokio::test]
	async fn session_ready_is_advertised_buffered_and_replayed() {
		let handle = start(ServerConfig::new("s", "secret")).await.unwrap();

		// A client connected before readiness sees it broadcast live.
		let mut early = connect(&handle, "secret").await;
		let hello = next_server_hello(&mut early).await;
		assert!(
			hello
				.capabilities
				.contains(&capabilities::SESSION_READY.into())
		);
		wait_for_clients(&handle, 1).await;

		handle.push_session_ready(SessionReady {
			session_id:           "s".into(),
			lifecycle_request_id: Some("lc_01".into()),
			startup_prompt_ref:   Some("prompt_lc_01".into()),
			repo:                 Some("gajae-code".into()),
			branch:               Some("feat/x".into()),
			title:                None,
		});
		match next_server_msg(&mut early).await {
			ServerMessage::SessionReady(r) => {
				assert_eq!(r.session_id, "s");
				assert_eq!(r.lifecycle_request_id.as_deref(), Some("lc_01"));
			},
			other => panic!("expected session_ready broadcast, got {other:?}"),
		}

		// A client connecting AFTER readiness still gets it replayed on connect.
		let mut late = connect(&handle, "secret").await;
		next_server_hello(&mut late).await;
		match next_server_msg(&mut late).await {
			ServerMessage::SessionReady(r) => assert_eq!(r.session_id, "s"),
			other => panic!("expected replayed session_ready, got {other:?}"),
		}
		handle.stop();
	}
	#[tokio::test]
	async fn v3_frames_keep_connection_identity_and_direct_sends_do_not_broadcast() {
		let handle = start(ServerConfig::new("s", "secret")).await.unwrap();
		let mut frames = handle.take_frame_receiver().expect("frame receiver");
		let mut a = connect(&handle, "secret").await;
		let a_id = next_server_hello(&mut a)
			.await
			.connection_id
			.expect("connection id");
		let mut b = connect(&handle, "secret").await;
		next_server_hello(&mut b)
			.await
			.connection_id
			.expect("connection id");
		a.send(Message::Text(r#"{"type":"register_provider","id":"r1"}"#.into()))
			.await
			.unwrap();
		let (source, raw) = tokio::time::timeout(std::time::Duration::from_secs(2), frames.recv())
			.await
			.expect("frame timeout")
			.expect("frame forwarded");
		assert_eq!(source, a_id);
		assert_eq!(raw, r#"{"type":"register_provider","id":"r1"}"#);
		assert!(
			handle.send_to(&a_id, r#"{"type":"register_provider_result","leaseId":"l1"}"#.into())
		);
		let directed = tokio::time::timeout(std::time::Duration::from_secs(2), a.next())
			.await
			.expect("directed send timeout")
			.expect("socket open")
			.expect("ws message");
		assert!(matches!(directed, Message::Text(text) if text.contains("leaseId")));
		assert!(
			tokio::time::timeout(std::time::Duration::from_millis(300), b.next())
				.await
				.is_err()
		);
		handle.stop();
	}
	#[tokio::test]
	async fn directed_tool_frames_require_negotiated_capability() {
		let handle = start(ServerConfig::new("s", "secret")).await.unwrap();
		let mut legacy = connect(&handle, "secret").await;
		let legacy_id = next_server_hello(&mut legacy)
			.await
			.connection_id
			.expect("connection id");
		send_hello(&mut legacy, vec![]).await;
		let mut capable = connect(&handle, "secret").await;
		let capable_id = next_server_hello(&mut capable)
			.await
			.connection_id
			.expect("connection id");
		send_hello(&mut capable, vec![capabilities::TOOL_ACTIVITY_V1.into()]).await;
		wait_for_clients(&handle, 2).await;

		let frame =
			r#"{"type":"tool_activity","toolCallId":"c1","toolName":"read","phase":"started"}"#;
		assert!(handle.send_to(&legacy_id, frame.into()));
		assert!(
			tokio::time::timeout(std::time::Duration::from_millis(300), legacy.next())
				.await
				.is_err()
		);
		assert!(handle.send_to(&capable_id, frame.into()));
		let delivered = tokio::time::timeout(std::time::Duration::from_secs(2), capable.next())
			.await
			.expect("directed send timeout")
			.expect("socket open")
			.expect("ws message");
		assert!(matches!(delivered, Message::Text(text) if text.contains("tool_activity")));
		handle.stop();
	}
	#[tokio::test]
	async fn oversized_text_frame_closes_only_the_offending_client() {
		let handle = start(ServerConfig::new("s", "secret")).await.unwrap();
		let mut oversized = connect(&handle, "secret").await;
		next_server_hello(&mut oversized).await;
		let mut healthy = connect(&handle, "secret").await;
		next_server_hello(&mut healthy).await;
		wait_for_clients(&handle, 2).await;

		oversized
			.send(Message::Text("x".repeat(REQUEST_FRAME_BYTES + 1).into()))
			.await
			.expect("send oversized text frame");
		match tokio::time::timeout(std::time::Duration::from_secs(2), oversized.next())
			.await
			.expect("oversized client was not closed")
		{
			Some(Ok(Message::Close(Some(frame)))) => {
				assert_eq!(frame.code, CloseCode::Size);
			},
			Some(Err(_)) | None => {},
			Some(Ok(message)) => panic!("unexpected non-close message: {message:?}"),
		}

		healthy
			.send(Message::Text(
				serde_json::to_string(&ClientMessage::Ping(Ping { nonce: "healthy".into() }))
					.unwrap()
					.into(),
			))
			.await
			.expect("send healthy request");
		assert!(
			matches!(next_server_msg(&mut healthy).await, ServerMessage::Pong(Pong { nonce }) if nonce == "healthy")
		);
		handle.stop();
	}

	#[tokio::test]
	async fn binary_protocol_frame_is_rejected_with_unsupported_data_close() {
		let handle = start(ServerConfig::new("s", "secret")).await.unwrap();
		let mut ws = connect(&handle, "secret").await;
		next_server_hello(&mut ws).await;
		wait_for_clients(&handle, 1).await;

		ws.send(Message::Binary(br#"{"type":"ping"}"#.to_vec().into()))
			.await
			.expect("send binary protocol frame");
		let rejected = tokio::time::timeout(std::time::Duration::from_secs(2), ws.next())
			.await
			.expect("binary client was not closed")
			.expect("binary client stream closed without a close frame")
			.expect("binary client close error");
		assert!(
			matches!(rejected, Message::Close(Some(frame)) if frame.code == CloseCode::Unsupported)
		);
		handle.stop();
	}

	#[tokio::test]
	async fn send_failure_after_dispatch_begins_is_transport_ambiguous() {
		let handle = start(ServerConfig::new("s", "secret")).await.unwrap();
		let (tx, mut rx) = mpsc::unbounded_channel::<DirectCommand>();
		handle
			.state
			.connections
			.lock()
			.insert("origin".into(), Connection {
				generation: "generation".into(),
				capabilities: vec![capabilities::ASK_SELECTED_ACK_V1.into()],
				negotiation: Negotiation::Negotiated,
				delivered: None,
				tx,
			});
		let task = {
			let handle = handle.clone();
			tokio::spawn(async move {
				handle
					.request_ack(
						AskSelectedAckRequest::Recovery {
							request_id:  "send-failure-request".into(),
							commit_key:  "send-failure-commit".into(),
							session_id:  "s".into(),
							action_id:   "a1".into(),
							deadline_at: (std::time::SystemTime::now()
								.duration_since(std::time::UNIX_EPOCH)
								.unwrap()
								.as_millis() + 5_000) as i64,
						},
						Some(("origin".into(), "generation".into())),
					)
					.await
			})
		};
		let direct = rx.recv().await.expect("queued acknowledgement");
		let DirectCommand::Deliver(message, Some(dispatched)) = direct else {
			panic!("expected acknowledgement delivery command");
		};
		assert!(prepare_direct_ack(&handle.state, &message));
		dispatched.send(false).unwrap();
		assert_eq!(task.await.unwrap(), AskSelectedAckOutcome::Unknown {
			reason: AskSelectedAckUnknownReason::TransportAmbiguous,
		});
		handle.stop();
	}
	#[test]
	fn acknowledgement_registry_linearizes_dispatch_terminal_and_cancel() {
		let mut registry = AckRegistry::default();
		let (waiter, receiver) = oneshot::channel();
		registry.commits.insert("commit".into(), "request".into());
		registry.pending.insert("request".into(), AckPending {
			commit_key: "commit".into(),
			origin: None,
			dispatched: false,
			waiter,
		});
		let delivered = AskSelectedAckOutcome::Delivered { message_id: 42 };
		let unknown =
			AskSelectedAckOutcome::Unknown { reason: AskSelectedAckUnknownReason::HostTimeout };
		assert!(registry.begin_dispatch("request"));
		let (actual, finished) = registry.finish("request", delivered.clone());
		assert_eq!(actual, delivered);
		assert!(finished.expect("first settlement").2);
		assert!(!registry.begin_dispatch("request"));
		assert_eq!(registry.finish("request", unknown).0, delivered);
		let cancelled =
			AskSelectedAckOutcome::Failed { reason: AskSelectedAckFailedReason::Cancelled };
		assert_eq!(registry.cancel("request", "commit", cancelled.clone()).0, delivered);
		assert_eq!(
			registry
				.cancel("request", "wrong-commit", cancelled.clone())
				.0,
			cancelled
		);
		assert_eq!(receiver.blocking_recv().unwrap(), delivered);
	}
}
