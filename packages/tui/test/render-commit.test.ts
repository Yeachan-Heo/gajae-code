import { describe, expect, it } from "bun:test";
import { Text } from "../src/components/text";
import { setTerminalImageProtocol, TERMINAL } from "../src/terminal-capabilities";
import { type Component, CURSOR_MARKER, TUI } from "../src/tui";
import { VirtualTerminal } from "./virtual-terminal";

class SecondWriteFailureTerminal extends VirtualTerminal {
	#writes = 0;

	override write(data: string): void {
		this.#writes += 1;
		if (this.#writes === 2) throw new Error("second renderer write failed");
		super.write(data);
	}
}

class CursorComponent implements Component {
	invalidate(): void {}

	render(): string[] {
		return [`cursor${CURSOR_MARKER}`];
	}
}

describe("generation-scoped render commits", () => {
	it("resolves after the requested generation writes successfully", async () => {
		const terminal = new VirtualTerminal(40, 8);
		const tui = new TUI(terminal);
		tui.start();
		tui.addChild(new Text("resume-progress", 1, 0));

		const generation = tui.requestRenderWithGeneration(false, "test.resume-progress");
		expect(await tui.waitForRenderCommit(generation)).toBe(true);
		expect(terminal.getWriteLog().join(" ")).toContain("resume-progress");

		tui.stop();
	});
	it("commits the shared frame when optional IME reanchoring fails", async () => {
		const previousIme = Bun.env.GJC_TUI_IME_CURSOR;
		const previousImageProtocol = TERMINAL.imageProtocol;
		Bun.env.GJC_TUI_IME_CURSOR = "1";
		setTerminalImageProtocol(null);
		const terminal = new SecondWriteFailureTerminal(40, 8);
		const tui = new TUI(terminal, false);
		tui.addChild(new CursorComponent());

		try {
			tui.start();
			const generation = tui.requestRenderWithGeneration(false, "test.ime-cursor-failure");

			expect(await tui.waitForRenderCommit(generation)).toBe(true);
			expect(tui.terminalAvailable).toBe(false);
		} finally {
			tui.stop();
			setTerminalImageProtocol(previousImageProtocol);
			if (previousIme === undefined) delete Bun.env.GJC_TUI_IME_CURSOR;
			else Bun.env.GJC_TUI_IME_CURSOR = previousIme;
		}
	});
	it("commits the shared frame when optional overlay delivery fails", async () => {
		const previousImageProtocol = TERMINAL.imageProtocol;
		setTerminalImageProtocol(null);
		const terminal = new SecondWriteFailureTerminal(40, 8);
		const tui = new TUI(terminal, true);
		tui.addChild(new Text("overlay-frame", 1, 0));
		tui.setPostRenderEmitter(() => "\x1b[?25l");

		try {
			tui.start();
			const generation = tui.requestRenderWithGeneration(false, "test.overlay-failure");

			expect(await tui.waitForRenderCommit(generation)).toBe(true);
			expect(tui.terminalAvailable).toBe(false);
		} finally {
			tui.stop();
			setTerminalImageProtocol(previousImageProtocol);
		}
	});

	it("fails open immediately after the renderer is stopped", async () => {
		const terminal = new VirtualTerminal(40, 8);
		const tui = new TUI(terminal);
		tui.start();
		tui.stop();

		const generation = tui.requestRenderWithGeneration(false, "test.stopped");
		expect(await tui.waitForRenderCommit(generation)).toBe(false);
	});
});
