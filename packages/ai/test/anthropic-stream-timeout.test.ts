import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type Anthropic from "@anthropic-ai/sdk";
import { resetAnthropicFallbackRetryBudgetForTests, streamAnthropic } from "../src/providers/anthropic";
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

beforeEach(() => {
	// The fallback downgrade budget is process-wide by design (see the policy
	// comment in providers/anthropic.ts); isolate tests from each other.
	resetAnthropicFallbackRetryBudgetForTests();
});

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

	// Shared builder for unified-limit 429 mocks. The default header set is
	// the COMPLETE captured incident shape (2026-07-16), verbatim including
	// the fields the gate does not read -- tests must prove the observed
	// production shape, not a convenient subset. Overrides flip one dial at
	// a time for the adversarial cases.
	const unifiedRejection429 = (
		headerOverrides: Record<string, string | null> = {},
		body?: { text: string; contentType?: string },
	) => {
		const headers: Record<string, string> = {
			"content-type": body?.contentType ?? "application/json",
			"retry-after": "13262",
			"anthropic-ratelimit-unified-reset": "1784227800",
			"anthropic-ratelimit-unified-status": "rejected",
			"anthropic-ratelimit-unified-5h-reset": "1784227800",
			"anthropic-ratelimit-unified-5h-status": "rejected",
			"anthropic-ratelimit-unified-5h-utilization": "1.08",
			"anthropic-ratelimit-unified-7d-status": "allowed",
			"anthropic-ratelimit-unified-fallback-percentage": "0.5",
			"anthropic-ratelimit-unified-overage-disabled-reason": "org_level_disabled",
			"anthropic-ratelimit-unified-representative-claim": "five_hour",
		};
		for (const [name, value] of Object.entries(headerOverrides)) {
			if (value === null) delete headers[name];
			else headers[name] = value;
		}
		return new Response(
			body?.text ??
				JSON.stringify({
					type: "error",
					error: {
						type: "rate_limit_error",
						message: "This request would exceed your account's rate limit. Please try again later.",
					},
				}),
			{ status: 429, headers },
		);
	};

	const runUnifiedRejection = async (
		overrides: Record<string, string | null> = {},
		body?: { text: string; contentType?: string },
	) => {
		let attempts = 0;
		const fetchMock = (async () => {
			attempts += 1;
			return unifiedRejection429(overrides, body);
		}) as FetchImpl;
		const result = await streamAnthropic(model, context, {
			apiKey: "test-key",
			fetch: fetchMock,
			requestMaxRetries: 1,
		}).result();
		return { attempts: () => attempts, result };
	};

	it("gives the captured incident shape a bounded wrapper retry, then fails loud", async () => {
		// Field incident (2026-07-16): the exhaustion fast-path declared the
		// session terminal after ONE attempt although the rejection was
		// rolling (fallback capacity advertised; real requests succeeded
		// within minutes). The wrapper now waits abort-aware and re-fetches
		// itself: exactly 1 + ANTHROPIC_FALLBACK_MAX_RETRIES(2) = 3 attempts
		// regardless of the SDK retry budget (the SDK never sees the
		// downgraded 429), then the exhaustion fast-path with header
		// evidence surfaces -- never a six-request burst.
		const { attempts, result } = await runUnifiedRejection();
		expect(attempts()).toBe(3);
		expect(result.stopReason).toBe("error");
		expect(result.errorStatus).toBe(429);
		expect(result.errorMessage).toContain("anthropic-ratelimit-unified-fallback-percentage=0.5");
	}, 15_000);

	it("downgrades a capture that only carries a window-scoped rejected status", async () => {
		// #2464 finding 1: a capture may carry only
		// anthropic-ratelimit-unified-5h-status=rejected without the generic
		// header -- the gate must match the shapes actually observed.
		const { attempts, result } = await runUnifiedRejection({
			"anthropic-ratelimit-unified-status": null,
		});
		expect(attempts()).toBe(3);
		expect(result.errorStatus).toBe(429);
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
			{ "anthropic-ratelimit-unified-fallback-percentage": null },
			{
				"anthropic-ratelimit-unified-status": "allowed",
				"anthropic-ratelimit-unified-5h-status": "allowed",
			},
			{
				"anthropic-ratelimit-unified-status": null,
				"anthropic-ratelimit-unified-5h-status": null,
				"anthropic-ratelimit-unified-7d-status": null,
			},
		];
		for (const overrides of variants) {
			const { attempts, result } = await runUnifiedRejection(overrides);
			expect(attempts()).toBe(1);
			expect(result.stopReason).toBe("error");
			expect(result.errorStatus).toBe(429);
		}
	});

	it("fails closed on non-JSON bodies even with fully verified headers", async () => {
		// #2464 finding 2: without a parseable typed error the exact class
		// cannot be proven -- text/plain with the matching phrase must NOT
		// unlock the downgrade.
		const { attempts, result } = await runUnifiedRejection(
			{},
			{
				text: "This request would exceed your account's rate limit. Please try again later.",
				contentType: "text/plain",
			},
		);
		expect(attempts()).toBe(1);
		expect(result.errorStatus).toBe(429);
	});

	it("leaves small or ms-precedence retry hints alone (no forced 2s sleep)", async () => {
		// #2464 finding 3: the downgrade exists to rescue OVERSIZED hints; a
		// small hint needs no rescue. retry-after-ms takes precedence over an
		// oversized retry-after (SDK precedence), so an effective 50ms hint
		// keeps the original exhaustion handling -- fail-fast, no 2s sleep.
		const hintVariants: Array<Record<string, string | null>> = [
			{ "retry-after": "1" },
			{ "retry-after-ms": "50" },
			{ "retry-after": null },
		];
		for (const overrides of hintVariants) {
			const started = Date.now();
			const { attempts, result } = await runUnifiedRejection(overrides);
			expect(attempts()).toBe(1);
			expect(result.errorStatus).toBe(429);
			expect(Date.now() - started).toBeLessThan(1_500);
		}
	});

	it("downgrades an oversized HTTP-date retry-after in the verified shape", async () => {
		const httpDate = new Date(Date.now() + 2 * 60 * 60 * 1000).toUTCString();
		const { attempts, result } = await runUnifiedRejection({ "retry-after": httpDate });
		expect(attempts()).toBe(3);
		expect(result.errorStatus).toBe(429);
	}, 15_000);

	it("shares the sliding downgrade budget across sequential calls", async () => {
		// #2464 finding 4: the budget is PROCESS-WIDE (every streamAnthropic
		// call builds a fresh wrapper, so any narrower scope silently becomes
		// per-call). A second call inside the same 60s window must fail fast
		// with zero extra downgrades -- 3 + 1 attempts total, never 6.
		const first = await runUnifiedRejection();
		expect(first.attempts()).toBe(3);
		const second = await runUnifiedRejection();
		expect(second.attempts()).toBe(1);
		expect(second.result.errorStatus).toBe(429);
	}, 20_000);

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

	it("abort interrupts the bounded fallback backoff promptly", async () => {
		// #2464 finding 5: cancellation must interrupt the delay itself, not
		// merely prevent a later fetch. The wrapper waits via signal-aware
		// scheduler.wait, so an abort at ~100ms must surface well before the
		// 2s delay elapses and no follow-up attempt may be made.
		let attempts = 0;
		const fetchMock = (async () => {
			attempts += 1;
			return unifiedRejection429();
		}) as FetchImpl;
		const controller = new AbortController();
		const started = Date.now();
		const pending = streamAnthropic(model, context, {
			apiKey: "test-key",
			fetch: fetchMock,
			requestMaxRetries: 5,
			signal: controller.signal,
		}).result();
		setTimeout(() => controller.abort(), 100);
		const result = await pending;
		const elapsed = Date.now() - started;
		expect(attempts).toBe(1);
		expect(elapsed).toBeLessThan(1_000);
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
