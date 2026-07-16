import * as os from "node:os";
import { scheduler } from "node:timers/promises";
import {
	$env,
	$flag,
	asRecord,
	extractHttpStatusFromError,
	fetchWithRetry,
	logger,
	readSseJson,
	structuredCloneJSON,
} from "@gajae-code/utils";
import type OpenAI from "openai";
import type {
	ResponseCustomToolCall,
	ResponseFunctionToolCall,
	ResponseInput,
	ResponseInputContent,
	ResponseOutputMessage,
	ResponseReasoningItem,
} from "openai/resources/responses/responses";
import packageJson from "../../package.json" with { type: "json" };
import { calculateCost } from "../models";
import { getEnvApiKey } from "../stream";
import {
	type Api,
	type AssistantMessage,
	type Context,
	type FetchImpl,
	type Model,
	type ProviderSessionState,
	resolveServiceTier,
	type ServiceTier,
	type StreamFunction,
	type StreamOptions,
	type TextContent,
	type ThinkingContent,
	type Tool,
	type ToolCall,
	type ToolChoice,
} from "../types";
import {
	createOpenAIResponsesHistoryPayload,
	getOpenAIResponsesHistoryItems,
	getOpenAIResponsesHistoryPayload,
	neutralizeResponsesInputControlTokens,
	normalizeSystemPrompts,
	sanitizeOpenAIResponsesHistoryItemsForReplay,
} from "../utils";
import { AssistantMessageEventStream } from "../utils/event-stream";
import { transportFailureFacts } from "../utils/fallback-transport";
import { finalizeErrorMessage, type RawHttpRequestDump } from "../utils/http-inspector";
import { getOpenAIStreamIdleTimeoutMs, iterateWithIdleTimeout } from "../utils/idle-iterator";
import { parseStreamingJson } from "../utils/json-parse";
import { resolveRetryBudget } from "../utils/retry-budget";
import {
	adaptSchemaForStrict,
	flattenToolRootCombinators,
	NO_STRICT,
	sanitizeSchemaForOpenAIResponses,
	toolWireSchema,
} from "../utils/schema";
import {
	isForcedToolChoiceUnsupportedError,
	markToolChoiceIncapability,
	resolveToolChoice,
} from "../utils/tool-choice-capability";
import { compactGrammarDefinition } from "./grammar";
import { CODEX_BASE_URL, getCodexAccountId, OPENAI_HEADER_VALUES, OPENAI_HEADERS } from "./openai-codex/constants";
import {
	type CodexRequestOptions,
	type InputItem,
	type RequestBody,
	transformRequestBody,
} from "./openai-codex/request-transformer";
import { parseCodexError } from "./openai-codex/response-handler";
import { normalizeOpenAIResponsesPromptCacheKey } from "./openai-responses";
import {
	appendResponsesToolResultMessages,
	convertResponsesAssistantMessage,
	convertResponsesInputContent,
	encodeResponsesToolCallId,
	encodeTextSignatureV1,
	flagTruncatedToolCalls,
	mapOpenAIResponsesStopReason,
	populateResponsesUsageFromResponse,
} from "./openai-responses-shared";
import { transformMessages } from "./transform-messages";

export interface OpenAICodexResponsesOptions extends StreamOptions {
	reasoning?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	reasoningSummary?: "auto" | "concise" | "detailed" | null;
	textVerbosity?: "low" | "medium" | "high";
	include?: string[];
	codexMode?: boolean;
	toolChoice?: ToolChoice;
	preferWebsockets?: boolean;
	serviceTier?: ServiceTier;
}

const CODEX_DEBUG = $flag("PI_CODEX_DEBUG");
const CODEX_MAX_RETRIES = 5;
const CODEX_RETRY_DELAY_MS = 500;
const CODEX_WEBSOCKET_CONNECT_TIMEOUT_MS = 10000;
const CODEX_WEBSOCKET_IDLE_TIMEOUT_MS = 300000;
const CODEX_WEBSOCKET_FIRST_EVENT_TIMEOUT_MS = 15000;
const CODEX_WEBSOCKET_RETRY_BUDGET = CODEX_MAX_RETRIES;
const CODEX_WEBSOCKET_TRANSPORT_ERROR_PREFIX = "Codex websocket transport error";
const CODEX_PREVIOUS_RESPONSE_STALE_CODES = new Set(["previous_response_not_found", "codex_previous_response_stale"]);
const CODEX_RETRYABLE_EVENT_CODES = new Set(["model_error", "server_error", "internal_error"]);
const CODEX_NON_RETRYABLE_EVENT_CODES = new Set([
	"invalid_function_parameters",
	"invalid_request_error",
	"invalid_schema",
	"invalid_tool_schema",
	// A poisoned-history rejection (`Request blocked (code=invalid_prompt)`) is a
	// deterministic content fault, not a transient upstream failure: retrying the
	// same request re-sends the same offending item and re-triggers the block, so
	// classify it as explicitly non-retryable instead of relying on omission
	// (the request-boundary sanitizer, not a provider retry, is the recovery path).
	"invalid_prompt",
]);
const CODEX_NON_RETRYABLE_EVENT_MESSAGE =
	/invalid[_ -]function[_ -]parameters|invalid schema for function|invalid[_ -]tool[_ -]schema|schema must have type ["']?object["']?|request blocked[^\n]*invalid[_ -]prompt|code=invalid[_ -]prompt/i;
const CODEX_RETRYABLE_EVENT_MESSAGE =
	/processing your request|retry your request|temporar(?:y|ily)|overloaded|service.?unavailable|internal error|server error/i;
const CODEX_PROVIDER_SESSION_STATE_KEY = "openai-codex-responses";
const X_CODEX_TURN_STATE_HEADER = "x-codex-turn-state";
const X_MODELS_ETAG_HEADER = "x-models-etag";
const X_REASONING_INCLUDED_HEADER = "x-reasoning-included";
/** Connection-level websocket failures that should immediately fall back to SSE without retrying. */
const CODEX_WEBSOCKET_FATAL_PATTERNS = ["websocket error:", "websocket closed before open", "connection timeout"];
/** Max total time to spend retrying 429s with server-provided delays (5 minutes). */
const CODEX_RATE_LIMIT_BUDGET_MS = 5 * 60 * 1000;

const CODEX_PROGRESS_EVENT_TYPES = new Set([
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
	"response.done",
	"response.incomplete",
	"response.failed",
	"error",
]);

function isCodexStreamProgressEvent(event: unknown): boolean {
	if (!event || typeof event !== "object") return false;
	const type = (event as { type?: unknown }).type;
	return typeof type === "string" && CODEX_PROGRESS_EVENT_TYPES.has(type);
}
type CodexTransport = "sse" | "websocket";
type CodexEventItem = ResponseReasoningItem | ResponseOutputMessage | ResponseFunctionToolCall | ResponseCustomToolCall;
type CodexThinkingBlock = ThinkingContent & { summaryBuffer: string; rawBuffer: string; summaryStarted: boolean };
type CodexOutputBlock = CodexThinkingBlock | TextContent | (ToolCall & { partialJson: string });
export interface OpenAICodexWebSocketDebugStats {
	fullContextRequests: number;
	deltaRequests: number;
	lastInputItems: number;
	lastDeltaInputItems?: number;
	lastPreviousResponseId?: string;
}

type CodexWebSocketSessionState = {
	disableWebsocket: boolean;
	lastRequest?: RequestBody;
	lastResponseId?: string;
	lastResponseItems?: InputItem[];
	canAppend: boolean;
	turnState?: string;
	modelsEtag?: string;
	reasoningIncluded?: boolean;
	connection?: CodexWebSocketConnection;
	lastTransport?: CodexTransport;
	fallbackCount: number;
	lastFallbackAt?: number;
	prewarmed: boolean;
	stats: OpenAICodexWebSocketDebugStats;
};

interface CodexProviderSessionState extends ProviderSessionState {
	webSocketSessions: Map<string, CodexWebSocketSessionState>;
	webSocketPublicToPrivate: Map<string, string>;
}

interface CodexRequestContext {
	apiKey: string;
	accountId: string | undefined;
	baseUrl: string;
	url: string;
	requestHeaders: Record<string, string>;
	providerSessionState?: CodexProviderSessionState;
	websocketState?: CodexWebSocketSessionState;
	transformedBody: RequestBody;
	rawRequestDump: RawHttpRequestDump;
}

async function retryCodexInitialTransportWithoutToolChoice(
	model: Model<"openai-codex-responses">,
	options: OpenAICodexResponsesOptions | undefined,
	requestSetup: CodexRequestSetup,
	requestContext: CodexRequestContext,
	stream: AssistantMessageEventStream,
	error: unknown,
): Promise<{
	eventStream: AsyncGenerator<Record<string, unknown>>;
	requestBodyForState: RequestBody;
	transport: CodexTransport;
}> {
	if (
		!isForcedToolChoiceUnsupportedError(error, isForcedCodexToolChoice(requestContext.transformedBody.tool_choice))
	) {
		throw error;
	}
	const reason = await finalizeErrorMessage(error, requestContext.rawRequestDump);
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
	const next = await openCodexSseTransportWithoutToolChoice(
		model,
		requestContext,
		requestSetup,
		options,
		requestContext.websocketState,
	);
	requestContext.rawRequestDump = { ...requestContext.rawRequestDump, body: next.requestBodyForState };
	return next;
}

interface CodexRequestSetup {
	requestSignal: AbortSignal;
	wrapCodexSseStream: (source: AsyncGenerator<Record<string, unknown>>) => AsyncGenerator<Record<string, unknown>>;
	requestAbortController: AbortController;
}

interface CodexStreamRuntime {
	eventStream: AsyncGenerator<Record<string, unknown>>;
	requestBodyForState: RequestBody;
	transport: CodexTransport;
	websocketState?: CodexWebSocketSessionState;
	currentItem: CodexEventItem | null;
	currentBlock: CodexOutputBlock | null;
	nativeOutputItems: Array<Record<string, unknown>>;
	websocketStreamRetries: number;
	providerRetryAttempt: number;
	sawTerminalEvent: boolean;
	canSafelyReplayWebsocketOverSse: boolean;
	/** Ids of tool calls that received their terminal `output_item.done`. */
	finalizedToolCallIds: Set<string>;
}

interface CodexStreamProcessingContext {
	model: Model<"openai-codex-responses">;
	output: AssistantMessage;
	stream: AssistantMessageEventStream;
	options: OpenAICodexResponsesOptions | undefined;
	requestSetup: CodexRequestSetup;
	requestContext: CodexRequestContext;
	startTime: number;
	firstTokenTime?: number;
}

interface CodexStreamCompletion {
	firstTokenTime?: number;
}

function parseCodexNonNegativeInteger(value: string | undefined, fallback: number): number {
	if (!value) return fallback;
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed < 0) return fallback;
	return Math.trunc(parsed);
}

function parseCodexPositiveInteger(value: string | undefined, fallback: number): number {
	if (!value) return fallback;
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
	return Math.trunc(parsed);
}

function isCodexWebSocketEnvEnabled(): boolean {
	return $flag("PI_CODEX_WEBSOCKET");
}

function getCodexWebSocketRetryBudget(options?: Pick<OpenAICodexResponsesOptions, "streamMaxRetries">): number {
	if (options?.streamMaxRetries !== undefined) {
		return resolveRetryBudget(options.streamMaxRetries, CODEX_WEBSOCKET_RETRY_BUDGET);
	}
	return parseCodexNonNegativeInteger($env.PI_CODEX_WEBSOCKET_RETRY_BUDGET, CODEX_WEBSOCKET_RETRY_BUDGET);
}

function getCodexWebSocketRetryDelayMs(retry: number): number {
	const baseDelay = parseCodexPositiveInteger($env.PI_CODEX_WEBSOCKET_RETRY_DELAY_MS, CODEX_RETRY_DELAY_MS);
	return baseDelay * Math.max(1, retry);
}

function getCodexWebSocketIdleTimeoutMs(overrideMs?: number): number {
	return (
		overrideMs ?? parseCodexPositiveInteger($env.PI_CODEX_WEBSOCKET_IDLE_TIMEOUT_MS, CODEX_WEBSOCKET_IDLE_TIMEOUT_MS)
	);
}

function getCodexWebSocketFirstEventTimeoutMs(idleTimeoutMs: number, overrideMs?: number): number {
	return (
		overrideMs ??
		parseCodexPositiveInteger(
			$env.PI_CODEX_WEBSOCKET_FIRST_EVENT_TIMEOUT_MS,
			Math.min(CODEX_WEBSOCKET_FIRST_EVENT_TIMEOUT_MS, idleTimeoutMs),
		)
	);
}

function createCodexProviderSessionState(): CodexProviderSessionState {
	const state: CodexProviderSessionState = {
		webSocketSessions: new Map(),
		webSocketPublicToPrivate: new Map(),
		close: () => {
			for (const session of state.webSocketSessions.values()) {
				session.connection?.close("session_disposed");
			}
			state.webSocketSessions.clear();
			state.webSocketPublicToPrivate.clear();
		},
	};
	return state;
}

function getCodexProviderSessionState(
	providerSessionState: Map<string, ProviderSessionState> | undefined,
): CodexProviderSessionState | undefined {
	if (!providerSessionState) return undefined;
	const existing = providerSessionState.get(CODEX_PROVIDER_SESSION_STATE_KEY) as CodexProviderSessionState | undefined;
	if (existing) return existing;
	const created = createCodexProviderSessionState();
	providerSessionState.set(CODEX_PROVIDER_SESSION_STATE_KEY, created);
	return created;
}

function createCodexWebSocketTransportError(message: string): Error {
	return new Error(`${CODEX_WEBSOCKET_TRANSPORT_ERROR_PREFIX}: ${message}`);
}

function isCodexWebSocketFatalError(error: Error): boolean {
	const msg = error.message.toLowerCase();
	return CODEX_WEBSOCKET_FATAL_PATTERNS.some(pattern => msg.includes(pattern.toLowerCase()));
}

function isCodexWebSocketTransportError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	return error.message.startsWith(CODEX_WEBSOCKET_TRANSPORT_ERROR_PREFIX);
}

function isCodexWebSocketRetryableStreamError(error: unknown): boolean {
	if (!(error instanceof Error) || !isCodexWebSocketTransportError(error)) return false;
	const message = error.message.toLowerCase();
	return (
		message.includes("websocket closed (") ||
		message.includes("websocket closed before response completion") ||
		message.includes("websocket connection is unavailable") ||
		message.includes("idle timeout waiting for websocket") ||
		message.includes("timeout waiting for first websocket event") ||
		message.includes("syntaxerror") ||
		message.includes("json")
	);
}

function toCodexHeaderRecord(value: unknown): Record<string, string> | null {
	if (!value || typeof value !== "object") return null;
	const headers: Record<string, string> = {};
	for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
		if (typeof entry === "string") {
			headers[key] = entry;
		} else if (Array.isArray(entry) && entry.every(item => typeof item === "string")) {
			headers[key] = entry.join(",");
		} else if (typeof entry === "number" || typeof entry === "boolean") {
			headers[key] = String(entry);
		}
	}
	return Object.keys(headers).length > 0 ? headers : null;
}

function toCodexHeaders(value: unknown): Headers | undefined {
	if (!value) return undefined;
	if (value instanceof Headers) return value;
	if (Array.isArray(value)) {
		try {
			return new Headers(value as Array<[string, string]>);
		} catch {
			return undefined;
		}
	}
	const record = toCodexHeaderRecord(value);
	if (!record) return undefined;
	return new Headers(record);
}

function updateCodexSessionMetadataFromHeaders(
	state: CodexWebSocketSessionState | undefined,
	headers: Headers | Record<string, string> | null | undefined,
): void {
	if (!state || !headers) return;
	const resolvedHeaders = headers instanceof Headers ? headers : new Headers(headers);
	const turnState = resolvedHeaders.get(X_CODEX_TURN_STATE_HEADER);
	if (turnState && turnState.length > 0) {
		state.turnState = turnState;
	}
	const modelsEtag = resolvedHeaders.get(X_MODELS_ETAG_HEADER);
	if (modelsEtag && modelsEtag.length > 0) {
		state.modelsEtag = modelsEtag;
	}
	const reasoningIncluded = resolvedHeaders.get(X_REASONING_INCLUDED_HEADER);
	if (reasoningIncluded !== null) {
		const normalized = reasoningIncluded.trim().toLowerCase();
		state.reasoningIncluded = normalized.length === 0 ? true : normalized !== "false";
	}
}

function extractCodexWebSocketHandshakeHeaders(socket: Bun.WebSocket, openEvent?: Event): Headers | undefined {
	const eventRecord = openEvent as Record<string, unknown> | undefined;
	const eventResponse = eventRecord?.response as Record<string, unknown> | undefined;
	const socketRecord = socket as unknown as Record<string, unknown>;
	const socketResponse = socketRecord.response as Record<string, unknown> | undefined;
	const socketHandshake = socketRecord.handshake as Record<string, unknown> | undefined;
	return (
		toCodexHeaders(eventRecord?.responseHeaders) ??
		toCodexHeaders(eventRecord?.headers) ??
		toCodexHeaders(eventResponse?.headers) ??
		toCodexHeaders(socketRecord.responseHeaders) ??
		toCodexHeaders(socketRecord.handshakeHeaders) ??
		toCodexHeaders(socketResponse?.headers) ??
		toCodexHeaders(socketHandshake?.headers)
	);
}

/** @internal Exported for tests. */
export function normalizeCodexToolChoice(
	choice: ToolChoice | undefined,
	tools: Tool[] = [],
	model?: Model<"openai-codex-responses">,
): string | Record<string, unknown> | undefined {
	if (!choice) return undefined;
	if (typeof choice === "string") return choice;
	const allowFreeform = model ? supportsFreeformApplyPatchCodex(model) : false;
	const mapName = (name: string): Record<string, string> => {
		const customTool = allowFreeform
			? tools.find(tool => tool.customFormat && (tool.name === name || tool.customWireName === name))
			: undefined;
		return customTool
			? { type: "custom", name: customTool.customWireName ?? customTool.name }
			: { type: "function", name };
	};
	if (choice.type === "function") {
		if ("function" in choice && choice.function?.name) {
			return mapName(choice.function.name);
		}
		if ("name" in choice && choice.name) {
			return mapName(choice.name);
		}
	}
	if (choice.type === "tool" && choice.name) {
		return mapName(choice.name);
	}
	return undefined;
}

function createEmptyUsage(): AssistantMessage["usage"] {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function getCodexUserAgent(): string {
	return `pi/${packageJson.version} (${os.platform()} ${os.release()}; ${os.arch()})`;
}

function getCodexServiceTierCostMultiplier(
	model: Pick<Model<"openai-codex-responses">, "id">,
	serviceTier: ServiceTier | "default" | undefined,
): number {
	switch (serviceTier) {
		case "flex":
			return 0.5;
		case "priority":
			return model.id === "gpt-5.5" ? 2.5 : 2;
		default:
			return 1;
	}
}

function resolveCodexCostServiceTier(res: unknown, req?: unknown): ServiceTier | "default" | undefined {
	switch (res) {
		case "flex":
			return "flex";
		case "priority":
			return "priority";
		default:
			if (req === "flex" || req === "priority") {
				return req;
			}
			return "default";
	}
}

function applyCodexServiceTierPricing(
	model: Pick<Model<"openai-codex-responses">, "id">,
	usage: AssistantMessage["usage"],
	resTier: unknown,
	reqTier: unknown,
): void {
	const resolvedTier = resolveCodexCostServiceTier(resTier, reqTier);
	const multiplier = getCodexServiceTierCostMultiplier(model, resolvedTier);
	if (multiplier === 1) return;
	usage.cost.input *= multiplier;
	usage.cost.output *= multiplier;
	usage.cost.cacheRead *= multiplier;
	usage.cost.cacheWrite *= multiplier;
	usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
}

function createAssistantOutput(model: Model<"openai-codex-responses">): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "openai-codex-responses" as Api,
		provider: model.provider,
		model: model.id,
		usage: createEmptyUsage(),
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function resetOutputState(output: AssistantMessage): void {
	output.content.length = 0;
	output.usage = createEmptyUsage();
	output.stopReason = "stop";
}

function removeTransientBlockIndices(output: AssistantMessage): void {
	for (const block of output.content) {
		delete (block as { index?: number }).index;
	}
}

function createRequestSetup(options: OpenAICodexResponsesOptions | undefined): CodexRequestSetup {
	const requestAbortController = new AbortController();
	const requestSignal = options?.signal
		? AbortSignal.any([options.signal, requestAbortController.signal])
		: requestAbortController.signal;
	const wrapCodexSseStream = (
		source: AsyncGenerator<Record<string, unknown>>,
	): AsyncGenerator<Record<string, unknown>> =>
		iterateWithIdleTimeout(source, {
			idleTimeoutMs: options?.streamIdleTimeoutMs ?? getOpenAIStreamIdleTimeoutMs(),
			errorMessage: "OpenAI Codex SSE stream stalled while waiting for the next event",
			onIdle: () => requestAbortController.abort(),
			abortSignal: options?.signal,
			isProgressItem: isCodexStreamProgressEvent,
		});
	return { requestAbortController, requestSignal, wrapCodexSseStream };
}

async function buildCodexRequestContext(
	model: Model<"openai-codex-responses">,
	context: Context,
	options: OpenAICodexResponsesOptions | undefined,
	output: AssistantMessage,
): Promise<CodexRequestContext> {
	const apiKey = options?.apiKey || getEnvApiKey(model.provider) || "";
	if (!apiKey) {
		throw new Error(`No API key for provider: ${model.provider}`);
	}

	const accountId = getAccountId(apiKey);
	const baseUrl = model.baseUrl || CODEX_BASE_URL;
	const url = resolveCodexResponsesUrl(baseUrl);
	const promptCacheKey = normalizeOpenAIResponsesPromptCacheKey(options?.sessionId);
	const transformedBody = await buildTransformedCodexRequestBody(model, context, options);
	options?.onPayload?.(transformedBody);

	const requestHeaders = { ...(model.headers ?? {}), ...(options?.headers ?? {}) };
	const rawRequestDump: RawHttpRequestDump = {
		provider: model.provider,
		api: output.api,
		model: model.id,
		method: "POST",
		url,
		body: transformedBody,
	};

	const providerSessionState = getCodexProviderSessionState(options?.providerSessionState);
	const sessionKey = getCodexWebSocketSessionKey(promptCacheKey, model, accountId, baseUrl);
	const publicSessionKey = getCodexPublicSessionKey(promptCacheKey, model, baseUrl);
	if (sessionKey && publicSessionKey) {
		providerSessionState?.webSocketPublicToPrivate.set(publicSessionKey, sessionKey);
	}
	const websocketState =
		sessionKey && providerSessionState ? getCodexWebSocketSessionState(sessionKey, providerSessionState) : undefined;

	return {
		apiKey,
		accountId,
		baseUrl,
		url,
		requestHeaders,
		providerSessionState,
		websocketState,
		transformedBody,
		rawRequestDump,
	};
}

async function buildTransformedCodexRequestBody(
	model: Model<"openai-codex-responses">,
	context: Context,
	options: OpenAICodexResponsesOptions | undefined,
): Promise<RequestBody> {
	const params: RequestBody = {
		model: model.id,
		input: neutralizeResponsesInputControlTokens(convertMessages(model, context)),
		stream: true,
		prompt_cache_key: normalizeOpenAIResponsesPromptCacheKey(options?.sessionId),
	};

	if (options?.maxTokens) {
		params.max_output_tokens = options.maxTokens;
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
	const resolvedServiceTier = resolveServiceTier(options?.serviceTier, model.provider);
	if (resolvedServiceTier === "flex" || resolvedServiceTier === "scale" || resolvedServiceTier === "priority") {
		params.service_tier = resolvedServiceTier;
	}
	if (context.tools && context.tools.length > 0) {
		params.tools = convertOpenAICodexResponsesTools(context.tools, model);
		if (options?.toolChoice) {
			const resolvedToolChoice = resolveToolChoice(model, options.toolChoice);
			if (resolvedToolChoice.degraded && resolvedToolChoice.supportSource === "runtime") {
				logCodexDebug("codex degraded tool_choice after runtime capability discovery", {
					model: model.id,
					requestedLevel: resolvedToolChoice.requestedLevel,
					resolvedLevel: resolvedToolChoice.resolvedLevel,
					reason: resolvedToolChoice.reason,
				});
			}
			const toolChoice = normalizeCodexToolChoice(resolvedToolChoice.resolvedChoice, context.tools, model);
			if (toolChoice) {
				params.tool_choice = toolChoice;
			}
		}
		// When a custom-tool is active, force serial tool-calling. OpenAI's
		// `parallel_tool_calls` is request-scoped — disabling it here affects
		// every tool in the turn, not just the custom one. That's coarser
		// than spec §1's "supports_parallel_tool_calls = false" (which
		// strictly targets `apply_patch`), but the platform API offers no
		// per-tool flag.
		const emittedTools = params.tools as CodexToolPayload[];
		if (emittedTools.some(t => t.type === "custom")) {
			params.parallel_tool_calls = false;
		}
	}

	const systemPrompts = normalizeSystemPrompts(context.systemPrompt);
	if (systemPrompts.length > 0) {
		params.instructions = systemPrompts[0];
	}
	const developerMessages = systemPrompts.slice(1);
	const codexOptions: CodexRequestOptions = {
		reasoningEffort: options?.reasoning,
		reasoningSummary: options?.reasoningSummary ?? "auto",
		textVerbosity: options?.textVerbosity,
		include: options?.include,
	};

	return transformRequestBody(params, model, codexOptions, { developerMessages });
}

async function openInitialCodexEventStream(
	model: Model<"openai-codex-responses">,
	options: OpenAICodexResponsesOptions | undefined,
	requestSetup: CodexRequestSetup,
	requestContext: CodexRequestContext,
): Promise<{
	eventStream: AsyncGenerator<Record<string, unknown>>;
	requestBodyForState: RequestBody;
	transport: CodexTransport;
}> {
	const { transformedBody, websocketState } = requestContext;
	if (websocketState && shouldUseCodexWebSocket(model, websocketState, options?.preferWebsockets)) {
		const websocketRetryBudget = getCodexWebSocketRetryBudget(options);
		let websocketRetries = 0;
		while (true) {
			try {
				return await openCodexWebSocketTransport(
					requestContext,
					requestSetup,
					options,
					websocketState,
					websocketRetries,
				);
			} catch (error) {
				const websocketError = error instanceof Error ? error : new Error(String(error));
				const isFatal = isCodexWebSocketFatalError(websocketError);
				const activateFallback = isFatal || websocketRetries >= websocketRetryBudget;
				recordCodexWebSocketFailure(websocketState, activateFallback);
				logCodexDebug("codex websocket fallback", {
					error: websocketError.message,
					retry: websocketRetries,
					retryBudget: websocketRetryBudget,
					activated: activateFallback,
					fatal: isFatal,
				});
				if (!activateFallback) {
					websocketRetries += 1;
					await scheduler.wait(getCodexWebSocketRetryDelayMs(websocketRetries), {
						signal: requestSetup.requestSignal,
					});
					continue;
				}
				break;
			}
		}
	}
	return openCodexSseTransport(model, requestContext, requestSetup, options, websocketState, transformedBody);
}
async function openCodexWebSocketTransport(
	requestContext: CodexRequestContext,
	requestSetup: CodexRequestSetup,
	options: OpenAICodexResponsesOptions | undefined,
	websocketState: CodexWebSocketSessionState,
	retry: number,
): Promise<{
	eventStream: AsyncGenerator<Record<string, unknown>>;
	requestBodyForState: RequestBody;
	transport: CodexTransport;
}> {
	const websocketRequest = buildCodexWebSocketRequest(requestContext.transformedBody, websocketState);
	const websocketHeaders = createCodexHeaders(
		requestContext.requestHeaders,
		requestContext.accountId,
		requestContext.apiKey,
		requestContext.transformedBody.prompt_cache_key,
		"websocket",
		websocketState,
	);
	const requestBodyForState = structuredCloneJSON(requestContext.transformedBody);
	logCodexDebug("codex websocket request", {
		url: toWebSocketUrl(requestContext.url),
		model: requestContext.transformedBody.model,
		reasoningEffort: requestContext.transformedBody.reasoning?.effort ?? null,
		headers: redactHeaders(websocketHeaders),
		sentTurnStateHeader: websocketHeaders.has(X_CODEX_TURN_STATE_HEADER),
		sentModelsEtagHeader: websocketHeaders.has(X_MODELS_ETAG_HEADER),
		requestType: websocketRequest.type,
		retry,
		retryBudget: getCodexWebSocketRetryBudget(options),
	});
	const eventStream = await openCodexWebSocketEventStream(
		toWebSocketUrl(requestContext.url),
		websocketHeaders,
		websocketRequest,
		websocketState,
		requestSetup.requestSignal,
		options,
	);
	return { eventStream, requestBodyForState, transport: "websocket" };
}

async function openCodexSseTransport(
	model: Model<"openai-codex-responses">,
	requestContext: CodexRequestContext,
	requestSetup: CodexRequestSetup,
	options: OpenAICodexResponsesOptions | undefined,
	state: CodexWebSocketSessionState | undefined,
	body = requestContext.transformedBody,
): Promise<{
	eventStream: AsyncGenerator<Record<string, unknown>>;
	requestBodyForState: RequestBody;
	transport: CodexTransport;
}> {
	const eventStream = requestSetup.wrapCodexSseStream(
		await openCodexSseEventStream(
			requestContext.url,
			requestContext.requestHeaders,
			requestContext.accountId,
			requestContext.apiKey,
			body.prompt_cache_key,
			body,
			state,
			requestSetup.requestSignal,
			event => options?.onSseEvent?.(event, model),
			options?.fetch,
			options,
		),
	);
	return { eventStream, requestBodyForState: structuredCloneJSON(body), transport: "sse" };
}

async function openCodexSseTransportWithoutToolChoice(
	model: Model<"openai-codex-responses">,
	requestContext: CodexRequestContext,
	requestSetup: CodexRequestSetup,
	options: OpenAICodexResponsesOptions | undefined,
	state: CodexWebSocketSessionState | undefined,
): Promise<{
	eventStream: AsyncGenerator<Record<string, unknown>>;
	requestBodyForState: RequestBody;
	transport: CodexTransport;
}> {
	const body = structuredCloneJSON(requestContext.transformedBody);
	delete body.tool_choice;
	return openCodexSseTransport(model, requestContext, requestSetup, options, state, body);
}

async function reopenCodexWebSocketRuntimeStream(
	context: CodexStreamProcessingContext,
	runtime: CodexStreamRuntime,
	state: CodexWebSocketSessionState,
): Promise<void> {
	try {
		const next = await openCodexWebSocketTransport(
			context.requestContext,
			context.requestSetup,
			context.options,
			state,
			runtime.websocketStreamRetries,
		);
		runtime.eventStream = next.eventStream;
		runtime.requestBodyForState = next.requestBodyForState;
		runtime.transport = next.transport;
		state.lastTransport = next.transport;
	} catch (error) {
		const wsError = error instanceof Error ? error : new Error(String(error));
		if (!isCodexWebSocketTransportError(wsError)) throw error;
		// Reopen failed at the websocket layer (handshake refused, connect timeout, etc.).
		// Activate fallback so subsequent turns use SSE, and replay this turn over SSE
		// instead of surfacing a raw transport error to the caller.
		recordCodexWebSocketFailure(state, true);
		logCodexDebug("codex websocket reopen failed, falling back to SSE", {
			error: wsError.message,
			retry: runtime.websocketStreamRetries,
		});
		await reopenCodexSseRuntimeStream(context, runtime, state);
	}
}

async function reopenCodexSseRuntimeStream(
	context: CodexStreamProcessingContext,
	runtime: CodexStreamRuntime,
	state: CodexWebSocketSessionState | undefined,
): Promise<void> {
	const next = await openCodexSseTransport(
		context.model,
		context.requestContext,
		context.requestSetup,
		context.options,
		state,
	);
	runtime.eventStream = next.eventStream;
	runtime.requestBodyForState = next.requestBodyForState;
	runtime.transport = next.transport;
	if (state) {
		state.lastTransport = next.transport;
	}
}

function createCodexStreamRuntime(initial: {
	eventStream: AsyncGenerator<Record<string, unknown>>;
	requestBodyForState: RequestBody;
	transport: CodexTransport;
	websocketState?: CodexWebSocketSessionState;
}): CodexStreamRuntime {
	return {
		eventStream: initial.eventStream,
		requestBodyForState: initial.requestBodyForState,
		transport: initial.transport,
		websocketState: initial.websocketState,
		currentItem: null,
		currentBlock: null,
		nativeOutputItems: [],
		websocketStreamRetries: 0,
		providerRetryAttempt: 0,
		sawTerminalEvent: false,
		canSafelyReplayWebsocketOverSse: true,
		finalizedToolCallIds: new Set<string>(),
	};
}

async function processCodexResponseStream(
	context: CodexStreamProcessingContext,
	runtime: CodexStreamRuntime,
): Promise<CodexStreamCompletion> {
	const { output, stream } = context;
	stream.push({ type: "start", partial: output });

	while (true) {
		try {
			let firstTokenTime = context.firstTokenTime;
			for await (const rawEvent of runtime.eventStream) {
				firstTokenTime = handleCodexStreamEvent({
					...context,
					runtime,
					rawEvent,
					firstTokenTime,
				});
				if (runtime.sawTerminalEvent) break;
			}
			return { firstTokenTime };
		} catch (error) {
			const recovered = await recoverCodexStreamError(context, runtime, error);
			if (!recovered) {
				throw error;
			}
		}
	}
}

function handleCodexStreamEvent(args: {
	model: Model<"openai-codex-responses">;
	output: AssistantMessage;
	stream: AssistantMessageEventStream;
	runtime: CodexStreamRuntime;
	rawEvent: Record<string, unknown>;
	firstTokenTime?: number;
}): number | undefined {
	const { model, output, stream, runtime, rawEvent } = args;
	const eventType = typeof rawEvent.type === "string" ? rawEvent.type : "";
	if (!eventType) return args.firstTokenTime;

	const blocks = output.content;
	const blockIndex = () => blocks.length - 1;
	let firstTokenTime = args.firstTokenTime;

	if (eventType === "response.output_item.added") {
		if (!firstTokenTime) firstTokenTime = Date.now();
		const item = rawEvent.item as CodexEventItem;
		runtime.currentItem = item;
		runtime.currentBlock = createOutputBlockForItem(item);
		if (!runtime.currentBlock) return firstTokenTime;
		output.content.push(runtime.currentBlock);
		stream.push({
			type: getOutputBlockStartEventType(runtime.currentBlock),
			contentIndex: blockIndex(),
			partial: output,
		});
		return firstTokenTime;
	}

	if (eventType === "response.reasoning_summary_part.added") {
		handleReasoningSummaryPartAdded(runtime.currentItem, rawEvent);
		return firstTokenTime;
	}

	if (eventType === "response.reasoning_summary_text.delta") {
		handleReasoningSummaryTextDelta(runtime.currentItem, runtime.currentBlock, rawEvent, stream, output, blockIndex);
		return firstTokenTime;
	}

	if (eventType === "response.reasoning_summary_part.done") {
		handleReasoningSummaryPartDone(runtime.currentItem, runtime.currentBlock, stream, output, blockIndex);
		return firstTokenTime;
	}

	if (eventType === "response.reasoning_text.delta") {
		handleReasoningTextDelta(runtime.currentItem, runtime.currentBlock, rawEvent, stream, output, blockIndex);
		return firstTokenTime;
	}

	if (eventType === "response.content_part.added") {
		handleContentPartAdded(runtime.currentItem, rawEvent);
		return firstTokenTime;
	}

	if (eventType === "response.output_text.delta") {
		handleMessageTextDelta(
			runtime.currentItem,
			runtime.currentBlock,
			rawEvent,
			stream,
			output,
			blockIndex,
			"output_text",
		);
		return firstTokenTime;
	}

	if (eventType === "response.refusal.delta") {
		handleMessageTextDelta(
			runtime.currentItem,
			runtime.currentBlock,
			rawEvent,
			stream,
			output,
			blockIndex,
			"refusal",
		);
		return firstTokenTime;
	}

	if (eventType === "response.function_call_arguments.delta") {
		handleToolCallArgumentsDelta(runtime.currentItem, runtime.currentBlock, rawEvent, stream, output, blockIndex);
		return firstTokenTime;
	}

	if (eventType === "response.function_call_arguments.done") {
		handleToolCallArgumentsDone(runtime.currentItem, runtime.currentBlock, rawEvent);
		return firstTokenTime;
	}

	if (eventType === "response.custom_tool_call_input.delta") {
		handleCustomToolCallInputDelta(runtime.currentItem, runtime.currentBlock, rawEvent, stream, output, blockIndex);
		return firstTokenTime;
	}

	if (eventType === "response.custom_tool_call_input.done") {
		handleCustomToolCallInputDone(runtime.currentItem, runtime.currentBlock, rawEvent);
		return firstTokenTime;
	}

	if (eventType === "response.output_item.done") {
		handleOutputItemDone(model, output, stream, runtime, rawEvent, blockIndex);
		return firstTokenTime;
	}

	if (eventType === "response.created") {
		return handleResponseCreated(runtime, rawEvent);
	}

	if (eventType === "response.completed" || eventType === "response.done" || eventType === "response.incomplete") {
		handleResponseCompleted(model, output, runtime, rawEvent);
		return firstTokenTime;
	}

	if (eventType === "error" || eventType === "response.failed") {
		throw createCodexProviderStreamError(rawEvent);
	}

	return firstTokenTime;
}

function createOutputBlockForItem(item: CodexEventItem): CodexOutputBlock | null {
	if (item.type === "reasoning") {
		return { type: "thinking", thinking: "", summaryBuffer: "", rawBuffer: "", summaryStarted: false };
	}
	if (item.type === "message") {
		return { type: "text", text: "" };
	}
	if (item.type === "function_call") {
		return {
			type: "toolCall",
			id: encodeResponsesToolCallId(item.call_id, item.id),
			name: item.name,
			arguments: {},
			partialJson: item.arguments || "",
		};
	}
	if (item.type === "custom_tool_call") {
		// Wire name flows through unchanged; the agent-loop dispatcher also
		// matches `Tool.customWireName`. Reuse `partialJson` as the
		// accumulation buffer for the raw input string.
		return {
			type: "toolCall",
			id: encodeResponsesToolCallId(item.call_id, item.id),
			name: item.name,
			arguments: { input: item.input ?? "" },
			customWireName: item.name,
			partialJson: item.input ?? "",
		};
	}
	return null;
}

function getOutputBlockStartEventType(block: CodexOutputBlock): "thinking_start" | "text_start" | "toolcall_start" {
	if (block.type === "thinking") return "thinking_start";
	if (block.type === "text") return "text_start";
	return "toolcall_start";
}

function handleReasoningSummaryPartAdded(currentItem: CodexEventItem | null, rawEvent: Record<string, unknown>): void {
	if (currentItem?.type !== "reasoning") return;
	currentItem.summary = currentItem.summary || [];
	currentItem.summary.push((rawEvent as { part: ResponseReasoningItem["summary"][number] }).part);
}

function handleReasoningSummaryTextDelta(
	currentItem: CodexEventItem | null,
	currentBlock: CodexOutputBlock | null,
	rawEvent: Record<string, unknown>,
	stream: AssistantMessageEventStream,
	output: AssistantMessage,
	blockIndex: () => number,
): void {
	if (currentItem?.type !== "reasoning" || currentBlock?.type !== "thinking") return;
	if (!currentBlock.summaryStarted) {
		currentBlock.summaryStarted = true;
		stream.push({ type: "reasoning_summary_start", contentIndex: blockIndex(), partial: output });
	}
	currentItem.summary = currentItem.summary || [];
	const lastPart = currentItem.summary[currentItem.summary.length - 1];
	if (!lastPart) return;
	const delta = (rawEvent as { delta?: string }).delta || "";
	currentBlock.thinking += delta;
	currentBlock.summaryBuffer += delta;
	lastPart.text += delta;
	stream.push({ type: "reasoning_summary_delta", contentIndex: blockIndex(), delta, partial: output });
}

function handleReasoningSummaryPartDone(
	currentItem: CodexEventItem | null,
	currentBlock: CodexOutputBlock | null,
	stream: AssistantMessageEventStream,
	output: AssistantMessage,
	blockIndex: () => number,
): void {
	if (currentItem?.type !== "reasoning" || currentBlock?.type !== "thinking") return;
	currentItem.summary = currentItem.summary || [];
	const lastPart = currentItem.summary[currentItem.summary.length - 1];
	if (!lastPart) return;
	currentBlock.thinking += "\n\n";
	currentBlock.summaryBuffer += "\n\n";
	lastPart.text += "\n\n";
	stream.push({ type: "reasoning_summary_delta", contentIndex: blockIndex(), delta: "\n\n", partial: output });
}

function handleReasoningTextDelta(
	currentItem: CodexEventItem | null,
	currentBlock: CodexOutputBlock | null,
	rawEvent: Record<string, unknown>,
	stream: AssistantMessageEventStream,
	output: AssistantMessage,
	blockIndex: () => number,
): void {
	if (currentItem?.type !== "reasoning" || currentBlock?.type !== "thinking") return;
	const delta = (rawEvent as { delta?: string }).delta || "";
	currentBlock.thinking += delta;
	currentBlock.rawBuffer += delta;
	stream.push({ type: "thinking_delta", contentIndex: blockIndex(), delta, partial: output });
}

function handleContentPartAdded(currentItem: CodexEventItem | null, rawEvent: Record<string, unknown>): void {
	if (currentItem?.type !== "message") return;
	currentItem.content = currentItem.content || [];
	const part = (rawEvent as { part?: ResponseOutputMessage["content"][number] }).part;
	if (part && (part.type === "output_text" || part.type === "refusal")) {
		currentItem.content.push(part);
	}
}

function handleMessageTextDelta(
	currentItem: CodexEventItem | null,
	currentBlock: CodexOutputBlock | null,
	rawEvent: Record<string, unknown>,
	stream: AssistantMessageEventStream,
	output: AssistantMessage,
	blockIndex: () => number,
	partType: "output_text" | "refusal",
): void {
	if (currentItem?.type !== "message" || currentBlock?.type !== "text") return;
	if (!currentItem.content || currentItem.content.length === 0) return;
	const lastPart = currentItem.content[currentItem.content.length - 1];
	if (!lastPart || lastPart.type !== partType) return;
	const delta = (rawEvent as { delta?: string }).delta || "";
	currentBlock.text += delta;
	if (lastPart.type === "output_text") {
		lastPart.text += delta;
	} else {
		lastPart.refusal += delta;
	}
	stream.push({ type: "text_delta", contentIndex: blockIndex(), delta, partial: output });
}

function handleToolCallArgumentsDelta(
	currentItem: CodexEventItem | null,
	currentBlock: CodexOutputBlock | null,
	rawEvent: Record<string, unknown>,
	stream: AssistantMessageEventStream,
	output: AssistantMessage,
	blockIndex: () => number,
): void {
	if (currentItem?.type !== "function_call" || currentBlock?.type !== "toolCall") return;
	const delta = (rawEvent as { delta?: string }).delta || "";
	currentBlock.partialJson += delta;
	currentBlock.arguments = parseStreamingJson(currentBlock.partialJson);
	stream.push({ type: "toolcall_delta", contentIndex: blockIndex(), delta, partial: output });
}

function handleToolCallArgumentsDone(
	currentItem: CodexEventItem | null,
	currentBlock: CodexOutputBlock | null,
	rawEvent: Record<string, unknown>,
): void {
	if (currentItem?.type !== "function_call" || currentBlock?.type !== "toolCall") return;
	const args = (rawEvent as { arguments?: string }).arguments;
	if (typeof args === "string") {
		currentBlock.partialJson = args;
		currentBlock.arguments = parseStreamingJson(currentBlock.partialJson);
	}
}

function handleCustomToolCallInputDelta(
	currentItem: CodexEventItem | null,
	currentBlock: CodexOutputBlock | null,
	rawEvent: Record<string, unknown>,
	stream: AssistantMessageEventStream,
	output: AssistantMessage,
	blockIndex: () => number,
): void {
	if (currentItem?.type !== "custom_tool_call" || currentBlock?.type !== "toolCall") return;
	const delta = (rawEvent as { delta?: string }).delta || "";
	currentBlock.partialJson += delta;
	currentBlock.arguments = { input: currentBlock.partialJson };
	stream.push({ type: "toolcall_delta", contentIndex: blockIndex(), delta, partial: output });
}

function handleCustomToolCallInputDone(
	currentItem: CodexEventItem | null,
	currentBlock: CodexOutputBlock | null,
	rawEvent: Record<string, unknown>,
): void {
	if (currentItem?.type !== "custom_tool_call" || currentBlock?.type !== "toolCall") return;
	const input = (rawEvent as { input?: string }).input;
	if (typeof input === "string") {
		currentBlock.partialJson = input;
		currentBlock.arguments = { input };
	}
}

function handleOutputItemDone(
	model: Model<"openai-codex-responses">,
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	runtime: CodexStreamRuntime,
	rawEvent: Record<string, unknown>,
	blockIndex: () => number,
): void {
	const item = structuredCloneJSON(rawEvent.item) as CodexEventItem;
	runtime.nativeOutputItems.push(item as unknown as Record<string, unknown>);

	if (item.type === "reasoning" && runtime.currentBlock?.type === "thinking") {
		const block = runtime.currentBlock;
		// Prefer the streamed summary buffer only when it carries real text; a
		// part.done before/without any summary_text delta leaves only separators, so
		// fall back to the canonical item.summary from output_item.done (matches the
		// shared Responses decoder).
		const bufferSummary = block.summaryBuffer ?? "";
		const itemSummary = item.summary?.map(summary => summary.text).join("\n\n") ?? "";
		const summaryText = bufferSummary.trim() ? bufferSummary : itemSummary;
		const rawText = block.rawBuffer;
		const mutable = block as { provenance?: "summary" | "raw" | "mixed"; summaryText?: string; rawText?: string };
		if (mutable.provenance === undefined) {
			if (mutable.summaryText === undefined && summaryText) mutable.summaryText = summaryText;
			if (mutable.rawText === undefined && rawText) mutable.rawText = rawText;
			mutable.provenance = summaryText && rawText ? "mixed" : summaryText ? "summary" : rawText ? "raw" : undefined;
		}
		// Finalized display string must exclude raw CoT when a summary exists (parity
		// with openai-responses-shared). Derive from STORED write-once provenance fields
		// so a later/duplicate raw-only finalization cannot overwrite a summary/mixed
		// block's safe display with raw CoT; raw-only stays raw.
		{
			const effSummary = mutable.summaryText ?? summaryText;
			const effRaw = mutable.rawText ?? rawText;
			block.thinking = mutable.provenance === "raw" ? effRaw : effSummary || effRaw;
		}
		block.thinkingSignature = JSON.stringify(item);
		delete (block as { summaryBuffer?: string }).summaryBuffer;
		delete (block as { rawBuffer?: string }).rawBuffer;
		const wasSummaryStarted = block.summaryStarted;
		delete (block as { summaryStarted?: boolean }).summaryStarted;
		if (summaryText) {
			// Emit a summary start first when none was streamed (part.added/done or
			// canonical done-item summary with no summary_text delta), so consumers that
			// open a summary on start don't receive an orphaned reasoning_summary_end.
			if (!wasSummaryStarted) {
				stream.push({ type: "reasoning_summary_start", contentIndex: blockIndex(), partial: output });
			}
			stream.push({
				type: "reasoning_summary_end",
				contentIndex: blockIndex(),
				content: summaryText,
				partial: output,
			});
		}
		stream.push({ type: "thinking_end", contentIndex: blockIndex(), content: block.thinking, partial: output });
		runtime.currentBlock = null;
		return;
	}

	if (item.type === "message" && runtime.currentBlock?.type === "text") {
		runtime.currentBlock.text = item.content
			.map(content => (content.type === "output_text" ? content.text : content.refusal))
			.join("");
		const phase = item.phase === "commentary" || item.phase === "final_answer" ? item.phase : undefined;
		runtime.currentBlock.textSignature = encodeTextSignatureV1(item.id, phase);
		stream.push({
			type: "text_end",
			contentIndex: blockIndex(),
			content: runtime.currentBlock.text,
			partial: output,
		});
		runtime.currentBlock = null;
		return;
	}

	if (item.type === "function_call") {
		const id = encodeResponsesToolCallId(item.call_id, item.id);
		runtime.finalizedToolCallIds.add(id);
		const toolCall: ToolCall = {
			type: "toolCall",
			id,
			name: item.name,
			arguments: parseStreamingJson(item.arguments || "{}"),
		};
		runtime.canSafelyReplayWebsocketOverSse = false;
		stream.push({ type: "toolcall_end", contentIndex: blockIndex(), toolCall, partial: output });
		return;
	}

	if (item.type === "custom_tool_call") {
		const id = encodeResponsesToolCallId(item.call_id, item.id);
		runtime.finalizedToolCallIds.add(id);
		const rawInput =
			runtime.currentBlock?.type === "toolCall" && runtime.currentBlock.partialJson
				? runtime.currentBlock.partialJson
				: (item.input ?? "");
		const toolCall: ToolCall = {
			type: "toolCall",
			id,
			name: item.name,
			arguments: { input: rawInput },
			customWireName: item.name,
		};
		runtime.canSafelyReplayWebsocketOverSse = false;
		stream.push({ type: "toolcall_end", contentIndex: blockIndex(), toolCall, partial: output });
		return;
	}

	void model;
}

function handleResponseCreated(runtime: CodexStreamRuntime, rawEvent: Record<string, unknown>): number | undefined {
	const response = (rawEvent as { response?: { id?: string } }).response;
	const state = runtime.websocketState;
	if (runtime.transport === "websocket" && state && typeof response?.id === "string" && response.id.length > 0) {
		state.lastResponseId = response.id;
	}
	return undefined;
}

function handleResponseCompleted(
	model: Model<"openai-codex-responses">,
	output: AssistantMessage,
	runtime: CodexStreamRuntime,
	rawEvent: Record<string, unknown>,
): void {
	runtime.sawTerminalEvent = true;
	const response = (
		rawEvent as {
			response?: {
				id?: string;
				usage?: {
					input_tokens?: number;
					output_tokens?: number;
					total_tokens?: number;
					input_tokens_details?: { cached_tokens?: number };
					output_tokens_details?: { reasoning_tokens?: number };
				};
				status?: string;
				service_tier?: ServiceTier | "default";
			};
		}
	).response;

	populateResponsesUsageFromResponse(output, response?.usage);
	if (typeof response?.id === "string" && response.id.length > 0) {
		output.responseId = response.id;
	}

	const state = runtime.websocketState;
	if (runtime.transport === "websocket" && state) {
		state.lastRequest = structuredCloneJSON(runtime.requestBodyForState);
		if (typeof response?.id === "string" && response.id.length > 0) {
			state.lastResponseId = response.id;
			state.lastResponseItems = stripInputItemIds(structuredCloneJSON(runtime.nativeOutputItems));
		}
		state.canAppend = rawEvent.type === "response.done" || rawEvent.type === "response.completed";
	}

	calculateCost(model, output.usage);
	applyCodexServiceTierPricing(model, output.usage, response?.service_tier, runtime.requestBodyForState.service_tier);
	output.stopReason = mapOpenAIResponsesStopReason(response?.status as OpenAI.Responses.ResponseStatus | undefined);
	// A response cut short for length may have stopped mid-tool-call. Flag any
	// call that never received its `output_item.done` so the agent loop rejects
	// the truncated arguments instead of executing a best-effort partial parse.
	flagTruncatedToolCalls(output, output.stopReason, block => runtime.finalizedToolCallIds.has(block.id));
	if (output.content.some(block => block.type === "toolCall") && output.stopReason === "stop") {
		output.stopReason = "toolUse";
	}
}

async function recoverCodexStreamError(
	context: CodexStreamProcessingContext,
	runtime: CodexStreamRuntime,
	error: unknown,
): Promise<boolean> {
	if (context.options?.fallbackManaged) return false;
	if (await tryRetryWithoutForcedToolChoice(context, runtime, error)) {
		return true;
	}
	if (await tryReconnectCodexWebSocketOnConnectionLimit(context, runtime, error)) {
		return true;
	}
	if (await tryRecoverCodexPreviousResponseNotFound(context, runtime, error)) {
		return true;
	}
	if (await tryReplayWebsocketFailureOverSse(context, runtime, error)) {
		return true;
	}
	if (await tryRetryCodexProviderError(context, runtime, error)) {
		return true;
	}
	return false;
}

async function tryRetryWithoutForcedToolChoice(
	context: CodexStreamProcessingContext,
	runtime: CodexStreamRuntime,
	error: unknown,
): Promise<boolean> {
	if (
		context.options?.fallbackManaged ||
		runtime.providerRetryAttempt > 0 ||
		context.output.content.length > 0 ||
		context.firstTokenTime !== undefined ||
		context.options?.signal?.aborted ||
		!isForcedToolChoiceUnsupportedError(error, isForcedCodexToolChoice(runtime.requestBodyForState.tool_choice))
	) {
		return false;
	}

	const reason = await finalizeErrorMessage(error, context.requestContext.rawRequestDump);
	markToolChoiceIncapability(context.model, "auto", reason);
	const resolvedToolChoice = resolveToolChoice(context.model, context.options?.toolChoice);
	context.stream.push({
		type: "toolChoiceIncapability",
		api: context.model.api,
		provider: context.model.provider,
		model: context.model.id,
		requestedLevel: resolvedToolChoice.requestedLevel,
		resolvedLevel: "auto",
		reason,
		registryKey: resolvedToolChoice.registryKey,
	});

	runtime.providerRetryAttempt += 1;
	runtime.currentItem = null;
	runtime.currentBlock = null;
	runtime.sawTerminalEvent = false;
	runtime.nativeOutputItems.length = 0;
	resetOutputState(context.output);
	context.firstTokenTime = undefined;

	const websocketState = context.requestContext.websocketState;
	if (websocketState) {
		resetCodexWebSocketAppendState(websocketState);
		resetCodexSessionMetadata(websocketState);
	}
	const next = await openCodexSseTransportWithoutToolChoice(
		context.model,
		context.requestContext,
		context.requestSetup,
		context.options,
		websocketState,
	);
	runtime.eventStream = next.eventStream;
	runtime.requestBodyForState = next.requestBodyForState;
	runtime.transport = next.transport;
	if (websocketState) {
		websocketState.lastTransport = next.transport;
	}
	context.requestContext.rawRequestDump = { ...context.requestContext.rawRequestDump, body: next.requestBodyForState };
	return true;
}

function isForcedCodexToolChoice(choice: RequestBody["tool_choice"]): boolean {
	return !!choice && choice !== "none" && choice !== "auto";
}

/**
 * Handles `websocket_connection_limit_reached` errors by closing the stale connection
 * and opening a fresh websocket. If content has already been emitted to the caller,
 * falls back to SSE replay (same as other WS failures) since we cannot safely
 * continue a partial response on a new connection.
 */
async function tryReconnectCodexWebSocketOnConnectionLimit(
	context: CodexStreamProcessingContext,
	runtime: CodexStreamRuntime,
	error: unknown,
): Promise<boolean> {
	if (!(error instanceof CodexProviderStreamError) || error.code !== "websocket_connection_limit_reached") {
		return false;
	}
	const websocketState = context.requestContext.websocketState;
	if (
		!websocketState ||
		runtime.transport !== "websocket" ||
		context.options?.signal?.aborted ||
		context.options?.fallbackManaged
	) {
		return false;
	}

	// Close the stale connection so getOrCreateOpenAI code backendWebSocketConnection creates a fresh one.
	websocketState.connection?.close("connection_limit");
	websocketState.connection = undefined;
	resetCodexWebSocketAppendState(websocketState);

	logCodexDebug("codex websocket connection limit reached, reconnecting", {
		hadContent: context.output.content.length > 0,
		retry: runtime.websocketStreamRetries,
	});

	if (context.output.content.length > 0) {
		// Content already emitted to the caller — cannot safely continue on a new WS.
		// Reset and replay the full request over SSE.
		runtime.canSafelyReplayWebsocketOverSse = true;
		runtime.currentItem = null;
		runtime.currentBlock = null;
		runtime.nativeOutputItems.length = 0;
		resetOutputState(context.output);
		context.firstTokenTime = undefined;
		recordCodexWebSocketFailure(websocketState, true);
		await reopenCodexSseRuntimeStream(context, runtime, websocketState);
		return true;
	}

	// No content emitted yet — reconnect over websocket.
	runtime.websocketStreamRetries += 1;
	await reopenCodexWebSocketRuntimeStream(context, runtime, websocketState);
	return true;
}

function isCodexPreviousResponseNotFound(error: unknown): boolean {
	return (
		error instanceof CodexProviderStreamError &&
		typeof error.code === "string" &&
		CODEX_PREVIOUS_RESPONSE_STALE_CODES.has(error.code)
	);
}

async function tryRecoverCodexPreviousResponseNotFound(
	context: CodexStreamProcessingContext,
	runtime: CodexStreamRuntime,
	error: unknown,
): Promise<boolean> {
	const websocketState = context.requestContext.websocketState;
	if (
		!isCodexPreviousResponseNotFound(error) ||
		!websocketState ||
		context.options?.fallbackManaged ||
		runtime.transport !== "websocket" ||
		context.output.content.length > 0 ||
		context.options?.signal?.aborted ||
		runtime.providerRetryAttempt >= resolveRetryBudget(context.options?.streamMaxRetries, CODEX_MAX_RETRIES)
	) {
		return false;
	}

	runtime.providerRetryAttempt += 1;
	resetCodexWebSocketAppendState(websocketState);
	resetCodexSessionMetadata(websocketState);
	runtime.currentItem = null;
	runtime.currentBlock = null;
	runtime.sawTerminalEvent = false;
	runtime.nativeOutputItems.length = 0;
	resetOutputState(context.output);
	context.firstTokenTime = undefined;

	logCodexDebug("codex previous_response_id expired; retrying with full context", {
		retry: runtime.providerRetryAttempt,
	});
	await reopenCodexWebSocketRuntimeStream(context, runtime, websocketState);
	return true;
}

async function tryReplayWebsocketFailureOverSse(
	context: CodexStreamProcessingContext,
	runtime: CodexStreamRuntime,
	error: unknown,
): Promise<boolean> {
	const websocketState = context.requestContext.websocketState;
	const canReplay =
		runtime.transport === "websocket" &&
		websocketState &&
		isCodexWebSocketRetryableStreamError(error) &&
		runtime.canSafelyReplayWebsocketOverSse &&
		!runtime.sawTerminalEvent &&
		!context.options?.signal?.aborted &&
		!context.options?.fallbackManaged;
	if (!canReplay) return false;

	const state = websocketState;
	const streamError = error instanceof Error ? error : new Error(String(error));
	const replayingBufferedOutputOverSse = context.output.content.length > 0;
	const isFatal = isCodexWebSocketFatalError(streamError);
	const activateFallback =
		replayingBufferedOutputOverSse ||
		isFatal ||
		runtime.websocketStreamRetries >= getCodexWebSocketRetryBudget(context.options);
	recordCodexWebSocketFailure(state, activateFallback);
	logCodexDebug("codex websocket stream fallback", {
		error: streamError.message,
		retry: runtime.websocketStreamRetries,
		retryBudget: getCodexWebSocketRetryBudget(context.options),
		activated: activateFallback,
		fatal: isFatal,
		replayedBufferedOutput: replayingBufferedOutputOverSse,
	});

	if (!activateFallback) {
		runtime.websocketStreamRetries += 1;
		await scheduler.wait(getCodexWebSocketRetryDelayMs(runtime.websocketStreamRetries), {
			signal: context.requestSetup.requestSignal,
		});
		await reopenCodexWebSocketRuntimeStream(context, runtime, state);
		return true;
	}

	if (replayingBufferedOutputOverSse) {
		runtime.canSafelyReplayWebsocketOverSse = true;
		runtime.currentItem = null;
		runtime.currentBlock = null;
		runtime.nativeOutputItems.length = 0;
		resetOutputState(context.output);
		context.firstTokenTime = undefined;
	}

	await reopenCodexSseRuntimeStream(context, runtime, state);
	return true;
}

async function tryRetryCodexProviderError(
	context: CodexStreamProcessingContext,
	runtime: CodexStreamRuntime,
	error: unknown,
): Promise<boolean> {
	if (
		!isRetryableCodexProviderError(error) ||
		context.output.content.length > 0 ||
		runtime.providerRetryAttempt >= resolveRetryBudget(context.options?.streamMaxRetries, CODEX_MAX_RETRIES) ||
		context.options?.signal?.aborted ||
		context.options?.fallbackManaged
	) {
		return false;
	}

	runtime.providerRetryAttempt += 1;
	const websocketState = context.requestContext.websocketState;
	if (runtime.transport === "websocket" && websocketState) {
		resetCodexWebSocketAppendState(websocketState);
		resetCodexSessionMetadata(websocketState);
	}

	logCodexDebug("retrying codex provider stream error", {
		error: error instanceof Error ? error.message : String(error),
		retry: runtime.providerRetryAttempt,
		retryBudget: resolveRetryBudget(context.options?.streamMaxRetries, CODEX_MAX_RETRIES),
		transport: runtime.transport,
	});

	runtime.currentItem = null;
	runtime.currentBlock = null;
	runtime.sawTerminalEvent = false;
	resetOutputState(context.output);
	context.firstTokenTime = undefined;
	await scheduler.wait(CODEX_RETRY_DELAY_MS * runtime.providerRetryAttempt, {
		signal: context.requestSetup.requestSignal,
	});

	if (runtime.transport === "websocket" && websocketState) {
		await reopenCodexWebSocketRuntimeStream(context, runtime, websocketState);
		return true;
	}

	await reopenCodexSseRuntimeStream(context, runtime, websocketState);
	return true;
}

function finalizeCodexResponse(
	context: CodexStreamProcessingContext,
	runtime: CodexStreamRuntime,
	completion: CodexStreamCompletion,
): AssistantMessage {
	const { output } = context;
	if (context.options?.signal?.aborted) {
		throw new Error("Request was aborted");
	}
	if (!runtime.sawTerminalEvent) {
		if (runtime.transport === "websocket" && context.requestContext.websocketState) {
			resetCodexWebSocketAppendState(context.requestContext.websocketState);
			resetCodexSessionMetadata(context.requestContext.websocketState);
		}
		logCodexDebug("codex stream ended unexpectedly", {
			transport: runtime.transport,
			terminalEventSeen: runtime.sawTerminalEvent,
			unexpectedStreamEnd: true,
			sentTurnStateHeader: Boolean(context.requestContext.websocketState?.turnState),
			sentModelsEtagHeader: Boolean(context.requestContext.websocketState?.modelsEtag),
		});
		throw new Error("Codex stream ended before terminal completion event");
	}
	if (output.stopReason === "aborted" || output.stopReason === "error") {
		throw new Error("Codex response failed");
	}

	output.providerPayload = createOpenAIResponsesHistoryPayload(context.model.provider, runtime.nativeOutputItems);
	output.duration = Date.now() - context.startTime;
	if (completion.firstTokenTime) {
		output.ttft = completion.firstTokenTime - context.startTime;
	}
	return output;
}

async function handleCodexStreamFailure(
	context: CodexStreamProcessingContext,
	error: unknown,
): Promise<AssistantMessage> {
	const { output } = context;
	removeTransientBlockIndices(output);
	if (context.requestContext.websocketState) {
		resetCodexWebSocketAppendState(context.requestContext.websocketState);
		resetCodexSessionMetadata(context.requestContext.websocketState);
	}
	output.stopReason = context.options?.signal?.aborted ? "aborted" : "error";
	output.errorStatus = extractHttpStatusFromError(error);
	output.transportFailure = transportFailureFacts(error);
	output.errorMessage = await finalizeErrorMessage(error, context.requestContext.rawRequestDump);
	output.duration = Date.now() - context.startTime;
	if (context.firstTokenTime) {
		output.ttft = context.firstTokenTime - context.startTime;
	}
	return output;
}

export const streamOpenAICodexResponses: StreamFunction<"openai-codex-responses"> = (
	model: Model<"openai-codex-responses">,
	context: Context,
	options?: OpenAICodexResponsesOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();

	(async () => {
		const startTime = Date.now();
		const output = createAssistantOutput(model);
		const requestSetup = createRequestSetup(options);
		let processingContext: CodexStreamProcessingContext | undefined;

		try {
			const requestContext = await buildCodexRequestContext(model, context, options, output);
			let initialTransport: Awaited<ReturnType<typeof openInitialCodexEventStream>>;
			try {
				initialTransport = await openInitialCodexEventStream(model, options, requestSetup, requestContext);
			} catch (error) {
				if (options?.fallbackManaged) throw error;
				initialTransport = await retryCodexInitialTransportWithoutToolChoice(
					model,
					options,
					requestSetup,
					requestContext,
					stream,
					error,
				);
			}
			const runtime = createCodexStreamRuntime({
				...initialTransport,
				websocketState: requestContext.websocketState,
			});
			if (requestContext.websocketState) {
				requestContext.websocketState.lastTransport = initialTransport.transport;
			}

			processingContext = {
				model,
				output,
				stream,
				options,
				requestSetup,
				requestContext,
				startTime,
			};

			const completion = await processCodexResponseStream(processingContext, runtime);
			processingContext.firstTokenTime = completion.firstTokenTime;
			const message = finalizeCodexResponse(processingContext, runtime, completion);
			stream.push({ type: "done", reason: message.stopReason as "stop" | "length" | "toolUse", message });
			stream.end();
		} catch (error) {
			const failureContext =
				processingContext ??
				({
					model,
					output,
					stream,
					options,
					requestSetup,
					requestContext: {
						apiKey: "",
						accountId: "",
						baseUrl: model.baseUrl || CODEX_BASE_URL,
						url: "",
						requestHeaders: {},
						transformedBody: { model: model.id },
						rawRequestDump: {
							provider: model.provider,
							api: output.api,
							model: model.id,
							method: "POST",
							url: "",
							body: { model: model.id },
						},
					},
					startTime,
				} satisfies CodexStreamProcessingContext);
			const failure = await handleCodexStreamFailure(failureContext, error);
			stream.push({ type: "error", reason: failure.stopReason as "error" | "aborted", error: failure });
			stream.end();
		}
	})();

	return stream;
};

export async function prewarmOpenAICodexResponses(
	model: Model<"openai-codex-responses">,
	options?: Pick<
		OpenAICodexResponsesOptions,
		"apiKey" | "headers" | "sessionId" | "signal" | "preferWebsockets" | "providerSessionState"
	>,
): Promise<void> {
	const apiKey = options?.apiKey || getEnvApiKey(model.provider) || "";
	if (!apiKey) return;
	const accountId = getAccountId(apiKey);
	const baseUrl = model.baseUrl || CODEX_BASE_URL;
	const url = resolveCodexResponsesUrl(baseUrl);
	const promptCacheKey = normalizeOpenAIResponsesPromptCacheKey(options?.sessionId);
	const providerSessionState = getCodexProviderSessionState(options?.providerSessionState);
	const sessionKey = getCodexWebSocketSessionKey(promptCacheKey, model, accountId, baseUrl);
	const publicSessionKey = getCodexPublicSessionKey(promptCacheKey, model, baseUrl);
	if (publicSessionKey && sessionKey) {
		providerSessionState?.webSocketPublicToPrivate.set(publicSessionKey, sessionKey);
	}
	if (!sessionKey || !providerSessionState) return;
	const state = getCodexWebSocketSessionState(sessionKey, providerSessionState);
	if (!shouldUseCodexWebSocket(model, state, options?.preferWebsockets)) return;
	const headers = logger.time(
		"prewarmCodex:createHeaders",
		createCodexHeaders,
		{ ...(model.headers ?? {}), ...(options?.headers ?? {}) },
		accountId,
		apiKey,
		promptCacheKey,
		"websocket",
		state,
	);
	await logger.time(
		"prewarmCodex:establishWs",
		getOrCreateCodexWebSocketConnection,
		state,
		toWebSocketUrl(url),
		headers,
		options?.signal,
	);
	state.prewarmed = true;
}

function getCodexWebSocketSessionKey(
	sessionId: string | undefined,
	model: Model<"openai-codex-responses">,
	accountId: string | undefined,
	baseUrl: string,
): string | undefined {
	const promptCacheKey = normalizeOpenAIResponsesPromptCacheKey(sessionId);
	if (!promptCacheKey) return undefined;
	return `${accountId ?? "opaque"}:${baseUrl}:${model.id}:${promptCacheKey}`;
}

function getCodexPublicSessionKey(
	sessionId: string | undefined,
	model: Model<"openai-codex-responses">,
	baseUrl: string,
): string | undefined {
	const promptCacheKey = normalizeOpenAIResponsesPromptCacheKey(sessionId);
	if (!promptCacheKey) return undefined;
	return `${baseUrl}:${model.id}:${promptCacheKey}`;
}

function getCodexWebSocketSessionState(
	sessionKey: string,
	providerSessionState: CodexProviderSessionState,
): CodexWebSocketSessionState {
	const existing = providerSessionState.webSocketSessions.get(sessionKey);
	if (existing) return existing;
	const created: CodexWebSocketSessionState = {
		disableWebsocket: false,
		canAppend: false,
		fallbackCount: 0,
		prewarmed: false,
		stats: {
			fullContextRequests: 0,
			deltaRequests: 0,
			lastInputItems: 0,
		},
	};
	providerSessionState.webSocketSessions.set(sessionKey, created);
	return created;
}

function resetCodexWebSocketAppendState(state: CodexWebSocketSessionState): void {
	state.canAppend = false;
	state.lastRequest = undefined;
	state.lastResponseId = undefined;
	state.lastResponseItems = undefined;
}

function resetCodexSessionMetadata(state: CodexWebSocketSessionState): void {
	state.turnState = undefined;
	state.modelsEtag = undefined;
	state.reasoningIncluded = undefined;
}

function recordCodexWebSocketFailure(state: CodexWebSocketSessionState, activateFallback: boolean): void {
	resetCodexWebSocketAppendState(state);
	state.connection?.close("fallback");
	state.connection = undefined;
	state.lastFallbackAt = Date.now();
	if (activateFallback && !state.disableWebsocket) {
		state.disableWebsocket = true;
		state.fallbackCount += 1;
	}
}

function shouldUseCodexWebSocket(
	model: Model<"openai-codex-responses">,
	state: CodexWebSocketSessionState | undefined,
	preferWebsockets?: boolean,
): boolean {
	if (!state || state.disableWebsocket) return false;
	if (preferWebsockets === false) return false;
	return isCodexWebSocketEnvEnabled() || preferWebsockets === true || model.preferWebsockets === true;
}

export interface OpenAICodexTransportDetails {
	websocketPreferred: boolean;
	lastTransport?: CodexTransport;
	websocketDisabled: boolean;
	websocketConnected: boolean;
	fallbackCount: number;
	canAppend: boolean;
	prewarmed: boolean;
	hasSessionState: boolean;
	lastFallbackAt?: number;
}

function getCodexWebSocketStateForPublicSession(
	model: Model<"openai-codex-responses">,
	options:
		| {
				sessionId?: string;
				baseUrl?: string;
				providerSessionState?: Map<string, ProviderSessionState>;
		  }
		| undefined,
): CodexWebSocketSessionState | undefined {
	const baseUrl = options?.baseUrl || model.baseUrl || CODEX_BASE_URL;
	const providerSessionState = getCodexProviderSessionState(options?.providerSessionState);
	const publicSessionKey = getCodexPublicSessionKey(options?.sessionId, model, baseUrl);
	const privateSessionKey = publicSessionKey
		? providerSessionState?.webSocketPublicToPrivate.get(publicSessionKey)
		: undefined;
	return privateSessionKey ? providerSessionState?.webSocketSessions.get(privateSessionKey) : undefined;
}

export function getOpenAICodexWebSocketDebugStats(
	model: Model<"openai-codex-responses">,
	options?: {
		sessionId?: string;
		baseUrl?: string;
		providerSessionState?: Map<string, ProviderSessionState>;
	},
): OpenAICodexWebSocketDebugStats | undefined {
	const stats = getCodexWebSocketStateForPublicSession(model, options)?.stats;
	return stats ? { ...stats } : undefined;
}

export function getOpenAICodexTransportDetails(
	model: Model<"openai-codex-responses">,
	options?: {
		sessionId?: string;
		baseUrl?: string;
		preferWebsockets?: boolean;
		providerSessionState?: Map<string, ProviderSessionState>;
	},
): OpenAICodexTransportDetails {
	const websocketPreferred =
		options?.preferWebsockets === false
			? false
			: isCodexWebSocketEnvEnabled() || options?.preferWebsockets === true || model.preferWebsockets === true;
	const state = getCodexWebSocketStateForPublicSession(model, options);

	return {
		websocketPreferred,
		lastTransport: state?.lastTransport,
		websocketDisabled: state?.disableWebsocket ?? false,
		websocketConnected: state?.connection?.isOpen() ?? false,
		fallbackCount: state?.fallbackCount ?? 0,
		canAppend: state?.canAppend ?? false,
		prewarmed: state?.prewarmed ?? false,
		hasSessionState: state !== undefined,
		lastFallbackAt: state?.lastFallbackAt,
	};
}

function buildAppendInput(
	previous: RequestBody | undefined,
	previousResponseItems: InputItem[] | undefined,
	current: RequestBody,
): InputItem[] | null {
	if (!previous) return null;
	if (!Array.isArray(previous.input) || !Array.isArray(current.input)) return null;
	const previousWithoutInput = { ...previous, input: undefined };
	const currentWithoutInput = { ...current, input: undefined };
	if (JSON.stringify(previousWithoutInput) !== JSON.stringify(currentWithoutInput)) {
		return null;
	}
	const baseline = [...previous.input, ...(previousResponseItems ?? [])];
	if (current.input.length <= baseline.length) return null;
	for (let index = 0; index < baseline.length; index += 1) {
		if (JSON.stringify(baseline[index]) !== JSON.stringify(current.input[index])) {
			return null;
		}
	}
	return current.input.slice(baseline.length) as InputItem[];
}

function stripInputItemIds(items: Array<Record<string, unknown>>): InputItem[] {
	return items.map(item => {
		if (item.id == null) return item as InputItem;
		const { id: _id, ...rest } = item;
		return rest as InputItem;
	});
}

function recordCodexWebSocketRequestStats(
	state: CodexWebSocketSessionState | undefined,
	request: Record<string, unknown>,
): void {
	if (!state) return;
	const input = request.input;
	state.stats.lastInputItems = Array.isArray(input) ? input.length : 0;
	if (typeof request.previous_response_id === "string" && request.previous_response_id.length > 0) {
		state.stats.deltaRequests += 1;
		state.stats.lastDeltaInputItems = state.stats.lastInputItems;
		state.stats.lastPreviousResponseId = request.previous_response_id;
		return;
	}
	state.stats.fullContextRequests += 1;
	state.stats.lastDeltaInputItems = undefined;
	state.stats.lastPreviousResponseId = undefined;
}

function buildCodexWebSocketRequest(
	requestBody: RequestBody,
	state: CodexWebSocketSessionState | undefined,
): Record<string, unknown> {
	const appendInput = state?.canAppend
		? buildAppendInput(state.lastRequest, state.lastResponseItems, requestBody)
		: null;
	if (appendInput && appendInput.length > 0 && state?.lastResponseId) {
		const request = {
			type: "response.create",
			...requestBody,
			previous_response_id: state.lastResponseId,
			input: appendInput,
		};
		recordCodexWebSocketRequestStats(state, request);
		return request;
	}
	if (state?.canAppend) {
		logCodexDebug("codex websocket append reset", {
			hadTurnStateHeader: Boolean(state.turnState),
			hadModelsEtagHeader: Boolean(state.modelsEtag),
		});
		resetCodexWebSocketAppendState(state);
		resetCodexSessionMetadata(state);
	}
	const request = {
		type: "response.create",
		...requestBody,
	};
	recordCodexWebSocketRequestStats(state, request);
	return request;
}

function toWebSocketUrl(url: string): string {
	const parsed = new URL(url);
	if (parsed.protocol === "https:") {
		parsed.protocol = "wss:";
	} else if (parsed.protocol === "http:") {
		parsed.protocol = "ws:";
	}
	return parsed.toString();
}

function headersToRecord(headers: Headers): Record<string, string> {
	const result: Record<string, string> = {};
	for (const [key, value] of headers.entries()) {
		result[key] = value;
	}
	return result;
}

interface CodexWebSocketConnectionOptions {
	idleTimeoutMs: number;
	firstEventTimeoutMs: number;
	onHandshakeHeaders?: (headers: Headers) => void;
}

class CodexWebSocketConnection {
	#url: string;
	#headers: Record<string, string>;
	#idleTimeoutMs: number;
	#firstEventTimeoutMs: number;
	#onHandshakeHeaders?: (headers: Headers) => void;
	#socket: Bun.WebSocket | null = null;
	#queue: Array<Record<string, unknown> | Error | null> = [];
	#waiters: Array<() => void> = [];
	#connectPromise?: Promise<void>;
	#activeRequest = false;

	constructor(url: string, headers: Record<string, string>, options: CodexWebSocketConnectionOptions) {
		this.#url = url;
		this.#headers = headers;
		this.#idleTimeoutMs = options.idleTimeoutMs;
		this.#firstEventTimeoutMs = options.firstEventTimeoutMs;
		this.#onHandshakeHeaders = options.onHandshakeHeaders;
	}

	isOpen(): boolean {
		return this.#socket?.readyState === WebSocket.OPEN;
	}

	matchesAuth(headers: Record<string, string>): boolean {
		return this.#headers.authorization === headers.authorization;
	}

	close(reason = "done"): void {
		if (
			this.#socket &&
			(this.#socket.readyState === WebSocket.OPEN || this.#socket.readyState === WebSocket.CONNECTING)
		) {
			this.#socket.close(1000, reason);
		}
		this.#socket = null;
	}

	async connect(signal?: AbortSignal): Promise<void> {
		if (this.isOpen()) return;
		if (this.#connectPromise) {
			logger.time("codexWs:awaitSharedHandshake");
			await this.#connectPromise;
			return;
		}
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		this.#connectPromise = promise;
		const socket = new (WebSocket as unknown as new (url: string, opts: Bun.WebSocketOptions) => Bun.WebSocket)(
			this.#url,
			{ headers: this.#headers },
		);
		socket.binaryType = "nodebuffer";
		this.#socket = socket;
		let settled = false;
		let timeout: NodeJS.Timeout | undefined;
		const onAbort = () => {
			socket.close(1000, "aborted");
			if (!settled) {
				settled = true;
				reject(createCodexWebSocketTransportError("request was aborted"));
			}
		};
		if (signal) {
			if (signal.aborted) {
				onAbort();
			} else {
				signal.addEventListener("abort", onAbort, { once: true });
			}
		}
		const clearPending = () => {
			if (timeout) clearTimeout(timeout);
			if (signal) signal.removeEventListener("abort", onAbort);
		};
		timeout = setTimeout(() => {
			socket.close(1000, "connect-timeout");
			if (!settled) {
				settled = true;
				reject(createCodexWebSocketTransportError("connection timeout"));
			}
		}, CODEX_WEBSOCKET_CONNECT_TIMEOUT_MS);

		socket.onopen = event => {
			if (!settled) {
				settled = true;
				clearPending();
				this.#captureHandshakeHeaders(socket, event);
				resolve();
			}
		};
		socket.onerror = event => {
			const eventRecord = event as unknown as Record<string, unknown>;
			const detail =
				(typeof eventRecord.message === "string" && eventRecord.message) ||
				(eventRecord.error instanceof Error && eventRecord.error.message) ||
				String(event.type);
			const error = createCodexWebSocketTransportError(`websocket error: ${detail}`);
			if (!settled) {
				settled = true;
				clearPending();
				reject(error);
				return;
			}
			this.#push(error);
		};
		socket.onclose = event => {
			this.#socket = null;
			if (!settled) {
				settled = true;
				clearPending();
				reject(createCodexWebSocketTransportError(`websocket closed before open (${event.code})`));
				return;
			}
			this.#push(createCodexWebSocketTransportError(`websocket closed (${event.code})`));
			this.#push(null);
		};
		socket.onmessage = event => {
			try {
				const text = typeof event.data === "string" ? event.data : Buffer.from(event.data).toString("utf-8");
				if (!text) return;
				const parsed = JSON.parse(text) as Record<string, unknown>;
				if (parsed.type === "error" && typeof parsed.error === "object" && parsed.error) {
					const inner = parsed.error as Record<string, unknown>;
					if (typeof parsed.code !== "string" && typeof inner.code === "string") {
						parsed.code = inner.code;
					}
					if (typeof parsed.message !== "string" && typeof inner.message === "string") {
						parsed.message = inner.message;
					}
				}
				this.#push(parsed);
			} catch (error) {
				this.#push(createCodexWebSocketTransportError(String(error)));
			}
		};

		logger.time("codexWs:awaitTcpHandshake");
		try {
			await promise;
		} finally {
			this.#connectPromise = undefined;
		}
	}

	async *streamRequest(
		request: Record<string, unknown>,
		signal?: AbortSignal,
	): AsyncGenerator<Record<string, unknown>> {
		if (!this.#socket || this.#socket.readyState !== WebSocket.OPEN) {
			throw createCodexWebSocketTransportError("websocket connection is unavailable");
		}
		if (this.#activeRequest) {
			throw createCodexWebSocketTransportError("websocket request already in progress");
		}
		this.#activeRequest = true;
		const onAbort = () => {
			this.close("aborted");
			this.#push(createCodexWebSocketTransportError("request was aborted"));
		};
		if (signal) {
			if (signal.aborted) {
				onAbort();
			} else {
				signal.addEventListener("abort", onAbort, { once: true });
			}
		}

		try {
			this.#socket.send(JSON.stringify(request));
			let sawFirstEvent = false;
			let lastProgressAt = Date.now();
			while (true) {
				let timeoutMs = this.#firstEventTimeoutMs;
				if (sawFirstEvent) {
					timeoutMs = this.#idleTimeoutMs - (Date.now() - lastProgressAt);
					if (timeoutMs <= 0) {
						throw createCodexWebSocketTransportError("idle timeout waiting for websocket");
					}
				}
				const next = await this.#nextMessage(
					timeoutMs,
					sawFirstEvent ? "idle timeout waiting for websocket" : "timeout waiting for first websocket event",
				);
				if (next instanceof Error) {
					throw next;
				}
				if (next === null) {
					throw createCodexWebSocketTransportError("websocket closed before response completion");
				}
				sawFirstEvent = true;
				if (isCodexStreamProgressEvent(next)) {
					lastProgressAt = Date.now();
				}
				yield next;
				const eventType = typeof next.type === "string" ? next.type : "";
				if (
					eventType === "response.completed" ||
					eventType === "response.done" ||
					eventType === "response.incomplete" ||
					eventType === "response.failed" ||
					eventType === "error"
				) {
					break;
				}
			}
		} finally {
			this.#activeRequest = false;
			if (signal) {
				signal.removeEventListener("abort", onAbort);
			}
		}
	}

	#captureHandshakeHeaders(socket: Bun.WebSocket, openEvent?: Event): void {
		if (!this.#onHandshakeHeaders) return;
		const headers = extractCodexWebSocketHandshakeHeaders(socket, openEvent);
		if (!headers) return;
		this.#onHandshakeHeaders(headers);
	}

	#push(item: Record<string, unknown> | Error | null): void {
		this.#queue.push(item);
		const waiter = this.#waiters.shift();
		if (waiter) waiter();
	}

	async #nextMessage(timeoutMs: number, timeoutReason: string): Promise<Record<string, unknown> | Error | null> {
		while (this.#queue.length === 0) {
			const { promise, resolve } = Promise.withResolvers<void>();
			this.#waiters.push(resolve);
			let timedOut = false;
			let timeout: NodeJS.Timeout | undefined;
			if (timeoutMs > 0) {
				timeout = setTimeout(() => {
					timedOut = true;
					const waiterIndex = this.#waiters.indexOf(resolve);
					if (waiterIndex >= 0) {
						this.#waiters.splice(waiterIndex, 1);
					}
					resolve();
				}, timeoutMs);
			}
			await promise;
			if (timeout) clearTimeout(timeout);
			if (timedOut && this.#queue.length === 0) {
				return createCodexWebSocketTransportError(timeoutReason);
			}
		}
		return this.#queue.shift() ?? null;
	}
}

async function getOrCreateCodexWebSocketConnection(
	state: CodexWebSocketSessionState,
	url: string,
	headers: Headers,
	signal?: AbortSignal,
	options?: Pick<OpenAICodexResponsesOptions, "streamFirstEventTimeoutMs" | "streamIdleTimeoutMs">,
): Promise<CodexWebSocketConnection> {
	const headerRecord = headersToRecord(headers);
	if (state.connection?.isOpen()) {
		if (state.connection.matchesAuth(headerRecord)) {
			logger.time("codexWs:reuseOpenSocket");
			return state.connection;
		}
		state.connection.close("token-refresh");
		resetCodexWebSocketAppendState(state);
	}
	state.connection?.close("reconnect");
	resetCodexWebSocketAppendState(state);
	logger.time("codexWs:newSocket");
	const idleTimeoutMs = getCodexWebSocketIdleTimeoutMs(options?.streamIdleTimeoutMs);
	state.connection = new CodexWebSocketConnection(url, headerRecord, {
		idleTimeoutMs,
		firstEventTimeoutMs: getCodexWebSocketFirstEventTimeoutMs(idleTimeoutMs, options?.streamFirstEventTimeoutMs),
		onHandshakeHeaders: handshakeHeaders => {
			updateCodexSessionMetadataFromHeaders(state, handshakeHeaders);
		},
	});
	await state.connection.connect(signal);
	return state.connection;
}

async function openCodexSseEventStream(
	url: string,
	requestHeaders: Record<string, string> | undefined,
	accountId: string | undefined,
	apiKey: string,
	sessionId: string | undefined,
	body: RequestBody,
	state: CodexWebSocketSessionState | undefined,
	signal?: AbortSignal,
	onSseEvent?: OpenAICodexResponsesOptions["onSseEvent"],
	fetchOverride?: FetchImpl,
	options?: Pick<OpenAICodexResponsesOptions, "requestMaxRetries">,
): Promise<AsyncGenerator<Record<string, unknown>>> {
	const headers = createCodexHeaders(requestHeaders, accountId, apiKey, sessionId, "sse", state);
	logCodexDebug("codex request", {
		url,
		model: body.model,
		headers: redactHeaders(headers),
		sentTurnStateHeader: headers.has(X_CODEX_TURN_STATE_HEADER),
		sentModelsEtagHeader: headers.has(X_MODELS_ETAG_HEADER),
	});
	const response = await fetchWithRetry(url, {
		method: "POST",
		headers,
		body: JSON.stringify(body),
		signal,
		maxAttempts: resolveRetryBudget(options?.requestMaxRetries, CODEX_MAX_RETRIES) + 1,
		defaultDelayMs: attempt => CODEX_RETRY_DELAY_MS * (attempt + 1),
		maxDelayMs: CODEX_RATE_LIMIT_BUDGET_MS,
		fetch: fetchOverride,
	});
	logCodexDebug("codex response", {
		url: response.url,
		status: response.status,
		statusText: response.statusText,
		contentType: response.headers.get("content-type") || null,
		cfRay: response.headers.get("cf-ray") || null,
	});
	updateCodexSessionMetadataFromHeaders(state, response.headers);
	if (!response.ok) {
		const info = await parseCodexError(response);
		const error = new Error(info.friendlyMessage || info.message);
		(error as { headers?: Headers; status?: number }).headers = response.headers;
		(error as { headers?: Headers; status?: number }).status = response.status;
		(error as { code?: string }).code = info.code;
		throw error;
	}
	if (!response.body) {
		throw new Error("No response body");
	}
	return readSseJson<Record<string, unknown>>(response.body, signal, event =>
		onSseEvent?.({ event: event.event, data: event.data, raw: [...event.raw] }, undefined),
	);
}

async function openCodexWebSocketEventStream(
	url: string,
	headers: Headers,
	request: Record<string, unknown>,
	state: CodexWebSocketSessionState,
	signal?: AbortSignal,
	options?: Pick<OpenAICodexResponsesOptions, "streamFirstEventTimeoutMs" | "streamIdleTimeoutMs">,
): Promise<AsyncGenerator<Record<string, unknown>>> {
	const connection = await getOrCreateCodexWebSocketConnection(state, url, headers, signal, options);
	return connection.streamRequest(request, signal);
}

function createCodexHeaders(
	initHeaders: Record<string, string> | undefined,
	accountId: string | undefined,
	accessToken: string,
	promptCacheKey?: string,
	transport: CodexTransport = "sse",
	state?: CodexWebSocketSessionState,
): Headers {
	const headers = new Headers(initHeaders ?? {});
	headers.delete("x-api-key");
	headers.set("Authorization", `Bearer ${accessToken}`);
	if (accountId) {
		headers.set(OPENAI_HEADERS.ACCOUNT_ID, accountId);
	} else {
		headers.delete(OPENAI_HEADERS.ACCOUNT_ID);
	}
	const betaHeader =
		transport === "websocket"
			? OPENAI_HEADER_VALUES.BETA_RESPONSES_WEBSOCKETS_V2
			: OPENAI_HEADER_VALUES.BETA_RESPONSES;
	headers.delete(OPENAI_HEADERS.BETA);
	headers.delete("openai-beta");
	headers.set(OPENAI_HEADERS.BETA, betaHeader);
	headers.set(OPENAI_HEADERS.ORIGINATOR, OPENAI_HEADER_VALUES.ORIGINATOR_CODEX);
	headers.set("User-Agent", getCodexUserAgent());
	if (promptCacheKey) {
		headers.set(OPENAI_HEADERS.CONVERSATION_ID, promptCacheKey);
		headers.set(OPENAI_HEADERS.SESSION_ID, promptCacheKey);
		headers.set("x-client-request-id", promptCacheKey);
	} else {
		headers.delete(OPENAI_HEADERS.CONVERSATION_ID);
		headers.delete(OPENAI_HEADERS.SESSION_ID);
	}
	if (state?.turnState) {
		headers.set(X_CODEX_TURN_STATE_HEADER, state.turnState);
	} else {
		headers.delete(X_CODEX_TURN_STATE_HEADER);
	}
	if (state?.modelsEtag) {
		headers.set(X_MODELS_ETAG_HEADER, state.modelsEtag);
	} else {
		headers.delete(X_MODELS_ETAG_HEADER);
	}
	if (transport === "sse") {
		headers.set("accept", "text/event-stream");
		headers.set("content-type", "application/json");
	} else {
		headers.delete("accept");
		headers.delete("content-type");
	}
	return headers;
}

function logCodexDebug(message: string, details?: Record<string, unknown>): void {
	if (!CODEX_DEBUG) return;
	logger.debug(`[codex] ${message}`, details ?? {});
}

function redactHeaders(headers: Headers): Record<string, string> {
	const redacted: Record<string, string> = {};
	for (const [key, value] of headers.entries()) {
		const lower = key.toLowerCase();
		if (lower === "authorization") {
			redacted[key] = "Bearer [redacted]";
			continue;
		}
		if (
			lower.includes("account") ||
			lower.includes("session") ||
			lower.includes("conversation") ||
			lower === "cookie"
		) {
			redacted[key] = "[redacted]";
			continue;
		}
		redacted[key] = value;
	}
	return redacted;
}

function resolveCodexResponsesUrl(baseUrl: string | undefined): string {
	const raw = baseUrl && baseUrl.trim().length > 0 ? baseUrl : CODEX_BASE_URL;
	const normalized = raw.replace(/\/+$/, "");
	if (normalized.endsWith("/codex/responses")) return normalized;
	if (normalized.endsWith("/codex")) return `${normalized}/responses`;
	return `${normalized}/codex/responses`;
}

function getAccountId(accessToken: string): string | undefined {
	return getCodexAccountId(accessToken);
}

function convertMessages(model: Model<"openai-codex-responses">, context: Context): ResponseInput {
	const messages: ResponseInput = [];

	const normalizeToolCallId = (id: string): string => {
		if (!id.includes("|")) return id;
		const [callId, itemId] = id.split("|");
		const sanitizedCallId = callId.replace(/[^a-zA-Z0-9_-]/g, "_");
		let sanitizedItemId = itemId.replace(/[^a-zA-Z0-9_-]/g, "_");
		if (!sanitizedItemId.startsWith("fc")) {
			sanitizedItemId = `fc_${sanitizedItemId}`;
		}
		let normalizedCallId = sanitizedCallId.length > 64 ? sanitizedCallId.slice(0, 64) : sanitizedCallId;
		let normalizedItemId = sanitizedItemId.length > 64 ? sanitizedItemId.slice(0, 64) : sanitizedItemId;
		normalizedCallId = normalizedCallId.replace(/_+$/, "");
		normalizedItemId = normalizedItemId.replace(/_+$/, "");
		return `${normalizedCallId}|${normalizedItemId}`;
	};

	const transformedMessages = transformMessages(context.messages, model, normalizeToolCallId);
	let msgIndex = 0;
	// Track call_ids that originated as custom tool calls so paired tool-result
	// messages can be replayed as `custom_tool_call_output` rather than
	// `function_call_output` (OpenAI rejects mismatched pairs).
	const customCallIds = new Set<string>();
	const knownCallIds = new Set<string>();

	for (const msg of transformedMessages) {
		if (msg.role === "user" || msg.role === "developer") {
			const providerPayload = (msg as { providerPayload?: AssistantMessage["providerPayload"] }).providerPayload;
			const historyItems = getOpenAIResponsesHistoryItems(providerPayload, model.provider);
			if (historyItems) {
				const sanitizedHistoryItems = sanitizeOpenAIResponsesHistoryItemsForReplay(historyItems);
				for (const item of sanitizedHistoryItems) {
					const maybe = item as { type?: string; call_id?: string };
					if (maybe.type === "custom_tool_call" && typeof maybe.call_id === "string") {
						customCallIds.add(maybe.call_id);
					}
				}
				messages.push(...sanitizedHistoryItems);
				msgIndex += 1;
				continue;
			}

			const normalizedContent = normalizeInputMessageContent(model, msg.content);
			if (normalizedContent.length === 0) continue;
			messages.push({ role: msg.role, content: normalizedContent });
			msgIndex += 1;
			continue;
		}

		if (msg.role === "assistant") {
			const assistantMsg = msg as AssistantMessage;
			const providerPayload = getOpenAIResponsesHistoryPayload(
				assistantMsg.providerPayload,
				model.provider,
				assistantMsg.provider,
			);
			const historyItems = providerPayload?.items;
			if (historyItems) {
				const sanitizedHistoryItems = sanitizeOpenAIResponsesHistoryItemsForReplay(historyItems);
				for (const item of sanitizedHistoryItems) {
					const maybe = item as { type?: string; call_id?: string };
					if (maybe.type === "custom_tool_call" && typeof maybe.call_id === "string") {
						customCallIds.add(maybe.call_id);
					}
				}
				if (providerPayload?.dt) {
					messages.push(...sanitizedHistoryItems);
				} else {
					messages.splice(0, messages.length, ...sanitizedHistoryItems);
					// Keep customCallIds from the pre-splice state since historyItems may re-introduce them.
				}
				msgIndex += 1;
				continue;
			}

			const outputItems = convertResponsesAssistantMessage(
				msg as AssistantMessage,
				model,
				msgIndex,
				knownCallIds,
				true,
				customCallIds,
			);
			if (outputItems.length > 0) {
				messages.push(...outputItems);
			}
			msgIndex += 1;
			continue;
		}

		if (msg.role === "toolResult") {
			appendResponsesToolResultMessages(messages, msg, model, false, knownCallIds, customCallIds);
		}

		msgIndex += 1;
	}

	return messages;
}

function normalizeInputMessageContent(
	model: Model<"openai-codex-responses">,
	content: string | Array<{ type: "text"; text: string } | { type: "image"; mimeType: string; data: string }>,
): ResponseInputContent[] {
	if (typeof content === "string") {
		if (!content || content.trim() === "") return [];
		return [{ type: "input_text", text: content.toWellFormed() }];
	}

	return convertResponsesInputContent(content, model.input.includes("image")) ?? [];
}

/** @internal Exported for tests. `classifyCodexFailureEventRetryable` is the retry classification of a Codex failure event. */
export {
	convertMessages as convertCodexResponsesMessages,
	isRetryableCodexFailureEvent as classifyCodexFailureEventRetryable,
};

/**
 * Whether this OpenAI code backend-backend model should get the custom-tool grammar
 * variant for `apply_patch`. OpenAI code backend-rs uses a single serializer for both
 * the public Responses endpoint and `chatgpt.com/backend-api`, so the
 * backend already accepts `{type: "custom"}` tools in production. The
 * generated model catalog sets `applyPatchToolType` for first-party GPT-5
 * OpenAI code backend models; this runtime path only consumes that metadata.
 */
function supportsFreeformApplyPatchCodex(model: Model<"openai-codex-responses">): boolean {
	return model.applyPatchToolType === "freeform";
}

type CodexToolPayload =
	| {
			type: "function";
			name: string;
			description: string;
			parameters: Record<string, unknown>;
			strict?: boolean;
	  }
	| {
			type: "custom";
			name: string;
			description: string;
			format: { type: "grammar"; syntax: "lark" | "regex"; definition: string };
	  };

/** @internal Exported for tests. */
export function convertOpenAICodexResponsesTools(
	tools: Tool[],
	model: Model<"openai-codex-responses">,
): CodexToolPayload[] {
	const allowFreeform = supportsFreeformApplyPatchCodex(model);
	return tools.map((tool): CodexToolPayload => {
		if (allowFreeform && tool.customFormat) {
			return {
				type: "custom",
				name: tool.customWireName ?? tool.name,
				description: tool.description || "",
				format: {
					type: "grammar",
					syntax: tool.customFormat.syntax,
					definition: compactGrammarDefinition(tool.customFormat.syntax, tool.customFormat.definition),
				},
			};
		}
		const strict = !!(!NO_STRICT && tool.strict);
		const baseParameters = sanitizeSchemaForOpenAIResponses(flattenToolRootCombinators(toolWireSchema(tool)));
		const { schema: parameters, strict: effectiveStrict } = adaptSchemaForStrict(baseParameters, strict);
		return {
			type: "function",
			name: tool.name,
			description: tool.description || "",
			parameters,
			...(effectiveStrict && { strict: true }),
		};
	});
}

function getString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function getCodexEventError(rawEvent: Record<string, unknown>): Record<string, unknown> | null {
	const response = asRecord(rawEvent.response);
	return asRecord(rawEvent.error) ?? (response ? asRecord(response.error) : null);
}

function getCodexEventErrorCode(rawEvent: Record<string, unknown>): string {
	const error = getCodexEventError(rawEvent);
	return getString(error?.code) ?? getString(error?.type) ?? getString(rawEvent.code) ?? "";
}

function getCodexEventErrorMessage(rawEvent: Record<string, unknown>): string {
	const response = asRecord(rawEvent.response);
	const error = getCodexEventError(rawEvent);
	return getString(error?.message) ?? getString(rawEvent.message) ?? getString(response?.message) ?? "";
}

class CodexProviderStreamError extends Error {
	readonly retryable: boolean;
	readonly code?: string;

	constructor(message: string, retryable: boolean, code?: string) {
		super(message);
		this.name = "CodexProviderStreamError";
		this.retryable = retryable;
		this.code = code;
	}
}

function isRetryableCodexFailureEvent(rawEvent: Record<string, unknown>): boolean {
	const code = getCodexEventErrorCode(rawEvent).toLowerCase();
	const message = getCodexEventErrorMessage(rawEvent);
	if (
		(code && CODEX_NON_RETRYABLE_EVENT_CODES.has(code)) ||
		(!!message && CODEX_NON_RETRYABLE_EVENT_MESSAGE.test(message))
	) {
		return false;
	}
	if (code && CODEX_RETRYABLE_EVENT_CODES.has(code)) {
		return true;
	}
	return !!message && CODEX_RETRYABLE_EVENT_MESSAGE.test(message);
}

function createCodexProviderStreamError(rawEvent: Record<string, unknown>): CodexProviderStreamError {
	const code = getCodexEventErrorCode(rawEvent);
	const message = getCodexEventErrorMessage(rawEvent);
	const formattedMessage =
		typeof rawEvent.type === "string" && rawEvent.type === "error"
			? formatCodexErrorEvent(rawEvent, code, message)
			: (formatCodexFailure(rawEvent) ?? "Codex response failed");
	return new CodexProviderStreamError(formattedMessage, isRetryableCodexFailureEvent(rawEvent), code || undefined);
}

function isRetryableCodexProviderError(error: unknown): boolean {
	return error instanceof CodexProviderStreamError && error.retryable;
}

function truncate(text: string, limit: number): string {
	if (text.length <= limit) return text;
	return `${text.slice(0, limit)}…[truncated ${text.length - limit}]`;
}

function formatCodexFailure(rawEvent: Record<string, unknown>): string | null {
	const response = asRecord(rawEvent.response);
	const error = asRecord(rawEvent.error) ?? (response ? asRecord(response.error) : null);
	const message = getString(error?.message) ?? getString(rawEvent.message) ?? getString(response?.message);
	const code = getString(error?.code) ?? getString(error?.type) ?? getString(rawEvent.code);
	const status = getString(response?.status) ?? getString(rawEvent.status);

	const meta: string[] = [];
	if (code) meta.push(`code=${code}`);
	if (status) meta.push(`status=${status}`);

	if (message) {
		const metaText = meta.length ? ` (${meta.join(", ")})` : "";
		return `Codex response failed: ${message}${metaText}`;
	}
	if (meta.length) {
		return `Codex response failed (${meta.join(", ")})`;
	}
	try {
		return `Codex response failed: ${truncate(JSON.stringify(rawEvent), 800)}`;
	} catch {
		return "Codex response failed";
	}
}

function formatCodexErrorEvent(rawEvent: Record<string, unknown>, code: string, message: string): string {
	const detail = formatCodexFailure(rawEvent);
	if (detail) {
		return detail.replace("response failed", "error event");
	}
	const meta: string[] = [];
	if (code) meta.push(`code=${code}`);
	if (message) meta.push(`message=${message}`);
	if (meta.length > 0) {
		return `Codex error event (${meta.join(", ")})`;
	}
	try {
		return `Codex error event: ${truncate(JSON.stringify(rawEvent), 800)}`;
	} catch {
		return "Codex error event";
	}
}
