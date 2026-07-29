import { afterEach, describe, expect, it } from "bun:test";
import { getBundledModel } from "../src/models";
import { streamAzureOpenAIResponses } from "../src/providers/azure-openai-responses";
import { streamOpenAICompletions } from "../src/providers/openai-completions";
import { streamOpenAIResponses } from "../src/providers/openai-responses";
import type { Context, Model, TextContent } from "../src/types";
import { waitForDelayOrAbort } from "./helpers";

const originalFetch = global.fetch;

const openAIResponsesModel = getBundledModel("openai", "gpt-5-mini") as Model<"openai-responses">;
const openAICompletionsModel = {
	...(getBundledModel("openai", "gpt-4o-mini") as Model<"openai-completions">),
	api: "openai-completions",
} satisfies Model<"openai-completions">;
const azureOpenAIResponsesModel: Model<"azure-openai-responses"> = {
	id: "gpt-5-mini",
	name: "GPT-5 Mini",
	api: "azure-openai-responses",
	provider: "azure",
	baseUrl: "https://example.openai.azure.com/openai/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 400000,
	maxTokens: 128000,
};

function baseContext(): Context {
	return {
		messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
	};
}

function getRequestSignal(input: string | URL | Request, init: RequestInit | undefined): AbortSignal | undefined {
	if (init?.signal) {
		return init.signal;
	}
	if (input instanceof Request) {
		return input.signal;
	}
	return undefined;
}

function createHangingSseResponse(signal: AbortSignal | undefined): Response {
	let abortListener: (() => void) | undefined;
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			abortListener = () => {
				if (abortListener) {
					signal?.removeEventListener("abort", abortListener);
				}
				const reason = signal?.reason;
				if (reason instanceof Error) {
					controller.error(reason);
					return;
				}
				controller.error(new Error("request aborted"));
			};
			if (signal?.aborted) {
				queueMicrotask(() => abortListener?.());
				return;
			}
			signal?.addEventListener("abort", abortListener, { once: true });
		},
		cancel() {
			if (abortListener) {
				signal?.removeEventListener("abort", abortListener);
			}
		},
	});
	return new Response(stream, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function createHangingFetch(): typeof fetch {
	async function mockFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
		return createHangingSseResponse(getRequestSignal(input, init));
	}

	return Object.assign(mockFetch, { preconnect: originalFetch.preconnect });
}

function createSseResponse(events: unknown[]): Response {
	const payload = `${events.map(event => `data: ${typeof event === "string" ? event : JSON.stringify(event)}`).join("\n\n")}\n\n`;
	return new Response(payload, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function createNoProgressOpenAIResponsesStream(signal: AbortSignal | undefined): Response {
	const encoder = new TextEncoder();
	let interval: NodeJS.Timeout | undefined;
	let abortListener: (() => void) | undefined;
	const encode = (event: unknown): Uint8Array => encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(encode({ type: "response.created", response: { id: "resp_stalled" } }));
			controller.enqueue(
				encode({
					type: "response.output_item.added",
					item: {
						type: "function_call",
						id: "fc_stalled",
						call_id: "call_stalled",
						name: "todo_write",
						arguments: "",
						status: "in_progress",
					},
				}),
			);
			interval = setInterval(() => {
				controller.enqueue(
					encode({
						type: "response.in_progress",
						response: { id: "resp_stalled", status: "in_progress" },
					}),
				);
			}, 2);
			abortListener = () => {
				if (interval) clearInterval(interval);
				if (abortListener) signal?.removeEventListener("abort", abortListener);
				const reason = signal?.reason;
				controller.error(reason instanceof Error ? reason : new Error("request aborted"));
			};
			if (signal?.aborted) {
				queueMicrotask(() => abortListener?.());
			} else {
				signal?.addEventListener("abort", abortListener, { once: true });
			}
		},
		cancel() {
			if (interval) clearInterval(interval);
			if (abortListener) signal?.removeEventListener("abort", abortListener);
		},
	});
	return new Response(stream, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function createDelayedFetch(delayMs: number, responseFactory: () => Response): typeof fetch {
	async function mockFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
		await waitForDelayOrAbort(delayMs, getRequestSignal(input, init));
		return responseFactory();
	}

	return Object.assign(mockFetch, { preconnect: originalFetch.preconnect });
}

function createOpenAIResponsesSuccessResponse(): Response {
	return createSseResponse([
		{ type: "response.created", response: { id: "resp_delayed" } },
		{
			type: "response.output_item.added",
			item: { type: "message", id: "msg_delayed", role: "assistant", status: "in_progress", content: [] },
		},
		{ type: "response.content_part.added", part: { type: "output_text", text: "" } },
		{ type: "response.output_text.delta", delta: "Hello delayed" },
		{
			type: "response.output_item.done",
			item: {
				type: "message",
				id: "msg_delayed",
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text: "Hello delayed" }],
			},
		},
		{
			type: "response.completed",
			response: {
				id: "resp_delayed",
				status: "completed",
				usage: {
					input_tokens: 5,
					output_tokens: 2,
					total_tokens: 7,
					input_tokens_details: { cached_tokens: 0 },
				},
			},
		},
	]);
}

function createOpenAICompletionsSuccessResponse(modelId: string): Response {
	return createSseResponse([
		{
			id: "chatcmpl-delayed",
			object: "chat.completion.chunk",
			created: 0,
			model: modelId,
			choices: [{ index: 0, delta: { content: "Hello delayed" } }],
		},
		{
			id: "chatcmpl-delayed",
			object: "chat.completion.chunk",
			created: 0,
			model: modelId,
			choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			usage: {
				prompt_tokens: 5,
				completion_tokens: 2,
				total_tokens: 7,
				prompt_tokens_details: { cached_tokens: 0 },
			},
		},
		"[DONE]",
	]);
}

async function expectFirstEventTimeout(
	run: (
		streamFirstEventTimeoutMs: number,
	) => Promise<{ stopReason: string; errorMessage?: string; transportFailure?: { providerCode?: string } }>,
	expectedMessage: string,
	expectedProviderCode?: string,
): Promise<void> {
	global.fetch = createHangingFetch();

	const result = await run(20);

	expect(result.stopReason).toBe("error");
	expect(result.errorMessage).toBe(expectedMessage);
	if (expectedProviderCode) expect(result.transportFailure?.providerCode).toBe(expectedProviderCode);
}

async function expectCallerAbort(
	run: (
		signal: AbortSignal,
		streamFirstEventTimeoutMs: number,
	) => Promise<{ stopReason: string; errorMessage?: string }>,
	unexpectedMessage: string,
): Promise<void> {
	global.fetch = createHangingFetch();
	const controller = new AbortController();
	setTimeout(() => controller.abort(), 5);

	const result = await run(controller.signal, 50);

	expect(result.stopReason).toBe("aborted");
	expect(result.errorMessage).not.toBe(unexpectedMessage);
	expect((result.errorMessage ?? "").toLowerCase()).toContain("abort");
}

function getFirstTextContent(result: { content: unknown[] }): TextContent | undefined {
	return result.content.find((content): content is TextContent => {
		return typeof content === "object" && content !== null && "type" in content && content.type === "text";
	});
}

async function expectDelayedRequestSetupSucceeds(
	run: (streamFirstEventTimeoutMs: number) => Promise<{ stopReason: string; content: unknown[] }>,
	responseFactory: () => Response,
): Promise<void> {
	global.fetch = createDelayedFetch(30, responseFactory);

	const result = await run(20);

	expect(result.stopReason).toBe("stop");
	expect(getFirstTextContent(result)).toMatchObject({ type: "text", text: "Hello delayed" });
}

afterEach(() => {
	global.fetch = originalFetch;
});

describe("OpenAI-family first-event timeouts", () => {
	it("surfaces the OpenAI responses first-event timeout message instead of a generic abort", async () => {
		await expectFirstEventTimeout(
			streamFirstEventTimeoutMs =>
				streamOpenAIResponses(openAIResponsesModel, baseContext(), {
					apiKey: "test-key",
					streamFirstEventTimeoutMs,
				}).result(),
			"OpenAI responses stream timed out while waiting for the first event",
			"stream_first_event_timeout",
		);
	});

	it("times out OpenAI responses streams that only emit no-progress status events", async () => {
		global.fetch = ((input: string | URL | Request, init?: RequestInit) =>
			Promise.resolve(createNoProgressOpenAIResponsesStream(getRequestSignal(input, init)))) as typeof fetch;

		const result = await streamOpenAIResponses(openAIResponsesModel, baseContext(), {
			apiKey: "test-key",
			streamFirstEventTimeoutMs: 1_000,
			streamIdleTimeoutMs: 20,
		}).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("OpenAI responses stream stalled while waiting for the next event");
		expect(result.content as unknown[]).toEqual([
			{
				type: "toolCall",
				id: "call_stalled|fc_stalled",
				name: "todo_write",
				arguments: {},
				partialJson: "",
			},
		]);
	});

	it("surfaces the OpenAI completions first-event timeout message", async () => {
		await expectFirstEventTimeout(
			streamFirstEventTimeoutMs =>
				streamOpenAICompletions(openAICompletionsModel, baseContext(), {
					apiKey: "test-key",
					streamFirstEventTimeoutMs,
				}).result(),
			"OpenAI completions stream timed out while waiting for the first event",
			"stream_first_event_timeout",
		);
	});

	it("surfaces the Azure OpenAI responses first-event timeout message", async () => {
		await expectFirstEventTimeout(
			streamFirstEventTimeoutMs =>
				streamAzureOpenAIResponses(azureOpenAIResponsesModel, baseContext(), {
					apiKey: "test-key",
					azureBaseUrl: azureOpenAIResponsesModel.baseUrl,
					azureApiVersion: "v1",
					streamFirstEventTimeoutMs,
				}).result(),
			"Azure OpenAI responses stream timed out while waiting for the first event",
			"stream_first_event_timeout",
		);
	});

	it("keeps caller aborts as aborted for OpenAI responses", async () => {
		await expectCallerAbort(
			(signal, streamFirstEventTimeoutMs) =>
				streamOpenAIResponses(openAIResponsesModel, baseContext(), {
					apiKey: "test-key",
					signal,
					streamFirstEventTimeoutMs,
				}).result(),
			"OpenAI responses stream timed out while waiting for the first event",
		);
	});

	it("keeps caller aborts as aborted for OpenAI completions", async () => {
		await expectCallerAbort(
			(signal, streamFirstEventTimeoutMs) =>
				streamOpenAICompletions(openAICompletionsModel, baseContext(), {
					apiKey: "test-key",
					signal,
					streamFirstEventTimeoutMs,
				}).result(),
			"OpenAI completions stream timed out while waiting for the first event",
		);
	});

	it("keeps caller aborts as aborted for Azure OpenAI responses", async () => {
		await expectCallerAbort(
			(signal, streamFirstEventTimeoutMs) =>
				streamAzureOpenAIResponses(azureOpenAIResponsesModel, baseContext(), {
					apiKey: "test-key",
					azureBaseUrl: azureOpenAIResponsesModel.baseUrl,
					azureApiVersion: "v1",
					signal,
					streamFirstEventTimeoutMs,
				}).result(),
			"Azure OpenAI responses stream timed out while waiting for the first event",
		);
	});

	it("does not arm the first-event watchdog before OpenAI responses stream setup finishes", async () => {
		await expectDelayedRequestSetupSucceeds(
			streamFirstEventTimeoutMs =>
				streamOpenAIResponses(openAIResponsesModel, baseContext(), {
					apiKey: "test-key",
					streamFirstEventTimeoutMs,
				}).result(),
			createOpenAIResponsesSuccessResponse,
		);
	});

	it("does not arm the first-event watchdog before OpenAI completions stream setup finishes", async () => {
		await expectDelayedRequestSetupSucceeds(
			streamFirstEventTimeoutMs =>
				streamOpenAICompletions(openAICompletionsModel, baseContext(), {
					apiKey: "test-key",
					streamFirstEventTimeoutMs,
				}).result(),
			() => createOpenAICompletionsSuccessResponse(openAICompletionsModel.id),
		);
	});

	it("does not arm the first-event watchdog before Azure OpenAI responses setup finishes", async () => {
		await expectDelayedRequestSetupSucceeds(
			streamFirstEventTimeoutMs =>
				streamAzureOpenAIResponses(azureOpenAIResponsesModel, baseContext(), {
					apiKey: "test-key",
					azureBaseUrl: azureOpenAIResponsesModel.baseUrl,
					azureApiVersion: "v1",
					streamFirstEventTimeoutMs,
				}).result(),
			createOpenAIResponsesSuccessResponse,
		);
	});
});
