import { afterEach, describe, expect, it, vi } from "bun:test";
import { __animationSchedulerTestHooks } from "@gajae-code/tui";
import { registerAnimationCallback } from "@gajae-code/tui/animation-scheduler";
import { Loader } from "@gajae-code/tui/components/loader";
import type { TUI } from "@gajae-code/tui/tui";

function makeUi() {
	return { requestRender: vi.fn() } as unknown as TUI & { requestRender: ReturnType<typeof vi.fn> };
}

describe("G010 shared animation scheduler red-team", () => {
	afterEach(() => {
		__animationSchedulerTestHooks.reset();
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	it("SINGLE-TIMER: uses one active timer per cadence bucket and stops each empty bucket", () => {
		vi.useFakeTimers();
		const ui = makeUi();
		const defaults = Array.from(
			{ length: 20 },
			(_, i) =>
				new Loader(
					ui,
					text => text,
					text => text,
					`default-${i}`,
					["-", "+"],
				),
		);
		const animated = new Loader(
			ui,
			text => text,
			text => text,
			"animated",
			["-", "+"],
			{
				timeDependentColor: true,
			},
		);

		expect(__animationSchedulerTestHooks.getRegistrantCount(80)).toBe(20);
		expect(__animationSchedulerTestHooks.getActiveTimerCount()).toBe(2);
		expect(__animationSchedulerTestHooks.getActiveTimerCount(80)).toBe(1);
		expect(__animationSchedulerTestHooks.getActiveTimerCount(16)).toBe(1);

		for (const loader of defaults) loader.stop();

		expect(__animationSchedulerTestHooks.getRegistrantCount(80)).toBe(0);
		expect(__animationSchedulerTestHooks.getActiveTimerCount(80)).toBe(0);
		expect(__animationSchedulerTestHooks.getRegistrantCount(16)).toBe(1);
		expect(__animationSchedulerTestHooks.getActiveTimerCount()).toBe(1);

		animated.stop();

		expect(__animationSchedulerTestHooks.getRegistrantCount()).toBe(0);
		expect(__animationSchedulerTestHooks.getActiveTimerCount()).toBe(0);
	});

	it("LEAK-FREE-DISPOSE: repeated create/dispose cycles leave no registrants or timers", () => {
		vi.useFakeTimers();
		for (let i = 0; i < 100; i++) {
			const loader = new Loader(
				makeUi(),
				text => text,
				text => text,
				`cycle-${i}`,
				["-", "+"],
				{
					timeDependentColor: i % 2 === 0,
				},
			);
			loader.dispose();
			expect(__animationSchedulerTestHooks.getRegistrantCount()).toBe(0);
			expect(__animationSchedulerTestHooks.getActiveTimerCount()).toBe(0);
		}
	});

	it("DOUBLE-STOP: stop/dispose are idempotent and do not underflow registrations", () => {
		vi.useFakeTimers();
		const loader = new Loader(
			makeUi(),
			text => text,
			text => text,
			"double",
			["-", "+"],
		);
		expect(__animationSchedulerTestHooks.getRegistrantCount(80)).toBe(1);

		expect(() => {
			loader.stop();
			loader.stop();
			loader.dispose();
			loader.dispose();
		}).not.toThrow();

		expect(__animationSchedulerTestHooks.getRegistrantCount()).toBe(0);
		expect(__animationSchedulerTestHooks.getActiveTimerCount()).toBe(0);
	});

	it("CADENCE: default repaints at 80ms, time-dependent at 16ms, both spinner frames advance only every 80ms", () => {
		vi.useFakeTimers();
		const defaultUi = makeUi();
		const animatedUi = makeUi();
		const defaultFrames: string[] = [];
		const animatedFrames: string[] = [];
		const defaultLoader = new Loader(
			defaultUi,
			frame => {
				defaultFrames.push(frame);
				return frame;
			},
			text => text,
			"default",
			["A", "B", "C"],
		);
		const animatedLoader = new Loader(
			animatedUi,
			frame => {
				animatedFrames.push(frame);
				return frame;
			},
			text => `${text}-${performance.now()}`,
			"animated",
			["A", "B", "C"],
			{ timeDependentColor: true },
		);
		const initialDefaultRequests = defaultUi.requestRender.mock.calls.length;
		const initialAnimatedRequests = animatedUi.requestRender.mock.calls.length;

		vi.advanceTimersByTime(16);
		expect(defaultUi.requestRender.mock.calls.length).toBe(initialDefaultRequests);
		expect(animatedUi.requestRender.mock.calls.length).toBe(initialAnimatedRequests + 1);
		expect(defaultFrames.at(-1)).toBe("A");
		expect(animatedFrames.at(-1)).toBe("A");

		vi.advanceTimersByTime(64);
		expect(defaultUi.requestRender.mock.calls.length).toBe(initialDefaultRequests + 1);
		expect(animatedUi.requestRender.mock.calls.length).toBe(initialAnimatedRequests + 5);
		expect(defaultFrames.at(-1)).toBe("B");
		expect(animatedFrames.at(-1)).toBe("B");

		vi.advanceTimersByTime(16);
		expect(defaultUi.requestRender.mock.calls.length).toBe(initialDefaultRequests + 1);
		expect(animatedUi.requestRender.mock.calls.length).toBe(initialAnimatedRequests + 6);
		expect(defaultFrames.at(-1)).toBe("B");
		expect(animatedFrames.at(-1)).toBe("B");

		defaultLoader.stop();
		animatedLoader.stop();
	});

	it("THROW-ISOLATION: one throwing callback does not stop the bucket or block other registrants", () => {
		vi.useFakeTimers();
		let healthyCalls = 0;
		const throwing = registerAnimationCallback(() => {
			throw new Error("red-team scheduler throw");
		}, 80);
		const healthy = registerAnimationCallback(() => {
			healthyCalls += 1;
		}, 80);

		expect(() => vi.advanceTimersByTime(80)).not.toThrow();
		expect(healthyCalls).toBe(1);
		expect(__animationSchedulerTestHooks.getActiveTimerCount(80)).toBe(1);

		throwing.unregister();
		vi.advanceTimersByTime(80);
		expect(healthyCalls).toBe(2);
		expect(__animationSchedulerTestHooks.getActiveTimerCount(80)).toBe(1);

		healthy.unregister();
		expect(__animationSchedulerTestHooks.getActiveTimerCount()).toBe(0);
	});

	it("REENTRANT: callback registration and unregistration during a tick do not corrupt invocation counts", () => {
		vi.useFakeTimers();
		const calls: string[] = [];
		let child: ReturnType<typeof registerAnimationCallback> | undefined;
		const parent = registerAnimationCallback(() => {
			calls.push("parent");
			if (!child) {
				child = registerAnimationCallback(() => calls.push("child"), 80);
			}
		}, 80);
		const sibling = registerAnimationCallback(() => {
			calls.push("sibling");
			child?.unregister();
			child = undefined;
		}, 80);

		vi.advanceTimersByTime(80);
		expect(calls).toEqual(["parent", "sibling"]);
		expect(__animationSchedulerTestHooks.getRegistrantCount(80)).toBe(2);

		calls.length = 0;
		vi.advanceTimersByTime(80);
		expect(calls).toEqual(["parent", "sibling"]);
		expect(__animationSchedulerTestHooks.getRegistrantCount(80)).toBe(2);

		parent.unregister();
		sibling.unregister();
		expect(__animationSchedulerTestHooks.getRegistrantCount()).toBe(0);
		expect(__animationSchedulerTestHooks.getActiveTimerCount()).toBe(0);
	});

	it("UNREF: started timers are unref'd", () => {
		vi.useFakeTimers();
		const fakeSetInterval = globalThis.setInterval;
		const handles: Array<{ unref?: ReturnType<typeof vi.fn> }> = [];
		vi.spyOn(globalThis, "setInterval").mockImplementation(((...args: Parameters<typeof setInterval>) => {
			const handle = fakeSetInterval(...args);
			if (handle && typeof handle === "object") {
				const timer = handle as { unref?: () => unknown };
				const originalUnref = timer.unref?.bind(timer);
				timer.unref = vi.fn(() => originalUnref?.());
				handles.push(timer as { unref?: ReturnType<typeof vi.fn> });
			}
			return handle;
		}) as typeof setInterval);

		const defaultLoader = new Loader(
			makeUi(),
			text => text,
			text => text,
			"default",
			["-", "+"],
		);
		const animatedLoader = new Loader(
			makeUi(),
			text => text,
			text => text,
			"animated",
			["-", "+"],
			{
				timeDependentColor: true,
			},
		);

		expect(handles).toHaveLength(2);
		for (const handle of handles) expect(handle.unref).toHaveBeenCalledTimes(1);

		defaultLoader.dispose();
		animatedLoader.dispose();
		expect(__animationSchedulerTestHooks.getActiveTimerCount()).toBe(0);
	});
});
