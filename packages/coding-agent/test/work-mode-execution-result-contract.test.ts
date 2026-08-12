import { expect, test } from "bun:test";
import type {
	WorkModeExecutionCaseId,
	WorkModeExecutionCaseMap,
	WorkModeTurnFinalizeCaseMap,
} from "../src/config/work-mode-execution-cases";
import type {
	RuntimeActivationStatus,
	WorkModeEventPhase,
	WorkModeExecutionResult,
	WorkModeFingerprint,
	WorkModeFingerprintRelation,
	WorkModeOperationFailureCode,
	WorkModeOperationReceipt,
	WorkModeRoleReadiness,
	WorkModeTurnFinalizeEvent,
} from "../src/config/work-mode-result";

const COMPLETE_FINGERPRINT: WorkModeFingerprint = {
	schema: "work-mode-fingerprint.v1",
	digest: "work-mode-test-fingerprint",
	payload: {
		schema: "work-mode-fingerprint.v1",
		catalog: {
			presence: "present",
			value: {
				version: 1,
				modeId: "quick-edit",
				profileId: "codex-eco",
				entryDigest: "catalog-entry",
			},
		},
		bundledDefinition: {
			presence: "present",
			value: {
				profileId: "codex-eco",
				source: "builtin",
				definitionDigest: "definition",
				requiredProviders: ["openai-codex"],
				alternativeProviderGroups: [],
				modelMapping: {
					default: "openai-codex/gpt-5.6-terra:low",
					executor: "openai-codex/gpt-5.6-luna:low",
					planner: "openai-codex/gpt-5.6-luna:high",
					critic: null,
					architect: null,
				},
			},
		},
		effectiveDefinition: {
			presence: "present",
			value: {
				profileId: "codex-eco",
				source: "builtin",
				definitionDigest: "definition",
				requiredProviders: ["openai-codex"],
				alternativeProviderGroups: [],
				modelMapping: {
					default: "openai-codex/gpt-5.6-terra:low",
					executor: "openai-codex/gpt-5.6-luna:low",
					planner: "openai-codex/gpt-5.6-luna:high",
					critic: null,
					architect: null,
				},
			},
		},
		registryResolution: {
			presence: "present",
			value: {
				registryRevision: "registry",
				resolutionRevision: "resolution",
				resolutionDigest: "resolved",
			},
		},
		readiness: {
			presence: "present",
			value: {
				strictProviders: [{ providerId: "openai-codex", state: "ready" }],
				alternativeGroups: [],
			},
		},
		roles: [
			{
				presence: "present",
				value: {
					role: "default",
					requested: "openai-codex/gpt-5.6-terra:low",
					resolved: "openai-codex/gpt-5.6-terra:low",
					effort: "low",
					state: "resolved",
				},
			},
			{
				presence: "present",
				value: {
					role: "executor",
					requested: "openai-codex/gpt-5.6-luna:low",
					resolved: "openai-codex/gpt-5.6-luna:low",
					effort: "low",
					state: "resolved",
				},
			},
			{
				presence: "present",
				value: {
					role: "planner",
					requested: "openai-codex/gpt-5.6-luna:high",
					resolved: "openai-codex/gpt-5.6-luna:high",
					effort: "high",
					state: "resolved",
				},
			},
			{
				presence: "present",
				value: {
					role: "critic",
					requested: null,
					resolved: null,
					effort: null,
					state: "not_configured",
				},
			},
			{
				presence: "present",
				value: {
					role: "architect",
					requested: null,
					resolved: null,
					effort: null,
					state: "not_configured",
				},
			},
		],
		fallback: {
			presence: "present",
			value: {
				defaultChain: ["openai-codex/gpt-5.6-terra:low"],
				activeIndex: 0,
				skips: [],
			},
		},
		confirmation: { required: false, roleDegradation: [] },
	},
};

const COMPLETE_READINESS: WorkModeRoleReadiness = {
	kind: "complete",
	confirmation: "not_required",
};
const COMPLETE_CONFIRMATION: Readonly<{ required: boolean; accepted: boolean }> = {
	required: false,
	accepted: true,
};
const EQUAL_RELATION: WorkModeFingerprintRelation = {
	kind: "equal",
	accepted: COMPLETE_FINGERPRINT,
	observed: COMPLETE_FINGERPRINT,
};
const PARTIAL_RUNTIME: RuntimeActivationStatus = {
	kind: "rejected",
	code: "turn_activation_failed",
};
const ADMITTED_RUNTIME: RuntimeActivationStatus = {
	kind: "admitted",
	turnLeaseId: "turn-lease",
};
const RESTORED_RUNTIME: RuntimeActivationStatus = { kind: "restored" };

function makeReceipt(
	phase: WorkModeEventPhase,
	runtime: RuntimeActivationStatus,
	reason: WorkModeOperationFailureCode | null,
): WorkModeOperationReceipt {
	return {
		schema: "work-mode-receipt.v1",
		version: 1,
		receiptId: `${phase}-receipt`,
		operationId: `${phase}-operation`,
		phase,
		scope: "turn",
		acceptedFingerprint: COMPLETE_FINGERPRINT,
		observedFingerprint: COMPLETE_FINGERPRINT,
		relation: EQUAL_RELATION,
		roleReadiness: COMPLETE_READINESS,
		confirmation: COMPLETE_CONFIRMATION,
		durable: { kind: "not_requested" },
		runtime,
		reason,
		timing: { startedAt: 1, finishedAt: 2 },
		facts: {},
	};
}

const PARTIAL_CLEANUP_RESULT = {
	caseId: "turn_admission.unavailable.runtime.activation_failed",
	phase: "turn_admission",
	state: "unavailable",
	operationId: "turn-admission-partial",
	acceptedFingerprint: COMPLETE_FINGERPRINT,
	observedFingerprint: COMPLETE_FINGERPRINT,
	activationOwner: "partial_cleanup",
	relation: EQUAL_RELATION,
	roleReadiness: COMPLETE_READINESS,
	confirmation: COMPLETE_CONFIRMATION,
	durable: { kind: "not_requested" },
	runtime: PARTIAL_RUNTIME,
	receipt: makeReceipt("turn_admission", PARTIAL_RUNTIME, "turn_activation_failed"),
	partialActivationId: "partial-activation",
	setupCheckpoint: "setup_verified",
	admissionTokenId: "admission-token",
} satisfies WorkModeExecutionCaseMap["turn_admission.unavailable.runtime.activation_failed"];

const ADMITTED_RESULT = {
	caseId: "turn_admission.ready",
	phase: "turn_admission",
	state: "ready",
	operationId: "turn-admission-admitted",
	acceptedFingerprint: COMPLETE_FINGERPRINT,
	observedFingerprint: COMPLETE_FINGERPRINT,
	activationOwner: "admitted_lease",
	relation: EQUAL_RELATION,
	roleReadiness: COMPLETE_READINESS,
	confirmation: COMPLETE_CONFIRMATION,
	durable: { kind: "not_requested" },
	runtime: ADMITTED_RUNTIME,
	receipt: makeReceipt("turn_admission", ADMITTED_RUNTIME, null),
	stagedFingerprint: COMPLETE_FINGERPRINT,
	admittedFingerprint: COMPLETE_FINGERPRINT,
	turnLeaseId: "turn-lease",
	admissionReceiptId: "admission-receipt",
	admissionTokenId: "admission-token",
	finalizationObligation: "required",
} satisfies WorkModeExecutionCaseMap["turn_admission.ready"];

const FINALIZE_RESULT = {
	caseId: "turn_finalize.ready",
	phase: "turn_finalize",
	state: "ready",
	operationId: "turn-admission-admitted",
	acceptedFingerprint: COMPLETE_FINGERPRINT,
	observedFingerprint: COMPLETE_FINGERPRINT,
	activationOwner: "admitted_lease",
	relation: EQUAL_RELATION,
	roleReadiness: COMPLETE_READINESS,
	confirmation: COMPLETE_CONFIRMATION,
	durable: { kind: "not_requested" },
	runtime: RESTORED_RUNTIME,
	receipt: makeReceipt("turn_finalize", RESTORED_RUNTIME, null),
	admissionReceiptId: "admission-receipt",
	turnLeaseId: "turn-lease",
	admittedFingerprint: COMPLETE_FINGERPRINT,
	finalReason: "completed",
	finalizationReceiptId: "finalization-receipt",
} satisfies WorkModeTurnFinalizeCaseMap["turn_finalize.ready"];

const EXECUTION_RESULTS: readonly WorkModeExecutionResult[] = [PARTIAL_CLEANUP_RESULT, ADMITTED_RESULT];
const FINALIZATION_RESULTS: readonly WorkModeTurnFinalizeEvent[] = [FINALIZE_RESULT];

const INVALID_PARTIAL_CLEANUP: WorkModeExecutionCaseMap["turn_admission.unavailable.runtime.activation_failed"] = {
	...PARTIAL_CLEANUP_RESULT,
	// @ts-expect-error Partial cleanup cannot carry admitted lease metadata.
	turnLeaseId: "forbidden-lease",
};

const { admissionReceiptId: omittedAdmissionReceipt, ...ADMITTED_WITHOUT_REFERENCE } = ADMITTED_RESULT;
// @ts-expect-error Admitted results require the admission receipt reference.
const INVALID_ADMITTED_RESULT: WorkModeExecutionCaseMap["turn_admission.ready"] = ADMITTED_WITHOUT_REFERENCE;

const { finalizationReceiptId: omittedFinalizationReceipt, ...FINALIZE_WITHOUT_REFERENCE } = FINALIZE_RESULT;
// @ts-expect-error Finalization results require the finalization receipt reference.
const INVALID_FINALIZE_RESULT: WorkModeTurnFinalizeCaseMap["turn_finalize.ready"] = FINALIZE_WITHOUT_REFERENCE;

void omittedAdmissionReceipt;
void omittedFinalizationReceipt;
void INVALID_PARTIAL_CLEANUP;
void INVALID_ADMITTED_RESULT;
void INVALID_FINALIZE_RESULT;

const CASE_IDS: readonly WorkModeExecutionCaseId[] = [
	...EXECUTION_RESULTS.map(result => result.caseId),
	...FINALIZATION_RESULTS.map(result => result.caseId),
];

test("public execution results preserve discriminated partial-cleanup ownership", () => {
	expect(EXECUTION_RESULTS.map(result => result.caseId)).toEqual([
		"turn_admission.unavailable.runtime.activation_failed",
		"turn_admission.ready",
	]);
	expect(PARTIAL_CLEANUP_RESULT.activationOwner).toBe("partial_cleanup");
	expect(PARTIAL_CLEANUP_RESULT).not.toHaveProperty("turnLeaseId");
	expect(PARTIAL_CLEANUP_RESULT).not.toHaveProperty("admissionReceiptId");
	expect(PARTIAL_CLEANUP_RESULT).not.toHaveProperty("finalizationObligation");
	expect(PARTIAL_CLEANUP_RESULT).not.toHaveProperty("finalizationReceiptId");
});

test("admitted results carry every lease and admission reference", () => {
	expect(ADMITTED_RESULT.activationOwner).toBe("admitted_lease");
	expect(ADMITTED_RESULT.turnLeaseId).toBe("turn-lease");
	expect(ADMITTED_RESULT.admissionReceiptId).toBe("admission-receipt");
	expect(ADMITTED_RESULT.admissionTokenId).toBe("admission-token");
	expect(ADMITTED_RESULT.finalizationObligation).toBe("required");
	expect(ADMITTED_RESULT.stagedFingerprint).toBe(COMPLETE_FINGERPRINT);
	expect(ADMITTED_RESULT.admittedFingerprint).toBe(COMPLETE_FINGERPRINT);
});

test("finalization results carry the admitted lease and both receipt references", () => {
	expect(FINALIZATION_RESULTS.map(result => result.caseId)).toEqual(["turn_finalize.ready"]);
	expect(FINALIZE_RESULT.activationOwner).toBe("admitted_lease");
	expect(FINALIZE_RESULT.admissionReceiptId).toBe("admission-receipt");
	expect(FINALIZE_RESULT.turnLeaseId).toBe("turn-lease");
	expect(FINALIZE_RESULT.finalizationReceiptId).toBe("finalization-receipt");
	expect(FINALIZE_RESULT.admittedFingerprint).toBe(COMPLETE_FINGERPRINT);
	expect(FINALIZE_RESULT.finalReason).toBe("completed");
});

test("all representative public results retain their normative case IDs", () => {
	expect(CASE_IDS).toEqual([
		"turn_admission.unavailable.runtime.activation_failed",
		"turn_admission.ready",
		"turn_finalize.ready",
	]);
});
