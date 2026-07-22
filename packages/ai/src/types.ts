import type { ZodType, z } from "zod/v4";
import type { BedrockOptions } from "./providers/amazon-bedrock";
import type { AnthropicOptions } from "./providers/anthropic";
import type { AzureOpenAIResponsesOptions } from "./providers/azure-openai-responses";
import type { CursorOptions } from "./providers/cursor";
import type {
	DeleteArgs,
	DeleteResult,
	DiagnosticsArgs,
	DiagnosticsResult,
	GrepArgs,
	GrepResult,
	LsArgs,
	LsResult,
	McpResult,
	ReadArgs,
	ReadResult,
	ShellArgs,
	ShellResult,
	WriteArgs,
	WriteResult,
} from "./providers/cursor/gen/agent_pb";
import type { GoogleOptions } from "./providers/google";
import type { GoogleGeminiCliOptions } from "./providers/google-gemini-cli";
import type { GoogleVertexOptions } from "./providers/google-vertex";
import type { OllamaChatOptions } from "./providers/ollama";
import type { OpenAICodexResponsesOptions } from "./providers/openai-codex-responses";
import type { OpenAICompletionsOptions } from "./providers/openai-completions";
import type { OpenAIResponsesOptions } from "./providers/openai-responses";
import type { AssistantMessageEventStream } from "./utils/event-stream";
import type { FallbackAttemptToken, TransportFailureFacts } from "./utils/fallback-transport";

export type { AssistantMessageEventStream } from "./utils/event-stream";

export type KnownApi =
	| "openai-completions"
	| "openai-responses"
	| "openai-codex-responses"
	| "azure-openai-responses"
	| "anthropic-messages"
	| "bedrock-converse-stream"
	| "google-generative-ai"
	| "google-gemini-cli"
	| "google-vertex"
	| "ollama-chat"
	| "cursor-agent";
export type Api = KnownApi | (string & {});
export interface ApiOptionsMap {
	"anthropic-messages": AnthropicOptions;
	"bedrock-converse-stream": BedrockOptions;
	"openai-completions": OpenAICompletionsOptions;
	"openai-responses": OpenAIResponsesOptions;
	"openai-codex-responses": OpenAICodexResponsesOptions;
	"azure-openai-responses": AzureOpenAIResponsesOptions;
	"google-generative-ai": GoogleOptions;
	"google-gemini-cli": GoogleGeminiCliOptions;
	"google-vertex": GoogleVertexOptions;
	"ollama-chat": OllamaChatOptions;
	"cursor-agent": CursorOptions;
}
// Compile-time exhaustiveness check - this will fail if ApiOptionsMap doesn't have all KnownApi keys
type _CheckExhaustive =
	ApiOptionsMap extends Record<KnownApi, StreamOptions>
		? Record<KnownApi, StreamOptions> extends ApiOptionsMap
			? true
			: ["ApiOptionsMap is missing some KnownApi values", Exclude<KnownApi, keyof ApiOptionsMap>]
		: ["ApiOptionsMap doesn't extend Record<KnownApi, StreamOptions>"];
true satisfies _CheckExhaustive;
export type OptionsForApi<TApi extends Api> =
	| StreamOptions
	| (TApi extends keyof ApiOptionsMap ? ApiOptionsMap[TApi] : never);

/** Canonical thinking transport used by a model. */
export type ThinkingControlMode =
	| "effort"
	| "budget"
	| "google-level"
	| "anthropic-adaptive"
	| "anthropic-budget-effort";

/** Canonical runtime vocabulary for provider thinking transports. */
export const THINKING_CONTROL_MODES = [
	"effort",
	"budget",
	"google-level",
	"anthropic-adaptive",
	"anthropic-budget-effort",
] as const satisfies readonly ThinkingControlMode[];

type _CheckThinkingControlModes = [
	Exclude<ThinkingControlMode, (typeof THINKING_CONTROL_MODES)[number]>,
	Exclude<(typeof THINKING_CONTROL_MODES)[number], ThinkingControlMode>,
] extends [never, never]
	? true
	: false;
true satisfies _CheckThinkingControlModes;

/** Per-model thinking capabilities used to clamp and map user-facing effort levels. */
export interface ThinkingConfig {
	/** Least intensive supported user-facing effort level. */
	minLevel: Effort;
	/** Most intensive supported user-facing effort level. */
	maxLevel: Effort;
	/**
	 * Optional explicit list of supported levels. When present, takes precedence over
	 * the `minLevel`..`maxLevel` range — used to encode discrete sets with gaps
	 * (e.g. Gemini 3 Pro supports `low` and `high` but not `medium`).
	 */
	levels?: readonly Effort[];
	/** Optional default effort applied when this model is selected. Falls back to global default if absent. */
	defaultLevel?: Effort;
	/** Provider-specific transport used to encode the selected effort. */
	mode: ThinkingControlMode;
}

export type KnownProvider =
	| "alibaba-token-plan"
	| "amazon-bedrock"
	| "azure-openai"
	| "anthropic"
	| "google"
	| "google-gemini-cli"
	| "google-antigravity"
	| "google-vertex"
	| "openai"
	| "openai-codex"
	| "kimi-code"
	| "minimax-code"
	| "minimax-code-cn"
	| "github-copilot"
	| "fireworks"
	| "firepass"
	| "fugu"
	| "gitlab-duo"
	| "cursor"
	| "deepseek"
	| "deepinfra"
	| "xai"
	| "groq"
	| "cerebras"
	| "openrouter"
	| "kilo"
	| "vercel-ai-gateway"
	| "zai"
	| "glm-zcode"
	| "mistral"
	| "minimax"
	| "opencode-go"
	| "opencode-zen"
	| "synthetic"
	| "cloudflare-ai-gateway"
	| "huggingface"
	| "litellm"
	| "moonshot"
	| "nvidia"
	| "nanogpt"
	| "ollama"
	| "ollama-cloud"
	| "qianfan"
	| "qwen-portal"
	| "together"
	| "venice"
	| "vllm"
	| "xiaomi"
	| "xiaomi-token-plan-sgp"
	| "xiaomi-token-plan-ams"
	| "xiaomi-token-plan-cn"
	| "zenmux"
	| "lm-studio";
export type Provider = KnownProvider | string;

import type { Effort } from "./model-thinking";

/** Token budgets for each thinking level (token-based providers only) */
export type ThinkingBudgets = { [key in Effort]?: number };

export type MessageAttribution = "user" | "agent";

export type ToolChoice =
	| "auto"
	| "none"
	| "any"
	| "required"
	| { type: "function"; name: string }
	| { type: "function"; function: { name: string } }
	| { type: "tool"; name: string };

export type ToolChoiceSupport = "none" | "auto" | "required" | "named";
export type ToolChoiceSupportSource = "static" | "derived" | "runtime";

export interface ToolChoiceCompat {
	/** Maximum supported tool_choice level. */
	toolChoiceSupport?: ToolChoiceSupport;
	/** Legacy flag for accepting the tool_choice parameter. */
	supportsToolChoice?: boolean;
	/** Legacy flag for forced tool_choice support. */
	supportsForcedToolChoice?: boolean;
}

// Base options all providers share
export type CacheRetention = "none" | "short" | "long";

/**
 * Service tier hint for processing priority / cost control.
 *
 * The unscoped values (`"auto"`, `"default"`, `"flex"`, `"scale"`,
 * `"priority"`) are passed through to providers that understand them
 * (OpenAI and DeepInfra's `service_tier` field directly; Anthropic translates
 * `"priority"` into `speed: "fast"` on supported Opus models).
 *
 * The scoped values target a specific provider family and behave as the
 * unscoped value on the matching provider, or `undefined` everywhere else.
 * They let users opt into priority on one family without paying premium
 * costs on the other when switching models mid-session.
 *
 * - `"openai-only"` → `"priority"` on `openai` and `OpenAI code provider`; ignored elsewhere.
 * - `"Anthropic model-only"` → `"priority"` on direct `anthropic` (not Bedrock/Vertex Anthropic model).
 */
export type ServiceTier = "auto" | "default" | "flex" | "scale" | "priority" | "openai-only" | "claude-only";

/** Resolved tier — one of the values that providers actually consume on the wire. */
export type ResolvedServiceTier = Exclude<ServiceTier, "openai-only" | "claude-only">;

/**
 * Resolves a possibly scoped `ServiceTier` to the effective tier for the
 * given provider. Scoped values match their target family and otherwise
 * collapse to `undefined`; unscoped values pass through unchanged.
 */
export function resolveServiceTier(
	serviceTier: ServiceTier | null | undefined,
	provider: Provider | undefined,
): ResolvedServiceTier | undefined {
	if (!serviceTier) return undefined;
	switch (serviceTier) {
		case "openai-only":
			return provider === "openai" || provider === "openai-codex" ? "priority" : undefined;
		case "claude-only":
			return provider === "anthropic" ? "priority" : undefined;
		default:
			return serviceTier;
	}
}

/**
 * True when the (possibly scoped) tier should be sent as an OpenAI-compatible
 * `service_tier` request field for providers that support it. Unsupported tiers
 * (`"auto"`, `"default"`) and scope mismatches all return false.
 */
export function shouldSendServiceTier(
	serviceTier: ServiceTier | null | undefined,
	provider: Provider | undefined,
): boolean {
	const resolved = resolveServiceTier(serviceTier, provider);
	if (provider === "deepinfra") return resolved === "priority";
	if (provider !== "openai" && provider !== "openai-codex") return false;
	return resolved === "flex" || resolved === "scale" || resolved === "priority";
}

/**
 * Premium-request weight contributed by sending priority to a provider
 * that supports it. Mirrors GitHub Copilot's `premiumRequests` accounting
 * so the "premium requests" stat aggregates priority traffic across the
 * OpenAI family and Anthropic fast-mode realizations.
 *
 * Returns 1 per resolved priority request, 0 otherwise.
 */
export function getPriorityPremiumRequests(
	serviceTier: ServiceTier | null | undefined,
	provider: Provider | undefined,
): number {
	if (resolveServiceTier(serviceTier, provider) !== "priority") return 0;
	// Only providers that realize `priority` on the wire bill the user.
	// Everywhere else, the field is silently dropped and nothing is charged.
	return provider === "openai" || provider === "openai-codex" || provider === "anthropic" || provider === "deepinfra"
		? 1
		: 0;
}

export interface ProviderSessionState {
	close(): void;
}

export interface ProviderResponseMetadata {
	status: number;
	headers: Record<string, string>;
	requestId?: string | null;
	metadata?: Record<string, unknown>;
}

export interface RawSseEvent {
	event: string | null;
	data: string;
	raw: string[];
}

/**
 * `fetch`-compatible function. Accepts any callable matching the standard
 * fetch signature; `preconnect` is optional because non-Bun runtimes (browsers,
 * test mocks) won't expose it.
 */
export type FetchImpl = ((input: string | URL | Request, init?: RequestInit) => Promise<Response>) & {
	preconnect?: typeof globalThis.fetch.preconnect;
};

export interface StreamOptions {
	temperature?: number;
	topP?: number;
	topK?: number;
	minP?: number;
	presencePenalty?: number;
	repetitionPenalty?: number;
	/**
	 * Stop sequences. Anthropic encodes as `stop_sequences` (array, max 4);
	 * OpenAI chat-completions encodes as `stop` (string or array of up to 4);
	 * OpenAI Responses API has no `stop` field today (silently dropped by the
	 * provider when present).
	 */
	stopSequences?: string[];
	/**
	 * Frequency penalty (OpenAI). Penalizes new tokens based on existing frequency
	 * in the text so far. Range -2.0 to 2.0. Parallel to {@link presencePenalty}.
	 */
	frequencyPenalty?: number;
	maxTokens?: number;
	signal?: AbortSignal;
	apiKey?: string;
	/** Disables all transport-level replay; the fallback controller owns retries. */
	fallbackManaged?: boolean;
	/** Opaque token returned by beginAttempt for a managed transport invocation. */
	fallbackAttempt?: FallbackAttemptToken;
	/**
	 * Called when a provider returns 401 before any replay-unsafe assistant
	 * event has been emitted. Returning a different key retries the provider
	 * request once.
	 */
	onAuthError?: (provider: string, apiKey: string, error: unknown) => Promise<string | undefined>;
	cacheRetention?: CacheRetention;
	/**
	 * Additional headers to include in provider requests.
	 * These are merged on top of model-defined headers.
	 */
	headers?: Record<string, string>;
	/**
	 * Optional explicit request attribution override for providers that support it.
	 */
	initiatorOverride?: MessageAttribution;
	/**
	 * Maximum delay in milliseconds to wait for a retry when the server requests a long wait.
	 * If the server's requested delay exceeds this value, the request fails immediately
	 * with an error containing the requested delay, allowing higher-level retry logic
	 * to handle it with user visibility.
	 * Default: 60000 (60 seconds). Set to 0 to disable the cap.
	 */
	maxRetryDelayMs?: number;
	/**
	 * Maximum provider request retries for transports/SDKs that retry before a stream is established.
	 * Counts retries only, not the initial attempt. Providers keep their built-in default when unset.
	 */
	requestMaxRetries?: number;
	/**
	 * Maximum provider stream replay retries after a replay-safe transient stream failure.
	 * Counts retries only, not the initial stream attempt. Providers keep their built-in default when unset.
	 */
	streamMaxRetries?: number;
	/**
	 * Optional metadata to include in API requests.
	 * Providers extract the fields they understand and ignore the rest.
	 * For example, Anthropic uses `user_id` for abuse tracking and rate limiting.
	 */
	metadata?: Record<string, unknown>;
	/**
	 * Optional session identifier for providers that support session-based caching.
	 * Providers can use this to enable prompt caching, request routing, or other
	 * session-aware features. Ignored by providers that don't support it.
	 */
	sessionId?: string;
	/**
	 * Provider-scoped mutable state store for this agent session.
	 * Providers can use this to persist transport/session state between turns.
	 */
	providerSessionState?: Map<string, ProviderSessionState>;
	/**
	 * Optional callback for inspecting or replacing provider payloads before sending.
	 * Return undefined to keep the payload unchanged.
	 */
	onPayload?: (payload: unknown, model?: Model<Api>) => unknown | undefined | Promise<unknown | undefined>;
	/**
	 * Optional callback for provider response metadata after headers are received.
	 */
	onResponse?: (response: ProviderResponseMetadata, model?: Model<Api>) => void | Promise<void>;
	/**
	 * Optional callback for raw Server-Sent Events as they arrive from HTTP streaming providers.
	 *
	 * Diagnostic only: provider implementations must ignore callback failures and must not
	 * let observers alter stream contents.
	 */
	onSseEvent?: (event: RawSseEvent, model?: Model<Api>) => void;
	/**
	 * Optional override for the first streamed event watchdog in milliseconds.
	 * Set to 0 to disable the first-event watchdog for this request.
	 */
	streamFirstEventTimeoutMs?: number;
	/**
	 * Optional override for the maximum idle gap between streamed events in milliseconds.
	 * Set to 0 to disable the inter-event idle watchdog for this request.
	 */
	streamIdleTimeoutMs?: number;
	/**
	 * Optional retry delay hook for tests and transports that need custom scheduling.
	 */
	providerRetryWait?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
	/**
	 * Optional `fetch` implementation override. Providers route every HTTP
	 * request — direct calls, SDK clients, and retry helpers — through this
	 * implementation when set. Defaults to `globalThis.fetch`. Providers that
	 * do not use `fetch` (Bedrock's AWS SDK transport, Cursor's HTTP/2
	 * channel) silently ignore the override.
	 */
	fetch?: FetchImpl;
	/**
	 * Authentication credential type selected for this request.
	 * Providers use this only when endpoint routing differs between API-key and OAuth credentials.
	 */
	authCredentialType?: "api_key" | "oauth";
	/** Cursor exec/MCP tool handlers (cursor-agent only). */
	execHandlers?: CursorExecHandlers;
}

// Unified options with reasoning passed to streamSimple() and completeSimple()
export interface SimpleStreamOptions extends StreamOptions {
	reasoning?: Effort;
	/**
	 * Force-disable reasoning for the request even when the model supports it.
	 * Takes precedence over `reasoning`. Useful for fast utility calls
	 * (e.g. title generation) where the model would otherwise burn the entire
	 * output budget on internal thinking. Provider support is format-specific:
	 * some transports can disable reasoning directly, while generic
	 * effort-based OpenAI-compatible endpoints use the lowest supported effort.
	 */
	disableReasoning?: boolean;
	/**
	 * If true, request that the provider omit thinking/reasoning summaries
	 * from the response (e.g. Anthropic `thinking.display = "omitted"`,
	 * OpenAI Responses `reasoning.summary` left unset). The model still
	 * reasons internally; only the human-readable summary stream is dropped.
	 * Useful when the UI hides thinking blocks anyway and the summary is wasted bandwidth.
	 */
	hideThinkingSummary?: boolean;
	/** Custom token budgets for thinking levels (token-based providers only) */
	thinkingBudgets?: ThinkingBudgets;
	/** Cursor exec handlers for local tool execution */
	cursorExecHandlers?: CursorExecHandlers;
	/** Hook to handle tool results from Cursor exec */
	cursorOnToolResult?: CursorToolResultHandler;
	/** Optional tool choice override for compatible providers */
	toolChoice?: ToolChoice;
	/** OpenAI service tier for processing priority/cost control. Ignored by non-OpenAI providers. */
	serviceTier?: ServiceTier;
	/** API format for Kimi Code provider: "openai" or "anthropic" (default: "anthropic") */
	kimiApiFormat?: "openai" | "anthropic";
	/** API format for Synthetic provider: "openai" or "anthropic" (default: "openai") */
	syntheticApiFormat?: "openai" | "anthropic";
	/** Hint that websocket transport should be preferred when supported by the provider implementation. */
	preferWebsockets?: boolean;
}

// Generic StreamFunction with typed options
export type StreamFunction<TApi extends Api> = (
	model: Model<TApi>,
	context: Context,
	options: OptionsForApi<TApi>,
) => AssistantMessageEventStream;

export interface TextSignatureV1 {
	v: 1;
	id: string;
	phase?: "commentary" | "final_answer";
}

export interface TextContent {
	type: "text";
	text: string;
	textSignature?: string; // e.g., for OpenAI responses, message metadata (legacy id string or TextSignatureV1 JSON)
}

export interface ThinkingContent {
	type: "thinking";
	thinking: string;
	thinkingSignature?: string; // e.g., for OpenAI responses, the reasoning item ID
	itemId?: string; // item.id from output_item.added, used to match output_item.done
	readonly provenance?: "summary" | "raw" | "mixed";
	readonly summaryText?: string;
	readonly rawText?: string;
}

export interface RedactedThinkingContent {
	type: "redactedThinking";
	data: string;
}

export interface ImageContent {
	type: "image";
	data: string; // base64 encoded image data
	mimeType: string; // e.g., "image/jpeg", "image/png"
}

export interface ToolCall {
	type: "toolCall";
	id: string;
	name: string;
	arguments: Record<string, any>;
	thoughtSignature?: string; // Google-specific: opaque signature for reusing thought context
	intent?: string; // Harness-level intent metadata extracted from traced tool arguments
	/**
	 * Original wire-level name when the tool was invoked via OpenAI's custom-tool
	 * mechanism (e.g., `apply_patch`). Set by `openai-responses` on receive so
	 * the history-replay path can re-emit the call as `custom_tool_call` with
	 * its paired tool-result as `custom_tool_call_output`. Absent for regular
	 * JSON function tools.
	 */
	customWireName?: string;
	/**
	 * Set when the provider detected the argument JSON was truncated — the model
	 * hit its output-token limit (or the response was otherwise cut short) before
	 * emitting a complete arguments object. The `arguments` field then holds a
	 * best-effort partial parse and must not be executed as-is; the agent loop
	 * rejects the call with a retryable error instead.
	 */
	incompleteArguments?: boolean;
}

export interface Usage {
	/** Non-cached input tokens (matches the bucket the provider bills as new input). */
	input: number;
	/** Total output tokens for the turn, including thinking, assistant text, and tool-call argument tokens. */
	output: number;
	/** Tokens read from the prompt cache. */
	cacheRead: number;
	/** Tokens written to the prompt cache (cache creation). */
	cacheWrite: number;
	/** Sum of input + output + cacheRead + cacheWrite. */
	totalTokens: number;
	/** Copilot premium-request counter, when applicable. */
	premiumRequests?: number;
	/**
	 * Reasoning/thinking tokens included in `output`, when the provider reports them
	 * (OpenAI `output_tokens_details.reasoning_tokens`, Google `thoughtsTokenCount`).
	 * Always a subset of `output` — non-reasoning output is `output - reasoningTokens`.
	 *
	 * Providers that don't expose this leave it undefined rather than guessing;
	 * `undefined` means unknown, NOT zero.
	 */
	reasoningTokens?: number;
	/**
	 * Cache-write TTL breakdown (Anthropic only). When set, the components sum to
	 * `cacheWrite`. Absent providers do not populate this.
	 */
	cttl?: {
		ephemeral5m?: number;
		ephemeral1h?: number;
	};
	/**
	 * Server-side tool invocations made during this turn (Anthropic web_search /
	 * web_fetch, OpenAI built-in tools when reported). Counts requests, not tokens.
	 */
	server?: {
		webSearch?: number;
		webFetch?: number;
	};
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
}

export type StopReason = "stop" | "length" | "toolUse" | "error" | "aborted";
export type AssistantErrorKind = "provider_safety_stop";

export interface OpenAIResponsesHistoryPayload {
	type: "openaiResponsesHistory";
	provider?: string;
	dt?: boolean;
	items: Array<Record<string, unknown>>;
}

export type ProviderPayload = OpenAIResponsesHistoryPayload;

export interface UserMessage {
	role: "user";
	content: string | (TextContent | ImageContent)[];
	/** True if the message was injected by the system (e.g., auto-continue). */
	synthetic?: boolean;
	/** Who initiated this message for billing/attribution semantics. */
	attribution?: MessageAttribution;
	/** Provider-specific opaque payload used to reconstruct transport-native history. */
	providerPayload?: ProviderPayload;
	timestamp: number; // Unix timestamp in milliseconds
}

export interface DeveloperMessage {
	role: "developer";
	content: string | (TextContent | ImageContent)[];
	/** Who initiated this message for billing/attribution semantics. */
	attribution?: MessageAttribution;
	/** Provider-specific opaque payload used to reconstruct transport-native history. */
	providerPayload?: ProviderPayload;
	timestamp: number; // Unix timestamp in milliseconds
}

export interface AssistantMessage {
	role: "assistant";
	content: (TextContent | ThinkingContent | RedactedThinkingContent | ToolCall)[];
	api: Api;
	provider: Provider;
	model: string;
	responseId?: string; // Provider-specific response/message identifier when the upstream API exposes one
	usage: Usage;
	stopReason: StopReason;
	errorMessage?: string;
	errorKind?: AssistantErrorKind;
	/** HTTP status surfaced by the provider when the request failed. Populated by every provider's catch block alongside `errorMessage` so consumers (auth retry, telemetry, UI) can branch without regex-scraping the message. */
	errorStatus?: number;
	/** Typed upstream failure facts retained for retry classification without parsing errorMessage. */
	transportFailure?: TransportFailureFacts;
	/**
	 * Stable identifiers for request features the provider silently dropped
	 * during this turn (e.g. `"priority"`). Set when a server-side rejection
	 * triggered an in-provider fallback retry that succeeded without the
	 * feature. Callers can use this to sync user-facing toggles back to the
	 * server's actual state.
	 */
	disabledFeatures?: string[];
	/** Provider-specific opaque payload used to reconstruct transport-native history. */
	providerPayload?: ProviderPayload;
	timestamp: number; // Unix timestamp in milliseconds
	duration?: number; // Request duration in milliseconds
	ttft?: number; // Time to first token in milliseconds
}

export interface ToolResultMessage<TDetails = any> {
	role: "toolResult";
	toolCallId: string;
	toolName: string;
	content: (TextContent | ImageContent)[]; // Supports text and images
	details?: TDetails;
	isError: boolean;
	/** Who initiated this message for billing/attribution semantics. */
	attribution?: MessageAttribution;
	/** Timestamp when output was pruned (ms since epoch). Undefined if unpruned. */
	prunedAt?: number;
	timestamp: number; // Unix timestamp in milliseconds
}

export type Message = UserMessage | DeveloperMessage | AssistantMessage | ToolResultMessage;

export type CursorExecHandlerResult<T> = { result: T; toolResult?: ToolResultMessage } | T | ToolResultMessage;

export type CursorToolResultHandler = (
	result: ToolResultMessage,
) => ToolResultMessage | undefined | Promise<ToolResultMessage | undefined>;

export interface CursorMcpCall {
	name: string;
	providerIdentifier: string;
	toolName: string;
	toolCallId: string;
	args: Record<string, unknown>;
	rawArgs: Record<string, Uint8Array>;
}

export interface CursorShellStreamCallbacks {
	onStdout(data: string): void;
	onStderr(data: string): void;
}

export interface CursorExecHandlers {
	read?: (args: ReadArgs) => Promise<CursorExecHandlerResult<ReadResult>>;
	ls?: (args: LsArgs) => Promise<CursorExecHandlerResult<LsResult>>;
	grep?: (args: GrepArgs) => Promise<CursorExecHandlerResult<GrepResult>>;
	write?: (args: WriteArgs) => Promise<CursorExecHandlerResult<WriteResult>>;
	delete?: (args: DeleteArgs) => Promise<CursorExecHandlerResult<DeleteResult>>;
	shell?: (args: ShellArgs) => Promise<CursorExecHandlerResult<ShellResult>>;
	shellStream?: (
		args: ShellArgs,
		callbacks: CursorShellStreamCallbacks,
	) => Promise<CursorExecHandlerResult<ShellResult>>;
	diagnostics?: (args: DiagnosticsArgs) => Promise<CursorExecHandlerResult<DiagnosticsResult>>;
	mcp?: (call: CursorMcpCall) => Promise<CursorExecHandlerResult<McpResult>>;
	onToolResult?: CursorToolResultHandler;
}

/**
 * Plain JSON Schema document used by extension-authored tools (legacy TypeBox
 * emits this shape). Distinguished from Zod at runtime via {@link isZodSchema}.
 */
export type TJsonSchema = Record<string, unknown>;

/**
 * Schema type accepted by the {@link Tool} interface.
 *
 * Canonical authoring uses Zod. Extension compat may supply a JSON Schema
 * object (including TypeBox static schema objects).
 */
export type TSchema = ZodType | TJsonSchema;

/** Resolve parameter types for tool execution / handlers. */
export type Static<S> = S extends ZodType ? z.infer<S> : S extends { static: infer T } ? T : unknown;

export type RawArgumentRejectionCode =
	| "ask-intent-review-requires-positive-round"
	| "ask-intent-contract-requires-non-empty-authority";

export type RawArgumentValidationResult =
	| { outcome: "passthrough" }
	| { outcome: "accept"; arguments: ToolCall["arguments"] }
	| { outcome: "reject"; code?: RawArgumentRejectionCode };

export interface Tool<TParameters extends TSchema = TSchema> {
	name: string;
	description: string;
	parameters: TParameters;
	/** Optional pre-coercion adapter for narrowly scoped raw argument recovery or rejection. */
	rawArgumentValidation?: (arguments_: ToolCall["arguments"]) => RawArgumentValidationResult;
	/** If true, tool is strictly typed and validated against the parameters schema before execution */
	strict?: boolean;
	/**
	 * Optional grammar constraint for OpenAI custom-tool emission.
	 * When set, providers that support grammar-constrained tools (currently only
	 * `openai-responses` against models with the right capability flag) may emit
	 * this tool as `{type: "custom", format: {type: "grammar", …}}` instead of a
	 * JSON function tool. Other providers ignore the field.
	 */
	customFormat?: { syntax: "lark" | "regex"; definition: string };
	/**
	 * Optional wire-level name used when this tool is emitted as a custom tool
	 * (e.g. OpenAI's `{type: "custom"}` shape). Models trained on specific tool
	 * names — like GPT-5 on `apply_patch` — need to see that exact name on the
	 * wire, but it may differ from the harness-internal `name`. The agent-loop
	 * dispatcher matches both `name` and `customWireName` so returned tool
	 * calls route correctly. Absent for regular JSON function tools.
	 */
	customWireName?: string;
	/**
	 * Optional safe projection for tool arguments or results. Extensions use this
	 * only for explicitly opt-in, display-safe summaries.
	 */
	safeSummary?: (kind: "args" | "result", value: unknown) => string | undefined;
	/** Allowlisted argument/result field names for a safe fallback summary. */
	safeSummaryFields?: { args?: string[]; result?: string[] };
}

export interface Context {
	systemPrompt?: string[];
	messages: Message[];
	tools?: Tool[];
}

export type AssistantMessageEvent =
	| { type: "start"; contentIndex?: undefined; partial: AssistantMessage }
	| { type: "text_start"; contentIndex: number; partial: AssistantMessage }
	| { type: "text_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
	| { type: "text_end"; contentIndex: number; content: string; partial: AssistantMessage }
	| { type: "thinking_start"; contentIndex: number; partial: AssistantMessage }
	| { type: "thinking_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
	| { type: "thinking_end"; contentIndex: number; content: string; partial: AssistantMessage }
	| { type: "reasoning_summary_start"; contentIndex: number; partial: AssistantMessage }
	| { type: "reasoning_summary_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
	| { type: "reasoning_summary_end"; contentIndex: number; content: string; partial: AssistantMessage }
	| { type: "toolcall_start"; contentIndex: number; partial: AssistantMessage }
	| { type: "toolcall_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
	| { type: "toolcall_end"; contentIndex: number; toolCall: ToolCall; partial: AssistantMessage }
	| {
			type: "done";
			contentIndex?: undefined;
			reason: Extract<StopReason, "stop" | "length" | "toolUse">;
			message: AssistantMessage;
	  }
	| {
			type: "error";
			contentIndex?: undefined;
			reason: Extract<StopReason, "aborted" | "error">;
			error: AssistantMessage;
	  }
	| {
			type: "toolChoiceIncapability";
			contentIndex?: undefined;
			api: string;
			provider: string;
			model: string;
			requestedLevel: ToolChoiceSupport;
			resolvedLevel: ToolChoiceSupport;
			reason: string;
			registryKey: string;
	  };

/**
 * Compatibility settings for openai-completions API.
 * Use this to override URL-based auto-detection for custom providers.
 */
export interface OpenAICompat extends ToolChoiceCompat {
	/** Whether the provider supports the `store` field. Default: auto-detected from URL. */
	supportsStore?: boolean;
	/** Whether the provider supports the `developer` role (vs `system`). Default: auto-detected from URL. */
	supportsDeveloperRole?: boolean;
	/**
	 * Whether to forward the agent session id as vendor-neutral session-identity
	 * headers (`session_id`, `x-session-id`) on every chat-completions request.
	 * Off by default. Opt in for OpenAI-compatible proxies/relays that route on
	 * session affinity or reuse a server-side prompt cache keyed by session.
	 * First-party OpenAI does not need this (it has its own gated injection in
	 * the openai-responses provider). Headers are only added when a non-empty
	 * session id is available and are never allowed to overwrite a header the
	 * caller already set via `headers`/`requestTransform`.
	 */
	sendSessionHeaders?: boolean;
	/**
	 * Whether the provider's chat-completions endpoint accepts multiple
	 * leading `system`/`developer` messages. When false, ordered system
	 * prompts are coalesced into a single message joined by `\n\n` so
	 * strict chat templates (e.g. Qwen-served via vLLM, MiniMax) accept
	 * the request. Default: detected per provider/baseUrl. Canonical
	 * OpenAI/Azure/OpenRouter/Cerebras/Together/Fireworks/Groq/DeepSeek/
	 * Mistral/xAI/Z.ai/GitHub Copilot/Zenmux are treated as `true`;
	 * unknown or strict-template hosts default to `false`. Setting this
	 * to `true` preserves separate blocks, which is preferred for
	 * KV-cache reuse when the trailing prompt changes between calls.
	 */
	supportsMultipleSystemMessages?: boolean;
	/** Whether the provider supports `reasoning_effort`. Default: auto-detected from URL. */
	supportsReasoningEffort?: boolean;
	/** Optional mapping from pi-ai reasoning levels to provider/model-specific `reasoning_effort` values. */
	reasoningEffortMap?: Partial<Record<Effort, string>>;
	/** Whether the provider supports `stream_options: { include_usage: true }` for token usage in streaming responses. Default: true. */
	supportsUsageInStreaming?: boolean;
	/** Which field to use for max tokens. Default: auto-detected from URL. */
	maxTokensField?: "max_completion_tokens" | "max_tokens";
	/** Whether tool results require the `name` field. Default: auto-detected from URL. */
	requiresToolResultName?: boolean;
	/** Whether a user message after tool results requires an assistant message in between. Default: auto-detected from URL. */
	requiresAssistantAfterToolResult?: boolean;
	/** Whether thinking blocks must be converted to text blocks with <thinking> delimiters. Default: auto-detected from URL. */
	requiresThinkingAsText?: boolean;
	/** Whether tool call IDs must be normalized to Mistral format (exactly 9 alphanumeric chars). Default: auto-detected from URL. */
	requiresMistralToolIds?: boolean;
	/** Format for reasoning/thinking parameter. "openai" uses reasoning_effort, "openrouter" uses reasoning: { effort }, "zai" uses thinking: { type: "enabled" | "disabled" } (also used by Moonshot Kimi), "qwen" uses top-level enable_thinking, and "qwen-chat-template" uses chat_template_kwargs.enable_thinking. Default: "openai". */
	thinkingFormat?: "openai" | "openrouter" | "zai" | "qwen" | "qwen-chat-template";
	/** Which reasoning content field to emit on assistant messages. Default: auto-detected. */
	reasoningContentField?: "reasoning_content" | "reasoning" | "reasoning_text";
	/** Whether assistant tool-call messages must include reasoning content. Default: false. */
	requiresReasoningContentForToolCalls?: boolean;
	/** Whether the provider accepts a synthetic placeholder (e.g. ".") for missing reasoning_content on tool-call turns. Default: true. Set to false for providers like DeepSeek that validate the exact reasoning_content value. */
	allowsSyntheticReasoningContentForToolCalls?: boolean;
	/** Whether assistant tool-call messages must include non-empty content. Default: false. */
	requiresAssistantContentForToolCalls?: boolean;
	/** Whether the provider supports the `tool_choice` parameter. Default: true. */
	supportsToolChoice?: boolean;
	/** Whether `tool_choice` may force a tool (`required` / named tool). Default: true. */
	supportsForcedToolChoice?: boolean;
	/**
	 * Drop reasoning fields (`reasoning_effort`, OpenRouter `reasoning`) for
	 * the request when `tool_choice` forces a tool call. Mirrors the Anthropic
	 * `disableThinkingIfToolChoiceForced` rule for backends like Kimi that
	 * 400 with `tool_choice 'specified' is incompatible with thinking
	 * enabled` whenever both are present. Default: auto-detected (Kimi).
	 */
	disableReasoningOnForcedToolChoice?: boolean;
	/**
	 * Drop reasoning fields (`reasoning_effort`, OpenRouter `reasoning`) for
	 * any request that sends `tool_choice`. Use for providers/models that accept
	 * tools and `tool_choice`, but reject `tool_choice` while thinking is enabled.
	 * Default: auto-detected (DeepSeek reasoning models).
	 */
	disableReasoningOnToolChoice?: boolean;
	/** OpenRouter-specific routing preferences. Only used when baseUrl points to OpenRouter. */
	openRouterRouting?: OpenRouterRouting;
	/** Vercel AI Gateway routing preferences. Only used when baseUrl points to Vercel AI Gateway. */
	vercelGatewayRouting?: VercelGatewayRouting;
	/** Extra fields to include in request body (e.g. gateway routing hints for OpenClaw-style proxies). */
	extraBody?: Record<string, unknown>;
	/** Whether the provider supports the `strict` field in tool definitions. Default: auto-detected per provider/baseUrl (conservative for unknown providers). */
	supportsStrictMode?: boolean;
	/** Whether tool schemas must be sent either all strict or all non-strict. Undefined keeps the existing per-tool mixed behavior. */
	toolStrictMode?: "all_strict" | "none";
}

/**
 * Compatibility settings for anthropic-messages API.
 * Use this to disable features that strict-by-default Anthropic accepts but
 * that proxy gateways (Vertex AI, AWS Bedrock-style fronts, etc.) reject.
 */
export interface AnthropicCompat extends ToolChoiceCompat {
	/**
	 * Drop the top-level `strict: true` field on tool definitions. Vertex AI's
	 * Anthropic-compatible endpoint rejects unknown tool fields with
	 * `tools.<n>.custom.strict: Extra inputs are not permitted`.
	 */
	disableStrictTools?: boolean;
	/**
	 * Map adaptive thinking (`thinking: { type: "adaptive" }`) to
	 * `{ type: "enabled", budget_tokens }`. Vertex AI rejects the `adaptive`
	 * tag with `Input tag 'adaptive' ... does not match any of the expected
	 * tags: 'disabled', 'enabled'`.
	 */
	disableAdaptiveThinking?: boolean;
	/** Whether tools may include Anthropic's per-tool eager_input_streaming flag. Default: true. */
	supportsEagerToolInputStreaming?: boolean;
	/** Whether the provider accepts the `tool_choice` parameter at all. Default: true. */
	supportsToolChoice?: boolean;
	/** Whether `tool_choice` may force a tool (`any` / named `tool`). Default: true except known incompatible Anthropic models. */
	supportsForcedToolChoice?: boolean;
	/** Whether long prompt-cache retention (`ttl: "1h"`) is supported. Default: true for canonical Anthropic API. */
	supportsLongCacheRetention?: boolean;
	/**
	 * Prompt-cache transport accepted by this Anthropic-compatible endpoint.
	 * Canonical Anthropic defaults to `"automatic"`; noncanonical endpoints default
	 * to `"none"` and must explicitly opt into generated `"explicit"` markers.
	 */
	promptCacheMode?: "none" | "explicit" | "automatic";
}

/**
 * OpenRouter provider routing preferences.
 * Controls which upstream providers OpenRouter routes requests to.
 * @see https://openrouter.ai/docs/provider-routing
 */
export interface OpenRouterRouting {
	/** List of provider slugs to exclusively use for this request (e.g., ["amazon-bedrock", "anthropic"]). */
	only?: string[];
	/** List of provider slugs to try in order (e.g., ["anthropic", "openai"]). */
	order?: string[];
}

/**
 * Vercel AI Gateway routing preferences.
 * Controls which upstream providers the gateway routes requests to.
 * @see https://vercel.com/docs/ai-gateway/models-and-providers/provider-options
 */
export interface VercelGatewayRouting {
	/** List of provider slugs to exclusively use for this request (e.g., ["bedrock", "anthropic"]). */
	only?: string[];
	/** List of provider slugs to try in order (e.g., ["anthropic", "openai"]). */
	order?: string[];
}

// Model interface for the unified model system

export interface ModelRequestTransform {
	/** Named request-shaping preset. `openai-proxy` removes OpenAI SDK telemetry headers and uses a generic Gajae-Code User-Agent. */
	profile?: "openai-proxy";
	/** Header names to remove from the final outbound request. Case-insensitive. */
	stripHeaders?: string[];
	/** Headers to set after stripping; use null to remove a header explicitly. */
	setHeaders?: Record<string, string | null>;
	/** Extra request body fields merged after provider defaults; protected core request keys are ignored. */
	extraBody?: Record<string, unknown>;
}

export interface Model<TApi extends Api = any> {
	id: string;
	name: string;
	api: TApi;
	provider: Provider;
	baseUrl: string;
	reasoning: boolean;
	input: ("text" | "image")[];
	/**
	 * Output modalities the model can produce. Defaults to text-only when
	 * unset. A model that lists `"image"` advertises image-generation support
	 * (e.g. an OpenAI-compatible `gpt-image` model behind a proxy), which the
	 * `generate_image` tool uses to route requests without first-party
	 * provider/id heuristics.
	 */
	output?: ("text" | "image")[];
	cost: {
		input: number; // $/million tokens
		output: number; // $/million tokens
		cacheRead: number; // $/million tokens
		cacheWrite: number; // $/million tokens
	};
	/** Premium Copilot requests charged per user-initiated request (defaults to 1). */
	premiumMultiplier?: number;
	contextWindow: number;
	maxTokens: number;
	headers?: Record<string, string>;
	/**
	 * Streaming transport override. When `"pi-native"`, `streamSimple` routes
	 * the request to the model's `baseUrl` via the auth-gateway's
	 * `POST /v1/pi/stream` endpoint instead of dispatching the per-API
	 * provider client. The `baseUrl` must point at an `gjc auth-gateway`
	 * (or compatible) host; `headers.Authorization` (or `apiKey` resolved by
	 * the registry) carries the gateway bearer.
	 *
	 * Used by containerized GJC installs to route every LLM call through a
	 * sidecar gateway that holds the real provider credentials. The model's other
	 * metadata (pricing, context window, thinking config, …) still resolves locally; only the streaming
	 * dispatch is redirected.
	 */
	transport?: "pi-native";
	/** Hint that websocket transport should be preferred when supported by the provider implementation. */
	preferWebsockets?: boolean;
	/** Preferred model to switch to when context promotion is triggered (model id or provider/id). */
	contextPromotionTarget?: string;
	/** Provider-facing model id when it differs from the local selector id. */
	wireModelId?: string;
	/** Declarative request shaping for OpenAI-compatible proxy providers. */
	requestTransform?: ModelRequestTransform;
	/** Default prompt-cache retention preference for this model when the request omits one. */
	cacheRetention?: CacheRetention;
	/** Provider-assigned priority value (lower = higher priority). */
	priority?: number;
	/** Canonical thinking capability metadata for this model. */
	thinking?: ThinkingConfig;
	/** Compatibility overrides per API. If not set, auto-detected from baseUrl. */
	compat?: TApi extends "openai-completions" | "openai-responses"
		? OpenAICompat
		: TApi extends "anthropic-messages"
			? AnthropicCompat
			: TApi extends
						| "bedrock-converse-stream"
						| "google-generative-ai"
						| "google-gemini-cli"
						| "google-vertex"
						| "ollama-chat"
						| "azure-openai-responses"
						| "openai-codex-responses"
				? ToolChoiceCompat
				: never;
	/**
	 * Which shape to use when exposing the OpenAI code backend `apply_patch` tool to this model.
	 * Generated catalog policy sets `"freeform"` for first-party GPT-5 Responses
	 * models that support OpenAI custom tools with a Lark grammar. The freeform
	 * variant sends a raw patch string with no JSON envelope.
	 * - `"function"` or undefined: JSON function-tool with `{input: string}` (spec §1.2).
	 */
	applyPatchToolType?: "freeform" | "function";
	/**
	 * Force OAuth-style request shaping for providers whose API key prefix doesn't
	 * match an OAuth token (e.g. routing Anthropic traffic through a proxy that
	 * expects Anthropic Code framing). When true, the streaming layer sets
	 * `options.isOAuth = true` for the underlying provider call.
	 */
	isOAuth?: boolean;
}
