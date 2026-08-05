/**
 * Synthetic Web Search Provider
 *
 * Uses Synthetic's zero-data-retention web search API for coding agents.
 * Endpoint: POST https://api.synthetic.new/v2/search
 */

import { type AuthStorage, getEnvApiKey } from "@gajae-code/ai/core";
import type { SearchResponse, SearchSource } from "../../../web/search/types";
import { SearchProviderError } from "../../../web/search/types";
import type { SearchParams } from "./base";
import { SearchProvider } from "./base";
import { classifyProviderHttpError, withHardTimeout } from "./utils";

const SYNTHETIC_SEARCH_URL = "https://api.synthetic.new/v2/search";

interface SyntheticSearchResult {
	url: string;
	title: string;
	text?: string;
	published?: string;
}

interface SyntheticSearchResponse {
	results: SyntheticSearchResult[];
}

/** Resolve Synthetic API key through the shared auth storage pipeline. */
export function findApiKey(
	authStorage: AuthStorage,
	sessionId?: string,
	signal?: AbortSignal,
): Promise<string | undefined> {
	return authStorage.getApiKey("synthetic", sessionId, { signal });
}

/** Call Synthetic search API. */
async function callSyntheticSearch(
	apiKey: string,
	query: string,
	signal?: AbortSignal,
): Promise<SyntheticSearchResponse> {
	const response = await fetch(SYNTHETIC_SEARCH_URL, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${apiKey}`,
		},
		body: JSON.stringify({ query }),
		signal: withHardTimeout(signal, "api"),
	});

	if (!response.ok) {
		const errorText = await response.text();
		const classified = classifyProviderHttpError("synthetic", response.status, errorText);
		if (classified) throw classified;
		throw new SearchProviderError(
			"synthetic",
			`Synthetic API error (${response.status}): ${errorText}`,
			response.status,
		);
	}

	return (await response.json()) as SyntheticSearchResponse;
}

/** Execute Synthetic web search. */
export async function searchSynthetic(params: SearchParams): Promise<SearchResponse> {
	const apiKey = await findApiKey(params.authStorage, params.sessionId, params.signal);
	if (!apiKey) {
		throw new Error("Synthetic credentials not found. Set SYNTHETIC_API_KEY or login with 'gjc /login synthetic'.");
	}

	const data = await callSyntheticSearch(apiKey, params.query, params.signal);
	const sources: SearchSource[] = [];

	for (const result of data.results ?? []) {
		if (!result.url) continue;
		sources.push({
			title: result.title ?? result.url,
			url: result.url,
			snippet: result.text ?? undefined,
			publishedDate: result.published ?? undefined,
		});
	}

	const numResults = params.numSearchResults ?? params.limit;
	const limitedSources = numResults ? sources.slice(0, numResults) : sources;

	return {
		provider: "synthetic",
		sources: limitedSources,
	};
}

/** Search provider for Synthetic. */
export class SyntheticProvider extends SearchProvider {
	readonly id = "synthetic";
	readonly label = "Synthetic";

	isAvailable(authStorage: AuthStorage): boolean {
		return authStorage.hasAuth("synthetic") || !!getEnvApiKey("synthetic");
	}

	search(params: SearchParams): Promise<SearchResponse> {
		return searchSynthetic(params);
	}
}
