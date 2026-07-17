/**
 * MCP Client.
 *
 * Handles connection initialization, tool listing, and tool calling.
 */
import * as path from "node:path";
import * as url from "node:url";
import { getProjectDir, logger, withTimeout } from "@gajae-code/utils";
import { createHttpTransport } from "./transports/http";
import { createStdioTransport } from "./transports/stdio";
import type {
	MCPGetPromptParams,
	MCPGetPromptResult,
	MCPHttpServerConfig,
	MCPInitializeParams,
	MCPInitializeResult,
	MCPPrompt,
	MCPPromptsListResult,
	MCPRequestOptions,
	MCPResource,
	MCPResourceReadParams,
	MCPResourceReadResult,
	MCPResourceSubscribeParams,
	MCPResourcesListResult,
	MCPResourceTemplate,
	MCPResourceTemplatesListResult,
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
import { MCPExpectedFailure } from "./types";

/** MCP protocol version we support */
const PROTOCOL_VERSION = "2025-03-26";

/** Default connection timeout in ms */
const CONNECTION_TIMEOUT_MS = 30_000;

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

/**
 * Default handler for standard MCP server-to-client requests.
 * Handles `ping` and `roots/list`; rejects unknown methods with -32601.
 * Reads getProjectDir() at call time so the root stays stable even if
 * the process cwd changes during tool execution.
 */
async function defaultRequestHandler(method: string, _params: unknown): Promise<unknown> {
	switch (method) {
		case "ping":
			return {};
		case "roots/list": {
			const cwd = getProjectDir();
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
		case "sse":
			return createHttpTransport(config as MCPHttpServerConfig | MCPSseServerConfig);
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
		capabilities: options?.advertiseRoots === false ? {} : { roots: { listChanged: false } },
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
	},
): Promise<MCPServerConnection> {
	const timeoutMs = config.timeout ?? CONNECTION_TIMEOUT_MS;
	let transport: MCPTransport | undefined;
	const connectAbort = new AbortController();
	const connectSignal = options?.signal ? AbortSignal.any([options.signal, connectAbort.signal]) : connectAbort.signal;

	const connect = async (): Promise<MCPServerConnection> => {
		transport = await createTransport(config);
		if (options?.onNotification) {
			transport.onNotification = options.onNotification;
		}

		// Always install a handler for standard MCP server-to-client requests.
		// Callers that do not advertise roots can reject roots/list via onRequest.
		transport.onRequest = options?.onRequest ?? defaultRequestHandler;

		try {
			const initResult = await initializeConnection(transport, {
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
				transport,
				serverInfo: initResult.serverInfo,
				capabilities: initResult.capabilities,
				instructions: initResult.instructions,
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
	// Check if server supports tools
	if (!connection.capabilities.tools) {
		return [];
	}

	// Return cached tools if available
	if (connection.tools) {
		return connection.tools;
	}

	const allTools: MCPToolDefinition[] = [];
	let cursor: string | undefined;

	do {
		const params: Record<string, unknown> = {};
		if (cursor) {
			params.cursor = cursor;
		}

		const result = decodeToolsListResult(await connection.transport.request<unknown>("tools/list", params, options));
		allTools.push(...result.tools);
		cursor = result.nextCursor;
	} while (cursor);

	// Cache tools
	connection.tools = allTools;

	return allTools;
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

	return connection.transport.request<MCPToolCallResult>(
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
	if (!connection.capabilities.resources) {
		return [];
	}

	if (connection.resources) {
		return connection.resources;
	}

	const allResources: MCPResource[] = [];
	let cursor: string | undefined;

	do {
		const params: Record<string, unknown> = {};
		if (cursor) {
			params.cursor = cursor;
		}

		const result = await connection.transport.request<MCPResourcesListResult>("resources/list", params, options);
		allResources.push(...result.resources);
		cursor = result.nextCursor;
	} while (cursor);

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
	if (!connection.capabilities.resources) {
		return [];
	}

	if (connection.resourceTemplates) {
		return connection.resourceTemplates;
	}

	const allTemplates: MCPResourceTemplate[] = [];
	let cursor: string | undefined;

	do {
		const params: Record<string, unknown> = {};
		if (cursor) {
			params.cursor = cursor;
		}

		const result = await connection.transport.request<MCPResourceTemplatesListResult>(
			"resources/templates/list",
			params,
			options,
		);
		allTemplates.push(...result.resourceTemplates);
		cursor = result.nextCursor;
	} while (cursor);

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
	return connection.transport.request<MCPResourceReadResult>(
		"resources/read",
		params as unknown as Record<string, unknown>,
		options,
	);
}

/**
 * Subscribe to resource update notifications.
 */
export async function subscribeToResources(
	connection: MCPServerConnection,
	uris: string[],
	options?: MCPRequestOptions,
): Promise<void> {
	if (uris.length === 0 || !connection.capabilities.resources?.subscribe) return;
	const results = await Promise.allSettled(
		uris.map(uri => {
			const params: MCPResourceSubscribeParams = { uri };
			return connection.transport.request(
				"resources/subscribe",
				params as unknown as Record<string, unknown>,
				options,
			);
		}),
	);
	for (const result of results) {
		if (result.status === "rejected") {
			logger.warn("Failed to subscribe to MCP resource", { error: result.reason });
		}
	}
}

/**
 * Unsubscribe from resource update notifications.
 */
export async function unsubscribeFromResources(
	connection: MCPServerConnection,
	uris: string[],
	options?: MCPRequestOptions,
): Promise<void> {
	if (uris.length === 0 || !connection.capabilities.resources?.subscribe) return;
	const results = await Promise.allSettled(
		uris.map(uri => {
			const params: MCPResourceSubscribeParams = { uri };
			return connection.transport.request(
				"resources/unsubscribe",
				params as unknown as Record<string, unknown>,
				options,
			);
		}),
	);
	for (const result of results) {
		if (result.status === "rejected") {
			logger.warn("Failed to unsubscribe from MCP resource", { error: result.reason });
		}
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
	if (!connection.capabilities.prompts) {
		return [];
	}

	if (connection.prompts) {
		return connection.prompts;
	}

	const allPrompts: MCPPrompt[] = [];
	let cursor: string | undefined;

	do {
		const params: Record<string, unknown> = {};
		if (cursor) {
			params.cursor = cursor;
		}

		const result = await connection.transport.request<MCPPromptsListResult>("prompts/list", params, options);
		allPrompts.push(...result.prompts);
		cursor = result.nextCursor;
	} while (cursor);

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

	return connection.transport.request<MCPGetPromptResult>(
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
