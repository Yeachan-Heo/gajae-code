/**
 * Unified Web Search Tool
 *
 * Single tool supporting Anthropic, Perplexity, Exa, Brave, Jina, Kimi, Gemini, OpenAI code backend, xAI, Tavily, Kagi, Z.AI, SearXNG, and Synthetic
 * providers with provider-specific parameters exposed conditionally.
 */
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@gajae-code/agent-core";
import type { AuthStorage } from "@gajae-code/ai";
import { prompt } from "@gajae-code/utils";
import * as z from "zod/v4";
import type { CustomTool, CustomToolContext, RenderResultOptions } from "../../extensibility/custom-tools/types";
import type { Theme } from "../../modes/theme/theme";
import webSearchSystemPrompt from "../../prompts/system/web-search.md" with { type: "text" };
import webSearchDescription from "../../prompts/tools/web-search.md" with { type: "text" };
import { discoverAuthStorage } from "../../sdk";
import type { ToolSession } from "../../tools";
import { formatAge } from "../../tools/render-utils";
import { throwIfAborted } from "../../tools/tool-errors";
import { getSearchProviderLabel, prewarmSearchProviders, resolveProviderChain, type SearchProvider } from "./provider";
import { renderSearchCall, renderSearchResult, type SearchRenderDetails } from "./render";
import type { ActiveSearchModelContext, SearchProviderId, SearchResponse } from "./types";
import { SearchProviderError } from "./types";

/** Web search tool parameters schema */
export const webSearchSchema = z.object({
	query: z.string().describe("search query"),
	recency: z.enum(["day", "week", "month", "year"]).describe("recency filter").optional(),
	limit: z.number().describe("max results").optional(),
	max_tokens: z.number().describe("max output tokens").optional(),
	temperature: z.number().describe("sampling temperature").optional(),
	num_search_results: z.number().describe("number of search results").optional(),
	xai_search_mode: z
		.enum(["web", "x", "web_and_x"])
		.describe("xAI only: use web_search, x_search, or both")
		.optional(),
	allowed_domains: z.array(z.string()).max(5).describe("xAI web_search only: allowed domains").optional(),
	excluded_domains: z.array(z.string()).max(5).describe("xAI web_search only: excluded domains").optional(),
	allowed_x_handles: z.array(z.string()).max(20).describe("xAI x_search only: allowed X handles").optional(),
	excluded_x_handles: z.array(z.string()).max(20).describe("xAI x_search only: excluded X handles").optional(),
	from_date: z.string().describe("xAI x_search only: start date in ISO8601 format").optional(),
	to_date: z.string().describe("xAI x_search only: end date in ISO8601 format").optional(),
	enable_image_understanding: z.boolean().describe("xAI only: analyze images encountered during search").optional(),
	enable_image_search: z.boolean().describe("xAI web_search only: search for and embed image results").optional(),
	enable_video_understanding: z.boolean().describe("xAI x_search only: analyze videos in X posts").optional(),
	no_inline_citations: z.boolean().describe("xAI only: disable inline citation markdown in the answer").optional(),
});

export type SearchToolParams = z.infer<typeof webSearchSchema>;

export interface SearchQueryParams extends SearchToolParams {
	provider?: SearchProviderId | "auto";
}

function formatProviderError(error: unknown, provider: SearchProvider): string {
	if (error instanceof SearchProviderError) {
		if (error.provider === "anthropic" && error.status === 404) {
			return "Anthropic web search returned 404 (model or endpoint not found).";
		}
		if (error.status === 401 || error.status === 403) {
			if (error.provider === "zai") {
				return error.message;
			}
			return `${getSearchProviderLabel(error.provider)} authorization failed (${error.status}). Check API key or base URL.`;
		}
		return error.message;
	}
	if (error instanceof Error) return error.message;
	return `Unknown error from ${provider.label}`;
}

function formatProviderFailure(error: unknown, provider: SearchProvider): string {
	if (error instanceof SearchProviderError) return error.message;
	return `${provider.id}: ${formatProviderError(error, provider)}`;
}

function formatFallbackWarning(
	failures: Array<{ provider: SearchProvider; error: unknown }>,
	provider: SearchProvider,
): string {
	return `Web search provider fallback: ${failures.map(f => formatProviderFailure(f.error, f.provider)).join("; ")}; using ${provider.label}.`;
}

/** Truncate text for tool output */
function truncateText(text: string, maxLen: number): string {
	if (text.length <= maxLen) return text;
	return `${text.slice(0, Math.max(0, maxLen - 1))}…`;
}

function formatCount(label: string, count: number): string {
	return `${count} ${label}${count === 1 ? "" : "s"}`;
}

/** Format response for LLM consumption */
export function formatSearchResponseForLlm(response: SearchResponse): string {
	const parts: string[] = [];

	if (response.answer) {
		parts.push(response.answer);
		if (response.sources.length > 0) {
			parts.push("\n## Sources");
			parts.push(formatCount("source", response.sources.length));
		}
	}

	for (const [i, src] of response.sources.entries()) {
		const age = formatAge(src.ageSeconds) || src.publishedDate;
		const agePart = age ? ` (${age})` : "";
		parts.push(`[${i + 1}] ${src.title}${agePart}\n    ${src.url}`);
		if (src.snippet) {
			parts.push(`    ${truncateText(src.snippet, 240)}`);
		}
	}

	if (response.citations && response.citations.length > 0) {
		parts.push("\n## Citations");
		parts.push(formatCount("citation", response.citations.length));
		for (const [i, citation] of response.citations.entries()) {
			const title = citation.title || citation.url;
			parts.push(`[${i + 1}] ${title}\n    ${citation.url}`);
			if (citation.citedText) {
				parts.push(`    ${truncateText(citation.citedText, 240)}`);
			}
		}
	}

	if (response.relatedQuestions && response.relatedQuestions.length > 0) {
		parts.push("\n## Related");
		parts.push(formatCount("question", response.relatedQuestions.length));
		for (const q of response.relatedQuestions) {
			parts.push(`- ${q}`);
		}
	}

	if (response.searchQueries && response.searchQueries.length > 0) {
		parts.push(`Search queries: ${response.searchQueries.length}`);
		for (const query of response.searchQueries.slice(0, 3)) {
			parts.push(`- ${truncateText(query, 120)}`);
		}
	}

	return `<untrusted-content>\n${parts.join("\n").replace(/<\/untrusted-content>/gi, "&lt;/untrusted-content>")}\n</untrusted-content>`;
}

interface ExecuteSearchOptions {
	authStorage: AuthStorage;
	sessionId?: string;
	signal?: AbortSignal;
	activeModelContext?: ActiveSearchModelContext;
}

/**
 * Delay before the keyless DuckDuckGo hedge fires while a slower primary is
 * still in flight. Chosen to be comfortably above DDG's typical ~1-2s
 * round-trip cost budget yet far below LLM-mediated primary latency, so a
 * failing primary can fall back to an already-completed hedge result instead
 * of paying primary-failure time plus DDG time sequentially.
 */
const DDG_HEDGE_DELAY_MS = 3_000;

let ddgHedgeDelayMs = DDG_HEDGE_DELAY_MS;

/** Override the hedge delay (tests). Non-finite/non-positive resets to default. */
export function setDdgHedgeDelayMs(ms: number | undefined): void {
	ddgHedgeDelayMs = typeof ms === "number" && Number.isFinite(ms) && ms > 0 ? ms : DDG_HEDGE_DELAY_MS;
}

/** Execute web search */
async function executeSearch(
	_toolCallId: string,
	params: SearchQueryParams,
	options: ExecuteSearchOptions,
): Promise<{ content: Array<{ type: "text"; text: string }>; details: SearchRenderDetails }> {
	const { authStorage, sessionId, signal, activeModelContext } = options;
	// Pass `params.provider` straight through: when omitted (the normal model-facing
	// path) it is `undefined`, so `resolveProviderChain` applies the settings-configured
	// preferred provider. Coalescing to "auto" here would silently bypass that preference.
	const providers = await resolveProviderChain({
		authStorage,
		sessionId,
		signal,
		preferredProvider: params.provider,
		activeModelContext,
	});

	const baseSearchParams = {
		query: params.query.replace(/202\d/g, String(new Date().getFullYear())), // LUL
		limit: params.limit,
		recency: params.recency,
		systemPrompt: webSearchSystemPrompt,
		maxOutputTokens: params.max_tokens,
		numSearchResults: params.num_search_results,
		temperature: params.temperature,
		xaiSearchMode: params.xai_search_mode,
		allowedDomains: params.allowed_domains,
		excludedDomains: params.excluded_domains,
		allowedXHandles: params.allowed_x_handles,
		excludedXHandles: params.excluded_x_handles,
		fromDate: params.from_date,
		toDate: params.to_date,
		enableImageUnderstanding: params.enable_image_understanding,
		enableImageSearch: params.enable_image_search,
		enableVideoUnderstanding: params.enable_video_understanding,
		noInlineCitations: params.no_inline_citations,
		authStorage,
		sessionId,
		activeModelContext,
	};

	// Hedged fallback: when DuckDuckGo (keyless, cheap) is a non-primary member
	// of the chain, start it in the background after a short delay. If the
	// primary succeeds first the hedge is aborted; if the primary fails, the
	// hedge result is typically already available, collapsing the fallback
	// latency from `t(primary failure) + t(ddg)` to `max(t(primary failure), t(ddg))`.
	const ddgIndex = providers.findIndex(p => p.id === "duckduckgo");
	const hedgeCtl = new AbortController();
	const onUpstreamAbort = () => hedgeCtl.abort();
	signal?.addEventListener("abort", onUpstreamAbort, { once: true });
	let hedgePromise: Promise<SearchResponse> | undefined;
	let hedgeTimer: NodeJS.Timeout | undefined;
	if (ddgIndex > 0) {
		const ddg = providers[ddgIndex]!;
		hedgeTimer = setTimeout(() => {
			hedgePromise = ddg.search({ ...baseSearchParams, signal: hedgeCtl.signal });
			// Failures are consumed when (and if) the loop reaches DuckDuckGo;
			// never let a losing hedge become an unhandled rejection.
			hedgePromise.catch(() => {});
		}, ddgHedgeDelayMs);
	}
	const cancelHedge = () => {
		if (hedgeTimer !== undefined) clearTimeout(hedgeTimer);
		hedgeCtl.abort();
		signal?.removeEventListener("abort", onUpstreamAbort);
	};

	const failures: Array<{ provider: SearchProvider; error: unknown }> = [];
	let lastProvider = providers[0];
	try {
		for (const provider of providers) {
			lastProvider = provider;
			try {
				let response: SearchResponse;
				if (provider.id === "duckduckgo" && hedgePromise) {
					// Reuse the in-flight (often already-settled) hedge request.
					if (hedgeTimer !== undefined) clearTimeout(hedgeTimer);
					response = await hedgePromise;
				} else {
					if (provider.id === "duckduckgo" && hedgeTimer !== undefined) clearTimeout(hedgeTimer);
					response = await provider.search({ ...baseSearchParams, signal });
				}

				const text = formatSearchResponseForLlm(response);
				const warning = failures.length > 0 ? formatFallbackWarning(failures, provider) : undefined;

				return {
					content: [{ type: "text" as const, text: warning ? `Warning: ${warning}\n\n${text}` : text }],
					details: { response, ...(warning ? { warning } : {}) },
				};
			} catch (error) {
				// Surface user-initiated cancellation immediately so the session sees
				// a clean abort instead of a generic "all providers failed" message.
				// Without this, an AbortError from `fetch()` is treated as a provider
				// failure and the loop falls through to the next provider (or to the
				// summary error), masking the cancellation.
				throwIfAborted(signal);
				failures.push({ provider, error });
			}
		}
	} finally {
		cancelHedge();
	}

	const lastFailure = failures[failures.length - 1];
	const baseMessage = lastFailure
		? formatProviderError(lastFailure.error, lastFailure.provider)
		: `Unknown error from ${lastProvider.label}`;
	const message =
		providers.length > 1
			? `All web search providers failed: ${failures.map(f => formatProviderFailure(f.error, f.provider)).join("; ")}`
			: baseMessage;

	return {
		content: [{ type: "text" as const, text: `Error: ${message}` }],
		details: { response: { provider: lastProvider.id, sources: [] }, error: message },
	};
}

/**
 * Execute a web search query for CLI/testing workflows.
 *
 * `authStorage` may be omitted; in that case we discover one via the standard
 * factory (`discoverAuthStorage`), which honours `GJC_AUTH_BROKER_URL` and
 * otherwise opens the local SQLite credential store.
 */
export async function runSearchQuery(
	params: SearchQueryParams,
	options: {
		authStorage?: AuthStorage;
		sessionId?: string;
		signal?: AbortSignal;
		activeModelContext?: ActiveSearchModelContext;
	} = {},
): Promise<{ content: Array<{ type: "text"; text: string }>; details: SearchRenderDetails }> {
	const authStorage = options.authStorage ?? (await discoverAuthStorage());
	return executeSearch("cli-web-search", params, {
		authStorage,
		sessionId: options.sessionId,
		signal: options.signal,
		activeModelContext: options.activeModelContext,
	});
}

/**
 * Web search tool implementation.
 *
 * Supports Anthropic, Perplexity, Exa, Brave, Jina, Kimi, Gemini, OpenAI code backend, xAI, Z.AI, SearXNG, and Synthetic providers with automatic fallback.
 */
export class WebSearchTool implements AgentTool<typeof webSearchSchema, SearchRenderDetails> {
	readonly name = "web_search";
	readonly label = "Web Search";
	readonly description: string;
	readonly parameters = webSearchSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "Search the web for up-to-date information";

	#session: ToolSession;

	constructor(session: ToolSession) {
		this.#session = session;
		this.description = prompt.render(webSearchDescription);
		// Prewarm: resolve the provider chain once in the background so the
		// provider modules are imported and the chain cache is primed before
		// the first user-visible search. Best-effort only.
		const authStorage = session.authStorage;
		if (authStorage) {
			try {
				const activeModelContext = session.model
					? session.modelRegistry?.getActiveSearchModelContext(session.model)
					: undefined;
				prewarmSearchProviders({
					authStorage,
					sessionId: session.getSessionId?.() ?? undefined,
					activeModelContext,
				});
			} catch {
				// Never let prewarming break tool construction.
			}
		}
	}

	async execute(
		_toolCallId: string,
		params: SearchToolParams,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<SearchRenderDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<SearchRenderDetails>> {
		const authStorage = this.#session.authStorage ?? (await discoverAuthStorage());
		const sessionId = this.#session.getSessionId?.() ?? undefined;
		const activeModelContext = this.#session.model
			? this.#session.modelRegistry?.getActiveSearchModelContext(this.#session.model)
			: undefined;
		return executeSearch(_toolCallId, params, { authStorage, sessionId, signal, activeModelContext });
	}
}

/** Web search tool as CustomTool (for TUI rendering support) */
export const webSearchCustomTool: CustomTool<typeof webSearchSchema, SearchRenderDetails> = {
	name: "web_search",
	label: "Web Search",
	description: prompt.render(webSearchDescription),
	parameters: webSearchSchema,

	async execute(
		toolCallId: string,
		params: SearchToolParams,
		_onUpdate,
		ctx: CustomToolContext,
		signal?: AbortSignal,
	) {
		const authStorage = ctx.modelRegistry?.authStorage ?? (await discoverAuthStorage());
		const sessionId = ctx.sessionManager.getSessionId();
		return executeSearch(toolCallId, params, {
			authStorage,
			sessionId,
			signal,
			activeModelContext: ctx.model ? ctx.modelRegistry?.getActiveSearchModelContext(ctx.model) : undefined,
		});
	},

	renderCall(args: SearchToolParams, options: RenderResultOptions, theme: Theme) {
		return renderSearchCall(args, options, theme);
	},

	renderResult(result, options: RenderResultOptions, theme: Theme) {
		return renderSearchResult(result, options, theme);
	},
};

export function getSearchTools(): CustomTool<any, any>[] {
	return [webSearchCustomTool];
}

export {
	getConfiguredSearchProviderPreference,
	getSearchProvider,
	setPreferredSearchProvider,
	setSearchFallbackProviders,
} from "./provider";
export { applyConfiguredSearchTimeout, setSearchHardTimeoutMs } from "./providers/utils";
export type { SearchProviderId as SearchProvider, SearchResponse } from "./types";
export { isConfigurableSearchProviderId, isSearchProviderPreference } from "./types";
