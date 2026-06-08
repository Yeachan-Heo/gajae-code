import { describe, expect, it } from "bun:test";
import { createBridgeFetchHandler } from "@gajae-code/coding-agent/modes/bridge/bridge-mode";
import { approvalGate } from "@gajae-code/coding-agent/modes/shared/agent-wire/approval-gate";
import {
	BridgeFrameSequencer,
	toBridgeWorkflowGateFrame,
} from "@gajae-code/coding-agent/modes/shared/agent-wire/event-envelope";
import {
	type BridgeHandshakeAccepted,
	type BridgeHandshakeRequest,
	isBridgeHandshakeRequest,
	isUnattendedDeclarationShape,
	negotiateBridgeHandshake,
} from "@gajae-code/coding-agent/modes/shared/agent-wire/handshake";
import {
	MemoryGateStore,
	WorkflowGateBroker,
} from "@gajae-code/coding-agent/modes/shared/agent-wire/workflow-gate-broker";

const decl = {
	actor: "hermes",
	budget: { max_tokens: 1000, max_tool_calls: 5, max_wall_time_ms: 10_000, max_cost_usd: 2 },
	scopes: ["prompt"],
	action_allowlist: ["bash.readonly"],
};

function serverArgs() {
	return {
		sessionId: "sess-1",
		capabilities: ["events", "workflow_gate"] as const,
		scopes: ["prompt"] as const,
		endpoints: {
			events: "/v1/sessions/sess-1/events",
			commands: "/v1/sessions/sess-1/commands",
			uiResponses: "/v1/sessions/sess-1/ui-responses",
			claimControl: "/v1/sessions/sess-1/control/claim",
			disconnectControl: "/v1/sessions/sess-1/control/disconnect",
			hostToolResults: "/v1/sessions/sess-1/host-tool-results",
			hostUriResults: "/v1/sessions/sess-1/host-uri-results",
		},
		frameTypes: ["event", "workflow_gate"] as const,
	};
}

describe("bridge handshake advertises workflow_gate (#321)", () => {
	it("accepts the workflow_gate capability + frame type without claiming inactive unattended", () => {
		const request: BridgeHandshakeRequest = {
			protocol_version_range: { min: 1, max: 1 },
			capabilities: ["events", "workflow_gate"],
			requested_scopes: ["prompt"],
			unattended: decl,
		};
		const res = negotiateBridgeHandshake(request, serverArgs()) as BridgeHandshakeAccepted;
		expect(res.status).toBe("accepted");
		expect(res.accepted_capabilities).toContain("workflow_gate");
		expect(res.frame_types).toContain("workflow_gate");
		expect(res.accepted_unattended).toBeUndefined();
	});

	it("does not echo the declaration when workflow_gate is not accepted", () => {
		const request: BridgeHandshakeRequest = {
			protocol_version_range: { min: 1, max: 1 },
			capabilities: ["events"],
			requested_scopes: ["prompt"],
			unattended: decl,
		};
		const res = negotiateBridgeHandshake(request, {
			...serverArgs(),
			capabilities: ["events"],
		}) as BridgeHandshakeAccepted;
		expect(res.accepted_unattended).toBeUndefined();
	});

	it("validates the unattended declaration shape (fail-closed at the contract boundary)", () => {
		expect(isUnattendedDeclarationShape(decl)).toBe(true);
		expect(isUnattendedDeclarationShape({ ...decl, budget: { max_tokens: 1 } })).toBe(false);
		expect(isUnattendedDeclarationShape({ ...decl, scopes: [1] })).toBe(false);
		// Parity with UnattendedRunController fail-closed: empty actor + non-positive budgets rejected.
		expect(isUnattendedDeclarationShape({ ...decl, actor: "" })).toBe(false);
		expect(isUnattendedDeclarationShape({ ...decl, budget: { ...decl.budget, max_tokens: 0 } })).toBe(false);
		expect(isUnattendedDeclarationShape({ ...decl, budget: { ...decl.budget, max_cost_usd: -1 } })).toBe(false);
		// A handshake request carrying a malformed declaration is rejected by the type guard.
		expect(
			isBridgeHandshakeRequest({
				protocol_version_range: { min: 1, max: 1 },
				capabilities: ["workflow_gate"],
				requested_scopes: ["prompt"],
				unattended: { actor: "x" },
			}),
		).toBe(false);
	});
});

describe("workflow_gate bridge frame (#321 replay/idempotency)", () => {
	it("sequences gate frames with monotonic seq and gate_id correlation", () => {
		const broker = new WorkflowGateBroker("run-bridge", new MemoryGateStore());
		const seq = new BridgeFrameSequencer("sess-1");
		const gate = broker.openGate(approvalGate({ summary: "plan" }));
		const frame = toBridgeWorkflowGateFrame(gate, seq);
		expect(frame.type).toBe("workflow_gate");
		expect(frame.seq).toBe(1);
		expect(frame.correlation_id).toBe(gate.gate_id);
		expect(frame.payload.gate_id).toBe(gate.gate_id);
		expect(frame.session_id).toBe("sess-1");
		expect(frame.frame_id).toBeTruthy();
		const gate2 = broker.openGate(approvalGate());
		const frame2 = toBridgeWorkflowGateFrame(gate2, seq);
		expect(frame2.seq).toBe(2); // replayable ordering
		expect(frame2.frame_id).not.toBe(frame.frame_id); // idempotency key per frame
	});
});

describe("handshake handler advertises workflow_gate over the wire", () => {
	it("returns workflow_gate in frame_types from POST /v1/handshake", async () => {
		const handle = createBridgeFetchHandler({
			sessionId: "sess-1",
			token: "secret",
			commandScopes: ["prompt"],
			endpointMatrix: { events: true, commands: true },
			idempotencyCache: new Map(),
			commandDispatcher: async command => ({ id: command.id, type: "response", command: "prompt", success: true }),
		});
		const res = await handle(
			new Request("https://bridge.test/v1/handshake", {
				method: "POST",
				headers: { Authorization: "Bearer secret" },
				body: JSON.stringify({
					protocol_version_range: { min: 1, max: 1 },
					capabilities: ["events", "workflow_gate"],
					requested_scopes: ["prompt"],
				}),
			}),
		);
		const body = (await res.json()) as BridgeHandshakeAccepted;
		expect(body.accepted_capabilities).toContain("workflow_gate");
		expect(body.frame_types).toContain("workflow_gate");
	});
});
