import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { Agent, type AgentMessage } from "@gajae-code/agent-core";
import { calculateContextTokens, estimateMessageTokensHeuristic } from "@gajae-code/agent-core/compaction";
import { type AssistantMessage, getBundledModel, type Model, type Usage } from "@gajae-code/ai";
import { AssistantMessageEventStream } from "@gajae-code/ai/utils/event-stream";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@gajae-code/coding-agent/config/settings";
import type { ExtensionRunner } from "@gajae-code/coding-agent/extensibility/extensions/runner";
import type { ContextUsage } from "@gajae-code/coding-agent/extensibility/extensions/types";
import { initTheme, theme } from "@gajae-code/coding-agent/modes/theme/theme";
import {
	computeContextBreakdown,
	computeNonMessageTokens,
	renderContextUsage,
} from "@gajae-code/coding-agent/modes/utils/context-usage";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { convertToLlm } from "@gajae-code/coding-agent/session/messages";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { StatusLineComponent } from "../src/modes/components/tool-status-header";

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

async function createSession(
	messages: AgentMessage[] = [],
	extensionRunner?: ExtensionRunner,
): Promise<{
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
		extensionRunner,
		modelRegistry: new ModelRegistry(authStorage),
	});
	sessions.push(session);
	return { session, sessionManager };
}

function requireContextUsage(session: AgentSession): ContextUsage {
	const usage = session.getContextUsage();
	if (!usage) throw new Error("Expected context usage");
	return usage;
}

function createDisplaySession(
	contextUsage: ContextUsage | undefined,
	model: Model | null | undefined = testModel,
): AgentSession {
	const resolvedModel = model ?? undefined;
	const messages: AgentMessage[] = [{ role: "user", content: "small prompt", timestamp: 1 }];
	return {
		state: { model: resolvedModel, messages },
		model: resolvedModel,
		messages,
		systemPrompt: ["short system prompt"],
		agent: { state: { tools: [] } },
		skills: [],
		settings: Settings.instance,
		modelRegistry: { isUsingOAuth: () => false },
		sessionManager: {
			getUsageStatistics: () => ({
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				premiumRequests: 0,
				cost: 0,
			}),
			getSessionName: () => "red-team",
		},
		isStreaming: false,
		isFastModeActive: () => false,
		getAsyncJobSnapshot: () => ({ running: [] }),
		getGoalModeState: () => undefined,
		getContextUsage: () => contextUsage,
	} as unknown as AgentSession;
}

function configureForModel(component: StatusLineComponent): void {
	component.updateSettings({
		preset: "custom",
		leftSegments: ["model"],
		rightSegments: [],
		showSkillHud: false,
		showHookStatus: false,
		sessionAccent: false,
	});
}

const testModel: Model = {
	id: "red-team-model",
	name: "Red Team Model",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://example.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow,
	maxTokens: 8_192,
};

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme();
});

afterEach(async () => {
	for (const session of sessions.splice(0)) {
		await session.dispose();
	}
	for (const authStorage of authStorages.splice(0)) {
		authStorage.close();
	}
	vi.restoreAllMocks();
});

afterAll(() => {
	resetSettingsForTest();
});

describe("context usage SSOT red-team probes", () => {
	it("rejects a timestamp-less stale assistant at a compaction boundary", async () => {
		const { session, sessionManager } = await createSession();
		const staleAssistant = createAssistant({ usage: createUsage(150_000), text: "pre-compaction response" });
		delete (staleAssistant as { timestamp?: number }).timestamp;

		const staleAssistantId = sessionManager.appendMessage(staleAssistant);
		session.agent.appendMessage(staleAssistant);
		sessionManager.appendCompaction("summary", "summary", staleAssistantId, 150_000);
		// This represents delayed persistence of the old message after the compaction entry.
		sessionManager.appendMessage(staleAssistant);

		expect(requireContextUsage(session)).toEqual({
			tokens: null,
			contextWindow,
			percent: null,
			source: "unknown",
		});
	});

	it("uses an earlier positive post-compaction anchor after a zero-usage success", async () => {
		const { session, sessionManager } = await createSession();
		const keptUser = { role: "user" as const, content: "kept", timestamp: Date.now() - 10_000 };
		const keptUserId = sessionManager.appendMessage(keptUser);
		session.agent.appendMessage(keptUser);
		sessionManager.appendCompaction("summary", "summary", keptUserId, 1_000);

		const positive = createAssistant({ usage: createUsage(150_000), timestamp: Date.now() + 1 });
		const zero = createAssistant({ usage: createUsage(0), timestamp: Date.now() + 2 });
		sessionManager.appendMessage(positive);
		session.agent.appendMessage(positive);
		sessionManager.appendMessage(zero);
		session.agent.appendMessage(zero);

		const usage = requireContextUsage(session);
		expect(usage.tokens).toBe(calculateContextTokens(positive.usage) + estimateDisplayMessages([zero]));
		expect(usage.source).toBe("provider_anchor");
	});

	it("renders provider usage above the context window without negative free/reserve tokens", () => {
		const usage: ContextUsage = {
			tokens: 300_000,
			contextWindow,
			percent: 150,
			source: "provider_anchor",
		};
		const session = createDisplaySession(usage);
		const component = new StatusLineComponent(session);
		configureForModel(component);

		const breakdown = computeContextBreakdown(session);
		const rendered = Bun.stripANSI(component.render(160).join("\n"));
		expect(breakdown.source).toBe("provider_anchor");
		expect(breakdown.usedTokens).toBe(300_000);
		expect(breakdown.autoCompactBufferTokens).toBeGreaterThanOrEqual(0);
		expect(breakdown.freeTokens).toBe(0);
		expect(rendered).toContain("150.0%");
		expect(() => renderContextUsage(breakdown, theme)).not.toThrow();
		component.dispose();
	});

	it("renders unknown context usage without a model", () => {
		const session = createDisplaySession(undefined, null);
		const component = new StatusLineComponent(session);
		configureForModel(component);

		expect(session.getContextUsage()).toBeUndefined();
		const rendered = Bun.stripANSI(component.render(160).join("\n"));
		expect(rendered).toContain("no-model");
		component.updateSettings({
			preset: "custom",
			leftSegments: ["context_pct"],
			rightSegments: [],
			showSkillHud: false,
			showHookStatus: false,
			sessionAccent: false,
		});
		expect(Bun.stripANSI(component.render(160).join("\n"))).toContain("?/0");
		component.dispose();
	});

	it("keeps reserve and free arithmetic non-negative for heuristic and provider-anchor breakdowns", () => {
		const heuristic = computeContextBreakdown(
			createDisplaySession({ tokens: 1, contextWindow, percent: 0.0005, source: "heuristic" }),
		);
		const providerAnchor = computeContextBreakdown(
			createDisplaySession({ tokens: 300_000, contextWindow, percent: 150, source: "provider_anchor" }),
		);

		for (const breakdown of [heuristic, providerAnchor]) {
			expect(breakdown.autoCompactBufferTokens).toBeGreaterThanOrEqual(0);
			expect(breakdown.freeTokens).toBeGreaterThanOrEqual(0);
		}
		expect(heuristic.source).toBe("heuristic");
		expect(providerAnchor.source).toBe("provider_anchor");
	});

	it("retains only heuristic deltas after a provider anchor", async () => {
		const { session, sessionManager } = await createSession();
		const anchor = createAssistant({ usage: createUsage(150_000) });
		const trailing = { role: "user" as const, content: "unsent", timestamp: Date.now() + 1 };
		sessionManager.appendMessage(anchor);
		sessionManager.appendMessage(trailing);
		session.agent.replaceMessages([anchor, trailing]);

		const usage = requireContextUsage(session);
		expect(usage.tokens).toBe(calculateContextTokens(anchor.usage) + estimateDisplayMessages([trailing]));
		expect(usage.source).toBe("provider_anchor");
	});
	it("anchors a timestamp-less positive-usage assistant when no compaction boundary exists", async () => {
		const { session, sessionManager } = await createSession();
		const legacyAssistant = createAssistant({ usage: createUsage(150_000), text: "legacy response" });
		delete (legacyAssistant as { timestamp?: number }).timestamp;

		sessionManager.appendMessage(legacyAssistant);
		session.agent.appendMessage(legacyAssistant);

		expect(requireContextUsage(session)).toEqual({
			tokens: calculateContextTokens(legacyAssistant.usage),
			contextWindow,
			percent: (calculateContextTokens(legacyAssistant.usage) / contextWindow) * 100,
			source: "provider_anchor",
		});
	});

	it("retains a positive post-compaction anchor past zero-usage, aborted, and error turns", async () => {
		const { session, sessionManager } = await createSession();
		const keptUser = { role: "user" as const, content: "kept", timestamp: Date.now() - 10_000 };
		const keptUserId = sessionManager.appendMessage(keptUser);
		sessionManager.appendCompaction("summary", "summary", keptUserId, 1_000);
		const compaction = sessionManager.getBranch().findLast(entry => entry.type === "compaction");
		if (compaction?.type !== "compaction") throw new Error("Expected compaction boundary");
		const boundaryTs = new Date(compaction.timestamp).getTime();
		const positive = createAssistant({ usage: createUsage(150_000), timestamp: boundaryTs + 1 });
		const zeroUsage = createAssistant({ usage: createUsage(0), timestamp: boundaryTs + 2 });
		const aborted = createAssistant({
			usage: createUsage(80_000),
			stopReason: "aborted",
			timestamp: boundaryTs + 3,
		});
		const errored = createAssistant({ usage: createUsage(70_000), stopReason: "error", timestamp: boundaryTs + 4 });
		for (const message of [positive, zeroUsage, aborted, errored]) {
			sessionManager.appendMessage(message);
		}
		session.agent.replaceMessages([positive, zeroUsage, aborted, errored]);

		const usage = requireContextUsage(session);
		expect(usage.tokens).toBe(
			calculateContextTokens(positive.usage) + estimateDisplayMessages([zeroUsage, aborted, errored]),
		);
		expect(usage.source).toBe("provider_anchor");
	});

	it("rejects the anchor between two compactions and accepts the one after the latest boundary", async () => {
		const { session, sessionManager } = await createSession();
		const firstKeptUser = { role: "user" as const, content: "first kept", timestamp: Date.now() - 10_000 };
		const firstKeptEntryId = sessionManager.appendMessage(firstKeptUser);
		sessionManager.appendCompaction("first", "first", firstKeptEntryId, 1_000);
		const firstCompaction = sessionManager.getBranch().findLast(entry => entry.type === "compaction");
		if (firstCompaction?.type !== "compaction") throw new Error("Expected first compaction boundary");
		const firstBoundaryTs = new Date(firstCompaction.timestamp).getTime();
		const betweenCompactions = createAssistant({ usage: createUsage(140_000), timestamp: firstBoundaryTs + 1 });
		sessionManager.appendMessage(betweenCompactions);

		await Bun.sleep(5);
		const secondKeptUser = { role: "user" as const, content: "second kept", timestamp: Date.now() };
		const secondKeptEntryId = sessionManager.appendMessage(secondKeptUser);
		sessionManager.appendCompaction("second", "second", secondKeptEntryId, 1_000);
		const latestCompaction = sessionManager.getBranch().findLast(entry => entry.type === "compaction");
		if (latestCompaction?.type !== "compaction") throw new Error("Expected latest compaction boundary");
		const latestBoundaryTs = new Date(latestCompaction.timestamp).getTime();
		expect(latestBoundaryTs).toBeGreaterThan(firstBoundaryTs);
		const afterLatestCompaction = createAssistant({ usage: createUsage(150_000), timestamp: latestBoundaryTs + 1 });
		sessionManager.appendMessage(afterLatestCompaction);
		session.agent.replaceMessages([betweenCompactions, afterLatestCompaction]);

		const usage = requireContextUsage(session);
		expect(usage.tokens).toBe(calculateContextTokens(afterLatestCompaction.usage));
		expect(usage.source).toBe("provider_anchor");
	});

	it("keeps unknown usage nullable while deriving non-negative free space from the estimate", () => {
		const session = createDisplaySession({
			tokens: null,
			contextWindow,
			percent: null,
			source: "unknown",
		});
		const breakdown = computeContextBreakdown(session);
		const report = Bun.stripANSI(renderContextUsage(breakdown, theme));

		expect(breakdown.usedTokens).toBeNull();
		expect(breakdown.freeTokens).toBeGreaterThanOrEqual(0);
		expect(breakdown.freeTokens).toBe(
			Math.max(0, contextWindow - breakdown.estimatedCategoryTotal - breakdown.autoCompactBufferTokens),
		);
		expect(report).toContain("unknown");
	});

	it("copies an anchor-less heuristic snapshot into the context breakdown", async () => {
		const user = { role: "user" as const, content: "heuristic-only context", timestamp: Date.now() };
		const { session } = await createSession([user]);

		const usage = requireContextUsage(session);
		const breakdown = computeContextBreakdown(session);
		expect(usage.source).toBe("heuristic");
		expect(usage.tokens).toBeGreaterThan(estimateDisplayMessages([user]));
		expect(breakdown.usedTokens).toBe(usage.tokens);
	});

	it("uses the provider anchor for display and conservatively inflates only anchor-less pre-prompt estimates", async () => {
		const anchor = createAssistant({ usage: createUsage(150_000) });
		const { session: anchoredSession } = await createSession([anchor]);
		const anchoredUsage = requireContextUsage(anchoredSession);
		expect(anchoredUsage).toMatchObject({
			tokens: calculateContextTokens(anchor.usage),
			source: "provider_anchor",
		});

		const messages: AgentMessage[] = [
			{ role: "user", content: "unanchored content ".repeat(500), timestamp: Date.now() },
		];
		const { session } = await createSession(messages);
		const displayUsage = requireContextUsage(session);
		if (displayUsage.tokens === null) throw new Error("Expected heuristic context tokens");

		const fixedTokens = computeNonMessageTokens(session);
		const pendingMessage: AgentMessage = { role: "user", content: "pending", timestamp: Date.now() };
		const displayWithPending = displayUsage.tokens + estimateDisplayMessages([pendingMessage]);
		const compactionWithPending =
			Math.ceil(fixedTokens * 1.2) +
			messages.reduce((sum, message) => sum + Math.ceil(estimateDisplayMessages([message]) * 1.2), 0) +
			Math.ceil(estimateDisplayMessages([pendingMessage]) * 1.2);
		expect(compactionWithPending).toBeGreaterThanOrEqual(displayWithPending);
		expect(compactionWithPending).toBeGreaterThan(displayWithPending);

		const threshold = Math.floor((displayWithPending + compactionWithPending) / 2);
		session.settings.override("compaction.enabled", true);
		session.settings.override("compaction.strategy", "context-full");
		session.settings.override("compaction.thresholdTokens", threshold);
		let autoCompactionStarts = 0;
		session.subscribe(event => {
			if (event.type === "auto_compaction_start") autoCompactionStarts++;
		});
		session.agent.streamFn = () => {
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				const response = createAssistant({ usage: createUsage(1), text: "done" });
				stream.push({ type: "start", partial: response });
				stream.push({ type: "done", reason: "stop", message: response });
			});
			return stream;
		};

		await session.prompt("pending", { expandPromptTemplates: false });
		expect(autoCompactionStarts).toBe(1);
	});

	it("invalidates an in-place non-last message mutation after touchContext", async () => {
		const earlier = { role: "user" as const, content: "short earlier message", timestamp: 1 };
		const last = { role: "user" as const, content: "unchanged tail", timestamp: 2 };
		const { session, sessionManager } = await createSession([earlier, last]);
		const before = requireContextUsage(session);
		const revision = sessionManager.revisionSnapshot();

		// Direct mutations bypass Agent-owned mutators, so callers must explicitly
		// notify context consumers after changing committed context in place.
		const liveEarlier = session.messages[0] as { content: string };
		liveEarlier.content += " expanded earlier content".repeat(400);
		session.agent.touchContext();
		const after = requireContextUsage(session);
		const { session: independentlyRecomputed } = await createSession([
			{ ...earlier, content: liveEarlier.content },
			{ ...last },
		]);
		const expectedAfterMutation = requireContextUsage(independentlyRecomputed);

		expect(session.messages.at(-1)).toBe(last);
		expect(sessionManager.revisionSnapshot()).toEqual(revision);
		expect(after).toEqual(expectedAfterMutation);
		expect(after.tokens).toBeGreaterThan(before.tokens ?? 0);
	});

	it("invalidates the last-assistant snapshot when usage attaches or stop reason changes", async () => {
		const assistant = createAssistant({ usage: createUsage(150_000), text: "partial response" });
		delete (assistant as Partial<AssistantMessage>).usage;
		const { session } = await createSession([assistant]);
		const before = requireContextUsage(session);
		expect(before.source).toBe("heuristic");

		const liveAssistant = session.messages[0] as AssistantMessage;
		liveAssistant.usage = createUsage(150_000);
		const attached = requireContextUsage(session);
		expect(attached).toMatchObject({
			tokens: calculateContextTokens(liveAssistant.usage),
			source: "provider_anchor",
		});

		liveAssistant.stopReason = "aborted";
		const aborted = requireContextUsage(session);
		expect(aborted).not.toBe(attached);
		expect(aborted.tokens).toBe(estimateDisplayMessages([liveAssistant]) + computeNonMessageTokens(session));
		expect(aborted.source).toBe("heuristic");
	});

	it("invalidates after same-length replacement with an unchanged-shape last message", async () => {
		const earlier = { role: "user" as const, content: "short earlier message", timestamp: 1 };
		const last = { role: "user" as const, content: "unchanged tail", timestamp: 2 };
		const { session, sessionManager } = await createSession([earlier, last]);
		const before = requireContextUsage(session);
		const revision = sessionManager.revisionSnapshot();

		session.agent.replaceMessages([{ ...earlier, content: "replacement earlier content".repeat(400) }, { ...last }]);
		const after = requireContextUsage(session);

		expect(session.messages).toHaveLength(2);
		expect(session.messages.at(-1)).not.toBe(last);
		expect(sessionManager.revisionSnapshot()).toEqual(revision);
		expect(after).not.toBe(before);
		expect(after.tokens).toBeGreaterThan(before.tokens ?? 0);
	});

	it("invalidates after real compaction and returns unknown until a new assistant responds", async () => {
		const extensionRunner = {
			hasHandlers: (eventType: string) => eventType === "session_before_compact",
			emit: async (event: { type: string; preparation?: { firstKeptEntryId: string; tokensBefore: number } }) => {
				if (event.type !== "session_before_compact" || !event.preparation) return undefined;
				return {
					compaction: {
						summary: "compacted summary",
						shortSummary: "compacted",
						firstKeptEntryId: event.preparation.firstKeptEntryId,
						tokensBefore: event.preparation.tokensBefore,
						details: {},
					},
				};
			},
		} as unknown as ExtensionRunner;
		const earlier = { role: "user" as const, content: "history to compact ".repeat(100), timestamp: 1 };
		const last = { role: "user" as const, content: "latest user message", timestamp: 2 };
		const { session, sessionManager } = await createSession([earlier, last], extensionRunner);
		sessionManager.appendMessage(earlier);
		sessionManager.appendMessage(last);
		session.settings.override("compaction.keepRecentTokens", 1);
		requireContextUsage(session);
		const revision = sessionManager.revisionSnapshot();

		await session.compact();

		expect(sessionManager.revisionSnapshot().entry).toBeGreaterThan(revision.entry);
		expect(requireContextUsage(session)).toEqual({
			tokens: null,
			contextWindow,
			percent: null,
			source: "unknown",
		});
	});

	it("invalidates when the model id changes without changing its context window", async () => {
		const { session } = await createSession([{ role: "user", content: "prompt", timestamp: 1 }]);
		const before = requireContextUsage(session);
		const model = session.model;
		if (!model) throw new Error("Expected model");

		session.agent.setModel({ ...model, id: "same-window-cache-invalidation-model", contextWindow });
		const after = requireContextUsage(session);

		expect(after).not.toBe(before);
		expect(after.contextWindow).toBe(contextWindow);
		expect(after.tokens).toBe(before.tokens);
	});

	it("invalidates a same-length system-prompt swap via setSystemPrompt", async () => {
		const sparsePrompt = "a".repeat(1_000);
		const densePrompt = "中".repeat(1_000);
		const { session } = await createSession();
		session.agent.setSystemPrompt([sparsePrompt]);
		const sparseTokens = computeNonMessageTokens(session);
		const before = requireContextUsage(session);

		session.agent.setSystemPrompt([densePrompt]);
		const denseTokens = computeNonMessageTokens(session);
		const after = requireContextUsage(session);

		expect(densePrompt).toHaveLength(sparsePrompt.length);
		expect(denseTokens).toBeGreaterThan(sparseTokens);
		expect(after.tokens).toBe(denseTokens);
		expect(after.tokens).toBeGreaterThan(before.tokens ?? 0);
	});

	it("refreshes every streamed last-assistant text growth", async () => {
		const assistant = createAssistant({ usage: createUsage(1), stopReason: "aborted", text: "stream" });
		const { session } = await createSession([assistant]);
		const liveAssistant = session.messages[0] as AssistantMessage;
		const textBlock = liveAssistant.content[0];
		if (textBlock?.type !== "text") throw new Error("Expected text block");

		let previous = requireContextUsage(session);
		for (let step = 0; step < 3; step++) {
			textBlock.text += " streamed growth".repeat(100);
			const current = requireContextUsage(session);
			expect(current).not.toBe(previous);
			expect(current.tokens).toBeGreaterThan(previous.tokens ?? 0);
			previous = current;
		}
	});
});
