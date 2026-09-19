import { expect, test } from "bun:test";
import {
	IDLE_TOOL_BOUNDARY_RESULT,
	TOOL_CALL_BOUNDARY_GRACE_MS,
	waitForToolCallBoundary,
} from "../src/sdk/prompt-tool-boundary";

/**
 * Pure-module cases for the bounded tool-boundary wait (#5637). Deterministic by
 * construction: the pending set is a plain array under the test's control and
 * the idle signal is a manually resolved promise, so nothing here depends on
 * wall-clock scheduling except the injected short grace.
 */

const GRACE_MS = 20;

/** Pending set plus the idle signal the bus derives from it, as a test double. */
function pendingSet(initial: string[]) {
	const ids = [...initial];
	const waiters: Array<() => void> = [];
	return {
		pending: (): readonly string[] => ids,
		whenIdle: (): Promise<void> => {
			if (ids.length === 0) return Promise.resolve();
			const { promise, resolve } = Promise.withResolvers<void>();
			waiters.push(resolve);
			return promise;
		},
		end: (id: string) => {
			const index = ids.indexOf(id);
			if (index < 0) return;
			ids.splice(index, 1);
			if (ids.length === 0) for (const resolve of waiters.splice(0)) resolve();
		},
	};
}

test("an idle prompt returns the shared idle result without arming a timer", async () => {
	// The overwhelmingly common case: deadline expiry with no tool running must
	// stay byte-identical to its pre-#5637 behaviour — no timer, no allocation.
	let armed = 0;
	const realSetTimeout = globalThis.setTimeout;
	globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
		armed += 1;
		return realSetTimeout(...args);
	}) as typeof setTimeout;
	try {
		const result = await waitForToolCallBoundary({
			pending: () => [],
			whenIdle: () => Promise.resolve(),
			graceMs: GRACE_MS,
		});
		expect(result).toBe(IDLE_TOOL_BOUNDARY_RESULT);
		expect(result.outcome).toBe("idle");
		expect(result.waitedMs).toBe(0);
		expect(result.pendingToolCallIds).toEqual([]);
		expect(armed).toBe(0);
	} finally {
		globalThis.setTimeout = realSetTimeout;
	}
});

test("a tool that reaches its boundary inside the grace settles the wait", async () => {
	// AC-1 at the pure level: the wait ends on the tool's own boundary, not on the
	// grace timer, so the caller's abort lands with no tool running.
	const tools = pendingSet(["slow-tool"]);
	const waited = waitForToolCallBoundary({
		pending: tools.pending,
		whenIdle: tools.whenIdle,
		graceMs: 5_000,
		now: () => 0,
	});
	tools.end("slow-tool");
	const result = await waited;
	expect(result.outcome).toBe("settled");
	expect(result.pendingToolCallIds).toEqual([]);
});

test("a tool still executing when the grace expires forces termination and is recorded", async () => {
	// AC-2 at the pure level: force-termination is not silent — the ids of the
	// calls that were still running are returned as structured evidence.
	const tools = pendingSet(["stuck-tool", "other-stuck-tool"]);
	const result = await waitForToolCallBoundary({
		pending: tools.pending,
		whenIdle: tools.whenIdle,
		graceMs: GRACE_MS,
	});
	expect(result.outcome).toBe("forced");
	expect([...result.pendingToolCallIds].sort()).toEqual(["other-stuck-tool", "stuck-tool"]);
	expect(result.waitedMs).toBeGreaterThanOrEqual(GRACE_MS - 5);
});

test("only the calls still running at expiry are reported, not the ones that already ended", async () => {
	// The snapshot is taken when the grace expires, so a call that reached its
	// boundary during the wait never shows up as force-terminated.
	const tools = pendingSet(["finished-tool", "stuck-tool"]);
	const waited = waitForToolCallBoundary({
		pending: tools.pending,
		whenIdle: tools.whenIdle,
		graceMs: GRACE_MS,
	});
	tools.end("finished-tool");
	const result = await waited;
	expect(result.outcome).toBe("forced");
	expect(result.pendingToolCallIds).toEqual(["stuck-tool"]);
});

test("an idle signal that rejects leaves the grace as the sole arbiter, without an unhandled rejection", async () => {
	// The losing side of the race is abandoned, not cancelled: an unobserved
	// rejection from it must never reach the process-level handler and take the
	// host down.
	const unhandled: unknown[] = [];
	const onUnhandled = (reason: unknown) => unhandled.push(reason);
	process.on("unhandledRejection", onUnhandled);
	try {
		const result = await waitForToolCallBoundary({
			pending: () => ["stuck-tool"],
			whenIdle: () => Promise.reject(new Error("idle signal failed")),
			graceMs: GRACE_MS,
		});
		expect(result.outcome).toBe("forced");
		expect(result.pendingToolCallIds).toEqual(["stuck-tool"]);
		// Give the microtask queue and the rejection-tracking tick a chance to run.
		await Bun.sleep(20);
		expect(unhandled).toEqual([]);
	} finally {
		process.off("unhandledRejection", onUnhandled);
	}
});

test("the production grace is a finite, non-zero bound", () => {
	// No unbounded wait: a tool that never returns must still be force-terminated.
	expect(Number.isFinite(TOOL_CALL_BOUNDARY_GRACE_MS)).toBe(true);
	expect(TOOL_CALL_BOUNDARY_GRACE_MS).toBeGreaterThan(0);
});
