/**
 * Source-level handling of ```svg fences in assistant Markdown: splitting
 * prose around them ({@link splitSvgFences}), turning a fence that is still
 * streaming into a document an SVG parser accepts ({@link closePartialSvg}),
 * and resolving the theme tokens figures color themselves with
 * ({@link prepareSvg}).
 *
 * Source: oh-my-pi (https://github.com/can1357/oh-my-pi)
 */

/** One run of an assistant text block: prose, or the body of a ```svg fence. */
export type FigureSegment =
	| { readonly kind: "markdown"; readonly text: string }
	/** `closed` once the fence's closing line arrived. */
	| { readonly kind: "svg"; readonly source: string; readonly closed: boolean };

/** A top-level (≤3-space indent) fenced-code opener. */
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/** Whether `markdown` holds a ```svg fence {@link splitSvgFences} would lift. */
export function hasSvgFence(markdown: string): boolean {
	if (!markdown.includes("svg")) return false;
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
				if (open[2]!.trim().split(/[ \t]/, 1)[0]!.toLowerCase() === "svg") return true;
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
	/** Open fence: its marker run, and where an svg fence's body starts (-1 for other fences). */
	let fence: { marker: string; body: number } | undefined;
	let proseStart = 0;
	let lineStart = 0;
	while (lineStart <= markdown.length) {
		const newline = markdown.indexOf("\n", lineStart);
		const lineEnd = newline < 0 ? markdown.length : newline;
		const next = newline < 0 ? markdown.length + 1 : newline + 1;
		const line = markdown.slice(lineStart, lineEnd);
		if (fence) {
			if (closesFence(line, fence.marker)) {
				if (fence.body >= 0) {
					segments.push({ kind: "svg", source: markdown.slice(fence.body, lineStart), closed: true });
					proseStart = Math.min(next, markdown.length);
				}
				fence = undefined;
			}
		} else {
			const open = FENCE_OPEN.exec(line);
			// A backtick fence's info string cannot hold backticks (CommonMark).
			if (open && !(open[1]![0] === "`" && open[2]!.includes("`"))) {
				const isSvg = open[2]!.trim().split(/[ \t]/, 1)[0]!.toLowerCase() === "svg";
				if (isSvg) {
					const prose = markdown.slice(proseStart, lineStart);
					if (prose.trim()) segments.push({ kind: "markdown", text: prose });
					fence = { marker: open[1]!, body: Math.min(next, markdown.length) };
				} else {
					fence = { marker: open[1]!, body: -1 };
				}
			}
		}
		lineStart = next;
	}
	if (fence && fence.body >= 0) {
		segments.push({ kind: "svg", source: markdown.slice(fence.body), closed: false });
	} else if (markdown.slice(proseStart).trim()) {
		segments.push({ kind: "markdown", text: markdown.slice(proseStart) });
	}
	return segments;
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

/** `var(--name)` / `var(--name, fallback)`; the fallback may hold one level of parentheses (`rgb(…)`). */
const VAR_REFERENCE = /var\(\s*--([\w-]+)\s*(?:,\s*((?:[^()]|\([^()]*\))*))?\)/g;
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
 * - locally declared CSS custom properties remain intact for the SVG cascade;
 *   other variable references in `<style>` contents, `style` declarations,
 *   and presentation attributes become `palette[name]` (an unknown name
 *   takes its fallback, else `palette.fg`); SVG text and unrelated attributes
 *   stay literal;
 * - a root `<svg>` lacking them gets `color` = `palette.fg` (so
 *   `currentColor` follows the theme), a sans-serif `font-family` (instead
 *   of the rasterizer's Times), `xmlns`, and `xmlns:xlink` when the source
 *   uses `xlink:` attributes.
 */
export function prepareSvg(svg: string, palette: Readonly<Record<string, string>>): string {
	const fg = palette.fg ?? "currentColor";
	const localVariables = collectSvgCssVariables(svg);
	const resolved = resolveSvgCssVariables(svg, palette, fg, localVariables);
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
function resolveSvgCssVariables(
	source: string,
	palette: Readonly<Record<string, string>>,
	fg: string,
	localVariables: ReadonlySet<string>,
): string {
	let output = "";
	let cursor = 0;
	while (cursor < source.length) {
		const start = source.indexOf("<", cursor);
		if (start < 0) return output + source.slice(cursor);
		output += source.slice(cursor, start);
		const end = constructEnd(source, start);
		if (end < 0) return output + source.slice(start);
		const tag = source.slice(start, end);
		if (/^<(?:[\w.-]+:)?style(?=[\s/>])/i.test(tag)) {
			output += resolveCssAttributes(tag, palette, fg, localVariables);
			const closingTag = findStyleClosingTag(source, end);
			if (closingTag < 0) return output + resolveCssValue(source.slice(end), palette, fg, localVariables);
			output += resolveCssValue(source.slice(end, closingTag), palette, fg, localVariables);
			cursor = closingTag;
			continue;
		}
		output += resolveCssAttributes(tag, palette, fg, localVariables);
		cursor = end;
	}
	return output;
}

/** Collect custom-property declarations from stylesheet text and inline styles. */
function collectSvgCssVariables(source: string): Set<string> {
	const variables = new Set<string>();
	let cursor = 0;
	while (cursor < source.length) {
		const start = source.indexOf("<", cursor);
		if (start < 0) break;
		const end = constructEnd(source, start);
		if (end < 0) break;
		const tag = source.slice(start, end);
		forEachSvgAttribute(tag, (name, value) => {
			if (name === "style") collectCssVariableDeclarations(value, variables);
		});
		if (/^<(?:[\w.-]+:)?style(?=[\s/>])/i.test(tag)) {
			const closingTag = findStyleClosingTag(source, end);
			if (closingTag < 0) {
				collectCssVariableDeclarations(source.slice(end), variables);
				break;
			}
			collectCssVariableDeclarations(source.slice(end, closingTag), variables);
			cursor = closingTag;
			continue;
		}
		cursor = end;
	}
	return variables;
}

/** Collect custom-property declarations while ignoring CSS comments and strings. */
function collectCssVariableDeclarations(css: string, variables: Set<string>): void {
	let index = 0;
	let lastSignificant: string | undefined;
	while (index < css.length) {
		if (css.startsWith("/*", index)) {
			const end = css.indexOf("*/", index + 2);
			index = end < 0 ? css.length : end + 2;
			continue;
		}
		const char = css[index];
		if (char === '"' || char === "'") {
			const quote = char;
			index++;
			while (index < css.length) {
				if (css[index] === "\\") index += 2;
				else if (css[index++] === quote) break;
			}
			lastSignificant = quote;
			continue;
		}
		if (
			css.startsWith("--", index) &&
			(lastSignificant === undefined || lastSignificant === "{" || lastSignificant === ";")
		) {
			let nameEnd = index + 2;
			while (/[\w-]/.test(css[nameEnd] ?? "")) nameEnd++;
			let colon = nameEnd;
			while (/\s/.test(css[colon] ?? "")) colon++;
			if (nameEnd > index + 2 && css[colon] === ":") variables.add(css.slice(index + 2, nameEnd));
		}
		if (!/\s/.test(char ?? "")) lastSignificant = char;
		index++;
	}
}

/** Find the closing style tag; `<` cannot appear literally in XML style text. */
function findStyleClosingTag(source: string, start: number): number {
	const lowered = source.toLowerCase();
	let index = lowered.indexOf("</style", start);
	while (index >= 0) {
		const next = source[index + 7];
		if (next === ">" || (next !== undefined && /\s/.test(next))) return index;
		index = lowered.indexOf("</style", index + 7);
	}
	return -1;
}

/** Resolve CSS-bearing attribute values without rewriting other XML content. */
function resolveCssAttributes(
	tag: string,
	palette: Readonly<Record<string, string>>,
	fg: string,
	localVariables: ReadonlySet<string>,
): string {
	const replacements: Array<{ start: number; end: number; value: string }> = [];
	forEachSvgAttribute(tag, (name, value, start, end) => {
		if (name !== "style" && !CSS_VALUE_ATTRIBUTES.has(name)) return;
		const resolved = resolveCssValue(value, palette, fg, localVariables);
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
function resolveCssValue(
	source: string,
	palette: Readonly<Record<string, string>>,
	fg: string,
	localVariables: ReadonlySet<string>,
): string {
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
		if (source.startsWith("var(", index)) {
			VAR_REFERENCE.lastIndex = index;
			const match = VAR_REFERENCE.exec(source);
			if (match?.index === index) {
				const name = match[1]!;
				const fallback = match[2];
				const end = VAR_REFERENCE.lastIndex;
				if (!localVariables.has(name)) {
					output += source.slice(cursor, index);
					output += palette[name] ?? (fallback?.trim() || fg);
					cursor = end;
				}
				index = end;
				continue;
			}
		}
		index++;
	}
	return output ? output + source.slice(cursor) : source;
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
