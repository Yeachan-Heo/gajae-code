import { describe, expect, test } from "bun:test";
import { StdinBuffer } from "../src/stdin-buffer";
import { type Component, TUI } from "../src/tui";
import { VirtualTerminal } from "./virtual-terminal";

function startHarness(enableMouse = false, mouseSettings?: boolean[]) {
	const terminal = new VirtualTerminal(80, 12) as VirtualTerminal & { setMouseEnabled?: (enabled: boolean) => void };
	if (mouseSettings) terminal.setMouseEnabled = enabled => mouseSettings.push(enabled);
	const tui = new TUI(terminal, undefined, { enableMouse });
	const inputs: string[] = [];
	const clicks: unknown[] = [];
	const component: Component = {
		render: () => Array.from({ length: 40 }, (_, index) => `line ${index}`),
		invalidate: () => {},
		handleInput: data => inputs.push(data),
		handleMouse: event => clicks.push(event),
	};
	tui.setFocus(component);
	tui.start();
	return { terminal, tui, inputs, clicks };
}

describe("G006 WS6 red team", () => {
	test("disabled mouse does not opt the terminal in and valid reports do not leak as editor text", async () => {
		const mouseSettings: boolean[] = [];
		const h = startHarness(false, mouseSettings);
		expect(mouseSettings).toEqual([false]);

		const buffer = new StdinBuffer({ timeout: 5 });
		buffer.on("data", sequence => h.terminal.sendInput(sequence));
		buffer.process("\x1b[<0;4");
		buffer.process(";5M");
		expect(h.clicks).toEqual([{ kind: "click", button: 0, x: 4, y: 5 }]);
		expect(h.inputs).toEqual([]);
		await h.terminal.waitForRender();
		h.tui.stop();
	});

	test("wheel storms coalesce rendering and boundary scrolling is safe", async () => {
		const h = startHarness(true);
		await h.terminal.waitForRender();
		h.terminal.clearWriteLog();
		for (let index = 0; index < 100; index++) h.terminal.sendInput("\x1b[<64;1;1M");
		await h.terminal.waitForRender();
		// A storm produces one scheduled render rather than one render per input.
		expect(h.terminal.getWriteLog().length).toBeLessThan(20);
		expect(() => h.tui.scrollViewportPages(-1)).not.toThrow();
		for (let index = 0; index < 10; index++) h.tui.scrollViewportPages(1);
		expect(() => h.tui.scrollViewportPages(1)).not.toThrow();
		h.tui.stop();
	});

	test("quarantines malformed and incomplete SGR reports", async () => {
		const h = startHarness();
		const buffer = new StdinBuffer({ timeout: 5 });
		buffer.on("data", sequence => h.terminal.sendInput(sequence));
		buffer.process("\x1b[<-1;4;5M");
		buffer.process("\x1b[<0;4;5");
		await new Promise(resolve => setTimeout(resolve, 15));
		expect(h.inputs).toEqual([]);
		expect(h.clicks).toEqual([]);
		h.tui.stop();

		const huge = startHarness();
		huge.terminal.sendInput("\x1b[<0;999999999999999999999;5M");
		expect(huge.inputs).toEqual([]);
		expect(huge.clicks).toEqual([]);
		huge.tui.stop();
	});
});
