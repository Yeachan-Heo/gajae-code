import { ThinkingLevel } from "@gajae-code/agent-core";
import {
	type Api,
	type Effort,
	getSupportedEfforts,
	type Model,
	THINKING_CONTROL_MODES,
	THINKING_EFFORTS,
	type ThinkingControlMode,
	UNK_CONTEXT_WINDOW,
	UNK_MAX_TOKENS,
} from "@gajae-code/ai/core";
import { formatModelProfileDisplayLabel, type ModelProfileDefinition } from "../config/model-profiles";
import { SYNTHETIC_PROVIDER_ID } from "./model-profile-model";

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
	/**
	 * Logical model-profile facade inputs. When supplied, deterministic,
	 * availability-filtered synthetic rows (`gajae-code/<profile>`) are
	 * appended after the real rows; the underlying `Model` registry entries
	 * are never touched.
	 */
	profiles?: ReadonlyMap<string, ModelProfileDefinition>;
	/** Profile ids whose providers are authenticated and therefore selectable. */
	availableProfileIds?: ReadonlySet<string>;
	/** Active in-session profile marker; its synthetic row is the logical current. */
	activeProfile?: string;
	/** Resolve a profile's default concrete model for display metadata. */
	resolveProfileDefaultModel?: (profile: ModelProfileDefinition) => Model<Api> | undefined;
}

/**
 * Projects model registry entries into the Q10 public DTO without exposing
 * transport, credentials, pricing, or other registry internals.
 */
export function projectQ10Models(input: Q10ModelProjectionInput): Q10Model[] {
	const profileActive = input.activeProfile !== undefined;
	const concrete = input.models.map(model => {
		const current =
			!profileActive && input.currentModel?.provider === model.provider && input.currentModel.id === model.id;
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
	const synthetic = projectSyntheticQ10Models(input);
	return synthetic.length === 0 ? concrete : [...concrete, ...synthetic];
}

/**
 * Project model profiles as logical synthetic model rows. Only profiles that
 * pass the authenticated-provider availability join (plus the active profile,
 * which remains visible as the current logical readback even when its
 * providers are no longer authenticated or the profile is absent from the
 * registry map) are included. An absent availability set fails closed: without
 * a verified join, non-current profiles are never advertised as selectable.
 * Rows are appended sorted by profile id so placement across paginated Q10
 * responses stays deterministic.
 */
function projectSyntheticQ10Models(input: Q10ModelProjectionInput): Q10Model[] {
	if (!input.profiles) return [];
	const rows: Q10Model[] = [];
	let activeRowEmitted = false;
	for (const [name, profile] of [...input.profiles.entries()].sort(([left], [right]) => left.localeCompare(right))) {
		const isActive = input.activeProfile === name;
		if (isActive) activeRowEmitted = true;
		// Fail closed on an unknown availability join: never advertise a
		// non-current profile as selectable without verified credentials.
		if (!isActive && input.availableProfileIds === undefined) continue;
		if (!isActive && input.availableProfileIds !== undefined && !input.availableProfileIds.has(name)) continue;
		const defaultModel = input.resolveProfileDefaultModel?.(profile);
		rows.push({
			provider: SYNTHETIC_PROVIDER_ID,
			id: name,
			name: formatModelProfileDisplayLabel(profile),
			contextWindow: defaultModel?.contextWindow ?? UNK_CONTEXT_WINDOW,
			maxTokens: defaultModel?.maxTokens ?? UNK_MAX_TOKENS,
			reasoning: false,
			thinking: { validLevels: [ThinkingLevel.Off] },
			current: isActive,
			...(isActive ? { currentThinkingLevel: ThinkingLevel.Inherit } : {}),
		});
	}
	// Bounded current readback for an active marker whose profile is absent
	// from the registry map (or whose availability is unknown): exactly one
	// current row must exist while the marker is set, so concrete current
	// suppression stays truthful.
	if (input.activeProfile !== undefined && !activeRowEmitted) {
		rows.push({
			provider: SYNTHETIC_PROVIDER_ID,
			id: input.activeProfile,
			name: input.activeProfile,
			contextWindow: UNK_CONTEXT_WINDOW,
			maxTokens: UNK_MAX_TOKENS,
			reasoning: false,
			thinking: { validLevels: [ThinkingLevel.Off] },
			current: true,
			currentThinkingLevel: ThinkingLevel.Inherit,
		});
	}
	return rows;
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
