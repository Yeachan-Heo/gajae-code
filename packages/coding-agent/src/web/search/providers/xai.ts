/**
 * xAI Web/X Search Provider
 *
 * Uses xAI's Responses API with the built-in web_search and x_search tools.
 * Endpoint: POST https://api.x.ai/v1/responses
 */
import type { AuthStorage } from "@gajae-code/ai";
import { $env } from "@gajae-code/utils";
import type { SearchCitation, SearchResponse, SearchSource, SearchUsage } from "../../../web/search/types";
import { SearchProviderError } from "../../../web/search/types";
import type { SearchParams } from "./base";
import { SearchProvider } from "./base";
import { classifyProviderHttpError, withHardTimeout } from "./utils";

const DEFAULT_BASE_URL = "https://api.x.ai/v1";
const DEFAULT_MODEL = "grok-4.3";
const DEFAULT_NUM_RESULTS = 10;
const MAX_WEB_DOMAINS = 5;
const MAX_X_HANDLES = 20;
const XAI_SEARCH_MODES = ["web", "x", "web_and_x"] as const;

const RECENCY_DAYS: Record<NonNullable<XaiSearchParams["recency"]>, number> = {
	day: 1,
	week: 7,
	month: 30,
	year: 365,
};

export type XaiSearchMode = (typeof XAI_SEARCH_MODES)[number];

export interface XaiSearchParams {
	query: string;
	system_prompt?: string;
	num_results?: number;
	max_output_tokens?: number;
	temperature?: number;
	recency?: "day" | "week" | "month" | "year";
	xai_search_mode?: XaiSearchMode;
	allowed_domains?: string[];
	excluded_domains?: string[];
	allowed_x_handles?: string[];
	excluded_x_handles?: string[];
	from_date?: string;
	to_date?: string;
	enable_image_understanding?: boolean;
	enable_image_search?: boolean;
	enable_video_understanding?: boolean;
	no_inline_citations?: boolean;
	signal?: AbortSignal;
	authStorage: AuthStorage;
	sessionId?: string;
}

interface XaiAuth {
	bearer: string;
	mode: "api_key" | "oauth";
}

interface PreparedXaiTools {
	tools: Array<Record<string, unknown>>;
	include?: string[];
}

function asTrimmed(value: string | undefined): string | undefined {
	if (!value) return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function getModel(): string {
	return asTrimmed($env.PI_XAI_WEB_SEARCH_MODEL) ?? asTrimmed($env.XAI_WEB_SEARCH_MODEL) ?? DEFAULT_MODEL;
}

function getBaseUrl(): string {
	return asTrimmed($env.XAI_SEARCH_BASE_URL) ?? DEFAULT_BASE_URL;
}

function responsesEndpoint(): string {
	return `${getBaseUrl().replace(/\/+$/, "")}/responses`;
}

async function resolveXaiAuth(
	authStorage: AuthStorage,
	sessionId: string | undefined,
	model: string,
	signal: AbortSignal | undefined,
): Promise<XaiAuth | null> {
	const credentialSessionId = sessionId ?? `xai-search:${crypto.randomUUID()}`;
	const bearer = await authStorage.getApiKey("xai", credentialSessionId, {
		baseUrl: getBaseUrl(),
		modelId: model,
		signal,
	});
	if (!bearer) return null;

	// getApiKey records the selected credential type for session-scoped calls.
	// Do not call getOAuthAccess here: when an API-key credential wins, resolving
	// OAuth solely for labelling would refresh/record the wrong credential.
	const selectedType = authStorage.getSessionCredentialType("xai", credentialSessionId);
	return { bearer, mode: selectedType === "oauth" ? "oauth" : "api_key" };
}

function normalizeDomain(value: string): string {
	const trimmed = value.trim();
	if (!trimmed) return "";
	const withoutWildcard = trimmed.replace(/^\*\./, "");
	try {
		const url = new URL(
			/^[a-z][a-z0-9+.-]*:\/\//i.test(withoutWildcard) ? withoutWildcard : `https://${withoutWildcard}`,
		);
		return url.hostname.toLowerCase();
	} catch {
		return withoutWildcard.split("/")[0]?.toLowerCase() ?? "";
	}
}

function normalizeXHandle(value: string): string {
	return value.trim().replace(/^@+/, "");
}

function normalizeList(
	values: string[] | undefined,
	label: string,
	max: number,
	normalize: (value: string) => string,
): string[] | undefined {
	if (!values) return undefined;
	const out: string[] = [];
	const seen = new Set<string>();
	for (const value of values) {
		if (typeof value !== "string") continue;
		const normalized = normalize(value);
		if (!normalized || seen.has(normalized)) continue;
		seen.add(normalized);
		out.push(normalized);
	}
	if (out.length > max) {
		throw new SearchProviderError("xai", `xAI ${label} supports at most ${max} entries`, 400);
	}
	return out.length > 0 ? out : undefined;
}

function assertNotBoth(
	leftName: string,
	left: unknown[] | undefined,
	rightName: string,
	right: unknown[] | undefined,
): void {
	if (left?.length && right?.length) {
		throw new SearchProviderError("xai", `xAI ${leftName} cannot be set together with ${rightName}`, 400);
	}
}

function formatUtcDate(date: Date): string {
	return date.toISOString().slice(0, 10);
}

function dateDaysAgo(days: number): string {
	const date = new Date();
	date.setUTCDate(date.getUTCDate() - days);
	return formatUtcDate(date);
}

function xDateRange(params: { recency?: XaiSearchParams["recency"]; fromDate?: string; toDate?: string }): {
	fromDate?: string;
	toDate?: string;
} {
	const fromDate =
		asTrimmed(params.fromDate) ?? (params.recency ? dateDaysAgo(RECENCY_DAYS[params.recency]) : undefined);
	const toDate = asTrimmed(params.toDate) ?? (params.recency ? formatUtcDate(new Date()) : undefined);
	return { fromDate, toDate };
}

function prepareXaiTools(params: {
	xaiSearchMode?: XaiSearchMode;
	recency?: XaiSearchParams["recency"];
	allowedDomains?: string[];
	excludedDomains?: string[];
	allowedXHandles?: string[];
	excludedXHandles?: string[];
	fromDate?: string;
	toDate?: string;
	enableImageUnderstanding?: boolean;
	enableImageSearch?: boolean;
	enableVideoUnderstanding?: boolean;
	noInlineCitations?: boolean;
}): PreparedXaiTools {
	if (params.xaiSearchMode && !(XAI_SEARCH_MODES as readonly string[]).includes(params.xaiSearchMode)) {
		throw new SearchProviderError("xai", `Invalid xAI search mode: ${params.xaiSearchMode}`, 400);
	}
	const allowedDomains = normalizeList(params.allowedDomains, "allowed_domains", MAX_WEB_DOMAINS, normalizeDomain);
	const excludedDomains = normalizeList(params.excludedDomains, "excluded_domains", MAX_WEB_DOMAINS, normalizeDomain);
	const allowedXHandles = normalizeList(params.allowedXHandles, "allowed_x_handles", MAX_X_HANDLES, normalizeXHandle);
	const excludedXHandles = normalizeList(
		params.excludedXHandles,
		"excluded_x_handles",
		MAX_X_HANDLES,
		normalizeXHandle,
	);
	assertNotBoth("allowed_domains", allowedDomains, "excluded_domains", excludedDomains);
	assertNotBoth("allowed_x_handles", allowedXHandles, "excluded_x_handles", excludedXHandles);

	const hasWebOnlyOptions = Boolean(
		allowedDomains?.length || excludedDomains?.length || params.enableImageSearch === true,
	);
	const hasXOnlyOptions = Boolean(
		allowedXHandles?.length ||
			excludedXHandles?.length ||
			asTrimmed(params.fromDate) ||
			asTrimmed(params.toDate) ||
			params.enableVideoUnderstanding === true,
	);
	const mode =
		params.xaiSearchMode ?? (hasWebOnlyOptions && hasXOnlyOptions ? "web_and_x" : hasXOnlyOptions ? "x" : "web");

	if (mode === "web" && hasXOnlyOptions) {
		throw new SearchProviderError("xai", "xAI X Search options require xai_search_mode='x' or 'web_and_x'", 400);
	}
	if (mode === "x" && hasWebOnlyOptions) {
		throw new SearchProviderError("xai", "xAI Web Search options require xai_search_mode='web' or 'web_and_x'", 400);
	}

	const tools: Array<Record<string, unknown>> = [];
	if (mode === "web" || mode === "web_and_x") {
		const tool: Record<string, unknown> = { type: "web_search" };
		const filters: Record<string, unknown> = {};
		if (allowedDomains) filters.allowed_domains = allowedDomains;
		if (excludedDomains) filters.excluded_domains = excludedDomains;
		if (Object.keys(filters).length > 0) tool.filters = filters;
		if (params.enableImageUnderstanding !== undefined)
			tool.enable_image_understanding = params.enableImageUnderstanding;
		if (params.enableImageSearch !== undefined) tool.enable_image_search = params.enableImageSearch;
		tools.push(tool);
	}
	if (mode === "x" || mode === "web_and_x") {
		const tool: Record<string, unknown> = { type: "x_search" };
		if (allowedXHandles) tool.allowed_x_handles = allowedXHandles;
		if (excludedXHandles) tool.excluded_x_handles = excludedXHandles;
		const { fromDate, toDate } = xDateRange({
			recency: params.recency,
			fromDate: params.fromDate,
			toDate: params.toDate,
		});
		if (fromDate) tool.from_date = fromDate;
		if (toDate) tool.to_date = toDate;
		if (params.enableImageUnderstanding !== undefined)
			tool.enable_image_understanding = params.enableImageUnderstanding;
		if (params.enableVideoUnderstanding !== undefined)
			tool.enable_video_understanding = params.enableVideoUnderstanding;
		tools.push(tool);
	}

	return { tools, include: params.noInlineCitations ? ["no_inline_citations"] : undefined };
}

export function buildXaiRequestBody(params: {
	query: string;
	systemPrompt: string;
	model: string;
	maxOutputTokens?: number;
	temperature?: number;
	recency?: XaiSearchParams["recency"];
	xaiSearchMode?: XaiSearchMode;
	allowedDomains?: string[];
	excludedDomains?: string[];
	allowedXHandles?: string[];
	excludedXHandles?: string[];
	fromDate?: string;
	toDate?: string;
	enableImageUnderstanding?: boolean;
	enableImageSearch?: boolean;
	enableVideoUnderstanding?: boolean;
	noInlineCitations?: boolean;
}): Record<string, unknown> {
	const prepared = prepareXaiTools(params);
	const body: Record<string, unknown> = {
		model: params.model,
		input: [
			{ role: "system", content: params.systemPrompt },
			{ role: "user", content: params.query },
		],
		tools: prepared.tools,
	};
	if (prepared.include) body.include = prepared.include;
	if (params.temperature !== undefined) body.temperature = params.temperature;
	if (params.maxOutputTokens !== undefined) body.max_output_tokens = params.maxOutputTokens;
	return body;
}

function textFromResponse(json: any): string | undefined {
	if (typeof json?.output_text === "string" && json.output_text.trim().length > 0) return json.output_text;
	const chunks: string[] = [];
	for (const item of json?.output ?? []) {
		for (const content of item?.content ?? []) {
			if (typeof content?.text === "string" && content.text.length > 0) chunks.push(content.text);
		}
	}
	return chunks.join("\n").trim() || undefined;
}

function pushCitation(out: SearchCitation[], rawUrl: unknown, rawTitle: unknown, rawText: unknown): void {
	if (typeof rawUrl !== "string") return;
	const url = rawUrl.trim();
	if (!url) return;
	const title = typeof rawTitle === "string" ? rawTitle.trim() : "";
	out.push({
		url,
		title: title && !/^\d+$/.test(title) ? title : url,
		citedText: typeof rawText === "string" && rawText.trim() ? rawText : undefined,
	});
}

function collectCitationAnnotations(annotations: unknown, out: SearchCitation[]): void {
	if (!Array.isArray(annotations)) return;
	for (const annotation of annotations) {
		if (!annotation || typeof annotation !== "object") continue;
		const ann = annotation as Record<string, any>;
		if (ann.type !== "url_citation") continue;
		const citation = ann.url_citation && typeof ann.url_citation === "object" ? ann.url_citation : ann;
		pushCitation(out, citation.url ?? citation.uri, citation.title, citation.text ?? citation.quote ?? ann.text);
	}
}

function collectTopLevelCitations(citations: unknown, out: SearchCitation[]): void {
	if (!Array.isArray(citations)) return;
	for (const citation of citations) {
		if (typeof citation === "string") {
			pushCitation(out, citation, undefined, undefined);
			continue;
		}
		if (!citation || typeof citation !== "object") continue;
		const record = citation as Record<string, unknown>;
		pushCitation(out, record.url ?? record.uri, record.title, record.text ?? record.quote ?? record.snippet);
	}
}

export function parseXaiCitations(json: any): SearchCitation[] {
	const citations: SearchCitation[] = [];
	for (const item of json?.output ?? []) {
		for (const content of item?.content ?? []) {
			collectCitationAnnotations(content?.annotations, citations);
		}
	}
	collectTopLevelCitations(json?.citations, citations);

	const seen = new Set<string>();
	return citations.filter(citation => {
		if (seen.has(citation.url)) return false;
		seen.add(citation.url);
		return true;
	});
}

function toSources(citations: SearchCitation[], limit: number): SearchSource[] {
	return citations.slice(0, limit).map(citation => ({
		title: citation.title || citation.url,
		url: citation.url,
		snippet: citation.citedText,
	}));
}

function numericUsage(record: unknown, ...keys: string[]): number | undefined {
	if (!record || typeof record !== "object") return undefined;
	const values = record as Record<string, unknown>;
	for (const key of keys) {
		const value = values[key];
		if (typeof value === "number") return value;
	}
	return undefined;
}

function positiveUsage(record: unknown, ...keys: string[]): number | undefined {
	const value = numericUsage(record, ...keys);
	return value && value > 0 ? value : undefined;
}

function parseUsage(json: any): SearchUsage | undefined {
	const usage = json?.usage;
	const toolUsage =
		usage?.server_side_tool_usage_details ??
		usage?.server_side_tool_usage ??
		json?.server_side_tool_usage_details ??
		json?.server_side_tool_usage;
	if ((!usage || typeof usage !== "object") && (!toolUsage || typeof toolUsage !== "object")) return undefined;

	const parsed: SearchUsage = {
		inputTokens: typeof usage?.input_tokens === "number" ? usage.input_tokens : undefined,
		outputTokens: typeof usage?.output_tokens === "number" ? usage.output_tokens : undefined,
		totalTokens: typeof usage?.total_tokens === "number" ? usage.total_tokens : undefined,
		searchRequests: positiveUsage(toolUsage, "web_search_calls", "SERVER_SIDE_TOOL_WEB_SEARCH"),
		xSearchRequests: positiveUsage(toolUsage, "x_search_calls", "SERVER_SIDE_TOOL_X_SEARCH"),
		imageSearchRequests: positiveUsage(toolUsage, "image_search_calls", "SERVER_SIDE_TOOL_IMAGE_SEARCH"),
		imageUnderstandingRequests: positiveUsage(toolUsage, "view_image_calls", "SERVER_SIDE_TOOL_VIEW_IMAGE"),
		videoUnderstandingRequests: positiveUsage(
			toolUsage,
			"video_understanding_calls",
			"SERVER_SIDE_TOOL_VIEW_VIDEO",
			"SERVER_SIDE_TOOL_VIEW_X_VIDEO",
		),
	};

	return Object.values(parsed).some(value => value !== undefined) ? parsed : undefined;
}

/** Execute xAI web/X search through the Responses API search tools. */
export async function searchXai(params: XaiSearchParams): Promise<SearchResponse> {
	const model = getModel();
	const auth = await resolveXaiAuth(params.authStorage, params.sessionId, model, params.signal);
	if (!auth) {
		throw new SearchProviderError(
			"xai",
			"xAI search credentials not found. Set XAI_API_KEY or login with 'gjc /login xai'.",
			401,
		);
	}

	const response = await fetch(responsesEndpoint(), {
		method: "POST",
		headers: {
			Authorization: `Bearer ${auth.bearer}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(
			buildXaiRequestBody({
				query: params.query,
				systemPrompt: params.system_prompt ?? "Use web search to answer accurately and cite sources.",
				model,
				maxOutputTokens: params.max_output_tokens,
				temperature: params.temperature,
				recency: params.recency,
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
			}),
		),
		signal: withHardTimeout(params.signal),
	});

	const text = await response.text();
	if (!response.ok) {
		const classified = classifyProviderHttpError("xai", response.status, text);
		if (classified) throw classified;
		throw new SearchProviderError("xai", `xAI search API error (${response.status}): ${text}`, response.status);
	}

	let json: any;
	try {
		json = text ? JSON.parse(text) : {};
	} catch {
		throw new SearchProviderError("xai", "xAI search API returned invalid JSON", 502);
	}
	const citations = parseXaiCitations(json);
	if (citations.length === 0) {
		throw new SearchProviderError("xai", "xAI web search returned no citations", 424);
	}

	const limit = params.num_results ?? DEFAULT_NUM_RESULTS;
	return {
		provider: "xai",
		answer: textFromResponse(json),
		sources: toSources(citations, limit),
		citations,
		usage: parseUsage(json),
		model: typeof json.model === "string" ? json.model : model,
		requestId: typeof json.id === "string" ? json.id : undefined,
		authMode: auth.mode,
	};
}

/** Search provider for xAI web and X search. */
export class XaiProvider extends SearchProvider {
	readonly id = "xai";
	readonly label = "xAI";

	isAvailable(authStorage: AuthStorage): boolean {
		return authStorage.hasAuth("xai");
	}

	search(params: SearchParams): Promise<SearchResponse> {
		return searchXai({
			query: params.query,
			system_prompt: params.systemPrompt,
			num_results: params.numSearchResults ?? params.limit,
			max_output_tokens: params.maxOutputTokens,
			temperature: params.temperature,
			recency: params.recency,
			xai_search_mode: params.xaiSearchMode,
			allowed_domains: params.allowedDomains,
			excluded_domains: params.excludedDomains,
			allowed_x_handles: params.allowedXHandles,
			excluded_x_handles: params.excludedXHandles,
			from_date: params.fromDate,
			to_date: params.toDate,
			enable_image_understanding: params.enableImageUnderstanding,
			enable_image_search: params.enableImageSearch,
			enable_video_understanding: params.enableVideoUnderstanding,
			no_inline_citations: params.noInlineCitations,
			signal: params.signal,
			authStorage: params.authStorage,
			sessionId: params.sessionId,
		});
	}
}
