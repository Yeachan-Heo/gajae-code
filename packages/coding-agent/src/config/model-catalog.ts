import { type Api, getBundledModels, getBundledProviders, type Model } from "@gajae-code/ai";

export type CanonicalModelSource = "builtin" | "discovered" | "custom" | "extension";
export type CanonicalFreshnessStatus = "fresh" | "stale" | "unavailable";
export type CanonicalModelInputModality = "text" | "image";

export interface CanonicalFreshness {
	readonly status: CanonicalFreshnessStatus;
	readonly reason?: string;
	readonly timestamp?: number;
}

export interface CanonicalModelRecord {
	readonly canonicalId: string;
	readonly provider: string;
	readonly modelId: string;
	readonly displayName: string;
	readonly inputModalities: readonly CanonicalModelInputModality[];
	readonly capabilities: readonly string[];
	readonly reasoning: boolean;
	readonly contextWindow: number;
	readonly maxTokens: number;
	readonly source: CanonicalModelSource;
	readonly sourceVersion: string;
	readonly revision: number;
	readonly freshness: CanonicalFreshness;
}

export interface CanonicalModelCatalog {
	readonly revision: number;
	readonly records: readonly CanonicalModelRecord[];
}

export interface CanonicalModelRecordInput {
	readonly canonicalId?: string;
	readonly provider: string;
	readonly modelId: string;
	readonly displayName: string;
	readonly inputModalities?: readonly CanonicalModelInputModality[];
	readonly capabilities?: readonly string[];
	readonly reasoning?: boolean;
	readonly contextWindow: number;
	readonly maxTokens: number;
	readonly source?: CanonicalModelSource;
	readonly sourceVersion?: string;
	readonly revision?: number;
	readonly freshness?: CanonicalFreshness;
}

export type CanonicalFreshnessResolver =
	| CanonicalFreshness
	| CanonicalFreshnessStatus
	| ((model: Model<Api>) => CanonicalFreshness | CanonicalFreshnessStatus);

export type CanonicalSourceResolver = CanonicalModelSource | ((model: Model<Api>) => CanonicalModelSource);
export type CanonicalStringResolver = string | ((model: Model<Api>) => string);
export type CanonicalRevisionResolver = number | ((model: Model<Api>) => number);

export interface ModelProjectionMetadata {
	readonly canonicalId?: string;
	readonly displayName?: string;
	readonly inputModalities?: readonly CanonicalModelInputModality[];
	readonly capabilities?: readonly string[];
	readonly source?: CanonicalModelSource;
	readonly sourceVersion?: string;
	readonly revision?: number;
	readonly freshness?: CanonicalFreshness;
}

export interface ModelRegistryProjectionOptions {
	readonly canonicalId?: CanonicalStringResolver;
	readonly source?: CanonicalSourceResolver;
	readonly sourceVersion?: CanonicalStringResolver;
	readonly revision?: CanonicalRevisionResolver;
	readonly freshness?: CanonicalFreshnessResolver;
	readonly capabilities?: readonly string[] | ((model: Model<Api>) => readonly string[]);
	readonly metadata?: ReadonlyMap<string, ModelProjectionMetadata>;
	readonly catalogRevision?: number;
}

export interface ModelRegistryLike {
	readonly models?: readonly Model<Api>[];
	readonly getAll?: () => readonly Model<Api>[];
	readonly getAvailable?: () => readonly Model<Api>[];
}

export type ModelRegistryProjectionInput = readonly Model<Api>[] | ModelRegistryLike;

export type ModelCatalogErrorCode =
	| "invalid_catalog_record"
	| "invalid_catalog_revision"
	| "invalid_registry_input"
	| "invalid_model_metadata"
	| "projection_failed"
	| "forbidden_field"
	| "invalid_overlay"
	| "unknown_catalog_ref"
	| "invalid_session_id"
	| "invalid_write_expectation"
	| "stale_overlay_update"
	| "stale_catalog_revision"
	| "invalid_overlay_revision";

export class ModelCatalogError extends Error {
	readonly code: ModelCatalogErrorCode;
	readonly reason: ModelCatalogErrorCode;
	readonly field?: string;

	constructor(code: ModelCatalogErrorCode, message: string, field?: string) {
		super(message);
		this.name = "ModelCatalogError";
		this.code = code;
		this.reason = code;
		this.field = field;
		Object.freeze(this);
	}
}

const SOURCE_ORDER: readonly CanonicalModelSource[] = ["builtin", "discovered", "custom", "extension"];
const FRESHNESS_ORDER: readonly CanonicalFreshnessStatus[] = ["fresh", "stale", "unavailable"];
const MODALITY_ORDER: readonly CanonicalModelInputModality[] = ["text", "image"];
const FORBIDDEN_FIELDS = new Set([
	"apikey",
	"token",
	"password",
	"baseurl",
	"endpoint",
	"credential",
	"credentials",
	"secret",
	"price",
	"prices",
	"cost",
	"costs",
	"pricing",
	"inputcost",
	"outputcost",
	"cachereadcost",
	"cachewritecost",
	"inputprice",
	"outputprice",
	"cachereadprice",
	"cachewriteprice",
	"latency",
	"role",
	"roles",
	"fallback",
	"fallbackchain",
	"scope",
	"session",
	"sessionid",
	"workmode",
	"workmodeid",
]);

const UNKNOWN_FRESHNESS_REASON = "freshness_unknown";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizedFieldName(value: string): string {
	return value.toLowerCase().replace(/[_-]/gu, "");
}

function assertNoForbiddenFields(value: unknown, seen: Set<object> = new Set<object>()): void {
	if (value === null || typeof value !== "object") return;
	if (seen.has(value)) return;
	seen.add(value);
	if (Array.isArray(value)) {
		for (const item of value) assertNoForbiddenFields(item, seen);
		return;
	}
	for (const [key, nested] of Object.entries(value)) {
		if (FORBIDDEN_FIELDS.has(normalizedFieldName(key))) {
			throw new ModelCatalogError(
				"forbidden_field",
				"The catalog contract rejects a private or session field.",
				key,
			);
		}
		assertNoForbiddenFields(nested, seen);
	}
}

function requireNonEmpty(value: unknown, code: ModelCatalogErrorCode, field: string): string {
	if (typeof value !== "string") {
		throw new ModelCatalogError(code, "The catalog contract requires a non-empty string.", field);
	}
	const normalized = value.trim();
	if (!normalized || /[\p{Cc}\p{Cf}]/u.test(normalized)) {
		throw new ModelCatalogError(code, "The catalog contract requires a safe non-empty string.", field);
	}
	return normalized;
}

function requireFinite(value: unknown, field: string, minimum: number): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < minimum) {
		throw new ModelCatalogError(
			"invalid_catalog_record",
			"The catalog contract requires a finite non-negative number.",
			field,
		);
	}
	return value;
}

function requireRevision(value: unknown, field: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
		throw new ModelCatalogError(
			"invalid_catalog_revision",
			"The catalog revision must be a positive integer.",
			field,
		);
	}
	return value;
}

function compareText(left: string, right: string): number {
	const lowerLeft = left.toLowerCase();
	const lowerRight = right.toLowerCase();
	if (lowerLeft < lowerRight) return -1;
	if (lowerLeft > lowerRight) return 1;
	if (left < right) return -1;
	if (left > right) return 1;
	return 0;
}

function sourceRank(source: CanonicalModelSource): number {
	return SOURCE_ORDER.indexOf(source);
}

function freshnessRank(status: CanonicalFreshnessStatus): number {
	return FRESHNESS_ORDER.indexOf(status);
}

function isSource(value: unknown): value is CanonicalModelSource {
	return value === "builtin" || value === "discovered" || value === "custom" || value === "extension";
}

function isFreshnessStatus(value: unknown): value is CanonicalFreshnessStatus {
	return value === "fresh" || value === "stale" || value === "unavailable";
}

function normalizeDisplayName(value: unknown, fallback: string): string {
	if (typeof value !== "string") return fallback;
	const normalized = value
		.normalize("NFKC")
		.replace(/[\p{Cc}\p{Cf}]+/gu, " ")
		.trim();
	return normalized.slice(0, 256) || fallback;
}

function freezeStrings(values: readonly string[]): readonly string[] {
	const unique = new Set<string>();
	for (const value of values) {
		const normalized = requireNonEmpty(value, "invalid_catalog_record", "values");
		unique.add(normalized);
	}
	return Object.freeze([...unique].sort(compareText));
}

function freezeModalities(values: readonly CanonicalModelInputModality[]): readonly CanonicalModelInputModality[] {
	const unique = new Set<CanonicalModelInputModality>();
	for (const value of values) {
		if (!MODALITY_ORDER.includes(value)) {
			throw new ModelCatalogError(
				"invalid_catalog_record",
				"The catalog input modality is not supported.",
				"inputModalities",
			);
		}
		unique.add(value);
	}
	return Object.freeze([...MODALITY_ORDER].filter(value => unique.has(value)));
}

function freezeFreshness(value: CanonicalFreshness | undefined): CanonicalFreshness {
	const status = value?.status ?? "fresh";
	if (!isFreshnessStatus(status)) {
		throw new ModelCatalogError(
			"invalid_catalog_record",
			"The catalog freshness status is not supported.",
			"freshness.status",
		);
	}
	const reason =
		value?.reason === undefined
			? undefined
			: requireNonEmpty(value.reason, "invalid_catalog_record", "freshness.reason");
	const timestamp =
		value?.timestamp === undefined ? undefined : requireFinite(value.timestamp, "freshness.timestamp", 0);
	const freshness: CanonicalFreshness = Object.freeze({
		status,
		...(reason === undefined ? {} : { reason }),
		...(timestamp === undefined ? {} : { timestamp }),
	});
	return freshness;
}

function safeRecordInput(input: CanonicalModelRecordInput): CanonicalModelRecord {
	assertNoForbiddenFields(input);
	const provider = requireNonEmpty(input.provider, "invalid_catalog_record", "provider");
	const modelId = requireNonEmpty(input.modelId, "invalid_catalog_record", "modelId");
	const canonicalId = requireNonEmpty(
		input.canonicalId ?? `${provider}/${modelId}`,
		"invalid_catalog_record",
		"canonicalId",
	);
	const fallbackName = `${provider}/${modelId}`;
	const displayName = normalizeDisplayName(input.displayName, fallbackName);
	const inputModalities = freezeModalities(input.inputModalities ?? ["text"]);
	const capabilities = freezeStrings(input.capabilities ?? []);
	const reasoning = input.reasoning ?? false;
	if (typeof reasoning !== "boolean") {
		throw new ModelCatalogError("invalid_catalog_record", "The catalog reasoning flag must be boolean.", "reasoning");
	}
	const contextWindow = requireFinite(input.contextWindow, "contextWindow", 1);
	const maxTokens = requireFinite(input.maxTokens, "maxTokens", 0);
	const source = input.source ?? "builtin";
	if (!isSource(source)) {
		throw new ModelCatalogError("invalid_catalog_record", "The catalog source is not supported.", "source");
	}
	const sourceVersion = requireNonEmpty(input.sourceVersion ?? source, "invalid_catalog_record", "sourceVersion");
	const revision = input.revision === undefined ? 1 : requireRevision(input.revision, "revision");
	const freshness = freezeFreshness(input.freshness);
	const record: CanonicalModelRecord = Object.freeze({
		canonicalId,
		provider,
		modelId,
		displayName,
		inputModalities,
		capabilities,
		reasoning,
		contextWindow,
		maxTokens,
		source,
		sourceVersion,
		revision,
		freshness,
	});
	return record;
}

function compareRecords(left: CanonicalModelRecord, right: CanonicalModelRecord): number {
	const idOrder = compareText(left.canonicalId, right.canonicalId);
	if (idOrder !== 0) return idOrder;
	const sourceOrder = sourceRank(left.source) - sourceRank(right.source);
	if (sourceOrder !== 0) return sourceOrder;
	const freshnessOrder = freshnessRank(left.freshness.status) - freshnessRank(right.freshness.status);
	if (freshnessOrder !== 0) return freshnessOrder;
	if (left.revision !== right.revision) return right.revision - left.revision;
	const versionOrder = compareText(left.sourceVersion, right.sourceVersion);
	if (versionOrder !== 0) return versionOrder;
	const providerOrder = compareText(left.provider, right.provider);
	if (providerOrder !== 0) return providerOrder;
	return compareText(left.modelId, right.modelId);
}

function deduplicateRecords(records: readonly CanonicalModelRecord[]): readonly CanonicalModelRecord[] {
	const sorted = [...records].sort(compareRecords);
	const chosen = new Map<string, CanonicalModelRecord>();
	for (const record of sorted) {
		const key = record.canonicalId.toLowerCase();
		if (!chosen.has(key)) chosen.set(key, record);
	}
	return Object.freeze([...chosen.values()]);
}

function buildCatalog(records: readonly CanonicalModelRecord[], revision: number): CanonicalModelCatalog {
	const catalogRevision = requireRevision(revision, "catalogRevision");
	const frozenRecords = deduplicateRecords(records);
	const catalog: CanonicalModelCatalog = Object.freeze({
		revision: catalogRevision,
		records: frozenRecords,
	});
	return catalog;
}

function isModelValue(value: unknown): value is Model<Api> {
	return (
		isRecord(value) &&
		typeof value.api === "string" &&
		typeof value.provider === "string" &&
		typeof value.id === "string"
	);
}

function isCanonicalModelRecordInput(value: unknown): value is CanonicalModelRecordInput {
	return (
		isRecord(value) &&
		typeof value.provider === "string" &&
		typeof value.modelId === "string" &&
		typeof value.displayName === "string" &&
		typeof value.contextWindow === "number" &&
		typeof value.maxTokens === "number"
	);
}

function isModelArray(value: ModelRegistryProjectionInput): value is readonly Model<Api>[] {
	return Array.isArray(value);
}

function isRegistryObject(value: ModelRegistryProjectionInput): value is ModelRegistryLike {
	return !isModelArray(value) && isRecord(value);
}

function resolveRegistryModels(source: ModelRegistryProjectionInput): readonly Model<Api>[] {
	if (isModelArray(source)) return Object.freeze([...source]);
	if (!isRegistryObject(source)) {
		throw new ModelCatalogError("invalid_registry_input", "The model registry does not expose model values.");
	}
	if (source.models !== undefined) return Object.freeze([...source.models]);
	if (typeof source.getAll === "function") return Object.freeze([...source.getAll()]);
	if (typeof source.getAvailable === "function") return Object.freeze([...source.getAvailable()]);
	throw new ModelCatalogError("invalid_registry_input", "The model registry does not expose model values.");
}

function isGeneratedBundledProvider(value: string): value is Parameters<typeof getBundledModels>[0] {
	return getBundledProviders().some(provider => provider === value);
}

function bundledModelReferences(): ReadonlySet<Model<Api>> {
	const references = new Set<Model<Api>>();
	for (const provider of getBundledProviders()) {
		if (!isGeneratedBundledProvider(provider)) continue;
		for (const bundledModel of getBundledModels(provider)) references.add(bundledModel);
	}
	return references;
}

const BUNDLED_MODEL_REFERENCES = bundledModelReferences();

function isBundledModel(model: Model<Api>): boolean {
	return BUNDLED_MODEL_REFERENCES.has(model);
}

function resolveText(value: CanonicalStringResolver | undefined, model: Model<Api>, fallback: string): string {
	if (value === undefined) return fallback;
	if (typeof value === "string") return value;
	return value(model);
}

function resolveSource(
	value: CanonicalSourceResolver | undefined,
	model: Model<Api>,
	fallback: CanonicalModelSource,
): CanonicalModelSource {
	if (value === undefined) return fallback;
	if (typeof value === "string") return value;
	return value(model);
}

function resolveRevision(value: CanonicalRevisionResolver | undefined, model: Model<Api>, fallback: number): number {
	if (value === undefined) return fallback;
	if (typeof value === "number") return value;
	return value(model);
}

function resolveFreshness(
	value: CanonicalFreshnessResolver | undefined,
	model: Model<Api>,
	fallback: CanonicalFreshness | CanonicalFreshnessStatus,
): CanonicalFreshness | CanonicalFreshnessStatus {
	if (value === undefined) return fallback;
	if (typeof value === "string") return value;
	if (typeof value === "function") return value(model);
	return value;
}

function resolveCapabilities(
	value: readonly string[] | ((model: Model<Api>) => readonly string[]) | undefined,
	model: Model<Api>,
): readonly string[] {
	if (value === undefined) return [];
	if (typeof value === "function") return value(model);
	return value;
}

function assertProjectionOptions(options: ModelRegistryProjectionOptions): void {
	assertNoForbiddenFields(options);
	for (const [, metadata] of options.metadata ?? []) assertNoForbiddenFields(metadata);
}

function metadataForModel(
	model: Model<Api>,
	options: ModelRegistryProjectionOptions,
): ModelProjectionMetadata | undefined {
	return (
		options.metadata?.get(`${model.provider}/${model.id}`) ??
		options.metadata?.get(`${model.provider}/${model.id}`.toLowerCase())
	);
}

function projectModel(model: Model<Api>, options: ModelRegistryProjectionOptions): CanonicalModelRecord {
	try {
		if (!isModelValue(model)) {
			throw new ModelCatalogError("invalid_model_metadata", "A model registry value is malformed.");
		}
		const metadata = metadataForModel(model, options);
		const provider = requireNonEmpty(model.provider, "invalid_model_metadata", "provider");
		const modelId = requireNonEmpty(model.id, "invalid_model_metadata", "modelId");
		const canonicalId = requireNonEmpty(
			metadata?.canonicalId ?? resolveText(options.canonicalId, model, `${provider}/${modelId}`),
			"invalid_model_metadata",
			"canonicalId",
		);
		const displayName = normalizeDisplayName(metadata?.displayName ?? model.name, `${provider}/${modelId}`);
		if (!Array.isArray(model.input)) {
			throw new ModelCatalogError(
				"invalid_model_metadata",
				"A model registry input modality list is malformed.",
				"inputModalities",
			);
		}
		const inputModalities = metadata?.inputModalities ?? model.input;
		const derivedCapabilities = new Set<string>();
		if (model.reasoning) derivedCapabilities.add("reasoning");
		if (inputModalities.includes("image")) derivedCapabilities.add("vision");
		if (model.output?.includes("image")) derivedCapabilities.add("image-output");
		const configuredCapabilities = metadata?.capabilities ?? resolveCapabilities(options.capabilities, model);
		for (const capability of configuredCapabilities) derivedCapabilities.add(capability);
		const bundled = isBundledModel(model);
		const source = metadata?.source ?? resolveSource(options.source, model, bundled ? "builtin" : "discovered");
		const sourceVersion = metadata?.sourceVersion ?? resolveText(options.sourceVersion, model, source);
		const recordRevision = metadata?.revision ?? resolveRevision(options.revision, model, 1);
		const freshness =
			metadata?.freshness ??
			resolveFreshness(
				options.freshness,
				model,
				bundled ? { status: "fresh" } : { status: "unavailable", reason: UNKNOWN_FRESHNESS_REASON },
			);
		const canonicalFreshness: CanonicalFreshness = typeof freshness === "string" ? { status: freshness } : freshness;
		return safeRecordInput({
			canonicalId,
			provider,
			modelId,
			displayName,
			inputModalities,
			capabilities: [...derivedCapabilities],
			reasoning: model.reasoning,
			contextWindow: model.contextWindow,
			maxTokens: model.maxTokens,
			source,
			sourceVersion,
			revision: recordRevision,
			freshness: canonicalFreshness,
		});
	} catch (error: unknown) {
		if (error instanceof ModelCatalogError) throw error;
		throw new ModelCatalogError("projection_failed", "The model registry projection failed.");
	}
}

export function createCanonicalModelRecord(input: CanonicalModelRecordInput): CanonicalModelRecord {
	return safeRecordInput(input);
}

export function createCanonicalModelCatalog(
	input: readonly CanonicalModelRecordInput[] | readonly Model<Api>[],
	options: { readonly revision?: number } = {},
): CanonicalModelCatalog {
	if (input.length === 0) return buildCatalog([], options.revision ?? 1);
	const first = input[0];
	if (isModelValue(first)) {
		const models: Model<Api>[] = [];
		for (const value of input) {
			if (!isModelValue(value)) {
				throw new ModelCatalogError("invalid_registry_input", "The model registry contains a malformed value.");
			}
			models.push(value);
		}
		return projectModelRegistry(models, { catalogRevision: options.revision });
	}
	const records: CanonicalModelRecordInput[] = [];
	for (const value of input) {
		if (!isCanonicalModelRecordInput(value)) {
			throw new ModelCatalogError("invalid_catalog_record", "The catalog records contain a model registry value.");
		}
		records.push(value);
	}
	return buildCatalog(
		records.map(record => safeRecordInput(record)),
		options.revision ?? 1,
	);
}

export function projectModelRegistry(
	source: ModelRegistryProjectionInput,
	options: ModelRegistryProjectionOptions = {},
): CanonicalModelCatalog {
	assertProjectionOptions(options);
	const models = resolveRegistryModels(source);
	const records = models.map(model => projectModel(model, options));
	return buildCatalog(records, options.catalogRevision ?? 1);
}
