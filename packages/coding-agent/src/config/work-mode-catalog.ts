import type { ModelProfileDefinition } from "./model-profiles";
import { BUILTIN_MODEL_PROFILES } from "./model-profiles";

export const WORK_MODE_CATALOG_VERSION = 1 as const;

export const CURATED_WORK_MODES = Object.freeze([
	Object.freeze({
		id: "quick-edit",
		label: "Quick Edit",
		taskContext: "Short, constrained code changes.",
		searchTerms: Object.freeze(["quick", "edit", "constrained", "code"]),
		profileId: "codex-eco",
	}),
	Object.freeze({
		id: "daily-coding",
		label: "Daily Coding",
		taskContext: "General implementation and tests.",
		searchTerms: Object.freeze(["daily", "coding", "implementation", "tests"]),
		profileId: "codex-medium",
	}),
	Object.freeze({
		id: "deep-plan",
		label: "Deep Plan",
		taskContext: "Architecture and large-change planning.",
		searchTerms: Object.freeze(["deep", "plan", "architecture", "planning"]),
		profileId: "claude-opus",
	}),
	Object.freeze({
		id: "review",
		label: "Review",
		taskContext: "Read-heavy criticism and validation.",
		searchTerms: Object.freeze(["review", "criticism", "validation"]),
		profileId: "claude-fable",
	}),
	Object.freeze({
		id: "autonomous",
		label: "Autonomous",
		taskContext: "Multi-step implementation and verification under explicit user direction.",
		searchTerms: Object.freeze(["autonomous", "multi-step", "implementation", "verification"]),
		profileId: "lunamaxxing",
	}),
] as const);

export type CuratedWorkMode = (typeof CURATED_WORK_MODES)[number];
export type WorkModeId = CuratedWorkMode["id"];

export const WORK_MODE_IDS: readonly WorkModeId[] = Object.freeze(CURATED_WORK_MODES.map(mode => mode.id));

export type CuratedWorkModeProfileFailure =
	| "curated_profile_missing"
	| "curated_profile_shadowed"
	| "curated_profile_malformed"
	| "curated_profile_mismatch"
	| "builtin_source_unavailable"
	| "model_profile_registry_unavailable";

export interface CuratedWorkModeProfileValidation {
	readonly modeId: WorkModeId;
	readonly profileId: string;
	readonly available: boolean;
	readonly reason: CuratedWorkModeProfileFailure | null;
	readonly bundledDefinition: ModelProfileDefinition | undefined;
	readonly effectiveDefinition: ModelProfileDefinition | undefined;
}

function profileDefinitionShape(value: ModelProfileDefinition): string {
	const roles = ["default", "executor", "planner", "critic", "architect"] as const;
	const mapping = roles.map(role => {
		const selector = value.modelMapping[role];
		return [role, selector === undefined ? null : selector] as const;
	});
	const groups = (value.alternativeProviderGroups ?? []).map(group => [...group]);
	return JSON.stringify({
		name: value.name,
		requiredProviders: [...value.requiredProviders].sort((left, right) => left.localeCompare(right)),
		alternativeProviderGroups: groups,
		modelMapping: mapping,
		source: value.source,
	});
}

export function modelProfileDefinitionsEqual(left: ModelProfileDefinition, right: ModelProfileDefinition): boolean {
	return profileDefinitionShape(left) === profileDefinitionShape(right);
}

export function getCuratedWorkMode(modeId: string): CuratedWorkMode | undefined {
	return CURATED_WORK_MODES.find(mode => mode.id === modeId);
}

export function validateCuratedWorkModeProfile(
	modeOrId: CuratedWorkMode | WorkModeId | string,
	profiles: ReadonlyMap<string, ModelProfileDefinition>,
): CuratedWorkModeProfileValidation {
	const mode = typeof modeOrId === "string" ? getCuratedWorkMode(modeOrId) : modeOrId;
	if (!mode) {
		return {
			modeId: typeof modeOrId === "string" ? (modeOrId as WorkModeId) : modeOrId.id,
			profileId: "",
			available: false,
			reason: "curated_profile_missing",
			bundledDefinition: undefined,
			effectiveDefinition: undefined,
		};
	}

	const bundledDefinition = BUILTIN_MODEL_PROFILES.find(profile => profile.name === mode.profileId);
	if (!bundledDefinition) {
		return {
			modeId: mode.id,
			profileId: mode.profileId,
			available: false,
			reason: "builtin_source_unavailable",
			bundledDefinition: undefined,
			effectiveDefinition: undefined,
		};
	}

	const effectiveDefinition = profiles.get(mode.profileId);
	if (!effectiveDefinition) {
		return {
			modeId: mode.id,
			profileId: mode.profileId,
			available: false,
			reason: "curated_profile_missing",
			bundledDefinition,
			effectiveDefinition: undefined,
		};
	}
	if (effectiveDefinition.source !== "builtin") {
		return {
			modeId: mode.id,
			profileId: mode.profileId,
			available: false,
			reason: "curated_profile_shadowed",
			bundledDefinition,
			effectiveDefinition,
		};
	}
	const requiredProvidersValid =
		Array.isArray(effectiveDefinition.requiredProviders) &&
		effectiveDefinition.requiredProviders.every(provider => typeof provider === "string");
	const alternativeGroupsValid =
		effectiveDefinition.alternativeProviderGroups === undefined ||
		(Array.isArray(effectiveDefinition.alternativeProviderGroups) &&
			effectiveDefinition.alternativeProviderGroups.every(
				group => Array.isArray(group) && group.every(provider => typeof provider === "string"),
			));
	const mappingValid =
		effectiveDefinition.modelMapping !== null &&
		typeof effectiveDefinition.modelMapping === "object" &&
		(["default", "executor", "planner", "critic", "architect"] as const).every(role => {
			const selector = effectiveDefinition.modelMapping[role];
			return (
				selector === undefined ||
				typeof selector === "string" ||
				(Array.isArray(selector) && selector.every(item => typeof item === "string"))
			);
		});
	if (
		typeof effectiveDefinition.name !== "string" ||
		typeof effectiveDefinition.source !== "string" ||
		!requiredProvidersValid ||
		!alternativeGroupsValid ||
		!mappingValid
	) {
		return {
			modeId: mode.id,
			profileId: mode.profileId,
			available: false,
			reason: "curated_profile_malformed",
			bundledDefinition,
			effectiveDefinition,
		};
	}
	if (!modelProfileDefinitionsEqual(effectiveDefinition, bundledDefinition)) {
		return {
			modeId: mode.id,
			profileId: mode.profileId,
			available: false,
			reason: "curated_profile_mismatch",
			bundledDefinition,
			effectiveDefinition,
		};
	}
	return {
		modeId: mode.id,
		profileId: mode.profileId,
		available: true,
		reason: null,
		bundledDefinition,
		effectiveDefinition,
	};
}
