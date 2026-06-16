import type { AuthStorage } from "@gajae-code/ai";
import type { ActiveSearchModelContext, SearchProviderId, SearchResponse } from "../types";

/**
 * Shared web search parameters passed to providers.
 *
 * `authStorage` is the **only** credential source providers may consult.
 * Opening a sibling SQLite handle or calling provider-direct refresh helpers
 * (e.g. `refreshOpenAIOpenAI code backendToken`, `refreshGoogleCloudToken`) is prohibited:
 * it races the broker's per-credential refresh and POSTs the broker sentinel
 * (`REMOTE_REFRESH_SENTINEL`) to the upstream token endpoint, which classifies
 * as `invalid_grant` and disables the row.
 */
export interface SearchParams {
	query: string;
	limit?: number;
	/**
	 * Temporal filter narrowing results to the specified time window.
	 *
	 * Providers MUST interpret this as a pure time filter. Providers MUST NOT
	 * use recency as an implicit signal to change topic scope, content domain,
	 * or ranking strategy. If a provider API couples temporal filtering with
	 * other dimensions (e.g. Tavily's `topic=news`), the provider implementation
	 * is responsible for decoupling them before calling the upstream API.
	 *
	 * Providers that do not support temporal filtering MUST ignore this field
	 * silently; they MUST NOT approximate it by rewriting the query or altering
	 * any other request parameter.
	 */
	recency?: "day" | "week" | "month" | "year";
	systemPrompt: string;
	signal?: AbortSignal;
	maxOutputTokens?: number;
	numSearchResults?: number;
	temperature?: number;
	/** xAI-specific search surface. Defaults to web_search when omitted. */
	xaiSearchMode?: "web" | "x" | "web_and_x";
	/** xAI web_search domain allow-list (max 5). */
	allowedDomains?: string[];
	/** xAI web_search domain deny-list (max 5). */
	excludedDomains?: string[];
	/** xAI x_search handle allow-list (max 20). */
	allowedXHandles?: string[];
	/** xAI x_search handle deny-list (max 20). */
	excludedXHandles?: string[];
	/** xAI x_search lower date bound, ISO8601 date such as YYYY-MM-DD. */
	fromDate?: string;
	/** xAI x_search upper date bound, ISO8601 date such as YYYY-MM-DD. */
	toDate?: string;
	/** xAI web_search/x_search image understanding. */
	enableImageUnderstanding?: boolean;
	/** xAI web_search image search result embedding. */
	enableImageSearch?: boolean;
	/** xAI x_search video understanding. */
	enableVideoUnderstanding?: boolean;
	/** xAI Responses include=["no_inline_citations"]. */
	noInlineCitations?: boolean;
	googleSearch?: Record<string, unknown>;
	codeExecution?: Record<string, unknown>;
	urlContext?: Record<string, unknown>;
	/**
	 * The single source of truth for credentials. Providers MUST consult this
	 * handle exclusively (`getApiKey` for bearer-style auth, `getOAuthAccess`
	 * when identity metadata is required). Do not open `AgentStorage` or any
	 * `AuthCredentialStore` directly — that bypasses the broker pipeline and
	 * the per-credential single-flight refresh.
	 */
	authStorage: AuthStorage;
	/**
	 * Optional session id used as the round-robin / sticky key when selecting
	 * among multiple credentials for the same provider. Pass through from the
	 * caller's agent session when available; otherwise omit.
	 */
	sessionId?: string;
	activeModelContext?: ActiveSearchModelContext;
}

/** Base class for web search providers. */
export abstract class SearchProvider {
	abstract readonly id: SearchProviderId;
	abstract readonly label: string;

	/**
	 * Indicates whether this provider has the credentials/config it needs to
	 * service a request right now. Implementations consult the passed
	 * {@link AuthStorage} — never a sibling store.
	 */
	abstract isAvailable(authStorage: AuthStorage): Promise<boolean> | boolean;

	/**
	 * Execute a search. Credentials MUST be resolved through `params.authStorage`.
	 */
	abstract search(params: SearchParams): Promise<SearchResponse>;
}
