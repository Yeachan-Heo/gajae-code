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

function expectApprovalError(answer: unknown, code: ApprovalGateError["code"]): void {
	try {
		const decoded = decodeApproval(answer);
		expect(decoded.approved).toBe(false);
		expect.unreachable(`decodeApproval unexpectedly returned ${JSON.stringify(decoded)}`);
	} catch (error) {
		expect(error).toBeInstanceOf(ApprovalGateError);
		expect((error as ApprovalGateError).code).toBe(code);
	}
}

function expectExecutionError(answer: unknown, code: ApprovalGateError["code"]): void {
	try {
		const decoded = decodeExecution(answer);
		expect(decoded.approved).toBe(false);
		expect.unreachable(`decodeExecution unexpectedly returned ${JSON.stringify(decoded)}`);
	} catch (error) {
		expect(error).toBeInstanceOf(ApprovalGateError);
		expect((error as ApprovalGateError).code).toBe(code);
	}
}

describe("approvalGate red-team coercion checks (#317)", () => {
	it("never approves non-approve approval decisions", () => {
		const requestChanges = decodeApproval({ decision: "request-changes", comments: "revise the risk section" });
		expect(requestChanges).toEqual({
			approved: false,
			decision: "request-changes",
			comments: "revise the risk section",
		});

		const reject = decodeApproval({ decision: "reject" });
		expect(reject).toEqual({ approved: false, decision: "reject", comments: undefined });
	});

	it("does not normalize approve casing or whitespace into approval", () => {
		for (const decision of ["Approve", " approve ", "APPROVE"]) {
			expectApprovalError({ decision }, "unknown_decision");
		}
	});

	it("rejects unexpected answer properties through the advertised broker schema", async () => {
		const advanced: unknown[] = [];
		const broker = new WorkflowGateBroker("redteam-extra-property", new MemoryGateStore(), {
			advance: (_gate, answer) => {
				advanced.push(answer);
			},
		});
		const gate = broker.openGate(approvalGate());

		const resolution = await broker.resolve({
			gate_id: gate.gate_id,
			answer: { decision: "approve", unexpected: "coerce" },
		});

		expect(resolution.status).toBe("rejected");
		expect(resolution.error?.errors).toEqual(
			expect.arrayContaining([expect.objectContaining({ path: "#/unexpected", keyword: "additionalProperties" })]),
		);
		expect(advanced).toEqual([]);
	});

	it("throws on missing, non-string, and null decisions or answers", () => {
		for (const answer of [{}, { decision: 1 }, { decision: null }, null]) {
			expectApprovalError(answer, "invalid_answer_shape");
		}
	});

	it("keeps a broker gate pending after schema-invalid decision, then accepts valid approve", async () => {
		const advanced: unknown[] = [];
		const broker = new WorkflowGateBroker("redteam-roundtrip", new MemoryGateStore(), {
			advance: (_gate, answer) => {
				advanced.push(answer);
			},
		});
		const gate = broker.openGate(approvalGate());

		const invalid = await broker.resolve({ gate_id: gate.gate_id, answer: { decision: " approve " } });
		expect(invalid.status).toBe("rejected");
		expect(invalid.error?.errors).toEqual(
			expect.arrayContaining([expect.objectContaining({ path: "#/decision", keyword: "enum" })]),
		);
		expect(advanced).toEqual([]);

		const valid = await broker.resolve({ gate_id: gate.gate_id, answer: { decision: "approve" } });
		expect(valid.status).toBe("accepted");
		expect(advanced).toEqual([{ decision: "approve" }]);
		expect(decodeApproval(advanced[0]).approved).toBe(true);
	});

	it("lets broker accept schema-valid request-changes without comments, while decode enforces missing_comments", async () => {
		const advanced: unknown[] = [];
		const broker = new WorkflowGateBroker("redteam-semantic-comments", new MemoryGateStore(), {
			advance: (_gate, answer) => {
				advanced.push(answer);
			},
		});
		const gate = broker.openGate(approvalGate());

		const resolution = await broker.resolve({ gate_id: gate.gate_id, answer: { decision: "request-changes" } });
		expect(resolution.status).toBe("accepted");
		expect(advanced).toEqual([{ decision: "request-changes" }]);
		expectApprovalError(advanced[0], "missing_comments");
	});
});

describe("executionGate red-team coercion checks (#317)", () => {
	it("honors execution decline with and without reason", () => {
		expect(decodeExecution({ decision: "decline", reason: "operator rejected evidence" })).toEqual({
			approved: false,
			decision: "decline",
			reason: "operator rejected evidence",
		});
		expect(decodeExecution({ decision: "decline" })).toEqual({
			approved: false,
			decision: "decline",
			reason: undefined,
		});
	});

	it("throws when execution reason is non-string", () => {
		expectExecutionError({ decision: "decline", reason: 7 }, "invalid_answer_shape");
	});

	it("rejects non-string execution reason through the advertised broker schema", async () => {
		const advanced: unknown[] = [];
		const broker = new WorkflowGateBroker("redteam-execution-reason", new MemoryGateStore(), {
			advance: (_gate, answer) => {
				advanced.push(answer);
			},
		});
		const gate = broker.openGate(executionGate());

		const resolution = await broker.resolve({ gate_id: gate.gate_id, answer: { decision: "decline", reason: 7 } });
		expect(resolution.status).toBe("rejected");
		expect(resolution.error?.errors).toEqual(
			expect.arrayContaining([expect.objectContaining({ path: "#/reason", keyword: "type" })]),
		);
		expect(advanced).toEqual([]);
	});
});
