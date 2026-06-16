/**
 * MCP HTTP transport (Streamable HTTP).
 *
 * Implements JSON-RPC 2.0 over HTTP POST with optional SSE streaming.
 * Based on MCP spec 2025-03-26.
 */
import { logger, readSseJson, Snowflake } from "@gajae-code/utils";
import type {
	JsonRpcError,
	JsonRpcMessage,
	JsonRpcRequest,
	JsonRpcResponse,
	MCPHttpServerConfig,
	MCPRequestOptions,
	MCPSseServerConfig,
	MCPTransport,
} from "../../runtime-mcp/types";
import { toJsonRpcError } from "../../runtime-mcp/types";

/**
 * HTTP transport for MCP servers.
 * Uses POST for requests, supports SSE responses.
 */
export class HttpTransport implements MCPTransport {
	#connected = false;
	#sessionId: string | null = null;
	#sseConnection: AbortController | null = null;
	#streamControllers = new Set<AbortController>();
	#streamReaders = new Set<Promise<void>>();

	onClose?: () => void;
	onError?: (error: Error) => void;
	onNotification?: (method: string, params: unknown) => void;
	onRequest?: (method: string, params: unknown) => Promise<unknown>;
	/** Called on 401/403 to attempt token refresh. Returns updated headers or null. */
	onAuthError?: () => Promise<Record<string, string> | null>;

	constructor(private config: MCPHttpServerConfig | MCPSseServerConfig) {}

	get connected(): boolean {
		return this.#connected;
	}

	get url(): string {
		return this.config.url;
	}

	/**
	 * Mark transport as connected.
	 * HTTP doesn't need persistent connection, but we track state.
	 */
	async connect(): Promise<void> {
		if (this.#connected) return;
		this.#connected = true;
	}

	#trackReader(promise: Promise<void>, controller?: AbortController): void {
		if (controller) this.#streamControllers.add(controller);
		this.#streamReaders.add(promise);
		void promise.finally(() => {
			this.#streamReaders.delete(promise);
			if (controller) this.#streamControllers.delete(controller);
		});
	}

	/**
	 * Start SSE listener for server-initiated messages.
	 * Resolves once the SSE connection is established (or fails/unsupported).
	 * Message reading continues in the background.
	 */
	async startSSEListener(): Promise<void> {
		if (!this.#connected) return;
		if (this.#sseConnection) return;

		const sseConnection = new AbortController();
		this.#sseConnection = sseConnection;
		const headers: Record<string, string> = {
			Accept: "text/event-stream",
			...this.config.headers,
		};

		if (this.#sessionId) {
			headers["Mcp-Session-Id"] = this.#sessionId;
		}

		let response: Response;
		try {
			response = await fetch(this.config.url, {
				method: "GET",
				headers,
				signal: sseConnection.signal,
			});
		} catch (error) {
			this.#sseConnection = this.#sseConnection === sseConnection ? null : this.#sseConnection;
			if (error instanceof Error && error.name !== "AbortError") {
				this.onError?.(error);
			}
			return;
		}

		if (response.status === 405 || !response.ok || !response.body) {
			await response.body?.cancel().catch(() => {});
			this.#sseConnection = this.#sseConnection === sseConnection ? null : this.#sseConnection;
			return;
		}

		// Connection established — read messages in background.
		// If the stream ends unexpectedly (server restart, network drop),
		// fire onClose so the manager can trigger reconnection.
		const signal = sseConnection.signal;
		const reader = this.#readSSEStream(response.body!, signal).finally(() => {
			const wasConnected = this.#connected;
			if (this.#sseConnection === sseConnection) this.#sseConnection = null;
			if (wasConnected && !signal.aborted) this.onClose?.();
		});
		this.#trackReader(reader, sseConnection);
	}
	async #readSSEStream(body: ReadableStream<Uint8Array>, signal: AbortSignal): Promise<void> {
		try {
			for await (const message of readSseJson<JsonRpcMessage>(body, signal)) {
				if (!this.#connected) break;
				this.#dispatchSSEMessage(message);
			}
		} catch (error) {
			if (error instanceof Error && error.name !== "AbortError") {
				logger.debug("HTTP SSE stream error", { url: this.config.url, error: error.message });
				this.onError?.(error);
			}
		}
	}

	/** Route an SSE message (or batch) to the appropriate handler. */
	#dispatchSSEMessage(message: JsonRpcMessage | JsonRpcMessage[]): void {
		if (Array.isArray(message)) {
			for (const m of message) this.#dispatchSSEMessage(m);
			return;
		}
		// Server-to-client request: has both method and id
		if ("method" in message && "id" in message && message.id != null) {
			void this.#handleServerRequest(message as JsonRpcRequest);
			return;
		}
		// Notification: has method but no id
		if ("method" in message && !("id" in message)) {
			this.onNotification?.(message.method, message.params);
		}
	}

	async request<T = unknown>(
		method: string,
		params?: Record<string, unknown>,
		options?: MCPRequestOptions,
	): Promise<T> {
		try {
			return await this.#executeRequest<T>(method, params, options);
		} catch (error) {
			// Retry once on auth failure if onAuthError is wired
			if (this.onAuthError && error instanceof Error && /^HTTP (401|403):/.test(error.message)) {
				const newHeaders = await this.onAuthError();
				if (newHeaders) {
					// Persist refreshed headers so subsequent requests use them directly
					this.config = { ...this.config, headers: newHeaders };
					return this.#executeRequest<T>(method, params, options);
				}
			}
			throw error;
		}
	}

	async #executeRequest<T>(
		method: string,
		params: Record<string, unknown> | undefined,
		options: MCPRequestOptions | undefined,
	): Promise<T> {
		if (!this.#connected) {
			throw new Error("Transport not connected");
		}

		const id = Snowflake.next();
		const body = {
			jsonrpc: "2.0" as const,
			id,
			method,
			params: params ?? {},
		};

		const headers: Record<string, string> = {
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
			...this.config.headers,
		};

		if (this.#sessionId) {
			headers["Mcp-Session-Id"] = this.#sessionId;
		}

		// Create AbortController for timeout
		const timeout = this.config.timeout ?? 30000;
		const abortController = new AbortController();
		const timeoutId = setTimeout(() => abortController.abort(), timeout);
		const operationSignal = options?.signal
			? AbortSignal.any([options.signal, abortController.signal])
			: abortController.signal;

		try {
			const response = await fetch(this.config.url, {
				method: "POST",
				headers,
				body: JSON.stringify(body),
				signal: operationSignal,
			});

			// Check for session ID in response
			const newSessionId = response.headers.get("Mcp-Session-Id");
			if (newSessionId) {
				this.#sessionId = newSessionId;
			}

			if (!response.ok) {
				const text = await response.text();
				const wwwAuthenticate = response.headers.get("WWW-Authenticate");
				const mcpAuthServer = response.headers.get("Mcp-Auth-Server");
				const authHints = [
					wwwAuthenticate ? `WWW-Authenticate: ${wwwAuthenticate}` : null,
					mcpAuthServer ? `Mcp-Auth-Server: ${mcpAuthServer}` : null,
				]
					.filter(Boolean)
					.join("; ");
				const suffix = authHints ? ` [${authHints}]` : "";
				throw new Error(`HTTP ${response.status}: ${text}${suffix}`);
			}

			const contentType = response.headers.get("Content-Type") ?? "";

			// Handle SSE response
			if (contentType.includes("text/event-stream")) {
				return this.#parseSSEResponse<T>(response, id, options);
			}

			// Handle JSON response
			const result = (await response.json()) as JsonRpcResponse;

			if (result.error) {
				throw new Error(`MCP error ${result.error.code}: ${result.error.message}`);
			}

			return result.result as T;
		} catch (error) {
			if (error instanceof Error && error.name === "AbortError") {
				if (options?.signal?.aborted) {
					throw error;
				}
				throw new Error(`Request timeout after ${timeout}ms`);
			}
			throw error;
		} finally {
			clearTimeout(timeoutId);
		}
	}

	#parseSSEResponse<T>(response: Response, expectedId: string | number, options?: MCPRequestOptions): Promise<T> {
		if (!response.body) {
			throw new Error("No response body");
		}

		const timeout = this.config.timeout ?? 30000;
		const abortController = new AbortController();
		const timeoutId = setTimeout(() => abortController.abort(), timeout);
		const operationSignal = options?.signal
			? AbortSignal.any([options.signal, abortController.signal])
			: abortController.signal;

		const { promise, resolve, reject } = Promise.withResolvers<T>();
		let captured = false;

		// Drain this per-request SSE response from a single iterator. Once the
		// matching response arrives, resolve/reject and abort the reader so the
		// response body is cancelled instead of lingering in the background.
		// Re-reading `response.body` would lock the stream a second time and surface
		// as "ReadableStream already has a controller", so the iterator owns the
		// stream until it is aborted, completes, or errors.
		const drainController = abortController;
		this.#streamControllers.add(drainController);
		const drain = async (): Promise<void> => {
			try {
				for await (const raw of readSseJson<JsonRpcMessage | JsonRpcMessage[]>(response.body!, operationSignal)) {
					const messages = Array.isArray(raw) ? raw : [raw];
					for (const message of messages) {
						if (
							!captured &&
							"id" in message &&
							message.id === expectedId &&
							("result" in message || "error" in message)
						) {
							captured = true;
							drainController.abort();
							if (message.error) {
								reject(new Error(`MCP error ${message.error.code}: ${message.error.message}`));
							} else {
								resolve(message.result as T);
							}
							return;
						}
						if (!this.#connected) continue;
						this.#dispatchSSEMessage(message);
					}
				}
				if (!captured) {
					reject(new Error(`No response received for request ID ${expectedId}`));
				}
			} catch (error) {
				if (captured) return;
				if (error instanceof Error && error.name === "AbortError") {
					if (options?.signal?.aborted) {
						reject(error);
					} else {
						reject(new Error(`SSE response timeout after ${timeout}ms`));
					}
				} else {
					reject(error as Error);
				}
			} finally {
				clearTimeout(timeoutId);
				this.#streamControllers.delete(drainController);
				await response.body?.cancel().catch(() => {});
			}
		};

		this.#trackReader(drain());
		return promise;
	}

	async #handleServerRequest(request: JsonRpcRequest): Promise<void> {
		if (!this.onRequest) {
			await this.#sendServerResponse(request.id, undefined, { code: -32601, message: "Method not found" });
			return;
		}
		try {
			const result = await this.onRequest(request.method, request.params);
			await this.#sendServerResponse(request.id, result);
		} catch (error) {
			await this.#sendServerResponse(request.id, undefined, toJsonRpcError(error));
		}
	}

	/** POST a JSON-RPC response back to the server (for server-to-client requests received via SSE). */
	async #sendServerResponse(id: string | number, result?: unknown, error?: JsonRpcError): Promise<void> {
		if (!this.#connected) return;
		const body = error
			? { jsonrpc: "2.0" as const, id, error }
			: { jsonrpc: "2.0" as const, id, result: result ?? {} };
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
			...this.config.headers,
		};
		if (this.#sessionId) {
			headers["Mcp-Session-Id"] = this.#sessionId;
		}
		try {
			const resp = await fetch(this.config.url, {
				method: "POST",
				headers,
				body: JSON.stringify(body),
				signal: AbortSignal.timeout(this.config.timeout ?? 30000),
			});
			// Retry once on auth failure if onAuthError is wired
			if (this.onAuthError && (resp.status === 401 || resp.status === 403)) {
				await resp.body?.cancel();
				const newHeaders = await this.onAuthError();
				if (newHeaders) {
					this.config.headers ??= {};
					Object.assign(this.config.headers, newHeaders);
					Object.assign(headers, newHeaders);
					const retry = await fetch(this.config.url, {
						method: "POST",
						headers,
						body: JSON.stringify(body),
						signal: AbortSignal.timeout(this.config.timeout ?? 30000),
					});
					await retry.body?.cancel();
					return;
				}
			}
			await resp.body?.cancel();
		} catch {
			// Best-effort response delivery — server may have disconnected
		}
	}

	async notify(method: string, params?: Record<string, unknown>): Promise<void> {
		if (!this.#connected) {
			throw new Error("Transport not connected");
		}

		const body = {
			jsonrpc: "2.0" as const,
			method,
			params: params ?? {},
		};

		const headers: Record<string, string> = {
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
			...this.config.headers,
		};

		if (this.#sessionId) {
			headers["Mcp-Session-Id"] = this.#sessionId;
		}

		// Create AbortController for timeout
		const timeout = this.config.timeout ?? 30000;
		const abortController = new AbortController();
		const timeoutId = setTimeout(() => abortController.abort(), timeout);

		try {
			const response = await fetch(this.config.url, {
				method: "POST",
				headers,
				body: JSON.stringify(body),
				signal: abortController.signal,
			});

			clearTimeout(timeoutId);

			// 202 Accepted is success for notifications
			if (!response.ok && response.status !== 202) {
				const text = await response.text();
				throw new Error(`HTTP ${response.status}: ${text}`);
			}

			// The server may piggyback server-to-client requests or notifications
			// on the notification response (MCP Streamable HTTP spec). Read them.
			const contentType = response.headers.get("Content-Type") ?? "";
			if (contentType.includes("text/event-stream") && response.body) {
				const streamController = new AbortController();
				const streamTimeout = AbortSignal.timeout(this.config.timeout ?? 30000);
				const signals = this.#sseConnection
					? [this.#sseConnection.signal, streamController.signal, streamTimeout]
					: [streamController.signal, streamTimeout];
				const reader = this.#readSSEStream(response.body, AbortSignal.any(signals));
				this.#trackReader(reader, streamController);
			} else {
				await response.body?.cancel();
			}
		} catch (error) {
			clearTimeout(timeoutId);
			if (error instanceof Error && error.name === "AbortError") {
				throw new Error(`Notify timeout after ${timeout}ms`);
			}
			throw error;
		}
	}

	async close(): Promise<void> {
		const wasConnected = this.#connected;
		this.#connected = false;

		// Abort all SSE/background readers and wait for them to settle.
		for (const controller of this.#streamControllers) {
			controller.abort();
		}
		if (this.#sseConnection) {
			this.#sseConnection.abort();
			this.#sseConnection = null;
		}
		await Promise.allSettled(Array.from(this.#streamReaders));

		if (!wasConnected && !this.#sessionId) return;

		// Send session termination if we have a session
		if (this.#sessionId) {
			try {
				const timeout = this.config.timeout ?? 30000;
				const headers: Record<string, string> = {
					...this.config.headers,
					"Mcp-Session-Id": this.#sessionId,
				};

				await fetch(this.config.url, {
					method: "DELETE",
					headers,
					signal: AbortSignal.timeout(timeout),
				});
			} catch {
				// Ignore termination errors
			}
			this.#sessionId = null;
		}

		this.onClose?.();
		this.onClose = undefined;
	}
}

/**
 * Create and connect an HTTP transport.
 */
export async function createHttpTransport(config: MCPHttpServerConfig | MCPSseServerConfig): Promise<HttpTransport> {
	const transport = new HttpTransport(config);
	await transport.connect();
	return transport;
}
