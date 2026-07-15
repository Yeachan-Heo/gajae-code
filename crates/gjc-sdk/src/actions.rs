//! Action lifecycle: pending -> resolved, with buffering, replay, idempotency,
//! and first-valid-reply-wins semantics.
//!
//! The registry is the transport-independent heart of the SDK. The WS server
//! layer (added later) owns sockets and broadcast; it delegates all lifecycle
//! decisions here so the rules are unit-testable without networking.

use std::{
	collections::HashMap,
	sync::atomic::{AtomicU64, Ordering},
};

use crate::protocol::{
	ActionKind, ActionNeeded, ActionResolved, RejectReason, Reply, ReplyAnswer, ResolvedBy,
	WorkflowGateActionNeeded, WorkflowGateWireDiscriminator,
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

/// Registration failed because generic replies cannot distinguish action
/// epochs or correlated wire presentations.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ActionRegistrationError {
	/// This action id has already been registered during this server's lifetime.
	ActionIdAlreadyRegistered,
	/// The action id is bound to a distinct correlated wire presentation.
	CorrelatedPresentationCollision,
}

impl std::fmt::Display for ActionRegistrationError {
	fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		match self {
			Self::ActionIdAlreadyRegistered => formatter.write_str("action id is already registered"),
			Self::CorrelatedPresentationCollision => {
				formatter.write_str("action id is bound to a distinct correlated wire presentation")
			},
		}
	}
}

impl std::error::Error for ActionRegistrationError {}

/// A pending action that may still be resolved.
#[derive(Debug, Clone)]
struct PendingAction {
	repliable: bool,
	claim:     Option<Claim>,
}

#[derive(Debug, Clone)]
struct Claim {
	receipt_id:      String,
	connection_id:   String,
	generation:      String,
	answer:          ReplyAnswer,
	idempotency_key: Option<String>,
}

/// An atomically claimed reply that may be forwarded to the host exactly once.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClaimedReply {
	pub reply:            Reply,
	pub reply_receipt_id: String,
}

/// Authenticated connection provenance retained for a claimed reply receipt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReplyOrigin {
	pub connection_id: String,
	pub generation:    String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ClaimOutcome {
	Forward(ClaimedReply),
	Duplicate,
	Reject(RejectReason),
}

/// Concrete identity of the canonical buffered ask.
///
/// The epoch changes on every registration, including same-id replacement, so a
/// delivery from an older registration cannot authorize a newer action.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActionIdentity {
	/// Stable action id.
	pub id:    String,
	/// Monotonic registration epoch for this id.
	pub epoch: u64,
}

/// Typed terminal proof for an exact in-process presentation lease.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RetireIfUnclaimed {
	Retired(ActionResolved),
	AlreadyTerminal,
	Claimed,
	Stale,
}

/// Record of a resolved action, retained for idempotency and late-reply
/// rejection.
#[derive(Debug, Clone)]
struct ResolvedRecord {
	answer:             Option<ReplyAnswer>,
	idempotency_key:    Option<String>,
	registration_epoch: u64,
}

/// Tracks action lifecycle for a single session.
#[derive(Debug, Default)]
pub struct ActionRegistry {
	pending: HashMap<String, PendingAction>,
	resolved: HashMap<String, ResolvedRecord>,
	receipts: HashMap<String, String>,
	origins: HashMap<String, ReplyOrigin>,
	next_receipt: AtomicU64,
	/// The single currently-pending `ask`, replayed to clients that connect
	/// late. Idle pings are intentionally ephemeral and never buffered.
	buffered_ask: Option<ActionNeeded>,
	/// Monotonic registration epoch for the canonical buffered ask.
	epoch: u64,
	/// Private durable correlation for the canonical presentation.
	workflow_gate_id: Option<String>,
	/// Complete private identity for the canonical correlated presentation.
	workflow_gate_registration: Option<WorkflowGateRegistrationIdentity>,
}

/// Correlated authority includes both the outer wire discriminator and the
/// action kind, so identifiers cannot cross-bind distinct wire presentations.
#[derive(Debug, Clone, PartialEq, Eq)]
struct WorkflowGateRegistrationIdentity {
	wire_discriminator: WorkflowGateWireDiscriminator,
	action_kind:        ActionKind,
	action_id:          String,
	session_id:         String,
	workflow_gate_id:   String,
}

impl WorkflowGateRegistrationIdentity {
	fn new(
		wire_discriminator: WorkflowGateWireDiscriminator,
		needed: &ActionNeeded,
		workflow_gate_id: &str,
	) -> Self {
		Self {
			wire_discriminator,
			action_kind: needed.kind,
			action_id: needed.id.clone(),
			session_id: needed.session_id.clone(),
			workflow_gate_id: workflow_gate_id.to_owned(),
		}
	}
}

impl ActionRegistry {
	/// Create an empty registry.
	#[must_use]
	pub fn new() -> Self {
		Self::default()
	}

	/// Register an `ask` action. It becomes the canonical buffered ask used by
	/// tailored connection delivery. Duplicate action ids are rejected without
	/// mutation; use [`Self::try_register_ask`] to observe the typed failure.
	///
	/// `repliable` is `false` when the session has no SDK workflow-gate
	/// resolver, so the ask is broadcast as notify-only and any reply is
	/// rejected with [`RejectReason::ResolverUnavailable`].
	pub fn register_ask(&mut self, needed: ActionNeeded, repliable: bool) {
		let _ = self.try_register_ask(needed, repliable);
	}

	/// Register an `ask`, returning an error rather than reusing an action id.
	pub fn try_register_ask(
		&mut self,
		needed: ActionNeeded,
		repliable: bool,
	) -> Result<(), ActionRegistrationError> {
		self.register(needed, None, repliable)
	}

	/// Register an ask whose wire presentation carries durable workflow-gate
	/// correlation. Generic reply authority remains the action id.
	pub fn register_workflow_gate_ask(
		&mut self,
		needed: ActionNeeded,
		workflow_gate_id: String,
		repliable: bool,
	) {
		let _ = self.try_register_workflow_gate_ask(needed, workflow_gate_id, repliable);
	}

	/// Register a correlated workflow-gate ask, rejecting reused action ids.
	pub fn try_register_workflow_gate_ask(
		&mut self,
		needed: ActionNeeded,
		workflow_gate_id: String,
		repliable: bool,
	) -> Result<(), ActionRegistrationError> {
		self.try_register_workflow_gate_ask_with_discriminator(
			needed,
			workflow_gate_id,
			WorkflowGateWireDiscriminator::ActionNeeded,
			repliable,
		)
	}

	pub(crate) fn try_register_workflow_gate_ask_with_discriminator(
		&mut self,
		needed: ActionNeeded,
		workflow_gate_id: String,
		wire_discriminator: WorkflowGateWireDiscriminator,
		repliable: bool,
	) -> Result<(), ActionRegistrationError> {
		let identity =
			WorkflowGateRegistrationIdentity::new(wire_discriminator, &needed, &workflow_gate_id);
		if let Some(current) = &self.workflow_gate_registration {
			if current == &identity {
				if self.buffered_ask.as_ref() == Some(&needed)
					&& self
						.pending
						.get(&needed.id)
						.is_some_and(|pending| pending.repliable == repliable)
				{
					return Ok(());
				}
			} else if current.action_id == needed.id {
				return Err(ActionRegistrationError::CorrelatedPresentationCollision);
			}
		}
		self.register(needed, Some((workflow_gate_id, identity)), repliable)
	}

	fn register(
		&mut self,
		needed: ActionNeeded,
		workflow_gate: Option<(String, WorkflowGateRegistrationIdentity)>,
		repliable: bool,
	) -> Result<(), ActionRegistrationError> {
		debug_assert_eq!(needed.kind, ActionKind::Ask);
		// Generic wire replies carry only the action id, not an epoch. Reusing an
		// id while it is pending or terminal would let a delayed reply authorize a
		// different action, so every registered id is a server-lifetime tombstone.
		if self.pending.contains_key(&needed.id) || self.resolved.contains_key(&needed.id) {
			return Err(ActionRegistrationError::ActionIdAlreadyRegistered);
		}
		if let Some(previous_id) = self.buffered_ask.as_ref().map(|ask| ask.id.clone()) {
			self.retire_pending(&previous_id);
		}
		self.epoch = self
			.epoch
			.checked_add(1)
			.expect("action registry epoch exhausted");
		self.buffered_ask = Some(needed.clone());
		let (workflow_gate_id, workflow_gate_registration) =
			workflow_gate.map_or((None, None), |(id, identity)| (Some(id), Some(identity)));
		self.workflow_gate_id = workflow_gate_id;
		self.workflow_gate_registration = workflow_gate_registration;
		self
			.pending
			.insert(needed.id, PendingAction { repliable, claim: None });
		Ok(())
	}

	fn retire_pending(&mut self, id: &str) {
		let Some(pending) = self.pending.remove(id) else {
			return;
		};
		if let Some(claim) = pending.claim {
			self.receipts.remove(&claim.receipt_id);
			self.origins.remove(&claim.receipt_id);
		}
		// Supersession does not emit an action_resolved frame, but the old id must
		// remain terminal so its delayed generic replies cannot authorize a reissue.
		self.resolved.insert(id.to_owned(), ResolvedRecord {
			answer:             None,
			idempotency_key:    None,
			registration_epoch: self.epoch,
		});
	}

	/// Record an idle ping. Ephemeral: not stored, not buffered, never
	/// repliable. Returned for the caller to broadcast to currently-connected
	/// clients only.
	#[must_use]
	pub fn note_idle(&self, needed: ActionNeeded) -> ActionNeeded {
		debug_assert_eq!(needed.kind, ActionKind::Idle);
		needed
	}

	/// Identity of the current canonical buffered ask, if any.
	#[must_use]
	pub fn current_identity(&self) -> Option<ActionIdentity> {
		self
			.buffered_ask
			.as_ref()
			.map(|ask| ActionIdentity { id: ask.id.clone(), epoch: self.epoch })
	}

	/// Clone the canonical ask and its concrete registration identity for
	/// connection-specific presentation.
	#[must_use]
	pub fn current_ask_snapshot(&self) -> Option<(ActionNeeded, ActionIdentity)> {
		self.buffered_ask.clone().map(|ask| {
			let identity = ActionIdentity { id: ask.id.clone(), epoch: self.epoch };
			(ask, identity)
		})
	}

	/// Clone the canonical ask, private correlation metadata, and registration
	/// identity for connection-specific wire presentation.
	#[must_use]
	pub(crate) fn current_wire_snapshot(
		&self,
	) -> Option<(ActionNeeded, Option<String>, ActionIdentity)> {
		self.buffered_ask.clone().map(|action| {
			let identity = ActionIdentity { id: action.id.clone(), epoch: self.epoch };
			(action, self.workflow_gate_id.clone(), identity)
		})
	}

	/// Clone the current correlated workflow presentation, if one is active.
	#[must_use]
	pub fn current_workflow_gate_ask(&self) -> Option<(WorkflowGateActionNeeded, ActionIdentity)> {
		let action = self.buffered_ask.clone()?;
		let workflow_gate_id = self.workflow_gate_id.clone()?;
		let identity = ActionIdentity { id: action.id.clone(), epoch: self.epoch };
		Some((WorkflowGateActionNeeded { action, workflow_gate_id }, identity))
	}

	/// Atomically terminalize an exact unclaimed presentation. Claims win once
	/// acquired, and a stale lease never mutates registry state.
	pub fn retire_if_unclaimed(&mut self, expected: &ActionIdentity) -> RetireIfUnclaimed {
		let Some(current) = self.current_identity() else {
			return if self
				.resolved
				.get(&expected.id)
				.is_some_and(|resolved| resolved.registration_epoch == expected.epoch)
			{
				RetireIfUnclaimed::AlreadyTerminal
			} else {
				RetireIfUnclaimed::Stale
			};
		};
		if &current != expected {
			return RetireIfUnclaimed::Stale;
		}
		if self.has_claim_for_action(&expected.id) {
			return RetireIfUnclaimed::Claimed;
		}
		match self.resolve_internal(&expected.id, ResolvedBy::Local, None, None) {
			Ok(resolved) => RetireIfUnclaimed::Retired(resolved),
			Err(_) => RetireIfUnclaimed::Stale,
		}
	}

	fn controlled_identity_for(&self, id: &str) -> Option<ActionIdentity> {
		self
			.buffered_ask
			.as_ref()
			.filter(|ask| ask.id == id && !ask.controls.is_empty())
			.map(|ask| ActionIdentity { id: ask.id.clone(), epoch: self.epoch })
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
		if self
			.pending
			.get(id)
			.is_some_and(|pending| pending.claim.is_some())
		{
			return None;
		}
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

	/// Atomically compare a controlled reply's delivered identity before
	/// applying it. Ordinary asks preserve [`Self::apply_reply`] behavior
	/// without a delivery requirement.
	pub fn apply_reply_if_delivered(
		&mut self,
		delivered: Option<&ActionIdentity>,
		reply: &Reply,
		authorized: bool,
		resolver_available: bool,
	) -> ReplyOutcome {
		if self
			.controlled_identity_for(&reply.id)
			.is_some_and(|current| delivered != Some(&current))
		{
			return ReplyOutcome::Rejected(RejectReason::InvalidAnswer);
		}
		self.apply_reply(reply, authorized, resolver_available)
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

	/// Atomically claim a reply for host forwarding. A claim binds the
	/// authenticated connection id/generation and yields one receipt; duplicate
	/// same-body retries do not re-forward, while conflicts are rejected.
	pub fn claim_reply(
		&mut self,
		reply: &Reply,
		connection_id: &str,
		generation: &str,
		authorized: bool,
		resolver_available: bool,
	) -> ClaimOutcome {
		if !authorized {
			return ClaimOutcome::Reject(RejectReason::Unauthorized);
		}
		if let Some(record) = self.resolved.get(&reply.id) {
			return match (&record.idempotency_key, &reply.idempotency_key) {
				(Some(existing), Some(incoming))
					if existing == incoming && record.answer.as_ref() == Some(&reply.answer) =>
				{
					ClaimOutcome::Duplicate
				},
				(Some(existing), Some(incoming)) if existing == incoming => {
					ClaimOutcome::Reject(RejectReason::IdempotencyConflict)
				},
				_ => ClaimOutcome::Reject(RejectReason::AlreadyAnswered),
			};
		}
		let Some(pending) = self.pending.get_mut(&reply.id) else {
			return ClaimOutcome::Reject(RejectReason::UnknownAction);
		};
		if !pending.repliable || !resolver_available {
			return ClaimOutcome::Reject(RejectReason::ResolverUnavailable);
		}
		if let Some(claim) = &pending.claim {
			return if claim.connection_id == connection_id
				&& claim.generation == generation
				&& claim.idempotency_key == reply.idempotency_key
				&& claim.answer == reply.answer
			{
				ClaimOutcome::Duplicate
			} else {
				ClaimOutcome::Reject(RejectReason::IdempotencyConflict)
			};
		}
		let receipt_id = format!("reply:{}", self.next_receipt.fetch_add(1, Ordering::Relaxed));
		pending.claim = Some(Claim {
			receipt_id:      receipt_id.clone(),
			connection_id:   connection_id.to_owned(),
			generation:      generation.to_owned(),
			answer:          reply.answer.clone(),
			idempotency_key: reply.idempotency_key.clone(),
		});
		self.receipts.insert(receipt_id.clone(), reply.id.clone());
		self.origins.insert(receipt_id.clone(), ReplyOrigin {
			connection_id: connection_id.to_owned(),
			generation:    generation.to_owned(),
		});
		ClaimOutcome::Forward(ClaimedReply {
			reply:            reply.clone(),
			reply_receipt_id: receipt_id,
		})
	}

	/// Atomically compare a controlled reply's delivered identity before
	/// claiming it for host forwarding. Ordinary asks preserve
	/// [`Self::claim_reply`] behavior without a delivery requirement.
	pub fn claim_reply_if_delivered(
		&mut self,
		delivered: Option<&ActionIdentity>,
		reply: &Reply,
		connection_id: &str,
		generation: &str,
		authorized: bool,
		resolver_available: bool,
	) -> ClaimOutcome {
		if self
			.controlled_identity_for(&reply.id)
			.is_some_and(|current| delivered != Some(&current))
		{
			return ClaimOutcome::Reject(RejectReason::InvalidAnswer);
		}
		self.claim_reply(reply, connection_id, generation, authorized, resolver_available)
	}

	/// Return the authenticated origin bound to a receipt, including after the
	/// action itself became terminal. This is provenance, not authority to
	/// reopen the action.
	#[must_use]
	pub fn claim_origin(&self, receipt_id: &str) -> Option<ReplyOrigin> {
		self.origins.get(receipt_id).cloned()
	}

	#[must_use]
	pub fn claim_action_id(&self, receipt_id: &str) -> Option<String> {
		self.receipts.get(receipt_id).cloned()
	}

	#[must_use]
	pub fn has_claim_for_action(&self, id: &str) -> bool {
		self
			.pending
			.get(id)
			.is_some_and(|pending| pending.claim.is_some())
	}

	/// Complete a claimed reply. A receipt cannot settle a different action.
	pub fn resolve_claim(
		&mut self,
		receipt_id: &str,
		answer: Option<ReplyAnswer>,
		idempotency_key: Option<String>,
	) -> Option<ActionResolved> {
		let id = self.receipts.get(receipt_id)?.clone();
		let pending = self.pending.get(&id)?;
		let claim = pending.claim.as_ref()?;
		if claim.receipt_id != receipt_id
			|| answer.as_ref() != Some(&claim.answer)
			|| idempotency_key != claim.idempotency_key
		{
			return None;
		}
		self
			.resolve_internal(&id, ResolvedBy::Client, answer, idempotency_key)
			.ok()
	}

	/// Terminally close a claimed invalid reply. The interaction must be
	/// reissued under a fresh action id; it is never reopened.
	pub fn close_claim_invalid(&mut self, receipt_id: &str) -> Option<ActionResolved> {
		let id = self.receipts.get(receipt_id)?.clone();
		let pending = self.pending.get(&id)?;
		if !matches!(pending.claim.as_ref(), Some(claim) if claim.receipt_id == receipt_id) {
			return None;
		}
		self
			.resolve_internal(&id, ResolvedBy::Client, None, None)
			.ok()
	}

	/// Cancel a claim during abort/shutdown and terminalize its pending action.
	pub fn cancel_claim(&mut self, receipt_id: &str) -> Option<ActionResolved> {
		self.close_claim_invalid(receipt_id)
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
		if self
			.pending
			.get(id)
			.is_some_and(|pending| pending.claim.is_some())
		{
			return None;
		}
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
		let Some(pending) = self.pending.remove(id) else {
			return Err(RejectReason::AlreadyAnswered);
		};
		if let Some(claim) = pending.claim {
			self.receipts.remove(&claim.receipt_id);
			self.origins.remove(&claim.receipt_id);
		}
		if self.buffered_ask.as_ref().is_some_and(|a| a.id == id) {
			self.buffered_ask = None;
			self.workflow_gate_id = None;
			self.workflow_gate_registration = None;
		}
		self.resolved.insert(id.to_owned(), ResolvedRecord {
			answer: answer.clone(),
			idempotency_key,
			registration_epoch: self.epoch,
		});
		Ok(ActionResolved { id: id.to_owned(), resolved_by, answer })
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::protocol::{ActionKind, AskControl};

	fn ask(id: &str) -> ActionNeeded {
		ActionNeeded {
			id:         id.into(),
			kind:       ActionKind::Ask,
			session_id: "s".into(),
			question:   Some("?".into()),
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

	fn reply(id: &str, answer: ReplyAnswer) -> Reply {
		Reply { id: id.into(), answer, token: "t".into(), idempotency_key: None }
	}

	#[test]
	fn canonical_ask_snapshot_tracks_pending_ask() {
		let mut reg = ActionRegistry::new();
		assert!(reg.current_ask_snapshot().is_none());
		reg.register_ask(ask("a1"), true);
		let (needed, identity) = reg.current_ask_snapshot().expect("canonical ask snapshot");
		assert_eq!(needed.id, "a1");
		assert_eq!(identity.id, "a1");
	}

	#[test]
	fn idle_is_ephemeral_not_buffered() {
		let reg = ActionRegistry::new();
		let msg = reg.note_idle(idle("i1"));
		assert_eq!(msg.id, "i1");
		assert!(reg.current_ask_snapshot().is_none());
		assert!(!reg.is_pending("i1"));
	}

	#[test]
	fn first_client_reply_wins_second_is_already_answered() {
		let mut reg = ActionRegistry::new();
		reg.register_ask(ask("a1"), true);
		let first = reg.apply_reply(&reply("a1", ReplyAnswer::Index(0)), true, true);
		assert!(matches!(first, ReplyOutcome::Resolved(r) if r.resolved_by == ResolvedBy::Client));
		// buffered ask cleared after resolution
		assert!(reg.current_ask_snapshot().is_none());
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

	#[test]
	fn claimed_reply_requires_authorization_and_exact_settlement() {
		let mut reg = ActionRegistry::new();
		reg.register_ask(ask("a1"), true);
		let mut incoming = reply("a1", ReplyAnswer::Index(0));
		incoming.idempotency_key = Some("k1".into());
		assert_eq!(
			reg.claim_reply(&incoming, "c1", "g1", false, true),
			ClaimOutcome::Reject(RejectReason::Unauthorized),
		);
		let claim = match reg.claim_reply(&incoming, "c1", "g1", true, true) {
			ClaimOutcome::Forward(claim) => claim,
			other => panic!("expected forwarded claim, got {other:?}"),
		};
		assert!(
			reg.resolve_claim(&claim.reply_receipt_id, Some(ReplyAnswer::Index(1)), Some("k1".into()))
				.is_none()
		);
		assert!(reg.is_pending("a1"));
		assert!(
			reg.resolve_claim(&claim.reply_receipt_id, Some(ReplyAnswer::Index(0)), Some("k1".into()))
				.is_some()
		);
		assert!(reg.claim_origin(&claim.reply_receipt_id).is_none());
	}

	#[test]
	fn invalid_claim_close_is_terminal_and_cleans_origin() {
		let mut reg = ActionRegistry::new();
		reg.register_ask(ask("a1"), true);
		let incoming = reply("a1", ReplyAnswer::Text("bad".into()));
		let claim = match reg.claim_reply(&incoming, "c1", "g1", true, true) {
			ClaimOutcome::Forward(claim) => claim,
			other => panic!("expected forwarded claim, got {other:?}"),
		};
		assert!(reg.close_claim_invalid(&claim.reply_receipt_id).is_some());
		assert!(!reg.is_pending("a1"));
		assert!(reg.claim_origin(&claim.reply_receipt_id).is_none());
	}

	#[test]
	fn resolved_same_id_reregistration_preserves_terminal_tombstone() {
		let mut reg = ActionRegistry::new();
		reg.register_ask(ask("a1"), true);
		let terminal = reg.resolve_local("a1", None).expect("local resolution");

		assert_eq!(
			reg.try_register_ask(ask("a1"), true),
			Err(ActionRegistrationError::ActionIdAlreadyRegistered)
		);

		assert!(!reg.is_pending("a1"));
		assert!(reg.current_ask_snapshot().is_none());
		assert!(reg.resolved.contains_key(&terminal.id));
	}

	#[test]
	fn stale_delayed_reply_cannot_authorize_rejected_same_id_reregistration() {
		let mut reg = ActionRegistry::new();
		reg.register_ask(ask("a1"), true);
		assert!(reg.resolve_local("a1", None).is_some());
		assert_eq!(
			reg.try_register_ask(ask("a1"), true),
			Err(ActionRegistrationError::ActionIdAlreadyRegistered)
		);

		let delayed = reply("a1", ReplyAnswer::Index(0));
		assert_eq!(
			reg.apply_reply(&delayed, true, true),
			ReplyOutcome::Rejected(RejectReason::AlreadyAnswered)
		);
		assert_eq!(
			reg.claim_reply(&delayed, "c1", "g1", true, true),
			ClaimOutcome::Reject(RejectReason::AlreadyAnswered)
		);
		assert!(!reg.is_pending("a1"));
	}

	#[test]
	fn superseded_action_reply_is_rejected_without_mutating_current_action() {
		let mut reg = ActionRegistry::new();
		reg.register_ask(controlled_ask("a1"), true);
		let delivered = reg.current_identity().expect("first identity");
		reg.register_ask(ask("a2"), true);
		let current = reg.current_identity().expect("replacement identity");
		let incoming = reply("a1", ReplyAnswer::Index(0));

		assert_eq!(
			reg.apply_reply_if_delivered(Some(&delivered), &incoming, true, true),
			ReplyOutcome::Rejected(RejectReason::AlreadyAnswered),
		);
		assert_eq!(
			reg.claim_reply_if_delivered(Some(&delivered), &incoming, "c1", "g1", true, true),
			ClaimOutcome::Reject(RejectReason::AlreadyAnswered),
		);
		assert!(!reg.is_pending("a1"));
		assert!(!reg.has_claim_for_action("a1"));
		assert!(reg.receipts.is_empty());
		assert!(reg.origins.is_empty());
		assert_eq!(reg.current_identity(), Some(current));
		assert!(reg.is_pending("a2"));
		assert_eq!(
			reg.try_register_ask(ask("a1"), true),
			Err(ActionRegistrationError::ActionIdAlreadyRegistered)
		);
		assert!(matches!(
			reg.apply_reply(&reply("a2", ReplyAnswer::Index(1)), true, true),
			ReplyOutcome::Resolved(ActionResolved { resolved_by: ResolvedBy::Client, .. })
		));
	}

	#[test]
	fn superseding_claimed_action_cleans_receipt_and_origin() {
		let mut reg = ActionRegistry::new();
		reg.register_ask(ask("a1"), true);
		let claim = match reg.claim_reply(&reply("a1", ReplyAnswer::Index(0)), "c1", "g1", true, true)
		{
			ClaimOutcome::Forward(claim) => claim,
			other => panic!("expected forwarded claim, got {other:?}"),
		};
		assert_eq!(reg.claim_action_id(&claim.reply_receipt_id).as_deref(), Some("a1"));
		assert!(reg.claim_origin(&claim.reply_receipt_id).is_some());

		reg.register_ask(ask("a2"), true);

		assert!(!reg.is_pending("a1"));
		assert!(reg.claim_action_id(&claim.reply_receipt_id).is_none());
		assert!(reg.claim_origin(&claim.reply_receipt_id).is_none());
		assert!(reg.receipts.is_empty());
		assert!(reg.origins.is_empty());
		assert!(reg.is_pending("a2"));
	}

	#[test]
	fn pending_same_id_registration_is_rejected_without_mutating_original_action() {
		let mut reg = ActionRegistry::new();
		reg.register_ask(ask("a1"), true);
		let original = reg.current_identity().expect("original identity");

		assert_eq!(
			reg.try_register_ask(ask("a1"), true),
			Err(ActionRegistrationError::ActionIdAlreadyRegistered)
		);
		assert_eq!(reg.current_identity(), Some(original));
		assert!(reg.is_pending("a1"));
	}

	#[test]
	fn delayed_reply_after_rejected_pending_reregistration_resolves_only_original_action() {
		let mut reg = ActionRegistry::new();
		reg.register_ask(controlled_ask("a1"), true);
		let original = reg.current_identity().expect("original identity");
		assert_eq!(
			reg.try_register_ask(controlled_ask("a1"), true),
			Err(ActionRegistrationError::ActionIdAlreadyRegistered)
		);

		let incoming = reply("a1", ReplyAnswer::Index(0));
		assert!(matches!(
			reg.apply_reply_if_delivered(Some(&original), &incoming, true, true),
			ReplyOutcome::Resolved(ActionResolved { resolved_by: ResolvedBy::Client, .. })
		));
		assert!(!reg.is_pending("a1"));
	}

	#[test]
	fn compare_and_claim_mismatch_is_mutation_free() {
		let mut reg = ActionRegistry::new();
		reg.register_ask(controlled_ask("a1"), true);
		let delivered = ActionIdentity { id: "a1".into(), epoch: 0 };
		let incoming = reply("a1", ReplyAnswer::Index(0));
		assert_eq!(
			reg.claim_reply_if_delivered(Some(&delivered), &incoming, "c1", "g1", true, true),
			ClaimOutcome::Reject(RejectReason::InvalidAnswer),
		);
		assert!(reg.is_pending("a1"));
		assert!(!reg.has_claim_for_action("a1"));
	}

	#[test]
	fn tailored_snapshot_never_mutates_canonical_controls() {
		let mut reg = ActionRegistry::new();
		reg.register_ask(controlled_ask("a1"), true);
		let (mut tailored, _) = reg.current_ask_snapshot().expect("snapshot");
		tailored.controls.clear();
		assert_eq!(
			reg.current_ask_snapshot()
				.expect("canonical snapshot")
				.0
				.controls
				.len(),
			1
		);
	}

	#[test]
	fn retire_if_unclaimed_is_exact_and_claim_wins() {
		let mut reg = ActionRegistry::new();
		reg.register_workflow_gate_ask(ask("a1"), "gate-1".into(), true);
		let identity = reg.current_identity().expect("identity");
		let (workflow, _) = reg.current_workflow_gate_ask().expect("workflow metadata");
		assert_eq!(workflow.workflow_gate_id, "gate-1");

		let stale = ActionIdentity { id: "a1".into(), epoch: identity.epoch - 1 };
		assert_eq!(reg.retire_if_unclaimed(&stale), RetireIfUnclaimed::Stale);
		assert!(reg.is_pending("a1"));

		let claim = reg.claim_reply(&reply("a1", ReplyAnswer::Index(0)), "c1", "g1", true, true);
		assert!(matches!(claim, ClaimOutcome::Forward(_)));
		assert_eq!(reg.retire_if_unclaimed(&identity), RetireIfUnclaimed::Claimed);
		assert!(reg.has_claim_for_action("a1"));
		assert_eq!(reg.current_identity(), Some(identity));
	}

	#[test]
	fn retire_if_unclaimed_terminalizes_once_without_receipt() {
		let mut reg = ActionRegistry::new();
		reg.register_ask(ask("a1"), true);
		let identity = reg.current_identity().expect("identity");
		assert!(matches!(reg.retire_if_unclaimed(&identity), RetireIfUnclaimed::Retired(_)));
		assert_eq!(reg.retire_if_unclaimed(&identity), RetireIfUnclaimed::AlreadyTerminal);
		assert!(reg.current_identity().is_none());
	}

	#[test]
	fn correlated_wire_kind_identity_rejects_cross_wire_collision_and_settles_once() {
		let mut reg = ActionRegistry::new();
		let first = ask("presentation-1");
		reg.try_register_workflow_gate_ask_with_discriminator(
			first.clone(),
			"gate-1".into(),
			WorkflowGateWireDiscriminator::ActionNeeded,
			true,
		)
		.unwrap();
		let identity = reg.current_identity().expect("first identity");

		assert_eq!(
			reg.try_register_workflow_gate_ask_with_discriminator(
				first.clone(),
				"gate-1".into(),
				WorkflowGateWireDiscriminator::ActionUnavailable,
				true,
			),
			Err(ActionRegistrationError::CorrelatedPresentationCollision)
		);
		assert_eq!(
			reg.try_register_workflow_gate_ask_with_discriminator(
				idle("presentation-1"),
				"gate-1".into(),
				WorkflowGateWireDiscriminator::ActionNeeded,
				true,
			),
			Err(ActionRegistrationError::CorrelatedPresentationCollision)
		);
		assert_eq!(reg.current_identity(), Some(identity.clone()));
		assert_eq!(
			reg.current_workflow_gate_ask()
				.expect("first workflow")
				.0
				.action,
			first
		);

		// Retrying the exact presentation is idempotent and does not issue a new lease.
		assert!(
			reg.try_register_workflow_gate_ask_with_discriminator(
				ask("presentation-1"),
				"gate-1".into(),
				WorkflowGateWireDiscriminator::ActionNeeded,
				true,
			)
			.is_ok()
		);
		assert_eq!(reg.current_identity(), Some(identity.clone()));

		assert!(matches!(
			reg.apply_reply_if_delivered(
				Some(&identity),
				&reply("presentation-1", ReplyAnswer::Index(0)),
				true,
				true,
			),
			ReplyOutcome::Resolved(_)
		));
		assert!(matches!(
			reg.apply_reply_if_delivered(
				Some(&identity),
				&reply("presentation-1", ReplyAnswer::Index(0)),
				true,
				true,
			),
			ReplyOutcome::Rejected(RejectReason::AlreadyAnswered)
		));
	}
}
