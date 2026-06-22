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
}

/// Messages sent from a client to the server (upstream).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ClientMessage {
	/// A reply to a pending action.
	Reply(Reply),
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
		let ClientMessage::Reply(reply) = msg;
		assert_eq!(reply.id, "a1");
		assert_eq!(reply.answer, ReplyAnswer::Index(2));
		assert_eq!(reply.token, "t");
		assert!(reply.idempotency_key.is_none());
	}

	#[test]
	fn reply_text_answer_parses_as_text_not_index() {
		let raw =
			r#"{"type":"reply","id":"a1","answer":"Looks good","token":"t","idempotencyKey":"k1"}"#;
		let ClientMessage::Reply(reply) = serde_json::from_str(raw).unwrap();
		assert_eq!(reply.answer, ReplyAnswer::Text("Looks good".into()));
		assert_eq!(reply.idempotency_key.as_deref(), Some("k1"));
	}

	#[test]
	fn reply_structured_answer_parses() {
		let raw =
			r#"{"type":"reply","id":"a1","answer":{"selected":[0,"Maybe"],"custom":"x"},"token":"t"}"#;
		let ClientMessage::Reply(reply) = serde_json::from_str(raw).unwrap();
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
}
