/**
 * Shared provider ordering used by every provider-facing selector (`/login`,
 * `/model`, `/provider`).
 *
 * Providers the user already has come first, then a curated list of well-known
 * providers, then everything else alphabetically. This is the single source of
 * truth for that order — surfaces must not keep their own famous-provider list.
 */

/**
 * Auth/config state of a provider as seen by the calling surface.
 *
 * - `valid` — stored credentials that validated successfully.
 * - `checking` — stored credentials whose async validation is still in flight.
 *   Ranked with `valid` so rows do not reflow when validation resolves.
 * - `configured` — no OAuth record, but the provider is present in the model
 *   registry with a working API key (custom/API-compatible providers).
 * - `invalid` — stored credentials that failed validation (problematic login).
 * - `none` — nothing stored and nothing configured.
 */
export type ProviderAuthState = "valid" | "checking" | "configured" | "invalid" | "none";

export const PROVIDER_RANK_TIER = {
	existing: 0,
	problematic: 1,
	famous: 2,
	other: 3,
} as const;

export type ProviderRankTier = (typeof PROVIDER_RANK_TIER)[keyof typeof PROVIDER_RANK_TIER];

/**
 * Curated provider order for the famous tier. Regional and device variants sit
 * immediately behind their primary so related entries stay grouped.
 */
export const FAMOUS_PROVIDER_ORDER: readonly string[] = [
	"openai-codex",
	"openai-codex-device",
	"anthropic",
	"xai",
	"opencode-go",
	"zai",
	"glm-zcode",
	"alibaba-token-plan",
	"qwen-portal",
	"kimi-code",
	"moonshot",
	"minimax-code",
	"minimax-code-cn",
	"xiaomi",
	"xiaomi-token-plan-sgp",
	"xiaomi-token-plan-ams",
	"xiaomi-token-plan-cn",
	"opengateway",
	"bizrouter",
	"mara",
	"github-copilot",
	"cursor",
];

const FAMOUS_PROVIDER_INDEX = new Map(FAMOUS_PROVIDER_ORDER.map((id, index) => [id, index]));

/** A provider as ranked by a surface. `label` is what the user sees. */
export interface RankableProvider {
	id: string;
	label: string;
	authState: ProviderAuthState;
}

/** A provider's position in the ordering: its tier plus its rank inside that tier. */
export interface ProviderRank {
	tier: ProviderRankTier;
	intraTierRank: number;
}

/**
 * The single ranking result for a provider. `intraTierRank` is the curated
 * famous-list position, or `Number.MAX_SAFE_INTEGER` for providers that are not
 * on the list and therefore order by display label.
 */
export function rankProvider(provider: RankableProvider): ProviderRank {
	return {
		tier: providerRankTier(provider.authState, provider.id),
		intraTierRank: FAMOUS_PROVIDER_INDEX.get(provider.id) ?? Number.MAX_SAFE_INTEGER,
	};
}

export function providerRankTier(authState: ProviderAuthState, id: string): ProviderRankTier {
	if (authState === "valid" || authState === "checking" || authState === "configured") {
		return PROVIDER_RANK_TIER.existing;
	}
	if (authState === "invalid") return PROVIDER_RANK_TIER.problematic;
	return FAMOUS_PROVIDER_INDEX.has(id) ? PROVIDER_RANK_TIER.famous : PROVIDER_RANK_TIER.other;
}

/** Position within the famous list, or `undefined` for providers not on it. */
export function famousProviderIndex(id: string): number | undefined {
	return FAMOUS_PROVIDER_INDEX.get(id);
}

/**
 * Total order over providers: tier, then famous-list position, then display
 * label, then id. The trailing id comparison guarantees no ties.
 */
export function compareRankedProviders(left: RankableProvider, right: RankableProvider): number {
	const leftRank = rankProvider(left);
	const rightRank = rankProvider(right);
	if (leftRank.tier !== rightRank.tier) return leftRank.tier - rightRank.tier;
	if (leftRank.intraTierRank !== rightRank.intraTierRank) return leftRank.intraTierRank - rightRank.intraTierRank;

	const label = left.label.localeCompare(right.label);
	if (label !== 0) return label;

	return left.id.localeCompare(right.id);
}

/** Convenience wrapper returning a new array in ranked order. */
export function sortRankedProviders<T extends RankableProvider>(providers: readonly T[]): T[] {
	return [...providers].sort(compareRankedProviders);
}
