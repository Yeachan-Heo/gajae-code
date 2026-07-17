import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent, AgentBusyError } from "@gajae-code/agent-core";
import { getBundledModel } from "@gajae-code/ai";
import { createMockModel } from "@gajae-code/ai/providers/mock";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { type CustomEntry, SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import type { WorkflowIntentDiff } from "@gajae-code/coding-agent/workflow/workflow-intent-diff";
import { TempDir } from "@gajae-code/utils";

type WorkflowIntentDiffEntry = CustomEntry<WorkflowIntentDiff>;

describe("AgentSession workflow intent-diff tracking", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let sessionManager: SessionManager;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@gjc-workflow-intent-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "anthropic-test-key");
		const modelRegistry = new ModelRegistry(authStorage);
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled Anthropic test model to exist");

		const mock = createMockModel({
			responses: Array.from({ length: 12 }, () => ({ content: ["ack"] })),
		});
		const agent = new Agent({
			getApiKey: provider => `${provider}-test-key`,
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: mock.stream,
		});

		sessionManager = SessionManager.inMemory(tempDir.path());
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
		});
	});

	afterEach(async () => {
		await session.dispose();
		authStorage.close();
		tempDir.removeSync();
	});

	function workflowIntentEntries(): WorkflowIntentDiffEntry[] {
		return sessionManager
			.getEntries()
			.filter(
				(entry): entry is WorkflowIntentDiffEntry =>
					entry.type === "custom" && entry.customType === "workflow-intent-diff",
			);
	}

	it("records a CustomEntry-only intent diff for clear low-risk direct prompts", async () => {
		await session.prompt("fix packages/coding-agent/src/session/agent-session.ts null check");

		const [entry] = workflowIntentEntries();
		expect(entry?.data).toMatchObject({
			route: "direct",
			directTracking: "custom-entry-only",
			rootCausePhase: { status: "inactive", triggers: [] },
		});
		expect(entry?.data?.claimsLedger.claims).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: "workflow-route",
					evidence: expect.arrayContaining(["route: direct", "trigger: low-risk direct"]),
				}),
				expect.objectContaining({
					id: "root-cause-phase",
					evidence: expect.arrayContaining(["root-cause: inactive"]),
				}),
			]),
		);
		expect(entry?.data?.consensusReport).toMatchObject({
			version: 1,
			route: "direct",
			confidence: "high",
			escalationGate: {
				status: "not-required",
				reason: "clear low-risk prompt stays on direct implementation path",
			},
		});
		expect(entry?.data?.consensusReport.observerSignals).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					observer: "intent-router",
					conclusion: "direct",
				}),
				expect.objectContaining({
					observer: "root-cause-schema",
					conclusion: "inactive",
				}),
				expect.objectContaining({
					observer: "escalation-gate",
					conclusion: "not-required",
				}),
			]),
		);
		expect(session.agent.state.messages).not.toEqual(
			expect.arrayContaining([expect.objectContaining({ customType: "workflow-intent-diff" })]),
		);
	});

	it("records ralplan deliberate plus root-cause activation for high-risk sequence prompts", async () => {
		await session.prompt("plan the auth migration sequence and explain the regression risk before implementation");
		await session.prompt("avoid regression but migrate auth");

		const [combinedRisk, contrastiveRisk] = workflowIntentEntries();
		expect(combinedRisk?.data).toMatchObject({
			route: "ralplan",
			recommendedSkill: "ralplan",
			recommendedInvocation: "/skill:ralplan --deliberate",
			directTracking: "not-direct",
			rootCausePhase: { status: "active" },
			consensusReport: {
				route: "ralplan",
				confidence: "high",
				escalationGate: {
					status: "required",
					reason: "/skill:ralplan --deliberate",
				},
			},
		});
		expect(combinedRisk?.data?.claimsLedger.claims).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: "escalation-gate",
					evidence: expect.arrayContaining(["escalation: required", "invocation: /skill:ralplan --deliberate"]),
				}),
			]),
		);
		expect(combinedRisk?.data?.rootCausePhase.triggers).toEqual(
			expect.arrayContaining(["regression", "high-risk transition"]),
		);
		expect(contrastiveRisk?.data).toMatchObject({
			route: "ralplan",
			recommendedSkill: "ralplan",
			recommendedInvocation: "/skill:ralplan --deliberate",
			directTracking: "not-direct",
			rootCausePhase: { status: "active" },
		});
		expect(contrastiveRisk?.data?.rootCausePhase.triggers).toEqual(["high-risk transition"]);
	});

	it("records ambiguous and durable prompts as explicit workflow escalations", async () => {
		await session.prompt("I'm not sure what this product should be, don't assume the requirements");
		await session.prompt("create a durable goal ledger for this multi-step release");
		await session.prompt("create a durable goal ledger for this production release");

		const [deepInterview, ultragoal, productionUltragoal] = workflowIntentEntries();
		expect(deepInterview?.data).toMatchObject({
			route: "deep-interview",
			recommendedSkill: "deep-interview",
			recommendedInvocation: "/skill:deep-interview",
			directTracking: "not-direct",
		});
		expect(ultragoal?.data).toMatchObject({
			route: "ultragoal",
			recommendedSkill: "ultragoal",
			recommendedInvocation: "/skill:ultragoal",
			directTracking: "not-direct",
		});
		expect(productionUltragoal?.data).toMatchObject({
			route: "ultragoal",
			recommendedSkill: "ultragoal",
			recommendedInvocation: "/skill:ultragoal",
			directTracking: "not-direct",
			rootCausePhase: { status: "active", triggers: ["high-risk transition"] },
		});
	});

	it("lets ambiguous requirements take precedence over durable tracking words", async () => {
		await session.prompt("I'm not sure what this product should be; create a durable goal ledger after that");
		await session.prompt("ambiguous requirements; create a durable goal ledger after clarification");

		const [naturalLanguage, policyPhrase] = workflowIntentEntries();
		expect(naturalLanguage?.data).toMatchObject({
			route: "deep-interview",
			recommendedSkill: "deep-interview",
			recommendedInvocation: "/skill:deep-interview",
			directTracking: "not-direct",
		});
		expect(policyPhrase?.data).toMatchObject({
			route: "deep-interview",
			recommendedSkill: "deep-interview",
			recommendedInvocation: "/skill:deep-interview",
			directTracking: "not-direct",
		});
	});

	it("records coordinated persistent worker requests as team escalations", async () => {
		await session.prompt("use a team of coordinated persistent workers for this approved implementation");

		const [entry] = workflowIntentEntries();
		expect(entry?.data).toMatchObject({
			route: "team",
			recommendedSkill: "team",
			recommendedInvocation: "/skill:team",
			directTracking: "not-direct",
		});
	});

	it("keeps ordinary product-domain workflow words on the direct path", async () => {
		await session.prompt("fix the team settings page typo");
		await session.prompt("fix the auth settings page typo");
		await session.prompt("fix the production settings page typo");
		await session.prompt("fix the ledger table typo");
		await session.prompt("fix the checkpoint page typo");

		for (const entry of workflowIntentEntries()) {
			expect(entry.data).toMatchObject({
				route: "direct",
				directTracking: "custom-entry-only",
				rootCausePhase: { status: "inactive", triggers: [] },
			});
		}
	});

	it("activates root-cause phase for contradiction without requiring workflow escalation", async () => {
		await session.prompt("resolve the contradiction between the intended contract and the observed behavior");

		const [entry] = workflowIntentEntries();
		expect(entry?.data).toMatchObject({
			route: "direct",
			directTracking: "custom-entry-only",
			rootCausePhase: { status: "active" },
		});
		expect(entry?.data?.rootCausePhase.triggers).toEqual(["contradiction"]);
	});

	it("does not activate root-cause phase for explicitly absent risks", async () => {
		await session.prompt("plan the architecture sequence without migration or regression");

		const [entry] = workflowIntentEntries();
		expect(entry?.data).toMatchObject({
			route: "ralplan",
			rootCausePhase: { status: "inactive", triggers: [] },
		});
	});

	it("keeps rejected busy prompts out of workflow intent tracking", async () => {
		try {
			session.agent.state.isStreaming = true;

			await expect(session.prompt("fix the direct null check")).rejects.toBeInstanceOf(AgentBusyError);
			expect(workflowIntentEntries()).toEqual([]);
		} finally {
			session.agent.state.isStreaming = false;
		}
	});

	it("does not record workflow intent diffs for synthetic prompts", async () => {
		await session.prompt("internal continuation", { synthetic: true });

		expect(workflowIntentEntries()).toEqual([]);
	});
});
