/**
 * Perplexity Web Search Provider
 *
 * Supports three auth modes:
 * - Cookies (`PERPLEXITY_COOKIES`) via `www.perplexity.ai/rest/sse/perplexity_ask`
 * - OAuth/session bearer via `AuthStorage` and `www.perplexity.ai/rest/sse/perplexity_ask`
 * - API key (`PERPLEXITY_API_KEY`) via `api.perplexity.ai/chat/completions`
 */

import { type AuthStorage, getEnvApiKey } from "@gajae-code/ai/core";
import { $env, readSseJson } from "@gajae-code/utils";
import type { PerplexityRequest, SearchCitation, SearchResponse, SearchSource } from "../../../web/search/types";
import { SearchProviderError } from "../../../web/search/types";
import { clampNumResults, dateToAgeSeconds } from "../utils";
import type { SearchParams } from "./base";
import { SearchProvider } from "./base";
import { classifyProviderHttpError, withHardTimeout } from "./utils";

const PERPLEXITY_API_URL = "https://api.perplexity.ai/chat/completions";
const PERPLEXITY_OAUTH_ASK_URL = "https://www.perplexity.ai/rest/sse/perplexity_ask";

const DEFAULT_MAX_TOKENS = 8192;
const DEFAULT_TEMPERATURE = 0.2;
const DEFAULT_NUM_SEARCH_RESULTS = 10;
const MIN_NUM_SEARCH_RESULTS = 3;
const MAX_NUM_SEARCH_RESULTS = 100;
const OAUTH_EXPIRY_BUFFER_MS = 5 * 60 * 1000;
const OAUTH_API_VERSION = "2.18";
const OAUTH_USER_AGENT = "Perplexity/641 CFNetwork/1568 Darwin/25.2.0";

type PerplexityAuth =
	| {
			type: "api_key";
			token: string;
	  }
	| {
			type: "oauth";
			token: string;
	  }
	| {
			type: "cookies";
			cookies: string;
	  };

interface PerplexityOAuthStreamMarkdownBlock {
	answer?: string;
	chunks?: string[];
	chunk_starting_offset?: number;
}
interface PerplexityOAuthStreamWebResult {
	name?: string;
	url?: string;
	snippet?: string;
	timestamp?: string;
}

interface PerplexityOAuthStreamWebResultBlock {
	web_results?: PerplexityOAuthStreamWebResult[];
}

interface PerplexityOAuthStreamBlock {
	intended_usage?: string;
	markdown_block?: PerplexityOAuthStreamMarkdownBlock;
	web_result_block?: PerplexityOAuthStreamWebResultBlock;
}

interface PerplexityOAuthStreamSource {
	title?: string;
	url?: string;
	snippet?: string;
	date?: string;
}

interface PerplexityOAuthStreamEvent {
	status?: string;
	final?: boolean;
	text?: string;
	blocks?: PerplexityOAuthStreamBlock[];
	sources_list?: PerplexityOAuthStreamSource[];
	error_code?: string;
	error_message?: string;
	display_model?: string;
	uuid?: string;
}

function mergeMarkdownBlock(
	existing: PerplexityOAuthStreamMarkdownBlock | undefined,
	incoming: PerplexityOAuthStreamMarkdownBlock,
): PerplexityOAuthStreamMarkdownBlock {
	if (!existing) return { ...incoming };

	const result: PerplexityOAuthStreamMarkdownBlock = { ...existing, ...incoming };
	if (incoming.chunks?.length) {
		const offset = incoming.chunk_starting_offset ?? 0;
		const existingChunks = existing.chunks ?? [];
		result.chunks = offset === 0 ? [...incoming.chunks] : [...existingChunks.slice(0, offset), ...incoming.chunks];
	}

	return result;
}

function mergeBlocks(
	existing: PerplexityOAuthStreamBlock[],
	incoming: PerplexityOAuthStreamBlock[],
): PerplexityOAuthStreamBlock[] {
	const blockMap = new Map<string, PerplexityOAuthStreamBlock>(
		existing
			.filter(block => typeof block.intended_usage === "string" && block.intended_usage.length > 0)
			.map(block => [block.intended_usage as string, block]),
	);

	for (const block of incoming) {
		if (!block.intended_usage) continue;
		const prev = blockMap.get(block.intended_usage);
		if (block.markdown_block) {
			blockMap.set(block.intended_usage, {
				...prev,
				...block,
				markdown_block: mergeMarkdownBlock(prev?.markdown_block, block.markdown_block),
			});
			continue;
		}

		blockMap.set(block.intended_usage, { ...prev, ...block });
	}

	return [...blockMap.values()];
}

function mergeOAuthEventSnapshot(
	existing: PerplexityOAuthStreamEvent,
	incoming: PerplexityOAuthStreamEvent,
): PerplexityOAuthStreamEvent {
	const merged: PerplexityOAuthStreamEvent = { ...existing, ...incoming };
	if (incoming.blocks && incoming.blocks.length > 0) {
		merged.blocks = mergeBlocks(existing.blocks ?? [], incoming.blocks);
	} else {
		merged.blocks = existing.blocks ?? [];
	}

	if (!merged.sources_list && existing.sources_list) {
		merged.sources_list = existing.sources_list;
	}

	return merged;
}
export interface PerplexitySearchParams {
	signal?: AbortSignal;
	query: string;
	system_prompt?: string;
	search_recency_filter?: "hour" | "day" | "week" | "month" | "year";
	num_results?: number;
	/** Maximum output tokens. Defaults to 4096. */
	max_tokens?: number;
	/** Sampling temperature (0–1). Lower = more focused/factual. Defaults to 0.2. */
	temperature?: number;
	/** Number of search results to retrieve. Defaults to 10. */
	num_search_results?: number;
	authStorage: AuthStorage;
	sessionId?: string;
}

/** Find PERPLEXITY_API_KEY from environment or .env files (also checks PPLX_API_KEY) */
export function findApiKey(): string | null {
	return getEnvApiKey("perplexity") ?? null;
}

/**
 * Decode a Perplexity JWT's `exp` claim, in ms. Returns `undefined` when the
 * token has no `exp` (which is the common case — Perplexity sessions are
 * server-side and effectively non-expiring from the client's POV).
 */
function jwtExpiryMs(token: string): number | undefined {
	const parts = token.split(".");
	if (parts.length !== 3) return undefined;
	const payload = parts[1];
	if (!payload) return undefined;
	try {
		const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { exp?: unknown };
		if (typeof decoded.exp !== "number" || !Number.isFinite(decoded.exp)) return undefined;
		return decoded.exp * 1000;
	} catch {
		return undefined;
	}
}

async function findOAuthToken(
	authStorage: AuthStorage,
	sessionId: string | undefined,
	signal: AbortSignal | undefined,
): Promise<string | null> {
	try {
		// `getOAuthAccess` returns the raw OAuth bearer only — runtime/config
		// api_key overrides and stored api_key credentials are intentionally
		// suppressed so we don't POST an `api.perplexity.ai` key to the
		// `www.perplexity.ai` session/SSE endpoint.
		const access = await authStorage.getOAuthAccess("perplexity", sessionId, { signal });
		const token = access?.accessToken;
		if (!token) return null;
		// Trust the JWT's own `exp` claim if it has one; otherwise treat as
		// non-expiring. Perplexity session JWTs commonly omit `exp`.
		const jwtExpiry = jwtExpiryMs(token);
		if (jwtExpiry !== undefined && jwtExpiry <= Date.now() + OAUTH_EXPIRY_BUFFER_MS) return null;
		return token;
	} catch {
		return null;
	}
}

async function findPerplexityAuth(
	authStorage: AuthStorage,
	sessionId: string | undefined,
	signal: AbortSignal | undefined,
): Promise<PerplexityAuth | null> {
	// 1. PERPLEXITY_COOKIES env var
	const cookies = $env.PERPLEXITY_COOKIES?.trim();
	if (cookies) {
		return { type: "cookies", cookies };
	}

	const apiKey = findApiKey();

	// 2. OAuth/session bearer from AuthStorage.
	const oauthToken = await findOAuthToken(authStorage, sessionId, signal);
	if (oauthToken) {
		return { type: "oauth", token: oauthToken };
	}

	// 3. PERPLEXITY_API_KEY env var
	if (apiKey) {
		return { type: "api_key", token: apiKey };
	}
	return null;
}

/** Call Perplexity API-key endpoint. */
async function callPerplexityApi(apiKey: string, request: PerplexityRequest, signal?: AbortSignal): Promise<unknown> {
	const response = await fetch(PERPLEXITY_API_URL, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${apiKey}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(request),
		signal: withHardTimeout(signal, "llm"),
	});

	if (!response.ok) {
		const errorText = await response.text();
		const classified = classifyProviderHttpError("perplexity", response.status, errorText);
		if (classified) throw classified;
		throw new SearchProviderError("perplexity", `Perplexity API error (${response.status})`, response.status);
	}

	try {
		return await response.json();
	} catch (error) {
		if (error instanceof Error && error.name === "AbortError") throw error;
		throw new SearchProviderError("perplexity", "Perplexity API returned invalid JSON", 502);
	}
}

function buildOAuthSources(event: PerplexityOAuthStreamEvent): SearchSource[] {
	const results =
		event.blocks?.find(block => block.intended_usage === "web_results")?.web_result_block?.web_results ?? [];

	if (results.length > 0) {
		return results
			.filter(result => typeof result.url === "string" && result.url.length > 0)
			.map(result => ({
				title: result.name ?? result.url ?? "",
				url: result.url ?? "",
				snippet: result.snippet,
				publishedDate: result.timestamp,
				ageSeconds: dateToAgeSeconds(result.timestamp),
			}));
	}

	return (event.sources_list ?? [])
		.filter(source => typeof source.url === "string" && source.url.length > 0)
		.map(source => ({
			title: source.title ?? source.url ?? "",
			url: source.url ?? "",
			snippet: source.snippet,
			publishedDate: source.date,
			ageSeconds: dateToAgeSeconds(source.date),
		}));
}

function buildOAuthAnswer(event: PerplexityOAuthStreamEvent): string {
	if (!event.blocks?.length) {
		return typeof event.text === "string" ? event.text : "";
	}

	const markdownBlock = event.blocks.find(
		block => block.intended_usage?.includes("markdown") && block.markdown_block,
	)?.markdown_block;
	if (markdownBlock) {
		if (Array.isArray(markdownBlock.chunks) && markdownBlock.chunks.length > 0) {
			return markdownBlock.chunks.join("");
		}
		if (typeof markdownBlock.answer === "string" && markdownBlock.answer.length > 0) {
			return markdownBlock.answer;
		}
	}

	const textBlock = event.blocks.find(
		block => block.intended_usage === "ask_text" && block.markdown_block,
	)?.markdown_block;
	if (textBlock) {
		if (Array.isArray(textBlock.chunks) && textBlock.chunks.length > 0) {
			return textBlock.chunks.join("");
		}
		if (typeof textBlock.answer === "string" && textBlock.answer.length > 0) {
			return textBlock.answer;
		}
	}
	if (typeof event.text === "string" && event.text.length > 0) {
		return event.text;
	}
	return "";
}

async function callPerplexityOAuth(
	auth: { type: "oauth"; token: string } | { type: "cookies"; cookies: string },
	params: PerplexitySearchParams,
): Promise<{ answer: string; sources: SearchSource[]; model?: string; requestId?: string }> {
	const requestId = crypto.randomUUID();
	const effectiveQuery = params.system_prompt ? `${params.system_prompt}\n\n${params.query}` : params.query;

	const response = await fetch(PERPLEXITY_OAUTH_ASK_URL, {
		method: "POST",
		headers: {
			...(auth.type === "cookies" ? { Cookie: auth.cookies } : { Authorization: `Bearer ${auth.token}` }),
			"Content-Type": "application/json",
			Accept: "text/event-stream",
			Origin: "https://www.perplexity.ai",
			Referer: "https://www.perplexity.ai/",
			"User-Agent": OAUTH_USER_AGENT,
			"X-App-ApiClient": "default",
			"X-App-ApiVersion": OAUTH_API_VERSION,
			"X-Perplexity-Request-Reason": "submit",
			"X-Request-ID": requestId,
		},
		body: JSON.stringify({
			query_str: effectiveQuery,
			params: {
				query_str: effectiveQuery,
				search_focus: "internet",
				mode: "copilot",
				model_preference: "pplx_pro_upgraded",
				sources: ["web"],
				attachments: [],
				frontend_uuid: crypto.randomUUID(),
				frontend_context_uuid: crypto.randomUUID(),
				version: OAUTH_API_VERSION,
				language: "en-US",
				timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
				search_recency_filter: params.search_recency_filter ?? null,
				is_incognito: true,
				use_schematized_api: true,
				skip_search_enabled: true,
			},
		}),
		signal: withHardTimeout(params.signal, "llm"),
	});

	if (!response.ok) {
		const errorText = await response.text();
		const classified = classifyProviderHttpError("perplexity", response.status, errorText);
		if (classified) throw classified;
		throw new SearchProviderError("perplexity", `Perplexity OAuth API error (${response.status})`, response.status);
	}

	if (!response.body) {
		throw new SearchProviderError("perplexity", "Perplexity OAuth API returned no response body", 500);
	}

	let answer = "";
	let model: string | undefined;
	let finalRequestId: string | undefined;
	const sourcesByUrl = new Map<string, SearchSource>();
	let mergedEvent: PerplexityOAuthStreamEvent = { blocks: [] };

	for await (const event of readSseJson<PerplexityOAuthStreamEvent>(response.body, params.signal)) {
		if (event.error_code) {
			const message = event.error_message ?? event.error_code;
			throw new SearchProviderError("perplexity", `Perplexity OAuth stream error: ${message}`, 400);
		}

		mergedEvent = mergeOAuthEventSnapshot(mergedEvent, event);

		const eventAnswer = buildOAuthAnswer(mergedEvent);
		if (eventAnswer.length > 0) {
			answer = eventAnswer;
		}

		for (const source of buildOAuthSources(mergedEvent)) {
			sourcesByUrl.set(source.url, source);
		}

		if (mergedEvent.display_model) model = mergedEvent.display_model;
		if (mergedEvent.uuid) finalRequestId = mergedEvent.uuid;
		if (mergedEvent.final || mergedEvent.status === "COMPLETED") {
			break;
		}
	}

	return {
		answer,
		sources: [...sourcesByUrl.values()],
		model,
		requestId: finalRequestId ?? requestId,
	};
}

type JsonObject = Record<string, unknown>;

function malformedResponse(detail: string): never {
	throw new SearchProviderError("perplexity", `Perplexity API returned malformed response body (${detail})`, 502);
}

function isJsonObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalArray(value: unknown, detail: string): unknown[] {
	if (value === undefined || value === null) return [];
	if (!Array.isArray(value)) malformedResponse(detail);
	return value;
}

function messageContentToText(content: unknown): string {
	if (content === undefined || content === null) return "";
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) malformedResponse("message content must be a string or array");

	return content
		.map(chunk => {
			if (!isJsonObject(chunk) || typeof chunk.type !== "string") {
				malformedResponse("message content chunks must be objects with a type");
			}
			if (chunk.type !== "text") return "";
			if (typeof chunk.text !== "string") malformedResponse("text content chunks must contain text");
			return chunk.text;
		})
		.join("");
}

/** Parse API response into unified SearchResponse */
function parseResponse(value: unknown): SearchResponse {
	if (!isJsonObject(value)) malformedResponse("expected a JSON object");

	const choices = optionalArray(value.choices, "choices must be an array");
	const firstChoice = choices[0];
	if (firstChoice !== undefined && !isJsonObject(firstChoice)) malformedResponse("choices must contain objects");
	const message = firstChoice?.message;
	if (message !== undefined && !isJsonObject(message)) malformedResponse("choice message must be an object");
	const messageContent = message?.content;
	const answer = messageContentToText(messageContent);

	const sources: SearchSource[] = [];
	const citations: SearchCitation[] = [];

	const citationUrls = optionalArray(value.citations, "citations must be an array").map(url => {
		if (typeof url !== "string" || url.length === 0) malformedResponse("citations must contain non-empty URLs");
		return url;
	});
	const searchResults = optionalArray(value.search_results, "search_results must be an array").map(result => {
		if (!isJsonObject(result)) malformedResponse("search_results must contain objects");
		if (typeof result.url !== "string" || result.url.length === 0) {
			malformedResponse("search_results entries must contain a non-empty URL");
		}
		if (result.title !== undefined && typeof result.title !== "string") {
			malformedResponse("search_results titles must be strings");
		}
		if (result.snippet !== undefined && typeof result.snippet !== "string") {
			malformedResponse("search_results snippets must be strings");
		}
		if (result.date !== undefined && result.date !== null && typeof result.date !== "string") {
			malformedResponse("search_results dates must be strings");
		}
		return {
			title: result.title ?? result.url,
			url: result.url,
			snippet: result.snippet,
			date: result.date,
		};
	});

	if (citationUrls.length > 0) {
		for (const url of citationUrls) {
			const searchResult = searchResults.find(r => r.url === url);
			sources.push({
				title: searchResult?.title ?? url,
				url,
				snippet: searchResult?.snippet,
				publishedDate: searchResult?.date ?? undefined,
				ageSeconds: dateToAgeSeconds(searchResult?.date),
			});
			citations.push({
				url,
				title: searchResult?.title ?? url,
			});
		}
	} else {
		for (const searchResult of searchResults) {
			sources.push({
				title: searchResult.title ?? searchResult.url,
				url: searchResult.url,
				snippet: searchResult.snippet,
				publishedDate: searchResult.date ?? undefined,
				ageSeconds: dateToAgeSeconds(searchResult.date),
			});
		}
	}

	return {
		provider: "perplexity",
		answer: answer || undefined,
		sources,
		citations: citations.length > 0 ? citations : undefined,
		usage: isJsonObject(value.usage)
			? {
					inputTokens: typeof value.usage.prompt_tokens === "number" ? value.usage.prompt_tokens : undefined,
					outputTokens:
						typeof value.usage.completion_tokens === "number" ? value.usage.completion_tokens : undefined,
					totalTokens: typeof value.usage.total_tokens === "number" ? value.usage.total_tokens : undefined,
				}
			: undefined,
		model: typeof value.model === "string" ? value.model : undefined,
		requestId: typeof value.id === "string" ? value.id : undefined,
	};
}

function normalizeNumSearchResults(value: number | undefined): number {
	return Math.max(MIN_NUM_SEARCH_RESULTS, clampNumResults(value, DEFAULT_NUM_SEARCH_RESULTS, MAX_NUM_SEARCH_RESULTS));
}

function applySourceLimit(result: SearchResponse, limit?: number): SearchResponse {
	if (limit && result.sources.length > limit) {
		result.sources = result.sources.slice(0, limit);
	}
	return result;
}

/** Execute Perplexity web search */
export async function searchPerplexity(params: PerplexitySearchParams): Promise<SearchResponse> {
	const auth = await findPerplexityAuth(params.authStorage, params.sessionId, params.signal);
	if (!auth) {
		throw new Error("Perplexity auth not found. Set PERPLEXITY_COOKIES, PERPLEXITY_API_KEY, or login via OAuth.");
	}

	if (auth.type === "oauth" || auth.type === "cookies") {
		const oauthResult = await callPerplexityOAuth(auth, params);
		if (!oauthResult.answer.trim()) {
			throw new SearchProviderError("perplexity", "Perplexity web search returned no answer", 424);
		}
		return applySourceLimit(
			{
				provider: "perplexity",
				answer: oauthResult.answer || undefined,
				sources: oauthResult.sources,
				model: oauthResult.model,
				requestId: oauthResult.requestId,
				authMode: "oauth",
			},
			params.num_results,
		);
	}

	const systemPrompt = params.system_prompt;
	const messages: PerplexityRequest["messages"] = [];
	if (systemPrompt) {
		messages.push({ role: "system", content: systemPrompt });
	}
	messages.push({ role: "user", content: params.query });

	const request: PerplexityRequest = {
		model: "sonar-pro",
		messages,
		max_tokens: params.max_tokens ?? DEFAULT_MAX_TOKENS,
		temperature: params.temperature ?? DEFAULT_TEMPERATURE,
		search_mode: "web",
		num_search_results: normalizeNumSearchResults(params.num_search_results),
		web_search_options: {
			search_type: "pro",
			search_context_size: "medium",
		},
		enable_search_classifier: true,
		reasoning_effort: "medium",
		language_preference: "en",
	};

	if (params.search_recency_filter) {
		request.search_recency_filter = params.search_recency_filter;
	}

	let result: SearchResponse | undefined;
	for (let attempt = 0; attempt < 2; attempt++) {
		const response = await callPerplexityApi(auth.token, request, params.signal);
		result = parseResponse(response);
		if (result.answer?.trim()) break;
	}

	if (!result?.answer?.trim()) {
		throw new SearchProviderError("perplexity", "Perplexity web search returned no answer", 424);
	}
	result.authMode = "api_key";
	return applySourceLimit(result, params.num_results);
}

/** Search provider for Perplexity. */
export class PerplexityProvider extends SearchProvider {
	readonly id = "perplexity";
	readonly label = "Perplexity";

	isAvailable(authStorage: AuthStorage): boolean {
		return !!$env.PERPLEXITY_COOKIES?.trim() || authStorage.hasAuth("perplexity") || !!findApiKey();
	}

	search(params: SearchParams): Promise<SearchResponse> {
		return searchPerplexity({
			signal: params.signal,
			query: params.query,
			temperature: params.temperature,
			max_tokens: params.maxOutputTokens,
			num_search_results: params.numSearchResults,
			system_prompt: params.systemPrompt,
			search_recency_filter: params.recency,
			num_results: params.limit,
			authStorage: params.authStorage,
			sessionId: params.sessionId,
		});
	}
}
