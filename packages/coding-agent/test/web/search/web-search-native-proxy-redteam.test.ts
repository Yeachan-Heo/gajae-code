import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { hookFetch } from "@gajae-code/utils";
import type { AuthStorage } from "../../../src/session/auth-storage";
import { runSearchQuery } from "../../../src/web/search";
import {
	activeContextNativeId,
	resolveProviderChain,
	setPreferredSearchProvider,
	setSearchFallbackProviders,
} from "../../../src/web/search/provider";
import { AnthropicProvider } from "../../../src/web/search/providers/anthropic";
import { GeminiProvider } from "../../../src/web/search/providers/gemini";
import type { ActiveSearchModelContext } from "../../../src/web/search/types";

function keyAuth(keys: Record<string, string> = {}): AuthStorage {
	return {
		hasAuth: (provider: string) => Boolean(keys[provider]),
		hasOAuth: () => false,
		getOAuthAccess: () => undefined,
		getApiKey: (provider: string) => keys[provider],
		getSessionCredentialType: () => "api-key",
	} as unknown as AuthStorage;
}

function oauthAuth(keys: Record<string, string> = {}): AuthStorage {
	return {
		hasAuth: (provider: string) => Boolean(keys[provider]),
		hasOAuth: (provider: string) => Boolean(keys[provider]),
		getOAuthAccess: (provider: string) =>
			keys[provider] ? { accessToken: keys[provider], projectId: `${provider}-project` } : undefined,
		getApiKey: (provider: string) => keys[provider],
		getSessionCredentialType: () => "oauth",
	} as unknown as AuthStorage;
}

async function chainIds(ctx: ActiveSearchModelContext, store: AuthStorage): Promise<string[]> {
	const chain = await resolveProviderChain({
		authStorage: store,
		preferredProvider: "auto",
		activeModelContext: ctx,
		fallbackProviders: [],
	});
	return chain.map(provider => provider.id);
}

beforeEach(() => {
	setPreferredSearchProvider("auto");
	setSearchFallbackProviders([]);
});

afterEach(() => {
	setPreferredSearchProvider("auto");
	setSearchFallbackProviders([]);
});

describe("native-over-proxy provider-chain red-team", () => {
	it("does not leak another provider's credential into active native search", async () => {
		const ctx: ActiveSearchModelContext = {
			provider: "proxy",
			modelId: "claude-sonnet-4",
			api: "anthropic-messages",
			baseUrl: "https://proxy.example",
		};

		await expect(chainIds(ctx, keyAuth({ anthropic: "sk-other-provider" }))).resolves.toEqual([
			"anthropic",
			"duckduckgo",
		]);
		await expect(chainIds(ctx, keyAuth({ openai: "sk-openai", gemini: "sk-gemini" }))).resolves.toEqual([
			"duckduckgo",
		]);
	});

	it("does not select native providers when wire protocol and model family disagree", async () => {
		const gptOnAnthropic: ActiveSearchModelContext = {
			provider: "proxy",
			modelId: "gpt-4o",
			api: "anthropic-messages",
			baseUrl: "https://proxy.example",
		};
		const claudeOnOpenAI: ActiveSearchModelContext = {
			provider: "proxy",
			modelId: "claude-sonnet-4",
			api: "openai-responses",
			baseUrl: "https://proxy.example/v1",
		};

		expect(activeContextNativeId(gptOnAnthropic)).toBeUndefined();
		expect(activeContextNativeId(claudeOnOpenAI)).toBe("openai-compatible");
		await expect(chainIds(gptOnAnthropic, keyAuth({ proxy: "sk-proxy" }))).resolves.toEqual(["duckduckgo"]);
		await expect(chainIds(claudeOnOpenAI, keyAuth({ proxy: "sk-proxy" }))).resolves.toEqual([
			"openai-compatible",
			"duckduckgo",
		]);
	});

	it("webSearch off suppresses native-over-proxy even when active credentials exist", async () => {
		const ctx: ActiveSearchModelContext = {
			provider: "proxy",
			modelId: "claude-sonnet-4",
			api: "anthropic-messages",
			baseUrl: "https://proxy.example",
			webSearch: "off",
		};

		expect(activeContextNativeId(ctx)).toBeUndefined();
		await expect(chainIds(ctx, keyAuth({ proxy: "sk-proxy", anthropic: "sk-anthropic" }))).resolves.toEqual([
			"duckduckgo",
		]);
	});

	it("does not claim openai-compatible for azure wire the adapter cannot service", async () => {
		const ctx: ActiveSearchModelContext = {
			provider: "proxy",
			modelId: "gpt-4o",
			api: "azure-openai-responses",
			baseUrl: "https://proxy.example",
		};

		expect(activeContextNativeId(ctx)).toBeUndefined();
		await expect(chainIds(ctx, keyAuth({ proxy: "sk-proxy" }))).resolves.toEqual(["duckduckgo"]);
	});
});

describe("native-over-proxy provider red-team", () => {
	it("AnthropicProvider with no canonical key and no active key throws before fetch", async () => {
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
				activeModelContext: {
					provider: "proxy",
					modelId: "claude-sonnet-4",
					api: "anthropic-messages",
					baseUrl: "https://proxy.example",
				},
			}),
		).rejects.toThrow("No Anthropic credentials found");
		expect(calls).toBe(0);
	});

	it("GeminiProvider google-generative-ai path uses active x-goog-api-key and never Cloud Code OAuth", async () => {
		let capturedUrl = "";
		let capturedHeaders: Record<string, string> = {};
		let capturedBody: any;
		using _hook = hookFetch(async (input, init) => {
			capturedUrl = String(input);
			capturedHeaders = (init?.headers as Record<string, string>) ?? {};
			capturedBody = JSON.parse(String(init?.body));
			return Response.json({
				modelVersion: "gemini-2.5-pro",
				candidates: [
					{
						content: { parts: [{ text: "Answer." }] },
						groundingMetadata: {
							groundingChunks: [{ web: { uri: "https://example.com/g", title: "Gamma" } }],
							webSearchQueries: ["hello"],
						},
					},
				],
			});
		});

		const result = await new GeminiProvider().search({
			query: "hello",
			systemPrompt: "Use web search.",
			authStorage: keyAuth({ proxy: "sk-active" }),
			activeModelContext: {
				provider: "proxy",
				modelId: "gemini-2.5-pro",
				wireModelId: "models/gemini-2.5-pro",
				api: "google-generative-ai",
				baseUrl: "https://proxy.example",
				headers: { "X-Tenant": "acme" },
			},
		});

		expect(capturedUrl).toBe("https://proxy.example/v1beta/models/models%2Fgemini-2.5-pro:generateContent");
		expect(capturedUrl).not.toContain("cloudcode-pa.googleapis.com");
		expect(capturedHeaders["x-goog-api-key"]).toBe("sk-active");
		expect(capturedHeaders.Authorization).toBeUndefined();
		expect(capturedHeaders["X-Tenant"]).toBe("acme");
		expect(capturedBody.tools).toEqual([{ googleSearch: {} }]);
		expect(result.sources.map(source => source.url)).toEqual(["https://example.com/g"]);
	});

	it("proxy no-citation responses throw so executeSearch falls through to DuckDuckGo", async () => {
		const urls: string[] = [];
		using _hook = hookFetch(async (input, init) => {
			urls.push(String(input));
			if (String(input).includes("/v1beta/models/")) {
				expect((init?.headers as Record<string, string>)["x-goog-api-key"]).toBe("sk-active");
				return Response.json({
					modelVersion: "gemini-2.5-pro",
					candidates: [{ content: { parts: [{ text: "Ungrounded answer." }] } }],
				});
			}
			return new Response("duck fallback", { status: 502 });
		});

		await expect(
			new GeminiProvider().search({
				query: "hello",
				systemPrompt: "Use web search.",
				authStorage: keyAuth({ proxy: "sk-active" }),
				activeModelContext: {
					provider: "proxy",
					modelId: "gemini-2.5-pro",
					api: "google-generative-ai",
					baseUrl: "https://proxy.example",
				},
			}),
		).rejects.toMatchObject({ provider: "gemini", status: 424 });

		const result = await runSearchQuery(
			{ query: "hello" },
			{
				authStorage: keyAuth({ proxy: "sk-active" }),
				activeModelContext: {
					provider: "proxy",
					modelId: "gemini-2.5-pro",
					api: "google-generative-ai",
					baseUrl: "https://proxy.example",
				},
			},
		);

		expect(urls.some(url => url.includes("/v1beta/models/gemini-2.5-pro:generateContent"))).toBe(true);
		expect(result.details.response.provider).toBe("duckduckgo");
		expect(result.details.error).toContain("All web search providers failed");
		expect(result.details.error).toContain("Gemini native search returned no grounding sources");
	});

	it("canonical Gemini OAuth still uses Cloud Code instead of the active Generative Language fallback", async () => {
		let capturedUrl = "";
		using _hook = hookFetch(async input => {
			capturedUrl = String(input);
			return new Response("data: {}\n\n", { headers: { "Content-Type": "text/event-stream" } });
		});

		await new GeminiProvider().search({
			query: "hello",
			systemPrompt: "Use web search.",
			authStorage: oauthAuth({ "google-gemini-cli": "oauth-active", proxy: "sk-active" }),
			activeModelContext: {
				provider: "proxy",
				modelId: "gemini-2.5-pro",
				api: "google-generative-ai",
				baseUrl: "https://proxy.example",
			},
		});

		expect(capturedUrl).toContain("https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent");
		expect(capturedUrl).not.toContain("proxy.example/v1beta");
	});

	it("does not double-append the version when the active baseUrl is already versioned", async () => {
		let capturedUrl = "";
		using _hook = hookFetch(async input => {
			capturedUrl = String(input);
			return Response.json({
				modelVersion: "gemini-2.5-pro",
				candidates: [
					{
						content: { parts: [{ text: "Answer." }] },
						groundingMetadata: { groundingChunks: [{ web: { uri: "https://example.com/g", title: "G" } }] },
					},
				],
			});
		});

		await new GeminiProvider().search({
			query: "hello",
			systemPrompt: "Use web search.",
			authStorage: keyAuth({ proxy: "sk-active" }),
			activeModelContext: {
				provider: "proxy",
				modelId: "gemini-2.5-pro",
				api: "google-generative-ai",
				baseUrl: "https://proxy.example/v1beta",
			},
		});

		expect(capturedUrl).toBe("https://proxy.example/v1beta/models/gemini-2.5-pro:generateContent");
		expect(capturedUrl).not.toContain("/v1beta/v1beta");
	});
});
