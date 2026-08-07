import { describe, expect, it } from "bun:test";

import { getBundledModel, getBundledModels } from "../src/models";
import { DEFAULT_MODEL_PER_PROVIDER, PROVIDER_DESCRIPTORS } from "../src/provider-models/descriptors";
import { buildAnthropicClientOptions, buildAnthropicHeaders } from "../src/providers/anthropic";
import { complete, getEnvApiKey } from "../src/stream";
import { KNOWN_PROVIDERS } from "../src/types";
import { getOAuthProviders } from "../src/utils/oauth";
import { withEnv } from "./helpers";

const JUNIE_BASE_URL = "https://ingrazzio-cloud-prod.labs.jb.gg";
const API_KEY = "junie-test-token";

describe("JetBrains Junie provider", () => {
	it("is a known provider with claude-sonnet-4-6 as its default model", () => {
		expect(KNOWN_PROVIDERS).toContain("jetbrains-junie");
		expect(PROVIDER_DESCRIPTORS.some(d => d.providerId === "jetbrains-junie")).toBe(true);
		expect(DEFAULT_MODEL_PER_PROVIDER["jetbrains-junie"]).toBe("claude-sonnet-4-6");
	});

	it("resolves credentials from JUNIE_API_KEY only", () => {
		withEnv({ JUNIE_API_KEY: API_KEY }, () => {
			expect(getEnvApiKey("jetbrains-junie")).toBe(API_KEY);
		});
		withEnv({ JUNIE_API_KEY: undefined }, () => {
			expect(getEnvApiKey("jetbrains-junie")).toBeUndefined();
		});
	});

	it("bundles the JetBrains-served Claude catalog on the Ingrazzio gateway", () => {
		const models = getBundledModels("jetbrains-junie");
		expect(models.map(m => m.id).sort()).toEqual([
			"claude-opus-4-8",
			"claude-opus-5",
			"claude-sonnet-4-6",
			"claude-sonnet-5",
		]);
		for (const model of models) {
			expect(model.api).toBe("anthropic-messages");
			expect(model.baseUrl).toBe(JUNIE_BASE_URL);
			expect(model.headers?.["X-LLM-Model"]).toBe("anthropic");
			expect(model.headers?.["X-Keep-Path"]).toBe("true");
		}
	});

	it("sends only Authorization: Bearer, never X-Api-Key", () => {
		const headers = buildAnthropicHeaders({ apiKey: API_KEY, baseUrl: JUNIE_BASE_URL });
		expect(headers.Authorization).toBe(`Bearer ${API_KEY}`);
		expect(headers["X-Api-Key"]).toBeUndefined();
	});

	it("blocks the SDK from appending its own X-Api-Key header", () => {
		const model = getBundledModel("jetbrains-junie", "claude-sonnet-4-6") as Parameters<
			typeof buildAnthropicClientOptions
		>[0]["model"];
		const resolved = buildAnthropicClientOptions({ model, apiKey: API_KEY });

		// The SDK adds `X-Api-Key` whenever `apiKey` is set; JetBrains AI rejects that.
		expect(resolved.apiKey).toBeNull();
		expect(resolved.authToken).toBeNull();
		expect(resolved.isOAuthToken).toBe(false);
		expect(resolved.baseURL).toBe(JUNIE_BASE_URL);
		expect(resolved.defaultHeaders?.Authorization).toBe(`Bearer ${API_KEY}`);
		expect(resolved.defaultHeaders?.["X-LLM-Model"]).toBe("anthropic");
	});

	it("drives the request from JUNIE_API_KEY alone, with no explicit apiKey argument", async () => {
		const realFetch = globalThis.fetch;
		let requestUrl = "";
		let authorization = "";
		let hasApiKeyHeader = true;

		globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			requestUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			const headers = new Headers(init?.headers);
			authorization = headers.get("authorization") ?? "";
			hasApiKeyHeader = headers.has("x-api-key");
			// Short-circuit: the assertion target is the outbound request, not the reply.
			return new Response(JSON.stringify({ type: "error", error: { type: "halted" } }), { status: 418 });
		}) as typeof globalThis.fetch;

		try {
			await withEnv({ JUNIE_API_KEY: API_KEY }, async () => {
				const model = getBundledModel("jetbrains-junie", "claude-sonnet-4-6");
				await complete(
					model,
					{ messages: [{ role: "user", content: "x", timestamp: Date.now() }] },
					{ maxTokens: 8 },
				).catch(() => undefined);
			});
		} finally {
			globalThis.fetch = realFetch;
		}

		expect(requestUrl).toBe(`${JUNIE_BASE_URL}/v1/messages`);
		expect(authorization).toBe(`Bearer ${API_KEY}`);
		expect(hasApiKeyHeader).toBe(false);
	});

	it("exposes no OAuth login surface", () => {
		expect(getOAuthProviders().some(p => p.id === "jetbrains-junie")).toBe(false);
	});
});
