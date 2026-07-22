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
		let body: { model?: unknown; tools?: unknown } | undefined;
		using _hook = hookFetch(async (_input, init) => {
			body = JSON.parse(String(init?.body)) as { model?: unknown; tools?: unknown };
			return Response.json({
				id: "r1",
				output_text: "answer",
				output: [{ content: [{ annotations: [{ type: "url_citation", url: "https://a.example", title: "A" }] }] }],
			});
		});
		await new OpenAICompatibleSearchProvider().search(params());
		expect(body?.tools).toEqual([{ type: "web_search" }]);
		expect(body?.model).toBe("gpt-5-mini");
	});

	it("falls back to Chat Completions with web_search_options when /responses is absent", async () => {
		for (const status of [404, 405]) {
			let body: { messages?: Array<{ content?: unknown }>; web_search_options?: unknown } | undefined;
			const urls: string[] = [];
			const requestHeaders: Headers[] = [];
			using _hook = hookFetch(async (input, init) => {
				const url = String(input);
				urls.push(url);
				requestHeaders.push(new Headers(init?.headers));
				if (url.endsWith("/responses")) return new Response("unavailable", { status });
				body = JSON.parse(String(init?.body)) as {
					messages?: Array<{ content?: unknown }>;
					web_search_options?: unknown;
				};
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
			const result = await new OpenAICompatibleSearchProvider().search(
				params({ ...baseCtx, api: "openai-completions" }),
			);
			expect(urls).toEqual(["https://llm.example/v1/responses", "https://llm.example/v1/chat/completions"]);
			expect(requestHeaders).toHaveLength(2);
			for (const headers of requestHeaders) {
				expect(headers.get("Authorization")).toBe("Bearer sk-custom");
				expect(headers.get("X-Test")).toBe("yes");
			}
			expect(body?.web_search_options).toEqual({});
			expect(body?.messages?.[1]?.content).toBe("news");
			expect(result.sources).toEqual([{ title: "B", url: "https://b.example", snippet: undefined }]);
		}
	});

	it("prefers /responses for search even when the model's chat wire is openai-completions", async () => {
		const urls: string[] = [];
		using _hook = hookFetch(async input => {
			urls.push(String(input));
			return Response.json({
				id: "r-pref",
				output: [
					{ type: "web_search_call", status: "completed", action: { type: "search" } },
					{
						type: "message",
						content: [
							{
								type: "output_text",
								text: "grounded",
								annotations: [{ type: "url_citation", url: "https://r.example", title: "R" }],
							},
						],
					},
				],
			});
		});
		const result = await new OpenAICompatibleSearchProvider().search(
			params({ ...baseCtx, api: "openai-completions" }),
		);
		expect(urls).toHaveLength(1);
		expect(urls[0]?.endsWith("/responses")).toBe(true);
		expect(result.sources).toEqual([{ title: "R", url: "https://r.example", snippet: undefined }]);
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

	it("wraps invalid JSON success bodies without exposing their contents", async () => {
		const body = `not-json-${"sensitive ".repeat(1_000)}`;
		using _hook = hookFetch(async () => new Response(body));
		try {
			await new OpenAICompatibleSearchProvider().search(params());
			throw new Error("Expected malformed response to fail");
		} catch (error) {
			expect(error).toBeInstanceOf(SearchProviderError);
			expect(error).toMatchObject({ provider: "openai-compatible", status: 502 });
			expect((error as Error).message).toContain("invalid JSON");
			expect((error as Error).message).not.toContain("sensitive");
			expect((error as Error).message.length).toBeLessThan(200);
		}
	});

	it("rejects scalar and array success bodies as malformed provider responses", async () => {
		for (const body of [null, 42, "scalar-root-secret", []]) {
			using _hook = hookFetch(async () => Response.json(body));
			try {
				await new OpenAICompatibleSearchProvider().search(params());
				throw new Error("Expected malformed response to fail");
			} catch (error) {
				expect(error).toMatchObject({ provider: "openai-compatible", status: 502 });
				expect((error as Error).message).not.toContain("scalar-root-secret");
				expect((error as Error).message.length).toBeLessThan(200);
			}
		}
	});

	it("rejects wrong-shaped consumed arrays without exposing response bodies", async () => {
		const secret = "wrong-shaped-array-secret";
		const malformedBodies = [
			{ output: `${secret}-output` },
			{ choices: `${secret}-choices` },
			{ output: [{ content: `${secret}-content` }] },
			{ output: [{ content: [{ annotations: `${secret}-output-annotations` }] }] },
			{ choices: [{ message: { annotations: `${secret}-choice-annotations` } }] },
		];

		for (const body of malformedBodies) {
			using _hook = hookFetch(async () => Response.json(body));
			try {
				await new OpenAICompatibleSearchProvider().search(params());
				throw new Error("Expected malformed response to fail");
			} catch (error) {
				expect(error).toMatchObject({ provider: "openai-compatible", status: 502 });
				expect((error as Error).message).not.toContain(secret);
				expect((error as Error).message.length).toBeLessThan(200);
			}
		}
	});

	it("skips non-object response entries while retaining citations and string request ids", async () => {
		using _hook = hookFetch(async () =>
			Response.json({
				id: "string-request-id",
				output: [
					null,
					42,
					{
						content: [
							null,
							"text",
							{
								annotations: [null, { type: "url_citation", url: "https://entries.example", title: "Entries" }],
							},
						],
					},
				],
				choices: [
					null,
					42,
					{ message: null },
					{
						message: {
							annotations: [null, { type: "url_citation", url: "https://entries.example", title: "Entries" }],
						},
					},
				],
			}),
		);
		const result = await new OpenAICompatibleSearchProvider().search(params());
		expect(result.requestId).toBe("string-request-id");
		expect(result.sources).toEqual([{ title: "Entries", url: "https://entries.example", snippet: undefined }]);
	});

	it("omits non-string response ids", async () => {
		using _hook = hookFetch(async () =>
			Response.json({
				id: 42,
				output: [
					{ content: [{ annotations: [{ type: "url_citation", url: "https://id.example", title: "ID" }] }] },
				],
			}),
		);
		const result = await new OpenAICompatibleSearchProvider().search(params());
		expect(result.requestId).toBeUndefined();
	});

	it("classifies non-success responses without parsing them as successful bodies", async () => {
		const body = "non-success-body-secret";
		using _hook = hookFetch(async () => new Response(body, { status: 500 }));
		try {
			await new OpenAICompatibleSearchProvider().search(params());
			throw new Error("Expected HTTP failure");
		} catch (error) {
			expect(error).toMatchObject({ provider: "openai-compatible", status: 500 });
			expect((error as Error).message).toContain(body);
			expect((error as Error).message).not.toContain("invalid JSON");
		}
	});

	it("preserves abort errors from fetch", async () => {
		const abort = new Error("Aborted");
		abort.name = "AbortError";
		using _hook = hookFetch(async () => {
			throw abort;
		});
		await expect(new OpenAICompatibleSearchProvider().search(params())).rejects.toBe(abort);
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
