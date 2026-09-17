/**
 * Bounded wait for an in-flight dispatched tool call to reach its boundary
 * before an expired prompt deadline force-terminates the run (#5637).
 *
 * Terminal fencing aborts the run's cancellation domain FIRST and only proves
 * settlement afterwards (`RunResourceLedger.waitForSettlement` resolves once the
 * run is sealed and its tracked `kind: "tool"` resources have settled), so a
 * tool that was mid-write when the deadline expired observes the aborted signal
 * DURING its write and leaves a torn artifact behind. Waiting for that call's
 * own `tool_execution_end` — under a short, finite grace — turns the kill into a
 * boundary abort. When the grace is exhausted the run is force-terminated
 * exactly as before, and the fact that a tool was still executing is returned as
 * structured evidence rather than dropped.
 *
 * Deliberately dependency-light and clock-injectable: the contended bus module
 * takes only a call, and the behaviour is testable without a live transport.
 */

/**
 * Hard bound on how long deadline expiry will wait for an in-flight tool call to
 * reach its boundary before force-terminating. This guards a real subprocess, so
 * it is a real timer rather than the lease clock — and a parameter rather than a
 * bare module constant, so a test may shorten it explicitly instead of a fake
 * clock silently shortening it for production code too.
 */
export const TOOL_CALL_BOUNDARY_GRACE_MS = 5_000;

export type ToolBoundaryOutcome = "idle" | "settled" | "forced";

export interface ToolBoundaryWaitResult {
	outcome: ToolBoundaryOutcome;
	waitedMs: number;
	/**
	 * Non-empty ONLY for "forced": the dispatched tool calls still running when
	 * the grace expired. Ids only — never tool arguments, output or paths.
	 */
	pendingToolCallIds: string[];
}

/**
 * Shared result for the common case of no dispatched tool running at expiry.
 * Frozen because it is handed to every idle caller: the deadline path must stay
 * byte-identical to its pre-#5637 behaviour, which includes allocating nothing
 * and arming no timer.
 */
export const IDLE_TOOL_BOUNDARY_RESULT: ToolBoundaryWaitResult = Object.freeze({
	outcome: "idle" as const,
	waitedMs: 0,
	pendingToolCallIds: Object.freeze([]) as unknown as string[],
});

/**
 * Wait for the pending dispatched tool calls to drain, bounded by `graceMs`.
 *
 * Never composed with an abort signal: at the only call site nothing has been
 * aborted yet, and a signal that was already aborted would make this wait
 * unreachable — which is precisely the mid-tool kill being fixed.
 */
export async function waitForToolCallBoundary(input: {
	pending: () => readonly string[];
	/** Resolves when the pending set becomes empty. Expected never to reject. */
	whenIdle: () => Promise<void>;
	graceMs?: number;
	now?: () => number;
}): Promise<ToolBoundaryWaitResult> {
	const now = input.now ?? Date.now;
	// Idle prompts pay nothing: no timer, no allocation, no extra microtask turn
	// beyond the caller's own await.
	if (input.pending().length === 0) return IDLE_TOOL_BOUNDARY_RESULT;
	const graceMs = Math.max(0, input.graceMs ?? TOOL_CALL_BOUNDARY_GRACE_MS);
	const startedAt = now();
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const idle = input.whenIdle();
		// The loser of the race is abandoned rather than cancelled, so a rejection
		// from it must be swallowed here or it surfaces as an unhandled rejection
		// and takes the host down. A rejected idle simply leaves the grace timer
		// as the sole arbiter.
		const settled = new Promise<"settled">(resolve => {
			void idle.then(
				() => resolve("settled"),
				() => {},
			);
		});
		const forced = new Promise<"forced">(resolve => {
			timer = setTimeout(() => resolve("forced"), graceMs);
			// Never hold the process open for a tool that will not come back.
			timer?.unref?.();
		});
		const outcome = await Promise.race([settled, forced]);
		return outcome === "settled"
			? { outcome: "settled", waitedMs: now() - startedAt, pendingToolCallIds: [] }
			: { outcome: "forced", waitedMs: now() - startedAt, pendingToolCallIds: [...input.pending()] };
	} finally {
		clearTimeout(timer);
	}
}
