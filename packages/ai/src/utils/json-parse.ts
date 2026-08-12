import { parse as partialParse } from "partial-json";

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const U = 0x75;

// Valid chars after `\`: " \ / b f n r t u
const VALID_ESCAPE_CHAR = new Uint8Array(128);
for (const ch of '"\\/bfnrtu') VALID_ESCAPE_CHAR[ch.charCodeAt(0)] = 1;

const CONTROL_ESCAPES: readonly string[] = (() => {
	const e: string[] = [];
	e[0x08] = "\\b";
	e[0x09] = "\\t";
	e[0x0a] = "\\n";
	e[0x0c] = "\\f";
	e[0x0d] = "\\r";
	for (let cp = 0; cp <= 0x1f; cp++) {
		e[cp] ??= `\\u${cp.toString(16).padStart(4, "0")}`;
	}
	return e;
})();

function isHexDigit(cp: number): boolean {
	return (cp >= 0x30 && cp <= 0x39) || ((cp | 0x20) >= 0x61 && (cp | 0x20) <= 0x66);
}

export function repairJson(json: string): string {
	const len = json.length;
	const parts: string[] = [];
	let lastEmit = 0;
	let inString = false;
	let i = 0;

	while (i < len) {
		if (!inString) {
			// Fast scan: skip to next quote.
			while (i < len && json.charCodeAt(i) !== QUOTE) i++;
			if (i >= len) break;
			inString = true;
			i++;
			continue;
		}

		// Fast scan inside string: advance past chars that need no handling.
		while (i < len) {
			const cp = json.charCodeAt(i);
			if (cp < 0x20 || cp === QUOTE || cp === BACKSLASH) break;
			i++;
		}
		if (i >= len) break;

		const cp = json.charCodeAt(i);

		if (cp === QUOTE) {
			inString = false;
			i++;
			continue;
		}

		if (cp === BACKSLASH) {
			// Need at least one char after the backslash; treat EOI as invalid escape.
			if (i + 1 >= len) {
				parts.push(json.slice(lastEmit, i), "\\\\");
				lastEmit = i + 1;
				i++;
				continue;
			}

			const nextCp = json.charCodeAt(i + 1);

			if (nextCp === U) {
				// Need full \uXXXX, all four digits, all hex.
				if (
					i + 5 < len &&
					isHexDigit(json.charCodeAt(i + 2)) &&
					isHexDigit(json.charCodeAt(i + 3)) &&
					isHexDigit(json.charCodeAt(i + 4)) &&
					isHexDigit(json.charCodeAt(i + 5))
				) {
					i += 6;
					continue;
				}
				// Truncated or non-hex \u — escape the backslash, re-process the rest.
				parts.push(json.slice(lastEmit, i), "\\\\");
				lastEmit = i + 1;
				i++;
				continue;
			}

			if (nextCp < 128 && VALID_ESCAPE_CHAR[nextCp] === 1) {
				i += 2;
				continue;
			}

			parts.push(json.slice(lastEmit, i), "\\\\");
			lastEmit = i + 1;
			i++;
			continue;
		}

		// Control character (cp < 0x20).
		parts.push(json.slice(lastEmit, i), CONTROL_ESCAPES[cp]);
		lastEmit = i + 1;
		i++;
	}

	if (!parts.length) return json;
	if (lastEmit < len) parts.push(json.slice(lastEmit));
	return parts.join("");
}

/**
 * First unnecessary `\uXXXX` escape in a JSON document, or `undefined` when the
 * document contains none.
 *
 * "Unnecessary" means the escape encodes a character JSON can carry literally:
 * any non-ASCII printable character. Control characters (< U+0020) MUST be
 * escaped, and an unpaired surrogate CANNOT be written literally, so neither
 * counts. A `\\uXXXX` sequence is a literal backslash followed by `u` — the
 * intended source syntax when the model is writing code or a nested JSON
 * document — and is skipped, which is why this scans the raw text with the same
 * string/escape state machine as {@link repairJson} instead of using a regex.
 *
 * Models that spell non-ASCII text as hand-written hex instead of literal UTF-8
 * mistype the digits, and every mistyped nibble silently decodes to a different
 * but perfectly valid character (`\uc7a5` vs `\uc7a4`). The resulting arguments
 * parse cleanly and cannot be repaired after the fact, so the escape itself is
 * the only observable evidence that the payload is untrustworthy.
 */
export function findUnnecessaryUnicodeEscape(json: string): string | undefined {
	const len = json.length;
	let inString = false;
	let i = 0;

	const hexAt = (start: number): number | undefined => {
		if (start + 3 >= len) return undefined;
		for (let k = start; k <= start + 3; k++) if (!isHexDigit(json.charCodeAt(k))) return undefined;
		return Number.parseInt(json.slice(start, start + 4), 16);
	};

	while (i < len) {
		if (!inString) {
			const open = json.indexOf('"', i);
			if (open === -1) return undefined;
			inString = true;
			i = open + 1;
			continue;
		}

		// Jump straight to the next quote or backslash. A per-character walk costs
		// ~40ms on a 1MB literal-UTF-8 payload (a large `write`), and every byte in
		// between is by definition uninteresting.
		const nextQuote = json.indexOf('"', i);
		const nextBackslash = json.indexOf("\\", i);
		if (nextQuote === -1 && nextBackslash === -1) return undefined;
		i = nextBackslash === -1 || (nextQuote !== -1 && nextQuote < nextBackslash) ? nextQuote : nextBackslash;

		if (json.charCodeAt(i) === QUOTE) {
			inString = false;
			i++;
			continue;
		}
		if (json.charCodeAt(i + 1) !== U) {
			// Any other escape (including `\\`) consumes its own second character,
			// so a literal `\uXXXX` in the decoded value is never misread as one.
			i += 2;
			continue;
		}

		const first = hexAt(i + 2);
		if (first === undefined) {
			i += 2;
			continue;
		}
		if (first >= 0xd800 && first <= 0xdbff) {
			// High surrogate: only a completed pair denotes a real character.
			const low = json.charCodeAt(i + 6) === BACKSLASH && json.charCodeAt(i + 7) === U ? hexAt(i + 8) : undefined;
			if (low !== undefined && low >= 0xdc00 && low <= 0xdfff) {
				return json.slice(i, i + 12);
			}
			i += 6;
			continue;
		}
		if (first >= 0x80 && !(first >= 0xdc00 && first <= 0xdfff)) {
			return json.slice(i, i + 6);
		}
		i += 6;
	}
	return undefined;
}

export function parseJsonWithRepair<T>(json: string): T {
	try {
		return JSON.parse(json) as T;
	} catch (error) {
		const repairedJson = repairJson(json);
		if (repairedJson !== json) {
			return JSON.parse(repairedJson) as T;
		}
		throw error;
	}
}

/**
 * Attempts to parse potentially incomplete JSON during streaming.
 * Always returns a valid object, even if the JSON is incomplete.
 *
 * @param partialJson The partial JSON string from streaming
 * @returns Parsed object or empty object if parsing fails
 */
export function parseStreamingJson<T = Record<string, unknown>>(partialJson: string | undefined): T {
	partialJson = partialJson?.trimStart();
	if (!partialJson) {
		return {} as T;
	}
	try {
		return JSON.parse(partialJson) as T;
	} catch {
		partialJson = repairJson(partialJson);
		try {
			return (partialParse(partialJson) ?? {}) as T;
		} catch {
			// If all parsing fails, return empty object
			return {} as T;
		}
	}
}

/**
 * Whether a string is a complete, well-formed JSON document (strict parse, no
 * repair). Used to distinguish a tool-call argument blob that finished cleanly
 * from one that was cut off mid-stream (truncation). An empty / whitespace-only
 * string is treated as complete: a tool invoked with no arguments legitimately
 * streams an empty buffer and must not be flagged as truncated.
 */
export function isCompleteJson(text: string | undefined): boolean {
	const trimmed = text?.trim();
	if (!trimmed) return true;
	try {
		JSON.parse(trimmed);
		return true;
	} catch {
		return false;
	}
}
