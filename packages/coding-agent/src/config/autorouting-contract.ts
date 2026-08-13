import { createHash } from "node:crypto";

/**
 * Dependency-free autorouting vocabulary and settings validators.
 *
 * This module deliberately does not import Settings, task code, or model
 * profiles.  It is the shared contract used by settings and (later) routing
 * policy code.
 */

export const AUTOROUTING_TIERS = ["fast", "balanced", "strong"] as const;
export type AutoroutingTier = (typeof AUTOROUTING_TIERS)[number];
export const DEFAULT_AUTOROUTING_TIER: AutoroutingTier = "balanced";

/**
 * The single wording for "autorouting is switched on but cannot route".
 *
 * One constant so every delivery surface (interactive, print, and the SDK/ACP
 * host) reports the identical sentence and cannot drift apart. Bounded and free
 * of interpolation so it is always safe to render.
 */
export const AUTOROUTING_INACTIVE_WARNING =
	"Autorouting is enabled but has no usable tier chains; Task items fall back to manual model resolution. Run /routing to inspect, or /model \u2192 smart routing to generate tiers.";

/** The normalized tier map consumed by routing policy. */
export type TierMap = Partial<Record<AutoroutingTier, string[]>>;

/** The permissive input shape accepted by the settings surface. */
export type AutoroutingTierMapInput = Partial<Record<AutoroutingTier, string | string[]>>;

export type AutoroutingSetup = {
	schema: 1;
	providers: string[];
	models?: string[];
};

/** Fingerprints describing the generated autorouting declaration and materialized tiers. */
export type AutoroutingProvenance = {
	schema: 1;
	source: {
		catalogFingerprint: string;
		mapFingerprint: string;
		generatorVersion: number;
	};
	declarationFingerprint: string;
	tiersFingerprint: string;
};

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
	| "assistant_model_mismatch"
	| "provider_disabled"
	| "snapshot_missing"
	| "credential_unavailable"
	| "preflight_spawn_failed"
	| "preflight_exhausted";

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
	| { active: true; map: TierMap }
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

export function normalizeTierMap(value: unknown): TierMap {
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

/** Validate the typed auto-setup declaration without consulting the model catalog. */
export function validateAutoroutingSetup(value: unknown): AutoroutingLocalIssue[] {
	const issues: AutoroutingLocalIssue[] = [];
	if (!isRecord(value)) {
		issues.push(issue("", "config_invalid", "Expected an autorouting setup object."));
		return issues;
	}
	for (const key of Object.keys(value)) {
		if (key !== "schema" && key !== "providers" && key !== "models") {
			issues.push(issue(key, "config_invalid", "Unknown autorouting setup key."));
		}
	}
	if (value.schema !== 1) issues.push(issue("schema", "config_invalid", "Expected schema version 1."));
	if (!Array.isArray(value.providers)) {
		issues.push(issue("providers", "config_invalid", "Expected a non-empty array of provider names."));
	} else {
		if (value.providers.length === 0) {
			issues.push(issue("providers", "config_invalid", "Expected a non-empty array of provider names."));
		}
		const seen = new Set<string>();
		for (let index = 0; index < value.providers.length; index++) {
			const provider = value.providers[index];
			if (typeof provider !== "string" || provider.length === 0 || provider.trim() !== provider) {
				issues.push(issue(`providers.${index}`, "config_invalid", "Expected a non-empty provider name."));
				continue;
			}
			if (seen.has(provider)) {
				issues.push(issue(`providers.${index}`, "config_invalid", "Provider declarations must be unique."));
				continue;
			}
			seen.add(provider);
		}
	}
	if (value.models !== undefined) {
		if (!Array.isArray(value.models)) {
			issues.push(issue("models", "config_invalid", "Expected an array of provider-qualified model selectors."));
		} else {
			for (let index = 0; index < value.models.length; index++) {
				if (!isValidAutoroutingSelector(value.models[index])) {
					issues.push(
						issue(
							`models.${index}`,
							"selector_not_provider_qualified",
							`Expected ${AUTOROUTING_SELECTOR_DESCRIPTION}`,
						),
					);
				}
			}
		}
	}
	return issues;
}

const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/u;

function validateFingerprint(path: string, value: unknown, issues: AutoroutingLocalIssue[]): void {
	if (typeof value !== "string" || !FINGERPRINT_PATTERN.test(value)) {
		issues.push(issue(path, "config_invalid", "Expected a lowercase 64-character SHA-256 fingerprint."));
	}
}

/** Validate generated-tier provenance and its source identity. */
export function validateAutoroutingProvenance(value: unknown): AutoroutingLocalIssue[] {
	const issues: AutoroutingLocalIssue[] = [];
	if (!isRecord(value)) {
		issues.push(issue("", "config_invalid", "Expected an autorouting provenance object."));
		return issues;
	}
	for (const key of Object.keys(value)) {
		if (key !== "schema" && key !== "source" && key !== "declarationFingerprint" && key !== "tiersFingerprint") {
			issues.push(issue(key, "config_invalid", "Unknown autorouting provenance key."));
		}
	}
	if (value.schema !== 1) issues.push(issue("schema", "config_invalid", "Expected schema version 1."));
	if (!isRecord(value.source)) {
		issues.push(issue("source", "config_invalid", "Expected a provenance source object."));
	} else {
		for (const key of Object.keys(value.source)) {
			if (key !== "catalogFingerprint" && key !== "mapFingerprint" && key !== "generatorVersion") {
				issues.push(issue(`source.${key}`, "config_invalid", "Unknown provenance source key."));
			}
		}
		validateFingerprint("source.catalogFingerprint", value.source.catalogFingerprint, issues);
		validateFingerprint("source.mapFingerprint", value.source.mapFingerprint, issues);
		if (
			typeof value.source.generatorVersion !== "number" ||
			!Number.isSafeInteger(value.source.generatorVersion) ||
			value.source.generatorVersion < 1
		) {
			issues.push(issue("source.generatorVersion", "config_invalid", "Expected an integer generator version >= 1."));
		}
	}
	validateFingerprint("declarationFingerprint", value.declarationFingerprint, issues);
	validateFingerprint("tiersFingerprint", value.tiersFingerprint, issues);
	return issues;
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
		if (!new Set(["enabled", "tiers", "setup", "provenance"]).has(key)) {
			issues.push(issue(key, "config_invalid", "Unknown autorouting setting key."));
		}
	}
	if (fragment.enabled !== undefined && typeof fragment.enabled !== "boolean") {
		issues.push(issue("enabled", "config_invalid", "Expected a boolean."));
	}

	if (fragment.setup !== undefined) {
		for (const setupIssue of validateAutoroutingSetup(fragment.setup)) {
			issues.push({ ...setupIssue, path: setupIssue.path ? `setup.${setupIssue.path}` : "setup" });
		}
	}
	if (fragment.provenance !== undefined) {
		for (const provenanceIssue of validateAutoroutingProvenance(fragment.provenance)) {
			issues.push({
				...provenanceIssue,
				path: provenanceIssue.path ? `provenance.${provenanceIssue.path}` : "provenance",
			});
		}
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

/** Return a canonical JSON representation with sorted object keys and stored array order. */
function canonicalAutoroutingJson(value: unknown): string {
	if (value === null) return "null";
	if (value === undefined) return "undefined";
	switch (typeof value) {
		case "string":
		case "boolean":
			return JSON.stringify(value);
		case "number":
			return Number.isFinite(value) ? JSON.stringify(value) : "null";
		case "bigint":
			throw new TypeError("Cannot canonicalize bigint");
		case "function":
		case "symbol":
			return "undefined";
		case "object":
			if (Array.isArray(value)) {
				return `[${value
					.map(item => {
						const encoded = canonicalAutoroutingJson(item);
						return encoded === "undefined" ? "null" : encoded;
					})
					.join(",")}]`;
			}
			return `{${Object.keys(value as Record<string, unknown>)
				.sort()
				.flatMap(key => {
					const encoded = canonicalAutoroutingJson((value as Record<string, unknown>)[key]);
					return encoded === "undefined" ? [] : [`${JSON.stringify(key)}:${encoded}`];
				})
				.join(",")}}`;
		default:
			return "undefined";
	}
}

function autoroutingSha256(value: unknown): string {
	return createHash("sha256")
		.update(new TextEncoder().encode(canonicalAutoroutingJson(value)))
		.digest("hex");
}

export type AutoroutingProvenanceState = {
	staleMap: boolean;
	staleCatalog: boolean;
	handEdited: boolean;
};

/** Compare recorded provenance with the current catalog/map/tier materialization. */
export function evaluateAutoroutingProvenanceState(
	provenance: AutoroutingProvenance | undefined,
	current: { catalogFingerprint: string; mapFingerprint: string; tiers: unknown },
): AutoroutingProvenanceState {
	if (!provenance) return { staleMap: false, staleCatalog: false, handEdited: false };
	return {
		staleMap: provenance.source.mapFingerprint !== current.mapFingerprint,
		staleCatalog: provenance.source.catalogFingerprint !== current.catalogFingerprint,
		handEdited: provenance.tiersFingerprint !== autoroutingSha256(current.tiers),
	};
}

/** Compare a recorded tier fingerprint with the current raw tier map. */
export function matchesRecordedTiersFingerprint(
	provenance: AutoroutingProvenance | undefined,
	tiers: unknown,
): boolean {
	return provenance !== undefined && provenance.tiersFingerprint === autoroutingSha256(tiers);
}

/** Advisory comparison between a recorded declaration and the current provider priority. */
export type AutoroutingProviderOrderHint = {
	/** The declaration lists the same providers in a different relative order. */
	reordered: boolean;
	/** Declared providers that the current catalog no longer offers, in declaration order. */
	missing: string[];
};

/**
 * Compare a recorded `setup.providers` declaration against the current provider
 * priority, for an advisory panel hint only.
 *
 * Pure string comparison over two arrays, normalized exactly the way provider
 * selection normalizes ids (trim + lowercase). It deliberately never reaches
 * provenance, effective state, routing, preflight, or evidence: a changed priority
 * is a new suggestion, not proof that persisted tiers went stale.
 */
export function autoroutingProviderOrderHint(
	setupProviders: readonly string[],
	currentOrder: readonly string[],
): AutoroutingProviderOrderHint {
	const normalize = (value: string): string => value.trim().toLowerCase();
	const current = currentOrder.map(normalize).filter(id => id.length > 0);
	const currentSet = new Set(current);
	const declared: string[] = [];
	const missing: string[] = [];
	const seen = new Set<string>();
	for (const raw of setupProviders) {
		const id = normalize(raw);
		if (!id || seen.has(id)) continue;
		seen.add(id);
		if (currentSet.has(id)) declared.push(id);
		else missing.push(raw);
	}
	// Only the providers common to both sides can disagree about order, so a
	// declaration that is a subset in the same relative order is not reordered.
	const expected = current.filter(id => seen.has(id));
	const reordered = declared.length === expected.length && declared.some((id, index) => id !== expected[index]);
	return { reordered, missing };
}

export type AutoroutingSettingsBatchPatch =
	| { path: "task.autorouting.tiers"; op: "set"; value: TierMap }
	| { path: "task.autorouting.setup"; op: "set"; value: AutoroutingSetup }
	| { path: "task.autorouting.provenance"; op: "set"; value: AutoroutingProvenance }
	| { path: "task.autorouting.tiers" | "task.autorouting.setup" | "task.autorouting.provenance"; op: "unset" };

/** Build the one atomic settings batch used by autorouting Apply/Refresh or Clear. */
export function buildAutoroutingSettingsBatch(
	input: { tiers: TierMap; setup: AutoroutingSetup; provenance: AutoroutingProvenance } | { clear: true },
): readonly AutoroutingSettingsBatchPatch[] {
	if ("clear" in input) {
		return [
			{ path: "task.autorouting.tiers", op: "unset" },
			{ path: "task.autorouting.setup", op: "unset" },
			{ path: "task.autorouting.provenance", op: "unset" },
		];
	}
	return [
		{ path: "task.autorouting.tiers", op: "set", value: structuredClone(input.tiers) },
		{ path: "task.autorouting.setup", op: "set", value: structuredClone(input.setup) },
		{ path: "task.autorouting.provenance", op: "set", value: structuredClone(input.provenance) },
	];
}

/** Convenience aliases for controller intents that all use one atomic batch. */
export const buildAutoroutingApplyPatches = buildAutoroutingSettingsBatch;
export const buildAutoroutingRefreshPatches = buildAutoroutingSettingsBatch;
export const buildAutoroutingClearPatches = () => buildAutoroutingSettingsBatch({ clear: true });

/** Build the separate single-key enabled toggle mutation. */
export function buildAutoroutingEnabledPatch(enabled: boolean): {
	path: "task.autorouting.enabled";
	op: "set";
	value: boolean;
} {
	return { path: "task.autorouting.enabled", op: "set", value: enabled };
}

/** Validate effective enablement and map cross-field semantics. */
export function validateAutoroutingEffective(fragment: unknown): AutoroutingEffective {
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
	if (isMeaningfulTierMap(fragment.tiers)) {
		return { active: true, map: normalizeTierMap(fragment.tiers) };
	}
	return {
		active: false,
		issue: effectiveIssue(
			"map_absent",
			"Autorouting is enabled but has no usable tiers. Generate them from the /model smart-routing panel.",
		),
	};
}
