import { afterEach, describe, expect, it, vi } from "bun:test";
// Imported from the module rather than the package barrel: the barrel pulls in
// the native addon, which this suite does not need and which is not built in
// every checkout.
import {
	__animationSchedulerTestHooks,
	__setAnimationCongestionProbe,
	registerAnimationCallback,
} from "@gajae-code/tui/animation-scheduler";

/**
 * Animation ticks are decorative and droppable. When the output sink is backed
 * up — a remote terminal over SSH, a multiplexer, any slow pipe — emitting them
 * anyway does not make the screen more current; it queues frames the terminal
 * has not drained yet, so the user watches a backlog replay.
 *
 * These tests pin the two halves of that contract: skip while congested, resume
 * the moment it clears, and never skip on a healthy terminal.
 */
describe("animation scheduler backpressure", () => {
	afterEach(() => {
		__animationSchedulerTestHooks.reset();
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	it("does not run callbacks while the output sink is congested", () => {
		vi.useFakeTimers();
		__setAnimationCongestionProbe(() => true);
		const tick = vi.fn();
		registerAnimationCallback(tick, 16);

		vi.advanceTimersByTime(16 * 10);

		expect(tick).not.toHaveBeenCalled();
		expect(__animationSchedulerTestHooks.getSkippedTickCount()).toBe(10);
	});

	it("resumes on the next tick once the sink drains", () => {
		vi.useFakeTimers();
		let congested = true;
		__setAnimationCongestionProbe(() => congested);
		const tick = vi.fn();
		registerAnimationCallback(tick, 16);

		vi.advanceTimersByTime(16 * 5);
		expect(tick).not.toHaveBeenCalled();

		congested = false;
		vi.advanceTimersByTime(16 * 5);

		// Skipped frames are dropped, not replayed: the backlog is the thing being
		// avoided, so only the ticks that fell in the healthy window may run.
		expect(tick).toHaveBeenCalledTimes(5);
	});

	it("never skips on a healthy terminal", () => {
		vi.useFakeTimers();
		__setAnimationCongestionProbe(() => false);
		const tick = vi.fn();
		registerAnimationCallback(tick, 16);

		vi.advanceTimersByTime(16 * 10);

		expect(tick).toHaveBeenCalledTimes(10);
		expect(__animationSchedulerTestHooks.getSkippedTickCount()).toBe(0);
	});

	it("suppresses every registrant on a congested tick, not just one", () => {
		vi.useFakeTimers();
		let congested = false;
		__setAnimationCongestionProbe(() => congested);
		const fast = vi.fn();
		const slow = vi.fn();
		registerAnimationCallback(fast, 16);
		registerAnimationCallback(slow, 16);

		vi.advanceTimersByTime(16);
		expect(fast).toHaveBeenCalledTimes(1);
		expect(slow).toHaveBeenCalledTimes(1);

		congested = true;
		vi.advanceTimersByTime(16 * 4);

		// One sink, one decision: a partially-updated frame would be worse than a
		// dropped one, so registrants sharing a bucket move together.
		expect(fast).toHaveBeenCalledTimes(1);
		expect(slow).toHaveBeenCalledTimes(1);
	});

	it("treats an unmeasurable sink as healthy rather than stalling animation", () => {
		vi.useFakeTimers();
		// No probe override: falls back to reading process.stdout.writableLength,
		// which is 0 or undefined in this harness. A missing measurement must not
		// be read as congestion, or animation would stop wherever the runtime does
		// not expose the counter.
		const tick = vi.fn();
		registerAnimationCallback(tick, 16);

		vi.advanceTimersByTime(16 * 3);

		expect(tick).toHaveBeenCalledTimes(3);
	});
});
