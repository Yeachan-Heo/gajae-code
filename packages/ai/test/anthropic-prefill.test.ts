import { describe, expect, it } from "bun:test";
import { convertAnthropicMessages } from "@gajae-code/ai/providers/anthropic";
import { transformMessages } from "@gajae-code/ai/providers/transform-messages";
import type { AssistantMessage, Model, UserMessage } from "@gajae-code/ai/types";

/**
 * Regression: some Anthropic-routed models reject "assistant prefill" requests
 * (messages ending with an assistant turn). We should automatically append a
 * synthetic user message to keep the request valid.
 */
describe("Anthropic assistant-prefill fallback", () => {
	const model: Model<"anthropic-messages"> = {
		api: "anthropic-messages",
		provider: "anthropic",
		id: "claude-3-5-sonnet-20241022",
		name: "Claude 3.5 Sonnet",
		baseUrl: "https://api.anthropic.com",
		input: ["text"],
		cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
		maxTokens: 8192,
		contextWindow: 200000,
		reasoning: true,
	};

	it("appends a user Continue. message when the last turn is assistant", () => {
		const user: UserMessage = {
			role: "user",
			content: "Output JSON",
			timestamp: Date.now(),
		};
		const assistantPrefill: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "{" }],
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

		const params = convertAnthropicMessages([user, assistantPrefill], model, false);
		expect(params.at(-1)?.role).toBe("user");
		expect(params.at(-1)?.content).toBe("Continue.");
	});

	it("does not append Continue. when the last turn is already user", () => {
		const params = convertAnthropicMessages(
			[
				{ role: "user", content: "hi", timestamp: Date.now() },
				{
					role: "assistant",
					content: [{ type: "text", text: "hello" }],
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
				},
				{ role: "user", content: "what now?", timestamp: Date.now() },
			],
			model,
			false,
		);
		expect(params.at(-1)?.role).toBe("user");
		expect(params.at(-1)?.content).toBe("what now?");
	});
});

it("preserves redacted thinking blocks in assistant replay payloads", () => {
	const model: Model<"anthropic-messages"> = {
		api: "anthropic-messages",
		provider: "anthropic",
		id: "claude-3-5-sonnet-20241022",
		name: "Claude 3.5 Sonnet",
		baseUrl: "https://api.anthropic.com",
		input: ["text"],
		cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
		maxTokens: 8192,
		contextWindow: 200000,
		reasoning: true,
	};
	const user: UserMessage = {
		role: "user",
		content: "continue",
		timestamp: Date.now(),
	};
	const assistant: AssistantMessage = {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "internal", thinkingSignature: "sig_1" },
			{ type: "redactedThinking", data: "encrypted_payload" },
			{ type: "text", text: "Final answer" },
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

	const params = convertAnthropicMessages([user, assistant], model, false);
	const assistantParam = params.find(m => m.role === "assistant");
	expect(assistantParam).toBeDefined();
	expect(Array.isArray(assistantParam?.content)).toBe(true);
	const blocks = assistantParam?.content as unknown as Array<Record<string, unknown>>;
	expect(blocks.map(block => block.type)).toEqual(["thinking", "redacted_thinking", "text"]);
	expect(blocks[0]?.signature).toBe("sig_1");
	expect(blocks[1]?.data).toBe("encrypted_payload");
});

it("preserves latest Anthropic thinking blocks even when model id changes", () => {
	const model: Model<"anthropic-messages"> = {
		api: "anthropic-messages",
		provider: "anthropic",
		id: "claude-3-5-sonnet-20241022",
		name: "Claude 3.5 Sonnet",
		baseUrl: "https://api.anthropic.com",
		input: ["text"],
		cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
		maxTokens: 8192,
		contextWindow: 200000,
		reasoning: true,
	};
	const switchedModel: Model<"anthropic-messages"> = { ...model, id: "claude-opus-4-6-20251201" };
	const assistant: AssistantMessage = {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "internal", thinkingSignature: "sig_2" },
			{ type: "redactedThinking", data: "encrypted_payload_2" },
			{ type: "text", text: "Answer" },
		],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-6-20251201",
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

	const transformed = transformMessages(
		[{ role: "user", content: "continue", timestamp: Date.now() }, assistant],
		switchedModel,
	);
	const transformedAssistant = transformed.find(m => m.role === "assistant") as AssistantMessage | undefined;
	expect(transformedAssistant).toBeDefined();
	expect(transformedAssistant?.content[0]).toEqual(assistant.content[0]);
	expect(transformedAssistant?.content[1]).toEqual(assistant.content[1]);
});

it("drops invalid thinking blocks from aborted Anthropic replay messages", () => {
	const model: Model<"anthropic-messages"> = {
		api: "anthropic-messages",
		provider: "anthropic",
		id: "claude-3-5-sonnet-20241022",
		name: "Claude 3.5 Sonnet",
		baseUrl: "https://api.anthropic.com",
		input: ["text"],
		cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
		maxTokens: 8192,
		contextWindow: 200000,
		reasoning: true,
	};
	const assistant: AssistantMessage = {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "partial reasoning", thinkingSignature: "sig_partial" },
			{ type: "text", text: "partial answer" },
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
		timestamp: Date.now(),
	};

	const transformed = transformMessages(
		[{ role: "user", content: "continue", timestamp: Date.now() }, assistant],
		model,
	);
	const transformedAssistant = transformed.find(m => m.role === "assistant") as AssistantMessage | undefined;

	expect(transformedAssistant).toBeDefined();
	expect(transformedAssistant?.content).toEqual([{ type: "text", text: "partial answer" }]);
});
