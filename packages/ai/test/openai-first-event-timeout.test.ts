import { afterEach, describe, expect, it, vi } from "bun:test";
import { getBundledModel } from "../src/models";
import { streamAzureOpenAIResponses } from "../src/providers/azure-openai-responses";
import { streamOpenAICompletions } from "../src/providers/openai-completions";
import { streamOpenAIResponses } from "../src/providers/openai-responses";
import type { Context, Model, TextContent } from "../src/types";
import { waitForDelayOrAbort, withEnv } from "./helpers";

const originalFetch = global.fetch;

const openAIResponsesModel = getBundledModel("openai", "gpt-5-mini") as Model<"openai-responses">;
const openAICompletionsModel = {
	...(getBundledModel("openai", "gpt-4o-mini") as Model<"openai-completions">),
	api: "openai-completions",
} satisfies Model<"openai-completions">;
const alibabaOpenAIResponsesModel = getBundledModel(
	"alibaba-token-plan",
	"qwen3.8-max-preview",
) as Model<"openai-responses">;
const alibabaOpenAICompletionsModel = getBundledModel(
	"alibaba-token-plan",
	"deepseek-v4-pro",
) as Model<"openai-completions">;
const lmStudioCompletionsModel: Model<"openai-completions"> = {
	id: "local-model",
	name: "LM Studio Local Model",
	api: "openai-completions",
	provider: "lm-studio",
	baseUrl: "http://127.0.0.1:1234/v1",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 32768,
	maxTokens: 4096,
};
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

function createAbortIgnoringHangingFetch(): typeof fetch {
	async function mockFetch(): Promise<Response> {
		return new Response(
			new ReadableStream<Uint8Array>({
				start() {},
			}),
			{
				status: 200,
				headers: { "content-type": "text/event-stream" },
			},
		);
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

function createNoProgressOpenAICompletionsStream(signal: AbortSignal | undefined): Response {
	const encoder = new TextEncoder();
	let interval: NodeJS.Timeout | undefined;
	let abortListener: (() => void) | undefined;
	const encode = (event: unknown): Uint8Array => encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(
				encode({
					id: "chatcmpl-stalled",
					object: "chat.completion.chunk",
					created: 0,
					model: openAICompletionsModel.id,
					choices: [{ index: 0, delta: { content: "partial" }, finish_reason: null }],
				}),
			);
			interval = setInterval(() => {
				controller.enqueue(
					encode({
						id: "chatcmpl-stalled",
						object: "chat.completion.chunk",
						created: 0,
						model: openAICompletionsModel.id,
						choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
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

async function flushMicrotasks(ticks = 40): Promise<void> {
	for (let i = 0; i < ticks; i++) await Promise.resolve();
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
	vi.useRealTimers();
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

	it("honors explicit idle timeouts inside OpenAI completions streams", async () => {
		global.fetch = ((input: string | URL | Request, init?: RequestInit) =>
			Promise.resolve(createNoProgressOpenAICompletionsStream(getRequestSignal(input, init)))) as typeof fetch;

		const result = await streamOpenAICompletions(openAICompletionsModel, baseContext(), {
			apiKey: "test-key",
			streamFirstEventTimeoutMs: 1_000,
			streamIdleTimeoutMs: 20,
		}).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("OpenAI completions stream stalled while waiting for the next event");
		expect(result.content).toContainEqual({ type: "text", text: "partial" });
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

	it("does not let Azure status events keep an idle stream alive", async () => {
		global.fetch = ((input: string | URL | Request, init?: RequestInit) =>
			Promise.resolve(createNoProgressOpenAIResponsesStream(getRequestSignal(input, init)))) as typeof fetch;

		const result = await streamAzureOpenAIResponses(azureOpenAIResponsesModel, baseContext(), {
			apiKey: "test-key",
			streamFirstEventTimeoutMs: 1_000,
			streamIdleTimeoutMs: 20,
		}).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("Azure OpenAI responses stream stalled while waiting for the next event");
		expect(result.content).toContainEqual(expect.objectContaining({ type: "toolCall", name: "todo_write" }));
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
		global.fetch = createAbortIgnoringHangingFetch();
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 5);

		const streamResult = streamAzureOpenAIResponses(azureOpenAIResponsesModel, baseContext(), {
			apiKey: "test-key",
			azureBaseUrl: azureOpenAIResponsesModel.baseUrl,
			azureApiVersion: "v1",
			signal: controller.signal,
			streamFirstEventTimeoutMs: 1_000,
		}).result();
		const result = await Promise.race([
			streamResult,
			Bun.sleep(100).then(() => {
				throw new Error("Azure caller abort did not settle before the first-event timeout");
			}),
		]);

		expect(result.stopReason).toBe("aborted");
		expect((result.errorMessage ?? "").toLowerCase()).toContain("abort");
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

	it("lets Alibaba completions wait past the old 120s SDK timeout for response headers", async () => {
		vi.useFakeTimers();
		await withEnv({ PI_STREAM_FIRST_EVENT_TIMEOUT_MS: undefined }, async () => {
			let fetchAttempts = 0;
			const delayedFetch = createDelayedFetch(150_000, () =>
				createOpenAICompletionsSuccessResponse(alibabaOpenAICompletionsModel.id),
			);
			global.fetch = Object.assign(
				async (input: string | URL | Request, init?: RequestInit) => {
					fetchAttempts++;
					return delayedFetch(input, init);
				},
				{ preconnect: originalFetch.preconnect },
			);

			const pending = streamOpenAICompletions(alibabaOpenAICompletionsModel, baseContext(), {
				apiKey: "test-key",
				requestMaxRetries: 0,
			}).result();
			await flushMicrotasks();
			expect(fetchAttempts).toBe(1);

			vi.advanceTimersByTime(120_000);
			await flushMicrotasks();
			let settled = false;
			void pending.then(() => {
				settled = true;
			});
			await flushMicrotasks();
			expect(settled).toBe(false);

			vi.advanceTimersByTime(30_000);
			await flushMicrotasks();
			const result = await pending;
			expect(result.stopReason).toBe("stop");
			expect(getFirstTextContent(result)).toMatchObject({ type: "text", text: "Hello delayed" });
		});
	});

	it("lets LM Studio completions wait past the shared 120s SDK timeout for local model startup", async () => {
		vi.useFakeTimers();
		await withEnv({ PI_STREAM_FIRST_EVENT_TIMEOUT_MS: undefined }, async () => {
			const delayedFetch = createDelayedFetch(150_000, () =>
				createOpenAICompletionsSuccessResponse(lmStudioCompletionsModel.id),
			);
			global.fetch = Object.assign(delayedFetch, { preconnect: originalFetch.preconnect });

			const pending = streamOpenAICompletions(lmStudioCompletionsModel, baseContext(), {
				apiKey: "test-key",
				requestMaxRetries: 0,
			}).result();
			await flushMicrotasks();

			vi.advanceTimersByTime(120_000);
			await flushMicrotasks();
			let settled = false;
			void pending.then(() => {
				settled = true;
			});
			await flushMicrotasks();
			expect(settled).toBe(false);

			vi.advanceTimersByTime(30_000);
			await flushMicrotasks();
			const result = await pending;
			expect(result.stopReason).toBe("stop");
			expect(getFirstTextContent(result)).toMatchObject({ type: "text", text: "Hello delayed" });
		});
	});

	it("honors a shorter Alibaba completions caller timeout before response headers", async () => {
		vi.useFakeTimers();
		await withEnv({ PI_STREAM_FIRST_EVENT_TIMEOUT_MS: undefined }, async () => {
			let fetchAttempts = 0;
			const delayedFetch = createDelayedFetch(60_000, () =>
				createOpenAICompletionsSuccessResponse(alibabaOpenAICompletionsModel.id),
			);
			global.fetch = Object.assign(
				async (input: string | URL | Request, init?: RequestInit) => {
					fetchAttempts++;
					return delayedFetch(input, init);
				},
				{ preconnect: originalFetch.preconnect },
			);

			const pending = streamOpenAICompletions(alibabaOpenAICompletionsModel, baseContext(), {
				apiKey: "test-key",
				requestMaxRetries: 0,
				streamFirstEventTimeoutMs: 5_000,
			}).result();
			await flushMicrotasks();
			vi.advanceTimersByTime(5_000);
			await flushMicrotasks(100);
			const result = await pending;

			expect(fetchAttempts).toBe(1);
			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toBe("OpenAI completions stream timed out while waiting for the first event");
			expect(result.transportFailure?.providerCode).toBe("stream_first_event_timeout");
		});
	});

	it("normalizes an Alibaba completions SDK setup timeout as a typed first-event timeout", async () => {
		vi.useFakeTimers();
		await withEnv({ PI_STREAM_FIRST_EVENT_TIMEOUT_MS: "5000" }, async () => {
			let fetchAttempts = 0;
			const delayedFetch = createDelayedFetch(60_000, () =>
				createOpenAICompletionsSuccessResponse(alibabaOpenAICompletionsModel.id),
			);
			global.fetch = Object.assign(
				async (input: string | URL | Request, init?: RequestInit) => {
					fetchAttempts++;
					return delayedFetch(input, init);
				},
				{ preconnect: originalFetch.preconnect },
			);

			const pending = streamOpenAICompletions(alibabaOpenAICompletionsModel, baseContext(), {
				apiKey: "test-key",
				requestMaxRetries: 0,
			}).result();
			await flushMicrotasks();
			vi.advanceTimersByTime(5_000);
			await flushMicrotasks(100);
			const result = await pending;

			expect(fetchAttempts).toBe(1);
			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toBe("OpenAI completions stream timed out while waiting for the first event");
			expect(result.transportFailure?.providerCode).toBe("stream_first_event_timeout");
		});
	});

	it("normalizes an Alibaba responses SDK setup timeout as a typed first-event timeout", async () => {
		vi.useFakeTimers();
		let fetchAttempts = 0;
		const delayedFetch = createDelayedFetch(700_000, createOpenAIResponsesSuccessResponse);
		global.fetch = Object.assign(
			async (input: string | URL | Request, init?: RequestInit) => {
				fetchAttempts++;
				return delayedFetch(input, init);
			},
			{ preconnect: originalFetch.preconnect },
		);

		const pending = streamOpenAIResponses(alibabaOpenAIResponsesModel, baseContext(), {
			apiKey: "test-key",
			requestMaxRetries: 0,
		}).result();
		await flushMicrotasks();
		vi.advanceTimersByTime(600_000);
		await flushMicrotasks(100);
		const result = await pending;

		expect(fetchAttempts).toBe(1);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("OpenAI responses stream timed out while waiting for the first event");
		expect(result.transportFailure?.providerCode).toBe("stream_first_event_timeout");
	});

	it("honors a shorter Alibaba responses caller timeout before response headers", async () => {
		vi.useFakeTimers();
		await withEnv({ PI_STREAM_FIRST_EVENT_TIMEOUT_MS: undefined }, async () => {
			let fetchAttempts = 0;
			const delayedFetch = createDelayedFetch(60_000, createOpenAIResponsesSuccessResponse);
			global.fetch = Object.assign(
				async (input: string | URL | Request, init?: RequestInit) => {
					fetchAttempts++;
					return delayedFetch(input, init);
				},
				{ preconnect: originalFetch.preconnect },
			);

			const pending = streamOpenAIResponses(alibabaOpenAIResponsesModel, baseContext(), {
				apiKey: "test-key",
				requestMaxRetries: 0,
				streamFirstEventTimeoutMs: 5_000,
			}).result();
			await flushMicrotasks();
			vi.advanceTimersByTime(5_000);
			await flushMicrotasks(100);
			const result = await pending;

			expect(fetchAttempts).toBe(1);
			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toBe("OpenAI responses stream timed out while waiting for the first event");
			expect(result.transportFailure?.providerCode).toBe("stream_first_event_timeout");
		});
	});

	it("honors an env-pinned Azure responses setup timeout before response headers", async () => {
		vi.useFakeTimers();
		await withEnv({ PI_STREAM_FIRST_EVENT_TIMEOUT_MS: "5000" }, async () => {
			let fetchAttempts = 0;
			const delayedFetch = createDelayedFetch(60_000, createOpenAIResponsesSuccessResponse);
			global.fetch = Object.assign(
				async (input: string | URL | Request, init?: RequestInit) => {
					fetchAttempts++;
					return delayedFetch(input, init);
				},
				{ preconnect: originalFetch.preconnect },
			);

			const pending = streamAzureOpenAIResponses(azureOpenAIResponsesModel, baseContext(), {
				apiKey: "test-key",
				azureBaseUrl: azureOpenAIResponsesModel.baseUrl,
				azureApiVersion: "v1",
				requestMaxRetries: 0,
			}).result();
			await flushMicrotasks();
			vi.advanceTimersByTime(5_000);
			await flushMicrotasks(100);
			const result = await pending;

			expect(fetchAttempts).toBe(1);
			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toBe("Azure OpenAI responses stream timed out while waiting for the first event");
			expect(result.transportFailure?.providerCode).toBe("stream_first_event_timeout");
		});
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
