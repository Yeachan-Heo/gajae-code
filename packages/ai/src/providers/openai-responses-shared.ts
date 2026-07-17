import { structuredCloneJSON } from "@gajae-code/utils";
import type OpenAI from "openai";
import type {
	ResponseCustomToolCall,
	ResponseFunctionToolCall,
	ResponseInput,
	ResponseInputContent,
	ResponseInputImage,
	ResponseInputText,
	ResponseOutputItem,
	ResponseOutputMessage,
	ResponseReasoningItem,
} from "openai/resources/responses/responses";
import { calculateCost } from "../models";
import {
	type Api,
	type AssistantMessage,
	type ImageContent,
	type Model,
	resolveServiceTier,
	type ServiceTier,
	type StopReason,
	type StreamOptions,
	shouldSendServiceTier,
	type TextContent,
	type TextSignatureV1,
	type ThinkingContent,
	type ToolCall,
	type ToolResultMessage,
} from "../types";
import { normalizeResponsesToolCallId, sanitizeJsonStrings } from "../utils";
import type { AssistantMessageEventStream } from "../utils/event-stream";
import { isCompleteJson, parseStreamingJson } from "../utils/json-parse";
import { joinTextWithImagePlaceholder, NON_VISION_IMAGE_PLACEHOLDER, partitionVisionContent } from "./vision-guard";

export function encodeTextSignatureV1(id: string, phase?: TextSignatureV1["phase"]): string {
	const payload: TextSignatureV1 = { v: 1, id };
	if (phase) payload.phase = phase;
	return JSON.stringify(payload);
}

export function parseTextSignature(
	signature: string | undefined,
): { id: string; phase?: TextSignatureV1["phase"] } | undefined {
	if (!signature) return undefined;
	if (signature.startsWith("{")) {
		try {
			const parsed = JSON.parse(signature) as Partial<TextSignatureV1>;
			if (parsed.v === 1 && typeof parsed.id === "string") {
				if (parsed.phase === "commentary" || parsed.phase === "final_answer") {
					return { id: parsed.id, phase: parsed.phase };
				}
				return { id: parsed.id };
			}
		} catch {
			// Fall through to legacy plain-string handling.
		}
	}
	return { id: signature };
}

export function encodeResponsesToolCallId(callId: string, itemId: string | null | undefined): string {
	const stableItemId = itemId && itemId.length > 0 ? itemId : `fc_${Bun.hash(callId).toString(36)}`;
	return `${callId}|${stableItemId}`;
}

export function normalizeResponsesToolCallIdForTransform(
	id: string,
	model?: Model<Api>,
	source?: AssistantMessage,
): string {
	if (!id.includes("|")) return id;
	const isForeignToolCall =
		source != null && model != null && (source.provider !== model.provider || source.api !== model.api);
	if (isForeignToolCall) {
		const [callId, itemId] = id.split("|");
		const normalizeIdPart = (part: string): string => {
			const sanitized = part.replace(/[^a-zA-Z0-9_-]/g, "_");
			const truncated = sanitized.length > 64 ? sanitized.slice(0, 64) : sanitized;
			return truncated.replace(/_+$/, "");
		};
		const normalizedCallId = normalizeIdPart(callId);
		let normalizedItemId = `fc_${Bun.hash(itemId).toString(36)}`;
		if (normalizedItemId.length > 64) normalizedItemId = normalizedItemId.slice(0, 64);
		return `${normalizedCallId}|${normalizedItemId}`;
	}
	const normalized = normalizeResponsesToolCallId(id);
	return `${normalized.callId}|${normalized.itemId}`;
}

export function collectKnownCallIds(messages: ResponseInput): Set<string> {
	const knownCallIds = new Set<string>();
	for (const item of messages) {
		if (item.type === "function_call" && typeof item.call_id === "string") {
			knownCallIds.add(item.call_id);
		} else if (
			(item as { type?: string }).type === "custom_tool_call" &&
			typeof (item as { call_id?: string }).call_id === "string"
		) {
			knownCallIds.add((item as { call_id: string }).call_id);
		}
	}
	return knownCallIds;
}

/** Scan replay items for call_ids that were originally custom tool calls. */
export function collectCustomCallIds(messages: ResponseInput): Set<string> {
	const customCallIds = new Set<string>();
	for (const item of messages) {
		if (
			(item as { type?: string }).type === "custom_tool_call" &&
			typeof (item as { call_id?: string }).call_id === "string"
		) {
			customCallIds.add((item as { call_id: string }).call_id);
		}
	}
	return customCallIds;
}

/**
 * Convert orphan `function_call_output` / `custom_tool_call_output` items —
 * those whose `call_id` has no matching preceding `function_call` /
 * `custom_tool_call` in the same input — into assistant text notes.
 *
 * The Responses API rejects unpaired outputs with
 * `400 No tool call found for function call output with call_id …`. Orphans
 * sneak in through two paths today:
 *
 * - A previous turn's `providerPayload` snapshot replaces the input array via
 *   the `dt: false` splice (see {@link convertConversationMessages}), wiping
 *   the matching `function_call` while leaving the matching
 *   `function_call_output` queued in a later `toolResult`.
 * - A locally-rejected tool call (argument-validation failure, hook reject,
 *   aborted turn before the call streamed) produces a tool result without a
 *   `function_call` ever landing in any persisted provider payload.
 *
 * Dropping the result loses information the model needs to recover; sending
 * it as-is 400s the request. Folding it into an assistant `message` preserves
 * the payload (call_id + truncated output) while staying within the Responses
 * input grammar. Matches the behavior of {@link transformRequestBody} in the
 * OpenAI code backend provider — issue #1351 / regression of #472.
 */
export function repairOrphanResponsesToolOutputs(input: ResponseInput): ResponseInput {
	const knownCallIds = new Set<string>();
	for (const item of input) {
		const t = (item as { type?: string }).type;
		const callId = (item as { call_id?: unknown }).call_id;
		if (typeof callId !== "string") continue;
		if (t === "function_call" || t === "custom_tool_call") knownCallIds.add(callId);
	}
	let hasOrphan = false;
	for (const item of input) {
		const t = (item as { type?: string }).type;
		if (t !== "function_call_output" && t !== "custom_tool_call_output") continue;
		const callId = (item as { call_id?: unknown }).call_id;
		if (typeof callId === "string" && !knownCallIds.has(callId)) {
			hasOrphan = true;
			break;
		}
	}
	if (!hasOrphan) return input;
	return input.map(item => {
		const t = (item as { type?: string }).type;
		if (t !== "function_call_output" && t !== "custom_tool_call_output") return item;
		const record = item as { call_id?: unknown; output?: unknown; name?: unknown };
		const callId = record.call_id;
		if (typeof callId !== "string" || knownCallIds.has(callId)) return item;
		const toolName = typeof record.name === "string" && record.name.length > 0 ? record.name : "tool";
		const rawOutput = record.output;
		let text: string;
		if (typeof rawOutput === "string") text = rawOutput;
		else if (rawOutput == null) text = "";
		else {
			try {
				text = JSON.stringify(rawOutput);
			} catch {
				text = String(rawOutput);
			}
		}
		const ORPHAN_OUTPUT_LIMIT = 16_000;
		if (text.length > ORPHAN_OUTPUT_LIMIT) text = `${text.slice(0, ORPHAN_OUTPUT_LIMIT)}\n...[truncated]`;
		return {
			type: "message",
			role: "assistant",
			content: `[Orphan ${toolName} result; call_id=${callId}]: ${text}`,
		} as ResponseInput[number];
	});
}

export function convertResponsesInputContent(
	content: string | Array<TextContent | ImageContent>,
	supportsImages: boolean,
): ResponseInputContent[] | undefined {
	if (typeof content === "string") {
		if (content.trim().length === 0) return undefined;
		return [{ type: "input_text", text: content.toWellFormed() } satisfies ResponseInputText];
	}

	const { textBlocks, imageBlocks, omittedImages } = partitionVisionContent(content, supportsImages);
	const normalizedContent: ResponseInputContent[] = [];
	for (const item of textBlocks) {
		const text = item.text.toWellFormed();
		if (text.trim().length === 0) continue;
		normalizedContent.push({
			type: "input_text",
			text,
		} satisfies ResponseInputText);
	}
	for (const item of imageBlocks) {
		normalizedContent.push({
			type: "input_image",
			detail: "auto",
			image_url: `data:${item.mimeType};base64,${item.data}`,
		} satisfies ResponseInputImage);
	}
	if (omittedImages) {
		normalizedContent.push({
			type: "input_text",
			text: NON_VISION_IMAGE_PLACEHOLDER,
		} satisfies ResponseInputText);
	}
	return normalizedContent.length > 0 ? normalizedContent : undefined;
}

export function convertResponsesAssistantMessage<TApi extends Api>(
	assistantMsg: AssistantMessage,
	model: Model<TApi>,
	msgIndex: number,
	knownCallIds: Set<string>,
	includeThinkingSignatures = true,
	customCallIds?: Set<string>,
): ResponseInput {
	const outputItems: ResponseInput = [];
	const isDifferentModel =
		assistantMsg.model !== model.id && assistantMsg.provider === model.provider && assistantMsg.api === model.api;

	for (const block of assistantMsg.content) {
		if (block.type === "thinking" && assistantMsg.stopReason !== "error") {
			if (!includeThinkingSignatures) {
				continue;
			}
			if (block.thinkingSignature) {
				outputItems.push(JSON.parse(block.thinkingSignature) as ResponseReasoningItem);
			}
			continue;
		}

		if (block.type === "text") {
			const parsedSignature = parseTextSignature(block.textSignature);
			let msgId = parsedSignature?.id;
			if (!msgId) {
				msgId = `msg_${msgIndex}`;
			} else if (msgId.length > 64) {
				msgId = `msg_${Bun.hash(msgId).toString(36)}`;
			}
			outputItems.push({
				type: "message",
				role: "assistant",
				content: [{ type: "output_text", text: block.text.toWellFormed(), annotations: [] }],
				status: "completed",
				id: msgId,
				phase: parsedSignature?.phase,
			} satisfies ResponseOutputMessage);
			continue;
		}

		if (block.type !== "toolCall") {
			continue;
		}

		const normalized = normalizeResponsesToolCallId(block.id, block.customWireName ? "ctc" : "fc");
		let itemId: string | undefined = normalized.itemId;
		if (isDifferentModel && (itemId?.startsWith("fc_") || itemId?.startsWith("fcr_") || itemId?.startsWith("ctc_"))) {
			itemId = undefined;
		}
		knownCallIds.add(normalized.callId);
		if (block.customWireName) {
			const rawInput = typeof block.arguments?.input === "string" ? block.arguments.input.toWellFormed() : "";
			customCallIds?.add(normalized.callId);
			outputItems.push({
				type: "custom_tool_call",
				id: itemId,
				call_id: normalized.callId,
				name: block.customWireName,
				input: rawInput,
			} as ResponseInput[number]);
			continue;
		}
		outputItems.push({
			type: "function_call",
			id: itemId,
			call_id: normalized.callId,
			name: block.name,
			arguments: JSON.stringify(sanitizeJsonStrings(block.arguments ?? {})),
		});
	}

	return outputItems;
}

export function appendResponsesToolResultMessages<TApi extends Api>(
	messages: ResponseInput,
	toolResult: ToolResultMessage,
	model: Model<TApi>,
	strictResponsesPairing: boolean,
	knownCallIds: ReadonlySet<string>,
	customCallIds?: ReadonlySet<string>,
): void {
	const supportsImages = model.input.includes("image");
	const textResult = toolResult.content
		.filter((block): block is TextContent => block.type === "text")
		.map(block => block.text)
		.join("\n");
	const hasImages = toolResult.content.some((block): block is ImageContent => block.type === "image");
	const omittedImages = hasImages && !supportsImages;
	const normalized = normalizeResponsesToolCallId(toolResult.toolCallId);
	if (strictResponsesPairing && !knownCallIds.has(normalized.callId)) {
		return;
	}

	const output = (
		omittedImages
			? joinTextWithImagePlaceholder(textResult, true)
			: textResult.length > 0
				? textResult
				: "(see attached image)"
	).toWellFormed();
	if (customCallIds?.has(normalized.callId)) {
		messages.push({
			type: "custom_tool_call_output",
			call_id: normalized.callId,
			output,
		} as ResponseInput[number]);
	} else {
		messages.push({
			type: "function_call_output",
			call_id: normalized.callId,
			output,
		});
	}

	if (!hasImages || !supportsImages) {
		return;
	}

	const contentParts: ResponseInputContent[] = [
		{ type: "input_text", text: "Attached image(s) from tool result:" } satisfies ResponseInputText,
	];
	for (const block of toolResult.content) {
		if (block.type === "image") {
			contentParts.push({
				type: "input_image",
				detail: "auto",
				image_url: `data:${block.mimeType};base64,${block.data}`,
			} satisfies ResponseInputImage);
		}
	}
	messages.push({ role: "user", content: contentParts });
}

export interface ProcessResponsesStreamOptions {
	onFirstToken?: () => void;
	onOutputItemDone?: (item: ResponseOutputItem) => void;
}

export async function processResponsesStream<TApi extends Api>(
	openaiStream: AsyncIterable<OpenAI.Responses.ResponseStreamEvent>,
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	model: Model<TApi>,
	options?: ProcessResponsesStreamOptions,
): Promise<void> {
	type StreamItem = ResponseReasoningItem | ResponseOutputMessage | ResponseFunctionToolCall | ResponseCustomToolCall;
	type StreamBlock = ThinkingContent | TextContent | (ToolCall & { partialJson: string });
	interface ItemEntry {
		item: StreamItem;
		block: StreamBlock;
		blockContentIndex: number;
		summaryBuffer: string;
		rawBuffer: string;
		summaryStarted: boolean;
	}
	// Per-item argument buffer keyed on stable item identity. Multiple tool-call
	// items can stream interleaved argument deltas in one response, so a single
	// most-recent slot would mis-attribute deltas to the wrong item.
	const items = new Map<string, ItemEntry>();
	let lastKey: string | null = null;
	const idKey = (id: string) => `id:${id}`;
	const idxKey = (n: number) => `idx:${n}`;
	const hasIndex = (n: number | undefined): n is number => typeof n === "number" && Number.isFinite(n);
	const resolveEntry = (
		itemId: string | undefined,
		outputIndex: number | undefined,
		// Fallback to the most-recently-added entry (`lastKey`) when the event
		// cannot be resolved by identity:
		//  - "never": tool ghost events with an explicit but unmatched key are ignored.
		//  - "no-key": only when BOTH item_id and a finite output_index are absent —
		//    the legacy single continuation-style tool delta/done shape.
		//  - "always": continuation-style non-tool events (reasoning/text), which may
		//    legitimately omit identity and target the open block.
		fallback: "never" | "no-key" | "always",
	): ItemEntry | undefined => {
		if (itemId) {
			const byId = items.get(idKey(itemId));
			if (byId) return byId;
		}
		if (hasIndex(outputIndex)) {
			const byIdx = items.get(idxKey(outputIndex));
			if (byIdx) return byIdx;
		}
		const hasExplicitKey = !!itemId || hasIndex(outputIndex);
		const allowLastKey = fallback === "always" || (fallback === "no-key" && !hasExplicitKey);
		if (allowLastKey && lastKey) return items.get(lastKey);
		return undefined;
	};
	const registerEntry = (item: StreamItem, block: StreamBlock, outputIndex: number | undefined): ItemEntry => {
		output.content.push(block);
		const entry: ItemEntry = {
			item,
			block,
			blockContentIndex: output.content.length - 1,
			summaryBuffer: "",
			rawBuffer: "",
			summaryStarted: false,
		};
		// Primary key prefers the stable item id; if the wire omits it, fall back to
		// the positional index. A synthetic key keeps the entry addressable as lastKey
		// for continuation-style non-tool events even when neither is present.
		const key = item.id ? idKey(item.id) : hasIndex(outputIndex) ? idxKey(outputIndex) : `seq:${items.size}`;
		items.set(key, entry);
		if (item.id && hasIndex(outputIndex)) items.set(idxKey(outputIndex), entry);
		lastKey = key;
		return entry;
	};
	const dropEntry = (itemId: string | undefined, outputIndex: number | undefined): void => {
		const key = itemId ? idKey(itemId) : hasIndex(outputIndex) ? idxKey(outputIndex) : null;
		if (key) {
			items.delete(key);
			if (lastKey === key) lastKey = null;
		}
		if (itemId && hasIndex(outputIndex)) items.delete(idxKey(outputIndex));
	};
	let sawFirstToken = false;

	for await (const event of openaiStream) {
		if (event.type === "response.created") {
			output.responseId = event.response.id;
		} else if (event.type === "response.output_item.added") {
			if (!sawFirstToken) {
				sawFirstToken = true;
				options?.onFirstToken?.();
			}
			const item = event.item;
			const outputIndex = event.output_index;
			if (item.type === "reasoning") {
				const block: ThinkingContent = { type: "thinking", thinking: "", itemId: item.id };
				const entry = registerEntry(item, block, outputIndex);
				stream.push({ type: "thinking_start", contentIndex: entry.blockContentIndex, partial: output });
			} else if (item.type === "message") {
				const block: TextContent = { type: "text", text: "" };
				const entry = registerEntry(item, block, outputIndex);
				stream.push({ type: "text_start", contentIndex: entry.blockContentIndex, partial: output });
			} else if (item.type === "function_call") {
				const block: ToolCall & { partialJson: string } = {
					type: "toolCall",
					id: encodeResponsesToolCallId(item.call_id, item.id),
					name: item.name,
					arguments: {},
					partialJson: item.arguments || "",
				};
				const entry = registerEntry(item, block, outputIndex);
				stream.push({ type: "toolcall_start", contentIndex: entry.blockContentIndex, partial: output });
			} else if (item.type === "custom_tool_call") {
				const block: ToolCall & { partialJson: string } = {
					type: "toolCall",
					id: encodeResponsesToolCallId(item.call_id, item.id),
					// Preserve the raw wire name (e.g. `apply_patch`). The agent-loop
					// dispatcher matches it against both `Tool.name` and
					// `Tool.customWireName`, so this stays wire-accurate through
					// history replay while still routing to the right handler.
					name: item.name,
					arguments: { input: item.input ?? "" },
					customWireName: item.name,
					// Custom tools stream a raw string, but we reuse `partialJson` as the
					// accumulation buffer so later code that inspects the field still works.
					partialJson: item.input ?? "",
				};
				const entry = registerEntry(item, block, outputIndex);
				stream.push({ type: "toolcall_start", contentIndex: entry.blockContentIndex, partial: output });
			}
		} else if (event.type === "response.reasoning_summary_part.added") {
			const entry = resolveEntry(event.item_id, event.output_index, "always");
			if (entry?.item.type === "reasoning" && entry.block.type === "thinking") {
				entry.item.summary = entry.item.summary || [];
				entry.item.summary.push(event.part);
				if (!entry.summaryStarted) {
					entry.summaryStarted = true;
					stream.push({ type: "reasoning_summary_start", contentIndex: entry.blockContentIndex, partial: output });
				}
			}
		} else if (event.type === "response.reasoning_summary_text.delta") {
			const entry = resolveEntry(event.item_id, event.output_index, "always");
			if (entry?.item.type === "reasoning" && entry.block.type === "thinking") {
				entry.item.summary = entry.item.summary || [];
				const lastPart = entry.item.summary[entry.item.summary.length - 1];
				if (lastPart) {
					entry.block.thinking += event.delta;
					entry.summaryBuffer += event.delta;
					lastPart.text += event.delta;
					stream.push({
						type: "reasoning_summary_delta",
						contentIndex: entry.blockContentIndex,
						delta: event.delta,
						partial: output,
					});
				}
			}
		} else if (event.type === "response.reasoning_summary_part.done") {
			const entry = resolveEntry(event.item_id, event.output_index, "always");
			if (entry?.item.type === "reasoning" && entry.block.type === "thinking") {
				entry.item.summary = entry.item.summary || [];
				const lastPart = entry.item.summary[entry.item.summary.length - 1];
				if (lastPart) {
					entry.block.thinking += "\n\n";
					entry.summaryBuffer += "\n\n";
					lastPart.text += "\n\n";
					stream.push({
						type: "reasoning_summary_delta",
						contentIndex: entry.blockContentIndex,
						delta: "\n\n",
						partial: output,
					});
				}
			}
		} else if (event.type === "response.reasoning_text.delta") {
			// Raw reasoning text delta from local providers that stream thinking
			// directly rather than via the OpenAI summary tracking protocol.
			const entry = resolveEntry(event.item_id, event.output_index, "always");
			if (entry?.item.type === "reasoning" && entry.block.type === "thinking") {
				entry.block.thinking += event.delta;
				entry.rawBuffer += event.delta;
				stream.push({
					type: "thinking_delta",
					contentIndex: entry.blockContentIndex,
					delta: event.delta,
					partial: output,
				});
			}
		} else if (event.type === "response.content_part.added") {
			const entry = resolveEntry(event.item_id, event.output_index, "always");
			if (entry?.item.type === "message") {
				entry.item.content = entry.item.content || [];
				if (event.part.type === "output_text" || event.part.type === "refusal") {
					entry.item.content.push(event.part);
				}
			}
		} else if (event.type === "response.output_text.delta") {
			const entry = resolveEntry(event.item_id, event.output_index, "always");
			if (entry?.item.type === "message" && entry.block.type === "text") {
				const lastPart = entry.item.content?.[entry.item.content.length - 1];
				if (lastPart?.type === "output_text") {
					entry.block.text += event.delta;
					lastPart.text += event.delta;
					stream.push({
						type: "text_delta",
						contentIndex: entry.blockContentIndex,
						delta: event.delta,
						partial: output,
					});
				}
			}
		} else if (event.type === "response.refusal.delta") {
			const entry = resolveEntry(event.item_id, event.output_index, "always");
			if (entry?.item.type === "message" && entry.block.type === "text") {
				const lastPart = entry.item.content?.[entry.item.content.length - 1];
				if (lastPart?.type === "refusal") {
					entry.block.text += event.delta;
					lastPart.refusal += event.delta;
					stream.push({
						type: "text_delta",
						contentIndex: entry.blockContentIndex,
						delta: event.delta,
						partial: output,
					});
				}
			}
		} else if (event.type === "response.function_call_arguments.delta") {
			const entry = resolveEntry(event.item_id, event.output_index, "no-key");
			if (entry?.item.type === "function_call" && entry.block.type === "toolCall") {
				entry.block.partialJson += event.delta;
				entry.block.arguments = parseStreamingJson(entry.block.partialJson);
				stream.push({
					type: "toolcall_delta",
					contentIndex: entry.blockContentIndex,
					delta: event.delta,
					partial: output,
				});
			}
		} else if (event.type === "response.function_call_arguments.done") {
			const entry = resolveEntry(event.item_id, event.output_index, "no-key");
			if (entry?.item.type === "function_call" && entry.block.type === "toolCall") {
				entry.block.partialJson = event.arguments;
				entry.block.arguments = parseStreamingJson(entry.block.partialJson);
			}
		} else if (event.type === "response.custom_tool_call_input.delta") {
			const entry = resolveEntry(event.item_id, event.output_index, "no-key");
			if (entry?.item.type === "custom_tool_call" && entry.block.type === "toolCall") {
				entry.block.partialJson += event.delta;
				entry.block.arguments = { input: entry.block.partialJson };
				stream.push({
					type: "toolcall_delta",
					contentIndex: entry.blockContentIndex,
					delta: event.delta,
					partial: output,
				});
			}
		} else if (event.type === "response.custom_tool_call_input.done") {
			const entry = resolveEntry(event.item_id, event.output_index, "no-key");
			if (entry?.item.type === "custom_tool_call" && entry.block.type === "toolCall") {
				entry.block.partialJson = event.input;
				entry.block.arguments = { input: event.input };
			}
		} else if (event.type === "response.output_item.done") {
			const item = structuredCloneJSON(event.item);
			options?.onOutputItemDone?.(item);
			const entry = resolveEntry(item.id, event.output_index, "never");
			if (item.type === "reasoning") {
				// Prefer the streamed summary buffer only when it carries real text. When it
				// holds only synthetic separators (e.g. a part.done arrived before/without any
				// summary_text delta), fall back to the canonical `item.summary` from
				// output_item.done so the materialized summaryText is not blank/separator-only.
				const bufferSummary = entry?.summaryBuffer ?? "";
				const itemSummary = item.summary?.map(part => part.text).join("\n\n") ?? "";
				const summaryText = bufferSummary.trim() ? bufferSummary : itemSummary;
				const rawText =
					entry?.rawBuffer || (item.content?.[0]?.type === "reasoning_text" ? (item.content[0].text ?? "") : "");
				const reasoningBlock =
					entry?.block.type === "thinking"
						? entry.block
						: (output.content.find(b => b.type === "thinking" && (b as ThinkingContent).itemId === item.id) as
								| ThinkingContent
								| undefined);
				if (reasoningBlock) {
					const mutable = reasoningBlock as {
						provenance?: "summary" | "raw" | "mixed";
						summaryText?: string;
						rawText?: string;
					};
					if (mutable.provenance === undefined) {
						if (mutable.summaryText === undefined && summaryText) mutable.summaryText = summaryText;
						if (mutable.rawText === undefined && rawText) mutable.rawText = rawText;
						mutable.provenance =
							summaryText && rawText ? "mixed" : summaryText ? "summary" : rawText ? "raw" : undefined;
					}
					// Finalized display string must exclude raw CoT when a summary exists.
					// Derive it from the STORED write-once provenance fields (falling back to
					// this event's locals only for a first classification) so a later or
					// duplicate finalization carrying only raw can never overwrite a summary/
					// mixed block's safe display with raw CoT. Raw-only stays raw.
					{
						const effSummary = mutable.summaryText ?? summaryText;
						const effRaw = mutable.rawText ?? rawText;
						reasoningBlock.thinking = mutable.provenance === "raw" ? effRaw : effSummary || effRaw;
					}
					reasoningBlock.thinkingSignature = JSON.stringify(item);
					const reasoningBlockIndex =
						entry?.block === reasoningBlock ? entry.blockContentIndex : output.content.indexOf(reasoningBlock);
					if (summaryText) {
						// If the summary text came only from the canonical item.summary (no
						// streamed summary deltas/part.added), no reasoning_summary_start was
						// emitted. Emit one now so consumers that open a summary on start
						// (e.g. the Responses SSE encoder) don't receive an orphaned end.
						if (!entry?.summaryStarted) {
							stream.push({
								type: "reasoning_summary_start",
								contentIndex: reasoningBlockIndex,
								partial: output,
							});
						}
						stream.push({
							type: "reasoning_summary_end",
							contentIndex: reasoningBlockIndex,
							content: summaryText,
							partial: output,
						});
					}
					stream.push({
						type: "thinking_end",
						contentIndex: reasoningBlockIndex,
						content: reasoningBlock.thinking,
						partial: output,
					});
				}
				dropEntry(item.id, event.output_index);
			} else if (item.type === "message" && entry?.block.type === "text") {
				const block = entry.block;
				block.text = item.content
					.map(part => (part.type === "output_text" ? (part.text ?? "") : (part.refusal ?? "")))
					.join("");
				block.textSignature = encodeTextSignatureV1(item.id, item.phase ?? undefined);
				stream.push({
					type: "text_end",
					contentIndex: entry.blockContentIndex,
					content: block.text,
					partial: output,
				});
				dropEntry(item.id, event.output_index);
			} else if (item.type === "function_call") {
				// Finalize onto the same block object stored in output.content, reading
				// the matching entry's buffered partialJson first and only then the done
				// item's arguments — never an adjacent item's buffer.
				const args =
					entry?.block.type === "toolCall" && entry.block.partialJson
						? parseStreamingJson(entry.block.partialJson)
						: parseStreamingJson(item.arguments || "{}");
				const toolCall: ToolCall = {
					type: "toolCall",
					id: encodeResponsesToolCallId(item.call_id, item.id),
					name: item.name,
					arguments: args,
				};
				if (entry?.block.type === "toolCall") {
					entry.block.id = toolCall.id;
					entry.block.name = toolCall.name;
					entry.block.arguments = args;
				}
				const contentIndex = entry?.blockContentIndex ?? output.content.length - 1;
				dropEntry(item.id, event.output_index);
				stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: output });
			} else if (item.type === "custom_tool_call") {
				const rawInput =
					entry?.block.type === "toolCall" && entry.block.partialJson
						? entry.block.partialJson
						: (item.input ?? "");
				const toolCall: ToolCall = {
					type: "toolCall",
					id: encodeResponsesToolCallId(item.call_id, item.id),
					name: item.name,
					arguments: { input: rawInput },
					customWireName: item.name,
				};
				if (entry?.block.type === "toolCall") {
					entry.block.id = toolCall.id;
					entry.block.name = toolCall.name;
					entry.block.arguments = { input: rawInput };
				}
				const contentIndex = entry?.blockContentIndex ?? output.content.length - 1;
				dropEntry(item.id, event.output_index);
				stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: output });
			}
		} else if (event.type === "response.completed") {
			const response = event.response;
			if (response?.id) {
				output.responseId = response.id;
			}
			populateResponsesUsageFromResponse(output, response?.usage);
			calculateCost(model, output.usage);
			output.stopReason = mapOpenAIResponsesStopReason(response?.status);
			if (response?.status === "failed" || response?.status === "cancelled") {
				const error = response?.error ?? (response as any)?.status_details?.error;
				const details = response?.incomplete_details;
				const statusDetailsReason = (response as any)?.status_details?.reason;
				const message = error
					? `${error.code || "unknown"}: ${error.message || "no message"}`
					: details?.reason
						? `incomplete: ${details.reason}`
						: typeof statusDetailsReason === "string" && statusDetailsReason.length > 0
							? `status_details: ${statusDetailsReason}`
							: "Unknown error (no error details in response)";
				throw new Error(message);
			}
			// A response cut short for length (`incomplete`) may have stopped
			// mid-tool-call. Any tool-call item still tracked in `items` never
			// received its terminal `output_item.done`, so it was cut off; flag it
			// (along with any finalized-but-unparseable JSON call) so the agent loop
			// rejects it instead of executing repaired/partial arguments.
			const openBlocks = new Set<unknown>(Array.from(items.values(), entry => entry.block));
			flagTruncatedToolCalls(output, output.stopReason, block => !openBlocks.has(block));
			if (output.content.some(block => block.type === "toolCall") && output.stopReason === "stop") {
				output.stopReason = "toolUse";
			}
		} else if (event.type === "error") {
			throw new Error(`Error Code ${event.code}: ${event.message}` || "Unknown error");
		} else if (event.type === "response.failed") {
			const error = event.response?.error ?? (event.response as any)?.status_details?.error;
			const details = event.response?.incomplete_details;
			const message = error
				? `${error.code || "unknown"}: ${error.message || "no message"}`
				: details?.reason
					? `incomplete: ${details.reason}`
					: "Unknown error (no error details in response)";
			throw new Error(message);
		}
	}
}

/**
 * Mark tool-call blocks left incomplete by a length-truncated response so the
 * agent loop rejects them instead of executing a best-effort partial parse.
 *
 * The universal signal is finalization: a call that never received its terminal
 * `output_item.done` (passed in via `isFinalized`) was cut off mid-arguments.
 * This covers both JSON function calls and raw-input custom tools without
 * mis-flagging a *completed* custom tool whose raw input is not valid JSON. As a
 * defensive secondary, a finalized JSON function call whose buffered arguments
 * still don't parse (e.g. a misbehaving relay) is flagged too. No-op unless the
 * turn stopped for length.
 *
 * Shared by both Responses providers (`openai-responses`, `openai-codex-responses`).
 */
export function flagTruncatedToolCalls(
	output: AssistantMessage,
	stopReason: StopReason,
	isFinalized: (block: ToolCall) => boolean,
): void {
	if (stopReason !== "length") return;
	for (const block of output.content) {
		if (block.type !== "toolCall") continue;
		if (!isFinalized(block)) {
			block.incompleteArguments = true;
			continue;
		}
		// Finalized: custom tools carry raw (non-JSON) input and are complete once
		// finalized; only JSON function calls get the parse double-check.
		if (!block.customWireName) {
			const partial = (block as { partialJson?: string }).partialJson;
			if (partial !== undefined && !isCompleteJson(partial)) block.incompleteArguments = true;
		}
	}
}

export function mapOpenAIResponsesStopReason(status: OpenAI.Responses.ResponseStatus | undefined): StopReason {
	if (!status) return "stop";
	switch (status) {
		case "completed":
			return "stop";
		case "incomplete":
			return "length";
		case "failed":
		case "cancelled":
			return "error";
		case "in_progress":
		case "queued":
			return "stop";
		default: {
			const exhaustive: never = status;
			throw new Error(`Unhandled stop reason: ${exhaustive}`);
		}
	}
}

/** Initial empty `AssistantMessage` that streaming providers accumulate into. */
export function createInitialResponsesAssistantMessage(api: Api, provider: string, modelId: string): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api,
		provider,
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
		timestamp: Date.now(),
	};
}

/** Extension fields we add on top of `ResponseCreateParamsStreaming` across the Responses-family providers. */
export type ResponsesSamplingParamsExtras = {
	top_p?: number;
	top_k?: number;
	min_p?: number;
	presence_penalty?: number;
	repetition_penalty?: number;
};

type CommonResponsesParams = OpenAI.Responses.ResponseCreateParamsStreaming & ResponsesSamplingParamsExtras;

type CommonSamplingOptions = Pick<
	StreamOptions,
	"temperature" | "topP" | "topK" | "minP" | "presencePenalty" | "repetitionPenalty" | "maxTokens"
> & { serviceTier?: ServiceTier };

/**
 * Apply the common `StreamOptions` → Responses sampling-parameter mapping (max output tokens,
 * temperature, top-p/k, min-p, presence/repetition penalties, service tier). Mutates `params`.
 */
export function applyCommonResponsesSamplingParams<P extends CommonResponsesParams>(
	params: P,
	options: CommonSamplingOptions | undefined,
	provider: string,
): void {
	if (options?.maxTokens) params.max_output_tokens = options.maxTokens;
	if (options?.temperature !== undefined) params.temperature = options.temperature;
	if (options?.topP !== undefined) params.top_p = options.topP;
	if (options?.topK !== undefined) params.top_k = options.topK;
	if (options?.minP !== undefined) params.min_p = options.minP;
	if (options?.presencePenalty !== undefined) params.presence_penalty = options.presencePenalty;
	if (options?.repetitionPenalty !== undefined) params.repetition_penalty = options.repetitionPenalty;
	if (shouldSendServiceTier(options?.serviceTier, provider)) {
		const resolved = resolveServiceTier(options?.serviceTier, provider);
		if (resolved === "flex" || resolved === "scale" || resolved === "priority") {
			params.service_tier = resolved;
		}
	}
}

type ReasoningOptions = {
	reasoning?: string;
	reasoningSummary?: "auto" | "detailed" | "concise" | null;
};

/**
 * Apply reasoning-related Responses parameters: enable encrypted reasoning content for replay,
 * set effort/summary when requested, and otherwise inject the GPT-5 "Juice: 0" no-reasoning hack.
 * Mutates `params` and may push a developer message into `messages`.
 */
export function applyResponsesReasoningParams<P extends OpenAI.Responses.ResponseCreateParamsStreaming>(
	params: P,
	model: Model<Api>,
	options: ReasoningOptions | undefined,
	messages: ResponseInput,
	mapEffort?: (effort: string) => string,
): void {
	if (!model.reasoning) return;
	// Always request encrypted reasoning content so reasoning items can be replayed in
	// multi-turn conversations when store is false (items aren't persisted server-side, so
	// we must include the full content). See: https://github.com/can1357/gajae-code/issues/41
	params.include = ["reasoning.encrypted_content"];

	if (options?.reasoning || options?.reasoningSummary !== undefined) {
		const requested = options?.reasoning || "medium";
		type ReasoningParam = NonNullable<OpenAI.Responses.ResponseCreateParamsStreaming["reasoning"]>;
		const reasoningParams: ReasoningParam = {
			effort: (mapEffort ? mapEffort(requested) : requested) as ReasoningParam["effort"],
		};
		if (options?.reasoningSummary !== null) {
			reasoningParams.summary = options?.reasoningSummary || "auto";
		}
		params.reasoning = reasoningParams as P["reasoning"];
	} else if (model.name.toLowerCase().startsWith("gpt-5")) {
		// Jesus Christ, see https://community.openai.com/t/need-reasoning-false-option-for-gpt-5/1351588/7
		messages.push({
			role: "developer",
			content: [{ type: "input_text", text: "# Juice: 0 !important" }],
		});
	}
}

/** Populate `output.usage` from a Responses-API `response.usage` payload. Does not invoke `calculateCost`. */
export function populateResponsesUsageFromResponse(
	output: AssistantMessage,
	usage:
		| {
				input_tokens?: number | null;
				output_tokens?: number | null;
				total_tokens?: number | null;
				input_tokens_details?: { cached_tokens?: number | null } | null;
				output_tokens_details?: { reasoning_tokens?: number | null } | null;
		  }
		| null
		| undefined,
): void {
	if (!usage) return;
	const cachedTokens = usage.input_tokens_details?.cached_tokens || 0;
	const reasoningTokens = usage.output_tokens_details?.reasoning_tokens || 0;
	output.usage = {
		input: (usage.input_tokens || 0) - cachedTokens,
		output: usage.output_tokens || 0,
		cacheRead: cachedTokens,
		cacheWrite: 0,
		totalTokens: usage.total_tokens || 0,
		...(reasoningTokens > 0 ? { reasoningTokens } : {}),
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}
