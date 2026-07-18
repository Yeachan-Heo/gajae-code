/**
 * Telegram HTML formatting helpers for the Gajae-Code SDK.
 *
 * All Gajae-Code SDK Telegram output is sent with `parse_mode: "HTML"`. This
 * module is the single source of truth for: escaping dynamic text, converting a
 * bounded markdown subset into Telegram HTML, safely truncating a finished
 * message to Telegram's 4096-char limit without breaking tags/entities, and
 * laying out inline-keyboard buttons as a numbered grid.
 *
 * Discipline: escape first, tag second. Telegram only parses a small tag set
 * (b, i, u, s, code, pre, a, blockquote, tg-spoiler); a stray `<` or unbalanced
 * tag can make Telegram reject the whole message, so dynamic text is always
 * escaped before any tag is emitted.
 */

export const TELEGRAM_PARSE_MODE = "HTML" as const;
export const TELEGRAM_MESSAGE_LIMIT = 4096;

/** Tags Telegram parses in HTML mode (used by the truncation guard). */
const ALLOWED_TAGS = new Set(["b", "i", "u", "s", "code", "pre", "a", "blockquote", "tg-spoiler"]);

/** Escape text for Telegram HTML body content (`& < >`). */
export function escapeHtml(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Escape a value for use inside a double-quoted HTML attribute. */
function escapeAttr(value: string): string {
	return escapeHtml(value).replace(/"/g, "&quot;");
}

/** Wrap already-escaped text in a Telegram tag. */
function tag(name: string, escaped: string): string {
	return `<${name}>${escaped}</${name}>`;
}

/** Bold the given raw text (escaped internally). */
export function bold(raw: string): string {
	return tag("b", escapeHtml(raw));
}

/** Italicize the given raw text (escaped internally). */
export function italic(raw: string): string {
	return tag("i", escapeHtml(raw));
}

/** Render the given raw text as inline code (escaped internally). */
export function code(raw: string): string {
	return tag("code", escapeHtml(raw));
}

/** Render the given raw text as a preformatted block (escaped internally). */
export function pre(raw: string): string {
	return tag("pre", escapeHtml(raw));
}

const PLACEHOLDER_PREFIX = "\u0000ph";
const PLACEHOLDER_SUFFIX = "\u0000";

/** Only http(s) and mailto links are emitted; anything else stays literal. */
function isSafeUrl(url: string): boolean {
	return /^(https?:\/\/|mailto:)/i.test(url);
}

/** Column alignment parsed from a GFM table separator cell. */
type ColumnAlign = "left" | "right" | "center";

/** Split a markdown table row into trimmed cells, honoring escaped `\|`. */
function splitTableRow(line: string): string[] {
	let s = line.trim();
	if (s.startsWith("|")) s = s.slice(1);
	if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
	const cells: string[] = [];
	let cur = "";
	for (let i = 0; i < s.length; i++) {
		const ch = s[i]!;
		if (ch === "\\" && s[i + 1] === "|") {
			cur += "|";
			i++;
			continue;
		}
		if (ch === "|") {
			cells.push(cur);
			cur = "";
			continue;
		}
		cur += ch;
	}
	cells.push(cur);
	return cells.map(c => c.trim());
}

/** A line is a candidate table row when it contains an unescaped `|`. */
function looksLikeTableRow(line: string): boolean {
	return /(?:^|[^\\])\|/.test(line);
}

/** A separator row has only dashes/colons/spaces per cell, with at least one dash. */
function isTableSeparator(line: string): boolean {
	if (!looksLikeTableRow(line)) return false;
	const cells = splitTableRow(line);
	return cells.length > 0 && cells.every(c => /^:?-+:?$/.test(c));
}

/** Derive a column alignment from a separator cell (`:---`, `---:`, `:---:`). */
function parseAlign(cell: string): ColumnAlign {
	const c = cell.trim();
	const left = c.startsWith(":");
	const right = c.endsWith(":");
	if (left && right) return "center";
	if (right) return "right";
	return "left";
}

/** Render parsed table parts as an aligned, monospace-friendly plain-text grid. */
function renderTableText(header: string[], aligns: ColumnAlign[], body: string[][]): string {
	const rows = [header, ...body];
	const cols = Math.max(header.length, ...body.map(r => r.length));
	const widths: number[] = [];
	for (let c = 0; c < cols; c++) {
		let w = 1;
		for (const row of rows) w = Math.max(w, (row[c] ?? "").length);
		widths[c] = w;
	}
	const padCell = (value: string, c: number): string => {
		const width = widths[c]!;
		const pad = width - value.length;
		if (pad <= 0) return value;
		const align = aligns[c] ?? "left";
		if (align === "right") return " ".repeat(pad) + value;
		if (align === "center") {
			const leftPad = Math.floor(pad / 2);
			return " ".repeat(leftPad) + value + " ".repeat(pad - leftPad);
		}
		return value + " ".repeat(pad);
	};
	const renderRow = (row: string[]): string =>
		Array.from({ length: cols }, (_v, c) => padCell(row[c] ?? "", c)).join(" | ");
	const divider = widths.map(w => "-".repeat(w)).join("-|-");
	return [renderRow(header), divider, ...body.map(renderRow)].join("\n");
}
/** Render compact tables as a grid and wide tables as readable Telegram-native records. */
function renderTelegramTable(header: string[], aligns: ColumnAlign[], body: string[][]): string {
	const grid = renderTableText(header, aligns, body);
	if (body.length === 0 || grid.split("\n").every(line => Bun.stringWidth(line) <= 42)) return pre(grid);
	return body
		.map(row =>
			header
				.map(
					(label, column) =>
						`${tag("b", escapeHtml(label || `Column ${column + 1}`))}: ${escapeHtml(row[column] ?? "")}`,
				)
				.join("\n"),
		)
		.join("\n\n");
}

/**
 * Replace GFM tables with stashed monospace `<pre>` blocks. Telegram HTML has no
 * table primitive, so a header row followed by a `|---|` separator is rendered as
 * an aligned plain-text grid (cell content escaped by `pre`).
 */
function convertMarkdownTables(text: string, stash: (html: string) => string): string {
	const lines = text.split("\n");
	const out: string[] = [];
	for (let i = 0; i < lines.length; i++) {
		const headerLine = lines[i]!;
		const separatorLine = lines[i + 1];
		if (looksLikeTableRow(headerLine) && separatorLine !== undefined && isTableSeparator(separatorLine)) {
			const header = splitTableRow(headerLine);
			const aligns = splitTableRow(separatorLine).map(parseAlign);
			const body: string[][] = [];
			let j = i + 2;
			for (; j < lines.length; j++) {
				const row = lines[j]!;
				if (!looksLikeTableRow(row) || isTableSeparator(row)) break;
				body.push(splitTableRow(row));
			}
			out.push(stash(renderTelegramTable(header, aligns, body)));
			i = j - 1;
			continue;
		}
		out.push(headerLine);
	}
	return out.join("\n");
}

/**
 * Convert a bounded markdown subset into Telegram HTML. Supported: fenced code,
 * inline code, `**bold**`, `*italic*`, `~~strikethrough~~`, `[text](url)`
 * (safe schemes only), `#` headers, `>` blockquotes, and GFM tables (rendered
 * as a monospace block).
 * Unsupported or malformed markdown is left as escaped literal text — never
 * emitted as unbalanced tags.
 */
export function markdownToTelegramHtml(markdown: string): string {
	const placeholders: string[] = [];
	const stash = (html: string): string => {
		const token = `${PLACEHOLDER_PREFIX}${placeholders.length}${PLACEHOLDER_SUFFIX}`;
		placeholders.push(html);
		return token;
	};

	let text = markdown;

	// 1. Fenced code blocks (protect literal content before any other transform).
	text = text.replace(/```[^\n]*\n?([\s\S]*?)```/g, (_m, body: string) => stash(pre(body)));

	// 1b. GFM tables -> aligned monospace <pre> block (no native table primitive).
	text = convertMarkdownTables(text, stash);

	// 2. Inline code.
	text = text.replace(/`([^`\n]+)`/g, (_m, body: string) => stash(code(body)));

	// 3. Links (capture raw URL before escaping). Unsafe/malformed links stay literal.
	text = text.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (whole, label: string, url: string) => {
		if (!isSafeUrl(url)) return whole;
		return stash(`<a href="${escapeAttr(url)}">${escapeHtml(label)}</a>`);
	});

	// 4. Escape everything that remains (placeholders contain no escapable chars).
	text = escapeHtml(text);

	// 5. Line-level transforms on escaped text: headers and merged blockquotes.
	const lines = text.split("\n");
	const out: string[] = [];
	let quoteBuffer: string[] | null = null;
	const flushQuote = () => {
		if (quoteBuffer) {
			out.push(tag("blockquote", quoteBuffer.join("\n")));
			quoteBuffer = null;
		}
	};
	for (const line of lines) {
		const quote = /^&gt;\s?(.*)$/.exec(line);
		if (quote) {
			if (!quoteBuffer) {
				quoteBuffer = [];
			}
			quoteBuffer.push(quote[1] ?? "");
			continue;
		}
		flushQuote();
		const header = /^(#{1,6})\s+(.*)$/.exec(line);
		out.push(header ? tag("b", header[2] ?? "") : line);
	}
	flushQuote();
	text = out.join("\n");

	// 6. Inline emphasis (bold before italic; unbalanced markers stay literal).
	text = text.replace(/\*\*([^*\n]+)\*\*/g, (_m, body: string) => tag("b", body));
	text = text.replace(/\*([^*\n]+)\*/g, (_m, body: string) => tag("i", body));
	text = text.replace(/~~([^~\n]+)~~/g, (_m, body: string) => tag("s", body));

	// 7. Restore protected placeholders.
	text = text.replace(
		new RegExp(`${PLACEHOLDER_PREFIX}(\\d+)${PLACEHOLDER_SUFFIX}`, "g"),
		(_m, i: string) => placeholders[Number(i)] ?? "",
	);

	return text;
}

interface Token {
	value: string;
	/** Tag name if this token opens a tag, else undefined. */
	open?: string;
	/** Exact opening tag text, including attributes, for safe chunk reopening. */
	openTag?: string;
	/** Tag name if this token closes a tag, else undefined. */
	close?: string;
}

/** Tokenize HTML into tags, entities, and single characters (never splits them). */
function tokenize(html: string): Token[] {
	const tokens: Token[] = [];
	let i = 0;
	while (i < html.length) {
		const ch = html[i]!;
		if (ch === "<") {
			const end = html.indexOf(">", i);
			if (end !== -1) {
				const raw = html.slice(i, end + 1);
				const close = /^<\/([a-z-]+)>$/i.exec(raw);
				const openMatch = /^<([a-z-]+)(?:\s[^>]*)?>$/i.exec(raw);
				const token: Token = { value: raw };
				if (close && ALLOWED_TAGS.has(close[1]!.toLowerCase())) token.close = close[1]!.toLowerCase();
				else if (openMatch && ALLOWED_TAGS.has(openMatch[1]!.toLowerCase())) {
					token.open = openMatch[1]!.toLowerCase();
					token.openTag = raw;
				}
				tokens.push(token);
				i = end + 1;
				continue;
			}
		}
		if (ch === "&") {
			const end = html.indexOf(";", i);
			if (end !== -1 && end - i <= 10) {
				tokens.push({ value: html.slice(i, end + 1) });
				i = end + 1;
				continue;
			}
		}
		tokens.push({ value: ch });
		i++;
	}
	return tokens;
}

/**
 * Truncate a finished Telegram HTML message to at most `max` chars without
 * splitting a tag or entity, closing any still-open allowed tags and appending
 * `marker`. The final string is guaranteed to be <= `max`.
 */
export function truncateTelegramHtml(message: string, max = TELEGRAM_MESSAGE_LIMIT, marker = "… [truncated]"): string {
	if (message.length <= max) return message;

	// When `max` is too small to even hold the marker, drop it so the hard
	// length guarantee (output.length <= max) still holds.
	const effectiveMarker = marker.length <= max ? marker : "";

	const tokens = tokenize(message);
	const stack: string[] = [];
	let out = "";

	const closersFor = (s: string[]): string =>
		s
			.map(t => `</${t}>`)
			.reverse()
			.join("");

	for (const token of tokens) {
		// Simulate accepting this token, then ensure we can still close + mark.
		const nextStack = [...stack];
		if (token.open) nextStack.push(token.open);
		else if (token.close) {
			const idx = nextStack.lastIndexOf(token.close);
			if (idx !== -1) nextStack.splice(idx, 1);
		}
		const projected = out.length + token.value.length + closersFor(nextStack).length + effectiveMarker.length;
		if (projected > max) break;
		out += token.value;
		if (token.open) stack.push(token.open);
		else if (token.close) {
			const idx = stack.lastIndexOf(token.close);
			if (idx !== -1) stack.splice(idx, 1);
		}
	}

	return out + closersFor(stack) + effectiveMarker;
}

interface OpenTag {
	name: string;
	tag: string;
}

/** Split a finished Telegram HTML message into ordered chunks without splitting tags or entities. */
export function splitTelegramHtml(message: string, max = TELEGRAM_MESSAGE_LIMIT): string[] {
	if (message.length <= max) return [message];
	const chunks: string[] = [];
	const tokens = tokenize(message);
	const stack: OpenTag[] = [];
	let out = "";
	let chunkHasBody = false;

	const closersFor = (s: OpenTag[]): string =>
		s
			.map(t => `</${t.name}>`)
			.reverse()
			.join("");
	const openersFor = (s: OpenTag[]): string => s.map(t => t.tag).join("");
	const minimumChunkLengthFor = (s: OpenTag[]): number => openersFor(s).length + closersFor(s).length + 1;
	const flush = (): void => {
		if (!chunkHasBody) return;
		chunks.push(out + closersFor(stack));
		out = openersFor(stack);
		chunkHasBody = false;
	};

	const updateStackForClose = (name: string): boolean => {
		const idx = stack.findLastIndex(t => t.name === name);
		if (idx === -1) return false;
		stack.splice(idx, 1);
		return true;
	};

	for (const token of tokens) {
		if (token.open) {
			const nextStack = [...stack, { name: token.open, tag: token.openTag ?? token.value }];
			if (minimumChunkLengthFor(nextStack) > max) continue;
			if (chunkHasBody && out.length + token.value.length + closersFor(nextStack).length > max) flush();
			if (out.length + token.value.length + closersFor(nextStack).length > max) continue;
			out += token.value;
			chunkHasBody = true;
			stack.push({ name: token.open, tag: token.openTag ?? token.value });
			continue;
		}

		if (token.close) {
			const idx = stack.findLastIndex(t => t.name === token.close);
			if (idx === -1) continue;
			const nextStack = stack.toSpliced(idx, 1);
			if (chunkHasBody && out.length + token.value.length + closersFor(nextStack).length > max) flush();
			if (out.length + token.value.length + closersFor(nextStack).length > max) {
				updateStackForClose(token.close);
				continue;
			}
			out += token.value;
			chunkHasBody = true;
			updateStackForClose(token.close);
			continue;
		}

		if (chunkHasBody && out.length + token.value.length + closersFor(stack).length > max) flush();
		out += token.value;
		chunkHasBody = true;
	}
	if (chunkHasBody) chunks.push(out + closersFor(stack));
	return chunks;
}

/** Finalize an optional message: undefined passthrough, else safe-truncate. */
export function finalizeTelegramHtml(message?: string): string | undefined {
	if (message === undefined) return undefined;
	return truncateTelegramHtml(message);
}

/**
 * One-based, plain-text button label (Telegram does not parse HTML in labels).
 *
 * Strips any leading `N.`/`N)` index already embedded in the label (e.g.
 * deep-interview options pre-numbered by the ask tool) and applies the canonical
 * one-based button index instead. This avoids duplicated numbering like
 * `1. 1. …` and keeps the displayed number aligned with the button's real index.
 */
export function buttonLabel(label: string, index: number): string {
	const stripped = label.replace(/^\s*\d+[.)]\s+/, "");
	return `${index + 1}. ${stripped}`;
}

/** Numbered, escaped option list for the Telegram message body. */
export function numberedOptionList(labels: string[]): string {
	return labels.map((label, i) => `${i + 1}. ${escapeHtml(label.replace(/^\s*\d+[.)]\s+/, ""))}`).join("\n");
}

/** Compact numeric button label; full option text belongs in the message body. */
export function choiceButtonLabel(index: number): string {
	return String(index + 1);
}

export interface InlineButton {
	text: string;
	callback_data: string;
}

const COMPACT_BUTTONS_PER_ROW = 5;

/** A prefixed button label is "long" when it is wide or contains a newline. */
function isLongLabel(label: string): boolean {
	return label.length > 18 || /[\r\n]/.test(label);
}

/**
 * Lay out option callbacks as compact numeric buttons. Telegram mobile clients
 * ellipsize long inline-keyboard labels and tall keyboards can be obscured by
 * the composer, so the full choice text is rendered in the message body while
 * the keyboard keeps only stable one-based tap targets.
 */
export function buildCompactChoiceGrid(
	labels: string[],
	callbackForIndex: (index: number) => string,
): InlineButton[][] {
	const rows: InlineButton[][] = [];
	let run: InlineButton[] = [];
	const flush = () => {
		if (run.length) {
			rows.push(run);
			run = [];
		}
	};
	labels.forEach((_label, i) => {
		run.push({ text: choiceButtonLabel(i), callback_data: callbackForIndex(i) });
		if (run.length === COMPACT_BUTTONS_PER_ROW) flush();
	});
	flush();
	return rows;
}

/**
 * Lay out option labels as a numbered button grid. Long buttons take a
 * full-width row; runs of short buttons are packed into rows of up to 3. The
 * callback value comes from `callbackForIndex(i)` using the original zero-based
 * option index — layout never changes callback semantics.
 */
export function buildButtonGrid(labels: string[], callbackForIndex: (index: number) => string): InlineButton[][] {
	const rows: InlineButton[][] = [];
	let run: InlineButton[] = [];
	const flush = () => {
		if (run.length) {
			rows.push(run);
			run = [];
		}
	};
	labels.forEach((label, i) => {
		const button: InlineButton = { text: buttonLabel(label, i), callback_data: callbackForIndex(i) };
		if (isLongLabel(button.text)) {
			flush();
			rows.push([button]);
			return;
		}
		run.push(button);
		if (run.length === 3) flush();
	});
	flush();
	return rows;
}
