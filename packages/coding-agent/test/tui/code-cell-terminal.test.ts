import { beforeAll, expect, test } from "bun:test";
import fc from "fast-check";
import { initTheme, theme } from "../../src/modes/theme/theme";
import { readToolRenderer } from "../../src/tools/read";
import { renderCodeCell } from "../../src/tui/code-cell";

beforeAll(async () => {
	await initTheme();
});

function renderCell(code: string, language = "text", output?: string, width = 80, codeMaxLines?: number): string {
	return renderCodeCell(
		{
			code,
			language,
			output,
			width,
			expanded: codeMaxLines === undefined,
			codeMaxLines,
			title: "cell",
		},
		theme,
	).join("\n");
}

function renderRead(text: string, file = "notes.txt"): string {
	const component = readToolRenderer.renderResult(
		{
			content: [{ type: "text", text: "model copy" }],
			details: { displayContent: { text, startLine: 1 } },
		},
		{ expanded: true, isPartial: false },
		theme,
		{ path: file },
	);
	return component.render(80).join("\n");
}

test("read result does not render terminal controls from file bytes", () => {
	const osc52 = "\x1b]52;c;aGVsbG8=\x07";
	const title = "\x1b]0;pwn-title\x07";
	const csi = "\x1b[2J";
	const dcs = "\x1bP+payload\x1b\\";
	const c1 = "\u009d0;c1title\u009c";
	const rendered = renderRead(
		`keep${osc52}tail\nbefore${title}after\nx${csi}cleared\nd${dcs}e\nc${c1}z\nconst value = 1;`,
	);
	expect(rendered).not.toContain("\x1b]52;");
	expect(rendered).not.toContain("\x1b]0;pwn-title");
	expect(rendered).not.toContain("\x1b[2J");
	expect(rendered).not.toContain("\x1bP+payload");
	expect(rendered).not.toContain("\u009d");
	expect(rendered).not.toContain("aGVsbG8=");
	expect(rendered).not.toContain("pwn-title");
	expect(rendered).toContain("keep");
	expect(rendered).toContain("tail");
	expect(rendered).toContain("before");
	expect(rendered).toContain("after");
	expect(rendered).toContain("cleared");
	expect(rendered).toContain("const value = 1;");
});

test("strips controls before the line cap and a narrow wrap", () => {
	const osc = "\x1b]52;c;aGVsbG8=\x07";
	const capped = renderCell(`keep${osc}tail\nsecond-line`, "text", undefined, 80, 1);
	expect(capped).not.toContain("\x1b]52;");
	expect(capped).not.toContain("aGVsbG8=");
	expect(capped).toContain("keep");
	expect(capped).toContain("tail");
	expect(capped).not.toContain("second-line");
	const narrow = renderCell(`keep${osc}tail-and-more-text`, "text", undefined, 12);
	expect(narrow).not.toContain("\x1b]52;");
	expect(narrow).not.toContain("aGVsbG8=");
	expect(narrow).toContain("keep");
});

test("still allows ordinary source, brackets, whitespace, and a tab", () => {
	const rendered = renderCell("  Keep MixedCase\n\n\talpha\nsee [31m] and ESC c later\nconst value = 1;");
	expect(rendered).toContain("Keep MixedCase");
	expect(rendered).toContain("alpha");
	expect(rendered).toContain("[31m]");
	expect(rendered).toContain("ESC c later");
	expect(rendered).toContain("const value = 1;");
});

test("still allows a highlighted language to show the source text", () => {
	const rendered = renderCell("const value = 1;", "ts");
	expect(rendered).toContain("const");
	expect(rendered).toContain("value");
});

test("keeps an existing SGR sequence in the output section", () => {
	const rendered = renderCell("body", "text", "\x1b[31mkept-output\x1b[0m");
	expect(rendered).toContain("body");
	expect(rendered).toContain("kept-output");
	expect(rendered).toContain("\x1b[31mkept-output");
});

test("keeps CR overwrite and treats CRLF as LF", () => {
	const overwritten = renderCell("hidden\rvisible");
	expect(overwritten).toContain("visible");
	expect(overwritten).not.toContain("hidden");
	const lf = renderCell("alpha\nbravo");
	expect(renderCell("alpha\r\nbravo")).toBe(lf);
	expect(lf).toContain("alpha");
	expect(lf).toContain("bravo");
	expect(lf).not.toContain("alphabravo");
});

test("property: injected terminal controls are absent from the code cell, fc.property seed 62911, numRuns 64", () => {
	const mark = fc.stringMatching(/^[A-Za-z]{6,12}$/);
	const wrapper = fc.constantFrom(
		(value: string) => `\x1b]0;${value}\x07`,
		(value: string) => `\x1b]52;c;${value}\x07`,
		(value: string) => `\x1bP${value}\x1b\\`,
		(_value: string) => `\x1b[2J`,
		(value: string) => `\u009d${value}\u009c`,
	);
	fc.assert(
		fc.property(fc.string({ maxLength: 24 }), mark, wrapper, (prefix, token, wrap) => {
			fc.pre(!prefix.includes(token) && !prefix.includes("\x1b") && !prefix.includes("\u009d"));
			const sequence = wrap(token);
			const rendered = renderCell(`${prefix}keep${sequence}tail`);
			const payloadStripped =
				sequence.startsWith("\x1b]0;") || sequence.startsWith("\x1b]52;") || sequence.startsWith("\x1bP");
			return (
				!rendered.includes(sequence) &&
				!rendered.includes("\u009d") &&
				rendered.includes("keep") &&
				rendered.includes("tail") &&
				(!payloadStripped || !rendered.includes(token))
			);
		}),
		{ seed: 62911, numRuns: 64 },
	);
});

test("property: printable source and CR overwrite stay stable, fc.property seed 62912, numRuns 64", () => {
	const word = fc.stringMatching(/^[a-z]{3,8}$/);
	fc.assert(
		fc.property(word, word, (left, right) => {
			fc.pre(left !== right);
			const plain = renderCell(`${left} ${right}`);
			const overwritten = renderCell(`${left}\r${right}`);
			const crlf = renderCell(`${left}\r\n${right}`);
			const lf = renderCell(`${left}\n${right}`);
			return (
				plain.includes(left) &&
				plain.includes(right) &&
				overwritten.includes(right) &&
				!overwritten.includes(left) &&
				crlf === lf &&
				lf.includes(left) &&
				lf.includes(right)
			);
		}),
		{ seed: 62912, numRuns: 64 },
	);
});
