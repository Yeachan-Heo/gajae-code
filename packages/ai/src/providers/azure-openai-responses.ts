import { $env, extractHttpStatusFromError, logger } from "@gajae-code/utils";
import { AzureOpenAI } from "openai";
import type {
	Tool as OpenAITool,
	ResponseCreateParamsStreaming,
	ResponseInput,
} from "openai/resources/responses/responses";
import { getEnvApiKey } from "../stream";
import type {
	AssistantMessage,
	Context,
	Model,
	ServiceTier,
	StreamFunction,
	StreamOptions,
	Tool,
	ToolChoice,
} from "../types";
import { normalizeSystemPrompts } from "../utils";
import { createAbortSourceTracker } from "../utils/abort";
import { AssistantMessageEventStream } from "../utils/event-stream";
import { finalizeErrorMessage, type RawHttpRequestDump } from "../utils/http-inspector";
import {
	createWatchdog,
	getOpenAIStreamIdleTimeoutMs,
	getStreamFirstEventTimeoutMs,
	iterateWithIdleTimeout,
} from "../utils/idle-iterator";
import { resolveRetryBudget } from "../utils/retry-budget";
import { flattenToolRootCombinators, sanitizeSchemaForOpenAIResponses, toolWireSchema } from "../utils/schema";
import { wrapFetchForSseDebug } from "../utils/sse-debug";
import { mapToOpenAIResponsesToolChoice } from "../utils/tool-choice";
import {
	isForcedToolChoiceUnsupportedError,
	markToolChoiceIncapability,
	resolveToolChoice,
} from "../utils/tool-choice-capability";
import { wrapOpenAIFetchForBoundedRateLimits } from "./openai-bounded-rate-limits";
import { normalizeOpenAIResponsesPromptCacheKey, supportsDeveloperRole } from "./openai-responses";
import {
	appendResponsesToolResultMessages,
	applyCommonResponsesSamplingParams,
	applyResponsesReasoningParams,
	convertResponsesAssistantMessage,
	convertResponsesInputContent,
	createInitialResponsesAssistantMessage,
	normalizeResponsesToolCallIdForTransform,
	processResponsesStream,
} from "./openai-responses-shared";
import { transformMessages } from "./transform-messages";

const DEFAULT_AZURE_API_VERSION = "v1";
const AZURE_OPENAI_RESPONSES_FIRST_EVENT_TIMEOUT_MESSAGE =
	"Azure OpenAI responses stream timed out while waiting for the first event";

function parseDeploymentNameMap(value: string | undefined): Map<string, string> {
	const map = new Map<string, string>();
	if (!value) return map;
	for (const entry of value.split(",")) {
		const trimmed = entry.trim();
		if (!trimmed) continue;
		const [modelId, deploymentName] = trimmed.split("=", 2);
		if (!modelId || !deploymentName) continue;
		map.set(modelId.trim(), deploymentName.trim());
	}
	return map;
}

function resolveDeploymentName(model: Model<"azure-openai-responses">, options?: AzureOpenAIResponsesOptions): string {
	if (options?.azureDeploymentName) {
		return options.azureDeploymentName;
	}
	const mappedDeployment = parseDeploymentNameMap($env.AZURE_OPENAI_DEPLOYMENT_NAME_MAP).get(model.id);
	return mappedDeployment ?? model.id;
}

// Azure OpenAI Responses-specific options
export interface AzureOpenAIResponsesOptions extends StreamOptions {
	reasoning?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	reasoningSummary?: "auto" | "detailed" | "concise" | null;
	azureApiVersion?: string;
	azureResourceName?: string;
	azureBaseUrl?: string;
	azureDeploymentName?: string;
	toolChoice?: ToolChoice;
	serviceTier?: ServiceTier;
}

type AzureOpenAIResponsesSamplingParams = ResponseCreateParamsStreaming & {
	top_p?: number;
	top_k?: number;
	min_p?: number;
	presence_penalty?: number;
	repetition_penalty?: number;
};

/**
 * Generate function for Azure OpenAI Responses API
 */
export const streamAzureOpenAIResponses: StreamFunction<"azure-openai-responses"> = (
	model: Model<"azure-openai-responses">,
	context: Context,
	options?: AzureOpenAIResponsesOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();

	// Start async processing
	(async () => {
		const startTime = Date.now();
		let firstTokenTime: number | undefined;
		const deploymentName = resolveDeploymentName(model, options);

		const output: AssistantMessage = createInitialResponsesAssistantMessage(
			"azure-openai-responses",
			model.provider,
			model.id,
		);
		let rawRequestDump: RawHttpRequestDump | undefined;
		const abortTracker = createAbortSourceTracker(options?.signal);
		const firstEventTimeoutAbortError = new Error(AZURE_OPENAI_RESPONSES_FIRST_EVENT_TIMEOUT_MESSAGE);
		const { requestAbortController, requestSignal } = abortTracker;

		try {
			// Create Azure OpenAI client
			const apiKey = options?.apiKey || getEnvApiKey(model.provider) || "";
			const client = createClient(model, apiKey, options);
			const { baseUrl } = resolveAzureConfig(model, options);
			const params = buildParams(model, context, options, deploymentName, baseUrl);
			const idleTimeoutMs = getOpenAIStreamIdleTimeoutMs();
			options?.onPayload?.(params);
			rawRequestDump = {
				provider: model.provider,
				api: output.api,
				model: model.id,
				method: "POST",
				url: `${baseUrl}/responses`,
				body: params,
			};
			let openaiStream: Awaited<ReturnType<typeof client.responses.create>>;
			try {
				openaiStream = await client.responses.create(params, { signal: requestSignal });
			} catch (error) {
				if (!isForcedToolChoiceUnsupportedError(error, isForcedAzureResponsesToolChoice(params.tool_choice))) {
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
				rawRequestDump = { ...rawRequestDump, body: params };
				openaiStream = await client.responses.create(params, { signal: requestSignal });
			}
			const firstEventWatchdog = createWatchdog(
				options?.streamFirstEventTimeoutMs ?? getStreamFirstEventTimeoutMs(idleTimeoutMs),
				() => abortTracker.abortLocally(firstEventTimeoutAbortError),
			);
			stream.push({ type: "start", partial: output });

			await processResponsesStream(
				iterateWithIdleTimeout(openaiStream, {
					watchdog: firstEventWatchdog,
					idleTimeoutMs,
					errorMessage: "Azure OpenAI responses stream stalled while waiting for the next event",
					onIdle: () => requestAbortController.abort(),
				}),
				output,
				stream,
				model,
				{
					onFirstToken: () => {
						if (!firstTokenTime) firstTokenTime = Date.now();
					},
				},
			);

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

			output.duration = Date.now() - startTime;
			if (firstTokenTime) output.ttft = firstTokenTime - startTime;
			stream.push({ type: "done", reason: output.stopReason, message: output });
			stream.end();
		} catch (error) {
			for (const block of output.content) delete (block as { index?: number }).index;
			const firstEventTimeoutError = abortTracker.getLocalAbortReason();
			output.stopReason = abortTracker.wasCallerAbort() ? "aborted" : "error";
			output.errorStatus = extractHttpStatusFromError(error);
			output.errorMessage = firstEventTimeoutError?.message ?? (await finalizeErrorMessage(error, rawRequestDump));
			output.duration = Date.now() - startTime;
			if (firstTokenTime) output.ttft = firstTokenTime - startTime;
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
};

function normalizeAzureBaseUrl(baseUrl: string): string {
	return baseUrl.replace(/\/+$/, "");
}

function buildDefaultBaseUrl(resourceName: string): string {
	return `https://${resourceName}.openai.azure.com/openai/v1`;
}

function resolveAzureConfig(
	model: Model<"azure-openai-responses">,
	options?: AzureOpenAIResponsesOptions,
): { baseUrl: string; apiVersion: string } {
	const apiVersion = options?.azureApiVersion || $env.AZURE_OPENAI_API_VERSION || DEFAULT_AZURE_API_VERSION;

	const baseUrl = options?.azureBaseUrl?.trim() || $env.AZURE_OPENAI_BASE_URL?.trim() || undefined;
	const resourceName = options?.azureResourceName || $env.AZURE_OPENAI_RESOURCE_NAME;

	let resolvedBaseUrl = baseUrl;

	if (!resolvedBaseUrl && resourceName) {
		resolvedBaseUrl = buildDefaultBaseUrl(resourceName);
	}

	if (!resolvedBaseUrl && model.baseUrl) {
		resolvedBaseUrl = model.baseUrl;
	}

	if (!resolvedBaseUrl) {
		throw new Error(
			"Azure OpenAI base URL is required. Set AZURE_OPENAI_BASE_URL or AZURE_OPENAI_RESOURCE_NAME, or pass azureBaseUrl, azureResourceName, or model.baseUrl.",
		);
	}

	return {
		baseUrl: normalizeAzureBaseUrl(resolvedBaseUrl),
		apiVersion,
	};
}

function createClient(model: Model<"azure-openai-responses">, apiKey: string, options?: AzureOpenAIResponsesOptions) {
	if (!apiKey) {
		const envKey = $env.AZURE_OPENAI_API_KEY;
		if (!envKey) {
			throw new Error(
				"Azure OpenAI API key is required. Set AZURE_OPENAI_API_KEY environment variable or pass it as an argument.",
			);
		}
		apiKey = envKey;
	}

	const headers = { ...(model.headers ?? {}) };

	if (options?.headers) {
		Object.assign(headers, options.headers);
	}

	const { baseUrl, apiVersion } = resolveAzureConfig(model, options);

	const baseFetch = wrapOpenAIFetchForBoundedRateLimits(options?.fetch ?? fetch, options?.maxRetryDelayMs);
	const onSseEvent = options?.onSseEvent;
	return new AzureOpenAI({
		apiKey,
		apiVersion,
		dangerouslyAllowBrowser: true,
		maxRetries: resolveRetryBudget(options?.requestMaxRetries, 5),
		defaultHeaders: headers,
		baseURL: baseUrl,
		fetch: onSseEvent ? wrapFetchForSseDebug(baseFetch, event => onSseEvent(event, model)) : baseFetch,
	});
}

function buildParams(
	model: Model<"azure-openai-responses">,
	context: Context,
	options: AzureOpenAIResponsesOptions | undefined,
	deploymentName: string,
	resolvedBaseUrl?: string,
) {
	const messages = convertMessages(model, context, true, resolvedBaseUrl);

	const params: AzureOpenAIResponsesSamplingParams = {
		model: deploymentName,
		input: messages,
		stream: true,
		prompt_cache_key: normalizeOpenAIResponsesPromptCacheKey(options?.sessionId),
	};

	applyCommonResponsesSamplingParams(params, options, model.provider);

	if (context.tools) {
		params.tools = convertTools(context.tools);
		if (options?.toolChoice) {
			const toolChoice = resolveToolChoice(model, options.toolChoice);
			if (toolChoice.degraded && toolChoice.supportSource === "runtime") {
				logger.debug("azure-openai-responses: degraded tool_choice after runtime capability discovery", {
					model: model.id,
					requestedLevel: toolChoice.requestedLevel,
					resolvedLevel: toolChoice.resolvedLevel,
					reason: toolChoice.reason,
				});
			}
			params.tool_choice = mapToOpenAIResponsesToolChoice(toolChoice.resolvedChoice);
		}
	}

	applyResponsesReasoningParams(params, model, options, messages);

	return params;
}

function isForcedAzureResponsesToolChoice(choice: AzureOpenAIResponsesSamplingParams["tool_choice"]): boolean {
	return !!choice && choice !== "none" && choice !== "auto";
}

function convertMessages(
	model: Model<"azure-openai-responses">,
	context: Context,
	strictResponsesPairing: boolean,
	resolvedBaseUrl?: string,
): ResponseInput {
	const messages: ResponseInput = [];
	const transformedMessages = transformMessages(context.messages, model, normalizeResponsesToolCallIdForTransform);
	const knownCallIds = new Set<string>();

	const systemPrompts = normalizeSystemPrompts(context.systemPrompt);
	if (systemPrompts.length > 0) {
		const role = model.reasoning && supportsDeveloperRole(resolvedBaseUrl ?? model) ? "developer" : "system";
		for (const systemPrompt of systemPrompts) {
			messages.push({ role, content: systemPrompt });
		}
	}

	let msgIndex = 0;
	for (const msg of transformedMessages) {
		if (msg.role === "user" || msg.role === "developer") {
			const content = convertResponsesInputContent(msg.content, model.input.includes("image"));
			if (!content) continue;
			messages.push({
				role: "user",
				content: msg.role === "developer" && typeof msg.content === "string" ? msg.content.toWellFormed() : content,
			});
		} else if (msg.role === "assistant") {
			const outputItems = convertResponsesAssistantMessage(msg as AssistantMessage, model, msgIndex, knownCallIds);
			if (outputItems.length === 0) continue;
			messages.push(...outputItems);
		} else if (msg.role === "toolResult") {
			appendResponsesToolResultMessages(messages, msg, model, strictResponsesPairing, knownCallIds);
		}
		msgIndex++;
	}

	return messages;
}

function convertTools(tools: Tool[]): OpenAITool[] {
	return tools.map(tool => ({
		type: "function",
		name: tool.name,
		description: tool.description || "",
		parameters: sanitizeSchemaForOpenAIResponses(flattenToolRootCombinators(toolWireSchema(tool))),
		strict: false,
	}));
}
