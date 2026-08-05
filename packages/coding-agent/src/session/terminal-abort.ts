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
import { randomUUID } from "node:crypto";

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
