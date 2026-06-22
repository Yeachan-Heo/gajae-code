//! Wire protocol for the GJC notifications SDK.
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
	/// An `ask` tool question is pending and (in unattended/RPC mode) can be
	/// answered.
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
	/// Resolved by a remote client reply through the unattended/RPC gate.
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
	/// The session has no unattended gate resolver, so the ask cannot be
	/// answered remotely.
	ResolverUnavailable,
	/// A reply reused an idempotency key with a conflicting body.
	IdempotencyConflict,
	/// The reply token did not match the session token.
	Unauthorized,
}

/// A client-supplied answer to a pending `ask` action.
///
/// Accepts a zero-based option index, an option label / free-text string, or a
/// structured multi-select payload. Deserialization is order-sensitive: a JSON
/// number becomes [`ReplyAnswer::Index`], a JSON string becomes
/// [`ReplyAnswer::Text`], and a JSON object becomes
/// [`ReplyAnswer::Structured`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ReplyAnswer {
	/// Zero-based index into the action's `options`.
	Index(u32),
	/// An option label or free-text answer.
	Text(String),
	/// An explicit multi-select / free-text payload.
	Structured {
		/// Selected options, each an index or a label.
		selected: Vec<AnswerSelector>,
		/// Optional free-text "other" value.
		#[serde(default, skip_serializing_if = "Option::is_none")]
		custom:   Option<String>,
	},
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
	/// Stable action id. For `ask` in unattended/RPC mode this is the real
	/// broker `gate_id`.
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
	/// A short summary (e.g. truncated last assistant message for `idle`).
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub summary:    Option<String>,
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
	/// A pushed configuration update (verbosity/redact).
	ConfigUpdate(ConfigUpdate),
	/// Server capability/version advertisement for negotiation.
	Hello(ServerHello),
	/// Live agent-activity signal driving the client typing indicator.
	Activity(Activity),
	/// Inbound user-message delivery acknowledgement (native double-check UX).
	InboundAck(InboundAck),
	/// Application-level liveness response to a client ping.
	Pong(Pong),
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
	/// Application-level liveness ping from a client.
	Ping(Ping),
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
	pub session_id:  String,
	/// Whether this is a live (throttled) edit or the finalized output.
	pub phase:       TurnPhase,
	/// The rendered text for this chunk.
	pub text:        String,
	/// Opaque ref to coalesce live edits onto one rendered message.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub message_ref: Option<String>,
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

/// Server capability/version advertisement.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerHello {
	/// Protocol version the server speaks.
	pub protocol_version: u32,
	/// Capability tokens the server supports.
	pub capabilities:     Vec<String>,
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

/// Current protocol version emitted in [`ServerHello`].
pub const PROTOCOL_VERSION: u32 = 2;

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
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn action_needed_ask_serializes_camelcase_with_snake_type() {
		let msg = ServerMessage::ActionNeeded(ActionNeeded {
			id:         "wg_run_stage_1".into(),
			kind:       ActionKind::Ask,
			session_id: "sess-1".into(),
			question:   Some("Proceed?".into()),
			options:    Some(vec!["Yes".into(), "No".into()]),
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
	fn idle_action_omits_ask_fields() {
		let msg = ServerMessage::ActionNeeded(ActionNeeded {
			id:         "idle-sess-1-7".into(),
			kind:       ActionKind::Idle,
			session_id: "sess-1".into(),
			question:   None,
			options:    None,
			summary:    Some("done refactoring".into()),
		});
		let v = serde_json::to_value(&msg).unwrap();
		assert_eq!(v["kind"], "idle");
		assert_eq!(v["summary"], "done refactoring");
		assert!(v.get("question").is_none());
		assert!(v.get("options").is_none());
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
			ReplyAnswer::Structured { selected, custom } => {
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
	fn context_update_omits_absent_fields() {
		let msg = ServerMessage::ContextUpdate(ContextUpdate {
			session_id:   "sess-1".into(),
			last_message: Some("done".into()),
			task:         None,
			goal:         None,
			token_usage:  Some("12k/200k".into()),
			model:        Some("opus".into()),
			diff:         None,
		});
		let v = serde_json::to_value(&msg).unwrap();
		assert_eq!(v["type"], "context_update");
		assert_eq!(v["lastMessage"], "done");
		assert_eq!(v["tokenUsage"], "12k/200k");
		assert!(v.get("task").is_none());
		assert!(v.get("diff").is_none());
	}

	#[test]
	fn turn_stream_phase_serializes_snake_case() {
		let msg = ServerMessage::TurnStream(TurnStream {
			session_id:  "sess-1".into(),
			phase:       TurnPhase::Finalized,
			text:        "final output".into(),
			message_ref: Some("m-7".into()),
		});
		let v = serde_json::to_value(&msg).unwrap();
		assert_eq!(v["type"], "turn_stream");
		assert_eq!(v["phase"], "finalized");
		assert_eq!(v["messageRef"], "m-7");
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
		});
		let raw = serde_json::to_string(&hello).unwrap();
		let back: ServerMessage = serde_json::from_str(&raw).unwrap();
		assert_eq!(hello, back);
		let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
		assert_eq!(v["type"], "hello");
		assert_eq!(v["protocolVersion"], 2);
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
		});
		let v: serde_json::Value = serde_json::to_value(&msg).unwrap();
		assert_eq!(v["type"], "hello");
		assert_eq!(v["protocolVersion"], 2);
		assert!(
			v["capabilities"]
				.as_array()
				.unwrap()
				.iter()
				.any(|cap| cap == capabilities::CLIENT_PING_PONG)
		);
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
		let ClientMessage::Reply(reply) = serde_json::from_str(object).unwrap() else {
			panic!("expected reply")
		};
		assert_eq!(reply.answer, ReplyAnswer::Structured {
			selected: vec![AnswerSelector::Index(0), AnswerSelector::Label("Maybe".into())],
			custom:   Some("x".into()),
		});

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
