/**
 * MCP (Model Context Protocol) type definitions.
 *
 * Legacy sessionful surface based on MCP specification 2025-03-26; the modern
 * stateless generation (2026-07-28, "MCP v2") is modeled in ./protocol.ts.
 * https://modelcontextprotocol.io/specification/2026-07-28/
 */

import type { SourceMeta } from "../capability/types";
import type { MCPCacheHints, MCPProtocolObservation, MCPProtocolPreference } from "./protocol";

// =============================================================================
// JSON-RPC 2.0 Types
// =============================================================================

export interface JsonRpcRequest {
	jsonrpc: "2.0";
	id: string | number;
	method: string;
	params?: Record<string, unknown>;
}

export interface JsonRpcNotification {
	jsonrpc: "2.0";
	method: string;
	params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
	jsonrpc: "2.0";
	id: string | number;
	result?: unknown;
	error?: JsonRpcError;
}

export interface JsonRpcError {
	code: number;
	message: string;
	data?: unknown;
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

// =============================================================================
// MCP Server Configuration (.mcp.json format)
// =============================================================================

/** Authentication configuration for MCP servers */
export interface MCPAuthConfig {
	/** Authentication type */
	type: "oauth" | "apikey";
	/** Credential ID for OAuth (references agent.db) */
	credentialId?: string;
	/** Token endpoint URL — persisted for proactive token refresh */
	tokenUrl?: string;
	/** Client ID — persisted for token refresh */
	clientId?: string;
	/** Client secret — persisted for token refresh */
	clientSecret?: string;
}

/** Base server config with shared options */
export interface MCPServerConfigBase {
	/** Whether this server is enabled (default: true) */
	enabled?: boolean;
	/**
	 * Whether an explicit runtime MCP consumer should connect this server
	 * automatically when that consumer starts (default: true). Ordinary
	 * standalone `gjc`, `gjc --tmux`, and print-mode sessions honor autoload for
	 * conventional registrations; `autoload: false` keeps a server configured
	 * for on-demand `/mcp` connection. `--no-mcp` opts a session out entirely.
	 */
	autoload?: boolean;
	/** Connection timeout in milliseconds (default: 30000) */
	timeout?: number;
	/** Pool identity mode. W2 defaults to one physical connection per session. */
	sharing?: "per-session" | "shared";
	/**
	 * Protocol preference for remote (http/sse) servers: `auto` (default) negotiates
	 * the modern 2026-07-28 stateless protocol first with a bounded, observable
	 * legacy fallback; `2026-07-28` is strict modern-only; `legacy` forces the
	 * bounded compatibility handshake. Ignored by stdio servers (always legacy-era).
	 */
	protocol?: MCPProtocolPreference;
	/** Authentication configuration (optional) */
	auth?: MCPAuthConfig;
	/** OAuth configuration for servers requiring explicit client credentials */
	oauth?: {
		clientId?: string;
		clientSecret?: string;
		redirectUri?: string;
		callbackPort?: number;
		callbackPath?: string;
	};
}

/** Stdio server configuration */
export interface MCPStdioSpawnLaunch {
	command: string;
	args: readonly string[];
	cwd: string;
	/** Transport-supplied registrar for retryable cleanup before preparation allocates resources. */
	registerCleanup?: (cleanup: () => Promise<void>) => void;
}

export interface MCPStdioPreparedLaunch extends MCPStdioSpawnLaunch {
	/**
	 * Per-attempt cleanup run after confirmed child exit or failed spawn. The same
	 * callback may already have been registered during preparation.
	 */
	afterProcessExit?: () => Promise<void>;
}

export interface MCPStdioServerConfig extends MCPServerConfigBase {
	type?: "stdio"; // Default if not specified
	command: string;
	args?: string[];
	env?: Record<string, string>;
	/**
	 * When true, the child process is NOT given the host environment. Only a
	 * minimal OS allowlist (PATH/HOME/temp/locale) plus any explicit `env` keys
	 * are passed. Used for third-party plugin-bundle MCP servers so they cannot
	 * read host secrets from the inherited environment.
	 */
	noInheritEnv?: boolean;
	cwd?: string;
	/** Internal trusted-boundary preparation of immutable per-spawn authority. */
	prepareSpawn?: (launch: MCPStdioSpawnLaunch) => Promise<MCPStdioPreparedLaunch>;
	/** Internal trusted-boundary check run immediately before process creation. */
	spawnGuard?: (launch: MCPStdioSpawnLaunch) => Promise<void>;
	/** Internal cleanup run only after the owned stdio child is confirmed exited. */
	afterProcessExit?: () => Promise<void>;
	/** Test seam for deterministic mutation after the guard and before process creation. */
	afterSpawnGuardForTest?: () => Promise<void>;
}

/** HTTP server configuration (Streamable HTTP transport) */
export interface MCPHttpServerConfig extends MCPServerConfigBase {
	type: "http";
	url: string;
	headers?: Record<string, string>;
}

/** SSE server configuration (deprecated, use HTTP) */
export interface MCPSseServerConfig extends MCPServerConfigBase {
	type: "sse";
	url: string;
	headers?: Record<string, string>;
}

export type MCPServerConfig = MCPStdioServerConfig | MCPHttpServerConfig | MCPSseServerConfig;

export const MCP_CONFIG_SCHEMA_URL =
	"https://raw.githubusercontent.com/Yeachan-Heo/gajae-code/main/packages/coding-agent/src/config/mcp-schema.json";

/** Root mcp.json/.mcp.json file structure */
export interface MCPConfigFile {
	$schema?: string;
	mcpServers?: Record<string, MCPServerConfig>;
	disabledServers?: string[];
}

// =============================================================================
// MCP Protocol Types
// =============================================================================

/** MCP implementation info */
export interface MCPImplementation {
	name: string;
	version: string;
}

/** MCP client capabilities */
export interface MCPClientCapabilities {
	roots?: { listChanged?: boolean };
	sampling?: Record<string, never>;
	/** Form-mode elicitation support (modern MRTR `elicitation/create` input requests). */
	elicitation?: { form?: Record<string, never> };
	experimental?: Record<string, unknown>;
}

/** MCP server capabilities */
export interface MCPServerCapabilities {
	tools?: { listChanged?: boolean };
	resources?: { subscribe?: boolean; listChanged?: boolean };
	prompts?: { listChanged?: boolean };
	logging?: Record<string, never>;
	experimental?: Record<string, unknown>;
}

/** Initialize request params */
export interface MCPInitializeParams {
	protocolVersion: string;
	capabilities: MCPClientCapabilities;
	clientInfo: MCPImplementation;
}

/** Initialize response result */
export interface MCPInitializeResult {
	protocolVersion: string;
	capabilities: MCPServerCapabilities;
	serverInfo: MCPImplementation;
	instructions?: string;
}

/** MCP tool definition */
export interface MCPToolDefinition {
	name: string;
	description?: string;
	inputSchema: {
		type: "object";
		properties?: Record<string, unknown>;
		required?: string[];
		[key: string]: unknown;
	};
}

/** tools/list response */
export interface MCPToolsListResult extends MCPCacheHints {
	tools: MCPToolDefinition[];
	nextCursor?: string;
}

/** tools/call params */
export interface MCPToolCallParams {
	name: string;
	arguments?: Record<string, unknown>;
}

/** Content types in tool results */
export interface MCPTextContent {
	type: "text";
	text: string;
}

export interface MCPImageContent {
	type: "image";
	data: string; // base64
	mimeType: string;
}

export interface MCPResourceContent {
	type: "resource";
	resource: {
		uri: string;
		mimeType?: string;
		text?: string;
		blob?: string;
	};
}

export type MCPContent = MCPTextContent | MCPImageContent | MCPResourceContent;

/** tools/call response */
export interface MCPToolCallResult {
	content: MCPContent[];
	isError?: boolean;
	/** MCP result metadata, encoded as `_meta` on the wire. */
	_meta?: Record<string, unknown>;
}

// =============================================================================
// Transport Types
// =============================================================================

/** Expected configured-server transport or protocol failure. */
export class MCPExpectedFailure extends Error {
	constructor(cause?: unknown) {
		super(
			cause instanceof Error ? cause.message : "MCP server operation failed",
			cause === undefined ? undefined : { cause },
		);
		this.name = "MCPExpectedFailure";
	}
}

/** HTTP-level request failure carrying structured detail for era classification. */
export class MCPHttpRequestError extends Error {
	/** HTTP status code. */
	readonly status: number;
	/** Parsed JSON body when the error payload was JSON; undefined otherwise. */
	readonly body: unknown;
	constructor(status: number, message: string, body?: unknown) {
		super(message);
		this.name = "MCPHttpRequestError";
		this.status = status;
		this.body = body;
	}
}

/** JSON-RPC error response failure carrying the protocol error code. */
export class MCPJsonRpcError extends Error {
	readonly code: number;
	readonly data?: unknown;
	constructor(code: number, message: string, data?: unknown) {
		super(`MCP error ${code}: ${message}`);
		this.name = "MCPJsonRpcError";
		this.code = code;
		this.data = data;
	}
}
export interface MCPRequestOptions {
	/** Abort signal (e.g. Escape-to-interrupt) */
	signal?: AbortSignal;
	/** Shared lease policy: never retry the original request after transport/auth failure. */
	noReplay?: boolean;
	/**
	 * Handler for modern MRTR `input_required` results (elicitation, roots, sampling).
	 * When absent, an `input_required` result fails explicitly instead of hanging.
	 */
	inputHandler?: MCPInputRequestHandler;
	/** Extra mirrored headers for modern requests (`Mcp-Param-*` from x-mcp-header bindings). */
	mcpParamHeaders?: Record<string, string>;
}

// =============================================================================
// MRTR (multi round-trip) input handling
// =============================================================================

/** Context for one server input request gathered during a modern MRTR exchange. */
export interface MCPInputRequestContext {
	/** Server being called. */
	serverName: string;
	/** Original client request method (`tools/call`, `prompts/get`, `resources/read`). */
	originMethod: string;
	/**
	 * Stable correlation id shared by the initial request and its exactly-once
	 * retry, fencing the accepted input to this exchange.
	 */
	correlationId: string;
	/** Request-scoped abort signal (cancellation/timeout of the original call). */
	signal?: AbortSignal;
}

/**
 * Outcome of gathering one server input request. `result` values are placed in
 * the retry's `inputResponses` under the request key. `failed` outcomes abort
 * the MRTR exchange with an explicit error — except elicitation decline/cancel,
 * which the handler expresses as an ElicitResult-shaped `result`.
 */
export type MCPInputRequestHandlerResult =
	| { kind: "result"; result: unknown }
	| { kind: "failed"; reason: "declined" | "cancelled" | "timeout" | "unavailable" | "error"; message?: string };

/** Handler for one server input request inside an `input_required` result. */
export type MCPInputRequestHandler = (
	key: string,
	request: { method: string; params?: Record<string, unknown> },
	context: MCPInputRequestContext,
) => Promise<MCPInputRequestHandlerResult>;

/** Transport interface - abstracts stdio/http */
export interface MCPTransport {
	/** Send a request and wait for response */
	request<T = unknown>(method: string, params?: Record<string, unknown>, options?: MCPRequestOptions): Promise<T>;

	/** Send a notification (no response expected) */
	notify(method: string, params?: Record<string, unknown>): Promise<void>;

	/** Close the transport */
	close(): Promise<void>;

	/** Whether close must finish before reconnect can safely spawn a replacement. */
	readonly closeBeforeReconnect?: boolean;

	/** Whether the transport is connected */
	readonly connected: boolean;

	/** Event handlers */
	onClose?: () => void;
	onError?: (error: Error) => void;
	onNotification?: (method: string, params: unknown) => void;
	/** Handler for server-to-client requests (e.g. roots/list). Returns result or throws a JsonRpcError. */
	onRequest?: (method: string, params: unknown) => Promise<unknown>;
}

/** Transport factory function */
export type TransportFactory = (config: MCPServerConfig) => Promise<MCPTransport>;

// =============================================================================
// MCP Client Types
// =============================================================================

/** Connected MCP server state */
export interface MCPServerConnection {
	/** Server name from config */
	name: string;
	/** Original config */
	config: MCPServerConfig;
	/** Transport instance */
	transport: MCPTransport;
	/** Server info from initialize */
	serverInfo: MCPImplementation;
	/** Server capabilities */
	capabilities: MCPServerCapabilities;
	/** Cached tools (populated on demand) */
	tools?: MCPToolDefinition[];
	/** Source metadata (for display) */
	_source?: SourceMeta;
	/** Cached resources (populated on demand) */
	resources?: MCPResource[];
	/** Cached resource templates (populated on demand) */
	resourceTemplates?: MCPResourceTemplate[];
	/** Server instructions from initialize */
	instructions?: string;
	/** Cached prompts (populated on demand) */
	prompts?: MCPPrompt[];
	/**
	 * Authoritative protocol observation for this connection (preference,
	 * negotiated era/version, downgrade decision, deprecation state). Secret-free.
	 */
	protocol: MCPProtocolObservation;
	/** Freshness deadline (ms epoch) for the cached tool catalog, from server ttlMs hints. */
	toolsFreshUntil?: number;
	/** Cache scope of the cached tool catalog; private entries never cross credential identities. */
	toolsCacheScope?: "public" | "private";
}

/** MCP tool with server context */
export interface MCPToolWithServer {
	server: MCPServerConnection;
	tool: MCPToolDefinition;
}

// =============================================================================
// MCP Resource Types
// =============================================================================

/** Annotations for resources, templates, and content blocks */
export interface MCPAnnotations {
	audience?: ("user" | "assistant")[];
	priority?: number;
	lastModified?: string;
}

/** A concrete resource exposed by an MCP server */
export interface MCPResource {
	uri: string;
	name: string;
	title?: string;
	description?: string;
	mimeType?: string;
	size?: number;
	annotations?: MCPAnnotations;
}

/** A parameterized resource template (RFC 6570 URI template) */
export interface MCPResourceTemplate {
	uriTemplate: string;
	name: string;
	title?: string;
	description?: string;
	mimeType?: string;
	annotations?: MCPAnnotations;
}

/** Result of resources/list */
export interface MCPResourcesListResult extends MCPCacheHints {
	resources: MCPResource[];
	nextCursor?: string;
}

/** Result of resources/templates/list */
export interface MCPResourceTemplatesListResult extends MCPCacheHints {
	resourceTemplates: MCPResourceTemplate[];
	nextCursor?: string;
}

/** A single content item from resources/read */
export interface MCPResourceContentItem {
	uri: string;
	mimeType?: string;
	text?: string;
	blob?: string;
}

/** Result of resources/read */
export interface MCPResourceReadResult extends MCPCacheHints {
	contents: MCPResourceContentItem[];
}

/** Params for resources/read */
export interface MCPResourceReadParams {
	uri: string;
}

/** Params for resources/subscribe and resources/unsubscribe */
export interface MCPResourceSubscribeParams {
	uri: string;
}

// =============================================================================
// MCP Prompt Types
// =============================================================================

/** An argument definition for an MCP prompt */
export interface MCPPromptArgument {
	name: string;
	description?: string;
	required?: boolean;
}

/** A prompt definition exposed by an MCP server */
export interface MCPPrompt {
	name: string;
	title?: string;
	description?: string;
	arguments?: MCPPromptArgument[];
}

/** Result of prompts/list */
export interface MCPPromptsListResult extends MCPCacheHints {
	prompts: MCPPrompt[];
	nextCursor?: string;
}

/** Audio content in prompt messages */
export interface MCPAudioContent {
	type: "audio";
	data: string;
	mimeType: string;
}

/** Content type union for prompt messages */
export type MCPPromptContent = MCPTextContent | MCPImageContent | MCPAudioContent | MCPResourceContent;

/** A single message in a prompt result */
export interface MCPPromptMessage {
	role: "user" | "assistant";
	content: MCPPromptContent | MCPPromptContent[];
}

/** Params for prompts/get */
export interface MCPGetPromptParams {
	name: string;
	arguments?: Record<string, string>;
}

/** Result of prompts/get */
export interface MCPGetPromptResult {
	description?: string;
	messages: MCPPromptMessage[];
}

// =============================================================================
// server/discover (modern era)
// =============================================================================

/** Result of the optional modern `server/discover` request. */
export interface MCPDiscoverResult extends MCPCacheHints {
	/** Protocol versions the server supports. */
	supportedVersions: string[];
	/** Capabilities the server supports. */
	capabilities: MCPServerCapabilities;
	/** Optional natural-language usage guidance. */
	instructions?: string;
	/** Result metadata; `io.modelcontextprotocol/serverInfo` carries the identity. */
	_meta?: Record<string, unknown>;
}

/** Decoded `server/discover` payload with the extracted server identity. */
export interface MCPDiscoverResultLite extends MCPDiscoverResult {
	serverInfo?: MCPImplementation;
}

// =============================================================================
// MCP Notification Method Names
// =============================================================================

/** MCP server notification method names */
export const MCPNotificationMethods = {
	TOOLS_LIST_CHANGED: "notifications/tools/list_changed",
	RESOURCES_LIST_CHANGED: "notifications/resources/list_changed",
	RESOURCES_UPDATED: "notifications/resources/updated",
	PROMPTS_LIST_CHANGED: "notifications/prompts/list_changed",
} as const;

/** Extract a JsonRpcError from a thrown value. Preserves `.code` and `.message` from Error instances or plain objects. */
export function toJsonRpcError(error: unknown): JsonRpcError {
	if (error instanceof Error) {
		const code = "code" in error && typeof error.code === "number" ? error.code : -32603;
		return { code, message: error.message };
	}
	if (typeof error === "object" && error !== null) {
		const obj = error as Record<string, unknown>;
		if (typeof obj.code === "number" && typeof obj.message === "string") {
			return { code: obj.code, message: obj.message };
		}
	}
	return { code: -32603, message: "Internal error" };
}
