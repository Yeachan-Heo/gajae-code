import type { SearchCitation, SearchResponse, SearchSource } from "../types";
import { SearchProviderError } from "../types";
import type { SearchParams } from "./base";
import { SearchProvider } from "./base";
import { extractTextSources } from "./text-citations";
import { classifyProviderHttpError, withHardTimeout } from "./utils";

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function malformedResponse(detail: string): never {
	throw new SearchProviderError(
		"openai-compatible",
		`OpenAI-compatible web search returned malformed response body (${detail})`,
		502,
	);
}

function optionalArray(value: unknown, detail: string): unknown[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) malformedResponse(detail);
	return value;
}

function normalizeResponseBody(value: unknown): JsonObject {
	if (!isJsonObject(value)) malformedResponse("expected a JSON object");

	const output = optionalArray(value.output, "output must be an array");
	const choices = optionalArray(value.choices, "choices must be an array");

	for (const item of output) {
		if (!isJsonObject(item)) continue;
		for (const content of optionalArray(item.content, "output content must be an array")) {
			if (isJsonObject(content)) optionalArray(content.annotations, "output annotations must be an array");
		}
	}
	for (const choice of choices) {
		if (!isJsonObject(choice) || !isJsonObject(choice.message)) continue;
		optionalArray(choice.message.annotations, "choice annotations must be an array");
	}

	return { ...value, output, choices };
}

function parseResponseBody(text: string): JsonObject {
	let value: unknown;
	try {
		value = text ? JSON.parse(text) : {};
	} catch {
		throw new SearchProviderError("openai-compatible", "OpenAI-compatible web search returned invalid JSON", 502);
	}
	return normalizeResponseBody(value);
}

/**
 * Whether the response carries independent proof that a web search ran. Used to
 * gate inline-citation recovery so a stray prose URL in a non-search answer is
 * never promoted to a citation.
 */
function webSearchPerformed(json: JsonObject): boolean {
	if (Array.isArray(json.output) && json.output.some(item => isJsonObject(item) && item.type === "web_search_call")) {
		return true;
	}
	const toolUsage = isJsonObject(json.tool_usage) ? json.tool_usage : undefined;
	const webSearch = toolUsage && isJsonObject(toolUsage.web_search) ? toolUsage.web_search : undefined;
	const numRequests = webSearch?.num_requests;
	return typeof numRequests === "number" && numRequests > 0;
}

function endpoint(baseUrl: string, api: string): string {
	const base = baseUrl.replace(/\/+$/, "");
	return api === "openai-completions" ? `${base}/chat/completions` : `${base}/responses`;
}

function textFromResponse(json: JsonObject): string | undefined {
	if (typeof json.output_text === "string") return json.output_text;
	const chunks: string[] = [];
	for (const item of optionalArray(json.output, "output must be an array")) {
		if (!isJsonObject(item)) continue;
		for (const content of optionalArray(item.content, "output content must be an array")) {
			if (isJsonObject(content) && typeof content.text === "string") chunks.push(content.text);
		}
	}
	const firstChoice = optionalArray(json.choices, "choices must be an array")[0];
	const message = isJsonObject(firstChoice) && isJsonObject(firstChoice.message) ? firstChoice.message : undefined;
	if (typeof message?.content === "string") chunks.push(message.content);
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
		if (!isJsonObject(annotation) || annotation.type !== "url_citation") continue;
		const cite = isJsonObject(annotation.url_citation) ? annotation.url_citation : annotation;
		pushCitation(out, cite.url ?? cite.uri, cite.title, cite.text ?? cite.quote ?? annotation.text);
	}
}

function parseCitations(json: JsonObject): SearchCitation[] {
	const citations: SearchCitation[] = [];
	for (const item of optionalArray(json.output, "output must be an array")) {
		if (!isJsonObject(item)) continue;
		for (const content of optionalArray(item.content, "output content must be an array")) {
			if (isJsonObject(content)) collectCitationAnnotations(content.annotations, citations);
		}
	}
	for (const choice of optionalArray(json.choices, "choices must be an array")) {
		const message = isJsonObject(choice) && isJsonObject(choice.message) ? choice.message : undefined;
		if (message) collectCitationAnnotations(message.annotations, citations);
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
		const baseUrl = ctx.baseUrl ?? "";
		const headers = { ...(ctx.headers ?? {}), Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
		const messages = [
			{ role: "system", content: params.systemPrompt },
			{ role: "user", content: params.query },
		];
		const responsesBody = {
			model,
			input: messages,
			tools: [{ type: "web_search" }],
			temperature: params.temperature,
			max_output_tokens: params.maxOutputTokens,
		};
		const chatBody = {
			model,
			messages,
			web_search_options: {},
			temperature: params.temperature,
			max_tokens: params.maxOutputTokens,
		};

		const post = (api: "openai-responses" | "openai-completions", payload: unknown) =>
			fetch(endpoint(baseUrl, api), {
				method: "POST",
				headers,
				body: JSON.stringify(payload),
				signal: withHardTimeout(params.signal, "llm"),
			});

		// Web search is a Responses-API capability: many OpenAI-compatible
		// endpoints (incl. proxies fronting chat-only models) only ground search
		// through `/responses`, while `/chat/completions` answers from the model's
		// stale knowledge. Prefer `/responses` regardless of the model's chat wire,
		// and fall back to `/chat/completions` only when `/responses` is absent.
		let response = await post("openai-responses", responsesBody);
		if (response.status === 404 || response.status === 405) {
			response = await post("openai-completions", chatBody);
		}
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
		const json = parseResponseBody(text);
		const citations = parseCitations(json);
		const answer = textFromResponse(json);
		const limit = params.limit ?? params.numSearchResults ?? 10;
		let sources = toSources(citations, limit);
		const searched = webSearchPerformed(json);
		// Recover inline-cited sources only when a search demonstrably ran
		// (Responses `web_search_call` / `tool_usage.web_search`). This refuses to
		// promote a model's guessed prose URLs from a non-search answer — exactly
		// what a chat endpoint that ignores `web_search_options` returns.
		if (sources.length === 0 && searched && answer) {
			sources = extractTextSources(answer).slice(0, limit);
		}
		if (sources.length === 0 && !searched) {
			throw new SearchProviderError(this.id, "OpenAI-compatible web search returned no citations", 424);
		}
		return {
			provider: this.id,
			answer,
			sources,
			citations: citations.length > 0 ? citations : undefined,
			model,
			requestId: typeof json.id === "string" ? json.id : undefined,
			authMode: "api-key",
		};
	}
}
