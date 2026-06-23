/**
 * Google Gemini Web Search Provider
 *
 * Uses Gemini's Google Search grounding via Cloud Code Assist API.
 * Auth is resolved through `AuthStorage.getOAuthAccess(...)` for both
 * `google-gemini-cli` (stable prod) and `google-antigravity` (daily sandbox)
 * — the broker is the sole refresh authority, so this module never opens a
 * sibling SQLite store and never POSTs the broker sentinel to a Google token
 * endpoint.
 */
import {
	ANTIGRAVITY_SYSTEM_INSTRUCTION,
	type AuthStorage,
	getAntigravityUserAgent,
	getGeminiCliHeaders,
} from "@gajae-code/ai";
import { fetchWithRetry } from "@gajae-code/utils";

import type { SearchCitation, SearchResponse, SearchSource } from "../../../web/search/types";
import { SearchProviderError } from "../../../web/search/types";
import type { SearchParams } from "./base";
import { SearchProvider } from "./base";
import { classifyProviderHttpError, withHardTimeout } from "./utils";

const DEFAULT_ENDPOINT = "https://cloudcode-pa.googleapis.com";
const ANTIGRAVITY_DAILY_ENDPOINT = "https://daily-cloudcode-pa.googleapis.com";
const ANTIGRAVITY_SANDBOX_ENDPOINT = "https://daily-cloudcode-pa.sandbox.googleapis.com";
const ANTIGRAVITY_ENDPOINT_FALLBACKS = [ANTIGRAVITY_DAILY_ENDPOINT, ANTIGRAVITY_SANDBOX_ENDPOINT] as const;
const DEFAULT_MODEL = "gemini-2.5-flash";
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;
const RATE_LIMIT_BUDGET_MS = 5 * 60 * 1000;

const GEMINI_PROVIDERS = ["google-gemini-cli", "google-antigravity"] as const;
type GeminiProviderId = (typeof GEMINI_PROVIDERS)[number];

interface GeminiToolParams {
	google_search?: Record<string, unknown>;
	code_execution?: Record<string, unknown>;
	url_context?: Record<string, unknown>;
}

export interface GeminiSearchParams extends GeminiToolParams {
	query: string;
	system_prompt?: string;
	num_results?: number;
	/** Maximum output tokens. */
	max_output_tokens?: number;
	/** Sampling temperature (0–1). Lower = more focused/factual. */
	temperature?: number;
	signal?: AbortSignal;
	authStorage: AuthStorage;
	sessionId?: string;
}

export function buildGeminiRequestTools(params: GeminiToolParams): Array<Record<string, Record<string, unknown>>> {
	const tools: Array<Record<string, Record<string, unknown>>> = [{ googleSearch: params.google_search ?? {} }];
	if (params.code_execution !== undefined) {
		tools.push({ codeExecution: params.code_execution });
	}
	if (params.url_context !== undefined) {
		tools.push({ urlContext: params.url_context });
	}
	return tools;
}

/** Resolved auth for a Gemini API request. */
interface GeminiAuth {
	accessToken: string;
	projectId: string;
	isAntigravity: boolean;
}

/**
 * Walks the configured Gemini OAuth providers in deterministic order and
 * returns the first one that yields a usable access token + projectId via
 * {@link AuthStorage.getOAuthAccess}. AuthStorage handles refresh + broker
 * routing internally; this helper never touches refresh tokens directly.
 */
export async function findGeminiAuth(
	authStorage: AuthStorage,
	sessionId: string | undefined,
	signal: AbortSignal | undefined,
): Promise<GeminiAuth | null> {
	for (const provider of GEMINI_PROVIDERS) {
		const access = await authStorage.getOAuthAccess(provider, sessionId, { signal });
		if (!access?.accessToken || !access.projectId) continue;
		return {
			accessToken: access.accessToken,
			projectId: access.projectId,
			isAntigravity: provider === "google-antigravity",
		};
	}
	return null;
}

function hasGeminiOAuth(authStorage: AuthStorage): boolean {
	return GEMINI_PROVIDERS.some((provider: GeminiProviderId) => authStorage.hasOAuth(provider));
}

/** Cloud Code Assist API response types */
interface GeminiGroundingChunk {
	web?: {
		uri?: string;
		title?: string;
	};
}

interface GeminiGroundingSupport {
	segment?: {
		startIndex?: number;
		endIndex?: number;
		text?: string;
	};
	groundingChunkIndices?: number[];
	confidenceScores?: number[];
}

interface GeminiGroundingMetadata {
	groundingChunks?: GeminiGroundingChunk[];
	groundingSupports?: GeminiGroundingSupport[];
	webSearchQueries?: string[];
}

interface CloudCodeResponseChunk {
	response?: {
		candidates?: Array<{
			content?: {
				role: string;
				parts?: Array<{ text?: string }>;
			};
			finishReason?: string;
			groundingMetadata?: GeminiGroundingMetadata;
		}>;
		usageMetadata?: {
			promptTokenCount?: number;
			candidatesTokenCount?: number;
			totalTokenCount?: number;
		};
		modelVersion?: string;
	};
}

/**
 * Calls the Cloud Code Assist API with Google Search grounding enabled.
 *
 * If a request returns a refreshable auth failure (401/403/auth-flavoured 400),
 * we ask AuthStorage to invalidate + refresh the credential and retry once.
 * Provider-direct refresh helpers are intentionally not used: AuthStorage owns
 * the single-flight refresh and broker round-trip.
 */
async function callGeminiSearch(
	auth: GeminiAuth,
	query: string,
	systemPrompt: string | undefined,
	maxOutputTokens: number | undefined,
	temperature: number | undefined,
	toolParams: GeminiToolParams,
	signal: AbortSignal | undefined,
): Promise<{
	answer: string;
	sources: SearchSource[];
	citations: SearchCitation[];
	searchQueries: string[];
	model: string;
	usage?: { inputTokens: number; outputTokens: number; totalTokens: number };
}> {
	const endpoints = auth.isAntigravity ? ANTIGRAVITY_ENDPOINT_FALLBACKS : [DEFAULT_ENDPOINT];
	const headers = auth.isAntigravity ? { "User-Agent": getAntigravityUserAgent() } : getGeminiCliHeaders();

	const requestMetadata = auth.isAntigravity
		? {
				requestType: "agent",
				userAgent: "antigravity",
				requestId: `agent-${crypto.randomUUID()}`,
			}
		: {
				userAgent: "gajae-code",
				requestId: `pi-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`,
			};

	const normalizedSystemPrompt = systemPrompt?.toWellFormed();
	const systemInstructionParts: Array<{ text: string }> = [
		...(auth.isAntigravity
			? [
					{ text: ANTIGRAVITY_SYSTEM_INSTRUCTION },
					{ text: `Please ignore following [ignore]${ANTIGRAVITY_SYSTEM_INSTRUCTION}[/ignore]` },
				]
			: []),
		...(normalizedSystemPrompt ? [{ text: normalizedSystemPrompt }] : []),
	];

	const requestBody: Record<string, unknown> = {
		project: auth.projectId,
		model: DEFAULT_MODEL,
		request: {
			contents: [
				{
					role: "user",
					parts: [{ text: query }],
				},
			],
			tools: buildGeminiRequestTools(toolParams),
			...(systemInstructionParts.length > 0 && {
				systemInstruction: {
					...(auth.isAntigravity ? { role: "user" } : {}),
					parts: systemInstructionParts,
				},
			}),
		},
		...requestMetadata,
	};

	if (maxOutputTokens !== undefined || temperature !== undefined) {
		const generationConfig: Record<string, number> = {};
		if (maxOutputTokens !== undefined) {
			generationConfig.maxOutputTokens = maxOutputTokens;
		}
		if (temperature !== undefined) {
			generationConfig.temperature = temperature;
		}
		(requestBody.request as Record<string, unknown>).generationConfig = generationConfig;
	}
	const buildInit = (): RequestInit => ({
		method: "POST",
		headers: {
			Authorization: `Bearer ${auth.accessToken}`,
			"Content-Type": "application/json",
			Accept: "text/event-stream",
			...headers,
		},
		body: JSON.stringify(requestBody),
		signal: withHardTimeout(signal),
	});
	const urlFor = (attempt: number) =>
		`${endpoints[Math.min(attempt, endpoints.length - 1)]}/v1internal:streamGenerateContent?alt=sse`;

	const response = await fetchWithRetry(urlFor, {
		...buildInit(),
		maxAttempts: MAX_RETRIES + 1,
		defaultDelayMs: attempt => BASE_DELAY_MS * 2 ** attempt,
		maxDelayMs: RATE_LIMIT_BUDGET_MS,
	});

	if (!response.ok) {
		const errorText = await response.text();
		const classified = classifyProviderHttpError("gemini", response.status, errorText);
		if (classified) throw classified;
		throw new SearchProviderError(
			"gemini",
			`Gemini Cloud Code API error (${response.status}): ${errorText}`,
			response.status,
		);
	}

	if (!response.body) {
		throw new SearchProviderError("gemini", "Gemini API returned no response body", 500);
	}

	// Parse SSE stream
	const answerParts: string[] = [];
	const sources: SearchSource[] = [];
	const citations: SearchCitation[] = [];
	const searchQueries: string[] = [];
	const seenUrls = new Set<string>();
	let model = DEFAULT_MODEL;
	let usage: { inputTokens: number; outputTokens: number; totalTokens: number } | undefined;

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;

			buffer += decoder.decode(value, { stream: true });
			const lines = buffer.split("\n");
			buffer = lines.pop() || "";

			for (const line of lines) {
				if (!line.startsWith("data:")) continue;

				const jsonStr = line.slice(5).trim();
				if (!jsonStr) continue;

				let chunk: CloudCodeResponseChunk;
				try {
					chunk = JSON.parse(jsonStr) as CloudCodeResponseChunk;
				} catch {
					continue;
				}

				const responseData = chunk.response;
				if (!responseData) continue;

				const candidate = responseData.candidates?.[0];

				// Extract text content
				if (candidate?.content?.parts) {
					for (const part of candidate.content.parts) {
						if (part.text) {
							answerParts.push(part.text);
						}
					}
				}

				// Extract grounding metadata
				const groundingMetadata = candidate?.groundingMetadata;
				if (groundingMetadata) {
					// Extract sources from grounding chunks
					if (groundingMetadata.groundingChunks) {
						for (const grChunk of groundingMetadata.groundingChunks) {
							if (grChunk.web?.uri) {
								const sourceUrl = grChunk.web.uri;
								if (!seenUrls.has(sourceUrl)) {
									seenUrls.add(sourceUrl);
									sources.push({
										title: grChunk.web.title ?? sourceUrl,
										url: sourceUrl,
									});
								}
							}
						}
					}

					// Extract citations from grounding supports
					if (groundingMetadata.groundingSupports && groundingMetadata.groundingChunks) {
						for (const support of groundingMetadata.groundingSupports) {
							const citedText = support.segment?.text;
							const chunkIndices = support.groundingChunkIndices ?? [];

							for (const idx of chunkIndices) {
								const grChunk = groundingMetadata.groundingChunks[idx];
								if (grChunk?.web?.uri) {
									citations.push({
										url: grChunk.web.uri,
										title: grChunk.web.title ?? grChunk.web.uri,
										citedText,
									});
								}
							}
						}
					}

					// Extract search queries
					if (groundingMetadata.webSearchQueries) {
						for (const q of groundingMetadata.webSearchQueries) {
							if (!searchQueries.includes(q)) {
								searchQueries.push(q);
							}
						}
					}
				}

				// Extract usage metadata
				if (responseData.usageMetadata) {
					usage = {
						inputTokens: responseData.usageMetadata.promptTokenCount ?? 0,
						outputTokens: responseData.usageMetadata.candidatesTokenCount ?? 0,
						totalTokens: responseData.usageMetadata.totalTokenCount ?? 0,
					};
				}

				// Extract model version
				if (responseData.modelVersion) {
					model = responseData.modelVersion;
				}
			}
		}
	} finally {
		reader.releaseLock();
	}

	return {
		answer: answerParts.join(""),
		sources,
		citations,
		searchQueries,
		model,
		usage,
	};
}

/**
 * Executes a web search using Google Gemini with Google Search grounding.
 */
export async function searchGemini(params: GeminiSearchParams): Promise<SearchResponse> {
	const auth = await findGeminiAuth(params.authStorage, params.sessionId, params.signal);
	if (!auth) {
		throw new Error(
			"No Gemini OAuth credentials found. Login with 'gjc /login google-gemini-cli' or 'gjc /login google-antigravity' to enable Gemini web search.",
		);
	}

	const result = await callGeminiSearch(
		auth,
		params.query,
		params.system_prompt,
		params.max_output_tokens,
		params.temperature,
		{
			google_search: params.google_search,
			code_execution: params.code_execution,
			url_context: params.url_context,
		},
		params.signal,
	);

	let sources = result.sources;

	if (params.num_results && sources.length > params.num_results) {
		sources = sources.slice(0, params.num_results);
	}

	return {
		provider: "gemini",
		answer: result.answer || undefined,
		sources,
		citations: result.citations.length > 0 ? result.citations : undefined,
		searchQueries: result.searchQueries.length > 0 ? result.searchQueries : undefined,
		usage: result.usage,
		model: result.model,
	};
}

/**
 * Native Gemini web search over the public Generative Language REST API
 * (`{baseUrl}/v1beta/models/{model}:generateContent`), reusing the ACTIVE
 * model's own API key + baseUrl. This is the "native search over a proxy" path
 * for `google-generative-ai` wire models whose canonical gemini-cli/antigravity
 * OAuth is absent. Distinct from {@link searchGemini}, which speaks the Cloud
 * Code Assist API with OAuth.
 */
async function searchGeminiViaGenerativeLanguage(params: SearchParams): Promise<SearchResponse> {
	const ctx = params.activeModelContext;
	if (!ctx) throw new SearchProviderError("gemini", "Gemini web search requires active model context", 400);
	const apiKey = await params.authStorage.getApiKey(ctx.provider, params.sessionId, {
		baseUrl: ctx.baseUrl,
		modelId: ctx.modelId,
		signal: params.signal,
	});
	if (!apiKey) throw new SearchProviderError("gemini", `No credentials for ${ctx.provider}`, 401);

	const model = ctx.wireModelId ?? ctx.modelId;
	const base = (ctx.baseUrl ?? "https://generativelanguage.googleapis.com").replace(/\/+$/, "");
	// Respect an already-versioned active baseUrl (e.g. a proxy exposing `…/v1beta`)
	// instead of double-appending the version segment.
	const versionedBase = /\/v1(beta|alpha)?$/.test(base) ? base : `${base}/v1beta`;
	const url = `${versionedBase}/models/${encodeURIComponent(model)}:generateContent`;
	const systemPrompt = params.systemPrompt?.toWellFormed();
	const body: Record<string, unknown> = {
		contents: [{ role: "user", parts: [{ text: params.query }] }],
		tools: buildGeminiRequestTools({ google_search: params.googleSearch }),
		...(systemPrompt ? { systemInstruction: { parts: [{ text: systemPrompt }] } } : {}),
	};
	if (params.maxOutputTokens !== undefined || params.temperature !== undefined) {
		const generationConfig: Record<string, number> = {};
		if (params.maxOutputTokens !== undefined) generationConfig.maxOutputTokens = params.maxOutputTokens;
		if (params.temperature !== undefined) generationConfig.temperature = params.temperature;
		body.generationConfig = generationConfig;
	}

	const response = await fetch(url, {
		method: "POST",
		headers: { ...(ctx.headers ?? {}), "x-goog-api-key": apiKey, "Content-Type": "application/json" },
		body: JSON.stringify(body),
		signal: withHardTimeout(params.signal),
	});
	const text = await response.text();
	if (!response.ok) {
		const classified = classifyProviderHttpError("gemini", response.status, text);
		if (classified) throw classified;
		throw new SearchProviderError("gemini", `Gemini API error (${response.status}): ${text}`, response.status);
	}

	const json = text ? JSON.parse(text) : {};
	const candidate = json.candidates?.[0];
	const grounding: GeminiGroundingMetadata | undefined = candidate?.groundingMetadata;
	const answer = (candidate?.content?.parts ?? []).map((part: { text?: string }) => part.text ?? "").join("");

	const sources: SearchSource[] = [];
	const citations: SearchCitation[] = [];
	const searchQueries: string[] = [];
	const seenUrls = new Set<string>();
	const chunks = grounding?.groundingChunks ?? [];
	for (const grChunk of chunks) {
		const uri = grChunk.web?.uri;
		if (uri && !seenUrls.has(uri)) {
			seenUrls.add(uri);
			sources.push({ title: grChunk.web?.title ?? uri, url: uri });
		}
	}
	for (const support of grounding?.groundingSupports ?? []) {
		const citedText = support.segment?.text;
		for (const idx of support.groundingChunkIndices ?? []) {
			const uri = chunks[idx]?.web?.uri;
			if (uri) citations.push({ url: uri, title: chunks[idx]?.web?.title ?? uri, citedText });
		}
	}
	for (const q of grounding?.webSearchQueries ?? []) {
		if (!searchQueries.includes(q)) searchQueries.push(q);
	}

	if (sources.length === 0) {
		throw new SearchProviderError("gemini", "Gemini native search returned no grounding sources", 424);
	}
	const limit = params.numSearchResults ?? params.limit;
	return {
		provider: "gemini",
		answer: answer || undefined,
		sources: limit && sources.length > limit ? sources.slice(0, limit) : sources,
		citations: citations.length > 0 ? citations : undefined,
		searchQueries: searchQueries.length > 0 ? searchQueries : undefined,
		model: json.modelVersion ?? model,
	};
}

/** Search provider for Google Gemini web search. */
export class GeminiProvider extends SearchProvider {
	readonly id = "gemini";
	readonly label = "Gemini";

	isAvailable(authStorage: AuthStorage): boolean {
		// Cheap, in-memory check — avoids driving the refresh pipeline during
		// the provider-chain probe. `searchGemini` calls `getOAuthAccess` which
		// will refresh lazily on the actual request.
		return hasGeminiOAuth(authStorage);
	}

	search(params: SearchParams): Promise<SearchResponse> {
		// Native-over-proxy: when canonical gemini-cli/antigravity OAuth is
		// absent but the active model speaks the Generative Language wire, reuse
		// its own API key + baseUrl instead of failing closed.
		const ctx = params.activeModelContext;
		if (!hasGeminiOAuth(params.authStorage) && ctx?.api === "google-generative-ai") {
			return searchGeminiViaGenerativeLanguage(params);
		}
		return searchGemini({
			query: params.query,
			system_prompt: params.systemPrompt,
			num_results: params.numSearchResults ?? params.limit,
			max_output_tokens: params.maxOutputTokens,
			temperature: params.temperature,
			google_search: params.googleSearch,
			code_execution: params.codeExecution,
			url_context: params.urlContext,
			signal: params.signal,
			authStorage: params.authStorage,
			sessionId: params.sessionId,
		});
	}
}
