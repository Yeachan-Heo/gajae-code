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
		globalThis.setInterval = ((handler: (...handlerArgs: unknown[]) => void, timeout?: number, ...args: unknown[]) => {
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
});
