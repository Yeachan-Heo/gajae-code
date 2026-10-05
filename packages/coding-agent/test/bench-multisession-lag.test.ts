import { describe, expect, it } from "bun:test";
import { LAG_INTERVAL_MS, LagSampler } from "../bench/multisession/lag";

describe("multi-session event-loop lag sampler", () => {
	it("does not accumulate ordinary per-tick timer drift into lag", () => {
		// A timer that fires 1.5ms late every tick for ~3 minutes: per-tick lag stays 1.5ms,
		// whereas a fixed schedule from the start would report ~2.9s by the last tick.
		const sampler = new LagSampler(0);
		let now = 0;
		for (let tick = 0; tick < 1_950; tick += 1) {
			now += LAG_INTERVAL_MS + 1.5;
			sampler.tick(now);
		}
		expect(sampler.samplesMs).toHaveLength(1_950);
		expect(Math.max(...sampler.samplesMs)).toBeCloseTo(1.5, 6);
	});

	it("reports a stall once, then recovers", () => {
		const sampler = new LagSampler(1_000);
		for (const at of [1_100, 1_200, 1_800, 1_900, 2_000]) sampler.tick(at);
		expect(sampler.samplesMs).toEqual([0, 0, 500, 0, 0]);
	});

	it("never reports negative lag for an early tick", () => {
		const sampler = new LagSampler(0);
		sampler.tick(99);
		expect(sampler.samplesMs).toEqual([0]);
	});
});
