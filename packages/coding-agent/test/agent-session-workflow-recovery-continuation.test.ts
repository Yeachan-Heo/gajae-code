import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as crypto from "node:crypto";
import * as path from "node:path";
import { Agent } from "@gajae-code/agent-core";
import * as compactionModule from "@gajae-code/agent-core/compaction";
import type { AssistantMessage } from "@gajae-code/ai";
import { getBundledModel } from "@gajae-code/ai/models";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { loadExtensions } from "@gajae-code/coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@gajae-code/coding-agent/extensibility/extensions/runner";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import * as activeStateModule from "@gajae-code/coding-agent/skill-state/active-state";
import { getProjectAgentDir, TempDir } from "@gajae-code/utils";

function assistantMessage(stopReason: "stop" | "length" = "stop"): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		stopReason,
		usage: {
			input: 190000,
			output: 1000,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 191000,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: Date.now(),
	} as AssistantMessage;
}

describe("AgentSession workflow recovery continuation (#4560)", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	let sessionManager: SessionManager;
	let authStorage: AuthStorage;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-4560-continuation-");
		const extensionPath = path.join(getProjectAgentDir(tempDir.path()), "extensions", "compact.ts");
		await Bun.write(extensionPath, "export default function(pi) {}");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage);
		sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		const extensionsResult = await loadExtensions([extensionPath], tempDir.path());
		const extensionRunner = new ExtensionRunner(
			extensionsResult.extensions,
			extensionsResult.runtime,
			tempDir.path(),
			sessionManager,
			modelRegistry,
		);
		const bundledModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!bundledModel) throw new Error("Expected built-in anthropic model");
		const agent = new Agent({
			initialState: {
				model: { ...bundledModel, contextWindow: 200_000 },
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
		});
		sessionManager.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({
				"compaction.autoContinue": true,
				"contextPromotion.enabled": false,
				"todo.reminders": false,
			}),
			modelRegistry,
			extensionRunner,
		});
		vi.spyOn(compactionModule, "compact").mockImplementation(async preparation => ({
			summary: "compacted",
			shortSummary: undefined,
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: preparation.tokensBefore,
			details: {},
		}));
	});

	afterEach(async () => {
		await session.dispose();
		authStorage.close();
		tempDir.removeSync();
		vi.restoreAllMocks();
	});

	async function compact(stopReason: "stop" | "length" = "stop"): Promise<void> {
		const message = assistantMessage(stopReason);
		sessionManager.appendMessage(message);
		session.agent.emitExternalEvent({ type: "message_end", message });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [message] });
		for (let i = 0; i < 20; i++) await Promise.resolve();
		await session.waitForIdle();
		await Bun.sleep(25);
		await session.waitForIdle();
	}

	async function seedActiveSkillState(phase: string, skill = "ultragoal"): Promise<void> {
		const { sessionPath } = activeStateModule.getSkillActiveStatePaths(tempDir.path(), session.sessionId);
		await Bun.write(
			sessionPath,
			JSON.stringify({
				version: 1,
				active_skills: [{ skill, phase, active: true, updated_at: new Date().toISOString() }],
			}),
		);
	}

	async function seedUltragoalPlan(): Promise<void> {
		const dir = path.join(tempDir.path(), ".gjc", `_session-${session.sessionId}`, "ultragoal");
		const now = new Date().toISOString();
		await Bun.write(
			path.join(dir, "goals.json"),
			JSON.stringify({
				version: 1,
				brief: "b",
				gjcGoalMode: "aggregate",
				gjcObjective: "Ship the durable recovery contract",
				goals: [
					{
						id: "G001",
						title: "Implement",
						objective: "Implement the contract",
						status: "complete",
						createdAt: now,
						updatedAt: now,
						evidence: "focused tests pass",
					},
					{
						id: "G002",
						title: "Verify",
						objective: "Verify resumption",
						status: "active",
						createdAt: now,
						updatedAt: now,
					},
				],
				createdAt: now,
				updatedAt: now,
			}),
		);
	}

	async function seedRalplanReview(): Promise<void> {
		const runId = "review-run";
		const runDir = path.join(tempDir.path(), ".gjc", `_session-${session.sessionId}`, "plans", "ralplan", runId);
		const plan = `Plan the durable recovery contract.\n\n## Accepted Scope\n- recovery projection\n\n## Non-Goals\n- unrelated UI changes\n\n## Acceptance Criteria\n- forced compaction resumes plan review\n`;
		const artifactPath = path.join(runDir, "stage-01-planner.md");
		await Bun.write(artifactPath, plan);
		await Bun.write(
			path.join(runDir, "index.jsonl"),
			`${JSON.stringify({
				stage: "planner",
				stage_n: 1,
				path: artifactPath,
				sha256: crypto.createHash("sha256").update(plan).digest("hex"),
			})}\n`,
		);
		await Bun.write(
			path.join(tempDir.path(), ".gjc", `_session-${session.sessionId}`, "state", "ralplan-state.json"),
			JSON.stringify({ run_id: runId, current_phase: "planner", active: true }),
		);
	}

	async function seedJoinedCohort(sourceHash: string): Promise<void> {
		const dir = path.join(tempDir.path(), ".gjc", `_session-${session.sessionId}`, "ultragoal");
		await Bun.write(
			path.join(dir, "ledger.jsonl"),
			`${JSON.stringify({
				event: "goal_checkpointed",
				status: "complete",
				goalId: "G001",
				eventId: "evt-1",
				qualityGateJson: { iteration: { reviewCohort: { reviewGeneration: 2, sourceHash } } },
			})}\n`,
		);
	}

	async function seedUltragoalPlanWithBlockedGoal(): Promise<void> {
		const dir = path.join(tempDir.path(), ".gjc", `_session-${session.sessionId}`, "ultragoal");
		const now = new Date().toISOString();
		await Bun.write(
			path.join(dir, "goals.json"),
			JSON.stringify({
				version: 1,
				brief: "b",
				gjcGoalMode: "aggregate",
				gjcObjective: "Ship the durable recovery contract",
				goals: [
					{
						id: "G001",
						title: "Implement",
						objective: "Implement the contract",
						status: "complete",
						createdAt: now,
						updatedAt: now,
						evidence: "focused tests pass",
					},
					{
						id: "G002",
						title: "Resolve blockers",
						objective: "Resolve final review blockers",
						status: "review_blocked",
						createdAt: now,
						updatedAt: now,
					},
				],
				createdAt: now,
				updatedAt: now,
			}),
		);
	}

	it("continues from the structured workflow contract after compaction", async () => {
		await seedActiveSkillState("active");
		await seedUltragoalPlan();
		session.setGoalModeState({
			enabled: true,
			mode: "active",
			goal: {
				id: "goal-4560",
				objective: "Ship the durable recovery contract",
				status: "active",
				tokensUsed: 0,
				timeUsedSeconds: 0,
				createdAt: 0,
				updatedAt: 0,
			},
		});
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue();
		await compact("length");
		expect(promptSpy).toHaveBeenCalledTimes(1);
		const calls = promptSpy.mock.calls.flat(4) as unknown[];
		const text = JSON.stringify(calls);

		expect(text).toContain("workflow-recovery");
		expect(text).toContain("continue-current-goal");
		expect(text).toContain("G002");
		expect(text).toContain("Accepted scope");
		expect(text).not.toContain("STALLED:");
	});

	it("counts zero progress once per compaction rather than once per snapshot", async () => {
		await seedActiveSkillState("active");
		await seedUltragoalPlan();
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue();
		await compact("length");
		expect(JSON.stringify(promptSpy.mock.calls.at(-1))).not.toContain("STALLED:");
		await compact("length");
		expect(JSON.stringify(promptSpy.mock.calls.at(-1))).not.toContain("STALLED:");
		await compact("length");
		expect(JSON.stringify(promptSpy.mock.calls.at(-1))).toContain("STALLED:");
	});

	it("keeps terminal workflow phases continuation-inert", async () => {
		await seedActiveSkillState("handoff");
		await seedUltragoalPlan();
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue();
		await compact("length");
		expect(JSON.stringify(promptSpy.mock.calls)).not.toContain("workflow-recovery");
	});

	it("resumes ralplan at intent reconciliation, not consensus, after forced compaction", async () => {
		// #4560 review P1-1: a planner-only run must not resume into Architect/Critic
		// consensus, because its material intent was never reconciled.
		await seedActiveSkillState("planner", "ralplan");
		await seedRalplanReview();
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue();
		await compact("length");
		const text = JSON.stringify(promptSpy.mock.calls);
		expect(text).toContain("workflow-recovery");
		expect(text).toContain("reconcile-intent");
		expect(text).not.toContain("run-plan-review");
		expect(text).toContain("recovery projection");
	});

	it("preserves the joined cohort source identity across repeated compaction", async () => {
		// #4560 forced-compaction matrix: repeated compaction during boundary review
		// must keep projecting the same frozen source basis and the same next action,
		// so a resumed run cannot silently review a different source.
		await seedActiveSkillState("active");
		await seedUltragoalPlan();
		await seedJoinedCohort("sha256:frozen-basis-1");
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue();
		await compact("length");
		const first = JSON.stringify(promptSpy.mock.calls.at(-1));
		expect(first).toContain("sha256:frozen-basis-1");
		expect(first).toContain("continue-current-goal");
		await compact("length");
		const second = JSON.stringify(promptSpy.mock.calls.at(-1));
		expect(second).toContain("sha256:frozen-basis-1");
		expect(second).toContain("continue-current-goal");
	});

	it("resumes blocker resolution rather than re-review when blockers are open", async () => {
		// #4560 forced-compaction matrix: blocker-fix/re-review window. Compaction
		// here must resume at blocker resolution, not restart the review cohort.
		await seedActiveSkillState("active");
		await seedUltragoalPlanWithBlockedGoal();
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue();
		await compact("length");
		const text = JSON.stringify(promptSpy.mock.calls.at(-1));
		expect(text).toContain("resolve-review-blockers");
		expect(text).toContain("G002");
	});

	it("keeps the generic prompt when no durable workflow state exists", async () => {
		await seedActiveSkillState("active");
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue();
		await compact("length");
		expect(promptSpy).toHaveBeenCalledTimes(1);
		const calls = promptSpy.mock.calls.flat(2) as unknown[];
		const text = JSON.stringify(calls);
		expect(text).not.toContain("workflow-recovery");
	});
});
