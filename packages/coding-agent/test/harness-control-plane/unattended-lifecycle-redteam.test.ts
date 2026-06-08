/**
 * #323 adversarial hardening: prove unattended lifecycle guardrails fail closed.
 */
import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { RpcUnattendedDeclaration, RpcWorkflowGate } from "@gajae-code/coding-agent/modes/rpc/rpc-types";
import {
	approvalGate,
	decodeApproval,
	executionGate,
} from "@gajae-code/coding-agent/modes/shared/agent-wire/approval-gate";
import {
	type AskGateQuestion,
	gateAnswerToResult,
	questionToGate,
} from "@gajae-code/coding-agent/modes/shared/agent-wire/deep-interview-gate";
import { UnattendedAuditLog } from "@gajae-code/coding-agent/modes/shared/agent-wire/unattended-audit";
import {
	ActionDeniedError,
	ScopeDeniedError,
	type UnattendedAuditEvent,
	UnattendedBudgetExceededError,
	UnattendedRunController,
} from "@gajae-code/coding-agent/modes/shared/agent-wire/unattended-run-controller";
import {
	FileGateStore,
	type GateAuditEvent,
	WorkflowGateBroker,
} from "@gajae-code/coding-agent/modes/shared/agent-wire/workflow-gate-broker";

const DECLARATION: RpcUnattendedDeclaration = {
	actor: "openclaw/hermes",
	budget: { max_tokens: 1_000_000, max_tool_calls: 100, max_wall_time_ms: 600_000, max_cost_usd: 50 },
	scopes: ["prompt", "control", "bash"],
	action_allowlist: ["command.prompt", "command.control", "command.bash", "bash.readonly"],
};

const DI_QUESTIONS: AskGateQuestion[] = [
	{
		id: "topology",
		question: "Round 0: solo or team?",
		options: [{ label: "solo" }, { label: "team" }],
		recommended: 0,
	},
	{ id: "auth", question: "Which auth method?", options: [{ label: "JWT" }, { label: "OAuth2" }], recommended: 1 },
];

class ScriptedMemoryAgent {
	answer(gate: RpcWorkflowGate): unknown {
		if (gate.stage === "deep-interview") {
			const first = gate.options?.[0]?.value;
			return first !== undefined
				? { selected: [first], other: false }
				: { selected: [], other: true, custom: "memory" };
		}
		if (gate.kind === "approval") return { decision: "approve", comments: "approved from memory" };
		if (gate.kind === "execution") return { decision: "approve", reason: "criteria met" };
		return { decision: "approve" };
	}
}

function makeHarness(overrides: Partial<RpcUnattendedDeclaration> = {}) {
	const dir = mkdtempSync(path.join(tmpdir(), "unattended-redteam-"));
	const runId = `redteam-${path.basename(dir)}`;
	const sessionId = "redteam-session";
	const declaration: RpcUnattendedDeclaration = {
		...DECLARATION,
		...overrides,
		budget: overrides.budget ?? DECLARATION.budget,
		scopes: overrides.scopes ?? DECLARATION.scopes,
		action_allowlist: overrides.action_allowlist ?? DECLARATION.action_allowlist,
	};
	const auditLog = new UnattendedAuditLog(path.join(dir, "audit", "run.jsonl"));
	const audit = (event: UnattendedAuditEvent) => {
		if (event.event === "unattended_negotiated") {
			auditLog.record({
				run_id: runId,
				session_id: sessionId,
				actor: declaration.actor,
				event: "unattended_negotiated",
				outcome: "info",
				dedupe_key: `${runId}:negotiated`,
			});
		} else if (event.event === "budget_exceeded") {
			auditLog.record({
				run_id: runId,
				session_id: sessionId,
				actor: declaration.actor,
				event: "budget_exceeded",
				outcome: "exceeded",
				dedupe_key: `${runId}:budget:${event.payload.metric}:${event.payload.phase}`,
				budget: event.payload,
			});
		} else if (event.event === "scope_denied") {
			auditLog.record({
				run_id: runId,
				session_id: sessionId,
				actor: declaration.actor,
				event: "scope_denied",
				outcome: "denied",
				dedupe_key: `${runId}:scope:${event.payload.scope}:${event.payload.command ?? ""}`,
				scope: event.payload.scope,
				error: event.payload,
			});
		} else if (event.event === "action_denied") {
			auditLog.record({
				run_id: runId,
				session_id: sessionId,
				actor: declaration.actor,
				event: "action_denied",
				outcome: "denied",
				dedupe_key: `${runId}:action:${event.payload.action}:${event.payload.command ?? ""}`,
				action: event.payload.action,
				error: event.payload,
			});
		}
	};
	const controller = UnattendedRunController.negotiate(declaration, {
		runId,
		sessionId,
		providerSupportsTokenCostMetrics: true,
		audit,
	});
	const brokerAudit: GateAuditEvent[] = [];
	const broker = new WorkflowGateBroker(runId, new FileGateStore(path.join(dir, "gates", "store.json")), {
		audit: e => brokerAudit.push(e),
	});
	return { auditLog, broker, brokerAudit, controller, declaration, dir, runId, sessionId };
}

async function resolveViaBroker(
	harness: ReturnType<typeof makeHarness>,
	gateInput: Parameters<WorkflowGateBroker["openGate"]>[0],
	answer: unknown,
) {
	const gate = harness.broker.openGate(gateInput);
	const resolution = await harness.broker.resolve({ gate_id: gate.gate_id, answer });
	if (resolution.status === "accepted") {
		harness.auditLog.record({
			run_id: harness.runId,
			session_id: harness.sessionId,
			actor: harness.declaration.actor,
			event: "gate_response_accepted",
			outcome: "accepted",
			dedupe_key: `${gate.gate_id}:accepted`,
			gate_id: gate.gate_id,
			stage: gate.stage,
			kind: gate.kind,
			answer,
			answer_hash: resolution.answer_hash,
		});
	}
	return { gate, resolution };
}

describe("#323 unattended lifecycle red-team guardrails", () => {
	it("aborts and audits when a tiny budget is breached mid-lifecycle", async () => {
		const harness = makeHarness({
			budget: { ...DECLARATION.budget, max_tool_calls: 1 },
		});
		const agent = new ScriptedMemoryAgent();

		const firstGate = harness.broker.openGate(questionToGate(DI_QUESTIONS[0]!));
		harness.controller.preflightToolCall("first gate round");
		const answer = agent.answer(firstGate);
		const resolution = await harness.broker.resolve({ gate_id: firstGate.gate_id, answer });
		expect(resolution.status).toBe("accepted");

		expect(() => harness.controller.preflightToolCall("second gate round")).toThrow(UnattendedBudgetExceededError);
		expect(harness.controller.isAborted).toBe(true);
		await harness.controller.abortCompletion;
		const budgetEvents = harness.auditLog.query({ run_id: harness.runId, event: "budget_exceeded" });
		expect(budgetEvents).toHaveLength(1);
		expect(budgetEvents[0]!.budget?.metric).toBe("tool_calls");
	});

	it("denies destructive bash before simulated executeBash side effects and audits the denial", () => {
		const harness = makeHarness();
		let executeBashCalls = 0;
		const executeBash = (command: string) => {
			harness.controller.authorizeBash(command);
			executeBashCalls += 1;
		};

		expect(() => executeBash("git push --force origin main")).toThrow(ActionDeniedError);
		expect(() => executeBash("rm -rf /important")).toThrow(ActionDeniedError);
		expect(executeBashCalls).toBe(0);
		const denied = harness.auditLog.query({ run_id: harness.runId, event: "action_denied" });
		expect(denied).toHaveLength(2);
		expect(
			denied.every(
				r => r.outcome === "denied" && r.error && (r.error as { pre_side_effect?: boolean }).pre_side_effect,
			),
		).toBe(true);
	});

	it("denies out-of-allowlist command scope", () => {
		const harness = makeHarness({ scopes: ["prompt", "control"] });

		expect(() => harness.controller.authorizeScope("bash", "bash requested outside declared scope")).toThrow(
			ScopeDeniedError,
		);
		const denied = harness.auditLog.query({ run_id: harness.runId, event: "scope_denied" });
		expect(denied).toHaveLength(1);
		expect(denied[0]!.scope).toBe("bash");
		expect((denied[0]!.error as { pre_side_effect?: boolean }).pre_side_effect).toBe(true);
	});

	it("rejects malformed gate answers and leaves the gate pending until a valid answer is supplied", async () => {
		const harness = makeHarness();
		const gate = harness.broker.openGate(approvalGate({ summary: "red-team malformed gate" }));

		const malformed = await harness.broker.resolve({
			gate_id: gate.gate_id,
			answer: { decision: "approve", extra: "skip" },
		});
		expect(malformed.status).toBe("rejected");
		expect(harness.brokerAudit.filter(e => e.event === "gate_response_rejected")).toHaveLength(1);

		const validAnswer = { decision: "approve", comments: "valid retry" };
		const valid = await harness.broker.resolve({ gate_id: gate.gate_id, answer: validAnswer });
		expect(valid.status).toBe("accepted");
		expect(decodeApproval(validAnswer).approved).toBe(true);
		expect(harness.brokerAudit.filter(e => e.event === "gate_response_accepted")).toHaveLength(1);
		expect(() => harness.broker.resolve({ gate_id: gate.gate_id, answer: validAnswer })).toThrow();
	});

	it("records a complete audit trail for resolved gates plus denial and breach events", async () => {
		const harness = makeHarness({ budget: { ...DECLARATION.budget, max_tool_calls: 1 } });
		const agent = new ScriptedMemoryAgent();
		let resolvedGates = 0;

		for (const question of DI_QUESTIONS) {
			const gate = harness.broker.openGate(questionToGate(question));
			const answer = agent.answer(gate);
			const resolution = await harness.broker.resolve({ gate_id: gate.gate_id, answer });
			expect(resolution.status).toBe("accepted");
			harness.auditLog.record({
				run_id: harness.runId,
				session_id: harness.sessionId,
				actor: harness.declaration.actor,
				event: "gate_response_accepted",
				outcome: "accepted",
				dedupe_key: `${gate.gate_id}:accepted`,
				gate_id: gate.gate_id,
				stage: gate.stage,
				kind: gate.kind,
				answer,
				answer_hash: resolution.answer_hash,
			});
			gateAnswerToResult(question, answer);
			resolvedGates += 1;
		}

		const approvalAnswer = { decision: "approve", comments: "plan approved" };
		await resolveViaBroker(harness, approvalGate({ summary: "approve plan" }), approvalAnswer);
		resolvedGates += 1;

		const executionAnswer = { decision: "approve", reason: "execution complete" };
		await resolveViaBroker(harness, executionGate({ summary: "approve execution" }), executionAnswer);
		resolvedGates += 1;

		expect(() => harness.controller.authorizeBash("rm -rf /important")).toThrow(ActionDeniedError);
		harness.controller.preflightToolCall("first tool");
		expect(() => harness.controller.preflightToolCall("second tool")).toThrow(UnattendedBudgetExceededError);
		await harness.controller.abortCompletion;

		const audited = harness.auditLog.query({ run_id: harness.runId });
		const gateRecords = audited.filter(r => r.event === "gate_response_accepted");
		const guardrailEvents = audited.filter(r => r.event === "action_denied" || r.event === "budget_exceeded");
		expect(gateRecords).toHaveLength(resolvedGates);
		expect(guardrailEvents).toHaveLength(2);
		expect(gateRecords.every(r => r.answer !== undefined && typeof r.answer_hash === "string")).toBe(true);
		expect(gateRecords.length + guardrailEvents.length).toBe(resolvedGates + 2);
	});
});
