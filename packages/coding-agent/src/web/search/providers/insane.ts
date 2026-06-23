/**
 * Insane Search Provider
 *
 * Native TypeScript, fail-closed adaptation of the MIT-licensed upstream
 * fivetaku/insane-search public-route strategy. This ports only safe Phase 0
 * concepts: deterministic no-auth public endpoints plus route-attempt tracing.
 *
 * Deliberately excluded from upstream: TLS impersonation, browser/cookie warming,
 * CAPTCHA/paywall/login bypasses, credential storage, Playwright automation, and
 * auto dependency installation. Unsupported or terminal auth/paywall/block states
 * throw instead of pretending a shallow fetch succeeded.
 */

import type { AuthStorage } from "@gajae-code/ai";

import type { SearchResponse, SearchSource } from "../../../web/search/types";
import { SearchProviderError } from "../../../web/search/types";
import { clampNumResults } from "../utils";
import type { SearchParams } from "./base";
import { SearchProvider } from "./base";
import { searchDuckDuckGo } from "./duckduckgo";
import { withHardTimeout } from "./utils";

const DEFAULT_NUM_RESULTS = 10;
const MAX_NUM_RESULTS = 20;
const PUBLIC_ROUTE_TIMEOUT_MS = 15_000;
const DISCOVERY_LIMIT = 8;

const USER_AGENT = "Gajae-Code insane-search safe-public-routes/1.0 (+https://github.com/Yeachan-Heo/gajae-code)";

const BLOCK_MARKERS = [
	"access denied",
	"attention required! | cloudflare",
	"captcha",
	"cf-chl-bypass",
	"checking your browser",
	"datadome",
	"just a moment...",
	"login required",
	"paywall",
	"please enable js",
	"request unsuccessful. incapsula",
	"sec-if-cpt-container",
	"sign in to continue",
	"the requested url was rejected",
] as const;

const HTML_ENTITY_MAP: Record<string, string> = {
	amp: "&",
	apos: "'",
	gt: ">",
	lt: "<",
	nbsp: " ",
	quot: '"',
};

export interface InsaneRouteAttempt {
	platform: InsanePlatform;
	route: string;
	ok: boolean;
	status: number;
	bytes: number;
	note?: string;
}

type InsanePlatform = "reddit" | "x" | "youtube" | "hackernews";

interface RouteSuccess {
	platform: InsanePlatform;
	route: string;
	finalUrl: string;
	sources: SearchSource[];
	attempts: InsaneRouteAttempt[];
}

interface RouteFailure {
	platform: InsanePlatform;
	attempts: InsaneRouteAttempt[];
}

type RouteResult = RouteSuccess | RouteFailure | null;

function decodeEntities(input: string): string {
	return input
		.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
			if (entity.startsWith("#x")) return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
			if (entity.startsWith("#")) return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
			return HTML_ENTITY_MAP[entity.toLowerCase()] ?? match;
		})
		.replace(/\s+/g, " ")
		.trim();
}

function stripTags(input: string): string {
	return decodeEntities(
		input
			.replace(/<script\b[\s\S]*?<\/script>/gi, " ")
			.replace(/<style\b[\s\S]*?<\/style>/gi, " ")
			.replace(/<[^>]+>/g, " "),
	);
}

function hostnameWithoutWww(url: URL): string {
	const host = url.hostname.toLowerCase();
	return host.startsWith("www.") ? host.slice(4) : host;
}

function parseHttpUrl(raw: string): URL | null {
	try {
		const url = new URL(raw.trim());
		if (url.protocol !== "http:" && url.protocol !== "https:") return null;
		if (url.username || url.password) return null;
		return url;
	} catch {
		return null;
	}
}

function detectPlatform(url: URL): InsanePlatform | null {
	const host = hostnameWithoutWww(url);
	if (host === "redd.it" || host === "reddit.com" || host.endsWith(".reddit.com")) return "reddit";
	if (host === "x.com" || host.endsWith(".x.com") || host === "twitter.com" || host.endsWith(".twitter.com"))
		return "x";
	if (host === "youtu.be" || host === "youtube.com" || host.endsWith(".youtube.com")) return "youtube";
	if (host === "news.ycombinator.com" || host === "hn.algolia.com") return "hackernews";
	return null;
}

function isBlockedBody(text: string): boolean {
	const lower = text.toLowerCase();
	return BLOCK_MARKERS.some(marker => lower.includes(marker));
}

function isSuccess(result: RouteResult): result is RouteSuccess {
	return result !== null && "sources" in result;
}

function attempt(
	platform: InsanePlatform,
	route: string,
	ok: boolean,
	status: number,
	body: string,
	note?: string,
): InsaneRouteAttempt {
	return { platform, route, ok, status, bytes: new TextEncoder().encode(body).byteLength, note };
}

async function fetchText(
	url: string,
	signal?: AbortSignal,
): Promise<{ status: number; text: string; contentType: string }> {
	const response = await fetch(url, {
		headers: {
			Accept: "application/json, application/atom+xml, application/rss+xml, text/xml, text/html;q=0.8, */*;q=0.5",
			"User-Agent": USER_AGENT,
		},
		redirect: "follow",
		signal: withHardTimeout(signal, PUBLIC_ROUTE_TIMEOUT_MS),
	});
	const text = await response.text();
	return { status: response.status, text, contentType: response.headers.get("content-type") ?? "" };
}

function attr(input: string, name: string): string | undefined {
	const re = new RegExp(`${name}=["']([^"']+)["']`, "i");
	return input.match(re)?.[1];
}

function firstTag(input: string, tag: string): string | undefined {
	return input.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"))?.[1];
}

function tagText(input: string, tag: string): string | undefined {
	const raw = firstTag(input, tag);
	return raw === undefined ? undefined : stripTags(raw);
}

function parseFeedEntries(xml: string, fallbackUrl: string): SearchSource[] {
	const sources: SearchSource[] = [];
	for (const entry of xml.matchAll(/<entry\b[\s\S]*?<\/entry>/gi)) {
		const chunk = entry[0];
		const linkTag = chunk.match(/<link\b[^>]*>/i)?.[0] ?? "";
		const href = attr(linkTag, "href") ?? tagText(chunk, "link");
		const title = tagText(chunk, "title");
		if (!title || !href) continue;
		sources.push({
			title,
			url: href,
			snippet: tagText(chunk, "summary") ?? tagText(chunk, "content"),
			publishedDate: tagText(chunk, "updated") ?? tagText(chunk, "published"),
			author: tagText(chunk, "name"),
		});
	}
	for (const item of xml.matchAll(/<item\b[\s\S]*?<\/item>/gi)) {
		const chunk = item[0];
		const title = tagText(chunk, "title");
		const link = tagText(chunk, "link") ?? fallbackUrl;
		if (!title) continue;
		sources.push({
			title,
			url: link,
			snippet: tagText(chunk, "description"),
			publishedDate: tagText(chunk, "pubDate"),
		});
	}
	return sources;
}

function redditFeedUrls(url: URL): string[] {
	const base = `${url.origin}${url.pathname}`.replace(/\/+$/, "");
	if (/\/comments\//.test(url.pathname)) return [`${base}.rss`];
	return [`${base}/.rss`, `${base}.rss`];
}

async function routeReddit(url: URL, signal?: AbortSignal): Promise<RouteResult> {
	const attempts: InsaneRouteAttempt[] = [];
	for (const feedUrl of redditFeedUrls(url)) {
		try {
			const response = await fetchText(feedUrl, signal);
			const ok = response.status === 200 && /<(feed|rss)\b/i.test(response.text) && !isBlockedBody(response.text);
			attempts.push(attempt("reddit", "rss", ok, response.status, response.text, ok ? "feed" : "no-feed-markers"));
			if (ok)
				return {
					platform: "reddit",
					route: "rss",
					finalUrl: feedUrl,
					sources: parseFeedEntries(response.text, feedUrl),
					attempts,
				};
		} catch (error) {
			attempts.push(attempt("reddit", "rss", false, 0, "", error instanceof Error ? error.name : "fetch_error"));
		}
	}
	return { platform: "reddit", attempts };
}

function tweetId(url: URL): string | null {
	return url.pathname.match(/\/status(?:es)?\/(\d+)/)?.[1] ?? null;
}

function xHandle(url: URL): string | null {
	const handle = url.pathname.split("/").filter(Boolean)[0]?.replace(/^@/, "");
	if (!handle) return null;
	const reserved = new Set(["explore", "hashtag", "home", "i", "messages", "notifications", "search", "settings"]);
	return reserved.has(handle.toLowerCase()) ? null : handle;
}

function sourceFromTweetJson(raw: string, url: string): SearchSource | null {
	const data = JSON.parse(raw) as {
		text?: string;
		user?: { name?: string; screen_name?: string };
		created_at?: string;
	};
	if (!data.text) return null;
	const author = data.user?.screen_name ? `@${data.user.screen_name}` : data.user?.name;
	return {
		title: author ? `${author}: ${data.text.slice(0, 80)}` : data.text.slice(0, 80),
		url,
		snippet: data.text,
		publishedDate: data.created_at,
		author,
	};
}

function sourceFromOEmbed(raw: string, url: string): SearchSource | null {
	const data = JSON.parse(raw) as { title?: string; author_name?: string; html?: string; url?: string };
	const snippet = data.html ? stripTags(data.html) : undefined;
	const title = data.title ?? snippet?.slice(0, 100) ?? data.author_name;
	if (!title) return null;
	return { title, url: data.url ?? url, snippet, author: data.author_name };
}

async function routeX(url: URL, signal?: AbortSignal): Promise<RouteResult> {
	const attempts: InsaneRouteAttempt[] = [];
	const id = tweetId(url);
	if (id) {
		const tweetResultUrl = `https://cdn.syndication.twimg.com/tweet-result?id=${encodeURIComponent(id)}&token=a`;
		try {
			const response = await fetchText(tweetResultUrl, signal);
			const source =
				response.status === 200 && !isBlockedBody(response.text)
					? sourceFromTweetJson(response.text, url.toString())
					: null;
			attempts.push(
				attempt("x", "tweet-result", !!source, response.status, response.text, source ? "has-text" : "no-text"),
			);
			if (source)
				return { platform: "x", route: "tweet-result", finalUrl: tweetResultUrl, sources: [source], attempts };
		} catch (error) {
			attempts.push(attempt("x", "tweet-result", false, 0, "", error instanceof Error ? error.name : "fetch_error"));
		}
		const oembedUrl = `https://publish.twitter.com/oembed?url=${encodeURIComponent(`https://twitter.com/i/status/${id}`)}&omit_script=1`;
		try {
			const response = await fetchText(oembedUrl, signal);
			const source =
				response.status === 200 && !isBlockedBody(response.text)
					? sourceFromOEmbed(response.text, oembedUrl)
					: null;
			attempts.push(
				attempt("x", "oembed", !!source, response.status, response.text, source ? "has-html" : "no-html"),
			);
			if (source) return { platform: "x", route: "oembed", finalUrl: oembedUrl, sources: [source], attempts };
		} catch (error) {
			attempts.push(attempt("x", "oembed", false, 0, "", error instanceof Error ? error.name : "fetch_error"));
		}
	}
	const handle = xHandle(url);
	if (handle) {
		const timelineUrl = `https://syndication.twitter.com/srv/timeline-profile/screen-name/${encodeURIComponent(handle)}`;
		try {
			const response = await fetchText(timelineUrl, signal);
			const ok = response.status === 200 && response.text.includes("__NEXT_DATA__") && !isBlockedBody(response.text);
			attempts.push(
				attempt("x", "syndication-timeline", ok, response.status, response.text, ok ? "timeline" : "no-next-data"),
			);
			if (ok)
				return {
					platform: "x",
					route: "syndication-timeline",
					finalUrl: timelineUrl,
					sources: parseTimelineHtml(response.text, timelineUrl),
					attempts,
				};
		} catch (error) {
			attempts.push(
				attempt("x", "syndication-timeline", false, 0, "", error instanceof Error ? error.name : "fetch_error"),
			);
		}
	}
	return { platform: "x", attempts };
}

function parseTimelineHtml(html: string, url: string): SearchSource[] {
	const title = tagText(html, "title") ?? "X public timeline";
	const text = stripTags(html).slice(0, 500);
	return [{ title, url, snippet: text || undefined }];
}

function youtubeVideoId(url: URL): string | null {
	if (hostnameWithoutWww(url) === "youtu.be") return url.pathname.split("/").filter(Boolean)[0] ?? null;
	return url.searchParams.get("v") ?? url.pathname.match(/\/shorts\/([^/?#]+)/)?.[1] ?? null;
}

async function routeYouTube(url: URL, signal?: AbortSignal): Promise<RouteResult> {
	const attempts: InsaneRouteAttempt[] = [];
	const videoId = youtubeVideoId(url);
	if (videoId) {
		const watchUrl = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
		const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(watchUrl)}&format=json`;
		try {
			const response = await fetchText(oembedUrl, signal);
			const source =
				response.status === 200 && !isBlockedBody(response.text) ? sourceFromOEmbed(response.text, watchUrl) : null;
			attempts.push(
				attempt("youtube", "oembed", !!source, response.status, response.text, source ? "metadata" : "no-metadata"),
			);
			if (source) return { platform: "youtube", route: "oembed", finalUrl: oembedUrl, sources: [source], attempts };
		} catch (error) {
			attempts.push(attempt("youtube", "oembed", false, 0, "", error instanceof Error ? error.name : "fetch_error"));
		}
	}
	const channelId = url.pathname.match(/\/channel\/([^/?#]+)/)?.[1];
	if (channelId) {
		const feedUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`;
		try {
			const response = await fetchText(feedUrl, signal);
			const ok = response.status === 200 && /<feed\b/i.test(response.text) && !isBlockedBody(response.text);
			attempts.push(attempt("youtube", "feed", ok, response.status, response.text, ok ? "feed" : "no-feed"));
			if (ok)
				return {
					platform: "youtube",
					route: "feed",
					finalUrl: feedUrl,
					sources: parseFeedEntries(response.text, feedUrl),
					attempts,
				};
		} catch (error) {
			attempts.push(attempt("youtube", "feed", false, 0, "", error instanceof Error ? error.name : "fetch_error"));
		}
	}
	return { platform: "youtube", attempts };
}

function hnItemId(url: URL): string | null {
	return url.searchParams.get("id") ?? url.pathname.match(/item\?id=(\d+)/)?.[1] ?? null;
}

function hnSourceFromItem(raw: string): SearchSource | null {
	const data = JSON.parse(raw) as {
		by?: string;
		descendants?: number;
		id?: number;
		score?: number;
		text?: string;
		time?: number;
		title?: string;
		url?: string;
	};
	if (!data.title && !data.text) return null;
	const discussionUrl = data.id ? `https://news.ycombinator.com/item?id=${data.id}` : "https://news.ycombinator.com/";
	const parts = [
		data.score === undefined ? undefined : `${data.score} points`,
		data.descendants === undefined ? undefined : `${data.descendants} comments`,
	].filter(Boolean);
	return {
		title: data.title ?? stripTags(data.text ?? "").slice(0, 100),
		url: data.url ?? discussionUrl,
		snippet: [stripTags(data.text ?? ""), parts.join(" · ")].filter(Boolean).join(" — ") || undefined,
		publishedDate: data.time ? new Date(data.time * 1000).toISOString() : undefined,
		author: data.by,
	};
}

async function routeHackerNews(url: URL, signal?: AbortSignal): Promise<RouteResult> {
	const attempts: InsaneRouteAttempt[] = [];
	const id = hnItemId(url);
	if (!id) return { platform: "hackernews", attempts };
	const itemUrl = `https://hacker-news.firebaseio.com/v0/item/${encodeURIComponent(id)}.json`;
	try {
		const response = await fetchText(itemUrl, signal);
		const source = response.status === 200 && !isBlockedBody(response.text) ? hnSourceFromItem(response.text) : null;
		attempts.push(
			attempt("hackernews", "firebase-item", !!source, response.status, response.text, source ? "item" : "no-item"),
		);
		if (source)
			return { platform: "hackernews", route: "firebase-item", finalUrl: itemUrl, sources: [source], attempts };
	} catch (error) {
		attempts.push(
			attempt("hackernews", "firebase-item", false, 0, "", error instanceof Error ? error.name : "fetch_error"),
		);
	}
	return { platform: "hackernews", attempts };
}

export async function routeInsanePublicUrl(rawUrl: string, signal?: AbortSignal): Promise<RouteResult> {
	const url = parseHttpUrl(rawUrl);
	if (!url) return null;
	const platform = detectPlatform(url);
	if (platform === "reddit") return routeReddit(url, signal);
	if (platform === "x") return routeX(url, signal);
	if (platform === "youtube") return routeYouTube(url, signal);
	if (platform === "hackernews") return routeHackerNews(url, signal);
	return null;
}

function discoveryQuery(query: string): string {
	const lower = query.toLowerCase();
	if (/\breddit\b/.test(lower)) return `${query} site:reddit.com`;
	if (/\b(x|twitter)\b/.test(lower)) return `${query} site:x.com OR site:twitter.com`;
	if (/\byoutube\b/.test(lower)) return `${query} site:youtube.com OR site:youtu.be`;
	if (/\b(hacker news|hn)\b/.test(lower)) return `${query} site:news.ycombinator.com`;
	return query;
}

function routeSummary(attempts: InsaneRouteAttempt[]): string {
	const tried = attempts
		.map(item => `${item.platform}/${item.route}:${item.status || item.note || "error"}`)
		.join(", ");
	return tried ? `insane public-route attempts: ${tried}` : "insane public-route attempts: none";
}

function withRouteSnippet(source: SearchSource, route: RouteSuccess): SearchSource {
	const routeNote = `via ${route.platform}/${route.route}`;
	return {
		...source,
		snippet: source.snippet ? `${routeNote}: ${source.snippet}` : routeNote,
	};
}

/** Execute safe Insane Search public-route discovery. */
export async function searchInsane(params: {
	query: string;
	num_results?: number;
	recency?: "day" | "week" | "month" | "year";
	signal?: AbortSignal;
}): Promise<SearchResponse> {
	const numResults = clampNumResults(params.num_results, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS);
	const direct = await routeInsanePublicUrl(params.query, params.signal);
	if (isSuccess(direct) && direct.sources.length > 0) {
		return {
			provider: "insane",
			sources: direct.sources.slice(0, numResults).map(source => withRouteSnippet(source, direct)),
			searchQueries: [routeSummary(direct.attempts)],
		};
	}
	if (direct && "attempts" in direct) {
		throw new SearchProviderError("insane", `insane: public routes failed closed (${routeSummary(direct.attempts)})`);
	}
	if (parseHttpUrl(params.query)) {
		throw new SearchProviderError(
			"insane",
			"insane: no supported public route found; unsafe upstream TLS/browser/auth bypasses are intentionally disabled",
		);
	}

	const discovery = await searchDuckDuckGo({
		query: discoveryQuery(params.query),
		num_results: Math.min(DISCOVERY_LIMIT, Math.max(numResults, 3)),
		recency: params.recency,
		signal: params.signal,
	});

	const attempts: InsaneRouteAttempt[] = [];
	const routedSources: SearchSource[] = [];
	const seenUrls = new Set<string>();
	for (const candidate of discovery.sources) {
		if (routedSources.length >= numResults) break;
		const routed = await routeInsanePublicUrl(candidate.url, params.signal);
		if (routed && "attempts" in routed) attempts.push(...routed.attempts);
		if (!isSuccess(routed)) continue;
		for (const source of routed.sources) {
			if (routedSources.length >= numResults) break;
			if (seenUrls.has(source.url)) continue;
			seenUrls.add(source.url);
			routedSources.push(withRouteSnippet(source, routed));
		}
	}

	if (routedSources.length > 0) {
		return { provider: "insane", sources: routedSources, searchQueries: [routeSummary(attempts)] };
	}

	if (attempts.length > 0) {
		throw new SearchProviderError("insane", `insane: public routes failed closed (${routeSummary(attempts)})`);
	}

	throw new SearchProviderError(
		"insane",
		"insane: no supported public route found; unsafe upstream TLS/browser/auth bypasses are intentionally disabled",
	);
}

/** Keyless provider that ports safe upstream public-route fallbacks only. */
export class InsaneProvider extends SearchProvider {
	readonly id = "insane";
	readonly label = "Insane";

	isAvailable(_authStorage: AuthStorage): boolean {
		return true;
	}

	search(params: SearchParams): Promise<SearchResponse> {
		return searchInsane({
			query: params.query,
			num_results: params.numSearchResults ?? params.limit,
			recency: params.recency,
			signal: params.signal,
		});
	}
}
