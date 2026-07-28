/**
 * Kimi Web Search Provider
 *
 * Uses Moonshot Kimi Code search API to retrieve web results.
 * Endpoint: POST https://api.kimi.com/coding/v1/search
 */
import type { AuthStorage } from "@gajae-code/ai";
import { $credentialEnv } from "@gajae-code/utils";

import type { SearchResponse, SearchSource } from "../../../web/search/types";
import { SearchProviderError } from "../../../web/search/types";
import { clampNumResults, dateToAgeSeconds } from "../utils";
import type { SearchParams } from "./base";
import { SearchProvider } from "./base";
import { classifyProviderHttpError, withHardTimeout } from "./utils";

const KIMI_SEARCH_URL = "https://api.kimi.com/coding/v1/search";

const DEFAULT_NUM_RESULTS = 10;
const MAX_NUM_RESULTS = 20;
const DEFAULT_TIMEOUT_SECONDS = 30;
// Local hard ceiling aligned with the upstream `timeout_seconds` request budget
// (plus transport headroom) instead of the generic 15s "api" class: Kimi
// legitimately runs search + page crawling up to its advertised 30s window,
// and aborting earlier would discard valid in-budget responses.
const KIMI_HARD_TIMEOUT_MS = (DEFAULT_TIMEOUT_SECONDS + 5) * 1000;

export interface KimiSearchParams {
	query: string;
	num_results?: number;
	include_content?: boolean;
	signal?: AbortSignal;
	authStorage: AuthStorage;
	sessionId?: string;
}

interface KimiSearchResult {
	site_name?: string;
	title?: string;
	url?: string;
	snippet?: string;
	content?: string;
	date?: string;
	icon?: string;
	mime?: string;
}

interface KimiSearchResponse {
	search_results?: KimiSearchResult[];
}

function asTrimmed(value: string | undefined): string | undefined {
	if (!value) return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

/** Test seam: the Kimi search base URL as resolved from trusted env. */
export function resolveKimiSearchBaseUrlForTest(): string {
	return resolveBaseUrl();
}

function resolveBaseUrl(): string {
	return (
		asTrimmed($credentialEnv("MOONSHOT_SEARCH_BASE_URL")) ??
		asTrimmed($credentialEnv("KIMI_SEARCH_BASE_URL")) ??
		KIMI_SEARCH_URL
	);
}

/** Find Kimi search credentials from environment or AuthStorage. */
async function findApiKey(
	authStorage: AuthStorage,
	sessionId: string | undefined,
	signal: AbortSignal | undefined,
): Promise<string | null> {
	const envKey =
		asTrimmed($credentialEnv("MOONSHOT_SEARCH_API_KEY")) ?? asTrimmed($credentialEnv("KIMI_SEARCH_API_KEY"));
	if (envKey) return envKey;

	return (
		(await authStorage.getApiKey("moonshot", sessionId, { signal })) ??
		(await authStorage.getApiKey("kimi-code", sessionId, { signal })) ??
		null
	);
}

async function callKimiSearch(
	apiKey: string,
	params: { query: string; limit: number; includeContent: boolean; signal?: AbortSignal },
): Promise<{ response: KimiSearchResponse; requestId?: string }> {
	const response = await fetch(resolveBaseUrl(), {
		method: "POST",
		headers: {
			Accept: "application/json",
			"Content-Type": "application/json",
			Authorization: `Bearer ${apiKey}`,
		},
		body: JSON.stringify({
			text_query: params.query,
			limit: params.limit,
			enable_page_crawling: params.includeContent,
			timeout_seconds: DEFAULT_TIMEOUT_SECONDS,
		}),
		signal: withHardTimeout(params.signal, KIMI_HARD_TIMEOUT_MS),
	});

	if (!response.ok) {
		const errorText = await response.text();
		const classified = classifyProviderHttpError("kimi", response.status, errorText);
		if (classified) throw classified;
		throw new SearchProviderError(
			"kimi",
			`Kimi search API error (${response.status}): ${errorText}`,
			response.status,
		);
	}

	const data = (await response.json()) as KimiSearchResponse;
	const requestId = response.headers.get("x-request-id") ?? response.headers.get("x-msh-request-id") ?? undefined;
	return { response: data, requestId };
}

/** Execute Kimi web search. */
export async function searchKimi(params: KimiSearchParams): Promise<SearchResponse> {
	const apiKey = await findApiKey(params.authStorage, params.sessionId, params.signal);
	if (!apiKey) {
		throw new Error(
			"Kimi search credentials not found. Set MOONSHOT_SEARCH_API_KEY, KIMI_SEARCH_API_KEY, MOONSHOT_API_KEY, or login with 'gjc /login moonshot'.",
		);
	}

	const limit = clampNumResults(params.num_results, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS);
	const { response, requestId } = await callKimiSearch(apiKey, {
		query: params.query,
		limit,
		includeContent: params.include_content ?? false,
		signal: params.signal,
	});
	const sources: SearchSource[] = [];

	for (const result of response.search_results ?? []) {
		if (!result.url) continue;
		const publishedDate = asTrimmed(result.date);
		const snippet = asTrimmed(result.snippet) ?? asTrimmed(result.content);
		sources.push({
			title: asTrimmed(result.title) ?? result.url,
			url: result.url,
			snippet,
			publishedDate,
			ageSeconds: dateToAgeSeconds(publishedDate),
			author: asTrimmed(result.site_name),
		});
	}

	return {
		provider: "kimi",
		sources: sources.slice(0, limit),
		requestId,
	};
}

/** Search provider for Kimi web search. */
export class KimiProvider extends SearchProvider {
	readonly id = "kimi";
	readonly label = "Kimi";

	isAvailable(authStorage: AuthStorage): boolean {
		return (
			!!asTrimmed($credentialEnv("MOONSHOT_SEARCH_API_KEY")) ||
			!!asTrimmed($credentialEnv("KIMI_SEARCH_API_KEY")) ||
			authStorage.hasAuth("moonshot") ||
			authStorage.hasAuth("kimi-code")
		);
	}

	search(params: SearchParams): Promise<SearchResponse> {
		return searchKimi({
			query: params.query,
			num_results: params.numSearchResults ?? params.limit,
			signal: params.signal,
			authStorage: params.authStorage,
			sessionId: params.sessionId,
		});
	}
}
