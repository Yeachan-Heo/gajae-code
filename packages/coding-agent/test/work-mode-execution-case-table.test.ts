import { expect, test } from "bun:test";
import {
	getWorkModeExecutionCase,
	WORK_MODE_EXECUTION_CASES,
	type WorkModeExecutionCaseDefinition,
	type WorkModeExecutionCaseId,
} from "../src/config/work-mode-execution-cases";

type CaseRule = Pick<
	WorkModeExecutionCaseDefinition,
	"phase" | "state" | "receiptCount" | "finalizeCount" | "ownership"
>;

const NORMATIVE_CASE_IDS: readonly WorkModeExecutionCaseId[] = [
	"session_apply.ready",
	"session_apply.degraded",
	"session_apply.unavailable",
	"session_apply.drifted",
	"persistent_apply.ready.committed",
	"persistent_apply.ready.committed_unconfirmed",
	"persistent_apply.degraded.committed",
	"persistent_apply.degraded.committed_unconfirmed",
	"persistent_apply.unavailable.prewrite",
	"persistent_apply.unavailable.mutation",
	"persistent_apply.drifted",
	"turn_stage.ready",
	"turn_stage.degraded",
	"turn_stage.unavailable",
	"turn_stage.drifted",
	"turn_admission.ready",
	"turn_admission.degraded",
	"turn_admission.unavailable.runtime.activation_failed",
	"turn_admission.unavailable.runtime.rollback_failed",
	"turn_admission.unavailable.pre_gate_cancelled",
	"turn_admission.unavailable.pre_gate_rejected",
	"turn_admission.drifted",
	"turn_finalize.ready",
	"turn_finalize.degraded",
	"turn_finalize.unavailable.restore_failed",
];

function neverCase(caseId: never): never {
	throw new Error(`Unhandled Work Mode execution case: ${caseId}`);
}

function normativeRule(caseId: WorkModeExecutionCaseId): CaseRule {
	switch (caseId) {
		case "session_apply.ready":
		case "session_apply.degraded":
		case "session_apply.unavailable":
		case "session_apply.drifted":
			return {
				phase: "session_apply",
				state: caseId.endsWith("ready")
					? "ready"
					: caseId.endsWith("degraded")
						? "degraded"
						: caseId.endsWith("unavailable")
							? "unavailable"
							: "drifted",
				receiptCount: 1,
				finalizeCount: 0,
				ownership: "none",
			};
		case "persistent_apply.ready.committed":
		case "persistent_apply.ready.committed_unconfirmed":
		case "persistent_apply.degraded.committed":
		case "persistent_apply.degraded.committed_unconfirmed":
		case "persistent_apply.unavailable.prewrite":
		case "persistent_apply.unavailable.mutation":
		case "persistent_apply.drifted":
			return {
				phase: "persistent_apply",
				state: caseId.includes(".ready.")
					? "ready"
					: caseId.includes(".degraded.")
						? "degraded"
						: caseId.endsWith("drifted")
							? "drifted"
							: "unavailable",
				receiptCount: 1,
				finalizeCount: 0,
				ownership: "none",
			};
		case "turn_stage.ready":
		case "turn_stage.degraded":
		case "turn_stage.unavailable":
		case "turn_stage.drifted":
			return {
				phase: "turn_stage",
				state: caseId.endsWith("ready")
					? "ready"
					: caseId.endsWith("degraded")
						? "degraded"
						: caseId.endsWith("unavailable")
							? "unavailable"
							: "drifted",
				receiptCount: 1,
				finalizeCount: 0,
				ownership: "none",
			};
		case "turn_admission.ready":
		case "turn_admission.degraded":
			return {
				phase: "turn_admission",
				state: caseId.endsWith("ready") ? "ready" : "degraded",
				receiptCount: 1,
				finalizeCount: 1,
				ownership: "admitted_lease",
			};
		case "turn_admission.unavailable.runtime.activation_failed":
		case "turn_admission.unavailable.runtime.rollback_failed":
			return {
				phase: "turn_admission",
				state: "unavailable",
				receiptCount: 1,
				finalizeCount: 0,
				ownership: "partial_cleanup",
			};
		case "turn_admission.unavailable.pre_gate_cancelled":
		case "turn_admission.unavailable.pre_gate_rejected":
		case "turn_admission.drifted":
			return {
				phase: "turn_admission",
				state: caseId.endsWith("drifted") ? "drifted" : "unavailable",
				receiptCount: 1,
				finalizeCount: 0,
				ownership: "none",
			};
		case "turn_finalize.ready":
		case "turn_finalize.degraded":
		case "turn_finalize.unavailable.restore_failed":
			return {
				phase: "turn_finalize",
				state: caseId.endsWith("ready") ? "ready" : caseId.endsWith("degraded") ? "degraded" : "unavailable",
				receiptCount: 1,
				finalizeCount: 1,
				ownership: "admitted_lease",
			};
		default:
			return neverCase(caseId);
	}
}

test("publishes the 25 unique normative Work Mode execution case IDs", () => {
	const tableCaseIds: readonly WorkModeExecutionCaseId[] = WORK_MODE_EXECUTION_CASES.map(
		candidate => candidate.caseId,
	);

	expect(NORMATIVE_CASE_IDS).toHaveLength(25);
	expect(new Set(NORMATIVE_CASE_IDS).size).toBe(25);
	expect(tableCaseIds).toEqual(NORMATIVE_CASE_IDS);
	expect(new Set(tableCaseIds).size).toBe(25);
});

test("keeps every case phase, state, receipt cardinality, and ownership rule exact", () => {
	for (const candidate of WORK_MODE_EXECUTION_CASES) {
		const expected = normativeRule(candidate.caseId);
		expect({
			phase: candidate.phase,
			state: candidate.state,
			receiptCount: candidate.receiptCount,
			finalizeCount: candidate.finalizeCount,
			ownership: candidate.ownership,
		}).toEqual(expected);
	}
});

test("keeps partial-cleanup cases free of lease and finalizer metadata", () => {
	const partialCases = WORK_MODE_EXECUTION_CASES.filter(candidate => candidate.shape === "partial_cleanup");

	expect(partialCases.map(candidate => candidate.caseId)).toEqual([
		"turn_admission.unavailable.runtime.activation_failed",
		"turn_admission.unavailable.runtime.rollback_failed",
	]);
	for (const candidate of partialCases) {
		expect(candidate.ownership).toBe("partial_cleanup");
		expect(candidate.finalizeCount).toBe(0);
		expect(candidate).not.toHaveProperty("turnLeaseId");
		expect(candidate).not.toHaveProperty("admissionReceiptId");
		expect(candidate).not.toHaveProperty("finalizationObligation");
		expect(candidate).not.toHaveProperty("finalizationReceiptId");
	}
});

test("marks admitted and finalization cases as lease-owned, finalizable records", () => {
	const admittedCases = WORK_MODE_EXECUTION_CASES.filter(candidate => candidate.ownership === "admitted_lease");

	expect(admittedCases.map(candidate => candidate.caseId)).toEqual([
		"turn_admission.ready",
		"turn_admission.degraded",
		"turn_finalize.ready",
		"turn_finalize.degraded",
		"turn_finalize.unavailable.restore_failed",
	]);
	for (const candidate of admittedCases) {
		expect(candidate.receiptCount).toBe(1);
		expect(candidate.finalizeCount).toBe(1);
		expect(candidate.phase === "turn_admission" || candidate.phase === "turn_finalize").toBe(true);
	}
});

test("freezes the case table and each normative definition", () => {
	expect(Object.isFrozen(WORK_MODE_EXECUTION_CASES)).toBe(true);
	for (const candidate of WORK_MODE_EXECUTION_CASES) expect(Object.isFrozen(candidate)).toBe(true);
});

test("accepts every table ID through an exhaustive case switch", () => {
	for (const candidate of WORK_MODE_EXECUTION_CASES) {
		expect(normativeRule(candidate.caseId).phase).toBe(getWorkModeExecutionCase(candidate.caseId).phase);
	}
});
