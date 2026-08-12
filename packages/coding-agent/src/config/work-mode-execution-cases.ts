import type {
	DurableMutationStatus,
	RuntimeActivationStatus,
	WorkModeExecutionPhase,
	WorkModeFingerprint,
	WorkModeFingerprintFact,
	WorkModeFingerprintRelation,
	WorkModeOperationFailureCode,
	WorkModeOperationReceipt,
	WorkModePreviewResult,
	WorkModeRoleReadiness,
	WorkModeState,
} from "./work-mode-result";

export type PartialActivationCheckpoint =
	| "none"
	| "provider_scope_opened"
	| "target_model_mutated"
	| "fallback_overlay_installed"
	| "role_overlays_applied"
	| "active_profile_set"
	| "setup_verified";

export type WorkModeExecutionOwnership = "none" | "partial_cleanup" | "admitted_lease";
export type WorkModeReceiptCardinality = 0 | 1;

export interface WorkModeExecutionCaseDefinition {
	readonly caseId: string;
	readonly phase: WorkModeExecutionPhase | "turn_finalize";
	readonly state: WorkModeState;
	readonly shape: "fresh" | "preview_drift" | "pre_gate" | "partial_cleanup" | "admitted" | "finalize";
	readonly legalReasons: readonly WorkModeOperationFailureCode[];
	readonly relation: "equal" | "changed" | "not_observed";
	readonly readiness: "complete" | "degraded" | "complete_or_degraded" | "spent";
	readonly durable: "not_requested" | "committed" | "committed_unconfirmed" | "locked" | "conflict" | "rejected";
	readonly runtime:
		| "not_requested"
		| "applied"
		| "staged"
		| "admitted"
		| "rejected"
		| "cancelled"
		| "restored"
		| "restore_failed";
	readonly ownership: WorkModeExecutionOwnership;
	readonly receiptCount: 1;
	readonly finalizeCount: 0 | 1;
}

function freezeExecutionCases<T extends readonly WorkModeExecutionCaseDefinition[]>(cases: T): T {
	return Object.freeze(cases.map(candidate => Object.freeze(candidate))) as unknown as T;
}

export const WORK_MODE_EXECUTION_CASES = freezeExecutionCases([
	{
		caseId: "session_apply.ready",
		phase: "session_apply",
		state: "ready",
		shape: "fresh",
		legalReasons: [],
		relation: "equal",
		readiness: "complete",
		durable: "not_requested",
		runtime: "applied",
		ownership: "none",
		receiptCount: 1,
		finalizeCount: 0,
	},
	{
		caseId: "session_apply.degraded",
		phase: "session_apply",
		state: "degraded",
		shape: "fresh",
		legalReasons: [],
		relation: "equal",
		readiness: "degraded",
		durable: "not_requested",
		runtime: "applied",
		ownership: "none",
		receiptCount: 1,
		finalizeCount: 0,
	},
	{
		caseId: "session_apply.unavailable",
		phase: "session_apply",
		state: "unavailable",
		shape: "fresh",
		legalReasons: ["session_activation_failed", "session_rollback_failed"],
		relation: "equal",
		readiness: "complete_or_degraded",
		durable: "not_requested",
		runtime: "rejected",
		ownership: "none",
		receiptCount: 1,
		finalizeCount: 0,
	},
	{
		caseId: "session_apply.drifted",
		phase: "session_apply",
		state: "drifted",
		shape: "preview_drift",
		legalReasons: ["preview_drift"],
		relation: "changed",
		readiness: "complete_or_degraded",
		durable: "not_requested",
		runtime: "rejected",
		ownership: "none",
		receiptCount: 1,
		finalizeCount: 0,
	},
	{
		caseId: "persistent_apply.ready.committed",
		phase: "persistent_apply",
		state: "ready",
		shape: "fresh",
		legalReasons: [],
		relation: "equal",
		readiness: "complete",
		durable: "committed",
		runtime: "not_requested",
		ownership: "none",
		receiptCount: 1,
		finalizeCount: 0,
	},
	{
		caseId: "persistent_apply.ready.committed_unconfirmed",
		phase: "persistent_apply",
		state: "ready",
		shape: "fresh",
		legalReasons: ["persistent_reload_unconfirmed", "persistent_reload_mismatch"],
		relation: "equal",
		readiness: "complete",
		durable: "committed_unconfirmed",
		runtime: "not_requested",
		ownership: "none",
		receiptCount: 1,
		finalizeCount: 0,
	},
	{
		caseId: "persistent_apply.degraded.committed",
		phase: "persistent_apply",
		state: "degraded",
		shape: "fresh",
		legalReasons: [],
		relation: "equal",
		readiness: "degraded",
		durable: "committed",
		runtime: "not_requested",
		ownership: "none",
		receiptCount: 1,
		finalizeCount: 0,
	},
	{
		caseId: "persistent_apply.degraded.committed_unconfirmed",
		phase: "persistent_apply",
		state: "degraded",
		shape: "fresh",
		legalReasons: ["persistent_reload_unconfirmed", "persistent_reload_mismatch"],
		relation: "equal",
		readiness: "degraded",
		durable: "committed_unconfirmed",
		runtime: "not_requested",
		ownership: "none",
		receiptCount: 1,
		finalizeCount: 0,
	},
	{
		caseId: "persistent_apply.unavailable.prewrite",
		phase: "persistent_apply",
		state: "unavailable",
		shape: "fresh",
		legalReasons: ["project_scope_unavailable"],
		relation: "equal",
		readiness: "complete_or_degraded",
		durable: "not_requested",
		runtime: "not_requested",
		ownership: "none",
		receiptCount: 1,
		finalizeCount: 0,
	},
	{
		caseId: "persistent_apply.unavailable.mutation",
		phase: "persistent_apply",
		state: "unavailable",
		shape: "fresh",
		legalReasons: ["scope_locked", "scope_conflict", "persistent_write_failed", "scope_rejected"],
		relation: "equal",
		readiness: "complete_or_degraded",
		durable: "rejected",
		runtime: "not_requested",
		ownership: "none",
		receiptCount: 1,
		finalizeCount: 0,
	},
	{
		caseId: "persistent_apply.drifted",
		phase: "persistent_apply",
		state: "drifted",
		shape: "preview_drift",
		legalReasons: ["preview_drift"],
		relation: "changed",
		readiness: "complete_or_degraded",
		durable: "not_requested",
		runtime: "not_requested",
		ownership: "none",
		receiptCount: 1,
		finalizeCount: 0,
	},
	{
		caseId: "turn_stage.ready",
		phase: "turn_stage",
		state: "ready",
		shape: "fresh",
		legalReasons: [],
		relation: "equal",
		readiness: "complete",
		durable: "not_requested",
		runtime: "staged",
		ownership: "none",
		receiptCount: 1,
		finalizeCount: 0,
	},
	{
		caseId: "turn_stage.degraded",
		phase: "turn_stage",
		state: "degraded",
		shape: "fresh",
		legalReasons: [],
		relation: "equal",
		readiness: "degraded",
		durable: "not_requested",
		runtime: "staged",
		ownership: "none",
		receiptCount: 1,
		finalizeCount: 0,
	},
	{
		caseId: "turn_stage.unavailable",
		phase: "turn_stage",
		state: "unavailable",
		shape: "fresh",
		legalReasons: ["turn_stage_rejected", "operation_unexpected"],
		relation: "equal",
		readiness: "complete_or_degraded",
		durable: "not_requested",
		runtime: "rejected",
		ownership: "none",
		receiptCount: 1,
		finalizeCount: 0,
	},
	{
		caseId: "turn_stage.drifted",
		phase: "turn_stage",
		state: "drifted",
		shape: "preview_drift",
		legalReasons: ["preview_drift"],
		relation: "changed",
		readiness: "complete_or_degraded",
		durable: "not_requested",
		runtime: "rejected",
		ownership: "none",
		receiptCount: 1,
		finalizeCount: 0,
	},
	{
		caseId: "turn_admission.ready",
		phase: "turn_admission",
		state: "ready",
		shape: "admitted",
		legalReasons: [],
		relation: "equal",
		readiness: "complete",
		durable: "not_requested",
		runtime: "admitted",
		ownership: "admitted_lease",
		receiptCount: 1,
		finalizeCount: 1,
	},
	{
		caseId: "turn_admission.degraded",
		phase: "turn_admission",
		state: "degraded",
		shape: "admitted",
		legalReasons: [],
		relation: "equal",
		readiness: "degraded",
		durable: "not_requested",
		runtime: "admitted",
		ownership: "admitted_lease",
		receiptCount: 1,
		finalizeCount: 1,
	},
	{
		caseId: "turn_admission.unavailable.runtime.activation_failed",
		phase: "turn_admission",
		state: "unavailable",
		shape: "partial_cleanup",
		legalReasons: ["turn_activation_failed"],
		relation: "equal",
		readiness: "complete_or_degraded",
		durable: "not_requested",
		runtime: "rejected",
		ownership: "partial_cleanup",
		receiptCount: 1,
		finalizeCount: 0,
	},
	{
		caseId: "turn_admission.unavailable.runtime.rollback_failed",
		phase: "turn_admission",
		state: "unavailable",
		shape: "partial_cleanup",
		legalReasons: ["turn_rollback_failed"],
		relation: "equal",
		readiness: "complete_or_degraded",
		durable: "not_requested",
		runtime: "restore_failed",
		ownership: "partial_cleanup",
		receiptCount: 1,
		finalizeCount: 0,
	},
	{
		caseId: "turn_admission.unavailable.pre_gate_cancelled",
		phase: "turn_admission",
		state: "unavailable",
		shape: "pre_gate",
		legalReasons: ["turn_admission_cancelled", "turn_admission_handoff_cancelled", "turn_admission_disposed"],
		relation: "not_observed",
		readiness: "spent",
		durable: "not_requested",
		runtime: "cancelled",
		ownership: "none",
		receiptCount: 1,
		finalizeCount: 0,
	},
	{
		caseId: "turn_admission.unavailable.pre_gate_rejected",
		phase: "turn_admission",
		state: "unavailable",
		shape: "pre_gate",
		legalReasons: ["turn_admission_setup_failed", "preflight_unexpected"],
		relation: "not_observed",
		readiness: "spent",
		durable: "not_requested",
		runtime: "rejected",
		ownership: "none",
		receiptCount: 1,
		finalizeCount: 0,
	},
	{
		caseId: "turn_admission.drifted",
		phase: "turn_admission",
		state: "drifted",
		shape: "preview_drift",
		legalReasons: ["preview_drift"],
		relation: "changed",
		readiness: "complete_or_degraded",
		durable: "not_requested",
		runtime: "rejected",
		ownership: "none",
		receiptCount: 1,
		finalizeCount: 0,
	},
	{
		caseId: "turn_finalize.ready",
		phase: "turn_finalize",
		state: "ready",
		shape: "finalize",
		legalReasons: [],
		relation: "equal",
		readiness: "complete",
		durable: "not_requested",
		runtime: "restored",
		ownership: "admitted_lease",
		receiptCount: 1,
		finalizeCount: 1,
	},
	{
		caseId: "turn_finalize.degraded",
		phase: "turn_finalize",
		state: "degraded",
		shape: "finalize",
		legalReasons: [],
		relation: "equal",
		readiness: "degraded",
		durable: "not_requested",
		runtime: "restored",
		ownership: "admitted_lease",
		receiptCount: 1,
		finalizeCount: 1,
	},
	{
		caseId: "turn_finalize.unavailable.restore_failed",
		phase: "turn_finalize",
		state: "unavailable",
		shape: "finalize",
		legalReasons: ["turn_rollback_failed"],
		relation: "equal",
		readiness: "complete_or_degraded",
		durable: "not_requested",
		runtime: "restore_failed",
		ownership: "admitted_lease",
		receiptCount: 1,
		finalizeCount: 1,
	},
] as const satisfies readonly WorkModeExecutionCaseDefinition[]);

export type WorkModeExecutionCase = (typeof WORK_MODE_EXECUTION_CASES)[number];
export type WorkModeExecutionCaseId = WorkModeExecutionCase["caseId"];
export type WorkModeFinalizationCase = Extract<WorkModeExecutionCase, { phase: "turn_finalize" }>;
export type WorkModeExecutionOnlyCase = Exclude<WorkModeExecutionCase, { phase: "turn_finalize" }>;

type CaseById<Id extends WorkModeExecutionCaseId> = Extract<WorkModeExecutionCase, { caseId: Id }>;

type CommonExecutionFields<D extends WorkModeExecutionCase> = Readonly<{
	caseId: D["caseId"];
	phase: D["phase"];
	state: D["state"];
	operationId: string;
	acceptedFingerprint: WorkModeFingerprint;
	observedFingerprint?: WorkModeFingerprint;
	relation: WorkModeFingerprintRelation;
	roleReadiness: WorkModeRoleReadiness;
	confirmation: Readonly<{ required: boolean; accepted: boolean }>;
	durable: DurableMutationStatus;
	runtime: RuntimeActivationStatus;
	receipt: WorkModeOperationReceipt;
}>;

type DriftFields = Readonly<{
	observedFingerprint: WorkModeFingerprint;
	reason: "preview_drift";
	changedFacts: readonly [WorkModeFingerprintFact, ...WorkModeFingerprintFact[]];
	rePreview: WorkModePreviewResult;
	appliedFingerprint?: never;
	committedFingerprint?: never;
	stagedFingerprint?: never;
	admittedFingerprint?: never;
}>;

type FreshEffectFields<D extends WorkModeExecutionCase> = D["phase"] extends "session_apply"
	? D["state"] extends "ready" | "degraded"
		? Readonly<{
				observedFingerprint: WorkModeFingerprint;
				appliedFingerprint: WorkModeFingerprint;
				committedFingerprint?: never;
				stagedFingerprint?: never;
				admittedFingerprint?: never;
			}>
		: Readonly<{
				observedFingerprint: WorkModeFingerprint;
				appliedFingerprint?: never;
				committedFingerprint?: never;
				stagedFingerprint?: never;
				admittedFingerprint?: never;
			}>
	: D["phase"] extends "persistent_apply"
		? D["state"] extends "ready" | "degraded"
			? Readonly<{
					observedFingerprint: WorkModeFingerprint;
					committedFingerprint: WorkModeFingerprint;
					appliedFingerprint?: never;
					stagedFingerprint?: never;
					admittedFingerprint?: never;
				}>
			: Readonly<{
					observedFingerprint: WorkModeFingerprint;
					committedFingerprint?: never;
					appliedFingerprint?: never;
					stagedFingerprint?: never;
					admittedFingerprint?: never;
				}>
		: D["phase"] extends "turn_stage"
			? D["state"] extends "ready" | "degraded"
				? Readonly<{
						observedFingerprint: WorkModeFingerprint;
						stagedFingerprint: WorkModeFingerprint;
						appliedFingerprint?: never;
						committedFingerprint?: never;
						admittedFingerprint?: never;
					}>
				: Readonly<{
						observedFingerprint: WorkModeFingerprint;
						stagedFingerprint?: never;
						appliedFingerprint?: never;
						committedFingerprint?: never;
						admittedFingerprint?: never;
					}>
			: D["phase"] extends "turn_admission"
				? D["ownership"] extends "admitted_lease"
					? Readonly<{
							observedFingerprint: WorkModeFingerprint;
							activationOwner: "admitted_lease";
							stagedFingerprint: WorkModeFingerprint;
							admittedFingerprint: WorkModeFingerprint;
							turnLeaseId: string;
							admissionReceiptId: string;
							admissionTokenId: string;
							finalizationObligation: "required";
							partialActivationId?: never;
							setupCheckpoint?: never;
							finalizationReceiptId?: never;
							appliedFingerprint?: never;
							committedFingerprint?: never;
						}>
					: Readonly<{
							observedFingerprint: WorkModeFingerprint;
							activationOwner: "partial_cleanup";
							partialActivationId: string;
							setupCheckpoint: PartialActivationCheckpoint;
							admissionTokenId: string;
							admittedFingerprint?: never;
							turnLeaseId?: never;
							admissionReceiptId?: never;
							finalizationObligation?: never;
							finalizationReceiptId?: never;
							appliedFingerprint?: never;
							committedFingerprint?: never;
							stagedFingerprint?: never;
						}>
				: Readonly<{
						appliedFingerprint?: never;
						committedFingerprint?: never;
						stagedFingerprint?: never;
						admittedFingerprint?: never;
					}>;

type ExecutionResultForCase<D extends WorkModeExecutionCase> = CommonExecutionFields<D> &
	(D["shape"] extends "preview_drift"
		? DriftFields
		: D["shape"] extends "pre_gate"
			? Readonly<{
					reason: D["legalReasons"][number];
					mustRestage: true;
					admissionTokenId: string;
					observedFingerprint?: never;
					admittedFingerprint?: never;
					turnLeaseId?: never;
					finalizationObligation?: never;
					partialActivationId?: never;
					setupCheckpoint?: never;
					appliedFingerprint?: never;
					committedFingerprint?: never;
					stagedFingerprint?: never;
				}>
			: D["shape"] extends "finalize"
				? Readonly<{
						observedFingerprint: WorkModeFingerprint;
						activationOwner: "admitted_lease";
						admissionReceiptId: string;
						turnLeaseId: string;
						admittedFingerprint: WorkModeFingerprint;
						finalReason: "completed" | "error" | "aborted" | "cancelled" | "handoff" | "disposed";
						finalizationReceiptId: string;
						partialActivationId?: never;
						setupCheckpoint?: never;
					}>
				: FreshEffectFields<D>);

export type WorkModeExecutionCaseMap = {
	[Id in WorkModeExecutionOnlyCase["caseId"]]: ExecutionResultForCase<CaseById<Id>>;
};

export type WorkModeTurnFinalizeCaseMap = {
	[Id in WorkModeFinalizationCase["caseId"]]: ExecutionResultForCase<CaseById<Id>>;
};

export function getWorkModeExecutionCase(caseId: WorkModeExecutionCaseId): WorkModeExecutionCase {
	const match = WORK_MODE_EXECUTION_CASES.find(candidate => candidate.caseId === caseId);
	if (!match) throw new Error("Unknown Work Mode execution case.");
	return match;
}

export function isWorkModeFinalizeCase(caseId: WorkModeExecutionCaseId): caseId is WorkModeFinalizationCase["caseId"] {
	return caseId.startsWith("turn_finalize.");
}
