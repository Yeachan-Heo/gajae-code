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
import type { SearchProviderId } from "./types";

export type { SearchParams } from "./providers/base";
export { SearchProvider } from "./providers/base";

interface ProviderMeta {
	id: SearchProviderId;
	label: string;
	load: () => Promise<SearchProvider>;
}

/** Lazy factories. Each `load()` dynamic-imports its provider module on first call. */
const PROVIDER_META: Record<SearchProviderId, ProviderMeta> = {
	exa: {
		id: "exa",
		label: "Exa",
		load: async () => new (await import("./providers/exa")).ExaProvider(),
	},
	brave: {
		id: "brave",
		label: "Brave",
		load: async () => new (await import("./providers/brave")).BraveProvider(),
	},
	jina: {
		id: "jina",
		label: "Jina",
		load: async () => new (await import("./providers/jina")).JinaProvider(),
	},
	perplexity: {
		id: "perplexity",
		label: "Perplexity",
		load: async () => new (await import("./providers/perplexity")).PerplexityProvider(),
	},
	kimi: {
		id: "kimi",
		label: "Kimi",
		load: async () => new (await import("./providers/kimi")).KimiProvider(),
	},
	zai: {
		id: "zai",
		label: "Z.AI",
		load: async () => new (await import("./providers/zai")).ZaiProvider(),
	},
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
	codex: {
		id: "codex",
		label: "OpenAI",
		load: async () => new (await import("./providers/codex")).CodexProvider(),
	},
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
	kagi: {
		id: "kagi",
		label: "Kagi",
		load: async () => new (await import("./providers/kagi")).KagiProvider(),
	},
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
};

const instanceCache = new Map<SearchProviderId, SearchProvider>();

/** Cheap, sync metadata accessor — never triggers a provider load. */
export function getSearchProviderLabel(id: SearchProviderId): string {
	return PROVIDER_META[id]?.label ?? id;
}

/**
 * Resolve and cache a provider instance. First call for a given id loads the
 * underlying module; subsequent calls return the cached singleton.
 */
export async function getSearchProvider(id: SearchProviderId): Promise<SearchProvider> {
	const cached = instanceCache.get(id);
	if (cached) return cached;
	const meta = PROVIDER_META[id];
	if (!meta) {
		throw new Error(`Unknown search provider: ${id}`);
	}
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
	"zai",
	"exa",
	"parallel",
	"kagi",
	"synthetic",
	"searxng",
];

/**
 * Map an active model's provider string to its own native web-search provider.
 * Keys are real model provider ids (see packages/ai/src/types.ts KnownProvider);
 * a few aliases (gemini/kimi) and API strings (openai-responses) are tolerated
 * defensively. Providers absent from this map (custom/unknown) fall through to
 * DuckDuckGo.
 */
const MODEL_PROVIDER_TO_SEARCH: Record<string, SearchProviderId> = {
	openai: "codex",
	"openai-codex": "codex",
	"openai-responses": "codex",
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

/** Preferred provider set via settings (default: auto) */
let preferredProvId: SearchProviderId | "auto" = "auto";

/** Set the preferred web search provider from settings */
export function setPreferredSearchProvider(provider: SearchProviderId | "auto"): void {
	preferredProvId = provider;
}

/**
 * Resolve the ordered provider chain for a search request.
 *
 * Resolution is active-model-gated, never credential-scanning:
 *   1. An explicitly preferred provider (settings) that is available is primary.
 *   2. Otherwise the active model's own native search is primary, but only when
 *      that provider's own credentials are present (its `isAvailable()`).
 *   3. DuckDuckGo (keyless) is always appended as the terminal fallback, so a
 *      missing primary — or a primary runtime failure — still returns results
 *      with zero configuration. Keyed standalone providers are never
 *      auto-selected; they are reachable only via explicit selection (step 1).
 */
export async function resolveProviderChain(
	authStorage: AuthStorage,
	preferredProvider: SearchProviderId | "auto" = preferredProvId,
	activeModelProvider?: string,
): Promise<SearchProvider[]> {
	const chain: SearchProviderId[] = [];

	if (preferredProvider !== "auto") {
		const provider = await getSearchProvider(preferredProvider);
		if (await provider.isAvailable(authStorage)) {
			chain.push(preferredProvider);
		}
	} else if (activeModelProvider) {
		const nativeId = MODEL_PROVIDER_TO_SEARCH[activeModelProvider.toLowerCase()];
		if (nativeId) {
			const provider = await getSearchProvider(nativeId);
			if (await provider.isAvailable(authStorage)) {
				chain.push(nativeId);
			}
		}
	}

	// DuckDuckGo is the permissionless terminal fallback (deduped).
	if (!chain.includes("duckduckgo")) chain.push("duckduckgo");

	const providers: SearchProvider[] = [];
	for (const id of chain) {
		providers.push(await getSearchProvider(id));
	}
	return providers;
}
