/**
 * Lazy provider module loading.
 *
 * Each provider module is loaded only when its stream function is first called.
 * This avoids eagerly importing heavy SDK dependencies (e.g., @anthropic-ai/sdk,
 * openai) at startup. The loaded module promise is cached so subsequent calls
 * reuse the same import.
 *
 * stream.ts imports its provider stream functions from this module (see the
 * lazy wrappers below), so this file IS the main streaming path's provider
 * loader: heavy SDKs stay out of the CLI startup parse graph.
 */

import type {
	Api,
	AssistantMessage,
	AssistantMessageEvent,
	AssistantMessageEventStream,
	Context,
	Model,
	OptionsForApi,
} from "../types";
import { type AbortSourceTracker, createAbortSourceTracker } from "../utils/abort";
import { AssistantMessageEventStream as EventStreamImpl } from "../utils/event-stream";
import { transportFailureFacts } from "../utils/fallback-transport";
import {
	FirstEventTimeoutError,
	getProviderFirstEventTimeoutFallbackMs,
	getStreamFirstEventTimeoutMs,
	getStreamIdleTimeoutMs,
	iterateWithIdleTimeout,
} from "../utils/idle-iterator";
import type { BedrockOptions } from "./amazon-bedrock";
import type { AnthropicOptions } from "./anthropic";
import type { AzureOpenAIResponsesOptions } from "./azure-openai-responses";
import type { CursorOptions } from "./cursor";
import type { GoogleOptions } from "./google";
import type { GoogleGeminiCliOptions } from "./google-gemini-cli";
import type { GoogleVertexOptions } from "./google-vertex";
import type { KiroCodeWhispererOptions } from "./kiro-codewhisperer";
import type { OllamaChatOptions } from "./ollama";
import type { OpenAICodexResponsesOptions } from "./openai-codex-responses";
import type { OpenAICompletionsOptions } from "./openai-completions";
import type { OpenAIResponsesOptions } from "./openai-responses";

// ---------------------------------------------------------------------------
// Lazy provider module shape
// ---------------------------------------------------------------------------

interface LazyProviderModule<TApi extends Api> {
	stream: (model: Model<TApi>, context: Context, options: OptionsForApi<TApi>) => AsyncIterable<AssistantMessageEvent>;
}

/**
 * Lazy runtime descriptor for a built-in provider implementation.
 *
 * The registry stores descriptors with an erased module type because each
 * provider's stream options are intentionally different. Callers narrow the
 * loaded module at the single API dispatch boundary instead of forcing
 * distributive variance through the collection type.
 */
export interface ProviderRuntimeDescriptor<TApi extends Api = Api, TModule = unknown> {
	readonly api: TApi;
	readonly load: () => Promise<TModule>;
}

type ErasedProviderRuntimeDescriptor = ProviderRuntimeDescriptor<Api, any>;

interface AnthropicProviderModule {
	streamAnthropic: (
		model: Model<"anthropic-messages">,
		context: Context,
		options: AnthropicOptions,
	) => AssistantMessageEventStream;
}

interface AzureOpenAIResponsesProviderModule {
	streamAzureOpenAIResponses: (
		model: Model<"azure-openai-responses">,
		context: Context,
		options: AzureOpenAIResponsesOptions,
	) => AssistantMessageEventStream;
}

interface GoogleProviderModule {
	streamGoogle: (
		model: Model<"google-generative-ai">,
		context: Context,
		options: GoogleOptions,
	) => AssistantMessageEventStream;
}

interface GoogleGeminiCliProviderModule {
	streamGoogleGeminiCli: (
		model: Model<"google-gemini-cli">,
		context: Context,
		options: GoogleGeminiCliOptions,
	) => AssistantMessageEventStream;
}

interface GoogleVertexProviderModule {
	streamGoogleVertex: (
		model: Model<"google-vertex">,
		context: Context,
		options: GoogleVertexOptions,
	) => AssistantMessageEventStream;
}

interface OpenAICodexResponsesProviderModule {
	streamOpenAICodexResponses: (
		model: Model<"openai-codex-responses">,
		context: Context,
		options: OpenAICodexResponsesOptions,
	) => AssistantMessageEventStream;
}

interface OpenAICompletionsProviderModule {
	streamOpenAICompletions: (
		model: Model<"openai-completions">,
		context: Context,
		options: OpenAICompletionsOptions,
	) => AssistantMessageEventStream;
}

interface OpenAIResponsesProviderModule {
	streamOpenAIResponses: (
		model: Model<"openai-responses">,
		context: Context,
		options: OpenAIResponsesOptions,
	) => AssistantMessageEventStream;
}

interface OllamaProviderModule {
	streamOllama: (
		model: Model<"ollama-chat">,
		context: Context,
		options: OllamaChatOptions,
	) => AssistantMessageEventStream;
}

interface CursorProviderModule {
	streamCursor: (
		model: Model<"cursor-agent">,
		context: Context,
		options: CursorOptions,
	) => AssistantMessageEventStream;
}

interface BedrockProviderModule {
	streamBedrock: (
		model: Model<"bedrock-converse-stream">,
		context: Context,
		options: BedrockOptions,
	) => AssistantMessageEventStream;
}

interface KiroCodeWhispererProviderModule {
	streamKiroCodeWhisperer: (
		model: Model<"kiro-codewhisperer-stream">,
		context: Context,
		options: KiroCodeWhispererOptions,
	) => AssistantMessageEventStream;
}

// ---------------------------------------------------------------------------
// Module-level lazy promise caches
// ---------------------------------------------------------------------------

let anthropicProviderModulePromise: Promise<LazyProviderModule<"anthropic-messages">> | undefined;
let azureOpenAIResponsesProviderModulePromise: Promise<LazyProviderModule<"azure-openai-responses">> | undefined;
let googleProviderModulePromise: Promise<LazyProviderModule<"google-generative-ai">> | undefined;
let googleGeminiCliProviderModulePromise: Promise<LazyProviderModule<"google-gemini-cli">> | undefined;
let googleVertexProviderModulePromise: Promise<LazyProviderModule<"google-vertex">> | undefined;
let openAICodexResponsesProviderModulePromise: Promise<LazyProviderModule<"openai-codex-responses">> | undefined;
let openAICompletionsProviderModulePromise: Promise<LazyProviderModule<"openai-completions">> | undefined;
let openAIResponsesProviderModulePromise: Promise<LazyProviderModule<"openai-responses">> | undefined;
let ollamaProviderModulePromise: Promise<LazyProviderModule<"ollama-chat">> | undefined;
let cursorProviderModulePromise: Promise<LazyProviderModule<"cursor-agent">> | undefined;
let bedrockProviderModuleOverride: LazyProviderModule<"bedrock-converse-stream"> | undefined;
let kiroCodeWhispererProviderModulePromise: Promise<LazyProviderModule<"kiro-codewhisperer-stream">> | undefined;
let bedrockProviderModulePromise: Promise<LazyProviderModule<"bedrock-converse-stream">> | undefined;

export function setBedrockProviderModule(module: BedrockProviderModule): void {
	bedrockProviderModuleOverride = {
		stream: module.streamBedrock,
	};
}

// ---------------------------------------------------------------------------
// Stream forwarding / error helpers
// ---------------------------------------------------------------------------

const LAZY_STREAM_IDLE_TIMEOUT_ERROR = "Provider stream stalled while waiting for the next event";
const LAZY_STREAM_FIRST_EVENT_TIMEOUT_ERROR = "Provider stream timed out while waiting for the first event";
const LAZY_STREAM_NON_PROGRESS_EVENT_TYPES = new Set(["start", "toolChoiceIncapability"]);

function hasFinalResult(
	source: AsyncIterable<AssistantMessageEvent>,
): source is AsyncIterable<AssistantMessageEvent> & { result(): Promise<AssistantMessage> } {
	return typeof (source as { result?: unknown }).result === "function";
}

/**
 * Per-provider default overrides for the lazy stream watchdogs. These widen the
 * floor used when neither caller option nor env var pins a value. The env vars
 * (`PI_STREAM_FIRST_EVENT_TIMEOUT_MS`, `PI_STREAM_IDLE_TIMEOUT_MS`) still take
 * precedence; `StreamOptions.streamFirstEventTimeoutMs` / `streamIdleTimeoutMs`
 * still trump everything.
 */
interface LazyStreamLimits {
	defaultFirstEventTimeoutMs?: number;
	defaultIdleTimeoutMs?: number;
	/** The provider already watches raw transport events, which this normalized wrapper cannot observe. */
	providerOwnsWatchdog?: boolean;
}

const PROVIDER_OWNED_STREAM_WATCHDOG: LazyStreamLimits = {
	providerOwnsWatchdog: true,
};

/**
 * Cloud Code Assist (google-gemini-cli / google-antigravity) routinely takes
 * longer than the global 100s default to emit its first SSE event when serving
 * the heavier Gemini 3.x Pro tiers at high thinking levels. Bump the first-event
 * floor to five minutes so duke et al. stop seeing spurious "stream timed out
 * while waiting for the first event" aborts on legitimate cold reasoning starts.
 * The steady-state idle watchdog stays on the global default since the upstream
 * emits thinking tokens frequently once it gets going.
 */
const GOOGLE_GEMINI_CLI_LAZY_STREAM_LIMITS: LazyStreamLimits = {
	defaultFirstEventTimeoutMs: 300_000,
};

/**
 * Resolves the first-event timeout fallback for the outer lazy-stream watchdog.
 * A configured wrapper-specific fallback (from `LazyStreamLimits`) always wins;
 * otherwise providers known to have slow first events use the same centralized
 * fallback as their inner provider-level watchdog. Returns `undefined` for
 * providers that should use the shared default.
 */
export function resolveLazyStreamFirstEventFallbackMs(
	provider: string,
	configuredFallbackMs?: number,
): number | undefined {
	if (configuredFallbackMs !== undefined) return configuredFallbackMs;
	return getProviderFirstEventTimeoutFallbackMs(provider);
}

function forwardStream<TApi extends Api>(
	target: EventStreamImpl,
	source: AsyncIterable<AssistantMessageEvent>,
	model: Model<TApi>,
	options: OptionsForApi<TApi>,
	abortTracker: AbortSourceTracker,
	onStreamCreated?: () => void,
	limits?: LazyStreamLimits,
): void {
	(async () => {
		try {
			let admitted = false;
			const markAdmission = (): void => {
				if (admitted) return;
				admitted = true;
				onStreamCreated?.();
			};
			let watchedSource = source;
			if (!limits?.providerOwnsWatchdog) {
				const idleTimeoutMs = options.streamIdleTimeoutMs ?? getStreamIdleTimeoutMs(limits?.defaultIdleTimeoutMs);
				const firstEventFallbackMs = resolveLazyStreamFirstEventFallbackMs(
					model.provider,
					limits?.defaultFirstEventTimeoutMs,
				);
				watchedSource = iterateWithIdleTimeout(source, {
					idleTimeoutMs,
					firstItemTimeoutMs:
						options.streamFirstEventTimeoutMs ??
						getStreamFirstEventTimeoutMs(idleTimeoutMs, firstEventFallbackMs),
					errorMessage: LAZY_STREAM_IDLE_TIMEOUT_ERROR,
					firstItemErrorMessage: LAZY_STREAM_FIRST_EVENT_TIMEOUT_ERROR,
					onIdle: () => abortTracker.abortLocally(new Error(LAZY_STREAM_IDLE_TIMEOUT_ERROR)),
					onFirstItemTimeout: () =>
						abortTracker.abortLocally(new FirstEventTimeoutError(LAZY_STREAM_FIRST_EVENT_TIMEOUT_ERROR)),
					abortSignal: options.signal,
					// Synthetic starts and tool-capability negotiation are control-plane events,
					// not model progress. Keep the first-event window active until assistant output
					// arrives instead of switching early to the shorter idle timeout.
					isProgressItem: event => {
						if (!event || typeof event !== "object") return true;
						const eventType = (event as { type?: unknown }).type;
						return typeof eventType !== "string" || !LAZY_STREAM_NON_PROGRESS_EVENT_TYPES.has(eventType);
					},
				});
			}

			for await (const event of watchedSource) {
				if (event.type !== "start") markAdmission();
				target.push(event);
			}
			if (hasFinalResult(source)) {
				target.end(await source.result());
			} else {
				target.end();
			}
		} catch (error) {
			const stopReason = abortTracker.wasCallerAbort() ? "aborted" : "error";
			const message = createLazyLoadErrorMessage(model, error, stopReason);
			target.push({ type: "error", reason: stopReason, error: message });
			target.end(message);
		}
	})();
}

function createLazyLoadErrorMessage<TApi extends Api>(
	model: Model<TApi>,
	error: unknown,
	stopReason: Extract<AssistantMessage["stopReason"], "aborted" | "error"> = "error",
): AssistantMessage {
	const transportFailure = transportFailureFacts(error);
	return {
		role: "assistant",
		content: [],
		api: model.api,
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
		stopReason,
		errorMessage:
			stopReason === "aborted" ? "Request was aborted" : error instanceof Error ? error.message : String(error),
		...(transportFailure ? { transportFailure } : {}),
		timestamp: Date.now(),
	};
}

// ---------------------------------------------------------------------------
// Generic lazy stream factory
// ---------------------------------------------------------------------------

function createLazyStream<TApi extends Api>(
	loadModule: () => Promise<LazyProviderModule<TApi>>,
	limits?: LazyStreamLimits,
): (
	model: Model<TApi>,
	context: Context,
	options: OptionsForApi<TApi>,
	onStreamCreated?: () => void,
) => EventStreamImpl {
	return (model, context, options, onStreamCreated) => {
		let abortTracker: AbortSourceTracker | undefined;
		const outer = new EventStreamImpl(() =>
			abortTracker?.abortLocally(new Error("Provider stream consumer stopped before completion")),
		);
		const streamOptions = (options ?? {}) as OptionsForApi<TApi>;

		loadModule()
			.then(module => {
				abortTracker = createAbortSourceTracker(streamOptions.signal);
				const providerOptions = { ...streamOptions, signal: abortTracker.requestSignal } as OptionsForApi<TApi>;
				const inner = module.stream(model, context, providerOptions);
				forwardStream(outer, inner, model, streamOptions, abortTracker, onStreamCreated, limits);
			})
			.catch(error => {
				const message = createLazyLoadErrorMessage(model, error);
				outer.push({ type: "error", reason: "error", error: message });
				outer.end(message);
			});

		return outer;
	};
}

// ---------------------------------------------------------------------------
// Module loaders (one per provider, cached via ||=)
// ---------------------------------------------------------------------------

function loadAnthropicProviderModule(): Promise<LazyProviderModule<"anthropic-messages">> {
	anthropicProviderModulePromise ||= Promise.resolve().then(() => {
		const provider = require("./anthropic") as AnthropicProviderModule;
		return { stream: provider.streamAnthropic };
	});
	return anthropicProviderModulePromise;
}

function loadAzureOpenAIResponsesProviderModule(): Promise<LazyProviderModule<"azure-openai-responses">> {
	azureOpenAIResponsesProviderModulePromise ||= Promise.resolve().then(() => {
		const provider = require("./azure-openai-responses") as AzureOpenAIResponsesProviderModule;
		return { stream: provider.streamAzureOpenAIResponses };
	});
	return azureOpenAIResponsesProviderModulePromise;
}

function loadGoogleProviderModule(): Promise<LazyProviderModule<"google-generative-ai">> {
	googleProviderModulePromise ||= Promise.resolve().then(() => {
		const provider = require("./google") as GoogleProviderModule;
		return { stream: provider.streamGoogle };
	});
	return googleProviderModulePromise;
}

function loadGoogleGeminiCliProviderModule(): Promise<LazyProviderModule<"google-gemini-cli">> {
	googleGeminiCliProviderModulePromise ||= Promise.resolve().then(() => {
		const provider = require("./google-gemini-cli") as GoogleGeminiCliProviderModule;
		return { stream: provider.streamGoogleGeminiCli };
	});
	return googleGeminiCliProviderModulePromise;
}

function loadGoogleVertexProviderModule(): Promise<LazyProviderModule<"google-vertex">> {
	googleVertexProviderModulePromise ||= Promise.resolve().then(() => {
		const provider = require("./google-vertex") as GoogleVertexProviderModule;
		return { stream: provider.streamGoogleVertex };
	});
	return googleVertexProviderModulePromise;
}

function loadOpenAICodexResponsesProviderModule(): Promise<LazyProviderModule<"openai-codex-responses">> {
	openAICodexResponsesProviderModulePromise ||= Promise.resolve().then(() => {
		const provider = require("./openai-codex-responses") as OpenAICodexResponsesProviderModule;
		return { stream: provider.streamOpenAICodexResponses };
	});
	return openAICodexResponsesProviderModulePromise;
}

function loadOpenAICompletionsProviderModule(): Promise<LazyProviderModule<"openai-completions">> {
	openAICompletionsProviderModulePromise ||= Promise.resolve().then(() => {
		const provider = require("./openai-completions") as OpenAICompletionsProviderModule;
		return { stream: provider.streamOpenAICompletions };
	});
	return openAICompletionsProviderModulePromise;
}

function loadOpenAIResponsesProviderModule(): Promise<LazyProviderModule<"openai-responses">> {
	openAIResponsesProviderModulePromise ||= Promise.resolve().then(() => {
		const provider = require("./openai-responses") as OpenAIResponsesProviderModule;
		return { stream: provider.streamOpenAIResponses };
	});
	return openAIResponsesProviderModulePromise;
}

function loadOllamaProviderModule(): Promise<LazyProviderModule<"ollama-chat">> {
	ollamaProviderModulePromise ||= Promise.resolve().then(() => {
		const provider = require("./ollama") as OllamaProviderModule;
		return { stream: provider.streamOllama };
	});
	return ollamaProviderModulePromise;
}

function loadCursorProviderModule(): Promise<LazyProviderModule<"cursor-agent">> {
	cursorProviderModulePromise ||= Promise.resolve().then(() => {
		const provider = require("./cursor") as CursorProviderModule;
		return { stream: provider.streamCursor };
	});
	return cursorProviderModulePromise;
}

function loadBedrockProviderModule(): Promise<LazyProviderModule<"bedrock-converse-stream">> {
	if (bedrockProviderModuleOverride) {
		return Promise.resolve(bedrockProviderModuleOverride);
	}
	bedrockProviderModulePromise ||= Promise.resolve().then(() => {
		const provider = require("./amazon-bedrock") as BedrockProviderModule;
		return { stream: provider.streamBedrock };
	});
	return bedrockProviderModulePromise;
}
function loadKiroCodeWhispererProviderModule(): Promise<LazyProviderModule<"kiro-codewhisperer-stream">> {
	kiroCodeWhispererProviderModulePromise ||= Promise.resolve().then(() => {
		const provider = require("./kiro-codewhisperer") as KiroCodeWhispererProviderModule;
		return { stream: provider.streamKiroCodeWhisperer };
	});
	return kiroCodeWhispererProviderModulePromise;
}

/**
 * Lazy provider descriptors used by core consumers that need to inspect or
 * prewarm a provider without importing its implementation at startup.
 */
export const PROVIDER_RUNTIME_DESCRIPTORS: readonly ProviderRuntimeDescriptor<Api, unknown>[] = [
	{ api: "anthropic-messages", load: loadAnthropicProviderModule },
	{ api: "azure-openai-responses", load: loadAzureOpenAIResponsesProviderModule },
	{ api: "google-generative-ai", load: loadGoogleProviderModule },
	{ api: "google-gemini-cli", load: loadGoogleGeminiCliProviderModule },
	{ api: "google-vertex", load: loadGoogleVertexProviderModule },
	{ api: "openai-codex-responses", load: loadOpenAICodexResponsesProviderModule },
	{ api: "openai-completions", load: loadOpenAICompletionsProviderModule },
	{ api: "openai-responses", load: loadOpenAIResponsesProviderModule },
	{ api: "ollama-chat", load: loadOllamaProviderModule },
	{ api: "cursor-agent", load: loadCursorProviderModule },
	{ api: "kiro-codewhisperer-stream", load: loadKiroCodeWhispererProviderModule },
	{ api: "bedrock-converse-stream", load: loadBedrockProviderModule },
] as readonly ErasedProviderRuntimeDescriptor[];

const providerRuntimeDescriptorMap = new Map<Api, ErasedProviderRuntimeDescriptor>(
	PROVIDER_RUNTIME_DESCRIPTORS.map(descriptor => [descriptor.api, descriptor]),
);

/** Return the lazy descriptor for a built-in API, if one is registered. */
export function getProviderRuntimeDescriptor<TApi extends Api>(
	api: TApi,
): ProviderRuntimeDescriptor<TApi, unknown> | undefined {
	return providerRuntimeDescriptorMap.get(api) as ProviderRuntimeDescriptor<TApi, unknown> | undefined;
}

// ---------------------------------------------------------------------------
// Lazy stream function exports
//
// Provider registry code imports these wrappers so the concrete provider modules
// are loaded on first use instead of during package initialization.
// ---------------------------------------------------------------------------

export const streamAnthropic = createLazyStream(loadAnthropicProviderModule, PROVIDER_OWNED_STREAM_WATCHDOG);
export const streamAzureOpenAIResponses = createLazyStream(
	loadAzureOpenAIResponsesProviderModule,
	PROVIDER_OWNED_STREAM_WATCHDOG,
);
export const streamGoogle = createLazyStream(loadGoogleProviderModule);
export const streamGoogleGeminiCli = createLazyStream(
	loadGoogleGeminiCliProviderModule,
	GOOGLE_GEMINI_CLI_LAZY_STREAM_LIMITS,
);
export const streamGoogleVertex = createLazyStream(loadGoogleVertexProviderModule);
export const streamOpenAICodexResponses = createLazyStream(
	loadOpenAICodexResponsesProviderModule,
	PROVIDER_OWNED_STREAM_WATCHDOG,
);
export const streamOpenAICompletions = createLazyStream(
	loadOpenAICompletionsProviderModule,
	PROVIDER_OWNED_STREAM_WATCHDOG,
);
export const streamOpenAIResponses = createLazyStream(
	loadOpenAIResponsesProviderModule,
	PROVIDER_OWNED_STREAM_WATCHDOG,
);
export const streamCursor = createLazyStream(loadCursorProviderModule, PROVIDER_OWNED_STREAM_WATCHDOG);
export const streamOllama = createLazyStream(loadOllamaProviderModule);

export const streamBedrock = createLazyStream(loadBedrockProviderModule);
export const streamKiroCodeWhisperer = createLazyStream(loadKiroCodeWhispererProviderModule);
