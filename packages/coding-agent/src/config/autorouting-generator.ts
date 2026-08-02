/**
 * Pure autorouting chain materialization.
 *
 * The generator consumes an explicit setup, a curation map, and a complete
 * model-registry snapshot. It never reads credentials, the clock, network
 * state, or discovery availability.
 */

import { createHash } from "node:crypto";
import type { Api, Model } from "@gajae-code/ai/core";
import {
	AUTOROUTING_SELECTOR_PATTERN,
	AUTOROUTING_TIERS,
	type AutoroutingSetup,
	type AutoroutingTier,
	type TierMap,
} from "./autorouting-contract";
import {
	type AutoroutingCuratedTierMap,
	CURATED_TIER_LABELS,
	CURATED_TIER_MAP,
	type CuratedTierLabels,
	canonicalJsonBytes,
	computeMapFingerprint,
	type TierAssignment,
	type TierEffort,
} from "./autorouting-tier-map";
import { formatModelString } from "./model-resolver";

export type { AutoroutingSetup } from "./autorouting-contract";
export { canonicalJsonBytes } from "./autorouting-tier-map";

export const AUTOROUTING_GENERATOR_VERSION = 1;
export const GENERATOR_VERSION = AUTOROUTING_GENERATOR_VERSION;

export type AutoroutingGeneratorMap =
	| AutoroutingCuratedTierMap
	| CuratedTierLabels
	| {
			labels: CuratedTierLabels;
			skips?: Record<`${string}/${string}`, { rationale: string; baseline?: true }>;
			skipList?: Record<`${string}/${string}`, { rationale: string; baseline?: true }>;
			version: number;
	  };
export type AutoroutingCuratedMap = AutoroutingGeneratorMap;

export type AutoroutingSourceIdentity = {
	catalogFingerprint: string;
	mapFingerprint: string;
	generatorVersion: number;
};

export type GeneratedTierChains = {
	tiers: TierMap;
	declarationFingerprint: string;
	tiersFingerprint: string;
	sourceIdentity: AutoroutingSourceIdentity;
};

type CatalogPair = { provider: string; id: string };
type Candidate = {
	selector: string;
	key: string;
	rank: number;
	providerIndex: number;
};

function canonicalJsonHash(value: unknown): string {
	return createHash("sha256").update(canonicalJsonBytes(value)).digest("hex");
}

function assertSetup(setup: AutoroutingSetup): void {
	if (setup === null || typeof setup !== "object" || setup.schema !== 1) {
		throw new TypeError("Autorouting setup schema must be 1.");
	}
	if (!Array.isArray(setup.providers) || setup.providers.length === 0) {
		throw new TypeError("Autorouting setup providers must be a non-empty array.");
	}
	for (const provider of setup.providers) {
		if (typeof provider !== "string" || provider.trim() !== provider || provider.length === 0) {
			throw new TypeError("Autorouting setup providers must contain non-empty strings.");
		}
	}
	if (setup.models !== undefined) {
		if (!Array.isArray(setup.models)) throw new TypeError("Autorouting setup models must be an array when present.");
		for (const selector of setup.models) {
			if (typeof selector !== "string" || selector.trim() !== selector || selector.length === 0) {
				throw new TypeError("Autorouting setup models must contain non-empty strings.");
			}
		}
	}
}

function mapParts(input: AutoroutingGeneratorMap): AutoroutingCuratedTierMap {
	if ("labels" in input && input.labels !== undefined) {
		return { labels: input.labels, skips: input.skips ?? input.skipList ?? {}, version: input.version };
	}
	if (input === CURATED_TIER_LABELS)
		return { labels: input, skips: CURATED_TIER_MAP.skips ?? {}, version: CURATED_TIER_MAP.version };
	return { labels: input, skips: {}, version: 1 };
}

function catalogKey(model: Pick<Model<Api>, "provider" | "id">): string {
	return `${model.provider}/${model.id}`;
}

function lowercaseKey(value: string): string {
	return value.toLowerCase();
}

function compareLex(left: string, right: string): number {
	return left === right ? 0 : left < right ? -1 : 1;
}

function compareCatalogPairs(left: CatalogPair, right: CatalogPair): number {
	const leftKey = `${left.provider}/${left.id}`;
	const rightKey = `${right.provider}/${right.id}`;
	return compareLex(leftKey, rightKey);
}

function catalogFingerprint(catalog: readonly Model<Api>[]): string {
	const pairs = catalog.map(model => ({ provider: model.provider, id: model.id })).sort(compareCatalogPairs);
	return canonicalJsonHash(pairs);
}

function splitAllowlistSelector(selector: string): string {
	const suffixMatch = selector.match(/:(minimal|low|medium|high|xhigh)$/u);
	return suffixMatch ? selector.slice(0, -suffixMatch[0].length) : selector;
}

function buildAllowlist(setup: AutoroutingSetup): Set<string> | undefined {
	if (setup.models === undefined) return undefined;
	return new Set(setup.models.map(splitAllowlistSelector));
}

function selectorWithEffort(model: Model<Api>, effort: TierEffort | undefined): string {
	const selector = formatModelString(model);
	const generated = effort === undefined ? selector : `${selector}:${effort}`;
	if (!new RegExp(AUTOROUTING_SELECTOR_PATTERN).test(generated)) {
		throw new Error(`Generated selector does not match autorouting grammar: ${generated}`);
	}
	return generated;
}

function providerOrder(setup: AutoroutingSetup): readonly string[] {
	return [...new Set(setup.providers)];
}

function assignmentsForProvider(
	labels: CuratedTierLabels,
	provider: string,
	providerIndex: number,
	catalogByKey: ReadonlyMap<string, Model<Api>>,
	allowlist: Set<string> | undefined,
): Map<AutoroutingTier, Candidate[]> {
	const byTier = new Map<AutoroutingTier, Candidate[]>();
	for (const [key, assignments] of Object.entries(labels)) {
		if (!key.startsWith(`${provider}/`)) continue;
		const model = catalogByKey.get(key);
		if (!model) continue;
		if (allowlist !== undefined && !allowlist.has(key)) continue;
		for (const assignment of assignments as readonly TierAssignment[]) {
			const selector = selectorWithEffort(model, assignment.effort);
			const candidates = byTier.get(assignment.tier) ?? [];
			candidates.push({ selector, key, rank: assignment.rank, providerIndex });
			byTier.set(assignment.tier, candidates);
		}
	}
	return byTier;
}

function materializeTiers(setup: AutoroutingSetup, labels: CuratedTierLabels, catalog: readonly Model<Api>[]): TierMap {
	const catalogByKey = new Map<string, Model<Api>>();
	for (const model of catalog) catalogByKey.set(catalogKey(model), model);
	const allowlist = buildAllowlist(setup);
	const tierCandidates = new Map<AutoroutingTier, Candidate[]>();
	for (const [providerIndex, provider] of providerOrder(setup).entries()) {
		const providerTiers = assignmentsForProvider(labels, provider, providerIndex, catalogByKey, allowlist);
		for (const tier of AUTOROUTING_TIERS) {
			const candidates = providerTiers.get(tier);
			if (!candidates) continue;
			const existing = tierCandidates.get(tier) ?? [];
			existing.push(...candidates);
			tierCandidates.set(tier, existing);
		}
	}

	const tiers: TierMap = {};
	for (const tier of AUTOROUTING_TIERS) {
		const candidates = tierCandidates.get(tier) ?? [];
		candidates.sort(
			(left, right) =>
				left.providerIndex - right.providerIndex ||
				left.rank - right.rank ||
				compareLex(lowercaseKey(left.key), lowercaseKey(right.key)) ||
				compareLex(left.key, right.key),
		);
		const selectors: string[] = [];
		const seen = new Set<string>();
		for (const candidate of candidates) {
			if (seen.has(candidate.selector)) continue;
			seen.add(candidate.selector);
			selectors.push(candidate.selector);
		}
		if (selectors.length > 0) tiers[tier] = selectors;
	}
	return tiers;
}

/** Generate deterministic fast/balanced/strong fallback chains. */
export function generateTierChains(
	setup: AutoroutingSetup,
	curatedMap: AutoroutingGeneratorMap = CURATED_TIER_MAP,
	catalog: readonly Model<Api>[],
): GeneratedTierChains {
	assertSetup(setup);
	const map = mapParts(curatedMap);
	const tiers = materializeTiers(setup, map.labels, catalog);
	return {
		tiers,
		declarationFingerprint: canonicalJsonHash(setup),
		tiersFingerprint: canonicalJsonHash(tiers),
		sourceIdentity: {
			catalogFingerprint: catalogFingerprint(catalog),
			mapFingerprint: computeMapFingerprint(map),
			generatorVersion: AUTOROUTING_GENERATOR_VERSION,
		},
	};
}
