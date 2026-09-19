/**
 * Streaming-safe removal of chat-template tool-call fence tokens.
 *
 * Unlike {@link ToolCallHealer}, this reconstructs nothing — it only deletes
 * the markers. That makes it safe for the **reasoning channel**, where a leaked
 * `<|tool_call_end|>` is pure noise: the structured `tool_calls` payload is the
 * single source of truth, and the healer's doc comment warns that feeding the
 * reasoning channel into its accumulator corrupts the holdback buffer (#5624).
 *
 * Deliberately NOT applied to the visible text channel: a fence token the
 * assistant *talks about* in prose, outside an active section, must survive as
 * text (see packages/ai/CHANGELOG.md:1094).
 */

import { MAX_TOOL_FENCE_PARTIAL_HOLD, TOOL_FENCE_TOKENS } from "./tool-call-healing";

/** Remove every complete fence token from `text`. Pure; no stream state. */
export function stripToolFenceTokens(text: string): string {
	let out = text;
	for (const token of TOOL_FENCE_TOKENS) {
		if (out.includes(token)) out = out.split(token).join("");
	}
	return out;
}

/**
 * Length of the trailing run that could still grow into a fence token. Every
 * token starts with `<` and contains no further `<`, so a genuine partial can
 * only begin at the last `<` in the buffer.
 */
function trailingPartialTokenLength(text: string): number {
	const start = text.lastIndexOf("<");
	if (start < 0 || text.length - start > MAX_TOOL_FENCE_PARTIAL_HOLD) return 0;
	const suffix = text.slice(start);
	for (const token of TOOL_FENCE_TOKENS) {
		if (token.length > suffix.length && token.startsWith(suffix)) return suffix.length;
	}
	return 0;
}

/**
 * Stateful wrapper around {@link stripToolFenceTokens} that holds back a
 * partial token at the end of a chunk until the next chunk arrives, so a fence
 * split across a streaming boundary is still removed. One instance per stream.
 */
export class ToolFenceStripper {
	#hold = "";

	/** Feed a chunk; returns the stripped text safe to emit now. */
	feed(text: string): string {
		if (text.length === 0) return "";
		const buffer = this.#hold + text;
		const held = trailingPartialTokenLength(buffer);
		this.#hold = held > 0 ? buffer.slice(buffer.length - held) : "";
		return stripToolFenceTokens(buffer.slice(0, buffer.length - held));
	}

	/** Drain any held-back partial at end of stream. It never completed, so emit it. */
	flush(): string {
		const rest = this.#hold;
		this.#hold = "";
		return stripToolFenceTokens(rest);
	}
}
