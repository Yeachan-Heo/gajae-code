import { afterEach, describe, expect, it } from "bun:test";
import { hookFetch } from "@gajae-code/utils";
import type { AuthStorage } from "../../src/session/auth-storage";
import { classifyInsaneFallback } from "../../src/tools/fetch";
import { runSearchQuery, setPreferredSearchProvider } from "../../src/web/search";
import { InsaneProvider, routeInsanePublicUrl, searchInsane } from "../../src/web/search/providers/insane";

const REDDIT_FEED = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">
<entry><title>Reddit Post</title><author><name>/u/alice</name></author><link href="https://www.reddit.com/r/test/comments/abc/post/"/><updated>2026-06-23T00:00:00Z</updated><content>Post body</content></entry>
</feed>`;

function fakeAuth(): AuthStorage {
	return { hasAuth: () => false, hasOAuth: () => false, getApiKey: () => undefined } as unknown as AuthStorage;
}

const testDependencies = {
	guardedFetch: async (url: string, init: BunFetchRequestInit) => {
		const logicalUrl = new URL(url);
		return { ok: true as const, response: await fetch(url, init), logicalUrl, wireUrl: logicalUrl };
	},
};

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

		const result = await routeInsanePublicUrl("https://www.reddit.com/r/test", undefined, testDependencies);
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

		const route = await routeInsanePublicUrl("https://x.com/alice/status/1234567890", undefined, testDependencies);
		if (!route || !("sources" in route)) throw new Error("expected route success");
		expect(route.sources[0]).toMatchObject({
			author: "@alice",
			snippet: expect.stringContaining("public tweet text"),
		});
		expect(route.attempts[0]).toMatchObject({ platform: "x", route: "tweet-result", status: 200 });
	});

	it("routes discovered public URLs for non-URL text queries", async () => {
		using _hook = hookFetch(input => {
			const url = input.toString();
			if (url.startsWith("https://html.duckduckgo.com")) {
				return new Response(
					`<a class="result__a" href="//duckduckgo.com/l/?uddg=${encodeURIComponent("https://www.reddit.com/r/test/comments/abc/post/")}">R</a><a class="result__snippet">reddit result</a>`,
					{ status: 200 },
				);
			}
			if (url.endsWith(".rss")) return new Response(REDDIT_FEED, { status: 200 });
			return new Response("", { status: 404 });
		});
		const result = await searchInsane({ query: "reddit test", dependencies: testDependencies });
		expect(result.provider).toBe("insane");
		expect(result.sources.length).toBeGreaterThan(0);
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
		const result = await routeInsanePublicUrl("https://www.reddit.com/r/test", undefined, testDependencies);
		expect(result).toMatchObject({ platform: "reddit", attempts: expect.any(Array) });
	});
	it("denies authentication, CAPTCHA, and paywall markers before transient 408, 429, and 5xx fallback", () => {
		for (const [status, content] of [
			[408, "login required"],
			[429, "captcha challenge"],
			[503, "paywall"],
			[425, "temporarily unavailable"],
		] as const) {
			expect(
				classifyInsaneFallback({
					url: "https://www.reddit.com/r/test",
					raw: false,
					enabled: true,
					outcome: { kind: "http-failure", status, content, usableContent: false },
				}),
			).toMatchObject({ allowed: false });
		}
	});
	it("fails closed on guarded private, DNS/rebind, proxy, and Unix redirect targets without a second dial", async () => {
		for (const reason of ["private_redirect", "dns_rebind", "proxy_or_unix"]) {
			const calls: string[] = [];
			const result = await routeInsanePublicUrl("https://www.reddit.com/r/test", undefined, {
				guardedFetch: async url => {
					calls.push(url);
					if (calls.length === 1)
						return {
							ok: true as const,
							response: new Response("", { status: 302, headers: { location: "http://127.0.0.1/private" } }),
							logicalUrl: new URL(url),
							wireUrl: new URL(url),
						};
					return { ok: false as const, reason, logicalUrl: url };
				},
			});
			expect(result).toMatchObject({ platform: "reddit", attempts: expect.any(Array) });
			expect(calls).toEqual([
				"https://www.reddit.com/r/test/.rss",
				"http://127.0.0.1/private",
				"https://www.reddit.com/r/test.rss",
			]);
		}
	});
	it("follows a public redirect only through the guarded route and rejects malformed or excessive locations", async () => {
		const redirectedCalls: string[] = [];
		const redirected = await routeInsanePublicUrl("https://www.reddit.com/r/test", undefined, {
			guardedFetch: async url => {
				redirectedCalls.push(url);
				if (redirectedCalls.length === 1)
					return {
						ok: true as const,
						response: new Response("", { status: 302, headers: { location: "https://public.example/feed" } }),
						logicalUrl: new URL(url),
						wireUrl: new URL(url),
					};
				return {
					ok: true as const,
					response: new Response(REDDIT_FEED, { status: 200 }),
					logicalUrl: new URL(url),
					wireUrl: new URL(url),
				};
			},
		});
		expect(redirected).toMatchObject({ platform: "reddit", route: "rss" });
		expect(redirectedCalls).toEqual(["https://www.reddit.com/r/test/.rss", "https://public.example/feed"]);

		for (const location of ["http://[", "https://public.example/loop"]) {
			const result = await routeInsanePublicUrl("https://www.reddit.com/r/test", undefined, {
				maxRedirects: location.includes("loop") ? 0 : 5,
				guardedFetch: async url => ({
					ok: true as const,
					response: new Response("", { status: 302, headers: { location } }),
					logicalUrl: new URL(url),
					wireUrl: new URL(url),
				}),
			});
			expect(result).toMatchObject({ platform: "reddit", attempts: expect.any(Array) });
		}
	});
	it("keeps direct-route failure degraded and does not fall back to an unguarded dial", async () => {
		const calls: string[] = [];
		const result = await routeInsanePublicUrl("https://www.reddit.com/r/test", undefined, {
			guardedFetch: async url => {
				calls.push(url);
				return { ok: false as const, reason: "guard_failed", logicalUrl: url };
			},
		});
		expect(result).toMatchObject({ platform: "reddit", attempts: expect.any(Array) });
		expect(calls).toEqual(["https://www.reddit.com/r/test/.rss", "https://www.reddit.com/r/test.rss"]);
	});

	it("rejects unsupported URLs instead of unsafe generic browsing", async () => {
		using _hook = hookFetch(() => new Response("", { status: 500 }));

		await expect(searchInsane({ query: "https://example.com/private" })).rejects.toThrow(
			/no supported public route found/,
		);
	});
});
