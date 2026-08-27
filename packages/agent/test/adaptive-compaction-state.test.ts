import { describe, expect, it } from "bun:test";
import { AdaptiveCompactionTracker } from "../src/compaction/adaptive";

describe("AdaptiveCompactionTracker", () => {
	it("tracks calls since the last compaction and resets after compaction", () => {
		const tracker = new AdaptiveCompactionTracker(60_000, 1_000);

		tracker.recordCall(50_000, 1_000);
		tracker.recordCall(70_000, 2_000);

		expect(tracker.snapshot()).toMatchObject({
			turnsSinceCompact: 2,
			callsInWindow: 2,
			windowStart: 1_000,
			lastContextTokens: 70_000,
			lastCompactContextTokens: null,
			lastCompactTs: null,
		});

		tracker.recordCompact(70_000, 3_000);

		expect(tracker.snapshot()).toMatchObject({
			turnsSinceCompact: 0,
			callsInWindow: 0,
			windowStart: 3_000,
			lastContextTokens: 70_000,
			lastCompactContextTokens: 70_000,
			lastCompactTs: 3_000,
		});
	});

	it("starts a new tumbling call-rate window at the expiry boundary", () => {
		const tracker = new AdaptiveCompactionTracker(60_000, 0);

		tracker.recordCall(80_000, 1_000);
		tracker.recordCall(90_000, 30_000);
		expect(tracker.snapshot().callsInWindow).toBe(2);

		tracker.recordCall(95_000, 61_000);
		expect(tracker.snapshot()).toMatchObject({
			turnsSinceCompact: 3,
			callsInWindow: 1,
			windowStart: 61_000,
			lastContextTokens: 95_000,
		});
	});

	it("resets without changing the configured window", () => {
		const tracker = new AdaptiveCompactionTracker(60_000, 0);
		tracker.recordCall(80_000, 1_000);

		tracker.reset(2_000);

		expect(tracker.snapshot()).toMatchObject({
			turnsSinceCompact: 0,
			callsInWindow: 0,
			windowStart: 2_000,
			lastContextTokens: 0,
			lastCompactContextTokens: null,
			lastCompactTs: null,
		});
		expect(tracker.windowMs).toBe(60_000);
	});

	it("normalizes non-finite window durations", () => {
		const tracker = new AdaptiveCompactionTracker(Number.NaN, 0);

		expect(tracker.windowMs).toBe(60_000);
		tracker.recordCall(80_000, 60_000);
		expect(tracker.snapshot().callsInWindow).toBe(1);
	});

	it("retains compaction metadata when counters are reset", () => {
		const tracker = new AdaptiveCompactionTracker(60_000, 0);
		tracker.recordCall(80_000, 1_000);
		tracker.reset(2_000);
		tracker.recordCompact(123_000, 3_000);

		expect(tracker.snapshot()).toMatchObject({
			turnsSinceCompact: 0,
			callsInWindow: 0,
			lastContextTokens: 123_000,
			lastCompactContextTokens: 123_000,
			lastCompactTs: 3_000,
		});
	});

	it("exposes the latest context size for adaptive decisions", () => {
		const tracker = new AdaptiveCompactionTracker(60_000, 0);

		tracker.recordCall(80_000, 1_000);
		tracker.recordCall(90_000, 2_000);

		expect(tracker.decisionState()).toEqual({
			turnsSinceCompact: 2,
			callsInWindow: 2,
			lastContextTokens: 90_000,
		});
	});
});
