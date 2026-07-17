/**
 * Pure helpers for the notifications extension.
 *
 * Kept side-effect-free so the mapping logic (ask extraction, idle summary,
 * dedupe keys) is unit-testable without a live session or the native server.
 */

import { buildRedactedAction, type RedactableAction } from "./config";

/** A pending ask derived from an `ask` tool call. */
export interface PendingAsk {
	/** Action id: `${toolCallId}:${questionId}`. */
	id: string;
	/** Question text. */
	question: string;
	/** Option labels (may be empty for free-text questions). */
	options: string[];
}

/** Truncate text to `max` chars, appending an ellipsis when cut. */
export function truncate(text: string, max = 280): string {
	if (max <= 0) return "";
	return text.length <= max ? text : `${text.slice(0, max - 1)}\u2026`;
}

/** Stable per-turn idle dedupe key so exactly one idle action fires per turn. */
export function idleDedupeKey(sessionId: string, turnIndex: number): string {
	return `${sessionId}#${turnIndex}`;
}

/**
 * Extract pending asks from an `ask` tool call input.
 *
 * Defensive: tolerates partial/unknown shapes and always returns an array.
 */
export function asksFromAskInput(toolCallId: string, input: unknown): PendingAsk[] {
	const questions = (input as { questions?: unknown } | null | undefined)?.questions;
	if (!Array.isArray(questions)) return [];
	const asks: PendingAsk[] = [];
	for (const raw of questions) {
		if (!raw || typeof raw !== "object") continue;
		const q = raw as { id?: unknown; question?: unknown; options?: unknown };
		const qid = typeof q.id === "string" && q.id.length > 0 ? q.id : String(asks.length);
		const question = typeof q.question === "string" ? q.question : "";
		const options = Array.isArray(q.options)
			? q.options.map(opt => {
					if (opt && typeof opt === "object" && typeof (opt as { label?: unknown }).label === "string") {
						return (opt as { label: string }).label;
					}
					return String(opt);
				})
			: [];
		asks.push({ id: `${toolCallId}:${qid}`, question, options });
	}
	return asks;
}

/** Prepare an action JSON payload for remote notification delivery. */
export function notificationActionPayload<T extends RedactableAction>(
	action: T,
	opts: { redact: boolean; sessionTag: string },
): RedactableAction {
	return buildRedactedAction(action, opts);
}

/** Extract a plain-text summary from an agent message's content, if any. */
export function summaryFromMessage(message: unknown, max = 280): string | undefined {
	const content = (message as { content?: unknown } | null | undefined)?.content;
	if (typeof content === "string") {
		const trimmed = content.trim();
		return trimmed ? truncate(trimmed, max) : undefined;
	}
	if (!Array.isArray(content)) return undefined;
	const parts: string[] = [];
	for (const block of content) {
		if (block && typeof block === "object" && (block as { type?: unknown }).type === "text") {
			const text = (block as { text?: unknown }).text;
			if (typeof text === "string") parts.push(text);
		}
	}
	const joined = parts.join("").trim();
	return joined ? truncate(joined, max) : undefined;
}

/**
 * Extract an idle summary from an `agent_end` event's settled message list: the
 * last message that yields text (i.e. the final assistant message; tool-result
 * messages have no text and are skipped).
 *
 * `agent_end` fires exactly once when the agent loop settles to await the user,
 * so emitting idle from this — instead of per-`turn_end` — produces exactly one
 * idle notification per genuine idle, eliminating the multi-turn flood.
 */
export function summaryFromMessages(messages: unknown, max = 280): string | undefined {
	if (!Array.isArray(messages)) return undefined;
	for (let i = messages.length - 1; i >= 0; i--) {
		const summary = summaryFromMessage(messages[i], max);
		if (summary) return summary;
	}
	return undefined;
}

/** An agent-produced image extracted from a message's content. */
export interface ExtractedImage {
	source: string;
	mime: string;
	data: string;
}

/**
 * Extract agent-produced images (`{ type: "image", data, mimeType }` blocks)
 * from a message's content — e.g. computer-use/browser screenshots or tool
 * image outputs — for `image_attachment` delivery.
 */
export function imageAttachmentsFromMessage(message: unknown, source = "agent"): ExtractedImage[] {
	const content = (message as { content?: unknown } | null | undefined)?.content;
	if (!Array.isArray(content)) return [];
	const out: ExtractedImage[] = [];
	for (const block of content) {
		if (
			block &&
			typeof block === "object" &&
			(block as { type?: unknown }).type === "image" &&
			typeof (block as { data?: unknown }).data === "string" &&
			typeof (block as { mimeType?: unknown }).mimeType === "string"
		) {
			out.push({
				source,
				mime: (block as { mimeType: string }).mimeType,
				data: (block as { data: string }).data,
			});
		}
	}
	return out;
}
