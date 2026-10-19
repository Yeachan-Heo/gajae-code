import { describe, expect, it } from "bun:test";
import { replaceTabs } from "@gajae-code/tui";
import { sanitizeText } from "@gajae-code/utils";
import { getThemeByName } from "../../src/modes/theme/theme";
import { astEditToolRenderer } from "../../src/tools/ast-edit";
import { astGrepToolRenderer } from "../../src/tools/ast-grep";
import { findToolRenderer } from "../../src/tools/find";
import { renderTreeList } from "../../src/tui/tree-list";

const ESC = "\u001b";
const BEL = "\u0007";
const MARKER = "visible-marker";
const POISON = `${ESC}]0;pwned-title${BEL}${MARKER}${ESC}]8;;https://attacker.invalid${BEL}link-label${ESC}]8;;${BEL}${ESC}]52;c;cGF5bG9hZA==${BEL}`;

const stubTheme = {
	fg: (_color: string, text: string) => text,
	tree: { branch: "├", last: "└", vertical: "│", horizontal: "─", hook: "╰" },
} as Parameters<typeof renderTreeList>[1];

function assertNoOsc(text: string): void {
	expect(text).not.toContain(`${ESC}]0;`);
	expect(text).not.toContain(`${ESC}]8;`);
	expect(text).not.toContain(`${ESC}]52;`);
	expect(text).not.toContain("attacker.invalid");
	expect(text).not.toContain("pwned-title");
	expect(text).not.toContain("cGF5bG9hZA");
	expect(text).toContain(MARKER);
	expect(text).toContain("link-label");
}

describe("tool tree render controls", () => {
	it("hides osc controls in ast grep, ast edit, and find results", async () => {
		const theme = await getThemeByName("red-claw");
		expect(theme).toBeDefined();
		const uiTheme = theme!;
		const opts = { expanded: true, isPartial: false };
		const display = `  1: ${POISON}`;
		const grep = astGrepToolRenderer.renderResult(
			{
				content: [{ type: "text", text: display }],
				details: { matchCount: 1, fileCount: 1, filesSearched: 1, displayContent: display, searchPath: "proj" },
			} as never,
			opts,
			uiTheme,
			{ pat: "needle" },
		);
		const edit = astEditToolRenderer.renderResult(
			{
				content: [{ type: "text", text: display }],
				details: {
					totalReplacements: 1,
					filesTouched: 1,
					filesSearched: 1,
					displayContent: display,
					searchPath: "proj",
				},
			} as never,
			opts,
			uiTheme,
			{ ops: [{ pat: "needle" }] },
		);
		const found = findToolRenderer.renderResult(
			{ content: [{ type: "text", text: POISON }] } as never,
			opts,
			uiTheme,
			{ paths: ["src"] },
		);
		const grepErr = astGrepToolRenderer.renderResult(
			{ content: [{ type: "text", text: POISON }], isError: true } as never,
			opts,
			uiTheme,
		);
		const editErr = astEditToolRenderer.renderResult(
			{ content: [{ type: "text", text: POISON }], isError: true } as never,
			opts,
			uiTheme,
		);
		const findErr = findToolRenderer.renderResult(
			{ content: [{ type: "text", text: POISON }], isError: true } as never,
			opts,
			uiTheme,
		);
		for (const component of [grep, edit, found, grepErr, editErr, findErr]) {
			assertNoOsc(component.render(200).join("\n"));
		}
	});

	it("keeps ordinary ast grep, ast edit, and find result text", async () => {
		const theme = await getThemeByName("red-claw");
		expect(theme).toBeDefined();
		const uiTheme = theme!;
		const opts = { expanded: true, isPartial: false };
		const display = "  1: plain-keep";
		const grep = astGrepToolRenderer.renderResult(
			{
				content: [{ type: "text", text: display }],
				details: { matchCount: 1, fileCount: 1, filesSearched: 1, displayContent: display, searchPath: "proj" },
			} as never,
			opts,
			uiTheme,
			{ pat: "needle" },
		);
		const edit = astEditToolRenderer.renderResult(
			{
				content: [{ type: "text", text: display }],
				details: {
					totalReplacements: 1,
					filesTouched: 1,
					filesSearched: 1,
					displayContent: display,
					searchPath: "proj",
				},
			} as never,
			opts,
			uiTheme,
			{ ops: [{ pat: "needle" }] },
		);
		const found = findToolRenderer.renderResult(
			{ content: [{ type: "text", text: "src/plain-keep.ts" }] } as never,
			opts,
			uiTheme,
			{ paths: ["src"] },
		);
		const err = findToolRenderer.renderResult(
			{ content: [{ type: "text", text: "disk full" }], isError: true } as never,
			opts,
			uiTheme,
		);
		expect(grep.render(200).join("\n")).toContain("plain-keep");
		expect(edit.render(200).join("\n")).toContain("plain-keep");
		expect(found.render(200).join("\n")).toContain("src/plain-keep.ts");
		expect(err.render(200).join("\n")).toContain("disk full");
	});

	it("property: tree list display lines match sanitizeText, seed 446, 64 inputs", () => {
		const seed = 446;
		let state = seed >>> 0;
		const next = () => {
			state = (state + 0x6d2b79f5) | 0;
			let t = Math.imul(state ^ (state >>> 15), 1 | state);
			t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
			return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
		};
		const alphabet = "abcDEF012 ._-:/";
		const injections = [
			`${ESC}]0;TITLE${BEL}`,
			`${ESC}]8;;https://attacker.invalid${BEL}`,
			`${ESC}]52;c;QQ==${BEL}`,
			`${ESC}[31m`,
			"\u0000",
			"\u007f",
		];
		for (let i = 0; i < 64; i++) {
			const n = 1 + Math.floor(next() * 24);
			let input = "";
			for (let k = 0; k < n; k++) {
				input +=
					next() < 0.25
						? injections[Math.floor(next() * injections.length)]!
						: alphabet[Math.floor(next() * alphabet.length)]!;
			}
			const expected = replaceTabs(sanitizeText(input));
			const renderInput = (value: string) =>
				renderTreeList({ items: [value], expanded: true, renderItem: line => line }, stubTheme);
			const lines = renderInput(input);
			if (expected.length === 0) expect(lines).toHaveLength(0);
			else expect(lines).toEqual([`└ ${expected}`]);
			expect(renderInput(expected)).toEqual(lines);
		}
	});
});
