/**
 * Keenable Web Search Provider
 *
 * Uses the Keenable search API. Works without an API key through the public
 * endpoint (rate-limited per IP); a KEENABLE_API_KEY or stored "keenable"
 * credential switches to the keyed endpoint for higher limits.
 */
import type { AuthStorage } from "@gajae-code/ai/core";
import type { SearchResponse, SearchSource } from "../../../web/search/types";
import { SearchProviderError } from "../../../web/search/types";
import { clampNumResults, dateToAgeSeconds } from "../utils";
import type { SearchParams } from "./base";
import { SearchProvider } from "./base";
import { classifyProviderHttpError, withHardTimeout } from "./utils";

const KEENABLE_SEARCH_URL = "https://api.keenable.ai/v1/search";
const KEENABLE_PUBLIC_SEARCH_URL = "https://api.keenable.ai/v1/search/public";
/** App identifier the public endpoint requires on keyless requests. */
const KEENABLE_APP_TITLE = "Gajae-Code";
const DEFAULT_NUM_RESULTS = 10;
const MAX_NUM_RESULTS = 50;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Cap on provider-supplied error text surfaced in fallback warnings and tool errors. */
const MAX_ERROR_MESSAGE_CHARS = 200;

/** Map our recency filter to a lookback window for Keenable's `published_after`. */
const RECENCY_DAYS: Record<"day" | "week" | "month" | "year", number> = {
	day: 1,
	week: 7,
	month: 30,
	year: 365,
};

export interface KeenableSearchParams {
	query: string;
	num_results?: number;
	recency?: "day" | "week" | "month" | "year";
	signal?: AbortSignal;
}

interface KeenableSearchResult {
	title?: string | null;
	url?: string | null;
	snippet?: string | null;
	/** ISO 8601 publication timestamp in UTC, when known. */
	published_at?: string | null;
}

interface KeenableSearchResponse {
	results?: KeenableSearchResult[] | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	if (typeof value !== "object" || value === null) return null;
	return value as Record<string, unknown>;
}

function getErrorMessage(value: unknown): string | null {
	if (typeof value === "string") {
		const trimmed = value.trim();
		return trimmed.length > 0 ? trimmed : null;
	}

	const record = asRecord(value);
	if (!record) return null;

	for (const key of ["message", "error", "detail"]) {
		const message = getErrorMessage(record[key]);
		if (message) return message;
	}

	return null;
}

/** Collapse whitespace and control characters in remote error text and cap its length. */
function boundErrorMessage(text: string): string {
	const collapsed = text.replace(/[\s\p{Cc}\p{Cf}]+/gu, " ").trim();
	if (collapsed.length <= MAX_ERROR_MESSAGE_CHARS) return collapsed;
	return `${collapsed.slice(0, MAX_ERROR_MESSAGE_CHARS - 1)}…`;
}

/** Find an optional Keenable API key through AuthStorage's unified refresh pipeline. */
export async function findApiKey(
	authStorage: AuthStorage,
	sessionId: string | undefined,
	signal: AbortSignal | undefined,
): Promise<string | null> {
	return (await authStorage.getApiKey("keenable", sessionId, { signal })) ?? null;
}

/** Exported for testing. Builds the Keenable request body from unified params. */
export function buildRequestBody(params: KeenableSearchParams, now: Date = new Date()): Record<string, unknown> {
	const body: Record<string, unknown> = {
		query: params.query,
		max_results: clampNumResults(params.num_results, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS),
	};
	if (params.recency) {
		// Send the full timestamp: a bare date resolves to midnight UTC on Keenable's
		// side and would widen the window by up to a day.
		const since = new Date(now.getTime() - RECENCY_DAYS[params.recency] * DAY_MS);
		body.published_after = since.toISOString();
	}
	return body;
}

async function callKeenableSearch(
	apiKey: string | null,
	params: KeenableSearchParams,
): Promise<KeenableSearchResponse> {
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		"X-Keenable-Title": KEENABLE_APP_TITLE,
	};
	if (apiKey) headers["X-API-Key"] = apiKey;

	const response = await fetch(apiKey ? KEENABLE_SEARCH_URL : KEENABLE_PUBLIC_SEARCH_URL, {
		method: "POST",
		headers,
		body: JSON.stringify(buildRequestBody(params)),
		signal: withHardTimeout(params.signal, "api"),
	});

	if (!response.ok) {
		const errorText = await response.text();
		const classified = classifyProviderHttpError("keenable", response.status, errorText);
		if (classified) throw classified;
		let message = errorText.trim();
		if (message.length === 0) {
			message = response.statusText;
		} else {
			try {
				message = getErrorMessage(JSON.parse(errorText)) ?? message;
			} catch {
				// Keep raw text fallback.
			}
		}
		throw new SearchProviderError(
			"keenable",
			`Keenable API error (${response.status}): ${boundErrorMessage(message)}`,
			response.status,
		);
	}

	return (await response.json()) as KeenableSearchResponse;
}

/** Execute Keenable web search. */
export async function searchKeenable(params: SearchParams): Promise<SearchResponse> {
	const keenableParams: KeenableSearchParams = {
		query: params.query,
		num_results: params.numSearchResults ?? params.limit,
		recency: params.recency,
		signal: params.signal,
	};
	const apiKey = await findApiKey(params.authStorage, params.sessionId, params.signal);
	const numResults = clampNumResults(keenableParams.num_results, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS);
	const response = await callKeenableSearch(apiKey, keenableParams);
	const sources: SearchSource[] = [];

	for (const result of response.results ?? []) {
		if (!result?.url) continue;
		const snippet = result.snippet?.replace(/\s+/g, " ").trim();
		const publishedDate = typeof result.published_at === "string" ? result.published_at : undefined;
		sources.push({
			title: result.title?.trim() || result.url,
			url: result.url,
			snippet: snippet || undefined,
			publishedDate,
			ageSeconds: dateToAgeSeconds(publishedDate),
		});
	}

	return {
		provider: "keenable",
		sources: sources.slice(0, numResults),
		authMode: apiKey ? "api_key" : undefined,
	};
}

/** Search provider for Keenable web search. Keyless, so always available once selected. */
export class KeenableProvider extends SearchProvider {
	readonly id = "keenable";
	readonly label = "Keenable";

	isAvailable(_authStorage: AuthStorage): boolean {
		return true;
	}

	search(params: SearchParams): Promise<SearchResponse> {
		return searchKeenable(params);
	}
}
