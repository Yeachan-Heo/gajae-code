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

// Re-exported so other streaming filters (e.g. the thinking-channel fence
// stripper) share this token list instead of duplicating the literals.
export { MAX_PARTIAL_HOLD as MAX_TOOL_FENCE_PARTIAL_HOLD, TOKENS as TOOL_FENCE_TOKENS };

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

const DSML_TAG_PREFIXES = [
	{ prefix: "</｜DSML｜", closing: true },
	{ prefix: "</|DSML|", closing: true },
	{ prefix: "<｜DSML｜", closing: false },
	{ prefix: "<|DSML|", closing: false },
] as const;

type DsmlTagKind = "invoke" | "parameter" | "wrapper" | "unknown";

interface DsmlTag {
	readonly length: number;
	readonly kind: DsmlTagKind;
	readonly closing: boolean;
	readonly name?: string;
	readonly string?: boolean;
}

/**
 * Streaming-safe recovery for DeepSeek DSML tool-call markup leaked into
 * `delta.content` by hosts whose server-side parser did not recognize it.
 * One instance per stream; completed calls use deterministic per-stream IDs.
 */
export class DsmlToolCallHealer {
	#buffer = "";
	#offset = 0;
	#inCall = false;
	#inParameter = false;
	#pendingName = "";
	#pendingInvokeString: boolean | undefined;
	#pendingParameterName = "";
	#pendingParameterString = true;
	#pendingValue = "";
	#pendingArguments: string[] = [];
	#nextId = 1;
	readonly #idPrefix: string;
	readonly #completed: HealedToolCall[] = [];

	/**
	 * `idPrefix` keeps recovered ids distinct across streams: conversation-level
	 * consumers index tool calls by id, so two turns both starting at `dsml_1`
	 * would overwrite each other.
	 */
	constructor(idPrefix = "dsml") {
		this.#idPrefix = idPrefix;
	}

	/**
	 * Drop whatever invocation is in progress. Used when the provider also sent a
	 * structured call for the same chunk: the structured payload is the source of
	 * truth, and a half-consumed invocation left active would otherwise be re-emitted
	 * from the closing tag in a later content-only delta under a synthesized id.
	 */
	#abandonCall(): void {
		this.#inCall = false;
		this.#inParameter = false;
		this.#pendingName = "";
		this.#pendingInvokeString = undefined;
		this.#pendingParameterName = "";
		this.#pendingParameterString = true;
		this.#pendingValue = "";
		this.#pendingArguments = [];
	}

	feed(text: string): string {
		if (text.length === 0) return "";
		this.#compact();
		this.#buffer += text;
		return this.#consume();
	}

	consumeWithoutCalls(text: string): string {
		const clean = this.feed(text);
		this.#abandonCall();
		if (this.#completed.length > 0) this.#completed.length = 0;
		return clean;
	}

	drainCompleted(): HealedToolCall[] {
		if (this.#completed.length === 0) return [];
		return this.#completed.splice(0, this.#completed.length);
	}

	flushPending(): string {
		const tail = this.#remaining();
		this.#buffer = "";
		this.#offset = 0;
		if (this.#inCall) return "";
		return tail;
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
			if (this.#buffer[this.#offset] === "<") {
				const tag = this.#parseTag();
				if (tag === "partial") break;
				if (tag !== undefined) {
					this.#offset += tag.length;
					this.#handleTag(tag);
					continue;
				}
			}

			const ch = this.#buffer[this.#offset]!;
			this.#offset += 1;
			if (this.#inCall) {
				this.#pendingValue += ch;
			} else {
				clean += ch;
			}
		}

		return clean;
	}

	/** Returns "partial" when the remaining bytes could still become a DSML tag. */
	#parseTag(): DsmlTag | "partial" | undefined {
		const remaining = this.#remaining();
		let matched: (typeof DSML_TAG_PREFIXES)[number] | undefined;
		for (const candidate of DSML_TAG_PREFIXES) {
			if (remaining.startsWith(candidate.prefix)) {
				matched = candidate;
				break;
			}
		}
		if (!matched) {
			for (const candidate of DSML_TAG_PREFIXES) {
				if (candidate.prefix.startsWith(remaining)) return "partial";
			}
			return undefined;
		}

		const end = remaining.indexOf(">", matched.prefix.length);
		if (end < 0) return "partial";

		const body = remaining.slice(matched.prefix.length, end).trim();
		const length = end + 1;
		const match = /^([A-Za-z_][\w-]*)(?:\s+([\s\S]*))?$/.exec(body);
		if (!match) return { length, kind: "unknown", closing: matched.closing };

		const tagName = match[1];
		if (tagName === "calls" || tagName === "tool_calls") {
			return { length, kind: "wrapper", closing: matched.closing };
		}
		if (tagName !== "invoke" && tagName !== "parameter") {
			return { length, kind: "unknown", closing: matched.closing };
		}
		if (matched.closing) return { length, kind: tagName, closing: true };

		const attributes = match[2] ?? "";
		const stringAttribute = readDsmlAttribute(attributes, "string");
		return {
			length,
			kind: tagName,
			closing: false,
			name: readDsmlAttribute(attributes, "name"),
			string: stringAttribute === undefined ? undefined : stringAttribute !== "false",
		};
	}

	#handleTag(tag: DsmlTag): void {
		if (tag.kind === "invoke") {
			if (tag.closing) {
				if (this.#inCall) this.#finalizeCall();
				return;
			}
			this.#inCall = true;
			this.#inParameter = false;
			this.#pendingName = tag.name?.trim() ?? "";
			this.#pendingInvokeString = tag.string;
			this.#pendingParameterName = "";
			this.#pendingParameterString = true;
			this.#pendingValue = "";
			this.#pendingArguments = [];
			return;
		}

		if (tag.kind !== "parameter" || !this.#inCall) return;
		if (!tag.closing) {
			this.#inParameter = true;
			this.#pendingParameterName = tag.name ?? "";
			this.#pendingParameterString = tag.string !== false;
			this.#pendingValue = "";
			return;
		}

		if (this.#inParameter) {
			this.#addArgument(this.#pendingParameterName, this.#pendingValue, this.#pendingParameterString);
		} else if (this.#pendingInvokeString !== undefined) {
			// An observed Venice deviation closes the invoke's direct value as a
			// parameter. Its invoke attributes describe that first parameter too.
			this.#addArgument(this.#pendingName, this.#pendingValue, this.#pendingInvokeString);
		}
		this.#inParameter = false;
		this.#pendingParameterName = "";
		this.#pendingParameterString = true;
		this.#pendingValue = "";
	}

	#addArgument(name: string, value: string, isString: boolean): void {
		let rawJson: string;
		if (isString) {
			rawJson = JSON.stringify(value);
		} else {
			const candidate = value.trim();
			try {
				parseJsonWithRepair<unknown>(candidate);
				rawJson = candidate;
			} catch {
				rawJson = JSON.stringify(value);
			}
		}
		this.#pendingArguments.push(`${JSON.stringify(name)}:${rawJson}`);
	}

	#finalizeCall(): void {
		const rawArgs = this.#pendingArguments.length === 0 ? "{}" : `{${this.#pendingArguments.join(",")}}`;
		const escapedUnicodeArgumentEvidence = collectUnsafeUnicodeEscapeEvidence(rawArgs);
		const escapedNonAsciiArguments = escapedUnicodeArgumentEvidence !== undefined;

		let argsJson = rawArgs;
		try {
			argsJson = JSON.stringify(parseJsonWithRepair<unknown>(rawArgs));
		} catch {
			// Leave raw; downstream parseStreamingJson absorbs the failure.
		}

		const completed: HealedToolCall = {
			id: `${this.#idPrefix}_${this.#nextId++}`,
			name: this.#pendingName,
			arguments: argsJson,
			escapedNonAsciiArguments,
		};
		if (escapedUnicodeArgumentEvidence) attachUnicodeEscapeEvidence(completed, escapedUnicodeArgumentEvidence);
		this.#completed.push(completed);
		this.#abandonCall();
	}
}

function readDsmlAttribute(attributes: string, name: "name" | "string"): string | undefined {
	const match = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(attributes);
	return match?.[1] ?? match?.[2];
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
