import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type Anthropic from "@anthropic-ai/sdk";
import { streamAnthropic } from "../src/providers/anthropic";
import { streamOpenAICompletions } from "../src/providers/openai-completions";
import type { AssistantMessageEvent, Context, Model } from "../src/types";
import {
	clearToolChoiceIncapabilityRegistryForTests,
	getToolChoiceCapabilityOverride,
} from "../src/utils/tool-choice-capability";
import {
	collectEvents,
	createBaseModel,
	createErrorResponse,
	createSseResponse,
	testContext,
} from "./openai-tool-choice-test-helpers";

const originalFetch = global.fetch;

beforeEach(() => {
	vi.restoreAllMocks();
	clearToolChoiceIncapabilityRegistryForTests();
});

afterEach(() => {
	global.fetch = originalFetch;
});

function openaiModel(overrides: Partial<Model<"openai-completions">> = {}): Model<"openai-completions"> {
	return { ...createBaseModel("openai-completions"), ...overrides };
}

function openaiOkChunk(modelId: string, text = "recovered"): Response {
	return createSseResponse([
		{
			id: "chatcmpl-redteam",
			object: "chat.completion.chunk",
			created: 0,
			model: modelId,
			choices: [{ index: 0, delta: { content: text } }],
		},
		{
			id: "chatcmpl-redteam",
			object: "chat.completion.chunk",
			created: 0,
			model: modelId,
			choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
		},
		"[DONE]",
	]);
}

const anthropicModel: Model<"anthropic-messages"> = {
	id: "claude-redteam-a",
	name: "Claude Redteam A",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8_192,
};

const anthropicContext: Context = {
	messages: [{ role: "user", content: "Use the tool", timestamp: 0 }],
	tools: [
		{
			name: "resolve",
			description: "Resolve a task",
			parameters: {
				type: "object",
				properties: { action: { type: "string" } },
				required: ["action"],
			},
		},
	],
};

type MockAnthropicEvent = Record<string, unknown>;
type MockAnthropicRequest = {
	withResponse(): Promise<{
		data: AsyncIterable<MockAnthropicEvent>;
		response: Response;
		request_id: string | null;
	}>;
};

type MockAnthropicCreate = (params: unknown, options?: { signal?: AbortSignal }) => MockAnthropicRequest;

function createMockRequest(events: MockAnthropicEvent[]): MockAnthropicRequest {
	const response = new Response(null, { status: 200, headers: { "request-id": "req_redteam" } });
	return {
		async withResponse() {
			return {
				data: {
					async *[Symbol.asyncIterator]() {
						for (const event of events) yield event;
					},
				},
				response,
				request_id: response.headers.get("request-id"),
			};
		},
	};
}

function createRejectedMockRequest(error: Error): MockAnthropicRequest {
	return {
		async withResponse() {
			throw error;
		},
	};
}

function unsupportedForcedChoiceError(): Error {
	const error = new Error(
		'400 {"type":"error","error":{"type":"invalid_request_error","message":"tool_choice forces tool use is not compatible with this model"},"request_id":"req_redteam"}',
	);
	(error as Error & { status: number }).status = 400;
	return error;
}

function abortError(): Error {
	const error = new Error("Request was aborted");
	(error as Error & { name: string }).name = "AbortError";
	return error;
}

function anthropicSuccessEvents(text = "recovered"): MockAnthropicEvent[] {
	return [
		{
			type: "message_start",
			message: {
				id: "msg_redteam",
				usage: {
					input_tokens: 21,
					output_tokens: 0,
					cache_read_input_tokens: 0,
					cache_creation_input_tokens: 0,
				},
			},
		},
		{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
		{ type: "content_block_stop", index: 0 },
		{
			type: "message_delta",
			delta: { stop_reason: "end_turn" },
			usage: {
				input_tokens: 21,
				output_tokens: 7,
				cache_read_input_tokens: 0,
				cache_creation_input_tokens: 0,
			},
		},
		{ type: "message_stop" },
	];
}

function anthropicMidStreamErrorEvents(): MockAnthropicEvent[] {
	return [
		{
			type: "message_start",
			message: {
				id: "msg_midstream_error",
				usage: {
					input_tokens: 21,
					output_tokens: 0,
					cache_read_input_tokens: 0,
					cache_creation_input_tokens: 0,
				},
			},
		},
		{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "partial" } },
		{
			type: "error",
			error: {
				type: "invalid_request_error",
				message: "tool_choice forces tool use is not compatible with this model",
				status: 400,
			},
		},
	];
}

function mockAnthropicClient(create: MockAnthropicCreate): Anthropic {
	return { messages: { create } } as unknown as Anthropic;
}

function count(events: AssistantMessageEvent[], type: AssistantMessageEvent["type"]): number {
	return events.filter(event => event.type === type).length;
}

function eventTypes(events: AssistantMessageEvent[]): AssistantMessageEvent["type"][] {
	return events.map(event => event.type);
}

function expectFallbackOrdering(events: AssistantMessageEvent[], expectedText: string): void {
	expect(count(events, "start")).toBe(1);
	expect(events.filter(event => event.type === "done" || event.type === "error")).toHaveLength(1);
	expect(count(events, "done")).toBe(1);
	expect(count(events, "error")).toBe(0);
	expect(count(events, "toolChoiceIncapability")).toBe(1);
	expect(count(events, "text_start")).toBe(1);
	expect(count(events, "text_delta")).toBe(1);
	expect(count(events, "text_end")).toBe(1);
	const fallbackIndex = events.findIndex(event => event.type === "toolChoiceIncapability");
	const textStartIndex = events.findIndex(event => event.type === "text_start");
	const textDeltaIndex = events.findIndex(event => event.type === "text_delta");
	const doneIndex = events.findIndex(event => event.type === "done");
	expect(fallbackIndex).toBeLessThan(textStartIndex);
	expect(textStartIndex).toBeLessThan(textDeltaIndex);
	expect(textDeltaIndex).toBeLessThan(doneIndex);
	const fallbackEvent = events[fallbackIndex] as AssistantMessageEvent & { contentIndex?: number; partial?: unknown };
	expect(fallbackEvent.contentIndex).toBeUndefined();
	expect(fallbackEvent.partial).toBeUndefined();
	const visibleText = events
		.filter((event): event is Extract<AssistantMessageEvent, { type: "text_delta" }> => event.type === "text_delta")
		.map(event => event.delta)
		.join("");
	expect(visibleText).toBe(expectedText);
}

describe("forced tool_choice fallback red-team", () => {
	it("openai-completions retries exactly once on double forced-choice 400 and surfaces one terminal error", async () => {
		let calls = 0;
		const testModel = openaiModel({ id: "openai-double-failure" });
		global.fetch = Object.assign(
			async () => {
				calls += 1;
				return createErrorResponse("tool_choice forces tool use is not compatible with this model");
			},
			{ preconnect: originalFetch.preconnect },
		);

		const stream = streamOpenAICompletions(testModel, testContext, {
			apiKey: "test-key",
			toolChoice: { type: "function", function: { name: "search" } },
		});
		const events = await collectEvents(stream);
		const result = await stream.result();

		expect(calls).toBe(2);
		expect(count(events, "start")).toBe(0);
		expect(count(events, "toolChoiceIncapability")).toBe(1);
		expect(events.filter(event => event.type === "done" || event.type === "error")).toHaveLength(1);
		expect(count(events, "error")).toBe(1);
		expect(result.stopReason).toBe("error");
		expect(result.errorStatus).toBe(400);
		expect(result.errorMessage).toContain("tool_choice forces tool use");
		expect(getToolChoiceCapabilityOverride(testModel)).toBe("auto");
	});

	it("anthropic retries exactly once on double forced-choice 400 and surfaces one terminal error", async () => {
		let attempts = 0;
		const client = mockAnthropicClient(() => {
			attempts += 1;
			return createRejectedMockRequest(unsupportedForcedChoiceError());
		});

		const stream = streamAnthropic(anthropicModel, anthropicContext, {
			client,
			toolChoice: { type: "tool", name: "resolve" },
		});
		const events = await collectEvents(stream);
		const result = await stream.result();

		expect(attempts).toBe(2);
		expect(count(events, "start")).toBe(1);
		expect(count(events, "toolChoiceIncapability")).toBe(1);
		expect(events.filter(event => event.type === "done" || event.type === "error")).toHaveLength(1);
		expect(count(events, "error")).toBe(1);
		expect(result.stopReason).toBe("error");
		expect(result.errorStatus).toBe(400);
		expect(result.errorMessage).toContain("tool_choice forces tool use");
		expect(getToolChoiceCapabilityOverride(anthropicModel)).toBe("auto");
	});

	it("openai-completions fallback emits incapability before visible content and exactly one start/done", async () => {
		const bodies: Record<string, unknown>[] = [];
		const testModel = openaiModel({ id: "openai-ordering" });
		global.fetch = Object.assign(
			async (_input: string | URL | Request, init?: RequestInit) => {
				bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
				return bodies.length === 1
					? createErrorResponse("tool_choice forces tool use is not compatible with this model")
					: openaiOkChunk(testModel.id, "ordered");
			},
			{ preconnect: originalFetch.preconnect },
		);

		const stream = streamOpenAICompletions(testModel, testContext, {
			apiKey: "test-key",
			toolChoice: { type: "function", function: { name: "search" } },
		});
		const events = await collectEvents(stream);
		const result = await stream.result();

		expect(eventTypes(events)).toEqual([
			"toolChoiceIncapability",
			"start",
			"text_start",
			"text_delta",
			"text_end",
			"done",
		]);
		expect(result.stopReason).toBe("stop");
		expect(bodies[0]?.tool_choice).toEqual({ type: "function", function: { name: "search" } });
		expect(bodies[1]?.tool_choice).toBeUndefined();
		expectFallbackOrdering(events, "ordered");
	});

	it("anthropic fallback emits start, incapability, content, done with no visible fallback content", async () => {
		let attempts = 0;
		const client = mockAnthropicClient(() => {
			attempts += 1;
			return attempts === 1
				? createRejectedMockRequest(unsupportedForcedChoiceError())
				: createMockRequest(anthropicSuccessEvents("ordered"));
		});

		const stream = streamAnthropic(anthropicModel, anthropicContext, {
			client,
			toolChoice: { type: "tool", name: "resolve" },
		});
		const events = await collectEvents(stream);
		const result = await stream.result();

		expect(eventTypes(events)).toEqual([
			"start",
			"toolChoiceIncapability",
			"text_start",
			"text_delta",
			"text_end",
			"done",
		]);
		expect(result.stopReason).toBe("stop");
		expectFallbackOrdering(events, "ordered");
	});

	it("registry persistence skips a second openai-completions 400 round-trip for the same model", async () => {
		const bodies: Record<string, unknown>[] = [];
		const testModel = openaiModel({ id: "openai-registry-persistence" });
		global.fetch = Object.assign(
			async (_input: string | URL | Request, init?: RequestInit) => {
				bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
				return bodies.length === 1
					? createErrorResponse("tool_choice forces tool use is not compatible with this model")
					: openaiOkChunk(testModel.id, `ok-${bodies.length}`);
			},
			{ preconnect: originalFetch.preconnect },
		);

		await streamOpenAICompletions(testModel, testContext, {
			apiKey: "test-key",
			toolChoice: { type: "function", function: { name: "search" } },
		}).result();
		await streamOpenAICompletions(testModel, testContext, {
			apiKey: "test-key",
			toolChoice: { type: "function", function: { name: "search" } },
		}).result();

		expect(bodies).toHaveLength(3);
		expect(bodies[0]?.tool_choice).toEqual({ type: "function", function: { name: "search" } });
		expect(bodies[1]?.tool_choice).toBeUndefined();
		expect(bodies[2]?.tool_choice).toBeUndefined();
		expect(getToolChoiceCapabilityOverride(testModel)).toBe("auto");
	});

	it("anthropic mid-stream 400-looking error after visible content does not reset into fallback", async () => {
		let attempts = 0;
		const client = mockAnthropicClient(() => {
			attempts += 1;
			return createMockRequest(anthropicMidStreamErrorEvents());
		});

		const stream = streamAnthropic(anthropicModel, anthropicContext, {
			client,
			toolChoice: { type: "tool", name: "resolve" },
			streamMaxRetries: 0,
		});
		const events = await collectEvents(stream);
		const result = await stream.result();

		expect(attempts).toBe(1);
		expect(count(events, "toolChoiceIncapability")).toBe(0);
		expect(count(events, "text_delta")).toBe(1);
		expect(count(events, "error")).toBe(1);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("terminal stop signal");
		expect(getToolChoiceCapabilityOverride(anthropicModel)).toBeUndefined();
	});

	it("anthropic abort between first failure and retry exits without hanging", async () => {
		const abortController = new AbortController();
		let attempts = 0;
		const client = mockAnthropicClient((_params, options) => {
			attempts += 1;
			if (attempts === 1) return createRejectedMockRequest(unsupportedForcedChoiceError());
			return createRejectedMockRequest(
				options?.signal?.aborted ? abortError() : new Error("retry should be aborted"),
			);
		});

		const stream = streamAnthropic(anthropicModel, anthropicContext, {
			client,
			toolChoice: { type: "tool", name: "resolve" },
			signal: abortController.signal,
			onPayload: params => {
				if (attempts === 1) abortController.abort();
				return params;
			},
		});
		const events = await collectEvents(stream);
		const result = await stream.result();

		expect(attempts).toBe(2);
		expect(count(events, "toolChoiceIncapability")).toBe(1);
		expect(count(events, "error")).toBe(1);
		expect(result.stopReason).toBe("aborted");
		expect(result.errorMessage).toContain("Request was aborted");
	});

	it("runtime incapability is isolated by model id for openai-completions", async () => {
		const modelA = openaiModel({ id: "openai-isolated-a" });
		const modelB = openaiModel({ id: "openai-isolated-b" });
		const bodiesByModel = new Map<string, Record<string, unknown>[]>();
		global.fetch = Object.assign(
			async (_input: string | URL | Request, init?: RequestInit) => {
				const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
				const modelId = String(body.model);
				const bodies = bodiesByModel.get(modelId) ?? [];
				bodies.push(body);
				bodiesByModel.set(modelId, bodies);
				if (modelId === modelA.id && bodies.length === 1) {
					return createErrorResponse("tool_choice forces tool use is not compatible with this model");
				}
				return openaiOkChunk(modelId, modelId);
			},
			{ preconnect: originalFetch.preconnect },
		);

		await streamOpenAICompletions(modelA, testContext, {
			apiKey: "test-key",
			toolChoice: { type: "function", function: { name: "search" } },
		}).result();
		await streamOpenAICompletions(modelB, testContext, {
			apiKey: "test-key",
			toolChoice: { type: "function", function: { name: "search" } },
		}).result();

		expect(bodiesByModel.get(modelA.id)).toHaveLength(2);
		expect(bodiesByModel.get(modelA.id)?.[0]?.tool_choice).toEqual({
			type: "function",
			function: { name: "search" },
		});
		expect(bodiesByModel.get(modelA.id)?.[1]?.tool_choice).toBeUndefined();
		expect(bodiesByModel.get(modelB.id)).toHaveLength(1);
		expect(bodiesByModel.get(modelB.id)?.[0]?.tool_choice).toEqual({
			type: "function",
			function: { name: "search" },
		});
		expect(getToolChoiceCapabilityOverride(modelA)).toBe("auto");
		expect(getToolChoiceCapabilityOverride(modelB)).toBeUndefined();
	});
});
