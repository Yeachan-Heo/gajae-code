import { describe, expect, it, vi } from "bun:test";
import { logger } from "@gajae-code/utils";
import {
	createSessionReaper,
	MAX_REAP_FAILURES,
	type ReapableSession,
	selectReapableSessions,
} from "../../src/coordinator-mcp/session-reaper";

const TTL = 30 * 60_000;
const NOW = 10_000_000;

function sess(id: string, over: Partial<ReapableSession> = {}): ReapableSession {
	return { sessionId: id, ephemeral: true, hasActiveTurn: false, lastActivityMs: NOW - TTL - 1, ...over };
}

describe("selectReapableSessions", () => {
	it("reaps ephemeral, idle-past-TTL, no-active-turn sessions", () => {
		expect(selectReapableSessions([sess("a")], NOW, TTL).map(s => s.sessionId)).toEqual(["a"]);
	});
	it("never reaps a non-ephemeral (user-registered resident) session", () => {
		expect(selectReapableSessions([sess("u", { ephemeral: false })], NOW, TTL)).toEqual([]);
	});
	it("never reaps a session with an active turn", () => {
		expect(selectReapableSessions([sess("t", { hasActiveTurn: true })], NOW, TTL)).toEqual([]);
	});
	it("keeps sessions still within the TTL", () => {
		expect(selectReapableSessions([sess("f", { lastActivityMs: NOW - 1000 })], NOW, TTL)).toEqual([]);
	});
	it("clamps a too-small TTL to the floor so a just-active session is never reaped", () => {
		expect(selectReapableSessions([sess("j", { lastActivityMs: NOW - 1000 })], NOW, 0)).toEqual([]);
	});
	it("reaps exactly at the TTL boundary", () => {
		expect(
			selectReapableSessions([sess("b", { lastActivityMs: NOW - TTL })], NOW, TTL).map(s => s.sessionId),
		).toEqual(["b"]);
	});
});

describe("createSessionReaper.sweepOnce", () => {
	it("reaps every eligible session and returns the count, skipping ineligible", async () => {
		const reaped: string[] = [];
		const reaper = createSessionReaper(
			{
				listSessions: async () => [sess("a"), sess("u", { ephemeral: false }), sess("b")],
				reapSession: async id => {
					reaped.push(id);
				},
				markSessionDead: async () => {},
				now: () => NOW,
			},
			{ idleTtlMs: TTL, sweepIntervalMs: 60_000 },
		);
		expect(await reaper.sweepOnce()).toBe(2);
		expect(reaped.sort()).toEqual(["a", "b"]);
	});

	it("continues the sweep when one reap throws (one wedged session cannot abort the rest)", async () => {
		const reaped: string[] = [];
		const reaper = createSessionReaper(
			{
				listSessions: async () => [sess("bad"), sess("good")],
				reapSession: async id => {
					if (id === "bad") throw new Error("wedged");
					reaped.push(id);
				},
				markSessionDead: async () => {},
				now: () => NOW,
			},
			{ idleTtlMs: TTL, sweepIntervalMs: 60_000 },
		);
		expect(await reaper.sweepOnce()).toBe(1);
		expect(reaped).toEqual(["good"]);
	});

	it("never overlaps concurrent sweeps", async () => {
		let active = 0;
		let maxActive = 0;
		const reaper = createSessionReaper(
			{
				listSessions: async () => {
					active += 1;
					maxActive = Math.max(maxActive, active);
					await new Promise(r => setTimeout(r, 10));
					active -= 1;
					return [];
				},
				reapSession: async () => {},
				markSessionDead: async () => {},
				now: () => NOW,
			},
			{ idleTtlMs: TTL, sweepIntervalMs: 60_000 },
		);
		const first = reaper.sweepOnce();
		const second = reaper.sweepOnce(); // fires while first is mid-list
		expect(await second).toBe(0); // guarded out
		await first;
		expect(maxActive).toBe(1);
	});
});

describe("createSessionReaper scheduler", () => {
	it("start()/stop() flips running and is idempotent", () => {
		const reaper = createSessionReaper(
			{ listSessions: async () => [], reapSession: async () => {}, markSessionDead: async () => {}, now: () => NOW },
			{ idleTtlMs: TTL, sweepIntervalMs: 60_000 },
		);
		expect(reaper.running).toBe(false);
		reaper.start();
		reaper.start(); // idempotent, no duplicate timer
		expect(reaper.running).toBe(true);
		reaper.stop();
		expect(reaper.running).toBe(false);
	});

	it("fires a sweep when the interval elapses", () => {
		vi.useFakeTimers();
		try {
			let sweeps = 0;
			const reaper = createSessionReaper(
				{
					listSessions: async () => {
						sweeps += 1;
						return [];
					},
					reapSession: async () => {},
					markSessionDead: async () => {},
					now: () => NOW,
				},
				{ idleTtlMs: TTL, sweepIntervalMs: 60_000 },
			);
			reaper.start();
			vi.advanceTimersByTime(60_000);
			expect(sweeps).toBe(1);
			reaper.stop();
		} finally {
			vi.useRealTimers();
		}
	});

	it("stop() cancels the pending scheduled sweep so it never fires (generation guard)", () => {
		vi.useFakeTimers();
		try {
			let sweeps = 0;
			const reaper = createSessionReaper(
				{
					listSessions: async () => {
						sweeps += 1;
						return [];
					},
					reapSession: async () => {},
					markSessionDead: async () => {},
					now: () => NOW,
				},
				{ idleTtlMs: TTL, sweepIntervalMs: 60_000 },
			);
			reaper.start();
			reaper.stop();
			vi.advanceTimersByTime(300_000);
			expect(sweeps).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it("logs a refused sweep and reschedules the next attempt", async () => {
		vi.useFakeTimers();
		const warning = vi.spyOn(logger, "warn").mockImplementation(() => {});
		try {
			let listCalls = 0;
			const reaper = createSessionReaper(
				{
					listSessions: async () => {
						listCalls += 1;
						if (listCalls === 1) throw new Error("coordinator_projection_scan_incomplete");
						return [];
					},
					reapSession: async () => {},
					markSessionDead: async () => {},
					now: () => NOW,
				},
				{ idleTtlMs: TTL, sweepIntervalMs: 60_000 },
			);
			reaper.start();
			vi.advanceTimersByTime(60_000);
			for (let i = 0; i < 6; i++) await Promise.resolve();
			expect(listCalls).toBe(1);
			expect(warning).toHaveBeenCalledWith("session-reaper: sweep refused: coordinator_projection_scan_incomplete");
			expect(reaper.running).toBe(true);
			vi.advanceTimersByTime(60_000);
			for (let i = 0; i < 6; i++) await Promise.resolve();
			expect(listCalls).toBe(2);
			reaper.stop();
		} finally {
			warning.mockRestore();
			vi.useRealTimers();
		}
	});
});
// NEW TESTS — append to existing describe blocks or add new ones
// These exercise the bounded-retry / eviction path (AC-1, AC-2, AC-3).

describe("createSessionReaper.sweepOnce — bounded failure eviction", () => {
	it("AC-1: reproduces infinite-retry: stale endpoint stub evicts after MAX_REAP_FAILURES sweeps", async () => {
		const warning = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const deadSessions: string[] = [];
		// After eviction the session is gone; simulate by tracking evicted ids.
		const evicted = new Set<string>();
		const reaper = createSessionReaper(
			{
				listSessions: async () => (evicted.has("stale") ? [] : [sess("stale")]),
				reapSession: async () => {
					throw new Error("endpoint_stale");
				},
				markSessionDead: async id => {
					evicted.add(id);
					deadSessions.push(id);
				},
				now: () => NOW,
			},
			{ idleTtlMs: TTL, sweepIntervalMs: 60_000 },
		);

		// First MAX_REAP_FAILURES - 1 sweeps: warn but do NOT evict yet.
		for (let i = 0; i < MAX_REAP_FAILURES - 1; i++) {
			await reaper.sweepOnce();
		}
		expect(deadSessions).toHaveLength(0);
		// The (MAX_REAP_FAILURES)th sweep crosses the threshold -> evict.
		await reaper.sweepOnce();
		expect(deadSessions).toEqual(["stale"]);

		// AC-3: subsequent sweeps do NOT call reapSession (listSessions returns []).
		const warnsBefore = warning.mock.calls.length;
		await reaper.sweepOnce();
		await reaper.sweepOnce();
		expect(warning.mock.calls.length).toBe(warnsBefore); // no new warns
		expect(deadSessions).toHaveLength(1); // markSessionDead called exactly once

		warning.mockRestore();
	});

	it("F1: a non-endpoint_stale failure retries forever and is never force-evicted", async () => {
		const warning = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const deadSessions: string[] = [];
		let reapAttempts = 0;
		const reaper = createSessionReaper(
			{
				listSessions: async () => [sess("wedged")],
				reapSession: async () => {
					reapAttempts += 1;
					// close_failed / broker / filesystem errors are transient, not stale.
					throw new Error("close_failed");
				},
				markSessionDead: async id => {
					deadSessions.push(id);
				},
				now: () => NOW,
			},
			{ idleTtlMs: TTL, sweepIntervalMs: 60_000 },
		);

		// Far more sweeps than MAX_REAP_FAILURES: a transient failure must keep
		// retrying and never escalate to force eviction.
		for (let i = 0; i < MAX_REAP_FAILURES + 5; i++) {
			await reaper.sweepOnce();
		}
		expect(reapAttempts).toBe(MAX_REAP_FAILURES + 5);
		expect(deadSessions).toHaveLength(0);
		// Only the retry warn fires — never the "evicted after" warn.
		expect(warning.mock.calls.some(([msg]) => String(msg).includes("evicted after"))).toBe(false);

		warning.mockRestore();
	});

	it("F1: a non-stale failure resets the stale streak (consecutive contract)", async () => {
		const warning = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const deadSessions: string[] = [];
		let mode: "stale" | "other" = "stale";
		const reaper = createSessionReaper(
			{
				listSessions: async () => [sess("mixed")],
				reapSession: async () => {
					throw new Error(mode === "stale" ? "endpoint_stale" : "close_failed");
				},
				markSessionDead: async id => {
					deadSessions.push(id);
				},
				now: () => NOW,
			},
			{ idleTtlMs: TTL, sweepIntervalMs: 60_000 },
		);

		// Accumulate stale failures right up to the threshold boundary.
		for (let i = 0; i < MAX_REAP_FAILURES - 1; i++) await reaper.sweepOnce();
		expect(deadSessions).toHaveLength(0);
		// A non-stale failure breaks the consecutive streak and resets the counter.
		mode = "other";
		await reaper.sweepOnce();
		expect(deadSessions).toHaveLength(0);
		// The counter was reset: a single further stale failure is only count=1, so it
		// must NOT cross the threshold — the previous streak no longer counts.
		mode = "stale";
		await reaper.sweepOnce();
		expect(deadSessions).toHaveLength(0);
		// Only a fresh, fully-consecutive stale streak reaches eviction.
		for (let i = 0; i < MAX_REAP_FAILURES - 1; i++) await reaper.sweepOnce();
		expect(deadSessions).toEqual(["mixed"]);

		warning.mockRestore();
	});

	it("AC-2: success resets the failure counter so the session gets MAX_REAP_FAILURES fresh chances", async () => {
		const warning = vi.spyOn(logger, "warn").mockImplementation(() => {});
		let shouldFail = true;
		const deadSessions: string[] = [];
		const reaper = createSessionReaper(
			{
				listSessions: async () => [sess("flaky")],
				reapSession: async () => {
					if (shouldFail) throw new Error("endpoint_stale");
				},
				markSessionDead: async id => {
					deadSessions.push(id);
				},
				now: () => NOW,
			},
			{ idleTtlMs: TTL, sweepIntervalMs: 60_000 },
		);

		// Fail once (count = 1).
		await reaper.sweepOnce();
		expect(deadSessions).toHaveLength(0);

		// Succeed -- resets counter to 0.
		shouldFail = false;
		await reaper.sweepOnce();

		// Now fail MAX_REAP_FAILURES times in a row -- should evict only after a fresh MAX streak.
		shouldFail = true;
		for (let i = 0; i < MAX_REAP_FAILURES - 1; i++) {
			await reaper.sweepOnce();
		}
		expect(deadSessions).toHaveLength(0); // not yet
		await reaper.sweepOnce();
		expect(deadSessions).toEqual(["flaky"]);

		warning.mockRestore();
	});

	it("AC-3: the eviction warn fires exactly once, not on subsequent sweeps", async () => {
		const warnings: string[] = [];
		vi.spyOn(logger, "warn").mockImplementation(msg => {
			warnings.push(msg as string);
		});
		const evicted = new Set<string>();
		const reaper = createSessionReaper(
			{
				listSessions: async () => (evicted.has("s") ? [] : [sess("s")]),
				reapSession: async () => {
					throw new Error("endpoint_stale");
				},
				markSessionDead: async id => {
					evicted.add(id);
				},
				now: () => NOW,
			},
			{ idleTtlMs: TTL, sweepIntervalMs: 60_000 },
		);

		// Run enough sweeps to trigger eviction and several more after.
		for (let i = 0; i < MAX_REAP_FAILURES + 5; i++) {
			await reaper.sweepOnce();
		}

		const evictionWarns = warnings.filter(w => w.includes("evicted after"));
		expect(evictionWarns).toHaveLength(1);
		// Regular per-failure warns fire only for the first (MAX_REAP_FAILURES - 1) sweeps.
		const failureWarns = warnings.filter(w => w.includes("failed to reap"));
		expect(failureWarns.length).toBe(MAX_REAP_FAILURES - 1);

		vi.restoreAllMocks();
	});
});
