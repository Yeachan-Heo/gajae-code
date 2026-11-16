import { describe, expect, it } from "bun:test";
import {
	ApprovalGateError,
	approvalGate,
	decodeApproval,
	decodeExecution,
	executionGate,
} from "../src/modes/shared/agent-wire/approval-gate";
import {
	type GateContinuation,
	MemoryGateStore,
	WorkflowGateBroker,
} from "../src/modes/shared/agent-wire/workflow-gate-broker";
import { compileGateSchema, validateGateAnswer } from "../src/modes/shared/agent-wire/workflow-gate-schema";

function activeContinuation(): GateContinuation {
	let active = true;
	return {
		activate: () => {},
		terminalProof: "not_published",
		isLive: () => active,
		release: () => {
			active = false;
		},
	};
}
describe("approvalGate (ralplan #317)", () => {
	it("emits a ralplan approval gate with stable schema", () => {
		const gate = approvalGate({ summary: "plan v2" });
		expect(gate.stage).toBe("ralplan");
		expect(gate.kind).toBe("approval");
		expect(gate.schema.properties?.decision?.enum).toEqual(["approve", "request-changes", "reject"]);
		expect(gate.context?.summary).toBe("plan v2");
		expect(gate.options).toEqual([
			{ value: { decision: "approve" }, label: "approve" },
			{ value: { decision: "reject" }, label: "reject" },
		]);
		const compiled = compileGateSchema(gate.schema);
		for (const option of gate.options ?? []) {
			expect(validateGateAnswer(compiled, "approval", option.value)).toBeNull();
			expect(decodeApproval(option.value)).toEqual({
				approved: option.label === "approve",
				decision: option.label === "approve" ? "approve" : "reject",
				comments: undefined,
			});
		}
	});

	it("advances only on explicit approve; decline/request-changes are honored", () => {
		expect(decodeApproval({ decision: "approve" }).approved).toBe(true);
		expect(decodeApproval({ decision: "reject" }).approved).toBe(false);
		const rc = decodeApproval({ decision: "request-changes", comments: "tighten scope" });
		expect(rc.approved).toBe(false);
		expect(rc.comments).toBe("tighten scope");
	});

	it("requires nonblank comments for request-changes in both schema and decoder", () => {
		const compiled = compileGateSchema(approvalGate().schema);
		for (const answer of [
			{ decision: "request-changes" },
			{ decision: "request-changes", comments: "" },
			{ decision: "request-changes", comments: " \t\n　 " },
		]) {
			expect(validateGateAnswer(compiled, "approval", answer)?.code).toBe("invalid_workflow_gate_answer");
			expect(() => decodeApproval(answer)).toThrow(ApprovalGateError);
			expect(() => decodeApproval(answer)).toThrow(/comments are required/);
		}
		const answer = { decision: "request-changes" as const, comments: " \tTighten scope.\n " };
		expect(validateGateAnswer(compiled, "approval", answer)).toBeNull();
		expect(decodeApproval(answer)).toEqual({ approved: false, ...answer });
		for (const decision of ["approve", "reject"] as const) {
			for (const comments of [undefined, "", " \t\n "]) {
				const answer = comments === undefined ? { decision } : { decision, comments };
				expect(validateGateAnswer(compiled, "approval", answer)).toBeNull();
				expect(decodeApproval(answer)).toEqual({ approved: decision === "approve", decision, comments });
			}
		}
		for (const answer of ["approve", "reject", { decision: "request-changes", comments: 1 }])
			expect(validateGateAnswer(compiled, "approval", answer)?.code).toBe("invalid_workflow_gate_answer");
	});

	it("rejects unknown/malformed decisions (never silently approves)", () => {
		expect(() => decodeApproval({ decision: "maybe" })).toThrow(/unknown approval decision/);
		expect(() => decodeApproval({})).toThrow(/decision must be a string/);
		expect(() => decodeApproval("approve")).toThrow(/must be an object/);
		expect(() => decodeApproval({ decision: "approve", comments: 1 })).toThrow(/comments must be a string/);
	});
});

describe("executionGate (ultragoal #317)", () => {
	it("emits an ultragoal execution gate", () => {
		const gate = executionGate();
		expect(gate.stage).toBe("ultragoal");
		expect(gate.kind).toBe("execution");
		expect(gate.schema.properties?.decision?.enum).toEqual(["approve", "decline"]);
		expect(gate.options).toEqual([
			{ value: { decision: "approve" }, label: "approve" },
			{ value: { decision: "decline" }, label: "decline" },
		]);
		const compiled = compileGateSchema(gate.schema);
		for (const option of gate.options ?? []) {
			expect(validateGateAnswer(compiled, "execution", option.value)).toBeNull();
			expect(decodeExecution(option.value)).toEqual({
				approved: option.label === "approve",
				decision: option.label === "approve" ? "approve" : "decline",
				reason: undefined,
			});
			expect(validateGateAnswer(compiled, "execution", option.label)?.code).toBe("invalid_workflow_gate_answer");
		}
	});

	it("advances only on explicit approve; decline honored", () => {
		expect(decodeExecution({ decision: "approve" }).approved).toBe(true);
		const d = decodeExecution({ decision: "decline", reason: "needs more review" });
		expect(d.approved).toBe(false);
		expect(d.reason).toBe("needs more review");
		expect(() => decodeExecution({ decision: "go" })).toThrow(/unknown execution decision/);
	});
});

describe("end-to-end via the broker", () => {
	it("keeps invalid approval answers pending and accepts genuine request-changes", async () => {
		const advanced: unknown[] = [];
		const broker = new WorkflowGateBroker("run-approval", new MemoryGateStore(), {
			advance: (_g, a) => {
				advanced.push(a);
			},
		});
		const gate = broker.openGate(approvalGate({ summary: "PRD" }), activeContinuation());
		expect(broker.listPendingGates()).toEqual([gate]);

		// schema-invalid (decision not in enum) -> rejected, gate pending
		const bad = await broker.resolve({ gate_id: gate.gate_id, answer: { decision: "maybe" } });
		expect(bad.status).toBe("rejected");
		expect(advanced).toHaveLength(0);
		// Incomplete or blank request-changes must leave the gate pending.
		for (const answer of [
			{ decision: "request-changes" },
			{ decision: "request-changes", comments: "" },
			{ decision: "request-changes", comments: " \t\n " },
		]) {
			const incomplete = await broker.resolve({ gate_id: gate.gate_id, answer });
			expect(incomplete.status).toBe("rejected");
			expect(incomplete.error?.code).toBe("invalid_workflow_gate_answer");
			expect(broker.listPendingGates()).toEqual([gate]);
			expect(advanced).toEqual([]);
		}
		// Genuine comments allow request-changes; the decoded decision is NOT approval.
		const rc = await broker.resolve({
			gate_id: gate.gate_id,
			answer: { decision: "request-changes", comments: "x" },
		});
		expect(rc.status).toBe("accepted");
		expect(advanced).toEqual([{ decision: "request-changes", comments: "x" }]);
		expect(decodeApproval(advanced[0])).toEqual({
			approved: false,
			decision: "request-changes",
			comments: "x",
		});
	});

	it("validates execution answers and honors decline", async () => {
		const advanced: unknown[] = [];
		const broker = new WorkflowGateBroker("run-exec", new MemoryGateStore(), {
			advance: (_g, answer) => {
				advanced.push(answer);
			},
		});
		const gate = broker.openGate(executionGate(), activeContinuation());
		expect(broker.listPendingGates()).toEqual([gate]);
		const ok = await broker.resolve({ gate_id: gate.gate_id, answer: { decision: "decline", reason: "later" } });
		expect(ok.status).toBe("accepted");
		expect(advanced).toEqual([{ decision: "decline", reason: "later" }]);
		expect(decodeExecution({ decision: "decline", reason: "later" }).approved).toBe(false);
	});
});
