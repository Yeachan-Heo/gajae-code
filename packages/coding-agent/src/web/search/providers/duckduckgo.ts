/**
 * DuckDuckGo Web Search Provider
 *
 * Keyless, permissionless web search. Scrapes DuckDuckGo's no-JavaScript HTML
 * endpoints and maps anchors/snippets into the unified SearchResponse shape
 * (sources only — DuckDuckGo does not synthesize an answer).
 *
 * This is the zero-config default/fallback backend: it requires no API key and
 * no OAuth, so `isAvailable()` is always true. Because DuckDuckGo applies
 * anti-bot rate limiting (HTTP 202 / 403 / empty responses) from datacenter and
 * VPN IPs, the provider is best-effort: it retries with backoff, rotates the
 * user-agent, and alternates between the `html` and `lite` endpoints. When every
 * attempt fails it throws a {@link SearchProviderError} rather than returning an
 * empty success — it never falls through to keyed providers.
 *
 * Endpoints:
 *   https://html.duckduckgo.com/html/  (primary)
 *   https://lite.duckduckgo.com/lite/  (fallback markup)
 *
 * The HTML markup is liable to drift; the parser is deliberately small and is
 * pinned by fixture-driven tests (see test/tools/web-search-duckduckgo.test.ts).
 */

import type { AuthStorage } from "@gajae-code/ai";

import type { SearchResponse, SearchSource } from "../../../web/search/types";
import { SearchProviderError } from "../../../web/search/types";
import { clampNumResults } from "../utils";
import type { SearchParams } from "./base";
import { SearchProvider } from "./base";
import { classifyProviderHttpError, withHardTimeout } from "./utils";

const HTML_ENDPOINT = "https://html.duckduckgo.com/html/";
const LITE_ENDPOINT = "https://lite.duckduckgo.com/lite/";

const DEFAULT_NUM_RESULTS = 10;
const MAX_NUM_RESULTS = 20;

/** Endpoint order across retry attempts; rotates markup and user-agent. */
const ATTEMPTS: Array<"html" | "lite"> = ["html", "lite", "html"];

/** Backoff (ms) applied between attempts. Index 0 is unused (first attempt). */
const BACKOFF_MS = [0, 400, 800];

/** Realistic desktop user-agents rotated per attempt to dodge naive blocks. */
const USER_AGENTS = [
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
	"Mozilla/5.0 (X11; Linux x86_64; rv:125.0) Gecko/20100101 Firefox/125.0",
];

/** Map our recency filter to DuckDuckGo's `df` time parameter. */
const RECENCY_MAP: Record<"day" | "week" | "month" | "year", string> = {
	day: "d",
	week: "w",
	month: "m",
	year: "y",
};

interface ParsedResult {
	title: string;
	url: string;
	snippet?: string;
}

/** Decode a small set of HTML entities without pulling in a DOM library. */
function decodeEntities(input: string): string {
	return input
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#0*39;|&#x0*27;|&apos;/gi, "'")
		.replace(/&#x0*2f;/gi, "/")
		.replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
		.replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
		.replace(/&nbsp;/g, " ");
}

/** Strip tags, decode entities, and collapse whitespace from an HTML fragment. */
function cleanText(fragment: string): string {
	return decodeEntities(fragment.replace(/<[^>]+>/g, ""))
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * Resolve a DuckDuckGo result href to the real destination URL. DuckDuckGo wraps
 * external links in a `/l/?uddg=<encoded>` redirect; `lite` sometimes links
 * directly. Returns null for unusable or internal links (so ads/redirect shells
 * are dropped).
 */
export function decodeResultUrl(href: string): string | null {
	let h = decodeEntities(href.trim());
	if (!h || h.startsWith("#")) return null;
	if (h.startsWith("//")) h = `https:${h}`;
	let parsed: URL;
	try {
		parsed = new URL(h, "https://duckduckgo.com");
	} catch {
		return null;
	}
	const uddg = parsed.searchParams.get("uddg");
	if (uddg) {
		try {
			const target = new URL(uddg);
			if (target.protocol !== "http:" && target.protocol !== "https:") return null;
			if (target.hostname.endsWith("duckduckgo.com")) return null;
			return target.toString();
		} catch {
			return null;
		}
	}
	// No redirect wrapper: accept only real external http(s) links.
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
	if (parsed.hostname.endsWith("duckduckgo.com")) return null;
	return parsed.toString();
}

/** Parse results from the `html.duckduckgo.com/html/` markup. */
export function parseHtmlResults(html: string): ParsedResult[] {
	const titleRe = /<a\b[^>]*class="[^"]*\bresult__a\b[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
	const snippetRe = /<a\b[^>]*class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
	const snippets: string[] = [];
	for (const m of html.matchAll(snippetRe)) snippets.push(cleanText(m[1]));

	const results: ParsedResult[] = [];
	let idx = 0;
	for (const m of html.matchAll(titleRe)) {
		const url = decodeResultUrl(m[1]);
		const title = cleanText(m[2]);
		const snippet = snippets[idx];
		idx++;
		if (!url || !title) continue;
		results.push({ title, url, snippet: snippet || undefined });
	}
	return results;
}

/** Parse results from the `lite.duckduckgo.com/lite/` markup. */
export function parseLiteResults(html: string): ParsedResult[] {
	const linkRe = /<a\b[^>]*class="[^"]*\bresult-link\b[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
	const snippetRe = /<td\b[^>]*class="[^"]*\bresult-snippet\b[^"]*"[^>]*>([\s\S]*?)<\/td>/gi;
	const snippets: string[] = [];
	for (const m of html.matchAll(snippetRe)) snippets.push(cleanText(m[1]));

	const results: ParsedResult[] = [];
	let idx = 0;
	for (const m of html.matchAll(linkRe)) {
		const url = decodeResultUrl(m[1]);
		const title = cleanText(m[2]);
		const snippet = snippets[idx];
		idx++;
		if (!url || !title) continue;
		results.push({ title, url, snippet: snippet || undefined });
	}
	return results;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new DOMException("Aborted", "AbortError"));
			return;
		}
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				reject(new DOMException("Aborted", "AbortError"));
			},
			{ once: true },
		);
	});
}

/** Fetch one endpoint and parse it. Throws on HTTP error, rate-limit, or empty parse. */
async function fetchAndParse(
	endpoint: "html" | "lite",
	query: string,
	df: string | undefined,
	userAgent: string,
	signal: AbortSignal | undefined,
): Promise<ParsedResult[]> {
	const url = endpoint === "html" ? HTML_ENDPOINT : LITE_ENDPOINT;
	const body = new URLSearchParams({ q: query });
	if (df) body.set("df", df);

	const response = await fetch(url, {
		method: "POST",
		headers: {
			"User-Agent": userAgent,
			Accept: "text/html,application/xhtml+xml",
			"Content-Type": "application/x-www-form-urlencoded",
			"Accept-Language": "en-US,en;q=0.9",
		},
		body,
		signal: withHardTimeout(signal),
	});

	// DuckDuckGo signals soft blocks with 202 (which is still response.ok).
	if (response.status === 202) {
		throw new SearchProviderError("duckduckgo", "duckduckgo: rate-limited (202)", 202);
	}
	if (!response.ok) {
		const errorText = await response.text();
		const classified = classifyProviderHttpError("duckduckgo", response.status, errorText);
		if (classified) throw classified;
		throw new SearchProviderError("duckduckgo", `DuckDuckGo error (${response.status})`, response.status);
	}

	const text = await response.text();
	const parsed = endpoint === "html" ? parseHtmlResults(text) : parseLiteResults(text);
	if (parsed.length === 0) {
		throw new SearchProviderError("duckduckgo", "duckduckgo: no parseable results (possible block)");
	}
	return parsed;
}

/** Execute a keyless DuckDuckGo web search with light resilience. */
export async function searchDuckDuckGo(params: {
	query: string;
	num_results?: number;
	recency?: "day" | "week" | "month" | "year";
	signal?: AbortSignal;
}): Promise<SearchResponse> {
	const numResults = clampNumResults(params.num_results, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS);
	const df = params.recency ? RECENCY_MAP[params.recency] : undefined;

	let lastError: unknown;
	for (let attempt = 0; attempt < ATTEMPTS.length; attempt++) {
		if (params.signal?.aborted) throw new DOMException("Aborted", "AbortError");
		if (BACKOFF_MS[attempt] > 0) await delay(BACKOFF_MS[attempt], params.signal);

		const endpoint = ATTEMPTS[attempt];
		const userAgent = USER_AGENTS[attempt % USER_AGENTS.length];
		try {
			const parsed = await fetchAndParse(endpoint, params.query, df, userAgent, params.signal);
			const sources: SearchSource[] = parsed.slice(0, numResults).map(result => ({
				title: result.title,
				url: result.url,
				snippet: result.snippet,
			}));
			return { provider: "duckduckgo", sources };
		} catch (error) {
			// A caller cancellation must abort immediately, never silently retry.
			if (params.signal?.aborted) throw error;
			lastError = error;
		}
	}

	if (lastError instanceof SearchProviderError) throw lastError;
	throw new SearchProviderError(
		"duckduckgo",
		`DuckDuckGo search failed after ${ATTEMPTS.length} attempts${
			lastError instanceof Error ? `: ${lastError.message}` : ""
		}`,
	);
}

/** Keyless, permissionless web search provider backed by DuckDuckGo. */
export class DuckDuckGoProvider extends SearchProvider {
	readonly id = "duckduckgo";
	readonly label = "DuckDuckGo";

	isAvailable(_authStorage: AuthStorage): boolean {
		return true;
	}

	search(params: SearchParams): Promise<SearchResponse> {
		return searchDuckDuckGo({
			query: params.query,
			num_results: params.numSearchResults ?? params.limit,
			recency: params.recency,
			signal: params.signal,
		});
	}
}
