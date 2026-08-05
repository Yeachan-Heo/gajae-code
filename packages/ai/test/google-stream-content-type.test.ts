import { describe, expect, it } from "bun:test";
import { streamGoogleGenAI } from "../src/providers/google-shared";
import { collectEvents, createBaseModel, createSseResponse } from "./openai-tool-choice-test-helpers";

const chunks = [
	{ candidates: [{ content: { parts: [{ text: "hello " }] } }] },
	{
		candidates: [{ content: { parts: [{ text: "world" }] }, finishReason: "STOP" }],
		usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 2, totalTokenCount: 4 },
	},
];

function streamResponse(response: Response, onSseEvent?: () => void) {
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
		"application/jsonl",
	] as const)("reads newline-delimited JSON responses with content type %s", async contentType => {
		const response = new Response(chunks.map(chunk => JSON.stringify(chunk)).join("\n"), {
			headers: { "content-type": contentType },
		});
		let sseEventCount = 0;
		const stream = streamResponse(response, () => {
			sseEventCount++;
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
		expect(sseEventCount).toBe(0);
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

	it("surfaces malformed newline-delimited JSON as a stream error", async () => {
		const response = new Response('{"candidates":', {
			headers: { "content-type": "application/x-ndjson" },
		});
		const stream = streamResponse(response);
		const events = await collectEvents(stream);
		const result = await stream.result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBeTruthy();
		expect(events.filter(event => event.type === "error")).toHaveLength(1);
		expect(events.filter(event => event.type === "done")).toHaveLength(0);
	});
});
