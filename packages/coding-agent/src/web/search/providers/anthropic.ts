/**
 * Anthropic Web Search Provider
 *
 * Uses Anthropic's built-in web_search_20250305 tool to search the web.
 * Returns synthesized answers with citations and source metadata.
 */
import {
	type AnthropicAuthConfig,
	type AnthropicSystemBlock,
	type AuthStorage,
	buildAnthropicAuthConfig,
	buildAnthropicSearchHeaders,
	buildAnthropicSystemBlocks,
	buildAnthropicUrl,
	stripClaudeToolPrefix,
} from "@gajae-code/ai";
import { $env } from "@gajae-code/utils";
import type {
	AnthropicApiResponse,
	AnthropicCitation,
	SearchCitation,
	SearchResponse,
	SearchSource,
} from "../../../web/search/types";
import { SearchProviderError } from "../../../web/search/types";
import type { SearchParams } from "./base";
import { SearchProvider } from "./base";
import { extractTextSources } from "./text-citations";
import { classifyProviderHttpError, withHardTimeout } from "./utils";

const DEFAULT_MODEL = "claude-haiku-4-5";
const DEFAULT_MAX_TOKENS = 4096;
const WEB_SEARCH_TOOL_NAME = "web_search";
const WEB_SEARCH_TOOL_TYPE = "web_search_20250305";
export interface AnthropicSearchParams {
	query: string;
	system_prompt?: string;
	num_results?: number;
	max_tokens?: number;
	temperature?: number;
	signal?: AbortSignal;
}

/**
 * Gets the model to use for web search from environment or default.
 * @returns Model identifier string
 */
function getModel(): string {
	return $env.ANTHROPIC_SEARCH_MODEL ?? DEFAULT_MODEL;
}

/**
 * Builds system instruction blocks for the Anthropic API request.
 * @param auth - Authentication configuration
 * @param model - Model identifier (affects whether Anthropic Code instruction is included)
 * @param systemPrompt - Optional system prompt for guiding response style
 * @returns Array of system blocks for the API request
 */
function buildSystemBlocks(
	auth: AnthropicAuthConfig,
	model: string,
	systemPrompt?: string,
): AnthropicSystemBlock[] | undefined {
	const includeClaudeCode = !model.startsWith("claude-3-5-haiku");
	const extraInstructions = auth.isOAuth ? ["You are a helpful AI assistant with web search capabilities."] : [];

	return buildAnthropicSystemBlocks(systemPrompt ? [systemPrompt] : undefined, {
		includeClaudeCodeInstruction: includeClaudeCode,
		extraInstructions,
		cacheControl: { type: "ephemeral" },
	});
}

/**
 * Calls the Anthropic API with web search tool enabled.
 * @param auth - Authentication configuration (API key or OAuth)
 * @param model - Model identifier to use
 * @param query - Search query from the user
 * @param systemPrompt - Optional system prompt for guiding response style
 * @returns Raw API response from Anthropic
 * @throws {SearchProviderError} If the API request fails
 */
async function callSearch(
	auth: AnthropicAuthConfig,
	model: string,
	query: string,
	systemPrompt?: string,
	maxTokens?: number,
	temperature?: number,
	signal?: AbortSignal,
	extraHeaders?: Record<string, string>,
): Promise<AnthropicApiResponse> {
	const url = buildAnthropicUrl(auth);
	const headers = { ...(extraHeaders ?? {}), ...buildAnthropicSearchHeaders(auth) };

	const systemBlocks = buildSystemBlocks(auth, model, systemPrompt);

	const body: Record<string, unknown> = {
		model,
		max_tokens: maxTokens ?? DEFAULT_MAX_TOKENS,
		messages: [{ role: "user", content: query }],
		tools: [
			{
				type: WEB_SEARCH_TOOL_TYPE,
				name: WEB_SEARCH_TOOL_NAME,
			},
		],
	};

	if (temperature !== undefined) {
		body.temperature = temperature;
	}

	if (systemBlocks && systemBlocks.length > 0) {
		body.system = systemBlocks;
	}

	const response = await fetch(url, {
		method: "POST",
		headers,
		body: JSON.stringify(body),
		signal: withHardTimeout(signal),
	});

	if (!response.ok) {
		const errorText = await response.text();
		const classified = classifyProviderHttpError("anthropic", response.status, errorText);
		if (classified) throw classified;
		throw new SearchProviderError(
			"anthropic",
			`Anthropic API error (${response.status}): ${errorText}`,
			response.status,
		);
	}

	return response.json() as Promise<AnthropicApiResponse>;
}

/**
 * Parses a human-readable page age string into seconds.
 * @param pageAge - Age string like "2 days ago", "3h ago", "1 week ago"
 * @returns Age in seconds, or undefined if parsing fails
 */
function parsePageAge(pageAge: string | null | undefined): number | undefined {
	if (!pageAge) return undefined;

	const match = pageAge.match(/^(\d+)\s*(s|sec|second|m|min|minute|h|hour|d|day|w|week|mo|month|y|year)s?\s*(ago)?$/i);
	if (!match) return undefined;

	const value = parseInt(match[1], 10);
	const unit = match[2].toLowerCase();

	const multipliers: Record<string, number> = {
		s: 1,
		sec: 1,
		second: 1,
		m: 60,
		min: 60,
		minute: 60,
		h: 3600,
		hour: 3600,
		d: 86400,
		day: 86400,
		w: 604800,
		week: 604800,
		mo: 2592000,
		month: 2592000,
		y: 31536000,
		year: 31536000,
	};

	return value * (multipliers[unit] ?? 86400);
}

/**
 * Parses the Anthropic API response into a unified SearchResponse.
 * @param response - Raw API response containing content blocks
 * @returns Normalized response with answer, sources, citations, and usage
 */
function parseResponse(response: AnthropicApiResponse): SearchResponse {
	const answerParts: string[] = [];
	const searchQueries: string[] = [];
	const sources: SearchSource[] = [];
	const citations: SearchCitation[] = [];

	for (const block of response.content) {
		if (
			block.type === "server_tool_use" &&
			block.name &&
			stripClaudeToolPrefix(block.name) === WEB_SEARCH_TOOL_NAME
		) {
			// Intermediate search query
			if (block.input?.query) {
				searchQueries.push(block.input.query);
			}
		} else if (block.type === "web_search_tool_result" && Array.isArray(block.content)) {
			// Search results
			for (const result of block.content) {
				if (result.type === "web_search_result") {
					sources.push({
						title: result.title,
						url: result.url,
						snippet: undefined,
						publishedDate: result.page_age ?? undefined,
						ageSeconds: parsePageAge(result.page_age),
					});
				}
			}
		} else if (block.type === "text" && block.text) {
			// Synthesized answer with citations
			answerParts.push(block.text);
			if (block.citations) {
				for (const c of block.citations as AnthropicCitation[]) {
					citations.push({
						url: c.url,
						title: c.title,
						citedText: c.cited_text,
					});
				}
			}
		}
	}

	return {
		provider: "anthropic",
		answer: answerParts.join("\n\n") || undefined,
		sources,
		citations: citations.length > 0 ? citations : undefined,
		searchQueries: searchQueries.length > 0 ? searchQueries : undefined,
		usage: {
			inputTokens: response.usage.input_tokens,
			outputTokens: response.usage.output_tokens,
			searchRequests: response.usage.server_tool_use?.web_search_requests,
		},
		model: response.model,
		requestId: response.id,
	};
}

/**
 * Whether the response carries proof that a web search actually ran: a
 * `web_search_tool_result` block, a `web_search` server tool call, or a
 * non-zero `server_tool_use.web_search_requests` usage counter.
 */
function anthropicSearchPerformed(response: AnthropicApiResponse): boolean {
	if (response.usage?.server_tool_use?.web_search_requests) return true;
	for (const block of response.content ?? []) {
		if (block.type === "web_search_tool_result") {
			// `content` is an array of results on success but an error OBJECT
			// (`web_search_tool_result_error`) on failure; only count a result
			// array with at least one real result as proof of search.
			if (Array.isArray(block.content) && block.content.some(result => result.type === "web_search_result")) {
				return true;
			}
			continue;
		}
		if (
			block.type === "server_tool_use" &&
			block.name &&
			stripClaudeToolPrefix(block.name) === WEB_SEARCH_TOOL_NAME
		) {
			return true;
		}
	}
	return false;
}

/**
 * Executes a web search using Anthropic's Anthropic model with built-in web search tool.
 * @param params - Search parameters including query and optional settings
 * @returns Search response with synthesized answer, sources, and citations
 * @throws {Error} If no Anthropic credentials are configured
 */
export async function searchAnthropic(
	params: SearchParams | AnthropicSearchParams,
	_legacyStorage?: unknown,
): Promise<SearchResponse> {
	const searchApiKey = $env.ANTHROPIC_SEARCH_API_KEY;
	const searchBaseUrl = $env.ANTHROPIC_SEARCH_BASE_URL;
	let auth: AnthropicAuthConfig | undefined;
	// When reusing the active model's own credentials (native search over a
	// proxy), prefer its wire model id and carry its request headers through.
	let modelOverride: string | undefined;
	let extraHeaders: Record<string, string> | undefined;

	if (searchApiKey) {
		auth = buildAnthropicAuthConfig(searchApiKey, searchBaseUrl);
	} else if ("authStorage" in params) {
		const apiKey = await params.authStorage.getApiKey("anthropic", params.sessionId, {
			signal: params.signal,
		});
		if (apiKey) auth = buildAnthropicAuthConfig(apiKey);

		// Fall back to the active model's own credentials + baseUrl when no
		// canonical Anthropic key exists but the active model speaks the
		// Anthropic wire (e.g. Claude served through a proxy).
		const ctx = params.activeModelContext;
		if (!auth && ctx && ctx.api === "anthropic-messages") {
			const ctxKey = await params.authStorage.getApiKey(ctx.provider, params.sessionId, {
				baseUrl: ctx.baseUrl,
				modelId: ctx.modelId,
				signal: params.signal,
			});
			if (ctxKey) {
				auth = buildAnthropicAuthConfig(ctxKey, ctx.baseUrl);
				modelOverride = ctx.wireModelId ?? ctx.modelId;
				extraHeaders = ctx.headers;
			}
		}
	}

	if (!auth) {
		throw new Error(
			"No Anthropic credentials found. Set ANTHROPIC_SEARCH_API_KEY or ANTHROPIC_API_KEY, or configure Anthropic OAuth.",
		);
	}

	const model = modelOverride ?? getModel();
	const systemPrompt = "authStorage" in params ? params.systemPrompt : params.system_prompt;
	const maxTokens = "authStorage" in params ? params.maxOutputTokens : params.max_tokens;
	const response = await callSearch(
		auth,
		model,
		params.query,
		systemPrompt,
		maxTokens,
		params.temperature,
		params.signal,
		extraHeaders,
	);

	const result = parseResponse(response);
	const searched = anthropicSearchPerformed(response);

	// When a search ran but the model wrote its citations inline instead of as
	// structured `web_search_result_location` blocks, recover sources from the
	// answer text so a genuinely grounded result is not discarded.
	if (result.sources.length === 0 && searched && result.answer) {
		const inline = extractTextSources(result.answer);
		if (inline.length > 0) result.sources = inline;
	}

	// Fail closed so the chain falls through to DuckDuckGo when Claude answered
	// from stable knowledge without running a web search.
	if (result.sources.length === 0 && !(result.citations && result.citations.length > 0) && !searched) {
		throw new SearchProviderError("anthropic", "Anthropic web search returned no grounded sources", 424);
	}

	const numResults = "authStorage" in params ? (params.numSearchResults ?? params.limit) : params.num_results;
	if (numResults && result.sources.length > numResults) {
		result.sources = result.sources.slice(0, numResults);
	}

	return result;
}

/** Search provider for Anthropic Anthropic model web search. */
export class AnthropicProvider extends SearchProvider {
	readonly id = "anthropic";
	readonly label = "Anthropic";

	isAvailable(authStorage: AuthStorage): Promise<boolean> | boolean {
		return Boolean($env.ANTHROPIC_SEARCH_API_KEY) || authStorage.hasAuth("anthropic");
	}

	search(params: SearchParams): Promise<SearchResponse> {
		return searchAnthropic(params);
	}
}
