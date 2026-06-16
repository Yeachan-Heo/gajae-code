import { isCompiledBinary, logger, Snowflake } from "@gajae-code/utils";
import { registerResourceOwner } from "../../runtime/process-lifecycle";
import type { ToolSession } from "../../tools";
import { ToolAbortError, ToolError } from "../../tools/tool-errors";
import { callSessionTool, type JsStatusEvent } from "./tool-bridge";
import { WorkerCore } from "./worker-core";
// Worker entry. See `tab-supervisor.ts` for the rationale behind the
// literal-string + `new URL(import.meta.url)` hybrid: the literal is what
// Bun's `--compile` bundler discovers, the `new URL` form is what makes dev
// runs portable across cwds. The worker is registered as an additional
// `--compile` entrypoint in `scripts/build-binary.ts`.
import type {
	JsDisplayOutput,
	RunErrorPayload,
	SessionSnapshot,
	Transport,
	WorkerInbound,
	WorkerOutbound,
} from "./worker-protocol";

export { rewriteImports, wrapCode } from "./shared/rewrite-imports";
export type { JsDisplayOutput } from "./worker-protocol";

export interface VmRunState {
	signal?: AbortSignal;
	onText?: (chunk: string) => void;
	onDisplay?: (output: JsDisplayOutput) => void;
}

interface WorkerHandle {
	mode: "worker" | "inline";
	send(msg: WorkerInbound): void;
	onMessage(handler: (msg: WorkerOutbound) => void): () => void;
	terminate(): Promise<void>;
}

interface PendingRun {
	runId: string;
	runState: VmRunState;
	toolSession: ToolSession;
	resolve(value: { value: unknown }): void;
	reject(error: Error): void;
	toolCalls: Map<string, AbortController>;
	settled: boolean;
}

interface ReadyDeferred {
	promise: Promise<JsSession>;
	resolve(session: JsSession): void;
	reject(error: Error): void;
}

interface QueueDeferred {
	promise: Promise<void>;
	resolve(): void;
	reject(error: Error): void;
}

interface JsSession {
	sessionKey: string;
	worker?: WorkerHandle;
	state: "starting" | "alive" | "dead";
	ownerId?: string;
	pending: Map<string, PendingRun>;
	queue: Promise<void>;
	queuedWaiters: Set<(error: Error) => void>;
	queueTail: QueueDeferred;
	controllers: Set<AbortController>;
	runSignal?: AbortSignal;
	ready: ReadyDeferred;
	unsubscribe?: () => void;
	unregistered?: () => void;
}

const sessions = new Map<string, JsSession>();
const sessionWaiters = new Map<string, Set<(error: Error) => void>>();
let vmResourceCleanupRegistered = false;

function ensureVmResourceCleanup(): void {
	if (vmResourceCleanupRegistered) return;
	vmResourceCleanupRegistered = true;
	registerResourceOwner("js-vm-contexts", async () => {
		try {
			await disposeAllVmContexts();
		} finally {
			vmResourceCleanupRegistered = false;
		}
	});
}
const READY_TIMEOUT_MS_DEFAULT = 5_000;

function getSessionWaiters(sessionKey: string): Set<(error: Error) => void> {
	let waiters = sessionWaiters.get(sessionKey);
	if (!waiters) {
		waiters = new Set();
		sessionWaiters.set(sessionKey, waiters);
	}
	return waiters;
}

export async function executeInVmContext(options: {
	sessionKey: string;
	sessionId: string;
	cwd: string;
	session: ToolSession;
	ownerId?: string;
	reset?: boolean;
	code: string;
	filename: string;
	timeoutMs?: number;
	runState: VmRunState;
}): Promise<{ value: unknown }> {
	if (options.reset) {
		await resetVmContext(options.sessionKey);
	}
	const waiters = getSessionWaiters(options.sessionKey);
	const { promise: contextResetPromise, reject: rejectContextReset } = Promise.withResolvers<never>();
	contextResetPromise.catch(() => undefined);
	waiters.add(rejectContextReset);
	const runPromise = (async (): Promise<{ value: unknown }> => {
		const session = await acquireSession(
			options.sessionKey,
			{ cwd: options.cwd, sessionId: options.sessionId },
			options.ownerId,
			options.timeoutMs,
		);
		return await runQueued(session, () => runOnce(session, options));
	})();
	try {
		return await Promise.race([runPromise, contextResetPromise]);
	} finally {
		waiters.delete(rejectContextReset);
	}
}

export async function resetVmContext(sessionKey: string): Promise<void> {
	const session = sessions.get(sessionKey);
	if (!session) return;
	sessions.delete(sessionKey);
	const waiters = sessionWaiters.get(sessionKey);
	if (waiters) for (const reject of [...waiters]) reject(new ToolError("JS context reset"));
	await killSession(session, new ToolError("JS context reset"));
}

export async function disposeVmContextsByOwner(ownerId: string): Promise<void> {
	const owned = [...sessions.entries()].filter(
		([sessionKey, session]) =>
			session.ownerId === ownerId || sessionKey === ownerId || sessionKey === `js:${ownerId}`,
	);
	for (const [sessionKey, session] of owned) {
		if (sessions.get(sessionKey) === session) sessions.delete(sessionKey);
	}
	await Promise.all(owned.map(([, session]) => killSession(session, new ToolError("JS context disposed"))));
}

export async function disposeAllVmContexts(): Promise<void> {
	const all = [...sessions.values()];
	sessions.clear();
	await Promise.all(all.map(session => killSession(session, new ToolError("JS context disposed"))));
}

export function liveVmContextCount(): number {
	return [...sessions.values()].filter(session => session.state !== "dead").length;
}

async function runQueued<T>(session: JsSession, work: () => Promise<T>): Promise<T> {
	if (session.state !== "alive") throw new ToolError("JS worker is not alive");
	const previous = session.queue;
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	const queueController = new AbortController();
	const queueItem: QueueDeferred = { promise, resolve, reject };
	const rejectWaiter = (error: Error): void => queueItem.reject(error);
	session.queuedWaiters.add(rejectWaiter);
	session.controllers.add(queueController);
	session.queueTail = queueItem;
	session.queue = (async () => {
		await previous.catch(() => undefined);
		await queueItem.promise;
	})().catch(() => undefined);
	try {
		await Promise.race([previous.catch(() => undefined), queueItem.promise, abortPromise(queueController.signal)]);
		if (session.runSignal?.aborted) throw reasonToError(session.runSignal.reason, "JS worker is not alive");
		if (session.state !== "alive") throw new ToolError("JS worker is not alive");
		session.queuedWaiters.delete(rejectWaiter);
		return await Promise.race([
			work(),
			queueItem.promise.then(() => new Promise<never>(() => {})),
			abortPromise(queueController.signal),
		]);
	} finally {
		session.queuedWaiters.delete(rejectWaiter);
		session.controllers.delete(queueController);
		queueItem.resolve();
	}
}

async function runOnce(
	session: JsSession,
	options: {
		sessionId: string;
		cwd: string;
		session: ToolSession;
		code: string;
		filename: string;
		runState: VmRunState;
	},
): Promise<{ value: unknown }> {
	const runId = `r-${Snowflake.next()}`;
	const { promise, resolve, reject } = Promise.withResolvers<{ value: unknown }>();
	const sessionSignal = session.runSignal;
	const pending: PendingRun = {
		runId,
		runState: options.runState,
		toolSession: options.session,
		resolve,
		reject,
		toolCalls: new Map(),
		settled: false,
	};
	session.pending.set(runId, pending);

	const onAbort = (): void => {
		const reason = options.runState.signal?.reason;
		const abortError = reasonToError(reason, "Execution aborted");
		// Cancel any in-flight tool calls first.
		for (const ctrl of pending.toolCalls.values()) ctrl.abort(abortError);
		// Hard-kill the worker — only way to interrupt synchronous user code.
		void killSessionFor(session, abortError);
	};

	if (options.runState.signal?.aborted) {
		queueMicrotask(onAbort);
	} else {
		options.runState.signal?.addEventListener("abort", onAbort, { once: true });
	}

	try {
		if (sessionSignal?.aborted) throw reasonToError(sessionSignal.reason, "JS worker is not alive");
		if (
			!safeSend(session, {
				type: "run",
				runId,
				code: options.code,
				filename: options.filename,
				snapshot: { cwd: options.cwd, sessionId: options.sessionId },
			})
		) {
			settleRunWithError(session, pending, new ToolError("JS worker send failed"));
			return await promise;
		}
		return await promise;
	} finally {
		options.runState.signal?.removeEventListener("abort", onAbort);
		session.pending.delete(runId);
	}
}

async function acquireSession(
	sessionKey: string,
	snapshot: SessionSnapshot,
	ownerId: string | undefined,
	timeoutMs?: number,
): Promise<JsSession> {
	ensureVmResourceCleanup();
	const existing = sessions.get(sessionKey);
	if (existing && existing.state !== "dead") return await existing.ready.promise;

	const { promise: ready, resolve: resolveSession, reject: rejectSession } = Promise.withResolvers<JsSession>();
	ready.catch(() => undefined);
	const session: JsSession = {
		sessionKey,
		state: "starting",
		ownerId,
		pending: new Map(),
		queue: Promise.resolve(),
		queuedWaiters: new Set(),
		queueTail: settledQueueDeferred(),
		controllers: new Set(),
		ready: { promise: ready, resolve: resolveSession, reject: rejectSession },
	};
	sessions.set(sessionKey, session);

	let worker: WorkerHandle | undefined;
	try {
		worker = await spawnJsWorker();
		const current = sessions.get(sessionKey);
		if (current !== session) {
			await worker.terminate().catch(() => undefined);
			return (
				(await current?.ready.promise) ?? Promise.reject(new ToolError("JS context replaced during initialization"))
			);
		}
		session.worker = worker;
		const { promise: readyPromise, resolve: resolveReady, reject: rejectReady } = Promise.withResolvers<void>();
		let resolved = false;
		session.unsubscribe = worker.onMessage(msg => {
			if (!resolved && msg.type === "ready") {
				resolved = true;
				resolveReady();
				return;
			}
			if (!resolved && msg.type === "init-failed") {
				resolved = true;
				rejectReady(errorFromPayload(msg.error));
				return;
			}
			handleSessionMessage(session, msg);
		});
		const readyTimeoutMs = Math.max(READY_TIMEOUT_MS_DEFAULT, timeoutMs ?? 0);
		await raceWithTimeout(readyPromise, readyTimeoutMs, "Timed out initializing JS eval worker");
		if (sessions.get(sessionKey) !== session) {
			await killSession(session, new ToolError("JS context replaced during initialization"));
			return (
				(await sessions.get(sessionKey)?.ready.promise) ??
				Promise.reject(new ToolError("JS context replaced during initialization"))
			);
		}
		worker.send({ type: "init", snapshot });
		session.state = "alive";
		session.ready.resolve(session);
		return session;
	} catch (error) {
		if (sessions.get(sessionKey) === session) sessions.delete(sessionKey);
		await killSession(session, error instanceof Error ? error : new Error(String(error)));
		session.ready.reject(error instanceof Error ? error : new Error(String(error)));
		throw error;
	}
}

function handleSessionMessage(session: JsSession, msg: WorkerOutbound): void {
	switch (msg.type) {
		case "text": {
			const pending = session.pending.get(msg.runId);
			pending?.runState.onText?.(msg.chunk);
			return;
		}
		case "display": {
			const pending = session.pending.get(msg.runId);
			pending?.runState.onDisplay?.(msg.output);
			return;
		}
		case "tool-call":
			void handleToolCall(session, msg);
			return;
		case "result":
			settlePending(session, msg);
			return;
		case "log":
			logWorkerMessage(msg);
			return;
		case "ready":
		case "init-failed":
		case "closed":
			return;
	}
}

async function handleToolCall(session: JsSession, msg: Extract<WorkerOutbound, { type: "tool-call" }>): Promise<void> {
	const pending = session.pending.get(msg.runId);
	if (!pending) {
		safeSend(session, {
			type: "tool-reply",
			id: msg.id,
			reply: { ok: false, error: { message: "Run no longer active" } },
		});
		return;
	}
	const ctrl = new AbortController();
	pending.toolCalls.set(msg.id, ctrl);
	try {
		const value = await callSessionTool(msg.name, msg.args, {
			session: pending.toolSession,
			signal: ctrl.signal,
			emitStatus: (event: JsStatusEvent) => pending.runState.onDisplay?.({ type: "status", event }),
		});
		safeSend(session, { type: "tool-reply", id: msg.id, reply: { ok: true, value } });
	} catch (error) {
		safeSend(session, { type: "tool-reply", id: msg.id, reply: { ok: false, error: toErrorPayload(error) } });
	} finally {
		pending.toolCalls.delete(msg.id);
	}
}

function settlePending(session: JsSession, msg: Extract<WorkerOutbound, { type: "result" }>): void {
	const pending = session.pending.get(msg.runId);
	if (!pending || pending.settled) return;
	pending.settled = true;
	if (msg.ok) {
		pending.resolve({ value: undefined });
		return;
	}
	pending.reject(errorFromPayload(msg.error));
}

async function killSessionFor(session: JsSession, error: Error): Promise<void> {
	if (sessions.get(session.sessionKey) === session) {
		sessions.delete(session.sessionKey);
	}
	await killSession(session, error);
}

async function killSession(session: JsSession, error: Error): Promise<void> {
	if (session.state === "dead") return;
	session.state = "dead";
	const unsubscribe = session.unsubscribe;
	session.unsubscribe = undefined;
	unsubscribe?.();
	session.ready.reject(error);
	session.queueTail.reject(error);
	for (const controller of [...session.controllers]) controller.abort(error);
	session.controllers.clear();
	session.runSignal = AbortSignal.abort(error);
	for (const reject of [...session.queuedWaiters]) reject(error);
	session.queuedWaiters.clear();
	for (const pending of [...session.pending.values()]) settleRunWithError(session, pending, error);
	session.pending.clear();
	void session.worker?.terminate().catch(() => undefined);
}

function settleRunWithError(session: JsSession, pending: PendingRun, error: Error): void {
	if (pending.settled) return;
	pending.settled = true;
	for (const ctrl of pending.toolCalls.values()) ctrl.abort(error);
	pending.toolCalls.clear();
	session.pending.delete(pending.runId);
	pending.reject(error);
}

function settledQueueDeferred(): QueueDeferred {
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	resolve();
	return { promise, resolve, reject };
}

function abortPromise(signal: AbortSignal): Promise<never> {
	if (signal.aborted) return Promise.reject(reasonToError(signal.reason, "JS worker is not alive"));
	const { promise, reject } = Promise.withResolvers<never>();
	const onAbort = (): void => reject(reasonToError(signal.reason, "JS worker is not alive"));
	signal.addEventListener("abort", onAbort, { once: true });
	promise.finally(() => signal.removeEventListener("abort", onAbort)).catch(() => undefined);
	return promise;
}

function safeSend(session: JsSession, msg: WorkerInbound): boolean {
	if (session.state !== "alive") return false;
	try {
		session.worker?.send(msg);
		return true;
	} catch (err) {
		logger.debug("js worker send failed", { error: err instanceof Error ? err.message : String(err) });
		void killSessionFor(session, err instanceof Error ? err : new Error(String(err)));
		return false;
	}
}

function reasonToError(reason: unknown, fallback: string): Error {
	if (reason instanceof Error) return reason;
	if (typeof reason === "string") return new ToolAbortError(reason);
	return new ToolAbortError(fallback);
}

function errorFromPayload(payload: RunErrorPayload): Error {
	if (payload.isAbort) {
		const err = new ToolAbortError(payload.message || "Execution aborted");
		if (payload.stack) err.stack = payload.stack;
		return err;
	}
	const ctor = payload.isToolError ? ToolError : Error;
	const error = new ctor(payload.message);
	if (payload.name) error.name = payload.name;
	if (payload.stack) error.stack = payload.stack;
	return error;
}

function toErrorPayload(error: unknown): RunErrorPayload {
	if (error instanceof Error) {
		return {
			name: error.name,
			message: error.message,
			stack: error.stack,
			isAbort: error.name === "AbortError" || error.name === "ToolAbortError",
			isToolError: error instanceof ToolError || error.name === "ToolError",
		};
	}
	return { message: String(error) };
}

function logWorkerMessage(msg: Extract<WorkerOutbound, { type: "log" }>): void {
	if (msg.level === "debug") logger.debug(msg.msg, msg.meta);
	else if (msg.level === "warn") logger.warn(msg.msg, msg.meta);
	else logger.error(msg.msg, msg.meta);
}

async function raceWithTimeout<T>(promise: Promise<T>, timeoutMs: number, reason: string): Promise<T> {
	const timeoutSignal = AbortSignal.timeout(timeoutMs);
	const { promise: timeoutPromise, reject } = Promise.withResolvers<never>();
	const onAbort = (): void => reject(new ToolError(reason));
	timeoutSignal.addEventListener("abort", onAbort, { once: true });
	try {
		return await Promise.race([promise, timeoutPromise]);
	} finally {
		timeoutSignal.removeEventListener("abort", onAbort);
	}
}

async function spawnJsWorker(): Promise<WorkerHandle> {
	try {
		const worker = isCompiledBinary()
			? new Worker("./packages/coding-agent/src/eval/js/worker-entry.ts", { type: "module" })
			: new Worker(new URL("./worker-entry.ts", import.meta.url).href, { type: "module" });
		return wrapBunWorker(worker);
	} catch (err) {
		if (process.env.GAJAE_CODE_JS_EVAL_INLINE_WORKER === "1") {
			logger.warn("Bun Worker spawn failed; using test-only inline JS eval worker", {
				error: err instanceof Error ? err.message : String(err),
			});
			return spawnInlineWorker();
		}
		throw new ToolError(
			`JS eval worker is unavailable and inline fallback is disabled because it cannot interrupt synchronous user code: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}

function wrapBunWorker(worker: Worker): WorkerHandle {
	return {
		mode: "worker",
		send(msg) {
			worker.postMessage(msg);
		},
		onMessage(handler) {
			const wrap = (event: MessageEvent): void => handler(event.data as WorkerOutbound);
			worker.addEventListener("message", wrap);
			return () => worker.removeEventListener("message", wrap);
		},
		async terminate() {
			worker.terminate();
		},
	};
}

/**
 * Inline fallback for environments where Bun cannot spawn the worker entry
 * (e.g. some test runners). Preserves behavior but cannot interrupt synchronous
 * infinite loops because user code runs on the main thread.
 */
function spawnInlineWorker(): WorkerHandle {
	const hostListeners = new Set<(message: WorkerOutbound) => void>();
	const workerListeners = new Set<(message: WorkerInbound) => void>();
	const workerTransport: Transport = {
		send: msg =>
			queueMicrotask(() => {
				for (const listener of hostListeners) listener(msg);
			}),
		onMessage: handler => {
			workerListeners.add(handler);
			return () => workerListeners.delete(handler);
		},
		close: () => {},
	};
	new WorkerCore(workerTransport);
	return {
		mode: "inline",
		send: msg =>
			queueMicrotask(() => {
				for (const listener of workerListeners) listener(msg);
			}),
		onMessage: handler => {
			hostListeners.add(handler);
			return () => hostListeners.delete(handler);
		},
		async terminate() {
			hostListeners.clear();
			workerListeners.clear();
		},
	};
}
