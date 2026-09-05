import { afterEach, describe, expect, it, vi } from "bun:test";
import type { AuthStorage } from "@gajae-code/ai";
import { hookFetch } from "@gajae-code/utils";
import { searchPerplexity } from "../../../src/web/search/providers/perplexity";
import { SearchProviderError } from "../../../src/web/search/types";

const originalApiKey = process.env.PERPLEXITY_API_KEY;
const originalCookies = process.env.PERPLEXITY_COOKIES;

const authStorage = {
	hasAuth: (provider: string) => provider === "perplexity",
	getOAuthAccess: async () => undefined,
} as unknown as AuthStorage;

function validResponse() {
	return {
		id: "response-1",
		model: "sonar-pro",
		created: 1,
		choices: [
			{
				index: 0,
				finish_reason: "stop",
				message: { role: "assistant", content: "A grounded answer." },
				delta: { role: "assistant", content: "" },
			},
		],
		citations: ["https://example.com/source"],
		search_results: [
			{
				title: "Example source",
				url: "https://example.com/source",
				snippet: "Evidence",
				date: "2026-09-04",
			},
		],
		usage: {
			prompt_tokens: 10,
			completion_tokens: 5,
			total_tokens: 15,
			cost: {
				input_tokens_cost: 0,
				output_tokens_cost: 0,
				total_cost: 0,
			},
		},
	};
}

function params(numSearchResults?: number) {
	return {
		query: "Perplexity contract test",
		num_search_results: numSearchResults,
		authStorage,
	};
}

afterEach(() => {
	vi.restoreAllMocks();
	if (originalApiKey === undefined) delete process.env.PERPLEXITY_API_KEY;
	else process.env.PERPLEXITY_API_KEY = originalApiKey;
	if (originalCookies === undefined) delete process.env.PERPLEXITY_COOKIES;
	else process.env.PERPLEXITY_COOKIES = originalCookies;
});

describe("Perplexity web search provider", () => {
	it.each([
		[0, 10],
		[2, 3],
		[3, 3],
		[100, 100],
		[101, 100],
	] as const)("normalizes num_search_results %d to %d", async (requested, expected) => {
		process.env.PERPLEXITY_API_KEY = "test-key";
		delete process.env.PERPLEXITY_COOKIES;
		let capturedBody: Record<string, unknown> | undefined;
		using _hook = hookFetch(async (_input, init) => {
			capturedBody = JSON.parse(String(init?.body));
			return Response.json(validResponse());
		});

		await searchPerplexity(params(requested));

		expect(capturedBody?.num_search_results).toBe(expected);
	});

	it("retries one structural-empty response and returns the valid retry", async () => {
		process.env.PERPLEXITY_API_KEY = "test-key";
		delete process.env.PERPLEXITY_COOKIES;
		let calls = 0;
		using _hook = hookFetch(async () => {
			calls++;
			if (calls === 1) {
				const response = validResponse();
				response.choices[0]!.message.content = "";
				response.usage.completion_tokens = 0;
				return Response.json(response);
			}
			return Response.json(validResponse());
		});

		const result = await searchPerplexity(params());

		expect(calls).toBe(2);
		expect(result.answer).toBe("A grounded answer.");
		expect(result.sources).toHaveLength(1);
	});

	it("propagates a provider error after repeated structural-empty responses", async () => {
		process.env.PERPLEXITY_API_KEY = "test-key";
		delete process.env.PERPLEXITY_COOKIES;
		let calls = 0;
		using _hook = hookFetch(async () => {
			calls++;
			const response = validResponse();
			response.choices[0]!.message.content = "";
			response.usage.completion_tokens = 0;
			return Response.json(response);
		});

		try {
			await searchPerplexity(params());
			throw new Error("Expected structural-empty response to fail");
		} catch (error) {
			expect(calls).toBe(2);
			expect(error).toBeInstanceOf(SearchProviderError);
			expect(error).toMatchObject({ provider: "perplexity", status: 424 });
			expect((error as Error).message).toContain("returned no answer");
		}
	});

	it.each([
		{ choices: "not-an-array" },
		{ citations: "not-an-array" },
		{ search_results: "not-an-array" },
		{ choices: [{ message: { content: { unexpected: true } } }] },
		{ citations: ["https://example.com", 42] },
		{ search_results: [{ title: "Missing URL" }] },
	])("rejects malformed response structures without leaking provider data", async patch => {
		process.env.PERPLEXITY_API_KEY = "test-key";
		delete process.env.PERPLEXITY_COOKIES;
		const secret = "provider-secret-payload";
		using _hook = hookFetch(async () => Response.json({ ...validResponse(), ...patch, secret }));

		try {
			await searchPerplexity(params());
			throw new Error("Expected malformed response to fail");
		} catch (error) {
			expect(error).toBeInstanceOf(SearchProviderError);
			expect(error).toMatchObject({ provider: "perplexity", status: 502 });
			expect((error as Error).message).toContain("malformed response body");
			expect((error as Error).message).not.toContain(secret);
		}
	});

	it("wraps invalid JSON as a sanitized provider error", async () => {
		process.env.PERPLEXITY_API_KEY = "test-key";
		delete process.env.PERPLEXITY_COOKIES;
		using _hook = hookFetch(async () => new Response("provider-secret-payload", { status: 200 }));

		try {
			await searchPerplexity(params());
			throw new Error("Expected invalid JSON to fail");
		} catch (error) {
			expect(error).toBeInstanceOf(SearchProviderError);
			expect(error).toMatchObject({ provider: "perplexity", status: 502 });
			expect((error as Error).message).toBe("Perplexity API returned invalid JSON");
		}
	});

	it("does not expose unclassified non-2xx response bodies", async () => {
		process.env.PERPLEXITY_API_KEY = "test-key";
		delete process.env.PERPLEXITY_COOKIES;
		const secret = "provider-secret-payload";
		using _hook = hookFetch(async () => new Response(secret, { status: 500 }));

		try {
			await searchPerplexity(params());
			throw new Error("Expected provider failure");
		} catch (error) {
			expect(error).toBeInstanceOf(SearchProviderError);
			expect(error).toMatchObject({ provider: "perplexity", status: 500 });
			expect((error as Error).message).toBe("Perplexity API error (500)");
			expect((error as Error).message).not.toContain(secret);
		}
	});

	it("preserves a valid answer when citation and result structures are empty", async () => {
		process.env.PERPLEXITY_API_KEY = "test-key";
		delete process.env.PERPLEXITY_COOKIES;
		using _hook = hookFetch(async () =>
			Response.json({
				...validResponse(),
				citations: [],
				search_results: [],
			}),
		);

		const result = await searchPerplexity(params());

		expect(result.answer).toBe("A grounded answer.");
		expect(result.sources).toEqual([]);
		expect(result.citations).toBeUndefined();
	});

	it("rejects an empty OAuth stream instead of returning an empty success", async () => {
		delete process.env.PERPLEXITY_API_KEY;
		process.env.PERPLEXITY_COOKIES = "session=test";
		using _hook = hookFetch(
			async () =>
				new Response("", {
					status: 200,
					headers: { "Content-Type": "text/event-stream" },
				}),
		);

		await expect(searchPerplexity(params())).rejects.toMatchObject({
			provider: "perplexity",
			status: 424,
		});
	});

	it("preserves valid answers, citations, sources, usage, and identifiers", async () => {
		process.env.PERPLEXITY_API_KEY = "test-key";
		delete process.env.PERPLEXITY_COOKIES;
		using _hook = hookFetch(async () => Response.json(validResponse()));

		const result = await searchPerplexity(params(10));

		expect(result).toMatchObject({
			provider: "perplexity",
			authMode: "api_key",
			answer: "A grounded answer.",
			model: "sonar-pro",
			requestId: "response-1",
			usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
			citations: [{ title: "Example source", url: "https://example.com/source" }],
			sources: [
				{
					title: "Example source",
					url: "https://example.com/source",
					snippet: "Evidence",
					publishedDate: "2026-09-04",
				},
			],
		});
	});
});
