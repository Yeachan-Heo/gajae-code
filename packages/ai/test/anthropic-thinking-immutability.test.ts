import { describe, expect, it } from "bun:test";
import {
	convertAnthropicMessages,
	isAnthropicThinkingBlockMutationError,
	isAnthropicThinkingSignatureInvalidError,
} from "@gajae-code/ai/providers/anthropic";
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

	it("drops thinking across every assistant turn for signature-invalid replay repair", () => {
		const makeAssistant = (suffix: string, text: string): AssistantMessage => ({
			role: "assistant",
			content: [
				{ type: "thinking", thinking: `thinking ${suffix}`, thinkingSignature: `sig_${suffix}` },
				{ type: "redactedThinking", data: `redacted-${suffix}` },
				{ type: "text", text },
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
		});
		const userA: UserMessage = { role: "user", content: "first", timestamp: Date.now() };
		const userB: UserMessage = { role: "user", content: "second", timestamp: Date.now() };

		const params = convertAnthropicMessages(
			[userA, makeAssistant("early", "early answer"), userB, makeAssistant("late", "late answer")],
			model,
			false,
			{ repairAllAssistantThinking: true },
		);

		expect(params).toEqual([
			{ role: "user", content: "first" },
			{ role: "assistant", content: [{ type: "text", text: "early answer" }] },
			{ role: "user", content: "second" },
			{ role: "assistant", content: [{ type: "text", text: "late answer" }] },
			{ role: "user", content: "Continue." },
		]);
	});

	it("keeps cross-model thinking as text during signature-invalid replay repair", () => {
		const userA: UserMessage = { role: "user", content: "first", timestamp: Date.now() };
		const userB: UserMessage = { role: "user", content: "second", timestamp: Date.now() };
		// Replayed history from a DIFFERENT Anthropic model: its thinking was never
		// sent as a signed block by this model, so it degrades to plain text and
		// cannot be the signature failure — repair must not delete it.
		const crossModelAssistant: AssistantMessage = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "important prior reasoning", thinkingSignature: "sig_other_model" },
				{ type: "text", text: "cross-model answer" },
			],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-opus-4-1",
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
		const sameModelAssistant: AssistantMessage = {
			...crossModelAssistant,
			model: model.id,
			content: [
				{ type: "thinking", thinking: "same-model thinking", thinkingSignature: "sig_same_model" },
				{ type: "text", text: "same-model answer" },
			],
		};

		const params = convertAnthropicMessages([userA, crossModelAssistant, userB, sameModelAssistant], model, false, {
			repairAllAssistantThinking: true,
		});

		expect(params).toEqual([
			{ role: "user", content: "first" },
			{
				role: "assistant",
				content: [
					{ type: "text", text: "important prior reasoning" },
					{ type: "text", text: "cross-model answer" },
				],
			},
			{ role: "user", content: "second" },
			{ role: "assistant", content: [{ type: "text", text: "same-model answer" }] },
			{ role: "user", content: "Continue." },
		]);
	});
});

describe("Anthropic thinking replay 400 classification", () => {
	const status400 = (message: string): Error => Object.assign(new Error(message), { status: 400 });
	// Captured from a real session failure (2026-07-23): a historical thinking block
	// whose signature no longer validates fails the whole request.
	const signatureInvalidMessage =
		'400 {"type":"error","error":{"type":"invalid_request_error","message":"messages.5.content.24: Invalid `signature` in `thinking` block"},"request_id":"req_011CdHzaxJ77hsR8hX9U6QBH"}';
	const latestMutationMessage =
		'400 {"type":"error","error":{"type":"invalid_request_error","message":"The `thinking` blocks in the latest assistant message cannot be modified. These blocks must remain as they were in the original response."}}';

	it("classifies the invalid-signature 400 variant", () => {
		const error = status400(signatureInvalidMessage);
		expect(isAnthropicThinkingSignatureInvalidError(error)).toBe(true);
		// The latest-message repair matcher must NOT claim this variant: its repair
		// scope (latest assistant only) cannot fix a historical block.
		expect(isAnthropicThinkingBlockMutationError(error)).toBe(false);
	});

	it("keeps the latest-message mutation variant on the targeted matcher", () => {
		const error = status400(latestMutationMessage);
		expect(isAnthropicThinkingBlockMutationError(error)).toBe(true);
		expect(isAnthropicThinkingSignatureInvalidError(error)).toBe(false);
	});

	it("requires HTTP 400 for the invalid-signature match", () => {
		const error = Object.assign(new Error(signatureInvalidMessage.replace(/^400 /, "500 ")), { status: 500 });
		expect(isAnthropicThinkingSignatureInvalidError(error)).toBe(false);
	});

	it("rejects non-Error inputs and unrelated thinking-config 400s", () => {
		expect(isAnthropicThinkingSignatureInvalidError(undefined)).toBe(false);
		expect(isAnthropicThinkingSignatureInvalidError("Invalid `signature` in `thinking` block")).toBe(false);
		// A thinking-related 400 without a signature complaint must not trigger the
		// all-history thinking drop.
		const budgetError = status400(
			'400 {"type":"error","error":{"type":"invalid_request_error","message":"thinking.budget_tokens: Input should be greater than or equal to 1024"}}',
		);
		expect(isAnthropicThinkingSignatureInvalidError(budgetError)).toBe(false);
	});
});
