// Lazy registry of web search providers.
//
// Each provider is loaded on first use; importing this module loads zero
// provider implementations. Provider modules are heavy (each pulls in
// fetch/parse/format helpers) and only one — at most — is needed per session,
// so eager construction was wasted work at startup.
//
// The `label`/`id` metadata is kept inline so callers needing a display name
// (error formatting, UI listings) do not force a load.

import type { AuthStorage } from "@gajae-code/ai";
import type { SearchProvider } from "./providers/base";
import type { ActiveSearchModelContext, SearchProviderId } from "./types";
import { isConfigurableSearchProviderId } from "./types";

export type { SearchParams } from "./providers/base";
export { SearchProvider } from "./providers/base";

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
	duckduckgo: {
		id: "duckduckgo",
		label: "DuckDuckGo",
		load: async () => new (await import("./providers/duckduckgo")).DuckDuckGoProvider(),
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

export function setPreferredSearchProvider(provider: SearchProviderId | "auto"): void {
	preferredProvId = provider;
}

export function setSearchFallbackProviders(ids: readonly string[]): void {
	fallbackProvIds = ids.filter(isConfigurableSearchProviderId);
}

export interface ResolveProviderChainOptions {
	authStorage: AuthStorage;
	sessionId?: string;
	signal?: AbortSignal;
	preferredProvider?: SearchProviderId | "auto";
	activeModelContext?: ActiveSearchModelContext;
	fallbackProviders?: readonly SearchProviderId[];
}

async function appendAvailable(
	chain: SearchProviderId[],
	id: SearchProviderId,
	authStorage: AuthStorage,
): Promise<void> {
	if (chain.includes(id)) return;
	const provider = await getSearchProvider(id);
	if (await provider.isAvailable(authStorage)) chain.push(id);
}

function appendDeduped(chain: SearchProviderId[], id: SearchProviderId): void {
	if (!chain.includes(id)) chain.push(id);
}

function isAnthropicWire(api: string): boolean {
	return api === "anthropic-messages";
}

function isGoogleWire(api: string): boolean {
	return api === "google-generative-ai" || api === "google-vertex" || api === "google-gemini-cli";
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

export function inferNativeProviderFromModel(ctx: ActiveSearchModelContext | undefined): SearchProviderId | undefined {
	if (!ctx || ctx.webSearch === "off") return undefined;
	const modelId = (ctx.wireModelId ?? ctx.modelId).toLowerCase();
	if (modelId.startsWith("claude-") && isAnthropicWire(ctx.api)) return "anthropic";
	if (modelId.startsWith("gemini-") && isGoogleWire(ctx.api)) return "gemini";
	if (looksXaiFamilyModelId(ctx) && isOpenAICompatWire(ctx.api)) return "xai";
	if (looksOpenAIFamilyModelId(ctx) && isOpenAICompatWire(ctx.api)) {
		if (ctx.webSearch === "on" || !isLocalBaseUrl(ctx.baseUrl)) return "codex";
	}
	return undefined;
}

function canUseDirectProviderMapping(ctx: ActiveSearchModelContext, id: SearchProviderId): boolean {
	if (ctx.webSearch === "off") return false;
	if (id !== "codex") return true;
	if (!isOpenAICompatWire(ctx.api)) return true;
	return ctx.webSearch === "on" || !isLocalBaseUrl(ctx.baseUrl);
}

export async function canUseGenericCredentials(
	authStorage: AuthStorage,
	ctx: ActiveSearchModelContext | undefined,
	sessionId?: string,
	signal?: AbortSignal,
): Promise<boolean> {
	if (!ctx) return false;
	const key = await authStorage.getApiKey(ctx.provider, sessionId, {
		baseUrl: ctx.baseUrl,
		modelId: ctx.modelId,
		signal,
	});
	return Boolean(key);
}

export async function shouldTryGenericOpenAICompat(
	authStorage: AuthStorage,
	ctx: ActiveSearchModelContext | undefined,
	sessionId?: string,
	signal?: AbortSignal,
): Promise<boolean> {
	if (!ctx || ctx.webSearch === "off" || !isOpenAICompatWire(ctx.api)) return false;
	const autoAllowed =
		ctx.webSearch === "on" ||
		((ctx.api === "openai-responses" || looksOpenAIFamilyModelId(ctx)) && !isLocalBaseUrl(ctx.baseUrl));
	return autoAllowed && (await canUseGenericCredentials(authStorage, ctx, sessionId, signal));
}

export async function resolveProviderChain(options: ResolveProviderChainOptions): Promise<SearchProvider[]> {
	const {
		authStorage,
		sessionId,
		signal,
		preferredProvider = preferredProvId,
		activeModelContext,
		fallbackProviders = fallbackProvIds,
	} = options;
	const chain: SearchProviderId[] = [];

	// A forced primary is honored only when it is a user-configurable provider.
	// The internal `openai-compatible` adapter (and any non-configurable value) is
	// never selectable as a forced primary; such inputs fall through to auto
	// native resolution instead of being injected into the chain.
	if (preferredProvider !== "auto" && isConfigurableSearchProviderId(preferredProvider)) {
		await appendAvailable(chain, preferredProvider, authStorage);
	} else if (activeModelContext) {
		const directId = MODEL_PROVIDER_TO_SEARCH[activeModelContext.provider.toLowerCase()];
		if (directId && canUseDirectProviderMapping(activeModelContext, directId))
			await appendAvailable(chain, directId, authStorage);
		const inferred = inferNativeProviderFromModel(activeModelContext);
		if (inferred) await appendAvailable(chain, inferred, authStorage);
		const hasNativeXai = chain.includes("xai");
		if (!hasNativeXai && (await shouldTryGenericOpenAICompat(authStorage, activeModelContext, sessionId, signal)))
			appendDeduped(chain, "openai-compatible");
	}

	// Configured fallbacks are user-facing only: the internal `openai-compatible`
	// adapter (and any non-configurable id) can never enter the chain through the
	// fallback list, regardless of how `fallbackProviders` was supplied.
	for (const id of fallbackProviders) {
		if (!isConfigurableSearchProviderId(id)) continue;
		await appendAvailable(chain, id, authStorage);
	}
	appendDeduped(chain, "duckduckgo");

	const providers: SearchProvider[] = [];
	for (const id of chain) providers.push(await getSearchProvider(id));
	return providers;
}
