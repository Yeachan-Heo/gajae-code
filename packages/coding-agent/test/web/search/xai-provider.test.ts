import { afterEach, describe, expect, it, vi } from "bun:test";
import type { AuthStorage } from "@gajae-code/ai";
import { hookFetch } from "@gajae-code/utils";
import { buildXaiRequestBody, searchXai, XaiProvider } from "../../../src/web/search/providers/xai";

const originalPiModel = process.env.PI_XAI_WEB_SEARCH_MODEL;
const originalXaiModel = process.env.XAI_WEB_SEARCH_MODEL;
const originalBaseUrl = process.env.XAI_SEARCH_BASE_URL;

function restoreEnv() {
	if (originalPiModel === undefined) delete process.env.PI_XAI_WEB_SEARCH_MODEL;
	else process.env.PI_XAI_WEB_SEARCH_MODEL = originalPiModel;
	if (originalXaiModel === undefined) delete process.env.XAI_WEB_SEARCH_MODEL;
	else process.env.XAI_WEB_SEARCH_MODEL = originalXaiModel;
	if (originalBaseUrl === undefined) delete process.env.XAI_SEARCH_BASE_URL;
	else process.env.XAI_SEARCH_BASE_URL = originalBaseUrl;
}

function auth(options: { key?: string; oauth?: boolean } = {}): AuthStorage {
	return {
		hasAuth: (provider: string) => provider === "xai" && Boolean(options.key),
		hasOAuth: (provider: string) => provider === "xai" && Boolean(options.oauth),
		getApiKey: (provider: string) => (provider === "xai" ? options.key : undefined),
		getOAuthAccess: (provider: string) =>
			provider === "xai" && options.oauth && options.key ? { accessToken: options.key } : undefined,
	} as unknown as AuthStorage;
}

function urlOf(input: Parameters<typeof fetch>[0]): string {
	return typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
}

afterEach(() => {
	vi.restoreAllMocks();
	restoreEnv();
});

describe("xAI web search provider", () => {
	it("builds Responses API requests with the web_search tool", () => {
		const body = buildXaiRequestBody({
			query: "latest Bun release",
			systemPrompt: "search carefully",
			model: "grok-test",
			maxOutputTokens: 300,
			temperature: 0,
		});

		expect(body).toEqual({
			model: "grok-test",
			input: [
				{ role: "system", content: "search carefully" },
				{ role: "user", content: "latest Bun release" },
			],
			tools: [{ type: "web_search" }],
			temperature: 0,
			max_output_tokens: 300,
		});
	});

	it("sends OAuth bearer auth and parses top-level xAI citations", async () => {
		process.env.PI_XAI_WEB_SEARCH_MODEL = "grok-test";
		process.env.XAI_SEARCH_BASE_URL = "https://xai.example/v1/";

		let capturedUrl = "";
		let capturedHeaders: Record<string, string> = {};
		let capturedBody: any;
		let capturedSignal: AbortSignal | undefined | null;

		using _hook = hookFetch(async (input, init) => {
			capturedUrl = urlOf(input);
			capturedHeaders = init?.headers as Record<string, string>;
			capturedBody = JSON.parse(String(init?.body));
			capturedSignal = init?.signal;
			return Response.json({
				id: "resp-1",
				model: "grok-test",
				output_text: "xAI Web Search uses the Responses API.",
				citations: [{ title: "1", url: "https://docs.x.ai/developers/tools/web-search" }],
				usage: {
					input_tokens: 10,
					output_tokens: 20,
					total_tokens: 30,
					server_side_tool_usage_details: { web_search_calls: 2 },
				},
			});
		});

		const result = await searchXai({
			query: "xAI web search docs",
			system_prompt: "use web search",
			max_output_tokens: 300,
			temperature: 0,
			authStorage: auth({ key: "oauth-token", oauth: true }),
		});

		expect(capturedUrl).toBe("https://xai.example/v1/responses");
		expect(capturedHeaders.Authorization).toBe("Bearer oauth-token");
		expect(capturedBody.model).toBe("grok-test");
		expect(capturedBody.tools).toEqual([{ type: "web_search" }]);
		expect(capturedBody.input[1].content).toBe("xAI web search docs");
		expect(capturedSignal).toBeInstanceOf(AbortSignal);

		expect(result).toMatchObject({
			provider: "xai",
			answer: "xAI Web Search uses the Responses API.",
			model: "grok-test",
			requestId: "resp-1",
			authMode: "oauth",
			usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30, searchRequests: 2 },
		});
		expect(result.sources).toEqual([
			{
				title: "https://docs.x.ai/developers/tools/web-search",
				url: "https://docs.x.ai/developers/tools/web-search",
				snippet: undefined,
			},
		]);
	});

	it("parses url_citation annotations into sources", async () => {
		using _hook = hookFetch(async () =>
			Response.json({
				id: "resp-2",
				citations: [{ title: "1", url: "https://docs.x.ai/developers/tools/citations" }],
				output: [
					{
						content: [
							{
								type: "output_text",
								text: "Annotated answer",
								annotations: [
									{
										type: "url_citation",
										url: "https://docs.x.ai/developers/tools/citations",
										title: "Citations",
										text: "citation docs",
									},
								],
							},
						],
					},
				],
			}),
		);

		const result = await searchXai({ query: "citations", authStorage: auth({ key: "sk-xai" }) });
		expect(result.answer).toBe("Annotated answer");
		expect(result.authMode).toBe("api_key");
		expect(result.sources).toEqual([
			{
				title: "Citations",
				url: "https://docs.x.ai/developers/tools/citations",
				snippet: "citation docs",
			},
		]);
	});

	it("throws 424 when xAI returns no grounded citations", async () => {
		using _hook = hookFetch(async () => Response.json({ output_text: "plain answer" }));
		await expect(searchXai({ query: "plain", authStorage: auth({ key: "sk-xai" }) })).rejects.toMatchObject({
			provider: "xai",
			status: 424,
		});
	});

	it("does not fetch without xAI credentials", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		await expect(searchXai({ query: "missing", authStorage: auth() })).rejects.toMatchObject({
			provider: "xai",
			status: 401,
		});
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("reports availability from unified xAI auth storage", () => {
		expect(new XaiProvider().isAvailable(auth({ key: "sk-xai" }))).toBe(true);
		expect(new XaiProvider().isAvailable(auth())).toBe(false);
	});
});
