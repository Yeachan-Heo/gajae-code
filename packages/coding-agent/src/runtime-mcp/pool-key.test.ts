import { describe, expect, test } from "bun:test";
import { buildMCPPoolKeyIdentity, canonicalizeMCPEndpoint, computeMCPPoolKey, MCPPoolConfigError } from "./pool-key";
import type { MCPHttpServerConfig, MCPServerConfig, MCPStdioServerConfig } from "./types";

const stdio = (overrides: Partial<MCPStdioServerConfig> = {}): MCPServerConfig => ({
	type: "stdio",
	command: "node",
	args: ["server.js"],
	...overrides,
});

const http = (url: string, overrides: Partial<MCPHttpServerConfig> = {}): MCPServerConfig => ({
	type: "http",
	url,
	...overrides,
});

const key = (config: MCPServerConfig, options: Parameters<typeof computeMCPPoolKey>[2] = {}) =>
	computeMCPPoolKey("server", config, { sessionId: "session-a", ...options });

describe("MCP C5 pool identity", () => {
	test("partitions each pool identity field", () => {
		const base = stdio({ env: { A: "1" }, cwd: ".", noInheritEnv: true });
		const variants: MCPServerConfig[] = [
			stdio({ cwd: "/tmp" }),
			stdio({ args: ["server.js", "--other"] }),
			stdio({ env: { A: "2" }, noInheritEnv: true }),
			stdio({ noInheritEnv: false }),
			{ ...base, type: "http", url: "https://example.test/mcp" },
			stdio({}),
		];
		const keys = [
			key(base),
			key(variants[0], { effectiveCwd: "/tmp" }),
			key(variants[1]),
			key(variants[2]),
			key(variants[3]),
			key(variants[4]),
			key(base, { capabilityProfile: "tools-only" }),
		];
		expect(new Set(keys).size).toBe(keys.length);
		expect(key(base, { sharingMode: "shared", sessionId: "session-a" })).not.toBe(
			key(base, { sharingMode: "per-session", sessionId: "session-a" }),
		);
		expect(key(base, { sessionId: "session-b" })).not.toBe(key(base, { sessionId: "session-a" }));
		expect(key(base, { pluginNetworkPolicyId: "restricted" })).not.toBe(key(base));
		expect(key(base, { authBindingKind: "oauth", authScopeId: "scope-a" })).not.toBe(key(base));
		expect(key(http("https://h/mcp", { headers: { "X-Test": "one" } }))).not.toBe(
			key(http("https://h/mcp", { headers: { "X-Test": "two" } })),
		);
	});
	test("partitions auth binding, auth scope, transport, and every remaining C5 discriminator", () => {
		const base = http("https://h/mcp", { auth: { type: "oauth", credentialId: "scope-a" } });
		expect(key(base, { authBindingKind: "oauth", authScopeId: "scope-a" })).not.toBe(
			key(base, { authBindingKind: "apikey", authScopeId: "scope-a" }),
		);
		expect(key(base, { authBindingKind: "oauth", authScopeId: "scope-a" })).not.toBe(
			key(base, { authBindingKind: "oauth", authScopeId: "scope-b" }),
		);
		expect(key(base, { capabilityProfile: "roots" })).not.toBe(key(base, { capabilityProfile: "tools-only" }));
		expect(key(base, { pluginNetworkPolicyId: "default" })).not.toBe(
			key(base, { pluginNetworkPolicyId: "isolated" }),
		);
		expect(key(base, { sharingMode: "per-session" })).not.toBe(key(base, { sharingMode: "shared" }));
		expect(key(base, { sessionId: "session-a" })).not.toBe(key(base, { sessionId: "session-b" }));
		expect(key(base)).not.toBe(key({ type: "sse", url: "https://h/mcp" }));
	});
	test("partitions server name and command", () => {
		expect(computeMCPPoolKey("server-a", stdio(), { sessionId: "s" })).not.toBe(
			computeMCPPoolKey("server-b", stdio(), { sessionId: "s" }),
		);
		expect(key(stdio({ command: "node" }))).not.toBe(key(stdio({ command: "deno" })));
	});

	test("uses an empty endpoint sentinel for stdio", () => {
		expect(buildMCPPoolKeyIdentity("server", stdio(), { sessionId: "s" }).endpointIdentity).toBe("");
	});

	test("preserves endpoint distinctions", () => {
		const distinct = [
			["https://h/mcp", "https://h/mcp/"],
			["https://h/a%2Fb", "https://h/a/b"],
			["https://h/x?a=1&b=2", "https://h/x?b=2&a=1"],
			["https://h/x?a=1&a=2", "https://h/x?a=2&a=1"],
			["https://h/x?a=", "https://h/x?a"],
			["https://h/x?a", "https://h/x"],
			["https://h/~x", "https://h/%7Ex"],
		];
		for (const [left, right] of distinct) expect(key(http(left))).not.toBe(key(http(right)));
	});

	test("S7-style one-host endpoint partitions preserve path and query identity", () => {
		const endpoints = [
			"http://127.0.0.1:43123/mcp/alpha?tenant=one&cursor=1",
			"http://127.0.0.1:43123/mcp/beta?tenant=one&cursor=1",
			"http://127.0.0.1:43123/mcp/alpha?cursor=1&tenant=one",
			"http://127.0.0.1:43123/mcp/alpha?tenant=one&tenant=one",
		];
		const keys = endpoints.map(endpoint => key(http(endpoint)));
		expect(new Set(keys).size).toBe(endpoints.length);
	});

	test("normalizes only universally equivalent endpoint forms", () => {
		const equivalent = [
			["HTTPS://Host.Example/x", "https://host.example/x"],
			["https://h/x", "https://h:443/x"],
			["https://münich.example/x", "https://xn--mnich-kva.example/x"],
			["https://h/a%2fb", "https://h/a%2Fb"],
		];
		for (const [left, right] of equivalent) expect(key(http(left))).toBe(key(http(right)));
	});

	test("hashes the configured query text without URLSearchParams round-tripping", () => {
		const endpoint = canonicalizeMCPEndpoint("https://h/x?a=1&a=2&empty=&bare&encoded=%2f");
		expect(endpoint.queryIdentityInput).toBe("a=1&a=2&empty=&bare&encoded=%2F");
		expect(endpoint.queryHash).toBeDefined();
	});

	test("authorization token rotation does not repartition", () => {
		const config = http("https://h/mcp", { auth: { type: "oauth", credentialId: "credential-a" } });
		const first = key(config, {
			effectiveHeaders: { Authorization: "Bearer old-token" },
			authBindingKind: "oauth",
			authScopeId: "credential-a",
		});
		const rotated = key(config, {
			effectiveHeaders: { Authorization: "Bearer new-token" },
			authBindingKind: "oauth",
			authScopeId: "credential-a",
		});
		expect(rotated).toBe(first);
	});

	test("plain credential-free env/header rotation remains partitioning per C5", () => {
		// This is contract-conformant behavior, not a defect: only Authorization rotates out of identity.
		expect(key(stdio(), { effectiveEnv: { PATH: "one" } })).not.toBe(key(stdio(), { effectiveEnv: { PATH: "two" } }));
		expect(key(http("https://h/mcp"), { effectiveHeaders: { "X-Test": "one" } })).not.toBe(
			key(http("https://h/mcp"), { effectiveHeaders: { "X-Test": "two" } }),
		);
	});

	test("authorization value is ignored even without an auth binding", () => {
		const config = http("https://h/mcp");
		const first = key(config, { effectiveHeaders: { Authorization: "Bearer old-token" } });
		const rotated = key(config, { effectiveHeaders: { authorization: "Bearer new-token" } });
		expect(rotated).toBe(first);
	});

	test("shared Authorization requires non-secret binding metadata", () => {
		const config = http("https://h/mcp", { sharing: "shared", headers: { Authorization: "Bearer tenant-a" } });
		expect(() => key(config, { sharingMode: "shared" })).toThrow(MCPPoolConfigError);
		try {
			key(config, { sharingMode: "shared" });
		} catch (error) {
			expect(error).toMatchObject({ code: "MCP_AUTH_BINDING_REQUIRED", name: "MCPPoolConfigError" });
		}
	});

	test("rejects duplicate case-insensitive header names", () => {
		expect(() => key(http("https://h/mcp", { headers: { Authorization: "one", authorization: "two" } }))).toThrow(
			MCPPoolConfigError,
		);
		try {
			key(http("https://h/mcp", { headers: { "X-Test": "one", "x-test": "two" } }));
		} catch (error) {
			expect(error).toMatchObject({ code: "MCP_DUPLICATE_HEADER", name: "MCPPoolConfigError" });
		}
	});

	test("rejects URL userinfo with a typed config error", () => {
		expect(() => canonicalizeMCPEndpoint("https://user:password@example.test/mcp")).toThrow(MCPPoolConfigError);
		try {
			canonicalizeMCPEndpoint("https://user@example.test/mcp");
		} catch (error) {
			expect(error).toMatchObject({ code: "MCP_USERINFO_NOT_ALLOWED", name: "MCPPoolConfigError" });
		}
	});
});
