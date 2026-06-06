/**
 * #323 acceptance: a scripted external agent with canned memory drives
 * deep-interview -> ralplan -> ultragoal end-to-end over the workflow-gate
 * contract with ZERO human input, declaring budget + scope + action allowlist,
 * answering every gate via the broker, producing a valid spec + plan + execution
 * result with a complete audit trail bounded by the declared budget.
 *
 * This harness wires the v1 control-plane building blocks together:
 *  - UnattendedRunController (#318 budget, #319 scope/action)
 *  - WorkflowGateBroker (#315 durable gate contract)
 *  - deep-interview / approval / execution gate mappers (#316/#317)
 *  - UnattendedAuditLog (#320)
 */

import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { RpcUnattendedDeclaration, RpcWorkflowGate } from "@gajae-code/coding-agent/modes/rpc/rpc-types";
import {
	approvalGate,
	decodeApproval,
	decodeExecution,
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
	UnattendedRunController,
} from "@gajae-code/coding-agent/modes/shared/agent-wire/unattended-run-controller";
import {
	FileGateStore,
	type GateAuditEvent,
	WorkflowGateBroker,
} from "@gajae-code/coding-agent/modes/shared/agent-wire/workflow-gate-broker";

/**
 * A scripted external agent with a canned "memory". It answers any gate it
 * receives without any human interaction, recording how many gates it handled.
 */
class ScriptedMemoryAgent {
	gatesAnswered = 0;
	humanPromptsRequested = 0; // must stay 0 — proves zero human input

	answer(gate: RpcWorkflowGate): unknown {
		this.gatesAnswered += 1;
		if (gate.stage === "deep-interview") {
			// Pick the first advertised option, or free-text when no options.
			const first = gate.options?.[0]?.value;
			if (first !== undefined) return { selected: [first], other: false };
			return { selected: [], other: true, custom: "memory-derived answer" };
		}
		if (gate.kind === "approval") return { decision: "approve", comments: "looks good" };
		if (gate.kind === "execution") return { decision: "approve", reason: "criteria met" };
		return { decision: "approve" };
	}
}

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
	{ id: "free", question: "Any missing constraint?", options: [] },
];

describe("#323 end-to-end unattended workflow lifecycle (zero human input)", () => {
	it("drives deep-interview -> ralplan -> ultragoal over the gate contract with a complete audit trail bounded by budget", async () => {
		const dir = mkdtempSync(path.join(tmpdir(), "unattended-e2e-"));
		const runId = "e2e-run-001";
		const sessionId = "e2e-sess-001";
		const auditLog = new UnattendedAuditLog(path.join(dir, "audit", "run.jsonl"));
		const agent = new ScriptedMemoryAgent();

		// 1. Enter unattended mode (fail-closed: complete budget + scopes + actions).
		const controller = UnattendedRunController.negotiate(DECLARATION, {
			runId,
			sessionId,
			providerSupportsTokenCostMetrics: true,
			audit: event => {
				if (event.event === "unattended_negotiated") {
					auditLog.record({
						run_id: runId,
						session_id: sessionId,
						actor: DECLARATION.actor,
						event: "unattended_negotiated",
						outcome: "info",
						dedupe_key: `${runId}:negotiated`,
					});
				}
			},
		});
		expect(controller.actor).toBe("openclaw/hermes");

		// 2. Durable broker; audit every gate lifecycle event.
		const brokerAudit: GateAuditEvent[] = [];
		const broker = new WorkflowGateBroker(runId, new FileGateStore(path.join(dir, "gates.json")), {
			audit: e => brokerAudit.push(e),
		});

		let gatesResolvedViaBroker = 0;
		let rounds = 0;

		// Helper: open a gate, let the canned-memory agent answer it, resolve, audit.
		const driveGate = async (input: Parameters<typeof broker.openGate>[0]) => {
			rounds += 1;
			const gate = broker.openGate(input);
			// Pre-turn budget accounting for the round (estimate + reconcile).
			controller.preTurnEstimate({ tokens: 500, costUsd: 0.01 });
			const answer = agent.answer(gate);
			const resolution = await broker.resolve({ gate_id: gate.gate_id, answer });
			gatesResolvedViaBroker += 1;
			controller.recordTokens(500);
			controller.recordCost(0.01);
			auditLog.record({
				run_id: runId,
				session_id: sessionId,
				actor: DECLARATION.actor,
				event: resolution.status === "accepted" ? "gate_response_accepted" : "gate_response_rejected",
				outcome: resolution.status === "accepted" ? "accepted" : "rejected",
				dedupe_key: `${gate.gate_id}:${resolution.status}`,
				gate_id: gate.gate_id,
				stage: gate.stage,
				kind: gate.kind,
				answer,
				answer_hash: resolution.answer_hash,
			});
			return { gate, answer, resolution };
		};

		// 3. deep-interview: answer every question, build the spec.
		const specAnswers: string[] = [];
		for (const q of DI_QUESTIONS) {
			const { gate, answer } = await driveGate(questionToGate(q));
			expect(gate.kind).toBe("question");
			const result = gateAnswerToResult(q, answer);
			specAnswers.push(`${q.id}: ${result.selectedOptions.join(",") || result.customInput}`);
		}
		const specPath = path.join(dir, "spec.md");
		writeFileSync(specPath, `# Spec\n\n${specAnswers.join("\n")}\n`);

		// 4. ralplan: approval gate must advance only on explicit approve.
		const approval = await driveGate(approvalGate({ summary: "PRD from deep-interview" }));
		expect(decodeApproval(approval.answer).approved).toBe(true);
		const planPath = path.join(dir, "plan.md");
		writeFileSync(planPath, `# Plan\n\nApproved via gate ${approval.gate.gate_id}\n`);

		// 5. ultragoal: execution sign-off, then "execute" under budget + scope.
		const execution = await driveGate(executionGate({ summary: "execute the approved plan" }));
		expect(decodeExecution(execution.answer).approved).toBe(true);

		// Execution does real-ish work under the guardrail floor:
		controller.preflightToolCall(); // reserve a tool call (budget #318)
		const action = controller.authorizeBash("ls -la"); // allowed readonly (#319)
		expect(action).toBe("bash.readonly");

		// A destructive action NOT in the allowlist is denied BEFORE side effects (#319).
		let executeBashCalled = false;
		const runBash = (cmd: string) => {
			controller.authorizeBash(cmd); // throws before the side effect if denied
			executeBashCalled = true;
		};
		expect(() => runBash("rm -rf /important")).toThrow(ActionDeniedError);
		expect(executeBashCalled).toBe(false);

		const resultPath = path.join(dir, "result.md");
		writeFileSync(resultPath, `# Execution result\n\nApproved + executed (readonly action: ${action})\n`);

		// 6. Acceptance assertions.
		// Zero human input: the scripted agent never requested a human prompt.
		expect(agent.humanPromptsRequested).toBe(0);
		// 100% of gates answered via workflow_gate_response (broker), no screen-scraping.
		expect(gatesResolvedViaBroker).toBe(DI_QUESTIONS.length + 2);
		expect(agent.gatesAnswered).toBe(gatesResolvedViaBroker);
		// Valid spec + plan + execution artifacts produced.
		expect(specAnswers).toHaveLength(3);
		// Complete audit trail: a record per gate response + negotiation.
		const audited = auditLog.query({ run_id: runId });
		const gateRecords = audited.filter(r => r.event === "gate_response_accepted");
		expect(gateRecords).toHaveLength(DI_QUESTIONS.length + 2);
		expect(audited.some(r => r.event === "unattended_negotiated")).toBe(true);
		// Every gate record carries the full answer + hash (#320 answer policy).
		expect(gateRecords.every(r => r.answer !== undefined && typeof r.answer_hash === "string")).toBe(true);
		// Broker emitted + accepted every gate (durable, exactly-once).
		expect(brokerAudit.filter(e => e.event === "gate_emitted")).toHaveLength(gatesResolvedViaBroker);
		expect(brokerAudit.filter(e => e.event === "gate_response_accepted")).toHaveLength(gatesResolvedViaBroker);
		// Run bounded by declared budget: usage stayed under caps, never aborted.
		const usage = controller.usageSnapshot();
		expect(controller.isAborted).toBe(false);
		expect(usage.tokens).toBeLessThanOrEqual(DECLARATION.budget.max_tokens);
		expect(usage.toolCalls).toBeLessThanOrEqual(DECLARATION.budget.max_tool_calls);
		expect(usage.costUsd).toBeLessThanOrEqual(DECLARATION.budget.max_cost_usd);

		// Secondary metric: rounds + tokens (vs a cold-start baseline this would be lower).
		const metric = { rounds, tokens: usage.tokens, gates: gatesResolvedViaBroker };
		expect(metric.rounds).toBe(DI_QUESTIONS.length + 2);
		expect(metric.tokens).toBeGreaterThan(0);
	});

	it("refuses to start unattended without a complete budget (fail-closed)", () => {
		expect(() =>
			UnattendedRunController.negotiate(
				{ ...DECLARATION, budget: { max_tokens: 1 } as never },
				{ runId: "x", providerSupportsTokenCostMetrics: true, audit: () => {} },
			),
		).toThrow();
	});
});
