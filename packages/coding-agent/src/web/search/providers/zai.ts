/**
 * Z.AI Web Search Provider
 *
 * Calls Z.AI's remote MCP server (`webSearchPrime`) and adapts results into
 * the unified SearchResponse shape used by the web search tool.
 */
import { type AuthStorage, getEnvApiKey } from "@gajae-code/ai/core";
import { asRecord, asString } from "../../../web/scrapers/utils";
import type { SearchResponse, SearchSource } from "../../../web/search/types";
import { SearchProviderError } from "../../../web/search/types";
import { dateToAgeSeconds } from "../utils";
import type { SearchParams } from "./base";
import { SearchProvider } from "./base";
import { classifyProviderHttpError, withHardTimeout } from "./utils";

const ZAI_MCP_URL = "https://api.z.ai/api/mcp/web_search_prime/mcp";
const ZAI_TOOL_NAME = "web_search_prime";
const DEFAULT_NUM_RESULTS = 10;

export interface ZaiSearchParams {
	query: string;
	num_results?: number;
	signal?: AbortSignal;
	authStorage: AuthStorage;
	sessionId?: string;
}

interface ZaiSearchResult {
	title?: string;
	content?: string;
	link?: string;
	url?: string;
	media?: string;
	publish_date?: string;
	publishedDate?: string;
}

interface ZaiWebSearchResponse {
	id?: string;
	request_id?: string;
	requestId?: string;
	search_result?: ZaiSearchResult[];
	results?: ZaiSearchResult[];
}

interface JsonRpcError {
	code?: number;
	message?: string;
}

interface JsonRpcPayload {
	result?: unknown;
	error?: JsonRpcError;
}

/** Resolve Z.AI API credentials through the unified auth storage pipeline. */
export async function findApiKey(
	authStorage: AuthStorage,
	sessionId?: string,
	signal?: AbortSignal,
): Promise<string | null> {
	return (await authStorage.getApiKey("zai", sessionId, { signal })) ?? null;
}

async function callZaiTool(apiKey: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
	const response = await fetch(ZAI_MCP_URL, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${apiKey}`,
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
		},
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: crypto.randomUUID(),
			method: "tools/call",
			params: {
				name: ZAI_TOOL_NAME,
				arguments: args,
			},
		}),
		signal: withHardTimeout(signal, "api"),
	});

	if (!response.ok) {
		const errorText = await response.text();
		const classified = classifyProviderHttpError("zai", response.status, errorText);
		if (classified) throw classified;
		throw new SearchProviderError("zai", `Z.AI MCP error (${response.status}): ${errorText}`, response.status);
	}

	const rawText = await response.text();

	const parsedMessages: unknown[] = [];
	for (const line of rawText.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed.startsWith("data:")) continue;
		const data = trimmed.slice(5).trim();
		if (!data) continue;
		try {
			parsedMessages.push(JSON.parse(data));
		} catch {
			// Ignore non-JSON data events.
		}
	}

	if (parsedMessages.length === 0) {
		try {
			parsedMessages.push(JSON.parse(rawText));
		} catch {
			throw new SearchProviderError("zai", "Failed to parse Z.AI MCP response", 500);
		}
	}

	const parsed = parsedMessages[parsedMessages.length - 1];
	const parsedRecord = asRecord(parsed);
	const directErrorCode = typeof parsedRecord?.code === "number" ? parsedRecord.code : undefined;
	const directErrorSuccess = parsedRecord?.success;
	const directErrorMessage =
		asString(parsedRecord?.msg) ?? asString(parsedRecord?.message) ?? asString(parsedRecord?.error_message);
	if (directErrorSuccess === false && directErrorMessage) {
		throw new SearchProviderError(
			"zai",
			`Z.AI API error${directErrorCode ? ` (${directErrorCode})` : ""}: ${directErrorMessage}`,
			directErrorCode,
		);
	}

	const payload = parsed as JsonRpcPayload;
	if (payload.error) {
		const status = typeof payload.error.code === "number" ? payload.error.code : 400;
		throw new SearchProviderError(
			"zai",
			`Z.AI MCP error${payload.error.code ? ` (${payload.error.code})` : ""}: ${payload.error.message ?? "Unknown error"}`,
			status,
		);
	}

	const resultRecord = asRecord(payload.result);
	if (resultRecord?.isError === true) {
		const content = Array.isArray(resultRecord.content) ? resultRecord.content : [];
		const errorText = content
			.map(item => asString(asRecord(item)?.text))
			.filter((text): text is string => text != null)
			.join("\n")
			.trim();
		const statusMatch = errorText.match(/MCP error\s*(-?\d+)/i);
		const statusCode = statusMatch ? Math.abs(Number.parseInt(statusMatch[1], 10)) : 400;
		throw new SearchProviderError("zai", errorText || "Z.AI MCP tool call failed", statusCode);
	}

	if (payload.result !== undefined) {
		return payload.result;
	}

	return parsed;
}

async function callZaiSearch(apiKey: string, params: ZaiSearchParams): Promise<unknown> {
	const count = params.num_results ?? DEFAULT_NUM_RESULTS;
	const attempts: Record<string, unknown>[] = [
		{ query: params.query, count },
		{ search_query: params.query, count },
		{ search_query: params.query, search_engine: "search-prime", count },
	];

	let lastError: unknown;
	for (let i = 0; i < attempts.length; i++) {
		try {
			return await callZaiTool(apiKey, attempts[i], params.signal);
		} catch (error) {
			lastError = error;
			const isLastAttempt = i === attempts.length - 1;
			if (isLastAttempt) {
				throw error;
			}
			if (!(error instanceof SearchProviderError)) {
				throw error;
			}
			const message = error.message.toLowerCase();
			const looksLikeArgError =
				error.status === 400 ||
				message.includes("invalid") ||
				message.includes("argument") ||
				message.includes("search_query") ||
				message.includes("query");
			if (!looksLikeArgError) {
				throw error;
			}
		}
	}

	throw lastError ?? new SearchProviderError("zai", "Z.AI search failed", 500);
}

function getSearchResults(value: unknown): ZaiSearchResult[] {
	if (Array.isArray(value)) {
		return value as ZaiSearchResult[];
	}
	const obj = asRecord(value);
	if (!obj) return [];

	const searchResult = obj.search_result;
	if (Array.isArray(searchResult)) return searchResult as ZaiSearchResult[];

	const results = obj.results;
	if (Array.isArray(results)) return results as ZaiSearchResult[];

	return [];
}

function parseSearchPayload(rawResult: unknown): {
	results: ZaiSearchResult[];
	answer?: string;
	requestId?: string;
} {
	const candidates: unknown[] = [rawResult];
	const textParts: string[] = [];

	const root = asRecord(rawResult);
	if (root) {
		if (root.structuredContent) candidates.push(root.structuredContent);
		if (root.data) candidates.push(root.data);
		if (root.result) candidates.push(root.result);

		const content = root.content;
		if (Array.isArray(content)) {
			for (const part of content) {
				const partObj = asRecord(part);
				const text = asString(partObj?.text);
				if (!text) continue;
				textParts.push(text);
				try {
					candidates.push(JSON.parse(text));
				} catch {
					// Not JSON payload; keep as fallback answer text.
				}
			}
		}
	}

	for (const candidate of candidates) {
		const results = getSearchResults(candidate);
		if (results.length > 0) {
			const obj = asRecord(candidate) as ZaiWebSearchResponse | null;
			return {
				results,
				answer: textParts.length > 0 ? textParts.join("\n\n") : undefined,
				requestId: obj?.request_id ?? obj?.requestId ?? obj?.id,
			};
		}
	}

	return {
		results: [],
		answer: textParts.length > 0 ? textParts.join("\n\n") : undefined,
	};
}

function toSources(results: ZaiSearchResult[]): SearchSource[] {
	const sources: SearchSource[] = [];
	for (const result of results) {
		const url = asString(result.link) ?? asString(result.url);
		if (!url) continue;

		const publishedDate = asString(result.publish_date) ?? asString(result.publishedDate);
		sources.push({
			title: asString(result.title) ?? url,
			url,
			snippet: asString(result.content) ?? undefined,
			publishedDate: publishedDate ?? undefined,
			ageSeconds: dateToAgeSeconds(publishedDate),
			author: asString(result.media) ?? undefined,
		});
	}
	return sources;
}

/** Execute Z.AI web search via remote MCP endpoint. */
export async function searchZai(params: ZaiSearchParams): Promise<SearchResponse> {
	const apiKey = await findApiKey(params.authStorage, params.sessionId, params.signal);
	if (!apiKey) {
		throw new Error("Z.AI credentials not found. Set ZAI_API_KEY or login with 'gjc /login zai'.");
	}

	const rawResult = await callZaiSearch(apiKey, params);
	const payload = parseSearchPayload(rawResult);
	let sources = toSources(payload.results);

	if (params.num_results && sources.length > params.num_results) {
		sources = sources.slice(0, params.num_results);
	}

	return {
		provider: "zai",
		answer: payload.answer,
		sources,
		requestId: payload.requestId,
	};
}

/** Search provider for Z.AI web search MCP. */
export class ZaiProvider extends SearchProvider {
	readonly id = "zai";
	readonly label = "Z.AI";

	isAvailable(authStorage: AuthStorage): Promise<boolean> | boolean {
		return authStorage.hasAuth("zai") || !!getEnvApiKey("zai");
	}

	search(params: SearchParams): Promise<SearchResponse> {
		return searchZai({
			query: params.query,
			num_results: params.numSearchResults ?? params.limit,
			signal: params.signal,
			authStorage: params.authStorage,
			sessionId: params.sessionId,
		});
	}
}
