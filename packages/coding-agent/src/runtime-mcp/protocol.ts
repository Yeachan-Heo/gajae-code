/**
 * MCP protocol generation model ("MCP v2", specification 2026-07-28).
 *
 * Canonical authority (verified against the primary sources, not secondary
 * summaries):
 * - https://modelcontextprotocol.io/specification/2026-07-28/basic
 * - https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http
 * - https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning
 * - https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/mrtr
 * - https://modelcontextprotocol.io/specification/2026-07-28/server/discover
 * - https://modelcontextprotocol.io/specification/2026-07-28/server/utilities/caching
 * - schema source of truth: modelcontextprotocol/specification schema/2026-07-28/schema.ts
 *
 * 2026-07-28 ("modern" era) removes the initialize/initialized handshake,
 * protocol sessions (`Mcp-Session-Id`), the standalone GET SSE stream, and
 * `Last-Event-ID` replay from the core request path. Every request carries its
 * protocol version, client identity, and client capabilities in `_meta`, and
 * Streamable HTTP mirrors selected fields into `MCP-Protocol-Version`,
 * `Mcp-Method`, and `Mcp-Name` headers.
 */

// =============================================================================
// Protocol versions and eras
// =============================================================================

/** The modern (stateless) protocol revision implemented by this client. */
export const MCP_PROTOCOL_VERSION_2026_07_28 = "2026-07-28";

/** Legacy (initialize handshake) revision this client speaks for compatibility. */
export const MCP_PROTOCOL_VERSION_LEGACY = "2025-03-26";

/** Modern-era revisions this client can speak, most preferred first. */
export const MCP_MODERN_PROTOCOL_VERSIONS: readonly string[] = [MCP_PROTOCOL_VERSION_2026_07_28];

/** Protocol generation: modern = per-request metadata (2026-07-28+), legacy = initialize handshake. */
export type MCPProtocolEra = "modern" | "legacy";

/**
 * Per-server protocol preference from configuration.
 * - `auto`: attempt modern first; bounded, observable legacy fallback per the
 *   specification's era-detection rules. Default when unset.
 * - `2026-07-28`: strict modern-only; never initializes a legacy session.
 * - `legacy`: bounded compatibility mode; always uses the legacy handshake.
 */
export type MCPProtocolPreference = "auto" | "2026-07-28" | "legacy";

export const MCP_PROTOCOL_PREFERENCES: readonly MCPProtocolPreference[] = ["auto", "2026-07-28", "legacy"];

export function isMCPProtocolPreference(value: unknown): value is MCPProtocolPreference {
	return typeof value === "string" && (MCP_PROTOCOL_PREFERENCES as readonly string[]).includes(value);
}

/** Resolve the effective preference; `auto` when unset. */
export function resolveMCPProtocolPreference(value: MCPProtocolPreference | undefined): MCPProtocolPreference {
	return value ?? "auto";
}

/** True when a version string names a modern-era revision (date-based, >= 2026-07-28). */
export function isModernProtocolVersion(version: string): boolean {
	return version >= MCP_PROTOCOL_VERSION_2026_07_28;
}

// =============================================================================
// Protocol-defined JSON-RPC error codes (2026-07-28 reserved range)
// =============================================================================

/** Headers do not match the request body, or required headers are missing/malformed. */
export const MCP_ERROR_HEADER_MISMATCH = -32020;
/** The request requires a client capability the client did not declare. */
export const MCP_ERROR_MISSING_REQUIRED_CLIENT_CAPABILITY = -32021;
/** The server does not implement the requested protocol version. */
export const MCP_ERROR_UNSUPPORTED_PROTOCOL_VERSION = -32022;
/** Standard JSON-RPC method-not-found (modern servers pair it with HTTP 404). */
export const JSONRPC_ERROR_METHOD_NOT_FOUND = -32601;
/** Standard JSON-RPC invalid-params (modern servers reject missing `_meta` with it). */
export const JSONRPC_ERROR_INVALID_PARAMS = -32602;

// =============================================================================
// Per-request `_meta` (modern era)
// =============================================================================

export const MCP_META_PROTOCOL_VERSION = "io.modelcontextprotocol/protocolVersion";
export const MCP_META_CLIENT_INFO = "io.modelcontextprotocol/clientInfo";
export const MCP_META_CLIENT_CAPABILITIES = "io.modelcontextprotocol/clientCapabilities";
export const MCP_META_SERVER_INFO = "io.modelcontextprotocol/serverInfo";

/** Client identity advertised in modern per-request `_meta`. */
export interface MCPModernClientContext {
	protocolVersion: string;
	clientInfo: { name: string; version: string };
	/** Capabilities relevant to requests, e.g. `{ roots: {...}, elicitation: {...} }`. */
	capabilities: Record<string, unknown>;
}

/**
 * Build the `_meta` object every modern request MUST carry. Callers merge this
 * into `params._meta`, preserving any pre-existing keys (e.g. `progressToken`).
 */
export function buildModernRequestMeta(context: MCPModernClientContext): Record<string, unknown> {
	return {
		[MCP_META_PROTOCOL_VERSION]: context.protocolVersion,
		[MCP_META_CLIENT_INFO]: { name: context.clientInfo.name, version: context.clientInfo.version },
		[MCP_META_CLIENT_CAPABILITIES]: context.capabilities,
	};
}

/** Merge modern `_meta` into request params without clobbering existing keys. */
export function withModernMeta(
	params: Record<string, unknown>,
	context: MCPModernClientContext,
): Record<string, unknown> {
	const existing = params._meta;
	const base = typeof existing === "object" && existing !== null && !Array.isArray(existing) ? existing : {};
	return { ...params, _meta: { ...base, ...buildModernRequestMeta(context) } };
}

// =============================================================================
// Streamable HTTP mirrored headers (modern era)
// =============================================================================

const BASE64_SENTINEL_PREFIX = "=?base64?";
const BASE64_SENTINEL_SUFFIX = "?=";

/** RFC 9110 field-value safe set: visible ASCII, space, and horizontal tab. */
export function isPlainAsciiHeaderValue(value: string): boolean {
	if (value.length === 0) return true;
	// Leading/trailing whitespace forces encoding (intermediaries may trim).
	if (value !== value.trim()) return false;
	for (let i = 0; i < value.length; i++) {
		const code = value.charCodeAt(i);
		if (code === 0x09) continue;
		if (code < 0x21 || code > 0x7e) return false;
	}
	return true;
}

/**
 * Encode a value for `Mcp-Name` / `Mcp-Param-{Name}` headers: plain ASCII when
 * safe, otherwise the `=?base64?<base64-utf8>?=` sentinel. Values already
 * matching the sentinel pattern MUST also be encoded to avoid ambiguity.
 */
export function encodeMcpHeaderValue(value: string): string {
	if (
		isPlainAsciiHeaderValue(value) &&
		!(value.startsWith(BASE64_SENTINEL_PREFIX) && value.endsWith(BASE64_SENTINEL_SUFFIX))
	) {
		return value;
	}
	return `${BASE64_SENTINEL_PREFIX}${Buffer.from(value, "utf8").toString("base64")}${BASE64_SENTINEL_SUFFIX}`;
}

/** HTTP field-name token syntax (RFC 9110 §5.1: 1*tchar). */
const HTTP_FIELD_NAME_PATTERN = /^[!#$%&'*+\-.0-9A-Za-z^_`|~]+$/;

/** Methods whose `params.name` / `params.uri` MUST be mirrored into `Mcp-Name`. */
const MCP_NAME_HEADER_METHODS = new Set(["tools/call", "resources/read", "prompts/get"]);

/**
 * Build the mirrored headers a modern Streamable HTTP request MUST carry:
 * `MCP-Protocol-Version` (must equal the `_meta` version), `Mcp-Method`, and —
 * for `tools/call`, `resources/read`, `prompts/get` — `Mcp-Name`.
 */
export function buildModernMcpHeaders(input: {
	protocolVersion: string;
	method: string;
	params?: Record<string, unknown>;
}): Record<string, string> {
	const headers: Record<string, string> = {
		"MCP-Protocol-Version": input.protocolVersion,
		"Mcp-Method": encodeMcpHeaderValue(input.method),
	};
	if (MCP_NAME_HEADER_METHODS.has(input.method)) {
		const nameValue = input.params?.name ?? input.params?.uri;
		if (typeof nameValue === "string" && nameValue.length > 0) {
			headers["Mcp-Name"] = encodeMcpHeaderValue(nameValue);
		}
	}
	return headers;
}

// =============================================================================
// `x-mcp-header` tool parameter mirroring (modern era, Streamable HTTP)
// =============================================================================

/** A validated binding from a tool inputSchema property to an `Mcp-Param-*` header. */
export interface McpHeaderParamBinding {
	/** Exact property path (chain of `properties` keys) in the call arguments. */
	propertyPath: string[];
	/** The `name` portion of the `Mcp-Param-{name}` header. */
	headerName: string;
	/** Primitive type of the annotated property. */
	propertyType: "string" | "integer" | "boolean";
}

export interface XMcpHeaderBindingsResult {
	bindings: McpHeaderParamBinding[];
	/** Human-readable reasons the tool definition is invalid for HTTP mirroring. */
	violations: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Collect `x-mcp-header` bindings from a tool `inputSchema`, enforcing the
 * specification constraints: field-name token syntax, primitive (non-number)
 * types, case-insensitive uniqueness, and static reachability via `properties`
 * chains only. Any violation invalidates the tool definition for HTTP clients.
 */
export function collectXMcpHeaderBindings(inputSchema: unknown): XMcpHeaderBindingsResult {
	const bindings: McpHeaderParamBinding[] = [];
	const violations: string[] = [];
	const seenHeaderNames = new Set<string>();

	const walk = (schema: unknown, path: string[]): void => {
		if (!isRecord(schema)) return;
		const annotation = schema["x-mcp-header"];
		if (annotation !== undefined) {
			const label = path.length > 0 ? path.join(".") : "(root)";
			if (typeof annotation !== "string" || annotation.length === 0) {
				violations.push(`x-mcp-header on "${label}" must be a non-empty string`);
			} else if (!HTTP_FIELD_NAME_PATTERN.test(annotation)) {
				violations.push(`x-mcp-header "${annotation}" on "${label}" is not a valid HTTP field-name token`);
			} else if (seenHeaderNames.has(annotation.toLowerCase())) {
				violations.push(`x-mcp-header "${annotation}" is not case-insensitively unique`);
			} else {
				const type = schema.type;
				if (type !== "string" && type !== "integer" && type !== "boolean") {
					violations.push(
						`x-mcp-header "${annotation}" on "${label}" requires a primitive type (string, integer, boolean)`,
					);
				} else if (path.length === 0) {
					violations.push(`x-mcp-header "${annotation}" must annotate a property, not the schema root`);
				} else {
					seenHeaderNames.add(annotation.toLowerCase());
					bindings.push({ propertyPath: path, headerName: annotation, propertyType: type });
				}
			}
		}
		// Only `properties` chains are statically reachable; anything annotated
		// under items/composition/conditional keywords is unreachable and invalid
		// by construction (we simply never descend there, so such annotations are
		// ignored rather than mirrored).
		if (isRecord(schema.properties)) {
			for (const [key, subschema] of Object.entries(schema.properties)) {
				walk(subschema, [...path, key]);
			}
		}
	};

	walk(inputSchema, []);
	return { bindings, violations };
}

/**
 * Extract `Mcp-Param-{name}` headers from tool call arguments per validated
 * bindings. Missing or null values omit the header, per the specification.
 */
export function buildXMcpParamHeaders(
	bindings: readonly McpHeaderParamBinding[],
	args: Record<string, unknown>,
): Record<string, string> {
	const headers: Record<string, string> = {};
	for (const binding of bindings) {
		let value: unknown = args;
		for (const key of binding.propertyPath) {
			if (!isRecord(value)) {
				value = undefined;
				break;
			}
			value = value[key];
		}
		if (value === undefined || value === null) continue;
		let text: string;
		switch (binding.propertyType) {
			case "string":
				if (typeof value !== "string") continue;
				text = value;
				break;
			case "integer":
				if (typeof value !== "number" || !Number.isSafeInteger(value)) continue;
				text = String(value);
				break;
			case "boolean":
				if (typeof value !== "boolean") continue;
				text = value ? "true" : "false";
				break;
		}
		headers[`Mcp-Param-${binding.headerName}`] = encodeMcpHeaderValue(text);
	}
	return headers;
}

// =============================================================================
// Era detection (Streamable HTTP backward compatibility)
// =============================================================================

/** Failure classes for a modern probe request. */
export type MCPProbeFailureClass =
	/** Recognized modern JSON-RPC error: the server speaks a modern revision. */
	| "modern-error"
	/** 4xx without a recognized modern error body: legacy-era server signal. */
	| "legacy-signal"
	/** 401/403 (and WWW-Authenticate challenges): never a downgrade signal. */
	| "auth-failure"
	/** Anything else (5xx, network, malformed payload): not a downgrade signal. */
	| "other-failure";

export interface MCPProbeClassification {
	class: MCPProbeFailureClass;
	/** Protocol-defined modern error code when recognized. */
	modernErrorCode?: number;
	/** `data.supported` from an UnsupportedProtocolVersionError, when present. */
	supportedVersions?: string[];
	/** `data.requested` from an UnsupportedProtocolVersionError, when present. */
	requestedVersion?: string;
}

function isModernErrorCode(code: number): boolean {
	return (
		code === MCP_ERROR_HEADER_MISMATCH ||
		code === MCP_ERROR_MISSING_REQUIRED_CLIENT_CAPABILITY ||
		code === MCP_ERROR_UNSUPPORTED_PROTOCOL_VERSION
	);
}

/**
 * Classify a failed modern probe per the specification's era-detection rules:
 * recognized modern JSON-RPC errors identify a modern server; a 400/404/405
 * without one identifies a legacy server; auth and security failures are never
 * era signals and must never authorize a downgrade.
 */
export function classifyMcpProbeFailure(status: number, parsedBody: unknown): MCPProbeClassification {
	if (status === 401 || status === 403) {
		return { class: "auth-failure" };
	}

	let errorCode: number | undefined;
	let errorData: unknown;
	if (isRecord(parsedBody) && isRecord(parsedBody.error)) {
		if (typeof parsedBody.error.code === "number") errorCode = parsedBody.error.code;
		errorData = parsedBody.error.data;
	}

	if (errorCode !== undefined && isModernErrorCode(errorCode)) {
		const classification: MCPProbeClassification = { class: "modern-error", modernErrorCode: errorCode };
		if (errorCode === MCP_ERROR_UNSUPPORTED_PROTOCOL_VERSION && isRecord(errorData)) {
			if (Array.isArray(errorData.supported) && errorData.supported.every(v => typeof v === "string")) {
				classification.supportedVersions = errorData.supported as string[];
			}
			if (typeof errorData.requested === "string") classification.requestedVersion = errorData.requested;
		}
		return classification;
	}

	// A modern server reports unknown methods as 404 + -32601; that pairing is
	// itself a modern-era signal (legacy HTTP+SSE 404s carry no JSON-RPC body).
	if (status === 404 && errorCode === JSONRPC_ERROR_METHOD_NOT_FOUND) {
		return { class: "modern-error", modernErrorCode: errorCode };
	}

	if (status === 400 || status === 404 || status === 405) {
		return { class: "legacy-signal" };
	}

	return { class: "other-failure" };
}

// =============================================================================
// Authoritative protocol observation model
// =============================================================================

/** Lifecycle state of a protocol feature, mirroring the specification's feature lifecycle. */
export type MCPFeatureLifecycle = "active" | "deprecated" | "removed";

export interface MCPProtocolFeatureState {
	feature: string;
	lifecycle: MCPFeatureLifecycle;
	/** Secret-free explanation shown in diagnostics. */
	note?: string;
}

/** How the effective era/version was reached. */
export type MCPNegotiationState =
	/** No negotiation attempt has completed yet. */
	| "pending"
	/** Modern era confirmed (probe or direct modern request succeeded). */
	| "modern"
	/** Modern era after selecting a mutually supported version from UnsupportedProtocolVersionError. */
	| "modern-version-retry"
	/** Legacy era via era detection (legacy server signal) under `auto`. */
	| "legacy-fallback"
	/** Legacy era because configuration forced it (`legacy`) or the transport is stdio. */
	| "legacy-forced"
	/** Negotiation failed; the connection could not be established. */
	| "failed";

/** Machine-readable reasons a legacy fallback was engaged (never auth/security driven). */
export type MCPDowngradeReason =
	/** `protocol: "legacy"` configured explicitly. */
	| "preference-legacy"
	/** stdio transport has no per-request HTTP signals; legacy handshake retained. */
	| "stdio-transport"
	/** Probe returned 400/404/405 without a recognized modern error body. */
	| "legacy-server-signal"
	/** A modern server advertised only legacy-era versions in `supported`. */
	| "server-advertised-legacy-only";

/**
 * One authoritative, secret-free observation of a server's negotiated protocol
 * state. Consumed by `/extensions` (#4291) and customization doctor (#4288);
 * contains no credentials, tokens, metadata documents, or header values.
 */
export interface MCPProtocolObservation {
	/** Configured preference (defaults to `auto`). */
	preference: MCPProtocolPreference;
	/** Effective protocol version in use, once negotiated. */
	effectiveVersion: string | null;
	/** Effective era, once negotiated. */
	era: MCPProtocolEra | null;
	/** How the effective state was reached. */
	negotiation: MCPNegotiationState;
	/** Why a legacy fallback engaged; null unless `negotiation` is a legacy state. */
	downgradeReason: MCPDowngradeReason | null;
	/** Versions the server advertised (via server/discover or version errors). */
	supportedVersions: string[];
	/** Self-reported server identity (display only; never security-relevant). */
	serverInfo: { name: string; version: string } | null;
	/** Lifecycle visibility for protocol features (legacy session behavior, etc). */
	features: MCPProtocolFeatureState[];
	/** v2 capability state observed for this connection. */
	capabilities: {
		/** server/discover answered (optional per spec; absence does not block calls). */
		discover: "yes" | "no" | "unknown";
		/** Server advertised tools capability. */
		tools: boolean;
		/** Server advertised resources capability. */
		resources: boolean;
		/** Server advertised prompts capability. */
		prompts: boolean;
	};
}

/** Initial observation before negotiation completes. */
export function createMCPProtocolObservation(preference: MCPProtocolPreference): MCPProtocolObservation {
	return {
		preference,
		effectiveVersion: null,
		era: null,
		negotiation: "pending",
		downgradeReason: null,
		supportedVersions: [],
		serverInfo: null,
		features: [],
		capabilities: { discover: "unknown", tools: false, resources: false, prompts: false },
	};
}

/** Legacy session/transport features reported as deprecated under the feature lifecycle. */
export function legacyEraFeatureStates(): MCPProtocolFeatureState[] {
	return [
		{
			feature: "initialize-handshake",
			lifecycle: "deprecated",
			note: "Connection-scoped initialize/initialized handshake; removed from the core request path in 2026-07-28",
		},
		{
			feature: "mcp-session-id",
			lifecycle: "deprecated",
			note: "Protocol-level Mcp-Session-Id sessions; not part of 2026-07-28",
		},
		{
			feature: "standalone-sse-stream",
			lifecycle: "deprecated",
			note: "GET-opened standalone SSE stream; removed in 2026-07-28 (subscriptions/listen replaces it)",
		},
		{
			feature: "sse-resumability",
			lifecycle: "deprecated",
			note: "Last-Event-ID stream replay; unsupported in 2026-07-28",
		},
	];
}

/** Finalize an observation for a negotiated modern connection. */
export function modernEraObservation(input: {
	preference: MCPProtocolPreference;
	effectiveVersion: string;
	negotiation: "modern" | "modern-version-retry";
	supportedVersions?: string[];
	serverInfo?: { name: string; version: string } | null;
	capabilities?: { tools?: boolean; resources?: boolean; prompts?: boolean };
	discover: "yes" | "no" | "unknown";
}): MCPProtocolObservation {
	return {
		preference: input.preference,
		effectiveVersion: input.effectiveVersion,
		era: "modern",
		negotiation: input.negotiation,
		downgradeReason: null,
		supportedVersions: input.supportedVersions ?? [],
		serverInfo: input.serverInfo ?? null,
		features: [],
		capabilities: {
			discover: input.discover,
			tools: input.capabilities?.tools ?? false,
			resources: input.capabilities?.resources ?? false,
			prompts: input.capabilities?.prompts ?? false,
		},
	};
}

/** Finalize an observation for a negotiated legacy connection. */
export function legacyEraObservation(input: {
	preference: MCPProtocolPreference;
	effectiveVersion: string;
	negotiation: "legacy-fallback" | "legacy-forced";
	downgradeReason: MCPDowngradeReason;
	serverInfo?: { name: string; version: string } | null;
	capabilities?: { tools?: boolean; resources?: boolean; prompts?: boolean };
}): MCPProtocolObservation {
	return {
		preference: input.preference,
		effectiveVersion: input.effectiveVersion,
		era: "legacy",
		negotiation: input.negotiation,
		downgradeReason: input.downgradeReason,
		supportedVersions: [],
		serverInfo: input.serverInfo ?? null,
		features: legacyEraFeatureStates(),
		capabilities: {
			discover: "no",
			tools: input.capabilities?.tools ?? false,
			resources: input.capabilities?.resources ?? false,
			prompts: input.capabilities?.prompts ?? false,
		},
	};
}

// =============================================================================
// Caching hints (server/discover and catalog results)
// =============================================================================

/** Cache scope hint: public results may cross authorization contexts; private must not. */
export type MCPCacheScope = "public" | "private";

/** Server-supplied caching hints carried on cacheable `complete` results. */
export interface MCPCacheHints {
	/** Milliseconds the result may be considered fresh; absent/negative means 0. */
	ttlMs?: number;
	cacheScope?: MCPCacheScope;
}

/** Normalize raw hints: negative ttlMs is treated as 0 per the specification. */
export function normalizeMcpCacheHints(raw: unknown): MCPCacheHints | undefined {
	if (!isRecord(raw)) return undefined;
	const hints: MCPCacheHints = {};
	if (typeof raw.ttlMs === "number" && Number.isFinite(raw.ttlMs)) {
		hints.ttlMs = Math.max(0, raw.ttlMs);
	}
	if (raw.cacheScope === "public" || raw.cacheScope === "private") {
		hints.cacheScope = raw.cacheScope;
	}
	return hints.ttlMs === undefined && hints.cacheScope === undefined ? undefined : hints;
}

// =============================================================================
// MRTR (multi round-trip requests)
// =============================================================================

/** Result type marker for interim input requests. */
export const MCP_RESULT_TYPE_INPUT_REQUIRED = "input_required";
export const MCP_RESULT_TYPE_COMPLETE = "complete";

/** Input request methods a server may embed in an InputRequiredResult. */
export const MCP_INPUT_REQUEST_METHODS = new Set(["elicitation/create", "sampling/createMessage", "roots/list"]);

export interface MCPInputRequiredData {
	inputRequests: Record<string, { method: string; params?: Record<string, unknown> }>;
	requestState?: string;
}

/**
 * Extract MRTR input data from a JSON-RPC result. Returns null when the result
 * is a normal `complete` result (including legacy results with no resultType,
 * which the specification requires clients to treat as `"complete"`).
 * Throws on a malformed `input_required` payload.
 */
export function extractMcpInputRequired(result: unknown): MCPInputRequiredData | null {
	if (!isRecord(result)) return null;
	const resultType = result.resultType;
	if (resultType === undefined || resultType === MCP_RESULT_TYPE_COMPLETE) return null;
	if (resultType !== MCP_RESULT_TYPE_INPUT_REQUIRED) {
		// Unrecognized resultType values are invalid per the specification.
		throw new Error(`MCP result has unrecognized resultType "${String(resultType)}"`);
	}
	const inputRequests = Object.create(null) as MCPInputRequiredData["inputRequests"];
	if (result.inputRequests !== undefined) {
		if (!isRecord(result.inputRequests)) {
			throw new Error("MCP input_required result has malformed inputRequests");
		}
		for (const [key, value] of Object.entries(result.inputRequests)) {
			if (!isRecord(value) || typeof value.method !== "string" || !MCP_INPUT_REQUEST_METHODS.has(value.method)) {
				throw new Error(`MCP input_required request "${key}" is not a supported input request`);
			}
			inputRequests[key] = {
				method: value.method,
				...(isRecord(value.params) ? { params: value.params } : {}),
			};
		}
	}
	let requestState: string | undefined;
	if (result.requestState !== undefined) {
		if (typeof result.requestState !== "string") {
			throw new Error("MCP input_required result has non-string requestState");
		}
		requestState = result.requestState;
	}
	if (Object.keys(inputRequests).length === 0 && requestState === undefined) {
		throw new Error("MCP input_required result carries neither inputRequests nor requestState");
	}
	return { inputRequests, ...(requestState === undefined ? {} : { requestState }) };
}
