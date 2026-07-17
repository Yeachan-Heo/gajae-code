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
import type * as winston from "winston";
import { getLogsDir } from "./dirs";

/** Ensure a logs directory exists; return the resolved path. */
function ensureDir(dir: string): string {
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true });
	}
	return dir;
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

/** Build a rotating file transport, materializing the target directory lazily. */
function makeFileTransport(DailyRotateFile: DailyRotateFileCtor, dir?: string): Transport {
	return new DailyRotateFile({
		dirname: ensureDir(dir ?? getLogsDir()),
		filename: "gjc.%DATE%.log",
		datePattern: "YYYY-MM-DD",
		maxSize: "10m",
		maxFiles: 5,
		zippedArchive: true,
	});
}

function makeConsoleTransport(winston: WinstonModule): Transport {
	return new winston.transports.Console({ format: makeLogFormat(winston) });
}

function applyTransports(
	logger: Logger,
	modules: { winston: WinstonModule; DailyRotateFile: DailyRotateFileCtor },
): void {
	logger.clear();
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
	const lines: string[] = [];
	lines.push("");
	lines.push("--- Startup timings (hierarchical) ---");
	const work: Span[] = [];
	const loads: Span[] = [];
	for (const child of gRootSpan.children) {
		if (isModuleLoadSpan(child)) loads.push(child);
		else work.push(child);
	}
	for (const child of work.sort((a, b) => a.start - b.start)) {
		printSpan(child, 0, lines);
	}
	if (loads.length > 0) {
		printModuleLoadSummary(loads, 0, lines);
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
 * Idempotent: a second call while already recording is a no-op so that side-effect
 * starters (see module-timer.ts) and explicit starters (main.ts) can coexist.
 */
export function startTiming(): void {
	if (gRecordTimings) return;
	gRootSpan = {
		op: "(root)",
		start: performance.now(),
		parent: undefined,
		children: [],
	};
	gRecordTimings = true;
}

/**
 * Record an externally-measured span as a leaf child of the active span (or root
 * when no span is active). Used by the module-load timing plugin to splice load
 * events into the tree retroactively.
 */
export function recordModuleLoadSpan(path: string, start: number, durationMs: number): void {
	if (!gRecordTimings || !gRootSpan) return;
	const parent = spanStorage.getStore() ?? gRootSpan;
	const span: Span = {
		op: `load:${shortenLoadPath(path)}`,
		start,
		end: start + durationMs,
		parent,
		children: [],
	};
	parent.children.push(span);
}

function shortenLoadPath(p: string): string {
	const cwd = process.cwd();
	if (p.startsWith(`${cwd}/`)) return p.slice(cwd.length + 1);
	const home = process.env.HOME;
	if (home && p.startsWith(`${home}/`)) return `~/${p.slice(home.length + 1)}`;
	return p;
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

const MODULE_LOAD_PREFIX = "load:";
const MODULE_LOAD_VERBOSE_TOP = 10;

function isModuleLoadSpan(span: Span): boolean {
	return span.op.startsWith(MODULE_LOAD_PREFIX);
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

	// Split children into work spans and module-load spans for summarization.
	const work: Span[] = [];
	const loads: Span[] = [];
	for (const child of span.children) {
		if (isModuleLoadSpan(child)) loads.push(child);
		else work.push(child);
	}
	for (const child of work.sort((a, b) => a.start - b.start)) {
		printSpan(child, depth + 1, lines);
	}
	if (loads.length > 0) {
		printModuleLoadSummary(loads, depth + 1, lines);
	}
}

/** Collapse the (typically hundreds of) module-load spans into one summary line. */
function printModuleLoadSummary(loads: Span[], depth: number, lines: string[]): void {
	const childIndent = "  ".repeat(depth);
	const grandIndent = "  ".repeat(depth + 1);
	let unionStart = Number.POSITIVE_INFINITY;
	let unionEnd = 0;
	let totalSelf = 0;
	for (const span of loads) {
		if (span.end === undefined) continue;
		if (span.start < unionStart) unionStart = span.start;
		if (span.end > unionEnd) unionEnd = span.end;
		totalSelf += span.end - span.start;
	}
	const wall = unionEnd > unionStart ? unionEnd - unionStart : 0;
	lines.push(`${childIndent}(modules): ${loads.length} loaded, wall ${fmtMs(wall)}, sum ${fmtMs(totalSelf)}`);
	const showAll = process.env.PI_TIMING === "full";
	const sorted = [...loads].sort((a, b) => durationOf(b) - durationOf(a));
	const visible = showAll ? sorted : sorted.slice(0, MODULE_LOAD_VERBOSE_TOP);
	for (const span of visible) {
		const dur = durationOf(span);
		if (dur < LOGGED_TIMING_THRESHOLD_MS) break;
		const tag = isParallel(span) ? " [parallel]" : "";
		lines.push(`${grandIndent}${span.op}: ${fmtMs(dur)}${tag}`);
	}
	if (!showAll && sorted.length > MODULE_LOAD_VERBOSE_TOP) {
		lines.push(`${grandIndent}… ${sorted.length - MODULE_LOAD_VERBOSE_TOP} more (PI_TIMING=full to show all)`);
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
