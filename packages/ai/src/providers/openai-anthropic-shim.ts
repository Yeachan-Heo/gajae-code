/**
 * Shared implementation for providers that expose BOTH an OpenAI-compatible
 * and an Anthropic-compatible API surface against the same model catalog
 * (currently Kimi Code and Synthetic).
 *
 * Each call site supplies the provider-specific bits (base URLs, default
 * format, optional extra headers); the streaming/forwarding plumbing lives
 * here once.
 */

import { ANTHROPIC_THINKING } from "../stream";
import type { Context, Model, SimpleStreamOptions } from "../types";
import { AssistantMessageEventStream } from "../utils/event-stream";
import { createProviderErrorMessage } from "./error-message";
import { streamAnthropic, streamOpenAICompletions } from "./register-builtins";

export type OpenAIAnthropicApiFormat = "openai" | "anthropic";

export interface OpenAIAnthropicShimOptions extends SimpleStreamOptions {
	/** API format: "openai" or "anthropic". */
	format?: OpenAIAnthropicApiFormat;
}

export interface OpenAIAnthropicShimConfig {
	/** Base URL for the Anthropic-compatible endpoint (without trailing /v1/messages). */
	anthropicBaseUrl: string;
	/** Optional override for the OpenAI-compatible base URL. If omitted, `model.baseUrl` is used as-is. */
	openaiBaseUrl?: string;
	/** Default API format when caller does not specify one. */
	defaultFormat: OpenAIAnthropicApiFormat;
	/** Provider-specific headers (e.g. auth/session) merged ahead of user-supplied headers. */
	extraHeaders?: () => Record<string, string>;
}

/**
 * Stream from an OpenAI-or-Anthropic compatible provider. Returns synchronously;
 * async header fetching and stream piping happen internally.
 */
export function streamOpenAIAnthropicShim(
	model: Model<"openai-completions">,
	context: Context,
	options: OpenAIAnthropicShimOptions | undefined,
	config: OpenAIAnthropicShimConfig,
): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	const format = options?.format ?? config.defaultFormat;

	(async () => {
		try {
			const mergedHeaders = {
				...(config.extraHeaders?.() ?? {}),
				...options?.headers,
			};

			if (format === "anthropic") {
				const anthropicModel: Model<"anthropic-messages"> = {
					id: model.id,
					name: model.name,
					api: "anthropic-messages",
					provider: model.provider,
					baseUrl: config.anthropicBaseUrl,
					headers: mergedHeaders,
					contextWindow: model.contextWindow,
					maxTokens: model.maxTokens,
					reasoning: model.reasoning,
					input: model.input,
					cost: model.cost,
				};

				const reasoningEffort = options?.reasoning;
				const thinkingEnabled = !!reasoningEffort && model.reasoning;
				const thinkingBudget = reasoningEffort
					? (options?.thinkingBudgets?.[reasoningEffort] ?? ANTHROPIC_THINKING[reasoningEffort])
					: undefined;

				const innerStream = streamAnthropic(anthropicModel, context, {
					apiKey: options?.apiKey,
					temperature: options?.temperature,
					topP: options?.topP,
					topK: options?.topK,
					minP: options?.minP,
					presencePenalty: options?.presencePenalty,
					repetitionPenalty: options?.repetitionPenalty,
					maxTokens: options?.maxTokens ?? Math.min(model.maxTokens, 32000),
					signal: options?.signal,
					headers: mergedHeaders,
					sessionId: options?.sessionId,
					onPayload: options?.onPayload,
					attemptScope: options?.attemptScope,
					onResponse: options?.onResponse,
					onSseEvent: options?.onSseEvent,
					fetch: options?.fetch,
					streamIdleTimeoutMs: options?.streamIdleTimeoutMs,
					streamFirstEventTimeoutMs: options?.streamFirstEventTimeoutMs,
					thinkingEnabled,
					thinkingBudgetTokens: thinkingBudget,
				});

				for await (const event of innerStream) {
					stream.push(event);
				}
			} else {
				const openaiModel: Model<"openai-completions"> = config.openaiBaseUrl
					? { ...model, baseUrl: config.openaiBaseUrl, headers: mergedHeaders }
					: model;

				const reasoningEffort = options?.reasoning;
				const innerStream = streamOpenAICompletions(openaiModel, context, {
					apiKey: options?.apiKey,
					temperature: options?.temperature,
					topP: options?.topP,
					topK: options?.topK,
					minP: options?.minP,
					presencePenalty: options?.presencePenalty,
					repetitionPenalty: options?.repetitionPenalty,
					maxTokens: options?.maxTokens ?? model.maxTokens,
					signal: options?.signal,
					headers: mergedHeaders,
					sessionId: options?.sessionId,
					onPayload: options?.onPayload,
					attemptScope: options?.attemptScope,
					onResponse: options?.onResponse,
					onSseEvent: options?.onSseEvent,
					fetch: options?.fetch,
					streamIdleTimeoutMs: options?.streamIdleTimeoutMs,
					streamFirstEventTimeoutMs: options?.streamFirstEventTimeoutMs,
					reasoning: reasoningEffort,
				});

				for await (const event of innerStream) {
					stream.push(event);
				}
			}
		} catch (err) {
			stream.push({
				type: "error",
				reason: "error",
				error: createProviderErrorMessage(model, err),
			});
		}
	})();

	return stream;
}
