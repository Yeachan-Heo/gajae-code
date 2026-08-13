import { afterEach, describe, expect, it, vi } from "bun:test";
import { Messages } from "@anthropic-ai/sdk/resources/messages/messages";
import * as utils from "@gajae-code/utils";
import { streamAnthropic } from "../src/providers/anthropic";
import type { AssistantMessageEvent, Context, Model } from "../src/types";

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
	messages: [{ role: "user", content: "Think", timestamp: Date.now() }],
};

type MockEvent = Record<string, unknown>;
type MockStream = AsyncIterable<MockEvent>;
type MockRequest = {
	withResponse(): Promise<{
		data: MockStream;
		response: Response;
		request_id: string | null;
	}>;
};

function mockRequest(events: MockEvent[]): MockRequest {
	const response = new Response(null, { status: 200, headers: { "request-id": "req_mock" } });
	const stream: MockStream = {
		async *[Symbol.asyncIterator]() {
			for (const event of events) yield event;
		},
	};
	return {
		async withResponse() {
			return { data: stream, response, request_id: response.headers.get("request-id") };
		},
	};
}

/**
 * Build a complete SSE event sequence that assembles an assistant message
 * whose content ends up with directly adjacent thinking blocks.
 */
function adjacentThinkingEvents(): MockEvent[] {
	return [
		{
			type: "message_start",
			message: {
				id: "msg_adj",
				usage: { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
			},
		},
		// First thinking block
		{ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "first reasoning" } },
		{ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig_alpha" } },
		{ type: "content_block_stop", index: 0 },
		// Second thinking block, DIRECTLY adjacent (no intervening tool_use/text)
		{ type: "content_block_start", index: 1, content_block: { type: "thinking", thinking: "" } },
		{ type: "content_block_delta", index: 1, delta: { type: "thinking_delta", thinking: "second reasoning" } },
		{ type: "content_block_delta", index: 1, delta: { type: "signature_delta", signature: "sig_beta" } },
		{ type: "content_block_stop", index: 1 },
		{
			type: "message_delta",
			delta: { stop_reason: "end_turn" },
			usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
		},
		{ type: "message_stop" },
	];
}

/**
 * Build a complete SSE event sequence where thinking blocks are separated
 * by a tool_use (ordinary interleaved-thinking shape).
 */
function interleavedThinkingEvents(): MockEvent[] {
	return [
		{
			type: "message_start",
			message: {
				id: "msg_interleaved",
				usage: { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
			},
		},
		{ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "reasoning" } },
		{ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig_alpha" } },
		{ type: "content_block_stop", index: 0 },
		// tool_use separates the two thinking blocks — this is interleaved shape, NOT adjacent
		{
			type: "content_block_start",
			index: 1,
			content_block: { type: "tool_use", id: "toolu_1", name: "read", input: {} },
		},
		{ type: "content_block_stop", index: 1 },
		{ type: "content_block_start", index: 2, content_block: { type: "thinking", thinking: "" } },
		{ type: "content_block_delta", index: 2, delta: { type: "thinking_delta", thinking: "more reasoning" } },
		{ type: "content_block_delta", index: 2, delta: { type: "signature_delta", signature: "sig_beta" } },
		{ type: "content_block_stop", index: 2 },
		{
			type: "message_delta",
			delta: { stop_reason: "tool_use" },
			usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
		},
		{ type: "message_stop" },
	];
}

/**
 * Build a complete SSE event sequence with a single thinking block (no adjacency).
 */
function singleThinkingEvents(): MockEvent[] {
	return [
		{
			type: "message_start",
			message: {
				id: "msg_single",
				usage: { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
			},
		},
		{ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "sole reasoning" } },
		{ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig_alpha" } },
		{ type: "content_block_stop", index: 0 },
		{ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "answer" } },
		{ type: "content_block_stop", index: 1 },
		{
			type: "message_delta",
			delta: { stop_reason: "end_turn" },
			usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
		},
		{ type: "message_stop" },
	];
}

async function drainStream(stream: ReturnType<typeof streamAnthropic>): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(event);
	await stream.result();
	return events;
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("anthropic stream-assembler adjacent-thinking diagnostic (#4443)", () => {
	it("warns once when a completed stream assembles adjacent thinking blocks", async () => {
		const warnSpy = vi.spyOn(utils.logger, "warn").mockImplementation(() => {});
		vi.spyOn(Messages.prototype, "create").mockImplementation(() => mockRequest(adjacentThinkingEvents()) as never);

		await drainStream(streamAnthropic(model, context, { apiKey: "sk-ant-test" }));

		const adjacentWarn = warnSpy.mock.calls.find(
			([message]) => typeof message === "string" && message.includes("adjacent thinking blocks"),
		);
		expect(adjacentWarn).toBeDefined();
		const metadata = adjacentWarn![1] as Record<string, unknown>;
		// Envelope shape only — never raw thinking text, signatures, or payloads
		expect(metadata).toHaveProperty("contentBlockCount", 2);
		expect(metadata).toHaveProperty("hasAdjacentPrivateBlocks", true);
		expect(metadata).toHaveProperty("model");
		expect(metadata).toHaveProperty("provider");
		expect(JSON.stringify(metadata)).not.toContain("first reasoning");
		expect(JSON.stringify(metadata)).not.toContain("second reasoning");
		expect(JSON.stringify(metadata)).not.toContain("sig_alpha");
		expect(JSON.stringify(metadata)).not.toContain("sig_beta");
	});

	it("does not warn when thinking blocks are separated by a tool_use (interleaved)", async () => {
		const warnSpy = vi.spyOn(utils.logger, "warn").mockImplementation(() => {});
		vi.spyOn(Messages.prototype, "create").mockImplementation(
			() => mockRequest(interleavedThinkingEvents()) as never,
		);

		await drainStream(streamAnthropic(model, context, { apiKey: "sk-ant-test" }));

		const adjacentWarn = warnSpy.mock.calls.find(
			([message]) => typeof message === "string" && message.includes("adjacent thinking blocks"),
		);
		expect(adjacentWarn).toBeUndefined();
	});

	it("does not warn for a single thinking block (no adjacency)", async () => {
		const warnSpy = vi.spyOn(utils.logger, "warn").mockImplementation(() => {});
		vi.spyOn(Messages.prototype, "create").mockImplementation(() => mockRequest(singleThinkingEvents()) as never);

		await drainStream(streamAnthropic(model, context, { apiKey: "sk-ant-test" }));

		const adjacentWarn = warnSpy.mock.calls.find(
			([message]) => typeof message === "string" && message.includes("adjacent thinking blocks"),
		);
		expect(adjacentWarn).toBeUndefined();
	});
});
