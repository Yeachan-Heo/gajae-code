import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AuthStorage } from "@gajae-code/ai";
import { getBundledModels } from "@gajae-code/ai/core";
import * as codexDiscovery from "@gajae-code/ai/utils/discovery/codex";
import { hookFetch } from "@gajae-code/utils";
import type { SearchParams } from "../../src/web/search/providers/base";
import { searchCodex } from "../../src/web/search/providers/codex";
import { SearchProviderError } from "../../src/web/search/types";

type CapturedRequest = {
	url: string;
	headers: RequestInit["headers"];
	body: Record<string, unknown> | null;
};

const originalCodexSearchModel = process.env.PI_CODEX_WEB_SEARCH_MODEL;
const originalDocumentedCodexSearchModel = process.env.GJC_OPENAI_CODE_WEB_SEARCH_MODEL;
const bundledModels = getBundledModels("openai-codex");

function mockDiscovery(ids: readonly string[] | null) {
	const models = ids?.map(id => {
		const model = bundledModels.find(model => model.id === id);
		if (!model) throw new Error(`Missing bundled Codex model fixture: ${id}`);
		return { ...model, api: "openai-codex-responses" as const };
	});
	return vi.spyOn(codexDiscovery, "fetchCodexModels").mockResolvedValue(models ? { models } : null);
}

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

	function expectAuthenticatedDiscovery() {
		const discovery = vi.spyOn(codexDiscovery, "fetchCodexModels");
		expect(discovery).toHaveBeenCalledTimes(1);
		const options = discovery.mock.calls[0]?.[0];
		// Compare privately so assertion failures never print auth values.
		expect(options?.accessToken === "test-access-token").toBe(true);
		expect(options?.accountId === "acct-test").toBe(true);
		expect(options?.signal).toBeInstanceOf(AbortSignal);
		expect(options?.signal?.aborted).toBe(false);
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

	beforeEach(() => {
		delete process.env.PI_CODEX_WEB_SEARCH_MODEL;
		delete process.env.GJC_OPENAI_CODE_WEB_SEARCH_MODEL;
		mockDiscovery(["gpt-6.1-sol", "gpt-6-luna"]);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		capturedRequest = null;
		if (originalCodexSearchModel === undefined) {
			delete process.env.PI_CODEX_WEB_SEARCH_MODEL;
		} else {
			process.env.PI_CODEX_WEB_SEARCH_MODEL = originalCodexSearchModel;
		}
		if (originalDocumentedCodexSearchModel === undefined) {
			delete process.env.GJC_OPENAI_CODE_WEB_SEARCH_MODEL;
		} else {
			process.env.GJC_OPENAI_CODE_WEB_SEARCH_MODEL = originalDocumentedCodexSearchModel;
		}
	});

	it("uses Sol by default and requests the web_search tool", async () => {
		using _hook = mockCodexFetch("gpt-6.1-sol");

		const result = await searchCodex(makeSearchParams("default codex model"));

		expectAuthenticatedDiscovery();
		expect(capturedRequest).not.toBeNull();
		expect(capturedRequest?.url).toBe("https://chatgpt.com/backend-api/codex/responses");
		expect(capturedRequest?.body?.model).toBe("gpt-6.1-sol");
		expect(capturedRequest?.body?.tools).toEqual([{ type: "web_search", search_context_size: "high" }]);
		expect(capturedRequest?.body?.tool_choice).toEqual({ type: "web_search" });
		expect(result.model).toBe("gpt-6.1-sol");
		expect(result.sources).toEqual([{ title: "Example Article", url: "https://example.com/article" }]);
	});

	it("falls back to the default model when PI_CODEX_WEB_SEARCH_MODEL is blank", async () => {
		process.env.PI_CODEX_WEB_SEARCH_MODEL = "   ";
		using _hook = mockCodexFetch("gpt-6.1-sol");

		const result = await searchCodex(makeSearchParams("blank codex model"));

		expect(capturedRequest).not.toBeNull();
		expect(capturedRequest?.body?.model).toBe("gpt-6.1-sol");
		expect(result.model).toBe("gpt-6.1-sol");
	});

	it.each([
		{ name: "Sol-only", ids: ["gpt-6.1-sol"], expected: "gpt-6.1-sol" },
		{ name: "Luna-only", ids: ["gpt-6-luna"], expected: "gpt-6-luna" },
		{ name: "reverse-order Luna/Sol", ids: ["gpt-6-luna", "gpt-6.1-sol"], expected: "gpt-6.1-sol" },
		{ name: "non-preferred plus Luna", ids: ["gpt-6-astra", "gpt-6-luna"], expected: "gpt-6-luna" },
	])("selects only advertised preferences from $name account discovery", async ({ ids, expected }) => {
		mockDiscovery(ids);
		using _hook = mockCodexFetch(expected);

		const result = await searchCodex(makeSearchParams("filtered account discovery"));

		expectAuthenticatedDiscovery();
		expect(capturedRequest?.body?.model).toBe(expected);
		expect(result.model).toBe(expected);
	});

	it.each([
		{ name: "unavailable", ids: null, message: "Codex model discovery unavailable" },
		{ name: "empty", ids: [], message: "No preferred Codex web-search models are advertised for this account" },
		{
			name: "non-preferred-only",
			ids: ["gpt-6-astra"],
			message: "No preferred Codex web-search models are advertised for this account",
		},
		{
			name: "retired-only",
			ids: ["gpt-5.5", "gpt-5.4", "gpt-5-codex-mini"],
			message: "No preferred Codex web-search models are advertised for this account",
		},
	])("fails closed before searching for $name account discovery", async ({ ids, message }) => {
		mockDiscovery(ids);
		using _hook = mockCodexFetch("gpt-6.1-sol");

		const result = searchCodex(makeSearchParams("no advertised preferred models"));
		await expect(result).rejects.toBeInstanceOf(SearchProviderError);
		await expect(result).rejects.toMatchObject({ provider: "codex", status: 503, message });
		expectAuthenticatedDiscovery();
		expect(capturedRequest).toBeNull();
	});

	it("preserves an already aborted caller reason without discovery or a search POST", async () => {
		const controller = new AbortController();
		const reason = new Error("caller cancelled before discovery");
		controller.abort(reason);
		using _hook = mockCodexFetch("gpt-6.1-sol");

		await expect(searchCodex({ ...makeSearchParams("already cancelled"), signal: controller.signal })).rejects.toBe(
			reason,
		);
		expect(codexDiscovery.fetchCodexModels).not.toHaveBeenCalled();
		expect(capturedRequest).toBeNull();
	});

	it("preserves caller cancellation during unavailable discovery without a search POST", async () => {
		const controller = new AbortController();
		const reason = new Error("caller cancelled during discovery");
		vi.spyOn(codexDiscovery, "fetchCodexModels").mockImplementation(async () => {
			controller.abort(reason);
			return null;
		});
		using _hook = mockCodexFetch("gpt-6.1-sol");

		await expect(searchCodex({ ...makeSearchParams("cancelled discovery"), signal: controller.signal })).rejects.toBe(
			reason,
		);
		expect(codexDiscovery.fetchCodexModels).toHaveBeenCalledTimes(1);
		expect(capturedRequest).toBeNull();
	});

	it("does not retry unadvertised Sol when the only advertised preference Luna is unsupported", async () => {
		mockDiscovery(["gpt-6-astra", "gpt-6-luna", "gpt-5.4"]);
		const models: string[] = [];
		using _hook = hookFetch((_url, init) => {
			models.push(JSON.parse(init?.body as string).model);
			return new Response("Model is not supported", { status: 400 });
		});

		await expect(searchCodex(makeSearchParams("unsupported advertised Luna"))).rejects.toMatchObject({
			provider: "codex",
			status: 400,
			message: expect.stringContaining("Model is not supported"),
		});
		expect(models).toEqual(["gpt-6-luna"]);
	});

	it.each([
		"Model is not supported",
		"The requested model is not supported",
		"'gpt-6.1-sol' is NOT SUPPORTED WHEN USING CODEX WITH A CHATGPT ACCOUNT.",
	])("retries Sol then Luna for unsupported-model 400: %s", async message => {
		mockDiscovery(["gpt-6-luna", "gpt-6.1-sol"]);
		const models: string[] = [];
		using _hook = hookFetch((_url, init) => {
			models.push(JSON.parse(init?.body as string).model);
			return models.length === 1
				? new Response(JSON.stringify({ detail: message }), { status: 400 })
				: new Response(makeSseResponse("gpt-6-luna"), {
						headers: { "Content-Type": "text/event-stream" },
					});
		});

		const result = await searchCodex(makeSearchParams("retry unsupported default"));

		expect(models).toEqual(["gpt-6.1-sol", "gpt-6-luna"]);
		expect(result.model).toBe("gpt-6-luna");
		expect(result.sources).toEqual([{ title: "Example Article", url: "https://example.com/article" }]);
	});

	it("exhausts only discovered Sol/Luna preferences and surfaces the last unsupported-model error", async () => {
		mockDiscovery(["gpt-5.5", "gpt-5-codex-mini", "gpt-5.4", "gpt-6-luna", "gpt-6.1-sol"]);
		const models: string[] = [];
		using _hook = hookFetch((_url, init) => {
			const model = JSON.parse(init?.body as string).model as string;
			models.push(model);
			return new Response(JSON.stringify({ detail: `${model}: model is not supported` }), { status: 400 });
		});

		await expect(searchCodex(makeSearchParams("exhaust defaults"))).rejects.toMatchObject({
			provider: "codex",
			status: 400,
			message: expect.stringContaining("gpt-6-luna: model is not supported"),
		});
		expect(models).toEqual(["gpt-6.1-sol", "gpt-6-luna"]);
	});

	it.each([
		"GJC_OPENAI_CODE_WEB_SEARCH_MODEL",
		"PI_CODEX_WEB_SEARCH_MODEL",
	])("does not retry an explicit %s override on unsupported-model 400", async name => {
		const discovery = mockDiscovery(null);
		process.env[name] = " custom-model ";
		const models: string[] = [];
		using _hook = hookFetch((_url, init) => {
			models.push(JSON.parse(init?.body as string).model);
			return new Response("Model is not supported", { status: 400 });
		});

		await expect(searchCodex(makeSearchParams("explicit unsupported model"))).rejects.toMatchObject({
			provider: "codex",
			status: 400,
		});
		expect(models).toEqual(["custom-model"]);
		expect(discovery).not.toHaveBeenCalled();
	});

	it.each([
		{ status: 400, message: "Unsupported tool: web_search" },
		...[401, 403, 404, 429, 500].map(status => ({ status, message: "Model is not supported" })),
	])("does not retry default HTTP $status: $message", async ({ status, message }) => {
		let calls = 0;
		using _hook = hookFetch(() => {
			calls += 1;
			return new Response(JSON.stringify({ detail: message }), { status });
		});

		await expect(searchCodex(makeSearchParams("nonretryable http error"))).rejects.toMatchObject({ status });
		expect(calls).toBe(1);
	});

	it("does not retry a network error even when its message matches unsupported-model errors", async () => {
		const error = new TypeError("Model is not supported");
		let calls = 0;
		using _hook = hookFetch(() => {
			calls += 1;
			throw error;
		});

		await expect(searchCodex(makeSearchParams("network failure"))).rejects.toBe(error);
		expect(calls).toBe(1);
	});

	it.each([
		{ type: "error", code: "unsupported_model", message: "Model is not supported" },
		{ type: "response.failed", response: { error: { message: "Model is not supported" } } },
	])("does not retry an SSE $type event", async event => {
		let calls = 0;
		using _hook = hookFetch(() => {
			calls += 1;
			return new Response(`data: ${JSON.stringify(event)}\n\n`, {
				headers: { "Content-Type": "text/event-stream" },
			});
		});

		await expect(searchCodex(makeSearchParams("stream failure"))).rejects.toMatchObject({
			provider: "codex",
			status: 500,
			message: expect.stringContaining("Model is not supported"),
		});
		expect(calls).toBe(1);
	});

	it("does not retry an unsupported-model SearchProviderError from another provider", async () => {
		const error = new SearchProviderError("brave", "Model is not supported", 400);
		let calls = 0;
		using _hook = hookFetch(() => {
			calls += 1;
			throw error;
		});

		await expect(searchCodex(makeSearchParams("other provider failure"))).rejects.toBe(error);
		expect(calls).toBe(1);
	});

	it("uses PI_CODEX_WEB_SEARCH_MODEL when provided", async () => {
		const discovery = mockDiscovery(null);
		process.env.PI_CODEX_WEB_SEARCH_MODEL = "  gpt-5.4-mini  ";
		using _hook = mockCodexFetch("gpt-5.4-mini");

		const result = await searchCodex(makeSearchParams("overridden codex model"));

		expect(capturedRequest).not.toBeNull();
		expect(capturedRequest?.body?.model).toBe("gpt-5.4-mini");
		expect(result.model).toBe("gpt-5.4-mini");
		expect(discovery).not.toHaveBeenCalled();
	});

	it("uses the documented GJC_OPENAI_CODE_WEB_SEARCH_MODEL when provided", async () => {
		const discovery = mockDiscovery(null);
		process.env.GJC_OPENAI_CODE_WEB_SEARCH_MODEL = "  gpt-5.4-mini  ";
		using _hook = mockCodexFetch("gpt-5.4-mini");

		const result = await searchCodex(makeSearchParams("documented codex model override"));

		expect(capturedRequest).not.toBeNull();
		expect(capturedRequest?.body?.model).toBe("gpt-5.4-mini");
		expect(result.model).toBe("gpt-5.4-mini");
		expect(discovery).not.toHaveBeenCalled();
	});

	it("resolves GJC-first: GJC_OPENAI_CODE_WEB_SEARCH_MODEL wins over legacy PI_CODEX_WEB_SEARCH_MODEL", async () => {
		const discovery = mockDiscovery(null);
		process.env.GJC_OPENAI_CODE_WEB_SEARCH_MODEL = "  gpt-5.4-mini  ";
		process.env.PI_CODEX_WEB_SEARCH_MODEL = "  gpt-5.4  ";
		using _hook = mockCodexFetch("gpt-5.4-mini");

		const result = await searchCodex(makeSearchParams("gjc-first codex model"));

		expect(capturedRequest?.body?.model).toBe("gpt-5.4-mini");
		expect(result.model).toBe("gpt-5.4-mini");
		expect(discovery).not.toHaveBeenCalled();
	});

	it("lets blank GJC shadow the legacy override and select the default", async () => {
		process.env.GJC_OPENAI_CODE_WEB_SEARCH_MODEL = "   ";
		process.env.PI_CODEX_WEB_SEARCH_MODEL = "gpt-5.4-mini";
		using _hook = mockCodexFetch("gpt-6.1-sol");

		const result = await searchCodex(makeSearchParams("blank documented override"));

		expectAuthenticatedDiscovery();
		expect(capturedRequest?.body?.model).toBe("gpt-6.1-sol");
		expect(result.model).toBe("gpt-6.1-sol");
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
