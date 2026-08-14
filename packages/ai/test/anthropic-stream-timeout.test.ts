import { afterEach, describe, expect, it, vi } from "bun:test";
import type Anthropic from "@anthropic-ai/sdk";
import { streamAnthropic } from "../src/providers/anthropic";
import type { Context, FetchImpl, Model } from "../src/types";
import { waitForDelayOrAbort } from "./helpers";

const model: Model<"anthropic-messages"> = {
	id: "claude-sonnet-4-5",
	name: "Claude Sonnet 4.5",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8_192,
};

const context: Context = {
	messages: [{ role: "user", content: "Say hi", timestamp: Date.now() }],
};

function contextWithBytes(bytes: number): Context {
	return {
		messages: [{ role: "user", content: "x".repeat(bytes), timestamp: Date.now() }],
	};
}

function customModel(baseUrl: string): Model<"anthropic-messages"> {
	return { ...model, baseUrl };
}

type MockAnthropicEvent = Record<string, unknown>;
type MockAnthropicStream = AsyncIterable<MockAnthropicEvent>;

type MockAnthropicRequest = {
	withResponse(): Promise<{
		data: MockAnthropicStream;
		response: Response;
		request_id: string | null;
	}>;
};

async function waitForAbortAndThrowAbortError(signal: AbortSignal | undefined): Promise<never> {
	if (signal?.aborted) {
		throw new Error("Request was aborted.");
	}

	const { promise, reject } = Promise.withResolvers<void>();
	const onAbort = () => reject(new Error("Request was aborted."));
	signal?.addEventListener("abort", onAbort, { once: true });

	try {
		await promise;
		throw new Error("Anthropic mock stream unexpectedly resumed");
	} finally {
		signal?.removeEventListener("abort", onAbort);
	}
}

function createSuccessfulAnthropicEvents(text: string): MockAnthropicEvent[] {
	return [
		{
			type: "message_start",
			message: {
				id: "msg_retry_success",
				usage: {
					input_tokens: 12,
					output_tokens: 0,
					cache_read_input_tokens: 0,
					cache_creation_input_tokens: 0,
				},
			},
		},
		{
			type: "content_block_start",
			index: 0,
			content_block: { type: "text", text: "" },
		},
		{
			type: "content_block_delta",
			index: 0,
			delta: { type: "text_delta", text },
		},
		{ type: "content_block_stop", index: 0 },
		{
			type: "message_delta",
			delta: { stop_reason: "end_turn" },
			usage: {
				input_tokens: 12,
				output_tokens: 4,
				cache_read_input_tokens: 0,
				cache_creation_input_tokens: 0,
			},
		},
	];
}

function createAnthropicMockStream({
	signal,
	connectDelayMs = 0,
	eventDelayMs = 0,
	events,
	hangAfterEvents = false,
}: {
	signal: AbortSignal | undefined;
	connectDelayMs?: number;
	eventDelayMs?: number;
	events?: MockAnthropicEvent[];
	hangAfterEvents?: boolean;
}): MockAnthropicRequest {
	const response = new Response(null, {
		status: 200,
		headers: { "request-id": "req_mock" },
	});

	const stream: MockAnthropicStream = {
		async *[Symbol.asyncIterator]() {
			if (!events) {
				await waitForAbortAndThrowAbortError(signal);
				return;
			}
			if (eventDelayMs > 0) {
				await waitForDelayOrAbort(eventDelayMs, signal);
			}
			for (const event of events) {
				yield event;
			}
			if (hangAfterEvents) {
				await waitForAbortAndThrowAbortError(signal);
			}
		},
	};

	return {
		async withResponse() {
			if (connectDelayMs > 0) {
				await waitForDelayOrAbort(connectDelayMs, signal);
			}
			return {
				data: stream,
				response,
				request_id: response.headers.get("request-id"),
			};
		},
	};
}

afterEach(() => {
	vi.useRealTimers();
});

describe("anthropic first-event timeouts", () => {
	it("surfaces the canonical first-event timeout without an internal provider replay", async () => {
		let attempt = 0;
		const create = ((_body: unknown, requestOptions?: { signal?: AbortSignal }) => {
			attempt += 1;
			return createAnthropicMockStream({
				signal: requestOptions?.signal,
				events: attempt === 1 ? undefined : createSuccessfulAnthropicEvents("must not replay"),
			}) as never;
		}) as unknown as Anthropic["messages"]["create"];
		const client = { messages: { create } } as Anthropic;
		const providerRetryWait = vi.fn(async () => {});

		const result = await streamAnthropic(model, context, {
			client,
			streamFirstEventTimeoutMs: 1,
			streamMaxRetries: 0,
			providerRetryWait,
		}).result();

		expect(attempt).toBe(1);
		expect(providerRetryWait).not.toHaveBeenCalled();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("Anthropic stream timed out while waiting for the first event");
		expect(result.errorMessage).toContain("elapsed=");
		expect(result.errorMessage).toContain("request_bytes=");
		expect(result.errorMessage).toContain("endpoint=canonical");
		expect(result.errorMessage).toContain("PI_STREAM_FIRST_EVENT_TIMEOUT_MS");
		expect(result.transportFailure?.providerCode).toBe("stream_first_event_timeout");
		expect(result.transportFailure?.endpointClass).toBe("canonical");
		expect(result.transportFailure?.retryMaxAttempts).toBe(2);
		expect(result.transportFailure?.requestBytes).toBeGreaterThan(0);
	});

	it("does not upload a multi-megabyte body again after a full-window first-event timeout", async () => {
		let attempts = 0;
		const create = ((_body: unknown, requestOptions?: { signal?: AbortSignal }) => {
			attempts += 1;
			return createAnthropicMockStream({ signal: requestOptions?.signal }) as never;
		}) as unknown as Anthropic["messages"]["create"];
		const providerRetryWait = vi.fn(async () => {});

		const result = await streamAnthropic(model, contextWithBytes(1_670_000), {
			client: { messages: { create } } as Anthropic,
			streamFirstEventTimeoutMs: 1,
			providerRetryWait,
		}).result();

		expect(attempts).toBe(1);
		expect(providerRetryWait).not.toHaveBeenCalled();
		expect(result.transportFailure).toMatchObject({
			providerCode: "stream_first_event_timeout",
			endpointClass: "canonical",
			retryMaxAttempts: 1,
		});
		expect(result.transportFailure?.requestBytes).toBeGreaterThan(1_000_000);
		expect(result.usage.totalTokens).toBe(0);
		expect(result.duration).toBeGreaterThanOrEqual(result.transportFailure?.firstEventElapsedMs ?? 0);
	});

	it("allows one bounded replay for a small first-event timeout", async () => {
		let attempts = 0;
		const create = ((_body: unknown, requestOptions?: { signal?: AbortSignal }) => {
			attempts += 1;
			return createAnthropicMockStream({
				signal: requestOptions?.signal,
				events: attempts === 1 ? undefined : createSuccessfulAnthropicEvents("recovered once"),
			}) as never;
		}) as unknown as Anthropic["messages"]["create"];
		const providerRetryWait = vi.fn(async () => {});

		const result = await streamAnthropic(model, context, {
			client: { messages: { create } } as Anthropic,
			streamFirstEventTimeoutMs: 1,
			providerRetryWait,
		}).result();

		expect(attempts).toBe(2);
		expect(providerRetryWait).toHaveBeenCalledTimes(1);
		expect(result.stopReason).toBe("stop");
		expect(result.content).toEqual([{ type: "text", text: "recovered once" }]);
		expect(result.usage.totalTokens).toBe(16);
	});

	it("gives custom endpoints bounded grace so a late 529 surfaces instead of a timeout", async () => {
		let attempts = 0;
		const create = ((_body: unknown) => {
			attempts += 1;
			const response = new Response(null, { status: 200 });
			const data: MockAnthropicStream = {
				[Symbol.asyncIterator]() {
					return {
						async next(): Promise<IteratorResult<MockAnthropicEvent>> {
							await Bun.sleep(5);
							const error = new Error(
								'529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
							);
							(error as Error & { status: number; error: { type: string } }).status = 529;
							(error as Error & { status: number; error: { type: string } }).error = {
								type: "overloaded_error",
							};
							throw error;
						},
					};
				},
			};
			return {
				async withResponse() {
					return { data, response, request_id: null };
				},
			} as never;
		}) as unknown as Anthropic["messages"]["create"];

		const result = await streamAnthropic(
			customModel("https://user:password@proxy.example/v1?token=secret"),
			contextWithBytes(1_670_000),
			{
				client: { messages: { create } } as Anthropic,
				streamFirstEventTimeoutMs: 1,
				streamMaxRetries: 0,
			},
		).result();

		expect(attempts).toBe(1);
		expect(result.errorStatus).toBe(529);
		expect(result.errorMessage).toContain("overloaded_error");
		expect(result.errorMessage).not.toContain("timed out while waiting for the first event");
		expect(result.errorMessage).not.toContain("password");
		expect(result.errorMessage).not.toContain("token=secret");
	});

	it("honors caller abort while a custom endpoint is inside its bounded grace", async () => {
		let attempts = 0;
		const create = ((_body: unknown, requestOptions?: { signal?: AbortSignal }) => {
			attempts += 1;
			return createAnthropicMockStream({ signal: requestOptions?.signal }) as never;
		}) as unknown as Anthropic["messages"]["create"];
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 5);

		const result = await streamAnthropic(customModel("https://proxy.example"), contextWithBytes(1_670_000), {
			client: { messages: { create } } as Anthropic,
			signal: controller.signal,
			streamFirstEventTimeoutMs: 1,
		}).result();

		expect(attempts).toBe(1);
		expect(result.stopReason).toBe("aborted");
		expect(result.errorMessage).not.toContain("timed out while waiting for the first event");
	});

	it("surfaces redacted timeout facts after large custom-endpoint grace expires", async () => {
		vi.useFakeTimers();
		let attempts = 0;
		const streamStarted = Promise.withResolvers<void>();
		const create = ((_body: unknown, requestOptions?: { signal?: AbortSignal }) => {
			attempts += 1;
			streamStarted.resolve();
			return createAnthropicMockStream({ signal: requestOptions?.signal }) as never;
		}) as unknown as Anthropic["messages"]["create"];

		const resultPromise = streamAnthropic(
			customModel("https://user:password@proxy.example/v1?token=secret"),
			contextWithBytes(1_670_000),
			{
				client: { messages: { create } } as Anthropic,
				streamFirstEventTimeoutMs: 1,
			},
		).result();
		await streamStarted.promise;
		for (let index = 0; index < 20 && vi.getTimerCount() === 0; index++) {
			await Promise.resolve();
		}
		expect(vi.getTimerCount()).toBeGreaterThan(0);
		vi.advanceTimersByTime(120_001);
		await Promise.resolve();
		await Promise.resolve();
		const result = await resultPromise;

		expect(attempts).toBe(1);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("elapsed=120001ms");
		expect(result.errorMessage).toContain("endpoint=custom");
		expect(result.errorMessage).toContain("configured_timeout=1ms");
		expect(result.errorMessage).not.toContain("password");
		expect(result.errorMessage).not.toContain("token=secret");
		expect(result.transportFailure).toMatchObject({
			endpointClass: "custom",
			firstEventTimeoutMs: 1,
			retryMaxAttempts: 1,
		});
		expect(result.transportFailure?.requestBytes).toBeGreaterThan(1_000_000);
	});

	it("does not extend the configured first-event window for a small custom-endpoint request", async () => {
		let attempts = 0;
		const create = ((_body: unknown, requestOptions?: { signal?: AbortSignal }) => {
			attempts += 1;
			return createAnthropicMockStream({ signal: requestOptions?.signal }) as never;
		}) as unknown as Anthropic["messages"]["create"];

		const result = await streamAnthropic(customModel("https://proxy.example"), context, {
			client: { messages: { create } } as Anthropic,
			streamFirstEventTimeoutMs: 1,
			streamMaxRetries: 0,
		}).result();

		expect(attempts).toBe(1);
		expect(result.stopReason).toBe("error");
		expect(result.transportFailure).toMatchObject({
			endpointClass: "custom",
			retryMaxAttempts: 2,
		});
		expect(result.duration).toBeLessThan(1_000);
	});

	it("surfaces large retry-after Anthropic 429s instead of first-event timeouts", async () => {
		let attempts = 0;
		const fetchMock = (async () => {
			attempts += 1;
			return new Response(
				JSON.stringify({
					type: "error",
					error: {
						type: "rate_limit_error",
						message: "This request would exceed your account's rate limit. Please try again later.",
					},
				}),
				{
					status: 429,
					headers: {
						"content-type": "application/json",
						"retry-after": "62291",
						"anthropic-ratelimit-unified-status": "rejected",
						"anthropic-ratelimit-unified-7d-status": "rejected",
						"anthropic-ratelimit-unified-overage-disabled-reason": "out_of_credits",
					},
				},
			);
		}) as FetchImpl;
		const providerRetryWait = vi.fn(async () => {});

		const result = await streamAnthropic(model, context, {
			apiKey: "test-key",
			fetch: fetchMock,
			streamFirstEventTimeoutMs: 1,
			providerRetryWait,
		}).result();

		expect(attempts).toBe(1);
		expect(providerRetryWait).not.toHaveBeenCalled();
		expect(result.stopReason).toBe("error");
		expect(result.errorStatus).toBe(429);
		expect(result.errorMessage).toContain("rate_limit_error");
		expect(result.errorMessage).toContain("This request would exceed your account's rate limit");
		expect(result.errorMessage).toContain("retry-after-ms=62291000");
		expect(result.errorMessage).toContain("anthropic-ratelimit-unified-overage-disabled-reason=out_of_credits");
		expect(result.errorMessage).not.toContain("timed out while waiting for the first event");
	});

	it("does not arm the Anthropic first-event watchdog before the stream connects", async () => {
		const create = ((_body: unknown, requestOptions?: { signal?: AbortSignal }) => {
			return createAnthropicMockStream({
				signal: requestOptions?.signal,
				connectDelayMs: 2,
				events: createSuccessfulAnthropicEvents("delayed connect"),
			}) as never;
		}) as unknown as Anthropic["messages"]["create"];
		const client = { messages: { create } } as Anthropic;

		const result = await streamAnthropic(model, context, {
			client,
			streamFirstEventTimeoutMs: 1,
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(result.content).toEqual([{ type: "text", text: "delayed connect" }]);
	});

	it("accepts an eventual first event inside the configured window", async () => {
		const create = ((_body: unknown, requestOptions?: { signal?: AbortSignal }) => {
			return createAnthropicMockStream({
				signal: requestOptions?.signal,
				eventDelayMs: 2,
				events: createSuccessfulAnthropicEvents("eventual first byte"),
			}) as never;
		}) as unknown as Anthropic["messages"]["create"];

		const result = await streamAnthropic(model, context, {
			client: { messages: { create } } as Anthropic,
			streamFirstEventTimeoutMs: 20,
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(result.content).toEqual([{ type: "text", text: "eventual first byte" }]);
	});

	it("keeps caller aborts as aborted instead of retrying them as first-event timeouts", async () => {
		let attempt = 0;
		const create = ((_body: unknown, requestOptions?: { signal?: AbortSignal }) => {
			attempt += 1;
			return createAnthropicMockStream({ signal: requestOptions?.signal }) as never;
		}) as unknown as Anthropic["messages"]["create"];
		const client = { messages: { create } } as Anthropic;

		const controller = new AbortController();
		setTimeout(() => controller.abort(), 1);

		const result = await streamAnthropic(model, context, {
			client,
			signal: controller.signal,
			streamFirstEventTimeoutMs: 10,
		}).result();

		expect(attempt).toBe(1);
		expect(result.stopReason).toBe("aborted");
		expect(result.errorMessage).not.toBe("Anthropic stream timed out while waiting for the first event");
		expect((result.errorMessage ?? "").toLowerCase()).toContain("abort");
	});

	it("stops a small-body timeout retry when the caller aborts during backoff", async () => {
		let attempts = 0;
		const create = ((_body: unknown, requestOptions?: { signal?: AbortSignal }) => {
			attempts += 1;
			return createAnthropicMockStream({ signal: requestOptions?.signal }) as never;
		}) as unknown as Anthropic["messages"]["create"];
		const controller = new AbortController();
		const providerRetryWait = vi.fn(async (_delayMs: number, signal?: AbortSignal) => {
			controller.abort();
			await waitForDelayOrAbort(1, signal);
		});

		const result = await streamAnthropic(model, context, {
			client: { messages: { create } } as Anthropic,
			signal: controller.signal,
			streamFirstEventTimeoutMs: 1,
			providerRetryWait,
		}).result();

		expect(attempts).toBe(1);
		expect(providerRetryWait).toHaveBeenCalledTimes(1);
		expect(result.stopReason).toBe("aborted");
	});
	it("fails hung Anthropic streams between tool-call events instead of waiting forever", async () => {
		let attempt = 0;
		const create = ((_body: unknown, requestOptions?: { signal?: AbortSignal }) => {
			attempt += 1;
			return createAnthropicMockStream({
				signal: requestOptions?.signal,
				events: [
					{
						type: "message_start",
						message: {
							id: "msg_stalled_tool",
							usage: {
								input_tokens: 12,
								output_tokens: 0,
								cache_read_input_tokens: 0,
								cache_creation_input_tokens: 0,
							},
						},
					},
					{
						type: "content_block_start",
						index: 0,
						content_block: {
							type: "tool_use",
							id: "toolu_stalled_todo",
							name: "todo_write",
							input: {},
						},
					},
				],
				hangAfterEvents: true,
			}) as never;
		}) as unknown as Anthropic["messages"]["create"];
		const client = { messages: { create } } as Anthropic;

		const result = await streamAnthropic(model, context, {
			client,
			streamFirstEventTimeoutMs: 5000,
			streamIdleTimeoutMs: 1,
		}).result();

		expect(attempt).toBe(1);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("Anthropic stream stalled while waiting for the next event");
		expect(result.content).toEqual([
			{
				type: "toolCall",
				id: "toolu_stalled_todo",
				name: "todo_write",
				arguments: {},
			},
		]);
	});

	it("does not let Anthropic ping events keep a stalled response alive", async () => {
		const create = ((_body: unknown, requestOptions?: { signal?: AbortSignal }) => {
			const response = new Response(null, { status: 200, headers: { "request-id": "req_ping_stall" } });
			const data: MockAnthropicStream = {
				async *[Symbol.asyncIterator]() {
					yield {
						type: "message_start",
						message: {
							id: "msg_ping_stall",
							usage: {
								input_tokens: 12,
								output_tokens: 0,
								cache_read_input_tokens: 0,
								cache_creation_input_tokens: 0,
							},
						},
					};
					yield {
						type: "content_block_start",
						index: 0,
						content_block: { type: "text", text: "" },
					};
					yield {
						type: "content_block_delta",
						index: 0,
						delta: { type: "text_delta", text: "checking" },
					};
					while (!requestOptions?.signal?.aborted) {
						await Bun.sleep(1);
						yield { type: "ping" };
					}
				},
			};
			return {
				async withResponse() {
					return { data, response, request_id: "req_ping_stall" };
				},
			} as never;
		}) as unknown as Anthropic["messages"]["create"];
		const client = { messages: { create } } as Anthropic;

		const result = await streamAnthropic(model, context, {
			client,
			streamFirstEventTimeoutMs: 5000,
			streamIdleTimeoutMs: 5,
		}).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("Anthropic stream stalled while waiting for the next event");
	});
});
