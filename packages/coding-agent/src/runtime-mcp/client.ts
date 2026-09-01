/**
 * MCP Client.
 *
 * Handles connection negotiation (modern 2026-07-28 stateless vs legacy
 * sessionful), tool listing, and tool calling. Era detection and the downgrade
 * policy live in ./protocol.ts; legacy behavior is unchanged.
 */
import * as path from "node:path";
import * as url from "node:url";
import { getProjectDir, logger, withTimeout } from "@gajae-code/utils";
import {
	buildXMcpParamHeaders,
	classifyMcpProbeFailure,
	collectXMcpHeaderBindings,
	extractMcpInputRequired,
	isModernProtocolVersion,
	JSONRPC_ERROR_METHOD_NOT_FOUND,
	legacyEraObservation,
	MCP_ERROR_UNSUPPORTED_PROTOCOL_VERSION,
	MCP_PROTOCOL_VERSION_2026_07_28,
	type MCPDowngradeReason,
	type MCPModernClientContext,
	modernEraObservation,
	normalizeMcpCacheHints,
	resolveMCPProtocolPreference,
} from "./protocol";
import { createHttpTransport, HttpTransport } from "./transports/http";
import { createStdioTransport } from "./transports/stdio";
import type {
	MCPDiscoverResultLite,
	MCPGetPromptParams,
	MCPGetPromptResult,
	MCPHttpServerConfig,
	MCPInitializeParams,
	MCPInitializeResult,
	MCPPrompt,
	MCPRequestOptions,
	MCPResource,
	MCPResourceReadParams,
	MCPResourceReadResult,
	MCPResourceSubscribeParams,
	MCPResourceTemplate,
	MCPServerCapabilities,
	MCPServerConfig,
	MCPServerConnection,
	MCPSseServerConfig,
	MCPStdioServerConfig,
	MCPToolCallParams,
	MCPToolCallResult,
	MCPToolDefinition,
	MCPToolsListResult,
	MCPTransport,
} from "./types";
import { MCPExpectedFailure, MCPHttpRequestError, MCPJsonRpcError } from "./types";

/** MCP protocol version we support */
const PROTOCOL_VERSION = "2025-03-26";

/** Default connection timeout in ms */
const CONNECTION_TIMEOUT_MS = 30_000;

const MAX_PAGINATION_PAGES = 100,
	MAX_PAGINATION_ITEMS = 10_000;

/** Client info sent during initialization */
const CLIENT_INFO = {
	name: "gjc-coding-agent",
	version: "1.0.0",
};
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeInitializeResult(value: unknown): MCPInitializeResult {
	if (
		!isRecord(value) ||
		typeof value.protocolVersion !== "string" ||
		!isRecord(value.capabilities) ||
		!isRecord(value.serverInfo) ||
		typeof value.serverInfo.name !== "string" ||
		typeof value.serverInfo.version !== "string" ||
		(value.instructions !== undefined && typeof value.instructions !== "string")
	) {
		throw new MCPExpectedFailure();
	}

	return {
		protocolVersion: value.protocolVersion,
		capabilities: value.capabilities as MCPServerCapabilities,
		serverInfo: {
			name: value.serverInfo.name,
			version: value.serverInfo.version,
		},
		...(value.instructions === undefined ? {} : { instructions: value.instructions }),
	};
}

function decodeToolsListResult(value: unknown): MCPToolsListResult {
	if (
		!isRecord(value) ||
		!Array.isArray(value.tools) ||
		(value.nextCursor !== undefined && typeof value.nextCursor !== "string")
	) {
		throw new MCPExpectedFailure();
	}

	const tools = value.tools.map(tool => {
		if (
			!isRecord(tool) ||
			typeof tool.name !== "string" ||
			!isRecord(tool.inputSchema) ||
			tool.inputSchema.type !== "object" ||
			(tool.inputSchema.properties !== undefined && !isRecord(tool.inputSchema.properties)) ||
			(tool.inputSchema.required !== undefined &&
				(!Array.isArray(tool.inputSchema.required) ||
					!tool.inputSchema.required.every(item => typeof item === "string"))) ||
			(tool.description !== undefined && typeof tool.description !== "string")
		) {
			throw new MCPExpectedFailure();
		}
		return {
			name: tool.name,
			inputSchema: { ...tool.inputSchema, type: "object" as const },
			...(tool.description === undefined ? {} : { description: tool.description }),
		};
	});

	return value.nextCursor === undefined ? { tools } : { tools, nextCursor: value.nextCursor };
}

async function collectPaginated<T>(
	connection: MCPServerConnection,
	options: MCPRequestOptions | undefined,
	method: string,
	itemKey: string,
	items: T[],
	decode?: (value: unknown) => unknown,
	onPage?: (result: Record<string, unknown>) => void,
): Promise<void> {
	const seenCursors = new Set<string>();
	const failure = (detail: string) => new MCPExpectedFailure(new Error(`MCP ${method} pagination ${detail}`));
	let cursor: string | undefined;
	for (let page = 1; page <= MAX_PAGINATION_PAGES; page++) {
		const value = await connection.transport.request<unknown>(method, cursor ? { cursor } : {}, options);
		const result = decode ? decode(value) : value;
		if (
			!isRecord(result) ||
			!Array.isArray(result[itemKey]) ||
			(result.nextCursor !== undefined && typeof result.nextCursor !== "string")
		)
			throw new MCPExpectedFailure();
		const nextCursor = result.nextCursor as string | undefined;
		if (nextCursor && seenCursors.has(nextCursor)) throw failure("repeated a cursor");
		const pageItems = result[itemKey] as T[];
		const itemCount = items.length + pageItems.length;
		if (itemCount > MAX_PAGINATION_ITEMS || (itemCount === MAX_PAGINATION_ITEMS && nextCursor))
			throw failure("did not complete within the 10000-item budget");
		items.push(...pageItems);
		onPage?.(result as Record<string, unknown>);
		if (!nextCursor) return;
		if (page === MAX_PAGINATION_PAGES) throw failure("did not complete within the 100-page budget");
		seenCursors.add(nextCursor);
		cursor = nextCursor;
	}
}

/**
 * Default handler for standard MCP server-to-client requests.
 * Handles `ping` and `roots/list`; rejects unknown methods with -32601.
 * Reads getProjectDir() at call time so the root stays stable even if
 * the process cwd changes during tool execution.
 */
async function defaultRequestHandler(method: string, _params: unknown, cwd = getProjectDir()): Promise<unknown> {
	switch (method) {
		case "ping":
			return {};
		case "roots/list": {
			return {
				roots: [{ uri: url.pathToFileURL(cwd).href, name: path.basename(cwd) }],
			};
		}
		default:
			throw Object.assign(new Error(`Unsupported server request: ${method}`), { code: -32601 });
	}
}

/**
 * Create a transport for the given server config.
 */
async function createTransport(config: MCPServerConfig): Promise<MCPTransport> {
	const serverType = config.type ?? "stdio";

	switch (serverType) {
		case "stdio":
			return createStdioTransport(config as MCPStdioServerConfig);
		case "http":
			return createHttpTransport(config as MCPHttpServerConfig);
		case "sse":
			// Compatibility: `sse` configs use Streamable HTTP, not the legacy MCP SSE
			// protocol. The configured URL receives JSON-RPC POST requests directly.
			return createHttpTransport(config as MCPSseServerConfig);
		default:
			throw new Error(`Unknown server type: ${serverType}`);
	}
}

/**
 * Initialize connection with MCP server.
 */
async function initializeConnection(
	transport: MCPTransport,
	options?: {
		signal?: AbortSignal;
		/** Whether to advertise the roots/list capability (default: true). */
		advertiseRoots?: boolean;
		/** Called after the initialize response (which sets the session ID) but before notifications/initialized. */
		onInitialized?: () => void | Promise<void>;
	},
): Promise<MCPInitializeResult> {
	const params: MCPInitializeParams = {
		protocolVersion: PROTOCOL_VERSION,
		capabilities: options?.advertiseRoots === false ? {} : { roots: { listChanged: true } },
		clientInfo: CLIENT_INFO,
	};

	const result = decodeInitializeResult(
		await transport.request<unknown>("initialize", params as unknown as Record<string, unknown>, {
			signal: options?.signal,
		}),
	);

	if (options?.signal?.aborted) {
		throw options.signal.reason instanceof Error ? options.signal.reason : new Error("Aborted");
	}

	// Hook point: the transport now has the session ID from the initialize response.
	// For HTTP, this is the moment to open the SSE stream so server-to-client requests
	// triggered by notifications/initialized (e.g. roots/list) can be delivered.
	await options?.onInitialized?.();

	// Send initialized notification
	await transport.notify("notifications/initialized");

	return result;
}

/** Negotiation-local failure (distinguished from transport failures by type). */
class ModernNegotiationError extends Error {}

/** Build the per-request modern client context (2026-07-28). */
function buildModernClientContext(options?: { advertiseRoots?: boolean }): MCPModernClientContext {
	const capabilities: Record<string, unknown> = {};
	if (options?.advertiseRoots !== false) {
		capabilities.roots = { listChanged: true };
	}
	return {
		protocolVersion: MCP_PROTOCOL_VERSION_2026_07_28,
		clientInfo: CLIENT_INFO,
		capabilities,
	};
}

/** Decode a `server/discover` result, including `_meta` serverInfo and cache hints. */
function decodeDiscoverResult(value: unknown): MCPDiscoverResultLite {
	if (
		!isRecord(value) ||
		!Array.isArray(value.supportedVersions) ||
		!value.supportedVersions.every(entry => typeof entry === "string") ||
		!isRecord(value.capabilities)
	) {
		throw new MCPExpectedFailure();
	}
	const meta = isRecord(value._meta) ? value._meta : undefined;
	const serverInfoRaw = meta?.["io.modelcontextprotocol/serverInfo"];
	const serverInfo =
		isRecord(serverInfoRaw) && typeof serverInfoRaw.name === "string" && typeof serverInfoRaw.version === "string"
			? { name: serverInfoRaw.name, version: serverInfoRaw.version }
			: undefined;
	const hints = normalizeMcpCacheHints(value);
	return {
		supportedVersions: value.supportedVersions as string[],
		capabilities: value.capabilities as MCPServerCapabilities,
		...(typeof value.instructions === "string" ? { instructions: value.instructions } : {}),
		...(hints?.ttlMs !== undefined ? { ttlMs: hints.ttlMs } : {}),
		...(hints?.cacheScope !== undefined ? { cacheScope: hints.cacheScope } : {}),
		...(serverInfo ? { serverInfo } : {}),
	};
}

/** Unwrap the original transport failure preserved as MCPExpectedFailure.cause. */
function unwrapTransportFailure(error: unknown): unknown {
	return error instanceof MCPExpectedFailure && error.cause !== undefined ? error.cause : error;
}

type ModernNegotiation =
	| { outcome: "modern"; discovery: MCPDiscoverResultLite | null; discoverState: "yes" | "no"; versionRetry: boolean }
	| { outcome: "legacy-fallback"; reason: MCPDowngradeReason };

/**
 * Negotiate the modern era with an HTTP server via the optional `server/discover`
 * probe and the specification's era-detection rules. Auth, issuer/audience,
 * redirect/SSRF/DNS, malformed-response, and other security or protocol-integrity
 * failures NEVER authorize a downgrade; only a 400/404/405 without a recognized
 * modern error body, or an explicit version advertisement containing only
 * legacy-era versions, may fall back — and only under `auto`.
 */
async function negotiateModernEra(
	transport: HttpTransport,
	preference: "auto" | "2026-07-28",
	signal: AbortSignal,
): Promise<ModernNegotiation> {
	const strict = preference === MCP_PROTOCOL_VERSION_2026_07_28;
	const failStrict = (detail: string): never => {
		throw new ModernNegotiationError(`strict 2026-07-28: ${detail}`);
	};
	let versionRetry = false;
	for (;;) {
		let discovery: MCPDiscoverResultLite;
		try {
			discovery = decodeDiscoverResult(await transport.request<unknown>("server/discover", {}, { signal }));
		} catch (error) {
			const cause = unwrapTransportFailure(error);
			if (cause instanceof MCPHttpRequestError) {
				const classification = classifyMcpProbeFailure(cause.status, cause.body);
				switch (classification.class) {
					case "auth-failure":
					case "other-failure":
						// Auth/security/protocol-integrity failures are never era signals.
						throw error;
					case "legacy-signal":
						if (strict) failStrict("server rejected the modern probe without a recognized modern error");
						return { outcome: "legacy-fallback", reason: "legacy-server-signal" };
					case "modern-error": {
						if (classification.modernErrorCode === MCP_ERROR_UNSUPPORTED_PROTOCOL_VERSION) {
							const supported = classification.supportedVersions ?? [];
							if (supported.includes(MCP_PROTOCOL_VERSION_2026_07_28)) {
								// Retry the probe once with the mutually supported version.
								if (versionRetry) {
									throw new MCPExpectedFailure(new Error("MCP version negotiation did not converge"));
								}
								versionRetry = true;
								continue;
							}
							if (supported.length > 0 && supported.every(v => !isModernProtocolVersion(v))) {
								if (strict) failStrict(`server advertises only legacy-era versions (${supported.join(", ")})`);
								return { outcome: "legacy-fallback", reason: "server-advertised-legacy-only" };
							}
							throw new MCPExpectedFailure(
								new Error(
									`MCP server does not support protocol ${MCP_PROTOCOL_VERSION_2026_07_28} (supported: ${supported.join(", ") || "unknown"})`,
								),
							);
						}
						if (classification.modernErrorCode === JSONRPC_ERROR_METHOD_NOT_FOUND) {
							// Modern server without the optional server/discover: proceed with
							// direct v2 calls; capabilities are learned lazily.
							return { outcome: "modern", discovery: null, discoverState: "no", versionRetry };
						}
						// HeaderMismatch / MissingRequiredClientCapability: a modern server
						// rejecting our request context — a defect or policy failure, never
						// a downgrade signal.
						throw new MCPExpectedFailure(
							new Error(
								`MCP modern server rejected the request context (code ${classification.modernErrorCode})`,
							),
						);
					}
				}
			}
			if (cause instanceof MCPJsonRpcError && cause.code === JSONRPC_ERROR_METHOD_NOT_FOUND) {
				// Ambiguous: legacy servers also answer -32601 to unknown methods. Strict
				// mode may assume the modern era; auto treats it as a legacy signal.
				if (strict) return { outcome: "modern", discovery: null, discoverState: "no", versionRetry };
				return { outcome: "legacy-fallback", reason: "legacy-server-signal" };
			}
			// Network, timeout, abort, or malformed 2xx payloads: never downgrade.
			throw error;
		}

		if (discovery.supportedVersions.includes(MCP_PROTOCOL_VERSION_2026_07_28)) {
			return { outcome: "modern", discovery, discoverState: "yes", versionRetry };
		}
		if (discovery.supportedVersions.some(isModernProtocolVersion)) {
			throw new MCPExpectedFailure(
				new Error(
					`MCP server supports only newer modern protocol versions (${discovery.supportedVersions.join(", ")}); this client implements ${MCP_PROTOCOL_VERSION_2026_07_28}`,
				),
			);
		}
		if (discovery.supportedVersions.length > 0) {
			if (strict)
				failStrict(`server advertises only legacy-era versions (${discovery.supportedVersions.join(", ")})`);
			return { outcome: "legacy-fallback", reason: "server-advertised-legacy-only" };
		}
		throw new MCPExpectedFailure(new Error("MCP server/discover returned no supported versions"));
	}
}

/** Maximum MRTR retries per original request (repeated input_required rounds). */
const MAX_MRTR_RETRIES = 3;

/** True when the failure is a modern "method not found" (unknown/unsupported method). */
function isModernMethodNotFound(error: unknown): boolean {
	const cause = unwrapTransportFailure(error);
	if (cause instanceof MCPJsonRpcError && cause.code === JSONRPC_ERROR_METHOD_NOT_FOUND) return true;
	if (cause instanceof MCPHttpRequestError && cause.status === 404) return true;
	return false;
}

/**
 * Issue a modern-era request, resolving `input_required` (MRTR) interim results.
 * The original request is retried with `inputResponses` and a verbatim
 * `requestState` echo under a fresh JSON-RPC id, at most MAX_MRTR_RETRIES times;
 * the retry is fenced to the originating exchange by a stable correlation id.
 */
async function requestWithInputHandling<T>(
	connection: MCPServerConnection,
	method: string,
	params: Record<string, unknown>,
	options?: MCPRequestOptions,
): Promise<T> {
	const stripResultType = (value: unknown): T => {
		// A present resultType of "complete" is the modern default; drop the marker
		// so legacy-shaped consumers see the legacy result shape.
		if (isRecord(value) && typeof value.resultType === "string") {
			const { resultType: _discarded, ...rest } = value;
			return rest as T;
		}
		return value as T;
	};

	const initial = await connection.transport.request<unknown>(method, params, options);
	if (connection.protocol.era !== "modern") return initial as T;
	let inputRequired = extractMcpInputRequired(initial);
	if (!inputRequired) return stripResultType(initial);

	const handler = options?.inputHandler;
	const correlationId = crypto.randomUUID();

	for (let attempt = 0; attempt < MAX_MRTR_RETRIES; attempt++) {
		const inputResponses = Object.create(null) as Record<string, unknown>;
		for (const [key, request] of Object.entries(inputRequired.inputRequests)) {
			if (options?.signal?.aborted) {
				throw options.signal.reason instanceof Error ? options.signal.reason : new Error("Aborted");
			}
			if (request.method === "roots/list") {
				if (connection.rootsEnabled === false) {
					throw new MCPExpectedFailure(
						new Error(`MCP server "${connection.name}" requested roots/list while roots are disabled`),
					);
				}
				// roots are answered from local state without user interaction.
				inputResponses[key] = await defaultRequestHandler("roots/list", undefined, connection.clientCwd);
				continue;
			}
			if (!handler) {
				throw new MCPExpectedFailure(
					new Error(
						`MCP server "${connection.name}" requested additional input (input_required) for ${method}, but no interactive input handler is available`,
					),
				);
			}
			const outcome = await handler(key, request, {
				serverName: connection.name,
				originMethod: method,
				correlationId,
				...(options?.signal ? { signal: options.signal } : {}),
			});
			if (outcome.kind === "failed") {
				throw new MCPExpectedFailure(
					new Error(
						`MCP input request "${key}" for ${method} ${outcome.reason}${outcome.message ? `: ${outcome.message}` : ""}`,
					),
				);
			}
			inputResponses[key] = outcome.result;
		}
		// The retry is a NEW request (fresh JSON-RPC id assigned by the transport)
		// carrying the original params plus the gathered input; inputResponses and
		// requestState are fenced to this exchange and never reused elsewhere.
		const retryParams: Record<string, unknown> = { ...params, inputResponses };
		if (inputRequired.requestState !== undefined) {
			retryParams.requestState = inputRequired.requestState;
		}
		const retryResult = await connection.transport.request<unknown>(method, retryParams, options);
		inputRequired = extractMcpInputRequired(retryResult);
		if (!inputRequired) return stripResultType(retryResult);
	}
	throw new MCPExpectedFailure(
		new Error(`MCP server "${connection.name}" repeatedly requested additional input for ${method}`),
	);
}

/**
 * Connect to an MCP server.
 * Has a 30 second timeout to prevent blocking startup.
 */
export async function connectToServer(
	name: string,
	config: MCPServerConfig,
	options?: {
		signal?: AbortSignal;
		/** Whether to advertise the roots/list capability (default: true). */
		advertiseRoots?: boolean;
		onNotification?: (method: string, params: unknown) => void;
		onRequest?: (method: string, params: unknown) => Promise<unknown>;
		cwd?: string;
	},
): Promise<MCPServerConnection> {
	const timeoutMs = config.timeout ?? CONNECTION_TIMEOUT_MS;
	let transport: MCPTransport | undefined;
	const connectAbort = new AbortController();
	const connectSignal = options?.signal ? AbortSignal.any([options.signal, connectAbort.signal]) : connectAbort.signal;

	const preference = resolveMCPProtocolPreference(config.protocol);

	const connect = async (): Promise<MCPServerConnection> => {
		transport = await createTransport(config);
		if (options?.onNotification) {
			transport.onNotification = options.onNotification;
		}

		// Always install a handler for standard MCP server-to-client requests.
		// Callers that do not advertise roots can reject roots/list via onRequest.
		// (Modern-era transports never receive server-initiated requests; MRTR
		// input requests arrive as input_required results instead.)
		transport.onRequest =
			options?.onRequest ?? ((method, params) => defaultRequestHandler(method, params, options?.cwd));

		const connectLegacy = async (
			negotiationState: "legacy-fallback" | "legacy-forced",
			reason: MCPDowngradeReason,
		): Promise<MCPServerConnection> => {
			const initResult = await initializeConnection(transport!, {
				signal: connectSignal,
				advertiseRoots: options?.advertiseRoots,
				async onInitialized() {
					// Open the SSE stream before sending initialized, so server-to-client
					// requests triggered by on_initialized (e.g. roots/list) are delivered.
					if ("startSSEListener" in transport! && typeof transport!.startSSEListener === "function") {
						await (transport as { startSSEListener(): Promise<void> }).startSSEListener();
					}
				},
			});
			return {
				name,
				config,
				clientCwd: options?.cwd,
				rootsEnabled: options?.advertiseRoots !== false,
				transport: transport!,
				serverInfo: initResult.serverInfo,
				capabilities: initResult.capabilities,
				instructions: initResult.instructions,
				protocol: legacyEraObservation({
					preference,
					effectiveVersion: initResult.protocolVersion,
					negotiation: negotiationState,
					downgradeReason: reason,
					serverInfo: initResult.serverInfo,
					capabilities: {
						tools: initResult.capabilities.tools !== undefined,
						resources: initResult.capabilities.resources !== undefined,
						prompts: initResult.capabilities.prompts !== undefined,
					},
				}),
			};
		};

		try {
			// stdio has no per-request HTTP era signals; it stays on the legacy handshake.
			if ((config.type ?? "stdio") === "stdio") {
				return await connectLegacy("legacy-forced", "stdio-transport");
			}
			if (preference === "legacy") {
				return await connectLegacy("legacy-forced", "preference-legacy");
			}

			// auto / strict 2026-07-28: negotiate the modern era first.
			if (!(transport instanceof HttpTransport)) {
				throw new MCPExpectedFailure(new Error(`MCP server "${name}" did not produce an HTTP transport`));
			}
			transport.setProtocolMode("modern", buildModernClientContext(options));
			const negotiation = await negotiateModernEra(transport, preference, connectSignal);
			if (negotiation.outcome === "legacy-fallback") {
				transport.setProtocolMode("legacy");
				return await connectLegacy("legacy-fallback", negotiation.reason);
			}

			const discovery = negotiation.discovery;
			const serverInfo = discovery?.serverInfo ?? { name, version: "unknown" };
			const capabilities = discovery?.capabilities ?? {};
			return {
				name,
				config,
				clientCwd: options?.cwd,
				rootsEnabled: options?.advertiseRoots !== false,
				transport,
				serverInfo,
				capabilities,
				instructions: discovery?.instructions,
				protocol: modernEraObservation({
					preference,
					effectiveVersion: MCP_PROTOCOL_VERSION_2026_07_28,
					negotiation: negotiation.versionRetry ? "modern-version-retry" : "modern",
					supportedVersions: discovery?.supportedVersions,
					serverInfo: discovery?.serverInfo ?? null,
					capabilities: discovery
						? {
								tools: discovery.capabilities.tools !== undefined,
								resources: discovery.capabilities.resources !== undefined,
								prompts: discovery.capabilities.prompts !== undefined,
							}
						: undefined,
					discover: negotiation.discoverState,
				}),
			};
		} catch (error) {
			try {
				await transport.close();
			} catch {
				// Preserve the initialization failure when cleanup also fails.
			}
			throw error;
		}
	};

	const connectionTimeoutMessage = `Connection to MCP server "${name}" timed out after ${timeoutMs}ms`;

	try {
		return await withTimeout(connect(), timeoutMs, connectionTimeoutMessage, connectSignal);
	} catch (error) {
		// If withTimeout rejected (timeout/abort) while connect() was still pending,
		// abort initialization and wait for transport cleanup before returning.
		const aborted = options?.signal?.aborted === true;
		connectAbort.abort(error);
		if (transport) {
			try {
				await transport.close();
			} catch {
				// Preserve the primary connection failure when cleanup also fails.
			}
		}
		if (error instanceof MCPExpectedFailure) {
			throw error;
		}
		if (aborted || (error instanceof Error && error.message === connectionTimeoutMessage)) {
			throw new MCPExpectedFailure(error);
		}
		throw error;
	}
}

/**
 * List tools from a connected server.
 */
export async function listTools(
	connection: MCPServerConnection,
	options?: { signal?: AbortSignal },
): Promise<MCPToolDefinition[]> {
	const modern = connection.protocol.era === "modern";
	// Legacy gating uses the negotiated capabilities; modern servers without
	// server/discover learn capability lazily (method-not-found means no tools).
	if (!modern && !connection.capabilities.tools) {
		return [];
	}

	// Return cached tools while fresh: server ttlMs hints bound freshness when present.
	if (connection.tools) {
		if (connection.toolsFreshUntil !== undefined && Date.now() >= connection.toolsFreshUntil) {
			connection.tools = undefined;
			connection.toolsFreshUntil = undefined;
			connection.toolsCacheScope = undefined;
		} else {
			return connection.tools;
		}
	}

	let freshUntil: number | undefined;
	let cacheScope: "public" | "private" | undefined;
	const allTools: MCPToolDefinition[] = [];
	try {
		await collectPaginated(connection, options, "tools/list", "tools", allTools, decodeToolsListResult, page => {
			const hints = normalizeMcpCacheHints(page);
			if (hints?.ttlMs !== undefined) {
				const deadline = Date.now() + hints.ttlMs;
				freshUntil = freshUntil === undefined ? deadline : Math.min(freshUntil, deadline);
			}
			if (hints?.cacheScope !== undefined) cacheScope = hints.cacheScope;
		});
	} catch (error) {
		if (modern && isModernMethodNotFound(error)) return [];
		throw error;
	}

	// Modern era: HTTP clients MUST exclude tools with invalid x-mcp-header
	// annotations rather than letting one malformed tool break the catalog.
	const validTools = modern
		? allTools.filter(tool => {
				const { violations } = collectXMcpHeaderBindings(tool.inputSchema);
				if (violations.length === 0) return true;
				logger.warn("Excluding MCP tool with invalid x-mcp-header annotation", {
					tool: tool.name,
					reason: violations.join("; "),
				});
				return false;
			})
		: allTools;

	// Cache tools
	connection.tools = validTools;
	connection.toolsFreshUntil = freshUntil;
	connection.toolsCacheScope = cacheScope;

	return validTools;
}

/**
 * Call a tool on a connected server.
 */
export async function callTool(
	connection: MCPServerConnection,
	toolName: string,
	args: Record<string, unknown> = {},
	options?: MCPRequestOptions,
): Promise<MCPToolCallResult> {
	const params: MCPToolCallParams = {
		name: toolName,
		arguments: args,
	};

	// Modern era: mirror validated x-mcp-header bindings into Mcp-Param-* headers.
	if (connection.protocol.era === "modern" && !options?.mcpParamHeaders) {
		const tool = connection.tools?.find(candidate => candidate.name === toolName);
		if (tool) {
			const { bindings } = collectXMcpHeaderBindings(tool.inputSchema);
			if (bindings.length > 0) {
				const mcpParamHeaders = buildXMcpParamHeaders(bindings, args);
				if (Object.keys(mcpParamHeaders).length > 0) {
					options = { ...options, mcpParamHeaders };
				}
			}
		}
	}

	return requestWithInputHandling<MCPToolCallResult>(
		connection,
		"tools/call",
		params as unknown as Record<string, unknown>,
		options,
	);
}

/**
 * Disconnect from a server.
 */
export async function disconnectServer(connection: MCPServerConnection): Promise<void> {
	await connection.transport.close();
}

/**
 * Check if a server supports tools.
 */
export function serverSupportsTools(capabilities: MCPServerCapabilities): boolean {
	return capabilities.tools !== undefined;
}

/**
 * List resources from a connected server.
 */
export async function listResources(
	connection: MCPServerConnection,
	options?: { signal?: AbortSignal },
): Promise<MCPResource[]> {
	const modern = connection.protocol.era === "modern";
	if (!modern && !connection.capabilities.resources) {
		return [];
	}

	if (connection.resources) {
		return connection.resources;
	}

	const allResources: MCPResource[] = [];
	try {
		await collectPaginated(connection, options, "resources/list", "resources", allResources);
	} catch (error) {
		if (modern && isModernMethodNotFound(error)) return [];
		throw error;
	}

	connection.resources = allResources;
	return allResources;
}

/**
 * List resource templates from a connected server.
 */
export async function listResourceTemplates(
	connection: MCPServerConnection,
	options?: { signal?: AbortSignal },
): Promise<MCPResourceTemplate[]> {
	const modern = connection.protocol.era === "modern";
	if (!modern && !connection.capabilities.resources) {
		return [];
	}

	if (connection.resourceTemplates) {
		return connection.resourceTemplates;
	}

	const allTemplates: MCPResourceTemplate[] = [];
	try {
		await collectPaginated(connection, options, "resources/templates/list", "resourceTemplates", allTemplates);
	} catch (error) {
		if (modern && isModernMethodNotFound(error)) return [];
		throw error;
	}

	connection.resourceTemplates = allTemplates;
	return allTemplates;
}

/**
 * Read a resource from a connected server.
 */
export async function readResource(
	connection: MCPServerConnection,
	uri: string,
	options?: MCPRequestOptions,
): Promise<MCPResourceReadResult> {
	const params: MCPResourceReadParams = { uri };
	return requestWithInputHandling<MCPResourceReadResult>(
		connection,
		"resources/read",
		params as unknown as Record<string, unknown>,
		options,
	);
}

type MCPResourceSubscriptionOptions = MCPRequestOptions & { throwOnError?: boolean };
function resourceSubscriptionRequestOptions(options?: MCPResourceSubscriptionOptions): MCPRequestOptions | undefined {
	return options?.signal ? { signal: options.signal } : undefined;
}

/**
 * Subscribe to resource update notifications.
 */
export async function subscribeToResources(
	connection: MCPServerConnection,
	uris: string[],
	options?: MCPResourceSubscriptionOptions,
): Promise<void> {
	if (uris.length === 0 || !connection.capabilities.resources?.subscribe) return;
	const results = await Promise.allSettled(
		uris.map(uri => {
			const params: MCPResourceSubscribeParams = { uri };
			return connection.transport.request(
				"resources/subscribe",
				params as unknown as Record<string, unknown>,
				resourceSubscriptionRequestOptions(options),
			);
		}),
	);
	const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
	if (options?.throwOnError && failures.length > 0) {
		const successfulUris = uris.filter((_uri, index) => results[index]?.status === "fulfilled");
		const compensation = await Promise.allSettled(
			successfulUris.map(uri =>
				connection.transport.request(
					"resources/unsubscribe",
					{ uri } as unknown as Record<string, unknown>,
					resourceSubscriptionRequestOptions(options),
				),
			),
		);
		const compensationFailures = compensation.filter(
			(result): result is PromiseRejectedResult => result.status === "rejected",
		);
		throw new AggregateError(
			[...failures.map(result => result.reason), ...compensationFailures.map(result => result.reason)],
			"MCP resource subscription failed",
		);
	}
	for (const result of failures) {
		logger.warn("Failed to subscribe to MCP resource", { error: result.reason });
	}
}

/**
 * Unsubscribe from resource update notifications.
 */
export async function unsubscribeFromResources(
	connection: MCPServerConnection,
	uris: string[],
	options?: MCPResourceSubscriptionOptions,
): Promise<void> {
	if (uris.length === 0 || !connection.capabilities.resources?.subscribe) return;
	const results = await Promise.allSettled(
		uris.map(uri => {
			const params: MCPResourceSubscribeParams = { uri };
			return connection.transport.request(
				"resources/unsubscribe",
				params as unknown as Record<string, unknown>,
				resourceSubscriptionRequestOptions(options),
			);
		}),
	);
	const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
	if (options?.throwOnError && failures.length > 0) {
		const successfulUris = uris.filter((_uri, index) => results[index]?.status === "fulfilled");
		const compensation = await Promise.allSettled(
			successfulUris.map(uri =>
				connection.transport.request(
					"resources/subscribe",
					{ uri } as unknown as Record<string, unknown>,
					resourceSubscriptionRequestOptions(options),
				),
			),
		);
		const compensationFailures = compensation.filter(
			(result): result is PromiseRejectedResult => result.status === "rejected",
		);
		throw new AggregateError(
			[...failures.map(result => result.reason), ...compensationFailures.map(result => result.reason)],
			"MCP resource unsubscription failed",
		);
	}
	for (const result of failures) {
		logger.warn("Failed to unsubscribe from MCP resource", { error: result.reason });
	}
}

/**
 * Check if a server supports resource subscriptions.
 */
export function serverSupportsResourceSubscriptions(capabilities: MCPServerCapabilities): boolean {
	return capabilities.resources?.subscribe === true;
}

/**
 * Check if a server supports resources.
 */
export function serverSupportsResources(capabilities: MCPServerCapabilities): boolean {
	return capabilities.resources !== undefined;
}

/**
 * List prompts from a connected server.
 */
export async function listPrompts(
	connection: MCPServerConnection,
	options?: { signal?: AbortSignal },
): Promise<MCPPrompt[]> {
	const modern = connection.protocol.era === "modern";
	if (!modern && !connection.capabilities.prompts) {
		return [];
	}

	if (connection.prompts) {
		return connection.prompts;
	}

	const allPrompts: MCPPrompt[] = [];
	try {
		await collectPaginated(connection, options, "prompts/list", "prompts", allPrompts);
	} catch (error) {
		if (modern && isModernMethodNotFound(error)) return [];
		throw error;
	}

	connection.prompts = allPrompts;
	return allPrompts;
}

/**
 * Get a specific prompt from a connected server.
 */
export async function getPrompt(
	connection: MCPServerConnection,
	name: string,
	args?: Record<string, string>,
	options?: MCPRequestOptions,
): Promise<MCPGetPromptResult> {
	const params: MCPGetPromptParams = { name };
	if (args && Object.keys(args).length > 0) {
		params.arguments = args;
	}

	return requestWithInputHandling<MCPGetPromptResult>(
		connection,
		"prompts/get",
		params as unknown as Record<string, unknown>,
		options,
	);
}

/**
 * Check if a server supports prompts.
 */
export function serverSupportsPrompts(capabilities: MCPServerCapabilities): boolean {
	return capabilities.prompts !== undefined;
}
