import { Marked, type Token, type Tokens } from "marked";

export type RichEligibility = { kind: "eligible" } | { kind: "ineligible" };

type MathToken = Token & { type: "btw_math"; expression: string };

const MAX_SCALARS = 32_768;
const MAX_UTF8_BYTES = 131_072;
const MAX_BLOCKS = 500;
const MAX_DEPTH = 16;
const MAX_TABLE_COLUMNS = 20;
function exceedsScalarLimit(source: string): boolean {
	let count = 0;
	for (const _scalar of source) {
		count++;
		if (count > MAX_SCALARS) return true;
	}
	return false;
}

function isEscaped(source: string, index: number): boolean {
	let escapes = 0;
	for (let cursor = index - 1; cursor >= 0 && source[cursor] === "\\"; cursor--) escapes++;
	return escapes % 2 === 1;
}
function isPlainTextSafe(source: string): boolean {
	for (let index = 0; index < source.length; index++) {
		if (
			!isEscaped(source, index) &&
			(source[index] === "*" ||
				source[index] === "_" ||
				source[index] === "~" ||
				source[index] === "`" ||
				source[index] === "[" ||
				source[index] === "]" ||
				source[index] === "<" ||
				source[index] === ">")
		)
			return false;
	}
	return true;
}

function hasLoneSurrogate(source: string): boolean {
	for (let index = 0; index < source.length; index++) {
		const code = source.charCodeAt(index);
		if (code >= 0xd800 && code <= 0xdbff) {
			if (
				index + 1 >= source.length ||
				source.charCodeAt(index + 1) < 0xdc00 ||
				source.charCodeAt(index + 1) > 0xdfff
			)
				return true;
			index++;
		} else if (code >= 0xdc00 && code <= 0xdfff) {
			return true;
		}
	}
	return false;
}

function hasUnescapedDollar(source: string): boolean {
	for (let cursor = 0; cursor < source.length; cursor++) {
		if (source[cursor] === "$" && !isEscaped(source, cursor)) return true;
	}
	return false;
}

function isValidMathExpression(expression: string, multiline: boolean): boolean {
	return (
		expression.trim().length > 0 &&
		(multiline || !expression.includes("\n")) &&
		!expression.startsWith(" ") &&
		!expression.endsWith(" ") &&
		!hasUnescapedDollar(expression) &&
		!expression.includes("\\(") &&
		!expression.includes("\\)") &&
		!expression.includes("\\[") &&
		!expression.includes("\\]")
	);
}

function validateInlineMath(source: string): boolean {
	for (let cursor = 0; cursor < source.length; cursor++) {
		if (source[cursor] === "$" && !isEscaped(source, cursor)) {
			if (source[cursor + 1] === "$") return false;
			let closing = cursor + 1;
			while (closing < source.length && (source[closing] !== "$" || isEscaped(source, closing))) closing++;
			if (closing === source.length || !isValidMathExpression(source.slice(cursor + 1, closing), false))
				return false;
			cursor = closing;
			continue;
		}
		if (source.startsWith("\\(", cursor) && !isEscaped(source, cursor)) {
			let closing = cursor + 2;
			while (closing < source.length && (!source.startsWith("\\)", closing) || isEscaped(source, closing)))
				closing++;
			if (closing === source.length || !isValidMathExpression(source.slice(cursor + 2, closing), false))
				return false;
			cursor = closing + 1;
			continue;
		}
		if (source.startsWith("\\)", cursor) && !isEscaped(source, cursor)) return false;
		if ((source.startsWith("\\[", cursor) || source.startsWith("\\]", cursor)) && !isEscaped(source, cursor))
			return false;
	}
	return true;
}

function parseDisplayMath(source: string): boolean {
	const block = source.trim();
	const delimiter =
		block.startsWith("$$") && block.endsWith("$$")
			? "$$"
			: block.startsWith("\\[") && block.endsWith("\\]")
				? "\\["
				: undefined;
	if (delimiter === undefined) return false;
	const closing = delimiter === "$$" ? "$$" : "\\]";
	return (
		!isEscaped(block, block.length - closing.length) &&
		isValidMathExpression(block.slice(delimiter.length, -closing.length).trim(), true)
	);
}

const marked = new Marked({
	async: false,
	breaks: false,
	gfm: true,
	pedantic: false,
	silent: false,
	extensions: [
		{
			name: "btw_math",
			level: "inline",
			start(src) {
				const dollar = src.indexOf("$");
				const parenthesized = src.indexOf("\\(");
				if (dollar < 0) return parenthesized;
				if (parenthesized < 0) return dollar;
				return Math.min(dollar, parenthesized);
			},
			tokenizer(src) {
				if (src.startsWith("$") && !src.startsWith("$$")) {
					let closing = 1;
					while (closing < src.length && (src[closing] !== "$" || isEscaped(src, closing))) closing++;
					const expression = src.slice(1, closing);
					if (closing < src.length && isValidMathExpression(expression, false))
						return { type: "btw_math", raw: src.slice(0, closing + 1), expression };
				}
				if (src.startsWith("\\(")) {
					let closing = 2;
					while (closing < src.length && (!src.startsWith("\\)", closing) || isEscaped(src, closing))) closing++;
					const expression = src.slice(2, closing);
					if (closing < src.length && isValidMathExpression(expression, false))
						return { type: "btw_math", raw: src.slice(0, closing + 2), expression };
				}
				return undefined;
			},
		},
	],
});

function recognizeText(tokens: Token[], depth: number): boolean {
	if (depth > MAX_DEPTH) return false;
	for (const token of tokens) {
		switch (token.type) {
			case "btw_math":
				if (depth > 2 || !isValidMathExpression((token as MathToken).expression, false)) return false;
				break;
			case "text":
				if (!isPlainTextSafe(token.raw)) return false;
				break;
			case "escape":
			case "br":
			case "codespan":
				break;
			case "strong":
			case "em":
			case "del":
				if (token.tokens === undefined || !recognizeText(token.tokens, depth + 1)) return false;
				break;
			default:
				return false;
		}
	}
	return true;
}

function recognizeTable(token: Tokens.Table, count: { value: number }): boolean {
	const columns = token.header.length;
	if (
		columns < 1 ||
		columns > MAX_TABLE_COLUMNS ||
		token.align.length !== columns ||
		token.rows.some(row => row.length !== columns) ||
		token.align.some(align => align !== "left" && align !== "center" && align !== "right" && align !== null)
	)
		return false;
	for (const row of [token.header, ...token.rows]) {
		for (const cell of row) {
			if (!validateInlineMath(cell.text) || !recognizeText(cell.tokens, 0)) return false;
		}
	}
	count.value += 1 + token.rows.length + 1;
	return count.value <= MAX_BLOCKS;
}

/** Conservatively recognize `/btw` Markdown that can be represented as rich content. */
export function parseRichEligibility(markdown: string): RichEligibility {
	try {
		if (
			hasLoneSurrogate(markdown) ||
			exceedsScalarLimit(markdown) ||
			Buffer.byteLength(markdown, "utf8") > MAX_UTF8_BYTES ||
			markdown.includes("\u0000")
		)
			return { kind: "ineligible" };

		const tokens = marked.lexer(markdown);
		const count = { value: 0 };
		let structured = false;
		for (const token of tokens) {
			if (token.type === "space") continue;
			if (token.type === "heading") {
				if (
					token.tokens === undefined ||
					token.depth < 1 ||
					token.depth > 6 ||
					!validateInlineMath(token.text) ||
					!recognizeText(token.tokens, 0)
				)
					return { kind: "ineligible" };
				count.value++;
			} else if (token.type === "paragraph" || token.type === "text") {
				if (token.type === "paragraph" && parseDisplayMath(token.text)) {
					structured = true;
					count.value++;
				} else {
					const inline = token.type === "paragraph" ? token.tokens : [token];
					if (inline === undefined || !validateInlineMath(token.text) || !recognizeText(inline, 0))
						return { kind: "ineligible" };
					structured ||= inline.some(part => part.type === "btw_math");
					count.value++;
				}
			} else if (token.type === "table") {
				if (!recognizeTable(token as Tokens.Table, count)) return { kind: "ineligible" };
				structured = true;
			} else {
				return { kind: "ineligible" };
			}
			if (count.value > MAX_BLOCKS) return { kind: "ineligible" };
		}
		return structured ? { kind: "eligible" } : { kind: "ineligible" };
	} catch {
		return { kind: "ineligible" };
	}
}
