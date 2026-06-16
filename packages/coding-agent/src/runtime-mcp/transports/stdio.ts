/**
 * MCP stdio transport.
 *
 * Implements JSON-RPC 2.0 over subprocess stdin/stdout.
 * Messages are newline-delimited JSON.
 */

import { getProjectDir, readJsonl, Snowflake } from "@gajae-code/utils";
import { type OwnedProcess, spawnOwnedProcess } from "../../runtime/process-lifecycle";
import type {
	JsonRpcError,
	JsonRpcMessage,
	JsonRpcRequest,
	JsonRpcResponse,
	MCPRequestOptions,
	MCPStdioServerConfig,
	MCPTransport,
} from "../../runtime-mcp/types";
import { toJsonRpcError } from "../../runtime-mcp/types";

/**
 * Stdio transport for MCP servers.
 * Spawns a subprocess and communicates via stdin/stdout.
 */
const CLOSE_WAIT_MS = 1_000;

export class StdioTransport implements MCPTransport {
	#process: OwnedProcess | null = null;
	#pendingRequests = new Map<
		string | number,
		{
			resolve: (value: unknown) => void;
			reject: (error: Error) => void;
		}
	>();
	#connected = false;
	#readLoop: Promise<void> | null = null;
	#stderrLoop: Promise<void> | null = null;
	#closePromise: Promise<void> | null = null;

	onClose?: () => void;
	onError?: (error: Error) => void;
	onNotification?: (method: string, params: unknown) => void;
	onRequest?: (method: string, params: unknown) => Promise<unknown>;

	constructor(private config: MCPStdioServerConfig) {}

	get connected(): boolean {
		return this.#connected;
	}

	get closeBeforeReconnect(): true {
		return true;
	}

	/**
	 * Start the subprocess and begin reading.
	 */
	async connect(): Promise<void> {
		if (this.#closePromise) {
			throw new Error("Transport is closing");
		}
		if (this.#connected) return;

		const args = this.config.args ?? [];
		const env = {
			...Bun.env,
			...this.config.env,
		};

		this.#process = spawnOwnedProcess([this.config.command, ...args], {
			cwd: this.config.cwd ?? getProjectDir(),
			env,
			stdin: "pipe",
			gracefulMs: CLOSE_WAIT_MS,
			name: `mcp-stdio:${this.config.command}`,
		});

		this.#connected = true;

		// Start reading stdout
		this.#readLoop = this.#startReadLoop();

		// Log stderr for debugging
		this.#stderrLoop = this.#startStderrLoop();
	}

	async #startReadLoop(): Promise<void> {
		if (!this.#process?.child.stdout) return;
		try {
			for await (const line of readJsonl(this.#process.child.stdout)) {
				if (!this.#connected) break;
				try {
					this.#handleMessage(line as JsonRpcMessage);
				} catch {
					// Skip malformed lines
				}
			}
		} catch (error) {
			if (this.#connected) {
				this.onError?.(error instanceof Error ? error : new Error(String(error)));
			}
		} finally {
			this.#handleClose();
		}
	}

	async #startStderrLoop(): Promise<void> {
		if (!this.#process?.child.stderr) return;

		const reader = this.#process.child.stderr.getReader();
		const decoder = new TextDecoder();

		try {
			while (this.#connected) {
				const { done, value } = await reader.read();
				if (done) break;
				// Log stderr but don't treat as error - servers use it for logging
				const text = decoder.decode(value, { stream: true });
				if (text.trim()) {
					// Could expose via onStderr callback if needed
					// For now, silent - MCP spec says clients MAY capture/ignore
				}
			}
		} catch {
			// Ignore stderr read errors
		} finally {
			reader.releaseLock();
		}
	}

	#handleMessage(message: JsonRpcMessage | JsonRpcMessage[]): void {
		if (Array.isArray(message)) {
			for (const m of message) this.#handleMessage(m);
			return;
		}
		// Server-to-client request: has both method and id
		if ("method" in message && "id" in message && message.id != null) {
			void this.#handleServerRequest(message as JsonRpcRequest);
			return;
		}

		// Response to our request: has id
		if ("id" in message && message.id != null) {
			const response = message as JsonRpcResponse;
			const pending = this.#pendingRequests.get(response.id);
			if (pending) {
				this.#pendingRequests.delete(response.id);
				if (response.error) {
					pending.reject(new Error(`MCP error ${response.error.code}: ${response.error.message}`));
				} else {
					pending.resolve(response.result);
				}
			}
			return;
		}

		// Notification: has method but no id
		if ("method" in message) {
			const notification = message as { method: string; params?: unknown };
			this.onNotification?.(notification.method, notification.params);
		}
	}

	async #handleServerRequest(request: JsonRpcRequest): Promise<void> {
		try {
			if (!this.onRequest) {
				this.#sendResponse(request.id, undefined, { code: -32601, message: "Method not found" });
				return;
			}
			const result = await this.onRequest(request.method, request.params);
			this.#sendResponse(request.id, result);
		} catch (error) {
			try {
				this.#sendResponse(request.id, undefined, toJsonRpcError(error));
			} catch {
				// Best-effort — process may have exited
			}
		}
	}

	#getStdin(): Bun.FileSink | null {
		const stdin = this.#process?.child.stdin;
		return typeof stdin === "object" && stdin !== null ? stdin : null;
	}

	#sendResponse(id: string | number, result?: unknown, error?: JsonRpcError): void {
		const stdin = this.#getStdin();
		if (!this.#connected || !stdin) return;
		const response = error
			? { jsonrpc: "2.0" as const, id, error }
			: { jsonrpc: "2.0" as const, id, result: result ?? {} };
		stdin.write(`${JSON.stringify(response)}\n`);
		stdin.flush();
	}

	#handleClose(): void {
		void this.#closeInternal(true);
	}

	async request<T = unknown>(
		method: string,
		params?: Record<string, unknown>,
		options?: MCPRequestOptions,
	): Promise<T> {
		const stdin = this.#getStdin();
		if (!this.#connected || !stdin) {
			throw new Error("Transport not connected");
		}

		const id = Snowflake.next();
		const request = {
			jsonrpc: "2.0" as const,
			id,
			method,
			params: params ?? {},
		};

		const timeout = this.config.timeout ?? 30000;
		const signal = options?.signal;

		if (signal?.aborted) {
			const reason = signal.reason instanceof Error ? signal.reason : new Error("Aborted");
			return Promise.reject(reason);
		}

		const { promise, resolve, reject } = Promise.withResolvers<T>();
		let timer: NodeJS.Timeout | undefined;
		let settled = false;

		const cleanup = () => {
			if (settled) return;
			settled = true;
			if (timer) {
				clearTimeout(timer);
				timer = undefined;
			}
			if (signal) {
				signal.removeEventListener("abort", onAbort);
			}
			this.#pendingRequests.delete(id);
		};

		const onAbort = () => {
			cleanup();
			const reason = signal?.reason instanceof Error ? signal.reason : new Error("Aborted");
			reject(reason);
		};

		if (signal) {
			signal.addEventListener("abort", onAbort, { once: true });
		}

		this.#pendingRequests.set(id, {
			resolve: (value: unknown) => {
				cleanup();
				resolve(value as T);
			},
			reject: (error: Error) => {
				cleanup();
				reject(error);
			},
		});

		timer = setTimeout(() => {
			cleanup();
			reject(new Error(`Request timeout after ${timeout}ms`));
		}, timeout);

		const message = `${JSON.stringify(request)}\n`;
		try {
			// Bun's FileSink has write() method directly
			stdin.write(message);
			stdin.flush();
		} catch (error: unknown) {
			cleanup();
			reject(error instanceof Error ? error : new Error(String(error)));
		}

		return promise;
	}

	async notify(method: string, params?: Record<string, unknown>): Promise<void> {
		const stdin = this.#getStdin();
		if (!this.#connected || !stdin) {
			throw new Error("Transport not connected");
		}

		const notification = {
			jsonrpc: "2.0" as const,
			method,
			params: params ?? {},
		};

		const message = `${JSON.stringify(notification)}\n`;
		// Bun's FileSink has write() method directly
		stdin.write(message);
		stdin.flush();
	}

	async close(): Promise<void> {
		await this.#closeInternal(false);
	}

	#closeInternal(fromReadLoop: boolean): Promise<void> {
		if (this.#closePromise) return this.#closePromise;
		this.#closePromise = this.#finishClose(fromReadLoop).finally(() => {
			this.#closePromise = null;
		});
		return this.#closePromise;
	}

	async #finishClose(fromReadLoop: boolean): Promise<void> {
		const wasConnected = this.#connected;
		this.#connected = false;

		for (const [, pending] of this.#pendingRequests) {
			pending.reject(new Error("Transport closed"));
		}
		this.#pendingRequests.clear();

		const stdin = this.#getStdin();
		const process = this.#process;
		this.#process = null;
		if (process) {
			stdin?.end();
			await process.dispose().catch(() => {});
			await process.awaitExit({ timeoutMs: CLOSE_WAIT_MS }).catch(() => ({ exited: false, code: null }));
		}

		if (!fromReadLoop && this.#readLoop) {
			await this.#readLoop.catch(() => {});
		}
		this.#readLoop = null;

		if (this.#stderrLoop) {
			await this.#stderrLoop.catch(() => {});
			this.#stderrLoop = null;
		}

		if (wasConnected) this.onClose?.();
	}
}

/**
 * Create and connect a stdio transport.
 */
export async function createStdioTransport(config: MCPStdioServerConfig): Promise<StdioTransport> {
	const transport = new StdioTransport(config);
	await transport.connect();
	return transport;
}
