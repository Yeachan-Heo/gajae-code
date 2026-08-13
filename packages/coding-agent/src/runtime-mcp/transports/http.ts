/**
 * MCP HTTP transport (Streamable HTTP).
 *
 * Implements JSON-RPC 2.0 over HTTP POST with optional SSE streaming.
 * Legacy era: session-oriented Streamable HTTP per MCP spec 2025-03-26
 * (`Mcp-Session-Id`, standalone GET SSE listener, DELETE termination).
 * Modern era (2026-07-28): stateless per-request `_meta` + mirrored headers,
 * no sessions, no standalone stream, no replay. See ../protocol.ts.
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
import { MCPExpectedFailure, MCPHttpRequestError, MCPJsonRpcError, toJsonRpcError } from "../../runtime-mcp/types";
import {
	cancelMCPStream,
	MCP_MAX_CONTENT_BYTES,
	MCP_MAX_ERROR_BYTES,
	MCP_MAX_SSE_BATCH_MESSAGES,
	MCP_MAX_SSE_REQUEST_MESSAGES,
	readMCPResponseText,
} from "../content-limits";
import { fetchPluginMcpRequest, isPluginMcpPublicNetworkBound } from "../plugin-network-boundary";
import { buildModernMcpHeaders, type MCPModernClientContext, type MCPProtocolEra, withModernMeta } from "../protocol";

/** Best-effort JSON parse of an error body for structured era classification. */
function tryParseJsonBody(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

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
	/**
	 * Negotiated protocol era. Legacy keeps the sessionful 2025-03-26 behavior;
	 * modern (2026-07-28) is stateless: no session id, no GET stream, no DELETE.
	 */
	#era: MCPProtocolEra = "legacy";
	#modernContext: MCPModernClientContext | null = null;

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
	get closeBeforeReconnect(): false {
		return false;
	}

	get url(): string {
		return this.config.url;
	}

	/** Negotiated protocol era (defaults to legacy until the client negotiates). */
	get era(): MCPProtocolEra {
		return this.#era;
	}

	/**
	 * Select the protocol era. Modern mode requires the per-request client
	 * context (protocol version, identity, capabilities) mirrored into `_meta`
	 * and HTTP headers on every request.
	 */
	setProtocolMode(era: MCPProtocolEra, modernContext?: MCPModernClientContext): void {
		if (era === "modern" && !modernContext) {
			throw new Error("modern MCP protocol mode requires a client context");
		}
		this.#era = era;
		this.#modernContext = era === "modern" ? (modernContext ?? null) : null;
		if (era === "modern") this.#sessionId = null;
	}

	/**
	 * Mark transport as connected.
	 * HTTP doesn't need persistent connection, but we track state.
	 */
	async connect(): Promise<void> {
		if (this.#connected) return;
		this.#connected = true;
	}

	#fetch(init: BunFetchRequestInit): Promise<Response> {
		return isPluginMcpPublicNetworkBound(this.config)
			? fetchPluginMcpRequest(this.config.url, init)
			: fetch(this.config.url, init);
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
		// The modern era removed the standalone GET stream; request-scoped SSE
		// responses and subscriptions/listen are the only streams.
		if (this.#era === "modern") return;
		if (this.#sseConnection) return;

		const sseConnection = new AbortController();
		const headerController = new AbortController();
		const headerTimeout = this.config.timeout ?? 30000;
		const headerTimeoutId = setTimeout(() => headerController.abort(), headerTimeout);
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
			response = await this.#fetch({
				method: "GET",
				headers,
				signal: AbortSignal.any([sseConnection.signal, headerController.signal]),
			});
		} catch (error) {
			this.#sseConnection = this.#sseConnection === sseConnection ? null : this.#sseConnection;
			if (headerController.signal.aborted && !sseConnection.signal.aborted) {
				this.onError?.(new Error(`SSE connection timeout after ${headerTimeout}ms`));
			} else if (error instanceof Error && error.name !== "AbortError") {
				this.onError?.(error);
			}
			return;
		} finally {
			clearTimeout(headerTimeoutId);
		}

		if (response.status === 405 || !response.ok || !response.body) {
			cancelMCPStream(response.body);
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
			for await (const message of readSseJson<JsonRpcMessage>(body, signal, undefined, {
				maxEventBytes: MCP_MAX_CONTENT_BYTES,
			})) {
				if (!this.#connected) break;
				if (Array.isArray(message) && message.length > MCP_MAX_SSE_BATCH_MESSAGES) {
					throw new Error("MCP SSE batch exceeds message limit");
				}
				this.#dispatchSSEMessage(message);
			}
		} catch (error) {
			if (error instanceof Error && error.name !== "AbortError") {
				logger.debug("HTTP SSE stream error");
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
			if (this.#era === "modern") {
				// 2026-07-28 forbids server-initiated JSON-RPC requests on SSE streams;
				// server-to-client interactions use MRTR input requests instead. Do not
				// fall back to the legacy elicitation-over-stream pattern.
				logger.debug("Dropping server-initiated request on modern-era stream");
				return;
			}
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
			// Retry once on auth failure only for explicitly replay-safe requests.
			if (
				this.onAuthError &&
				!options?.noReplay &&
				error instanceof Error &&
				/^HTTP (401|403):/.test(error.message)
			) {
				const newHeaders = await this.onAuthError();
				if (newHeaders) {
					this.config = { ...this.config, headers: newHeaders };
					try {
						return await this.#executeRequest<T>(method, params, options);
					} catch (retryError) {
						throw retryError instanceof MCPExpectedFailure ? retryError : new MCPExpectedFailure(retryError);
					}
				}
			}
			throw error instanceof MCPExpectedFailure ? error : new MCPExpectedFailure(error);
		}
	}

	async #executeRequest<T>(
		method: string,
		params: Record<string, unknown> | undefined,
		options: MCPRequestOptions | undefined,
	): Promise<T> {
		if (!this.#connected) {
			throw new MCPExpectedFailure();
		}

		const id = Snowflake.next();
		const body = {
			jsonrpc: "2.0" as const,
			id,
			method,
			params:
				this.#era === "modern" && this.#modernContext
					? withModernMeta(params ?? {}, this.#modernContext)
					: (params ?? {}),
		};

		const headers: Record<string, string> = {
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
			...this.config.headers,
		};

		if (this.#era === "modern" && this.#modernContext) {
			// 2026-07-28: mirrored request metadata headers are REQUIRED.
			Object.assign(
				headers,
				buildModernMcpHeaders({
					protocolVersion: this.#modernContext.protocolVersion,
					method,
					params: body.params,
				}),
			);
			if (options?.mcpParamHeaders) Object.assign(headers, options.mcpParamHeaders);
		} else if (this.#sessionId) {
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
			const response = await this.#fetch({
				method: "POST",
				headers,
				body: JSON.stringify(body),
				signal: operationSignal,
			});

			// Check for session ID in response (legacy era only; modern servers do not mint sessions)
			if (this.#era !== "modern") {
				const newSessionId = response.headers.get("Mcp-Session-Id");
				if (newSessionId) {
					this.#sessionId = newSessionId;
				}
			}

			if (!response.ok) {
				const text = await readMCPResponseText(response, MCP_MAX_ERROR_BYTES, true, operationSignal);
				const wwwAuthenticate = response.headers.get("WWW-Authenticate");
				const mcpAuthServer = response.headers.get("Mcp-Auth-Server");
				const authHints = [
					wwwAuthenticate ? `WWW-Authenticate: ${wwwAuthenticate}` : null,
					mcpAuthServer ? `Mcp-Auth-Server: ${mcpAuthServer}` : null,
				]
					.filter(Boolean)
					.join("; ");
				const suffix = authHints ? ` [${authHints}]` : "";
				throw new MCPHttpRequestError(
					response.status,
					`HTTP ${response.status}: ${text}${suffix}`,
					tryParseJsonBody(text),
				);
			}

			const contentType = response.headers.get("Content-Type") ?? "";

			// Handle SSE response
			if (contentType.includes("text/event-stream")) {
				return this.#parseSSEResponse<T>(response, id, options);
			}

			// Handle JSON response
			if (!response.body) {
				throw new MCPExpectedFailure();
			}
			const parsedResult = JSON.parse(
				await readMCPResponseText(response, MCP_MAX_CONTENT_BYTES, false, operationSignal),
			) as unknown;

			if (
				typeof parsedResult !== "object" ||
				parsedResult === null ||
				!("id" in parsedResult) ||
				parsedResult.id !== id ||
				(!("result" in parsedResult) && !("error" in parsedResult))
			) {
				throw new MCPExpectedFailure();
			}

			const result = parsedResult as JsonRpcResponse;
			if ("error" in result) {
				if (!result.error) {
					throw new MCPExpectedFailure();
				}
				throw new MCPExpectedFailure(
					new MCPJsonRpcError(result.error.code, result.error.message, result.error.data),
				);
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
			throw new MCPExpectedFailure();
		}

		const timeout = this.config.timeout ?? 30000;
		const abortController = new AbortController();
		const timeoutId = setTimeout(() => abortController.abort(), timeout);
		const operationSignal = options?.signal
			? AbortSignal.any([options.signal, abortController.signal])
			: abortController.signal;

		const { promise, resolve, reject } = Promise.withResolvers<T>();
		let captured = false;
		let messageCount = 0;

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
				for await (const raw of readSseJson<JsonRpcMessage | JsonRpcMessage[]>(
					response.body!,
					operationSignal,
					undefined,
					{
						maxEventBytes: MCP_MAX_CONTENT_BYTES,
						maxTotalBytes: MCP_MAX_CONTENT_BYTES,
					},
				)) {
					const messages = Array.isArray(raw) ? raw : [raw];
					if (messages.length > MCP_MAX_SSE_BATCH_MESSAGES) throw new Error("MCP SSE batch exceeds message limit");
					messageCount += messages.length;
					if (messageCount > MCP_MAX_SSE_REQUEST_MESSAGES)
						throw new Error("MCP SSE response exceeds message limit");
					for (const message of messages) {
						if (
							!captured &&
							"id" in message &&
							message.id === expectedId &&
							("result" in message || "error" in message)
						) {
							captured = true;
							drainController.abort();
							const response = message as JsonRpcResponse;
							if ("error" in response) {
								if (!response.error) {
									reject(new MCPExpectedFailure());
								} else {
									reject(
										new MCPExpectedFailure(
											new MCPJsonRpcError(response.error.code, response.error.message, response.error.data),
										),
									);
								}
							} else {
								resolve(response.result as T);
							}
							return;
						}
						if (!this.#connected) continue;
						this.#dispatchSSEMessage(message);
					}
				}
				if (!captured) {
					reject(new MCPExpectedFailure());
				}
			} catch (error) {
				if (captured) return;
				if (error instanceof Error && error.name === "AbortError") {
					if (options?.signal?.aborted) {
						reject(new MCPExpectedFailure(error));
					} else {
						reject(new MCPExpectedFailure(new Error(`SSE response timeout after ${timeout}ms`)));
					}
				} else {
					reject(error instanceof MCPExpectedFailure ? error : new MCPExpectedFailure(error));
				}
			} finally {
				clearTimeout(timeoutId);
				this.#streamControllers.delete(drainController);
				cancelMCPStream(response.body);
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
			const resp = await this.#fetch({
				method: "POST",
				headers,
				body: JSON.stringify(body),
				signal: AbortSignal.timeout(this.config.timeout ?? 30000),
			});
			// Retry once on auth failure if onAuthError is wired
			if (this.onAuthError && (resp.status === 401 || resp.status === 403)) {
				cancelMCPStream(resp.body);
				const newHeaders = await this.onAuthError();
				if (newHeaders) {
					this.config.headers ??= {};
					Object.assign(this.config.headers, newHeaders);
					Object.assign(headers, newHeaders);
					const retry = await this.#fetch({
						method: "POST",
						headers,
						body: JSON.stringify(body),
						signal: AbortSignal.timeout(this.config.timeout ?? 30000),
					});
					cancelMCPStream(retry.body);
					return;
				}
			}
			cancelMCPStream(resp.body);
		} catch {
			// Best-effort response delivery — server may have disconnected
		}
	}

	async notify(method: string, params?: Record<string, unknown>): Promise<void> {
		if (!this.#connected) {
			throw new MCPExpectedFailure();
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
			const response = await this.#fetch({
				method: "POST",
				headers,
				body: JSON.stringify(body),
				signal: abortController.signal,
			});

			// 202 Accepted is success for notifications
			if (!response.ok && response.status !== 202) {
				const text = await readMCPResponseText(response, MCP_MAX_ERROR_BYTES, true, abortController.signal);
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
				cancelMCPStream(response.body);
			}
		} catch (error) {
			if (error instanceof Error && error.name === "AbortError") {
				throw new MCPExpectedFailure(new Error(`Notify timeout after ${timeout}ms`));
			}
			throw error instanceof MCPExpectedFailure ? error : new MCPExpectedFailure(error);
		} finally {
			clearTimeout(timeoutId);
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

		// Send session termination if we have a session (legacy era only;
		// the modern era has no protocol session to terminate)
		if (this.#era !== "modern" && this.#sessionId) {
			try {
				const timeout = this.config.timeout ?? 30000;
				const headers: Record<string, string> = {
					...this.config.headers,
					"Mcp-Session-Id": this.#sessionId,
				};

				await this.#fetch({
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
