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
	events,
	hangAfterEvents = false,
}: {
	signal: AbortSignal | undefined;
	connectDelayMs?: number;
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
	// No shared globals to restore; keep hook so the suite stays explicit.
});

describe("anthropic first-event timeout retries", () => {
	it("retries when the provider never sends the first stream event", async () => {
		let attempt = 0;
		const create = ((_body: unknown, requestOptions?: { signal?: AbortSignal }) => {
			attempt += 1;
			return createAnthropicMockStream({
				signal: requestOptions?.signal,
				events: attempt === 1 ? undefined : createSuccessfulAnthropicEvents("retry recovered"),
			}) as never;
		}) as unknown as Anthropic["messages"]["create"];
		const client = { messages: { create } } as Anthropic;
		const providerRetryWait = vi.fn(async () => {});

		const result = await streamAnthropic(model, context, {
			client,
			streamFirstEventTimeoutMs: 1,
			providerRetryWait,
		}).result();

		expect(attempt).toBe(2);
		expect(providerRetryWait).toHaveBeenCalledWith(2000, undefined);
		expect(result.stopReason).toBe("stop");
		expect(result.content).toEqual([{ type: "text", text: "retry recovered" }]);
		expect(result.responseId).toBe("msg_retry_success");
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

	// Shared builder for unified-limit 429 mocks; header overrides let the
	// adversarial cases below flip one dial at a time.
	const unifiedRejection429 = (headerOverrides: Record<string, string | null> = {}, message?: string) => {
		const headers: Record<string, string> = {
			"content-type": "application/json",
			"retry-after": "13262",
			"anthropic-ratelimit-unified-status": "rejected",
			"anthropic-ratelimit-unified-5h-status": "rejected",
			"anthropic-ratelimit-unified-fallback-percentage": "0.5",
			"anthropic-ratelimit-unified-overage-disabled-reason": "org_level_disabled",
		};
		for (const [name, value] of Object.entries(headerOverrides)) {
			if (value === null) delete headers[name];
			else headers[name] = value;
		}
		return new Response(
			JSON.stringify({
				type: "error",
				error: {
					type: "rate_limit_error",
					message: message ?? "This request would exceed your account's rate limit. Please try again later.",
				},
			}),
			{ status: 429, headers },
		);
	};

	it("gives verified fallback-capacity rejections a bounded retry", async () => {
		// Field incident (2026-07-16): unified-5h-status=rejected with
		// fallback-percentage=0.5 and overage merely org-disabled. Requests
		// succeeded again within minutes (the unified window is rolling and a
		// fraction keeps being accepted), but the exhaustion fast-path saw
		// retry-after=13262s (> cap) plus the "request would exceed" body and
		// declared the session terminally exhausted after ONE attempt. The
		// verified shape now gets a bounded retry with an explicit short
		// delay (the SDK obeys retry-after verbatim, so the worst-case hint
		// is overridden, never passed through).
		let attempts = 0;
		const fetchMock = (async () => {
			attempts += 1;
			return unifiedRejection429();
		}) as FetchImpl;

		const result = await streamAnthropic(model, context, {
			apiKey: "test-key",
			fetch: fetchMock,
			requestMaxRetries: 1,
		}).result();

		// Bounded retry happened (initial + 1 = SDK budget) instead of a
		// single-shot terminal failure; the final error stays an honest 429.
		expect(attempts).toBe(2);
		expect(result.stopReason).toBe("error");
		expect(result.errorStatus).toBe(429);
		expect(result.errorMessage).toContain("rate_limit_error");
	});

	it("caps the fallback retry budget below the SDK retry budget", async () => {
		// SDK budget 5 retries, wrapper budget ANTHROPIC_FALLBACK_MAX_RETRIES=2:
		// exactly 3 attempts total, then the exhaustion fast-path (with the
		// appended header evidence) stops the SDK -- never a six-request burst.
		let attempts = 0;
		const fetchMock = (async () => {
			attempts += 1;
			return unifiedRejection429();
		}) as FetchImpl;

		const result = await streamAnthropic(model, context, {
			apiKey: "test-key",
			fetch: fetchMock,
			requestMaxRetries: 5,
		}).result();

		expect(attempts).toBe(3);
		expect(result.stopReason).toBe("error");
		expect(result.errorStatus).toBe(429);
		expect(result.errorMessage).toContain("anthropic-ratelimit-unified-fallback-percentage=0.5");
	}, 15_000);

	it("fails fast when the unified rejection shape is not fully proven", async () => {
		// One dial off the verified shape at a time -- every variant must keep
		// the original single-attempt fail-fast (a lone or malformed header
		// must never loosen retry policy).
		const variants: Array<Record<string, string | null>> = [
			{ "anthropic-ratelimit-unified-fallback-percentage": "0.5junk" },
			{ "anthropic-ratelimit-unified-fallback-percentage": "101" },
			{ "anthropic-ratelimit-unified-fallback-percentage": "0" },
			{ "anthropic-ratelimit-unified-fallback-percentage": "Infinity" },
			{ "anthropic-ratelimit-unified-status": "allowed" },
			{ "anthropic-ratelimit-unified-status": null },
		];
		for (const overrides of variants) {
			let attempts = 0;
			const fetchMock = (async () => {
				attempts += 1;
				return unifiedRejection429(overrides);
			}) as FetchImpl;
			const result = await streamAnthropic(model, context, {
				apiKey: "test-key",
				fetch: fetchMock,
				requestMaxRetries: 3,
			}).result();
			expect(attempts).toBe(1);
			expect(result.stopReason).toBe("error");
			expect(result.errorStatus).toBe(429);
		}
	});

	it("does not let fallback headers change unrelated 429 error classes", async () => {
		// An arbitrary 429 (small retry-after, non-unified error class) with
		// spoofed fallback headers passes through UNTOUCHED: the SDK's own
		// default 429 handling applies, and the wrapper neither strips nor
		// rewrites anything (cross-provider safety: the wrapper is installed
		// for every Anthropic-compatible auth path).
		let attempts = 0;
		const fetchMock = (async () => {
			attempts += 1;
			return new Response(
				JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }),
				{
					status: 429,
					headers: {
						"content-type": "application/json",
						"retry-after": "1",
						"anthropic-ratelimit-unified-status": "rejected",
						"anthropic-ratelimit-unified-fallback-percentage": "0.5",
					},
				},
			);
		}) as FetchImpl;
		const providerRetryWait = vi.fn(async () => {});
		const result = await streamAnthropic(model, context, {
			apiKey: "test-key",
			fetch: fetchMock,
			requestMaxRetries: 1,
			providerRetryWait,
		}).result();
		// SDK default: 429 is retryable, honors the small retry-after as-is.
		// (Provider-level transient retries may add attempts on top of the
		// SDK's; the point is that the wrapper touched NOTHING -- no header
		// stripping, no exhaustion stamp, so the error class survives.)
		expect(attempts).toBeGreaterThanOrEqual(2);
		expect(result.errorStatus).toBe(429);
		expect(result.errorMessage).toContain("Overloaded");
	});

	it("aborting during the bounded fallback backoff stops further attempts", async () => {
		let attempts = 0;
		const fetchMock = (async () => {
			attempts += 1;
			return unifiedRejection429();
		}) as FetchImpl;
		const controller = new AbortController();
		const pending = streamAnthropic(model, context, {
			apiKey: "test-key",
			fetch: fetchMock,
			requestMaxRetries: 5,
			signal: controller.signal,
		}).result();
		setTimeout(() => controller.abort(), 100);
		const result = await pending;
		// The abort lands during the first bounded backoff: no burst of
		// further attempts (at most the one in-flight follow-up).
		expect(attempts).toBeLessThanOrEqual(2);
		expect(result.stopReason === "aborted" || result.stopReason === "error").toBe(true);
	}, 15_000);

	it("still fails fast when fallback is advertised but credits are out", async () => {
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
						"anthropic-ratelimit-unified-fallback-percentage": "0.5",
						"anthropic-ratelimit-unified-overage-disabled-reason": "out_of_credits",
					},
				},
			);
		}) as FetchImpl;

		const result = await streamAnthropic(model, context, {
			apiKey: "test-key",
			fetch: fetchMock,
			requestMaxRetries: 1,
		}).result();

		expect(attempts).toBe(1);
		expect(result.stopReason).toBe("error");
		expect(result.errorStatus).toBe(429);
		expect(result.errorMessage).toContain("out_of_credits");
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
});
