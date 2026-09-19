import { readSseEvents } from "@gajae-code/utils";
import type { ActiveSearchModelCredentials, SearchCitation, SearchResponse, SearchSource } from "../types";
import { SearchProviderError } from "../types";
import type { SearchParams } from "./base";
import { SearchProvider } from "./base";
import { extractTextSources } from "./text-citations";
import { classifyProviderHttpError, withHardTimeout } from "./utils";

type JsonObject = Record<string, unknown>;

function hasHeader(headers: Record<string, string>, name: string): boolean {
	const normalized = name.toLowerCase();
	return Object.keys(headers).some(key => key.toLowerCase() === normalized);
}

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

function parseJsonObject(text: string): JsonObject {
	let value: unknown;
	try {
		value = text ? JSON.parse(text) : {};
	} catch {
		throw new SearchProviderError("openai-compatible", "OpenAI-compatible web search returned invalid JSON", 502);
	}
	if (!isJsonObject(value)) malformedResponse("expected a JSON object");
	return value;
}

function validateJsonSuccess(value: JsonObject, chat: boolean): JsonObject {
	const json = normalizeResponseBody(value);
	if (json.error != null) malformedResponse("unsuccessful response");
	if (chat) {
		const firstChoice = optionalArray(json.choices, "choices must be an array").find(
			(choice, index) => isJsonObject(choice) && (choice.index === 0 || (choice.index === undefined && index === 0)),
		);
		if (
			isJsonObject(firstChoice) &&
			firstChoice.finish_reason !== undefined &&
			firstChoice.finish_reason !== "stop"
		) {
			malformedResponse("unsuccessful choice completion");
		}
		return json;
	}
	if ((json.status !== undefined && json.status !== "completed") || json.incomplete_details != null) {
		malformedResponse("unsuccessful response");
	}
	for (const item of optionalArray(json.output, "output must be an array")) {
		if (isJsonObject(item) && item.status !== undefined && item.status !== "completed") {
			malformedResponse("unsuccessful output item");
		}
	}
	return json;
}

function failedStreamEvent(type: unknown): boolean {
	return type === "error" || type === "response.failed" || type === "response.incomplete";
}

async function readStreamBody(response: Response, chat: boolean, signal: AbortSignal): Promise<JsonObject> {
	if (!response.body) malformedResponse("missing event stream");
	const outputItems = new Map<number, JsonObject>();
	const chunks: string[] = [];
	const annotations: unknown[] = [];
	let id: string | undefined;
	let toolUsage: unknown;
	let completed = false;
	try {
		for await (const event of readSseEvents(response.body, signal)) {
			signal.throwIfAborted();
			if (failedStreamEvent(event.event)) malformedResponse("unsuccessful stream event");
			if (event.data === "[DONE]") break;
			if (!event.data) continue;
			const json = parseJsonObject(event.data);
			if (failedStreamEvent(json.type) || json.error != null) malformedResponse("unsuccessful stream event");
			if (!chat) {
				const type = json.type ?? event.event;
				if (type === "response.output_item.done") {
					const index = json.output_index;
					const item = json.item;
					if (
						typeof index !== "number" ||
						!Number.isInteger(index) ||
						index < 0 ||
						!isJsonObject(item) ||
						typeof item.type !== "string"
					) {
						malformedResponse("invalid completed output item");
					}
					if (
						(item.status !== undefined && item.status !== "completed") ||
						((item.type === "message" || item.type === "web_search_call") && item.status !== "completed")
					) {
						malformedResponse("unsuccessful output item");
					}
					normalizeResponseBody({ output: [item] });
					outputItems.set(index, item);
					continue;
				}
				if (type !== "response.completed" && type !== "response.done") continue;
				const snapshot = json.response;
				if (
					!isJsonObject(snapshot) ||
					snapshot.status !== "completed" ||
					snapshot.error != null ||
					snapshot.incomplete_details != null
				) {
					malformedResponse("missing successful response snapshot");
				}
				// Nonempty terminal output is canonical. Streaming gateways can omit
				// it after sending completed items; reconstruct only that sparse case,
				// never from token deltas or before a successful response terminal.
				const output = optionalArray(snapshot.output, "output must be an array");
				for (const item of output) {
					if (isJsonObject(item) && item.status !== undefined && item.status !== "completed") {
						malformedResponse("unsuccessful output item");
					}
				}
				return normalizeResponseBody({
					...snapshot,
					output: output.length > 0 ? output : [...outputItems].sort(([a], [b]) => a - b).map(([, item]) => item),
				});
			}
			if (typeof json.id === "string") id = json.id;
			if (webSearchPerformed({ tool_usage: json.tool_usage })) toolUsage = json.tool_usage;
			const choice = optionalArray(json.choices, "choices must be an array").find(
				(value, index) => isJsonObject(value) && (value.index === 0 || (value.index === undefined && index === 0)),
			);
			if (!isJsonObject(choice)) continue;
			if (choice.delta !== undefined && !isJsonObject(choice.delta)) malformedResponse("invalid choice delta");
			const delta = isJsonObject(choice.delta) ? choice.delta : undefined;
			if (delta?.content != null) {
				if (typeof delta.content !== "string") malformedResponse("invalid choice content");
				if (completed && delta.content) malformedResponse("content after completion");
				chunks.push(delta.content);
			}
			for (const annotation of optionalArray(delta?.annotations, "choice annotations must be an array")) {
				annotations.push(annotation);
			}
			if (choice.finish_reason != null) {
				if (choice.finish_reason !== "stop") malformedResponse("unsuccessful choice completion");
				completed = true;
			}
		}
		// readSseEvents intentionally swallows aborts. Never turn one into an
		// EOF error, or return a partial answer after a successful choice chunk.
		signal.throwIfAborted();
		if (!chat || !completed) malformedResponse("stream ended before successful completion");
		// Usage-only chunks may follow finish_reason, so consume through DONE/EOF.
		return { id, tool_usage: toolUsage, choices: [{ message: { content: chunks.join(""), annotations } }] };
	} catch (error) {
		signal.throwIfAborted();
		if (
			error instanceof SearchProviderError ||
			(error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError"))
		) {
			throw error;
		}
		malformedResponse("invalid event stream");
	}
}

async function cancelResponseBody(response: Response): Promise<void> {
	// readSseEvents cancels its iterator on early return/error, propagating
	// cancellation through its abortable pipe. Cancel bodies not owned by it too.
	if (!response.body || response.body.locked) return;
	try {
		await response.body.cancel();
	} catch {
		// Cleanup must not replace the provider error or caller's abort reason.
	}
}

async function readResponseText(response: Response, signal: AbortSignal): Promise<string> {
	try {
		signal.throwIfAborted();
		const body = response.body?.pipeThrough(new TransformStream<Uint8Array, Uint8Array>(), { signal });
		const text = await (body ? new Response(body).text() : response.text());
		signal.throwIfAborted();
		return text;
	} catch (error) {
		signal.throwIfAborted();
		throw error;
	}
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
		const activeCredentials: ActiveSearchModelCredentials = ctx.resolveCredentials
			? await ctx.resolveCredentials({ sessionId: params.sessionId, signal: params.signal })
			: {
					apiKey: await params.authStorage.getApiKey(ctx.provider, params.sessionId, {
						baseUrl: ctx.baseUrl,
						modelId: ctx.modelId,
						signal: params.signal,
					}),
					headers: ctx.headers,
				};
		const apiKey = activeCredentials.apiKey;
		const headers = { ...(activeCredentials.headers ?? ctx.headers ?? {}) };
		if (apiKey && !hasHeader(headers, "authorization")) headers.Authorization = `Bearer ${apiKey}`;
		if (!hasHeader(headers, "authorization")) {
			throw new SearchProviderError(this.id, `No credentials for ${ctx.provider}`, 401);
		}
		if (!hasHeader(headers, "content-type")) headers["Content-Type"] = "application/json";
		const model = ctx.wireModelId ?? ctx.modelId;
		const baseUrl = ctx.baseUrl ?? "";
		const messages = [
			{ role: "system", content: params.systemPrompt },
			{ role: "user", content: params.query },
		];
		const responsesBody = {
			model,
			stream: true,
			input: messages,
			tools: [{ type: "web_search" }],
			temperature: params.temperature,
			max_output_tokens: params.maxOutputTokens,
		};
		const chatBody = {
			model,
			stream: true,
			messages,
			web_search_options: {},
			temperature: params.temperature,
			max_tokens: params.maxOutputTokens,
		};

		const signal = withHardTimeout(params.signal, "llm");
		const post = (api: "openai-responses" | "openai-completions", payload: unknown) =>
			fetch(endpoint(baseUrl, api), {
				method: "POST",
				headers,
				body: JSON.stringify(payload),
				signal,
			});

		// Web search is a Responses-API capability: many OpenAI-compatible
		// endpoints (incl. proxies fronting chat-only models) only ground search
		// through `/responses`, while `/chat/completions` answers from the model's
		// stale knowledge. Prefer `/responses` regardless of the model's chat wire,
		// and fall back to `/chat/completions` only when `/responses` is absent.
		let response = await post("openai-responses", responsesBody);
		const chat = response.status === 404 || response.status === 405;
		if (chat) {
			await cancelResponseBody(response);
			signal.throwIfAborted();
			response = await post("openai-completions", chatBody);
		}
		let json: JsonObject;
		try {
			signal.throwIfAborted();
			if (!response.ok) {
				const text = await readResponseText(response, signal);
				const classified = classifyProviderHttpError(this.id, response.status, text);
				if (classified) throw classified;
				throw new SearchProviderError(
					this.id,
					`OpenAI-compatible web search error (${response.status}): ${text}`,
					response.status,
				);
			}
			const streaming =
				response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() === "text/event-stream";
			json = streaming
				? await readStreamBody(response, chat, signal)
				: validateJsonSuccess(parseJsonObject(await readResponseText(response, signal)), chat);
			signal.throwIfAborted();
		} finally {
			await cancelResponseBody(response);
		}
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
