import { randomUUID } from "node:crypto";

export type SdkErrorCode =
	| "invalid_input"
	| "unknown_operation"
	| "not_found"
	| "unavailable"
	| "timeout"
	| "connection_closed"
	| "endpoint_credential_forbidden"
	| (string & {});

export class SdkClientError extends Error {
	readonly code: SdkErrorCode;
	readonly details: unknown;
	constructor(code: SdkErrorCode, message: string, details?: unknown) {
		super(message);
		this.name = "SdkClientError";
		this.code = code;
		this.details = details;
	}
}

export interface SdkClientOptions {
	timeoutMs?: number;
	/** Absolute wall-clock deadline shared by connect, hello, retry, and request work. */
	deadline?: number;

	reconnectAttempts?: number;
	reconnectBackoffMs?: number;
}

export interface SdkRequestOptions {
	timeoutMs?: number;
	idempotencyKey?: string;
	confirm?: boolean;
}

export type SdkFrame = Record<string, unknown>;
export type SdkFrameHandler = (frame: SdkFrame) => void;
export type SdkReconnectHandler = () => void;
export type SdkReconnectFailedHandler = (error: SdkClientError) => void;

type Frame = SdkFrame;
type Cycle = {
	readonly generation: number;
	phase: "opening" | "backoff" | "complete" | "aborted";
	candidate: Incarnation | null;
	promise?: Promise<Incarnation>;
	backoffTimer?: ReturnType<typeof setTimeout>;
	rejectBackoff?: (error: Error) => void;
};
type Incarnation = {
	readonly generation: number;
	readonly cycle: Cycle;
	readonly socket: WebSocket;
	phase: "opening" | "hello" | "active" | "retired";
	tornDown: boolean;
	openTimer?: ReturnType<typeof setTimeout>;
	failure?: Error;
	helloTimer?: ReturnType<typeof setTimeout>;
	resolveOpen?: () => void;
	rejectOpen?: (error: Error) => void;
	resolveHello?: () => void;
	rejectHello?: (error: Error) => void;
	listeners: Array<["open" | "error" | "close" | "message", EventListener]>;
};
type Pending = {
	readonly incarnation: Incarnation;
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
};

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

/** A transport-only v3 SDK WebSocket client. It never imports or dispatches AgentSession. */
export class SdkClient {
	readonly #url: string;
	readonly #token: string;
	readonly #timeoutMs: number;
	readonly #reconnectAttempts: number;
	readonly #reconnectBackoffMs: number;
	readonly #deadline?: number;
	#currentSocketRecord: Incarnation | null = null;
	#opening: Cycle | null = null;
	#cycleGeneration = 0;
	#incarnationGeneration = 0;
	#pending = new Map<string, Pending>();
	#frameHandlers = new Set<SdkFrameHandler>();
	#reconnectHandlers = new Set<SdkReconnectHandler>();
	#reconnectFailedHandlers = new Set<SdkReconnectFailedHandler>();

	#closed = false;
	connectionId?: string;

	constructor(url: string, token: string, options: SdkClientOptions = {}) {
		this.#url = url;
		this.#token = token;
		this.#timeoutMs = options.timeoutMs ?? 10_000;
		this.#deadline =
			typeof options.deadline === "number" && Number.isFinite(options.deadline) ? options.deadline : undefined;

		this.#reconnectAttempts = options.reconnectAttempts ?? 3;
		this.#reconnectBackoffMs = options.reconnectBackoffMs ?? 25;
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

	request(frame: SdkFrame, timeout?: number | { timeoutMs?: number; idempotencyKey?: string }): Promise<SdkFrame> {
		const options = typeof timeout === "number" ? { timeoutMs: timeout } : (timeout ?? {});
		return this.#request(frame, options) as Promise<SdkFrame>;
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		const cycle = this.#opening;
		if (cycle) {
			cycle.phase = "aborted";
			if (cycle.backoffTimer) clearTimeout(cycle.backoffTimer);
			if (cycle.candidate)
				this.#retire(cycle.candidate, new SdkClientError("connection_closed", "SDK client closed"), true);
			cycle.rejectBackoff?.(new SdkClientError("connection_closed", "SDK client closed"));
			cycle.rejectBackoff = undefined;
			if (this.#opening === cycle) this.#opening = null;
		}
		const current = this.#currentSocketRecord;
		if (current) this.#retire(current, new SdkClientError("connection_closed", "SDK client closed"), true);
		for (const [id, pending] of this.#pending)
			this.#settlePending(id, pending, new SdkClientError("connection_closed", "SDK client closed"));
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

	async #request(frame: Frame, options: SdkRequestOptions): Promise<unknown> {
		if (this.#closed) throw new SdkClientError("connection_closed", "SDK client closed");
		this.#throwIfDeadlineElapsed();
		const incarnation = await this.#connect();
		const timeoutMs = this.#remainingTimeout(options.timeoutMs ?? this.#timeoutMs);
		if (timeoutMs <= 0) throw this.#deadlineError();
		const id = randomUUID();
		return await new Promise<unknown>((resolve, reject) => {
			const pending: Pending = {
				incarnation,
				resolve,
				reject,
				timer: setTimeout(
					() =>
						this.#settlePending(
							id,
							pending,
							new SdkClientError("timeout", `SDK request timed out after ${timeoutMs}ms`),
						),
					timeoutMs,
				),
			};
			this.#pending.set(id, pending);
			if (!this.#isActive(incarnation) || incarnation.socket.readyState !== WebSocket.OPEN) {
				this.#settlePending(id, pending, new SdkClientError("unavailable", "SDK WebSocket is not connected"));
				return;
			}
			try {
				incarnation.socket.send(
					JSON.stringify({
						...frame,
						id,
						...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
					}),
				);
			} catch (error) {
				this.#settlePending(
					id,
					pending,
					error instanceof SdkClientError
						? error
						: new SdkClientError("unavailable", "SDK WebSocket send failed", error),
				);
			}
		});
	}

	#deadlineError(): SdkClientError {
		return new SdkClientError("timeout", "SDK client deadline elapsed.");
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
			this.#retire(current, new SdkClientError("connection_closed", "SDK WebSocket connection closed"), true);
		let cycle = this.#opening;
		if (!cycle) {
			cycle = { generation: ++this.#cycleGeneration, phase: "opening", candidate: null };
			this.#opening = cycle;
			cycle.promise = this.#openWithRetry(cycle);
		}
		return await cycle.promise!;
	}

	async #openWithRetry(cycle: Cycle): Promise<Incarnation> {
		let lastError: unknown;
		for (let attempt = 0; attempt <= this.#reconnectAttempts; attempt++) {
			if (this.#deadline !== undefined && Date.now() >= this.#deadline) {
				const error = this.#deadlineError();
				this.#completeCycle(cycle, error);
				throw error;
			}
			if (!this.#isOpening(cycle)) throw new SdkClientError("connection_closed", "SDK client closed");
			try {
				const incarnation = await this.#open(cycle);
				if (!this.#isActive(incarnation) && (!this.#isOpening(cycle) || cycle.candidate !== incarnation))
					throw new SdkClientError("connection_closed", "SDK WebSocket is not connected");
				await this.#waitForHello(incarnation);
				if (this.#isActive(incarnation)) return incarnation;
				throw new SdkClientError("connection_closed", "SDK WebSocket is not connected");
			} catch (error) {
				lastError = error;
				if (!this.#isOpening(cycle)) throw error;
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
					const backoffMs = this.#remainingTimeout(this.#reconnectBackoffMs * 2 ** attempt);
					if (backoffMs <= 0) break;
					cycle.phase = "backoff";
					await new Promise<void>((resolve, reject) => {
						cycle.rejectBackoff = reject;
						cycle.backoffTimer = setTimeout(resolve, backoffMs);
					});
					cycle.rejectBackoff = undefined;
					cycle.backoffTimer = undefined;
					if (!this.#isOpening(cycle)) throw new SdkClientError("connection_closed", "SDK client closed");
					cycle.phase = "opening";
				}
			}
		}
		if (!this.#isOpening(cycle)) throw new SdkClientError("connection_closed", "SDK client closed");
		if (this.#deadline !== undefined && Date.now() >= this.#deadline) {
			const error = this.#deadlineError();
			this.#completeCycle(cycle, error);
			throw error;
		}
		cycle.phase = "complete";
		if (this.#opening === cycle) this.#opening = null;
		const error = new SdkClientError("reconnect_exhausted", "SDK WebSocket reconnect attempts exhausted", lastError);
		for (const handler of this.#reconnectFailedHandlers) handler(error);
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
		return new Promise((resolve, reject) => {
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
				resolveOpen: () => resolve(incarnation),
				rejectOpen: reject,
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
				}) as EventListener,
				true,
			);
			add("error", ((event: Event) => this.#onSocketFailure(incarnation, event)) as EventListener);
			add("close", (() => this.#onSocketFailure(incarnation)) as EventListener);
			add("message", ((event: MessageEvent) => this.#onMessage(event.data, incarnation)) as EventListener);
			incarnation.openTimer = setTimeout(() => this.#onOpenTimeout(incarnation, timeoutMs), timeoutMs);
			incarnation.openTimer.unref?.();
		});
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
		return new Promise((resolve, reject) => {
			incarnation.resolveHello = resolve;
			incarnation.rejectHello = reject;
		});
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
			if (incarnation.phase === "hello" && this.#isCandidate(incarnation.cycle, incarnation)) {
				this.#acceptHello(incarnation, frame);
				if (this.#isActive(incarnation)) for (const handler of this.#frameHandlers) handler(frame);
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
			for (const handler of this.#reconnectHandlers) handler();
		}
		if (!this.#isActive(incarnation)) return;
		for (const handler of this.#frameHandlers) handler(frame);
		const id =
			typeof frame.id === "string" ? frame.id : typeof frame.requestId === "string" ? frame.requestId : undefined;
		if (!id) return;
		const pending = this.#pending.get(id);
		if (!pending || pending.incarnation !== incarnation) return;
		this.#settlePending(id, pending, frame.ok === false || frame.status === "error" ? errorFrom(frame) : frame);
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
		if (reconnecting) for (const handler of this.#reconnectHandlers) handler();
	}

	#settlePending(id: string, pending: Pending, result: unknown): void {
		if (this.#pending.get(id) !== pending) return;
		this.#pending.delete(id);
		clearTimeout(pending.timer);
		if (result instanceof Error) pending.reject(result);
		else pending.resolve(result);
	}
	#rejectPendingFor(incarnation: Incarnation, error: SdkClientError): void {
		for (const [id, pending] of this.#pending)
			if (pending.incarnation === incarnation) this.#settlePending(id, pending, error);
	}
	#retire(incarnation: Incarnation, error: SdkClientError, closeSocket: boolean): void {
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
		this.#rejectPendingFor(incarnation, error);
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
