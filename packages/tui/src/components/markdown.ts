import { LRUCache } from "lru-cache/raw";
import { Marked, marked, type Token, Tokenizer, type Tokens } from "marked";
import type { SymbolTheme } from "../symbols";
import { TERMINAL } from "../terminal-capabilities";
import type { Component } from "../tui";
import {
	applyBackgroundToLine,
	padding,
	replaceTabs,
	type ViewportAnchorSpan,
	visibleWidth,
	wrapTextWithAnsi,
} from "../utils";

const STRICT_STRIKETHROUGH_REGEX = /^(~~)(?=[^\s~])((?:\\.|[^\\])*?(?:\\.|[^\s~\\]))\1(?=[^~]|$)/;

class StrictStrikethroughTokenizer extends Tokenizer {
	override del(src: string): Tokens.Del | undefined {
		const match = STRICT_STRIKETHROUGH_REGEX.exec(src);
		if (!match) {
			return undefined;
		}

		const text = match[2];
		return {
			type: "del",
			raw: match[0],
			text,
			tokens: this.lexer.inlineTokens(text),
		};
	}
}

const markdownParser = new Marked();
markdownParser.setOptions({
	tokenizer: new StrictStrikethroughTokenizer(),
});

// ---------------------------------------------------------------------------
// Module-level LRU render cache
// ---------------------------------------------------------------------------
// Each session-tree navigation discards and recreates Markdown component
// instances, so the per-instance #cachedLines field is always cold on first
// render of a fresh component. This module-level cache survives across
// component lifetimes and eliminates redundant marked.lexer + highlightCode
// (Rust FFI) work for content/layout combinations already seen this session.

const RENDER_CACHE_MAX = 256; // sane cap: ~256 distinct message × width combos
const renderCache = new LRUCache<
	string,
	{ source: string; lines: string[]; anchorSpans?: Array<ViewportAnchorSpan | null> }
>({
	max: RENDER_CACHE_MAX,
});
const PARSE_CACHE_MAX = 128;
const parseCache = new LRUCache<string, { source: string; tokens: Token[] }>({ max: PARSE_CACHE_MAX });
const MARKDOWN_STREAM_THROTTLE_MS = 64;
let markdownNow = (): number => performance.now();

// Viewport anchor offsets are numbered over each top-level token's width-invariant
// source-text span (scaled to leave room for content rows) instead of the
// width-dependent rendered glyph stream. HR fill length, per-row blockquote
// prefixes, and boxed/raw table topology all change the rendered glyph count with
// width; source-text spans do not, so anchors resolve to the same content after a
// topology-changing reflow (#2031). The scale guarantees each content row a
// positive, non-overlapping sub-span even when a token wraps into more rows than
// its source has characters.
const ANCHOR_SOURCE_SCALE = 1 << 16;

/** Test-only clock seam for streaming throttle tests. */
export function __setMarkdownNowForTest(now: (() => number) | undefined): void {
	markdownNow = now ?? (() => performance.now());
}

// Per-code-block highlight cache (F3): keyed by theme + lang + code so streaming
// appends only highlight new/changed blocks instead of re-highlighting the whole
// prefix on every chunk. Bounded LRU; cleared on theme change via clearRenderCache().
const HIGHLIGHT_CACHE_MAX = 512;
const highlightCache = new LRUCache<string, string[]>({ max: HIGHLIGHT_CACHE_MAX });

function renderedLinesBytes(lines: readonly string[]): number {
	let bytes = 0;
	for (const line of lines) bytes += Buffer.byteLength(line, "utf8");
	return bytes;
}

function anchorSpansBytes(spans: readonly (ViewportAnchorSpan | null)[]): number {
	let bytes = spans.length * 8; // Array element references
	for (const span of spans) {
		if (span) bytes += 4 * 8; // Four numeric offsets
	}
	return bytes;
}

// F18: cap synchronous (Rust FFI) syntax highlighting so a single huge fenced block
// cannot stall the UI thread; oversized blocks render plain with a sanitized marker.
const MAX_HIGHLIGHT_BYTES = 200_000;
const MAX_HIGHLIGHT_LINES = 2000;
let highlightCallCount = 0;
/** Test/diagnostic seam: number of synchronous highlight invocations since the last reset. */
export function getMarkdownHighlightCallCount(): number {
	return highlightCallCount;
}
export function resetMarkdownHighlightCallCount(): void {
	highlightCallCount = 0;
}

/** Test-only performance counters for advisory baseline tests. */
export const __markdownPerfCounters = {
	lexerInvocations: 0,
	lexedBytes: 0,
	reset(): void {
		this.lexerInvocations = 0;
		this.lexedBytes = 0;
	},
};

// Full-content 64-bit wyhash over every byte (no lossy sampling). Cache hits
// additionally verify entry.source against the normalized text, so even a
// hash collision can never return another message's render.
function markdownContentKey(text: string): string {
	return `${text.length}:${Bun.hash(text).toString(36)}`;
}

function wrapTextIfNeeded(line: string, width: number): string[] {
	return wrapTextWithAnsi(line, width);
}

/** Drop all L2 cache entries. Call on theme change to prevent stale styled output. */
export function clearRenderCache(): void {
	renderCache.clear();
	parseCache.clear();
	highlightCache.clear();
}

export function getRenderCacheRetainedBytes(): number {
	let bytes = 0;
	for (const entry of renderCache.values()) {
		bytes += Buffer.byteLength(entry.source, "utf8");
		bytes += renderedLinesBytes(entry.lines);
		if (entry.anchorSpans) bytes += anchorSpansBytes(entry.anchorSpans);
	}
	for (const entry of parseCache.values()) bytes += Buffer.byteLength(entry.source, "utf8");
	for (const lines of highlightCache.values()) bytes += renderedLinesBytes(lines);
	return bytes;
}

// Stable numeric IDs for structural theme/style objects (no ID field on type).
// Symbol-keyed so the id travels with the object and is invisible to consumers.
const kObjectId = Symbol("markdown.objectId");
type WithObjectId = object & { [kObjectId]?: number };
let nextObjectId = 0;
function objectId(o: object): number {
	const tagged = o as WithObjectId;
	let id = tagged[kObjectId];
	if (id === undefined) {
		id = nextObjectId++;
		tagged[kObjectId] = id;
	}
	return id;
}

/**
 * Default text styling for markdown content.
 * Applied to all text unless overridden by markdown formatting.
 */
export interface DefaultTextStyle {
	/** Foreground color function */
	color?: (text: string) => string;
	/** Background color function */
	bgColor?: (text: string) => string;
	/** Bold text */
	bold?: boolean;
	/** Italic text */
	italic?: boolean;
	/** Strikethrough text */
	strikethrough?: boolean;
	/** Underline text */
	underline?: boolean;
}

/**
 * Theme functions for markdown elements.
 * Each function takes text and returns styled text with ANSI codes.
 */
export interface MarkdownTheme {
	heading: (text: string) => string;
	link: (text: string) => string;
	linkUrl: (text: string) => string;
	code: (text: string) => string;
	codeBlock: (text: string) => string;
	codeBlockBorder: (text: string) => string;
	quote: (text: string) => string;
	quoteBorder: (text: string) => string;
	hr: (text: string) => string;
	listBullet: (text: string) => string;
	bold: (text: string) => string;
	italic: (text: string) => string;
	strikethrough: (text: string) => string;
	underline: (text: string) => string;
	highlightCode?: (code: string, lang?: string) => string[];
	/**
	 * Resolve a mermaid ASCII rendering by fenced block source text.
	 * Return null to fall back to fenced code rendering.
	 */
	resolveMermaidAscii?: (source: string) => string | null;
	symbols: SymbolTheme;
}

interface InlineStyleContext {
	applyText: (text: string) => string;
	stylePrefix: string;
}

type ListToken = Token & { items: Array<{ tokens?: Token[] }>; ordered: boolean; start?: number };
type TableCellToken = { tokens?: Token[] };
type TableToken = Token & { header: TableCellToken[]; rows: TableCellToken[][]; raw?: string };

function formatHyperlink(text: string, target: string): string {
	if (!TERMINAL.hyperlinks || !target) {
		return text;
	}

	const safeTarget = target.replaceAll("\x1b", "").replaceAll("\x07", "");
	if (!safeTarget) {
		return text;
	}

	return `\x1b]8;;${safeTarget}\x07${text}\x1b]8;;\x07`;
}

function stripHtmlComments(raw: string): string {
	let result = "";
	let index = 0;

	while (index < raw.length) {
		const start = raw.indexOf("<!--", index);
		if (start < 0) {
			result += raw.slice(index);
			break;
		}

		result += raw.slice(index, start);
		const end = raw.indexOf("-->", start + 4);
		if (end < 0) {
			result += raw.slice(start);
			break;
		}
		index = end + 3;
	}

	return result;
}

export class Markdown implements Component {
	#text: string;
	#paddingX: number; // Left/right padding
	#paddingY: number; // Top/bottom padding
	#defaultTextStyle?: DefaultTextStyle;
	#theme: MarkdownTheme;
	#defaultStylePrefix?: string;
	/** Number of spaces used to indent code block content. */
	#codeBlockIndent: number;

	// Cache for rendered output
	#cachedText?: string;
	#cachedWidth?: number;
	#cachedLines?: string[];
	#cachedAnchorSpans?: Array<ViewportAnchorSpan | null>;

	#streaming = false;
	#lastFullParseAt = 0;
	#onStaleThrottle?: () => void;
	#staleThrottleTimer?: ReturnType<typeof setTimeout>;

	constructor(
		text: string,
		paddingX: number,
		paddingY: number,
		theme: MarkdownTheme,
		defaultTextStyle?: DefaultTextStyle,
		codeBlockIndent: number = 2,
	) {
		this.#text = text;
		this.#paddingX = paddingX;
		this.#paddingY = paddingY;
		this.#theme = theme;
		this.#defaultTextStyle = defaultTextStyle;
		this.#codeBlockIndent = Math.max(0, Math.floor(codeBlockIndent));
	}

	setOnStaleThrottle(callback: (() => void) | undefined): void {
		this.#onStaleThrottle = callback;
	}

	setText(text: string, options?: { streaming?: boolean }): void {
		if (options?.streaming !== undefined) {
			this.setStreaming(options.streaming);
		}
		this.#text = text;
		if (this.#streaming) {
			return;
		}
		this.invalidate();
	}

	setStreaming(streaming: boolean): void {
		if (this.#streaming === streaming) return;
		this.#streaming = streaming;
		if (!streaming) {
			this.#clearStaleThrottleTimer();
			this.#lastFullParseAt = 0;
			this.invalidate();
		}
	}

	#clearStaleThrottleTimer(): void {
		if (!this.#staleThrottleTimer) return;
		clearTimeout(this.#staleThrottleTimer);
		this.#staleThrottleTimer = undefined;
	}

	#armStaleThrottleTimer(remainingMs: number): void {
		if (!this.#onStaleThrottle || this.#staleThrottleTimer || this.#cachedText === this.#text) return;
		this.#staleThrottleTimer = setTimeout(
			() => {
				this.#staleThrottleTimer = undefined;
				if (this.#streaming && this.#cachedText !== this.#text) {
					this.#onStaleThrottle?.();
				}
			},
			Math.max(0, remainingMs),
		);
		this.#staleThrottleTimer.unref?.();
	}

	dispose(): void {
		this.#clearStaleThrottleTimer();
	}

	invalidate(): void {
		this.#cachedText = undefined;
		this.#cachedWidth = undefined;
		this.#cachedLines = undefined;
		this.#cachedAnchorSpans = undefined;
	}

	#exceedsHighlightCap(code: string): boolean {
		let newlines = 0;
		for (let i = 0; i < code.length; i++) {
			if (code.charCodeAt(i) === 10) newlines += 1;
		}
		if (newlines + 1 > MAX_HIGHLIGHT_LINES) return true;
		// UTF-8 byte length (not UTF-16 code-unit count) so a non-ASCII block cannot
		// exceed the advertised byte cap and still reach the synchronous highlighter.
		return Buffer.byteLength(code, "utf8") > MAX_HIGHLIGHT_BYTES;
	}

	#highlightCodeBlock(code: string, lang: string): string[] | null {
		if (!this.#theme.highlightCode) return null;
		if (this.#exceedsHighlightCap(code)) return null;
		const key = `${objectId(this.#theme)}\x00${lang}\x00${code}`;
		const cached = highlightCache.get(key);
		if (cached) return cached;
		highlightCallCount += 1;
		const result = this.#theme.highlightCode(code, lang || undefined);
		highlightCache.set(key, result);
		return result;
	}

	#emitCodeBlock(lines: string[], code: string, lang: string, codeIndent: string): void {
		lines.push(this.#theme.codeBlockBorder(`\`\`\`${lang}`));
		const highlighted = this.#highlightCodeBlock(code, lang);
		if (highlighted) {
			for (const hlLine of highlighted) {
				lines.push(`${codeIndent}${hlLine}`);
			}
		} else {
			if (this.#theme.highlightCode && this.#exceedsHighlightCap(code)) {
				lines.push(`${codeIndent}${this.#theme.codeBlock("[syntax highlighting skipped: code block too large]")}`);
			}
			for (const codeLine of code.split("\n")) {
				lines.push(`${codeIndent}${this.#theme.codeBlock(codeLine)}`);
			}
		}
		lines.push(this.#theme.codeBlockBorder("```"));
	}

	render(width: number): string[] {
		return this.#render(width, false).lines;
	}

	#render(width: number, includeAnchors: boolean): { lines: string[]; spans?: Array<ViewportAnchorSpan | null> } {
		// L1: per-instance cache — fastest path for repeated renders of the same
		// instance at the same width (e.g. resize debounce, repeated redraws).
		if (
			this.#cachedLines &&
			this.#cachedText === this.#text &&
			this.#cachedWidth === width &&
			(!includeAnchors || this.#cachedAnchorSpans !== undefined)
		) {
			return { lines: this.#cachedLines, spans: this.#cachedAnchorSpans };
		}

		// Calculate available width for content (subtract horizontal padding)
		const contentWidth = Math.max(1, width - this.#paddingX * 2);

		if (
			this.#streaming &&
			this.#cachedLines &&
			this.#cachedWidth === width &&
			this.#lastFullParseAt > 0 &&
			(!includeAnchors || this.#cachedAnchorSpans !== undefined)
		) {
			const elapsedMs = markdownNow() - this.#lastFullParseAt;
			if (elapsedMs < MARKDOWN_STREAM_THROTTLE_MS) {
				this.#armStaleThrottleTimer(MARKDOWN_STREAM_THROTTLE_MS - elapsedMs);
				return { lines: this.#cachedLines, spans: this.#cachedAnchorSpans };
			}
		}

		// Don't render anything if there's no actual text
		if (!this.#text || this.#text.trim() === "") {
			const result: string[] = [];
			// Update per-instance cache
			this.#cachedText = this.#text;
			this.#cachedWidth = width;
			this.#cachedLines = result;
			this.#cachedAnchorSpans = includeAnchors ? [] : undefined;
			return { lines: result, spans: this.#cachedAnchorSpans };
		}

		// Replace tabs with 3 spaces for consistent rendering
		const normalizedText = replaceTabs(this.#text);
		this.#clearStaleThrottleTimer();
		const contentKey = markdownContentKey(normalizedText);

		// L2: module-level LRU — survives component disposal/recreation across
		// session-tree navigations. Key encodes every dimension that affects the
		// render output so different configurations never collide. The markdown
		// content dimension is a full-content hash; entries store the source text
		// and verify it on hit so hash collisions can never serve wrong output.
		const bgColorProbe = this.#defaultTextStyle?.bgColor ? this.#defaultTextStyle.bgColor("\x01") : "";
		const headingProbe = this.#theme.heading("");
		const cacheKey = `${contentKey}\x00${width}\x00${this.#paddingX}\x00${this.#paddingY}\x00${this.#codeBlockIndent}\x00${objectId(this.#theme)}\x00${this.#defaultTextStyle ? objectId(this.#defaultTextStyle) : -1}\x00${TERMINAL.imageProtocol ?? ""}\x00${TERMINAL.hyperlinks ? 1 : 0}\x00${bgColorProbe}\x00${headingProbe}`;
		const cached = renderCache.get(cacheKey);
		if (
			cached !== undefined &&
			cached.source === normalizedText &&
			(!includeAnchors || cached.anchorSpans !== undefined)
		) {
			// Populate L1 so subsequent calls from this instance are O(1) map lookup.
			this.#cachedText = this.#text;
			this.#cachedWidth = width;
			this.#cachedLines = cached.lines;
			this.#cachedAnchorSpans = cached.anchorSpans;
			return { lines: cached.lines, spans: cached.anchorSpans };
		}

		// Parse markdown to marked tokens. Parse cache is width/theme independent,
		// so the same content can be reused across resize/layout renders even when
		// final wrapped output must differ by width.
		const cachedParse = parseCache.get(contentKey);
		let tokens: Token[];
		if (cachedParse !== undefined && cachedParse.source === normalizedText) {
			tokens = cachedParse.tokens;
		} else {
			__markdownPerfCounters.lexerInvocations += 1;
			__markdownPerfCounters.lexedBytes += normalizedText.length;
			tokens = markdownParser.lexer(normalizedText);
			parseCache.set(contentKey, { source: normalizedText, tokens });
		}

		// Convert tokens to styled terminal output. When anchoring, record each
		// top-level token's rendered-line range plus a width-invariant source-text
		// span (cumulative marked-token `raw` lengths) so viewport anchors are
		// numbered over stable source identities instead of the rendered glyph
		// stream (#2031).
		const renderedLines: string[] = [];
		const tokenBoundaries: Array<{ start: number; end: number; srcLo: number; srcHi: number; units: number[] }> = [];
		let srcOffset = 0;

		for (let i = 0; i < tokens.length; i++) {
			const token = tokens[i];
			const nextToken = tokens[i + 1];
			const tokenStart = renderedLines.length;
			const units: number[] | undefined = includeAnchors ? [] : undefined;
			const tokenLines = this.#renderToken(token, contentWidth, nextToken?.type, undefined, units);
			renderedLines.push(...tokenLines);
			if (includeAnchors) {
				const rawLength = "raw" in token && typeof token.raw === "string" ? token.raw.length : 0;
				const srcLo = srcOffset;
				srcOffset += Math.max(1, rawLength);
				// units must align 1:1 with the token's rendered lines; if a renderer
				// path emitted none, treat the whole token as a single unit.
				const lineUnits =
					units && units.length === tokenLines.length ? units : new Array<number>(tokenLines.length).fill(0);
				tokenBoundaries.push({
					start: tokenStart,
					end: renderedLines.length,
					srcLo,
					srcHi: srcOffset,
					units: lineUnits,
				});
			}
		}

		let wrappedLines: string[];
		let wrappedSpans: Array<ViewportAnchorSpan | null> | undefined;
		if (includeAnchors) {
			wrappedLines = [];
			const spans: Array<ViewportAnchorSpan | null> = [];
			for (const boundary of tokenBoundaries) {
				// Number this token's width-invariant source-text band [lo, hi) over its
				// source units — width-invariant structural spans (a list item, a table
				// row, a blockquote child block; a simple token is one unit) — rather than
				// over the width-dependent count of final content rows. Each unit reserves
				// a fixed sub-band, so an earlier unit's rows no longer move when a *later*
				// unit of the same top-level token rewraps into more rows. That
				// within-token drift was the P2 the first #2031 pass reintroduced: a
				// page-down anchor pinned to list item 1 (or a table header) slid into item
				// 2 (or a data row) once the later unit rewrapped, because every unit shared
				// one content-row count the later unit inflated.
				const lo = boundary.srcLo * ANCHOR_SOURCE_SCALE;
				const hi = boundary.srcHi * ANCHOR_SOURCE_SCALE;
				const lineCount = boundary.end - boundary.start;
				// Wrap the token's rendered lines exactly as the plain path does (so the
				// emitted `lines` stay byte-identical to render()), recording each wrapped
				// row's source unit and its position in `wrappedLines`.
				const firstWrapped = wrappedLines.length;
				const rowUnit: number[] = [];
				let unitCount = 1;
				for (let li = 0; li < lineCount; li++) {
					const renderedLine = renderedLines[boundary.start + li];
					const unit = boundary.units[li];
					if (unit + 1 > unitCount) unitCount = unit + 1;
					const lineWrapped = TERMINAL.isImageLine(renderedLine)
						? [renderedLine]
						: wrapTextIfNeeded(renderedLine, contentWidth);
					for (const w of lineWrapped) {
						wrappedLines.push(w);
						spans.push(null);
						rowUnit.push(unit);
					}
				}
				// Blank, decoration-only whitespace, and image rows carry no anchor.
				const contentRowsByUnit: number[][] = Array.from({ length: unitCount }, () => []);
				for (let j = 0; j < rowUnit.length; j++) {
					const globalIdx = firstWrapped + j;
					const line = wrappedLines[globalIdx];
					if (!TERMINAL.isImageLine(line) && Bun.stripANSI(line).trim().length > 0) {
						contentRowsByUnit[rowUnit[j]].push(globalIdx);
					}
				}
				for (let u = 0; u < unitCount; u++) {
					const unitLo = lo + Math.floor((u * (hi - lo)) / unitCount);
					const unitHi = u === unitCount - 1 ? hi : lo + Math.floor(((u + 1) * (hi - lo)) / unitCount);
					const rows = contentRowsByUnit[u];
					const count = rows.length;
					for (let c = 0; c < count; c++) {
						const start = unitLo + Math.floor((c * (unitHi - unitLo)) / count);
						const end = c === count - 1 ? unitHi : unitLo + Math.floor(((c + 1) * (unitHi - unitLo)) / count);
						spans[rows[c]] = { graphemeStart: start, graphemeEnd: end, cellStart: start, cellEnd: end };
					}
				}
			}
			wrappedSpans = spans;
		} else {
			wrappedLines = [];
			for (const line of renderedLines) {
				if (TERMINAL.isImageLine(line)) wrappedLines.push(line);
				else wrappedLines.push(...wrapTextIfNeeded(line, contentWidth));
			}
		}

		// Add margins and background to each wrapped line
		const leftMargin = padding(this.#paddingX);
		const rightMargin = padding(this.#paddingX);
		const bgFn = this.#defaultTextStyle?.bgColor;
		const contentLines: string[] = [];

		for (const line of wrappedLines) {
			// Image lines must be output raw - no margins or background
			if (TERMINAL.isImageLine(line)) {
				contentLines.push(line);
				continue;
			}

			const lineWithMargins = leftMargin + line + rightMargin;

			if (bgFn) {
				contentLines.push(applyBackgroundToLine(lineWithMargins, width, bgFn));
			} else {
				// No background - just pad to width
				const visibleLen = visibleWidth(lineWithMargins);
				const paddingNeeded = Math.max(0, width - visibleLen);
				contentLines.push(lineWithMargins + padding(paddingNeeded));
			}
		}

		// Add top/bottom padding (empty lines)
		const emptyLine = padding(width);
		const emptyLines: string[] = [];
		for (let i = 0; i < this.#paddingY; i++) {
			const line = bgFn ? applyBackgroundToLine(emptyLine, width, bgFn) : emptyLine;
			emptyLines.push(line);
		}

		const rawResult = [...emptyLines, ...contentLines, ...emptyLines];
		const rawAnchorSpans = wrappedSpans && [
			...emptyLines.map(() => null),
			...wrappedSpans,
			...emptyLines.map(() => null),
		];
		const result = rawResult.length > 0 ? rawResult : [""];
		const anchorSpans = rawResult.length > 0 ? rawAnchorSpans : wrappedSpans ? [null] : undefined;

		// Update L1 per-instance cache
		this.#cachedText = this.#text;
		this.#cachedWidth = width;
		this.#cachedLines = result;
		this.#cachedAnchorSpans = anchorSpans;
		this.#lastFullParseAt = markdownNow();

		// Update L2 module-level LRU so future instances with the same key skip
		// the marked.lexer + highlightCode (Rust FFI) work entirely.
		renderCache.set(cacheKey, { source: normalizedText, lines: result, ...(anchorSpans ? { anchorSpans } : {}) });

		return { lines: result, spans: anchorSpans };
	}

	renderWithViewportAnchorSource(
		width: number,
		source: { id: string },
	): {
		lines: string[];
		anchors: Array<({ id: string } & ViewportAnchorSpan) | null>;
	} {
		const { lines, spans } = this.#render(width, true);
		if (!spans) throw new Error("Viewport anchor source render completed without row spans");
		return {
			lines,
			anchors: spans.map(span => (span ? { id: source.id, ...span } : null)),
		};
	}

	/**
	 * Apply default text style to a string.
	 * This is the base styling applied to all text content.
	 * NOTE: Background color is NOT applied here - it's applied at the padding stage
	 * to ensure it extends to the full line width.
	 */
	#applyDefaultStyle(text: string): string {
		if (!this.#defaultTextStyle) {
			return text;
		}

		let styled = text;

		// Apply foreground color (NOT background - that's applied at padding stage)
		if (this.#defaultTextStyle.color) {
			styled = this.#defaultTextStyle.color(styled);
		}

		// Apply text decorations using this.#theme
		if (this.#defaultTextStyle.bold) {
			styled = this.#theme.bold(styled);
		}
		if (this.#defaultTextStyle.italic) {
			styled = this.#theme.italic(styled);
		}
		if (this.#defaultTextStyle.strikethrough) {
			styled = this.#theme.strikethrough(styled);
		}
		if (this.#defaultTextStyle.underline) {
			styled = this.#theme.underline(styled);
		}

		return styled;
	}

	#getDefaultStylePrefix(): string {
		if (!this.#defaultTextStyle) {
			return "";
		}

		if (this.#defaultStylePrefix !== undefined) {
			return this.#defaultStylePrefix;
		}

		const sentinel = "\u0000";
		let styled = sentinel;

		if (this.#defaultTextStyle.color) {
			styled = this.#defaultTextStyle.color(styled);
		}

		if (this.#defaultTextStyle.bold) {
			styled = this.#theme.bold(styled);
		}
		if (this.#defaultTextStyle.italic) {
			styled = this.#theme.italic(styled);
		}
		if (this.#defaultTextStyle.strikethrough) {
			styled = this.#theme.strikethrough(styled);
		}
		if (this.#defaultTextStyle.underline) {
			styled = this.#theme.underline(styled);
		}

		const sentinelIndex = styled.indexOf(sentinel);
		this.#defaultStylePrefix = sentinelIndex >= 0 ? styled.slice(0, sentinelIndex) : "";
		return this.#defaultStylePrefix;
	}

	#getStylePrefix(styleFn: (text: string) => string): string {
		const sentinel = "\u0000";
		const styled = styleFn(sentinel);
		const sentinelIndex = styled.indexOf(sentinel);
		return sentinelIndex >= 0 ? styled.slice(0, sentinelIndex) : "";
	}

	#getDefaultInlineStyleContext(): InlineStyleContext {
		return {
			applyText: (text: string) => this.#applyDefaultStyle(text),
			stylePrefix: this.#getDefaultStylePrefix(),
		};
	}

	#renderToken(
		token: Token,
		width: number,
		nextTokenType?: string,
		styleContext?: InlineStyleContext,
		units?: number[],
	): string[] {
		const lines: string[] = [];

		switch (token.type) {
			case "heading": {
				const headingLevel = token.depth;
				const headingPrefix = `${"#".repeat(headingLevel)} `;
				const headingText = this.#renderInlineTokens(token.tokens || [], styleContext);
				let styledHeading: string;
				if (headingLevel === 1) {
					styledHeading = this.#theme.heading(this.#theme.bold(this.#theme.underline(headingText)));
				} else if (headingLevel === 2) {
					styledHeading = this.#theme.heading(this.#theme.bold(headingText));
				} else {
					styledHeading = this.#theme.heading(this.#theme.bold(headingPrefix + headingText));
				}
				lines.push(styledHeading);
				if (nextTokenType && nextTokenType !== "space") {
					lines.push(""); // Add spacing after headings (unless space token follows)
				}
				break;
			}

			case "paragraph": {
				const paragraphText = this.#renderInlineTokens(token.tokens || [], styleContext);
				lines.push(paragraphText);
				// Don't add spacing if next token is space or list
				if (nextTokenType && nextTokenType !== "list" && nextTokenType !== "space") {
					lines.push("");
				}
				break;
			}

			case "code": {
				// Handle mermaid diagrams with ASCII rendering when available
				if (token.lang === "mermaid" && this.#theme.resolveMermaidAscii) {
					const ascii = this.#theme.resolveMermaidAscii(token.text);

					if (ascii) {
						for (const asciiLine of Bun.stripANSI(ascii).split("\n")) {
							lines.push(asciiLine);
						}
						if (nextTokenType && nextTokenType !== "space") {
							lines.push("");
						}
						break;
					}
				}

				const codeIndent = padding(this.#codeBlockIndent);
				this.#emitCodeBlock(lines, token.text, token.lang || "", codeIndent);
				if (nextTokenType && nextTokenType !== "space") {
					lines.push(""); // Add spacing after code blocks (unless space token follows)
				}
				break;
			}

			case "list": {
				const listLines = this.#renderList(token as ListToken, 0, styleContext, units);
				lines.push(...listLines);
				// Don't add spacing after lists if a space token follows
				// (the space token will handle it)
				break;
			}

			case "table": {
				const tableLines = this.#renderTable(token as TableToken, width, nextTokenType, styleContext, units);
				lines.push(...tableLines);
				break;
			}

			case "blockquote": {
				const quoteStyle = (text: string) => this.#theme.quote(this.#theme.italic(text));
				const quoteStylePrefix = this.#getStylePrefix(quoteStyle);
				const applyQuoteStyle = (line: string): string => {
					if (!quoteStylePrefix) {
						return quoteStyle(line);
					}

					const lineWithReappliedStyle = line.replace(/\x1b\[0m/g, `\x1b[0m${quoteStylePrefix}`);
					return quoteStyle(lineWithReappliedStyle);
				};

				// Blockquotes contain block-level tokens (paragraph, list, code, etc.), so render
				// children recursively and keep default message styling out of nested content.
				const quoteInlineStyleContext: InlineStyleContext = {
					applyText: (text: string) => text,
					stylePrefix: "",
				};
				const quoteContentWidth = Math.max(1, width - 2);
				const quoteTokens = token.tokens || [];
				const renderedQuoteLines: string[] = [];
				// Track which source child block produced each rendered quote line so the
				// anchor band can be numbered over width-invariant child units rather than
				// the width-dependent count of wrapped quote lines.
				const quoteLineUnit: number[] = [];

				for (let i = 0; i < quoteTokens.length; i++) {
					const quoteToken = quoteTokens[i];
					const nextQuoteToken = quoteTokens[i + 1];
					const childLines = this.#renderToken(
						quoteToken,
						quoteContentWidth,
						nextQuoteToken?.type,
						quoteInlineStyleContext,
					);
					for (let c = 0; c < childLines.length; c++) quoteLineUnit.push(i);
					renderedQuoteLines.push(...childLines);
				}

				while (renderedQuoteLines.length > 0 && renderedQuoteLines[renderedQuoteLines.length - 1] === "") {
					renderedQuoteLines.pop();
					quoteLineUnit.pop();
				}

				for (let q = 0; q < renderedQuoteLines.length; q++) {
					const styledLine = applyQuoteStyle(renderedQuoteLines[q]);
					const wrappedLines = wrapTextIfNeeded(styledLine, quoteContentWidth);
					for (const wrappedLine of wrappedLines) {
						lines.push(this.#theme.quoteBorder(`${this.#theme.symbols.quoteBorder} `) + wrappedLine);
						units?.push(quoteLineUnit[q]);
					}
				}
				if (nextTokenType && nextTokenType !== "space") {
					lines.push(""); // Add spacing after blockquotes (unless space token follows)
					units?.push(quoteTokens.length > 0 ? quoteTokens.length - 1 : 0);
				}
				break;
			}

			case "hr":
				lines.push(this.#theme.hr(this.#theme.symbols.hrChar.repeat(Math.min(width, 80))));
				if (nextTokenType && nextTokenType !== "space") {
					lines.push(""); // Add spacing after horizontal rules (unless space token follows)
				}
				break;

			case "html": {
				// HTML comments are invisible markup (React/SSR text separators often emit "<!-- -->").
				// Keep other HTML-like model text visible as plain terminal text.
				const visibleHtml = "raw" in token && typeof token.raw === "string" ? stripHtmlComments(token.raw) : "";
				if (visibleHtml.trim().length > 0) {
					lines.push(this.#applyDefaultStyle(visibleHtml.trim()));
				}
				break;
			}

			case "space":
				// Space tokens represent blank lines in markdown
				lines.push("");
				break;

			default:
				// Handle any other token types as plain text
				if ("text" in token && typeof token.text === "string") {
					lines.push(token.text);
				}
		}

		// Anchor units: lines a token emitted without an explicit unit (simple
		// single-unit tokens, trailing spacing) inherit the last unit, default 0.
		if (units) while (units.length < lines.length) units.push(units.length ? units[units.length - 1] : 0);
		return lines;
	}

	#renderInlineTokens(tokens: Token[], styleContext?: InlineStyleContext): string {
		let result = "";
		const resolvedStyleContext = styleContext ?? this.#getDefaultInlineStyleContext();
		const { applyText, stylePrefix } = resolvedStyleContext;
		const applyTextWithNewlines = (text: string): string => {
			const segments: string[] = text.split("\n");
			return segments.map((segment: string) => applyText(segment)).join("\n");
		};

		for (const token of tokens) {
			switch (token.type) {
				case "text":
					// Text tokens in list items can have nested tokens for inline formatting
					if (token.tokens && token.tokens.length > 0) {
						result += this.#renderInlineTokens(token.tokens, resolvedStyleContext);
					} else {
						result += applyTextWithNewlines(token.text);
					}
					break;

				case "paragraph":
					// Paragraph tokens contain nested inline tokens
					result += this.#renderInlineTokens(token.tokens || [], resolvedStyleContext);
					break;

				case "strong": {
					const boldContent = this.#renderInlineTokens(token.tokens || [], resolvedStyleContext);
					result += this.#theme.bold(boldContent) + stylePrefix;
					break;
				}

				case "em": {
					const italicContent = this.#renderInlineTokens(token.tokens || [], resolvedStyleContext);
					result += this.#theme.italic(italicContent) + stylePrefix;
					break;
				}

				case "codespan":
					result += this.#theme.code(token.text) + stylePrefix;
					break;

				case "link": {
					const linkText = this.#renderInlineTokens(token.tokens || [], resolvedStyleContext);
					const styledLinkText = this.#theme.link(this.#theme.underline(linkText));
					const clickableLinkText = formatHyperlink(styledLinkText, token.href);
					// If link text matches href, only show the link once
					// Compare raw text (token.text) not styled text (linkText) since linkText has ANSI codes
					// For mailto: links, strip the prefix before comparing (autolinked emails have
					// text="foo@bar.com" but href="mailto:foo@bar.com")
					const hrefForComparison = token.href.startsWith("mailto:") ? token.href.slice(7) : token.href;
					if (token.text === token.href || token.text === hrefForComparison)
						result += clickableLinkText + stylePrefix;
					else {
						const styledLinkUrl = this.#theme.linkUrl(` (${token.href})`);
						result += clickableLinkText + formatHyperlink(styledLinkUrl, token.href) + stylePrefix;
					}
					break;
				}

				case "br":
					result += "\n";
					break;

				case "del": {
					const delContent = this.#renderInlineTokens(token.tokens || [], resolvedStyleContext);
					result += this.#theme.strikethrough(delContent) + stylePrefix;
					break;
				}

				case "html": {
					// HTML comments are markup-only separators; keep other inline HTML visible as text.
					const visibleHtml = "raw" in token && typeof token.raw === "string" ? stripHtmlComments(token.raw) : "";
					if (visibleHtml.trim().length > 0) {
						result += applyTextWithNewlines(visibleHtml);
					}
					break;
				}

				default:
					// Handle any other inline token types as plain text
					if ("text" in token && typeof token.text === "string") {
						result += applyTextWithNewlines(token.text);
					}
			}
		}

		// Strip dangling re-opened-default SGR prefix left over from the last inline
		// token (strong/em/codespan/link/del/etc.) so the emitted line self-terminates
		// at its last styled segment instead of carrying an unmatched SGR open into
		// the next line. Matches upstream behavior.
		while (stylePrefix && result.endsWith(stylePrefix)) {
			result = result.slice(0, -stylePrefix.length);
		}

		return result;
	}

	/**
	 * Render a list with proper nesting support
	 */
	#renderList(token: ListToken, depth: number, styleContext?: InlineStyleContext, units?: number[]): string[] {
		const lines: string[] = [];
		const indent = "  ".repeat(depth);
		// Use the list's start property (defaults to 1 for ordered lists)
		const startNumber = token.start ?? 1;

		for (let i = 0; i < token.items.length; i++) {
			const item = token.items[i];
			const bullet = token.ordered ? `${startNumber + i}. ` : "- ";

			// Process item tokens to handle nested lists
			const itemLines = this.#renderListItem(item.tokens || [], depth, styleContext);

			if (itemLines.length > 0) {
				// First line - check if it's a nested list
				// A nested list will start with indent (spaces) followed by cyan bullet
				const firstLine = itemLines[0];
				const isNestedList = /^\s+\x1b\[36m[-\d]/.test(firstLine); // starts with spaces + cyan + bullet char

				if (isNestedList) {
					// This is a nested list, just add it as-is (already has full indent)
					lines.push(firstLine);
				} else {
					// Regular text content - add indent and bullet
					lines.push(indent + this.#theme.listBullet(bullet) + firstLine);
				}

				// Rest of the lines
				for (let j = 1; j < itemLines.length; j++) {
					const line = itemLines[j];
					const isNestedListLine = /^\s+\x1b\[36m[-\d]/.test(line); // starts with spaces + cyan + bullet char

					if (isNestedListLine) {
						// Nested list line - already has full indent
						lines.push(line);
					} else {
						// Regular content - add parent indent + 2 spaces for continuation
						lines.push(`${indent}  ${line}`);
					}
				}
			} else {
				lines.push(indent + this.#theme.listBullet(bullet));
			}
			// Anchor units: every rendered line of this top-level item (including any
			// nested list lines) belongs to one width-invariant unit — the item index.
			if (units) while (units.length < lines.length) units.push(i);
		}

		return lines;
	}

	/**
	 * Render list item tokens, handling nested lists
	 * Returns lines WITHOUT the parent indent (renderList will add it)
	 */
	#renderListItem(tokens: Token[], parentDepth: number, styleContext?: InlineStyleContext): string[] {
		const lines: string[] = [];

		for (const token of tokens) {
			if (token.type === "list") {
				// Nested list - render with one additional indent level
				// These lines will have their own indent, so we just add them as-is
				const nestedLines = this.#renderList(token as ListToken, parentDepth + 1, styleContext);
				lines.push(...nestedLines);
			} else if (token.type === "text") {
				// Text content (may have inline tokens)
				const text =
					token.tokens && token.tokens.length > 0
						? this.#renderInlineTokens(token.tokens, styleContext)
						: token.text || "";
				lines.push(text);
			} else if (token.type === "paragraph") {
				// Paragraph in list item
				const text = this.#renderInlineTokens(token.tokens || [], styleContext);
				lines.push(text);
			} else if (token.type === "code") {
				// Code block in list item
				const codeIndent = padding(this.#codeBlockIndent);
				this.#emitCodeBlock(lines, token.text, token.lang || "", codeIndent);
			} else {
				// Other token types - try to render as inline
				const text = this.#renderInlineTokens([token], styleContext);
				if (text) {
					lines.push(text);
				}
			}
		}

		return lines;
	}

	/**
	 * Get the visible width of the longest word in a string.
	 */
	#getLongestWordWidth(text: string, maxWidth?: number): number {
		const words = text.split(/\s+/).filter(word => word.length > 0);
		let longest = 0;
		for (const word of words) {
			longest = Math.max(longest, visibleWidth(word));
		}
		if (maxWidth === undefined) {
			return longest;
		}
		return Math.min(longest, maxWidth);
	}

	/**
	 * Wrap a table cell to fit into a column.
	 *
	 * Delegates to wrapTextWithAnsi() so ANSI codes + long tokens are handled
	 * consistently with the rest of the renderer.
	 */
	#wrapCellText(text: string, maxWidth: number): string[] {
		return wrapTextIfNeeded(text, Math.max(1, maxWidth));
	}

	/**
	 * Render a table with width-aware cell wrapping.
	 * Cells that don't fit are wrapped to multiple lines.
	 */
	#renderTable(
		token: TableToken,
		availableWidth: number,
		nextTokenType?: string,
		styleContext?: InlineStyleContext,
		units?: number[],
	): string[] {
		const lines: string[] = [];
		const numCols = token.header.length;

		if (numCols === 0) {
			return lines;
		}

		// Calculate border overhead: "│ " + (n-1) * " │ " + " │"
		// = 2 + (n-1) * 3 + 2 = 3n + 1
		const borderOverhead = 3 * numCols + 1;
		const availableForCells = availableWidth - borderOverhead;
		if (availableForCells < numCols) {
			// Too narrow to render a stable table. Fall back to raw markdown.
			const fallbackLines = token.raw ? wrapTextWithAnsi(token.raw, availableWidth) : [];
			if (nextTokenType && nextTokenType !== "space") {
				fallbackLines.push("");
			}
			return fallbackLines;
		}

		const maxUnbrokenWordWidth = 30;

		// Calculate natural column widths (what each column needs without constraints)
		const naturalWidths: number[] = [];
		const minWordWidths: number[] = [];
		for (let i = 0; i < numCols; i++) {
			const headerText = this.#renderInlineTokens(token.header[i].tokens || [], styleContext);
			naturalWidths[i] = visibleWidth(headerText);
			minWordWidths[i] = Math.max(1, this.#getLongestWordWidth(headerText, maxUnbrokenWordWidth));
		}
		for (const row of token.rows) {
			for (let i = 0; i < row.length; i++) {
				const cellText = this.#renderInlineTokens(row[i].tokens || [], styleContext);
				naturalWidths[i] = Math.max(naturalWidths[i] || 0, visibleWidth(cellText));
				minWordWidths[i] = Math.max(
					minWordWidths[i] || 1,
					this.#getLongestWordWidth(cellText, maxUnbrokenWordWidth),
				);
			}
		}

		let minColumnWidths = minWordWidths;
		let minCellsWidth = minColumnWidths.reduce((a, b) => a + b, 0);

		if (minCellsWidth > availableForCells) {
			minColumnWidths = new Array(numCols).fill(1);
			const remaining = availableForCells - numCols;

			if (remaining > 0) {
				const totalWeight = minWordWidths.reduce((total, width) => total + Math.max(0, width - 1), 0);
				const growth = minWordWidths.map(width => {
					const weight = Math.max(0, width - 1);
					return totalWeight > 0 ? Math.floor((weight / totalWeight) * remaining) : 0;
				});

				for (let i = 0; i < numCols; i++) {
					minColumnWidths[i] += growth[i] ?? 0;
				}

				const allocated = growth.reduce((total, width) => total + width, 0);
				let leftover = remaining - allocated;
				for (let i = 0; leftover > 0 && i < numCols; i++) {
					minColumnWidths[i]++;
					leftover--;
				}
			}

			minCellsWidth = minColumnWidths.reduce((a, b) => a + b, 0);
		}

		// Calculate column widths that fit within available width
		const totalNaturalWidth = naturalWidths.reduce((a, b) => a + b, 0) + borderOverhead;
		let columnWidths: number[];

		if (totalNaturalWidth <= availableWidth) {
			// Everything fits naturally
			columnWidths = naturalWidths.map((width, index) => Math.max(width, minColumnWidths[index]));
		} else {
			// Need to shrink columns to fit
			const totalGrowPotential = naturalWidths.reduce((total, width, index) => {
				return total + Math.max(0, width - minColumnWidths[index]);
			}, 0);
			const extraWidth = Math.max(0, availableForCells - minCellsWidth);
			columnWidths = minColumnWidths.map((minWidth, index) => {
				const naturalWidth = naturalWidths[index];
				const minWidthDelta = Math.max(0, naturalWidth - minWidth);
				let grow = 0;
				if (totalGrowPotential > 0) {
					grow = Math.floor((minWidthDelta / totalGrowPotential) * extraWidth);
				}
				return minWidth + grow;
			});

			// Adjust for rounding errors - distribute remaining space
			const allocated = columnWidths.reduce((a, b) => a + b, 0);
			let remaining = availableForCells - allocated;
			while (remaining > 0) {
				let grew = false;
				for (let i = 0; i < numCols && remaining > 0; i++) {
					if (columnWidths[i] < naturalWidths[i]) {
						columnWidths[i]++;
						remaining--;
						grew = true;
					}
				}
				if (!grew) {
					break;
				}
			}
		}

		const t = this.#theme.symbols.table;
		const h = t.horizontal;
		const v = t.vertical;

		// Render top border
		const topBorderCells = columnWidths.map(w => h.repeat(w));
		lines.push(`${t.topLeft}${h}${topBorderCells.join(`${h}${t.teeDown}${h}`)}${h}${t.topRight}`);

		// Render header with wrapping
		const headerCellLines: string[][] = token.header.map((cell, i) => {
			const text = this.#renderInlineTokens(cell.tokens || [], styleContext);
			return this.#wrapCellText(text, columnWidths[i]);
		});
		const headerLineCount = Math.max(...headerCellLines.map(c => c.length));

		for (let lineIdx = 0; lineIdx < headerLineCount; lineIdx++) {
			const rowParts = headerCellLines.map((cellLines, colIdx) => {
				const text = cellLines[lineIdx] || "";
				const padded = text + padding(Math.max(0, columnWidths[colIdx] - visibleWidth(text)));
				return this.#theme.bold(padded);
			});
			lines.push(`${v} ${rowParts.join(` ${v} `)} ${v}`);
		}

		// Render separator
		const separatorCells = columnWidths.map(w => h.repeat(w));
		const separatorLine = `${t.teeRight}${h}${separatorCells.join(`${h}${t.cross}${h}`)}${h}${t.teeLeft}`;
		lines.push(separatorLine);
		// Anchor units: the whole header block (top border + header rows + separator)
		// is unit 0; each source data row is its own width-invariant unit below.
		if (units) while (units.length < lines.length) units.push(0);

		// Render rows with wrapping
		for (let rowIndex = 0; rowIndex < token.rows.length; rowIndex++) {
			const row = token.rows[rowIndex];
			const rowCellLines: string[][] = row.map((cell, i) => {
				const text = this.#renderInlineTokens(cell.tokens || [], styleContext);
				return this.#wrapCellText(text, columnWidths[i]);
			});
			const rowLineCount = Math.max(...rowCellLines.map(c => c.length));

			for (let lineIdx = 0; lineIdx < rowLineCount; lineIdx++) {
				const rowParts = rowCellLines.map((cellLines, colIdx) => {
					const text = cellLines[lineIdx] || "";
					return text + padding(Math.max(0, columnWidths[colIdx] - visibleWidth(text)));
				});
				lines.push(`${v} ${rowParts.join(` ${v} `)} ${v}`);
			}

			if (rowIndex < token.rows.length - 1) {
				lines.push(separatorLine);
			}
			if (units) while (units.length < lines.length) units.push(rowIndex + 1);
		}

		// Render bottom border
		const bottomBorderCells = columnWidths.map(w => h.repeat(w));
		lines.push(`${t.bottomLeft}${h}${bottomBorderCells.join(`${h}${t.teeUp}${h}`)}${h}${t.bottomRight}`);

		if (nextTokenType && nextTokenType !== "space") {
			lines.push(""); // Add spacing after table
		}
		if (units) while (units.length < lines.length) units.push(token.rows.length);
		return lines;
	}
}

/**
 * Render inline markdown (bold, italic, code, links, strikethrough) to a styled string.
 * Unlike the full Markdown component, this produces a single line with no block-level elements.
 */
export function renderInlineMarkdown(text: string, mdTheme: MarkdownTheme, baseColor?: (t: string) => string): string {
	// Guard against undefined/null during streaming — partial JSON can leave fields unpopulated.
	if (typeof text !== "string") return (baseColor ?? (t => t))(text != null ? String(text) : "");
	const tokens = marked.lexer(text);
	const applyText = baseColor ?? ((t: string) => t);
	let result = "";
	for (const token of tokens) {
		if (token.type === "paragraph" && token.tokens) {
			result += renderInlineTokens(token.tokens, mdTheme, applyText);
		} else if (token.type === "list") {
			result += token.items
				.map((item: Tokens.ListItem, index: number) => {
					const prefix = token.ordered ? `${(token.start || 1) + index}. ` : "• ";
					const content = item.tokens ? renderInlineTokens(item.tokens, mdTheme, applyText) : applyText(item.text);
					return `${applyText(prefix)}${content}`;
				})
				.join(applyText(" "));
		} else if (token.type === "html" && "raw" in token && typeof token.raw === "string") {
			const visibleHtml = stripHtmlComments(token.raw);
			if (visibleHtml.trim().length > 0) {
				result += applyText(visibleHtml);
			}
		} else if ("text" in token && typeof token.text === "string") {
			result += applyText(token.text);
		}
	}
	return result;
}

function renderInlineTokens(tokens: Token[], mdTheme: MarkdownTheme, applyText: (t: string) => string): string {
	let result = "";
	const styleReset = applyText("");
	for (const token of tokens) {
		switch (token.type) {
			case "text":
				if (token.tokens && token.tokens.length > 0) {
					result += renderInlineTokens(token.tokens, mdTheme, applyText);
				} else {
					result += applyText(token.text);
				}
				break;
			case "strong":
				result += mdTheme.bold(renderInlineTokens(token.tokens || [], mdTheme, applyText)) + styleReset;
				break;
			case "em":
				result += mdTheme.italic(renderInlineTokens(token.tokens || [], mdTheme, applyText)) + styleReset;
				break;
			case "codespan":
				result += mdTheme.code(token.text) + styleReset;
				break;
			case "del":
				result += mdTheme.strikethrough(renderInlineTokens(token.tokens || [], mdTheme, applyText)) + styleReset;
				break;
			case "link": {
				const linkText = renderInlineTokens(token.tokens || [], mdTheme, applyText);
				result += mdTheme.link(mdTheme.underline(linkText)) + styleReset;
				break;
			}
			case "html": {
				const visibleHtml = "raw" in token && typeof token.raw === "string" ? stripHtmlComments(token.raw) : "";
				if (visibleHtml.trim().length > 0) {
					result += applyText(visibleHtml);
				}
				break;
			}
			default:
				if ("text" in token && typeof token.text === "string") {
					result += applyText(token.text);
				}
				break;
		}
	}
	return result;
}
