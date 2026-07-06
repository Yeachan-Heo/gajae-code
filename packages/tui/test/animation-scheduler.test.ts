import { afterEach, describe, expect, it, vi } from "bun:test";
import { __animationSchedulerTestHooks } from "@gajae-code/tui";
import { Loader } from "@gajae-code/tui/components/loader";
import type { TUI } from "@gajae-code/tui/tui";

describe("shared animation scheduler", () => {
	afterEach(() => {
		__animationSchedulerTestHooks.reset();
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

	it("recomputes declared time-dependent loaders at 16ms and default loaders at 80ms", () => {
		vi.useFakeTimers();
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
			expect(__animationSchedulerTestHooks.getActiveTimerCount(16)).toBe(1);
			const initialDefaultRequests = defaultRequests.mock.calls.length;
			const initialAnimatedRequests = animatedRequests.mock.calls.length;

			for (let i = 0; i < 4; i++) {
				tick += 1;
				vi.advanceTimersByTime(16);
			}

			expect(defaultRequests.mock.calls.length).toBe(initialDefaultRequests);
			expect(animatedRequests.mock.calls.length).toBe(initialAnimatedRequests + 4);

			tick += 1;
			vi.advanceTimersByTime(16);

			expect(defaultRequests.mock.calls.length).toBe(initialDefaultRequests + 1);
			expect(animatedRequests.mock.calls.length).toBe(initialAnimatedRequests + 5);
		} finally {
			defaultLoader.stop();
			animatedLoader.stop();
		}
	});
});
