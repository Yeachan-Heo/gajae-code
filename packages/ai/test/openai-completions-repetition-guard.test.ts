import { afterEach, describe, expect, it } from "bun:test";
import { streamOpenAICompletions } from "../src/providers/openai-completions";
import type { AssistantMessage, Context, Model, TextContent, ThinkingContent, ToolCall } from "../src/types";

const originalFetch = global.fetch;

afterEach(() => {
	global.fetch = originalFetch;
});

interface SseToolCallDelta {
	index: number;
	id?: string;
	type?: "function";
	function?: { name?: string; arguments?: string };
}

interface SseChoiceDelta {
	content?: string;
	reasoning_content?: string;
	tool_calls?: SseToolCallDelta[];
}

interface SseChunk {
	id: string;
	object: "chat.completion.chunk";
	created: number;
	model: string;
	choices: Array<{
		index: number;
		delta: SseChoiceDelta;
		finish_reason?: "stop" | "tool_calls" | "length" | null;
	}>;
}

function chunk(delta: SseChoiceDelta, finish: SseChunk["choices"][0]["finish_reason"] = null): SseChunk {
	return {
		id: "chatcmpl-repetition-guard",
		object: "chat.completion.chunk",
		created: 0,
		model: "test-model",
		choices: [{ index: 0, delta, finish_reason: finish }],
	};
}

interface DeliveryState {
	/** How many SSE events the upstream actually handed to the client. */
	delivered: number;
}

/**
 * Serves the events one at a time through a real `ReadableStream` so the
 * consumer's backpressure — and its abort — are observable. A pre-buffered
 * `Response` would hand over every event before the guard could ever cut the
 * stream short, which is exactly the property under test.
 */
function streamingFetch(events: ReadonlyArray<SseChunk | "[DONE]">, state: DeliveryState): typeof fetch {
	const fn = async (_input: unknown, init?: { signal?: AbortSignal }): Promise<Response> => {
		const signal = init?.signal;
		const encoder = new TextEncoder();
		let index = 0;
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				signal?.addEventListener("abort", () => {
					try {
						controller.error(new DOMException("Aborted", "AbortError"));
					} catch {
						// Already closed or errored — nothing to cancel.
					}
				});
			},
			pull(controller) {
				if (signal?.aborted) return;
				if (index >= events.length) {
					controller.close();
					return;
				}
				const event = events[index++];
				state.delivered = index;
				controller.enqueue(
					encoder.encode(`data: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`),
				);
			},
		});
		return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
	};
	return Object.assign(fn, { preconnect: originalFetch.preconnect }) as unknown as typeof fetch;
}

function model(): Model<"openai-completions"> {
	return {
		id: "test-model",
		name: "Test",
		api: "openai-completions",
		provider: "test-provider",
		baseUrl: "https://example.com/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 8192,
	};
}

function context(): Context {
	return { messages: [{ role: "user", content: "go", timestamp: Date.now() }] };
}

function thinkingText(result: AssistantMessage): string {
	return result.content
		.filter((block): block is ThinkingContent => block.type === "thinking")
		.map(block => block.thinking)
		.join("");
}

function visibleText(result: AssistantMessage): string {
	return result.content
		.filter((block): block is TextContent => block.type === "text")
		.map(block => block.text)
		.join("");
}

function countOccurrences(haystack: string, needle: string): number {
	return haystack.split(needle).length - 1;
}

/** Matches the guard's shipped default. */
const THRESHOLD = 12;

describe("chat-completions: streamed repetition guard (#5624)", () => {
	// The exact loop the reporter hit on xai/grok-4.6 at thinking=xhigh: one
	// short sentence emitted ~78 times on the reasoning channel.
	const SENTENCE = "0.0.1 버전으로 배포 완료되었습니다";

	it("bounds a thinking channel stuck repeating one line and marks the turn aborted", async () => {
		const state: DeliveryState = { delivered: 0 };
		const events: Array<SseChunk | "[DONE]"> = [];
		for (let i = 0; i < 100; i++) events.push(chunk({ reasoning_content: `${SENTENCE}\n` }));
		events.push(chunk({}, "stop"), "[DONE]");
		global.fetch = streamingFetch(events, state);

		const result = await streamOpenAICompletions(model(), context(), { apiKey: "test" }).result();

		expect(countOccurrences(thinkingText(result), SENTENCE)).toBeLessThanOrEqual(THRESHOLD);
		expect(result.stopReason).toBe("aborted");
		expect(result.errorCode).toBe("repetition_guard_tripped");
		// The count belongs in the human-readable message, never in the bounded code.
		expect(result.errorMessage).toContain(String(THRESHOLD));
		// The guard cut the upstream stream instead of draining all 100 events.
		expect(state.delivered).toBeLessThan(100);
	});

	it("bounds a thinking channel repeating a short run with no newlines", async () => {
		const state: DeliveryState = { delivered: 0 };
		const events: Array<SseChunk | "[DONE]"> = [];
		// No newline separator, so only the n-gram detector can catch this one.
		for (let i = 0; i < 200; i++) events.push(chunk({ reasoning_content: "0.0.1 done " }));
		events.push(chunk({}, "stop"), "[DONE]");
		global.fetch = streamingFetch(events, state);

		const result = await streamOpenAICompletions(model(), context(), { apiKey: "test" }).result();

		expect(countOccurrences(thinkingText(result), "0.0.1 done")).toBeLessThan(200);
		expect(result.stopReason).toBe("aborted");
		expect(result.errorCode).toBe("repetition_guard_tripped");
		expect(state.delivered).toBeLessThan(200);
	});

	it("keeps tool-call frames intact while the guard trips on thinking", async () => {
		const state: DeliveryState = { delivered: 0 };
		const events: Array<SseChunk | "[DONE]"> = [];
		for (let i = 0; i < 4; i++) events.push(chunk({ reasoning_content: `${SENTENCE}\n` }));
		events.push(
			chunk({
				tool_calls: [
					{ index: 0, id: "call_1", type: "function", function: { name: "read", arguments: '{"path":' } },
				],
			}),
			chunk({ tool_calls: [{ index: 0, function: { arguments: '"a.ts"}' } }] }),
		);
		for (let i = 0; i < 100; i++) events.push(chunk({ reasoning_content: `${SENTENCE}\n` }));
		events.push(chunk({}, "stop"), "[DONE]");
		global.fetch = streamingFetch(events, state);

		const result = await streamOpenAICompletions(model(), context(), { apiKey: "test" }).result();

		const toolCalls = result.content.filter((block): block is ToolCall => block.type === "toolCall");
		expect(toolCalls).toHaveLength(1);
		expect(toolCalls[0].name).toBe("read");
		expect(toolCalls[0].arguments).toEqual({ path: "a.ts" });
		expect(result.stopReason).toBe("aborted");
	});

	it("strips leaked tool fences from rendered thinking", async () => {
		const state: DeliveryState = { delivered: 0 };
		global.fetch = streamingFetch(
			[
				chunk({ reasoning_content: "0.0.1 <|tool_call_end|>" }),
				chunk({ reasoning_content: " next<|tool_calls_section_end|> step" }),
				chunk({}, "stop"),
				"[DONE]",
			],
			state,
		);

		const result = await streamOpenAICompletions(model(), context(), { apiKey: "test" }).result();

		const thinking = thinkingText(result);
		expect(thinking).not.toContain("<|tool_call_end|>");
		expect(thinking).not.toContain("<|tool_calls_section_end|>");
		expect(thinking).toBe("0.0.1  next step");
		expect(result.stopReason).toBe("stop");
	});

	it("strips a tool fence that arrives split across two chunks", async () => {
		const state: DeliveryState = { delivered: 0 };
		global.fetch = streamingFetch(
			[
				chunk({ reasoning_content: "0.0.1 <|tool_ca" }),
				chunk({ reasoning_content: "ll_end|> done" }),
				chunk({}, "stop"),
				"[DONE]",
			],
			state,
		);

		const result = await streamOpenAICompletions(model(), context(), { apiKey: "test" }).result();

		expect(thinkingText(result)).toBe("0.0.1  done");
		expect(result.stopReason).toBe("stop");
	});

	// Guards the deliberate behaviour recorded in packages/ai/CHANGELOG.md:1094 —
	// a fence token the assistant *talks about* in prose must survive as text.
	it("leaves tool fences alone on the visible text channel", async () => {
		const state: DeliveryState = { delivered: 0 };
		const prose = "Use <|tool_call_end|> to close a call.";
		global.fetch = streamingFetch([chunk({ content: prose }), chunk({}, "stop"), "[DONE]"], state);

		const result = await streamOpenAICompletions(model(), context(), { apiKey: "test" }).result();

		expect(visibleText(result)).toBe(prose);
		expect(result.stopReason).toBe("stop");
	});

	it("passes a normal stream through byte for byte", async () => {
		const state: DeliveryState = { delivered: 0 };
		const thinkingParts = ["Let me check the version.\n", "It looks like 0.0.1.\n", "Deploying now.\n"];
		const textParts = ["Deployed ", "version 0.0.1 ", "successfully."];
		const events: Array<SseChunk | "[DONE]"> = [
			...thinkingParts.map(part => chunk({ reasoning_content: part })),
			...textParts.map(part => chunk({ content: part })),
			chunk({}, "stop"),
			"[DONE]",
		];
		global.fetch = streamingFetch(events, state);

		const result = await streamOpenAICompletions(model(), context(), { apiKey: "test" }).result();

		expect(thinkingText(result)).toBe(thinkingParts.join(""));
		expect(visibleText(result)).toBe(textParts.join(""));
		expect(result.stopReason).toBe("stop");
		expect(result.errorCode).toBeUndefined();
	});

	it("does not trip on a long stream that merely reuses a common short phrase", async () => {
		const state: DeliveryState = { delivered: 0 };
		const events: Array<SseChunk | "[DONE]"> = [];
		for (let i = 0; i < 60; i++) events.push(chunk({ reasoning_content: `Step ${i}: checking file ${i}.ts\n` }));
		events.push(chunk({}, "stop"), "[DONE]");
		global.fetch = streamingFetch(events, state);

		const result = await streamOpenAICompletions(model(), context(), { apiKey: "test" }).result();

		expect(result.stopReason).toBe("stop");
		expect(result.errorCode).toBeUndefined();
		expect(thinkingText(result)).toContain("Step 59: checking file 59.ts");
	});
});
