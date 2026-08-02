import { describe, expect, it, vi } from "bun:test";
import {
	__stdinErrorDispatcherInstalledForTests,
	__stdinErrorSubscriberCountForTests,
	__stdoutErrorDispatcherInstalledForTests,
	__stdoutErrorSubscriberCountForTests,
	ProcessTerminal,
	type Terminal,
	type TerminalAppearance,
} from "@gajae-code/tui/terminal";
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
class MultiLineComponent implements Component {
	#lines: string[];

	constructor(lines: string[]) {
		this.#lines = [...lines];
	}

	setLines(lines: string[]): void {
		this.#lines = [...lines];
	}

	invalidate(): void {}

	render(): string[] {
		return this.#lines;
	}
}

class DetachingTerminal implements Terminal {
	#writes: string[] = [];
	#attempts: string[] = [];

	#available = true;
	#writeFailureAt: number | undefined;
	#hideCursorFails = false;

	constructor(writeFailureAt?: number) {
		this.#writeFailureAt = writeFailureAt;
	}

	get writes(): string[] {
		return [...this.#writes];
	}

	get attempts(): string[] {
		return [...this.#attempts];
	}

	setHideCursorFails(fails: boolean): void {
		this.#hideCursorFails = fails;
	}

	setWriteFailureAt(writeFailureAt: number | undefined): void {
		this.#writeFailureAt = writeFailureAt;
		if (writeFailureAt === undefined) this.#available = true;
	}

	start(_onInput: (data: string) => void, _onResize: () => void): void {}

	stop(): void {}

	async drainInput(_maxMs?: number, _idleMs?: number): Promise<void> {}

	write(data: string): void {
		this.#attempts.push(data);

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

	it("enables SGR mouse reporting inside tmux", () => {
		const terminal = new ProcessTerminal();
		const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		const resumeSpy = vi.spyOn(process.stdin, "resume").mockImplementation(() => process.stdin);
		const pauseSpy = vi.spyOn(process.stdin, "pause").mockImplementation(() => process.stdin);
		const previousTmux = process.env.TMUX;
		process.env.TMUX = "/tmp/tmux/default,1,0";

		try {
			withStdoutProperty("isTTY", true, () => {
				terminal.setMouseEnabled(true);
				terminal.start(
					() => {},
					() => {},
				);
				const output = writeSpy.mock.calls.map(call => String(call[0])).join("");
				expect(output).toContain("\x1b[?1002h");
				expect(output).toContain("\x1b[?1006h");
				expect(output).toContain("\x1b[?1007l");
			});
		} finally {
			terminal.stop();
			writeSpy.mockRestore();
			resumeSpy.mockRestore();
			pauseSpy.mockRestore();
			if (previousTmux === undefined) delete process.env.TMUX;
			else process.env.TMUX = previousTmux;
		}
	});
	it("disables stale SGR mouse reporting inside tmux when mouse support is off", () => {
		const terminal = new ProcessTerminal();
		const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		const resumeSpy = vi.spyOn(process.stdin, "resume").mockImplementation(() => process.stdin);
		const pauseSpy = vi.spyOn(process.stdin, "pause").mockImplementation(() => process.stdin);
		const previousTmux = process.env.TMUX;
		process.env.TMUX = "/tmp/tmux/default,1,0";

		try {
			withStdoutProperty("isTTY", true, () => {
				terminal.setMouseEnabled(false);
				terminal.start(
					() => {},
					() => {},
				);
				const output = writeSpy.mock.calls.map(call => String(call[0])).join("");
				expect(output).toContain("\x1b[?1000l");
				expect(output).toContain("\x1b[?1002l");
				expect(output).toContain("\x1b[?1006l");
				expect(output).toContain("\x1b[?1007l");
				expect(output).not.toContain("\x1b[?1000h");
				expect(output).not.toContain("\x1b[?1002h");
				expect(output).not.toContain("\x1b[?1006h");
			});
		} finally {
			terminal.stop();
			writeSpy.mockRestore();
			resumeSpy.mockRestore();
			pauseSpy.mockRestore();
			if (previousTmux === undefined) delete process.env.TMUX;
			else process.env.TMUX = previousTmux;
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
	it("marks ProcessTerminal unavailable when stdin emits an async EIO", () => {
		// A vanished PTY (tmux pane killed, SSH dropped) fails the in-flight stdin
		// read with EIO. Without a listener the EventEmitter rethrows it as an
		// uncaught exception that kills the whole agent process.
		const terminal = new ProcessTerminal();
		const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		const resumeSpy = vi.spyOn(process.stdin, "resume").mockImplementation(() => process.stdin);
		const pauseSpy = vi.spyOn(process.stdin, "pause").mockImplementation(() => process.stdin);

		try {
			withStdoutProperty("isTTY", true, () => {
				terminal.start(
					() => {},
					() => {},
				);
				expect(terminal.available).toBe(true);
				expect(() => {
					process.stdin.emit("error", Object.assign(new Error("pty is gone"), { code: "EIO" }));
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
	it("keeps a non-EIO stdin error propagating instead of retiring the terminal", () => {
		// Only EIO means "the controlling terminal vanished". Any other stream
		// failure (EBADF, EPIPE, ...) must keep the EventEmitter contract: with no
		// other "error" listener it throws, and the terminal stays usable.
		const terminal = new ProcessTerminal();
		const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		const resumeSpy = vi.spyOn(process.stdin, "resume").mockImplementation(() => process.stdin);
		const pauseSpy = vi.spyOn(process.stdin, "pause").mockImplementation(() => process.stdin);
		// Ambient listeners installed by the runtime would absorb the throw, so
		// detach them for the duration of this assertion and restore them after.
		const ambientListeners = process.stdin.listeners("error") as Array<(...args: unknown[]) => void>;
		for (const listener of ambientListeners) process.stdin.removeListener("error", listener);
		const badFileDescriptor = Object.assign(new Error("bad file descriptor"), { code: "EBADF" });

		try {
			withStdoutProperty("isTTY", true, () => {
				terminal.start(
					() => {},
					() => {},
				);
				expect(terminal.available).toBe(true);
				expect(() => {
					process.stdin.emit("error", badFileDescriptor);
				}).toThrow(badFileDescriptor);
				expect(terminal.available).toBe(true);
			});
		} finally {
			terminal.stop();
			writeSpy.mockRestore();
			resumeSpy.mockRestore();
			pauseSpy.mockRestore();
			for (const listener of ambientListeners) process.stdin.on("error", listener);
		}
	});
	it("delivers a non-EIO stdin error to other listeners without retiring the terminal", () => {
		const terminal = new ProcessTerminal();
		const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		const resumeSpy = vi.spyOn(process.stdin, "resume").mockImplementation(() => process.stdin);
		const pauseSpy = vi.spyOn(process.stdin, "pause").mockImplementation(() => process.stdin);
		const observed: Error[] = [];
		const observer = (err: Error): void => {
			observed.push(err);
		};
		process.stdin.on("error", observer);
		const brokenPipe = Object.assign(new Error("broken pipe"), { code: "EPIPE" });

		try {
			withStdoutProperty("isTTY", true, () => {
				terminal.start(
					() => {},
					() => {},
				);
				expect(() => {
					process.stdin.emit("error", brokenPipe);
				}).not.toThrow();
				expect(observed).toEqual([brokenPipe]);
				expect(terminal.available).toBe(true);
			});
		} finally {
			terminal.stop();
			writeSpy.mockRestore();
			resumeSpy.mockRestore();
			pauseSpy.mockRestore();
			process.stdin.removeListener("error", observer);
		}
	});
	it("keeps stdin error listener armed briefly after stop and releases it afterwards", async () => {
		const terminal = new ProcessTerminal();
		const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		const resumeSpy = vi.spyOn(process.stdin, "resume").mockImplementation(() => process.stdin);
		const pauseSpy = vi.spyOn(process.stdin, "pause").mockImplementation(() => process.stdin);
		const ambientListener = (): void => {};
		process.stdin.on("error", ambientListener);
		await Bun.sleep(300);
		const listenersBeforeStart = new Set(process.stdin.listeners("error"));
		const subscribersBeforeStart = __stdinErrorSubscriberCountForTests();
		const dispatcherWasInstalled = __stdinErrorDispatcherInstalledForTests();

		try {
			withStdoutProperty("isTTY", true, () => {
				terminal.start(
					() => {},
					() => {},
				);
				const listenersAfterStart = process.stdin.listeners("error");
				const listenersAddedByStart = listenersAfterStart.filter(listener => !listenersBeforeStart.has(listener));
				expect(listenersAddedByStart).toHaveLength(dispatcherWasInstalled ? 0 : 1);
				expect(__stdinErrorDispatcherInstalledForTests()).toBe(true);
				expect(__stdinErrorSubscriberCountForTests()).toBe(subscribersBeforeStart + 1);
				terminal.stop();
				expect(process.stdin.listeners("error")).toEqual(listenersAfterStart);
				expect(() => {
					process.stdin.emit("error", Object.assign(new Error("pty vanished after stop"), { code: "EIO" }));
				}).not.toThrow();
				expect(terminal.available).toBe(false);
			});
			await Bun.sleep(300);
			expect(__stdinErrorSubscriberCountForTests()).toBe(subscribersBeforeStart);
			expect(process.stdin.listeners("error")).toContain(ambientListener);
			expect(__stdinErrorDispatcherInstalledForTests()).toBe(dispatcherWasInstalled);
		} finally {
			terminal.stop();
			writeSpy.mockRestore();
			resumeSpy.mockRestore();
			pauseSpy.mockRestore();
			process.stdin.removeListener("error", ambientListener);
		}
	});
	it("keeps stdout error listener armed briefly after stop restore writes", async () => {
		const terminal = new ProcessTerminal();
		const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		const resumeSpy = vi.spyOn(process.stdin, "resume").mockImplementation(() => process.stdin);
		const pauseSpy = vi.spyOn(process.stdin, "pause").mockImplementation(() => process.stdin);
		const ambientListener = (): void => {};
		process.stdout.on("error", ambientListener);
		await Bun.sleep(300);
		const listenersBeforeStart = new Set(process.stdout.listeners("error"));
		const subscribersBeforeStart = __stdoutErrorSubscriberCountForTests();
		const dispatcherWasInstalled = __stdoutErrorDispatcherInstalledForTests();

		try {
			withStdoutProperty("isTTY", true, () => {
				terminal.start(
					() => {},
					() => {},
				);
				const listenersAfterStart = process.stdout.listeners("error");
				const listenersAddedByStart = listenersAfterStart.filter(listener => !listenersBeforeStart.has(listener));
				expect(listenersAddedByStart).toHaveLength(dispatcherWasInstalled ? 0 : 1);
				expect(__stdoutErrorDispatcherInstalledForTests()).toBe(true);
				expect(__stdoutErrorSubscriberCountForTests()).toBe(subscribersBeforeStart + 1);
				terminal.stop();
				expect(process.stdout.listeners("error")).toEqual(listenersAfterStart);
				expect(() => {
					process.stdout.emit("error", Object.assign(new Error("pty vanished after stop"), { code: "EIO" }));
				}).not.toThrow();
				expect(terminal.available).toBe(false);
			});
			await Bun.sleep(300);
			expect(__stdoutErrorSubscriberCountForTests()).toBe(subscribersBeforeStart);
			expect(process.stdout.listeners("error")).toContain(ambientListener);
			expect(__stdoutErrorDispatcherInstalledForTests()).toBe(dispatcherWasInstalled);
		} finally {
			terminal.stop();
			writeSpy.mockRestore();
			resumeSpy.mockRestore();
			pauseSpy.mockRestore();
			process.stdout.removeListener("error", ambientListener);
		}
	});
	it("shares one stdout error listener across terminals during cleanup grace periods", async () => {
		const terminals = Array.from({ length: 12 }, () => new ProcessTerminal());
		const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		const resumeSpy = vi.spyOn(process.stdin, "resume").mockImplementation(() => process.stdin);
		const pauseSpy = vi.spyOn(process.stdin, "pause").mockImplementation(() => process.stdin);
		const ambientListener = (): void => {};
		process.stdout.on("error", ambientListener);
		await Bun.sleep(300);
		const listenersBeforeStart = new Set(process.stdout.listeners("error"));
		const subscribersBeforeStart = __stdoutErrorSubscriberCountForTests();
		const dispatcherWasInstalled = __stdoutErrorDispatcherInstalledForTests();

		try {
			withStdoutProperty("isTTY", true, () => {
				for (const terminal of terminals) {
					terminal.start(
						() => {},
						() => {},
					);
					terminal.stop();
				}
				const listenersAfterStart = process.stdout.listeners("error");
				const listenersAddedByStarts = listenersAfterStart.filter(listener => !listenersBeforeStart.has(listener));
				expect(listenersAddedByStarts).toHaveLength(dispatcherWasInstalled ? 0 : 1);
				expect(__stdoutErrorDispatcherInstalledForTests()).toBe(true);
				expect(__stdoutErrorSubscriberCountForTests()).toBe(subscribersBeforeStart + terminals.length);
				expect(() => {
					process.stdout.emit("error", Object.assign(new Error("shared detached stdout"), { code: "EIO" }));
				}).not.toThrow();
				expect(terminals.every(terminal => !terminal.available)).toBe(true);
			});
			await Bun.sleep(300);
			expect(__stdoutErrorSubscriberCountForTests()).toBe(subscribersBeforeStart);
			expect(process.stdout.listeners("error")).toContain(ambientListener);
			expect(__stdoutErrorDispatcherInstalledForTests()).toBe(dispatcherWasInstalled);
		} finally {
			for (const terminal of terminals) terminal.stop();
			writeSpy.mockRestore();
			resumeSpy.mockRestore();
			pauseSpy.mockRestore();
			process.stdout.removeListener("error", ambientListener);
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
	it("retries component cleanup after terminal recovery", async () => {
		const terminal = new DetachingTerminal(1);
		const tui = new TUI(terminal);
		const delivered = vi.fn();

		tui.queueTerminalCleanup("pet-cleanup", delivered);
		expect(delivered).not.toHaveBeenCalled();
		expect(terminal.writes).toEqual([]);

		terminal.setWriteFailureAt(undefined);
		tui.start();
		await settle();
		expect(delivered).toHaveBeenCalledTimes(1);
		expect(terminal.writes).toContain("pet-cleanup");
		tui.stop();
	});
	it("commits neither frame nor frontier when the render-buffer write fails before an IME cursor write", async () => {
		const previousIme = Bun.env.GJC_TUI_IME_CURSOR;
		Bun.env.GJC_TUI_IME_CURSOR = "1";
		const terminal = new DetachingTerminal();
		const tui = new TUI(terminal, false);
		const transcript = new StaticComponent("before");
		const component = new StaticComponent(`${CURSOR_MARKER}draft`);
		tui.addChild(transcript);
		tui.addChild(component);
		try {
			tui.start();
			await settle();
			const committedWrites = terminal.writes.length;
			transcript.setLine("after");
			terminal.setWriteFailureAt(committedWrites + 1);
			tui.requestRender(true, "failure.render-buffer");
			await settle();

			expect(terminal.attempts.at(-1)).toContain("after");
			expect(terminal.writes).toHaveLength(committedWrites);
			expect(tui.terminalAvailable).toBe(false);
			const attemptsAfterFailure = terminal.attempts.length;
			tui.requestRender(true, "failure.no-retry");
			await settle();
			expect(terminal.attempts).toHaveLength(attemptsAfterFailure);
			// Recover the same TUI only after its transport is writable again; a new
			// instance would not prove that the failed frame was discarded.
			tui.stop();
			terminal.setWriteFailureAt(undefined);
			transcript.setLine("fresh-render-baseline");
			component.setLine(`${CURSOR_MARKER}fresh-cursor-baseline`);
			const recoveryStart = terminal.writes.length;
			tui.start();
			await settle();
			const recoveryFrame = terminal.writes.slice(recoveryStart).join("");
			expect(recoveryFrame).toContain("fresh-render-baseline");
			expect(recoveryFrame).toContain("fresh-cursor-baseline");
			expect(recoveryFrame).not.toContain("after");
			expect(recoveryFrame).not.toContain("draft");
		} finally {
			tui.stop();
			if (previousIme === undefined) delete Bun.env.GJC_TUI_IME_CURSOR;
			else Bun.env.GJC_TUI_IME_CURSOR = previousIme;
		}
	});

	it("commits the painted frame before a subsequent IME cursor write fails", async () => {
		const previousIme = Bun.env.GJC_TUI_IME_CURSOR;
		Bun.env.GJC_TUI_IME_CURSOR = "1";
		const terminal = new DetachingTerminal();
		const tui = new TUI(terminal, false);
		const transcript = new StaticComponent("before");
		const component = new StaticComponent(`${CURSOR_MARKER}draft`);
		tui.addChild(transcript);
		tui.addChild(component);
		try {
			tui.start();
			await settle();
			const committedWrites = terminal.writes.length;
			transcript.setLine("after");
			terminal.setWriteFailureAt(committedWrites + 2);
			tui.requestRender(true, "failure.cursor");
			await settle();

			const paintIndex = terminal.attempts.findIndex(write => write.includes("after"));
			expect(paintIndex).toBeGreaterThanOrEqual(0);
			const paint = terminal.attempts[paintIndex]!;
			const cursor = terminal.attempts[paintIndex + 1];
			expect(cursor).toContain("\x1b[");
			expect(terminal.writes).toContain(paint);
			expect(tui.terminalAvailable).toBe(false);
			const attemptsAfterFailure = terminal.attempts.length;
			tui.requestRender(true, "failure.no-retry");
			await settle();
			expect(terminal.attempts).toHaveLength(attemptsAfterFailure);
			tui.stop();
			terminal.setWriteFailureAt(undefined);
			transcript.setLine("fresh-cursor-recovery");
			component.setLine(`${CURSOR_MARKER}fresh-cursor-baseline`);
			const recoveryStart = terminal.writes.length;
			tui.start();
			await settle();
			const recoveryFrame = terminal.writes.slice(recoveryStart).join("");
			expect(recoveryFrame).toContain("fresh-cursor-recovery");
			expect(recoveryFrame).toContain("fresh-cursor-baseline");
			expect(recoveryFrame).not.toContain("after");
			expect(recoveryFrame).not.toContain("draft");
		} finally {
			tui.stop();
			if (previousIme === undefined) delete Bun.env.GJC_TUI_IME_CURSOR;
			else Bun.env.GJC_TUI_IME_CURSOR = previousIme;
		}
	});
	it("preserves manual follow intent when the repaint write fails and retries after restart", async () => {
		const terminal = new DetachingTerminal();
		const tui = new TUI(terminal);
		const component = new MultiLineComponent(Array.from({ length: 30 }, (_value, index) => `line-${index}`));
		tui.addChild(component);
		tui.setViewportOutputSource({ identity: "transactional-follow", revision: 0n });

		tui.start();
		await settle();
		expect(tui.terminalAvailable).toBe(true);
		expect(tui.scrollViewportPages(-1)).toBe(true);
		await settle();
		tui.setViewportOutputSource({ identity: "transactional-follow", revision: 1n });
		await settle();

		// The next write — the auto-follow live repaint — is set to fail before commit.
		const writesBeforeFollow = terminal.writes.length;
		terminal.setWriteFailureAt(writesBeforeFollow + 1);
		expect(tui.scrollViewportPages(1)).toBe(false);
		expect(tui.terminalAvailable).toBe(false);

		const attemptsAfterFailure = terminal.attempts.length;
		expect(tui.followLiveViewport()).toBe(false);
		expect(terminal.attempts).toHaveLength(attemptsAfterFailure);

		// Restart paints the retained manual frame and notice; follow can then commit.
		terminal.setWriteFailureAt(undefined);
		tui.stop();
		const restartStart = terminal.writes.length;
		tui.start();
		await settle();
		expect(tui.terminalAvailable).toBe(true);
		expect(terminal.writes.slice(restartStart).join("")).toContain("New output — type to follow");
		expect(tui.followLiveViewport()).toBe(true);
		await settle();
		expect(tui.followLiveViewport()).toBe(false);

		component.setLines(Array.from({ length: 30 }, (_value, index) => `line-${index}`).concat("fresh-recovery"));
		const recoveryStart = terminal.writes.length;
		tui.requestRender();
		await settle();
		const recoveryFrame = terminal.writes.slice(recoveryStart).join("");
		expect(recoveryFrame).toContain("fresh-recovery");
		expect(recoveryFrame).not.toContain("New output — type to follow");
	});
	it("commits the follow-live transition before a later IME cursor write fails", async () => {
		const previousIme = Bun.env.GJC_TUI_IME_CURSOR;
		Bun.env.GJC_TUI_IME_CURSOR = "1";
		const terminal = new DetachingTerminal();
		const tui = new TUI(terminal, false);
		const component = new MultiLineComponent(
			Array.from({ length: 29 }, (_value, index) => `line-${index}`).concat(`${CURSOR_MARKER}line-29`),
		);
		tui.addChild(component);
		tui.setViewportOutputSource({ identity: "cursor-follow", revision: 0n });
		try {
			tui.start();
			await settle();
			expect(tui.scrollViewportPages(-1)).toBe(true);
			await settle();
			tui.setViewportOutputSource({ identity: "cursor-follow", revision: 1n });
			await settle();

			const committedWrites = terminal.writes.length;
			terminal.setWriteFailureAt(committedWrites + 2);
			expect(tui.scrollViewportPages(1)).toBe(false);
			expect(terminal.writes).toHaveLength(committedWrites + 1);
			expect(tui.terminalAvailable).toBe(false);
			const attemptsAfterFailure = terminal.attempts.length;
			expect(tui.followLiveViewport()).toBe(false);
			expect(terminal.attempts).toHaveLength(attemptsAfterFailure);

			tui.stop();
			terminal.setWriteFailureAt(undefined);
			component.setLines(
				Array.from({ length: 29 }, (_value, index) => `fresh-${index}`).concat(`${CURSOR_MARKER}fresh-live`),
			);
			const recoveryStart = terminal.writes.length;
			tui.start();
			await settle();
			const recoveryFrame = terminal.writes.slice(recoveryStart).join("");
			expect(recoveryFrame).toContain("fresh-live");
			expect(recoveryFrame).not.toContain("New output — type to follow");
		} finally {
			tui.stop();
			if (previousIme === undefined) delete Bun.env.GJC_TUI_IME_CURSOR;
			else Bun.env.GJC_TUI_IME_CURSOR = previousIme;
		}
	});
});
