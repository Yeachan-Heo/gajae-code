import { afterEach, describe, expect, it, vi } from "bun:test";
import type { AgentMessage } from "@gajae-code/agent-core";
import * as ai from "@gajae-code/ai";
import { type Api, getBundledModel, type Model } from "@gajae-code/ai";
import {
	buildPromptSuggestionContext,
	generatePromptSuggestion,
	sanitizePromptSuggestion,
	suppressPromptSuggestionReason,
} from "../src/utils/prompt-suggestion";

function getModelOrThrow(id: string): Model<Api> {
	const model = getBundledModel("anthropic", id);
	if (!model) throw new Error(`Expected model ${id}`);
	return model;
}

function createSettings(model: Model<Api>) {
	return {
		getModelRole(role: string) {
			return role === "default" ? `${model.provider}/${model.id}` : undefined;
		},
		getStorage() {
			return undefined;
		},
	} as never;
}

function createRegistry(model: Model<Api>) {
	return {
		getAvailable: () => [model],
		getApiKey: async () => "test-key",
	} as never;
}

function userMessage(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: Date.now() } as never;
}

function assistantMessage(text: string): AgentMessage {
	return { role: "assistant", content: [{ type: "text", text }] } as never;
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("sanitizePromptSuggestion", () => {
	it("strips wrapper tags", () => {
		expect(sanitizePromptSuggestion("<suggestion>run the tests</suggestion>")).toBe("run the tests");
		expect(sanitizePromptSuggestion("<response>commit this</response>")).toBe("commit this");
	});

	it("keeps ambiguous nested wrappers intact", () => {
		const nested = "<suggestion>outer </suggestion> inner</suggestion>";
		expect(sanitizePromptSuggestion(nested)).toBe(nested);
	});

	it("strips label prefixes", () => {
		expect(sanitizePromptSuggestion("Suggestion: run the tests")).toBe("run the tests");
		expect(sanitizePromptSuggestion("suggested response: go ahead")).toBe("go ahead");
	});

	it("trims whitespace", () => {
		expect(sanitizePromptSuggestion("  run the tests \n")).toBe("run the tests");
	});
});

describe("suppressPromptSuggestionReason", () => {
	it("accepts a normal short suggestion", () => {
		expect(suppressPromptSuggestionReason("run the tests")).toBeNull();
	});

	it("accepts allow-listed single words and slash commands", () => {
		expect(suppressPromptSuggestionReason("yes")).toBeNull();
		expect(suppressPromptSuggestionReason("commit")).toBeNull();
		expect(suppressPromptSuggestionReason("/compact")).toBeNull();
	});

	it("rejects empty and meta output", () => {
		expect(suppressPromptSuggestionReason("")).toBe("empty");
		expect(suppressPromptSuggestionReason("done")).toBe("done");
		expect(suppressPromptSuggestionReason("nothing to suggest here")).toBe("meta_text");
		expect(suppressPromptSuggestionReason("I will stay silent")).toBe("meta_text");
		expect(suppressPromptSuggestionReason("(no suggestion applicable)")).toBe("meta_wrapped");
	});

	it("rejects error passthrough", () => {
		expect(suppressPromptSuggestionReason("API Error: rate limited")).toBe("error_message");
	});

	it("rejects labels, arbitrary single words, and overlong output", () => {
		expect(suppressPromptSuggestionReason("Note: something")).toBe("prefixed_label");
		expect(suppressPromptSuggestionReason("refactor")).toBe("too_few_words");
		expect(suppressPromptSuggestionReason("a b c d e f g h i j k l m")).toBe("too_many_words");
		expect(suppressPromptSuggestionReason(`fix ${"x".repeat(100)}`)).toBe("too_long");
	});

	it("rejects prose-shaped output", () => {
		expect(suppressPromptSuggestionReason("Run it. Then commit")).toBe("multiple_sentences");
		expect(suppressPromptSuggestionReason("run **all** tests")).toBe("has_formatting");
		expect(suppressPromptSuggestionReason("looks good to me")).toBe("evaluative");
		expect(suppressPromptSuggestionReason("I'll run the tests")).toBe("claude_voice");
		expect(suppressPromptSuggestionReason("Here's the next step")).toBe("claude_voice");
	});
});

describe("buildPromptSuggestionContext", () => {
	it("returns null when there is no user message", () => {
		expect(buildPromptSuggestionContext([])).toBeNull();
		expect(buildPromptSuggestionContext([assistantMessage("hi")])).toBeNull();
	});

	it("builds a chronological transcript from recent messages", () => {
		const context = buildPromptSuggestionContext([
			userMessage("fix the bug and run tests"),
			assistantMessage("Fixed the null check in parser.ts."),
		]);
		expect(context).toContain("User: fix the bug and run tests");
		expect(context).toContain("Assistant: Fixed the null check in parser.ts.");
		expect(context?.indexOf("User:")).toBeLessThan(context?.indexOf("Assistant:") ?? -1);
	});

	it("truncates very long messages", () => {
		const context = buildPromptSuggestionContext([userMessage("x".repeat(5000))]);
		expect(context).toContain("…");
		expect(context?.length ?? 0).toBeLessThan(3000);
	});

	it("skips messages without extractable text", () => {
		const toolResult = { role: "toolResult", content: [{ type: "text", text: "output" }] } as never;
		const context = buildPromptSuggestionContext([userMessage("run it"), toolResult]);
		expect(context).toContain("User: run it");
		expect(context).not.toContain("output");
	});
});

describe("generatePromptSuggestion", () => {
	it("returns the sanitized model prediction", async () => {
		const model = getModelOrThrow("claude-sonnet-4-5");
		const completeSimpleMock = vi.spyOn(ai, "completeSimple").mockResolvedValue({
			stopReason: "stop",
			content: [{ type: "text", text: "Suggestion: run the tests" }],
		} as never);

		const suggestion = await generatePromptSuggestion(
			[userMessage("fix the bug and run tests"), assistantMessage("Bug fixed.")],
			createRegistry(model),
			createSettings(model),
		);

		expect(suggestion).toBe("run the tests");
		expect(completeSimpleMock.mock.calls[0]?.[2]).toMatchObject({ disableReasoning: true });
	});

	it("returns null when the prediction is suppressed", async () => {
		const model = getModelOrThrow("claude-sonnet-4-5");
		vi.spyOn(ai, "completeSimple").mockResolvedValue({
			stopReason: "stop",
			content: [{ type: "text", text: "Looks good, thanks!" }],
		} as never);

		const suggestion = await generatePromptSuggestion(
			[userMessage("fix the bug")],
			createRegistry(model),
			createSettings(model),
		);

		expect(suggestion).toBeNull();
	});

	it("returns null on response errors", async () => {
		const model = getModelOrThrow("claude-sonnet-4-5");
		vi.spyOn(ai, "completeSimple").mockResolvedValue({
			stopReason: "error",
			errorMessage: "boom",
			content: [],
		} as never);

		const suggestion = await generatePromptSuggestion(
			[userMessage("fix the bug")],
			createRegistry(model),
			createSettings(model),
		);

		expect(suggestion).toBeNull();
	});

	it("returns null without calling the model when there is no user message", async () => {
		const model = getModelOrThrow("claude-sonnet-4-5");
		const completeSimpleMock = vi.spyOn(ai, "completeSimple").mockResolvedValue({
			stopReason: "stop",
			content: [{ type: "text", text: "run the tests" }],
		} as never);

		const suggestion = await generatePromptSuggestion([], createRegistry(model), createSettings(model));

		expect(suggestion).toBeNull();
		expect(completeSimpleMock).not.toHaveBeenCalled();
	});
});
