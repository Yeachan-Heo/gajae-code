import { beforeEach, describe, expect, it } from "bun:test";
import type { AuthStorage } from "../../../src/session/auth-storage";
import {
	inferNativeProviderFromModel,
	resolveProviderChain,
	setPreferredSearchProvider,
	setSearchFallbackProviders,
} from "../../../src/web/search/provider";
import type { ActiveSearchModelContext } from "../../../src/web/search/types";

function auth(providers: string[] = []): AuthStorage {
	const set = new Set(providers);
	return {
		hasAuth: (provider: string) => set.has(provider),
		hasOAuth: (provider: string) => set.has(provider),
		getOAuthAccess: (provider: string) => (set.has(provider) ? `${provider}-oauth` : undefined),
		getApiKey: (provider: string) => (set.has(provider) ? `${provider}-key` : undefined),
	} as unknown as AuthStorage;
}

async function ids(ctx?: ActiveSearchModelContext, opts: { preferred?: any; fallback?: any[]; auth?: string[] } = {}) {
	const providers = await resolveProviderChain({
		authStorage: auth(opts.auth),
		preferredProvider: opts.preferred ?? "auto",
		activeModelContext: ctx,
		fallbackProviders: opts.fallback ?? [],
	});
	return providers.map(p => p.id);
}

beforeEach(() => {
	setPreferredSearchProvider("auto");
	setSearchFallbackProviders([]);
});

describe("native web-search provider resolution", () => {
	it("infers Anthropic native search for proxy Claude context with Anthropic credentials", async () => {
		await expect(
			ids(
				{
					provider: "proxy",
					modelId: "claude-sonnet-4",
					api: "anthropic-messages",
					baseUrl: "https://proxy.example",
				},
				{ auth: ["anthropic"] },
			),
		).resolves.toEqual(["anthropic", "duckduckgo"]);
	});

	it("keeps local OpenAI-compatible auto contexts away from codex and generic even with Codex OAuth", async () => {
		await expect(
			ids(
				{ provider: "local", modelId: "gpt-oss", api: "openai-responses", baseUrl: "http://localhost:11434" },
				{ auth: ["openai-codex", "codex"] },
			),
		).resolves.toEqual(["duckduckgo"]);
	});

	it("does not map provider id openai to hosted codex for local OpenAI-compatible auto contexts", async () => {
		await expect(
			ids(
				{
					provider: "openai",
					modelId: "gpt-oss",
					api: "openai-responses",
					baseUrl: "http://localhost:11434/v1",
					webSearch: "auto",
				},
				{ auth: ["openai-codex", "codex"] },
			),
		).resolves.toEqual(["duckduckgo"]);
	});

	it("still maps provider id openai to hosted codex for non-local auto contexts", async () => {
		await expect(
			ids(
				{
					provider: "openai",
					modelId: "gpt-5",
					api: "openai-responses",
					baseUrl: "https://api.openai.com/v1",
					webSearch: "auto",
				},
				{ auth: ["openai-codex", "codex"] },
			),
		).resolves.toEqual(["codex", "duckduckgo"]);
	});

	it("maps xAI active models to native xAI search without generic OpenAI-compatible fallback", async () => {
		await expect(
			ids(
				{
					provider: "xai",
					modelId: "grok-4.3",
					api: "openai-completions",
					baseUrl: "https://api.x.ai/v1",
					webSearch: "on",
				},
				{ auth: ["xai"] },
			),
		).resolves.toEqual(["xai", "duckduckgo"]);
	});

	it("infers xAI native search for Grok contexts behind proxies and suppresses generic fallback", async () => {
		const ctx: ActiveSearchModelContext = {
			provider: "proxy",
			modelId: "grok-4.3",
			api: "openai-completions",
			baseUrl: "https://api.x.ai/v1",
			webSearch: "on",
		};

		expect(inferNativeProviderFromModel(ctx)).toBe("xai");
		await expect(ids(ctx, { auth: ["xai", "proxy"] })).resolves.toEqual(["xai", "duckduckgo"]);
	});

	it("uses xAI wire model ids for native search inference", async () => {
		const ctx: ActiveSearchModelContext = {
			provider: "proxy",
			modelId: "routed-grok",
			wireModelId: "x-ai/grok-4-fast",
			api: "openai-completions",
			baseUrl: "https://models.example/v1",
		};

		expect(inferNativeProviderFromModel(ctx)).toBe("xai");
		await expect(ids(ctx, { auth: ["xai"] })).resolves.toEqual(["xai", "duckduckgo"]);
	});

	it("honors explicit xAI preference with availability gating before configured fallbacks", async () => {
		await expect(
			ids(undefined, { preferred: "xai", fallback: ["anthropic", "xai"], auth: ["xai", "anthropic"] }),
		).resolves.toEqual(["xai", "anthropic", "duckduckgo"]);

		await expect(
			ids(undefined, { preferred: "xai", fallback: ["anthropic", "xai"], auth: ["anthropic"] }),
		).resolves.toEqual(["anthropic", "duckduckgo"]);
	});

	it("honors forced provider first and dedupes configured fallback plus DuckDuckGo", async () => {
		await expect(
			ids(
				{ provider: "proxy", modelId: "claude-3", api: "anthropic-messages", baseUrl: "https://proxy.example" },
				{ preferred: "anthropic", fallback: ["anthropic", "duckduckgo"], auth: ["anthropic"] },
			),
		).resolves.toEqual(["anthropic", "duckduckgo"]);
	});

	it("applies fallback order with credential gating and terminal DuckDuckGo", async () => {
		await expect(ids(undefined, { fallback: ["anthropic", "duckduckgo"], auth: ["anthropic"] })).resolves.toEqual([
			"anthropic",
			"duckduckgo",
		]);
		await expect(ids(undefined, { fallback: ["anthropic", "duckduckgo"], auth: [] })).resolves.toEqual([
			"duckduckgo",
		]);
	});

	it("falls back to DuckDuckGo when nothing is known or credentialed", async () => {
		await expect(
			ids({ provider: "unknown", modelId: "mystery", api: "openai-completions", baseUrl: "https://models.example" }),
		).resolves.toEqual(["duckduckgo"]);
	});

	it("webSearch on enables generic for local OpenAI-compatible only with exact active-provider credentials", async () => {
		const ctx = {
			provider: "local",
			modelId: "gpt-local",
			api: "openai-responses",
			baseUrl: "http://127.0.0.1:8080",
			webSearch: "on" as const,
		};
		await expect(ids(ctx, { auth: ["local"] })).resolves.toEqual(["openai-compatible", "duckduckgo"]);
		await expect(ids(ctx, { auth: [] })).resolves.toEqual(["duckduckgo"]);
	});

	it("webSearch off disables inferred native and generic while global forced primary still works", async () => {
		const ctx = {
			provider: "proxy",
			modelId: "claude-3",
			api: "anthropic-messages",
			baseUrl: "https://proxy.example",
			webSearch: "off" as const,
		};
		await expect(ids(ctx, { auth: ["anthropic"] })).resolves.toEqual(["duckduckgo"]);
		await expect(ids(ctx, { preferred: "anthropic", auth: ["anthropic"] })).resolves.toEqual([
			"anthropic",
			"duckduckgo",
		]);
	});

	it("maps only corroborated hosted model families when native credentials exist", async () => {
		await expect(
			ids(
				{
					provider: "proxy",
					modelId: "gemini-2.5-pro",
					api: "google-generative-ai",
					baseUrl: "https://proxy.example",
				},
				{ auth: ["google-gemini-cli"] },
			),
		).resolves.toEqual(["gemini", "duckduckgo"]);
		await expect(
			ids(
				{ provider: "proxy", modelId: "gpt-5", api: "openai-responses", baseUrl: "https://models.example" },
				{ auth: ["openai-codex", "proxy"] },
			),
		).resolves.toEqual(["codex", "openai-compatible", "duckduckgo"]);
		await expect(
			ids(
				{ provider: "proxy", modelId: "gpt-5", api: "anthropic-messages", baseUrl: "https://models.example" },
				{ auth: ["openai-codex", "proxy"] },
			),
		).resolves.toEqual(["duckduckgo"]);
	});
});
