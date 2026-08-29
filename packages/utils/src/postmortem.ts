/**
 * Cleanup and postmortem handler utilities.
 *
 * This module provides a system for registering and running cleanup callbacks
 * in response to process exit, signals, or fatal exceptions. It is intended to
 * allow reliably releasing resources or shutting down subprocesses, files, sockets, etc.
 */

import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import inspector from "node:inspector";
import * as path from "node:path";
import { isMainThread } from "node:worker_threads";
import { BROKEN_PIPE_EXIT_CODE, createProcessStdoutEpipeClassifier } from "./broken-pipe";
import { type CrashFingerprint, computeCrashFingerprint, formatCrashRecordMarker } from "./crash-fingerprint";
import type { CrashProvenance } from "./crash-journal";
import { appendCrashEvent, appendFatalCrashEvent, detectCrashProvenance } from "./crash-journal";
import { redactCrashSecrets } from "./crash-redaction";
import { getCrashEventsPath, getCrashLogPath, getHandledErrorEventsPath, getHandledErrorLogPath } from "./dirs";
import * as logger from "./logger";
import { safeStderrWrite } from "./safe-stderr";

// Cleanup reasons, in order of priority/meaning.
export enum Reason {
	PRE_EXIT = "pre_exit", // Pre-exit phase (not used by default)
	EXIT = "exit", // Normal process exit
	SIGINT = "sigint", // Ctrl-C or SIGINT
	SIGTERM = "sigterm", // SIGTERM
	SIGHUP = "sighup", // SIGHUP
	UNCAUGHT_EXCEPTION = "uncaught_exception", // Fatal exception
	UNHANDLED_REJECTION = "unhandled_rejection", // Unhandled promise rejection
	MANUAL = "manual", // Manual cleanup (not triggered by process)
}

interface CleanupOptions {
	quiet?: boolean;
}

type StdoutWriteCallback = (error?: Error | null) => void;

// Internal list of active cleanup callbacks (in registration order)
const callbackList: ((reason: Reason) => Promise<void> | void)[] = [];
// Tracks cleanup run state (to prevent recursion/reentry issues)
let cleanupStage: "idle" | "running" | "complete" = "idle";
let cleanupPromise: Promise<void> | undefined;
let quietShutdownStarted = false;
let ordinaryFatalStarted = false;
const stdoutEpipeClassifier = createProcessStdoutEpipeClassifier();

function shouldSuppressCleanupLogging(quiet: boolean): boolean {
	return quiet || quietShutdownStarted;
}

/**
 * Internal: runs all registered cleanup callbacks for the given reason.
 * Ensures each callback is invoked at most once. Handles errors and prevents reentrancy.
 *
 * Returns a Promise that settles after all cleanups complete or error out.
 */
function runCleanup(reason: Reason, options: CleanupOptions = {}): Promise<void> {
	const quiet = options.quiet === true;
	switch (cleanupStage) {
		case "idle":
			cleanupStage = "running";
			break;
		case "running":
			// Exit-bound waiters (signals, fatals, quit) legitimately join the
			// in-flight cleanup via `cleanupPromise`; only a genuine manual
			// recursion (a cleanup callback calling cleanup()) is a bug worth a
			// diagnostic.
			if (reason === Reason.MANUAL && !shouldSuppressCleanupLogging(quiet)) {
				logger.error("Cleanup invoked recursively", { stack: new Error().stack });
			}
			return Promise.resolve();
		case "complete":
			return Promise.resolve();
	}

	const { promise, resolve } = Promise.withResolvers<void>();
	cleanupPromise = promise;

	// Call .cleanup() for each callback that is still "armed".
	// Assign the shared completion promise first so synchronous re-entry joins it.
	const promises = callbackList.toReversed().map(callback => {
		return Promise.try(() => callback(reason));
	});

	void Promise.allSettled(promises).then(results => {
		try {
			if (!shouldSuppressCleanupLogging(quiet)) {
				for (const result of results) {
					if (result.status === "rejected") {
						const err = result.reason instanceof Error ? result.reason : new Error(String(result.reason));
						logger.error("Cleanup callback failed", { err, stack: err.stack });
					}
				}
			}
		} finally {
			cleanupStage = "complete";
			resolve();
		}
	});
	return promise;
}

/**
 * Finite cleanup-liveness contract for every exit-bound wait.
 *
 * Governed waits: signal handlers (SIGINT/SIGTERM/SIGHUP), fatal handlers
 * (uncaught exception / unhandled rejection), the quiet stdout-EPIPE exit, and
 * `quit()`. Each waits at most `resolveCleanupDeadlineMs()` for the shared
 * in-flight cleanup before exiting with its own unchanged exit code (130/143/
 * 129, 1 for fatals, BROKEN_PIPE_EXIT_CODE, or quit's `code`).
 *
 * Ungoverned: `cleanup()` (Reason.MANUAL without exit) is caller-owned and
 * unbounded, and Reason.EXIT stays fire-and-forget (exit is imminent).
 *
 * On expiry the stage is forced to "complete" so late re-entries no-op, a
 * single diagnostic goes to stderr and the error log (suppressed during quiet
 * broken-pipe shutdown), and late callback settlement is ignored — rejections
 * were already routed through Promise.allSettled, so none can become unhandled.
 *
 * The deadline defaults to 5000 ms and can be overridden with
 * `GJC_CLEANUP_DEADLINE_MS` (finite values >= 0; anything else falls back to
 * the default).
 */
const DEFAULT_CLEANUP_DEADLINE_MS = 5_000;

function resolveCleanupDeadlineMs(): number {
	const raw = process.env.GJC_CLEANUP_DEADLINE_MS;
	if (raw === undefined || raw.trim() === "") return DEFAULT_CLEANUP_DEADLINE_MS;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_CLEANUP_DEADLINE_MS;
	return parsed;
}

async function awaitCleanupWithDeadline(reason: Reason, options: CleanupOptions = {}): Promise<void> {
	const pending = cleanupPromise;
	if (!pending || cleanupStage === "complete") return;
	const deadlineMs = resolveCleanupDeadlineMs();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timedOut = await Promise.race([
		pending.then(() => false),
		new Promise<boolean>(resolve => {
			// Deliberately referenced: the timer is also the liveness floor that
			// keeps the process alive until the bounded wait settles, so an
			// otherwise-empty event loop cannot exit 0 underneath a governed wait.
			timer = setTimeout(() => resolve(true), deadlineMs);
		}),
	]);
	if (timer) clearTimeout(timer);
	if (!timedOut) return;
	// Force the terminal stage so late settlement and re-entries are no-ops.
	cleanupStage = "complete";
	if (!shouldSuppressCleanupLogging(options.quiet === true)) {
		const diagnostic = `[postmortem] cleanup deadline (${deadlineMs}ms) expired for ${reason}; exiting without waiting for remaining callbacks.\n`;
		safeStderrWrite(diagnostic);
		logger.error("Cleanup deadline expired", { reason, deadlineMs });
	}
}

async function runCleanupBounded(reason: Reason, options: CleanupOptions = {}): Promise<void> {
	void runCleanup(reason, options);
	await awaitCleanupWithDeadline(reason, options);
}

function installProcessStdoutWriteClassifier(): void {
	const originalWrite = process.stdout.write.bind(process.stdout);
	const markCallback = (callback: StdoutWriteCallback): StdoutWriteCallback => {
		return error => {
			stdoutEpipeClassifier.markDirectProcessStdoutWriteError(error);
			callback(error);
		};
	};

	const markedWrite = (
		chunk: string | Uint8Array,
		encoding?: BufferEncoding | StdoutWriteCallback,
		callback?: StdoutWriteCallback,
	): boolean => {
		// Bun 1.4 stopped surfacing a broken stdout pipe as a synchronous throw
		// from `write()`; it now rejects asynchronously (via the write's own
		// callback and an `unhandledRejection`) with an error object that lacks
		// the `fd`/`syscall` fields the fallback attribution path relies on.
		// Always attach an internal callback — even when the caller passed none —
		// so `markDirectProcessStdoutWriteError` still runs before that async
		// rejection reaches `handleFatalError`. The synchronous `try/catch` below
		// stays as a fallback for Bun/Node versions that still throw synchronously.
		try {
			if (typeof encoding === "function") return originalWrite(chunk, markCallback(encoding));
			if (callback) {
				return typeof chunk === "string"
					? originalWrite(chunk, encoding, markCallback(callback))
					: originalWrite(chunk, markCallback(callback));
			}
			return typeof chunk === "string"
				? originalWrite(
						chunk,
						encoding,
						markCallback(() => {}),
					)
				: originalWrite(
						chunk,
						markCallback(() => {}),
					);
		} catch (error) {
			stdoutEpipeClassifier.markDirectProcessStdoutWriteError(error);
			throw error;
		}
	};

	process.stdout.write = markedWrite as typeof process.stdout.write;
}

const UNREADABLE_FIELD = "[unreadable]";
const UNREADABLE_THROWABLE = "[unreadable throwable]";
const ERROR_FIELDS = ["name", "message", "stack"] as const;
type ErrorField = (typeof ERROR_FIELDS)[number];
const CRASH_CONTEXT_FIELDS = new Set([
	"code",
	"errno",
	"syscall",
	"path",
	"dest",
	"address",
	"port",
	"fd",
	"status",
	"statusCode",
	"url",
	"method",
	"phase",
	"reason",
	"exitCode",
	"stderr",
]);
const CRASH_CONTEXT_FIELD_MAX_BYTES = 4 * 1024;
const CRASH_CONTEXT_FIELD_TRUNCATION_MARKER = "… [field truncated]";
const UNDEFINED_FIELD = "[undefined]";

type FieldRead =
	| { readonly kind: "missing" }
	| { readonly kind: "unreadable" }
	| { readonly kind: "value"; readonly value: unknown };

interface CapturedPayload {
	readonly serialized: string;
}

/** Reads one top-level field exactly once and keeps both its value and refusal state. */
function readField(reason: object, key: string, preserveUndefined = false): FieldRead {
	try {
		const value = (reason as Record<string, unknown>)[key];
		return value === undefined && !preserveUndefined ? { kind: "missing" } : { kind: "value", value };
	} catch {
		return { kind: "unreadable" };
	}
}

function capturedValue(field: FieldRead): unknown {
	if (field.kind === "value") return field.value;
	if (field.kind === "unreadable") return UNREADABLE_FIELD;
	return undefined;
}

function boundedJsonString(value: string): string {
	const redacted = redactCrashSecrets(value);
	if (Buffer.byteLength(JSON.stringify(redacted), "utf8") <= CRASH_CONTEXT_FIELD_MAX_BYTES)
		return JSON.stringify(redacted);

	let low = 0;
	let high = redacted.length;
	while (low < high) {
		const midpoint = Math.ceil((low + high) / 2);
		const candidate = JSON.stringify(`${redacted.slice(0, midpoint)}${CRASH_CONTEXT_FIELD_TRUNCATION_MARKER}`);
		if (Buffer.byteLength(candidate, "utf8") <= CRASH_CONTEXT_FIELD_MAX_BYTES) low = midpoint;
		else high = midpoint - 1;
	}
	let end = low;
	if (end > 0 && /[\uD800-\uDBFF]/.test(redacted[end - 1] ?? "")) end--;
	return JSON.stringify(`${redacted.slice(0, end)}${CRASH_CONTEXT_FIELD_TRUNCATION_MARKER}`);
}

/**
 * Serializes one already-captured diagnostic value. Credential shapes are
 * redacted before output, and oversized fields become a bounded string preview
 * so one request body cannot evict the remaining crash context.
 */
function serializeCapturedValue(value: unknown): string {
	if (value === undefined) return JSON.stringify(UNDEFINED_FIELD);
	if (typeof value === "string") return boundedJsonString(value);

	try {
		const serialized = JSON.stringify(value);
		if (typeof serialized !== "string") return boundedJsonString(String(value));
		const redacted = redactCrashSecrets(serialized);
		if (Buffer.byteLength(redacted, "utf8") <= CRASH_CONTEXT_FIELD_MAX_BYTES) return redacted;
		return boundedJsonString(redacted);
	} catch {
		try {
			return boundedJsonString(String(value));
		} catch {
			return JSON.stringify(UNREADABLE_FIELD);
		}
	}
}

/**
 * Captures only stable diagnostic context. Arbitrary request objects and bodies
 * are intentionally excluded: they are large, routinely contain credentials,
 * and add less crash value than transport, process, and lifecycle metadata.
 */
function capturePayload(reason: object): CapturedPayload | undefined {
	let keys: string[];
	try {
		keys = Object.keys(reason);
	} catch {
		return undefined;
	}

	const properties: string[] = [];
	for (const key of keys) {
		if (!CRASH_CONTEXT_FIELDS.has(key)) continue;
		const serialized = serializeCapturedValue(capturedValue(readField(reason, key, true)));
		properties.push(`${JSON.stringify(key)}:${serialized}`);
	}
	return properties.length > 0 ? { serialized: `{${properties.join(",")}}` } : undefined;
}

function fieldText(field: FieldRead, fallback: string): string {
	if (field.kind === "unreadable") return UNREADABLE_FIELD;
	if (field.kind !== "value") return fallback;
	try {
		const text = typeof field.value === "string" ? field.value : String(field.value);
		return text || fallback;
	} catch {
		return UNREADABLE_FIELD;
	}
}

/** A throwable reduced to captured text; the rest of this module reads nothing else. */
interface FatalDiagnostic {
	name: string;
	message: string;
	stack: string;
	payload?: string;
}

/**
 * The single read of an unknown throwable, and the only one this module has.
 *
 * Objects retain the named diagnostic fields independently from the optional
 * allowlisted context payload. Context never replaces a readable identity,
 * message, or stack.
 */
function describeFatal(reason: unknown): FatalDiagnostic {
	try {
		if (typeof reason !== "object" || reason === null) {
			let message: string;
			try {
				message = String(reason);
			} catch {
				message = UNREADABLE_THROWABLE;
			}
			return { name: "Error", message: message || "(no message)", stack: "" };
		}

		const fields: Record<ErrorField, FieldRead> = {
			name: readField(reason, "name"),
			message: readField(reason, "message"),
			stack: readField(reason, "stack"),
		};
		const payload = capturePayload(reason);
		const payloadIsMessage = payload !== undefined && ERROR_FIELDS.every(key => fields[key].kind === "missing");

		const name = fieldText(fields.name, "Error");
		const message = fieldText(fields.message, "(no message)");
		let stack = "";
		if (fields.stack.kind === "unreadable") {
			stack = `${name}: ${message}\n${UNREADABLE_FIELD}`;
		} else if (
			fields.stack.kind === "value" &&
			typeof fields.stack.value === "string" &&
			fields.stack.value.length > 0
		) {
			stack = fields.stack.value.includes("\n") ? fields.stack.value : `${name}: ${message}\n${fields.stack.value}`;
		}

		return {
			name,
			message: payloadIsMessage ? payload.serialized : message,
			stack,
			payload: payloadIsMessage ? undefined : payload?.serialized,
		};
	} catch {
		return { name: "Error", message: UNREADABLE_THROWABLE, stack: "" };
	}
}

/** Rebuild an `Error` for structured logging out of strings that are already safe to read. */
function fatalErrorForLog(fatal: FatalDiagnostic): Error {
	const error = new Error(fatal.message);
	error.name = fatal.name;
	if (fatal.stack) error.stack = fatal.stack;
	return error;
}

// Register signal and error event handlers to trigger cleanup before exit.
// Main thread: full signal handling (SIGINT, SIGTERM, SIGHUP) + exceptions + exit
// Worker thread: exit only (workers use self.addEventListener for exceptions)
let inspectorOpened = false;

/**
 * Returns `stack` without the `Name: message` header V8 places at the top.
 *
 * The header spans as many lines as the message does, so dropping a single line left lines
 * 2..N of a multi-line message inside the "stack" while the caller had already rendered the
 * message in full — printing the entire body twice. Any stack whose header does not match the
 * captured name/message (the message may have been replaced by a serialized payload) falls back
 * to dropping just the first line, which is the shape V8 guarantees.
 */
function stackFramesOnly(fatal: FatalDiagnostic): string {
	if (fatal.stack.length === 0) return "";
	const header = `${fatal.name}: ${fatal.message}`;
	if (
		fatal.stack.startsWith(header) &&
		(fatal.stack.length === header.length ||
			fatal.stack[header.length] === "\n" ||
			fatal.stack[header.length] === "\r")
	)
		return fatal.stack.slice(header.length).replace(/^\r?\n/, "");
	const firstBreak = fatal.stack.indexOf("\n");
	if (firstBreak === -1) return "";
	const firstLine = fatal.stack.slice(0, firstBreak);
	return firstLine === fatal.name || firstLine.startsWith(`${fatal.name}: `)
		? fatal.stack.slice(firstBreak + 1)
		: fatal.stack;
}

function formatFatalError(label: string, fatal: FatalDiagnostic): string {
	const frames = stackFramesOnly(fatal);
	const formattedStack = frames.length > 0 ? `\n${frames}` : "";
	const formattedPayload = fatal.payload ? `\n${fatal.payload}` : "";
	return boundCrashRecord(
		redactCrashSecrets(`\n[${label}] ${fatal.name}: ${fatal.message}${formattedStack}${formattedPayload}\n`),
	);
}
/** Cap for the durable crash log; it is reset past this so a crash loop cannot fill the disk. */
export const CRASH_LOG_MAX_BYTES = 512 * 1024;
/**
 * Per-record budget so a single oversized error body cannot bypass the file
 * cap: every persisted record is truncated to this many bytes (UTF-8 safe,
 * with a marker) before the append/reset decision.
 */
export const CRASH_RECORD_MAX_BYTES = 64 * 1024;
const CRASH_RECORD_TRUNCATION_MARKER = "\n… [crash record truncated]\n\n";

export { redactCrashSecrets };

/**
 * Bound one record to `maxBytes` without splitting a UTF-8 sequence. Keeps the
 * header (timestamp/label/message) at the front, where the diagnostic value is
 * highest.
 */
function boundCrashRecord(report: string, maxBytes: number = CRASH_RECORD_MAX_BYTES): string {
	if (Buffer.byteLength(report, "utf8") <= maxBytes) return report;
	const bytes = Buffer.from(report, "utf8");
	const budget = maxBytes - Buffer.byteLength(CRASH_RECORD_TRUNCATION_MARKER, "utf8");
	let end = budget;
	// Drop trailing continuation bytes of a truncated multi-byte sequence.
	while (end > 0 && (bytes[end - 1] & 0xc0) === 0x80) end--;
	// Drop the now-incomplete lead byte, if any.
	if (end > 0 && bytes[end - 1] >= 0xc0) end--;
	return bytes.subarray(0, end).toString("utf8") + CRASH_RECORD_TRUNCATION_MARKER;
}

/**
 * Append a fatal-crash record to the dedicated, rotation-immune crash log
 * (`~/.gjc/agent/gjc-crash.log`).
 *
 * The daily logger file is gzip-archived at date rollover by every gjc process
 * independently; that shared-archive race can truncate a day's log to an empty
 * `.gz`, destroying the `logger.error` crash record written here. This
 * append-only file is never rotated, so a crash stays diagnosable regardless.
 *
 * Fully defensive: it never throws (a failing crash writer must not mask the
 * original fatal) and uses synchronous IO so the record lands before
 * `process.exit`. Returns the path written, or `undefined` on failure.
 */
export function recordFatalCrash(label: string, reason: unknown, options: CrashRecordOptions = {}): string | undefined {
	const provenance = detectCrashProvenance();
	const written = writeCrashRecord(label, describeFatal(reason), { ...options, provenance });
	if (!written) return undefined;
	appendFatalCrashEvent(
		{
			kind: "occurrence",
			fingerprint: written.fingerprint.fingerprint,
			fpv: written.fingerprint.version,
			recordId: written.recordId,
			at: written.now.getTime(),
			errorName: written.fingerprint.errorName,
			messageClass: written.fingerprint.messageClass,
			provenance,
		},
		getCrashEventsTarget(written.target, options.path),
	);
	return written.target;
}

/**
 * Classify only process-level harness modes that are explicit and stable.
 * Everything else is product provenance, including source checkouts, CLI
 * invocations, SDK/ACP hosts, and native-loader failures.
 */

const handledErrorFingerprints = new Set<string>();
const HANDLED_ERROR_FINGERPRINT_LIMIT = 256;

export interface HandledErrorRecordOptions {
	/** Override the log target; defaults to `getHandledErrorLogPath()`. */
	readonly path?: string;
	readonly now?: Date;
}

/**
 * Record one handled (non-fatal) error, at most once per fingerprint while it
 * stays hot.
 *
 * A handled error is only useful when its stack establishes a stable identity.
 * The bounded process-local set prevents one retry loop from turning routine
 * failures into disk churn while preserving the fatal crash store's signal.
 * The set is LRU with a hard cap: at saturation the coldest fingerprint is
 * evicted so a long-lived process keeps recording newly seen failure classes
 * instead of going permanently blind past the cap.
 */
export function recordHandledError(
	label: string,
	error: unknown,
	options: HandledErrorRecordOptions = {},
): string | undefined {
	try {
		if (!(error instanceof Error) || typeof error.stack !== "string" || error.stack.length === 0) return undefined;
		const fatal = describeFatal(error);
		const fingerprint = computeCrashFingerprint(fatal).fingerprint;
		if (handledErrorFingerprints.has(fingerprint)) {
			// Still hot: dedupe, but refresh recency so an actively failing class
			// is not the one evicted under pressure.
			handledErrorFingerprints.delete(fingerprint);
			handledErrorFingerprints.add(fingerprint);
			return undefined;
		}
		if (handledErrorFingerprints.size >= HANDLED_ERROR_FINGERPRINT_LIMIT) {
			const coldest = handledErrorFingerprints.values().next().value;
			if (coldest !== undefined) handledErrorFingerprints.delete(coldest);
		}
		handledErrorFingerprints.add(fingerprint);
		const written = writeCrashRecord(label, fatal, {
			path: options.path ?? getHandledErrorLogPath(),
			now: options.now,
		});
		if (!written) {
			handledErrorFingerprints.delete(fingerprint);
			return undefined;
		}
		appendCrashEvent(
			{
				kind: "occurrence",
				fingerprint: written.fingerprint.fingerprint,
				fpv: written.fingerprint.version,
				recordId: written.recordId,
				at: written.now.getTime(),
				errorName: written.fingerprint.errorName,
				messageClass: written.fingerprint.messageClass,
			},
			getHandledErrorEventsTarget(written.target, options.path),
		);
		return written.target;
	} catch {
		return undefined;
	}
}

/** Reset handled-error process dedupe so isolated tests can exercise repeats. */
export function resetHandledErrorDedupeForTest(): void {
	handledErrorFingerprints.clear();
}

interface CrashRecordOptions {
	path?: string;
	now?: Date;
	provenance?: CrashProvenance;
}

interface WrittenCrashRecord {
	readonly target: string;
	readonly now: Date;
	readonly fingerprint: CrashFingerprint;
	readonly recordId: string;
}

function getCrashEventsTarget(target: string, configuredPath: string | undefined): string {
	return configuredPath === undefined
		? getCrashEventsPath()
		: path.join(path.dirname(target), path.basename(getCrashEventsPath()));
}

function getHandledErrorEventsTarget(target: string, configuredPath: string | undefined): string {
	return configuredPath === undefined
		? getHandledErrorEventsPath()
		: path.join(path.dirname(target), path.basename(getHandledErrorEventsPath()));
}

function writeCrashRecord(
	label: string,
	fatal: FatalDiagnostic,
	options: CrashRecordOptions = {},
): WrittenCrashRecord | undefined {
	try {
		const target = options.path ?? getCrashLogPath();
		const now = options.now ?? new Date();
		// The record already prints `name: message` on its own line below, so only the frames
		// are appended here; the raw stack would repeat a multi-line message verbatim.
		const frames = stackFramesOnly(fatal);
		const stack = frames ? `${redactCrashSecrets(frames)}\n` : "";
		const payload = fatal.payload ? `${redactCrashSecrets(fatal.payload)}\n` : "";
		// Identity is computed from the already-captured diagnostic text only; the
		// throwable is never read again here.
		const fingerprint = computeCrashFingerprint(fatal);
		const recordId = randomBytes(8).toString("hex");
		const markerLine = `${formatCrashRecordMarker(fingerprint.fingerprint, fingerprint.version, recordId)}\n`;
		// The marker is the record's identity, so it is budgeted first and appended
		// after truncation: an oversized body can never evict it.
		const body = boundCrashRecord(
			`${now.toISOString()} pid=${process.pid} [${label}${options.provenance && options.provenance !== "product" ? `;provenance=${options.provenance}` : ""}] ` +
				`${redactCrashSecrets(fatal.name)}: ${redactCrashSecrets(fatal.message)}\n` +
				`${stack}${payload}`,
			CRASH_RECORD_MAX_BYTES - Buffer.byteLength(markerLine, "utf8") - 1,
		);
		const report = `${body}${markerLine}\n`;
		fs.mkdirSync(path.dirname(target), { recursive: true });
		let existingSize = 0;
		try {
			existingSize = fs.statSync(target).size;
		} catch {}
		// Reset (rather than append) when the file would exceed the cap so the
		// newest crash is always retained without unbounded growth. Every record
		// is individually bounded above, so no single crash can bypass the cap.
		if (existingSize + Buffer.byteLength(report, "utf8") > CRASH_LOG_MAX_BYTES) {
			fs.writeFileSync(target, report, { mode: 0o600 });
		} else {
			fs.appendFileSync(target, report, { mode: 0o600 });
		}
		// A pre-existing file may carry looser permissions; enforce owner-only.
		try {
			fs.chmodSync(target, 0o600);
		} catch {}
		return { target, now, fingerprint, recordId };
	} catch {
		return undefined;
	}
}

async function exitQuietlyForAttributableStdoutEpipe(reason: Reason): Promise<void> {
	if (ordinaryFatalStarted || quietShutdownStarted) return;
	quietShutdownStarted = true;
	// Set the observable status before cleanup can await or trigger another error.
	process.exitCode = BROKEN_PIPE_EXIT_CODE;
	await runCleanupBounded(reason, { quiet: true });
	// An ordinary fatal that arrived during quiet cleanup takes precedence.
	if (process.exitCode === BROKEN_PIPE_EXIT_CODE) process.exit(BROKEN_PIPE_EXIT_CODE);
}

async function handleFatalError(label: string, reason: unknown, cleanupReason: Reason): Promise<void> {
	if (stdoutEpipeClassifier.isAttributableProcessStdoutEpipe(reason)) {
		await exitQuietlyForAttributableStdoutEpipe(cleanupReason);
		return;
	}

	// A distinct ordinary fatal must retain its normal diagnostic and status-1
	// contract, including when it arrives while quiet cleanup is still pending.
	ordinaryFatalStarted = true;
	process.exitCode = 1;
	const fatal = describeFatal(reason);
	// Persist first: the rotation-immune record must land before any
	// best-effort stderr output, so a slow or failing stderr cannot cost the
	// crash record. Cleanup (which may itself hang or fail) runs afterwards.
	const crashLogPath = recordFatalCrash(label, reason);
	safeStderrWrite(formatFatalError(label, fatal));
	if (crashLogPath) safeStderrWrite(`[${label}] crash recorded at ${crashLogPath}\n`);
	if (!quietShutdownStarted) {
		const err = fatalErrorForLog(fatal);
		logger.error(label === "Uncaught Exception" ? "Uncaught exception" : "Unhandled rejection", {
			err,
			stack: err.stack,
		});
	}
	await runCleanupBounded(cleanupReason);
	process.exit(1);
}

if (isMainThread) {
	installProcessStdoutWriteClassifier();
	process
		.on("SIGINT", async () => {
			await runCleanupBounded(Reason.SIGINT);
			process.exit(130); // 128 + SIGINT (2)
		})
		.on("SIGUSR1", () => {
			if (inspectorOpened) return;
			inspectorOpened = true;
			inspector.open(undefined, undefined, false);
			const url = inspector.url();
			safeStderrWrite(`Inspector opened: ${url}\n`);
		})
		.on("uncaughtException", async error => {
			await handleFatalError("Uncaught Exception", error, Reason.UNCAUGHT_EXCEPTION);
		})
		.on("unhandledRejection", async reason => {
			await handleFatalError("Unhandled Rejection", reason, Reason.UNHANDLED_REJECTION);
		})
		.on("exit", async () => {
			void runCleanup(Reason.EXIT); // fire and forget (exit imminent)
		})
		.on("SIGTERM", async () => {
			await runCleanupBounded(Reason.SIGTERM);
			process.exit(143); // 128 + SIGTERM (15)
		})
		.on("SIGHUP", async () => {
			await runCleanupBounded(Reason.SIGHUP);
			process.exit(129); // 128 + SIGHUP (1)
		});
} else {
	// Worker thread: only register exit handler for cleanup.
	// DO NOT register uncaughtException/unhandledRejection handlers here -
	// they would swallow errors before the worker's own handlers (self.addEventListener)
	// can report failures back to the parent thread.
	process.on("exit", () => {
		void runCleanup(Reason.EXIT);
	});
}

/**
 * Register a process cleanup callback, to be run on shutdown, signal, or fatal error.
 *
 * Returns a Callback instance that can be used to cancel (unregister) or manually clean up.
 * If register is called after cleanup already began, invokes callback on a microtask.
 */
export function register(id: string, callback: (reason: Reason) => void | Promise<void>): () => void {
	let done = false;
	const exec = (reason: Reason) => {
		if (done) return;
		done = true;
		try {
			return callback(reason);
		} catch (error) {
			if (quietShutdownStarted) return;
			const err = error instanceof Error ? error : new Error(String(error));
			logger.error("Cleanup callback failed", { err, id, stack: err.stack });
		}
	};

	const cancel = () => {
		const index = callbackList.indexOf(exec);
		if (index >= 0) {
			callbackList.splice(index, 1);
		}
		done = true;
	};

	if (cleanupStage !== "idle") {
		if (quietShutdownStarted) {
			queueMicrotask(() => {
				void Promise.try(() => exec(Reason.MANUAL)).catch(() => {});
			});
			return () => {
				done = true;
			};
		}
		// If cleanup is already running/completed, warn and run on microtask.
		logger.warn("Cleanup invoked recursively", { id });
		queueMicrotask(() => {
			void Promise.try(() => exec(Reason.MANUAL)).catch(error => {
				const err = error instanceof Error ? error : new Error(String(error));
				logger.error("Cleanup callback failed", { err, id, stack: err.stack });
			});
		});
		return () => {};
	}

	// Register callback as "armed" (active).
	callbackList.push(exec);
	return cancel;
}

/**
 * Runs all cleanup callbacks without exiting.
 * Use this in workers or when you need to clean up but continue execution.
 */
export function cleanup(): Promise<void> {
	return runCleanup(Reason.MANUAL);
}

interface ProcessOutputDrain {
	promise: Promise<void>;
	cancel: () => void;
}

function waitForProcessOutput(stream: NodeJS.WriteStream): ProcessOutputDrain | undefined {
	if (!stream.writable || stream.destroyed || stream.writableFinished) return undefined;

	const { promise, resolve } = Promise.withResolvers<void>();
	let settled = false;
	const finish = (): void => {
		if (settled) return;
		settled = true;
		stream.off("close", finish);
		stream.off("error", finish);
		resolve();
	};

	stream.once("close", finish);
	stream.once("error", finish);
	try {
		stream.end(finish);
	} catch {
		finish();
	}
	return { promise, cancel: finish };
}

async function waitForProcessOutputDrain(): Promise<void> {
	const drains = [waitForProcessOutput(process.stdout), waitForProcessOutput(process.stderr)].filter(
		(drain): drain is ProcessOutputDrain => drain !== undefined,
	);
	if (drains.length === 0) return;

	const { promise: deadline, resolve: resolveDeadline } = Promise.withResolvers<void>();
	const timer = setTimeout(resolveDeadline, 5_000);
	try {
		await Promise.race([Promise.all(drains.map(drain => drain.promise)), deadline]);
	} finally {
		clearTimeout(timer);
		for (const drain of drains) drain.cancel();
	}
}

/**
 * Runs all cleanup callbacks and exits.
 *
 * In main thread: waits for stdout and stderr drain, then calls process.exit().
 * In workers: runs cleanup only (process.exit would kill entire process).
 */
export async function quit(code: number = 0): Promise<void> {
	const cleanupWasRunning = cleanupStage === "running";
	void runCleanup(Reason.MANUAL);
	const completion = cleanupPromise ?? Promise.resolve();

	if (!isMainThread) {
		if (!cleanupWasRunning) await completion;
		return;
	}

	const exitAfterCleanup = async (): Promise<void> => {
		await awaitCleanupWithDeadline(Reason.MANUAL);
		await waitForProcessOutputDrain();
		process.exit(code);
	};

	if (cleanupWasRunning) {
		void exitAfterCleanup();
		return;
	}
	await exitAfterCleanup();
}
