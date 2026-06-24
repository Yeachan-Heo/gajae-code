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

async function chainIds(ctx?: ActiveSearchModelContext, providers: string[] = []): Promise<string[]> {
	const chain = await resolveProviderChain({
		authStorage: auth(providers),
		preferredProvider: "auto",
		activeModelContext: ctx,
		fallbackProviders: [],
	});
	return chain.map(provider => provider.id);
}

function openAIContext(
	baseUrl: string | undefined,
	overrides: Partial<ActiveSearchModelContext> = {},
): ActiveSearchModelContext {
	return {
		provider: "openai",
		modelId: "gpt-5",
		api: "openai-responses",
		baseUrl,
		...overrides,
	};
}

beforeEach(() => {
	setPreferredSearchProvider("auto");
	setSearchFallbackProviders([]);
});

describe("codex official-endpoint gate red-team", () => {
	it("selects codex for official OpenAI and ChatGPT endpoints only", async () => {
		for (const baseUrl of [
			"https://api.openai.com/v1",
			"https://chatgpt.com/backend-api",
			"https://eu.api.openai.com/v1",
		]) {
			const ctx = openAIContext(baseUrl);
			expect(inferNativeProviderFromModel(ctx), baseUrl).toBe("codex");
			await expect(chainIds(ctx, ["openai-codex"]), baseUrl).resolves.toEqual(["codex", "duckduckgo"]);
		}
	});

	it("fails closed for hostname-spoofed OpenAI-looking base URLs", async () => {
		for (const baseUrl of [
			"https://api.openai.com.evil.com/v1",
			"https://notopenai.com/v1",
			"https://openai.com.attacker.test/v1",
			"https://chatgpt.com.evil.com/backend-api",
		]) {
			const ctx = openAIContext(baseUrl, { provider: "proxy" });
			expect(inferNativeProviderFromModel(ctx), baseUrl).toBeUndefined();
			await expect(chainIds(ctx, ["openai-codex", "proxy"]), baseUrl).resolves.toEqual([
				"openai-compatible",
				"duckduckgo",
			]);
			await expect(chainIds(ctx, ["openai-codex"]), baseUrl).resolves.toEqual(["duckduckgo"]);
		}
	});

	it("treats absent or empty OpenAI baseUrl as default hosted OpenAI", async () => {
		for (const baseUrl of [undefined, "", "   "]) {
			const ctx = openAIContext(baseUrl);
			expect(inferNativeProviderFromModel(ctx), String(baseUrl)).toBe("codex");
			await expect(chainIds(ctx, ["openai-codex"]), String(baseUrl)).resolves.toEqual(["codex", "duckduckgo"]);
		}
	});

	it("fails closed for malformed baseUrl instead of selecting codex", async () => {
		const ctx = openAIContext("not a url", { provider: "proxy" });
		expect(inferNativeProviderFromModel(ctx)).toBeUndefined();
		await expect(chainIds(ctx, ["openai-codex", "proxy"])).resolves.toEqual(["openai-compatible", "duckduckgo"]);
		await expect(chainIds(ctx, ["openai-codex"])).resolves.toEqual(["duckduckgo"]);
	});

	it("keeps reported custom proxy Codex-named scenario on openai-compatible, never codex", async () => {
		const ctx: ActiveSearchModelContext = {
			provider: "custom-proxy",
			modelId: "gpt-codex-proxy",
			wireModelId: "gpt-5-codex",
			api: "openai-completions",
			baseUrl: "https://models.internal.example/v1",
			webSearch: "on",
		};

		expect(inferNativeProviderFromModel(ctx)).toBeUndefined();
		await expect(chainIds(ctx, ["openai-codex", "custom-proxy"])).resolves.toEqual([
			"openai-compatible",
			"duckduckgo",
		]);
	});

	it("webSearch off suppresses codex inference and provider-chain insertion", async () => {
		const ctx = openAIContext("https://api.openai.com/v1", { webSearch: "off" });
		expect(inferNativeProviderFromModel(ctx)).toBeUndefined();
		await expect(chainIds(ctx, ["openai-codex"])).resolves.toEqual(["duckduckgo"]);
	});
});
