import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as dns from "node:dns/promises";
import { hookFetch } from "@gajae-code/utils";
import type { AuthStorage } from "../../src/session/auth-storage";
import * as urlGuard from "../../src/web/insane/url-guard";
import { runSearchQuery, setPreferredSearchProvider } from "../../src/web/search";
import { InsaneProvider, routeInsanePublicUrl, searchInsane } from "../../src/web/search/providers/insane";

const REDDIT_FEED = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">
<entry><title>Reddit Post</title><author><name>/u/alice</name></author><link href="https://www.reddit.com/r/test/comments/abc/post/"/><updated>2026-06-23T00:00:00Z</updated><content>Post body</content></entry>
</feed>`;
const PUBLIC_ROUTE_RESPONSE_LIMIT = 1024 * 1024;

function redditFeedOfSize(totalBytes: number): string {
	const prefix =
		'<?xml version="1.0"?><feed><entry><title>Large Feed</title><link href="https://www.reddit.com/r/test/comments/large"/><content>';
	const suffix = "</content></entry></feed>";
	const fixedBytes = new TextEncoder().encode(prefix + suffix).byteLength;
	if (totalBytes < fixedBytes) throw new Error("fixture size is too small");
	return prefix + "x".repeat(totalBytes - fixedBytes) + suffix;
}

function chunkedResponse(chunks: string[], onCancel: () => void): Response {
	const encoder = new TextEncoder();
	let index = 0;
	return new Response(
		new ReadableStream<Uint8Array>({
			pull(controller) {
				const chunk = chunks[index++];
				if (chunk === undefined) {
					controller.close();
					return;
				}
				controller.enqueue(encoder.encode(chunk));
			},
			cancel() {
				onCancel();
			},
		}),
		{ status: 200 },
	);
}

function fakeAuth(): AuthStorage {
	return { hasAuth: () => false, hasOAuth: () => false, getApiKey: () => undefined } as unknown as AuthStorage;
}

function interceptedUrl(input: string | URL | Request, init?: RequestInit): string {
	const raw = input instanceof Request ? input.url : input.toString();
	try {
		const url = new URL(raw);
		const host = init?.headers ? new Headers(init.headers).get("host") : null;
		if (host) url.host = host;
		return url.toString();
	} catch {
		return raw;
	}
}

beforeEach(() => {
	vi.spyOn(dns, "lookup").mockImplementation((async () => [
		{ address: "93.184.216.34", family: 4 },
	]) as unknown as typeof dns.lookup);
});

afterEach(() => {
	vi.restoreAllMocks();
	setPreferredSearchProvider("auto");
});

describe("Insane public-route provider", () => {
	it("is keyless and selectable", () => {
		const provider = new InsaneProvider();
		expect(provider.id).toBe("insane");
		expect(provider.isAvailable({} as AuthStorage)).toBe(true);
	});

	it("routes Reddit URLs through RSS instead of blocked JSON/browser bypasses", async () => {
		using _hook = hookFetch((input, init) => {
			const url = interceptedUrl(input, init);
			if (url === "https://www.reddit.com/r/test/.rss") return new Response(REDDIT_FEED, { status: 200 });
			return new Response("Access Denied", { status: 403 });
		});

		const result = await routeInsanePublicUrl("https://www.reddit.com/r/test");
		expect(result).toMatchObject({ platform: "reddit", route: "rss" });
		if (!result || !("sources" in result)) throw new Error("expected route success");
		expect(result.sources[0]).toMatchObject({ title: "Reddit Post", author: "/u/alice" });
		expect(result.attempts).toEqual([expect.objectContaining({ platform: "reddit", route: "rss", ok: true })]);
	});

	it("accepts a public-route response exactly at the 1 MiB limit", async () => {
		const feed = redditFeedOfSize(PUBLIC_ROUTE_RESPONSE_LIMIT);
		using _hook = hookFetch(() => new Response(feed, { status: 200 }));

		const result = await routeInsanePublicUrl("https://www.reddit.com/r/test");
		if (!result || !("sources" in result)) throw new Error("expected route success");

		expect(result.attempts[0]?.bytes).toBe(PUBLIC_ROUTE_RESPONSE_LIMIT);
		expect(result.sources[0]?.title).toBe("Large Feed");
	});
	it("accepts a public-route response one byte under the 1 MiB limit", async () => {
		const feed = redditFeedOfSize(PUBLIC_ROUTE_RESPONSE_LIMIT - 1);
		using _hook = hookFetch(() => new Response(feed, { status: 200 }));

		const result = await routeInsanePublicUrl("https://www.reddit.com/r/test");
		if (!result || !("sources" in result)) throw new Error("expected route success");

		expect(result.attempts[0]?.bytes).toBe(PUBLIC_ROUTE_RESPONSE_LIMIT - 1);
		expect(result.sources[0]?.title).toBe("Large Feed");
	});

	it("rejects a streamed response exceeding the limit by exactly one byte", async () => {
		using _hook = hookFetch(() => chunkedResponse([redditFeedOfSize(PUBLIC_ROUTE_RESPONSE_LIMIT), "X"], () => {}));

		const result = await routeInsanePublicUrl("https://www.reddit.com/r/test");
		if (!result || !("attempts" in result) || "sources" in result) throw new Error("expected route failure");

		expect(result.attempts.every(item => item.note === "response_too_large")).toBe(true);
	});

	it("preserves UTF-8 multibyte boundaries when the limit splits a sequence", async () => {
		// é is U+00E9, 2 bytes in UTF-8 (0xC3 0xA9).
		// Build a feed whose total is exactly LIMIT, with the é split across
		// two chunks so the first byte is the last byte of chunk1 and the
		// second byte is the first byte of chunk2. The streaming TextDecoder
		// with { stream: true } must buffer the incomplete sequence and
		// correctly decode it once chunk2 arrives.
		const openTag =
			'<?xml version="1.0"?><feed><entry><title>T</title><link href="https://www.reddit.com/r/test/comments/abc"/><content>';
		const openBytes = new TextEncoder().encode(openTag);
		const charName = "é"; // 2 bytes
		const charBytes = new TextEncoder().encode(charName);
		const closeTag = "</content></entry></feed>";
		const closeBytes = new TextEncoder().encode(closeTag);

		const paddingLength =
			PUBLIC_ROUTE_RESPONSE_LIMIT - openBytes.byteLength - charBytes.byteLength - closeBytes.byteLength;
		if (paddingLength < 0) throw new Error("fixture too small for multibyte test");

		const padding = new Uint8Array(paddingLength).fill(0x78); // 'x'

		// chunk1 ends with the first byte of é; chunk2 starts with the second byte.
		const chunk1 = new Uint8Array(openBytes.byteLength + paddingLength + 1);
		chunk1.set(openBytes, 0);
		chunk1.set(padding, openBytes.byteLength);
		chunk1.set(Uint8Array.of(charBytes[0]), openBytes.byteLength + paddingLength);

		const chunk2 = new Uint8Array(1 + closeBytes.byteLength);
		chunk2.set(Uint8Array.of(charBytes[1]), 0);
		chunk2.set(closeBytes, 1);

		expect(chunk1.byteLength + chunk2.byteLength).toBe(PUBLIC_ROUTE_RESPONSE_LIMIT);

		using _hook = hookFetch(
			() =>
				new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(chunk1);
							controller.enqueue(chunk2);
							controller.close();
						},
					}),
					{ status: 200 },
				),
		);

		const result = await routeInsanePublicUrl("https://www.reddit.com/r/test");
		if (!result || !("sources" in result)) throw new Error("expected route success");
		// The content tag should end with é, proving the split multibyte
		// sequence was correctly reassembled rather than producing U+FFFD.
		expect(result.sources[0]?.snippet?.endsWith("é")).toBe(true);
		expect(result.sources[0]?.snippet?.includes("\uFFFD")).toBe(false);
		expect(result.attempts[0]?.bytes).toBe(PUBLIC_ROUTE_RESPONSE_LIMIT);
	});

	it("rejects a declared oversized response and cancels its body", async () => {
		let cancelCount = 0;
		using _hook = hookFetch(
			() =>
				new Response(
					new ReadableStream<Uint8Array>({
						pull() {},
						cancel() {
							cancelCount++;
						},
					}),
					{
						status: 200,
						headers: { "Content-Length": String(PUBLIC_ROUTE_RESPONSE_LIMIT + 1) },
					},
				),
		);

		const result = await routeInsanePublicUrl("https://www.reddit.com/r/test");
		if (!result || !("attempts" in result) || "sources" in result) throw new Error("expected route failure");

		expect(result.attempts).toHaveLength(2);
		expect(result.attempts.every(item => item.note === "response_too_large")).toBe(true);
		expect(cancelCount).toBe(2);
	});

	it("rejects an oversized chunked response without returning partial content", async () => {
		let cancelCount = 0;
		using _hook = hookFetch(() =>
			chunkedResponse(["x".repeat(700_000), "y".repeat(400_000), "unread"], () => {
				cancelCount++;
			}),
		);

		const result = await routeInsanePublicUrl("https://www.reddit.com/r/test");
		if (!result || !("attempts" in result) || "sources" in result) throw new Error("expected route failure");

		expect(result.attempts).toHaveLength(2);
		expect(result.attempts.every(item => item.note === "response_too_large")).toBe(true);
		expect(cancelCount).toBe(2);
	});

	it("continues discovery after an oversized candidate", async () => {
		using _hook = hookFetch((input, init) => {
			const url = interceptedUrl(input, init);
			if (url.startsWith("https://html.duckduckgo.com")) {
				return new Response(
					[
						`<a class="result__a" href="//duckduckgo.com/l/?uddg=${encodeURIComponent("https://www.reddit.com/r/oversized")}">Oversized</a>`,
						'<a class="result__snippet">too large</a>',
						`<a class="result__a" href="//duckduckgo.com/l/?uddg=${encodeURIComponent("https://www.reddit.com/r/good")}">Good</a>`,
						'<a class="result__snippet">good result</a>',
					].join(""),
					{ status: 200 },
				);
			}
			if (url.includes("/oversized")) {
				return chunkedResponse(["x".repeat(700_000), "y".repeat(400_000), "unread"], () => {});
			}
			if (url === "https://www.reddit.com/r/good/.rss") {
				return new Response(REDDIT_FEED, { status: 200 });
			}
			return new Response("", { status: 404 });
		});

		const result = await searchInsane({ query: "reddit bounded discovery" });

		expect(result.sources[0]?.title).toBe("Reddit Post");
		expect(result.sources.some(source => source.snippet?.includes("x".repeat(100)))).toBe(false);
	});

	it("routes X status URLs through public tweet-result metadata", async () => {
		using _hook = hookFetch((input, init) => {
			const url = interceptedUrl(input, init);
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
		using _hook = hookFetch((input, init) => {
			const url = interceptedUrl(input, init);
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
		using _hook = hookFetch((input, init) => {
			const url = interceptedUrl(input, init);
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

	it("does not return the body of a loopback feed", async () => {
		const sentinel = "INSANE_DIRECT_LOOPBACK_SENTINEL_215";
		let hits = 0;
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request) {
				hits++;
				if (new URL(request.url).pathname !== "/feed") return new Response("missing", { status: 404 });
				return new Response(
					`<?xml version="1.0"?><rss><channel><item><title>${sentinel}</title><link>http://127.0.0.1/feed</link><description>${sentinel}</description></item></channel></rss>`,
					{ status: 200, headers: { "content-type": "application/rss+xml" } },
				);
			},
		});
		const feedUrl = new URL("/feed", server.url).href;
		const validateSpy = vi.spyOn(urlGuard, "validatePublicHttpUrl");
		const dialSpy = vi.spyOn(urlGuard, "guardedPublicFetch");
		try {
			using _hook = hookFetch((input, init) => {
				const url = interceptedUrl(input, init);
				expect(init?.redirect).not.toBe("follow");
				if (url.startsWith("http://127.0.0.1")) {
					hits++;
					return new Response(sentinel, { status: 200 });
				}
				return new Response(null, {
					status: 302,
					headers: { location: feedUrl },
				});
			});

			const result = await routeInsanePublicUrl("https://www.reddit.com/r/test");
			expect(result).not.toBeNull();
			if (!result || !("attempts" in result) || "sources" in result) throw new Error("expected a refused route");
			expect(result.attempts.length).toBeGreaterThan(0);
			expect(result.attempts.every(item => item.note === "public_url_rejected")).toBe(true);
			expect(JSON.stringify(result)).not.toContain(sentinel);
			expect(validateSpy.mock.calls.some(call => call[0] === feedUrl)).toBe(true);
			expect(dialSpy.mock.calls.some(call => String(call[0]).includes("127.0.0.1"))).toBe(false);
			expect(hits).toBe(0);
		} finally {
			await server.stop(true);
		}
	});

	it("does not read a redirect to a second loopback address", async () => {
		const sentinel = "INSANE_REDIRECT_LOOPBACK_SENTINEL_215";
		let secretHits = 0;
		const secret = Bun.serve({
			hostname: "::1",
			port: 0,
			fetch() {
				secretHits++;
				return new Response(
					`<?xml version="1.0"?><feed><entry><title>${sentinel}</title><link href="http://[::1]/feed"/></entry></feed>`,
					{ status: 200, headers: { "content-type": "application/atom+xml" } },
				);
			},
		});
		let redirectHits = 0;
		const redirect = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request) {
				redirectHits++;
				expect(request.headers.get("authorization")).toBeNull();
				return new Response(null, { status: 302, headers: { Location: new URL("/feed", secret.url).href } });
			},
		});
		try {
			using _hook = hookFetch((input, init, next) => {
				const url = interceptedUrl(input, init);
				if (url.startsWith("https://www.reddit.com/")) {
					expect(init?.body).toBeUndefined();
					expect(init?.redirect).toBe("manual");
					const headers = new Headers(init?.headers);
					expect(headers.get("authorization")).toBeNull();
					return next(new URL("/feed", redirect.url).href, {
						method: "GET",
						headers,
						redirect: init?.redirect,
						signal: init?.signal ?? undefined,
					});
				}
				return next(input, init);
			});

			const result = await routeInsanePublicUrl("https://www.reddit.com/r/test");
			expect(redirectHits).toBeGreaterThan(0);
			expect(secretHits).toBe(0);
			expect(JSON.stringify(result)).not.toContain(sentinel);
		} finally {
			await redirect.stop(true);
			await secret.stop(true);
		}
	});

	it("follows a public redirect to the same feed result", async () => {
		using _hook = hookFetch((input, init) => {
			const url = interceptedUrl(input, init);
			if (url === "https://www.reddit.com/r/test/.rss") {
				return new Response(null, { status: 301, headers: { location: "/r/test.rss" } });
			}
			if (url === "https://www.reddit.com/r/test.rss") return new Response(REDDIT_FEED, { status: 200 });
			return new Response("", { status: 404 });
		});

		const result = await routeInsanePublicUrl("https://www.reddit.com/r/test");
		if (!result || !("sources" in result)) throw new Error("expected route success");
		expect(result.sources[0]?.title).toBe("Reddit Post");
	});

	it("rejects a public feed when a proxy environment variable is set", async () => {
		const previousProxy = process.env.HTTPS_PROXY;
		const previousNoProxy = process.env.NO_PROXY;
		process.env.HTTPS_PROXY = "http://127.0.0.1:9";
		process.env.NO_PROXY = "www.reddit.com";
		let fetches = 0;
		try {
			using _hook = hookFetch(() => {
				fetches++;
				return new Response(REDDIT_FEED, { status: 200 });
			});
			const result = await routeInsanePublicUrl("https://www.reddit.com/r/test");
			expect(fetches).toBe(0);
			if (!result || !("attempts" in result) || "sources" in result) throw new Error("expected a refused route");
			expect(result.attempts.every(item => item.note === "public_url_rejected")).toBe(true);
		} finally {
			if (previousProxy === undefined) delete process.env.HTTPS_PROXY;
			else process.env.HTTPS_PROXY = previousProxy;
			if (previousNoProxy === undefined) delete process.env.NO_PROXY;
			else process.env.NO_PROXY = previousNoProxy;
		}
	});

	it("follows a public redirect after validating the next hop", async () => {
		let fetches = 0;
		using _hook = hookFetch((input, init) => {
			const url = interceptedUrl(input, init);
			expect(init?.redirect).toBe("manual");
			fetches++;
			if (url === "https://www.reddit.com/r/test/.rss") {
				return new Response(null, { status: 301, headers: { location: "/r/test.rss" } });
			}
			if (url === "https://www.reddit.com/r/test.rss") return new Response(REDDIT_FEED, { status: 200 });
			return new Response("", { status: 404 });
		});

		const result = await routeInsanePublicUrl("https://www.reddit.com/r/test");
		if (!result || !("sources" in result)) throw new Error("expected route success");
		expect(result.sources[0]?.title).toBe("Reddit Post");
		expect(fetches).toBe(2);
	});

	it("refuses the sixth redirect hop", async () => {
		let fetches = 0;
		using _hook = hookFetch(() => {
			fetches++;
			return new Response(null, {
				status: 308,
				headers: { location: `https://www.reddit.com/r/test/.rss?hop=${fetches}` },
			});
		});

		const result = await routeInsanePublicUrl("https://www.reddit.com/r/test");
		if (!result || !("attempts" in result) || "sources" in result) throw new Error("expected a refused route");
		expect(result.attempts.every(item => item.note === "public_url_rejected")).toBe(true);
		expect(fetches).toBe(12);
		expect(JSON.stringify(result)).not.toContain("hop=");
	});
});
