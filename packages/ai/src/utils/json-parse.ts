import * as crypto from "node:crypto";
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

const MAX_UNICODE_ESCAPE_POSITIONS = 32;
const MAX_UNICODE_ESCAPE_DEPTH = 64;
const UNICODE_ESCAPE_EVIDENCE_KEY_SLOT = Symbol.for("@gajae-code/ai.unicode-escape-evidence-key.v1");
const unicodeEscapeEvidenceGlobal = globalThis as unknown as Record<PropertyKey, unknown>;
const existingUnicodeEscapeEvidenceKey = unicodeEscapeEvidenceGlobal[UNICODE_ESCAPE_EVIDENCE_KEY_SLOT];
const UNICODE_ESCAPE_EVIDENCE_KEY = Buffer.isBuffer(existingUnicodeEscapeEvidenceKey)
	? existingUnicodeEscapeEvidenceKey
	: crypto.randomBytes(32);
if (!Buffer.isBuffer(existingUnicodeEscapeEvidenceKey)) {
	Object.defineProperty(unicodeEscapeEvidenceGlobal, UNICODE_ESCAPE_EVIDENCE_KEY_SLOT, {
		value: UNICODE_ESCAPE_EVIDENCE_KEY,
		writable: false,
		configurable: false,
		enumerable: false,
	});
}

export interface UnicodeEscapePositionEvidence {
	/** UTF-16 offset of the escape's leading backslash in the raw JSON. */
	readonly offset: number;
	/** Process-keyed tag of the encoded scalar; never the recoverable character. */
	readonly scalarTag: string;
	/** Process-keyed tag of the unambiguous array-index-free path; never raw field names. */
	readonly pathTag: string;
	/** Escapes in object keys are structural and can never be display-safe. */
	readonly location: "key" | "value";
	/** Ordinal of this string among values sharing the array-index-free path. */
	readonly valueOrdinal: number;
	/** UTF-16 offset of the decoded scalar inside that string value. */
	readonly valueOffset: number;
}

export interface UnicodeEscapeEvidence {
	readonly positions: readonly UnicodeEscapePositionEvidence[];
	/** Total qualifying escapes observed, including positions omitted by the cap. */
	readonly totalPositions: number;
	/** More qualifying escapes existed than the bounded evidence can carry. */
	readonly truncated: boolean;
	/** The raw JSON could not be mapped exactly and unambiguously; validation must fail closed. */
	readonly malformed: boolean;
	/** Process-local HMAC binding the complete collector-produced envelope. */
	readonly integrity: string;
}

interface UnicodeEscapeEvidenceTarget {
	escapedNonAsciiArguments?: boolean;
	escapedUnicodeArgumentEvidence?: UnicodeEscapeEvidence;
}

/** Stable, payload-free identity for an unambiguous array-index-free argument path. */
export function unicodeEscapePathTag(path: readonly string[]): string {
	const hash = crypto.createHmac("sha256", UNICODE_ESCAPE_EVIDENCE_KEY);
	const length = Buffer.allocUnsafe(4);
	length.writeUInt32BE(path.length);
	hash.update(length);
	for (const segment of path) {
		length.writeUInt32BE(Buffer.byteLength(segment));
		hash.update(length);
		hash.update(segment);
	}
	return hash.digest("hex");
}

/** Process-keyed scalar identity used without retaining recoverable argument text. */
export function unicodeEscapeScalarTag(codePoint: number): string {
	return crypto.createHmac("sha256", UNICODE_ESCAPE_EVIDENCE_KEY).update(`scalar:v1:${codePoint}`).digest("hex");
}

function unicodeEscapeEvidenceIntegrity(evidence: Omit<UnicodeEscapeEvidence, "integrity">): string {
	const hmac = crypto.createHmac("sha256", UNICODE_ESCAPE_EVIDENCE_KEY);
	hmac.update(`v1:${evidence.totalPositions}:${evidence.truncated ? 1 : 0}:${evidence.malformed ? 1 : 0}`);
	for (const position of evidence.positions) {
		hmac.update(
			`|${position.offset}:${position.location}:${position.valueOrdinal}:${position.valueOffset}:${position.scalarTag}:`,
		);
		hmac.update(position.pathTag);
	}
	return hmac.digest("hex");
}

function createUnicodeEscapeEvidence(
	positions: readonly UnicodeEscapePositionEvidence[],
	totalPositions: number,
	truncated: boolean,
	malformed: boolean,
): UnicodeEscapeEvidence {
	const evidence = { positions, totalPositions, truncated, malformed };
	return { ...evidence, integrity: unicodeEscapeEvidenceIntegrity(evidence) };
}

/** Verify that an evidence envelope is complete and was produced in this process. */
export function verifyUnicodeEscapeEvidence(evidence: UnicodeEscapeEvidence): boolean {
	if (
		!Array.isArray(evidence.positions) ||
		evidence.positions.length > MAX_UNICODE_ESCAPE_POSITIONS ||
		!Number.isSafeInteger(evidence.totalPositions) ||
		evidence.totalPositions < evidence.positions.length ||
		(!evidence.truncated && evidence.totalPositions !== evidence.positions.length) ||
		typeof evidence.integrity !== "string" ||
		!/^[0-9a-f]{64}$/.test(evidence.integrity)
	) {
		return false;
	}
	try {
		const expected = unicodeEscapeEvidenceIntegrity(evidence);
		return crypto.timingSafeEqual(Buffer.from(evidence.integrity, "hex"), Buffer.from(expected, "hex"));
	} catch {
		return false;
	}
}

function isSuspiciousEscapedScalar(codePoint: number): boolean {
	return (codePoint >= 0x20 && codePoint < 0x7f) || codePoint >= 0x80;
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
 * "Unnecessary" means the escape encodes a printable character JSON can carry
 * literally, including ASCII. ASCII must remain observable because one mistyped
 * nibble can move a non-ASCII escape into ASCII (`\u00b7` → `\u0077`). Control
 * characters (< U+0020), DEL, and unpaired surrogates are excluded. A `\\uXXXX`
 * sequence is a literal backslash followed by `u` — the
 * intended source syntax when the model is writing code or a nested JSON
 * document — and is skipped, which is why this scans the raw text with the same
 * string/escape state machine as {@link repairJson} instead of using a regex.
 *
 * Models that spell text as hand-written hex instead of literal characters
 * mistype the digits, and every mistyped nibble silently decodes to a different
 * but perfectly valid character (`\uc7a5` vs `\uc7a4`). The resulting arguments
 * parse cleanly and cannot be repaired after the fact, so the escape itself is
 * the only observable evidence that the payload is untrustworthy.
 */
export function findUnnecessaryUnicodeEscape(json: string): string | undefined {
	const len = json.length;
	let inString = false;
	let i = 0;
	let nextQuote = -1;
	let nextBackslash = -1;

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
		if (nextQuote < i) {
			const offset = json.indexOf('"', i);
			nextQuote = offset === -1 ? len : offset;
		}
		if (nextBackslash < i) {
			const offset = json.indexOf("\\", i);
			nextBackslash = offset === -1 ? len : offset;
		}
		i = Math.min(nextQuote, nextBackslash);
		if (i === len) return undefined;

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
		if (isSuspiciousEscapedScalar(first) && !(first >= 0xdc00 && first <= 0xdfff)) {
			return json.slice(i, i + 6);
		}
		i += 6;
	}
	return undefined;
}

/**
 * Bounded raw-position/scalar evidence for every suspicious `\uXXXX` escape.
 *
 * Scalars and paths are carried only as process-keyed HMAC tags, so terminal
 * validation can match them against decoded arguments without retaining
 * recoverable characters, keys, or values in messages, diagnostics, or durable
 * session artifacts. Array indices are
 * intentionally omitted to preserve `questions.question`-style field matching.
 */
export function collectUnicodeEscapeEvidence(json: string): UnicodeEscapeEvidence | undefined {
	const firstEscape = findUnnecessaryUnicodeEscape(json);
	if (firstEscape === undefined) return undefined;

	try {
		JSON.parse(json);
	} catch {
		return createUnicodeEscapeEvidence([], 0, false, true);
	}

	const positions: UnicodeEscapePositionEvidence[] = [];
	let totalPositions = 0;
	let truncated = false;
	let i = 0;
	const path: string[] = [];
	const valueOrdinals = new Map<string, number>();

	const push = (
		offset: number,
		codePoint: number,
		pathTag: string,
		location: "key" | "value",
		valueOrdinal: number,
		valueOffset: number,
	): void => {
		if (!isSuspiciousEscapedScalar(codePoint)) return;
		totalPositions++;
		if (positions.length >= MAX_UNICODE_ESCAPE_POSITIONS) {
			truncated = true;
			return;
		}
		positions.push({
			offset,
			scalarTag: unicodeEscapeScalarTag(codePoint),
			pathTag,
			location,
			valueOrdinal,
			valueOffset,
		});
	};
	const whitespace = (): void => {
		while (i < json.length) {
			const cp = json.charCodeAt(i);
			if (cp !== 0x20 && cp !== 0x09 && cp !== 0x0a && cp !== 0x0d) break;
			i++;
		}
	};
	const string = (location: "key" | "value"): string => {
		const start = i;
		const pathTag = unicodeEscapePathTag(path);
		const valueOrdinal = location === "value" ? (valueOrdinals.get(pathTag) ?? 0) : 0;
		if (location === "value") valueOrdinals.set(pathTag, valueOrdinal + 1);
		let decodedOffset = 0;
		i++;
		while (i < json.length) {
			const cp = json.charCodeAt(i);
			if (cp === QUOTE) {
				i++;
				return JSON.parse(json.slice(start, i)) as string;
			}
			if (cp !== BACKSLASH) {
				i++;
				decodedOffset++;
				continue;
			}
			if (json.charCodeAt(i + 1) !== U) {
				i += 2;
				decodedOffset++;
				continue;
			}
			const offset = i;
			const first = Number.parseInt(json.slice(i + 2, i + 6), 16);
			if (first >= 0xd800 && first <= 0xdbff) {
				const low = Number.parseInt(json.slice(i + 8, i + 12), 16);
				if (
					json.charCodeAt(i + 6) === BACKSLASH &&
					json.charCodeAt(i + 7) === U &&
					low >= 0xdc00 &&
					low <= 0xdfff
				) {
					push(
						offset,
						0x10000 + ((first - 0xd800) << 10) + (low - 0xdc00),
						pathTag,
						location,
						valueOrdinal,
						decodedOffset,
					);
					i += 12;
					decodedOffset += 2;
					continue;
				}
			} else if (!(first >= 0xdc00 && first <= 0xdfff)) {
				push(offset, first, pathTag, location, valueOrdinal, decodedOffset);
			}
			i += 6;
			decodedOffset++;
		}
		throw new Error("validated JSON string ended unexpectedly");
	};
	const value = (depth: number): void => {
		if (depth > MAX_UNICODE_ESCAPE_DEPTH) throw new Error("Unicode escape evidence nesting exceeded");
		whitespace();
		const cp = json.charCodeAt(i);
		if (cp === QUOTE) {
			string("value");
			return;
		}
		if (cp === 0x7b) {
			i++;
			const keys = new Set<string>();
			whitespace();
			if (json.charCodeAt(i) === 0x7d) {
				i++;
				return;
			}
			while (i < json.length) {
				whitespace();
				const key = string("key");
				if (keys.has(key)) throw new Error("Duplicate JSON object key");
				keys.add(key);
				whitespace();
				i++;
				path.push(key);
				value(depth + 1);
				path.pop();
				whitespace();
				if (json.charCodeAt(i) === 0x7d) {
					i++;
					return;
				}
				i++;
			}
			return;
		}
		if (cp === 0x5b) {
			i++;
			whitespace();
			if (json.charCodeAt(i) === 0x5d) {
				i++;
				return;
			}
			while (i < json.length) {
				value(depth + 1);
				whitespace();
				if (json.charCodeAt(i) === 0x5d) {
					i++;
					return;
				}
				i++;
			}
			return;
		}
		while (i < json.length) {
			const delimiter = json.charCodeAt(i);
			if (delimiter === 0x2c || delimiter === 0x5d || delimiter === 0x7d) return;
			i++;
		}
	};

	try {
		value(0);
	} catch {
		return createUnicodeEscapeEvidence([], 0, false, true);
	}
	return createUnicodeEscapeEvidence(positions, totalPositions, truncated, false);
}

function hasUnpairedUnicodeSurrogate(value: unknown): boolean {
	const pending: unknown[] = [value];
	while (pending.length > 0) {
		const current = pending.pop();
		if (typeof current === "string") {
			if (!current.isWellFormed()) return true;
			continue;
		}
		if (typeof current !== "object" || current === null) continue;
		if (Array.isArray(current)) {
			for (const child of current) pending.push(child);
			continue;
		}
		for (const [key, child] of Object.entries(current)) {
			if (!key.isWellFormed()) return true;
			pending.push(child);
		}
	}
	return false;
}

/**
 * Return evidence only when decoded tool arguments are unsafe to execute.
 *
 * Valid JSON escapes and literal UTF-8 have the same canonical decoded value,
 * including a valid scalar whose hex digits differ from what a caller intended:
 * runtime syntax validation cannot infer author intent after decoding.
 * Malformed escape-bearing JSON, duplicate/deep suspicious escape evidence, and
 * unpaired UTF-16 surrogates keep the fail-closed path.
 */
export function collectUnsafeUnicodeEscapeEvidence(json: string): UnicodeEscapeEvidence | undefined {
	const hasUnicodeEscape = json.includes("\\u");
	if (!hasUnicodeEscape && json.isWellFormed()) return undefined;
	const evidence = hasUnicodeEscape ? collectUnicodeEscapeEvidence(json) : undefined;
	if (evidence?.malformed) return evidence;
	try {
		if (hasUnpairedUnicodeSurrogate(JSON.parse(json))) {
			return createUnicodeEscapeEvidence([], 0, false, true);
		}
	} catch {
		return createUnicodeEscapeEvidence([], 0, false, true);
	}
	return undefined;
}

/** Attach unsafe raw evidence while preserving the existing call-level guard flag. */
export function captureUnicodeEscapeEvidence(target: UnicodeEscapeEvidenceTarget, json: string): boolean {
	const evidence = collectUnsafeUnicodeEscapeEvidence(json);
	if (!evidence) return false;
	attachUnicodeEscapeEvidence(target, evidence);
	return true;
}

/** Attach evidence as transient, non-enumerable metadata excluded from serialization. */
export function attachUnicodeEscapeEvidence(
	target: UnicodeEscapeEvidenceTarget,
	evidence: UnicodeEscapeEvidence,
): void {
	target.escapedNonAsciiArguments = true;
	Object.defineProperty(target, "escapedUnicodeArgumentEvidence", {
		value: evidence,
		writable: true,
		configurable: true,
		enumerable: false,
	});
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
