/**
 * OpenAI Responses HTTP wire-format ↔ gjc Context bridge for the auth-gateway.
 *
 * Inbound: parses `POST /v1/responses` request bodies into a {@link ParsedRequest}.
 * Outbound: encodes gjc's {@link AssistantMessage} (and event stream) back into
 * the documented `response.*` SSE taxonomy or the non-streaming JSON shape.
 *
 * Spec: https://platform.openai.com/docs/api-reference/responses
 * Inverse direction (source-of-truth for item shapes): ../../providers/openai-responses.ts
 */

import { logger } from "@gajae-code/utils";
import { resolvePromptCacheKey } from "../auth-gateway/http";
import type { AuthGatewayParsedRequest as ParsedRequest } from "../auth-gateway/types";
import type {
	AssistantMessage,
	AssistantMessageEventStream,
	Context,
	Message,
	TextContent,
	ThinkingContent,
	Tool,
	ToolCall,
} from "../types";
import { sanitizeJsonStrings } from "../utils";
import {
	type OpenAIResponsesFunctionCallItem,
	type OpenAIResponsesFunctionCallOutputItem,
	type OpenAIResponsesInputContent,
	type OpenAIResponsesOutputContent,
	type OpenAIResponsesReasoningItem,
	type OpenAIResponsesTool,
	openaiResponsesRequestSchema,
} from "./openai-responses-server-schema";

export type { ParsedRequest };

// ─── narrow guards ──────────────────────────────────────────────────────────

function isReasoningEffort(value: unknown): value is NonNullable<ParsedRequest["options"]["reasoning"]> {
	return (
		value === "minimal" ||
		value === "low" ||
		value === "medium" ||
		value === "high" ||
		value === "xhigh" ||
		value === "max"
	);
}

function isServiceTier(value: unknown): value is NonNullable<ParsedRequest["options"]["serviceTier"]> {
	return value === "auto" || value === "default" || value === "flex" || value === "scale" || value === "priority";
}

function isObj(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asString(v: unknown): string | undefined {
	return typeof v === "string" ? v : undefined;
}

// ─── id helpers ─────────────────────────────────────────────────────────────

function uuidNoDashes(): string {
	return crypto.randomUUID().replace(/-/g, "");
}

function makeRespId(): string {
	return `resp_${uuidNoDashes()}`;
}

function makeMsgId(): string {
	return `msg_${uuidNoDashes()}`;
}

function makeReasoningId(): string {
	return `rs_${uuidNoDashes()}`;
}

function makeFuncCallId(): string {
	return `fc_${uuidNoDashes()}`;
}

function makeCustomCallId(): string {
	return `ctc_${uuidNoDashes()}`;
}

// ─── once-only warnings ─────────────────────────────────────────────────────
// Module-scoped so we don't spam logs once per turn.

let warnedImageNotSupported = false;
let warnedFileNotSupported = false;
let warnedReasoningSummaryLevel = false;

// ─── inbound parser helpers ─────────────────────────────────────────────────

function reasoningContentFromItem(
	item: OpenAIResponsesReasoningItem,
): Pick<ThinkingContent, "thinking" | "provenance" | "summaryText" | "rawText"> {
	// `summary[]` is provider-displayable; `content[]` is raw reasoning. Keep
	// these channels distinct so a Responses gateway round-trip cannot relabel
	// raw CoT as a summary merely because summary text is absent.
	const summaryText = (item.summary ?? []).map(part => part.text).join("");
	const rawText = (item.content ?? []).map(part => part.text).join("");
	if (summaryText && rawText) {
		return { thinking: summaryText, provenance: "mixed", summaryText, rawText };
	}
	if (summaryText) return { thinking: summaryText, provenance: "summary", summaryText };
	if (rawText) return { thinking: rawText, provenance: "raw", rawText };
	return { thinking: "" };
}

type InputBlockUnion =
	| { type: "input_text"; text: string }
	| { type: "text"; text: string }
	| { type: "input_image"; detail?: "auto" | "low" | "high"; image_url?: string; file_id?: string }
	| { type: "input_file"; file_id?: string; filename?: string; file_data?: string };

/**
 * Walk an input message's content array and produce pi-ai's `TextContent[]`.
 * `input_image`/`input_file` blocks become bracketed text placeholders since
 * pi-ai's `ImageContent` only carries inline base64 data and we have no
 * resolver for OpenAI `image_url` / `file_id` references. Logs once per kind.
 */
function inputContentParts(blocks: OpenAIResponsesInputContent[] | string | undefined): string | TextContent[] {
	if (typeof blocks === "string") return blocks;
	if (!blocks) return [];
	const parts: TextContent[] = [];
	for (const raw of blocks) {
		const block = raw as InputBlockUnion;
		if (block.type === "input_text" || block.type === "text") {
			parts.push({ type: "text", text: block.text });
		} else if (block.type === "input_image") {
			if (!warnedImageNotSupported) {
				warnedImageNotSupported = true;
				logger.warn("openai-responses-server: input_image dropped (no pi-ai bridge for image_url/file_id)", {
					hasUrl: typeof block.image_url === "string",
					hasFileId: typeof block.file_id === "string",
				});
			}
			const ref = block.image_url ?? block.file_id ?? "?";
			parts.push({ type: "text", text: `[image: ${ref}]` });
		} else if (block.type === "input_file") {
			if (!warnedFileNotSupported) {
				warnedFileNotSupported = true;
				logger.warn("openai-responses-server: input_file dropped (no pi-ai bridge for file_id/file_data)", {
					hasFileId: typeof block.file_id === "string",
					hasFileData: typeof block.file_data === "string",
				});
			}
			const ref = block.file_id ?? block.filename ?? "?";
			parts.push({ type: "text", text: `[file: ${ref}]` });
		}
	}
	return parts.length === 1 ? parts[0].text : parts;
}

type OutputBlockUnion =
	| { type: "output_text"; text: string }
	| { type: "text"; text: string }
	| { type: "refusal"; refusal: string };

function outputTextOf(blocks: OpenAIResponsesOutputContent[] | string | undefined): TextContent[] {
	if (typeof blocks === "string") return blocks.length > 0 ? [{ type: "text", text: blocks }] : [];
	if (!blocks) return [];
	const out: TextContent[] = [];
	for (const raw of blocks) {
		const block = raw as OutputBlockUnion;
		if (block.type === "output_text" || block.type === "text") {
			out.push({ type: "text", text: block.text });
		} else if (block.type === "refusal") {
			// Preserve the refusal reason so history replay still carries it.
			out.push({ type: "text", text: `[refusal: ${block.refusal}]` });
		}
	}
	return out;
}

// The schema accepts a much wider tool_choice union than the SDK type so the
// walker narrows against the local schema shape.
type ParsedToolChoice =
	| "auto"
	| "none"
	| "required"
	| { type: "function"; name: string }
	| { type: "custom"; name: string }
	| {
			type:
				| "web_search_preview"
				| "file_search"
				| "computer_use_preview"
				| "code_interpreter"
				| "image_generation"
				| "mcp";
	  }
	| { type: "allowed_tools"; mode: "auto" | "required"; tools: Array<{ type: string; name?: string }> };

function mapToolChoice(value: ParsedToolChoice | undefined): ParsedRequest["options"]["toolChoice"] {
	if (value === undefined) return undefined;
	if (value === "auto" || value === "none" || value === "required") return value;
	if ("type" in value) {
		// `custom` (OpenAI code backend apply_patch) and `function` both resolve to the same
		// pi-ai shape: pi-ai's dispatcher matches `Tool.name` AND `customWireName`,
		// so passing the wire name works for either.
		if (value.type === "function" || value.type === "custom") return { name: value.name };
		// Hosted tools + allowed_tools — we don't surface these to pi-ai; fall
		// back to letting the model pick a tool freely.
		return "auto";
	}
	return undefined;
}

function buildTools(tools: Array<OpenAIResponsesTool | { type: string }> | undefined): Tool[] | undefined {
	if (!tools) return undefined;
	const out: Tool[] = [];
	for (const t of tools) {
		// Skip non-function tools (web_search, file_search, …).
		if (t.type !== "function") continue;
		const fn = t as Extract<OpenAIResponsesTool, { type: "function" }>;
		const tool: Tool = {
			name: fn.name,
			description: fn.description ?? "",
			parameters: (fn.parameters ?? {}) as Tool["parameters"],
		};
		if (fn.strict !== undefined && fn.strict !== null) tool.strict = fn.strict;
		out.push(tool);
	}
	return out.length > 0 ? out : undefined;
}

function ensureAssistantPlaceholder(messages: Message[], modelId: string, now: number): AssistantMessage {
	const last = messages[messages.length - 1];
	if (last && last.role === "assistant") return last;
	const placeholder: AssistantMessage = {
		role: "assistant",
		content: [],
		api: "openai-responses",
		provider: "openai",
		model: modelId,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: now,
	};
	messages.push(placeholder);
	return placeholder;
}

/** Flatten a function_call_output array form (text + refusal) into a single string. */
function flattenFunctionOutputArray(blocks: readonly unknown[]): string {
	const parts: string[] = [];
	for (const raw of blocks) {
		if (!isObj(raw)) continue;
		const t = raw.type;
		if (t === "output_text" || t === "text") {
			const text = asString(raw.text);
			if (text) parts.push(text);
		} else if (t === "refusal") {
			const refusal = asString(raw.refusal);
			if (refusal) parts.push(`[refusal: ${refusal}]`);
		}
	}
	return parts.join("");
}

// ─── parseRequest ───────────────────────────────────────────────────────────

export function parseRequest(body: unknown, headers?: Headers): ParsedRequest {
	// Header capture is centralized in `auth-gateway/server.ts` (the
	// allow-listed set lands on `options.headers` automatically). We also
	// consult `headers` here to populate `options.promptCacheKey` when the
	// client signals a cache identity outside the body — see the
	// `resolvePromptCacheKey` call further down.

	const parsed = openaiResponsesRequestSchema.safeParse(body);
	if (!parsed.success) {
		throw new Error(`openai-responses: ${parsed.error.message}`);
	}
	const data = parsed.data;

	const now = Date.now();
	const messages: Message[] = [];
	const systemPrompt: string[] = [];

	if (typeof data.instructions === "string" && data.instructions.length > 0) {
		systemPrompt.push(data.instructions);
	}

	if (typeof data.input === "string") {
		messages.push({ role: "user", content: data.input, timestamp: now });
	} else if (data.input) {
		for (const item of data.input) {
			// Items may omit `type` and rely on `role` (the convenience shape).
			const effectiveType = item.type ?? ("role" in item ? "message" : undefined);
			if (effectiveType === "message") {
				const msg = item as {
					role?: string;
					content?: OpenAIResponsesInputContent[] | OpenAIResponsesOutputContent[] | string;
				};
				switch (msg.role) {
					case "system": {
						const text = inputContentParts(msg.content as OpenAIResponsesInputContent[] | string | undefined);
						const flat = typeof text === "string" ? text : text.map(p => p.text).join("");
						if (flat.length > 0) systemPrompt.push(flat);
						break;
					}
					case "user":
					case "developer": {
						const content = inputContentParts(msg.content as OpenAIResponsesInputContent[] | string | undefined);
						messages.push({ role: msg.role, content, timestamp: now });
						break;
					}
					case "assistant": {
						const parts = outputTextOf(msg.content as OpenAIResponsesOutputContent[] | string | undefined);
						messages.push({
							role: "assistant",
							content: parts,
							api: "openai-responses",
							provider: "openai",
							model: data.model,
							usage: {
								input: 0,
								output: 0,
								cacheRead: 0,
								cacheWrite: 0,
								totalTokens: 0,
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
							},
							stopReason: "stop",
							timestamp: now,
						});
						break;
					}
				}
				continue;
			}
			if (effectiveType === "reasoning") {
				const reasoning = item as OpenAIResponsesReasoningItem;
				const content = reasoningContentFromItem(reasoning);
				const thinking: ThinkingContent = {
					type: "thinking",
					...content,
					thinkingSignature: JSON.stringify(reasoning),
					...(reasoning.id ? { itemId: reasoning.id } : {}),
				};
				ensureAssistantPlaceholder(messages, data.model, now).content.push(thinking);
				continue;
			}
			if (effectiveType === "function_call") {
				const call = item as OpenAIResponsesFunctionCallItem;
				const argsRaw = call.arguments ?? "{}";
				let args: Record<string, unknown>;
				try {
					const parsedArgs: unknown = JSON.parse(argsRaw);
					args = isObj(parsedArgs) ? parsedArgs : {};
				} catch {
					throw new Error(`openai-responses: function_call ${call.call_id} has invalid JSON arguments`);
				}
				const toolCall: ToolCall = {
					type: "toolCall",
					id: call.call_id,
					name: call.name,
					arguments: args,
					...(call.id ? { thoughtSignature: call.id } : {}),
				};
				ensureAssistantPlaceholder(messages, data.model, now).content.push(toolCall);
				continue;
			}
			if (effectiveType === "custom_tool_call") {
				const call = item as { id?: string; call_id: string; name: string; input: string };
				// Custom tools carry a raw input string. We stash it in `arguments.input`
				// matching pi-ai's openai-responses-shared convention, and tag the call
				// with `customWireName` so encoders re-emit it as `custom_tool_call`.
				const toolCall: ToolCall = {
					type: "toolCall",
					id: call.call_id,
					name: call.name,
					arguments: { input: call.input ?? "" },
					customWireName: call.name,
					...(call.id ? { thoughtSignature: call.id } : {}),
				};
				ensureAssistantPlaceholder(messages, data.model, now).content.push(toolCall);
				continue;
			}
			if (effectiveType === "function_call_output") {
				const output = item as OpenAIResponsesFunctionCallOutputItem;
				const toolName = findToolNameById(messages, output.call_id);
				const text =
					typeof output.output === "string"
						? output.output
						: Array.isArray(output.output)
							? flattenFunctionOutputArray(output.output)
							: "";
				messages.push({
					role: "toolResult",
					toolCallId: output.call_id,
					toolName,
					content: [{ type: "text", text }],
					isError: false,
					timestamp: now,
				});
				continue;
			}
			if (effectiveType === "custom_tool_call_output") {
				const output = item as { call_id: string; output: string };
				const toolName = findToolNameById(messages, output.call_id);
				messages.push({
					role: "toolResult",
					toolCallId: output.call_id,
					toolName,
					content: [{ type: "text", text: output.output ?? "" }],
					isError: false,
					timestamp: now,
				});
			}
			// Other item types are tolerated but not bridged.
		}
	}

	const tools = buildTools(data.tools);
	const context: Context = {
		...(systemPrompt.length > 0 ? { systemPrompt } : {}),
		messages,
		...(tools ? { tools } : {}),
	};

	const options: ParsedRequest["options"] = {};
	if (data.max_output_tokens !== undefined) options.maxOutputTokens = data.max_output_tokens;
	if (data.temperature !== undefined) options.temperature = data.temperature;
	if (data.top_p !== undefined) options.topP = data.top_p;
	if (data.stop !== undefined && data.stop !== null) {
		options.stopSequences = typeof data.stop === "string" ? [data.stop] : data.stop;
	}
	const toolChoice = mapToolChoice(data.tool_choice as ParsedToolChoice | undefined);
	if (toolChoice !== undefined) options.toolChoice = toolChoice;
	if (data.reasoning?.effort && isReasoningEffort(data.reasoning.effort)) {
		options.reasoning = data.reasoning.effort;
	}
	// OpenAI summary: `none` → suppress; `auto`/`concise`/`detailed` → request
	// visible summary. pi-ai has no per-level plumbing — log once and let the
	// provider default kick in.
	if (data.reasoning?.summary === "none") {
		options.hideThinkingSummary = true;
	} else if (
		data.reasoning?.summary === "auto" ||
		data.reasoning?.summary === "concise" ||
		data.reasoning?.summary === "detailed"
	) {
		if (!warnedReasoningSummaryLevel) {
			warnedReasoningSummaryLevel = true;
			logger.debug("openai-responses-server: reasoning.summary level not differentiated", {
				level: data.reasoning.summary,
			});
		}
	}
	if (data.service_tier !== undefined && isServiceTier(data.service_tier)) {
		options.serviceTier = data.service_tier;
	}
	if (data.presence_penalty !== undefined) options.presencePenalty = data.presence_penalty;
	if (data.frequency_penalty !== undefined) options.frequencyPenalty = data.frequency_penalty;
	if (data.parallel_tool_calls !== undefined) options.parallelToolCalls = data.parallel_tool_calls;
	const cacheKey = resolvePromptCacheKey(body, headers);
	if (cacheKey !== undefined) options.promptCacheKey = cacheKey;
	if (data.previous_response_id !== undefined) options.previousResponseId = data.previous_response_id;
	if (data.user !== undefined) options.user = data.user;
	if (isObj(data.metadata)) options.metadata = data.metadata;
	// `store` is a stateful-storage hint that gjc's gateway doesn't honour;
	// silently accepted by the schema. No typed slot — drop.

	return {
		modelId: data.model,
		context,
		stream: data.stream === true,
		options,
	};
}

function findToolNameById(messages: Message[], callId: string): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m.role !== "assistant") continue;
		for (const c of m.content) {
			if (c.type === "toolCall" && c.id === callId) return c.name;
		}
	}
	return "";
}

// ─── formatError ────────────────────────────────────────────────────────────

export function formatError(status: number, type: string, message: string): Response {
	return new Response(JSON.stringify({ error: { message, type } }), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

// ─── output item builders (shared by streaming + non-streaming encoders) ────

type ReasoningOutputItem = {
	type: "reasoning";
	id: string;
	summary: Array<{ type: "summary_text"; text: string }>;
} & Record<string, unknown>;

type MessageOutputItem = {
	type: "message";
	id: string;
	role: "assistant";
	status: "completed";
	content: Array<{ type: "output_text"; text: string; annotations: never[] }>;
};

type FunctionCallOutputItem = {
	type: "function_call";
	id: string;
	call_id: string;
	name: string;
	arguments: string;
	status: "completed";
};

type CustomToolCallOutputItem = {
	type: "custom_tool_call";
	id: string;
	call_id: string;
	name: string;
	input: string;
	status: "completed";
};

type OutputItem = ReasoningOutputItem | MessageOutputItem | FunctionCallOutputItem | CustomToolCallOutputItem;

type ResponseStatus = "completed" | "in_progress" | "failed" | "incomplete";

function responseStatusForStopReason(message: AssistantMessage): ResponseStatus {
	if (message.stopReason === "length") return "incomplete";
	if (message.stopReason === "error" || message.stopReason === "aborted") return "failed";
	return "completed";
}

/**
 * Privacy boundary for the public Responses envelope: a reasoning item's
 * `summary_text` must carry ONLY provider-displayable summary text, never raw
 * chain-of-thought. A summary is published ONLY for blocks explicitly marked
 * `provenance: "summary" | "mixed"` (the #2304 provenance path), sourced from
 * `summaryText`. Raw-provenance AND unmarked blocks are omitted: unmarked
 * `thinking` can be raw CoT from providers that stream unmarked reasoning (e.g.
 * openai-completions / ollama) which the auth gateway re-encodes into the
 * Responses wire format, so falling open to `part.thinking` would leak raw CoT.
 */
function envelopeSummaryText(part: ThinkingContent): string | undefined {
	if (part.provenance === "summary" || part.provenance === "mixed") return part.summaryText;
	return undefined;
}

function envelopeSummaryParts(part: ThinkingContent): Array<{ type: "summary_text"; text: string }> {
	const text = envelopeSummaryText(part);
	return text ? [{ type: "summary_text", text }] : [];
}

function normalizeSummaryParts(value: unknown): Array<{ type: "summary_text"; text: string }> {
	// A serialized signature's `summary` is, by the Responses protocol, provider-
	// displayable summary text (raw reasoning lives in content[]/encrypted_content,
	// which is stripped). Coerce to the canonical shape, keeping only well-formed
	// summary_text entries. This is NOT the unsafe `part.thinking` fallback.
	if (!Array.isArray(value)) return [];
	const out: Array<{ type: "summary_text"; text: string }> = [];
	for (const entry of value) {
		if (isObj(entry) && entry.type === "summary_text" && typeof entry.text === "string") {
			out.push({ type: "summary_text", text: entry.text });
		}
	}
	return out;
}

function buildReasoningItem(part: ThinkingContent): ReasoningOutputItem {
	const baseId = part.itemId ?? makeReasoningId();
	if (part.thinkingSignature) {
		try {
			const sigParsed: unknown = JSON.parse(part.thinkingSignature);
			if (isObj(sigParsed) && sigParsed.type === "reasoning") {
				const id = part.itemId ?? asString(sigParsed.id) ?? makeReasoningId();
				// Preserve any extra fields (encrypted_content, …) the original carried,
				// but normalize the summary into the canonical `{type, text}[]` shape.
				const merged: Record<string, unknown> = { ...sigParsed, type: "reasoning", id };
				merged.summary =
					part.provenance === "summary" || part.provenance === "mixed"
						? envelopeSummaryParts(part)
						: normalizeSummaryParts(sigParsed.summary);
				// Strip any `content[]` (raw `reasoning_text`) the serialized signature
				// carried: raw chain-of-thought must never surface in the public final
				// envelope (#2304 CoT boundary). Opaque top-level `encrypted_content`
				// (when present) is a separate field and is preserved by the spread above.
				delete merged.content;
				return merged as ReasoningOutputItem;
			}
		} catch {
			// Not a serialized Responses reasoning item; fall through to fresh build.
		}
	}
	return {
		type: "reasoning",
		id: baseId,
		summary: envelopeSummaryParts(part),
	};
}

function reasoningItemId(part: ThinkingContent): string {
	if (part.itemId) return part.itemId;
	if (part.thinkingSignature) {
		try {
			const sigParsed: unknown = JSON.parse(part.thinkingSignature);
			if (isObj(sigParsed)) {
				const id = asString(sigParsed.id);
				if (id) return id;
			}
		} catch {
			// Not a serialized Responses reasoning item.
		}
	}
	return makeReasoningId();
}

/**
 * Walk the assistant content array and group consecutive TextContent into a
 * single message item; each ThinkingContent / ToolCall is its own item.
 */
function buildOutputItems(message: AssistantMessage): OutputItem[] {
	const out: OutputItem[] = [];
	let pendingMessage: MessageOutputItem | null = null;
	const flushMessage = () => {
		if (pendingMessage) {
			out.push(pendingMessage);
			pendingMessage = null;
		}
	};

	for (const part of message.content) {
		if (part.type === "text") {
			if (!pendingMessage) {
				pendingMessage = {
					type: "message",
					id: makeMsgId(),
					role: "assistant",
					status: "completed",
					content: [],
				};
			}
			pendingMessage.content.push({ type: "output_text", text: part.text, annotations: [] });
		} else if (part.type === "thinking") {
			flushMessage();
			out.push(buildReasoningItem(part));
		} else if (part.type === "toolCall") {
			flushMessage();
			if (part.customWireName) {
				const rawInput =
					typeof part.arguments?.input === "string" ? (part.arguments.input as string).toWellFormed() : "";
				out.push({
					type: "custom_tool_call",
					id: part.thoughtSignature ?? makeCustomCallId(),
					call_id: part.id,
					name: part.customWireName,
					input: rawInput,
					status: "completed",
				});
			} else {
				out.push({
					type: "function_call",
					id: part.thoughtSignature ?? makeFuncCallId(),
					call_id: part.id,
					name: part.name,
					arguments: JSON.stringify(sanitizeJsonStrings(part.arguments ?? {})),
					status: "completed",
				});
			}
		}
		// RedactedThinking / Image are silently dropped — no direct Responses wire representation.
	}
	flushMessage();
	return out;
}

function buildUsage(message: AssistantMessage): Record<string, unknown> {
	const u = message.usage;
	const inputTokens = u.input + u.cacheRead + u.cacheWrite;
	return {
		input_tokens: inputTokens,
		input_tokens_details: { cached_tokens: u.cacheRead },
		output_tokens: u.output,
		output_tokens_details: { reasoning_tokens: u.reasoningTokens ?? 0 },
		total_tokens: inputTokens + u.output,
	};
}

function buildResponseEnvelope(
	message: AssistantMessage,
	requestedModelId: string,
	id: string,
	status: ResponseStatus,
	items: OutputItem[] | [],
	usage: Record<string, unknown> | null,
): Record<string, unknown> {
	return {
		id,
		object: "response",
		created_at: Math.floor(message.timestamp / 1000),
		status,
		model: requestedModelId,
		output: items,
		usage,
		...(status === "incomplete" ? { incomplete_details: { reason: "max_output_tokens" } } : {}),
		...(status === "failed" ? { error: { message: message.errorMessage ?? "response failed" } } : {}),
	};
}

// ─── encodeResponse (non-streaming) ─────────────────────────────────────────

export function encodeResponse(message: AssistantMessage, requestedModelId: string): Record<string, unknown> {
	const items = buildOutputItems(message);
	return buildResponseEnvelope(
		message,
		requestedModelId,
		makeRespId(),
		responseStatusForStopReason(message),
		items,
		buildUsage(message),
	);
}

// ─── encodeStream ───────────────────────────────────────────────────────────

interface OpenMessage {
	kind: "message";
	itemId: string;
	outputIndex: number;
	contentIndex: number;
	currentPartText: string;
	content: Array<{ type: "output_text"; text: string; annotations: never[] }>;
}
interface OpenReasoning {
	kind: "reasoning";
	itemId: string;
	outputIndex: number;
	summaryText: string;
	summaryPartText: string;
}
interface OpenFunctionCall {
	kind: "function_call";
	itemId: string;
	outputIndex: number;
	callId: string;
	name: string;
	argsText: string;
	/** Set when the underlying ToolCall is a custom-tool emission. */
	customWireName?: string;
}
type OpenItem = OpenMessage | OpenReasoning | OpenFunctionCall;

function sseEvent(name: string, data: unknown): string {
	return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function encodeStream(
	events: AssistantMessageEventStream,
	requestedModelId: string,
): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	const responseId = makeRespId();
	let sequenceNumber = 0;
	const seq = () => sequenceNumber++;

	return new ReadableStream<Uint8Array>({
		async start(controller) {
			const emit = (name: string, data: Record<string, unknown>) => {
				controller.enqueue(encoder.encode(sseEvent(name, { type: name, sequence_number: seq(), ...data })));
			};
			const emitDone = () => controller.enqueue(encoder.encode("data: [DONE]\n\n"));

			let createdAt = Math.floor(Date.now() / 1000);
			let outputIndex = 0;
			const state: { open: OpenItem | null } = { open: null };
			const finishedItems: OutputItem[] = [];

			const responseSnapshot = (status: ResponseStatus, output: OutputItem[] | []) => ({
				id: responseId,
				object: "response",
				created_at: createdAt,
				status,
				model: requestedModelId,
				output,
				usage: null,
			});

			const openMessage = (): OpenMessage => {
				const itemId = makeMsgId();
				const item = {
					type: "message" as const,
					id: itemId,
					status: "in_progress",
					role: "assistant" as const,
					content: [] as Array<{ type: "output_text"; text: string; annotations: never[] }>,
				};
				emit("response.output_item.added", { output_index: outputIndex, item });
				const next: OpenMessage = {
					kind: "message",
					itemId,
					outputIndex,
					contentIndex: 0,
					currentPartText: "",
					content: [],
				};
				state.open = next;
				return next;
			};

			const openReasoning = (partial: AssistantMessage, contentIndex: number): OpenReasoning => {
				const part = partial.content[contentIndex];
				const itemId = part && part.type === "thinking" ? reasoningItemId(part) : makeReasoningId();
				const item = {
					type: "reasoning" as const,
					id: itemId,
					summary: [] as Array<{ type: "summary_text"; text: string }>,
				};
				emit("response.output_item.added", { output_index: outputIndex, item });
				const next: OpenReasoning = {
					kind: "reasoning",
					itemId,
					outputIndex,
					summaryText: "",
					summaryPartText: "",
				};
				state.open = next;
				return next;
			};

			const openToolCall = (partial: AssistantMessage, contentIndex: number): OpenFunctionCall => {
				const part = partial.content[contentIndex];
				const tc = part && part.type === "toolCall" ? part : undefined;
				const customWireName: string | undefined =
					tc && typeof tc.customWireName === "string" && tc.customWireName.length > 0
						? tc.customWireName
						: undefined;
				const isCustom = customWireName !== undefined;
				const itemId = tc?.thoughtSignature ?? (isCustom ? makeCustomCallId() : makeFuncCallId());
				const callId = tc?.id ?? "";
				const name = customWireName ?? tc?.name ?? "";
				const item = isCustom
					? {
							type: "custom_tool_call" as const,
							id: itemId,
							call_id: callId,
							name,
							input: "",
							status: "in_progress",
						}
					: {
							type: "function_call" as const,
							id: itemId,
							call_id: callId,
							name,
							arguments: "",
							status: "in_progress",
						};
				emit("response.output_item.added", { output_index: outputIndex, item });
				const next: OpenFunctionCall = {
					kind: "function_call",
					itemId,
					outputIndex,
					callId,
					name,
					argsText: "",
					...(isCustom ? { customWireName } : {}),
				};
				state.open = next;
				return next;
			};

			const closeOpen = () => {
				if (!state.open) return;
				if (state.open.kind === "message") {
					const item = {
						type: "message",
						id: state.open.itemId,
						status: "completed",
						role: "assistant",
						content: state.open.content,
					};
					emit("response.output_item.done", { output_index: state.open.outputIndex, item });
					finishedItems.push({
						type: "message",
						id: state.open.itemId,
						role: "assistant",
						status: "completed",
						content: state.open.content,
					});
				} else if (state.open.kind === "reasoning") {
					const summary = state.open.summaryText
						? [{ type: "summary_text" as const, text: state.open.summaryText }]
						: [];
					// Final reasoning envelope carries the displayable summary ONLY. Raw
					// chain-of-thought is streamed live via response.reasoning_text.delta
					// (the internal raw channel) and is deliberately NOT persisted into the
					// terminal item's content[] — the public final envelope must never carry
					// raw CoT (#2304 CoT boundary).
					const item: ReasoningOutputItem = {
						type: "reasoning",
						id: state.open.itemId,
						summary,
					};
					emit("response.output_item.done", { output_index: state.open.outputIndex, item });
					finishedItems.push(item);
				} else {
					const text = state.open.argsText ?? "";
					if (state.open.customWireName) {
						const item = {
							type: "custom_tool_call",
							id: state.open.itemId,
							call_id: state.open.callId ?? "",
							name: state.open.customWireName,
							input: text,
							status: "completed",
						};
						emit("response.output_item.done", { output_index: state.open.outputIndex, item });
						finishedItems.push({
							type: "custom_tool_call",
							id: state.open.itemId,
							call_id: state.open.callId ?? "",
							name: state.open.customWireName,
							input: text,
							status: "completed",
						});
					} else {
						const item = {
							type: "function_call",
							id: state.open.itemId,
							call_id: state.open.callId ?? "",
							name: state.open.name ?? "",
							arguments: text,
							status: "completed",
						};
						emit("response.output_item.done", { output_index: state.open.outputIndex, item });
						finishedItems.push({
							type: "function_call",
							id: state.open.itemId,
							call_id: state.open.callId ?? "",
							name: state.open.name ?? "",
							arguments: text,
							status: "completed",
						});
					}
				}
				outputIndex++;
				state.open = null;
			};

			try {
				let finalMessage: AssistantMessage | null = null;
				let failureMessage: AssistantMessage | null = null;

				for await (const ev of events) {
					switch (ev.type) {
						case "start": {
							createdAt = Math.floor((ev.partial.timestamp || Date.now()) / 1000);
							// response.created — initial envelope.
							controller.enqueue(
								encoder.encode(
									sseEvent("response.created", {
										type: "response.created",
										sequence_number: seq(),
										response: responseSnapshot("in_progress", []),
									}),
								),
							);
							// response.in_progress — mirrors real OpenAI; some clients gate
							// on it before reading items.
							controller.enqueue(
								encoder.encode(
									sseEvent("response.in_progress", {
										type: "response.in_progress",
										sequence_number: seq(),
										response: responseSnapshot("in_progress", []),
									}),
								),
							);
							break;
						}
						case "text_start": {
							let cur: OpenMessage;
							if (state.open && state.open.kind === "message") {
								// continue same message item, new content part
								cur = state.open;
								cur.currentPartText = "";
							} else {
								if (state.open) closeOpen();
								cur = openMessage();
							}
							const part = { type: "output_text", text: "", annotations: [] as never[] };
							emit("response.content_part.added", {
								item_id: cur.itemId,
								output_index: cur.outputIndex,
								content_index: cur.contentIndex,
								part,
							});
							break;
						}
						case "text_delta": {
							if (state.open?.kind !== "message") break;
							const cur: OpenMessage = state.open;
							cur.currentPartText += ev.delta;
							emit("response.output_text.delta", {
								item_id: cur.itemId,
								output_index: cur.outputIndex,
								content_index: cur.contentIndex,
								delta: ev.delta,
								logprobs: [],
							});
							// TODO: when pi-ai surfaces output_text annotations
							// (web_search citations, …), emit
							// `response.output_text.annotation.added` here.
							break;
						}
						case "text_end": {
							if (state.open?.kind !== "message") break;
							const cur: OpenMessage = state.open;
							const text = ev.content ?? cur.currentPartText;
							emit("response.output_text.done", {
								item_id: cur.itemId,
								output_index: cur.outputIndex,
								content_index: cur.contentIndex,
								text,
								logprobs: [],
							});
							cur.content.push({ type: "output_text", text, annotations: [] });
							emit("response.content_part.done", {
								item_id: cur.itemId,
								output_index: cur.outputIndex,
								content_index: cur.contentIndex,
								part: { type: "output_text", text, annotations: [] },
							});
							cur.contentIndex += 1;
							cur.currentPartText = "";
							break;
						}
						case "thinking_start": {
							if (state.open) closeOpen();
							openReasoning(ev.partial, ev.contentIndex);
							break;
						}
						case "thinking_delta": {
							// Raw reasoning is private. The public Responses gateway emits only
							// provider-displayable reasoning_summary_* events.
							break;
						}
						case "thinking_end": {
							if (state.open?.kind !== "reasoning") break;
							// Raw reasoning is intentionally omitted from every public gateway
							// frame. Only reasoning_summary_* events populate the terminal item.
							closeOpen();
							break;
						}
						case "reasoning_summary_start": {
							if (state.open?.kind !== "reasoning") break;
							const cur: OpenReasoning = state.open;
							cur.summaryPartText = "";
							emit("response.reasoning_summary_part.added", {
								item_id: cur.itemId,
								output_index: cur.outputIndex,
								summary_index: 0,
								part: { type: "summary_text", text: "" },
							});
							break;
						}
						case "reasoning_summary_delta": {
							if (state.open?.kind !== "reasoning") break;
							const cur: OpenReasoning = state.open;
							cur.summaryPartText += ev.delta;
							cur.summaryText += ev.delta;
							emit("response.reasoning_summary_text.delta", {
								item_id: cur.itemId,
								output_index: cur.outputIndex,
								summary_index: 0,
								delta: ev.delta,
							});
							break;
						}
						case "reasoning_summary_end": {
							if (state.open?.kind !== "reasoning") break;
							const cur: OpenReasoning = state.open;
							const text = ev.content ?? cur.summaryPartText;
							// A separator-only accumulated summary (e.g. a part.done "\n\n" before any
							// real text) is treated as empty so the real end content wins.
							if (!cur.summaryText.trim()) cur.summaryText = text;
							emit("response.reasoning_summary_text.done", {
								item_id: cur.itemId,
								output_index: cur.outputIndex,
								summary_index: 0,
								text,
							});
							emit("response.reasoning_summary_part.done", {
								item_id: cur.itemId,
								output_index: cur.outputIndex,
								summary_index: 0,
								part: { type: "summary_text", text },
							});
							break;
						}
						case "toolcall_start": {
							if (state.open) closeOpen();
							openToolCall(ev.partial, ev.contentIndex);
							break;
						}
						case "toolcall_delta": {
							if (state.open?.kind !== "function_call") break;
							const cur: OpenFunctionCall = state.open;
							cur.argsText += ev.delta;
							if (cur.customWireName) {
								emit("response.custom_tool_call_input.delta", {
									item_id: cur.itemId,
									output_index: cur.outputIndex,
									delta: ev.delta,
								});
							} else {
								emit("response.function_call_arguments.delta", {
									item_id: cur.itemId,
									output_index: cur.outputIndex,
									delta: ev.delta,
								});
							}
							break;
						}
						case "toolcall_end": {
							if (state.open?.kind !== "function_call") break;
							const cur: OpenFunctionCall = state.open;
							// Promote possibly-late info from the canonical ToolCall.
							const tc = ev.toolCall;
							if (tc.customWireName && !cur.customWireName) cur.customWireName = tc.customWireName;
							if (tc.thoughtSignature) cur.itemId = tc.thoughtSignature;
							cur.callId = tc.id;
							cur.name = cur.customWireName ?? tc.name;
							if (cur.customWireName) {
								// Custom tool: raw input string. Streamed deltas accumulated
								// the wire-level body; fall back to `arguments.input` from
								// the finalized ToolCall when nothing streamed (rare).
								const rawInput =
									cur.argsText ||
									(typeof tc.arguments?.input === "string" ? (tc.arguments.input as string) : "");
								cur.argsText = rawInput;
								emit("response.custom_tool_call_input.done", {
									item_id: cur.itemId,
									output_index: cur.outputIndex,
									input: rawInput,
									name: cur.name,
								});
							} else {
								// Standard JSON tool: arguments object on the gjc side, the
								// wire wants the JSON string the model emitted (= streamed deltas).
								const argsJson =
									cur.argsText.toWellFormed() || JSON.stringify(sanitizeJsonStrings(tc.arguments ?? {}));
								cur.argsText = argsJson;
								emit("response.function_call_arguments.done", {
									item_id: cur.itemId,
									output_index: cur.outputIndex,
									arguments: argsJson,
									name: cur.name,
								});
							}
							closeOpen();
							break;
						}
						case "done": {
							finalMessage = ev.message;
							break;
						}
						case "error": {
							failureMessage = ev.error;
							break;
						}
					}
				}

				if (failureMessage) {
					if (state.open) closeOpen();
					controller.enqueue(
						encoder.encode(
							sseEvent("response.failed", {
								type: "response.failed",
								sequence_number: seq(),
								response: {
									...responseSnapshot("failed", finishedItems),
									error: { message: failureMessage.errorMessage ?? "stream failed" },
								},
							}),
						),
					);
					emitDone();
					controller.close();
					return;
				}

				if (state.open) closeOpen();
				const message = finalMessage ?? ((await events.result().catch(() => null)) as AssistantMessage | null);

				// Build the canonical output from the final message so non-streaming
				// readers see the exact same shape they'd get from encodeResponse().
				const items = message ? buildOutputItems(message) : finishedItems;
				const usage = message ? buildUsage(message) : null;
				const status = message ? responseStatusForStopReason(message) : "completed";
				const terminalEvent =
					status === "incomplete"
						? "response.incomplete"
						: status === "failed"
							? "response.failed"
							: "response.completed";
				controller.enqueue(
					encoder.encode(
						sseEvent(terminalEvent, {
							type: terminalEvent,
							sequence_number: seq(),
							response: {
								id: responseId,
								object: "response",
								created_at: createdAt,
								status,
								model: requestedModelId,
								output: items,
								usage,
								...(status === "incomplete" ? { incomplete_details: { reason: "max_output_tokens" } } : {}),
								...(status === "failed"
									? { error: { message: message?.errorMessage ?? "response failed" } }
									: {}),
							},
						}),
					),
				);
				emitDone();
				controller.close();
			} catch (err) {
				controller.enqueue(
					encoder.encode(
						sseEvent("response.failed", {
							type: "response.failed",
							sequence_number: seq(),
							response: {
								id: responseId,
								object: "response",
								created_at: Math.floor(Date.now() / 1000),
								status: "failed",
								model: requestedModelId,
								output: [],
								error: { message: err instanceof Error ? err.message : String(err) },
							},
						}),
					),
				);
				emitDone();
				controller.close();
			}
		},
	});
}
