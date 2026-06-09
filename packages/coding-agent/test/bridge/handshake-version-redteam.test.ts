import { describe, expect, it } from "bun:test";
import { AGENT_WIRE_PROTOCOL_VERSION } from "../../src/modes/shared/agent-wire/event-contract";
import { AgentWireFrameSequencer, toAgentWireEventFrame } from "../../src/modes/shared/agent-wire/event-envelope";
import type { BridgeProtocolRange } from "../../src/modes/shared/agent-wire/handshake";
import { negotiateBridgeHandshake } from "../../src/modes/shared/agent-wire/handshake";
import type { AgentSessionEvent } from "../../src/session/agent-session";

const server = {
	sessionId: "sess-redteam",
	capabilities: ["events"] as const,
	scopes: ["prompt"] as const,
	endpoints: {
		events: "/v1/sessions/sess-redteam/events",
		commands: "/v1/sessions/sess-redteam/commands",
		uiResponses: "/v1/sessions/sess-redteam/ui-responses/{correlation_id}",
		claimControl: "/v1/sessions/sess-redteam/control:claim",
		disconnectControl: "/v1/sessions/sess-redteam/control:disconnect",
		hostToolResults: "/v1/sessions/sess-redteam/host-tool-results/{correlation_id}",
		hostUriResults: "/v1/sessions/sess-redteam/host-uri-results/{correlation_id}",
	},
	frameTypes: ["event"] as const,
};

function handshake(range: BridgeProtocolRange) {
	return negotiateBridgeHandshake(
		{
			protocol_version_range: range,
			capabilities: ["events"],
			requested_scopes: ["prompt"],
		},
		server,
	);
}

function eventOfType(type: AgentSessionEvent["type"]): AgentSessionEvent {
	return { type } as unknown as AgentSessionEvent;
}

describe("bridge handshake v2 red-team", () => {
	it("rejects pure v1 clients with no back-compat", () => {
		const response = handshake({ min: 1, max: 1 });
		expect(response.status).toBe("rejected");
		if (response.status !== "rejected") throw new Error("pure v1 handshake was accepted");
		expect(response.reason).toBe("incompatible_version");
	});

	it("accepts ranges that include v2", () => {
		for (const range of [
			{ min: 1, max: 2 },
			{ min: 2, max: 2 },
			{ min: 2, max: 5 },
		]) {
			const response = handshake(range);
			expect(response.status).toBe("accepted");
		}
	});

	it("rejects ranges that exclude v2", () => {
		for (const range of [
			{ min: 3, max: 4 },
			{ min: 0, max: 1 },
		]) {
			const response = handshake(range);
			expect(response.status).toBe("rejected");
			if (response.status !== "rejected") throw new Error(`range ${range.min}..${range.max} was accepted`);
			expect(response.reason).toBe("incompatible_version");
		}
	});

	it("accepts the exact v2 boundary and reports protocol v2", () => {
		const response = handshake({ min: 2, max: 2 });
		expect(response.status).toBe("accepted");
		if (response.status !== "accepted") throw new Error("exact v2 handshake was rejected");
		expect(response.protocol_version).toBe(AGENT_WIRE_PROTOCOL_VERSION);
		expect(response.protocol_version).toBe(2);
	});

	it("emits sequenced event frames with protocol v2", () => {
		const sequencer = new AgentWireFrameSequencer("sess-redteam");
		const frame = toAgentWireEventFrame(eventOfType("message_update"), sequencer);
		expect(frame.protocol_version).toBe(AGENT_WIRE_PROTOCOL_VERSION);
		expect(frame.protocol_version).toBe(2);
		expect(frame.seq).toBe(1);
		expect(frame.type).toBe("event");
	});
});
