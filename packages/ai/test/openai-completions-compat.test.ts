import { afterEach, describe, expect, it } from "bun:test";
import * as z from "zod/v4";
import { Effort } from "../src/model-thinking";
import { getBundledModel } from "../src/models";
import { convertMessages, detectCompat, streamOpenAICompletions } from "../src/providers/openai-completions";
import { resolveOpenAICompat } from "../src/providers/openai-completions-compat";
import type { AssistantMessage, AssistantMessageEvent, Context, Model, OpenAICompat, Tool } from "../src/types";
import { EMPTY_RESPONSE_PROVIDER_CODE } from "../src/utils/fallback-transport";

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
function getNestedString(value: unknown, key: string): string | undefined {
	const obj = toObject(value);
	if (!obj) return undefined;
	const property = Reflect.get(obj, key);
	return typeof property === "string" ? property : undefined;
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

function createSuccessfulCompletionResponse(): Response {
	return createSseResponse([
		{
			id: "chatcmpl-success",
			object: "chat.completion.chunk",
			created: 0,
			model: "gpt-4o-mini",
			choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }],
		},
		"[DONE]",
	]);
}

function createEmptyResponseModel(
	cost: Model<"openai-completions">["cost"] = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
): Model<"openai-completions"> {
	return {
		...getBundledModel("openai", "gpt-4o-mini"),
		api: "openai-completions",
		provider: "kilo",
		id: "stealth/ox-alpha",
		name: "Ox Alpha",
		baseUrl: "https://api.kilo.ai/api/gateway",
		cost,
	};
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
	it("never sends reasoning controls to Groq compound systems after late metadata overrides", async () => {
		for (const id of ["groq/compound", "groq/compound-mini"] as const) {
			const model: Model<"openai-completions"> = {
				id,
				name: id,
				api: "openai-completions",
				provider: "groq",
				baseUrl: "https://api.groq.com/openai/v1",
				reasoning: true,
				thinking: { mode: "effort", minLevel: Effort.Low, maxLevel: Effort.High },
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 131_072,
				maxTokens: 8_192,
				compat: { supportsReasoningEffort: true },
			};
			const { promise, resolve } = Promise.withResolvers<Record<string, unknown>>();
			streamOpenAICompletions(model, baseContext(), {
				apiKey: "test-key",
				reasoning: "high",
				signal: createAbortedSignal(),
				onPayload: payload => resolve(payload as Record<string, unknown>),
			});

			const payload = await promise;
			expect(payload.reasoning_effort).toBeUndefined();
			expect(payload.reasoning).toBeUndefined();
			expect(payload.enable_thinking).toBeUndefined();
			expect(payload.chat_template_kwargs).toBeUndefined();
		}
	});

	it("serializes direct xAI Grok 4.5+ reasoning efforts without changing other Grok routes", async () => {
		async function captureXaiPayload(modelId: string, reasoning: "low" | "xhigh", baseUrl = "https://api.x.ai/v1") {
			const model: Model<"openai-completions"> = {
				id: modelId,
				name: modelId,
				api: "openai-completions",
				provider: "xai",
				baseUrl,
				reasoning: true,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 500_000,
				maxTokens: 64_000,
			};
			const { promise, resolve } = Promise.withResolvers<unknown>();
			streamOpenAICompletions(model, baseContext(), {
				apiKey: "test-key",
				reasoning,
				signal: createAbortedSignal(),
				onPayload: payload => resolve(payload),
			});
			return (await promise) as Record<string, unknown>;
		}

		function xaiCompat(id: string, provider = "xai", baseUrl = "https://api.x.ai/v1") {
			return resolveOpenAICompat({
				id,
				name: id,
				api: "openai-completions",
				provider,
				baseUrl,
				reasoning: true,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 500_000,
				maxTokens: 64_000,
			}).supportsReasoningEffort;
		}

		for (const id of [
			"grok-4.5",
			"grok-4.6",
			"grok-4.7",
			"grok-4.20",
			"grok-4.20-0309-reasoning",
			"grok-4.20-beta-latest-reasoning",
			"grok-4.20-multi-agent-beta-latest",
			"grok-5",
			"grok-10.1-preview",
		]) {
			expect(xaiCompat(id), id).toBe(true);
		}
		for (const id of [
			"grok-3",
			"grok-3-mini",
			"grok-4",
			"grok-4.1",
			"grok-code-fast-1",
			"ungrok-4.6",
			"grok-04.6",
			"grok-4.06",
			"grok-4.6-",
			"grok-4.6--preview",
			"grok-4.6-preview_fast",
			"grok-4.6-fast-non-reasoning",
			"grok-4.20-0309-non-reasoning",
			"grok-4.20-beta-latest-non-reasoning",
			"GROK-4.6",
		]) {
			expect(xaiCompat(id), id).toBe(false);
		}
		expect(xaiCompat("grok-4.6", "xai", "https://proxy.example.com/v1")).toBe(false);
		expect(xaiCompat("grok-4.6", "xai", "http://localhost:4000/v1")).toBe(false);
		expect(xaiCompat("grok-4.6", "xai", "https://api.x.ai.evil.example/v1")).toBe(false);
		expect(xaiCompat("grok-4.6", "custom", "https://api.x.ai/v1")).toBe(false);
		expect(xaiCompat("grok-4.6", "openai", "https://api.openai.com/v1")).toBe(false);
		expect(xaiCompat("x-ai/grok-4.6", "openai", "https://api.openai.com/v1")).toBe(false);
		expect((await captureXaiPayload("grok-4.5", "low")).reasoning_effort).toBe("low");
		expect((await captureXaiPayload("grok-4.6", "xhigh")).reasoning_effort).toBe("xhigh");
		expect((await captureXaiPayload("grok-4.7", "low")).reasoning_effort).toBe("low");
		expect((await captureXaiPayload("grok-4.20-0309-reasoning", "low")).reasoning_effort).toBe("low");
		expect((await captureXaiPayload("grok-4.6", "xhigh", "https://proxy.example.com/v1")).reasoning_effort).toBe(
			undefined,
		);
		expect(xaiCompat("x-ai/grok-4.6", "openrouter", "https://openrouter.ai/api/v1")).toBe(true);
	});

	it("fails closed for arbitrary custom reasoning transports and honors explicit opt-in", async () => {
		async function captureCustomPayload(
			options: { compat?: OpenAICompat; id?: string; provider?: string; baseUrl?: string } = {},
		) {
			const model: Model<"openai-completions"> = {
				id: options.id ?? "reasoning-model",
				name: "Reasoning Model",
				api: "openai-completions",
				provider: options.provider ?? "my-proxy",
				baseUrl: options.baseUrl ?? "https://proxy.example.com/v1",
				reasoning: true,
				thinking: { mode: "effort", minLevel: Effort.Low, maxLevel: Effort.High },
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128_000,
				maxTokens: 32_000,
				compat: options.compat,
			};
			const { promise, resolve } = Promise.withResolvers<Record<string, unknown>>();
			streamOpenAICompletions(model, baseContext(), {
				apiKey: "test-key",
				reasoning: "high",
				signal: createAbortedSignal(),
				onPayload: payload => resolve(payload as Record<string, unknown>),
			});
			return { model, payload: await promise };
		}

		const implicit = await captureCustomPayload();
		expect(resolveOpenAICompat(implicit.model).supportsReasoningEffort).toBe(false);
		expect(implicit.payload).not.toHaveProperty("reasoning_effort");

		const disabled = await captureCustomPayload({ compat: { supportsReasoningEffort: false } });
		expect(disabled.payload).not.toHaveProperty("reasoning_effort");

		const knownLabelOnUnknownEndpoint = await captureCustomPayload({
			provider: "litellm",
			baseUrl: "http://localhost:4000/v1",
		});
		expect(knownLabelOnUnknownEndpoint.payload).not.toHaveProperty("reasoning_effort");

		const grokOnOpenAIOrigin = await captureCustomPayload({
			id: "grok-4.6",
			provider: "openai",
			baseUrl: "https://api.openai.com/v1",
		});
		expect(grokOnOpenAIOrigin.payload).not.toHaveProperty("reasoning_effort");

		const qwenByNameOnly = await captureCustomPayload({
			id: "qwen-custom-reasoner",
			compat: { supportsReasoningEffort: false },
		});
		expect(qwenByNameOnly.payload).not.toHaveProperty("enable_thinking");
		expect(qwenByNameOnly.payload).not.toHaveProperty("reasoning_effort");

		const optedIn = await captureCustomPayload({
			id: "qwen-custom-reasoner",
			compat: {
				supportsReasoningEffort: true,
				reasoningEffortMap: { high: "provider-high" },
			},
		});
		expect(optedIn.payload.reasoning_effort).toBe("provider-high");
		expect(optedIn.payload).not.toHaveProperty("enable_thinking");

		const qwenOnOpenAI = await captureCustomPayload({
			id: "qwen-custom-reasoner",
			provider: "custom",
			baseUrl: "https://api.openai.com/dashscope/v1",
		});
		expect(qwenOnOpenAI.payload.reasoning_effort).toBe("high");
		expect(qwenOnOpenAI.payload).not.toHaveProperty("enable_thinking");

		const explicitQwenFormat = await captureCustomPayload({
			id: "qwen-custom-reasoner",
			compat: { supportsReasoningEffort: true, thinkingFormat: "qwen" },
		});
		expect(explicitQwenFormat.payload.enable_thinking).toBe(true);
		expect(explicitQwenFormat.payload).not.toHaveProperty("reasoning_effort");

		const disabledExplicitQwenFormat = await captureCustomPayload({
			id: "qwen-custom-reasoner",
			compat: { supportsReasoningEffort: false, thinkingFormat: "qwen" },
		});
		expect(disabledExplicitQwenFormat.payload).not.toHaveProperty("enable_thinking");
		expect(disabledExplicitQwenFormat.payload).not.toHaveProperty("reasoning_effort");

		const disabledAuditedQwenFormat = await captureCustomPayload({
			id: "qwen-custom-reasoner",
			baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
			compat: { supportsReasoningEffort: false, thinkingFormat: "qwen" },
		});
		expect(disabledAuditedQwenFormat.payload).not.toHaveProperty("enable_thinking");
		expect(disabledAuditedQwenFormat.payload).not.toHaveProperty("reasoning_effort");

		const disabledInjectedThinking = await captureCustomPayload({
			compat: {
				supportsReasoningEffort: false,
				extraBody: { thinking: { type: "enabled" } },
			},
		});
		expect(disabledInjectedThinking.payload).not.toHaveProperty("thinking");

		const zaiPathLookalike = await captureCustomPayload({
			baseUrl: "https://api.openai.com/v1/api.z.ai",
		});
		expect(zaiPathLookalike.payload.reasoning_effort).toBe("high");
		expect(zaiPathLookalike.payload).not.toHaveProperty("thinking");

		const openRouterPathLookalike = await captureCustomPayload({
			baseUrl: "https://api.openai.com/v1/openrouter.ai",
		});
		expect(openRouterPathLookalike.payload.reasoning_effort).toBe("high");
		expect(openRouterPathLookalike.payload).not.toHaveProperty("reasoning");
	});

	it("serializes assistant text content as a plain string", () => {
		const model: Model<"openai-completions"> = {
			...getBundledModel("openai", "gpt-4o-mini"),
			api: "openai-completions",
		};
		const compat = {
			supportsStore: true,
			supportsDeveloperRole: true,
			sendSessionHeaders: false,
			supportsResponsesSessionAffinity: false,
			supportsServiceTier: false,
			reservedToolNames: [],
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

	it("types an empty zero-usage completion as a retryable transport failure", async () => {
		const model = createEmptyResponseModel();
		global.fetch = createMockFetch([
			{
				id: "chatcmpl-empty",
				object: "chat.completion.chunk",
				created: 0,
				model: model.id,
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
				usage: { prompt_tokens: 0, completion_tokens: 0 },
			},
			"[DONE]",
		]);

		const stream = streamOpenAICompletions(model, baseContext(), { apiKey: "test-key" });
		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) events.push(event);
		const result = await stream.result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("Provider returned an empty response with zero token usage");
		expect(result.transportFailure).toEqual({
			kind: "transport",
			providerCode: EMPTY_RESPONSE_PROVIDER_CODE,
		});
		expect(events.filter(event => event.type === "error")).toHaveLength(1);
		expect(events.filter(event => event.type === "done")).toHaveLength(0);
	});

	it("leaves low nonzero empty completion usage untyped for overflow recovery", async () => {
		const model = createEmptyResponseModel({ input: 2, output: 4, cacheRead: 1, cacheWrite: 3 });
		global.fetch = createMockFetch([
			{
				id: "chatcmpl-low-usage-empty",
				object: "chat.completion.chunk",
				created: 0,
				model: model.id,
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
				usage: { prompt_tokens: 1, completion_tokens: 1 },
			},
			"[DONE]",
		]);

		const stream = streamOpenAICompletions(model, baseContext(), { apiKey: "test-key" });
		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) events.push(event);
		const result = await stream.result();

		expect(result.stopReason).toBe("stop");
		expect(result.content).toEqual([]);
		expect(result.usage).toMatchObject({ input: 1, output: 1 });
		expect(result.usage.cost).toEqual({
			input: 0.000002,
			output: 0.000004,
			cacheRead: 0,
			cacheWrite: 0,
			total: 0.000006,
		});
		expect(result.transportFailure).toBeUndefined();
		expect(events.filter(event => event.type === "error")).toHaveLength(0);
		expect(events.filter(event => event.type === "done")).toHaveLength(1);
	});

	it("leaves empty completions without explicit usage on overflow recovery", async () => {
		const model = createEmptyResponseModel();
		global.fetch = createMockFetch([
			{
				id: "chatcmpl-usage-absent",
				object: "chat.completion.chunk",
				created: 0,
				model: model.id,
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			},
			"[DONE]",
		]);

		const result = await streamOpenAICompletions(model, baseContext(), { apiKey: "test-key" }).result();

		expect(result.stopReason).toBe("stop");
		expect(result.content).toEqual([]);
		expect(result.usage.totalTokens).toBe(0);
		expect(result.transportFailure).toBeUndefined();
	});

	it("preserves total-token-only evidence on empty completions", async () => {
		const model = createEmptyResponseModel();
		global.fetch = createMockFetch([
			{
				id: "chatcmpl-total-only",
				object: "chat.completion.chunk",
				created: 0,
				model: model.id,
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
				usage: { total_tokens: 2 },
			},
			"[DONE]",
		]);

		const result = await streamOpenAICompletions(model, baseContext(), { apiKey: "test-key" }).result();

		expect(result.stopReason).toBe("stop");
		expect(result.usage.totalTokens).toBe(2);
		expect(result.transportFailure).toBeUndefined();
	});

	it("does not let duplicate zero usage erase earlier nonzero evidence", async () => {
		const model = createEmptyResponseModel();
		global.fetch = createMockFetch([
			{
				id: "chatcmpl-nonzero-first",
				object: "chat.completion.chunk",
				created: 0,
				model: model.id,
				choices: [],
				usage: { prompt_tokens: 1, completion_tokens: 1 },
			},
			{
				id: "chatcmpl-zero-last",
				object: "chat.completion.chunk",
				created: 0,
				model: model.id,
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
				usage: { prompt_tokens: 0, completion_tokens: 0 },
			},
			"[DONE]",
		]);

		const result = await streamOpenAICompletions(model, baseContext(), { apiKey: "test-key" }).result();

		expect(result.stopReason).toBe("stop");
		expect(result.usage).toMatchObject({ input: 1, output: 1, totalTokens: 2 });
		expect(result.transportFailure).toBeUndefined();
	});

	it("maps qwen chat template reasoning into chat_template_kwargs", async () => {
		const model: Model<"openai-completions"> = {
			...getBundledModel("openai", "gpt-4o-mini"),
			api: "openai-completions",
			reasoning: true,
			compat: {
				supportsReasoningEffort: true,
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
	it("maps oMLX reasoning effort into chat_template_kwargs.reasoning_effort", async () => {
		const model: Model<"openai-completions"> = {
			...getBundledModel("openai", "gpt-4o-mini"),
			api: "openai-completions",
			provider: "omlx",
			id: "Qwen3.6-35B-A3B-8bit",
			reasoning: true,
			compat: {
				thinkingFormat: "qwen-chat-template",
				supportsReasoningEffort: true,
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
		expect(getNestedString(chatTemplateArgs, "reasoning_effort")).toBe("high");
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
	it("preserves duplicate endpoint query parameters across SDK requests", async () => {
		const model: Model<"openai-completions"> = {
			...getBundledModel("openai", "gpt-4o-mini"),
			api: "openai-completions",
			provider: "custom" as Model["provider"],
			baseUrl: "https://example.invalid/v1?scope=read&scope=write&sig=a%2fb%20c",
		};
		const requests: string[] = [];
		let attempt = 0;
		const fetch = Object.assign(
			async (input: string | URL | Request): Promise<Response> => {
				requests.push(input instanceof Request ? input.url : String(input));
				attempt++;
				if (attempt === 1) {
					return new Response("retry", { status: 500, headers: { "retry-after-ms": "0" } });
				}
				return createSuccessfulCompletionResponse();
			},
			{ preconnect: originalFetch.preconnect },
		);

		const result = await streamOpenAICompletions(model, baseContext(), {
			apiKey: "test-key",
			fetch,
			requestMaxRetries: 1,
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(requests).toHaveLength(2);
		for (const request of requests) {
			expect(new URL(request).searchParams.getAll("scope")).toEqual(["read", "write"]);
			expect(request).toContain("sig=a%2fb%20c");
		}
	});
	it("preserves a percent-encoded explicit Azure API version from the endpoint", async () => {
		const model: Model<"openai-completions"> = {
			...getBundledModel("openai", "gpt-4o-mini"),
			api: "openai-completions",
			provider: "custom" as Model["provider"],
			baseUrl: "https://example.openai.azure.com/openai/v1?api%2Dversion=2025-04-01-preview",
		};
		const requests: string[] = [];
		const fetch = Object.assign(
			async (input: string | URL | Request): Promise<Response> => {
				requests.push(input instanceof Request ? input.url : String(input));
				return createSuccessfulCompletionResponse();
			},
			{ preconnect: originalFetch.preconnect },
		);

		const result = await streamOpenAICompletions(model, baseContext(), { apiKey: "test-key", fetch }).result();

		expect(result.stopReason).toBe("stop");
		expect(requests).toHaveLength(1);
		expect(new URL(requests[0]!).searchParams.getAll("api-version")).toEqual(["2025-04-01-preview"]);
		expect(requests[0]).toContain("?api%2Dversion=2025-04-01-preview");
	});
	it("appends the default Azure API version after endpoint query entries", async () => {
		const model: Model<"openai-completions"> = {
			...getBundledModel("openai", "gpt-4o-mini"),
			api: "openai-completions",
			provider: "custom" as Model["provider"],
			baseUrl: "https://example.openai.azure.com/openai/v1?scope=read&scope=write",
		};
		const requests: string[] = [];
		const fetch = Object.assign(
			async (input: string | URL | Request): Promise<Response> => {
				requests.push(input instanceof Request ? input.url : String(input));
				return createSuccessfulCompletionResponse();
			},
			{ preconnect: originalFetch.preconnect },
		);

		const result = await streamOpenAICompletions(model, baseContext(), { apiKey: "test-key", fetch }).result();

		expect(result.stopReason).toBe("stop");
		expect(requests).toHaveLength(1);
		expect(new URL(requests[0]!).search).toStartWith("?scope=read&scope=write&api-version=");
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
		modelId = "kimi-k2.7-code",
	): Promise<Record<string, unknown>> {
		const tool: Tool = {
			name: "search",
			description: "Search test data",
			parameters: z.object({ query: z.string() }),
		};
		const { promise, resolve } = Promise.withResolvers<unknown>();
		streamOpenAICompletions(
			getBundledModel("opencode-go", modelId) as Model<"openai-completions">,
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
	it("captures OpenCode Go Kimi effort gaps and forced tool_choice support per variant", () => {
		const cases = [
			{ id: "kimi-k2.5", effortMap: { minimal: "low" } },
			{ id: "kimi-k2.6", effortMap: {} },
			{ id: "kimi-k2.7-code", effortMap: { xhigh: "high", max: "high" } },
		] as const;

		for (const { id, effortMap } of cases) {
			const model = getBundledModel("opencode-go", id);
			expect(model.provider).toBe("opencode-go");
			expect(model.reasoning).toBe(true);

			const compat = detectCompat(model as Model<"openai-completions">);

			expect(compat.reasoningEffortMap).toEqual(expect.objectContaining(effortMap));
			expect(compat.disableReasoningOnForcedToolChoice).toBe(true);
			expect(compat.supportsForcedToolChoice).toBe(false);
		}
	});

	it("omits forced tool_choice for every OpenCode Go Kimi payload", async () => {
		for (const modelId of ["kimi-k2.5", "kimi-k2.6", "kimi-k2.7-code"]) {
			const payload = await captureOpenCodeGoPayload(
				{
					reasoning: "high",
					toolChoice: { type: "function", function: { name: "search" } },
				},
				modelId,
			);

			expect(payload.tools).toBeDefined();
			expect(payload.tool_choice).toBeUndefined();
			expect(payload.reasoning_effort).toBe("high");
		}
	});

	it("preserves reasoning for OpenCode Go auto tool_choice payloads", async () => {
		const payload = await captureOpenCodeGoPayload({ reasoning: "high", toolChoice: "auto" });

		expect(payload.tools).toBeDefined();
		expect(payload.tool_choice).toBe("auto");
		expect(payload.reasoning_effort).toBe("high");
	});

	it("maps only the OpenCode Go Kimi efforts rejected in live probes", async () => {
		const k25MinimalPayload = await captureOpenCodeGoPayload(
			{ reasoning: "minimal", toolChoice: "auto" },
			"kimi-k2.5",
		);
		const k25MaxPayload = await captureOpenCodeGoPayload({ reasoning: "max", toolChoice: "auto" }, "kimi-k2.5");
		const k26MaxPayload = await captureOpenCodeGoPayload({ reasoning: "max", toolChoice: "auto" }, "kimi-k2.6");
		const k27XhighPayload = await captureOpenCodeGoPayload({ reasoning: "xhigh", toolChoice: "auto" });
		const k27MaxPayload = await captureOpenCodeGoPayload({ reasoning: "max", toolChoice: "auto" });

		expect(k25MinimalPayload.reasoning_effort).toBe("low");
		expect(k25MaxPayload.reasoning_effort).toBe("max");
		expect(k26MaxPayload.reasoning_effort).toBe("max");
		expect(k27XhighPayload.reasoning_effort).toBe("high");
		expect(k27MaxPayload.reasoning_effort).toBe("high");
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

describe("DeepSeek strict mode via OpenRouter", () => {
	function deepseekModel(overrides: Partial<Model<"openai-completions">> = {}): Model<"openai-completions"> {
		return {
			...getBundledModel("openai", "gpt-4o-mini"),
			api: "openai-completions",
			id: "deepseek/deepseek-v4-pro",
			reasoning: true,
			...overrides,
		} as Model<"openai-completions">;
	}

	it("disables strict mode for DeepSeek V4 via OpenRouter", () => {
		const model = deepseekModel({
			provider: "openrouter",
			baseUrl: "https://openrouter.ai/api/v1",
		});
		const compat = detectCompat(model);
		expect(compat.supportsStrictMode).toBe(false);
	});

	it("disables strict mode for DeepSeek V4 flash via OpenRouter", () => {
		const model = deepseekModel({
			provider: "openrouter",
			baseUrl: "https://openrouter.ai/api/v1",
			id: "deepseek/deepseek-v4-flash",
		});
		const compat = detectCompat(model);
		expect(compat.supportsStrictMode).toBe(false);
	});

	it("keeps strict mode enabled for non-DeepSeek models via OpenRouter", () => {
		const model = deepseekModel({
			provider: "openrouter",
			baseUrl: "https://openrouter.ai/api/v1",
			id: "anthropic/claude-sonnet-4-20250514",
		});
		const compat = detectCompat(model);
		expect(compat.supportsStrictMode).toBe(true);
	});

	it("keeps strict mode enabled for GPT via OpenRouter", () => {
		const model = deepseekModel({
			provider: "openrouter",
			baseUrl: "https://openrouter.ai/api/v1",
			id: "openai/gpt-5",
		});
		const compat = detectCompat(model);
		expect(compat.supportsStrictMode).toBe(true);
	});

	it("keeps strict mode enabled for DeepSeek direct API", () => {
		const model = deepseekModel({
			provider: "deepseek",
			baseUrl: "https://api.deepseek.com/v1",
			id: "deepseek-chat",
		});
		const compat = detectCompat(model);
		expect(compat.supportsStrictMode).toBe(true);
	});

	it("keeps strict mode disabled for DeepSeek via NVIDIA NIM (nvidia does not support strict)", () => {
		const model = deepseekModel({
			provider: "nvidia",
			baseUrl: "https://integrate.api.nvidia.com/v1",
			id: "deepseek-ai/deepseek-v4-flash",
		});
		const compat = detectCompat(model);
		expect(compat.supportsStrictMode).toBe(false);
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
