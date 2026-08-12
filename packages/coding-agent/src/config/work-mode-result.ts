import { createHash } from "node:crypto";
import type { ModelProfileDefinition, ModelProfileRole } from "./model-profiles";
import type { ModelSelectorValue } from "./model-selector-value";
import type { ScopedConfigurationMutationReceipt } from "./scoped-configuration-mutation";
import type { CuratedWorkMode } from "./work-mode-catalog";
import type { WorkModeExecutionCaseMap, WorkModeTurnFinalizeCaseMap } from "./work-mode-execution-cases";

export type RoleId = Extract<ModelProfileRole, "default" | "executor" | "planner" | "critic" | "architect">;
export const WORK_MODE_ROLE_IDS: readonly RoleId[] = Object.freeze([
	"default",
	"executor",
	"planner",
	"critic",
	"architect",
]);

export type WorkModePhase = "preview" | "session_apply" | "persistent_apply" | "turn_stage" | "turn_admission";
export type WorkModeState = "ready" | "degraded" | "unavailable" | "drifted";
export type WorkModeExecutionPhase = Exclude<WorkModePhase, "preview">;
export type WorkModeEventPhase = WorkModeExecutionPhase | "turn_finalize";

export type WorkModeOperationFailureCode =
	| "unknown_work_mode"
	| "catalog_invalid"
	| "catalog_source_unavailable"
	| "curated_profile_missing"
	| "curated_profile_shadowed"
	| "curated_profile_malformed"
	| "curated_profile_mismatch"
	| "builtin_source_unavailable"
	| "model_profile_registry_unavailable"
	| "provider_readiness_unavailable"
	| "required_provider_unauthenticated"
	| "alternative_provider_group_unavailable"
	| "default_selector_unresolved"
	| "non_default_role_unresolved"
	| "preflight_unexpected"
	| "project_scope_unavailable"
	| "scope_locked"
	| "scope_conflict"
	| "persistent_write_failed"
	| "persistent_reload_unconfirmed"
	| "persistent_reload_mismatch"
	| "scope_rejected"
	| "session_activation_failed"
	| "session_rollback_failed"
	| "turn_stage_rejected"
	| "turn_activation_failed"
	| "turn_rollback_failed"
	| "turn_admission_cancelled"
	| "turn_admission_handoff_cancelled"
	| "turn_admission_setup_failed"
	| "turn_admission_disposed"
	| "operation_unexpected"
	| "preview_drift";

export type WorkModePreGateExitReason =
	| "turn_admission_cancelled"
	| "turn_admission_handoff_cancelled"
	| "turn_admission_disposed"
	| "turn_admission_setup_failed"
	| "preflight_unexpected";

export type WorkModeFingerprintFact =
	| "catalog"
	| "profile_identity"
	| "profile_definition"
	| "registry_resolution"
	| "provider_readiness"
	| "role_resolution"
	| "degradation"
	| "fallback"
	| "confirmation";

export type FingerprintFact<T, Missing extends string, Unavailable extends string> =
	| { readonly presence: "present"; readonly value: T }
	| { readonly presence: "missing"; readonly reason: Missing }
	| { readonly presence: "unavailable"; readonly reason: Unavailable };

export type CatalogFact = Readonly<{
	version: number;
	modeId: string;
	profileId: string;
	entryDigest: string;
}>;

export type DefinitionRoleMapping = Readonly<{
	readonly default: ModelSelectorValue | null;
	readonly executor: ModelSelectorValue | null;
	readonly planner: ModelSelectorValue | null;
	readonly critic: ModelSelectorValue | null;
	readonly architect: ModelSelectorValue | null;
}>;

export type DefinitionFact = Readonly<{
	profileId: string;
	source: "builtin" | "user";
	definitionDigest: string;
	requiredProviders: readonly string[];
	alternativeProviderGroups: readonly (readonly string[])[];
	modelMapping: DefinitionRoleMapping;
}>;

export type ResolutionSnapshot = Readonly<{
	registryRevision: string;
	resolutionRevision: string;
	resolutionDigest: string;
}>;

export type ReadinessFact = Readonly<{
	strictProviders: readonly { providerId: string; state: "ready" | "missing" }[];
	alternativeGroups: readonly {
		providerIds: readonly string[];
		state: "ready" | "missing";
		selectedProviderId: string | null;
	}[];
}>;

export type RoleResolutionFact = Readonly<{
	role: RoleId;
	requested: ModelSelectorValue | null;
	resolved: string | null;
	effort: string | null;
	state: "resolved" | "unresolved" | "not_configured";
}>;

export type FallbackFact = Readonly<{
	defaultChain: readonly string[];
	activeIndex: number | null;
	skips: readonly { selector: string; reason: string }[];
}>;

export type WorkModeRoleDegradation = Readonly<{
	role: Exclude<RoleId, "default">;
	reason: "role_not_configured" | "role_unresolved" | "role_resolution_unavailable";
}>;

export type WorkModeFingerprintPayloadV1 = Readonly<{
	schema: "work-mode-fingerprint.v1";
	catalog: FingerprintFact<CatalogFact, "unknown_work_mode" | "catalog_invalid", "catalog_source_unavailable">;
	bundledDefinition: FingerprintFact<DefinitionFact, "curated_profile_missing", "builtin_source_unavailable">;
	effectiveDefinition: FingerprintFact<
		DefinitionFact,
		"curated_profile_missing" | "curated_profile_shadowed" | "curated_profile_malformed" | "curated_profile_mismatch",
		"model_profile_registry_unavailable"
	>;
	registryResolution: FingerprintFact<ResolutionSnapshot, "not_resolved", "model_profile_registry_unavailable">;
	readiness: FingerprintFact<ReadinessFact, "not_evaluated", "provider_readiness_unavailable">;
	roles: readonly [
		FingerprintFact<RoleResolutionFact, "role_not_configured" | "role_unresolved", "role_resolution_unavailable">,
		FingerprintFact<RoleResolutionFact, "role_not_configured" | "role_unresolved", "role_resolution_unavailable">,
		FingerprintFact<RoleResolutionFact, "role_not_configured" | "role_unresolved", "role_resolution_unavailable">,
		FingerprintFact<RoleResolutionFact, "role_not_configured" | "role_unresolved", "role_resolution_unavailable">,
		FingerprintFact<RoleResolutionFact, "role_not_configured" | "role_unresolved", "role_resolution_unavailable">,
	];
	fallback: FingerprintFact<FallbackFact, "no_default_chain", "fallback_resolution_unavailable">;
	confirmation: Readonly<{ required: boolean; roleDegradation: readonly Exclude<RoleId, "default">[] }>;
}>;

export type WorkModeFingerprint = Readonly<{
	schema: "work-mode-fingerprint.v1";
	digest: string;
	payload: WorkModeFingerprintPayloadV1;
}>;

function deepFreeze<T>(value: T): T {
	if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
	if (Array.isArray(value)) {
		for (const child of value as readonly unknown[]) deepFreeze(child);
	} else {
		for (const child of Object.values(value as Readonly<Record<string, unknown>>)) deepFreeze(child);
	}
	return Object.freeze(value) as T;
}

export type WorkModeFingerprintInput =
	| WorkModeFingerprintPayloadV1
	| Readonly<{
			catalog: WorkModeFingerprintPayloadV1["catalog"];
			bundledDefinition: WorkModeFingerprintPayloadV1["bundledDefinition"];
			effectiveDefinition: WorkModeFingerprintPayloadV1["effectiveDefinition"];
			registryResolution: WorkModeFingerprintPayloadV1["registryResolution"];
			readiness: WorkModeFingerprintPayloadV1["readiness"];
			roles: WorkModeFingerprintPayloadV1["roles"];
			fallback: WorkModeFingerprintPayloadV1["fallback"];
			confirmation: WorkModeFingerprintPayloadV1["confirmation"];
	  }>;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeString(value: unknown): string {
	if (typeof value !== "string") return "";
	return value
		.normalize("NFKC")
		.replace(/[\u0000-\u001f\u007f\u007f]/gu, " ")
		.slice(0, 512);
}

function canonicalize(value: unknown): string {
	if (value === null) return "null";
	if (typeof value === "string") return JSON.stringify(safeString(value));
	if (typeof value === "boolean") return value ? "true" : "false";
	if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : "null";
	if (Array.isArray(value)) return `[${value.map(entry => canonicalize(entry)).join(",")}]`;
	if (!isRecord(value)) return "null";
	return `{${Object.keys(value)
		.sort((left, right) => left.localeCompare(right))
		.map(key => `${JSON.stringify(safeString(key))}:${canonicalize(value[key])}`)
		.join(",")}}`;
}

function roleMappingFromDefinition(definition: ModelProfileDefinition | undefined): DefinitionRoleMapping {
	const mapping = definition?.modelMapping ?? {};
	return {
		default: mapping.default ?? null,
		executor: mapping.executor ?? null,
		planner: mapping.planner ?? null,
		critic: mapping.critic ?? null,
		architect: mapping.architect ?? null,
	};
}

export function definitionFactFromProfile(
	definition: ModelProfileDefinition | undefined,
	profileId = definition?.name ?? "",
): DefinitionFact | undefined {
	if (!definition) return undefined;
	const shape = {
		profileId,
		source: definition.source,
		requiredProviders: [...new Set(definition.requiredProviders)].sort((left, right) => left.localeCompare(right)),
		alternativeProviderGroups: (definition.alternativeProviderGroups ?? []).map(group =>
			[...new Set(group)].sort((left, right) => left.localeCompare(right)),
		),
		modelMapping: roleMappingFromDefinition(definition),
	};
	return Object.freeze({
		...shape,
		definitionDigest: createHash("sha256").update(canonicalize(shape), "utf8").digest("hex"),
	});
}

export function presentFingerprintFact<T>(value: T): { readonly presence: "present"; readonly value: T } {
	return Object.freeze({ presence: "present", value });
}

export function missingFingerprintFact<Missing extends string>(
	reason: Missing,
): { readonly presence: "missing"; readonly reason: Missing } {
	return Object.freeze({ presence: "missing", reason });
}

export function unavailableFingerprintFact<Unavailable extends string>(
	reason: Unavailable,
): { readonly presence: "unavailable"; readonly reason: Unavailable } {
	return Object.freeze({ presence: "unavailable", reason });
}

function emptyRoleFact(
	role: RoleId,
): FingerprintFact<RoleResolutionFact, "role_not_configured" | "role_unresolved", "role_resolution_unavailable"> {
	return presentFingerprintFact({
		role,
		requested: null,
		resolved: null,
		effort: null,
		state: "not_configured",
	});
}

export function buildWorkModeRoleTuple<T>(factory: (index: number, role: RoleId) => T): readonly [T, T, T, T, T] {
	return [
		factory(0, WORK_MODE_ROLE_IDS[0]),
		factory(1, WORK_MODE_ROLE_IDS[1]),
		factory(2, WORK_MODE_ROLE_IDS[2]),
		factory(3, WORK_MODE_ROLE_IDS[3]),
		factory(4, WORK_MODE_ROLE_IDS[4]),
	];
}

function payloadFromInput(input: WorkModeFingerprintInput): WorkModeFingerprintPayloadV1 {
	const normalizedRoles =
		input.roles.length === WORK_MODE_ROLE_IDS.length
			? [...input.roles].sort((left, right) => {
					const leftRole =
						left.presence === "present" ? WORK_MODE_ROLE_IDS.indexOf(left.value.role) : Number.MAX_SAFE_INTEGER;
					const rightRole =
						right.presence === "present" ? WORK_MODE_ROLE_IDS.indexOf(right.value.role) : Number.MAX_SAFE_INTEGER;
					return leftRole - rightRole;
				})
			: [...input.roles, ...WORK_MODE_ROLE_IDS.slice(input.roles.length).map(role => emptyRoleFact(role))].slice(
					0,
					WORK_MODE_ROLE_IDS.length,
				);
	const roles = buildWorkModeRoleTuple((index, role) => normalizedRoles[index] ?? emptyRoleFact(role));
	return {
		schema: "work-mode-fingerprint.v1",
		catalog: input.catalog,
		bundledDefinition: input.bundledDefinition,
		effectiveDefinition: input.effectiveDefinition,
		registryResolution: input.registryResolution,
		readiness: input.readiness,
		roles,
		fallback: input.fallback,
		confirmation: {
			required: input.confirmation.required,
			roleDegradation: [...new Set(input.confirmation.roleDegradation)].sort((left, right) =>
				left.localeCompare(right),
			),
		},
	};
}

export function computeWorkModeFingerprint(input: WorkModeFingerprintInput): WorkModeFingerprint {
	const payload = payloadFromInput(input);
	const serialized = canonicalize(payload);
	const digest = createHash("sha256").update(serialized, "utf8").digest("hex");
	return Object.freeze({ schema: "work-mode-fingerprint.v1", digest, payload: deepFreeze(payload) });
}

function identityValue(value: FingerprintFact<DefinitionFact, string, string>): unknown {
	if (value.presence !== "present") return value;
	return {
		presence: value.presence,
		profileId: value.value.profileId,
		source: value.value.source,
	};
}

function groupValue(payload: WorkModeFingerprintPayloadV1, group: WorkModeFingerprintFact): unknown {
	switch (group) {
		case "catalog":
			return payload.catalog;
		case "profile_identity":
			return {
				bundled: identityValue(payload.bundledDefinition),
				effective: identityValue(payload.effectiveDefinition),
			};
		case "profile_definition":
			return {
				bundled: payload.bundledDefinition,
				effective: payload.effectiveDefinition,
			};
		case "registry_resolution":
			return payload.registryResolution;
		case "provider_readiness":
			return payload.readiness;
		case "role_resolution":
			return payload.roles;
		case "degradation":
			return payload.confirmation.roleDegradation;
		case "fallback":
			return payload.fallback;
		case "confirmation":
			return { required: payload.confirmation.required };
	}
}

export function compareWorkModeFingerprints(
	accepted: WorkModeFingerprint,
	observed: WorkModeFingerprint,
):
	| { readonly equal: true }
	| {
			readonly equal: false;
			readonly changedFacts: readonly [WorkModeFingerprintFact, ...WorkModeFingerprintFact[]];
	  } {
	const groups: readonly WorkModeFingerprintFact[] = [
		"catalog",
		"profile_identity",
		"profile_definition",
		"registry_resolution",
		"provider_readiness",
		"role_resolution",
		"degradation",
		"fallback",
		"confirmation",
	];
	const changed = groups.filter(
		group => canonicalize(groupValue(accepted.payload, group)) !== canonicalize(groupValue(observed.payload, group)),
	);
	if (changed.length === 0 && accepted.digest === observed.digest) return { equal: true };
	const normalized = (changed.length > 0 ? changed : ["profile_definition"]) as [
		WorkModeFingerprintFact,
		...WorkModeFingerprintFact[],
	];
	return { equal: false, changedFacts: normalized };
}

export type WorkModeFingerprintRelation =
	| { readonly kind: "equal"; readonly accepted: WorkModeFingerprint; readonly observed: WorkModeFingerprint }
	| {
			readonly kind: "changed";
			readonly accepted: WorkModeFingerprint;
			readonly observed: WorkModeFingerprint;
			readonly changedFacts: readonly [WorkModeFingerprintFact, ...WorkModeFingerprintFact[]];
	  }
	| {
			readonly kind: "not_observed";
			readonly accepted: WorkModeFingerprint;
			readonly reason: WorkModePreGateExitReason;
	  };

export function relateWorkModeFingerprints(
	accepted: WorkModeFingerprint,
	observed: WorkModeFingerprint | undefined,
	reason?: WorkModePreGateExitReason,
): WorkModeFingerprintRelation {
	if (!observed) {
		return { kind: "not_observed", accepted, reason: reason ?? "preflight_unexpected" };
	}
	const comparison = compareWorkModeFingerprints(accepted, observed);
	return comparison.equal
		? { kind: "equal", accepted, observed }
		: { kind: "changed", accepted, observed, changedFacts: comparison.changedFacts };
}

export type WorkModeRoleReadiness =
	| { readonly kind: "complete"; readonly confirmation: "not_required" }
	| {
			readonly kind: "degraded";
			readonly unresolved: readonly WorkModeRoleDegradation[];
			readonly confirmation: "accepted";
	  };

export type DurableMutationStatus =
	| { readonly kind: "not_requested" }
	| { readonly kind: "committed"; readonly scopedReceipt: ScopedConfigurationMutationReceipt }
	| {
			readonly kind: "committed_unconfirmed";
			readonly code: "persistent_reload_unconfirmed" | "persistent_reload_mismatch";
			readonly scopedReceipt: ScopedConfigurationMutationReceipt;
	  }
	| { readonly kind: "conflict"; readonly scopedReceipt: ScopedConfigurationMutationReceipt }
	| { readonly kind: "locked"; readonly scopedReceipt: ScopedConfigurationMutationReceipt }
	| {
			readonly kind: "rejected";
			readonly code: WorkModeOperationFailureCode;
			readonly scopedReceipt?: ScopedConfigurationMutationReceipt;
	  };

export type RuntimeActivationStatus =
	| { readonly kind: "not_requested" }
	| { readonly kind: "staged" }
	| { readonly kind: "applied" }
	| { readonly kind: "admitted"; readonly turnLeaseId: string }
	| { readonly kind: "rejected"; readonly code: WorkModeOperationFailureCode }
	| { readonly kind: "cancelled"; readonly code: WorkModeOperationFailureCode }
	| { readonly kind: "restored" }
	| { readonly kind: "restore_failed"; readonly code: "turn_rollback_failed" };

export type WorkModeOperationReceipt = Readonly<{
	schema: "work-mode-receipt.v1";
	version: 1;
	receiptId: string;
	operationId: string;
	phase: WorkModeEventPhase;
	scope: "session" | "project" | "user" | "turn";
	acceptedFingerprint: WorkModeFingerprint;
	observedFingerprint?: WorkModeFingerprint;
	relation: WorkModeFingerprintRelation;
	roleReadiness: WorkModeRoleReadiness;
	confirmation: Readonly<{ required: boolean; accepted: boolean }>;
	durable: DurableMutationStatus;
	runtime: RuntimeActivationStatus;
	reason: WorkModeOperationFailureCode | null;
	timing: Readonly<{ startedAt: number; finishedAt: number }>;
	facts: Readonly<Record<string, string | number | boolean>>;
}>;

export type WorkModeSafeDetails = Readonly<{
	code: WorkModeOperationFailureCode;
	category: "catalog" | "profile" | "registry" | "readiness" | "scope" | "runtime" | "drift";
}>;

export type WorkModeFacts = Readonly<{
	mode: CuratedWorkMode;
	profileId: string;
	requestedRoleReadiness: WorkModeRoleReadiness;
}>;

export type WorkModeUnavailableReason = WorkModeOperationFailureCode;

export type WorkModePreviewResult =
	| Readonly<{
			phase: "preview";
			state: "ready";
			fingerprint: WorkModeFingerprint;
			facts: WorkModeFacts;
			roleReadiness: { readonly kind: "complete"; readonly confirmation: "not_required" };
			confirmationRequired: false;
	  }>
	| Readonly<{
			phase: "preview";
			state: "degraded";
			fingerprint: WorkModeFingerprint;
			facts: WorkModeFacts;
			roleReadiness: {
				readonly kind: "degraded";
				readonly unresolved: readonly WorkModeRoleDegradation[];
				readonly confirmation: "accepted";
			};
			confirmationRequired: true;
	  }>
	| Readonly<{
			phase: "preview";
			state: "unavailable";
			fingerprint: WorkModeFingerprint;
			reason: WorkModeUnavailableReason;
			details: WorkModeSafeDetails;
	  }>;

export type WorkModeExecutionResult = WorkModeExecutionCaseMap[keyof WorkModeExecutionCaseMap];
export type WorkModeTurnFinalizeEvent = WorkModeTurnFinalizeCaseMap[keyof WorkModeTurnFinalizeCaseMap];
export type WorkModeOperationEvent = WorkModePreviewResult | WorkModeExecutionResult | WorkModeTurnFinalizeEvent;

export function freezeWorkModeReceipt(receipt: WorkModeOperationReceipt): WorkModeOperationReceipt {
	return deepFreeze({ ...receipt, facts: { ...receipt.facts } });
}
