import * as path from "node:path";
import { isEnoent, isKnownSinkPeerClosedError, logger, untilAborted } from "@gajae-code/utils";
import { formatCrashDiagnosticNotice, writeCrashReport } from "../debug/crash-diagnostics";
import { registerResourceOwner, spawnOwnedProcess } from "../runtime/process-lifecycle";
import { ToolAbortError, throwIfAborted } from "../tools/tool-errors";
import { applyWorkspaceEdit } from "./edits";
import { getLspmuxCommand, isLspmuxSupported } from "./lspmux";
import type {
	LspClient,
	LspJsonRpcNotification,
	LspJsonRpcRequest,
	LspJsonRpcResponse,
	PublishDiagnosticsParams,
	ServerConfig,
	WorkspaceEdit,
} from "./types";
import { detectLanguageId, fileToUri } from "./utils";

// =============================================================================
// Client State
// =============================================================================

const clients = new Map<string, LspClient>();
const killedClients = new WeakSet<LspClient>();
const clientLocks = new Map<string, Promise<LspClient>>();
const fileOperationLocks = new Map<string, Promise<void>>();
const clientOperationIds = new WeakMap<LspClient, number>();
let nextClientOperationId = 1;
const initializingClients = new Set<LspClient>();
let shutdownGeneration = 0;
// Session lifetimes retain the workspace/profile scope they may use. A scoped
// release only tears down its clients after the last session releases that
// scope; process teardown continues to use shutdownAll() below.
const scopeReferences = new Map<string, number>();
const scopeShutdownGenerations = new Map<string, number>();
const transportClosedErrors = new WeakMap<LspClient, Error>();
const LSP_TRANSPORT_CLOSED_MESSAGE = "LSP transport closed";

function fileOperationLockKey(client: LspClient, uri: string): string {
	let id = clientOperationIds.get(client);
	if (id === undefined) {
		id = nextClientOperationId++;
		clientOperationIds.set(client, id);
	}
	return `${id}:${uri}`;
}

async function withFileOperationLock<T>(
	key: string,
	signal: AbortSignal | undefined,
	operation: () => Promise<T>,
): Promise<T> {
	const previous = fileOperationLocks.get(key);
	const current = (async () => {
		// The shared tail is failure-absorbing: a cancelled or failed operation
		// must not poison work queued behind it.
		if (previous) await previous.catch(() => undefined);
		return operation();
	})();
	const tail = current.then(
		() => undefined,
		() => undefined,
	);
	fileOperationLocks.set(key, tail);
	void tail.finally(() => {
		if (fileOperationLocks.get(key) === tail) fileOperationLocks.delete(key);
	});
	return untilAborted(signal, () => current);
}
let lspCleanupOwner: (() => void) | undefined;

function ensureLspCleanup(): void {
	if (lspCleanupOwner) return;
	lspCleanupOwner = registerResourceOwner("lsp:clients", shutdownAll);
}

function normalizedAgentDir(agentDir?: string): string {
	return agentDir ? path.resolve(agentDir) : "";
}

function lspScopeKey(cwd: string, agentDir?: string): string {
	return JSON.stringify([path.resolve(cwd), normalizedAgentDir(agentDir)]);
}

function scopeKeyFromClientKey(key: string): string | undefined {
	try {
		const value: unknown = JSON.parse(key);
		if (!Array.isArray(value) || typeof value[1] !== "string") return undefined;
		return lspScopeKey(value[1], typeof value[2] === "string" && value[2] ? value[2] : undefined);
	} catch {
		return undefined;
	}
}

function scopeGeneration(scopeKey: string): number {
	return scopeShutdownGenerations.get(scopeKey) ?? 0;
}

/** Retain a workspace/profile LSP scope for one live session. */
export function retainLspScope(cwd: string, agentDir?: string): void {
	const key = lspScopeKey(cwd, agentDir);
	scopeReferences.set(key, (scopeReferences.get(key) ?? 0) + 1);
}

// Idle timeout configuration (disabled by default). The unscoped value keeps
// the original one-argument API working for callers that do not have a
// workspace/profile scope. Config-loaded policies are keyed by the same
// workspace/profile identity used by the client cache.
let idleTimeoutMs: number | null = null;
const scopedIdleTimeouts = new Map<string, number | null>();
let idleCheckInterval: NodeJS.Timeout | null = null;
const IDLE_CHECK_INTERVAL_MS = 60 * 1000;

/**
 * Configure the idle timeout for LSP clients.
 * @param ms - Timeout in milliseconds, or null/undefined to disable
 * @param cwd - Optional workspace scope. When provided, the policy only
 * applies to clients for this workspace/profile.
 * @param agentDir - Optional profile directory for the workspace scope.
 */
export function setIdleTimeout(ms: number | null | undefined, cwd?: string, agentDir?: string): void {
	const timeoutMs = ms ?? null;
	if (cwd === undefined) {
		idleTimeoutMs = timeoutMs;
	} else {
		scopedIdleTimeouts.set(lspScopeKey(cwd, agentDir), timeoutMs);
	}

	if (hasIdleTimeoutPolicy()) {
		startIdleChecker();
	} else {
		stopIdleChecker();
	}
}

function hasIdleTimeoutPolicy(): boolean {
	if (idleTimeoutMs !== null && idleTimeoutMs > 0) return true;
	for (const timeoutMs of scopedIdleTimeouts.values()) {
		if (timeoutMs !== null && timeoutMs > 0) return true;
	}
	return false;
}

function getIdleTimeoutForClient(key: string): number | null {
	const scopeKey = scopeKeyFromClientKey(key);
	if (scopeKey !== undefined && scopedIdleTimeouts.has(scopeKey)) {
		return scopedIdleTimeouts.get(scopeKey) ?? null;
	}
	return idleTimeoutMs;
}

function startIdleChecker(): void {
	if (idleCheckInterval) return;
	idleCheckInterval = setInterval(() => {
		const now = Date.now();
		for (const [key, client] of Array.from(clients.entries())) {
			const timeoutMs = getIdleTimeoutForClient(key);
			if (timeoutMs !== null && timeoutMs > 0 && now - client.lastActivity > timeoutMs) {
				void shutdownClient(key, client);
			}
		}
	}, IDLE_CHECK_INTERVAL_MS);
}

function stopIdleChecker(): void {
	if (idleCheckInterval) {
		clearInterval(idleCheckInterval);
		idleCheckInterval = null;
	}
}

export function isIdleCheckerActiveForTests(): boolean {
	return idleCheckInterval !== null;
}

function rejectPendingRequests(client: LspClient, error: Error): void {
	for (const pending of client.pendingRequests.values()) {
		pending.reject(error);
	}
	client.pendingRequests.clear();
}

function deleteCachedClient(key: string, client: LspClient): void {
	if (clients.get(key) === client) {
		clients.delete(key);
	}
}

function deleteClientLock(key: string, clientPromise: Promise<LspClient>): void {
	if (clientLocks.get(key) === clientPromise) {
		clientLocks.delete(key);
	}
}

function evictDeadCachedClient(key: string, client: LspClient): void {
	if (client.proc.exitCode === null && !client.proc.killed && !client.owner?.disposed && !killedClients.has(client))
		return;
	deleteCachedClient(key, client);
	client.resolveProjectLoaded();
	rejectPendingRequests(client, new Error("LSP server exited"));
}

function terminalizeTransport(client: LspClient, cause: unknown): Error {
	const existingError = transportClosedErrors.get(client);
	if (existingError) return existingError;

	const error = new Error(LSP_TRANSPORT_CLOSED_MESSAGE, { cause });
	transportClosedErrors.set(client, error);
	deleteCachedClient(client.name, client);
	client.resolveProjectLoaded();
	rejectPendingRequests(client, error);
	void client.owner?.dispose().catch(disposeError => {
		logger.debug("Failed to dispose terminal LSP transport owner", { error: String(disposeError) });
	});
	return error;
}
// =============================================================================
// Client Capabilities
// =============================================================================

const CLIENT_CAPABILITIES = {
	textDocument: {
		synchronization: {
			didSave: true,
			dynamicRegistration: false,
			willSave: false,
			willSaveWaitUntil: false,
		},
		hover: {
			contentFormat: ["markdown", "plaintext"],
			dynamicRegistration: false,
		},
		definition: {
			dynamicRegistration: false,
			linkSupport: true,
		},
		typeDefinition: {
			dynamicRegistration: false,
			linkSupport: true,
		},
		implementation: {
			dynamicRegistration: false,
			linkSupport: true,
		},
		references: {
			dynamicRegistration: false,
		},
		documentSymbol: {
			dynamicRegistration: false,
			hierarchicalDocumentSymbolSupport: true,
			symbolKind: {
				valueSet: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26],
			},
		},
		rename: {
			dynamicRegistration: false,
			prepareSupport: true,
		},
		codeAction: {
			dynamicRegistration: false,
			codeActionLiteralSupport: {
				codeActionKind: {
					valueSet: [
						"quickfix",
						"refactor",
						"refactor.extract",
						"refactor.inline",
						"refactor.rewrite",
						"source",
						"source.organizeImports",
						"source.fixAll",
					],
				},
			},
			resolveSupport: {
				properties: ["edit"],
			},
		},
		formatting: {
			dynamicRegistration: false,
		},
		rangeFormatting: {
			dynamicRegistration: false,
		},
		publishDiagnostics: {
			relatedInformation: true,
			versionSupport: true,
			tagSupport: { valueSet: [1, 2] },
			codeDescriptionSupport: true,
			dataSupport: true,
		},
	},
	window: {
		workDoneProgress: true,
	},
	workspace: {
		applyEdit: true,
		workspaceEdit: {
			documentChanges: true,
			resourceOperations: ["create", "rename", "delete"],
			failureHandling: "textOnlyTransactional",
		},
		configuration: true,
		symbol: {
			dynamicRegistration: false,
			symbolKind: {
				valueSet: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26],
			},
		},
		fileOperations: {
			dynamicRegistration: false,
			willCreate: false,
			didCreate: false,
			willRename: true,
			didRename: true,
			willDelete: false,
			didDelete: false,
		},
	},
	experimental: {
		snippetTextEdit: true,
	},
};

// =============================================================================
// LSP Message Protocol
// =============================================================================

/**
 * Parse a single LSP message from a buffer.
 * Returns the parsed message and remaining buffer, or null if incomplete.
 */
function parseMessage(
	buffer: Buffer,
): { message: LspJsonRpcResponse | LspJsonRpcNotification; remaining: Buffer } | null {
	// Only decode enough to find the header
	const headerEndIndex = findHeaderEnd(buffer);
	if (headerEndIndex === -1) return null;

	const headerText = new TextDecoder().decode(buffer.slice(0, headerEndIndex));
	const contentLengthMatch = headerText.match(/Content-Length: (\d+)/i);
	if (!contentLengthMatch) return null;

	const contentLength = Number.parseInt(contentLengthMatch[1], 10);
	const messageStart = headerEndIndex + 4; // Skip \r\n\r\n
	const messageEnd = messageStart + contentLength;

	if (buffer.length < messageEnd) return null;

	const messageBytes = buffer.subarray(messageStart, messageEnd);
	const messageText = new TextDecoder().decode(messageBytes);
	const remaining = buffer.subarray(messageEnd);

	return {
		message: JSON.parse(messageText),
		remaining,
	};
}

/**
 * Find the end of the header section (before \r\n\r\n)
 */
function findHeaderEnd(buffer: Uint8Array): number {
	for (let i = 0; i < buffer.length - 3; i++) {
		if (buffer[i] === 13 && buffer[i + 1] === 10 && buffer[i + 2] === 13 && buffer[i + 3] === 10) {
			return i;
		}
	}
	return -1;
}

async function writeMessage(
	client: LspClient,
	message: LspJsonRpcRequest | LspJsonRpcNotification | LspJsonRpcResponse,
): Promise<void> {
	const content = JSON.stringify(message);
	const terminalError = transportClosedErrors.get(client);
	if (terminalError) throw terminalError;

	try {
		// FileSink.write() returns `number | Promise<number>`: under backpressure
		// (e.g. a large didOpen/didChange payload) it returns a promise whose
		// rejection — typically EPIPE when the server dies mid-write — would
		// otherwise be discarded here and surface as an unhandled rejection that
		// takes down the whole process. Await it so every failure mode reaches
		// the transport-closed mapping below.
		await client.proc.stdin.write(`Content-Length: ${Buffer.byteLength(content, "utf-8")}\r\n\r\n${content}`);
		await client.proc.stdin.flush();
	} catch (error) {
		if (isKnownSinkPeerClosedError(error)) {
			throw terminalizeTransport(client, error);
		}
		throw error;
	}
}

function queueWriteMessage(
	client: LspClient,
	message: LspJsonRpcRequest | LspJsonRpcNotification | LspJsonRpcResponse,
): Promise<void> {
	const write = client.writeQueue.catch(() => {}).then(() => writeMessage(client, message));
	client.writeQueue = write.catch(() => {});
	return write;
}

// =============================================================================
// Message Reader
// =============================================================================

/**
 * Start background message reader for a client.
 * Routes responses to pending requests and handles notifications.
 */
async function startMessageReader(client: LspClient): Promise<void> {
	if (client.isReading) return;
	client.isReading = true;

	const reader = (client.proc.stdout as ReadableStream<Uint8Array>).getReader();

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;

			// Atomically update buffer before processing
			const currentBuffer: Buffer = Buffer.concat([client.messageBuffer, value]);
			client.messageBuffer = currentBuffer;

			// Process all complete messages in buffer
			// Use local variable to avoid race with concurrent buffer updates
			let workingBuffer = currentBuffer;
			let parsed = parseMessage(workingBuffer);
			while (parsed) {
				const { message, remaining } = parsed;
				workingBuffer = remaining;

				// Route message
				if ("id" in message && message.id !== undefined) {
					// Response to a request
					const pending = client.pendingRequests.get(message.id);
					if (pending) {
						client.pendingRequests.delete(message.id);
						if ("error" in message && message.error) {
							pending.reject(new Error(`LSP error: ${message.error.message}`));
						} else {
							pending.resolve(message.result);
						}
					} else if ("method" in message) {
						await handleServerRequest(client, message as LspJsonRpcRequest);
					}
				} else if ("method" in message) {
					// Server notification
					if (message.method === "textDocument/publishDiagnostics" && message.params) {
						const params = message.params as PublishDiagnosticsParams;
						client.diagnostics.set(params.uri, {
							diagnostics: params.diagnostics,
							version: params.version ?? null,
						});
						client.diagnosticsVersion += 1;
					} else if (message.method === "$/progress" && message.params) {
						const params = message.params as { token: string | number; value?: { kind?: string } };
						if (params.value?.kind === "begin") {
							client.activeProgressTokens.add(params.token);
						} else if (params.value?.kind === "end") {
							client.activeProgressTokens.delete(params.token);
							if (client.activeProgressTokens.size === 0) {
								client.resolveProjectLoaded();
							}
						}
					}
				}

				parsed = parseMessage(workingBuffer);
			}

			// Atomically commit processed buffer
			client.messageBuffer = workingBuffer;
		}
	} catch (err) {
		// Connection closed or error - reject all pending requests
		for (const pending of Array.from(client.pendingRequests.values())) {
			pending.reject(new Error(`LSP connection closed: ${err}`));
		}
		client.pendingRequests.clear();
	} finally {
		reader.releaseLock();
		client.isReading = false;
	}
}

/**
 * Handle workspace/configuration requests from the server.
 */
async function handleConfigurationRequest(client: LspClient, message: LspJsonRpcRequest): Promise<void> {
	if (typeof message.id !== "number") return;
	const params = message.params as { items?: Array<{ section?: string }> };
	const items = params?.items ?? [];
	const result = items.map(item => {
		const section = item.section ?? "";
		return client.config.settings?.[section] ?? {};
	});
	await sendResponse(client, message.id, result, "workspace/configuration");
}

/**
 * Handle workspace/applyEdit requests from the server.
 */
async function handleApplyEditRequest(client: LspClient, message: LspJsonRpcRequest): Promise<void> {
	if (typeof message.id !== "number") return;
	const params = message.params as { edit?: WorkspaceEdit };
	if (!params?.edit) {
		await sendResponse(
			client,
			message.id,
			{ applied: false, failureReason: "No edit provided" },
			"workspace/applyEdit",
		);
		return;
	}

	try {
		await applyWorkspaceEdit(params.edit, client.cwd);
		await sendResponse(client, message.id, { applied: true }, "workspace/applyEdit");
	} catch (err) {
		await sendResponse(client, message.id, { applied: false, failureReason: String(err) }, "workspace/applyEdit");
	}
}

/**
 * Respond to a server-initiated request.
 */
async function handleServerRequest(client: LspClient, message: LspJsonRpcRequest): Promise<void> {
	if (message.method === "workspace/configuration") {
		await handleConfigurationRequest(client, message);
		return;
	}
	if (message.method === "workspace/applyEdit") {
		await handleApplyEditRequest(client, message);
		return;
	}
	if (message.method === "window/workDoneProgress/create") {
		// Accept progress token registration from the server
		if (typeof message.id === "number") {
			await sendResponse(client, message.id, null, message.method);
		}
		return;
	}
	if (typeof message.id !== "number") return;
	await sendResponse(client, message.id, null, message.method, {
		code: -32601,
		message: `Method not found: ${message.method}`,
	});
}

/**
 * Send an LSP response to the server.
 */
async function sendResponse(
	client: LspClient,
	id: number,
	result: unknown,
	method: string,
	error?: { code: number; message: string; data?: unknown },
): Promise<void> {
	const response: LspJsonRpcResponse = {
		jsonrpc: "2.0",
		id,
		...(error ? { error } : { result }),
	};

	try {
		await queueWriteMessage(client, response);
	} catch (err) {
		logger.error("LSP failed to respond.", { method, error: String(err) });
	}
}

// =============================================================================
// Client Management
// =============================================================================

/** Timeout for warmup initialize requests (5 seconds) */
export const WARMUP_TIMEOUT_MS = 5000;

/** Max time to wait for the server to report project loading completion via $/progress */
const PROJECT_LOAD_TIMEOUT_MS = 15_000;

/**
 * Get or create an LSP client for the given server configuration and working directory.
 * @param config - Server configuration
 * @param cwd - Working directory
 * @param initTimeoutMs - Optional timeout for the initialize request (defaults to 30s)
 */
export async function getOrCreateClient(
	config: ServerConfig,
	cwd: string,
	initTimeoutMs?: number,
	agentDir?: string,
): Promise<LspClient> {
	// A language server process is scoped to both its workspace and effective
	// profile. Same-cwd sessions using different profiles must not share the
	// process (or its open files, diagnostics, and initialization state).
	const key = JSON.stringify([config.command, cwd, normalizedAgentDir(agentDir)]);
	const scopeKey = lspScopeKey(cwd, agentDir);

	// Check if client already exists
	const existingClient = clients.get(key);
	if (existingClient) {
		evictDeadCachedClient(key, existingClient);
		if (clients.has(key)) {
			existingClient.lastActivity = Date.now();
			return existingClient;
		}
	}

	// Check if another coroutine is already creating this client
	const existingLock = clientLocks.get(key);
	if (existingLock) {
		return existingLock;
	}

	// Create new client with lock
	let clientPromise!: Promise<LspClient>;
	clientPromise = (async () => {
		const creationGeneration = shutdownGeneration;
		const creationScopeGeneration = scopeGeneration(scopeKey);
		const baseCommand = config.resolvedCommand ?? config.command;
		const baseArgs = config.args ?? [];

		// Wrap with lspmux if available and supported
		const { command, args, env } = isLspmuxSupported(baseCommand)
			? await getLspmuxCommand(baseCommand, baseArgs, cwd)
			: { command: baseCommand, args: baseArgs };
		if (creationGeneration !== shutdownGeneration || creationScopeGeneration !== scopeGeneration(scopeKey)) {
			throw new Error("LSP client shutdown");
		}

		const owner = spawnOwnedProcess([command, ...args], {
			cwd,
			stdin: "pipe",
			env: env ? { ...Bun.env, ...env } : undefined,
			name: `lsp:${config.command}`,
		});
		const proc = owner.child;

		let resolveProjectLoaded!: () => void;
		const projectLoaded = new Promise<void>(resolve => {
			resolveProjectLoaded = resolve;
		});
		// Auto-resolve after timeout in case server doesn't use progress tokens
		const projectLoadTimeout = setTimeout(resolveProjectLoaded, PROJECT_LOAD_TIMEOUT_MS);
		const originalResolve = resolveProjectLoaded;
		resolveProjectLoaded = () => {
			clearTimeout(projectLoadTimeout);
			originalResolve();
		};

		const client: LspClient = {
			name: key,
			cwd,
			proc,
			owner,
			config,
			requestId: 0,
			diagnostics: new Map(),
			diagnosticsVersion: 0,
			openFiles: new Map(),
			pendingRequests: new Map(),
			messageBuffer: new Uint8Array(0),
			isReading: false,
			lastActivity: Date.now(),
			writeQueue: Promise.resolve(),
			activeProgressTokens: new Set(),
			projectLoaded,
			resolveProjectLoaded,
		};
		const originalKill = proc.kill.bind(proc);
		proc.kill = (...args: Parameters<typeof proc.kill>) => {
			killedClients.add(client);
			return originalKill(...args);
		};
		initializingClients.add(client);
		if (creationGeneration !== shutdownGeneration || creationScopeGeneration !== scopeGeneration(scopeKey)) {
			initializingClients.delete(client);
			await shutdownClientInstance(client);
			throw new Error("LSP client shutdown");
		}

		// Register crash recovery - remove client on process exit
		proc.exited.then(async () => {
			deleteCachedClient(key, client);
			deleteClientLock(key, clientPromise);
			client.resolveProjectLoaded();

			// Reject any pending requests — the server is gone, they will never complete.
			if (client.pendingRequests.size > 0) {
				// Strip informational log lines (e.g. marksman's [INF]/[DBG] prefix)
				// — they are startup noise, not actionable errors.
				const rawStderr = proc.peekStderr().trim();
				const stderr = rawStderr
					.split("\n")
					.filter(line => !/^\[\d{2}:\d{2}:\d{2} (?:INF|DBG|VRB)\]/.test(line))
					.join("\n")
					.trim();
				const crashNotice = formatCrashDiagnosticNotice(
					await writeCrashReport(
						{
							kind: "lsp",
							command: [command, ...args],
							exitCode: proc.exitCode,
							stderr,
							protocol: "lsp",
						},
						{ cwd },
					),
				);
				const diagnosticSuffix = crashNotice ? `\n${crashNotice}` : "";
				const code = proc.exitCode;
				const err = new Error(
					stderr
						? `LSP server exited (code ${code}): ${stderr}${diagnosticSuffix}`
						: `LSP server exited unexpectedly (code ${code})${diagnosticSuffix}`,
				);
				for (const pending of client.pendingRequests.values()) {
					pending.reject(err);
				}
				client.pendingRequests.clear();
			}
		});

		// Start background message reader
		startMessageReader(client);

		try {
			// Send initialize request
			const initResult = (await sendRequest(
				client,
				"initialize",
				{
					processId: process.pid,
					rootUri: fileToUri(cwd),
					rootPath: cwd,
					capabilities: CLIENT_CAPABILITIES,
					initializationOptions: config.initOptions ?? {},
					workspaceFolders: [{ uri: fileToUri(cwd), name: cwd.split("/").pop() ?? "workspace" }],
				},
				undefined, // signal
				initTimeoutMs,
			)) as { capabilities?: unknown };

			if (!initResult) {
				throw new Error("Failed to initialize LSP: no response");
			}

			client.serverCapabilities = initResult.capabilities as LspClient["serverCapabilities"];

			// Send initialized notification
			await sendNotification(client, "initialized", {});
			ensureLspCleanup();
			const terminalError = transportClosedErrors.get(client);
			if (terminalError) throw terminalError;
			if (creationGeneration !== shutdownGeneration || creationScopeGeneration !== scopeGeneration(scopeKey)) {
				throw new Error("LSP client shutdown");
			}

			// Publish to the cache only after the handshake completes: callers that
			// hit the `clients` map must never observe a client whose initialize is
			// still in flight. Concurrent callers instead share `clientLocks` and
			// wait for initialization, so a server that dies mid-handshake rejects
			// every waiter instead of handing them a transport that is about to
			// break underneath them.
			clients.set(key, client);

			return client;
		} catch (err) {
			// Clean up on initialization failure
			deleteClientLock(key, clientPromise);
			await shutdownClientInstance(client);
			throw err;
		} finally {
			initializingClients.delete(client);
			deleteClientLock(key, clientPromise);
		}
	})();

	clientLocks.set(key, clientPromise);
	return clientPromise;
}

/**
 * Ensure a file is opened in the LSP client.
 * Sends didOpen notification if the file is not already tracked.
 */
export async function ensureFileOpen(client: LspClient, filePath: string, signal?: AbortSignal): Promise<void> {
	throwIfAborted(signal);
	const uri = fileToUri(filePath);
	const lockKey = fileOperationLockKey(client, uri);

	// Check if file is already open
	if (client.openFiles.has(uri)) {
		return;
	}

	// Check if another operation is already opening this file
	// Serialize open with sync/refresh and retain the client identity represented
	// by this promise through scope replacement.
	const openPromise = withFileOperationLock(lockKey, signal, async () => {
		throwIfAborted(signal);
		// Double-check after acquiring lock
		if (client.openFiles.has(uri)) {
			return;
		}

		let content: string;
		try {
			content = await Bun.file(filePath).text();
			throwIfAborted(signal);
		} catch (err) {
			if (isEnoent(err)) return;
			throw err;
		}
		const languageId = detectLanguageId(filePath);
		throwIfAborted(signal);

		await sendNotification(client, "textDocument/didOpen", {
			textDocument: {
				uri,
				languageId,
				version: 1,
				text: content,
			},
		});

		client.openFiles.set(uri, { version: 1, languageId });
		client.lastActivity = Date.now();
	});
	await openPromise;
}

/**
 * Wait for the server's initial project loading to complete.
 * Races the server's $/progress tracking against the abort signal.
 * Returns immediately if loading already completed or timed out.
 */
export async function waitForProjectLoaded(client: LspClient, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) return;
	await untilAborted(signal, client.projectLoaded);
}

/**
 * Sync in-memory content to the LSP client without reading from disk.
 * Use this to provide instant feedback during edits before the file is saved.
 */
export async function syncContent(
	client: LspClient,
	filePath: string,
	content: string,
	signal?: AbortSignal,
): Promise<void> {
	const uri = fileToUri(filePath);
	const lockKey = fileOperationLockKey(client, uri);
	throwIfAborted(signal);

	const syncPromise = withFileOperationLock(lockKey, signal, async () => {
		throwIfAborted(signal);
		// Clear stale diagnostics before syncing new content
		client.diagnostics.delete(uri);

		const info = client.openFiles.get(uri);

		if (!info) {
			// Open file with provided content instead of reading from disk
			const languageId = detectLanguageId(filePath);
			throwIfAborted(signal);
			await sendNotification(client, "textDocument/didOpen", {
				textDocument: {
					uri,
					languageId,
					version: 1,
					text: content,
				},
			});
			client.openFiles.set(uri, { version: 1, languageId });
			client.lastActivity = Date.now();
			return;
		}

		const version = ++info.version;
		throwIfAborted(signal);
		await sendNotification(client, "textDocument/didChange", {
			textDocument: { uri, version },
			contentChanges: [{ text: content }],
		});
		client.lastActivity = Date.now();
	});
	await syncPromise;
}

/**
 * Notify LSP that a file was saved.
 * Assumes content was already synced via syncContent - just sends didSave.
 */
export async function notifySaved(client: LspClient, filePath: string, signal?: AbortSignal): Promise<void> {
	const uri = fileToUri(filePath);
	throwIfAborted(signal);
	await withFileOperationLock(fileOperationLockKey(client, uri), signal, async () => {
		throwIfAborted(signal);
		if (!client.openFiles.has(uri)) return;
		throwIfAborted(signal);
		await sendNotification(client, "textDocument/didSave", {
			textDocument: { uri },
		});
		client.lastActivity = Date.now();
	});
}

/**
 * Refresh a file in the LSP client.
 * Increments version, sends didChange and didSave notifications.
 */
export async function refreshFile(client: LspClient, filePath: string, signal?: AbortSignal): Promise<void> {
	throwIfAborted(signal);
	const uri = fileToUri(filePath);
	const lockKey = fileOperationLockKey(client, uri);

	const refreshPromise = withFileOperationLock(lockKey, signal, async () => {
		throwIfAborted(signal);
		// Drop cached diagnostics for this URI before asking the server to recompute.
		// Otherwise an unrelated publishDiagnostics notification can advance the global
		// diagnostics version and cause waiters to accept stale unversioned diagnostics.
		client.diagnostics.delete(uri);
		const info = client.openFiles.get(uri);

		if (!info) {
			let content: string;
			try {
				content = await Bun.file(filePath).text();
				throwIfAborted(signal);
			} catch (err) {
				if (isEnoent(err)) return;
				throw err;
			}
			const languageId = detectLanguageId(filePath);
			await sendNotification(client, "textDocument/didOpen", {
				textDocument: { uri, languageId, version: 1, text: content },
			});
			client.openFiles.set(uri, { version: 1, languageId });
			client.lastActivity = Date.now();
			return;
		}

		let content: string;
		try {
			content = await Bun.file(filePath).text();
			throwIfAborted(signal);
		} catch (err) {
			if (isEnoent(err)) return;
			throw err;
		}
		const version = ++info.version;
		throwIfAborted(signal);

		await sendNotification(client, "textDocument/didChange", {
			textDocument: { uri, version },
			contentChanges: [{ text: content }],
		});
		throwIfAborted(signal);

		await sendNotification(client, "textDocument/didSave", {
			textDocument: { uri },
			text: content,
		});

		client.lastActivity = Date.now();
	});
	await refreshPromise;
}

/**
 * Shutdown a specific client by key.
 */
async function shutdownClientInstance(client: LspClient): Promise<void> {
	const err = new Error("LSP client shutdown");
	rejectPendingRequests(client, err);

	const shutdown = sendRequest(client, "shutdown", null, undefined, 5_000).catch(() => {});
	await Promise.race([shutdown, Bun.sleep(5_000)]);
	await client.owner?.dispose();
	await client.owner?.awaitExit({ timeoutMs: 1_000 });
	await Promise.race([client.proc.exited.catch(() => undefined), Bun.sleep(1_000)]);
}

export async function shutdownClient(key: string, expectedClient?: LspClient): Promise<void> {
	const client = clients.get(key);
	if (!client || (expectedClient !== undefined && client !== expectedClient)) return;
	clients.delete(key);
	await shutdownClientInstance(client);
}

/**
 * Release one session's workspace/profile LSP scope.
 *
 * Clients remain alive while another session retains the same scope. Once the
 * final holder releases it, cached and in-flight clients for that exact scope
 * are shut down without touching sibling profiles or workspaces.
 */
export async function releaseLspScope(cwd: string, agentDir?: string): Promise<void> {
	const scopeKey = lspScopeKey(cwd, agentDir);
	const references = scopeReferences.get(scopeKey);
	if (references === undefined) return;
	if (references > 1) {
		scopeReferences.set(scopeKey, references - 1);
		return;
	}
	scopeReferences.delete(scopeKey);
	const shutdownGeneration = scopeGeneration(scopeKey) + 1;
	scopeShutdownGenerations.set(scopeKey, shutdownGeneration);

	const clientsToShutdown: LspClient[] = [];
	for (const [key, client] of Array.from(clients.entries())) {
		if (scopeKeyFromClientKey(key) !== scopeKey) continue;
		clients.delete(key);
		clientsToShutdown.push(client);
	}

	const initializingToShutdown = Array.from(initializingClients).filter(
		client => scopeKeyFromClientKey(client.name) === scopeKey,
	);
	const inFlightPromises: Promise<LspClient>[] = [];
	for (const [key, promise] of Array.from(clientLocks.entries())) {
		if (scopeKeyFromClientKey(key) !== scopeKey) continue;
		clientLocks.delete(key);
		inFlightPromises.push(promise);
	}

	await Promise.allSettled([
		...clientsToShutdown.map(client => shutdownClientInstance(client)),
		...initializingToShutdown.map(client => shutdownClientInstance(client)),
		...inFlightPromises,
	]);
	if (scopeReferences.has(scopeKey) === false && scopeGeneration(scopeKey) === shutdownGeneration) {
		scopeShutdownGenerations.delete(scopeKey);
	}
}

// =============================================================================
// LSP Protocol Methods
// =============================================================================

/** Default timeout for LSP requests (30 seconds) */
const DEFAULT_REQUEST_TIMEOUT_MS = 30000;

/**
 * Send an LSP request and wait for response.
 */
export async function sendRequest(
	client: LspClient,
	method: string,
	params: unknown,
	signal?: AbortSignal,
	timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS,
): Promise<unknown> {
	const terminalError = transportClosedErrors.get(client);
	if (terminalError) throw terminalError;
	// Atomically increment and capture request ID
	const id = ++client.requestId;
	if (signal?.aborted) {
		const reason = signal.reason instanceof Error ? signal.reason : new ToolAbortError();
		return Promise.reject(reason);
	}

	const request: LspJsonRpcRequest = {
		jsonrpc: "2.0",
		id,
		method,
		params,
	};

	client.lastActivity = Date.now();

	const { promise, resolve, reject } = Promise.withResolvers<unknown>();
	let timeout: NodeJS.Timeout | undefined;
	const cleanup = () => {
		if (signal) {
			signal.removeEventListener("abort", abortHandler);
		}
	};
	const abortHandler = () => {
		if (client.pendingRequests.has(id)) {
			client.pendingRequests.delete(id);
		}
		void sendNotification(client, "$/cancelRequest", { id }).catch(() => {});
		if (timeout) clearTimeout(timeout);
		cleanup();
		const reason = signal?.reason instanceof Error ? signal.reason : new ToolAbortError();
		reject(reason);
	};

	// Set timeout
	timeout = setTimeout(() => {
		if (client.pendingRequests.has(id)) {
			client.pendingRequests.delete(id);
			const err = new Error(`LSP request ${method} timed out after ${timeoutMs}ms`);
			cleanup();
			reject(err);
		}
	}, timeoutMs);
	if (signal) {
		signal.addEventListener("abort", abortHandler, { once: true });
		if (signal.aborted) {
			abortHandler();
			return promise;
		}
	}

	// Register pending request with timeout wrapper
	client.pendingRequests.set(id, {
		resolve: result => {
			if (timeout) clearTimeout(timeout);
			cleanup();
			resolve(result);
		},
		reject: err => {
			if (timeout) clearTimeout(timeout);
			cleanup();
			reject(err);
		},
		method,
	});

	// Write request
	queueWriteMessage(client, request).catch(err => {
		if (timeout) clearTimeout(timeout);
		client.pendingRequests.delete(id);
		cleanup();
		reject(err);
	});
	return promise;
}

/**
 * Send an LSP notification (no response expected).
 */
export async function sendNotification(client: LspClient, method: string, params: unknown): Promise<void> {
	const notification: LspJsonRpcNotification = {
		jsonrpc: "2.0",
		method,
		params,
	};

	client.lastActivity = Date.now();
	try {
		await queueWriteMessage(client, notification);
	} catch (error) {
		if (transportClosedErrors.get(client) === error) return;
		throw error;
	}
}

/**
 * Shutdown all LSP clients.
 */
export async function shutdownAll(): Promise<void> {
	stopIdleChecker();
	shutdownGeneration += 1;
	const inFlightPromises = Array.from(clientLocks.values());
	const initializingToShutdown = Array.from(initializingClients);
	clientLocks.clear();
	fileOperationLocks.clear();
	const clientsToShutdown = Array.from(clients.values());
	clients.clear();
	await Promise.allSettled([
		...clientsToShutdown.map(client => shutdownClientInstance(client)),
		...initializingToShutdown.map(client => shutdownClientInstance(client)),
		...inFlightPromises,
	]);
}

/** Status of an LSP server */
export interface LspServerStatus {
	name: string;
	status: "connecting" | "ready" | "error";
	fileTypes: string[];
	error?: string;
}

/**
 * Get status of all active LSP clients.
 */
export function getActiveClients(): LspServerStatus[] {
	return Array.from(clients.values()).map(client => ({
		name: client.config.command,
		status: "ready" as const,
		fileTypes: client.config.fileTypes,
	}));
}

// =============================================================================
// Process Cleanup
// =============================================================================

// Register cleanup on module unload
if (typeof process !== "undefined") {
	process.on("beforeExit", () => {
		void shutdownAll();
	});
	process.on("exit", () => {
		lspCleanupOwner?.();
		for (const client of clients.values()) {
			client.proc.kill();
		}
	});
	process.on("SIGINT", () => {
		void (async () => {
			await shutdownAll();
			process.exit(0);
		})();
	});
	process.on("SIGTERM", () => {
		void (async () => {
			await shutdownAll();
			process.exit(0);
		})();
	});
}
