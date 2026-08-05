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
const activeScopes = new Map<string, ActiveTerminalScope>();
const activeScopeByAttempt = new Map<string, string>();
const ownedRegistrations = new Map<string, TurnRegistrationKey>();

/** Register one active terminal scope (scopeId -> seam). Bounded; evicts oldest. */
export function registerTerminalScope(scope: ActiveTerminalScope): void {
	if (activeScopes.size >= MAX_ACTIVE_TERMINAL_SCOPES) {
		const oldest = activeScopes.keys().next().value;
		if (oldest !== undefined) unregisterTerminalScope(oldest);
	}
	activeScopes.set(scope.scopeId, scope);
	activeScopeByAttempt.set(`${scope.lineageIdHash}\u0000${scope.abortedAttemptEpoch}`, scope.scopeId);
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
export function registerOwnedRegistration(key: TurnRegistrationKey): void {
	const mapKey = `${key.jobId}\u0000${key.jobGeneration}`;
	if (ownedRegistrations.has(mapKey)) return;
	if (ownedRegistrations.size >= MAX_OWNED_REGISTRATIONS) {
		const oldest = ownedRegistrations.keys().next().value;
		if (oldest !== undefined) ownedRegistrations.delete(oldest);
	}
	ownedRegistrations.set(mapKey, key);
}

/** Exact (jobId, jobGeneration) lookup for completion-origin classification. */
export function lookupOwnedRegistration(jobId: string, jobGeneration: string): TurnRegistrationKey | undefined {
	return ownedRegistrations.get(`${jobId}\u0000${jobGeneration}`);
}

export function unregisterOwnedRegistration(key: TurnRegistrationKey): void {
	ownedRegistrations.delete(`${key.jobId}\u0000${key.jobGeneration}`);
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
export interface LineageBinding {
	lineageIdHash: string;
	promptAttemptEpoch: number;
	endpointGeneration: number;
}

const MAX_LINEAGE_BINDINGS = 8192;
const lineageByToolCall = new Map<string, LineageBinding>();

/**
 * Bind immutable lineage/attempt metadata to an attempt-scoped tool call
 * identity (toolCallId). The binding is set once at prompt admission and must
 * never be mutated from a session-current fallback; missing/mismatched
 * context fails closed (resolve returns undefined).
 */
export function bindToolLineage(toolCallId: string, binding: LineageBinding): void {
	if (lineageByToolCall.size >= MAX_LINEAGE_BINDINGS) {
		const oldest = lineageByToolCall.keys().next().value;
		if (oldest !== undefined) lineageByToolCall.delete(oldest);
	}
	lineageByToolCall.set(toolCallId, binding);
}

export function resolveToolLineage(toolCallId: string | undefined): LineageBinding | undefined {
	return toolCallId === undefined ? undefined : lineageByToolCall.get(toolCallId);
}

export function unbindToolLineage(toolCallId: string): void {
	lineageByToolCall.delete(toolCallId);
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
	manager: { getJob?(id: string): { generation?: string } | undefined },
	toolCallId: string | undefined,
	jobId: string,
): void {
	try {
		const lineage = resolveToolLineage(toolCallId);
		if (!lineage) return;
		const jobGeneration = manager.getJob?.(jobId)?.generation;
		if (!jobGeneration) return;
		registerOwnedRegistration({
			endpointGeneration: lineage.endpointGeneration,
			lineageIdHash: lineage.lineageIdHash,
			promptAttemptEpoch: lineage.promptAttemptEpoch,
			jobId,
			jobGeneration,
		});
	} catch {
		// ignore: never break ordinary registration
	}
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
}): RegisteredTerminalScope {
	const terminalScopeId = options.terminalScopeId ?? newTerminalScopeId();
	const seam = createTurnContinuationSeam({
		lineageIdHash: options.lineageIdHash,
		abortedAttemptEpoch: options.promptAttemptEpoch,
		terminalScopeId,
		ownedCompletionPolicy: options.ownedCompletionPolicy,
		blockedContinuationIds: options.blockedContinuationIds,
	});
	seam.gate.close("terminal-turn");
	registerTerminalScope({
		scopeId: terminalScopeId,
		lineageIdHash: options.lineageIdHash,
		abortedAttemptEpoch: options.promptAttemptEpoch,
		gate: seam.gate,
		fence: seam.fence,
	});
	return {
		scopeId: terminalScopeId,
		lineageIdHash: options.lineageIdHash,
		promptAttemptEpoch: options.promptAttemptEpoch,
		seam,
	};
}
