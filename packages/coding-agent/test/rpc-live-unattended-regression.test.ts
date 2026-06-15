import { describe, expect, it } from "bun:test";
import type { RpcUnattendedDeclaration } from "@gajae-code/coding-agent/modes/rpc/rpc-types";
import { approvalGate } from "@gajae-code/coding-agent/modes/shared/agent-wire/approval-gate";
import { dispatchRpcCommand } from "@gajae-code/coding-agent/modes/shared/agent-wire/command-dispatch";
import { UnattendedSessionControlPlane } from "@gajae-code/coding-agent/modes/shared/agent-wire/unattended-session";

const declaration: RpcUnattendedDeclaration = {
	actor: "redteam",
	budget: { max_tokens: 100, max_tool_calls: 2, max_wall_time_ms: 10_000, max_cost_usd: 1 },
	scopes: ["prompt", "bash", "control"],
	action_allowlist: ["command.prompt", "command.bash", "command.control", "bash.readonly"],
};

type SessionStub = {
	readonly bashCalls: number;
	readonly promptCalls: number;
	setStats(next: { tokens: { total: number }; cost: number }): void;
} & Record<string, unknown>;

function sessionStub(): SessionStub {
	let bashCalls = 0;
	let promptCalls = 0;
	let stats = { tokens: { total: 0 }, cost: 0 };
	return {
		get bashCalls() {
			return bashCalls;
		},
		get promptCalls() {
			return promptCalls;
		},
		setStats(next: { tokens: { total: number }; cost: number }) {
			stats = next;
		},
		sessionId: "sess-live",
		model: undefined,
		thinkingLevel: undefined,
		isStreaming: false,
		isCompacting: false,
		steeringMode: "all",
		followUpMode: "all",
		interruptMode: "wait",
		sessionFile: undefined,
		sessionName: undefined,
		autoCompactionEnabled: false,
		messages: [],
		queuedMessageCount: 0,
		agent: { state: { tools: [] } },
		getTodoPhases: () => [],
		systemPrompt: "",
		getContextUsage: () => undefined,
		getSessionStats: () => stats,
		executeBash: async (_command: string) => {
			bashCalls += 1;
			return { command: _command, stdout: "", stderr: "", exitCode: 0 };
		},
		prompt: async () => {
			promptCalls += 1;
		},
		steer: async () => undefined,
		followUp: async () => undefined,
		abort: async () => undefined,
	} as SessionStub;
}

function context(session: ReturnType<typeof sessionStub>, cp: UnattendedSessionControlPlane) {
	return {
		session,
		output: () => undefined,
		hostToolRegistry: { setTools: () => [] },
		hostUriRegistry: { setSchemes: () => [] },
		createUiContext: () => ({ notify: () => undefined }),
		unattendedControlPlane: cp,
	} as never;
}

describe("live RPC unattended dispatch wiring", () => {
	it("denies unauthorized bash before side effects with typed payload", async () => {
		const session = sessionStub();
		const cp = new UnattendedSessionControlPlane({
			runId: "run-live",
			sessionId: "sess-live",
			emitFrame: () => undefined,
			providerSupportsTokenCostMetrics: true,
		});
		cp.negotiate(declaration);
		const res = await dispatchRpcCommand(
			{ id: "1", type: "bash", command: "rm -rf /tmp/nope" },
			context(session, cp),
		);
		expect(res.success).toBe(false);
		if (res.success) throw new Error("expected failure");
		expect(res.error).toMatchObject({ code: "action_denied", action: "file.delete", pre_side_effect: true });
		expect(session.bashCalls).toBe(0);
	});

	it("tracks live command budget and aborts before side effects", async () => {
		const session = sessionStub();
		const cp = new UnattendedSessionControlPlane({
			runId: "run-live",
			sessionId: "sess-live",
			emitFrame: () => undefined,
			providerSupportsTokenCostMetrics: true,
		});
		cp.negotiate(declaration);
		expect((await dispatchRpcCommand({ id: "1", type: "bash", command: "pwd" }, context(session, cp))).success).toBe(
			true,
		);
		expect((await dispatchRpcCommand({ id: "2", type: "bash", command: "pwd" }, context(session, cp))).success).toBe(
			true,
		);
		const res = await dispatchRpcCommand({ id: "3", type: "bash", command: "pwd" }, context(session, cp));
		expect(res.success).toBe(false);
		if (res.success) throw new Error("expected failure");
		expect(res.error).toMatchObject({ code: "budget_exceeded", metric: "tool_calls", observed: 3 });
		expect(session.bashCalls).toBe(2);
	});

	it("resolves emitted workflow gates through live dispatch", async () => {
		const emitted: unknown[] = [];
		const session = sessionStub();
		const cp = new UnattendedSessionControlPlane({
			runId: "run-live",
			sessionId: "sess-live",
			emitFrame: gate => emitted.push(gate),
			providerSupportsTokenCostMetrics: true,
		});
		cp.negotiate(declaration);
		const answerPromise = cp.emitGate(approvalGate({ summary: "ship?" }));
		const gate = emitted[0] as { gate_id: string };
		const res = await dispatchRpcCommand(
			{ id: "r", type: "workflow_gate_response", gate_id: gate.gate_id, answer: { decision: "approve" } },
			context(session, cp),
		);
		expect(res.success).toBe(true);
		await expect(answerPromise).resolves.toEqual({ decision: "approve" });
	});
});
