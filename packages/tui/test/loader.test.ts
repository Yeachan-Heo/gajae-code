import { afterEach, describe, expect, it, vi } from "bun:test";
import { Container, Text, TUI } from "@gajae-code/tui";
import { __loaderPerfCounters, Loader } from "@gajae-code/tui/components/loader";
import { visibleWidth } from "@gajae-code/tui/utils";
import { __animationSchedulerTestHooks } from "../src/animation-scheduler";
import { VirtualTerminal } from "./virtual-terminal";

class CountingTranscript extends Container {
	renderCount = 0;

	override renderWithViewportAnchors(width: number) {
		this.renderCount += 1;
		return super.renderWithViewportAnchors(width);
	}
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

function clearTerminalTransportEnv(): () => void {
	const saved = TERMINAL_TRANSPORT_ENV_KEYS.map(key => [key, process.env[key]] as const);
	for (const key of TERMINAL_TRANSPORT_ENV_KEYS) delete process.env[key];
	return () => {
		for (const [key, value] of saved) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	};
}

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

	it("routes layout-scoped updates through requestLayoutRender", () => {
		const term = new VirtualTerminal(40, 4);
		const tui = new TUI(term);
		let fullRequests = 0;
		let layoutRequests = 0;
		const realRequestRender = tui.requestRender.bind(tui);
		const realRequestLayoutRender = tui.requestLayoutRender.bind(tui);
		tui.requestRender = ((force?: boolean, source?: string) => {
			if (source === "loader") fullRequests += 1;
			return realRequestRender(force, source);
		}) as typeof tui.requestRender;
		tui.requestLayoutRender = ((source?: string) => {
			if (source === "loader") layoutRequests += 1;
			return realRequestLayoutRender(source);
		}) as typeof tui.requestLayoutRender;

		const loader = new Loader(
			tui,
			text => text,
			text => text,
			"Working",
			["|"],
			{
				renderScope: "layout",
			},
		);
		expect(fullRequests).toBe(0);
		expect(layoutRequests).toBe(1);

		loader.setMessage("Still working");
		expect(fullRequests).toBe(0);
		expect(layoutRequests).toBe(2);

		loader.stop();
		tui.stop();
	});

	it("reuses an unchanged anchored transcript for a layout-scoped Loader update", async () => {
		const term = new VirtualTerminal(80, 12);
		const tui = new TUI(term, undefined, { widthSettleMs: 0 });
		const transcript = new CountingTranscript();
		for (let index = 0; index < 2_000; index++) transcript.addChild(new Text(`transcript-${index}`, 0, 0));
		const status = new Container();
		const loader = new Loader(
			tui,
			text => text,
			text => text,
			"Working",
			["|"],
			{ renderScope: "layout" },
		);
		status.addChild(loader);
		tui.addChild(transcript);
		tui.addChild(status);
		tui.setViewportAnchorComponent(transcript);
		tui.setViewportOutputSource({ identity: "session:test", revision: 0n });

		try {
			tui.start();
			await term.waitForRender();
			expect(transcript.renderCount).toBe(1);

			TUI.resetRenderCountersForTest();
			loader.setMessage("Still working");
			await term.waitForRender();

			expect(transcript.renderCount).toBe(1);
			expect(term.getViewport().join("\n")).toContain("Still working");
		} finally {
			loader.stop();
			tui.stop();
		}
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

	it("restores the 60fps color cadence for direct local terminals", () => {
		vi.useFakeTimers();
		const restoreEnv = clearTerminalTransportEnv();
		process.env.TERM = "xterm-256color";
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

		try {
			expect(__animationSchedulerTestHooks.getActiveTimerCount(16)).toBe(1);
			expect(__animationSchedulerTestHooks.getActiveTimerCount(80)).toBe(0);
			expect(__loaderPerfCounters.renderRequests).toBe(1);
			vi.advanceTimersByTime(1000);

			expect(__loaderPerfCounters.callbackInvocations).toBe(62);
			expect(__loaderPerfCounters.renderRequests).toBe(63);

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
		} finally {
			loader.dispose();
			tui.stop();
			restoreEnv();
		}
	});

	it("keeps time-dependent loaders at 80ms over SSH", () => {
		vi.useFakeTimers();
		const restoreEnv = clearTerminalTransportEnv();
		process.env.SSH_CONNECTION = "test";
		const tui = new TUI(new VirtualTerminal(40, 4));
		const loader = new Loader(
			tui,
			text => text,
			text => text,
			"Working",
			["|"],
			{
				timeDependentColor: true,
			},
		);

		try {
			expect(__animationSchedulerTestHooks.getActiveTimerCount(16)).toBe(0);
			expect(__animationSchedulerTestHooks.getActiveTimerCount(80)).toBe(1);
		} finally {
			loader.dispose();
			tui.stop();
			restoreEnv();
		}
	});

	it("keeps time-dependent loaders at 80ms under a multiplexer", () => {
		vi.useFakeTimers();
		const restoreEnv = clearTerminalTransportEnv();
		process.env.TMUX = "test";
		const tui = new TUI(new VirtualTerminal(40, 4));
		const loader = new Loader(
			tui,
			text => text,
			text => text,
			"Working",
			["|"],
			{
				timeDependentColor: true,
			},
		);

		try {
			expect(__animationSchedulerTestHooks.getActiveTimerCount(16)).toBe(0);
			expect(__animationSchedulerTestHooks.getActiveTimerCount(80)).toBe(1);
		} finally {
			loader.dispose();
			tui.stop();
			restoreEnv();
		}
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
