import { describe, expect, test } from "bun:test";
import { processResponsesStream } from "@gajae-code/ai/providers/openai-responses-shared";
import type { AssistantMessage, Model, ThinkingContent } from "@gajae-code/ai/types";
import type { ResponseStreamEvent } from "openai/resources/responses/responses";

const RAW_SENTINEL = "RAW_SENTINEL_DO_NOT_SURFACE";
const SUMMARY_SENTINEL = "SUMMARY_SENTINEL_SAFE_TO_SURFACE";

async function* stream(events: readonly unknown[]): AsyncIterable<ResponseStreamEvent> {
	for (const event of events) yield event as ResponseStreamEvent;
}

function output(): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		timestamp: 0,
		provider: "test",
		model: "test",
		api: "openai-responses",
		stopReason: "stop",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

const model: Model<"openai-responses"> = {
	id: "test",
	name: "test",
	api: "openai-responses",
	provider: "test",
	baseUrl: "https://example.test",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1,
	maxTokens: 1,
};

function reasoningDone(summary: string[] = [], raw = "") {
	return {
		type: "response.output_item.done",
		output_index: 0,
		item: {
			type: "reasoning",
			id: "r",
			summary: summary.map(text => ({ type: "summary_text", text })),
			content: raw ? [{ type: "reasoning_text", text: raw }] : [],
		},
	};
}

async function run(events: readonly unknown[]) {
	const message = output();
	const emitted: Array<Record<string, unknown>> = [];
	await processResponsesStream(
		stream(events),
		message,
		{ push: (event: Record<string, unknown>) => emitted.push(event), end() {} } as never,
		model,
	);
	return { block: message.content[0] as ThinkingContent, emitted, message };
}

const reasoningAdded = {
	type: "response.output_item.added",
	output_index: 0,
	item: { type: "reasoning", id: "r", summary: [] },
};

describe("reasoning provenance", () => {
	test("summary-only stream materializes only summaryText", async () => {
		const { block } = await run([
			reasoningAdded,
			{
				type: "response.reasoning_summary_part.added",
				item_id: "r",
				output_index: 0,
				part: { type: "summary_text", text: "" },
			},
			{ type: "response.reasoning_summary_text.delta", item_id: "r", output_index: 0, delta: "safe" },
			reasoningDone(["safe"]),
		]);
		expect(block).toMatchObject({ provenance: "summary", summaryText: "safe" });
		expect(block.rawText).toBeUndefined();
	});

	test("raw-only stream materializes only rawText", async () => {
		const { block } = await run([
			reasoningAdded,
			{ type: "response.reasoning_text.delta", item_id: "r", output_index: 0, delta: "raw" },
			reasoningDone([], "raw"),
		]);
		expect(block).toMatchObject({ provenance: "raw", rawText: "raw" });
		expect(block.summaryText).toBeUndefined();
	});

	test("mixed stream keeps raw text out of summaryText", async () => {
		const { block } = await run([
			reasoningAdded,
			{
				type: "response.reasoning_summary_part.added",
				item_id: "r",
				output_index: 0,
				part: { type: "summary_text", text: "" },
			},
			{ type: "response.reasoning_summary_text.delta", item_id: "r", output_index: 0, delta: "summary" },
			{ type: "response.reasoning_text.delta", item_id: "r", output_index: 0, delta: "raw" },
			reasoningDone(["summary"], "raw"),
		]);
		expect(block).toMatchObject({ provenance: "mixed", summaryText: "summary", rawText: "raw" });
		expect(block.summaryText).not.toContain("raw");
	});

	test("interleaved later message and tool retain their content indices", async () => {
		const { emitted } = await run([
			reasoningAdded,
			{ type: "response.output_item.added", output_index: 1, item: { type: "message", id: "m", content: [] } },
			{
				type: "response.output_item.added",
				output_index: 2,
				item: { type: "function_call", id: "f", call_id: "c", name: "tool", arguments: "" },
			},
			reasoningDone(),
		]);
		expect(emitted.find(event => event.type === "text_start")?.contentIndex).toBe(1);
		expect(emitted.find(event => event.type === "toolcall_start")?.contentIndex).toBe(2);
	});

	test("falls back to output_item.done summary when the streamed buffer has only separators", async () => {
		const { block } = await run([
			reasoningAdded,
			{
				type: "response.reasoning_summary_part.added",
				item_id: "r",
				output_index: 0,
				part: { type: "summary_text", text: "" },
			},
			{ type: "response.reasoning_summary_part.done", item_id: "r", output_index: 0 },
			reasoningDone(["FINAL SUMMARY"]),
		]);
		expect(block).toMatchObject({ provenance: "summary", summaryText: "FINAL SUMMARY" });
	});
	test("canonical output_item.done summary opens and closes an unstreamed summary", async () => {
		const { emitted } = await run([reasoningAdded, reasoningDone(["FINAL SUMMARY"])]);
		const summaryEvents = emitted.filter(event =>
			["reasoning_summary_start", "reasoning_summary_end"].includes(event.type as string),
		);
		expect(summaryEvents).toEqual([
			expect.objectContaining({ type: "reasoning_summary_start", contentIndex: 0 }),
			expect.objectContaining({ type: "reasoning_summary_end", contentIndex: 0, content: "FINAL SUMMARY" }),
		]);
	});

	test("streamed summary delta does not emit a duplicate summary start at output_item.done", async () => {
		const { emitted } = await run([
			reasoningAdded,
			{
				type: "response.reasoning_summary_part.added",
				item_id: "r",
				output_index: 0,
				part: { type: "summary_text", text: "" },
			},
			{ type: "response.reasoning_summary_text.delta", item_id: "r", output_index: 0, delta: "streamed" },
			reasoningDone(["streamed"]),
		]);
		expect(emitted.filter(event => event.type === "reasoning_summary_start")).toHaveLength(1);
	});
	test("multi-part summary concatenates once at output_item.done", async () => {
		const { block, emitted } = await run([
			reasoningAdded,
			{
				type: "response.reasoning_summary_part.added",
				item_id: "r",
				output_index: 0,
				part: { type: "summary_text", text: "" },
			},
			{ type: "response.reasoning_summary_text.delta", item_id: "r", output_index: 0, delta: "one" },
			{ type: "response.reasoning_summary_part.done", item_id: "r", output_index: 0 },
			{
				type: "response.reasoning_summary_part.added",
				item_id: "r",
				output_index: 0,
				part: { type: "summary_text", text: "" },
			},
			{ type: "response.reasoning_summary_text.delta", item_id: "r", output_index: 0, delta: "two" },
			reasoningDone(["one", "two"]),
		]);
		expect(block.summaryText).toBe("one\n\ntwo");
		expect(emitted.filter(event => event.type === "reasoning_summary_end")).toHaveLength(1);
	});

	test("write-once guard preserves an existing provenance assignment", async () => {
		const { block } = await run([
			reasoningAdded,
			{ type: "response.reasoning_text.delta", item_id: "r", output_index: 0, delta: "raw" },
			reasoningDone([], "raw"),
			reasoningDone(["summary"], ""),
		]);
		expect(block).toMatchObject({ provenance: "raw", rawText: "raw" });
		expect(block.summaryText).toBeUndefined();
	});
	test("keeps finalized thinking monotonic across reasoning finalization permutations", async () => {
		const summaryPart = {
			type: "response.reasoning_summary_part.added",
			item_id: "r",
			output_index: 0,
			part: { type: "summary_text", text: "" },
		};
		const summaryDelta = {
			type: "response.reasoning_summary_text.delta",
			item_id: "r",
			output_index: 0,
			delta: SUMMARY_SENTINEL,
		};
		const rawDelta = {
			type: "response.reasoning_text.delta",
			item_id: "r",
			output_index: 0,
			delta: RAW_SENTINEL,
		};
		const cases = [
			{
				name: "summary-first then raw duplicate output_item.done",
				events: [
					reasoningAdded,
					summaryPart,
					summaryDelta,
					reasoningDone([SUMMARY_SENTINEL]),
					reasoningDone([], RAW_SENTINEL),
				],
				provenance: "summary",
				summaryText: SUMMARY_SENTINEL,
				rawText: undefined,
			},
			{
				name: "raw-first then summary",
				events: [
					reasoningAdded,
					rawDelta,
					summaryPart,
					summaryDelta,
					reasoningDone([SUMMARY_SENTINEL], RAW_SENTINEL),
				],
				provenance: "mixed",
				summaryText: SUMMARY_SENTINEL,
				rawText: RAW_SENTINEL,
			},
			{
				name: "duplicate summary finalizations",
				events: [
					reasoningAdded,
					summaryPart,
					summaryDelta,
					reasoningDone([SUMMARY_SENTINEL]),
					reasoningDone([SUMMARY_SENTINEL]),
				],
				provenance: "summary",
				summaryText: SUMMARY_SENTINEL,
				rawText: undefined,
			},
			{
				name: "final-only summary",
				events: [reasoningAdded, reasoningDone([SUMMARY_SENTINEL])],
				provenance: "summary",
				summaryText: SUMMARY_SENTINEL,
				rawText: undefined,
			},
			{
				name: "raw-only control",
				events: [reasoningAdded, rawDelta, reasoningDone([], RAW_SENTINEL)],
				provenance: "raw",
				summaryText: undefined,
				rawText: RAW_SENTINEL,
			},
		] as const;

		for (const scenario of cases) {
			const { block } = await run(scenario.events);
			expect(block, scenario.name).toMatchObject({ provenance: scenario.provenance });
			expect(block.summaryText, scenario.name).toBe(scenario.summaryText);
			expect(block.rawText, scenario.name).toBe(scenario.rawText);
			if (scenario.provenance === "raw") {
				expect(block.thinking, scenario.name).toBe(RAW_SENTINEL);
			} else {
				expect(block.thinking, scenario.name).toBe(SUMMARY_SENTINEL);
				expect(block.thinking, scenario.name).not.toContain(RAW_SENTINEL);
			}
		}
	});
});
