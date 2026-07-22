import { afterEach, describe, expect, it, vi } from "bun:test";
import { HindsightApi, HindsightError } from "@gajae-code/coding-agent/hindsight/client";

const client = new HindsightApi({ baseUrl: "https://hindsight.test" });

afterEach(() => {
	vi.restoreAllMocks();
});

describe("HindsightApi response boundaries", () => {
	it("parses a normal JSON response", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ results: [{ text: "remember this" }] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		);

		await expect(client.recall("bank", "query")).resolves.toEqual({
			results: [{ text: "remember this" }],
		});
	});

	it("preserves structured API error mapping", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ detail: "service unavailable" }), { status: 503 }),
		);

		const error = await client.recall("bank", "query").catch(value => value);
		expect(error).toBeInstanceOf(HindsightError);
		expect(error).toMatchObject({ statusCode: 503, details: "service unavailable" });
		expect(error.message).toBe("recall failed: service unavailable");
	});

	it("rejects an oversized declared response before parsing it", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response("sensitive-response-content", {
				status: 200,
				headers: { "Content-Length": String(Number.MAX_SAFE_INTEGER) },
			}),
		);

		const error = await client.recall("bank", "query").catch(value => value);
		expect(error).toBeInstanceOf(HindsightError);
		expect(error.message).toContain("response exceeded size limit");
		expect(error.message).not.toContain("sensitive-response-content");
	});

	it("rejects a chunked response that crosses the streaming byte cap", async () => {
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new Uint8Array(8 * 1024 * 1024 + 1));
				controller.close();
			},
		});
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(body, { status: 200 }));

		const error = await client.recall("bank", "query").catch(value => value);
		expect(error).toBeInstanceOf(HindsightError);
		expect(error.message).toContain("response exceeded size limit");
	});

	it("maps an aborted stalled body to a content-free timeout error", async () => {
		const timeoutController = new AbortController();
		vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeoutController.signal);
		vi.spyOn(globalThis, "fetch").mockImplementation((async (
			_input: Parameters<typeof fetch>[0],
			init?: Parameters<typeof fetch>[1],
		) => {
			expect(init?.signal).toBe(timeoutController.signal);
			const body = new ReadableStream<Uint8Array>({
				start(controller) {
					init?.signal?.addEventListener("abort", () => {
						controller.error(new DOMException("sensitive upstream detail", "AbortError"));
					});
					queueMicrotask(() => timeoutController.abort());
				},
			});
			return new Response(body, { status: 200 });
		}) as unknown as typeof fetch);

		const error = await client.recall("bank", "query").catch(value => value);
		expect(error).toBeInstanceOf(HindsightError);
		expect(error.message).toBe("recall request failed: timed out");
		expect(error.message).not.toContain("sensitive upstream detail");
	});

	it("preserves the HTTP status for an oversized error response", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response("oversized-error", {
				status: 503,
				headers: { "Content-Length": String(Number.MAX_SAFE_INTEGER) },
			}),
		);

		const error = await client.recall("bank", "query").catch(value => value);
		expect(error).toMatchObject({ statusCode: 503 });
		expect(error.message).toBe("recall request failed: response exceeded size limit");
	});

	it("accepts a valid response exactly at the byte cap", async () => {
		const text = "x".repeat(8 * 1024 * 1024 - 11);
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ text })));

		await expect(client.reflect("bank", "query")).resolves.toEqual({ text });
	});

	it("decodes multibyte JSON split across body chunks", async () => {
		const bytes = new TextEncoder().encode(JSON.stringify({ text: "😀" }));
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(bytes.subarray(0, 11));
				controller.enqueue(bytes.subarray(11));
				controller.close();
			},
		});
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(body));

		await expect(client.reflect("bank", "query")).resolves.toEqual({ text: "😀" });
	});

	it("treats forged and duplicate Content-Length values as advisory", async () => {
		const headers = new Headers();
		headers.append("Content-Length", "1");
		headers.append("Content-Length", "999999999");
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ results: [] }), { headers }));

		await expect(client.recall("bank", "query")).resolves.toEqual({ results: [] });
	});

	it("counts expanded response bytes even when Content-Encoding is present", async () => {
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new Uint8Array(8 * 1024 * 1024 + 1));
				controller.close();
			},
		});
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(body, { headers: { "Content-Encoding": "gzip", "Content-Length": "1" } }),
		);

		await expect(client.recall("bank", "query")).rejects.toThrow("response exceeded size limit");
	});

	it("propagates the deadline while waiting for response headers", async () => {
		const timeoutController = new AbortController();
		vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeoutController.signal);
		vi.spyOn(globalThis, "fetch").mockImplementation(
			((_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
				new Promise((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => reject(new DOMException("late header", "AbortError")));
					queueMicrotask(() => timeoutController.abort());
				})) as unknown as typeof fetch,
		);

		await expect(client.recall("bank", "query")).rejects.toThrow("recall request failed: timed out");
	});

	it("cancels a 404 body without poisoning a later request", async () => {
		let cancelled = false;
		const body = new ReadableStream<Uint8Array>({
			cancel() {
				cancelled = true;
			},
		});
		vi.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(new Response(body, { status: 404 }))
			.mockResolvedValueOnce(new Response(JSON.stringify({ results: [] })));

		await expect(client.getDocument("bank", "missing")).resolves.toBeNull();
		await expect(client.recall("bank", "query")).resolves.toEqual({ results: [] });
		expect(cancelled).toBe(true);
	});

	it("keeps concurrent request budgets isolated", async () => {
		vi.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(new Response(JSON.stringify({ results: [] })))
			.mockResolvedValueOnce(new Response(new Uint8Array(8 * 1024 * 1024 + 1)));

		const [safe, oversized] = await Promise.allSettled([
			client.recall("bank", "safe"),
			client.recall("bank", "large"),
		]);
		expect(safe).toMatchObject({ status: "fulfilled", value: { results: [] } });
		expect(oversized).toMatchObject({ status: "rejected" });
	});

	it("maps a partial body read failure without exposing its abort reason", async () => {
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode('{"results":'));
				controller.error(new DOMException("sensitive partial-read reason", "AbortError"));
			},
		});
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(body, { status: 502 }));

		const error = await client.recall("bank", "query").catch(value => value);
		expect(error).toMatchObject({ statusCode: 502 });
		expect(error.message).toBe("recall request failed: response could not be read");
		expect(error.message).not.toContain("sensitive partial-read reason");
	});

	it("uses the configured URL with fetch's redirect handling", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ results: [] })));

		await expect(client.recall("bank with spaces", "query")).resolves.toEqual({ results: [] });
		expect(fetchSpy).toHaveBeenCalledWith(
			"https://hindsight.test/v1/default/banks/bank%20with%20spaces/memories/recall",
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		);
		const [, init] = fetchSpy.mock.calls[0]!;
		expect(init?.redirect).toBeUndefined();
	});

	it("keeps allow404 responses body-independent", async () => {
		let cancelled = false;
		const body = new ReadableStream<Uint8Array>({
			cancel() {
				cancelled = true;
			},
		});
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(body, {
				status: 404,
				headers: { "Content-Length": String(Number.MAX_SAFE_INTEGER) },
			}),
		);

		await expect(client.getDocument("bank", "missing")).resolves.toBeNull();
		expect(cancelled).toBe(true);
	});
});
