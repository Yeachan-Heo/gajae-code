import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { Terminal as XtermTerminalType } from "@xterm/headless";
import { Chalk } from "chalk";
import { clearRenderCache, Markdown, renderInlineMarkdown } from "../src/components/markdown.js";
import { TERMINAL } from "../src/terminal-capabilities.js";
import { type Component, TUI } from "../src/tui.js";
import { defaultMarkdownTheme } from "./test-themes.js";
import { VirtualTerminal } from "./virtual-terminal.js";

// Force full color in CI so ANSI assertions are deterministic
const chalk = new Chalk({ level: 3 });

function getCellItalic(terminal: VirtualTerminal, row: number, col: number): number {
	const xterm = (terminal as unknown as { xterm: XtermTerminalType }).xterm;
	const buffer = xterm.buffer.active;
	const line = buffer.getLine(buffer.viewportY + row);
	expect(line, `Missing buffer line at row ${row}`).toBeTruthy();
	const cell = line!.getCell(col);
	expect(cell, `Missing cell at row ${row} col ${col}`).toBeTruthy();
	return cell!.isItalic();
}

describe("renderInlineMarkdown", () => {
	it("preserves ordered list items as visible inline text", () => {
		const rendered = renderInlineMarkdown("1. Review against a base branch (PR Style)", defaultMarkdownTheme);
		const plain = rendered.replace(/\x1b\[[0-9;]*m/g, "");

		expect(plain).toBe("1. Review against a base branch (PR Style)");
	});

	it("returns empty string for undefined input (streaming guard)", () => {
		// During streaming, partial JSON can leave option label fields as undefined.
		// renderInlineMarkdown must not throw in that case.
		const rendered = renderInlineMarkdown(undefined as unknown as string, defaultMarkdownTheme);
		expect(rendered).toBe("");
	});

	it("applies baseColor to fallback for non-string input", () => {
		const rendered = renderInlineMarkdown(null as unknown as string, defaultMarkdownTheme, t => `[${t}]`);
		expect(rendered).toBe("[]");
	});
});

describe("Markdown component", () => {
	describe("Nested lists", () => {
		it("should render simple nested list", () => {
			const markdown = new Markdown(
				`- Item 1
  - Nested 1.1
  - Nested 1.2
- Item 2`,
				0,
				0,
				defaultMarkdownTheme,
			);

			const lines = markdown.render(80);

			// Check that we have content
			expect(lines.length > 0).toBeTruthy();

			// Strip ANSI codes for checking
			const plainLines = lines.map(line => line.replace(/\x1b\[[0-9;]*m/g, ""));

			// Check structure
			expect(plainLines.some(line => line.includes("- Item 1"))).toBeTruthy();
			expect(plainLines.some(line => line.includes("  - Nested 1.1"))).toBeTruthy();
			expect(plainLines.some(line => line.includes("  - Nested 1.2"))).toBeTruthy();
			expect(plainLines.some(line => line.includes("- Item 2"))).toBeTruthy();
		});

		it("should render deeply nested list", () => {
			const markdown = new Markdown(
				`- Level 1
  - Level 2
    - Level 3
      - Level 4`,
				0,
				0,
				defaultMarkdownTheme,
			);

			const lines = markdown.render(80);
			const plainLines = lines.map(line => line.replace(/\x1b\[[0-9;]*m/g, ""));

			// Check proper indentation
			expect(plainLines.some(line => line.includes("- Level 1"))).toBeTruthy();
			expect(plainLines.some(line => line.includes("  - Level 2"))).toBeTruthy();
			expect(plainLines.some(line => line.includes("    - Level 3"))).toBeTruthy();
			expect(plainLines.some(line => line.includes("      - Level 4"))).toBeTruthy();
		});

		it("should render ordered nested list", () => {
			const markdown = new Markdown(
				`1. First
   1. Nested first
   2. Nested second
2. Second`,
				0,
				0,
				defaultMarkdownTheme,
			);

			const lines = markdown.render(80);
			const plainLines = lines.map(line => line.replace(/\x1b\[[0-9;]*m/g, ""));

			expect(plainLines.some(line => line.includes("1. First"))).toBeTruthy();
			expect(plainLines.some(line => line.includes("  1. Nested first"))).toBeTruthy();
			expect(plainLines.some(line => line.includes("  2. Nested second"))).toBeTruthy();
			expect(plainLines.some(line => line.includes("2. Second"))).toBeTruthy();
		});

		it("should render mixed ordered and unordered nested lists", () => {
			const markdown = new Markdown(
				`1. Ordered item
   - Unordered nested
   - Another nested
2. Second ordered
   - More nested`,
				0,
				0,
				defaultMarkdownTheme,
			);

			const lines = markdown.render(80);
			const plainLines = lines.map(line => line.replace(/\x1b\[[0-9;]*m/g, ""));

			expect(plainLines.some(line => line.includes("1. Ordered item"))).toBeTruthy();
			expect(plainLines.some(line => line.includes("  - Unordered nested"))).toBeTruthy();
			expect(plainLines.some(line => line.includes("2. Second ordered"))).toBeTruthy();
		});

		it("should maintain numbering when code blocks are not indented (LLM output)", () => {
			// When code blocks aren't indented, marked parses each item as a separate list.
			// We use token.start to preserve the original numbering.
			const markdown = new Markdown(
				`1. First item

\`\`\`typescript
// code block
\`\`\`

2. Second item

\`\`\`typescript
// another code block
\`\`\`

3. Third item`,
				0,
				0,
				defaultMarkdownTheme,
			);

			const lines = markdown.render(80);
			const plainLines = lines.map(line => line.replace(/\x1b\[[0-9;]*m/g, "").trim());

			// Find all lines that start with a number and period
			const numberedLines = plainLines.filter(line => /^\d+\./.test(line));

			// Should have 3 numbered items
			expect(numberedLines.length, `Expected 3 numbered items, got: ${numberedLines.join(", ")}`).toBe(3);

			// Check the actual numbers
			expect(numberedLines[0].startsWith("1."), `First item should be "1.", got: ${numberedLines[0]}`).toBeTruthy();
			expect(numberedLines[1].startsWith("2."), `Second item should be "2.", got: ${numberedLines[1]}`).toBeTruthy();
			expect(numberedLines[2].startsWith("3."), `Third item should be "3.", got: ${numberedLines[2]}`).toBeTruthy();
		});
	});

	describe("Tables", () => {
		it("should render simple table", () => {
			const markdown = new Markdown(
				`| Name | Age |
| --- | --- |
| Alice | 30 |
| Bob | 25 |`,
				0,
				0,
				defaultMarkdownTheme,
			);

			const lines = markdown.render(80);
			const plainLines = lines.map(line => line.replace(/\x1b\[[0-9;]*m/g, ""));

			// Check table structure
			expect(plainLines.some(line => line.includes("Name"))).toBeTruthy();
			expect(plainLines.some(line => line.includes("Age"))).toBeTruthy();
			expect(plainLines.some(line => line.includes("Alice"))).toBeTruthy();
			expect(plainLines.some(line => line.includes("Bob"))).toBeTruthy();
			// Check for table borders
			expect(plainLines.some(line => line.includes("|"))).toBeTruthy();
			expect(plainLines.some(line => line.includes("-"))).toBeTruthy();
		});

		it("should render row dividers between data rows", () => {
			const markdown = new Markdown(
				`| Name | Age |
| --- | --- |
| Alice | 30 |
| Bob | 25 |`,
				0,
				0,
				defaultMarkdownTheme,
			);

			const lines = markdown.render(80);
			const plainLines = lines.map(line => line.replace(/\x1b\[[0-9;]*m/g, ""));
			const dividerLines = plainLines.filter(line => line.includes("+"));

			expect(dividerLines.length >= 2, "Expected header + row divider").toBeTruthy();
		});

		it("should keep column width at least the longest word", () => {
			const longestWord = "superlongword";
			const markdown = new Markdown(
				`| Column One | Column Two |
| --- | --- |
| ${longestWord} short | otherword |
| small | tiny |`,
				0,
				0,
				defaultMarkdownTheme,
			);

			const lines = markdown.render(32);
			const plainLines = lines.map(line => line.replace(/\x1b\[[0-9;]*m/g, ""));
			const dataLine = plainLines.find(line => line.includes(longestWord));
			expect(dataLine, "Expected data row containing longest word").toBeTruthy();

			const segments = dataLine!.split("|").slice(1, -1);
			const [firstSegment] = segments;
			expect(firstSegment, "Expected first column segment").toBeTruthy();
			const firstColumnWidth = firstSegment.length - 2;

			expect(
				firstColumnWidth >= longestWord.length,
				`Expected first column width >= ${longestWord.length}, got ${firstColumnWidth}`,
			).toBeTruthy();
		});

		it("should render table with alignment", () => {
			const markdown = new Markdown(
				`| Left | Center | Right |
| :--- | :---: | ---: |
| A | B | C |
| Long text | Middle | End |`,
				0,
				0,
				defaultMarkdownTheme,
			);

			const lines = markdown.render(80);
			const plainLines = lines.map(line => line.replace(/\x1b\[[0-9;]*m/g, ""));

			// Check headers
			expect(plainLines.some(line => line.includes("Left"))).toBeTruthy();
			expect(plainLines.some(line => line.includes("Center"))).toBeTruthy();
			expect(plainLines.some(line => line.includes("Right"))).toBeTruthy();
			// Check content
			expect(plainLines.some(line => line.includes("Long text"))).toBeTruthy();
		});

		it("should handle tables with varying column widths", () => {
			const markdown = new Markdown(
				`| Short | Very long column header |
| --- | --- |
| A | This is a much longer cell content |
| B | Short |`,
				0,
				0,
				defaultMarkdownTheme,
			);

			const lines = markdown.render(80);

			// Should render without errors
			expect(lines.length > 0).toBeTruthy();

			const plainLines = lines.map(line => line.replace(/\x1b\[[0-9;]*m/g, ""));
			expect(plainLines.some(line => line.includes("Very long column header"))).toBeTruthy();
			expect(plainLines.some(line => line.includes("This is a much longer cell content"))).toBeTruthy();
		});

		it("should wrap table cells when table exceeds available width", () => {
			const markdown = new Markdown(
				`| Command | Description | Example |
| --- | --- | --- |
| npm install | Install all dependencies | npm install |
| npm run build | Build the project | npm run build |`,
				0,
				0,
				defaultMarkdownTheme,
			);

			// Render at narrow width that forces wrapping
			const lines = markdown.render(50);
			const plainLines = lines.map(line => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());

			// All lines should fit within width
			for (const line of plainLines) {
				expect(line.length <= 50, `Line exceeds width 50: "${line}" (length: ${line.length})`).toBeTruthy();
			}

			// Content should still be present (possibly wrapped across lines)
			const allText = plainLines.join(" ");
			expect(allText.includes("Command"), "Should contain 'Command'").toBeTruthy();
			expect(allText.includes("Description"), "Should contain 'Description'").toBeTruthy();
			expect(allText.includes("npm install"), "Should contain 'npm install'").toBeTruthy();
			expect(allText.includes("Install"), "Should contain 'Install'").toBeTruthy();
		});

		it("should wrap long cell content to multiple lines", () => {
			const markdown = new Markdown(
				`| Header |
| --- |
| This is a very long cell content that should wrap |`,
				0,
				0,
				defaultMarkdownTheme,
			);

			// Render at width that forces the cell to wrap
			const lines = markdown.render(25);
			const plainLines = lines.map(line =>
				line
					.replace(/\x1b\]8;;[^\x07]*\x07/g, "")
					.replace(/\x1b\[[0-9;]*m/g, "")
					.trimEnd(),
			);

			// Should have multiple data rows due to wrapping
			const dataRows = plainLines.filter(line => line.startsWith("|") && !line.includes("-"));
			expect(dataRows.length > 2, `Expected wrapped rows, got ${dataRows.length} rows`).toBeTruthy();

			// All content should be preserved (may be split across lines)
			const allText = plainLines.join(" ");
			expect(allText.includes("very long"), "Should preserve 'very long'").toBeTruthy();
			expect(allText.includes("cell content"), "Should preserve 'cell content'").toBeTruthy();
			expect(allText.includes("should wrap"), "Should preserve 'should wrap'").toBeTruthy();
		});

		it("should wrap long unbroken tokens inside table cells (not only at line start)", () => {
			const url = "https://example.com/this/is/a/very/long/url/that/should/wrap";
			const markdown = new Markdown(
				`| Value |
| --- |
| prefix ${url} |`,
				0,
				0,
				defaultMarkdownTheme,
			);

			const width = 30;
			const lines = markdown.render(width);
			const plainLines = lines.map(line =>
				line
					.replace(/\x1b\]8;;[^\x07]*\x07/g, "")
					.replace(/\x1b\[[0-9;]*m/g, "")
					.trimEnd(),
			);

			for (const line of plainLines) {
				expect(
					line.length <= width,
					`Line exceeds width ${width}: "${line}" (length: ${line.length})`,
				).toBeTruthy();
			}

			// Borders should stay intact (exactly 2 vertical borders for a 1-col table)
			const tableLines = plainLines.filter(line => line.startsWith("|"));
			expect(tableLines.length > 0, "Expected table rows to render").toBeTruthy();
			for (const line of tableLines) {
				const borderCount = line.split("|").length - 1;
				expect(borderCount, `Expected 2 borders, got ${borderCount}: "${line}"`).toBe(2);
			}

			// Strip box drawing characters + whitespace so we can assert the URL is preserved
			// even if it was split across multiple wrapped lines.
			const extracted = plainLines.join("").replace(/[|+\-\s]/g, "");
			expect(extracted.includes("prefix"), "Should preserve 'prefix'").toBeTruthy();
			expect(extracted.includes(url), "Should preserve URL").toBeTruthy();
		});

		it("should wrap styled inline code inside table cells without breaking borders", () => {
			const markdown = new Markdown(
				`| Code |
| --- |
| \`averyveryveryverylongidentifier\` |`,
				0,
				0,
				defaultMarkdownTheme,
			);

			const width = 20;
			const lines = markdown.render(width);
			const joinedOutput = lines.join("\n");
			expect(joinedOutput.includes("\x1b[33m"), "Inline code should be styled (yellow)").toBeTruthy();

			const plainLines = lines.map(line => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());
			for (const line of plainLines) {
				expect(
					line.length <= width,
					`Line exceeds width ${width}: "${line}" (length: ${line.length})`,
				).toBeTruthy();
			}

			const tableLines = plainLines.filter(line => line.startsWith("|"));
			for (const line of tableLines) {
				const borderCount = line.split("|").length - 1;
				expect(borderCount, `Expected 2 borders, got ${borderCount}: "${line}"`).toBe(2);
			}
		});

		it("should handle extremely narrow width gracefully", () => {
			const markdown = new Markdown(
				`| A | B | C |
| --- | --- | --- |
| 1 | 2 | 3 |`,
				0,
				0,
				defaultMarkdownTheme,
			);

			// Very narrow width
			const lines = markdown.render(15);
			const plainLines = lines.map(line => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());

			// Should not crash and should produce output
			expect(lines.length > 0, "Should produce output").toBeTruthy();

			// Lines should not exceed width
			for (const line of plainLines) {
				expect(line.length <= 15, `Line exceeds width 15: "${line}" (length: ${line.length})`).toBeTruthy();
			}
		});

		it("should render table correctly when it fits naturally", () => {
			const markdown = new Markdown(
				`| A | B |
| --- | --- |
| 1 | 2 |`,
				0,
				0,
				defaultMarkdownTheme,
			);

			// Wide width where table fits naturally
			const lines = markdown.render(80);
			const plainLines = lines.map(line => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());

			// Should have proper table structure
			const headerLine = plainLines.find(line => line.includes("A") && line.includes("B"));
			expect(headerLine, "Should have header row").toBeTruthy();
			expect(headerLine?.includes("|"), "Header should have borders").toBeTruthy();

			const separatorLine = plainLines.find(line => line.includes("+") && line.includes("-"));
			expect(separatorLine, "Should have separator row").toBeTruthy();

			const dataLine = plainLines.find(line => line.includes("1") && line.includes("2"));
			expect(dataLine, "Should have data row").toBeTruthy();
		});

		it("should respect paddingX when calculating table width", () => {
			const markdown = new Markdown(
				`| Column One | Column Two |
| --- | --- |
| Data 1 | Data 2 |`,
				2, // paddingX = 2
				0,
				defaultMarkdownTheme,
			);

			// Width 40 with paddingX=2 means contentWidth=36
			const lines = markdown.render(40);
			const plainLines = lines.map(line => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());

			// All lines should respect width
			for (const line of plainLines) {
				expect(line.length <= 40, `Line exceeds width 40: "${line}" (length: ${line.length})`).toBeTruthy();
			}

			// Table rows should have left padding
			const tableRow = plainLines.find(line => line.includes("|"));
			expect(tableRow?.startsWith("  "), "Table should have left padding").toBeTruthy();
		});

		it("should not add a trailing blank line when table is the last rendered block", () => {
			const markdown = new Markdown(
				`| Name |
| --- |
| Alice |`,
				0,
				0,
				defaultMarkdownTheme,
			);

			const lines = markdown.render(80);
			const plainLines = lines.map(line => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());

			expect(plainLines.at(-1)).not.toBe("");
		});
	});

	describe("Combined features", () => {
		it("should render lists and tables together", () => {
			const markdown = new Markdown(
				`# Test Document

- Item 1
  - Nested item
- Item 2

| Col1 | Col2 |
| --- | --- |
| A | B |`,
				0,
				0,
				defaultMarkdownTheme,
			);

			const lines = markdown.render(80);
			const plainLines = lines.map(line => line.replace(/\x1b\[[0-9;]*m/g, ""));

			// Check heading
			expect(plainLines.some(line => line.includes("Test Document"))).toBeTruthy();
			// Check list
			expect(plainLines.some(line => line.includes("- Item 1"))).toBeTruthy();
			expect(plainLines.some(line => line.includes("  - Nested item"))).toBeTruthy();
			// Check table
			expect(plainLines.some(line => line.includes("Col1"))).toBeTruthy();
			expect(plainLines.some(line => line.includes("|"))).toBeTruthy();
		});
	});

	describe("Pre-styled text (thinking traces)", () => {
		it("should preserve gray italic styling after inline code", () => {
			// This replicates how thinking content is rendered in assistant-message.ts
			const markdown = new Markdown(
				"This is thinking with `inline code` and more text after",
				1,
				0,
				defaultMarkdownTheme,
				{
					color: text => chalk.gray(text),
					italic: true,
				},
			);

			const lines = markdown.render(80);
			const joinedOutput = lines.join("\n");

			// Should contain the inline code block
			expect(joinedOutput.includes("inline code")).toBeTruthy();

			// The output should have ANSI codes for gray (90) and italic (3)
			expect(joinedOutput.includes("\x1b[90m"), "Should have gray color code").toBeTruthy();
			expect(joinedOutput.includes("\x1b[3m"), "Should have italic code").toBeTruthy();

			// Verify that inline code is styled (theme uses yellow)
			const hasCodeColor = joinedOutput.includes("\x1b[33m");
			expect(hasCodeColor, "Should style inline code").toBeTruthy();
		});

		it("should preserve gray italic styling after bold text", () => {
			const markdown = new Markdown(
				"This is thinking with **bold text** and more after",
				1,
				0,
				defaultMarkdownTheme,
				{
					color: text => chalk.gray(text),
					italic: true,
				},
			);

			const lines = markdown.render(80);
			const joinedOutput = lines.join("\n");

			// Should contain bold text
			expect(joinedOutput.includes("bold text")).toBeTruthy();

			// The output should have ANSI codes for gray (90) and italic (3)
			expect(joinedOutput.includes("\x1b[90m"), "Should have gray color code").toBeTruthy();
			expect(joinedOutput.includes("\x1b[3m"), "Should have italic code").toBeTruthy();

			// Should have bold codes (1 or 22 for bold on/off)
			expect(joinedOutput.includes("\x1b[1m"), "Should have bold code").toBeTruthy();
		});

		it("should not leak styles into following lines when rendered in TUI", async () => {
			class MarkdownWithInput implements Component {
				markdownLineCount = 0;

				constructor(private readonly markdown: Markdown) {}

				render(width: number): string[] {
					const lines = this.markdown.render(width);
					this.markdownLineCount = lines.length;
					return [...lines, "INPUT"];
				}

				invalidate(): void {
					this.markdown.invalidate();
				}
			}

			const markdown = new Markdown("This is thinking with `inline code`", 1, 0, defaultMarkdownTheme, {
				color: text => chalk.gray(text),
				italic: true,
			});

			const terminal = new VirtualTerminal(80, 6);
			const tui = new TUI(terminal);
			const component = new MarkdownWithInput(markdown);
			tui.addChild(component);
			tui.start();
			await terminal.flush();

			expect(component.markdownLineCount > 0).toBeTruthy();
			const inputRow = component.markdownLineCount;
			expect(getCellItalic(terminal, inputRow, 0)).toBe(0);
			tui.stop();
		});
	});

	describe("Spacing after code blocks", () => {
		it("should have only one blank line between code block and following paragraph", () => {
			const markdown = new Markdown(
				`hello world

\`\`\`js
const hello = "world";
\`\`\`

again, hello world`,
				0,
				0,
				defaultMarkdownTheme,
			);

			const lines = markdown.render(80);
			const plainLines = lines.map(line => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());

			const closingBackticksIndex = plainLines.indexOf("```");
			expect(closingBackticksIndex !== -1, "Should have closing backticks").toBeTruthy();

			const afterBackticks = plainLines.slice(closingBackticksIndex + 1);
			const emptyLineCount = afterBackticks.findIndex(line => line !== "");

			expect(
				emptyLineCount,
				`Expected 1 empty line after code block, but found ${emptyLineCount}. Lines after backticks: ${JSON.stringify(afterBackticks.slice(0, 5))}`,
			).toBe(1);
		});

		it("should normalize paragraph and code block spacing to one blank line", () => {
			const cases = [
				`hello this is text
\`\`\`
code block
\`\`\`
more text`,
				`hello this is text

\`\`\`
code block
\`\`\`

more text`,
			];
			const expectedLines = ["hello this is text", "", "```", "  code block", "```", "", "more text"];

			for (const text of cases) {
				const markdown = new Markdown(text, 0, 0, defaultMarkdownTheme);
				const lines = markdown.render(80);
				const plainLines = lines.map(line => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());

				expect(plainLines).toEqual(expectedLines);
			}
		});

		it("should not add a trailing blank line when code block is the last rendered block", () => {
			const cases = ["```js\nconst hello = 'world';\n```", "hello world\n\n```js\nconst hello = 'world';\n```"];

			for (const text of cases) {
				const markdown = new Markdown(text, 0, 0, defaultMarkdownTheme);
				const lines = markdown.render(80);
				const plainLines = lines.map(line => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());

				expect(plainLines.at(-1)).not.toBe("");
			}
		});
	});

	describe("Mermaid fenced blocks", () => {
		const renderMermaidLines = (text: string, resolveMermaidAscii: (source: string) => string | null) => {
			const markdown = new Markdown(text, 0, 0, { ...defaultMarkdownTheme, resolveMermaidAscii });

			return markdown.render(80).map(line => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());
		};

		it("renders resolver ASCII only when the mermaid source matches", () => {
			const fencedMermaid = "```mermaid\nflowchart TD\n  Start-->Stop\n```";
			const mermaidSource = "flowchart TD\n  Start-->Stop";
			const seenSources: string[] = [];

			const plainLines = renderMermaidLines(fencedMermaid, source => {
				seenSources.push(source);
				return source === mermaidSource ? "Start\n  |\nStop" : null;
			});

			expect(seenSources).toEqual([mermaidSource]);
			expect(plainLines).toEqual(["Start", "  |", "Stop"]);
			expect(plainLines.some(line => line.includes("```mermaid"))).toBeFalsy();
		});

		it("falls back to the original fenced code block when mermaid resolution returns null", () => {
			const invalidMermaid = "```mermaid\nflowchart TD\n  A --\n```";
			const invalidSource = "flowchart TD\n  A --";
			const seenSources: string[] = [];

			const plainLines = renderMermaidLines(invalidMermaid, source => {
				seenSources.push(source);
				return null;
			});

			expect(seenSources).toEqual([invalidSource]);
			expect(plainLines).toEqual(["```mermaid", "  flowchart TD", "    A --", "```"]);
		});
	});

	describe("Spacing after dividers", () => {
		it("should have only one blank line between divider and following paragraph", () => {
			const markdown = new Markdown(
				`hello world

---

again, hello world`,
				0,
				0,
				defaultMarkdownTheme,
			);

			const lines = markdown.render(80);
			const plainLines = lines.map(line => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());

			const dividerIndex = plainLines.findIndex(line => /^-+$/.test(line.trim()));
			expect(dividerIndex !== -1, "Should have divider").toBeTruthy();

			const afterDivider = plainLines.slice(dividerIndex + 1);
			const emptyLineCount = afterDivider.findIndex(line => line !== "");

			expect(
				emptyLineCount,
				`Expected 1 empty line after divider, but found ${emptyLineCount}. Lines after divider: ${JSON.stringify(afterDivider.slice(0, 5))}`,
			).toBe(1);
		});

		it("should not add a trailing blank line when divider is the last rendered block", () => {
			const markdown = new Markdown("---", 0, 0, defaultMarkdownTheme);
			const lines = markdown.render(80);
			const plainLines = lines.map(line => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());

			expect(plainLines.at(-1)).not.toBe("");
		});
	});

	describe("Spacing after headings", () => {
		it("should have only one blank line between heading and following paragraph", () => {
			const markdown = new Markdown(
				`# Hello

This is a paragraph`,
				0,
				0,
				defaultMarkdownTheme,
			);

			const lines = markdown.render(80);
			const plainLines = lines.map(line => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());

			const headingIndex = plainLines.findIndex(line => line.includes("Hello"));
			expect(headingIndex !== -1, "Should have heading").toBeTruthy();

			const afterHeading = plainLines.slice(headingIndex + 1);
			const emptyLineCount = afterHeading.findIndex(line => line !== "");

			expect(
				emptyLineCount,
				`Expected 1 empty line after heading, but found ${emptyLineCount}. Lines after heading: ${JSON.stringify(afterHeading.slice(0, 5))}`,
			).toBe(1);
		});

		it("should not add a trailing blank line when heading is the last rendered block", () => {
			const markdown = new Markdown("# Hello", 0, 0, defaultMarkdownTheme);
			const lines = markdown.render(80);
			const plainLines = lines.map(line => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());

			expect(plainLines.at(-1)).not.toBe("");
		});
	});

	describe("Spacing after blockquotes", () => {
		it("should have only one blank line between blockquote and following paragraph", () => {
			const markdown = new Markdown(
				`hello world

> This is a quote

again, hello world`,
				0,
				0,
				defaultMarkdownTheme,
			);

			const lines = markdown.render(80);
			const plainLines = lines.map(line => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());

			const quoteIndex = plainLines.findIndex(line => line.includes("This is a quote"));
			expect(quoteIndex !== -1, "Should have blockquote").toBeTruthy();

			const afterQuote = plainLines.slice(quoteIndex + 1);
			const emptyLineCount = afterQuote.findIndex(line => line !== "");

			expect(
				emptyLineCount,
				`Expected 1 empty line after blockquote, but found ${emptyLineCount}. Lines after quote: ${JSON.stringify(afterQuote.slice(0, 5))}`,
			).toBe(1);
		});

		it("should not add a trailing blank line when blockquote is the last rendered block", () => {
			const markdown = new Markdown("> This is a quote", 0, 0, defaultMarkdownTheme);
			const lines = markdown.render(80);
			const plainLines = lines.map(line => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());

			expect(plainLines.at(-1)).not.toBe("");
		});
	});

	describe("Blockquotes with multiline content", () => {
		it("should apply consistent styling to all lines in lazy continuation blockquote", () => {
			// Markdown "lazy continuation" - second line without > is still part of the quote
			const markdown = new Markdown(
				`>Foo
bar`,
				0,
				0,
				defaultMarkdownTheme,
				{
					color: text => chalk.magenta(text), // This should NOT be applied to blockquotes
				},
			);

			const lines = markdown.render(80);

			// Both lines should have the quote border
			const plainLines = lines.map(line => line.replace(/\x1b\[[0-9;]*m/g, ""));
			const quotedLines = plainLines.filter(line => line.startsWith("│ "));
			expect(quotedLines.length).toBe(2);

			// Both lines should have italic (from theme.quote styling)
			const fooLine = lines.find(line => line.includes("Foo"));
			const barLine = lines.find(line => line.includes("bar"));
			expect(fooLine).toBeTruthy();
			expect(barLine).toBeTruthy();

			// Check that both have italic (\x1b[3m) - blockquotes use theme styling, not default message color
			expect(fooLine?.includes("\x1b[3m")).toBeTruthy();
			expect(barLine?.includes("\x1b[3m")).toBeTruthy();

			// Blockquotes should NOT have the default message color (magenta)
			expect(fooLine?.includes("\x1b[35m")).toBeFalsy();
			expect(barLine?.includes("\x1b[35m")).toBeFalsy();
		});

		it("should apply consistent styling to explicit multiline blockquote", () => {
			const markdown = new Markdown(
				`>Foo
>bar`,
				0,
				0,
				defaultMarkdownTheme,
				{
					color: text => chalk.cyan(text), // This should NOT be applied to blockquotes
				},
			);

			const lines = markdown.render(80);

			// Both lines should have the quote border
			const plainLines = lines.map(line => line.replace(/\x1b\[[0-9;]*m/g, ""));
			const quotedLines = plainLines.filter(line => line.startsWith("│ "));
			expect(quotedLines.length).toBe(2);

			// Both lines should have italic (from theme.quote styling)
			const fooLine = lines.find(line => line.includes("Foo"));
			const barLine = lines.find(line => line.includes("bar"));
			expect(fooLine?.includes("\x1b[3m")).toBeTruthy();
			expect(barLine?.includes("\x1b[3m")).toBeTruthy();

			// Blockquotes should NOT have the default message color (cyan)
			expect(fooLine?.includes("\x1b[36m")).toBeFalsy();
			expect(barLine?.includes("\x1b[36m")).toBeFalsy();
		});

		it("should wrap long blockquote lines and add border to each wrapped line", () => {
			const longText = "This is a very long blockquote line that should wrap to multiple lines when rendered";
			const markdown = new Markdown(`> ${longText}`, 0, 0, defaultMarkdownTheme);

			// Render at narrow width to force wrapping
			const lines = markdown.render(30);
			const plainLines = lines.map(line => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());

			// Filter to non-empty lines (exclude trailing blank line after blockquote)
			const contentLines = plainLines.filter(line => line.length > 0);

			// Should have multiple lines due to wrapping
			expect(contentLines.length > 1).toBeTruthy();

			// Every content line should start with the quote border
			for (const line of contentLines) {
				expect(line.startsWith("│ ")).toBeTruthy();
			}

			// All content should be preserved
			const allText = contentLines.join(" ");
			expect(allText.includes("very long")).toBeTruthy();
			expect(allText.includes("blockquote")).toBeTruthy();
			expect(allText.includes("multiple")).toBeTruthy();
		});

		it("should properly indent wrapped blockquote lines with styling", () => {
			const markdown = new Markdown(
				"> This is styled text that is long enough to wrap",
				0,
				0,
				defaultMarkdownTheme,
				{
					color: text => chalk.yellow(text), // This should NOT be applied to blockquotes
					italic: true,
				},
			);

			const lines = markdown.render(25);
			const plainLines = lines.map(line => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());

			// Filter to non-empty lines
			const contentLines = plainLines.filter(line => line.length > 0);

			// All lines should have the quote border
			for (const line of contentLines) {
				expect(line.startsWith("│ ")).toBeTruthy();
			}

			// Check that italic is applied (from theme.quote)
			const allOutput = lines.join("\n");
			expect(allOutput.includes("\x1b[3m")).toBeTruthy();

			// Blockquotes should NOT have the default message color (yellow)
			expect(allOutput.includes("\x1b[33m")).toBeFalsy();
		});

		it("should render inline formatting inside blockquotes and reapply quote styling after", () => {
			const markdown = new Markdown("> Quote with **bold** and `code`", 0, 0, defaultMarkdownTheme);

			const lines = markdown.render(80);
			const plainLines = lines.map(line => line.replace(/\x1b\[[0-9;]*m/g, ""));

			// Should have the quote border
			expect(plainLines.some(line => line.startsWith("│ "))).toBeTruthy();

			// Content should be preserved
			const allPlain = plainLines.join(" ");
			expect(allPlain.includes("Quote with")).toBeTruthy();
			expect(allPlain.includes("bold")).toBeTruthy();
			expect(allPlain.includes("code")).toBeTruthy();

			const allOutput = lines.join("\n");

			// Should have bold styling (\x1b[1m)
			expect(allOutput.includes("\x1b[1m")).toBeTruthy();

			// Should have code styling (yellow = \x1b[33m from defaultMarkdownTheme)
			expect(allOutput.includes("\x1b[33m")).toBeTruthy();

			// Should have italic from quote styling (\x1b[3m)
			expect(allOutput.includes("\x1b[3m")).toBeTruthy();
		});
		it("should render list content inside blockquotes", () => {
			const markdown = new Markdown("> 1. bla bla\n>    - nested bullet", 0, 0, defaultMarkdownTheme);

			const lines = markdown.render(80);
			const plainLines = lines.map(line => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());
			const quotedLines = plainLines.filter(line => line.startsWith("│ "));

			expect(quotedLines.some(line => line.includes("1. bla bla"))).toBeTruthy();
			expect(quotedLines.some(line => line.includes("- nested bullet"))).toBeTruthy();
		});

		it("should render table content inside blockquotes", () => {
			const markdown = new Markdown("> | A | B |\n> | --- | --- |\n> | 1 | 2 |", 0, 0, defaultMarkdownTheme);

			const lines = markdown.render(80);
			const plainLines = lines.map(line => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());
			const quotedLines = plainLines.filter(line => line.startsWith("│ "));
			const quotedOutput = quotedLines.join("\n");

			expect(quotedOutput.includes("A")).toBeTruthy();
			expect(quotedOutput.includes("B")).toBeTruthy();
			expect(quotedOutput.includes("1")).toBeTruthy();
			expect(quotedOutput.includes("2")).toBeTruthy();
			expect(quotedOutput.includes("+---+")).toBeTruthy();
			expect(quotedOutput.includes("| A")).toBeTruthy();
		});

		it("should render fenced code blocks inside blockquotes without applying default text color", () => {
			const markdown = new Markdown("> ```js\n> console.log(1)\n> ```", 0, 0, defaultMarkdownTheme, {
				color: text => chalk.magenta(text),
			});

			const lines = markdown.render(80);
			const plainLines = lines.map(line => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());
			const quotedLines = plainLines.filter(line => line.startsWith("│ "));
			const output = lines.join("\n");
			const plainOutput = quotedLines.join("\n");

			expect(plainOutput.includes("```js")).toBeTruthy();
			expect(plainOutput.includes("console.log(1)")).toBeTruthy();
			expect(plainOutput.includes("```")).toBeTruthy();
			expect(output.includes("\x1b[35m")).toBeFalsy();
			expect(output.includes("\x1b[3m")).toBeTruthy();
		});
	});

	const stripTerminalSequences = (line: string): string =>
		line.replace(/\x1b\]8;;[^\x07]*\x07/g, "").replace(/\x1b\[[0-9;]*m/g, "");

	describe("Links", () => {
		// CI environments often resolve to the "base" terminal which has hyperlinks
		// disabled; force them on so OSC 8 assertions are deterministic. The render
		// cache keys on TERMINAL.hyperlinks, so flipping the bit invalidates entries.
		const terminalState = TERMINAL as unknown as { hyperlinks: boolean };
		const originalHyperlinks = terminalState.hyperlinks;
		beforeAll(() => {
			terminalState.hyperlinks = true;
		});
		afterAll(() => {
			terminalState.hyperlinks = originalHyperlinks;
		});

		it("should not duplicate URL for autolinked emails", () => {
			const markdown = new Markdown("Contact user@example.com for help", 0, 0, defaultMarkdownTheme);

			const lines = markdown.render(80);
			const plainLines = lines.map(stripTerminalSequences);
			const joinedPlain = plainLines.join(" ");

			// Should contain the email once, not duplicated with mailto:
			expect(joinedPlain.includes("user@example.com"), "Should contain email").toBeTruthy();
			expect(!joinedPlain.includes("mailto:"), "Should not show mailto: prefix for autolinked emails").toBeTruthy();
		});

		it("should not duplicate URL for bare URLs", () => {
			const markdown = new Markdown("Visit https://example.com for more", 0, 0, defaultMarkdownTheme);

			const lines = markdown.render(80);
			const plainLines = lines.map(stripTerminalSequences);
			const joinedPlain = plainLines.join(" ");

			// URL should appear only once
			const urlCount = (joinedPlain.match(/https:\/\/example\.com/g) || []).length;
			expect(urlCount, "URL should appear exactly once").toBe(1);
		});

		it("should emit OSC 8 hyperlink sequences for bare URLs", () => {
			const markdown = new Markdown("Visit https://example.com for more", 0, 0, defaultMarkdownTheme);

			const output = markdown.render(80).join("\n");
			expect(output.includes("\x1b]8;;https://example.com\x07")).toBeTruthy();
			expect(output.includes("\x1b]8;;\x07")).toBeTruthy();
		});

		it("should keep wrapped URLs inside a single OSC 8 hyperlink span", () => {
			const markdown = new Markdown(
				"Visit https://example.com/really/long/path/that/will/wrap/on/narrow/width for more",
				0,
				0,
				defaultMarkdownTheme,
			);

			const lines = markdown.render(32);
			expect(lines.length).toBeGreaterThan(1);
			const output = lines.join("\n");
			const openMatches =
				output.match(
					/\x1b\]8;;https:\/\/example\.com\/really\/long\/path\/that\/will\/wrap\/on\/narrow\/width\x07/g,
				) || [];
			const closeMatches = output.match(/\x1b\]8;;\x07/g) || [];
			expect(openMatches.length).toBe(1);
			expect(closeMatches.length).toBeGreaterThan(0);
		});

		it("should show URL for explicit markdown links with different text", () => {
			const markdown = new Markdown("[click here](https://example.com)", 0, 0, defaultMarkdownTheme);

			const lines = markdown.render(80);
			const plainLines = lines.map(stripTerminalSequences);
			const joinedPlain = plainLines.join(" ");

			// Should show both link text and URL
			expect(joinedPlain.includes("click here"), "Should contain link text").toBeTruthy();
			expect(joinedPlain.includes("(https://example.com)"), "Should show URL in parentheses").toBeTruthy();
		});

		it("should show URL for explicit mailto links with different text", () => {
			const markdown = new Markdown("[Email me](mailto:test@example.com)", 0, 0, defaultMarkdownTheme);

			const lines = markdown.render(80);
			const plainLines = lines.map(stripTerminalSequences);
			const joinedPlain = plainLines.join(" ");

			// Should show both link text and mailto URL
			expect(joinedPlain.includes("Email me"), "Should contain link text").toBeTruthy();
			expect(
				joinedPlain.includes("(mailto:test@example.com)"),
				"Should show mailto URL in parentheses",
			).toBeTruthy();
		});
	});

	describe("HTML-like tags in text", () => {
		it("should render content with HTML-like tags as text", () => {
			// When the model emits something like <thinking>content</thinking> in regular text,
			// marked might treat it as HTML and hide the content
			const markdown = new Markdown(
				"This is text with <thinking>hidden content</thinking> that should be visible",
				0,
				0,
				defaultMarkdownTheme,
			);

			const lines = markdown.render(80);
			const plainLines = lines.map(line => line.replace(/\x1b\[[0-9;]*m/g, ""));
			const joinedPlain = plainLines.join(" ");

			// The content inside the tags should be visible
			expect(
				joinedPlain.includes("hidden content") || joinedPlain.includes("<thinking>"),
				"Should render HTML-like tags or their content as text, not hide them",
			).toBeTruthy();
		});

		it("should render HTML tags in code blocks correctly", () => {
			const markdown = new Markdown("```html\n<div>Some HTML</div>\n```", 0, 0, defaultMarkdownTheme);

			const lines = markdown.render(80);
			const plainLines = lines.map(line => line.replace(/\x1b\[[0-9;]*m/g, ""));
			const joinedPlain = plainLines.join("\n");

			// HTML in code blocks should be visible
			expect(
				joinedPlain.includes("<div>") && joinedPlain.includes("</div>"),
				"Should render HTML in code blocks",
			).toBeTruthy();
		});
	});
});

describe("Module-level LRU render cache", () => {
	it("invokes highlightCode only once for two distinct instances with identical (text, width, theme)", () => {
		// Build a theme with a spy on highlightCode. The theme object reference
		// is stable across both instances so objectId() returns the same ID,
		// meaning the L2 cache key is identical for both renders.
		let highlightCallCount = 0;
		const themeWithSpy = {
			...defaultMarkdownTheme,
			highlightCode: (code: string, _lang?: string): string[] => {
				highlightCallCount++;
				return [code]; // trivial passthrough
			},
		};

		const text = "```js\nconst x = 1;\n```";
		const width = 80;

		// First instance: cold cache → highlightCode MUST be called.
		const md1 = new Markdown(text, 0, 0, themeWithSpy);
		const lines1 = md1.render(width);
		expect(highlightCallCount, "First render should call highlightCode exactly once").toBe(1);

		// Second distinct instance with identical inputs: L2 cache hit → highlightCode must NOT be called again.
		const md2 = new Markdown(text, 0, 0, themeWithSpy);
		const lines2 = md2.render(width);
		expect(highlightCallCount, "Second render (different instance, same key) must use L2 cache").toBe(1);

		// Output must be byte-identical — cache is transparent to callers.
		expect(lines2).toEqual(lines1);
	});

	it("keeps distinct markdown render cache bounded", () => {
		clearRenderCache();
		let highlightCallCount = 0;
		const themeWithSpy = {
			...defaultMarkdownTheme,
			highlightCode: (code: string, _lang?: string): string[] => {
				highlightCallCount++;
				return [code];
			},
		};

		// Exceed BOTH the L2 render cache (256) and the per-code-block highlight cache
		// (512) so message 0 is evicted from each and a re-render must re-highlight it.
		for (let i = 0; i < 600; i++) {
			new Markdown(`message ${i}\n\n\`\`\`js\nconst value = ${i};\n\`\`\``, 0, 0, themeWithSpy).render(80);
		}

		new Markdown("message 0\n\n```js\nconst value = 0;\n```", 0, 0, themeWithSpy).render(80);
		expect(highlightCallCount).toBe(601);
	});

	it("never serves another message's render on content-key collision attempts", () => {
		clearRenderCache();
		// Force a DETERMINISTIC key collision: stub Bun.hash to a constant so
		// two different documents map to the same content hash. The cache's
		// source-verification on hit is then the only thing preventing wrong
		// output — exactly the guard this regression must pin down.
		const realHash = Bun.hash;
		const stub = Object.assign((..._args: unknown[]) => 0xdeadbeefn, realHash);
		(Bun as { hash: typeof Bun.hash }).hash = stub as typeof Bun.hash;
		try {
			const head = "# Title\n\n";
			const tail = "\n\n---\nfooter line for the collision probe";
			const docA = `${head}body ${"a".repeat(200)} unique-AAAA${tail}`;
			const docB = `${head}body ${"a".repeat(200)} unique-BBBB${tail}`;
			expect(docA.length).toBe(docB.length); // same length + stubbed hash => identical cache key

			const linesA = new Markdown(docA, 0, 0, defaultMarkdownTheme).render(80);
			const linesB = new Markdown(docB, 0, 0, defaultMarkdownTheme).render(80);

			expect(linesB.join("\n")).toContain("unique-BBBB");
			expect(linesB.join("\n")).not.toContain("unique-AAAA");
			expect(linesA.join("\n")).toContain("unique-AAAA");
		} finally {
			(Bun as { hash: typeof Bun.hash }).hash = realHash;
			clearRenderCache();
		}
	});
});
