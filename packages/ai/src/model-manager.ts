import { sanitizeText } from "@gajae-code/utils";
import { applyFinalCodexGpt56ContextCap } from "./context-cap-policy";
import {
	insertModelCacheIfAbsent,
	readModelCache,
	updateModelCacheIfUnchanged,
	writeModelCacheIfNotNewer,
} from "./model-cache";
import { isRetiredModel, isRetiredModelKey } from "./model-retirements";
import { applyGeneratedModelPolicies, enrichModelThinking } from "./model-thinking";
import { type GeneratedProvider, getBundledModels } from "./models";
import type { Api, Model, Provider } from "./types";
import { isSafeCatalogModelId } from "./utils/discovery/openai-compatible";

const DEFAULT_CACHE_TTL_MS = 2 * 60 * 60 * 1000;
const NON_AUTHORITATIVE_RETRY_MS = 5 * 60 * 1000;

// Coalescing guards the implicit cold-start strategy only: an explicit
// "online" refresh owns its fetch so a newer probe can always supersede an
// older in-flight refresh (the registry pins that ordering), and callers never
// block behind a refresh whose completion they may be expected to unblock.
// A legacy or missing row has no dynamic-ID marker, so concurrent cold-start
// resolutions would otherwise all fetch before the first one can publish it.
const legacyDynamicRefreshes = new Map<string, Promise<void>>();

function legacyDynamicRefreshKey(providerId: Provider, cacheDbPath: string | undefined, provenance: string): string {
	return `${cacheDbPath ?? "<default>"}\0${providerId}\0${provenance}`;
}

/**
 * Controls when dynamic endpoint models should be fetched.
 */
export type ModelRefreshStrategy = "online" | "offline" | "online-if-uncached";

/**
 * Hook for loading and mapping models.dev fallback data into canonical model objects.
 */
export interface ModelsDevFallback<TApi extends Api = Api, TPayload = unknown> {
	/** Fetches raw fallback payload (for example from models.dev). */
	fetch(): Promise<TPayload>;
	/** Maps payload into provider models. */
	map(payload: TPayload, providerId: Provider): readonly Model<TApi>[];
}

/**
 * Configuration for provider model resolution.
 */
export interface ModelManagerOptions<TApi extends Api = Api, TModelsDevPayload = unknown> {
	/** Provider id used for static lookup and cache namespacing. */
	providerId: Provider;
	/** Optional static list override. When omitted, bundled models.json is used. */
	staticModels?: readonly Model<TApi>[];
	/** Optional override for the cache database path. Default: <agent-dir>/models.db. */
	cacheDbPath?: string;
	/** Maximum cache age in milliseconds before considered stale. Default: 24h. */
	cacheTtlMs?: number;
	/** Optional dynamic endpoint fetcher. */
	fetchDynamicModels?: () => Promise<readonly Model<TApi>[] | null>;
	/** Optional models.dev fallback hook. */
	modelsDev?: ModelsDevFallback<TApi, TModelsDevPayload>;
	/** Clock override for deterministic tests. */
	now?: () => number;
	/** Optional guard that must permit cache publication. Default: writes are permitted. */
	canPublishCache?: () => boolean;
	/** Credential-and-endpoint identity required to reuse dynamic catalog IDs. */
	cacheDynamicModelProvenance?: string;
}

/**
 * Resolution result.
 *
 * `stale` is false when the resolved catalog is authoritative for the selected provider:
 * - dynamic endpoint data was fetched in this call,
 * - a still-fresh authoritative cache was reused in `online-if-uncached` mode, or
 * - the provider has no dynamic fetcher configured.
 */
export interface ModelResolutionResult<TApi extends Api = Api> {
	models: Model<TApi>[];
	stale: boolean;
	/** Whether the cache row consulted for this resolution was still within its TTL. */
	cacheFresh: boolean;
	/** Whether the consulted cache row was authoritative. */
	cacheAuthoritative: boolean;
	/** Whether this resolution successfully fetched dynamic models. */
	fetched: boolean;
	/**
	 * IDs returned by a current authoritative dynamic provider catalog. This is
	 * deliberately distinct from `models`, which merges static and cached data.
	 */
	dynamicModelIds?: readonly string[];
}

/**
 * Stateful facade over provider model resolution.
 */
export interface ModelManager<TApi extends Api = Api> {
	refresh(strategy?: ModelRefreshStrategy): Promise<ModelResolutionResult<TApi>>;
}

/**
 * Creates a reusable provider model manager.
 */
export function createModelManager<TApi extends Api = Api, TModelsDevPayload = unknown>(
	options: ModelManagerOptions<TApi, TModelsDevPayload>,
): ModelManager<TApi> {
	return {
		refresh(strategy: ModelRefreshStrategy = "online-if-uncached") {
			return resolveProviderModels(options, strategy);
		},
	};
}

/**
 * Cheap fast path for trusted model sources (bundled literals, our own cache rows).
 * Skips per-field validation; only guards against catastrophically corrupt rows.
 */
function passModelList<TApi extends Api>(value: unknown): Model<TApi>[] {
	if (!Array.isArray(value)) {
		return [];
	}
	const out: Model<TApi>[] = [];
	for (const item of value) {
		if (item === null || typeof item !== "object") {
			continue;
		}
		const candidate = item as { id?: unknown; provider?: unknown };
		if (!isSafeCatalogModelId(candidate.id)) {
			continue;
		}
		if (typeof candidate.provider === "string" && isRetiredModelKey(candidate.provider, candidate.id)) {
			continue;
		}
		const model = enrichModelThinking(item as Model<TApi>);
		out.push({ ...model, name: sanitizeModelDisplayName(model.name, model.id) });
	}
	applyGeneratedModelPolicies(out as Model<Api>[]);
	return applyFinalCodexGpt56ContextCap(out);
}

/**
 * Resolves provider models with source precedence:
 * static -> models.dev -> cache -> dynamic.
 *
 * Later sources override earlier ones by model id.
 */
export async function resolveProviderModels<TApi extends Api = Api, TModelsDevPayload = unknown>(
	options: ModelManagerOptions<TApi, TModelsDevPayload>,
	strategy: ModelRefreshStrategy = "online-if-uncached",
): Promise<ModelResolutionResult<TApi>> {
	const provenance = options.cacheDynamicModelProvenance;
	const now = options.now ?? Date.now;
	const ttlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
	const legacyCache = readModelCache<TApi>(options.providerId, ttlMs, now, options.cacheDbPath);
	if (
		strategy !== "online-if-uncached" ||
		typeof options.fetchDynamicModels !== "function" ||
		provenance === undefined ||
		(legacyCache !== null && legacyCache.dynamicModelIds !== undefined)
	) {
		return resolveProviderModelsUncoalesced(options, strategy);
	}

	const refreshKey = legacyDynamicRefreshKey(options.providerId, options.cacheDbPath, provenance);
	const inFlightRefresh = legacyDynamicRefreshes.get(refreshKey);
	if (inFlightRefresh) {
		await inFlightRefresh;
		return resolveProviderModelsUncoalesced(options, strategy);
	}

	const refreshCompletion = Promise.withResolvers<void>();
	legacyDynamicRefreshes.set(refreshKey, refreshCompletion.promise);
	try {
		return await resolveProviderModelsUncoalesced(options, strategy);
	} finally {
		if (legacyDynamicRefreshes.get(refreshKey) === refreshCompletion.promise) {
			legacyDynamicRefreshes.delete(refreshKey);
		}
		refreshCompletion.resolve();
	}
}

async function resolveProviderModelsUncoalesced<TApi extends Api = Api, TModelsDevPayload = unknown>(
	options: ModelManagerOptions<TApi, TModelsDevPayload>,
	strategy: ModelRefreshStrategy = "online-if-uncached",
): Promise<ModelResolutionResult<TApi>> {
	const now = options.now ?? Date.now;
	const ttlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
	const dbPath = options.cacheDbPath;
	const staticModels = passModelList<TApi>(
		options.staticModels ?? getBundledModels(options.providerId as GeneratedProvider),
	);
	const cache = readModelCache<TApi>(options.providerId, ttlMs, now, dbPath);
	const dynamicFetcher = options.fetchDynamicModels;
	const hasDynamicFetcher = typeof dynamicFetcher === "function";
	const cacheDynamicModelIdsCurrent =
		cache?.dynamicModelIds !== undefined &&
		cache.dynamicModelProvenance !== undefined &&
		cache.dynamicModelProvenance === options.cacheDynamicModelProvenance;
	const requiresBoundDynamicCache = hasDynamicFetcher && options.cacheDynamicModelProvenance !== undefined;
	const cacheProvenanceMismatch =
		cache !== null &&
		(cache.dynamicModelIds !== undefined ? !cacheDynamicModelIdsCurrent : requiresBoundDynamicCache);
	// A provider that supplies cache provenance has opted into live-catalog
	// authority. Rows written before that provider enabled discovery have no
	// dynamic IDs, so they must be synchronized once rather than suppressing
	// the first live fetch for their full TTL.
	const cacheNeedsInitialDynamicRefresh =
		hasDynamicFetcher &&
		options.cacheDynamicModelProvenance !== undefined &&
		!options.cacheDynamicModelProvenance.startsWith("gajae:non-cacheable-") &&
		cache?.dynamicModelIds === undefined;
	const hasAuthoritativeCache =
		!hasDynamicFetcher ||
		((cache?.authoritative ?? false) &&
			(!cacheNeedsInitialDynamicRefresh && requiresBoundDynamicCache
				? cacheDynamicModelIdsCurrent
				: cache?.dynamicModelIds === undefined || cacheDynamicModelIdsCurrent));
	const cacheAgeMs = cache ? now() - cache.updatedAt : Number.POSITIVE_INFINITY;
	const shouldFetchFromNetwork =
		// A bound row whose dynamic IDs are defined but stale belongs to a
		// different discovery context: force the validation fetch immediately,
		// on every non-offline visit, until a row for this context lands.
		// A row with no dynamic IDs (a failed-fetch tombstone, or a legacy
		// provenance-less row) cannot prove foreignness, never serves its
		// models in a bound context, and is non-authoritative — so its refetch
		// cadence follows the standard non-authoritative retry backoff instead
		// of hammering a failing endpoint on every provider-tab visit.
		(cacheNeedsInitialDynamicRefresh || (cacheProvenanceMismatch && cache?.dynamicModelIds !== undefined)) &&
		strategy !== "offline"
			? true
			: shouldFetchRemoteSources(strategy, cache?.fresh ?? false, hasAuthoritativeCache, cacheAgeMs);
	const staticFingerprint = fingerprintStatic(staticModels);

	// Cold-start fast path: when a fresh, authoritative cache exists, the network
	// fetch is skipped, AND the static catalog slice is byte-identical to what
	// was merged in last time, the cache row IS the authoritative merge result.
	// Re-running `mergeDynamicModels(static, cache)` would just rebuild the same
	// objects (~800ms in the steady-state cold-start profile for `gjc -p hi`).
	if (
		!shouldFetchFromNetwork &&
		cache?.fresh &&
		hasAuthoritativeCache &&
		cache.staticFingerprint === staticFingerprint &&
		cache.staticFingerprint.length > 0
	) {
		const cachedModels = passModelList<TApi>(cache.models);
		if (!hasStaticTransportDrift(staticModels, cachedModels)) {
			return {
				models: cachedModels,
				stale: false,
				cacheFresh: true,
				cacheAuthoritative: true,
				fetched: false,
				dynamicModelIds:
					strategy === "online-if-uncached" && cacheDynamicModelIdsCurrent ? cache.dynamicModelIds : undefined,
			};
		}
		const repairedModels = mergeDynamicModels(staticModels, cachedModels);
		if (options.canPublishCache?.() ?? true) {
			writeModelCacheIfNotNewer(
				options.providerId,
				cache.updatedAt,
				now(),
				repairedModels,
				true,
				staticFingerprint,
				dbPath,
				cache.dynamicModelIds,
				cache.dynamicModelProvenance,
			);
		}
		return {
			models: repairedModels,
			stale: false,
			cacheFresh: true,
			cacheAuthoritative: true,
			fetched: false,
			dynamicModelIds:
				strategy === "online-if-uncached" && cacheDynamicModelIdsCurrent ? cache.dynamicModelIds : undefined,
		};
	}

	const discoveryStartedAt = shouldFetchFromNetwork ? now() : undefined;
	const [fetchedModelsDevModels, fetchedDynamicModels] = shouldFetchFromNetwork
		? await Promise.all([fetchModelsDev(options), dynamicFetcher ? fetchDynamicModels(dynamicFetcher) : null])
		: [null, null];
	const modelsDevModels = normalizeModelList<TApi>(fetchedModelsDevModels ?? []);
	const shouldUseFreshCacheAsAuthoritative =
		strategy === "online-if-uncached" && (cache?.fresh ?? false) && hasAuthoritativeCache;
	const dynamicFetchSucceeded = fetchedDynamicModels !== null;
	// Stale-while-error fallback: cached dynamic rows may only serve when their
	// provenance still matches the current request context. A fetch forced by a
	// provenance mismatch means the cache belongs to a different discovery
	// context (e.g. another tenant's header), so a failed refetch must fail
	// closed on those rows instead of surfacing them as selectable models. The
	// explicit "offline" strategy keeps serving last-known rows regardless:
	// local-only mode has no network attempt whose failure would warrant
	// withholding them.
	const cacheModelsServeCurrentContext = !cacheProvenanceMismatch || strategy === "offline";
	let cacheModels =
		dynamicFetchSucceeded || !cacheModelsServeCurrentContext ? [] : normalizeModelList<TApi>(cache?.models ?? []);
	const dynamicModels = fetchedDynamicModels ?? [];
	const mergedWithCache = mergeDynamicModels(mergeModelSources(staticModels, modelsDevModels), cacheModels);
	const models = applyFinalCodexGpt56ContextCap(mergeDynamicModels(mergedWithCache, dynamicModels));
	const dynamicAuthoritative =
		!hasDynamicFetcher ||
		dynamicFetchSucceeded ||
		(shouldUseFreshCacheAsAuthoritative && cacheModelsServeCurrentContext);
	if (shouldFetchFromNetwork) {
		if (dynamicFetchSucceeded) {
			const snapshotModels = applyFinalCodexGpt56ContextCap(
				mergeDynamicModels(mergeModelSources(staticModels, modelsDevModels), dynamicModels),
			);
			if ((options.canPublishCache?.() ?? true) && discoveryStartedAt !== undefined) {
				writeModelCacheIfNotNewer(
					options.providerId,
					discoveryStartedAt,
					now(),
					snapshotModels,
					true,
					staticFingerprint,
					dbPath,
					dynamicModels.map(model => model.id),
					options.cacheDynamicModelProvenance,
				);
			}
		} else {
			// Dynamic fetch failed — update cache with a non-authoritative snapshot so
			// stale state remains visible while retry backoff still applies. Re-read
			// the current row and trust only that row's provenance and dynamic IDs,
			// not the initial cacheProvenanceMismatch snapshot. A concurrent writer
			// may have replaced the provider row; if the latest row is unbound or
			// belongs to another context, use no latest fallback and do not
			// overwrite or downgrade it.
			const latestCache = readModelCache<TApi>(options.providerId, ttlMs, now, dbPath);
			const latestCacheMatchesCurrentContext =
				options.cacheDynamicModelProvenance === undefined
					? latestCache !== null && latestCache.dynamicModelIds === undefined
					: cacheRowMatchesBoundDynamicProvenance(latestCache, options.cacheDynamicModelProvenance);
			const latestCacheIsLegacy =
				cache?.dynamicModelIds === undefined && latestCache !== null && latestCache.dynamicModelIds === undefined;
			// An unbound context (the provider supplies no dynamic provenance) has no
			// foreign-context risk, so a legacy row keeps serving its models through a
			// failed refetch instead of blanking the catalog and overwriting the row
			// with an empty snapshot.
			const latestCacheServesLegacyRow = latestCacheIsLegacy && options.cacheDynamicModelProvenance === undefined;
			const fallbackCacheModels =
				(latestCacheMatchesCurrentContext || latestCacheServesLegacyRow) && latestCache !== null
					? normalizeModelList<TApi>(latestCache.models)
					: [];
			cacheModels = fallbackCacheModels;
			if (options.canPublishCache?.() ?? true) {
				const snapshotModels = applyFinalCodexGpt56ContextCap(
					mergeDynamicModels(mergeModelSources(staticModels, modelsDevModels), fallbackCacheModels),
				);
				if (latestCache !== null && (latestCacheMatchesCurrentContext || latestCacheIsLegacy)) {
					const updated = updateModelCacheIfUnchanged(
						options.providerId,
						latestCache.updatedAt,
						latestCache.dynamicModelIds,
						latestCache.dynamicModelProvenance,
						latestCache.models,
						now(),
						snapshotModels,
						false,
						staticFingerprint,
						dbPath,
						options.cacheDynamicModelProvenance === undefined ? undefined : [],
						options.cacheDynamicModelProvenance,
					);
					if (!updated) cacheModels = [];
				} else if (latestCache == null) {
					const inserted = insertModelCacheIfAbsent(
						options.providerId,
						now(),
						snapshotModels,
						false,
						staticFingerprint,
						dbPath,
						options.cacheDynamicModelProvenance === undefined ? undefined : [],
						options.cacheDynamicModelProvenance,
					);
					if (!inserted) cacheModels = [];
				}
			}
		}
	}
	const returnedModels =
		shouldFetchFromNetwork && !dynamicFetchSucceeded
			? applyFinalCodexGpt56ContextCap(
					mergeDynamicModels(mergeModelSources(staticModels, modelsDevModels), cacheModels),
				)
			: models;
	return {
		models: returnedModels,
		stale: !dynamicAuthoritative,
		cacheFresh: cache?.fresh ?? false,
		cacheAuthoritative: cache?.authoritative ?? false,
		fetched: shouldFetchFromNetwork && dynamicFetchSucceeded,
		dynamicModelIds: dynamicFetchSucceeded
			? dynamicModels.map(model => model.id)
			: shouldUseFreshCacheAsAuthoritative
				? cacheDynamicModelIdsCurrent
					? cache?.dynamicModelIds
					: undefined
				: undefined,
	};
}

async function fetchModelsDev<TApi extends Api, TModelsDevPayload>(
	options: ModelManagerOptions<TApi, TModelsDevPayload>,
): Promise<Model<TApi>[] | null> {
	if (!options.modelsDev) {
		return null;
	}

	try {
		const payload = await options.modelsDev.fetch();
		return normalizeModelList<TApi>(options.modelsDev.map(payload, options.providerId));
	} catch {
		return null;
	}
}

async function fetchDynamicModels<TApi extends Api>(
	fetcher: () => Promise<readonly Model<TApi>[] | null>,
): Promise<Model<TApi>[] | null> {
	try {
		const models = await fetcher();
		if (models === null) {
			return null;
		}
		return normalizeModelList<TApi>(models);
	} catch {
		return null;
	}
}

function cacheRowMatchesBoundDynamicProvenance<
	TCache extends {
		models: readonly { id: string }[];
		dynamicModelIds?: readonly string[];
		dynamicModelProvenance?: string;
	},
>(
	cache: TCache | null | undefined,
	expectedProvenance: string | undefined,
): cache is TCache & { dynamicModelIds: readonly string[]; dynamicModelProvenance: string } {
	if (
		cache == null ||
		cache.dynamicModelIds === undefined ||
		cache.dynamicModelProvenance === undefined ||
		expectedProvenance === undefined ||
		cache.dynamicModelProvenance !== expectedProvenance
	) {
		return false;
	}
	const modelIds = new Set(cache.models.map(model => model.id));
	return cache.dynamicModelIds.every(id => modelIds.has(id));
}

function shouldFetchRemoteSources(
	strategy: ModelRefreshStrategy,
	hasFreshCache: boolean,
	hasAuthoritativeCache: boolean,
	cacheAgeMs: number,
): boolean {
	if (strategy === "offline") {
		return false;
	}
	if (strategy === "online") {
		return true;
	}
	// online-if-uncached: skip fetch if cache is fresh.
	// For non-authoritative caches (dynamic fetch previously failed),
	// use a shorter retry interval instead of retrying every startup.
	if (!hasFreshCache) {
		return true;
	}
	if (!hasAuthoritativeCache) {
		return cacheAgeMs >= NON_AUTHORITATIVE_RETRY_MS;
	}
	return false;
}

function hasStaticTransportDrift<TApi extends Api>(
	staticModels: readonly Model<TApi>[],
	cachedModels: readonly Model<TApi>[],
): boolean {
	if (staticModels.length === 0 || cachedModels.length === 0) return false;
	const cachedById = new Map(cachedModels.map(model => [model.id, model]));
	for (const staticModel of staticModels) {
		const cachedModel = cachedById.get(staticModel.id);
		if (!cachedModel) continue;
		if (cachedModel.api !== staticModel.api) return true;
	}
	return false;
}

function mergeModelSources<TApi extends Api>(...sources: readonly (readonly Model<TApi>[])[]): Model<TApi>[] {
	// Strip out empty/missing sources up front. The hot path is `(static, [])`
	// (modelsDev disabled / failed) — a single non-empty source means we can
	// skip the Map churn entirely and just hand back the array.
	const nonEmpty = sources.filter(source => source.length > 0);
	if (nonEmpty.length === 0) return [];
	if (nonEmpty.length === 1) return [...nonEmpty[0]];
	const merged = new Map<string, Model<TApi>>();
	for (const source of nonEmpty) {
		for (const model of source) {
			if (!model?.id) continue;
			merged.set(model.id, model);
		}
	}
	return Array.from(merged.values());
}

function mergeDynamicModels<TApi extends Api>(
	baseModels: readonly Model<TApi>[],
	dynamicModels: readonly Model<TApi>[],
): Model<TApi>[] {
	// Empty-side fast paths: `mergeDynamicModels(base, [])` is the common shape
	// after we've already merged the first pair, and `(...)` with no base
	// happens for providers without static catalogs.
	if (dynamicModels.length === 0) return baseModels.length === 0 ? [] : [...baseModels];
	if (baseModels.length === 0) return [...dynamicModels];
	const merged = new Map<string, Model<TApi>>(baseModels.map(model => [model.id, model]));
	for (const dynamicModel of dynamicModels) {
		if (!dynamicModel?.id) {
			continue;
		}
		const existingModel = merged.get(dynamicModel.id);
		if (!existingModel) {
			merged.set(dynamicModel.id, dynamicModel);
			continue;
		}
		merged.set(dynamicModel.id, mergeDynamicModel(existingModel, dynamicModel));
	}
	return Array.from(merged.values());
}

/**
 * Stable, low-collision fingerprint of a static catalog slice. Cached by
 * reference so repeat calls in the same process (e.g. multiple cold-start
 * arms calling `resolveProviderModels` with the same `staticModels` array)
 * skip the JSON+hash work after the first call.
 */
const kStaticFingerprint = Symbol("model-manager.staticFingerprint");
type ModelArrayWithFingerprint = readonly Model<Api>[] & { [kStaticFingerprint]?: string };
function fingerprintStatic<TApi extends Api>(models: readonly Model<TApi>[]): string {
	if (models.length === 0) return "empty";
	const tagged = models as ModelArrayWithFingerprint;
	const cached = tagged[kStaticFingerprint];
	if (cached !== undefined) return cached;
	// `Bun.hash` returns a `bigint`; base36 keeps the string short for the
	// SQLite column without sacrificing distinguishability.
	const fingerprint = Bun.hash(JSON.stringify(models)).toString(36);
	tagged[kStaticFingerprint] = fingerprint;
	return fingerprint;
}

function mergeDynamicModel<TApi extends Api>(existingModel: Model<TApi>, dynamicModel: Model<TApi>): Model<TApi> {
	const supportsImage = existingModel.input.includes("image") || dynamicModel.input.includes("image");
	// The static catalog is authoritative for transport: `api` (and its
	// api-specific `baseUrl`). Dynamic discovery enumerates ids via a single
	// hardcoded api (e.g. fetchOpenAICompatibleModels always tags
	// `openai-completions`), so spreading it blindly would clobber catalog
	// entries that route through a different format — e.g. opencode-go
	// qwen3.7-max is `anthropic-messages` but would be downgraded to
	// `openai-completions` and 401 with `not supported for format oa-compat`
	// (issue #489). Keep the existing api, and only take the dynamic baseUrl
	// when the api matches (same transport, same URL shape).
	const baseUrl = existingModel.api === dynamicModel.api ? dynamicModel.baseUrl : existingModel.baseUrl;
	const merged = enrichModelThinking({
		...existingModel,
		...dynamicModel,
		api: existingModel.api,
		baseUrl,
		name: sanitizeModelDisplayName(
			preferDiscoveryName(dynamicModel.name, existingModel.name, dynamicModel.id),
			dynamicModel.id,
		),
		reasoning: existingModel.reasoning || dynamicModel.reasoning,
		input: supportsImage ? ["text", "image"] : ["text"],
		cost: {
			input: preferDiscoveryCost(dynamicModel.cost.input, existingModel.cost.input),
			output: preferDiscoveryCost(dynamicModel.cost.output, existingModel.cost.output),
			cacheRead: preferDiscoveryCost(dynamicModel.cost.cacheRead, existingModel.cost.cacheRead),
			cacheWrite: preferDiscoveryCost(dynamicModel.cost.cacheWrite, existingModel.cost.cacheWrite),
		},
		contextWindow: preferDiscoveryLimit(dynamicModel.contextWindow, existingModel.contextWindow),
		maxTokens: preferDiscoveryLimit(dynamicModel.maxTokens, existingModel.maxTokens),
		headers: dynamicModel.headers ? { ...existingModel.headers, ...dynamicModel.headers } : existingModel.headers,
		compat: dynamicModel.compat ?? existingModel.compat,
		contextPromotionTarget: dynamicModel.contextPromotionTarget ?? existingModel.contextPromotionTarget,
	});
	const policyModels = [merged as Model<Api>];
	applyGeneratedModelPolicies(policyModels);
	return policyModels[0] as Model<TApi>;
}

function preferDiscoveryCost(discoveryCost: number, fallbackCost: number): number {
	if (Number.isFinite(discoveryCost) && discoveryCost > 0) {
		return discoveryCost;
	}
	return fallbackCost;
}

function preferDiscoveryName(discoveryName: string, fallbackName: string, modelId: string): string {
	const normalizedDiscoveryName = discoveryName.trim();
	if (normalizedDiscoveryName.length === 0) {
		return fallbackName;
	}
	if (normalizedDiscoveryName === modelId && fallbackName !== modelId) {
		return fallbackName;
	}
	return normalizedDiscoveryName;
}

const MODEL_DISPLAY_NAME_MAX_LENGTH = 200;

function sanitizeModelDisplayName(name: string, modelId: string): string {
	const sanitizedName = sanitizeText(name).replace(/\s+/g, " ").trim().slice(0, MODEL_DISPLAY_NAME_MAX_LENGTH);
	if (sanitizedName.length > 0) return sanitizedName;
	const sanitizedId = sanitizeText(modelId).replace(/\s+/g, " ").trim().slice(0, MODEL_DISPLAY_NAME_MAX_LENGTH);
	return sanitizedId || "Unnamed model";
}

function preferDiscoveryLimit(discoveryLimit: number, fallbackLimit: number): number {
	if (!Number.isFinite(discoveryLimit) || discoveryLimit <= 0) {
		return fallbackLimit;
	}
	if (discoveryLimit === 4096 && fallbackLimit > discoveryLimit) {
		return fallbackLimit;
	}
	return discoveryLimit;
}

function normalizeModelList<TApi extends Api>(value: unknown): Model<TApi>[] {
	if (!Array.isArray(value)) {
		return [];
	}
	const models: Model<TApi>[] = [];
	for (const item of value) {
		if (isModelLike(item) && !isRetiredModel(item)) {
			const model = enrichModelThinking(item as Model<TApi>);
			model.longContextPricing = undefined;
			models.push({ ...model, name: sanitizeModelDisplayName(model.name, model.id) });
		}
	}
	applyGeneratedModelPolicies(models as Model<Api>[]);
	return applyFinalCodexGpt56ContextCap(models);
}

function isModelLike(value: unknown): value is Model<Api> {
	if (!isRecord(value)) {
		return false;
	}
	const v = value as {
		id?: unknown;
		name?: unknown;
		api?: unknown;
		provider?: unknown;
		baseUrl?: unknown;
		reasoning?: unknown;
		input?: unknown;
		cost?: unknown;
		contextWindow?: unknown;
		maxTokens?: unknown;
	};
	if (!isSafeCatalogModelId(v.id)) {
		return false;
	}
	if (typeof v.name !== "string" || v.name.length === 0) {
		return false;
	}
	if (typeof v.api !== "string" || v.api.length === 0) {
		return false;
	}
	if (typeof v.provider !== "string" || v.provider.length === 0) {
		return false;
	}
	if (typeof v.baseUrl !== "string" || v.baseUrl.length === 0) {
		return false;
	}
	if (typeof v.reasoning !== "boolean") {
		return false;
	}
	if (!isModelInputArray(v.input)) {
		return false;
	}
	if (!isModelCost(v.cost)) {
		return false;
	}
	// Finite positive: NaN > 0 is false, +Infinity < Infinity is false.
	const cw = v.contextWindow;
	if (typeof cw !== "number" || !(cw > 0 && cw < Infinity)) {
		return false;
	}
	const mt = v.maxTokens;
	if (typeof mt !== "number" || !(mt > 0 && mt < Infinity)) {
		return false;
	}
	return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isModelInputArray(value: unknown): value is ("text" | "image")[] {
	if (!Array.isArray(value) || value.length === 0) {
		return false;
	}
	for (let i = 0; i < value.length; i++) {
		const item = value[i];
		if (item !== "text" && item !== "image") {
			return false;
		}
	}
	return true;
}

function isModelCost(value: unknown): value is Model<Api>["cost"] {
	if (!isRecord(value)) {
		return false;
	}
	const c = value as {
		input?: unknown;
		output?: unknown;
		cacheRead?: unknown;
		cacheWrite?: unknown;
	};
	// Finite (NaN-safe): -Infinity < x < Infinity rejects NaN and both infinities.
	// Preserves original behavior: 0 and negatives remain valid.
	const ci = c.input;
	if (typeof ci !== "number" || !(ci > -Infinity && ci < Infinity)) {
		return false;
	}
	const co = c.output;
	if (typeof co !== "number" || !(co > -Infinity && co < Infinity)) {
		return false;
	}
	const cr = c.cacheRead;
	if (typeof cr !== "number" || !(cr > -Infinity && cr < Infinity)) {
		return false;
	}
	const cw = c.cacheWrite;
	if (typeof cw !== "number" || !(cw > -Infinity && cw < Infinity)) {
		return false;
	}
	return true;
}
