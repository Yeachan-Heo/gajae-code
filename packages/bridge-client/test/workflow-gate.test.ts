import { describe, expect, it } from "bun:test";
import type { BridgeFrame, WorkflowGate } from "../src";
import { BridgeClient, isWorkflowGateFrame } from "../src";

function fakeClient(captured: Array<{ url: string; body: string | null; headers: Record<string, string> }>) {
	return new BridgeClient({
		baseUrl: "https://bridge.test",
		token: "secret",
		fetch: async (input, init) => {
			const headers = new Headers(init?.headers);
			captured.push({
				url: String(input),
				body: init?.body?.toString() ?? null,
				headers: Object.fromEntries(headers.entries()),
			});
			return new Response(JSON.stringify({ ok: true }), { status: 200 });
		},
	});
}

const gate: WorkflowGate = {
	type: "workflow_gate",
	gate_id: "wg_1_ralplan_000001",
	stage: "ralplan",
	kind: "approval",
	schema: { type: "object" },
	schema_hash: "h",
	context: { title: "Approve?" },
	created_at: "2026-06-05T05:00:00.000Z",
	required: true,
};

describe("bridge-client workflow_gate helpers (#322)", () => {
	it("isWorkflowGateFrame narrows workflow_gate frames", () => {
		const frame: BridgeFrame = {
			protocol_version: 2,
			session_id: "s",
			seq: 1,
			frame_id: "f",
			type: "workflow_gate",
			payload: gate,
		};
		const other: BridgeFrame = {
			protocol_version: 2,
			session_id: "s",
			seq: 2,
			frame_id: "g",
			type: "event",
			payload: {},
		};
		expect(isWorkflowGateFrame(frame)).toBe(true);
		expect(isWorkflowGateFrame(other)).toBe(false);
	});

	it("respondGate posts through the owner-token protected UI response endpoint", async () => {
		const captured: Array<{ url: string; body: string | null; headers: Record<string, string> }> = [];
		const client = fakeClient(captured);
		await client.respondGate(
			"sess-1",
			gate.gate_id,
			"owner-token",
			{ decision: "approve" },
			{ idempotencyKey: "k1" },
		);
		expect(captured[0]?.url).toBe(`https://bridge.test/v1/sessions/sess-1/ui-responses/${gate.gate_id}`);
		expect(captured[0]?.headers["x-gjc-bridge-owner-token"]).toBe("owner-token");
		expect(captured[0]?.headers["idempotency-key"]).toBe("k1");
		const body = JSON.parse(captured[0]?.body ?? "{}");
		expect(body).toEqual({
			gate_id: gate.gate_id,
			answer: { decision: "approve" },
			idempotency_key: "k1",
		});
	});

	it("includes the unattended declaration on the handshake request", async () => {
		const captured: Array<{ url: string; body: string | null; headers: Record<string, string> }> = [];
		const client = fakeClient(captured);
		await client.handshake({
			protocol_version_range: { min: 1, max: 2 },
			capabilities: ["events", "workflow_gate"],
			requested_scopes: ["prompt"],
			unattended: {
				actor: "hermes",
				budget: { max_tokens: 1, max_tool_calls: 1, max_wall_time_ms: 1, max_cost_usd: 1 },
				scopes: ["prompt"],
				action_allowlist: ["bash.readonly"],
			},
		});
		const body = JSON.parse(captured[0]?.body ?? "{}");
		expect(body.capabilities).toContain("workflow_gate");
		expect(body.unattended.actor).toBe("hermes");
	});
});
