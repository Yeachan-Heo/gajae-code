import { beforeEach, describe, expect, it, vi } from "bun:test";
import type Anthropic from "@anthropic-ai/sdk";
import { streamAnthropic } from "@gajae-code/ai/providers/anthropic";
import type { AssistantMessageEvent, Context, Model } from "@gajae-code/ai/types";
import {
	clearToolChoiceIncapabilityRegistryForTests,
	getToolChoiceCapabilityOverride,
} from "@gajae-code/ai/utils/tool-choice-capability";

const model: Model<"anthropic-messages"> = {
	id: "claude-sonnet-4-5",
	name: "Claude Sonnet 4.5",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8_192,
};

const context: Context = {
	messages: [{ role: "user", content: "Use the tool", timestamp: Date.now() }],
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

function createMockRequest(events: MockAnthropicEvent[]): MockAnthropicRequest {
	const response = new Response(null, { status: 200, headers: { "request-id": "req_mock" } });
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
		'400 {"type":"error","error":{"type":"invalid_request_error","message":"tool_choice forces tool use is not compatible with this model"},"request_id":"req_test"}',
	);
	(error as Error & { status: number }).status = 400;
	return error;
}

function unrelated400Error(): Error {
	const error = new Error(
		'400 {"type":"error","error":{"type":"invalid_request_error","message":"invalid request body"},"request_id":"req_test"}',
	);
	(error as Error & { status: number }).status = 400;
	return error;
}

function successEvents(): MockAnthropicEvent[] {
	return [
		{
			type: "message_start",
			message: {
				id: "msg_success",
				usage: {
					input_tokens: 21,
					output_tokens: 0,
					cache_read_input_tokens: 0,
					cache_creation_input_tokens: 0,
				},
			},
		},
		{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "recovered" } },
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

function count(events: AssistantMessageEvent[], type: AssistantMessageEvent["type"]): number {
	return events.filter(event => event.type === type).length;
}
function mockClient(create: (params: unknown) => MockAnthropicRequest): Anthropic {
	return { messages: { create } } as unknown as Anthropic;
}

beforeEach(() => {
	vi.restoreAllMocks();
	clearToolChoiceIncapabilityRegistryForTests();
});

describe("anthropic", () => {
	it("retries forced tool_choice 400s once without the forced field and emits a single terminal event", async () => {
		const requestBodies: Array<{ tool_choice?: unknown }> = [];
		let attempt = 0;
		const client = mockClient((params: unknown) => {
			attempt += 1;
			requestBodies.push(params as { tool_choice?: unknown });
			return attempt === 1
				? createRejectedMockRequest(unsupportedForcedChoiceError())
				: createMockRequest(successEvents());
		});

		const stream = streamAnthropic(model, context, {
			client,
			toolChoice: { type: "tool", name: "resolve" },
		});
		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) events.push(event);
		const result = await stream.result();

		expect(attempt).toBe(2);
		expect(requestBodies[0]?.tool_choice).toEqual({ type: "tool", name: "resolve" });
		expect(requestBodies[1]?.tool_choice).toBeUndefined();
		expect(count(events, "start")).toBe(1);
		expect(events.findIndex(event => event.type === "toolChoiceIncapability")).toBeLessThan(
			events.findIndex(event => event.type === "text_start"),
		);
		expect(count(events, "text_delta")).toBe(1);
		expect(count(events, "done")).toBe(1);
		expect(count(events, "error")).toBe(0);
		expect(getToolChoiceCapabilityOverride(model)).toBe("auto");
		expect(result.content).toEqual([{ type: "text", text: "recovered" }]);
		expect(result.usage.input).toBe(21);
		expect(result.usage.output).toBe(7);
	});

	it("propagates non-matching 400s without retrying or marking the registry", async () => {
		let attempt = 0;
		const client = mockClient(() => {
			attempt += 1;
			return createRejectedMockRequest(unrelated400Error());
		});

		const stream = streamAnthropic(model, context, {
			client,
			toolChoice: { type: "tool", name: "resolve" },
		});
		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) events.push(event);
		const result = await stream.result();

		expect(attempt).toBe(1);
		expect(count(events, "start")).toBe(1);
		expect(count(events, "toolChoiceIncapability")).toBe(0);
		expect(count(events, "done")).toBe(0);
		expect(count(events, "error")).toBe(1);
		expect(getToolChoiceCapabilityOverride(model)).toBeUndefined();
		expect(result.stopReason).toBe("error");
		expect(result.errorStatus).toBe(400);
		expect(result.errorMessage).toContain("invalid request body");
	});
});
