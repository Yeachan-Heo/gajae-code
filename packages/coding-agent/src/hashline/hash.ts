/**
 * Core hash utilities shared by hashline edit mode, read/search output,
 * and prompt helpers.
 */

import bigrams from "./bigrams.json" with { type: "json" };

// Optional native acceleration for formatHashLines. Loaded WITHOUT throwing at
// module evaluation so this core module (and its re-exported helpers) stays
// usable and falls back to the TS loop if the native addon is unavailable.
let formatHashLinesNative: ((text: string, startLine?: number) => string) | undefined;
void import("../../../natives/native/index.js")
	.then(mod => {
		if (typeof mod.h06FormatHashLines === "function") {
			formatHashLinesNative = mod.h06FormatHashLines;
		}
	})
	.catch(() => {
		// Native unavailable; formatHashLines uses the TS loop.
	});

/**
 * 647 single-token BPE bigrams for hashline anchors. Every entry tokenizes as
 * exactly one token in modern BPE vocabularies (cl100k / o200k / Anthropic model family),
 * so a hashline anchor built from one bigram is exactly 1 token.
 *
 * This is the complete set of 2-letter lowercase combinations that are single
 * tokens — the 29 missing combinations are rare-letter pairs (q/x/z heavy)
 * that no major BPE vocabulary merges into a single token.
 *
 * Order is stable forever — changing it would invalidate every saved
 * `LINE+ID` reference in transcripts and prompts.
 */
export const HL_BIGRAMS: readonly string[] = bigrams;

export const HL_BIGRAMS_COUNT = HL_BIGRAMS.length;

/**
 * Decoration prefix that may precede a `LINE+HASH` anchor in tool output:
 * `>` (context line in grep), `+` (added line in diff), `-` (removed line),
 * `*` (match line). Any combination, in any order, surrounded by optional
 * whitespace. Output formatters emit at most one decoration per anchor; the
 * regex stays liberal because anchor-ref parsers accept whatever the model
 * echoes back.
 */
export const HL_ANCHOR_DECORATION_RE_RAW = `\\s*[>+\\-*]*\\s*`;

/**
 * Capture-group regex source for a decorated `LINE+HASH` anchor. Group 1
 * captures the line number (digits only); group 2 captures the hash. The
 * source is intentionally unanchored — anchoring with `^` (or composing into a
 * larger pattern) is the caller's responsibility.
 */
export const HL_ANCHOR_RE_RAW = `${HL_ANCHOR_DECORATION_RE_RAW}(\\d+)([a-z]{2})`;

/**
 * Bare `LINE+HASH` Lid (no decorations, no captures, no anchors). Use for
 * embedding inside larger patterns where the line+hash unit appears as a
 * literal (e.g. range bounds, alternation arms, op-line heuristics).
 */
export const HL_HASH_RE_RAW = `[1-9]\\d*[a-z]{2}`;

/**
 * Capture-group form of {@link HL_HASH_RE_RAW}: group 1 captures the
 * line number, group 2 captures the hash.
 */
export const HL_HASH_CAPTURE_RE_RAW = `([1-9]\\d*)([a-z]{2})`;

/** Width of a hash in display characters. */
export const HL_HASH_WIDTH = 2;

/**
 * Representative hash suffixes for use in user-facing error messages and
 * prompt examples.
 */
export const HL_HASH_EXAMPLES = ["sr", "ab", "th"] as const;

/**
 * Format a comma-separated list of example anchors with an optional line-number
 * prefix, quoted for inclusion in error messages: `"160sr", "160ab", "160th"`.
 */
export function describeAnchorExamples(linePrefix = ""): string {
	return HL_HASH_EXAMPLES.map(e => `"${linePrefix}${e}"`).join(", ");
}

/**
 * Substitute every grammar placeholder with the value derived from its
 * TypeScript counterpart. Grammars that don't reference these placeholders
 * pass through unchanged.
 */
export function resolveHashlineGrammarPlaceholders(grammar: string): string {
	return grammar
		.replaceAll("$HFMT$", "[a-z]{2}")
		.replaceAll("$HOP_INSERT_BEFORE$", HL_OP_INSERT_BEFORE)
		.replaceAll("$HOP_INSERT_AFTER$", HL_OP_INSERT_AFTER)
		.replaceAll("$HOP_REPLACE$", HL_OP_REPLACE)
		.replaceAll("$HOP_CHARS$", HL_OP_CHARS)
		.replaceAll("$HFILE$", HL_FILE_PREFIX);
}

/** @deprecated Use {@link resolveHashlineGrammarPlaceholders}. */
export const resolveLarkLidPlaceholders = resolveHashlineGrammarPlaceholders;

const regexEscape = (str: string): string => str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Hashline edit input markers. File section headers start with {@link HL_FILE_PREFIX};
 * op lines start with a direction/action sigil: {@link HL_OP_INSERT_BEFORE},
 * {@link HL_OP_INSERT_AFTER}, or {@link HL_OP_REPLACE}. Payload lines are
 * verbatim file content and have no per-line marker.
 *
 * These constants are the single source of truth for the edit parser, grammar,
 * renderer, and prompt.
 */
export const HL_OP_INSERT_BEFORE = "«";
export const HL_OP_INSERT_AFTER = "»";
export const HL_OP_REPLACE = "≔";

/** All hashline edit op sigils, concatenated for fast membership tests. */
export const HL_OP_CHARS = `${HL_OP_INSERT_BEFORE}${HL_OP_INSERT_AFTER}${HL_OP_REPLACE}`;

/** Hashline edit file section header marker. */
export const HL_FILE_PREFIX = "§";

/** Stable separator for read/search/hashline display output. Intentionally not configurable. */
export const HL_BODY_SEP = "|";

/** Regex-escaped form of {@link HL_BODY_SEP}, safe for embedding inside a regex. */
export const HL_BODY_SEP_RE_RAW = regexEscape(HL_BODY_SEP);

/**
 * Compute a 2-character hash of a single line via xxHash32 mod 647 over
 * {@link HL_BIGRAMS}. The hash depends only on the line's content (after
 * stripping CR and trailing whitespace); the `idx` parameter is accepted
 * for call-site symmetry with line numbers but is intentionally unused so
 * that anchors remain stable across line shifts caused by sibling edits.
 *
 * The line input should not include a trailing newline.
 */
export function computeLineHash(idx: number, line: string): string {
	void idx;
	line = line.replace(/\r/g, "").trimEnd();
	// Seed is fixed so the hash depends only on line content. Earlier we mixed
	// in `idx` for blank/punctuation-only lines, but that meant any line shift
	// (e.g. from a sibling edit in the same batch) invalidated anchors whose
	// content had not changed. Identical blank lines are intentionally allowed
	// to collide — the edit op's line number disambiguates them.
	return HL_BIGRAMS[Bun.hash.xxHash32(line, 0) % HL_BIGRAMS_COUNT];
}

/**
 * Formats an anchor reference given a line number and its text.
 * Returns `LINE+ID` (e.g., `42sr`) — no separator between
 * number and hash.
 */
export function formatLineHash(line: number, lines: string): string {
	return `${line}${computeLineHash(line, lines)}`;
}

/**
 * Formats a single line with a hashline anchor.
 * Returns `LINE+ID|TEXT` (e.g., `42sr|function hi() {`, `3ab|}`).
 */
export function formatHashLine(lineNumber: number, line: string): string {
	return `${lineNumber}${computeLineHash(lineNumber, line)}${HL_BODY_SEP}${line}`;
}

/**
 * Format file text with hashline prefixes for display.
 *
 * Each line becomes `LINE+ID|TEXT` where LINENUM is 1-indexed.
 * No padding on line numbers; pipe separator between anchor and content.
 *
 * @param text - Raw file text string
 * @param startLine - First line number (1-indexed, defaults to 1)
 * @returns Formatted string with one hashline-prefixed line per input line
 *
 * @example
 * ```
 * formatHashLines("function hi() {\n  return;\n}")
 * // "1bm|function hi() {\n2er|  return;\n3ab|}"
 * ```
 */
export function formatHashLines(text: string, startLine = 1): string {
	// Native path only for the supported startLine domain (non-negative integer);
	// other values fall through to JS numeric semantics in the TS loop.
	if (formatHashLinesNative && Number.isInteger(startLine) && startLine >= 0) {
		try {
			return formatHashLinesNative(text, startLine);
		} catch {
			// Native hashline formatting is an optimization only; preserve the TS contract.
		}
	}
	const lines = text.split("\n");
	return lines.map((line, i) => formatHashLine(startLine + i, line)).join("\n");
}
