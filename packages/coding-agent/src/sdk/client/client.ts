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
type Pending = {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
};

function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
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

/** A transport-only v3 SDK WebSocket client. It never imports or dispatches AgentSession. */
export class SdkClient {
	readonly #url: string;
	readonly #token: string;
	readonly #timeoutMs: number;
	readonly #reconnectAttempts: number;
	readonly #reconnectBackoffMs: number;
	readonly #deadline?: number;

	#socket: WebSocket | null = null;
	#opening: Promise<WebSocket> | null = null;
	#pending = new Map<string, Pending>();
	#frameHandlers = new Set<SdkFrameHandler>();
	#reconnectHandlers = new Set<SdkReconnectHandler>();
	#reconnectFailedHandlers = new Set<SdkReconnectFailedHandler>();

	#helloSocket: WebSocket | null = null;
	#helloPromise: Promise<void> | null = null;
	#helloReceived = new WeakSet<WebSocket>();
	#resolveHello?: () => void;
	#rejectHello?: (error: Error) => void;
	#helloTimer?: ReturnType<typeof setTimeout>;

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

		const socket = this.#socket;
		if (!socket || socket.readyState !== WebSocket.OPEN)
			throw new SdkClientError("connection_closed", "SDK WebSocket is not connected");
		try {
			socket.send(JSON.stringify(frame));
		} catch (error) {
			throw new SdkClientError("unavailable", "SDK WebSocket send failed", error);
		}
	}

	request(frame: SdkFrame, timeout?: number | { timeoutMs?: number; idempotencyKey?: string }): Promise<SdkFrame> {
		const options = typeof timeout === "number" ? { timeoutMs: timeout } : (timeout ?? {});
		return this.#request(frame, options) as Promise<SdkFrame>;
	}

	async close(): Promise<void> {
		this.#closed = true;
		this.#socket?.close();
		this.#socket = null;
		this.#rejectHello?.(new SdkClientError("connection_closed", "SDK client closed"));
		this.#clearHello();
		for (const pending of this.#pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(new SdkClientError("connection_closed", "SDK client closed"));
		}
		this.#pending.clear();
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
		await this.#connect();
		const timeoutMs = this.#remainingTimeout(options.timeoutMs ?? this.#timeoutMs);
		if (timeoutMs <= 0) throw this.#deadlineError();
		const id = randomUUID();
		return await new Promise<unknown>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.#pending.delete(id);
				reject(new SdkClientError("timeout", `SDK request timed out after ${timeoutMs}ms`));
			}, timeoutMs);
			this.#pending.set(id, { resolve, reject, timer });
			try {
				this.send({ ...frame, id, ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}) });
			} catch (error) {
				clearTimeout(timer);
				this.#pending.delete(id);
				reject(
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

	async #connect(): Promise<WebSocket> {
		this.#throwIfDeadlineElapsed();
		if (this.#socket?.readyState === WebSocket.OPEN) {
			await this.#waitForHello(this.#socket);
			return this.#socket;
		}
		if (this.#opening) return await this.#opening;
		this.#opening = this.#openWithRetry();
		try {
			return await this.#opening;
		} finally {
			this.#opening = null;
		}
	}

	async #openWithRetry(): Promise<WebSocket> {
		let lastError: unknown;
		for (let attempt = 0; attempt <= this.#reconnectAttempts; attempt++) {
			this.#throwIfDeadlineElapsed();
			let socket: WebSocket | undefined;
			try {
				socket = await this.#open();
				await this.#waitForHello(socket);
				return socket;
			} catch (error) {
				lastError = error;
				socket?.close();
				if (attempt < this.#reconnectAttempts) {
					const backoffMs = this.#remainingTimeout(this.#reconnectBackoffMs * 2 ** attempt);
					if (backoffMs <= 0) break;
					await sleep(backoffMs);
				}
			}
		}
		if (this.#deadline !== undefined && Date.now() >= this.#deadline) throw this.#deadlineError();
		const error = new SdkClientError("reconnect_exhausted", "SDK WebSocket reconnect attempts exhausted", lastError);
		for (const handler of this.#reconnectFailedHandlers) handler(error);
		throw error;
	}

	#open(): Promise<WebSocket> {
		const timeoutMs = this.#remainingTimeout();
		if (timeoutMs <= 0) return Promise.reject(this.#deadlineError());
		return new Promise((resolve, reject) => {
			const url = new URL(this.#url);
			url.searchParams.set("token", this.#token);
			const socket = new WebSocket(url);
			let timer: NodeJS.Timeout | undefined;
			const onOpen = () => {
				cleanup();
				if (this.#closed) {
					try {
						socket.close();
					} catch {}
					reject(new SdkClientError("connection_closed", "SDK client closed"));
					return;
				}
				this.#socket = socket;
				this.#beginHello(socket);
				resolve(socket);
			};
			const onError = (event: Event) => {
				cleanup();
				const eventWithDetail = event as Event & { error?: unknown; message?: unknown };
				const detail = eventWithDetail.error;
				reject(
					detail instanceof Error
						? detail
						: new Error(
								typeof eventWithDetail.message === "string"
									? eventWithDetail.message
									: "SDK WebSocket connection failed",
							),
				);
			};
			const cleanup = () => {
				socket.removeEventListener("open", onOpen);
				socket.removeEventListener("error", onError);
				if (timer !== undefined) {
					clearTimeout(timer);
					timer = undefined;
				}
			};
			socket.addEventListener("open", onOpen, { once: true });
			socket.addEventListener("error", onError, { once: true });
			socket.addEventListener("message", event => this.#onMessage(event.data, socket));
			socket.addEventListener("close", () => {
				if (this.#socket !== socket) return;
				this.#socket = null;
				if (this.#helloSocket === socket) {
					this.#rejectHello?.(
						new SdkClientError("connection_closed", "SDK WebSocket closed before server hello."),
					);
					this.#clearHello();
				}
				this.#rejectPending(new SdkClientError("connection_closed", "SDK WebSocket connection closed"));
			});
			timer = setTimeout(() => {
				cleanup();
				try {
					socket.close();
				} catch {}
				reject(new SdkClientError("timeout", `SDK WebSocket connection timed out after ${timeoutMs}ms`));
			}, timeoutMs);
			timer.unref?.();
		});
	}

	#rejectPending(error: SdkClientError): void {
		for (const pending of this.#pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.#pending.clear();
	}

	#beginHello(socket: WebSocket): void {
		this.#helloSocket = socket;
		const timeoutMs = this.#remainingTimeout();
		this.#helloPromise = new Promise<void>((resolve, reject) => {
			this.#resolveHello = resolve;
			this.#rejectHello = reject;
			if (timeoutMs <= 0) {
				reject(this.#deadlineError());
				return;
			}
			// A server that never sends its hello must fail typed instead of
			// hanging the caller until the request timeout.
			const timer = setTimeout(() => {
				if (this.#helloSocket !== socket) return;
				this.#rejectHello?.(
					this.#deadline !== undefined && Date.now() >= this.#deadline
						? this.#deadlineError()
						: new SdkClientError("protocol_error", "SDK server did not send a hello frame."),
				);
				this.#clearHello();
			}, timeoutMs);
			this.#helloTimer = timer;
			timer.unref?.();
		});
	}

	async #waitForHello(socket: WebSocket): Promise<void> {
		this.#throwIfDeadlineElapsed();
		if (this.#helloReceived.has(socket)) return;
		if (this.#helloSocket === socket && this.#helloPromise) {
			await this.#helloPromise;
			return;
		}
		throw new SdkClientError("connection_closed", "SDK WebSocket is not connected");
	}

	#clearHello(): void {
		if (this.#helloTimer !== undefined) {
			clearTimeout(this.#helloTimer);
			this.#helloTimer = undefined;
		}
		this.#helloSocket = null;
		this.#helloPromise = null;
		this.#resolveHello = undefined;
		this.#rejectHello = undefined;
	}

	#onMessage(value: unknown, socket: WebSocket): void {
		if (this.#socket !== socket) return;
		let frame: Frame;
		try {
			frame = parseFrame(value);
			if (frame.type === "control_command_result" && typeof frame.message === "string")
				frame = parseFrame(frame.message);
		} catch (error) {
			this.#rejectPending(
				error instanceof SdkClientError
					? error
					: new SdkClientError("protocol_error", "SDK server sent a malformed frame.", error),
			);
			return;
		}
		if (frame.type === "hello" || frame.type === "server_hello" || frame.type === "broker_hello") {
			// Per-session hosts advertise connectionId; the broker's hello carries
			// only protocolVersion. Both mark the connection as ready.
			if (typeof frame.connectionId === "string") {
				const reconnecting = this.connectionId !== undefined && this.connectionId !== frame.connectionId;
				this.connectionId = frame.connectionId;
				if (reconnecting) for (const handler of this.#reconnectHandlers) handler();
			}
			this.#helloReceived.add(socket);
			if (this.#helloSocket === socket) {
				this.#resolveHello?.();
				this.#clearHello();
			}
		}
		for (const handler of this.#frameHandlers) handler(frame);
		const id =
			typeof frame.id === "string" ? frame.id : typeof frame.requestId === "string" ? frame.requestId : undefined;
		if (!id) return;
		const pending = this.#pending.get(id);
		if (!pending) return;
		this.#pending.delete(id);
		clearTimeout(pending.timer);
		if (frame.ok === false || frame.status === "error") pending.reject(errorFrom(frame));
		else pending.resolve(frame);
	}
}
