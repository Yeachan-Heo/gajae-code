import { describe, expect, it } from "bun:test";
import type { AgentToolContext } from "@gajae-code/agent-core";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import type { RpcUnattendedDeclaration, RpcWorkflowGate } from "@gajae-code/coding-agent/modes/rpc/rpc-types";
import { approvalGate } from "@gajae-code/coding-agent/modes/shared/agent-wire/approval-gate";
import {
	UnattendedSessionControlPlane,
	type WorkflowGateEmitter,
} from "@gajae-code/coding-agent/modes/shared/agent-wire/unattended-session";
import type { OpenGateInput } from "@gajae-code/coding-agent/modes/shared/agent-wire/workflow-gate-broker";
import type { ToolSession } from "@gajae-code/coding-agent/tools";
import { AskTool } from "@gajae-code/coding-agent/tools/ask";

const DECL: RpcUnattendedDeclaration = {
	actor: "hermes",
	budget: { max_tokens: 1000, max_tool_calls: 10, max_wall_time_ms: 10_000, max_cost_usd: 5 },
	scopes: ["prompt"],
	action_allowlist: ["command.prompt"],
};

function makePlane(opts: { providerSupportsTokenCostMetrics?: boolean } = {}) {
	const emitted: RpcWorkflowGate[] = [];
	const plane = new UnattendedSessionControlPlane({
		runId: "redteam-run",
		emitFrame: gate => emitted.push(gate),
		...opts,
	});
	return { plane, emitted };
}

function tick(): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, 0));
}

async function expectStillPending<T>(promise: Promise<T>): Promise<void> {
	let settled = false;
	void promise.finally(() => {
		settled = true;
	});
	await tick();
	expect(settled).toBe(false);
}

function createContext(): AgentToolContext {
	return {
		hasUI: true,
		ui: {
			select: async () => undefined,
			editor: async () => undefined,
		},
		abort: () => {},
	} as unknown as AgentToolContext;
}

class StubEmitter implements WorkflowGateEmitter {
	readonly received: OpenGateInput[] = [];
	constructor(private readonly answerFor: (input: OpenGateInput) => unknown) {}
	isUnattended(): boolean {
		return true;
	}
	emitGate(input: OpenGateInput): Promise<unknown> {
		this.received.push(input);
		return Promise.resolve(this.answerFor(input));
	}
}

function createSession(emitter: WorkflowGateEmitter): ToolSession {
	return {
		cwd: "/tmp/test",
		hasUI: true,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
		getWorkflowGateEmitter: () => emitter,
	} as unknown as ToolSession;
}

describe("UnattendedSessionControlPlane red-team G011", () => {
	it("resolves two concurrent emitGate calls with their own answers when resolved out of order", async () => {
		const { plane, emitted } = makePlane();
		plane.negotiate(DECL);

		const firstPending = plane.emitGate(approvalGate({ title: "first" }));
		const secondPending = plane.emitGate(approvalGate({ title: "second" }));
		expect(emitted).toHaveLength(2);

		const secondAnswer = { decision: "reject", comments: "second answer" };
		const firstAnswer = { decision: "approve", comments: "first answer" };

		await expect(plane.resolveGate({ gate_id: emitted[1].gate_id, answer: secondAnswer })).resolves.toMatchObject({
			status: "accepted",
		});
		await expect(secondPending).resolves.toEqual(secondAnswer);
		await expectStillPending(firstPending);

		await expect(plane.resolveGate({ gate_id: emitted[0].gate_id, answer: firstAnswer })).resolves.toMatchObject({
			status: "accepted",
		});
		await expect(firstPending).resolves.toEqual(firstAnswer);
	});

	it("rejects malformed answers without resolving emitGate, then resolves the exact valid payload", async () => {
		const { plane, emitted } = makePlane();
		plane.negotiate(DECL);
		const pending = plane.emitGate(approvalGate({ title: "malformed" }));

		await expect(
			plane.resolveGate({ gate_id: emitted[0].gate_id, answer: { decision: "maybe" } }),
		).resolves.toMatchObject({ status: "rejected" });
		await expectStillPending(pending);

		const validAnswer = { decision: "request-changes", comments: "include migration notes" };
		await expect(plane.resolveGate({ gate_id: emitted[0].gate_id, answer: validAnswer })).resolves.toMatchObject({
			status: "accepted",
		});
		await expect(pending).resolves.toEqual(validAnswer);
	});

	it("throws unknown_gate for unknown gate_id and does not resolve pending emitGate calls", async () => {
		const { plane, emitted } = makePlane();
		plane.negotiate(DECL);
		const pending = plane.emitGate(approvalGate({ title: "still pending" }));

		await expect(
			plane.resolveGate({ gate_id: "wg_redteam_missing_000001", answer: { decision: "approve" } }),
		).rejects.toMatchObject({ code: "unknown_gate" });
		await expectStillPending(pending);

		const answer = { decision: "approve", comments: "real gate" };
		await expect(plane.resolveGate({ gate_id: emitted[0].gate_id, answer })).resolves.toMatchObject({
			status: "accepted",
		});
		await expect(pending).resolves.toEqual(answer);
	});

	it("fails closed on missing budget and unsupported provider metrics, keeping attended mode and rejecting emitGate", async () => {
		const missingBudget = { ...DECL, budget: undefined } as unknown as RpcUnattendedDeclaration;
		const noBudget = makePlane();
		expect(() => noBudget.plane.negotiate(missingBudget)).toThrow();
		expect(noBudget.plane.isUnattended()).toBe(false);
		await expect(noBudget.plane.emitGate(approvalGate())).rejects.toThrow(/before unattended mode is negotiated/);

		const noMetrics = makePlane({ providerSupportsTokenCostMetrics: false });
		expect(() => noMetrics.plane.negotiate(DECL)).toThrow();
		expect(noMetrics.plane.isUnattended()).toBe(false);
		await expect(noMetrics.plane.emitGate(approvalGate())).rejects.toThrow(/before unattended mode is negotiated/);
	});

	it("returns the cached resolution for idempotent replay without double-resolving or advancing", async () => {
		const { plane, emitted } = makePlane();
		plane.negotiate(DECL);
		let resolveCount = 0;
		const pending = plane.emitGate(approvalGate({ title: "idempotent" }));
		void pending.then(() => {
			resolveCount += 1;
		});

		const answer = { decision: "approve", comments: "once" };
		const first = await plane.resolveGate({
			gate_id: emitted[0].gate_id,
			answer,
			idempotency_key: "same-key",
		});
		await expect(pending).resolves.toEqual(answer);
		await tick();
		expect(resolveCount).toBe(1);

		const replay = await plane.resolveGate({
			gate_id: emitted[0].gate_id,
			answer,
			idempotency_key: "same-key",
		});
		expect(replay).toEqual(first);
		await tick();
		expect(resolveCount).toBe(1);
	});
});

describe("AskTool unattended gate red-team G011", () => {
	it("decodes a multi-select gate answer to multiple selectedOptions", async () => {
		const emitter = new StubEmitter(() => ({ selected: ["JWT", "OAuth2"], other: false }));
		const tool = new AskTool(createSession(emitter));

		const result = await tool.execute(
			"call-redteam-multi",
			{
				questions: [
					{
						id: "auth",
						question: "Which auth methods?",
						options: [{ label: "JWT" }, { label: "OAuth2" }, { label: "Passkeys" }],
						multi: true,
					},
				],
			},
			undefined,
			undefined,
			createContext(),
		);

		expect(emitter.received).toHaveLength(1);
		expect(emitter.received[0]).toMatchObject({ stage: "deep-interview", kind: "question" });
		expect(result.details).toMatchObject({ selectedOptions: ["JWT", "OAuth2"] });
	});
});
