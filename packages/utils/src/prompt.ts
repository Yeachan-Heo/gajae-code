import type { HelperDelegate, HelperOptions, Template, TemplateDelegate } from "handlebars";

export type { HelperDelegate, HelperOptions, Template, TemplateDelegate };

export type PromptRenderPhase = "pre-render" | "post-render";

export interface PromptFormatOptions {
	renderPhase?: PromptRenderPhase;
	replaceAsciiSymbols?: boolean;
	normalizeRfc2119?: boolean;
}

// Opening XML tag (not self-closing, not closing)
const OPENING_XML = /^<([a-z_-]+)(?:\s+[^>]*)?>$/;
// Closing XML tag
const CLOSING_XML = /^<\/([a-z_-]+)>$/;
// Handlebars block end: {{/if}}, {{/has}}, {{/list}}, etc.
const CLOSING_HBS = /^\{\{\//;
// Table row
const TABLE_ROW = /^\|.*\|$/;
// Table separator (|---|---|)
const TABLE_SEP = /^\|[-:\s|]+\|$/;

/**
 * RFC 2119 keywords (plus project aliases NEVER/AVOID) wrapped in markdown bold
 * — `**MUST**`, `**MUST NOT**`, `**NEVER**`, etc.
 */
const RFC2119_BOLD = /\*\*(MUST NOT|SHOULD NOT|RECOMMENDED|REQUIRED|OPTIONAL|SHOULD|MUST|MAY|NEVER|AVOID)\*\*/g;

/**
 * Normalize RFC 2119 markers per project convention:
 *   - Strip `**KEYWORD**` bold (visual noise, no semantics).
 *   - Alias `MUST NOT` → `NEVER` and `SHOULD NOT` → `AVOID` (single-token equivalents).
 * Skips spans inside inline code (`` `…` ``) so alias definitions can be quoted literally.
 */
function normalizeRfc2119(line: string): string {
	const segments = line.split("`");
	for (let i = 0; i < segments.length; i += 2) {
		segments[i] = segments[i]
			.replace(RFC2119_BOLD, "$1")
			.replace(/\bMUST NOT\b/g, "NEVER")
			.replace(/\bSHOULD NOT\b/g, "AVOID");
	}
	return segments.join("`");
}

/** Compact a table row by trimming cell padding */
function compactTableRow(line: string): string {
	const cells = line.split("|");
	return cells.map(c => c.trim()).join("|");
}

/** Compact a table separator row */
function compactTableSep(line: string): string {
	const cells = line.split("|").filter(c => c.trim());
	const normalized = cells.map(c => {
		const trimmed = c.trim();
		const left = trimmed.startsWith(":");
		const right = trimmed.endsWith(":");
		if (left && right) return ":---:";
		if (left) return ":---";
		if (right) return "---:";
		return "---";
	});
	return `|${normalized.join("|")}|`;
}

const HTML_COMMENT_OPEN = "<!--";
const HTML_COMMENT_CLOSE = "-->";

type HtmlCommentState = {
	inHtmlComment: boolean;
};

function replaceCommonAsciiSymbols(line: string): string {
	return line
		.replace(/\.{3}/g, "…")
		.replace(/<->/g, "↔")
		.replace(/->/g, "→")
		.replace(/<-/g, "←")
		.replace(/!=/g, "≠")
		.replace(/<=/g, "≤")
		.replace(/>=/g, "≥");
}

function replaceCommonAsciiSymbolsOutsideHtmlComments(line: string, state: HtmlCommentState): string {
	if (!state.inHtmlComment && !line.includes(HTML_COMMENT_OPEN) && !line.includes(HTML_COMMENT_CLOSE)) {
		return replaceCommonAsciiSymbols(line);
	}

	let result = "";
	let cursor = 0;

	while (cursor < line.length) {
		if (state.inHtmlComment) {
			const closeIndex = line.indexOf(HTML_COMMENT_CLOSE, cursor);
			if (closeIndex === -1) {
				return result + line.slice(cursor);
			}
			result += line.slice(cursor, closeIndex + HTML_COMMENT_CLOSE.length);
			cursor = closeIndex + HTML_COMMENT_CLOSE.length;
			state.inHtmlComment = false;
			continue;
		}

		const openIndex = line.indexOf(HTML_COMMENT_OPEN, cursor);
		if (openIndex === -1) {
			result += replaceCommonAsciiSymbols(line.slice(cursor));
			return result;
		}

		result += replaceCommonAsciiSymbols(line.slice(cursor, openIndex));
		const closeIndex = line.indexOf(HTML_COMMENT_CLOSE, openIndex + HTML_COMMENT_OPEN.length);
		if (closeIndex === -1) {
			result += line.slice(openIndex);
			state.inHtmlComment = true;
			return result;
		}

		result += line.slice(openIndex, closeIndex + HTML_COMMENT_CLOSE.length);
		cursor = closeIndex + HTML_COMMENT_CLOSE.length;
	}

	return result;
}

export function format(content: string, options: PromptFormatOptions = {}): string {
	const {
		renderPhase = "post-render",
		replaceAsciiSymbols = false,
		normalizeRfc2119: shouldNormalizeRfc2119 = false,
	} = options;
	const isPreRender = renderPhase === "pre-render";
	const lines = content.split("\n");
	const result: string[] = [];
	let inCodeBlock = false;

	const htmlCommentState: HtmlCommentState = { inHtmlComment: false };
	const topLevelTags: string[] = [];

	for (let i = 0; i < lines.length; i++) {
		let line = lines[i].trimEnd();
		let trimmedStart = line.trimStart();
		if (trimmedStart.startsWith("```") || trimmedStart.startsWith("~~~")) {
			inCodeBlock = !inCodeBlock;
			result.push(line);
			continue;
		}

		if (inCodeBlock) {
			result.push(line);
			continue;
		}

		if (replaceAsciiSymbols) {
			line = replaceCommonAsciiSymbolsOutsideHtmlComments(line, htmlCommentState);
		}
		trimmedStart = line.trimStart();
		const trimmed = line.trim();

		const isOpeningXml = OPENING_XML.test(trimmedStart) && !trimmedStart.endsWith("/>");
		if (isOpeningXml && line.length === trimmedStart.length) {
			const match = OPENING_XML.exec(trimmedStart);
			if (match) topLevelTags.push(match[1]);
		}

		const closingMatch = CLOSING_XML.exec(trimmedStart);
		if (closingMatch) {
			const tagName = closingMatch[1];
			if (topLevelTags.length > 0 && topLevelTags[topLevelTags.length - 1] === tagName) {
				topLevelTags.pop();
			}
		} else if (isPreRender && trimmedStart.startsWith("{{")) {
			/* keep indentation as-is in pre-render for Handlebars markers */
		} else if (TABLE_SEP.test(trimmedStart)) {
			const leadingWhitespace = line.slice(0, line.length - trimmedStart.length);
			line = `${leadingWhitespace}${compactTableSep(trimmedStart)}`;
		} else if (TABLE_ROW.test(trimmedStart)) {
			const leadingWhitespace = line.slice(0, line.length - trimmedStart.length);
			line = `${leadingWhitespace}${compactTableRow(trimmedStart)}`;
		}

		if (shouldNormalizeRfc2119) {
			line = normalizeRfc2119(line);
		}

		if (trimmed === "") {
			const nextLine = lines[i + 1]?.trim() ?? "";
			// Strip any run of 2+ consecutive blank lines entirely; preserve a single blank.
			if (nextLine === "") {
				while (result.length > 0 && result[result.length - 1].trim() === "") {
					result.pop();
				}
				while (i + 1 < lines.length && lines[i + 1].trim() === "") i++;
				continue;
			}
			const prevLine = result[result.length - 1]?.trim() ?? "";
			if (prevLine === "") {
				continue;
			}
		}

		if (CLOSING_XML.test(trimmed) || (isPreRender && CLOSING_HBS.test(trimmed))) {
			while (result.length > 0 && result[result.length - 1].trim() === "") {
				result.pop();
			}
		}

		result.push(line);
	}

	while (result.length > 0 && result[result.length - 1].trim() === "") {
		result.pop();
	}

	return result.join("\n");
}

export interface TemplateContext extends Record<string, unknown> {
	args?: string[];
	ARGUMENTS?: string;
	arguments?: string;
}

type HandlebarsRuntime = typeof import("handlebars");
type HandlebarsInstance = ReturnType<HandlebarsRuntime["create"]>;

let handlebars: HandlebarsInstance | undefined;

function getHandlebars(): HandlebarsInstance {
	if (handlebars) return handlebars;
	// Lazy bare-literal require: statically traceable, so the bundler always
	// embeds handlebars in the main bundle (compiled binaries included), while
	// the module still loads only on first template render. The previous
	// bunfs extra-entrypoint require crashed v0.9.3–v0.9.6 compiled releases
	// at startup when --minify dropped the entrypoint (#1939).
	const Handlebars = asHandlebarsRuntime(require("handlebars"));
	handlebars = Handlebars.create();
	registerBuiltinHelpers(handlebars);
	return handlebars;
}

function asHandlebarsRuntime(value: unknown): HandlebarsRuntime {
	if (isHandlebarsRuntime(value)) return value;
	if (isObjectRecord(value) && isHandlebarsRuntime(value.default)) return value.default;
	throw new Error("Loaded handlebars module does not expose the expected runtime API.");
}

function isHandlebarsRuntime(value: unknown): value is HandlebarsRuntime {
	return isObjectRecord(value) && typeof value.create === "function";
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function registerBuiltinHelpers(handlebars: HandlebarsInstance): void {
	handlebars.registerHelper("arg", function (this: TemplateContext, index: number | string): string {
		const args = this.args ?? [];
		const parsedIndex = typeof index === "number" ? index : Number.parseInt(index, 10);
		if (!Number.isFinite(parsedIndex)) return "";
		const zeroBased = parsedIndex - 1;
		if (zeroBased < 0) return "";
		return args[zeroBased] ?? "";
	});

	/**
	 * {{#list items prefix="- " suffix="" join="\n"}}{{this}}{{/list}}
	 * Renders an array with customizable prefix, suffix, and join separator.
	 * Note: Use \n in join for newlines (will be unescaped automatically).
	 */
	handlebars.registerHelper("list", function (this: unknown, context: unknown[], options: HelperOptions): string {
		if (!Array.isArray(context) || context.length === 0) return "";
		const prefix = (options.hash.prefix as string) ?? "";
		const suffix = (options.hash.suffix as string) ?? "";
		const rawSeparator = (options.hash.join as string) ?? "\n";
		const separator = rawSeparator.replace(/\\n/g, "\n").replace(/\\t/g, "\t");
		return context.map(item => `${prefix}${options.fn(item)}${suffix}`).join(separator);
	});

	/**
	 * {{join array ", "}}
	 * Joins an array with a separator (default: ", ").
	 */
	handlebars.registerHelper("join", (context: unknown[], separator?: unknown): string => {
		if (!Array.isArray(context)) return "";
		const sep = typeof separator === "string" ? separator : ", ";
		return context.join(sep);
	});

	/**
	 * {{default value "fallback"}}
	 * Returns the value if truthy, otherwise returns the fallback.
	 */
	handlebars.registerHelper("default", (value: unknown, defaultValue: unknown): unknown => value || defaultValue);

	/**
	 * {{pluralize count "item" "items"}}
	 * Returns "1 item" or "5 items" based on count.
	 */
	handlebars.registerHelper(
		"pluralize",
		(count: number, singular: string, plural: string): string => `${count} ${count === 1 ? singular : plural}`,
	);

	/**
	 * {{#when value "==" compare}}...{{else}}...{{/when}}
	 * Conditional block with comparison operators: ==, ===, !=, !==, >, <, >=, <=
	 */
	handlebars.registerHelper(
		"when",
		function (this: unknown, lhs: unknown, operator: string, rhs: unknown, options: HelperOptions): string {
			const ops: Record<string, (a: unknown, b: unknown) => boolean> = {
				"==": (a, b) => a === b,
				"===": (a, b) => a === b,
				"!=": (a, b) => a !== b,
				"!==": (a, b) => a !== b,
				">": (a, b) => (a as number) > (b as number),
				"<": (a, b) => (a as number) < (b as number),
				">=": (a, b) => (a as number) >= (b as number),
				"<=": (a, b) => (a as number) <= (b as number),
			};
			const fn = ops[operator];
			if (!fn) return options.inverse(this);
			return fn(lhs, rhs) ? options.fn(this) : options.inverse(this);
		},
	);

	/**
	 * {{#ifAny a b c}}...{{else}}...{{/ifAny}}
	 * True if any argument is truthy.
	 */
	handlebars.registerHelper("ifAny", function (this: unknown, ...args: unknown[]): string {
		const options = args.pop() as HelperOptions;
		return args.some(Boolean) ? options.fn(this) : options.inverse(this);
	});

	/**
	 * {{#ifAll a b c}}...{{else}}...{{/ifAll}}
	 * True if all arguments are truthy.
	 */
	handlebars.registerHelper("ifAll", function (this: unknown, ...args: unknown[]): string {
		const options = args.pop() as HelperOptions;
		return args.every(Boolean) ? options.fn(this) : options.inverse(this);
	});

	/**
	 * {{#table rows headers="Col1|Col2"}}{{col1}}|{{col2}}{{/table}}
	 * Generates a markdown table from an array of objects.
	 */
	handlebars.registerHelper("table", function (this: unknown, context: unknown[], options: HelperOptions): string {
		if (!Array.isArray(context) || context.length === 0) return "";
		const headersStr = options.hash.headers as string | undefined;
		const headers = headersStr?.split("|") ?? [];
		const separator = headers.map(() => "---").join(" | ");
		const headerRow = headers.length > 0 ? `| ${headers.join(" | ")} |\n| ${separator} |\n` : "";
		const rows = context.map(item => `| ${options.fn(item).trim()} |`).join("\n");
		return headerRow + rows;
	});

	/**
	 * {{#codeblock lang="diff"}}...{{/codeblock}}
	 * Wraps content in a fenced code block.
	 */
	handlebars.registerHelper("codeblock", function (this: unknown, options: HelperOptions): string {
		const lang = (options.hash.lang as string) ?? "";
		const content = options.fn(this).trim();
		return `\`\`\`${lang}\n${content}\n\`\`\``;
	});

	/**
	 * {{#xml "tag"}}content{{/xml}}
	 * Wraps content in XML-style tags. Returns empty string if content is empty.
	 */
	handlebars.registerHelper("xml", function (this: unknown, tag: string, options: HelperOptions): string {
		const content = options.fn(this).trim();
		if (!content) return "";
		return `<${tag}>\n${content}\n</${tag}>`;
	});

	/**
	 * {{escapeXml value}}
	 * Escapes XML special characters: & < > "
	 */
	handlebars.registerHelper("escapeXml", (value: unknown): string => {
		if (value == null) return "";
		return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
	});

	/**
	 * {{len array}}
	 * Returns the length of an array or string.
	 */
	handlebars.registerHelper("len", (value: unknown): number => {
		if (Array.isArray(value)) return value.length;
		if (typeof value === "string") return value.length;
		return 0;
	});

	/**
	 * {{add a b}}
	 * Adds two numbers.
	 */
	handlebars.registerHelper("add", (a: number, b: number): number => (a ?? 0) + (b ?? 0));

	/**
	 * {{sub a b}}
	 * Subtracts b from a.
	 */
	handlebars.registerHelper("sub", (a: number, b: number): number => (a ?? 0) - (b ?? 0));

	/**
	 * {{#has collection item}}...{{else}}...{{/has}}
	 * Checks if an array includes an item or if a Set/Map has a key.
	 */
	handlebars.registerHelper(
		"has",
		function (this: unknown, collection: unknown, item: unknown, options: HelperOptions): string {
			let found = false;
			if (Array.isArray(collection)) {
				found = collection.includes(item);
			} else if (collection instanceof Set) {
				found = collection.has(item);
			} else if (collection instanceof Map) {
				found = collection.has(item);
			} else if (collection && typeof collection === "object") {
				if (typeof item === "string" || typeof item === "number" || typeof item === "symbol") {
					found = item in collection;
				}
			}
			return found ? options.fn(this) : options.inverse(this);
		},
	);

	/**
	 * {{includes array item}}
	 * Returns true if array includes item. For use in other helpers.
	 */
	handlebars.registerHelper("includes", (collection: unknown, item: unknown): boolean => {
		if (Array.isArray(collection)) return collection.includes(item);
		if (collection instanceof Set) return collection.has(item);
		if (collection instanceof Map) return collection.has(item);
		return false;
	});

	/**
	 * {{not value}}
	 * Returns logical NOT of value. For use in subexpressions.
	 */
	handlebars.registerHelper("not", (value: unknown): boolean => !value);

	handlebars.registerHelper("jsonStringify", (value: unknown): string => JSON.stringify(value));
}

export function registerHelper(name: string, fn: HelperDelegate): void {
	getHandlebars().registerHelper(name, fn);
}

export function registerPartial(name: string, fn: Template): void {
	getHandlebars().registerPartial(name, fn);
}

/**
 * Handlebars' lexer greedily matches `}}}` as `CLOSE_UNESCAPED` (the close of a
 * triple-stash `{{{ ... }}}`). When a regular helper close `}}` is immediately
 * followed by a literal `}` (common in compact JSON examples like
 * `{del:{{href ...}}}`), the lexer mistakes the trailing `}}}` for a triple-close
 * and rejects the input.
 *
 * We never use triple-stash (it's redundant under `noEscape: true`), so any run
 * of 3+ closing braces is unambiguously "helper close `}}`" + "literal `}`s".
 * Inject a no-op comment between them so the lexer tokenizes the helper close
 * cleanly and treats the rest as content.
 */
function disambiguateClosingBraces(template: string): string {
	return template.replace(/\}\}(\}+)/g, "}}{{!---}}$1");
}

const compiledTemplateCache = new Map<string, (context: TemplateContext) => string>();

export function compile(template: string): (context: TemplateContext) => string {
	const disambiguated = disambiguateClosingBraces(template);
	const cached = compiledTemplateCache.get(disambiguated);
	if (cached) return cached;
	const compiled = getHandlebars().compile(disambiguated, { noEscape: true, strict: false }) as (
		context: TemplateContext,
	) => string;
	compiledTemplateCache.set(disambiguated, compiled);
	return compiled;
}

export function render(template: string, context: TemplateContext = {}): string {
	const compiled = compile(template);
	const rendered = compiled(context ?? {});
	return format(rendered, { renderPhase: "post-render" });
}
