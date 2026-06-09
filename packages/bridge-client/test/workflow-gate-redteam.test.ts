import { describe, expect, it } from "bun:test";
import type { BridgeFrame, WorkflowGate } from "../src";
import { BridgeClient, isWorkflowGateFrame } from "../src";

const gate: WorkflowGate = {
	type: "workflow_gate",
	gate_id: "wg_redteam_ralplan_000001",
	stage: "ralplan",
	kind: "approval",
	schema: { type: "object" },
	schema_hash: "hash-redteam",
	context: { title: "Approve?" },
	created_at: "2026-06-05T05:00:00.000Z",
	required: true,
};

function frame(type: string, payload: unknown): BridgeFrame {
	return {
		protocol_version: 2,
		session_id: "sess-1",
		seq: 1,
		frame_id: `${type}-1`,
		type,
		payload,
	};
}

function fakeClient(captured: Array<{ url: string; body: string | null; headers: Record<string, string> }>) {
	return new BridgeClient({
		baseUrl: "https://bridge.test",
		token: "bridge-token",
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

describe("bridge-client workflow_gate red-team coverage (#322)", () => {
	it("isWorkflowGateFrame rejects non-gate frames and gate frames without gate_id", () => {
		expect(isWorkflowGateFrame(frame("event", { type: "turn_start" }))).toBe(false);
		expect(isWorkflowGateFrame(frame("ui_request", { id: "ui-1", method: "confirm" }))).toBe(false);
		expect(isWorkflowGateFrame(frame("permission_request", { id: "perm-1" }))).toBe(false);
		expect(isWorkflowGateFrame(frame("workflow_gate", { ...gate, gate_id: undefined }))).toBe(false);
		expect(isWorkflowGateFrame(frame("workflow_gate", { ...gate }))).toBe(true);
	});

	it("respondGate omits idempotency fields when no idempotencyKey is provided", async () => {
		const captured: Array<{ url: string; body: string | null; headers: Record<string, string> }> = [];
		const client = fakeClient(captured);

		await client.respondGate("sess-1", gate.gate_id, "owner-token", { decision: "approve" });

		expect(captured[0]?.url).toBe(`https://bridge.test/v1/sessions/sess-1/ui-responses/${gate.gate_id}`);
		expect(captured[0]?.headers["idempotency-key"]).toBeUndefined();
		expect(captured[0]?.headers["x-gjc-bridge-owner-token"]).toBe("owner-token");
		expect(JSON.parse(captured[0]?.body ?? "{}")).toEqual({
			gate_id: gate.gate_id,
			answer: { decision: "approve" },
		});
	});

	it("respondGate posts to the exact gate response path with owner-token header", async () => {
		const captured: Array<{ url: string; body: string | null; headers: Record<string, string> }> = [];
		const client = fakeClient(captured);

		await client.respondGate("session/with space", "gate/with space", "owner-token", "approved", {
			idempotencyKey: "idem-1",
		});

		expect(captured[0]?.url).toBe(
			"https://bridge.test/v1/sessions/session%2Fwith%20space/ui-responses/gate%2Fwith%20space",
		);
		expect(captured[0]?.headers["idempotency-key"]).toBe("idem-1");
		expect(captured[0]?.headers["x-gjc-bridge-owner-token"]).toBe("owner-token");
		expect(JSON.parse(captured[0]?.body ?? "{}")).toEqual({
			gate_id: "gate/with space",
			answer: "approved",
			idempotency_key: "idem-1",
		});
	});

	it("consumeWorkflowGates routes only workflow_gate frames from a mixed event stream", async () => {
		const captured: Array<{ url: string; body: string | null; headers: Record<string, string> }> = [];
		const client = fakeClient(captured);
		const frames = [
			frame("event", { type: "turn_start" }),
			frame("workflow_gate", { ...gate, gate_id: "wg_1" }),
			frame("ui_request", { id: "ui-1", method: "confirm" }),
			frame("workflow_gate", { ...gate, gate_id: "wg_2" }),
		];
		client.events = async function* () {
			for (const item of frames) yield item;
		};

		const handled: Array<{ gate: WorkflowGate; answer: unknown }> = [];
		for await (const item of client.consumeWorkflowGates("sess-1", "owner-token", received => ({
			gate: received.gate_id,
		}))) {
			handled.push(item);
		}

		expect(handled.map(item => item.gate.gate_id)).toEqual(["wg_1", "wg_2"]);
		expect(captured.map(item => JSON.parse(item.body ?? "{}"))).toEqual([
			{ gate_id: "wg_1", answer: { gate: "wg_1" } },
			{ gate_id: "wg_2", answer: { gate: "wg_2" } },
		]);
	});
});
