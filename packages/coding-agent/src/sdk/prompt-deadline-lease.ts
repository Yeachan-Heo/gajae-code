/**
 * Bounded progress-aware lease for the SDK prompt terminal deadline (#4334).
 *
 * The accepted prompt deadline is no longer a fixed wall-clock window from
 * acceptance: fresh *attributable* progress — tool/skill execution events
 * correlated to the exact accepted `commandId`/`turnId` at the prompt/agent
 * runtime boundary — renews the terminal deadline up to a deterministic hard
 * maximum runtime. Unrelated session noise, heartbeats, other turns, streaming
 * chatter, and retry bookkeeping never renew the lease, and there is no
 * unbounded disable value: `maxMs` is always a finite bound.
 */

/** Agent session event types that constitute attributable agent/skill/tool progress. */
const ATTRIBUTABLE_PROGRESS_EVENT_TYPES = new Set(["tool_execution_start", "tool_execution_end"]);

export interface PromptDeadlineLease {
	/** When the prompt was accepted; anchors the hard maximum runtime. */
	readonly acceptedAt: number;
	/** Last verified attributable progress (starts at acceptance). */
	lastProgressAt: number;
	/** Inactivity window: the deadline is this far past the last verified progress. */
	readonly leaseMs: number;
	/** Deterministic hard maximum runtime from acceptance; never unbounded. */
	readonly maxMs: number;
	/** Monotonic revision used to reject stale expiry work after progress. */
	generation: number;
}

export function createPromptDeadlineLease(input: { now: number; leaseMs: number; maxMs: number }): PromptDeadlineLease {
	return {
		acceptedAt: input.now,
		lastProgressAt: input.now,
		leaseMs: input.leaseMs,
		maxMs: input.maxMs,
		generation: 0,
	};
}

/**
 * Current terminal deadline: the inactivity lease from last verified progress,
 * bounded by the hard maximum runtime from acceptance.
 */
export function promptDeadlineAt(lease: PromptDeadlineLease): number {
	return Math.min(lease.lastProgressAt + lease.leaseMs, lease.acceptedAt + lease.maxMs);
}

/**
 * Record fresh attributable progress. Monotonic: a stale or equal timestamp
 * never moves the lease backwards, so out-of-order delivery cannot shorten it.
 */
export function recordAttributableProgress(lease: PromptDeadlineLease, now: number): void {
	if (now > lease.lastProgressAt) {
		lease.lastProgressAt = now;
		lease.generation += 1;
	}
}

/**
 * Whether an agent session event at the prompt/agent runtime boundary is
 * attributable progress for the accepted prompt. Only tool execution
 * boundaries qualify: skills do their work through tools, so skill progress is
 * covered; streaming text/thinking deltas, retries, and bookkeeping are not.
 */
export function isAttributableProgressEventType(type: string): boolean {
	return ATTRIBUTABLE_PROGRESS_EVENT_TYPES.has(type);
}
