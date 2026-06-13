import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { AuthStorage, SqliteAuthCredentialStore } from "../src/auth-storage";
import { getOAuthProviders, refreshOAuthToken } from "../src/utils/oauth";
import type { OAuthCredentials } from "../src/utils/oauth/types";
import {
	discoverXaiOAuthEndpoints,
	refreshXaiToken,
	XAI_OAUTH_CLIENT_ID,
	XAI_OAUTH_DISCOVERY_URL,
	XAI_OAUTH_SCOPE,
	XaiOAuthFlow,
} from "../src/utils/oauth/xai";
import { withEnv } from "./helpers";

const originalFetch = global.fetch;
const SUPPRESS_XAI_ENV = { XAI_API_KEY: undefined } as const;
const AUTHORIZATION_ENDPOINT = "https://auth.x.ai/oauth2/authorize";
const TOKEN_ENDPOINT = "https://auth.x.ai/oauth2/token";

function discoveryResponse(): Response {
	return new Response(
		JSON.stringify({
			issuer: "https://auth.x.ai",
			authorization_endpoint: AUTHORIZATION_ENDPOINT,
			token_endpoint: TOKEN_ENDPOINT,
		}),
		{ status: 200, headers: { "Content-Type": "application/json" } },
	);
}

function tokenResponse(accessToken: string, refreshToken: string, accountId: string, email: string): Response {
	return new Response(
		JSON.stringify({
			access_token: accessToken,
			refresh_token: refreshToken,
			id_token: jwt({ sub: accountId, email }),
			expires_in: 3600,
			token_type: "Bearer",
		}),
		{ status: 200, headers: { "Content-Type": "application/json" } },
	);
}

function jwt(payload: Record<string, unknown>): string {
	const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
	return `${encode({ alg: "none", typ: "JWT" })}.${encode(payload)}.`;
}

async function dispatchLocalCallback(callbackUrl: string): Promise<void> {
	const url = new URL(callbackUrl);
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

describe("xAI OAuth login provider", () => {
	let tempDir = "";
	let store: SqliteAuthCredentialStore | undefined;
	let authStorage: AuthStorage | undefined;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-xai-oauth-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		authStorage = new AuthStorage(store);
	});

	afterEach(async () => {
		global.fetch = originalFetch;
		vi.restoreAllMocks();
		store?.close();
		store = undefined;
		authStorage = undefined;
		if (tempDir) {
			await fs.rm(tempDir, { recursive: true, force: true });
			tempDir = "";
		}
	});

	it("registers xAI as an available login provider", () => {
		expect(getOAuthProviders().find(provider => provider.id === "xai")).toEqual({
			id: "xai",
			name: "xAI",
			available: true,
		});
	});

	it("discovers xAI OAuth endpoints from the official issuer", async () => {
		const fetchMock = vi.fn(async () => discoveryResponse());
		global.fetch = fetchMock as unknown as typeof fetch;

		await expect(discoverXaiOAuthEndpoints()).resolves.toEqual({
			authorizationEndpoint: AUTHORIZATION_ENDPOINT,
			tokenEndpoint: TOKEN_ENDPOINT,
		});
		expect(fetchMock).toHaveBeenCalledWith(XAI_OAUTH_DISCOVERY_URL, expect.any(Object));
	});

	it("rejects OAuth discovery endpoints outside x.ai", async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						authorization_endpoint: "https://evil.example/oauth2/authorize",
						token_endpoint: TOKEN_ENDPOINT,
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				),
		);
		global.fetch = fetchMock as unknown as typeof fetch;

		await expect(discoverXaiOAuthEndpoints()).rejects.toThrow(/unexpected endpoint/i);
	});

	it("builds a PKCE browser authorization URL", async () => {
		const fetchMock = vi.fn(async () => discoveryResponse());
		global.fetch = fetchMock as unknown as typeof fetch;
		const flow = new XaiOAuthFlow({ onAuth: () => {}, onPrompt: async () => "" });
		expect(flow.redirectUri).toBe("http://127.0.0.1:56121/callback");

		const { url } = await flow.generateAuthUrl("state-123", "http://127.0.0.1:56121/callback");
		const authUrl = new URL(url);

		expect(authUrl.origin + authUrl.pathname).toBe(AUTHORIZATION_ENDPOINT);
		expect(authUrl.searchParams.get("response_type")).toBe("code");
		expect(authUrl.searchParams.get("client_id")).toBe(XAI_OAUTH_CLIENT_ID);
		expect(authUrl.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:56121/callback");
		expect(authUrl.searchParams.get("scope")).toBe(XAI_OAUTH_SCOPE);
		expect(authUrl.searchParams.get("code_challenge_method")).toBe("S256");
		expect(authUrl.searchParams.get("code_challenge")?.length).toBeGreaterThan(20);
		expect(authUrl.searchParams.get("state")).toBe("state-123");
		expect(authUrl.searchParams.get("nonce")?.length).toBeGreaterThan(20);
	});

	it("adds provider-specific authorization metadata when requested", async () => {
		const fetchMock = vi.fn(async () => discoveryResponse());
		global.fetch = fetchMock as unknown as typeof fetch;
		const flow = new XaiOAuthFlow(
			{ onAuth: () => {}, onPrompt: async () => "" },
			{
				extraAuthorizeParams: {
					client_id: "must-not-override",
					plan: "generic",
					referrer: "gjc-grok-cli",
				},
			},
		);

		const { url } = await flow.generateAuthUrl("state-123", "http://127.0.0.1:56121/callback");
		const authUrl = new URL(url);

		expect(authUrl.searchParams.get("client_id")).toBe(XAI_OAUTH_CLIENT_ID);
		expect(authUrl.searchParams.get("plan")).toBe("generic");
		expect(authUrl.searchParams.get("referrer")).toBe("gjc-grok-cli");
	});

	it("exchanges an authorization code for refreshable OAuth credentials", async () => {
		let tokenBody = "";
		const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			if (url === XAI_OAUTH_DISCOVERY_URL) return discoveryResponse();
			if (url === TOKEN_ENDPOINT) {
				tokenBody = String(init?.body ?? "");
				return tokenResponse("access-token", "refresh-token", "account-123", "User@Example.com");
			}
			throw new Error(`Unexpected fetch: ${url}`);
		});
		global.fetch = fetchMock as unknown as typeof fetch;
		const flow = new XaiOAuthFlow({ onAuth: () => {}, onPrompt: async () => "" });
		await flow.generateAuthUrl("state-123", "http://127.0.0.1:56121/callback");

		const credentials = await flow.exchangeToken("auth-code", "state-123", "http://127.0.0.1:56121/callback");
		const tokenParams = new URLSearchParams(tokenBody);

		expect(tokenParams.get("grant_type")).toBe("authorization_code");
		expect(tokenParams.get("client_id")).toBe(XAI_OAUTH_CLIENT_ID);
		expect(tokenParams.get("code")).toBe("auth-code");
		expect(tokenParams.get("redirect_uri")).toBe("http://127.0.0.1:56121/callback");
		expect(tokenParams.get("code_verifier")?.length).toBeGreaterThan(20);
		expect(credentials).toMatchObject({
			access: "access-token",
			refresh: "refresh-token",
			accountId: "account-123",
			email: "user@example.com",
		});
		expect(credentials.expires).toBeGreaterThan(Date.now());
	});

	it("stores xAI login credentials as refreshable OAuth credentials", async () => {
		if (!store || !authStorage) throw new Error("test setup failed");
		const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			if (url === XAI_OAUTH_DISCOVERY_URL) return discoveryResponse();
			if (url === TOKEN_ENDPOINT) {
				expect(String(init?.body ?? "")).toContain("grant_type=authorization_code");
				return tokenResponse("access-login", "refresh-login", "account-login", "login@example.com");
			}
			throw new Error(`Unexpected fetch: ${url}`);
		});
		global.fetch = fetchMock as unknown as typeof fetch;
		await authStorage.set("xai", { type: "api_key", key: "legacy-api-key" });

		await authStorage.login("xai", {
			onAuth: info => {
				const authUrl = new URL(info.url);
				const redirectUri = authUrl.searchParams.get("redirect_uri");
				const state = authUrl.searchParams.get("state");
				if (!redirectUri || !state) throw new Error("missing redirect_uri/state");
				queueMicrotask(() => {
					void dispatchLocalCallback(`${redirectUri}?code=login-code&state=${state}`);
				});
			},
			onPrompt: async () => "",
			onManualCodeInput: () => new Promise<string>(() => {}),
		});

		const credentials = store.listAuthCredentials("xai");
		expect(credentials).toHaveLength(1);
		expect(credentials[0]?.credential).toMatchObject({
			type: "oauth",
			access: "access-login",
			refresh: "refresh-login",
			accountId: "account-login",
			email: "login@example.com",
		});
		await withEnv(SUPPRESS_XAI_ENV, async () => {
			expect(await authStorage?.getApiKey("xai", "session-xai-login")).toBe("access-login");
		});
	});

	it("refreshes expired xAI OAuth credentials with the refresh token", async () => {
		let tokenBody = "";
		const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			if (url === XAI_OAUTH_DISCOVERY_URL) return discoveryResponse();
			if (url === TOKEN_ENDPOINT) {
				tokenBody = String(init?.body ?? "");
				return tokenResponse("access-rotated", "refresh-rotated", "account-rotated", "rotated@example.com");
			}
			throw new Error(`Unexpected fetch: ${url}`);
		});
		global.fetch = fetchMock as unknown as typeof fetch;
		const credentials: OAuthCredentials = {
			access: "access-old",
			refresh: "refresh-old",
			expires: Date.now() - 60_000,
		};

		const refreshed = await refreshOAuthToken("xai", credentials);
		const tokenParams = new URLSearchParams(tokenBody);

		expect(tokenParams.get("grant_type")).toBe("refresh_token");
		expect(tokenParams.get("client_id")).toBe(XAI_OAUTH_CLIENT_ID);
		expect(tokenParams.get("refresh_token")).toBe("refresh-old");
		expect(refreshed).toMatchObject({
			access: "access-rotated",
			refresh: "refresh-rotated",
			accountId: "account-rotated",
			email: "rotated@example.com",
		});
	});

	it("adds provider-specific refresh metadata when requested", async () => {
		let tokenBody = "";
		const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			if (url === XAI_OAUTH_DISCOVERY_URL) return discoveryResponse();
			if (url === TOKEN_ENDPOINT) {
				tokenBody = String(init?.body ?? "");
				return tokenResponse("access-build", "refresh-build", "account-build", "build@example.com");
			}
			throw new Error(`Unexpected fetch: ${url}`);
		});
		global.fetch = fetchMock as unknown as typeof fetch;

		const refreshed = await refreshXaiToken("refresh-old", {
			extraTokenParams: {
				client_id: "must-not-override",
				plan: "generic",
				referrer: "gjc-grok-cli",
				scope: XAI_OAUTH_SCOPE,
			},
		});
		const tokenParams = new URLSearchParams(tokenBody);

		expect(tokenParams.get("grant_type")).toBe("refresh_token");
		expect(tokenParams.get("client_id")).toBe(XAI_OAUTH_CLIENT_ID);
		expect(tokenParams.get("refresh_token")).toBe("refresh-old");
		expect(tokenParams.get("plan")).toBe("generic");
		expect(tokenParams.get("referrer")).toBe("gjc-grok-cli");
		expect(tokenParams.get("scope")).toBe(XAI_OAUTH_SCOPE);
		expect(refreshed).toMatchObject({
			access: "access-build",
			refresh: "refresh-build",
			accountId: "account-build",
			email: "build@example.com",
		});
	});
});
