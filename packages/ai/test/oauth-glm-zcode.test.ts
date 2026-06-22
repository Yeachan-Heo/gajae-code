import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { AuthStorage, SqliteAuthCredentialStore } from "../src/auth-storage";
import { getBundledModel } from "../src/models";
import { buildAnthropicHeaders } from "../src/providers/anthropic";
import { isOAuthToken } from "../src/utils/anthropic-auth";
import { getOAuthProviders, refreshOAuthToken } from "../src/utils/oauth";
import {
	GLM_ZCODE_OAUTH_AUTHORIZE_URL,
	GLM_ZCODE_OAUTH_BROKER_TOKEN_URL,
	GLM_ZCODE_OAUTH_CLIENT_ID,
	GLM_ZCODE_OAUTH_REDIRECT_URI,
	GLM_ZCODE_ZAI_LOGIN_URL,
	GlmZcodeOAuthFlow,
	isGlmZcodeOAuthConfigured,
	refreshGlmZcodeToken,
} from "../src/utils/oauth/glm-zcode";
import type { OAuthCredentials } from "../src/utils/oauth/types";
import { withEnv } from "./helpers";

const originalFetch = global.fetch;
const USERINFO_URL = "https://chat.z.ai/api/oauth/userinfo";
const SUPPRESS_ENV = {
	GLM_ZCODE_API_KEY: undefined,
	ZAI_API_KEY: undefined,
	ZCODE_OAUTH_CLIENT_ID: undefined,
} as const;

const UPSTREAM_ZAI_TOKEN = "upstream-zai-access-token-value-1234567890";
const ZCODE_JWT = jwt({ sub: "zcode-sub-id", email: "ZJwt@Example.com" });
const BUSINESS_TOKEN = "business-token-value-abcdefghijklmnop-998877";

function jwt(payload: Record<string, unknown>): string {
	const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
	return `${encode({ alg: "none", typ: "JWT" })}.${encode(payload)}.`;
}

interface MockOptions {
	expiresIn?: number;
	businessToken?: string;
	userinfo?: { email?: string; id?: string } | null;
	captureBroker?: (body: string) => void;
	captureZLogin?: (body: string) => void;
	zLoginStatus?: number;
	zLoginErrorBody?: string;
	brokerPayloadOverride?: unknown;
}

function routingFetch(options: MockOptions = {}) {
	return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
		if (url === GLM_ZCODE_OAUTH_BROKER_TOKEN_URL) {
			options.captureBroker?.(String(init?.body ?? ""));
			return new Response(
				JSON.stringify(
					options.brokerPayloadOverride ?? {
						data: { token: ZCODE_JWT, zai: { access_token: UPSTREAM_ZAI_TOKEN } },
					},
				),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}
		if (url === GLM_ZCODE_ZAI_LOGIN_URL) {
			options.captureZLogin?.(String(init?.body ?? ""));
			if (options.zLoginStatus && options.zLoginStatus >= 400) {
				return new Response(options.zLoginErrorBody ?? "rejected", { status: options.zLoginStatus });
			}
			return new Response(
				JSON.stringify({
					data: { access_token: options.businessToken ?? BUSINESS_TOKEN, expires_in: options.expiresIn ?? 3600 },
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}
		if (url === USERINFO_URL) {
			if (options.userinfo === null) return new Response("no", { status: 404 });
			const data = options.userinfo ?? { email: "Member@Example.com", id: "account-xyz" };
			return new Response(JSON.stringify({ data }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}
		throw new Error(`Unexpected fetch: ${url}`);
	});
}

describe("GLM ZCode OAuth login provider", () => {
	let tempDir = "";
	let store: SqliteAuthCredentialStore | undefined;
	let authStorage: AuthStorage | undefined;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-glm-zcode-oauth-"));
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

	it("registers glm-zcode as an available, opt-in-labeled login provider", () => {
		const provider = getOAuthProviders().find(p => p.id === "glm-zcode");
		expect(provider).toEqual({
			id: "glm-zcode",
			name: "GLM ZCode OAuth (unofficial, opt-in)",
			available: true,
		});
		expect(isGlmZcodeOAuthConfigured()).toBe(true);
	});

	it("uses the exact ZCode client id and custom-protocol redirect by default", () => {
		expect(GLM_ZCODE_OAUTH_CLIENT_ID).toBe("client_P8X5CMWmlaRO9gyO-KSqtg");
		expect(GLM_ZCODE_OAUTH_REDIRECT_URI).toBe("zcode://oauth/callback");
	});

	it("builds the authorize URL with client id, custom redirect, response_type, and state", async () => {
		const flow = new GlmZcodeOAuthFlow(
			{ onAuth: () => {}, onPrompt: async () => "" },
			{ fetch: routingFetch() as unknown as typeof fetch },
		);
		const { url, instructions } = await flow.generateAuthUrl("state-123", GLM_ZCODE_OAUTH_REDIRECT_URI);
		const authUrl = new URL(url);
		expect(authUrl.origin + authUrl.pathname).toBe(GLM_ZCODE_OAUTH_AUTHORIZE_URL);
		expect(authUrl.searchParams.get("client_id")).toBe(GLM_ZCODE_OAUTH_CLIENT_ID);
		expect(authUrl.searchParams.get("redirect_uri")).toBe(GLM_ZCODE_OAUTH_REDIRECT_URI);
		expect(authUrl.searchParams.get("response_type")).toBe("code");
		expect(authUrl.searchParams.get("state")).toBe("state-123");
		expect(instructions ?? "").toMatch(/unofficial/i);
	});

	it("runs the broker exchange then z/login and maps tokens correctly", async () => {
		let brokerBody = "";
		let zLoginBody = "";
		const fetchMock = routingFetch({
			captureBroker: body => {
				brokerBody = body;
			},
			captureZLogin: body => {
				zLoginBody = body;
			},
		});
		const flow = new GlmZcodeOAuthFlow(
			{ onAuth: () => {}, onPrompt: async () => "" },
			{ fetch: fetchMock as unknown as typeof fetch },
		);
		const credentials = await flow.exchangeToken("auth-code", "state-123", GLM_ZCODE_OAUTH_REDIRECT_URI);

		expect(JSON.parse(brokerBody)).toEqual({
			provider: "zai",
			code: "auth-code",
			redirect_uri: GLM_ZCODE_OAUTH_REDIRECT_URI,
			state: "state-123",
		});
		expect(JSON.parse(zLoginBody)).toEqual({ token: UPSTREAM_ZAI_TOKEN });

		// access = business token; refresh = plain upstream Z.AI token (NOT JSON, NOT the ZCode JWT).
		expect(credentials.access).toBe(BUSINESS_TOKEN);
		expect(credentials.refresh).toBe(UPSTREAM_ZAI_TOKEN);
		expect(() => JSON.parse(credentials.refresh)).toThrow();
		expect(credentials.refresh).not.toBe(ZCODE_JWT);
		expect(credentials.email).toBe("member@example.com");
		expect(credentials.accountId).toBe("account-xyz");
		expect(credentials.expires).toBeGreaterThan(Date.now());
		// 2-minute refresh skew applied.
		expect(credentials.expires).toBeLessThanOrEqual(Date.now() + 3600 * 1000 - 60_000);
	});

	it("accepts a pasted full zcode:// redirect URL as the code", async () => {
		const fetchMock = routingFetch();
		const flow = new GlmZcodeOAuthFlow(
			{ onAuth: () => {}, onPrompt: async () => "" },
			{ fetch: fetchMock as unknown as typeof fetch },
		);
		const credentials = await flow.exchangeToken(
			"zcode://oauth/callback?code=pasted-code&state=state-123",
			"state-123",
			GLM_ZCODE_OAUTH_REDIRECT_URI,
		);
		expect(credentials.access).toBe(BUSINESS_TOKEN);
		const brokerCall = fetchMock.mock.calls.find(c => String(c[0]) === GLM_ZCODE_OAUTH_BROKER_TOKEN_URL);
		expect(JSON.parse(String((brokerCall?.[1] as RequestInit).body)).code).toBe("pasted-code");
	});

	it("falls back to JWT identity decode when userinfo fails", async () => {
		const fetchMock = routingFetch({ userinfo: null });
		const flow = new GlmZcodeOAuthFlow(
			{ onAuth: () => {}, onPrompt: async () => "" },
			{ fetch: fetchMock as unknown as typeof fetch },
		);
		const credentials = await flow.exchangeToken("auth-code", "state-123", GLM_ZCODE_OAUTH_REDIRECT_URI);
		expect(credentials.email).toBe("zjwt@example.com");
		expect(credentials.accountId).toBe("zcode-sub-id");
	});

	it("re-mints the business token on refresh via z/login using the stored upstream token", async () => {
		let zLoginBody = "";
		const fetchMock = routingFetch({
			businessToken: "business-token-rotated-zzz-2222222222",
			captureZLogin: body => {
				zLoginBody = body;
			},
		});
		const credentials: OAuthCredentials = {
			access: "business-old",
			refresh: UPSTREAM_ZAI_TOKEN,
			expires: Date.now() - 60_000,
			email: "member@example.com",
			accountId: "account-xyz",
		};
		const refreshed = await refreshGlmZcodeToken(credentials, { fetch: fetchMock as unknown as typeof fetch });
		expect(JSON.parse(zLoginBody)).toEqual({ token: UPSTREAM_ZAI_TOKEN });
		expect(refreshed.access).toBe("business-token-rotated-zzz-2222222222");
		expect(refreshed.refresh).toBe(UPSTREAM_ZAI_TOKEN);
		expect(refreshed.email).toBe("member@example.com");
		expect(refreshed.expires).toBeGreaterThan(Date.now());
	});

	it("dispatches refreshOAuthToken('glm-zcode') to the z/login re-mint path", async () => {
		const fetchMock = routingFetch({ businessToken: "business-via-dispatch-7777777777777" });
		global.fetch = fetchMock as unknown as typeof fetch;
		const refreshed = await refreshOAuthToken("glm-zcode", {
			access: "business-old",
			refresh: UPSTREAM_ZAI_TOKEN,
			expires: Date.now() - 60_000,
		});
		expect(refreshed.access).toBe("business-via-dispatch-7777777777777");
		expect(refreshed.refresh).toBe(UPSTREAM_ZAI_TOKEN);
	});

	it("fails with a sanitized re-login error when refresh has no upstream token", async () => {
		await expect(refreshGlmZcodeToken({ access: "business", refresh: "", expires: Date.now() - 1 })).rejects.toThrow(
			/require re-login/i,
		);
	});

	it("fails with a re-login error (no expired credential returned) when z/login rejects", async () => {
		const fetchMock = routingFetch({ zLoginStatus: 401 });
		await expect(
			refreshGlmZcodeToken(
				{ access: "business-old", refresh: UPSTREAM_ZAI_TOKEN, expires: Date.now() - 1 },
				{ fetch: fetchMock as unknown as typeof fetch },
			),
		).rejects.toThrow(/require re-login/i);
	});

	it("rejects a malformed broker payload missing the upstream Z.AI token", async () => {
		const fetchMock = routingFetch({ brokerPayloadOverride: { data: { token: ZCODE_JWT } } });
		const flow = new GlmZcodeOAuthFlow(
			{ onAuth: () => {}, onPrompt: async () => "" },
			{ fetch: fetchMock as unknown as typeof fetch },
		);
		await expect(flow.exchangeToken("auth-code", "state-123", GLM_ZCODE_OAUTH_REDIRECT_URI)).rejects.toThrow(
			/broker response missing/i,
		);
	});

	it("redacts token-like strings echoed in an upstream error body", async () => {
		const leakedToken = "leaked-secret-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
		const fetchMock = routingFetch({ zLoginStatus: 500, zLoginErrorBody: `upstream said: ${leakedToken}` });
		let caught: unknown;
		try {
			await refreshGlmZcodeToken(
				{ access: "business-old", refresh: UPSTREAM_ZAI_TOKEN, expires: Date.now() - 1 },
				{ fetch: fetchMock as unknown as typeof fetch },
			);
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(Error);
		const message = String(caught);
		expect(message).toMatch(/require re-login/i);
		expect(message).not.toContain(leakedToken);
		expect(message).toContain("[redacted]");
	});

	it("stores glm-zcode login as OAuth and getApiKey returns the business token", async () => {
		if (!store || !authStorage) throw new Error("test setup failed");
		const fetchMock = routingFetch();
		global.fetch = fetchMock as unknown as typeof fetch;

		let capturedState: string | undefined;
		await authStorage.login("glm-zcode", {
			onAuth: info => {
				capturedState = new URL(info.url).searchParams.get("state") ?? undefined;
			},
			onPrompt: async () => "",
			onManualCodeInput: async () => `zcode://oauth/callback?code=login-code&state=${capturedState ?? ""}`,
		});

		const credentials = store.listAuthCredentials("glm-zcode");
		expect(credentials).toHaveLength(1);
		expect(credentials[0]?.credential).toMatchObject({
			type: "oauth",
			access: BUSINESS_TOKEN,
			refresh: UPSTREAM_ZAI_TOKEN,
		});
		await withEnv(SUPPRESS_ENV, async () => {
			expect(await authStorage?.getApiKey("glm-zcode", "session-glm-zcode")).toBe(BUSINESS_TOKEN);
		});
	});

	it("coexists with the legacy zai API-key provider without cross-contamination", async () => {
		if (!store || !authStorage) throw new Error("test setup failed");
		const fetchMock = routingFetch();
		global.fetch = fetchMock as unknown as typeof fetch;

		await authStorage.set("zai", { type: "api_key", key: "legacy-zai-key" });

		let capturedState: string | undefined;
		await authStorage.login("glm-zcode", {
			onAuth: info => {
				capturedState = new URL(info.url).searchParams.get("state") ?? undefined;
			},
			onPrompt: async () => "",
			onManualCodeInput: async () => `zcode://oauth/callback?code=login-code&state=${capturedState ?? ""}`,
		});

		// Legacy zai stays an API key under its own provider.
		const zaiCreds = store.listAuthCredentials("zai");
		expect(zaiCreds).toHaveLength(1);
		expect(zaiCreds[0]?.credential).toMatchObject({ type: "api_key" });
		const glmCreds = store.listAuthCredentials("glm-zcode");
		expect(glmCreds).toHaveLength(1);
		expect(glmCreds[0]?.credential).toMatchObject({ type: "oauth" });

		await withEnv(SUPPRESS_ENV, async () => {
			expect(await authStorage?.getApiKey("zai", "session-zai")).toBe("legacy-zai-key");
			expect(await authStorage?.getApiKey("glm-zcode", "session-glm")).toBe(BUSINESS_TOKEN);
		});
	});

	it("exposes a statically bundled glm-zcode/glm-5.2 model selectable without live credentials", () => {
		const model = getBundledModel("glm-zcode", "glm-5.2");
		expect(model).toBeDefined();
		expect(model.provider).toBe("glm-zcode");
		expect(model.api).toBe("anthropic-messages");
		expect(model.baseUrl).toBe("https://api.z.ai/api/anthropic");
	});

	it("sends Authorization: Bearer (no x-api-key, no claude-cli UA, no isOAuth) for the GLM business token", () => {
		// GLM base is not api.anthropic.com → the non-Anthropic-base branch emits a
		// plain bearer. isOAuth must NOT be set; the business token is not a Claude
		// OAuth token, so no Claude-Code header/tool-prefix behavior applies.
		expect(isOAuthToken(BUSINESS_TOKEN)).toBe(false);
		const headers = buildAnthropicHeaders({
			apiKey: BUSINESS_TOKEN,
			baseUrl: "https://api.z.ai/api/anthropic",
		});
		expect(headers.Authorization).toBe(`Bearer ${BUSINESS_TOKEN}`);
		expect(headers["X-Api-Key"]).toBeUndefined();
		expect((headers["User-Agent"] ?? "").toLowerCase().startsWith("claude-cli")).toBe(false);
	});
});
