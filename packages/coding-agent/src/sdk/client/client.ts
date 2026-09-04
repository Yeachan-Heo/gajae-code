import { createHash, randomUUID } from "node:crypto";

export type SdkErrorCode =
	| "invalid_input"
	| "unknown_operation"
	| "not_found"
	| "unavailable"
	| "timeout"
	| "connection_closed"
	| "uncertain_after_send"
	| "endpoint_credential_forbidden"
	| (string & {});

export class SdkClientError extends Error {
	readonly code: SdkErrorCode;
	readonly details: unknown;
	/**
	 * Reconnect-cycle diagnostics, separate from `details` because `details` is an
	 * established contract: callers read the terminating transport error straight off
	 * it (`session-cli.ts` matches `details.code` against `ENOENT`/`ECONNREFUSED`, and
	 * lifecycle callers cast it to a sent record). Wrapping that value would silently
	 * break every such reader, so the new attribution rides alongside it instead.
	 */
	readonly reconnect?: SdkReconnectExhaustedDetails;
	constructor(code: SdkErrorCode, message: string, details?: unknown, reconnect?: SdkReconnectExhaustedDetails) {
		super(message);
		this.name = "SdkClientError";
		this.code = code;
		this.details = details;
		if (reconnect) this.reconnect = reconnect;
	}
}

/** A prepared transport operation failed before any wire handoff. */
export class SdkPreparedDispatchError extends SdkClientError {
	constructor(error: SdkClientError) {
		super(error.code, error.message, error.details, error.reconnect);
		this.name = "SdkPreparedDispatchError";
	}
}

export type SdkReconnectTerminationReason = "attempts_exhausted" | "deadline" | "cancelled";

/**
 * Reconnect-cycle termination diagnostics. `attemptsConsumed` counts retry slots,
 * not socket opens: the initial open is free, so the loop can open one more socket
 * than `attemptBudget`. Both values are therefore directly comparable.
 *
 * `reason` is authoritative. `attemptsConsumed < attemptBudget` is corroborating
 * evidence of truncation, not a classifier: a zero-attempt client that trips its
 * deadline immediately reports `0 === 0` and is still deadline-terminated.
 */
export interface SdkReconnectExhaustedDetails {
	readonly attemptsConsumed: number;
	readonly attemptBudget: number;
	readonly elapsedMs: number;
	readonly reason: SdkReconnectTerminationReason;
}

/**
 * Deadline a one-shot request client waits for a reply. Long-lived session
 * clients override it per request; see `SESSION_REQUEST_TIMEOUT_MS`.
 */
export const DEFAULT_SDK_REQUEST_TIMEOUT_MS = 10_000;

export interface SdkClientOptions {
	timeoutMs?: number;
	/** Absolute wall-clock deadline shared by connect, hello, retry, and request work. */
	deadline?: number;

	reconnectAttempts?: number;
	reconnectBackoffMs?: number;
	/**
	 * Per-attempt ceiling for the exponential reconnect backoff. A long reconnect
	 * budget must keep probing frequently instead of sleeping for tens of seconds
	 * on its last attempts. Defaults to 2s.
	 */
	reconnectMaxBackoffMs?: number;
}

export interface SdkRequestOptions {
	timeoutMs?: number;
	idempotencyKey?: string;
	confirm?: boolean;
	/**
	 * Synchronous pre-send observer for one request. Called after the
	 * connection is live and validated, immediately before the frame is written
	 * to the socket. Throwing aborts the dispatch: nothing is written, no sent
	 * record is retained, and the request rejects with the thrown error, so the
	 * caller may safely retry (pre-send semantics).
	 */
	beforeDispatch?: SdkBeforeDispatchHandler;
	/**
	 * Synchronous dispatch-boundary observer for one request. Called immediately
	 * after the frame was handed to the socket — never before — and before any
	 * other client work. From this point a transport close before the response
	 * settles the request as `uncertain_after_send`; observer exceptions cannot
	 * alter that settlement.
	 */
	onDispatch?: SdkDispatchHandler;
	/** Internal prepared-dispatch mode: fail pre-send instead of reconnecting. */
	connectedOnly?: boolean;
}
export type SdkFrame = Record<string, unknown>;
/**
 * Synchronous by contract. Returning a thenable (e.g. an `async` function) is a
 * contract violation: pre-send the dispatch aborts retryably and the eventual
 * rejection is sunk, never escaping to the process unhandled-rejection channel.
 */
export type SdkBeforeDispatchHandler = (request: SdkDispatchContext) => void;
/**
 * Synchronous by contract. A returned thenable's rejection is sunk; it can
 * neither displace request settlement nor escape to the process
 * unhandled-rejection channel.
 */
export type SdkDispatchHandler = (request: SdkDispatchContext) => void;

/**
 * Facts about one request at its dispatch boundary. `frame.id` is the exact
 * correlated identity a response frame must carry to settle this request.
 */
export interface SdkDispatchContext {
	readonly frame: SdkFrame;
	/** Transport generation this request was written to. */
	readonly connectionId: string | undefined;
	readonly generation: number;
}

/** Request identity retained after an uncertain send. */
export interface SdkSentRecord {
	readonly id: string;
	readonly operation?: string;
	readonly idempotencyKey?: string;
	/** Present for lifecycle lookups; `session.spawn` replays through its idempotency key. */
	readonly fingerprint?: string;
}

export type SdkFrameHandler = (frame: SdkFrame) => void;
export type SdkReconnectHandler = () => void;
export type SdkReconnectFailedHandler = (error: SdkClientError) => void;

type Frame = SdkFrame;
type Cycle = {
	readonly generation: number;
	phase: "opening" | "backoff" | "complete" | "aborted";
	candidate: Incarnation | null;
	promise?: Promise<Incarnation>;
	backoffTimer?: NodeJS.Timeout;
	rejectBackoff?: (error: Error) => void;
};
type Incarnation = {
	readonly generation: number;
	readonly cycle: Cycle;
	readonly socket: WebSocket;
	phase: "opening" | "hello" | "active" | "retired";
	tornDown: boolean;
	openTimer?: NodeJS.Timeout;
	failure?: Error;
	helloTimer?: NodeJS.Timeout;
	/** Hello frames that arrived before the open handler advanced phase to "hello". */
	earlyHello?: Frame;
	resolveOpen?: () => void;
	rejectOpen?: (error: Error) => void;
	resolveHello?: () => void;
	rejectHello?: (error: Error) => void;
	listeners: Array<["open" | "error" | "close" | "message", EventListener]>;
};
type Pending = {
	readonly incarnation: Incarnation;
	readonly connectedOnly: boolean;
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
	sent: boolean;
	onResponse?: () => void;
};

/**
 * Transport facts attached to a request timeout before an outcome is known.
 * A timeout after send is surfaced as `uncertain_after_send` with an
 * {@link SdkSentRecord} in its details.
 */
export interface SdkRequestTimeoutDetails {
	requestId: string;
	requestSent: boolean;
}

function errorFrom(frame: Frame): SdkClientError {
	const error = frame.error;
	if (error && typeof error === "object") {
		const detail = error as { code?: unknown; message?: unknown };
		return new SdkClientError(
			typeof detail.code === "string" ? detail.code : "unavailable",
			typeof detail.message === "string" ? detail.message : "SDK request failed",
			error,
		);
	}
	return new SdkClientError("unavailable", "SDK request failed", error);
}

function parseFrame(value: unknown): Frame {
	try {
		const frame = JSON.parse(String(value));
		if (frame && typeof frame === "object" && !Array.isArray(frame)) return frame as Frame;
	} catch (error) {
		throw new SdkClientError("protocol_error", "SDK server sent malformed JSON.", error);
	}
	throw new SdkClientError("protocol_error", "SDK server sent a malformed frame.");
}
/**
 * Recursively freezes the parsed request frame handed to dispatch-boundary
 * observers. The frame a consumer sees in `beforeDispatch`/`onDispatch` must be
 * the exact immutable bytes-derived identity that went on the wire, so a
 * mutating callback can never desynchronize the advertised identity or the
 * reconciliation fingerprint from the request that was actually sent.
 */
function deepFreeze<T>(value: T): T {
	if (value && typeof value === "object") {
		for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
		Object.freeze(value);
	}
	return value;
}

type Thenable = { then?: unknown };

/**
 * Observers are synchronous by contract, but TypeScript happily accepts an
 * `async` function where `() => void` is expected. A rejected promise returned
 * by an observer would otherwise reach the process-level unhandled-rejection
 * channel — terminating `--unhandled-rejections=strict` consumers — and a
 * rejected `beforeDispatch` would silently not abort the dispatch. Observers
 * that return a thenable are treated as a contract violation: detected
 * explicitly, sunk here, and (pre-send) failed before the wire.
 */
function isThenable(value: unknown): value is Thenable {
	return (
		(typeof value === "object" || typeof value === "function") &&
		value !== null &&
		typeof (value as Thenable).then === "function"
	);
}

function sinkThenable(value: unknown): void {
	const thenable = value as { then: (onFulfilled: unknown, onRejected: (error: unknown) => void) => unknown };
	try {
		thenable.then(undefined, () => {
			// Observer rejections never displace settlement; swallow them here
			// so they cannot escape to the process unhandled-rejection channel.
		});
	} catch {
		// A throwing then-accessor already surfaced synchronously to the caller
		// of the observer; nothing further to sink.
	}
}

function lifecycleFingerprint(operation: string, input: unknown): string {
	const identity =
		input !== null && typeof input === "object" && !Array.isArray(input)
			? { ...(input as Record<string, unknown>) }
			: input;
	if (identity !== null && typeof identity === "object" && !Array.isArray(identity)) {
		const lifecycleIdentity = identity as Record<string, unknown>;
		delete lifecycleIdentity.coordinatorSidecarSigningKey;
		delete lifecycleIdentity.coordinatorSidecarKeyId;
	}
	return createHash("sha256")
		.update(JSON.stringify({ operation, input: identity }))
		.digest("hex");
}

function inputFingerprint(input: unknown): string {
	return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

/** A transport-only v3 SDK WebSocket client with no host or session authority. */
export class SdkClient {
	readonly #url: string;
	readonly #token: string;
	readonly #timeoutMs: number;
	readonly #reconnectAttempts: number;
	readonly #reconnectBackoffMs: number;
	readonly #reconnectMaxBackoffMs: number;
	/**
	 * Bounded grace for best-effort transport close, independent of the request
	 * deadline. Close teardown must never be gated by an already-elapsed operation
	 * deadline, or the socket leaks.
	 */
	readonly #closeGraceMs: number;
	readonly #deadline?: number;
	#currentSocketRecord: Incarnation | null = null;
	#opening: Cycle | null = null;
	#cycleGeneration = 0;
	#incarnationGeneration = 0;
	#pending = new Map<string, Pending>();
	#sentRecords = new Map<string, SdkSentRecord>();
	#frameHandlers = new Set<SdkFrameHandler>();
	#reconnectHandlers = new Set<SdkReconnectHandler>();
	#reconnectFailedHandlers = new Set<SdkReconnectFailedHandler>();
	#closePromise: Promise<void> | undefined;

	#closed = false;
	connectionId?: string;

	constructor(url: string, token: string, options: SdkClientOptions = {}) {
		this.#url = url;
		this.#token = token;
		this.#timeoutMs = options.timeoutMs ?? DEFAULT_SDK_REQUEST_TIMEOUT_MS;
		this.#closeGraceMs = Math.max(1, Math.min(this.#timeoutMs, 1_000));
		this.#deadline =
			typeof options.deadline === "number" && Number.isFinite(options.deadline) ? options.deadline : undefined;

		this.#reconnectAttempts = options.reconnectAttempts ?? 3;
		this.#reconnectBackoffMs = options.reconnectBackoffMs ?? 25;
		this.#reconnectMaxBackoffMs = Math.max(this.#reconnectBackoffMs, options.reconnectMaxBackoffMs ?? 2_000);
	}

	static async connect(url: string, token: string, options: SdkClientOptions = {}): Promise<SdkClient> {
		const client = new SdkClient(url, token, options);
		await client.connect();
		return client;
	}

	async connect(): Promise<void> {
		await this.#connect();
	}

	/** Resolves once the current WebSocket has received its server hello frame. */
	async awaitHello(): Promise<void> {
		await this.#connect();
	}

	onFrame(handler: SdkFrameHandler): () => void {
		this.#frameHandlers.add(handler);
		return () => this.#frameHandlers.delete(handler);
	}

	onReconnect(handler: SdkReconnectHandler): () => void {
		this.#reconnectHandlers.add(handler);
		return () => this.#reconnectHandlers.delete(handler);
	}

	onReconnectFailed(handler: SdkReconnectFailedHandler): () => void {
		this.#reconnectFailedHandlers.add(handler);
		return () => this.#reconnectFailedHandlers.delete(handler);
	}

	send(frame: SdkFrame): void {
		if (this.#closed) throw new SdkClientError("connection_closed", "SDK client closed");
		this.#throwIfDeadlineElapsed();
		const current = this.#currentSocketRecord ?? this.#opening?.candidate;
		const authoritative =
			this.#isActive(current ?? null) ||
			(!!current && current.phase === "hello" && this.#isCandidate(current.cycle, current));
		if (!current || !authoritative || current.socket.readyState !== WebSocket.OPEN)
			throw new SdkClientError("connection_closed", "SDK WebSocket is not connected");
		try {
			current.socket.send(JSON.stringify(frame));
		} catch (error) {
			throw new SdkClientError("unavailable", "SDK WebSocket send failed", error);
		}
	}

	request(frame: SdkFrame, options?: number | SdkRequestOptions): Promise<SdkFrame> {
		const resolved = typeof options === "number" ? { timeoutMs: options } : (options ?? {});
		return this.#request(frame, resolved) as Promise<SdkFrame>;
	}

	close(): Promise<void> {
		this.#closePromise ??= this.#close();
		return this.#closePromise;
	}
	async #close(): Promise<void> {
		this.#closed = true;
		const transports = new Set<Incarnation>();
		const cycle = this.#opening;
		if (cycle) {
			cycle.phase = "aborted";
			if (cycle.backoffTimer) clearTimeout(cycle.backoffTimer);
			if (cycle.candidate) {
				transports.add(cycle.candidate);
				this.#retire(cycle.candidate, new SdkClientError("connection_closed", "SDK client closed"), false);
			}
			cycle.rejectBackoff?.(new SdkClientError("connection_closed", "SDK client closed"));
			cycle.rejectBackoff = undefined;
			if (this.#opening === cycle) this.#opening = null;
		}
		const current = this.#currentSocketRecord;
		if (current) {
			transports.add(current);
			this.#retire(current, new SdkClientError("connection_closed", "SDK client closed"), false, true);
		}
		for (const [id, pending] of this.#pending)
			this.#settlePending(id, pending, new SdkClientError("connection_closed", "SDK client closed"), true);
		try {
			await Promise.all([...transports].map(incarnation => this.#closeTransport(incarnation)));
		} finally {
			this.#sentRecords.clear();
		}
	}

	async control(
		operation: string,
		input: Record<string, unknown> = {},
		options: SdkRequestOptions = {},
	): Promise<unknown> {
		return await this.#request(
			{
				type: "control_request",
				operation,
				input,
				...(options.confirm === undefined ? {} : { confirm: options.confirm }),
			},
			options,
		);
	}

	async query(
		query: string,
		input: Record<string, unknown> = {},
		cursor?: string,
		options: SdkRequestOptions = {},
	): Promise<unknown> {
		return await this.#request(
			{ type: "query_request", query, input, ...(cursor === undefined ? {} : { cursor }) },
			options,
		);
	}

	async global(
		operation: string,
		input: Record<string, unknown> = {},
		options: SdkRequestOptions = {},
	): Promise<unknown> {
		return await this.#request({ type: "broker_request", operation, input }, options);
	}

	getSentRecord(id: string): SdkSentRecord | undefined {
		return this.#sentRecords.get(id);
	}
	#rememberSentRecord(record: SdkSentRecord): void {
		this.#sentRecords.set(record.id, record);
		while (this.#sentRecords.size > 256) {
			const oldest = this.#sentRecords.keys().next().value;
			if (oldest === undefined) return;
			this.#sentRecords.delete(oldest);
		}
	}
	async lookupLifecycle(record: SdkSentRecord, timeoutMs?: number): Promise<unknown> {
		if (!record.operation || !record.idempotencyKey || !record.fingerprint)
			throw new SdkClientError(
				"invalid_input",
				"A lifecycle sent record requires operation, idempotencyKey, and fingerprint.",
			);
		return await this.#request(
			{
				type: "broker_request",
				operation: "broker.lookup_lifecycle",
				input: { operation: record.operation, fingerprint: record.fingerprint },
			},
			{ timeoutMs, idempotencyKey: record.idempotencyKey },
			() => this.#sentRecords.delete(record.id),
		);
	}

	async #request(frame: Frame, options: SdkRequestOptions, onResponse?: () => void): Promise<unknown> {
		if (this.#closed) {
			const error = new SdkClientError("connection_closed", "SDK client closed");
			throw options.connectedOnly ? new SdkPreparedDispatchError(error) : error;
		}
		try {
			this.#throwIfDeadlineElapsed();
		} catch (error) {
			if (options.connectedOnly && error instanceof SdkClientError) throw new SdkPreparedDispatchError(error);
			throw error;
		}
		let incarnation: Incarnation;
		if (options.connectedOnly) {
			try {
				incarnation = this.#requireConnectedIncarnation();
			} catch (error) {
				if (error instanceof SdkClientError) throw new SdkPreparedDispatchError(error);
				throw error;
			}
		} else incarnation = await this.#connect();
		const timeoutMs = this.#remainingTimeout(options.timeoutMs ?? this.#timeoutMs);
		if (timeoutMs <= 0) {
			const error = this.#deadlineError();
			throw options.connectedOnly ? new SdkPreparedDispatchError(error) : error;
		}
		const id = randomUUID();
		const requestFrame = {
			...frame,
			id,
			...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
		};
		const serializedRequest = JSON.stringify(requestFrame);
		const serializedFrame: Frame = deepFreeze(JSON.parse(serializedRequest) as Frame);
		// Snapshot reconciliation identity from the exact serialized bytes BEFORE any
		// observer runs. Callers own `options`, so rereading `options.idempotencyKey`
		// or recomputing the fingerprint after a callback would let a mutating or
		// getter-swapping observer diverge the retained record from the wire request.
		const sentOperation = typeof serializedFrame.operation === "string" ? serializedFrame.operation : undefined;
		const sentIdempotencyKey =
			typeof serializedFrame.idempotencyKey === "string" ? serializedFrame.idempotencyKey : undefined;
		const isSpawn = sentOperation === "session.spawn";
		const sentFingerprint = isSpawn
			? undefined
			: typeof serializedFrame.operation === "string"
				? lifecycleFingerprint(serializedFrame.operation, serializedFrame.input ?? {})
				: inputFingerprint(serializedFrame.input ?? {});
		const deferred = Promise.withResolvers<unknown>();
		const pending: Pending = {
			incarnation,
			connectedOnly: options.connectedOnly === true,
			resolve: deferred.resolve,
			reject: deferred.reject,
			sent: false,
			onResponse,
			timer: setTimeout(
				() =>
					this.#settlePending(
						id,
						pending,
						new SdkClientError("timeout", `SDK request timed out after ${timeoutMs}ms`, {
							requestId: id,
							requestSent: pending.sent,
						} satisfies SdkRequestTimeoutDetails),
						true,
					),
				timeoutMs,
			),
		};
		this.#pending.set(id, pending);
		if (!this.#isActive(incarnation) || incarnation.socket.readyState !== WebSocket.OPEN) {
			const error = new SdkClientError("unavailable", "SDK WebSocket is not connected");
			this.#settlePending(id, pending, options.connectedOnly ? new SdkPreparedDispatchError(error) : error);
			return await deferred.promise;
		}
		if (options.beforeDispatch) {
			try {
				const observerResult = options.beforeDispatch({
					frame: serializedFrame,
					connectionId: this.connectionId,
					generation: incarnation.generation,
				});
				if (isThenable(observerResult)) {
					// An async observer cannot honor the synchronous pre-send
					// contract: its abort decision is unavailable before the
					// write. Sink the eventual rejection so it never escapes,
					// and abort the dispatch pre-send (retryable, nothing on
					// the wire).
					sinkThenable(observerResult);
					this.#settlePending(
						id,
						pending,
						new SdkClientError(
							"invalid_input",
							"beforeDispatch must be synchronous; an async observer cannot gate the dispatch boundary.",
						),
						false,
					);
					return await deferred.promise;
				}
			} catch (error) {
				// Pre-send abort: the wire never saw this request, so retirement
				// must not retain a sent record or classify it as uncertain. The
				// caller's own rejection comes back unchanged so it stays
				// retryable and distinguishable from transport failure.
				this.#settlePending(
					id,
					pending,
					error instanceof Error ? error : new SdkClientError("invalid_input", String(error), error),
					false,
				);
				return await deferred.promise;
			}
		}
		// `beforeDispatch` is arbitrary synchronous caller code: it may have closed
		// the client, retired this incarnation, settled this pending entry, or run
		// the deadline past its end. Nothing about the pre-call validation still
		// holds, so revalidate all of it before the wire write and bookkeeping.
		if (this.#closed || this.#pending.get(id) !== pending || !this.#isActive(incarnation)) {
			if (this.#pending.get(id) === pending)
				this.#settlePending(
					id,
					pending,
					options.connectedOnly
						? new SdkPreparedDispatchError(
								new SdkClientError("connection_closed", "SDK client closed during dispatch"),
							)
						: new SdkClientError("connection_closed", "SDK client closed during dispatch"),
				);
			return await deferred.promise;
		}
		if (this.#deadline !== undefined && Date.now() >= this.#deadline) {
			const error = this.#deadlineError();
			this.#settlePending(id, pending, options.connectedOnly ? new SdkPreparedDispatchError(error) : error);
			return await deferred.promise;
		}
		if (incarnation.socket.readyState !== WebSocket.OPEN) {
			const error = new SdkClientError("unavailable", "SDK WebSocket is not connected");
			this.#settlePending(id, pending, options.connectedOnly ? new SdkPreparedDispatchError(error) : error);
			return await deferred.promise;
		}
		// Handoff bookkeeping is reentrancy-safe: `sent` flips BEFORE the wire
		// write so a send that synchronously triggers a close event or response
		// retires this request as already-sent (uncertain_after_send on close,
		// never pre-send), and the sent record is retained up-front for the same
		// reason. Only a synchronous send THROW rolls the pre-write state back:
		// nothing reached the transport, so the request stays retryable and
		// non-uncertain with no record retained.
		pending.sent = true;
		// A spawn claim replays only through its caller-provided idempotency key;
		// it deliberately has no lifecycle fingerprint. Retain the common sent
		// record anyway so an uncertain transport result tells the caller which
		// key can join that durable claim.
		this.#rememberSentRecord({
			id,
			...(sentOperation === undefined ? {} : { operation: sentOperation }),
			...(sentIdempotencyKey === undefined ? {} : { idempotencyKey: sentIdempotencyKey }),
			...(sentFingerprint === undefined ? {} : { fingerprint: sentFingerprint }),
		});
		try {
			incarnation.socket.send(serializedRequest);
		} catch (error) {
			if (this.#pending.get(id) === pending) {
				// Nothing was accepted by the transport (the write threw before
				// handoff), so this stays a retryable pre-send failure — unless a
				// reentrant event already settled the request during the throw,
				// in which case that settlement stands and must not be displaced.
				pending.sent = false;
				this.#sentRecords.delete(id);
				const sendError =
					error instanceof SdkClientError
						? error
						: new SdkClientError("unavailable", "SDK WebSocket send failed", error);
				this.#settlePending(
					id,
					pending,
					options.connectedOnly ? new SdkPreparedDispatchError(sendError) : sendError,
				);
			}
			return await deferred.promise;
		}
		// Reconciliation identity was retained above the send so reentrant
		// close/response handling finds it; nothing further to record here.
		try {
			const observerResult = options.onDispatch?.({
				frame: serializedFrame,
				connectionId: this.connectionId,
				generation: incarnation.generation,
			});
			if (isThenable(observerResult)) sinkThenable(observerResult);
		} catch {
			// The frame was already handed to the socket. An observer failure can
			// neither un-send it nor displace settlement, so the request stays
			// pending for its response, deadline, or transport-close retirement.
		}
		return await deferred.promise;
	}

	#deadlineError(reconnect?: SdkReconnectExhaustedDetails): SdkClientError {
		return new SdkClientError("timeout", "SDK client deadline elapsed.", undefined, reconnect);
	}

	#remainingTimeout(limit = this.#timeoutMs): number {
		if (this.#deadline === undefined) return limit;
		return Math.min(limit, Math.max(0, this.#deadline - Date.now()));
	}

	#throwIfDeadlineElapsed(): void {
		if (this.#deadline !== undefined && Date.now() >= this.#deadline) throw this.#deadlineError();
	}

	async #connect(): Promise<Incarnation> {
		this.#throwIfDeadlineElapsed();
		const current = this.#currentSocketRecord;
		if (current && this.#isActive(current) && current.socket.readyState === WebSocket.OPEN) return current;
		if (current)
			this.#retire(current, new SdkClientError("connection_closed", "SDK WebSocket connection closed"), true, true);

		let cycle = this.#opening;
		if (!cycle) {
			cycle = { generation: ++this.#cycleGeneration, phase: "opening", candidate: null };
			this.#opening = cycle;
			cycle.promise = this.#openWithRetry(cycle);
		}
		return await cycle.promise!;
	}

	#requireConnectedIncarnation(): Incarnation {
		const current = this.#currentSocketRecord;
		if (!current || !this.#isActive(current) || current.socket.readyState !== WebSocket.OPEN)
			throw new SdkClientError("connection_closed", "SDK WebSocket disconnected before prepared dispatch.");
		return current;
	}

	async #openWithRetry(cycle: Cycle): Promise<Incarnation> {
		const startedAt = Date.now();
		let attemptsConsumed = 0;
		let lastError: unknown;
		const diagnostics = (reason: SdkReconnectTerminationReason): SdkReconnectExhaustedDetails => ({
			attemptsConsumed,
			attemptBudget: this.#reconnectAttempts,
			elapsedMs: Date.now() - startedAt,
			reason,
		});
		const cancelled = (): SdkClientError =>
			new SdkClientError("connection_closed", "SDK client closed", lastError, diagnostics("cancelled"));
		/**
		 * A deadline and retry budget measure different failure axes. One-shot clients
		 * need the deadline to fast-fail their operation, while long-lived ACP sessions
		 * express their recovery window as retry slots. Honor both, but retain the
		 * terminating axis so a deadline-truncated session budget is not misdiagnosed
		 * as a host that consumed every retry.
		 */
		for (let attempt = 0; attempt <= this.#reconnectAttempts; attempt++) {
			if (this.#deadline !== undefined && Date.now() >= this.#deadline) {
				const error = this.#deadlineError(diagnostics("deadline"));
				this.#completeCycle(cycle, error);
				throw error;
			}
			if (!this.#isOpening(cycle)) throw cancelled();
			if (attempt > 0) attemptsConsumed++;
			try {
				const incarnation = await this.#open(cycle);
				if (!this.#isActive(incarnation) && (!this.#isOpening(cycle) || cycle.candidate !== incarnation))
					throw new SdkClientError("connection_closed", "SDK WebSocket is not connected");
				await this.#waitForHello(incarnation);
				if (this.#isActive(incarnation)) return incarnation;
				throw new SdkClientError("connection_closed", "SDK WebSocket is not connected");
			} catch (error) {
				lastError = error;
				if (!this.#isOpening(cycle)) throw cancelled();
				const candidate = cycle.candidate;
				if (candidate && candidate.phase !== "active")
					this.#retire(
						candidate,
						error instanceof SdkClientError
							? error
							: new SdkClientError("unavailable", "SDK WebSocket connection failed", error),
						true,
					);
				if (attempt < this.#reconnectAttempts) {
					const backoffMs = this.#remainingTimeout(
						Math.min(this.#reconnectBackoffMs * 2 ** attempt, this.#reconnectMaxBackoffMs),
					);
					if (backoffMs <= 0) break;
					cycle.phase = "backoff";
					// A close during the sleep rejects this promise. Left uncaught it escapes as
					// the bare teardown error, so the one cancellation that is hardest to observe
					// would be the only one carrying no attribution.
					const deferred = Promise.withResolvers<void>();
					cycle.rejectBackoff = deferred.reject;
					cycle.backoffTimer = setTimeout(() => deferred.resolve(), backoffMs);
					try {
						await deferred.promise;
					} catch (backoffRejection) {
						lastError = backoffRejection;
						throw cancelled();
					} finally {
						cycle.rejectBackoff = undefined;
						cycle.backoffTimer = undefined;
					}
					if (!this.#isOpening(cycle)) throw cancelled();
					cycle.phase = "opening";
				}
			}
		}
		if (!this.#isOpening(cycle)) throw cancelled();
		if (this.#deadline !== undefined && Date.now() >= this.#deadline) {
			const error = this.#deadlineError(diagnostics("deadline"));
			this.#completeCycle(cycle, error);
			throw error;
		}
		cycle.phase = "complete";
		if (this.#opening === cycle) this.#opening = null;
		const error = new SdkClientError(
			"reconnect_exhausted",
			"SDK WebSocket reconnect attempts exhausted",
			lastError,
			diagnostics("attempts_exhausted"),
		);
		this.#notifyReconnectFailedHandlers(error);
		throw error;
	}

	#completeCycle(cycle: Cycle, error: SdkClientError): void {
		if (cycle.backoffTimer) clearTimeout(cycle.backoffTimer);
		cycle.rejectBackoff?.(error);
		cycle.rejectBackoff = undefined;
		cycle.backoffTimer = undefined;
		const candidate = cycle.candidate;
		if (candidate) this.#retire(candidate, error, true);
		cycle.candidate = null;
		cycle.phase = "complete";
		if (this.#opening === cycle) this.#opening = null;
	}

	#open(cycle: Cycle): Promise<Incarnation> {
		const timeoutMs = this.#remainingTimeout();
		if (timeoutMs <= 0) return Promise.reject(this.#deadlineError());
		const deferred = Promise.withResolvers<Incarnation>();
		try {
			const url = new URL(this.#url);
			url.searchParams.set("token", this.#token);
			const socket = new WebSocket(url);
			const incarnation: Incarnation = {
				generation: ++this.#incarnationGeneration,
				cycle,
				socket,
				phase: "opening",
				tornDown: false,
				listeners: [],
				resolveOpen: () => deferred.resolve(incarnation),
				rejectOpen: deferred.reject,
			};
			cycle.candidate = incarnation;
			const add = (type: "open" | "error" | "close" | "message", listener: EventListener, once = false) => {
				incarnation.listeners.push([type, listener]);
				socket.addEventListener(type, listener, once ? { once: true } : undefined);
			};
			add(
				"open",
				(() => {
					if (!this.#isCandidate(cycle, incarnation) || incarnation.phase !== "opening") return;
					if (incarnation.openTimer) clearTimeout(incarnation.openTimer);
					incarnation.phase = "hello";
					incarnation.resolveOpen?.();
					incarnation.resolveOpen = undefined;
					incarnation.rejectOpen = undefined;
					this.#beginHello(incarnation);
					const earlyHello = incarnation.earlyHello;
					if (earlyHello) {
						incarnation.earlyHello = undefined;
						this.#acceptHello(incarnation, earlyHello);
						if (this.#isActive(incarnation)) this.#notifyFrameHandlers(earlyHello);
					}
				}) as EventListener,
				true,
			);
			add("error", ((event: Event) => this.#onSocketFailure(incarnation, event)) as EventListener);
			add("close", (() => this.#onSocketFailure(incarnation)) as EventListener);
			add("message", ((event: MessageEvent) => this.#onMessage(event.data, incarnation)) as EventListener);
			incarnation.openTimer = setTimeout(() => this.#onOpenTimeout(incarnation, timeoutMs), timeoutMs);
			incarnation.openTimer.unref?.();
		} catch (error) {
			deferred.reject(error);
		}
		return deferred.promise;
	}

	#beginHello(incarnation: Incarnation): void {
		const timeoutMs = this.#remainingTimeout();
		if (timeoutMs <= 0) {
			this.#retire(incarnation, this.#deadlineError(), true);
			return;
		}
		incarnation.helloTimer = setTimeout(() => {
			if (!this.#isCandidate(incarnation.cycle, incarnation) || incarnation.phase !== "hello") return;
			const error =
				this.#deadline !== undefined && Date.now() >= this.#deadline
					? this.#deadlineError()
					: new SdkClientError("protocol_error", "SDK server did not send a hello frame.");
			incarnation.rejectHello?.(error);
			this.#retire(incarnation, error, true);
		}, timeoutMs);
		incarnation.helloTimer.unref?.();
	}

	#waitForHello(incarnation: Incarnation): Promise<void> {
		if (incarnation.failure) return Promise.reject(incarnation.failure);
		if (this.#isActive(incarnation)) return Promise.resolve();
		if (!this.#isCandidate(incarnation.cycle, incarnation) || incarnation.phase !== "hello")
			return Promise.reject(new SdkClientError("connection_closed", "SDK WebSocket is not connected"));
		const deferred = Promise.withResolvers<void>();
		incarnation.resolveHello = deferred.resolve;
		incarnation.rejectHello = deferred.reject;
		return deferred.promise;
	}

	#onOpenTimeout(incarnation: Incarnation, timeoutMs: number): void {
		if (!this.#isCandidate(incarnation.cycle, incarnation) || incarnation.phase !== "opening") return;
		const error =
			this.#deadline !== undefined && Date.now() >= this.#deadline
				? this.#deadlineError()
				: new SdkClientError("timeout", `SDK WebSocket connection timed out after ${timeoutMs}ms`);
		incarnation.rejectOpen?.(error);
		this.#retire(incarnation, error, true);
	}

	#onSocketFailure(incarnation: Incarnation, event?: Event): void {
		if (!this.#isCandidate(incarnation.cycle, incarnation) && !this.#isActive(incarnation)) return;
		const detail = event as (Event & { error?: unknown; message?: unknown }) | undefined;
		const error =
			detail?.error instanceof Error
				? detail.error
				: new SdkClientError(
						"connection_closed",
						typeof detail?.message === "string" ? detail.message : "SDK WebSocket connection closed",
					);
		if (incarnation.phase === "opening") incarnation.rejectOpen?.(error);
		if (incarnation.phase === "hello") incarnation.rejectHello?.(error);
		this.#retire(
			incarnation,
			error instanceof SdkClientError
				? error
				: new SdkClientError("unavailable", "SDK WebSocket connection failed", error),
			true,
			true,
		);
	}

	#onMessage(value: unknown, incarnation: Incarnation): void {
		if (!this.#isCandidate(incarnation.cycle, incarnation) && !this.#isActive(incarnation)) return;
		let frame: Frame;
		try {
			frame = parseFrame(value);
			if (frame.type === "control_command_result" && typeof frame.message === "string")
				frame = parseFrame(frame.message);
		} catch (error) {
			this.#rejectPendingFor(
				incarnation,
				error instanceof SdkClientError
					? error
					: new SdkClientError("protocol_error", "SDK server sent malformed frame.", error),
			);
			return;
		}
		if (frame.type === "hello" || frame.type === "server_hello" || frame.type === "broker_hello") {
			if (incarnation.phase === "opening" && this.#isCandidate(incarnation.cycle, incarnation)) {
				// Buffer until the open handler advances phase; do not drop.
				incarnation.earlyHello = frame;
				return;
			}
			if (incarnation.phase === "hello" && this.#isCandidate(incarnation.cycle, incarnation)) {
				this.#acceptHello(incarnation, frame);
				if (this.#isActive(incarnation)) this.#notifyFrameHandlers(frame);
				return;
			}
			if (!this.#isActive(incarnation)) return;
			if (
				typeof frame.connectionId !== "string" ||
				frame.connectionId.length === 0 ||
				frame.connectionId === this.connectionId
			)
				return;
			this.connectionId = frame.connectionId;
			this.#notifyReconnectHandlers();
		}
		if (!this.#isActive(incarnation)) return;
		const id =
			typeof frame.id === "string" ? frame.id : typeof frame.requestId === "string" ? frame.requestId : undefined;
		if (id) {
			const pending = this.#pending.get(id);
			if (pending?.incarnation === incarnation) {
				this.#settlePending(
					id,
					pending,
					frame.ok === false || frame.status === "error" ? errorFrom(frame) : frame,
					false,
					true,
				);
			}
		}
		this.#notifyFrameHandlers(frame);
	}

	#notifyFrameHandlers(frame: Frame): void {
		for (const handler of [...this.#frameHandlers]) {
			try {
				handler(frame);
			} catch {
				// Observers cannot change transport settlement or prevent later observers.
			}
		}
	}

	#notifyReconnectHandlers(): void {
		for (const handler of [...this.#reconnectHandlers]) {
			try {
				handler();
			} catch {
				// Reconnect observers cannot change transport state or prevent later observers.
			}
		}
	}

	#notifyReconnectFailedHandlers(error: SdkClientError): void {
		for (const handler of [...this.#reconnectFailedHandlers]) {
			try {
				handler(error);
			} catch {
				// Failure observers cannot replace the typed transport error or prevent later observers.
			}
		}
	}

	#acceptHello(incarnation: Incarnation, frame: Frame): void {
		if (!this.#isCandidate(incarnation.cycle, incarnation) || incarnation.phase !== "hello") return;
		if (incarnation.helloTimer) clearTimeout(incarnation.helloTimer);
		const reconnecting =
			typeof frame.connectionId === "string" &&
			frame.connectionId.length > 0 &&
			this.connectionId !== undefined &&
			this.connectionId !== frame.connectionId;
		if (typeof frame.connectionId === "string" && frame.connectionId.length > 0)
			this.connectionId = frame.connectionId;
		incarnation.phase = "active";
		this.#currentSocketRecord = incarnation;
		incarnation.cycle.phase = "complete";
		if (this.#opening === incarnation.cycle) this.#opening = null;
		const resolveHello = incarnation.resolveHello;
		incarnation.resolveHello = undefined;
		incarnation.rejectHello = undefined;
		resolveHello?.();
		if (reconnecting) this.#notifyReconnectHandlers();
	}

	#settlePending(
		id: string,
		pending: Pending,
		result: unknown,
		transportFailure = false,
		responseReceived = false,
	): void {
		if (this.#pending.get(id) !== pending) return;
		this.#pending.delete(id);
		clearTimeout(pending.timer);
		if (responseReceived) pending.onResponse?.();
		if (result instanceof Error) {
			const errorResult =
				!pending.sent &&
				pending.connectedOnly &&
				result instanceof SdkClientError &&
				!(result instanceof SdkPreparedDispatchError)
					? new SdkPreparedDispatchError(result)
					: result;
			if (transportFailure && pending.sent && errorResult instanceof SdkClientError)
				pending.reject(
					new SdkClientError(
						"uncertain_after_send",
						"SDK request outcome is uncertain after the frame was sent.",
						this.#sentRecords.get(id),
					),
				);
			else {
				this.#sentRecords.delete(id);
				pending.reject(errorResult);
			}
			return;
		}
		this.#sentRecords.delete(id);
		pending.resolve(result);
	}
	#rejectPendingFor(incarnation: Incarnation, error: SdkClientError, transportFailure = false): void {
		for (const [id, pending] of this.#pending)
			if (pending.incarnation === incarnation) this.#settlePending(id, pending, error, transportFailure);
	}
	#retire(incarnation: Incarnation, error: SdkClientError, closeSocket: boolean, transportFailure = false): void {
		if (incarnation.tornDown) return;
		const phase = incarnation.phase;
		incarnation.phase = "retired";
		incarnation.failure = error;
		if (phase === "opening") incarnation.rejectOpen?.(error);
		if (phase === "hello") incarnation.rejectHello?.(error);
		incarnation.resolveOpen = undefined;
		incarnation.rejectOpen = undefined;
		incarnation.resolveHello = undefined;
		incarnation.rejectHello = undefined;
		this.#rejectPendingFor(incarnation, error, transportFailure);
		if (this.#currentSocketRecord === incarnation) this.#currentSocketRecord = null;
		if (incarnation.cycle.candidate === incarnation) incarnation.cycle.candidate = null;
		this.#teardown(incarnation, closeSocket);
	}
	#teardown(incarnation: Incarnation, closeSocket: boolean): void {
		if (incarnation.tornDown) return;
		incarnation.tornDown = true;
		if (incarnation.openTimer) clearTimeout(incarnation.openTimer);
		if (incarnation.helloTimer) clearTimeout(incarnation.helloTimer);
		for (const [type, listener] of incarnation.listeners) incarnation.socket.removeEventListener(type, listener);
		incarnation.listeners = [];
		if (closeSocket)
			try {
				incarnation.socket.close();
			} catch {}
	}
	async #closeTransport(incarnation: Incarnation): Promise<void> {
		const socket = incarnation.socket;
		if (socket.readyState === WebSocket.CLOSED) return;
		// Close teardown must always issue socket.close() and be bounded by a
		// dedicated close grace, never by the (possibly elapsed) request deadline —
		// gating on an expired deadline would throw before close and leak the socket.
		const timeoutMs = this.#closeGraceMs;
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		const onClose = (): void => resolve();
		socket.addEventListener("close", onClose, { once: true });
		const timer = setTimeout(
			() => reject(new SdkClientError("timeout", `SDK WebSocket close timed out after ${timeoutMs}ms`)),
			timeoutMs,
		);
		timer.unref?.();
		try {
			socket.close();
			if (Number(socket.readyState) === WebSocket.CLOSED) resolve();
			await promise;
		} catch (error) {
			if (error instanceof SdkClientError) throw error;
			if (Number(socket.readyState) !== WebSocket.CLOSED)
				throw new SdkClientError("connection_closed", "SDK WebSocket close failed", error);
		} finally {
			clearTimeout(timer);
			socket.removeEventListener("close", onClose);
		}
	}
	#isCandidate(cycle: Cycle, incarnation: Incarnation): boolean {
		return (
			!this.#closed &&
			this.#opening === cycle &&
			cycle.candidate === incarnation &&
			cycle.generation > 0 &&
			incarnation.generation > 0 &&
			incarnation.cycle === cycle &&
			(cycle.phase === "opening" || cycle.phase === "backoff")
		);
	}
	#isOpening(cycle: Cycle): boolean {
		return !this.#closed && this.#opening === cycle && (cycle.phase === "opening" || cycle.phase === "backoff");
	}
	#isActive(incarnation: Incarnation | null): boolean {
		return (
			!!incarnation &&
			incarnation.generation > 0 &&
			!this.#closed &&
			this.#currentSocketRecord === incarnation &&
			incarnation.phase === "active"
		);
	}
}
