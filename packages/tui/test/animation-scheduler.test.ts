import { afterEach, describe, expect, it, vi } from "bun:test";
import { __animationSchedulerTestHooks, registerAnimationCallback } from "@gajae-code/tui";
import { Loader } from "@gajae-code/tui/components/loader";
import type { TUI } from "@gajae-code/tui/tui";
import { logger } from "@gajae-code/utils";

describe("shared animation scheduler", () => {
	afterEach(() => {
		__animationSchedulerTestHooks.reset();
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	it("shares one 80ms timer across many default loaders", () => {
		vi.useFakeTimers();
		const requestRender = vi.fn();
		const ui = { requestRender } as unknown as TUI;
		const loaders = Array.from(
			{ length: 12 },
			(_, i) =>
				new Loader(
					ui,
					text => text,
					text => text,
					`loading-${i}`,
					["-", "+"],
				),
		);

		try {
			expect(__animationSchedulerTestHooks.getRegistrantCount(80)).toBe(12);
			expect(__animationSchedulerTestHooks.getActiveTimerCount(80)).toBe(1);
			expect(__animationSchedulerTestHooks.getActiveTimerCount(16)).toBe(0);
			const initialRequests = requestRender.mock.calls.length;

			vi.advanceTimersByTime(80);

			expect(requestRender.mock.calls.length).toBe(initialRequests + loaders.length);
		} finally {
			for (const loader of loaders) loader.stop();
		}

		expect(__animationSchedulerTestHooks.getRegistrantCount(80)).toBe(0);
		expect(__animationSchedulerTestHooks.getActiveTimerCount(80)).toBe(0);
	});

	it("recomputes time-dependent colors at 80ms on constrained terminals", () => {
		vi.useFakeTimers();
		const previousSshConnection = process.env.SSH_CONNECTION;
		process.env.SSH_CONNECTION = "test";
		let tick = 0;
		const defaultRequests = vi.fn();
		const animatedRequests = vi.fn();
		const defaultUi = { requestRender: defaultRequests } as unknown as TUI;
		const animatedUi = { requestRender: animatedRequests } as unknown as TUI;
		const colorizer = (text: string) => `${text}-${tick}`;
		const defaultLoader = new Loader(defaultUi, text => text, colorizer, "default", ["|", "/"]);
		const animatedLoader = new Loader(animatedUi, text => text, colorizer, "animated", ["|", "/"], {
			timeDependentColor: true,
		});

		try {
			expect(__animationSchedulerTestHooks.getActiveTimerCount(80)).toBe(1);
			expect(__animationSchedulerTestHooks.getActiveTimerCount(16)).toBe(0);
			const initialDefaultRequests = defaultRequests.mock.calls.length;
			const initialAnimatedRequests = animatedRequests.mock.calls.length;

			for (let i = 0; i < 4; i++) {
				tick += 1;
				vi.advanceTimersByTime(16);
			}

			expect(defaultRequests.mock.calls.length).toBe(initialDefaultRequests);
			expect(animatedRequests.mock.calls.length).toBe(initialAnimatedRequests);

			tick += 1;
			vi.advanceTimersByTime(16);

			expect(defaultRequests.mock.calls.length).toBe(initialDefaultRequests + 1);
			expect(animatedRequests.mock.calls.length).toBe(initialAnimatedRequests + 1);
		} finally {
			defaultLoader.stop();
			animatedLoader.stop();
			if (previousSshConnection === undefined) delete process.env.SSH_CONNECTION;
			else process.env.SSH_CONNECTION = previousSshConnection;
		}
	});

	it("quarantines a throwing callback once while preserving its sibling", () => {
		vi.useFakeTimers();
		const warning = vi.spyOn(logger, "warn").mockImplementation(() => {});
		let throwingCalls = 0;
		let healthyCalls = 0;
		const error = new Error(`unsafe\x1b[31m\n${"😀".repeat(300)}`);
		error.name = "NamedFailure".repeat(10);
		const throwing = registerAnimationCallback(() => {
			throwingCalls += 1;
			throw error;
		});
		const healthy = registerAnimationCallback(() => {
			healthyCalls += 1;
		});

		vi.advanceTimersByTime(160);

		expect(throwingCalls).toBe(1);
		expect(healthyCalls).toBe(2);
		expect(__animationSchedulerTestHooks.getRegistrantCount(80)).toBe(1);
		expect(__animationSchedulerTestHooks.getFailedCallbackCount()).toBe(1);
		expect(warning).toHaveBeenCalledTimes(1);
		const [warningMessage, diagnostic] = warning.mock.calls[0]!;
		expect(warningMessage).toBe("Animation callback quarantined after throwing");
		expect(diagnostic).toEqual({
			cadence: 80,
			errorName: expect.any(String),
			message: expect.any(String),
		});
		expect(Array.from(String(diagnostic?.errorName))).toHaveLength(64);
		expect(Array.from(String(diagnostic?.message))).toHaveLength(256);
		expect(String(diagnostic?.message)).not.toContain("\x1b");
		expect(String(diagnostic?.message)).not.toContain("\n");
		expect(diagnostic).not.toHaveProperty("stack");
		expect(diagnostic).not.toHaveProperty("source");
		expect(diagnostic).not.toHaveProperty("path");

		throwing.unregister();
		expect(__animationSchedulerTestHooks.getRegistrantCount(80)).toBe(1);
		healthy.unregister();
		expect(__animationSchedulerTestHooks.getActiveTimerCount()).toBe(0);

		__animationSchedulerTestHooks.reset();
		expect(__animationSchedulerTestHooks.getFailedCallbackCount()).toBe(0);
	});

	it("stops the bucket when its final callback throws", () => {
		vi.useFakeTimers();
		vi.spyOn(logger, "warn").mockImplementation(() => {});
		registerAnimationCallback(() => {
			throw new Error("final failure");
		}, 16);

		vi.advanceTimersByTime(16);

		expect(__animationSchedulerTestHooks.getRegistrantCount(16)).toBe(0);
		expect(__animationSchedulerTestHooks.getActiveTimerCount(16)).toBe(0);
		expect(__animationSchedulerTestHooks.getFailedCallbackCount()).toBe(1);
	});
});
