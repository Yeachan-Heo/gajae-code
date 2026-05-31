import { describe, expect, it } from "bun:test";
import type Anthropic from "@anthropic-ai/sdk";
import { streamAnthropic } from "@gajae-code/ai/providers/anthropic";
import type { AssistantMessage, Context, Model, UserMessage } from "@gajae-code/ai/types";

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

type MockAnthropicEvent = Record<string, unknown>;
type MockAnthropicStream = AsyncIterable<MockAnthropicEvent>;
type MockAnthropicRequest = {
	withResponse(): Promise<{
		data: MockAnthropicStream;
		response: Response;
		request_id: string | null;
	}>;
};

function createSuccessfulRequest(): MockAnthropicRequest {
	const response = new Response(null, {
		status: 200,
		headers: { "request-id": "req_repair" },
	});
	const events: MockAnthropicEvent[] = [
		{
			type: "message_start",
			message: {
				id: "msg_repair_success",
				usage: {
					input_tokens: 1,
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
				input_tokens: 1,
				output_tokens: 1,
				cache_read_input_tokens: 0,
				cache_creation_input_tokens: 0,
			},
		},
		{ type: "message_stop" },
	];

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

function createAnthropicThinking400(): MockAnthropicRequest {
	return {
		async withResponse() {
			const error = new Error(
				"400 invalid_request_error: thinking blocks in the latest assistant message cannot be modified",
			);
			(error as { status?: number }).status = 400;
			throw error;
		},
	};
}

describe("Anthropic thinking replay repair retry", () => {
	it("retries once without latest assistant thinking blocks after the Anthropic 400 invariant error", async () => {
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
		const context: Context = {
			messages: [user, assistant, { ...user, content: "next prompt", timestamp: Date.now() + 1 }],
		};
		const requestBodies: unknown[] = [];
		let attempt = 0;
		const create = ((body: unknown) => {
			requestBodies.push(body);
			attempt += 1;
			return (attempt === 1 ? createAnthropicThinking400() : createSuccessfulRequest()) as never;
		}) as unknown as Anthropic["messages"]["create"];
		const client = { messages: { create } } as Anthropic;

		const result = await streamAnthropic(model, context, { client }).result();

		expect(result.stopReason).toBe("stop");
		expect(result.content).toEqual([{ type: "text", text: "recovered" }]);
		expect(requestBodies).toHaveLength(2);
		expect(JSON.stringify(requestBodies[0])).toContain("synthetic_sig");
		expect(JSON.stringify(requestBodies[1])).not.toContain("synthetic_sig");
		expect(JSON.stringify(requestBodies[1])).not.toContain("redacted_thinking");
		expect(JSON.stringify(requestBodies[1])).toContain("visible answer");
	});

	it("does not retry or scrub history for non-matching Anthropic 400 errors", async () => {
		const user: UserMessage = {
			role: "user",
			content: "continue",
			timestamp: Date.now(),
		};
		const assistant: AssistantMessage = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "synthetic thinking", thinkingSignature: "synthetic_sig" },
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
		const context: Context = {
			messages: [user, assistant, { ...user, content: "next prompt", timestamp: Date.now() + 1 }],
		};
		const requestBodies: unknown[] = [];
		const create = ((body: unknown) => {
			requestBodies.push(body);
			const error = new Error("400 invalid_request_error: max_tokens is too low");
			(error as { status?: number }).status = 400;
			throw error;
		}) as unknown as Anthropic["messages"]["create"];
		const client = { messages: { create } } as Anthropic;

		const result = await streamAnthropic(model, context, { client }).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorStatus).toBe(400);
		expect(result.errorMessage).toContain("max_tokens is too low");
		expect(requestBodies).toHaveLength(1);
		expect(JSON.stringify(requestBodies[0])).toContain("synthetic_sig");
	});
});
