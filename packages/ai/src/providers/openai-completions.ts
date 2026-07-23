import { $credentialEnv, $env, $inheritedEnv, extractHttpStatusFromError, logger } from "@gajae-code/utils";
import OpenAI from "openai";
import type {
	ChatCompletionAssistantMessageParam,
	ChatCompletionChunk,
	ChatCompletionContentPart,
	ChatCompletionContentPartImage,
	ChatCompletionContentPartText,
	ChatCompletionMessageParam,
	ChatCompletionToolMessageParam,
} from "openai/resources/chat/completions";
import packageJson from "../../package.json" with { type: "json" };
import { type Effort, getSupportedEfforts } from "../model-thinking";
import { calculateCost } from "../models";
import { getEnvApiKey } from "../stream";
import {
	type AssistantMessage,
	type Context,
	type FetchImpl,
	type Message,
	type MessageAttribution,
	type Model,
	type OpenAICompat,
	type ProviderSessionState,
	resolveServiceTier,
	type ServiceTier,
	type StopReason,
	type StreamFunction,
	type StreamOptions,
	shouldSendServiceTier,
	type TextContent,
	type ThinkingContent,
	type Tool,
	type ToolCall,
	type ToolChoice,
	type ToolResultMessage,
} from "../types";
import { normalizeSystemPrompts, sanitizeJsonStrings } from "../utils";
import { createAbortSourceTracker } from "../utils/abort";
import { AssistantMessageEventStream } from "../utils/event-stream";
import { transportFailureFacts } from "../utils/fallback-transport";
import { toFirepassWireModelId, toFireworksWireModelId } from "../utils/fireworks-model-id";
import {
	type CapturedHttpErrorResponse,
	finalizeErrorMessage,
	type RawHttpRequestDump,
	rewriteCopilotError,
} from "../utils/http-inspector";
import {
	createWatchdog,
	getOpenAIStreamIdleTimeoutMs,
	getStreamFirstEventTimeoutMs,
	iterateWithIdleTimeout,
} from "../utils/idle-iterator";
import { isCompleteJson, parseStreamingJson } from "../utils/json-parse";
import { parseGitHubCopilotApiKey } from "../utils/oauth/github-copilot";
import { getKimiCommonHeaders } from "../utils/oauth/kimi";
import { notifyProviderResponse } from "../utils/provider-response";
import { callWithCopilotModelRetry } from "../utils/retry";
import { resolveRetryBudget } from "../utils/retry-budget";
import { adaptSchemaForStrict, flattenToolRootCombinators, NO_STRICT, toolWireSchema } from "../utils/schema";
import { wrapFetchForSseDebug } from "../utils/sse-debug";
import { type HealedToolCall, modelMayLeakKimiToolCalls, ToolCallHealer } from "../utils/tool-call-healing";
import { isForcedToolChoice, mapToOpenAICompletionsToolChoice } from "../utils/tool-choice";
import {
	isForcedToolChoiceUnsupportedError,
	markToolChoiceIncapability,
	resolveToolChoice,
} from "../utils/tool-choice-capability";
import { COMPOSER_EDIT_DISCIPLINE_PROMPT, isComposerHarnessModel } from "./composer-discipline";
import {
	buildCopilotDynamicHeaders,
	hasCopilotVisionInput,
	resolveGitHubCopilotBaseUrl,
} from "./github-copilot-headers";
import { wrapOpenAIFetchForBoundedRateLimits } from "./openai-bounded-rate-limits";
import { detectOpenAICompat, type ResolvedOpenAICompat, resolveOpenAICompat } from "./openai-completions-compat";
import {
	applyOpenAIRequestTransformBody,
	applyOpenAIRequestTransformHeaders,
	wrapFetchForOpenAIRequestTransform,
} from "./openai-request-transform";
import { createInitialResponsesAssistantMessage } from "./openai-responses-shared";
import { transformMessages } from "./transform-messages";
import { joinTextWithImagePlaceholder, NON_VISION_IMAGE_PLACEHOLDER } from "./vision-guard";

const OPENAI_DEFAULT_BASE_URL = "https://api.openai.com/v1";
const OPENAI_DEFAULT_BASE_URL_HOST = "api.openai.com";

function isDefaultOpenAIBaseUrl(baseUrl: string): boolean {
	try {
		const url = new URL(baseUrl);
		return url.hostname === OPENAI_DEFAULT_BASE_URL_HOST && (url.pathname === "" || url.pathname === "/v1");
	} catch {
		return baseUrl === OPENAI_DEFAULT_BASE_URL;
	}
}

function resolveOpenAIProviderBaseUrl(
	baseUrl: string | undefined,
	authCredentialType: "api_key" | "oauth" | undefined,
): string {
	if (authCredentialType === "oauth") return OPENAI_DEFAULT_BASE_URL;
	const envBaseUrl = $inheritedEnv("OPENAI_BASE_URL") ?? $env.OPENAI_BASE_URL?.trim();
	const configuredBaseUrl = baseUrl?.trim();
	if (envBaseUrl && (!configuredBaseUrl || isDefaultOpenAIBaseUrl(configuredBaseUrl))) {
		return envBaseUrl;
	}
	return configuredBaseUrl || envBaseUrl || OPENAI_DEFAULT_BASE_URL;
}

/**
 * Normalize tool call ID for Mistral.
 * Mistral requires tool IDs to be exactly 9 alphanumeric characters (a-z, A-Z, 0-9).
 */
function normalizeMistralToolId(id: string, isMistral: boolean): string {
	if (!isMistral) return id;
	// Remove non-alphanumeric characters
	let normalized = id.replace(/[^a-zA-Z0-9]/g, "");
	// Mistral requires exactly 9 characters
	if (normalized.length < 9) {
		// Pad with deterministic characters based on original ID to ensure matching
		const padding = "ABCDEFGHI";
		normalized = normalized + padding.slice(0, 9 - normalized.length);
	} else if (normalized.length > 9) {
		normalized = normalized.slice(0, 9);
	}
	return normalized;
}

/**
 * Normalize OpenAI-compatible streaming `delta.content` into plain text.
 *
 * Most providers stream `delta.content` as a string, but some (notably Mistral
 * Medium 3.5 / `mistral-medium-2604`) return an array of typed content parts
 * — e.g. `[{ type: "text", text: "Hello" }]`. Without normalization those
 * parts get string-coerced via `text += array`, producing the literal
 * `[object Object]` sequences observed in issue #911.
 *
 * Returns the joined text. Non-text parts and unknown shapes are skipped so
 * we never emit JS object sigils as visible output.
 */
function normalizeStreamingContentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		let out = "";
		for (const part of content) {
			if (typeof part === "string") {
				out += part;
			} else if (part && typeof part === "object") {
				const obj = part as { type?: unknown; text?: unknown };
				if ((obj.type === undefined || obj.type === "text") && typeof obj.text === "string") {
					out += obj.text;
				}
			}
		}
		return out;
	}
	if (content && typeof content === "object") {
		const obj = content as { type?: unknown; text?: unknown };
		if ((obj.type === undefined || obj.type === "text") && typeof obj.text === "string") {
			return obj.text;
		}
	}
	return "";
}

function serializeToolArguments(value: unknown): string {
	if (value && typeof value === "object" && !Array.isArray(value)) {
		try {
			return JSON.stringify(sanitizeJsonStrings(value));
		} catch {
			return "{}";
		}
	}

	if (typeof value === "string") {
		const trimmed = value.trim();
		if (trimmed.length === 0) return "{}";
		try {
			const parsed = JSON.parse(trimmed);
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				return JSON.stringify(sanitizeJsonStrings(parsed));
			}
		} catch {}
		return "{}";
	}

	return "{}";
}

/**
 * Check if conversation messages contain tool calls or tool results.
 * This is needed because Anthropic (via proxy) requires the tools param
 * to be present when messages include tool_calls or tool role messages.
 */
function hasToolHistory(messages: Message[]): boolean {
	for (const msg of messages) {
		if (msg.role === "toolResult") {
			return true;
		}
		if (msg.role === "assistant") {
			if (msg.content.some(block => block.type === "toolCall")) {
				return true;
			}
		}
	}
	return false;
}

/**
 * Identify "real progress" stream chunks vs. keepalives, role-only preambles,
 * and empty `{choices:[]}` no-ops emitted by some OpenAI-compatible endpoints.
 * Without this filter, every keepalive resets `iterateWithIdleTimeout`'s
 * deadline, so a provider that streams nothing but pings keeps the watchdog
 * asleep indefinitely — observed against z.ai/GLM via OpenRouter where a
 * subagent stalled for hours with no error surfaced.
 *
 * A chunk counts as progress when it carries terminal usage, a finish reason,
 * or any model-produced delta (content / tool calls / reasoning / refusal).
 * Role-only `delta: { role: "assistant" }` preambles do NOT count; we want the
 * (longer) first-event timeout to keep governing until real output appears.
 */
export function isOpenAICompletionsProgressChunk(chunk: unknown): boolean {
	if (!chunk || typeof chunk !== "object") return false;
	const record = chunk as {
		usage?: unknown;
		choices?: ReadonlyArray<{
			finish_reason?: unknown;
			usage?: unknown;
			delta?: {
				content?: unknown;
				tool_calls?: unknown;
				reasoning?: unknown;
				reasoning_content?: unknown;
				reasoning_text?: unknown;
				refusal?: unknown;
			};
		}>;
	};
	if (record.usage) return true;
	const choice = Array.isArray(record.choices) ? record.choices[0] : undefined;
	if (!choice) return false;
	if (choice.finish_reason) return true;
	if (choice.usage) return true;
	const delta = choice.delta;
	if (!delta) return false;
	const content = delta.content;
	if (typeof content === "string" ? content.length > 0 : Array.isArray(content) && content.length > 0) return true;
	if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) return true;
	if (typeof delta.reasoning === "string" && delta.reasoning.length > 0) return true;
	if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) return true;
	if (typeof delta.reasoning_text === "string" && delta.reasoning_text.length > 0) return true;
	if (typeof delta.refusal === "string" && delta.refusal.length > 0) return true;
	return false;
}

export interface OpenAICompletionsOptions extends StreamOptions {
	toolChoice?: ToolChoice;
	reasoning?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	/** Force-disable reasoning where supported, or request the lowest effort on generic effort endpoints. */
	disableReasoning?: boolean;
	serviceTier?: ServiceTier;
}

type OpenAICompletionsParams = Omit<OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming, "reasoning_effort"> & {
	top_k?: number;
	min_p?: number;
	repetition_penalty?: number;
	thinking?: { type: "enabled" | "disabled" };
	enable_thinking?: boolean;
	chat_template_kwargs?: { enable_thinking: boolean };
	reasoning?: { effort?: string } | { enabled: false };
	reasoning_effort?: OpenAICompletionsOptions["reasoning"];
	provider?: OpenAICompat["openRouterRouting"];
	providerOptions?: { gateway?: { only?: string[]; order?: string[] } };
};

type AppliedToolStrictMode = "mixed" | "all_strict" | "none";
type ToolStrictModeOverride = Exclude<ResolvedOpenAICompat["toolStrictMode"], "mixed"> | undefined;

type BuiltOpenAICompletionTools = {
	tools: OpenAI.Chat.Completions.ChatCompletionTool[];
	toolStrictMode: AppliedToolStrictMode;
};

const OPENAI_COMPLETIONS_PROVIDER_SESSION_STATE_PREFIX = "openai-completions:";

type OpenAICompletionsProviderSessionState = ProviderSessionState & {
	strictToolsDisabled: boolean;
};

function createOpenAICompletionsProviderSessionState(): OpenAICompletionsProviderSessionState {
	const state: OpenAICompletionsProviderSessionState = {
		strictToolsDisabled: false,
		close: () => {
			state.strictToolsDisabled = false;
		},
	};
	return state;
}

function getOpenAICompletionsProviderSessionState(
	model: Model<"openai-completions">,
	baseUrl: string | undefined,
	providerSessionState: Map<string, ProviderSessionState> | undefined,
): OpenAICompletionsProviderSessionState | undefined {
	if (!providerSessionState) return undefined;
	const key = `${OPENAI_COMPLETIONS_PROVIDER_SESSION_STATE_PREFIX}${model.provider}:${baseUrl ?? ""}:${model.id}`;
	const existing = providerSessionState.get(key) as OpenAICompletionsProviderSessionState | undefined;
	if (existing) return existing;
	const created = createOpenAICompletionsProviderSessionState();
	providerSessionState.set(key, created);
	return created;
}

function isOpenRouterAnthropicModel(model: Model<"openai-completions">): boolean {
	return model.provider === "openrouter" && model.id.toLowerCase().startsWith("anthropic/");
}

function isCompiledGrammarTooLargeStrictError(
	error: unknown,
	capturedErrorResponse: CapturedHttpErrorResponse | undefined,
): boolean {
	const status = extractHttpStatusFromError(error) ?? capturedErrorResponse?.status;
	if (status !== 400) return false;
	const messageParts = [error instanceof Error ? error.message : undefined, capturedErrorResponse?.bodyText]
		.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
		.join("\n");
	return (
		/invalid_request_error/i.test(messageParts) &&
		/compiled grammar/i.test(messageParts) &&
		/too large/i.test(messageParts)
	);
}
function hasContentFilterSafetyCode(capturedErrorResponse: CapturedHttpErrorResponse | undefined): boolean {
	const bodyJson = capturedErrorResponse?.bodyJson;
	if (typeof bodyJson !== "object" || bodyJson === null || Array.isArray(bodyJson)) return false;
	if (Reflect.get(bodyJson, "code") === "content_filter") return true;

	const error = Reflect.get(bodyJson, "error");
	return (
		typeof error === "object" &&
		error !== null &&
		!Array.isArray(error) &&
		Reflect.get(error, "code") === "content_filter"
	);
}

// LIMITATION: The think tag parser uses naive string matching for <think>/<thinking> tags.
// If MiniMax models output these literal strings in code blocks, XML examples, or explanations,
// they will be incorrectly consumed as thinking delimiters, truncating visible output.
// A streaming parser with arbitrary chunk boundaries cannot reliably detect code block context.
// This is acceptable because: (1) only enabled for minimax-code providers, (2) MiniMax models
// use these tags as their actual thinking format, and (3) false positives are rare in practice.
const MINIMAX_THINK_OPEN_TAGS = ["<think>", "<thinking>"] as const;
const MINIMAX_THINK_CLOSE_TAGS = ["</think>", "</thinking>"] as const;

function findFirstTag(text: string, tags: readonly string[]): { index: number; tag: string } | undefined {
	let earliestIndex = Number.POSITIVE_INFINITY;
	let earliestTag: string | undefined;
	for (const tag of tags) {
		const index = text.indexOf(tag);
		if (index !== -1 && index < earliestIndex) {
			earliestIndex = index;
			earliestTag = tag;
		}
	}
	if (!earliestTag) return undefined;
	return { index: earliestIndex, tag: earliestTag };
}

function getTrailingPartialTag(text: string, tags: readonly string[]): string {
	let maxLength = 0;
	for (const tag of tags) {
		const maxCandidateLength = Math.min(tag.length - 1, text.length);
		for (let length = maxCandidateLength; length > 0; length--) {
			if (text.endsWith(tag.slice(0, length))) {
				if (length > maxLength) maxLength = length;
				break;
			}
		}
	}
	if (maxLength === 0) return "";
	return text.slice(-maxLength);
}

// DeepSeek models leak chat-template special tokens (e.g. `<｜tool_calls_begin｜>`,
// `<｜DSML｜tool_calls｜>`) into visible `content` deltas when hosted behind providers
// (such as NVIDIA NIM) that don't strip them server-side. The structured `tool_calls`
// payload is still emitted correctly — we only need to filter the leaked markers from
// user-visible text. Tokens use either fullwidth pipes (｜, U+FF5C) or ASCII pipes.
// Body is restricted to identifier-like chars (with the DeepSeek tokenizer's `▁`),
// capped at a sane length to avoid swallowing legitimate angle-bracket text.
const DEEPSEEK_SPECIAL_TOKEN_REGEX = /<(?:｜|\|)[A-Za-z0-9_.｜|▁]{1,64}(?:｜|\|)>/g;
const DEEPSEEK_SPECIAL_TOKEN_AT_START_REGEX = /^\s*<(?:｜|\|)[A-Za-z0-9_.｜|▁]{1,64}(?:｜|\|)>/;
const DEEPSEEK_SPECIAL_TOKEN_AT_END_REGEX = /<(?:｜|\|)[A-Za-z0-9_.｜|▁]{1,64}(?:｜|\|)>\s*$/;
const DEEPSEEK_OPEN_DELIMS = ["<｜", "<|"] as const;

function stripDeepseekSpecialTokens(text: string): string {
	const stripped = text.replace(DEEPSEEK_SPECIAL_TOKEN_REGEX, "");
	if (stripped === text) return text;

	let normalized = stripped;
	if (DEEPSEEK_SPECIAL_TOKEN_AT_START_REGEX.test(text)) normalized = normalized.replace(/^\s+/u, "");
	if (DEEPSEEK_SPECIAL_TOKEN_AT_END_REGEX.test(text)) normalized = normalized.replace(/\s+$/u, "");
	return normalized;
}

// Find any trailing partial `<｜...` (or `<|...`) that has not yet been closed by a
// matching `｜>`/`|>`, so it can be held back until the next chunk arrives. A solo
// trailing `<` is also held in case it is the start of a new token.
function getTrailingPartialDeepseekToken(text: string): string {
	let bestIdx = -1;
	for (const delim of DEEPSEEK_OPEN_DELIMS) {
		const idx = text.lastIndexOf(delim);
		if (idx > bestIdx) bestIdx = idx;
	}
	if (bestIdx === -1) {
		return text.endsWith("<") ? "<" : "";
	}
	const tail = text.slice(bestIdx);
	if (tail.includes("｜>") || tail.includes("|>")) return "";
	// Cap the held-back length so a stray `<｜` in normal prose can't grow unboundedly.
	if (tail.length > 256) return "";
	return tail;
}

const ALIBABA_TOKEN_PLAN_FIRST_EVENT_TIMEOUT_MS = 300_000;
const OPENAI_COMPLETIONS_FIRST_EVENT_TIMEOUT_MESSAGE =
	"OpenAI completions stream timed out while waiting for the first event";

export const streamOpenAICompletions: StreamFunction<"openai-completions"> = (
	model: Model<"openai-completions">,
	context: Context,
	options?: OpenAICompletionsOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();

	(async () => {
		const startTime = Date.now();
		let firstTokenTime: number | undefined;
		let getCapturedErrorResponse: (() => CapturedHttpErrorResponse | undefined) | undefined;

		const output: AssistantMessage = createInitialResponsesAssistantMessage(model.api, model.provider, model.id);
		let rawRequestDump: RawHttpRequestDump | undefined;
		const abortTracker = createAbortSourceTracker(options?.signal);
		const firstEventTimeoutAbortError = new Error(OPENAI_COMPLETIONS_FIRST_EVENT_TIMEOUT_MESSAGE);
		const { requestAbortController, requestSignal } = abortTracker;

		try {
			const apiKey = options?.apiKey || getEnvApiKey(model.provider) || "";
			const idleTimeoutMs = getOpenAIStreamIdleTimeoutMs();
			const {
				client,
				copilotPremiumRequests,
				baseUrl,
				requestHeaders,
				getCapturedErrorResponse: captureErrorResponse,
				clearCapturedErrorResponse,
			} = await createClient(
				model,
				context,
				apiKey,
				options?.headers,
				options?.initiatorOverride,
				options?.onSseEvent,
				options?.fetch,
				options?.streamFirstEventTimeoutMs,
				options?.authCredentialType,
				options?.requestMaxRetries,
				options?.sessionId,
				options?.maxRetryDelayMs,
			);
			const premiumRequestsTotal = copilotPremiumRequests;
			getCapturedErrorResponse = captureErrorResponse;
			let appliedToolStrictMode: AppliedToolStrictMode = "mixed";
			const providerSessionState = getOpenAICompletionsProviderSessionState(
				model,
				baseUrl,
				options?.providerSessionState,
			);
			let disableStrictTools = providerSessionState?.strictToolsDisabled ?? false;
			let strictFallbackErrorMessage: string | undefined;
			const createCompletionsStream = async (toolStrictModeOverride?: ToolStrictModeOverride) => {
				clearCapturedErrorResponse();
				const effectiveToolStrictModeOverride = disableStrictTools ? "none" : toolStrictModeOverride;
				const { params, toolStrictMode } = buildParams(
					model,
					context,
					options,
					baseUrl,
					effectiveToolStrictModeOverride,
				);
				appliedToolStrictMode = toolStrictMode;
				options?.onPayload?.(params);
				rawRequestDump = {
					provider: model.provider,
					api: output.api,
					model: model.id,
					method: "POST",
					url: `${baseUrl}/chat/completions`,
					headers: requestHeaders,
					body: params,
				};
				const { data, response, request_id } = await client.chat.completions
					.create(params as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming, { signal: requestSignal })
					.withResponse();
				await notifyProviderResponse(options, response, model, request_id);
				return data;
			};
			let openaiStream: AsyncIterable<ChatCompletionChunk>;
			try {
				openaiStream = await callWithCopilotModelRetry(() => createCompletionsStream(), {
					provider: model.provider,
					signal: requestSignal,
					fallbackManaged: options?.fallbackManaged,
				});
			} catch (error) {
				const capturedErrorResponse = getCapturedErrorResponse();
				const sentForcedToolChoice = isForcedToolChoice(
					(rawRequestDump?.body as { tool_choice?: unknown } | undefined)?.tool_choice,
				);
				if (
					!options?.fallbackManaged &&
					firstTokenTime === undefined &&
					isForcedToolChoiceUnsupportedError(error, sentForcedToolChoice)
				) {
					const reason = await finalizeErrorMessage(error, rawRequestDump, capturedErrorResponse);
					markToolChoiceIncapability(model, "auto", reason);
					const resolvedToolChoice = resolveToolChoice(model, options?.toolChoice);
					stream.push({
						type: "toolChoiceIncapability",
						api: model.api,
						provider: model.provider,
						model: model.id,
						requestedLevel: resolvedToolChoice.requestedLevel,
						resolvedLevel: "auto",
						reason,
						registryKey: resolvedToolChoice.registryKey,
					});
					openaiStream = await createCompletionsStream();
				} else if (
					!options?.fallbackManaged &&
					isOpenRouterAnthropicModel(model) &&
					!disableStrictTools &&
					isCompiledGrammarTooLargeStrictError(error, capturedErrorResponse)
				) {
					strictFallbackErrorMessage = await finalizeErrorMessage(error, rawRequestDump, capturedErrorResponse);
					output.errorMessage = strictFallbackErrorMessage;
					if (providerSessionState) {
						providerSessionState.strictToolsDisabled = true;
					}
					disableStrictTools = true;
					openaiStream = await createCompletionsStream("none");
				} else {
					if (
						options?.fallbackManaged ||
						!shouldRetryWithoutStrictTools(error, capturedErrorResponse, appliedToolStrictMode, context.tools)
					) {
						throw error;
					}
					openaiStream = await createCompletionsStream("none");
				}
			}
			const firstEventFallbackMs =
				model.provider === "alibaba-token-plan" ? ALIBABA_TOKEN_PLAN_FIRST_EVENT_TIMEOUT_MS : undefined;
			const firstEventWatchdog = createWatchdog(
				options?.streamFirstEventTimeoutMs ?? getStreamFirstEventTimeoutMs(idleTimeoutMs, firstEventFallbackMs),
				() => abortTracker.abortLocally(firstEventTimeoutAbortError),
			);
			if (premiumRequestsTotal !== undefined) {
				output.usage.premiumRequests = premiumRequestsTotal;
			}
			stream.push({ type: "start", partial: output });

			const parseMiniMaxThinkTags = model.provider === "minimax-code" || model.provider === "minimax-code-cn";
			// Some OpenAI-compatible DeepSeek hosts (including NVIDIA NIM and DeepSeek's
			// native API) leak chat-template tool-call markers in `delta.content` even
			// though tool calls are also surfaced structurally. Strip the leaked markers
			// so users don't see raw `<｜...｜>` tokens.
			const stripDeepseekChatTemplateTokens =
				/deepseek/i.test(model.id) && (model.provider === "nvidia" || model.provider === "deepseek");
			type OpenAIStreamBlock = TextContent | ThinkingContent | (ToolCall & { partialArgs: string });
			let currentBlock: OpenAIStreamBlock | undefined;
			const blockIndex = (block: OpenAIStreamBlock | undefined): number => {
				if (!block) return Math.max(0, output.content.length - 1);
				return output.content.indexOf(block);
			};
			const finishCurrentBlock = (block: OpenAIStreamBlock | undefined): void => {
				if (!block) return;
				const contentIndex = blockIndex(block);
				if (contentIndex < 0) return;
				if (block.type === "text") {
					stream.push({ type: "text_end", contentIndex, content: block.text, partial: output });
					return;
				}
				if (block.type === "thinking") {
					stream.push({ type: "thinking_end", contentIndex, content: block.thinking, partial: output });
					return;
				}
				block.arguments = parseStreamingJson(block.partialArgs);
				delete (block as { partialArgs?: string }).partialArgs;
				stream.push({ type: "toolcall_end", contentIndex, toolCall: block, partial: output });
			};
			const appendText = (
				message: AssistantMessage,
				eventStream: AssistantMessageEventStream,
				text: string,
			): void => {
				if (currentBlock?.type !== "text") {
					finishCurrentBlock(currentBlock);
					currentBlock = { type: "text", text: "" };
					message.content.push(currentBlock);
					eventStream.push({ type: "text_start", contentIndex: blockIndex(currentBlock), partial: message });
				}
				currentBlock.text += text;
				eventStream.push({
					type: "text_delta",
					contentIndex: blockIndex(currentBlock),
					delta: text,
					partial: message,
				});
			};
			const appendThinking = (
				message: AssistantMessage,
				eventStream: AssistantMessageEventStream,
				thinking: string,
				signature?: string,
			): void => {
				if (
					currentBlock?.type !== "thinking" ||
					(signature !== undefined && currentBlock.thinkingSignature !== signature)
				) {
					finishCurrentBlock(currentBlock);
					currentBlock = { type: "thinking", thinking: "", thinkingSignature: signature };
					message.content.push(currentBlock);
					eventStream.push({
						type: "thinking_start",
						contentIndex: blockIndex(currentBlock),
						partial: message,
					});
				}
				if (signature !== undefined && !currentBlock.thinkingSignature) {
					currentBlock.thinkingSignature = signature;
				}
				currentBlock.thinking += thinking;
				eventStream.push({
					type: "thinking_delta",
					contentIndex: blockIndex(currentBlock),
					delta: thinking,
					partial: message,
				});
			};

			let taggedTextBuffer = "";
			let insideTaggedThinking = false;
			const appendTextDelta = (text: string) => {
				if (!text) return;
				if (!firstTokenTime) firstTokenTime = Date.now();
				appendText(output, stream, text);
			};
			const appendThinkingDelta = (thinking: string, signature?: string) => {
				if (!thinking) return;
				if (!firstTokenTime) firstTokenTime = Date.now();
				appendThinking(output, stream, thinking, signature);
			};

			const flushTaggedTextBuffer = () => {
				while (taggedTextBuffer.length > 0) {
					if (insideTaggedThinking) {
						const closingTag = findFirstTag(taggedTextBuffer, MINIMAX_THINK_CLOSE_TAGS);
						if (closingTag) {
							appendThinkingDelta(taggedTextBuffer.slice(0, closingTag.index));
							taggedTextBuffer = taggedTextBuffer.slice(closingTag.index + closingTag.tag.length);
							insideTaggedThinking = false;
							continue;
						}

						const trailingPartialTag = getTrailingPartialTag(taggedTextBuffer, MINIMAX_THINK_CLOSE_TAGS);
						const flushLength = taggedTextBuffer.length - trailingPartialTag.length;
						appendThinkingDelta(taggedTextBuffer.slice(0, flushLength));
						taggedTextBuffer = trailingPartialTag;
						break;
					}

					const openingTag = findFirstTag(taggedTextBuffer, MINIMAX_THINK_OPEN_TAGS);
					if (openingTag) {
						appendTextDelta(taggedTextBuffer.slice(0, openingTag.index));
						taggedTextBuffer = taggedTextBuffer.slice(openingTag.index + openingTag.tag.length);
						insideTaggedThinking = true;
						continue;
					}

					const trailingPartialTag = getTrailingPartialTag(taggedTextBuffer, MINIMAX_THINK_OPEN_TAGS);
					const flushLength = taggedTextBuffer.length - trailingPartialTag.length;
					appendTextDelta(taggedTextBuffer.slice(0, flushLength));
					taggedTextBuffer = trailingPartialTag;
					break;
				}
			};

			let deepseekStripBuffer = "";
			const flushDeepseekStripBuffer = (final: boolean): void => {
				if (deepseekStripBuffer.length === 0) return;
				let flushable: string;
				if (final) {
					flushable = deepseekStripBuffer;
					deepseekStripBuffer = "";
				} else {
					const trailing = getTrailingPartialDeepseekToken(deepseekStripBuffer);
					flushable = deepseekStripBuffer.slice(0, deepseekStripBuffer.length - trailing.length);
					deepseekStripBuffer = trailing;
				}
				const stripped = stripDeepseekSpecialTokens(flushable);
				if (stripped && (stripped === flushable || stripped.trim().length > 0)) appendTextDelta(stripped);
			};

			const kimiHealer = modelMayLeakKimiToolCalls(model.provider, model.id) ? new ToolCallHealer() : undefined;
			let healedToolCallEmitted = false;
			const emitHealedToolCall = (call: HealedToolCall): void => {
				finishCurrentBlock(currentBlock);
				const block: ToolCall & { partialArgs: string } = {
					type: "toolCall",
					id: call.id,
					name: call.name,
					arguments: {},
					partialArgs: call.arguments,
				};
				block.arguments = parseStreamingJson(call.arguments);
				currentBlock = block;
				output.content.push(block);
				stream.push({ type: "toolcall_start", contentIndex: blockIndex(block), partial: output });
				stream.push({
					type: "toolcall_delta",
					contentIndex: blockIndex(block),
					delta: call.arguments,
					partial: output,
				});
				finishCurrentBlock(block);
				currentBlock = undefined;
				healedToolCallEmitted = true;
			};
			const flushHealedToolCalls = (): void => {
				if (!kimiHealer) return;
				const calls = kimiHealer.drainCompleted();
				for (const call of calls) emitHealedToolCall(call);
			};
			let providerSafetyStop = false;
			const markProviderSafetyStop = (errorMessage?: string): void => {
				providerSafetyStop = true;
				output.errorKind = "provider_safety_stop";
				output.stopReason = "error";
				if (errorMessage) output.errorMessage = errorMessage;
			};

			for await (const chunk of iterateWithIdleTimeout(openaiStream, {
				watchdog: firstEventWatchdog,
				idleTimeoutMs,
				errorMessage: "OpenAI completions stream stalled while waiting for the next event",
				onIdle: () => requestAbortController.abort(),
				abortSignal: options?.signal,
				isProgressItem: isOpenAICompletionsProgressChunk,
			})) {
				if (!chunk || typeof chunk !== "object") continue;

				// OpenAI documents ChatCompletionChunk.id as the unique chat completion identifier,
				// and each chunk in a streamed completion carries the same id.
				output.responseId ||= chunk.id;

				if (chunk.usage) {
					output.usage = parseChunkUsage(chunk.usage, model, premiumRequestsTotal);
				}

				const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : undefined;
				if (!choice) continue;

				if (!chunk.usage) {
					const choiceUsage = getChoiceUsage(choice);
					if (choiceUsage) {
						output.usage = parseChunkUsage(choiceUsage, model, premiumRequestsTotal);
					}
				}

				if (choice.finish_reason) {
					const finishReasonResult = mapStopReason(choice.finish_reason);
					if (choice.finish_reason === "content_filter") {
						markProviderSafetyStop(finishReasonResult.errorMessage);
					} else if (!providerSafetyStop) {
						output.stopReason = finishReasonResult.stopReason;
						if (finishReasonResult.errorMessage) {
							output.errorMessage = finishReasonResult.errorMessage;
						}
					}
				}

				if (choice.delta) {
					if (typeof choice.delta.refusal === "string" && choice.delta.refusal.length > 0) {
						appendTextDelta(choice.delta.refusal);
						if (!providerSafetyStop) {
							markProviderSafetyStop("Provider returned a safety refusal");
						}
					}
					const normalizedDeltaText = normalizeStreamingContentText(choice.delta.content);
					if (normalizedDeltaText.length > 0) {
						if (!firstTokenTime) firstTokenTime = Date.now();
						if (parseMiniMaxThinkTags) {
							taggedTextBuffer += normalizedDeltaText;
							flushTaggedTextBuffer();
						} else if (stripDeepseekChatTemplateTokens) {
							deepseekStripBuffer += normalizedDeltaText;
							flushDeepseekStripBuffer(false);
						} else if (kimiHealer) {
							const hasStructuredToolCalls =
								Array.isArray(choice.delta.tool_calls) && choice.delta.tool_calls.length > 0;
							if (hasStructuredToolCalls) {
								// Same chunk leaks markers AND carries structured tool_calls.
								// Strip the marker text from visible output, but drop any
								// synthesized calls so the structured payload stays the
								// single source of truth (avoids double-dispatch).
								const clean = kimiHealer.consumeWithoutCalls(normalizedDeltaText);
								if (clean.length > 0) appendTextDelta(clean);
							} else {
								const clean = kimiHealer.feed(normalizedDeltaText);
								if (clean.length > 0) appendTextDelta(clean);
								flushHealedToolCalls();
							}
						} else {
							appendTextDelta(normalizedDeltaText);
						}
					}

					// Some endpoints return reasoning in reasoning_content (llama.cpp),
					// or reasoning (other openai compatible endpoints)
					// Use the first non-empty reasoning field to avoid duplication
					// (e.g., chutes.ai returns both reasoning_content and reasoning with same content)
					const reasoningFields = ["reasoning_content", "reasoning", "reasoning_text"];
					let foundReasoningField: string | null = null;
					for (const field of reasoningFields) {
						if (
							(choice.delta as any)[field] !== null &&
							(choice.delta as any)[field] !== undefined &&
							(choice.delta as any)[field].length > 0
						) {
							if (!foundReasoningField) {
								foundReasoningField = field;
								break;
							}
						}
					}

					if (foundReasoningField) {
						const delta = (choice.delta as any)[foundReasoningField];
						appendThinkingDelta(delta, foundReasoningField);
					}

					if (choice?.delta?.tool_calls && choice.delta.tool_calls.length > 0) {
						for (const toolCall of choice.delta.tool_calls) {
							if (currentBlock?.type !== "toolCall" || (toolCall.id && currentBlock.id !== toolCall.id)) {
								finishCurrentBlock(currentBlock);
								currentBlock = {
									type: "toolCall",
									id: toolCall.id || "",
									name: toolCall.function?.name || "",
									arguments: {},
									partialArgs: "",
								};
								output.content.push(currentBlock);
								stream.push({
									type: "toolcall_start",
									contentIndex: blockIndex(currentBlock),
									partial: output,
								});
							}

							if (currentBlock.type === "toolCall") {
								if (toolCall.id) currentBlock.id = toolCall.id;
								if (toolCall.function?.name) currentBlock.name = toolCall.function.name;
								let delta = "";
								if (toolCall.function?.arguments) {
									delta = toolCall.function.arguments;
									currentBlock.partialArgs += toolCall.function.arguments;
									currentBlock.arguments = parseStreamingJson(currentBlock.partialArgs);
								}
								stream.push({
									type: "toolcall_delta",
									contentIndex: blockIndex(currentBlock),
									delta,
									partial: output,
								});
							}
						}
					}

					const reasoningDetails = (choice.delta as any).reasoning_details;
					if (reasoningDetails && Array.isArray(reasoningDetails)) {
						for (const detail of reasoningDetails) {
							if (detail.type === "reasoning.encrypted" && detail.id && detail.data) {
								const matchingToolCall = output.content.find(
									b => b.type === "toolCall" && b.id === detail.id,
								) as ToolCall | undefined;
								if (matchingToolCall) {
									matchingToolCall.thoughtSignature = JSON.stringify(detail);
								}
							}
						}
					}
				}
			}

			if (parseMiniMaxThinkTags && taggedTextBuffer.length > 0) {
				if (insideTaggedThinking) {
					appendThinkingDelta(taggedTextBuffer);
				} else {
					appendTextDelta(taggedTextBuffer);
				}
				taggedTextBuffer = "";
			}

			if (stripDeepseekChatTemplateTokens) {
				flushDeepseekStripBuffer(true);
			}

			if (kimiHealer) {
				const trailing = kimiHealer.flushPending();
				if (trailing.length > 0) appendTextDelta(trailing);
				flushHealedToolCalls();
				if (healedToolCallEmitted && output.stopReason === "stop") {
					// Hosts that leak Kimi tool tokens often still report
					// `finish_reason: stop` for the surrounding turn. Promote
					// only that natural-completion finish — leave `error`,
					// `length`, `aborted`, etc. untouched.
					output.stopReason = "toolUse";
				}
			}

			// A turn cut short for length may have stopped mid-tool-call. The open
			// block's `partialArgs` would otherwise be repaired into a plausible-
			// but-wrong object by `finishCurrentBlock`; flag it first so the agent
			// loop rejects the truncated call instead of executing it.
			if (output.stopReason === "length" && currentBlock?.type === "toolCall") {
				const partial = (currentBlock as { partialArgs?: string }).partialArgs;
				if (partial !== undefined && !isCompleteJson(partial)) {
					currentBlock.incompleteArguments = true;
				}
			}

			finishCurrentBlock(currentBlock);

			const firstEventTimeoutError = abortTracker.getLocalAbortReason();
			if (firstEventTimeoutError) {
				throw firstEventTimeoutError;
			}
			if (abortTracker.wasCallerAbort()) {
				throw new Error("Request was aborted");
			}

			if (output.stopReason === "aborted") {
				throw new Error("Request was aborted");
			}
			if (output.stopReason === "error") {
				throw new Error(output.errorMessage || "Provider returned an error stop reason");
			}

			output.errorMessage = strictFallbackErrorMessage;
			output.duration = Date.now() - startTime;
			if (firstTokenTime) output.ttft = firstTokenTime - startTime;
			stream.push({ type: "done", reason: output.stopReason, message: output });
			stream.end();
		} catch (error) {
			for (const block of output.content) delete (block as any).index;
			const firstEventTimeoutError = abortTracker.getLocalAbortReason();
			const capturedErrorResponse = getCapturedErrorResponse?.();
			output.stopReason = abortTracker.wasCallerAbort() ? "aborted" : "error";
			output.errorStatus = extractHttpStatusFromError(error) ?? capturedErrorResponse?.status;
			output.transportFailure = transportFailureFacts(error, capturedErrorResponse);
			output.errorMessage =
				firstEventTimeoutError?.message ??
				(await finalizeErrorMessage(error, rawRequestDump, capturedErrorResponse));
			// Some providers via OpenRouter include extra details here.
			const rawMetadata = (error as { error?: { metadata?: { raw?: string } } })?.error?.metadata?.raw;
			if (rawMetadata) output.errorMessage += `\n${rawMetadata}`;
			output.errorMessage = rewriteCopilotError(output.errorMessage, error, model.provider);
			if (hasContentFilterSafetyCode(capturedErrorResponse)) {
				output.errorKind = "provider_safety_stop";
			}
			output.duration = Date.now() - startTime;
			if (firstTokenTime) output.ttft = firstTokenTime - startTime;
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
};

async function createClient(
	model: Model<"openai-completions">,
	context: Context,
	apiKey?: string,
	extraHeaders?: Record<string, string>,
	initiatorOverride?: MessageAttribution,
	onSseEvent?: OpenAICompletionsOptions["onSseEvent"],
	fetchOverride?: FetchImpl,
	streamFirstEventTimeoutOverride?: number,
	authCredentialType?: OpenAICompletionsOptions["authCredentialType"],
	requestMaxRetries?: number,
	sessionId?: string,
	maxRetryDelayMs?: number,
): Promise<{
	client: OpenAI;
	copilotPremiumRequests: number | undefined;
	baseUrl: string | undefined;
	requestHeaders: Record<string, string>;
	getCapturedErrorResponse: () => CapturedHttpErrorResponse | undefined;
	clearCapturedErrorResponse: () => void;
}> {
	if (!apiKey) {
		apiKey = $credentialEnv("OPENAI_API_KEY");
		if (!apiKey) {
			throw new Error(
				"OpenAI API key is required. Set OPENAI_API_KEY environment variable or pass it as an argument.",
			);
		}
	}
	const rawApiKey = apiKey;

	let headers = { ...model.headers };
	if (model.provider === "openrouter") {
		// App attribution — opts the agent into OpenRouter's public rankings and per-app
		// analytics. `HTTP-Referer` is the unique app identifier; without it nothing is
		// tracked. `X-OpenRouter-Title` is the display name (`X-Title` is the legacy
		// alias kept for back-compat). `X-OpenRouter-Categories` slots us into the
		// `cli-agent` marketplace category. `User-Agent` overrides the default OpenAI
		// SDK UA so traffic is identifiable in upstream provider logs.
		// https://openrouter.ai/docs/app-attribution
		headers["User-Agent"] = `Gajae-Code/${packageJson.version}`;
		headers["HTTP-Referer"] = "https://gaebal-gajae.dev/";
		headers["X-OpenRouter-Title"] = "Gajae-Code";
		headers["X-OpenRouter-Categories"] = "cli-agent";
		// Always-on response caching: identical requests return cached responses for free.
		// TTL 1h; first call hits the provider, every identical call within the window
		// replays from OpenRouter's edge cache. https://openrouter.ai/docs/features/response-caching
		headers["X-OpenRouter-Cache"] = "true";
		headers["X-OpenRouter-Cache-TTL"] = "3600";
	}
	Object.assign(headers, extraHeaders);
	if (sessionId && resolveOpenAICompat(model).sendSessionHeaders) {
		// Forward the agent session id as vendor-neutral session-identity headers so
		// OpenAI-compatible proxies/relays can do session-affinity routing and reuse a
		// server-side prompt cache. Opt-in via `compat.sendSessionHeaders`; never
		// overwrite a header the caller already set (model.headers / requestTransform).
		headers.session_id ??= sessionId;
		headers["x-session-id"] ??= sessionId;
	}
	if (model.provider === "kimi-code") {
		headers = { ...getKimiCommonHeaders(), ...headers };
	}
	headers = applyOpenAIRequestTransformHeaders(headers, model.requestTransform, `Gajae-Code/${packageJson.version}`);
	let copilotPremiumRequests: number | undefined;

	let baseUrl =
		model.provider === "openai" ? resolveOpenAIProviderBaseUrl(model.baseUrl, authCredentialType) : model.baseUrl;
	if (model.provider === "github-copilot") {
		apiKey = parseGitHubCopilotApiKey(rawApiKey).accessToken;
		const hasImages = hasCopilotVisionInput(context.messages);
		const copilot = buildCopilotDynamicHeaders({
			messages: context.messages,
			hasImages,
			premiumMultiplier: model.premiumMultiplier,
			headers,
			initiatorOverride,
		});
		Object.assign(headers, copilot.headers);
		copilotPremiumRequests = copilot.premiumRequests;
		baseUrl = resolveGitHubCopilotBaseUrl(model.baseUrl, rawApiKey) ?? model.baseUrl;
	}
	// Azure OpenAI requires /deployments/{id}/chat/completions?api-version=YYYY-MM-DD.
	// The generic openai-completions path adds neither, producing silent 404s.
	let azureDefaultQuery: Record<string, string> | undefined;
	if (baseUrl?.includes(".openai.azure.com")) {
		const apiVersion = $env.AZURE_OPENAI_API_VERSION || "2024-10-21";
		if (!baseUrl.includes("/deployments/")) {
			baseUrl = `${baseUrl}/deployments/${model.id}`;
		}
		azureDefaultQuery = { "api-version": apiVersion };
	}
	let capturedErrorResponse: CapturedHttpErrorResponse | undefined;
	const baseFetch = fetchOverride ?? fetch;
	const wrappedFetch = Object.assign(
		async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			const response = await baseFetch(input, init);
			if (response.ok) {
				capturedErrorResponse = undefined;
				return response;
			}
			let bodyText: string | undefined;
			let bodyJson: unknown;
			try {
				bodyText = await response.clone().text();
				if (bodyText.trim().length > 0) {
					try {
						bodyJson = JSON.parse(bodyText);
					} catch {}
				}
			} catch {}
			capturedErrorResponse = {
				status: response.status,
				headers: response.headers,
				bodyText,
				bodyJson,
			};
			return response;
		},
		baseFetch.preconnect ? { preconnect: baseFetch.preconnect } : {},
	);
	const boundedFetch = wrapOpenAIFetchForBoundedRateLimits(wrappedFetch, maxRetryDelayMs);
	const transformedFetch = wrapFetchForOpenAIRequestTransform(
		boundedFetch,
		model.requestTransform,
		`Gajae-Code/${packageJson.version}`,
	);
	const debugFetch = onSseEvent
		? wrapFetchForSseDebug(transformedFetch, event => onSseEvent(event, model))
		: transformedFetch;
	// Bound HTTP request timeout to roughly the first-event watchdog window.
	// The OpenAI SDK's default is 10 minutes per attempt × `maxRetries`, which
	// turns a stalled-before-headers fetch into a multi-minute hang invisible
	// to the agent loop (the iterator watchdog only arms AFTER `create()` returns).
	// Using the first-event timeout keeps both layers aligned: the SDK gives up
	// before the agent watchdog would have, surfacing a real error to the catch
	// in the IIFE.
	// A caller may raise `StreamOptions.streamFirstEventTimeoutMs` for a slow-
	// before-headers provider; respect it so the SDK doesn't give up before the
	// wrapping watchdog arms. An explicit `0` disables the first-event watchdog,
	// and the SDK treats `timeout: 0` as an immediate timeout, so do not pass a
	// request timeout in that case.
	const envSdkTimeoutMs = getStreamFirstEventTimeoutMs(getOpenAIStreamIdleTimeoutMs());
	const sdkTimeoutMs =
		streamFirstEventTimeoutOverride === 0
			? undefined
			: streamFirstEventTimeoutOverride !== undefined
				? Math.max(envSdkTimeoutMs ?? 0, streamFirstEventTimeoutOverride)
				: envSdkTimeoutMs;
	return {
		client: new OpenAI({
			apiKey,
			baseURL: baseUrl,
			dangerouslyAllowBrowser: true,
			maxRetries: resolveRetryBudget(requestMaxRetries, 5),
			defaultHeaders: headers,
			defaultQuery: azureDefaultQuery,
			fetch: debugFetch,
			...(sdkTimeoutMs !== undefined ? { timeout: sdkTimeoutMs } : {}),
		}),
		copilotPremiumRequests,
		baseUrl,
		requestHeaders: headers,
		getCapturedErrorResponse: () => capturedErrorResponse,
		clearCapturedErrorResponse: () => {
			capturedErrorResponse = undefined;
		},
	};
}

function buildParams(
	model: Model<"openai-completions">,
	context: Context,
	options: OpenAICompletionsOptions | undefined,
	resolvedBaseUrl?: string,
	toolStrictModeOverride?: ToolStrictModeOverride,
): { params: OpenAICompletionsParams; toolStrictMode: AppliedToolStrictMode } {
	const compat = getCompat(model, resolvedBaseUrl);
	const messages = convertMessages(model, context, compat);
	maybeAddOpenRouterAnthropicCacheControl(model, messages);
	const supportsReasoningParams = model.provider !== "github-copilot";

	// Kimi (including via OpenRouter and Fireworks router-form IDs such as
	// `accounts/fireworks/routers/kimi-*`) calculates TPM rate limits based on
	// max_tokens, not actual output. The official Kimi K2 model guidance
	// (https://docs.fireworks.ai/models/kimi-k2) also requires `max_tokens` for
	// every call since the family can otherwise emit very long reasoning traces
	// before the final answer. Always send max_tokens — match the same
	// Kimi-family regex used by the compat detector.
	// Note: Direct kimi-code provider is handled by the dedicated Kimi provider in kimi.ts.
	const isKimi = model.id.includes("moonshotai/kimi") || /(^|\/)kimi[-.]/i.test(model.id);
	const effectiveMaxTokens = options?.maxTokens ?? (isKimi ? model.maxTokens : undefined);

	const requestModelId =
		model.wireModelId ??
		(model.provider === "fireworks"
			? toFireworksWireModelId(model.id)
			: model.provider === "firepass"
				? toFirepassWireModelId(model.id)
				: model.id);
	const params: OpenAICompletionsParams = {
		model: requestModelId,
		messages,
		stream: true,
	};
	let toolStrictMode: AppliedToolStrictMode = "none";

	if (compat.supportsUsageInStreaming !== false) {
		params.stream_options = { include_usage: true };
	}

	if (compat.supportsStore) {
		params.store = false;
	}

	if (effectiveMaxTokens) {
		if (compat.maxTokensField === "max_tokens") {
			params.max_tokens = effectiveMaxTokens;
		} else {
			params.max_completion_tokens = effectiveMaxTokens;
		}
	}

	if (options?.temperature !== undefined) {
		params.temperature = options.temperature;
	}
	if (options?.topP !== undefined) {
		params.top_p = options.topP;
	}
	if (options?.topK !== undefined) {
		params.top_k = options.topK;
	}
	if (options?.minP !== undefined) {
		params.min_p = options.minP;
	}
	if (options?.presencePenalty !== undefined) {
		params.presence_penalty = options.presencePenalty;
	}
	if (options?.repetitionPenalty !== undefined) {
		params.repetition_penalty = options.repetitionPenalty;
	}
	if (options?.stopSequences?.length) {
		const seqs = options.stopSequences;
		params.stop = seqs.length === 1 ? seqs[0] : seqs.slice(0, 4);
	}
	if (options?.frequencyPenalty !== undefined) {
		params.frequency_penalty = options.frequencyPenalty;
	}
	if (shouldSendServiceTier(options?.serviceTier, model.provider)) {
		const resolved = resolveServiceTier(options?.serviceTier, model.provider);
		if (resolved === "flex" || resolved === "scale" || resolved === "priority") {
			params.service_tier = resolved;
		}
	}

	if (context.tools?.length) {
		const builtTools = convertTools(context.tools, compat, toolStrictModeOverride);
		params.tools = builtTools.tools;
		toolStrictMode = builtTools.toolStrictMode;
	} else if (context.tools === undefined && hasToolHistory(context.messages)) {
		// Anthropic (via LiteLLM/proxy) requires the `tools` param when the conversation
		// contains tool_calls/tool_results, even when no tools are offered this turn.
		// Only inject the sentinel when the caller passed `context.tools = undefined`
		// (i.e. tools were not specified at all). An explicit `context.tools = []` means
		// the caller opted out of tools for this turn (as /btw and IRC background replies
		// do via AgentSession.runEphemeralTurn) — honour that intent and emit nothing,
		// so LiteLLM → Bedrock never sees an empty `toolConfig` block.
		params.tools = [];
	}

	if (options?.toolChoice) {
		const toolChoice = resolveToolChoice(model, options.toolChoice, compat);
		if (toolChoice.degraded && toolChoice.supportSource === "runtime") {
			logger.debug("openai-completions: degraded tool_choice after runtime capability discovery", {
				model: model.id,
				requestedLevel: toolChoice.requestedLevel,
				resolvedLevel: toolChoice.resolvedLevel,
				reason: toolChoice.reason,
			});
		}
		if (toolChoice.resolvedChoice !== undefined) {
			params.tool_choice = mapToOpenAICompletionsToolChoice(toolChoice.resolvedChoice);
		}
	}

	if (params.tool_choice === "none" && (!Array.isArray(params.tools) || params.tools.length === 0)) {
		// `tool_choice: "none"` with no tools to gate is redundant and also
		// trips LiteLLM → Bedrock: the proxy serializes the directive into a
		// `toolConfig` block, and Bedrock requires `toolConfig.tools` to be
		// non-empty whenever the conversation already holds `toolUse`/`toolResult`
		// content. Drop it whenever the resolved tools list is missing or empty.
		// Side-channel turns hit this: `/btw` and IRC background replies route
		// through `AgentSession.runEphemeralTurn`, which sets `context.tools = []`
		// and `toolChoice: "none"` (see packages/coding-agent/src/session/agent-session.ts).
		delete params.tool_choice;
	}

	if (supportsReasoningParams && compat.thinkingFormat === "zai" && model.reasoning) {
		// Z.ai uses binary thinking: { type: "enabled" | "disabled" }
		// Must explicitly disable since z.ai defaults to thinking enabled.
		const enabled = options?.reasoning && !options?.disableReasoning;
		params.thinking = { type: enabled ? "enabled" : "disabled" };
	} else if (supportsReasoningParams && compat.thinkingFormat === "qwen" && model.reasoning) {
		// Qwen uses top-level enable_thinking: boolean
		params.enable_thinking = !!options?.reasoning && !options?.disableReasoning;
	} else if (supportsReasoningParams && compat.thinkingFormat === "qwen-chat-template" && model.reasoning) {
		params.chat_template_kwargs = {
			enable_thinking: !!options?.reasoning && !options?.disableReasoning,
		};
	} else if (supportsReasoningParams && compat.thinkingFormat === "openrouter" && model.reasoning) {
		// OpenRouter normalizes reasoning across providers via a nested reasoning object.
		// Without an explicit signal, OpenRouter defaults reasoning models to thinking, which
		// silently consumes the entire output budget on small `max_tokens` requests (e.g.
		// title generation). Honor `disableReasoning` to opt out cleanly.
		const openRouterParams = params as typeof params & {
			reasoning?: { effort?: string } | { enabled: false };
		};
		if (options?.disableReasoning) {
			openRouterParams.reasoning = { enabled: false };
		} else if (options?.reasoning) {
			openRouterParams.reasoning = {
				effort: mapReasoningEffort(options.reasoning, compat.reasoningEffortMap),
			};
		}
	} else if (
		supportsReasoningParams &&
		options?.reasoning &&
		!options?.disableReasoning &&
		model.reasoning &&
		compat.supportsReasoningEffort
	) {
		// OpenAI-style reasoning_effort
		params.reasoning_effort = mapReasoningEffort(options.reasoning, compat.reasoningEffortMap) as Effort;
	} else if (
		supportsReasoningParams &&
		options?.disableReasoning &&
		!options?.reasoning &&
		model.reasoning &&
		compat.supportsReasoningEffort
	) {
		// Generic OpenAI-compatible effort endpoints do not expose a true off
		// switch. Use the model's lowest supported effort as the closest
		// transport-level approximation when callers request disabled reasoning.
		const minEffort = getSupportedEfforts(model)[0];
		if (minEffort === undefined) {
			throw new Error(`Model ${model.provider}/${model.id} has no supported reasoning efforts`);
		}
		params.reasoning_effort = mapReasoningEffort(minEffort, compat.reasoningEffortMap) as Effort;
	}

	if (compat.disableReasoningOnToolChoice && params.tool_choice !== undefined) {
		// DeepSeek reasoning models accept tools/tool_choice, but reject that
		// control field while thinking is enabled. Keep the tool-selection
		// contract and suppress reasoning for this single request.
		delete params.reasoning_effort;
		delete params.reasoning;
	}

	if (compat.disableReasoningOnForcedToolChoice && isForcedToolChoice(params.tool_choice)) {
		// Backends like Kimi 400 with `tool_choice 'specified' is incompatible
		// with thinking enabled`. Suppress thinking for this single forced-tool
		// turn while keeping the tool-selection contract intact.
		delete params.reasoning_effort;
		delete params.reasoning;
		if (compat.thinkingFormat === "zai") {
			params.thinking = { type: "disabled" };
		}
	}

	// OpenRouter provider routing preferences
	if (model.baseUrl.includes("openrouter.ai") && compat.openRouterRouting) {
		params.provider = compat.openRouterRouting;
	}

	// Vercel AI Gateway provider routing preferences
	if (model.baseUrl.includes("ai-gateway.vercel.sh") && model.compat?.vercelGatewayRouting) {
		const routing = model.compat.vercelGatewayRouting;
		if (routing.only || routing.order) {
			const gatewayOptions: Record<string, string[]> = {};
			if (routing.only) gatewayOptions.only = routing.only;
			if (routing.order) gatewayOptions.order = routing.order;
			params.providerOptions = { gateway: gatewayOptions };
		}
	}

	if (compat.extraBody) {
		Object.assign(params, compat.extraBody);
	}
	applyOpenAIRequestTransformBody(params, model.requestTransform);

	return { params, toolStrictMode };
}

function getOptionalNumberProperty(value: object, key: string): number | undefined {
	const property = Reflect.get(value, key);
	return typeof property === "number" ? property : undefined;
}

function getOptionalObjectProperty(value: object, key: string): object | undefined {
	const property = Reflect.get(value, key);
	return typeof property === "object" && property !== null ? property : undefined;
}

function getChoiceUsage(choice: ChatCompletionChunk.Choice): object | undefined {
	return getOptionalObjectProperty(choice, "usage");
}

export function parseChunkUsage(
	rawUsage: object,
	model: Model<"openai-completions">,
	premiumRequests: number | undefined,
): AssistantMessage["usage"] {
	const promptTokenDetails = getOptionalObjectProperty(rawUsage, "prompt_tokens_details");
	const completionTokenDetails = getOptionalObjectProperty(rawUsage, "completion_tokens_details");
	const deepSeekCacheHitTokens = getOptionalNumberProperty(rawUsage, "prompt_cache_hit_tokens");
	const deepSeekCacheMissTokens = getOptionalNumberProperty(rawUsage, "prompt_cache_miss_tokens");
	const cachedTokens =
		getOptionalNumberProperty(rawUsage, "cached_tokens") ??
		(promptTokenDetails ? getOptionalNumberProperty(promptTokenDetails, "cached_tokens") : undefined) ??
		deepSeekCacheHitTokens ??
		0;
	// OpenRouter exposes cache writes via `prompt_tokens_details.cache_write_tokens`
	// and INCLUDES them in `prompt_tokens`. Without subtracting, cache-write tokens
	// leak into `input` (e.g. GLM/Anthropic via OpenRouter on a fresh cache).
	// Ref: https://openrouter.ai/docs/guides/best-practices/prompt-caching
	const cacheWriteTokens = promptTokenDetails
		? (getOptionalNumberProperty(promptTokenDetails, "cache_write_tokens") ?? 0)
		: 0;
	const reasoningTokens =
		(completionTokenDetails ? getOptionalNumberProperty(completionTokenDetails, "reasoning_tokens") : undefined) ?? 0;
	const promptTokens = getOptionalNumberProperty(rawUsage, "prompt_tokens") ?? 0;
	const input = Math.max(0, deepSeekCacheMissTokens ?? promptTokens - cachedTokens - cacheWriteTokens);
	// Per OpenAI's CompletionUsage spec, `reasoning_tokens` is a subset of
	// `completion_tokens` (which is the total billed output). Adding them would
	// double-count.
	const outputTokens = getOptionalNumberProperty(rawUsage, "completion_tokens") ?? 0;
	const usage: AssistantMessage["usage"] = {
		input,
		output: outputTokens,
		cacheRead: cachedTokens,
		cacheWrite: cacheWriteTokens,
		totalTokens: input + outputTokens + cachedTokens + cacheWriteTokens,
		...(reasoningTokens > 0 ? { reasoningTokens } : {}),
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		...(premiumRequests !== undefined ? { premiumRequests } : {}),
	};
	calculateCost(model, usage);
	return usage;
}

function mapReasoningEffort(
	effort: NonNullable<OpenAICompletionsOptions["reasoning"]>,
	reasoningEffortMap: Partial<Record<NonNullable<OpenAICompletionsOptions["reasoning"]>, string>>,
): string {
	return reasoningEffortMap[effort] ?? effort;
}

function maybeAddOpenRouterAnthropicCacheControl(
	model: Model<"openai-completions">,
	messages: ChatCompletionMessageParam[],
): void {
	if (model.provider !== "openrouter" || !model.id.startsWith("anthropic/")) return;

	// Anthropic-style caching requires cache_control on a text part. Add a breakpoint
	// on the last user/assistant message (walking backwards until we find text content).
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role !== "user" && msg.role !== "assistant" && msg.role !== "developer") continue;

		const content = msg.content;
		if (typeof content === "string") {
			msg.content = [
				Object.assign({ type: "text" as const, text: content }, { cache_control: { type: "ephemeral" } }),
			];
			return;
		}

		if (!Array.isArray(content)) continue;

		// Find last text part and add cache_control
		for (let j = content.length - 1; j >= 0; j--) {
			const part = content[j];
			if (part?.type === "text") {
				Object.assign(part, { cache_control: { type: "ephemeral" } });
				return;
			}
		}
	}
}

export function convertMessages(
	model: Model<"openai-completions">,
	context: Context,
	compat: ResolvedOpenAICompat,
): ChatCompletionMessageParam[] {
	const params: ChatCompletionMessageParam[] = [];

	const normalizeToolCallId = (id: string): string => {
		if (compat.requiresMistralToolIds) return normalizeMistralToolId(id, true);

		// Handle pipe-separated IDs from OpenAI Responses API
		// Format: {call_id}|{id} where {id} can be 400+ chars with special chars (+, /, =)
		// These come from providers like github-copilot, OpenAI code provider, opencode
		// Extract just the call_id part and normalize it
		if (id.includes("|")) {
			const [callId] = id.split("|");
			// Sanitize to allowed chars and truncate to 40 chars (OpenAI limit)
			return callId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40);
		}

		if (model.provider === "openai") return id.length > 40 ? id.slice(0, 40) : id;
		return id;
	};
	const transformedMessages = transformMessages(context.messages, model, id => normalizeToolCallId(id));

	const remappedToolCallIds = new Map<string, string[]>();
	let generatedToolCallIdCounter = 0;

	const generateFallbackToolCallId = (seed: string): string => {
		generatedToolCallIdCounter += 1;
		const hash = Bun.hash(`${model.provider}:${model.id}:${seed}:${generatedToolCallIdCounter}`).toString(36);
		return `call_${hash}`;
	};

	const rememberToolCallId = (originalId: string, normalizedId: string): void => {
		const queue = remappedToolCallIds.get(originalId);
		if (queue) {
			queue.push(normalizedId);
			return;
		}
		remappedToolCallIds.set(originalId, [normalizedId]);
	};

	const consumeToolCallId = (originalId: string): string | null => {
		const queue = remappedToolCallIds.get(originalId);
		if (!queue || queue.length === 0) return null;
		const nextId = queue.shift() ?? null;
		if (queue.length === 0) remappedToolCallIds.delete(originalId);
		return nextId;
	};

	const ensureToolCallId = (rawId: string, seed: string): string => {
		const normalized = normalizeToolCallId(rawId);
		if (normalized.trim().length > 0) return normalized;
		return generateFallbackToolCallId(seed);
	};

	const systemPrompts = normalizeSystemPrompts(context.systemPrompt);
	// Composer-harness models need anchor/edit discipline pinned ahead of any
	// host prompt (see composer-discipline.ts for the observed failure modes).
	if (isComposerHarnessModel(model.id)) {
		systemPrompts.unshift(COMPOSER_EDIT_DISCIPLINE_PROMPT);
	}
	if (systemPrompts.length > 0) {
		const useDeveloperRole = model.reasoning && compat.supportsDeveloperRole;
		const role = useDeveloperRole ? "developer" : "system";
		// Default to one block per ordered system prompt so the leading prefix
		// stays byte-identical between turns and the provider's KV cache can
		// reuse it. Hosts whose chat templates reject follow-up system messages
		// (Qwen via vLLM, MiniMax, Alibaba Dashscope, Qwen Portal, …) opt out
		// via `compat.supportsMultipleSystemMessages = false`; in that mode we
		// coalesce into a single message joined by `\n\n`.
		if (compat.supportsMultipleSystemMessages) {
			for (const systemPrompt of systemPrompts) {
				params.push({ role, content: systemPrompt });
			}
		} else {
			params.push({ role, content: systemPrompts.join("\n\n") });
		}
	}

	let lastRole: string | null = null;

	for (let i = 0; i < transformedMessages.length; i++) {
		const msg = transformedMessages[i];
		// Some providers (e.g. Mistral/Devstral) don't allow user messages directly after tool results
		// Insert a synthetic assistant message to bridge the gap
		if (
			compat.requiresAssistantAfterToolResult &&
			lastRole === "toolResult" &&
			(msg.role === "user" || msg.role === "developer")
		) {
			params.push({
				role: "assistant",
				content: "I have processed the tool results.",
			});
		}

		const devAsUser = !compat.supportsDeveloperRole;
		if (msg.role === "user" || msg.role === "developer") {
			const role = !devAsUser && msg.role === "developer" ? "developer" : "user";
			if (typeof msg.content === "string") {
				const text = msg.content.toWellFormed();
				if (text.trim().length === 0) continue;
				params.push({
					role: role,
					content: text,
				});
			} else {
				const supportsImages = model.input.includes("image");
				const content: ChatCompletionContentPart[] = [];
				let omittedImages = false;
				for (const item of msg.content) {
					if (item.type === "text") {
						const text = item.text.toWellFormed();
						if (text.trim().length === 0) continue;
						content.push({
							type: "text",
							text,
						} satisfies ChatCompletionContentPartText);
					} else if (supportsImages) {
						content.push({
							type: "image_url",
							image_url: {
								url: `data:${item.mimeType};base64,${item.data}`,
							},
						} satisfies ChatCompletionContentPartImage);
					} else {
						omittedImages = true;
					}
				}
				if (omittedImages) {
					content.push({
						type: "text",
						text: NON_VISION_IMAGE_PLACEHOLDER,
					} satisfies ChatCompletionContentPartText);
				}
				if (content.length === 0) continue;
				params.push({
					role: "user",
					content,
				});
			}
		} else if (msg.role === "assistant") {
			// Some providers (e.g. Mistral) don't accept null content, use empty string instead
			const assistantMsg: ChatCompletionAssistantMessageParam = {
				role: "assistant",
				content: compat.requiresAssistantAfterToolResult ? "" : null,
			};

			const textBlocks = msg.content.filter(b => b.type === "text") as TextContent[];
			// Filter out empty text blocks to avoid API validation errors
			const nonEmptyTextBlocks = textBlocks.filter(b => b.text && b.text.trim().length > 0);
			if (nonEmptyTextBlocks.length > 0) {
				// Always send assistant content as a plain string. Some OpenAI-compatible
				// backends mirror array-of-text-block payloads back to the model literally,
				// causing recursive nested content in subsequent turns.
				assistantMsg.content = nonEmptyTextBlocks.map(b => b.text.toWellFormed()).join("");
			}

			// Handle thinking blocks
			const thinkingBlocks = msg.content.filter(b => b.type === "thinking") as ThinkingContent[];
			// Filter out empty thinking blocks to avoid API validation errors
			const nonEmptyThinkingBlocks = thinkingBlocks.filter(b => b.thinking && b.thinking.trim().length > 0);
			if (nonEmptyThinkingBlocks.length > 0) {
				if (compat.requiresThinkingAsText) {
					// Convert thinking blocks to plain text (no tags to avoid model mimicking them)
					const thinkingText = nonEmptyThinkingBlocks.map(b => b.thinking).join("\n\n");
					const textContent = assistantMsg.content as Array<{ type: "text"; text: string }> | null;
					if (textContent) {
						textContent.unshift({ type: "text", text: thinkingText });
					} else {
						assistantMsg.content = [{ type: "text", text: thinkingText }];
					}
				} else if (compat.requiresReasoningContentForToolCalls) {
					// Use the signature from the first thinking block if available, but only for
					// recognized OpenAI-compat reasoning field names. Opaque signatures from other
					// providers (Anthropic encrypted, OpenAI Responses JSON) are not valid property names.
					const signature = nonEmptyThinkingBlocks[0].thinkingSignature;
					const recognizedFields = ["reasoning_content", "reasoning", "reasoning_text"];
					if (signature && recognizedFields.includes(signature)) {
						(assistantMsg as any)[signature] = nonEmptyThinkingBlocks.map(b => b.thinking).join("\n");
					}
				}
			}

			if (compat.thinkingFormat === "openai" && compat.requiresReasoningContentForToolCalls) {
				const streamedReasoningField = nonEmptyThinkingBlocks[0]?.thinkingSignature;
				const reasoningField =
					streamedReasoningField === "reasoning_content" ||
					streamedReasoningField === "reasoning" ||
					streamedReasoningField === "reasoning_text"
						? streamedReasoningField
						: (compat.reasoningContentField ?? "reasoning_content");
				const reasoningContent = (assistantMsg as any)[reasoningField];
				if (!reasoningContent) {
					const reasoning = (assistantMsg as any).reasoning;
					const reasoningText = (assistantMsg as any).reasoning_text;
					if (reasoning && reasoningField !== "reasoning") {
						(assistantMsg as any)[reasoningField] = reasoning;
					} else if (reasoningText && reasoningField !== "reasoning_text") {
						(assistantMsg as any)[reasoningField] = reasoningText;
					} else if (nonEmptyThinkingBlocks.length > 0) {
						(assistantMsg as any)[reasoningField] = nonEmptyThinkingBlocks.map(b => b.thinking).join("\n");
					}
				}
			}

			const toolCalls = msg.content.filter(b => b.type === "toolCall") as ToolCall[];
			// Replay reasoning_content on assistant turns for backends that validate
			// thinking-mode history. DeepSeek V4 requires reasoning_content on EVERY
			// assistant turn once any prior turn included it — not just tool-call turns.
			// The replay logic has three tiers:
			//   1. Recover from thinking blocks with valid signatures (covers same-model replay
			//      where nonEmptyThinkingBlocks may have filtered out empty-text blocks)
			//   2. For providers that require the field but returned no reasoning at all
			//      (e.g. proxy-stripped reasoning_content), emit an empty string
			//   3. For providers that accept synthetic placeholders (Kimi, OpenRouter), emit "."
			// DeepSeek V4 rejects synthetic "." placeholders — it validates the exact value —
			// so the allowsSyntheticReasoningContentForToolCalls flag controls tier 3.
			const canUseSyntheticReasoningContent =
				compat.requiresReasoningContentForToolCalls &&
				compat.allowsSyntheticReasoningContentForToolCalls &&
				(compat.thinkingFormat === "openai" ||
					compat.thinkingFormat === "openrouter" ||
					compat.thinkingFormat === "zai");
			// DeepSeek reasoning models require reasoning_content on ALL assistant turns,
			// not just tool-call turns. Other providers (Kimi, OpenRouter) only require it
			// on tool-call turns.
			const needsReasoningOnAllTurns =
				compat.requiresReasoningContentForToolCalls && !compat.allowsSyntheticReasoningContentForToolCalls;
			const needsReasoningField = needsReasoningOnAllTurns || toolCalls.length > 0;
			let hasReasoningField =
				(assistantMsg as any).reasoning_content !== undefined ||
				(assistantMsg as any).reasoning !== undefined ||
				(assistantMsg as any).reasoning_text !== undefined;
			// Tier 1: Recover reasoning_content from ALL thinking blocks (including empty-text
			// ones) when the provider requires exact replay and rejects synthetic placeholders.
			// This covers the case where thinking blocks have valid signatures but were excluded
			// by the nonEmptyThinkingBlocks filter above, or where thinking text is empty but
			// the signature identifies the correct field name for replay.
			// Only recognized OpenAI-compat reasoning field names qualify — opaque signatures
			// from other providers (Anthropic encrypted, OpenAI Responses JSON, etc.) are not
			// valid property names for the wire message.
			if (
				needsReasoningField &&
				!hasReasoningField &&
				compat.requiresReasoningContentForToolCalls &&
				!compat.allowsSyntheticReasoningContentForToolCalls
			) {
				const allThinkingBlocks = msg.content.filter(b => b.type === "thinking") as ThinkingContent[];
				if (allThinkingBlocks.length > 0) {
					const signature = allThinkingBlocks[0].thinkingSignature;
					const recognizedFields = ["reasoning_content", "reasoning", "reasoning_text"];
					if (signature && recognizedFields.includes(signature)) {
						(assistantMsg as any)[signature] = allThinkingBlocks.map(b => b.thinking).join("\n");
						hasReasoningField = true;
					}
				}
			}
			// Tier 2: When the provider requires reasoning_content but there are genuinely no
			// thinking blocks at all (e.g. proxy stripped reasoning_content from the response),
			// emit an empty string. The field must be present; an empty string is the most honest
			// representation of "no reasoning was captured."
			if (
				needsReasoningField &&
				!hasReasoningField &&
				compat.requiresReasoningContentForToolCalls &&
				!compat.allowsSyntheticReasoningContentForToolCalls
			) {
				const reasoningField = compat.reasoningContentField ?? "reasoning_content";
				(assistantMsg as any)[reasoningField] = "";
				hasReasoningField = true;
			}
			// Tier 3: For providers that accept synthetic placeholders (Kimi, OpenRouter).
			if (toolCalls.length > 0 && canUseSyntheticReasoningContent && !hasReasoningField) {
				const reasoningField = compat.reasoningContentField ?? "reasoning_content";
				(assistantMsg as any)[reasoningField] = ".";
				hasReasoningField = true;
			}
			if (toolCalls.length > 0) {
				assistantMsg.tool_calls = toolCalls.map((tc, toolCallIndex) => {
					const toolCallId = ensureToolCallId(tc.id, `${i}:${toolCallIndex}:${tc.name}`);
					rememberToolCallId(tc.id, toolCallId);
					return {
						id: normalizeMistralToolId(toolCallId, compat.requiresMistralToolIds),
						type: "function" as const,
						function: {
							name: tc.name,
							arguments: serializeToolArguments(tc.arguments),
						},
					};
				});
				const reasoningDetails = toolCalls
					.filter(tc => tc.thoughtSignature)
					.map(tc => {
						try {
							return JSON.parse(tc.thoughtSignature!);
						} catch {
							return null;
						}
					})
					.filter(Boolean);
				if (reasoningDetails.length > 0) {
					(assistantMsg as any).reasoning_details = reasoningDetails;
				}
			}
			// DeepSeek requires non-null content when reasoning_content is present
			if (assistantMsg.content === null && hasReasoningField) {
				assistantMsg.content = "";
			}
			// Skip assistant messages that have no content, no tool calls, and no reasoning payload.
			// Some OpenAI-compatible backends require replaying reasoning-only assistant turns
			// so follow-up requests preserve the provider-specific reasoning field name.
			const content = assistantMsg.content;
			const hasContent =
				content !== null &&
				content !== undefined &&
				(typeof content === "string" ? content.length > 0 : content.length > 0);
			if (!hasContent && assistantMsg.tool_calls && compat.requiresAssistantContentForToolCalls) {
				assistantMsg.content = ".";
			}
			if (!hasContent && !assistantMsg.tool_calls && !hasReasoningField) {
				continue;
			}
			params.push(assistantMsg);
		} else if (msg.role === "toolResult") {
			// Batch consecutive tool results and collect all images
			const imageBlocks: Array<{ type: "image_url"; image_url: { url: string } }> = [];
			let j = i;

			for (; j < transformedMessages.length && transformedMessages[j].role === "toolResult"; j++) {
				const toolMsg = transformedMessages[j] as ToolResultMessage;

				// Extract text and image content
				const textResult = toolMsg.content
					.filter(c => c.type === "text")
					.map(c => (c as TextContent).text)
					.join("\n");
				const supportsImages = model.input.includes("image");
				const hasImages = toolMsg.content.some(c => c.type === "image");
				const omittedImages = hasImages && !supportsImages;

				// Always send tool result with text (or placeholder if only images)
				const hasText = textResult.length > 0;
				const remappedToolCallId = consumeToolCallId(toolMsg.toolCallId);
				const resolvedToolCallId =
					remappedToolCallId ?? ensureToolCallId(toolMsg.toolCallId, `${j}:${toolMsg.toolName ?? "tool"}`);
				const toolResultContent = omittedImages
					? joinTextWithImagePlaceholder(textResult, true)
					: hasText
						? textResult
						: hasImages
							? "(see attached image)"
							: "";
				const toolResultMsg: ChatCompletionToolMessageParam = {
					role: "tool",
					content: toolResultContent.toWellFormed(),
					tool_call_id: normalizeMistralToolId(resolvedToolCallId, compat.requiresMistralToolIds),
				};
				if (compat.requiresToolResultName && toolMsg.toolName) {
					(toolResultMsg as any).name = toolMsg.toolName;
				}
				params.push(toolResultMsg);

				if (hasImages && supportsImages) {
					for (const block of toolMsg.content) {
						if (block.type === "image") {
							imageBlocks.push({
								type: "image_url",
								image_url: {
									url: `data:${block.mimeType};base64,${block.data}`,
								},
							});
						}
					}
				}
			}

			i = j - 1;

			// After all consecutive tool results, add a single user message with all images
			if (imageBlocks.length > 0) {
				if (compat.requiresAssistantAfterToolResult) {
					params.push({
						role: "assistant",
						content: "I have processed the tool results.",
					});
				}

				params.push({
					role: "user",
					content: [
						{
							type: "text",
							text: "Attached image(s) from tool result:",
						},
						...imageBlocks,
					],
				});
				lastRole = "user";
			} else {
				lastRole = "toolResult";
			}
			continue;
		}

		lastRole =
			msg.role === "developer"
				? model.reasoning && compat.supportsDeveloperRole
					? "developer"
					: "system"
				: msg.role;
	}

	return params;
}

function convertTools(
	tools: Tool[],
	compat: ResolvedOpenAICompat,
	toolStrictModeOverride?: ToolStrictModeOverride,
): BuiltOpenAICompletionTools {
	const adaptedTools = tools.map(tool => {
		const strict = !NO_STRICT && compat.supportsStrictMode !== false && tool.strict !== false;
		const baseParameters = flattenToolRootCombinators(toolWireSchema(tool));
		const adapted = adaptSchemaForStrict(baseParameters, strict);
		return {
			tool,
			baseParameters,
			parameters: adapted.schema,
			strict: adapted.strict,
		};
	});

	const requestedStrictMode = toolStrictModeOverride ?? compat.toolStrictMode;
	const toolStrictMode =
		requestedStrictMode === "none"
			? "none"
			: requestedStrictMode === "all_strict"
				? adaptedTools.every(tool => tool.strict)
					? "all_strict"
					: "none"
				: "mixed";

	return {
		tools: adaptedTools.map(({ tool, baseParameters, parameters, strict }) => {
			const includeStrict = toolStrictMode === "all_strict" || (toolStrictMode === "mixed" && strict);
			return {
				type: "function",
				function: {
					name: tool.name,
					description: tool.description || "",
					parameters: includeStrict ? parameters : baseParameters,
					// Only include strict if provider supports it. Some reject unknown fields.
					...(includeStrict && { strict: true }),
				},
			};
		}),
		toolStrictMode,
	};
}

function shouldRetryWithoutStrictTools(
	error: unknown,
	capturedErrorResponse: CapturedHttpErrorResponse | undefined,
	toolStrictMode: AppliedToolStrictMode,
	tools: Tool[] | undefined,
): boolean {
	if (!tools || tools.length === 0 || toolStrictMode !== "all_strict") {
		return false;
	}
	const status = extractHttpStatusFromError(error) ?? capturedErrorResponse?.status;
	if (status !== 400 && status !== 422) {
		return false;
	}
	const messageParts = [error instanceof Error ? error.message : undefined, capturedErrorResponse?.bodyText]
		.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
		.join("\n");
	return /wrong_api_format|mixed values for 'strict'|tool[s]?\b.*strict|\bstrict\b.*tool/i.test(messageParts);
}

function mapStopReason(reason: ChatCompletionChunk.Choice["finish_reason"] | string): {
	stopReason: StopReason;
	errorMessage?: string;
} {
	if (reason === null) return { stopReason: "stop" };
	switch (reason) {
		case "stop":
		case "end":
			return { stopReason: "stop" };
		case "length":
			return { stopReason: "length" };
		case "function_call":
		case "tool_calls":
			return { stopReason: "toolUse" };
		case "content_filter":
			return { stopReason: "error", errorMessage: "Provider finish_reason: content_filter" };
		case "network_error":
			return { stopReason: "error", errorMessage: "Provider finish_reason: network_error" };
		default:
			return {
				stopReason: "error",
				errorMessage: `Provider finish_reason: ${reason}`,
			};
	}
}

/**
 * Detect compatibility settings from provider and baseUrl for known providers.
 * Provider takes precedence over URL-based detection since it's explicitly configured.
 * Returns a fully resolved OpenAICompat object with all fields set.
 */
export function detectCompat(model: Model<"openai-completions">): ResolvedOpenAICompat {
	return detectOpenAICompat(model);
}

/**
 * Get resolved compatibility settings for a model.
 * Uses explicit model.compat if provided, otherwise auto-detects from provider/URL.
 * @param model - The model configuration
 * @param resolvedBaseUrl - Optional resolved base URL (e.g., after GitHub Copilot proxy-ep resolution).
 */
function getCompat(model: Model<"openai-completions">, resolvedBaseUrl?: string): ResolvedOpenAICompat {
	return resolveOpenAICompat(model, resolvedBaseUrl);
}
