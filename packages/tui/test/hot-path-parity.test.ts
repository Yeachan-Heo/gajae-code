import { describe, expect, it } from "bun:test";
import { Box } from "../src/components/box";
import { Editor } from "../src/components/editor";
import { Input } from "../src/components/input";
import { TUI } from "../src/tui";
import { __textHelperPerfCounters, applyBackgroundToLine, padding, visibleWidth } from "../src/utils";
import { defaultEditorTheme } from "./test-themes";
import { VirtualTerminal } from "./virtual-terminal";

class RecordingTerminal extends VirtualTerminal {
	writes: string[] = [];
	override write(data: string): void {
		this.writes.push(data);
		super.write(data);
	}
}

async function settle(term: VirtualTerminal): Promise<void> {
	await Bun.sleep(50);
	await term.flush();
}

function assertSameGeometry(actual: string[], expected: string[]): void {
	const normalize = (rows: string[]): string[] => {
		const normalized = rows.map(row => row.trimEnd());
		while (normalized.at(-1) === "") normalized.pop();
		return normalized;
	};
	expect(normalize(actual)).toEqual(normalize(expected));
}

async function capture(line: string): Promise<string> {
	const term = new RecordingTerminal(80, 8);
	const tui = new TUI(term);
	tui.addChild({ render: () => [line], invalidate() {} });
	try {
		tui.start();
		await settle(term);
		return term.writes.join("");
	} finally {
		tui.stop();
	}
}

describe("renderer hot-path byte parity", () => {
	it("detects interior and leading blank-row displacement", () => {
		expect(() => assertSameGeometry(["界", "", "X"], ["界", "X", ""])).toThrow();
		expect(() => assertSameGeometry(["", "界", "X"], ["界", "X", ""])).toThrow();
		assertSameGeometry(["界  ", "", "X", "", ""], ["界", "", "X"]);
	});

	it("preserves no-op text and complete non-erase CSI bytes", async () => {
		const input = "plain 界 👩🏽‍💻 \x1b[31mred\x1b[0m";
		expect(await capture(input)).toContain(input);
	});

	for (const [input, expected] of [
		["a\x1b[2Jb\x1b[Kc", "abc"],
		["a\x9b2Jb\x9b0Kc", "abc"],
		["a\x1b[12;", "a"],
		["a\x9b12;", "a"],
		["a\x1b[12;界b", "a界b"],
		["a\x1b[1 2Jb", "ab"],
		["a\x1b", "a"],
		["\x1b[J\x1b[K", ""],
		["a\x1b[31mb\x1b[Kc\x1b[0m", "a\x1b[31mbc\x1b[0m"],
	]) {
		it(`matches sanitized transaction for ${JSON.stringify(input)}`, async () => {
			expect(await capture(input!)).toBe(await capture(expected!));
		});
	}

	it("reuses warm widths for duplicate, styled, fitting and over-width rows", async () => {
		const term = new RecordingTerminal(12, 8);
		const tui = new TUI(term);
		// Avoid ZWJ sequences: emulator geometry varies across platforms; CJK has stable width 2.
		const lines = ["界".repeat(10), "界".repeat(10), "語", "\x1b[31m界\x1b[0m"];
		tui.addChild({ render: () => [...lines], invalidate() {} });
		try {
			tui.start();
			await settle(term);
			const before = term.getViewport();
			expect(before.slice(0, 4).map(line => line.trimEnd())).toEqual(["界".repeat(6), "界".repeat(6), "語", "界"]);
			__textHelperPerfCounters.reset();
			tui.requestRender(true);
			await settle(term);
			// Ignore cell padding and trailing empty viewport rows only; leading and
			// interior blank rows must retain their positions across a forced repaint.
			const after = term.getViewport();
			assertSameGeometry(after, before);
			expect(after.slice(0, 4).map(line => line.trimEnd())).toEqual(["界".repeat(6), "界".repeat(6), "語", "界"]);
			expect(__textHelperPerfCounters.visibleWidthsCalls).toBe(0);
			expect(__textHelperPerfCounters.truncateLinesToWidthCalls).toBe(0);
		} finally {
			tui.stop();
		}
	});
});

describe("first-grapheme cursor and delete parity", () => {
	for (const first of ["界", "👩🏽‍💻", "🇰🇷", "क़"]) {
		it(`moves and deletes whole ${first} graphemes on long suffixes`, () => {
			const suffix = "界👩🏽‍💻".repeat(500);
			const text = `${first}🇰🇷${suffix}`;
			const input = new Input();
			const editor = new Editor(defaultEditorTheme);
			input.setValue(text);
			editor.setText(text);
			for (const component of [input, editor]) {
				component.handleInput("\x01");
				component.handleInput("\x1b[C");
				expect(component.render(40).join("\n")).toContain("\x1b[7m🇰🇷");
				component.handleInput("\x1b[3~");
				component.handleInput("|");
			}
			expect(input.getValue()).toBe(`${first}|${suffix}`);
			expect(editor.getText()).toBe(`${first}|${suffix}`);
		});
	}
});

describe("box background row parity", () => {
	it("matches the previous pre-padded background bytes, including wide and ANSI rows", () => {
		const lines = ["", "界👩🏽‍💻", "\x1b[31mred\x1b[0m", "界".repeat(20)];
		const bg = (text: string): string => `\x1b[44m${text}\x1b[49m`;
		for (const width of [1, 12, 40]) {
			for (const background of [undefined, bg]) {
				const box = new Box(1, 1, background);
				box.addChild({ render: () => lines, invalidate() {} });
				const expected = ["", ...lines.map(line => ` ${line}`), ""].map(line => {
					const padded = line + padding(Math.max(0, width - visibleWidth(line)));
					return background ? applyBackgroundToLine(padded, width, background) : padded;
				});
				expect(box.render(width)).toEqual(expected);
			}
		}
	});
});
