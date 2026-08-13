import { describe, expect, it } from "bun:test";
import { hasAdjacentPrivateThinkingBlocks } from "../src/providers/transform-messages";

describe("hasAdjacentPrivateThinkingBlocks (#4443)", () => {
	it("detects two directly adjacent thinking blocks", () => {
		expect(hasAdjacentPrivateThinkingBlocks([{ type: "thinking" }, { type: "thinking" }])).toBe(true);
	});

	it("detects adjacent thinking followed by redactedThinking", () => {
		expect(hasAdjacentPrivateThinkingBlocks([{ type: "thinking" }, { type: "redactedThinking" }])).toBe(true);
	});

	it("detects adjacent redactedThinking followed by thinking", () => {
		expect(hasAdjacentPrivateThinkingBlocks([{ type: "redactedThinking" }, { type: "thinking" }])).toBe(true);
	});

	it("detects two directly adjacent redactedThinking blocks", () => {
		expect(hasAdjacentPrivateThinkingBlocks([{ type: "redactedThinking" }, { type: "redactedThinking" }])).toBe(true);
	});

	it("detects adjacency within a longer content sequence", () => {
		expect(
			hasAdjacentPrivateThinkingBlocks([
				{ type: "text" },
				{ type: "thinking" },
				{ type: "thinking" },
				{ type: "toolCall" },
			]),
		).toBe(true);
	});

	it("returns false for thinking separated by a tool call (interleaved)", () => {
		expect(hasAdjacentPrivateThinkingBlocks([{ type: "thinking" }, { type: "toolCall" }, { type: "thinking" }])).toBe(
			false,
		);
	});

	it("returns false for thinking separated by text", () => {
		expect(hasAdjacentPrivateThinkingBlocks([{ type: "thinking" }, { type: "text" }, { type: "thinking" }])).toBe(
			false,
		);
	});

	it("returns false for a single thinking block", () => {
		expect(hasAdjacentPrivateThinkingBlocks([{ type: "thinking" }])).toBe(false);
	});

	it("returns false for a single redactedThinking block", () => {
		expect(hasAdjacentPrivateThinkingBlocks([{ type: "redactedThinking" }])).toBe(false);
	});

	it("returns false for no thinking blocks at all", () => {
		expect(hasAdjacentPrivateThinkingBlocks([{ type: "text" }, { type: "toolCall" }])).toBe(false);
	});

	it("returns false for an empty content array", () => {
		expect(hasAdjacentPrivateThinkingBlocks([])).toBe(false);
	});

	it("returns false for non-thinking adjacent blocks", () => {
		expect(hasAdjacentPrivateThinkingBlocks([{ type: "text" }, { type: "text" }])).toBe(false);
	});

	it("returns false for toolCall followed by toolCall", () => {
		expect(hasAdjacentPrivateThinkingBlocks([{ type: "toolCall" }, { type: "toolCall" }])).toBe(false);
	});
});
