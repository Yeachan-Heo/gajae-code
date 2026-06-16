/**
 * xAI Web Search Provider
 *
 * Uses xAI's Responses API with the built-in web_search tool.
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

export interface XaiSearchParams {
	query: string;
	system_prompt?: string;
	num_results?: number;
	max_output_tokens?: number;
	temperature?: number;
	signal?: AbortSignal;
	authStorage: AuthStorage;
	sessionId?: string;
}

interface XaiAuth {
	bearer: string;
	mode: "api_key" | "oauth";
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
	const bearer = await authStorage.getApiKey("xai", sessionId, {
		baseUrl: getBaseUrl(),
		modelId: model,
		signal,
	});
	if (!bearer) return null;

	// getApiKey records the selected credential type for session-scoped calls.
	// Do not call getOAuthAccess here: when an API-key credential wins, resolving
	// OAuth solely for labelling would refresh/record the wrong credential.
	const selectedType = authStorage.getSessionCredentialType("xai", sessionId);
	return { bearer, mode: selectedType === "oauth" ? "oauth" : "api_key" };
}

export function buildXaiRequestBody(params: {
	query: string;
	systemPrompt: string;
	model: string;
	maxOutputTokens?: number;
	temperature?: number;
}): Record<string, unknown> {
	const body: Record<string, unknown> = {
		model: params.model,
		input: [
			{ role: "system", content: params.systemPrompt },
			{ role: "user", content: params.query },
		],
		tools: [{ type: "web_search" }],
	};
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

function parseUsage(json: any): SearchUsage | undefined {
	const usage = json?.usage;
	if (!usage || typeof usage !== "object") return undefined;
	const toolUsage = usage.server_side_tool_usage_details;
	return {
		inputTokens: typeof usage.input_tokens === "number" ? usage.input_tokens : undefined,
		outputTokens: typeof usage.output_tokens === "number" ? usage.output_tokens : undefined,
		totalTokens: typeof usage.total_tokens === "number" ? usage.total_tokens : undefined,
		searchRequests: typeof toolUsage?.web_search_calls === "number" ? toolUsage.web_search_calls : undefined,
	};
}

/** Execute xAI web search through the Responses API web_search tool. */
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

	const json = text ? JSON.parse(text) : {};
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

/** Search provider for xAI web search. */
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
			signal: params.signal,
			authStorage: params.authStorage,
			sessionId: params.sessionId,
		});
	}
}
