import { describe, expect, it, vi } from "bun:test";
import { fetchWithRetry } from "../src/fetch-retry";

describe("fetchWithRetry", () => {
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
		const cancelSpy = vi.spyOn(discardedResponse.body!, "cancel").mockImplementation(() => cancellation.promise);
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
			.spyOn(discardedResponse.body!, "cancel")
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
		const cancelSpy = vi.spyOn(discardedResponse.body!, "cancel").mockImplementation(() => {
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
});
