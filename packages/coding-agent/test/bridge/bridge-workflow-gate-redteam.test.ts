import { describe, expect, it } from "bun:test";
import { createBridgeFetchHandler } from "@gajae-code/coding-agent/modes/bridge/bridge-mode";
import { approvalGate } from "@gajae-code/coding-agent/modes/shared/agent-wire/approval-gate";
import {
	BridgeFrameSequencer,
	toBridgeWorkflowGateFrame,
} from "@gajae-code/coding-agent/modes/shared/agent-wire/event-envelope";
import {
	type BridgeHandshakeAccepted,
	type BridgeHandshakeRejected,
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
	actor: "redteam-agent",
	budget: { max_tokens: 10000, max_tool_calls: 12, max_wall_time_ms: 120000, max_cost_usd: 3.5 },
	scopes: ["prompt", "workflow_gate"],
	action_allowlist: ["workflow_gate.answer", "bash.readonly"],
};

function request(overrides: Partial<BridgeHandshakeRequest> = {}): BridgeHandshakeRequest {
	return {
		protocol_version_range: { min: 1, max: 2 },
		capabilities: ["events", "workflow_gate"],
		requested_scopes: ["prompt"],
		...overrides,
	};
}

function server(overrides: Partial<Parameters<typeof negotiateBridgeHandshake>[1]> = {}) {
	return {
		sessionId: "sess-redteam",
		capabilities: ["events", "workflow_gate"] as const,
		scopes: ["prompt"] as const,
		endpoints: {
			events: "/events",
			commands: "/commands",
			uiResponses: "/ui",
			claimControl: "/claim",
			disconnectControl: "/disconnect",
			hostToolResults: "/tools",
			hostUriResults: "/uris",
		},
		frameTypes: ["event", "workflow_gate"] as const,
		...overrides,
	};
}

function handler() {
	return createBridgeFetchHandler({
		sessionId: "sess-redteam",
		token: "secret",
		commandScopes: ["prompt"],
		endpointMatrix: { events: true, commands: true },
		idempotencyCache: new Map(),
		commandDispatcher: async command => ({ id: command.id, type: "response", command: "prompt", success: true }),
	});
}

async function postHandshake(body: unknown) {
	const res = await handler()(
		new Request("https://bridge.test/v1/handshake", {
			method: "POST",
			headers: { Authorization: "Bearer secret" },
			body: JSON.stringify(body),
		}),
	);
	return { status: res.status, body: await res.json() };
}

describe("workflow_gate red-team declaration guards", () => {
	it("rejects malformed declarations and accepts a complete declaration", () => {
		const bad = [
			null,
			{ ...decl, budget: undefined },
			{ ...decl, budget: { ...decl.budget, max_cost_usd: Number.NaN } },
			{ ...decl, actor: undefined },
			{ ...decl, scopes: ["prompt", 7] },
			{ ...decl, action_allowlist: ["ok", 7] },
		];
		expect(isUnattendedDeclarationShape(decl)).toBe(true);
		for (const value of bad) expect(isUnattendedDeclarationShape(value)).toBe(false);
	});

	it("accepts absent and well-formed unattended but rejects malformed unattended", () => {
		expect(isBridgeHandshakeRequest(request())).toBe(true);
		expect(isBridgeHandshakeRequest(request({ unattended: decl }))).toBe(true);
		expect(isBridgeHandshakeRequest({ ...request(), unattended: { ...decl, scopes: ["prompt", 7] } })).toBe(false);
	});
});

describe("workflow_gate red-team negotiation", () => {
	it("does not accept or echo unattended when workflow_gate is requested but not offered", () => {
		const res = negotiateBridgeHandshake(
			request({ unattended: decl }),
			server({ capabilities: ["events"], frameTypes: ["event"] }),
		) as BridgeHandshakeAccepted;
		expect(res.status).toBe("accepted");
		expect(res.accepted_capabilities).not.toContain("workflow_gate");
		expect(res.unsupported).toContain("workflow_gate");
		expect(res.accepted_unattended).toBeUndefined();
	});

	it("accepts workflow_gate without echoing inactive unattended", () => {
		const res = negotiateBridgeHandshake(request({ unattended: decl }), server()) as BridgeHandshakeAccepted;
		expect(res.status).toBe("accepted");
		expect(res.accepted_capabilities).toContain("workflow_gate");
		expect(res.frame_types).toContain("workflow_gate");
		expect(res.accepted_unattended).toBeUndefined();
	});

	it("still rejects incompatible protocol versions", () => {
		const res = negotiateBridgeHandshake(
			request({ protocol_version_range: { min: 3, max: 3 }, unattended: decl }),
			server(),
		) as BridgeHandshakeRejected;
		expect(res.status).toBe("rejected");
		expect(res.reason).toBe("incompatible_version");
	});
});

describe("workflow_gate red-team frames", () => {
	it("creates replayable monotonic frames with unique ids and gate correlation", () => {
		const broker = new WorkflowGateBroker("run-redteam", new MemoryGateStore());
		const sequencer = new BridgeFrameSequencer("sess-redteam");
		const frames = Array.from({ length: 5 }, (_, index) => {
			const gate = broker.openGate(approvalGate({ summary: `gate ${index}` }));
			return { gate, frame: toBridgeWorkflowGateFrame(gate, sequencer) };
		});
		expect(frames.map(({ frame }) => frame.seq)).toEqual([1, 2, 3, 4, 5]);
		expect(new Set(frames.map(({ frame }) => frame.frame_id)).size).toBe(frames.length);
		for (const { gate, frame } of frames) {
			expect(frame.session_id).toBe("sess-redteam");
			expect(frame.correlation_id).toBe(gate.gate_id);
			expect(frame.payload.gate_id).toBe(gate.gate_id);
		}
		const otherGate = broker.openGate(approvalGate({ summary: "other" }));
		const otherFrame = toBridgeWorkflowGateFrame(otherGate, new BridgeFrameSequencer("sess-other"));
		expect(otherFrame.session_id).toBe("sess-other");
		expect(otherFrame.seq).toBe(1);
		expect(otherFrame.correlation_id).toBe(otherGate.gate_id);
	});
});

describe("workflow_gate red-team over the wire", () => {
	it("rejects malformed unattended declarations with invalid_request", async () => {
		const res = await postHandshake({ ...request(), unattended: { ...decl, action_allowlist: ["ok", 7] } });
		expect(res.status).toBeGreaterThanOrEqual(400);
		expect(res.status).toBeLessThan(500);
		expect(res.body).toEqual({ error: "invalid_request" });
	});

	it("accepts valid or absent unattended and advertises workflow_gate frame type", async () => {
		for (const body of [request(), request({ unattended: decl })]) {
			const res = await postHandshake(body);
			expect(res.status).toBe(200);
			const response = res.body as BridgeHandshakeAccepted;
			expect(response.accepted_capabilities).toContain("workflow_gate");
			expect(response.frame_types).toContain("workflow_gate");
			if ("unattended" in body) expect(response.accepted_unattended).toBeUndefined();
		}
	});
});
