import { beforeAll, expect, test } from "bun:test";
import fc from "fast-check";
import { initTheme, theme } from "../../src/modes/theme/theme";
import { renderMarkdownCell } from "../../src/tui/code-cell";

beforeAll(async () => {
	await initTheme();
});

function renderCell(content: string, output?: string): string {
	return renderMarkdownCell({ content, output, width: 80, expanded: true }, theme).join("\n");
}

test("does not render a raw terminal control sequence from markdown content", () => {
	const title = "\x1b]0;f667-title\x07";
	const href = `[label](https://example.com/x\x1b]0;f667-href\x07)`;
	const fence = "```\n\x1b]0;f667-fence\x07\n```";
	const colored = "\x1b[38;2;9;8;7mcolored\x1b[0m";
	const dcs = "\x1bP+f667payload\x1b\\";
	const c1 = "\u009d0;f667-c1\u009c";
	const rendered = renderCell(`before ${title} after\n\n${href}\n\n${fence}\n\n${colored} ${dcs} ${c1}`);
	expect(rendered).not.toContain("\x1b]0;f667-title");
	expect(rendered).not.toContain("\x1b]0;f667-href");
	expect(rendered).not.toContain("\x1b]0;f667-fence");
	expect(rendered).not.toContain("\x1b[38;2;9;8;7m");
	expect(rendered).not.toContain("\x1bP+f667payload");
	expect(rendered).not.toContain("\u009d0;f667-c1");
	expect(rendered).toContain("before");
	expect(rendered).toContain("after");
	expect(rendered).toContain("label");
	expect(rendered).toContain("colored");
});

test("still allows ordinary markdown prose and a fenced code line", () => {
	const rendered = renderCell("# Title\n\nKeep MixedCase plain **bold** word\n\n```\nconst value = 1;\n```\n");
	expect(rendered).toContain("Title");
	expect(rendered).toContain("Keep MixedCase");
	expect(rendered).toContain("plain");
	expect(rendered).toContain("bold");
	expect(rendered).toContain("const value = 1;");
});

test("keeps a normal https link label", () => {
	const rendered = renderCell("[docs](https://example.com/docs)");
	expect(rendered).toContain("docs");
	expect(rendered).toContain("https://example.com/docs");
});

test("still allows surrounding whitespace and a tab", () => {
	const rendered = renderCell("  keep me\n\n\talpha");
	expect(rendered).toContain("keep me");
	expect(rendered).toContain("alpha");
});

test("keeps bracket text that is not a control sequence", () => {
	const rendered = renderCell("see [31m] and ESC c later");
	expect(rendered).toContain("[31m]");
	expect(rendered).toContain("ESC c later");
});

test("keeps an existing SGR sequence in the output section", () => {
	const rendered = renderCell("body", "\x1b[31mkept-output\x1b[0m");
	expect(rendered).toContain("kept-output");
	expect(rendered).toContain("\x1b[31mkept-output");
});

test("property: injected terminal controls are absent from the cell, fc.property seed 66721, numRuns 64", () => {
	const mark = fc.stringMatching(/^[A-Za-z0-9]{6,12}$/);
	const wrapper = fc.constantFrom(
		(value: string) => `\x1b]0;${value}\x07`,
		(value: string) => `\x1b]8;;http://e/${value}\x07x\x1b]8;;\x07`,
		(value: string) => `\x1bP${value}\x1b\\`,
		(value: string) => `\x1b[38;2;${value.length};1;2m`,
	);
	fc.assert(
		fc.property(fc.string({ maxLength: 24 }), mark, wrapper, (prefix, token, wrap) => {
			fc.pre(!prefix.includes(token));
			const sequence = wrap(token);
			const rendered = renderCell(`${prefix}keep${sequence}tail`);
			const payloadIsStripped = sequence.startsWith("\x1b]0;") || sequence.startsWith("\x1bP");
			return !rendered.includes(sequence) && (!payloadIsStripped || !rendered.includes(token));
		}),
		{ seed: 66721, numRuns: 64 },
	);
});

test("still allows CR and CRLF markdown breaks", () => {
	const lf = "# One\n\nTwo\n\n```\nconst value = 1;\n```\n";
	const crlf = lf.replaceAll("\n", "\r\n");
	const cr = lf.replaceAll("\n", "\r");
	const rendered = renderCell(lf);
	expect(renderCell(crlf)).toBe(rendered);
	expect(renderCell(cr)).toBe(rendered);
	expect(rendered).toContain("One");
	expect(rendered).toContain("Two");
	expect(rendered).toContain("const value = 1;");
	expect(rendered).not.toContain("OneTwo");
});

test("keeps markdown newline meaning, fc.property seed 66723, numRuns 64", () => {
	const line = fc.stringMatching(/^[A-Za-z][A-Za-z0-9 ]{0,12}$/);
	fc.assert(
		fc.property(line, line, fc.constantFrom("\n", "\r\n", "\r"), (heading, paragraph, br) => {
			const lf = `# ${heading}\n\n${paragraph}\n\n\`\`\`\nconst value = 1;\n\`\`\`\n`;
			const mixed = `# ${heading}${br}${br}${paragraph}${br}${br}\`\`\`${br}const value = 1;${br}\`\`\`${br}`;
			return renderCell(mixed) === renderCell(lf);
		}),
		{ seed: 66723, numRuns: 64 },
	);
});

test("keeps printable markdown letters, fc.property seed 66722, numRuns 64", () => {
	fc.assert(
		fc.property(fc.stringMatching(/^[A-Za-z][A-Za-z ]{0,30}$/), text => {
			return renderCell(text).includes(text.trim());
		}),
		{ seed: 66722, numRuns: 64 },
	);
});
