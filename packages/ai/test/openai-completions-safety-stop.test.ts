import { afterEach, describe, expect, it } from "bun:test";
import { streamOpenAICompletions } from "@gajae-code/ai/providers/openai-completions";
import type { AssistantMessageEvent, Context, Model } from "@gajae-code/ai/types";

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
		delta: { content?: string; refusal?: string; tool_calls?: ToolCallDelta[] };
		finish_reason?: "stop" | "tool_calls" | "content_filter" | null;
	}>;
}

function sseResponse(events: ReadonlyArray<SseChunk | "[DONE]">): Response {
	const payload = `${events.map(event => `data: ${typeof event === "string" ? event : JSON.stringify(event)}`).join("\n\n")}\n\n`;
	return new Response(payload, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function mockFetch(events: ReadonlyArray<SseChunk | "[DONE]">): typeof fetch {
	const fn = async (): Promise<Response> => sseResponse(events);
	return Object.assign(fn, { preconnect: originalFetch.preconnect });
}
function mockErrorFetch(body: object): typeof fetch {
	const fn = async (): Promise<Response> =>
		new Response(JSON.stringify(body), { status: 400, headers: { "content-type": "application/json" } });
	return Object.assign(fn, { preconnect: originalFetch.preconnect });
}

function chunk(
	delta: SseChunk["choices"][0]["delta"],
	finish: SseChunk["choices"][0]["finish_reason"] = null,
): SseChunk {
	return {
		id: "chatcmpl-safety-stop",
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

describe("chat-completions: provider safety stops", () => {
	it("keeps a content-filter safety stop when a later tool block finishes", async () => {
		global.fetch = mockFetch([
			chunk({}, "content_filter"),
			chunk(
				{
					tool_calls: [
						{
							index: 0,
							id: "call_1",
							type: "function",
							function: { name: "read_file", arguments: "{}" },
						},
					],
				},
				"tool_calls",
			),
			"[DONE]",
		]);

		const result = await streamOpenAICompletions(model(), context(), { apiKey: "test" }).result();
		expect(result.errorKind).toBe("provider_safety_stop");
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("Provider finish_reason: content_filter");
	});

	it("classifies a streamed refusal as a safety stop despite an ordinary finish reason", async () => {
		global.fetch = mockFetch([chunk({ refusal: "I cannot help with that." }, "stop"), "[DONE]"]);

		const result = await streamOpenAICompletions(model(), context(), { apiKey: "test" }).result();
		expect(result.errorKind).toBe("provider_safety_stop");
		expect(result.stopReason).toBe("error");
		expect(result.content).toEqual([{ type: "text", text: "I cannot help with that." }]);
	});

	it("keeps a streamed refusal as a safety error when a later tool call finishes", async () => {
		global.fetch = mockFetch([
			chunk({ refusal: "I cannot help with that." }),
			chunk(
				{
					tool_calls: [
						{
							index: 0,
							id: "call_1",
							type: "function",
							function: { name: "read_file", arguments: "{}" },
						},
					],
				},
				"tool_calls",
			),
			"[DONE]",
		]);

		const result = await streamOpenAICompletions(model(), context(), { apiKey: "test" }).result();
		expect(result.content.some(block => block.type === "toolCall")).toBe(true);
		expect(result.errorKind).toBe("provider_safety_stop");
		expect(result.stopReason).toBe("error");
	});

	it("keeps refusal and ordinary content visible in their streamed order", async () => {
		global.fetch = mockFetch([
			chunk({ refusal: "I cannot help with that. ", content: "Here is ordinary content." }, "stop"),
			"[DONE]",
		]);

		const result = await streamOpenAICompletions(model(), context(), { apiKey: "test" }).result();
		expect(result.errorKind).toBe("provider_safety_stop");
		expect(result.stopReason).toBe("error");
		expect(result.content).toEqual([{ type: "text", text: "I cannot help with that. Here is ordinary content." }]);
	});

	it("keeps the content-filter error after an earlier refusal", async () => {
		global.fetch = mockFetch([chunk({ refusal: "I cannot help with that." }), chunk({}, "content_filter"), "[DONE]"]);

		const result = await streamOpenAICompletions(model(), context(), { apiKey: "test" }).result();
		expect(result.errorKind).toBe("provider_safety_stop");
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("Provider finish_reason: content_filter");
	});

	it("types an HTTP content-filter rejection from a structured error code", async () => {
		global.fetch = mockErrorFetch({
			error: { code: "content_filter", message: "Prompt rejected by policy" },
		});

		const stream = streamOpenAICompletions(model(), context(), { apiKey: "test" });
		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) events.push(event);
		const result = await stream.result();

		expect(result.errorStatus).toBe(400);
		expect(result.errorKind).toBe("provider_safety_stop");
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("Prompt rejected by policy");
		expect(events.filter(event => event.type === "error")).toHaveLength(1);
		expect(events.filter(event => event.type === "done")).toHaveLength(0);
	});

	it("leaves unrelated HTTP errors with content-filter text untyped", async () => {
		global.fetch = mockErrorFetch({
			error: {
				code: "invalid_request_error",
				message: "The literal content_filter token is not allowed in this parameter.",
			},
		});

		const stream = streamOpenAICompletions(model(), context(), { apiKey: "test" });
		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) events.push(event);
		const result = await stream.result();

		expect(result.errorStatus).toBe(400);
		expect(result.errorKind).toBeUndefined();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("content_filter");
		expect(events.filter(event => event.type === "error")).toHaveLength(1);
		expect(events.filter(event => event.type === "done")).toHaveLength(0);
	});
});
