/**
 * Private terminal-abort machinery for C04 `turn.abort` `mode:"terminal"`.
 *
 * Corrected semantics (approved plan, user-directed; see the plan's prominent
 * design note): `scope:"turn"` stops the ROOT WORKER's current turn and blocks
 * ONLY its own continuation routes (same-turn retry, TTSR/`agent.continue`,
 * steering continuation, hidden-next-turn, maintenance/worker successor,
 * accepted-pre-close same-attempt continuation). Left-running owned work
 * (background Bash/task jobs, detached subagents) keeps running and its
 * completions are DELIVERED NORMALLY through the existing
 * YieldQueue -> `agent.followUp`/`agent.prompt` path so the root worker can
 * resume with a fresh attempt. Owned delivery is intentionally NOT suppressed.
 *
 * The earlier stage-04 no-successor delivery fence was a misunderstanding and
 * must not be reinstated under any name.
 */
import { createHash, randomUUID } from "node:crypto";

/** Origin class assigned to every causal callback/queue entry before escape. */
export type DeliveryOrigin =
	| Readonly<{
			kind: "turn-continuation";
			lineageIdHash: string;
			attemptEpoch: number;
			continuationId: string;
	  }>
	| Readonly<{
			kind: "owned-completion";
			lineageIdHash: string;
			attemptEpoch: number;
			registration: TurnRegistrationKey;
	  }>
	| Readonly<{ kind: "ordinary"; source: string }>;

/** Exact causal registration key bound before a job/subagent handle escapes. */
export interface TurnRegistrationKey {
	/** Endpoint (top-level session) identity that owns this job: the registry is
	 *  process-global and job ids/generations restart per AsyncJobManager, so
	 *  two concurrent sessions both mint bg_1/job:1 — without the endpoint in
	 *  the key the second registration would overwrite the first and an owned
	 *  abort of the first turn could find an empty causal set (review thread
	 *  P1). Absent (legacy/test fixtures) = a default scope. */
	endpointId?: string;
	endpointGeneration: number;
	lineageIdHash: string;
	promptAttemptEpoch: number;
	jobId: string;
	jobGeneration: string;
}

/** Per-completion delivery key: registration tuple plus entry identity. */
export type TurnDeliveryKey = TurnRegistrationKey & {
	entryId: string;
	progressSeq?: number;
};
/** Private origin envelope carried through the plain AgentMessage boundary. */
export interface OwnedCompletionEnvelope {
	lineageIdHash: string;
	promptAttemptEpoch: number;
	/** Exact registered five-tuple so the final gate can validate source authority. */
	registration: TurnRegistrationKey;
}

export type TurnContinuationFenceState = "open" | "closing" | "closed" | "retained" | "released";

export type OwnedCompletionPolicy = "enabled" | "disabled";

/**
 * Continuation fence lifecycle: `open -> closing -> closed` happens
 * synchronously before the first await that interrupts the root turn. Closing
 * records exact continuation tombstones and invalidates ONLY continuation
 * tokens; it never invalidates an owned-completion token, cancels a manager
 * job, or creates a turn delivery receipt. `retained` keeps tombstones for
 * restart/later-owned binding; `released` requires exact tokens gone, teardown
 * with no live continuation, or bounded durable retention. Host response
 * success/replay/retry never releases it.
 */
export interface TurnContinuationFence {
	state: TurnContinuationFenceState;
	lineageIdHash: string;
	abortedAttemptEpoch: number;
	terminalScopeId: string;
	blockedContinuationIds: ReadonlySet<string>;
	predecessorTombstones: ReadonlySet<string>;
	ownedCompletionPolicy: OwnedCompletionPolicy;
}

/**
 * The one gate consulted immediately before turn-origin continuation calls and
 * owned-completion admission.
 *
 * `authorizeContinuation` denies any post-close same-turn continuation and
 * allows only a call already linearized as a predecessor before close.
 * `authorizeOwnedCompletion` does NOT consult the closed continuation state as
 * a suppression flag; it validates exact source metadata and, when allowed,
 * AgentSession allocates a FRESH attempt/lineage for the new turn.
 */
export interface TurnContinuationGate {
	close(reason: "terminal-turn"): void;
	authorizeContinuation(origin: DeliveryOrigin): "deny" | "allow-predecessor";
	authorizeOwnedCompletion(origin: DeliveryOrigin): "allow-new-turn" | "deny";
}

export type OwnedDeliverySettlementPath =
	| "enqueue-acknowledged-return"
	| "acknowledgeDeliveries-queue-purge"
	| "delivery-loop-acknowledged-skip"
	| "deliverDelivery-acknowledged-return"
	| "terminal-wait-acknowledge-suppression-purge"
	| "filtered-drain-post-selection-suppression";

/** Owned-scope-only settlement observer (never installed for turn scope). */
export type OwnedDeliverySettlementObserver = (event: {
	key: TurnDeliveryKey;
	path: OwnedDeliverySettlementPath;
	action: "owned_settled" | "owned_absent";
}) => void;

/** Safe, bounded reasons surfaced on `terminal_uncertain` responses. */
export const TERMINAL_UNCERTAIN_REASONS = [
	"persistence_unavailable",
	"publication_failed",
	"delivery_failed",
	"owned_unsettled",
	"worker_unsettled",
	"unknown_origin",
	"registration_authority_unavailable",
] as const;
export type TerminalUncertainReason = (typeof TERMINAL_UNCERTAIN_REASONS)[number];

export interface TerminalScopeDispositions {
	selection: "turn" | "owned";
	turnDisposition: "pending" | "stopped" | "uncertain";
	ownedWorkDisposition: "not_requested" | "left_running" | "stopped" | "uncertain";
	automaticDeliveryDisposition: "enabled" | "none";
	resumeOnOwnedCompletion: boolean;
}
export interface ActiveTerminalScope {
	scopeId: string;
	lineageIdHash: string;
	abortedAttemptEpoch: number;
	gate: TurnContinuationGate;
	fence: TurnContinuationFence;
}

const MAX_ACTIVE_TERMINAL_SCOPES = 1024;
const MAX_OWNED_REGISTRATIONS = 8192;
const MAX_RETAINED_OWNERSHIP_TUPLES = 2048;
const MAX_RETAINED_ATTEMPT_POLICIES = 2048;
const activeScopes = new Map<string, ActiveTerminalScope>();
/**
 * Compact authorization evidence for registrations evicted by the 8,192 cap:
 * a TERMINAL job may still have an owned-completion envelope queued but not
 * yet consumed/acknowledged, and evicting its registration would remove the
 * authorizeOwnedCompletion authority (the queued result would be denied after
 * a scope:"turn" abort, losing the promised fresh completion). Evicted tuples
 * are retained here (bounded, FIFO) and removed once the delivery settles
 * (unregisterOwnedRegistration) — review thread P2.
 */
const retainedOwnershipTuples = new Map<string, TurnRegistrationKey>();
const activeScopeByAttempt = new Map<string, string>();
const ownedRegistrations = new Map<string, TurnRegistrationKey>();
/**
 * Compact attempt-policy tombstones for scopes evicted by the cap: when a
 * scope is evicted, its ownedCompletionPolicy is retained so a still-running
 * owned completion from that attempt keeps classifying correctly (fresh
 * resume for scope:"turn", drop for scope:"owned") instead of degrading to
 * ordinary (review thread P2). Bounded; oldest tombstone evicted first.
 */
const retainedAttemptPolicies = new Map<string, { ownedCompletionPolicy: "enabled" | "disabled" }>();
/** Attempts whose owned-registration set is KNOWN incomplete (registry
 *  saturation skipped a registration under the 8192 cap). Bounded by the
 *  number of saturation events — fail-closed authority for those attempts.
 */
const incompleteOwnedAttempts = new Set<string>();
/** Evicted call key → its attempt marker + retained lineage until that tool call settles. */
const incompleteToolCallWindows = new Map<string, { incompleteKey: string; binding: LineageBinding }>();
/** Number of evicted tool-call windows still capable of registering per attempt. */
const incompleteAttemptWindowCounts = new Map<string, number>();
/**
 * Saturation authority owner map (attempt key -> endpoint id): when the
 * process-global registry is full with no evictable tuple, the skipped
 * registration's attempt can never prove an exact causal set. The authority
 * is retained PER AFFECTED ATTEMPT (lineage+epoch, unique per session) and
 * retired when its endpoint's registrations are torn down — a transient
 * backlog must not permanently disable owned aborts for unrelated sessions
 * or endpoints (review thread P2).
 */
const saturatedAttemptEndpoints = new Map<string, string>();
/**
 * EvictKeys whose TERMINAL tuple could not move into the retained evidence
 * (its cap is full): the tuple stays in the LIVE map so authorizeOwnedCompletion
 * still finds it, and the eviction scan skips these keys so a later
 * registration does not re-evict the same protected tuple (review thread P2).
 */
const retentionBacklog = new Set<string>();

/** Register one active terminal scope (scopeId -> seam). Bounded; evicts oldest. */
export function registerTerminalScope(scope: ActiveTerminalScope): boolean {
	if (activeScopes.size >= MAX_ACTIVE_TERMINAL_SCOPES) {
		const oldest = activeScopes.keys().next().value;
		if (oldest !== undefined) {
			const evicted = activeScopes.get(oldest);
			if (evicted) {
				if (retainedAttemptPolicies.size >= MAX_RETAINED_ATTEMPT_POLICIES) {
					// Evict only a tombstone whose attempt has NO remaining
					// registrations (its owned completions have settled) — never
					// by age alone while a registration could still classify and
					// require the policy (review thread P2).
					let evictPolicyKey: string | undefined;
					for (const [candidateKey] of retainedAttemptPolicies) {
						const separator = candidateKey.lastIndexOf("\u0000");
						const lineage = candidateKey.slice(0, separator);
						const epoch = Number(candidateKey.slice(separator + 1));
						const hasRegistrations =
							[...ownedRegistrations.values()].some(
								reg => reg.lineageIdHash === lineage && reg.promptAttemptEpoch === epoch,
							) ||
							// A TERMINAL job awaiting delivery may have been
							// evicted into the retained evidence; its attempt is
							// NOT settled and its policy must survive (review P2).
							[...retainedOwnershipTuples.values()].some(
								reg => reg.lineageIdHash === lineage && reg.promptAttemptEpoch === epoch,
							);
						if (!hasRegistrations) {
							evictPolicyKey = candidateKey;
							break;
						}
					}
					if (evictPolicyKey === undefined) {
						// Every retained tombstone still has LIVE registrations:
						// evicting the OLDEST ACTIVE scope would drop ITS policy
						// while its work remains registered/classifiable, changing
						// its later completion from fresh/drop to ordinary. FAIL
						// the NEW scope admission instead — the oldest scope keeps
						// its policy (review thread P2).
						return false;
					}
					retainedAttemptPolicies.delete(evictPolicyKey);
				}
				retainedAttemptPolicies.set(`${evicted.lineageIdHash}\u0000${evicted.abortedAttemptEpoch}`, {
					ownedCompletionPolicy: evicted.fence.ownedCompletionPolicy,
				});
			}
			unregisterTerminalScope(oldest);
		}
	}
	activeScopes.set(scope.scopeId, scope);
	activeScopeByAttempt.set(`${scope.lineageIdHash}\u0000${scope.abortedAttemptEpoch}`, scope.scopeId);
	return true;
}

/** Look up the active terminal scope for an aborted attempt (exact lineage+epoch). */
export function lookupTerminalScope(lineageIdHash: string, attemptEpoch: number): ActiveTerminalScope | undefined {
	const scopeId = activeScopeByAttempt.get(`${lineageIdHash}\u0000${attemptEpoch}`);
	return scopeId === undefined ? undefined : activeScopes.get(scopeId);
}

export function unregisterTerminalScope(scopeId: string): void {
	const scope = activeScopes.get(scopeId);
	if (!scope) return;
	activeScopes.delete(scopeId);
	activeScopeByAttempt.delete(`${scope.lineageIdHash}\u0000${scope.abortedAttemptEpoch}`);
}

/** Record an exact owned registration before its handle escapes (bounded). */
export function registerOwnedRegistration(
	key: TurnRegistrationKey,
	options?: { isJobTerminal?: (candidate: TurnRegistrationKey) => boolean | undefined },
): void {
	// Key by (endpoint, jobId, jobGeneration): job ids and generations restart
	// per AsyncJobManager, so CONCURRENT sessions' bg_1/job:1 must coexist —
	// the endpoint identity prevents the second registration from overwriting
	// the first (review thread P1). A same-ENDPOINT (jobId, jobGeneration)
	// rebind (replaced manager within one session) still overwrites the stale
	// entry; a same-turn re-registration (exact tuple) is a no-op.
	const mapKey = `${key.endpointId ?? ""}\u0000${key.jobId}\u0000${key.jobGeneration}`;
	const existing = ownedRegistrations.get(mapKey);
	if (
		existing &&
		existing.lineageIdHash === key.lineageIdHash &&
		existing.promptAttemptEpoch === key.promptAttemptEpoch &&
		existing.endpointId === key.endpointId
	) {
		return;
	}
	if (ownedRegistrations.size >= MAX_OWNED_REGISTRATIONS) {
		// Prefer evicting a TERMINAL registration: its job already finished, so
		// a long-lived LIVE job must never be dropped by shorter finished jobs —
		// otherwise scope:"owned" would omit it from the exact causal set and
		// could report stopped_owned while it keeps running (review thread P2).
		let evictKey: string | undefined;
		if (options?.isJobTerminal) {
			for (const [candidateKey, candidate] of ownedRegistrations) {
				// Skip tuples already protected in the retention backlog (their
				// pending authorization must not be re-evicted, review thread P2).
				if (retentionBacklog.has(candidateKey)) continue;
				if (options.isJobTerminal(candidate) === true) {
					evictKey = candidateKey;
					break;
				}
			}
		}
		if (evictKey === undefined) {
			// ALL retained registrations are live: evicting any of them would lose
			// a still-running job's ownership authority. FAIL CLOSED instead —
			// do not evict, skip the new registration. Mark the SKIPPED
			// registration's attempt as having an incomplete causal set: the
			// unregistered job may still launch, so its exact set is unknowable.
			// The marker is scoped to this attempt — never a process-lifetime
			// daemon flag — and is retired when the attempt's endpoint is torn
			// down (review thread P2).
			markAttemptSaturated(key);
			return;
		}
		const evictedTuple = ownedRegistrations.get(evictKey);
		ownedRegistrations.delete(evictKey);
		if (evictedTuple) {
			if (retainedOwnershipTuples.size >= MAX_RETAINED_OWNERSHIP_TUPLES) {
				// Retained evidence at cap: NEVER drop a pending authorization by
				// age — keep the terminal tuple in the LIVE map (backlogged) so
				// authorizeOwnedCompletion still finds it while its completion
				// envelope is queued (review thread P2). The live map only
				// transiently exceeds its cap under pathological concurrent
				// pending deliveries; the backlog is cleared as deliveries settle.
				retentionBacklog.add(evictKey);
				ownedRegistrations.set(evictKey, evictedTuple);
				// The pending tuple cannot move to retained evidence, so the new
				// registration has NO eviction headroom: FAIL CLOSED instead of
				// inserting it and letting both the live map and the backlog grow
				// without bound while deliveries stay stalled. The skipped
				// registration's attempt is marked incomplete (scoped to the
				// attempt, retired at endpoint teardown) (review thread P2).
				markAttemptSaturated(key);
				return;
			}
			retainedOwnershipTuples.set(evictKey, evictedTuple);
		}
	}
	ownedRegistrations.set(mapKey, key);
}

/** Record an attempt whose owned-registration set is KNOWN incomplete — the
 *  fail-closed authority for an EVICTED in-flight lineage binding whose tool
 *  may still launch unregistered work. Every marker is paired with a
 *  registration window that settles it at afterToolCall, so the set is bounded
 *  by the open-window map. Registry-saturation skips record the affected
 *  attempt through markAttemptSaturated instead (review thread P2). */
function markAttemptRegistrationIncomplete(lineageIdHash: string, attemptEpoch: number): void {
	const incompleteKey = `${lineageIdHash}\u0000${attemptEpoch}`;
	// A marker can be cleared only once its affected call is known unable to
	// register. FIFO aging loses that authority while a delayed in-flight tool
	// may still launch, allowing scope:"owned" to claim stopped_owned over a
	// live unregistered job (review thread P2).
	incompleteOwnedAttempts.add(incompleteKey);
}

/** Record a REGISTRY-SATURATION skip for an attempt: the new registration was
 *  refused while the process-global registry had no evictable tuple, so the
 *  skipped job may still launch unregistered and the attempt's exact causal
 *  set can never be proven. Unlike window-backed markers there is no
 *  registration window to settle these; they are scoped to the affected
 *  attempt and retired when the owning endpoint's registrations are torn down
 *  (retireOwnedRegistrationsForEndpoint), so a transient backlog never
 *  permanently disables owned aborts daemon-wide (review thread P2). */
function markAttemptSaturated(key: TurnRegistrationKey): void {
	const incompleteKey = `${key.lineageIdHash}\u0000${key.promptAttemptEpoch}`;
	incompleteOwnedAttempts.add(incompleteKey);
	saturatedAttemptEndpoints.set(incompleteKey, key.endpointId ?? "");
}

/** Whether an attempt's owned registration set is KNOWN incomplete (an
 *  evicted in-flight lineage binding or a registry-saturation skip) — a
 *  scope:"owned" abort of that exact attempt must fail closed to uncertainty
 *  (review thread P2). */
export function isOwnedAttemptRegistrationIncomplete(lineageIdHash: string, attemptEpoch: number): boolean {
	// Per-attempt incomplete authority: window-backed markers from evicted
	// in-flight lineage bindings AND registry-saturation skips both land in
	// incompleteOwnedAttempts, so the check is scoped to the attempt — never a
	// process-lifetime daemon flag — and saturation markers retire at endpoint
	// teardown (review thread P2).
	return incompleteOwnedAttempts.has(`${lineageIdHash}\u0000${attemptEpoch}`);
}

/** Exact (jobId, jobGeneration) lookup for completion-origin classification. */
export function lookupOwnedRegistration(
	jobId: string,
	jobGeneration: string,
	endpointId?: string,
): TurnRegistrationKey | undefined {
	const prefix = `${endpointId ?? ""}\u0000${jobId}\u0000${jobGeneration}`;
	if (endpointId !== undefined) {
		const exact = ownedRegistrations.get(prefix);
		if (exact) return exact;
		// The live entry may have been evicted by the cap with its compact
		// authorization evidence retained (pending delivery — review P2).
		const retained = retainedOwnershipTuples.get(prefix);
		if (retained) return retained;
	}
	// An ENDPOINT-qualified lookup NEVER falls back to the cross-endpoint scan:
	// with concurrent sessions reusing bg_1/job:1, the scan could return
	// another session's registration — B's monitor would attach A's ownership
	// envelope, or B's Job/Bash settlement would unregister A's tuple while A's
	// job keeps running (review thread P1). The scan is reserved for callers
	// that OMIT an endpoint (legacy callers/tests).
	if (endpointId === undefined) {
		for (const reg of ownedRegistrations.values()) {
			if (reg.jobId === jobId && reg.jobGeneration === jobGeneration) return reg;
		}
		for (const reg of retainedOwnershipTuples.values()) {
			if (reg.jobId === jobId && reg.jobGeneration === jobGeneration) return reg;
		}
	}
	return undefined;
}

export function unregisterOwnedRegistration(key: TurnRegistrationKey): void {
	const mapKey = `${key.endpointId ?? ""}\u0000${key.jobId}\u0000${key.jobGeneration}`;
	// Only remove the EXACT five-tuple: the (jobId, jobGeneration) pair may
	// have been REBOUND to another lineage/epoch/endpoint (which
	// registerOwnedRegistration explicitly allows), and deleting by the pair
	// alone would drop the replacement job's authoritative registration — a
	// later scope:"owned" abort could then omit it and report stopped_owned
	// while it stays active (review thread P1).
	const matches = (r: TurnRegistrationKey) =>
		r.lineageIdHash === key.lineageIdHash &&
		r.promptAttemptEpoch === key.promptAttemptEpoch &&
		r.endpointGeneration === key.endpointGeneration &&
		r.jobId === key.jobId &&
		r.jobGeneration === key.jobGeneration;
	const existing = ownedRegistrations.get(mapKey);
	if (existing && matches(existing)) {
		ownedRegistrations.delete(mapKey);
	}
	// The registration may already have been EVICTED into the retained
	// evidence (a TERMINAL job whose envelope is still queued) while its
	// delivery now settles; settle the retained tuple too. Without this the
	// stale evidence would fill the FIFO and evict authorization for
	// genuinely queued completions (review thread P2).
	const retained = retainedOwnershipTuples.get(mapKey);
	if (retained && matches(retained)) {
		retainedOwnershipTuples.delete(mapKey);
	}
	retentionBacklog.delete(mapKey);
}
/**
 * Enumerate every exact owned registration belonging to one aborted turn
 * (matching lineage + attempt epoch). Used by `scope:"owned"` cleanup to
 * capture the exact causal job set; foreign/unclassified work is never
 * returned and is never swept.
 */
/** Retire EVERY owned registration owned by a disposing endpoint (live,
 * retained-evidence, and backlogged tuples): after the endpoint's manager is
 * unregistered the tuples can no longer reach a delivery settlement boundary,
 * and future managers deliberately cannot classify foreign-endpoint tuples as
 * terminal for eviction — repeatedly disposing distinct sessions with pending
 * jobs would accumulate tuples until the 8192-entry registry saturates and
 * all later owned aborts fail closed (review thread P2). */
export function retireOwnedRegistrationsForEndpoint(endpointId: string): void {
	for (const reg of [...ownedRegistrations.values(), ...retainedOwnershipTuples.values()]) {
		if (reg.endpointId === endpointId) unregisterOwnedRegistration(reg);
	}
	// Retire the endpoint's saturation authority too: the skipped
	// (unregistered) job's work is torn down with the endpoint, so the affected
	// attempts no longer need to fail closed (review thread P2).
	for (const [attemptKey, owner] of [...saturatedAttemptEndpoints]) {
		if (owner === endpointId) {
			saturatedAttemptEndpoints.delete(attemptKey);
			incompleteOwnedAttempts.delete(attemptKey);
		}
	}
}

export function findOwnedRegistrationsForTurn(lineageIdHash: string, attemptEpoch: number): TurnRegistrationKey[] {
	const matches: TurnRegistrationKey[] = [];
	for (const key of ownedRegistrations.values()) {
		if (key.lineageIdHash === lineageIdHash && key.promptAttemptEpoch === attemptEpoch) {
			matches.push(key);
		}
	}
	// A live registration evicted into the retained evidence (a terminal job
	// whose execution promise is still unwinding) is still exact causal work of
	// this attempt: include it so a scope:"owned" abort generation-verifies,
	// cancels, and waits for its quiescence before claiming stopped_owned
	// (review thread P2). unregisterOwnedRegistration settles retained tuples
	// too, so the settlement path retires them.
	for (const key of retainedOwnershipTuples.values()) {
		if (key.lineageIdHash === lineageIdHash && key.promptAttemptEpoch === attemptEpoch) {
			matches.push(key);
		}
	}
	return matches;
}
export interface OwnedCompletionClassification {
	lineageIdHash: string;
	promptAttemptEpoch: number;
	registration: TurnRegistrationKey;
	terminalScopeId: string;
}

/**
 * Classify a manager completion/progress delivery against the terminal-abort
 * registries. Returns an exact owned-completion classification ONLY when the
 * job carries an exact registered five-tuple AND a terminal scope exists for
 * that turn. Missing or mismatched metadata fails closed (undefined) and the
 * delivery is then ordinary. Classification is source/lineage-based, never
 * timing-based; a closed terminal record does NOT suppress an exact
 * left-running owned completion (corrected turn semantics).
 */
export function classifyOwnedCompletion(
	jobId: string,
	jobGeneration: string | undefined,
): OwnedCompletionClassification | undefined {
	if (!jobGeneration) return undefined;
	const registration = lookupOwnedRegistration(jobId, jobGeneration);
	if (!registration) return undefined;
	const scope = lookupTerminalScope(registration.lineageIdHash, registration.promptAttemptEpoch);
	if (!scope) return undefined;
	return {
		lineageIdHash: registration.lineageIdHash,
		promptAttemptEpoch: registration.promptAttemptEpoch,
		registration,
		terminalScopeId: scope.scopeId,
	};
}
/**
 * Whether an owned-completion envelope is authorized by its owning terminal
 * scope as a fresh-turn resume. Used at batch build (sdk/session.ts) and the
 * final injection boundary (agent-session.ts): a denied envelope — owned scope
 * (policy disabled), forged/unregistered tuple, or vanished scope — must be
 * dropped/partitioned out so stopped work can never call followUp/prompt.
 */
/**
 * Classify an owned-completion envelope into three states. A registration
 * without a terminal scope (no abort yet) is ORDINARY — normal delivery;
 * only a scope with the owned policy disabled DROPS, and a turn-scope
 * enabled policy is FRESH (new-turn resume). This lets the batch keep
 * ownership on the entry and reclassify at flush/abort time (review
 * thread P1: a completion finished before the abort must not become an
 * unpurgeable ordinary entry that can still resume the agent).
 */
/**
 * Structural validation for envelopes carried through the public AgentMessage
 * `details` boundary: `ExtensionAPI.sendMessage` allows arbitrary details, so
 * a malformed `ownedCompletions` entry (object, null item, missing tuple
 * fields) must never crash the delivery path — invalid entries are skipped,
 * never classified (review thread P2).
 */
export function isOwnedCompletionEnvelope(value: unknown): value is OwnedCompletionEnvelope {
	if (typeof value !== "object" || value === null) return false;
	const envelope = value as Record<string, unknown>;
	if (typeof envelope.lineageIdHash !== "string") return false;
	if (typeof envelope.promptAttemptEpoch !== "number") return false;
	const registration = envelope.registration;
	if (typeof registration !== "object" || registration === null) return false;
	const key = registration as Record<string, unknown>;
	return (
		typeof key.jobId === "string" &&
		typeof key.jobGeneration === "string" &&
		typeof key.endpointGeneration === "number" &&
		typeof key.lineageIdHash === "string" &&
		typeof key.promptAttemptEpoch === "number" &&
		(key.endpointId === undefined || typeof key.endpointId === "string")
	);
}

export function classifyOwnedEnvelope(envelope: OwnedCompletionEnvelope): "ordinary" | "fresh" | "drop" {
	const scope = lookupTerminalScope(envelope.lineageIdHash, envelope.promptAttemptEpoch);
	if (scope) {
		return scope.gate.authorizeOwnedCompletion({
			kind: "owned-completion",
			lineageIdHash: envelope.lineageIdHash,
			attemptEpoch: envelope.promptAttemptEpoch,
			registration: envelope.registration,
		}) === "allow-new-turn"
			? "fresh"
			: "drop";
	}
	// The scope was evicted by the cap but its attempt-policy tombstone
	// survives: classify by the retained policy while the registration is
	// still exact (review thread P2).
	const retained = retainedAttemptPolicies.get(`${envelope.lineageIdHash}\u0000${envelope.promptAttemptEpoch}`);
	if (!retained) return "ordinary";
	if (retained.ownedCompletionPolicy === "disabled") return "drop";
	const registered = lookupOwnedRegistration(
		envelope.registration.jobId,
		envelope.registration.jobGeneration,
		envelope.registration.endpointId,
	);
	// Compare EVERY tuple component against the authoritative registration: a
	// (jobId, jobGeneration) may have been REBOUND to another lineage/epoch
	// since the envelope was built, and classifying the stale envelope as fresh
	// would resume work under the wrong ownership (review thread P2).
	if (!registered) return "ordinary";
	if (registered.endpointGeneration !== envelope.registration.endpointGeneration) return "ordinary";
	if (registered.lineageIdHash !== envelope.lineageIdHash) return "ordinary";
	if (registered.promptAttemptEpoch !== envelope.promptAttemptEpoch) return "ordinary";
	if (registered.jobId !== envelope.registration.jobId) return "ordinary";
	if (registered.jobGeneration !== envelope.registration.jobGeneration) return "ordinary";
	return "fresh";
}

/** Whether an envelope must be kept in the batch (not an owned-scope drop). */
export function isOwnedCompletionEnvelopeAllowed(envelope: OwnedCompletionEnvelope): boolean {
	return classifyOwnedEnvelope(envelope) !== "drop";
}
/** Structural subset of AsyncJobManager used by owned-stop settlement (avoids an import cycle). */
export interface OwnedStopManager {
	cancel(jobId: string): boolean;
	getJob(jobId: string): { generation?: string; status?: string } | undefined;
	getJobPromise?(jobId: string, generation: string): Promise<void> | undefined;
	acknowledgeDeliveries(jobIds: string[]): number;
}

/**
 * Settle exact owned work for `scope:"owned"`: generation-verified cancel, a
 * fixed grace, a second quiescence proof, then a delivery purge. Returns
 * "stopped" only when every captured job is terminal after the grace; a reused
 * job id with a new generation, a missing/evicted record, or still-running/
 * paused work fails closed to "unsettled" (AC 16/36 — foreign work is never
 * swept and unprovable quiescence never claims stopped).
 */
export async function settleOwnedWork(
	manager: OwnedStopManager,
	exactJobs: TurnRegistrationKey[],
	graceMs: number,
): Promise<"stopped" | "unsettled"> {
	let generationExact = true;
	for (const reg of exactJobs) {
		const live = manager.getJob(reg.jobId);
		if (live !== undefined && live.generation !== reg.jobGeneration) {
			generationExact = false;
			continue;
		}
		manager.cancel(reg.jobId);
	}
	if (!generationExact) return "unsettled";
	const deadline = Date.now() + graceMs;
	await Bun.sleep(graceMs);
	// Second proof: every captured job must still be the EXACT captured
	// generation and terminal (cancelled/completed/failed). A reused job id
	// with a NEW generation during the grace, a missing/evicted record, or a
	// still-running/paused job fails closed — foreign work is never swept and
	// unprovable quiescence never claims stopped. Additionally, the ACTUAL job
	// promise must settle within the grace: AsyncJobManager.cancel() updates
	// status to "cancelled" eagerly while the job function may still be
	// unwinding, so the status alone is not proof of quiescence (review P1).
	const quiescent = await Promise.all(
		exactJobs.map(async reg => {
			const job = manager.getJob(reg.jobId);
			if (!job || job.generation !== reg.jobGeneration) return false;
			if (job.status === "running" || job.status === "paused") return false;
			const promise = manager.getJobPromise?.(reg.jobId, reg.jobGeneration);
			if (!promise) return true; // no promise exposed — fall back to status
			let settled = false;
			try {
				await Promise.race([
					promise.then(
						() => {
							settled = true;
						},
						() => {
							settled = true;
						},
					),
					Bun.sleep(Math.max(0, deadline - Date.now())),
				]);
			} catch {
				// ignore: a rejected promise still counts as unwound
			}
			return settled;
		}),
	);
	if (!quiescent.every(Boolean)) return "unsettled";
	manager.acknowledgeDeliveries(exactJobs.map(reg => reg.jobId));
	// The jobs are terminal and their deliveries are suppressed: the owned
	// registrations are settled, so remove them — otherwise they occupy the
	// attempt indefinitely and the retained-policy tombstone eviction cannot
	// distinguish live work from finished work (review thread P2).
	for (const reg of exactJobs) unregisterOwnedRegistration(reg);
	return "stopped";
}
export interface LineageBinding {
	lineageIdHash: string;
	promptAttemptEpoch: number;
	endpointGeneration: number;
	/** Endpoint (top-level session) identity that minted this binding. */
	endpointId?: string;
}

const MAX_LINEAGE_BINDINGS = 8192;
// Keyed by (endpointId, toolCallId): concurrent sessions receive the SAME
// provider-local toolCallId, and a toolCallId-only key lets the later
// session's beforeToolCall overwrite the first session's binding — the first
// session's background Bash/task job would then be attributed to the second
// session's endpoint and lineage (review thread P1).
const lineageByToolCall = new Map<string, LineageBinding>();
// Tool calls whose afterToolCall settlement already ran. A later eviction of
// such a binding must NOT open a registration window: the call and its
// background registrations settled long ago, and the only removal path
// (settleToolLineageRegistrationWindow) will never run again, so the window
// and its incomplete-attempt marker would leak forever (review thread P2).
// Bounded by lineageByToolCall: entries are cleared on rebind and eviction.
const settledToolCallLineages = new Set<string>();
const toolCallLineageKey = (endpointId: string | undefined, toolCallId: string) =>
	`${endpointId ?? ""}\u0000${toolCallId}`;

/**
 * Bind immutable lineage/attempt metadata to an attempt-scoped tool call
 * identity (toolCallId). The binding is set once at prompt admission and must
 * never be mutated from a session-current fallback; missing/mismatched
 * context fails closed (resolve returns undefined).
 */
export function bindToolLineage(toolCallId: string, binding: LineageBinding): void {
	if (lineageByToolCall.size >= MAX_LINEAGE_BINDINGS) {
		const oldest = lineageByToolCall.keys().next().value;
		if (oldest !== undefined) {
			const evicted = lineageByToolCall.get(oldest);
			lineageByToolCall.delete(oldest);
			if (evicted) {
				if (settledToolCallLineages.has(oldest)) {
					// The evicted call already settled (afterToolCall ran): its
					// owned registrations were captured during execution, so there
					// is no in-flight window to protect. Retire the binding without
					// creating a window or an incomplete marker — both would leak
					// forever because the settlement callback never runs again
					// (review thread P2).
					settledToolCallLineages.delete(oldest);
				} else {
					// An evicted binding may belong to an IN-FLIGHT tool call whose
					// background tool has not yet reached registerOwnedIfLineaged:
					// its job would then launch with no owned registration and no
					// evidence. Mark the evicted attempt's registration authority
					// incomplete so a later scope:"owned" abort of THAT attempt fails
					// closed to uncertainty instead of reporting stopped_owned
					// over an incomplete causal set.
					const incompleteKey = `${evicted.lineageIdHash}\u0000${evicted.promptAttemptEpoch}`;
					markAttemptRegistrationIncomplete(evicted.lineageIdHash, evicted.promptAttemptEpoch);
					// Retain the full lineage binding in the window: if this in-flight tool
					// call still launches a background job, registerOwnedIfLineaged can
					// register it under the retained lineage instead of leaving the
					// attempt's causal set empty (review thread P2).
					incompleteToolCallWindows.set(oldest, { incompleteKey, binding: evicted });
					incompleteAttemptWindowCounts.set(
						incompleteKey,
						(incompleteAttemptWindowCounts.get(incompleteKey) ?? 0) + 1,
					);
					// The per-attempt marker above is deliberately scoped to the
					// evicted attempt (never process-lifetime): every tool call binds
					// a lineage entry and production never unbinds it (bindings
					// intentionally survive the tool call so resumed registrations
					// re-use the original id and task batches register one job per
					// item), so a healthy long-running daemon inevitably reaches the
					// 8,192 cap and the first eviction is ordinary historical churn —
					// the evicted call and its job have settled long ago. A
					// process-lifetime flag on ANY eviction would make every
					// subsequent scope:"owned" abort fail with uncertainty forever,
					// even when all evicted calls settled (review thread P2).
				}
			}
		}
	}
	// A rebind supersedes any prior execution of the same id: the new execution
	// is in flight until its own afterToolCall settles.
	settledToolCallLineages.delete(toolCallLineageKey(binding.endpointId, toolCallId));
	lineageByToolCall.set(toolCallLineageKey(binding.endpointId, toolCallId), binding);
}

export function resolveToolLineage(toolCallId: string | undefined, endpointId?: string): LineageBinding | undefined {
	if (toolCallId === undefined) return undefined;
	if (endpointId !== undefined) return lineageByToolCall.get(toolCallLineageKey(endpointId, toolCallId));
	// Legacy endpoint-less callers: match by toolCallId. Prefer a binding whose
	// endpoint equals the caller's, else the first match (review thread P1 —
	// endpoint-aware callers must pass their endpoint to disambiguate
	// concurrent sessions).
	for (const [key, binding] of lineageByToolCall) {
		if (key.endsWith(`\u0000${toolCallId}`)) return binding;
	}
	return undefined;
}

/** Close an evicted tool's registration window after its execution settles. */
export function settleToolLineageRegistrationWindow(toolCallId: string, endpointId?: string): void {
	const key = toolCallLineageKey(endpointId, toolCallId);
	// Mark the execution settled ONLY while its binding remains in the lineage
	// map: a later FIFO eviction of that binding consults this set and removes
	// the key. An already-evicted binding lives only in the window closed
	// below — retaining the marker there would leak the key forever because
	// no eviction can ever execute the delete (review thread P2).
	if (lineageByToolCall.has(key)) settledToolCallLineages.add(key);
	const window = incompleteToolCallWindows.get(key);
	if (window !== undefined) {
		incompleteToolCallWindows.delete(key);
		const remaining = (incompleteAttemptWindowCounts.get(window.incompleteKey) ?? 1) - 1;
		if (remaining <= 0) {
			incompleteAttemptWindowCounts.delete(window.incompleteKey);
			// The same attempt may ALSO carry saturation evidence (an owned job
			// whose registration was rejected because the owned registry was
			// full): keep the incomplete marker while either source remains, or
			// a later scope:"owned" abort could omit that still-live job and
			// claim stopped_owned (review thread P2).
			if (!saturatedAttemptEndpoints.has(window.incompleteKey)) {
				incompleteOwnedAttempts.delete(window.incompleteKey);
			}
		} else {
			incompleteAttemptWindowCounts.set(window.incompleteKey, remaining);
		}
	}
}

export function unbindToolLineage(toolCallId: string, endpointId?: string): void {
	if (endpointId !== undefined) {
		lineageByToolCall.delete(toolCallLineageKey(endpointId, toolCallId));
		return;
	}
	for (const key of lineageByToolCall.keys()) {
		if (key.endsWith(`\u0000${toolCallId}`)) lineageByToolCall.delete(key);
	}
}

/**
 * Mint an unforgeable opaque lineage id for one prompt turn. The hash binds
 * session id, attempt epoch, and a per-session secret; it never contains
 * prompt body and cannot be re-derived from public session data. It is
 * created before model/tool execution and must never be mutated from a
 * session-current fallback.
 */
export function mintTurnLineageIdHash(sessionId: string, promptAttemptEpoch: number, sessionSecret: string): string {
	return createHash("sha256")
		.update(`turn-lineage-v1:${sessionId}\u0000${promptAttemptEpoch}\u0000${sessionSecret}`)
		.digest("hex");
}
/**
 * Register an exact owned registration when the tool call carries immutable
 * lineage metadata. The generation is read synchronously from the manager's
 * job record; a missing generation fails closed (no ownership claim). A
 * registry failure never breaks ordinary registration.
 */
export function registerOwnedIfLineaged(
	manager: { getJob?(id: string): { generation?: string; status?: string } | undefined },
	toolCallId: string | undefined,
	jobId: string,
	endpointId?: string,
): void {
	try {
		let lineage = resolveToolLineage(toolCallId, endpointId);
		if (!lineage && toolCallId !== undefined) {
			// The lineage binding may have been EVICTED by the cap while this tool
			// call was still in flight. The eviction retained the binding's lineage
			// in the registration window: register the launched job under that
			// retained lineage so the attempt's causal set is complete instead of
			// empty. Settling the window here would remove the attempt's only
			// fail-closed marker while the unregistered job keeps running and a
			// later scope:"owned" abort could claim stopped_owned over nothing
			// (review thread P2). The window (and attempt marker) settles at
			// afterToolCall once the tool call's execution ends.
			lineage = incompleteToolCallWindows.get(toolCallLineageKey(endpointId, toolCallId))?.binding;
		}
		if (!lineage) return;
		const job = manager.getJob?.(jobId);
		const jobGeneration = job?.generation;
		if (!jobGeneration) return;
		registerOwnedRegistration(
			{
				...(lineage.endpointId ? { endpointId: lineage.endpointId } : {}),
				endpointGeneration: lineage.endpointGeneration,
				lineageIdHash: lineage.lineageIdHash,
				promptAttemptEpoch: lineage.promptAttemptEpoch,
				jobId,
				jobGeneration,
			},
			{
				// Only FINISHED jobs are evictable under the cap, so a long-lived
				// live job's ownership tuple is never dropped by shorter completed
				// jobs (review thread P2). The check is scoped to the CANDIDATE's
				// OWN endpoint: a candidate from another session (same reusable
				// job id bg_1) must not be judged terminal using THIS manager's
				// unrelated bg_1 record (review thread P2).
				isJobTerminal: candidate => {
					if ((candidate.endpointId ?? "") !== (lineage.endpointId ?? "")) return undefined;
					const status = manager.getJob?.(candidate.jobId)?.status;
					return status === "completed" || status === "cancelled" || status === "failed" || status === "evicted";
				},
			},
		);
	} catch {
		// ignore: never break ordinary registration
	}
}

/** Retire the exact (endpoint, jobId, jobGeneration) owned registration when
 *  its completion delivery is dead-lettered by the manager (delivery-queue
 *  overflow or retry exhaustion): no message is injected and no later
 *  consumption boundary will settle it, so the terminal tuple would otherwise
 *  occupy the global registries until saturation (review thread P2). The
 *  delivery is enqueued only when the job is terminal, so no live job's
 *  authority is dropped. */
export function retireOwnedRegistrationForDeadLetter(
	endpointId: string | undefined,
	jobId: string,
	jobGeneration: string,
): void {
	const tuple = lookupOwnedRegistration(jobId, jobGeneration, endpointId);
	if (tuple) unregisterOwnedRegistration(tuple);
}

let attemptEpochCounter = 0;

/** Monotonic fresh-attempt epoch for `resumeFromOwnedCompletion` allocation. */
export function nextPromptAttemptEpoch(): number {
	return ++attemptEpochCounter;
}

/** Mint a fresh terminal scope id (opaque, never persisted raw). */
export function newTerminalScopeId(): string {
	return randomUUID();
}

export interface TurnContinuationSeam {
	fence: TurnContinuationFence;
	gate: TurnContinuationGate;
}

/**
 * Create a continuation fence + gate for one terminal scope. The fence starts
 * `open` and is closed synchronously via `gate.close()` before the root turn is
 * interrupted. Continuation authorization is source-based (lineageIdHash +
 * attemptEpoch + continuationId); timing alone never authorizes.
 */
export function createTurnContinuationSeam(options: {
	lineageIdHash: string;
	abortedAttemptEpoch: number;
	terminalScopeId: string;
	ownedCompletionPolicy?: OwnedCompletionPolicy;
	blockedContinuationIds?: readonly string[];
}): TurnContinuationSeam {
	const blocked = new Set<string>(options.blockedContinuationIds ?? []);
	const predecessors = new Set<string>();
	let state: TurnContinuationFenceState = "open";

	const fence: TurnContinuationFence = {
		state: "open",
		lineageIdHash: options.lineageIdHash,
		abortedAttemptEpoch: options.abortedAttemptEpoch,
		terminalScopeId: options.terminalScopeId,
		blockedContinuationIds: blocked,
		predecessorTombstones: predecessors,
		ownedCompletionPolicy: options.ownedCompletionPolicy ?? "enabled",
	};

	const gate: TurnContinuationGate = {
		close(_reason: "terminal-turn") {
			if (state === "closing" || state === "closed") return;
			state = "closing";
			state = "closed";
			fence.state = state;
		},
		authorizeContinuation(origin) {
			if (origin.kind !== "turn-continuation") return "deny";
			if (origin.lineageIdHash !== fence.lineageIdHash || origin.attemptEpoch !== fence.abortedAttemptEpoch)
				return "deny";
			// A call linearized BEFORE close is a predecessor: record it once and
			// allow it to finish its already-started work; it must never start a
			// successor. After close, only recorded predecessors pass; every other
			// same-turn continuation (retry/TTSR/steering/hidden/maintenance) is
			// denied.
			if (state === "open" || state === "closing") {
				predecessors.add(origin.continuationId);
				return "allow-predecessor";
			}
			return predecessors.has(origin.continuationId) ? "allow-predecessor" : "deny";
		},
		authorizeOwnedCompletion(origin) {
			// Owned completion is intentionally NOT suppressed by a closed turn
			// record. Validate exact source metadata and fail closed otherwise.
			if (origin.kind !== "owned-completion") return "deny";
			if (!origin.registration || typeof origin.registration !== "object") return "deny";
			if (origin.lineageIdHash !== fence.lineageIdHash) return "deny";
			if (origin.attemptEpoch !== fence.abortedAttemptEpoch) return "deny";
			const { endpointGeneration, promptAttemptEpoch, jobId, jobGeneration } = origin.registration;
			if (promptAttemptEpoch !== fence.abortedAttemptEpoch) return "deny";
			if (fence.ownedCompletionPolicy === "disabled") return "deny";
			if (
				!Number.isFinite(endpointGeneration) ||
				typeof jobId !== "string" ||
				!jobId ||
				typeof jobGeneration !== "string" ||
				!jobGeneration
			)
				return "deny";
			// The tuple must be an EXACT registered five-tuple: an unregistered,
			// forged, or mutated registration fails closed even when the outer
			// lineage/epoch match the aborted turn (AC 25 — missing/copied/
			// mismatched origin never authorizes an automatic call). The lookup
			// is ENDPOINT-scoped so concurrent sessions' same reusable job id
			// never resolves to a foreign session's registration, which would
			// deny a valid completion (review thread P1).
			const registered = lookupOwnedRegistration(jobId, jobGeneration, origin.registration.endpointId);
			if (!registered) return "deny";
			if (
				registered.lineageIdHash !== origin.lineageIdHash ||
				registered.promptAttemptEpoch !== promptAttemptEpoch ||
				registered.endpointGeneration !== endpointGeneration ||
				(registered.endpointId ?? "") !== (origin.registration.endpointId ?? "")
			)
				return "deny";
			return "allow-new-turn";
		},
	};

	return { fence, gate };
}
export interface RegisteredTerminalScope {
	scopeId: string;
	lineageIdHash: string;
	promptAttemptEpoch: number;
	seam: TurnContinuationSeam;
}

/**
 * Create, register, and synchronously close a terminal scope for one aborted
 * turn. The fence closes before the first await that interrupts the root turn;
 * owned-completion policy is enabled for `scope:"turn"` (left-running owned
 * delivery intentionally resumes the agent as a fresh turn) and disabled for
 * `scope:"owned"`. Registered scopes are process-local and bounded; the exact
 * (lineageIdHash, attemptEpoch) key makes later owned-completion classification
 * source-exact and fail-closed.
 */
export function registerTerminalTurnScope(options: {
	lineageIdHash: string;
	promptAttemptEpoch: number;
	terminalScopeId?: string;
	ownedCompletionPolicy?: OwnedCompletionPolicy;
	blockedContinuationIds?: readonly string[];
}): RegisteredTerminalScope | undefined {
	// Concurrent aborts of the SAME turn (dispatch-cache eviction can admit two
	// same-turn requests before either settles) must not overwrite the attempt
	// index with a second scope of a different owned-completion policy — a
	// losing scope:"owned" request would otherwise make a successful
	// scope:"turn" request's completions drop instead of resuming the fresh
	// turn (review thread P2). Reuse the first scope's authority.
	const existing = lookupTerminalScope(options.lineageIdHash, options.promptAttemptEpoch);
	if (existing) {
		// A concurrent abort with a DIFFERENT owned-completion policy must not
		// reuse this scope's gate: the losing request would report semantics
		// (automaticDelivery/ownedWork) that belong to the winner's policy — an
		// owned request winning would let the concurrent turn request claim
		// left_running/enabled, and vice versa. Fail the mismatched admission
		// closed so nothing is attributed to the losing request (review thread
		// P1); the winner's scope and policy stay untouched.
		if (existing.fence.ownedCompletionPolicy !== options.ownedCompletionPolicy) return undefined;
		return {
			scopeId: existing.scopeId,
			lineageIdHash: existing.lineageIdHash,
			promptAttemptEpoch: existing.abortedAttemptEpoch,
			seam: { fence: existing.fence, gate: existing.gate },
		};
	}
	const terminalScopeId = options.terminalScopeId ?? newTerminalScopeId();
	const seam = createTurnContinuationSeam({
		lineageIdHash: options.lineageIdHash,
		abortedAttemptEpoch: options.promptAttemptEpoch,
		terminalScopeId,
		ownedCompletionPolicy: options.ownedCompletionPolicy,
		blockedContinuationIds: options.blockedContinuationIds,
	});
	seam.gate.close("terminal-turn");
	const admitted = registerTerminalScope({
		scopeId: terminalScopeId,
		lineageIdHash: options.lineageIdHash,
		abortedAttemptEpoch: options.promptAttemptEpoch,
		gate: seam.gate,
		fence: seam.fence,
	});
	if (!admitted) return undefined;
	return {
		scopeId: terminalScopeId,
		lineageIdHash: options.lineageIdHash,
		promptAttemptEpoch: options.promptAttemptEpoch,
		seam,
	};
}

/**
 * TEST-ONLY: clear the module-global terminal-abort registries so tests get
 * isolated lineage/binding/scope state. Never call from production code —
 * the registries are intentionally process-lifetime in the runtime.
 */
export function resetTerminalAbortRegistriesForTests(): void {
	activeScopes.clear();
	activeScopeByAttempt.clear();
	ownedRegistrations.clear();
	lineageByToolCall.clear();
	settledToolCallLineages.clear();
	retainedOwnershipTuples.clear();
	retainedAttemptPolicies.clear();
	incompleteOwnedAttempts.clear();
	incompleteToolCallWindows.clear();
	incompleteAttemptWindowCounts.clear();
	retentionBacklog.clear();
	saturatedAttemptEndpoints.clear();
}

/**
 * Structural subset of a durable terminal-scope row needed for bounding
 * retention (review thread P2). Only rows with a COMPLETED disposition are
 * evictable; pending markers are never touched.
 */
export interface DurableScopeRetentionRow {
	idempotencyKeyHash?: string;
	idempotencyInputHash?: string;
	turnDisposition: "pending" | "no_effect" | (string & {});
	acceptedAt?: number;
	ownedWorkDisposition?: "not_requested" | "left_running" | "stopped" | "uncertain";
	responseState?: "pending" | "sent" | "delivered" | "failed";
	responsePayloadHash?: string;
	replayPayloadHash?: string;
	terminalPublished?: boolean;
}

/**
 * Evict the OLDEST COMPLETED terminal-scope rows beyond `cap`, mirroring the
 * bounded in-memory idempotency cache so a long-lived session cannot grow
 * the durable reconciliation document indefinitely. Completed dispositions
 * (stopped/uncertain/no_effect) are evicted oldest-first; pending markers and
 * TRANSITIONAL no_effect_reserved reservations (an in-flight abort that may
 * still transition to active) are never evicted — evicting a reserved row
 * would leave a tombstone that replays uncertainty over an unfinalized
 * reservation (review thread P2). Returns a new array.
 */
export function boundCompletedTerminalScopeRows<T extends DurableScopeRetentionRow>(rows: T[], cap: number): T[] {
	const isCompleted = (row: T): boolean =>
		row.turnDisposition !== "pending" && row.turnDisposition !== "no_effect_reserved";
	const retentionKey = (row: T): string => `${row.idempotencyKeyHash ?? ""}\u0000${row.idempotencyInputHash ?? ""}`;
	const completed = rows.filter(isCompleted);
	if (completed.length <= cap) return rows;
	const overflow = completed.length - cap;
	const evict = new Set(
		[...completed]
			.sort((a, b) => (a.acceptedAt ?? 0) - (b.acceptedAt ?? 0))
			.slice(0, overflow)
			.map(retentionKey),
	);
	// The evict set is keyed by key+input hash, so it must only be applied to
	// COMPLETED rows: a transitional no_effect_reserved reservation that happens
	// to share an evicted row's key pair must survive, exactly like a pending
	// marker (review thread P2).
	return rows.filter(row => !(isCompleted(row) && evict.has(retentionKey(row))));
}

/**
 * Compact key tombstones for completed rows evicted by the retention cap: the
 * key+input hashes are retained durably so a same-key retry after dispatch
 * cache expiry/restart still replays instead of aborting an unrelated later
 * prompt (review thread P2).
 */
/** Compact key tombstone with enough disposition metadata to reconstruct the
 *  original replay result (the retention cap can evict stopped/uncertain rows,
 *  not only no-effect reservations — review thread P2). */
export interface EvictedTerminalKey {
	keyHash: string;
	inputHash: string;
	turnDisposition: "stopped" | "uncertain" | "no_effect" | "no_effect_marker_failure";
	ownedWorkDisposition: "not_requested" | "left_running" | "stopped" | "uncertain";
	responseState?: "pending" | "sent" | "delivered" | "failed";
	responsePayloadHash?: string;
	replayPayloadHash?: string;
	terminalPublished?: boolean;
}

/** Bound the retained evicted-key tombstone collection FIFO: when a
 *  long-lived session's unique terminal-abort keys evict completed rows until
 *  the tombstone cap is reached, the OLDEST tombstones expire instead of the
 *  next finalization throwing after the destructive stop already happened —
 *  the client would otherwise receive an error while its durable row stays
 *  pending, and subsequent aborts repeat the failure and accumulate
 *  non-evictable pending rows (review thread P2). A dropped tombstone only
 *  loses replay authority for keys older than the bound; the idempotency
 *  guarantee degrades to the in-memory cache horizon instead of disabling
 *  future aborts. */
export function boundEvictedTerminalKeys<T extends { keyHash: string }>(keys: T[], cap: number): T[] {
	if (keys.length <= cap) return keys;
	return keys.slice(keys.length - cap);
}

export function collectEvictedTerminalKeys<T extends DurableScopeRetentionRow>(
	before: T[],
	after: T[],
): EvictedTerminalKey[] {
	const afterKeys = new Set(after.map(s => `${s.idempotencyKeyHash ?? ""}\u0000${s.idempotencyInputHash ?? ""}`));
	const evicted: EvictedTerminalKey[] = [];
	for (const row of before) {
		// A TRANSITIONAL reservation is never evictable, so it must never mint a
		// tombstone either: the same completed-row definition as
		// `boundCompletedTerminalScopeRows` (review thread P2).
		if (row.turnDisposition === "pending" || row.turnDisposition === "no_effect_reserved") continue;
		const key = `${row.idempotencyKeyHash ?? ""}\u0000${row.idempotencyInputHash ?? ""}`;
		if (!afterKeys.has(key) && row.idempotencyKeyHash && row.idempotencyInputHash) {
			evicted.push({
				keyHash: row.idempotencyKeyHash,
				inputHash: row.idempotencyInputHash,
				turnDisposition: row.turnDisposition as "stopped" | "uncertain" | "no_effect" | "no_effect_marker_failure",
				ownedWorkDisposition: row.ownedWorkDisposition ?? "not_requested",
				responseState: row.responseState,
				responsePayloadHash: row.responsePayloadHash,
				// A pending finalized row's written replay must still advance the
				// evicted tombstone; preserve its replay-shaped hash (review
				// thread P2).
				replayPayloadHash: row.replayPayloadHash,
				terminalPublished: row.terminalPublished,
			});
		}
	}
	return evicted;
}

/** Durable terminal-scope reservation cap. Idle/already-terminal aborts write
 *  durable no-effect reservations, so a client sending idle aborts with unique
 *  keys must not grow the reconciliation document indefinitely: only the OLDEST
 *  COMPLETED rows beyond this cap are evicted (review thread P2). */
export const MAX_DURABLE_TERMINAL_RESERVATIONS = 256;
/** Retained evicted-key tombstone cap; see {@link boundEvictedTerminalKeys}. */
export const MAX_RETAINED_TERMINAL_KEY_TOMBSTONES = 4096;

/**
 * Apply the durable terminal-scope retention bound to a pending
 * `transactTerminalState` mutation: evict the oldest COMPLETED scope rows past
 * {@link MAX_DURABLE_TERMINAL_RESERVATIONS}, retain a compact key tombstone for
 * every evicted row ATOMICALLY with the scope write, and FIFO-expire tombstones
 * past {@link MAX_RETAINED_TERMINAL_KEY_TOMBSTONES} instead of throwing after a
 * destructive stop already happened (review thread P2).
 *
 * Every durable terminal-state write — admission markers, no-effect
 * reservations, reservation finalization, and pending-marker transitions — must
 * go through this single bound in BOTH session runtimes (the notifications-hosted
 * bus runtime and the SDK-only host runtime); a hand-rolled copy is how the two
 * paths drift apart.
 */
export function boundTerminalRetentionState<Row extends DurableScopeRetentionRow, Key extends { keyHash: string }>(
	priorKeys: readonly Key[],
	nextScopes: Row[],
	maxScopes: number = MAX_DURABLE_TERMINAL_RESERVATIONS,
): { scopes: Row[]; keys: Array<Key | EvictedTerminalKey> } {
	const scopes = boundCompletedTerminalScopeRows(nextScopes, maxScopes);
	const evicted = collectEvictedTerminalKeys(nextScopes, scopes);
	return {
		scopes,
		keys: boundEvictedTerminalKeys<Key | EvictedTerminalKey>(
			[...priorKeys, ...evicted],
			MAX_RETAINED_TERMINAL_KEY_TOMBSTONES,
		),
	};
}
