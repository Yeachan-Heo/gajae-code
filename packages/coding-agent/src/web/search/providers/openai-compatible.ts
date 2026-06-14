import type { SearchCitation, SearchResponse, SearchSource } from "../types";
import { SearchProviderError } from "../types";
import type { SearchParams } from "./base";
import { SearchProvider } from "./base";
import { classifyProviderHttpError, withHardTimeout } from "./utils";

function endpoint(baseUrl: string, api: string): string {
	const base = baseUrl.replace(/\/+$/, "");
	return api === "openai-completions" ? `${base}/chat/completions` : `${base}/responses`;
}

function textFromResponse(json: any): string | undefined {
	if (typeof json.output_text === "string") return json.output_text;
	const chunks: string[] = [];
	for (const item of json.output ?? []) {
		for (const content of item.content ?? []) {
			if (typeof content.text === "string") chunks.push(content.text);
		}
	}
	const chat = json.choices?.[0]?.message?.content;
	if (typeof chat === "string") chunks.push(chat);
	return chunks.join("\n") || undefined;
}

function pushCitation(out: SearchCitation[], rawUrl: unknown, rawTitle: unknown, rawText: unknown): void {
	if (typeof rawUrl !== "string" || !rawUrl) return;
	out.push({
		url: rawUrl,
		title: typeof rawTitle === "string" && rawTitle ? rawTitle : rawUrl,
		citedText: typeof rawText === "string" ? rawText : undefined,
	});
}

// Only recognized grounding annotations count as citations. An OpenAI-compatible
// endpoint that ignores the web_search request returns a normal answer with no
// `url_citation` annotations; treating arbitrary URL/`type:"source"` metadata as a
// citation would mask that non-search answer as a real search result. Restrict
// extraction to the documented annotation shapes (Responses
// `output[].content[].annotations[]` and Chat `choices[].message.annotations[]`),
// accepting only `type: "url_citation"` entries.
function collectCitationAnnotations(annotations: unknown, out: SearchCitation[]): void {
	if (!Array.isArray(annotations)) return;
	for (const annotation of annotations) {
		if (!annotation || typeof annotation !== "object") continue;
		const ann = annotation as Record<string, any>;
		if (ann.type !== "url_citation") continue;
		const cite =
			ann.url_citation && typeof ann.url_citation === "object" ? (ann.url_citation as Record<string, any>) : ann;
		pushCitation(out, cite.url ?? cite.uri, cite.title, cite.text ?? cite.quote ?? ann.text);
	}
}

function parseCitations(json: any): SearchCitation[] {
	const citations: SearchCitation[] = [];
	for (const item of json?.output ?? []) {
		for (const content of item?.content ?? []) {
			collectCitationAnnotations(content?.annotations, citations);
		}
	}
	for (const choice of json?.choices ?? []) {
		collectCitationAnnotations(choice?.message?.annotations, citations);
	}
	const seen = new Set<string>();
	return citations.filter(c => {
		if (seen.has(c.url)) return false;
		seen.add(c.url);
		return true;
	});
}

function toSources(citations: SearchCitation[], limit: number): SearchSource[] {
	return citations.slice(0, limit).map(c => ({ title: c.title || c.url, url: c.url, snippet: c.citedText }));
}

export class OpenAICompatibleSearchProvider extends SearchProvider {
	readonly id = "openai-compatible" as const;
	readonly label = "OpenAI-compatible";

	isAvailable(): boolean {
		return true;
	}

	async search(params: SearchParams): Promise<SearchResponse> {
		const ctx = params.activeModelContext;
		if (!ctx)
			throw new SearchProviderError(this.id, "OpenAI-compatible web search requires active model context", 400);
		if (ctx.api !== "openai-responses" && ctx.api !== "openai-completions") {
			throw new SearchProviderError(this.id, `OpenAI-compatible web search does not support ${ctx.api}`, 400);
		}
		const apiKey = await params.authStorage.getApiKey(ctx.provider, params.sessionId, {
			baseUrl: ctx.baseUrl,
			modelId: ctx.modelId,
			signal: params.signal,
		});
		if (!apiKey) throw new SearchProviderError(this.id, `No credentials for ${ctx.provider}`, 401);
		const model = ctx.wireModelId ?? ctx.modelId;
		const headers = { ...(ctx.headers ?? {}), Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
		const body =
			ctx.api === "openai-completions"
				? {
						model,
						messages: [
							{ role: "system", content: params.systemPrompt },
							{ role: "user", content: params.query },
						],
						web_search_options: {},
						temperature: params.temperature,
						max_tokens: params.maxOutputTokens,
					}
				: {
						model,
						input: [
							{ role: "system", content: params.systemPrompt },
							{ role: "user", content: params.query },
						],
						tools: [{ type: "web_search" }],
						temperature: params.temperature,
						max_output_tokens: params.maxOutputTokens,
					};
		const response = await fetch(endpoint(ctx.baseUrl ?? "", ctx.api), {
			method: "POST",
			headers,
			body: JSON.stringify(body),
			signal: withHardTimeout(params.signal),
		});
		const text = await response.text();
		if (!response.ok) {
			const classified = classifyProviderHttpError(this.id, response.status, text);
			if (classified) throw classified;
			throw new SearchProviderError(
				this.id,
				`OpenAI-compatible web search error (${response.status}): ${text}`,
				response.status,
			);
		}
		const json = text ? JSON.parse(text) : {};
		const citations = parseCitations(json);
		if (citations.length === 0) {
			throw new SearchProviderError(this.id, "OpenAI-compatible web search returned no citations", 424);
		}
		return {
			provider: this.id,
			answer: textFromResponse(json),
			sources: toSources(citations, params.limit ?? params.numSearchResults ?? 10),
			citations,
			model,
			requestId: json.id,
			authMode: "api-key",
		};
	}
}
