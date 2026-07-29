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
	messages: [{ role: "user", content: "Write the file", timestamp: Date.now() }],
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

function createMockRequest(events: MockAnthropicEvent[]): MockAnthropicRequest {
	const response = new Response(null, { status: 200, headers: { "request-id": "req_mock" } });
	const stream: MockAnthropicStream = {
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

function messageStart(id: string): MockAnthropicEvent {
	return {
		type: "message_start",
		message: {
			id,
			usage: {
				input_tokens: 1,
				output_tokens: 0,
				cache_read_input_tokens: 0,
				cache_creation_input_tokens: 0,
			},
		},
	};
}

function terminal(stopReason: "max_tokens" | "tool_use"): MockAnthropicEvent[] {
	return [
		{ type: "message_delta", delta: { stop_reason: stopReason }, usage: { output_tokens: 1 } },
		{ type: "message_stop" },
	];
}

function toolStart(index: number, id: string): MockAnthropicEvent {
	return {
		type: "content_block_start",
		index,
		content_block: { type: "tool_use", id, name: "write_file", input: {} },
	};
}

function toolDelta(index: number, partialJson: string): MockAnthropicEvent {
	return {
		type: "content_block_delta",
		index,
		delta: { type: "input_json_delta", partial_json: partialJson },
	};
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

describe("Anthropic truncated tool calls", () => {
	it("flags only the incomplete sibling when a max_tokens turn closes both blocks", async () => {
		const result = await run([
			messageStart("msg_siblings"),
			toolStart(0, "tool_truncated"),
			toolDelta(0, '{"path":"a.ts","content":"line1'),
			{ type: "content_block_stop", index: 0 },
			toolStart(1, "tool_complete"),
			toolDelta(1, '{"path":"b.ts"}'),
			{ type: "content_block_stop", index: 1 },
			...terminal("max_tokens"),
		]);

		const tools = toolCalls(result);
		expect(result.stopReason).toBe("length");
		expect(tools).toHaveLength(2);
		expect(tools[0].incompleteArguments).toBe(true);
		expect(tools[1].incompleteArguments).toBeFalsy();
	});

	it("finalizes and flags an open block without leaking stream fields", async () => {
		const result = await run([
			messageStart("msg_open"),
			toolStart(0, "tool_open"),
			toolDelta(0, '{"path":"a.ts","content":"line1'),
			...terminal("max_tokens"),
		]);

		const [tool] = toolCalls(result);
		expect(tool?.incompleteArguments).toBe(true);
		expect(tool && "partialJson" in tool).toBe(false);
		expect(tool && "index" in tool).toBe(false);
	});

	it("preserves truncation evidence when a duplicate index orphans a block", async () => {
		const result = await run([
			messageStart("msg_orphan"),
			toolStart(0, "tool_orphan"),
			toolDelta(0, '{"path":"a.ts","content":"line1'),
			toolStart(0, "tool_replacement"),
			toolDelta(0, '{"path":"b.ts"}'),
			{ type: "content_block_stop", index: 0 },
			...terminal("max_tokens"),
		]);

		const tools = toolCalls(result);
		expect(tools).toHaveLength(2);
		expect(tools[0].id).toBe("tool_orphan");
		expect(tools[0].incompleteArguments).toBe(true);
		expect(tools[1].incompleteArguments).toBeFalsy();
	});

	it("does not transfer orphan truncation state to a same-ID replacement", async () => {
		const result = await run([
			messageStart("msg_same_id_orphan"),
			toolStart(0, "tool_shared"),
			toolDelta(0, '{"path":"a.ts","content":"line1'),
			toolStart(0, "tool_shared"),
			toolDelta(0, '{"path":"b.ts"}'),
			{ type: "content_block_stop", index: 0 },
			...terminal("max_tokens"),
		]);

		const tools = toolCalls(result);
		expect(tools).toHaveLength(2);
		expect(tools[0].id).toBe("tool_shared");
		expect(tools[0].incompleteArguments).toBe(true);
		expect(tools[1].id).toBe("tool_shared");
		expect(tools[1].incompleteArguments).toBeFalsy();
	});

	it("keeps an incomplete same-ID orphan blocked on an explicit tool-use stop", async () => {
		const result = await run([
			messageStart("msg_same_id_tool_use"),
			toolStart(0, "tool_shared"),
			toolDelta(0, '{"path":"a.ts","content":"partial'),
			toolStart(0, "tool_shared"),
			toolDelta(0, '{"path":"b.ts","content":"ok"}'),
			{ type: "content_block_stop", index: 0 },
			...terminal("tool_use"),
		]);

		const tools = toolCalls(result);
		expect(tools).toHaveLength(2);
		expect(tools[0].arguments).toEqual({ path: "a.ts", content: "partial" });
		expect(tools[0].incompleteArguments).toBe(true);
		expect(tools[1].arguments).toEqual({ path: "b.ts", content: "ok" });
		expect(tools[1].incompleteArguments).toBeFalsy();
	});

	it("flags incomplete arguments when message_stop omits the terminal reason", async () => {
		const result = await run([
			messageStart("msg_missing_reason"),
			toolStart(0, "tool_missing_reason"),
			toolDelta(0, '{"path":"a.ts","content":"line1'),
			{ type: "content_block_stop", index: 0 },
			{ type: "message_stop" },
		]);

		expect(result.stopReason).toBe("stop");
		expect(toolCalls(result)[0]?.incompleteArguments).toBe(true);
	});

	it("rejects tool events that arrive after message_stop", async () => {
		const result = await run([
			messageStart("msg_post_terminal"),
			...terminal("tool_use"),
			toolStart(0, "tool_post_terminal"),
			toolDelta(0, '{"path":"a.ts"}'),
			{ type: "content_block_stop", index: 0 },
		]);

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("received event after message_stop");
		expect(toolCalls(result)).toHaveLength(0);
	});

	it("does not flag an empty argument buffer on a max_tokens turn", async () => {
		const result = await run([
			messageStart("msg_empty"),
			toolStart(0, "tool_empty"),
			{ type: "content_block_stop", index: 0 },
			...terminal("max_tokens"),
		]);

		expect(toolCalls(result)[0]?.incompleteArguments).toBeFalsy();
	});

	it("does not flag incomplete JSON when the turn ends for tool use", async () => {
		const result = await run([
			messageStart("msg_tool_use"),
			toolStart(0, "tool_use"),
			toolDelta(0, '{"path":"a.ts","content":"line1'),
			{ type: "content_block_stop", index: 0 },
			...terminal("tool_use"),
		]);

		expect(result.stopReason).toBe("toolUse");
		expect(toolCalls(result)[0]?.incompleteArguments).toBeFalsy();
	});

	it("finalizes but does not flag an open block when the turn ends for tool use", async () => {
		const result = await run([
			messageStart("msg_open_tool_use"),
			toolStart(0, "tool_open_use"),
			toolDelta(0, '{"path":"a.ts","content":"line1'),
			...terminal("tool_use"),
		]);

		const [tool] = toolCalls(result);
		expect(result.stopReason).toBe("toolUse");
		expect(tool?.incompleteArguments).toBeFalsy();
		expect(tool && "partialJson" in tool).toBe(false);
		expect(tool && "index" in tool).toBe(false);
	});
});
