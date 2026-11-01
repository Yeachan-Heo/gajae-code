import { afterEach, describe, expect, it, vi } from "bun:test";
import { stream } from "@gajae-code/ai/stream";
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

function createStalledOpenAICompletionsStream(signal: AbortSignal | undefined, modelId: string): Response {
	const encoder = new TextEncoder();
	let abortListener: (() => void) | undefined;
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(
				encoder.encode(
					`data: ${JSON.stringify({
						id: "chatcmpl-stalled",
						object: "chat.completion.chunk",
						created: 0,
						model: modelId,
						choices: [{ index: 0, delta: { content: "partial" }, finish_reason: null }],
					})}\n\n`,
				),
			);
			abortListener = () => {
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
			if (abortListener) signal?.removeEventListener("abort", abortListener);
		},
	});
	return new Response(stream, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function createStalledOpenAIResponsesStream(signal: AbortSignal | undefined): Response {
	const encoder = new TextEncoder();
	let abortListener: (() => void) | undefined;
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			const events = [
				{ type: "response.created", response: { id: "resp_stalled" } },
				{ type: "response.in_progress", response: { id: "resp_stalled", status: "in_progress" } },
			];
			controller.enqueue(
				encoder.encode(`${events.map(event => `data: ${JSON.stringify(event)}`).join("\n\n")}\n\n`),
			);
			abortListener = () => {
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

	it("surfaces OpenAI completions first-event timeout diagnostics for the canonical endpoint", async () => {
		global.fetch = createHangingFetch();

		const result = await streamOpenAICompletions(openAICompletionsModel, baseContext(), {
			apiKey: "test-key",
			streamFirstEventTimeoutMs: 20,
		}).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toMatch(
			/^OpenAI completions stream timed out while waiting for the first event \(elapsed=\d+ms request_bytes=\d+ endpoint=canonical configured_timeout=20ms; override with retry\.streamFirstEventTimeoutMs or PI_STREAM_FIRST_EVENT_TIMEOUT_MS\)$/,
		);
		const requestBytes = Number(/request_bytes=(\d+)/.exec(result.errorMessage ?? "")?.[1]);
		const elapsedMs = Number(/elapsed=(\d+)ms/.exec(result.errorMessage ?? "")?.[1]);
		expect(requestBytes).toBeGreaterThan(0);
		expect(elapsedMs).toBeGreaterThanOrEqual(20);
		expect(result.transportFailure).toMatchObject({
			providerCode: "stream_first_event_timeout",
			requestBytes,
			firstEventElapsedMs: elapsedMs,
			firstEventTimeoutMs: 20,
			endpointClass: "canonical",
		});
		expect(result.transportFailure?.retryMaxAttempts).toBeUndefined();
	});

	it("classifies a custom openai-completions proxy endpoint without leaking its URL", async () => {
		global.fetch = createHangingFetch();
		const proxyModel: Model<"openai-completions"> = {
			...openAICompletionsModel,
			provider: "cliproxy",
			id: "claude-opus-4-1",
			baseUrl: "http://user:secret@127.0.0.1:8317/v1?token=secret",
		};

		const result = await streamOpenAICompletions(proxyModel, baseContext(), {
			apiKey: "test-key",
			streamFirstEventTimeoutMs: 20,
		}).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("endpoint=custom configured_timeout=20ms");
		expect(result.errorMessage).not.toContain("127.0.0.1");
		expect(result.errorMessage).not.toContain("secret");
		expect(result.transportFailure).toMatchObject({
			providerCode: "stream_first_event_timeout",
			endpointClass: "custom",
		});
	});

	it("classifies a bundled provider's catalog base URL as canonical and an override as custom", async () => {
		const openRouterModel = getBundledModel("openrouter", "openai/gpt-4o-mini") as Model<"openai-completions">;
		if (!openRouterModel) throw new Error("Expected bundled openrouter test model");
		for (const [baseUrl, endpointClass] of [
			[openRouterModel.baseUrl, "canonical"],
			["https://openrouter.example.test/api/v1", "custom"],
		] as const) {
			global.fetch = createHangingFetch();
			const result = await streamOpenAICompletions({ ...openRouterModel, baseUrl }, baseContext(), {
				apiKey: "test-key",
				streamFirstEventTimeoutMs: 20,
			}).result();
			expect(result.errorMessage).toContain(`endpoint=${endpointClass} `);
			expect(result.transportFailure?.endpointClass).toBe(endpointClass);
		}
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

	it("uses a configured model idle timeout for custom OpenAI-compatible providers", async () => {
		await withEnv(
			{
				GJC_OPENAI_STREAM_IDLE_TIMEOUT_MS: "invalid",
				PI_STREAM_IDLE_TIMEOUT_MS: undefined,
				PI_OPENAI_STREAM_IDLE_TIMEOUT_MS: undefined,
			},
			async () => {
				const model: Model<"openai-completions"> = {
					...openAICompletionsModel,
					id: "claude-opus-5-5",
					name: "Claude Opus 5.5 via proxy",
					provider: "custom-proxy",
					baseUrl: "https://proxy.example.com/v1",
					streamIdleTimeoutMs: 20,
				};
				global.fetch = ((input: string | URL | Request, init?: RequestInit) =>
					Promise.resolve(
						createStalledOpenAICompletionsStream(getRequestSignal(input, init), model.id),
					)) as typeof fetch;

				const controller = new AbortController();
				const pending = streamOpenAICompletions(model, baseContext(), {
					apiKey: "test-key",
					signal: controller.signal,
					streamFirstEventTimeoutMs: 1_000,
				}).result();
				let settled = false;
				void pending.then(() => {
					settled = true;
				});
				await Bun.sleep(75);
				const timedOutAtConfiguredWindow = settled;
				if (!settled) {
					// Stop the stream instead of leaking a pending 120s-default watchdog
					// when the configured timeout is ignored.
					controller.abort(new Error("test cleanup"));
				}
				const result = await pending;

				expect(timedOutAtConfiguredWindow).toBe(true);
				expect(result.stopReason).toBe("error");
				expect(result.errorMessage).toBe("OpenAI completions stream stalled while waiting for the next event");
			},
		);
	});

	it("uses a configured model idle timeout for OpenAI Responses proxies", async () => {
		await withEnv(
			{
				GJC_OPENAI_STREAM_IDLE_TIMEOUT_MS: "invalid",
				PI_STREAM_IDLE_TIMEOUT_MS: undefined,
				PI_OPENAI_STREAM_IDLE_TIMEOUT_MS: undefined,
			},
			async () => {
				const model: Model<"openai-responses"> = {
					...openAIResponsesModel,
					id: "claude-opus-5-5",
					name: "Claude Opus 5.5 via proxy",
					provider: "custom-proxy",
					baseUrl: "https://proxy.example.com/v1",
					streamIdleTimeoutMs: 20,
				};
				global.fetch = ((input: string | URL | Request, init?: RequestInit) =>
					Promise.resolve(createStalledOpenAIResponsesStream(getRequestSignal(input, init)))) as typeof fetch;

				const controller = new AbortController();
				const pending = streamOpenAIResponses(model, baseContext(), {
					apiKey: "test-key",
					signal: controller.signal,
					streamFirstEventTimeoutMs: 1_000,
				}).result();
				let settled = false;
				void pending.then(() => {
					settled = true;
				});
				await Bun.sleep(75);
				const timedOutAtConfiguredWindow = settled;
				if (!settled) {
					controller.abort(new Error("test cleanup"));
				}
				const result = await pending;

				expect(timedOutAtConfiguredWindow).toBe(true);
				expect(result.stopReason).toBe("error");
				expect(result.errorMessage).toBe("OpenAI responses stream stalled while waiting for the next event");
			},
		);
	});

	it("uses the longer request idle timeout for OpenAI completions setup", async () => {
		vi.useFakeTimers();
		await withEnv(
			{
				GJC_OPENAI_STREAM_IDLE_TIMEOUT_MS: undefined,
				PI_STREAM_IDLE_TIMEOUT_MS: undefined,
				PI_OPENAI_STREAM_IDLE_TIMEOUT_MS: undefined,
				PI_STREAM_FIRST_EVENT_TIMEOUT_MS: undefined,
			},
			async () => {
				const model: Model<"openai-completions"> = {
					...openAICompletionsModel,
					provider: "custom-proxy",
					baseUrl: "https://proxy.example.com/v1",
					streamIdleTimeoutMs: 120_000,
				};
				const delayedFetch = createDelayedFetch(150_000, () => createOpenAICompletionsSuccessResponse(model.id));
				global.fetch = Object.assign(delayedFetch, { preconnect: originalFetch.preconnect });

				const pending = streamOpenAICompletions(model, baseContext(), {
					apiKey: "test-key",
					requestMaxRetries: 0,
					streamIdleTimeoutMs: 300_000,
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
			},
		);
	});

	it("uses the longer request idle timeout for OpenAI Responses setup", async () => {
		vi.useFakeTimers();
		await withEnv(
			{
				GJC_OPENAI_STREAM_IDLE_TIMEOUT_MS: undefined,
				PI_STREAM_IDLE_TIMEOUT_MS: undefined,
				PI_OPENAI_STREAM_IDLE_TIMEOUT_MS: undefined,
				PI_STREAM_FIRST_EVENT_TIMEOUT_MS: undefined,
			},
			async () => {
				const model: Model<"openai-responses"> = {
					...openAIResponsesModel,
					provider: "custom-proxy",
					baseUrl: "https://proxy.example.com/v1",
					streamIdleTimeoutMs: 120_000,
				};
				const delayedFetch = createDelayedFetch(150_000, createOpenAIResponsesSuccessResponse);
				global.fetch = Object.assign(delayedFetch, { preconnect: originalFetch.preconnect });

				const pending = streamOpenAIResponses(model, baseContext(), {
					apiKey: "test-key",
					requestMaxRetries: 0,
					streamIdleTimeoutMs: 300_000,
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
			},
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

	describe("github-copilot caller aborts (#912)", () => {
		function makeCopilotResponsesModel(baseUrl: string): Model<"openai-responses"> {
			return {
				id: "gpt-5-mini",
				name: "GPT-5 Mini",
				api: "openai-responses",
				provider: "github-copilot",
				baseUrl,
				reasoning: true,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 64000,
				headers: { "User-Agent": "opencode/1.3.15" },
			};
		}

		function makeContext(): Context {
			return {
				systemPrompt: ["You are a helpful assistant."],
				messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
			};
		}

		/**
		 * Issue #912: github-copilot provider hangs the UI on `Working...` and ESC
		 * does not unstick it. The user-facing symptom is "spinner spins forever".
		 *
		 * Root cause exposed by this test: when the upstream Copilot SSE stream is
		 * stuck (server holds the response open without sending events) and the
		 * underlying body reader does not surface the AbortSignal, the provider's
		 * stream-consumption loop only races the SDK iterator against the idle/first
		 * -event watchdog (default 100s). It does NOT race against the caller's abort
		 * signal, so ESC has no observable effect for ~100 seconds — exactly the
		 * "infinite Working..." UX the user reports.
		 *
		 * The mock here returns a 200 + text/event-stream response whose body is a
		 * ReadableStream that intentionally ignores the upstream signal — emulating
		 * the broken Copilot path / a misbehaving HTTP/2 reverse proxy. The provider
		 * MUST still settle within a tight bound after the caller aborts. We allow
		 * up to 3 seconds to absorb scheduling jitter while still being orders of
		 * magnitude tighter than the 100s watchdog.
		 */
		it("settles within bounded time when the caller aborts a hung Copilot response that ignores fetch abort", async () => {
			const fetchInvoked = Promise.withResolvers<void>();

			// A body that never enqueues data and never reacts to the upstream
			// signal — this is the regression vector. Real Bun fetch normally
			// propagates abort to the body reader, but we cannot rely on it for
			// every transport (HTTP/2, intermediaries, native sockets).
			global.fetch = (async (input: string | URL | Request, _init?: RequestInit): Promise<Response> => {
				const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
				if (!url.endsWith("/responses")) {
					throw new Error(`Unexpected fetch to ${url}`);
				}

				const body = new ReadableStream<Uint8Array>({
					start(_controller) {
						// Intentionally do nothing. No enqueue, no close, no error.
						// The body parser will hang on the first read until something
						// closes it from outside (which here only ESC/abort can do).
					},
				});

				fetchInvoked.resolve();

				return new Response(body, {
					status: 200,
					headers: {
						"Content-Type": "text/event-stream",
						"Cache-Control": "no-cache",
					},
				});
			}) as typeof fetch;

			const model = makeCopilotResponsesModel("https://api.githubcopilot.example/test");
			const controller = new AbortController();
			const providerStream = stream(model, makeContext(), {
				apiKey: JSON.stringify({ token: "ghu_test_token", enterpriseUrl: undefined }),
				signal: controller.signal,
			});

			await fetchInvoked.promise;
			await Bun.sleep(50);
			controller.abort();

			// Bound: 3 seconds. The first-event watchdog default is 100s, so any
			// pass within 3s implies the provider observed the abort signal
			// directly rather than waiting for the watchdog.
			const result = await Promise.race([
				providerStream.result(),
				Bun.sleep(3_000).then(() => {
					throw new Error("providerStream.result() did not settle within 3s after abort");
				}),
			]);

			expect(result.stopReason).toBe("aborted");
		}, 10_000);
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
