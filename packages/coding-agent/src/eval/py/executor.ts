import { getProjectDir, logger } from "@gajae-code/utils";
import { Settings } from "../../config/settings";
import { formatCrashDiagnosticNotice, writeCrashReport } from "../../debug/crash-diagnostics";
import { registerResourceOwner } from "../../runtime/process-lifecycle";
import { OutputSink } from "../../session/streaming-output";
import type { ToolSession } from "../../tools";
import { resolveOutputMaxColumns, resolveOutputSinkHeadBytes } from "../../tools/output-meta";
import type { JsStatusEvent } from "../js/shared/types";
import type { KernelDisplayOutput } from "./display";
import {
	checkPythonKernelAvailability,
	type KernelExecuteOptions,
	type KernelExecuteResult,
	type KernelShutdownResult,
	PythonKernel,
} from "./kernel";
import type { PythonRuntimeOptions } from "./runtime";
import { ensurePyToolBridge, registerPyToolBridge } from "./tool-bridge";

export type PythonKernelMode = "session" | "per-call";

export interface PythonExecutorOptions {
	/** Working directory for command execution */
	cwd?: string;
	/** Session settings used for shell and runtime policy. */
	settings?: Settings;
	/** Timeout in milliseconds */
	timeoutMs?: number;
	/** Absolute wall-clock deadline in milliseconds since epoch */
	deadlineMs?: number;
	/** Callback for streaming output chunks (already sanitized) */
	onChunk?: (chunk: string) => Promise<void> | void;
	/** AbortSignal for cancellation */
	signal?: AbortSignal;
	/** Session identifier for kernel reuse */
	sessionId?: string;
	/** Logical owner identifier for retained kernel cleanup */
	kernelOwnerId?: string;
	/** Kernel mode (session reuse vs per-call) */
	kernelMode?: PythonKernelMode;
	/** Called when a retained session kernel is acquired or replaced. */
	onKernelStart?: (kernelInstanceId: string) => void;
	/** Restart the kernel before executing */
	reset?: boolean;
	/** Session file path for accessing task outputs */
	sessionFile?: string;
	/**
	 * Effective artifacts directory for the current session. Subagents share
	 * the parent's directory, so this can differ from `sessionFile`'s sibling
	 * dir. When present, exported to the kernel as `PI_ARTIFACTS_DIR` and
	 * preferred over `PI_SESSION_FILE`-derived paths.
	 */
	artifactsDir?: string;
	/** Runtime resolution/provisioning options (RLM managed workspace venv, package seeding). */
	runtimeOptions?: PythonRuntimeOptions;
	/** Artifact path/id for full output storage */
	artifactPath?: string;
	artifactId?: string;
	/**
	 * ToolSession used to resolve host-side `tool.<name>(args)` calls made from
	 * the Python prelude's bridge proxy. When omitted, the bridge env vars are
	 * not injected and any `tool.foo(...)` raises in Python.
	 */
	toolSession?: ToolSession;
	/** Callback for status events emitted by tool bridge invocations. */
	emitStatus?: (event: JsStatusEvent) => void;
	/** @internal Bridge session id, set by `executePython` before delegating. */
	bridgeSessionId?: string;
	/** @internal Bridge endpoint info, set by `executePython` before delegating. */
	bridge?: { url: string; capability: string };
}

export interface PythonKernelExecutor {
	execute: (code: string, options?: KernelExecuteOptions) => Promise<KernelExecuteResult>;
	getExitCode?: () => number | null;
	peekStderr?: () => string;
}

export interface PythonResult {
	/** Combined stdout + stderr output (sanitized, possibly truncated) */
	output: string;
	/** Execution exit code (0 ok, 1 error, undefined if cancelled) */
	exitCode: number | undefined;
	/** Whether the execution was cancelled via signal */
	cancelled: boolean;
	/** Whether the output was truncated */
	truncated: boolean;
	/** Artifact ID if full output was saved to artifact storage */
	artifactId?: string;
	/** Total number of lines in the output stream */
	totalLines: number;
	/** Total number of bytes in the output stream */
	totalBytes: number;
	/** Number of lines included in the output text */
	outputLines: number;
	/** Number of bytes included in the output text */
	outputBytes: number;
	/** Rich display outputs captured from display_data/execute_result */
	displayOutputs: KernelDisplayOutput[];
	/** Whether stdin was requested */
	stdinRequested: boolean;
}

// ---------------------------------------------------------------------------
// Session bookkeeping
//
// One PythonKernel subprocess per session id. Sessions are reused until they
// die or are explicitly disposed. Multiple agent owners can register against
// the same session id; the kernel stays alive until the last owner detaches.
// ---------------------------------------------------------------------------

interface PythonSession {
	sessionId: string;
	kernel: PythonKernel;
	kernelInstanceId: string;
	bridgeCapability?: string;
	ownerIds: Set<string>;
	hasFallbackOwner: boolean;
	queue: Promise<void>;
	cleanupPromise?: Promise<KernelShutdownResult>;
	cleanupStart?: () => void;
}

interface InitializingPythonSession {
	promise: Promise<PythonSession>;
	ownerIds: Set<string>;
	retirementOwnerIds: Set<string>;
	hasFallbackOwner: boolean;
	cancelled?: PythonExecutionCancelledError;
	kernel?: PythonKernel;
	cleanupError?: unknown;
	cleanupFailed?: boolean;
}

interface ActivePythonRequest {
	readonly ownerId?: string;
	readonly controller: AbortController;
	readonly completion: Promise<void>;
	readonly finish: () => void;
}

let pythonResourceCleanupRegistered = false;

function ensurePythonResourceCleanup(): void {
	if (pythonResourceCleanupRegistered) return;
	pythonResourceCleanupRegistered = true;
	registerResourceOwner("python-kernel-sessions", disposeAllKernelSessions);
}
const sessions = new Map<string, PythonSession | InitializingPythonSession>();
const retiringKernels = new Set<PythonKernel>();
const settingsScopes = new WeakMap<Settings, string>();
const activeRequests = new Set<ActivePythonRequest>();
const retiringSessions = new Set<PythonSession>();
const initializingSessions = new Set<InitializingPythonSession>();
const retiringKernelShutdowns = new Map<PythonKernel, Promise<KernelShutdownResult>>();
const retiringKernelOwners = new Map<PythonKernel, Set<string>>();

/**
 * Fingerprint the settings values that actually shape a spawned kernel process.
 * `PythonKernel.start` derives the kernel environment solely from
 * `settings.getShellConfig()`, so two Settings instances resolving to the same
 * shell configuration produce byte-identical kernels and MUST share one
 * retained kernel. Keying on Settings object identity instead partitions every
 * logical session into its own kernel, which breaks cross-session reuse and
 * lets one session's dispose shut down a kernel another session still owns.
 */
function settingsScope(activeSettings: Settings): string {
	const cached = settingsScopes.get(activeSettings);
	if (cached !== undefined) return cached;
	const { shell, args, env } = activeSettings.getShellConfig();
	const canonicalEnv = Object.keys(env)
		.sort()
		.map(key => [key, env[key]]);
	const canonical = JSON.stringify([shell, args, canonicalEnv]);
	const scope = new Bun.CryptoHasher("sha256").update(canonical).digest("hex").slice(0, 16);
	settingsScopes.set(activeSettings, scope);
	return scope;
}

function scopedSessionId(sessionId: string, activeSettings: Settings | undefined, explicitSessionId: boolean): string {
	if (explicitSessionId) return sessionId;
	if (!activeSettings) {
		const prefix = `${sessionId}:settings-`;
		for (const existingSessionId of sessions.keys()) {
			if (existingSessionId.startsWith(prefix)) return existingSessionId;
		}
		return sessionId;
	}
	return `${sessionId}:settings-${settingsScope(activeSettings)}`;
}

function retainKernelForOwners(kernel: PythonKernel, ownerIds: Set<string>): void {
	retiringKernels.add(kernel);
	const owners = retiringKernelOwners.get(kernel) ?? new Set<string>();
	for (const ownerId of ownerIds) owners.add(ownerId);
	retiringKernelOwners.set(kernel, owners);
}

async function shutdownOrRetainKernel(kernel: PythonKernel, ownerIds: Set<string>): Promise<void> {
	let result: KernelShutdownResult;
	try {
		result = await callKernelShutdown(kernel);
	} catch (error) {
		retainKernelForOwners(kernel, ownerIds);
		logger.warn("Python kernel shutdown not confirmed", { kernelId: kernel.id, reason: error });
		throw error;
	}
	if (result.confirmed) return;
	retainKernelForOwners(kernel, ownerIds);
	logger.warn("Python kernel shutdown not confirmed", { kernelId: kernel.id });
	throw unconfirmedShutdownError(kernel);
}

function prepareSessionShutdown(session: PythonSession): Promise<KernelShutdownResult> {
	if (session.cleanupPromise) return session.cleanupPromise;
	const { promise: cleanup, resolve, reject } = Promise.withResolvers<KernelShutdownResult>();
	retiringSessions.add(session);
	session.cleanupPromise = cleanup;
	session.cleanupStart = () => void confirmedKernelShutdown(session.kernel).then(resolve, reject);
	void cleanup.then(
		result => {
			if (result.confirmed) retiringSessions.delete(session);
			if (session.cleanupPromise === cleanup) {
				session.cleanupPromise = undefined;
				session.cleanupStart = undefined;
			}
		},
		() => {
			retiringSessions.add(session);
			if (session.cleanupPromise === cleanup) {
				session.cleanupPromise = undefined;
				session.cleanupStart = undefined;
			}
		},
	);
	return cleanup;
}

function startSessionShutdown(session: PythonSession): void {
	const start = session.cleanupStart;
	if (!start) return;
	session.cleanupStart = undefined;
	start();
}

function callKernelShutdown(kernel: PythonKernel): Promise<KernelShutdownResult> {
	try {
		return kernel.shutdown();
	} catch (error) {
		return Promise.reject(error);
	}
}

function confirmedKernelShutdown(kernel: PythonKernel): Promise<KernelShutdownResult> {
	return callKernelShutdown(kernel).then(result => {
		if (!result.confirmed) throw unconfirmedShutdownError(kernel);
		return result;
	});
}

function prepareRetiringKernelShutdown(kernel: PythonKernel): [Promise<KernelShutdownResult>, () => void] {
	const existing = retiringKernelShutdowns.get(kernel);
	if (existing) return [existing, () => {}];
	const { promise, resolve, reject } = Promise.withResolvers<KernelShutdownResult>();
	retiringKernelShutdowns.set(kernel, promise);
	let started = false;
	void promise.then(
		result => {
			if (result.confirmed) {
				retiringKernels.delete(kernel);
				retiringKernelOwners.delete(kernel);
			}
			if (retiringKernelShutdowns.get(kernel) === promise) retiringKernelShutdowns.delete(kernel);
		},
		() => {
			if (retiringKernelShutdowns.get(kernel) === promise) retiringKernelShutdowns.delete(kernel);
		},
	);
	return [
		promise,
		() => {
			if (started) return;
			started = true;
			void confirmedKernelShutdown(kernel).then(resolve, reject);
		},
	];
}

function isInitializingSession(
	session: PythonSession | InitializingPythonSession,
): session is InitializingPythonSession {
	return "promise" in session;
}

// ---------------------------------------------------------------------------
// Cancellation plumbing
// ---------------------------------------------------------------------------

class PythonExecutionCancelledError extends Error {
	readonly timedOut: boolean;

	constructor(timedOut: boolean) {
		super(timedOut ? "Command timed out" : "Command aborted");
		this.name = timedOut ? "TimeoutError" : "AbortError";
		this.timedOut = timedOut;
	}
}

function getExecutionDeadlineMs(options?: Pick<PythonExecutorOptions, "deadlineMs" | "timeoutMs">): number | undefined {
	if (options?.deadlineMs !== undefined) return options.deadlineMs;
	if (options?.timeoutMs === undefined) return undefined;
	return Date.now() + options.timeoutMs;
}

function beginPythonRequest(
	options?: PythonExecutorOptions,
	useSessionFallback = false,
): {
	options: PythonExecutorOptions;
	request: ActivePythonRequest;
	cwd?: string;
} {
	ensurePythonResourceCleanup();
	const capturedOptions = { ...(options ?? {}) };
	const cwd = useSessionFallback ? (capturedOptions.cwd ?? getProjectDir()) : undefined;
	const ownerId =
		capturedOptions.kernelOwnerId ??
		(useSessionFallback && capturedOptions.kernelMode !== "per-call"
			? scopedSessionId(
					capturedOptions.sessionId ?? `session:${cwd}`,
					capturedOptions.settings,
					capturedOptions.sessionId !== undefined,
				)
			: undefined);
	const deadlineMs = getExecutionDeadlineMs(capturedOptions);
	const controller = new AbortController();
	const { promise: completion, resolve } = Promise.withResolvers<void>();
	let deadlineTimer: NodeJS.Timeout | undefined;
	const request: ActivePythonRequest = {
		ownerId,
		controller,
		completion,
		finish: () => {
			activeRequests.delete(request);
			if (deadlineTimer) clearTimeout(deadlineTimer);
			resolve();
		},
	};
	activeRequests.add(request);

	const signals = [controller.signal];
	if (capturedOptions.signal) signals.push(capturedOptions.signal);
	const signal = AbortSignal.any(signals);
	const remainingMs = getRemainingTimeoutMs(deadlineMs);
	deadlineTimer =
		remainingMs !== undefined
			? setTimeout(() => controller.abort(new PythonExecutionCancelledError(true)), Math.max(0, remainingMs))
			: undefined;
	deadlineTimer?.unref?.();

	return {
		options: { ...capturedOptions, signal, deadlineMs },
		request,
		cwd,
	};
}

function getRemainingTimeoutMs(deadlineMs?: number): number | undefined {
	if (deadlineMs === undefined) return undefined;
	return deadlineMs - Date.now();
}

function requireRemainingTimeoutMs(deadlineMs?: number): number | undefined {
	const remainingMs = getRemainingTimeoutMs(deadlineMs);
	if (remainingMs === undefined) return undefined;
	if (remainingMs <= 0) {
		throw new PythonExecutionCancelledError(true);
	}
	return remainingMs;
}

function isCancellationError(error: unknown): boolean {
	return (
		error instanceof PythonExecutionCancelledError ||
		(error instanceof DOMException && (error.name === "AbortError" || error.name === "TimeoutError")) ||
		(error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError"))
	);
}

function isTimedOutCancellation(error: unknown, signal?: AbortSignal): boolean {
	if (error instanceof PythonExecutionCancelledError) return error.timedOut;
	if (error instanceof DOMException) return error.name === "TimeoutError";
	if (error instanceof Error && error.name === "TimeoutError") return true;
	const reason = signal?.reason;
	if (reason instanceof DOMException) return reason.name === "TimeoutError";
	return reason instanceof Error ? reason.name === "TimeoutError" : false;
}

function throwIfExecutionCancelled(options: Pick<PythonExecutorOptions, "signal" | "deadlineMs">): void {
	if (options.signal?.aborted) {
		throw new PythonExecutionCancelledError(isTimedOutCancellation(options.signal.reason, options.signal));
	}
	requireRemainingTimeoutMs(options.deadlineMs);
}

async function waitForPromiseWithCancellation<T>(
	promise: Promise<T>,
	options: Pick<PythonExecutorOptions, "signal" | "deadlineMs">,
): Promise<T> {
	if (options.signal?.aborted) {
		throw new PythonExecutionCancelledError(isTimedOutCancellation(options.signal.reason, options.signal));
	}
	const remainingMs = getRemainingTimeoutMs(options.deadlineMs);
	if (remainingMs !== undefined && remainingMs <= 0) {
		throw new PythonExecutionCancelledError(true);
	}
	if (!options.signal && remainingMs === undefined) {
		return await promise;
	}

	const { promise: resultPromise, resolve, reject } = Promise.withResolvers<T>();
	const cleanups: Array<() => void> = [];
	const finish = (cb: () => void): void => {
		while (cleanups.length > 0) cleanups.pop()?.();
		cb();
	};
	if (options.signal) {
		const onAbort = (): void =>
			finish(() =>
				reject(new PythonExecutionCancelledError(isTimedOutCancellation(options.signal?.reason, options.signal))),
			);
		options.signal.addEventListener("abort", onAbort, { once: true });
		cleanups.push(() => options.signal?.removeEventListener("abort", onAbort));
	}
	if (remainingMs !== undefined) {
		const timer = setTimeout(() => finish(() => reject(new PythonExecutionCancelledError(true))), remainingMs);
		timer.unref();
		cleanups.push(() => clearTimeout(timer));
	}
	promise.then(
		value => finish(() => resolve(value)),
		err => finish(() => reject(err)),
	);
	return await resultPromise;
}

// ---------------------------------------------------------------------------
// Result formatting
// ---------------------------------------------------------------------------

function formatTimeoutAnnotation(timeoutMs?: number): string | undefined {
	if (timeoutMs === undefined) return "Command timed out";
	const secs = Math.max(1, Math.round(timeoutMs / 1000));
	return `Command timed out after ${secs} seconds`;
}

function formatKernelTimeoutAnnotation(timeoutMs: number | undefined, kernelKilled: boolean): string {
	const secs = timeoutMs === undefined ? undefined : Math.max(1, Math.round(timeoutMs / 1000));
	if (kernelKilled) {
		return "eval cell timed out and the kernel was unresponsive to interrupt; the kernel has been killed and will be recreated on the next call.";
	}
	const duration = secs === undefined ? "the configured timeout" : `${secs}s`;
	return `eval cell timed out after ${duration}; kernel interrupted but remains running. Reset the kernel via { reset: true } if state appears corrupted.`;
}

function createCancelledPythonResult(timedOut: boolean, timeoutMs?: number): PythonResult {
	const output = timedOut ? (formatTimeoutAnnotation(timeoutMs) ?? "Command timed out") : "";
	const outputBytes = Buffer.byteLength(output, "utf-8");
	const outputLines = output.length > 0 ? 1 : 0;
	return {
		output,
		exitCode: undefined,
		cancelled: true,
		truncated: false,
		totalLines: outputLines,
		totalBytes: outputBytes,
		outputLines,
		outputBytes,
		displayOutputs: [],
		stdinRequested: false,
	};
}

// ---------------------------------------------------------------------------
// Kernel start helpers
// ---------------------------------------------------------------------------

function buildKernelEnv(options: {
	sessionFile?: string;
	artifactsDir?: string;
	bridgeSessionId?: string;
	bridge?: { url: string; capability: string };
}): Record<string, string> | undefined {
	const env: Record<string, string> = {};
	if (options.sessionFile) env.PI_SESSION_FILE = options.sessionFile;
	if (options.artifactsDir) env.PI_ARTIFACTS_DIR = options.artifactsDir;
	if (options.bridge && options.bridgeSessionId) {
		env.PI_TOOL_BRIDGE_URL = options.bridge.url;
		env.PI_TOOL_BRIDGE_CAPABILITY = options.bridge.capability;
		env.PI_TOOL_BRIDGE_SESSION = options.bridgeSessionId;
	}
	return Object.keys(env).length > 0 ? env : undefined;
}

async function startKernel(cwd: string, options: PythonExecutorOptions): Promise<PythonKernel> {
	throwIfExecutionCancelled(options);
	return await PythonKernel.start({
		cwd,
		settings: options.settings,
		env: buildKernelEnv(options),
		runtimeOptions: options.runtimeOptions,
		signal: options.signal,
		deadlineMs: options.deadlineMs,
	});
}

function attachOwner(
	session: PythonSession | InitializingPythonSession,
	sessionId: string,
	ownerId: string | undefined,
): void {
	if (ownerId !== undefined) {
		if (session.hasFallbackOwner) {
			session.ownerIds.delete(sessionId);
			session.hasFallbackOwner = false;
		}
		session.ownerIds.add(ownerId);
		return;
	}
	if (session.hasFallbackOwner || session.ownerIds.size === 0) {
		session.ownerIds.add(sessionId);
		session.hasFallbackOwner = true;
	}
}

async function acquireSession(sessionId: string, cwd: string, options: PythonExecutorOptions): Promise<PythonSession> {
	const existing = sessions.get(sessionId);
	if (existing) {
		attachOwner(existing, sessionId, options.kernelOwnerId);
		let session: PythonSession;
		if (isInitializingSession(existing)) {
			try {
				session = await waitForPromiseWithCancellation(existing.promise, options);
			} catch (error) {
				const remainingMs = getRemainingTimeoutMs(options.deadlineMs);
				if (
					isCancellationError(error) &&
					!options.signal?.aborted &&
					(remainingMs === undefined || remainingMs > 0)
				)
					return await acquireSession(sessionId, cwd, options);
				throw error;
			}
		} else {
			session = existing;
		}
		return session;
	}

	const initializing: InitializingPythonSession = {
		ownerIds: new Set(),
		retirementOwnerIds: new Set(),
		hasFallbackOwner: false,
		promise: Promise.resolve().then(async () => {
			throwIfExecutionCancelled(options);
			const kernel = await startKernel(cwd, options);
			initializing.kernel = kernel;
			if (initializing.cancelled || options.signal?.aborted) {
				try {
					await shutdownOrRetainKernel(kernel, initializing.ownerIds);
				} catch (error) {
					initializing.cleanupError = error;
					initializing.cleanupFailed = true;
				}
				throw (
					initializing.cancelled ??
					new PythonExecutionCancelledError(isTimedOutCancellation(options.signal?.reason, options.signal))
				);
			}
			const current = sessions.get(sessionId);
			if (current !== initializing) {
				try {
					await shutdownOrRetainKernel(kernel, initializing.ownerIds);
				} catch (error) {
					initializing.cleanupError = error;
					initializing.cleanupFailed = true;
				}
				const winner = current
					? isInitializingSession(current)
						? await waitForPromiseWithCancellation(current.promise, options)
						: current
					: undefined;
				if (winner) return winner;
				throw new PythonExecutionCancelledError(false);
			}
			const session: PythonSession = {
				sessionId,
				kernel,
				kernelInstanceId: crypto.randomUUID(),
				bridgeCapability: options.bridge?.capability,
				ownerIds: new Set(initializing.ownerIds),
				hasFallbackOwner: initializing.hasFallbackOwner,
				queue: Promise.resolve(),
			};
			sessions.set(sessionId, session);
			return session;
		}),
	};
	attachOwner(initializing, sessionId, options.kernelOwnerId);
	initializingSessions.add(initializing);
	sessions.set(sessionId, initializing);
	let cancellationTimer: NodeJS.Timeout | undefined;
	const retireCancelledInitialization = (timedOut: boolean): void => {
		if (initializing.cancelled) return;
		initializing.cancelled = new PythonExecutionCancelledError(timedOut);
		if (sessions.get(sessionId) === initializing) sessions.delete(sessionId);
	};
	const onAbort = (): void => {
		options.signal?.removeEventListener("abort", onAbort);
		retireCancelledInitialization(isTimedOutCancellation(options.signal?.reason, options.signal));
	};
	if (options.signal?.aborted) {
		onAbort();
	} else if (options.signal) {
		options.signal.addEventListener("abort", onAbort, { once: true });
	}
	const remainingMs = getRemainingTimeoutMs(options.deadlineMs);
	if (remainingMs !== undefined) {
		if (remainingMs <= 0) {
			retireCancelledInitialization(true);
		} else {
			cancellationTimer = setTimeout(() => retireCancelledInitialization(true), remainingMs);
			cancellationTimer.unref();
		}
	}
	void initializing.promise
		.finally(() => {
			initializingSessions.delete(initializing);
			options.signal?.removeEventListener("abort", onAbort);
			if (cancellationTimer) clearTimeout(cancellationTimer);
		})
		.catch(() => undefined);
	try {
		const session = await waitForPromiseWithCancellation(initializing.promise, options);
		return session;
	} catch (err) {
		if (isCancellationError(err)) {
			retireCancelledInitialization(isTimedOutCancellation(err, options.signal));
			await initializing.promise.catch(() => undefined);
		} else if (sessions.get(sessionId) === initializing) {
			sessions.delete(sessionId);
		}
		throw err;
	}
}

async function replaceSessionKernel(
	session: PythonSession,
	cwd: string,
	options: PythonExecutorOptions,
): Promise<void> {
	throwIfExecutionCancelled(options);
	const old = session.kernel;
	const remaining = getRemainingTimeoutMs(options.deadlineMs);
	await old
		.shutdown(remaining !== undefined ? { timeoutMs: Math.max(0, remaining) } : undefined)
		.catch(() => undefined);
	throwIfExecutionCancelled(options);
	if (sessions.get(session.sessionId) !== session) {
		throw new PythonExecutionCancelledError(false);
	}
	throwIfExecutionCancelled(options);
	const bridge = options.bridge;
	const previousCapability = bridge?.capability;
	const nextCapability = bridge ? crypto.randomUUID() : undefined;
	if (bridge && nextCapability) bridge.capability = nextCapability;
	let next: PythonKernel | undefined;
	try {
		throwIfExecutionCancelled(options);
		next = await startKernel(cwd, options);
		throwIfExecutionCancelled(options);
		if (sessions.get(session.sessionId) !== session) {
			throw new PythonExecutionCancelledError(false);
		}
		session.kernel = next;
		session.kernelInstanceId = crypto.randomUUID();
		session.bridgeCapability = nextCapability;
	} catch (err) {
		await next?.shutdown().catch(() => undefined);
		if (bridge && previousCapability && bridge.capability === nextCapability) {
			bridge.capability = previousCapability;
		}
		throw err;
	}
}

async function resetSession(sessionId: string): Promise<void> {
	const existing = sessions.get(sessionId);
	if (!existing) return;
	if (sessions.get(sessionId) === existing) sessions.delete(sessionId);
	if (isInitializingSession(existing)) {
		await existing.promise.catch(() => undefined);
		return;
	}
	const shutdown = prepareSessionShutdown(existing);
	startSessionShutdown(existing);
	await shutdown.catch(() => undefined);
}

async function runQueued<T>(
	session: PythonSession,
	options: Pick<PythonExecutorOptions, "signal" | "deadlineMs">,
	work: () => Promise<T>,
): Promise<T> {
	const previous = session.queue;
	const { promise: ourSlot, resolve: releaseSlot } = Promise.withResolvers<void>();
	// Keep the queue chained even if WE bail out: future runs must still wait
	// for `previous` to finish before they touch the kernel.
	session.queue = previous.catch(() => undefined).then(() => ourSlot);
	try {
		await waitForPromiseWithCancellation(
			previous.catch(() => undefined),
			options,
		);
		return await work();
	} finally {
		releaseSlot();
	}
}

// ---------------------------------------------------------------------------
// Public dispose entry points
// ---------------------------------------------------------------------------

export function disposeAllKernelSessions(): Promise<void> {
	const entries = [...sessions.entries()];
	const requests = [...activeRequests];
	const initializing = [...initializingSessions];
	const targets = new Set<PythonSession>([
		...[...entries.map(([, entry]) => entry), ...retiringSessions].filter(
			(entry): entry is PythonSession => !isInitializingSession(entry),
		),
	]);
	const shutdowns = [...targets].map(session => [session, prepareSessionShutdown(session)] as const);
	const retiring = [...retiringKernels].map(kernel => [kernel, ...prepareRetiringKernelShutdown(kernel)] as const);
	for (const [id, entry] of entries) {
		if (sessions.get(id) === entry) sessions.delete(id);
	}
	// Publish every exact physical cleanup future before abort listeners or shutdown callbacks can reenter disposal.
	for (const request of requests) {
		if (!request.controller.signal.aborted) request.controller.abort(new PythonExecutionCancelledError(false));
	}
	for (const [session] of shutdowns) startSessionShutdown(session);
	for (const [, , start] of retiring) start();
	return (async () => {
		await Promise.all([
			...requests.map(request => request.completion),
			...initializing.map(entry => entry.promise.catch(() => undefined)),
		]);
		const failures: unknown[] = initializing.filter(entry => entry.cleanupFailed).map(entry => entry.cleanupError);
		const results = await Promise.allSettled(shutdowns.map(([, cleanup]) => cleanup));
		for (let index = 0; index < shutdowns.length; index += 1) {
			const [session] = shutdowns[index];
			const result = results[index];
			if (result.status === "fulfilled" && result.value.confirmed) continue;
			if (!sessions.has(session.sessionId)) sessions.set(session.sessionId, session);
			if (result.status === "rejected") failures.push(result.reason);
			else failures.push(unconfirmedShutdownError(session.kernel));
		}
		const retiringResults = await Promise.allSettled(retiring.map(([, cleanup]) => cleanup));
		for (let index = 0; index < retiring.length; index += 1) {
			const [kernel] = retiring[index];
			const result = retiringResults[index];
			if (result.status === "fulfilled" && result.value.confirmed) continue;
			retiringKernels.add(kernel);
			failures.push(result.status === "rejected" ? result.reason : unconfirmedShutdownError(kernel));
		}
		if (failures.length) throw failures[0];
	})();
}

export function disposeKernelSessionsByOwner(ownerId: string): Promise<void> {
	const requests = [...activeRequests].filter(request => request.ownerId === ownerId);
	const entries = [...sessions.entries()].filter(([, entry]) => entry.ownerIds.has(ownerId));
	const initializing = [...initializingSessions].filter(
		entry => entry.ownerIds.has(ownerId) || entry.retirementOwnerIds.has(ownerId),
	);
	const sessionsToRetire = new Set<PythonSession>([
		...[...entries.map(([, entry]) => entry), ...retiringSessions].filter(
			(entry): entry is PythonSession => !isInitializingSession(entry) && entry.ownerIds.has(ownerId),
		),
	]);
	const toShutdown: PythonSession[] = [];
	for (const entry of initializing) entry.retirementOwnerIds.add(ownerId);
	for (const [id, entry] of entries)
		if (isInitializingSession(entry) && entry.ownerIds.size === 1) sessions.delete(id);
	for (const entry of initializing) entry.ownerIds.delete(ownerId);
	for (const session of sessionsToRetire) {
		if (session.ownerIds.size === 1) {
			toShutdown.push(session);
			if (sessions.get(session.sessionId) === session) sessions.delete(session.sessionId);
		} else {
			session.ownerIds.delete(ownerId);
		}
	}
	const shutdowns = toShutdown.map(session => [session, prepareSessionShutdown(session)] as const);
	const retiring = [...retiringKernels]
		.filter(kernel => retiringKernelOwners.get(kernel)?.has(ownerId))
		.map(kernel => [kernel, ...prepareRetiringKernelShutdown(kernel)] as const);
	// All cleanup futures are visible before an abort listener can reenter this API.
	for (const request of requests) {
		if (!request.controller.signal.aborted) request.controller.abort(new PythonExecutionCancelledError(false));
	}
	for (const [session] of shutdowns) startSessionShutdown(session);
	for (const [, , start] of retiring) start();
	return (async () => {
		await Promise.all([
			...requests.map(request => request.completion),
			...initializing.map(entry => entry.promise.catch(() => undefined)),
		]);
		const failures: unknown[] = [];
		for (const entry of initializing)
			if (entry.cleanupFailed) {
				if (entry.kernel) retainKernelForOwners(entry.kernel, new Set([ownerId]));
				failures.push(entry.cleanupError);
			}
		const results = await Promise.allSettled(shutdowns.map(([, shutdown]) => shutdown));
		for (let index = 0; index < shutdowns.length; index += 1) {
			const [session] = shutdowns[index];
			const result = results[index];
			if (result.status === "fulfilled" && result.value.confirmed) {
				session.ownerIds.delete(ownerId);
				continue;
			}
			if (!sessions.has(session.sessionId)) sessions.set(session.sessionId, session);
			if (result.status === "rejected") failures.push(result.reason);
			else failures.push(unconfirmedShutdownError(session.kernel));
		}
		const retiringResults = await Promise.allSettled(retiring.map(([, cleanup]) => cleanup));
		for (let index = 0; index < retiring.length; index += 1) {
			const [kernel] = retiring[index];
			const result = retiringResults[index];
			if (result.status === "fulfilled" && result.value.confirmed) continue;
			failures.push(result.status === "rejected" ? result.reason : unconfirmedShutdownError(kernel));
		}
		if (failures.length) throw failures[0];
	})();
}

function unconfirmedShutdownError(kernel: PythonKernel): Error {
	const error = new Error(`Python kernel shutdown not confirmed: ${kernel.id}`);
	error.name = "PythonKernelShutdownUnconfirmedError";
	return error;
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

async function executeWithKernel(
	kernel: PythonKernelExecutor,
	code: string,
	options: PythonExecutorOptions | undefined,
): Promise<PythonResult> {
	const settings = options?.settings ?? (await Settings.init());
	if (options) throwIfExecutionCancelled(options);
	const sink = new OutputSink({
		onChunk: options?.onChunk,
		artifactPath: options?.artifactPath,
		artifactId: options?.artifactId,
		headBytes: resolveOutputSinkHeadBytes(settings),
		maxColumns: resolveOutputMaxColumns(settings),
	});
	const displayOutputs: KernelDisplayOutput[] = [];
	const deadlineMs = getExecutionDeadlineMs(options);
	let executionTimeoutMs: number | undefined;

	const emitStatus =
		options?.emitStatus ??
		((event: JsStatusEvent) => {
			displayOutputs.push({ type: "status", event });
		});
	let unregisterBridge: (() => void) | null = null;

	try {
		if (options) throwIfExecutionCancelled(options);
		unregisterBridge =
			options?.toolSession && options?.bridgeSessionId && options.bridge
				? registerPyToolBridge(options.bridgeSessionId, options.bridge.capability, {
						toolSession: options.toolSession,
						signal: options.signal,
						emitStatus,
					})
				: null;
		if (options) throwIfExecutionCancelled(options);
		executionTimeoutMs = requireRemainingTimeoutMs(deadlineMs);
		const result = await kernel.execute(code, {
			signal: options?.signal,
			timeoutMs: executionTimeoutMs,
			onChunk: text => sink.push(text),
			onDisplay: output => void displayOutputs.push(output),
		});
		if (options) throwIfExecutionCancelled(options);

		if (result.cancelled) {
			// Prefer the caller-configured timeout for the user-facing annotation.
			// Remaining wall-clock budget can shrink after async setup (Settings.init,
			// kernel start) and would otherwise flake Math.round() second formatting.
			const annotation = result.timedOut
				? formatKernelTimeoutAnnotation(options?.timeoutMs ?? executionTimeoutMs, result.kernelKilled ?? false)
				: undefined;
			let crashNotice: string | null = null;
			if (result.kernelKilled) {
				crashNotice = formatCrashDiagnosticNotice(
					await writeCrashReport(
						{
							kind: "python",
							exitCode: kernel.getExitCode?.(),
							cancelled: false,
							timedOut: result.timedOut,
							stderr: kernel.peekStderr?.(),
							protocol: "eval.py.kernel",
						},
						{ cwd: options?.cwd },
					),
				);
			}
			const notice = [annotation, crashNotice].filter(text => text).join("; ") || undefined;
			return {
				exitCode: undefined,
				cancelled: true,
				displayOutputs,
				stdinRequested: result.stdinRequested,
				...(await sink.dump(notice)),
			};
		}

		if (result.stdinRequested) {
			return {
				exitCode: 1,
				cancelled: false,
				displayOutputs,
				stdinRequested: true,
				...(await sink.dump("Kernel requested stdin; interactive input is not supported.")),
			};
		}

		const exitCode = result.status === "ok" ? 0 : 1;
		return {
			exitCode,
			cancelled: false,
			displayOutputs,
			stdinRequested: false,
			...(await sink.dump()),
		};
	} catch (err) {
		if (isCancellationError(err) || options?.signal?.aborted) {
			const timedOut = isTimedOutCancellation(err, options?.signal);
			return {
				exitCode: undefined,
				cancelled: true,
				displayOutputs,
				stdinRequested: false,
				...(await sink.dump(
					timedOut ? formatTimeoutAnnotation(options?.timeoutMs ?? executionTimeoutMs) : undefined,
				)),
			};
		}
		const error = err instanceof Error ? err : new Error(String(err));
		logger.error("Python execution failed", { error: error.message });
		throw error;
	} finally {
		unregisterBridge?.();
	}
}

async function ensureKernelAvailable(cwd: string, options: PythonExecutorOptions): Promise<void> {
	throwIfExecutionCancelled(options);
	const availability = await checkPythonKernelAvailability(
		cwd,
		options.runtimeOptions,
		{
			signal: options.signal,
			deadlineMs: options.deadlineMs,
		},
		options.settings,
	);
	throwIfExecutionCancelled(options);
	if (!availability.ok) {
		throw new Error(availability.reason ?? "Python kernel unavailable");
	}
}

async function ensureToolBridge(options: PythonExecutorOptions): Promise<void> {
	if (!options.toolSession || options.bridge) return;
	throwIfExecutionCancelled(options);
	try {
		const bridge = await ensurePyToolBridge();
		throwIfExecutionCancelled(options);
		options.bridge = { ...bridge, capability: crypto.randomUUID() };
	} catch (err) {
		if (isCancellationError(err) || options.signal?.aborted) throw err;
		logger.warn("Failed to start Python tool bridge", {
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

async function executePerCall(code: string, cwd: string, options: PythonExecutorOptions): Promise<PythonResult> {
	throwIfExecutionCancelled(options);
	if (options.bridge && !options.bridgeSessionId) {
		options.bridgeSessionId = `py-bridge:${crypto.randomUUID()}`;
	}
	const kernel = await startKernel(cwd, options);
	try {
		throwIfExecutionCancelled(options);
		return await executeWithKernel(kernel, code, options);
	} finally {
		await kernel.shutdown().catch(() => undefined);
	}
}

async function executeOnSession(code: string, cwd: string, options: PythonExecutorOptions): Promise<PythonResult> {
	throwIfExecutionCancelled(options);
	const sessionId = scopedSessionId(
		options.sessionId ?? `session:${cwd}`,
		options.settings,
		options.sessionId !== undefined,
	);
	if (options.bridge && !options.bridgeSessionId) {
		options.bridgeSessionId = sessionId;
	}
	if (options.reset) {
		throwIfExecutionCancelled(options);
		await resetSession(sessionId);
		throwIfExecutionCancelled(options);
	}
	const session = await acquireSession(sessionId, cwd, options);
	throwIfExecutionCancelled(options);
	if (options.bridge && session.bridgeCapability) {
		options.bridge.capability = session.bridgeCapability;
	}
	options.onKernelStart?.(session.kernelInstanceId);
	return await runQueued(session, options, async () => {
		throwIfExecutionCancelled(options);
		if (sessions.get(session.sessionId) !== session) {
			throw new PythonExecutionCancelledError(false);
		}
		if (!session.kernel.isAlive()) {
			throwIfExecutionCancelled(options);
			await replaceSessionKernel(session, cwd, options);
			throwIfExecutionCancelled(options);
			if (sessions.get(session.sessionId) !== session) {
				throw new PythonExecutionCancelledError(false);
			}
			options.onKernelStart?.(session.kernelInstanceId);
		}
		try {
			throwIfExecutionCancelled(options);
			return await executeWithKernel(session.kernel, code, options);
		} catch (err) {
			if (isCancellationError(err) || options.signal?.aborted) throw err;
			if (session.kernel.isAlive()) throw err;
			if (sessions.get(session.sessionId) !== session) {
				throw new PythonExecutionCancelledError(false);
			}
			// Kernel died during execute. Replace it and retry once on a fresh one.
			throwIfExecutionCancelled(options);
			await replaceSessionKernel(session, cwd, options);
			throwIfExecutionCancelled(options);
			if (sessions.get(session.sessionId) !== session) {
				throw new PythonExecutionCancelledError(false);
			}
			options.onKernelStart?.(session.kernelInstanceId);
			return await executeWithKernel(session.kernel, code, options);
		}
	});
}

export async function executePythonWithKernel(
	kernel: PythonKernelExecutor,
	code: string,
	options?: PythonExecutorOptions,
): Promise<PythonResult> {
	const tracked = beginPythonRequest(options);
	try {
		return await executeWithKernel(kernel, code, tracked.options);
	} catch (err) {
		if (isCancellationError(err) || tracked.options.signal?.aborted) {
			return createCancelledPythonResult(
				isTimedOutCancellation(err, tracked.options.signal),
				tracked.options.timeoutMs,
			);
		}
		throw err;
	} finally {
		tracked.request.finish();
	}
}

export async function executePython(code: string, options?: PythonExecutorOptions): Promise<PythonResult> {
	const tracked = beginPythonRequest(options, true);
	const executionOptions = tracked.options;
	const cwd = tracked.cwd!;
	try {
		throwIfExecutionCancelled(executionOptions);
		await ensureKernelAvailable(cwd, executionOptions);
		throwIfExecutionCancelled(executionOptions);
		await ensureToolBridge(executionOptions);
		throwIfExecutionCancelled(executionOptions);

		const kernelMode = executionOptions.kernelMode ?? "session";
		if (kernelMode === "per-call") {
			return await executePerCall(code, cwd, executionOptions);
		}
		return await executeOnSession(code, cwd, executionOptions);
	} catch (err) {
		if (isCancellationError(err) || executionOptions.signal?.aborted) {
			return createCancelledPythonResult(isTimedOutCancellation(err, executionOptions.signal));
		}
		throw err;
	} finally {
		tracked.request.finish();
	}
}
