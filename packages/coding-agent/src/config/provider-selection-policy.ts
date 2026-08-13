import type { Api, Model } from "@gajae-code/ai/core";

/**
 * Effective credential provenance for a provider, derived from credential
 * surfaces (never from token shape).
 *
 * - `"oauth"`: requests are authenticated with an OAuth-provisioned credential,
 *   including OAuth flows whose access tokens happen to look like API keys
 *   (e.g. GitHub Copilot `ghu_` tokens).
 * - `"key"`: a manual or configured API key (stored `api_key`, CLI `--api-key`
 *   runtime override, `models.yml` `apiKey`/`apiKeyEnv`, or environment key).
 * - `"keyless"`: no credential is required (local servers, `auth: none`).
 * - `"unknown"`: no credential surface is present.
 */
export type EffectiveProviderAuth = "oauth" | "key" | "keyless" | "unknown";

export interface ProviderSelectionPolicyInput {
	/** Explicit `modelProviderOrder` from settings; trimmed and case-insensitive. */
	explicitProviderOrder: readonly string[];
	/** Effective auth provenance per lowercased provider id. */
	effectiveAuth: ReadonlyMap<string, EffectiveProviderAuth>;
	/** Registry catalog provider ids, lowercased, first-wins catalog order. */
	catalogProviders: readonly string[];
	/** Registry catalog model selectors ("provider/id"), lowercased, first-wins catalog order. */
	catalogModels: readonly string[];
}

export interface ProviderSelectionPolicy {
	/**
	 * Total-order rank for a provider: explicit providers `0..n-1`, omitted
	 * effective-OAuth providers `n`, omitted non-OAuth/unknown/keyless providers
	 * `n+1`. Unknown providers that were never cataloged still receive the
	 * non-OAuth rank unless their effective auth is OAuth.
	 */
	rank(provider: string): number;
	/** Lowercased explicit provider ids, in explicit order (deduped). */
	explicitProviders(): readonly string[];
	/** Whether a provider was listed explicitly. */
	isExplicit(provider: string): boolean;
	/** Ordered distinct provider ids: explicit order first, then catalog order. */
	orderedProviders(): readonly string[];
	/** Stable catalog index per lowercased provider id (registry-owned tie data). */
	providerCatalogIndex(provider: string): number;
	/** Stable catalog index per lowercased model selector (registry-owned tie data). */
	modelCatalogIndex(selector: string): number;
}

/**
 * Build a pure provider selection policy over explicit user order, effective
 * credential provenance, and registry-owned catalog tie data. The policy never
 * reads settings, auth storage, or the model catalog itself — callers pass the
 * current values in so ranking stays deterministic and testable.
 */
export function createProviderSelectionPolicy(input: ProviderSelectionPolicyInput): ProviderSelectionPolicy {
	const explicitProviders: string[] = [];
	const explicitSet = new Set<string>();
	for (const raw of input.explicitProviderOrder) {
		const normalized = raw.trim().toLowerCase();
		if (!normalized || explicitSet.has(normalized)) {
			continue;
		}
		explicitSet.add(normalized);
		explicitProviders.push(normalized);
	}
	const explicitCount = explicitProviders.length;
	const oauthRank = explicitCount;
	const nonOAuthRank = explicitCount + 1;

	const providerCatalogIndex = new Map<string, number>();
	const modelCatalogIndex = new Map<string, number>();
	for (let index = 0; index < input.catalogProviders.length; index += 1) {
		const provider = input.catalogProviders[index]!;
		if (!providerCatalogIndex.has(provider)) {
			providerCatalogIndex.set(provider, index);
		}
	}
	for (let index = 0; index < input.catalogModels.length; index += 1) {
		const selector = input.catalogModels[index]!;
		if (!modelCatalogIndex.has(selector)) {
			modelCatalogIndex.set(selector, index);
		}
	}

	// One shared implementation with the standalone accessor; see projectProviderOrder.
	const orderedProviders = projectProviderOrder(explicitProviders, input.catalogProviders);

	return {
		rank(provider: string): number {
			const normalized = provider.trim().toLowerCase();
			if (explicitSet.has(normalized)) {
				return explicitProviders.indexOf(normalized);
			}
			return input.effectiveAuth.get(normalized) === "oauth" ? oauthRank : nonOAuthRank;
		},
		explicitProviders: () => explicitProviders,
		isExplicit(provider: string): boolean {
			return explicitSet.has(provider.trim().toLowerCase());
		},
		orderedProviders: () => orderedProviders,
		providerCatalogIndex(provider: string): number {
			return providerCatalogIndex.get(provider.trim().toLowerCase()) ?? Number.MAX_SAFE_INTEGER;
		},
		modelCatalogIndex(selector: string): number {
			return modelCatalogIndex.get(selector.trim().toLowerCase()) ?? Number.MAX_SAFE_INTEGER;
		},
	};
}

/**
 * Project the deterministic provider order: normalized explicit order first, then
 * first-wins catalog order for everything else.
 *
 * This is the single implementation of that ordering. It reads no credentials and
 * takes no auth input at all, so any consumer that only needs "which providers, in
 * what priority" cannot accidentally acquire auth sensitivity. Auth-aware banding
 * lives exclusively in {@link ProviderSelectionPolicy.rank}.
 */
export function projectProviderOrder(
	explicitProviderOrder: readonly string[],
	catalogProviders: readonly string[],
): string[] {
	const ordered: string[] = [];
	const seen = new Set<string>();
	for (const raw of explicitProviderOrder) {
		const normalized = raw.trim().toLowerCase();
		if (!normalized || seen.has(normalized)) continue;
		seen.add(normalized);
		ordered.push(normalized);
	}
	for (const provider of catalogProviders) {
		if (!provider || seen.has(provider)) continue;
		seen.add(provider);
		ordered.push(provider);
	}
	return ordered;
}

export interface ProviderSelectionCatalog {
	/** Lowercased provider ids in first-wins registry catalog order. */
	readonly catalogProviders: readonly string[];
	/** Lowercased model selectors in first-wins registry catalog order. */
	readonly catalogModels: readonly string[];
}

/**
 * Derive stable provider/model tie data from the registry catalog order, not
 * from a caller-supplied candidate array. First occurrence wins so reordering
 * candidates never changes ranking.
 */
export function buildProviderSelectionCatalog(models: readonly Model<Api>[]): ProviderSelectionCatalog {
	const catalogProviders: string[] = [];
	const catalogModels: string[] = [];
	const seenProviders = new Set<string>();
	const seenModels = new Set<string>();
	for (const model of models) {
		const providerKey = model.provider.trim().toLowerCase();
		if (providerKey && !seenProviders.has(providerKey)) {
			seenProviders.add(providerKey);
			catalogProviders.push(providerKey);
		}
		const selectorKey = `${model.provider}/${model.id}`.trim().toLowerCase();
		if (selectorKey && !seenModels.has(selectorKey)) {
			seenModels.add(selectorKey);
			catalogModels.push(selectorKey);
		}
	}
	return { catalogProviders, catalogModels };
}
