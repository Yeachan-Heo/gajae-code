/**
 * Google Gemini CLI / Antigravity provider.
 * Shared implementation for both google-gemini-cli and google-antigravity providers.
 * Uses the Cloud Code Assist API endpoint to access Gemini and Anthropic model models.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { scheduler } from "node:timers/promises";
import { extractHttpStatusFromError, fetchWithRetry, readSseJson } from "@gajae-code/utils";
import { calculateCost } from "../models";
import type {
	Api,
	AssistantMessage,
	Context,
	Model,
	StreamFunction,
	StreamOptions,
	TextContent,
	ThinkingContent,
	ToolCall,
} from "../types";
import { normalizeSystemPrompts } from "../utils";
import { AssistantMessageEventStream } from "../utils/event-stream";
import { appendRawHttpRequestDumpFor400, type RawHttpRequestDump, withHttpStatus } from "../utils/http-inspector";
import { resolveRetryBudget } from "../utils/retry-budget";
// Refresh is the sole responsibility of AuthStorage (broker-aware, single-flighted);
// the stream provider trusts the access token threaded through `options.apiKey`.
import { normalizeSchemaForCCA } from "../utils/schema";
import {
	isForcedToolChoiceUnsupportedError,
	markToolChoiceIncapability,
	resolveToolChoice,
} from "../utils/tool-choice-capability";
import {
	ANTIGRAVITY_SYSTEM_INSTRUCTION,
	getAntigravityRequestHeaders,
	getGeminiCliHeaders,
} from "./google-gemini-headers";
import type { Content, FunctionCallingConfigMode, ThinkingConfig } from "./google-shared";
import {
	convertMessages,
	convertTools,
	type GoogleThinkingLevel,
	getGooglePromptBlockReason,
	isGoogleCandidateSafetyStopReason,
	isGooglePromptSafetyStopReason,
	isThinkingPart,
	mapStopReasonString,
	mapToolChoice,
	nextToolCallId,
	PROVIDER_SAFETY_STOP,
	pushBlockEndEvent,
	pushToolCallEvents,
	retainThoughtSignature,
	startTextOrThinkingBlock,
} from "./google-shared";

/**
 * Thinking level for Gemini 3 models. Re-exported from `google-shared` so existing
 * `import { GoogleThinkingLevel } from "./google-gemini-cli"` callers keep working.
 */
export type { GoogleThinkingLevel };

export interface GoogleGeminiCliOptions extends StreamOptions {
	toolChoice?: "auto" | "none" | "any" | "required";
	/**
	 * Thinking/reasoning configuration.
	 * - Gemini 2.x models: use `budgetTokens` to set the thinking budget
	 * - Gemini 3 models (gemini-3-pro-*, gemini-3-flash-*): use `level` instead
	 *
	 * When using `streamSimple`, this is handled automatically based on the model.
	 */
	thinking?: {
		enabled: boolean;
		/** Thinking budget in tokens. Use for Gemini 2.x models. */
		budgetTokens?: number;
		/** Thinking level. Use for Gemini 3 models (LOW/HIGH for Pro, MINIMAL/LOW/MEDIUM/HIGH for Flash). */
		level?: GoogleThinkingLevel;
	};
	projectId?: string;
}

const DEFAULT_ENDPOINT = "https://cloudcode-pa.googleapis.com";
const ANTIGRAVITY_DAILY_ENDPOINT = "https://daily-cloudcode-pa.googleapis.com";
const ANTIGRAVITY_SANDBOX_ENDPOINT = "https://daily-cloudcode-pa.sandbox.googleapis.com";
const ANTIGRAVITY_ENDPOINT_FALLBACKS = [ANTIGRAVITY_DAILY_ENDPOINT, ANTIGRAVITY_SANDBOX_ENDPOINT] as const;

export {
	ANTIGRAVITY_SYSTEM_INSTRUCTION,
	getAntigravityRequestHeaders,
	getGeminiCliHeaders,
	getGeminiCliUserAgent,
} from "./google-gemini-headers";

// Retry configuration
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;
const MAX_EMPTY_STREAM_RETRIES = 2;
const EMPTY_STREAM_BASE_DELAY_MS = 500;
const RATE_LIMIT_BUDGET_MS = 5 * 60 * 1000;
const CLAUDE_THINKING_BETA_HEADER = "interleaved-thinking-2025-05-14";
const GOOGLE_GEMINI_REFRESH_SKEW_MS = 60_000;
const ANTIGRAVITY_REFRESH_SKEW_MS = 60_000;

function isClaudeModel(modelId: string): boolean {
	return modelId.toLowerCase().includes("claude");
}

function needsClaudeThinkingBetaHeader(model: Model<"google-gemini-cli">): boolean {
	return model.provider === "google-antigravity" && model.id.startsWith("claude-") && model.reasoning;
}

function shouldInjectAntigravitySystemInstruction(modelId: string): boolean {
	const normalized = modelId.toLowerCase();
	return normalized.includes("claude") || normalized.includes("gemini-3");
}

/**
 * Extract a clean, user-friendly error message from Google API error response.
 * Parses JSON error responses and returns just the message field.
 */
function extractErrorMessage(errorText: string): string {
	try {
		const parsed = JSON.parse(errorText) as { error?: { message?: string } };
		if (parsed.error?.message) {
			return parsed.error.message;
		}
	} catch {
		// Not JSON, return as-is
	}
	return errorText;
}

interface GeminiCliApiKeyPayload {
	token?: unknown;
	projectId?: unknown;
	project_id?: unknown;
	refreshToken?: unknown;
	expiresAt?: unknown;
	refresh?: unknown;
	expires?: unknown;
}
interface ParsedGeminiCliCredentials {
	accessToken: string;
	projectId: string;
	refreshToken?: string;
	expiresAt?: number;
}

function normalizeExpiryMs(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
		return undefined;
	}
	return value < 10_000_000_000 ? value * 1000 : value;
}

export function parseGeminiCliCredentials(apiKeyRaw: string): ParsedGeminiCliCredentials {
	const invalidCredentialsMessage = "Invalid Google Cloud Code Assist credentials. Use /login to re-authenticate.";
	const missingCredentialsMessage =
		"Missing token or projectId in Google Cloud credentials. Use /login to re-authenticate.";

	let parsed: GeminiCliApiKeyPayload;
	try {
		parsed = JSON.parse(apiKeyRaw) as GeminiCliApiKeyPayload;
	} catch {
		throw new Error(invalidCredentialsMessage);
	}

	const projectId =
		typeof parsed.projectId === "string"
			? parsed.projectId
			: typeof parsed.project_id === "string"
				? parsed.project_id
				: undefined;

	if (typeof parsed.token !== "string" || typeof projectId !== "string") {
		throw new Error(missingCredentialsMessage);
	}

	const refreshToken =
		typeof parsed.refreshToken === "string"
			? parsed.refreshToken
			: typeof parsed.refresh === "string"
				? parsed.refresh
				: undefined;
	const expiresAt = normalizeExpiryMs(parsed.expiresAt ?? parsed.expires);

	return {
		accessToken: parsed.token,
		projectId,
		refreshToken,
		expiresAt,
	};
}

export function shouldRefreshGeminiCliCredentials(
	expiresAt: number | undefined,
	isAntigravity: boolean,
	nowMs = Date.now(),
): boolean {
	if (expiresAt === undefined) {
		return false;
	}

	const skewMs = isAntigravity ? ANTIGRAVITY_REFRESH_SKEW_MS : GOOGLE_GEMINI_REFRESH_SKEW_MS;
	return nowMs + skewMs >= expiresAt;
}

interface CloudCodeAssistRequest {
	project: string;
	model: string;
	request: {
		contents: Content[];
		sessionId?: string;
		systemInstruction?: { role?: string; parts: { text: string }[] };
		generationConfig?: {
			maxOutputTokens?: number;
			temperature?: number;
			topP?: number;
			topK?: number;
			minP?: number;
			presencePenalty?: number;
			repetitionPenalty?: number;
			thinkingConfig?: ThinkingConfig;
		};
		tools?: { functionDeclarations: Record<string, unknown>[] }[] | undefined;
		toolConfig?: {
			functionCallingConfig: {
				mode: FunctionCallingConfigMode;
			};
		};
		// Evidence: Real Antigravity IDE sends preambleConfig with
		// SYSTEM_INSTRUCTION_MODE_REPLACE to control how the server
		// interprets the system instruction (replace vs append).
		// Confirmed via network interception of official IDE traffic.
		preambleConfig?: {
			mode: "SYSTEM_INSTRUCTION_MODE_REPLACE";
		};
	};
	requestType?: string;
	userAgent?: string;
	requestId?: string;
}

interface CloudCodeAssistResponseChunk {
	response?: {
		candidates?: Array<{
			content?: {
				role: string;
				parts?: Array<{
					text?: string;
					thought?: boolean;
					thoughtSignature?: string;
					functionCall?: {
						name: string;
						args: Record<string, unknown>;
						id?: string;
					};
				}>;
			};
			finishReason?: string;
		}>;
		promptFeedback?: {
			blockReason?: string;
		};
		usageMetadata?: {
			promptTokenCount?: number;
			candidatesTokenCount?: number;
			thoughtsTokenCount?: number;
			totalTokenCount?: number;
			cachedContentTokenCount?: number;
		};
		modelVersion?: string;
		responseId?: string;
	};
	traceId?: string;
}

export const streamGoogleGeminiCli: StreamFunction<"google-gemini-cli"> = (
	model: Model<"google-gemini-cli">,
	context: Context,
	options?: GoogleGeminiCliOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();

	(async () => {
		const startTime = Date.now();
		let firstTokenTime: number | undefined;

		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: "google-gemini-cli" as Api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};
		let rawRequestDump: RawHttpRequestDump | undefined;

		try {
			const apiKeyRaw = options?.apiKey;
			if (!apiKeyRaw) {
				throw new Error("Google Cloud Code Assist requires OAuth authentication. Use /login to authenticate.");
			}

			const isAntigravity = model.provider === "google-antigravity";
			const parsedCredentials = parseGeminiCliCredentials(apiKeyRaw);
			// AuthStorage already refreshed credentials before threading them
			// here (see {@link OAUTH_REFRESH_SKEW_MS}). If the credential lands
			// expired we bail rather than POSTing a stale token; the next call
			// — driven by AuthStorage's invalidate+retry path — will carry a
			// fresh credential.
			if (
				shouldRefreshGeminiCliCredentials(parsedCredentials.expiresAt, isAntigravity) &&
				parsedCredentials.expiresAt !== undefined &&
				Date.now() >= parsedCredentials.expiresAt
			) {
				throw new Error(
					"OAuth token expired before request — please retry; AuthStorage will refresh on the next attempt.",
				);
			}
			const { accessToken, projectId } = parsedCredentials;

			const baseUrl = model.baseUrl?.trim();
			const endpoints = baseUrl ? [baseUrl] : isAntigravity ? ANTIGRAVITY_ENDPOINT_FALLBACKS : [DEFAULT_ENDPOINT];

			let requestBody = buildRequest(model, context, projectId, options, isAntigravity);
			const replacementPayload = await options?.onPayload?.(requestBody, model);
			if (replacementPayload !== undefined) {
				requestBody = replacementPayload as typeof requestBody;
			}
			const headers = isAntigravity
				? getAntigravityRequestHeaders() // Evidence: UA = "antigravity-ide" (disassembly 0x5ecb1dd)
				: getGeminiCliHeaders(model.id);

			const requestHeaders = {
				Authorization: `Bearer ${accessToken}`,
				"Content-Type": "application/json",
				Accept: "text/event-stream",
				...headers,
				...(needsClaudeThinkingBetaHeader(model) ? { "anthropic-beta": CLAUDE_THINKING_BETA_HEADER } : {}),
				...(options?.headers ?? {}),
			};
			let requestBodyJson = JSON.stringify(requestBody);
			rawRequestDump = {
				provider: model.provider,
				api: output.api,
				model: model.id,
				method: "POST",
				body: requestBody,
				headers: requestHeaders,
			};

			const sentForcedToolChoice =
				(requestBody.request.toolConfig?.functionCallingConfig?.mode === "ANY" ||
					requestBody.request.toolConfig?.functionCallingConfig?.mode === "VALIDATED") &&
				options?.toolChoice !== undefined &&
				options.toolChoice !== "auto" &&
				options.toolChoice !== "none";
			let response = await fetchWithRetry(
				attempt => `${endpoints[Math.min(attempt, endpoints.length - 1)]}/v1internal:streamGenerateContent?alt=sse`,
				{
					method: "POST",
					headers: requestHeaders,
					body: requestBodyJson,
					signal: options?.signal,
					maxAttempts: resolveRetryBudget(options?.requestMaxRetries, MAX_RETRIES) + 1,
					defaultDelayMs: attempt => BASE_DELAY_MS * 2 ** attempt,
					maxDelayMs: options?.maxRetryDelayMs ?? RATE_LIMIT_BUDGET_MS,
					fetch: options?.fetch,
				},
			);
			if (!response.ok && sentForcedToolChoice) {
				const errorText = await response.text();
				const error = withHttpStatus(
					new Error(`Cloud Code Assist API error (${response.status}): ${extractErrorMessage(errorText)}`),
					response.status,
				);
				if (firstTokenTime === undefined && isForcedToolChoiceUnsupportedError(error, true)) {
					const beforeMark = resolveToolChoice(model, options?.toolChoice);
					markToolChoiceIncapability(model, "auto", error.message);
					stream.push({
						type: "toolChoiceIncapability",
						api: model.api,
						provider: model.provider,
						model: model.id,
						requestedLevel: beforeMark.requestedLevel,
						resolvedLevel: "auto",
						reason: error.message,
						registryKey: beforeMark.registryKey,
					});
					requestBody = {
						...requestBody,
						request: { ...requestBody.request, toolConfig: undefined },
					};
					requestBodyJson = JSON.stringify(requestBody);
					rawRequestDump = { ...rawRequestDump, body: requestBody };
					response = await fetchWithRetry(
						attempt =>
							`${endpoints[Math.min(attempt, endpoints.length - 1)]}/v1internal:streamGenerateContent?alt=sse`,
						{
							method: "POST",
							headers: requestHeaders,
							body: requestBodyJson,
							signal: options?.signal,
							maxAttempts: 1,
							defaultDelayMs: attempt => BASE_DELAY_MS * 2 ** attempt,
							maxDelayMs: options?.maxRetryDelayMs ?? RATE_LIMIT_BUDGET_MS,
							fetch: options?.fetch,
						},
					);
				} else {
					throw error;
				}
			}
			if (!response.ok) {
				const errorText = await response.text();
				throw withHttpStatus(
					new Error(`Cloud Code Assist API error (${response.status}): ${extractErrorMessage(errorText)}`),
					response.status,
				);
			}
			const requestUrl = response.url;

			let started = false;
			const ensureStarted = () => {
				if (!started) {
					if (!firstTokenTime) firstTokenTime = Date.now();
					stream.push({ type: "start", partial: output });
					started = true;
				}
			};

			const resetOutput = () => {
				output.content = [];
				output.usage = {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				};
				output.stopReason = "stop";
				output.errorMessage = undefined;
				output.timestamp = Date.now();
				started = false;
			};

			const streamResponse = async (activeResponse: Response): Promise<boolean> => {
				if (!activeResponse.body) {
					throw new Error("No response body");
				}

				let hasContent = false;
				let currentBlock: TextContent | ThinkingContent | null = null;
				const blocks = output.content;
				const blockIndex = () => blocks.length - 1;

				for await (const chunk of readSseJson<CloudCodeAssistResponseChunk>(
					activeResponse.body!,
					options?.signal,
					event => options?.onSseEvent?.({ event: event.event, data: event.data, raw: [...event.raw] }, model),
				)) {
					const responseData = chunk.response;
					if (!responseData) continue;

					const candidate = responseData.candidates?.[0];
					if (candidate?.content?.parts) {
						for (const part of candidate.content.parts) {
							if (part.text !== undefined) {
								hasContent = true;
								const isThinking = isThinkingPart(part);
								if (
									!currentBlock ||
									(isThinking && currentBlock.type !== "thinking") ||
									(!isThinking && currentBlock.type !== "text")
								) {
									if (currentBlock) {
										pushBlockEndEvent(currentBlock, blockIndex(), output, stream);
									}
									currentBlock = startTextOrThinkingBlock(isThinking, output, stream, ensureStarted);
								}
								if (currentBlock.type === "thinking") {
									currentBlock.thinking += part.text;
									currentBlock.thinkingSignature = retainThoughtSignature(
										currentBlock.thinkingSignature,
										part.thoughtSignature,
									);
									stream.push({
										type: "thinking_delta",
										contentIndex: blockIndex(),
										delta: part.text,
										partial: output,
									});
								} else {
									currentBlock.text += part.text;
									currentBlock.textSignature = retainThoughtSignature(
										currentBlock.textSignature,
										part.thoughtSignature,
									);
									stream.push({
										type: "text_delta",
										contentIndex: blockIndex(),
										delta: part.text,
										partial: output,
									});
								}
							}

							if (part.functionCall) {
								hasContent = true;
								if (currentBlock) {
									pushBlockEndEvent(currentBlock, blockIndex(), output, stream);
									currentBlock = null;
								}

								const providedId = part.functionCall.id;
								const needsNewId =
									!providedId || output.content.some(b => b.type === "toolCall" && b.id === providedId);
								const toolCallId = needsNewId ? nextToolCallId(part.functionCall.name || "tool") : providedId;

								const toolCall: ToolCall = {
									type: "toolCall",
									id: toolCallId,
									name: part.functionCall.name || "",
									arguments: part.functionCall.args as Record<string, unknown>,
									...(part.thoughtSignature && { thoughtSignature: part.thoughtSignature }),
								};

								output.content.push(toolCall);
								ensureStarted();
								pushToolCallEvents(toolCall, blockIndex(), output, stream);
							}
						}
					}

					if (candidate?.finishReason) {
						if (isGoogleCandidateSafetyStopReason(candidate.finishReason)) {
							hasContent = true;
							output.errorKind = PROVIDER_SAFETY_STOP;
							output.stopReason = "error";
						} else if (output.errorKind !== PROVIDER_SAFETY_STOP) {
							output.stopReason = mapStopReasonString(candidate.finishReason);
							if (output.stopReason === "stop" && output.content.some(b => b.type === "toolCall")) {
								output.stopReason = "toolUse";
							}
						}
					}

					const blockReason = getGooglePromptBlockReason(responseData.promptFeedback);
					if (blockReason) {
						hasContent = true;
						if (isGooglePromptSafetyStopReason(blockReason)) {
							output.errorKind = PROVIDER_SAFETY_STOP;
							output.stopReason = "error";
						} else if (output.errorKind !== PROVIDER_SAFETY_STOP) {
							output.stopReason = "error";
						}
					}

					if (responseData.usageMetadata) {
						// promptTokenCount includes cachedContentTokenCount, so subtract to get fresh input
						const promptTokens = responseData.usageMetadata.promptTokenCount || 0;
						const cacheReadTokens = responseData.usageMetadata.cachedContentTokenCount || 0;
						const thinkingTokens = responseData.usageMetadata.thoughtsTokenCount || 0;
						output.usage = {
							input: promptTokens - cacheReadTokens,
							output: (responseData.usageMetadata.candidatesTokenCount || 0) + thinkingTokens,
							cacheRead: cacheReadTokens,
							cacheWrite: 0,
							totalTokens: responseData.usageMetadata.totalTokenCount || 0,
							...(thinkingTokens > 0 ? { reasoningTokens: thinkingTokens } : {}),
							cost: {
								input: 0,
								output: 0,
								cacheRead: 0,
								cacheWrite: 0,
								total: 0,
							},
						};
						calculateCost(model, output.usage);
					}
				}

				if (currentBlock) {
					pushBlockEndEvent(currentBlock, blockIndex(), output, stream);
				}

				return hasContent;
			};

			let receivedContent = false;
			let currentResponse = response;

			const emptyStreamRetryBudget = resolveRetryBudget(options?.streamMaxRetries, MAX_EMPTY_STREAM_RETRIES);
			for (let emptyAttempt = 0; emptyAttempt <= emptyStreamRetryBudget; emptyAttempt++) {
				if (options?.signal?.aborted) {
					throw new Error("Request was aborted");
				}

				if (emptyAttempt > 0) {
					const backoffMs = EMPTY_STREAM_BASE_DELAY_MS * 2 ** (emptyAttempt - 1);
					try {
						await scheduler.wait(backoffMs, { signal: options?.signal });
					} catch {
						// Normalize AbortError to expected message for consistent error handling
						throw new Error("Request was aborted");
					}

					if (!requestUrl) {
						throw new Error("Missing request URL");
					}

					currentResponse = await (options?.fetch ?? fetch)(requestUrl, {
						method: "POST",
						headers: requestHeaders,
						body: requestBodyJson,
						signal: options?.signal,
					});

					if (!currentResponse.ok) {
						const retryErrorText = await currentResponse.text();
						throw withHttpStatus(
							new Error(`Cloud Code Assist API error (${currentResponse.status}): ${retryErrorText}`),
							currentResponse.status,
						);
					}
				}

				const streamed = await streamResponse(currentResponse);
				if (streamed) {
					receivedContent = true;
					break;
				}

				if (emptyAttempt < emptyStreamRetryBudget) {
					resetOutput();
				}
			}

			if (!receivedContent) {
				throw new Error("Cloud Code Assist API returned an empty response");
			}

			if (options?.signal?.aborted) {
				throw new Error("Request was aborted");
			}

			if (output.stopReason === "aborted" || output.stopReason === "error") {
				throw new Error(output.errorMessage ?? "An unknown error occurred");
			}

			output.duration = Date.now() - startTime;
			if (firstTokenTime) output.ttft = firstTokenTime - startTime;
			stream.push({ type: "done", reason: output.stopReason, message: output });
			stream.end();
		} catch (error) {
			for (const block of output.content) {
				if ("index" in block) {
					delete (block as { index?: number }).index;
				}
			}
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorStatus = extractHttpStatusFromError(error);
			output.errorMessage = await appendRawHttpRequestDumpFor400(
				error instanceof Error ? error.message : JSON.stringify(error),
				error,
				rawRequestDump,
			);
			output.duration = Date.now() - startTime;
			if (firstTokenTime) output.ttft = firstTokenTime - startTime;
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
};

const INT63_MASK = (1n << 63n) - 1n;
const ANTIGRAVITY_RANDOM_BOUND = 9_000_000_000_000_000_000n;

function formatSignedDecimalSessionId(value: bigint): string {
	return `-${value.toString()}`;
}

function deriveSignedDecimalFromHash(text: string): string {
	const digest = createHash("sha256").update(text).digest();
	let value = 0n;
	for (let index = 0; index < 8; index += 1) {
		value = (value << 8n) | BigInt(digest[index] ?? 0);
	}
	return formatSignedDecimalSessionId(value & INT63_MASK);
}

function randomBoundedInt63(maxExclusive: bigint): bigint {
	while (true) {
		const bytes = randomBytes(8);
		let value = 0n;
		for (const byte of bytes) {
			value = (value << 8n) | BigInt(byte);
		}
		value &= INT63_MASK;
		if (value < maxExclusive) {
			return value;
		}
	}
}

function randomSignedDecimalSessionId(): string {
	return formatSignedDecimalSessionId(randomBoundedInt63(ANTIGRAVITY_RANDOM_BOUND));
}

function getFirstUserTextForAntigravitySession(context: Context): string | undefined {
	for (const message of context.messages) {
		if (message.role !== "user") {
			continue;
		}

		if (typeof message.content === "string") {
			return message.content;
		}

		if (Array.isArray(message.content)) {
			const firstTextPart = message.content.find((item): item is TextContent => item.type === "text");
			return firstTextPart?.text;
		}

		return undefined;
	}

	return undefined;
}

function deriveAntigravitySessionId(context: Context): string {
	const text = getFirstUserTextForAntigravitySession(context);
	if (text && text.trim().length > 0) {
		return deriveSignedDecimalFromHash(text);
	}

	return randomSignedDecimalSessionId();
}

function normalizeAntigravityTools(
	tools: CloudCodeAssistRequest["request"]["tools"],
): CloudCodeAssistRequest["request"]["tools"] {
	return tools?.map(tool => ({
		...tool,
		functionDeclarations: tool.functionDeclarations.map(declaration => {
			if ("parameters" in declaration) {
				return declaration;
			}

			const { parametersJsonSchema, ...rest } = declaration;
			return {
				...rest,
				parameters: normalizeSchemaForCCA(parametersJsonSchema),
			};
		}),
	}));
}

export function buildRequest(
	model: Model<"google-gemini-cli">,
	context: Context,
	projectId: string,
	options: GoogleGeminiCliOptions = {},
	isAntigravity = false,
): CloudCodeAssistRequest {
	const systemPrompts = normalizeSystemPrompts(context.systemPrompt);
	const contents = convertMessages(model, context);
	const generationConfig: CloudCodeAssistRequest["request"]["generationConfig"] = {};
	if (options.temperature !== undefined) {
		generationConfig.temperature = options.temperature;
	}
	if (options.maxTokens !== undefined) {
		generationConfig.maxOutputTokens = options.maxTokens;
	}
	if (options.topP !== undefined) {
		generationConfig.topP = options.topP;
	}
	if (options.topK !== undefined) {
		generationConfig.topK = options.topK;
	}
	if (options.minP !== undefined) {
		generationConfig.minP = options.minP;
	}
	if (options.presencePenalty !== undefined) {
		generationConfig.presencePenalty = options.presencePenalty;
	}
	if (options.repetitionPenalty !== undefined) {
		generationConfig.repetitionPenalty = options.repetitionPenalty;
	}

	// Thinking config
	if (options.thinking?.enabled && model.reasoning) {
		generationConfig.thinkingConfig = {
			includeThoughts: true,
		};
		// Gemini 3 models use thinkingLevel, older models use thinkingBudget
		if (options.thinking.level !== undefined) {
			// Cast to any since our GoogleThinkingLevel mirrors Google's ThinkingLevel enum values
			generationConfig.thinkingConfig.thinkingLevel = options.thinking.level as any;
		} else if (options.thinking.budgetTokens !== undefined) {
			generationConfig.thinkingConfig.thinkingBudget = options.thinking.budgetTokens;
		}
	}

	const request: CloudCodeAssistRequest["request"] = {
		contents,
	};

	if (isAntigravity) {
		request.sessionId = deriveAntigravitySessionId(context);
	}

	// System instruction must be object with parts, not plain string.
	// Evidence: Real Antigravity IDE sets role: "user" on systemInstruction
	// (confirmed in request body dumps from network interception).
	// Only applied for Antigravity path — standard gemini-cli omits role.
	if (systemPrompts.length > 0) {
		request.systemInstruction = {
			...(isAntigravity && { role: "user" }),
			parts: systemPrompts.map(text => ({ text })),
		};
	}

	if (Object.keys(generationConfig).length > 0) {
		request.generationConfig = generationConfig;
	}

	const resolvedToolChoice = resolveToolChoice(model, options.toolChoice);
	if (context.tools && context.tools.length > 0) {
		const convertedTools = convertTools(context.tools, model);
		request.tools = isAntigravity ? normalizeAntigravityTools(convertedTools) : convertedTools;
		const resolved = resolvedToolChoice;
		if (resolved.resolvedChoice) {
			request.toolConfig = {
				functionCallingConfig: {
					mode: mapToolChoice(resolved.resolvedChoice as string),
				},
			};
		}
	}

	if (isAntigravity && !isClaudeModel(model.id) && request.generationConfig?.maxOutputTokens !== undefined) {
		delete request.generationConfig.maxOutputTokens;
		if (Object.keys(request.generationConfig).length === 0) {
			delete request.generationConfig;
		}
	}

	// Claude Antigravity: use VALIDATED mode only when tools are present
	// and the caller hasn't explicitly requested "none" tool choice.
	//
	// Evidence:
	// - Real Antigravity IDE sends VALIDATED for Claude requests with tools
	//   (confirmed via network interception of official IDE traffic)
	// - The original GJC code used resolvedToolChoice.resolvedLevel to gate
	//   VALIDATED, but the real IDE doesn't check tool choice resolution —
	//   it sends VALIDATED whenever tools exist and toolChoice != "none"
	// - omp reference: packages/ai/src/providers/google-gemini-cli.ts
	//   `antigravityClaudeToolConfig` guard pattern
	if (
		isAntigravity &&
		isClaudeModel(model.id) &&
		context.tools &&
		context.tools.length > 0 &&
		options?.toolChoice !== "none"
	) {
		request.toolConfig = {
			functionCallingConfig: {
				mode: "VALIDATED" as FunctionCallingConfigMode,
			},
		};
	}

	// Stateless system instruction injection: send on EVERY Antigravity request.
	// This is safer than client-side session dedup because:
	// - preambleConfig server-side persistence is unproven
	// - A failed first request would poison the session if we skipped injection
	// - Token cost is acceptable for Antigravity's long-context models
	//
	// Evidence:
	// - Real Antigravity IDE sends the full system prompt on every request
	//   (confirmed via repeated request dumps — no client-side dedup observed)
	// - The [ignore] wrapper was a GJC-original addition not present in the
	//   real IDE wire format. Removed for byte-faithful emulation.
	// - preambleConfig: { mode: "SYSTEM_INSTRUCTION_MODE_REPLACE" } is the
	//   mechanism the real IDE uses to deliver system instructions. Without it,
	//   the server may append (not replace) the system prompt.
	// - omp reference: `sessionSystemInstructionSent` Map was omp's approach;
	//   we chose stateless injection for simplicity and safety.
	if (isAntigravity && shouldInjectAntigravitySystemInstruction(model.id)) {
		const existingParts = request.systemInstruction?.parts ?? [];
		request.systemInstruction = {
			role: "user",
			parts: [{ text: ANTIGRAVITY_SYSTEM_INSTRUCTION }, ...existingParts],
		};
		request.preambleConfig = {
			mode: "SYSTEM_INSTRUCTION_MODE_REPLACE",
		};
	}

	return {
		project: projectId,
		model: model.id,
		request,
		...(isAntigravity
			? {
					requestType: "agent",
					userAgent: "antigravity",
					requestId: `agent-${randomUUID()}`,
				}
			: {}),
	};
}
