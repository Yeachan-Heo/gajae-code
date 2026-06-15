import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { hookFetch } from "@gajae-code/utils";
import { ModelsConfigSchema } from "../../../src/config/models-config-schema";
import { SETTINGS_SCHEMA } from "../../../src/config/settings-schema";
import type { AuthStorage } from "../../../src/session/auth-storage";
import {
	inferNativeProviderFromModel,
	isLocalBaseUrl,
	resolveProviderChain,
	setPreferredSearchProvider,
	setSearchFallbackProviders,
} from "../../../src/web/search/provider";
import { OpenAICompatibleSearchProvider } from "../../../src/web/search/providers/openai-compatible";
import {
	type ActiveSearchModelContext,
	CONFIGURABLE_SEARCH_PROVIDER_IDS,
	isConfigurableSearchProviderId,
	isSearchProviderPreference,
} from "../../../src/web/search/types";

function auth(providers: string[] = [], keys: Record<string, string> = {}): AuthStorage {
	const set = new Set(providers);
	return {
		hasAuth: (provider: string) => set.has(provider) || Boolean(keys[provider]),
		hasOAuth: (provider: string) => set.has(provider) || Boolean(keys[provider]),
		getOAuthAccess: (provider: string) => (set.has(provider) || keys[provider] ? `${provider}-oauth` : undefined),
		getApiKey: (provider: string) => keys[provider] ?? (set.has(provider) ? `${provider}-key` : undefined),
	} as unknown as AuthStorage;
}

async function chainIds(
	ctx?: ActiveSearchModelContext,
	opts: { preferred?: any; fallback?: any[]; auth?: string[]; keys?: Record<string, string> } = {},
): Promise<string[]> {
	const chain = await resolveProviderChain({
		authStorage: auth(opts.auth, opts.keys),
		preferredProvider: opts.preferred ?? "auto",
		activeModelContext: ctx,
		fallbackProviders: opts.fallback ?? [],
	});
	return chain.map(provider => provider.id);
}

const hostedOpenAI: ActiveSearchModelContext = {
	provider: "custom-openai",
	modelId: "gpt-4o",
	api: "openai-responses",
	baseUrl: "https://api.openai-compatible.example/v1",
};

const providerParams = (ctx: ActiveSearchModelContext, store = auth([], { [ctx.provider]: "sk-test" })) => ({
	query: "latest research",
	systemPrompt: "Use web search.",
	authStorage: store,
	activeModelContext: ctx,
});

beforeEach(() => {
	setPreferredSearchProvider("auto");
	setSearchFallbackProviders([]);
});

afterEach(() => vi.restoreAllMocks());

describe("red-team local endpoint classification", () => {
	it("fails closed for malformed baseUrls", () => {
		for (const baseUrl of ["not a url", "http://[::1", "http://%zz", "//localhost:11434"]) {
			expect(isLocalBaseUrl(baseUrl), baseUrl).toBe(true);
		}
	});

	it("treats loopback, private, link-local, ULA, and localhost-ish endpoints as local", () => {
		const localUrls = [
			"HTTP://LOCALHOST:11434/v1",
			"http://localhost.:11434/v1",
			"http://api.localhost/v1",
			"http://model.local/v1",
			"http://host.docker.internal:8080/v1",
			"http://user:pass@127.255.1.2:8080/v1",
			"http://0.0.0.0:8080/v1",
			"http://10.255.255.255/v1",
			"http://169.254.10.20/v1",
			"http://172.16.0.1/v1",
			"http://172.31.255.255/v1",
			"http://192.168.255.255/v1",
			"http://[::1]:8080/v1",
			"http://[::]:8080/v1",
			"http://[fe80::1]:8080/v1",
			"http://[fd00::1]:8080/v1",
			"http://[fc00::1]:8080/v1",
		];
		for (const baseUrl of localUrls) expect(isLocalBaseUrl(baseUrl), baseUrl).toBe(true);
	});

	it("does not mark public boundary neighbors or credentialed-host syntax as local", () => {
		const hostedUrls = [
			"https://api.openai.com/v1",
			"https://LOCALHOST.example/v1",
			"https://user@api.example:443/v1",
			"https://172.15.255.255/v1",
			"https://172.32.0.1/v1",
			"https://169.255.0.1/v1",
			"https://[2001:4860:4860::8888]/v1",
		];
		for (const baseUrl of hostedUrls) expect(isLocalBaseUrl(baseUrl), baseUrl).toBe(false);
	});
});

describe("red-team native-provider inference", () => {
	it("does not select codex for local gpt-oss OpenAI Responses even with Codex OAuth available", async () => {
		const ctx = {
			provider: "local",
			modelId: "gpt-oss-120b",
			api: "openai-responses",
			baseUrl: "http://127.0.0.1:11434/v1",
		};
		expect(inferNativeProviderFromModel(ctx)).toBeUndefined();
		await expect(chainIds(ctx, { auth: ["codex", "openai-codex"] })).resolves.toEqual(["duckduckgo"]);
	});

	it("selects codex for hosted OpenAI-family models only when Codex credentials exist", async () => {
		await expect(chainIds(hostedOpenAI, { auth: [] })).resolves.toEqual(["duckduckgo"]);
		await expect(chainIds(hostedOpenAI, { auth: ["openai-codex"] })).resolves.toEqual(["codex", "duckduckgo"]);
	});

	it("keeps ambiguous OpenAI-family ids non-codex on local baseUrls", async () => {
		await expect(
			chainIds(
				{ provider: "local", modelId: "gpt-oss-120b", api: "openai-completions", baseUrl: "http://0.0.0.0:9999" },
				{ auth: ["openai-codex", "local"] },
			),
		).resolves.toEqual(["duckduckgo"]);
	});

	it("maps Claude over a localhost proxy to Anthropic dedicated search credentials", async () => {
		await expect(
			chainIds(
				{
					provider: "proxy",
					modelId: "claude-3-5-sonnet",
					api: "anthropic-messages",
					baseUrl: "http://localhost:8080",
				},
				{ auth: ["anthropic"] },
			),
		).resolves.toEqual(["anthropic", "duckduckgo"]);
	});

	it("webSearch off suppresses native inference and generic OpenAI-compatible probing", async () => {
		await expect(
			chainIds({ ...hostedOpenAI, webSearch: "off" }, { auth: ["openai-codex", "custom-openai"] }),
		).resolves.toEqual(["duckduckgo"]);
	});
});

describe("red-team provider chain resolution", () => {
	it("forced providers.webSearch wins and then appends deduped fallback plus DuckDuckGo", async () => {
		await expect(
			chainIds(hostedOpenAI, {
				preferred: "anthropic",
				fallback: ["anthropic", "tavily", "duckduckgo"],
				auth: ["anthropic", "tavily", "openai-codex", "custom-openai"],
			}),
		).resolves.toEqual(["anthropic", "tavily", "duckduckgo"]);
	});

	it("does not inject openai-compatible in a generic no-credential context", async () => {
		await expect(
			chainIds({ ...hostedOpenAI, provider: "no-key" }, { auth: ["openai-codex"] }),
		).resolves.not.toContain("openai-compatible");
	});

	it("skips unavailable keyed fallback providers while keeping available providers and terminal DuckDuckGo", async () => {
		await expect(
			chainIds(undefined, { fallback: ["exa", "anthropic", "duckduckgo"], auth: ["anthropic"] }),
		).resolves.toEqual(["anthropic", "duckduckgo"]);
	});

	it("does not allow openai-compatible through runtime provider preference or fallback configuration", async () => {
		expect(isConfigurableSearchProviderId("openai-compatible")).toBe(false);
		expect(isSearchProviderPreference("openai-compatible")).toBe(false);
		setPreferredSearchProvider("openai-compatible" as any);
		setSearchFallbackProviders(["openai-compatible", "anthropic"]);
		// openai-compatible is filtered out of the configured fallback; the valid
		// anthropic fallback remains. The internal provider must never appear.
		const viaModulePreference = await chainIds(undefined, { auth: ["anthropic"] });
		expect(viaModulePreference).not.toContain("openai-compatible");
		// Passing the internal id directly as a forced preferredProvider must also be
		// rejected (falls through to auto/fallback), never injected into the chain.
		const direct = await resolveProviderChain({
			authStorage: auth(["anthropic"]),
			preferredProvider: "openai-compatible" as any,
		});
		expect(direct.map(p => p.id)).not.toContain("openai-compatible");
		// restore module state for other tests
		setPreferredSearchProvider("auto");
		setSearchFallbackProviders([]);
	});

	it("never appends openai-compatible via a directly-passed fallbackProviders list", async () => {
		// Defense in depth: even if the internal id is forced into the option directly,
		// the resolver must filter it out of the fallback loop.
		const ids = await chainIds(undefined, { fallback: ["openai-compatible", "anthropic"], auth: ["anthropic"] });
		expect(ids).not.toContain("openai-compatible");
		expect(ids).toEqual(["anthropic", "duckduckgo"]);
	});
});

describe("red-team OpenAI-compatible provider behavior", () => {
	it("throws 424 on no-citation responses so executeSearch can fall through", async () => {
		using _hook = hookFetch(async () =>
			Response.json({ id: "r-no-cite", output_text: "Plain answer without grounding." }),
		);
		await expect(new OpenAICompatibleSearchProvider().search(providerParams(hostedOpenAI))).rejects.toMatchObject({
			provider: "openai-compatible",
			status: 424,
		});
	});

	it("throws HTTP errors from the provider", async () => {
		using _hook = hookFetch(async () => new Response("bad gateway", { status: 502 }));
		await expect(new OpenAICompatibleSearchProvider().search(providerParams(hostedOpenAI))).rejects.toMatchObject({
			provider: "openai-compatible",
			status: 502,
		});
	});

	it("throws 401 and performs no fetch when exact active-provider credentials are missing", async () => {
		let calls = 0;
		using _hook = hookFetch(async () => {
			calls++;
			return Response.json({});
		});
		await expect(
			new OpenAICompatibleSearchProvider().search(providerParams(hostedOpenAI, auth())),
		).rejects.toMatchObject({
			provider: "openai-compatible",
			status: 401,
		});
		expect(calls).toBe(0);
	});

	it("does not treat bare prose URLs as citations", async () => {
		using _hook = hookFetch(async () =>
			Response.json({
				id: "r-bare-url",
				output_text: "I found https://example.com in prose, but there is no structured source annotation.",
			}),
		);
		await expect(new OpenAICompatibleSearchProvider().search(providerParams(hostedOpenAI))).rejects.toMatchObject({
			status: 424,
		});
	});

	it("keeps concurrent baseUrls, headers, models, and auth isolated", async () => {
		const seen: Array<{ url: string; authorization: string; tenant: string; model: string }> = [];
		using _hook = hookFetch(async (input, init) => {
			const headers = init?.headers as Record<string, string>;
			const body = JSON.parse(String(init?.body));
			seen.push({
				url: String(input),
				authorization: headers.Authorization,
				tenant: headers["X-Tenant"],
				model: body.model,
			});
			return Response.json({
				id: `resp-${body.model}`,
				output_text: "grounded",
				output: [
					{
						content: [
							{
								annotations: [
									{ type: "url_citation", url: `https://${body.model}.example`, title: body.model },
								],
							},
						],
					},
				],
			});
		});
		const provider = new OpenAICompatibleSearchProvider();
		await Promise.all([
			provider.search(
				providerParams(
					{
						...hostedOpenAI,
						provider: "tenant-a",
						modelId: "gpt-4o-a",
						baseUrl: "https://a.example/v1",
						headers: { "X-Tenant": "a" },
					},
					auth([], { "tenant-a": "sk-a" }),
				),
			),
			provider.search(
				providerParams(
					{
						...hostedOpenAI,
						provider: "tenant-b",
						modelId: "gpt-4o-b",
						baseUrl: "https://b.example/v1",
						headers: { "X-Tenant": "b" },
					},
					auth([], { "tenant-b": "sk-b" }),
				),
			),
		]);
		expect(seen).toEqual(
			expect.arrayContaining([
				{ url: "https://a.example/v1/responses", authorization: "Bearer sk-a", tenant: "a", model: "gpt-4o-a" },
				{ url: "https://b.example/v1/responses", authorization: "Bearer sk-b", tenant: "b", model: "gpt-4o-b" },
			]),
		);
	});

	it("passes abort signals through to fetch without mutating request context", async () => {
		const ac = new AbortController();
		let captured: AbortSignal | undefined | null;
		using _hook = hookFetch(async (_input, init) => {
			captured = init?.signal;
			return Response.json({
				id: "abort-signal-capture",
				output_text: "grounded",
				output: [
					{
						content: [
							{ annotations: [{ type: "url_citation", url: "https://signal.example", title: "Signal" }] },
						],
					},
				],
			});
		});
		await new OpenAICompatibleSearchProvider().search({ ...providerParams(hostedOpenAI), signal: ac.signal });
		expect(captured).toBeInstanceOf(AbortSignal);
		expect(captured).not.toBe(ac.signal);
	});
});

describe("red-team schema and runtime validation guards", () => {
	it("web_search.fallback enum metadata rejects openai-compatible and unknown ids", () => {
		const fallback = SETTINGS_SCHEMA["web_search.fallback"];
		expect(fallback.type).toBe("array");
		expect(fallback.items?.enum).toEqual(CONFIGURABLE_SEARCH_PROVIDER_IDS);
		expect(fallback.items?.enum).not.toContain("openai-compatible");
		expect(fallback.items?.enum).not.toContain("totally-unknown");
		expect(isConfigurableSearchProviderId("openai-compatible")).toBe(false);
		expect(isConfigurableSearchProviderId("totally-unknown")).toBe(false);
	});

	it("providers.webSearch enum rejects invalid values including openai-compatible", () => {
		const providerSetting = SETTINGS_SCHEMA["providers.webSearch"];
		expect(providerSetting.type).toBe("enum");
		expect(providerSetting.values).not.toContain("openai-compatible");
		expect(providerSetting.values).not.toContain("totally-unknown");
		expect(isSearchProviderPreference("openai-compatible")).toBe(false);
		expect(isSearchProviderPreference("totally-unknown")).toBe(false);
	});

	it("models config provider webSearch accepts only on/off/auto", () => {
		for (const webSearch of ["on", "off", "auto"]) {
			expect(ModelsConfigSchema.safeParse({ providers: { custom: { webSearch } } }).success, webSearch).toBe(true);
		}
		expect(ModelsConfigSchema.safeParse({ providers: { custom: { webSearch: "invalid" } } }).success).toBe(false);
	});
});
