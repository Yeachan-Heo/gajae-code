/**
 * Maintenance one-shot calls (compaction summary, turn-prefix summary, handoff)
 * must size their reasoning effort against the model they are about to call.
 *
 * They used to hard-code `Effort.High`. A reasoning-capable model whose
 * transport is not an audited reasoning-control endpoint (the registry strips
 * `thinking` and `modelSupportsReasoningControl` reports false — a proxied
 * `openai-codex` baseUrl is the everyday case) then fails inside
 * `requireSupportedEffort` with "does not support thinking", and because the
 * compaction fallback chain picks the same-provider largest-context model,
 * every candidate dies on the same throw and auto-compaction reports the last
 * one. The agent turn itself survives because it clamps through the same
 * helper; only the maintenance calls skipped it.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import {
	type CompactionPreparation,
	compact,
	createFileOps,
	DEFAULT_COMPACTION_SETTINGS,
	generateHandoff,
	generateSummary,
} from "@gajae-code/agent-core/compaction";
import type { AgentMessage } from "@gajae-code/agent-core/types";
import type { AssistantMessage, Model, SimpleStreamOptions, Usage } from "@gajae-code/ai";
import * as ai from "@gajae-code/ai";
import { Effort } from "@gajae-code/ai";

afterEach(() => {
	vi.restoreAllMocks();
});

/** Reasoning-capable Codex model served through a non-audited proxy host. */
const PROXIED_CODEX: Model = {
	id: "gpt-5.4",
	name: "GPT-5.4",
	api: "openai-codex-responses",
	provider: "openai-codex",
	baseUrl: "http://10.0.0.1:8317/backend-api",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1_000_000,
	maxTokens: 128_000,
};

/** Same model on its audited first-party host, with thinking metadata intact. */
const FIRST_PARTY_CODEX: Model = {
	...PROXIED_CODEX,
	baseUrl: "https://chatgpt.com/backend-api",
	thinking: { mode: "effort", minLevel: Effort.Low, maxLevel: Effort.XHigh },
};

/** Model whose declared ceiling is below `high`. */
const CAPPED_MODEL: Model = {
	...FIRST_PARTY_CODEX,
	id: "capped",
	thinking: { mode: "effort", minLevel: Effort.Low, maxLevel: Effort.Medium },
};

function makeUsage(): Usage {
	return {
		input: 10,
		output: 10,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 20,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function makeAssistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "mock",
		provider: "mock",
		model: "mock-model",
		usage: makeUsage(),
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function makeUserMessage(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: Date.now() };
}

function makePreparation(overrides: Partial<CompactionPreparation> = {}): CompactionPreparation {
	return {
		firstKeptEntryId: "kept-1",
		messagesToSummarize: [makeUserMessage("Hello"), makeAssistantMessage("Hi back")],
		turnPrefixMessages: [],
		recentMessages: [makeUserMessage("Next question")],
		isSplitTurn: false,
		tokensBefore: 12345,
		fileOps: createFileOps(),
		settings: { ...DEFAULT_COMPACTION_SETTINGS, remoteEnabled: false },
		tokenCorrection: { ratio: 1, keepRecentTokensCorrected: DEFAULT_COMPACTION_SETTINGS.keepRecentTokens },
		...overrides,
	};
}

function spyCompleteSimple(): SimpleStreamOptions[] {
	const captured: SimpleStreamOptions[] = [];
	vi.spyOn(ai, "completeSimple").mockImplementation(async (_model, _ctx, options) => {
		captured.push(options as SimpleStreamOptions);
		return makeAssistantMessage("summary text");
	});
	return captured;
}

describe("maintenance calls clamp reasoning to the target model", () => {
	it("sends no reasoning to a reasoning model whose transport has no reasoning control", async () => {
		const captured = spyCompleteSimple();
		await generateSummary([makeUserMessage("Hi")], PROXIED_CODEX, 4096, "k");
		expect(captured).toHaveLength(1);
		expect(captured[0]?.reasoning).toBeUndefined();
	});

	it("keeps high effort on the audited first-party transport", async () => {
		const captured = spyCompleteSimple();
		await generateSummary([makeUserMessage("Hi")], FIRST_PARTY_CODEX, 4096, "k");
		expect(captured[0]?.reasoning).toBe(Effort.High);
	});

	it("clamps to the model's declared ceiling when it is below high", async () => {
		const captured = spyCompleteSimple();
		await generateSummary([makeUserMessage("Hi")], CAPPED_MODEL, 4096, "k");
		expect(captured[0]?.reasoning).toBe(Effort.Medium);
	});

	it("generateHandoff applies the same clamp", async () => {
		const captured = spyCompleteSimple();
		await generateHandoff([makeUserMessage("Hi")], PROXIED_CODEX, "k", { systemPrompt: ["sys"], tools: [] });
		expect(captured[0]?.reasoning).toBeUndefined();
	});

	it("split-turn compact() clamps both the history and turn-prefix summaries", async () => {
		const captured = spyCompleteSimple();
		await compact(
			makePreparation({
				isSplitTurn: true,
				turnPrefixMessages: [makeUserMessage("prefix"), makeAssistantMessage("prefix reply")],
			}),
			PROXIED_CODEX,
			"k",
		);
		expect(captured).toHaveLength(2);
		for (const options of captured) expect(options.reasoning).toBeUndefined();
	});

	it("the unclamped effort is exactly what the provider mapper rejects", () => {
		// Pin the failure mode this file guards: `requireSupportedEffort` is what the
		// OpenAI option mapper runs on `options.reasoning`, and it throws for this model.
		expect(() => ai.requireSupportedEffort(PROXIED_CODEX, Effort.High)).toThrow(
			"Model openai-codex/gpt-5.4 does not support thinking",
		);
		expect(ai.clampThinkingLevelForModel(PROXIED_CODEX, Effort.High)).toBeUndefined();
	});
});
