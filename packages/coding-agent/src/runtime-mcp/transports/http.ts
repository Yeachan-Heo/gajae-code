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
import { isResourceOwnerDisposalActive, registerResourceOwner } from "../../runtime/process-lifecycle";
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

/**
 * Postmortem release of live HTTP/SSE MCP sessions.
 *
 * A stdio server dies with the agent because it is a `spawnOwnedProcess` child, but an
 * HTTP/SSE server is a separate, already-running process that only learns a client is gone
 * from the session-termination `DELETE`. A signal kill (`SIGINT`/`SIGTERM`/`SIGHUP`) or a
 * fatal exit bypasses session dispose, so without this sweep the server keeps the
 * `Mcp-Session-Id` and everything hanging off it for every agent run that ever died -
 * unbounded growth on the server side. Mirrors the LSP/Python/browser owners.
 */
const liveHttpTransports = new Set<HttpTransport>();
let httpTransportOwnerRelease: (() => void) | undefined;
/** Exit must not wait on a wedged endpoint; the per-request timeout is up to 30s. */
const POSTMORTEM_CLOSE_TIMEOUT_MS = 2_000;

function trackHttpTransport(transport: HttpTransport): void {
	liveHttpTransports.add(transport);
	httpTransportOwnerRelease ??= registerResourceOwner("mcp:http-transports", closeLiveHttpTransports);
}

function untrackHttpTransport(transport: HttpTransport): void {
	if (!liveHttpTransports.delete(transport) || liveHttpTransports.size > 0) return;
	// Nothing left to release: drop the registration so a long-lived host does not
	// retain dead transports through the owner map.
	httpTransportOwnerRelease?.();
	httpTransportOwnerRelease = undefined;
}

async function closeLiveHttpTransports(): Promise<void> {
	await Promise.all(
		[...liveHttpTransports].map(async transport => {
			try {
				await transport.releaseForPostmortem(AbortSignal.timeout(POSTMORTEM_CLOSE_TIMEOUT_MS));
			} catch (error) {
				logger.debug("MCP HTTP postmortem release failed", { error });
			}
		}),
	);
}

/** Live HTTP/SSE MCP transports awaiting postmortem release. Exposed for leak assertions/tests. */
export function liveHttpTransportCount(): number {
	return liveHttpTransports.size;
}

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
		if (isResourceOwnerDisposalActive()) {
			throw new Error("Cannot connect MCP HTTP transport during process resource disposal");
		}
		this.#connected = true;
		trackHttpTransport(this);
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

	/** Abort every SSE/background reader. Does not wait for them to settle. */
	#abortStreams(): void {
		for (const controller of this.#streamControllers) {
			controller.abort();
		}
		if (this.#sseConnection) {
			this.#sseConnection.abort();
			this.#sseConnection = null;
		}
	}

	/**
	 * Send session termination (legacy era only; the modern era has no protocol
	 * session to terminate). This DELETE is the only signal an already-running
	 * HTTP/SSE server gets that its session may be dropped.
	 */
	async #terminateSession(signal?: AbortSignal): Promise<void> {
		if (this.#era === "modern") return;
		const sessionId = this.#sessionId;
		if (!sessionId) return;
		// Claim the server session before awaiting the wire request. Graceful close
		// and postmortem disposal can overlap during shutdown; only the caller that
		// detached this id may emit its termination DELETE.
		this.#sessionId = null;
		try {
			const timeout = this.config.timeout ?? 30000;
			const headers: Record<string, string> = {
				...this.config.headers,
				"Mcp-Session-Id": sessionId,
			};

			const timeoutSignal = AbortSignal.timeout(timeout);
			await this.#fetch({
				method: "DELETE",
				headers,
				signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal,
			});
		} catch {
			// Ignore termination errors
		}
	}

	/**
	 * Terminate the server-side session on a signal or fatal exit, without the
	 * reader drain `close()` does: postmortem runs inside the signal handler,
	 * where an aborted SSE body read is never observed by JS, so awaiting the
	 * readers there never settles and the DELETE stays unreachable. `onClose` is
	 * deliberately not fired - the manager reacts to it by reconnecting, which
	 * would open a fresh server session on the way out.
	 */
	async releaseForPostmortem(signal: AbortSignal): Promise<void> {
		untrackHttpTransport(this);
		this.#connected = false;
		this.#abortStreams();
		await this.#terminateSession(signal);
	}

	async close(): Promise<void> {
		untrackHttpTransport(this);
		const wasConnected = this.#connected;
		this.#connected = false;

		// Abort all SSE/background readers and wait for them to settle.
		this.#abortStreams();
		await Promise.allSettled(Array.from(this.#streamReaders));

		if (!wasConnected && !this.#sessionId) return;

		await this.#terminateSession();

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
