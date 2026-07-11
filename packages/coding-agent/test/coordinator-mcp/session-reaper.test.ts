import { describe, expect, it, vi } from "bun:test";
import {
	createSessionReaper,
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
			{ listSessions: async () => [], reapSession: async () => {}, now: () => NOW },
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
});
