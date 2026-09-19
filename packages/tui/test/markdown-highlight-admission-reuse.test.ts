import { expect, test } from "bun:test";
import { highlightCode } from "@gajae-code/natives";
import { __markdownPerfCounters, clearRenderCache, Markdown } from "../src/components/markdown";
import { defaultMarkdownTheme } from "./test-themes";

test("cached native highlights do not repeat UTF-8 and line admission scans", () => {
	clearRenderCache();
	const theme = {
		...defaultMarkdownTheme,
		highlightCode: (code: string, lang?: string) =>
			highlightCode(code, lang, {
				comment: "",
				keyword: "",
				function: "",
				variable: "",
				string: "",
				number: "",
				type: "",
				operator: "",
				punctuation: "",
			}).split("\n"),
	};
	const code = "const 한글 = 42;\n".repeat(500);
	const markdown = new Markdown(`\`\`\`typescript\n${code}\`\`\`\nfirst`, 0, 0, theme);
	markdown.render(80);
	__markdownPerfCounters.reset();
	markdown.setText(`\`\`\`typescript\n${code}\`\`\`\nsecond`);
	const warm = markdown.render(80);
	expect(__markdownPerfCounters.highlightAdmissionScans).toBe(0);
	clearRenderCache();
	markdown.invalidate();
	expect(markdown.render(80)).toEqual(warm);
	expect(__markdownPerfCounters.highlightAdmissionScans).toBeGreaterThan(0);
});
