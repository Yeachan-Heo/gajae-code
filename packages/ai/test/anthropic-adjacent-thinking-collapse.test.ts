import { describe, expect, it } from "bun:test";
import { convertAnthropicMessages } from "@gajae-code/ai/providers/anthropic";
import type { AssistantMessage, Model, ToolResultMessage, UserMessage } from "@gajae-code/ai/types";

const model: Model<"anthropic-messages"> = {
	api: "anthropic-messages",
	provider: "anthropic",
	id: "claude-opus-5",
	name: "Claude Opus 5",
	baseUrl: "https://api.anthropic.com",
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	maxTokens: 8_192,
	contextWindow: 200_000,
	reasoning: true,
};

/**
 * Minimal same-model Anthropic assistant turn builder for adjacency tests.
 * Each thinking block carries a distinct signature so the invariant can be
 * verified by inspecting which signature survived.
 */
function makeAssistant(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
}

const userTurn: UserMessage = { role: "user", content: "continue", timestamp: Date.now() };

describe("convertAnthropicMessages: adjacent thinking-block collapse (#4416)", () => {
	it("collapses [thinking(sigA), thinking(sigB), toolCall] to [thinking(sigA), toolCall]", () => {
		const assistant = makeAssistant([
			{ type: "thinking", thinking: "first thinking", thinkingSignature: "sigA" },
			{ type: "thinking", thinking: "second thinking", thinkingSignature: "sigB" },
			{ type: "text", text: "answer" },
			{ type: "toolCall", id: "toolu_1", name: "read", arguments: { path: "README.md" } },
		]);

		const params = convertAnthropicMessages([userTurn, assistant], model, false);
		const wire = params.find(m => m.role === "assistant");
		expect(wire).toBeDefined();
		expect(wire?.content).toEqual([
			{ type: "thinking", thinking: "first thinking", signature: "sigA" },
			{ type: "text", text: "answer" },
			{ type: "tool_use", id: "toolu_1", name: "read", input: { path: "README.md" } },
		]);
	});

	it("collapses a run of three adjacent thinking blocks to the first", () => {
		const assistant = makeAssistant([
			{ type: "thinking", thinking: "alpha", thinkingSignature: "sigA" },
			{ type: "thinking", thinking: "beta", thinkingSignature: "sigB" },
			{ type: "thinking", thinking: "gamma", thinkingSignature: "sigC" },
			{ type: "text", text: "answer" },
		]);

		const params = convertAnthropicMessages([userTurn, assistant], model, false);
		const wire = params.find(m => m.role === "assistant");
		expect(wire?.content).toEqual([
			{ type: "thinking", thinking: "alpha", signature: "sigA" },
			{ type: "text", text: "answer" },
		]);
	});

	it("collapses adjacent mixed thinking/redacted-thinking in thinking-then-redacted order", () => {
		const assistant = makeAssistant([
			{ type: "thinking", thinking: "reasoning", thinkingSignature: "sigA" },
			{ type: "redactedThinking", data: "opaque-redacted" },
			{ type: "text", text: "answer" },
		]);

		const params = convertAnthropicMessages([userTurn, assistant], model, false);
		const wire = params.find(m => m.role === "assistant");
		expect(wire?.content).toEqual([
			{ type: "thinking", thinking: "reasoning", signature: "sigA" },
			{ type: "text", text: "answer" },
		]);
	});

	it("collapses adjacent mixed thinking/redacted-thinking in redacted-then-thinking order", () => {
		const assistant = makeAssistant([
			{ type: "redactedThinking", data: "opaque-redacted" },
			{ type: "thinking", thinking: "reasoning", thinkingSignature: "sigB" },
			{ type: "text", text: "answer" },
		]);

		const params = convertAnthropicMessages([userTurn, assistant], model, false);
		const wire = params.find(m => m.role === "assistant");
		expect(wire?.content).toEqual([
			{ type: "redacted_thinking", data: "opaque-redacted" },
			{ type: "text", text: "answer" },
		]);
	});

	it("preserves interleaved [thinking, toolCall, thinking, toolCall]", () => {
		const assistant = makeAssistant([
			{ type: "thinking", thinking: "first thought", thinkingSignature: "sigA" },
			{ type: "toolCall", id: "toolu_1", name: "read", arguments: { path: "a.txt" } },
			{ type: "thinking", thinking: "second thought", thinkingSignature: "sigB" },
			{ type: "toolCall", id: "toolu_2", name: "read", arguments: { path: "b.txt" } },
		]);

		const params = convertAnthropicMessages([userTurn, assistant], model, false);
		const wire = params.find(m => m.role === "assistant");
		expect(wire?.content).toEqual([
			{ type: "thinking", thinking: "first thought", signature: "sigA" },
			{ type: "tool_use", id: "toolu_1", name: "read", input: { path: "a.txt" } },
			{ type: "thinking", thinking: "second thought", signature: "sigB" },
			{ type: "tool_use", id: "toolu_2", name: "read", input: { path: "b.txt" } },
		]);
	});

	it("preserves thinking separated by a text block", () => {
		const assistant = makeAssistant([
			{ type: "thinking", thinking: "first", thinkingSignature: "sigA" },
			{ type: "text", text: "intermediate text" },
			{ type: "thinking", thinking: "second", thinkingSignature: "sigB" },
		]);

		const params = convertAnthropicMessages([userTurn, assistant], model, false);
		const wire = params.find(m => m.role === "assistant");
		expect(wire?.content).toEqual([
			{ type: "thinking", thinking: "first", signature: "sigA" },
			{ type: "text", text: "intermediate text" },
			{ type: "thinking", thinking: "second", signature: "sigB" },
		]);
	});

	it("collapses a leading run of adjacent thinking blocks", () => {
		const assistant = makeAssistant([
			{ type: "thinking", thinking: "keep", thinkingSignature: "sigA" },
			{ type: "thinking", thinking: "drop", thinkingSignature: "sigB" },
		]);

		const params = convertAnthropicMessages([userTurn, assistant], model, false);
		const wire = params.find(m => m.role === "assistant");
		expect(wire?.content).toEqual([{ type: "thinking", thinking: "keep", signature: "sigA" }]);
	});

	it("collapses a trailing run of adjacent thinking blocks", () => {
		const assistant = makeAssistant([
			{ type: "text", text: "answer" },
			{ type: "thinking", thinking: "keep", thinkingSignature: "sigA" },
			{ type: "thinking", thinking: "drop", thinkingSignature: "sigB" },
		]);

		const params = convertAnthropicMessages([userTurn, assistant], model, false);
		const wire = params.find(m => m.role === "assistant");
		expect(wire?.content).toEqual([
			{ type: "text", text: "answer" },
			{ type: "thinking", thinking: "keep", signature: "sigA" },
		]);
	});

	it("is idempotent: running convertAnthropicMessages output through again is a no-op", () => {
		const assistant = makeAssistant([
			{ type: "thinking", thinking: "first", thinkingSignature: "sigA" },
			{ type: "thinking", thinking: "second", thinkingSignature: "sigB" },
			{ type: "thinking", thinking: "third", thinkingSignature: "sigC" },
			{ type: "text", text: "answer" },
		]);

		const params1 = convertAnthropicMessages([userTurn, assistant], model, false);
		const wire1 = JSON.stringify(params1.find(m => m.role === "assistant")?.content);

		// Re-run: the collapsed output fed back in must not change further.
		// We re-build a fresh AssistantMessage from the wire shape to exercise
		// the full conversion path (transformMessages → convertAnthropicMessages).
		const replayAssistant: AssistantMessage = {
			...assistant,
			content: [
				{ type: "thinking", thinking: "first", thinkingSignature: "sigA" },
				{ type: "text", text: "answer" },
			],
		};
		const params2 = convertAnthropicMessages([userTurn, replayAssistant], model, false);
		const wire2 = JSON.stringify(params2.find(m => m.role === "assistant")?.content);

		expect(wire1).toEqual(wire2);
	});

	it("collapses adjacency created when convertAnthropicMessages skips an empty text block", () => {
		// [thinking, text(""), thinking] — the empty text is skipped, which would
		// create [thinking, thinking] on the wire without the final collapse pass.
		const assistant = makeAssistant([
			{ type: "thinking", thinking: "first", thinkingSignature: "sigA" },
			{ type: "text", text: "   " },
			{ type: "thinking", thinking: "second", thinkingSignature: "sigB" },
			{ type: "text", text: "answer" },
		]);

		const params = convertAnthropicMessages([userTurn, assistant], model, false);
		const wire = params.find(m => m.role === "assistant");
		expect(wire?.content).toEqual([
			{ type: "thinking", thinking: "first", signature: "sigA" },
			{ type: "text", text: "answer" },
		]);
	});

	it("does not collapse cross-model thinking blocks that degrade to text", () => {
		// Cross-model thinking degrades to text in transformMessages when it is
		// NOT the latest Anthropic assistant message (isSameModel=false &&
		// mustPreserveLatestAnthropicThinking=false). Those degraded text blocks
		// are never native thinking on the wire, so the collapse must leave them
		// intact. Here an earlier cross-model turn sits before a same-model turn.
		const crossModelAssistant: AssistantMessage = {
			...makeAssistant([
				{ type: "thinking", thinking: "cross-model reasoning A", thinkingSignature: "sigX" },
				{ type: "thinking", thinking: "cross-model reasoning B", thinkingSignature: "sigY" },
				{ type: "text", text: "cross-model answer" },
			]),
			model: "claude-sonnet-4-6", // different model id
		};
		const sameModelAssistant = makeAssistant([
			{ type: "thinking", thinking: "same-model reasoning", thinkingSignature: "sigSame" },
			{ type: "text", text: "same-model answer" },
		]);
		const userMid: UserMessage = { role: "user", content: "again", timestamp: Date.now() };

		const params = convertAnthropicMessages(
			[userTurn, crossModelAssistant, userMid, sameModelAssistant],
			model,
			false,
		);
		const assistants = params.filter(m => m.role === "assistant");
		// Cross-model thinking degraded to text; both survive (collapse targets
		// native thinking blocks only).
		expect(assistants[0]?.content).toEqual([
			{ type: "text", text: "cross-model reasoning A" },
			{ type: "text", text: "cross-model reasoning B" },
			{ type: "text", text: "cross-model answer" },
		]);
		// Same-model native thinking is preserved.
		expect(assistants[1]?.content).toEqual([
			{ type: "thinking", thinking: "same-model reasoning", signature: "sigSame" },
			{ type: "text", text: "same-model answer" },
		]);
	});

	it("collapses adjacency across multiple assistant messages independently", () => {
		const assistantA = makeAssistant([
			{ type: "thinking", thinking: "a-first", thinkingSignature: "sigA1" },
			{ type: "thinking", thinking: "a-second", thinkingSignature: "sigA2" },
			{ type: "text", text: "answer a" },
		]);
		const assistantB = makeAssistant([
			{ type: "thinking", thinking: "b-first", thinkingSignature: "sigB1" },
			{ type: "thinking", thinking: "b-second", thinkingSignature: "sigB2" },
			{ type: "text", text: "answer b" },
		]);
		const toolResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "toolu_1",
			toolName: "read",
			content: [{ type: "text", text: "result" }],
			isError: false,
			timestamp: Date.now(),
		};

		const params = convertAnthropicMessages([userTurn, assistantA, toolResult, assistantB], model, false);
		const assistants = params.filter(m => m.role === "assistant");
		expect(assistants).toHaveLength(2);
		expect(assistants[0]?.content).toEqual([
			{ type: "thinking", thinking: "a-first", signature: "sigA1" },
			{ type: "text", text: "answer a" },
		]);
		expect(assistants[1]?.content).toEqual([
			{ type: "thinking", thinking: "b-first", signature: "sigB1" },
			{ type: "text", text: "answer b" },
		]);
	});

	it("preserves the surviving block's exact bytes/signature (object identity of first block)", () => {
		const assistant = makeAssistant([
			{ type: "thinking", thinking: "first", thinkingSignature: "sigA" },
			{ type: "thinking", thinking: "second", thinkingSignature: "sigB" },
		]);

		const params = convertAnthropicMessages([userTurn, assistant], model, false);
		const wire = params.find(m => m.role === "assistant");
		const wireContent = Array.isArray(wire?.content) ? wire.content : [];
		// Only the first thinking block survives; its signature and bytes are unchanged.
		expect(wireContent).toEqual([{ type: "thinking", thinking: "first", signature: "sigA" }]);
		expect(wireContent.some(b => "signature" in b && b.signature === "sigB")).toBe(false);
	});

	it("handles a long adversarial run of alternating thinking types bounded and idempotent", () => {
		// 200 adjacent thinking/redacted blocks → must collapse to exactly one in O(n).
		const blocks: AssistantMessage["content"] = [];
		for (let i = 0; i < 100; i++) {
			blocks.push({ type: "thinking", thinking: `t${i}`, thinkingSignature: `sig${i}` });
			blocks.push({ type: "redactedThinking", data: `r${i}` });
		}
		blocks.push({ type: "text", text: "answer" });
		const assistant = makeAssistant(blocks);

		const params = convertAnthropicMessages([userTurn, assistant], model, false);
		const wire = params.find(m => m.role === "assistant");
		expect(wire?.content).toEqual([
			{ type: "thinking", thinking: "t0", signature: "sig0" },
			{ type: "text", text: "answer" },
		]);
	});

	it("reconstructs the minimal #4416 reproducer: [thinking, thinking, text] → [thinking, text]", () => {
		// probepark's minimal reproducer: two signed thinking blocks lifted
		// verbatim from a poisoned message, replayed in a 3-message conversation.
		// Either block alone succeeds; the adjacent pair is rejected by Anthropic.
		const poisonedAssistant = makeAssistant([
			{ type: "thinking", thinking: "first reasoning block", thinkingSignature: "sig_1880_chars_A" },
			{ type: "thinking", thinking: "second reasoning block", thinkingSignature: "sig_2032_chars_B" },
			{ type: "text", text: "visible response" },
		]);

		const params = convertAnthropicMessages([userTurn, poisonedAssistant], model, false);
		const wire = params.find(m => m.role === "assistant");
		expect(wire?.content).toEqual([
			{ type: "thinking", thinking: "first reasoning block", signature: "sig_1880_chars_A" },
			{ type: "text", text: "visible response" },
		]);
	});
});
