import { logger } from "@gajae-code/utils";
import { captureRequestHeaders, resolvePromptCacheKey } from "../auth-gateway/http";
import type {
	AssistantMessage,
	AssistantMessageEventStream,
	Message,
	RedactedThinkingContent,
	StopReason,
	TextContent,
	ThinkingContent,
	Tool,
	ToolCall,
	ToolResultMessage,
	UserMessage,
} from "../types";
import { sanitizeJsonStrings } from "../utils";
import {
	type AnthropicAssistantContentBlock,
	type AnthropicMessage,
	type AnthropicSystem,
	type AnthropicTool,
	type AnthropicToolChoice,
	type AnthropicToolResultContent,
	type AnthropicUserContentBlock,
	anthropicMessagesRequestSchema,
} from "./anthropic-messages-server-schema";

/**
 * Anthropic Messages API (https://docs.anthropic.com/en/api/messages) ↔ pi-ai
 * gateway translation. Inbound: foreign HTTP body → gjc Context. Outbound:
 * gjc AssistantMessage[Stream] → Anthropic-shaped JSON / SSE.
 */

import type { AuthGatewayParsedRequest as ParsedRequest } from "../auth-gateway/types";

export type { ParsedRequest };

// ---------------------------------------------------------------------------
// Inbound parsing
// ---------------------------------------------------------------------------

type ImageContentPart = { type: "image"; data: string; mimeType: string };

// Dedup noise from unknown-block-type warnings. Module-scoped so the warn
// fires once per (category, type) pair across the lifetime of the process.
const WARNED_UNKNOWN_BLOCK_TYPES = new Set<string>();
function warnUnknownBlockType(category: "user" | "assistant", blockType: string): void {
	const key = `${category}:${blockType}`;
	if (WARNED_UNKNOWN_BLOCK_TYPES.has(key)) return;
	WARNED_UNKNOWN_BLOCK_TYPES.add(key);
	logger.warn("anthropic-messages: unknown content block flattened to text placeholder", {
		category,
		blockType,
	});
}

// pi-ai's `ImageContent` only carries base64 + mimeType. When the inbound
// uses `url` or `file_id` sources we surface a text placeholder so the
// downstream provider still sees a sane history; warn once per source kind.
const WARNED_NON_BASE64_IMAGE_SOURCES = new Set<string>();
function warnNonBase64ImageSource(sourceType: string): void {
	if (WARNED_NON_BASE64_IMAGE_SOURCES.has(sourceType)) return;
	WARNED_NON_BASE64_IMAGE_SOURCES.add(sourceType);
	logger.warn("anthropic-messages: image source surfaced as text placeholder (pi-ai ImageContent lacks URL channel)", {
		sourceType,
	});
}

// Compact, log-safe stringification for unknown content blocks. Keeps the
// placeholder informative without dumping multi-KB structures into history.
function describeUnknownBlock(block: { type: string }): string {
	try {
		const json = JSON.stringify(block);
		if (json !== undefined && json.length <= 200) return `[${block.type}: ${json}]`;
	} catch {
		// fall through
	}
	return `[${block.type}]`;
}

function buildSystemPrompt(raw: AnthropicSystem): string[] | undefined {
	if (raw === undefined) return undefined;
	if (typeof raw === "string") return raw.length > 0 ? [raw] : undefined;
	const parts = raw.map(block => block.text).filter(text => text.length > 0);
	return parts.length > 0 ? [parts.join("\n\n")] : undefined;
}

function makeUserMessage(parts: (TextContent | ImageContentPart)[], timestamp: number): UserMessage {
	return {
		role: "user",
		content: parts.length === 1 && parts[0].type === "text" ? parts[0].text : parts,
		timestamp,
	};
}

function toolResultPartsFromBlocks(
	content: AnthropicToolResultContent[] | string | undefined,
): (TextContent | ImageContentPart)[] {
	if (content === undefined) return [];
	if (typeof content === "string") return [{ type: "text", text: content }];
	const out: (TextContent | ImageContentPart)[] = [];
	for (const block of content) {
		if (block.type === "text") {
			out.push({ type: "text", text: block.text });
			continue;
		}
		// block.type === "image" — schema only accepts base64 sources.
		if (block.source.type === "base64") {
			out.push({ type: "image", data: block.source.data, mimeType: block.source.media_type });
		}
	}
	return out;
}

function walkUserContent(
	blocks: string | AnthropicUserContentBlock[],
	timestamp: number,
): (UserMessage | ToolResultMessage)[] {
	const messages: (UserMessage | ToolResultMessage)[] = [];
	const userParts: (TextContent | ImageContentPart)[] = [];
	const flush = () => {
		if (userParts.length === 0) return;
		messages.push(makeUserMessage(userParts.splice(0), timestamp));
	};
	if (typeof blocks === "string") {
		if (blocks.length > 0) userParts.push({ type: "text", text: blocks });
		flush();
		return messages;
	}
	for (const block of blocks) {
		if (block.type === "text") {
			userParts.push({ type: "text", text: block.text });
		} else if (block.type === "image") {
			// SDK's typed source covers base64+url; our schema also accepts the
			// forward-compat `file` variant. Narrow against a widened shape so
			// every variant is handled at runtime regardless of SDK lag.
			const source = block.source as {
				type: string;
				data?: string;
				media_type?: string;
				url?: string;
				file_id?: string;
			};
			if (source.type === "base64" && source.data && source.media_type) {
				userParts.push({ type: "image", data: source.data, mimeType: source.media_type });
			} else {
				warnNonBase64ImageSource(source.type);
				const ref =
					source.type === "url" ? (source.url ?? "") : source.type === "file" ? (source.file_id ?? "") : "";
				userParts.push({ type: "text", text: `[image: ${ref}]` });
			}
		} else if (block.type === "tool_result") {
			// Anthropic permits tool_result blocks to follow plain text/image
			// siblings in the same user message. pi-ai's history is a flat
			// sequence of typed messages, so flush the accumulated parts as a
			// separate UserMessage before emitting the ToolResultMessage.
			flush();
			messages.push({
				role: "toolResult",
				toolCallId: block.tool_use_id,
				// Anthropic tool_results don't carry the tool name; downstream can rehydrate.
				toolName: "",
				content: toolResultPartsFromBlocks(block.content as AnthropicToolResultContent[] | string | undefined),
				isError: block.is_error === true,
				timestamp,
			});
		} else {
			// Unknown variant (server_tool_use, mcp_*, document, web_search_tool_result,
			// container_upload, code_execution_*, …). Flatten to a text placeholder
			// so the downstream provider still gets a coherent transcript.
			const unknown = block as { type: string };
			warnUnknownBlockType("user", unknown.type);
			userParts.push({ type: "text", text: describeUnknownBlock(unknown) });
		}
	}
	flush();
	return messages;
}

function walkAssistantContent(
	blocks: string | AnthropicAssistantContentBlock[],
): (TextContent | ThinkingContent | RedactedThinkingContent | ToolCall)[] {
	const out: (TextContent | ThinkingContent | RedactedThinkingContent | ToolCall)[] = [];
	if (typeof blocks === "string") {
		if (blocks.length > 0) out.push({ type: "text", text: blocks });
		return out;
	}
	for (const block of blocks) {
		switch (block.type) {
			case "text":
				out.push({ type: "text", text: block.text });
				break;
			case "thinking": {
				const tc: ThinkingContent = { type: "thinking", thinking: block.thinking };
				if (block.signature !== undefined) tc.thinkingSignature = block.signature;
				out.push(tc);
				break;
			}
			case "redacted_thinking":
				out.push({ type: "redactedThinking", data: block.data });
				break;
			case "tool_use":
				out.push({
					type: "toolCall",
					id: block.id,
					name: block.name,
					arguments: block.input ?? {},
				});
				break;
			default: {
				// Unknown assistant variant (server_tool_use, mcp_tool_use, …).
				// Flatten to a text placeholder; warn once per unknown type.
				const unknown = block as { type: string };
				warnUnknownBlockType("assistant", unknown.type);
				out.push({ type: "text", text: describeUnknownBlock(unknown) });
				break;
			}
		}
	}
	return out;
}

function walkTools(tools: AnthropicTool[] | undefined): Tool[] | undefined {
	if (!tools) return undefined;
	return tools.map(tool => ({
		name: tool.name,
		description: tool.description ?? "",
		parameters: tool.input_schema as Record<string, unknown>,
	}));
}

function mapToolChoice(choice: AnthropicToolChoice | undefined): ParsedRequest["options"]["toolChoice"] {
	if (!choice) return undefined;
	switch (choice.type) {
		case "auto":
			return "auto";
		case "any":
			return "required";
		case "none":
			return "none";
		case "tool":
			return { name: choice.name };
	}
}

type AnthropicCacheControl = { type: "ephemeral"; ttl?: "1h" | "5m" };
type HasCacheControl = { cache_control?: AnthropicCacheControl };

function readCacheControl(value: unknown): AnthropicCacheControl | undefined {
	if (value === null || typeof value !== "object") return undefined;
	const cc = (value as HasCacheControl).cache_control;
	if (!cc || typeof cc !== "object" || cc.type !== "ephemeral") return undefined;
	return cc;
}

/**
 * Anthropic clients annotate caching breakpoints per block via
 * `cache_control: { type: "ephemeral", ttl?: "1h"|"5m" }`. pi-ai's
 * `cacheRetention` is per-request, not per-block, and its anthropic provider
 * re-applies breakpoints itself on the rebuilt outbound wire. Scan every
 * block once and return the strongest retention requested: any `ttl: "1h"`
 * promotes the request to "long", anything else ephemeral maps to "short".
 */
function deriveCacheRetention(data: {
	system?: unknown;
	messages: readonly unknown[];
	tools?: readonly unknown[];
}): "short" | "long" | undefined {
	let strongest: "short" | "long" | undefined;
	const visit = (cc: AnthropicCacheControl | undefined): void => {
		if (!cc) return;
		if (cc.ttl === "1h") strongest = "long";
		else strongest ??= "short";
	};
	if (Array.isArray(data.system)) {
		for (const block of data.system) visit(readCacheControl(block));
	}
	for (const message of data.messages) {
		if (message === null || typeof message !== "object") continue;
		const content = (message as { content?: unknown }).content;
		if (!Array.isArray(content)) continue;
		for (const block of content) visit(readCacheControl(block));
	}
	if (data.tools) {
		for (const tool of data.tools) visit(readCacheControl(tool));
	}
	return strongest;
}

export function parseRequest(body: unknown, headers?: Headers): ParsedRequest {
	const parsed = anthropicMessagesRequestSchema.safeParse(body);
	if (!parsed.success) {
		throw new Error(`anthropic-messages: ${parsed.error.message}`);
	}
	const data = parsed.data;

	const now = Date.now();
	const messages: Message[] = [];
	for (const message of data.messages as AnthropicMessage[]) {
		if (message.role === "user") {
			for (const m of walkUserContent(message.content, now)) messages.push(m);
		} else {
			const assistant: AssistantMessage = {
				role: "assistant",
				content: walkAssistantContent(message.content),
				api: "anthropic-messages",
				provider: "anthropic",
				model: data.model,
				usage: emptyUsage(),
				stopReason: "stop",
				timestamp: now,
			};
			messages.push(assistant);
		}
	}

	const options: ParsedRequest["options"] = {
		maxOutputTokens: data.max_tokens,
	};
	if (data.temperature !== undefined) options.temperature = data.temperature;
	if (data.top_p !== undefined) options.topP = data.top_p;
	if (data.top_k !== undefined) options.topK = data.top_k;
	if (data.stop_sequences) options.stopSequences = data.stop_sequences;
	const toolChoice = mapToolChoice(data.tool_choice as AnthropicToolChoice | undefined);
	if (toolChoice !== undefined) options.toolChoice = toolChoice;
	// `disable_parallel_tool_use === true` means the client wants the model to
	// emit at most one tool call per turn; map to pi-ai's negated boolean.
	// Leave undefined when the field is absent or explicitly `false` so we
	// don't override provider defaults.
	if (data.tool_choice?.disable_parallel_tool_use === true) {
		options.parallelToolCalls = false;
	}
	if (data.thinking) {
		switch (data.thinking.type) {
			case "enabled":
				options.explicitThinkingBudgetTokens = data.thinking.budget_tokens;
				break;
			case "disabled":
				options.disableReasoning = true;
				break;
			case "adaptive":
				if (data.thinking.budget_tokens !== undefined) {
					options.explicitThinkingBudgetTokens = data.thinking.budget_tokens;
				}
				break;
		}
	}
	const cacheRetention = deriveCacheRetention(data);
	if (cacheRetention !== undefined) options.cacheRetention = cacheRetention;
	// Anthropic clients commonly send `metadata: { user_id }`; forward verbatim
	// so downstream providers (and our anthropic-passthrough fast-path) can
	// preserve abuse-tracking signal.
	if (data.metadata !== undefined) {
		options.metadata = data.metadata as Record<string, unknown>;
	}
	const cacheKey = resolvePromptCacheKey(body, headers);
	if (cacheKey !== undefined) options.promptCacheKey = cacheKey;
	// Allow-listed header capture. The gateway's `handleFormatEndpoint`
	// already merges its own pre-capture under whatever the parser sets, but
	// we populate here too so direct callers of `parseRequest` (tests, custom
	// wrappers) see the same surface. `anthropic-version` is the most
	// load-bearing — some downstream Anthropic-API targets reject requests
	// missing it.
	if (headers) {
		const captured = captureRequestHeaders(headers);
		if (Object.keys(captured).length > 0) options.headers = captured;
	}

	return {
		modelId: data.model,
		context: {
			systemPrompt: buildSystemPrompt(data.system as AnthropicSystem),
			messages,
			tools: walkTools(data.tools as AnthropicTool[] | undefined),
		},
		stream: data.stream === true,
		options,
	};
}

function emptyUsage(): AssistantMessage["usage"] {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

// ---------------------------------------------------------------------------
// Outbound encoding
// ---------------------------------------------------------------------------

function newMessageId(): string {
	const hex = (globalThis.crypto?.randomUUID?.() ?? randomFallback()).replace(/-/g, "").slice(0, 24);
	return `msg_${hex}`;
}

function randomFallback(): string {
	// Sufficient for tests / environments without crypto.randomUUID
	const buf = new Uint8Array(16);
	for (let i = 0; i < 16; i++) buf[i] = Math.floor(Math.random() * 256);
	const hex = Array.from(buf, b => b.toString(16).padStart(2, "0")).join("");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function mapStopReasonOut(reason: StopReason): "end_turn" | "max_tokens" | "tool_use" {
	switch (reason) {
		case "length":
			return "max_tokens";
		case "toolUse":
			return "tool_use";
		default:
			return "end_turn";
	}
}

/**
 * True when `signature` is one of OUR serialized OpenAI Responses reasoning-item
 * envelopes (produced by the Responses/Codex decoders as
 * `JSON.stringify(reasoningItem)` with `type: "reasoning"`). Such an envelope is
 * NOT a valid Anthropic thinking signature and may embed raw chain-of-thought in
 * `content[]`, so it must never be forwarded on Anthropic egress. Genuine opaque
 * Anthropic signatures and any non-envelope string return false (fail safe).
 */
function isSerializedResponsesReasoningItem(signature: string): boolean {
	try {
		const parsed: unknown = JSON.parse(signature);
		return (
			typeof parsed === "object" &&
			parsed !== null &&
			!Array.isArray(parsed) &&
			(parsed as { type?: unknown }).type === "reasoning"
		);
	} catch {
		return false;
	}
}

/**
 * A thinking-block signature safe to emit on Anthropic egress: cross-protocol
 * serialized Responses reasoning envelopes are omitted (they can carry raw CoT);
 * genuine opaque Anthropic signatures round-trip unchanged.
 */
function safeThinkingSignature(signature: string | undefined): string | undefined {
	if (!signature) return undefined;
	if (isSerializedResponsesReasoningItem(signature)) return undefined;
	return signature;
}

function isResponsesFamilyApi(api: AssistantMessage["api"]): boolean {
	return api === "openai-responses" || api === "openai-codex-responses";
}

function safeThinkingText(content: ThinkingContent, api: AssistantMessage["api"]): string | undefined {
	if (isResponsesFamilyApi(api) && content.provenance === undefined) return undefined;
	if (content.provenance === "raw") return undefined;
	if (content.provenance === "mixed") return content.summaryText;
	if (content.provenance === "summary") return content.summaryText ?? content.thinking;
	return content.thinking;
}

function hasRawOrMixedThinking(partial: AssistantMessage, contentIndex: number): boolean {
	const content = partial.content[contentIndex];
	return content?.type === "thinking" && (content.provenance === "raw" || content.provenance === "mixed");
}

/** Responses-family reasoning is untrusted until output_item.done assigns provenance. */
function hasUnfinalizedResponsesThinking(partial: AssistantMessage, contentIndex: number): boolean {
	const content = partial.content[contentIndex];
	return content?.type !== "thinking" || (isResponsesFamilyApi(partial.api) && content.provenance === undefined);
}

function encodeContentBlocks(message: AssistantMessage): Record<string, unknown>[] {
	const blocks: Record<string, unknown>[] = [];
	for (const c of message.content) {
		switch (c.type) {
			case "text":
				blocks.push({ type: "text", text: c.text });
				break;
			case "thinking": {
				const thinking = safeThinkingText(c, message.api);
				if (thinking === undefined) break;
				const b: Record<string, unknown> = { type: "thinking", thinking };
				const sig = safeThinkingSignature(c.thinkingSignature);
				if (sig) b.signature = sig;
				blocks.push(b);
				break;
			}
			case "redactedThinking":
				blocks.push({ type: "redacted_thinking", data: c.data });
				break;
			case "toolCall":
				blocks.push({ type: "tool_use", id: c.id, name: c.name, input: sanitizeJsonStrings(c.arguments ?? {}) });
				break;
		}
	}
	return blocks;
}

function encodeUsage(message: AssistantMessage): Record<string, unknown> {
	return {
		input_tokens: message.usage.input,
		output_tokens: message.usage.output,
		cache_read_input_tokens: message.usage.cacheRead,
		cache_creation_input_tokens: message.usage.cacheWrite,
	};
}

export function encodeResponse(message: AssistantMessage, requestedModelId: string): Record<string, unknown> {
	if (message.stopReason === "error" || message.stopReason === "aborted") {
		throw new Error(message.errorMessage ?? `anthropic-messages: upstream ${message.stopReason}`);
	}
	return {
		id: message.responseId ?? newMessageId(),
		type: "message",
		role: "assistant",
		model: requestedModelId,
		content: encodeContentBlocks(message),
		stop_reason: mapStopReasonOut(message.stopReason),
		// TODO: surface the matched stop sequence once pi-ai's
		// `AssistantMessage.stopReason` carries the matched string. Intentionally
		// `null` for now (Anthropic schema allows it).
		stop_sequence: null,
		usage: encodeUsage(message),
	};
}

// ---------------------------------------------------------------------------
// Streaming encoder
// ---------------------------------------------------------------------------

const ENCODER = new TextEncoder();

function sseFrame(event: string, data: Record<string, unknown>): Uint8Array {
	return ENCODER.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

type BlockKind = "text" | "thinking" | "tool_use";

interface OpenBlock {
	index: number;
	kind: BlockKind;
}

export function encodeStream(
	events: AssistantMessageEventStream,
	requestedModelId: string,
): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		async start(controller) {
			const messageId = newMessageId();
			let started = false;
			const open = new Map<number, OpenBlock>();
			// contentIndexes that already streamed a reasoning summary delta, so a
			// final-only reasoning_summary_end does not duplicate streamed summary text.
			const summaryDeltaSeen = new Set<number>();
			// Responses assigns reasoning provenance only at output_item.done. Keep its
			// pre-classification bytes out of this public compatibility stream.
			const pendingThinkingDeltas = new Map<number, string[]>();

			const ensureStart = (partial: AssistantMessage) => {
				if (started) return;
				started = true;
				controller.enqueue(
					sseFrame("message_start", {
						type: "message_start",
						message: {
							id: messageId,
							type: "message",
							role: "assistant",
							model: requestedModelId,
							content: [],
							stop_reason: null,
							// TODO: same as encodeResponse — surface matched stop sequence
							// once pi-ai propagates it.
							stop_sequence: null,
							usage: encodeUsage(partial),
						},
					}),
				);
			};

			const closeBlock = (index: number) => {
				if (!open.has(index)) return;
				controller.enqueue(sseFrame("content_block_stop", { type: "content_block_stop", index }));
				open.delete(index);
			};

			const openThinking = (partial: AssistantMessage, index: number) => {
				if (open.has(index)) return;
				ensureStart(partial);
				open.set(index, { index, kind: "thinking" });
				controller.enqueue(
					sseFrame("content_block_start", {
						type: "content_block_start",
						index,
						content_block: { type: "thinking", thinking: "" },
					}),
				);
			};

			const writeThinkingDelta = (index: number, thinking: string) => {
				if (thinking.length === 0) return;
				controller.enqueue(
					sseFrame("content_block_delta", {
						type: "content_block_delta",
						index,
						delta: { type: "thinking_delta", thinking },
					}),
				);
			};

			try {
				for await (const ev of events) {
					switch (ev.type) {
						case "start":
							ensureStart(ev.partial);
							break;
						case "text_start": {
							ensureStart(ev.partial);
							open.set(ev.contentIndex, { index: ev.contentIndex, kind: "text" });
							controller.enqueue(
								sseFrame("content_block_start", {
									type: "content_block_start",
									index: ev.contentIndex,
									content_block: { type: "text", text: "" },
								}),
							);
							break;
						}
						case "text_delta":
							controller.enqueue(
								sseFrame("content_block_delta", {
									type: "content_block_delta",
									index: ev.contentIndex,
									delta: { type: "text_delta", text: ev.delta },
								}),
							);
							break;
						case "text_end":
							closeBlock(ev.contentIndex);
							break;
						case "thinking_start": {
							if (hasRawOrMixedThinking(ev.partial, ev.contentIndex)) break;
							if (hasUnfinalizedResponsesThinking(ev.partial, ev.contentIndex)) {
								pendingThinkingDeltas.set(ev.contentIndex, []);
								break;
							}
							openThinking(ev.partial, ev.contentIndex);
							break;
						}
						case "thinking_delta": {
							if (hasRawOrMixedThinking(ev.partial, ev.contentIndex)) break;
							if (hasUnfinalizedResponsesThinking(ev.partial, ev.contentIndex)) {
								const deltas = pendingThinkingDeltas.get(ev.contentIndex) ?? [];
								deltas.push(ev.delta);
								pendingThinkingDeltas.set(ev.contentIndex, deltas);
								break;
							}
							writeThinkingDelta(ev.contentIndex, ev.delta);
							break;
						}
						case "thinking_end": {
							const unfinalized = hasUnfinalizedResponsesThinking(ev.partial, ev.contentIndex);
							const rawOrMixed = hasRawOrMixedThinking(ev.partial, ev.contentIndex);
							const pending = pendingThinkingDeltas.get(ev.contentIndex);
							pendingThinkingDeltas.delete(ev.contentIndex);
							if (rawOrMixed || unfinalized) {
								closeBlock(ev.contentIndex);
								break;
							}
							if (pending) {
								openThinking(ev.partial, ev.contentIndex);
								for (const delta of pending) writeThinkingDelta(ev.contentIndex, delta);
							}
							const c = ev.partial.content[ev.contentIndex];
							const sig = c?.type === "thinking" ? safeThinkingSignature(c.thinkingSignature) : undefined;
							if (sig) {
								controller.enqueue(
									sseFrame("content_block_delta", {
										type: "content_block_delta",
										index: ev.contentIndex,
										delta: { type: "signature_delta", signature: sig },
									}),
								);
							}
							closeBlock(ev.contentIndex);
							break;
						}
						case "reasoning_summary_start": {
							// Provider-displayable summary reasoning surfaces as this format's
							// native thinking channel. Open the thinking block if a thinking_start
							// did not already (summary-only streams emit no thinking_start).
							if (!open.has(ev.contentIndex)) {
								ensureStart(ev.partial);
								open.set(ev.contentIndex, { index: ev.contentIndex, kind: "thinking" });
								controller.enqueue(
									sseFrame("content_block_start", {
										type: "content_block_start",
										index: ev.contentIndex,
										content_block: { type: "thinking", thinking: "" },
									}),
								);
							}
							break;
						}
						case "reasoning_summary_delta":
							// Only a non-whitespace delta counts as a delivered summary; a bare
							// separator ("\n\n") must not suppress a later final-only end content.
							if (ev.delta.trim().length > 0) summaryDeltaSeen.add(ev.contentIndex);
							controller.enqueue(
								sseFrame("content_block_delta", {
									type: "content_block_delta",
									index: ev.contentIndex,
									delta: { type: "thinking_delta", thinking: ev.delta },
								}),
							);
							break;
						case "reasoning_summary_end": {
							// Final-only summary: text arrives only on the end event with no prior
							// deltas. Ensure the thinking block is open, then surface the content as
							// a thinking_delta (skip when deltas already streamed to avoid dup). The
							// thinking block is closed by the subsequent thinking_end.
							if (ev.content.length > 0 && !summaryDeltaSeen.has(ev.contentIndex)) {
								if (!open.has(ev.contentIndex)) {
									ensureStart(ev.partial);
									open.set(ev.contentIndex, { index: ev.contentIndex, kind: "thinking" });
									controller.enqueue(
										sseFrame("content_block_start", {
											type: "content_block_start",
											index: ev.contentIndex,
											content_block: { type: "thinking", thinking: "" },
										}),
									);
								}
								controller.enqueue(
									sseFrame("content_block_delta", {
										type: "content_block_delta",
										index: ev.contentIndex,
										delta: { type: "thinking_delta", thinking: ev.content },
									}),
								);
							}
							break;
						}
						case "toolcall_start": {
							ensureStart(ev.partial);
							const tc = ev.partial.content[ev.contentIndex] as ToolCall | undefined;
							open.set(ev.contentIndex, { index: ev.contentIndex, kind: "tool_use" });
							controller.enqueue(
								sseFrame("content_block_start", {
									type: "content_block_start",
									index: ev.contentIndex,
									content_block: {
										type: "tool_use",
										id: tc?.id ?? "",
										name: tc?.name ?? "",
										input: {},
									},
								}),
							);
							break;
						}
						case "toolcall_delta":
							controller.enqueue(
								sseFrame("content_block_delta", {
									type: "content_block_delta",
									index: ev.contentIndex,
									delta: { type: "input_json_delta", partial_json: ev.delta },
								}),
							);
							break;
						case "toolcall_end":
							closeBlock(ev.contentIndex);
							break;
						case "done": {
							for (const idx of [...open.keys()]) closeBlock(idx);
							pendingThinkingDeltas.clear();
							controller.enqueue(
								sseFrame("message_delta", {
									type: "message_delta",
									// TODO: surface matched stop sequence once pi-ai
									// propagates it on the `done` event.
									delta: { stop_reason: mapStopReasonOut(ev.reason), stop_sequence: null },
									usage: encodeUsage(ev.message),
								}),
							);
							controller.enqueue(sseFrame("message_stop", { type: "message_stop" }));
							controller.close();
							return;
						}
						case "error": {
							const msg = ev.error.errorMessage ?? "stream error";
							pendingThinkingDeltas.clear();
							controller.enqueue(
								sseFrame("error", { type: "error", error: { type: "api_error", message: msg } }),
							);
							controller.close();
							return;
						}
					}
				}
				// stream ended without explicit done; close gracefully
				pendingThinkingDeltas.clear();
				for (const idx of [...open.keys()]) closeBlock(idx);
				controller.enqueue(sseFrame("message_stop", { type: "message_stop" }));
				controller.close();
			} catch (err) {
				pendingThinkingDeltas.clear();
				controller.enqueue(
					sseFrame("error", {
						type: "error",
						error: { type: "api_error", message: err instanceof Error ? err.message : String(err) },
					}),
				);
				controller.close();
			}
		},
	});
}

// ---------------------------------------------------------------------------
// Error envelope
// ---------------------------------------------------------------------------

/**
 * Anthropic error envelope: `{ type: "error", error: { type, message } }`.
 * See https://docs.anthropic.com/en/api/errors. Returned as a `Response` so
 * the gateway can hand it straight back to the client without extra wrapping.
 */
export function formatError(status: number, type: string, message: string): Response {
	return new Response(JSON.stringify({ type: "error", error: { type, message } }), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}
