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

function routeProviderRequests(origin: string): Disposable {
	return hookFetch((input, init, next) => {
		const url = new URL(String(input));
		if (url.hostname !== "provider.example") return next(input, init);
		return next(new URL(`${url.pathname}${url.search}`, origin), init);
	});
}

describe("mcp oauth flow", () => {
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

	for (const status of [307, 308] as const) {
		it(`rejects a ${status} token redirect without forwarding the form body`, async () => {
			let tokenBody = "";
			let redirectedRequests = 0;
			const tokenReceived = Promise.withResolvers<void>();
			const server = Bun.serve({
				hostname: "127.0.0.1",
				port: 0,
				async fetch(request) {
					const url = new URL(request.url);
					if (url.pathname === "/token") {
						tokenBody = await request.text();
						tokenReceived.resolve();
						return new Response(null, {
							status,
							headers: { Location: new URL("/token-redirected", request.url).href },
						});
					}
					if (url.pathname === "/token-redirected") {
						redirectedRequests++;
						return new Response("redirected");
					}
					return new Response("not found", { status: 404 });
				},
			});

			try {
				using _route = routeProviderRequests(`http://127.0.0.1:${server.port}`);
				const flow = new MCPOAuthFlow(
					{ ...baseConfig, clientSecret: "client-secret", resource: "https://mcp.example/mcp" },
					{},
				);

				await expect(
					flow.exchangeToken("authorization-code", "state", "https://client.example/oauth/callback"),
				).rejects.toThrow();
				await tokenReceived.promise;

				expect(Object.fromEntries(new URLSearchParams(tokenBody))).toEqual({
					grant_type: "authorization_code",
					code: "authorization-code",
					redirect_uri: "https://client.example/oauth/callback",
					client_id: "client-id",
					resource: "https://mcp.example/mcp",
					client_secret: "client-secret",
				});
				expect(redirectedRequests).toBe(0);
			} finally {
				server.stop(true);
			}
		});

		it(`rejects a ${status} registration redirect without forwarding the JSON body`, async () => {
			let registrationBody = "";
			let redirectedRequests = 0;
			const registrationReceived = Promise.withResolvers<void>();
			const server = Bun.serve({
				hostname: "127.0.0.1",
				port: 0,
				async fetch(request) {
					const url = new URL(request.url);
					if (url.pathname === "/.well-known/oauth-authorization-server") {
						return Response.json({ registration_endpoint: "https://provider.example/register" });
					}
					if (url.pathname === "/register") {
						registrationBody = await request.text();
						registrationReceived.resolve();
						return new Response(null, {
							status,
							headers: { Location: new URL("/register-redirected", request.url).href },
						});
					}
					if (url.pathname === "/register-redirected") {
						redirectedRequests++;
						return Response.json({ client_id: "redirected-client-id" });
					}
					if (url.pathname === "/authorize") return new Response("authorization page");
					return new Response("not found", { status: 404 });
				},
			});

			try {
				using _route = routeProviderRequests(`http://127.0.0.1:${server.port}`);
				const flow = new MCPOAuthFlow({ ...baseConfig, clientId: undefined }, {});
				const { url } = await flow.generateAuthUrl("test-state", "https://client.example/oauth/callback");
				await registrationReceived.promise;

				expect(JSON.parse(registrationBody)).toEqual({
					client_name: "Codex",
					redirect_uris: ["https://client.example/oauth/callback"],
					grant_types: ["authorization_code", "refresh_token"],
					response_types: ["code"],
					token_endpoint_auth_method: "none",
					application_type: "native",
				});
				expect(new URL(url).searchParams.get("client_id")).toBeNull();
				expect(flow.resolvedClientId).toBeUndefined();
				expect(redirectedRequests).toBe(0);
			} finally {
				server.stop(true);
			}
		});
	}

	it("ignores a late registration response after cancellation", async () => {
		const controller = new AbortController();
		const registrationReceived = Promise.withResolvers<string>();
		const releaseRegistration = Promise.withResolvers<void>();
		const responseProduced = Promise.withResolvers<void>();
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				const url = new URL(request.url);
				if (url.pathname === "/.well-known/oauth-authorization-server") {
					return Response.json({ registration_endpoint: "https://provider.example/register" });
				}
				if (url.pathname === "/register") {
					registrationReceived.resolve(await request.text());
					await releaseRegistration.promise;
					responseProduced.resolve();
					return Response.json({ client_id: "late-client-id", client_secret: "late-client-secret" });
				}
				return new Response("not found", { status: 404 });
			},
		});

		try {
			using _route = routeProviderRequests(`http://127.0.0.1:${server.port}`);
			const flow = new MCPOAuthFlow({ ...baseConfig, clientId: undefined }, { signal: controller.signal });
			const operation = flow.generateAuthUrl("test-state", "https://client.example/oauth/callback");

			const registrationBody = await registrationReceived.promise;
			controller.abort(new Error("registration cancelled"));
			await expect(operation).rejects.toThrow("registration cancelled");
			releaseRegistration.resolve();
			await responseProduced.promise;

			expect(JSON.parse(registrationBody)).toMatchObject({
				client_name: "Codex",
				redirect_uris: ["https://client.example/oauth/callback"],
			});
			expect(flow.resolvedClientId).toBeUndefined();
			expect(flow.registeredClientSecret).toBeUndefined();
		} finally {
			releaseRegistration.resolve();
			server.stop(true);
		}
	});

	it("rejects private token endpoints before the first fetch", async () => {
		const lookup = vi.spyOn(dns, "lookup");
		lookup.mockImplementation((async (hostname: string) => {
			if (hostname === "private.example") return { address: "127.0.0.1", family: 4 };
			return { address: "1.1.1.1", family: 4 };
		}) as typeof dns.lookup);
		let fetchCalled = false;
		using _hook = hookFetch(() => {
			fetchCalled = true;
			return new Response("unexpected", { status: 500 });
		});

		const flow = new MCPOAuthFlow({ ...baseConfig, tokenUrl: "https://private.example/token" }, {});
		await expect(flow.exchangeToken("test-code", "state", "http://127.0.0.1/callback")).rejects.toThrow(
			/Refusing non-public OAuth endpoint/,
		);
		expect(fetchCalled).toBe(false);
	});

	it("rejects private registration endpoints before the registration POST", async () => {
		const lookup = vi.spyOn(dns, "lookup");
		lookup.mockImplementation((async (hostname: string) => {
			if (hostname === "private.example") return { address: "127.0.0.1", family: 4 };
			return { address: "1.1.1.1", family: 4 };
		}) as typeof dns.lookup);
		let registrationCalled = false;
		using _hook = hookFetch((input, init) => {
			const url = String(input);
			if (url === "https://provider.example/.well-known/oauth-authorization-server") {
				return new Response(JSON.stringify({ registration_endpoint: "https://private.example/register" }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			if (url === "https://private.example/register") {
				registrationCalled = true;
				return new Response(JSON.stringify({ client_id: "unexpected" }), { status: 200 });
			}
			if (url === "https://provider.example/authorize") return new Response("ok", { status: 200 });
			throw new Error(`Unexpected fetch: ${url} ${String(init?.method ?? "GET")}`);
		});

		const flow = new MCPOAuthFlow({ ...baseConfig, clientId: undefined }, {});
		await flow.generateAuthUrl("state", "http://127.0.0.1/callback");
		expect(registrationCalled).toBe(false);
		expect(flow.resolvedClientId).toBeUndefined();
	});

	it("propagates abort and network failures from direct token exchange", async () => {
		const controller = new AbortController();
		controller.abort(new Error("cancelled"));
		let fetchCalled = false;
		using _hook = hookFetch(() => {
			fetchCalled = true;
			throw new Error("network failure");
		});
		const abortedFlow = new MCPOAuthFlow(baseConfig, { signal: controller.signal });
		await expect(abortedFlow.exchangeToken("code", "state", "http://127.0.0.1/callback")).rejects.toThrow(
			"cancelled",
		);
		expect(fetchCalled).toBe(false);

		const networkFlow = new MCPOAuthFlow(baseConfig, {});
		await expect(networkFlow.exchangeToken("code", "state", "http://127.0.0.1/callback")).rejects.toThrow(
			"network failure",
		);
	});

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

	it("ignores a late token response after cancellation", async () => {
		const controller = new AbortController();
		const tokenReceived = Promise.withResolvers<string>();
		const releaseToken = Promise.withResolvers<void>();
		const responseProduced = Promise.withResolvers<void>();
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				if (new URL(request.url).pathname !== "/token") return new Response("not found", { status: 404 });
				tokenReceived.resolve(await request.text());
				await releaseToken.promise;
				responseProduced.resolve();
				return Response.json({ access_token: "late-access-token", refresh_token: "late-refresh-token" });
			},
		});

		try {
			using _route = routeProviderRequests(`http://127.0.0.1:${server.port}`);
			const flow = new MCPOAuthFlow({ ...baseConfig, clientSecret: "client-secret" }, { signal: controller.signal });
			const operation = flow.exchangeToken("authorization-code", "state", "https://client.example/oauth/callback");

			const tokenBody = await tokenReceived.promise;
			controller.abort(new Error("token exchange cancelled"));
			await expect(operation).rejects.toThrow("token exchange cancelled");
			releaseToken.resolve();
			await responseProduced.promise;

			expect(Object.fromEntries(new URLSearchParams(tokenBody))).toEqual({
				grant_type: "authorization_code",
				code: "authorization-code",
				redirect_uri: "https://client.example/oauth/callback",
				client_id: "client-id",
				client_secret: "client-secret",
			});
		} finally {
			releaseToken.resolve();
			server.stop(true);
		}
	});

	it("aborts a token POST on timeout without following a redirect", async () => {
		const tokenReceived = Promise.withResolvers<string>();
		const releaseToken = Promise.withResolvers<void>();
		const responseProduced = Promise.withResolvers<void>();
		let redirectedRequests = 0;
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				const url = new URL(request.url);
				if (url.pathname === "/token") {
					tokenReceived.resolve(await request.text());
					await releaseToken.promise;
					responseProduced.resolve();
					return new Response(null, {
						status: 307,
						headers: { Location: new URL("/token-redirected", request.url).href },
					});
				}
				if (url.pathname === "/token-redirected") redirectedRequests++;
				return new Response("not found", { status: 404 });
			},
		});

		try {
			using _route = routeProviderRequests(`http://127.0.0.1:${server.port}`);
			const flow = new MCPOAuthFlow(
				{ ...baseConfig, clientSecret: "client-secret" },
				{ signal: AbortSignal.timeout(25) },
			);
			const operation = flow.exchangeToken("authorization-code", "state", "https://client.example/oauth/callback");
			const tokenBody = await tokenReceived.promise;

			await expect(operation).rejects.toThrow();
			expect(Object.fromEntries(new URLSearchParams(tokenBody))).toEqual({
				grant_type: "authorization_code",
				code: "authorization-code",
				redirect_uri: "https://client.example/oauth/callback",
				client_id: "client-id",
				client_secret: "client-secret",
			});
			expect(redirectedRequests).toBe(0);
		} finally {
			releaseToken.resolve();
			await responseProduced.promise.catch(() => undefined);
			server.stop(true);
		}
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
