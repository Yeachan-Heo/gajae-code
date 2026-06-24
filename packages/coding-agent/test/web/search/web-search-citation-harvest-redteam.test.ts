import { describe, expect, it } from "bun:test";
import { hookFetch } from "@gajae-code/utils";
import type { AuthStorage } from "../../../src/session/auth-storage";
import { AnthropicProvider } from "../../../src/web/search/providers/anthropic";
import { OpenAICompatibleSearchProvider } from "../../../src/web/search/providers/openai-compatible";
import { extractTextSources } from "../../../src/web/search/providers/text-citations";
import type { ActiveSearchModelContext } from "../../../src/web/search/types";

function keyAuth(keys: Record<string, string> = {}): AuthStorage {
	return {
		hasAuth: (p: string) => Boolean(keys[p]),
		hasOAuth: () => false,
		getOAuthAccess: () => undefined,
		getApiKey: (p: string) => keys[p],
		getSessionCredentialType: () => "api-key",
	} as unknown as AuthStorage;
}

const openaiCtx = (api: "openai-responses" | "openai-completions"): ActiveSearchModelContext => ({
	provider: "proxy",
	modelId: "gpt-5.5",
	api,
	baseUrl: "https://proxy.example/v1",
});

async function openaiSearch(json: unknown, api: "openai-responses" | "openai-completions" = "openai-responses") {
	using _hook = hookFetch(async () => Response.json(json));
	return await new OpenAICompatibleSearchProvider().search({
		query: "latest stable Bun version",
		systemPrompt: "Search the web and cite sources.",
		limit: 5,
		authStorage: keyAuth({ proxy: "sk-proxy" }),
		activeModelContext: openaiCtx(api),
	} as any);
}

const anthropicCtx: ActiveSearchModelContext = {
	provider: "proxy",
	modelId: "claude-sonnet-4",
	api: "anthropic-messages",
	baseUrl: "https://proxy.example",
};

async function anthropicSearch(json: unknown) {
	using _hook = hookFetch(async () => Response.json(json));
	return await new AnthropicProvider().search({
		query: "latest stable Bun version",
		systemPrompt: "Search the web and cite sources.",
		limit: 5,
		authStorage: keyAuth({ proxy: "sk-proxy" }),
		activeModelContext: anthropicCtx,
	} as any);
}

describe("citation harvest red-team: OpenAI-compatible responses", () => {
	it("preserves fail-closed guard for a non-search response with a stray prose URL", async () => {
		await expect(
			openaiSearch({ id: "resp_stray", output_text: "I remember seeing this at https://bun.com/releases." }),
		).rejects.toMatchObject({ provider: "openai-compatible", status: 424 });
	});

	it("returns a searched response with empty sources when the answer has only non-http tokens", async () => {
		const result = await openaiSearch({
			id: "resp_non_http",
			output: [
				{ type: "web_search_call", status: "completed", action: { type: "search", query: "bun releases" } },
				{ type: "message", content: [{ type: "output_text", text: "Latest release is listed at bun:releases." }] },
			],
		});

		expect(result.answer).toContain("bun:releases");
		expect(result.sources).toEqual([]);
	});

	it("treats tool_usage.web_search.num_requests === 0 as not searched", async () => {
		await expect(
			openaiSearch({
				id: "resp_zero_requests",
				tool_usage: { web_search: { num_requests: 0 } },
				output: [
					{ type: "message", content: [{ type: "output_text", text: "See https://bun.com/ for details." }] },
				],
			}),
		).rejects.toMatchObject({ provider: "openai-compatible", status: 424 });
	});
});

describe("citation harvest red-team: OpenAI-compatible chat completions", () => {
	it("fails closed for a plain chat-completions answer with no links", async () => {
		await expect(
			openaiSearch(
				{ id: "chat_plain", choices: [{ message: { content: "Bun is a JavaScript runtime." } }] },
				"openai-completions",
			),
		).rejects.toMatchObject({ provider: "openai-compatible", status: 424 });
	});

	it("harvests a markdown link from a chat-completions answer", async () => {
		const result = await openaiSearch(
			{
				id: "chat_markdown",
				choices: [
					{
						message: { content: "Latest Bun releases are on [GitHub](https://github.com/oven-sh/bun/releases)." },
					},
				],
			},
			"openai-completions",
		);

		expect(result.sources.map(source => source.url)).toEqual(["https://github.com/oven-sh/bun/releases"]);
	});
});

describe("citation harvest red-team: Anthropic", () => {
	it("harvests a markdown link when server_tool_use web_search is present", async () => {
		const result = await anthropicSearch({
			id: "msg_markdown",
			model: "claude-sonnet-4",
			usage: { input_tokens: 1, output_tokens: 1 },
			content: [
				{ type: "server_tool_use", name: "web_search", input: { query: "bun releases" } },
				{ type: "text", text: "Latest Bun releases are on [GitHub](https://github.com/oven-sh/bun/releases)." },
			],
		});

		expect(result.sources.map(source => source.url)).toEqual(["https://github.com/oven-sh/bun/releases"]);
	});

	it("fails closed when no search signal exists even if prose contains a URL", async () => {
		await expect(
			anthropicSearch({
				id: "msg_no_search_url",
				model: "claude-sonnet-4",
				usage: { input_tokens: 1, output_tokens: 1 },
				content: [{ type: "text", text: "I remember the release notes are around https://bun.com/ somewhere." }],
			}),
		).rejects.toMatchObject({ provider: "anthropic", status: 424 });
	});

	it("fails closed for a web_search_tool_result_error block with no results or citations", async () => {
		await expect(
			anthropicSearch({
				id: "msg_search_error",
				model: "claude-sonnet-4",
				usage: { input_tokens: 1, output_tokens: 1 },
				content: [
					{
						type: "web_search_tool_result",
						content: { type: "web_search_tool_result_error", error_code: "max_uses_exceeded" },
					},
					{ type: "text", text: "I could not retrieve current release sources." },
				],
			}),
		).rejects.toMatchObject({ provider: "anthropic", status: 424 });
	});
});

describe("citation harvest red-team: text source extraction", () => {
	it("normalizes valid URLs and drops malformed or non-http URL-like garbage", () => {
		expect(
			extractTextSources(
				"Bad: [ftp](ftp://example.com), [broken](https://), https://exa mple.com, javascript:alert(1), http://[::1. Good: [release](https://bun.com/releases).",
			)
				.map(source => source.url)
				.sort(),
		).toEqual(["https://bun.com/releases", "https://exa/"]);
	});
});
