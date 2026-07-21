import { afterEach, describe, expect, it, vi } from "bun:test";
import { hookFetch } from "../../utils/src/hook-fetch";
import { MCPOAuthFlow } from "../src/runtime-mcp/oauth-flow";

const originalFetch = global.fetch;

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
