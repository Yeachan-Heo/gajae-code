import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as z from "zod/v4";
import { getBundledModel } from "../src/models";
import { streamOpenAICompletions } from "../src/providers/openai-completions";
import type { AssistantMessage, Context, Model, Tool } from "../src/types";
import {
	clearToolChoiceIncapabilityRegistryForTests,
	getToolChoiceCapabilityOverride,
} from "../src/utils/tool-choice-capability";
import {
	collectEvents,
	createBaseModel,
	createErrorResponse,
	createSseResponse,
	expectSingleCleanFallbackEvents,
	testContext,
} from "./openai-tool-choice-test-helpers";

const originalFetch = global.fetch;

beforeEach(() => {
	clearToolChoiceIncapabilityRegistryForTests();
});

afterEach(() => {
	global.fetch = originalFetch;
});

function model(overrides: Partial<Model<"openai-completions">> = {}): Model<"openai-completions"> {
	return { ...createBaseModel("openai-completions"), ...overrides };
}

function okChunk(modelId: string): Response {
	return createSseResponse([
		{
			id: "chatcmpl-tool-choice",
			object: "chat.completion.chunk",
			created: 0,
			model: modelId,
			choices: [{ index: 0, delta: { content: "ok" } }],
		},
		{
			id: "chatcmpl-tool-choice",
			object: "chat.completion.chunk",
			created: 0,
			model: modelId,
			choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
		},
		"[DONE]",
	]);
}

describe("OpenAI completions tool choice capability", () => {
	it("passes through named tool_choice when named choices are supported", async () => {
		let payload: Record<string, unknown> | undefined;
		const testModel = model({ compat: { toolChoiceSupport: "named" } });
		global.fetch = Object.assign(
			async (_input: string | URL | Request, init?: RequestInit) => {
				payload = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
				return okChunk(testModel.id);
			},
			{ preconnect: originalFetch.preconnect },
		);

		const result = await streamOpenAICompletions(testModel, testContext, {
			apiKey: "test-key",
			toolChoice: { type: "function", function: { name: "search" } },
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(payload?.tool_choice).toEqual({ type: "function", function: { name: "search" } });
	});

	it("omits forced tool_choice but keeps tools when forced choices are unsupported", async () => {
		let payload: Record<string, unknown> | undefined;
		const testModel = model({ compat: { supportsForcedToolChoice: false } });
		global.fetch = Object.assign(
			async (_input: string | URL | Request, init?: RequestInit) => {
				payload = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
				return okChunk(testModel.id);
			},
			{ preconnect: originalFetch.preconnect },
		);

		await streamOpenAICompletions(testModel, testContext, {
			apiKey: "test-key",
			toolChoice: { type: "function", function: { name: "search" } },
		}).result();

		expect(payload?.tool_choice).toBeUndefined();
		expect(payload?.tools).toEqual(expect.any(Array));
		expect((payload?.tools as unknown[]).length).toBeGreaterThan(0);
	});

	it("retries once without forced tool_choice on semantic 400 and records runtime incapability", async () => {
		const bodies: Record<string, unknown>[] = [];
		const testModel = model({ id: "runtime-completions" });
		global.fetch = Object.assign(
			async (_input: string | URL | Request, init?: RequestInit) => {
				bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
				if (bodies.length === 1) {
					return createErrorResponse("tool_choice forces tool use is not compatible with this model");
				}
				return okChunk(testModel.id);
			},
			{ preconnect: originalFetch.preconnect },
		);

		const stream = streamOpenAICompletions(testModel, testContext, {
			apiKey: "test-key",
			toolChoice: { type: "function", function: { name: "search" } },
		});
		const events = await collectEvents(stream);
		const result = await stream.result();

		expect(result.stopReason).toBe("stop");
		expect(bodies).toHaveLength(2);
		expect(bodies[0]?.tool_choice).toEqual({ type: "function", function: { name: "search" } });
		expect(bodies[1]?.tool_choice).toBeUndefined();
		expect(bodies[1]?.tools).toEqual(expect.any(Array));
		expect(getToolChoiceCapabilityOverride(testModel)).toBe("auto");
		expectSingleCleanFallbackEvents(events);
	});

	it("propagates unrelated 400 without retry or registry mark", async () => {
		let calls = 0;
		const testModel = model({ id: "unrelated-completions" });
		global.fetch = Object.assign(
			async () => {
				calls += 1;
				return createErrorResponse("some other bad request");
			},
			{ preconnect: originalFetch.preconnect },
		);

		const result = await streamOpenAICompletions(testModel, testContext, {
			apiKey: "test-key",
			toolChoice: { type: "function", function: { name: "search" } },
		}).result();

		expect(calls).toBe(1);
		expect(result.stopReason).toBe("error");
		expect(getToolChoiceCapabilityOverride(testModel)).toBeUndefined();
	});
});

describe("OpenAI completions empty-tool choice serialization", () => {
	// #1227: Explicit tools: [] opts out; only undefined tools with history retains
	// the Anthropic-proxy tools: [] sentinel. Neither empty shape sends tool_choice.
	function abortedSignal(): AbortSignal {
		const controller = new AbortController();
		controller.abort();
		return controller.signal;
	}

	function bedrockModel(): Model<"openai-completions"> {
		return {
			...getBundledModel("openai", "gpt-4o-mini"),
			api: "openai-completions",
			id: "bedrock-claude-sonnet-4-6",
			name: "Bedrock Claude Sonnet 4.6 (LiteLLM)",
			provider: "litellm-bedrock",
			baseUrl: "https://example.test/v1",
		};
	}

	async function capturePayload(
		context: Context,
		opts: Parameters<typeof streamOpenAICompletions>[2],
	): Promise<Record<string, unknown>> {
		const { promise, resolve } = Promise.withResolvers<unknown>();
		streamOpenAICompletions(bedrockModel(), context, {
			...opts,
			apiKey: "test-key",
			signal: abortedSignal(),
			onPayload: payload => resolve(payload),
		});
		return (await promise) as Record<string, unknown>;
	}

	function assistantWithToolCall(): AssistantMessage {
		return {
			role: "assistant",
			content: [{ type: "toolCall", id: "call_1", name: "search", arguments: { q: "x" } }],
			api: "openai-completions",
			provider: "litellm-bedrock",
			model: "bedrock-claude-sonnet-4-6",
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

	const echoTool: Tool = {
		name: "echo",
		description: "Echo input",
		parameters: z.object({ text: z.string() }),
	};

	it("omits both tools and tool_choice when /btw passes empty tools + toolChoice none", async () => {
		// Mirrors AgentSession.runEphemeralTurn: context.tools = [] is explicit
		// (prevents tool-catalog leakage in IRC replies) and toolChoice = "none".
		// `[]` is truthy, so buildParams used to land in the `if (context.tools)`
		// branch and emit `"tools": []` on the wire — LiteLLM → Bedrock then
		// translated that into an empty `toolConfig` block and Bedrock rejected
		// the request whenever the conversation already held toolUse/toolResult
		// content. The `.length` guard now skips the branch on empty arrays so
		// the wire body carries no `tools` field at all, which is the only shape
		// every downstream proxy accepts.
		const body = await capturePayload(
			{
				messages: [{ role: "user", content: "what is X", timestamp: Date.now() }],
				tools: [],
			},
			{ toolChoice: "none" },
		);

		expect(body.tools).toBeUndefined();
		expect(body.tool_choice).toBeUndefined();
	});

	it("omits both tools and tool_choice when /btw passes empty tools + has tool history", async () => {
		// The critical /btw scenario: session already has tool history (prior agentic
		// turn) AND context.tools = []. After the .length guard skips the first branch,
		// the caller-opted-out case must NOT fall through to the hasToolHistory sentinel
		// — that would still emit `"tools": []` and cause the same Bedrock rejection.
		// The `context.tools === undefined` guard on the second branch ensures we only
		// inject the Anthropic-proxy sentinel when tools were omitted entirely.
		const body = await capturePayload(
			{
				messages: [
					{ role: "user", content: "search now", timestamp: Date.now() },
					assistantWithToolCall(),
					{
						role: "toolResult",
						toolCallId: "call_1",
						toolName: "search",
						content: [{ type: "text", text: "result" }],
						isError: false,
						timestamp: Date.now(),
					},
					{ role: "user", content: "btw what is X", timestamp: Date.now() },
				],
				tools: [], // explicit opt-out, as AgentSession.runEphemeralTurn does
			},
			{ toolChoice: "none" },
		);

		expect(body.tools).toBeUndefined();
		expect(body.tool_choice).toBeUndefined();
	});

	it("drops tool_choice when tool history is present without explicit tools", async () => {
		// hasToolHistory() branch: no context.tools, but messages contain a prior
		// assistant toolCall — buildParams injects `tools: []` for Anthropic-proxy
		// compat, and toolChoice="none" must still be stripped to keep LiteLLM from
		// emitting a malformed Bedrock toolConfig.
		const body = await capturePayload(
			{
				messages: [
					{ role: "user", content: "search now", timestamp: Date.now() },
					assistantWithToolCall(),
					{
						role: "toolResult",
						toolCallId: "call_1",
						toolName: "search",
						content: [{ type: "text", text: "result" }],
						isError: false,
						timestamp: Date.now(),
					},
					{ role: "user", content: "follow-up", timestamp: Date.now() },
				],
			},
			{ toolChoice: "none" },
		);

		expect(body.tools).toEqual([]);
		expect(body.tool_choice).toBeUndefined();
	});

	it("keeps tool_choice none when real tools are present", async () => {
		// Sanity: with non-empty tools, tool_choice="none" is legal Bedrock input
		// (toolConfig has entries) and must still be forwarded so the model knows
		// it should not call any tool this turn.
		const body = await capturePayload(
			{
				messages: [{ role: "user", content: "answer in prose", timestamp: Date.now() }],
				tools: [echoTool],
			},
			{ toolChoice: "none" },
		);

		expect(Array.isArray(body.tools)).toBe(true);
		expect((body.tools as unknown[]).length).toBe(1);
		expect(body.tool_choice).toBe("none");
	});
});
