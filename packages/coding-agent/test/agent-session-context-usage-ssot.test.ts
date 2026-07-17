import { afterEach, describe, expect, it, vi } from "bun:test";
import { Agent, type AgentMessage } from "@gajae-code/agent-core";
import { calculateContextTokens, estimateMessageTokensHeuristic } from "@gajae-code/agent-core/compaction";
import { type AssistantMessage, getBundledModel, type Usage } from "@gajae-code/ai";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { computeNonMessageTokens } from "@gajae-code/coding-agent/modes/utils/context-usage";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { convertToLlm } from "@gajae-code/coding-agent/session/messages";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";

const contextWindow = 200_000;
const sessions: AgentSession[] = [];
const authStorages: AuthStorage[] = [];

function createUsage(totalTokens: number): Usage {
	return {
		input: totalTokens,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function createAssistant(options: {
	usage: Usage;
	stopReason?: AssistantMessage["stopReason"];
	timestamp?: number;
	text?: string;
}): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: options.text ?? "ok" }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		stopReason: options.stopReason ?? "stop",
		usage: options.usage,
		timestamp: options.timestamp ?? Date.now(),
	};
}

function estimateDisplayMessages(messages: readonly AgentMessage[]): number {
	let tokens = 0;
	for (const message of messages) {
		for (const llmMessage of convertToLlm([message])) {
			tokens += estimateMessageTokensHeuristic(llmMessage);
		}
	}
	return tokens;
}

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

function appendCompactionBoundary(sessionManager: SessionManager, firstKeptEntryId: string): number {
	sessionManager.appendCompaction("summary", "summary", firstKeptEntryId, 1_000);
	const compaction = sessionManager.getBranch().findLast(entry => entry.type === "compaction");
	if (compaction?.type !== "compaction") throw new Error("Expected compaction entry");
	return new Date(compaction.timestamp).getTime();
}

afterEach(async () => {
	for (const session of sessions.splice(0)) {
		await session.dispose();
	}
	for (const authStorage of authStorages.splice(0)) {
		authStorage.close();
	}
	vi.restoreAllMocks();
});

describe("AgentSession context usage source of truth", () => {
	it("anchors on the provider-reported total and estimates only trailing messages", async () => {
		const { session, sessionManager } = await createSession();
		const anchor = createAssistant({ usage: createUsage(150_000), text: "tiny provider-backed response" });
		const trailing = { role: "user" as const, content: "tiny unsent follow-up", timestamp: Date.now() + 1 };
		sessionManager.appendMessage(anchor);
		sessionManager.appendMessage(trailing);
		session.agent.replaceMessages([anchor, trailing]);

		const usage = requireContextUsage(session);
		const expectedTokens = calculateContextTokens(anchor.usage) + estimateDisplayMessages([trailing]);

		expect(usage.tokens).toBe(expectedTokens);
		expect(usage.tokens).toBeGreaterThan(100_000);
		expect(usage.percent).toBe((expectedTokens / contextWindow) * 100);
		expect(usage.source).toBe("provider_anchor");
	});

	it("uses a full heuristic, including fixed context, when assistants only abort or error", async () => {
		const aborted = createAssistant({ usage: createUsage(90_000), stopReason: "aborted", text: "partial output" });
		const errored = createAssistant({ usage: createUsage(80_000), stopReason: "error", text: "failed output" });
		const { session } = await createSession([aborted, errored]);

		const usage = requireContextUsage(session);
		const messageTokens = estimateDisplayMessages([aborted, errored]);
		const fixedTokens = computeNonMessageTokens(session);

		expect(fixedTokens).toBeGreaterThan(0);
		expect(usage.tokens).toBe(messageTokens + fixedTokens);
		expect(usage.tokens).toBeGreaterThan(messageTokens);
		expect(usage.source).toBe("heuristic");
	});

	it("uses the fixed-context heuristic at session start", async () => {
		const { session } = await createSession();

		const usage = requireContextUsage(session);
		const fixedTokens = computeNonMessageTokens(session);

		expect(fixedTokens).toBeGreaterThan(0);
		expect(usage.tokens).toBeGreaterThanOrEqual(fixedTokens);
		expect(usage.source).toBe("heuristic");
	});

	it("reports unknown usage after compaction until an assistant responds", async () => {
		const { session, sessionManager } = await createSession();
		const keptUser = { role: "user" as const, content: "keep this", timestamp: Date.now() - 1_000 };
		const keptUserId = sessionManager.appendMessage(keptUser);
		session.agent.appendMessage(keptUser);
		sessionManager.appendCompaction("summary", "summary", keptUserId, 1_000);

		expect(requireContextUsage(session)).toEqual({
			tokens: null,
			contextWindow,
			percent: null,
			source: "unknown",
		});
	});

	it("reports unknown when all provider usage predates the latest compaction boundary", async () => {
		const { session, sessionManager } = await createSession();
		const staleAssistant = createAssistant({
			usage: createUsage(150_000),
			timestamp: Date.now() - 60_000,
			text: "small retained response",
		});
		const staleAssistantId = sessionManager.appendMessage(staleAssistant);
		session.agent.appendMessage(staleAssistant);
		sessionManager.appendCompaction("summary", "summary", staleAssistantId, 150_000);
		// Persisted message-entry order can lag its message timestamp. Boundary-aware
		// anchoring must still reject the stale response and preserve unknown usage.
		sessionManager.appendMessage(staleAssistant);

		expect(requireContextUsage(session)).toEqual({
			tokens: null,
			contextWindow,
			percent: null,
			source: "unknown",
		});
	});

	it("anchors past a later zero-usage success after compaction", async () => {
		const { session, sessionManager } = await createSession();
		const keptUser = { role: "user" as const, content: "keep this", timestamp: Date.now() - 1_000 };
		const keptUserId = sessionManager.appendMessage(keptUser);
		const boundaryTs = appendCompactionBoundary(sessionManager, keptUserId);
		const anchor = createAssistant({ usage: createUsage(150_000), timestamp: boundaryTs + 1 });
		const zeroUsage = createAssistant({ usage: createUsage(0), timestamp: boundaryTs + 2 });
		sessionManager.appendMessage(anchor);
		sessionManager.appendMessage(zeroUsage);
		session.agent.replaceMessages([anchor, zeroUsage]);

		const usage = requireContextUsage(session);
		expect(usage.tokens).toBe(calculateContextTokens(anchor.usage) + estimateDisplayMessages([zeroUsage]));
		expect(usage.source).toBe("provider_anchor");
	});

	it("uses an earlier post-compaction anchor after aborted and error turns", async () => {
		const { session, sessionManager } = await createSession();
		const keptUser = { role: "user" as const, content: "keep this", timestamp: Date.now() - 1_000 };
		const keptUserId = sessionManager.appendMessage(keptUser);
		const boundaryTs = appendCompactionBoundary(sessionManager, keptUserId);
		const anchor = createAssistant({ usage: createUsage(150_000), timestamp: boundaryTs + 1 });
		const aborted = createAssistant({ usage: createUsage(80_000), stopReason: "aborted", timestamp: boundaryTs + 2 });
		const errored = createAssistant({ usage: createUsage(70_000), stopReason: "error", timestamp: boundaryTs + 3 });
		sessionManager.appendMessage(anchor);
		sessionManager.appendMessage(aborted);
		sessionManager.appendMessage(errored);
		session.agent.replaceMessages([anchor, aborted, errored]);

		const usage = requireContextUsage(session);
		expect(usage.tokens).toBe(calculateContextTokens(anchor.usage) + estimateDisplayMessages([aborted, errored]));
		expect(usage.source).toBe("provider_anchor");
	});

	it("rejects an assistant whose timestamp equals the compaction boundary", async () => {
		const { session, sessionManager } = await createSession();
		const keptUser = { role: "user" as const, content: "keep this", timestamp: Date.now() - 1_000 };
		const keptUserId = sessionManager.appendMessage(keptUser);
		const boundaryTs = appendCompactionBoundary(sessionManager, keptUserId);
		const boundaryAssistant = createAssistant({ usage: createUsage(150_000), timestamp: boundaryTs });
		sessionManager.appendMessage(boundaryAssistant);
		session.agent.replaceMessages([boundaryAssistant]);

		expect(requireContextUsage(session)).toEqual({
			tokens: null,
			contextWindow,
			percent: null,
			source: "unknown",
		});
	});

	it("skips a NaN timestamp anchor without hiding an earlier valid post-compaction anchor", async () => {
		const { session, sessionManager } = await createSession();
		const keptUser = { role: "user" as const, content: "keep this", timestamp: Date.now() - 1_000 };
		const keptUserId = sessionManager.appendMessage(keptUser);
		const boundaryTs = appendCompactionBoundary(sessionManager, keptUserId);
		const anchor = createAssistant({ usage: createUsage(150_000), timestamp: boundaryTs + 1 });
		const nanTimestampAssistant = createAssistant({ usage: createUsage(125_000), timestamp: Number.NaN });
		sessionManager.appendMessage(anchor);
		sessionManager.appendMessage(nanTimestampAssistant);
		session.agent.replaceMessages([anchor, nanTimestampAssistant]);

		const usage = requireContextUsage(session);
		expect(usage.tokens).toBe(
			calculateContextTokens(anchor.usage) + estimateDisplayMessages([nanTimestampAssistant]),
		);
		expect(usage.source).toBe("provider_anchor");
	});
});
