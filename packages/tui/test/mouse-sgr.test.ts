import { describe, expect, test } from "bun:test";
import { isSgrMouseSequence, StdinBuffer } from "../src/stdin-buffer";
import { type Component, parseSgrMouseEvent, TUI } from "../src/tui";

describe("SGR mouse input", () => {
	test("parses wheel and left-click reports", () => {
		expect(parseSgrMouseEvent("\x1b[<64;12;9M")).toEqual({ kind: "wheel", direction: -1, x: 12, y: 9 });
		expect(parseSgrMouseEvent("\x1b[<65;12;9M")).toEqual({ kind: "wheel", direction: 1, x: 12, y: 9 });
		expect(parseSgrMouseEvent("\x1b[<0;3;4M")).toEqual({ kind: "click", button: 0, x: 3, y: 4 });
	});

	test("ignores drag and release reports", () => {
		expect(parseSgrMouseEvent("\x1b[<32;3;4M")).toBeUndefined();
		expect(parseSgrMouseEvent("\x1b[<0;3;4m")).toBeUndefined();
	});

	test("keeps complete SGR reports as a single control sequence", () => {
		const input = new StdinBuffer();
		const sequences: string[] = [];
		input.on("data", sequence => sequences.push(sequence));
		input.process("\x1b[<64;12;9M");
		expect(sequences).toEqual(["\x1b[<64;12;9M"]);
		expect(isSgrMouseSequence(sequences[0]!)).toBe(true);
	});
	test("quarantines delayed incomplete and malformed SGR reports", async () => {
		const input = new StdinBuffer({ timeout: 5 });
		const sequences: string[] = [];
		input.on("data", sequence => sequences.push(sequence));
		input.process("\x1b[<0;4");
		await Bun.sleep(15);
		input.process("\x1b[<-1;4;5M");
		await Bun.sleep(15);
		expect(sequences).toEqual([]);
	});

	test("does not dispatch malformed or out-of-bounds SGR reports", () => {
		let input: ((data: string) => void) | undefined;
		const terminal = {
			columns: 80,
			rows: 24,
			available: true,
			kittyProtocolActive: false,
			start(handler: (data: string) => void) {
				input = handler;
			},
			stop() {},
			drainInput: async () => {},
			write() {},
			moveBy() {},
			hideCursor() {},
			showCursor() {},
			clearLine() {},
			clearFromCursor() {},
			clearScreen() {},
			setTitle() {},
			setProgress() {},
		} as unknown as import("../src/terminal").Terminal;
		const tui = new TUI(terminal);
		const inputs: string[] = [];
		const clicks: unknown[] = [];
		tui.setFocus({
			render: () => [],
			invalidate: () => {},
			handleInput: data => inputs.push(data),
			handleMouse: event => clicks.push(event),
		});
		tui.start();
		input!("\x1b[<-1;4;5M");
		input!("\x1b[<0;999999;5M");
		expect(inputs).toEqual([]);
		expect(clicks).toEqual([]);
	});

	test("dispatches only inside a bottom-centered overlay using last-painted local coordinates", async () => {
		let input: ((data: string) => void) | undefined;
		const terminal = {
			columns: 80,
			rows: 24,
			available: true,
			kittyProtocolActive: false,
			start(handler: (data: string) => void) {
				input = handler;
			},
			stop() {},
			drainInput: async () => {},
			write() {},
			moveBy() {},
			hideCursor() {},
			showCursor() {},
			clearLine() {},
			clearFromCursor() {},
			clearScreen() {},
			setTitle() {},
			setProgress() {},
		} as unknown as import("../src/terminal").Terminal;
		const tui = new TUI(terminal);
		const clicks: unknown[] = [];
		const overlay: Component = {
			render: () => ["one", "two", "three"],

			invalidate: () => {},
			handleMouse: event => clicks.push(event),
		};
		tui.showOverlay(overlay, { anchor: "bottom-center", width: 20 });
		tui.start();
		await Bun.sleep(1);

		input!("\x1b[<0;31;22M");
		input!("\x1b[<0;31;1M");
		expect(clicks).toEqual([{ kind: "click", button: 0, x: 31, y: 22, localX: 1, localY: 1 }]);
	});

	test("does not rerender an overlay to hit-test a click", async () => {
		let input: ((data: string) => void) | undefined;
		const terminal = {
			columns: 80,
			rows: 24,
			available: true,
			kittyProtocolActive: false,
			start(handler: (data: string) => void) {
				input = handler;
			},
			stop() {},
			drainInput: async () => {},
			write() {},
			moveBy() {},
			hideCursor() {},
			showCursor() {},
			clearLine() {},
			clearFromCursor() {},
			clearScreen() {},
			setTitle() {},
			setProgress() {},
		} as unknown as import("../src/terminal").Terminal;
		const tui = new TUI(terminal);
		let renders = 0;
		const clicks: unknown[] = [];
		tui.showOverlay(
			{
				render: () => {
					renders++;
					return ["overlay"];
				},
				invalidate: () => {},
				handleMouse: event => clicks.push(event),
			},
			{ anchor: "bottom-center", width: 20 },
		);
		tui.start();
		await Bun.sleep(1);
		const rendersBeforeClick = renders;
		input!("\x1b[<0;31;24M");
		expect(clicks).toEqual([{ kind: "click", button: 0, x: 31, y: 24, localX: 1, localY: 1 }]);
		expect(renders).toBe(rendersBeforeClick);
	});
	test("dispatches clicks to the focused component without forwarding mouse text", () => {
		let input: ((data: string) => void) | undefined;
		const terminal = {
			columns: 80,
			rows: 24,
			available: true,
			kittyProtocolActive: false,
			start(handler: (data: string) => void) {
				input = handler;
			},
			stop() {},
			drainInput: async () => {},
			write() {},
			moveBy() {},
			hideCursor() {},
			showCursor() {},
			clearLine() {},
			clearFromCursor() {},
			clearScreen() {},
			setTitle() {},
			setProgress() {},
		} as unknown as import("../src/terminal").Terminal;
		const tui = new TUI(terminal);
		const clicks: unknown[] = [];
		const component: Component = {
			render: () => [],
			invalidate: () => {},
			handleInput: () => {
				throw new Error("mouse reached editor");
			},
			handleMouse: event => clicks.push(event),
		};
		tui.setFocus(component);
		tui.start();
		input!("\x1b[<0;4;5M");
		expect(clicks).toEqual([{ kind: "click", button: 0, x: 4, y: 5 }]);
	});
});
