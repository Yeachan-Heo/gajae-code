import { afterEach, describe, expect, it, vi } from "bun:test";
import { Messages } from "@anthropic-ai/sdk/resources/messages/messages";
import type { AssistantMessageEventStream, Message, Model } from "@gajae-code/ai";
import * as z from "zod/v4";
import { streamAnthropic } from "../../ai/src/providers/anthropic";
import type { Context as LocalContext, Model as LocalModel } from "../../ai/src/types";
import { agentLoop } from "../src/agent-loop";
import type { AgentContext, AgentLoopConfig, AgentMessage, AgentTool, StreamFn } from "../src/types";

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

function toolResponse(id: string, json: string, stopReason: "max_tokens" | "tool_use"): MockAnthropicEvent[] {
	return [
		messageStart(`msg_${id}`),
		{
			type: "content_block_start",
			index: 0,
			content_block: { type: "tool_use", id, name: "write_file", input: {} },
		},
		{
			type: "content_block_delta",
			index: 0,
			delta: { type: "input_json_delta", partial_json: json },
		},
		{ type: "content_block_stop", index: 0 },
		{ type: "message_delta", delta: { stop_reason: stopReason }, usage: { output_tokens: 1 } },
		{ type: "message_stop" },
	];
}

function duplicateToolResponse(id: string): MockAnthropicEvent[] {
	return [
		messageStart(`msg_${id}`),
		{
			type: "content_block_start",
			index: 0,
			content_block: { type: "tool_use", id, name: "write_file", input: {} },
		},
		{
			type: "content_block_delta",
			index: 0,
			delta: { type: "input_json_delta", partial_json: '{"path":"a.ts","content":"partial' },
		},
		{
			type: "content_block_start",
			index: 0,
			content_block: { type: "tool_use", id, name: "write_file", input: {} },
		},
		{
			type: "content_block_delta",
			index: 0,
			delta: { type: "input_json_delta", partial_json: '{"path":"b.ts","content":"ok"}' },
		},
		{ type: "content_block_stop", index: 0 },
		{ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 1 } },
		{ type: "message_stop" },
	];
}

function textResponse(text: string): MockAnthropicEvent[] {
	return [
		messageStart("msg_done"),
		{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
		{ type: "content_block_stop", index: 0 },
		{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
		{ type: "message_stop" },
	];
}

function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter(m => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[];
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("agentLoop with Anthropic truncated tool calls", () => {
	it("refuses the repaired partial call and executes a later complete call", async () => {
		const responses = [
			toolResponse("tool_truncated", '{"path":"a.ts","content":"line1', "max_tokens"),
			toolResponse("tool_complete", '{"path":"b.ts","content":"ok"}', "tool_use"),
			textResponse("done"),
		];
		let responseIndex = 0;
		const createSpy = vi.spyOn(Messages.prototype, "create").mockImplementation(() => {
			const events = responses[responseIndex];
			if (!events) throw new Error(`Unexpected Anthropic request ${responseIndex + 1}`);
			responseIndex++;
			return createMockRequest(events) as never;
		});

		const executed: Array<Record<string, unknown>> = [];
		const toolSchema = z.object({ path: z.string(), content: z.string() });
		const tool: AgentTool<typeof toolSchema, Record<string, never>> = {
			name: "write_file",
			label: "Write",
			description: "Write a file",
			parameters: toolSchema,
			async execute(_id, params) {
				executed.push(params as Record<string, unknown>);
				return { content: [{ type: "text", text: "wrote" }], details: {} };
			},
		};
		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [tool] };
		const config: AgentLoopConfig = { model, convertToLlm: identityConverter, fallbackManaged: true };
		const streamFn: StreamFn = (providerModel, providerContext, options) =>
			streamAnthropic(
				providerModel as unknown as LocalModel<"anthropic-messages">,
				providerContext as unknown as LocalContext,
				{ apiKey: "sk-ant-test", signal: options?.signal, fallbackManaged: options?.fallbackManaged },
			) as unknown as AssistantMessageEventStream;

		const toolResults: Array<{ isError?: boolean; text: string }> = [];
		const initialMessage: AgentMessage = { role: "user", content: "write the file", timestamp: Date.now() };
		const stream = agentLoop([initialMessage], context, config, undefined, streamFn);
		for await (const event of stream) {
			if (event.type === "tool_execution_end") {
				const first = event.result.content?.[0];
				toolResults.push({ isError: event.isError, text: first?.type === "text" ? first.text : "" });
			}
		}
		expect(responseIndex).toBe(responses.length);
		expect(createSpy).toHaveBeenCalledTimes(responses.length);

		expect(executed).toEqual([{ path: "b.ts", content: "ok" }]);
		expect(toolResults).toHaveLength(2);
		expect(toolResults[0].isError).toBe(true);
		expect(toolResults[0].text).toContain("cut off");
		expect(toolResults[0].text.toLowerCase()).toContain("re-issue");
		expect(toolResults[1]).toEqual({ isError: false, text: "wrote" });
	});

	it("executes only the complete same-ID replacement after a malformed duplicate index", async () => {
		const responses = [duplicateToolResponse("tool_shared"), textResponse("done")];
		let responseIndex = 0;
		vi.spyOn(Messages.prototype, "create").mockImplementation(() => {
			const events = responses[responseIndex];
			if (!events) throw new Error(`Unexpected Anthropic request ${responseIndex + 1}`);
			responseIndex++;
			return createMockRequest(events) as never;
		});

		const executed: Array<Record<string, unknown>> = [];
		const toolSchema = z.object({ path: z.string(), content: z.string() });
		const tool: AgentTool<typeof toolSchema, Record<string, never>> = {
			name: "write_file",
			label: "Write",
			description: "Write a file",
			parameters: toolSchema,
			async execute(_id, params) {
				executed.push(params as Record<string, unknown>);
				return { content: [{ type: "text", text: "wrote" }], details: {} };
			},
		};
		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [tool] };
		const config: AgentLoopConfig = { model, convertToLlm: identityConverter, fallbackManaged: true };
		const streamFn: StreamFn = (providerModel, providerContext, options) =>
			streamAnthropic(
				providerModel as unknown as LocalModel<"anthropic-messages">,
				providerContext as unknown as LocalContext,
				{ apiKey: "sk-ant-test", signal: options?.signal, fallbackManaged: options?.fallbackManaged },
			) as unknown as AssistantMessageEventStream;

		const toolResults: Array<{ isError?: boolean; text: string }> = [];
		const initialMessage: AgentMessage = { role: "user", content: "write the file", timestamp: Date.now() };
		const stream = agentLoop([initialMessage], context, config, undefined, streamFn);
		for await (const event of stream) {
			if (event.type === "tool_execution_end") {
				const first = event.result.content?.[0];
				toolResults.push({ isError: event.isError, text: first?.type === "text" ? first.text : "" });
			}
		}

		expect(responseIndex).toBe(2);
		expect(executed).toEqual([{ path: "b.ts", content: "ok" }]);
		expect(toolResults).toHaveLength(2);
		expect(toolResults[0].isError).toBe(true);
		expect(toolResults[0].text).toContain("cut off");
		expect(toolResults[1]).toEqual({ isError: false, text: "wrote" });
	});
});
