import { afterEach, describe, expect, it, vi } from "bun:test";
import type { AuthStorage } from "@gajae-code/ai";
import { hookFetch } from "@gajae-code/utils";
import type { SearchParams } from "../../src/web/search/providers/base";
import { searchCodex } from "../../src/web/search/providers/codex";

type CapturedRequest = {
	url: string;
	headers: RequestInit["headers"];
	body: Record<string, unknown> | null;
};

const originalCodexSearchModel = process.env.PI_CODEX_WEB_SEARCH_MODEL;

function makeSseResponse(model: string): string {
	return [
		`data: ${JSON.stringify({
			type: "response.output_item.done",
			item: {
				type: "message",
				content: [
					{
						type: "output_text",
						text: "Codex answer",
						annotations: [{ type: "url_citation", url: "https://example.com/article", title: "Example Article" }],
					},
				],
			},
		})}`,
		"",
		`data: ${JSON.stringify({
			type: "response.completed",
			response: {
				id: "resp_codex_test",
				model,
				usage: {
					input_tokens: 12,
					output_tokens: 7,
					total_tokens: 19,
				},
			},
		})}`,
		"",
	].join("\n");
}

function makeImagePlaceholderSseResponse(model: string): string {
	return [
		`data: ${JSON.stringify({
			type: "response.output_text.delta",
			delta: "OpenAI Responses API defaults `store` to false unless you opt in.",
		})}`,
		"",
		`data: ${JSON.stringify({
			type: "response.output_item.done",
			item: {
				type: "message",
				content: [
					{
						type: "output_text",
						text: "(see attached image)",
						annotations: [
							{ type: "url_citation", url: "https://platform.openai.com/docs/api-reference/responses" },
						],
					},
				],
			},
		})}`,
		"",
		`data: ${JSON.stringify({
			type: "response.completed",
			response: {
				id: "resp_codex_placeholder_test",
				model,
			},
		})}`,
		"",
	].join("\n");
}

function makeMarkdownLinkSseResponse(model: string): string {
	return [
		`data: ${JSON.stringify({
			type: "response.output_item.done",
			item: {
				type: "message",
				content: [
					{
						type: "output_text",
						text: "See [Example Article](https://example.com/article) for details.",
						annotations: [],
					},
				],
			},
		})}`,
		"",
		`data: ${JSON.stringify({
			type: "response.completed",
			response: { id: "resp_codex_markdown_test", model },
		})}`,
		"",
	].join("\n");
}

function makePlainUrlSseResponse(model: string): string {
	return [
		`data: ${JSON.stringify({
			type: "response.output_item.done",
			item: {
				type: "message",
				content: [
					{
						type: "output_text",
						text: "Sources:\n- https://example.com/article\n- https://example.com/faq",
						annotations: [],
					},
				],
			},
		})}`,
		"",
		`data: ${JSON.stringify({
			type: "response.completed",
			response: { id: "resp_codex_plain_url_test", model },
		})}`,
		"",
	].join("\n");
}

function makeMarkdownParenthesesSseResponse(model: string): string {
	return [
		`data: ${JSON.stringify({
			type: "response.output_item.done",
			item: {
				type: "message",
				content: [
					{
						type: "output_text",
						text: "See [Function](https://en.wikipedia.org/wiki/Function_(mathematics)) for details.",
						annotations: [],
					},
				],
			},
		})}`,
		"",
		`data: ${JSON.stringify({
			type: "response.completed",
			response: { id: "resp_codex_markdown_parentheses_test", model },
		})}`,
		"",
	].join("\n");
}

function makePlainUrlPunctuationSseResponse(model: string): string {
	return [
		`data: ${JSON.stringify({
			type: "response.output_item.done",
			item: {
				type: "message",
				content: [
					{
						type: "output_text",
						text: "Read https://example.com/article. Then compare https://example.com/faq), and keep https://en.wikipedia.org/wiki/Function_(mathematics).",
						annotations: [],
					},
				],
			},
		})}`,
		"",
		`data: ${JSON.stringify({
			type: "response.completed",
			response: { id: "resp_codex_plain_url_punctuation_test", model },
		})}`,
		"",
	].join("\n");
}

describe("searchCodex model selection", () => {
	const fakeAuthStorage = {
		async getOAuthAccess() {
			return {
				accessToken: "test-access-token",
				accountId: "acct-test",
			};
		},
		hasOAuth() {
			return true;
		},
	} as unknown as AuthStorage;
	let capturedRequest: CapturedRequest | null = null;

	function makeSearchParams(query: string): SearchParams {
		return {
			query,
			systemPrompt: "Codex test system prompt",
			authStorage: fakeAuthStorage,
		};
	}

	function mockCodexFetch(responseModel: string, responseBody?: string): Disposable {
		capturedRequest = null;
		return hookFetch((url, init) => {
			capturedRequest = {
				url: typeof url === "string" ? url : url.toString(),
				headers: init?.headers,
				body: init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : null,
			};
			return new Response(responseBody ?? makeSseResponse(responseModel), {
				status: 200,
				headers: { "Content-Type": "text/event-stream" },
			});
		});
	}

	afterEach(() => {
		vi.restoreAllMocks();
		capturedRequest = null;
		if (originalCodexSearchModel === undefined) {
			delete process.env.PI_CODEX_WEB_SEARCH_MODEL;
		} else {
			process.env.PI_CODEX_WEB_SEARCH_MODEL = originalCodexSearchModel;
		}
	});

	it("uses the built-in default model when PI_CODEX_WEB_SEARCH_MODEL is unset", async () => {
		delete process.env.PI_CODEX_WEB_SEARCH_MODEL;
		using _hook = mockCodexFetch("gpt-5.5");

		const result = await searchCodex(makeSearchParams("default codex model"));

		expect(capturedRequest).not.toBeNull();
		expect(capturedRequest?.url).toBe("https://chatgpt.com/backend-api/codex/responses");
		expect(capturedRequest?.body?.model).toBe("gpt-5.5");
		expect(result.model).toBe("gpt-5.5");
		expect(result.sources).toEqual([{ title: "Example Article", url: "https://example.com/article" }]);
	});

	it("falls back to the default model when PI_CODEX_WEB_SEARCH_MODEL is blank", async () => {
		process.env.PI_CODEX_WEB_SEARCH_MODEL = "   ";
		using _hook = mockCodexFetch("gpt-5.5");

		const result = await searchCodex(makeSearchParams("blank codex model"));

		expect(capturedRequest).not.toBeNull();
		expect(capturedRequest?.body?.model).toBe("gpt-5.5");
		expect(result.model).toBe("gpt-5.5");
	});
	it("retries the next bundled default when Codex rejects a model for ChatGPT accounts", async () => {
		delete process.env.PI_CODEX_WEB_SEARCH_MODEL;
		let calls = 0;
		capturedRequest = null;
		using _hook = hookFetch((url, init) => {
			calls += 1;
			capturedRequest = {
				url: typeof url === "string" ? url : url.toString(),
				headers: init?.headers,
				body: init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : null,
			};

			const requestedModel = capturedRequest.body?.model;
			if (calls === 1) {
				expect(requestedModel).toBe("gpt-5.5");
				return new Response(
					JSON.stringify({
						detail: "The 'gpt-5.5' model is not supported when using Codex with a ChatGPT account.",
					}),
					{ status: 400, headers: { "Content-Type": "application/json" } },
				);
			}

			expect(requestedModel).toBe("gpt-5.4");
			return new Response(makeSseResponse("gpt-5.4"), {
				status: 200,
				headers: { "Content-Type": "text/event-stream" },
			});
		});

		const result = await searchCodex(makeSearchParams("retry unsupported default"));

		expect(calls).toBe(2);
		expect(result.model).toBe("gpt-5.4");
		expect(result.sources).toEqual([{ title: "Example Article", url: "https://example.com/article" }]);
	});

	it("uses PI_CODEX_WEB_SEARCH_MODEL when provided", async () => {
		process.env.PI_CODEX_WEB_SEARCH_MODEL = "gpt-5.4-mini";
		using _hook = mockCodexFetch("gpt-5.4-mini");

		const result = await searchCodex(makeSearchParams("overridden codex model"));

		expect(capturedRequest).not.toBeNull();
		expect(capturedRequest?.body?.model).toBe("gpt-5.4-mini");
		expect(result.model).toBe("gpt-5.4-mini");
	});

	it("forces web_search tool choice and extracts markdown link citations when annotations are absent", async () => {
		process.env.PI_CODEX_WEB_SEARCH_MODEL = "gpt-5.4";
		using _hook = mockCodexFetch("gpt-5.4", makeMarkdownLinkSseResponse("gpt-5.4"));

		const result = await searchCodex(makeSearchParams("markdown citations"));

		expect(capturedRequest).not.toBeNull();
		expect(capturedRequest?.body?.tool_choice).toEqual({ type: "web_search" });
		expect(result.sources).toEqual([{ title: "Example Article", url: "https://example.com/article" }]);
	});

	it("extracts plain text URLs when annotations are absent", async () => {
		process.env.PI_CODEX_WEB_SEARCH_MODEL = "gpt-5.4";
		using _hook = mockCodexFetch("gpt-5.4", makePlainUrlSseResponse("gpt-5.4"));

		const result = await searchCodex(makeSearchParams("plain url citations"));

		expect(result.sources).toEqual([
			{ title: "https://example.com/article", url: "https://example.com/article" },
			{ title: "https://example.com/faq", url: "https://example.com/faq" },
		]);
	});

	it("preserves markdown URLs that contain balanced parentheses", async () => {
		process.env.PI_CODEX_WEB_SEARCH_MODEL = "gpt-5.4";
		using _hook = mockCodexFetch("gpt-5.4", makeMarkdownParenthesesSseResponse("gpt-5.4"));

		const result = await searchCodex(makeSearchParams("markdown parentheses citations"));

		expect(result.sources).toEqual([
			{ title: "Function", url: "https://en.wikipedia.org/wiki/Function_(mathematics)" },
		]);
	});

	it("strips trailing prose punctuation from plain text URLs", async () => {
		process.env.PI_CODEX_WEB_SEARCH_MODEL = "gpt-5.4";
		using _hook = mockCodexFetch("gpt-5.4", makePlainUrlPunctuationSseResponse("gpt-5.4"));

		const result = await searchCodex(makeSearchParams("plain url punctuation"));

		expect(result.sources).toEqual([
			{ title: "https://example.com/article", url: "https://example.com/article" },
			{ title: "https://example.com/faq", url: "https://example.com/faq" },
			{
				title: "https://en.wikipedia.org/wiki/Function_(mathematics)",
				url: "https://en.wikipedia.org/wiki/Function_(mathematics)",
			},
		]);
	});

	it("prefers streamed text when the final item only contains an image placeholder", async () => {
		using _hook = hookFetch(() => {
			return new Response(makeImagePlaceholderSseResponse("gpt-5.4-mini"), {
				status: 200,
				headers: { "Content-Type": "text/event-stream" },
			});
		});

		const result = await searchCodex(makeSearchParams("responses api store semantics"));

		expect(result.answer).toBe("OpenAI Responses API defaults `store` to false unless you opt in.");
		expect(result.sources).toEqual([
			{
				title: "https://platform.openai.com/docs/api-reference/responses",
				url: "https://platform.openai.com/docs/api-reference/responses",
			},
		]);
	});
});
