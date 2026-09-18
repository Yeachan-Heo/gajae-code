import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { logger } from "@gajae-code/utils";
import { streamOpenAICompletions } from "../src/providers/openai-completions";
import { streamSimple } from "../src/stream";
import type { AssistantMessage, Context, Model, TextContent, ThinkingContent, ToolCall } from "../src/types";
import { REPETITION_GUARD_ERROR_CODE, REPETITION_GUARD_STOP_MESSAGE } from "../src/utils/stream-repetition-guard";

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

/**
 * A chunk with no `choices` key at all — what a usage-only report or a
 * keepalive-shaped frame looks like on the wire. Its own type rather than a
 * cast, so the harness keeps type-checking the events it serves.
 */
interface SseChoicelessChunk {
	id: string;
	object: "chat.completion.chunk";
	created: number;
	model: string;
	usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

/**
 * Everything the harness can serve. A bare `string` is emitted verbatim after
 * `data: `, so `"[DONE]"` ends the stream and e.g. `"123"` produces a payload
 * that parses to a non-object.
 */
type SseEvent = SseChunk | SseChoicelessChunk | Record<string, never> | string;

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
 * What the upstream does once every event has been delivered. `close` is the
 * healthy end of stream; the other two are the faults that can land *inside* the
 * post-trip drain window and must keep their own classification (#5627).
 */
type StreamEnding = "close" | "stall" | "error";

/** Status carried by the `error` ending, so transport facts are observable. */
const UPSTREAM_ERROR_STATUS = 503;
const UPSTREAM_ERROR_MESSAGE = "upstream connection reset";

/**
 * Serves the events one at a time through a real `ReadableStream` so the
 * consumer's backpressure — and its abort — are observable. A pre-buffered
 * `Response` would hand over every event before the guard could ever cut the
 * stream short, which is exactly the property under test.
 */
function streamingFetch(
	events: ReadonlyArray<SseEvent>,
	state: DeliveryState,
	ending: StreamEnding = "close",
): typeof fetch {
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
					if (ending === "error") {
						controller.error(Object.assign(new Error(UPSTREAM_ERROR_MESSAGE), { status: UPSTREAM_ERROR_STATUS }));
						return;
					}
					if (ending === "stall") {
						// Never settles: the body goes quiet without closing, which is
						// what a hung provider looks like to the idle watchdog. The
						// drain window cannot close itself here — it is evaluated once
						// per consumed chunk, and no chunk is coming.
						return new Promise<void>(() => {});
					}
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

	it("bounds a thinking channel stuck repeating one line and marks the turn a provider error", async () => {
		const state: DeliveryState = { delivered: 0 };
		const events: Array<SseChunk | "[DONE]"> = [];
		for (let i = 0; i < 100; i++) events.push(chunk({ reasoning_content: `${SENTENCE}\n` }));
		events.push(chunk({}, "stop"), "[DONE]");
		global.fetch = streamingFetch(events, state);

		const result = await streamOpenAICompletions(model(), context(), { apiKey: "test" }).result();

		expect(countOccurrences(thinkingText(result), SENTENCE)).toBeLessThanOrEqual(THRESHOLD);
		expect(result.stopReason).toBe("error");
		expect(result.errorCode).toBe("repetition_guard_tripped");
		// A fixed literal — the repeat count used to be interpolated here, but this
		// field is forwarded to API clients by the gateway (#5627 r5).
		expect(result.errorMessage).toBe(REPETITION_GUARD_STOP_MESSAGE);
		// A local decision, not a retryable transport fault — and retry admission
		// in the agent loop keys on exactly this field.
		expect(result.transportFailure).toBeUndefined();
		// The guard cut the upstream stream instead of draining all 100 events.
		expect(state.delivered).toBeLessThan(100);
	});

	// The drain window keeps the stream open after a trip, so a provider fault can
	// land inside it. Keying the catch on `repetitionTrip` classified those faults
	// as decode loops, dropping the real message/status and flipping the session's
	// retry decision to terminal. The guard's own abort is now tracked separately.
	//
	// Timings: the 20 repeats below deliver in ~5ms, so a 400ms idle timeout is
	// ~80x clear of delivery and ~5x inside the 2000ms drain window. The drain
	// cannot pre-empt the stall regardless — it is evaluated once per consumed
	// chunk, and during a stall no chunk arrives.
	const STALL_IDLE_TIMEOUT_MS = 400;

	/** 20 > THRESHOLD, so the guard trips at 12 and 8 chunks drain before the fault. */
	function repeatsBeforeFault(): Array<SseChunk | "[DONE]"> {
		const events: Array<SseChunk | "[DONE]"> = [];
		for (let i = 0; i < 20; i++) events.push(chunk({ reasoning_content: `${SENTENCE}\n` }));
		return events;
	}

	it("keeps the stall classification when the provider hangs after a trip", async () => {
		const state: DeliveryState = { delivered: 0 };
		global.fetch = streamingFetch(repeatsBeforeFault(), state, "stall");

		const result = await streamOpenAICompletions(model(), context(), {
			apiKey: "test",
			streamIdleTimeoutMs: STALL_IDLE_TIMEOUT_MS,
			streamFirstEventTimeoutMs: 5_000,
		}).result();

		// Non-vacuity: the guard really did trip, so the catch genuinely had a
		// `repetitionTrip` set and still refused to claim the failure.
		expect(countOccurrences(thinkingText(result), SENTENCE)).toBe(THRESHOLD);
		expect(result.stopReason).toBe("error");
		expect(result.errorCode).not.toBe(REPETITION_GUARD_ERROR_CODE);
		expect(result.errorCode).toBeUndefined();
		expect(result.errorMessage).toContain("stalled while waiting for the next event");
	});

	it("keeps the transport facts when the stream errors after a trip", async () => {
		const state: DeliveryState = { delivered: 0 };
		global.fetch = streamingFetch(repeatsBeforeFault(), state, "error");

		const result = await streamOpenAICompletions(model(), context(), {
			apiKey: "test",
			streamIdleTimeoutMs: 60_000,
		}).result();

		expect(countOccurrences(thinkingText(result), SENTENCE)).toBe(THRESHOLD);
		expect(result.stopReason).toBe("error");
		expect(result.errorCode).not.toBe(REPETITION_GUARD_ERROR_CODE);
		expect(result.errorCode).toBeUndefined();
		// The facts the guard classification used to discard.
		expect(result.transportFailure).toBeDefined();
		expect(result.errorStatus).toBe(UPSTREAM_ERROR_STATUS);
		expect(result.errorMessage).toContain(UPSTREAM_ERROR_MESSAGE);
	});

	// A repetition stop must not squat on the wire that means "the user cancelled":
	// the auth gateway maps `aborted` to 499 and telemetry counts it as a cancel.
	it("still reports a genuine caller abort as aborted, not as a guard trip", async () => {
		const state: DeliveryState = { delivered: 0 };
		const events: Array<SseChunk | "[DONE]"> = [];
		for (let i = 0; i < 100; i++) events.push(chunk({ reasoning_content: `Step ${i}: still working\n` }));
		events.push(chunk({}, "stop"), "[DONE]");
		global.fetch = streamingFetch(events, state);

		const controller = new AbortController();
		const pending = streamOpenAICompletions(model(), context(), {
			apiKey: "test",
			signal: controller.signal,
		}).result();
		await Promise.resolve();
		controller.abort();
		const result = await pending;

		expect(result.stopReason).toBe("aborted");
		expect(result.errorCode).not.toBe("repetition_guard_tripped");
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
		expect(result.stopReason).toBe("error");
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
		expect(result.stopReason).toBe("error");
	});

	it("keeps tool-call frames that arrive after the guard has already tripped", async () => {
		const state: DeliveryState = { delivered: 0 };
		const events: Array<SseChunk | "[DONE]"> = [];
		// Enough repeats to trip the guard *before* the model gets round to its
		// tool call — the ordering the original abort-on-trip dropped (#5627).
		for (let i = 0; i < 14; i++) events.push(chunk({ reasoning_content: `${SENTENCE}\n` }));
		events.push(
			chunk({
				tool_calls: [
					{ index: 0, id: "call_1", type: "function", function: { name: "read", arguments: '{"path":' } },
				],
			}),
			chunk({ tool_calls: [{ index: 0, function: { arguments: '"late.ts"}' } }] }),
		);
		for (let i = 0; i < 100; i++) events.push(chunk({ reasoning_content: `${SENTENCE}\n` }));
		events.push(chunk({}, "stop"), "[DONE]");
		global.fetch = streamingFetch(events, state);

		const result = await streamOpenAICompletions(model(), context(), { apiKey: "test" }).result();

		const toolCalls = result.content.filter((block): block is ToolCall => block.type === "toolCall");
		expect(toolCalls).toHaveLength(1);
		expect(toolCalls[0].name).toBe("read");
		expect(toolCalls[0].arguments).toEqual({ path: "late.ts" });
		// Draining for the tool call must not re-open the emit path: the repeats
		// that kept streaming during the drain are still not rendered.
		expect(countOccurrences(thinkingText(result), SENTENCE)).toBeLessThanOrEqual(THRESHOLD);
		expect(result.stopReason).toBe("error");
		expect(result.errorCode).toBe("repetition_guard_tripped");
		// The drain window is bounded — the stream was still cut short.
		expect(state.delivered).toBeLessThan(events.length);
	});

	// Mirrors the module-private REPETITION_DRAIN_PENDING_TOOL_MAX_CHUNKS — the
	// widest of the two budgets, so asserting against it holds whichever branch
	// `maybeAbortAfterRepetitionDrain` takes.
	const DRAIN_PENDING_TOOL_MAX_CHUNKS = 256;

	/**
	 * The drain budget used to be spent only by chunks that survived to the
	 * bottom of the loop body: two early `continue`s — one for a non-object
	 * payload, one for a `choices`-less payload — skipped the only call to
	 * `maybeAbortAfterRepetitionDrain()`. A provider that answered a tripped
	 * stream with usage-only, keepalive-shaped or malformed frames therefore
	 * held the request open with no bound at all (#5627 review r5).
	 *
	 * Both halves live in one test on purpose: the bound and the late tool call
	 * pull in opposite directions (cut sooner vs. finalize what already
	 * arrived), so splitting them would let a fix satisfy one and break the
	 * other while staying green.
	 */
	it("bounds the drain on chunks that carry no choices, and still keeps a late tool call", async () => {
		const state: DeliveryState = { delivered: 0 };
		const events: SseEvent[] = [];
		// 14 > THRESHOLD, so the guard is already tripped before the tool call.
		for (let i = 0; i < 14; i++) events.push(chunk({ reasoning_content: `${SENTENCE}\n` }));
		events.push(
			chunk({
				tool_calls: [
					{ index: 0, id: "call_1", type: "function", function: { name: "read", arguments: '{"path":' } },
				],
			}),
			chunk({ tool_calls: [{ index: 0, function: { arguments: '"late.ts"}' } }] }),
		);
		// Now flood with chunks that reach *only* the two early-exit paths, far
		// past either budget so "bounded" is a real claim and not an accident.
		const FLOOD = 400;
		for (let i = 0; i < FLOOD; i++) {
			if (i % 3 === 0) {
				// usage-only / `choices`-less
				events.push({
					id: "chatcmpl-repetition-guard",
					object: "chat.completion.chunk",
					created: 0,
					model: "test-model",
					usage: { prompt_tokens: 1, completion_tokens: i, total_tokens: i + 1 },
				});
			} else if (i % 3 === 1) {
				// not an object at all — `data: 123` parses to a number
				events.push(String(i));
			} else {
				events.push({});
			}
		}
		events.push(chunk({}, "stop"), "[DONE]");
		global.fetch = streamingFetch(events, state);

		const result = await streamOpenAICompletions(model(), context(), {
			apiKey: "test",
			// Generous: the chunk budget, not the clock, must be what ends this.
			streamIdleTimeoutMs: 60_000,
		}).result();

		// (1) The late tool call still landed — the check stays *after* each
		// chunk's processing, so nothing in flight is cut mid-frame.
		const toolCalls = result.content.filter((block): block is ToolCall => block.type === "toolCall");
		expect(toolCalls).toHaveLength(1);
		expect(toolCalls[0].name).toBe("read");
		expect(toolCalls[0].arguments).toEqual({ path: "late.ts" });

		// (2) ...and the stream was still cut, inside the advertised budget.
		expect(state.delivered).toBeLessThan(events.length);
		expect(state.delivered).toBeLessThanOrEqual(DRAIN_PENDING_TOOL_MAX_CHUNKS);

		// Classification is unchanged by the restructure.
		expect(result.stopReason).toBe("error");
		expect(result.errorCode).toBe(REPETITION_GUARD_ERROR_CODE);
		// Draining did not re-open the emit path.
		expect(countOccurrences(thinkingText(result), SENTENCE)).toBeLessThanOrEqual(THRESHOLD);
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

	// Visible text is the deliverable. A model asked for a log dump, a fixture or
	// a generated table legitimately repeats itself, and truncating that corrupts
	// the answer — so the heuristic is confined to the reasoning channel (#5627).
	const LOG_LINE = "[info] cache warm\n";

	it("streams intentionally repeated visible output through unchanged", async () => {
		const state: DeliveryState = { delivered: 0 };
		const events: Array<SseChunk | "[DONE]"> = [];
		for (let i = 0; i < 60; i++) events.push(chunk({ content: LOG_LINE }));
		events.push(chunk({}, "stop"), "[DONE]");
		global.fetch = streamingFetch(events, state);

		const result = await streamOpenAICompletions(model(), context(), { apiKey: "test" }).result();

		expect(visibleText(result)).toBe(LOG_LINE.repeat(60));
		expect(result.stopReason).toBe("stop");
		expect(result.errorCode).toBeUndefined();
	});

	it("guards visible output when the caller opts in", async () => {
		const state: DeliveryState = { delivered: 0 };
		const events: Array<SseChunk | "[DONE]"> = [];
		for (let i = 0; i < 60; i++) events.push(chunk({ content: LOG_LINE }));
		events.push(chunk({}, "stop"), "[DONE]");
		global.fetch = streamingFetch(events, state);

		const result = await streamOpenAICompletions(model(), context(), {
			apiKey: "test",
			repetitionGuard: { text: THRESHOLD },
		}).result();

		expect(countOccurrences(visibleText(result), LOG_LINE)).toBeLessThanOrEqual(THRESHOLD);
		expect(result.errorCode).toBe("repetition_guard_tripped");
	});

	it("leaves the thinking channel unguarded when the caller opts out", async () => {
		const state: DeliveryState = { delivered: 0 };
		const events: Array<SseChunk | "[DONE]"> = [];
		for (let i = 0; i < 60; i++) events.push(chunk({ reasoning_content: `${SENTENCE}\n` }));
		events.push(chunk({}, "stop"), "[DONE]");
		global.fetch = streamingFetch(events, state);

		const result = await streamOpenAICompletions(model(), context(), {
			apiKey: "test",
			repetitionGuard: { thinking: false },
		}).result();

		expect(countOccurrences(thinkingText(result), SENTENCE)).toBe(60);
		expect(result.stopReason).toBe("stop");
		expect(result.errorCode).toBeUndefined();
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
	// The repeated unit is raw model output, and the gateway forwards
	// `errorMessage` to API clients on the streaming path. The sentinel below is
	// also built from words `classifyGatewayError` keyword-matches on, so one
	// case covers both hazards: leaking the sample, and letting it pick the HTTP
	// status (#5627 review r5).
	const LEAK_SENTINEL = "quota invalid forbidden zzsentinelzz";

	it("never puts the repeated sample in errorMessage", async () => {
		const state: DeliveryState = { delivered: 0 };
		const events: Array<SseChunk | "[DONE]"> = [];
		for (let i = 0; i < 40; i++) events.push(chunk({ reasoning_content: `${LEAK_SENTINEL}\n` }));
		events.push(chunk({}, "stop"), "[DONE]");
		global.fetch = streamingFetch(events, state);

		const result = await streamOpenAICompletions(model(), context(), { apiKey: "test" }).result();

		// Non-vacuity: the guard really tripped on the sentinel.
		expect(result.errorCode).toBe(REPETITION_GUARD_ERROR_CODE);
		expect(thinkingText(result)).toContain(LEAK_SENTINEL);
		// ...and none of it reached the field the gateway publishes.
		expect(result.errorMessage).toBe(REPETITION_GUARD_STOP_MESSAGE);
		expect(result.errorMessage).not.toContain(LEAK_SENTINEL);
		expect(result.errorMessage).not.toContain("zzsentinelzz");
		expect(result.errorMessage).not.toContain("quota");
		expect(result.errorMessage).not.toContain("invalid");
		expect(result.errorMessage).not.toContain("forbidden");
	});

	// `feed()` closes a line only on `\n` and a token only on whitespace, so a
	// runaway stream whose last copy arrives unterminated used to finish as a
	// healthy turn. The guard is finalized at end of stream instead (#5627 r5).
	it("classifies a runaway turn whose final repeat has no trailing newline", async () => {
		const state: DeliveryState = { delivered: 0 };
		const events: Array<SseChunk | "[DONE]"> = [];
		for (let i = 0; i < THRESHOLD - 1; i++) events.push(chunk({ reasoning_content: `${SENTENCE}\n` }));
		// The threshold-completing copy never gets its newline.
		events.push(chunk({ reasoning_content: SENTENCE }), chunk({}, "stop"), "[DONE]");
		global.fetch = streamingFetch(events, state);

		const result = await streamOpenAICompletions(model(), context(), { apiKey: "test" }).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorCode).toBe(REPETITION_GUARD_ERROR_CODE);
		expect(result.errorMessage).toBe(REPETITION_GUARD_STOP_MESSAGE);
	});

	// The cases above reach the option by calling the provider directly. Callers
	// in this repository go through `streamSimple`/`completeSimple`, whose
	// options mapping dropped `repetitionGuard` on the floor — so the documented
	// opt-out was unreachable from the public API and a false-positive thinking
	// trip could not be switched off (#5627 review r5).
	function opinionatedRepeats(): SseEvent[] {
		const events: SseEvent[] = [];
		for (let i = 0; i < 60; i++) events.push(chunk({ reasoning_content: `${SENTENCE}\n` }));
		events.push(chunk({}, "stop"), "[DONE]");
		return events;
	}

	it("honours a repetitionGuard opt-out forwarded through streamSimple", async () => {
		const state: DeliveryState = { delivered: 0 };
		global.fetch = streamingFetch(opinionatedRepeats(), state);

		const result = await streamSimple(model(), context(), {
			apiKey: "test",
			repetitionGuard: { thinking: false },
		}).result();

		expect(countOccurrences(thinkingText(result), SENTENCE)).toBe(60);
		expect(result.stopReason).toBe("stop");
		expect(result.errorCode).toBeUndefined();
	});

	// Positive control: same fixture, same entry point, option omitted. Without
	// this the opt-out test could pass on a stream that never looped at all.
	it("still trips through streamSimple when no repetitionGuard option is given", async () => {
		const state: DeliveryState = { delivered: 0 };
		global.fetch = streamingFetch(opinionatedRepeats(), state);

		const result = await streamSimple(model(), context(), { apiKey: "test" }).result();

		expect(countOccurrences(thinkingText(result), SENTENCE)).toBeLessThanOrEqual(THRESHOLD);
		expect(result.stopReason).toBe("error");
		expect(result.errorCode).toBe(REPETITION_GUARD_ERROR_CODE);
	});
});

/**
 * `errorMessage` was already scrubbed for the gateway (#5627 r5), but the trip
 * site also called `logger.debug(..., { sample: trip.sample })`. `logger`'s
 * default transport is a rotating FILE under `~/.gjc/logs`, and `makeLogFormat`
 * JSON-stringifies every metadata key verbatim with no redaction — so a model
 * that looped on a secret or a private fragment of the prompt persisted it to
 * disk, where it travelled into rotation, support bundles and backups
 * (#5627 review r6).
 *
 * This drives the real transport rather than spying on the logger module: the
 * defect was about what lands in the FILE, so the file is what gets asserted.
 */
describe("chat-completions: repetition guard diagnostics never persist model text (#5627 r6)", () => {
	// Obviously fake, and shaped like something a scanner would flag, so a
	// regression is unmistakable in a diff.
	const SECRET = "sk-test-NOTAREALKEY-zzsentinelzz-4242";
	const LOOPED_LINE = `Retrying with credential ${SECRET}`;

	let logDir: string | undefined;

	afterEach(() => {
		// The module default (see packages/utils/src/logger.ts) — console off so
		// the TUI is not corrupted, file on.
		logger.setTransports({ file: true });
		if (logDir) {
			fs.rmSync(logDir, { recursive: true, force: true });
			logDir = undefined;
		}
	});

	/**
	 * winston's file transport writes asynchronously and the module imports
	 * winston lazily, so neither the file nor its contents exist on return from
	 * the awaited stream. Poll instead of sleeping a fixed amount, so a loaded
	 * CI box takes longer rather than failing.
	 */
	async function readLogsUntil(dir: string, marker: string, timeoutMs = 5_000): Promise<string> {
		const deadline = Date.now() + timeoutMs;
		let contents = "";
		while (Date.now() < deadline) {
			contents = fs
				.readdirSync(dir)
				.map(name => {
					try {
						return fs.readFileSync(path.join(dir, name), "utf8");
					} catch {
						// Mid-rotation rename; the next poll picks it up.
						return "";
					}
				})
				.join("");
			if (contents.includes(marker)) return contents;
			await new Promise(resolve => setTimeout(resolve, 25));
		}
		return contents;
	}

	it("writes the repetition-trip diagnostic without the repeated model text", async () => {
		// `os.tmpdir()`, not a hardcoded /tmp: on macOS this is $TMPDIR.
		logDir = fs.mkdtempSync(path.join(os.tmpdir(), "rf5627-logs-"));
		logger.setTransports({ console: false, file: logDir });

		const state: DeliveryState = { delivered: 0 };
		const events: Array<SseChunk | "[DONE]"> = [];
		for (let i = 0; i < 40; i++) events.push(chunk({ reasoning_content: `${LOOPED_LINE}\n` }));
		events.push(chunk({}, "stop"), "[DONE]");
		global.fetch = streamingFetch(events, state);

		const result = await streamOpenAICompletions(model(), context(), { apiKey: "test" }).result();

		// Non-vacuity, part 1: the guard really tripped on the sentinel line, and
		// the sentinel really was in the stream the provider consumed.
		expect(result.errorCode).toBe(REPETITION_GUARD_ERROR_CODE);
		expect(thinkingText(result)).toContain(SECRET);

		const contents = await readLogsUntil(logDir, "repetition guard tripped");

		// Non-vacuity, part 2: the diagnostic reached the file transport. Without
		// this half, a run that logged nothing at all would pass the negative
		// below — so these two come first.
		expect(contents).toContain("openai-completions: repetition guard tripped");
		expect(contents).toContain('"repeats":12');

		// The actual contract: no fragment of the repeated unit is on disk.
		expect(contents).not.toContain(SECRET);
		expect(contents).not.toContain("zzsentinelzz");
		expect(contents).not.toContain(LOOPED_LINE);
		expect(contents).not.toContain('"sample"');

		// Bounded, derived, model-uncontrollable — the replacement for `sample`.
		expect(contents).toContain(`"sampleLength":${LOOPED_LINE.length}`);
	});
});
