import { type AuthStorage, getEnvApiKey } from "@gajae-code/ai/core";
import type { SearchResponse } from "../../../web/search/types";
import { SearchProviderError } from "../../../web/search/types";
import { ParallelApiError, type ParallelSearchResult, type ParallelSearchSource } from "../../parallel";
import { clampNumResults } from "../utils";
import type { SearchParams } from "./base";
import { SearchProvider } from "./base";
import { classifyProviderHttpError, toSearchSources, withHardTimeout } from "./utils";

const DEFAULT_NUM_RESULTS = 10;
const MAX_NUM_RESULTS = 40;
const PARALLEL_SEARCH_URL = "https://api.parallel.ai/v1beta/search";
const PARALLEL_BETA_HEADER = "search-extract-2025-10-10";

function isObject(value: unknown): value is object {
	return typeof value === "object" && value !== null;
}

function getOwnValue(value: object, key: string): unknown {
	return Object.getOwnPropertyDescriptor(value, key)?.value;
}

function getString(value: object, key: string): string | undefined {
	const field = getOwnValue(value, key);
	return typeof field === "string" ? field : undefined;
}

function getObjectArray(value: object, key: string): object[] {
	const field = getOwnValue(value, key);
	return Array.isArray(field) ? field.filter(isObject) : [];
}

function getStringArray(value: object, key: string): string[] {
	const field = getOwnValue(value, key);
	return Array.isArray(field) ? field.filter((item): item is string => typeof item === "string") : [];
}

function extractParallelErrorMessage(payload: unknown): string | null {
	if (!isObject(payload)) return null;

	const directMessage = getString(payload, "message") ?? getString(payload, "detail") ?? getString(payload, "error");
	if (directMessage && directMessage.trim().length > 0) {
		return directMessage.trim();
	}

	const errorObject = getOwnValue(payload, "error");
	if (isObject(errorObject)) {
		const nestedMessage = getString(errorObject, "message") ?? getString(errorObject, "detail");
		if (nestedMessage && nestedMessage.trim().length > 0) {
			return nestedMessage.trim();
		}
	}

	return null;
}

function createParallelApiError(statusCode: number, detail?: string): ParallelApiError {
	return new ParallelApiError(
		detail ? `Parallel API error (${statusCode}): ${detail}` : `Parallel API error (${statusCode})`,
		statusCode,
	);
}

function parseParallelErrorResponse(statusCode: number, responseText: string): ParallelApiError {
	const trimmedResponseText = responseText.trim();
	if (trimmedResponseText.length === 0) {
		return createParallelApiError(statusCode);
	}

	try {
		const payload: unknown = JSON.parse(trimmedResponseText);
		return createParallelApiError(statusCode, extractParallelErrorMessage(payload) ?? trimmedResponseText);
	} catch {
		return createParallelApiError(statusCode, trimmedResponseText);
	}
}

function parseSearchPayload(payload: unknown): ParallelSearchResult {
	if (!isObject(payload)) {
		throw new ParallelApiError("Parallel search returned an invalid response payload.");
	}

	const requestId = getString(payload, "search_id") ?? "";
	const rawResults = getObjectArray(payload, "results");
	const sources: ParallelSearchSource[] = [];

	for (const item of rawResults) {
		const url = getString(item, "url");
		if (!url) continue;

		const excerpts = getStringArray(item, "excerpts");
		const snippet = excerpts.length > 0 ? excerpts.join("\n\n") : undefined;
		sources.push({
			title: getString(item, "title") ?? url,
			url,
			snippet,
			publishedDate: getString(item, "publish_date"),
			excerpts,
		});
	}

	return {
		requestId,
		sources,
		warnings: [],
		usage: [],
	};
}

async function searchWithAuthStorage(
	objective: string,
	queries: string[],
	params: {
		signal?: AbortSignal;
	},
	authStorage: AuthStorage,
	sessionId?: string,
): Promise<ParallelSearchResult> {
	const apiKey = await authStorage.getApiKey("parallel", sessionId, { signal: params.signal });
	if (!apiKey) {
		throw new ParallelApiError(
			"Parallel credentials not found. Set PARALLEL_API_KEY or login with 'gjc /login parallel'.",
		);
	}

	const response = await fetch(PARALLEL_SEARCH_URL, {
		method: "POST",
		headers: {
			Accept: "application/json",
			"Content-Type": "application/json",
			"x-api-key": apiKey,
			"parallel-beta": PARALLEL_BETA_HEADER,
		},
		body: JSON.stringify({
			objective,
			search_queries: queries,
			mode: "fast",
			excerpts: {
				max_chars_per_result: 10_000,
			},
		}),
		signal: withHardTimeout(params.signal, "api"),
	});
	if (!response.ok) {
		throw parseParallelErrorResponse(response.status, await response.text());
	}

	const payload: unknown = await response.json();
	return parseSearchPayload(payload);
}

export async function searchParallel(
	params: {
		query: string;
		num_results?: number;
		signal?: AbortSignal;
	},
	authStorage: AuthStorage,
	sessionId?: string,
): Promise<SearchResponse> {
	const numResults = clampNumResults(params.num_results, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS);

	try {
		const result = await searchWithAuthStorage(
			params.query,
			[params.query],
			{
				signal: params.signal,
			},
			authStorage,
			sessionId,
		);

		return {
			provider: "parallel",
			sources: toSearchSources(result.sources, numResults),
			requestId: result.requestId,
		};
	} catch (err) {
		if (err instanceof ParallelApiError) {
			if (typeof err.statusCode === "number") {
				const classified = classifyProviderHttpError("parallel", err.statusCode, err.message);
				if (classified) throw classified;
			}
			throw new SearchProviderError("parallel", err.message, err.statusCode);
		}
		throw err;
	}
}

export class ParallelProvider extends SearchProvider {
	readonly id = "parallel";
	readonly label = "Parallel";

	isAvailable(authStorage: AuthStorage) {
		return !!getEnvApiKey("parallel") || authStorage.hasAuth("parallel");
	}

	search(params: SearchParams): Promise<SearchResponse> {
		return searchParallel(
			{
				query: params.query,
				num_results: params.numSearchResults ?? params.limit,
				signal: params.signal,
			},
			params.authStorage,
			params.sessionId,
		);
	}
}
