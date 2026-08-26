/**
 * Streaming-safe filter for the Kimi K2 chat-template "tool-call section"
 * grammar.
 *
 * Some providers hosting Kimi K2 (the native `kimi-code` API, OpenRouter,
 * Fireworks, and others) leak the raw chat-template special tokens into
 * `delta.content` instead of emitting structured `tool_calls`. Visually
 * that looks like:
 *
 *     <|tool_calls_section_begin|>
 *       <|tool_call_begin|>functions.read:0<|tool_call_argument_begin|>{"path":"foo"}<|tool_call_end|>
 *     <|tool_calls_section_end|>
 *
 * Without healing, the user sees the raw markers and the agent loop never
 * sees a tool call. This module reconstructs the embedded calls and strips
 * the markers from visible text. It is stream-aware: any partial token at
 * the end of a chunk is held back until the next chunk arrives.
 */

import {
	attachUnicodeEscapeEvidence,
	collectUnsafeUnicodeEscapeEvidence,
	parseJsonWithRepair,
	type UnicodeEscapeEvidence,
} from "./json-parse";

const TOK_SECTION_BEGIN = "<|tool_calls_section_begin|>";
const TOK_SECTION_END = "<|tool_calls_section_end|>";
const TOK_CALL_BEGIN = "<|tool_call_begin|>";
const TOK_CALL_END = "<|tool_call_end|>";
const TOK_ARG_BEGIN = "<|tool_call_argument_begin|>";

const TOKENS = [TOK_SECTION_BEGIN, TOK_SECTION_END, TOK_CALL_BEGIN, TOK_CALL_END, TOK_ARG_BEGIN] as const;

/** Maximum buffered partial-token length before we give up holding back. */
const MAX_PARTIAL_HOLD = 64;

export interface HealedToolCall {
	readonly id: string;
	readonly name: string;
	readonly arguments: string;
	/**
	 * Whether the raw leaked payload carried unsafe Unicode argument data.
	 * Captured before the normalizing round-trip below, which would otherwise
	 * erase malformed escape evidence. Valid `\uXXXX` spellings decode
	 * canonically and leave this false.
	 */
	readonly escapedNonAsciiArguments: boolean;
	readonly escapedUnicodeArgumentEvidence?: UnicodeEscapeEvidence;
}

/**
 * State machine that consumes streamed text, emits visible text with all
 * Kimi tool-call markers stripped, and accumulates the embedded tool calls
 * for the caller to drain after each `feed()`.
 *
 * One instance per stream. Feed only the channel that may carry leaked
 * markers (typically `delta.content`); mixing reasoning + content into the
 * same accumulator corrupts the holdback buffer if both channels race in
 * the same chunk.
 */
export class ToolCallHealer {
	#buffer = "";
	#offset = 0;
	#inSection = false;
	#inCall = false;
	#inArgs = false;
	#pendingId = "";
	#pendingArgs = "";
	#sectionTerminated = false;
	readonly #completed: HealedToolCall[] = [];

	/**
	 * Feed a chunk of streamed text. Returns the portion safe to emit
	 * downstream (with all tokens stripped). Any partial token suffix is
	 * held back until the next chunk arrives or {@link flushPending} is
	 * called.
	 */
	feed(text: string): string {
		if (text.length === 0) return "";
		this.#compact();
		this.#buffer += text;
		return this.#consume();
	}

	/**
	 * Like {@link feed}, but discards any tool calls that the chunk completes.
	 * Used when the upstream provider also emits structured `delta.tool_calls`
	 * for the same chunk: the healer still strips leaked marker text from the
	 * visible output, but the structured payload remains the single source of
	 * truth for the call list.
	 */
	consumeWithoutCalls(text: string): string {
		const clean = this.feed(text);
		if (this.#completed.length > 0) this.#completed.length = 0;
		return clean;
	}

	/**
	 * Drain accumulated tool calls. The internal list is cleared so a
	 * subsequent section in the same stream (rare) yields fresh calls.
	 */
	drainCompleted(): HealedToolCall[] {
		if (this.#completed.length === 0) return [];
		return this.#completed.splice(0, this.#completed.length);
	}

	/**
	 * Flush any held-back fragment when the stream ends. If we were mid-call
	 * the partial is dropped (emitting raw token bytes would surface markers
	 * to the user); otherwise the fragment is returned verbatim so a literal
	 * `<|` in prose is not silently lost.
	 */
	flushPending(): string {
		const tail = this.#remaining();
		this.#buffer = "";
		this.#offset = 0;
		if (this.#inCall || this.#inSection) return "";
		return tail;
	}

	/** True once any tool-call section in this stream has fully closed. */
	get sectionClosed(): boolean {
		return this.#sectionTerminated;
	}

	#remaining(): string {
		return this.#offset === 0 ? this.#buffer : this.#buffer.slice(this.#offset);
	}

	#compact(): void {
		if (this.#offset === 0) return;
		this.#buffer = this.#buffer.slice(this.#offset);
		this.#offset = 0;
	}

	#consume(): string {
		let clean = "";

		while (this.#offset < this.#buffer.length) {
			if (this.#startsWithPartialToken()) break;

			if (this.#matches(TOK_SECTION_BEGIN)) {
				this.#inSection = true;
				this.#offset += TOK_SECTION_BEGIN.length;
				continue;
			}
			if (this.#matches(TOK_SECTION_END)) {
				this.#inSection = false;
				this.#sectionTerminated = true;
				this.#offset += TOK_SECTION_END.length;
				continue;
			}
			if (this.#matches(TOK_CALL_BEGIN)) {
				if (!this.#inSection) {
					// Literal mention outside a section — pass through as text so
					// docs/examples explaining tool tokens are not silently eaten.
					clean += TOK_CALL_BEGIN;
					this.#offset += TOK_CALL_BEGIN.length;
					continue;
				}
				this.#inCall = true;
				this.#inArgs = false;
				this.#pendingId = "";
				this.#pendingArgs = "";
				this.#offset += TOK_CALL_BEGIN.length;
				continue;
			}
			if (this.#matches(TOK_ARG_BEGIN)) {
				if (!this.#inSection) {
					clean += TOK_ARG_BEGIN;
					this.#offset += TOK_ARG_BEGIN.length;
					continue;
				}
				this.#inArgs = true;
				this.#offset += TOK_ARG_BEGIN.length;
				continue;
			}
			if (this.#matches(TOK_CALL_END)) {
				if (!this.#inSection || !this.#inCall) {
					// Token appeared outside an active call (e.g. an assistant
					// turn explaining the Kimi format). Emit it verbatim instead
					// of synthesizing a bogus empty tool call.
					clean += TOK_CALL_END;
					this.#offset += TOK_CALL_END.length;
					continue;
				}
				this.#finalizeCall();
				this.#offset += TOK_CALL_END.length;
				continue;
			}

			const ch = this.#buffer[this.#offset]!;
			this.#offset += 1;

			if (this.#inCall) {
				if (this.#inArgs) {
					this.#pendingArgs += ch;
				} else {
					this.#pendingId += ch;
				}
				continue;
			}

			// Inside the section but outside an individual call: swallow
			// inter-call whitespace/newlines. Outside the section: pass through.
			if (!this.#inSection) clean += ch;
		}

		return clean;
	}

	#matches(token: string): boolean {
		return this.#buffer.startsWith(token, this.#offset);
	}

	/**
	 * True if the remaining buffer is a strict prefix of any known token —
	 * we need more bytes before deciding whether it's a token or prose.
	 * Capped so a stray `<|` in normal text can't grow the holdback
	 * unboundedly.
	 */
	#startsWithPartialToken(): boolean {
		const remainingLength = this.#buffer.length - this.#offset;
		if (remainingLength === 0 || remainingLength > MAX_PARTIAL_HOLD) return false;
		for (const token of TOKENS) {
			if (token.length <= remainingLength) continue;
			if (this.#bufferIsPrefixOf(token, remainingLength)) return true;
		}
		return false;
	}

	#bufferIsPrefixOf(token: string, remainingLength: number): boolean {
		for (let i = 0; i < remainingLength; i++) {
			if (this.#buffer[this.#offset + i] !== token[i]) return false;
		}
		return true;
	}

	#finalizeCall(): void {
		const rawId = this.#pendingId.trim();
		const rawArgs = this.#pendingArgs.trim();
		const name = normalizeFunctionName(rawId);
		const id = generateHealedToolCallId();

		// Sample unsafe raw payloads first: the round-trip below decodes `\uXXXX`
		// into literal characters, so malformed escape data must be retained before
		// normalization. Valid escapes need no evidence because their decoded value
		// is canonical.
		const escapedUnicodeArgumentEvidence = collectUnsafeUnicodeEscapeEvidence(rawArgs);
		const escapedNonAsciiArguments = escapedUnicodeArgumentEvidence !== undefined;

		let argsJson = rawArgs;
		if (rawArgs.length > 0) {
			try {
				// Round-trip to normalize whitespace and repair near-valid JSON.
				argsJson = JSON.stringify(parseJsonWithRepair<unknown>(rawArgs));
			} catch {
				// Leave raw; downstream parseStreamingJson absorbs the failure.
			}
		} else {
			argsJson = "{}";
		}

		const completed: HealedToolCall = {
			id,
			name,
			arguments: argsJson,
			escapedNonAsciiArguments,
		};
		if (escapedUnicodeArgumentEvidence) attachUnicodeEscapeEvidence(completed, escapedUnicodeArgumentEvidence);
		this.#completed.push(completed);
		this.#inCall = false;
		this.#inArgs = false;
		this.#pendingId = "";
		this.#pendingArgs = "";
	}
}

/**
 * Cheap test for whether a given model is known to leak Kimi-K2 chat-template
 * tool-call tokens into visible text. Used to gate the per-stream healer so
 * non-Kimi providers do not pay for the scan.
 */
export function modelMayLeakKimiToolCalls(provider: string, modelId: string): boolean {
	if (provider === "kimi-code" || provider === "moonshot") return true;
	return /kimi[-/_.]?k2/i.test(modelId);
}

function normalizeFunctionName(rawId: string): string {
	const stripped = rawId.startsWith("functions.") ? rawId.slice("functions.".length) : rawId;
	const colon = stripped.indexOf(":");
	return colon >= 0 ? stripped.slice(0, colon) : stripped;
}

function generateHealedToolCallId(): string {
	return `call_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
}
