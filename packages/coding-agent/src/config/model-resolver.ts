/**
 * Model resolution, scoping, and initial selection
 */

import { ThinkingLevel } from "@gajae-code/agent-core";
import { type Api, DEFAULT_MODEL_PER_PROVIDER, type KnownProvider, type Model, modelsAreEqual } from "@gajae-code/ai";
import { fuzzyMatch } from "@gajae-code/tui";
import { logger } from "@gajae-code/utils";
import chalk from "chalk";
import { parseThinkingLevel, resolveThinkingLevelForModel } from "../thinking";
import { isAuthenticated, kNoAuth, MODEL_ROLE_IDS, type ModelRegistry, type ModelRole } from "./model-registry";
import { type ModelSelectorValue, normalizeModelSelectorValue } from "./model-selector-value";
import type { Settings } from "./settings";

/** Default model IDs for each known provider */
export const defaultModelPerProvider: Record<KnownProvider, string> = DEFAULT_MODEL_PER_PROVIDER;

/**
 * Cursor's current RPC transport executes its exec protocol while streaming and
 * has no client-side tool-call mode. Managed fallback attempts must not enable
 * that irreversible path.
 */
export function managedCursorFallbackUnavailableReason(model: Model<Api>, selector: string): string | undefined {
	if (model.api !== "cursor-agent") return undefined;
	return `Cursor model ${selector} requires provider-side tool execution and cannot be used in a retryable fallback chain`;
}

export interface ScopedModelSelection {
	model: Model<Api>;
	thinkingLevel?: ThinkingLevel;
	explicitThinkingLevel?: boolean;
}

export interface ScopedModel extends ScopedModelSelection {
	explicitThinkingLevel: boolean;
}

/**
 * Parse a model string in "provider/modelId" format.
 * Returns undefined if the format is invalid.
 */
export function parseModelString(
	modelStr: string,
): { provider: string; id: string; thinkingLevel?: ThinkingLevel } | undefined {
	const slashIdx = modelStr.indexOf("/");
	if (slashIdx <= 0) return undefined;
	const id = modelStr.slice(slashIdx + 1);
	const provider = modelStr.slice(0, slashIdx);
	// Strip valid thinking level suffix (e.g., "Anthropic model-sonnet-4-6:high" -> id "Anthropic model-sonnet-4-6", thinkingLevel "high")
	const colonIdx = id.lastIndexOf(":");
	if (colonIdx !== -1) {
		const suffix = id.slice(colonIdx + 1);
		const thinkingLevel = parseThinkingLevel(suffix);
		if (thinkingLevel) {
			return { provider, id: id.slice(0, colonIdx), thinkingLevel };
		}
	}
	return { provider, id };
}

/**
 * Format a model as "provider/modelId" string.
 */
export function formatModelString(model: Model<Api>): string {
	return `${model.provider}/${model.id}`;
}

export function formatModelSelectorValue(selector: string, thinkingLevel: ThinkingLevel | undefined): string {
	return thinkingLevel && thinkingLevel !== ThinkingLevel.Inherit ? `${selector}:${thinkingLevel}` : selector;
}

function getOpenRouterRouteSuffix(modelId: string): { baseId: string; suffix: string } | undefined {
	const colonIdx = modelId.lastIndexOf(":");
	if (colonIdx === -1) {
		return undefined;
	}

	const suffix = modelId.slice(colonIdx + 1).trim();
	if (!suffix || parseThinkingLevel(suffix)) {
		return undefined;
	}

	return { baseId: modelId.slice(0, colonIdx), suffix };
}

function stripOpenRouterDateSuffix(modelId: string): string | undefined {
	const stripped = modelId.replace(/-\d{8}(?=$|:)/i, "");
	return stripped !== modelId ? stripped : undefined;
}

function getOpenRouterFallbackModelIds(modelId: string): string[] {
	const orderedCandidates: string[] = [];
	const queue = [modelId];
	const seen = new Set<string>();

	while (queue.length > 0) {
		const candidate = queue.shift();
		if (!candidate || seen.has(candidate)) {
			continue;
		}
		seen.add(candidate);
		orderedCandidates.push(candidate);

		const routedSuffix = getOpenRouterRouteSuffix(candidate);
		if (routedSuffix) {
			queue.push(routedSuffix.baseId);
		}

		const strippedDate = stripOpenRouterDateSuffix(candidate);
		if (strippedDate) {
			queue.push(strippedDate);
		}
	}

	return orderedCandidates;
}

function cloneModelWithRequestedId(model: Model<Api>, requestedId: string): Model<Api> {
	return {
		...model,
		id: requestedId,
		...(model.name === model.id ? { name: requestedId } : {}),
	};
}

const kProviderModelIndex = Symbol("model-resolver.providerIndex");
type ModelsWithProviderIndex = readonly Model<Api>[] & {
	[kProviderModelIndex]?: Map<string, Model<Api> | null>;
};

function getProviderModelIndex(availableModels: readonly Model<Api>[]): Map<string, Model<Api> | null> {
	const tagged = availableModels as ModelsWithProviderIndex;
	const cached = tagged[kProviderModelIndex];
	if (cached) return cached;
	const index = new Map<string, Model<Api> | null>();
	for (const m of availableModels) {
		const key = `${m.provider.toLowerCase()}\u0000${m.id.toLowerCase()}`;
		if (index.has(key)) {
			index.set(key, null); // ambiguous sentinel; do not overwrite back
		} else {
			index.set(key, m);
		}
	}
	tagged[kProviderModelIndex] = index;
	return index;
}

export function resolveProviderModelReference(
	provider: string,
	modelId: string,
	availableModels: readonly Model<Api>[],
): Model<Api> | undefined {
	const trimmedProvider = provider.trim();
	const trimmedModelId = modelId.trim();
	const normalizedProvider = trimmedProvider.toLowerCase();
	const normalizedModelId = trimmedModelId.toLowerCase();
	if (!normalizedProvider || !normalizedModelId) {
		return undefined;
	}

	// Prefer an exact provider/model id match before falling back to the
	// case-insensitive index. Some provider catalogs intentionally carry both a
	// machine-id form (for example `minimax-m3`) and a display-cased alias
	// (`MiniMax-M3`). The lowercase index correctly treats those aliases as
	// ambiguous for fuzzy/case-insensitive lookup, but an exact selector should
	// still resolve deterministically.
	const caseExact = availableModels.find(m => m.provider === trimmedProvider && m.id === trimmedModelId);
	if (caseExact) return caseExact;

	const index = getProviderModelIndex(availableModels);
	const exact = index.get(`${normalizedProvider}\u0000${normalizedModelId}`);
	if (exact === null) {
		return undefined; // ambiguous
	}
	if (exact !== undefined) {
		return exact;
	}

	if (normalizedProvider !== "openrouter") {
		return undefined;
	}

	for (const fallbackId of getOpenRouterFallbackModelIds(modelId).slice(1)) {
		const fallback = index.get(`${normalizedProvider}\u0000${fallbackId.toLowerCase()}`);
		if (fallback === null) {
			return undefined;
		}
		if (fallback !== undefined) {
			return cloneModelWithRequestedId(fallback, modelId);
		}
	}

	return undefined;
}

export interface ModelMatchPreferences {
	/** Most-recently-used model keys (provider/modelId) to prefer when ambiguous. */
	usageOrder?: string[];
	/** Providers to deprioritize when no recent usage is available. */
	deprioritizeProviders?: string[];
}

export type CanonicalModelRegistry = Partial<
	Pick<ModelRegistry, "resolveCanonicalModel" | "getCanonicalVariants" | "getCanonicalId" | "seedCanonicalVariant">
>;
export type ModelLookupRegistry = Pick<ModelRegistry, "getAvailable"> & Partial<CanonicalModelRegistry>;
type CliModelRegistry = Pick<ModelRegistry, "getAll"> & Partial<CanonicalModelRegistry>;
type InitialModelRegistry = Pick<ModelRegistry, "getAvailable" | "find">;
type RestorableModelRegistry = Pick<ModelRegistry, "getAvailable" | "find" | "getApiKey">;

interface ModelPreferenceContext {
	modelUsageRank: Map<string, number>;
	providerUsageRank: Map<string, number>;
	deprioritizedProviders: Set<string>;
	modelOrder: Map<string, number>;
}

function buildPreferenceContext(
	availableModels: Model<Api>[],
	preferences: ModelMatchPreferences | undefined,
): ModelPreferenceContext {
	const modelUsageRank = new Map<string, number>();
	const providerUsageRank = new Map<string, number>();
	const usageOrder = preferences?.usageOrder ?? [];
	for (let i = 0; i < usageOrder.length; i += 1) {
		const key = usageOrder[i];
		if (!modelUsageRank.has(key)) {
			modelUsageRank.set(key, i);
		}
		const parsed = parseModelString(key);
		if (parsed && !providerUsageRank.has(parsed.provider)) {
			providerUsageRank.set(parsed.provider, i);
		}
	}

	const deprioritizedProviders = new Set(preferences?.deprioritizeProviders ?? ["openrouter"]);
	const modelOrder = new Map<string, number>();
	for (let i = 0; i < availableModels.length; i += 1) {
		modelOrder.set(formatModelString(availableModels[i]), i);
	}

	return { modelUsageRank, providerUsageRank, deprioritizedProviders, modelOrder };
}

function pickPreferredModel(candidates: Model<Api>[], context: ModelPreferenceContext): Model<Api> {
	if (candidates.length <= 1) return candidates[0];
	return [...candidates].sort((a, b) => {
		const aKey = formatModelString(a);
		const bKey = formatModelString(b);
		const aUsage = context.modelUsageRank.get(aKey);
		const bUsage = context.modelUsageRank.get(bKey);
		if (aUsage !== undefined || bUsage !== undefined) {
			return (aUsage ?? Number.POSITIVE_INFINITY) - (bUsage ?? Number.POSITIVE_INFINITY);
		}

		const aProviderUsage = context.providerUsageRank.get(a.provider);
		const bProviderUsage = context.providerUsageRank.get(b.provider);
		if (aProviderUsage !== undefined || bProviderUsage !== undefined) {
			return (aProviderUsage ?? Number.POSITIVE_INFINITY) - (bProviderUsage ?? Number.POSITIVE_INFINITY);
		}

		// Prefer vision-capable variants over configured provider/registration order
		// so an ambiguous id never resolves to a text-only namesake when a
		// vision-capable variant of the same id is available.
		const aVision = a.input.includes("image") ? 0 : 1;
		const bVision = b.input.includes("image") ? 0 : 1;
		if (aVision !== bVision) {
			return aVision - bVision;
		}

		const aDeprioritized = context.deprioritizedProviders.has(a.provider);
		const bDeprioritized = context.deprioritizedProviders.has(b.provider);
		if (aDeprioritized !== bDeprioritized) {
			return aDeprioritized ? 1 : -1;
		}

		const aOrder = context.modelOrder.get(aKey) ?? 0;
		const bOrder = context.modelOrder.get(bKey) ?? 0;
		return aOrder - bOrder;
	})[0];
}

/**
 * Helper to check if a model ID looks like an alias (no date suffix)
 * Dates are typically in format: -20241022 or -20250929
 */
function isAlias(id: string): boolean {
	// Check if ID ends with -latest
	if (id.endsWith("-latest")) return true;

	// Check if ID ends with a date pattern (-YYYYMMDD)
	const datePattern = /-\d{8}$/;
	return !datePattern.test(id);
}

/**
 * Find an exact explicit provider/model match.
 * Bare model ids are handled separately so canonical ids can coalesce variants.
 */
export function findExactModelReferenceMatch(
	modelReference: string,
	availableModels: Model<Api>[],
): Model<Api> | undefined {
	const trimmedReference = modelReference.trim();
	if (!trimmedReference) {
		return undefined;
	}

	const slashIndex = trimmedReference.indexOf("/");
	if (slashIndex !== -1) {
		const provider = trimmedReference.substring(0, slashIndex).trim();
		const modelId = trimmedReference.substring(slashIndex + 1).trim();
		if (provider && modelId) {
			return resolveProviderModelReference(provider, modelId, availableModels);
		}
	}
	return undefined;
}

function findExactCanonicalModelMatch(
	modelReference: string,
	availableModels: Model<Api>[],
	modelRegistry: CanonicalModelRegistry | undefined,
	sessionId?: string,
): Model<Api> | undefined {
	if (!modelRegistry) {
		return undefined;
	}
	const trimmedReference = modelReference.trim();
	if (!trimmedReference || trimmedReference.includes("/")) {
		return undefined;
	}
	return modelRegistry.resolveCanonicalModel?.(trimmedReference, {
		availableOnly: false,
		candidates: availableModels,
		sessionId,
	});
}

/**
 * Try to match a pattern to a model from the available models list.
 * Returns the matched model or undefined if no match found.
 */
function tryMatchModel(
	modelPattern: string,
	availableModels: Model<Api>[],
	context: ModelPreferenceContext,
	options?: { modelRegistry?: CanonicalModelRegistry; sessionId?: string },
): Model<Api> | undefined {
	// Explicit provider/model selectors always bypass canonical coalescing.
	const exactRefMatch = findExactModelReferenceMatch(modelPattern, availableModels);
	if (exactRefMatch) {
		return exactRefMatch;
	}

	// Exact canonical ids coalesce provider variants before bare-id matching.
	const exactCanonicalMatch = findExactCanonicalModelMatch(
		modelPattern,
		availableModels,
		options?.modelRegistry,
		options?.sessionId,
	);
	if (exactCanonicalMatch) {
		return exactCanonicalMatch;
	}

	// Exact ID match (case-insensitive) — this must happen before provider-scoped
	// fuzzy matching so raw IDs that contain slashes (for example OpenRouter model
	// IDs like "openai/gpt-4o:extended") still resolve as IDs instead of being
	// misread as a provider-qualified selector.
	const exactMatches = availableModels.filter(m => m.id.toLowerCase() === modelPattern.toLowerCase());
	if (exactMatches.length > 0) {
		return pickPreferredModel(exactMatches, context);
	}
	// Check for provider/modelId format — fuzzy match within provider only.
	const slashIndex = modelPattern.indexOf("/");
	if (slashIndex !== -1) {
		const provider = modelPattern.substring(0, slashIndex);
		const modelId = modelPattern.substring(slashIndex + 1);
		const providerModels = availableModels.filter(m => m.provider.toLowerCase() === provider.toLowerCase());
		if (providerModels.length === 0) {
			// The prefix is not a known provider in this candidate set, so treat the
			// slash as part of the raw model ID and continue with generic matching.
		} else {
			const scored = providerModels
				.map(model => ({ model, match: fuzzyMatch(modelId, model.id) }))
				.filter(entry => entry.match.matches);
			if (scored.length === 0) {
				return undefined;
			}

			scored.sort((a, b) => {
				if (a.match.score !== b.match.score) return a.match.score - b.match.score;
				const aKey = formatModelString(a.model);
				const bKey = formatModelString(b.model);
				const aUsage = context.modelUsageRank.get(aKey) ?? Number.POSITIVE_INFINITY;
				const bUsage = context.modelUsageRank.get(bKey) ?? Number.POSITIVE_INFINITY;
				if (aUsage !== bUsage) return aUsage - bUsage;

				const aProviderUsage = context.providerUsageRank.get(a.model.provider) ?? Number.POSITIVE_INFINITY;
				const bProviderUsage = context.providerUsageRank.get(b.model.provider) ?? Number.POSITIVE_INFINITY;
				if (aProviderUsage !== bProviderUsage) return aProviderUsage - bProviderUsage;

				const aOrder = context.modelOrder.get(aKey) ?? 0;
				const bOrder = context.modelOrder.get(bKey) ?? 0;
				return aOrder - bOrder;
			});
			return scored[0]?.model;
		}
	}

	// No exact match - fall back to partial matching
	const matches = availableModels.filter(
		m =>
			m.id.toLowerCase().includes(modelPattern.toLowerCase()) ||
			m.name?.toLowerCase().includes(modelPattern.toLowerCase()),
	);

	if (matches.length === 0) {
		return undefined;
	}

	// Separate into aliases and dated versions
	const aliases = matches.filter(m => isAlias(m.id));
	const datedVersions = matches.filter(m => !isAlias(m.id));

	if (aliases.length > 0) {
		return pickPreferredModel(aliases, context);
	}
	if (datedVersions.length === 0) return undefined;

	if (datedVersions.length === 1) {
		return datedVersions[0];
	}

	const sortedById = [...datedVersions].sort((a, b) => b.id.localeCompare(a.id));
	const topId = sortedById[0]?.id;
	if (!topId) return undefined;
	const topCandidates = sortedById.filter(model => model.id === topId);
	return pickPreferredModel(topCandidates, context);
}

export interface ParsedModelResult {
	model: Model<Api> | undefined;
	/** Thinking level if explicitly specified in pattern, undefined otherwise */
	thinkingLevel?: ThinkingLevel;
	warning: string | undefined;
	explicitThinkingLevel: boolean;
}

/**
 * Parse a pattern to extract model and thinking level.
 * Handles models with colons in their IDs (e.g., OpenRouter's :exacto suffix).
 *
 * Algorithm:
 * 1. Try to match full pattern as a model
 * 2. If found, return it with undefined thinking level
 * 3. If not found and has colons, split on last colon:
 *    - If suffix is valid thinking level, use it and recurse on prefix
 *    - If suffix is invalid, warn and recurse on prefix
 *
 * @internal Exported for testing
 */
function parseModelPatternWithContext(
	pattern: string,
	availableModels: Model<Api>[],
	context: ModelPreferenceContext,
	options?: {
		allowInvalidThinkingSelectorFallback?: boolean;
		modelRegistry?: CanonicalModelRegistry;
		sessionId?: string;
	},
): ParsedModelResult {
	// Try exact match first
	const exactMatch = tryMatchModel(pattern, availableModels, context, options);
	if (exactMatch) {
		return { model: exactMatch, thinkingLevel: undefined, warning: undefined, explicitThinkingLevel: false };
	}

	// No match - try splitting on last colon if present
	const lastColonIndex = pattern.lastIndexOf(":");
	if (lastColonIndex === -1) {
		// No colons, pattern simply doesn't match any model
		return { model: undefined, thinkingLevel: undefined, warning: undefined, explicitThinkingLevel: false };
	}

	const prefix = pattern.substring(0, lastColonIndex);
	const suffix = pattern.substring(lastColonIndex + 1);

	const parsedThinkingLevel = parseThinkingLevel(suffix);
	if (parsedThinkingLevel) {
		// Valid thinking level - recurse on prefix and use this level
		const result = parseModelPatternWithContext(prefix, availableModels, context, options);
		if (result.model) {
			// Only use this thinking level if no warning from inner recursion
			const explicitThinkingLevel = !result.warning;
			return {
				model: result.model,
				thinkingLevel: explicitThinkingLevel ? parsedThinkingLevel : undefined,
				warning: result.warning,
				explicitThinkingLevel,
			};
		}
		return result;
	}

	const allowFallback = options?.allowInvalidThinkingSelectorFallback ?? true;
	if (!allowFallback) {
		return { model: undefined, thinkingLevel: undefined, warning: undefined, explicitThinkingLevel: false };
	}

	// Invalid suffix - recurse on prefix and warn
	const result = parseModelPatternWithContext(prefix, availableModels, context, options);
	if (result.model) {
		return {
			model: result.model,
			thinkingLevel: undefined,
			warning: `Invalid thinking level "${suffix}" in pattern "${pattern}". Using default instead.`,
			explicitThinkingLevel: false,
		};
	}
	return result;
}

export function parseModelPattern(
	pattern: string,
	availableModels: Model<Api>[],
	preferences?: ModelMatchPreferences,
	options?: {
		allowInvalidThinkingSelectorFallback?: boolean;
		modelRegistry?: CanonicalModelRegistry;
		sessionId?: string;
	},
): ParsedModelResult {
	const context = buildPreferenceContext(availableModels, preferences);
	return parseModelPatternWithContext(pattern, availableModels, context, options);
}

const PREFIX_MODEL_ROLE = "pi/";
const DEFAULT_MODEL_ROLE = "default";

function getModelRoleAlias(value: string): ModelRole | undefined {
	const normalized = value.trim();
	if (!normalized.startsWith(PREFIX_MODEL_ROLE)) return undefined;

	const candidate = normalized.slice(PREFIX_MODEL_ROLE.length);
	for (const role of MODEL_ROLE_IDS) {
		if (candidate === role) return role;
	}
	return undefined;
}

function normalizeModelPatternList(value: ModelSelectorValue | undefined): string[] {
	return normalizeModelSelectorValue(value);
}

function isSessionInheritedAgentPattern(value: string): boolean {
	return value === DEFAULT_MODEL_ROLE || value === `${PREFIX_MODEL_ROLE}${DEFAULT_MODEL_ROLE}`;
}

function resolveConfiguredRolePattern(value: string, settings?: Settings): string[] | undefined {
	const normalized = value.trim();
	if (!normalized) return undefined;

	const lastColonIndex = normalized.lastIndexOf(":");
	const thinkingLevel =
		lastColonIndex > PREFIX_MODEL_ROLE.length ? parseThinkingLevel(normalized.slice(lastColonIndex + 1)) : undefined;
	const aliasCandidate = thinkingLevel ? normalized.slice(0, lastColonIndex) : normalized;
	const role = getModelRoleAlias(aliasCandidate);
	if (!role) return [normalized];

	const configured = settings?.getModelRole(role);
	const resolved = configured ? normalizeModelPatternList(configured) : undefined;
	if (!resolved || resolved.length === 0) {
		return undefined;
	}

	return thinkingLevel ? resolved.map(pattern => `${pattern}:${thinkingLevel}`) : resolved;
}

/**
 * Expand a role alias like "pi/default" to the configured model string.
 */
export function expandRoleAlias(value: string, settings?: Settings): string {
	const normalized = value.trim();
	if (normalized === DEFAULT_MODEL_ROLE) {
		return normalizeModelPatternList(settings?.getModelRole("default"))[0] ?? value;
	}

	const resolved = resolveConfiguredRolePattern(value, settings)?.[0];
	return resolved ?? value;
}

export function resolveConfiguredModelPatterns(value: ModelSelectorValue | undefined, settings?: Settings): string[] {
	const patterns = normalizeModelPatternList(value);
	return patterns.flatMap(pattern => {
		const resolved = resolveConfiguredRolePattern(pattern, settings);
		return resolved ?? [];
	});
}
export interface AgentModelPatternResolutionOptions {
	settingsOverride?: ModelSelectorValue;
	agentModel?: ModelSelectorValue;
	settings?: Settings;
	activeModelPattern?: string;
	fallbackModelPattern?: string;
}

export function resolveAgentModelPatterns(options: AgentModelPatternResolutionOptions): string[] {
	const { settingsOverride, agentModel, settings, activeModelPattern, fallbackModelPattern } = options;

	const overridePatterns = resolveConfiguredModelPatterns(settingsOverride, settings);
	if (overridePatterns.length > 0) return overridePatterns;

	const normalizedAgentPatterns = normalizeModelPatternList(agentModel);
	const configuredAgentPatterns = resolveConfiguredModelPatterns(agentModel, settings);
	const singleAgentPattern = normalizedAgentPatterns.length === 1 ? normalizedAgentPatterns[0] : undefined;
	const agentInheritsSessionModel = singleAgentPattern ? isSessionInheritedAgentPattern(singleAgentPattern) : false;
	if (configuredAgentPatterns.length > 0 && !agentInheritsSessionModel) {
		return configuredAgentPatterns;
	}

	const fallback =
		activeModelPattern?.trim() ||
		fallbackModelPattern?.trim() ||
		normalizeModelPatternList(settings?.getModelRole("default"))[0] ||
		"";
	return resolveConfiguredModelPatterns(fallback, settings);
}

/**
 * Resolve a model role value into a concrete model and thinking metadata.
 */
export interface ResolvedModelRoleValue {
	model: Model<Api> | undefined;
	thinkingLevel?: ThinkingLevel;
	explicitThinkingLevel: boolean;
	warning: string | undefined;
}

export function resolveModelRoleValue(
	roleValue: ModelSelectorValue | undefined,
	availableModels: Model<Api>[],
	options?: {
		settings?: Settings;
		matchPreferences?: ModelMatchPreferences;
		modelRegistry?: CanonicalModelRegistry;
		sessionId?: string;
	},
): ResolvedModelRoleValue {
	const effectivePatterns = normalizeModelPatternList(roleValue).flatMap(
		pattern => resolveConfiguredRolePattern(pattern, options?.settings) ?? [],
	);
	if (effectivePatterns.length === 0) {
		return { model: undefined, thinkingLevel: undefined, explicitThinkingLevel: false, warning: undefined };
	}

	let warning: string | undefined;
	for (const effectivePattern of effectivePatterns) {
		const resolved = parseModelPattern(effectivePattern, availableModels, options?.matchPreferences, {
			modelRegistry: options?.modelRegistry,
			sessionId: options?.sessionId,
		});
		if (resolved.model) {
			return {
				model: resolved.model,
				thinkingLevel: resolved.explicitThinkingLevel
					? (resolveThinkingLevelForModel(resolved.model, resolved.thinkingLevel) ?? resolved.thinkingLevel)
					: resolved.thinkingLevel,
				explicitThinkingLevel: resolved.explicitThinkingLevel,
				warning: resolved.warning,
			};
		}
		if (!warning && resolved.warning) {
			warning = resolved.warning;
		}
	}

	return { model: undefined, thinkingLevel: undefined, explicitThinkingLevel: false, warning };
}

export function extractExplicitThinkingSelector(
	value: ModelSelectorValue | undefined,
	settings?: Settings,
): ThinkingLevel | undefined {
	const normalized = normalizeModelPatternList(value)[0];
	if (!normalized || normalized === DEFAULT_MODEL_ROLE) return undefined;

	const visited = new Set<string>();
	let current = normalized;
	while (!visited.has(current)) {
		visited.add(current);
		const lastColonIndex = current.lastIndexOf(":");
		const thinkingSelector =
			lastColonIndex > PREFIX_MODEL_ROLE.length ? parseThinkingLevel(current.slice(lastColonIndex + 1)) : undefined;
		if (thinkingSelector) {
			return thinkingSelector;
		}
		const expanded = expandRoleAlias(current, settings).trim();
		if (!expanded || expanded === current) break;
		if (expanded === DEFAULT_MODEL_ROLE) return undefined;
		current = expanded;
	}

	return undefined;
}

/**
 * Resolve a model identifier or pattern to a Model instance.
 */
export function resolveModelFromString(
	value: string,
	available: Model<Api>[],
	matchPreferences?: ModelMatchPreferences,
	modelRegistry?: CanonicalModelRegistry,
): Model<Api> | undefined {
	const parsed = parseModelString(value);
	if (parsed) {
		const exact = available.find(model => model.provider === parsed.provider && model.id === parsed.id);
		if (exact) return exact;
	}
	return parseModelPattern(value, available, matchPreferences, { modelRegistry }).model;
}

/**
 * Resolve a model from configured roles, honoring order and overrides.
 */
export function resolveModelFromSettings(options: {
	settings: Settings;
	availableModels: Model<Api>[];
	matchPreferences?: ModelMatchPreferences;
	roleOrder?: readonly ModelRole[];
	modelRegistry?: CanonicalModelRegistry;
}): Model<Api> | undefined {
	const { settings, availableModels, matchPreferences, roleOrder, modelRegistry } = options;
	const roles = roleOrder ?? MODEL_ROLE_IDS;
	let sawConfiguredProviderQualifiedRole = false;
	for (const role of roles) {
		const configured = settings.getModelRole(role);
		const expanded = normalizeModelPatternList(configured)[0];
		if (!expanded) continue;
		const resolvedValue = expandRoleAlias(expanded, settings).trim();
		if (expanded.includes("/")) {
			sawConfiguredProviderQualifiedRole = true;
		}
		const resolved = resolveModelFromString(resolvedValue, availableModels, matchPreferences, modelRegistry);
		if (resolved) return resolved;
	}
	return sawConfiguredProviderQualifiedRole ? undefined : availableModels[0];
}

/**
 * Resolve a list of override patterns to the first matching model.
 */
export function resolveModelOverride(
	modelPatterns: string[],
	modelRegistry: ModelLookupRegistry,
	settings?: Settings,
	sessionId?: string,
): { model?: Model<Api>; thinkingLevel?: ThinkingLevel; explicitThinkingLevel: boolean } {
	if (modelPatterns.length === 0) return { explicitThinkingLevel: false };
	const availableModels = modelRegistry.getAvailable();
	const matchPreferences = { usageOrder: settings?.getStorage()?.getModelUsageOrder() };
	for (const pattern of modelPatterns) {
		const { model, thinkingLevel, explicitThinkingLevel } = resolveModelRoleValue(pattern, availableModels, {
			settings,
			matchPreferences,
			modelRegistry,
			sessionId,
		});
		if (model) {
			return { model, thinkingLevel, explicitThinkingLevel };
		}
	}
	return { explicitThinkingLevel: false };
}

/**
 * Resolve a configured fallback chain to its first callable entry without
 * charging requests. For retryable chains, consumers MUST pass
 * `{ managedFallback: true }` so unsuitable entries (including Cursor's
 * provider-side tool mode) fail closed during resolution before any request
 * is attempted. Single-entry chains remain non-managed selections.
 */
export interface ModelChainResolutionOptions {
	managedFallback?: boolean;
}

export async function resolveModelChainWithAuth(
	modelPatterns: readonly string[],
	modelRegistry: ModelLookupRegistry & Pick<ModelRegistry, "getApiKey">,
	settings?: Settings,
	sessionId?: string,
	options?: ModelChainResolutionOptions,
): Promise<{
	model?: Model<Api>;
	thinkingLevel?: ThinkingLevel;
	explicitThinkingLevel: boolean;
	activeIndex: number;
	skips: Array<{ selector: string; reason: string }>;
}> {
	const availableModels = modelRegistry.getAvailable();
	const matchPreferences = { usageOrder: settings?.getStorage()?.getModelUsageOrder() };
	const skips: Array<{ selector: string; reason: string }> = [];
	for (let activeIndex = 0; activeIndex < modelPatterns.length; activeIndex += 1) {
		const selector = modelPatterns[activeIndex];
		const candidate = resolveModelRoleValue(selector, availableModels, {
			settings,
			matchPreferences,
			modelRegistry,
			sessionId,
		});
		if (!candidate.model) {
			skips.push({ selector, reason: "unknown_model" });
			continue;
		}
		if (options?.managedFallback && modelPatterns.length > 1) {
			const cursorReason = managedCursorFallbackUnavailableReason(candidate.model, selector);
			if (cursorReason) {
				skips.push({ selector, reason: cursorReason });
				continue;
			}
		}
		const key = await modelRegistry.getApiKey(candidate.model, sessionId);
		if (key === kNoAuth || isAuthenticated(key)) {
			return { ...candidate, activeIndex, skips };
		}
		skips.push({ selector, reason: "unauthenticated" });
	}
	return { explicitThinkingLevel: false, activeIndex: modelPatterns.length, skips };
}

/**
 * Resolve a list of override patterns to the first matching model, with an
 * auth-aware fallback to the parent session's active model.
 *
 * If the resolved subagent model has no working credentials (provider has no
 * usable auth), and the parent's active model resolves with working auth,
 * use the parent's model instead. This prevents subagent dispatch from
 * silently routing to a provider the user can't actually call (e.g.
 * `modelRoles.task` pointing at an unqualified id whose only available
 * provider variant has no configured credentials — see #985).
 *
 * Keyless-by-design providers (llama.cpp, ollama, lm-studio) advertise the
 * `kNoAuth` sentinel from `getApiKey` to signal that they do not require
 * credentials. Those are treated as authenticated here so an explicitly
 * configured local model is never silently rerouted to the parent's remote
 * provider (see #1008).
 *
 * If neither the subagent nor the parent has working auth, returns the
 * primary resolution unchanged so the existing error path still surfaces
 * a meaningful failure downstream.
 */
export async function resolveModelOverrideWithAuthFallback(
	modelPatterns: string[],
	parentActiveModelPattern: string | undefined,
	modelRegistry: ModelLookupRegistry & Pick<ModelRegistry, "getApiKey">,
	settings?: Settings,
	authSessionId?: string,
	options?: ModelChainResolutionOptions,
	canonicalSessionId?: string,
): Promise<{
	model?: Model<Api>;
	thinkingLevel?: ThinkingLevel;
	explicitThinkingLevel: boolean;
	authFallbackUsed: boolean;
	requestedModel?: Model<Api>;
	fallbackReason?: "auth_unavailable";
	activeIndex?: number;
	parentFallbackSelector?: string;
	skips: Array<{ selector: string; reason: string }>;
}> {
	const availableModels = modelRegistry.getAvailable();
	const matchPreferences = { usageOrder: settings?.getStorage()?.getModelUsageOrder() };
	let requestedModel: Model<Api> | undefined;
	let requestedResolution: ResolvedModelRoleValue | undefined;
	const skips: Array<{ selector: string; reason: string }> = [];
	let activeIndex = 0;
	const canonicalScope = canonicalSessionId ?? authSessionId;
	if (canonicalScope && parentActiveModelPattern) {
		const parentActiveModel = resolveModelOverride([parentActiveModelPattern], modelRegistry, settings).model;
		if (parentActiveModel) {
			modelRegistry.seedCanonicalVariant?.(canonicalScope, parentActiveModel);
		}
	}
	for (const pattern of modelPatterns) {
		const candidate = resolveModelRoleValue(pattern, availableModels, {
			settings,
			matchPreferences,
			modelRegistry,
			sessionId: canonicalScope,
		});
		if (!requestedModel && candidate.model) {
			requestedModel = candidate.model;
			requestedResolution = candidate;
		}
		if (!candidate.model) {
			skips.push({ selector: pattern, reason: "unknown_model" });
			activeIndex += 1;
			continue;
		}
		if (options?.managedFallback && modelPatterns.length > 1) {
			const cursorReason = managedCursorFallbackUnavailableReason(candidate.model, pattern);
			if (cursorReason) {
				skips.push({ selector: pattern, reason: cursorReason });
				activeIndex += 1;
				continue;
			}
		}
		const key = await modelRegistry.getApiKey(candidate.model, authSessionId);
		if (key === kNoAuth || isAuthenticated(key)) {
			return { ...candidate, requestedModel: candidate.model, authFallbackUsed: false, activeIndex, skips };
		}
		skips.push({ selector: pattern, reason: "unauthenticated" });
		activeIndex += 1;
	}
	const fallback = parentActiveModelPattern
		? resolveModelOverride([parentActiveModelPattern], modelRegistry, settings, authSessionId)
		: { explicitThinkingLevel: false };
	if (fallback.model) {
		const fallbackKey = await modelRegistry.getApiKey(fallback.model, authSessionId);
		if (fallbackKey === kNoAuth || isAuthenticated(fallbackKey)) {
			const isParentSubstitution = requestedModel === undefined || !modelsAreEqual(fallback.model, requestedModel);
			return {
				...fallback,
				requestedModel,
				authFallbackUsed: requestedModel !== undefined && isParentSubstitution,
				fallbackReason: requestedModel && isParentSubstitution ? "auth_unavailable" : undefined,
				parentFallbackSelector: isParentSubstitution ? formatModelString(fallback.model) : undefined,
				skips,
			};
		}
	}
	return requestedResolution
		? { ...requestedResolution, requestedModel, authFallbackUsed: false, activeIndex, skips }
		: { explicitThinkingLevel: false, requestedModel, authFallbackUsed: false, activeIndex, skips };
}

/**
 * Resolve a list of role patterns to the first matching model.
 */
export function resolveRoleSelection(
	roles: readonly string[],
	settings: Settings,
	availableModels: Model<Api>[],
	modelRegistry?: CanonicalModelRegistry,
): { model: Model<Api>; thinkingLevel?: ThinkingLevel } | undefined {
	const matchPreferences = { usageOrder: settings.getStorage()?.getModelUsageOrder() };
	for (const role of roles) {
		const resolved = resolveModelRoleValue(settings.getModelRole(role), availableModels, {
			settings,
			matchPreferences,
			modelRegistry,
		});
		if (resolved.model) {
			return { model: resolved.model, thinkingLevel: resolved.thinkingLevel };
		}
	}
	return undefined;
}

function resolveExactCanonicalScopePattern(
	pattern: string,
	modelRegistry: Pick<ModelRegistry, "getCanonicalVariants">,
	availableModels: Model<Api>[],
): { models: Model<Api>[]; thinkingLevel?: ThinkingLevel; explicitThinkingLevel: boolean } | undefined {
	const lastColonIndex = pattern.lastIndexOf(":");
	let canonicalId = pattern;
	let thinkingLevel: ThinkingLevel | undefined;
	let explicitThinkingLevel = false;

	if (lastColonIndex !== -1) {
		const suffix = pattern.substring(lastColonIndex + 1);
		const parsedThinkingLevel = parseThinkingLevel(suffix);
		if (parsedThinkingLevel) {
			canonicalId = pattern.substring(0, lastColonIndex);
			thinkingLevel = parsedThinkingLevel;
			explicitThinkingLevel = true;
		}
	}

	const variants = modelRegistry
		.getCanonicalVariants(canonicalId, { availableOnly: true, candidates: availableModels })
		.map(variant => variant.model);
	if (variants.length === 0) {
		return undefined;
	}

	return { models: variants, thinkingLevel, explicitThinkingLevel };
}

/**
 * Resolve model patterns to actual Model objects with optional thinking levels
 * Format: "pattern:level" where :level is optional
 * For each pattern, finds all matching models and picks the best version:
 * 1. Prefer alias (e.g., Anthropic model-sonnet-4-5) over dated versions (Anthropic model-sonnet-4-5-20250929)
 * 2. If no alias, pick the latest dated version
 *
 * Supports models with colons in their IDs (e.g., OpenRouter's model:exacto).
 * The algorithm tries to match the full pattern first, then progressively
 * strips colon-suffixes to find a match.
 */
export async function resolveModelScope(
	patterns: string[],
	modelRegistry: Pick<ModelRegistry, "getAvailable" | "getCanonicalVariants">,
	preferences?: ModelMatchPreferences,
): Promise<ScopedModel[]> {
	const availableModels = modelRegistry.getAvailable();
	const context = buildPreferenceContext(availableModels, preferences);
	const scopedModels: ScopedModel[] = [];

	for (const pattern of patterns) {
		// Check if pattern contains glob characters
		if (pattern.includes("*") || pattern.includes("?") || pattern.includes("[")) {
			// Extract optional thinking level suffix (e.g., "provider/*:high")
			const colonIdx = pattern.lastIndexOf(":");
			let globPattern = pattern;
			let thinkingLevel: ThinkingLevel | undefined;
			let explicitThinkingLevel = false;

			if (colonIdx !== -1) {
				const suffix = pattern.substring(colonIdx + 1);
				const parsedThinkingLevel = parseThinkingLevel(suffix);
				if (parsedThinkingLevel) {
					thinkingLevel = parsedThinkingLevel;
					explicitThinkingLevel = true;
					globPattern = pattern.substring(0, colonIdx);
				}
			}

			// Match against "provider/modelId" format OR just model ID
			// This allows "*sonnet*" to match without requiring "anthropic/*sonnet*"
			const matchingModels = availableModels.filter(m => {
				const fullId = `${m.provider}/${m.id}`;
				const glob = new Bun.Glob(globPattern.toLowerCase());
				return glob.match(fullId.toLowerCase()) || glob.match(m.id.toLowerCase());
			});

			if (matchingModels.length === 0) {
				logger.warn(`No models match pattern "${pattern}"`);
				continue;
			}

			for (const model of matchingModels) {
				if (!scopedModels.find(sm => modelsAreEqual(sm.model, model))) {
					scopedModels.push({
						model,
						thinkingLevel: explicitThinkingLevel
							? (resolveThinkingLevelForModel(model, thinkingLevel) ?? thinkingLevel)
							: thinkingLevel,
						explicitThinkingLevel,
					});
				}
			}
			continue;
		}

		const exactCanonical = resolveExactCanonicalScopePattern(pattern, modelRegistry, availableModels);
		if (exactCanonical) {
			for (const model of exactCanonical.models) {
				if (!scopedModels.find(sm => modelsAreEqual(sm.model, model))) {
					scopedModels.push({
						model,
						thinkingLevel: exactCanonical.explicitThinkingLevel
							? (resolveThinkingLevelForModel(model, exactCanonical.thinkingLevel) ??
								exactCanonical.thinkingLevel)
							: exactCanonical.thinkingLevel,
						explicitThinkingLevel: exactCanonical.explicitThinkingLevel,
					});
				}
			}
			continue;
		}

		const { model, thinkingLevel, warning, explicitThinkingLevel } = parseModelPatternWithContext(
			pattern,
			availableModels,
			context,
			{ modelRegistry },
		);

		if (warning) {
			logger.warn(warning);
		}

		if (!model) {
			logger.warn(`No models match pattern "${pattern}"`);
			continue;
		}

		// Avoid duplicates
		if (!scopedModels.find(sm => modelsAreEqual(sm.model, model))) {
			scopedModels.push({
				model,
				thinkingLevel: explicitThinkingLevel
					? (resolveThinkingLevelForModel(model, thinkingLevel) ?? thinkingLevel)
					: thinkingLevel,
				explicitThinkingLevel,
			});
		}
	}

	return scopedModels;
}

/**
 * Resolve the set of models a session is allowed to use, given the active
 * settings. Starts from `modelRegistry.getAvailable()` (so disabled providers
 * and providers without credentials are already filtered out) and, when
 * `enabledModels` is configured for the current path scope, further restricts
 * the result to models matching those patterns.
 *
 * Returns the unfiltered available list when `enabledModels` is empty.
 * Returns an empty list when `enabledModels` is configured but no available
 * model matches any pattern — callers MUST treat this as "no usable model"
 * rather than falling back to the global default (see issue #1022).
 */
export async function resolveAllowedModels(
	modelRegistry: Pick<ModelRegistry, "getAvailable" | "getCanonicalVariants">,
	settings: Settings | undefined,
	preferences?: ModelMatchPreferences,
): Promise<Model<Api>[]> {
	const available = modelRegistry.getAvailable();
	const patterns = settings?.get("enabledModels");
	if (!patterns || patterns.length === 0) {
		return available;
	}
	const scoped = await resolveModelScope(patterns, modelRegistry, preferences);
	if (scoped.length === 0) {
		return [];
	}
	const allowed = new Set(scoped.map(entry => `${entry.model.provider}/${entry.model.id}`));
	return available.filter(model => allowed.has(`${model.provider}/${model.id}`));
}

export interface ResolveCliModelResult {
	model: Model<Api> | undefined;
	selector?: string;
	thinkingLevel?: ThinkingLevel;
	warning: string | undefined;
	error: string | undefined;
}

/**
 * Resolve a single model from CLI flags.
 */
export function resolveCliModel(options: {
	cliProvider?: string;
	cliModel?: string;
	modelRegistry: CliModelRegistry;
	preferences?: ModelMatchPreferences;
}): ResolveCliModelResult {
	const { cliProvider, cliModel, modelRegistry, preferences } = options;

	if (!cliModel) {
		return { model: undefined, selector: undefined, warning: undefined, error: undefined };
	}

	const availableModels = modelRegistry.getAll();
	if (availableModels.length === 0) {
		return {
			model: undefined,
			selector: undefined,
			warning: undefined,
			error: "No models available. Check your installation or add models to models.json.",
		};
	}

	const providerMap = new Map<string, string>();
	for (const model of availableModels) {
		providerMap.set(model.provider.toLowerCase(), model.provider);
	}

	let provider = cliProvider ? providerMap.get(cliProvider.toLowerCase()) : undefined;
	if (cliProvider && !provider) {
		return {
			model: undefined,
			selector: undefined,
			warning: undefined,
			error: `Unknown provider "${cliProvider}". Use --list-models to see available providers/models.`,
		};
	}

	const trimmedModel = cliModel.trim();
	if (!provider) {
		const lower = trimmedModel.toLowerCase();
		// When input has provider/id format (e.g. "zai/glm-5"), prefer decomposed
		// provider+id match over flat id match. Without this, a model with id
		// "zai/glm-5" on provider "vercel-ai-gateway" wins over provider "zai"
		// with id "glm-5", because Array.find returns the first catalog hit.
		const slashIdx = lower.indexOf("/");
		let exact: (typeof availableModels)[number] | undefined;
		if (slashIdx !== -1) {
			const prefix = lower.substring(0, slashIdx);
			const suffix = trimmedModel.substring(slashIdx + 1);
			exact = resolveProviderModelReference(prefix, suffix, availableModels);
		}
		if (!exact && !trimmedModel.includes(":")) {
			const canonicalMatch = modelRegistry.resolveCanonicalModel?.(trimmedModel, { availableOnly: false });
			if (canonicalMatch) {
				return {
					model: canonicalMatch,
					selector: modelRegistry.getCanonicalId?.(canonicalMatch) ?? trimmedModel,
					warning: undefined,
					thinkingLevel: undefined,
					error: undefined,
				};
			}
		}
		if (!exact) {
			exact = availableModels.find(
				model => model.id.toLowerCase() === lower || `${model.provider}/${model.id}`.toLowerCase() === lower,
			);
		}
		if (exact) {
			return {
				model: exact,
				selector: formatModelString(exact),
				warning: undefined,
				thinkingLevel: undefined,
				error: undefined,
			};
		}
	}

	let pattern = trimmedModel;

	if (!provider) {
		const slashIndex = cliModel.indexOf("/");
		if (slashIndex !== -1) {
			const maybeProvider = cliModel.substring(0, slashIndex);
			const canonical = providerMap.get(maybeProvider.toLowerCase());
			if (canonical) {
				provider = canonical;
				pattern = cliModel.substring(slashIndex + 1);
			}
		}
	} else {
		const prefix = `${provider}/`;
		if (cliModel.toLowerCase().startsWith(prefix.toLowerCase())) {
			pattern = cliModel.substring(prefix.length);
		}
	}

	if (provider) {
		const exactProviderMatch = resolveProviderModelReference(provider, pattern, availableModels);
		if (exactProviderMatch) {
			return {
				model: exactProviderMatch,
				selector: formatModelString(exactProviderMatch),
				warning: undefined,
				thinkingLevel: undefined,
				error: undefined,
			};
		}
	}

	const candidates = provider ? availableModels.filter(model => model.provider === provider) : availableModels;
	const { model, thinkingLevel, warning } = parseModelPattern(pattern, candidates, preferences, {
		allowInvalidThinkingSelectorFallback: false,
		modelRegistry,
	});

	if (!model) {
		const display = provider ? `${provider}/${pattern}` : cliModel;
		return {
			model: undefined,
			selector: undefined,
			thinkingLevel: undefined,
			warning,
			error: `Model "${display}" not found. Use --list-models to see available models.`,
		};
	}

	let selector = provider ? formatModelString(model) : undefined;
	if (!provider) {
		const lastColonIndex = pattern.lastIndexOf(":");
		const canonicalCandidate =
			lastColonIndex !== -1 && parseThinkingLevel(pattern.substring(lastColonIndex + 1))
				? pattern.substring(0, lastColonIndex)
				: pattern;
		if (!canonicalCandidate.includes("/")) {
			const canonicalResolved = modelRegistry.resolveCanonicalModel?.(canonicalCandidate, { availableOnly: false });
			if (canonicalResolved && canonicalResolved.provider === model.provider && canonicalResolved.id === model.id) {
				selector = modelRegistry.getCanonicalId?.(canonicalResolved) ?? canonicalCandidate;
			}
		}
	}

	return {
		model,
		selector,
		thinkingLevel,
		warning,
		error: undefined,
	};
}

export interface InitialModelResult {
	model: Model<Api> | undefined;
	thinkingLevel?: ThinkingLevel;
	fallbackMessage: string | undefined;
}

/**
 * Find the initial model to use based on priority:
 * 1. CLI args (provider + model)
 * 2. First model from scoped models (if not continuing/resuming)
 * 3. Restored from session (if continuing/resuming)
 * 4. Saved default from settings
 * 5. First available model with valid API key
 */
export async function findInitialModel(options: {
	cliProvider?: string;
	cliModel?: string;
	scopedModels: ScopedModel[];
	isContinuing: boolean;
	defaultProvider?: string;
	defaultModelId?: string;
	defaultThinkingSelector?: ThinkingLevel;
	modelRegistry: InitialModelRegistry;
}): Promise<InitialModelResult> {
	const {
		cliProvider,
		cliModel,
		scopedModels,
		isContinuing,
		defaultProvider,
		defaultModelId,
		defaultThinkingSelector,
		modelRegistry,
	} = options;

	let model: Model<Api> | undefined;
	let thinkingLevel: ThinkingLevel | undefined;

	// 1. CLI args take priority
	if (cliProvider && cliModel) {
		const found = modelRegistry.find(cliProvider, cliModel);
		if (!found) {
			console.error(chalk.red(`Model ${cliProvider}/${cliModel} not found`));
			process.exit(1);
		}
		return { model: found, thinkingLevel: undefined, fallbackMessage: undefined };
	}

	// 2. Use first model from scoped models (skip if continuing/resuming)
	if (scopedModels.length > 0 && !isContinuing) {
		const scoped = scopedModels[0];
		const scopedThinkingSelector =
			scoped.thinkingLevel === ThinkingLevel.Inherit
				? defaultThinkingSelector
				: (scoped.thinkingLevel ?? defaultThinkingSelector);
		return {
			model: scoped.model,
			thinkingLevel: resolveThinkingLevelForModel(scoped.model, scopedThinkingSelector),
			fallbackMessage: undefined,
		};
	}

	// 3. Try saved default from settings
	if (defaultProvider && defaultModelId) {
		const found = modelRegistry.find(defaultProvider, defaultModelId);
		if (found) {
			model = found;
			thinkingLevel = resolveThinkingLevelForModel(found, defaultThinkingSelector);
			return { model, thinkingLevel, fallbackMessage: undefined };
		}
	}

	// 4. Try first available model with valid API key
	const availableModels = modelRegistry.getAvailable();

	if (availableModels.length > 0) {
		// Try to find a default model from known providers
		for (const provider of Object.keys(defaultModelPerProvider) as KnownProvider[]) {
			const defaultId = defaultModelPerProvider[provider];
			const match = availableModels.find(m => m.provider === provider && m.id === defaultId);
			if (match) {
				return { model: match, thinkingLevel: undefined, fallbackMessage: undefined };
			}
		}

		// If no default found, use first available
		return { model: availableModels[0], thinkingLevel: undefined, fallbackMessage: undefined };
	}

	// 5. No model found
	return { model: undefined, thinkingLevel: undefined, fallbackMessage: undefined };
}

/**
 * Restore model from session, with fallback to available models
 */
export async function restoreModelFromSession(
	savedProvider: string,
	savedModelId: string,
	currentModel: Model<Api> | undefined,
	shouldPrintMessages: boolean,
	modelRegistry: RestorableModelRegistry,
): Promise<{ model: Model<Api> | undefined; fallbackMessage: string | undefined }> {
	const restoredModel = modelRegistry.find(savedProvider, savedModelId);

	// Check if restored model exists and has a valid API key
	const hasApiKey = restoredModel ? !!(await modelRegistry.getApiKey(restoredModel)) : false;

	if (restoredModel && hasApiKey) {
		if (shouldPrintMessages) {
			console.log(chalk.dim(`Restored model: ${savedProvider}/${savedModelId}`));
		}
		return { model: restoredModel, fallbackMessage: undefined };
	}

	// Model not found or no API key - fall back
	const reason = !restoredModel ? "model no longer exists" : "no API key available";

	if (shouldPrintMessages) {
		console.error(chalk.yellow(`Warning: Could not restore model ${savedProvider}/${savedModelId} (${reason}).`));
	}

	// If we already have a model, use it as fallback
	if (currentModel) {
		if (shouldPrintMessages) {
			console.log(chalk.dim(`Falling back to: ${currentModel.provider}/${currentModel.id}`));
		}
		return {
			model: currentModel,
			fallbackMessage: `Could not restore model ${savedProvider}/${savedModelId} (${reason}). Using ${currentModel.provider}/${currentModel.id}.`,
		};
	}

	// Try to find any available model
	const availableModels = modelRegistry.getAvailable();

	if (availableModels.length > 0) {
		// Try to find a default model from known providers
		let fallbackModel: Model<Api> | undefined;
		for (const provider of Object.keys(defaultModelPerProvider) as KnownProvider[]) {
			const defaultId = defaultModelPerProvider[provider];
			const match = availableModels.find(m => m.provider === provider && m.id === defaultId);
			if (match) {
				fallbackModel = match;
				break;
			}
		}

		// If no default found, use first available
		if (!fallbackModel) {
			fallbackModel = availableModels[0];
		}

		if (shouldPrintMessages) {
			console.log(chalk.dim(`Falling back to: ${fallbackModel.provider}/${fallbackModel.id}`));
		}

		return {
			model: fallbackModel,
			fallbackMessage: `Could not restore model ${savedProvider}/${savedModelId} (${reason}). Using ${fallbackModel.provider}/${fallbackModel.id}.`,
		};
	}

	// No models available
	return { model: undefined, fallbackMessage: undefined };
}
