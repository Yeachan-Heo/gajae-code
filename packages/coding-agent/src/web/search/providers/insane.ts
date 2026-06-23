/**
 * Insane Search provider
 *
 * Native TypeScript, keyless search provider inspired by fivetaku/insane-search's
 * public-route-first posture. This MVP deliberately avoids upstream Python,
 * browser, TLS impersonation, cookies, credentials, and paywall/auth bypasses.
 *
 * The provider returns normal SearchResponse sources only:
 *   1. public URL enrichment when the query is itself a URL,
 *   2. public DuckDuckGo html/lite search as the query-to-sources backend.
 *
 * URL enrichment is fail-closed: only public http/https URLs are fetched, every
 * redirect target is validated before following, localhost/private/link-local
 * hosts are rejected, and auth/paywall/CAPTCHA/block signals are treated as
 * provider errors rather than scraped around.
 */

import * as dns from "node:dns/promises";
import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import * as http from "node:http";
import * as https from "node:https";
import * as net from "node:net";
import type { AuthStorage } from "@gajae-code/ai";

import type { SearchResponse, SearchSource } from "../../../web/search/types";
import { SearchProviderError } from "../../../web/search/types";
import { clampNumResults } from "../utils";
import type { SearchParams } from "./base";
import { SearchProvider } from "./base";
import { searchDuckDuckGo } from "./duckduckgo";
import { classifyProviderHttpError } from "./utils";

const DEFAULT_NUM_RESULTS = 10;
const MAX_NUM_RESULTS = 20;
const URL_FETCH_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 5;
const MAX_HTML_BYTES = 512_000;

const USER_AGENT =
	"Gajae-Code/1.0 (+https://github.com/Yeachan-Heo/gajae-code; public web_search provider; no auth bypass)";

const BLOCKED_HOSTNAMES = new Set(["localhost", "localhost.localdomain", "0.0.0.0"]);

const BLOCK_SIGNAL_PATTERN =
	/\b(paywall|subscribe to continue|log in to continue|login to continue|sign in to continue|captcha|cf-challenge|cloudflare ray id|access denied|forbidden|unauthorized|blocked)\b/i;

export interface PublicUrlValidationResult {
	url: URL;
	addresses: string[];
}

function isBlockedHostname(hostname: string): boolean {
	const normalized = hostname.toLowerCase().replace(/\.$/, "");
	return (
		BLOCKED_HOSTNAMES.has(normalized) ||
		normalized.endsWith(".localhost") ||
		normalized.endsWith(".local") ||
		normalized.endsWith(".internal") ||
		normalized.endsWith(".home.arpa")
	);
}

function isPrivateIPv4(address: string): boolean {
	const parts = address.split(".").map(part => Number.parseInt(part, 10));
	if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return true;
	const [a, b] = parts;
	return (
		a === 0 ||
		a === 10 ||
		a === 127 ||
		(a === 100 && b >= 64 && b <= 127) ||
		(a === 169 && b === 254) ||
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && b === 0) ||
		(a === 192 && b === 168) ||
		(a === 198 && (b === 18 || b === 19)) ||
		a >= 224
	);
}

function normalizeIPv4MappedIPv6(address: string): string {
	return address.toLowerCase().startsWith("::ffff:") ? address.slice(7) : address;
}

function isPrivateIPv6(address: string): boolean {
	const normalized = address.toLowerCase();
	const mapped = normalizeIPv4MappedIPv6(normalized);
	if (mapped !== normalized) return isPrivateIPv4(mapped);
	return (
		normalized === "::" ||
		normalized === "::1" ||
		normalized.startsWith("fc") ||
		normalized.startsWith("fd") ||
		normalized.startsWith("fe8") ||
		normalized.startsWith("fe9") ||
		normalized.startsWith("fea") ||
		normalized.startsWith("feb") ||
		normalized.startsWith("ff")
	);
}

export function isPrivateOrSpecialAddress(address: string): boolean {
	const normalized = normalizeIPv4MappedIPv6(address);
	const family = net.isIP(normalized);
	if (family === 4) return isPrivateIPv4(normalized);
	if (family === 6) return isPrivateIPv6(normalized);
	return true;
}

export async function validatePublicHttpUrl(rawUrl: string): Promise<PublicUrlValidationResult> {
	let url: URL;
	try {
		url = new URL(rawUrl);
	} catch {
		throw new SearchProviderError("insane", "insane: invalid URL");
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new SearchProviderError("insane", "insane: URL enrichment only supports public http/https URLs");
	}
	if (url.username || url.password) {
		throw new SearchProviderError("insane", "insane: URL credentials are not allowed");
	}
	if (isBlockedHostname(url.hostname)) {
		throw new SearchProviderError("insane", "insane: refusing localhost or private host");
	}

	const literalFamily = net.isIP(url.hostname);
	if (literalFamily !== 0) {
		if (isPrivateOrSpecialAddress(url.hostname)) {
			throw new SearchProviderError("insane", "insane: refusing private, local, or special-purpose IP address");
		}
		return { url, addresses: [url.hostname] };
	}

	let records: Array<{ address: string }>;
	try {
		records = await dns.lookup(url.hostname, { all: true, verbatim: true });
	} catch {
		throw new SearchProviderError("insane", "insane: host could not be resolved for safe URL enrichment");
	}
	const addresses = records.map(record => record.address);
	if (addresses.length === 0 || addresses.some(isPrivateOrSpecialAddress)) {
		throw new SearchProviderError(
			"insane",
			"insane: refusing host that resolves to private or special-purpose addresses",
		);
	}
	return { url, addresses };
}

function firstUrlFromQuery(query: string): string | undefined {
	const trimmed = query.trim();
	if (!/^https?:\/\//i.test(trimmed)) return undefined;
	const [candidate] = trimmed.split(/\s+/, 1);
	return candidate;
}

function cleanText(input: string): string {
	return input
		.replace(/<script\b[\s\S]*?<\/script>/gi, " ")
		.replace(/<style\b[\s\S]*?<\/style>/gi, " ")
		.replace(/<[^>]+>/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#0*39;|&#x0*27;|&apos;/gi, "'")
		.replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
		.replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
		.replace(/\s+/g, " ")
		.trim();
}

function extractMetaContent(html: string, names: string[]): string | undefined {
	for (const name of names) {
		const pattern = new RegExp(
			`<meta\\b(?=[^>]*(?:name|property)=["']${name}["'])(?=[^>]*content=["']([^"']+)["'])[^>]*>`,
			"i",
		);
		const match = html.match(pattern);
		if (match?.[1]) return cleanText(match[1]);
	}
	return undefined;
}

function extractTitle(html: string, url: URL): string {
	const ogTitle = extractMetaContent(html, ["og:title", "twitter:title"]);
	if (ogTitle) return ogTitle;
	const titleMatch = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
	const title = titleMatch?.[1] ? cleanText(titleMatch[1]) : "";
	return title || url.hostname;
}

function extractSnippet(html: string): string | undefined {
	const description = extractMetaContent(html, ["description", "og:description", "twitter:description"]);
	if (description) return description.slice(0, 500);
	const text = cleanText(html);
	return text ? text.slice(0, 500) : undefined;
}

interface PinnedHttpResponse {
	status: number;
	headers: IncomingHttpHeaders;
	body: string;
}

function headerValue(headers: IncomingHttpHeaders, name: string): string | undefined {
	const value = headers[name.toLowerCase()];
	if (Array.isArray(value)) return value[0];
	return value;
}

function abortError(): DOMException {
	return new DOMException("Aborted", "AbortError");
}
interface PinnedRequestState {
	request?: http.ClientRequest;
	settled: boolean;
	byteLength: number;
}

async function requestPinnedPublicUrl(
	validated: PublicUrlValidationResult,
	signal: AbortSignal | undefined,
): Promise<PinnedHttpResponse> {
	const client = validated.url.protocol === "https:" ? https : http;
	const resolvers = Promise.withResolvers<PinnedHttpResponse>();
	const state: PinnedRequestState = { settled: false, byteLength: 0 };
	const finish = (error: unknown, response?: PinnedHttpResponse): void => {
		if (state.settled) return;
		state.settled = true;
		clearTimeout(timeout);
		signal?.removeEventListener("abort", onAbort);
		if (error) resolvers.reject(error);
		else resolvers.resolve(response as PinnedHttpResponse);
	};
	const onAbort = (): void => {
		state.request?.destroy(abortError());
		finish(abortError());
	};
	const timeout = setTimeout(() => {
		state.request?.destroy(new SearchProviderError("insane", "insane: URL enrichment timed out"));
	}, URL_FETCH_TIMEOUT_MS);

	if (signal?.aborted) {
		finish(abortError());
		return await resolvers.promise;
	}

	state.request = client.request(
		{
			protocol: validated.url.protocol,
			hostname: validated.addresses[0],
			port: validated.url.port || (validated.url.protocol === "https:" ? 443 : 80),
			path: `${validated.url.pathname}${validated.url.search}`,
			method: "GET",
			family: net.isIP(validated.addresses[0]) || undefined,
			servername: validated.url.protocol === "https:" ? validated.url.hostname : undefined,
			headers: {
				Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.5",
				Host: validated.url.host,
				"User-Agent": USER_AGENT,
			},
		},
		(response: IncomingMessage) => {
			const chunks: Buffer[] = [];
			response.on("data", (chunk: Buffer | string) => {
				const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
				state.byteLength += buffer.byteLength;
				if (state.byteLength > MAX_HTML_BYTES) {
					state.request?.destroy(
						new SearchProviderError("insane", "insane: URL enrichment response exceeded byte limit"),
					);
					return;
				}
				chunks.push(buffer);
			});
			response.on("end", () => {
				finish(undefined, {
					status: response.statusCode ?? 0,
					headers: response.headers,
					body: Buffer.concat(chunks).toString("utf8"),
				});
			});
		},
	);
	state.request.on("error", error => finish(error));
	signal?.addEventListener("abort", onAbort, { once: true });
	state.request.end();
	return await resolvers.promise;
}
let httpTransport = requestPinnedPublicUrl;

export function setInsaneHttpTransportForTest(
	transport:
		| ((validated: PublicUrlValidationResult, signal: AbortSignal | undefined) => Promise<PinnedHttpResponse>)
		| undefined,
): void {
	httpTransport = transport ?? requestPinnedPublicUrl;
}

async function fetchPublicHtml(rawUrl: string, signal: AbortSignal | undefined): Promise<{ url: URL; html: string }> {
	let validated = await validatePublicHttpUrl(rawUrl);
	for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect++) {
		const response = await httpTransport(validated, signal);
		if ([301, 302, 303, 307, 308].includes(response.status)) {
			const location = headerValue(response.headers, "location");
			if (!location)
				throw new SearchProviderError("insane", "insane: redirect without Location header", response.status);
			validated = await validatePublicHttpUrl(new URL(location, validated.url).toString());
			continue;
		}

		const contentType = headerValue(response.headers, "content-type") ?? "";
		const body = response.body;
		const classified = classifyProviderHttpError("insane", response.status, body);
		if (classified) throw classified;
		if (response.status < 200 || response.status >= 300)
			throw new SearchProviderError("insane", `insane: URL enrichment failed (${response.status})`, response.status);
		if (!/\b(?:text\/html|application\/xhtml\+xml|application\/xml|text\/plain)\b/i.test(contentType)) {
			throw new SearchProviderError("insane", "insane: URL enrichment only accepts public text/html content");
		}
		if (BLOCK_SIGNAL_PATTERN.test(body)) {
			throw new SearchProviderError("insane", "insane: refusing auth, paywall, CAPTCHA, or block page");
		}
		return { url: validated.url, html: body };
	}
	throw new SearchProviderError("insane", "insane: too many redirects during URL enrichment");
}

export async function enrichPublicUrl(rawUrl: string, signal?: AbortSignal): Promise<SearchSource> {
	const { url, html } = await fetchPublicHtml(rawUrl, signal);
	return {
		title: extractTitle(html, url),
		url: url.toString(),
		snippet: extractSnippet(html),
	};
}

/** Execute a safe keyless search. */
export async function searchInsane(params: {
	query: string;
	num_results?: number;
	recency?: "day" | "week" | "month" | "year";
	signal?: AbortSignal;
}): Promise<SearchResponse> {
	const numResults = clampNumResults(params.num_results, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS);
	const urlCandidate = firstUrlFromQuery(params.query);
	if (urlCandidate) {
		const source = await enrichPublicUrl(urlCandidate, params.signal);
		return { provider: "insane", sources: [source] };
	}

	const duck = await searchDuckDuckGo({
		query: params.query,
		num_results: numResults,
		recency: params.recency,
		signal: params.signal,
	});
	return {
		...duck,
		provider: "insane",
		sources: duck.sources.slice(0, numResults),
	};
}

/** Keyless public-route provider inspired by insane-search. */
export class InsaneProvider extends SearchProvider {
	readonly id = "insane";
	readonly label = "Insane Search";

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
