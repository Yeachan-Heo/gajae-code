/**
 * Regression: the compaction summary request must not itself overflow the model
 * context window.
 *
 * When a near-full context is compacted, `generateSummary` serializes (nearly) the
 * entire history into a single summary request. On strict backends (e.g.
 * OpenAI-code/Codex `context_length_exceeded`) that request itself overflowed and
 * threw, so context-overflow recovery could not produce a summary and a
 * non-interactive `gjc -p` run terminated on the very overflow it was meant to
 * absorb. `boundConversationTextForSummary` caps the serialized input so the
 * summary request fits.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage, Context, Model, Usage } from "@gajae-code/ai";
import * as ai from "@gajae-code/ai";
import { boundConversationTextForSummary, generateSummary } from "../src/compaction/compaction";
import type { AgentMessage } from "../src/types";

const MODEL: Model = {
	id: "mock-model",
	name: "mock-model",
	api: "mock",
	provider: "mock",
	baseUrl: "mock://",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 20_000,
	maxTokens: 4_096,
};

const HEURISTIC_BYTES_PER_TOKEN = 4;

afterEach(() => {
	vi.restoreAllMocks();
});

function makeUsage(): Usage {
	return {
		input: 10,
		output: 5,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 15,
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

/** Spy on completeSimple, capturing the request Context (messages) it receives. */
function spyCompleteSimple(): Context[] {
	const captured: Context[] = [];
	vi.spyOn(ai, "completeSimple").mockImplementation(async (_model, ctx) => {
		captured.push(ctx as Context);
		return makeAssistantMessage("summary text");
	});
	return captured;
}

describe("boundConversationTextForSummary", () => {
	it("returns short input unchanged", () => {
		const text = "a short conversation";
		expect(boundConversationTextForSummary(text, MODEL, 1_000)).toBe(text);
	});

	it("truncates input that would exceed the model context window", () => {
		const outputMaxTokens = 1_600;
		const huge = "x".repeat(400_000); // ~100k heuristic tokens, far above any 20k-window budget
		const bounded = boundConversationTextForSummary(huge, MODEL, outputMaxTokens);

		expect(bounded.length).toBeLessThan(huge.length);
		expect(bounded).toContain("elided so this summarization request fits");

		// The bounded text must fit the conservative input budget in tokens.
		const overhead = 4096;
		const safety = 0.6;
		const budgetTokens = Math.floor((MODEL.contextWindow - outputMaxTokens - overhead) * safety);
		// heuristic tokens = chars / 4; the elision marker adds a small constant.
		const markerSlackChars = 200;
		expect(Math.ceil((bounded.length - markerSlackChars) / HEURISTIC_BYTES_PER_TOKEN)).toBeLessThanOrEqual(
			budgetTokens,
		);
	});

	it("does not bound when the context window is unknown", () => {
		const huge = "y".repeat(400_000);
		const unknownWindow: Model = { ...MODEL, contextWindow: 0 };
		expect(boundConversationTextForSummary(huge, unknownWindow, 1_000)).toBe(huge);
	});
});

describe("generateSummary request stays within the context window", () => {
	it("does not send an oversized summarization request for a near-full context", async () => {
		const captured = spyCompleteSimple();

		// A large history that, serialized verbatim, would blow past the 20k window.
		const messages: AgentMessage[] = [];
		for (let i = 0; i < 100; i++) {
			messages.push({ role: "user", content: "u".repeat(3_000), timestamp: Date.now() + i });
			messages.push(makeAssistantMessage("a".repeat(3_000)));
		}

		const summary = await generateSummary(messages, MODEL, 2_000, "test-key");
		expect(summary).toBe("summary text");

		// Exactly one summary request was issued, and its input was bounded.
		expect(captured).toHaveLength(1);
		const req = captured[0];
		const promptText = req.messages
			.map(m => {
				const content = (m as { content?: unknown }).content;
				if (typeof content === "string") return content;
				if (!Array.isArray(content)) return "";
				return content
					.filter((c): c is { type: "text"; text: string } => (c as { type?: string })?.type === "text")
					.map(c => c.text)
					.join("");
			})
			.join("");

		// The raw history is ~600k chars; the request must be a small fraction of that.
		expect(promptText).toContain("elided so this summarization request fits");
		const outputMaxTokens = Math.floor(0.8 * 2_000);
		const budgetTokens = Math.floor((MODEL.contextWindow - outputMaxTokens - 4096) * 0.6);
		// Prompt = bounded conversation + template/tags overhead; keep a generous slack for the template.
		const templateSlackTokens = 2_000;
		expect(Math.ceil(promptText.length / HEURISTIC_BYTES_PER_TOKEN)).toBeLessThanOrEqual(
			budgetTokens + templateSlackTokens,
		);
	});
});
