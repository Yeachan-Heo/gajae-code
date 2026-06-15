import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { hookFetch } from "@gajae-code/utils";
import type { AuthStorage } from "../../src/session/auth-storage";
import { runSearchQuery } from "../../src/web/search/index";
import { resolveProviderChain, setPreferredSearchProvider } from "../../src/web/search/provider";
import {
	DuckDuckGoProvider,
	decodeResultUrl,
	parseHtmlResults,
	parseLiteResults,
	searchDuckDuckGo,
} from "../../src/web/search/providers/duckduckgo";

const HTML_FIXTURE = `<html><body>
<div class="result results_links results_links_deep web-result">
  <h2 class="result__title">
    <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Falpha%3Fx%3D1&amp;rut=deadbeef">Alpha <b>Title</b></a>
  </h2>
  <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Falpha">Alpha <b>snippet</b> body.</a>
</div>
<div class="result result--ad">
  <a class="result__a" href="//duckduckgo.com/y.js?ad_provider=foo">Sponsored</a>
  <a class="result__snippet">Ad snippet</a>
</div>
<div class="result results_links">
  <h2 class="result__title">
    <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Fbeta">Beta Title</a>
  </h2>
  <a class="result__snippet">Beta snippet text.</a>
</div>
</body></html>`;

const LITE_FIXTURE = `<html><body><table>
<tr>
  <td><a class="result-link" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Flite.example.com%2Fgamma">Gamma Title</a></td>
</tr>
<tr><td class="result-snippet">Gamma snippet text.</td></tr>
<tr>
  <td><a class="result-link" href="https://direct.example.net/delta">Delta Title</a></td>
</tr>
<tr><td class="result-snippet">Delta snippet.</td></tr>
</table></body></html>`;

/** Minimal AuthStorage stub exposing only the credential probes providers consult. */
function fakeAuth(opts: { oauth?: string[]; auth?: string[] } = {}): AuthStorage {
	const oauth = new Set(opts.oauth ?? []);
	const auth = new Set([...(opts.auth ?? []), ...(opts.oauth ?? [])]);
	return {
		hasOAuth: (provider: string) => oauth.has(provider),
		hasAuth: (provider: string) => auth.has(provider),
		getApiKey: (provider: string) => (auth.has(provider) ? `${provider}-key` : undefined),
	} as unknown as AuthStorage;
}

async function chainIds(
	authStorage: AuthStorage,
	preferredProvider: any = "auto",
	activeModelProvider?: string,
): Promise<string[]> {
	const activeModelContext = activeModelProvider
		? {
				provider: activeModelProvider,
				modelId: "test",
				api:
					activeModelProvider.includes("google") || activeModelProvider === "gemini"
						? "google-generative-ai"
						: activeModelProvider === "anthropic"
							? "anthropic-messages"
							: activeModelProvider.includes("kimi")
								? "anthropic-messages"
								: "openai-responses",
				baseUrl: "https://api.example.com",
			}
		: undefined;
	const providers = await resolveProviderChain({ authStorage, preferredProvider, activeModelContext });
	return providers.map(p => p.id);
}

// Web-search availability is env-sensitive; isolate it so resolution is deterministic.
const SEARCH_ENV_KEYS = [
	"ANTHROPIC_SEARCH_API_KEY",
	"BRAVE_API_KEY",
	"EXA_API_KEY",
	"JINA_API_KEY",
	"MOONSHOT_SEARCH_API_KEY",
	"KIMI_SEARCH_API_KEY",
	"PERPLEXITY_COOKIES",
	"PERPLEXITY_API_KEY",
	"TAVILY_API_KEY",
	"KAGI_API_KEY",
	"PARALLEL_API_KEY",
	"SEARXNG_ENDPOINT",
	"ZAI_API_KEY",
	"SYNTHETIC_API_KEY",
];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
	for (const key of SEARCH_ENV_KEYS) {
		savedEnv[key] = process.env[key];
		delete process.env[key];
	}
});

afterEach(() => {
	vi.restoreAllMocks();
	for (const key of SEARCH_ENV_KEYS) {
		if (savedEnv[key] === undefined) delete process.env[key];
		else process.env[key] = savedEnv[key];
	}
});

describe("DuckDuckGo URL decoding", () => {
	it("decodes the uddg redirect to the real destination", () => {
		expect(decodeResultUrl("//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa%3Fx%3D1&rut=z")).toBe(
			"https://example.com/a?x=1",
		);
	});

	it("accepts direct external links", () => {
		expect(decodeResultUrl("https://direct.example.net/x")).toBe("https://direct.example.net/x");
	});

	it("drops internal/ad links and anchors", () => {
		expect(decodeResultUrl("//duckduckgo.com/y.js?ad_provider=foo")).toBeNull();
		expect(decodeResultUrl("#")).toBeNull();
		// uddg shell that points back at duckduckgo is an ad redirect.
		expect(decodeResultUrl("//duckduckgo.com/l/?uddg=https%3A%2F%2Fduckduckgo.com%2Fy.js")).toBeNull();
	});
});

describe("DuckDuckGo HTML parsing (fixture-pinned)", () => {
	it("parses the html endpoint markup, pairing snippets and skipping ads", () => {
		expect(parseHtmlResults(HTML_FIXTURE)).toEqual([
			{ title: "Alpha Title", url: "https://example.com/alpha?x=1", snippet: "Alpha snippet body." },
			{ title: "Beta Title", url: "https://example.org/beta", snippet: "Beta snippet text." },
		]);
	});

	it("parses the lite endpoint markup", () => {
		expect(parseLiteResults(LITE_FIXTURE)).toEqual([
			{ title: "Gamma Title", url: "https://lite.example.com/gamma", snippet: "Gamma snippet text." },
			{ title: "Delta Title", url: "https://direct.example.net/delta", snippet: "Delta snippet." },
		]);
	});
});

describe("DuckDuckGo provider search", () => {
	it("is always available (keyless)", () => {
		const provider = new DuckDuckGoProvider();
		expect(provider.id).toBe("duckduckgo");
		expect(provider.isAvailable({} as AuthStorage)).toBe(true);
	});

	it("returns sources parsed from the html endpoint", async () => {
		using _hook = hookFetch(input => {
			const url = input.toString();
			if (url.startsWith("https://html.duckduckgo.com")) return new Response(HTML_FIXTURE, { status: 200 });
			return new Response("", { status: 500 });
		});
		const response = await searchDuckDuckGo({ query: "alpha" });
		expect(response.provider).toBe("duckduckgo");
		expect(response.sources.map(s => s.url)).toEqual(["https://example.com/alpha?x=1", "https://example.org/beta"]);
	});

	it("falls back from html (202 block) to the lite endpoint", async () => {
		using _hook = hookFetch(input => {
			const url = input.toString();
			if (url.startsWith("https://html.duckduckgo.com")) return new Response("", { status: 202 });
			if (url.startsWith("https://lite.duckduckgo.com")) return new Response(LITE_FIXTURE, { status: 200 });
			return new Response("", { status: 500 });
		});
		const response = await searchDuckDuckGo({ query: "gamma" });
		expect(response.sources[0]?.url).toBe("https://lite.example.com/gamma");
	});

	it("rotates the user-agent across attempts and throws after all fail", async () => {
		const userAgents: string[] = [];
		using _hook = hookFetch((_input, init) => {
			userAgents.push(new Headers(init?.headers).get("user-agent") ?? "");
			return new Response("", { status: 202 });
		});
		await expect(searchDuckDuckGo({ query: "blocked" })).rejects.toThrow(/rate-limited|failed/i);
		expect(userAgents.length).toBe(3);
		expect(new Set(userAgents).size).toBeGreaterThan(1);
	});

	it("aborts immediately on an already-aborted signal without fetching", async () => {
		const controller = new AbortController();
		controller.abort();
		let fetched = false;
		using _hook = hookFetch(() => {
			fetched = true;
			return new Response(HTML_FIXTURE, { status: 200 });
		});
		await expect(searchDuckDuckGo({ query: "x", signal: controller.signal })).rejects.toThrow();
		expect(fetched).toBe(false);
	});
});

describe("resolveProviderChain — active-model-gated resolution", () => {
	it("uses an explicitly selected available provider, with DuckDuckGo appended", async () => {
		expect(await chainIds(fakeAuth({ auth: ["anthropic"] }), "anthropic")).toEqual(["anthropic", "duckduckgo"]);
	});

	it("dedupes when DuckDuckGo is explicitly selected", async () => {
		expect(await chainIds(fakeAuth(), "duckduckgo")).toEqual(["duckduckgo"]);
	});

	it("falls back to DuckDuckGo when the explicitly selected provider is unavailable", async () => {
		expect(await chainIds(fakeAuth(), "anthropic")).toEqual(["duckduckgo"]);
	});

	it("uses the active model's native search when its own creds exist", async () => {
		expect(await chainIds(fakeAuth({ auth: ["anthropic"] }), "auto", "anthropic")).toEqual([
			"anthropic",
			"duckduckgo",
		]);
	});

	it("falls back to DuckDuckGo when the active model's native search lacks creds", async () => {
		expect(await chainIds(fakeAuth(), "auto", "anthropic")).toEqual(["duckduckgo"]);
	});

	it("falls back to DuckDuckGo for custom/unknown model providers", async () => {
		expect(await chainIds(fakeAuth(), "auto", "my-custom-llm")).toEqual(["duckduckgo"]);
	});

	it("falls back to DuckDuckGo when no active model is known", async () => {
		expect(await chainIds(fakeAuth(), "auto")).toEqual(["duckduckgo"]);
	});

	it("maps real registry provider strings to their native search", async () => {
		expect(await chainIds(fakeAuth({ oauth: ["openai-codex"] }), "auto", "openai")).toEqual(["codex", "duckduckgo"]);
		expect(await chainIds(fakeAuth({ oauth: ["openai-codex"] }), "auto", "openai-codex")).toEqual([
			"codex",
			"openai-compatible",
			"duckduckgo",
		]);
		expect(await chainIds(fakeAuth({ oauth: ["google-gemini-cli"] }), "auto", "google-gemini-cli")).toEqual([
			"gemini",
			"duckduckgo",
		]);
		expect(await chainIds(fakeAuth({ oauth: ["google-antigravity"] }), "auto", "google-antigravity")).toEqual([
			"gemini",
			"duckduckgo",
		]);
		expect(await chainIds(fakeAuth({ auth: ["kimi-code"] }), "auto", "kimi-code")).toEqual(["kimi", "duckduckgo"]);
	});

	it("never auto-selects keyed standalone providers even when their key is present", async () => {
		process.env.BRAVE_API_KEY = "present";
		expect(await chainIds(fakeAuth(), "auto", "my-custom-llm")).toEqual(["duckduckgo"]);
	});

	it("REGRESSION: a stray openai-codex OAuth on a non-OpenAI model resolves to DuckDuckGo, not codex", async () => {
		// This is the reported bug: auto mode used to 401 on a custom model because a
		// stray OpenAI OAuth credential was selected. It must now resolve to DuckDuckGo.
		expect(await chainIds(fakeAuth({ oauth: ["openai-codex"] }), "auto", "my-custom-llm")).toEqual(["duckduckgo"]);
	});
});

describe("executeSearch fallback", () => {
	it("falls back to DuckDuckGo when an explicitly selected provider fails at runtime", async () => {
		process.env.BRAVE_API_KEY = "test-key";
		using _hook = hookFetch(input => {
			const url = input.toString();
			if (url.startsWith("https://api.search.brave.com")) return new Response("upstream error", { status: 500 });
			if (url.startsWith("https://html.duckduckgo.com")) return new Response(HTML_FIXTURE, { status: 200 });
			return new Response("", { status: 404 });
		});
		const result = await runSearchQuery({ query: "alpha", provider: "brave" }, { authStorage: fakeAuth() });
		expect(result.details.response.provider).toBe("duckduckgo");
		expect(result.content[0]?.text).toContain("example.com/alpha");
	});
});

describe("executeSearch honors the configured preferred provider", () => {
	afterEach(() => setPreferredSearchProvider("auto"));

	it("uses the settings-configured preferred provider when params.provider is omitted", async () => {
		// Regression: the model-facing schema has no `provider` field, so executeSearch must
		// NOT coalesce the omitted value to "auto" — that would bypass providers.webSearch.
		process.env.BRAVE_API_KEY = "test-key";
		setPreferredSearchProvider("brave");
		using _hook = hookFetch(input => {
			const url = input.toString();
			if (url.startsWith("https://api.search.brave.com")) {
				return new Response(
					JSON.stringify({
						web: { results: [{ title: "Brave", url: "https://brave.example/x", description: "d" }] },
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			if (url.startsWith("https://html.duckduckgo.com")) return new Response(HTML_FIXTURE, { status: 200 });
			return new Response("", { status: 500 });
		});

		const result = await runSearchQuery({ query: "preference wins" }, { authStorage: fakeAuth() });
		expect(result.details.response.provider).toBe("brave");
	});
});

const RUN_LIVE_DDG_E2E = process.env.GJC_LIVE_DUCKDUCKGO_E2E === "1";

describe.skipIf(!RUN_LIVE_DDG_E2E)("DuckDuckGo live e2e", () => {
	it("returns real web results without credentials", async () => {
		const response = await searchDuckDuckGo({ query: "anthropic claude", num_results: 5 });
		expect(response.provider).toBe("duckduckgo");
		expect(response.sources.length).toBeGreaterThan(0);
		expect(response.sources[0]?.title.length).toBeGreaterThan(0);
		expect(response.sources[0]?.url).toMatch(/^https?:\/\//);
	});
});
