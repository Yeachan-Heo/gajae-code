import { describe, expect, it } from "bun:test";
import { negotiateBridgeHandshake } from "../../src/modes/shared/agent-wire/handshake";
import { BRIDGE_PROTOCOL_VERSION } from "../../src/modes/shared/agent-wire/protocol";

const server = {
	sessionId: "sess-1",
	capabilities: ["events", "prompt", "permission", "elicitation", "ui.declarative"] as const,
	scopes: ["prompt", "message:read"] as const,
	endpoints: {
		events: "/v1/sessions/sess-1/events",
		commands: "/v1/sessions/sess-1/commands",
		uiResponses: "/v1/sessions/sess-1/ui-responses/{correlation_id}",
		claimControl: "/v1/sessions/sess-1/control:claim",
		disconnectControl: "/v1/sessions/sess-1/control:disconnect",
		hostToolResults: "/v1/sessions/sess-1/host-tool-results/{correlation_id}",
		hostUriResults: "/v1/sessions/sess-1/host-uri-results/{correlation_id}",
	},
	frameTypes: ["event", "response", "ui_request", "permission_request"] as const,
};

describe("agent-wire bridge handshake", () => {
	it("accepts compatible clients and reports unsupported capabilities explicitly", () => {
		const response = negotiateBridgeHandshake(
			{
				protocol_version_range: { min: 1, max: 2 },
				capabilities: ["events", "prompt", "ui.editor", "ui.declarative"],
				requested_scopes: ["prompt", "bash", "message:read"],
			},
			server,
		);
		expect(response.status).toBe("accepted");
		if (response.status !== "accepted") throw new Error("handshake was rejected");
		expect(response.protocol_version).toBe(BRIDGE_PROTOCOL_VERSION);
		expect(response.session_id).toBe("sess-1");
		expect(response.accepted_capabilities).toEqual(["events", "prompt", "ui.declarative"]);
		expect(response.unsupported).toEqual(["ui.editor"]);
		expect(response.accepted_scopes).toEqual(["prompt", "message:read"]);
		expect(response.endpoints.events).toContain("/events");
	});

	it("rejects incompatible major versions", () => {
		const response = negotiateBridgeHandshake(
			{
				protocol_version_range: { min: 3, max: 4 },
				capabilities: ["events"],
				requested_scopes: ["prompt"],
			},
			server,
		);
		expect(response.status).toBe("rejected");
		if (response.status !== "rejected") throw new Error("handshake was accepted");
		expect(response.reason).toBe("incompatible_version");
		expect(response.message).toContain("outside client range");
	});
});
