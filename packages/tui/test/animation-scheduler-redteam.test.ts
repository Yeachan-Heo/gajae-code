import { afterEach, describe, expect, it, vi } from "bun:test";
import { __animationSchedulerTestHooks } from "@gajae-code/tui";
import { registerAnimationCallback } from "@gajae-code/tui/animation-scheduler";
import { Loader } from "@gajae-code/tui/components/loader";
import type { TUI } from "@gajae-code/tui/tui";

function makeUi() {
	return { requestRender: vi.fn() } as unknown as TUI & { requestRender: ReturnType<typeof vi.fn> };
}

const TERMINAL_TRANSPORT_ENV_KEYS = [
	"SSH_CONNECTION",
	"SSH_CLIENT",
	"SSH_TTY",
	"TMUX",
	"TMUX_PANE",
	"STY",
	"ZELLIJ",
	"GJC_TMUX_LAUNCHED",
	// TERM feeds the multiplexer predicate: tmux-*/screen-* values count as
	// multiplexed and would route animated loaders back to the 80ms bucket.
	"TERM",
] as const;

const pinnedTerminalTransportEnv: Record<string, string | undefined> = {};

// resolveAnimationCadence routes timeDependentColor loaders to the 16ms bucket
// on direct local terminals and the shared 80ms bucket on remote or multiplexed
// ones, so scheduler-count assertions must pin the terminal transport context.
function pinTerminalTransportEnv(overrides: Record<string, string>): void {
	for (const key of TERMINAL_TRANSPORT_ENV_KEYS) {
		if (!(key in pinnedTerminalTransportEnv)) pinnedTerminalTransportEnv[key] = process.env[key];
		delete process.env[key];
	}
	for (const [key, value] of Object.entries(overrides)) process.env[key] = value;
}

function restoreTerminalTransportEnv(): void {
	for (const key of TERMINAL_TRANSPORT_ENV_KEYS) {
		if (!(key in pinnedTerminalTransportEnv)) continue;
		const value = pinnedTerminalTransportEnv[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
		delete pinnedTerminalTransportEnv[key];
	}
}

describe("G010 shared animation scheduler red-team", () => {
	afterEach(() => {
		__animationSchedulerTestHooks.reset();
		restoreTerminalTransportEnv();
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	it("SINGLE-TIMER: uses one active timer per cadence bucket and stops each empty bucket", () => {
		vi.useFakeTimers();
		pinTerminalTransportEnv({ SSH_CONNECTION: "test" });
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

		expect(__animationSchedulerTestHooks.getRegistrantCount(80)).toBe(21);
		expect(__animationSchedulerTestHooks.getActiveTimerCount()).toBe(1);
		expect(__animationSchedulerTestHooks.getActiveTimerCount(80)).toBe(1);
		expect(__animationSchedulerTestHooks.getActiveTimerCount(16)).toBe(0);

		for (const loader of defaults) loader.stop();

		expect(__animationSchedulerTestHooks.getRegistrantCount(80)).toBe(1);
		expect(__animationSchedulerTestHooks.getActiveTimerCount(80)).toBe(1);
		expect(__animationSchedulerTestHooks.getRegistrantCount(16)).toBe(0);
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

	it("CADENCE: default and time-dependent loaders repaint and advance frames only every 80ms", () => {
		vi.useFakeTimers();
		pinTerminalTransportEnv({ SSH_CONNECTION: "test" });
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
		expect(animatedUi.requestRender.mock.calls.length).toBe(initialAnimatedRequests);
		expect(defaultFrames.at(-1)).toBe("A");
		expect(animatedFrames.at(-1)).toBe("A");

		vi.advanceTimersByTime(64);
		expect(defaultUi.requestRender.mock.calls.length).toBe(initialDefaultRequests + 1);
		expect(animatedUi.requestRender.mock.calls.length).toBe(initialAnimatedRequests + 1);
		expect(defaultFrames.at(-1)).toBe("B");
		expect(animatedFrames.at(-1)).toBe("B");

		vi.advanceTimersByTime(16);
		expect(defaultUi.requestRender.mock.calls.length).toBe(initialDefaultRequests + 1);
		expect(animatedUi.requestRender.mock.calls.length).toBe(initialAnimatedRequests + 1);
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
		pinTerminalTransportEnv({ SSH_CONNECTION: "test" });
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

		expect(handles).toHaveLength(1);
		for (const handle of handles) expect(handle.unref).toHaveBeenCalledTimes(1);

		defaultLoader.dispose();
		animatedLoader.dispose();
		expect(__animationSchedulerTestHooks.getActiveTimerCount()).toBe(0);
	});

	it("DIRECT-LOCAL: time-dependent loaders use the 16ms bucket on direct local terminals while spinner cadence stays 80ms", () => {
		vi.useFakeTimers();
		pinTerminalTransportEnv({ TERM: "xterm-256color" });
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

		expect(__animationSchedulerTestHooks.getRegistrantCount(80)).toBe(1);
		expect(__animationSchedulerTestHooks.getRegistrantCount(16)).toBe(1);
		expect(__animationSchedulerTestHooks.getActiveTimerCount()).toBe(2);

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

		defaultLoader.stop();
		animatedLoader.stop();
		expect(__animationSchedulerTestHooks.getActiveTimerCount()).toBe(0);
	});
});
