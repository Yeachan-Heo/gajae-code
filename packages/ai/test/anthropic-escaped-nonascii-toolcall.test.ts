import { afterEach, describe, expect, it, vi } from "bun:test";
import { Messages } from "@anthropic-ai/sdk/resources/messages/messages";
import { streamAnthropic } from "../src/providers/anthropic";
import type { AssistantMessage, Context, Model, ToolCall } from "../src/types";

const model: Model<"anthropic-messages"> = {
	id: "claude-sonnet-4-5",
	name: "Claude Sonnet 4.5",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8_192,
};

const context: Context = {
	messages: [{ role: "user", content: "Ask me something", timestamp: Date.now() }],
};

type MockAnthropicEvent = Record<string, unknown>;

function createMockRequest(events: MockAnthropicEvent[]) {
	const response = new Response(null, { status: 200, headers: { "request-id": "req_mock" } });
	const stream = {
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

function script(partialJson: string): MockAnthropicEvent[] {
	return [
		{
			type: "message_start",
			message: {
				id: "msg_escape",
				usage: {
					input_tokens: 1,
					output_tokens: 0,
					cache_read_input_tokens: 0,
					cache_creation_input_tokens: 0,
				},
			},
		},
		{
			type: "content_block_start",
			index: 0,
			content_block: { type: "tool_use", id: "tc-1", name: "ask", input: {} },
		},
		{ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: partialJson } },
		{ type: "content_block_stop", index: 0 },
		{ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 1 } },
		{ type: "message_stop" },
	];
}

async function run(events: MockAnthropicEvent[]): Promise<AssistantMessage> {
	vi.spyOn(Messages.prototype, "create").mockImplementation(() => createMockRequest(events) as never);
	const stream = streamAnthropic(model, context, { apiKey: "sk-ant-test", requestMaxRetries: 0, streamMaxRetries: 0 });
	for await (const _event of stream) {
		// Drain the provider stream.
	}
	return stream.result();
}

function toolCalls(message: AssistantMessage): ToolCall[] {
	return message.content.filter((block): block is ToolCall => block.type === "toolCall");
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("Anthropic ASCII-escaped non-ASCII tool arguments", () => {
	it("accepts a call whose arguments spell Hangul as \\uXXXX escapes", async () => {
		const result = await run(script(String.raw`{"question":"\ub9c8\uc9c0\ub9c9 \ubcd1\ubaa9"}`));
		const [tool] = toolCalls(result);

		expect(tool?.arguments).toEqual({ question: "마지막 병목" });
		expect(tool?.escapedNonAsciiArguments).toBeUndefined();
		expect(tool?.escapedUnicodeArgumentEvidence).toBeUndefined();
		expect(tool && "partialJson" in tool).toBe(false);
	});

	it("accepts printable ASCII escapes", async () => {
		const result = await run(script(String.raw`{"question":"\u0077 \u0026"}`));
		const [tool] = toolCalls(result);

		expect(tool?.arguments).toEqual({ question: "w &" });
		expect(tool?.escapedNonAsciiArguments).toBeUndefined();
		expect(tool?.escapedUnicodeArgumentEvidence).toBeUndefined();
	});

	it("retains non-enumerable guard evidence for an unpaired surrogate", async () => {
		const result = await run(script(String.raw`{"question":"\ud83d"}`));
		const [tool] = toolCalls(result);

		expect(tool?.arguments).toEqual({ question: String.fromCharCode(0xd83d) });
		expect(tool?.escapedNonAsciiArguments).toBe(true);
		expect(tool?.escapedUnicodeArgumentEvidence).toMatchObject({ malformed: true });
		expect(JSON.stringify(tool)).not.toContain("escapedUnicodeArgumentEvidence");
		expect(tool ? Object.keys(tool) : []).not.toContain("escapedUnicodeArgumentEvidence");
	});

	it("does not flag literal UTF-8 arguments", async () => {
		const result = await run(script('{"question":"마지막 병목"}'));

		expect(toolCalls(result)[0]?.escapedNonAsciiArguments).toBeUndefined();
	});

	it("does not flag an escaped backslash that is the written source text", async () => {
		const result = await run(script(String.raw`{"question":"if c == \\uac00:"}`));

		expect(toolCalls(result)[0]?.arguments).toEqual({ question: String.raw`if c == \uac00:` });
		expect(toolCalls(result)[0]?.escapedNonAsciiArguments).toBeUndefined();
	});
});
