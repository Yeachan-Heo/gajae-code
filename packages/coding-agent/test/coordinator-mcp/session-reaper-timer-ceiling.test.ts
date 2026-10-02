import { describe, expect, it } from "bun:test";
import { createSessionReaper } from "../../src/coordinator-mcp/session-reaper";

describe("session reaper sweep interval ceiling", () => {
	it("does not re-sweep back to back when the interval exceeds the setTimeout maximum", async () => {
		// Given a sweep interval one past the 32-bit setTimeout limit (about 24.9 days),
		// which setTimeout would otherwise treat as 1 ms.
		let sweeps = 0;
		const reaper = createSessionReaper(
			{
				listSessions: async () => {
					sweeps += 1;
					return [];
				},
				reapSession: async () => {},
				markSessionDead: async () => {},
				now: () => Date.now(),
			},
			{ idleTtlMs: 30 * 60_000, sweepIntervalMs: 2 ** 31 },
		);

		// When the reaper runs for a short while.
		reaper.start();
		try {
			await Bun.sleep(100);
		} finally {
			reaper.stop();
		}

		// Then no sweep has fired yet.
		expect(sweeps).toBe(0);
	});
});
