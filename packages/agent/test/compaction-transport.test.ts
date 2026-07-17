/**
 * Tests that maintenance one-shot LLM calls (compaction summary, short summary,
 * turn-prefix summary, handoff, branch summary) forward the live provider
 * session state and configured WebSocket transport preference, and that
 * split-turn compaction runs its two summaries sequentially when they share a
 * single provider session (so a Codex WebSocket session never gets two
 * concurrent requests).
 *
 * Regression coverage for #736.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import {
	type CompactionPreparation,
	compact,
	createFileOps,
	DEFAULT_COMPACTION_SETTINGS,
	generateBranchSummary,
	generateHandoff,
	generateSummary,
} from "@gajae-code/agent-core/compaction";
import type { AgentMessage } from "@gajae-code/agent-core/types";
import type { AssistantMessage, Model, ProviderSessionState, SimpleStreamOptions, Usage } from "@gajae-code/ai";
import * as ai from "@gajae-code/ai";

const MODEL: Model = {
	id: "mock-model",
	name: "mock-model",
	api: "mock",
	provider: "mock",
	baseUrl: "mock://",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 32_768,
};

const CODEX_MODEL: Model = {
	...MODEL,
	id: "codex-mock-model",
	name: "codex-mock-model",
	api: "openai-codex-responses",
	provider: "openai",
};

afterEach(() => {
	vi.restoreAllMocks();
});

function makeUsage(input = 120, output = 80, cacheRead = 0, cacheWrite = 0): Usage {
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: input + output + cacheRead + cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function makeAssistantMessage(text: string, usage: Usage = makeUsage()): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "mock",
		provider: "mock",
		model: "mock-model",
		usage,
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function makeUserMessage(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: Date.now() };
}

function makePreparation(overrides: Partial<CompactionPreparation> = {}): CompactionPreparation {
	const messagesToSummarize: AgentMessage[] = [makeUserMessage("Hello"), makeAssistantMessage("Hi back")];
	const recentMessages: AgentMessage[] = [makeUserMessage("Next question")];
	return {
		firstKeptEntryId: "kept-1",
		messagesToSummarize,
		turnPrefixMessages: [],
		recentMessages,
		isSplitTurn: false,
		tokensBefore: 12345,
		fileOps: createFileOps(),
		settings: { ...DEFAULT_COMPACTION_SETTINGS, remoteEnabled: false },
		tokenCorrection: { ratio: 1, keepRecentTokensCorrected: DEFAULT_COMPACTION_SETTINGS.keepRecentTokens },
		...overrides,
	};
}

/** Spy on completeSimple, recording every options object it receives. */
function spyCompleteSimple(): SimpleStreamOptions[] {
	const captured: SimpleStreamOptions[] = [];
	vi.spyOn(ai, "completeSimple").mockImplementation(async (_model, _ctx, options) => {
		captured.push(options as SimpleStreamOptions);
		return makeAssistantMessage("summary text");
	});
	return captured;
}

describe("maintenance call transport forwarding (#736)", () => {
	it("generateSummary forwards sessionId, providerSessionState, and preferWebsockets", async () => {
		const captured = spyCompleteSimple();
		const providerSessionState = new Map<string, ProviderSessionState>();

		await generateSummary([makeUserMessage("Hi")], MODEL, 4096, "k", undefined, undefined, undefined, {
			sessionId: "turn-session-1",
			providerSessionState,
			preferWebsockets: true,
		});

		expect(captured).toHaveLength(1);
		expect(captured[0]?.sessionId).toBe("turn-session-1");
		expect(captured[0]?.providerSessionState).toBe(providerSessionState);
		expect(captured[0]?.preferWebsockets).toBe(true);
	});

	it("generateHandoff forwards sessionId, providerSessionState, and preferWebsockets", async () => {
		const captured = spyCompleteSimple();
		const providerSessionState = new Map<string, ProviderSessionState>();

		await generateHandoff([makeUserMessage("Hi")], MODEL, "k", {
			systemPrompt: ["Live system prompt"],
			tools: [],
			sessionId: "turn-session-2",
			providerSessionState,
			preferWebsockets: true,
		});

		expect(captured).toHaveLength(1);
		expect(captured[0]?.sessionId).toBe("turn-session-2");
		expect(captured[0]?.providerSessionState).toBe(providerSessionState);
		expect(captured[0]?.preferWebsockets).toBe(true);
	});

	it("generateBranchSummary forwards sessionId, providerSessionState, and preferWebsockets", async () => {
		const captured = spyCompleteSimple();
		const providerSessionState = new Map<string, ProviderSessionState>();
		const entries = [
			{
				type: "message" as const,
				id: "e1",
				parentId: null,
				timestamp: new Date().toISOString(),
				message: makeUserMessage("first"),
			},
			{
				type: "message" as const,
				id: "e2",
				parentId: "e1",
				timestamp: new Date().toISOString(),
				message: makeAssistantMessage("response"),
			},
		];

		await generateBranchSummary(entries, {
			model: MODEL,
			apiKey: "k",
			signal: new AbortController().signal,
			sessionId: "turn-session-3",
			providerSessionState,
			preferWebsockets: true,
		});

		expect(captured).toHaveLength(1);
		expect(captured[0]?.sessionId).toBe("turn-session-3");
		expect(captured[0]?.providerSessionState).toBe(providerSessionState);
		expect(captured[0]?.preferWebsockets).toBe(true);
	});

	it("compact() forwards transport fields to the history summary (short summary is derived locally, #2335)", async () => {
		const captured = spyCompleteSimple();
		const providerSessionState = new Map<string, ProviderSessionState>();

		await compact(makePreparation(), MODEL, "k", undefined, undefined, {
			sessionId: "turn-session-4",
			providerSessionState,
			preferWebsockets: true,
		});

		// history summary only: shortSummary is derived from the main summary
		// without a dedicated LLM roundtrip (#2335).
		expect(captured).toHaveLength(1);
		for (const options of captured) {
			expect(options.sessionId).toBe("turn-session-4");
			expect(options.providerSessionState).toBe(providerSessionState);
			expect(options.preferWebsockets).toBe(true);
		}
	});
});

describe("split-turn compaction sequencing (#736)", () => {
	/** Mock completeSimple with a slow body that records peak concurrency. */
	function spyTrackingConcurrency(): { peak: () => number } {
		let active = 0;
		let maxActive = 0;
		vi.spyOn(ai, "completeSimple").mockImplementation(async () => {
			active++;
			maxActive = Math.max(maxActive, active);
			await new Promise(resolve => setTimeout(resolve, 10));
			active--;
			return makeAssistantMessage("ok");
		});
		return { peak: () => maxActive };
	}

	const splitPreparation = () =>
		makePreparation({
			isSplitTurn: true,
			turnPrefixMessages: [makeUserMessage("Inline mid-turn instruction")],
		});

	it("runs the two summaries sequentially when they share a provider WebSocket session", async () => {
		const tracker = spyTrackingConcurrency();
		const providerSessionState = new Map<string, ProviderSessionState>();

		await compact(splitPreparation(), CODEX_MODEL, "k", undefined, undefined, {
			sessionId: "turn-session-seq",
			providerSessionState,
			preferWebsockets: true,
		});

		expect(tracker.peak()).toBe(1);
	});

	it("runs the two summaries sequentially when shared provider state may select WebSocket by env or model default", async () => {
		const tracker = spyTrackingConcurrency();
		const providerSessionState = new Map<string, ProviderSessionState>();

		await compact(splitPreparation(), CODEX_MODEL, "k", undefined, undefined, {
			sessionId: "turn-session-env",
			providerSessionState,
		});

		expect(tracker.peak()).toBe(1);
	});

	it("runs the two summaries in parallel when WebSocket transport is explicitly disabled", async () => {
		const tracker = spyTrackingConcurrency();
		const providerSessionState = new Map<string, ProviderSessionState>();

		await compact(splitPreparation(), CODEX_MODEL, "k", undefined, undefined, {
			sessionId: "turn-session-http",
			providerSessionState,
			preferWebsockets: false,
		});

		expect(tracker.peak()).toBe(2);
	});

	it("runs the two summaries in parallel for non-Codex providers even when transport fields are present", async () => {
		const tracker = spyTrackingConcurrency();
		const providerSessionState = new Map<string, ProviderSessionState>();

		await compact(splitPreparation(), MODEL, "k", undefined, undefined, {
			sessionId: "turn-session-non-codex",
			providerSessionState,
			preferWebsockets: true,
		});

		expect(tracker.peak()).toBe(2);
	});

	it("runs the two summaries in parallel when no shared WebSocket session is configured", async () => {
		const tracker = spyTrackingConcurrency();

		await compact(splitPreparation(), MODEL, "k", undefined, undefined, {});

		expect(tracker.peak()).toBe(2);
	});
});
