import { describe, expect, it } from "bun:test";
import { TUI } from "@gajae-code/tui";
import { Loader } from "@gajae-code/tui/components/loader";
import { visibleWidth } from "@gajae-code/tui/utils";
import { VirtualTerminal } from "./virtual-terminal";

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
});
