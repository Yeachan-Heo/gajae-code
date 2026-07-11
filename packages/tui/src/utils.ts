import {
	Ellipsis,
	type ExtractSegmentsResult,
	extractSegments as nativeExtractSegments,
	sliceWithWidth as nativeSliceWithWidth,
	truncateLinesToWidth as nativeTruncateLinesToWidth,
	truncateToWidth as nativeTruncateToWidth,
	visibleWidth as nativeVisibleWidth,
	visibleWidths as nativeVisibleWidths,
	wrapTextWithAnsi as nativeWrapTextWithAnsi,
	type SliceResult,
} from "@gajae-code/natives";
import { getDefaultTabWidth, getIndentation, onDefaultTabWidthChange } from "@gajae-code/utils";
import { renderMetrics } from "./metrics";

export { Ellipsis } from "@gajae-code/natives";

export { getDefaultTabWidth, getIndentation } from "@gajae-code/utils";
/** Test-only performance counters for advisory baseline tests. */
export const __textHelperPerfCounters = {
	truncateToWidthCalls: 0,
	wrapTextWithAnsiCalls: 0,
	truncateLinesToWidthCalls: 0,
	visibleWidthsCalls: 0,
	reset(): void {
		this.truncateToWidthCalls = 0;
		this.wrapTextWithAnsiCalls = 0;
		this.truncateLinesToWidthCalls = 0;
		this.visibleWidthsCalls = 0;
	},
};

function recordTextHelper<T>(name: string, fn: () => T): T {
	if (!renderMetrics.enabled) return fn();
	const start = renderMetrics.now();
	try {
		return fn();
	} finally {
		renderMetrics.recordHelper(name, renderMetrics.now() - start);
	}
}

let cachedTabWidth: number | undefined;

function getCachedTabWidth(): number {
	cachedTabWidth ??= getDefaultTabWidth();
	return cachedTabWidth;
}

export function invalidateTabWidthCache(): void {
	cachedTabWidth = undefined;
}
onDefaultTabWidthChange(invalidateTabWidthCache);

export function isPrintableAscii(text: string): boolean {
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		if (code < 0x20 || code > 0x7e) return false;
	}
	return true;
}

export function sliceWithWidth(line: string, startCol: number, length: number, strict?: boolean | null): SliceResult {
	return nativeSliceWithWidth(line, startCol, length, strict ?? null, getCachedTabWidth());
}

export function truncateToWidth(
	text: string,
	maxWidth: number,
	ellipsisKind?: Ellipsis | null,
	pad?: boolean | null,
): string {
	__textHelperPerfCounters.truncateToWidthCalls += 1;
	// Guard nullish napi inputs: napi-rs 3 on the Windows prebuilt rejects
	// `null` for `Option<u8>` (Ellipsis) / `Option<bool>` (pad) (issue #848),
	// and `maxWidth` is a required `u32` that throws on `null`/`undefined`
	// everywhere. The `text` arg is a required `String` that likewise throws on
	// `null`/`undefined` on every platform, which crashed renderers that passed
	// an optional/possibly-undefined field. Pass concrete defaults that mirror
	// the Rust `unwrap_or`s.
	const safeText = typeof text === "string" ? text : String(text ?? "");
	const safeWidth = Number.isFinite(maxWidth) ? Math.max(0, Math.trunc(maxWidth)) : 0;
	let resolvedEllipsis: Ellipsis | null | undefined | string = ellipsisKind;
	if (typeof resolvedEllipsis === "string") {
		resolvedEllipsis = resolvedEllipsis === "" ? Ellipsis.Omit : Ellipsis.Unicode;
	}
	return nativeTruncateToWidth(
		safeText,
		safeWidth,
		resolvedEllipsis ?? Ellipsis.Unicode,
		pad ?? false,
		getCachedTabWidth(),
	);
}

export function truncateLinesToWidth(
	lines: readonly string[],
	maxWidth: number,
	ellipsisKind?: Ellipsis | null,
	pad?: boolean | null,
): string[] {
	__textHelperPerfCounters.truncateLinesToWidthCalls += 1;
	const safeWidth = Number.isFinite(maxWidth) ? Math.max(0, Math.trunc(maxWidth)) : 0;
	let resolvedEllipsis: Ellipsis | null | undefined | string = ellipsisKind;
	if (typeof resolvedEllipsis === "string") {
		resolvedEllipsis = resolvedEllipsis === "" ? Ellipsis.Omit : Ellipsis.Unicode;
	}
	return nativeTruncateLinesToWidth(
		lines.map(line => (typeof line === "string" ? line : String(line ?? ""))),
		safeWidth,
		resolvedEllipsis ?? Ellipsis.Unicode,
		pad ?? false,
		getCachedTabWidth(),
	);
}

export function wrapTextWithAnsi(text: string, width: number): string[] {
	__textHelperPerfCounters.wrapTextWithAnsiCalls += 1;
	return nativeWrapTextWithAnsi(text, width, getCachedTabWidth());
}

export function extractSegments(
	line: string,
	beforeEnd: number,
	afterStart: number,
	afterLen: number,
	strictAfter: boolean,
): ExtractSegmentsResult {
	return nativeExtractSegments(line, beforeEnd, afterStart, afterLen, strictAfter, getCachedTabWidth());
}

// Pre-allocated space buffer for padding
const SPACE_BUFFER = " ".repeat(512);

/**
 * Tab width in columns for `file`, using `process.cwd()` as the project root for relative paths.
 */
export function getIndentationNoescape(file?: string): number {
	return getIndentation(file, process.cwd());
}

/*
 * Replace tabs with configured spacing for consistent rendering.
 */
export function replaceTabs(text: string, file?: string): string {
	return text.replaceAll("\t", " ".repeat(getIndentation(file)));
}

/**
 * Returns a string of n spaces. Uses a pre-allocated buffer for efficiency.
 */
export function padding(n: number): string {
	if (n <= 0) return "";
	if (n <= 512) return SPACE_BUFFER.slice(0, n);
	return " ".repeat(n);
}

// Grapheme segmenter (shared instance)
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * Get the shared grapheme segmenter instance.
 */
export function getSegmenter(): Intl.Segmenter {
	return segmenter;
}

export interface ViewportAnchorSpan {
	graphemeStart: number;
	graphemeEnd: number;
	cellStart: number;
	cellEnd: number;
}

export interface ViewportAnchorAnnotation {
	text: string;
	nextGrapheme: number;
	nextCell: number;
	token: string;
}

// APC marker for viewport anchors. Must NOT start with "\x1b_G": that is the
// Kitty graphics prefix and TERMINAL.isImageLine() would misclassify every
// annotated line as an image line, which skips wrapping (issue: assistant
// prose overflowing the terminal on Kitty-protocol terminals).
export const VIEWPORT_ANCHOR_PREFIX = "\x1b_AGJC_ANCHOR:";
const VIEWPORT_ANCHOR_SUFFIX = "\x1b\\";

function ansiSequenceEnd(text: string, start: number): number {
	if (text[start] !== "\x1b" || start + 1 >= text.length) return start;
	const kind = text[start + 1];
	if (kind === "[") {
		let index = start + 2;
		while (index < text.length) {
			const code = text.charCodeAt(index++);
			if (code >= 0x40 && code <= 0x7e) return index;
		}
		return text.length;
	}
	if (kind === "]" || kind === "_" || kind === "P" || kind === "^" || kind === "X") {
		const bel = text.indexOf("\x07", start + 2);
		const st = text.indexOf("\x1b\\", start + 2);
		if (bel < 0) return st < 0 ? text.length : st + 2;
		if (st < 0) return bel + 1;
		return Math.min(bel + 1, st + 2);
	}
	return Math.min(text.length, start + 2);
}

/**
 * Tag every visible grapheme with an APC marker that survives ANSI-aware
 * wrapping. The marker contains source grapheme and monotonic cell offsets.
 */
export function annotateViewportAnchorGraphemes(
	text: string,
	startGrapheme = 0,
	startCell = 0,
	token = crypto.randomUUID(),
): ViewportAnchorAnnotation {
	let result = "";
	let grapheme = startGrapheme;
	let cell = startCell;
	let textStart = 0;
	const appendVisible = (visible: string): void => {
		for (const part of segmenter.segment(visible)) {
			if (part.segment === "\n" || part.segment === "\r") {
				result += part.segment;
				continue;
			}
			const cellEnd = cell + Math.max(1, visibleWidth(part.segment));
			result += `${part.segment}${VIEWPORT_ANCHOR_PREFIX}${token}:${grapheme}:${grapheme + 1}:${cell}:${cellEnd}${VIEWPORT_ANCHOR_SUFFIX}`;
			grapheme += 1;
			cell = cellEnd;
		}
	};
	for (let index = 0; index < text.length; ) {
		if (text[index] !== "\x1b") {
			index += 1;
			continue;
		}
		appendVisible(text.slice(textStart, index));
		const end = ansiSequenceEnd(text, index);
		result += text.slice(index, end);
		index = end;
		textStart = end;
	}
	appendVisible(text.slice(textStart));
	return { text: result, nextGrapheme: grapheme, nextCell: cell, token };
}

/** Remove viewport anchor markers and return the exact marked span for each row. */
export function extractViewportAnchorRows(
	lines: readonly string[],
	token: string,
): { lines: string[]; spans: Array<ViewportAnchorSpan | null> } {
	const markerRegex = new RegExp(`\\x1b_AGJC_ANCHOR:${token}:(\\d+):(\\d+):(\\d+):(\\d+)\\x1b\\\\`, "g");
	const cleanLines: string[] = [];
	const spans: Array<ViewportAnchorSpan | null> = [];
	for (const line of lines) {
		let span: ViewportAnchorSpan | null = null;
		const clean = line.replace(markerRegex, (_marker, start, end, cellStart, cellEnd) => {
			const candidate = {
				graphemeStart: Number(start),
				graphemeEnd: Number(end),
				cellStart: Number(cellStart),
				cellEnd: Number(cellEnd),
			};
			if (!span) {
				span = candidate;
			} else {
				span.graphemeStart = Math.min(span.graphemeStart, candidate.graphemeStart);
				span.graphemeEnd = Math.max(span.graphemeEnd, candidate.graphemeEnd);
				span.cellStart = Math.min(span.cellStart, candidate.cellStart);
				span.cellEnd = Math.max(span.cellEnd, candidate.cellEnd);
			}
			return "";
		});
		cleanLines.push(clean);
		spans.push(span);
	}
	return { lines: cleanLines, spans };
}
function normalizeForWidth(str: string): string {
	const normalized = str.normalize("NFC");
	return normalized === str ? str : normalized;
}

function hasUnpairedSurrogate(str: string): boolean {
	for (let index = 0; index < str.length; index++) {
		const code = str.charCodeAt(index);
		if (code >= 0xd800 && code <= 0xdbff) {
			const next = str.charCodeAt(index + 1);
			if (next >= 0xdc00 && next <= 0xdfff) {
				index += 1;
				continue;
			}
			return true;
		}
		if (code >= 0xdc00 && code <= 0xdfff) return true;
	}
	return false;
}
export function visibleWidthRaw(str: string): number {
	if (!str) {
		return 0;
	}
	if (str.length === 1) {
		const code = str.charCodeAt(0);
		if (code >= 0x20 && code <= 0x7e) return 1;
		if (code === 9) return getCachedTabWidth();
	}

	let tabCount = 0;
	let isPureAscii = true;
	for (let i = 0; i < str.length; i++) {
		const code = str.charCodeAt(i);
		if (code === 9) {
			tabCount += 1;
		} else if (code < 0x20 || code > 0x7e) {
			isPureAscii = false;
		}
	}
	if (isPureAscii) {
		return str.length + tabCount * (getCachedTabWidth() - 1);
	}
	const normalized = normalizeForWidth(str);
	const text = tabCount === 0 ? normalized : normalized.replaceAll("\t", " ".repeat(getCachedTabWidth()));
	return nativeVisibleWidth(text, getCachedTabWidth());
}

/**
 * Calculate the visible width of a string in terminal columns.
 */
export function visibleWidth(str: string): number {
	if (!renderMetrics.enabled) return visibleWidthRaw(str);
	return recordTextHelper("text.visibleWidth", () => visibleWidthRaw(str));
}

export function visibleWidthsNative(lines: readonly string[]): number[] {
	__textHelperPerfCounters.visibleWidthsCalls += 1;
	const safeLines = lines.map(line => (typeof line === "string" ? line : String(line ?? "")));
	const widths = nativeVisibleWidths(safeLines, getCachedTabWidth());
	for (let index = 0; index < safeLines.length; index++) {
		const line = safeLines[index]!;
		if (hasUnpairedSurrogate(line)) widths[index] = visibleWidthRaw(line);
	}
	return widths;
}

export function visibleWidths(lines: readonly string[]): number[] {
	if (!renderMetrics.enabled) return visibleWidthsNative(lines);
	return recordTextHelper("text.visibleWidths", () => visibleWidthsNative(lines));
}

const THAI_LAO_AM_REGEX = /[\u0e33\u0eb3]/;
const THAI_LAO_AM_GLOBAL_REGEX = /[\u0e33\u0eb3]/g;
const HANGUL_JAMO_REGEX = /[\u1100-\u11ff\ua960-\ua97f\ud7b0-\ud7ff]/;

/**
 * Normalize text for terminal output without changing logical editor content.
 * Some terminals render canonically decomposed Hangul jamo or precomposed
 * Thai/Lao AM vowels inconsistently during differential repaint. Emit a stable
 * terminal form while keeping the component/source strings unchanged.
 */
export function normalizeTerminalOutput(str: string): string {
	let normalized = str;
	if (HANGUL_JAMO_REGEX.test(normalized)) normalized = normalized.normalize("NFC");
	if (!THAI_LAO_AM_REGEX.test(normalized)) return normalized;
	return normalized.replaceAll(THAI_LAO_AM_GLOBAL_REGEX, char =>
		char === "\u0e33" ? "\u0e4d\u0e32" : "\u0ecd\u0eb2",
	);
}

const makeBoolArray = (chars: string): Uint8Array => {
	const table = new Uint8Array(128);
	for (let i = 0; i < chars.length; i++) {
		const code = chars.charCodeAt(i);
		if (code < table.length) {
			table[code] = 1;
		}
	}
	return table;
};

const ASCII_WHITESPACE = makeBoolArray("\x09\x0a\x0b\x0c\x0d\x20");

/**
 * Check if a character is whitespace.
 */
export function isWhitespaceChar(char: string): boolean {
	const code = char.codePointAt(0) ?? 0;
	return code < 128 && ASCII_WHITESPACE[code] === 1;
}

const ASCII_PUNCTUATION = makeBoolArray("(){}[]<>.,;:'\"!?+-=*/\\|&%^$#@~`");

/**
 * Check if a character is punctuation.
 */
export function isPunctuationChar(char: string): boolean {
	const code = char.codePointAt(0) ?? 0;
	return code < 128 && ASCII_PUNCTUATION[code] === 1;
}

export type WordNavKind = "whitespace" | "delimiter" | "cjk" | "word" | "other";

const WORD_NAV_RE_WHITESPACE = /^\p{White_Space}$/u;
const WORD_NAV_RE_PUNCT = /^\p{P}$/u;
const WORD_NAV_RE_SYMBOL = /^\p{S}$/u;
const WORD_NAV_RE_LETTER = /^\p{L}$/u;
const WORD_NAV_RE_NUMBER = /^\p{N}$/u;
const WORD_NAV_RE_HAN = /^\p{Script=Han}$/u;
const WORD_NAV_RE_HIRAGANA = /^\p{Script=Hiragana}$/u;
const WORD_NAV_RE_KATAKANA = /^\p{Script=Katakana}$/u;
const WORD_NAV_RE_HANGUL = /^\p{Script=Hangul}$/u;

function firstCodePointChar(str: string): string {
	const cp = str.codePointAt(0);
	if (cp === undefined) return "";
	return String.fromCodePoint(cp);
}

/**
 * Coarse Unicode-aware character classification for word navigation (Option/Alt + Left/Right).
 * This intentionally avoids language-specific word segmentation for predictability across scripts.
 */
export function getWordNavKind(grapheme: string): WordNavKind {
	if (!grapheme) return "other";
	const ch = firstCodePointChar(grapheme);
	if (!ch) return "other";
	if (WORD_NAV_RE_WHITESPACE.test(ch)) return "whitespace";
	if (WORD_NAV_RE_PUNCT.test(ch) || WORD_NAV_RE_SYMBOL.test(ch)) return "delimiter";
	if (
		WORD_NAV_RE_HAN.test(ch) ||
		WORD_NAV_RE_HIRAGANA.test(ch) ||
		WORD_NAV_RE_KATAKANA.test(ch) ||
		WORD_NAV_RE_HANGUL.test(ch)
	) {
		return "cjk";
	}
	if (ch === "_" || WORD_NAV_RE_LETTER.test(ch) || WORD_NAV_RE_NUMBER.test(ch)) return "word";
	return "other";
}

const WORD_NAV_JOINERS = new Set(["'", "’", "-", "‐", "‑"]);

export function isWordNavJoiner(grapheme: string): boolean {
	const ch = firstCodePointChar(grapheme);
	return WORD_NAV_JOINERS.has(ch);
}

/**
 * Move the cursor one "word" to the left using Unicode-aware coarse navigation.
 *
 * Returns a new cursor index in the range [0, text.length].
 */
export function moveWordLeft(text: string, cursor: number): number {
	const len = text.length;
	if (len === 0) return 0;
	let i = Math.min(Math.max(cursor, 0), len);
	if (i === 0) return 0;

	const graphemes = [...segmenter.segment(text.slice(0, i))];
	if (graphemes.length === 0) return 0;

	// Skip trailing whitespace.
	while (graphemes.length > 0 && getWordNavKind(graphemes[graphemes.length - 1]?.segment || "") === "whitespace") {
		i -= graphemes.pop()?.segment.length || 0;
	}
	if (i === 0 || graphemes.length === 0) return i;

	const kind = getWordNavKind(graphemes[graphemes.length - 1]?.segment || "");
	if (kind === "delimiter" || kind === "cjk") {
		while (graphemes.length > 0 && getWordNavKind(graphemes[graphemes.length - 1]?.segment || "") === kind) {
			i -= graphemes.pop()?.segment.length || 0;
		}
		return i;
	}

	if (kind === "word") {
		// Skip word run (letters/numbers/underscore), keeping common joiners inside words.
		let hasRightWord = false;
		while (graphemes.length > 0) {
			const g = graphemes[graphemes.length - 1]?.segment || "";
			const k = getWordNavKind(g);
			if (k === "word") {
				hasRightWord = true;
				i -= graphemes.pop()?.segment.length || 0;
				continue;
			}
			if (hasRightWord && k === "delimiter" && isWordNavJoiner(g)) {
				const left = graphemes[graphemes.length - 2]?.segment || "";
				if (getWordNavKind(left) === "word") {
					i -= graphemes.pop()?.segment.length || 0;
					continue;
				}
			}
			break;
		}
		return i;
	}

	// Fallback: move by one grapheme.
	i -= graphemes.pop()?.segment.length || 0;
	return Math.max(0, i);
}

/**
 * Move the cursor one "word" to the right using Unicode-aware coarse navigation.
 *
 * Returns a new cursor index in the range [0, text.length].
 */
export function moveWordRight(text: string, cursor: number): number {
	const len = text.length;
	if (len === 0) return 0;
	let i = Math.min(Math.max(cursor, 0), len);
	if (i === len) return len;

	const iterator = segmenter.segment(text.slice(i))[Symbol.iterator]();
	let next = iterator.next();

	// Skip leading whitespace.
	while (!next.done && getWordNavKind(next.value.segment) === "whitespace") {
		i += next.value.segment.length;
		next = iterator.next();
	}
	if (next.done) return i;

	const firstKind = getWordNavKind(next.value.segment);
	if (firstKind === "delimiter" || firstKind === "cjk") {
		while (!next.done && getWordNavKind(next.value.segment) === firstKind) {
			i += next.value.segment.length;
			next = iterator.next();
		}
		return i;
	}

	if (firstKind === "word") {
		let hasLeftWord = false;
		while (!next.done) {
			const segment = next.value.segment;
			const k = getWordNavKind(segment);
			if (k === "word") {
				hasLeftWord = true;
				i += segment.length;
				next = iterator.next();
				continue;
			}
			if (hasLeftWord && k === "delimiter" && isWordNavJoiner(segment)) {
				const lookahead = iterator.next();
				if (!lookahead.done && getWordNavKind(lookahead.value.segment) === "word") {
					i += segment.length;
					next = lookahead;
					continue;
				}
			}
			break;
		}
		return i;
	}

	// Fallback: move by one grapheme.
	return i + next.value.segment.length;
}

/**
 * Apply background color to a line, padding to full width.
 *
 * @param line - Line of text (may contain ANSI codes)
 * @param width - Total width to pad to
 * @param bgFn - Background color function
 * @returns Line with background applied and padded to width
 */
export function applyBackgroundToLine(line: string, width: number, bgFn: (text: string) => string): string {
	// Calculate padding needed
	const visibleLen = visibleWidth(line);
	const paddingNeeded = Math.max(0, width - visibleLen);

	// Apply background to content + padding
	const withPadding = line + padding(paddingNeeded);
	return bgFn(withPadding);
}

/**
 * Extract a range of visible columns from a line. Handles ANSI codes and wide chars.
 *
 * @param strict - If true, exclude wide chars at boundary that would extend past the range
 */
export function sliceByColumn(line: string, startCol: number, length: number, strict = false): string {
	return sliceWithWidth(line, startCol, length, strict).text;
}
