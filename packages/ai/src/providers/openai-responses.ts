import {
	$credentialEnv,
	$env,
	$inheritedEnv,
	extractHttpStatusFromError,
	logger,
	structuredCloneJSON,
} from "@gajae-code/utils";
import OpenAI from "openai";
import type {
	Tool as OpenAITool,
	ResponseCreateParamsStreaming,
	ResponseInput,
} from "openai/resources/responses/responses";
import packageJson from "../../package.json" with { type: "json" };
import { getEnvApiKey } from "../stream";
import type {
	AssistantMessage,
	CacheRetention,
	Context,
	FetchImpl,
	MessageAttribution,
	Model,
	OpenAICompat,
	ProviderSessionState,
	ServiceTier,
	StreamFunction,
	StreamOptions,
	Tool,
	ToolChoice,
} from "../types";
import {
	createOpenAIResponsesHistoryPayload,
	getOpenAIResponsesHistoryItems,
	getOpenAIResponsesHistoryPayload,
	isInvalidPromptError,
	neutralizeResponsesInputControlTokens,
	normalizeSystemPrompts,
	resolveCacheRetention,
	sanitizeOpenAIResponsesHistoryItemsForReplay,
} from "../utils";
import { createAbortSourceTracker } from "../utils/abort";
import { AssistantMessageEventStream } from "../utils/event-stream";
import { transportFailureFacts } from "../utils/fallback-transport";
import { finalizeErrorMessage, type RawHttpRequestDump, rewriteCopilotError } from "../utils/http-inspector";
import {
	createWatchdog,
	getOpenAIStreamIdleTimeoutMs,
	getStreamFirstEventTimeoutMs,
	iterateWithIdleTimeout,
} from "../utils/idle-iterator";
import { parseGitHubCopilotApiKey } from "../utils/oauth/github-copilot";
import { notifyProviderResponse } from "../utils/provider-response";
import { callWithCopilotModelRetry } from "../utils/retry";
import { resolveRetryBudget } from "../utils/retry-budget";
import {
	adaptSchemaForStrict,
	flattenToolRootCombinators,
	NO_STRICT,
	sanitizeSchemaForOpenAIResponses,
	toolWireSchema,
} from "../utils/schema";
import { wrapFetchForSseDebug } from "../utils/sse-debug";
import { mapToOpenAIResponsesToolChoice, type OpenAIResponsesToolChoice } from "../utils/tool-choice";
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
import { compactGrammarDefinition } from "./grammar";
import { wrapOpenAIFetchForBoundedRateLimits } from "./openai-bounded-rate-limits";
import {
	applyOpenAIRequestTransformBody,
	applyOpenAIRequestTransformHeaders,
	wrapFetchForOpenAIRequestTransform,
} from "./openai-request-transform";
import {
	appendResponsesToolResultMessages,
	applyCommonResponsesSamplingParams,
	applyResponsesReasoningParams,
	collectCustomCallIds,
	collectKnownCallIds,
	convertResponsesAssistantMessage,
	convertResponsesInputContent,
	createInitialResponsesAssistantMessage,
	normalizeResponsesToolCallIdForTransform,
	processResponsesStream,
	repairOrphanResponsesToolOutputs,
} from "./openai-responses-shared";
import { transformMessages } from "./transform-messages";

/**
 * Get prompt cache retention based on cacheRetention and base URL.
 * Only applies to direct OpenAI API calls (api.openai.com).
 */
function getPromptCacheRetention(baseUrl: string | undefined, cacheRetention: CacheRetention): "24h" | undefined {
	if (cacheRetention !== "long") {
		return undefined;
	}
	if (baseUrl && isDefaultOpenAIBaseUrl(baseUrl)) {
		return "24h";
	}
	return undefined;
}

export function normalizeOpenAIResponsesPromptCacheKey(sessionId: string | undefined): string | undefined {
	if (!sessionId || sessionId.length === 0) return undefined;
	const wellFormed = sessionId.toWellFormed();
	if (wellFormed.length <= 64) return wellFormed;
	return `pc_${Bun.hash(wellFormed).toString(36)}`;
}

// OpenAI Responses-specific options
export interface OpenAIResponsesOptions extends StreamOptions {
	reasoning?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	reasoningSummary?: "auto" | "detailed" | "concise" | null;
	serviceTier?: ServiceTier;
	toolChoice?: ToolChoice;
	/**
	 * Enforce strict tool call/result pairing when building Responses API inputs.
	 * Azure OpenAI and GitHub Copilot Responses paths require tool results to match prior tool calls.
	 */
	strictResponsesPairing?: boolean;
}

const OPENAI_RESPONSES_PROVIDER_SESSION_STATE_PREFIX = "openai-responses:";
const ALIBABA_TOKEN_PLAN_FIRST_EVENT_TIMEOUT_MS = 300_000;
const OPENAI_RESPONSES_FIRST_EVENT_TIMEOUT_MESSAGE =
	"OpenAI responses stream timed out while waiting for the first event";
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

function isOpenAIHostBaseUrl(baseUrl: string): boolean {
	try {
		const url = new URL(baseUrl);
		return url.hostname === OPENAI_DEFAULT_BASE_URL_HOST;
	} catch {
		return baseUrl.toLowerCase().startsWith(OPENAI_DEFAULT_BASE_URL);
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

const OPENAI_RESPONSES_PROGRESS_EVENT_TYPES = new Set([
	"response.created",
	"response.output_item.added",
	"response.reasoning_summary_part.added",
	"response.reasoning_summary_text.delta",
	"response.reasoning_summary_part.done",
	"response.reasoning_text.delta",
	"response.content_part.added",
	"response.output_text.delta",
	"response.refusal.delta",
	"response.function_call_arguments.delta",
	"response.function_call_arguments.done",
	"response.custom_tool_call_input.delta",
	"response.custom_tool_call_input.done",
	"response.output_item.done",
	"response.completed",
	"response.failed",
	"error",
]);

function isOpenAIResponsesProgressEvent(event: unknown): boolean {
	if (!event || typeof event !== "object") return false;
	const type = (event as { type?: unknown }).type;
	return typeof type === "string" && OPENAI_RESPONSES_PROGRESS_EVENT_TYPES.has(type);
}

interface OpenAIResponsesProviderSessionState extends ProviderSessionState {
	nativeHistoryReplayWarmed: boolean;
}

function createOpenAIResponsesProviderSessionState(): OpenAIResponsesProviderSessionState {
	const state: OpenAIResponsesProviderSessionState = {
		nativeHistoryReplayWarmed: false,
		close: () => {
			state.nativeHistoryReplayWarmed = false;
		},
	};
	return state;
}

function getOpenAIResponsesProviderSessionStateKey(model: Model<"openai-responses">): string {
	return `${OPENAI_RESPONSES_PROVIDER_SESSION_STATE_PREFIX}${model.provider}`;
}

function getOpenAIResponsesProviderSessionState(
	model: Model<"openai-responses">,
	providerSessionState: Map<string, ProviderSessionState> | undefined,
): OpenAIResponsesProviderSessionState | undefined {
	if (!providerSessionState) return undefined;
	const key = getOpenAIResponsesProviderSessionStateKey(model);
	const existing = providerSessionState.get(key) as OpenAIResponsesProviderSessionState | undefined;
	if (existing) return existing;
	const created = createOpenAIResponsesProviderSessionState();
	providerSessionState.set(key, created);
	return created;
}

function canReplayOpenAIResponsesNativeHistory(
	providerSessionState: OpenAIResponsesProviderSessionState | undefined,
): boolean {
	return providerSessionState?.nativeHistoryReplayWarmed ?? true;
}

type OpenAIResponsesSamplingParams = ResponseCreateParamsStreaming & {
	top_p?: number;
	top_k?: number;
	min_p?: number;
	presence_penalty?: number;
	repetition_penalty?: number;
	stream_options?: { include_obfuscation?: boolean };
};

/**
 * Generate function for OpenAI Responses API
 */
export const streamOpenAIResponses: StreamFunction<"openai-responses"> = (
	model: Model<"openai-responses">,
	context: Context,
	options?: OpenAIResponsesOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();

	// Start async processing
	(async () => {
		const startTime = Date.now();
		let firstTokenTime: number | undefined;

		const output: AssistantMessage = createInitialResponsesAssistantMessage(
			"openai-responses",
			model.provider,
			model.id,
		);
		let rawRequestDump: RawHttpRequestDump | undefined;
		const abortTracker = createAbortSourceTracker(options?.signal);
		const firstEventTimeoutAbortError = new Error(OPENAI_RESPONSES_FIRST_EVENT_TIMEOUT_MESSAGE);
		const { requestAbortController, requestSignal } = abortTracker;

		try {
			// Keep request headers and prompt-cache routing on the same session-derived value.
			const cacheSessionId = getOpenAIResponsesCacheSessionId(options);
			const apiKey = options?.apiKey || getEnvApiKey(model.provider) || "";
			const { client, copilotPremiumRequests, baseUrl } = createClient(
				model,
				context,
				apiKey,
				options?.headers,
				options?.initiatorOverride,
				cacheSessionId,
				options?.onSseEvent,
				options?.fetch,
				options?.authCredentialType,
				options?.requestMaxRetries,
				options?.maxRetryDelayMs,
			);
			const premiumRequestsTotal = copilotPremiumRequests;
			const providerSessionState = getOpenAIResponsesProviderSessionState(model, options?.providerSessionState);
			const { params } = buildParams(model, context, options, providerSessionState, baseUrl);
			const idleTimeoutMs = options?.streamIdleTimeoutMs ?? getOpenAIStreamIdleTimeoutMs();
			options?.onPayload?.(params);
			rawRequestDump = {
				provider: model.provider,
				api: output.api,
				model: model.id,
				method: "POST",
				url: `${baseUrl}/responses`,
				body: params,
			};
			const openaiStream = await callWithCopilotModelRetry(
				async () => {
					const { data, response, request_id } = await client.responses
						.create(params, { signal: requestSignal })
						.withResponse();
					await notifyProviderResponse(options, response, model, request_id);
					return data;
				},
				{ provider: model.provider, signal: requestSignal, fallbackManaged: options?.fallbackManaged },
			).catch(async error => {
				if (
					options?.fallbackManaged ||
					!isForcedToolChoiceUnsupportedError(error, isForcedOpenAIResponsesToolChoice(params.tool_choice))
				) {
					throw error;
				}
				const reason = await finalizeErrorMessage(error, rawRequestDump);
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
				delete params.tool_choice;
				if (rawRequestDump) rawRequestDump.body = params;
				const { data, response, request_id } = await client.responses
					.create(params, { signal: requestSignal })
					.withResponse();
				await notifyProviderResponse(options, response, model, request_id);
				return data;
			});
			const firstEventFallbackMs =
				model.provider === "alibaba-token-plan" ? ALIBABA_TOKEN_PLAN_FIRST_EVENT_TIMEOUT_MS : undefined;
			const firstEventWatchdog = createWatchdog(
				options?.streamFirstEventTimeoutMs ?? getStreamFirstEventTimeoutMs(idleTimeoutMs, firstEventFallbackMs),
				() => abortTracker.abortLocally(firstEventTimeoutAbortError),
			);
			if (premiumRequestsTotal !== undefined) output.usage.premiumRequests = premiumRequestsTotal;
			stream.push({ type: "start", partial: output });

			const nativeOutputItems: Array<Record<string, unknown>> = [];
			await processResponsesStream(
				iterateWithIdleTimeout(openaiStream, {
					idleTimeoutMs,
					watchdog: firstEventWatchdog,
					errorMessage: "OpenAI responses stream stalled while waiting for the next event",
					onIdle: () => requestAbortController.abort(),
					abortSignal: options?.signal,
					isProgressItem: isOpenAIResponsesProgressEvent,
				}),
				output,
				stream,
				model,
				{
					onFirstToken: () => {
						if (!firstTokenTime) firstTokenTime = Date.now();
					},
					onOutputItemDone: item => {
						nativeOutputItems.push(structuredCloneJSON<unknown>(item) as unknown as Record<string, unknown>);
					},
				},
			);
			if (premiumRequestsTotal !== undefined) output.usage.premiumRequests = premiumRequestsTotal;

			const firstEventTimeoutError = abortTracker.getLocalAbortReason();
			if (firstEventTimeoutError) {
				throw firstEventTimeoutError;
			}
			if (abortTracker.wasCallerAbort()) {
				throw new Error("Request was aborted");
			}

			if (output.stopReason === "aborted" || output.stopReason === "error") {
				throw new Error(output.errorMessage ?? "An unknown error occurred");
			}

			output.providerPayload = createOpenAIResponsesHistoryPayload(model.provider, nativeOutputItems);
			if (providerSessionState) providerSessionState.nativeHistoryReplayWarmed = true;

			output.duration = Date.now() - startTime;
			if (firstTokenTime) output.ttft = firstTokenTime - startTime;
			stream.push({ type: "done", reason: output.stopReason, message: output });
			stream.end();
		} catch (error) {
			for (const block of output.content) delete (block as { index?: number }).index;
			const firstEventTimeoutError = abortTracker.getLocalAbortReason();
			output.stopReason = abortTracker.wasCallerAbort() ? "aborted" : "error";
			output.errorStatus = extractHttpStatusFromError(error);
			output.transportFailure = transportFailureFacts(error);
			output.errorMessage = firstEventTimeoutError?.message ?? (await finalizeErrorMessage(error, rawRequestDump));
			output.errorMessage = rewriteCopilotError(output.errorMessage, error, model.provider);
			// Explicitly mark the poisoned-history rejection so the shared
			// `invalid_prompt` contract is present even when the SDK error surfaces
			// only a message (no structured code). This keeps the responses
			// transport's classification uniform with the codex transport's
			// non-retryable event set and lets the session-level circuit breaker
			// key on one durable marker instead of per-transport string matching.
			if (
				output.stopReason === "error" &&
				!output.transportFailure?.providerCode &&
				(isInvalidPromptError(error) || isInvalidPromptError(output.errorMessage))
			) {
				output.transportFailure = {
					...(output.transportFailure ?? { kind: "transport" }),
					providerCode: "invalid_prompt",
				};
			}
			output.duration = Date.now() - startTime;
			if (firstTokenTime) output.ttft = firstTokenTime - startTime;
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
};

function createClient(
	model: Model<"openai-responses">,
	context: Context,
	apiKey?: string,
	extraHeaders?: Record<string, string>,
	initiatorOverride?: MessageAttribution,
	sessionId?: string,
	onSseEvent?: OpenAIResponsesOptions["onSseEvent"],
	fetchOverride?: FetchImpl,
	authCredentialType?: OpenAIResponsesOptions["authCredentialType"],
	requestMaxRetries?: number,
	maxRetryDelayMs?: number,
): {
	client: OpenAI;
	copilotPremiumRequests: number | undefined;
	baseUrl: string | undefined;
} {
	if (!apiKey) {
		apiKey = $credentialEnv("OPENAI_API_KEY");
		if (!apiKey) {
			throw new Error(
				"OpenAI API key is required. Set OPENAI_API_KEY environment variable or pass it as an argument.",
			);
		}
	}
	const rawApiKey = apiKey;

	const headers = applyOpenAIRequestTransformHeaders(
		{ ...(model.headers ?? {}), ...(extraHeaders ?? {}) },
		model.requestTransform,
		`Gajae-Code/${packageJson.version}`,
	);
	let copilotPremiumRequests: number | undefined;

	let baseUrl =
		model.provider === "openai" ? resolveOpenAIProviderBaseUrl(model.baseUrl, authCredentialType) : model.baseUrl;
	if (model.provider === "openai" && !baseUrl) {
		baseUrl = OPENAI_DEFAULT_BASE_URL;
	}
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
	if (sessionId && model.provider === "openai" && (!model.baseUrl || (baseUrl && isDefaultOpenAIBaseUrl(baseUrl)))) {
		headers.session_id ??= sessionId;
		headers["x-client-request-id"] ??= sessionId;
	}
	const baseFetch = fetchOverride ?? fetch;
	const boundedFetch = wrapOpenAIFetchForBoundedRateLimits(baseFetch, maxRetryDelayMs);
	const transformedFetch = wrapFetchForOpenAIRequestTransform(
		boundedFetch,
		model.requestTransform,
		`Gajae-Code/${packageJson.version}`,
	);
	return {
		client: new OpenAI({
			apiKey,
			baseURL: baseUrl,
			dangerouslyAllowBrowser: true,
			maxRetries: resolveRetryBudget(requestMaxRetries, 5),
			defaultHeaders: headers,
			fetch: onSseEvent
				? wrapFetchForSseDebug(transformedFetch, event => onSseEvent(event, model))
				: transformedFetch,
		}),
		copilotPremiumRequests,
		baseUrl,
	};
}

function getOpenAIResponsesCacheSessionId(
	options: Pick<OpenAIResponsesOptions, "sessionId"> | undefined,
): string | undefined {
	return normalizeOpenAIResponsesPromptCacheKey(options?.sessionId);
}

function buildParams(
	model: Model<"openai-responses">,
	context: Context,
	options: OpenAIResponsesOptions | undefined,
	providerSessionState: OpenAIResponsesProviderSessionState | undefined,
	resolvedBaseUrl?: string,
): { conversationMessages: ResponseInput; params: OpenAIResponsesSamplingParams } {
	const strictResponsesPairing =
		options?.strictResponsesPairing ??
		(isAzureOpenAIBaseUrl(model.baseUrl ?? "") || model.provider === "github-copilot");
	const conversationMessages = convertConversationMessages(
		model,
		context,
		strictResponsesPairing,
		providerSessionState,
	);
	const messages: ResponseInput = neutralizeResponsesInputControlTokens(conversationMessages);

	const systemPrompts = normalizeSystemPrompts(context.systemPrompt);
	if (isComposerHarnessModel(model.id)) {
		systemPrompts.unshift(COMPOSER_EDIT_DISCIPLINE_PROMPT);
	}
	let systemInstructions: string | undefined;
	if (systemPrompts.length > 0) {
		const needsDeveloperRole =
			model.reasoning &&
			((model.provider === "openai" && !model.baseUrl) || supportsDeveloperRole(resolvedBaseUrl || model));
		if (needsDeveloperRole) {
			// Reasoning models on known OpenAI-compatible endpoints require the
			// `developer` role. Send all system prompts inline in `input`.
			messages.unshift(
				...systemPrompts.map(systemPrompt => ({ role: "developer" as const, content: systemPrompt })),
			);
		} else {
			// All other endpoints (including third-party /v1/responses proxies) use
			// the canonical top-level `instructions` field so that proxies that
			// reject `input[{role:"system"}]` work out of the box.
			systemInstructions = systemPrompts.join("\n\n");
		}
	}

	const cacheRetention = resolveCacheRetention(options?.cacheRetention ?? model.cacheRetention);
	const promptCacheKey = getOpenAIResponsesCacheSessionId(options);
	const params: OpenAIResponsesSamplingParams = {
		model: model.wireModelId ?? model.id,
		input: messages,
		instructions: systemInstructions,
		stream: true,
		prompt_cache_key: promptCacheKey,
		prompt_cache_retention: getPromptCacheRetention(resolvedBaseUrl || model.baseUrl, cacheRetention),
		store: false,
		stream_options: model.provider === "openai" ? { include_obfuscation: false } : undefined,
	};

	applyCommonResponsesSamplingParams(params, options, model.provider);
	// TODO: openai responses has no top-level `stop`/`stop_sequences`; surface via reasoning.stop?
	// `StreamOptions.stopSequences` is intentionally dropped for this provider.
	// TODO: openai responses has no top-level `frequency_penalty` field as of the current SDK;
	// `StreamOptions.frequencyPenalty` is intentionally dropped for this provider.

	if (context.tools) {
		params.tools = convertTools(context.tools, supportsStrictMode(model), model);
		if (options?.toolChoice) {
			const toolChoice = resolveToolChoice(model, options.toolChoice);
			if (toolChoice.degraded && toolChoice.supportSource === "runtime") {
				logger.debug("openai-responses: degraded tool_choice after runtime capability discovery", {
					model: model.id,
					requestedLevel: toolChoice.requestedLevel,
					resolvedLevel: toolChoice.resolvedLevel,
					reason: toolChoice.reason,
				});
			}
			params.tool_choice = mapOpenAIResponsesToolChoiceForTools(toolChoice.resolvedChoice, context.tools, model);
		}
		// The apply_patch spec §1 marks only `apply_patch` itself as
		// `supports_parallel_tool_calls = false`. OpenAI's Responses API
		// exposes `parallel_tool_calls` as a request-scoped flag, not a
		// per-tool one, so when a custom grammar tool is in the list we
		// disable parallelism for the whole turn. Slightly coarser than
		// the spec requires — but the platform API offers no finer knob.
		if (params.tools.some(t => (t as { type?: string }).type === "custom")) {
			params.parallel_tool_calls = false;
		}
	}

	applyResponsesReasoningParams(params, model, options, messages, effort =>
		mapReasoningEffort(effort as NonNullable<OpenAIResponsesOptions["reasoning"]>, model.compat?.reasoningEffortMap),
	);
	applyOpenAIRequestTransformBody(params, model.requestTransform);

	return { conversationMessages, params };
}

function mapReasoningEffort(
	effort: NonNullable<OpenAIResponsesOptions["reasoning"]>,
	reasoningEffortMap: OpenAICompat["reasoningEffortMap"] | undefined,
): string {
	return reasoningEffortMap?.[effort] ?? effort;
}

function isAzureOpenAIBaseUrl(baseUrl: string): boolean {
	return baseUrl.includes(".openai.azure.com") || baseUrl.includes("azure.com/openai");
}

function supportsStrictMode(model: Model<"openai-responses">): boolean {
	if (model.provider === "openai" || model.provider === "azure" || model.provider === "github-copilot") return true;

	const baseUrl = model.baseUrl;
	const lowerBaseUrl = baseUrl.toLowerCase();
	return (
		isDefaultOpenAIBaseUrl(baseUrl) ||
		lowerBaseUrl.includes(".openai.azure.com") ||
		lowerBaseUrl.includes("models.inference.ai.azure.com")
	);
}

export function supportsDeveloperRole(modelOrBaseUrl: Pick<Model, "provider" | "baseUrl"> | string): boolean {
	const baseUrl = typeof modelOrBaseUrl === "string" ? modelOrBaseUrl : (modelOrBaseUrl.baseUrl ?? "");
	if (typeof modelOrBaseUrl !== "string" && modelOrBaseUrl.provider === "openai" && !baseUrl) {
		return true;
	}
	const lowerBaseUrl = baseUrl.toLowerCase();
	return (
		isOpenAIHostBaseUrl(baseUrl) ||
		lowerBaseUrl.includes(".openai.azure.com") ||
		lowerBaseUrl.includes("azure.com/openai") ||
		lowerBaseUrl.includes("models.inference.ai.azure.com") ||
		lowerBaseUrl.includes("githubcopilot.com") ||
		lowerBaseUrl.includes("copilot-api.")
	);
}

function convertConversationMessages(
	model: Model<"openai-responses">,
	context: Context,
	strictResponsesPairing: boolean,
	providerSessionState: OpenAIResponsesProviderSessionState | undefined,
): ResponseInput {
	const messages: ResponseInput = [];
	let knownCallIds = new Set<string>();
	const customCallIds = new Set<string>();
	const shouldReplayNativeHistory = canReplayOpenAIResponsesNativeHistory(providerSessionState);
	const transformedMessages = transformMessages(context.messages, model, normalizeResponsesToolCallIdForTransform);

	let msgIndex = 0;
	for (const msg of transformedMessages) {
		if (msg.role === "user" || msg.role === "developer") {
			const providerPayload = (msg as { providerPayload?: AssistantMessage["providerPayload"] }).providerPayload;
			const historyItems = getOpenAIResponsesHistoryItems(providerPayload, model.provider);
			const shouldReplayPayloadItems =
				shouldReplayNativeHistory ||
				(historyItems?.some(item => {
					if (!item || typeof item !== "object") return false;
					const candidate = item as { type?: unknown };
					return candidate.type === "compaction" || candidate.type === "compaction_summary";
				}) ??
					false);
			if (historyItems && shouldReplayPayloadItems) {
				messages.push(...sanitizeOpenAIResponsesHistoryItemsForReplay(historyItems));
				knownCallIds = collectKnownCallIds(messages);
				for (const id of collectCustomCallIds(messages)) customCallIds.add(id);
				msgIndex++;
				continue;
			}
			const content = convertResponsesInputContent(msg.content, model.input.includes("image"));
			if (!content) continue;
			messages.push({ role: "user", content });
		} else if (msg.role === "assistant") {
			const assistantMsg = msg as AssistantMessage;
			const providerPayload = shouldReplayNativeHistory
				? getOpenAIResponsesHistoryPayload(assistantMsg.providerPayload, model.provider, assistantMsg.provider)
				: undefined;
			const historyItems = providerPayload?.items;
			if (historyItems) {
				const sanitizedHistoryItems = sanitizeOpenAIResponsesHistoryItemsForReplay(historyItems);
				if (providerPayload?.dt) {
					messages.push(...sanitizedHistoryItems);
				} else {
					messages.splice(0, messages.length, ...sanitizedHistoryItems);
				}
				knownCallIds = collectKnownCallIds(messages);
				for (const id of collectCustomCallIds(messages)) customCallIds.add(id);
				msgIndex++;
				continue;
			}

			const outputItems = convertResponsesAssistantMessage(
				assistantMsg,
				model,
				msgIndex,
				knownCallIds,
				shouldReplayNativeHistory,
				customCallIds,
			);
			if (outputItems.length === 0) continue;
			messages.push(...outputItems);
		} else if (msg.role === "toolResult") {
			appendResponsesToolResultMessages(messages, msg, model, strictResponsesPairing, knownCallIds, customCallIds);
		}
		msgIndex++;
	}

	return repairOrphanResponsesToolOutputs(messages);
}

/**
 * Whether this model should get the OpenAI custom-tool grammar variant
 * for `apply_patch`. The generated model catalog sets
 * `model.applyPatchToolType` for first-party GPT-5 Responses models; this
 * runtime path only consumes that metadata.
 * @internal Exported for tests.
 */
export function supportsFreeformApplyPatch(model: Model<"openai-responses">): boolean {
	return model.applyPatchToolType === "freeform";
}

/** @internal Exported for tests. */
export function mapOpenAIResponsesToolChoiceForTools(
	choice: ToolChoice | undefined,
	tools: Tool[],
	model: Model<"openai-responses">,
): OpenAIResponsesToolChoice {
	const mapped = mapToOpenAIResponsesToolChoice(choice);
	if (!mapped || typeof mapped === "string" || mapped.type !== "function" || !supportsFreeformApplyPatch(model)) {
		return mapped;
	}

	const customTool = tools.find(
		tool => tool.customFormat && (tool.name === mapped.name || tool.customWireName === mapped.name),
	);
	return customTool ? { type: "custom", name: customTool.customWireName ?? customTool.name } : mapped;
}

function isForcedOpenAIResponsesToolChoice(choice: unknown): boolean {
	return !!choice && choice !== "none" && choice !== "auto";
}

/** @internal Exported for tests. */
export function convertTools(tools: Tool[], strictMode: boolean, model: Model<"openai-responses">): OpenAITool[] {
	const allowFreeform = supportsFreeformApplyPatch(model);
	return tools.map(tool => {
		if (allowFreeform && tool.customFormat) {
			return {
				type: "custom",
				// Tool advertises its wire-level name (e.g. `apply_patch`) — the
				// agent-loop dispatcher will match incoming calls by either the
				// internal `name` or `customWireName`.
				name: tool.customWireName ?? tool.name,
				description: tool.description || "",
				format: {
					type: "grammar",
					syntax: tool.customFormat.syntax,
					definition: compactGrammarDefinition(tool.customFormat.syntax, tool.customFormat.definition),
				},
			} as unknown as OpenAITool;
		}
		const strict = !NO_STRICT && strictMode && tool.strict !== false;
		const baseParameters = flattenToolRootCombinators(toolWireSchema(tool));
		const responseParameters = sanitizeSchemaForOpenAIResponses(baseParameters);
		const { schema: parameters, strict: effectiveStrict } = adaptSchemaForStrict(responseParameters, strict);
		return {
			type: "function",
			name: tool.name,
			description: tool.description || "",
			parameters,
			...(effectiveStrict && { strict: true }),
		} as OpenAITool;
	});
}
