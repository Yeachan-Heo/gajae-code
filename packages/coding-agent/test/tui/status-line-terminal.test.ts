import { beforeAll, expect, test } from "bun:test";
import fc from "fast-check";
import { initTheme, theme } from "../../src/modes/theme/theme";
import { renderStatusLine } from "../../src/tui/status-line";

beforeAll(async () => {
	await initTheme();
});

test("status line strips terminal controls from title, description, badge, and meta", () => {
	const osc52 = "\x1b]52;c;aGVsbG8=\x07";
	const oscTitle = "\x1b]0;pwn-title\x07";
	const csi = "\x1b[2J";
	const dcs = "\x1bP+payload\x1b\\";
	const c1 = "\u009d0;c1title\u009c";

	const rendered = renderStatusLine(
		{
			icon: "pending",
			title: `Read${oscTitle}`,
			description: `notes/${osc52}file.txt${csi}`,
			badge: { label: `badge${dcs}`, color: "accent" },
			meta: [`meta1${c1}`, "meta2"],
		},
		theme,
	);

	expect(rendered).not.toContain("\x1b]52;");
	expect(rendered).not.toContain("aGVsbG8=");
	expect(rendered).not.toContain("\x1b]0;pwn-title");
	expect(rendered).not.toContain("pwn-title");
	expect(rendered).not.toContain("\x1b[2J");
	expect(rendered).not.toContain("\x1bP+payload");
	expect(rendered).not.toContain("\u009d");
	expect(rendered).toContain("Read");
	expect(rendered).toContain("notes/file.txt");
	expect(rendered).toContain("badge");
	expect(rendered).toContain("meta1");
	expect(rendered).toContain("meta2");
});

test("flattens newlines in description and meta to preserve single-line rendering", () => {
	const rendered = renderStatusLine(
		{
			title: "Bash",
			description: "echo 1\necho 2\r\necho 3",
			meta: ["lineA\nlineB"],
		},
		theme,
	);

	expect(rendered).not.toContain("\n");
	expect(rendered).not.toContain("\r");
	expect(rendered).toContain("echo 1 echo 2 echo 3");
	expect(rendered).toContain("lineA lineB");
});

test("preserves ordinary text, brackets, and status icon styling", () => {
	const rendered = renderStatusLine(
		{
			icon: "success",
			title: "Find",
			description: "src/**/*.ts",
			badge: { label: "12 files", color: "accent" },
			meta: ["15ms"],
		},
		theme,
	);

	expect(rendered).toContain("Find");
	expect(rendered).toContain("src/**/*.ts");
	expect(rendered).toContain("12 files");
	expect(rendered).toContain(theme.format.bracketLeft);
	expect(rendered).toContain(theme.format.bracketRight);
	expect(rendered).toContain("15ms");
});

test("preserves caller-provided SGR styles in description and meta", () => {
	const styledMeta = theme.fg("error", "1 failed");
	const styledDesc = theme.fg("accent", "src/tools/write.ts");

	const rendered = renderStatusLine(
		{
			title: "Job",
			description: styledDesc,
			meta: [styledMeta, "3 passed"],
		},
		theme,
	);

	expect(rendered).toContain(styledMeta);
	expect(rendered).toContain(styledDesc);
	expect(rendered).toContain("3 passed");
});

test("strips injected controls embedded inside caller-styled text", () => {
	const maliciousPath = "src/evil\x1b]52;c;payload\x07\x1b[2Jfile.ts";
	const styledDesc = theme.fg("accent", maliciousPath);

	const rendered = renderStatusLine(
		{
			title: "Write",
			description: styledDesc,
		},
		theme,
	);

	expect(rendered).not.toContain("\x1b]52;");
	expect(rendered).not.toContain("payload");
	expect(rendered).not.toContain("\x1b[2J");
	expect(rendered).toContain("src/evilfile.ts");
	expect(rendered).toContain(theme.fg("accent", "src/evilfile.ts"));
});

test("property: status line strips arbitrary terminal controls, fc.property seed 71291, numRuns 64", () => {
	const mark = fc.stringMatching(/^[A-Za-z]{6,12}$/);
	const wrapper = fc.constantFrom(
		(value: string) => `\x1b]0;${value}\x07`,
		(value: string) => `\x1b]52;c;${value}\x07`,
		(value: string) => `\x1bP${value}\x1b\\`,
		(_value: string) => `\x1b[2J`,
		(value: string) => `\u009d${value}\u009c`,
	);

	fc.assert(
		fc.property(fc.string({ maxLength: 16 }), mark, wrapper, (prefix, token, wrap) => {
			fc.pre(!prefix.includes(token) && !prefix.includes("\x1b") && !prefix.includes("\u009d"));
			const sequence = wrap(token);
			const rendered = renderStatusLine(
				{
					title: "Tool",
					description: `${prefix}path/${sequence}/test`,
				},
				theme,
			);
			const payloadStripped =
				sequence.startsWith("\x1b]0;") || sequence.startsWith("\x1b]52;") || sequence.startsWith("\x1bP");
			return (
				!rendered.includes(sequence) &&
				!rendered.includes("\u009d") &&
				rendered.includes("path/") &&
				rendered.includes("/test") &&
				(!payloadStripped || !rendered.includes(token))
			);
		}),
		{ seed: 71291, numRuns: 64 },
	);
});
