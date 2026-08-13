import { describe, expect, it } from "bun:test";
import {
	buildModernMcpHeaders,
	buildModernRequestMeta,
	buildXMcpParamHeaders,
	classifyMcpProbeFailure,
	collectXMcpHeaderBindings,
	createMCPProtocolObservation,
	encodeMcpHeaderValue,
	extractMcpInputRequired,
	isMCPProtocolPreference,
	isModernProtocolVersion,
	legacyEraObservation,
	MCP_ERROR_HEADER_MISMATCH,
	MCP_ERROR_MISSING_REQUIRED_CLIENT_CAPABILITY,
	MCP_ERROR_UNSUPPORTED_PROTOCOL_VERSION,
	MCP_META_CLIENT_CAPABILITIES,
	MCP_META_CLIENT_INFO,
	MCP_META_PROTOCOL_VERSION,
	MCP_PROTOCOL_VERSION_2026_07_28,
	modernEraObservation,
	normalizeMcpCacheHints,
	resolveMCPProtocolPreference,
	withModernMeta,
} from "./protocol";

const CONTEXT = {
	protocolVersion: MCP_PROTOCOL_VERSION_2026_07_28,
	clientInfo: { name: "gjc-coding-agent", version: "1.0.0" },
	capabilities: { roots: { listChanged: true } },
};

describe("protocol preference", () => {
	it("accepts exactly the documented preferences", () => {
		expect(isMCPProtocolPreference("auto")).toBe(true);
		expect(isMCPProtocolPreference("2026-07-28")).toBe(true);
		expect(isMCPProtocolPreference("legacy")).toBe(true);
		expect(isMCPProtocolPreference("2025-03-26")).toBe(false);
		expect(isMCPProtocolPreference("modern")).toBe(false);
		expect(isMCPProtocolPreference(undefined)).toBe(false);
		expect(isMCPProtocolPreference(42)).toBe(false);
	});

	it("resolves an unset preference to auto", () => {
		expect(resolveMCPProtocolPreference(undefined)).toBe("auto");
		expect(resolveMCPProtocolPreference("legacy")).toBe("legacy");
	});

	it("classifies modern protocol versions by date boundary", () => {
		expect(isModernProtocolVersion("2026-07-28")).toBe(true);
		expect(isModernProtocolVersion("2026-11-01")).toBe(true);
		expect(isModernProtocolVersion("2025-11-25")).toBe(false);
		expect(isModernProtocolVersion("2025-03-26")).toBe(false);
	});
});

describe("modern per-request _meta", () => {
	it("carries protocol version, client info, and client capabilities", () => {
		const meta = buildModernRequestMeta(CONTEXT);
		expect(meta[MCP_META_PROTOCOL_VERSION]).toBe(MCP_PROTOCOL_VERSION_2026_07_28);
		expect(meta[MCP_META_CLIENT_INFO]).toEqual({ name: "gjc-coding-agent", version: "1.0.0" });
		expect(meta[MCP_META_CLIENT_CAPABILITIES]).toEqual({ roots: { listChanged: true } });
	});

	it("merges without clobbering existing _meta keys", () => {
		const merged = withModernMeta({ name: "tool", _meta: { progressToken: "tok-1" } }, CONTEXT);
		const meta = merged._meta as Record<string, unknown>;
		expect(meta.progressToken).toBe("tok-1");
		expect(meta[MCP_META_PROTOCOL_VERSION]).toBe(MCP_PROTOCOL_VERSION_2026_07_28);
	});
});

describe("mirrored header encoding", () => {
	it("passes plain ASCII through unchanged", () => {
		expect(encodeMcpHeaderValue("tools/call")).toBe("tools/call");
		expect(encodeMcpHeaderValue("my-tool_1.2")).toBe("my-tool_1.2");
	});

	it("encodes non-ASCII with the base64 sentinel", () => {
		const encoded = encodeMcpHeaderValue("검색");
		expect(encoded.startsWith("=?base64?")).toBe(true);
		expect(encoded.endsWith("?=")).toBe(true);
		const inner = encoded.slice("=?base64?".length, -"?=".length);
		expect(Buffer.from(inner, "base64").toString("utf8")).toBe("검색");
	});

	it("encodes values that already look like the sentinel to avoid ambiguity", () => {
		const value = "=?base64?AAAA?=";
		expect(encodeMcpHeaderValue(value)).not.toBe(value);
	});

	it("encodes values with leading/trailing whitespace", () => {
		expect(encodeMcpHeaderValue(" padded")).toMatch(/^=\?base64\?/);
	});
});

describe("buildModernMcpHeaders", () => {
	it("mirrors protocol version and method on every request", () => {
		const headers = buildModernMcpHeaders({ protocolVersion: MCP_PROTOCOL_VERSION_2026_07_28, method: "tools/list" });
		expect(headers["MCP-Protocol-Version"]).toBe(MCP_PROTOCOL_VERSION_2026_07_28);
		expect(headers["Mcp-Method"]).toBe("tools/list");
		expect(headers["Mcp-Name"]).toBeUndefined();
	});

	it("mirrors params.name into Mcp-Name for tools/call and prompts/get", () => {
		expect(
			buildModernMcpHeaders({
				protocolVersion: MCP_PROTOCOL_VERSION_2026_07_28,
				method: "tools/call",
				params: { name: "search" },
			})["Mcp-Name"],
		).toBe("search");
		expect(
			buildModernMcpHeaders({
				protocolVersion: MCP_PROTOCOL_VERSION_2026_07_28,
				method: "prompts/get",
				params: { name: "greet" },
			})["Mcp-Name"],
		).toBe("greet");
	});

	it("mirrors params.uri into Mcp-Name for resources/read", () => {
		const headers = buildModernMcpHeaders({
			protocolVersion: MCP_PROTOCOL_VERSION_2026_07_28,
			method: "resources/read",
			params: { uri: "file:///doc" },
		});
		expect(headers["Mcp-Name"]).toBe("file:///doc");
	});

	it("base64-encodes a non-ASCII Mcp-Name", () => {
		const headers = buildModernMcpHeaders({
			protocolVersion: MCP_PROTOCOL_VERSION_2026_07_28,
			method: "tools/call",
			params: { name: "検索" },
		});
		expect(headers["Mcp-Name"]).toMatch(/^=\?base64\?.+\?=$/);
	});
});

describe("x-mcp-header bindings", () => {
	it("collects validated primitive bindings with property paths", () => {
		const { bindings, violations } = collectXMcpHeaderBindings({
			type: "object",
			properties: {
				tenant: { type: "string", "x-mcp-header": "Tenant-Id" },
				retries: { type: "integer", "x-mcp-header": "X-Retries" },
				flag: { type: "boolean", "x-mcp-header": "X-Flag" },
				nested: { type: "object", properties: { inner: { type: "string", "x-mcp-header": "X-Inner" } } },
			},
		});
		expect(violations).toEqual([]);
		expect(bindings).toEqual([
			{ propertyPath: ["tenant"], headerName: "Tenant-Id", propertyType: "string" },
			{ propertyPath: ["retries"], headerName: "X-Retries", propertyType: "integer" },
			{ propertyPath: ["flag"], headerName: "X-Flag", propertyType: "boolean" },
			{ propertyPath: ["nested", "inner"], headerName: "X-Inner", propertyType: "string" },
		]);
	});

	it("rejects invalid field-name tokens, non-primitives, and duplicate names", () => {
		const { violations } = collectXMcpHeaderBindings({
			type: "object",
			properties: {
				bad: { type: "string", "x-mcp-header": "has space" },
				nonPrimitive: { type: "number", "x-mcp-header": "X-Num" },
				arr: { type: "array", "x-mcp-header": "X-Arr" },
				dupA: { type: "string", "x-mcp-header": "X-Dup" },
				dupB: { type: "string", "x-mcp-header": "x-dup" },
			},
		});
		expect(violations).toHaveLength(4);
		expect(violations.join("\n")).toMatch(/not a valid HTTP field-name token/);
		expect(violations.join("\n")).toMatch(/primitive type/);
		expect(violations.join("\n")).toMatch(/case-insensitively unique/);
	});

	it("rejects annotations on the schema root", () => {
		const { bindings, violations } = collectXMcpHeaderBindings({ type: "string", "x-mcp-header": "Root" });
		expect(bindings).toEqual([]);
		expect(violations).toEqual(['x-mcp-header "Root" must annotate a property, not the schema root']);
	});

	it("builds Mcp-Param headers from args, omitting missing, null, and mistyped values", () => {
		const { bindings } = collectXMcpHeaderBindings({
			type: "object",
			properties: {
				tenant: { type: "string", "x-mcp-header": "Tenant-Id" },
				retries: { type: "integer", "x-mcp-header": "X-Retries" },
				flag: { type: "boolean", "x-mcp-header": "X-Flag" },
				nested: { type: "object", properties: { inner: { type: "string", "x-mcp-header": "X-Inner" } } },
			},
		});
		expect(
			buildXMcpParamHeaders(bindings, {
				tenant: "acme",
				retries: 3,
				flag: false,
				nested: { inner: "deep" },
			}),
		).toEqual({
			"Mcp-Param-Tenant-Id": "acme",
			"Mcp-Param-X-Retries": "3",
			"Mcp-Param-X-Flag": "false",
			"Mcp-Param-X-Inner": "deep",
		});
		expect(buildXMcpParamHeaders(bindings, { tenant: null, retries: 1.5, flag: "yes" })).toEqual({});
	});
});

describe("era detection classification", () => {
	it("never treats 401/403 as a downgrade signal", () => {
		expect(classifyMcpProbeFailure(401, undefined).class).toBe("auth-failure");
		expect(classifyMcpProbeFailure(403, { error: { code: -32022 } }).class).toBe("auth-failure");
	});

	it("recognizes modern protocol errors with supported-version data", () => {
		const result = classifyMcpProbeFailure(400, {
			error: {
				code: MCP_ERROR_UNSUPPORTED_PROTOCOL_VERSION,
				data: { supported: ["2026-07-28"], requested: "2026-07-28" },
			},
		});
		expect(result.class).toBe("modern-error");
		expect(result.modernErrorCode).toBe(MCP_ERROR_UNSUPPORTED_PROTOCOL_VERSION);
		expect(result.supportedVersions).toEqual(["2026-07-28"]);
		expect(result.requestedVersion).toBe("2026-07-28");
	});

	it("recognizes header-mismatch and capability errors as modern", () => {
		expect(classifyMcpProbeFailure(400, { error: { code: MCP_ERROR_HEADER_MISMATCH } }).class).toBe("modern-error");
		expect(
			classifyMcpProbeFailure(400, { error: { code: MCP_ERROR_MISSING_REQUIRED_CLIENT_CAPABILITY } }).class,
		).toBe("modern-error");
	});

	it("treats 404 + -32601 as a modern unknown-method signal", () => {
		const result = classifyMcpProbeFailure(404, { error: { code: -32601 } });
		expect(result.class).toBe("modern-error");
		expect(result.modernErrorCode).toBe(-32601);
	});

	it("treats bare 400/404/405 as legacy signals and 5xx as non-signals", () => {
		expect(classifyMcpProbeFailure(400, "not json").class).toBe("legacy-signal");
		expect(classifyMcpProbeFailure(404, undefined).class).toBe("legacy-signal");
		expect(classifyMcpProbeFailure(405, {}).class).toBe("legacy-signal");
		expect(classifyMcpProbeFailure(500, undefined).class).toBe("other-failure");
	});
});

describe("protocol observation model", () => {
	it("starts pending with no effective state", () => {
		const observation = createMCPProtocolObservation("auto");
		expect(observation).toMatchObject({
			preference: "auto",
			effectiveVersion: null,
			era: null,
			negotiation: "pending",
			downgradeReason: null,
		});
	});

	it("finalizes modern observations without downgrade metadata", () => {
		const observation = modernEraObservation({
			preference: "2026-07-28",
			effectiveVersion: MCP_PROTOCOL_VERSION_2026_07_28,
			negotiation: "modern",
			supportedVersions: ["2026-07-28"],
			serverInfo: { name: "srv", version: "1" },
			capabilities: { tools: true },
			discover: "yes",
		});
		expect(observation).toMatchObject({
			era: "modern",
			negotiation: "modern",
			downgradeReason: null,
			supportedVersions: ["2026-07-28"],
			capabilities: { discover: "yes", tools: true, resources: false, prompts: false },
		});
	});

	it("finalizes legacy observations with deprecation lifecycle visibility", () => {
		const observation = legacyEraObservation({
			preference: "auto",
			effectiveVersion: "2025-03-26",
			negotiation: "legacy-fallback",
			downgradeReason: "legacy-server-signal",
			serverInfo: { name: "old", version: "1" },
			capabilities: { tools: true },
		});
		expect(observation.era).toBe("legacy");
		expect(observation.downgradeReason).toBe("legacy-server-signal");
		const features = observation.features.map(feature => feature.feature);
		expect(features).toContain("initialize-handshake");
		expect(features).toContain("mcp-session-id");
		expect(features).toContain("standalone-sse-stream");
		expect(observation.features.every(feature => feature.lifecycle === "deprecated")).toBe(true);
		// Secret-free by construction: plain JSON with no credential material.
		expect(JSON.stringify(observation)).not.toMatch(/authorization|token|secret|bearer/i);
	});
});

describe("cache hints", () => {
	it("normalizes ttlMs and cacheScope, clamping negative ttlMs to zero", () => {
		expect(normalizeMcpCacheHints({ ttlMs: 5000, cacheScope: "private" })).toEqual({
			ttlMs: 5000,
			cacheScope: "private",
		});
		expect(normalizeMcpCacheHints({ ttlMs: -10 })).toEqual({ ttlMs: 0 });
		expect(normalizeMcpCacheHints({ ttlMs: "soon" })).toBeUndefined();
		expect(normalizeMcpCacheHints({ cacheScope: "everything" })).toBeUndefined();
		expect(normalizeMcpCacheHints(undefined)).toBeUndefined();
		expect(normalizeMcpCacheHints({})).toBeUndefined();
	});
});

describe("MRTR input_required extraction", () => {
	it("extracts input requests and the opaque requestState", () => {
		const extracted = extractMcpInputRequired({
			resultType: "input_required",
			requestState: "opaque-blob",
			inputRequests: {
				elicit1: { method: "elicitation/create", params: { message: "pick" } },
			},
		});
		expect(extracted).toEqual({
			requestState: "opaque-blob",
			inputRequests: { elicit1: { method: "elicitation/create", params: { message: "pick" } } },
		});
	});

	it("returns null for complete results and results without a resultType", () => {
		expect(extractMcpInputRequired({ resultType: "complete", content: [] })).toBeNull();
		expect(extractMcpInputRequired({ content: [] })).toBeNull();
		expect(extractMcpInputRequired("input_required")).toBeNull();
	});

	it("throws on malformed input_required payloads (fail closed)", () => {
		expect(() =>
			extractMcpInputRequired({
				resultType: "input_required",
				inputRequests: { bad: { method: "admin/deleteEverything" } },
			}),
		).toThrow(/not a supported input request/);
		expect(() => extractMcpInputRequired({ resultType: "input_required" })).toThrow(
			/neither inputRequests nor requestState/,
		);
		expect(() => extractMcpInputRequired({ resultType: "input_required", requestState: { opaque: 1 } })).toThrow(
			/non-string requestState/,
		);
		expect(() => extractMcpInputRequired({ resultType: "surprise" })).toThrow(/unrecognized resultType/);
	});
});
