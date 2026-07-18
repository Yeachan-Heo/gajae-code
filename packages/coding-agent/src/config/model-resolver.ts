/**
 * Model resolution, scoping, and initial selection
 */

import { ThinkingLevel } from "@gajae-code/agent-core";
import { type Api, DEFAULT_MODEL_PER_PROVIDER, type KnownProvider, type Model, modelsAreEqual } from "@gajae-code/ai";

import { logger } from "@gajae-code/utils";
import chalk from "chalk";
import { parseThinkingLevel, resolveThinkingLevelForModel, splitSelectorThinkingSuffix } from "../thinking";
import { isAuthenticatedOrKeyless } from "./model-auth";
import { compareEquivalentModelVariants } from "./model-equivalence";
import { MODEL_ROLE_IDS, type ModelRegistry, type ModelRole } from "./model-registry";
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

export type { SelectorThinkingSuffix } from "../thinking";
export { splitSelectorThinkingSuffix } from "../thinking";

/**
 * Parse a model string in "provider/modelId" format.
 * Returns undefined if the format is invalid.
 */
export function parseModelString(
	modelStr: string,
): { provider: string; id: string; thinkingLevel?: ThinkingLevel } | undefined {
	const slashIdx = modelStr.indexOf("/");
	if (slashIdx <= 0) return undefined;
	const provider = modelStr.slice(0, slashIdx);
	const suffix = splitSelectorThinkingSuffix(modelStr);
	return suffix.thinkingLevel
		? { provider, id: suffix.selector.slice(slashIdx + 1), thinkingLevel: suffix.thinkingLevel }
		: { provider, id: modelStr.slice(slashIdx + 1) };
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

const providerModelIndexes = new WeakMap<
	readonly Model<Api>[],
	{ fingerprint: string; models: readonly Model<Api>[]; index: Map<string, Model<Api> | null> }
>();

function modelFingerprint(availableModels: readonly Model<Api>[]): string {
	return availableModels.map(model => `${model.provider}\u0000${model.id}`).join("\u0001");
}

function getProviderModelIndex(availableModels: readonly Model<Api>[]): Map<string, Model<Api> | null> {
	const fingerprint = modelFingerprint(availableModels);
	const cached = providerModelIndexes.get(availableModels);
	if (cached?.fingerprint === fingerprint && cached.models.every((model, index) => model === availableModels[index])) {
		return cached.index;
	}

	const index = new Map<string, Model<Api> | null>();
	for (const m of availableModels) {
		const key = `${m.provider.toLowerCase()}\u0000${m.id.toLowerCase()}`;
		if (index.has(key)) {
			index.set(key, null); // ambiguous sentinel; do not overwrite back
		} else {
			index.set(key, m);
		}
	}
	providerModelIndexes.set(availableModels, { fingerprint, models: [...availableModels], index });

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

	// Preserve exact provider/id replacement semantics before case-insensitive
	// ambiguity handling. Custom entries can intentionally replace a bundled
	// model while a differently-cased catalog alias remains present.
	const caseExact = availableModels.find(model => model.provider === trimmedProvider && model.id === trimmedModelId);
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
type InitialModelRegistry = Pick<ModelRegistry, "getAvailable">;
type RestorableModelRegistry = Pick<ModelRegistry, "getAvailable" | "getApiKey">;

interface ModelPreferenceContext {
	modelUsageRank: Map<string, number>;
	providerUsageRank: Map<string, number>;
	deprioritizedProviders: Set<string>;
	modelOrder: Map<string, number>;
}

const preferenceContexts = new WeakMap<
	readonly Model<Api>[],
	{
		fingerprint: string;
		models: readonly Model<Api>[];
		cacheKey: string;
		context: ModelPreferenceContext;
	}
>();

function modelPreferenceKey(model: Pick<Model<Api>, "provider" | "id">): string {
	return `${model.provider}/${model.id}`.toLowerCase();
}

function preferenceCacheKey(preferences: ModelMatchPreferences | undefined): string {
	return JSON.stringify([preferences?.usageOrder ?? [], preferences?.deprioritizeProviders ?? ["openrouter"]]);
}

function buildPreferenceContext(
	availableModels: Model<Api>[],
	preferences: ModelMatchPreferences | undefined,
): ModelPreferenceContext {
	const fingerprint = modelFingerprint(availableModels);
	const cacheKey = preferenceCacheKey(preferences);
	const cached = preferenceContexts.get(availableModels);
	if (
		cached?.fingerprint === fingerprint &&
		cached.cacheKey === cacheKey &&
		cached.models.every((model, index) => model === availableModels[index])
	) {
		return cached.context;
	}

	const modelUsageRank = new Map<string, number>();
	const providerUsageRank = new Map<string, number>();
	const usageOrder = preferences?.usageOrder ?? [];
	for (let i = 0; i < usageOrder.length; i += 1) {
		const key = usageOrder[i];
		if (!modelUsageRank.has(key.toLowerCase())) modelUsageRank.set(key.toLowerCase(), i);
		const parsed = parseModelString(key);
		if (parsed && !providerUsageRank.has(parsed.provider.toLowerCase())) {
			providerUsageRank.set(parsed.provider.toLowerCase(), i);
		}
	}

	const deprioritizedProviders = new Set(
		(preferences?.deprioritizeProviders ?? ["openrouter"]).map(provider => provider.toLowerCase()),
	);

	const modelOrder = new Map<string, number>();
	for (let i = 0; i < availableModels.length; i += 1) {
		modelOrder.set(formatModelString(availableModels[i]), i);
	}
	const context = { modelUsageRank, providerUsageRank, deprioritizedProviders, modelOrder };
	preferenceContexts.set(availableModels, {
		fingerprint,
		models: [...availableModels],
		cacheKey,
		context,
	});

	return context;
}

function pickPreferredModel(candidates: Model<Api>[], context: ModelPreferenceContext): Model<Api> {
	if (candidates.length <= 1) return candidates[0];
	return [...candidates].sort((a, b) => {
		const aUsage = context.modelUsageRank.get(modelPreferenceKey(a));
		const bUsage = context.modelUsageRank.get(modelPreferenceKey(b));

		if (aUsage !== undefined || bUsage !== undefined) {
			return (aUsage ?? Number.POSITIVE_INFINITY) - (bUsage ?? Number.POSITIVE_INFINITY);
		}

		const aProviderUsage = context.providerUsageRank.get(a.provider.toLowerCase());
		const bProviderUsage = context.providerUsageRank.get(b.provider.toLowerCase());

		if (aProviderUsage !== undefined || bProviderUsage !== undefined) {
			return (aProviderUsage ?? Number.POSITIVE_INFINITY) - (bProviderUsage ?? Number.POSITIVE_INFINITY);
		}

		const variantRank = compareEquivalentModelVariants(a, b, { finalize: false });
		if (variantRank !== 0) {
			return variantRank;
		}

		const aDeprioritized = context.deprioritizedProviders.has(a.provider.toLowerCase());
		const bDeprioritized = context.deprioritizedProviders.has(b.provider.toLowerCase());
		if (aDeprioritized !== bDeprioritized) {
			return aDeprioritized ? 1 : -1;
		}

		return compareEquivalentModelVariants(a, b, { modelOrder: context.modelOrder });
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
 * Resolve an unqualified exact alias through its canonical record so it uses
 * the registry's equivalent-variant ranking rather than generic fuzzy policy.
 */
function findExactEquivalentModelMatch(
	modelReference: string,
	availableModels: Model<Api>[],
	modelRegistry: CanonicalModelRegistry | undefined,
	sessionId?: string,
): Model<Api> | undefined {
	if (!modelRegistry?.getCanonicalId || !modelRegistry.resolveCanonicalModel) return undefined;
	const trimmedReference = modelReference.trim();
	if (!trimmedReference || trimmedReference.includes("/")) return undefined;
	const exactMatches = availableModels.filter(model => model.id.toLowerCase() === trimmedReference.toLowerCase());
	if (exactMatches.length === 0) return undefined;
	const canonicalIds = new Set(
		exactMatches
			.map(model => modelRegistry.getCanonicalId!(model))
			.filter((canonicalId): canonicalId is string => Boolean(canonicalId)),
	);
	if (canonicalIds.size !== 1) return undefined;
	return modelRegistry.resolveCanonicalModel([...canonicalIds][0]!, {
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

	const exactEquivalentMatch = findExactEquivalentModelMatch(
		modelPattern,
		availableModels,
		options?.modelRegistry,
		options?.sessionId,
	);
	if (exactEquivalentMatch) {
		return exactEquivalentMatch;
	}

	// Exact ID match (case-insensitive) — this must happen before provider-scoped
	// fuzzy matching so raw IDs that contain slashes (for example OpenRouter model
	// IDs like "openai/gpt-4o:extended") still resolve as IDs instead of being
	// misread as a provider-qualified selector.
	const exactMatches = availableModels.filter(m => m.id.toLowerCase() === modelPattern.toLowerCase());
	if (exactMatches.length > 0) {
		return pickPreferredModel(exactMatches, context);
	}
	// Provider-qualified selectors are exact-only. Case-only duplicate catalog
	// entries still rank deterministically within the explicitly named provider.
	const slashIndex = modelPattern.indexOf("/");
	if (slashIndex !== -1) {
		const provider = modelPattern.slice(0, slashIndex).trim().toLowerCase();
		const modelId = modelPattern
			.slice(slashIndex + 1)
			.trim()
			.toLowerCase();
		const providerExactMatches = availableModels.filter(
			model => model.provider.toLowerCase() === provider && model.id.toLowerCase() === modelId,
		);
		return providerExactMatches.length > 0 ? pickPreferredModel(providerExactMatches, context) : undefined;
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

export interface ResolveSelectorOptions {
	allowInvalidThinkingSelectorFallback?: boolean;
	modelRegistry?: CanonicalModelRegistry;
	preferences?: ModelMatchPreferences;
	sessionId?: string;
}

/**
 * Resolve one selector through ordered exact, canonical, bare-id, provider-fuzzy,
 * substring/alias, and glob stages. Thinking is split only after a full selector
 * cannot resolve, which preserves OpenRouter route suffixes in concrete IDs.
 */
export function resolveSelector(
	selector: string,
	candidates: Model<Api>[],
	options?: ResolveSelectorOptions,
): ParsedModelResult {
	const context = buildPreferenceContext(candidates, options?.preferences);
	const exact = tryMatchModel(selector, candidates, context, options);
	if (exact) return { model: exact, thinkingLevel: undefined, warning: undefined, explicitThinkingLevel: false };
	const glob = findGlobMatch(selector, candidates, context);
	if (glob) return { model: glob, thinkingLevel: undefined, warning: undefined, explicitThinkingLevel: false };

	const suffix = splitSelectorThinkingSuffix(selector);
	if (
		suffix.selector === selector ||
		(suffix.invalidSuffix !== undefined && !(options?.allowInvalidThinkingSelectorFallback ?? true))
	) {
		return { model: undefined, thinkingLevel: undefined, warning: undefined, explicitThinkingLevel: false };
	}

	const model =
		tryMatchModel(suffix.selector, candidates, context, options) ??
		findGlobMatch(suffix.selector, candidates, context);
	if (!model) return { model: undefined, thinkingLevel: undefined, warning: undefined, explicitThinkingLevel: false };
	if (suffix.thinkingLevel) {
		return { model, thinkingLevel: suffix.thinkingLevel, warning: undefined, explicitThinkingLevel: true };
	}
	return {
		model,
		thinkingLevel: undefined,
		warning: `Invalid thinking level "${suffix.invalidSuffix}" in pattern "${selector}". Using default instead.`,
		explicitThinkingLevel: false,
	};
}

function findGlobMatch(
	selector: string,
	candidates: Model<Api>[],
	context: ModelPreferenceContext,
): Model<Api> | undefined {
	if (!selector.includes("*") && !selector.includes("?") && !selector.includes("[")) return undefined;
	const glob = new Bun.Glob(selector.toLowerCase());
	return pickPreferredModel(
		candidates.filter(
			model => glob.match(formatModelString(model).toLowerCase()) || glob.match(model.id.toLowerCase()),
		),
		context,
	);
}

/** @internal Exported for testing and legacy adapters. */

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
	return resolveSelector(pattern, availableModels, { ...options, preferences });
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

	const suffix = splitSelectorThinkingSuffix(normalized);
	const thinkingLevel = suffix.thinkingLevel;
	const aliasCandidate = thinkingLevel ? suffix.selector : normalized;
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
		const thinkingSelector = splitSelectorThinkingSuffix(current).thinkingLevel;

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
	return resolveSelector(value, available, { preferences: matchPreferences, modelRegistry }).model;
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
		if (isAuthenticatedOrKeyless(key)) {
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
		if (isAuthenticatedOrKeyless(key)) {
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
		if (isAuthenticatedOrKeyless(fallbackKey)) {
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
	// Exact concrete selectors must win before a suffix is interpreted as thinking.
	// This preserves canonical/OpenRouter model IDs that themselves contain colons.
	if (
		findExactModelReferenceMatch(pattern, availableModels) ||
		(pattern.includes(":") && availableModels.some(model => model.id.toLowerCase() === pattern.trim().toLowerCase()))
	) {
		return undefined;
	}

	const suffix = splitSelectorThinkingSuffix(pattern);
	const canonicalId = suffix.thinkingLevel ? suffix.selector : pattern;
	const thinkingLevel = suffix.thinkingLevel;
	const explicitThinkingLevel = thinkingLevel !== undefined;

	const variants = modelRegistry
		.getCanonicalVariants(canonicalId, { availableOnly: true, candidates: availableModels })
		.map(variant => variant.model);
	if (variants.length === 0) {
		return undefined;
	}

	return { models: variants, thinkingLevel, explicitThinkingLevel };
}

/**
 * Resolve model patterns to actual Model objects with optional thinking levels.
 * A `:level` suffix is interpreted only after the complete selector fails to
 * resolve, preserving concrete model IDs that contain colon-bearing route suffixes.
 * For each non-glob pattern, alias IDs are preferred over dated versions; otherwise
 * the latest dated version is selected.
 */

export async function resolveModelScope(
	patterns: string[],
	modelRegistry: Pick<ModelRegistry, "getAvailable" | "getCanonicalVariants">,
	preferences?: ModelMatchPreferences,
): Promise<ScopedModel[]> {
	const availableModels = modelRegistry.getAvailable();

	const scopedModels: ScopedModel[] = [];
	const addScopedModel = (selection: ScopedModel): void => {
		const duplicate = scopedModels.some(
			existing =>
				modelsAreEqual(existing.model, selection.model) &&
				existing.thinkingLevel === selection.thinkingLevel &&
				existing.explicitThinkingLevel === selection.explicitThinkingLevel,
		);
		if (!duplicate) scopedModels.push(selection);
	};

	for (const pattern of patterns) {
		// Check if pattern contains glob characters
		if (pattern.includes("*") || pattern.includes("?") || pattern.includes("[")) {
			// Extract the optional thinking suffix once, preserving route suffixes.
			const suffix = splitSelectorThinkingSuffix(pattern);
			const globPattern = suffix.thinkingLevel ? suffix.selector : pattern;
			const thinkingLevel = suffix.thinkingLevel;
			const explicitThinkingLevel = thinkingLevel !== undefined;

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
				addScopedModel({
					model,
					thinkingLevel: explicitThinkingLevel
						? (resolveThinkingLevelForModel(model, thinkingLevel) ?? thinkingLevel)
						: thinkingLevel,
					explicitThinkingLevel,
				});
			}

			continue;
		}

		const exactCanonical = resolveExactCanonicalScopePattern(pattern, modelRegistry, availableModels);
		if (exactCanonical) {
			for (const model of exactCanonical.models) {
				addScopedModel({
					model,
					thinkingLevel: exactCanonical.explicitThinkingLevel
						? (resolveThinkingLevelForModel(model, exactCanonical.thinkingLevel) ?? exactCanonical.thinkingLevel)
						: exactCanonical.thinkingLevel,
					explicitThinkingLevel: exactCanonical.explicitThinkingLevel,
				});
			}

			continue;
		}

		const { model, thinkingLevel, warning, explicitThinkingLevel } = resolveSelector(pattern, availableModels, {
			modelRegistry,
			preferences,
		});

		if (warning) {
			logger.warn(warning);
		}

		if (!model) {
			logger.warn(`No models match pattern "${pattern}"`);
			continue;
		}

		addScopedModel({
			model,
			thinkingLevel: explicitThinkingLevel
				? (resolveThinkingLevelForModel(model, thinkingLevel) ?? thinkingLevel)
				: thinkingLevel,
			explicitThinkingLevel,
		});
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

/** Resolve a single model from CLI flags through the staged selector resolver. */
export function resolveCliModel(options: {
	cliProvider?: string;
	cliModel?: string;
	modelRegistry: CliModelRegistry;
	preferences?: ModelMatchPreferences;
}): ResolveCliModelResult {
	const { cliProvider, cliModel, modelRegistry, preferences } = options;
	if (!cliModel) return { model: undefined, selector: undefined, warning: undefined, error: undefined };

	const availableModels = modelRegistry.getAll();
	if (availableModels.length === 0) {
		return {
			model: undefined,
			selector: undefined,
			warning: undefined,
			error: "No models available. Check your installation or add models to models.json.",
		};
	}

	const provider = cliProvider
		? availableModels.find(model => model.provider.toLowerCase() === cliProvider.toLowerCase())?.provider
		: undefined;
	if (cliProvider && !provider) {
		return {
			model: undefined,
			selector: undefined,
			warning: undefined,
			error: `Unknown provider "${cliProvider}". Use --list-models to see available providers/models.`,
		};
	}

	const modelInput = cliModel.trim();
	const providerPrefix = provider ? `${provider}/` : "";
	const pattern =
		provider && modelInput.toLowerCase().startsWith(providerPrefix.toLowerCase())
			? modelInput.slice(providerPrefix.length)
			: modelInput;
	const candidates = provider
		? availableModels.filter(model => model.provider.toLowerCase() === provider.toLowerCase())
		: availableModels;
	const selectorInput = provider ? `${provider}/${pattern}` : pattern;
	const exactProviderResolved = provider
		? resolveSelector(selectorInput, candidates, {
				allowInvalidThinkingSelectorFallback: false,
				preferences,
			})
		: undefined;
	const resolved = exactProviderResolved?.model
		? exactProviderResolved
		: resolveSelector(provider ? pattern : selectorInput, candidates, {
				allowInvalidThinkingSelectorFallback: false,
				modelRegistry: provider ? undefined : modelRegistry,
				preferences,
			});

	if (!resolved.model) {
		return {
			model: undefined,
			selector: undefined,
			thinkingLevel: undefined,
			warning: resolved.warning,
			error: `Model "${selectorInput}" not found. Use --list-models to see available models.`,
		};
	}

	const suffix = splitSelectorThinkingSuffix(selectorInput);
	const canonicalSelector = suffix.selector.includes("/") ? undefined : suffix.selector;
	const canonicalModel = canonicalSelector
		? modelRegistry.resolveCanonicalModel?.(canonicalSelector, { availableOnly: false, candidates: availableModels })
		: undefined;
	return {
		model: resolved.model,
		selector:
			canonicalModel &&
			canonicalModel.provider === resolved.model.provider &&
			canonicalModel.id === resolved.model.id
				? (modelRegistry.getCanonicalId?.(canonicalModel) ?? canonicalSelector)
				: formatModelString(resolved.model),
		thinkingLevel: resolved.thinkingLevel,
		warning: resolved.warning,
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
		const found = resolveProviderModelReference(cliProvider, cliModel, modelRegistry.getAvailable());

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
		const found = resolveProviderModelReference(defaultProvider, defaultModelId, modelRegistry.getAvailable());

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
	const restoredModel = resolveProviderModelReference(savedProvider, savedModelId, modelRegistry.getAvailable());

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
