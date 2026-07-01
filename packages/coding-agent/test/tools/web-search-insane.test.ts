import { afterEach, describe, expect, it } from "bun:test";
import { hookFetch } from "@gajae-code/utils";
import type { AuthStorage } from "../../src/session/auth-storage";
import { runSearchQuery, setPreferredSearchProvider } from "../../src/web/search";
import { InsaneProvider, routeInsanePublicUrl, searchInsane } from "../../src/web/search/providers/insane";

const REDDIT_FEED = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">
<entry><title>Reddit Post</title><author><name>/u/alice</name></author><link href="https://www.reddit.com/r/test/comments/abc/post/"/><updated>2026-06-23T00:00:00Z</updated><content>Post body</content></entry>
</feed>`;

function fakeAuth(): AuthStorage {
	return { hasAuth: () => false, hasOAuth: () => false, getApiKey: () => undefined } as unknown as AuthStorage;
}

afterEach(() => {
	setPreferredSearchProvider("auto");
});

describe("Insane public-route provider", () => {
	it("is keyless and selectable", () => {
		const provider = new InsaneProvider();
		expect(provider.id).toBe("insane");
		expect(provider.isAvailable({} as AuthStorage)).toBe(true);
	});

	it("routes Reddit URLs through RSS instead of blocked JSON/browser bypasses", async () => {
		using _hook = hookFetch(input => {
			const url = input.toString();
			if (url === "https://www.reddit.com/r/test/.rss") return new Response(REDDIT_FEED, { status: 200 });
			return new Response("Access Denied", { status: 403 });
		});

		const result = await routeInsanePublicUrl("https://www.reddit.com/r/test");
		expect(result).toMatchObject({ platform: "reddit", route: "rss" });
		if (!result || !("sources" in result)) throw new Error("expected route success");
		expect(result.sources[0]).toMatchObject({ title: "Reddit Post", author: "/u/alice" });
		expect(result.attempts).toEqual([expect.objectContaining({ platform: "reddit", route: "rss", ok: true })]);
	});

	it("routes X status URLs through public tweet-result metadata", async () => {
		using _hook = hookFetch(input => {
			const url = input.toString();
			if (url.startsWith("https://cdn.syndication.twimg.com/tweet-result")) {
				return Response.json({
					text: "public tweet text",
					user: { screen_name: "alice" },
					created_at: "Tue Jun 23 00:00:00 +0000 2026",
				});
			}
			return new Response("", { status: 404 });
		});

		const response = await searchInsane({ query: "https://x.com/alice/status/1234567890" });
		expect(response.provider).toBe("insane");
		expect(response.sources[0]).toMatchObject({
			author: "@alice",
			snippet: expect.stringContaining("public tweet text"),
		});
		expect(response.searchQueries?.[0]).toContain("x/tweet-result:200");
	});

	it("discovers platform URLs with DuckDuckGo and enriches them through safe routes", async () => {
		using _hook = hookFetch(input => {
			const url = input.toString();
			if (url.startsWith("https://html.duckduckgo.com")) {
				return new Response(
					`<a class="result__a" href="//duckduckgo.com/l/?uddg=${encodeURIComponent("https://www.reddit.com/r/test")}">Result</a><a class="result__snippet">snippet</a>`,
					{ status: 200 },
				);
			}
			if (url === "https://www.reddit.com/r/test/.rss") return new Response(REDDIT_FEED, { status: 200 });
			return new Response("", { status: 404 });
		});

		const result = await runSearchQuery({ query: "reddit test", provider: "insane" }, { authStorage: fakeAuth() });
		expect(result.details.response.provider).toBe("insane");
		expect(result.content[0]?.text).toContain("Reddit Post");
	});

	it("emits a diagnostic when configured Insane falls back to DuckDuckGo", async () => {
		setPreferredSearchProvider("insane");
		using _hook = hookFetch(input => {
			const url = input.toString();
			if (url.startsWith("https://html.duckduckgo.com")) {
				return new Response(
					`<a class="result__a" href="//duckduckgo.com/l/?uddg=${encodeURIComponent("https://example.com/plain")}">Plain</a><a class="result__snippet">plain snippet</a>`,
					{ status: 200 },
				);
			}
			return new Response("", { status: 404 });
		});

		const result = await runSearchQuery({ query: "plain web" }, { authStorage: fakeAuth() });
		expect(result.details.response.provider).toBe("duckduckgo");
		expect(result.details.warning).toContain("insane");
		expect(result.details.warning).toContain("using DuckDuckGo");
		expect(result.content[0]?.text).toContain("Warning: Web search provider fallback");
	});

	it("fails closed when only block pages are available", async () => {
		using _hook = hookFetch(() => new Response("<html>captcha access denied</html>", { status: 403 }));

		await expect(searchInsane({ query: "https://www.reddit.com/r/test" })).rejects.toThrow(
			/public routes failed closed/,
		);
	});

	it("rejects unsupported URLs instead of unsafe generic browsing", async () => {
		using _hook = hookFetch(() => new Response("", { status: 500 }));

		await expect(searchInsane({ query: "https://example.com/private" })).rejects.toThrow(
			/unsafe upstream TLS\/browser\/auth bypasses/,
		);
	});
});
