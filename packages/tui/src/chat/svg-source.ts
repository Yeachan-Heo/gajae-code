/**
 * Source-level handling of ```svg fences in assistant Markdown: splitting
 * prose around them ({@link splitSvgFences}), turning a fence that is still
 * streaming into a document an SVG parser accepts ({@link closePartialSvg}),
 * and resolving the theme tokens figures color themselves with
 * ({@link prepareSvg}).
 *
 * Source: oh-my-pi (https://github.com/can1357/oh-my-pi)
 */
import { Marked } from "marked";

/** One run of an assistant text block: prose, or the body of a ```svg fence. */
export type FigureSegment =
	| { readonly kind: "markdown"; readonly text: string }
	/** `closed` once the fence's closing line arrived. */
	| { readonly kind: "svg"; readonly source: string; readonly closed: boolean };

/** A top-level (≤3-space indent) fenced-code opener. */
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const SVG_TEXT = /svg/i;
const svgMarkdownParser = new Marked();

/** Whether `markdown` holds a ```svg fence {@link splitSvgFences} would lift. */
export function hasSvgFence(markdown: string): boolean {
	if (!SVG_TEXT.test(markdown)) return false;
	let fence: string | undefined;
	let lineStart = 0;
	while (lineStart <= markdown.length) {
		const newline = markdown.indexOf("\n", lineStart);
		const lineEnd = newline < 0 ? markdown.length : newline;
		const next = newline < 0 ? markdown.length + 1 : newline + 1;
		const line = markdown.slice(lineStart, lineEnd);
		if (fence) {
			if (closesFence(line, fence)) fence = undefined;
		} else {
			const open = FENCE_OPEN.exec(line);
			// A backtick fence's info string cannot hold backticks (CommonMark).
			if (open && !(open[1]![0] === "`" && open[2]!.includes("`"))) {
				if (isSvgFenceInfo(open[2]!)) {
					return svgMarkdownParser
						.lexer(markdown)
						.some(token => token.type === "code" && isSvgFenceInfo(token.lang));
				}
				fence = open[1]!;
			}
		}
		lineStart = next;
	}
	return false;
}

/**
 * Split `markdown` into prose and ```svg fence bodies, in order. Only
 * top-level fences lift; an svg fence nested in another fence, a list's
 * indented block or a blockquote stays prose. Blank prose runs are dropped.
 * An svg fence still open at the end is the last segment, `closed: false`.
 */
export function splitSvgFences(markdown: string): FigureSegment[] {
	const segments: FigureSegment[] = [];
	let proseStart = 0;
	for (const token of svgMarkdownParser.lexer(markdown)) {
		if (token.type !== "code" || !isSvgFenceInfo(token.lang)) continue;
		const start = markdown.indexOf(token.raw, proseStart);
		if (start < 0) continue;
		const end = start + token.raw.length;
		const prose = markdown.slice(proseStart, start);
		if (prose.trim()) segments.push({ kind: "markdown", text: prose });
		segments.push({ kind: "svg", ...splitFenceBody(token.raw) });
		proseStart = end;
	}
	const trailingProse = markdown.slice(proseStart);
	if (trailingProse.trim()) segments.push({ kind: "markdown", text: trailingProse });
	return segments;
}

/** Whether a Marked SVG code token's raw source contains its closing fence. */
export function isClosedSvgFence(raw: string): boolean {
	return splitFenceBody(raw).closed;
}

function isSvgFenceInfo(info: string | undefined): boolean {
	return info?.trim().split(/[ \t]/, 1)[0]?.toLowerCase() === "svg";
}

function splitFenceBody(raw: string): { source: string; closed: boolean } {
	const openerEnd = raw.indexOf("\n");
	const opener = raw.slice(0, openerEnd < 0 ? raw.length : openerEnd);
	const marker = FENCE_OPEN.exec(opener)?.[1];
	const bodyStart = openerEnd < 0 ? raw.length : openerEnd + 1;
	if (!marker) return { source: raw.slice(bodyStart), closed: false };
	let lineStart = bodyStart;
	while (lineStart <= raw.length) {
		const newline = raw.indexOf("\n", lineStart);
		const lineEnd = newline < 0 ? raw.length : newline;
		if (closesFence(raw.slice(lineStart, lineEnd), marker)) {
			return { source: raw.slice(bodyStart, lineStart), closed: true };
		}
		if (newline < 0) break;
		lineStart = newline + 1;
	}
	return { source: raw.slice(bodyStart), closed: false };
}

/** Whether `line` closes a fence opened by `marker`: same character, at least as long, nothing after. */
function closesFence(line: string, marker: string): boolean {
	let index = 0;
	while (index < 3 && line[index] === " ") index++;
	let run = 0;
	while (line[index + run] === marker[0]) run++;
	return run >= marker.length && line.slice(index + run).trim() === "";
}

/**
 * Turn a possibly truncated SVG source into a well-formed document: cut the
 * trailing construct still being written (a tag without its `>`, an
 * unterminated comment, CDATA section, processing instruction or declaration,
 * a dangling `&entity`) and close every element left open, innermost first.
 * A complete document passes through unchanged. Returns null until the root
 * `<svg …>` start tag is complete — before that there is nothing to draw.
 */
export function closePartialSvg(source: string): string | null {
	const open: string[] = [];
	let rootSeen = false;
	let end = 0;
	let index = 0;
	for (;;) {
		const lt = source.indexOf("<", index);
		if (lt < 0) {
			// Trailing text: an entity reference still being written would not parse.
			const amp = source.lastIndexOf("&");
			end = amp >= index && !source.includes(";", amp) ? amp : source.length;
			break;
		}
		end = lt;
		const close = constructEnd(source, lt);
		if (close < 0) break;
		if (source.startsWith("</", lt)) {
			const name = source.slice(lt + 2, close - 1).trim();
			const at = open.lastIndexOf(name);
			if (at >= 0) open.length = at;
		} else if (source[lt + 1] !== "!" && source[lt + 1] !== "?") {
			const name = /^<([^\s/>]+)/.exec(source.slice(lt, close))?.[1];
			if (name !== undefined) {
				if (source[close - 2] !== "/") open.push(name);
				if (!rootSeen && (name === "svg" || name.endsWith(":svg"))) rootSeen = true;
			}
		}
		index = close;
		end = close;
	}
	if (!rootSeen) return null;
	let document = source.slice(0, end);
	for (let at = open.length - 1; at >= 0; at--) document += `</${open[at]}>`;
	return document;
}

/** CSS `var()` references are parsed with balanced parentheses below. */
const CSS_VALUE_ATTRIBUTES = new Set([
	"alignment-baseline",
	"baseline-shift",
	"clip",
	"clip-path",
	"clip-rule",
	"color",
	"color-interpolation",
	"color-interpolation-filters",
	"color-rendering",
	"cursor",
	"direction",
	"display",
	"dominant-baseline",
	"fill",
	"fill-opacity",
	"fill-rule",
	"filter",
	"flood-color",
	"flood-opacity",
	"font-family",
	"font-size",
	"font-size-adjust",
	"font-stretch",
	"font-style",
	"font-variant",
	"font-weight",
	"glyph-orientation-horizontal",
	"glyph-orientation-vertical",
	"image-rendering",
	"letter-spacing",
	"lighting-color",
	"marker-end",
	"marker-mid",
	"marker-start",
	"mask",
	"opacity",
	"overflow",
	"paint-order",
	"pointer-events",
	"shape-rendering",
	"stop-color",
	"stop-opacity",
	"stroke",
	"stroke-dasharray",
	"stroke-dashoffset",
	"stroke-linecap",
	"stroke-linejoin",
	"stroke-miterlimit",
	"stroke-opacity",
	"stroke-width",
	"text-anchor",
	"text-decoration",
	"text-rendering",
	"unicode-bidi",
	"vector-effect",
	"visibility",
	"word-spacing",
	"writing-mode",
]);

/**
 * Make a figure's source what an SVG rasterizer draws as written, in the
 * reader's theme. Rasterizers resolve neither CSS custom properties nor an
 * inherited text color, and reject a root without the SVG namespace, so:
 * - reserved `--gjc-${name}` variables in `<style>` contents, `style`
 *   declarations, and presentation attributes become `palette[name]` (an
 *   unknown GJC token takes its fallback, else `palette.fg`); author-defined
 *   CSS custom properties stay intact, and nested fallbacks are resolved;
 *   SVG text and unrelated attributes stay literal;
 * - a root `<svg>` lacking them gets `color` = `palette.fg` (so
 *   `currentColor` follows the theme), a sans-serif `font-family` (instead
 *   of the rasterizer's Times), `xmlns`, and `xmlns:xlink` when the source
 *   uses `xlink:` attributes.
 */
export function prepareSvg(svg: string, palette: Readonly<Record<string, string>>): string {
	const fg = palette.fg ?? "currentColor";
	const resolved = resolveSvgCssVariables(svg, palette, fg);
	const usesXlink = resolved.includes("xlink:");
	const root = findRootSvgTag(resolved);
	if (!root) return resolved;
	let added = "";
	if (!hasSvgAttribute(root.tag, "color")) added += ` color="${fg}"`;
	if (!hasSvgAttribute(root.tag, "font-family")) added += ` font-family="sans-serif"`;
	if (!hasSvgAttribute(root.tag, "xmlns")) added += ` xmlns="http://www.w3.org/2000/svg"`;
	if (usesXlink && !hasSvgAttribute(root.tag, "xmlns:xlink")) {
		added += ` xmlns:xlink="http://www.w3.org/1999/xlink"`;
	}
	if (!added) return resolved;
	const tag = root.tag.replace(/^<[^\s/>]+/, `$&${added}`);
	return `${resolved.slice(0, root.start)}${tag}${resolved.slice(root.end)}`;
}

/** Resolve CSS variables only in stylesheet text and CSS-bearing XML attributes. */
function resolveSvgCssVariables(source: string, palette: Readonly<Record<string, string>>, fg: string): string {
	let output = "";
	let cursor = 0;
	while (cursor < source.length) {
		const start = source.indexOf("<", cursor);
		if (start < 0) return output + source.slice(cursor);
		output += source.slice(cursor, start);
		const end = constructEnd(source, start);
		if (end < 0) return output + source.slice(start);
		const tag = source.slice(start, end);
		const styleTagName = /^<((?:[\w.-]+:)?style)(?=[\s/>])/i.exec(tag)?.[1];
		if (styleTagName && !isSelfClosingSvgTag(tag)) {
			output += resolveCssAttributes(tag, palette, fg);
			const closingTag = findStyleClosingTag(source, end, styleTagName);
			if (closingTag < 0) return output + resolveCssValue(source.slice(end), palette, fg);
			output += resolveCssValue(source.slice(end, closingTag), palette, fg);
			cursor = closingTag;
			continue;
		}
		output += resolveCssAttributes(tag, palette, fg);
		cursor = end;
	}
	return output;
}

/** Whether a complete XML start tag is self-closing. */
function isSelfClosingSvgTag(tag: string): boolean {
	return /\/\s*>$/.test(tag);
}

/** Find the matching closing style tag; `<` cannot appear literally in XML style text. */
function findStyleClosingTag(source: string, start: number, qualifiedName: string): number {
	const lowered = source.toLowerCase();
	const closingTag = `</${qualifiedName}`.toLowerCase();
	let index = source.indexOf("<", start);
	while (index >= 0) {
		if (lowered.startsWith(closingTag, index)) {
			const next = source[index + closingTag.length];
			if (next === ">" || (next !== undefined && /\s/.test(next))) return index;
		}
		const end = constructEnd(source, index);
		if (end < 0) return -1;
		index = source.indexOf("<", end);
	}
	return -1;
}

/** Resolve CSS-bearing attribute values without rewriting other XML content. */
function resolveCssAttributes(tag: string, palette: Readonly<Record<string, string>>, fg: string): string {
	const replacements: Array<{ start: number; end: number; value: string }> = [];
	forEachSvgAttribute(tag, (name, value, start, end) => {
		if (name !== "style" && !CSS_VALUE_ATTRIBUTES.has(name)) return;
		const resolved = resolveCssValue(value, palette, fg);
		if (resolved !== value) replacements.push({ start, end, value: resolved });
	});
	if (replacements.length === 0) return tag;
	let output = "";
	let cursor = 0;
	for (const replacement of replacements) {
		output += tag.slice(cursor, replacement.start) + replacement.value;
		cursor = replacement.end;
	}
	return output + tag.slice(cursor);
}

type SvgAttributeVisitor = (name: string, value: string, valueStart: number, valueEnd: number) => void;

/** Visit quoted attributes in a complete XML start tag with source offsets. */
function forEachSvgAttribute(tag: string, visit: SvgAttributeVisitor): void {
	if (!/^<[A-Za-z_]/.test(tag)) return;
	let index = 1;
	while (index < tag.length && !/[\s/>]/.test(tag[index] ?? "")) index++;
	while (index < tag.length) {
		while (/\s/.test(tag[index] ?? "")) index++;
		if (tag[index] === "/" || tag[index] === ">") return;
		const nameStart = index;
		while (index < tag.length && !/[\s=/>]/.test(tag[index] ?? "")) index++;
		const name = tag.slice(nameStart, index).toLowerCase();
		while (/\s/.test(tag[index] ?? "")) index++;
		if (tag[index] !== "=") continue;
		index++;
		while (/\s/.test(tag[index] ?? "")) index++;
		const quote = tag[index];
		if (quote === '"' || quote === "'") {
			const valueStart = ++index;
			while (index < tag.length && tag[index] !== quote) index++;
			const valueEnd = index;
			visit(name, tag.slice(valueStart, valueEnd), valueStart, valueEnd);
			index++;
		} else {
			while (index < tag.length && !/[\s>]/.test(tag[index] ?? "")) index++;
		}
	}
}

/** Resolve variable functions outside CSS comments and quoted string literals. */
function resolveCssValue(source: string, palette: Readonly<Record<string, string>>, fg: string, depth = 0): string {
	if (depth >= 16) return source;
	let output = "";
	let cursor = 0;
	let index = 0;
	while (index < source.length) {
		if (source.startsWith("/*", index)) {
			const end = source.indexOf("*/", index + 2);
			index = end < 0 ? source.length : end + 2;
			continue;
		}
		const char = source[index];
		if (char === '"' || char === "'") {
			const quote = char;
			index++;
			while (index < source.length) {
				if (source[index] === "\\") index += 2;
				else if (source[index++] === quote) break;
			}
			continue;
		}
		if (source.slice(index, index + 4).toLowerCase() === "var(") {
			const reference = readCssVariableReference(source, index);
			if (reference) {
				if (reference.name.startsWith("gjc-")) {
					output += source.slice(cursor, index);
					const themeColor = palette[reference.name.slice("gjc-".length)];
					const fallback = reference.fallback?.trim();
					output += themeColor ?? (fallback ? resolveCssValue(fallback, palette, fg, depth + 1) : fg);
					cursor = reference.end;
				} else if (reference.fallback !== undefined) {
					const resolvedFallback = resolveCssValue(reference.fallback, palette, fg, depth + 1);
					if (resolvedFallback !== reference.fallback) {
						output += source.slice(cursor, index);
						output +=
							source.slice(index, reference.fallbackStart) +
							resolvedFallback +
							source.slice(reference.fallbackEnd, reference.end);
						cursor = reference.end;
					}
				}
				index = reference.end;
				continue;
			}
		}
		index++;
	}
	return output ? output + source.slice(cursor) : source;
}

interface CssVariableReference {
	name: string;
	end: number;
	fallback: string | undefined;
	fallbackStart: number;
	fallbackEnd: number;
}

/** Parse a CSS `var()` reference with balanced nested functions. */
function readCssVariableReference(source: string, start: number): CssVariableReference | undefined {
	let depth = 1;
	let quote: string | undefined;
	let close = -1;
	for (let index = start + 4; index < source.length; index++) {
		if (source.startsWith("/*", index)) {
			const commentEnd = source.indexOf("*/", index + 2);
			if (commentEnd < 0) return undefined;
			index = commentEnd + 1;
			continue;
		}
		const char = source[index];
		if (quote !== undefined) {
			if (char === "\\") index++;
			else if (char === quote) quote = undefined;
		} else if (char === '"' || char === "'") {
			quote = char;
		} else if (char === "(") {
			depth++;
		} else if (char === ")" && --depth === 0) {
			close = index;
			break;
		}
	}
	if (close < 0) return undefined;

	const bodyStart = start + 4;
	let nestedDepth = 0;
	quote = undefined;
	let comma = -1;
	for (let index = bodyStart; index < close; index++) {
		if (source.startsWith("/*", index)) {
			const commentEnd = source.indexOf("*/", index + 2);
			if (commentEnd < 0 || commentEnd >= close) return undefined;
			index = commentEnd + 1;
			continue;
		}
		const char = source[index];
		if (quote !== undefined) {
			if (char === "\\") index++;
			else if (char === quote) quote = undefined;
		} else if (char === '"' || char === "'") {
			quote = char;
		} else if (char === "(") {
			nestedDepth++;
		} else if (char === ")") {
			nestedDepth--;
		} else if (char === "," && nestedDepth === 0) {
			comma = index;
			break;
		}
	}
	const nameEnd = comma < 0 ? close : comma;
	const name = source.slice(bodyStart, nameEnd).trim();
	if (!/^--[\w-]+$/.test(name)) return undefined;
	const fallbackStart = comma < 0 ? close : comma + 1;
	return {
		name: name.slice(2),
		end: close + 1,
		fallback: comma < 0 ? undefined : source.slice(fallbackStart, close),
		fallbackStart,
		fallbackEnd: close,
	};
}

/** The first quote-aware `<svg …>` start tag (namespace prefix allowed). */
function findRootSvgTag(source: string): { start: number; end: number; tag: string } | undefined {
	let start = source.indexOf("<");
	while (start >= 0) {
		const end = constructEnd(source, start);
		if (end < 0) return undefined;
		const tag = source.slice(start, end);
		if (/^<(?:[\w.-]+:)?svg(?=[\s/>])/.test(tag)) return { start, end, tag };
		start = source.indexOf("<", end);
	}
	return undefined;
}

/** Whether the quote-aware root tag declares `attribute` outside another value. */
function hasSvgAttribute(tag: string, attribute: string): boolean {
	const name = /^<(?:[\w.-]+:)?svg(?=[\s/>])/.exec(tag)?.[0];
	if (!name) return false;
	let index = name.length;
	while (index < tag.length) {
		while (/\s/.test(tag[index] ?? "")) index++;
		if (tag[index] === "/" || tag[index] === ">") return false;
		const start = index;
		while (index < tag.length && !/[\s=/>]/.test(tag[index] ?? "")) index++;
		const current = tag.slice(start, index);
		while (/\s/.test(tag[index] ?? "")) index++;
		if (tag[index] !== "=") return false;
		index++;
		while (/\s/.test(tag[index] ?? "")) index++;
		const quote = tag[index];
		if (quote === "'" || quote === '"') {
			index++;
			while (index < tag.length && tag[index] !== quote) index++;
			index++;
		} else {
			while (index < tag.length && !/[\s>]/.test(tag[index] ?? "")) index++;
		}
		if (current === attribute) return true;
	}
	return false;
}

/** Index just past the markup construct starting at `<` (`lt`), or -1 when it is not complete yet. */
function constructEnd(source: string, lt: number): number {
	const after = (terminator: string, from: number): number => {
		const at = source.indexOf(terminator, from);
		return at < 0 ? -1 : at + terminator.length;
	};
	if (source.startsWith("<!--", lt)) return after("-->", lt + 4);
	if (source.startsWith("<![CDATA[", lt)) return after("]]>", lt + 9);
	if (source.startsWith("<?", lt)) return after("?>", lt + 2);
	// Tags and declarations end at the first `>` outside a quoted value; a
	// doctype's internal subset (`[…]`) may hold `>` of its own.
	let quote: string | undefined;
	let subset = false;
	for (let at = lt + 1; at < source.length; at++) {
		const char = source[at];
		if (quote !== undefined) {
			if (char === quote) quote = undefined;
		} else if (char === '"' || char === "'") {
			quote = char;
		} else if (char === "[" && source[lt + 1] === "!") {
			subset = true;
		} else if (char === "]") {
			subset = false;
		} else if (char === ">" && !subset) {
			return at + 1;
		}
	}
	return -1;
}
