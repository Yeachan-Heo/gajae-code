import type { Model } from "@gajae-code/ai/core";
import { splitSelectorThinkingSuffix } from "../thinking";
import { type AutoroutingEffective, type AutoroutingTier, DEFAULT_AUTOROUTING_TIER } from "./autorouting-contract";
import { formatModelString } from "./model-resolver";

export type TierSelectorNormalization =
	| { pinned: string }
	| { rejected: "selector_not_provider_qualified" }
	| { unmatched: true };

export type RoutingOutcome =
	| { kind: "disabled" }
	| {
			kind: "routed";
			tier: AutoroutingTier;
			requestedTier?: AutoroutingTier;
			defaultTierApplied?: true;
			pinnedSelector: string;
	  }
	| {
			kind: "manual-fallback";
			tier: AutoroutingTier;
			requestedTier?: AutoroutingTier;
			defaultTierApplied?: true;
			attemptedSelectorCount: number;
			reason: "tier_unmatched" | "tier_missing_in_map";
	  };

function isProviderQualified(selector: string): boolean {
	const slash = selector.indexOf("/");
	if (slash <= 0 || slash === selector.length - 1) return false;
	if (/[*?[]/.test(selector)) return false;
	if (selector.slice(0, slash).toLowerCase() === "pi") return false;
	return selector.trim() === selector;
}

/**
 * Pin one configured selector against exactly the supplied ordered snapshot.
 * No settings, role aliases, usage ordering, or fuzzy matching participate.
 */
export function normalizeTierSelector(selector: string, snapshot: readonly Model[]): TierSelectorNormalization {
	if (!isProviderQualified(selector)) return { rejected: "selector_not_provider_qualified" };
	const slash = selector.indexOf("/");
	const provider = selector.slice(0, slash);
	const rest = selector.slice(slash + 1);

	// Literal first: colon-bearing model ids are preserved when they exist.
	const literal = snapshot.find(
		model => model.provider.toLowerCase() === provider.toLowerCase() && model.id.toLowerCase() === rest.toLowerCase(),
	);
	if (literal) return { pinned: formatModelString(literal) };

	const suffix = splitSelectorThinkingSuffix(rest);
	if (suffix.invalidSuffix !== undefined) return { unmatched: true };
	if (suffix.thinkingLevel === undefined) return { unmatched: true };
	const baseId = suffix.selector;
	const model = snapshot.find(
		candidate =>
			candidate.provider.toLowerCase() === provider.toLowerCase() &&
			candidate.id.toLowerCase() === baseId.toLowerCase(),
	);
	if (!model) return { unmatched: true };
	return { pinned: `${formatModelString(model)}:${suffix.thinkingLevel}` };
}

export function resolveTaskRouting(input: {
	effectiveAutorouting: AutoroutingEffective;
	requestedTier?: AutoroutingTier;
	availableModels?: readonly Model[];
}): RoutingOutcome {
	const { effectiveAutorouting, requestedTier, availableModels } = input;
	if (!effectiveAutorouting.active) return { kind: "disabled" };

	const tier = requestedTier ?? DEFAULT_AUTOROUTING_TIER;
	const defaultTierApplied = requestedTier === undefined ? true : undefined;
	const selectors = effectiveAutorouting.map[tier];
	if (!selectors || selectors.length === 0) {
		return {
			kind: "manual-fallback",
			tier,
			requestedTier,
			...(defaultTierApplied ? { defaultTierApplied } : {}),
			attemptedSelectorCount: 0,
			reason: "tier_missing_in_map",
		};
	}
	if (!availableModels) {
		return {
			kind: "manual-fallback",
			tier,
			requestedTier,
			...(defaultTierApplied ? { defaultTierApplied } : {}),
			attemptedSelectorCount: selectors.length,
			reason: "tier_unmatched",
		};
	}

	let attemptedSelectorCount = 0;
	for (const selector of selectors) {
		attemptedSelectorCount++;
		const normalized = normalizeTierSelector(selector, availableModels);
		if ("pinned" in normalized) {
			return {
				kind: "routed",
				tier,
				requestedTier,
				...(defaultTierApplied ? { defaultTierApplied } : {}),
				pinnedSelector: normalized.pinned,
			};
		}
	}
	return {
		kind: "manual-fallback",
		tier,
		requestedTier,
		...(defaultTierApplied ? { defaultTierApplied } : {}),
		attemptedSelectorCount,
		reason: "tier_unmatched",
	};
}
