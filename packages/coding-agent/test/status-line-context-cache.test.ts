/**
 * Regression guard for the display context snapshot consumed by the status line.
 *
 * Status refresh runs on every agent event. Once the snapshot is warm, it must
 * avoid materializing the session branch or re-estimating the message history.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { Agent, type AgentMessage, type AgentTool } from "@gajae-code/agent-core";
import { getBundledModel } from "@gajae-code/ai";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@gajae-code/coding-agent/config/settings";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";

const contextWindow = 200_000;
const sessions: AgentSession[] = [];
const authStorages: AuthStorage[] = [];

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
});

afterAll(() => {
	resetSettingsForTest();
});

afterEach(async () => {
	for (const session of sessions.splice(0)) {
		await session.dispose();
	}
	for (const authStorage of authStorages.splice(0)) {
		authStorage.close();
	}
});

async function createSession(messages: AgentMessage[] = []): Promise<{
	session: AgentSession;
	sessionManager: SessionManager;
}> {
	const bundledModel = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!bundledModel) throw new Error("Expected bundled anthropic model");

	const authStorage = await AuthStorage.create(":memory:");
	authStorage.setRuntimeApiKey("anthropic", "test-key");
	authStorages.push(authStorage);

	const sessionManager = SessionManager.inMemory();
	const agent = new Agent({
		initialState: {
			model: { ...bundledModel, contextWindow },
			systemPrompt: ["Test system prompt"],
			tools: [],
			messages,
		},
	});
	const session = new AgentSession({
		agent,
		sessionManager,
		settings: Settings.isolated({ "compaction.enabled": false, "todo.reminders": false }),
		modelRegistry: new ModelRegistry(authStorage),
	});
	sessions.push(session);
	return { session, sessionManager };
}

function requireContextUsage(session: AgentSession) {
	const usage = session.getContextUsage();
	if (!usage) throw new Error("Expected context usage");
	return usage;
}

function getContextUsageEstimateCount(session: AgentSession): number {
	return session.getContextUsageObservabilityForTests().estimateCount;
}

function expectContextUsageRecomputed(session: AgentSession, previousEstimateCount: number): void {
	expect(getContextUsageEstimateCount(session)).toBe(previousEstimateCount + 1);
}

function createTestTool(name: string, description: string): AgentTool {
	return {
		name,
		label: name,
		description,
		parameters: {},
		execute: async () => ({ content: [], details: {} }),
	} as unknown as AgentTool;
}

describe("AgentSession display context snapshot cache", () => {
	it("keeps warm context usage refreshes O(1) without rematerializing the branch or re-estimating history", async () => {
		const { session, sessionManager } = await createSession(
			Array.from({ length: 200 }, (_, index) => ({
				role: "user" as const,
				content: `message ${index} `.repeat(20),
				timestamp: index,
			})),
		);

		const materializationsBeforeWarmup =
			sessionManager.getObservabilityStatsForTests().getBranchMaterializerCallCount;
		const estimatesBeforeWarmup = getContextUsageEstimateCount(session);
		requireContextUsage(session);
		const materializationsAfterWarmup = sessionManager.getObservabilityStatsForTests().getBranchMaterializerCallCount;
		const estimatesAfterWarmup = getContextUsageEstimateCount(session);
		expect(materializationsAfterWarmup - materializationsBeforeWarmup).toBe(1);
		expect(estimatesAfterWarmup).toBe(estimatesBeforeWarmup + 1);

		for (let index = 0; index < 20; index++) requireContextUsage(session);

		expect(sessionManager.getObservabilityStatsForTests().getBranchMaterializerCallCount).toBe(
			materializationsAfterWarmup,
		);
		expect(getContextUsageEstimateCount(session)).toBe(estimatesAfterWarmup);
	});

	it("invalidates when the streaming last message grows in place", async () => {
		const { session } = await createSession([{ role: "user", content: "short", timestamp: 1 }]);
		const streaming = session.messages[0] as { content: string };

		const before = requireContextUsage(session);
		const estimateCount = getContextUsageEstimateCount(session);
		streaming.content += " longer streamed content".repeat(100);
		const after = requireContextUsage(session);

		expectContextUsageRecomputed(session, estimateCount);
		expect(after.tokens).toBeGreaterThan(before.tokens ?? 0);
	});

	it("invalidates when a message is appended", async () => {
		const { session } = await createSession([{ role: "user", content: "first", timestamp: 1 }]);

		const before = requireContextUsage(session);
		const estimateCount = getContextUsageEstimateCount(session);
		session.agent.appendMessage({ role: "user", content: "second message ".repeat(100), timestamp: 2 });
		const after = requireContextUsage(session);

		expectContextUsageRecomputed(session, estimateCount);
		expect(after.tokens).toBeGreaterThan(before.tokens ?? 0);
	});

	it("invalidates same-length replacement that keeps the tail object", async () => {
		const earlier = { role: "user" as const, content: "short earlier message", timestamp: 1 };
		const tail = { role: "user" as const, content: "unchanged tail", timestamp: 2 };
		const { session } = await createSession([earlier, tail]);

		const before = requireContextUsage(session);
		const estimateCount = getContextUsageEstimateCount(session);
		session.agent.replaceMessages([{ ...earlier, content: "replacement earlier content".repeat(100) }, tail]);
		const after = requireContextUsage(session);

		expect(session.messages.at(-1)).toBe(tail);
		expectContextUsageRecomputed(session, estimateCount);
		expect(after.tokens).toBeGreaterThan(before.tokens ?? 0);
	});

	it("invalidates an in-place non-last message mutation after touchContext", async () => {
		const { session } = await createSession([
			{ role: "user", content: "short earlier message", timestamp: 1 },
			{ role: "user", content: "unchanged tail", timestamp: 2 },
		]);

		const before = requireContextUsage(session);
		const estimateCount = getContextUsageEstimateCount(session);
		(session.messages[0] as { content: string }).content += " expanded earlier content".repeat(100);
		session.agent.touchContext();
		const after = requireContextUsage(session);

		expectContextUsageRecomputed(session, estimateCount);
		expect(after.tokens).toBeGreaterThan(before.tokens ?? 0);
	});

	it("invalidates a same-length system-prompt swap", async () => {
		const sparsePrompt = "a".repeat(1_000);
		const densePrompt = "中".repeat(1_000);
		const { session } = await createSession();
		session.agent.setSystemPrompt([sparsePrompt]);

		const before = requireContextUsage(session);
		const estimateCount = getContextUsageEstimateCount(session);
		session.agent.setSystemPrompt([densePrompt]);
		const after = requireContextUsage(session);

		expect(densePrompt).toHaveLength(sparsePrompt.length);
		expectContextUsageRecomputed(session, estimateCount);
		expect(after.tokens).toBeGreaterThan(before.tokens ?? 0);
	});

	it("invalidates a same-count tools swap", async () => {
		const { session } = await createSession();
		session.agent.setTools([createTestTool("first-tool", "first tool")]);

		const before = requireContextUsage(session);
		const estimateCount = getContextUsageEstimateCount(session);
		session.agent.setTools([createTestTool("replacement-tool", "replacement tool ".repeat(100))]);
		const after = requireContextUsage(session);

		expectContextUsageRecomputed(session, estimateCount);
		expect(after.tokens).toBeGreaterThan(before.tokens ?? 0);
	});

	it("invalidates when the last message is removed", async () => {
		const { session } = await createSession([
			{ role: "user", content: "first message ".repeat(100), timestamp: 1 },
			{ role: "user", content: "second message ".repeat(100), timestamp: 2 },
		]);

		const before = requireContextUsage(session);
		const estimateCount = getContextUsageEstimateCount(session);
		session.agent.popMessage();
		const after = requireContextUsage(session);

		expectContextUsageRecomputed(session, estimateCount);
		expect(after.tokens).toBeLessThan(before.tokens ?? Number.POSITIVE_INFINITY);
	});

	it("invalidates after compaction and reports unknown until a new assistant usage anchor", async () => {
		const kept = { role: "user" as const, content: "kept", timestamp: 1 };
		const { session, sessionManager } = await createSession([kept]);
		const keptEntryId = sessionManager.appendMessage(kept);

		requireContextUsage(session);
		const estimateCount = getContextUsageEstimateCount(session);
		sessionManager.appendCompaction("summary", "summary", keptEntryId, 1_000);
		const usage = requireContextUsage(session);

		expectContextUsageRecomputed(session, estimateCount);
		expect(usage).toEqual({
			tokens: null,
			contextWindow,
			percent: null,
			source: "unknown",
		});
	});

	it("invalidates when the model changes", async () => {
		const { session } = await createSession([{ role: "user", content: "prompt", timestamp: 1 }]);
		const before = requireContextUsage(session);
		const estimateCount = getContextUsageEstimateCount(session);
		const model = session.model;
		if (!model) throw new Error("Expected model");

		session.agent.setModel({ ...model, id: "cache-invalidation-model", contextWindow: 100_000 });
		const after = requireContextUsage(session);

		expectContextUsageRecomputed(session, estimateCount);
		expect(after.contextWindow).toBe(100_000);
		expect(after.percent).toBe((before.tokens! / 100_000) * 100);
	});

	it("invalidates on leaf-only branch switches", async () => {
		const message = { role: "user" as const, content: "prompt", timestamp: 1 };
		const { session, sessionManager } = await createSession([message]);
		const entryId = sessionManager.appendMessage(message);

		requireContextUsage(session);
		const afterWarmup = getContextUsageEstimateCount(session);
		sessionManager.resetLeaf();
		requireContextUsage(session);
		expectContextUsageRecomputed(session, afterWarmup);

		const afterResetLeaf = getContextUsageEstimateCount(session);
		sessionManager.branch(entryId);
		requireContextUsage(session);
		expectContextUsageRecomputed(session, afterResetLeaf);
	});

	it("returns independent snapshots without poisoning the cached value", async () => {
		const { session } = await createSession([{ role: "user", content: "prompt", timestamp: 1 }]);
		const first = requireContextUsage(session);
		const estimateCount = getContextUsageEstimateCount(session);
		first.tokens = -1;
		const second = requireContextUsage(session);

		expect(getContextUsageEstimateCount(session)).toBe(estimateCount);
		expect(second).not.toBe(first);
		expect(second.tokens).not.toBe(-1);
	});
});
