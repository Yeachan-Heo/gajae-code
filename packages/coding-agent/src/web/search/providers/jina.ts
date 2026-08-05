/**
 * Jina Reader Web Search Provider
 *
 * Uses the Jina Reader `s.jina.ai` endpoint to fetch search results with
 * cleaned content.
 */

import { type AuthStorage, getEnvApiKey } from "@gajae-code/ai/core";
import type { SearchResponse, SearchSource } from "../../../web/search/types";
import { SearchProviderError } from "../../../web/search/types";
import type { SearchParams } from "./base";
import { SearchProvider } from "./base";
import { classifyProviderHttpError, withHardTimeout } from "./utils";

const JINA_SEARCH_URL = "https://s.jina.ai";

export interface JinaSearchParams {
	query: string;
	num_results?: number;
	signal?: AbortSignal;
}

interface JinaSearchResult {
	title?: string | null;
	url?: string | null;
	content?: string | null;
}

type JinaSearchResponse = JinaSearchResult[];

/** Find JINA_API_KEY from environment or .env files. */
export function findApiKey(): string | null {
	return getEnvApiKey("jina") ?? null;
}

/** Call Jina Reader search API. */
async function callJinaSearch(apiKey: string, query: string, signal?: AbortSignal): Promise<JinaSearchResponse> {
	const requestUrl = `${JINA_SEARCH_URL}/${encodeURIComponent(query)}`;
	const response = await fetch(requestUrl, {
		headers: {
			Accept: "application/json",
			Authorization: `Bearer ${apiKey}`,
		},
		signal: withHardTimeout(signal, "api"),
	});

	if (!response.ok) {
		const errorText = await response.text();
		const classified = classifyProviderHttpError("jina", response.status, errorText);
		if (classified) throw classified;
		throw new SearchProviderError("jina", `Jina API error (${response.status}): ${errorText}`, response.status);
	}

	const payload = (await response.json()) as { data?: JinaSearchResponse } | null;
	return Array.isArray(payload?.data) ? payload.data : [];
}

/** Execute Jina web search. */
export async function searchJina(params: JinaSearchParams): Promise<SearchResponse> {
	const apiKey = findApiKey();
	if (!apiKey) {
		throw new Error("JINA_API_KEY not found. Set it in environment or .env file.");
	}

	const response = await callJinaSearch(apiKey, params.query, params.signal);
	const sources: SearchSource[] = [];

	for (const result of response) {
		if (!result?.url) continue;
		sources.push({
			title: result.title ?? result.url,
			url: result.url,
			snippet: result.content ?? undefined,
		});
	}

	const limitedSources = params.num_results ? sources.slice(0, params.num_results) : sources;

	return {
		provider: "jina",
		sources: limitedSources,
	};
}

/** Search provider for Jina Reader. */
export class JinaProvider extends SearchProvider {
	readonly id = "jina";
	readonly label = "Jina";

	isAvailable(_authStorage: AuthStorage): boolean {
		return !!findApiKey();
	}

	search(params: SearchParams): Promise<SearchResponse> {
		return searchJina({
			query: params.query,
			num_results: params.numSearchResults ?? params.limit,
			signal: params.signal,
		});
	}
}
