import { afterEach, describe, expect, it, vi } from "bun:test";
import { hookFetch } from "@gajae-code/utils";
import type { AuthStorage } from "../../../src/session/auth-storage";
import { OpenAICompatibleSearchProvider } from "../../../src/web/search/providers/openai-compatible";
import { type ActiveSearchModelContext, SearchProviderError } from "../../../src/web/search/types";

function auth(keys: Record<string, string> = {}): AuthStorage {
	return {
		getApiKey: (provider: string) => keys[provider],
	} as unknown as AuthStorage;
}

const baseCtx: ActiveSearchModelContext = {
	provider: "custom",
	modelId: "gpt-5-mini",
	api: "openai-responses",
	baseUrl: "https://llm.example/v1",
	headers: { "X-Test": "yes" },
};

function params(ctx: ActiveSearchModelContext = baseCtx, store = auth({ custom: "sk-custom" })) {
	return { query: "news", systemPrompt: "search", authStorage: store, activeModelContext: ctx };
}

afterEach(() => vi.restoreAllMocks());

describe("OpenAI-compatible web search provider", () => {
	it("sends Responses requests with the web_search tool", async () => {
		let body: any;
		using _hook = hookFetch(async (_input, init) => {
			body = JSON.parse(String(init?.body));
			return Response.json({
				id: "r1",
				output_text: "answer",
				output: [{ content: [{ annotations: [{ type: "url_citation", url: "https://a.example", title: "A" }] }] }],
			});
		});
		await new OpenAICompatibleSearchProvider().search(params());
		expect(body.tools).toEqual([{ type: "web_search" }]);
		expect(body.model).toBe("gpt-5-mini");
	});

	it("sends Chat Completions requests with web_search_options", async () => {
		let body: any;
		using _hook = hookFetch(async (_input, init) => {
			body = JSON.parse(String(init?.body));
			return Response.json({
				choices: [
					{
						message: {
							content: "answer",
							annotations: [{ type: "url_citation", url: "https://b.example", title: "B" }],
						},
					},
				],
			});
		});
		await new OpenAICompatibleSearchProvider().search(params({ ...baseCtx, api: "openai-completions" }));
		expect(body.web_search_options).toEqual({});
		expect(body.messages[1].content).toBe("news");
	});

	it("parses citations into sources", async () => {
		using _hook = hookFetch(async () =>
			Response.json({
				output_text: "answer",
				output: [
					{
						content: [
							{
								text: "answer",
								annotations: [{ type: "url_citation", url: "https://c.example", title: "C", text: "quote" }],
							},
						],
					},
				],
			}),
		);
		const result = await new OpenAICompatibleSearchProvider().search(params());
		expect(result.provider).toBe("openai-compatible");
		expect(result.sources).toEqual([{ title: "C", url: "https://c.example", snippet: "quote" }]);
	});

	it("throws 424 when the response has no citations", async () => {
		using _hook = hookFetch(async () => Response.json({ output_text: "plain answer" }));
		await expect(new OpenAICompatibleSearchProvider().search(params())).rejects.toMatchObject({
			provider: "openai-compatible",
			status: 424,
		});
	});

	it("does not accept non-url_citation source metadata as a citation (no masking)", async () => {
		using _hook = hookFetch(async () =>
			Response.json({
				output_text: "answer with stray metadata",
				// A response that ignored web_search but carries unrelated URL-bearing
				// objects (type "source", bare url fields) MUST NOT be treated as a search result.
				output: [
					{
						content: [
							{ text: "answer", annotations: [{ type: "source", url: "https://nope.example", title: "Nope" }] },
						],
					},
				],
				sources: [{ url: "https://also-nope.example" }],
				metadata: { citation: { url: "https://still-nope.example" } },
			}),
		);
		await expect(new OpenAICompatibleSearchProvider().search(params())).rejects.toMatchObject({
			provider: "openai-compatible",
			status: 424,
		});
	});

	it("does not fetch without an exact active-provider key", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		await expect(new OpenAICompatibleSearchProvider().search(params(baseCtx, auth()))).rejects.toBeInstanceOf(
			SearchProviderError,
		);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("keeps concurrent request context isolated", async () => {
		const seen: string[] = [];
		using _hook = hookFetch(async (input, init) => {
			seen.push(`${input}:${(init?.headers as Record<string, string>).Authorization}`);
			return Response.json({
				output_text: "answer",
				output: [{ content: [{ annotations: [{ type: "url_citation", url: "https://d.example", title: "D" }] }] }],
			});
		});
		const provider = new OpenAICompatibleSearchProvider();
		await Promise.all([
			provider.search(params({ ...baseCtx, provider: "a", baseUrl: "https://a.example/v1" }, auth({ a: "sk-a" }))),
			provider.search(params({ ...baseCtx, provider: "b", baseUrl: "https://b.example/v1" }, auth({ b: "sk-b" }))),
		]);
		expect(seen).toContain("https://a.example/v1/responses:Bearer sk-a");
		expect(seen).toContain("https://b.example/v1/responses:Bearer sk-b");
	});

	it("passes a composed abort signal to fetch", async () => {
		const ac = new AbortController();
		let captured: AbortSignal | undefined | null;
		using _hook = hookFetch(async (_input, init) => {
			captured = init?.signal;
			return Response.json({
				output_text: "answer",
				output: [{ content: [{ annotations: [{ type: "url_citation", url: "https://e.example", title: "E" }] }] }],
			});
		});
		await new OpenAICompatibleSearchProvider().search({
			...params(baseCtx, auth({ custom: "sk" })),
			signal: ac.signal,
		});
		expect(captured).toBeInstanceOf(AbortSignal);
		expect(captured).not.toBe(ac.signal);
	});
});
