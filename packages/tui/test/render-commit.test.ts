import { describe, expect, it, vi } from "bun:test";
import { Text } from "../src/components/text";
import { setTerminalImageProtocol, TERMINAL } from "../src/terminal-capabilities";
import { type Component, CURSOR_MARKER, TUI } from "../src/tui";
import { VirtualTerminal } from "./virtual-terminal";

class SecondWriteFailureTerminal extends VirtualTerminal {
	#writes = 0;
	readonly attempts: string[] = [];

	override write(data: string): void {
		this.#writes += 1;
		this.attempts.push(data);
		if (this.#writes === 2) throw new Error("second renderer write failed");
		super.write(data);
	}
}
class FirstWriteFailureTerminal extends VirtualTerminal {
	override write(_data: string): void {
		throw new Error("shared renderer write failed");
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
	it("does not commit a failed shared frame in either framing mode", async () => {
		const previousSync = Bun.env.GJC_TUI_SYNCHRONIZED_OUTPUT;
		try {
			for (const synchronizedOutput of [undefined, "0"]) {
				if (synchronizedOutput === undefined) delete Bun.env.GJC_TUI_SYNCHRONIZED_OUTPUT;
				else Bun.env.GJC_TUI_SYNCHRONIZED_OUTPUT = synchronizedOutput;
				const terminal = new FirstWriteFailureTerminal(40, 8);
				const tui = new TUI(terminal);
				tui.addChild(new Text("failed-frame", 1, 0));
				const overlay = vi.fn(() => "\x1b[?25l");
				tui.setPostRenderEmitter(overlay);
				try {
					tui.start();
					const generation = tui.requestRenderWithGeneration(true, "test.shared-write-failure");
					expect(await tui.waitForRenderCommit(generation)).toBe(false);
					expect(tui.terminalAvailable).toBe(false);
					expect(overlay).not.toHaveBeenCalled();
				} finally {
					tui.stop();
				}
			}
		} finally {
			if (previousSync === undefined) delete Bun.env.GJC_TUI_SYNCHRONIZED_OUTPUT;
			else Bun.env.GJC_TUI_SYNCHRONIZED_OUTPUT = previousSync;
		}
	});
	it("commits the shared frame when optional IME reanchoring fails in both framing modes", async () => {
		const previousIme = Bun.env.GJC_TUI_IME_CURSOR;
		const previousSync = Bun.env.GJC_TUI_SYNCHRONIZED_OUTPUT;
		const previousImageProtocol = TERMINAL.imageProtocol;
		Bun.env.GJC_TUI_IME_CURSOR = "1";
		setTerminalImageProtocol(null);

		try {
			for (const synchronizedOutput of [undefined, "0"]) {
				if (synchronizedOutput === undefined) delete Bun.env.GJC_TUI_SYNCHRONIZED_OUTPUT;
				else Bun.env.GJC_TUI_SYNCHRONIZED_OUTPUT = synchronizedOutput;
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
				}
			}
		} finally {
			setTerminalImageProtocol(previousImageProtocol);
			if (previousIme === undefined) delete Bun.env.GJC_TUI_IME_CURSOR;
			else Bun.env.GJC_TUI_IME_CURSOR = previousIme;
			if (previousSync === undefined) delete Bun.env.GJC_TUI_SYNCHRONIZED_OUTPUT;
			else Bun.env.GJC_TUI_SYNCHRONIZED_OUTPUT = previousSync;
		}
	});

	it("keeps the standalone IME cursor write outside synchronized framing", async () => {
		const previousIme = Bun.env.GJC_TUI_IME_CURSOR;
		const previousSync = Bun.env.GJC_TUI_SYNCHRONIZED_OUTPUT;
		const previousImageProtocol = TERMINAL.imageProtocol;
		Bun.env.GJC_TUI_IME_CURSOR = "1";
		delete Bun.env.GJC_TUI_SYNCHRONIZED_OUTPUT;
		setTerminalImageProtocol(null);
		const terminal = new VirtualTerminal(40, 8);
		const tui = new TUI(terminal, false);
		tui.addChild(new CursorComponent());

		try {
			tui.start();
			await terminal.waitForRender();
			const writes = terminal.getWriteLog();
			const sharedFrameIndex = writes.findIndex(
				write => write.startsWith("\x1b[?2026h") && write.endsWith("\x1b[?2026l"),
			);
			expect(sharedFrameIndex).toBeGreaterThanOrEqual(0);
			expect(writes[sharedFrameIndex + 1]).not.toContain("\x1b[?2026h");
			expect(writes[sharedFrameIndex + 1]).not.toContain("\x1b[?2026l");
		} finally {
			tui.stop();
			setTerminalImageProtocol(previousImageProtocol);
			if (previousIme === undefined) delete Bun.env.GJC_TUI_IME_CURSOR;
			else Bun.env.GJC_TUI_IME_CURSOR = previousIme;
			if (previousSync === undefined) delete Bun.env.GJC_TUI_SYNCHRONIZED_OUTPUT;
			else Bun.env.GJC_TUI_SYNCHRONIZED_OUTPUT = previousSync;
		}
	});

	it("commits the shared frame when optional overlay delivery fails in both framing modes", async () => {
		const previousSync = Bun.env.GJC_TUI_SYNCHRONIZED_OUTPUT;
		const previousImageProtocol = TERMINAL.imageProtocol;
		setTerminalImageProtocol(null);

		try {
			for (const synchronizedOutput of [undefined, "0"]) {
				if (synchronizedOutput === undefined) delete Bun.env.GJC_TUI_SYNCHRONIZED_OUTPUT;
				else Bun.env.GJC_TUI_SYNCHRONIZED_OUTPUT = synchronizedOutput;
				const terminal = new SecondWriteFailureTerminal(40, 8);
				const tui = new TUI(terminal, true);
				tui.addChild(new Text("overlay-frame", 1, 0));
				tui.setPostRenderEmitter(() => "\x1b[?25l");
				try {
					tui.start();
					const generation = tui.requestRenderWithGeneration(false, "test.overlay-failure");
					expect(await tui.waitForRenderCommit(generation)).toBe(true);
					expect(tui.terminalAvailable).toBe(false);
					const attemptsAfterFailure = terminal.attempts.length;
					const retryGeneration = tui.requestRenderWithGeneration(true, "test.overlay-failure-no-replay");
					expect(await tui.waitForRenderCommit(retryGeneration)).toBe(false);
					expect(terminal.attempts).toHaveLength(attemptsAfterFailure);
				} finally {
					tui.stop();
				}
			}
		} finally {
			setTerminalImageProtocol(previousImageProtocol);
			if (previousSync === undefined) delete Bun.env.GJC_TUI_SYNCHRONIZED_OUTPUT;
			else Bun.env.GJC_TUI_SYNCHRONIZED_OUTPUT = previousSync;
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
