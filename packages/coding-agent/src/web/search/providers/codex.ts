/**
 * OpenAI code provider Web Search Provider
 *
 * Uses OpenAI code backend's built-in web_search tool via the Responses API.
 * Auth is resolved through `AuthStorage.getOAuthAccess("OpenAI code provider")` so the
 * broker is the sole refresh authority — this module never opens a sibling
 * SQLite store, never POSTs the broker sentinel to an OpenAI token endpoint.
 */
import * as os from "node:os";
import { type AuthStorage, getBundledModels } from "@gajae-code/ai";
import { decodeJwt } from "@gajae-code/ai/utils/oauth/openai-codex";
import { $env, readSseJson } from "@gajae-code/utils";
import packageJson from "../../../../package.json" with { type: "json" };
import type { SearchResponse, SearchSource } from "../../../web/search/types";
import { SearchProviderError } from "../../../web/search/types";
import type { SearchParams } from "./base";
import { SearchProvider } from "./base";
import { classifyProviderHttpError, withHardTimeout } from "./utils";

const CODEX_BASE_URL = "https://chatgpt.com/backend-api";
const CODEX_RESPONSES_PATH = "/codex/responses";
const FALLBACK_MODEL = "gpt-5.5";
const DEFAULT_MODEL_PREFERENCES = [
	"gpt-5.5",
	"gpt-5.4",
	"gpt-5-codex",
	"gpt-5",
	"gpt-5.3-codex",
	"gpt-5.2-codex",
	"gpt-5.1-codex",
	"gpt-5-codex-mini",
];
const JWT_CLAIM_PATH = "https://api.openai.com/auth";
const DEFAULT_INSTRUCTIONS =
	"You are a helpful assistant with web search capabilities. Search the web to answer the user's question accurately and cite your sources.";

function getConfiguredModel(): string | undefined {
	const configuredModel = $env.PI_CODEX_WEB_SEARCH_MODEL?.trim();
	return configuredModel ? configuredModel : undefined;
}

function getDefaultModelCandidates(): string[] {
	const bundledModels = getBundledModels("openai-codex");
	const bundledIds = new Set(bundledModels.map(model => model.id));
	const candidates = DEFAULT_MODEL_PREFERENCES.filter(modelId => bundledIds.has(modelId));

	if (candidates.length > 0) {
		return candidates;
	}

	const nonMini = bundledModels.find(model => !model.id.includes("mini") && !model.id.includes("spark"));
	if (nonMini) {
		return [nonMini.id];
	}

	return bundledModels[0]?.id ? [bundledModels[0].id] : [FALLBACK_MODEL];
}

function shouldRetryWithNextDefaultModel(error: unknown): boolean {
	if (!(error instanceof SearchProviderError)) return false;
	if (error.provider !== "codex" || error.status !== 400) return false;
	return /model is not supported|requested model is not supported|not supported when using codex with a chatgpt account/i.test(
		error.message,
	);
}

export interface CodexSearchParams {
	signal?: AbortSignal;
	query: string;
	system_prompt?: string;
	num_results?: number;
	/** Search context size: controls how much web content to include */
	search_context_size?: "low" | "medium" | "high";
}

/** OpenAI code backend API response structure */
interface CodexResponseItem {
	type: string;
	id?: string;
	role?: string;
	name?: string;
	call_id?: string;
	status?: string;
	arguments?: string;
	content?: CodexContentPart[];
	summary?: Array<{ type: string; text: string }>;
}

interface CodexContentPart {
	type: string;
	text?: string;
	annotations?: CodexAnnotation[];
}

interface CodexAnnotation {
	type: string;
	url?: string;
	title?: string;
	start_index?: number;
	end_index?: number;
}

interface CodexUsage {
	input_tokens?: number;
	output_tokens?: number;
	total_tokens?: number;
	input_tokens_details?: { cached_tokens?: number };
}

interface CodexResponse {
	id?: string;
	model?: string;
	status?: string;
	usage?: CodexUsage;
}

function isImagePlaceholderAnswer(text: string): boolean {
	return text.trim().toLowerCase() === "(see attached image)";
}

function addSource(sources: SearchSource[], source: SearchSource): void {
	if (!sources.some(existing => existing.url === source.url)) {
		sources.push(source);
	}
}

function countCharacter(text: string, target: string): number {
	let count = 0;
	for (const char of text) {
		if (char === target) {
			count += 1;
		}
	}
	return count;
}

/**
 * Strips prose punctuation and unmatched closing delimiters from extracted URLs.
 * OpenAI code backend often returns links in markdown or sentence text without structured annotations.
 */
function normalizeExtractedUrl(candidate: string): string | null {
	let url = candidate.trim();

	while (url.length > 0) {
		const lastCharacter = url.at(-1);
		if (!lastCharacter) break;
		if (/[.,!?;:'"]/u.test(lastCharacter)) {
			url = url.slice(0, -1);
			continue;
		}
		if (lastCharacter === ")" && countCharacter(url, ")") > countCharacter(url, "(")) {
			url = url.slice(0, -1);
			continue;
		}
		if (lastCharacter === "]" && countCharacter(url, "]") > countCharacter(url, "[")) {
			url = url.slice(0, -1);
			continue;
		}
		if (lastCharacter === "}" && countCharacter(url, "}") > countCharacter(url, "{")) {
			url = url.slice(0, -1);
			continue;
		}
		break;
	}

	if (!/^https?:\/\//.test(url)) {
		return null;
	}

	try {
		return new URL(url).toString();
	} catch {
		return null;
	}
}

function findMarkdownLinkUrlEnd(text: string, openParenIndex: number): number | null {
	let depth = 0;

	for (let index = openParenIndex; index < text.length; index += 1) {
		const character = text[index];
		if (!character || character === "\n") {
			return null;
		}
		if (character === "(") {
			depth += 1;
			continue;
		}
		if (character !== ")") {
			continue;
		}
		depth -= 1;
		if (depth === 0) {
			return index;
		}
		if (depth < 0) {
			return null;
		}
	}

	return null;
}

/**
 * Extracts citation sources from markdown links and bare URLs in the answer text.
 * Used as a fallback when the OpenAI code backend response omits `url_citation` annotations.
 */
function extractTextSources(text: string): SearchSource[] {
	const sources: SearchSource[] = [];

	for (let index = 0; index < text.length; index += 1) {
		if (text[index] !== "[") {
			continue;
		}
		const titleEnd = text.indexOf("]", index + 1);
		if (titleEnd === -1 || text[titleEnd + 1] !== "(") {
			continue;
		}
		const urlEnd = findMarkdownLinkUrlEnd(text, titleEnd + 1);
		if (urlEnd === null) {
			continue;
		}
		const title = text.slice(index + 1, titleEnd).trim();
		const url = normalizeExtractedUrl(text.slice(titleEnd + 2, urlEnd));
		if (url) {
			addSource(sources, { title: title || url, url });
		}
		index = urlEnd;
	}

	for (const match of text.matchAll(/https?:\/\/\S+/g)) {
		const url = normalizeExtractedUrl(match[0] ?? "");
		if (!url) continue;
		addSource(sources, { title: url, url });
	}

	return sources;
}

/**
 * Extracts account ID from a OpenAI code backend access token.
 * @param accessToken - JWT access token
 * @returns Account ID string, or null if not found
 */
function getAccountIdFromJwt(accessToken: string): string | null {
	const payload = decodeJwt(accessToken);
	const auth = payload?.[JWT_CLAIM_PATH] as { chatgpt_account_id?: string } | undefined;
	const accountId = auth?.chatgpt_account_id;
	return typeof accountId === "string" && accountId.length > 0 ? accountId : null;
}

/**
 * Resolve a OpenAI code backend bearer + accountId through {@link AuthStorage} — the single
 * refresh authority. Returns `null` when no OAuth credential is configured,
 * when the credential cannot be refreshed (broker error, revoked token, etc.),
 * or when the access token carries no `chatgpt_account_id` claim.
 */
async function findCodexAuth(
	authStorage: AuthStorage,
	sessionId: string | undefined,
	signal: AbortSignal | undefined,
): Promise<{ accessToken: string; accountId: string } | null> {
	const access = await authStorage.getOAuthAccess("openai-codex", sessionId, { signal });
	if (!access) return null;
	const accountId = access.accountId ?? getAccountIdFromJwt(access.accessToken);
	if (!accountId) return null;
	return { accessToken: access.accessToken, accountId };
}

/**
 * Builds HTTP headers for OpenAI code backend API requests.
 */
function buildCodexHeaders(accessToken: string, accountId: string): Record<string, string> {
	return {
		Authorization: `Bearer ${accessToken}`,
		"chatgpt-account-id": accountId,
		"OpenAI-Beta": "responses=experimental",
		originator: "pi",
		"User-Agent": `pi/${packageJson.version} (${os.platform()} ${os.release()}; ${os.arch()})`,
		Accept: "text/event-stream",
		"Content-Type": "application/json",
	};
}

/**
 * Calls the OpenAI code backend Responses API with web search tool enabled.
 * The caller provides the exact model id to send; retry / fallback policy
 * lives one layer up in `searchOpenAI code backend()` so we can distinguish explicit user
 * overrides from the default ChatGPT-account model-selection path.
 */
async function callCodexSearch(
	auth: { accessToken: string; accountId: string },
	query: string,
	options: {
		signal?: AbortSignal;
		systemPrompt?: string;
		searchContextSize?: "low" | "medium" | "high";
		modelId: string;
	},
): Promise<{
	answer: string;
	sources: SearchSource[];
	model: string;
	requestId: string;
	usage?: { inputTokens: number; outputTokens: number; totalTokens: number };
}> {
	const url = `${CODEX_BASE_URL}${CODEX_RESPONSES_PATH}`;
	const headers = buildCodexHeaders(auth.accessToken, auth.accountId);

	const requestedModel = options.modelId;

	const body: Record<string, unknown> = {
		model: requestedModel,
		stream: true,
		store: false,
		input: [
			{
				type: "message",
				role: "user",
				content: [{ type: "input_text", text: query }],
			},
		],
		tools: [
			{
				type: "web_search",
				search_context_size: options.searchContextSize ?? "high",
			},
		],
		tool_choice: { type: "web_search" },
		instructions: options.systemPrompt ?? DEFAULT_INSTRUCTIONS,
	};

	const response = await fetch(url, {
		method: "POST",
		headers,
		body: JSON.stringify(body),
		signal: withHardTimeout(options.signal),
	});

	if (!response.ok) {
		const errorText = await response.text();
		const classified = classifyProviderHttpError("codex", response.status, errorText);
		if (classified) throw classified;
		throw new SearchProviderError("codex", `Codex API error (${response.status}): ${errorText}`, response.status);
	}

	if (!response.body) {
		throw new SearchProviderError("codex", "Codex API returned no response body", 500);
	}

	// Parse SSE stream
	const answerParts: string[] = [];
	const streamedAnswerParts: string[] = [];
	const sources: SearchSource[] = [];
	let model = requestedModel;
	let requestId = "";
	let usage: { inputTokens: number; outputTokens: number; totalTokens: number } | undefined;

	for await (const rawEvent of readSseJson<Record<string, unknown>>(response.body, options.signal)) {
		const eventType = typeof rawEvent.type === "string" ? rawEvent.type : "";
		if (!eventType) continue;

		if (eventType === "response.output_text.delta") {
			const delta = typeof rawEvent.delta === "string" ? rawEvent.delta : "";
			if (delta) {
				streamedAnswerParts.push(delta);
			}
		} else if (eventType === "response.output_item.done") {
			const item = rawEvent.item as CodexResponseItem | undefined;
			if (!item) continue;

			// Handle text message content and extract sources from annotations
			if (item.type === "message" && item.content) {
				for (const part of item.content) {
					if (part.type === "output_text" && part.text) {
						answerParts.push(part.text);

						// Extract sources from url_citation annotations
						if (part.annotations) {
							for (const annotation of part.annotations) {
								if (annotation.type === "url_citation" && annotation.url) {
									// Deduplicate by URL
									addSource(sources, { title: annotation.title ?? annotation.url, url: annotation.url });
								}
							}
						}
					}
				}
			}

			// Handle reasoning summary as part of answer
			if (item.type === "reasoning" && item.summary) {
				for (const part of item.summary) {
					if (part.type === "summary_text" && part.text) {
						answerParts.push(part.text);
					}
				}
			}
		} else if (eventType === "response.completed" || eventType === "response.done") {
			const resp = (rawEvent as { response?: CodexResponse }).response;
			if (resp) {
				if (resp.model) model = resp.model;
				if (resp.id) requestId = resp.id;
				if (resp.usage) {
					const cachedTokens = resp.usage.input_tokens_details?.cached_tokens ?? 0;
					usage = {
						inputTokens: (resp.usage.input_tokens ?? 0) - cachedTokens,
						outputTokens: resp.usage.output_tokens ?? 0,
						totalTokens: resp.usage.total_tokens ?? 0,
					};
				}
			}
		} else if (eventType === "error") {
			const code = (rawEvent as { code?: string }).code ?? "";
			const message = (rawEvent as { message?: string }).message ?? "Unknown error";
			throw new SearchProviderError("codex", `Codex error (${code}): ${message}`, 500);
		} else if (eventType === "response.failed") {
			const resp = (rawEvent as { response?: { error?: { message?: string } } }).response;
			const errorMessage = resp?.error?.message ?? "Request failed";
			throw new SearchProviderError("codex", `Codex request failed: ${errorMessage}`, 500);
		}
	}

	const finalAnswer = answerParts.join("\n\n").trim();
	const streamedAnswer = streamedAnswerParts.join("").trim();
	if (isImagePlaceholderAnswer(finalAnswer) && streamedAnswer.length === 0) {
		throw new SearchProviderError("codex", "Codex returned image-only response", 502);
	}
	const answer =
		finalAnswer.length > 0 && !isImagePlaceholderAnswer(finalAnswer)
			? finalAnswer
			: streamedAnswer.length > 0
				? streamedAnswer
				: finalAnswer;

	// Fallback: when OpenAI code backend omits url_citation annotations, scrape markdown links
	// and bare URLs from the synthesized answer so callers still receive sources.
	if (sources.length === 0 && answer.length > 0) {
		for (const source of extractTextSources(answer)) {
			addSource(sources, source);
		}
	}

	return {
		answer,
		sources,
		model,
		requestId,
		usage,
	};
}

/**
 * Executes a web search using OpenAI code provider's built-in web search tool.
 *
 * Default-model behavior:
 * - If `PI_CODEX_WEB_SEARCH_MODEL` is set, use it exactly once and surface any
 *   upstream error verbatim.
 * - Otherwise prefer ChatGPT-account-safe bundled defaults (GPT-5.5, GPT-5.4,
 *   GPT-5 code backend, …) and retry the next candidate only when OpenAI code backend returns the
 *   known 400 "model is not supported" family. This avoids selecting
 *   `gpt-5-codex-mini` first on ChatGPT accounts, which OpenAI rejects.
 */
export async function searchCodex(params: SearchParams): Promise<SearchResponse> {
	const auth = await findCodexAuth(params.authStorage, params.sessionId, params.signal);
	if (!auth) {
		throw new Error(
			"No Codex OAuth credentials found. Login with 'gjc /login openai-codex' to enable Codex web search.",
		);
	}

	const configuredModel = getConfiguredModel();
	const modelCandidates = configuredModel ? [configuredModel] : getDefaultModelCandidates();

	let result:
		| {
				answer: string;
				sources: SearchSource[];
				model: string;
				requestId: string;
				usage?: { inputTokens: number; outputTokens: number; totalTokens: number };
		  }
		| undefined;
	let lastError: unknown;

	for (let index = 0; index < modelCandidates.length; index += 1) {
		const modelId = modelCandidates[index];
		if (!modelId) continue;

		try {
			result = await callCodexSearch(auth, params.query, {
				signal: params.signal,
				systemPrompt: params.systemPrompt,
				searchContextSize: "high",
				modelId,
			});
			break;
		} catch (error) {
			lastError = error;
			const isLastCandidate = index === modelCandidates.length - 1;
			if (configuredModel || isLastCandidate || !shouldRetryWithNextDefaultModel(error)) {
				throw error;
			}
		}
	}

	if (!result) {
		throw lastError ?? new Error("Codex search failed without returning a result");
	}

	let sources = result.sources;

	const numResults = params.numSearchResults ?? params.limit;
	if (numResults && sources.length > numResults) {
		sources = sources.slice(0, numResults);
	}

	return {
		provider: "codex",
		answer: result.answer || undefined,
		sources,
		usage: result.usage
			? {
					inputTokens: result.usage.inputTokens,
					outputTokens: result.usage.outputTokens,
					totalTokens: result.usage.totalTokens,
				}
			: undefined,
		model: result.model,
		requestId: result.requestId,
	};
}

/**
 * Checks if OpenAI code backend web search is available.
 */
export async function hasCodexSearch(authStorage: AuthStorage): Promise<boolean> {
	// `isAvailable` runs before every request — keep the probe cheap.
	// `hasOAuth(...)` is a synchronous in-memory check that returns true as soon
	// as a OpenAI code backend OAuth credential is loaded, without driving the refresh
	// pipeline. The actual refresh happens lazily in `searchOpenAI code backend`.
	return authStorage.hasOAuth("openai-codex");
}

/** Search provider for OpenAI code provider web search. */
export class CodexProvider extends SearchProvider {
	readonly id = "codex";
	readonly label = "OpenAI";

	isAvailable(authStorage: AuthStorage): Promise<boolean> | boolean {
		return hasCodexSearch(authStorage);
	}

	search(params: SearchParams): Promise<SearchResponse> {
		return searchCodex(params);
	}
}
