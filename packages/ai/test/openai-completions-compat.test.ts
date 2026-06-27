import { afterEach, describe, expect, it } from "bun:test";
import * as z from "zod/v4";
import { getBundledModel } from "../src/models";
import { convertMessages, detectCompat, streamOpenAICompletions } from "../src/providers/openai-completions";
import { resolveOpenAICompat } from "../src/providers/openai-completions-compat";
import type { AssistantMessage, Context, Model, OpenAICompat, Tool } from "../src/types";

const originalFetch = global.fetch;

afterEach(() => {
	global.fetch = originalFetch;
});

function createAbortedSignal(): AbortSignal {
	const controller = new AbortController();
	controller.abort();
	return controller.signal;
}

function toObject(value: unknown): object | null {
	return typeof value === "object" && value !== null ? value : null;
}

function getNestedObject(value: unknown, key: string): object | null {
	const obj = toObject(value);
	if (!obj) return null;
	return toObject(Reflect.get(obj, key));
}

function getNestedBoolean(value: unknown, key: string): boolean | undefined {
	const obj = toObject(value);
	if (!obj) return undefined;
	const property = Reflect.get(obj, key);
	return typeof property === "boolean" ? property : undefined;
}

function createSseResponse(events: unknown[]): Response {
	const payload = `${events.map(event => `data: ${typeof event === "string" ? event : JSON.stringify(event)}`).join("\n\n")}\n\n`;
	return new Response(payload, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function createMockFetch(events: unknown[]): typeof fetch {
	async function mockFetch(_input: string | URL | Request, _init?: RequestInit): Promise<Response> {
		return createSseResponse(events);
	}

	return Object.assign(mockFetch, { preconnect: originalFetch.preconnect });
}

function baseContext(): Context {
	return {
		messages: [
			{
				role: "user",
				content: "hello",
				timestamp: Date.now(),
			},
		],
	};
}

describe("openai-completions compatibility", () => {
	it("serializes assistant text content as a plain string", () => {
		const model: Model<"openai-completions"> = {
			...getBundledModel("openai", "gpt-4o-mini"),
			api: "openai-completions",
		};
		const compat = {
			supportsStore: true,
			supportsDeveloperRole: true,
			sendSessionHeaders: false,
			supportsMultipleSystemMessages: true,
			supportsReasoningEffort: true,
			reasoningEffortMap: {},
			supportsUsageInStreaming: true,
			supportsToolChoice: true,
			supportsForcedToolChoice: true,
			toolChoiceSupport: "named",
			disableReasoningOnForcedToolChoice: false,
			disableReasoningOnToolChoice: false,
			maxTokensField: "max_completion_tokens",
			requiresToolResultName: false,
			requiresAssistantAfterToolResult: false,
			requiresThinkingAsText: false,
			requiresMistralToolIds: false,
			thinkingFormat: "openai",
			reasoningContentField: "reasoning_content",
			requiresReasoningContentForToolCalls: false,
			allowsSyntheticReasoningContentForToolCalls: true,
			requiresAssistantContentForToolCalls: false,
			openRouterRouting: {},
			vercelGatewayRouting: {},
			extraBody: {},
			supportsStrictMode: true,
			toolStrictMode: "none",
		} satisfies Required<OpenAICompat>;
		const assistantMessage: AssistantMessage = {
			role: "assistant",
			content: [
				{ type: "text", text: "hello" },
				{ type: "text", text: " world" },
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
		const messages = convertMessages(model, { messages: [assistantMessage] }, compat);
		const assistant = messages.find(message => message.role === "assistant");
		expect(assistant).toBeDefined();
		if (assistant?.role !== "assistant") {
			throw new Error("assistant message missing");
		}
		expect(typeof assistant.content).toBe("string");
		expect(assistant.content).toBe("hello world");
	});

	it("preserves multiple system prompts as leading system messages for chat completions", () => {
		const model: Model<"openai-completions"> = {
			...getBundledModel("openai", "gpt-4o-mini"),
			api: "openai-completions",
		};

		const messages = convertMessages(
			model,
			{
				systemPrompt: ["stable instructions", "cacheable policy"],
				messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
			},
			detectCompat(model),
		);

		expect(messages.slice(0, 3)).toEqual([
			{ role: "system", content: "stable instructions" },
			{ role: "system", content: "cacheable policy" },
			{ role: "user", content: "hello" },
		]);
	});

	it("uses developer messages for reasoning chat models only when the target supports them", () => {
		const model: Model<"openai-completions"> = {
			...getBundledModel("openai", "gpt-4o-mini"),
			api: "openai-completions",
			reasoning: true,
		};

		const supportedMessages = convertMessages(
			model,
			{
				systemPrompt: ["stable instructions", "cacheable policy"],
				messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
			},
			detectCompat(model),
		);

		expect(supportedMessages.slice(0, 3)).toEqual([
			{ role: "developer", content: "stable instructions" },
			{ role: "developer", content: "cacheable policy" },
			{ role: "user", content: "hello" },
		]);

		const unsupportedMessages = convertMessages(
			model,
			{
				systemPrompt: ["stable instructions", "cacheable policy"],
				messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
			},
			{ ...detectCompat(model), supportsDeveloperRole: false },
		);

		expect(unsupportedMessages.slice(0, 3)).toEqual([
			{ role: "system", content: "stable instructions" },
			{ role: "system", content: "cacheable policy" },
			{ role: "user", content: "hello" },
		]);
	});

	it("coalesces ordered system prompts when the host disables multi-system support", () => {
		const model: Model<"openai-completions"> = {
			...getBundledModel("openai", "gpt-4o-mini"),
			api: "openai-completions",
		};

		const messages = convertMessages(
			model,
			{
				systemPrompt: ["stable instructions", "cacheable policy"],
				messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
			},
			{ ...detectCompat(model), supportsMultipleSystemMessages: false },
		);

		expect(messages.slice(0, 2)).toEqual([
			{ role: "system", content: "stable instructions\n\ncacheable policy" },
			{ role: "user", content: "hello" },
		]);
	});

	it("coalesces system prompts on a developer-role reasoning model when multi-system is disabled", () => {
		const model: Model<"openai-completions"> = {
			...getBundledModel("openai", "gpt-4o-mini"),
			api: "openai-completions",
			reasoning: true,
		};

		const messages = convertMessages(
			model,
			{
				systemPrompt: ["stable instructions", "cacheable policy"],
				messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
			},
			{ ...detectCompat(model), supportsMultipleSystemMessages: false },
		);

		expect(messages.slice(0, 2)).toEqual([
			{ role: "developer", content: "stable instructions\n\ncacheable policy" },
			{ role: "user", content: "hello" },
		]);
	});

	it("emits separate system prompts for an unknown OpenAI-compatible host when explicitly enabled", () => {
		const model: Model<"openai-completions"> = {
			...getBundledModel("openai", "gpt-4o-mini"),
			api: "openai-completions",
			provider: "custom" as Model["provider"],
			baseUrl: "https://example.invalid/v1",
		};

		const detected = detectCompat(model);
		expect(detected.supportsMultipleSystemMessages).toBe(false);

		const overridden = convertMessages(
			model,
			{
				systemPrompt: ["stable instructions", "cacheable policy"],
				messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
			},
			{ ...detected, supportsMultipleSystemMessages: true },
		);

		expect(overridden.slice(0, 3)).toEqual([
			{ role: "system", content: "stable instructions" },
			{ role: "system", content: "cacheable policy" },
			{ role: "user", content: "hello" },
		]);
	});

	it("auto-detects MiniMax OpenAI hosts as single-system to satisfy error 2013", () => {
		const model: Model<"openai-completions"> = {
			...getBundledModel("openai", "gpt-4o-mini"),
			api: "openai-completions",
			provider: "minimax-code" as Model["provider"],
			baseUrl: "https://api.minimax.io/v1",
		};

		const detected = detectCompat(model);
		expect(detected.supportsMultipleSystemMessages).toBe(false);

		const messages = convertMessages(
			model,
			{
				systemPrompt: ["stable instructions", "cacheable policy"],
				messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
			},
			detected,
		);

		expect(messages.slice(0, 2)).toEqual([
			{ role: "system", content: "stable instructions\n\ncacheable policy" },
			{ role: "user", content: "hello" },
		]);
	});

	it("respects an explicit compat override for strict-template local providers", () => {
		const model: Model<"openai-completions"> = {
			...getBundledModel("openai", "gpt-4o-mini"),
			api: "openai-completions",
			provider: "custom" as Model["provider"],
			baseUrl: "https://my-vllm.local/v1",
			compat: {
				supportsDeveloperRole: false,
				supportsMultipleSystemMessages: false,
			},
		};

		const messages = convertMessages(
			model,
			{
				systemPrompt: ["stable instructions", "cacheable policy"],
				messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
			},
			resolveOpenAICompat(model),
		);

		expect(messages.slice(0, 2)).toEqual([
			{ role: "system", content: "stable instructions\n\ncacheable policy" },
			{ role: "user", content: "hello" },
		]);
	});

	it("reads usage from choice usage fallback", async () => {
		const model: Model<"openai-completions"> = {
			...getBundledModel("openai", "gpt-4o-mini"),
			api: "openai-completions",
		};
		global.fetch = createMockFetch([
			{
				id: "chatcmpl-test",
				object: "chat.completion.chunk",
				created: 0,
				model: model.id,
				choices: [
					{
						index: 0,
						delta: { content: "Hello" },
						usage: {
							prompt_tokens: 12,
							completion_tokens: 3,
							prompt_tokens_details: { cached_tokens: 2 },
						},
					},
				],
			},
			{
				id: "chatcmpl-test",
				object: "chat.completion.chunk",
				created: 0,
				model: model.id,
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			},
			"[DONE]",
		]);

		const result = await streamOpenAICompletions(model, baseContext(), { apiKey: "test-key" }).result();
		expect(result.stopReason).toBe("stop");
		expect(result.usage.input).toBe(10);
		expect(result.usage.output).toBe(3);
		expect(result.usage.cacheRead).toBe(2);
		expect(result.usage.totalTokens).toBe(15);
	});

	it("maps qwen chat template reasoning into chat_template_kwargs", async () => {
		const model: Model<"openai-completions"> = {
			...getBundledModel("openai", "gpt-4o-mini"),
			api: "openai-completions",
			reasoning: true,
			compat: {
				thinkingFormat: "qwen-chat-template",
			},
		};
		const { promise, resolve } = Promise.withResolvers<unknown>();
		streamOpenAICompletions(model, baseContext(), {
			apiKey: "test-key",
			reasoning: "high",
			signal: createAbortedSignal(),
			onPayload: payload => resolve(payload),
		});
		const payload = await promise;
		const chatTemplateArgs = getNestedObject(payload, "chat_template_kwargs");
		expect(getNestedBoolean(chatTemplateArgs, "enable_thinking")).toBe(true);
	});

	it("treats finish_reason end as stop", async () => {
		const model: Model<"openai-completions"> = {
			...getBundledModel("openai", "gpt-4o-mini"),
			api: "openai-completions",
		};
		global.fetch = createMockFetch([
			{
				id: "chatcmpl-end",
				object: "chat.completion.chunk",
				created: 0,
				model: model.id,
				choices: [{ index: 0, delta: { content: "done" } }],
			},
			{
				id: "chatcmpl-end",
				object: "chat.completion.chunk",
				created: 0,
				model: model.id,
				choices: [{ index: 0, delta: {}, finish_reason: "end" }],
			},
			"[DONE]",
		]);

		const result = await streamOpenAICompletions(model, baseContext(), { apiKey: "test-key" }).result();
		expect(result.stopReason).toBe("stop");
		expect(result.content[0]).toMatchObject({ type: "text", text: "done" });
	});

	it("injects compat.extraBody into OpenAI payload", async () => {
		const model: Model<"openai-completions"> = {
			...getBundledModel("openai", "gpt-4o-mini"),
			api: "openai-completions",
			compat: {
				extraBody: {
					gateway: "m1-01",
					controller: "mlx",
				},
			},
		};

		const { promise, resolve } = Promise.withResolvers<unknown>();
		global.fetch = createMockFetch(["[DONE]"]);
		streamOpenAICompletions(model, baseContext(), {
			apiKey: "test-key",
			signal: createAbortedSignal(),
			onPayload: payload => resolve(payload),
		});

		const payload = await promise;
		expect(payload).toEqual(
			expect.objectContaining({
				gateway: "m1-01",
				controller: "mlx",
			}),
		);
	});

	it("preserves the streamed reasoning field name when replay requires reasoning content", async () => {
		const model: Model<"openai-completions"> = {
			...getBundledModel("openai", "gpt-4o-mini"),
			api: "openai-completions",
		};
		global.fetch = createMockFetch([
			{
				id: "chatcmpl-reasoning-text",
				object: "chat.completion.chunk",
				created: 0,
				model: model.id,
				choices: [
					{
						index: 0,
						delta: { reasoning_text: "inspect tool output" },
					},
				],
			},
			{
				id: "chatcmpl-reasoning-text",
				object: "chat.completion.chunk",
				created: 0,
				model: model.id,
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			},
			"[DONE]",
		]);

		const result = await streamOpenAICompletions(model, baseContext(), { apiKey: "test-key" }).result();
		expect(result.content).toContainEqual({
			type: "thinking",
			thinking: "inspect tool output",
			thinkingSignature: "reasoning_text",
		});

		const compat = { ...detectCompat(model), requiresReasoningContentForToolCalls: true };
		const messages = convertMessages(model, { messages: [result] }, compat);
		const assistant = messages.find(message => message.role === "assistant");
		expect(assistant).toBeDefined();
		const assistantObject = toObject(assistant);
		expect(assistantObject).toBeDefined();
		expect(assistantObject ? Reflect.get(assistantObject, "reasoning_text") : undefined).toBe("inspect tool output");
		expect(assistantObject ? Reflect.get(assistantObject, "reasoning_content") : undefined).toBeUndefined();
	});
});

describe("kimi model detection via detectCompat", () => {
	function kimiOpenCodeModel(id: string): Model<"openai-completions"> {
		return {
			...getBundledModel("openai", "gpt-4o-mini"),
			api: "openai-completions",
			provider: "opencode-go",
			baseUrl: "https://opencode.ai/zen/go/v1",
			id,
			reasoning: true,
		};
	}

	function kimiMoonshotModel(id: string): Model<"openai-completions"> {
		return {
			...getBundledModel("openai", "gpt-4o-mini"),
			api: "openai-completions",
			provider: "moonshot",
			baseUrl: "https://api.moonshot.ai/v1",
			id,
			reasoning: true,
		};
	}

	// Regression for #1071: OpenCode-Go/Zen handle reasoning content server-side
	// and reject client-supplied `reasoning_content` ("Extra inputs are not
	// permitted"). Kimi on opencode-* MUST NOT have reasoning_content injected,
	// even though it's still recognized as a Kimi model for other quirks.
	it("does not require reasoning_content for tool calls on kimi-k2.5 (opencode-go)", () => {
		const compat = detectCompat(kimiOpenCodeModel("kimi-k2.5"));
		expect(compat.requiresReasoningContentForToolCalls).toBe(false);
		// Kimi-specific quirks still apply even on opencode hosts.
		expect(compat.requiresAssistantContentForToolCalls).toBe(true);
	});

	async function captureOpenCodeGoPayload(
		options: Parameters<typeof streamOpenAICompletions>[2],
	): Promise<Record<string, unknown>> {
		const tool: Tool = {
			name: "search",
			description: "Search test data",
			parameters: z.object({ query: z.string() }),
		};
		const { promise, resolve } = Promise.withResolvers<unknown>();
		streamOpenAICompletions(
			getBundledModel("opencode-go", "kimi-k2.5") as Model<"openai-completions">,
			{ ...baseContext(), tools: [tool] },
			{
				...options,
				apiKey: "test-key",
				signal: createAbortedSignal(),
				onPayload: payload => resolve(payload),
			},
		);
		return (await promise) as Record<string, unknown>;
	}
	it("disables reasoning for forced tool_choice on official OpenCode Go models", () => {
		const model = getBundledModel("opencode-go", "kimi-k2.5");
		expect(model.provider).toBe("opencode-go");
		expect(model.reasoning).toBe(true);

		const compat = detectCompat(model as Model<"openai-completions">);

		expect(compat.disableReasoningOnForcedToolChoice).toBe(true);
	});

	it("drops reasoning, not forced tool_choice, for OpenCode Go forced tool_choice payloads", async () => {
		const payload = await captureOpenCodeGoPayload({
			reasoning: "high",
			toolChoice: { type: "function", function: { name: "search" } },
		});

		expect(payload.tools).toBeDefined();
		expect(payload.tool_choice).toEqual({ type: "function", function: { name: "search" } });
		expect(payload.reasoning_effort).toBeUndefined();
		expect(payload.reasoning).toBeUndefined();
	});

	it("preserves reasoning for OpenCode Go auto tool_choice payloads", async () => {
		const payload = await captureOpenCodeGoPayload({ reasoning: "high", toolChoice: "auto" });

		expect(payload.tools).toBeDefined();
		expect(payload.tool_choice).toBe("auto");
		expect(payload.reasoning_effort).toBe("high");
	});

	it("does not inject reasoning_content placeholder for kimi on opencode-go", () => {
		const model = kimiOpenCodeModel("kimi-k2.5");
		const compat = detectCompat(model);
		const toolCallMessage: AssistantMessage = {
			role: "assistant",
			content: [
				{ type: "text", text: "Let me research this." },
				{
					type: "toolCall",
					id: "call_abc123",
					name: "web_search",
					arguments: { query: "beads gastownhall" },
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
		const messages = convertMessages(model, { messages: [toolCallMessage] }, compat);
		const assistant = messages.find(m => m.role === "assistant");
		expect(assistant).toBeDefined();
		expect(Reflect.get(assistant as object, "reasoning_content")).toBeUndefined();
	});

	it("does not replay streamed reasoning fields for kimi on opencode-go", () => {
		const model = kimiOpenCodeModel("kimi-k2.6");
		const compat = detectCompat(model);
		const toolCallMessage: AssistantMessage = {
			role: "assistant",
			content: [
				{ type: "text", text: "." },
				{
					type: "thinking",
					thinking: "The user wants to install...",
					thinkingSignature: "reasoning",
				},
				{
					type: "toolCall",
					id: "call_abc123",
					name: "bash",
					arguments: { command: "echo ok" },
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

		expect(compat.requiresReasoningContentForToolCalls).toBe(false);
		const messages = convertMessages(model, { messages: [toolCallMessage] }, compat);
		const assistant = messages.find(m => m.role === "assistant");
		const assistantObject = toObject(assistant);
		expect(assistantObject).toBeDefined();
		if (!assistantObject) {
			throw new Error("assistant message missing");
		}
		expect(Reflect.get(assistantObject, "reasoning")).toBeUndefined();
		expect(Reflect.get(assistantObject, "reasoning_content")).toBeUndefined();
		expect(Reflect.get(assistantObject, "reasoning_text")).toBeUndefined();
	});

	it("injects reasoning_content placeholder when kimi-on-moonshot has tool calls without reasoning field", () => {
		const model = kimiMoonshotModel("kimi-k2.5");
		const compat = detectCompat(model);
		const toolCallMessage: AssistantMessage = {
			role: "assistant",
			content: [
				{ type: "text", text: "Let me research this." },
				{
					type: "toolCall",
					id: "call_abc123",
					name: "web_search",
					arguments: { query: "beads gastownhall" },
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
		const messages = convertMessages(model, { messages: [toolCallMessage] }, compat);
		const assistant = messages.find(m => m.role === "assistant");
		expect(assistant).toBeDefined();
		const reasoningContent = Reflect.get(assistant as object, "reasoning_content");
		expect(reasoningContent).toBeDefined();
		expect(typeof reasoningContent).toBe("string");
		expect((reasoningContent as string).length).toBeGreaterThan(0);
	});

	it("injects reasoning_content placeholder for direct Moonshot Kimi after thinking-disabled forced tool calls", () => {
		const model: Model<"openai-completions"> = {
			...getBundledModel("openai", "gpt-4o-mini"),
			api: "openai-completions",
			provider: "moonshot",
			baseUrl: "https://api.moonshot.ai/v1",
			id: "kimi-k2.6",
			reasoning: false,
		};
		const compat = detectCompat(model);
		const toolCallMessage: AssistantMessage = {
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "call_abc123",
					name: "resolve",
					arguments: { action: "apply", reason: "approved" },
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

		expect(compat.thinkingFormat).toBe("zai");
		expect(compat.requiresReasoningContentForToolCalls).toBe(true);
		const messages = convertMessages(model, { messages: [toolCallMessage] }, compat);
		const assistant = messages.find(m => m.role === "assistant");
		expect(assistant).toBeDefined();
		expect(Reflect.get(assistant as object, "reasoning_content")).toBe(".");
	});

	it("does not inject reasoning_content when model is not kimi", () => {
		const model: Model<"openai-completions"> = {
			...getBundledModel("openai", "gpt-4o-mini"),
			api: "openai-completions",
			provider: "opencode-go",
			baseUrl: "https://opencode.ai/zen/go/v1",
			id: "some-other-model",
		};
		const compat = detectCompat(model);
		expect(compat.requiresReasoningContentForToolCalls).toBe(false);
		expect(compat.requiresAssistantContentForToolCalls).toBe(false);
	});

	// `requiresAssistantContentForToolCalls` keys directly off isKimiModel and
	// is provider-agnostic, so it's the cleanest signal that the id-pattern
	// match recognizes every Kimi variant.
	it.each(["kimi-k2.5", "kimi-k1.5", "kimi-k2-5"])("matches kimi model id: %s", id => {
		const compat = detectCompat(kimiMoonshotModel(id));
		expect(compat.requiresAssistantContentForToolCalls).toBe(true);
		expect(compat.requiresReasoningContentForToolCalls).toBe(true);
	});

	it("still matches moonshotai/kimi via openrouter", () => {
		const model: Model<"openai-completions"> = {
			...getBundledModel("openai", "gpt-4o-mini"),
			api: "openai-completions",
			provider: "openrouter",
			baseUrl: "https://openrouter.ai/api/v1",
			id: "moonshotai/kimi-k2-5",
			reasoning: true,
		};
		const compat = detectCompat(model);
		expect(compat.requiresReasoningContentForToolCalls).toBe(true);
	});
});

describe("NVIDIA NIM DeepSeek special-token stripping", () => {
	function nvidiaDeepseekModel(): Model<"openai-completions"> {
		return {
			...getBundledModel("openai", "gpt-4o-mini"),
			api: "openai-completions",
			provider: "nvidia",
			baseUrl: "https://integrate.api.nvidia.com/v1",
			id: "deepseek-ai/deepseek-v4-flash",
			reasoning: true,
		};
	}

	it("strips leaked <\uff5cDSML\uff5c...\uff5c> markers from visible content", async () => {
		const model = nvidiaDeepseekModel();
		global.fetch = createMockFetch([
			{
				id: "chatcmpl-nim-1",
				object: "chat.completion.chunk",
				created: 0,
				model: model.id,
				choices: [
					{
						index: 0,
						delta: { content: "Sure thing.<\uff5cDSML\uff5ctool_calls\uff5c>I'll help." },
					},
				],
			},
			{
				id: "chatcmpl-nim-1",
				object: "chat.completion.chunk",
				created: 0,
				model: model.id,
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			},
			"[DONE]",
		]);

		const result = await streamOpenAICompletions(model, baseContext(), { apiKey: "test-key" }).result();
		const text = result.content
			.filter(b => b.type === "text")
			.map(b => (b as { text: string }).text)
			.join("");
		expect(text).toBe("Sure thing.I'll help.");
		expect(text).not.toContain("DSML");
		expect(text).not.toContain("\uff5c");
	});

	it("holds back partial token split across chunks", async () => {
		const model = nvidiaDeepseekModel();
		global.fetch = createMockFetch([
			{
				id: "chatcmpl-nim-2",
				object: "chat.completion.chunk",
				created: 0,
				model: model.id,
				choices: [{ index: 0, delta: { content: "Hello <\uff5ctool_calls" } }],
			},
			{
				id: "chatcmpl-nim-2",
				object: "chat.completion.chunk",
				created: 0,
				model: model.id,
				choices: [{ index: 0, delta: { content: "_begin\uff5c>world" } }],
			},
			{
				id: "chatcmpl-nim-2",
				object: "chat.completion.chunk",
				created: 0,
				model: model.id,
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			},
			"[DONE]",
		]);

		const result = await streamOpenAICompletions(model, baseContext(), { apiKey: "test-key" }).result();
		const text = result.content
			.filter(b => b.type === "text")
			.map(b => (b as { text: string }).text)
			.join("");
		expect(text).toBe("Hello world");
	});

	it("flushes a dangling partial open delimiter at end of stream", async () => {
		const model = nvidiaDeepseekModel();
		global.fetch = createMockFetch([
			{
				id: "chatcmpl-nim-3",
				object: "chat.completion.chunk",
				created: 0,
				model: model.id,
				choices: [{ index: 0, delta: { content: "trailing <\uff5c" } }],
			},
			{
				id: "chatcmpl-nim-3",
				object: "chat.completion.chunk",
				created: 0,
				model: model.id,
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			},
			"[DONE]",
		]);

		// At end-of-stream we have no way to know whether the partial is a real token,
		// so we emit it verbatim rather than swallow legitimate text forever.
		const result = await streamOpenAICompletions(model, baseContext(), { apiKey: "test-key" }).result();
		const text = result.content
			.filter(b => b.type === "text")
			.map(b => (b as { text: string }).text)
			.join("");
		expect(text).toBe("trailing <\uff5c");
	});

	it("leaves visible content alone for non-deepseek nvidia models", async () => {
		const model: Model<"openai-completions"> = {
			...getBundledModel("openai", "gpt-4o-mini"),
			api: "openai-completions",
			provider: "nvidia",
			baseUrl: "https://integrate.api.nvidia.com/v1",
			id: "meta/llama-3.3-70b-instruct",
		};
		global.fetch = createMockFetch([
			{
				id: "chatcmpl-nim-4",
				object: "chat.completion.chunk",
				created: 0,
				model: model.id,
				choices: [{ index: 0, delta: { content: "keep <\uff5cas-is\uff5c> please" } }],
			},
			{
				id: "chatcmpl-nim-4",
				object: "chat.completion.chunk",
				created: 0,
				model: model.id,
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			},
			"[DONE]",
		]);

		const result = await streamOpenAICompletions(model, baseContext(), { apiKey: "test-key" }).result();
		const text = result.content
			.filter(b => b.type === "text")
			.map(b => (b as { text: string }).text)
			.join("");
		expect(text).toBe("keep <\uff5cas-is\uff5c> please");
	});
});
