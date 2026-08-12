import { ThinkingLevel } from "@gajae-code/agent-core";
import {
	type Api,
	type Effort,
	getSupportedEfforts,
	type Model,
	THINKING_CONTROL_MODES,
	THINKING_EFFORTS,
	type ThinkingControlMode,
} from "@gajae-code/ai";
import {
	type CanonicalFreshness,
	type CanonicalModelCatalog,
	type CanonicalModelInputModality,
	type CanonicalModelRecord,
	ModelCatalogError,
} from "../config/model-catalog";
import type {
	ModelOverlayConfirmation,
	ModelOverlaySkip,
	ModelOverlayTiming,
	ModelOverlayUsability,
	ModelResolutionOverlay,
} from "../config/model-resolution-overlay";

export interface SdkCanonicalFreshness {
	readonly status: CanonicalFreshness["status"];
	readonly reason?: string;
	readonly timestamp?: number;
}

export interface SdkCanonicalModelRecord {
	readonly canonicalId: string;
	readonly provider: string;
	readonly modelId: string;
	readonly displayName: string;
	readonly inputModalities: readonly CanonicalModelInputModality[];
	readonly capabilities: readonly string[];
	readonly reasoning: boolean;
	readonly contextWindow: number;
	readonly maxTokens: number;
	readonly source: CanonicalModelRecord["source"];
	readonly sourceVersion: string;
	readonly revision: number;
	readonly freshness: SdkCanonicalFreshness;
}

export interface SdkModelCatalog {
	readonly version: 1;
	readonly revision: number;
	readonly records: readonly SdkCanonicalModelRecord[];
}

export interface SdkModelOverlaySkip {
	readonly catalogRecordId: string;
	readonly reason: string;
	readonly selector?: string;
}

export interface SdkModelOverlayTiming {
	readonly requestedAt?: number;
	readonly startedAt?: number;
	readonly appliedAt?: number;
	readonly completedAt?: number;
	readonly durationMs?: number;
}

export interface SdkModelOverlayConfirmation {
	readonly status: ModelOverlayConfirmation["status"];
	readonly timestamp?: number;
	readonly reason?: string;
}

export interface SdkModelOverlayUsability {
	readonly status: ModelOverlayUsability["status"];
	readonly reason?: string;
}

export interface SdkModelResolutionOverlay {
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
	readonly skips: readonly SdkModelOverlaySkip[];
	readonly scope?: ModelResolutionOverlay["scope"];
	readonly timing?: SdkModelOverlayTiming;
	readonly confirmation?: SdkModelOverlayConfirmation;
	readonly usability?: SdkModelOverlayUsability;
	readonly receiptRefs: readonly string[];
	readonly workMode?: { readonly id: string; readonly fingerprint: string };
}

function copyFreshness(value: CanonicalFreshness): SdkCanonicalFreshness {
	return Object.freeze({
		status: value.status,
		...(value.reason === undefined ? {} : { reason: value.reason }),
		...(value.timestamp === undefined ? {} : { timestamp: value.timestamp }),
	});
}

function copyCanonicalRecord(value: CanonicalModelRecord): SdkCanonicalModelRecord {
	return Object.freeze({
		canonicalId: value.canonicalId,
		provider: value.provider,
		modelId: value.modelId,
		displayName: value.displayName,
		inputModalities: Object.freeze([...value.inputModalities]),
		capabilities: Object.freeze([...value.capabilities]),
		reasoning: value.reasoning,
		contextWindow: value.contextWindow,
		maxTokens: value.maxTokens,
		source: value.source,
		sourceVersion: value.sourceVersion,
		revision: value.revision,
		freshness: copyFreshness(value.freshness),
	});
}

export function projectCanonicalModelCatalog(catalog: CanonicalModelCatalog): SdkModelCatalog {
	return Object.freeze({
		version: 1,
		revision: catalog.revision,
		records: Object.freeze(catalog.records.map(copyCanonicalRecord)),
	});
}

function copyOverlayTiming(value: ModelOverlayTiming): SdkModelOverlayTiming {
	return Object.freeze({
		...(value.requestedAt === undefined ? {} : { requestedAt: value.requestedAt }),
		...(value.startedAt === undefined ? {} : { startedAt: value.startedAt }),
		...(value.appliedAt === undefined ? {} : { appliedAt: value.appliedAt }),
		...(value.completedAt === undefined ? {} : { completedAt: value.completedAt }),
		...(value.durationMs === undefined ? {} : { durationMs: value.durationMs }),
	});
}

function copyOverlayConfirmation(value: ModelOverlayConfirmation): SdkModelOverlayConfirmation {
	return Object.freeze({
		status: value.status,
		...(value.timestamp === undefined ? {} : { timestamp: value.timestamp }),
		...(value.reason === undefined ? {} : { reason: value.reason }),
	});
}

function copyOverlayUsability(value: ModelOverlayUsability): SdkModelOverlayUsability {
	return Object.freeze({
		status: value.status,
		...(value.reason === undefined ? {} : { reason: value.reason }),
	});
}

function copyOverlaySkip(value: ModelOverlaySkip): SdkModelOverlaySkip {
	return Object.freeze({
		catalogRecordId: value.catalogRecordId,
		reason: value.reason,
		...(value.selector === undefined ? {} : { selector: value.selector }),
	});
}

export function projectModelResolutionOverlay(
	overlay: ModelResolutionOverlay,
	sessionId: string,
): SdkModelResolutionOverlay {
	const requestedSessionId = sessionId.trim();
	if (!requestedSessionId || overlay.sessionId !== requestedSessionId) {
		throw new ModelCatalogError(
			"invalid_session_id",
			"The requested overlay session does not match the current session.",
		);
	}
	return Object.freeze({
		version: 1,
		sessionId: overlay.sessionId,
		catalogRevision: overlay.catalogRevision,
		sessionRevision: overlay.sessionRevision,
		catalogRecordId: overlay.catalogRecordId,
		...(overlay.profileId === undefined ? {} : { profileId: overlay.profileId }),
		requestedSelectors: Object.freeze([...overlay.requestedSelectors]),
		requestedRoles: Object.freeze([...overlay.requestedRoles]),
		resolvedCanonicalIds: Object.freeze([...overlay.resolvedCanonicalIds]),
		resolvedEfforts: Object.freeze([...overlay.resolvedEfforts]),
		fallbackChain: Object.freeze([...overlay.fallbackChain]),
		activeIndex: overlay.activeIndex,
		skips: Object.freeze(overlay.skips.map(copyOverlaySkip)),
		...(overlay.scope === undefined ? {} : { scope: overlay.scope }),
		...(overlay.timing === undefined ? {} : { timing: copyOverlayTiming(overlay.timing) }),
		...(overlay.confirmation === undefined ? {} : { confirmation: copyOverlayConfirmation(overlay.confirmation) }),
		...(overlay.usability === undefined ? {} : { usability: copyOverlayUsability(overlay.usability) }),
		receiptRefs: Object.freeze([...overlay.receiptRefs]),
		...(overlay.workMode === undefined
			? {}
			: { workMode: Object.freeze({ id: overlay.workMode.id, fingerprint: overlay.workMode.fingerprint }) }),
	});
}

export type Q10ThinkingEffort = Effort;
export type Q10SettableThinkingLevel = typeof ThinkingLevel.Off | Q10ThinkingEffort;
export type Q10CurrentThinkingLevel = Q10SettableThinkingLevel | typeof ThinkingLevel.Inherit;
export type Q10ThinkingMode = ThinkingControlMode;

export interface Q10ThinkingCapabilities {
	validLevels: readonly Q10SettableThinkingLevel[];
	minLevel?: Q10ThinkingEffort;
	maxLevel?: Q10ThinkingEffort;
	mode?: Q10ThinkingMode;
	defaultLevel?: Q10ThinkingEffort;
	/** Fresh raw explicit descriptor copy; source order retained. */
	levels?: readonly Q10ThinkingEffort[];
}

export interface Q10Model {
	provider: string;
	id: string;
	name: string;
	contextWindow: number;
	maxTokens: number;
	reasoning: boolean;
	thinking: Q10ThinkingCapabilities;
	current: boolean;
	currentThinkingLevel?: Q10CurrentThinkingLevel;
}

export type Q10ThinkingMetadataReason =
	| "missing_thinking"
	| "unknown_min_level"
	| "unknown_max_level"
	| "inverted_range"
	| "unknown_mode"
	| "empty_levels"
	| "unknown_level"
	| "level_out_of_range"
	| "lower_bound_mismatch"
	| "upper_bound_mismatch"
	| "supported_membership_mismatch"
	| "empty_supported_levels"
	| "unknown_default_level"
	| "default_not_supported";

/** An intentionally safe error for malformed model thinking metadata. */
export class Q10ThinkingMetadataError extends Error {
	readonly code = "internal";

	constructor(
		provider: string,
		id: string,
		readonly reason: Q10ThinkingMetadataReason,
	) {
		super(`Invalid thinking metadata for ${provider}/${id}: ${reason}`);
		this.name = "Q10ThinkingMetadataError";
	}
}

export interface Q10ModelProjectionInput {
	models: readonly Model<Api>[];
	currentModel?: Model<Api>;
	currentThinkingLevel?: Q10CurrentThinkingLevel;
	resolveSupportedEfforts?: (model: Model<Api>) => readonly Effort[];
}

/**
 * Projects model registry entries into the Q10 public DTO without exposing
 * transport, credentials, pricing, or other registry internals.
 */
export function projectQ10Models(input: Q10ModelProjectionInput): Q10Model[] {
	return input.models.map(model => {
		const current = input.currentModel?.provider === model.provider && input.currentModel.id === model.id;
		const base: Q10Model = {
			provider: model.provider,
			id: model.id,
			name: model.name,
			contextWindow: model.contextWindow,
			maxTokens: model.maxTokens,
			reasoning: model.reasoning,
			thinking: { validLevels: [ThinkingLevel.Off] },
			current,
			...(current && input.currentThinkingLevel !== undefined
				? { currentThinkingLevel: input.currentThinkingLevel }
				: {}),
		};
		if (!model.reasoning) return base;

		return {
			...base,
			thinking: projectThinking(model, input.resolveSupportedEfforts ?? getSupportedEfforts),
		};
	});
}

function projectThinking(
	model: Model<Api>,
	resolveSupportedEfforts: (model: Model<Api>) => readonly Effort[],
): Q10ThinkingCapabilities {
	const descriptor = model.thinking;
	if (!descriptor) throw invalid(model, "missing_thinking");

	if (!isEffort(descriptor.minLevel)) throw invalid(model, "unknown_min_level");
	if (!isEffort(descriptor.maxLevel)) throw invalid(model, "unknown_max_level");
	const minimumIndex = THINKING_EFFORTS.indexOf(descriptor.minLevel);
	const maximumIndex = THINKING_EFFORTS.indexOf(descriptor.maxLevel);
	if (minimumIndex > maximumIndex) throw invalid(model, "inverted_range");
	if (!THINKING_CONTROL_MODES.includes(descriptor.mode)) throw invalid(model, "unknown_mode");

	const levels = descriptor.levels;
	if (levels !== undefined) {
		if (levels.length === 0) throw invalid(model, "empty_levels");
		for (const level of levels) {
			if (!isEffort(level)) throw invalid(model, "unknown_level");
			const levelIndex = THINKING_EFFORTS.indexOf(level);
			if (levelIndex < minimumIndex || levelIndex > maximumIndex) throw invalid(model, "level_out_of_range");
		}
	}
	if (descriptor.defaultLevel !== undefined && !isEffort(descriptor.defaultLevel))
		throw invalid(model, "unknown_default_level");

	const supported = new Set<Effort>();
	for (const level of resolveSupportedEfforts(model)) {
		if (!isEffort(level)) throw invalid(model, "unknown_level");
		supported.add(level);
	}
	const canonicalSupported = THINKING_EFFORTS.filter(level => supported.has(level));
	if (canonicalSupported.length === 0) throw invalid(model, "empty_supported_levels");
	if (descriptor.defaultLevel !== undefined && !supported.has(descriptor.defaultLevel))
		throw invalid(model, "default_not_supported");

	if (levels !== undefined) {
		const explicit = new Set<Effort>(levels);
		const canonicalExplicit = THINKING_EFFORTS.filter(level => explicit.has(level));
		if (canonicalExplicit[0] !== descriptor.minLevel) throw invalid(model, "lower_bound_mismatch");
		if (canonicalExplicit.at(-1) !== descriptor.maxLevel) throw invalid(model, "upper_bound_mismatch");
		if (!sameMembership(explicit, supported)) throw invalid(model, "supported_membership_mismatch");
	}

	return {
		validLevels: [ThinkingLevel.Off, ...canonicalSupported],
		minLevel: descriptor.minLevel,
		maxLevel: descriptor.maxLevel,
		mode: descriptor.mode,
		...(descriptor.defaultLevel !== undefined ? { defaultLevel: descriptor.defaultLevel } : {}),
		...(levels !== undefined ? { levels: [...levels] } : {}),
	};
}

function invalid(model: Model<Api>, reason: Q10ThinkingMetadataReason): Q10ThinkingMetadataError {
	return new Q10ThinkingMetadataError(model.provider, model.id, reason);
}

function isEffort(value: unknown): value is Effort {
	return (THINKING_EFFORTS as readonly unknown[]).includes(value);
}
function sameMembership(left: ReadonlySet<Effort>, right: ReadonlySet<Effort>): boolean {
	return left.size === right.size && [...left].every(level => right.has(level));
}
