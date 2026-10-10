import { describe, expect, it } from "bun:test";
import { streamGoogleGenAI } from "../src/providers/google-shared";
import type { RawSseEvent } from "../src/types";
import { collectEvents, createBaseModel, createSseResponse } from "./openai-tool-choice-test-helpers";

const chunks = [
	{ candidates: [{ content: { parts: [{ text: "hello " }] } }] },
	{
		candidates: [{ content: { parts: [{ text: "world" }] }, finishReason: "STOP" }],
		usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 2, totalTokenCount: 4 },
	},
];

function streamResponse(response: Response, onSseEvent?: (event: RawSseEvent) => void) {
	const model = createBaseModel("google-generative-ai");
	return streamGoogleGenAI({
		model,
		api: "google-generative-ai",
		options: onSseEvent ? { onSseEvent } : undefined,
		prepare: () => ({
			params: { model: model.id, contents: [] },
			url: "https://provider.example.test/stream",
			headers: {},
			fetch: async () => response,
		}),
	});
}

function createSseFixture(contentType?: string): Response {
	const response = createSseResponse(chunks);
	return new Response(response.body, {
		headers: contentType ? { "content-type": contentType } : {},
	});
}

describe("Google stream response framing", () => {
	it.each([
		"Application/X-NDJSON; Charset=UTF-8",
		"application/ndjson",
		"application/jsonl",
		"application/x-jsonl",
	] as const)("reads newline-delimited JSON responses without reporting blank separators for content type %s", async contentType => {
		const rawLines = chunks.map((chunk, index) => {
			const json = JSON.stringify(chunk);
			return index === 0 ? `  ${json} ` : `\t${json}`;
		});
		const response = new Response(rawLines.join("\n\n"), {
			headers: { "content-type": contentType },
		});
		const rawEvents: RawSseEvent[] = [];
		const stream = streamResponse(response, event => {
			rawEvents.push(event);
		});

		const events = await collectEvents(stream);
		const result = await stream.result();

		expect(events.filter(event => event.type === "text_delta").map(event => event.delta)).toEqual([
			"hello ",
			"world",
		]);
		expect(result.content[0]).toMatchObject({ type: "text", text: "hello world" });
		expect(result.usage.totalTokens).toBe(4);
		expect(result.stopReason).toBe("stop");
		expect(rawEvents).toEqual(
			rawLines.map(raw => ({
				event: null,
				data: raw,
				raw: [raw],
			})),
		);
	});

	it("keeps parsing event-stream responses as SSE", async () => {
		let sseEventCount = 0;
		const stream = streamResponse(createSseResponse(chunks), () => {
			sseEventCount++;
		});

		await collectEvents(stream);
		const result = await stream.result();

		expect(result.content[0]).toMatchObject({ type: "text", text: "hello world" });
		expect(result.stopReason).toBe("stop");
		expect(sseEventCount).toBe(2);
	});

	it.each([
		{ label: "missing", contentType: undefined },
		{ label: "unknown", contentType: 'application/octet-stream; profile="jsonl"' },
	] as const)("keeps $label content types on the SSE parser", async ({ contentType }) => {
		let sseEventCount = 0;
		const stream = streamResponse(createSseFixture(contentType), () => {
			sseEventCount++;
		});

		await collectEvents(stream);
		const result = await stream.result();

		expect(result.content[0]).toMatchObject({ type: "text", text: "hello world" });
		expect(result.stopReason).toBe("stop");
		expect(sseEventCount).toBe(2);
	});

	it("surfaces malformed newline-delimited JSON as a stream error after reporting its raw line", async () => {
		const rawLine = ' {"candidates":';
		const response = new Response(rawLine, {
			headers: { "content-type": "application/x-ndjson" },
		});
		const rawEvents: RawSseEvent[] = [];
		const stream = streamResponse(response, event => rawEvents.push(event));
		const events = await collectEvents(stream);
		const result = await stream.result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBeTruthy();
		expect(events.filter(event => event.type === "error")).toHaveLength(1);
		expect(events.filter(event => event.type === "done")).toHaveLength(0);
		expect(rawEvents).toEqual([{ event: null, data: rawLine, raw: [rawLine] }]);
	});
});
