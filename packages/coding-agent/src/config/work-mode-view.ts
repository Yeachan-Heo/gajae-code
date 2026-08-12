import { truncateToWidth } from "@gajae-code/tui";
import { CURATED_WORK_MODES, getCuratedWorkMode, type WorkModeId } from "./work-mode-catalog";

import { WORK_MODE_EXECUTION_CASES, type WorkModeExecutionCaseId } from "./work-mode-execution-cases";
import {
	type DurableMutationStatus,
	type FingerprintFact,
	type RoleId,
	type RuntimeActivationStatus,
	relateWorkModeFingerprints,
	WORK_MODE_ROLE_IDS,
	type WorkModeEventPhase,
	type WorkModeExecutionResult,
	type WorkModeFingerprint,
	type WorkModeOperationEvent,
	type WorkModeOperationFailureCode,
	type WorkModeOperationReceipt,
	type WorkModePreviewResult,
	type WorkModeRoleDegradation,
	type WorkModeRoleReadiness,
} from "./work-mode-result";

const ANSI_OSC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x9d[^\x07\x9c]*(?:\x07|\x9c)/g;
const ANSI_STRING_RE = /\x1b(?:P|_|\^)[\s\S]*?\x1b\\|[\x90\x9e\x9f][\s\S]*?\x9c/g;
const ANSI_CSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]|\x9b[0-?]*[ -/]*[@-~]/g;
const ANSI_SINGLE_RE = /\x1b[@-Z\\-_]/g;

function safeText(value: unknown, fallback = ""): string {
	if (typeof value !== "string") return fallback;
	return value
		.replace(ANSI_OSC_RE, "")
		.replace(ANSI_STRING_RE, "")
		.replace(ANSI_CSI_RE, "")
		.replace(ANSI_SINGLE_RE, "")
		.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function safeId(value: unknown, fallback = "unknown"): string {
	return safeText(value, fallback) || fallback;
}

function renderLine(value: string, width: number | undefined): string {
	const text = safeText(value);
	return width === undefined || width <= 0 ? text : truncateToWidth(text, width);
}

function assertNever(_value: never): never {
	throw new Error("Unsupported Work Mode view case.");
}

export type WorkModeScope = "turn" | "session" | "project" | "user";
export type { WorkModeId };

export const WORK_MODE_SCOPE_CHOICES: readonly Readonly<{
	scope: WorkModeScope;
	label: string;
}>[] = Object.freeze([
	Object.freeze({ scope: "turn", label: "Apply this turn" }),
	Object.freeze({ scope: "session", label: "Apply this session" }),
	Object.freeze({ scope: "project", label: "Set project default (next session)" }),
	Object.freeze({ scope: "user", label: "Set user default (next session)" }),
]);

export type WorkModeProfileClassification =
	| Readonly<{ kind: "curated"; modeId: WorkModeId; profileId: string }>
	| Readonly<{
			kind: "custom";
			profileId: string;
			reason: "unmatched" | "shadowed" | "unavailable";
	  }>;

export interface WorkModeSelectorCard {
	readonly kind: "work-mode";
	readonly modeId: WorkModeId;
	readonly label: string;
	readonly taskContext: string;
	readonly profileId: string;
	readonly searchText: string;
	readonly classification: "curated";
	readonly disabled: boolean;
	readonly disabledReason?: string;
}

export interface WorkModeCustomProfileCard {
	readonly kind: "custom-profile";
	readonly label: "Custom profile";
	readonly profileId: string;
	readonly classification: "custom";
	readonly reason: "unmatched" | "shadowed" | "unavailable";
}

export function classifyWorkModeProfile(
	profileId: string | undefined,
	options: { readonly source?: "builtin" | "user"; readonly available?: boolean } = {},
): WorkModeProfileClassification {
	const normalized = safeId(profileId, "");
	const mode = CURATED_WORK_MODES.find(candidate => candidate.profileId === normalized);
	if (mode && options.source !== "user" && options.available !== false) {
		return Object.freeze({ kind: "curated", modeId: mode.id, profileId: mode.profileId });
	}
	return Object.freeze({
		kind: "custom",
		profileId: normalized || "unknown",
		reason:
			mode && options.source === "user" ? "shadowed" : options.available === false ? "unavailable" : "unmatched",
	});
}

export function createWorkModeSelectorCards(
	options: {
		readonly unavailableModeIds?: ReadonlySet<string>;
		readonly unavailableReasons?: ReadonlyMap<string, string>;
	} = {},
): readonly WorkModeSelectorCard[] {
	return Object.freeze(
		CURATED_WORK_MODES.map(mode => {
			const disabled = options.unavailableModeIds?.has(mode.id) === true;
			return Object.freeze({
				kind: "work-mode" as const,
				modeId: mode.id,
				label: safeText(mode.label, mode.id),
				taskContext: safeText(mode.taskContext),
				profileId: safeId(mode.profileId),
				searchText: [mode.id, mode.label, mode.taskContext, ...mode.searchTerms, mode.profileId]
					.map(value => safeText(value))
					.join(" "),
				classification: "curated" as const,
				disabled,
				disabledReason: disabled ? safeText(options.unavailableReasons?.get(mode.id), "Unavailable") : undefined,
			});
		}),
	);
}

export const buildWorkModeSelectorCards = createWorkModeSelectorCards;

export interface WorkModeScopeChoiceView {
	readonly scope: WorkModeScope;
	readonly label: string;
	readonly enabled: boolean;
	readonly reason?: string;
}

export function createWorkModeScopeSelectionView(
	options: {
		readonly selectedScope?: WorkModeScope;
		readonly disabledScopes?: ReadonlySet<WorkModeScope>;
		readonly disabledReasons?: ReadonlyMap<WorkModeScope, string>;
	} = {},
): Readonly<{
	readonly choices: readonly WorkModeScopeChoiceView[];
	readonly selectedScope: WorkModeScope;
}> {
	const selectedScope = options.selectedScope ?? "turn";
	return Object.freeze({
		choices: Object.freeze(
			WORK_MODE_SCOPE_CHOICES.map(choice => {
				const enabled = options.disabledScopes?.has(choice.scope) !== true;
				return Object.freeze({
					...choice,
					enabled,
					reason: enabled ? undefined : safeText(options.disabledReasons?.get(choice.scope), "Unavailable"),
				});
			}),
		),
		selectedScope,
	});
}

export const buildWorkModeScopeSelectionView = createWorkModeScopeSelectionView;

export interface WorkModeProviderReadinessView {
	readonly strictProviders: readonly Readonly<{ providerId: string; state: "ready" | "missing" }>[];
	readonly alternativeGroups: readonly Readonly<{
		providerIds: readonly string[];
		state: "ready" | "missing";
		selectedProviderId: string | null;
	}>[];
}

export interface WorkModeRoleFactView {
	readonly role: RoleId;
	readonly requested: string | null;
	readonly resolved: string | null;
	readonly effort: string | null;
	readonly state: "resolved" | "unresolved" | "not_configured" | "unavailable";
}

export interface WorkModeFallbackView {
	readonly defaultChain: readonly string[];
	readonly activeIndex: number | null;
	readonly skips: readonly Readonly<{ selector: string; reason: string }>[];
}

export interface WorkModePreviewView {
	readonly kind: "preview";
	readonly modeId: string;
	readonly label: string;
	readonly taskContext: string;
	readonly profileId: string;
	readonly state: WorkModePreviewResult["state"];
	readonly reason?: WorkModeOperationFailureCode;
	readonly safeDetails?: Readonly<{ code: WorkModeOperationFailureCode; category: string }>;
	readonly roleReadiness: WorkModeRoleReadiness | null;
	readonly confirmationRequired: boolean;
	readonly providerReadiness: WorkModeProviderReadinessView | null;
	readonly roles: readonly WorkModeRoleFactView[];
	readonly fallback: WorkModeFallbackView | null;
	readonly degradation: readonly WorkModeRoleDegradation[];
	readonly fingerprint: Readonly<{
		digest: string;
		qualified: boolean;
		catalogEntryDigest: string | null;
	}>;
	readonly classification: WorkModeProfileClassification;
	readonly recovery: WorkModeRecoveryView;
}

function factValue<T>(fact: FingerprintFact<T, string, string>): T | undefined {
	return fact.presence === "present" ? fact.value : undefined;
}

function readRoleFact(fact: WorkModeFingerprint["payload"]["roles"][number], role: RoleId): WorkModeRoleFactView {
	if (fact.presence === "present") {
		return Object.freeze({
			role,
			requested: fact.value.requested === null ? null : safeText(String(fact.value.requested)),
			resolved: fact.value.resolved === null ? null : safeText(fact.value.resolved),
			effort: fact.value.effort === null ? null : safeText(fact.value.effort),
			state: fact.value.state,
		});
	}
	return Object.freeze({
		role,
		requested: null,
		resolved: null,
		effort: null,
		state: "unavailable",
	});
}

function providerReadinessView(fingerprint: WorkModeFingerprint): WorkModeProviderReadinessView | null {
	const readiness = factValue(fingerprint.payload.readiness);
	if (!readiness) return null;
	return Object.freeze({
		strictProviders: Object.freeze(
			readiness.strictProviders.map(item =>
				Object.freeze({ providerId: safeId(item.providerId), state: item.state }),
			),
		),
		alternativeGroups: Object.freeze(
			readiness.alternativeGroups.map(group =>
				Object.freeze({
					providerIds: Object.freeze(group.providerIds.map(provider => safeId(provider))),
					state: group.state,
					selectedProviderId: group.selectedProviderId === null ? null : safeId(group.selectedProviderId),
				}),
			),
		),
	});
}

function fallbackView(fingerprint: WorkModeFingerprint): WorkModeFallbackView | null {
	const fallback = factValue(fingerprint.payload.fallback);
	if (!fallback) return null;
	return Object.freeze({
		defaultChain: Object.freeze(fallback.defaultChain.map(selector => safeText(selector))),
		activeIndex: fallback.activeIndex,
		skips: Object.freeze(
			fallback.skips.map(skip =>
				Object.freeze({ selector: safeText(skip.selector), reason: safeText(skip.reason) }),
			),
		),
	});
}

function recoveryFor(
	reason: WorkModeOperationFailureCode | undefined,
	state: WorkModePreviewView["state"],
): WorkModeRecoveryView {
	if (state === "degraded") return Object.freeze({ action: "confirm-degraded", label: "Confirm degraded Work Mode" });
	switch (reason) {
		case "preview_drift":
			return Object.freeze({ action: "re-preview", label: "Re-preview Work Mode" });
		case "required_provider_unauthenticated":
		case "alternative_provider_group_unavailable":
			return Object.freeze({ action: "authenticate-provider", label: "Authenticate a required provider" });
		case "curated_profile_shadowed":
		case "curated_profile_missing":
		case "curated_profile_malformed":
		case "curated_profile_mismatch":
			return Object.freeze({ action: "use-custom-profile", label: "Use Custom profile" });
		default:
			return Object.freeze({ action: "retry-preview", label: "Retry preview" });
	}
}

export type WorkModeRecoveryAction =
	| "confirm-degraded"
	| "re-preview"
	| "authenticate-provider"
	| "use-custom-profile"
	| "retry-preview"
	| "retry-apply"
	| "restore-runtime";

export interface WorkModeRecoveryView {
	readonly action: WorkModeRecoveryAction;
	readonly label: string;
}

export function createWorkModePreviewView(modeId: string, preview: WorkModePreviewResult): WorkModePreviewView {
	const mode = getCuratedWorkMode(modeId);
	const catalogFact = factValue(preview.fingerprint.payload.catalog);
	const profileId =
		preview.state === "ready" || preview.state === "degraded"
			? safeId(preview.facts.profileId, catalogFact?.profileId ?? mode?.profileId ?? modeId)
			: safeId(catalogFact?.profileId ?? mode?.profileId ?? modeId);
	const reason = preview.state === "unavailable" ? preview.reason : undefined;
	const roleReadiness = preview.state === "unavailable" ? null : preview.roleReadiness;
	const degradation = roleReadiness?.kind === "degraded" ? [...roleReadiness.unresolved] : [];
	const classification =
		reason === "curated_profile_shadowed"
			? classifyWorkModeProfile(profileId, { source: "user" })
			: classifyWorkModeProfile(profileId, { available: reason === undefined });
	const qualified =
		preview.state !== "unavailable" &&
		preview.fingerprint.payload.catalog.presence === "present" &&
		preview.fingerprint.payload.effectiveDefinition.presence === "present" &&
		preview.fingerprint.payload.effectiveDefinition.value.source === "builtin";
	return Object.freeze({
		kind: "preview" as const,
		modeId: safeId(mode?.id ?? modeId),
		label: safeText(mode?.label ?? modeId, modeId),
		taskContext: safeText(mode?.taskContext),
		profileId,
		state: preview.state,
		reason,
		safeDetails: preview.state === "unavailable" ? preview.details : undefined,
		roleReadiness,
		confirmationRequired: preview.state === "degraded" ? preview.confirmationRequired : false,
		providerReadiness: providerReadinessView(preview.fingerprint),
		roles: Object.freeze(
			WORK_MODE_ROLE_IDS.map((role, index) => readRoleFact(preview.fingerprint.payload.roles[index]!, role)),
		),
		fallback: fallbackView(preview.fingerprint),
		degradation: Object.freeze(degradation),
		fingerprint: Object.freeze({
			digest: safeId(preview.fingerprint.digest, "unavailable"),
			qualified,
			catalogEntryDigest: catalogFact?.entryDigest ?? null,
		}),
		classification,
		recovery: recoveryFor(reason, preview.state),
	});
}

export const buildWorkModePreviewView = createWorkModePreviewView;
export const createWorkModeExplainView = createWorkModePreviewView;
export const buildWorkModeExplainView = createWorkModePreviewView;

export interface WorkModeStatusQualification {
	readonly qualified: boolean;
	readonly modeId: string | null;
	readonly profileId: string | null;
	readonly relation: "equal" | "changed" | "not_observed";
}

export interface WorkModeStatusView {
	readonly kind: "status";
	readonly phase: WorkModeEventPhase;
	readonly status:
		| "applied"
		| "staged"
		| "admitted"
		| "committed"
		| "committed-unconfirmed"
		| "pending"
		| "drifted"
		| "conflict"
		| "locked"
		| "rejected"
		| "write-failure"
		| "partial-activation"
		| "partial-rollback"
		| "pre-gate-settlement"
		| "finalization-success"
		| "finalization-failure";
	readonly label: string;
	readonly detail: string;
	readonly qualification: WorkModeStatusQualification;
	readonly classification: WorkModeProfileClassification;
	readonly recovery: WorkModeRecoveryView;
	readonly reason: WorkModeOperationFailureCode | null;
	readonly receipt: Readonly<{
		operationId: string;
		receiptId: string;
		scope: WorkModeOperationReceipt["scope"];
		phase: WorkModeEventPhase;
		durable: DurableMutationStatus["kind"];
		runtime: RuntimeActivationStatus["kind"];
	}>;
}

function executionStatus(event: WorkModeExecutionResult): WorkModeStatusView["status"] {
	switch (event.caseId) {
		case "session_apply.ready":
		case "session_apply.degraded":
			return "applied";
		case "session_apply.unavailable":
			return "rejected";
		case "session_apply.drifted":
		case "persistent_apply.drifted":
		case "turn_stage.drifted":
		case "turn_admission.drifted":
			return "drifted";
		case "persistent_apply.ready.committed":
		case "persistent_apply.degraded.committed":
			return "committed";
		case "persistent_apply.ready.committed_unconfirmed":
		case "persistent_apply.degraded.committed_unconfirmed":
			return "committed-unconfirmed";
		case "persistent_apply.unavailable.prewrite":
			return "rejected";
		case "persistent_apply.unavailable.mutation":
			if (
				event.receipt.reason === "persistent_write_failed" ||
				(event.runtime.kind === "rejected" && event.runtime.code === "persistent_write_failed")
			) {
				return "write-failure";
			}
			switch (event.durable.kind) {
				case "conflict":
					return "conflict";
				case "locked":
					return "locked";
				case "rejected":
					return "rejected";
				default:
					return "rejected";
			}
		case "turn_stage.ready":
		case "turn_stage.degraded":
			return "staged";
		case "turn_stage.unavailable":
			return "rejected";
		case "turn_admission.ready":
		case "turn_admission.degraded":
			return "admitted";
		case "turn_admission.unavailable.runtime.activation_failed":
			return "partial-activation";
		case "turn_admission.unavailable.runtime.rollback_failed":
			return "partial-rollback";
		case "turn_admission.unavailable.pre_gate_cancelled":
		case "turn_admission.unavailable.pre_gate_rejected":
			return "pre-gate-settlement";
		default:
			return assertNever(event);
	}
}

function finalizationStatus(
	event: Extract<WorkModeOperationEvent, { phase: "turn_finalize" }>,
): WorkModeStatusView["status"] {
	switch (event.caseId) {
		case "turn_finalize.ready":
		case "turn_finalize.degraded":
			return "finalization-success";
		case "turn_finalize.unavailable.restore_failed":
			return "finalization-failure";
		default:
			return assertNever(event);
	}
}

function statusDetail(status: WorkModeStatusView["status"], reason: WorkModeOperationFailureCode | null): string {
	switch (status) {
		case "applied":
			return "Work Mode applied for this session.";
		case "staged":
			return "Work Mode staged for this turn.";
		case "admitted":
			return "Work Mode admitted for this turn.";
		case "committed":
			return "Work Mode default committed for the next session.";
		case "committed-unconfirmed":
			return "Work Mode default committed; reload confirmation is unavailable.";
		case "drifted":
			return "Work Mode changed while it was pending; re-preview before applying.";
		case "conflict":
			return "Work Mode default conflicted with a newer configuration.";
		case "locked":
			return "Work Mode default is locked by configuration policy.";
		case "write-failure":
			return "Work Mode default could not be written.";
		case "partial-activation":
			return "Work Mode activation stopped part-way through; runtime cleanup was attempted.";
		case "partial-rollback":
			return "Work Mode runtime rollback failed; recovery is required before another turn.";
		case "pre-gate-settlement":
			return "Work Mode turn admission was settled before dispatch.";
		case "finalization-success":
			return "Work Mode runtime was finalized.";
		case "finalization-failure":
			return "Work Mode runtime finalization failed; restore the runtime before continuing.";
		case "rejected":
			return reason ? `Work Mode was not applied (${safeText(reason)}).` : "Work Mode was not applied.";
		case "pending":
			return "Work Mode operation is pending.";
	}
}

function recoveryForStatus(status: WorkModeStatusView["status"]): WorkModeRecoveryView {
	switch (status) {
		case "drifted":
			return Object.freeze({ action: "re-preview", label: "Re-preview Work Mode" });
		case "partial-rollback":
		case "finalization-failure":
			return Object.freeze({ action: "restore-runtime", label: "Restore Work Mode runtime" });
		case "conflict":
		case "locked":
		case "write-failure":
		case "rejected":
		case "partial-activation":
		case "pre-gate-settlement":
			return Object.freeze({ action: "retry-apply", label: "Retry Work Mode" });
		default:
			return Object.freeze({ action: "retry-preview", label: "Review Work Mode" });
	}
}

function eventReason(event: WorkModeOperationEvent): WorkModeOperationFailureCode | null {
	if (event.phase === "preview") return event.state === "unavailable" ? event.reason : null;
	if (event.phase === "turn_finalize")
		return event.caseId === "turn_finalize.unavailable.restore_failed" ? "turn_rollback_failed" : null;
	if ("reason" in event && typeof event.reason === "string") return event.reason as WorkModeOperationFailureCode;
	return event.receipt.reason;
}

function eventExecutionPhase(event: WorkModeOperationEvent): WorkModeEventPhase {
	return event.phase === "preview" ? "session_apply" : event.phase;
}

export function qualifyWorkModeStatus(options: {
	readonly event: Exclude<WorkModeOperationEvent, { phase: "preview" }>;
	readonly currentProfileId?: string;
	readonly currentFingerprint?: WorkModeFingerprint;
	readonly currentPhase?: WorkModeEventPhase;
}): WorkModeStatusQualification {
	const event = options.event;
	const acceptedCatalog = event.acceptedFingerprint.payload.catalog;
	const acceptedProfileId = acceptedCatalog.presence === "present" ? acceptedCatalog.value.profileId : null;
	const modeId = acceptedCatalog.presence === "present" ? acceptedCatalog.value.modeId : null;
	const relation = options.currentFingerprint
		? relateWorkModeFingerprints(event.acceptedFingerprint, options.currentFingerprint).kind
		: "not_observed";
	const qualified =
		acceptedProfileId !== null &&
		options.currentProfileId === acceptedProfileId &&
		options.currentFingerprint !== undefined &&
		relation === "equal" &&
		options.currentPhase !== undefined &&
		options.currentPhase === event.phase;
	return Object.freeze({ qualified, modeId, profileId: acceptedProfileId, relation });
}

export function createWorkModeStatusView(
	event: Exclude<WorkModeOperationEvent, { phase: "preview" }>,
	options: {
		readonly currentProfileId?: string;
		readonly currentFingerprint?: WorkModeFingerprint;
		readonly currentPhase?: WorkModeEventPhase;
	} = {},
): WorkModeStatusView {
	const status = event.phase === "turn_finalize" ? finalizationStatus(event) : executionStatus(event);
	const reason = eventReason(event);
	const qualification = qualifyWorkModeStatus({ event, ...options });
	const mode = qualification.modeId ? getCuratedWorkMode(qualification.modeId) : undefined;
	const classification: WorkModeProfileClassification =
		qualification.qualified && mode
			? Object.freeze({ kind: "curated", modeId: mode.id, profileId: mode.profileId })
			: Object.freeze({
					kind: "custom",
					profileId: safeId(options.currentProfileId ?? qualification.profileId, "unknown"),
					reason:
						qualification.relation === "changed"
							? "shadowed"
							: qualification.profileId
								? "unavailable"
								: "unmatched",
				});
	return Object.freeze({
		kind: "status" as const,
		phase: eventExecutionPhase(event),
		status,
		label: qualification.qualified && mode ? safeText(mode.label, mode.id) : "Custom profile",
		detail: statusDetail(status, reason),
		qualification,
		classification,
		recovery: recoveryForStatus(status),
		reason,
		receipt: Object.freeze({
			operationId: safeId(event.receipt.operationId),
			receiptId: safeId(event.receipt.receiptId),
			scope: event.receipt.scope,
			phase: event.receipt.phase,
			durable: event.receipt.durable.kind,
			runtime: event.receipt.runtime.kind,
		}),
	});
}

export const buildWorkModeStatusView = createWorkModeStatusView;

export function createPendingWorkModeStatusView(modeId?: string): Readonly<{
	kind: "status";
	status: "pending";
	label: string;
	detail: string;
	modeId: string | null;
}> {
	const mode = modeId ? getCuratedWorkMode(modeId) : undefined;
	return Object.freeze({
		kind: "status" as const,
		status: "pending" as const,
		label: safeText(mode?.label ?? "Custom profile"),
		detail: statusDetail("pending", null),
		modeId: mode?.id ?? null,
	});
}

export function createWorkModeReceiptView(
	event: Exclude<WorkModeOperationEvent, { phase: "preview" }>,
): WorkModeOperationReceipt {
	return event.receipt;
}

export interface WorkModePaletteEntry {
	readonly id: `work-mode:${WorkModeId}`;
	readonly modeId: WorkModeId;
	readonly label: string;
	readonly category: "Work Modes";
	readonly description: string;
	readonly searchText: string;
	readonly disabled: boolean;
	readonly disabledReason?: string;
}

export function createWorkModePaletteEntries(
	options: {
		readonly unavailableModeIds?: ReadonlySet<string>;
		readonly unavailableReasons?: ReadonlyMap<string, string>;
	} = {},
): readonly WorkModePaletteEntry[] {
	return Object.freeze(
		createWorkModeSelectorCards(options).map(card =>
			Object.freeze({
				id: `work-mode:${card.modeId}` as const,
				modeId: card.modeId,
				label: `Work Mode: ${card.label}`,
				category: "Work Modes" as const,
				description: `${card.taskContext} Profile ${card.profileId}.`,
				searchText: card.searchText,
				disabled: card.disabled,
				disabledReason: card.disabledReason,
			}),
		),
	);
}

export const buildWorkModePaletteEntries = createWorkModePaletteEntries;

export function renderWorkModePreviewLines(view: WorkModePreviewView, width?: number): readonly string[] {
	const lines: string[] = [
		`${view.label} — ${view.taskContext}`,
		`Profile: ${view.profileId}`,
		`State: ${view.state}${view.confirmationRequired ? " (confirmation required)" : ""}`,
		...(view.confirmationRequired ? ["confirmation required"] : []),
		`Fingerprint: ${view.fingerprint.qualified ? "qualified" : "not qualified"} ${view.fingerprint.digest}`,
	];
	lines.splice(
		1,
		0,
		`Classification: ${view.classification.kind}${view.classification.kind === "custom" ? ` (${view.classification.reason})` : ""}`,
	);
	if (view.providerReadiness) {
		for (const provider of view.providerReadiness.strictProviders) {
			lines.push(`Required provider: ${provider.providerId} (${provider.state})`);
		}
		for (const group of view.providerReadiness.alternativeGroups) {
			lines.push(
				`Alternative providers: ${group.providerIds.join(" or ")} (${group.state}${group.selectedProviderId ? `; selected ${group.selectedProviderId}` : ""})`,
			);
		}
	}
	for (const role of view.roles) {
		lines.push(
			`${role.role}: requested ${role.requested ?? "—"}; resolved ${role.resolved ?? "—"}; effort ${role.effort ?? "—"} (${role.state})`,
		);
	}
	if (view.fallback) {
		lines.push(`Fallback chain: ${view.fallback.defaultChain.join(" → ") || "none"}`);
		for (const skip of view.fallback.skips) lines.push(`Fallback skipped: ${skip.selector} (${skip.reason})`);
	}
	for (const degradation of view.degradation) lines.push(`Degraded ${degradation.role}: ${degradation.reason}`);
	if (view.reason) lines.push(`Recovery: ${view.recovery.label}`);
	return Object.freeze(lines.map(line => renderLine(line, width)));
}

export function renderWorkModeScopeLines(
	view: Readonly<{ choices: readonly WorkModeScopeChoiceView[]; selectedScope: WorkModeScope }>,
	width?: number,
): readonly string[] {
	return Object.freeze(
		view.choices.map(choice => {
			const cursor = choice.scope === view.selectedScope ? "> " : "  ";
			const suffix = choice.enabled ? "" : ` (${choice.reason ?? "Unavailable"})`;
			return renderLine(`${cursor}${choice.label}${suffix}`, width);
		}),
	);
}

export function renderWorkModeStatusLines(view: WorkModeStatusView, width?: number): readonly string[] {
	return Object.freeze(
		[
			`${view.label}: ${view.status}`,
			view.detail,
			`Recovery: ${view.recovery.label}`,
			`Classification: ${view.classification.kind}${view.classification.kind === "custom" ? ` (${view.classification.reason})` : ""}`,
		].map(line => renderLine(line, width)),
	);
}

export function renderWorkModeExplainLines(view: WorkModePreviewView, width?: number): readonly string[] {
	return renderWorkModePreviewLines(view, width);
}

export type WorkModePublicCaseId = WorkModeExecutionCaseId;
export const WORK_MODE_PUBLIC_CASE_IDS: readonly WorkModePublicCaseId[] = Object.freeze(
	WORK_MODE_EXECUTION_CASES.map(candidate => candidate.caseId),
);

export const adaptWorkModePreview = createWorkModePreviewView;
export const adaptWorkModeOperation = createWorkModeStatusView;
export const adaptWorkModeEvent = createWorkModeStatusView;
export const renderWorkModePreview = renderWorkModePreviewLines;
export const renderWorkModeStatus = renderWorkModeStatusLines;
export const renderWorkModeScopeSelection = renderWorkModeScopeLines;
export const createWorkModeScopeView = createWorkModeScopeSelectionView;
export const createWorkModeStatusModel = createWorkModeStatusView;
export const createWorkModeReceiptModel = createWorkModeReceiptView;
export const createWorkModePaletteModel = createWorkModePaletteEntries;
