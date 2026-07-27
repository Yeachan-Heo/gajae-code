import { describe, expect, test } from "bun:test";
import { isSgrMouseSequence, StdinBuffer } from "../src/stdin-buffer";
import { type Component, DEFAULT_WHEEL_LINES, parseSgrMouseEvent, TUI } from "../src/tui";
import { VirtualTerminal } from "./virtual-terminal";

describe("SGR mouse input", () => {
	test("parses wheel and left-click reports", () => {
		expect(parseSgrMouseEvent("\x1b[<64;12;9M")).toEqual({ kind: "wheel", direction: -1, x: 12, y: 9 });
		expect(parseSgrMouseEvent("\x1b[<65;12;9M")).toEqual({ kind: "wheel", direction: 1, x: 12, y: 9 });
		expect(parseSgrMouseEvent("\x1b[<0;3;4M")).toEqual({ kind: "click", button: 0, x: 3, y: 4 });
	});

	test("parses left-button drag and release reports", () => {
		expect(parseSgrMouseEvent("\x1b[<32;3;4M")).toEqual({ kind: "drag", button: 0, x: 3, y: 4 });
		expect(parseSgrMouseEvent("\x1b[<0;3;4m")).toEqual({ kind: "release", button: 0, x: 3, y: 4 });
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
	test("highlights a drag selection and copies the selected terminal text on release", async () => {
		const terminal = new VirtualTerminal(20, 3);
		const copied: string[] = [];
		const tui = new TUI(terminal, undefined, {
			enableMouse: true,
			copySelection: text => {
				copied.push(text);
			},
		});
		tui.addChild({
			render: () => ["alpha", "bravo", "tail "],
			invalidate: () => {},
		});
		tui.start();
		await terminal.waitForRender();
		terminal.clearWriteLog();

		terminal.sendInput("\x1b[<0;2;1M");
		terminal.sendInput("\x1b[<32;6;2M");
		await terminal.waitForRender();
		expect(terminal.getWriteLog().join("")).toContain("\x1b[7m");

		terminal.sendInput("\x1b[<0;6;2m");
		await terminal.waitForRender();
		expect(copied).toEqual(["lpha\nbravo"]);
		terminal.sendInput("\x1b[<0;5;3M");
		terminal.sendInput("\x1b[<32;5;3M");
		terminal.sendInput("\x1b[<0;5;3m");
		await terminal.waitForRender();
		expect(copied).toEqual(["lpha\nbravo", " "]);
		tui.stop();
	});
	test("snaps forward and reverse selections to wide graphemes and strips terminal controls", async () => {
		for (const [pressX, releaseX] of [
			[2, 3],
			[3, 2],
		]) {
			const terminal = new VirtualTerminal(20, 1);
			const copied: string[] = [];
			const tui = new TUI(terminal, undefined, {
				enableMouse: true,
				copySelection: text => {
					copied.push(text);
				},
			});
			tui.addChild({
				render: () => ["A\x1b]8;;https://example.test\x07\x1b[31m表\x1b[0m\x1b]8;;\x07B"],
				invalidate: () => {},
			});
			tui.start();
			await terminal.waitForRender();

			terminal.sendInput(`\x1b[<0;${pressX};1M`);
			terminal.sendInput(`\x1b[<32;${releaseX};1M`);
			terminal.sendInput(`\x1b[<0;${releaseX};1m`);
			await terminal.waitForRender();

			expect(copied).toEqual(["表"]);
			expect(copied[0]).not.toContain("\x1b");
			tui.stop();
		}
	});
	test("strips ST terminal strings and reapplies selection after embedded SGR resets", async () => {
		const terminal = new VirtualTerminal(30, 1);
		const copied: string[] = [];
		const tui = new TUI(terminal, undefined, {
			enableMouse: true,
			copySelection: text => {
				copied.push(text);
			},
		});
		tui.addChild({
			render: () => [
				"A\x1b]8;;https://example.test\x1b\\\x1bPignored-dcs\x1b\\\x1b^ignored-pm\x1b\\\x1b_ignored-apc\x1b\\\x1bXignored-sos\x1b\\\x1b[31m表\x1b[0m\x1b]8;;\x1b\\B",
			],
			invalidate: () => {},
		});
		tui.start();
		await terminal.waitForRender();
		terminal.clearWriteLog();

		terminal.sendInput("\x1b[<0;2;1M");
		terminal.sendInput("\x1b[<32;3;1M");
		await terminal.waitForRender();
		expect(terminal.getWriteLog().join("")).toContain("\x1b[0m\x1b[7m");
		terminal.sendInput("\x1b[<0;3;1m");
		await terminal.waitForRender();

		expect(copied).toEqual(["表"]);
		expect(copied[0]).not.toContain("\x1b");
		tui.stop();
	});
	test("does not start or extend manual selection into pinned chrome", async () => {
		const terminal = new VirtualTerminal(30, 5);
		const copied: string[] = [];
		const tui = new TUI(terminal, undefined, {
			enableMouse: true,
			copySelection: text => {
				copied.push(text);
			},
		});
		tui.addChild({
			render: () => Array.from({ length: 10 }, (_value, index) => `line-${index}`),
			invalidate: () => {},
		});
		const status: Component = { render: () => ["status"], invalidate: () => {} };
		const editor: Component = { render: () => ["editor"], invalidate: () => {} };
		tui.addChild(status);
		tui.addChild(editor);
		tui.setBottomPinnedComponent(status);
		tui.start();
		await terminal.waitForRender();
		expect(tui.scrollViewportPages(-1)).toBe(true);
		await terminal.flush();

		terminal.sendInput("\x1b[<0;1;4M");
		terminal.sendInput("\x1b[<32;3;5M");
		terminal.sendInput("\x1b[<0;3;5m");
		await terminal.waitForRender();
		expect(copied).toEqual([]);

		terminal.clearWriteLog();
		terminal.sendInput("\x1b[<0;1;4M");
		terminal.sendInput("\x1b[<32;3;2M");
		terminal.sendInput("\x1b[<0;3;2m");
		await terminal.waitForRender();
		expect(terminal.getWriteLog().join("")).not.toContain("\x1b[7m");
		expect(copied).toEqual([]);

		terminal.sendInput("\x1b[<0;1;1M");
		terminal.sendInput("\x1b[<32;3;2M");
		terminal.sendInput("\x1b[<32;3;5M");
		terminal.sendInput("\x1b[<0;3;5m");
		await terminal.waitForRender();
		expect(copied).toHaveLength(1);
		expect(copied[0]).not.toContain("status");
		expect(copied[0]).not.toContain("editor");
		tui.stop();
	});
	test("wheel notches scroll a few lines instead of a full page", async () => {
		const terminal = new VirtualTerminal(30, 5);
		const tui = new TUI(terminal, undefined, { enableMouse: true });
		tui.addChild({
			render: () => Array.from({ length: 12 }, (_value, index) => `line-${index}`),
			invalidate: () => {},
		});
		tui.start();
		await terminal.waitForRender();
		expect(terminal.getViewport().map(line => line.trimEnd())).toEqual([
			"line-7",
			"line-8",
			"line-9",
			"line-10",
			"line-11",
		]);

		terminal.sendInput("\x1b[<64;10;2M");
		await terminal.flush();
		expect(terminal.getViewport().map(line => line.trimEnd())).toEqual([
			"line-4",
			"line-5",
			"line-6",
			"line-7",
			"line-8",
		]);
		expect(DEFAULT_WHEEL_LINES).toBe(3);
		tui.stop();
	});
});
