/**
 * Core types for the gajae-code-native coding-harness operations control plane (v1).
 *
 * See the approved consensus plan at
 * `.gjc/plans/ralplan/2026-06-02-0853-3e33/stage-02-revision.md` and the spec at
 * `.gjc/specs/deep-interview-harness-control-plane.md`.
 *
 * v1 implements the gajae-code adapter only. omx/codex/remote/auth are deferred seams.
 */

import type { AgentWireObservedSignal } from "../modes/shared/agent-wire/event-contract";

/** Harnesses the control plane can operate. v1 implements `gajae-code` only. */
export type Harness = "gajae-code" | "codex" | "omx";

/** Operating mode of a session. `implement` builds/changes code; `review` produces a read-only verdict. */
export type SessionMode = "implement" | "review";

/** Closed vocabulary of terminal review verdicts a review-only session may emit. */
export type ReviewVerdict = "APPROVE_MERGE_READY" | "REQUEST_CHANGES" | "OWNER_CONFIRMATION_REQUIRED";

export const REVIEW_VERDICTS: readonly ReviewVerdict[] = [
	"APPROVE_MERGE_READY",
	"REQUEST_CHANGES",
	"OWNER_CONFIRMATION_REQUIRED",
];

export function isReviewVerdict(value: unknown): value is ReviewVerdict {
	return typeof value === "string" && (REVIEW_VERDICTS as readonly string[]).includes(value);
}

/**
 * Alias verdict tokens accepted from free-form assistant text, mapped to their canonical verdict.
 * `MERGE_READY` is treated as `APPROVE_MERGE_READY`.
 */
const VERDICT_ALIASES: Readonly<Record<string, ReviewVerdict>> = {
	MERGE_READY: "APPROVE_MERGE_READY",
};

/**
 * Extract a single closed-vocabulary review verdict from free-form assistant text.
 *
 * Scans for canonical verdict tokens (and accepted aliases) as whole words and returns the
 * LAST occurrence — the agent's final stated decision wins over any earlier mention. Returns
 * null when no allowed token is present, so the finalizer fails closed on a missing verdict.
 */
export function extractReviewVerdict(text: string | null | undefined): ReviewVerdict | null {
	if (typeof text !== "string" || text.length === 0) return null;
	const tokens = [...REVIEW_VERDICTS, ...Object.keys(VERDICT_ALIASES)];
	const pattern = new RegExp(`\\b(${tokens.join("|")})\\b`, "g");
	let last: ReviewVerdict | null = null;
	for (const match of text.matchAll(pattern)) {
		const token = match[1];
		last = VERDICT_ALIASES[token] ?? (token as ReviewVerdict);
	}
	return last;
}

/** Lifecycle states of an operated session. */
export type HarnessLifecycle =
	| "new"
	| "started"
	| "submitted"
	| "observing"
	| "recovering"
	| "validating"
	| "finalizing"
	| "completed"
	| "blocked"
	| "retired";

/** Event severities emitted by the owner. */
export type Severity = "info" | "warn" | "critical";

/** Bounded git delta classification surfaced by `observe`. */
export type GitDelta = "clean" | "dirty" | "zero-delta" | "unknown";

/** Risk classification surfaced by `observe`. */
export type RiskKind = "normal" | "prompt-not-accepted" | "deleted-worktree" | "vanished-dirty";

/** Deterministic recovery classifications. */
export type RecoveryClassification =
	| "continue"
	| "send-enter"
	| "reinject-prompt"
	| "restart-clean"
	| "restart-preserve-delta"
	| "fallback-codex-exec"
	| "human-check";

/** Receipt families persisted under the session storage dir. */
export type ReceiptFamily =
	| "vanish"
	| "prompt-acceptance"
	| "validation"
	| "completion"
	| "review-verdict"
	| "review-failure"
	| "phase-rollup";

/** The CLI verbs / primitives exposed by `gjc harness <verb>`. */
export type HarnessVerb =
	| "start"
	| "submit"
	| "observe"
	| "classify"
	| "recover"
	| "validate"
	| "finalize"
	| "retire"
	| "events"
	| "monitor"
	| "operate";

/** Submission transports. */
export type SubmitMode = "paste-buffer" | "stdin" | "file";

/** A single entry in the forcing-function `nextAllowedActions` list. */
export interface NextAllowedAction {
	verb: HarnessVerb;
	available: boolean;
	/** Present when `available` is false; explains why the verb is currently disallowed. */
	reason?: string;
}

/** Compact, model-facing view of session state included in every response. */
export interface SessionStateView {
	sessionId: string;
	lifecycle: HarnessLifecycle;
	harness: Harness;
	ownerLive: boolean;
	blockers: string[];
}

/**
 * The universal contract: EVERY primitive response carries `{state, evidence, nextAllowedActions}`.
 * `ok` is a transport-level convenience; semantic blocking is expressed via state + nextAllowedActions.
 */
export interface PrimitiveResponse<E = Record<string, unknown>> {
	ok: boolean;
	state: SessionStateView;
	evidence: E;
	nextAllowedActions: NextAllowedAction[];
}

/** Re-grabbable session handle returned by `start` / `operate`. */
export interface SessionHandle {
	sessionId: string;
	harness: Harness;
	/** Operating mode; absent on legacy records means `implement`. */
	mode?: SessionMode;
	repo: string | null;
	workspace: string;
	branch: string | null;
	base: string | null;
	issueOrPr: string | null;
	processHandle: { kind: "runtime-owner"; ownerId: string | null; pid: number | null };
	sdkHandle: { kind: "sdk-session-endpoint"; sessionId: string };
	ownerHandle: { leasePath: string; endpoint: string | null; heartbeatAt: string | null };
	routerHandle: { kind: "default-in-owner"; policy: string; eventsPath: string };
	viewportHandle: { kind: "event-monitor"; tmuxSessionName: string | null; viewOnly: true };
	startedAt: string;
	updatedAt: string;
}

/** Persisted per-session record (state.json). */
export interface SessionState {
	schemaVersion: number;
	sessionId: string;
	lifecycle: HarnessLifecycle;
	harness: Harness;
	handle: SessionHandle;
	/** Per-classification retry counters consumed by the recovery policy. */
	retries: Record<string, number>;
	blockers: string[];
	createdAt: string;
	updatedAt: string;
}

/**
 * Bounded observed-signal vocabulary surfaced by `observe` (the owner only ever
 * emits these). Aliased to the canonical agent-wire signal vocabulary so there
 * is a single source of truth shared with the observation core.
 */
export type ObservedSignal = AgentWireObservedSignal;

export const OBSERVED_SIGNALS: readonly ObservedSignal[] = [
	"SessionStart",
	"prompt-accepted",
	"tool-call",
	"test-running",
	"commit-created",
	"completed",
	"error",
	"streaming",
	"idle",
];

/** Bounded observation surfaced by `observe` — never a raw pane/transcript dump. */
export interface Observation {
	lifecycle: HarnessLifecycle;
	ownerLive: boolean;
	cwd: string;
	branch: string | null;
	gitDelta: GitDelta;
	lastActivityAt: string | null;
	observedSignals: string[];
	risk: RiskKind;
	/** RPC subprocess liveness, distinct from owner-process/lease liveness. Optional for back-compat. */
	rpcLive?: boolean;
	/** ISO timestamp of the most recent RPC frame the owner observed, if any. */
	rpcLastFrameAt?: string | null;
	/** True only when owner/rpc/lifecycle gates indicate a prompt can be submitted now. */
	readyForSubmit?: boolean;
	/** Present when readyForSubmit is false; mirrors submit's nextAllowedActions reason. */
	submitUnavailableReason?: string | null;
}

/** Input to the deterministic recovery classifier. */
export interface ClassifyInput {
	observation: Observation;
	/** Remaining retry budget per classification family. */
	retryBudget: RetryBudget;
	/** Whether an accepted prompt was in flight when the owner/RPC was last seen. */
	acceptedPromptActive?: boolean;
}

/** Default and supplied retry budgets. */
export interface RetryBudget {
	reinjectPrompt: number;
	zeroDeltaVanish: number;
	dirtyVanishPreserve: number;
	validationRepair: number;
}

/** Result of the deterministic recovery classifier. */
export interface RecoveryDecision {
	classification: RecoveryClassification;
	reason: string;
	severity: Severity;
	/** Whether executing the recommended action requires a live owner. */
	ownerRequired: boolean;
	/** Receipt family that MUST be valid before the action may proceed (e.g. `vanish`). */
	requiredReceiptFamily: ReceiptFamily | null;
}

/** Severity-tagged event envelope written exclusively by the owner. */
export interface EventEnvelope<E = Record<string, unknown>> {
	eventId: string;
	cursor: number;
	createdAt: string;
	severity: Severity;
	kind: string;
	state: SessionStateView;
	evidence: E;
	nextAllowedActions: NextAllowedAction[];
	writer: { ownerId: string; leaseEpoch: number };
}

export const SESSION_SCHEMA_VERSION = 1 as const;

export const DEFAULT_RETRY_BUDGET: RetryBudget = {
	reinjectPrompt: 2,
	zeroDeltaVanish: 1,
	dirtyVanishPreserve: 1,
	validationRepair: 2,
};
