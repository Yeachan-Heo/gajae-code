/**
 * Amazon Bedrock Converse Stream provider.
 *
 * Talks directly to `bedrock-runtime.{region}.amazonaws.com` over HTTPS with
 * SigV4 signing and decodes the `application/vnd.amazon.eventstream` response.
 * No `@aws-sdk/*`, no `@smithy/*`, no `proxy-agent`. Proxies are honored via
 * Bun's native `HTTPS_PROXY` support.
 */

import { $credentialEnv, $env, $flag, extractHttpStatusFromError, fetchWithRetry } from "@gajae-code/utils";
import type { Effort } from "../model-thinking";
import { mapEffortToAnthropicAdaptiveEffort, requireSupportedEffort } from "../model-thinking";
import { calculateCost } from "../models";
import type {
	Api,
	AssistantMessage,
	CacheRetention,
	Context,
	Model,
	StopReason,
	StreamFunction,
	StreamOptions,
	TextContent,
	ThinkingBudgets,
	ThinkingContent,
	Tool,
	ToolCall,
	ToolChoice,
	ToolResultMessage,
} from "../types";
import { normalizeToolCallId, resolveCacheRetention, sanitizeJsonStrings } from "../utils";
import { AssistantMessageEventStream } from "../utils/event-stream";
import { appendRawHttpRequestDumpFor400, type RawHttpRequestDump, withHttpStatus } from "../utils/http-inspector";
import { parseStreamingJson } from "../utils/json-parse";
import { resolveRetryBudget } from "../utils/retry-budget";
import { flattenToolRootCombinators, toolWireSchema } from "../utils/schema";
import {
	isForcedToolChoiceUnsupportedError,
	markToolChoiceIncapability,
	resolveToolChoice,
} from "../utils/tool-choice-capability";
import { isValidBedrockBearerToken } from "./aws-credential-config";
import { resolveAwsCredentials } from "./aws-credentials";
import { decodeEventStream } from "./aws-eventstream";
import type { AwsCredentials } from "./aws-sigv4";
import { signRequest } from "./aws-sigv4";
import { transformMessages } from "./transform-messages";

export type BedrockThinkingDisplay = "summarized" | "omitted";

export interface BedrockOptions extends StreamOptions {
	region?: string;
	profile?: string;
	toolChoice?: ToolChoice;
	/* See https://docs.aws.amazon.com/bedrock/latest/userguide/inference-reasoning.html for supported models. */
	reasoning?: Effort;
	/* Custom token budgets per thinking level. Overrides default budgets. */
	thinkingBudgets?: ThinkingBudgets;
	/* Only supported by Anthropic model 4.x models, see https://docs.aws.amazon.com/bedrock/latest/userguide/Anthropic model-messages-extended-thinking.html#Anthropic model-messages-extended-thinking-tool-use-interleaved */
	interleavedThinking?: boolean;
	/**
	 * Controls how Anthropic model returns thinking content in Bedrock responses.
	 * - `"summarized"`: thinking blocks include human-readable summaries (default here).
	 * - `"omitted"`: thinking content is suppressed; the encrypted signature still
	 *   travels back for multi-turn continuity.
	 *
	 * Starting with Anthropic model Opus 4.7 the Anthropic API default is `"omitted"`, which
	 * leaves callers waiting on a silent stream during long reasoning runs (issue
	 * #1373). We default to `"summarized"` so adaptive-thinking models that accept
	 * the field keep producing visible thinking deltas. Older adaptive-thinking
	 * models (Opus 4.6, Sonnet 4.6+) reject the field, so we omit it for them.
	 */
	thinkingDisplay?: BedrockThinkingDisplay;
}

type Block = (TextContent | ThinkingContent | ToolCall) & { index?: number; partialJson?: string };

// ---------- Bedrock wire-format types ----------
// Mirrors only what we actually consume from `ConverseStreamRequest` /
// `ConverseStreamOutput`. Keeps us decoupled from `@aws-sdk/client-bedrock-runtime`.

interface CachePoint {
	cachePoint: { type: "default"; ttl?: "5m" | "1h" };
}
interface TextBlockWire {
	text: string;
}
interface ImageBlockWire {
	image: { format: "jpeg" | "png" | "gif" | "webp"; source: { bytes: string } };
}
interface ToolUseBlockWire {
	toolUse: { toolUseId: string; name: string; input: unknown };
}
interface ToolResultBlockWire {
	toolResult: {
		toolUseId: string;
		content: Array<TextBlockWire | ImageBlockWire>;
		status: "success" | "error";
	};
}
interface ReasoningBlockWire {
	reasoningContent: { reasoningText: { text: string; signature?: string } };
}

type UserContent = TextBlockWire | ImageBlockWire | ToolResultBlockWire | CachePoint;
type AssistantContent = TextBlockWire | ToolUseBlockWire | ReasoningBlockWire;
type SystemContent = TextBlockWire | CachePoint;

interface WireMessage {
	role: "user" | "assistant";
	content: Array<UserContent | AssistantContent>;
}

interface WireToolSpec {
	toolSpec: { name: string; description: string; inputSchema: { json: unknown } };
}
interface WireToolChoice {
	auto?: Record<string, never>;
	any?: Record<string, never>;
	tool?: { name: string };
}
interface WireToolConfig {
	tools: WireToolSpec[];
	toolChoice?: WireToolChoice;
}

interface ConverseStreamRequest {
	messages: WireMessage[];
	system?: SystemContent[];
	inferenceConfig?: { maxTokens?: number; temperature?: number; topP?: number };
	toolConfig?: WireToolConfig;
	additionalModelRequestFields?: Record<string, unknown>;
}

// Streaming events (snake_case matches the JSON envelope key, but Bedrock uses camelCase).
interface MessageStartEvent {
	role: "user" | "assistant";
}
interface ContentBlockStartEvent {
	contentBlockIndex: number;
	start?: { toolUse?: { toolUseId?: string; name?: string } };
}
interface ContentBlockDeltaEvent {
	contentBlockIndex: number;
	delta?: {
		text?: string;
		toolUse?: { input?: string };
		reasoningContent?: { text?: string; signature?: string };
	};
}
interface ContentBlockStopEvent {
	contentBlockIndex: number;
}
interface MessageStopEvent {
	stopReason?: string;
}
interface MetadataEvent {
	usage?: {
		inputTokens?: number;
		outputTokens?: number;
		cacheReadInputTokens?: number;
		cacheWriteInputTokens?: number;
		totalTokens?: number;
	};
}

type BedrockAuthMode = { kind: "bearer"; token: string } | { kind: "sigv4"; credentials: AwsCredentials };

export const streamBedrock: StreamFunction<"bedrock-converse-stream"> = (
	model: Model<"bedrock-converse-stream">,
	context: Context,
	options: BedrockOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();

	(async () => {
		const startTime = Date.now();
		let firstTokenTime: number | undefined;

		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: "bedrock-converse-stream" as Api,
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

		const blocks = output.content as Block[];
		let rawRequestDump: RawHttpRequestDump | undefined;
		const region = options.region || $env.AWS_REGION || $env.AWS_DEFAULT_REGION || "us-east-1";

		try {
			const cacheRetention = resolveCacheRetention(options.cacheRetention);
			const resolvedToolChoice = resolveToolChoice(model, options.toolChoice);
			const toolConfig = convertToolConfig(context.tools, resolvedToolChoice.resolvedChoice);
			let additionalModelRequestFields = buildAdditionalModelRequestFields(model, options);

			// Bedrock rejects thinking + forced tool_choice ("any" or specific tool).
			// When the resolved tool_choice forces tool use, disable thinking to avoid API errors.
			if (toolConfig?.toolChoice && additionalModelRequestFields) {
				const tc = toolConfig.toolChoice;
				if (tc.any || tc.tool) additionalModelRequestFields = undefined;
			}

			const commandInput: ConverseStreamRequest = {
				messages: convertMessages(context, model, cacheRetention),
				system: buildSystemPrompt(context.systemPrompt, model, cacheRetention),
				inferenceConfig: {
					maxTokens: options.maxTokens,
					temperature: options.temperature,
					topP: options.topP,
				},
				toolConfig,
				additionalModelRequestFields,
			};
			options?.onPayload?.(commandInput);

			const host = `bedrock-runtime.${region}.amazonaws.com`;
			const url = `https://${host}/model/${encodeURIComponent(model.id)}/converse-stream`;
			const urlPath = `/model/${encodeURIComponent(model.id)}/converse-stream`;
			rawRequestDump = {
				provider: model.provider,
				api: output.api,
				model: model.id,
				method: "POST",
				url,
				body: commandInput,
			};

			const bearerToken = $credentialEnv("AWS_BEARER_TOKEN_BEDROCK");
			if (bearerToken && !isValidBedrockBearerToken(bearerToken)) {
				throw new Error("AWS_BEARER_TOKEN_BEDROCK contains unsafe control characters.");
			}
			const authMode: BedrockAuthMode = bearerToken
				? { kind: "bearer", token: bearerToken }
				: {
						kind: "sigv4",
						credentials: $flag("AWS_BEDROCK_SKIP_AUTH")
							? { accessKeyId: "dummy-access-key", secretAccessKey: "dummy-secret-key" }
							: await resolveAwsCredentials({ profile: options.profile, region, signal: options.signal }),
					};
			const bodyText = JSON.stringify(commandInput);
			const body = new TextEncoder().encode(bodyText);
			const baseHeaders: Record<string, string> = {
				"content-type": "application/json",
				accept: "application/vnd.amazon.eventstream",
			};
			const buildRequestHeaders = async (requestBody: Uint8Array): Promise<Record<string, string>> => {
				const headers = new Headers(baseHeaders);
				if (authMode.kind === "bearer") {
					headers.set("authorization", `Bearer ${authMode.token}`);
					return Object.fromEntries(headers);
				}
				const signed = await signRequest({
					method: "POST",
					host,
					path: urlPath,
					body: requestBody,
					region,
					service: "bedrock",
					credentials: authMode.credentials,
					headers: baseHeaders,
				});
				for (const [name, value] of Object.entries(signed)) headers.set(name, value);
				return Object.fromEntries(headers);
			};
			const requestHeaders = await buildRequestHeaders(body);
			const sentForcedToolChoice = Boolean(toolConfig?.toolChoice?.any || toolConfig?.toolChoice?.tool);
			let fallbackRan = false;
			const retryWithoutForcedToolChoice = async (reason: string) => {
				fallbackRan = true;
				markToolChoiceIncapability(model, "auto", reason);
				stream.push({
					type: "toolChoiceIncapability",
					api: output.api,
					provider: model.provider,
					model: model.id,
					requestedLevel: resolvedToolChoice.requestedLevel,
					resolvedLevel: "auto",
					reason,
					registryKey: resolvedToolChoice.registryKey,
				});
				stripBedrockForcedToolChoiceForRetry(commandInput);
				const retryBodyText = JSON.stringify(commandInput);
				const retryBody = new TextEncoder().encode(retryBodyText);
				if (rawRequestDump) rawRequestDump.body = commandInput;
				return fetchWithRetry(url, {
					method: "POST",
					headers: await buildRequestHeaders(retryBody),
					body: retryBody,
					signal: options.signal,
					maxAttempts: 1,
				});
			};

			let response = await fetchWithRetry(url, {
				method: "POST",
				headers: requestHeaders,
				body,
				signal: options.signal,
				maxAttempts: resolveRetryBudget(options.requestMaxRetries, 4) + 1,
			});

			if (!response.ok && sentForcedToolChoice) {
				const errBody = await response.text().catch(() => "");
				const error = withHttpStatus(
					new Error(`Bedrock HTTP ${response.status}: ${errBody.slice(0, 1000)}`),
					response.status,
				);
				if (firstTokenTime === undefined && !fallbackRan && isForcedToolChoiceUnsupportedError(error, true)) {
					response = await retryWithoutForcedToolChoice(error.message);
				} else {
					throw error;
				}
			}
			if (!response.ok) {
				const errBody = await response.text().catch(() => "");
				throw withHttpStatus(
					new Error(`Bedrock HTTP ${response.status}: ${errBody.slice(0, 1000)}`),
					response.status,
				);
			}
			if (!response.body) throw new Error("Bedrock response has no body");

			// Track first event for the abort/diagnostic path (currently informational).
			streamLoop: while (true) {
				for await (const message of decodeEventStream(response.body)) {
					const messageType = message.headers[":message-type"];
					const eventType = message.headers[":event-type"];

					if (messageType === "exception") {
						const exceptionType = message.headers[":exception-type"] || "Exception";
						const payload = safeParsePayload(message.payload) as { message?: string } | undefined;
						const errorMessage = payload?.message || new TextDecoder().decode(message.payload);
						const status = exceptionType === "validationException" ? 400 : 0;
						const err = new Error(`${exceptionType}: ${errorMessage}`);
						const error = status ? withHttpStatus(err, status) : err;
						if (
							firstTokenTime === undefined &&
							sentForcedToolChoice &&
							!fallbackRan &&
							isForcedToolChoiceUnsupportedError(error, true)
						) {
							response = await retryWithoutForcedToolChoice(error.message);
							if (!response.ok) {
								const errBody = await response.text().catch(() => "");
								throw withHttpStatus(
									new Error(`Bedrock HTTP ${response.status}: ${errBody.slice(0, 1000)}`),
									response.status,
								);
							}
							if (!response.body) throw new Error("Bedrock response has no body");
							continue streamLoop;
						}
						throw error;
					}
					if (messageType === "error") {
						const code = message.headers[":error-code"] || "UnknownError";
						const errorMessage = message.headers[":error-message"] || new TextDecoder().decode(message.payload);
						throw new Error(`${code}: ${errorMessage}`);
					}
					if (messageType !== "event") continue;

					const payload = safeParsePayload(message.payload);
					if (!payload) continue;

					switch (eventType) {
						case "messageStart": {
							// no-op: first event marker is implicit by stream entry.
							const ev = payload as MessageStartEvent;
							if (ev.role !== "assistant") {
								throw new Error("Unexpected assistant message start but got user message start instead");
							}
							stream.push({ type: "start", partial: output });
							break;
						}
						case "contentBlockStart": {
							if (!firstTokenTime) firstTokenTime = Date.now();
							handleContentBlockStart(payload as ContentBlockStartEvent, blocks, output, stream);
							break;
						}
						case "contentBlockDelta": {
							if (!firstTokenTime) firstTokenTime = Date.now();
							handleContentBlockDelta(payload as ContentBlockDeltaEvent, blocks, output, stream);
							break;
						}
						case "contentBlockStop": {
							handleContentBlockStop(payload as ContentBlockStopEvent, blocks, output, stream);
							break;
						}
						case "messageStop": {
							const ev = payload as MessageStopEvent;
							output.stopReason = mapStopReason(ev.stopReason);
							break;
						}
						case "metadata": {
							handleMetadata(payload as MetadataEvent, model, output);
							break;
						}
						default:
							// Unknown event types (Bedrock may add new ones) — ignore.
							break;
					}
				}
				break;
			}

			if (options.signal?.aborted) throw new Error("Request was aborted");

			if (output.stopReason === "error" || output.stopReason === "aborted") {
				throw new Error(output.errorMessage ?? "An unknown error occurred");
			}

			output.duration = Date.now() - startTime;
			if (firstTokenTime) output.ttft = firstTokenTime - startTime;
			stream.push({ type: "done", reason: output.stopReason, message: output });
			stream.end();
		} catch (error) {
			for (const block of output.content) {
				delete (block as Block).index;
				delete (block as Block).partialJson;
			}
			output.stopReason = options.signal?.aborted ? "aborted" : "error";
			output.errorStatus = extractHttpStatusFromError(error);
			const baseMessage = error instanceof Error ? error.message : JSON.stringify(error);
			// Enrich error with thinking block diagnostics for signature-related failures
			let diagnostics = "";
			if (baseMessage.includes("signature") || baseMessage.includes("thinking")) {
				const thinkingBlocks = context.messages
					.filter((m): m is AssistantMessage => m.role === "assistant")
					.flatMap((m, mi) =>
						m.content
							.filter(b => b.type === "thinking")
							.map((b, bi) => ({
								msg: mi,
								block: bi,
								stop: m.stopReason,
								sigLen: b.thinkingSignature?.length ?? -1,
								thinkLen: b.thinking.length,
							})),
					);
				if (thinkingBlocks.length > 0) {
					diagnostics = `\n[thinking-diag] ${JSON.stringify(thinkingBlocks)}`;
				}
			}
			output.errorMessage = await appendRawHttpRequestDumpFor400(baseMessage + diagnostics, error, rawRequestDump);
			output.duration = Date.now() - startTime;
			if (firstTokenTime) output.ttft = firstTokenTime - startTime;
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
};

function safeParsePayload(payload: Uint8Array): unknown {
	if (payload.length === 0) return {};
	try {
		return JSON.parse(new TextDecoder().decode(payload));
	} catch {
		return undefined;
	}
}

function handleContentBlockStart(
	event: ContentBlockStartEvent,
	blocks: Block[],
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
): void {
	const index = event.contentBlockIndex;
	const start = event.start;

	if (start?.toolUse) {
		const block: Block = {
			type: "toolCall",
			id: normalizeToolCallId(start.toolUse.toolUseId || ""),
			name: start.toolUse.name || "",
			arguments: {},
			partialJson: "",
			index,
		};
		output.content.push(block);
		stream.push({ type: "toolcall_start", contentIndex: blocks.length - 1, partial: output });
	}
}

function handleContentBlockDelta(
	event: ContentBlockDeltaEvent,
	blocks: Block[],
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
): void {
	const contentBlockIndex = event.contentBlockIndex;
	const delta = event.delta;
	let index = blocks.findIndex(b => b.index === contentBlockIndex);
	let block = blocks[index];

	if (delta?.text !== undefined) {
		// If no text block exists yet, create one — `handleContentBlockStart` is not sent for text blocks
		if (!block) {
			const newBlock: Block = { type: "text", text: "", index: contentBlockIndex };
			output.content.push(newBlock);
			index = blocks.length - 1;
			block = blocks[index];
			stream.push({ type: "text_start", contentIndex: index, partial: output });
		}
		if (block.type === "text") {
			block.text += delta.text;
			stream.push({ type: "text_delta", contentIndex: index, delta: delta.text, partial: output });
		}
	} else if (delta?.toolUse && block?.type === "toolCall") {
		block.partialJson = (block.partialJson || "") + (delta.toolUse.input || "");
		block.arguments = parseStreamingJson(block.partialJson);
		stream.push({ type: "toolcall_delta", contentIndex: index, delta: delta.toolUse.input || "", partial: output });
	} else if (delta?.reasoningContent) {
		let thinkingBlock = block;
		let thinkingIndex = index;

		if (!thinkingBlock) {
			const newBlock: Block = { type: "thinking", thinking: "", thinkingSignature: "", index: contentBlockIndex };
			output.content.push(newBlock);
			thinkingIndex = blocks.length - 1;
			thinkingBlock = blocks[thinkingIndex];
			stream.push({ type: "thinking_start", contentIndex: thinkingIndex, partial: output });
		}

		if (thinkingBlock?.type === "thinking") {
			if (delta.reasoningContent.text) {
				thinkingBlock.thinking += delta.reasoningContent.text;
				stream.push({
					type: "thinking_delta",
					contentIndex: thinkingIndex,
					delta: delta.reasoningContent.text,
					partial: output,
				});
			}
			if (delta.reasoningContent.signature) {
				thinkingBlock.thinkingSignature =
					(thinkingBlock.thinkingSignature || "") + delta.reasoningContent.signature;
			}
		}
	}
}

function handleMetadata(event: MetadataEvent, model: Model<"bedrock-converse-stream">, output: AssistantMessage): void {
	if (event.usage) {
		output.usage.input = event.usage.inputTokens || 0;
		output.usage.output = event.usage.outputTokens || 0;
		output.usage.cacheRead = event.usage.cacheReadInputTokens || 0;
		output.usage.cacheWrite = event.usage.cacheWriteInputTokens || 0;
		output.usage.totalTokens = event.usage.totalTokens || output.usage.input + output.usage.output;
		calculateCost(model, output.usage);
	}
}

function handleContentBlockStop(
	event: ContentBlockStopEvent,
	blocks: Block[],
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
): void {
	const index = blocks.findIndex(b => b.index === event.contentBlockIndex);
	const block = blocks[index];
	if (!block) return;
	delete (block as Block).index;

	switch (block.type) {
		case "text":
			stream.push({ type: "text_end", contentIndex: index, content: block.text, partial: output });
			break;
		case "thinking":
			stream.push({ type: "thinking_end", contentIndex: index, content: block.thinking, partial: output });
			break;
		case "toolCall":
			block.arguments = parseStreamingJson(block.partialJson);
			delete (block as Block).partialJson;
			stream.push({ type: "toolcall_end", contentIndex: index, toolCall: block, partial: output });
			break;
	}
}

/**
 * Check if the model supports prompt caching.
 * Supported: Anthropic model 3.5 Haiku, Anthropic model 3.7 Sonnet, Anthropic model 4.x+ models, Haiku 4.5+
 *
 * For base models and system-defined inference profiles the model ID / ARN
 * contains the model name, so we can decide locally.
 *
 * For application inference profiles (whose ARNs don't contain the model name),
 * set AWS_BEDROCK_FORCE_CACHE=1 to enable cache points.  Amazon Nova models
 * have automatic caching and don't need explicit cache points.
 */
function supportsPromptCaching(model: Model<"bedrock-converse-stream">): boolean {
	if (model.cost.cacheRead || model.cost.cacheWrite) return true;
	const id = model.id.toLowerCase();
	// Anthropic model 4.x models (opus-4, sonnet-4, haiku-4)
	if (id.includes("claude") && (id.includes("-4-") || id.includes("-4."))) return true;
	// Anthropic model 3.5 Haiku, Anthropic model 3.7 Sonnet (legacy naming)
	if (id.includes("claude-3-7-sonnet") || id.includes("claude-3-5-haiku")) return true;
	// Anthropic model Haiku 4.5+ (new naming)
	if (id.includes("claude-haiku")) return true;
	// Application inference profiles don't contain the model name in the ARN.
	// Allow users to force cache points via environment variable.
	if (typeof process !== "undefined" && $flag("AWS_BEDROCK_FORCE_CACHE")) return true;
	return false;
}

/**
 * Check if the model supports thinking signatures in reasoningContent.
 * Only Anthropic Anthropic model models support the signature field.
 * Other models (Nova, Titan, Mistral, Llama, etc.) reject it with:
 * "This model doesn't support the reasoningContent.reasoningText.signature field"
 */
function supportsThinkingSignature(model: Model<"bedrock-converse-stream">): boolean {
	const id = model.id.toLowerCase();
	return id.includes("anthropic.claude") || id.includes("anthropic/claude");
}

function buildSystemPrompt(
	systemPrompt: readonly string[] | undefined,
	model: Model<"bedrock-converse-stream">,
	cacheRetention: CacheRetention,
): SystemContent[] | undefined {
	const prompts = systemPrompt?.map(prompt => prompt.toWellFormed()).filter(prompt => prompt.length > 0) ?? [];
	if (prompts.length === 0) return undefined;

	const blocks: SystemContent[] = prompts.map(prompt => ({ text: prompt }));

	// Add cache point for supported Anthropic model models
	if (cacheRetention !== "none" && supportsPromptCaching(model)) {
		blocks.push({
			cachePoint: { type: "default", ...(cacheRetention === "long" ? { ttl: "1h" } : {}) },
		});
	}

	return blocks;
}

function convertMessages(
	context: Context,
	model: Model<"bedrock-converse-stream">,
	cacheRetention: CacheRetention,
): WireMessage[] {
	const result: WireMessage[] = [];
	const transformedMessages = transformMessages(context.messages, model, normalizeToolCallId);

	for (let i = 0; i < transformedMessages.length; i++) {
		const m = transformedMessages[i];

		switch (m.role) {
			case "developer":
			case "user":
				if (typeof m.content === "string") {
					// Skip empty user messages
					if (!m.content || m.content.trim() === "") continue;
					result.push({ role: "user", content: [{ text: m.content.toWellFormed() }] });
				} else {
					const contentBlocks: UserContent[] = [];
					for (const c of m.content) {
						switch (c.type) {
							case "text": {
								const text = c.text.toWellFormed();
								if (text.trim().length === 0) continue;
								contentBlocks.push({ text });
								break;
							}
							case "image":
								contentBlocks.push({ image: createImageBlock(c.mimeType, c.data) });
								break;
							default:
								throw new Error("Unknown user content type");
						}
					}
					// Skip message if all blocks filtered out
					if (contentBlocks.length === 0) continue;
					result.push({ role: "user", content: contentBlocks });
				}
				break;
			case "assistant": {
				// Skip assistant messages with empty content (e.g., from aborted requests)
				// Bedrock rejects messages with empty content arrays
				if (m.content.length === 0) continue;
				const contentBlocks: AssistantContent[] = [];
				for (const c of m.content) {
					switch (c.type) {
						case "text":
							// Skip empty text blocks
							if (c.text.trim().length === 0) continue;
							contentBlocks.push({ text: c.text.toWellFormed() });
							break;
						case "toolCall":
							contentBlocks.push({
								toolUse: {
									toolUseId: normalizeToolCallId(c.id),
									name: c.name,
									input: sanitizeJsonStrings(c.arguments),
								},
							});
							break;
						case "thinking":
							// Skip empty thinking blocks
							if (c.thinking.trim().length === 0) continue;
							// Thinking blocks require a valid signature when sent as reasoningContent.
							// If the signature is missing (e.g., from an aborted stream), or the model
							// doesn't support signatures, convert to plain text instead.
							if (supportsThinkingSignature(model) && c.thinkingSignature) {
								contentBlocks.push({
									reasoningContent: {
										reasoningText: { text: c.thinking.toWellFormed(), signature: c.thinkingSignature },
									},
								});
							} else if (!supportsThinkingSignature(model)) {
								// Model doesn't support signatures at all — send as unsigned reasoning
								contentBlocks.push({
									reasoningContent: { reasoningText: { text: c.thinking.toWellFormed() } },
								});
							} else {
								// Model requires signature but we don't have one — demote to text
								contentBlocks.push({ text: `[Thinking]: ${c.thinking.toWellFormed()}` });
							}
							break;
						default:
							throw new Error("Unknown assistant content type");
					}
				}
				// Skip if all content blocks were filtered out
				if (contentBlocks.length === 0) continue;
				result.push({ role: "assistant", content: contentBlocks });
				break;
			}
			case "toolResult": {
				// Collect all consecutive toolResult messages into a single user message —
				// Bedrock requires all tool results to be in one message.
				const toolResults: ToolResultBlockWire[] = [];
				toolResults.push({
					toolResult: {
						toolUseId: normalizeToolCallId(m.toolCallId),
						content: m.content.map(c =>
							c.type === "image"
								? { image: createImageBlock(c.mimeType, c.data) }
								: { text: c.text.toWellFormed() },
						),
						status: m.isError ? "error" : "success",
					},
				});

				let j = i + 1;
				while (j < transformedMessages.length && transformedMessages[j].role === "toolResult") {
					const nextMsg = transformedMessages[j] as ToolResultMessage;
					toolResults.push({
						toolResult: {
							toolUseId: normalizeToolCallId(nextMsg.toolCallId),
							content: nextMsg.content.map(c =>
								c.type === "image"
									? { image: createImageBlock(c.mimeType, c.data) }
									: { text: c.text.toWellFormed() },
							),
							status: nextMsg.isError ? "error" : "success",
						},
					});
					j++;
				}
				i = j - 1;

				result.push({ role: "user", content: toolResults });
				break;
			}
			default:
				throw new Error("Unknown message role");
		}
	}

	// Add cache point to the last user message for supported Anthropic model models
	if (cacheRetention !== "none" && supportsPromptCaching(model) && result.length > 0) {
		const lastMessage = result[result.length - 1];
		if (lastMessage.role === "user" && lastMessage.content) {
			(lastMessage.content as UserContent[]).push({
				cachePoint: { type: "default", ...(cacheRetention === "long" ? { ttl: "1h" } : {}) },
			});
		}
	}

	return result;
}

export function stripBedrockForcedToolChoiceForRetry<T extends { toolConfig?: { toolChoice?: unknown } }>(body: T): T {
	if (body.toolConfig) {
		body.toolConfig = { ...body.toolConfig, toolChoice: undefined };
	}
	return body;
}

export function convertToolConfig(
	tools: Tool[] | undefined,
	toolChoice: BedrockOptions["toolChoice"],
): WireToolConfig | undefined {
	if (!tools?.length || toolChoice === "none") return undefined;

	const bedrockTools: WireToolSpec[] = tools.map(tool => ({
		toolSpec: {
			name: tool.name,
			description: tool.description || "",
			inputSchema: { json: flattenToolRootCombinators(toolWireSchema(tool)) },
		},
	}));

	let bedrockToolChoice: WireToolChoice | undefined;
	switch (toolChoice) {
		case "auto":
			bedrockToolChoice = { auto: {} };
			break;
		case "any":
		case "required":
			bedrockToolChoice = { any: {} };
			break;
		default:
			if (toolChoice?.type === "tool") {
				bedrockToolChoice = { tool: { name: toolChoice.name } };
			}
	}

	return bedrockToolChoice ? { tools: bedrockTools, toolChoice: bedrockToolChoice } : { tools: bedrockTools };
}

function mapStopReason(reason: string | undefined): StopReason {
	switch (reason) {
		case "end_turn":
		case "stop_sequence":
			return "stop";
		case "max_tokens":
		case "model_context_window_exceeded":
			return "length";
		case "tool_use":
			return "toolUse";
		default:
			return "error";
	}
}

function buildAdditionalModelRequestFields(
	model: Model<"bedrock-converse-stream">,
	options: BedrockOptions,
): Record<string, unknown> | undefined {
	const reasoning = options.reasoning;
	if (!reasoning || !model.reasoning) return undefined;

	const mode = model.thinking?.mode;
	if (mode === "anthropic-adaptive") {
		const effort = mapEffortToAnthropicAdaptiveEffort(model, reasoning);
		// Starting with Anthropic model Opus 4.7, Anthropic switched the adaptive-thinking
		// default to "omitted", which silently suppresses streamed reasoning and
		// can read as a stalled stream during long reasoning runs (issue #1373).
		// Opt back into "summarized" by default on models that accept the field.
		const adaptive: { type: "adaptive"; display?: BedrockThinkingDisplay } = { type: "adaptive" };
		if (supportsAdaptiveThinkingDisplay(model.id)) {
			adaptive.display = options.thinkingDisplay ?? "summarized";
		}
		return {
			thinking: adaptive,
			output_config: { effort },
		};
	}

	const level = requireSupportedEffort(model, reasoning);
	const defaultBudgets: Record<Effort, number> = {
		minimal: 1024,
		low: 2048,
		medium: 8192,
		high: 16384,
		xhigh: 32768,
		max: 32768,
	};
	const budget = options.thinkingBudgets?.[level] ?? defaultBudgets[level];

	const result: Record<string, unknown> = {
		thinking: {
			type: "enabled",
			budget_tokens: budget,
			display: options.thinkingDisplay ?? "summarized",
		},
	};

	if (options.interleavedThinking) {
		result.anthropic_beta = ["interleaved-thinking-2025-05-14"];
	}

	return result;
}

/**
 * Adaptive thinking `display` is supported starting with Anthropic model Opus 4.7.
 * Older adaptive-thinking models (Opus 4.6, Sonnet 4.6+) reject the field.
 * Bedrock model ids are prefixed with region/inference-profile slugs (e.g.
 * `eu.anthropic.Anthropic model-opus-4-7-...`); the regex matches the `Anthropic model-opus-X-Y`
 * fragment regardless of prefix.
 */
function supportsAdaptiveThinkingDisplay(modelId: string): boolean {
	const match = /claude-opus-(\d+)-(\d+)/.exec(modelId);
	if (!match) return false;
	const major = Number(match[1]);
	const minor = Number(match[2]);
	return major > 4 || (major === 4 && minor >= 7);
}

/**
 * Bedrock's wire format expects the image as `{ source: { bytes: <base64-string> }, format }`.
 * The caller already passes base64-encoded data, so no decode/re-encode round-trip is needed.
 */
function createImageBlock(mimeType: string, data: string): ImageBlockWire["image"] {
	let format: "jpeg" | "png" | "gif" | "webp";
	switch (mimeType) {
		case "image/jpeg":
		case "image/jpg":
			format = "jpeg";
			break;
		case "image/png":
			format = "png";
			break;
		case "image/gif":
			format = "gif";
			break;
		case "image/webp":
			format = "webp";
			break;
		default:
			throw new Error(`Unknown image type: ${mimeType}`);
	}
	return { source: { bytes: data }, format };
}
