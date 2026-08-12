import {
	type CanonicalModelCatalog,
	type CanonicalModelRecord,
	createCanonicalModelCatalog,
	ModelCatalogError,
	type ModelCatalogErrorCode,
} from "./model-catalog";

export type ModelOverlayScope = "turn" | "session" | "project" | "user" | "managed";
export type ModelOverlayConfirmationStatus = "pending" | "confirmed" | "rejected" | "unknown";
export type ModelOverlayUsabilityStatus = "usable" | "missing" | "unknown";

export interface ModelOverlaySkip {
	readonly catalogRecordId: string;
	readonly reason: string;
	readonly selector?: string;
}

export interface ModelOverlayTiming {
	readonly requestedAt?: number;
	readonly startedAt?: number;
	readonly appliedAt?: number;
	readonly completedAt?: number;
	readonly durationMs?: number;
}

export interface ModelOverlayConfirmation {
	readonly status: ModelOverlayConfirmationStatus;
	readonly timestamp?: number;
	readonly reason?: string;
}

export interface ModelOverlayUsability {
	readonly status: ModelOverlayUsabilityStatus;
	readonly reason?: string;
}

export interface FingerprintQualifiedWorkMode {
	readonly id: string;
	readonly fingerprint: string;
}

export interface ModelResolutionOverlay {
	readonly version: 1;
	readonly sessionId: string;
	readonly catalogRevision: number;
	readonly sessionRevision: number;
	readonly catalogRecordId: string;
	readonly profileId?: string;
	readonly requestedSelectors: readonly string[];
	readonly requestedRoles: readonly string[];
	readonly resolvedCanonicalIds: readonly string[];
	readonly resolvedEfforts: readonly string[];
	readonly fallbackChain: readonly string[];
	readonly activeIndex: number | null;
	readonly skips: readonly ModelOverlaySkip[];
	readonly scope?: ModelOverlayScope;
	readonly timing?: ModelOverlayTiming;
	readonly confirmation?: ModelOverlayConfirmation;
	readonly usability?: ModelOverlayUsability;
	readonly receiptRefs: readonly string[];
	readonly workMode?: FingerprintQualifiedWorkMode;
}

export interface ModelResolutionOverlayInput {
	readonly sessionId: string;
	readonly catalogRecordId: string;
	readonly catalogRevision?: number;
	readonly sessionRevision?: number;
	readonly profileId?: string;
	readonly requestedSelectors?: readonly string[];
	readonly requestedRoles?: readonly string[];
	readonly resolvedCanonicalIds?: readonly string[];
	readonly resolvedEfforts?: readonly string[];
	readonly fallbackChain?: readonly string[];
	readonly activeIndex?: number | null;
	readonly skips?: readonly ModelOverlaySkip[];
	readonly scope?: ModelOverlayScope;
	readonly timing?: ModelOverlayTiming;
	readonly confirmation?: ModelOverlayConfirmation;
	readonly usability?: ModelOverlayUsability;
	readonly receiptRefs?: readonly string[];
	readonly workMode?: FingerprintQualifiedWorkMode;
}

export interface ModelCatalogWriteExpectation {
	readonly catalogRevision: number;
	readonly sessionRevision: number;
}

const OVERLAY_VERSION = 1;
const SCOPE_VALUES: readonly ModelOverlayScope[] = ["turn", "session", "project", "user", "managed"];
const CONFIRMATION_VALUES: readonly ModelOverlayConfirmationStatus[] = ["pending", "confirmed", "rejected", "unknown"];
const USABILITY_VALUES: readonly ModelOverlayUsabilityStatus[] = ["usable", "missing", "unknown"];
const OVERLAY_FORBIDDEN_FIELDS = new Set([
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
]);

function fieldName(value: string): string {
	return value.toLowerCase().replace(/[_-]/gu, "");
}

function rejectForbiddenFields(value: unknown, seen: Set<object> = new Set<object>()): void {
	if (value === null || typeof value !== "object") return;
	if (seen.has(value)) return;
	seen.add(value);
	if (Array.isArray(value)) {
		for (const item of value) rejectForbiddenFields(item, seen);
		return;
	}
	for (const [key, nested] of Object.entries(value)) {
		if (OVERLAY_FORBIDDEN_FIELDS.has(fieldName(key))) {
			throw new ModelCatalogError("forbidden_field", "The overlay contract rejects a private field.", key);
		}
		rejectForbiddenFields(nested, seen);
	}
}

function requiredString(value: unknown, code: ModelCatalogErrorCode, field: string): string {
	if (typeof value !== "string") throw new ModelCatalogError(code, "The overlay contract requires a string.", field);
	const normalized = value.trim();
	if (!normalized || /[\p{Cc}\p{Cf}]/u.test(normalized)) {
		throw new ModelCatalogError(code, "The overlay contract requires a safe non-empty string.", field);
	}
	return normalized;
}

function presentationString(value: unknown, field: string): string {
	const normalized = requiredString(value, "invalid_overlay", field);
	const containsUrl = /\b[a-z][a-z\d+.-]{1,31}:\/\//iu.test(normalized);
	const containsQuery = /[?&#]/u.test(normalized) || /(?:^|[?&\s])[^=\s/?#]+=[^\s&]*/u.test(normalized);
	const containsCredential = /(?:api[_-]?key|token|password|secret|credential|authorization)\s*[:=]/iu.test(
		normalized,
	);
	if (containsUrl || containsQuery || containsCredential) {
		throw new ModelCatalogError(
			"invalid_overlay",
			"The overlay presentation value contains a URL, query, or credential pattern.",
			field,
		);
	}
	return normalized;
}

function presentationStrings(values: readonly string[] | undefined, field: string): readonly string[] {
	const output: string[] = [];
	const seen = new Set<string>();
	for (const value of values ?? []) {
		const normalized = presentationString(value, field);
		if (!seen.has(normalized)) {
			seen.add(normalized);
			output.push(normalized);
		}
	}
	return Object.freeze(output);
}

function optionalString(value: unknown, code: ModelCatalogErrorCode, field: string): string | undefined {
	return value === undefined ? undefined : requiredString(value, code, field);
}

function requiredRevision(value: unknown, field: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
		throw new ModelCatalogError("invalid_overlay", "The overlay revision must be a positive integer.", field);
	}
	return value;
}

function expectedRevision(value: unknown, field: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
		throw new ModelCatalogError(
			"invalid_write_expectation",
			"The write expectation must be a non-negative integer.",
			field,
		);
	}
	return value;
}

function optionalTimestamp(value: unknown, field: string): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		throw new ModelCatalogError("invalid_overlay", "The overlay timestamp must be finite and non-negative.", field);
	}
	return value;
}

function strings(values: readonly string[] | undefined, field: string): readonly string[] {
	const output: string[] = [];
	const seen = new Set<string>();
	for (const value of values ?? []) {
		const normalized = requiredString(value, "invalid_overlay", field);
		if (!seen.has(normalized)) {
			seen.add(normalized);
			output.push(normalized);
		}
	}
	return Object.freeze(output);
}

function recordsForCatalog(catalog: CanonicalModelCatalog): readonly CanonicalModelRecord[] {
	return catalog.records;
}

function catalogIds(catalog: CanonicalModelCatalog): ReadonlySet<string> {
	return new Set(recordsForCatalog(catalog).map(record => record.canonicalId));
}

function requireCatalogId(value: unknown, knownIds: ReadonlySet<string>, field: string): string {
	const id = requiredString(value, "invalid_overlay", field);
	if (!knownIds.has(id)) {
		throw new ModelCatalogError("unknown_catalog_ref", "The overlay references an unknown catalog record.", field);
	}
	return id;
}

function requireCatalogIds(
	values: readonly string[] | undefined,
	knownIds: ReadonlySet<string>,
	field: string,
): readonly string[] {
	const output: string[] = [];
	for (const value of values ?? []) output.push(requireCatalogId(value, knownIds, field));
	return Object.freeze(output);
}

function freezeTiming(value: ModelOverlayTiming | undefined): ModelOverlayTiming | undefined {
	if (value === undefined) return undefined;
	rejectForbiddenFields(value);
	const timing: ModelOverlayTiming = Object.freeze({
		...(value.requestedAt === undefined
			? {}
			: { requestedAt: optionalTimestamp(value.requestedAt, "timing.requestedAt") }),
		...(value.startedAt === undefined ? {} : { startedAt: optionalTimestamp(value.startedAt, "timing.startedAt") }),
		...(value.appliedAt === undefined ? {} : { appliedAt: optionalTimestamp(value.appliedAt, "timing.appliedAt") }),
		...(value.completedAt === undefined
			? {}
			: { completedAt: optionalTimestamp(value.completedAt, "timing.completedAt") }),
		...(value.durationMs === undefined
			? {}
			: { durationMs: optionalTimestamp(value.durationMs, "timing.durationMs") }),
	});
	return timing;
}

function freezeConfirmation(value: ModelOverlayConfirmation | undefined): ModelOverlayConfirmation | undefined {
	if (value === undefined) return undefined;
	rejectForbiddenFields(value);
	if (!CONFIRMATION_VALUES.includes(value.status)) {
		throw new ModelCatalogError(
			"invalid_overlay",
			"The overlay confirmation status is not supported.",
			"confirmation.status",
		);
	}
	const reason = value.reason === undefined ? undefined : presentationString(value.reason, "confirmation.reason");
	return Object.freeze({
		status: value.status,
		...(value.timestamp === undefined
			? {}
			: { timestamp: optionalTimestamp(value.timestamp, "confirmation.timestamp") }),
		...(reason === undefined ? {} : { reason }),
	});
}

function freezeUsability(value: ModelOverlayUsability | undefined): ModelOverlayUsability | undefined {
	if (value === undefined) return undefined;
	rejectForbiddenFields(value);
	if (!USABILITY_VALUES.includes(value.status)) {
		throw new ModelCatalogError(
			"invalid_overlay",
			"The overlay usability status is not supported.",
			"usability.status",
		);
	}
	const reason = value.reason === undefined ? undefined : presentationString(value.reason, "usability.reason");
	return Object.freeze({ status: value.status, ...(reason === undefined ? {} : { reason }) });
}

function freezeSkips(
	values: readonly ModelOverlaySkip[] | undefined,
	knownIds: ReadonlySet<string>,
): readonly ModelOverlaySkip[] {
	const skips: ModelOverlaySkip[] = [];
	for (const value of values ?? []) {
		rejectForbiddenFields(value);
		const catalogRecordId = requireCatalogId(value.catalogRecordId, knownIds, "skips.catalogRecordId");
		const reason = presentationString(value.reason, "skips.reason");
		const selector = value.selector === undefined ? undefined : presentationString(value.selector, "skips.selector");
		skips.push(
			Object.freeze({
				catalogRecordId,
				reason,
				...(selector === undefined ? {} : { selector }),
			}),
		);
	}
	return Object.freeze(skips);
}

function freezeWorkMode(value: FingerprintQualifiedWorkMode | undefined): FingerprintQualifiedWorkMode | undefined {
	if (value === undefined) return undefined;
	rejectForbiddenFields(value);
	const id = requiredString(value.id, "invalid_overlay", "workMode.id");
	const fingerprint = requiredString(value.fingerprint, "invalid_overlay", "workMode.fingerprint");
	return Object.freeze({ id, fingerprint });
}

export function createModelResolutionOverlay(
	input: ModelResolutionOverlayInput,
	catalog: CanonicalModelCatalog,
): ModelResolutionOverlay {
	if (input === null || typeof input !== "object") {
		throw new ModelCatalogError("invalid_overlay", "The overlay input must be an object.");
	}
	rejectForbiddenFields(input);
	if (!catalog) {
		throw new ModelCatalogError("invalid_overlay", "The overlay requires a revisioned catalog snapshot.");
	}
	const knownIds = catalogIds(catalog);
	const sessionId = requiredString(input.sessionId, "invalid_session_id", "sessionId");
	const catalogRecordId = requireCatalogId(input.catalogRecordId, knownIds, "catalogRecordId");
	const catalogRevision =
		input.catalogRevision === undefined
			? catalog.revision
			: requiredRevision(input.catalogRevision, "catalogRevision");
	if (catalogRevision !== catalog.revision) {
		throw new ModelCatalogError(
			"stale_catalog_revision",
			"The overlay catalog revision is stale.",
			"catalogRevision",
		);
	}
	const sessionRevision =
		input.sessionRevision === undefined ? 1 : requiredRevision(input.sessionRevision, "sessionRevision");
	const requestedSelectors = presentationStrings(input.requestedSelectors, "requestedSelectors");
	const requestedRoles = strings(input.requestedRoles, "requestedRoles");
	const resolvedCanonicalIds = requireCatalogIds(input.resolvedCanonicalIds, knownIds, "resolvedCanonicalIds");
	const resolvedEfforts = strings(input.resolvedEfforts, "resolvedEfforts");
	const fallbackChain = requireCatalogIds(input.fallbackChain, knownIds, "fallbackChain");
	const activeIndex = input.activeIndex === undefined ? null : input.activeIndex;
	if (
		activeIndex !== null &&
		(!Number.isSafeInteger(activeIndex) || activeIndex < 0 || activeIndex >= fallbackChain.length)
	) {
		throw new ModelCatalogError(
			"invalid_overlay",
			"The active fallback index is outside the fallback chain.",
			"activeIndex",
		);
	}
	const profileId = optionalString(input.profileId, "invalid_overlay", "profileId");
	const scope = input.scope;
	if (scope !== undefined && !SCOPE_VALUES.includes(scope)) {
		throw new ModelCatalogError("invalid_overlay", "The overlay scope is not supported.", "scope");
	}
	const timing = freezeTiming(input.timing);
	const confirmation = freezeConfirmation(input.confirmation);
	const usability = freezeUsability(input.usability);
	const skips = freezeSkips(input.skips, knownIds);
	const receiptRefs = presentationStrings(input.receiptRefs, "receiptRefs");
	const workMode = freezeWorkMode(input.workMode);
	const overlay: ModelResolutionOverlay = Object.freeze({
		version: OVERLAY_VERSION,
		sessionId,
		catalogRevision,
		sessionRevision,
		catalogRecordId,
		...(profileId === undefined ? {} : { profileId }),
		requestedSelectors,
		requestedRoles,
		resolvedCanonicalIds,
		resolvedEfforts,
		fallbackChain,
		activeIndex,
		skips,
		...(scope === undefined ? {} : { scope }),
		...(timing === undefined ? {} : { timing }),
		...(confirmation === undefined ? {} : { confirmation }),
		...(usability === undefined ? {} : { usability }),
		receiptRefs,
		...(workMode === undefined ? {} : { workMode }),
	});
	return overlay;
}

export class ModelCatalogSessionStore {
	readonly #catalog: CanonicalModelCatalog;
	readonly #overlays = new Map<string, ModelResolutionOverlay>();
	readonly #sessionRevisions = new Map<string, number>();

	constructor(catalog: CanonicalModelCatalog) {
		this.#catalog = createCanonicalModelCatalog(catalog.records, { revision: catalog.revision });
	}

	getBaseSnapshot(): CanonicalModelCatalog {
		return this.#catalog;
	}

	getOverlay(sessionId: string): ModelResolutionOverlay | undefined {
		const normalized = requiredString(sessionId, "invalid_session_id", "sessionId");
		return this.#overlays.get(normalized);
	}

	getSessionRevision(sessionId: string): number {
		const normalized = requiredString(sessionId, "invalid_session_id", "sessionId");
		return this.#sessionRevisions.get(normalized) ?? 0;
	}

	putOverlay(overlay: ModelResolutionOverlay, expected: ModelCatalogWriteExpectation): ModelResolutionOverlay {
		const expectedCatalogRevision = expectedRevision(expected.catalogRevision, "catalogRevision");
		const expectedSessionRevision = expectedRevision(expected.sessionRevision, "sessionRevision");
		if (expectedCatalogRevision !== this.#catalog.revision) {
			throw new ModelCatalogError(
				"stale_catalog_revision",
				"The catalog snapshot changed before the overlay write.",
			);
		}
		const validated = createModelResolutionOverlay(overlay, this.#catalog);
		const currentRevision = this.#sessionRevisions.get(validated.sessionId) ?? 0;
		if (expectedSessionRevision !== currentRevision) {
			throw new ModelCatalogError("stale_overlay_update", "The session overlay changed before the write.");
		}
		if (validated.catalogRevision !== this.#catalog.revision) {
			throw new ModelCatalogError("stale_catalog_revision", "The overlay references a different catalog snapshot.");
		}
		if (
			expectedSessionRevision >= Number.MAX_SAFE_INTEGER ||
			validated.sessionRevision !== expectedSessionRevision + 1
		) {
			throw new ModelCatalogError("invalid_overlay_revision", "The overlay revision must advance exactly once.");
		}
		this.#overlays.set(validated.sessionId, validated);
		this.#sessionRevisions.set(validated.sessionId, validated.sessionRevision);
		return validated;
	}

	clearOverlay(sessionId: string, expected: ModelCatalogWriteExpectation): void {
		const normalized = requiredString(sessionId, "invalid_session_id", "sessionId");
		const expectedCatalogRevision = expectedRevision(expected.catalogRevision, "catalogRevision");
		const expectedSessionRevision = expectedRevision(expected.sessionRevision, "sessionRevision");
		if (expectedCatalogRevision !== this.#catalog.revision) {
			throw new ModelCatalogError(
				"stale_catalog_revision",
				"The catalog snapshot changed before the overlay clear.",
			);
		}
		const currentRevision = this.#sessionRevisions.get(normalized) ?? 0;
		if (expectedSessionRevision !== currentRevision) {
			throw new ModelCatalogError("stale_overlay_update", "The session overlay changed before the clear.");
		}
		if (currentRevision >= Number.MAX_SAFE_INTEGER) {
			throw new ModelCatalogError("invalid_overlay_revision", "The session revision cannot advance further.");
		}
		this.#sessionRevisions.set(normalized, currentRevision + 1);
		this.#overlays.delete(normalized);
	}
}
