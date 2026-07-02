import { describe, expect, it, vi } from "bun:test";
import { ProcessTerminal, type Terminal, type TerminalAppearance } from "@gajae-code/tui/terminal";
import { type Component, CURSOR_MARKER, TUI } from "@gajae-code/tui/tui";

class StaticComponent implements Component {
	#line: string;

	constructor(line: string) {
		this.#line = line;
	}

	setLine(line: string): void {
		this.#line = line;
	}

	invalidate(): void {}

	render(): string[] {
		return [this.#line];
	}
}

class DetachingTerminal implements Terminal {
	#writes: string[] = [];
	#available = true;
	#writeFailureAt: number | undefined;
	#hideCursorFails = false;

	constructor(writeFailureAt?: number) {
		this.#writeFailureAt = writeFailureAt;
	}

	get writes(): string[] {
		return [...this.#writes];
	}

	setHideCursorFails(fails: boolean): void {
		this.#hideCursorFails = fails;
	}

	start(_onInput: (data: string) => void, _onResize: () => void): void {}

	stop(): void {}

	async drainInput(_maxMs?: number, _idleMs?: number): Promise<void> {}

	write(data: string): void {
		if (!this.#available) {
			throw Object.assign(new Error("pty is gone"), { code: "EIO" });
		}
		const nextWriteNumber = this.#writes.length + 1;
		if (this.#writeFailureAt !== undefined && nextWriteNumber >= this.#writeFailureAt) {
			this.#available = false;
			throw Object.assign(new Error("pty is gone"), { code: "EIO" });
		}
		this.#writes.push(data);
	}

	get columns(): number {
		return 80;
	}

	get rows(): number {
		return 24;
	}

	get kittyProtocolActive(): boolean {
		return false;
	}

	get available(): boolean {
		return this.#available;
	}

	get appearance(): TerminalAppearance | undefined {
		return undefined;
	}

	onAppearanceChange(_callback: (appearance: TerminalAppearance) => void): void {}

	moveBy(lines: number): void {
		if (lines > 0) this.write(`\x1b[${lines}B`);
		if (lines < 0) this.write(`\x1b[${-lines}A`);
	}

	hideCursor(): void {
		if (this.#hideCursorFails) {
			this.#available = false;
			throw Object.assign(new Error("pty is gone"), { code: "EIO" });
		}
		this.write("\x1b[?25l");
	}

	showCursor(): void {
		this.write("\x1b[?25h");
	}

	clearLine(): void {
		this.write("\x1b[K");
	}

	clearFromCursor(): void {
		this.write("\x1b[J");
	}

	clearScreen(): void {
		this.write("\x1b[H\x1b[0J");
	}

	setTitle(title: string): void {
		this.write(`\x1b]0;${title}\x07`);
	}

	setProgress(active: boolean): void {
		this.write(active ? "\x1b]9;4;3\x07" : "\x1b]9;4;0;\x07");
	}
}

async function settle(): Promise<void> {
	await new Promise<void>(resolve => process.nextTick(resolve));
	await Bun.sleep(25);
}

function withStdoutProperty<T>(
	property: "isTTY" | "writable" | "destroyed" | "closed",
	value: boolean,
	run: () => T,
): T {
	const original = process.stdout[property];
	Object.defineProperty(process.stdout, property, { configurable: true, value });
	try {
		return run();
	} finally {
		Object.defineProperty(process.stdout, property, { configurable: true, value: original });
	}
}

describe("terminal detach handling", () => {
	it("swallows ProcessTerminal EIO writes and marks output unavailable", () => {
		const terminal = new ProcessTerminal();
		const originalIsTTY = process.stdout.isTTY;
		Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
		const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => {
			throw Object.assign(new Error("pty is gone"), { code: "EIO" });
		});

		try {
			expect(() => terminal.write("render frame")).not.toThrow();
			expect(terminal.available).toBe(false);
			expect(() => terminal.hideCursor()).not.toThrow();
			expect(writeSpy).toHaveBeenCalledTimes(1);
		} finally {
			writeSpy.mockRestore();
			Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: originalIsTTY });
		}
	});

	it("marks ProcessTerminal unavailable when stdout emits an async EIO", () => {
		const terminal = new ProcessTerminal();
		const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		const resumeSpy = vi.spyOn(process.stdin, "resume").mockImplementation(() => process.stdin);
		const pauseSpy = vi.spyOn(process.stdin, "pause").mockImplementation(() => process.stdin);

		try {
			withStdoutProperty("isTTY", true, () => {
				expect(() =>
					terminal.start(
						() => {},
						() => {},
					),
				).not.toThrow();
				expect(terminal.available).toBe(true);
				expect(() => {
					process.stdout.emit("error", Object.assign(new Error("pty is gone"), { code: "EIO" }));
				}).not.toThrow();
				expect(terminal.available).toBe(false);
				expect(() => terminal.write("after async error")).not.toThrow();
			});
		} finally {
			expect(() => terminal.stop()).not.toThrow();
			writeSpy.mockRestore();
			resumeSpy.mockRestore();
			pauseSpy.mockRestore();
		}
	});
	it("keeps stdout error listener armed briefly after stop restore writes", async () => {
		const terminal = new ProcessTerminal();
		const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		const resumeSpy = vi.spyOn(process.stdin, "resume").mockImplementation(() => process.stdin);
		const pauseSpy = vi.spyOn(process.stdin, "pause").mockImplementation(() => process.stdin);
		await Bun.sleep(300);
		const beforeListeners = process.stdout.listenerCount("error");

		try {
			withStdoutProperty("isTTY", true, () => {
				terminal.start(
					() => {},
					() => {},
				);
				expect(process.stdout.listenerCount("error")).toBe(beforeListeners + 1);
				terminal.stop();
				expect(process.stdout.listenerCount("error")).toBe(beforeListeners + 1);
				expect(() => {
					process.stdout.emit("error", Object.assign(new Error("pty vanished after stop"), { code: "EIO" }));
				}).not.toThrow();
				expect(terminal.available).toBe(false);
			});
			await Bun.sleep(300);
			expect(process.stdout.listenerCount("error")).toBe(beforeListeners);
		} finally {
			terminal.stop();
			writeSpy.mockRestore();
			resumeSpy.mockRestore();
			pauseSpy.mockRestore();
		}
	});

	it("marks ProcessTerminal unavailable when stdout is already closed", () => {
		const terminal = new ProcessTerminal();
		const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

		try {
			withStdoutProperty("isTTY", true, () => {
				withStdoutProperty("closed", true, () => {
					expect(() => terminal.write("render frame")).not.toThrow();
					expect(terminal.available).toBe(false);
					expect(writeSpy).not.toHaveBeenCalled();
				});
			});
		} finally {
			writeSpy.mockRestore();
		}
	});

	it("stops render writes after a terminal write fails", async () => {
		const terminal = new DetachingTerminal(2);
		const tui = new TUI(terminal);
		const component = new StaticComponent("hello");
		tui.addChild(component);

		expect(() => tui.start()).not.toThrow();
		await settle();
		const writesAfterDetach = terminal.writes.length;
		expect(tui.terminalAvailable).toBe(false);

		component.setLine("after detach");
		expect(() => tui.requestRender(true)).not.toThrow();
		await settle();
		expect(terminal.writes.length).toBe(writesAfterDetach);
	});

	it("swallows cursor cleanup failures and suppresses later renders", async () => {
		const terminal = new DetachingTerminal();
		const tui = new TUI(terminal, true);
		const component = new StaticComponent(`${CURSOR_MARKER}hello`);
		tui.addChild(component);
		tui.start();
		await settle();
		const writesBeforeCursorFailure = terminal.writes.length;

		terminal.setHideCursorFails(true);
		component.setLine("hello");
		expect(() => tui.requestRender()).not.toThrow();
		await settle();
		expect(tui.terminalAvailable).toBe(false);

		component.setLine("after cursor failure");
		expect(() => tui.requestRender(true)).not.toThrow();
		await settle();
		expect(terminal.writes.length).toBe(writesBeforeCursorFailure);
	});
});
