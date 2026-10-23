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
							acquired_at: "2026-10-01T00:00:00Z",
						},
						{ url: "https://example.com/two", description: "", snippet: "" },
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
				{ title: "Result One", url: "https://example.com/one", snippet: "First line second line" },
				{ title: "https://example.com/two", url: "https://example.com/two", snippet: undefined },
			],
			authMode: undefined,
		});
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

	it("clamps result counts and maps recency to a published_after date", () => {
		const now = new Date("2026-10-23T12:00:00Z");
		expect(buildRequestBody({ query: "q" }, now)).toEqual({ query: "q", max_results: 10 });
		expect(buildRequestBody({ query: "q", num_results: 500 }, now)).toEqual({ query: "q", max_results: 50 });
		expect(buildRequestBody({ query: "q", recency: "day" }, now)).toMatchObject({ published_after: "2026-10-22" });
		expect(buildRequestBody({ query: "q", recency: "week" }, now)).toMatchObject({ published_after: "2026-10-16" });
		expect(buildRequestBody({ query: "q", recency: "month" }, now)).toMatchObject({ published_after: "2026-09-23" });
		expect(buildRequestBody({ query: "q", recency: "year" }, now)).toMatchObject({ published_after: "2025-10-23" });
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
