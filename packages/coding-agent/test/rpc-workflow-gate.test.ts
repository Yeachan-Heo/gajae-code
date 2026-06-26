import { describe, expect, it } from "bun:test";
import type { RpcJsonSchema, RpcWorkflowGate } from "@gajae-code/coding-agent/modes/rpc/rpc-types";
import { isRpcCommand } from "@gajae-code/coding-agent/modes/shared/agent-wire/command-validation";
import { isRpcCommandType, scopeForRpcCommand } from "@gajae-code/coding-agent/modes/shared/agent-wire/scopes";
import {
	MemoryGateStore,
	WorkflowGateBroker,
} from "@gajae-code/coding-agent/modes/shared/agent-wire/workflow-gate-broker";
import { schemaHash } from "@gajae-code/coding-agent/modes/shared/agent-wire/workflow-gate-schema";

describe("RPC workflow_gate contract", () => {
	it("recognizes and scopes the new commands", () => {
		expect(isRpcCommandType("negotiate_unattended")).toBe(true);
		expect(isRpcCommandType("workflow_gate_response")).toBe(true);
		expect(scopeForRpcCommand("negotiate_unattended")).toBe("control");
		expect(scopeForRpcCommand("workflow_gate_response")).toBe("control");
	});

	it("validates negotiate_unattended declarations (fail-closed shape)", () => {
		const ok = {
			type: "negotiate_unattended",
			declaration: {
				actor: "hermes",
				budget: { max_tokens: 1, max_tool_calls: 1, max_wall_time_ms: 1, max_cost_usd: 1 },
				scopes: ["prompt"],
				action_allowlist: ["bash.readonly"],
			},
		};
		expect(isRpcCommand(ok)).toBe(true);
		// Missing budget field → rejected.
		expect(
			isRpcCommand({
				type: "negotiate_unattended",
				declaration: { actor: "x", budget: {}, scopes: [], action_allowlist: [] },
			}),
		).toBe(false);
		// Missing declaration → rejected.
		expect(isRpcCommand({ type: "negotiate_unattended" })).toBe(false);
	});

	it("validates workflow_gate_response shape", () => {
		expect(isRpcCommand({ type: "workflow_gate_response", gate_id: "g1", answer: "approve" })).toBe(true);
		expect(isRpcCommand({ type: "workflow_gate_response", gate_id: "g1", answer: null, idempotency_key: "k" })).toBe(
			true,
		);
		expect(isRpcCommand({ type: "workflow_gate_response", answer: "approve" })).toBe(false); // no gate_id
		expect(isRpcCommand({ type: "workflow_gate_response", gate_id: "g1" })).toBe(false); // no answer
	});

	it("round-trips a gate emission and a schema-validated answer", async () => {
		const emitted: RpcWorkflowGate[] = [];
		let advancedAnswer: unknown;
		const broker = new WorkflowGateBroker("run-rt", new MemoryGateStore(), {
			emit: g => emitted.push(g),
			advance: (_g, a) => {
				advancedAnswer = a;
			},
		});
		const schema: RpcJsonSchema = { type: "string", enum: ["approve", "request-changes", "reject"] };
		const gate = broker.openGate({ stage: "ralplan", kind: "approval", schema, context: { title: "Approve plan?" } });

		// Advertised schema_hash equals the server-side validation hash (agreement).
		expect(gate.schema_hash).toBe(schemaHash(schema));
		expect(emitted[0]?.gate_id).toBe(gate.gate_id);

		// Invalid answer is rejected with a typed error and does not advance.
		const bad = await broker.resolve({ gate_id: gate.gate_id, answer: "maybe" });
		expect(bad.status).toBe("rejected");
		expect(bad.error?.code).toBe("invalid_workflow_gate_answer");
		expect(advancedAnswer).toBeUndefined();

		// Valid answer advances the workflow.
		const good = await broker.resolve({ gate_id: gate.gate_id, answer: "approve" });
		expect(good.status).toBe("accepted");
		expect(good.answer_hash).toBeTruthy();
		expect(advancedAnswer).toBe("approve");
	});
});
