import { beforeEach, describe, expect, it } from "bun:test";
import {
	clearRenderCache,
	getMarkdownHighlightCallCount,
	Markdown,
	type MarkdownTheme,
	resetMarkdownHighlightCallCount,
} from "@gajae-code/tui";
import { defaultMarkdownTheme } from "./test-themes";

function themeWithHighlight(): MarkdownTheme {
	// A deterministic stand-in for the real Rust-FFI highlighter; the module-level
	// highlight-call counter increments once per actual (uncached) invocation.
	return { ...defaultMarkdownTheme, highlightCode: (code: string) => code.split("\n") };
}

describe("markdown streaming highlight caps + cache (W3 / F3, F18)", () => {
	beforeEach(() => {
		clearRenderCache();
		resetMarkdownHighlightCallCount();
	});

	it("does not re-highlight the unchanged prefix when a streamed message grows (F3)", () => {
		const theme = themeWithHighlight();
		const base = "```ts\nconst a = 1;\n```\n\n```js\nconst b = 2;\n```\n\n```py\nx = 3\n```";
		new Markdown(base, 1, 0, theme).render(80);
		const afterThree = getMarkdownHighlightCallCount();
		expect(afterThree).toBe(3);

		// Streaming append of a 4th code block (worst case: a fresh component instance).
		const grown = `${base}\n\n\`\`\`rb\ny = 4\n\`\`\``;
		new Markdown(grown, 1, 0, theme).render(80);
		const afterFour = getMarkdownHighlightCallCount();

		// Only the newly-appended block is highlighted; the prior three are served from cache.
		expect(afterFour - afterThree).toBe(1);
	});

	it("reuses the per-code-block highlight cache across separate component instances (F3)", () => {
		const theme = themeWithHighlight();
		const md = "```ts\nconst z = 9;\n```";
		new Markdown(md, 1, 0, theme).render(80);
		new Markdown(md, 1, 0, theme).render(80);
		expect(getMarkdownHighlightCallCount()).toBe(1);
	});

	it("skips synchronous highlight for oversized code blocks and marks them (F18)", () => {
		const theme = themeWithHighlight();
		const bigCode = Array.from({ length: 2500 }, (_v, i) => `line ${i}`).join("\n");
		const md = `\`\`\`ts\n${bigCode}\n\`\`\``;
		const lines = new Markdown(md, 1, 0, theme).render(120);

		expect(getMarkdownHighlightCallCount()).toBe(0); // FFI highlighter never called
		expect(lines.join("\n")).toContain("syntax highlighting skipped");
		// The code content is still rendered (plain), not dropped.
		expect(lines.join("\n")).toContain("line 0");
		expect(lines.join("\n")).toContain("line 2499");
	});

	it("still highlights normal-sized blocks (regression guard)", () => {
		const theme = themeWithHighlight();
		const md = "```ts\nconst ok = true;\n```";
		const lines = new Markdown(md, 1, 0, theme).render(80);
		expect(getMarkdownHighlightCallCount()).toBe(1);
		expect(lines.join("\n")).not.toContain("syntax highlighting skipped");
	});

	it("caps highlight by UTF-8 byte length, not UTF-16 code units (F18 non-ASCII)", () => {
		const theme = themeWithHighlight();
		// 70k CJK code points on one line: 70k code units (< 200k) but ~210k UTF-8 bytes (> 200k).
		const cjk = "中".repeat(70_000);
		expect(cjk.length).toBeLessThan(200_000);
		expect(Buffer.byteLength(cjk, "utf8")).toBeGreaterThan(200_000);
		const md = `\`\`\`ts\n${cjk}\n\`\`\``;
		const lines = new Markdown(md, 1, 0, theme).render(120);
		expect(getMarkdownHighlightCallCount()).toBe(0); // byte cap trips → FFI skipped
		expect(lines.join("\n")).toContain("syntax highlighting skipped");
	});
});
