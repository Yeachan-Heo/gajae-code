/**
 * Centralized logger for gajae-code.
 *
 * Default: rotating `~/.gjc/logs/gjc.<DATE>.log`, no console output (writing
 * to stdout/stderr would corrupt the TUI). Long-running headless services
 * (the auth broker, etc.) call {@link setTransports} to swap in a console
 * transport so a process supervisor (pm2, journald, k8s) captures the logs.
 *
 * Each entry includes `process.pid` so concurrent gjc instances stay
 * traceable.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import * as fs from "node:fs";
import * as path from "node:path";
import type * as winston from "winston";
import { getEffectiveLogsDir } from "./dirs";

const LOG_DIR_MODE = 0o700;
const LOG_FILE_MODE = 0o600;

type LogPathPlatform = NodeJS.Platform | "posix";

function logPathKind(platform: LogPathPlatform): "posix" | "win32" {
	return platform === "win32" ? "win32" : "posix";
}

function isLogSeparator(char: string, platform: LogPathPlatform): boolean {
	return char === "/" || (logPathKind(platform) === "win32" && char === "\\");
}

/** A filesystem root. On POSIX a backslash is a file name, not a root or a separator. */
export function isFsRoot(target: string, platform: LogPathPlatform = process.platform): boolean {
	if (logPathKind(platform) === "win32") {
		return target === "/" || target === "\\" || /^[A-Za-z]:[\\/]$/.test(target);
	}
	if (target.length === 0) return false;
	for (const char of target) {
		if (char !== "/") return false;
	}
	return true;
}

/**
 * Drop trailing separators without changing the directory name.
 * POSIX removes only `/`. Windows also removes `\`.
 * A root keeps one separator so `C:\` does not become the drive-relative name `C:`.
 */
export function lexicalLogPath(target: string, platform: LogPathPlatform = process.platform): string {
	if (target.length === 0) return target;
	let end = target.length;
	while (end > 0 && isLogSeparator(target[end - 1] ?? "", platform)) {
		const kept = target.slice(0, end);
		const shorter = target.slice(0, end - 1);
		if (isFsRoot(kept, platform) && !isFsRoot(shorter, platform)) break;
		if (end === 1) break;
		end -= 1;
	}
	return target.slice(0, end);
}

function pathFor(platform: LogPathPlatform): { normalize(target: string): string } {
	return logPathKind(platform) === "win32" ? path.win32 : path.posix;
}

/** True when "." / ".." collapse to a filesystem root. Does not follow symlinks. */
export function resolvesAsFsRoot(target: string, platform: LogPathPlatform = process.platform): boolean {
	const lexical = lexicalLogPath(target, platform);
	if (isFsRoot(lexical, platform)) return true;
	const collapsed = lexicalLogPath(pathFor(platform).normalize(lexical), platform);
	return isFsRoot(collapsed, platform);
}

/** Skip mode repair for every spelling of a filesystem root. The transport path stays unchanged. */
function skipRootModeRepair(target: string): boolean {
	const lexical = lexicalLogPath(target);
	if (resolvesAsFsRoot(lexical) || resolvesAsFsRoot(path.resolve(lexical))) return true;
	try {
		return resolvesAsFsRoot(fs.realpathSync.native(lexical));
	} catch {
		return false;
	}
}

/** Drop a trailing "/." so "./link/." is judged as "./link". ".." is not collapsed. */
function pathForSymlinkCheck(target: string): string {
	let current = lexicalLogPath(target);
	const win = process.platform === "win32";
	for (;;) {
		const dot = current.endsWith("/.") || (win && current.endsWith("\\."));
		if (!dot) return current;
		current = lexicalLogPath(current.slice(0, -2));
	}
}

function isFinalSymlink(target: string): boolean {
	try {
		return fs.lstatSync(pathForSymlinkCheck(target)).isSymbolicLink();
	} catch {
		return false;
	}
}

/** True when this inode is the filesystem root. Unknown identity fails closed. */
function inodeIsFsRoot(st: fs.Stats): boolean {
	if (process.platform === "win32") return false;
	try {
		const root = fs.statSync("/");
		return st.dev === root.dev && st.ino === root.ino;
	} catch {
		return true;
	}
}

/** Clear group/world bits on this inode. A symlink, including a "." suffix, is not opened. */
function tightenOwnerOnly(target: string, mode: number, kind: "directory" | "file"): void {
	const lexical = lexicalLogPath(target);
	if (skipRootModeRepair(lexical) || isFinalSymlink(lexical)) return;
	// A trailing "/." is not the directory. lstat and O_NOFOLLOW must use the
	// same path the symlink check used, or a swapped link is followed.
	const repairPath = kind === "directory" ? pathForSymlinkCheck(lexical) : lexical;
	let fd: number | undefined;
	try {
		const listed = fs.lstatSync(repairPath);
		if (kind === "directory" ? !listed.isDirectory() : !listed.isFile()) return;
		if (inodeIsFsRoot(listed) || (listed.mode & 0o077) === 0) return;
		const noFollow = (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);
		const directoryFlag = kind === "directory" ? (fs.constants.O_DIRECTORY ?? 0) : 0;
		const writeOnly = fs.constants.O_WRONLY | noFollow;
		const readOnly = fs.constants.O_RDONLY | noFollow | directoryFlag;
		try {
			fd = fs.openSync(repairPath, kind === "file" ? writeOnly : readOnly);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "EACCES" && code !== "EPERM") throw error;
			try {
				if (kind !== "file") throw error;
				fd = fs.openSync(repairPath, fs.constants.O_RDONLY | noFollow);
			} catch (again) {
				const againCode = (again as NodeJS.ErrnoException).code;
				if (againCode !== "EACCES" && againCode !== "EPERM") throw again;
				reportSkippedRepair(kind);
				return;
			}
		}
		const opened = fs.fstatSync(fd);
		if (opened.dev !== listed.dev || opened.ino !== listed.ino || inodeIsFsRoot(opened)) return;
		if (kind === "directory" ? !opened.isDirectory() : !opened.isFile()) return;
		if ((opened.mode & 0o077) === 0) return;
		fs.fchmodSync(fd, mode);
	} catch {
		// A mode repair must not take logging down.
	} finally {
		if (fd !== undefined) {
			try {
				fs.closeSync(fd);
			} catch {
				// The mode was already repaired, or the close raced an exit.
			}
		}
	}
}

/** Ensure a logs directory exists at mode 0700; return the path the transport should use. */
function ensureDir(dir: string): string {
	const lexical = lexicalLogPath(dir);
	if (skipRootModeRepair(lexical) || isFinalSymlink(lexical)) return lexical;
	if (!fs.existsSync(lexical)) {
		fs.mkdirSync(lexical, { recursive: true, mode: LOG_DIR_MODE });
	}
	tightenOwnerOnly(lexical, LOG_DIR_MODE, "directory");
	return lexical;
}

type WinstonModule = typeof import("winston");
type DailyRotateFileCtor = typeof import("winston-daily-rotate-file");
type Logger = winston.Logger;
type Transport = winston.transport;
type LogLevel = "error" | "warn" | "info" | "debug";
type LogRecord = { level: LogLevel; message: string; context?: Record<string, unknown> };

let winstonModule: WinstonModule | undefined;
let dailyRotateFileCtor: DailyRotateFileCtor | undefined;
let winstonLogger: Logger | undefined;
let loggerInit: Promise<Logger> | undefined;
let flushingBufferedLogs = false;
let repairNoteQueued = false;
const bufferedLogs: LogRecord[] = [];
/** Cap pre-init buffering so a hung/failed winston import cannot grow heap unboundedly. */
const MAX_BUFFERED_LOGS = 10_000;
let transportOptions: { console?: boolean; file?: boolean | string } = { file: true };

async function loadLoggingModules(): Promise<{ winston: WinstonModule; DailyRotateFile: DailyRotateFileCtor }> {
	if (!winstonModule || !dailyRotateFileCtor) {
		const [winstonImport, dailyRotateFileImport] = await Promise.all([
			import("winston"),
			import("winston-daily-rotate-file"),
		]);
		winstonModule = (winstonImport.default ?? winstonImport) as WinstonModule;
		dailyRotateFileCtor = dailyRotateFileImport.default;
	}
	return { winston: winstonModule, DailyRotateFile: dailyRotateFileCtor };
}

/** Build the JSON log formatter after winston is loaded. */
function makeLogFormat(winston: WinstonModule): winston.Logform.Format {
	return winston.format.combine(
		winston.format.timestamp({ format: "YYYY-MM-DDTHH:mm:ss.SSSZ" }),
		winston.format.printf(({ timestamp, level, message, ...meta }) => {
			const entry: Record<string, unknown> = {
				timestamp,
				level,
				pid: process.pid,
				message,
			};
			// Flatten metadata into entry
			for (const [key, value] of Object.entries(meta)) {
				if (key !== "level" && key !== "timestamp" && key !== "message") {
					entry[key] = value;
				}
			}
			return JSON.stringify(entry);
		}),
	);
}

/**
 * Build a rotating file transport, materializing the target directory lazily.
 *
 * Destination precedence:
 *   1. `dir` — an explicit path from {@link setTransports}(`{ file: "<path>" }`).
 *   2. {@link getEffectiveLogsDir} — the provenance-checked `GJC_LOG_DIR`
 *      override, else the real config root (`~/.gjc/logs`).
 *
 * The resolution is centralized in `dirs.ts` rather than read from the
 * environment here: the log *readers* (report bundles, the debug log view, the
 * HTTP dump directory) call the same helper, and a second env read in this file
 * is what let the transport write somewhere the readers never looked.
 */
function makeFileTransport(DailyRotateFile: DailyRotateFileCtor, dir?: string): Transport {
	const dirname = ensureDir(dir ?? getEffectiveLogsDir());
	const transport = new DailyRotateFile({
		dirname,
		filename: "gjc.%DATE%.log",
		datePattern: "YYYY-MM-DD",
		maxSize: "10m",
		maxFiles: 5,
		zippedArchive: true,
		// `options` replaces the library default `{ flags: "a" }`. Keep append so
		// an existing log is not truncated. `mode` applies when the file is created.
		options: { flags: "a", mode: LOG_FILE_MODE },
	});
	// winston-daily-rotate-file never listens on its file-stream-rotator stream,
	// so a failed open or write of the log file (EACCES, EISDIR, EMFILE, the log
	// directory removed under a live process) is emitted with no listener and
	// becomes an uncaught exception from a single `logger.warn()`.
	const stream = transport.logStream as unknown as NodeJS.EventEmitter;
	let currentLog: string | undefined;
	const repairLog = (): void => {
		if (!currentLog) return;
		tightenOwnerOnly(currentLog, LOG_FILE_MODE, "file");
	};
	// `new` names the active file (including one that already existed at 0666).
	// `open` runs after a newly created file exists, so a late create is covered.
	stream.on("new", (file: unknown) => {
		if (typeof file !== "string") return;
		currentLog = file;
		repairLog();
	});
	stream.on("open", repairLog);
	stream.on("error", ignoreSinkError);
	return transport;
}

/** Logging failures must never take the process down; the record is dropped. */
function ignoreSinkError(): void {}

function makeConsoleTransport(winston: WinstonModule): Transport {
	return new winston.transports.Console({ format: makeLogFormat(winston) });
}

function applyTransports(
	logger: Logger,
	modules: { winston: WinstonModule; DailyRotateFile: DailyRotateFileCtor },
): void {
	logger.clear();
	logger.silent = !transportOptions.console && !transportOptions.file;
	if (transportOptions.file) {
		logger.add(
			makeFileTransport(
				modules.DailyRotateFile,
				typeof transportOptions.file === "string" ? transportOptions.file : undefined,
			),
		);
	}
	if (transportOptions.console) logger.add(makeConsoleTransport(modules.winston));
}

/** The winston logger instance. Default: file ON (TUI-safe), console OFF. */
async function getWinstonLogger(): Promise<Logger> {
	if (winstonLogger) return winstonLogger;
	loggerInit ??= (async () => {
		const modules = await loadLoggingModules();
		const logger = modules.winston.createLogger({
			level: "debug",
			format: makeLogFormat(modules.winston),
			transports: [],
			// Don't exit on error - logging failures shouldn't crash the app
			exitOnError: false,
		});
		// winston re-emits every transport `error` on the logger itself; with no
		// listener that re-emit throws.
		logger.on("error", ignoreSinkError);
		applyTransports(logger, modules);
		winstonLogger = logger;
		flushBufferedLogs();
		return logger;
	})();
	return loggerInit;
}

function flushBufferedLogs(): void {
	if (!winstonLogger || flushingBufferedLogs) return;
	flushingBufferedLogs = true;
	try {
		// Loop: records buffered by reentrant writes during a flush pass (e.g.
		// a transport callback that logs) are drained by the next pass instead
		// of being stranded forever.
		while (bufferedLogs.length > 0) {
			for (const record of bufferedLogs.splice(0)) {
				winstonLogger[record.level](record.message, record.context);
			}
		}
	} finally {
		flushingBufferedLogs = false;
	}
}

/**
 * A skipped mode repair is logged through the transports already configured.
 * The default is file-only, so this must not write the terminal. Console
 * output stays opt-in via {@link setTransports}(`{ console: true }`).
 */
function reportSkippedRepair(kind: "directory" | "file"): void {
	if (flushingBufferedLogs) return;
	if (!transportOptions.console && !transportOptions.file) return;
	bufferedLogs.push({
		level: "error",
		message: `rotating log mode repair skipped for an unopenable ${kind}`,
	});
	if (bufferedLogs.length > MAX_BUFFERED_LOGS) {
		bufferedLogs.splice(0, bufferedLogs.length - MAX_BUFFERED_LOGS);
	}
	// Init flushes after the transports exist. A later repair runs from a
	// stream callback, so deliver it after that callback returns.
	if (!winstonLogger || repairNoteQueued) return;
	repairNoteQueued = true;
	queueMicrotask(() => {
		repairNoteQueued = false;
		try {
			flushBufferedLogs();
		} catch {
			// A repair notice must not take logging down.
		}
	});
}

function writeLog(level: LogLevel, message: string, context?: Record<string, unknown>): void {
	try {
		if (winstonLogger && !flushingBufferedLogs) {
			winstonLogger[level](message, context);
			return;
		}
		bufferedLogs.push({ level, message, context });
		if (bufferedLogs.length > MAX_BUFFERED_LOGS) {
			bufferedLogs.splice(0, bufferedLogs.length - MAX_BUFFERED_LOGS);
		}
		void getWinstonLogger().catch(() => {
			bufferedLogs.length = 0;
			// Allow a later write to retry initialization instead of pinning a
			// rejected promise forever.
			loggerInit = undefined;
		});
	} catch {
		// Silently ignore logging failures
	}
}

/**
 * Replace the active log transports. Pass `console: true, file: false` for
 * long-running services (the auth broker, etc.) that want their structured
 * logs piped into a process supervisor instead of the rotating file.
 */
export function setTransports(opts: { console?: boolean; file?: boolean | string }): void {
	transportOptions = opts;
	if (winstonLogger && winstonModule && dailyRotateFileCtor) {
		applyTransports(winstonLogger, { winston: winstonModule, DailyRotateFile: dailyRotateFileCtor });
	} else if (loggerInit) {
		// Init in flight: re-apply once it settles so the new options can never
		// be silently skipped by an ordering race inside the init closure.
		void loggerInit
			.then(logger => {
				if (winstonModule && dailyRotateFileCtor) {
					applyTransports(logger, { winston: winstonModule, DailyRotateFile: dailyRotateFileCtor });
				}
			})
			.catch(() => {});
	}
}

/**
 * Log an error message.
 * @param message - The message to log.
 * @param context - The context to log.
 */
export function error(message: string, context?: Record<string, unknown>): void {
	writeLog("error", message, context);
}

/**
 * Log a warning message.
 * @param message - The message to log.
 * @param context - The context to log.
 */
export function warn(message: string, context?: Record<string, unknown>): void {
	writeLog("warn", message, context);
}

/**
 * Log an informational message.
 * @param message - The message to log.
 * @param context - The context to log.
 */
export function info(message: string, context?: Record<string, unknown>): void {
	writeLog("info", message, context);
}

/**
 * Log a debug message.
 * @param message - The message to log.
 * @param context - The context to log.
 */
export function debug(message: string, context?: Record<string, unknown>): void {
	writeLog("debug", message, context);
}

const LOGGED_TIMING_THRESHOLD_MS = 0.5;

interface Span {
	op: string;
	start: number;
	end?: number;
	parent?: Span;
	children: Span[];
	/** Marker / point event without a duration. */
	point?: boolean;
}

const spanStorage = new AsyncLocalStorage<Span>();
let gRootSpan: Span | undefined;
let gRecordTimings = false;

/**
 * Print collected timings as an indented tree.
 * Each span shows wall duration; parents with children also show "(self)" for unattributed time.
 * Sibling spans are sorted by start time. Spans whose intervals overlap with siblings ran in parallel.
 */
export function printTimings(): void {
	if (!gRecordTimings || !gRootSpan) {
		console.error("\n--- Startup Timings ---\n(no markers)\n");
		return;
	}

	gRootSpan.end = performance.now();
	// Close still-open spans (e.g. cli:dispatch, which wraps the very run that
	// prints) so they report elapsed-at-print instead of a misleading 0ms.
	const root = gRootSpan;
	const printNow = root.end;
	const closeOpenSpans = (span: Span): void => {
		for (const child of span.children) closeOpenSpans(child);
		if (span.end === undefined && !span.point) span.end = printNow;
	};
	closeOpenSpans(root);
	const lines: string[] = [];
	lines.push("");
	lines.push("--- Startup timings (hierarchical) ---");
	for (const child of [...gRootSpan.children].sort((a, b) => a.start - b.start)) {
		printSpan(child, 0, lines);
	}
	const totalMs = (gRootSpan.end - gRootSpan.start).toFixed(1);
	lines.push(`Total: ${totalMs}ms`);
	lines.push("--------------------------------------");
	lines.push("");
	console.error(lines.join("\n"));
	gRootSpan.end = undefined;
}

/**
 * Begin recording startup timings under a new root span.
 * Idempotent: a second call while already recording is a no-op so that the
 * early starter (cli.ts, the first CLI statement) and the explicit starter
 * (main.ts) can coexist.
 *
 * The root is anchored at the process-start origin rather than at the call:
 * `performance.now()` counts milliseconds since `performance.timeOrigin`
 * (process start) on Bun, so `start: 0` makes `Total` the true
 * time-since-process-start. Runtime bootstrap plus static module linking and
 * evaluation then land in the root's self time instead of being invisible
 * before the first statement of cli.ts.
 */
export function startTiming(): void {
	if (gRecordTimings) return;
	gRootSpan = {
		op: "(root)",
		start: 0,
		parent: undefined,
		children: [],
	};
	gRecordTimings = true;
}

/**
 * End timing window and clear buffers.
 */
export function endTiming(): void {
	gRootSpan = undefined;
	gRecordTimings = false;
}

function durationOf(span: Span): number {
	if (span.point || span.end === undefined) return 0;
	return span.end - span.start;
}

/** Self time = total - union of child intervals (handles parallel children correctly). */
function selfTimeOf(span: Span): number {
	const dur = durationOf(span);
	if (span.children.length === 0 || span.point) return dur;
	const intervals = span.children
		.filter(c => !c.point && c.end !== undefined)
		.map(c => [c.start, c.end as number] as const)
		.sort((a, b) => a[0] - b[0]);
	if (intervals.length === 0) return dur;
	let union = 0;
	let curStart = intervals[0][0];
	let curEnd = intervals[0][1];
	for (let i = 1; i < intervals.length; i++) {
		const [s, e] = intervals[i];
		if (s > curEnd) {
			union += curEnd - curStart;
			curStart = s;
			curEnd = e;
		} else if (e > curEnd) {
			curEnd = e;
		}
	}
	union += curEnd - curStart;
	return Math.max(0, dur - union);
}

function fmtMs(ms: number): string {
	if (ms < 1) return `${ms.toFixed(2)}ms`;
	if (ms < 100) return `${ms.toFixed(1)}ms`;
	return `${ms.toFixed(0)}ms`;
}

function printSpan(span: Span, depth: number, lines: string[]): void {
	const indent = "  ".repeat(depth);
	if (span.point) {
		lines.push(`${indent}• ${span.op}`);
		return;
	}
	const dur = durationOf(span);
	if (dur < LOGGED_TIMING_THRESHOLD_MS && span.children.length === 0) return;
	const parallel = isParallel(span);
	const tag = parallel ? " [parallel]" : "";
	const self = selfTimeOf(span);
	const selfStr = span.children.length > 0 && self > LOGGED_TIMING_THRESHOLD_MS ? ` (self ${fmtMs(self)})` : "";
	lines.push(`${indent}${span.op}: ${fmtMs(dur)}${selfStr}${tag}`);

	for (const child of [...span.children].sort((a, b) => a.start - b.start)) {
		printSpan(child, depth + 1, lines);
	}
}

/** A span is parallel if it overlaps a sibling that started before it. */
function isParallel(span: Span): boolean {
	const parent = span.parent;
	if (!parent || span.end === undefined) return false;
	for (const sibling of parent.children) {
		if (sibling === span || sibling.end === undefined || sibling.point) continue;
		// Overlap test: A overlaps B iff A.start < B.end && B.start < A.end
		if (sibling.start < span.end && span.start < sibling.end) return true;
	}
	return false;
}

/**
 * Time a span. Three forms:
 *   time(op)                    — point event (zero-duration breadcrumb)
 *   time(op, fn, ...args)        — wrap fn in a span; returns fn's return value (sync or Promise)
 *
 * Spans nest hierarchically via AsyncLocalStorage: a child started inside another span's fn
 * (even across awaits) becomes that span's child. Parallel children are recorded as siblings
 * with overlapping intervals.
 */
export function time(op: string): void;
export function time<T, A extends unknown[]>(op: string, fn: (...args: A) => T, ...args: A): T;
export function time<T, A extends unknown[]>(op: string, fn?: (...args: A) => T, ...args: A): T | undefined {
	if (!gRecordTimings || !gRootSpan) {
		if (fn === undefined) return undefined as T;
		return fn(...args);
	}

	const parent = spanStorage.getStore() ?? gRootSpan;
	const span: Span = { op, start: performance.now(), parent, children: [] };
	parent.children.push(span);

	if (fn === undefined) {
		span.end = span.start;
		span.point = true;
		return undefined as T;
	}

	const finish = (): void => {
		span.end = performance.now();
	};
	try {
		const result = spanStorage.run(span, () => fn(...args));
		if (result instanceof Promise) {
			return result.finally(finish) as T;
		}
		finish();
		return result;
	} catch (error) {
		finish();
		throw error;
	}
}
