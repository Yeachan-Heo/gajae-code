import { describe, expect, it, vi } from "bun:test";
import { marked, type Token, Tokenizer } from "marked";
import { clearRenderCache, Markdown } from "../src/components/markdown.js";
import { defaultMarkdownTheme } from "./test-themes.js";

const HEADING_MARK = "<<heading>>";

/** How many lines the component styles as a heading when it renders `source`. */
function renderedHeadingCount(source: string): number {
	const theme = { ...defaultMarkdownTheme, heading: (text: string) => `${HEADING_MARK}${text}` };
	clearRenderCache();
	const md = new Markdown(source, 0, 0, theme);
	const rendered = md.render(200);
	md.dispose();
	return rendered.filter(line => line.includes(HEADING_MARK)).length;
}

const rendersHeading = (source: string): boolean => renderedHeadingCount(source) > 0;

/**
 * Stock marked, without the component's tokenizer overrides, as the oracle.
 * List items are not descended into: the component renders them inline, so a
 * heading inside one is never styled, with or without the setext rule.
 */
function stockHeadingCount(tokens: readonly Token[]): number {
	let count = 0;
	for (const token of tokens) {
		if (token.type === "heading") count += 1;
		else if (token.type !== "list" && "tokens" in token && Array.isArray(token.tokens))
			count += stockHeadingCount(token.tokens);
	}
	return count;
}

describe("Markdown setext headings", () => {
	it("still recognizes every setext heading shape", () => {
		for (const source of [
			"Title\n=====",
			"Title\n---",
			"Title\n-",
			"Title\n   ---   ",
			"Title\n===\n",
			"line one\nline two\n===\n\nbody",
			"Title\n=\nnext paragraph",
			"first paragraph\n\nTitle\n===",
			"first paragraph\n \nTitle\n---\n\nlast paragraph",
		]) {
			expect({ source, heading: rendersHeading(source) }).toEqual({ source, heading: true });
		}
	});

	it("does not turn a paragraph without an underline into a heading", () => {
		for (const source of [
			"Title\n\n===",
			"Title\n \n===",
			"Title\n    ===",
			"Title\n=== x",
			"Title\n=-=",
			"Title ===",
			"Title\nplain second line",
		]) {
			expect({ source, heading: rendersHeading(source) }).toEqual({ source, heading: false });
		}
	});

	it("agrees with stock marked on how many headings every short line combination has", () => {
		const lines = [
			"Title",
			"two words",
			"",
			" ",
			"===",
			"---",
			"   --- ",
			"    ---",
			"--- x",
			"=",
			"- item",
			"- ",
			"-",
			"1. item",
			"* * *",
			"***",
			"> quote",
			"# atx",
			"#tag",
			"```",
			"~~~",
			"| a | b |",
			"|---|---|",
			"<div>",
			"<!-- note -->",
		];
		const sources: string[] = [];
		for (const first of lines) {
			sources.push(first);
			for (const second of lines) {
				sources.push(`${first}\n${second}`);
				for (const third of lines) sources.push(`${first}\n${second}\n${third}`);
			}
		}
		const disagreements = sources.filter(
			source => renderedHeadingCount(source) !== stockHeadingCount(marked.lexer(source)),
		);
		expect(disagreements).toEqual([]);
	}, 30_000);

	it("skips the stock setext rule for a paragraph that has no underline line", () => {
		const stock = vi.spyOn(Tokenizer.prototype, "lheading");
		try {
			// 334 hard-wrapped lines, no blank line; ends with a newline.
			const paragraph = "word word word word word word word word word word word word\n".repeat(334);
			clearRenderCache();
			const plain = new Markdown(paragraph, 0, 0, defaultMarkdownTheme);
			plain.render(80);
			plain.dispose();
			expect(stock).not.toHaveBeenCalled();

			// The rule still runs, once, for the paragraph that can be a heading.
			expect(rendersHeading(`${paragraph}===\n\nbody`)).toBe(true);
			expect(stock).toHaveBeenCalledTimes(1);

			// Paragraphs broken by headings rather than blank lines are each checked
			// up to the heading, so the underline at the end of the message does not
			// send every one of them to the stock rule.
			stock.mockClear();
			expect(renderedHeadingCount(`${"# heading\nword word word\n".repeat(50)}# end\n===\n`)).toBe(51);
			expect(stock).not.toHaveBeenCalled();

			// The same holds for the rule's other stops. Only the last paragraph,
			// the one with the underline, reaches the stock rule.
			for (const separator of ["\n", "* * *\n", "<!-- note -->\n", "```\ncode\n```\n"]) {
				stock.mockClear();
				const source = `${`word word word\n${separator}`.repeat(50)}end\n===\n`;
				expect({ separator, headings: renderedHeadingCount(source) }).toEqual({ separator, headings: 1 });
				expect(stock).toHaveBeenCalledTimes(1);
			}

			// Indented code and a table delimiter row stop the rule as well. Neither
			// message has a heading, so the stock rule is not needed at all.
			for (const separator of ["    code\n", "|---|---|\n"]) {
				stock.mockClear();
				const source = `${`word word word\n${separator}`.repeat(50)}end\n===\n`;
				expect({ separator, headings: renderedHeadingCount(source) }).toEqual({ separator, headings: 0 });
				expect(stock).not.toHaveBeenCalled();
			}

			// A run of setext headings costs one stock call per heading.
			stock.mockClear();
			expect(renderedHeadingCount("Title\n-----\n".repeat(50))).toBe(50);
			expect(stock).toHaveBeenCalledTimes(50);
		} finally {
			stock.mockRestore();
		}
	});
});
