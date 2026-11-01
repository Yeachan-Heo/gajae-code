import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AuthStorage } from "@gajae-code/ai";
import { hookFetch } from "@gajae-code/utils";
import { buildRequestBody, KeenableProvider, searchKeenable } from "../../src/web/search/providers/keenable";
import type { SearchProviderError } from "../../src/web/search/types";

describe("Keenable web search provider", () => {
	beforeEach(() => {
		delete process.env.KEENABLE_API_KEY;
	});

	afterEach(() => {
		vi.restoreAllMocks();
		delete process.env.KEENABLE_API_KEY;
	});

	const fakeAuthStorage = {
		async getApiKey() {
			return process.env.KEENABLE_API_KEY ?? undefined;
		},
		hasAuth() {
			return Boolean(process.env.KEENABLE_API_KEY);
		},
	} as unknown as AuthStorage;

	function makeParams(query: string) {
		return {
			query,
			authStorage: fakeAuthStorage,
			systemPrompt: "Keenable test prompt",
		} as const;
	}

	it("is available without credentials", () => {
		expect(new KeenableProvider().isAvailable(fakeAuthStorage)).toBe(true);
	});

	it("calls the public endpoint keylessly and maps snippets into SearchResponse", async () => {
		let requestUrl = "";
		let requestHeaders = new Headers();
		let requestBody: unknown = null;

		using _hook = hookFetch(async (input, init) => {
			requestUrl = String(input);
			requestHeaders = new Headers(init?.headers);
			requestBody = JSON.parse(String(init?.body ?? "null"));
			return new Response(
				JSON.stringify({
					results: [
						{
							title: "Result One",
							url: "https://example.com/one",
							description: "",
							snippet: "First line\n\n  second   line",
							published_at: "2026-09-30T08:15:00Z",
							acquired_at: "2026-10-01T00:00:00Z",
						},
						{ url: "https://example.com/two", description: "", snippet: "", published_at: null },
						{ title: "No URL", snippet: "dropped" },
					],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		});

		const response = await searchKeenable({ ...makeParams("bun test runner"), numSearchResults: 2 });
		expect(requestUrl).toBe("https://api.keenable.ai/v1/search/public");
		expect(requestHeaders.get("X-Keenable-Title")).toBe("Gajae-Code");
		expect(requestHeaders.has("X-API-Key")).toBe(false);
		expect(requestBody).toEqual({ query: "bun test runner", max_results: 2 });
		expect(response).toEqual({
			provider: "keenable",
			sources: [
				{
					title: "Result One",
					url: "https://example.com/one",
					snippet: "First line second line",
					publishedDate: "2026-09-30T08:15:00Z",
					ageSeconds: expect.any(Number),
				},
				{ title: "https://example.com/two", url: "https://example.com/two", snippet: undefined },
			],
			authMode: undefined,
		});
		expect(response.sources[1]?.publishedDate).toBeUndefined();
		expect(response.sources[1]?.ageSeconds).toBeUndefined();
	});

	it("uses the keyed endpoint with X-API-Key when a key is configured", async () => {
		process.env.KEENABLE_API_KEY = "test-keenable-key";
		let requestUrl = "";
		let requestHeaders = new Headers();

		using _hook = hookFetch(async (input, init) => {
			requestUrl = String(input);
			requestHeaders = new Headers(init?.headers);
			return new Response(JSON.stringify({ results: [] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		});

		const response = await searchKeenable(makeParams("keyed query"));
		expect(requestUrl).toBe("https://api.keenable.ai/v1/search");
		expect(requestHeaders.get("X-API-Key")).toBe("test-keenable-key");
		expect(requestHeaders.get("X-Keenable-Title")).toBe("Gajae-Code");
		expect(response).toMatchObject({ provider: "keenable", sources: [], authMode: "api_key" });
	});

	it("clamps result counts and maps recency to an exact published_after timestamp", () => {
		// Non-midnight on purpose: a date-only cutoff would widen the window to 00:00 UTC.
		const now = new Date("2026-10-23T12:34:56.789Z");
		expect(buildRequestBody({ query: "q" }, now)).toEqual({ query: "q", max_results: 10 });
		expect(buildRequestBody({ query: "q", num_results: 500 }, now)).toEqual({ query: "q", max_results: 50 });
		expect(buildRequestBody({ query: "q", recency: "day" }, now)).toEqual({
			query: "q",
			max_results: 10,
			published_after: "2026-10-22T12:34:56.789Z",
		});
		expect(buildRequestBody({ query: "q", recency: "week" }, now)).toMatchObject({
			published_after: "2026-10-16T12:34:56.789Z",
		});
		expect(buildRequestBody({ query: "q", recency: "month" }, now)).toMatchObject({
			published_after: "2026-09-23T12:34:56.789Z",
		});
		expect(buildRequestBody({ query: "q", recency: "year" }, now)).toMatchObject({
			published_after: "2025-10-23T12:34:56.789Z",
		});
	});

	it("sends the exact recency cutoff in the request body", async () => {
		let requestBody: Record<string, unknown> = {};
		using _hook = hookFetch(async (_input, init) => {
			requestBody = JSON.parse(String(init?.body ?? "{}"));
			return new Response(JSON.stringify({ results: [] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		});

		const before = Date.now();
		await searchKeenable({ ...makeParams("recent news"), recency: "day" });
		const after = Date.now();

		const cutoff = requestBody.published_after;
		expect(typeof cutoff).toBe("string");
		expect(cutoff).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
		const cutoffMs = Date.parse(cutoff as string);
		expect(cutoffMs).toBeGreaterThanOrEqual(before - 24 * 60 * 60 * 1000);
		expect(cutoffMs).toBeLessThanOrEqual(after - 24 * 60 * 60 * 1000);
	});

	it("surfaces rate-limit errors with the API message", async () => {
		using _hook = hookFetch(
			() =>
				new Response(JSON.stringify({ error: "Rate limit exceeded", message: "Too many requests" }), {
					status: 429,
					headers: { "Content-Type": "application/json" },
				}),
		);

		await expect(searchKeenable(makeParams("too many"))).rejects.toEqual(
			expect.objectContaining({
				provider: "keenable",
				status: 429,
				message: "Keenable API error (429): Too many requests",
			}) satisfies Partial<SearchProviderError>,
		);
	});

	it("bounds unclassified provider error text", async () => {
		const body = `<html>\n<body>\u001b[31m${"upstream exploded ".repeat(200)}</body>\n</html>`;
		using _hook = hookFetch(() => new Response(body, { status: 503, headers: { "Content-Type": "text/html" } }));

		const error = (await searchKeenable(makeParams("server error")).catch(err => err)) as SearchProviderError;
		const prefix = "Keenable API error (503): ";
		expect(error.provider).toBe("keenable");
		expect(error.status).toBe(503);
		expect(error.message.startsWith(`${prefix}<html> <body> [31mupstream exploded`)).toBe(true);
		expect(error.message.endsWith("…")).toBe(true);
		expect(error.message.length).toBe(prefix.length + 200);
		expect(error.message).not.toMatch(/[\n\u001b]/);
	});

	it("classifies rejected keys", async () => {
		process.env.KEENABLE_API_KEY = "bad-key";
		using _hook = hookFetch(
			() =>
				new Response(JSON.stringify({ error: "Authentication failed", message: "Malformed API key" }), {
					status: 401,
					headers: { "Content-Type": "application/json" },
				}),
		);

		await expect(searchKeenable(makeParams("bad auth"))).rejects.toEqual(
			expect.objectContaining({
				provider: "keenable",
				status: 401,
				message: "keenable: 401 unauthorized",
			}) satisfies Partial<SearchProviderError>,
		);
	});
});
