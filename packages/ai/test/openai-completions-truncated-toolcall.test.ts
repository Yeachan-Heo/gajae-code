import { afterEach, describe, expect, it } from "bun:test";
import { streamOpenAICompletions } from "@gajae-code/ai/providers/openai-completions";
import type { Context, Model, ToolCall } from "@gajae-code/ai/types";

// finish_reason "length" can land mid-tool-call. The provider must flag the open
// call's truncated arguments so the agent loop rejects it rather than executing
// a best-effort partial parse.

const originalFetch = global.fetch;
afterEach(() => {
	global.fetch = originalFetch;
});

interface ToolCallDelta {
	index: number;
	id?: string;
	type?: "function";
	function?: { name?: string; arguments?: string };
}
interface SseChunk {
	id: string;
	object: "chat.completion.chunk";
	created: number;
	model: string;
	choices: Array<{
		index: number;
		delta: { content?: string; tool_calls?: ToolCallDelta[] };
		finish_reason?: "stop" | "length" | "tool_calls" | null;
	}>;
}

function sseResponse(events: ReadonlyArray<SseChunk | "[DONE]">): Response {
	const payload = `${events.map(e => `data: ${typeof e === "string" ? e : JSON.stringify(e)}`).join("\n\n")}\n\n`;
	return new Response(payload, { status: 200, headers: { "content-type": "text/event-stream" } });
}
function mockFetch(events: ReadonlyArray<SseChunk | "[DONE]">): typeof fetch {
	const fn = async (): Promise<Response> => sseResponse(events);
	return Object.assign(fn, { preconnect: originalFetch.preconnect });
}
function chunk(
	delta: SseChunk["choices"][0]["delta"],
	finish: SseChunk["choices"][0]["finish_reason"] = null,
): SseChunk {
	return {
		id: "chatcmpl-trunc",
		object: "chat.completion.chunk",
		created: 0,
		model: "test-model",
		choices: [{ index: 0, delta, finish_reason: finish }],
	};
}
function model(): Model<"openai-completions"> {
	return {
		id: "test-model",
		name: "Test",
		api: "openai-completions",
		provider: "test-provider",
		baseUrl: "https://example.com/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 8192,
	};
}
function context(): Context {
	return { messages: [{ role: "user", content: "go", timestamp: Date.now() }] };
}

describe("chat-completions: truncated tool-call detection", () => {
	it("flags a tool call whose arguments are cut off by finish_reason length", async () => {
		global.fetch = mockFetch([
			chunk({
				tool_calls: [
					{
						index: 0,
						id: "call_1",
						type: "function",
						function: { name: "write_file", arguments: '{"path":"a.ts","content":"hello' },
					},
				],
			}),
			chunk({}, "length"),
			"[DONE]",
		]);

		const result = await streamOpenAICompletions(model(), context(), { apiKey: "test" }).result();
		const tools = result.content.filter((b): b is ToolCall => b.type === "toolCall");
		expect(tools).toHaveLength(1);
		expect(tools[0].name).toBe("write_file");
		expect(tools[0].incompleteArguments).toBe(true);
		expect(result.stopReason).toBe("length");
	});

	it("does NOT flag a tool call whose arguments completed before length truncation", async () => {
		global.fetch = mockFetch([
			chunk({
				tool_calls: [
					{
						index: 0,
						id: "call_1",
						type: "function",
						function: { name: "read_file", arguments: '{"path":"a.ts"}' },
					},
				],
			}),
			// finish_reason length, but the args JSON is already complete.
			chunk({}, "length"),
			"[DONE]",
		]);

		const result = await streamOpenAICompletions(model(), context(), { apiKey: "test" }).result();
		const tools = result.content.filter((b): b is ToolCall => b.type === "toolCall");
		expect(tools).toHaveLength(1);
		expect(tools[0].arguments).toEqual({ path: "a.ts" });
		expect(tools[0].incompleteArguments).toBeFalsy();
	});

	it("does NOT flag a normally completed tool call", async () => {
		global.fetch = mockFetch([
			chunk({
				tool_calls: [
					{
						index: 0,
						id: "call_1",
						type: "function",
						function: { name: "read_file", arguments: '{"path":"a.ts"}' },
					},
				],
			}),
			chunk({}, "tool_calls"),
			"[DONE]",
		]);

		const result = await streamOpenAICompletions(model(), context(), { apiKey: "test" }).result();
		const tools = result.content.filter((b): b is ToolCall => b.type === "toolCall");
		expect(tools[0].incompleteArguments).toBeFalsy();
		expect(result.stopReason).toBe("toolUse");
	});
});
