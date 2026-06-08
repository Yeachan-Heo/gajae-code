import { describe, expect, it } from "bun:test";
import {
	ApprovalGateError,
	approvalGate,
	decodeApproval,
	decodeExecution,
	executionGate,
} from "@gajae-code/coding-agent/modes/shared/agent-wire/approval-gate";
import {
	MemoryGateStore,
	WorkflowGateBroker,
} from "@gajae-code/coding-agent/modes/shared/agent-wire/workflow-gate-broker";

describe("approvalGate (ralplan #317)", () => {
	it("emits a ralplan approval gate with stable schema", () => {
		const gate = approvalGate({ summary: "plan v2" });
		expect(gate.stage).toBe("ralplan");
		expect(gate.kind).toBe("approval");
		expect(gate.schema.properties?.decision?.enum).toEqual(["approve", "request-changes", "reject"]);
		expect(gate.context?.summary).toBe("plan v2");
	});

	it("advances only on explicit approve; decline/request-changes are honored", () => {
		expect(decodeApproval({ decision: "approve" }).approved).toBe(true);
		expect(decodeApproval({ decision: "reject" }).approved).toBe(false);
		const rc = decodeApproval({ decision: "request-changes", comments: "tighten scope" });
		expect(rc.approved).toBe(false);
		expect(rc.comments).toBe("tighten scope");
	});

	it("requires comments when requesting changes (edit answers honored, not dropped)", () => {
		expect(() => decodeApproval({ decision: "request-changes" })).toThrow(ApprovalGateError);
		expect(() => decodeApproval({ decision: "request-changes", comments: "  " })).toThrow(/comments are required/);
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
	it("validates approval answers against the advertised schema and advances on approve", async () => {
		const advanced: unknown[] = [];
		const broker = new WorkflowGateBroker("run-approval", new MemoryGateStore(), {
			advance: (_g, a) => {
				advanced.push(a);
			},
		});
		const gate = broker.openGate(approvalGate({ summary: "PRD" }));
		// schema-invalid (decision not in enum) -> rejected, gate pending
		const bad = await broker.resolve({ gate_id: gate.gate_id, answer: { decision: "maybe" } });
		expect(bad.status).toBe("rejected");
		expect(advanced).toHaveLength(0);
		// request-changes is schema-valid and advances the gate (workflow then revises);
		// the decoded decision is NOT approval.
		const rc = await broker.resolve({
			gate_id: gate.gate_id,
			answer: { decision: "request-changes", comments: "x" },
		});
		expect(rc.status).toBe("accepted");
		expect(decodeApproval(advanced[0]).approved).toBe(false);
	});

	it("validates execution answers and honors decline", async () => {
		const broker = new WorkflowGateBroker("run-exec", new MemoryGateStore());
		const gate = broker.openGate(executionGate());
		const ok = await broker.resolve({ gate_id: gate.gate_id, answer: { decision: "decline", reason: "later" } });
		expect(ok.status).toBe("accepted");
		expect(decodeExecution({ decision: "decline", reason: "later" }).approved).toBe(false);
	});
});
