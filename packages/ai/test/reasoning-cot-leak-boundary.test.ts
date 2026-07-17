import { describe, expect, test } from "bun:test";
import { encodeResponse, encodeStream } from "@gajae-code/ai/providers/openai-responses-server";
import { processResponsesStream } from "@gajae-code/ai/providers/openai-responses-shared";
import type { AssistantMessage, Model, ThinkingContent } from "@gajae-code/ai/types";
import { AssistantMessageEventStream } from "@gajae-code/ai/utils/event-stream";
import type { ResponseStreamEvent } from "openai/resources/responses/responses";

const RAW_SENTINEL = "RAW_SENTINEL_DO_NOT_SURFACE";
const SUMMARY_SENTINEL = "SUMMARY_SENTINEL_SAFE_TO_SURFACE";

function message(content: AssistantMessage["content"] = []): AssistantMessage {
	return {
		role: "assistant",
		api: "openai-responses",
		provider: "test",
		model: "test",
		content,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<Array<Record<string, unknown>>> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let raw = "";
	for (;;) {
		const { value, done } = await reader.read();
		if (done) break;
		raw += decoder.decode(value);
	}
	return raw
		.split("\n\n")
		.map(chunk =>
			chunk
				.split("\n")
				.find(line => line.startsWith("data: "))
				?.slice("data: ".length),
		)
		.filter((data): data is string => Boolean(data && data !== "[DONE]"))
		.map(data => JSON.parse(data) as Record<string, unknown>);
}

async function* wire(events: Array<Record<string, unknown>>): AsyncIterable<ResponseStreamEvent> {
	for (const event of events) yield event as unknown as ResponseStreamEvent;
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

function expectNoRawSummaryText(value: unknown): void {
	if (Array.isArray(value)) {
		for (const entry of value) expectNoRawSummaryText(entry);
		return;
	}
	if (!value || typeof value !== "object") return;

	for (const [key, entry] of Object.entries(value)) {
		if (key === "summary_text") {
			expect(entry).not.toContain(RAW_SENTINEL);
		}
		expectNoRawSummaryText(entry);
	}
}

function reasoningSummary(envelope: Record<string, unknown>): Array<{ type: string; text: string }> {
	const output = envelope.output as Array<Record<string, unknown>>;
	const reasoning = output.find(item => item.type === "reasoning");
	return reasoning?.summary as Array<{ type: string; text: string }>;
}

function reasoningItem(envelope: Record<string, unknown>): Record<string, unknown> {
	const output = envelope.output as Array<Record<string, unknown>>;
	return output.find(item => item.type === "reasoning") ?? {};
}

function expectNoRawReasoningContent(value: unknown): void {
	if (Array.isArray(value)) {
		for (const entry of value) expectNoRawReasoningContent(entry);
		return;
	}
	if (!value || typeof value !== "object") return;

	const record = value as Record<string, unknown>;
	if (record.type === "reasoning" && Array.isArray(record.content)) {
		expect(JSON.stringify(record.content)).not.toContain(RAW_SENTINEL);
	}
	for (const entry of Object.values(record)) expectNoRawReasoningContent(entry);
}

describe("Responses raw reasoning / summary boundary", () => {
	test("omits raw-only reasoning from the non-streaming public envelope", () => {
		const envelope = encodeResponse(
			message([
				{
					type: "thinking",
					thinking: RAW_SENTINEL,
					provenance: "raw",
					rawText: RAW_SENTINEL,
				},
			]),
			"test",
		);

		expect(reasoningSummary(envelope)).toEqual([]);
		expectNoRawSummaryText(envelope);
		expect(JSON.stringify(envelope)).not.toContain(RAW_SENTINEL);
		expect(reasoningItem(envelope).content).toBeUndefined();
		expectNoRawReasoningContent(envelope);
	});

	test("preserves summary-only reasoning in the non-streaming public envelope", () => {
		const envelope = encodeResponse(
			message([
				{
					type: "thinking",
					thinking: SUMMARY_SENTINEL,
					provenance: "summary",
					summaryText: SUMMARY_SENTINEL,
				},
			]),
			"test",
		);

		expect(reasoningSummary(envelope)).toEqual([{ type: "summary_text", text: SUMMARY_SENTINEL }]);
		expectNoRawSummaryText(envelope);
		expect(JSON.stringify(envelope)).toContain(SUMMARY_SENTINEL);
	});

	test("strips raw reasoning content from serialized signatures while preserving encrypted content", () => {
		const envelope = encodeResponse(
			message([
				{
					type: "thinking",
					thinking: SUMMARY_SENTINEL,
					provenance: "summary",
					summaryText: SUMMARY_SENTINEL,
					thinkingSignature: JSON.stringify({
						type: "reasoning",
						id: "rs_signed_boundary",
						encrypted_content: "ENC_KEEP",
						content: [{ type: "reasoning_text", text: RAW_SENTINEL }],
					}),
				},
			]),
			"test",
		);

		const reasoning = reasoningItem(envelope);
		expect(reasoning.summary).toEqual([{ type: "summary_text", text: SUMMARY_SENTINEL }]);
		expect(reasoning.encrypted_content).toBe("ENC_KEEP");
		expect(reasoning.content).toBeUndefined();
		expectNoRawReasoningContent(envelope);
		expect(JSON.stringify(envelope)).not.toContain(RAW_SENTINEL);
	});

	test("omits raw CoT from mixed reasoning in the non-streaming public envelope", () => {
		const envelope = encodeResponse(
			message([
				{
					type: "thinking",
					thinking: `${RAW_SENTINEL}${SUMMARY_SENTINEL}`,
					provenance: "mixed",
					rawText: RAW_SENTINEL,
					summaryText: SUMMARY_SENTINEL,
				},
			]),
			"test",
		);

		expect(reasoningSummary(envelope)).toEqual([{ type: "summary_text", text: SUMMARY_SENTINEL }]);
		expectNoRawSummaryText(envelope);
		expect(JSON.stringify(envelope)).not.toContain(RAW_SENTINEL);
		expect(reasoningItem(envelope).content).toBeUndefined();
		expectNoRawReasoningContent(envelope);
	});

	test("omits unmarked fresh reasoning from the non-streaming public envelope (no fail-open)", () => {
		// Unmarked thinking may be raw CoT from providers that stream unmarked reasoning
		// (e.g. openai-completions / ollama) re-encoded via the auth gateway. It must be
		// omitted from the public envelope, never published as summary_text.
		const envelope = encodeResponse(message([{ type: "thinking", thinking: RAW_SENTINEL }]), "test");

		expect(reasoningSummary(envelope)).toEqual([]);
		expect(JSON.stringify(envelope)).not.toContain(RAW_SENTINEL);
		expectNoRawSummaryText(envelope);
		expectNoRawReasoningContent(envelope);
	});

	test("keeps a multipart summary intact without exposing mixed raw CoT", () => {
		const multipartSummary = `${SUMMARY_SENTINEL} paragraph one\n\n${SUMMARY_SENTINEL} paragraph two`;
		const envelope = encodeResponse(
			message([
				{
					type: "thinking",
					thinking: `${RAW_SENTINEL}${multipartSummary}`,
					provenance: "mixed",
					rawText: RAW_SENTINEL,
					summaryText: multipartSummary,
				},
			]),
			"test",
		);

		expect(reasoningSummary(envelope)).toEqual([{ type: "summary_text", text: multipartSummary }]);
		expectNoRawSummaryText(envelope);
		expect(JSON.stringify(envelope)).not.toContain(RAW_SENTINEL);
		expect(reasoningItem(envelope).content).toBeUndefined();
		expectNoRawReasoningContent(envelope);
	});

	test("round-trips raw reasoning separately from a genuine provider summary", async () => {
		const events = new AssistantMessageEventStream();
		const partial = message([{ type: "thinking", thinking: "", itemId: "rs_boundary" }]);
		const final = message([
			{
				type: "thinking",
				thinking: `${RAW_SENTINEL}${SUMMARY_SENTINEL}`,
				itemId: "rs_boundary",
				provenance: "mixed",
				rawText: RAW_SENTINEL,
				summaryText: SUMMARY_SENTINEL,
			},
		]);

		queueMicrotask(() => {
			events.push({ type: "start", partial: message() });
			events.push({ type: "thinking_start", contentIndex: 0, partial });
			events.push({ type: "thinking_delta", contentIndex: 0, delta: RAW_SENTINEL, partial });
			events.push({ type: "reasoning_summary_start", contentIndex: 0, partial });
			events.push({ type: "reasoning_summary_delta", contentIndex: 0, delta: SUMMARY_SENTINEL, partial });
			events.push({ type: "reasoning_summary_end", contentIndex: 0, content: SUMMARY_SENTINEL, partial });
			events.push({
				type: "thinking_end",
				contentIndex: 0,
				content: `${RAW_SENTINEL}${SUMMARY_SENTINEL}`,
				partial,
			});
			events.push({ type: "done", reason: "stop", message: final });
		});

		const encoded = await collect(encodeStream(events, "test"));
		const rawWire = encoded.filter(event => event.type === "response.reasoning_text.delta");
		const summaryWire = encoded.filter(event => String(event.type).includes("summary"));
		const completed = encoded.find(event => event.type === "response.completed");
		expect(completed).toBeDefined();
		const completedResponse = completed?.response as Record<string, unknown>;
		const completedReasoning = reasoningItem(completedResponse);
		const doneReasoningItems = encoded
			.filter(event => event.type === "response.output_item.done")
			.map(event => event.item as Record<string, unknown>)
			.filter(item => item.type === "reasoning");

		expect(rawWire).toEqual([]);
		expect(JSON.stringify(encoded)).not.toContain(RAW_SENTINEL);
		expect(summaryWire.some(event => JSON.stringify(event).includes(SUMMARY_SENTINEL))).toBe(true);
		expect(reasoningSummary(completedResponse)).toEqual([{ type: "summary_text", text: SUMMARY_SENTINEL }]);
		expect(completedReasoning.content).toBeUndefined();
		expect(doneReasoningItems.length).toBeGreaterThan(0);
		for (const item of doneReasoningItems) expect(item.content).toBeUndefined();
		expectNoRawSummaryText(encoded);
		expectNoRawReasoningContent(completedResponse);
		expectNoRawReasoningContent(doneReasoningItems);
		expect(JSON.stringify(completedResponse)).not.toContain(RAW_SENTINEL);

		const decoded = message();
		await processResponsesStream(wire(encoded), decoded, { push() {}, end() {} } as never, model);
		const block = decoded.content[0] as ThinkingContent;
		expect(block.provenance).toBe("summary");
		expect(block.rawText).toBeUndefined();
		expect(block.thinking).toContain(SUMMARY_SENTINEL);
		expect(block.summaryText).toContain(SUMMARY_SENTINEL);
		expect(block.summaryText).not.toContain(RAW_SENTINEL);
	});

	test("does not encode summary-only reasoning as raw text", async () => {
		const events = new AssistantMessageEventStream();
		const partial = message([{ type: "thinking", thinking: "", itemId: "rs_summary" }]);
		const final = message([
			{
				type: "thinking",
				thinking: SUMMARY_SENTINEL,
				itemId: "rs_summary",
				provenance: "summary",
				summaryText: SUMMARY_SENTINEL,
			},
		]);

		queueMicrotask(() => {
			events.push({ type: "start", partial: message() });
			events.push({ type: "thinking_start", contentIndex: 0, partial });
			events.push({ type: "reasoning_summary_start", contentIndex: 0, partial });
			events.push({ type: "reasoning_summary_delta", contentIndex: 0, delta: SUMMARY_SENTINEL, partial });
			events.push({ type: "reasoning_summary_end", contentIndex: 0, content: SUMMARY_SENTINEL, partial });
			events.push({ type: "thinking_end", contentIndex: 0, content: SUMMARY_SENTINEL, partial });
			events.push({ type: "done", reason: "stop", message: final });
		});

		const encoded = await collect(encodeStream(events, "test"));
		expect(encoded.some(event => String(event.type).startsWith("response.reasoning_text"))).toBe(false);

		const decoded = message();
		await processResponsesStream(wire(encoded), decoded, { push() {}, end() {} } as never, model);
		const block = decoded.content[0] as ThinkingContent;
		expect(block.provenance).toBe("summary");
		expect(block.summaryText).toContain(SUMMARY_SENTINEL);
		expect(block.summaryText).not.toContain(RAW_SENTINEL);
		expect(block.rawText).toBeUndefined();
	});

	test("does not encode raw-only reasoning as summary text", async () => {
		const events = new AssistantMessageEventStream();
		const partial = message([{ type: "thinking", thinking: "", itemId: "rs_raw" }]);
		const final = message([
			{
				type: "thinking",
				thinking: RAW_SENTINEL,
				itemId: "rs_raw",
				provenance: "raw",
				rawText: RAW_SENTINEL,
			},
		]);

		queueMicrotask(() => {
			events.push({ type: "start", partial: message() });
			events.push({ type: "thinking_start", contentIndex: 0, partial });
			events.push({ type: "thinking_delta", contentIndex: 0, delta: RAW_SENTINEL, partial });
			events.push({ type: "thinking_end", contentIndex: 0, content: RAW_SENTINEL, partial });
			events.push({ type: "done", reason: "stop", message: final });
		});

		const encoded = await collect(encodeStream(events, "test"));
		expect(encoded.some(event => String(event.type).startsWith("response.reasoning_summary_"))).toBe(false);

		const decoded = message();
		await processResponsesStream(wire(encoded), decoded, { push() {}, end() {} } as never, model);
		const block = decoded.content[0] as ThinkingContent;
		expect(block.provenance).toBeUndefined();
		expect(block.thinking).toBe("");
		expect(block.rawText).toBeUndefined();
		expect(block.summaryText).toBeUndefined();
	});
	test("uses final summary content when a separator-only delta arrives first", async () => {
		const events = new AssistantMessageEventStream();
		const partial = message([{ type: "thinking", thinking: "", itemId: "rs_separator" }]);
		const final = message([
			{
				type: "thinking",
				thinking: "REAL SUMMARY",
				itemId: "rs_separator",
				provenance: "summary",
				summaryText: "REAL SUMMARY",
			},
		]);

		queueMicrotask(() => {
			events.push({ type: "start", partial: message() });
			events.push({ type: "thinking_start", contentIndex: 0, partial });
			events.push({ type: "reasoning_summary_start", contentIndex: 0, partial });
			events.push({ type: "reasoning_summary_delta", contentIndex: 0, delta: "\n\n", partial });
			events.push({ type: "reasoning_summary_end", contentIndex: 0, content: "REAL SUMMARY", partial });
			events.push({ type: "thinking_end", contentIndex: 0, content: "REAL SUMMARY", partial });
			events.push({ type: "done", reason: "stop", message: final });
		});

		const encoded = await collect(encodeStream(events, "test"));
		const completed = encoded.find(event => event.type === "response.completed");
		const completedResponse = completed?.response as Record<string, unknown>;
		const doneReasoningItems = encoded
			.filter(event => event.type === "response.output_item.done")
			.map(event => event.item as Record<string, unknown>)
			.filter(item => item.type === "reasoning");

		expect(completed).toBeDefined();
		expect(reasoningSummary(completedResponse)).toEqual([{ type: "summary_text", text: "REAL SUMMARY" }]);
		expect(doneReasoningItems).toHaveLength(1);
		expect(doneReasoningItems[0]!.summary).toEqual([{ type: "summary_text", text: "REAL SUMMARY" }]);
		expect(JSON.stringify([completedResponse, doneReasoningItems])).not.toContain('"text":"\\n\\n"');
	});
});
