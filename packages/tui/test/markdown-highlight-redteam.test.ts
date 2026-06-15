import { beforeEach, describe, expect, it } from "bun:test";
import {
	clearRenderCache,
	getMarkdownHighlightCallCount,
	Markdown,
	type MarkdownTheme,
	resetMarkdownHighlightCallCount,
} from "@gajae-code/tui";
import { defaultMarkdownTheme } from "./test-themes";

type HighlightCall = { code: string; lang: string | undefined };

function makeSpyTheme(prefix: string): MarkdownTheme & { calls: HighlightCall[] } {
	const calls: HighlightCall[] = [];
	return {
		...defaultMarkdownTheme,
		highlightCode: (code: string, lang?: string): string[] => {
			calls.push({ code, lang });
			return code.split("\n").map(line => `${prefix}:${lang ?? "none"}:${line}`);
		},
		calls,
	};
}

function render(markdown: string, theme: MarkdownTheme, width = 160): string[] {
	return new Markdown(markdown, 0, 0, theme).render(width);
}

function joined(markdown: string, theme: MarkdownTheme, width = 160): string {
	return render(markdown, theme, width).join("\n");
}

function linesOf(count: number, fill: (index: number) => string): string {
	return Array.from({ length: count }, (_value, index) => fill(index)).join("\n");
}

describe("markdown highlight cache + cap red-team", () => {
	beforeEach(() => {
		clearRenderCache();
		resetMarkdownHighlightCallCount();
	});

	it("keeps normal code-block output byte-identical across cache states and fresh theme objects", () => {
		const markdown = [
			"Intro",
			"```ts",
			"const tricky = `literal with backticks`;",
			"console.log('unicode π 🚀');",
			"```",
			"```",
			"plain fence with empty lang and ``` inside text",
			"ansi-like \\x1b[31m not terminal escape",
			"```",
			"```sh",
			"printf '%s\\n' \"nested `tick` and café\"",
			"```",
		].join("\n");

		const themeA = makeSpyTheme("HL");
		const first = render(markdown, themeA);
		expect(getMarkdownHighlightCallCount()).toBe(3);

		clearRenderCache();
		resetMarkdownHighlightCallCount();
		const themeAAgain = makeSpyTheme("HL");
		const second = render(markdown, themeAAgain);
		expect(getMarkdownHighlightCallCount()).toBe(3);
		expect(second).toEqual(first);

		const freshTheme = makeSpyTheme("HL");
		const freshThemeLines = render(markdown, freshTheme);
		expect(getMarkdownHighlightCallCount()).toBe(6);
		expect(freshThemeLines.filter(line => line.includes("HL:"))).toEqual(first.filter(line => line.includes("HL:")));
	});

	it("highlights the exact 2000-line boundary and skips 2001 lines with the marker", () => {
		const theme = makeSpyTheme("LINE");
		const exactly2000 = `\`\`\`ts\n${linesOf(2000, index => `line-${index}`)}\n\`\`\``;
		const atBoundary = joined(exactly2000, theme, 240);
		expect(getMarkdownHighlightCallCount()).toBe(1);
		expect(atBoundary).toContain("LINE:ts:line-0");
		expect(atBoundary).toContain("LINE:ts:line-1999");
		expect(atBoundary).not.toContain("syntax highlighting skipped");

		resetMarkdownHighlightCallCount();
		const over2000 = `\`\`\`ts\n${linesOf(2001, index => `line-${index}`)}\n\`\`\``;
		const overBoundary = joined(over2000, theme, 240);
		expect(getMarkdownHighlightCallCount()).toBe(0);
		expect(overBoundary).toContain("[syntax highlighting skipped: code block too large]");
		expect(overBoundary).toContain("line-0");
		expect(overBoundary).toContain("line-2000");
		expect(overBoundary).not.toContain("LINE:ts:line-2000");
	});

	it("highlights below the byte cap and skips above the byte cap", () => {
		const theme = makeSpyTheme("BYTE");
		const belowByteCap = `\`\`\`txt\n${"a".repeat(199_000)}\n\`\`\``;
		const below = joined(belowByteCap, theme, 250_000);
		expect(getMarkdownHighlightCallCount()).toBe(1);
		expect(below).toContain(`BYTE:txt:${"a".repeat(64)}`);
		expect(below).not.toContain("syntax highlighting skipped");

		resetMarkdownHighlightCallCount();
		const aboveByteCap = `\`\`\`txt\n${"b".repeat(201_000)}\n\`\`\``;
		const above = joined(aboveByteCap, theme, 250_000);
		expect(getMarkdownHighlightCallCount()).toBe(0);
		expect(above).toContain("[syntax highlighting skipped: code block too large]");
		expect(above).toContain("b".repeat(64));
		expect(above).not.toContain(`BYTE:txt:${"b".repeat(64)}`);
	});

	it("only highlights an appended sixth block after a cached five-block prefix", () => {
		const theme = makeSpyTheme("APPEND");
		const base = Array.from({ length: 5 }, (_value, index) => `\`\`\`lang${index}\nblock-${index}\n\`\`\``).join(
			"\n\n",
		);

		render(base, theme);
		expect(getMarkdownHighlightCallCount()).toBe(5);

		const grown = `${base}\n\n\`\`\`lang5\nblock-5\n\`\`\``;
		render(grown, theme);
		expect(getMarkdownHighlightCallCount()).toBe(6);
		expect(theme.calls.map(call => call.lang)).toEqual(["lang0", "lang1", "lang2", "lang3", "lang4", "lang5"]);
	});

	it("uses changed theme highlight output after clearing render caches", () => {
		const markdown = "```ts\nconst theme = 'must invalidate';\n```";
		const themeA = makeSpyTheme("THEME-A");
		expect(joined(markdown, themeA)).toContain("THEME-A:ts:const theme = 'must invalidate';");

		clearRenderCache();
		resetMarkdownHighlightCallCount();
		const themeB = makeSpyTheme("THEME-B");
		const renderedWithB = joined(markdown, themeB);
		expect(getMarkdownHighlightCallCount()).toBe(1);
		expect(renderedWithB).toContain("THEME-B:ts:const theme = 'must invalidate';");
		expect(renderedWithB).not.toContain("THEME-A:ts:const theme = 'must invalidate';");
	});

	it("applies cache and cap behavior to code blocks nested in list items", () => {
		const theme = makeSpyTheme("LIST");
		const nestedNormal = ["- item with code", "", "  ```ts", "  const nested = true;", "  ```"].join("\n");

		const first = joined(nestedNormal, theme);
		const afterFirst = getMarkdownHighlightCallCount();
		const second = joined(nestedNormal, theme);
		expect(afterFirst).toBe(1);
		expect(getMarkdownHighlightCallCount()).toBe(1);
		expect(second).toBe(first);
		expect(second).toContain("LIST:ts:const nested = true;");

		resetMarkdownHighlightCallCount();
		const nestedHuge = [
			"- item with oversized code",
			"",
			"  ```ts",
			linesOf(2001, index => `  nested-${index}`),
			"  ```",
		].join("\n");
		const huge = joined(nestedHuge, theme, 240);
		expect(getMarkdownHighlightCallCount()).toBe(0);
		expect(huge).toContain("[syntax highlighting skipped: code block too large]");
		expect(huge).toContain("nested-2000");
	});
});
