import { describe, expect, test } from "bun:test";
import { processResponsesStream } from "@gajae-code/ai/providers/openai-responses-shared";
import type { AssistantMessage, Model, ToolCall } from "@gajae-code/ai/types";
import type { ResponseStreamEvent } from "openai/resources/responses/responses";

// Regression coverage for multi-tool-call stream correlation: when a single
// Responses API stream emits multiple tool-call items, each item's streamed
// argument deltas must accumulate against its own identity and never leak into
// an adjacent tool call. Tool names below are generic placeholders.

async function* makeStream(events: unknown[]): AsyncIterable<ResponseStreamEvent> {
	for (const e of events) yield e as ResponseStreamEvent;
}

function makeModel(): Model<"openai-responses"> {
	return {
		id: "test-model",
		name: "Test Model",
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

interface ToolCallEndEvent {
	type: "toolcall_end";
	contentIndex: number;
	toolCall: ToolCall;
}
function makeCapture() {
	const emitted: Array<Record<string, unknown>> = [];
	const stream = {
		push: (e: Record<string, unknown>) => emitted.push(e),
		end: () => {},
	} as never;
	return { emitted, stream };
}

function toolCallEnds(emitted: Array<Record<string, unknown>>): ToolCallEndEvent[] {
	return emitted.filter(e => e.type === "toolcall_end") as unknown as ToolCallEndEvent[];
}

function toolBlocks(output: AssistantMessage): Array<ToolCall & { partialJson?: string }> {
	return output.content.filter(b => b.type === "toolCall") as Array<ToolCall & { partialJson?: string }>;
}

describe("Responses multi-tool-call stream correlation", () => {
	test("interleaved argument deltas stay isolated per tool call", async () => {
		const events = [
			{
				type: "response.output_item.added",
				output_index: 0,
				item: { type: "function_call", id: "fc_a", call_id: "call_a", name: "alpha_tool", arguments: "" },
			},
			{
				type: "response.output_item.added",
				output_index: 1,
				item: { type: "function_call", id: "fc_b", call_id: "call_b", name: "beta_tool", arguments: "" },
			},
			{ type: "response.function_call_arguments.delta", item_id: "fc_a", output_index: 0, delta: '{"command"' },
			{ type: "response.function_call_arguments.delta", item_id: "fc_b", output_index: 1, delta: '{"path"' },
			{ type: "response.function_call_arguments.delta", item_id: "fc_a", output_index: 0, delta: ':"ls -la"}' },
			{ type: "response.function_call_arguments.delta", item_id: "fc_b", output_index: 1, delta: ':"/etc/hosts"}' },
			{
				type: "response.function_call_arguments.done",
				item_id: "fc_a",
				output_index: 0,
				arguments: '{"command":"ls -la"}',
			},
			{
				type: "response.function_call_arguments.done",
				item_id: "fc_b",
				output_index: 1,
				arguments: '{"path":"/etc/hosts"}',
			},
			{
				type: "response.output_item.done",
				output_index: 0,
				item: {
					type: "function_call",
					id: "fc_a",
					call_id: "call_a",
					name: "alpha_tool",
					arguments: '{"command":"ls -la"}',
				},
			},
			{
				type: "response.output_item.done",
				output_index: 1,
				item: {
					type: "function_call",
					id: "fc_b",
					call_id: "call_b",
					name: "beta_tool",
					arguments: '{"path":"/etc/hosts"}',
				},
			},
		];
		const output = makeOutput();
		const { emitted, stream } = makeCapture();
		await processResponsesStream(makeStream(events), output, stream, makeModel());

		const blocks = toolBlocks(output);
		expect(blocks).toHaveLength(2);
		expect(blocks[0]?.name).toBe("alpha_tool");
		expect(blocks[0]?.arguments).toEqual({ command: "ls -la" });
		expect(blocks[1]?.name).toBe("beta_tool");
		expect(blocks[1]?.arguments).toEqual({ path: "/etc/hosts" });

		const ends = toolCallEnds(emitted);
		const alpha = ends.find(e => e.toolCall.name === "alpha_tool");
		const beta = ends.find(e => e.toolCall.name === "beta_tool");
		expect(alpha?.toolCall.arguments).toEqual({ command: "ls -la" });
		expect(beta?.toolCall.arguments).toEqual({ path: "/etc/hosts" });
		expect(alpha?.contentIndex).toBe(0);
		expect(beta?.contentIndex).toBe(1);
	});

	test("back-to-back items finalize in order with per-item arguments", async () => {
		const events = [
			{
				type: "response.output_item.added",
				output_index: 0,
				item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "alpha_tool", arguments: "" },
			},
			{
				type: "response.output_item.added",
				output_index: 1,
				item: { type: "function_call", id: "fc_2", call_id: "call_2", name: "beta_tool", arguments: "" },
			},
			{ type: "response.function_call_arguments.delta", item_id: "fc_1", output_index: 0, delta: '{"x":1}' },
			{ type: "response.function_call_arguments.delta", item_id: "fc_2", output_index: 1, delta: '{"y":2}' },
			{
				type: "response.output_item.done",
				output_index: 0,
				item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "alpha_tool", arguments: '{"x":1}' },
			},
			{
				type: "response.output_item.done",
				output_index: 1,
				item: { type: "function_call", id: "fc_2", call_id: "call_2", name: "beta_tool", arguments: '{"y":2}' },
			},
		];
		const output = makeOutput();
		const { emitted, stream } = makeCapture();
		await processResponsesStream(makeStream(events), output, stream, makeModel());

		const blocks = toolBlocks(output);
		expect(blocks.map(b => b.name)).toEqual(["alpha_tool", "beta_tool"]);
		expect(blocks[0]?.arguments).toEqual({ x: 1 });
		expect(blocks[1]?.arguments).toEqual({ y: 2 });
		const ends = toolCallEnds(emitted);
		expect(ends.map(e => e.toolCall.name)).toEqual(["alpha_tool", "beta_tool"]);
	});

	test("each tool shape keeps its own fields with zero cross-leak", async () => {
		const specs = [
			{ id: "fc_bash", call: "c_bash", name: "bash_tool", args: { command: "echo hi" } },
			{ id: "fc_read", call: "c_read", name: "read_tool", args: { path: "/tmp/file.txt" } },
			{ id: "fc_search", call: "c_search", name: "search_tool", args: { pattern: "TODO", paths: ["src"] } },
			{ id: "fc_gh", call: "c_gh", name: "gh_tool", args: { op: "search_issues", query: "is:open" } },
		];
		const added = specs.map((s, i) => ({
			type: "response.output_item.added",
			output_index: i,
			item: { type: "function_call", id: s.id, call_id: s.call, name: s.name, arguments: "" },
		}));
		// Interleave the argument deltas across all four items.
		const deltas = specs.map((s, i) => ({
			type: "response.function_call_arguments.delta",
			item_id: s.id,
			output_index: i,
			delta: JSON.stringify(s.args),
		}));
		const dones = specs.map((s, i) => ({
			type: "response.output_item.done",
			output_index: i,
			item: { type: "function_call", id: s.id, call_id: s.call, name: s.name, arguments: JSON.stringify(s.args) },
		}));
		const events = [...added, ...deltas, ...dones];
		const output = makeOutput();
		const { stream } = makeCapture();
		await processResponsesStream(makeStream(events), output, stream, makeModel());

		const byName = new Map(toolBlocks(output).map(b => [b.name, b.arguments]));
		expect(byName.get("bash_tool")).toEqual({ command: "echo hi" });
		expect(byName.get("read_tool")).toEqual({ path: "/tmp/file.txt" });
		expect(byName.get("search_tool")).toEqual({ pattern: "TODO", paths: ["src"] });
		expect(byName.get("gh_tool")).toEqual({ op: "search_issues", query: "is:open" });
		// Explicit anti-leak assertions.
		expect((byName.get("bash_tool") as Record<string, unknown>).path).toBeUndefined();
		expect((byName.get("read_tool") as Record<string, unknown>).command).toBeUndefined();
		expect((byName.get("search_tool") as Record<string, unknown>).command).toBeUndefined();
		expect((byName.get("gh_tool") as Record<string, unknown>).pattern).toBeUndefined();
	});

	test("custom_tool_call interleaved with function_call keeps input and arguments separate", async () => {
		const events = [
			{
				type: "response.output_item.added",
				output_index: 0,
				item: { type: "custom_tool_call", id: "ctc", call_id: "c_custom", name: "apply_patch", input: "" },
			},
			{
				type: "response.output_item.added",
				output_index: 1,
				item: { type: "function_call", id: "fc", call_id: "c_fn", name: "alpha_tool", arguments: "" },
			},
			{ type: "response.custom_tool_call_input.delta", item_id: "ctc", output_index: 0, delta: "*** Begin" },
			{ type: "response.function_call_arguments.delta", item_id: "fc", output_index: 1, delta: '{"command"' },
			{ type: "response.custom_tool_call_input.delta", item_id: "ctc", output_index: 0, delta: " Patch ***" },
			{ type: "response.function_call_arguments.delta", item_id: "fc", output_index: 1, delta: ':"go"}' },
			{
				type: "response.custom_tool_call_input.done",
				item_id: "ctc",
				output_index: 0,
				input: "*** Begin Patch ***",
			},
			{
				type: "response.function_call_arguments.done",
				item_id: "fc",
				output_index: 1,
				arguments: '{"command":"go"}',
			},
			{
				type: "response.output_item.done",
				output_index: 0,
				item: {
					type: "custom_tool_call",
					id: "ctc",
					call_id: "c_custom",
					name: "apply_patch",
					input: "*** Begin Patch ***",
				},
			},
			{
				type: "response.output_item.done",
				output_index: 1,
				item: {
					type: "function_call",
					id: "fc",
					call_id: "c_fn",
					name: "alpha_tool",
					arguments: '{"command":"go"}',
				},
			},
		];
		const output = makeOutput();
		const { stream } = makeCapture();
		await processResponsesStream(makeStream(events), output, stream, makeModel());

		const blocks = toolBlocks(output);
		const custom = blocks.find(b => b.name === "apply_patch");
		const fn = blocks.find(b => b.name === "alpha_tool");
		expect(custom?.arguments).toEqual({ input: "*** Begin Patch ***" });
		expect(fn?.arguments).toEqual({ command: "go" });
	});

	test("single tool call streams unchanged with stable content index", async () => {
		const events = [
			{
				type: "response.output_item.added",
				output_index: 0,
				item: { type: "function_call", id: "fc_only", call_id: "call_only", name: "alpha_tool", arguments: "" },
			},
			{ type: "response.function_call_arguments.delta", item_id: "fc_only", output_index: 0, delta: '{"a"' },
			{ type: "response.function_call_arguments.delta", item_id: "fc_only", output_index: 0, delta: ":1}" },
			{ type: "response.function_call_arguments.done", item_id: "fc_only", output_index: 0, arguments: '{"a":1}' },
			{
				type: "response.output_item.done",
				output_index: 0,
				item: {
					type: "function_call",
					id: "fc_only",
					call_id: "call_only",
					name: "alpha_tool",
					arguments: '{"a":1}',
				},
			},
		];
		const output = makeOutput();
		const { emitted, stream } = makeCapture();
		await processResponsesStream(makeStream(events), output, stream, makeModel());

		const blocks = toolBlocks(output);
		expect(blocks).toHaveLength(1);
		expect(blocks[0]?.arguments).toEqual({ a: 1 });
		const ends = toolCallEnds(emitted);
		expect(ends).toHaveLength(1);
		expect(ends[0]?.contentIndex).toBe(0);
		expect(ends[0]?.toolCall.arguments).toEqual({ a: 1 });
	});

	test("late reasoning delta after a tool-call block targets the reasoning block", async () => {
		const events = [
			{
				type: "response.output_item.added",
				output_index: 0,
				item: { type: "reasoning", id: "r1", summary: [] },
			},
			{
				type: "response.reasoning_summary_part.added",
				item_id: "r1",
				output_index: 0,
				part: { type: "summary_text", text: "" },
			},
			// A tool-call block opens AFTER the reasoning block, so output.content[1] exists.
			{
				type: "response.output_item.added",
				output_index: 1,
				item: { type: "function_call", id: "fc_late", call_id: "call_late", name: "alpha_tool", arguments: "" },
			},
			// Late reasoning delta for the FIRST item must still target content index 0.
			{ type: "response.reasoning_summary_text.delta", item_id: "r1", output_index: 0, delta: "thinking..." },
			{
				type: "response.output_item.done",
				output_index: 0,
				item: { type: "reasoning", id: "r1", summary: [{ type: "summary_text", text: "thinking..." }] },
			},
			{ type: "response.function_call_arguments.delta", item_id: "fc_late", output_index: 1, delta: '{"z":9}' },
			{
				type: "response.output_item.done",
				output_index: 1,
				item: {
					type: "function_call",
					id: "fc_late",
					call_id: "call_late",
					name: "alpha_tool",
					arguments: '{"z":9}',
				},
			},
		];
		const output = makeOutput();
		const { emitted, stream } = makeCapture();
		await processResponsesStream(makeStream(events), output, stream, makeModel());

		// The reasoning summary delta and end must reference content index 0, not the tool block at index 1.
		// Under the #2304 provenance contract, `reasoning_summary_text.delta` routes to the
		// dedicated reasoning_summary_* channel (not thinking_delta), while still landing display
		// text on the reasoning block.
		const summaryDeltas = emitted.filter(e => e.type === "reasoning_summary_delta");
		expect(summaryDeltas.length).toBeGreaterThan(0);
		for (const d of summaryDeltas) {
			expect((d as { contentIndex: number }).contentIndex).toBe(0);
		}
		const summaryEnd = emitted.find(e => e.type === "reasoning_summary_end") as
			| { contentIndex: number; content: string }
			| undefined;
		expect(summaryEnd?.contentIndex).toBe(0);
		expect(summaryEnd?.content).toBe("thinking...");

		// output.content agrees: reasoning content landed on the reasoning block, tool args on the tool block.
		expect(output.content[0]?.type).toBe("thinking");
		expect((output.content[0] as { thinking: string }).thinking).toBe("thinking...");
		expect(output.content[1]?.type).toBe("toolCall");
		expect((output.content[1] as ToolCall).arguments).toEqual({ z: 9 });
	});

	test("tool-call deltas with no resolvable key are ignored without phantom blocks", async () => {
		const events = [
			{
				type: "response.output_item.added",
				output_index: 0,
				item: { type: "function_call", id: "fc_real", call_id: "call_real", name: "alpha_tool", arguments: "" },
			},
			{ type: "response.function_call_arguments.delta", item_id: "fc_real", output_index: 0, delta: '{"ok":1}' },
			// Unresolvable: unknown item_id AND non-finite output_index. Must be ignored.
			{ type: "response.function_call_arguments.delta", item_id: "ghost", delta: '{"leak":true}' },
			{ type: "response.function_call_arguments.done", item_id: "ghost", arguments: '{"leak":true}' },
			{ type: "response.custom_tool_call_input.delta", item_id: "ghost", delta: "noise" },
			{
				type: "response.output_item.done",
				output_index: 0,
				item: {
					type: "function_call",
					id: "fc_real",
					call_id: "call_real",
					name: "alpha_tool",
					arguments: '{"ok":1}',
				},
			},
		];
		const output = makeOutput();
		const { emitted, stream } = makeCapture();
		await processResponsesStream(makeStream(events), output, stream, makeModel());

		// Only the real tool call exists; the ghost events created no block and leaked nothing.
		const blocks = toolBlocks(output);
		expect(blocks).toHaveLength(1);
		expect(output.content).toHaveLength(1);
		expect(blocks[0]?.name).toBe("alpha_tool");
		expect(blocks[0]?.arguments).toEqual({ ok: 1 });
		const ends = toolCallEnds(emitted);
		expect(ends).toHaveLength(1);
		expect(ends[0]?.toolCall.arguments).toEqual({ ok: 1 });
	});

	test("legacy single continuation-style tool stream with no item_id/output_index still accumulates", async () => {
		// Sparse/continuation shape: a single tool item whose delta/done events omit
		// BOTH item_id and output_index. The most-recently-added entry must still
		// accumulate input and emit live toolcall_delta events (backward compatibility).
		const events = [
			{
				type: "response.output_item.added",
				item: { type: "custom_tool_call", id: "ctc_1", call_id: "call_1", name: "apply_patch", input: "" },
			},
			{ type: "response.custom_tool_call_input.delta", delta: "*** Begin Patch\n" },
			{ type: "response.custom_tool_call_input.delta", delta: "*** End Patch\n" },
			{ type: "response.custom_tool_call_input.done", input: "*** Begin Patch\n*** End Patch\n" },
			{
				type: "response.output_item.done",
				item: {
					type: "custom_tool_call",
					id: "ctc_1",
					call_id: "call_1",
					name: "apply_patch",
					input: "*** Begin Patch\n*** End Patch\n",
				},
			},
		];
		const output = makeOutput();
		const { emitted, stream } = makeCapture();
		await processResponsesStream(makeStream(events), output, stream, makeModel());

		const blocks = toolBlocks(output);
		expect(blocks).toHaveLength(1);
		expect(blocks[0]?.name).toBe("apply_patch");
		expect(blocks[0]?.arguments).toEqual({ input: "*** Begin Patch\n*** End Patch\n" });
		// Live delta accumulation must emit toolcall_delta events, not only finalize.
		const deltas = emitted.filter(e => e.type === "toolcall_delta");
		expect(deltas.length).toBeGreaterThan(0);
		const ends = toolCallEnds(emitted);
		expect(ends).toHaveLength(1);
		expect(ends[0]?.toolCall.arguments).toEqual({ input: "*** Begin Patch\n*** End Patch\n" });
	});

	test("function_call delta with no item_id/output_index accumulates onto the open item", async () => {
		const events = [
			{
				type: "response.output_item.added",
				item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "alpha_tool", arguments: "" },
			},
			{ type: "response.function_call_arguments.delta", delta: '{"command"' },
			{ type: "response.function_call_arguments.delta", delta: ':"go"}' },
			{ type: "response.function_call_arguments.done", arguments: '{"command":"go"}' },
			{
				type: "response.output_item.done",
				item: {
					type: "function_call",
					id: "fc_1",
					call_id: "call_1",
					name: "alpha_tool",
					arguments: '{"command":"go"}',
				},
			},
		];
		const output = makeOutput();
		const { emitted, stream } = makeCapture();
		await processResponsesStream(makeStream(events), output, stream, makeModel());

		const blocks = toolBlocks(output);
		expect(blocks).toHaveLength(1);
		expect(blocks[0]?.arguments).toEqual({ command: "go" });
		const deltas = emitted.filter(e => e.type === "toolcall_delta");
		expect(deltas.length).toBeGreaterThan(0);
	});
});
