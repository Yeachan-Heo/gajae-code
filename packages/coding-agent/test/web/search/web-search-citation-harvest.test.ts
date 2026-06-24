import { describe, expect, it } from "bun:test";
import { hookFetch } from "@gajae-code/utils";
import type { AuthStorage } from "../../../src/session/auth-storage";
import { AnthropicProvider } from "../../../src/web/search/providers/anthropic";
import { OpenAICompatibleSearchProvider } from "../../../src/web/search/providers/openai-compatible";
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

async function ocSearch(json: unknown, api: "openai-responses" | "openai-completions" = "openai-responses") {
	using _hook = hookFetch(async () => Response.json(json));
	return await new OpenAICompatibleSearchProvider().search({
		query: "latest stable Bun version",
		systemPrompt: "Search the web and cite sources.",
		limit: 5,
		authStorage: keyAuth({ proxy: "sk-proxy" }),
		activeModelContext: openaiCtx(api),
	} as any);
}

describe("OpenAI-compatible inline citation harvest (responses)", () => {
	it("harvests inline sources when a web_search_call ran but annotations are absent", async () => {
		const r = await ocSearch({
			id: "resp_1",
			output: [
				{ type: "web_search_call", status: "completed", action: { type: "search", query: "bun" } },
				{
					type: "message",
					content: [
						{
							type: "output_text",
							text: "Latest stable Bun is v1.3.14. ([github.com](https://github.com/oven-sh/bun/releases))",
						},
					],
				},
			],
		});
		expect(r.provider).toBe("openai-compatible");
		expect(r.sources.map(s => s.url)).toEqual(["https://github.com/oven-sh/bun/releases"]);
	});

	it("treats tool_usage.web_search.num_requests as proof of search", async () => {
		const r = await ocSearch({
			id: "resp_2",
			tool_usage: { web_search: { num_requests: 2 } },
			output: [{ type: "message", content: [{ type: "output_text", text: "See https://bun.com/ for details." }] }],
		});
		expect(r.sources.map(s => s.url)).toEqual(["https://bun.com/"]);
	});

	it("returns the grounded answer with empty sources when a search ran but no URLs are present", async () => {
		const r = await ocSearch({
			id: "resp_3",
			output: [
				{ type: "web_search_call", status: "completed", action: { type: "search" } },
				{ type: "message", content: [{ type: "output_text", text: "Bun v1.3.14 is the latest stable release." }] },
			],
		});
		expect(r.sources).toEqual([]);
		expect(r.answer).toContain("1.3.14");
	});

	it("still fails closed (424) for a non-search answer that merely mentions a URL", async () => {
		await expect(
			ocSearch({ id: "resp_4", output_text: "I think it's around https://bun.com somewhere." }),
		).rejects.toMatchObject({ provider: "openai-compatible", status: 424 });
	});
});

describe("OpenAI-compatible inline citation harvest (chat completions)", () => {
	it("harvests inline sources from a chat-completions search answer without annotations", async () => {
		const r = await ocSearch(
			{
				id: "chat_1",
				choices: [
					{
						message: {
							content: "Latest stable Bun is v1.3.14. ([releases](https://github.com/oven-sh/bun/releases))",
						},
					},
				],
			},
			"openai-completions",
		);
		expect(r.sources.map(s => s.url)).toEqual(["https://github.com/oven-sh/bun/releases"]);
	});

	it("fails closed (424) for a chat-completions answer with no citations", async () => {
		await expect(
			ocSearch(
				{ id: "chat_2", choices: [{ message: { content: "Bun is a JavaScript runtime." } }] },
				"openai-completions",
			),
		).rejects.toMatchObject({ provider: "openai-compatible", status: 424 });
	});

	it("uses structured url_citation annotations when present", async () => {
		const r = await ocSearch(
			{
				id: "chat_3",
				choices: [
					{
						message: {
							content: "Bun v1.3.14.",
							annotations: [{ type: "url_citation", url_citation: { url: "https://bun.com/", title: "Bun" } }],
						},
					},
				],
			},
			"openai-completions",
		);
		expect(r.sources.map(s => s.url)).toEqual(["https://bun.com/"]);
	});
});

describe("Anthropic inline citation harvest + fail-closed", () => {
	const ctx: ActiveSearchModelContext = {
		provider: "proxy",
		modelId: "claude-sonnet-4",
		api: "anthropic-messages",
		baseUrl: "https://proxy.example",
	};
	const run = async (json: unknown) => {
		using _hook = hookFetch(async () => Response.json(json));
		return await new AnthropicProvider().search({
			query: "latest stable Bun version",
			systemPrompt: "Search the web and cite sources.",
			limit: 5,
			authStorage: keyAuth({ proxy: "sk-proxy" }),
			activeModelContext: ctx,
		} as any);
	};

	it("harvests inline sources when a search ran but only inline links were emitted", async () => {
		const r = await run({
			id: "msg_1",
			model: "claude-sonnet-4",
			usage: { input_tokens: 1, output_tokens: 1, server_tool_use: { web_search_requests: 1 } },
			content: [
				{ type: "server_tool_use", name: "web_search", input: { query: "bun" } },
				{
					type: "text",
					text: "Latest stable Bun is v1.3.14. See [releases](https://github.com/oven-sh/bun/releases).",
				},
			],
		});
		expect(r.provider).toBe("anthropic");
		expect(r.sources.map(s => s.url)).toEqual(["https://github.com/oven-sh/bun/releases"]);
	});

	it("keeps structured web_search_result sources when present", async () => {
		const r = await run({
			id: "msg_2",
			model: "claude-sonnet-4",
			usage: { input_tokens: 1, output_tokens: 1, server_tool_use: { web_search_requests: 1 } },
			content: [
				{
					type: "web_search_tool_result",
					content: [{ type: "web_search_result", title: "Bun", url: "https://bun.com/" }],
				},
				{ type: "text", text: "Bun v1.3.14." },
			],
		});
		expect(r.sources.map(s => s.url)).toEqual(["https://bun.com/"]);
	});

	it("fails closed (424) when Claude answered without running a web search", async () => {
		await expect(
			run({
				id: "msg_3",
				model: "claude-sonnet-4",
				usage: { input_tokens: 1, output_tokens: 1 },
				content: [{ type: "text", text: "Bun is a fast JavaScript runtime (mentions https://bun.com)." }],
			}),
		).rejects.toMatchObject({ provider: "anthropic", status: 424 });
	});
});
