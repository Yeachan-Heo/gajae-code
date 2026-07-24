import { dlopen, FFIType, ptr } from "bun:ffi";
import * as fs from "node:fs";
import { $env, $flag, $pickenv } from "@gajae-code/utils";
import { setKittyProtocolActive } from "./keys";
import { StdinBuffer } from "./stdin-buffer";
import { isUnderTerminalMultiplexer } from "./terminal-capabilities";

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
	// Enable or disable opt-in SGR mouse reporting. Implementations that do not
	// own a real terminal may ignore this.
	setMouseEnabled?(enabled: boolean): void;
	/**
	 * Register a bounded terminal response parser before sending a query.
	 * Implementations with a shared stdin response registry consume matching
	 * frames before forwarding remaining bytes to TUI input listeners.
	 */
	registerResponse?<T>(request: TerminalResponseRequest<T>): (() => void) | undefined;

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

	// True for the real process stdin/stdout terminal (not virtual test terminals).
	readonly isProcessTerminal?: boolean;

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
const stdoutErrorSubscribers = new Set<(err: Error) => void>();
export function __stdoutErrorSubscriberCountForTests(): number {
	return stdoutErrorSubscribers.size;
}
export interface TerminalResponseFrame<T> {
	start: number;
	end: number;
	value: T;
}

export interface TerminalResponseParse<T> {
	frame?: TerminalResponseFrame<T>;
	partialStart?: number;
}

export interface TerminalResponseRequest<T> {
	/** Stable request identity; used by callers to correlate a completion. */
	id: string;
	/** Higher-priority requests win when two framers start at the same byte. */
	priority?: number;
	/** Parses the currently buffered bytes without mutating the input. */
	parse(buffer: string): TerminalResponseParse<T>;
	/** Called exactly once when a complete frame is consumed. */
	onComplete(value: T, frame: string): void;
	/** Called when the request expires before a complete frame arrives. */
	onExpire?: () => void;
	/** Maximum time this request may remain armed. */
	expiresInMs?: number;
}

export interface TerminalResponseRegistryOptions {
	maxBytes?: number;
	onForward?: (data: string) => void;
}
interface TerminalResponseRegistryEntry {
	request: TerminalResponseRequest<unknown>;
	serial: number;
	timer?: Timer;
}
/**
 * Serializes terminal probe response consumption.
 *
 * A response is consumed only after its request is armed and its framer has
 * produced a complete frame. Bytes before an armed frame, interrupted partial
 * frames, expired buffers, and over-limit buffers are returned unchanged.
 */
export class TerminalResponseRegistry {
	#buffer = "";
	#serial = 0;
	#maxBytes: number;
	#onForward?: (data: string) => void;
	#requests: TerminalResponseRegistryEntry[] = [];

	constructor(options: TerminalResponseRegistryOptions = {}) {
		this.#maxBytes = Math.max(1, Math.trunc(options.maxBytes ?? 4096));
		this.#onForward = options.onForward;
	}

	arm<T>(request: TerminalResponseRequest<T>): () => void {
		for (const entry of [...this.#requests]) {
			if (entry.request.id === request.id) this.#remove(entry);
		}
		const entry: TerminalResponseRegistryEntry = {
			request: request as TerminalResponseRequest<unknown>,
			serial: this.#serial++,
		};
		this.#requests.push(entry);
		if (request.expiresInMs !== undefined && request.expiresInMs > 0) {
			entry.timer = setTimeout(() => {
				this.#remove(entry);
				this.#emit(this.#drain());
				request.onExpire?.();
			}, request.expiresInMs);
			entry.timer.unref?.();
		}
		return () => this.#remove(entry);
	}

	/** Feed one decoded stdin chunk and return bytes that remain user input. */
	consume(data: string): string {
		if (data.length === 0) return "";
		this.#buffer += data;
		if (this.#buffer.length > this.#maxBytes) {
			const forwarded = this.#buffer;
			this.#buffer = "";
			this.#clearRequests();
			this.#emit(forwarded);
			return forwarded;
		}
		return this.#drain();
	}

	/** Forward and clear all buffered bytes, disarming every request. */
	stop(): string {
		this.#clearRequests();
		const forwarded = this.#buffer;
		this.#buffer = "";
		this.#emit(forwarded);
		return forwarded;
	}
	disarm(id: string): void {
		for (const entry of [...this.#requests]) {
			if (entry.request.id === id) this.#remove(entry);
		}
	}

	get pendingCount(): number {
		return this.#requests.length;
	}

	#drain(): string {
		let forwarded = "";
		for (;;) {
			if (this.#buffer.length === 0) break;
			const complete: Array<{
				entry: TerminalResponseRegistryEntry;
				frame: TerminalResponseFrame<unknown>;
			}> = [];
			let partialStart: number | undefined;
			for (const entry of this.#requests) {
				const parsed = entry.request.parse(this.#buffer);
				if (
					parsed.frame &&
					parsed.frame.start >= 0 &&
					parsed.frame.end > parsed.frame.start &&
					parsed.frame.end <= this.#buffer.length
				) {
					complete.push({ entry, frame: parsed.frame });
				} else if (
					parsed.partialStart !== undefined &&
					parsed.partialStart >= 0 &&
					parsed.partialStart < this.#buffer.length
				) {
					partialStart =
						partialStart === undefined ? parsed.partialStart : Math.min(partialStart, parsed.partialStart);
				}
			}
			if (partialStart !== undefined && complete.length > 0) {
				const earliestCompleteStart = Math.min(...complete.map(candidate => candidate.frame.start));
				const nextEscape = this.#buffer.indexOf("\x1b", partialStart + 1);
				if (nextEscape > partialStart && nextEscape <= earliestCompleteStart) {
					forwarded += this.#buffer.slice(0, nextEscape);
					this.#buffer = this.#buffer.slice(nextEscape);
					continue;
				}
			}
			if (complete.length > 0) {
				complete.sort(
					(a, b) =>
						a.frame.start - b.frame.start ||
						(b.entry.request.priority ?? 0) - (a.entry.request.priority ?? 0) ||
						a.entry.serial - b.entry.serial,
				);
				const selected = complete[0]!;
				forwarded += this.#buffer.slice(0, selected.frame.start);
				const frameText = this.#buffer.slice(selected.frame.start, selected.frame.end);
				this.#buffer = this.#buffer.slice(selected.frame.end);
				this.#remove(selected.entry);
				selected.entry.request.onComplete(selected.frame.value, frameText);
				continue;
			}
			if (partialStart !== undefined) {
				forwarded += this.#buffer.slice(0, partialStart);
				this.#buffer = this.#buffer.slice(partialStart);
				const nextEscape = this.#buffer.indexOf("\x1b", 1);
				if (nextEscape > 0) {
					forwarded += this.#buffer.slice(0, nextEscape);
					this.#buffer = this.#buffer.slice(nextEscape);
					continue;
				}
				break;
			}
			forwarded += this.#buffer;
			this.#buffer = "";
			break;
		}
		return forwarded;
	}

	#emit(data: string): void {
		if (data) this.#onForward?.(data);
	}

	#remove(entry: TerminalResponseRegistryEntry): void {
		const index = this.#requests.indexOf(entry);
		if (index < 0) return;
		this.#requests.splice(index, 1);
		if (entry.timer) clearTimeout(entry.timer);
	}

	#clearRequests(): void {
		for (const entry of this.#requests) {
			if (entry.timer) clearTimeout(entry.timer);
		}
		this.#requests = [];
	}
}
export function __stdoutErrorDispatcherInstalledForTests(): boolean {
	return process.stdout.listeners("error").includes(dispatchStdoutError);
}

function regexResponseParser<T>(
	completePattern: RegExp,
	partialPattern: RegExp,
	map: (match: RegExpExecArray) => T,
): (buffer: string) => TerminalResponseParse<T> {
	return (buffer: string): TerminalResponseParse<T> => {
		const complete = completePattern.exec(buffer);
		const partial = partialPattern.exec(buffer);
		if (complete && (partial === null || complete.index <= partial.index)) {
			return {
				frame: {
					start: complete.index,
					end: complete.index + complete[0].length,
					value: map(complete),
				},
			};
		}
		return partial ? { partialStart: partial.index } : {};
	};
}
const dispatchStdoutError = (err: Error): void => {
	for (const subscriber of stdoutErrorSubscribers) subscriber(err);
};

function subscribeToStdoutErrors(subscriber: (err: Error) => void): void {
	if (stdoutErrorSubscribers.size === 0) process.stdout.on("error", dispatchStdoutError);
	stdoutErrorSubscribers.add(subscriber);
}

function unsubscribeFromStdoutErrors(subscriber: (err: Error) => void): void {
	stdoutErrorSubscribers.delete(subscriber);
	if (stdoutErrorSubscribers.size === 0) process.stdout.removeListener("error", dispatchStdoutError);
}

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
	#responseRegistry?: TerminalResponseRegistry;
	#stdinDataHandler?: (data: string | Buffer) => void;
	#dead = false;
	#writeLogPath = $pickenv("GJC_TUI_WRITE_LOG", "PI_TUI_WRITE_LOG") || "";
	#detachLogPath = $env.PI_TUI_TERMINAL_DETACH_LOG || "";
	#windowsVTInputRestore?: () => void;
	#stdoutErrorHandler?: (err: Error) => void;
	#stdoutErrorHandlerCleanupTimer?: Timer;
	#appearanceCallbacks: Array<(appearance: TerminalAppearance) => void> = [];
	#appearance: TerminalAppearance | undefined;
	#osc11Pending = false;
	#osc11QueryQueued = false;
	#pendingDa1Sentinels = 0;
	#osc11PollTimer?: Timer;
	#mode2031DebounceTimer?: Timer;
	#progressTimer?: ReturnType<typeof setInterval>;
	#mouseEnabled = false;
	#started = false;

	get isProcessTerminal(): boolean {
		return true;
	}

	get kittyProtocolActive(): boolean {
		return this.#kittyProtocolActive;
	}

	get appearance(): TerminalAppearance | undefined {
		return this.#appearance;
	}

	registerResponse<T>(request: TerminalResponseRequest<T>): (() => void) | undefined {
		return this.#responseRegistry?.arm(request);
	}

	onAppearanceChange(callback: (appearance: TerminalAppearance) => void): void {
		this.#appearanceCallbacks.push(callback);
	}

	setMouseEnabled(enabled: boolean): void {
		this.#mouseEnabled = enabled && !isUnderTerminalMultiplexer(Bun.env);
		if (this.#started) this.#safeWrite(this.#mouseEnabled ? "\x1b[?1000h\x1b[?1006h" : "\x1b[?1000l\x1b[?1006l");
	}

	start(onInput: (data: string) => void, onResize: () => void): void {
		this.#inputHandler = onInput;
		this.#resizeHandler = onResize;
		this.#started = true;

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
		// SGR mouse reporting is opt-in and never enabled inside tmux or screen.
		if (this.#mouseEnabled) this.#safeWrite("\x1b[?1000h\x1b[?1006h");

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
			subscribeToStdoutErrors(this.#stdoutErrorHandler);
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
		let consumingSynchronously = false;
		this.#responseRegistry = new TerminalResponseRegistry({
			maxBytes: 512,
			onForward: data => {
				if (!consumingSynchronously) forwardInput(data);
			},
		});

		const armModeResponse = (): void => {
			this.#responseRegistry!.arm({
				id: "terminal.appearance.mode2031",
				parse: regexResponseParser(
					/\x1b\[\?997;([12])n/u,
					/\x1b\[\?997;[12]?$/u,
					match => (match[1] === "1" ? "dark" : "light"),
				),
				onComplete: () => {
					this.#stopOsc11Poll();
					if (this.#mode2031DebounceTimer) clearTimeout(this.#mode2031DebounceTimer);
					this.#mode2031DebounceTimer = setTimeout(() => {
						this.#mode2031DebounceTimer = undefined;
						this.#queryBackgroundColor();
					}, 100);
					armModeResponse();
				},
				onExpire: armModeResponse,
				expiresInMs: 1000,
			});
		};
		armModeResponse();

		/**
		 * TerminalResponseRegistry deliberately returns an interrupted probe and
		 * the following escape as one value. ProcessTerminal historically
		 * delivers each input escape separately, so discard the interrupted
		 * response prefix here while preserving the new user escape.
		 */
		const forwardInput = (data: string): void => {
			const inputHandler = this.#inputHandler;
			if (!inputHandler) return;

			let cursor = 0;
			let probeStart = data.indexOf("\x1b");
			while (probeStart >= 0) {
				const nextEscape = data.indexOf("\x1b", probeStart + 1);
				if (
					nextEscape > probeStart &&
					(/^\x1b\]11;[^\x1b\x07]*$/u.test(data.slice(probeStart, nextEscape)) ||
						/^\x1b\[\?[\d;]*$/u.test(data.slice(probeStart, nextEscape)))
				) {
					if (probeStart > cursor) inputHandler(data.slice(cursor, probeStart));
					cursor = nextEscape;
					probeStart = data.indexOf("\x1b", cursor);
					continue;
				}
				probeStart = data.indexOf("\x1b", probeStart + 1);
			}
			if (cursor < data.length) inputHandler(data.slice(cursor));
		};

		this.#stdinBuffer.on("data", (sequence: string) => {
			consumingSynchronously = true;
			let forwarded = "";
			try {
				forwarded = this.#responseRegistry!.consume(sequence);
			} finally {
				consumingSynchronously = false;
			}
			if (forwarded) forwardInput(forwarded);
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
		this.#osc11QueryQueued = false;
		this.#osc11Pending = true;
		this.#pendingDa1Sentinels++;
		this.#responseRegistry?.arm<{ r: string; g: string; b: string }>({
			id: "terminal.appearance.osc11",
			priority: 20,
			parse: regexResponseParser(
				/\x1b\]11;rgba?:([0-9a-fA-F]{1,4})\/([0-9a-fA-F]{1,4})\/([0-9a-fA-F]{1,4})(?:\x07|\x1b\\)/u,
				/\x1b\]11;[^\x07]*$/u,
				match => ({ r: match[1]!, g: match[2]!, b: match[3]! }),
			),
			onComplete: value => {
				this.#osc11Pending = false;
				this.#handleOsc11Response(value.r, value.g, value.b);
			},
			onExpire: () => {
				this.#osc11Pending = false;
			},
			expiresInMs: 1000,
		});
		this.#responseRegistry?.arm({
			id: "terminal.appearance.da1",
			priority: 10,
			parse: regexResponseParser(
				/\x1b\[\?[\d;]*c/u,
				/\x1b\[\?[\d;]*$/u,
				() => undefined,
			),
			onComplete: () => {
				this.#pendingDa1Sentinels = Math.max(0, this.#pendingDa1Sentinels - 1);
				if (this.#osc11Pending) {
					this.#osc11Pending = false;
					this.#responseRegistry?.disarm("terminal.appearance.osc11");
				}
				if (this.#pendingDa1Sentinels === 0 && this.#osc11QueryQueued && !this.#dead) {
					this.#osc11QueryQueued = false;
					this.#startOsc11Query();
				}
			},
			onExpire: () => {
				this.#pendingDa1Sentinels = Math.max(0, this.#pendingDa1Sentinels - 1);
				if (this.#osc11Pending) this.#osc11Pending = false;
			},
			expiresInMs: 1000,
		});
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
		this.#responseRegistry?.arm({
			id: "terminal.keyboard.kitty",
			priority: 30,
			parse: regexResponseParser(
				/\x1b\[\?(\d+)u/u,
				/\x1b\[\?\d*$/u,
				match => Number.parseInt(match[1]!, 10),
			),
			onComplete: () => {
				if (this.#modifyOtherKeysTimeout) {
					clearTimeout(this.#modifyOtherKeysTimeout);
					this.#modifyOtherKeysTimeout = undefined;
				}
				this.#kittyProtocolActive = true;
				setKittyProtocolActive(true);
				this.#safeWrite("\x1b[>7u");
			},
			expiresInMs: 150,
		});
		this.#safeWrite("\x1b[?u");
		// Windows Terminal and conhost do not implement the Kitty keyboard
		// protocol, so the query above never activates it there. They do honor the
		// modifyOtherKeys fallback below — but that mode breaks Windows CJK/Hangul
		// IME composition: Alt+Enter (and other chords) bypass the IME commit, so
		// the syllable still being composed is never delivered to the app and the
		// action fires on empty text (e.g. queue-message no-ops unless the user
		// types a trailing space to force a commit first). Skip the fallback on
		// win32; legacy encodings still deliver Alt+Enter (ESC CR) and the newline
		// chords, and IME composition works again. Opt back in with
		// GJC_TUI_KEYBOARD_PROTOCOL=0 disabling all enhancement, or force-enable
		// elsewhere if a Kitty-capable Windows terminal appears.
		if (process.platform === "win32") {
			return;
		}
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
		this.#started = false;
		this.#mouseEnabled = false;
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
		this.#responseRegistry?.stop();
		this.#responseRegistry = undefined;
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
				unsubscribeFromStdoutErrors(this.#stdoutErrorHandler);
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
		this.#responseRegistry?.stop();
		this.#responseRegistry = undefined;
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
