import type { AgentTool, AgentToolResult } from "@gajae-code/agent-core";
import type { Component } from "@gajae-code/tui";
import { Text } from "@gajae-code/tui";
import { prompt, untilAborted } from "@gajae-code/utils";
import * as z from "zod/v4";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import type { Theme } from "../modes/theme/theme";
import calculatorDescription from "../prompts/tools/calculator.md" with { type: "text" };
import { Ellipsis, Hasher, type RenderCache, renderStatusLine, renderTreeList, truncateToWidth } from "../tui";
import type { ToolSession } from ".";
import { formatCount, formatEmptyMessage, formatErrorMessage, PREVIEW_LIMITS, TRUNCATE_LENGTHS } from "./render-utils";

// =============================================================================
// Token Types
// =============================================================================

/** Supported arithmetic operators (** is exponentiation). */
type Operator = "+" | "-" | "*" | "/" | "%" | "**";

/**
 * Lexer token variants:
 * - number: parsed numeric value with original string for error messages
 * - operator: arithmetic operator
 * - paren: grouping parenthesis
 */
type Token =
	| { type: "number"; value: number; raw: string }
	| { type: "operator"; value: Operator }
	| { type: "paren"; value: "(" | ")" };

const calculatorSchema = z.object({
	calculations: z
		.array(
			z.object({
				expression: z.string().describe("math expression"),
				prefix: z.string().describe("prefix text"),
				suffix: z.string().describe("suffix text"),
			}),
		)
		.describe("calculations to evaluate"),
});

export interface CalculatorToolDetails {
	results: Array<{ expression: string; value: number; output: string }>;
}

// =============================================================================
// Character classification helpers for numeric literal parsing
// =============================================================================

function isDigit(ch: string): boolean {
	return ch >= "0" && ch <= "9";
}

function isHexDigit(ch: string): boolean {
	return (ch >= "0" && ch <= "9") || (ch >= "a" && ch <= "f") || (ch >= "A" && ch <= "F");
}

function isBinaryDigit(ch: string): boolean {
	return ch === "0" || ch === "1";
}

function isOctalDigit(ch: string): boolean {
	return ch >= "0" && ch <= "7";
}

// =============================================================================
// Tokenizer
// =============================================================================

/**
 * Tokenize a math expression into numbers, operators, and parentheses.
 *
 * Number formats supported:
 * - Decimal: 123, 3.14, .5
 * - Scientific: 1e10, 2.5E-3
 * - Hexadecimal: 0xFF
 * - Binary: 0b1010
 * - Octal: 0o755
 */
function tokenizeExpression(expression: string): Token[] {
	const tokens: Token[] = [];
	let i = 0;

	while (i < expression.length) {
		const ch = expression[i];

		// Skip whitespace
		if (ch.trim() === "") {
			i += 1;
			continue;
		}

		if (ch === "(" || ch === ")") {
			tokens.push({ type: "paren", value: ch });
			i += 1;
			continue;
		}

		// Check ** before single * to handle exponentiation
		if (ch === "*" && expression[i + 1] === "*") {
			tokens.push({ type: "operator", value: "**" });
			i += 2;
			continue;
		}

		if (ch === "+" || ch === "-" || ch === "*" || ch === "/" || ch === "%") {
			tokens.push({ type: "operator", value: ch });
			i += 1;
			continue;
		}

		// Number parsing: starts with digit or decimal point followed by digit
		const next = expression[i + 1];
		const numberStart = isDigit(ch) || (ch === "." && next !== undefined && isDigit(next));
		if (!numberStart) {
			throw new Error(`Invalid character "${ch}" in expression`);
		}

		const start = i;

		// Handle prefixed literals (0x, 0b, 0o)
		if (ch === "0" && next !== undefined) {
			const prefix = next.toLowerCase();
			if (prefix === "x" || prefix === "b" || prefix === "o") {
				i += 2; // Skip "0x" / "0b" / "0o"
				let hasDigit = false;
				while (i < expression.length) {
					const digit = expression[i];
					const valid =
						prefix === "x" ? isHexDigit(digit) : prefix === "b" ? isBinaryDigit(digit) : isOctalDigit(digit);
					if (!valid) break;
					hasDigit = true;
					i += 1;
				}

				if (!hasDigit) {
					throw new Error(`Invalid numeric literal starting at "${expression.slice(start, i)}"`);
				}

				const raw = expression.slice(start, i);
				const value = Number(raw); // JS Number() handles 0x/0b/0o natively
				if (!Number.isFinite(value)) {
					throw new Error(`Invalid number "${raw}"`);
				}
				tokens.push({ type: "number", value, raw });
				continue;
			}
		}

		// Parse decimal number: integer part
		let hasDigits = false;
		while (i < expression.length && isDigit(expression[i])) {
			hasDigits = true;
			i += 1;
		}

		// Fractional part
		if (expression[i] === ".") {
			i += 1;
			while (i < expression.length && isDigit(expression[i])) {
				hasDigits = true;
				i += 1;
			}
		}

		if (!hasDigits) {
			throw new Error(`Invalid number starting at "${expression.slice(start, i + 1)}"`);
		}

		// Scientific notation exponent (e.g., 1e10, 2.5E-3)
		if (expression[i] === "e" || expression[i] === "E") {
			i += 1;
			if (expression[i] === "+" || expression[i] === "-") {
				i += 1;
			}

			let hasExponentDigits = false;
			while (i < expression.length && isDigit(expression[i])) {
				hasExponentDigits = true;
				i += 1;
			}

			if (!hasExponentDigits) {
				throw new Error(`Invalid exponent in "${expression.slice(start, i)}"`);
			}
		}

		const raw = expression.slice(start, i);
		const value = Number(raw);
		if (!Number.isFinite(value)) {
			throw new Error(`Invalid number "${raw}"`);
		}
		tokens.push({ type: "number", value, raw });
	}

	return tokens;
}

// =============================================================================
// Recursive Descent Parser
// =============================================================================

/**
 * Recursive descent parser for arithmetic expressions.
 *
 * Operator precedence (lowest to highest):
 *   1. Addition, subtraction (+, -)
 *   2. Multiplication, division, modulo (*, /, %)
 *   3. Unary plus/minus (+x, -x)
 *   4. Exponentiation (**)
 *   5. Parentheses and literals
 *
 * Each precedence level has its own parse method. Lower precedence methods
 * call higher precedence methods, building the AST implicitly through
 * the call stack.
 */
class ExpressionParser {
	#index = 0;

	constructor(private readonly tokens: Token[]) {}

	/** Parse the full expression and ensure all tokens are consumed. */
	parse(): number {
		const value = this.#parseExpression();
		if (this.#index < this.tokens.length) {
			throw new Error("Unexpected token in expression");
		}
		return value;
	}

	/**
	 * Parse addition and subtraction (lowest precedence).
	 * Left-associative: 1 - 2 - 3 = (1 - 2) - 3
	 */
	#parseExpression(): number {
		let value = this.#parseTerm();
		while (true) {
			if (this.#matchOperator("+")) {
				value += this.#parseTerm();
				continue;
			}
			if (this.#matchOperator("-")) {
				value -= this.#parseTerm();
				continue;
			}
			break;
		}
		return value;
	}

	/**
	 * Parse multiplication, division, and modulo.
	 * Left-associative: 8 / 4 / 2 = (8 / 4) / 2
	 */
	#parseTerm(): number {
		let value = this.#parseUnary();
		while (true) {
			if (this.#matchOperator("*")) {
				value *= this.#parseUnary();
				continue;
			}
			if (this.#matchOperator("/")) {
				value /= this.#parseUnary();
				continue;
			}
			if (this.#matchOperator("%")) {
				value %= this.#parseUnary();
				continue;
			}
			break;
		}
		return value;
	}

	/**
	 * Parse unary + and - operators.
	 * Recursive to handle chained unary: --x, +-x
	 */
	#parseUnary(): number {
		if (this.#matchOperator("+")) {
			return this.#parseUnary();
		}
		if (this.#matchOperator("-")) {
			return -this.#parseUnary();
		}
		return this.#parsePower();
	}

	/**
	 * Parse exponentiation operator.
	 * Right-associative: 2 ** 3 ** 2 = 2 ** (3 ** 2) = 512
	 * The right operand accepts a unary sign, so negative exponents like
	 * 2 ** -3 evaluate instead of failing as an unexpected token; recursion
	 * through #parseUnary back into #parsePower keeps ** right-associative.
	 */
	#parsePower(): number {
		let value = this.#parsePrimary();
		if (this.#matchOperator("**")) {
			value = value ** this.#parseUnary(); // Right-associative via recursion
		}
		return value;
	}

	/**
	 * Parse primary expressions: number literals and parenthesized subexpressions.
	 * Parentheses restart parsing at lowest precedence (parseExpression).
	 */
	#parsePrimary(): number {
		const token = this.#peek();
		if (!token) {
			throw new Error("Unexpected end of expression");
		}

		if (token.type === "number") {
			this.#index += 1;
			return token.value;
		}

		if (token.type === "paren" && token.value === "(") {
			this.#index += 1;
			const value = this.#parseExpression(); // Reset to lowest precedence
			if (!this.#matchParen(")")) {
				throw new Error("Missing closing parenthesis");
			}
			return value;
		}

		throw new Error("Unexpected token in expression");
	}

	/** Consume operator if it matches, advancing the token index. */
	#matchOperator(value: Operator): boolean {
		const token = this.tokens[this.#index];
		if (token && token.type === "operator" && token.value === value) {
			this.#index += 1;
			return true;
		}
		return false;
	}

	/** Consume parenthesis if it matches, advancing the token index. */
	#matchParen(value: "(" | ")"): boolean {
		const token = this.tokens[this.#index];
		if (token && token.type === "paren" && token.value === value) {
			this.#index += 1;
			return true;
		}
		return false;
	}

	/** Look at current token without consuming it. */
	#peek(): Token | undefined {
		return this.tokens[this.#index];
	}
}

// =============================================================================
// Expression Evaluator
// =============================================================================

/**
 * Evaluate a math expression string and return the numeric result.
 *
 * Pipeline: expression string -> tokens -> parse tree (implicit) -> value
 *
 * @throws Error on syntax errors, empty expressions, or non-finite results (Infinity, NaN)
 */
function evaluateExpression(expression: string): number {
	const tokens = tokenizeExpression(expression);
	if (tokens.length === 0) {
		throw new Error("Expression is empty");
	}
	const parser = new ExpressionParser(tokens);
	const value = parser.parse();
	if (!Number.isFinite(value)) {
		throw new Error("Expression result is not a finite number");
	}
	// Normalize -0 to 0 for consistent output
	return Object.is(value, -0) ? 0 : value;
}

function formatResult(value: number): string {
	return String(value);
}

// ═══════════════════════════════════════════════════════════════════════════
// Tool Class
// ═══════════════════════════════════════════════════════════════════════════

type CalculatorParams = z.infer<typeof calculatorSchema>;

/**
 * Calculator tool for evaluating mathematical expressions.
 *
 * Supports decimal, hex (0x), binary (0b), octal (0o) literals,
 * standard arithmetic operators, and parentheses.
 */
export class CalculatorTool implements AgentTool<typeof calculatorSchema, CalculatorToolDetails> {
	readonly name = "calc";
	readonly label = "Calc";
	readonly summary = "Evaluate a mathematical expression";
	readonly loadMode = "discoverable";
	readonly description: string;
	readonly parameters = calculatorSchema;
	readonly strict = true;

	constructor(_session: ToolSession) {
		this.description = prompt.render(calculatorDescription);
	}

	async execute(
		_toolCallId: string,
		{ calculations }: CalculatorParams,
		signal?: AbortSignal,
	): Promise<AgentToolResult<CalculatorToolDetails>> {
		return untilAborted(signal, async () => {
			const results = calculations.map(calc => {
				const value = evaluateExpression(calc.expression);
				const output = `${calc.prefix}${formatResult(value)}${calc.suffix}`;
				return { expression: calc.expression, value, output };
			});

			const outputText = results.map(result => result.output).join("\n");
			return {
				content: [{ type: "text", text: outputText }],
				details: { results },
			};
		});
	}
}

// =============================================================================
// TUI Renderer
// =============================================================================

interface CalculatorRenderArgs {
	calculations?: Array<{ expression: string; prefix?: string; suffix?: string }>;
}

const COLLAPSED_LIST_LIMIT = PREVIEW_LIMITS.COLLAPSED_ITEMS;

/**
 * TUI renderer for calculator tool calls and results.
 * Handles both collapsed (preview) and expanded (full) display modes.
 */
export const calculatorToolRenderer = {
	/**
	 * Render the tool call header showing the first expression and count.
	 * Format: "Calc <expression> (N calcs)"
	 */
	renderCall(args: CalculatorRenderArgs, _options: RenderResultOptions, uiTheme: Theme): Component {
		const count = args.calculations?.length ?? 0;
		const firstExpression = args.calculations?.[0]?.expression;
		const description = firstExpression ? truncateToWidth(firstExpression, TRUNCATE_LENGTHS.TITLE) : undefined;
		const meta = count > 0 ? [formatCount("calc", count)] : [];
		const text = renderStatusLine({ icon: "pending", title: "Calc", description, meta }, uiTheme);
		return new Text(text, 0, 0);
	},

	/**
	 * Render calculation results as a tree list.
	 * Collapsed mode shows first N items with expand hint; expanded shows all.
	 */
	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: CalculatorToolDetails; isError?: boolean },
		options: RenderResultOptions,
		uiTheme: Theme,
		args?: CalculatorRenderArgs,
	): Component {
		const details = result.details;
		const textContent = result.content?.find(c => c.type === "text")?.text ?? "";
		if (result.isError) {
			const header = renderStatusLine({ icon: "error", title: "Calc" }, uiTheme);
			const renderedLines = [header, formatErrorMessage(textContent, uiTheme)];
			return {
				render() {
					return renderedLines;
				},
				invalidate() {},
			};
		}

		// Prefer structured details; fall back to parsing text content
		let outputs = details?.results?.map(entry => `${entry.expression} = ${entry.output}`) ?? [];
		if (outputs.length === 0 && textContent.trim()) {
			const rawOutputs = textContent.split("\n").filter(line => line.trim().length > 0);
			const expressions = args?.calculations?.map(calc => calc.expression) ?? [];
			if (expressions.length === rawOutputs.length && expressions.length > 0) {
				outputs = rawOutputs.map((output, index) => `${expressions[index]} = ${output}`);
			} else {
				outputs = rawOutputs;
			}
		}

		if (outputs.length === 0) {
			const header = renderStatusLine({ icon: "warning", title: "Calc" }, uiTheme);
			const renderedLines = [header, formatEmptyMessage("No results", uiTheme)];
			return {
				render() {
					return renderedLines;
				},
				invalidate() {},
			};
		}

		const description = args?.calculations?.[0]?.expression
			? truncateToWidth(args.calculations[0].expression, TRUNCATE_LENGTHS.TITLE)
			: undefined;
		const header = renderStatusLine(
			{ icon: "success", title: "Calc", description, meta: [formatCount("result", outputs.length)] },
			uiTheme,
		);

		let cached: RenderCache | undefined;

		return {
			render(width) {
				const { expanded } = options;
				const key = new Hasher().bool(expanded).u32(width).digest();
				if (cached?.key === key) return cached.lines;
				const treeLines = renderTreeList(
					{
						items: outputs,
						expanded,
						maxCollapsed: COLLAPSED_LIST_LIMIT,
						itemType: "result",
						renderItem: output => uiTheme.fg("toolOutput", output),
					},
					uiTheme,
				);
				const lines = [header, ...treeLines].map(l => truncateToWidth(l, width, Ellipsis.Omit));
				cached = { key, lines };
				return lines;
			},
			invalidate() {
				cached = undefined;
			},
		};
	},
	mergeCallAndResult: true,
};
