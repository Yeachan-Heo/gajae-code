//! Wire protocol for the Gajae-Code SDK.
//!
//! The protocol is a small, transport-agnostic JSON contract. Upstream emits
//! [`ServerMessage`] frames to connected clients and accepts [`ClientMessage`]
//! frames in reply. Third parties implement a client against this contract with
//! zero upstream changes; the bundled Telegram client is one such
//! implementation.
//!
//! Field names are `camelCase` on the wire (matching the TypeScript extension),
//! while the `type` discriminator values are `snake_case`.

use serde::{Deserialize, Serialize};

/// The kind of action that requires human attention.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ActionKind {
	/// An `ask` tool question is pending and can be answered by an authorized
	/// local or SDK client.
	Ask,
	/// The agent has gone idle at the end of a turn. Notify-only; not repliable.
	Idle,
}

/// Identifies who resolved a pending action.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ResolvedBy {
	/// Resolved locally in the CLI/TUI (the authoritative ask path).
	Local,
	/// Resolved by an authorized remote SDK client reply.
	Client,
	/// Resolved because the action timed out (reserved; not emitted in v1).
	Timeout,
}

/// Why an inbound reply was rejected.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RejectReason {
	/// The action was already resolved (locally or by a faster client).
	AlreadyAnswered,
	/// No action with the given id is currently pending.
	UnknownAction,
	/// The answer shape/value was invalid before reaching the gate broker.
	InvalidAnswer,
	/// The session has no SDK workflow-gate resolver, so the ask cannot be
	/// answered remotely.
	ResolverUnavailable,
	/// A reply reused an idempotency key with a conflicting body.
	IdempotencyConflict,
	/// The reply token did not match the session token.
	Unauthorized,
}

/// Why a controlled action could not be presented to this connection.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ActionUnavailableReason {
	/// The client did not negotiate a capability required by the action.
	MissingCapability,
}

/// A deterministic remote ask control. Controls are capability-gated by
/// [`capabilities::ASK_CONTROLS_V1`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AskControl {
	pub id:      String,
	pub kind:    String,
	pub label:   String,
	pub enabled: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReplyControl {
	pub control_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StructuredReply {
	/// Selected options, each an index or a label.
	pub selected: Vec<AnswerSelector>,
	/// Optional free-text "other" value.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub custom:   Option<String>,
}

/// A client-supplied answer to a pending `ask` action.
///
/// Accepts a zero-based option index, an option label / free-text string, a
/// deterministic control, or a structured multi-select payload.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ReplyAnswer {
	/// Zero-based index into the action's `options`.
	Index(u32),
	/// A typed deterministic control reply, distinct from labels and text.
	Control(ReplyControl),

	/// An option label or free-text answer.
	Text(String),
	/// An explicit multi-select / free-text payload.
	Structured(StructuredReply),
}

/// One selected option within a [`ReplyAnswer::Structured`] payload.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum AnswerSelector {
	/// Zero-based option index.
	Index(u32),
	/// Option label.
	Label(String),
}

/// An action that needs attention, broadcast to connected clients.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionNeeded {
	/// Ephemeral presentation/action id and the sole generic reply authority.
	/// Durable workflow correlation, when present, is carried separately on the
	/// correlated wire envelope.
	pub id:         String,
	/// Whether this is an answerable ask or a notify-only idle ping.
	pub kind:       ActionKind,
	/// The session this action belongs to.
	pub session_id: String,
	/// The ask question text (present for `ask`).
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub question:   Option<String>,
	/// The selectable options for an ask (present for `ask` when offered).
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub options:    Option<Vec<String>>,
	/// Typed deterministic controls. Senders emit controls only after this
	/// connection has negotiated [`capabilities::ASK_CONTROLS_V1`]; non-capable
	/// or timed-out connections receive `action_unavailable` instead.
	#[serde(default, skip_serializing_if = "Vec::is_empty")]
	pub controls:   Vec<AskControl>,
	/// A short summary (e.g. truncated last assistant message for `idle`).
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub summary:    Option<String>,
}

/// A correlated workflow-gate presentation. The embedded action retains the
/// generic reply authority; `workflow_gate_id` is correlation metadata only.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkflowGateActionNeeded {
	pub action:           ActionNeeded,
	pub workflow_gate_id: String,
}

/// The outer wire discriminator that scopes correlated workflow-gate
/// registration. This is internal registration metadata; it does not add a wire
/// field.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum WorkflowGateWireDiscriminator {
	ActionNeeded,
	#[allow(
		dead_code,
		reason = "reserved to fence future correlated action_unavailable registrations"
	)]
	ActionUnavailable,
}

impl WorkflowGateWireDiscriminator {
	#[must_use]
	pub(crate) const fn as_str(self) -> &'static str {
		match self {
			Self::ActionNeeded => "action_needed",
			Self::ActionUnavailable => "action_unavailable",
		}
	}
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WireActionNeeded<'a> {
	#[serde(rename = "type")]
	kind:             &'static str,
	#[serde(flatten)]
	action:           &'a ActionNeeded,
	workflow_gate_id: &'a str,
}

/// Decode correlated workflow metadata from an `action_needed` wire frame.
/// Legacy [`ServerMessage`] decoding remains intentionally correlation-blind.
pub fn decode_workflow_gate_action_needed(
	json: &str,
) -> Result<Option<WorkflowGateActionNeeded>, serde_json::Error> {
	let value: serde_json::Value = serde_json::from_str(json)?;
	if value.get("type").and_then(serde_json::Value::as_str)
		!= Some(WorkflowGateWireDiscriminator::ActionNeeded.as_str())
	{
		return Ok(None);
	}
	let Some(workflow_gate_value) = value.get("workflowGateId") else {
		return Ok(None);
	};
	let workflow_gate_id = workflow_gate_value
		.as_str()
		.filter(|id| !id.is_empty())
		.map(str::to_owned)
		.ok_or_else(|| {
			serde_json::Error::io(std::io::Error::new(
				std::io::ErrorKind::InvalidData,
				"workflowGateId must be a nonempty string",
			))
		})?;
	let action = serde_json::from_value(value)?;
	Ok(Some(WorkflowGateActionNeeded { action, workflow_gate_id }))
}

pub(crate) fn serialize_workflow_gate_action_needed(
	action: &ActionNeeded,
	workflow_gate_id: &str,
) -> Result<String, serde_json::Error> {
	serde_json::to_string(&WireActionNeeded {
		kind: WorkflowGateWireDiscriminator::ActionNeeded.as_str(),
		action,
		workflow_gate_id,
	})
}

/// Sent when a controlled action cannot be presented to this connection.
///
/// This frame is non-actionable. A sender emits it after Hello negotiation (or
/// its bounded grace timeout) when the client lacks the required capability.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionUnavailable {
	/// The action that could not be presented.
	pub id:                    String,
	/// The session the action belongs to.
	pub session_id:            String,
	/// Why the action is unavailable.
	pub reason:                ActionUnavailableReason,
	/// Capabilities required for an actionable presentation.
	pub required_capabilities: Vec<String>,
}

/// Broadcast when a pending action transitions to a terminal, non-repliable
/// state.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionResolved {
	/// The resolved action id.
	pub id:          String,
	/// Who resolved it.
	pub resolved_by: ResolvedBy,
	/// The accepted answer, when one applies.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub answer:      Option<ReplyAnswer>,
}

/// Sent to a single client when its reply could not be accepted.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplyRejected {
	/// The action id the rejected reply targeted.
	pub id:     String,
	/// Why the reply was rejected.
	pub reason: RejectReason,
}

/// A terminal acknowledgement outcome. Native only returns `unknown` when the
/// daemon did not supply correlated terminal delivery evidence.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
	tag = "status",
	rename_all = "snake_case",
	rename_all_fields = "camelCase",
	deny_unknown_fields
)]
pub enum AskSelectedAckOutcome {
	Delivered { message_id: i64 },
	Failed { reason: AskSelectedAckFailedReason },
	Unknown { reason: AskSelectedAckUnknownReason },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AskSelectedAckFailedReason {
	Unsupported,
	NoParticipant,
	AmbiguousParticipant,
	RouteMissing,
	Expired,
	Cancelled,
	TelegramRejected,
	SessionClosed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AskSelectedAckUnknownReason {
	TransportAmbiguous,
	OriginDisconnected,
	HostTimeout,
	Shutdown,
}

/// A live acknowledgement is restricted to the connection that claimed the
/// source reply. Recovery is topic-only and has no pending-action authority.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
	tag = "mode",
	rename_all = "snake_case",
	rename_all_fields = "camelCase",
	deny_unknown_fields
)]
pub enum AskSelectedAckRequest {
	Live {
		request_id:  String,
		commit_key:  String,
		action_id:   String,
		deadline_at: i64,
	},
	Recovery {
		request_id:  String,
		commit_key:  String,
		session_id:  String,
		action_id:   String,
		deadline_at: i64,
	},
}

impl AskSelectedAckRequest {
	#[must_use]
	pub fn request_id(&self) -> &str {
		match self {
			Self::Live { request_id, .. } | Self::Recovery { request_id, .. } => request_id,
		}
	}

	#[must_use]
	pub fn commit_key(&self) -> &str {
		match self {
			Self::Live { commit_key, .. } | Self::Recovery { commit_key, .. } => commit_key,
		}
	}

	#[must_use]
	pub const fn deadline_at(&self) -> i64 {
		match self {
			Self::Live { deadline_at, .. } | Self::Recovery { deadline_at, .. } => *deadline_at,
		}
	}
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AskSelectedAckResult {
	pub request_id: String,
	pub commit_key: String,
	pub outcome:    AskSelectedAckOutcome,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AskSelectedAckCancel {
	pub request_id: String,
	pub commit_key: String,
	pub reason:     AskSelectedAckCancelReason,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AskSelectedAckCancelReason {
	HostTimeout,
	ToolAbort,
	ActionResolved,
	SessionShutdown,
	EndpointReplaced,
}

/// An inbound reply from a client.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Reply {
	/// The action id being answered.
	pub id:              String,
	/// The answer payload.
	pub answer:          ReplyAnswer,
	/// The per-session token authorizing this client.
	pub token:           String,
	/// Optional idempotency key so retried replies are not double-applied.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub idempotency_key: Option<String>,
}

/// Messages sent from the server (upstream) to clients.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerMessage {
	/// A new action needs attention.
	ActionNeeded(ActionNeeded),
	/// A pending action became terminal/non-repliable.
	ActionResolved(ActionResolved),
	/// A specific client's reply was rejected.
	ReplyRejected(ReplyRejected),
	/// One-time per-session identity header (threaded clients).
	IdentityHeader(IdentityHeader),
	/// A streamed dynamic context update (threaded clients).
	ContextUpdate(ContextUpdate),
	/// A streamed turn output chunk: live (throttled) or finalized.
	TurnStream(TurnStream),
	/// An agent-produced image artifact.
	ImageAttachment(ImageAttachment),
	/// An agent-produced file artifact delivered as a chat document.
	FileAttachment(FileAttachment),
	/// A pushed configuration update (verbosity/redact).
	ConfigUpdate(ConfigUpdate),
	/// Server capability/version advertisement for negotiation.
	Hello(ServerHello),
	/// Live agent-activity signal driving the client typing indicator.
	Activity(Activity),
	/// Inbound user-message delivery acknowledgement (native double-check UX).
	InboundAck(InboundAck),
	/// Replayable readiness signal: the session is up and surfaced. Buffered
	/// and replayed to late clients so WS-open alone never implies readiness.
	SessionReady(SessionReady),
	/// Session endpoint teardown signal for clients that maintain per-session
	/// surfaces.
	SessionClosed(SessionClosed),
	/// Result of a deterministic transport control command.
	ControlCommandResult(ControlCommandResult),
	/// Application-level liveness response to a client ping.
	Pong(Pong),
	/// A native acknowledgement request, unicast to an authorized participant.
	AskSelectedAckRequest(AskSelectedAckRequest),
	/// A native cancellation for a previously dispatched acknowledgement
	/// request.
	AskSelectedAckCancel(AskSelectedAckCancel),
	/// A controlled action could not be presented to this connection.
	ActionUnavailable(ActionUnavailable),

	/// A projected tool execution activity update.
	ToolActivity(ToolActivity),
	/// A finalized, provider-supplied reasoning summary.
	ReasoningSummary(ReasoningSummary),

	/// Forward-compat: an unrecognized frame type. Tolerated, never emitted.
	#[serde(other)]
	Unknown,
}

/// Messages sent from a client to the server (upstream).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ClientMessage {
	/// A reply to a pending action.
	Reply(Reply),
	/// Client capability/version advertisement for negotiation.
	Hello(ClientHello),
	/// An inbound free-text user message that injects/steers a turn.
	UserMessage(UserMessage),
	/// An in-thread configuration command (verbosity/redact toggles).
	ConfigCommand(ConfigCommand),
	/// A deterministic transport control command from a client.
	ControlCommand(ControlCommand),
	/// Application-level liveness ping from a client.
	Ping(Ping),
	/// Correlated terminal outcome for a native acknowledgement request.
	AskSelectedAckResult(AskSelectedAckResult),

	/// Forward-compat: an unrecognized frame type. Tolerated, ignored.
	#[serde(other)]
	Unknown,
}

/// Streaming verbosity for the threaded session mirror.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Verbosity {
	/// Assistant text + tool names only (default).
	Lean,
	/// Full tool outputs + reasoning.
	Verbose,
}

/// Phase of a streamed turn output chunk.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TurnPhase {
	/// An in-progress, throttled live edit.
	Live,
	/// The clean, finalized turn output.
	Finalized,
}

/// Phase of a projected tool execution activity update.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolActivityPhase {
	Started,
	Completed,
	Failed,
	Cancelled,
	Unknown,
}

/// One-time per-session identity header, pinned at thread creation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IdentityHeader {
	/// The session this header describes.
	pub session_id: String,
	/// Repository name/path.
	pub repo:       String,
	/// Active branch.
	pub branch:     String,
	/// Host machine tag.
	pub machine:    String,
	/// Optional session title (also used as the topic title).
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub title:      Option<String>,
}

/// A streamed dynamic context update for a session thread.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextUpdate {
	/// The session this update belongs to.
	pub session_id:   String,
	/// Compact current working directory label; never the full host path by
	/// default.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub cwd:          Option<String>,
	/// Last assistant message text.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub last_message: Option<String>,
	/// Current task/todo summary.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub task:         Option<String>,
	/// Goal status summary.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub goal:         Option<String>,
	/// Token/context-window usage summary.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub token_usage:  Option<String>,
	/// Active model.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub model:        Option<String>,
	/// Latest diff snippet.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub diff:         Option<String>,
}

/// A streamed turn output chunk (live throttled edit or finalized).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnStream {
	/// The session this chunk belongs to.
	pub session_id:   String,
	/// Whether this is a live (throttled) edit or the finalized output.
	pub phase:        TurnPhase,
	/// The rendered text for this chunk.
	pub text:         String,
	/// True only for the distinct final-answer chunk of a turn (never for
	/// pre-ask lead-ins); consumers treat absence as false.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub final_answer: Option<bool>,
	/// Opaque ref to coalesce live edits onto one rendered message.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub message_ref:  Option<String>,
}

/// A projected tool execution activity update for a session.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolActivity {
	pub session_id:     String,
	pub tool_call_id:   String,
	pub tool_name:      String,
	pub phase:          ToolActivityPhase,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub args_summary:   Option<String>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub result_summary: Option<String>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub is_error:       Option<bool>,
}

/// A finalized, provider-supplied reasoning summary for a session.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReasoningSummary {
	pub session_id: String,
	pub text:       String,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub turn_ref:   Option<String>,
}

/// An agent-produced image artifact for a session thread.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageAttachment {
	/// The session this image belongs to.
	pub session_id: String,
	/// Image source: "computer", "browser", or a tool name.
	pub source:     String,
	/// MIME type, e.g. "image/png".
	pub mime:       String,
	/// Base64-encoded image bytes.
	pub data:       String,
	/// Optional caption.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub caption:    Option<String>,
}

/// An agent-produced file artifact to deliver as a chat document.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileAttachment {
	/// The session this file belongs to.
	pub session_id: String,
	/// Suggested file name (with extension when known).
	pub name:       String,
	/// MIME type, e.g. "application/pdf".
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub mime:       Option<String>,
	/// Base64-encoded file bytes.
	pub data:       String,
	/// Optional caption.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub caption:    Option<String>,
}

/// A pushed configuration update reflecting current verbosity/redaction.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigUpdate {
	/// The session this config applies to.
	pub session_id: String,
	/// Current streaming verbosity.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub verbosity:  Option<Verbosity>,
	/// Whether redaction is enabled.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub redact:     Option<bool>,
}

/// Session endpoint teardown signal.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionClosed {
	/// The session whose notification endpoint is shutting down.
	pub session_id: String,
}

/// Server capability/version advertisement.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerHello {
	/// Protocol version the server speaks.
	pub protocol_version: u32,
	/// Capability tokens the server supports.
	pub capabilities:     Vec<String>,
	/// Stable identifier for this WebSocket connection.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub connection_id:    Option<String>,
}

/// Client capability/version advertisement.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientHello {
	/// Protocol version the client speaks.
	pub protocol_version: u32,
	/// Capability tokens the client supports.
	pub capabilities:     Vec<String>,
}

/// Application-level liveness ping.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Ping {
	/// Opaque client nonce echoed in the response.
	pub nonce: String,
}

/// Application-level liveness pong.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Pong {
	/// Opaque client nonce from the ping.
	pub nonce: String,
}

/// An inline image attachment carried by an inbound user message.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InboundImage {
	/// Base64-encoded image bytes.
	pub data: String,
	/// MIME type when known (e.g. "image/jpeg").
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub mime: Option<String>,
}

/// An inbound free-text user message injecting/steering a session turn.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserMessage {
	/// The session to inject into.
	pub session_id: String,
	/// The free-text message body.
	pub text:       String,
	/// The per-session token authorizing this client.
	pub token:      String,
	/// Telegram update id for inbound dedupe/idempotency.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub update_id:  Option<i64>,
	/// Originating thread/topic id, for fail-closed routing.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub thread_id:  Option<String>,
	/// Inline image attachments to forward as image content blocks.
	#[serde(default, skip_serializing_if = "Vec::is_empty")]
	pub images:     Vec<InboundImage>,
}

/// An in-thread configuration command (verbosity/redact toggles).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigCommand {
	/// The session to configure.
	pub session_id: String,
	/// The per-session token authorizing this client.
	pub token:      String,
	/// Requested verbosity, if changing.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub verbosity:  Option<Verbosity>,
	/// Requested redaction state, if changing.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub redact:     Option<bool>,
}

/// A deterministic transport control command forwarded to the host session.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlCommand {
	/// The session to control.
	pub session_id: String,
	/// The per-session token authorizing this client.
	pub token:      String,
	/// Client-generated request id, echoed in the result.
	pub request_id: String,
	/// Telegram update id for inbound dedupe/idempotency.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub update_id:  Option<i64>,
	/// Originating thread/topic id, for fail-closed routing.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub thread_id:  Option<String>,
	/// Command payload as a small JSON object owned by the TypeScript executor.
	pub command:    serde_json::Value,
}

/// Result status for a transport control command.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ControlCommandStatus {
	/// Command completed successfully.
	Ok,
	/// Command was syntactically invalid or unsupported.
	Error,
	/// The target session/control surface is unavailable.
	Unavailable,
}

/// A Telegram-safe model choice surfaced by a successful `model` list control
/// result.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelChoice {
	/// Stable selector forwarded back to the session when this choice is tapped.
	pub selector: String,
	/// Human-readable button label.
	pub label:    String,
}

/// Result of a deterministic transport control command.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlCommandResult {
	/// The session this result belongs to.
	pub session_id:    String,
	/// Client request id being answered.
	pub request_id:    String,
	/// Telegram update id this result corresponds to, when known.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub update_id:     Option<i64>,
	/// Terminal command status.
	pub status:        ControlCommandStatus,
	/// Short deterministic Telegram-visible text.
	pub message:       String,
	/// Optional model choices for a successful bare `model` list request.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub model_choices: Option<Vec<ModelChoice>>,
}

/// Agent loop activity state, driving the client's live typing indicator.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ActivityState {
	/// The agent loop is running (thinking/streaming); show typing.
	Busy,
	/// The agent loop has settled, awaiting input; clear typing.
	Idle,
}

/// A live agent-activity signal. Emitted on agent loop start/settle so a client
/// can show/clear a native typing indicator while the agent is thinking.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Activity {
	/// The session this activity belongs to.
	pub session_id: String,
	/// Whether the agent is currently busy or idle.
	pub state:      ActivityState,
}

/// Delivery state of a previously-injected inbound user message.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InboundAckState {
	/// Received and queued (agent busy / message held as a steer).
	Queued,
	/// Consumed by a turn (the agent has picked the message up).
	Consumed,
}

/// Acknowledges progress of an inbound [`UserMessage`] (matched by `update_id`)
/// so the client can reflect a native double-check delivery state on the
/// originating message.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InboundAck {
	/// The session that received the inbound message.
	pub session_id: String,
	/// The Telegram update id this acknowledgement refers to.
	pub update_id:  i64,
	/// The delivery state now reached.
	pub state:      InboundAckState,
}

/// A replayable per-session readiness signal.
///
/// Emitted once the session's endpoint is up and surfaced into its thread.
/// Unlike [`IdentityHeader`], this frame is buffered and replayed to clients
/// that connect late, so a lifecycle control client can deterministically wait
/// for readiness instead of relying on WS-open (which proves nothing about the
/// session actually being live and surfaced).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionReady {
	/// The session that is now ready.
	pub session_id:           String,
	/// The lifecycle marker that spawned this session, when applicable.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub lifecycle_request_id: Option<String>,
	/// The startup-prompt reference consumed by this session, when applicable.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub startup_prompt_ref:   Option<String>,
	/// Repository/project name, when known.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub repo:                 Option<String>,
	/// Branch name, when known.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub branch:               Option<String>,
	/// A short session title, when known.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub title:                Option<String>,
}

/// Current protocol version emitted in [`ServerHello`].
pub const PROTOCOL_VERSION: u32 = 3;

/// Capability tokens for protocol negotiation.
pub mod capabilities {
	/// Threaded per-session forum-topic delivery.
	pub const THREADED: &str = "threaded";
	/// Streamed dynamic context updates.
	pub const CONTEXT: &str = "context";
	/// Live + finalized turn streaming.
	pub const TURN_STREAM: &str = "turn_stream";
	/// Image attachments.
	pub const IMAGES: &str = "images";
	/// Config push/commands.
	pub const CONFIG: &str = "config";
	/// Live typing indicator driven by activity signals.
	pub const TYPING: &str = "typing";
	/// Inbound user-message delivery acknowledgements (double-check UX).
	pub const INBOUND_ACK: &str = "inbound_ack";
	/// Application-level client ping/server pong.
	pub const CLIENT_PING_PONG: &str = "client_ping_pong";
	/// Daemon-owned session lifecycle control (create/close/resume ingress).
	pub const SESSION_LIFECYCLE: &str = "session_lifecycle";
	/// Replayable readiness signal for late-connecting clients.
	pub const SESSION_READY: &str = "session_ready";
	/// Typed remote ask controls and typed control replies.
	pub const ASK_CONTROLS_V1: &str = "ask_controls_v1";
	/// Correlated, origin-bound `Selected!` acknowledgement requests.
	pub const ASK_SELECTED_ACK_V1: &str = "ask_selected_ack_v1";
	/// Projected tool activity and finalized reasoning summary frames.
	pub const TOOL_ACTIVITY_V1: &str = "tool_activity_v1";
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn correlated_action_needed_roundtrips_without_changing_legacy_reader() {
		let action = ActionNeeded {
			id:         "presentation-1".into(),
			kind:       ActionKind::Ask,
			session_id: "session-1".into(),
			question:   Some("Proceed?".into()),
			options:    Some(vec!["Yes".into(), "No".into()]),
			controls:   vec![],
			summary:    None,
		};
		let raw = serialize_workflow_gate_action_needed(&action, "gate-1").unwrap();
		let correlated = decode_workflow_gate_action_needed(&raw)
			.unwrap()
			.expect("correlation");
		assert_eq!(correlated.action, action);
		assert_eq!(correlated.workflow_gate_id, "gate-1");
		let legacy: ServerMessage = serde_json::from_str(&raw).unwrap();
		assert_eq!(legacy, ServerMessage::ActionNeeded(action));
		assert!(
			decode_workflow_gate_action_needed(
				r#"{"type":"action_needed","id":"a","kind":"ask","sessionId":"s"}"#
			)
			.unwrap()
			.is_none()
		);
	}

	#[test]
	fn action_needed_ask_serializes_camelcase_with_snake_type() {
		let msg = ServerMessage::ActionNeeded(ActionNeeded {
			id:         "wg_run_stage_1".into(),
			kind:       ActionKind::Ask,
			session_id: "sess-1".into(),
			question:   Some("Proceed?".into()),
			options:    Some(vec!["Yes".into(), "No".into()]),
			controls:   vec![],
			summary:    None,
		});
		let v: serde_json::Value = serde_json::to_value(&msg).unwrap();
		assert_eq!(v["type"], "action_needed");
		assert_eq!(v["kind"], "ask");
		assert_eq!(v["id"], "wg_run_stage_1");
		assert_eq!(v["sessionId"], "sess-1");
		assert_eq!(v["options"][0], "Yes");
		// summary omitted when None
		assert!(v.get("summary").is_none());
	}

	#[test]
	fn controlled_action_needed_wire_shape_roundtrips() {
		let msg = ServerMessage::ActionNeeded(ActionNeeded {
			id:         "a1".into(),
			kind:       ActionKind::Ask,
			session_id: "sess-1".into(),
			question:   Some("Proceed?".into()),
			options:    Some(vec!["Yes".into(), "No".into()]),
			controls:   vec![AskControl {
				id:      "navigation_forward".into(),
				kind:    "navigation".into(),
				label:   "Continue".into(),
				enabled: true,
			}],
			summary:    None,
		});
		let raw = serde_json::to_string(&msg).unwrap();
		assert_eq!(
			raw,
			r#"{"type":"action_needed","id":"a1","kind":"ask","sessionId":"sess-1","question":"Proceed?","options":["Yes","No"],"controls":[{"id":"navigation_forward","kind":"navigation","label":"Continue","enabled":true}]}"#,
		);
		let decoded: ServerMessage = serde_json::from_str(&raw).unwrap();
		assert_eq!(decoded, msg);
	}

	#[test]
	fn action_unavailable_serializes_with_required_capabilities() {
		let msg = ServerMessage::ActionUnavailable(ActionUnavailable {
			id:                    "a1".into(),
			session_id:            "sess-1".into(),
			reason:                ActionUnavailableReason::MissingCapability,
			required_capabilities: vec![capabilities::ASK_CONTROLS_V1.into()],
		});
		assert_eq!(
			serde_json::to_string(&msg).unwrap(),
			r#"{"type":"action_unavailable","id":"a1","sessionId":"sess-1","reason":"missing_capability","requiredCapabilities":["ask_controls_v1"]}"#,
		);
	}

	#[test]
	fn idle_action_omits_ask_fields() {
		let msg = ServerMessage::ActionNeeded(ActionNeeded {
			id:         "idle-sess-1-7".into(),
			kind:       ActionKind::Idle,
			session_id: "sess-1".into(),
			question:   None,
			options:    None,
			controls:   vec![],
			summary:    Some("done refactoring".into()),
		});
		let v = serde_json::to_value(&msg).unwrap();
		assert_eq!(v["kind"], "idle");
		assert_eq!(v["summary"], "done refactoring");
		assert!(v.get("question").is_none());
		assert!(v.get("options").is_none());
	}

	#[test]
	fn action_needed_omits_empty_controls() {
		let msg = ServerMessage::ActionNeeded(ActionNeeded {
			id:         "a1".into(),
			kind:       ActionKind::Ask,
			session_id: "sess-1".into(),
			question:   Some("Proceed?".into()),
			options:    Some(vec!["Yes".into()]),
			controls:   vec![],
			summary:    None,
		});
		let value = serde_json::to_value(msg).unwrap();
		assert!(value.get("controls").is_none());
	}

	#[test]
	fn reply_index_answer_roundtrips() {
		let raw = r#"{"type":"reply","id":"a1","answer":2,"token":"t"}"#;
		let msg: ClientMessage = serde_json::from_str(raw).unwrap();
		let ClientMessage::Reply(reply) = msg else {
			panic!("expected reply")
		};
		assert_eq!(reply.id, "a1");
		assert_eq!(reply.answer, ReplyAnswer::Index(2));
		assert_eq!(reply.token, "t");
		assert!(reply.idempotency_key.is_none());
	}

	#[test]
	fn reply_text_answer_parses_as_text_not_index() {
		let raw =
			r#"{"type":"reply","id":"a1","answer":"Looks good","token":"t","idempotencyKey":"k1"}"#;
		let ClientMessage::Reply(reply) = serde_json::from_str(raw).unwrap() else {
			panic!("expected reply")
		};
		assert_eq!(reply.answer, ReplyAnswer::Text("Looks good".into()));
		assert_eq!(reply.idempotency_key.as_deref(), Some("k1"));
	}

	#[test]
	fn reply_structured_answer_parses() {
		let raw =
			r#"{"type":"reply","id":"a1","answer":{"selected":[0,"Maybe"],"custom":"x"},"token":"t"}"#;
		let ClientMessage::Reply(reply) = serde_json::from_str(raw).unwrap() else {
			panic!("expected reply")
		};
		match reply.answer {
			ReplyAnswer::Structured(StructuredReply { selected, custom }) => {
				assert_eq!(selected.len(), 2);
				assert_eq!(selected[0], AnswerSelector::Index(0));
				assert_eq!(selected[1], AnswerSelector::Label("Maybe".into()));
				assert_eq!(custom.as_deref(), Some("x"));
			},
			other => panic!("expected structured, got {other:?}"),
		}
	}

	#[test]
	fn action_resolved_serializes_resolved_by() {
		let msg = ServerMessage::ActionResolved(ActionResolved {
			id:          "a1".into(),
			resolved_by: ResolvedBy::Local,
			answer:      None,
		});
		let v = serde_json::to_value(&msg).unwrap();
		assert_eq!(v["type"], "action_resolved");
		assert_eq!(v["resolvedBy"], "local");
		assert!(v.get("answer").is_none());
	}

	#[test]
	fn reply_rejected_serializes_reason() {
		let msg = ServerMessage::ReplyRejected(ReplyRejected {
			id:     "a1".into(),
			reason: RejectReason::AlreadyAnswered,
		});
		let v = serde_json::to_value(&msg).unwrap();
		assert_eq!(v["type"], "reply_rejected");
		assert_eq!(v["reason"], "already_answered");
	}

	#[test]
	fn identity_header_serializes_camelcase() {
		let msg = ServerMessage::IdentityHeader(IdentityHeader {
			session_id: "sess-1".into(),
			repo:       "gajae-code".into(),
			branch:     "feat/notification-surface".into(),
			machine:    "mac-studio".into(),
			title:      Some("Rebuild notifications".into()),
		});
		let v = serde_json::to_value(&msg).unwrap();
		assert_eq!(v["type"], "identity_header");
		assert_eq!(v["sessionId"], "sess-1");
		assert_eq!(v["repo"], "gajae-code");
		assert_eq!(v["branch"], "feat/notification-surface");
		assert_eq!(v["machine"], "mac-studio");
		assert_eq!(v["title"], "Rebuild notifications");
	}

	#[test]
	fn session_closed_serializes_camelcase() {
		let msg = ServerMessage::SessionClosed(SessionClosed { session_id: "sess-1".into() });
		let v = serde_json::to_value(&msg).unwrap();
		assert_eq!(v["type"], "session_closed");
		assert_eq!(v["sessionId"], "sess-1");
	}

	#[test]
	fn context_update_omits_absent_fields() {
		let msg = ServerMessage::ContextUpdate(ContextUpdate {
			session_id:   "sess-1".into(),
			last_message: Some("done".into()),
			task:         None,
			goal:         None,
			token_usage:  Some("12k/200k".into()),
			model:        Some("opus".into()),
			diff:         None,
			cwd:          Some("repo-worktree".into()),
		});
		let v = serde_json::to_value(&msg).unwrap();
		assert_eq!(v["type"], "context_update");
		assert_eq!(v["lastMessage"], "done");
		assert_eq!(v["tokenUsage"], "12k/200k");
		assert_eq!(v["cwd"], "repo-worktree");
		assert!(v.get("task").is_none());
		assert!(v.get("diff").is_none());
	}

	#[test]
	fn turn_stream_phase_serializes_snake_case() {
		let msg = ServerMessage::TurnStream(TurnStream {
			session_id:   "sess-1".into(),
			phase:        TurnPhase::Finalized,
			text:         "final output".into(),
			final_answer: Some(true),
			message_ref:  Some("m-7".into()),
		});
		let v = serde_json::to_value(&msg).unwrap();
		assert_eq!(v["type"], "turn_stream");
		assert_eq!(v["phase"], "finalized");
		assert_eq!(v["finalAnswer"], true);
		assert_eq!(v["messageRef"], "m-7");
	}

	#[test]
	fn tool_activity_serializes_camelcase_snake_tag() {
		let msg = ServerMessage::ToolActivity(ToolActivity {
			session_id:     "sess-1".into(),
			tool_call_id:   "call-1".into(),
			tool_name:      "functions.read".into(),
			phase:          ToolActivityPhase::Completed,
			args_summary:   Some("path: protocol.rs".into()),
			result_summary: Some("1488 lines".into()),
			is_error:       Some(false),
		});
		let value = serde_json::to_value(&msg).unwrap();
		assert_eq!(value["type"], "tool_activity");
		assert_eq!(value["sessionId"], "sess-1");
		assert_eq!(value["toolCallId"], "call-1");
		assert_eq!(value["toolName"], "functions.read");
		assert_eq!(value["phase"], "completed");
		assert_eq!(value["argsSummary"], "path: protocol.rs");
		assert_eq!(value["resultSummary"], "1488 lines");
		assert_eq!(value["isError"], false);
		assert_eq!(serde_json::from_value::<ServerMessage>(value).unwrap(), msg);
	}

	#[test]
	fn reasoning_summary_round_trips() {
		let msg = ServerMessage::ReasoningSummary(ReasoningSummary {
			session_id: "sess-1".into(),
			text:       "Provider summary".into(),
			turn_ref:   Some("turn-1".into()),
		});
		let value = serde_json::to_value(&msg).unwrap();
		assert_eq!(value["type"], "reasoning_summary");
		assert_eq!(value["sessionId"], "sess-1");
		assert_eq!(value["turnRef"], "turn-1");
		assert_eq!(serde_json::from_value::<ServerMessage>(value).unwrap(), msg);
	}

	#[test]
	fn tool_activity_phase_snake_case() {
		for (phase, expected) in [
			(ToolActivityPhase::Started, "started"),
			(ToolActivityPhase::Completed, "completed"),
			(ToolActivityPhase::Failed, "failed"),
			(ToolActivityPhase::Cancelled, "cancelled"),
			(ToolActivityPhase::Unknown, "unknown"),
		] {
			assert_eq!(serde_json::to_string(&phase).unwrap(), format!("\"{expected}\""));
		}
	}

	#[test]
	fn unknown_variant_remains_final_serde_other() {
		let msg: ServerMessage =
			serde_json::from_str(r#"{"type":"totally_unknown","payload":true}"#).unwrap();
		assert_eq!(msg, ServerMessage::Unknown);
	}

	#[test]
	fn server_message_variant_enumeration() {
		// TODO(#2299 rebase): extend to include ephemeral_turn/ephemeral_turn_result.
		let raw = r#"[
			{"type":"tool_activity","sessionId":"sess-1","toolCallId":"call-1","toolName":"functions.read","phase":"started"},
			{"type":"reasoning_summary","sessionId":"sess-1","text":"Provider summary","turnRef":"turn-1"},
			{"type":"future_server_variant","payload":true}
		]"#;
		let messages: Vec<ServerMessage> = serde_json::from_str(raw).unwrap();
		assert_eq!(messages, vec![
			ServerMessage::ToolActivity(ToolActivity {
				session_id:     "sess-1".into(),
				tool_call_id:   "call-1".into(),
				tool_name:      "functions.read".into(),
				phase:          ToolActivityPhase::Started,
				args_summary:   None,
				result_summary: None,
				is_error:       None,
			}),
			ServerMessage::ReasoningSummary(ReasoningSummary {
				session_id: "sess-1".into(),
				text:       "Provider summary".into(),
				turn_ref:   Some("turn-1".into()),
			}),
			ServerMessage::Unknown,
		],);
		let round_tripped: Vec<ServerMessage> =
			serde_json::from_str(&serde_json::to_string(&messages).unwrap()).unwrap();
		assert_eq!(round_tripped, messages);
	}

	#[test]
	fn image_attachment_serializes() {
		let msg = ServerMessage::ImageAttachment(ImageAttachment {
			session_id: "sess-1".into(),
			source:     "computer".into(),
			mime:       "image/png".into(),
			data:       "AAAA".into(),
			caption:    None,
		});
		let v = serde_json::to_value(&msg).unwrap();
		assert_eq!(v["type"], "image_attachment");
		assert_eq!(v["mime"], "image/png");
		assert!(v.get("caption").is_none());
	}

	#[test]
	fn config_update_serializes_verbosity() {
		let msg = ServerMessage::ConfigUpdate(ConfigUpdate {
			session_id: "sess-1".into(),
			verbosity:  Some(Verbosity::Verbose),
			redact:     Some(false),
		});
		let v = serde_json::to_value(&msg).unwrap();
		assert_eq!(v["type"], "config_update");
		assert_eq!(v["verbosity"], "verbose");
		assert_eq!(v["redact"], false);
	}

	#[test]
	fn server_hello_roundtrips_with_capabilities() {
		let hello = ServerMessage::Hello(ServerHello {
			protocol_version: PROTOCOL_VERSION,
			capabilities:     vec![capabilities::THREADED.into(), capabilities::IMAGES.into()],
			connection_id:    None,
		});
		let raw = serde_json::to_string(&hello).unwrap();
		let back: ServerMessage = serde_json::from_str(&raw).unwrap();
		assert_eq!(hello, back);
		let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
		assert_eq!(v["type"], "hello");
		assert_eq!(v["protocolVersion"], PROTOCOL_VERSION);
		assert_eq!(v["capabilities"][0], "threaded");
	}

	#[test]
	fn ping_roundtrips() {
		let raw = r#"{"type":"ping","nonce":"n1"}"#;
		let msg: ClientMessage = serde_json::from_str(raw).unwrap();
		assert_eq!(msg, ClientMessage::Ping(Ping { nonce: "n1".into() }));
		assert_eq!(serde_json::to_string(&msg).unwrap(), raw);
	}

	#[test]
	fn pong_serializes() {
		let msg = ServerMessage::Pong(Pong { nonce: "n1".into() });
		assert_eq!(serde_json::to_string(&msg).unwrap(), r#"{"type":"pong","nonce":"n1"}"#);
	}

	#[test]
	fn server_hello_serializes_client_ping_pong_capability() {
		let msg = ServerMessage::Hello(ServerHello {
			protocol_version: PROTOCOL_VERSION,
			capabilities:     vec![capabilities::CLIENT_PING_PONG.into()],
			connection_id:    None,
		});
		let v: serde_json::Value = serde_json::to_value(&msg).unwrap();
		assert_eq!(v["type"], "hello");
		assert_eq!(v["protocolVersion"], PROTOCOL_VERSION);
		assert!(
			v["capabilities"]
				.as_array()
				.unwrap()
				.iter()
				.any(|cap| cap == capabilities::CLIENT_PING_PONG)
		);
	}

	#[test]
	fn ask_selected_ack_frames_use_camel_case_fields() {
		let request = ServerMessage::AskSelectedAckRequest(AskSelectedAckRequest::Live {
			request_id:  "r1".into(),
			commit_key:  "c1".into(),
			action_id:   "a1".into(),
			deadline_at: 123,
		});
		assert_eq!(
			serde_json::to_string(&request).unwrap(),
			r#"{"type":"ask_selected_ack_request","mode":"live","requestId":"r1","commitKey":"c1","actionId":"a1","deadlineAt":123}"#,
		);
		let result: ClientMessage = serde_json::from_str(
			r#"{"type":"ask_selected_ack_result","requestId":"r1","commitKey":"c1","outcome":{"status":"delivered","messageId":42}}"#,
		)
		.unwrap();
		assert!(matches!(
			result,
			ClientMessage::AskSelectedAckResult(AskSelectedAckResult {
				request_id,
				commit_key,
				outcome: AskSelectedAckOutcome::Delivered { message_id: 42 },
			}) if request_id == "r1" && commit_key == "c1"
		));
	}

	#[test]
	fn ask_selected_ack_frames_reject_malformed_boundaries() {
		for raw in [
			r#"{"type":"ask_selected_ack_request","mode":"live","requestId":"r","commitKey":"c","actionId":"a","deadlineAt":1,"extra":true}"#,
			r#"{"type":"ask_selected_ack_request","mode":"live","requestId":"r","commitKey":"c","deadlineAt":1}"#,
			r#"{"type":"ask_selected_ack_request","mode":"other","requestId":"r","commitKey":"c","deadlineAt":1}"#,
			r#"{"type":"ask_selected_ack_cancel","requestId":"r","commitKey":"c","reason":"bogus"}"#,
		] {
			assert!(serde_json::from_str::<ServerMessage>(raw).is_err(), "accepted {raw}");
		}
		for raw in [
			r#"{"type":"ask_selected_ack_result","requestId":"r","commitKey":"c","outcome":{"status":"delivered"}}"#,
			r#"{"type":"ask_selected_ack_result","requestId":"r","commitKey":"c","outcome":{"status":"failed","reason":"bogus"}}"#,
			r#"{"type":"ask_selected_ack_result","requestId":"r","commitKey":"c","outcome":{"status":"unknown","reason":"host_timeout","extra":true}}"#,
		] {
			assert!(serde_json::from_str::<ClientMessage>(raw).is_err(), "accepted {raw}");
		}
		let recovery: ServerMessage = serde_json::from_str(
			r#"{"type":"ask_selected_ack_request","mode":"recovery","requestId":"r","commitKey":"c","sessionId":"s","actionId":"a","deadlineAt":1}"#,
		)
		.unwrap();
		assert!(matches!(
			recovery,
			ServerMessage::AskSelectedAckRequest(AskSelectedAckRequest::Recovery { .. })
		));
		let cancel: ServerMessage = serde_json::from_str(
			r#"{"type":"ask_selected_ack_cancel","requestId":"r","commitKey":"c","reason":"session_shutdown"}"#,
		)
		.unwrap();
		assert!(matches!(cancel, ServerMessage::AskSelectedAckCancel(_)));
	}

	#[test]
	fn client_hello_parses() {
		let raw = r#"{"type":"hello","protocolVersion":2,"capabilities":["threaded","context"]}"#;
		let msg: ClientMessage = serde_json::from_str(raw).unwrap();
		match msg {
			ClientMessage::Hello(h) => {
				assert_eq!(h.protocol_version, 2);
				assert_eq!(h.capabilities, vec!["threaded", "context"]);
			},
			other => panic!("expected hello, got {other:?}"),
		}
	}

	#[test]
	fn user_message_parses_with_dedupe_fields() {
		let raw = r#"{"type":"user_message","sessionId":"s1","text":"keep going","token":"t","updateId":42,"threadId":"topic-9"}"#;
		let msg: ClientMessage = serde_json::from_str(raw).unwrap();
		match msg {
			ClientMessage::UserMessage(u) => {
				assert_eq!(u.session_id, "s1");
				assert_eq!(u.text, "keep going");
				assert_eq!(u.update_id, Some(42));
				assert_eq!(u.thread_id.as_deref(), Some("topic-9"));
			},
			other => panic!("expected user_message, got {other:?}"),
		}
	}

	#[test]
	fn config_command_parses() {
		let raw = r#"{"type":"config_command","sessionId":"s1","token":"t","verbosity":"lean","redact":true}"#;
		let msg: ClientMessage = serde_json::from_str(raw).unwrap();
		match msg {
			ClientMessage::ConfigCommand(c) => {
				assert_eq!(c.verbosity, Some(Verbosity::Lean));
				assert_eq!(c.redact, Some(true));
			},
			other => panic!("expected config_command, got {other:?}"),
		}
	}

	#[test]
	fn control_command_parses() {
		let raw = r#"{"type":"control_command","sessionId":"s1","token":"t","requestId":"r1","updateId":42,"threadId":"topic-9","command":{"name":"context"}}"#;
		let msg: ClientMessage = serde_json::from_str(raw).unwrap();
		match msg {
			ClientMessage::ControlCommand(c) => {
				assert_eq!(c.session_id, "s1");
				assert_eq!(c.request_id, "r1");
				assert_eq!(c.update_id, Some(42));
				assert_eq!(c.thread_id.as_deref(), Some("topic-9"));
				assert_eq!(c.command["name"], "context");
			},
			other => panic!("expected control_command, got {other:?}"),
		}
	}

	#[test]
	fn control_command_result_model_choices_roundtrip() {
		let msg = ServerMessage::ControlCommandResult(ControlCommandResult {
			session_id:    "s1".into(),
			request_id:    "r1".into(),
			update_id:     Some(42),
			status:        ControlCommandStatus::Ok,
			message:       "Select a model".into(),
			model_choices: Some(vec![ModelChoice {
				selector: "provider/model".into(),
				label:    "Model".into(),
			}]),
		});
		let v = serde_json::to_value(&msg).unwrap();
		assert_eq!(v["type"], "control_command_result");
		assert_eq!(v["sessionId"], "s1");
		assert_eq!(v["requestId"], "r1");
		assert_eq!(v["updateId"], 42);
		assert_eq!(v["status"], "ok");
		assert_eq!(v["modelChoices"][0]["selector"], "provider/model");
		assert_eq!(serde_json::from_value::<ServerMessage>(v).unwrap(), msg);
	}

	#[test]
	fn control_command_result_without_model_choices_remains_compatible() {
		let raw = r#"{"type":"control_command_result","sessionId":"s1","requestId":"r1","status":"ok","message":"done"}"#;
		let msg: ServerMessage = serde_json::from_str(raw).unwrap();
		match msg {
			ServerMessage::ControlCommandResult(result) => assert_eq!(result.model_choices, None),
			other => panic!("expected control_command_result, got {other:?}"),
		}
	}

	#[test]
	fn unknown_server_frame_tolerated_as_unknown() {
		let raw = r#"{"type":"some_future_frame","payload":{"a":1}}"#;
		let msg: ServerMessage = serde_json::from_str(raw).unwrap();
		assert_eq!(msg, ServerMessage::Unknown);
	}

	#[test]
	fn unknown_client_frame_tolerated_as_unknown() {
		let raw = r#"{"type":"some_future_inbound","x":true}"#;
		let msg: ClientMessage = serde_json::from_str(raw).unwrap();
		assert_eq!(msg, ClientMessage::Unknown);
	}

	#[test]
	fn legacy_reply_still_parses_after_additions() {
		let raw = r#"{"type":"reply","id":"a1","answer":2,"token":"t"}"#;
		let msg: ClientMessage = serde_json::from_str(raw).unwrap();
		assert!(matches!(msg, ClientMessage::Reply(_)));
	}

	#[test]
	fn malformed_json_rejected_without_panic() {
		for raw in ["{", "not json", r#"{"type":"reply","id":"a1","answer":2,"token":"t""#] {
			assert!(serde_json::from_str::<ClientMessage>(raw).is_err(), "accepted {raw:?}");
			assert!(serde_json::from_str::<ServerMessage>(raw).is_err(), "accepted {raw:?}");
		}
	}

	#[test]
	fn reply_answer_type_boundaries_are_enforced() {
		let object = r#"{"type":"reply","id":"a1","answer":{"selected":[0,"Maybe"],"custom":"x","future":true},"token":"t"}"#;
		assert!(serde_json::from_str::<ClientMessage>(object).is_err());
		let mixed = r#"{"type":"reply","id":"a1","answer":{"controlId":"navigation_forward","selected":[0]},"token":"t"}"#;
		assert!(serde_json::from_str::<ClientMessage>(mixed).is_err());

		let max = r#"{"type":"reply","id":"a1","answer":4294967295,"token":"t"}"#;
		let ClientMessage::Reply(reply) = serde_json::from_str(max).unwrap() else {
			panic!("expected reply")
		};
		assert_eq!(reply.answer, ReplyAnswer::Index(u32::MAX));

		let text = r#"{"type":"reply","id":"a1","answer":"4294967296","token":"t"}"#;
		let ClientMessage::Reply(reply) = serde_json::from_str(text).unwrap() else {
			panic!("expected reply")
		};
		assert_eq!(reply.answer, ReplyAnswer::Text("4294967296".into()));

		let too_large = r#"{"type":"reply","id":"a1","answer":4294967296,"token":"t"}"#;
		assert!(serde_json::from_str::<ClientMessage>(too_large).is_err());

		let negative = r#"{"type":"reply","id":"a1","answer":-1,"token":"t"}"#;
		assert!(serde_json::from_str::<ClientMessage>(negative).is_err());
	}

	#[test]
	fn user_message_missing_required_fields_is_rejected() {
		let missing_session = r#"{"type":"user_message","text":"keep going","token":"t"}"#;
		let missing_token = r#"{"type":"user_message","sessionId":"s1","text":"keep going"}"#;
		for raw in [missing_session, missing_token] {
			assert!(serde_json::from_str::<ClientMessage>(raw).is_err(), "accepted {raw}");
		}
	}

	#[test]
	fn unknown_nested_fields_are_ignored() {
		let raw = r#"{"type":"user_message","sessionId":"s1","text":"keep going","token":"t","updateId":7,"threadId":"topic-9","futureNested":{"ignored":true}}"#;
		let ClientMessage::UserMessage(msg) = serde_json::from_str(raw).unwrap() else {
			panic!("expected user_message")
		};
		assert_eq!(msg.session_id, "s1");
		assert_eq!(msg.update_id, Some(7));
		assert_eq!(msg.thread_id.as_deref(), Some("topic-9"));
	}

	#[test]
	fn user_message_update_id_accepts_i64_bounds() {
		for (raw, expected) in [
			(
				format!(
					r#"{{"type":"user_message","sessionId":"s1","text":"low","token":"t","updateId":{}}}"#,
					i64::MIN
				),
				i64::MIN,
			),
			(
				format!(
					r#"{{"type":"user_message","sessionId":"s1","text":"high","token":"t","updateId":{}}}"#,
					i64::MAX
				),
				i64::MAX,
			),
		] {
			let ClientMessage::UserMessage(msg) = serde_json::from_str(&raw).unwrap() else {
				panic!("expected user_message")
			};
			assert_eq!(msg.update_id, Some(expected));
		}
	}

	#[test]
	fn hello_accepts_empty_capabilities_vec() {
		let raw = r#"{"type":"hello","protocolVersion":2,"capabilities":[]}"#;
		let ClientMessage::Hello(hello) = serde_json::from_str(raw).unwrap() else {
			panic!("expected hello")
		};
		assert!(hello.capabilities.is_empty());
	}

	#[test]
	fn unknown_type_deserializes_to_unknown() {
		let server: ServerMessage =
			serde_json::from_str(r#"{"type":"future_server","payload":1}"#).unwrap();
		let client: ClientMessage =
			serde_json::from_str(r#"{"type":"future_client","payload":1}"#).unwrap();
		assert_eq!(server, ServerMessage::Unknown);
		assert_eq!(client, ClientMessage::Unknown);
	}

	#[test]
	fn activity_serializes_snake_type_and_state() {
		let msg = ServerMessage::Activity(Activity {
			session_id: "sess-1".into(),
			state:      ActivityState::Busy,
		});
		let v = serde_json::to_value(&msg).unwrap();
		assert_eq!(v["type"], "activity");
		assert_eq!(v["sessionId"], "sess-1");
		assert_eq!(v["state"], "busy");
	}

	#[test]
	fn inbound_ack_roundtrips_consumed() {
		let raw = r#"{"type":"inbound_ack","sessionId":"sess-1","updateId":42,"state":"consumed"}"#;
		let ServerMessage::InboundAck(ack) = serde_json::from_str(raw).unwrap() else {
			panic!("expected inbound_ack")
		};
		assert_eq!(ack.session_id, "sess-1");
		assert_eq!(ack.update_id, 42);
		assert_eq!(ack.state, InboundAckState::Consumed);
	}
}
