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
