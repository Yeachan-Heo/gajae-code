import { beforeEach, describe, expect, it } from "bun:test";
import type { AuthStorage } from "../../../src/session/auth-storage";
import {
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
