import { describe, expect, it } from "bun:test";

import { getBundledModel, getBundledModels } from "../src/models";
import { DEFAULT_MODEL_PER_PROVIDER, PROVIDER_DESCRIPTORS } from "../src/provider-models/descriptors";
import { buildAnthropicClientOptions, buildAnthropicHeaders } from "../src/providers/anthropic";
import { complete, formatMissingApiKeyError, getEnvApiKey } from "../src/stream";
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

	it("bundles the Claude lane on the Anthropic Messages transport", () => {
		const claude = getBundledModels("jetbrains-junie").filter(m => m.id.startsWith("claude-"));
		expect(claude.map(m => m.id).sort()).toEqual([
			"claude-fable-5",
			"claude-opus-4-6",
			"claude-opus-4-7",
			"claude-opus-4-8",
			"claude-opus-5",
			"claude-sonnet-4-6",
			"claude-sonnet-5",
		]);
		for (const model of claude) {
			expect(model.api).toBe("anthropic-messages");
			// The Anthropic transport supplies its own /v1 prefix.
			expect(model.baseUrl).toBe(JUNIE_BASE_URL);
			expect(model.headers?.["X-LLM-Model"]).toBe("anthropic");
			expect(model.headers?.["X-Keep-Path"]).toBe("true");
			// Gateway-enforced ceilings, probed live. Junie CLI sends far smaller
			// per-model budgets (20k-60k), but those are its own policy, not the
			// endpoint limit -- do not copy them back in.
			expect(model.contextWindow).toBe(1_000_000);
			expect(model.maxTokens).toBe(128_000);
		}
	});

	it("bundles the GPT lane with the /v1-prefixed base URL the OpenAI transports need", () => {
		const gpt = getBundledModels("jetbrains-junie").filter(m => m.id.startsWith("gpt-"));
		expect(gpt.map(m => m.id).sort()).toEqual([
			"gpt-5-2025-08-07",
			"gpt-5.2-2025-12-11",
			"gpt-5.3-codex",
			"gpt-5.4",
			"gpt-5.5",
			"gpt-5.6-luna",
			"gpt-5.6-sol",
			"gpt-5.6-terra",
		]);
		for (const model of gpt) {
			// The OpenAI transports append a bare /chat/completions or /responses,
			// so without this suffix every GPT request 404s on the gateway.
			expect(model.baseUrl).toBe(`${JUNIE_BASE_URL}/v1`);
			expect(model.headers?.["X-LLM-Model"]).toBe("openai");
			expect(model.maxTokens).toBe(128_000);
		}
		// gpt-5.3-codex is Responses-only; Chat Completions rejects it outright.
		const byId = new Map(gpt.map(m => [m.id, m]));
		expect(byId.get("gpt-5.3-codex")?.api).toBe("openai-responses");
		expect(byId.get("gpt-5.6-sol")?.api).toBe("openai-completions");
		// GPT is capped lower than Claude, and a generic GPT-5.5 policy must not
		// raise it back to 1M for this provider.
		expect(byId.get("gpt-5.5")?.contextWindow).toBe(922_000);
		expect(byId.get("gpt-5.6-sol")?.contextWindow).toBe(922_000);
	});

	it("excludes the CLI-only aliases the gateway rejects", () => {
		const ids = new Set(getBundledModels("jetbrains-junie").map(m => m.id));
		for (const alias of ["opus", "sonnet", "gpt", "grok"]) {
			expect(ids.has(alias)).toBe(false);
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
		const defaultHeaders = new Headers(resolved.defaultHeaders);
		expect(defaultHeaders.get("authorization")).toBe(`Bearer ${API_KEY}`);
		expect(defaultHeaders.get("x-llm-model")).toBe("anthropic");
	});

	it("drives the request from JUNIE_API_KEY alone, with no explicit apiKey argument", async () => {
		const realFetch = globalThis.fetch;
		let requestUrl = "";
		let requestHeaders = new Headers();

		globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			requestUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			requestHeaders = new Headers(input instanceof Request ? input.headers : undefined);
			new Headers(init?.headers).forEach((value, key) => {
				requestHeaders.set(key, value);
			});
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
		expect(requestHeaders.get("authorization")).toBe(`Bearer ${API_KEY}`);
		expect(requestHeaders.has("x-api-key")).toBe(false);
		expect(requestHeaders.get("x-llm-model")).toBe("anthropic");
	});

	it("tells the user where to get a key, and does not offer a login flow", () => {
		const message = formatMissingApiKeyError("jetbrains-junie");
		expect(message).toContain("JUNIE_API_KEY");
		expect(message).toContain("https://junie.jetbrains.com/cli");
		// There is no OAuth for this provider; suggesting /login would dead-end the user.
		expect(message).not.toContain("/login");
	});

	it("exposes no OAuth login surface", () => {
		expect(getOAuthProviders().some(p => p.id === "jetbrains-junie")).toBe(false);
	});
});
