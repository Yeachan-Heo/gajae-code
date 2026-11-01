// Lazy registry of web search providers.
//
// Each provider is loaded on first use; importing this module loads zero
// provider implementations. Provider modules are heavy (each pulls in
// fetch/parse/format helpers) and only one — at most — is needed per session,
// so eager construction was wasted work at startup.
//
// The `label`/`id` metadata is kept inline so callers needing a display name
// (error formatting, UI listings) do not force a load.

import type { AuthStorage } from "@gajae-code/ai/core";
import type { Settings } from "../../config/settings";
import type { SearchProvider, SearchProviderSettings } from "./providers/base";
import type { ActiveSearchModelContext, SearchProviderId } from "./types";
import { isConfigurableSearchProviderId } from "./types";

export type { SearchParams, SearchProviderSettings } from "./providers/base";
export { SearchProvider } from "./providers/base";

export function searchProviderSettings(settings?: Settings): SearchProviderSettings | undefined {
	if (!settings) return undefined;
	return {
		exa: {
			enabled: settings.get("exa.enabled"),
			enableSearch: settings.get("exa.enableSearch"),
		},
		searxng: {
			endpoint: settings.get("searxng.endpoint"),
			categories: settings.get("searxng.categories"),
			language: settings.get("searxng.language"),
		},
	};
}

interface ProviderMeta {
	id: SearchProviderId;
	label: string;
	load: () => Promise<SearchProvider>;
}

/** Lazy factories. Each `load()` dynamic-imports its provider module on first call. */
const PROVIDER_META: Record<SearchProviderId, ProviderMeta> = {
	exa: { id: "exa", label: "Exa", load: async () => new (await import("./providers/exa")).ExaProvider() },
	brave: { id: "brave", label: "Brave", load: async () => new (await import("./providers/brave")).BraveProvider() },
	jina: { id: "jina", label: "Jina", load: async () => new (await import("./providers/jina")).JinaProvider() },
	perplexity: {
		id: "perplexity",
		label: "Perplexity",
		load: async () => new (await import("./providers/perplexity")).PerplexityProvider(),
	},
	kimi: { id: "kimi", label: "Kimi", load: async () => new (await import("./providers/kimi")).KimiProvider() },
	zai: { id: "zai", label: "Z.AI", load: async () => new (await import("./providers/zai")).ZaiProvider() },
	anthropic: {
		id: "anthropic",
		label: "Anthropic",
		load: async () => new (await import("./providers/anthropic")).AnthropicProvider(),
	},
	gemini: {
		id: "gemini",
		label: "Gemini",
		load: async () => new (await import("./providers/gemini")).GeminiProvider(),
	},
	codex: { id: "codex", label: "OpenAI", load: async () => new (await import("./providers/codex")).CodexProvider() },
	xai: { id: "xai", label: "xAI", load: async () => new (await import("./providers/xai")).XaiProvider() },
	tavily: {
		id: "tavily",
		label: "Tavily",
		load: async () => new (await import("./providers/tavily")).TavilyProvider(),
	},
	parallel: {
		id: "parallel",
		label: "Parallel",
		load: async () => new (await import("./providers/parallel")).ParallelProvider(),
	},
	kagi: { id: "kagi", label: "Kagi", load: async () => new (await import("./providers/kagi")).KagiProvider() },
	synthetic: {
		id: "synthetic",
		label: "Synthetic",
		load: async () => new (await import("./providers/synthetic")).SyntheticProvider(),
	},
	searxng: {
		id: "searxng",
		label: "SearXNG",
		load: async () => new (await import("./providers/searxng")).SearXNGProvider(),
	},
	keenable: {
		id: "keenable",
		label: "Keenable",
		load: async () => new (await import("./providers/keenable")).KeenableProvider(),
	},
	duckduckgo: {
		id: "duckduckgo",
		label: "DuckDuckGo",
		load: async () => new (await import("./providers/duckduckgo")).DuckDuckGoProvider(),
	},
	insane: {
		id: "insane",
		label: "Insane",
		load: async () => new (await import("./providers/insane")).InsaneProvider(),
	},
	"openai-compatible": {
		id: "openai-compatible",
		label: "OpenAI-compatible",
		load: async () => new (await import("./providers/openai-compatible")).OpenAICompatibleSearchProvider(),
	},
};

const instanceCache = new Map<SearchProviderId, SearchProvider>();

export function getSearchProviderLabel(id: SearchProviderId): string {
	return PROVIDER_META[id]?.label ?? id;
}

export async function getSearchProvider(id: SearchProviderId): Promise<SearchProvider> {
	const cached = instanceCache.get(id);
	if (cached) return cached;
	const meta = PROVIDER_META[id];
	if (!meta) throw new Error(`Unknown search provider: ${id}`);
	const provider = await meta.load();
	instanceCache.set(id, provider);
	return provider;
}

export const SEARCH_PROVIDER_ORDER: SearchProviderId[] = [
	"duckduckgo",
	"insane",
	"tavily",
	"perplexity",
	"brave",
	"jina",
	"kimi",
	"anthropic",
	"gemini",
	"codex",
	"xai",
	"zai",
	"exa",
	"parallel",
	"kagi",
	"synthetic",
	"searxng",
	"keenable",
];

const MODEL_PROVIDER_TO_SEARCH: Record<string, SearchProviderId> = {
	openai: "codex",
	"openai-codex": "codex",
	"openai-responses": "codex",
	xai: "xai",
	anthropic: "anthropic",
	google: "gemini",
	"google-gemini-cli": "gemini",
	"google-antigravity": "gemini",
	gemini: "gemini",
	moonshot: "kimi",
	"kimi-code": "kimi",
	kimi: "kimi",
	zai: "zai",
	perplexity: "perplexity",
	synthetic: "synthetic",
};

let preferredProvId: SearchProviderId | "auto" = "auto";
let fallbackProvIds: SearchProviderId[] = [];

/**
 * Resolved-chain cache. Chain resolution probes provider availability
 * (credential lookups, potentially an OAuth refresh through the broker) on
 * every web_search call even though the result only changes when the active
 * model, provider preference, or credentials change. Cache the resolved
 * provider-id list per AuthStorage instance for a short TTL.
 *
 * Keyed by AuthStorage identity (WeakMap) so tests and short-lived CLI calls
 * with fresh storage handles never see another handle's chain. The TTL keeps
 * a login/logout mid-session from being masked for more than a minute.
 */
const CHAIN_CACHE_TTL_MS = 60_000;
let chainCache = new WeakMap<AuthStorage, Map<string, { ids: SearchProviderId[]; expires: number }>>();
const settingsCacheIds = new WeakMap<Settings, number>();
let nextSettingsCacheId = 1;

function settingsCacheId(settings: Settings | undefined): number | undefined {
	if (!settings) return undefined;
	const existing = settingsCacheIds.get(settings);
	if (existing !== undefined) return existing;
	const id = nextSettingsCacheId++;
	settingsCacheIds.set(settings, id);
	return id;
}

/** Drop every cached resolved chain (settings changed, tests). */
export function clearResolvedChainCache(): void {
	chainCache = new WeakMap();
}

function chainCacheKey(
	preferred: SearchProviderId | "auto" | undefined,
	fallbacks: readonly SearchProviderId[],
	ctx: ActiveSearchModelContext | undefined,
	authStorage: AuthStorage,
	settings: Settings | undefined,
): string {
	// Include the AuthStorage generation so credential changes (login/logout,
	// key rotation) invalidate cached chains immediately instead of being
	// masked for up to the TTL. Stubs without getGeneration() key as 0.
	const generation = (authStorage as { getGeneration?: () => number }).getGeneration?.() ?? 0;
	const providerSettings = settings
		? [settings.get("exa.enabled"), settings.get("exa.enableSearch"), settings.get("searxng.endpoint")]
		: null;
	return JSON.stringify([
		generation,
		settingsCacheId(settings),
		providerSettings,
		preferred ?? null,
		fallbacks,
		ctx
			? [
					ctx.provider,
					ctx.modelId,
					ctx.wireModelId ?? null,
					ctx.api,
					ctx.baseUrl ?? null,
					ctx.webSearch ?? null,
					ctx.ownerAuthOverride ?? false,
				]
			: null,
	]);
}

export function setPreferredSearchProvider(provider: SearchProviderId | "auto"): void {
	preferredProvId = provider;
	clearResolvedChainCache();
}

export function setSearchFallbackProviders(ids: readonly string[]): void {
	fallbackProvIds = ids.filter(isConfigurableSearchProviderId);
	clearResolvedChainCache();
}

/**
 * Fire-and-forget warm-up: resolve the provider chain once so the provider
 * modules are imported and the chain cache is primed before the first
 * user-visible search. Errors are intentionally swallowed — prewarming must
 * never surface a failure the real search path would handle itself.
 */
export function prewarmSearchProviders(options: ResolveProviderChainOptions): void {
	void resolveProviderChain(options).catch(() => {});
}

export interface SearchProviderPreferenceSource {
	get(path: "providers.webSearch" | "web_search.provider"): SearchProviderId | "auto";
	has(path: "providers.webSearch" | "web_search.provider"): boolean;
}

export function getConfiguredSearchProviderPreference(
	settings: SearchProviderPreferenceSource,
): SearchProviderId | "auto" {
	const providerPreference = settings.get("providers.webSearch");
	if (settings.has("providers.webSearch") || providerPreference !== "auto") return providerPreference;

	const legacyProviderPreference = settings.get("web_search.provider");
	return legacyProviderPreference;
}

export interface ResolveProviderChainOptions {
	authStorage: AuthStorage;
	sessionId?: string;
	signal?: AbortSignal;
	preferredProvider?: SearchProviderId | "auto";
	activeModelContext?: ActiveSearchModelContext;
	fallbackProviders?: readonly SearchProviderId[];
	settings?: Settings;
}

async function appendAvailable(
	chain: SearchProviderId[],
	id: SearchProviderId,
	authStorage: AuthStorage,
	settings: Settings | undefined,
): Promise<void> {
	if (chain.includes(id)) return;
	const provider = await getSearchProvider(id);
	if (await provider.isAvailable(authStorage, searchProviderSettings(settings))) chain.push(id);
}

function appendDeduped(chain: SearchProviderId[], id: SearchProviderId): void {
	if (!chain.includes(id)) chain.push(id);
}

function isAnthropicWire(api: string): boolean {
	return api === "anthropic-messages";
}

function isGoogleWire(api: string): boolean {
	return (
		api === "google-generative-ai" ||
		api === "google-generative-language" ||
		api === "gemini-wire" ||
		api === "google-vertex" ||
		api === "google-gemini-cli"
	);
}

function isGenerativeLanguageWire(api: string): boolean {
	return api === "google-generative-ai" || api === "google-generative-language" || api === "gemini-wire";
}

function isOpenAICompatWire(api: string): boolean {
	return api === "openai-responses" || api === "openai-completions" || api === "azure-openai-responses";
}

export function looksHostedModelId(modelId: string | undefined): boolean {
	if (!modelId) return false;
	const id = modelId.toLowerCase();
	return /^(gpt-|o\d|o-|chatgpt-|text-|davinci|babbage|curie)/.test(id);
}

function looksOpenAIFamilyModelId(ctx: ActiveSearchModelContext): boolean {
	return looksHostedModelId(ctx.wireModelId) || looksHostedModelId(ctx.modelId);
}

function looksXaiModelId(modelId: string | undefined): boolean {
	if (!modelId) return false;
	const id = modelId.toLowerCase();
	return id.startsWith("grok-") || id.startsWith("x-ai/grok-") || id.startsWith("xai/grok-");
}

function looksXaiFamilyModelId(ctx: ActiveSearchModelContext): boolean {
	return looksXaiModelId(ctx.wireModelId) || looksXaiModelId(ctx.modelId);
}

const OFFICIAL_GEMINI_HOSTS = new Set([
	"cloudcode-pa.googleapis.com",
	"daily-cloudcode-pa.googleapis.com",
	"daily-cloudcode-pa.sandbox.googleapis.com",
	"generativelanguage.googleapis.com",
]);

function normalizedHost(baseUrl: string): string | undefined {
	try {
		return new URL(baseUrl).hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "").replace(/\.$/, "");
	} catch {
		return undefined;
	}
}

function isOfficialGeminiBaseUrl(baseUrl: string | undefined): boolean {
	if (!baseUrl?.trim()) return true;
	const host = normalizedHost(baseUrl);
	return host !== undefined && OFFICIAL_GEMINI_HOSTS.has(host);
}

function isOfficialXaiBaseUrl(baseUrl: string | undefined): boolean {
	if (!baseUrl?.trim()) return true;
	return normalizedHost(baseUrl) === "api.x.ai";
}

const CANONICAL_GEMINI_PROVIDERS = new Set(["google", "gemini", "google-gemini-cli", "google-antigravity"]);

function hasCustomGeminiSearchContext(ctx: ActiveSearchModelContext): boolean {
	if (!isGoogleWire(ctx.api)) return false;
	if (ctx.ownerAuthOverride) return true;
	if (!isOfficialGeminiBaseUrl(ctx.baseUrl)) return true;
	const provider = ctx.provider.toLowerCase();
	return Boolean(ctx.resolveCredentials && !CANONICAL_GEMINI_PROVIDERS.has(provider));
}

function hasCustomXaiSearchContext(ctx: ActiveSearchModelContext): boolean {
	if (!isOpenAICompatWire(ctx.api)) return false;
	if (ctx.ownerAuthOverride) return true;
	const provider = ctx.provider.toLowerCase();
	if (provider === "xai" && !isOfficialXaiBaseUrl(ctx.baseUrl)) return true;
	if (!looksXaiFamilyModelId(ctx)) return false;
	if (!isOfficialXaiBaseUrl(ctx.baseUrl)) return true;
	return provider !== "xai";
}

export function isLocalBaseUrl(baseUrl: string | undefined): boolean {
	if (!baseUrl) return false;
	let url: URL;
	try {
		url = new URL(baseUrl);
	} catch {
		return true;
	}
	const host = url.hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "").replace(/\.$/, "");
	if (
		host === "localhost" ||
		host.endsWith(".localhost") ||
		host === "host.docker.internal" ||
		host.endsWith(".local")
	)
		return true;
	const v4 = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
	if (v4) {
		const [a, b] = v4.slice(1, 3).map(Number);
		if (
			a === 127 ||
			a === 0 ||
			a === 10 ||
			(a === 172 && b >= 16 && b <= 31) ||
			(a === 192 && b === 168) ||
			(a === 169 && b === 254)
		)
			return true;
	}
	if (host === "::1" || host === "::") return true;
	if (host.startsWith("fc") || host.startsWith("fd")) return true;
	if (host.startsWith("fe8") || host.startsWith("fe9") || host.startsWith("fea") || host.startsWith("feb"))
		return true;
	return false;
}

/**
 * Whether `baseUrl` is an official OpenAI endpoint (or absent, i.e. the default
 * hosted OpenAI). The dedicated `codex` provider authenticates against the
 * ChatGPT backend with the user's *local* Codex OAuth, so it must only be
 * selected when the active model is genuinely served by OpenAI/ChatGPT — never
 * for a custom/proxy endpoint, which should reuse its own credentials through
 * the `openai-compatible` adapter instead.
 */
function isOpenAIOfficialBaseUrl(baseUrl: string | undefined): boolean {
	if (!baseUrl?.trim()) return true;
	let host: string;
	try {
		host = new URL(baseUrl).hostname.toLowerCase();
	} catch {
		return false;
	}
	return (
		host === "api.openai.com" ||
		host === "chatgpt.com" ||
		host.endsWith(".openai.com") ||
		host.endsWith(".chatgpt.com")
	);
}

export function inferNativeProviderFromModel(ctx: ActiveSearchModelContext | undefined): SearchProviderId | undefined {
	if (!ctx || ctx.webSearch === "off") return undefined;
	const modelId = (ctx.wireModelId ?? ctx.modelId).toLowerCase();
	if (modelId.startsWith("claude-") && isAnthropicWire(ctx.api)) return "anthropic";
	if (modelId.startsWith("gemini-") && isGoogleWire(ctx.api) && !hasCustomGeminiSearchContext(ctx)) return "gemini";
	// A custom proxy may expose a Grok model through an OpenAI wire while the
	// process also has canonical xAI credentials. Do not infer the canonical
	// xAI provider from the model family: that would silently send the search to
	// api.x.ai with another registry's credentials. Custom active contexts are
	// dispatched below by activeContextNativeId, where the provider can consume
	// the active owner-bound resolver instead.
	if (
		looksXaiFamilyModelId(ctx) &&
		isOpenAICompatWire(ctx.api) &&
		ctx.provider.toLowerCase() === "xai" &&
		!hasCustomXaiSearchContext(ctx)
	)
		return "xai";
	// `codex` hits the ChatGPT backend with local Codex OAuth, so only infer it
	// for genuine OpenAI endpoints. Custom/proxy OpenAI-compatible models fall
	// through to `activeContextNativeId` and reuse their own credentials.
	if (
		!ctx.ownerAuthOverride &&
		looksOpenAIFamilyModelId(ctx) &&
		isOpenAICompatWire(ctx.api) &&
		isOpenAIOfficialBaseUrl(ctx.baseUrl)
	) {
		return "codex";
	}
	return undefined;
}

function canUseDirectProviderMapping(ctx: ActiveSearchModelContext, id: SearchProviderId): boolean {
	if (ctx.webSearch === "off") return false;
	if (id === "gemini" && hasCustomGeminiSearchContext(ctx)) return false;
	if (id === "xai" && hasCustomXaiSearchContext(ctx)) return false;
	if (id !== "codex") return true;
	if (ctx.ownerAuthOverride) return false;
	// Same constraint as inference: the ChatGPT-backed codex provider is valid
	// only for official OpenAI endpoints, not custom/proxy base URLs.
	return isOpenAIOfficialBaseUrl(ctx.baseUrl);
}

export async function canUseGenericCredentials(
	authStorage: AuthStorage,
	ctx: ActiveSearchModelContext | undefined,
	sessionId?: string,
	signal?: AbortSignal,
): Promise<boolean> {
	if (!ctx) return false;
	if (ctx.resolveCredentials) {
		const resolved = await ctx.resolveCredentials({ sessionId, signal });
		return Boolean(resolved.apiKey) || hasActiveCredentialHeader(resolved.headers);
	}
	const key = await authStorage.getApiKey(ctx.provider, sessionId, {
		baseUrl: ctx.baseUrl,
		modelId: ctx.modelId,
		signal,
	});
	return Boolean(key);
}

function hasActiveCredentialHeader(headers: Record<string, string> | undefined): boolean {
	return Object.keys(headers ?? {}).some(key => {
		const normalized = key.toLowerCase();
		return normalized === "authorization" || normalized === "x-api-key" || normalized === "x-goog-api-key";
	});
}

/**
 * Native web-search provider to attempt by reusing the ACTIVE model's own
 * credentials + baseUrl, dispatched by the model's wire protocol.
 *
 * This is the "native search over a proxy" path: when a model is served through
 * a proxy/custom endpoint, its canonical search credentials (e.g. a dedicated
 * `anthropic` key, or ChatGPT OAuth for `codex`) are usually absent, but the
 * credential that authenticates the model itself — stored under the active
 * provider id and aimed at `ctx.baseUrl` — can drive native web search just as
 * well. Each provider's `search()` falls back to those active credentials when
 * its canonical ones are missing.
 *
 * Returned ids are matched purely from the wire `api` (+ model-id family where a
 * native tool only makes sense for that family); the providers themselves fail
 * closed (and the chain falls through to DuckDuckGo) if the endpoint does not
 * actually support web search.
 */
export function activeContextNativeId(ctx: ActiveSearchModelContext | undefined): SearchProviderId | undefined {
	if (!ctx || ctx.webSearch === "off") return undefined;
	const modelId = (ctx.wireModelId ?? ctx.modelId).toLowerCase();
	// Dispatch must match exactly what each provider can service by reusing the
	// active credential: xAI-family models use the xAI search tools, the
	// OpenAI-compatible adapter only speaks the two plain OpenAI wires (not
	// azure), and the Gemini active path only speaks the public Generative
	// Language wire (not vertex/cloud-code). Returning an id the provider would
	// reject just wastes a guaranteed-fail attempt before DuckDuckGo.
	if (isAnthropicWire(ctx.api) && modelId.startsWith("claude-")) return "anthropic";
	if (isGenerativeLanguageWire(ctx.api) && modelId.startsWith("gemini-")) return "gemini";
	if (
		isOpenAICompatWire(ctx.api) &&
		hasCustomXaiSearchContext(ctx) &&
		(looksXaiFamilyModelId(ctx) || ctx.provider.toLowerCase() === "xai")
	)
		return "xai";
	if (ctx.api === "openai-responses" || ctx.api === "openai-completions") return "openai-compatible";
	return undefined;
}

export async function resolveProviderChain(options: ResolveProviderChainOptions): Promise<SearchProvider[]> {
	const {
		authStorage,
		sessionId,
		signal,
		preferredProvider = preferredProvId,
		activeModelContext,
		fallbackProviders = fallbackProvIds,
		settings,
	} = options;

	// Resolve the active model before consulting the chain cache. The registry
	// resolver refreshes rotating apiKeyEnv credentials and updates generated
	// headers, which also advances AuthStorage's generation when credentials
	// rotate or disappear.
	if (preferredProvider === "auto" && activeModelContext?.resolveCredentials) {
		await activeModelContext.resolveCredentials({ sessionId, signal });
	}
	const cacheKey = chainCacheKey(preferredProvider, fallbackProviders, activeModelContext, authStorage, settings);
	const perStorage = chainCache.get(authStorage);
	const now = Date.now();
	if (perStorage) {
		for (const [key, entry] of perStorage) {
			if (entry.expires <= now) perStorage.delete(key);
		}
	}
	const cached = perStorage?.get(cacheKey);
	if (cached && cached.expires > now) {
		const cachedProviders: SearchProvider[] = [];
		for (const id of cached.ids) cachedProviders.push(await getSearchProvider(id));
		return cachedProviders;
	}

	const chain: SearchProviderId[] = [];

	// A forced primary is honored only when it is a user-configurable provider.
	// The internal `openai-compatible` adapter (and any non-configurable value) is
	// never selectable as a forced primary; such inputs fall through to auto
	// native resolution instead of being injected into the chain.
	if (preferredProvider !== "auto" && isConfigurableSearchProviderId(preferredProvider)) {
		await appendAvailable(chain, preferredProvider, authStorage, settings);
	} else if (activeModelContext) {
		const directId = MODEL_PROVIDER_TO_SEARCH[activeModelContext.provider.toLowerCase()];
		if (directId && canUseDirectProviderMapping(activeModelContext, directId))
			await appendAvailable(chain, directId, authStorage, settings);
		const inferred = inferNativeProviderFromModel(activeModelContext);
		if (inferred) await appendAvailable(chain, inferred, authStorage, settings);
		// Native-over-proxy: when no canonical native provider was selected above,
		// fall back to the model's own credentials (resolved under the active
		// provider id against its baseUrl) to drive native web search. Gated on
		// those credentials actually resolving; otherwise the chain ends at the
		// keyless DuckDuckGo terminal fallback.
		if (chain.length === 0) {
			const activeNativeId = activeContextNativeId(activeModelContext);
			if (activeNativeId && (await canUseGenericCredentials(authStorage, activeModelContext, sessionId, signal)))
				chain.push(activeNativeId);
		}
	}

	// Configured fallbacks are user-facing only: the internal `openai-compatible`
	// adapter (and any non-configurable id) can never enter the chain through the
	// fallback list, regardless of how `fallbackProviders` was supplied.
	for (const id of fallbackProviders) {
		if (!isConfigurableSearchProviderId(id)) continue;
		await appendAvailable(chain, id, authStorage, settings);
	}
	appendDeduped(chain, "duckduckgo");

	const storageEntry = chainCache.get(authStorage) ?? new Map<string, { ids: SearchProviderId[]; expires: number }>();
	storageEntry.set(cacheKey, { ids: [...chain], expires: Date.now() + CHAIN_CACHE_TTL_MS });
	chainCache.set(authStorage, storageEntry);

	const providers: SearchProvider[] = [];
	for (const id of chain) providers.push(await getSearchProvider(id));
	return providers;
}
