/**
 * herdr-core status reporter (OSC 7501, the Program Status Protocol).
 *
 * Terminals started by herdr-core (`hc`) — including every terminal in the Herdr
 * desktop app — export `HC_TERMINAL_ID`, not the herdr TUI's `HERDR_ENV` /
 * `HERDR_PANE_ID`, so `herdr-pane.ts` stays inactive there. herdr-core never
 * infers status from screen text: a program is an agent only when it writes
 * OSC 7501 reports to its own terminal. This reporter writes them so the
 * Agents sidebar, attention sounds, `hc wait` and `hc send`'s blocked guard
 * all see gjc's lifecycle:
 *
 *   ESC ] 7501 ; state=<idle|working|blocked>[:kind=question]:app=gjc ESC \
 *
 * States come from the same lifecycle mapping as the herdr TUI reporter. On
 * exit the report is retracted with `state=clear`, since herdr-core keeps the
 * last report while the terminal returns to its shell.
 *
 * Reporting is best-effort: it is a no-op outside an hc terminal or when stdout
 * is not a TTY (a nested `gjc -p` whose output a tool captures), and a failed
 * write never reaches the session. Only interactive sessions report: a `--mode
 * json` or `-p` run still owns stdout as its output stream, and an OSC sequence
 * between records would break a consumer reading that stream through a PTY.
 */
import * as fs from "node:fs";
import { logger } from "@gajae-code/utils";
import { createHerdrLifecycleListener, type HerdrAgentState, type HerdrSessionEvent } from "./herdr-pane";

const HC_TERMINAL_ID_ENV = "HC_TERMINAL_ID";
const APP_NAME = "gjc";
/** Retries for a synchronous write that makes no progress (EAGAIN, EINTR, 0 bytes). */
const SYNC_WRITE_STALL_LIMIT = 50;
const SYNC_WRITE_STALL_MS = 2;
const RETRYABLE_WRITE_CODES = new Set(["EAGAIN", "EINTR"]);

export type HerdrCoreStatus = HerdrAgentState | "clear";

/** Build one OSC 7501 report. Exported for tests. */
export function encodeHerdrCoreStatus(state: HerdrCoreStatus): string {
	const kind = state === "blocked" ? ":kind=question" : "";
	return `\x1b]7501;state=${state}${kind}:app=${APP_NAME}\x1b\\`;
}

/**
 * Write every byte of `data` synchronously. A nonblocking PTY descriptor under
 * backpressure can accept only a prefix, or refuse with EAGAIN; stopping there
 * would leave half an escape sequence and a status herdr-core never clears.
 * Bounded so an exit handler can never hang on a stuck terminal.
 */
export function writeFullySync(
	data: string,
	writeChunk: (bytes: Uint8Array, offset: number) => number,
	stall: (ms: number) => void = ms => Bun.sleepSync(ms),
): void {
	const bytes = Buffer.from(data);
	let offset = 0;
	let stalls = 0;
	while (offset < bytes.length) {
		let written = 0;
		try {
			written = writeChunk(bytes, offset);
		} catch (error) {
			if (!RETRYABLE_WRITE_CODES.has((error as NodeJS.ErrnoException).code ?? "")) throw error;
		}
		if (written > 0) {
			offset += written;
			stalls = 0;
			continue;
		}
		stalls += 1;
		if (stalls > SYNC_WRITE_STALL_LIMIT) {
			throw new Error(`terminal accepted ${offset} of ${bytes.length} bytes`);
		}
		stall(SYNC_WRITE_STALL_MS);
	}
}

export interface HerdrCoreStatusOptions {
	/** The session runs the interactive TUI, the only mode that does not use stdout as its output stream. */
	interactive: boolean;
	env?: NodeJS.ProcessEnv;
	isTTY?: () => boolean;
	/** Live reports. Goes through `process.stdout` so it stays ordered with TUI frames. */
	write?: (data: string) => void;
	/** The retraction on release. Synchronous: a buffered stdout write is dropped at process exit. */
	writeSync?: (data: string) => void;
}

export interface HerdrCoreStatusReporter {
	/** Last reported status, for tests and diagnostics. */
	readonly state: HerdrCoreStatus | null;
	/** Stop listening and retract the report. Idempotent. */
	release(): void;
}

/** Whether this process runs directly in an herdr-core terminal. */
export function isHerdrCoreTerminal(options: Omit<HerdrCoreStatusOptions, "interactive"> = {}): boolean {
	const env = options.env ?? process.env;
	const isTTY = options.isTTY ?? (() => process.stdout.isTTY === true);
	return Boolean(env[HC_TERMINAL_ID_ENV]?.trim()) && isTTY();
}

export function createHerdrCoreStatusReporter(
	subscribe: (listener: (event: HerdrSessionEvent) => void) => () => void,
	options: Omit<HerdrCoreStatusOptions, "interactive"> = {},
): HerdrCoreStatusReporter {
	const write = options.write ?? ((data: string) => process.stdout.write(data));
	const writeSync =
		options.writeSync ??
		((data: string) =>
			writeFullySync(data, (bytes, offset) =>
				fs.writeSync(process.stdout.fd, bytes, offset, bytes.length - offset),
			));
	let current: HerdrCoreStatus | null = null;
	let released = false;

	const send = (state: HerdrCoreStatus, writer: (data: string) => void = write): void => {
		if (state === current) return;
		current = state;
		try {
			writer(encodeHerdrCoreStatus(state));
		} catch (error) {
			logger.debug("herdr-core status write failed", { error: String(error) });
		}
	};

	let unsubscribe: (() => void) | null = subscribe(
		createHerdrLifecycleListener(state => {
			if (!released) send(state);
		}),
	);
	send("idle");

	return {
		get state() {
			return current;
		},
		release() {
			if (released) return;
			released = true;
			unsubscribe?.();
			unsubscribe = null;
			send("clear", writeSync);
		},
	};
}

export function installHerdrCoreStatusReporter(
	subscribe: (listener: (event: HerdrSessionEvent) => void) => () => void,
	options: HerdrCoreStatusOptions,
): HerdrCoreStatusReporter | null {
	if (!options.interactive || !isHerdrCoreTerminal(options)) return null;
	const reporter = createHerdrCoreStatusReporter(subscribe, options);
	// `exit` handlers must be synchronous; release() writes with writeSync.
	process.once("exit", reporter.release);
	return reporter;
}
