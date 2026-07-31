/**
 * Dependency-free autorouting vocabulary, presets, and settings validators.
 *
 * This module deliberately does not import Settings, task code, or model
 * profiles.  It is the shared contract used by settings and (later) routing
 * policy code.
 */

export const AUTOROUTING_TIERS = ["fast", "balanced", "strong"] as const;
export type AutoroutingTier = (typeof AUTOROUTING_TIERS)[number];
export const DEFAULT_AUTOROUTING_TIER: AutoroutingTier = "balanced";

/** The normalized tier map consumed by routing policy. */
export type TierMap = Partial<Record<AutoroutingTier, string[]>>;

/** The permissive input shape accepted by the settings surface. */
export type AutoroutingTierMapInput = Partial<Record<AutoroutingTier, string | string[]>>;

export type AutoroutingPresetId = "anthropic" | "openai-codex" | "google" | "xai";

export const AUTOROUTING_PRESETS: Readonly<Record<AutoroutingPresetId, TierMap>> = {
	anthropic: {
		fast: ["anthropic/claude-haiku-4-5"],
		balanced: ["anthropic/claude-sonnet-5", "anthropic/claude-sonnet-4-6"],
		strong: ["anthropic/claude-opus-5:high", "anthropic/claude-opus-4-8:high"],
	},
	"openai-codex": {
		fast: ["openai-codex/gpt-5.6-terra:low"],
		balanced: ["openai-codex/gpt-5.6-terra:medium"],
		strong: ["openai-codex/gpt-5.6-sol:high"],
	},
	google: {
		fast: ["google/gemini-3.5-flash-lite", "google/gemini-2.5-flash-lite"],
		balanced: ["google/gemini-3.5-flash", "google/gemini-2.5-flash"],
		strong: ["google/gemini-3.1-pro-preview", "google/gemini-2.5-pro"],
	},
	xai: {
		fast: ["xai/grok-4.5:low", "xai/grok-4.3:low"],
		balanced: ["xai/grok-4.5:medium", "xai/grok-4.3:medium"],
		strong: ["xai/grok-4.5:high", "xai/grok-4.3:high"],
	},
};

export const AUTOROUTING_PRESET_IDS = Object.freeze(Object.keys(AUTOROUTING_PRESETS)) as readonly AutoroutingPresetId[];

/** The exact selector grammar published by the generated config schema. */
export const AUTOROUTING_SELECTOR_PATTERN = "^[^/\\s*?\\[]+\\/[^\\s*?\\[]+(?::(?:minimal|low|medium|high|xhigh))?$";

export const AUTOROUTING_SELECTOR_DESCRIPTION =
	"provider/modelId with an optional valid thinking suffix (:minimal|low|medium|high|xhigh), no globs, no bare model ids, no pi/<role> role aliases.";

export type AutoroutingReasonCode =
	| "tier_unmatched"
	| "tier_missing_in_map"
	| "config_invalid"
	| "map_absent"
	| "selector_not_provider_qualified"
	| "auth_substituted"
	| "assistant_model_mismatch";

export type AutoroutingLocalIssue = {
	path: string;
	code: AutoroutingReasonCode;
	/** Alias retained for callers that describe diagnostics as reasons. */
	reason: AutoroutingReasonCode;
	detail: string;
};

export type AutoroutingEffectiveIssue = {
	code: Extract<AutoroutingReasonCode, "config_invalid" | "map_absent">;
	/** Alias retained for callers that describe diagnostics as reasons. */
	reason: Extract<AutoroutingReasonCode, "config_invalid" | "map_absent">;
	detail: string;
};

export type AutoroutingEffective =
	| { active: true; map: TierMap; source: "tiers" | { preset: AutoroutingPresetId } }
	| { active: false; issue?: AutoroutingEffectiveIssue };

function issue(path: string, code: AutoroutingReasonCode, detail: string): AutoroutingLocalIssue {
	return { path, code, reason: code, detail };
}

function effectiveIssue(
	code: Extract<AutoroutingReasonCode, "config_invalid" | "map_absent">,
	detail: string,
): AutoroutingEffectiveIssue {
	return { code, reason: code, detail };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Validate one provider-qualified selector.  A selector has one provider
 * segment, a non-empty model remainder, and may carry one supported thinking
 * suffix.  Model ids may themselves contain slashes; the provider is always
 * the segment before the first slash.
 */
export function isValidAutoroutingSelector(value: unknown): value is string {
	if (typeof value !== "string" || value.length === 0 || value.trim() !== value) return false;
	if (/[*?[]/.test(value)) return false;
	if (!new RegExp(AUTOROUTING_SELECTOR_PATTERN).test(value)) return false;
	const separator = value.indexOf("/");
	if (separator <= 0) return false;
	const provider = value.slice(0, separator);
	return provider.toLowerCase() !== "pi";
}

function normalizeTierMap(value: unknown): TierMap {
	if (!isRecord(value)) return {};
	const normalized: TierMap = {};
	for (const tier of AUTOROUTING_TIERS) {
		const raw = value[tier];
		const selectors = typeof raw === "string" ? [raw] : Array.isArray(raw) ? raw : [];
		const usable = selectors.filter(isValidAutoroutingSelector);
		if (usable.length > 0) normalized[tier] = [...usable];
	}
	return normalized;
}

/** True when at least one known tier contains one grammatically valid selector. */
export function isMeaningfulTierMap(value: unknown): value is TierMap {
	return Object.values(normalizeTierMap(value)).some(selectors => selectors.length > 0);
}

/**
 * Resolve an explicit tier map before a preset.  An empty/default tiers object
 * does not mask a selected preset; a meaningful explicit map always wins.
 */
export function resolveTierMap(input: { tiers?: unknown; preset?: unknown }): TierMap {
	if (isMeaningfulTierMap(input.tiers)) return normalizeTierMap(input.tiers);
	if (typeof input.preset === "string" && Object.hasOwn(AUTOROUTING_PRESETS, input.preset)) {
		const preset = AUTOROUTING_PRESETS[input.preset as AutoroutingPresetId];
		return Object.fromEntries(
			AUTOROUTING_TIERS.filter(tier => preset[tier] !== undefined).map(tier => [tier, [...preset[tier]!]]),
		) as TierMap;
	}
	return {};
}

function validateSelectorValue(path: string, value: unknown, issues: AutoroutingLocalIssue[]): void {
	const selectors = typeof value === "string" ? [value] : Array.isArray(value) ? value : null;
	if (!selectors || selectors.length === 0 || selectors.some(selector => typeof selector !== "string")) {
		issues.push(issue(path, "config_invalid", "Expected a non-empty selector string or array of selector strings."));
		return;
	}
	for (let index = 0; index < selectors.length; index++) {
		if (!isValidAutoroutingSelector(selectors[index])) {
			issues.push(
				issue(
					Array.isArray(value) ? `${path}.${index}` : path,
					"selector_not_provider_qualified",
					`Expected ${AUTOROUTING_SELECTOR_DESCRIPTION}`,
				),
			);
		}
	}
}

/** Validate only local types, keys, and selector grammar for one source layer. */
export function validateAutoroutingLocal(fragment: unknown): AutoroutingLocalIssue[] {
	const issues: AutoroutingLocalIssue[] = [];
	if (fragment === undefined) return issues;
	if (!isRecord(fragment)) {
		issues.push(issue("", "config_invalid", "Expected task.autorouting to be an object."));
		return issues;
	}

	for (const key of Object.keys(fragment)) {
		if (key !== "enabled" && key !== "preset" && key !== "tiers") {
			issues.push(issue(key, "config_invalid", "Unknown autorouting setting key."));
		}
	}
	if (fragment.enabled !== undefined && typeof fragment.enabled !== "boolean") {
		issues.push(issue("enabled", "config_invalid", "Expected a boolean."));
	}
	if (fragment.preset !== undefined && typeof fragment.preset !== "string") {
		issues.push(issue("preset", "config_invalid", "Expected a string."));
	}
	if (fragment.tiers === undefined) return issues;
	if (!isRecord(fragment.tiers)) {
		issues.push(issue("tiers", "config_invalid", "Expected an object with only fast, balanced, and strong keys."));
		return issues;
	}
	for (const key of Object.keys(fragment.tiers)) {
		if (!AUTOROUTING_TIERS.includes(key as AutoroutingTier)) {
			issues.push(issue(`tiers.${key}`, "config_invalid", "Unknown tier key; expected fast, balanced, or strong."));
			continue;
		}
		validateSelectorValue(`tiers.${key}`, fragment.tiers[key], issues);
	}
	return issues;
}

/** Validate effective enablement and map/preset cross-field semantics. */
export function validateAutoroutingEffective(fragment: unknown): AutoroutingEffective {
	const availablePresetIds = [...AUTOROUTING_PRESET_IDS].sort();
	if (fragment === undefined || !isRecord(fragment)) return { active: false };
	if (fragment.enabled === undefined || fragment.enabled === false) return { active: false };
	if (fragment.enabled !== true) {
		return {
			active: false,
			issue: effectiveIssue(
				"config_invalid",
				"task.autorouting.enabled must be a boolean true to enable autorouting.",
			),
		};
	}
	const explicitMap = isMeaningfulTierMap(fragment.tiers);
	if (explicitMap) {
		return { active: true, map: resolveTierMap({ tiers: fragment.tiers }), source: "tiers" };
	}
	if (fragment.preset !== undefined && typeof fragment.preset !== "string") {
		return {
			active: false,
			issue: effectiveIssue(
				"config_invalid",
				`Autorouting preset must be one of: ${availablePresetIds.join(", ")}.`,
			),
		};
	}
	if (typeof fragment.preset === "string" && fragment.preset !== "") {
		if (Object.hasOwn(AUTOROUTING_PRESETS, fragment.preset)) {
			return {
				active: true,
				map: resolveTierMap({ preset: fragment.preset }),
				source: { preset: fragment.preset as AutoroutingPresetId },
			};
		}
		return {
			active: false,
			issue: effectiveIssue(
				"config_invalid",
				`Autorouting preset must be one of: ${availablePresetIds.join(", ")}.`,
			),
		};
	}
	return {
		active: false,
		issue: effectiveIssue(
			"map_absent",
			`Autorouting is enabled but has no usable tiers or preset. Available presets: ${availablePresetIds.join(", ")}.`,
		),
	};
}
