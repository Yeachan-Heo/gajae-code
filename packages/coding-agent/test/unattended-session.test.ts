import { describe, expect, it } from "bun:test";
import type { RpcUnattendedDeclaration, RpcWorkflowGate } from "@gajae-code/coding-agent/modes/rpc/rpc-types";
import { approvalGate } from "@gajae-code/coding-agent/modes/shared/agent-wire/approval-gate";
import { questionToGate } from "@gajae-code/coding-agent/modes/shared/agent-wire/deep-interview-gate";
import {
	modelSupportsTokenCostMetrics,
	UnattendedSessionControlPlane,
} from "@gajae-code/coding-agent/modes/shared/agent-wire/unattended-session";

const DECL: RpcUnattendedDeclaration = {
	actor: "hermes",
	budget: { max_tokens: 1000, max_tool_calls: 10, max_wall_time_ms: 10_000, max_cost_usd: 5 },
	scopes: ["prompt"],
	action_allowlist: ["command.prompt"],
};

function makePlane() {
	const emitted: RpcWorkflowGate[] = [];
	const plane = new UnattendedSessionControlPlane({
		runId: "run-1",
		emitFrame: g => emitted.push(g),
		providerSupportsTokenCostMetrics: true,
	});
	return { plane, emitted };
}

describe("UnattendedSessionControlPlane", () => {
	it("is attended (no emitter) until unattended is negotiated", () => {
		const { plane } = makePlane();
		expect(plane.isUnattended()).toBe(false);
		expect(plane.emitGate(approvalGate())).rejects.toThrow(/before unattended mode is negotiated/);
	});

	it("negotiates fail-closed and refuses providers without token/cost metrics", () => {
		const emitted: RpcWorkflowGate[] = [];
		const plane = new UnattendedSessionControlPlane({
			runId: "r",
			emitFrame: g => emitted.push(g),
			providerSupportsTokenCostMetrics: false,
		});
		expect(() => plane.negotiate(DECL)).toThrow();
		expect(plane.isUnattended()).toBe(false);
	});

	it("negotiates fail-closed when the token/cost capability is omitted (#606: no implicit true default)", () => {
		const emitted: RpcWorkflowGate[] = [];
		const plane = new UnattendedSessionControlPlane({
			runId: "r-omitted",
			emitFrame: g => emitted.push(g),
			// providerSupportsTokenCostMetrics intentionally omitted (undefined).
		});
		expect(() => plane.negotiate(DECL)).toThrow();
		expect(plane.isUnattended()).toBe(false);
	});

	it("bridges emitGate to the RPC answer: the gate frame is emitted and the answer resolves the promise", async () => {
		const { plane, emitted } = makePlane();
		const accepted = plane.negotiate(DECL);
		expect(accepted.actor).toBe("hermes");
		expect(plane.isUnattended()).toBe(true);

		// A runtime emits a gate; the frame is sent to the transport and emitGate awaits.
		const pending = plane.emitGate(approvalGate({ summary: "PRD" }));
		expect(emitted).toHaveLength(1);
		const gate = emitted[0];
		expect(gate.kind).toBe("approval");

		// The external agent answers over RPC; resolveGate completes the emitGate promise.
		const resolution = await plane.resolveGate({ gate_id: gate.gate_id, answer: { decision: "approve" } });
		expect(resolution.status).toBe("accepted");
		await expect(pending).resolves.toEqual({ decision: "approve" });
	});

	it("resolves a synchronously answered emitted gate without losing the answer", async () => {
		let plane: UnattendedSessionControlPlane;
		const emitted: RpcWorkflowGate[] = [];
		plane = new UnattendedSessionControlPlane({
			runId: "run-sync",
			providerSupportsTokenCostMetrics: true,
			emitFrame: gate => {
				emitted.push(gate);
				void plane.resolveGate({ gate_id: gate.gate_id, answer: { decision: "approve" } });
			},
		});
		plane.negotiate(DECL);

		await expect(plane.emitGate(approvalGate({ summary: "sync?" }))).resolves.toEqual({ decision: "approve" });
		expect(emitted).toHaveLength(1);
	});

	it("bridges a deep-interview question gate end-to-end", async () => {
		const { plane, emitted } = makePlane();
		plane.negotiate(DECL);
		const pending = plane.emitGate(questionToGate({ id: "q", question: "auth?", options: [{ label: "JWT" }] }));
		const gate = emitted[0];
		const resolution = await plane.resolveGate({
			gate_id: gate.gate_id,
			answer: { selected: ["JWT"], other: false },
		});
		expect(resolution.status).toBe("accepted");
		await expect(pending).resolves.toEqual({ selected: ["JWT"], other: false });
	});

	it("rejects a schema-invalid answer and keeps the gate pending (emitGate stays unresolved)", async () => {
		const { plane, emitted } = makePlane();
		plane.negotiate(DECL);
		let resolved = false;
		const pending = plane.emitGate(approvalGate());
		void pending.then(() => {
			resolved = true;
		});
		const bad = await plane.resolveGate({ gate_id: emitted[0].gate_id, answer: { decision: "maybe" } });
		expect(bad.status).toBe("rejected");
		await Promise.resolve();
		expect(resolved).toBe(false);
		// A valid answer then resolves it.
		const good = await plane.resolveGate({ gate_id: emitted[0].gate_id, answer: { decision: "approve" } });
		expect(good.status).toBe("accepted");
		await expect(pending).resolves.toEqual({ decision: "approve" });
	});

	it("rejects a pending emitGate when the unattended run aborts (no forever-hang)", async () => {
		const emitted: RpcWorkflowGate[] = [];
		const plane = new UnattendedSessionControlPlane({
			runId: "run-abort",
			emitFrame: g => emitted.push(g),
			providerSupportsTokenCostMetrics: true,
		});
		plane.negotiate({
			...DECL,
			budget: { max_tokens: 1000, max_tool_calls: 1, max_wall_time_ms: 10_000, max_cost_usd: 5 },
		});
		const pending = plane.emitGate(approvalGate());
		let rejected = false;
		void pending.catch(() => {
			rejected = true;
		});
		const controller = plane.controller;
		expect(controller).toBeDefined();
		controller?.preflightToolCall();
		expect(() => controller?.preflightToolCall()).toThrow();
		await controller?.abortCompletion;
		await Promise.resolve();
		expect(rejected).toBe(true);
		await expect(pending).rejects.toThrow(/aborted/);
	});
	it("does not charge max_tool_calls for read-only/control commands; bash still charges (issue 04)", () => {
		const emitted: RpcWorkflowGate[] = [];
		const plane = new UnattendedSessionControlPlane({
			runId: "budget-run",
			emitFrame: g => emitted.push(g),
			providerSupportsTokenCostMetrics: true,
		});
		plane.negotiate({
			actor: "hermes",
			budget: { max_tokens: 1000, max_tool_calls: 10, max_wall_time_ms: 60_000, max_cost_usd: 5 },
			scopes: ["prompt", "control", "message:read", "bash"],
			action_allowlist: [
				"command.prompt",
				"command.control",
				"command.message_read",
				"command.bash",
				"bash.readonly",
			],
		});
		const controller = plane.controller;
		expect(controller).toBeDefined();
		// Read-only/control/cancellation commands must never consume the tool-call budget.
		for (let i = 0; i < 20; i++) {
			plane.preflightCommand({ type: "get_state" });
			plane.preflightCommand({ type: "set_steering_mode", mode: "all" });
			plane.preflightCommand({ type: "abort" });
		}
		expect(controller?.usageSnapshot().toolCalls).toBe(0);
		// A bash command performs real tool work and still charges one unit.
		plane.preflightCommand({ type: "bash", command: "pwd" });
		expect(controller?.usageSnapshot().toolCalls).toBe(1);
	});
});

describe("modelSupportsTokenCostMetrics", () => {
	it("fails closed for an undefined model", () => {
		expect(modelSupportsTokenCostMetrics(undefined)).toBe(false);
	});

	it("supports a model with no compat overrides", () => {
		expect(modelSupportsTokenCostMetrics({} as never)).toBe(true);
	});

	it("supports a model whose compat enables streaming usage", () => {
		expect(modelSupportsTokenCostMetrics({ compat: { supportsUsageInStreaming: true } } as never)).toBe(true);
	});

	it("fails closed for a model that suppresses streaming usage", () => {
		expect(modelSupportsTokenCostMetrics({ compat: { supportsUsageInStreaming: false } } as never)).toBe(false);
	});
});
