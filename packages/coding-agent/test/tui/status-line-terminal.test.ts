import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import fc from "fast-check";
import { resetSettingsForTest, Settings, settings } from "../../src/config/settings";
import { initTheme, theme } from "../../src/modes/theme/theme";
import { fileHyperlink } from "../../src/tui/hyperlink";
import { renderStatusLine } from "../../src/tui/status-line";

beforeAll(async () => {
	await initTheme();
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
});

afterAll(() => {
	resetSettingsForTest();
});

afterEach(() => {
	settings.clearOverride("tui.hyperlinks");
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

test("preserves OSC 8 fileHyperlink markup in description when hyperlinks are enabled", () => {
	settings.override("tui.hyperlinks", "always");
	const linkedPath = fileHyperlink("/repo/src/tools/read.ts", theme.fg("accent", "src/tools/read.ts"));

	const rendered = renderStatusLine(
		{
			title: "Read",
			description: linkedPath,
		},
		theme,
	);

	expect(rendered).toContain("\x1b]8;");
	expect(rendered).toContain("\x1b]8;;\x1b\\");
	expect(rendered).toContain("file:///repo/src/tools/read.ts");
	expect(rendered).toContain("src/tools/read.ts");
});

test("strips injected terminal controls while preserving OSC 8 file hyperlinks", () => {
	settings.override("tui.hyperlinks", "always");
	const evilAnchor = `src/\x1b]52;c;payload\x07\x1b[2Jread.ts`;
	const linkedPath = fileHyperlink("/repo/src/tools/read.ts", evilAnchor);

	const rendered = renderStatusLine(
		{
			title: "Read",
			description: linkedPath,
		},
		theme,
	);

	expect(rendered).toContain("\x1b]8;");
	expect(rendered).toContain("file:///repo/src/tools/read.ts");
	expect(rendered).not.toContain("\x1b]52;");
	expect(rendered).not.toContain("payload");
	expect(rendered).not.toContain("\x1b[2J");
	expect(rendered).toContain("src/read.ts");
});

test("normalizes horizontal tabs to spaces to prevent layout desynchronization", () => {
	const rendered = renderStatusLine(
		{
			title: "Search",
			description: "foo\tbar\tbaz",
		},
		theme,
	);

	expect(rendered).not.toContain("\t");
	expect(rendered).toContain("foo bar baz");
});

test("strips non-file OSC 8 hyperlinks and unterminated OSC 8 sequences", () => {
	// 1. BEL-terminated https OSC 8
	const httpsLink = "x\x1b]8;;https://evil.com\x07tail";
	const renderedHttps = renderStatusLine({ title: "Tool", description: httpsLink }, theme);
	expect(renderedHttps).not.toContain("https://evil.com");
	expect(renderedHttps).not.toContain("\x1b]8;");
	expect(renderedHttps).toContain("tail");

	// 2. Unterminated OSC 8 (missing ST/BEL)
	const unterminated = "a\x1b]8;;file:///etc/passwd tail";
	const renderedUnterminated = renderStatusLine({ title: "Tool", description: unterminated }, theme);
	expect(renderedUnterminated).not.toContain("\x1b]8;");
	expect(renderedUnterminated).toContain("a]8;;file:///etc/passwd tail");

	// 3. C1 8-bit unterminated or https OSC 8
	const c1Https = "a\u009d8;;https://evil.com\u009cb";
	const renderedC1 = renderStatusLine({ title: "Tool", description: c1Https }, theme);
	expect(renderedC1).not.toContain("https://evil.com");
	expect(renderedC1).not.toContain("\u009d");
	expect(renderedC1).toContain("ab");
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

test("linear scan prevents quadratic blowup on repeated unterminated control introducers", () => {
	const repeated = `cmd${"\x1b]".repeat(5000)}arg`;
	const rendered = renderStatusLine(
		{
			title: "SSH",
			description: `ssh user@host ${repeated}`,
		},
		theme,
	);
	expect(rendered).toContain("ssh user@host cmd");
	expect(rendered).toContain("arg");
	expect(rendered).not.toContain("\x1b");
});
