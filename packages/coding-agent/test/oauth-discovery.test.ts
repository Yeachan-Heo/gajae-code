import { describe, expect, it } from "bun:test";
import {
	analyzeAuthError,
	discoverOAuthEndpoints,
	extractMcpAuthServerUrl,
	extractOAuthEndpoints,
} from "../src/runtime-mcp/oauth-discovery";
import type { AddressResolver } from "../src/web/insane/url-guard";

const resolver: AddressResolver = async () => ["8.8.8.8"];

function metadataFetch(
	routes: Partial<Record<string, { body?: Record<string, unknown>; location?: string; status?: number }>>,
) {
	const calls: string[] = [];
	const pinned: Array<{ host: string | null; serverName?: string; url: string }> = [];
	const fetch = async (input: string | URL | Request, init?: BunFetchRequestInit): Promise<Response> => {
		const target = new URL(String(input));
		const host = new Headers(init?.headers).get("Host");
		pinned.push({ host, serverName: init?.tls?.serverName, url: target.toString() });
		if (host) target.host = host;
		const url = target.toString();
		calls.push(url);
		expect(init?.redirect).toBe("manual");
		const route = routes[url] ?? { status: 404 };
		return new Response(route.body ? JSON.stringify(route.body) : null, {
			status: route.status ?? (route.location ? 302 : 200),
			headers: route.location ? { Location: route.location } : { "Content-Type": "application/json" },
		});
	};
	return { calls, fetch, pinned };
}

const authMetadata = (issuer = "https://auth.example/") => ({
	issuer,
	authorization_endpoint: "https://login.example/authorize",
	token_endpoint: "https://tokens.example/token",
});

describe("mcp oauth discovery", () => {
	it("classifies untrusted auth hints without granting them discovery authority", () => {
		const error = new Error(
			'HTTP 401 [WWW-Authenticate: Bearer authorization_uri="http://127.0.0.1/auth" token_url="http://127.0.0.1/token"; Mcp-Auth-Server: http://127.0.0.1]',
		);
		expect(extractMcpAuthServerUrl(error)).toBe("http://127.0.0.1/");
		expect(analyzeAuthError(error)).toMatchObject({ requiresAuth: true, authType: "oauth" });
		expect(analyzeAuthError(error).oauth).toBeUndefined();
		expect(analyzeAuthError(error).authServerUrl).toBeUndefined();
	});

	it("discovers issuer-bound endpoints across validated origins", async () => {
		const resourceMetadata = "https://mcp.example/.well-known/oauth-protected-resource";
		const authorizationMetadata = "https://auth.example/.well-known/oauth-authorization-server";
		const mock = metadataFetch({
			[resourceMetadata]: {
				body: { resource: "https://mcp.example/mcp", authorization_servers: ["https://auth.example"] },
			},
			[authorizationMetadata]: { body: { ...authMetadata(), scopes_supported: ["read", "write"] } },
		});
		const result = await discoverOAuthEndpoints("https://mcp.example/mcp", undefined, {
			fetch: mock.fetch,
			resolver,
		});
		expect(result).toEqual({
			authorizationUrl: "https://login.example/authorize",
			tokenUrl: "https://tokens.example/token",
			scopes: "read write",
			// Recorded from the validated metadata document for RFC 9207 response checks.
			issuer: "https://auth.example/",
		});
	});

	it("deduplicates aliases and terminates protected-resource cycles", async () => {
		const mock = metadataFetch({
			"https://mcp.example/.well-known/oauth-protected-resource": {
				body: {
					resource: "https://mcp.example/mcp",
					authorization_servers: ["https://AUTH.example:443", "https://auth.example/"],
				},
			},
			"https://auth.example/.well-known/oauth-protected-resource": {
				body: { resource: "https://mcp.example/mcp", authorization_servers: ["https://mcp.example"] },
			},
		});
		await discoverOAuthEndpoints("https://mcp.example/mcp", undefined, { fetch: mock.fetch, resolver });
		expect(
			mock.calls.filter(url => url === "https://auth.example/.well-known/oauth-authorization-server"),
		).toHaveLength(1);
		expect(mock.calls).toHaveLength(12);
	});

	it("shares one global request budget", async () => {
		const mock = metadataFetch({});
		await discoverOAuthEndpoints("https://mcp.example/mcp", undefined, {
			fetch: mock.fetch,
			maxRequests: 2,
			resolver,
		});
		expect(mock.calls).toHaveLength(2);
	});

	it("rejects invalid candidates, redirects, and metadata bindings", async () => {
		for (const routes of [
			{
				"https://mcp.example/.well-known/oauth-authorization-server": {
					body: authMetadata("https://other.example/"),
				},
			},
			{
				"https://mcp.example/.well-known/oauth-authorization-server": { location: "http://127.0.0.1/metadata" },
			},
			{
				"https://mcp.example/.well-known/oauth-protected-resource": {
					body: { resource: "https://other.example/mcp", authorization_servers: ["https://auth.example"] },
				},
			},
		]) {
			const mock = metadataFetch(routes);
			expect(
				await discoverOAuthEndpoints("https://mcp.example/mcp", undefined, { fetch: mock.fetch, resolver }),
			).toBeNull();
			expect(mock.calls).not.toContain("http://127.0.0.1/metadata");
		}
	});

	it("pins every redirect hop to its freshly validated address", async () => {
		const start = "https://mcp.example/.well-known/oauth-authorization-server";
		const mock = metadataFetch({
			[start]: { location: "https://mcp.example/oauth" },
			"https://mcp.example/oauth": { body: authMetadata("https://mcp.example/") },
		});
		let lookup = 0;
		await discoverOAuthEndpoints("https://mcp.example/mcp", undefined, {
			fetch: mock.fetch,
			resolver: async () => [`8.8.8.${++lookup}`],
		});
		expect(mock.calls.slice(0, 2)).toEqual([start, "https://mcp.example/oauth"]);
		expect(mock.pinned.slice(0, 2)).toEqual([
			{
				host: "mcp.example",
				serverName: "mcp.example",
				url: "https://8.8.8.3/.well-known/oauth-authorization-server",
			},
			{ host: "mcp.example", serverName: "mcp.example", url: "https://8.8.8.4/oauth" },
		]);
	});
	it("parses a large challenge-free error in linear time", () => {
		// The challenge-parameter rule scanned to the end of a long identifier run
		// at every offset before failing to find `="`: 25k/50k/100k characters cost
		// 498ms/1990ms/7959ms. `errorMsg` is the failure text a remote MCP server
		// produced, reached whenever a connection attempt fails, so its length is
		// not ours to assume.
		for (const body of [
			"a".repeat(100_000),
			"ab_".repeat(33_000),
			"{".repeat(100_000),
			`realm="x" `.repeat(10_000),
		]) {
			const startedAt = performance.now();
			expect(extractOAuthEndpoints(new Error(body))).toBeNull();
			expect(performance.now() - startedAt).toBeLessThan(1_000);
		}

		const startedAt = performance.now();
		analyzeAuthError(new Error(`401 unauthorized ${"a".repeat(100_000)}`));
		expect(performance.now() - startedAt).toBeLessThan(1_000);
	});

	it("still reads challenge parameters around an oversized key", () => {
		// A bounded regex could reinterpret this suffix as a different parameter;
		// the original parser does not recognize it as authorization_endpoint.
		expect(
			extractOAuthEndpoints(
				new Error(`${"x".repeat(70)}authorization_endpoint="ignored" token_url="https://a.example/tok"`),
			),
		).toBeNull();

		// The legacy realm fallback still recognizes a realm suffix, preserving
		// the existing WWW-Authenticate behavior.
		const legacyEndpoints = extractOAuthEndpoints(
			new Error(`${"x".repeat(70)}realm="https://a.example/auth" token_url="https://a.example/tok"`),
		);
		expect(legacyEndpoints).toMatchObject({
			authorizationUrl: "https://a.example/auth",
			tokenUrl: "https://a.example/tok",
		});

		// Neighboring parameters still resolve after an oversized unknown key.
		const endpoints = extractOAuthEndpoints(
			new Error(
				`Bearer ${"x".repeat(70)}="ignored" realm="https://a.example/auth" token_url="https://a.example/tok"`,
			),
		);
		expect(endpoints).toMatchObject({
			authorizationUrl: "https://a.example/auth",
			tokenUrl: "https://a.example/tok",
		});
	});
});
