import { dlopen, FFIType, ptr } from "bun:ffi";
import * as fs from "node:fs";
import { $env, $flag } from "@gajae-code/utils";
import { setKittyProtocolActive } from "./keys";
import { StdinBuffer } from "./stdin-buffer";

const TERMINAL_PROGRESS_KEEPALIVE_MS = 1000;
const TERMINAL_PROGRESS_ACTIVE_SEQUENCE = "\x1b]9;4;3\x07";
const TERMINAL_PROGRESS_CLEAR_SEQUENCE = "\x1b]9;4;0;\x07";

/**
 * Whether GJC may reprogram the keyboard with enhanced input protocols
 * (the Kitty keyboard protocol and the xterm modifyOtherKeys fallback).
 *
 * Enabled by default. Set `GJC_TUI_KEYBOARD_PROTOCOL=0` to leave the keyboard in
 * its default mode. Some terminals — notably Android Termius — break IME
 * composition (e.g. Korean/Hangul syllable composition) while these enhanced
 * modes are active, committing every intermediate composing jamo/syllable
 * instead of only the final character. Disabling the protocol restores normal
 * IME behavior, matching how other TUIs that leave the keyboard untouched render
 * Korean correctly.
 */
export function keyboardEnhancementEnabled(): boolean {
	return $flag("GJC_TUI_KEYBOARD_PROTOCOL", true);
}

/**
 * Minimal terminal interface for TUI
 */

// Track active terminal for emergency cleanup on crash
let activeTerminal: ProcessTerminal | null = null;
// Track if a terminal was ever started (for emergency restore logic)
let terminalEverStarted = false;

const STD_INPUT_HANDLE = -10;
const ENABLE_VIRTUAL_TERMINAL_INPUT = 0x0200;
/**
 * Emergency terminal restore - call this from signal/crash handlers
 * Resets terminal state without requiring access to the ProcessTerminal instance
 */
export function emergencyTerminalRestore(): void {
	try {
		const terminal = activeTerminal;
		if (terminal) {
			terminal.stop();
			terminal.showCursor();
		} else if (terminalEverStarted) {
			// Blind restore only if we know a terminal was started but lost track of it
			// This avoids writing escape sequences for non-TUI commands (grep, commit, etc.)
			process.stdout.write(
				"\x1b[?2004l" + // Disable bracketed paste
					"\x1b[?1000l" + // Disable normal mouse reporting
					"\x1b[?1006l" + // Disable SGR extended mouse reporting
					"\x1b[?2031l" + // Disable Mode 2031 appearance notifications
					"\x1b[<u" + // Pop kitty keyboard protocol
					"\x1b[>4;0m" + // Disable modifyOtherKeys fallback
					"\x1b[?25h", // Show cursor
			);
			if (process.stdin.setRawMode) {
				process.stdin.setRawMode(false);
			}
		}
	} catch {
		// Terminal may already be dead during crash cleanup - ignore errors
	}
}
/** Terminal-reported appearance (dark/light mode). */
export type TerminalAppearance = "dark" | "light";
export interface Terminal {
	// Start the terminal with input and resize handlers
	start(onInput: (data: string) => void, onResize: () => void): void;

	// Stop the terminal and restore state
	stop(): void;

	/**
	 * Drain stdin before exiting to prevent Kitty key release events from
	 * leaking to the parent shell over slow SSH connections.
	 * @param maxMs - Maximum time to drain (default: 1000ms)
	 * @param idleMs - Exit early if no input arrives within this time (default: 50ms)
	 */
	drainInput(maxMs?: number, idleMs?: number): Promise<void>;

	// Write output to terminal
	write(data: string): void;

	// Whether terminal output is still writable
	get available(): boolean;

	// Get terminal dimensions
	get columns(): number;
	get rows(): number;

	// Whether Kitty keyboard protocol is active
	get kittyProtocolActive(): boolean;

	// Cursor positioning (relative to current position)
	moveBy(lines: number): void; // Move cursor up (negative) or down (positive) by N lines

	// Cursor visibility
	hideCursor(): void; // Hide the cursor
	showCursor(): void; // Show the cursor

	// Clear operations
	clearLine(): void; // Clear current line
	clearFromCursor(): void; // Clear from cursor to end of screen
	clearScreen(): void; // Clear entire screen and move cursor to (0,0)

	// Title operations
	setTitle(title: string): void; // Set terminal window title

	// Progress indicator (OSC 9;4)
	setProgress(active: boolean): void;

	/**
	 * Register a callback for terminal appearance (dark/light) changes.
	 * Detection uses OSC 11 background color query with Mode 2031 as a change trigger.
	 * Fires when the detected appearance changes, including the initial detection.
	 */
	onAppearanceChange(callback: (appearance: TerminalAppearance) => void): void;

	/** The last detected terminal appearance, or undefined if not yet known. */
	get appearance(): TerminalAppearance | undefined;
}

interface TerminalSizeStream {
	columns?: number;
	rows?: number;
	getWindowSize?: () => [number, number] | number[];
}

function positiveDimension(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
	const dimension = Math.trunc(value);
	return dimension > 0 ? dimension : undefined;
}

export function resolveTerminalColumns(
	stream: TerminalSizeStream = process.stdout,
	envColumns: string | undefined = Bun.env.COLUMNS,
): number {
	try {
		const windowSize = stream.getWindowSize?.();
		const liveColumns = positiveDimension(windowSize?.[0]);
		if (liveColumns !== undefined) return liveColumns;
	} catch {
		// Fall back below when the stream cannot report a live TTY size.
	}
	return positiveDimension(stream.columns) ?? positiveDimension(Number(envColumns)) ?? 80;
}

export function resolveTerminalRows(
	stream: TerminalSizeStream = process.stdout,
	envRows: string | undefined = Bun.env.LINES,
): number {
	try {
		const windowSize = stream.getWindowSize?.();
		const liveRows = positiveDimension(windowSize?.[1]);
		if (liveRows !== undefined) return liveRows;
	} catch {
		// Fall back below when the stream cannot report a live TTY size.
	}
	return positiveDimension(stream.rows) ?? positiveDimension(Number(envRows)) ?? 24;
}

function isWindowsSubsystemForLinux(): boolean {
	return process.platform === "linux" && (!!$env.WSL_DISTRO_NAME || !!$env.WSL_INTEROP);
}
const STDOUT_ERROR_HANDLER_GRACE_MS = 250;

/**
 * Real terminal using process.stdin/stdout
 */
export class ProcessTerminal implements Terminal {
	#wasRaw = false;
	#inputHandler?: (data: string) => void;
	#resizeHandler?: () => void;
	#kittyProtocolActive = false;
	#modifyOtherKeysActive = false;
	#modifyOtherKeysTimeout?: Timer;
	#stdinBuffer?: StdinBuffer;
	#stdinDataHandler?: (data: string | Buffer) => void;
	#dead = false;
	#writeLogPath = $env.PI_TUI_WRITE_LOG || "";
	#detachLogPath = $env.PI_TUI_TERMINAL_DETACH_LOG || "";
	#windowsVTInputRestore?: () => void;
	#stdoutErrorHandler?: (err: Error) => void;
	#stdoutErrorHandlerCleanupTimer?: Timer;
	#appearanceCallbacks: Array<(appearance: TerminalAppearance) => void> = [];
	#appearance: TerminalAppearance | undefined;
	#osc11Pending = false;
	#osc11QueryQueued = false;
	#osc11ResponseBuffer = "";
	#privateCsiResponseBuffer = "";
	#pendingDa1Sentinels = 0;
	#osc11PollTimer?: Timer;
	#mode2031DebounceTimer?: Timer;
	#progressTimer?: ReturnType<typeof setInterval>;

	get kittyProtocolActive(): boolean {
		return this.#kittyProtocolActive;
	}

	get appearance(): TerminalAppearance | undefined {
		return this.#appearance;
	}

	onAppearanceChange(callback: (appearance: TerminalAppearance) => void): void {
		this.#appearanceCallbacks.push(callback);
	}

	start(onInput: (data: string) => void, onResize: () => void): void {
		this.#inputHandler = onInput;
		this.#resizeHandler = onResize;

		// Register for emergency cleanup
		activeTerminal = this;
		terminalEverStarted = true;

		// Save previous state and enable raw mode
		this.#wasRaw = process.stdin.isRaw || false;
		if (process.stdin.setRawMode) {
			process.stdin.setRawMode(true);
		}
		// Do NOT setEncoding("utf8"): raw stdin chunks may split a multi-byte
		// UTF-8 character across reads, and Bun's raw-TTY string decoding does
		// not reliably reassemble them (issue #454 — Korean paste mojibake).
		// StdinBuffer is the single decoding boundary and decodes Buffers via a
		// persistent StringDecoder, so we forward raw Buffers untouched.
		process.stdin.resume();

		// Enable bracketed paste mode - terminal will wrap pastes in \x1b[200~ ... \x1b[201~
		this.#safeWrite("\x1b[?2004h");

		// Set up resize handler immediately
		process.stdout.on("resize", this.#resizeHandler);
		if (this.#stdoutErrorHandlerCleanupTimer) {
			clearTimeout(this.#stdoutErrorHandlerCleanupTimer);
			this.#stdoutErrorHandlerCleanupTimer = undefined;
		}
		if (!this.#stdoutErrorHandler) {
			this.#stdoutErrorHandler = (err: Error) => {
				this.#markUnavailable(err, "stdout-error");
			};
			process.stdout.on("error", this.#stdoutErrorHandler);
		}

		// Refresh terminal dimensions - they may be stale after suspend/resume
		// (SIGWINCH is lost while process is stopped). Unix only.
		if (process.platform !== "win32") {
			process.kill(process.pid, "SIGWINCH");
		}

		// On Windows, enable ENABLE_VIRTUAL_TERMINAL_INPUT so the console sends
		// VT escape sequences (e.g. \x1b[Z for Shift+Tab) instead of raw console
		// events that lose modifier information. Must run after setRawMode(true)
		// since that resets console mode flags.
		this.#enableWindowsVTInput();
		// Query and enable Kitty keyboard protocol
		// The query handler intercepts input temporarily, then installs the user's handler
		// See: https://sw.kovidgoyal.net/kitty/keyboard-protocol/
		this.#queryAndEnableKittyProtocol();

		// Query terminal background color via OSC 11 for dark/light detection.
		// Uses DA1 (Primary Device Attributes) as a sentinel: terminals process
		// sequences in order, so if DA1 arrives before OSC 11 response,
		// the terminal does not support OSC 11. This avoids indefinite hangs.
		// Technique used by Neovim, bat, fish, and terminal-colorsaurus.
		this.#queryBackgroundColor();

		// Subscribe to Mode 2031 appearance change notifications.
		// When the terminal reports a change, we re-query OSC 11 to get the
		// actual background color (following Neovim convention) with 100ms debounce.
		this.#safeWrite("\x1b[?2031h");

		// Start periodic OSC 11 re-query for terminals without Mode 2031
		// (Warp, Alacritty, WezTerm, iTerm2). Self-disables once Mode 2031 fires.
		// Windows Terminal under WSL has been observed to close the hosting tab
		// after repeated OSC 11/DA1 probes. Keep the initial/event-driven probes,
		// but avoid background polling there.
		if (!isWindowsSubsystemForLinux()) {
			this.#startOsc11Poll();
		}
	}

	/**
	 * On Windows, add ENABLE_VIRTUAL_TERMINAL_INPUT to the stdin console mode
	 * so modified keys (for example Shift+Tab) arrive as VT escape sequences.
	 */
	#enableWindowsVTInput(): void {
		if (process.platform !== "win32") return;
		this.#restoreWindowsVTInput();
		try {
			const kernel32 = dlopen("kernel32.dll", {
				GetStdHandle: { args: [FFIType.i32], returns: FFIType.ptr },
				GetConsoleMode: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.bool },
				SetConsoleMode: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.bool },
			});
			const handle = kernel32.symbols.GetStdHandle(STD_INPUT_HANDLE);
			const mode = new Uint32Array(1);
			const modePtr = ptr(mode);
			if (!modePtr || !kernel32.symbols.GetConsoleMode(handle, modePtr)) {
				kernel32.close();
				return;
			}
			const originalMode = mode[0]!;
			const vtMode = originalMode | ENABLE_VIRTUAL_TERMINAL_INPUT;
			if (vtMode !== originalMode && !kernel32.symbols.SetConsoleMode(handle, vtMode)) {
				kernel32.close();
				return;
			}
			this.#windowsVTInputRestore = () => {
				try {
					kernel32.symbols.SetConsoleMode(handle, originalMode);
				} finally {
					kernel32.close();
				}
			};
		} catch {
			// bun:ffi unavailable or console API unsupported; keep startup non-fatal.
		}
	}

	#restoreWindowsVTInput(): void {
		if (process.platform !== "win32") return;
		const restore = this.#windowsVTInputRestore;
		this.#windowsVTInputRestore = undefined;
		if (!restore) return;
		try {
			restore();
		} catch {
			// Ignore restore errors during terminal teardown.
		}
	}

	/**
	 * Set up StdinBuffer to split batched input into individual sequences.
	 * This ensures components receive single events, making matchesKey/isKeyRelease work correctly.
	 *
	 * Also watches for Kitty protocol response and enables it when detected.
	 * This is done here (after stdinBuffer parsing) rather than on raw stdin
	 * to handle the case where the response arrives split across multiple events.
	 */
	#setupStdinBuffer(): void {
		this.#stdinBuffer = new StdinBuffer({ timeout: 10 });

		// Kitty protocol response pattern: \x1b[?<flags>u
		const kittyResponsePattern = /^\x1b\[\?(\d+)u$/;

		// Mode 2031 DSR response: \x1b[?997;{1=dark,2=light}n
		const appearanceDsrPattern = /^\x1b\[\?997;([12])n$/;

		// OSC 11 response: \x1b]11;rgb:RR/GG/BB or rgba:RR/GG/BB, terminated by BEL or ST.
		const osc11ResponsePattern =
			/^\x1b\]11;rgba?:([0-9a-fA-F]{1,4})\/([0-9a-fA-F]{1,4})\/([0-9a-fA-F]{1,4})(?:\x07|\x1b\\)$/;

		// DA1 (Primary Device Attributes) response: \x1b[?...c
		const da1ResponsePattern = /^\x1b\[\?[\d;]*c$/;

		// Private CSI partial: \x1b[?<digits/semicolons>... — incomplete probe response
		// that the StdinBuffer flushed before the terminator arrived (split across
		// stdin reads). Used to reassemble DA1, kitty, and Mode 2031 replies.
		const privateCsiPartialPattern = /^\x1b\[\?[\d;]*$/;

		// Forward individual sequences to the input handler
		this.#stdinBuffer.on("data", (sequence: string) => {
			// Reassemble split private CSI responses (DA1, kitty keyboard, Mode 2031).
			// When the terminal writes the response slowly enough that the StdinBuffer's
			// flush timeout elapses mid-sequence, the prefix `\x1b[?<digits>` arrives as
			// one event and the tail `;...<terminator>` arrives as individual character
			// events that would otherwise leak into the prompt as keystrokes. See #1238.
			if (
				this.#privateCsiResponseBuffer ||
				(privateCsiPartialPattern.test(sequence) && this.#pendingDa1Sentinels > 0)
			) {
				if (this.#privateCsiResponseBuffer && sequence.startsWith("\x1b")) {
					// New escape arrived mid-reassembly — abandon partial and re-process the new sequence.
					this.#privateCsiResponseBuffer = "";
				} else {
					this.#privateCsiResponseBuffer += sequence;
					// Cap accumulator to defend against runaway partials if the terminator never arrives.
					if (this.#privateCsiResponseBuffer.length > 256) {
						this.#privateCsiResponseBuffer = "";
						return;
					}
					const lastChar = this.#privateCsiResponseBuffer.at(-1)!;
					const lastCode = lastChar.charCodeAt(0);
					if (lastCode >= 0x40 && lastCode <= 0x7e) {
						// Terminator byte arrived. Fall through to the pattern checks with the
						// reassembled sequence so the existing DA1/kitty/Mode 2031 handlers run.
						sequence = this.#privateCsiResponseBuffer;
						this.#privateCsiResponseBuffer = "";
					} else if (!privateCsiPartialPattern.test(this.#privateCsiResponseBuffer)) {
						// Diverged from a valid private CSI prefix (unexpected byte). Drop the
						// probe noise we ate; do not forward to the input handler.
						this.#privateCsiResponseBuffer = "";
						return;
					} else {
						// Still accumulating.
						return;
					}
				}
			}

			// Check for Kitty protocol response (only if not already enabled)
			if (!this.#kittyProtocolActive) {
				const match = sequence.match(kittyResponsePattern);
				if (match) {
					if (this.#modifyOtherKeysTimeout) {
						clearTimeout(this.#modifyOtherKeysTimeout);
						this.#modifyOtherKeysTimeout = undefined;
					}
					this.#kittyProtocolActive = true;
					setKittyProtocolActive(true);

					// Enable Kitty keyboard protocol (push flags)
					// Flag 1 = disambiguate escape codes
					// Flag 2 = report event types (press/repeat/release)
					// Flag 4 = report alternate keys
					this.#safeWrite("\x1b[>7u");
					return; // Don't forward protocol response to TUI
				}
			}

			// DA1 response: swallow our sentinel reply regardless of whether OSC 11
			// already succeeded. Other terminal probes should never see these replies.
			if (da1ResponsePattern.test(sequence) && this.#pendingDa1Sentinels > 0) {
				this.#pendingDa1Sentinels--;
				if (this.#osc11Pending) {
					// DA1 arrived before OSC 11 response: terminal does not support
					// OSC 11. Clear the pending state without starting a queued query
					// (queued query is started below, after sentinel is consumed).
					this.#osc11Pending = false;
					this.#osc11ResponseBuffer = "";
				}
				// Now that this DA1 cycle is complete, start any queued query.
				if (this.#osc11QueryQueued && !this.#dead) {
					this.#osc11QueryQueued = false;
					this.#startOsc11Query();
				}
				return;
			}

			// OSC 11 replies can be split if the stdin buffer flushes a partial sequence.
			// Accumulate fragments until the BEL/ST terminator arrives, then parse once.
			// If a new escape sequence arrives (not the ST terminator), abort buffering
			// and forward it as normal input so user keystrokes are never swallowed.
			if (this.#osc11Pending && (this.#osc11ResponseBuffer || sequence.startsWith("\x1b]11;"))) {
				if (this.#osc11ResponseBuffer && sequence.startsWith("\x1b") && sequence !== "\x1b\\") {
					// New escape sequence arrived mid-buffer — not an OSC 11 continuation.
					this.#osc11ResponseBuffer = "";
					// Fall through to normal input handling below.
				} else {
					this.#osc11ResponseBuffer += sequence;
					const osc11Match = this.#osc11ResponseBuffer.match(osc11ResponsePattern);
					if (!osc11Match) return;
					const [, rHex, gHex, bHex] = osc11Match;
					this.#osc11Pending = false;
					this.#osc11ResponseBuffer = "";
					this.#handleOsc11Response(rHex!, gHex!, bHex!);
					return;
				}
			}

			// Mode 2031 change notification: re-query OSC 11 with 100ms debounce
			// (Neovim convention — coalesces rapid notifications during transitions)
			const appearanceMatch = sequence.match(appearanceDsrPattern);
			if (appearanceMatch) {
				this.#stopOsc11Poll();
				if (this.#mode2031DebounceTimer) clearTimeout(this.#mode2031DebounceTimer);
				this.#mode2031DebounceTimer = setTimeout(() => {
					this.#mode2031DebounceTimer = undefined;
					this.#queryBackgroundColor();
				}, 100);
				return;
			}
			if (this.#inputHandler) {
				this.#inputHandler(sequence);
			}
		});

		// Re-wrap paste content with bracketed paste markers for existing editor handling
		this.#stdinBuffer.on("paste", (content: string) => {
			if (this.#inputHandler) {
				this.#inputHandler(`\x1b[200~${content}\x1b[201~`);
			}
		});

		// Handler that pipes stdin data through the buffer
		this.#stdinDataHandler = (data: string | Buffer) => {
			this.#stdinBuffer!.process(data);
		};
	}

	/**
	 * Send OSC 11 background color query followed by DA1 sentinel.
	 * DA1 avoids indefinite hangs: if DA1 response arrives before OSC 11,
	 * the terminal does not support OSC 11.
	 */
	#queryBackgroundColor(): void {
		if (this.#dead) return;
		// Queue if an OSC 11 query is in flight or its DA1 sentinel hasn't been
		// consumed yet. Starting a new query while a DA1 is outstanding would
		// increment the sentinel counter, and the old DA1 arrival would then
		// prematurely clear the new query's pending state.
		if (this.#osc11Pending || this.#pendingDa1Sentinels > 0) {
			this.#osc11QueryQueued = true;
			return;
		}
		this.#startOsc11Query();
	}

	#startOsc11Query(): void {
		this.#osc11Pending = true;
		this.#osc11ResponseBuffer = "";
		this.#pendingDa1Sentinels++;
		this.#safeWrite("\x1b]11;?\x07"); // OSC 11 query (BEL terminated)
		this.#safeWrite("\x1b[c"); // DA1 sentinel
	}
	/**
	 * Parse an OSC 11 background color response and compute BT.601 luminance.
	 * Handles 1-, 2-, 3-, and 4-digit XParseColor hex components.
	 */
	#handleOsc11Response(rHex: string, gHex: string, bHex: string): void {
		const normalize = (hex: string): number => {
			const value = parseInt(hex, 16);
			if (Number.isNaN(value)) return 0;
			const max = 16 ** hex.length - 1;
			return max > 0 ? value / max : 0;
		};
		const luminance = 0.299 * normalize(rHex) + 0.587 * normalize(gHex) + 0.114 * normalize(bHex);
		const mode: TerminalAppearance = luminance < 0.5 ? "dark" : "light";
		if (mode === this.#appearance) return;
		this.#appearance = mode;
		for (const cb of this.#appearanceCallbacks) {
			try {
				cb(mode);
			} catch {
				/* ignore callback errors */
			}
		}
	}

	/**
	 * Start periodic OSC 11 re-queries for terminals without Mode 2031 (Warp, Alacritty, WezTerm).
	 * Self-disables once Mode 2031 fires (push-based is better than polling).
	 */
	#startOsc11Poll(): void {
		this.#stopOsc11Poll();
		this.#osc11PollTimer = setInterval(() => {
			if (this.#dead) {
				this.#stopOsc11Poll();
				return;
			}
			this.#queryBackgroundColor();
		}, 2_000);
		this.#osc11PollTimer.unref();
	}

	#stopOsc11Poll(): void {
		if (this.#osc11PollTimer) {
			clearInterval(this.#osc11PollTimer);
			this.#osc11PollTimer = undefined;
		}
	}

	/**
	 * Query terminal for Kitty keyboard protocol support and enable if available.
	 *
	 * Sends CSI ? u to query current flags. If terminal responds with CSI ? <flags> u,
	 * it supports the protocol and we enable it with CSI > 1 u.
	 *
	 * The response is detected in setupStdinBuffer's data handler, which properly
	 * handles the case where the response arrives split across multiple stdin events.
	 */
	#queryAndEnableKittyProtocol(): void {
		this.#setupStdinBuffer();
		process.stdin.on("data", this.#stdinDataHandler!);
		// Leave the keyboard in its default mode when enhanced input protocols are
		// disabled. Android Termius (and similar terminals) break IME/Hangul
		// composition when the Kitty keyboard protocol or modifyOtherKeys is active,
		// committing every intermediate composing jamo/syllable. Skipping the query
		// and the modifyOtherKeys fallback restores normal IME composition.
		if (!keyboardEnhancementEnabled()) {
			return;
		}
		this.#safeWrite("\x1b[?u");
		this.#modifyOtherKeysTimeout = setTimeout(() => {
			this.#modifyOtherKeysTimeout = undefined;
			if (this.#kittyProtocolActive || this.#modifyOtherKeysActive) {
				return;
			}
			this.#safeWrite("\x1b[>4;2m");
			this.#modifyOtherKeysActive = true;
		}, 150);
	}

	async drainInput(maxMs = 1000, idleMs = 50): Promise<void> {
		if (this.#kittyProtocolActive) {
			// Disable Kitty keyboard protocol first so any late key releases
			// do not generate new Kitty escape sequences.
			this.#safeWrite("\x1b[<u");
			this.#kittyProtocolActive = false;
			setKittyProtocolActive(false);
		}
		if (this.#modifyOtherKeysTimeout) {
			clearTimeout(this.#modifyOtherKeysTimeout);
			this.#modifyOtherKeysTimeout = undefined;
		}
		if (this.#modifyOtherKeysActive) {
			this.#safeWrite("\x1b[>4;0m");
			this.#modifyOtherKeysActive = false;
		}

		const previousHandler = this.#inputHandler;
		this.#inputHandler = undefined;

		let lastDataTime = Date.now();
		const onData = () => {
			lastDataTime = Date.now();
		};

		process.stdin.on("data", onData);
		const endTime = Date.now() + maxMs;

		try {
			while (true) {
				const now = Date.now();
				const timeLeft = endTime - now;
				if (timeLeft <= 0) break;
				if (now - lastDataTime >= idleMs) break;
				await new Promise(resolve => setTimeout(resolve, Math.min(idleMs, timeLeft)));
			}
		} finally {
			process.stdin.removeListener("data", onData);
			this.#inputHandler = previousHandler;
		}
	}

	stop(): void {
		// Unregister from emergency cleanup
		if (activeTerminal === this) {
			activeTerminal = null;
		}

		if (this.#clearProgressTimer()) {
			this.#safeWrite(TERMINAL_PROGRESS_CLEAR_SEQUENCE);
		}

		// Disable bracketed paste mode
		this.#safeWrite("\x1b[?2004l");
		this.#safeWrite("\x1b[?1000l");
		this.#safeWrite("\x1b[?1006l");

		// Disable Mode 2031 appearance change notifications
		this.#safeWrite("\x1b[?2031l");
		this.#stopOsc11Poll();
		if (this.#mode2031DebounceTimer) {
			clearTimeout(this.#mode2031DebounceTimer);
			this.#mode2031DebounceTimer = undefined;
		}
		this.#appearanceCallbacks = [];
		this.#osc11Pending = false;
		this.#osc11QueryQueued = false;
		this.#osc11ResponseBuffer = "";
		this.#privateCsiResponseBuffer = "";
		this.#pendingDa1Sentinels = 0;

		// Disable Kitty keyboard protocol if not already done by drainInput()
		if (this.#kittyProtocolActive) {
			this.#safeWrite("\x1b[<u");
			this.#kittyProtocolActive = false;
			setKittyProtocolActive(false);
		}
		if (this.#modifyOtherKeysTimeout) {
			clearTimeout(this.#modifyOtherKeysTimeout);
			this.#modifyOtherKeysTimeout = undefined;
		}
		if (this.#modifyOtherKeysActive) {
			this.#safeWrite("\x1b[>4;0m");
			this.#modifyOtherKeysActive = false;
		}

		this.#restoreWindowsVTInput();
		// Clean up StdinBuffer
		if (this.#stdinBuffer) {
			this.#stdinBuffer.destroy();
			this.#stdinBuffer = undefined;
		}

		// Remove event handlers
		if (this.#stdinDataHandler) {
			process.stdin.removeListener("data", this.#stdinDataHandler);
			this.#stdinDataHandler = undefined;
		}
		this.#inputHandler = undefined;
		this.#appearance = undefined;
		if (this.#resizeHandler) {
			process.stdout.removeListener("resize", this.#resizeHandler);
			this.#resizeHandler = undefined;
		}
		this.#scheduleStdoutErrorHandlerCleanup();

		// Pause stdin to prevent any buffered input (e.g., Ctrl+D) from being
		// re-interpreted after raw mode is disabled. This fixes a race condition
		// where Ctrl+D could close the parent shell over SSH.
		process.stdin.pause();

		// Restore raw mode state
		if (process.stdin.setRawMode) {
			process.stdin.setRawMode(this.#wasRaw);
		}
	}

	#scheduleStdoutErrorHandlerCleanup(): void {
		if (!this.#stdoutErrorHandler) return;
		if (this.#stdoutErrorHandlerCleanupTimer) clearTimeout(this.#stdoutErrorHandlerCleanupTimer);
		// Terminal restore writes above can fail asynchronously after stop() returns
		// when an SSH/Windows Terminal PTY disappears. Keep the stdout error listener
		// armed briefly so late EIO/EPIPE events mark the terminal unavailable instead
		// of surfacing as uncaught exceptions that kill the tmux pane.
		this.#stdoutErrorHandlerCleanupTimer = setTimeout(() => {
			if (this.#stdoutErrorHandler) {
				process.stdout.removeListener("error", this.#stdoutErrorHandler);
				this.#stdoutErrorHandler = undefined;
			}
			this.#stdoutErrorHandlerCleanupTimer = undefined;
		}, STDOUT_ERROR_HANDLER_GRACE_MS);
		this.#stdoutErrorHandlerCleanupTimer.unref?.();
	}

	write(data: string): void {
		this.#safeWrite(data);
		if (this.#writeLogPath) {
			try {
				fs.appendFileSync(this.#writeLogPath, data, { encoding: "utf8" });
			} catch {
				// Ignore logging errors
			}
		}
	}

	#safeWrite(data: string): void {
		if (this.#dead) return;
		// Skip control sequences when stdout isn't a TTY (piped output, tests, log
		// files). They serve no purpose there and would surface as visible noise.
		if (!process.stdout.isTTY) return;
		if (
			!process.stdout.writable ||
			process.stdout.destroyed ||
			process.stdout.closed ||
			process.stdout.writableEnded
		) {
			this.#markUnavailable(undefined, "stdout-closed");
			return;
		}
		try {
			process.stdout.write(data);
		} catch (err) {
			this.#markUnavailable(err, "write");
		}
	}

	#markUnavailable(err: unknown, operation: string): void {
		if (this.#dead) return;
		this.#dead = true;
		this.#clearProgressTimer();
		this.#stopOsc11Poll();
		if (this.#mode2031DebounceTimer) {
			clearTimeout(this.#mode2031DebounceTimer);
			this.#mode2031DebounceTimer = undefined;
		}
		if (this.#modifyOtherKeysTimeout) {
			clearTimeout(this.#modifyOtherKeysTimeout);
			this.#modifyOtherKeysTimeout = undefined;
		}
		this.#appendDetachDebugEvent(operation, err);
	}

	#appendDetachDebugEvent(operation: string, err: unknown): void {
		if (!this.#detachLogPath) return;
		const error = err instanceof Error ? err : undefined;
		const code =
			typeof (err as { code?: unknown } | undefined)?.code === "string" ? (err as { code: string }).code : undefined;
		const line = JSON.stringify({
			at: new Date().toISOString(),
			operation,
			code,
			name: error?.name,
			message: error?.message,
		});
		try {
			fs.appendFileSync(this.#detachLogPath, `${line}\n`, { encoding: "utf8" });
		} catch {
			// Ignore debug logging errors; the terminal is already unavailable.
		}
	}

	get available(): boolean {
		return !this.#dead;
	}

	get columns(): number {
		return resolveTerminalColumns();
	}

	get rows(): number {
		return resolveTerminalRows();
	}

	moveBy(lines: number): void {
		if (lines > 0) {
			// Move down
			this.#safeWrite(`\x1b[${lines}B`);
		} else if (lines < 0) {
			// Move up
			this.#safeWrite(`\x1b[${-lines}A`);
		}
		// lines === 0: no movement
	}

	hideCursor(): void {
		this.#safeWrite("\x1b[?25l");
	}

	showCursor(): void {
		this.#safeWrite("\x1b[?25h");
	}

	clearLine(): void {
		this.#safeWrite("\x1b[K");
	}

	clearFromCursor(): void {
		this.#safeWrite("\x1b[J");
	}

	clearScreen(): void {
		this.#safeWrite("\x1b[H\x1b[0J"); // Move to home (1,1) and clear from cursor to end
	}

	setTitle(title: string): void {
		// OSC 0;title BEL - set terminal window title
		this.#safeWrite(`\x1b]0;${title}\x07`);
	}

	setProgress(active: boolean): void {
		if (active) {
			this.#safeWrite(TERMINAL_PROGRESS_ACTIVE_SEQUENCE);
			if (!this.#progressTimer) {
				this.#progressTimer = setInterval(() => {
					this.#safeWrite(TERMINAL_PROGRESS_ACTIVE_SEQUENCE);
				}, TERMINAL_PROGRESS_KEEPALIVE_MS);
				this.#progressTimer.unref?.();
			}
		} else {
			this.#clearProgressTimer();
			this.#safeWrite(TERMINAL_PROGRESS_CLEAR_SEQUENCE);
		}
	}

	#clearProgressTimer(): boolean {
		if (!this.#progressTimer) return false;
		clearInterval(this.#progressTimer);
		this.#progressTimer = undefined;
		return true;
	}
}
