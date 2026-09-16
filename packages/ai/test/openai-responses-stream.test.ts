import { describe, expect, test } from "bun:test";
import { classifyFallbackTrigger, transportFailureFacts } from "@gajae-code/ai";
import { streamOpenAIResponses } from "@gajae-code/ai/providers/openai-responses";
import {
	isOpenAIResponsesProgressEvent,
	processResponsesStream,
} from "@gajae-code/ai/providers/openai-responses-shared";
import type { AssistantMessage, Model } from "@gajae-code/ai/types";
import type { AssistantMessageEventStream } from "@gajae-code/ai/utils/event-stream";
import type { ResponseStreamEvent } from "openai/resources/responses/responses";

// A generic Responses failure arrives inside an HTTP 200 stream — as a
// `response.failed` event or as a `response.completed` event whose response
// status is `failed` — so the envelope's typed `error.code` is the only
// structured evidence the transport can retain. The exact capacity-overload
// code must survive as typed facts; every other code (including case and
// padding variants) stays untyped so prose can never reach retry policy.

async function* makeStream(events: unknown[]): AsyncIterable<ResponseStreamEvent> {
	for (const event of events) yield event as ResponseStreamEvent;
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

function makeSink(): AssistantMessageEventStream {
	return { push: () => {}, end: () => {} } as never;
}

/** The three terminal envelope shapes that carry the same structured failure. */
type FailureShape = "response.failed" | "response.completed" | "response.completed.status_details";

const FAILURE_SHAPES: FailureShape[] = ["response.failed", "response.completed", "response.completed.status_details"];

function failureEvent(shape: FailureShape, code: string | undefined, message: string): unknown {
	const error = code === undefined ? { message } : { code, message };
	if (shape === "response.failed") return { type: "response.failed", response: { error } };
	if (shape === "response.completed") return { type: "response.completed", response: { status: "failed", error } };
	return { type: "response.completed", response: { status: "failed", status_details: { error } } };
}

async function streamError(events: unknown[]): Promise<unknown> {
	try {
		await processResponsesStream(makeStream(events), makeOutput(), makeSink(), makeModel());
	} catch (error) {
		return error;
	}
	throw new Error("Expected the terminal event to reject");
}

function failedResponseError(shape: FailureShape, code: string | undefined, message: string): Promise<unknown> {
	return streamError([failureEvent(shape, code, message)]);
}

const OVERLOAD_MESSAGE = "Our servers are currently overloaded. Please try again later.";
const OVERLOAD_CODE = "server_is_overloaded";

/** Serves one canned SSE stream so the provider's own catch/finalization runs. */
function sseFetch(events: unknown[]): typeof fetch {
	const body = `${events.map(event => `data: ${JSON.stringify(event)}`).join("\n\n")}\n\n`;
	return (async () =>
		new Response(body, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		})) as unknown as typeof fetch;
}

function streamProviderResult(events: unknown[]): Promise<AssistantMessage> {
	return streamOpenAIResponses(
		makeModel(),
		{ messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }] },
		{ apiKey: "test-key", fetch: sseFetch(events) },
	).result();
}

describe("Responses provider: bounded stream-failure classification", () => {
	test("classifies a non-overload HTTP 200 failed envelope without creating retry facts", async () => {
		for (const shape of FAILURE_SHAPES) {
			const error = await failedResponseError(shape, "server_error", OVERLOAD_MESSAGE);

			expect((error as Error).message).toBe(`server_error: ${OVERLOAD_MESSAGE}`);
			expect((error as { code?: string }).code).toBe("upstream_stream_interrupted");
			// The diagnostic classifier is not a transport fact, so it can never
			// authorize a replay.
			expect(transportFailureFacts(error)).toBeUndefined();
			expect(classifyFallbackTrigger(error)).toEqual({ class: "other" });
		}
	});

	test("classifies a top-level stream error event without creating retry facts", async () => {
		const error = await streamError([
			{ type: "error", code: "server_error", message: "stream interrupted before terminal event" },
		]);

		expect((error as { code?: string }).code).toBe("upstream_stream_interrupted");
		expect(transportFailureFacts(error)).toBeUndefined();
		expect(classifyFallbackTrigger(error)).toEqual({ class: "other" });
	});

	test("carries the bounded classifier onto the failed assistant message", async () => {
		for (const shape of FAILURE_SHAPES) {
			const result = await streamProviderResult([failureEvent(shape, "server_error", OVERLOAD_MESSAGE)]);

			expect(result.stopReason).toBe("error");
			expect(result.errorCode).toBe("upstream_stream_interrupted");
			expect(result.transportFailure).toBeUndefined();
		}
	});

	test("treats response.incomplete as a terminal event rather than an interruption", async () => {
		// The terminal frame must also count as progress, or a long silent tail before
		// it lets the idle watchdog abort and overwrite the derived `length`.
		expect(isOpenAIResponsesProgressEvent({ type: "response.incomplete" })).toBe(true);

		const result = await streamProviderResult([
			{ type: "response.created", response: { id: "resp_incomplete" } },
			{
				type: "response.incomplete",
				response: {
					id: "resp_incomplete",
					status: "incomplete",
					incomplete_details: { reason: "max_output_tokens" },
				},
			},
		]);

		// A length-limited stream is a normal terminal (`length`), never the
		// unexpected-EOF classifier.
		expect(result.stopReason).toBe("length");
		expect(result.errorCode).toBeUndefined();
		expect(result.transportFailure).toBeUndefined();
	});

	test("reports an unexpected EOF instead of a content-free success", async () => {
		// The parser reports that no terminal event was observed...
		expect(await processResponsesStream(makeStream([]), makeOutput(), makeSink(), makeModel())).toBe(false);

		// ...and the provider turns that into a bounded failure, not a `done` turn.
		const result = await streamProviderResult([]);
		expect(result.stopReason).toBe("error");
		expect(result.errorCode).toBe("upstream_stream_interrupted");
		expect(result.transportFailure).toBeUndefined();
		expect(result.content).toHaveLength(0);
	});
});

describe("Responses provider: generic terminal error codes", () => {
	test("preserves the exact capacity-overload code as typed transport facts", async () => {
		for (const shape of FAILURE_SHAPES) {
			const error = await failedResponseError(shape, OVERLOAD_CODE, OVERLOAD_MESSAGE);

			expect((error as Error).message).toBe(`${OVERLOAD_CODE}: ${OVERLOAD_MESSAGE}`);
			const facts = transportFailureFacts(error);
			expect(facts).toBeDefined();
			expect(facts?.providerCode).toBe(OVERLOAD_CODE);
			expect(facts?.openaiErrorCode).toBe(OVERLOAD_CODE);
			expect(facts?.status).toBeUndefined();
			expect(facts?.headers).toBeUndefined();
			expect(facts?.anthropicErrorType).toBeUndefined();
			expect(facts?.requestBytes).toBeUndefined();
			expect(facts?.retryMaxAttempts).toBeUndefined();
			expect(facts?.endpointClass).toBeUndefined();
			expect(classifyFallbackTrigger(facts)).toEqual({ class: "server" });
		}
	});

	test("re-normalizing the overload facts keeps them intact", async () => {
		for (const shape of FAILURE_SHAPES) {
			const facts = transportFailureFacts(await failedResponseError(shape, OVERLOAD_CODE, OVERLOAD_MESSAGE));

			expect(transportFailureFacts(facts)).toEqual(facts);
		}
	});

	test("leaves permanent, near-miss, and case-variant codes untyped and unclassified", async () => {
		for (const shape of FAILURE_SHAPES) {
			for (const code of [
				"server_error",
				"invalid_request_error",
				"server_is_overloaded_now",
				"SERVER_IS_OVERLOADED",
				"Server_Is_Overloaded",
				" server_is_overloaded",
				"server_is_overloaded ",
			]) {
				const error = await failedResponseError(shape, code, OVERLOAD_MESSAGE);

				expect((error as Error).message).toBe(`${code}: ${OVERLOAD_MESSAGE}`);
				expect(transportFailureFacts(error)).toBeUndefined();
				expect(classifyFallbackTrigger(error)).toEqual({ class: "other" });
			}
		}
	});

	test("leaves a cancelled response untyped even when it carries the overload code", async () => {
		// `cancelled` is not a capacity rejection: the request may already have
		// done observable work, so it must never reach a replay admission.
		const error = await streamError([
			{
				type: "response.completed",
				response: { status: "cancelled", error: { code: OVERLOAD_CODE, message: OVERLOAD_MESSAGE } },
			},
		]);

		expect((error as Error).message).toBe(`${OVERLOAD_CODE}: ${OVERLOAD_MESSAGE}`);
		expect(transportFailureFacts(error)).toBeUndefined();
	});

	test("keeps the existing display message for codeless and incomplete failures", async () => {
		for (const shape of FAILURE_SHAPES) {
			const codeless = await failedResponseError(shape, undefined, OVERLOAD_MESSAGE);
			expect((codeless as Error).message).toBe(`unknown: ${OVERLOAD_MESSAGE}`);
			expect(transportFailureFacts(codeless)).toBeUndefined();
		}

		const incomplete = await streamError([
			{ type: "response.failed", response: { incomplete_details: { reason: "max_output_tokens" } } },
		]);
		expect((incomplete as Error).message).toBe("incomplete: max_output_tokens");
		expect(transportFailureFacts(incomplete)).toBeUndefined();
	});
});

describe("Responses provider: terminal overload through provider finalization", () => {
	test("surfaces the typed overload on the failed assistant message", async () => {
		for (const shape of FAILURE_SHAPES) {
			const result = await streamProviderResult([failureEvent(shape, OVERLOAD_CODE, OVERLOAD_MESSAGE)]);

			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toContain(`${OVERLOAD_CODE}: ${OVERLOAD_MESSAGE}`);
			expect(result.errorStatus).toBeUndefined();
			expect(result.transportFailure).toMatchObject({
				kind: "transport",
				providerCode: OVERLOAD_CODE,
				openaiErrorCode: OVERLOAD_CODE,
			});
			expect(result.transportFailure?.status).toBeUndefined();
			expect(result.transportFailure?.headers).toBeUndefined();
			expect(result.transportFailure?.retryMaxAttempts).toBeUndefined();
			expect(classifyFallbackTrigger(result.transportFailure)).toEqual({ class: "server" });
		}
	});

	test("leaves near-miss and case-variant codes without transport facts", async () => {
		for (const code of ["server_error", "server_is_overloaded_now", "SERVER_IS_OVERLOADED"]) {
			const result = await streamProviderResult([failureEvent("response.failed", code, OVERLOAD_MESSAGE)]);

			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toContain(`${code}: ${OVERLOAD_MESSAGE}`);
			expect(result.transportFailure).toBeUndefined();
		}
	});
});
