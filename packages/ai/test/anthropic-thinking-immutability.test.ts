import { describe, expect, it } from "bun:test";
import { convertAnthropicMessages } from "@gajae-code/ai/providers/anthropic";
import type { AssistantMessage, Model, ToolResultMessage, UserMessage } from "@gajae-code/ai/types";

const model: Model<"anthropic-messages"> = {
	api: "anthropic-messages",
	provider: "anthropic",
	id: "claude-sonnet-4-6",
	name: "Claude Sonnet 4.6",
	baseUrl: "https://api.anthropic.com",
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	maxTokens: 8_192,
	contextWindow: 200_000,
	reasoning: true,
};

describe("Anthropic thinking replay immutability", () => {
	it("preserves signed-thinking blocks while normalizing non-thinking content", () => {
		const malformed = String.fromCharCode(0xd800);
		const user: UserMessage = {
			role: "user",
			content: "continue",
			timestamp: Date.now(),
		};
		const assistant: AssistantMessage = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: `analysis ${malformed}`, thinkingSignature: "sig_thinking" },
				{ type: "redactedThinking", data: "" },
				{ type: "text", text: `text ${malformed}` },
				{
					type: "toolCall",
					id: "toolu_123",
					name: "read",
					arguments: { path: "README.md" },
				},
			],
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

		const params = convertAnthropicMessages([user, assistant], model, false);
		const assistantParam = params.find(message => message.role === "assistant");
		expect(assistantParam).toBeDefined();
		expect(assistantParam?.content).toEqual([
			{ type: "thinking", thinking: `analysis ${malformed}`, signature: "sig_thinking" },
			{ type: "text", text: `text ${malformed.toWellFormed()}` },
			{ type: "tool_use", id: "toolu_123", name: "read", input: { path: "README.md" } },
		]);
	});

	it("drops aborted assistant thinking while preserving a resolved tool-use turn", () => {
		const user: UserMessage = {
			role: "user",
			content: "use a tool",
			timestamp: Date.now(),
		};
		const abortedAssistant: AssistantMessage = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "partial synthetic thinking", thinkingSignature: "partial_test_sig" },
				{ type: "redactedThinking", data: "synthetic-redacted-block" },
				{
					type: "toolCall",
					id: "toolu_abort",
					name: "read",
					arguments: { path: "README.md" },
				},
			],
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
			stopReason: "aborted",
			errorMessage: "Request was aborted",
			timestamp: Date.now(),
		};
		const toolResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "toolu_abort",
			toolName: "read",
			content: [{ type: "text", text: "synthetic result" }],
			isError: true,
			timestamp: Date.now(),
		};

		const params = convertAnthropicMessages([user, abortedAssistant, toolResult], model, false);

		expect(params).toEqual([
			{ role: "user", content: "use a tool" },
			{
				role: "assistant",
				content: [{ type: "tool_use", id: "toolu_abort", name: "read", input: { path: "README.md" } }],
			},
			{
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "toolu_abort",
						content: "synthetic result",
						is_error: true,
					},
				],
			},
			{
				role: "user",
				content: expect.stringContaining("<turn-aborted>"),
			},
		]);
	});

	it("synthesizes an aborted tool result after dropping aborted thinking-only private blocks", () => {
		const user: UserMessage = {
			role: "user",
			content: "use a tool",
			timestamp: Date.now(),
		};
		const abortedAssistant: AssistantMessage = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "partial synthetic thinking", thinkingSignature: "partial_test_sig" },
				{
					type: "toolCall",
					id: "toolu_no_result",
					name: "read",
					arguments: { path: "README.md" },
				},
			],
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
			stopReason: "aborted",
			errorMessage: "Request was aborted",
			timestamp: Date.now(),
		};

		const params = convertAnthropicMessages([user, abortedAssistant], model, false);

		expect(params).toEqual([
			{ role: "user", content: "use a tool" },
			{
				role: "assistant",
				content: [{ type: "tool_use", id: "toolu_no_result", name: "read", input: { path: "README.md" } }],
			},
			{
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "toolu_no_result",
						content: "aborted",
						is_error: true,
					},
				],
			},
			{
				role: "user",
				content: expect.stringContaining("<turn-aborted>"),
			},
		]);
	});

	it("drops latest assistant thinking for one-shot Anthropic replay repair", () => {
		const user: UserMessage = {
			role: "user",
			content: "continue",
			timestamp: Date.now(),
		};
		const assistant: AssistantMessage = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "synthetic thinking", thinkingSignature: "synthetic_sig" },
				{ type: "redactedThinking", data: "synthetic-redacted-block" },
				{ type: "text", text: "visible answer" },
			],
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
			stopReason: "stop",
			timestamp: Date.now(),
		};

		const params = convertAnthropicMessages([user, assistant], model, false, {
			repairLatestAssistantThinking: true,
		});

		expect(params).toEqual([
			{ role: "user", content: "continue" },
			{ role: "assistant", content: [{ type: "text", text: "visible answer" }] },
			{ role: "user", content: "Continue." },
		]);
	});
});
