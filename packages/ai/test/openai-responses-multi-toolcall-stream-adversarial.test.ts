import { describe, expect, test } from "bun:test";
import { processResponsesStream } from "@gajae-code/ai/providers/openai-responses-shared";
import type { AssistantMessage, Model, ToolCall } from "@gajae-code/ai/types";
import type { ResponseStreamEvent } from "openai/resources/responses/responses";

// Adversarial red-team tests designed to expose cross-attribution bugs and
// content-index drift in the per-item correlation fix of processResponsesStream.
// Tool names are generic placeholders throughout.

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

describe("Adversarial Responses stream red-team", () => {
	// -----------------------------------------------------------------------
	// Case (a): THREE function_call items added in order; argument deltas
	// delivered in REVERSE/SHUFFLED item order with chunk boundaries that
	// split JSON mid-key.  Assert each finalized toolCall.arguments equals
	// its OWN intended object — no cross-item content leak.
	// -----------------------------------------------------------------------
	test("(a) three items, reversed/shuffled delta order with mid-key splits", async () => {
		const events = [
			// All three items added first (output_index 0, 1, 2).
			{
				type: "response.output_item.added",
				output_index: 0,
				item: { type: "function_call", id: "fc_alpha", call_id: "call_alpha", name: "alpha_tool", arguments: "" },
			},
			{
				type: "response.output_item.added",
				output_index: 1,
				item: { type: "function_call", id: "fc_bravo", call_id: "call_bravo", name: "bravo_tool", arguments: "" },
			},
			{
				type: "response.output_item.added",
				output_index: 2,
				item: {
					type: "function_call",
					id: "fc_charlie",
					call_id: "call_charlie",
					name: "charlie_tool",
					arguments: "",
				},
			},
			// Deltas for C first, then A, then B — all interleaved, mid-key splits.
			// charlie_tool target: {"mode":"strict","limit":5}
			{ type: "response.function_call_arguments.delta", item_id: "fc_charlie", output_index: 2, delta: '{"mo' },
			// alpha_tool target: {"command":"echo hello"}
			{ type: "response.function_call_arguments.delta", item_id: "fc_alpha", output_index: 0, delta: '{"com' },
			{
				type: "response.function_call_arguments.delta",
				item_id: "fc_charlie",
				output_index: 2,
				delta: 'de":"strict',
			},
			// bravo_tool target: {"path":"/var/log"}
			{ type: "response.function_call_arguments.delta", item_id: "fc_bravo", output_index: 1, delta: '{"pat' },
			{
				type: "response.function_call_arguments.delta",
				item_id: "fc_alpha",
				output_index: 0,
				delta: 'mand":"echo hello"}',
			},
			{
				type: "response.function_call_arguments.delta",
				item_id: "fc_charlie",
				output_index: 2,
				delta: '","limit":5}',
			},
			{
				type: "response.function_call_arguments.delta",
				item_id: "fc_bravo",
				output_index: 1,
				delta: 'h":"/var/log"}',
			},
			// done events
			{
				type: "response.function_call_arguments.done",
				item_id: "fc_charlie",
				output_index: 2,
				arguments: '{"mode":"strict","limit":5}',
			},
			{
				type: "response.function_call_arguments.done",
				item_id: "fc_alpha",
				output_index: 0,
				arguments: '{"command":"echo hello"}',
			},
			{
				type: "response.function_call_arguments.done",
				item_id: "fc_bravo",
				output_index: 1,
				arguments: '{"path":"/var/log"}',
			},
			// output_item.done in original order
			{
				type: "response.output_item.done",
				output_index: 0,
				item: {
					type: "function_call",
					id: "fc_alpha",
					call_id: "call_alpha",
					name: "alpha_tool",
					arguments: '{"command":"echo hello"}',
				},
			},
			{
				type: "response.output_item.done",
				output_index: 1,
				item: {
					type: "function_call",
					id: "fc_bravo",
					call_id: "call_bravo",
					name: "bravo_tool",
					arguments: '{"path":"/var/log"}',
				},
			},
			{
				type: "response.output_item.done",
				output_index: 2,
				item: {
					type: "function_call",
					id: "fc_charlie",
					call_id: "call_charlie",
					name: "charlie_tool",
					arguments: '{"mode":"strict","limit":5}',
				},
			},
		];

		const output = makeOutput();
		const { emitted, stream } = makeCapture();
		await processResponsesStream(makeStream(events), output, stream, makeModel());

		// --- output.content assertions ---
		const blocks = toolBlocks(output);
		expect(blocks).toHaveLength(3);

		const byName = new Map(blocks.map(b => [b.name, b.arguments as Record<string, unknown>]));
		// Each item must carry only its own args.
		expect(byName.get("alpha_tool")).toEqual({ command: "echo hello" });
		expect(byName.get("bravo_tool")).toEqual({ path: "/var/log" });
		expect(byName.get("charlie_tool")).toEqual({ mode: "strict", limit: 5 });
		// Anti-leak: no foreign keys
		expect(byName.get("alpha_tool")?.path).toBeUndefined();
		expect(byName.get("alpha_tool")?.mode).toBeUndefined();
		expect(byName.get("bravo_tool")?.command).toBeUndefined();
		expect(byName.get("bravo_tool")?.mode).toBeUndefined();
		expect(byName.get("charlie_tool")?.command).toBeUndefined();
		expect(byName.get("charlie_tool")?.path).toBeUndefined();

		// --- emitted toolcall_end assertions ---
		const ends = toolCallEnds(emitted);
		expect(ends).toHaveLength(3);
		const endByName = new Map(ends.map(e => [e.toolCall.name, e.toolCall.arguments as Record<string, unknown>]));
		expect(endByName.get("alpha_tool")).toEqual({ command: "echo hello" });
		expect(endByName.get("bravo_tool")).toEqual({ path: "/var/log" });
		expect(endByName.get("charlie_tool")).toEqual({ mode: "strict", limit: 5 });
		// Content indices must be distinct 0/1/2.
		const ciByName = new Map(ends.map(e => [e.toolCall.name, e.contentIndex]));
		expect(ciByName.get("alpha_tool")).toBe(0);
		expect(ciByName.get("bravo_tool")).toBe(1);
		expect(ciByName.get("charlie_tool")).toBe(2);
	});

	// -----------------------------------------------------------------------
	// Case (b): function_call_arguments.done is ABSENT; finalization happens
	// only via output_item.done.  The accumulated per-item partialJson buffer
	// (from deltas) must supply the arguments, not another item's buffer.
	// -----------------------------------------------------------------------
	test("(b) no function_call_arguments.done — output_item.done finalizes from per-item buffer", async () => {
		// Two items so we can verify the delta buffer of item 1 does NOT pollute item 2.
		const events = [
			{
				type: "response.output_item.added",
				output_index: 0,
				item: { type: "function_call", id: "fc_delta_only", call_id: "c_delta", name: "alpha_tool", arguments: "" },
			},
			{
				type: "response.output_item.added",
				output_index: 1,
				item: { type: "function_call", id: "fc_control", call_id: "c_ctrl", name: "bravo_tool", arguments: "" },
			},
			// Deltas for item 0 only — split mid-value
			{
				type: "response.function_call_arguments.delta",
				item_id: "fc_delta_only",
				output_index: 0,
				delta: '{"result"',
			},
			{ type: "response.function_call_arguments.delta", item_id: "fc_delta_only", output_index: 0, delta: ':"ok"}' },
			// NO function_call_arguments.done for fc_delta_only
			// Control item gets its done event
			{
				type: "response.function_call_arguments.done",
				item_id: "fc_control",
				output_index: 1,
				arguments: '{"ctrl":true}',
			},
			// output_item.done carries the canonical arguments (which should agree with per-item buffer)
			{
				type: "response.output_item.done",
				output_index: 0,
				item: {
					type: "function_call",
					id: "fc_delta_only",
					call_id: "c_delta",
					name: "alpha_tool",
					arguments: '{"result":"ok"}',
				},
			},
			{
				type: "response.output_item.done",
				output_index: 1,
				item: {
					type: "function_call",
					id: "fc_control",
					call_id: "c_ctrl",
					name: "bravo_tool",
					arguments: '{"ctrl":true}',
				},
			},
		];

		const output = makeOutput();
		const { emitted, stream } = makeCapture();
		await processResponsesStream(makeStream(events), output, stream, makeModel());

		// output.content blocks
		const blocks = toolBlocks(output);
		expect(blocks).toHaveLength(2);
		const alpha = blocks.find(b => b.name === "alpha_tool");
		const bravo = blocks.find(b => b.name === "bravo_tool");
		// alpha_tool must have its own accumulated args — not bravo's
		expect(alpha?.arguments).toEqual({ result: "ok" });
		expect(bravo?.arguments).toEqual({ ctrl: true });
		// Anti-leak
		expect((alpha?.arguments as Record<string, unknown>)?.ctrl).toBeUndefined();
		expect((bravo?.arguments as Record<string, unknown>)?.result).toBeUndefined();

		// Emitted toolcall_end events
		const ends = toolCallEnds(emitted);
		expect(ends).toHaveLength(2);
		const alphaEnd = ends.find(e => e.toolCall.name === "alpha_tool");
		const bravoEnd = ends.find(e => e.toolCall.name === "bravo_tool");
		expect(alphaEnd?.toolCall.arguments).toEqual({ result: "ok" });
		expect(bravoEnd?.toolCall.arguments).toEqual({ ctrl: true });
		// The stored block and emitted event must agree for item 0
		expect(alpha?.arguments).toEqual(alphaEnd?.toolCall.arguments);
	});

	// -----------------------------------------------------------------------
	// Case (c): Ghost event — item_id matches NO known item AND output_index
	// is undefined/non-finite.  Must be silently ignored: no new block
	// created, existing blocks unchanged.
	// -----------------------------------------------------------------------
	test("(c) ghost event with unknown item_id and no output_index is ignored", async () => {
		const events = [
			{
				type: "response.output_item.added",
				output_index: 0,
				item: { type: "function_call", id: "fc_real", call_id: "c_real", name: "alpha_tool", arguments: "" },
			},
			{ type: "response.function_call_arguments.delta", item_id: "fc_real", output_index: 0, delta: '{"x":42}' },
			// GHOST delta: item_id unknown, output_index undefined
			{
				type: "response.function_call_arguments.delta",
				item_id: "ghost",
				output_index: undefined,
				delta: '{"injected":"POISON"}',
			},
			{
				type: "response.function_call_arguments.done",
				item_id: "fc_real",
				output_index: 0,
				arguments: '{"x":42}',
			},
			{
				type: "response.output_item.done",
				output_index: 0,
				item: {
					type: "function_call",
					id: "fc_real",
					call_id: "c_real",
					name: "alpha_tool",
					arguments: '{"x":42}',
				},
			},
		];

		const output = makeOutput();
		const { emitted, stream } = makeCapture();
		await processResponsesStream(makeStream(events), output, stream, makeModel());

		// Only the real item should exist
		const blocks = toolBlocks(output);
		expect(blocks).toHaveLength(1);
		expect(blocks[0]?.name).toBe("alpha_tool");
		expect(blocks[0]?.arguments).toEqual({ x: 42 });
		// No injected poison
		expect((blocks[0]?.arguments as Record<string, unknown>)?.injected).toBeUndefined();

		// Emitted: only one toolcall_end for the real item
		const ends = toolCallEnds(emitted);
		expect(ends).toHaveLength(1);
		expect(ends[0]?.toolCall.name).toBe("alpha_tool");
		expect(ends[0]?.toolCall.arguments).toEqual({ x: 42 });
		// No ghost toolcall_start or toolcall_end was emitted
		const ghostStarts = emitted.filter(
			e => e.type === "toolcall_start" && (e as Record<string, unknown>).contentIndex !== 0,
		);
		expect(ghostStarts).toHaveLength(0);
	});

	// -----------------------------------------------------------------------
	// Case (d): output_index REUSE — two sequential items occupy the same
	// output_index (0), i.e. item 1 is done/dropped before item 2 is added.
	// Assert that no entry from item 1 bleeds into item 2 after the lifecycle
	// boundary.
	// -----------------------------------------------------------------------
	test("(d) output_index reuse: item 2 at same index does not inherit item 1 state", async () => {
		const events = [
			// --- Item 1 lifecycle: output_index 0 ---
			{
				type: "response.output_item.added",
				output_index: 0,
				item: { type: "function_call", id: "fc_first", call_id: "c_first", name: "alpha_tool", arguments: "" },
			},
			{ type: "response.function_call_arguments.delta", item_id: "fc_first", output_index: 0, delta: '{"seq":1}' },
			{
				type: "response.function_call_arguments.done",
				item_id: "fc_first",
				output_index: 0,
				arguments: '{"seq":1}',
			},
			{
				type: "response.output_item.done",
				output_index: 0,
				item: {
					type: "function_call",
					id: "fc_first",
					call_id: "c_first",
					name: "alpha_tool",
					arguments: '{"seq":1}',
				},
			},
			// --- Item 2 lifecycle: SAME output_index 0 (reused) ---
			{
				type: "response.output_item.added",
				output_index: 0,
				item: { type: "function_call", id: "fc_second", call_id: "c_second", name: "bravo_tool", arguments: "" },
			},
			{ type: "response.function_call_arguments.delta", item_id: "fc_second", output_index: 0, delta: '{"seq":2}' },
			{
				type: "response.function_call_arguments.done",
				item_id: "fc_second",
				output_index: 0,
				arguments: '{"seq":2}',
			},
			{
				type: "response.output_item.done",
				output_index: 0,
				item: {
					type: "function_call",
					id: "fc_second",
					call_id: "c_second",
					name: "bravo_tool",
					arguments: '{"seq":2}',
				},
			},
		];

		const output = makeOutput();
		const { emitted, stream } = makeCapture();
		await processResponsesStream(makeStream(events), output, stream, makeModel());

		// Both blocks must be recorded
		const blocks = toolBlocks(output);
		expect(blocks).toHaveLength(2);
		const first = blocks.find(b => b.name === "alpha_tool");
		const second = blocks.find(b => b.name === "bravo_tool");
		expect(first?.arguments).toEqual({ seq: 1 });
		expect(second?.arguments).toEqual({ seq: 2 });
		// Anti-bleed
		expect((first?.arguments as Record<string, unknown>)?.seq).toBe(1);
		expect((second?.arguments as Record<string, unknown>)?.seq).toBe(2);

		// Two distinct toolcall_end events
		const ends = toolCallEnds(emitted);
		expect(ends).toHaveLength(2);
		const e1 = ends.find(e => e.toolCall.name === "alpha_tool");
		const e2 = ends.find(e => e.toolCall.name === "bravo_tool");
		expect(e1?.toolCall.arguments).toEqual({ seq: 1 });
		expect(e2?.toolCall.arguments).toEqual({ seq: 2 });
	});

	// -----------------------------------------------------------------------
	// Case (e): A text/message item interleaved between two tool-call items.
	// A late output_text.delta must land on the message block's recorded
	// content index, NOT on either tool block.
	// -----------------------------------------------------------------------
	test("(e) late text delta targets message block, not adjacent tool blocks", async () => {
		const events = [
			// tool item at index 0
			{
				type: "response.output_item.added",
				output_index: 0,
				item: { type: "function_call", id: "fc_pre", call_id: "c_pre", name: "alpha_tool", arguments: "" },
			},
			// message item at index 1 (interleaved)
			{
				type: "response.output_item.added",
				output_index: 1,
				item: {
					type: "message",
					id: "msg_mid",
					role: "assistant",
					content: [],
					status: "in_progress",
				},
			},
			// content_part added to the message so the text-delta path works
			{
				type: "response.content_part.added",
				item_id: "msg_mid",
				output_index: 1,
				content_index: 0,
				part: { type: "output_text", text: "" },
			},
			// tool item at index 2
			{
				type: "response.output_item.added",
				output_index: 2,
				item: { type: "function_call", id: "fc_post", call_id: "c_post", name: "bravo_tool", arguments: "" },
			},
			// pre-tool deltas
			{ type: "response.function_call_arguments.delta", item_id: "fc_pre", output_index: 0, delta: '{"pre":1}' },
			// LATE text delta — arrives after both tool items are already registered
			{
				type: "response.output_text.delta",
				item_id: "msg_mid",
				output_index: 1,
				content_index: 0,
				delta: "hello world",
			},
			// post-tool deltas
			{ type: "response.function_call_arguments.delta", item_id: "fc_post", output_index: 2, delta: '{"post":2}' },
			// finalize tools
			{
				type: "response.function_call_arguments.done",
				item_id: "fc_pre",
				output_index: 0,
				arguments: '{"pre":1}',
			},
			{
				type: "response.function_call_arguments.done",
				item_id: "fc_post",
				output_index: 2,
				arguments: '{"post":2}',
			},
			{
				type: "response.output_item.done",
				output_index: 0,
				item: { type: "function_call", id: "fc_pre", call_id: "c_pre", name: "alpha_tool", arguments: '{"pre":1}' },
			},
			// finalize message
			{
				type: "response.output_item.done",
				output_index: 1,
				item: {
					type: "message",
					id: "msg_mid",
					role: "assistant",
					content: [{ type: "output_text", text: "hello world" }],
					status: "completed",
				},
			},
			{
				type: "response.output_item.done",
				output_index: 2,
				item: {
					type: "function_call",
					id: "fc_post",
					call_id: "c_post",
					name: "bravo_tool",
					arguments: '{"post":2}',
				},
			},
		];

		const output = makeOutput();
		const { emitted, stream } = makeCapture();
		await processResponsesStream(makeStream(events), output, stream, makeModel());

		// output.content: [toolCall(alpha), text(msg), toolCall(bravo)]
		expect(output.content).toHaveLength(3);
		expect(output.content[0]?.type).toBe("toolCall");
		expect(output.content[1]?.type).toBe("text");
		expect(output.content[2]?.type).toBe("toolCall");

		// Text block must carry the interleaved delta
		const textBlock = output.content[1] as { type: "text"; text: string };
		expect(textBlock.text).toBe("hello world");

		// Tool blocks must NOT have text content
		const preTool = output.content[0] as ToolCall;
		const postTool = output.content[2] as ToolCall;
		expect(preTool.arguments).toEqual({ pre: 1 });
		expect(postTool.arguments).toEqual({ post: 2 });

		// text_delta event must target contentIndex 1 (the message block)
		const textDeltas = emitted.filter(e => e.type === "text_delta");
		expect(textDeltas.length).toBeGreaterThan(0);
		for (const td of textDeltas) {
			expect(td.contentIndex).toBe(1);
		}

		// toolcall_end events must have their correct content indices
		const ends = toolCallEnds(emitted);
		expect(ends).toHaveLength(2);
		const preEnd = ends.find(e => e.toolCall.name === "alpha_tool");
		const postEnd = ends.find(e => e.toolCall.name === "bravo_tool");
		expect(preEnd?.contentIndex).toBe(0);
		expect(postEnd?.contentIndex).toBe(2);
		expect(preEnd?.toolCall.arguments).toEqual({ pre: 1 });
		expect(postEnd?.toolCall.arguments).toEqual({ post: 2 });

		// Verify text delta did NOT mutate any tool block
		expect((preTool.arguments as Record<string, unknown>).text).toBeUndefined();
		expect((postTool.arguments as Record<string, unknown>).text).toBeUndefined();
	});
});
