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

function auth(options: { apiKey?: string; oauthToken?: string } = {}): AuthStorage {
	const credentialTypeBySession = new Map<string, "api_key" | "oauth">();
	return {
		hasAuth: (provider: string) => provider === "xai" && Boolean(options.apiKey ?? options.oauthToken),
		hasOAuth: (provider: string) => provider === "xai" && Boolean(options.oauthToken),
		getApiKey: (provider: string, sessionId?: string) => {
			if (provider !== "xai") return undefined;
			if (options.apiKey) {
				if (sessionId) credentialTypeBySession.set(sessionId, "api_key");
				return options.apiKey;
			}
			if (options.oauthToken) {
				if (sessionId) credentialTypeBySession.set(sessionId, "oauth");
				return options.oauthToken;
			}
			return undefined;
		},
		getOAuthAccess: vi.fn(() => {
			throw new Error("xAI search auth mode detection must not resolve OAuth twice");
		}),
		getSessionCredentialType: (provider: string, sessionId?: string) =>
			provider === "xai" && sessionId ? credentialTypeBySession.get(sessionId) : undefined,
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

	it("builds web_search filters, image options, and citation controls", () => {
		const body = buildXaiRequestBody({
			query: "xAI docs",
			systemPrompt: "search carefully",
			model: "grok-test",
			allowedDomains: ["https://docs.x.ai/developers/tools", "*.x.ai", "docs.x.ai"],
			enableImageUnderstanding: true,
			enableImageSearch: true,
			noInlineCitations: true,
		});

		expect(body.tools).toEqual([
			{
				type: "web_search",
				filters: { allowed_domains: ["docs.x.ai", "x.ai"] },
				enable_image_understanding: true,
				enable_image_search: true,
			},
		]);
		expect(body.include).toEqual(["no_inline_citations"]);
	});

	it("builds x_search with handles, date range, image understanding, and video understanding", () => {
		const body = buildXaiRequestBody({
			query: "xAI on X",
			systemPrompt: "search X",
			model: "grok-test",
			xaiSearchMode: "x",
			allowedXHandles: ["@xai", "elonmusk", "xai"],
			fromDate: "2025-10-01",
			toDate: "2025-10-10",
			enableImageUnderstanding: true,
			enableVideoUnderstanding: true,
		});

		expect(body.tools).toEqual([
			{
				type: "x_search",
				allowed_x_handles: ["xai", "elonmusk"],
				from_date: "2025-10-01",
				to_date: "2025-10-10",
				enable_image_understanding: true,
				enable_video_understanding: true,
			},
		]);
	});

	it("auto-selects web_and_x when web and X options are mixed", () => {
		const body = buildXaiRequestBody({
			query: "xAI docs and X",
			systemPrompt: "search both",
			model: "grok-test",
			allowedDomains: ["docs.x.ai"],
			allowedXHandles: ["@xai"],
		});

		expect(body.tools).toEqual([
			{
				type: "web_search",
				filters: { allowed_domains: ["docs.x.ai"] },
			},
			{
				type: "x_search",
				allowed_x_handles: ["xai"],
			},
		]);
	});

	it("rejects mode-incompatible xAI options and overlarge lists", () => {
		expect(() =>
			buildXaiRequestBody({
				query: "bad mode",
				systemPrompt: "search",
				model: "grok-test",
				xaiSearchMode: "x",
				allowedDomains: ["docs.x.ai"],
			}),
		).toThrow("Web Search options require xai_search_mode='web' or 'web_and_x'");

		expect(() =>
			buildXaiRequestBody({
				query: "too many handles",
				systemPrompt: "search",
				model: "grok-test",
				allowedXHandles: Array.from({ length: 21 }, (_, index) => `handle${index}`),
			}),
		).toThrow("allowed_x_handles supports at most 20 entries");
	});

	it("rejects mutually exclusive xAI filters before fetching", () => {
		expect(() =>
			buildXaiRequestBody({
				query: "conflict",
				systemPrompt: "search",
				model: "grok-test",
				allowedDomains: ["x.ai"],
				excludedDomains: ["example.com"],
			}),
		).toThrow("allowed_domains cannot be set together with excluded_domains");
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
			authStorage: auth({ oauthToken: "oauth-token" }),
			sessionId: "session-oauth",
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

	it("forwards xAI X Search options and parses xAI-specific usage", async () => {
		let capturedBody: any;
		using _hook = hookFetch(async (_input, init) => {
			capturedBody = JSON.parse(String(init?.body));
			return Response.json({
				output_text: "X answer",
				citations: ["https://x.com/xai/status/123"],
				usage: {
					server_side_tool_usage_details: {
						x_search_calls: 3,
						view_image_calls: 2,
						image_search_calls: 1,
						SERVER_SIDE_TOOL_VIEW_X_VIDEO: 1,
					},
				},
			});
		});

		const result = await new XaiProvider().search({
			query: "xAI on X",
			systemPrompt: "search X",
			xaiSearchMode: "x",
			allowedXHandles: ["@xai"],
			fromDate: "2025-10-01",
			toDate: "2025-10-10",
			enableImageUnderstanding: true,
			enableVideoUnderstanding: true,
			noInlineCitations: true,
			authStorage: auth({ apiKey: "sk-xai" }),
		});

		expect(capturedBody.tools).toEqual([
			{
				type: "x_search",
				allowed_x_handles: ["xai"],
				from_date: "2025-10-01",
				to_date: "2025-10-10",
				enable_image_understanding: true,
				enable_video_understanding: true,
			},
		]);
		expect(capturedBody.include).toEqual(["no_inline_citations"]);
		expect(result.usage).toMatchObject({
			xSearchRequests: 3,
			imageUnderstandingRequests: 2,
			imageSearchRequests: 1,
			videoUnderstandingRequests: 1,
		});
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

		const result = await searchXai({ query: "citations", authStorage: auth({ apiKey: "sk-xai" }) });
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
		await expect(searchXai({ query: "plain", authStorage: auth({ apiKey: "sk-xai" }) })).rejects.toMatchObject({
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

	it("does not resolve OAuth again when an API key credential wins", async () => {
		let authorization = "";
		using _hook = hookFetch(async (_input, init) => {
			authorization = (init?.headers as Record<string, string>).Authorization;
			return Response.json({
				output_text: "answer",
				citations: ["https://docs.x.ai/developers/tools/web-search"],
			});
		});

		const result = await searchXai({
			query: "auth precedence",
			authStorage: auth({ apiKey: "sk-xai", oauthToken: "oauth-token" }),
			sessionId: "session-with-both",
		});

		expect(authorization).toBe("Bearer sk-xai");
		expect(result.authMode).toBe("api_key");
	});

	it("reports OAuth auth mode without a caller session id", async () => {
		let authorization = "";
		using _hook = hookFetch(async (_input, init) => {
			authorization = (init?.headers as Record<string, string>).Authorization;
			return Response.json({
				output_text: "answer",
				citations: ["https://docs.x.ai/developers/tools/web-search"],
			});
		});

		const result = await searchXai({
			query: "oauth mode",
			authStorage: auth({ oauthToken: "oauth-token" }),
		});

		expect(authorization).toBe("Bearer oauth-token");
		expect(result.authMode).toBe("oauth");
	});

	it("reports availability from unified xAI auth storage", () => {
		expect(new XaiProvider().isAvailable(auth({ apiKey: "sk-xai" }))).toBe(true);
		expect(new XaiProvider().isAvailable(auth())).toBe(false);
	});
});
