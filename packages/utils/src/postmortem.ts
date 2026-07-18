/**
 * Cleanup and postmortem handler utilities.
 *
 * This module provides a system for registering and running cleanup callbacks
 * in response to process exit, signals, or fatal exceptions. It is intended to
 * allow reliably releasing resources or shutting down subprocesses, files, sockets, etc.
 */
import inspector from "node:inspector";
import { isMainThread } from "node:worker_threads";
import { BROKEN_PIPE_EXIT_CODE, createProcessStdoutEpipeClassifier } from "./broken-pipe";
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
		try {
			if (typeof encoding === "function") return originalWrite(chunk, markCallback(encoding));
			if (callback) {
				return typeof chunk === "string"
					? originalWrite(chunk, encoding, markCallback(callback))
					: originalWrite(chunk, markCallback(callback));
			}
			if (encoding === undefined) return originalWrite(chunk);
			return typeof chunk === "string" ? originalWrite(chunk, encoding) : originalWrite(chunk);
		} catch (error) {
			stdoutEpipeClassifier.markDirectProcessStdoutWriteError(error);
			throw error;
		}
	};

	process.stdout.write = markedWrite as typeof process.stdout.write;
}

function errorForDiagnostic(reason: unknown): Error {
	return reason instanceof Error ? reason : new Error(String(reason));
}

// Register signal and error event handlers to trigger cleanup before exit.
// Main thread: full signal handling (SIGINT, SIGTERM, SIGHUP) + exceptions + exit
// Worker thread: exit only (workers use self.addEventListener for exceptions)
let inspectorOpened = false;

function formatFatalError(label: string, err: Error): string {
	const name = err.name || "Error";
	const message = err.message || "(no message)";
	const stack = err.stack || "";
	const stackLines = stack.split("\n").slice(1);
	const formattedStack = stackLines.length > 0 ? `\n${stackLines.join("\n")}` : "";
	return `\n[${label}] ${name}: ${message}${formattedStack}\n`;
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
	const err = errorForDiagnostic(reason);
	safeStderrWrite(formatFatalError(label, err));
	if (!quietShutdownStarted) {
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
		try {
			callback(Reason.MANUAL);
		} catch (error) {
			const err = error instanceof Error ? error : new Error(String(error));
			logger.error("Cleanup callback failed", { err, id, stack: err.stack });
		}
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

/**
 * Runs all cleanup callbacks and exits.
 *
 * In main thread: waits for stdout drain, then calls process.exit().
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
		if (process.stdout.writableLength > 0) {
			const { promise, resolve } = Promise.withResolvers<void>();
			process.stdout.once("drain", resolve);
			await Promise.race([promise, Bun.sleep(5000)]);
		}
		process.exit(code);
	};

	if (cleanupWasRunning) {
		void exitAfterCleanup();
		return;
	}
	await exitAfterCleanup();
}
