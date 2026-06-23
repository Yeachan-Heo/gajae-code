import { describe, expect, test } from "bun:test";
import { processResponsesStream } from "@gajae-code/ai/providers/openai-responses-shared";
import type { AssistantMessage, Model, ToolCall } from "@gajae-code/ai/types";
import { isCompleteJson } from "@gajae-code/ai/utils/json-parse";
import type { ResponseStreamEvent } from "openai/resources/responses/responses";

// A response cut short for length (`incomplete`) can stop mid-tool-call. The
// streaming JSON parser repairs the partial arguments into a plausible-but-wrong
// object; the provider must flag such calls so the agent loop can reject them.

async function* makeStream(events: unknown[]): AsyncIterable<ResponseStreamEvent> {
	for (const e of events) yield e as ResponseStreamEvent;
}

function makeModel(): Model<"openai-responses"> {
	return {
		id: "test-model",
		name: "Test",
		api: "openai-responses",
		provider: "test-provider",
		baseUrl: "https://example.com/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 8192,
	};
}

function makeOutput(): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		timestamp: Date.now(),
		provider: "test-provider",
		model: "test-model",
		api: "openai-responses",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
	};
}

function makeCapture() {
	const emitted: Array<Record<string, unknown>> = [];
	const stream = { push: (e: Record<string, unknown>) => emitted.push(e), end: () => {} } as never;
	return { emitted, stream };
}

function toolBlocks(output: AssistantMessage): ToolCall[] {
	return output.content.filter(b => b.type === "toolCall") as ToolCall[];
}

describe("Responses provider: truncated tool-call detection", () => {
	test("flags a tool call whose arguments were cut off (status incomplete)", async () => {
		const events = [
			{
				type: "response.output_item.added",
				output_index: 0,
				item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "write_file", arguments: "" },
			},
			// Partial, structurally-incomplete JSON — the stream ends before it closes.
			{
				type: "response.function_call_arguments.delta",
				item_id: "fc_1",
				output_index: 0,
				delta: '{"path":"/etc/hosts","content":"line1\\nline2',
			},
			{
				type: "response.completed",
				response: { id: "resp_1", status: "incomplete", incomplete_details: { reason: "max_output_tokens" } },
			},
		];
		const output = makeOutput();
		const { stream } = makeCapture();
		await processResponsesStream(makeStream(events), output, stream, makeModel());

		expect(output.stopReason).toBe("length");
		const tools = toolBlocks(output);
		expect(tools).toHaveLength(1);
		expect(tools[0].name).toBe("write_file");
		expect(tools[0].incompleteArguments).toBe(true);
	});

	test("does NOT flag a completed tool call even if the turn later truncates", async () => {
		const events = [
			{
				type: "response.output_item.added",
				output_index: 0,
				item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "read_file", arguments: "" },
			},
			{ type: "response.function_call_arguments.delta", item_id: "fc_1", output_index: 0, delta: '{"path":"a.ts"}' },
			{
				type: "response.function_call_arguments.done",
				item_id: "fc_1",
				output_index: 0,
				arguments: '{"path":"a.ts"}',
			},
			{
				type: "response.output_item.done",
				output_index: 0,
				item: {
					type: "function_call",
					id: "fc_1",
					call_id: "call_1",
					name: "read_file",
					arguments: '{"path":"a.ts"}',
				},
			},
			{ type: "response.completed", response: { id: "resp_1", status: "incomplete" } },
		];
		const output = makeOutput();
		const { stream } = makeCapture();
		await processResponsesStream(makeStream(events), output, stream, makeModel());

		const tools = toolBlocks(output);
		expect(tools).toHaveLength(1);
		expect(tools[0].arguments).toEqual({ path: "a.ts" });
		expect(tools[0].incompleteArguments).toBeFalsy();
	});

	test("does NOT flag tool calls on a normally completed turn", async () => {
		const events = [
			{
				type: "response.output_item.added",
				output_index: 0,
				item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "read_file", arguments: "" },
			},
			{ type: "response.function_call_arguments.delta", item_id: "fc_1", output_index: 0, delta: '{"path":"a.ts"}' },
			{
				type: "response.output_item.done",
				output_index: 0,
				item: {
					type: "function_call",
					id: "fc_1",
					call_id: "call_1",
					name: "read_file",
					arguments: '{"path":"a.ts"}',
				},
			},
			{ type: "response.completed", response: { id: "resp_1", status: "completed" } },
		];
		const output = makeOutput();
		const { stream } = makeCapture();
		await processResponsesStream(makeStream(events), output, stream, makeModel());

		expect(output.stopReason).toBe("toolUse");
		expect(toolBlocks(output)[0].incompleteArguments).toBeFalsy();
	});

	test("flags a custom tool whose raw input was cut off (status incomplete)", async () => {
		const events = [
			{
				type: "response.output_item.added",
				output_index: 0,
				item: { type: "custom_tool_call", id: "ct_1", call_id: "call_1", name: "apply_patch", input: "" },
			},
			// Raw, non-JSON input that ends mid-stream.
			{
				type: "response.custom_tool_call_input.delta",
				item_id: "ct_1",
				output_index: 0,
				delta: "*** Begin Patch\n*** Update File: a.ts\n@@\n+const x =",
			},
			{ type: "response.completed", response: { id: "resp_1", status: "incomplete" } },
		];
		const output = makeOutput();
		const { stream } = makeCapture();
		await processResponsesStream(makeStream(events), output, stream, makeModel());

		expect(output.stopReason).toBe("length");
		const tools = toolBlocks(output);
		expect(tools).toHaveLength(1);
		expect(tools[0].customWireName).toBe("apply_patch");
		expect(tools[0].incompleteArguments).toBe(true);
	});

	test("does NOT flag a COMPLETED custom tool even when the turn truncates (no JSON false-positive)", async () => {
		// Regression: the raw custom-tool input is not valid JSON, so a naive
		// `isCompleteJson` check would wrongly flag a finished apply_patch call.
		const fullPatch = "*** Begin Patch\n*** Update File: a.ts\n@@\n+const x = 1\n*** End Patch";
		const events = [
			{
				type: "response.output_item.added",
				output_index: 0,
				item: { type: "custom_tool_call", id: "ct_1", call_id: "call_1", name: "apply_patch", input: "" },
			},
			{ type: "response.custom_tool_call_input.delta", item_id: "ct_1", output_index: 0, delta: fullPatch },
			{ type: "response.custom_tool_call_input.done", item_id: "ct_1", output_index: 0, input: fullPatch },
			{
				type: "response.output_item.done",
				output_index: 0,
				item: { type: "custom_tool_call", id: "ct_1", call_id: "call_1", name: "apply_patch", input: fullPatch },
			},
			// Turn truncated on trailing content AFTER the tool call finished.
			{ type: "response.completed", response: { id: "resp_1", status: "incomplete" } },
		];
		const output = makeOutput();
		const { stream } = makeCapture();
		await processResponsesStream(makeStream(events), output, stream, makeModel());

		const tools = toolBlocks(output);
		expect(tools).toHaveLength(1);
		expect(tools[0].arguments).toEqual({ input: fullPatch });
		expect(tools[0].incompleteArguments).toBeFalsy();
	});
});

describe("isCompleteJson", () => {
	test("treats empty / whitespace as complete (no-arg tools)", () => {
		expect(isCompleteJson("")).toBe(true);
		expect(isCompleteJson("   ")).toBe(true);
		expect(isCompleteJson(undefined)).toBe(true);
	});
	test("accepts well-formed JSON", () => {
		expect(isCompleteJson('{"a":1}')).toBe(true);
		expect(isCompleteJson("[1,2,3]")).toBe(true);
		expect(isCompleteJson('"str"')).toBe(true);
	});
	test("rejects truncated JSON", () => {
		expect(isCompleteJson('{"a":1')).toBe(false);
		expect(isCompleteJson('{"path":"/etc/hosts","content":"line1')).toBe(false);
		expect(isCompleteJson("[1,2,")).toBe(false);
	});
});
