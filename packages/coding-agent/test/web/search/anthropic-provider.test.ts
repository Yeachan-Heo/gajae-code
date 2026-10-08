import { afterEach, describe, expect, it } from "bun:test";
import { hookFetch } from "@gajae-code/utils";
import { searchAnthropic } from "../../../src/web/search/providers/anthropic";

const originalApiKey = process.env.ANTHROPIC_SEARCH_API_KEY;
const originalModel = process.env.ANTHROPIC_SEARCH_MODEL;

function restoreEnv(): void {
	if (originalApiKey === undefined) delete process.env.ANTHROPIC_SEARCH_API_KEY;
	else process.env.ANTHROPIC_SEARCH_API_KEY = originalApiKey;
	if (originalModel === undefined) delete process.env.ANTHROPIC_SEARCH_MODEL;
	else process.env.ANTHROPIC_SEARCH_MODEL = originalModel;
}

function responseBody(): Record<string, unknown> {
	return {
		id: "msg-search-test",
		model: "claude-haiku-5-5",
		content: [
			{
				type: "web_search_tool_result",
				content: [{ type: "web_search_result", title: "Example", url: "https://example.com" }],
			},
			{ type: "text", text: "A grounded answer." },
		],
		usage: { input_tokens: 10, output_tokens: 5, server_tool_use: { web_search_requests: 1 } },
	};
}

afterEach(restoreEnv);

describe("Anthropic web search provider", () => {
	it("omits unsupported temperature for the Haiku 5.5 default", async () => {
		process.env.ANTHROPIC_SEARCH_API_KEY = "sk-ant-test";
		delete process.env.ANTHROPIC_SEARCH_MODEL;
		let requestBody: Record<string, unknown> | undefined;
		using _hook = hookFetch(async (_input, init) => {
			requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
			return Response.json(responseBody());
		});

		await searchAnthropic({ query: "latest release", temperature: 0 });

		expect(requestBody?.model).toBe("claude-haiku-5-5");
		expect(requestBody).not.toHaveProperty("temperature");
	});

	it("preserves temperature for an Anthropic model that accepts sampling parameters", async () => {
		process.env.ANTHROPIC_SEARCH_API_KEY = "sk-ant-test";
		process.env.ANTHROPIC_SEARCH_MODEL = "claude-sonnet-4-5";
		let requestBody: Record<string, unknown> | undefined;
		using _hook = hookFetch(async (_input, init) => {
			requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
			return Response.json(responseBody());
		});

		await searchAnthropic({ query: "latest release", temperature: 0.4 });

		expect(requestBody?.model).toBe("claude-sonnet-4-5");
		expect(requestBody?.temperature).toBe(0.4);
	});
});
