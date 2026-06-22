//! Action lifecycle: pending -> resolved, with buffering, replay, idempotency,
//! and first-valid-reply-wins semantics.
//!
//! The registry is the transport-independent heart of the SDK. The WS server
//! layer (added later) owns sockets and broadcast; it delegates all lifecycle
//! decisions here so the rules are unit-testable without networking.

use std::collections::HashMap;

use crate::protocol::{
	ActionKind, ActionNeeded, ActionResolved, RejectReason, Reply, ReplyAnswer, ResolvedBy,
};

/// Outcome of feeding an inbound [`Reply`] to the registry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReplyOutcome {
	/// The reply resolved the action. Broadcast the contained
	/// [`ActionResolved`].
	Resolved(ActionResolved),
	/// An idempotent retry of an already-accepted reply; safe no-op re-ack.
	DuplicateAccepted,
	/// The reply was rejected. Send the reason to the replying client only.
	Rejected(RejectReason),
}

/// Read-only classification of an inbound reply for host-forwarding mode.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReplyClassification {
	/// Accepted at the WS layer; hand to the host to resolve the real gate.
	Forward,
	/// An idempotent retry of an already-accepted reply; re-ack, do not
	/// re-forward.
	Duplicate,
	/// Reject immediately with this reason (no host involvement).
	Reject(RejectReason),
}

/// A pending action that may still be resolved.
#[derive(Debug, Clone)]
struct PendingAction {
	repliable: bool,
}

/// Record of a resolved action, retained for idempotency and late-reply
/// rejection.
#[derive(Debug, Clone)]
struct ResolvedRecord {
	answer:          Option<ReplyAnswer>,
	idempotency_key: Option<String>,
}

/// Tracks action lifecycle for a single session.
#[derive(Debug, Default)]
pub struct ActionRegistry {
	pending:      HashMap<String, PendingAction>,
	resolved:     HashMap<String, ResolvedRecord>,
	/// The single currently-pending `ask`, replayed to clients that connect
	/// late. Idle pings are intentionally ephemeral and never buffered.
	buffered_ask: Option<ActionNeeded>,
}

impl ActionRegistry {
	/// Create an empty registry.
	#[must_use]
	pub fn new() -> Self {
		Self::default()
	}

	/// Register an `ask` action. It becomes the buffered ask replayed to late
	/// clients.
	///
	/// `repliable` is `false` when the session has no unattended gate resolver,
	/// so the ask is broadcast as notify-only and any reply is rejected with
	/// [`RejectReason::ResolverUnavailable`].
	pub fn register_ask(&mut self, needed: ActionNeeded, repliable: bool) {
		debug_assert_eq!(needed.kind, ActionKind::Ask);
		self.buffered_ask = Some(needed.clone());
		self.pending.insert(needed.id, PendingAction { repliable });
	}

	/// Record an idle ping. Ephemeral: not stored, not buffered, never
	/// repliable. Returned for the caller to broadcast to currently-connected
	/// clients only.
	#[must_use]
	pub fn note_idle(&self, needed: ActionNeeded) -> ActionNeeded {
		debug_assert_eq!(needed.kind, ActionKind::Idle);
		needed
	}

	/// The buffered ask to replay to a newly-connected client, if any is
	/// pending.
	#[must_use]
	pub const fn replay_for_new_client(&self) -> Option<&ActionNeeded> {
		self.buffered_ask.as_ref()
	}

	/// Whether an action with `id` is currently pending.
	#[must_use]
	pub fn is_pending(&self, id: &str) -> bool {
		self.pending.contains_key(id)
	}

	/// Resolve a pending action locally (CLI/TUI answered, or any non-client
	/// path).
	///
	/// First-valid-resolution wins: a second resolution of the same id returns
	/// `None` because the action is already terminal.
	pub fn resolve_local(
		&mut self,
		id: &str,
		answer: Option<ReplyAnswer>,
	) -> Option<ActionResolved> {
		self
			.resolve_internal(id, ResolvedBy::Local, answer, None)
			.ok()
	}

	/// Apply an inbound client [`Reply`].
	///
	/// Token authorization is the caller's responsibility (the server checks the
	/// session token before calling this); pass the result via `authorized`.
	pub fn apply_reply(
		&mut self,
		reply: &Reply,
		authorized: bool,
		resolver_available: bool,
	) -> ReplyOutcome {
		if !authorized {
			return ReplyOutcome::Rejected(RejectReason::Unauthorized);
		}

		// Idempotent retry against an already-resolved action.
		if let Some(record) = self.resolved.get(&reply.id) {
			return match (&record.idempotency_key, &reply.idempotency_key) {
				(Some(existing), Some(incoming)) if existing == incoming => {
					if record.answer.as_ref() == Some(&reply.answer) {
						ReplyOutcome::DuplicateAccepted
					} else {
						ReplyOutcome::Rejected(RejectReason::IdempotencyConflict)
					}
				},
				_ => ReplyOutcome::Rejected(RejectReason::AlreadyAnswered),
			};
		}

		let Some(pending) = self.pending.get(&reply.id) else {
			return ReplyOutcome::Rejected(RejectReason::UnknownAction);
		};

		if !pending.repliable || !resolver_available {
			return ReplyOutcome::Rejected(RejectReason::ResolverUnavailable);
		}

		match self.resolve_internal(
			&reply.id,
			ResolvedBy::Client,
			Some(reply.answer.clone()),
			reply.idempotency_key.clone(),
		) {
			Ok(resolved) => ReplyOutcome::Resolved(resolved),
			// Already resolved between the check above and now (single-threaded here,
			// but keep the branch honest for the locking server layer).
			Err(reason) => ReplyOutcome::Rejected(reason),
		}
	}

	/// Classify an inbound reply **without mutating** state.
	///
	/// Used by the host-forwarding server mode: a
	/// [`ReplyClassification::Forward`] reply should be handed to the host
	/// (which resolves the real gate and then
	/// calls [`ActionRegistry::resolve_client`]); other variants are answered
	/// immediately without involving the host.
	#[must_use]
	pub fn classify_reply(
		&self,
		reply: &Reply,
		authorized: bool,
		resolver_available: bool,
	) -> ReplyClassification {
		if !authorized {
			return ReplyClassification::Reject(RejectReason::Unauthorized);
		}
		if let Some(record) = self.resolved.get(&reply.id) {
			return match (&record.idempotency_key, &reply.idempotency_key) {
				(Some(existing), Some(incoming)) if existing == incoming => {
					if record.answer.as_ref() == Some(&reply.answer) {
						ReplyClassification::Duplicate
					} else {
						ReplyClassification::Reject(RejectReason::IdempotencyConflict)
					}
				},
				_ => ReplyClassification::Reject(RejectReason::AlreadyAnswered),
			};
		}
		let Some(pending) = self.pending.get(&reply.id) else {
			return ReplyClassification::Reject(RejectReason::UnknownAction);
		};
		if !pending.repliable || !resolver_available {
			return ReplyClassification::Reject(RejectReason::ResolverUnavailable);
		}
		ReplyClassification::Forward
	}

	/// Resolve a pending action as answered by a remote client.
	///
	/// Called by the host **after** it has resolved the real workflow gate, so
	/// the broadcast `action_resolved` reflects a genuine resolution (never a
	/// false one). Returns `None` if the action was already terminal.
	pub fn resolve_client(
		&mut self,
		id: &str,
		answer: Option<ReplyAnswer>,
		idempotency_key: Option<String>,
	) -> Option<ActionResolved> {
		self
			.resolve_internal(id, ResolvedBy::Client, answer, idempotency_key)
			.ok()
	}

	fn resolve_internal(
		&mut self,
		id: &str,
		resolved_by: ResolvedBy,
		answer: Option<ReplyAnswer>,
		idempotency_key: Option<String>,
	) -> Result<ActionResolved, RejectReason> {
		if self.pending.remove(id).is_none() {
			return Err(RejectReason::AlreadyAnswered);
		}
		if self.buffered_ask.as_ref().is_some_and(|a| a.id == id) {
			self.buffered_ask = None;
		}
		self
			.resolved
			.insert(id.to_owned(), ResolvedRecord { answer: answer.clone(), idempotency_key });
		Ok(ActionResolved { id: id.to_owned(), resolved_by, answer })
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::protocol::ActionKind;

	fn ask(id: &str) -> ActionNeeded {
		ActionNeeded {
			id:         id.into(),
			kind:       ActionKind::Ask,
			session_id: "s".into(),
			question:   Some("?".into()),
			options:    Some(vec!["Yes".into(), "No".into()]),
			summary:    None,
		}
	}

	fn idle(id: &str) -> ActionNeeded {
		ActionNeeded {
			id:         id.into(),
			kind:       ActionKind::Idle,
			session_id: "s".into(),
			question:   None,
			options:    None,
			summary:    Some("idle".into()),
		}
	}

	fn reply(id: &str, answer: ReplyAnswer) -> Reply {
		Reply { id: id.into(), answer, token: "t".into(), idempotency_key: None }
	}

	#[test]
	fn buffered_ask_is_replayed_to_late_clients() {
		let mut reg = ActionRegistry::new();
		assert!(reg.replay_for_new_client().is_none());
		reg.register_ask(ask("a1"), true);
		assert_eq!(reg.replay_for_new_client().map(|a| a.id.as_str()), Some("a1"));
	}

	#[test]
	fn idle_is_ephemeral_not_buffered() {
		let reg = ActionRegistry::new();
		let msg = reg.note_idle(idle("i1"));
		assert_eq!(msg.id, "i1");
		assert!(reg.replay_for_new_client().is_none());
		assert!(!reg.is_pending("i1"));
	}

	#[test]
	fn first_client_reply_wins_second_is_already_answered() {
		let mut reg = ActionRegistry::new();
		reg.register_ask(ask("a1"), true);
		let first = reg.apply_reply(&reply("a1", ReplyAnswer::Index(0)), true, true);
		assert!(matches!(first, ReplyOutcome::Resolved(r) if r.resolved_by == ResolvedBy::Client));
		// buffered ask cleared after resolution
		assert!(reg.replay_for_new_client().is_none());
		let second = reg.apply_reply(&reply("a1", ReplyAnswer::Index(1)), true, true);
		assert_eq!(second, ReplyOutcome::Rejected(RejectReason::AlreadyAnswered));
	}

	#[test]
	fn local_answer_makes_action_non_repliable() {
		let mut reg = ActionRegistry::new();
		reg.register_ask(ask("a1"), true);
		let resolved = reg.resolve_local("a1", None).expect("first local resolve");
		assert_eq!(resolved.resolved_by, ResolvedBy::Local);
		// a later remote reply is rejected as already answered
		let late = reg.apply_reply(&reply("a1", ReplyAnswer::Index(0)), true, true);
		assert_eq!(late, ReplyOutcome::Rejected(RejectReason::AlreadyAnswered));
		// double local resolve returns None
		assert!(reg.resolve_local("a1", None).is_none());
	}

	#[test]
	fn unknown_action_reply_is_rejected() {
		let mut reg = ActionRegistry::new();
		let out = reg.apply_reply(&reply("nope", ReplyAnswer::Index(0)), true, true);
		assert_eq!(out, ReplyOutcome::Rejected(RejectReason::UnknownAction));
	}

	#[test]
	fn unauthorized_reply_is_rejected() {
		let mut reg = ActionRegistry::new();
		reg.register_ask(ask("a1"), true);
		let out = reg.apply_reply(&reply("a1", ReplyAnswer::Index(0)), false, true);
		assert_eq!(out, ReplyOutcome::Rejected(RejectReason::Unauthorized));
		assert!(reg.is_pending("a1"));
	}

	#[test]
	fn resolver_unavailable_rejects_reply_without_false_resolution() {
		let mut reg = ActionRegistry::new();
		// notify-only ask (interactive/TUI): repliable=false
		reg.register_ask(ask("a1"), false);
		let out = reg.apply_reply(&reply("a1", ReplyAnswer::Index(0)), true, true);
		assert_eq!(out, ReplyOutcome::Rejected(RejectReason::ResolverUnavailable));
		// still pending; no false action_resolved
		assert!(reg.is_pending("a1"));

		// also rejected when the resolver is globally unavailable
		let mut reg2 = ActionRegistry::new();
		reg2.register_ask(ask("a2"), true);
		let out2 = reg2.apply_reply(&reply("a2", ReplyAnswer::Index(0)), true, false);
		assert_eq!(out2, ReplyOutcome::Rejected(RejectReason::ResolverUnavailable));
		assert!(reg2.is_pending("a2"));
	}

	#[test]
	fn idempotent_retry_same_key_same_body_is_duplicate_accepted() {
		let mut reg = ActionRegistry::new();
		reg.register_ask(ask("a1"), true);
		let r1 = Reply {
			id:              "a1".into(),
			answer:          ReplyAnswer::Index(0),
			token:           "t".into(),
			idempotency_key: Some("k1".into()),
		};
		assert!(matches!(reg.apply_reply(&r1, true, true), ReplyOutcome::Resolved(_)));
		// identical retry
		assert_eq!(reg.apply_reply(&r1, true, true), ReplyOutcome::DuplicateAccepted);
	}

	#[test]
	fn idempotency_conflict_same_key_different_body() {
		let mut reg = ActionRegistry::new();
		reg.register_ask(ask("a1"), true);
		let r1 = Reply {
			id:              "a1".into(),
			answer:          ReplyAnswer::Index(0),
			token:           "t".into(),
			idempotency_key: Some("k1".into()),
		};
		let r2 = Reply {
			id:              "a1".into(),
			answer:          ReplyAnswer::Index(1),
			token:           "t".into(),
			idempotency_key: Some("k1".into()),
		};
		assert!(matches!(reg.apply_reply(&r1, true, true), ReplyOutcome::Resolved(_)));
		assert_eq!(
			reg.apply_reply(&r2, true, true),
			ReplyOutcome::Rejected(RejectReason::IdempotencyConflict)
		);
	}
}
