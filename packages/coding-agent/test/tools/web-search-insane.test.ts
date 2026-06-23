import { afterEach, describe, expect, it } from "bun:test";
import { hookFetch } from "@gajae-code/utils";
import type { AuthStorage } from "../../src/session/auth-storage";
import { runSearchQuery } from "../../src/web/search/index";
import { getSearchProvider, getSearchProviderLabel, SEARCH_PROVIDER_ORDER } from "../../src/web/search/provider";
import {
	enrichPublicUrl,
	InsaneProvider,
	isPrivateOrSpecialAddress,
	searchInsane,
	setInsaneHttpTransportForTest,
	validatePublicHttpUrl,
} from "../../src/web/search/providers/insane";
import {
	CONFIGURABLE_SEARCH_PROVIDER_IDS,
	isConfigurableSearchProviderId,
	isSearchProviderId,
	isSearchProviderPreference,
} from "../../src/web/search/types";

const HTML_FIXTURE = `<html><body>
<div class="result results_links">
  <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Falpha">Alpha Result</a>
  <a class="result__snippet">Alpha snippet body.</a>
</div>
<div class="result results_links">
  <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Fbeta">Beta Result</a>
  <a class="result__snippet">Beta snippet body.</a>
</div>
</body></html>`;

const PUBLIC_IP_URL = "http://93.184.216.34/article";

afterEach(() => {
	setInsaneHttpTransportForTest(undefined);
});

describe("Insane search provider registry", () => {
	it("registers insane as a configurable keyless provider", async () => {
		expect(isSearchProviderId("insane")).toBe(true);
		expect(isConfigurableSearchProviderId("insane")).toBe(true);
		expect(isSearchProviderPreference("insane")).toBe(true);
		expect(CONFIGURABLE_SEARCH_PROVIDER_IDS).toContain("insane");
		expect(SEARCH_PROVIDER_ORDER).toContain("insane");
		expect(SEARCH_PROVIDER_ORDER.indexOf("insane")).toBe(SEARCH_PROVIDER_ORDER.indexOf("duckduckgo") + 1);
		expect(getSearchProviderLabel("insane")).toBe("Insane Search");

		const provider = await getSearchProvider("insane");
		expect(provider.id).toBe("insane");
		expect(provider.label).toBe("Insane Search");
		expect(provider.isAvailable({} as AuthStorage)).toBe(true);
	});
});

describe("Insane query mapping", () => {
	it("maps a normal query through public keyless search sources", async () => {
		using _hook = hookFetch(input => {
			const url = input.toString();
			if (url.startsWith("https://html.duckduckgo.com")) return new Response(HTML_FIXTURE, { status: 200 });
			return new Response("", { status: 500 });
		});

		const response = await searchInsane({ query: "alpha beta", num_results: 1 });

		expect(response.provider).toBe("insane");
		expect(response.sources).toEqual([
			{ title: "Alpha Result", url: "https://example.com/alpha", snippet: "Alpha snippet body." },
		]);
	});

	it("preserves the web_search formatted output contract through runSearchQuery", async () => {
		using _hook = hookFetch(input => {
			const url = input.toString();
			if (url.startsWith("https://html.duckduckgo.com")) return new Response(HTML_FIXTURE, { status: 200 });
			return new Response("", { status: 500 });
		});

		const result = await runSearchQuery(
			{ query: "alpha beta", provider: "insane", num_search_results: 1 },
			{ authStorage: {} as AuthStorage },
		);

		expect(result.details.response.provider).toBe("insane");
		expect(result.content[0]?.text).toContain("[1] Alpha Result");
		expect(result.content[0]?.text).toContain("https://example.com/alpha");
	});
});

describe("Insane URL safety", () => {
	it("classifies private and special-purpose addresses as unsafe", () => {
		expect(isPrivateOrSpecialAddress("127.0.0.1")).toBe(true);
		expect(isPrivateOrSpecialAddress("10.0.0.2")).toBe(true);
		expect(isPrivateOrSpecialAddress("172.16.0.1")).toBe(true);
		expect(isPrivateOrSpecialAddress("192.168.1.1")).toBe(true);
		expect(isPrivateOrSpecialAddress("169.254.169.254")).toBe(true);
		expect(isPrivateOrSpecialAddress("::1")).toBe(true);
		expect(isPrivateOrSpecialAddress("fc00::1")).toBe(true);
		expect(isPrivateOrSpecialAddress("93.184.216.34")).toBe(false);
	});

	it("rejects non-http schemes, localhost, private IPs, and URL credentials", async () => {
		await expect(validatePublicHttpUrl("file:///etc/passwd")).rejects.toThrow(/http\/https/);
		await expect(validatePublicHttpUrl("http://localhost:8080/")).rejects.toThrow(/localhost|private/);
		await expect(validatePublicHttpUrl("http://169.254.169.254/latest/meta-data/")).rejects.toThrow(
			/private|special/,
		);
		await expect(validatePublicHttpUrl("https://user:pass@example.com/")).rejects.toThrow(/credentials/);
	});

	it("enriches a public URL without credentials or cookies", async () => {
		setInsaneHttpTransportForTest(async validated => {
			expect(validated.url.toString()).toBe(PUBLIC_IP_URL);
			expect(validated.addresses).toEqual(["93.184.216.34"]);
			return {
				status: 200,
				headers: { "content-type": "text/html; charset=utf-8" },
				body: `<html><head><title>Public Article</title><meta name="description" content="Public description."></head><body>Visible public text.</body></html>`,
			};
		});

		await expect(enrichPublicUrl(PUBLIC_IP_URL)).resolves.toEqual({
			title: "Public Article",
			url: PUBLIC_IP_URL,
			snippet: "Public description.",
		});
	});

	it("rejects redirects to private targets before following them", async () => {
		const seen: string[] = [];
		setInsaneHttpTransportForTest(async validated => {
			seen.push(validated.url.toString());
			return { status: 302, headers: { location: "http://127.0.0.1/admin" }, body: "" };
		});

		await expect(enrichPublicUrl(PUBLIC_IP_URL)).rejects.toThrow(/private|special|localhost/);
		expect(seen).toEqual([PUBLIC_IP_URL]);
	});

	it("fails closed on auth, paywall, CAPTCHA, or block pages", async () => {
		setInsaneHttpTransportForTest(async () => ({
			status: 200,
			headers: { "content-type": "text/html" },
			body: "<html><title>Paywall</title><body>Please log in to continue. CAPTCHA required.</body></html>",
		}));

		await expect(enrichPublicUrl(PUBLIC_IP_URL)).rejects.toThrow(/auth|paywall|CAPTCHA|block/);
	});

	it("routes URL-shaped queries through safe URL enrichment", async () => {
		setInsaneHttpTransportForTest(async () => ({
			status: 200,
			headers: { "content-type": "text/html" },
			body: "<html><head><title>URL Route</title></head><body>Route snippet body.</body></html>",
		}));

		const response = await new InsaneProvider().search({
			query: PUBLIC_IP_URL,
			systemPrompt: "",
			authStorage: {} as AuthStorage,
		});
		expect(response.provider).toBe("insane");
		expect(response.sources[0]?.title).toBe("URL Route");
	});
});
