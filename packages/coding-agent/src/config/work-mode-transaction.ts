import { createHash } from "node:crypto";
import type { ThinkingLevel } from "@gajae-code/agent-core";
import type { Api, Model } from "@gajae-code/ai";
import type { AgentSession, TemporaryProviderSessionScope } from "../session/agent-session";

import {
	applyPreparedModelProfileActivation,
	ModelProfileCredentialError,
	type PreparedModelProfileActivation,
	prepareModelProfileActivation,
} from "./model-profile-activation";
import { BUILTIN_MODEL_PROFILES, type ModelProfileDefinition, resolveProfileBindings } from "./model-profiles";
import type { ModelRegistry } from "./model-registry";
import { parseModelString } from "./model-resolver";
import type { ModelSelectorValue } from "./model-selector-value";
import type {
	ScopedConfigurationExpectedOwner,
	ScopedConfigurationMutationReceipt,
	ScopedConfigurationMutationService,
	ScopedConfigurationScope,
} from "./scoped-configuration-mutation";
import {
	type CuratedWorkMode,
	getCuratedWorkMode,
	validateCuratedWorkModeProfile,
	type WorkModeId,
} from "./work-mode-catalog";
import {
	buildWorkModeRoleTuple,
	type CatalogFact,
	computeWorkModeFingerprint,
	type DefinitionFact,
	definitionFactFromProfile,
	type FallbackFact,
	type FingerprintFact,
	freezeWorkModeReceipt,
	missingFingerprintFact,
	presentFingerprintFact,
	type ReadinessFact,
	type ResolutionSnapshot,
	type RoleResolutionFact,
	type RuntimeActivationStatus,
	relateWorkModeFingerprints,
	unavailableFingerprintFact,
	WORK_MODE_ROLE_IDS,
	type WorkModeExecutionResult,
	type WorkModeFacts,
	type WorkModeFingerprint,
	type WorkModeFingerprintRelation,
	type WorkModeOperationEvent,
	type WorkModeOperationFailureCode,
	type WorkModeOperationReceipt,
	type WorkModePreGateExitReason,
	type WorkModePreviewResult,
	type WorkModeRoleDegradation,
	type WorkModeRoleReadiness,
	type WorkModeTurnFinalizeEvent,
} from "./work-mode-result";

type WorkModeExecutionResultForPhase<Phase extends WorkModeExecutionResult["phase"]> = Extract<
	WorkModeExecutionResult,
	{ readonly phase: Phase }
>;
type WorkModeTurnStageResult = WorkModeExecutionResultForPhase<"turn_stage">;
type WorkModeTurnAdmissionResult = WorkModeExecutionResultForPhase<"turn_admission">;

function requireExecutionResult(event: WorkModeOperationEvent): WorkModeExecutionResult {
	if (event.phase === "preview" || event.phase === "turn_finalize")
		throw new Error("Unexpected Work Mode non-execution event.");
	return event;
}

function requireTurnStageResult(event: WorkModeOperationEvent): WorkModeTurnStageResult {
	if (event.phase !== "turn_stage") throw new Error("Unexpected Work Mode turn-stage event.");
	return event;
}

function requireTurnAdmissionResult(event: WorkModeOperationEvent): WorkModeTurnAdmissionResult {
	if (event.phase !== "turn_admission") throw new Error("Unexpected Work Mode turn-admission event.");
	return event;
}

function requireTurnFinalizeEvent(event: WorkModeOperationEvent): WorkModeTurnFinalizeEvent {
	if (event.phase !== "turn_finalize") throw new Error("Unexpected Work Mode turn-finalize event.");
	return event;
}

export interface WorkModeApplicationRequest {
	readonly operationId?: string;
	readonly modeId: WorkModeId;
	readonly acceptedPreview: WorkModePreviewResult;
	readonly scope: "session" | "project" | "user" | "turn";
	readonly confirmationAccepted?: boolean;
	readonly targetEligibleUserAdmissionGeneration?: number;
	readonly expectedOwner?: ScopedConfigurationExpectedOwner;
}

export type WorkModePreview = WorkModePreviewResult;

export interface WorkModeSessionRuntime {
	readonly sessionId: string;
	readonly model: Model<Api> | undefined;
	readonly thinkingLevel: ThinkingLevel | undefined;
	readonly setModelTemporary: AgentSession["setModelTemporary"];
	readonly beginTemporaryProviderSessionScope: AgentSession["beginTemporaryProviderSessionScope"];
	readonly restoreTemporaryProviderSessionScope: AgentSession["restoreTemporaryProviderSessionScope"];
	readonly setActiveModelProfile: AgentSession["setActiveModelProfile"];
	readonly getActiveModelProfile: AgentSession["getActiveModelProfile"];
	readonly getConfiguredModelChain: AgentSession["getConfiguredModelChain"];
	readonly setConfiguredModelChain: AgentSession["setConfiguredModelChain"];
	readonly getDefaultFallbackRuntimeSnapshot?: AgentSession["getDefaultFallbackRuntimeSnapshot"];
	readonly setDefaultFallbackRuntimeChain?: AgentSession["setDefaultFallbackRuntimeChain"];
	readonly restoreDefaultFallbackRuntimeSnapshot?: AgentSession["restoreDefaultFallbackRuntimeSnapshot"];
}

export interface WorkModeTransactionOptions {
	readonly session: WorkModeSessionRuntime;
	readonly modelRegistry: ModelRegistry;
	readonly settings: AgentSession["settings"];
	readonly scopedMutationService?: Pick<ScopedConfigurationMutationService, "mutate">;
	readonly now?: () => number;
	readonly operationId?: () => string;
	readonly receiptId?: () => string;
	readonly turnLeaseId?: () => string;
	readonly emit?: (event: WorkModeOperationEvent) => void;
}

export interface WorkModeStagedTurn {
	readonly operationId: string;
	readonly stageReceiptId: string;
	readonly modeId: WorkModeId;
	readonly profileId: string;
	readonly acceptedFingerprint: WorkModeFingerprint;
	readonly acceptedRoleReadiness: WorkModeRoleReadiness;
	readonly degradedConfirmation: boolean;
	readonly targetEligibleUserAdmissionGeneration: number;
}

type WorkModeAdmissionLifecycle =
	| {
			readonly state: "staged";
			readonly staged: WorkModeStagedTurn;
	  }
	| {
			readonly state: "claimed";
			readonly staged: WorkModeStagedTurn;
			readonly tokenId: string;
	  }
	| {
			readonly state: "admitted";
			readonly staged: WorkModeStagedTurn;
			readonly tokenId: string;
			readonly event: WorkModeTurnAdmissionResult;
			readonly lease: TurnWorkModeActivationLease;
	  }
	| {
			readonly state: "settled";
			readonly staged: WorkModeStagedTurn;
			readonly tokenId: string;
			readonly event: WorkModeTurnAdmissionResult;
	  };

export interface TopLevelUserAdmissionToken {
	readonly tokenId: string;
	readonly operationId: string;
	readonly targetEligibleUserAdmissionGeneration: number;
}

interface PreflightSnapshot {
	readonly mode: CuratedWorkMode | undefined;
	readonly facts: WorkModeFacts | undefined;
	readonly fingerprint: WorkModeFingerprint;
	readonly roleReadiness: WorkModeRoleReadiness;
	readonly prepared: PreparedModelProfileActivation | undefined;
	readonly reason: WorkModeOperationFailureCode | null;
}

interface PartialActivationSnapshot {
	readonly activeProfile: string | undefined;
	readonly modelRolesOverride: Readonly<Record<string, ModelSelectorValue>> | undefined;
	readonly agentModelOverridesOverride: Readonly<Record<string, ModelSelectorValue>> | undefined;
}

export type PartialActivationCheckpoint =
	| "none"
	| "provider_scope_opened"
	| "target_model_mutated"
	| "fallback_overlay_installed"
	| "role_overlays_applied"
	| "active_profile_set"
	| "setup_verified";

export type PartialActivationState =
	| "initializing"
	| "setup_complete"
	| "transferred"
	| "cleaning"
	| "cleaned"
	| "cleanup_failed";

export class PartialTurnWorkModeActivation {
	readonly partialActivationId: string;
	readonly operationId: string;
	readonly acceptedFingerprint: WorkModeFingerprint;
	readonly observedFingerprint: WorkModeFingerprint;
	readonly #session: WorkModeSessionRuntime;
	readonly #settings: AgentSession["settings"];
	readonly #scope: TemporaryProviderSessionScope;
	readonly #snapshot: PartialActivationSnapshot;
	#checkpoint: PartialActivationCheckpoint = "provider_scope_opened";
	#state: PartialActivationState = "initializing";
	#cleanupPromise: Promise<boolean> | undefined;
	#setupPromise: Promise<void> | undefined;
	#cancellationRequested = false;
	#transferred = false;

	constructor(options: {
		readonly partialActivationId: string;
		readonly operationId: string;
		readonly acceptedFingerprint: WorkModeFingerprint;
		readonly observedFingerprint: WorkModeFingerprint;
		readonly session: WorkModeSessionRuntime;
		readonly settings: AgentSession["settings"];
	}) {
		this.partialActivationId = options.partialActivationId;
		this.operationId = options.operationId;
		this.acceptedFingerprint = options.acceptedFingerprint;
		this.observedFingerprint = options.observedFingerprint;
		this.#session = options.session;
		this.#settings = options.settings;
		this.#snapshot = {
			activeProfile: options.session.getActiveModelProfile(),
			modelRolesOverride: options.settings.getOverride("modelRoles"),
			agentModelOverridesOverride: options.settings.getOverride("task.agentModelOverrides"),
		};

		this.#scope = options.session.beginTemporaryProviderSessionScope("work-mode-turn");
	}

	get checkpoint(): PartialActivationCheckpoint {
		return this.#checkpoint;
	}

	get state(): PartialActivationState {
		return this.#state;
	}

	get transferred(): boolean {
		return this.#transferred;
	}
	requestCancellation(): void {
		this.#cancellationRequested = true;
	}

	setup(prepared: PreparedModelProfileActivation): Promise<void> {
		if (this.#setupPromise) return this.#setupPromise;
		if (this.#state !== "initializing") return Promise.resolve();
		this.#setupPromise = this.#setupOnce(prepared);
		return this.#setupPromise;
	}

	async #setupOnce(prepared: PreparedModelProfileActivation): Promise<void> {
		if (this.#cancellationRequested) return;
		if (!prepared.defaultModel) throw new Error("target model unavailable");
		if (this.#cancellationRequested) return;
		await this.#session.setModelTemporary(prepared.defaultModel, prepared.defaultThinkingLevel, {
			cause: "temporary-operation",
			reason: "work-mode-turn",
			providerSessionScope: this.#scope,
			persistAsSessionDefault: false,
		});
		this.#checkpoint = "target_model_mutated";
		if (this.#cancellationRequested) return;
		if (prepared.defaultChain.length > 0 && this.#session.setDefaultFallbackRuntimeChain) {
			if (this.#cancellationRequested) return;
			this.#session.setDefaultFallbackRuntimeChain(
				prepared.defaultChain,
				prepared.defaultActiveIndex ?? 0,
				prepared.defaultResolutionSkips,
			);
			this.#checkpoint = "fallback_overlay_installed";
		}
		if (this.#cancellationRequested) return;
		this.#settings.override("modelRoles", {
			...(this.#snapshot.modelRolesOverride ?? {}),
			...prepared.modelRoles,
		});
		this.#checkpoint = "role_overlays_applied";
		if (this.#cancellationRequested) return;
		this.#settings.override("task.agentModelOverrides", {
			...(this.#snapshot.agentModelOverridesOverride ?? {}),
			...prepared.agentModelOverrides,
		});
		this.#checkpoint = "role_overlays_applied";
		if (this.#cancellationRequested) return;
		this.#session.setActiveModelProfile(prepared.profileName);
		this.#checkpoint = "active_profile_set";
		if (this.#cancellationRequested) return;
		this.#checkpoint = "setup_verified";
		if (this.#cancellationRequested) return;
		this.#state = "setup_complete";
	}

	async cleanup(): Promise<boolean> {
		if (this.#cleanupPromise) return await this.#cleanupPromise;
		if (this.#transferred) return false;
		this.requestCancellation();
		this.#cleanupPromise = this.#cleanupOnce();
		return await this.#cleanupPromise;
	}

	markTransferred(): void {
		if (this.#state !== "setup_complete" || this.#cleanupPromise)
			throw new Error("partial activation is not promotable");
		this.#transferred = true;
		this.#state = "transferred";
	}

	async restoreIntoSession(): Promise<boolean> {
		if (this.#cleanupPromise) return await this.#cleanupPromise;
		this.#transferred = false;
		return await this.cleanup();
	}

	async #cleanupOnce(): Promise<boolean> {
		this.#state = "cleaning";
		if (this.#setupPromise) {
			try {
				await this.#setupPromise;
			} catch {
				// Setup failures are reported by the admission rail; cleanup still restores every journaled mutation.
			}
		}
		let restoreFailed = false;
		if (
			this.#checkpoint === "target_model_mutated" ||
			this.#checkpoint === "fallback_overlay_installed" ||
			this.#checkpoint === "role_overlays_applied" ||
			this.#checkpoint === "active_profile_set" ||
			this.#checkpoint === "setup_verified"
		) {
			try {
				this.#settings.clearOverride("modelRoles");
				if (this.#snapshot.modelRolesOverride !== undefined) {
					this.#settings.override("modelRoles", this.#snapshot.modelRolesOverride);
				}
			} catch {
				restoreFailed = true;
			}
			try {
				this.#settings.clearOverride("task.agentModelOverrides");
				if (this.#snapshot.agentModelOverridesOverride !== undefined) {
					this.#settings.override("task.agentModelOverrides", this.#snapshot.agentModelOverridesOverride);
				}
			} catch {
				restoreFailed = true;
			}
		}
		if (
			this.#checkpoint === "role_overlays_applied" ||
			this.#checkpoint === "active_profile_set" ||
			this.#checkpoint === "setup_verified"
		) {
			try {
				this.#session.setActiveModelProfile(this.#snapshot.activeProfile);
			} catch {
				restoreFailed = true;
			}
		}
		let scopeRestored = false;
		try {
			scopeRestored = this.#session.restoreTemporaryProviderSessionScope(this.#scope);
		} catch {
			restoreFailed = true;
		}
		if (!scopeRestored) restoreFailed = true;
		if (restoreFailed) {
			this.#state = "cleanup_failed";
			return false;
		}
		this.#state = "cleaned";
		return true;
	}
}

export interface WorkModeTurnLeaseLineage {
	readonly operationId: string;
	readonly stageReceiptId: string;
	readonly admissionReceiptId: string;
	readonly turnLeaseId: string;
	readonly rootLogicalRunId: string;
	readonly rootAdmissionGeneration: number;
	readonly continuationEpoch: number;
}

export class TurnWorkModeActivationLease {
	readonly turnLeaseId: string;
	readonly operationId: string;
	readonly acceptedFingerprint: WorkModeFingerprint;
	readonly admittedFingerprint: WorkModeFingerprint;
	readonly admissionReceiptId: string;
	readonly stageReceiptId: string;
	readonly rootLogicalRunId: string;
	readonly rootAdmissionGeneration: number;
	readonly continuationEpoch: number;
	readonly #partial: PartialTurnWorkModeActivation;
	#state: "admitted" | "finalizing" | "finalized" | "finalize_failed" = "admitted";

	#finalizePromise: Promise<WorkModeTurnFinalizeEvent> | undefined;

	constructor(options: {
		readonly turnLeaseId: string;
		readonly operationId: string;
		readonly acceptedFingerprint: WorkModeFingerprint;
		readonly admittedFingerprint: WorkModeFingerprint;
		readonly admissionReceiptId: string;
		readonly stageReceiptId: string;
		readonly partial: PartialTurnWorkModeActivation;
		readonly rootLogicalRunId: string;
		readonly rootAdmissionGeneration: number;
		readonly continuationEpoch: number;
	}) {
		this.turnLeaseId = options.turnLeaseId;
		this.operationId = options.operationId;
		this.acceptedFingerprint = options.acceptedFingerprint;
		this.admittedFingerprint = options.admittedFingerprint;
		this.admissionReceiptId = options.admissionReceiptId;
		this.stageReceiptId = options.stageReceiptId;
		this.#partial = options.partial;
		this.rootLogicalRunId = options.rootLogicalRunId;
		this.rootAdmissionGeneration = options.rootAdmissionGeneration;
		this.continuationEpoch = options.continuationEpoch;
	}

	get state(): "admitted" | "finalizing" | "finalized" | "finalize_failed" {
		return this.#state;
	}

	get lineage(): WorkModeTurnLeaseLineage {
		return Object.freeze({
			operationId: this.operationId,
			stageReceiptId: this.stageReceiptId,
			admissionReceiptId: this.admissionReceiptId,
			turnLeaseId: this.turnLeaseId,
			rootLogicalRunId: this.rootLogicalRunId,
			rootAdmissionGeneration: this.rootAdmissionGeneration,
			continuationEpoch: this.continuationEpoch,
		});
	}

	async finalize(
		reason: "completed" | "error" | "aborted" | "cancelled" | "handoff" | "disposed",
		options: {
			readonly receiptId: string;
			readonly now: () => number;
			readonly emit?: (event: WorkModeOperationEvent) => void;
		},
	): Promise<WorkModeTurnFinalizeEvent> {
		if (this.#finalizePromise) return await this.#finalizePromise;
		this.#finalizePromise = this.#finalizeOnce(reason, options);
		return await this.#finalizePromise;
	}

	async #finalizeOnce(
		reason: "completed" | "error" | "aborted" | "cancelled" | "handoff" | "disposed",
		options: {
			readonly receiptId: string;
			readonly now: () => number;
			readonly emit?: (event: WorkModeOperationEvent) => void;
		},
	): Promise<WorkModeTurnFinalizeEvent> {
		this.#state = "finalizing";
		const startedAt = options.now();
		const restored = await this.#partial.restoreIntoSession();
		const caseId: "turn_finalize.degraded" | "turn_finalize.ready" | "turn_finalize.unavailable.restore_failed" =
			restored
				? this.admittedFingerprint.payload.confirmation.required
					? "turn_finalize.degraded"
					: "turn_finalize.ready"
				: "turn_finalize.unavailable.restore_failed";
		const state: "ready" | "degraded" | "unavailable" = restored
			? this.admittedFingerprint.payload.confirmation.required
				? "degraded"
				: "ready"
			: "unavailable";
		const runtime: RuntimeActivationStatus = restored
			? { kind: "restored" }
			: { kind: "restore_failed", code: "turn_rollback_failed" };
		const receipt = freezeWorkModeReceipt({
			schema: "work-mode-receipt.v1",
			version: 1,
			receiptId: options.receiptId,
			operationId: this.operationId,
			phase: "turn_finalize",
			scope: "turn",
			acceptedFingerprint: this.acceptedFingerprint,
			observedFingerprint: this.admittedFingerprint,
			relation: relateWorkModeFingerprints(this.acceptedFingerprint, this.admittedFingerprint),
			roleReadiness: this.admittedFingerprint.payload.confirmation.required
				? { kind: "degraded", unresolved: [], confirmation: "accepted" }
				: { kind: "complete", confirmation: "not_required" },
			confirmation: { required: this.admittedFingerprint.payload.confirmation.required, accepted: true },
			durable: { kind: "not_requested" },
			runtime,
			reason: restored ? null : "turn_rollback_failed",
			timing: { startedAt, finishedAt: options.now() },
			facts: { finalReason: reason },
		});
		const event = {
			caseId,
			phase: "turn_finalize",
			state,
			operationId: this.operationId,
			acceptedFingerprint: this.acceptedFingerprint,
			observedFingerprint: this.admittedFingerprint,
			activationOwner: "admitted_lease",
			relation: receipt.relation,
			roleReadiness: receipt.roleReadiness,
			confirmation: receipt.confirmation,
			durable: receipt.durable,
			runtime,
			receipt,
			admissionReceiptId: this.admissionReceiptId,
			turnLeaseId: this.turnLeaseId,
			admittedFingerprint: this.admittedFingerprint,
			finalReason: reason,
			finalizationReceiptId: options.receiptId,
		} as WorkModeOperationEvent;
		this.#state = restored ? "finalized" : "finalize_failed";
		emitSafely(options.emit, event);
		return requireTurnFinalizeEvent(event);
	}
}

function scopedReasonCode(reason: string | null): WorkModeOperationFailureCode {
	switch (reason) {
		case "project_scope_unavailable":
		case "scope_locked":
		case "scope_conflict":
		case "persistent_write_failed":
		case "persistent_reload_unconfirmed":
		case "persistent_reload_mismatch":
		case "scope_rejected":
			return reason;
		default:
			return "persistent_write_failed";
	}
}

function unavailableReasonForPhase(
	phase: "session_apply" | "turn_stage" | "persistent_apply",
	reason: WorkModeOperationFailureCode,
): WorkModeOperationFailureCode {
	if (phase === "session_apply")
		return reason === "session_activation_failed" || reason === "session_rollback_failed"
			? reason
			: "session_activation_failed";
	if (phase === "turn_stage")
		return reason === "turn_stage_rejected" || reason === "operation_unexpected" ? reason : "turn_stage_rejected";
	return reason === "project_scope_unavailable" ||
		reason === "scope_locked" ||
		reason === "scope_conflict" ||
		reason === "persistent_write_failed" ||
		reason === "scope_rejected"
		? reason
		: "persistent_write_failed";
}

function confirmationAcceptedFor(roleReadiness: WorkModeRoleReadiness, requested: boolean | undefined): boolean {
	return roleReadiness.kind !== "degraded" || requested === true;
}

function emitSafely(emit: ((event: WorkModeOperationEvent) => void) | undefined, event: WorkModeOperationEvent): void {
	try {
		emit?.(event);
	} catch {
		// Event sinks are observational and cannot change lifecycle ownership.
	}
}

function safeOperationId(factory: (() => string) | undefined): string {
	return factory?.() ?? `work-mode-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function safeReceiptId(factory: (() => string) | undefined): string {
	return factory?.() ?? `work-mode-receipt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function safeLeaseId(factory: (() => string) | undefined): string {
	return factory?.() ?? `work-mode-lease-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function errorReason(error: unknown, fallback: WorkModeOperationFailureCode): WorkModeOperationFailureCode {
	if (error instanceof ModelProfileCredentialError) {
		return error.unsatisfiedAlternativeGroups.length > 0
			? "alternative_provider_group_unavailable"
			: "required_provider_unauthenticated";
	}
	if (error && typeof error === "object" && "code" in error) {
		const code = (error as { readonly code?: unknown }).code;
		if (code === "unknown_model_profile") return "curated_profile_missing";
		if (code === "model_profile_registry_error") return "model_profile_registry_unavailable";
	}
	if (error instanceof Error) {
		if (error.message.includes("default selector") || error.message.includes("default selectors"))
			return "default_selector_unresolved";
		if (error.message.includes("did not resolve")) return "non_default_role_unresolved";
	}
	return fallback;
}

function profileDefinitionMap(registry: ModelRegistry): ReadonlyMap<string, ModelProfileDefinition> {
	return registry.getModelProfiles();
}

function roleReadinessFromPrepared(
	definition: ModelProfileDefinition,
	prepared: PreparedModelProfileActivation,
	registry: ModelRegistry,
): { readonly roleReadiness: WorkModeRoleReadiness; readonly roles: readonly RoleResolutionFact[] } {
	const bindings = resolveProfileBindings(definition);
	const unresolved: WorkModeRoleDegradation[] = [];
	const roles: RoleResolutionFact[] = [];
	const available = registry.getAll();
	for (const role of WORK_MODE_ROLE_IDS) {
		const requested =
			role === "default" ? (bindings.defaultSelector ?? null) : (bindings.agentModelOverrides[role] ?? null);
		const resolvedValue = role === "default" ? prepared.defaultModel : prepared.agentModelOverrides[role];
		const selectorValue = role === "default" ? requested : resolvedValue;
		const selectors =
			typeof selectorValue === "string" ? [selectorValue] : Array.isArray(selectorValue) ? [...selectorValue] : [];
		const parsedSelectors = selectors.map(selector => parseModelString(selector));
		const resolvedModel =
			role === "default"
				? prepared.defaultModel
				: parsedSelectors
						.map(parsed =>
							parsed
								? available.find(model => model.provider === parsed.provider && model.id === parsed.id)
								: undefined,
						)
						.find(model => model !== undefined);
		const parsed = parsedSelectors.find(
			candidate =>
				candidate !== undefined &&
				resolvedModel &&
				candidate.provider === resolvedModel.provider &&
				candidate.id === resolvedModel.id,
		);
		const resolved = resolvedModel ? `${resolvedModel.provider}/${resolvedModel.id}` : null;
		if (role !== "default" && requested === null) unresolved.push({ role, reason: "role_not_configured" });
		else if (role !== "default" && resolved === null) unresolved.push({ role, reason: "role_unresolved" });
		roles.push({
			role,
			requested,
			resolved,
			effort: parsed?.thinkingLevel ?? null,
			state: requested === null ? "not_configured" : resolved === null ? "unresolved" : "resolved",
		});
	}
	return unresolved.length === 0
		? { roleReadiness: { kind: "complete", confirmation: "not_required" }, roles }
		: { roleReadiness: { kind: "degraded", unresolved, confirmation: "accepted" }, roles };
}

function definitionFactOrMissing(
	definition: ModelProfileDefinition | undefined,
	profileId: string,
): FingerprintFact<DefinitionFact, "curated_profile_missing", "builtin_source_unavailable"> {
	const fact = definitionFactFromProfile(definition, profileId);
	return fact ? presentFingerprintFact(fact) : missingFingerprintFact("curated_profile_missing");
}

function effectiveDefinitionFactOrMissing(
	definition: ModelProfileDefinition | undefined,
	profileId: string,
): FingerprintFact<
	DefinitionFact,
	"curated_profile_missing" | "curated_profile_shadowed" | "curated_profile_malformed" | "curated_profile_mismatch",
	"model_profile_registry_unavailable"
> {
	const fact = definitionFactFromProfile(definition, profileId);
	return fact ? presentFingerprintFact(fact) : missingFingerprintFact("curated_profile_missing");
}

function catalogEntryDigest(mode: CuratedWorkMode): string {
	return createHash("sha256")
		.update(
			JSON.stringify({
				id: mode.id,
				label: mode.label,
				taskContext: mode.taskContext,
				searchTerms: mode.searchTerms,
			}),
			"utf8",
		)
		.digest("hex");
}

function unavailableFingerprint(
	modeId: string,
	profileId: string,
	reason: WorkModeOperationFailureCode,
): WorkModeFingerprint {
	const modeKnown = getCuratedWorkMode(modeId);
	const catalog: FingerprintFact<CatalogFact, "unknown_work_mode" | "catalog_invalid", "catalog_source_unavailable"> =
		modeKnown
			? presentFingerprintFact({
					version: 1,
					modeId: modeKnown.id,
					profileId: modeKnown.profileId,
					entryDigest: catalogEntryDigest(modeKnown),
				})
			: missingFingerprintFact("unknown_work_mode");
	const bundled = BUILTIN_MODEL_PROFILES.find(profile => profile.name === profileId);
	const unavailableRegistry = reason === "model_profile_registry_unavailable";
	const effective =
		reason === "curated_profile_shadowed" ||
		reason === "curated_profile_malformed" ||
		reason === "curated_profile_mismatch"
			? missingFingerprintFact(reason)
			: unavailableRegistry
				? unavailableFingerprintFact("model_profile_registry_unavailable")
				: effectiveDefinitionFactOrMissing(bundled, profileId);
	const bundledFact =
		reason === "builtin_source_unavailable"
			? unavailableFingerprintFact("builtin_source_unavailable")
			: definitionFactOrMissing(bundled, profileId);
	return computeWorkModeFingerprint({
		catalog,
		bundledDefinition: bundledFact,
		effectiveDefinition: effective,
		registryResolution: unavailableRegistry
			? unavailableFingerprintFact("model_profile_registry_unavailable")
			: missingFingerprintFact("not_resolved"),
		readiness: unavailableFingerprintFact("provider_readiness_unavailable"),
		roles: buildWorkModeRoleTuple(() => unavailableFingerprintFact("role_resolution_unavailable")),
		fallback: unavailableFingerprintFact("fallback_resolution_unavailable"),
		confirmation: { required: false, roleDegradation: [] },
	});
}

export class WorkModeTransaction {
	readonly #session: WorkModeSessionRuntime;
	readonly #modelRegistry: ModelRegistry;
	readonly #settings: AgentSession["settings"];
	readonly #scopedMutationService: Pick<ScopedConfigurationMutationService, "mutate"> | undefined;
	readonly #now: () => number;
	readonly #operationId: () => string;
	readonly #receiptId: () => string;
	readonly #turnLeaseId: () => string;
	readonly #emit: ((event: WorkModeOperationEvent) => void) | undefined;
	readonly #staged = new Map<string, WorkModeStagedTurn>();
	readonly #admissions = new Map<string, WorkModeAdmissionLifecycle>();
	readonly #admissionAttempts = new Map<
		string,
		{ readonly tokenId: string; readonly promise: Promise<WorkModeTurnAdmissionResult> }
	>();
	readonly #settlementAttempts = new Map<string, Promise<WorkModeTurnAdmissionResult>>();
	readonly #leases = new Map<string, TurnWorkModeActivationLease>();
	readonly #lineageEpochs = new Map<string, number>();
	readonly #partials = new Map<string, PartialTurnWorkModeActivation>();

	constructor(options: WorkModeTransactionOptions) {
		this.#session = options.session;
		this.#modelRegistry = options.modelRegistry;
		this.#settings = options.settings;
		this.#scopedMutationService = options.scopedMutationService;
		this.#now = options.now ?? (() => Date.now());
		this.#operationId = options.operationId ?? (() => safeOperationId(undefined));
		this.#receiptId = options.receiptId ?? (() => safeReceiptId(undefined));
		this.#turnLeaseId = options.turnLeaseId ?? (() => safeLeaseId(undefined));
		this.#emit = options.emit;
	}

	async preview(modeId: string): Promise<WorkModePreviewResult> {
		return await this.preflight(modeId);
	}

	async preflight(modeId: string): Promise<WorkModePreviewResult> {
		const snapshot = await this.#preflight(modeId);
		if (!snapshot.mode || !snapshot.facts) {
			return {
				phase: "preview",
				state: "unavailable",
				fingerprint: snapshot.fingerprint,
				reason: snapshot.reason ?? "preflight_unexpected",
				details: {
					code: snapshot.reason ?? "preflight_unexpected",
					category: "profile",
				},
			};
		}
		if (snapshot.roleReadiness.kind === "degraded") {
			return {
				phase: "preview",
				state: "degraded",
				fingerprint: snapshot.fingerprint,
				facts: snapshot.facts,
				roleReadiness: snapshot.roleReadiness,
				confirmationRequired: true,
			};
		}
		return {
			phase: "preview",
			state: "ready",
			fingerprint: snapshot.fingerprint,
			facts: snapshot.facts,
			roleReadiness: snapshot.roleReadiness,
			confirmationRequired: false,
		};
	}

	async apply(request: WorkModeApplicationRequest): Promise<WorkModeExecutionResult> {
		const operationId = request.operationId ?? this.#operationId();
		const accepted = request.acceptedPreview;
		const fresh = await this.#preflight(request.modeId);
		const relation = relateWorkModeFingerprints(accepted.fingerprint, fresh.fingerprint);
		if (relation.kind === "changed") return this.#driftedResult(request, operationId, fresh, relation);
		if (!fresh.prepared || !fresh.mode || !fresh.facts)
			return this.#unavailableResult(request, operationId, fresh, fresh.reason ?? "preflight_unexpected");
		if (fresh.roleReadiness.kind === "degraded" && !request.confirmationAccepted) {
			return this.#unavailableResult(request, operationId, fresh, "operation_unexpected");
		}
		if (request.scope === "session") return await this.#applySession(request, operationId, fresh);
		if (request.scope === "project" || request.scope === "user")
			return await this.#applyPersistent(request, operationId, fresh);
		return await this.#stageTurn(request, operationId, fresh);
	}

	async stageTurn(request: WorkModeApplicationRequest): Promise<WorkModeTurnStageResult> {
		const turnRequest = { ...request, scope: "turn" as const };
		const operationId = turnRequest.operationId ?? this.#operationId();
		const accepted = turnRequest.acceptedPreview;
		const fresh = await this.#preflight(turnRequest.modeId);
		const relation = relateWorkModeFingerprints(accepted.fingerprint, fresh.fingerprint);
		if (relation.kind === "changed")
			return requireTurnStageResult(this.#driftedResult(turnRequest, operationId, fresh, relation));
		if (!fresh.prepared || !fresh.mode || !fresh.facts)
			return requireTurnStageResult(
				this.#unavailableResult(turnRequest, operationId, fresh, fresh.reason ?? "preflight_unexpected"),
			);
		if (fresh.roleReadiness.kind === "degraded" && !turnRequest.confirmationAccepted)
			return requireTurnStageResult(
				this.#unavailableResult(turnRequest, operationId, fresh, "operation_unexpected"),
			);
		return await this.#stageTurn(turnRequest, operationId, fresh);
	}

	async admitTurn(
		staged: WorkModeStagedTurn,
		options: {
			readonly admissionTokenId: string;
			readonly rootLogicalRunId: string;
			readonly continuationEpoch?: number;
			readonly targetGeneration: number;
		},
	): Promise<WorkModeTurnAdmissionResult> {
		const lifecycle = this.#admissions.get(staged.operationId);
		if (!lifecycle || !this.#sameStagedIdentity(lifecycle.staged, staged, options.targetGeneration)) {
			return this.#preGateAdmission(staged, "turn_admission_setup_failed", options.admissionTokenId);
		}
		if (lifecycle.state === "settled") {
			const pending = this.#settlementAttempts.get(staged.operationId);
			if (pending) return await pending;
			return lifecycle.event;
		}
		if (lifecycle.state === "admitted") return lifecycle.event;
		if (lifecycle.state === "claimed") {
			const attempt = this.#admissionAttempts.get(staged.operationId);
			if (attempt?.tokenId === options.admissionTokenId) return await attempt.promise;
			return this.#preGateAdmission(staged, "turn_admission_setup_failed", options.admissionTokenId, false);
		}
		this.#admissions.set(staged.operationId, {
			state: "claimed",
			staged: lifecycle.staged,
			tokenId: options.admissionTokenId,
		});
		const promise = this.#runClaimedAdmission(staged, options);
		this.#admissionAttempts.set(staged.operationId, { tokenId: options.admissionTokenId, promise });
		try {
			return await promise;
		} finally {
			const current = this.#admissionAttempts.get(staged.operationId);
			if (current?.promise === promise) this.#admissionAttempts.delete(staged.operationId);
		}
	}

	async #runClaimedAdmission(
		staged: WorkModeStagedTurn,
		options: {
			readonly admissionTokenId: string;
			readonly rootLogicalRunId: string;
			readonly continuationEpoch?: number;
			readonly targetGeneration: number;
		},
	): Promise<WorkModeTurnAdmissionResult> {
		const fresh = await this.#preflight(staged.modeId);
		if (!this.#isCurrentClaim(staged, options.admissionTokenId))
			return await this.#resolveStaleAdmission(staged, options.admissionTokenId, fresh);
		const relation = relateWorkModeFingerprints(staged.acceptedFingerprint, fresh.fingerprint);
		if (relation.kind === "changed") {
			const drifted = requireTurnAdmissionResult(
				this.#driftedResult(
					{
						modeId: staged.modeId,
						acceptedPreview: this.#previewFromStaged(staged),
						scope: "turn",
						operationId: staged.operationId,
						confirmationAccepted: staged.degradedConfirmation,
					},
					staged.operationId,
					fresh,
					relation,
					"turn_admission",
					false,
				),
			);
			return this.#settleClaimedEvent(staged, options.admissionTokenId, drifted);
		}
		if (!fresh.prepared || !fresh.mode || !fresh.facts) {
			return this.#settleClaimedPreGate(staged, "turn_admission_setup_failed", options.admissionTokenId);
		}
		let partial: PartialTurnWorkModeActivation | undefined;
		try {
			partial = new PartialTurnWorkModeActivation({
				partialActivationId: this.#receiptId(),
				operationId: staged.operationId,
				acceptedFingerprint: staged.acceptedFingerprint,
				observedFingerprint: fresh.fingerprint,
				session: this.#session,
				settings: this.#settings,
			});
			this.#partials.set(staged.operationId, partial);
			await partial.setup(fresh.prepared);
			if (!this.#isCurrentClaim(staged, options.admissionTokenId))
				return await this.#resolveStaleAdmission(staged, options.admissionTokenId, fresh, partial);
			const turnLeaseId = this.#turnLeaseId();
			const admissionReceiptId = this.#receiptId();
			const lease = new TurnWorkModeActivationLease({
				turnLeaseId,
				operationId: staged.operationId,
				acceptedFingerprint: staged.acceptedFingerprint,
				admittedFingerprint: fresh.fingerprint,
				admissionReceiptId,
				stageReceiptId: staged.stageReceiptId,
				partial,
				rootLogicalRunId: options.rootLogicalRunId,
				rootAdmissionGeneration: options.targetGeneration,
				continuationEpoch: options.continuationEpoch ?? 0,
			});
			if (!this.#isCurrentClaim(staged, options.admissionTokenId))
				return await this.#resolveStaleAdmission(staged, options.admissionTokenId, fresh, partial);
			const degraded = fresh.roleReadiness.kind === "degraded";
			const event = this.#admissionResult(
				staged,
				fresh,
				lease,
				admissionReceiptId,
				options.admissionTokenId,
				degraded,
			);
			if (!this.#isCurrentClaim(staged, options.admissionTokenId))
				return await this.#resolveStaleAdmission(staged, options.admissionTokenId, fresh, partial);
			partial.markTransferred();
			this.#leases.set(staged.operationId, lease);
			this.#lineageEpochs.set(staged.operationId, lease.continuationEpoch);
			this.#partials.delete(staged.operationId);
			this.#staged.delete(staged.operationId);
			this.#admissions.set(staged.operationId, {
				state: "admitted",
				staged,
				tokenId: options.admissionTokenId,
				event,
				lease,
			});
			emitSafely(this.#emit, event);
			return event;
		} catch {
			return await this.#partialFailure(staged, fresh, "turn_activation_failed", options.admissionTokenId);
		}
	}

	async finalizeTurn(
		operationId: string,
		reason: "completed" | "error" | "aborted" | "cancelled" | "handoff" | "disposed",
	): Promise<WorkModeTurnFinalizeEvent | undefined> {
		const lease = this.#leases.get(operationId);
		if (!lease) return undefined;
		const event = await lease.finalize(reason, { receiptId: this.#receiptId(), now: this.#now, emit: this.#emit });
		this.#leases.delete(operationId);
		this.#lineageEpochs.delete(operationId);
		return event;
	}

	settlePreGate(
		staged: WorkModeStagedTurn,
		reason: WorkModePreGateExitReason,
		tokenId: string,
	): WorkModeTurnAdmissionResult {
		const lifecycle = this.#admissions.get(staged.operationId);
		if (
			!lifecycle ||
			!this.#sameStagedIdentity(lifecycle.staged, staged, staged.targetEligibleUserAdmissionGeneration)
		) {
			return this.#preGateAdmission(staged, reason, tokenId);
		}
		if (lifecycle.state === "settled" || lifecycle.state === "admitted") return lifecycle.event;
		if (lifecycle.state === "claimed" && lifecycle.tokenId !== tokenId)
			return this.#preGateAdmission(staged, "turn_admission_setup_failed", tokenId, false);
		return this.#settleClaimedPreGate(staged, reason, tokenId);
	}

	#sameStagedIdentity(left: WorkModeStagedTurn, right: WorkModeStagedTurn, targetGeneration: number): boolean {
		return (
			left === right &&
			left.operationId === right.operationId &&
			left.stageReceiptId === right.stageReceiptId &&
			left.targetEligibleUserAdmissionGeneration === targetGeneration
		);
	}

	#isCurrentClaim(staged: WorkModeStagedTurn, tokenId: string): boolean {
		const lifecycle = this.#admissions.get(staged.operationId);
		return (
			lifecycle?.state === "claimed" &&
			lifecycle.tokenId === tokenId &&
			this.#sameStagedIdentity(lifecycle.staged, staged, staged.targetEligibleUserAdmissionGeneration) &&
			this.#staged.get(staged.operationId) === staged
		);
	}

	#settleClaimedPreGate(
		staged: WorkModeStagedTurn,
		reason: WorkModePreGateExitReason,
		tokenId: string,
	): WorkModeTurnAdmissionResult {
		const lifecycle = this.#admissions.get(staged.operationId);
		if (lifecycle?.state === "settled" || lifecycle?.state === "admitted") return lifecycle.event;
		if (!this.#isCurrentClaim(staged, tokenId) && lifecycle?.state !== "staged")
			return this.#preGateAdmission(staged, "turn_admission_setup_failed", tokenId, false);
		const event = this.#preGateAdmission(staged, reason, tokenId, false);
		this.#admissions.set(staged.operationId, { state: "settled", staged, tokenId, event });
		this.#staged.delete(staged.operationId);
		const partial = this.#partials.get(staged.operationId);
		partial?.requestCancellation();
		if (!partial) {
			emitSafely(this.#emit, event);
			return event;
		}
		const pending = this.#finishClaimedSettlement(staged, tokenId, event, partial);
		this.#settlementAttempts.set(staged.operationId, pending);
		void pending.then(
			() => {
				const current = this.#settlementAttempts.get(staged.operationId);
				if (current === pending) this.#settlementAttempts.delete(staged.operationId);
			},
			() => {
				const current = this.#settlementAttempts.get(staged.operationId);
				if (current === pending) this.#settlementAttempts.delete(staged.operationId);
			},
		);
		return event;
	}

	async #finishClaimedSettlement(
		staged: WorkModeStagedTurn,
		tokenId: string,
		event: WorkModeTurnAdmissionResult,
		partial: PartialTurnWorkModeActivation,
	): Promise<WorkModeTurnAdmissionResult> {
		partial.requestCancellation();
		let cleaned = true;
		try {
			cleaned = await partial.cleanup();
		} catch {
			cleaned = false;
		}
		this.#partials.delete(staged.operationId);
		if (cleaned) {
			emitSafely(this.#emit, event);
			return event;
		}
		const rollback = this.#partialFailureEvent(
			staged,
			partial.observedFingerprint,
			partial,
			"turn_rollback_failed",
			tokenId,
		);
		this.#admissions.set(staged.operationId, { state: "settled", staged, tokenId, event: rollback });
		emitSafely(this.#emit, rollback);
		return rollback;
	}

	#settleClaimedEvent(
		staged: WorkModeStagedTurn,
		tokenId: string,
		event: WorkModeTurnAdmissionResult,
	): WorkModeTurnAdmissionResult {
		const lifecycle = this.#admissions.get(staged.operationId);
		if (lifecycle?.state === "settled" || lifecycle?.state === "admitted") return lifecycle.event;
		if (!this.#isCurrentClaim(staged, tokenId)) return event;
		this.#admissions.set(staged.operationId, { state: "settled", staged, tokenId, event });
		this.#staged.delete(staged.operationId);
		emitSafely(this.#emit, event);
		return event;
	}

	async #resolveStaleAdmission(
		staged: WorkModeStagedTurn,
		tokenId: string,
		fresh: PreflightSnapshot,
		partial?: PartialTurnWorkModeActivation,
	): Promise<WorkModeTurnAdmissionResult> {
		const pending = this.#settlementAttempts.get(staged.operationId);
		if (pending) return await pending;
		partial?.requestCancellation();
		let cleaned = true;
		try {
			cleaned = partial ? await partial.cleanup() : true;
		} catch {
			cleaned = false;
		}
		this.#partials.delete(staged.operationId);
		const lifecycle = this.#admissions.get(staged.operationId);
		if (lifecycle?.state === "settled" || lifecycle?.state === "admitted") return lifecycle.event;
		if (!cleaned) return await this.#partialFailure(staged, fresh, "turn_rollback_failed", tokenId);
		return this.#preGateAdmission(staged, "turn_admission_setup_failed", tokenId, false);
	}

	getStagedTurn(operationId: string): WorkModeStagedTurn | undefined {
		return this.#staged.get(operationId);
	}

	getTurnLease(operationId: string): TurnWorkModeActivationLease | undefined {
		return this.#leases.get(operationId);
	}
	isValidTurnLineage(
		operationId: string,
		lineage: WorkModeTurnLeaseLineage,
		kind: "retry" | "profile_internal_fallback",
	): boolean {
		const lease = this.#leases.get(operationId);
		if (!lease) return false;
		const current = lease.lineage;
		const currentEpoch = this.#lineageEpochs.get(operationId) ?? current.continuationEpoch;
		return (
			(kind === "retry" || kind === "profile_internal_fallback") &&
			lineage.operationId === current.operationId &&
			lineage.stageReceiptId === current.stageReceiptId &&
			lineage.admissionReceiptId === current.admissionReceiptId &&
			lineage.turnLeaseId === current.turnLeaseId &&
			lineage.rootLogicalRunId === current.rootLogicalRunId &&
			lineage.rootAdmissionGeneration === current.rootAdmissionGeneration &&
			lineage.continuationEpoch === currentEpoch + 1
		);
	}
	retainTurnLineage(
		operationId: string,
		lineage: WorkModeTurnLeaseLineage,
		kind: "retry" | "profile_internal_fallback",
	): boolean {
		if (!this.isValidTurnLineage(operationId, lineage, kind)) return false;
		this.#lineageEpochs.set(operationId, lineage.continuationEpoch);
		return true;
	}

	async #preflight(modeId: string): Promise<PreflightSnapshot> {
		const mode = getCuratedWorkMode(modeId);
		if (!mode) {
			return {
				mode,
				facts: undefined,
				fingerprint: unavailableFingerprint(modeId, "", "unknown_work_mode"),
				roleReadiness: { kind: "complete", confirmation: "not_required" },
				prepared: undefined,
				reason: "unknown_work_mode",
			};
		}
		let profiles: ReadonlyMap<string, ModelProfileDefinition>;
		try {
			profiles = profileDefinitionMap(this.#modelRegistry);
		} catch {
			return {
				mode,
				facts: undefined,
				fingerprint: unavailableFingerprint(mode.id, mode.profileId, "model_profile_registry_unavailable"),
				roleReadiness: { kind: "complete", confirmation: "not_required" },
				prepared: undefined,
				reason: "model_profile_registry_unavailable",
			};
		}
		const validation = validateCuratedWorkModeProfile(mode, profiles);
		if (!validation.available || !validation.effectiveDefinition || !validation.bundledDefinition) {
			return {
				mode,
				facts: undefined,
				fingerprint: unavailableFingerprint(
					mode.id,
					mode.profileId,
					validation.reason ?? "curated_profile_missing",
				),
				roleReadiness: { kind: "complete", confirmation: "not_required" },
				prepared: undefined,
				reason: validation.reason ?? "curated_profile_missing",
			};
		}
		let prepared: PreparedModelProfileActivation;
		try {
			prepared = await prepareModelProfileActivation({
				session: this.#session,
				modelRegistry: this.#modelRegistry,
				settings: this.#settings,
				profileName: mode.profileId,
			});
		} catch (error) {
			const reason = errorReason(error, "preflight_unexpected");
			return {
				mode,
				facts: undefined,
				fingerprint: unavailableFingerprint(mode.id, mode.profileId, reason),
				roleReadiness: { kind: "complete", confirmation: "not_required" },
				prepared: undefined,
				reason,
			};
		}
		let roleResolution: {
			readonly roleReadiness: WorkModeRoleReadiness;
			readonly roles: readonly RoleResolutionFact[];
		};
		try {
			roleResolution = roleReadinessFromPrepared(validation.effectiveDefinition, prepared, this.#modelRegistry);
		} catch {
			return {
				mode,
				facts: undefined,
				fingerprint: unavailableFingerprint(mode.id, mode.profileId, "provider_readiness_unavailable"),
				roleReadiness: { kind: "complete", confirmation: "not_required" },
				prepared: undefined,
				reason: "provider_readiness_unavailable",
			};
		}
		const definition = definitionFactFromProfile(validation.effectiveDefinition, mode.profileId)!;
		const bundledDefinition = definitionFactFromProfile(validation.bundledDefinition, mode.profileId)!;
		const catalogFact = presentFingerprintFact<CatalogFact>({
			version: 1,
			modeId: mode.id,
			profileId: mode.profileId,
			entryDigest: computeWorkModeFingerprint({
				catalog: presentFingerprintFact({
					version: 1,
					modeId: mode.id,
					profileId: mode.profileId,
					entryDigest: catalogEntryDigest(mode),
				}),
				bundledDefinition: presentFingerprintFact(bundledDefinition),
				effectiveDefinition: presentFingerprintFact(definition),
				registryResolution: missingFingerprintFact("not_resolved"),
				readiness: missingFingerprintFact("not_evaluated"),
				roles: buildWorkModeRoleTuple(index => presentFingerprintFact(roleResolution.roles[index])),
				fallback: presentFingerprintFact({
					defaultChain: prepared.defaultChain,
					activeIndex: prepared.defaultActiveIndex ?? null,
					skips: prepared.defaultResolutionSkips,
				}),
				confirmation: {
					required: roleResolution.roleReadiness.kind === "degraded",
					roleDegradation:
						roleResolution.roleReadiness.kind === "degraded"
							? roleResolution.roleReadiness.unresolved.map(item => item.role)
							: [],
				},
			}).digest,
		});
		const authenticatedProviders = new Set(prepared.authenticatedProviderIds);
		const alternativeProviderIds = new Set(
			prepared.alternativeProviderSelections.flatMap(selection => selection.providerIds),
		);
		const readiness: ReadinessFact = {
			strictProviders: [...new Set(validation.effectiveDefinition.requiredProviders)]
				.filter(providerId => !alternativeProviderIds.has(providerId))
				.sort((left, right) => left.localeCompare(right))
				.map(providerId => ({
					providerId,
					state: authenticatedProviders.has(providerId) ? ("ready" as const) : ("missing" as const),
				})),
			alternativeGroups: prepared.alternativeProviderSelections.map(({ providerIds, selectedProviderId }) => ({
				providerIds,
				state: selectedProviderId === null ? ("missing" as const) : ("ready" as const),
				selectedProviderId,
			})),
		};
		const fallback: FallbackFact = {
			defaultChain: prepared.defaultChain,
			activeIndex: prepared.defaultActiveIndex ?? null,
			skips: prepared.defaultResolutionSkips,
		};
		const resolution: ResolutionSnapshot = {
			registryRevision: this.#modelRegistry.getModelProfiles().size.toString(10),
			resolutionRevision: prepared.profileName,
			resolutionDigest: prepared.defaultModel ? `${prepared.defaultModel.provider}/${prepared.defaultModel.id}` : "",
		};
		const fingerprint = computeWorkModeFingerprint({
			catalog: catalogFact,
			bundledDefinition: presentFingerprintFact(bundledDefinition),
			effectiveDefinition: presentFingerprintFact(definition),
			registryResolution: presentFingerprintFact(resolution),
			readiness: presentFingerprintFact(readiness),
			roles: buildWorkModeRoleTuple(index => presentFingerprintFact(roleResolution.roles[index])),
			fallback: presentFingerprintFact(fallback),
			confirmation: {
				required: roleResolution.roleReadiness.kind === "degraded",
				roleDegradation:
					roleResolution.roleReadiness.kind === "degraded"
						? roleResolution.roleReadiness.unresolved.map(item => item.role)
						: [],
			},
		});
		return {
			mode,
			facts: { mode, profileId: mode.profileId, requestedRoleReadiness: roleResolution.roleReadiness },
			fingerprint,
			roleReadiness: roleResolution.roleReadiness,
			prepared,
			reason: null,
		};
	}

	async #applySession(
		request: WorkModeApplicationRequest,
		operationId: string,
		fresh: PreflightSnapshot,
	): Promise<WorkModeExecutionResult> {
		const startedAt = this.#now();
		try {
			await applyPreparedModelProfileActivation(fresh.prepared!, { persistDefault: false });
			const receipt = this.#receipt(
				operationId,
				"session_apply",
				"session",
				request.acceptedPreview.fingerprint,
				fresh.fingerprint,
				fresh.roleReadiness,
				{ kind: "not_requested" },
				{ kind: "applied" },
				null,
				startedAt,
				confirmationAcceptedFor(fresh.roleReadiness, request.confirmationAccepted),
			);
			const event: WorkModeOperationEvent = {
				caseId: fresh.roleReadiness.kind === "degraded" ? "session_apply.degraded" : "session_apply.ready",
				phase: "session_apply",
				state: fresh.roleReadiness.kind === "degraded" ? "degraded" : "ready",
				operationId,
				acceptedFingerprint: request.acceptedPreview.fingerprint,
				observedFingerprint: fresh.fingerprint,
				relation: receipt.relation,
				roleReadiness: fresh.roleReadiness,
				confirmation: receipt.confirmation,
				durable: receipt.durable,
				runtime: receipt.runtime,
				receipt,
				appliedFingerprint: fresh.fingerprint,
			} as WorkModeOperationEvent;
			emitSafely(this.#emit, event);
			return requireExecutionResult(event);
		} catch {
			return this.#unavailableResult(request, operationId, fresh, "session_activation_failed");
		}
	}

	async #applyPersistent(
		request: WorkModeApplicationRequest,
		operationId: string,
		fresh: PreflightSnapshot,
	): Promise<WorkModeExecutionResult> {
		const startedAt = this.#now();
		if (!this.#scopedMutationService) return this.#unavailableResult(request, operationId, fresh, "scope_rejected");
		const scope: ScopedConfigurationScope = request.scope === "user" ? "user" : "project";
		let scopedReceipt: ScopedConfigurationMutationReceipt;
		try {
			scopedReceipt = await this.#scopedMutationService.mutate({
				scope,
				patches: [{ op: "set", path: "modelProfile.default", value: fresh.mode!.profileId }],
				expectedOwner: request.expectedOwner,
			});
		} catch {
			return this.#unavailableResult(request, operationId, fresh, "persistent_write_failed");
		}
		const reason = scopedReceipt.reason;
		const durable =
			scopedReceipt.status === "committed" ||
			scopedReceipt.status === "applied" ||
			scopedReceipt.status === "degraded"
				? scopedReceipt.confirmation === "unconfirmed" || scopedReceipt.durability === "committed_unconfirmed"
					? {
							kind: "committed_unconfirmed" as const,
							code: (reason === "persistent_reload_mismatch"
								? "persistent_reload_mismatch"
								: "persistent_reload_unconfirmed") as
								| "persistent_reload_unconfirmed"
								| "persistent_reload_mismatch",
							scopedReceipt,
						}
					: { kind: "committed" as const, scopedReceipt }
				: scopedReceipt.status === "conflict"
					? { kind: "conflict" as const, scopedReceipt }
					: scopedReceipt.status === "locked"
						? { kind: "locked" as const, scopedReceipt }
						: { kind: "rejected" as const, code: scopedReasonCode(reason), scopedReceipt };
		const successful = durable.kind === "committed" || durable.kind === "committed_unconfirmed";
		const state: "ready" | "degraded" | "unavailable" = successful
			? fresh.roleReadiness.kind === "degraded"
				? "degraded"
				: "ready"
			: "unavailable";
		const caseId:
			| "persistent_apply.ready.committed"
			| "persistent_apply.ready.committed_unconfirmed"
			| "persistent_apply.degraded.committed"
			| "persistent_apply.degraded.committed_unconfirmed"
			| "persistent_apply.unavailable.mutation"
			| "persistent_apply.unavailable.prewrite" = successful
			? fresh.roleReadiness.kind === "degraded"
				? durable.kind === "committed_unconfirmed"
					? "persistent_apply.degraded.committed_unconfirmed"
					: "persistent_apply.degraded.committed"
				: durable.kind === "committed_unconfirmed"
					? "persistent_apply.ready.committed_unconfirmed"
					: "persistent_apply.ready.committed"
			: durable.kind === "locked" || durable.kind === "conflict" || durable.kind === "rejected"
				? "persistent_apply.unavailable.mutation"
				: "persistent_apply.unavailable.prewrite";
		const receipt = this.#receipt(
			operationId,
			"persistent_apply",
			request.scope,
			request.acceptedPreview.fingerprint,
			fresh.fingerprint,
			fresh.roleReadiness,
			durable,
			{ kind: "not_requested" },
			successful ? null : scopedReasonCode(reason),
			startedAt,
			confirmationAcceptedFor(fresh.roleReadiness, request.confirmationAccepted),
			scopedReceipt,
		);
		const event: WorkModeOperationEvent = {
			caseId,
			phase: "persistent_apply",
			state,
			operationId,
			acceptedFingerprint: request.acceptedPreview.fingerprint,
			observedFingerprint: fresh.fingerprint,
			relation: receipt.relation,
			roleReadiness: fresh.roleReadiness,
			confirmation: receipt.confirmation,
			durable,
			runtime: receipt.runtime,
			receipt,
			...(successful ? { committedFingerprint: fresh.fingerprint } : {}),
		} as WorkModeOperationEvent;
		emitSafely(this.#emit, event);
		return requireExecutionResult(event);
	}

	async #stageTurn(
		request: WorkModeApplicationRequest,
		operationId: string,
		fresh: PreflightSnapshot,
	): Promise<WorkModeTurnStageResult> {
		const startedAt = this.#now();
		if (fresh.roleReadiness.kind === "degraded" && !request.confirmationAccepted)
			return requireTurnStageResult(this.#unavailableResult(request, operationId, fresh, "turn_stage_rejected"));
		const stageReceiptId = this.#receiptId();
		const staged: WorkModeStagedTurn = Object.freeze({
			operationId,
			stageReceiptId,
			modeId: request.modeId,
			profileId: fresh.mode!.profileId,
			acceptedFingerprint: request.acceptedPreview.fingerprint,
			acceptedRoleReadiness: fresh.roleReadiness,
			degradedConfirmation: request.confirmationAccepted === true,
			targetEligibleUserAdmissionGeneration: request.targetEligibleUserAdmissionGeneration ?? 0,
		});
		const receipt = freezeWorkModeReceipt({
			...this.#receipt(
				operationId,
				"turn_stage",
				"turn",
				request.acceptedPreview.fingerprint,
				fresh.fingerprint,
				fresh.roleReadiness,
				{ kind: "not_requested" },
				{ kind: "staged" },
				null,
				startedAt,
				confirmationAcceptedFor(fresh.roleReadiness, request.confirmationAccepted),
				undefined,
				stageReceiptId,
			),
			receiptId: stageReceiptId,
		});
		const event: WorkModeOperationEvent = {
			caseId: fresh.roleReadiness.kind === "degraded" ? "turn_stage.degraded" : "turn_stage.ready",
			phase: "turn_stage",
			state: fresh.roleReadiness.kind === "degraded" ? "degraded" : "ready",
			operationId,
			acceptedFingerprint: request.acceptedPreview.fingerprint,
			observedFingerprint: fresh.fingerprint,
			relation: receipt.relation,
			roleReadiness: fresh.roleReadiness,
			confirmation: receipt.confirmation,
			durable: receipt.durable,
			runtime: receipt.runtime,
			receipt,
			stagedFingerprint: fresh.fingerprint,
		} as WorkModeOperationEvent;
		this.#staged.set(operationId, staged);
		this.#admissions.set(operationId, { state: "staged", staged });
		emitSafely(this.#emit, event);
		return requireTurnStageResult(event);
	}

	#previewFromSnapshot(snapshot: PreflightSnapshot): WorkModePreviewResult {
		if (!snapshot.mode || !snapshot.facts) {
			return {
				phase: "preview",
				state: "unavailable",
				fingerprint: snapshot.fingerprint,
				reason: snapshot.reason ?? "preflight_unexpected",
				details: { code: snapshot.reason ?? "preflight_unexpected", category: "profile" },
			};
		}
		return snapshot.roleReadiness.kind === "degraded"
			? {
					phase: "preview",
					state: "degraded",
					fingerprint: snapshot.fingerprint,
					facts: snapshot.facts,
					roleReadiness: snapshot.roleReadiness,
					confirmationRequired: true,
				}
			: {
					phase: "preview",
					state: "ready",
					fingerprint: snapshot.fingerprint,
					facts: snapshot.facts,
					roleReadiness: snapshot.roleReadiness,
					confirmationRequired: false,
				};
	}

	#previewFromStaged(staged: WorkModeStagedTurn): WorkModePreviewResult {
		return staged.acceptedRoleReadiness.kind === "degraded"
			? {
					phase: "preview",
					state: "degraded",
					fingerprint: staged.acceptedFingerprint,
					facts: {
						mode: getCuratedWorkMode(staged.modeId)!,
						profileId: staged.profileId,
						requestedRoleReadiness: staged.acceptedRoleReadiness,
					},
					roleReadiness: staged.acceptedRoleReadiness,
					confirmationRequired: true,
				}
			: {
					phase: "preview",
					state: "ready",
					fingerprint: staged.acceptedFingerprint,
					facts: {
						mode: getCuratedWorkMode(staged.modeId)!,
						profileId: staged.profileId,
						requestedRoleReadiness: staged.acceptedRoleReadiness,
					},
					roleReadiness: staged.acceptedRoleReadiness,
					confirmationRequired: false,
				};
	}

	#receipt(
		operationId: string,
		phase: "session_apply" | "persistent_apply" | "turn_stage" | "turn_admission",
		scope: "session" | "project" | "user" | "turn",
		acceptedFingerprint: WorkModeFingerprint,
		observedFingerprint: WorkModeFingerprint,
		roleReadiness: WorkModeRoleReadiness,
		durable: WorkModeOperationReceipt["durable"],
		runtime: WorkModeOperationReceipt["runtime"],
		reason: WorkModeOperationFailureCode | null,
		startedAt: number,
		confirmationAccepted: boolean,
		scopedReceipt?: ScopedConfigurationMutationReceipt,
		receiptId = this.#receiptId(),
	): WorkModeOperationReceipt {
		const relation = relateWorkModeFingerprints(acceptedFingerprint, observedFingerprint);
		return freezeWorkModeReceipt({
			schema: "work-mode-receipt.v1",
			version: 1,
			receiptId,
			operationId,
			phase,
			scope,
			acceptedFingerprint,
			observedFingerprint,
			relation,
			roleReadiness,
			confirmation: {
				required: roleReadiness.kind === "degraded",
				accepted: confirmationAccepted,
			},
			durable,
			runtime,
			reason,
			timing: { startedAt, finishedAt: this.#now() },
			facts: scopedReceipt ? { scopedStatus: scopedReceipt.status } : {},
		});
	}

	#driftedResult(
		request: WorkModeApplicationRequest,
		operationId: string,
		fresh: PreflightSnapshot,
		relation: Extract<WorkModeFingerprintRelation, { kind: "changed" }>,
		phaseOverride?: "session_apply" | "persistent_apply" | "turn_stage" | "turn_admission",
		emit = true,
	): WorkModeExecutionResult {
		const phase: "turn_stage" | "session_apply" | "persistent_apply" | "turn_admission" =
			phaseOverride ??
			(request.scope === "turn" ? "turn_stage" : request.scope === "session" ? "session_apply" : "persistent_apply");
		const caseId:
			| "turn_stage.drifted"
			| "session_apply.drifted"
			| "persistent_apply.drifted"
			| "turn_admission.drifted" =
			phase === "turn_stage"
				? "turn_stage.drifted"
				: phase === "turn_admission"
					? "turn_admission.drifted"
					: phase === "session_apply"
						? "session_apply.drifted"
						: "persistent_apply.drifted";
		const receipt = this.#receipt(
			operationId,
			phase,
			request.scope,
			request.acceptedPreview.fingerprint,
			fresh.fingerprint,
			fresh.roleReadiness,
			{ kind: "not_requested" },
			{ kind: "rejected", code: "preview_drift" },
			"preview_drift",
			this.#now(),
			confirmationAcceptedFor(fresh.roleReadiness, request.confirmationAccepted),
		);
		const event: WorkModeOperationEvent = {
			caseId,
			phase,
			state: "drifted",
			operationId,
			acceptedFingerprint: request.acceptedPreview.fingerprint,
			observedFingerprint: fresh.fingerprint,
			relation,
			roleReadiness: fresh.roleReadiness,
			confirmation: receipt.confirmation,
			durable: receipt.durable,
			runtime: receipt.runtime,
			receipt,
			reason: "preview_drift",
			changedFacts: relation.changedFacts,
			rePreview: this.#previewFromSnapshot(fresh),
		} as WorkModeOperationEvent;
		if (emit) emitSafely(this.#emit, event);
		return requireExecutionResult(event);
	}

	#unavailableResult(
		request: WorkModeApplicationRequest,
		operationId: string,
		fresh: PreflightSnapshot,
		reason: WorkModeOperationFailureCode,
	): WorkModeExecutionResult {
		const phase: "session_apply" | "turn_stage" | "persistent_apply" =
			request.scope === "session" ? "session_apply" : request.scope === "turn" ? "turn_stage" : "persistent_apply";
		const boundedReason = unavailableReasonForPhase(phase, reason);
		const receipt = this.#receipt(
			operationId,
			phase,
			request.scope,
			request.acceptedPreview.fingerprint,
			fresh.fingerprint,
			fresh.roleReadiness,
			{ kind: "not_requested" },
			{ kind: "rejected", code: boundedReason },
			boundedReason,
			this.#now(),
			confirmationAcceptedFor(fresh.roleReadiness, request.confirmationAccepted),
		);
		const caseId:
			| "session_apply.unavailable"
			| "turn_stage.unavailable"
			| "persistent_apply.unavailable.prewrite"
			| "persistent_apply.unavailable.mutation" =
			phase === "session_apply"
				? "session_apply.unavailable"
				: phase === "turn_stage"
					? "turn_stage.unavailable"
					: boundedReason === "project_scope_unavailable"
						? "persistent_apply.unavailable.prewrite"
						: "persistent_apply.unavailable.mutation";
		const event: WorkModeOperationEvent = {
			caseId,
			phase,
			state: "unavailable",
			operationId,
			acceptedFingerprint: request.acceptedPreview.fingerprint,
			observedFingerprint: fresh.fingerprint,
			relation: receipt.relation,
			roleReadiness: fresh.roleReadiness,
			confirmation: receipt.confirmation,
			durable: receipt.durable,
			runtime: receipt.runtime,
			receipt,
			reason: boundedReason,
		} as WorkModeOperationEvent;
		emitSafely(this.#emit, event);
		return requireExecutionResult(event);
	}

	#preGateAdmission(
		staged: WorkModeStagedTurn,
		reason: WorkModeOperationFailureCode,
		tokenId: string,
		emit = true,
	): WorkModeTurnAdmissionResult {
		const runtime: WorkModeOperationReceipt["runtime"] =
			reason === "turn_admission_cancelled" ||
			reason === "turn_admission_handoff_cancelled" ||
			reason === "turn_admission_disposed"
				? { kind: "cancelled", code: reason }
				: { kind: "rejected", code: reason };
		const relation: WorkModeFingerprintRelation = {
			kind: "not_observed",
			accepted: staged.acceptedFingerprint,
			reason: reason as
				| "turn_admission_cancelled"
				| "turn_admission_handoff_cancelled"
				| "turn_admission_disposed"
				| "turn_admission_setup_failed"
				| "preflight_unexpected",
		};
		const receipt = freezeWorkModeReceipt({
			schema: "work-mode-receipt.v1",
			version: 1,
			receiptId: this.#receiptId(),
			operationId: staged.operationId,
			phase: "turn_admission",
			scope: "turn",
			acceptedFingerprint: staged.acceptedFingerprint,
			relation,
			roleReadiness: staged.acceptedRoleReadiness,
			confirmation: {
				required: staged.acceptedRoleReadiness.kind === "degraded",
				accepted: confirmationAcceptedFor(staged.acceptedRoleReadiness, staged.degradedConfirmation),
			},
			durable: { kind: "not_requested" },
			runtime,
			reason,
			timing: { startedAt: this.#now(), finishedAt: this.#now() },
			facts: { mustRestage: true, admissionTokenId: tokenId },
		});
		const caseId: "turn_admission.unavailable.pre_gate_rejected" | "turn_admission.unavailable.pre_gate_cancelled" =
			reason === "turn_admission_setup_failed" || reason === "preflight_unexpected"
				? "turn_admission.unavailable.pre_gate_rejected"
				: "turn_admission.unavailable.pre_gate_cancelled";
		const event: WorkModeOperationEvent = {
			caseId,
			phase: "turn_admission",
			state: "unavailable",
			operationId: staged.operationId,
			acceptedFingerprint: staged.acceptedFingerprint,
			relation,
			roleReadiness: staged.acceptedRoleReadiness,
			confirmation: receipt.confirmation,
			durable: receipt.durable,
			runtime,
			receipt,
			reason: reason as WorkModePreGateExitReason,
			mustRestage: true,
			admissionTokenId: tokenId,
		} as WorkModeOperationEvent;
		if (emit) emitSafely(this.#emit, event);
		return requireTurnAdmissionResult(event);
	}

	async #partialFailure(
		staged: WorkModeStagedTurn,
		fresh: PreflightSnapshot,
		reason: "turn_activation_failed" | "turn_rollback_failed",
		tokenId: string,
	): Promise<WorkModeTurnAdmissionResult> {
		const partial = this.#partials.get(staged.operationId);
		partial?.requestCancellation();
		let cleaned = true;
		try {
			cleaned = partial ? await partial.cleanup() : true;
		} catch {
			cleaned = false;
		}
		this.#partials.delete(staged.operationId);
		const lifecycle = this.#admissions.get(staged.operationId);
		if (lifecycle?.state === "settled" || lifecycle?.state === "admitted") return lifecycle.event;
		if (!this.#isCurrentClaim(staged, tokenId))
			return this.#preGateAdmission(staged, "turn_admission_setup_failed", tokenId, false);
		const actualReason =
			cleaned && reason === "turn_activation_failed" ? "turn_activation_failed" : "turn_rollback_failed";
		const event = this.#partialFailureEvent(staged, fresh.fingerprint, partial, actualReason, tokenId);
		return this.#settleClaimedEvent(staged, tokenId, event);
	}

	#partialFailureEvent(
		staged: WorkModeStagedTurn,
		observedFingerprint: WorkModeFingerprint,
		partial: PartialTurnWorkModeActivation | undefined,
		reason: "turn_activation_failed" | "turn_rollback_failed",
		tokenId: string,
	): WorkModeTurnAdmissionResult {
		let failureReceiptId: string;
		try {
			failureReceiptId = this.#receiptId();
		} catch {
			failureReceiptId = safeReceiptId(undefined);
		}
		const receipt = this.#receipt(
			staged.operationId,
			"turn_admission",
			"turn",
			staged.acceptedFingerprint,
			observedFingerprint,
			staged.acceptedRoleReadiness,
			{ kind: "not_requested" },
			reason === "turn_rollback_failed"
				? { kind: "restore_failed", code: "turn_rollback_failed" }
				: { kind: "rejected", code: "turn_activation_failed" },
			reason,
			this.#now(),
			confirmationAcceptedFor(staged.acceptedRoleReadiness, staged.degradedConfirmation),
			undefined,
			failureReceiptId,
		);
		const event: WorkModeOperationEvent = {
			caseId:
				reason === "turn_rollback_failed"
					? "turn_admission.unavailable.runtime.rollback_failed"
					: "turn_admission.unavailable.runtime.activation_failed",
			phase: "turn_admission",
			state: "unavailable",
			operationId: staged.operationId,
			acceptedFingerprint: staged.acceptedFingerprint,
			observedFingerprint,
			activationOwner: "partial_cleanup",
			relation: receipt.relation,
			roleReadiness: staged.acceptedRoleReadiness,
			confirmation: receipt.confirmation,
			durable: receipt.durable,
			runtime: receipt.runtime,
			receipt,
			reason,
			partialActivationId: partial?.partialActivationId ?? failureReceiptId,
			setupCheckpoint: partial?.checkpoint ?? "none",
			admissionTokenId: tokenId,
		} as WorkModeOperationEvent;
		return requireTurnAdmissionResult(event);
	}

	#admissionResult(
		staged: WorkModeStagedTurn,
		fresh: PreflightSnapshot,
		lease: TurnWorkModeActivationLease,
		receiptId: string,
		tokenId: string,
		degraded: boolean,
	): WorkModeTurnAdmissionResult {
		const receipt = this.#receipt(
			staged.operationId,
			"turn_admission",
			"turn",
			staged.acceptedFingerprint,
			fresh.fingerprint,
			fresh.roleReadiness,
			{ kind: "not_requested" },
			{ kind: "admitted", turnLeaseId: lease.turnLeaseId },
			null,
			this.#now(),
			confirmationAcceptedFor(staged.acceptedRoleReadiness, staged.degradedConfirmation),
			undefined,
			receiptId,
		);
		const event: WorkModeOperationEvent = {
			caseId: degraded ? "turn_admission.degraded" : "turn_admission.ready",
			phase: "turn_admission",
			state: degraded ? "degraded" : "ready",
			operationId: staged.operationId,
			acceptedFingerprint: staged.acceptedFingerprint,
			observedFingerprint: fresh.fingerprint,
			activationOwner: "admitted_lease",
			relation: receipt.relation,
			roleReadiness: fresh.roleReadiness,
			confirmation: receipt.confirmation,
			durable: receipt.durable,
			runtime: receipt.runtime,
			receipt,
			stagedFingerprint: staged.acceptedFingerprint,
			admittedFingerprint: fresh.fingerprint,
			turnLeaseId: lease.turnLeaseId,
			finalizationObligation: "required",
			admissionReceiptId: receiptId,
			admissionTokenId: tokenId,
		} as WorkModeOperationEvent;
		return requireTurnAdmissionResult(event);
	}
}
