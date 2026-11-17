import { describe, expect, it } from "bun:test";
import { getBundledModel } from "../src/models";
import { convertMessages, detectCompat } from "../src/providers/openai-completions";
import type { AssistantMessage, Model, ThinkingContent, ToolCall } from "../src/types";

function deepseekModel(overrides: Partial<Model<"openai-completions">>): Model<"openai-completions"> {
	return {
		...getBundledModel("openai", "gpt-4o-mini"),
		api: "openai-completions",
		reasoning: true,
		...overrides,
	};
}

function assistantToolCall(
	model: Model<"openai-completions">,
	content?: AssistantMessage["content"],
): AssistantMessage {
	return {
		role: "assistant",
		content: content ?? [
			{
				type: "toolCall",
				id: "call_test_1",
				name: "read",
				arguments: { path: "/tmp/test" },
			},
		],
		api: model.api,
		provider: model.provider,
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

function assistantWithToolCall(model: Model<"openai-completions">): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{ type: "text", text: "Calling a tool." },
			{
				type: "toolCall",
				id: "call_repro_1",
				name: "list_files",
				arguments: { path: "." },
			},
		],
		api: model.api,
		provider: model.provider,
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

// #883 / #810: Replay must work on both official and Deepinfra endpoints.
describe("DeepSeek V4 endpoint reasoning_content tool-call replay", () => {
	it("flags requiresReasoningContentForToolCalls for deepseek-v4-pro on the official endpoint", () => {
		const compat = detectCompat(
			deepseekModel({
				provider: "deepseek",
				baseUrl: "https://api.deepseek.com/v1",
				id: "deepseek-v4-pro",
			}),
		);
		expect(compat.requiresReasoningContentForToolCalls).toBe(true);
	});

	it("flags requiresReasoningContentForToolCalls for deepseek-v4 served by a non-deepseek host (e.g. Deepinfra)", () => {
		const compat = detectCompat(
			deepseekModel({
				provider: "deepinfra",
				baseUrl: "https://api.deepinfra.com/v1/openai",
				id: "deepseek-ai/DeepSeek-V4-Flash",
			}),
		);
		expect(compat.requiresReasoningContentForToolCalls).toBe(true);
	});

	it("sets reasoning_content to empty string for deepseek-v4-pro tool-call turn with no thinking blocks", () => {
		const model = deepseekModel({
			provider: "deepseek",
			baseUrl: "https://api.deepseek.com/v1",
			id: "deepseek-v4-pro",
		});
		const compat = detectCompat(model);
		const messages = convertMessages(model, { messages: [assistantWithToolCall(model)] }, compat);
		const assistant = messages.find(m => m.role === "assistant");
		expect(assistant).toBeDefined();
		const reasoningContent = Reflect.get(assistant as object, "reasoning_content");
		expect(reasoningContent).toBeDefined();
		// DeepSeek rejects synthetic "." — when no thinking blocks exist, we emit empty string
		expect(reasoningContent).toBe("");
	});

	it("normalizes assistant content to '' when reasoning_content placeholder is injected (DeepSeek invariant)", () => {
		const model = deepseekModel({
			provider: "deepinfra",
			baseUrl: "https://api.deepinfra.com/v1/openai",
			id: "deepseek-ai/DeepSeek-V4-Pro",
		});
		const compat = detectCompat(model);
		// Assistant turn whose only content is a tool call (no text) - matches what the SDK
		// produces after a pure tool-use turn. content must end up "" (not null) because
		// DeepSeek rejects null content alongside reasoning_content.
		const toolOnly: AssistantMessage = {
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "call_repro_2",
					name: "list_files",
					arguments: { path: "." },
				},
			],
			api: model.api,
			provider: model.provider,
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
		const messages = convertMessages(model, { messages: [toolOnly] }, compat);
		const assistant = messages.find(m => m.role === "assistant");
		expect(assistant).toBeDefined();
		expect((assistant as { content: unknown }).content).toBe("");
	});
});

describe("DeepSeek reasoning_content tool-call replay", () => {
	// ----------------------------------------------------------------
	// Fix 1: reasoningEffortMap for DeepSeek-family on any provider
	// ----------------------------------------------------------------
	describe("reasoningEffortMap (Fix 1)", () => {
		it("maps unsupported lower DeepSeek efforts to high on opencode-go", () => {
			const compat = detectCompat(
				deepseekModel({
					provider: "opencode-go",
					baseUrl: "https://opencode.ai/zen/go/v1",
					id: "deepseek-v4-flash",
				}),
			);
			expect(compat.reasoningEffortMap).toMatchObject({
				minimal: "high",
				low: "high",
				medium: "high",
				high: "high",
				xhigh: "max",
			});
		});

		it("maps unsupported lower DeepSeek efforts to high on NVIDIA", () => {
			const compat = detectCompat(
				deepseekModel({
					provider: "nvidia",
					baseUrl: "https://integrate.api.nvidia.com/v1",
					id: "deepseek-ai/deepseek-v4-flash",
				}),
			);
			expect(compat.reasoningEffortMap).toMatchObject({
				minimal: "high",
				low: "high",
				medium: "high",
				high: "high",
				xhigh: "max",
			});
		});

		it("maps unsupported lower DeepSeek efforts to high on the official endpoint", () => {
			const compat = detectCompat(
				deepseekModel({
					provider: "deepseek",
					baseUrl: "https://api.deepseek.com/v1",
					id: "deepseek-v4-pro",
				}),
			);
			expect(compat.reasoningEffortMap).toMatchObject({
				minimal: "high",
				low: "high",
				medium: "high",
				high: "high",
				xhigh: "max",
			});
		});

		it("does NOT map xhigh for non-DeepSeek models", () => {
			const compat = detectCompat(
				deepseekModel({
					provider: "openai",
					baseUrl: "https://api.openai.com/v1",
					id: "gpt-4o-mini",
					reasoning: false,
				}),
			);
			expect(compat.reasoningEffortMap.xhigh).toBeUndefined();
		});
	});

	// ----------------------------------------------------------------
	// allowsSyntheticReasoningContentForToolCalls flag
	// ----------------------------------------------------------------
	describe("allowsSyntheticReasoningContentForToolCalls flag", () => {
		it("is false for DeepSeek-family reasoning models", () => {
			const compat = detectCompat(
				deepseekModel({
					provider: "deepseek",
					baseUrl: "https://api.deepseek.com/v1",
					id: "deepseek-v4-pro",
				}),
			);
			expect(compat.allowsSyntheticReasoningContentForToolCalls).toBe(false);
		});

		it("is false for DeepSeek-family on NVIDIA", () => {
			const compat = detectCompat(
				deepseekModel({
					provider: "nvidia",
					baseUrl: "https://integrate.api.nvidia.com/v1",
					id: "deepseek-ai/deepseek-v4-flash",
				}),
			);
			expect(compat.allowsSyntheticReasoningContentForToolCalls).toBe(false);
		});

		it("is true for non-DeepSeek reasoning models on OpenRouter", () => {
			const compat = detectCompat({
				...getBundledModel("openai", "gpt-4o-mini"),
				api: "openai-completions",
				provider: "openrouter",
				baseUrl: "https://openrouter.ai/api/v1",
				id: "qwen/qwq-32b",
				reasoning: true,
			});
			// Qwen is not isDeepseekFamily, so synthetic is allowed
			expect(compat.allowsSyntheticReasoningContentForToolCalls).toBe(true);
		});
	});

	// ----------------------------------------------------------------
	// Fix 2: reasoning_content from empty thinking blocks with signature
	// ----------------------------------------------------------------
	describe("thinking-block signature recovery (Fix 2)", () => {
		it("recovers reasoning_content from empty thinking block with valid signature", () => {
			const model = deepseekModel({
				provider: "opencode-go",
				baseUrl: "https://opencode.ai/zen/go/v1",
				id: "deepseek-v4-flash",
			});
			const compat = detectCompat(model);
			// Simulate a tool-call turn with an empty thinking block that has a valid
			// signature — this happens when reasoning text was lost but the signature
			// (field name) is preserved.
			const msg: AssistantMessage = {
				role: "assistant",
				content: [
					{
						type: "thinking",
						thinking: "",
						thinkingSignature: "reasoning_content",
					} as ThinkingContent,
					{
						type: "toolCall",
						id: "call_empty_thinking",
						name: "read",
						arguments: { path: "/tmp/test" },
					} as ToolCall,
				],
				api: model.api,
				provider: model.provider,
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
			const messages = convertMessages(model, { messages: [msg] }, compat);
			const assistant = messages.find(m => m.role === "assistant");
			expect(assistant).toBeDefined();
			// The reasoning_content field should be set from the signature, even if empty.
			expect(Reflect.get(assistant as object, "reasoning_content")).toBe("");
		});

		it("recovers reasoning_content from non-empty thinking block with signature", () => {
			const model = deepseekModel({
				provider: "opencode-go",
				baseUrl: "https://opencode.ai/zen/go/v1",
				id: "deepseek-v4-flash",
			});
			const compat = detectCompat(model);
			const msg: AssistantMessage = {
				role: "assistant",
				content: [
					{
						type: "thinking",
						thinking: "I need to read the file first.",
						thinkingSignature: "reasoning_content",
					} as ThinkingContent,
					{
						type: "toolCall",
						id: "call_with_thinking",
						name: "read",
						arguments: { path: "/tmp/test" },
					} as ToolCall,
				],
				api: model.api,
				provider: model.provider,
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
			const messages = convertMessages(model, { messages: [msg] }, compat);
			const assistant = messages.find(m => m.role === "assistant");
			expect(assistant).toBeDefined();
			expect(Reflect.get(assistant as object, "reasoning_content")).toBe("I need to read the file first.");
		});
		it("does not use opaque signature as property name but still sets reasoning_content from thinking text", () => {
			const model = deepseekModel({
				provider: "opencode-go",
				baseUrl: "https://opencode.ai/zen/go/v1",
				id: "deepseek-v4-flash",
			});
			const compat = detectCompat(model);
			// Simulate a thinking block with an opaque signature from another provider
			// (e.g. Anthropic encrypted signature, OpenAI Responses JSON item).
			// The code should NOT write to a property named after the opaque signature.
			// It should still set reasoning_content from the thinking text via the
			// existing thinkingFormat="openai" path.
			const msg: AssistantMessage = {
				role: "assistant",
				content: [
					{
						type: "thinking",
						thinking: "some reasoning",
						thinkingSignature: "rs_6f3a1b2c4d5e6f7a8b9c0d1e2f3a4b5c",
					} as ThinkingContent,
					{
						type: "toolCall",
						id: "call_opaque_sig",
						name: "read",
						arguments: { path: "/tmp/test" },
					} as ToolCall,
				],
				api: model.api,
				provider: model.provider,
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
			const messages = convertMessages(model, { messages: [msg] }, compat);
			const assistant = messages.find(m => m.role === "assistant");
			expect(assistant).toBeDefined();
			// Should NOT have used the opaque signature as a property name.
			expect(Reflect.get(assistant as object, "rs_6f3a1b2c4d5e6f7a8b9c0d1e2f3a4b5c")).toBeUndefined();
			// Should have set reasoning_content from the thinking text via the openai path.
			expect(Reflect.get(assistant as object, "reasoning_content")).toBe("some reasoning");
		});
		it("falls through to empty-string when thinking block has opaque signature and empty text", () => {
			const model = deepseekModel({
				provider: "opencode-go",
				baseUrl: "https://opencode.ai/zen/go/v1",
				id: "deepseek-v4-flash",
			});
			const compat = detectCompat(model);
			// Empty-text thinking block with opaque signature — Tier 1 should reject the
			// opaque signature, nonEmptyThinkingBlocks won't include it, and the openai path
			// won't set anything. Tier 2 should then emit empty reasoning_content.
			const msg: AssistantMessage = {
				role: "assistant",
				content: [
					{
						type: "thinking",
						thinking: "",
						thinkingSignature: "rs_6f3a1b2c4d5e6f7a8b9c0d1e2f3a4b5c",
					} as ThinkingContent,
					{
						type: "toolCall",
						id: "call_empty_opaque",
						name: "read",
						arguments: { path: "/tmp/test" },
					} as ToolCall,
				],
				api: model.api,
				provider: model.provider,
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
			const messages = convertMessages(model, { messages: [msg] }, compat);
			const assistant = messages.find(m => m.role === "assistant");
			expect(assistant).toBeDefined();
			expect(Reflect.get(assistant as object, "rs_6f3a1b2c4d5e6f7a8b9c0d1e2f3a4b5c")).toBeUndefined();
			expect(Reflect.get(assistant as object, "reasoning_content")).toBe("");
		});
	});

	// ----------------------------------------------------------------
	// Fix 3: Empty-string fallback when NO thinking blocks exist
	// (matches the actual observed 400 failure: proxy-stripped reasoning)
	// ----------------------------------------------------------------
	describe("empty-string fallback for missing reasoning_content (Fix 3)", () => {
		it("sets reasoning_content to empty string when no thinking blocks exist for DeepSeek", () => {
			const model = deepseekModel({
				provider: "opencode-go",
				baseUrl: "https://opencode.ai/zen/go/v1",
				id: "deepseek-v4-flash",
			});
			const compat = detectCompat(model);
			// Tool-call turn with NO thinking blocks at all — matches the actual
			// observed 400 error pattern where proxy stripped reasoning_content.
			const msg = assistantToolCall(model, [
				{
					type: "toolCall",
					id: "call_no_thinking",
					name: "read",
					arguments: { path: "/tmp/test" },
				} as ToolCall,
			]);
			const messages = convertMessages(model, { messages: [msg] }, compat);
			const assistant = messages.find(m => m.role === "assistant");
			expect(assistant).toBeDefined();
			// reasoning_content must be present (empty string) — not absent and not "."
			const rc = Reflect.get(assistant as object, "reasoning_content");
			expect(rc).toBeDefined();
			expect(rc).toBe("");
		});

		it("sets content to empty string (not null) when reasoning_content is present", () => {
			const model = deepseekModel({
				provider: "nvidia",
				baseUrl: "https://integrate.api.nvidia.com/v1",
				id: "deepseek-ai/deepseek-v4-flash",
			});
			const compat = detectCompat(model);
			const msg = assistantToolCall(model, [
				{
					type: "toolCall",
					id: "call_no_content",
					name: "list_files",
					arguments: { path: "." },
				} as ToolCall,
			]);
			const messages = convertMessages(model, { messages: [msg] }, compat);
			const assistant = messages.find(m => m.role === "assistant");
			expect(assistant).toBeDefined();
			expect((assistant as { content: unknown }).content).toBe("");
		});
	});

	// ----------------------------------------------------------------
	// Fix 4: reasoning_content on ALL assistant turns, not just tool-call turns
	// DeepSeek V4 requires reasoning_content on every assistant message once any
	// prior turn included it — including plain text responses with no tool calls.
	// ----------------------------------------------------------------
	describe("reasoning_content on non-tool-call assistant turns (Fix 4)", () => {
		it("injects empty reasoning_content on plain text assistant turn for DeepSeek", () => {
			const model = deepseekModel({
				provider: "deepseek",
				baseUrl: "https://api.deepseek.com/v1",
				id: "deepseek-v4-pro",
			});
			const compat = detectCompat(model);
			// Plain text assistant response — no tool calls, no thinking blocks.
			// This is the exact pattern from the observed 400 error.
			const msg: AssistantMessage = {
				role: "assistant",
				content: [{ type: "text", text: "Here is the answer to your question." }],
				api: model.api,
				provider: model.provider,
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
			const messages = convertMessages(model, { messages: [msg] }, compat);
			const assistant = messages.find(m => m.role === "assistant");
			expect(assistant).toBeDefined();
			// reasoning_content must be present — even on non-tool-call turns
			const rc = Reflect.get(assistant as object, "reasoning_content");
			expect(rc).toBeDefined();
			expect(rc).toBe("");
		});

		it("injects reasoning_content from thinking blocks on plain text assistant turn", () => {
			const model = deepseekModel({
				provider: "opencode-go",
				baseUrl: "https://opencode.ai/zen/go/v1",
				id: "deepseek-v4-flash",
			});
			const compat = detectCompat(model);
			const msg: AssistantMessage = {
				role: "assistant",
				content: [
					{
						type: "thinking",
						thinking: "Let me think about this.",
						thinkingSignature: "reasoning_content",
					} as ThinkingContent,
					{ type: "text", text: "The answer is 42." },
				],
				api: model.api,
				provider: model.provider,
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
			const messages = convertMessages(model, { messages: [msg] }, compat);
			const assistant = messages.find(m => m.role === "assistant");
			expect(assistant).toBeDefined();
			expect(Reflect.get(assistant as object, "reasoning_content")).toBe("Let me think about this.");
			expect((assistant as { content: unknown }).content).toBe("The answer is 42.");
		});

		it("does NOT inject reasoning_content on non-tool-call turn for non-DeepSeek providers", () => {
			const model: Model<"openai-completions"> = {
				...getBundledModel("openai", "gpt-4o-mini"),
				api: "openai-completions",
				provider: "openrouter",
				baseUrl: "https://openrouter.ai/api/v1",
				id: "qwen/qwq-32b",
				reasoning: true,
			};
			const compat = detectCompat(model);
			const msg: AssistantMessage = {
				role: "assistant",
				content: [{ type: "text", text: "Plain answer." }],
				api: model.api,
				provider: model.provider,
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
			const messages = convertMessages(model, { messages: [msg] }, compat);
			const assistant = messages.find(m => m.role === "assistant");
			expect(assistant).toBeDefined();
			// OpenRouter reasoning models only need reasoning_content on tool-call turns
			expect(Reflect.get(assistant as object, "reasoning_content")).toBeUndefined();
		});
	});

	// ----------------------------------------------------------------
	// Tier 3: Synthetic placeholder for non-DeepSeek providers
	// ----------------------------------------------------------------
	describe("synthetic placeholder for non-DeepSeek providers (Tier 3)", () => {
		it('still uses "." placeholder for Kimi models that accept it', () => {
			const model: Model<"openai-completions"> = {
				...getBundledModel("openai", "gpt-4o-mini"),
				api: "openai-completions",
				provider: "moonshot",
				baseUrl: "https://api.moonshot.ai/v1",
				id: "kimi-k2.5",
				reasoning: true,
			};
			const compat = detectCompat(model);
			expect(compat.requiresReasoningContentForToolCalls).toBe(true);
			expect(compat.allowsSyntheticReasoningContentForToolCalls).toBe(true);
			const msg = assistantToolCall(model, [
				{
					type: "toolCall",
					id: "call_kimi",
					name: "read",
					arguments: { path: "/tmp" },
				} as ToolCall,
			]);
			const messages = convertMessages(model, { messages: [msg] }, compat);
			const assistant = messages.find(m => m.role === "assistant");
			expect(assistant).toBeDefined();
			expect(Reflect.get(assistant as object, "reasoning_content")).toBe(".");
		});
	});
});
