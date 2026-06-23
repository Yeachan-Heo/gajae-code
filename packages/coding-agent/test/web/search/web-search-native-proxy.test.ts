import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { hookFetch } from "@gajae-code/utils";
import type { AuthStorage } from "../../../src/session/auth-storage";
import { AnthropicProvider } from "../../../src/web/search/providers/anthropic";
import { GeminiProvider } from "../../../src/web/search/providers/gemini";
import type { ActiveSearchModelContext } from "../../../src/web/search/types";

/** Auth storage where only `keys[provider]` resolves an API key (no OAuth). */
function keyAuth(keys: Record<string, string> = {}): AuthStorage {
	return {
		hasAuth: (provider: string) => Boolean(keys[provider]),
		hasOAuth: () => false,
		getOAuthAccess: () => undefined,
		getApiKey: (provider: string) => keys[provider],
		getSessionCredentialType: () => "api-key",
	} as unknown as AuthStorage;
}

const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
	for (const key of ["ANTHROPIC_SEARCH_API_KEY", "ANTHROPIC_SEARCH_BASE_URL", "ANTHROPIC_BASE_URL"]) {
		savedEnv[key] = process.env[key];
		delete process.env[key];
	}
});

afterEach(() => {
	for (const [key, value] of Object.entries(savedEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

describe("Anthropic native search over a proxy", () => {
	const ctx: ActiveSearchModelContext = {
		provider: "proxy",
		modelId: "claude-sonnet-4",
		wireModelId: "anthropic/claude-sonnet-4",
		api: "anthropic-messages",
		baseUrl: "https://proxy.example",
		headers: { "X-Tenant": "acme" },
	};

	it("reuses the active model's own key + baseUrl when canonical creds are absent", async () => {
		let capturedUrl = "";
		let capturedHeaders: Record<string, string> = {};
		let capturedModel = "";
		using _hook = hookFetch(async (input, init) => {
			capturedUrl = String(input);
			capturedHeaders = (init?.headers as Record<string, string>) ?? {};
			capturedModel = JSON.parse(String(init?.body)).model;
			return Response.json({
				id: "msg-1",
				model: "claude-sonnet-4",
				usage: { input_tokens: 10, output_tokens: 20 },
				content: [
					{
						type: "web_search_tool_result",
						content: [{ type: "web_search_result", title: "Alpha", url: "https://example.com/a" }],
					},
					{ type: "text", text: "Answer." },
				],
			});
		});

		const result = await new AnthropicProvider().search({
			query: "hello",
			systemPrompt: "Use web search.",
			authStorage: keyAuth({ proxy: "sk-proxy" }),
			activeModelContext: ctx,
		});

		expect(capturedUrl).toBe("https://proxy.example/v1/messages?beta=true");
		expect(capturedModel).toBe("anthropic/claude-sonnet-4");
		expect(JSON.stringify(capturedHeaders)).toContain("sk-proxy");
		expect(capturedHeaders["X-Tenant"]).toBe("acme");
		expect(result.sources.map(s => s.url)).toEqual(["https://example.com/a"]);
	});

	it("throws when neither canonical nor active credentials resolve", async () => {
		let calls = 0;
		using _hook = hookFetch(async () => {
			calls++;
			return Response.json({});
		});
		await expect(
			new AnthropicProvider().search({
				query: "hello",
				systemPrompt: "Use web search.",
				authStorage: keyAuth(),
				activeModelContext: ctx,
			}),
		).rejects.toThrow();
		expect(calls).toBe(0);
	});
});

describe("Gemini native search over a proxy", () => {
	const ctx: ActiveSearchModelContext = {
		provider: "proxy",
		modelId: "gemini-2.5-pro",
		api: "google-generative-ai",
		baseUrl: "https://proxy.example",
		headers: { "X-Tenant": "acme" },
	};

	it("uses the Generative Language generateContent endpoint with the active key", async () => {
		let capturedUrl = "";
		let capturedHeaders: Record<string, string> = {};
		using _hook = hookFetch(async (input, init) => {
			capturedUrl = String(input);
			capturedHeaders = (init?.headers as Record<string, string>) ?? {};
			return Response.json({
				modelVersion: "gemini-2.5-pro",
				candidates: [
					{
						content: { parts: [{ text: "Answer." }] },
						groundingMetadata: {
							groundingChunks: [{ web: { uri: "https://example.com/g", title: "Gamma" } }],
							webSearchQueries: ["q"],
						},
					},
				],
			});
		});

		const result = await new GeminiProvider().search({
			query: "hello",
			systemPrompt: "Use web search.",
			authStorage: keyAuth({ proxy: "sk-proxy" }),
			activeModelContext: ctx,
		});

		expect(capturedUrl).toBe("https://proxy.example/v1beta/models/gemini-2.5-pro:generateContent");
		expect(capturedHeaders["x-goog-api-key"]).toBe("sk-proxy");
		expect(capturedHeaders["X-Tenant"]).toBe("acme");
		expect(result.sources.map(s => s.url)).toEqual(["https://example.com/g"]);
		expect(result.searchQueries).toEqual(["q"]);
	});

	it("throws 401 without performing a fetch when no active credential resolves", async () => {
		let calls = 0;
		using _hook = hookFetch(async () => {
			calls++;
			return Response.json({});
		});
		await expect(
			new GeminiProvider().search({
				query: "hello",
				systemPrompt: "Use web search.",
				authStorage: keyAuth(),
				activeModelContext: ctx,
			}),
		).rejects.toMatchObject({ provider: "gemini", status: 401 });
		expect(calls).toBe(0);
	});
});
