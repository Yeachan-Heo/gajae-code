import { afterEach, describe, expect, it, vi } from "bun:test";
import { hookFetch } from "@gajae-code/utils";
import type { AuthStorage } from "../../../src/session/auth-storage";
import { ToolAbortError } from "../../../src/tools/tool-errors";
import { runSearchQuery } from "../../../src/web/search";
import * as provider from "../../../src/web/search/provider";
import type { SearchParams } from "../../../src/web/search/providers/base";
import { OpenAICompatibleSearchProvider } from "../../../src/web/search/providers/openai-compatible";
import { SearchProviderError, type SearchProviderId, type SearchResponse } from "../../../src/web/search/types";

function fakeProvider(
	id: SearchProviderId,
	search: (params: SearchParams) => Promise<SearchResponse>,
): provider.SearchProvider {
	return { id, label: id, isAvailable: () => true, search };
}

const authStorage = {} as AuthStorage;

afterEach(() => vi.restoreAllMocks());

describe("executeSearch fallback", () => {
	it("falls through after a no-citation generic failure and preserves ordering", async () => {
		const calls: string[] = [];
		vi.spyOn(provider, "resolveProviderChain").mockResolvedValue([
			fakeProvider("openai-compatible", async () => {
				calls.push("generic");
				throw new SearchProviderError("openai-compatible", "no citations", 424);
			}),
			fakeProvider("exa", async () => {
				calls.push("exa");
				return { provider: "exa", sources: [{ title: "Exa", url: "https://exa.example" }] };
			}),
		]);
		const result = await runSearchQuery({ query: "anything" }, { authStorage });
		expect(calls).toEqual(["generic", "exa"]);
		expect(result.content[0]?.text).toContain("https://exa.example");
	});

	it("falls through after a malformed OpenAI-compatible response without exposing its body", async () => {
		const secret = "malformed-response-secret";
		const calls: string[] = [];
		const urls: string[] = [];
		using _hook = hookFetch(async input => {
			calls.push("openai-compatible");
			urls.push(String(input));
			return new Response(secret);
		});
		vi.spyOn(provider, "resolveProviderChain").mockResolvedValue([
			new OpenAICompatibleSearchProvider(),
			fakeProvider("exa", async () => {
				calls.push("exa");
				return {
					provider: "exa",
					sources: [{ title: "Exa", url: "https://exa.example" }],
				};
			}),
		]);
		const result = await runSearchQuery(
			{ query: "anything" },
			{
				authStorage: { getApiKey: async () => "sk-custom" } as unknown as AuthStorage,
				activeModelContext: {
					provider: "custom",
					modelId: "gpt-5-mini",
					api: "openai-responses",
					baseUrl: "https://llm.example/v1",
				},
			},
		);
		expect(urls).toEqual(["https://llm.example/v1/responses"]);
		expect(calls).toEqual(["openai-compatible", "exa"]);
		expect(result.content[0]?.text).toContain("https://exa.example");
		expect(result.content[0]?.text).not.toContain(secret);
		expect(result.details.warning).not.toContain(secret);
	});

	it("rethrows caller abort instead of falling through", async () => {
		const second = vi.fn();
		vi.spyOn(provider, "resolveProviderChain").mockResolvedValue([
			fakeProvider("openai-compatible", async () => {
				throw new DOMException("aborted", "AbortError");
			}),
			fakeProvider("exa", second),
		]);
		const ac = new AbortController();
		ac.abort();
		await expect(runSearchQuery({ query: "anything" }, { authStorage, signal: ac.signal })).rejects.toBeInstanceOf(
			ToolAbortError,
		);
		expect(second).not.toHaveBeenCalled();
	});
});
