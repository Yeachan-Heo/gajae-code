import { describe, expect, it } from "bun:test";
import { createBridgeFetchHandler } from "@gajae-code/coding-agent/modes/bridge/bridge-mode";
import { approvalGate } from "@gajae-code/coding-agent/modes/shared/agent-wire/approval-gate";
import type {
	BridgeHandshakeAccepted,
	BridgeHandshakeRequest,
} from "@gajae-code/coding-agent/modes/shared/agent-wire/handshake";
import { UiRequestBroker } from "@gajae-code/coding-agent/modes/shared/agent-wire/ui-request-broker";
import { UnattendedSessionControlPlane } from "@gajae-code/coding-agent/modes/shared/agent-wire/unattended-session";

const declaration = {
	actor: "bridge-agent",
	budget: { max_tokens: 100, max_tool_calls: 5, max_wall_time_ms: 10_000, max_cost_usd: 1 },
	scopes: ["prompt", "control"],
	action_allowlist: ["command.prompt", "command.control"],
};

function request(unattended = declaration): BridgeHandshakeRequest {
	return {
		protocol_version_range: { min: 1, max: 2 },
		capabilities: ["events", "workflow_gate"],
		requested_scopes: ["prompt", "control"],
		...(unattended ? { unattended } : {}),
	};
}

function authRequest(path: string, body?: unknown, headers: Record<string, string> = {}) {
	return new Request(`https://bridge.test${path}`, {
		method: "POST",
		headers: { Authorization: "Bearer secret", "Content-Type": "application/json", ...headers },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
}

describe("live bridge unattended workflow gate wiring", () => {
	it("does not claim accepted_unattended without an active control plane", async () => {
		const handle = createBridgeFetchHandler({
			sessionId: "sess-b",
			token: "secret",
			endpointMatrix: { events: true, commands: true },
			commandScopes: ["prompt", "control"],
		});
		const res = await handle(authRequest("/v1/handshake", request()));
		const body = (await res.json()) as BridgeHandshakeAccepted;
		expect(body.status).toBe("accepted");
		expect(body.accepted_capabilities).toContain("workflow_gate");
		expect(body.accepted_unattended).toBeUndefined();
		expect(body.unattended_active).toBeUndefined();
	});

	it("negotiates unattended during handshake and resolves gates through bridge ui-response compatibility route", async () => {
		const cp = new UnattendedSessionControlPlane({
			runId: "run-b",
			sessionId: "sess-b",
			emitFrame: () => undefined,
			providerSupportsTokenCostMetrics: true,
		});
		const permissionBroker = new UiRequestBroker<unknown, unknown>({ emitRequest: () => undefined });
		const handle = createBridgeFetchHandler({
			sessionId: "sess-b",
			token: "secret",
			endpointMatrix: { events: true, commands: true, control: true, uiResponses: true },
			commandScopes: ["prompt", "control"],
			unattendedControlPlane: cp,
			permissionBroker: permissionBroker as never,
			idempotencyCache: new Map(),
		});
		const hs = await handle(authRequest("/v1/handshake", request()));
		const accepted = (await hs.json()) as BridgeHandshakeAccepted;
		expect(accepted.accepted_unattended).toEqual(declaration);
		expect(accepted.unattended_active).toBe(true);
		const ownerToken = "owner-bridge-test";
		const claim = await handle(
			authRequest("/v1/sessions/sess-b/control:claim", undefined, { "X-GJC-Bridge-Owner-Token": ownerToken }),
		);
		expect(claim.status).toBe(200);

		const answerPromise = cp.emitGate(approvalGate({ summary: "bridge ship?" }));
		const gateId = "wg_runb_ralplan_000001";
		const response = await handle(
			authRequest(
				`/v1/sessions/sess-b/ui-responses/${gateId}`,
				{
					gate_id: gateId,
					answer: { decision: "approve" },
				},
				{ "X-GJC-Bridge-Owner-Token": ownerToken },
			),
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ gate_id: gateId, status: "accepted" });
		await expect(answerPromise).resolves.toEqual({ decision: "approve" });
	});
});
