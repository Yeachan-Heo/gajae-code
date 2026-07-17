import type { Terminal, TerminalAppearance } from "@gajae-code/tui/terminal";
import type { Terminal as XtermTerminalType } from "@xterm/headless";
import xterm from "@xterm/headless";

// Extract Terminal class from the module
const XtermTerminal = xterm.Terminal;

/**
 * Virtual terminal for testing using xterm.js for accurate terminal emulation
 */
export class VirtualTerminal implements Terminal {
	private xterm: XtermTerminalType;
	private inputHandler?: (data: string) => void;
	private resizeHandler?: () => void;
	#writeLog: string[] = [];
	private _columns: number;
	private _rows: number;

	#isProcessTerminal = false;

	constructor(columns = 80, rows = 24, options: { isProcessTerminal?: boolean } = {}) {
		this.#isProcessTerminal = options.isProcessTerminal === true;
		this._columns = columns;
		this._rows = rows;

		// Create xterm instance with specified dimensions
		this.xterm = new XtermTerminal({
			cols: columns,
			rows: rows,
			// Disable all interactive features for testing
			disableStdin: true,
			allowProposedApi: true,
		});
	}

	start(onInput: (data: string) => void, onResize: () => void): void {
		this.inputHandler = onInput;
		this.resizeHandler = onResize;
		// Enable bracketed paste mode for consistency with ProcessTerminal
		this.#write("\x1b[?2004h");
	}

	async drainInput(_maxMs?: number, _idleMs?: number): Promise<void> {
		// No-op for virtual terminal - no stdin to drain
	}

	stop(): void {
		// Disable bracketed paste mode
		this.#write("\x1b[?2004l");
		this.inputHandler = undefined;
		this.resizeHandler = undefined;
	}

	#write(data: string): void {
		this.#writeLog.push(data);
		this.xterm.write(data);
	}

	write(data: string): void {
		this.#write(data);
	}

	getWriteLog(): string[] {
		return [...this.#writeLog];
	}

	clearWriteLog(): void {
		this.#writeLog = [];
	}

	get columns(): number {
		return this._columns;
	}

	get rows(): number {
		return this._rows;
	}

	get kittyProtocolActive(): boolean {
		// Virtual terminal always reports Kitty protocol as active for testing
		return true;
	}

	get appearance(): TerminalAppearance | undefined {
		return undefined;
	}

	get available(): boolean {
		return true;
	}

	get isProcessTerminal(): boolean {
		return this.#isProcessTerminal;
	}

	onAppearanceChange(_callback: (appearance: TerminalAppearance) => void): void {
		// No-op for virtual terminal
	}

	moveBy(lines: number): void {
		if (lines > 0) {
			// Move down
			this.#write(`\x1b[${lines}B`);
		} else if (lines < 0) {
			// Move up
			this.#write(`\x1b[${-lines}A`);
		}
		// lines === 0: no movement
	}

	hideCursor(): void {
		this.#write("\x1b[?25l");
	}

	showCursor(): void {
		this.#write("\x1b[?25h");
	}

	clearLine(): void {
		this.#write("\x1b[K");
	}

	clearFromCursor(): void {
		this.#write("\x1b[J");
	}

	clearScreen(): void {
		this.#write("\x1b[H\x1b[0J"); // Move to home (1,1) and clear from cursor to end
	}

	setTitle(title: string): void {
		// OSC 0;title BEL - set terminal window title
		this.#write(`\x1b]0;${title}\x07`);
	}

	setProgress(active: boolean): void {
		// OSC 9;4 progress sequence; no-op in tests beyond writing through to xterm.
		this.#write(active ? "\x1b]9;4;3\x07" : "\x1b]9;4;0;\x07");
	}

	/** Wait for TUI's throttled render pipeline to settle (matches the 16ms frame budget). */
	async waitForRender(): Promise<void> {
		await new Promise<void>(resolve => process.nextTick(resolve));
		await new Promise<void>(resolve => setTimeout(resolve, 20));
		await this.flush();
	}

	// Test-specific methods not in Terminal interface

	/**
	 * Simulate keyboard input
	 */
	sendInput(data: string): void {
		if (this.inputHandler) {
			this.inputHandler(data);
		}
	}

	/**
	 * Resize the terminal
	 */
	resize(columns: number, rows: number): void {
		this._columns = columns;
		this._rows = rows;
		this.xterm.resize(columns, rows);
		if (this.resizeHandler) {
			this.resizeHandler();
		}
	}

	/**
	 * Wait for all pending writes to complete. Viewport and scroll buffer will be updated.
	 */
	async flush(): Promise<void> {
		// Write an empty string to ensure all previous writes are flushed
		return new Promise<void>(resolve => {
			this.xterm.write("", () => resolve());
		});
	}

	/**
	 * Flush and get viewport - convenience method for tests
	 */
	async flushAndGetViewport(): Promise<string[]> {
		await this.flush();
		return this.getViewport();
	}

	/**
	 * Get the visible viewport (what's currently on screen)
	 * Note: You should use getViewportAfterWrite() for testing after writing data
	 */
	getViewport(): string[] {
		const lines: string[] = [];
		const buffer = this.xterm.buffer.active;

		// Get only the visible lines (viewport)
		for (let i = 0; i < this.xterm.rows; i++) {
			const line = buffer.getLine(buffer.viewportY + i);
			if (line) {
				lines.push(line.translateToString(true));
			} else {
				lines.push("");
			}
		}

		return lines;
	}

	/**
	 * Get the entire scroll buffer
	 */
	getScrollBuffer(): string[] {
		const lines: string[] = [];
		const buffer = this.xterm.buffer.active;

		// Get all lines in the buffer (including scrollback)
		for (let i = 0; i < buffer.length; i++) {
			const line = buffer.getLine(i);
			if (line) {
				lines.push(line.translateToString(true));
			} else {
				lines.push("");
			}
		}

		return lines;
	}

	/**
	 * Clear the terminal viewport
	 */
	clear(): void {
		this.xterm.clear();
	}

	/**
	 * Reset the terminal completely
	 */
	reset(): void {
		this.xterm.reset();
	}
}
