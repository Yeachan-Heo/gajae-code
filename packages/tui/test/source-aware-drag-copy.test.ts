import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { getDefaultTabWidth, setDefaultTabWidth } from "@gajae-code/utils";
import { Box } from "../src/components/box";
import { Markdown, type MarkdownTheme } from "../src/components/markdown";
import { type Component, TUI } from "../src/tui";
import { extractCopyRowAnnotation, getIndentation, retainCopyAnnotations, visibleWidth } from "../src/utils";
import { defaultMarkdownTheme } from "./test-themes";
import { VirtualTerminal } from "./virtual-terminal";

const box = {
	topLeft: "┌",
	topRight: "┐",
	bottomLeft: "└",
	bottomRight: "┘",
	horizontal: "─",
	vertical: "│",
	teeDown: "┬",
	teeUp: "┴",
	teeLeft: "┤",
	teeRight: "├",
	cross: "┼",
};
const theme: MarkdownTheme = {
	...defaultMarkdownTheme,
	symbols: { ...defaultMarkdownTheme.symbols, table: box, boxSharp: box },
};

type Point = [x: number, y: number];
type Send = (button: number, x: number, y: number, final: "M" | "m") => void;

const plain = (row: string): string => Bun.stripANSI(row).replace(/\x1b_[\s\S]*?(?:\x1b\\|\x07)/gu, "");
const lines = (rows: string[]): Component => ({ render: () => rows, invalidate: () => {} });

function renderRows(markdown: string, width: number): string[] {
	return new Markdown(markdown, 1, 0, theme).render(width);
}

function rowIndex(markdown: string, width: number, text: string): number {
	return renderRows(markdown, width).findIndex(row => plain(row).includes(text));
}

/** Drives raw SGR mouse input against a real TUI; coordinates are zero-based screen cells. */
async function mouseSession(
	component: Component,
	size: { columns: number; rows: number },
	script: (send: Send, tui: TUI) => Promise<void>,
): Promise<string | undefined> {
	const terminal = new VirtualTerminal(size.columns, size.rows);
	let copied: string | undefined;
	const tui = new TUI(terminal, undefined, {
		enableMouse: true,
		copySelection: text => {
			copied = text;
		},
		widthSettleMs: 0,
	});
	tui.addChild(component);
	tui.start();
	await terminal.waitForRender();
	try {
		await script((button, x, y, final) => terminal.sendInput(`\x1b[<${button};${x + 1};${y + 1}${final}`), tui);
		await terminal.waitForRender();
	} finally {
		tui.stop();
		tui.dispose();
	}
	return copied;
}

function dragComponent(component: Component, width: number, from: Point, to: Point): Promise<string | undefined> {
	return mouseSession(component, { columns: width, rows: 40 }, async send => {
		send(0, from[0], from[1], "M");
		send(32, to[0], to[1], "M");
		await Bun.sleep(20);
		send(0, to[0], to[1], "m");
	});
}

function dragCopy(markdown: string, width: number, from: Point, to: Point | "end"): Promise<string | undefined> {
	const end: Point = to === "end" ? [width - 1, renderRows(markdown, width).length - 1] : to;
	return dragComponent(new Markdown(markdown, 1, 0, theme), width, from, end);
}

describe("copy annotations without a copying TUI", () => {
	const corpus = "# t\n\n> q\n\n```sh\necho hi\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n- item";

	test("render() emits no copy escape sequences", () => {
		const rows = new Markdown(corpus, 1, 0, theme).render(40);
		expect(rows.filter(row => row.includes("\x1b_AGJC_COPY"))).toEqual([]);
	});

	test("an annotated render does not reach a later stock render of the same text", () => {
		const release = retainCopyAnnotations();
		const annotated = new Markdown(corpus, 1, 0, theme).render(40);
		release();
		const stock = new Markdown(corpus, 1, 0, theme).render(40);
		expect(annotated.some(row => row.includes("\x1b_AGJC_COPY:"))).toBe(true);
		expect(stock.filter(row => row.includes("\x1b_AGJC_COPY"))).toEqual([]);
	});

	test("a disposed TUI stops edge auto-scrolling", async () => {
		const numbered = Array.from({ length: 30 }, (_, i) => `line ${i}`);
		const terminal = new VirtualTerminal(30, 10);
		const tui = new TUI(terminal, undefined, { enableMouse: true, copySelection: () => {}, widthSettleMs: 0 });
		const scroll = spyOn(tui, "scrollViewportBy");
		tui.addChild(lines(numbered));
		try {
			tui.start();
			await terminal.waitForRender();
			terminal.sendInput("\x1b[<0;30;10M");
			terminal.sendInput("\x1b[<32;1;1M");
			// Positive control: the held edge drag is auto-scrolling before dispose.
			await Bun.sleep(120);
			expect(scroll.mock.calls.length).toBeGreaterThan(0);
			tui.dispose();
			const calls = scroll.mock.calls.length;
			const before = terminal.getWriteLog().length;
			await Bun.sleep(200);
			expect(scroll.mock.calls.length).toBe(calls);
			expect(terminal.getWriteLog().length).toBe(before);
		} finally {
			tui.stop();
			tui.dispose();
		}
	});

	test("a failed terminal start leaves copy annotations off", () => {
		const terminal = new VirtualTerminal(30, 10);
		spyOn(terminal, "start").mockImplementation(() => {
			throw new Error("no tty");
		});
		const tui = new TUI(terminal, undefined, { enableMouse: true, copySelection: () => {}, widthSettleMs: 0 });
		expect(() => tui.start()).toThrow("no tty");
		const rows = new Markdown("failed start", 1, 0, theme).render(30);
		expect(rows.filter(row => row.includes("\x1b_AGJC_COPY"))).toEqual([]);
	});
});

describe("copy annotations under a copying TUI", () => {
	let release: () => void = () => {};
	beforeAll(() => {
		release = retainCopyAnnotations();
	});
	afterAll(() => release());

	const corpus = "# t\n\n> q\n\n```sh\necho hi\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n- item";

	test("renderer hints never leave the Markdown component", () => {
		const rows = renderRows(corpus, 40);
		expect(rows.some(row => row.includes("\x1b_AGJC_COPY:"))).toBe(true);
		expect(rows.filter(row => /AGJC_COPY_(CODE|TABLE|QUOTE)/u.test(row))).toEqual([]);
	});

	test("callers can still trim right padding", () => {
		for (const md of ["hello world", "- a\n- b"]) {
			const widths = new Markdown(md, 0, 0, theme).render(80).map(row => visibleWidth(`* ${row}`.trimEnd()));
			expect(Math.max(...widths)).toBeLessThan(20);
		}
	});

	test("no copy escape sequence reaches the terminal", async () => {
		const terminal = new VirtualTerminal(40, 12);
		const tui = new TUI(terminal, undefined, { enableMouse: true, copySelection: () => {}, widthSettleMs: 0 });
		tui.addChild(new Markdown(corpus, 1, 0, theme));
		try {
			tui.start();
			await terminal.waitForRender();
			terminal.sendInput("\x1b[<0;1;3M");
			terminal.sendInput("\x1b[<32;10;8M");
			await terminal.waitForRender();
		} finally {
			tui.stop();
			tui.dispose();
		}
		const written = terminal.getWriteLog().join("");
		expect(written).toContain("echo hi");
		expect(written).not.toContain("\x1b_AGJC_COPY");
	});

	test("a growing streamed token keeps already-painted rows byte-stable", () => {
		const md = new Markdown("", 1, 0, theme);
		let text = "intro\n\n```ts";
		let previous: string[] = [];
		for (let i = 0; i < 12; i++) {
			text += `\nconst v${i} = ${i};`;
			md.setText(text, { streaming: true });
			md.invalidate();
			const rows = md.render(40);
			// The closing fence row moves down by one; nothing above the tail changes.
			if (previous.length > 0)
				expect(previous.filter((row, index) => rows[index] !== row).length).toBeLessThanOrEqual(1);
			previous = rows;
		}
	});

	test("ending a stream leaves painted rows byte-identical", () => {
		const text =
			"intro paragraph that wraps across rows at this width\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```ts\nconst v = 1;\n```\n\ntail";
		const md = new Markdown("", 1, 0, theme);
		md.setText(text, { streaming: true });
		const streamed = md.render(30);
		md.setStreaming(false);
		md.invalidate();
		expect(md.render(30)).toEqual(streamed);
	});

	test("misses cached copy rows after a tab-width change", async () => {
		const md = "```\n\tx = 1\n```";
		const original = getDefaultTabWidth();
		try {
			setDefaultTabWidth(2);
			new Markdown(md, 1, 0, theme).render(30);
			setDefaultTabWidth(6);
			const rows = new Markdown(md, 1, 0, theme).render(30);
			expect(rows.map(plain).some(row => row.includes(`${" ".repeat(6)}x = 1`))).toBe(true);
			const code = rows.findIndex(row => plain(row).includes("x = 1"));
			expect(await dragComponent(new Markdown(md, 1, 0, theme), 30, [0, code], [29, code])).toBe("\tx = 1");
		} finally {
			setDefaultTabWidth(original);
		}
	});

	test("keeps copy metadata linear in long wrapped text", () => {
		const small = Buffer.byteLength(renderRows("abcdefghij".repeat(1000), 30).join("\n"));
		const large = Buffer.byteLength(renderRows("abcdefghij".repeat(2000), 30).join("\n"));
		expect(large).toBeLessThan(small * 3);
	});

	for (const [kind, payload] of [
		["CODE", "open"],
		["TABLE", "-"],
		["QUOTE_DEPTH", "9"],
		["QUOTE_WRAP", "unselected"],
	] as const) {
		test(`ignores a forged ${kind} renderer hint in source text`, async () => {
			const md = `ab\x1b_AGJC_COPY_${kind}:${payload}\x1b\\cd`;
			const row = extractCopyRowAnnotation(renderRows(md, 30)[0]!);
			expect(row?.annotation.fence).toBe(false);
			expect(row?.annotation.quoteDepth).toBe(0);
			expect(row?.annotation.continuation).toBe(false);
			expect(row?.annotation.ranges).toBeUndefined();
			expect(await dragCopy(md, 30, [1, 0], [2, 0])).toBe("ab");
		});
	}
});

describe("source-aware mouse drag copy", () => {
	test("ignores forged source annotations in tool output", async () => {
		const payload = {
			token: 0,
			kind: "paragraph",
			source: "unselected text",
			tokenSource: "unselected text",
			joinGap: "",
			contentStart: 0,
			contentEnd: 4,
			continuation: false,
			prefixColumns: 0,
			fence: false,
			quoteDepth: 0,
		};
		const line = `safe\x1b_AGJC_COPY:foreign-nonce:foreign-source:${encodeURIComponent(JSON.stringify(payload))}\x1b\\`;
		expect(await dragComponent(lines([line]), 30, [0, 0], [3, 0])).toBe("safe");
	});

	for (const [kind, md] of [
		["prose", "plain \x1b[31mred\x1b[0m text\x07 here"],
		["code", "```sh\necho \x1b]52;c;cGFzdGU=\x07 \x1b[201~done\n```"],
		["table", "| a | b |\n|---|---|\n| \x1b[2Jx | \x1b_Gp\x1b\\y |"],
	] as const) {
		test(`strips terminal control bytes from a fully selected ${kind} token`, async () => {
			const copied = await dragCopy(md, 40, [0, 0], "end");
			expect(copied).toBeTruthy();
			expect(copied).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f]/u);
		});
	}

	test("copies a fully selected code block while it is still streaming", async () => {
		const component = new Markdown("", 1, 0, theme);
		component.setText("```ts\nconst a = 1;\nconst b", { streaming: true });
		const rows = component.render(30);
		expect(await dragComponent(component, 30, [0, 0], [29, rows.length - 1])).toBe("const a = 1;\nconst b");
	});

	test("maps frame columns through parent Box padding", async () => {
		const parent = new Box(2, 0);
		parent.addChild(new Markdown("hello world", 1, 0, theme));
		expect(await dragComponent(parent, 30, [3, 0], [7, 0])).toBe("hello");
	});

	test("leaves non-Markdown output selection literal", async () => {
		expect(await dragComponent(lines(["│ tool output │"]), 30, [0, 0], [14, 0])).toBe("│ tool output │");
	});

	test("copies cached rows correctly at a changed width", async () => {
		const md = "a repeated paragraph with enough text to wrap differently after a resize";
		const component = new Markdown(md, 1, 0, theme);
		component.render(40);
		const rows = component.render(20);
		expect(await dragComponent(component, 20, [0, 0], [19, rows.length - 1])).toBe(md);
	});

	test("copies the finalized streamed content rather than an older parse", async () => {
		const md = "finalized streamed paragraph with enough text to wrap at this width";
		const component = new Markdown("old content", 1, 0, theme);
		component.setStreaming(true);
		component.render(30);
		component.setText(md, { streaming: true });
		component.setStreaming(false);
		const rows = component.render(30);
		expect(await dragComponent(component, 30, [0, 0], [29, rows.length - 1])).toBe(md);
	});

	test("joins prose soft wraps without presentation padding", async () => {
		const md = "First paragraph is long enough that it must wrap across several terminal rows here.";
		expect(await dragCopy(md, 30, [0, 0], "end")).toBe(md);
	});

	test("keeps paragraph separation", async () => {
		expect(await dragCopy("hello world\n\nsecond para", 30, [0, 0], "end")).toBe("hello world\n\nsecond para");
	});

	test("copies a partial row only", async () => {
		expect(await dragCopy("hello world", 30, [7, 0], [11, 0])).toBe("world");
	});

	test("handles backward selection", async () => {
		expect(await dragCopy("hello world", 30, [11, 0], [7, 0])).toBe("world");
	});

	test("joins a partial selection crossing a soft wrap", async () => {
		expect(await dragCopy("abcdefghij klmnopqrst uvwxyz", 14, [6, 0], [5, 1])).toBe("fghij klmno");
	});

	test("joins repeated identical wrap rows by position", async () => {
		expect(await dragCopy("abcdefghijabcdefghijabcdefghij", 12, [6, 0], [5, 1])).toBe("fghijabcde");
	});

	test("joins wraps around inline styling by visible coordinates", async () => {
		expect(await dragCopy("**abcdefghij** klmnopqrst uvwxyz", 14, [6, 0], [5, 1])).toBe("fghij klmno");
	});

	test("keeps list content", async () => {
		const md = "- first item with a long description that wraps\n- second item";
		expect(await dragCopy(md, 30, [0, 0], "end")).toBe(md);
	});

	test("keeps unicode graphemes", async () => {
		const md = "한글 문장과 emoji 👩‍💻가 여러 화면 줄에 걸쳐 표시됩니다.";
		expect(await dragCopy(md, 20, [0, 0], "end")).toBe(md);
	});

	test("copies visible structure when tab expansion changed block structure", async () => {
		// A tab-indented list item becomes a quote continuation after expansion, so
		// the original-spelling token no longer matches and is not trusted; the copy
		// keeps the rendered rows (list, quote, indented continuation) as painted.
		const md = "1. g\n> e\n\t- d";
		expect(await dragCopy(md, 40, [0, 0], "end")).toBe("1. g\n> e\n   - d");
	});
});

describe("source-aware drag copy of quotes", () => {
	test("joins a partial quote selection across its internal wrap", async () => {
		expect(await dragCopy("> abcdefghij klmnopqrst uvwxyz", 14, [8, 0], [7, 1])).toBe("fghij klmno");
	});

	test("maps selected nested quote prefixes to Markdown", async () => {
		expect(await dragCopy("> > hello world", 30, [0, 0], [9, 0])).toBe("> > hello");
	});

	test("removes quote borders while preserving quote semantics", async () => {
		const text = "quoted line that also wraps because it is long enough to wrap";
		expect(await dragCopy(`> ${text}`, 30, [0, 0], "end")).toBe(`> ${text}`);
	});

	test("removes code presentation indentation inside a quote", async () => {
		const md = "> ```sh\n> echo hello\n> ```";
		const row = rowIndex(md, 30, "echo hello");
		expect(await dragCopy(md, 30, [0, row], [8, row])).toBe("> echo");
	});

	test("does not copy a selection of only the quote margin", async () => {
		expect(await dragCopy("> hello world", 30, [0, 0], [1, 0])).toBeUndefined();
	});

	test("keeps a blank quoted line inside a quote selection", async () => {
		expect(await dragCopy("> a\n>\n> b", 30, [0, 0], [29, 2])).toBe("> a\n>\n> b");
	});

	test("preserves original tabs on covered code rows inside a quote", async () => {
		const md = "> intro\n>\n> ```\n> a\tb\n> c\n> ```";
		const row = rowIndex(md, 40, "a   ");
		expect(await dragCopy(md, 40, [0, row], [39, row])).toBe("> a\tb");
		expect(await dragCopy(md, 40, [0, row], [39, row + 1])).toBe("> a\tb\n> c");
	});

	test("preserves a tab at the wrap of a code row inside nested quotes", async () => {
		const md = "> > ```\n> > abcdefghij\tklmnopqrstuvwxyz0123456789\n> > ```";
		const rows = renderRows(md, 24);
		const first = rowIndex(md, 24, "abcdefghij");
		expect(await dragCopy(md, 24, [0, first], [23, rows.length - 2])).toBe(
			"> > abcdefghij\tklmnopqrstuvwxyz0123456789",
		);
	});

	test("maps each code block of a quote onto its own original lines", async () => {
		const md = "> ```\n> q\tw\n> ```\n>\n> ```\n> a\tb\n> ```";
		const row = rowIndex(md, 40, "a   ");
		expect(await dragCopy(md, 40, [0, row], [39, row])).toBe("> a\tb");
	});
});

describe("source-aware drag copy of code blocks", () => {
	test("does not remove code characters on continuation rows", async () => {
		expect(await dragCopy("```sh\nabcdefghij klmnopqrst uvwxyz\n```", 14, [8, 1], [5, 2])).toBe("fghij klmno");
	});

	test("preserves blank lines inside selected code", async () => {
		const md = "```sh\necho first\n\necho second\n```";
		const first = rowIndex(md, 30, "echo first");
		const second = rowIndex(md, 30, "echo second");
		expect(await dragCopy(md, 30, [0, first], [29, second])).toBe("echo first\n\necho second");
	});

	test("keeps literal box-drawing characters in code", async () => {
		const md = "```txt\n│ literal ─ text\n```";
		const row = rowIndex(md, 30, "literal");
		expect(await dragCopy(md, 30, [0, row], [29, row])).toBe("│ literal ─ text");
	});

	test("does not mistake literal backticks for presentation fences", async () => {
		const md = "````txt\n``` not a fence\nordinary\n````";
		const row = rowIndex(md, 30, "not a fence");
		expect(await dragCopy(md, 30, [0, row], [29, row])).toBe("``` not a fence");
	});

	test("preserves original code tabs", async () => {
		const code = "function x() {\n\treturn 1;\n}";
		expect(await dragCopy(`\`\`\`js\n${code}\n\`\`\``, 30, [0, 0], "end")).toBe(code);
	});

	test("drops both fences when a code block ends with a newline", async () => {
		expect(await dragCopy("```sh\necho hi\n```\n", 30, [0, 0], "end")).toBe("echo hi");
	});

	test("preserves tabs on a complete selected code line without fences", async () => {
		const md = "```js\nfunction x() {\n\treturn 1;\n}\n```";
		const row = rowIndex(md, 30, "return 1;");
		expect(await dragCopy(md, 30, [0, row], [29, row])).toBe("\treturn 1;");
	});

	test("does not restore unselected characters after a wrapped tab span", async () => {
		const width = getIndentation() + 12;
		expect(await dragCopy("```txt\n\tabcd efghijklmnopqrstuvwxyz\n```", width, [0, 1], [width - 1, 1])).toBe(
			"\tabcd",
		);
	});

	test("restores tab indentation across code wraps without selecting fences", async () => {
		const width = getIndentation() + 12;
		const code = "\tabcdefghijklmnopqrstuvwxyz";
		const md = `\`\`\`txt\n${code}\n\`\`\``;
		const last = renderRows(md, width).length - 2;
		expect(await dragCopy(md, width, [0, 1], [width - 1, last])).toBe(code);
	});

	test("does not reuse tab source for visually identical spaces", async () => {
		const spaces = `${" ".repeat(getIndentation())}return 1;`;
		await dragCopy("```js\n\treturn 1;\n```", 30, [0, 0], "end");
		expect(await dragCopy(`\`\`\`js\n${spaces}\n\`\`\``, 30, [0, 0], "end")).toBe(spaces);
	});

	test("keeps fences in a mixed Markdown selection", async () => {
		const md = "intro\n\n```sh\necho hi\n```\n\noutro";
		expect(await dragCopy(md, 30, [0, 0], "end")).toBe(md);
	});

	test("restores wrapped code but preserves actual indent and newlines", async () => {
		const source = 'if (ready) {\n    run("long argument that wraps across the screen");\n}';
		expect(await dragCopy(`\`\`\`ts\n${source}\n\`\`\``, 30, [0, 0], "end")).toBe(source);
	});

	test("drops list and code indent from a code row inside a list item", async () => {
		const md = "- item\n\n  ```js\n  const x = 1;\n  ```";
		const row = rowIndex(md, 40, "const x");
		expect(await dragCopy(md, 40, [0, row], [39, row])).toBe("const x = 1;");
	});

	test("copies rendered list code when no original tab survives", async () => {
		// marked expands list-item tabs to four spaces before lexing the item's code,
		// so the original lex holds no tab to restore; the copy is the rendered row.
		const md = "- item\n\n  ```\n  a\tb\n  ```";
		const row = rowIndex(md, 40, "a ");
		expect(await dragCopy(md, 40, [0, row], [39, row])).toBe(plain(renderRows(md, 40)[row]!).trim());
	});

	test("copies only selected code content", async () => {
		const md = "```sh\necho hello\necho world\n```";
		const row = rowIndex(md, 30, "echo hello");
		expect(row).toBeGreaterThanOrEqual(0);
		expect(await dragCopy(md, 30, [8, row], [12, row])).toBe("hello");
	});

	test("does not confuse identical prose and code rows", async () => {
		const md = "same\n\n```txt\nsame\n```";
		const row = renderRows(md, 30)
			.map(plain)
			.findLastIndex(text => text.trim() === "same");
		expect(await dragCopy(md, 30, [0, row], [29, row])).toBe("same");
	});
});

describe("source-aware drag copy of tables", () => {
	const table = "| a | b |\n| --- | --- |\n| 1 | 2 |";

	test("copies tables without box drawing", async () => {
		expect(await dragCopy(table, 30, [0, 0], "end")).toBe(table);
	});

	test("does not copy an unselected table cell", async () => {
		const row = rowIndex(table, 30, "│ 1 │ 2 │");
		expect(await dragCopy(table, 30, [3, row], [3, row])).toBe("1");
		expect(await dragCopy(table, 30, [2, row], [3, row])).not.toContain("2");
	});

	test("does not copy table border decoration", async () => {
		expect(await dragCopy(table, 30, [2, 0], [4, 0])).toBeUndefined();
	});

	test("keeps selected table cells separated without border rows", async () => {
		const md = "| aa | bb |\n| --- | --- |\n| cc | dd |";
		const header = rowIndex(md, 30, "aa │ bb");
		const data = rowIndex(md, 30, "cc │ dd");
		expect(await dragCopy(md, 30, [3, header], [9, data])).toBe("aa\tbb\ncc\tdd");
	});

	test("copies a partial cell of a table inside a quote", async () => {
		const md = "> | name | value |\n> |---|---|\n> | alpha | beta |";
		const row = rowIndex(md, 40, "alpha");
		const col = plain(renderRows(md, 40)[row]!).indexOf("alpha");
		expect(await dragCopy(md, 40, [col, row], [col + 4, row])).toBe("alpha");
	});

	describe("with a soft-wrapped cell", () => {
		const wrapped = "| col | v |\n|---|---|\n| alpha beta gamma delta epsilon | x |";
		const at = (text: string): Point => {
			const row = rowIndex(wrapped, 24, text);
			return [plain(renderRows(wrapped, 24)[row]!).indexOf(text), row];
		};

		test("joins a partial selection across the wrap without presentation newlines", async () => {
			const [col, row] = at("alpha");
			const [, next] = at("gamma");
			expect(await dragCopy(wrapped, 24, [col, row], [col + 10, next])).toBe("alpha beta gamma delta\tx");
		});

		test("joins every wrapped row of the cell", async () => {
			const [col, row] = at("alpha");
			const [, last] = at("epsilon");
			expect(await dragCopy(wrapped, 24, [col, row], [23, last])).toBe("alpha beta gamma delta epsilon\tx");
		});

		test("drops cell padding from a single wrapped row", async () => {
			const [col, row] = at("alpha");
			expect(await dragCopy(wrapped, 24, [col, row], [23, row])).toBe("alpha beta\tx");
		});

		test("joins a wrapped header cell", async () => {
			const md = "| alpha beta gamma delta | v |\n|---|---|\n| 1 | 2 |";
			const first = rowIndex(md, 20, "alpha beta");
			const last = rowIndex(md, 20, "delta");
			expect(await dragCopy(md, 20, [0, first], [19, last])).toBe("alpha beta gamma delta\tv");
		});
	});

	test("preserves a literal border character inside a selected cell", async () => {
		const md = "| a | b |\n| --- | --- |\n| │ | 2 |";
		const row = rowIndex(md, 30, "│ │ │ 2 │");
		expect(await dragCopy(md, 30, [3, row], [3, row])).toBe("│");
	});
});

describe("source-aware drag copy of a clipped Markdown preview", () => {
	// Tool previews render Markdown and then keep only some rows, as eval does with its tail.
	const table = `| k | v |\n|---|---|\n${Array.from({ length: 12 }, (_, i) => `| r${i} | v${i} |`).join("\n")}`;
	const clipped = (keep: (rows: string[]) => string[]): Component => ({
		render: width => [...keep(new Markdown(table, 1, 0, theme).render(width)), "… more lines"],
		invalidate: () => {},
	});
	const dragAll = async (component: Component): Promise<string | undefined> => {
		const rows = component.render(40).length;
		// Stop on the last table row, before the trailing notice.
		return dragComponent(component, 40, [0, 0], [39, rows - 2]);
	};

	test("copies only the visible rows when the preview drops the table's head", async () => {
		const copied = await dragAll(clipped(rows => rows.slice(-6)));
		expect(copied).toContain("r11\tv11");
		expect(copied).not.toContain("r0");
		expect(copied).not.toContain("| k | v |");
	});

	test("copies only the visible rows when the preview drops the table's tail", async () => {
		const copied = await dragAll(clipped(rows => rows.slice(0, 6)));
		expect(copied).toContain("r1");
		expect(copied).not.toContain("r11");
		expect(copied).not.toContain("|---|");
	});

	test("still restores the original table when the preview shows all of it", async () => {
		expect(await dragAll(clipped(rows => rows))).toBe(table);
	});
});

describe("drag selection while the transcript scrolls", () => {
	const numbered = Array.from({ length: 30 }, (_, i) => `line ${String(i).padStart(2, "0")}`);
	const screen = { columns: 30, rows: 10 };
	const contiguousTail = (text: string | undefined): number => {
		const copiedLines = text?.split("\n") ?? [];
		const first = numbered.indexOf(copiedLines[0] ?? "");
		return first >= 0 && copiedLines.join("\n") === numbered.slice(first).join("\n") ? first : -1;
	};

	test("keeps a drag alive while the wheel scrolls the transcript", async () => {
		const copied = await mouseSession(lines(numbered), screen, async send => {
			send(0, 29, 9, "M");
			send(32, 0, 5, "M");
			for (let i = 0; i < 3; i++) send(64, 0, 5, "M");
			send(32, 0, 0, "M");
			await Bun.sleep(20);
			send(0, 0, 0, "m");
		});
		expect(contiguousTail(copied)).toBe(11);
	});

	test("auto-scrolls while the drag is held at the top edge", async () => {
		const copied = await mouseSession(lines(numbered), screen, async send => {
			send(0, 29, 9, "M");
			send(32, 0, 0, "M");
			await Bun.sleep(400);
			send(0, 0, 0, "m");
		});
		const first = contiguousTail(copied);
		expect(first).toBeGreaterThanOrEqual(0);
		expect(first).toBeLessThan(20);
	});

	test("stops edge scrolling when the live viewport cannot move", async () => {
		let scrolls = 0;
		await mouseSession(lines(numbered), screen, async (send, tui) => {
			const scroll = spyOn(tui, "scrollViewportBy");
			send(0, 5, 4, "M");
			send(32, 5, 9, "M");
			await Bun.sleep(300);
			send(0, 5, 9, "m");
			scrolls = scroll.mock.calls.length;
			scroll.mockRestore();
		});
		expect(scrolls).toBeLessThanOrEqual(1);
	});

	test("edge-scrolls down from the last visible transcript row in history", async () => {
		const copied = await mouseSession(lines(numbered), screen, async send => {
			for (let i = 0; i < 3; i++) send(64, 0, 5, "M");
			send(0, 0, 4, "M");
			send(32, 29, 9, "M");
			await Bun.sleep(300);
			send(0, 29, 9, "m");
		});
		const copiedLines = copied?.split("\n") ?? [];
		expect(copiedLines[0]).toBe("line 15");
		expect(numbered.indexOf(copiedLines.at(-1) ?? "")).toBeGreaterThan(20);
	});

	test("edge-scrolls up after returning to the press row", async () => {
		const copied = await mouseSession(lines(numbered), screen, async send => {
			for (let i = 0; i < 3; i++) send(64, 0, 5, "M");
			send(0, 29, 0, "M");
			send(32, 29, 1, "M");
			send(32, 29, 0, "M");
			await Bun.sleep(300);
			send(0, 0, 0, "m");
		});
		expect(numbered.indexOf(copied?.split("\n")[0] ?? "")).toBeLessThan(11);
	});

	test("resolves a wheel step at the reported pointer row", async () => {
		let selectionStartLine: number | undefined;
		await mouseSession(lines(numbered), screen, async (send, tui) => {
			send(0, 29, 9, "M");
			send(32, 0, 5, "M");
			send(64, 0, 2, "M");
			await Bun.sleep(30);
			selectionStartLine = tui.getViewportObservation()?.selection?.start.line;
			send(0, 0, 2, "m");
		});
		// Observation rows are screen-relative; a stale drag pointer would report row 5.
		expect(selectionStartLine).toBe(2);
	});

	test("extends to line end when dragging below a single visible row", async () => {
		const copied = await mouseSession(lines(["hello world"]), screen, async send => {
			send(0, 0, 0, "M");
			send(32, 0, 1, "M");
			send(0, 0, 1, "m");
		});
		expect(copied).toBe("hello world");
	});

	test("resolves the endpoint after the wheel returns to the live view", async () => {
		const copied = await mouseSession(lines(numbered), screen, async send => {
			send(64, 0, 5, "M");
			send(0, 0, 5, "M");
			send(32, 29, 6, "M");
			send(65, 29, 6, "M");
			send(0, 29, 6, "m");
		});
		expect(copied).toBe(numbered.slice(22, 27).join("\n"));
	});

	test("keeps the selection when the drag leaves the terminal", async () => {
		const copied = await mouseSession(lines(numbered), screen, async send => {
			send(0, 0, 5, "M");
			send(32, 40, 30, "M");
			send(0, 40, 30, "m");
		});
		expect(copied).toBe(numbered.slice(25).join("\n"));
	});
});
