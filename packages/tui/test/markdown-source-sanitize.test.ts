import { afterEach, describe, expect, it } from "bun:test";
import fc from "fast-check";
import { Markdown, renderInlineMarkdown } from "../src/components/markdown.js";
import { ImageProtocol, setTerminalImageProtocol, TERMINAL } from "../src/terminal-capabilities.js";
import { defaultMarkdownTheme } from "./test-themes.js";

const PROPERTY_SEED = 64501;
const PROPERTY_RUNS = 64;
const OSC52 = "\x1b]52;c;QQ==\x07";
const OSC_TITLE = "\x1b]0;pwned\x07";
const DCS = "\x1bPpayload\x1b\\";

function render(source: string, width = 80): string {
	return new Markdown(source, 0, 0, defaultMarkdownTheme).render(width).join("\n");
}

describe("markdown source controls", () => {
	const previousProtocol = TERMINAL.imageProtocol;
	afterEach(() => {
		setTerminalImageProtocol(previousProtocol);
	});

	it("does not emit OSC 52, title OSC, DCS, or C1 from code fences or prose", () => {
		const source = ["# title", "", "```", OSC52, OSC_TITLE, DCS, "\x9b31mred", "```", "", `plain ${OSC52}`].join(
			"\n",
		);
		const output = render(source);
		expect(output).not.toContain("\x1b]52");
		expect(output).not.toContain("\x1b]0;");
		expect(output).not.toContain("\x1bP");
		expect(output).not.toContain("\x9b");
		expect(output).toContain("plain");
		expect(output).toContain("```");
	});

	it("strips OSC 52 in renderInlineMarkdown and setText", () => {
		const inline = renderInlineMarkdown(`hello ${OSC52} **bold**`, defaultMarkdownTheme);
		expect(inline).not.toContain("\x1b]52");
		expect(inline).toContain("hello");
		expect(inline).toContain("bold");
		expect(inline).toContain("\x1b[");

		const markdown = new Markdown("safe", 0, 0, defaultMarkdownTheme);
		markdown.setText(`next ${OSC52}`);
		expect(markdown.render(40).join("\n")).not.toContain("\x1b]52");
	});

	it("still renders emphasis, fenced code, tabs, and a clean https link", () => {
		const output = render("**bold** and `code`\n\n```ts\nconst x = 1;\n```\n\n- item\n");
		const plain = output.replace(/\x1b\[[0-9;]*m/g, "");
		expect(plain).toContain("bold");
		expect(plain).toContain("code");
		expect(plain).toContain("const x = 1;");
		expect(plain).toContain("item");
		expect(output).toContain("\x1b[");

		const terminalState = TERMINAL as unknown as { hyperlinks: boolean };
		const originalHyperlinks = terminalState.hyperlinks;
		terminalState.hyperlinks = true;
		try {
			const link = render("[source](https://example.com/a)");
			expect(link).toContain("\x1b]8;;https://example.com/a\x07");
		} finally {
			terminalState.hyperlinks = originalHyperlinks;
		}
	});

	it("still keeps a carriage return as a line break", () => {
		const lines = new Markdown("alpha\rbeta", 0, 0, defaultMarkdownTheme).render(40);
		const plain = lines.map(line => line.replace(/\x1b\[[0-9;]*m/g, "").trim());
		expect(plain).toContain("alpha");
		expect(plain).toContain("beta");
		expect(plain.join("\n")).not.toContain("alphabeta");
	});

	it("still lets an SVG figure emit an unwrapped Kitty image line", () => {
		setTerminalImageProtocol(ImageProtocol.Kitty);
		const kitty = `${ImageProtocol.Kitty}f=100,a=T,t=d;${"QUJD".repeat(64)}\x1b\\`;
		const width = 24;
		expect(kitty.length).toBeGreaterThan(width);
		const theme = {
			...defaultMarkdownTheme,
			resolveSvgFigure: () => ({
				render: () => [kitty],
				invalidate: () => {},
			}),
		};
		const lines = new Markdown("```svg\n<svg/>\n```", 0, 0, theme).render(width);
		expect(lines[0]).toBe(kitty);
	});

	it("property: hostile source cannot emit OSC 52, title, or DCS, seed 64501, 64 inputs", () => {
		fc.assert(
			fc.property(
				fc.string({ maxLength: 40 }),
				fc.string({
					minLength: 1,
					maxLength: 12,
					unit: fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789"),
				}),
				(noise, word) => {
					const source = `${noise}\n**${word}**\n\n\`\`\`\n${word}\n${OSC52}\n${OSC_TITLE}\n${DCS}\n\`\`\``;
					const output = render(source, 60);
					expect(output.includes("\x1b]52")).toBe(false);
					expect(output.includes("\x1b]0;")).toBe(false);
					expect(output.includes("\x1bP")).toBe(false);
					expect(output.includes("\x9b")).toBe(false);
					expect(output.includes(word)).toBe(true);
					expect(output.includes("\x1b[")).toBe(true);
				},
			),
			{ seed: PROPERTY_SEED, numRuns: PROPERTY_RUNS },
		);
	});

	it("property: printable markdown stays free of C0 controls, seed 64501, 64 inputs", () => {
		const alphabet = "abcdefghijklmnopqrstuvwxyz \t\n*_`[]()#.-";
		fc.assert(
			fc.property(fc.string({ minLength: 0, maxLength: 48, unit: fc.constantFrom(...alphabet) }), text => {
				const lines = new Markdown(text, 0, 0, defaultMarkdownTheme).render(48);
				expect(new Markdown(text, 0, 0, defaultMarkdownTheme).render(48)).toEqual(lines);
				const plain = lines
					.join("\n")
					.replace(/\x1b\[[0-9;]*m/g, "")
					.replace(/\x1b\]8;;[^\x07]*\x07/g, "");
				expect(/[\x00-\x08\x0b-\x1f\x7f]/u.test(plain)).toBe(false);
			}),
			{ seed: PROPERTY_SEED, numRuns: PROPERTY_RUNS },
		);
	});

	it("tolerates undefined and null text in Markdown constructor and setText", () => {
		const markdown = new Markdown("", 0, 0, defaultMarkdownTheme);

		// @ts-expect-error testing defensive guard against missing text
		const fromUndefined = new Markdown(undefined, 0, 0, defaultMarkdownTheme);
		expect(() => fromUndefined.render(40)).not.toThrow();
		expect(fromUndefined.render(40)).toEqual([]);

		// @ts-expect-error testing defensive guard against missing text
		const fromNull = new Markdown(null, 0, 0, defaultMarkdownTheme);
		expect(() => fromNull.render(40)).not.toThrow();
		expect(fromNull.render(40)).toEqual([]);

		// @ts-expect-error testing defensive guard against missing text
		markdown.setText(undefined);
		expect(() => markdown.render(40)).not.toThrow();
		expect(markdown.render(40)).toEqual([]);

		// @ts-expect-error testing defensive guard against missing text
		markdown.setText(null);
		expect(() => markdown.render(40)).not.toThrow();
		expect(markdown.render(40)).toEqual([]);
	});
});
