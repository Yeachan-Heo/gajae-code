import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as dns from "node:dns/promises";
import { hookFetch } from "../../utils/src/hook-fetch";
import { canonicalMCPResourceUri, MCPOAuthFlow } from "../src/runtime-mcp/oauth-flow";

const originalFetch = global.fetch;

beforeEach(() => {
	// Token URLs in this file are fictional. The public-URL check resolves them
	// before fetch, and these tests already mock that fetch.
	vi.spyOn(dns, "lookup").mockImplementation(((...args: unknown[]) => {
		const options = args[1];
		if (options && typeof options === "object" && "all" in options && options.all === true) {
			return Promise.resolve([{ address: "1.1.1.1", family: 4 }]);
		}
		return Promise.resolve({ address: "1.1.1.1", family: 4 });
	}) as typeof dns.lookup);
});

afterEach(() => {
	vi.restoreAllMocks();
	global.fetch = originalFetch;
});

async function dispatchLocalCallback(callbackUrl: string): Promise<void> {
	const url = new URL(callbackUrl);
	url.hostname = "127.0.0.1";
	let lastError: unknown;
	for (let attempt = 0; attempt < 20; attempt++) {
		try {
			await originalFetch(url.toString());
			return;
		} catch (error) {
			lastError = error;
			await Bun.sleep(10);
		}
	}
	throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/**
 * Reserve an OS-assigned loopback port for the OAuth callback server.
 *
 * The reservation is closed before MCPOAuthFlow re-binds the port, which
 * leaves a narrow close-then-rebind TOCTOU window. This is an accepted
 * test-only tradeoff: an intervening claimant causes an honest bind
 * failure/timeout, never a false pass, and eliminating it entirely would
 * require the production callback API to accept a pre-bound listener.
 * Do not replace this with hardcoded ports or retries.
 */
function allocateCallbackPort(): number {
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch() {
			return new Response("reserved callback port");
		},
	});
	const port = server.port;
	server.stop(true);
	if (port === undefined) throw new Error("Expected callback port");
	return port;
}

function mockProviderTokenEndpoint(onBody: (body: string) => void) {
	return hookFetch((input, init) => {
		const url = String(input);
		if (url === "https://provider.example/token") {
			onBody(String(init?.body ?? ""));
			return new Response(
				JSON.stringify({
					access_token: "access-token",
					refresh_token: "refresh-token",
					expires_in: 3600,
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}

		throw new Error(`Unexpected fetch: ${url}`);
	});
}

describe("mcp oauth flow", () => {
	it("does not follow redirects for credential-bearing token POSTs", async () => {
		let requestInit: RequestInit | undefined;
		using _hook = hookFetch((input, init) => {
			if (String(input) !== "https://provider.example/token") return new Response("not found", { status: 404 });
			requestInit = init;
			return new Response("redirect", { status: 307, headers: { location: "http://127.0.0.1/private" } });
		});

		const flow = new MCPOAuthFlow(
			{
				authorizationUrl: "https://provider.example/authorize",
				tokenUrl: "https://provider.example/token",
				clientId: "client-id",
			},
			{},
		);
		await expect(flow.exchangeToken("code", "state", "http://127.0.0.1/callback")).rejects.toThrow(
			"Token exchange failed",
		);
		expect(requestInit?.redirect).toBe("error");
	});

	it("does not follow redirects for credential-bearing dynamic registration POSTs", async () => {
		let requestInit: RequestInit | undefined;
		using _hook = hookFetch((input, init) => {
			const url = String(input);
			if (url === "https://provider.example/.well-known/oauth-authorization-server")
				return new Response(JSON.stringify({ registration_endpoint: "https://provider.example/register" }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			if (url === "https://provider.example/register") {
				requestInit = init;
				return new Response("redirect", { status: 307, headers: { location: "http://127.0.0.1/private" } });
			}
			return new Response("not found", { status: 404 });
		});

		const flow = new MCPOAuthFlow(
			{
				authorizationUrl: "https://provider.example/authorize",
				tokenUrl: "https://provider.example/token",
			},
			{},
		);
		await flow.generateAuthUrl("state", "http://127.0.0.1:3001/callback");
		expect(requestInit?.redirect).toBe("error");
	});

	it("uses Codex client name for dynamic client registration", async () => {
		let registrationPayload: Record<string, unknown> | null = null;

		using _hook = hookFetch((input, init) => {
			const url = String(input);
			if (url === "https://www.figma.com/.well-known/oauth-authorization-server") {
				return new Response(
					JSON.stringify({ registration_endpoint: "https://api.figma.com/v1/oauth/mcp/register" }),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}

			if (url === "https://api.figma.com/v1/oauth/mcp/register") {
				registrationPayload = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
				return new Response(
					JSON.stringify({
						client_id: "registered-client-id",
						client_secret: "registered-client-secret",
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}

			return new Response("not found", { status: 404 });
		});

		const flow = new MCPOAuthFlow(
			{
				authorizationUrl: "https://www.figma.com/oauth/mcp",
				tokenUrl: "https://api.figma.com/v1/oauth/token",
			},
			{},
		);

		const { url } = await flow.generateAuthUrl("test-state", "http://127.0.0.1:53172/callback");
		const authUrl = new URL(url);

		expect(registrationPayload).not.toBeNull();
		expect((registrationPayload as { client_name?: string } | null)?.client_name).toBe("Codex");
		expect(authUrl.searchParams.get("client_id")).toBe("registered-client-id");
		expect(authUrl.searchParams.get("state")).toBe("test-state");
	});

	it("uses configured callbackPath for the local redirect URI", async () => {
		let observedRedirectUri = "";
		let tokenRequestBody = "";

		using _hook = mockProviderTokenEndpoint(body => {
			tokenRequestBody = body;
		});

		const callbackPort = allocateCallbackPort();

		const flow = new MCPOAuthFlow(
			{
				authorizationUrl: "https://provider.example/authorize",
				tokenUrl: "https://provider.example/token",
				clientId: "client-id",
				callbackPort,
				callbackPath: "slack/oauth_redirect",
			},
			{
				onAuth: info => {
					const authUrl = new URL(info.url);
					observedRedirectUri = authUrl.searchParams.get("redirect_uri") ?? "";
					const state = authUrl.searchParams.get("state") ?? "";
					queueMicrotask(() => {
						void dispatchLocalCallback(`${observedRedirectUri}?code=test-code&state=${state}`);
					});
				},
				signal: AbortSignal.timeout(1_000),
			},
		);

		const credentials = await flow.login();
		const redirectUrl = new URL(observedRedirectUri);
		const tokenParams = new URLSearchParams(tokenRequestBody);

		expect(redirectUrl.pathname).toBe("/slack/oauth_redirect");
		expect(tokenParams.get("redirect_uri")).toBe(observedRedirectUri);
		expect(credentials).toMatchObject({
			access: "access-token",
			refresh: "refresh-token",
		});
	});

	it("uses exact redirectUri and clientSecret for provider requests", async () => {
		let observedRedirectUri = "";
		let tokenRequestBody = "";

		using _hook = mockProviderTokenEndpoint(body => {
			tokenRequestBody = body;
		});

		const callbackPort = allocateCallbackPort();

		const flow = new MCPOAuthFlow(
			{
				authorizationUrl: "https://provider.example/authorize",
				tokenUrl: "https://provider.example/token",
				clientId: "client-id",
				clientSecret: "client-secret",
				redirectUri: "https://public.example/slack/oauth_redirect",
				callbackPort,
				callbackPath: "slack/oauth_redirect",
			},
			{
				onAuth: info => {
					const authUrl = new URL(info.url);
					observedRedirectUri = authUrl.searchParams.get("redirect_uri") ?? "";
					const state = authUrl.searchParams.get("state") ?? "";
					queueMicrotask(() => {
						void dispatchLocalCallback(
							`http://127.0.0.1:${callbackPort}/slack/oauth_redirect?code=test-code&state=${state}`,
						);
					});
				},
				signal: AbortSignal.timeout(1_000),
			},
		);

		const credentials = await flow.login();
		const tokenParams = new URLSearchParams(tokenRequestBody);

		expect(observedRedirectUri).toBe("https://public.example/slack/oauth_redirect");
		expect(tokenParams.get("redirect_uri")).toBe("https://public.example/slack/oauth_redirect");
		expect(tokenParams.get("client_secret")).toBe("client-secret");
		expect(credentials).toMatchObject({
			access: "access-token",
			refresh: "refresh-token",
		});
	});

	it("preserves root redirectUri values without adding a trailing slash", async () => {
		let observedRedirectUri = "";
		let tokenRequestBody = "";

		using _hook = mockProviderTokenEndpoint(body => {
			tokenRequestBody = body;
		});

		const callbackPort = allocateCallbackPort();

		const flow = new MCPOAuthFlow(
			{
				authorizationUrl: "https://provider.example/authorize",
				tokenUrl: "https://provider.example/token",
				clientId: "client-id",
				redirectUri: "https://public.example",
				callbackPort,
			},
			{
				onAuth: info => {
					const authUrl = new URL(info.url);
					observedRedirectUri = authUrl.searchParams.get("redirect_uri") ?? "";
					const state = authUrl.searchParams.get("state") ?? "";
					queueMicrotask(() => {
						void dispatchLocalCallback(`http://127.0.0.1:${callbackPort}/?code=test-code&state=${state}`);
					});
				},
				signal: AbortSignal.timeout(1_000),
			},
		);

		const credentials = await flow.login();
		const tokenParams = new URLSearchParams(tokenRequestBody);

		expect(observedRedirectUri).toBe("https://public.example");
		expect(tokenParams.get("redirect_uri")).toBe("https://public.example");
		expect(credentials).toMatchObject({
			access: "access-token",
			refresh: "refresh-token",
		});
	});

	it("supports https loopback redirectUri values behind a separate local callback port", async () => {
		let observedRedirectUri = "";
		let tokenRequestBody = "";

		using _hook = mockProviderTokenEndpoint(body => {
			tokenRequestBody = body;
		});

		const callbackPort = allocateCallbackPort();

		const flow = new MCPOAuthFlow(
			{
				authorizationUrl: "https://provider.example/authorize",
				tokenUrl: "https://provider.example/token",
				redirectUri: "https://localhost:3443/slack/oauth_redirect",
				callbackPort,
			},
			{
				onAuth: info => {
					const authUrl = new URL(info.url);
					observedRedirectUri = authUrl.searchParams.get("redirect_uri") ?? "";
					const state = authUrl.searchParams.get("state") ?? "";
					queueMicrotask(() => {
						void dispatchLocalCallback(
							`http://127.0.0.1:${callbackPort}/slack/oauth_redirect?code=test-code&state=${state}`,
						);
					});
				},
				signal: AbortSignal.timeout(1_000),
			},
		);

		const credentials = await flow.login();
		const tokenParams = new URLSearchParams(tokenRequestBody);

		expect(observedRedirectUri).toBe("https://localhost:3443/slack/oauth_redirect");
		expect(tokenParams.get("redirect_uri")).toBe("https://localhost:3443/slack/oauth_redirect");
		expect(credentials).toMatchObject({
			access: "access-token",
			refresh: "refresh-token",
		});
	});

	it("rejects https loopback redirectUri values without a separate callback port", () => {
		expect(
			() =>
				new MCPOAuthFlow(
					{
						authorizationUrl: "https://provider.example/authorize",
						tokenUrl: "https://provider.example/token",
						redirectUri: "https://localhost:3000/slack/oauth_redirect",
					},
					{},
				),
		).toThrow("HTTPS loopback redirect URIs require oauth.callbackPort");
	});

	it("listens on the implied port for exact HTTP loopback redirectUri values", async () => {
		let servedOptions: { hostname?: string; port?: number | string } | undefined;
		const serveSpy = vi.spyOn(Bun, "serve").mockImplementation(options => {
			servedOptions = { hostname: options.hostname, port: options.port };
			throw Object.assign(new Error("EADDRINUSE"), { code: "EADDRINUSE" });
		});

		const flow = new MCPOAuthFlow(
			{
				authorizationUrl: "https://provider.example/authorize",
				tokenUrl: "https://provider.example/token",
				redirectUri: "http://localhost/callback",
			},
			{ signal: AbortSignal.timeout(1_000) },
		);

		await expect(flow.login()).rejects.toThrow(
			"OAuth callback port 80 unavailable; cannot fall back to a random port when oauth.redirectUri is set",
		);
		expect(serveSpy).toHaveBeenCalledTimes(1);
		expect(servedOptions).toMatchObject({ hostname: "127.0.0.1", port: 80 });
	});

	it("listens on the explicit port for exact HTTP loopback redirectUri values", async () => {
		let servedOptions: { hostname?: string; port?: number | string } | undefined;
		const serveSpy = vi.spyOn(Bun, "serve").mockImplementation(options => {
			servedOptions = { hostname: options.hostname, port: options.port };
			throw Object.assign(new Error("EADDRINUSE"), { code: "EADDRINUSE" });
		});

		const flow = new MCPOAuthFlow(
			{
				authorizationUrl: "https://provider.example/authorize",
				tokenUrl: "https://provider.example/token",
				redirectUri: "http://localhost:3000/callback",
			},
			{ signal: AbortSignal.timeout(1_000) },
		);

		await expect(flow.login()).rejects.toThrow(
			"OAuth callback port 3000 unavailable; cannot fall back to a random port when oauth.redirectUri is set",
		);
		expect(serveSpy).toHaveBeenCalledTimes(1);
		expect(servedOptions).toMatchObject({ hostname: "127.0.0.1", port: 3000 });
	});

	it("fails instead of falling back to a random port when redirectUri is exact", async () => {
		const callbackPort = allocateCallbackPort();
		let servedOptions: { hostname?: string; port?: number | string } | undefined;
		const serveSpy = vi.spyOn(Bun, "serve").mockImplementation(options => {
			servedOptions = { hostname: options.hostname, port: options.port };
			throw Object.assign(new Error("EADDRINUSE"), { code: "EADDRINUSE" });
		});

		const flow = new MCPOAuthFlow(
			{
				authorizationUrl: "https://provider.example/authorize",
				tokenUrl: "https://provider.example/token",
				redirectUri: "https://public.example/slack/oauth_redirect",
				callbackPort,
				callbackPath: "/slack/oauth_redirect",
			},
			{ signal: AbortSignal.timeout(1_000) },
		);

		await expect(flow.login()).rejects.toThrow("cannot fall back to a random port when oauth.redirectUri is set");
		expect(serveSpy).toHaveBeenCalledTimes(1);
		expect(servedOptions).toMatchObject({ hostname: "127.0.0.1", port: callbackPort });
	});

	it("exposes the dynamically registered client_id and client_secret after generateAuthUrl", async () => {
		using _hook = hookFetch(input => {
			const url = String(input);
			if (url === "https://www.figma.com/.well-known/oauth-authorization-server") {
				return new Response(
					JSON.stringify({ registration_endpoint: "https://api.figma.com/v1/oauth/mcp/register" }),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			if (url === "https://api.figma.com/v1/oauth/mcp/register") {
				return new Response(
					JSON.stringify({
						client_id: "registered-client-id",
						client_secret: "registered-client-secret",
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			return new Response("not found", { status: 404 });
		});

		const flow = new MCPOAuthFlow(
			{
				authorizationUrl: "https://www.figma.com/oauth/mcp",
				tokenUrl: "https://api.figma.com/v1/oauth/token",
			},
			{},
		);

		expect(flow.resolvedClientId).toBeUndefined();
		expect(flow.registeredClientSecret).toBeUndefined();

		await flow.generateAuthUrl("test-state", "http://127.0.0.1:53173/callback");

		expect(flow.resolvedClientId).toBe("registered-client-id");
		expect(flow.registeredClientSecret).toBe("registered-client-secret");
	});

	it("returns the configured client_id from resolvedClientId without triggering registration", async () => {
		let registrationCalled = false;
		using _hook = hookFetch(input => {
			const url = String(input);
			if (url.includes("/.well-known/")) {
				return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
			}
			if (url.endsWith("/register")) {
				registrationCalled = true;
			}
			return new Response("not found", { status: 404 });
		});

		const flow = new MCPOAuthFlow(
			{
				authorizationUrl: "https://provider.example/authorize",
				tokenUrl: "https://provider.example/token",
				clientId: "configured-client-id",
			},
			{},
		);

		expect(flow.resolvedClientId).toBe("configured-client-id");
		expect(flow.registeredClientSecret).toBeUndefined();

		await flow.generateAuthUrl("test-state", "http://127.0.0.1:53174/callback");

		expect(flow.resolvedClientId).toBe("configured-client-id");
		expect(flow.registeredClientSecret).toBeUndefined();
		expect(registrationCalled).toBe(false);
	});
});

describe("MCP 2026-07-28 authorization conformance", () => {
	const baseConfig = {
		authorizationUrl: "https://provider.example/authorize",
		tokenUrl: "https://provider.example/token",
		clientId: "client-id",
	};

	function mockTokenEndpoint(onBody: (body: string) => void) {
		return hookFetch((input, init) => {
			const url = String(input);
			if (url === "https://provider.example/token") {
				onBody(String(init?.body ?? ""));
				return new Response(
					JSON.stringify({ access_token: "access-token", refresh_token: "refresh-token", expires_in: 3600 }),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			return new Response("not found", { status: 404 });
		});
	}

	function driveCallback(onAuthUrl: (authUrl: URL) => Record<string, string>) {
		return (info: { url: string; instructions?: string }) => {
			const authUrl = new URL(info.url);
			const redirectUri = authUrl.searchParams.get("redirect_uri") ?? "";
			const state = authUrl.searchParams.get("state") ?? "";
			const extra = onAuthUrl(authUrl);
			const params = new URLSearchParams({ code: "test-code", state, ...extra });
			queueMicrotask(() => {
				void dispatchLocalCallback(`${redirectUri}?${params.toString()}`);
			});
		};
	}

	it("sends the RFC 8707 canonical resource on authorization and token requests", async () => {
		let tokenRequestBody = "";
		let observedAuthUrl: URL | undefined;
		using _hook = mockTokenEndpoint(body => {
			tokenRequestBody = body;
		});
		const flow = new MCPOAuthFlow(
			{ ...baseConfig, callbackPort: allocateCallbackPort(), resource: "https://mcp.example/mcp" },
			{
				onAuth: info => {
					observedAuthUrl = new URL(info.url);
					driveCallback(() => ({}))(info);
				},
				signal: AbortSignal.timeout(5_000),
			},
		);
		const credentials = await flow.login();
		expect(credentials.access).toBe("access-token");
		expect(observedAuthUrl?.searchParams.get("resource")).toBe("https://mcp.example/mcp");
		expect(new URLSearchParams(tokenRequestBody).get("resource")).toBe("https://mcp.example/mcp");
	});

	it("rejects a mismatched authorization-response issuer fail-closed (RFC 9207)", async () => {
		let tokenCalled = false;
		using _hook = mockTokenEndpoint(() => {
			tokenCalled = true;
		});
		const flow = new MCPOAuthFlow(
			{
				...baseConfig,
				callbackPort: allocateCallbackPort(),
				resource: "https://mcp.example/mcp",
				issuer: "https://provider.example",
				issuerResponseIssSupported: true,
			},
			{ onAuth: driveCallback(() => ({ iss: "https://attacker.example" })), signal: AbortSignal.timeout(5_000) },
		);
		await expect(flow.login()).rejects.toThrow(/issuer mismatch/);
		expect(tokenCalled).toBe(false);
	});

	it("rejects an iss-less response when metadata advertises iss support", async () => {
		using _hook = mockTokenEndpoint(() => {});
		const flow = new MCPOAuthFlow(
			{
				...baseConfig,
				callbackPort: allocateCallbackPort(),
				issuer: "https://provider.example",
				issuerResponseIssSupported: true,
			},
			{ onAuth: driveCallback(() => ({})), signal: AbortSignal.timeout(5_000) },
		);
		await expect(flow.login()).rejects.toThrow(/missing required issuer/);
	});

	it("accepts a response whose iss matches the recorded issuer", async () => {
		let tokenRequestBody = "";
		using _hook = mockTokenEndpoint(body => {
			tokenRequestBody = body;
		});
		const flow = new MCPOAuthFlow(
			{
				...baseConfig,
				callbackPort: allocateCallbackPort(),
				issuer: "https://provider.example",
				issuerResponseIssSupported: true,
			},
			{ onAuth: driveCallback(() => ({ iss: "https://provider.example" })), signal: AbortSignal.timeout(5_000) },
		);
		const credentials = await flow.login();
		expect(credentials.access).toBe("access-token");
		expect(new URLSearchParams(tokenRequestBody).get("code")).toBe("test-code");
	});

	it("proceeds without iss validation when no issuer was recorded", async () => {
		using _hook = mockTokenEndpoint(() => {});
		const flow = new MCPOAuthFlow(
			{ ...baseConfig, callbackPort: allocateCallbackPort() },
			{ onAuth: driveCallback(() => ({ iss: "https://anything.example" })), signal: AbortSignal.timeout(5_000) },
		);
		const credentials = await flow.login();
		expect(credentials.access).toBe("access-token");
	});

	it("passes cancellation through token exchange fetch", async () => {
		const callbackPort = allocateCallbackPort();
		const controller = new AbortController();
		const tokenStarted = Promise.withResolvers<void>();
		using _hook = hookFetch(async (input, init) => {
			if (String(input) !== "https://provider.example/token") return new Response("not found", { status: 404 });
			tokenStarted.resolve();
			const { promise: aborted, reject } = Promise.withResolvers<never>();
			init?.signal?.addEventListener("abort", () => reject(new Error("token exchange aborted")), { once: true });
			await aborted;
			throw new Error("unreachable");
		});
		const flow = new MCPOAuthFlow(
			{
				authorizationUrl: "https://provider.example/authorize",
				tokenUrl: "https://provider.example/token",
				clientId: "client-id",
				callbackPort,
			},
			{
				onAuth: info => {
					const authUrl = new URL(info.url);
					queueMicrotask(() => {
						void dispatchLocalCallback(
							`${authUrl.searchParams.get("redirect_uri")}?code=test-code&state=${authUrl.searchParams.get("state")}`,
						);
					});
				},
				signal: controller.signal,
			},
		);

		const operation = flow.login();
		await tokenStarted.promise;
		controller.abort(new Error("cancelled"));
		await expect(operation).rejects.toThrow("token exchange aborted");
	});

	it("canonicalizes MCP resource URIs per RFC 8707", () => {
		expect(canonicalMCPResourceUri("https://mcp.example.com/")).toBe("https://mcp.example.com");
		expect(canonicalMCPResourceUri("https://mcp.example.com/mcp#frag")).toBe("https://mcp.example.com/mcp");
		expect(canonicalMCPResourceUri("https://mcp.example.com:8443/server/mcp")).toBe(
			"https://mcp.example.com:8443/server/mcp",
		);
		expect(canonicalMCPResourceUri("not a url")).toBeUndefined();
	});
});
