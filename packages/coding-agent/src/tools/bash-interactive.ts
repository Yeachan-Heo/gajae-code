import type { AgentToolContext } from "@gajae-code/agent-core";
import type { PtySession as NativePtySession, PtyRunResult } from "@gajae-code/natives";
import {
	type Component,
	extractPrintableText,
	getKeybindings,
	matchesKey,
	padding,
	parseKey,
	parseKittySequence,
	truncateToWidth,
	visibleWidth,
} from "@gajae-code/tui";
import { logger, sanitizeText } from "@gajae-code/utils";
import type { Terminal as XtermTerminalType } from "@xterm/headless";
import { Settings } from "../config/settings";
import { NON_INTERACTIVE_ENV } from "../exec/non-interactive-env";
import type { Theme } from "../modes/theme/theme";
import { OutputSink, type OutputSummary, type TerminalArtifactPublisher } from "../session/streaming-output";
import { sanitizeWithOptionalSixelPassthrough } from "../utils/sixel";
import { resolveBashOutputSinkHeadBytes, resolveBashOutputSinkTailBytes, resolveOutputMaxColumns } from "./output-meta";
import { formatStatusIcon, replaceTabs } from "./render-utils";

type PtySession = NativePtySession;
let ptySessionLoad: Promise<typeof import("@gajae-code/natives")["PtySession"]> | undefined;

async function ptySessionNative(): Promise<typeof import("@gajae-code/natives")["PtySession"]> {
	ptySessionLoad ??= Promise.resolve(
		(require("@gajae-code/natives") as { PtySession: typeof import("@gajae-code/natives")["PtySession"] }).PtySession,
	);
	return await ptySessionLoad;
}

export interface BashInteractiveResult extends OutputSummary {
	exitCode: number | undefined;
	cancelled: boolean;
	timedOut: boolean;
}

function normalizeCaptureChunk(chunk: string): string {
	const normalized = chunk.replace(/\r\n?/gu, "\n");
	return sanitizeWithOptionalSixelPassthrough(normalized, sanitizeText);
}

function normalizeInputForPty(data: string, applicationCursorKeysMode: boolean): string {
	const kitty = parseKittySequence(data);
	if (kitty?.eventType === 3) {
		return "";
	}
	const printableText = extractPrintableText(data);
	if (printableText) {
		return printableText;
	}
	if (!kitty) {
		return data;
	}
	const keyId = parseKey(data);
	if (!keyId) {
		return data;
	}
	const normalizedKey = keyId.toLowerCase();
	if (normalizedKey === "up") return applicationCursorKeysMode ? "\x1bOA" : "\x1b[A";
	if (normalizedKey === "down") return applicationCursorKeysMode ? "\x1bOB" : "\x1b[B";
	if (normalizedKey === "right") return applicationCursorKeysMode ? "\x1bOC" : "\x1b[C";
	if (normalizedKey === "left") return applicationCursorKeysMode ? "\x1bOD" : "\x1b[D";
	if (normalizedKey === "home") return applicationCursorKeysMode ? "\x1bOH" : "\x1b[H";
	if (normalizedKey === "end") return applicationCursorKeysMode ? "\x1bOF" : "\x1b[F";
	if (normalizedKey === "pageup") return "\x1b[5~";
	if (normalizedKey === "pagedown") return "\x1b[6~";
	if (normalizedKey === "insert") return "\x1b[2~";
	if (normalizedKey === "delete") return "\x1b[3~";
	if (normalizedKey === "shift+tab") return "\x1b[Z";
	if (normalizedKey === "enter") return "\r";
	if (normalizedKey === "tab") return "\t";
	if (normalizedKey === "space") return " ";
	if (normalizedKey === "backspace") return "\x7f";
	if (normalizedKey === "escape") return "\x1b";
	const ctrlMatch = /^ctrl\+([a-z])$/u.exec(normalizedKey);
	if (ctrlMatch) {
		const letter = ctrlMatch[1]!;
		return String.fromCharCode(letter.charCodeAt(0) - 96);
	}
	const altMatch = /^alt\+([a-z])$/u.exec(normalizedKey);
	if (altMatch) {
		return `\x1b${altMatch[1]!}`;
	}
	// For any other Kitty sequence with a printable codepoint, emit the character directly
	if (kitty.codepoint >= 32 && kitty.codepoint < 127) {
		let ch = String.fromCharCode(kitty.codepoint);
		// Apply ctrl modifier if present (modifier bit 4 = ctrl)
		if (kitty.modifier & 4) {
			const code = kitty.codepoint;
			if (code >= 97 && code <= 122) {
				ch = String.fromCharCode(code - 96);
			}
		}
		// Apply alt modifier if present (modifier bit 2 = alt)
		if (kitty.modifier & 2) {
			ch = `\x1b${ch}`;
		}
		return ch;
	}
	return data;
}
class BashInteractiveOverlayComponent implements Component {
	#terminal: XtermTerminalType;
	#state: "running" | "complete" | "timed_out" | "killed" = "running";
	#exitCode: number | undefined;
	#onInput: (data: string) => void = () => {};
	#onDismiss: () => void = () => {};
	#onDispose: () => void = () => {};
	#session: PtySession | null = null;
	#lastCols = 0;
	#lastRows = 0;
	#writeQueue: string[] = [];
	#writeOffset = 0;
	#flushResolvers: Array<() => void> = [];
	#writing = false;
	#onFoldKey: () => boolean = () => false;

	constructor(
		private readonly command: string,
		private readonly uiTheme: Theme,
		private readonly getTerminalRows: () => number,
		XtermTerminal: typeof XtermTerminalType,
	) {
		this.#terminal = new XtermTerminal({
			cols: 120,
			rows: 40,
			disableStdin: true,
			allowProposedApi: true,
			scrollback: 10_000,
		});
	}

	setHandlers(
		onInput: (data: string) => void,
		onDismiss: () => void,
		onDispose: () => void,
		onFoldKey: () => boolean,
	): void {
		this.#onInput = onInput;
		this.#onDismiss = onDismiss;
		this.#onDispose = onDispose;
		this.#onFoldKey = onFoldKey;
	}

	appendOutput(chunk: string): void {
		this.#writeQueue.push(chunk);
		this.#drainQueue();
	}

	#drainQueue(): void {
		if (this.#writing) return;
		if (this.#writeOffset >= this.#writeQueue.length) {
			this.#resolveFlushWaiters();
			return;
		}
		this.#writing = true;
		const data = this.#writeQueue[this.#writeOffset]!;
		this.#terminal.write(data, () => {
			this.#writing = false;
			this.#writeOffset += 1;
			if (this.#writeOffset >= this.#writeQueue.length) {
				this.#writeQueue = [];
				this.#writeOffset = 0;
				this.#resolveFlushWaiters();
			}
			this.#drainQueue();
		});
	}

	#resolveFlushWaiters(): void {
		if (this.#writing || this.#writeOffset < this.#writeQueue.length) return;
		if (this.#flushResolvers.length === 0) return;
		const resolvers = this.#flushResolvers;
		this.#flushResolvers = [];
		for (const resolve of resolvers) {
			resolve();
		}
	}

	flushOutput(): Promise<void> {
		if (!this.#writing && this.#writeOffset >= this.#writeQueue.length) {
			return Promise.resolve();
		}
		const { promise, resolve } = Promise.withResolvers<void>();
		this.#flushResolvers.push(resolve);
		return promise;
	}

	setSession(session: PtySession): void {
		this.#session = session;
	}

	setComplete(result: { exitCode: number | undefined; cancelled: boolean; timedOut: boolean }): void {
		this.#exitCode = result.exitCode;
		if (result.timedOut) {
			this.#state = "timed_out";
			return;
		}
		if (result.cancelled) {
			this.#state = "killed";
			return;
		}
		this.#state = "complete";
	}

	handleInput(data: string): void {
		if (this.#state === "running" && getKeybindings().matches(data, "app.tool.backgroundFold")) {
			if (this.#onFoldKey()) return;
		}
		if (this.#state === "running" && (matchesKey(data, "escape") || matchesKey(data, "esc"))) {
			this.#onDismiss();
			return;
		}
		if (this.#state !== "running") {
			return;
		}
		const normalizedInput = normalizeInputForPty(data, this.#terminal.modes.applicationCursorKeysMode);
		if (!normalizedInput) {
			return;
		}
		this.#onInput(normalizedInput);
	}
	#stateText(): string {
		if (this.#state === "running") return this.uiTheme.fg("warning", "running");
		if (this.#state === "timed_out") return this.uiTheme.fg("warning", "timed out");
		if (this.#state === "killed") return this.uiTheme.fg("warning", "killed");
		if (this.#exitCode === 0) return this.uiTheme.fg("success", "exit 0");
		if (this.#exitCode === undefined) return this.uiTheme.fg("warning", "exited");
		return this.uiTheme.fg("error", `exit ${this.#exitCode}`);
	}

	#readViewport(innerWidth: number, maxContentRows: number): string[] {
		this.#terminal.resize(innerWidth, maxContentRows);
		const buffer = this.#terminal.buffer.active;
		const viewportY = buffer.viewportY;
		const visibleLines: string[] = [];
		for (let i = 0; i < maxContentRows; i++) {
			const line = buffer.getLine(viewportY + i)?.translateToString(true) ?? "";
			visibleLines.push(truncateToWidth(replaceTabs(sanitizeText(line)), innerWidth));
		}
		return visibleLines;
	}
	render(width: number): string[] {
		const safeWidth = Math.max(20, width);
		const innerWidth = Math.max(1, safeWidth - 2);
		const maxOverlayRows = Math.max(5, Math.floor(this.getTerminalRows() * 0.8));
		const chromeRows = 4;
		const maxContentRows = Math.max(1, maxOverlayRows - chromeRows);
		// Propagate terminal resize to PTY session
		const currentCols = innerWidth;
		const currentRows = maxContentRows;
		if (this.#session && (currentCols !== this.#lastCols || currentRows !== this.#lastRows)) {
			this.#lastCols = currentCols;
			this.#lastRows = currentRows;
			try {
				this.#session.resize(currentCols, currentRows);
			} catch {
				// Session may have ended
			}
		}
		const statusIcon =
			this.#state === "running"
				? formatStatusIcon("running", this.uiTheme)
				: this.#state === "complete" && this.#exitCode === 0
					? formatStatusIcon("success", this.uiTheme)
					: formatStatusIcon("warning", this.uiTheme);
		const title = this.uiTheme.fg("accent", "Console");
		const statusBadge = `${this.uiTheme.fg("dim", this.uiTheme.format.bracketLeft)}${this.#stateText()}${this.uiTheme.fg("dim", this.uiTheme.format.bracketRight)}`;
		const prefix = `${statusIcon} ${title} `;
		const suffix = ` ${statusBadge}`;
		const available = Math.max(1, innerWidth - visibleWidth(prefix) - visibleWidth(suffix));
		const cmd = truncateToWidth(this.uiTheme.fg("muted", replaceTabs(this.command)), available);
		const header = truncateToWidth(`${prefix}${cmd}${suffix}`, innerWidth);
		const footer =
			this.#state === "running"
				? truncateToWidth(
						`${this.uiTheme.fg("warning", "esc")} ${this.uiTheme.fg("dim", "force-kill")} ${this.uiTheme.fg("dim", "· input forwarded to PTY")}`,
						innerWidth,
					)
				: truncateToWidth(this.uiTheme.fg("dim", "session finished"), innerWidth);
		const visibleLines = this.#readViewport(innerWidth, maxContentRows);
		const content = visibleLines.length > 0 ? visibleLines : [padding(innerWidth)];
		const borderHorizontal = this.uiTheme.fg("border", this.uiTheme.boxSharp.horizontal.repeat(innerWidth));
		const borderVertical = this.uiTheme.fg("border", this.uiTheme.boxSharp.vertical);
		const boxLine = (line: string) =>
			`${borderVertical}${line}${padding(Math.max(0, innerWidth - visibleWidth(line)))}${borderVertical}`;
		return [
			`${this.uiTheme.fg("border", this.uiTheme.boxSharp.topLeft)}${borderHorizontal}${this.uiTheme.fg("border", this.uiTheme.boxSharp.topRight)}`,
			boxLine(header),
			...content.map(boxLine),
			boxLine(footer),
			`${this.uiTheme.fg("border", this.uiTheme.boxSharp.bottomLeft)}${borderHorizontal}${this.uiTheme.fg("border", this.uiTheme.boxSharp.bottomRight)}`,
		];
	}

	invalidate(): void {}

	dispose(): void {
		this.#terminal.dispose();
		this.#onDispose();
	}
}

/** Live controls handed to the caller once the PTY run owns its session. */
export interface InteractivePtyControls {
	/**
	 * Detach the overlay and settle the foreground call with `foldResult`, leaving
	 * the process running and still writing into the sink. Idempotent.
	 */
	detachObserver: (foldResult: BashInteractiveResult) => "resolved" | "already-settled";
	/**
	 * Resolves with the run's real summary when the process actually ends,
	 * regardless of whether the foreground was folded. A folded run is delivered
	 * from this, so its result can never be silently dropped.
	 */
	terminalCompletion: Promise<BashInteractiveResult>;
	/** Kill the owned process during owner teardown; the observer never calls this. */
	kill: () => void;
	/** Stop forwarding the foreground abort signal after ownership transfers on fold. */
	detachForegroundCancellation: () => void;
}

export async function runInteractiveBashPty(
	ui: NonNullable<AgentToolContext["ui"]>,
	options: {
		command: string;
		cwd: string;
		timeoutMs: number;
		signal?: AbortSignal;
		env?: Record<string, string>;
		artifactPath?: string;
		artifactId?: string;
		artifactPublisher?: TerminalArtifactPublisher;
		spillThreshold?: number;
		headBytes?: number;
		settings?: Settings;
		/** Receives live controls once the session is running; used to register a fold. */
		onControls?: (controls: InteractivePtyControls) => void;
		onFoldKey?: () => boolean;
		onDismiss?: () => void;
		onOutput?: (chunk: string) => void;
	},
): Promise<BashInteractiveResult> {
	const settings = options.settings ?? (await Settings.currentOrInit());
	const { shell: resolvedShell } = settings.getShellConfig();
	const sink = new OutputSink({
		artifactPath: options.artifactPath,
		artifactId: options.artifactId,
		artifactPublisher: options.artifactPublisher,
		spillThreshold: options.spillThreshold ?? resolveBashOutputSinkTailBytes(settings),
		headBytes: options.headBytes ?? resolveBashOutputSinkHeadBytes(settings),
		maxColumns: resolveOutputMaxColumns(settings),
	});
	const { default: xterm } = await import("@xterm/headless");
	const XtermTerminal = xterm.Terminal;
	const PtySession = await ptySessionNative();

	// Ownership inversion: this runner owns the session and the sink from t0,
	// started OUTSIDE ui.custom. The overlay is only an observer view, so
	// dismissing it — or never creating it — can never kill the process.
	// Seed the real host geometry so the first frame renders at the user's size;
	// the overlay keeps resizing the session as it lays out. Fallbacks apply only
	// when the host exposes no terminal (tests, pipes).
	const initialPtySize = {
		cols: Math.max(20, (process.stdout.columns ?? 80) - 2),
		rows: Math.max(5, (process.stdout.rows ?? 24) - 4),
	};

	const session = new PtySession();
	const processAbortController = new AbortController();
	const forwardForegroundAbort = () => processAbortController.abort();
	if (options.signal?.aborted) processAbortController.abort();
	else options.signal?.addEventListener("abort", forwardForegroundAbort, { once: true });
	let observer: BashInteractiveOverlayComponent | undefined;
	let settleForeground: ((result: BashInteractiveResult) => void) | undefined;
	let settled = false;
	const foreground = Promise.withResolvers<BashInteractiveResult>();
	const terminal = Promise.withResolvers<BashInteractiveResult>();

	const settle = (result: BashInteractiveResult): "resolved" | "already-settled" => {
		if (settled) return "already-settled";
		settled = true;
		// Prefer ui.custom's own `done` so the overlay tears down through its normal
		// path; fall back to the outer promise when no overlay was ever attached.
		if (settleForeground) settleForeground(result);
		else foreground.resolve(result);
		return "resolved";
	};

	let finished = false;
	const finalize = (run: PtyRunResult): void => {
		if (finished) return;
		finished = true;
		observer?.setComplete({ exitCode: run.exitCode, cancelled: run.cancelled, timedOut: run.timedOut });
		void (async () => {
			await observer?.flushOutput();
			const summary = await sink.dump();
			const outcome: BashInteractiveResult = {
				exitCode: run.exitCode,
				cancelled: run.cancelled,
				timedOut: run.timedOut,
				...summary,
			};
			options.signal?.removeEventListener("abort", forwardForegroundAbort);
			// Publish the real outcome BEFORE settling: a folded run's foreground is
			// already gone, and this is the only path that can deliver its result.
			terminal.resolve(outcome);
			settle(outcome);
		})();
	};

	// The original deadline rides on the run itself, so a folded command expires
	// exactly when it would have in the foreground.
	void session
		.start(
			{
				command: options.command,
				cwd: options.cwd,
				timeoutMs: options.timeoutMs,
				env: { ...NON_INTERACTIVE_ENV, ...options.env },
				signal: processAbortController.signal,
				cols: initialPtySize.cols,
				rows: initialPtySize.rows,
				shell: resolvedShell,
			},
			(err, chunk) => {
				if (finished || err || !chunk) return;
				// The sink is fed unconditionally: output stays continuous across a
				// fold, when no overlay exists, and after the overlay is disposed.
				const normalizedChunk = normalizeCaptureChunk(chunk);
				sink.push(normalizedChunk);
				options.onOutput?.(normalizedChunk);
				observer?.appendOutput(chunk);
			},
		)
		.then(finalize)
		.catch(error => {
			sink.push(`PTY error: ${error instanceof Error ? error.message : String(error)}\n`);
			finalize({ exitCode: undefined, cancelled: false, timedOut: false });
		});

	options.onControls?.({
		terminalCompletion: terminal.promise,
		kill: () => session.kill(),
		detachForegroundCancellation: () => {
			options.signal?.removeEventListener("abort", forwardForegroundAbort);
		},
		detachObserver: (foldResult: BashInteractiveResult) => {
			const outcome = settle(foldResult);
			if (outcome === "resolved") observer = undefined;
			return outcome;
		},
	});

	// Folded (or already finished) before any view existed: there is nothing to
	// attach an observer to, so never await an overlay that will never be settled.
	if (settled) return await foreground.promise;

	try {
		const overlayResult = await Promise.race([
			foreground.promise,
			ui.custom<BashInteractiveResult>(
				(tui, uiTheme, _keybindings, done) => {
					settleForeground = done;
					const component = new BashInteractiveOverlayComponent(
						options.command,
						uiTheme,
						() => tui.terminal.rows,
						XtermTerminal,
					);
					component.setSession(session);
					// Observer view only: stdin still reaches the process while attached,
					// Escape explicitly force-kills, while disposal never kills the work.
					component.setHandlers(
						data => {
							try {
								session.write(data);
							} catch {
								// ignore writes after the command exits
							}
						},
						options.onDismiss ?? (() => session.kill()),
						() => {},
						options.onFoldKey ?? (() => false),
					);
					observer = component;
					return component;
				},
				{ overlay: true },
			),
		]);
		return overlayResult;
	} catch (error) {
		// Overlay creation or view init failed. The process is already running and
		// owned here, so surface the failure without orphaning it: the run keeps
		// writing to the sink and settles the foreground on its own.
		logger.warn("Interactive PTY overlay unavailable; continuing without the view", {
			error: error instanceof Error ? error.message : String(error),
		});
		observer = undefined;
		settleForeground = undefined;
		return await foreground.promise;
	}
}
