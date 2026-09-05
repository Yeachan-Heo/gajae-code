/**
 * MCP stdio transport.
 *
 * Implements JSON-RPC 2.0 over subprocess stdin/stdout.
 * Messages are newline-delimited JSON.
 */

import { readJsonl, Snowflake } from "@gajae-code/utils";
import { type OwnedProcess, spawnOwnedProcess } from "../../runtime/process-lifecycle";
import type {
	JsonRpcError,
	JsonRpcMessage,
	JsonRpcRequest,
	JsonRpcResponse,
	MCPRequestOptions,
	MCPStdioPreparedLaunch,
	MCPStdioServerConfig,
	MCPTransport,
} from "../../runtime-mcp/types";
import { MCPExpectedFailure, toJsonRpcError } from "../../runtime-mcp/types";

/**
 * Stdio transport for MCP servers.
 * Spawns a subprocess and communicates via stdin/stdout.
 */
const CLOSE_WAIT_MS = 1_000;

/**
 * Build a minimal environment for a no-inherit stdio MCP child. Only OS-level
 * keys needed to locate/run an interpreter (PATH, HOME, temp, locale, and the
 * Windows system essentials) are copied from the host; everything else
 * (API keys, tokens, secrets) is withheld. Explicit `env` overrides win.
 */
function buildMinimalStdioEnv(explicit?: Record<string, string>): Record<string, string> {
	const allow = [
		"PATH",
		"HOME",
		"TMPDIR",
		"TEMP",
		"TMP",
		"LANG",
		"LC_ALL",
		"LC_CTYPE",
		"SHELL",
		"USER",
		"SystemRoot",
		"SYSTEMROOT",
		"PATHEXT",
		"COMSPEC",
		"WINDIR",
	];
	const env: Record<string, string> = {};
	for (const key of allow) {
		const value = Bun.env[key];
		if (typeof value === "string") env[key] = value;
	}
	return { ...env, ...explicit };
}

function combinedOperationAndCleanupFailure(operationError: unknown, cleanupError: unknown): MCPExpectedFailure {
	return new MCPExpectedFailure(
		new AggregateError(
			[operationError, cleanupError],
			"MCP stdio operation failed and subprocess cleanup also failed",
		),
	);
}

type StdioConnectAttempt = {
	generation: number;
	revoked: boolean;
	settled: boolean;
	completion: Promise<void>;
};

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
	#connectGeneration = 0;
	#connectAttempt: StdioConnectAttempt | null = null;
	/** Retained until the per-attempt cleanup resolves successfully. */
	#afterProcessExit: (() => Promise<void>) | null = null;

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

	#registerCleanup(attempt: StdioConnectAttempt, cleanup: () => Promise<void>): void {
		if (this.#connectAttempt !== attempt) {
			throw new Error("MCP stdio attempt registered cleanup after its ownership ended");
		}
		if (this.#afterProcessExit && this.#afterProcessExit !== cleanup) {
			throw new Error("MCP stdio attempt registered conflicting cleanup owners");
		}
		this.#afterProcessExit = cleanup;
	}

	#assertConnectAttemptActive(attempt: StdioConnectAttempt): void {
		if (attempt.revoked || this.#connectAttempt !== attempt || this.#connectGeneration !== attempt.generation) {
			throw new Error("MCP stdio connection attempt was closed");
		}
	}

	#revokeConnectAttempt(): StdioConnectAttempt | null {
		const attempt = this.#connectAttempt;
		if (attempt && !attempt.revoked) {
			attempt.revoked = true;
			this.#connectGeneration++;
		}
		return attempt;
	}

	/**
	 * Start the subprocess and begin reading.
	 */
	async connect(): Promise<void> {
		if (this.#connected) return;
		if (this.#closePromise) {
			throw new MCPExpectedFailure(new Error("MCP stdio child teardown is incomplete"));
		}
		if (this.#connectAttempt) {
			if (!this.#connectAttempt.settled) return this.#connectAttempt.completion;
			if (this.#process || this.#afterProcessExit) {
				throw new MCPExpectedFailure(new Error("MCP stdio child teardown is incomplete"));
			}
			this.#connectAttempt = null;
		}
		if (this.#process || this.#afterProcessExit) {
			throw new MCPExpectedFailure(new Error("MCP stdio child teardown is incomplete"));
		}

		const { promise, resolve, reject } = Promise.withResolvers<void>();
		const attempt: StdioConnectAttempt = {
			generation: ++this.#connectGeneration,
			revoked: false,
			settled: false,
			completion: promise,
		};
		this.#connectAttempt = attempt;
		void this.#finishConnect(attempt).then(
			() => {
				attempt.settled = true;
				resolve();
			},
			error => {
				attempt.settled = true;
				reject(error);
			},
		);
		void promise.catch(() => {});
		return promise;
	}

	async #finishConnect(attempt: StdioConnectAttempt): Promise<void> {
		let launch: MCPStdioPreparedLaunch = {
			command: this.config.command,
			args: Object.freeze([...(this.config.args ?? [])]),
			cwd: this.config.cwd ?? process.cwd(),
			registerCleanup: cleanup => this.#registerCleanup(attempt, cleanup),
		};
		const env = this.config.noInheritEnv
			? buildMinimalStdioEnv(this.config.env)
			: {
					...Bun.env,
					...this.config.env,
				};
		try {
			this.#assertConnectAttemptActive(attempt);
			if (this.config.prepareSpawn) launch = await this.config.prepareSpawn(launch);
			if (launch.afterProcessExit) this.#registerCleanup(attempt, launch.afterProcessExit);
			else if (!this.#afterProcessExit && this.config.afterProcessExit) {
				this.#registerCleanup(attempt, this.config.afterProcessExit);
			}
			this.#assertConnectAttemptActive(attempt);
			await this.config.spawnGuard?.(launch);
			this.#assertConnectAttemptActive(attempt);
			await this.config.afterSpawnGuardForTest?.();
			this.#assertConnectAttemptActive(attempt);
			const process = spawnOwnedProcess([launch.command, ...launch.args], {
				cwd: launch.cwd,
				env,
				stdin: "pipe",
				gracefulMs: CLOSE_WAIT_MS,
				name: `mcp-stdio:${launch.command}`,
			});
			if (attempt.revoked) {
				const teardown = await process.dispose();
				await process.awaitExit({ timeoutMs: CLOSE_WAIT_MS }).catch(() => ({ exited: false, code: null }));
				if (teardown.status !== "terminated") {
					this.#process = process;
					throw new MCPExpectedFailure(new Error(`stdio child teardown ${teardown.status}`));
				}
				throw new Error("MCP stdio connection attempt was closed");
			}
			this.#process = process;
		} catch (error) {
			if (!this.#process) {
				try {
					await this.#runAfterProcessExit();
				} catch (cleanupError) {
					throw combinedOperationAndCleanupFailure(error, cleanupError);
				}
			}
			throw new MCPExpectedFailure(error);
		}

		this.#connected = true;

		// Start reading stdout
		this.#readLoop = this.#startReadLoop();

		// Log stderr for debugging
		this.#stderrLoop = this.#startStderrLoop();
	}

	async #startReadLoop(): Promise<void> {
		if (!this.#process?.child.stdout) return;
		let failure: MCPExpectedFailure | undefined;
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
			failure = new MCPExpectedFailure(error);
			if (this.#connected) {
				this.onError?.(failure);
			}
		} finally {
			this.#handleClose(failure);
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
				if (!("result" in response) && !("error" in response)) {
					pending.reject(new MCPExpectedFailure());
				} else if ("error" in response) {
					if (!response.error) {
						pending.reject(new MCPExpectedFailure());
					} else {
						pending.reject(
							new MCPExpectedFailure(new Error(`MCP error ${response.error.code}: ${response.error.message}`)),
						);
					}
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
		// FileSink.write()/flush() return `number | Promise<number>` (flush may
		// also return undefined): under backpressure a write returns a promise
		// whose rejection — e.g. EPIPE when the server dies mid-write — must
		// not escape as an unhandled rejection. Best-effort, like the caller.
		Promise.resolve(stdin.write(`${JSON.stringify(response)}\n`))
			.then(() => stdin.flush())
			.catch(() => {
				// Best-effort — process may have exited
			});
	}

	#handleClose(failure?: MCPExpectedFailure): void {
		void this.#closeInternal(true, failure).catch(error => {
			this.onError?.(error instanceof Error ? error : new Error(String(error)));
		});
	}

	async request<T = unknown>(
		method: string,
		params?: Record<string, unknown>,
		options?: MCPRequestOptions,
	): Promise<T> {
		const stdin = this.#getStdin();
		if (!this.#connected || !stdin) {
			throw new MCPExpectedFailure();
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
			return Promise.reject(new MCPExpectedFailure(reason));
		}

		const { promise, resolve, reject } = Promise.withResolvers<T>();
		void promise.catch(() => {});
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
			reject(new MCPExpectedFailure(reason));
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
			reject(new MCPExpectedFailure(new Error(`Request timeout after ${timeout}ms`)));
		}, timeout);

		const message = `${JSON.stringify(request)}\n`;
		void (async () => {
			try {
				// Bun's FileSink has write() method directly. Await both write and
				// flush: under backpressure write() returns a promise, and either
				// call can fail with EPIPE when the server dies mid-write.
				await stdin.write(message);
				await stdin.flush();
			} catch (error: unknown) {
				cleanup();
				reject(new MCPExpectedFailure(error));
			}
		})();

		return promise;
	}

	async notify(method: string, params?: Record<string, unknown>): Promise<void> {
		const stdin = this.#getStdin();
		if (!this.#connected || !stdin) {
			throw new MCPExpectedFailure();
		}

		const notification = {
			jsonrpc: "2.0" as const,
			method,
			params: params ?? {},
		};

		const message = `${JSON.stringify(notification)}\n`;
		try {
			// Bun's FileSink has write() method directly. Await both write and
			// flush: under backpressure write() returns a promise, and either
			// call can fail with EPIPE when the server dies mid-write.
			await stdin.write(message);
			await stdin.flush();
		} catch (error) {
			throw new MCPExpectedFailure(error);
		}
	}

	async #runAfterProcessExit(): Promise<void> {
		const cleanup = this.#afterProcessExit;
		if (!cleanup) return;
		await cleanup();
		if (this.#afterProcessExit === cleanup) this.#afterProcessExit = null;
	}

	async close(): Promise<void> {
		await this.#closeInternal(false);
	}

	#closeInternal(fromReadLoop: boolean, failure?: MCPExpectedFailure): Promise<void> {
		if (this.#closePromise) return this.#closePromise;
		const connectAttempt = this.#revokeConnectAttempt();
		this.#closePromise = this.#finishClose(fromReadLoop, failure, connectAttempt).finally(() => {
			if (this.#connectAttempt === connectAttempt) this.#connectAttempt = null;
			this.#closePromise = null;
		});
		return this.#closePromise;
	}

	async #finishClose(
		fromReadLoop: boolean,
		failure: MCPExpectedFailure | undefined,
		connectAttempt: StdioConnectAttempt | null,
	): Promise<void> {
		const wasConnected = this.#connected;
		this.#connected = false;

		for (const [, pending] of this.#pendingRequests) {
			pending.reject(failure ?? new MCPExpectedFailure());
		}
		this.#pendingRequests.clear();

		let primaryFailure: unknown = failure;
		if (connectAttempt) {
			try {
				await connectAttempt.completion;
			} catch (error) {
				if (primaryFailure === undefined && this.#process) primaryFailure = error;
			}
		}
		const stdin = this.#getStdin();
		const process = this.#process;
		if (process) {
			try {
				stdin?.end();
				const teardown = await process.dispose();
				await process.awaitExit({ timeoutMs: CLOSE_WAIT_MS }).catch(() => ({ exited: false, code: null }));
				if (teardown.status !== "terminated") {
					throw new MCPExpectedFailure(new Error(`stdio child teardown ${teardown.status}`));
				}
				this.#process = null;
			} catch (cleanupError) {
				if (primaryFailure) throw combinedOperationAndCleanupFailure(primaryFailure, cleanupError);
				throw cleanupError;
			}
		}

		try {
			await this.#runAfterProcessExit();
		} catch (cleanupError) {
			if (primaryFailure) throw combinedOperationAndCleanupFailure(primaryFailure, cleanupError);
			throw cleanupError;
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
