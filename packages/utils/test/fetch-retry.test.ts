import { afterEach, describe, expect, it, vi } from "bun:test";
import { scheduler } from "node:timers/promises";
import { type FetchWithRetryOptions, fetchWithRetry } from "../src/fetch-retry";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("fetchWithRetry", () => {
	const maxTimerDelayMs = 2_147_483_647;

	it("routes requests through the `fetch` override when provided", async () => {
		const calls: Array<{ input: string | URL | Request; init: RequestInit | undefined }> = [];
		const customFetch = async (input: string | URL | Request, init?: RequestInit) => {
			calls.push({ input, init });
			return new Response("ok", { status: 200 });
		};

		const response = await fetchWithRetry("https://example.invalid/x", {
			method: "POST",
			body: "hi",
			fetch: customFetch,
		});

		expect(response.status).toBe(200);
		expect(await response.text()).toBe("ok");
		expect(calls).toHaveLength(1);
		expect(calls[0]?.input).toBe("https://example.invalid/x");
		expect(calls[0]?.init).toMatchObject({ method: "POST", body: "hi" });
	});

	it("retries through the override on transient failures", async () => {
		let attempt = 0;
		const customFetch = async () => {
			attempt += 1;
			if (attempt === 1) return new Response("", { status: 503 });
			return new Response("done", { status: 200 });
		};

		const response = await fetchWithRetry("https://example.invalid/y", {
			fetch: customFetch,
			defaultDelayMs: 1,
			maxAttempts: 3,
		});

		expect(response.status).toBe(200);
		expect(await response.text()).toBe("done");
		expect(attempt).toBe(2);
	});

	it("cancels response bodies that are discarded before a retry", async () => {
		const payload = new Uint8Array(1024 * 1024);
		const discardedResponse = new Response(
			new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(payload);
					controller.close();
				},
			}),
			{ status: 503 },
		);
		let attempt = 0;

		const response = await fetchWithRetry("https://example.invalid/discarded-body", {
			fetch: async () => {
				attempt += 1;
				return attempt === 1 ? discardedResponse : new Response("done", { status: 200 });
			},
			defaultDelayMs: 0,
			maxAttempts: 2,
		});

		expect(response.status).toBe(200);
		expect(discardedResponse.bodyUsed).toBe(true);
		await expect(discardedResponse.arrayBuffer()).rejects.toThrow();
	});

	it("continues retrying when discarded-body cancellation never settles", async () => {
		const discardedResponse = new Response("retry", { status: 503 });
		const cancellation = Promise.withResolvers<void>();
		// Bun 1.4 stopped keeping `response.body` referentially stable across
		// `response.clone()`; the retry loop re-reads `response.body` after
		// cloning, so cancellation lands on a different `ReadableStream`
		// instance than one snapshotted before the clone. Spy on the shared
		// prototype method instead, so the assertion observes the cancel
		// regardless of which instance receives it.
		const cancelSpy = vi.spyOn(ReadableStream.prototype, "cancel").mockImplementation(() => cancellation.promise);
		let attempt = 0;

		const request = fetchWithRetry("https://example.invalid/pending-cancel", {
			fetch: async () => {
				attempt += 1;
				return attempt === 1 ? discardedResponse : new Response("done", { status: 200 });
			},
			defaultDelayMs: 0,
			maxAttempts: 2,
		});

		const outcome = await Promise.race([
			request.then(() => "completed" as const),
			Bun.sleep(100).then(() => "timed-out" as const),
		]);
		cancellation.resolve();

		expect(outcome).toBe("completed");
		expect(cancelSpy).toHaveBeenCalledTimes(1);
		expect(attempt).toBe(2);
	});

	it("continues retrying when discarded-body cancellation rejects", async () => {
		const discardedResponse = new Response("retry", { status: 503 });
		const cancelSpy = vi
			.spyOn(ReadableStream.prototype, "cancel")
			.mockRejectedValue(new Error("transport refused cancellation"));
		let attempt = 0;

		const response = await fetchWithRetry("https://example.invalid/rejected-cancel", {
			fetch: async () => {
				attempt += 1;
				return attempt === 1 ? discardedResponse : new Response("done", { status: 200 });
			},
			defaultDelayMs: 0,
			maxAttempts: 2,
		});

		expect(response.status).toBe(200);
		expect(cancelSpy).toHaveBeenCalledTimes(1);
		expect(attempt).toBe(2);
	});

	it("observes external aborts while discarded-body cancellation remains pending", async () => {
		const controller = new AbortController();
		const discardedResponse = new Response("retry", { status: 503 });
		const cancellation = Promise.withResolvers<void>();
		const cleanupStarted = Promise.withResolvers<void>();
		const cancelSpy = vi.spyOn(ReadableStream.prototype, "cancel").mockImplementation(function (
			this: ReadableStream,
		) {
			cleanupStarted.resolve();
			return cancellation.promise;
		});
		let attempt = 0;

		const request = fetchWithRetry("https://example.invalid/abort-during-cancel", {
			fetch: async () => {
				attempt += 1;
				return discardedResponse;
			},
			defaultDelayMs: 0,
			maxAttempts: 2,
			signal: controller.signal,
		});

		await cleanupStarted.promise;
		controller.abort();
		const outcome = await Promise.race([
			request.then(
				() => ({ status: "resolved" as const }),
				error => ({ status: "rejected" as const, error }),
			),
			Bun.sleep(100).then(() => ({ status: "timed-out" as const })),
		]);
		cancellation.resolve();
		await request.catch(() => undefined);

		expect(outcome).toMatchObject({ status: "rejected", error: { name: "AbortError" } });
		expect(cancelSpy).toHaveBeenCalledTimes(1);
		expect(attempt).toBe(1);
	});

	it("does not consume an exhausted retryable response body", async () => {
		const finalResponse = new Response("retry later", { status: 503 });

		const response = await fetchWithRetry("https://example.invalid/final-body", {
			fetch: async () => finalResponse,
			maxAttempts: 1,
		});

		expect(response).toBe(finalResponse);
		expect(response.bodyUsed).toBe(false);
		expect(await response.text()).toBe("retry later");
	});

	it("does not consume a retryable response returned for a hint above the delay cap", async () => {
		const finalResponse = new Response("Please retry in 2s", { status: 429 });

		const response = await fetchWithRetry("https://example.invalid/capped-hint", {
			fetch: async () => finalResponse,
			maxAttempts: 2,
			maxDelayMs: 1,
		});

		expect(response).toBe(finalResponse);
		expect(response.bodyUsed).toBe(false);
		expect(await response.text()).toBe("Please retry in 2s");
	});

	it.each([
		["negative numeric", -1, 0],
		["NaN numeric", Number.NaN, 0],
		["negative-infinite numeric", Number.NEGATIVE_INFINITY, 0],
		["negative function result", () => -1, 0],
		["NaN function result", () => Number.NaN, 0],
		["negative-infinite function result", () => Number.NEGATIVE_INFINITY, 0],
		["negative array entry", [-1], 0],
		["NaN array entry", [Number.NaN], 0],
		["negative-infinite array entry", [Number.NEGATIVE_INFINITY], 0],
		["positive-infinite numeric capped to the maximum", Number.POSITIVE_INFINITY, 60_000],
		["positive-infinite function result capped to the maximum", () => Number.POSITIVE_INFINITY, 60_000],
		["positive-infinite array entry capped to the maximum", [Number.POSITIVE_INFINITY], 60_000],
		["finite numeric", 7, 7],
		["finite function result", () => 11, 11],
		["finite array entry", [13], 13],
	] satisfies Array<
		[string, NonNullable<FetchWithRetryOptions["defaultDelayMs"]>, number]
	>)("resolves %s before reaching the scheduler", async (_label, defaultDelayMs, expectedDelayMs) => {
		const waitSpy = vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		let attempt = 0;

		const response = await fetchWithRetry("https://example.invalid/delay", {
			fetch: async () => {
				attempt += 1;
				return new Response("", { status: attempt === 1 ? 503 : 200 });
			},
			defaultDelayMs,
			maxAttempts: 2,
		});

		expect(response.status).toBe(200);
		expect(waitSpy).toHaveBeenCalledTimes(1);
		expect(waitSpy).toHaveBeenCalledWith(expectedDelayMs, { signal: undefined });
	});

	it.each([
		["negative", -1, 0],
		["NaN", Number.NaN, 0],
		["negative-infinite", Number.NEGATIVE_INFINITY, 0],
		["positive-infinite", Number.POSITIVE_INFINITY, 7],
	] as const)("normalizes a %s response-path maximum at the scheduler boundary", async (_label, maxDelayMs, expected) => {
		const waitSpy = vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		let attempt = 0;

		const response = await fetchWithRetry("https://example.invalid/response-cap", {
			fetch: async () => {
				attempt += 1;
				return new Response("", { status: attempt === 1 ? 503 : 200 });
			},
			defaultDelayMs: 7,
			maxAttempts: 2,
			maxDelayMs,
		});

		expect(response.status).toBe(200);
		expect(waitSpy).toHaveBeenCalledWith(expected, { signal: undefined });
	});

	it("normalizes a hinted response delay after applying an invalid maximum", async () => {
		const waitSpy = vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		let attempt = 0;

		const response = await fetchWithRetry("https://example.invalid/hint-cap", {
			fetch: async () => {
				attempt += 1;
				return attempt === 1
					? new Response("", { status: 429, headers: { "retry-after": "1" } })
					: new Response("done", { status: 200 });
			},
			maxAttempts: 2,
			maxDelayMs: Number.NaN,
		});

		expect(response.status).toBe(200);
		expect(waitSpy).toHaveBeenCalledWith(0, { signal: undefined });
	});

	it.each([
		["negative", -1, 0],
		["NaN", Number.NaN, 0],
		["negative-infinite", Number.NEGATIVE_INFINITY, 0],
		["positive-infinite", Number.POSITIVE_INFINITY, 7],
	] as const)("normalizes a %s network-error maximum at the scheduler boundary", async (_label, maxDelayMs, expected) => {
		const waitSpy = vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		let attempt = 0;

		const response = await fetchWithRetry("https://example.invalid/network-cap", {
			fetch: async () => {
				attempt += 1;
				if (attempt === 1) throw new Error("temporary network failure");
				return new Response("done", { status: 200 });
			},
			defaultDelayMs: 7,
			maxAttempts: 2,
			maxDelayMs,
		});

		expect(response.status).toBe(200);
		expect(waitSpy).toHaveBeenCalledWith(expected, { signal: undefined });
	});

	it.each([
		["response", maxTimerDelayMs, maxTimerDelayMs],
		["response", maxTimerDelayMs + 1, maxTimerDelayMs],
		["response", 3_000_000_000, maxTimerDelayMs],
		["network", maxTimerDelayMs, maxTimerDelayMs],
		["network", maxTimerDelayMs + 1, maxTimerDelayMs],
		["network", 3_000_000_000, maxTimerDelayMs],
	] as const)("keeps the %s retry delay within the timer ceiling for %d ms", async (path, configuredDelayMs, expectedDelayMs) => {
		const waitSpy = vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		let attempt = 0;

		const response = await fetchWithRetry("https://example.invalid/timer-ceiling", {
			fetch: async () => {
				attempt += 1;
				if (attempt === 1) {
					if (path === "network") throw new Error("temporary network failure");
					return new Response("", { status: 503 });
				}
				return new Response("done", { status: 200 });
			},
			defaultDelayMs: configuredDelayMs,
			maxAttempts: 2,
			maxDelayMs: configuredDelayMs,
		});

		expect(response.status).toBe(200);
		expect(waitSpy).toHaveBeenCalledTimes(1);
		expect(waitSpy).toHaveBeenCalledWith(expectedDelayMs, { signal: undefined });
	});

	it("clamps a server retry hint at the timer ceiling", async () => {
		const waitSpy = vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		let attempt = 0;

		const response = await fetchWithRetry("https://example.invalid/hint-timer-ceiling", {
			fetch: async () => {
				attempt += 1;
				return attempt === 1
					? new Response("", { status: 429, headers: { "retry-after": "3000000" } })
					: new Response("done", { status: 200 });
			},
			maxAttempts: 2,
			maxDelayMs: 3_000_000_000,
		});

		expect(response.status).toBe(200);
		expect(waitSpy).toHaveBeenCalledTimes(1);
		expect(waitSpy).toHaveBeenCalledWith(maxTimerDelayMs, { signal: undefined });
	});
});
