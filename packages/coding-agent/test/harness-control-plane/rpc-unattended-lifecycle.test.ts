/**
 * #323 (over-RPC channel): drive `negotiate_unattended` and every
 * `workflow_gate_response` through the REAL `dispatchRpcCommand` surface (the
 * same path the RPC server uses), proving the gate answer channel works over the
 * RPC command transport — not just by calling the broker directly.
 */
import { describe, expect, it } from "bun:test";
import type {
	RpcCommand,
	RpcUnattendedAccepted,
	RpcUnattendedDeclaration,
	RpcWorkflowGate,
	RpcWorkflowGateResolution,
} from "@gajae-code/coding-agent/modes/rpc/rpc-types";
import { approvalGate, executionGate } from "@gajae-code/coding-agent/modes/shared/agent-wire/approval-gate";
import {
	dispatchRpcCommand,
	type RpcCommandDispatchContext,
	type RpcUnattendedControlPlane,
} from "@gajae-code/coding-agent/modes/shared/agent-wire/command-dispatch";
import { isRpcCommand } from "@gajae-code/coding-agent/modes/shared/agent-wire/command-validation";
import { questionToGate } from "@gajae-code/coding-agent/modes/shared/agent-wire/deep-interview-gate";
import { UnattendedRunController } from "@gajae-code/coding-agent/modes/shared/agent-wire/unattended-run-controller";
import {
	MemoryGateStore,
	WorkflowGateBroker,
} from "@gajae-code/coding-agent/modes/shared/agent-wire/workflow-gate-broker";

const DECLARATION: RpcUnattendedDeclaration = {
	actor: "hermes",
	budget: { max_tokens: 1_000_000, max_tool_calls: 100, max_wall_time_ms: 600_000, max_cost_usd: 50 },
	scopes: ["prompt", "control"],
	action_allowlist: ["command.prompt"],
};

function buildHarness() {
	const runId = "rpc-e2e-001";
	const advanced: RpcWorkflowGate[] = [];
	const broker = new WorkflowGateBroker(runId, new MemoryGateStore(), {
		advance: gate => {
			advanced.push(gate);
		},
	});
	let controller: UnattendedRunController | undefined;

	const controlPlane: RpcUnattendedControlPlane = {
		negotiate(declaration): RpcUnattendedAccepted {
			controller = UnattendedRunController.negotiate(declaration, {
				runId,
				providerSupportsTokenCostMetrics: true,
				audit: () => {},
			});
			return {
				run_id: runId,
				actor: controller.actor,
				budget: controller.budget,
				scopes: [...controller.scopes],
				action_allowlist: [...controller.actionAllowlist],
				accepted_at: new Date().toISOString(),
			};
		},
		resolveGate(response): Promise<RpcWorkflowGateResolution> {
			return broker.resolve(response);
		},
	};

	// Minimal context: these two commands use only the control plane.
	const context = {
		session: {} as never,
		output: () => {},
		hostToolRegistry: {} as never,
		hostUriRegistry: {} as never,
		createUiContext: () => ({ notify: () => {} }),
		unattendedControlPlane: controlPlane,
	} as RpcCommandDispatchContext;

	return { broker, context, advanced, getController: () => controller };
}

describe("#323 gate channel over the RPC dispatch transport", () => {
	it("negotiates unattended + answers deep-interview/ralplan/ultragoal gates through dispatchRpcCommand", async () => {
		const { broker, context, advanced, getController } = buildHarness();

		// negotiate_unattended over RPC.
		const negotiateCmd = { id: "n1", type: "negotiate_unattended", declaration: DECLARATION };
		expect(isRpcCommand(negotiateCmd)).toBe(true);
		const negotiated = await dispatchRpcCommand(negotiateCmd as RpcCommand, context);
		expect(negotiated.success).toBe(true);
		expect(getController()?.actor).toBe("hermes");

		// Drive a deep-interview question, a ralplan approval, and an ultragoal
		// execution gate — each answered through a workflow_gate_response COMMAND.
		const gates: RpcWorkflowGate[] = [
			broker.openGate(questionToGate({ id: "q", question: "auth?", options: [{ label: "JWT" }] })),
			broker.openGate(approvalGate({ summary: "PRD" })),
			broker.openGate(executionGate({ summary: "go" })),
		];
		const answers: unknown[] = [
			{ selected: ["JWT"], other: false },
			{ decision: "approve" },
			{ decision: "approve" },
		];

		for (let i = 0; i < gates.length; i++) {
			const cmd = { id: `g${i}`, type: "workflow_gate_response", gate_id: gates[i].gate_id, answer: answers[i] };
			expect(isRpcCommand(cmd)).toBe(true);
			const res = await dispatchRpcCommand(cmd as RpcCommand, context);
			expect(res.success).toBe(true);
			expect((res as { data: RpcWorkflowGateResolution }).data.status).toBe("accepted");
		}
		// Every gate advanced exactly once via the broker, answered over RPC.
		expect(advanced.map(g => g.gate_id)).toEqual(gates.map(g => g.gate_id));
	});

	it("rejects a schema-invalid answer over RPC and leaves the gate pending", async () => {
		const { broker, context } = buildHarness();
		await dispatchRpcCommand(
			{ id: "n", type: "negotiate_unattended", declaration: DECLARATION } as RpcCommand,
			context,
		);
		const gate = broker.openGate(approvalGate());

		const bad = await dispatchRpcCommand(
			{
				id: "b",
				type: "workflow_gate_response",
				gate_id: gate.gate_id,
				answer: { decision: "maybe" },
			} as RpcCommand,
			context,
		);
		expect(bad.success).toBe(true);
		expect((bad as { data: RpcWorkflowGateResolution }).data.status).toBe("rejected");

		// Gate still pending: a valid answer is then accepted over RPC.
		const good = await dispatchRpcCommand(
			{
				id: "g",
				type: "workflow_gate_response",
				gate_id: gate.gate_id,
				answer: { decision: "approve" },
			} as RpcCommand,
			context,
		);
		expect((good as { data: RpcWorkflowGateResolution }).data.status).toBe("accepted");
	});

	it("fails closed when no unattended control plane is attached", async () => {
		const context = {
			session: {} as never,
			output: () => {},
			hostToolRegistry: {} as never,
			hostUriRegistry: {} as never,
			createUiContext: () => ({ notify: () => {} }),
		} as RpcCommandDispatchContext;
		const res = await dispatchRpcCommand(
			{ id: "n", type: "negotiate_unattended", declaration: DECLARATION } as RpcCommand,
			context,
		);
		expect(res.success).toBe(false);
	});

	it("surfaces a fail-closed negotiation refusal as an RPC error", async () => {
		const { context } = buildHarness();
		const res = await dispatchRpcCommand(
			{
				id: "n",
				type: "negotiate_unattended",
				declaration: { ...DECLARATION, budget: { max_tokens: 1 } },
			} as RpcCommand,
			context,
		);
		expect(res.success).toBe(false);
	});
});
