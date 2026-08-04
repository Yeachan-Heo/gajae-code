import { afterEach, describe, expect, it, vi } from "bun:test";
import { TUI } from "@gajae-code/tui";
import { __loaderPerfCounters, Loader } from "@gajae-code/tui/components/loader";
import { visibleWidth } from "@gajae-code/tui/utils";
import { __animationSchedulerTestHooks } from "../src/animation-scheduler";
import { VirtualTerminal } from "./virtual-terminal";

afterEach(() => {
	vi.useRealTimers();
	__animationSchedulerTestHooks.reset();
	__loaderPerfCounters.reset();
});
describe("Loader component", () => {
	it("clamps rendered lines to terminal width", async () => {
		const term = new VirtualTerminal(1, 4);
		const tui = new TUI(term);
		const loader = new Loader(
			tui,
			text => text,
			text => text,
			"Checking",
			["⠸"],
		);
		tui.addChild(loader);

		tui.start();
		await Bun.sleep(0);
		await term.flush();

		for (const line of term.getViewport()) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(1);
		}

		loader.stop();
		tui.stop();
	});

	it("unrefs its animation interval so it does not keep the event loop alive", () => {
		const term = new VirtualTerminal(20, 4);
		const tui = new TUI(term);
		let unrefCalled = false;
		const realSetInterval = globalThis.setInterval;
		// Shim setInterval to observe that the loader unrefs the timer it creates.
		globalThis.setInterval = ((
			handler: (...handlerArgs: unknown[]) => void,
			timeout?: number,
			...args: unknown[]
		) => {
			const timer = realSetInterval(handler, timeout, ...args);
			const realUnref = timer.unref?.bind(timer);
			timer.unref = () => {
				unrefCalled = true;
				return realUnref ? realUnref() : timer;
			};
			return timer;
		}) as typeof globalThis.setInterval;
		try {
			const loader = new Loader(
				tui,
				text => text,
				text => text,
				"Working",
				["|"],
			);
			loader.stop();
		} finally {
			globalThis.setInterval = realSetInterval;
		}
		tui.stop();
		expect(unrefCalled).toBe(true);
	});

	it("suppresses redundant render requests when its rendered text does not change", () => {
		const term = new VirtualTerminal(40, 4);
		const tui = new TUI(term);
		let loaderRequests = 0;
		const realRequest = tui.requestRender.bind(tui);
		tui.requestRender = ((force?: boolean, source?: string) => {
			if (source === "loader") loaderRequests += 1;
			return realRequest(force, source);
		}) as typeof tui.requestRender;

		// Construction performs the initial display -> exactly one loader request.
		const loader = new Loader(
			tui,
			text => text,
			text => text,
			"Working",
			["|"],
		);
		expect(loaderRequests).toBe(1);

		// Same message + single static frame -> identical text -> no new request.
		loader.setMessage("Working");
		expect(loaderRequests).toBe(1);

		// Changed message -> new text -> one request.
		loader.setMessage("Still working");
		expect(loaderRequests).toBe(2);

		loader.stop();
		tui.stop();
	});

	it("still requests a render when a time-dependent colorizer changes the composed text", () => {
		const term = new VirtualTerminal(40, 4);
		const tui = new TUI(term);
		let loaderRequests = 0;
		const realRequest = tui.requestRender.bind(tui);
		tui.requestRender = ((force?: boolean, source?: string) => {
			if (source === "loader") loaderRequests += 1;
			return realRequest(force, source);
		}) as typeof tui.requestRender;

		let tick = 0;
		const animatedColorizer = (text: string) => `${text}#${tick}`;
		const loader = new Loader(tui, t => t, animatedColorizer, "Working", ["|"]);
		expect(loaderRequests).toBe(1); // initial "| Working#0"

		// Same message, but the time-dependent colorizer now composes new text.
		tick = 1;
		loader.setMessage("Working");
		expect(loaderRequests).toBe(2); // "| Working#1" differs -> still repaints

		loader.stop();
		tui.stop();
	});

	it("bounds time-dependent animation callbacks and render requests to the 80ms cadence", () => {
		vi.useFakeTimers();
		const term = new VirtualTerminal(40, 4);
		const tui = new TUI(term);
		let colorTick = 0;
		const loader = new Loader(
			tui,
			text => text,
			text => `${text}#${colorTick++}`,
			"Working",
			["|"],
			{
				timeDependentColor: true,
			},
		);

		expect(__loaderPerfCounters.renderRequests).toBe(1);
		vi.advanceTimersByTime(1000);

		expect(__loaderPerfCounters.callbackInvocations).toBeLessThanOrEqual(13);
		expect(__loaderPerfCounters.renderRequests).toBeLessThanOrEqual(14);

		const beforeMessage = __loaderPerfCounters.renderRequests;
		loader.setMessage("Immediate");
		expect(__loaderPerfCounters.renderRequests).toBe(beforeMessage + 1);

		loader.dispose();
		const callbacksAfterDispose = __loaderPerfCounters.callbackInvocations;
		const requestsAfterDispose = __loaderPerfCounters.renderRequests;
		vi.advanceTimersByTime(1000);
		expect(__loaderPerfCounters.callbackInvocations).toBe(callbacksAfterDispose);
		expect(__loaderPerfCounters.renderRequests).toBe(requestsAfterDispose);
		expect(__loaderPerfCounters.liveIntervals).toBe(0);
		tui.stop();
	});
	it("deduplicates unchanged output while callbacks remain bounded", () => {
		vi.useFakeTimers();
		const tui = new TUI(new VirtualTerminal(40, 4));
		const loader = new Loader(
			tui,
			text => text,
			text => text,
			"Working",
			["|"],
		);

		expect(__loaderPerfCounters.renderRequests).toBe(1);
		vi.advanceTimersByTime(1000);

		expect(__loaderPerfCounters.callbackInvocations).toBeLessThanOrEqual(13);
		expect(__loaderPerfCounters.renderRequests).toBe(1);

		loader.dispose();
		tui.stop();
	});
});
