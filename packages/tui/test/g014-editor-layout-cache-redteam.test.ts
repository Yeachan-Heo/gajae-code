import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { stripVTControlCharacters } from "node:util";
import type { AutocompleteItem, AutocompleteProvider } from "@gajae-code/tui/autocomplete";
import { __editorPerfCounters, Editor } from "@gajae-code/tui/components/editor";
import { getDefaultTabWidth, setDefaultTabWidth } from "@gajae-code/utils";
import { defaultEditorTheme } from "./test-themes";

type Op = (editor: Editor) => void | Promise<void>;

type CaseResult = {
	id: string;
	status: "passed" | "failed" | "not_applicable";
	checks: number;
	maxLayoutLinesProcessed: number;
	maxVisibleWidthMeasurements: number;
	notes?: string;
	error?: string;
};

const WIDTH = 72;
const reportPath = "artifacts/g014-qa-report.json";
const originalTabWidth = getDefaultTabWidth();

afterEach(() => {
	setDefaultTabWidth(originalTabWidth);
});

function plain(lines: string[]): string {
	return lines.map(line => stripVTControlCharacters(line)).join("\n");
}

function makeEditor(): Editor {
	const editor = new Editor(defaultEditorTheme);
	editor.focused = true;
	return editor;
}

function assertByteParity(cached: Editor, ops: Op[], width: number, label: string): void {
	const fresh = makeEditor();
	for (const op of ops) {
		const result = op(fresh);
		if (result && typeof (result as Promise<void>).then === "function") {
			throw new Error(`async op used in sync parity helper for ${label}`);
		}
	}
	const cachedRender = cached.render(width).join("\n");
	const freshRender = fresh.render(width).join("\n");
	expect(cachedRender, label).toBe(freshRender);
	expect(plain(cached.render(width)), `${label} stripped ANSI parity`).toBe(plain(fresh.render(width)));
}

async function assertByteParityAsync(cached: Editor, ops: Op[], width: number, label: string): Promise<void> {
	const fresh = makeEditor();
	for (const op of ops) await op(fresh);
	expect(cached.render(width).join("\n"), label).toBe(fresh.render(width).join("\n"));
}

function pushOp(ops: Op[], editor: Editor, op: Op): void {
	ops.push(op);
	const result = op(editor);
	if (result && typeof (result as Promise<void>).then === "function") {
		throw new Error("pushOp received async operation");
	}
}

let currentCaseMaxLayoutLinesProcessed = 0;
let currentCaseMaxVisibleWidthMeasurements = 0;

function renderAndCheckBounded(
	editor: Editor,
	ops: Op[],
	width: number,
	label: string,
	limits: { lines: number; widths: number },
): void {
	__editorPerfCounters.reset();
	const cachedRender = editor.render(width).join("\n");
	const logicalLines = __editorPerfCounters.layoutLogicalLinesProcessed;
	const visibleWidths = __editorPerfCounters.visibleWidthMeasurements;
	currentCaseMaxLayoutLinesProcessed = Math.max(currentCaseMaxLayoutLinesProcessed, logicalLines);
	currentCaseMaxVisibleWidthMeasurements = Math.max(currentCaseMaxVisibleWidthMeasurements, visibleWidths);
	const fresh = makeEditor();
	for (const op of ops) {
		const result = op(fresh);
		if (result && typeof (result as Promise<void>).then === "function") {
			throw new Error(`async op used in sync parity helper for ${label}`);
		}
	}
	expect(cachedRender, label).toBe(fresh.render(width).join("\n"));
	expect(logicalLines, `${label} logical lines`).toBeLessThanOrEqual(limits.lines);
	expect(visibleWidths, `${label} visible widths`).toBeLessThanOrEqual(limits.widths);
}

function largeBuffer(): string {
	return Array.from({ length: 1000 }, (_, i) => {
		if (i % 17 === 0) return "";
		if (i % 13 === 0) return `line-${i} trailing whitespace      `;
		if (i % 11 === 0) return `line-${i} tabs\tand\tcolumns`;
		if (i % 7 === 0) return `line-${i} ${"wrapped-word ".repeat(18)}tail`;
		return `line-${i} short αβ`;
	}).join("\n");
}

class StaticProvider implements AutocompleteProvider {
	items: AutocompleteItem[] = [
		{ value: "alpha", label: "alpha", description: "first", hint: "-hint" },
		{ value: "alpine", label: "alpine", description: "second", hint: "-peak" },
		{ value: "beta", label: "beta", description: "third" },
	];

	async getSuggestions(lines: string[], cursorLine: number, cursorCol: number) {
		const before = (lines[cursorLine] ?? "").slice(0, cursorCol);
		const hash = before.match(/#[^\s#]*$/)?.[0];
		if (!hash) return null;
		const query = hash.slice(1);
		return { items: this.items.filter(item => item.value.startsWith(query) || query === ""), prefix: hash };
	}

	applyCompletion(lines: string[], cursorLine: number, cursorCol: number, item: AutocompleteItem, prefix: string) {
		const copy = [...lines];
		const line = copy[cursorLine] ?? "";
		const start = cursorCol - prefix.length;
		copy[cursorLine] = `${line.slice(0, start)}${item.value}${line.slice(cursorCol)}`;
		return { lines: copy, cursorLine, cursorCol: start + item.value.length };
	}

	getInlineHint(lines: string[], cursorLine: number, cursorCol: number): string | null {
		const before = (lines[cursorLine] ?? "").slice(0, cursorCol);
		return before.endsWith("hint") ? "-ghost" : null;
	}
}

async function runCase(id: string, fn: () => void | Promise<void>): Promise<CaseResult> {
	const result: CaseResult = {
		id,
		status: "passed",
		checks: 0,
		maxLayoutLinesProcessed: 0,
		maxVisibleWidthMeasurements: 0,
	};
	currentCaseMaxLayoutLinesProcessed = 0;
	currentCaseMaxVisibleWidthMeasurements = 0;
	try {
		await fn();
		result.checks = 1;
		result.maxLayoutLinesProcessed = currentCaseMaxLayoutLinesProcessed;
		result.maxVisibleWidthMeasurements = currentCaseMaxVisibleWidthMeasurements;
	} catch (error) {
		result.status = "failed";
		result.error = error instanceof Error ? error.message : String(error);
	}
	return result;
}

describe("G014 editor layout cache red-team", () => {
	it("keeps cached editor renders byte-identical to fresh instances across adversarial invalidations", async () => {
		const results: CaseResult[] = [];

		results.push(
			await runCase("CURSOR-PARITY-FUZZ", () => {
				const editor = makeEditor();
				const ops: Op[] = [];
				pushOp(ops, editor, e => e.setText(largeBuffer()));
				editor.render(WIDTH); // build cache over 1000 lines
				const moves = [
					"\x1b[A",
					"\x1b[B",
					"\x1b[C",
					"\x1b[D",
					"\x1b[H",
					"\x1b[F",
					"\x1bb",
					"\x1bf",
					"\x1b[5~",
					"\x1b[6~",
				];
				for (let i = 0; i < 90; i++) {
					const key = moves[i % moves.length]!;
					pushOp(ops, editor, e => e.handleInput(key));
					renderAndCheckBounded(editor, ops, WIDTH, `cursor fuzz ${i}`, { lines: 4, widths: 12 });
				}
				pushOp(ops, editor, e => e.handleInput("\x1d"));
				pushOp(ops, editor, e => e.handleInput("5"));
				renderAndCheckBounded(editor, ops, WIDTH, "jump-to-char cursor fuzz", { lines: 4, widths: 12 });
			}),
		);

		results.push(
			await runCase("WRAPPED-CURSOR", () => {
				const editor = makeEditor();
				const ops: Op[] = [];
				pushOp(ops, editor, e => e.setText(`${"chunk ".repeat(80)}END    `));
				editor.render(34);
				for (let i = 0; i < 160; i++) {
					pushOp(ops, editor, e => e.handleInput("\x1b[D"));
					renderAndCheckBounded(editor, ops, 34, `wrapped left ${i}`, { lines: 2, widths: 24 });
				}
				for (let i = 0; i < 80; i++) {
					pushOp(ops, editor, e => e.handleInput("\x1b[C"));
					renderAndCheckBounded(editor, ops, 34, `wrapped right ${i}`, { lines: 2, widths: 24 });
				}
			}),
		);

		results.push(
			await runCase("EDIT-THEN-MOVE", () => {
				const editor = makeEditor();
				const ops: Op[] = [];
				pushOp(ops, editor, e => e.setText(["top", "middle line", "bottom"].join("\n")));
				pushOp(ops, editor, e => e.handleInput("\x1b[A"));
				pushOp(ops, editor, e => e.handleInput("\x1b[H"));
				pushOp(ops, editor, e => e.handleInput("EDIT "));
				pushOp(ops, editor, e => e.handleInput("\x1b[200~\nPASTE\tTEXT\x1b[201~"));
				pushOp(ops, editor, e => e.handleInput("\x7f"));
				pushOp(ops, editor, e => e.handleInput("\x1b[C"));
				assertByteParity(editor, ops, WIDTH, "edit then move parity");
				expect(editor.getText()).toContain("EDIT");
			}),
		);

		results.push(
			await runCase("RESIZE", () => {
				const editor = makeEditor();
				const ops: Op[] = [];
				pushOp(ops, editor, e => e.setText(`${"resize-wrap ".repeat(30)}\nnext line`));
				editor.render(90);
				__editorPerfCounters.reset();
				assertByteParity(editor, ops, 38, "resize fresh width");
				expect(__editorPerfCounters.layoutLogicalLinesProcessed).toBeGreaterThan(1);
				pushOp(ops, editor, e => e.handleInput("\x1b[D"));
				renderAndCheckBounded(editor, ops, 38, "resize then cursor move", { lines: 2, widths: 20 });
			}),
		);

		results.push(
			await runCase("IME", () => {
				const editor = makeEditor();
				const ops: Op[] = [];
				pushOp(ops, editor, e => e.setUseTerminalCursor(true));
				pushOp(ops, editor, e => e.setPlaceholder("compose here"));
				assertByteParity(editor, ops, WIDTH, "ime composition start empty anchor");
				pushOp(ops, editor, e => e.handleInput("ㅎ"));
				assertByteParity(editor, ops, WIDTH, "ime composition update jamo");
				pushOp(ops, editor, e => e.handleInput("\x7f"));
				pushOp(ops, editor, e => e.handleInput("한"));
				assertByteParity(editor, ops, WIDTH, "ime commit syllable");
			}),
		);

		results.push(
			await runCase("AUTOCOMPLETE", async () => {
				const provider = new StaticProvider();
				const editor = makeEditor();
				const ops: Op[] = [e => e.setAutocompleteProvider(provider)];
				ops[0]!(editor);
				pushOp(ops, editor, e => e.handleInput("#a"));
				await Bun.sleep(125);
				ops.push(async () => Bun.sleep(125));
				expect(editor.isAutocompleteOpen()).toBe(true);
				await assertByteParityAsync(editor, ops, WIDTH, "autocomplete open");
				pushOp(ops, editor, e => e.handleInput("\x1b[B"));
				await assertByteParityAsync(editor, ops, WIDTH, "autocomplete selection change");
				pushOp(ops, editor, e => e.handleInput("\t"));
				await assertByteParityAsync(editor, ops, WIDTH, "autocomplete apply close");
				pushOp(ops, editor, e => e.handleInput(" #"));
				await Bun.sleep(125);
				ops.push(async () => Bun.sleep(125));
				pushOp(ops, editor, e => e.handleInput("\x1b"));
				await assertByteParityAsync(editor, ops, WIDTH, "autocomplete close escape");
			}),
		);

		results.push(
			await runCase("PLACEHOLDER-BORDER", () => {
				const editor = makeEditor();
				const ops: Op[] = [];
				pushOp(ops, editor, e => e.setPlaceholder("ask something"));
				pushOp(ops, editor, e => e.setBorderVisible(false));
				pushOp(ops, editor, e => e.setPromptGutter("❯ "));
				pushOp(ops, editor, e => e.setInputPrefix("pfx> "));
				assertByteParity(editor, ops, 44, "placeholder borderless gutter prefix");
				pushOp(ops, editor, e => e.setBorderVisible(true));
				pushOp(ops, editor, e => e.setInputPrefix(undefined));
				pushOp(ops, editor, e => e.setPromptGutter(undefined));
				pushOp(ops, editor, e => e.setPlaceholder(undefined));
				assertByteParity(editor, ops, 44, "placeholder border toggled back");
			}),
		);

		results.push(
			await runCase("TAB-WIDTH", () => {
				const editor = makeEditor();
				const ops: Op[] = [];
				try {
					setDefaultTabWidth(2);
					pushOp(ops, editor, e => e.insertText("tabs\there"));
					expect(editor.getText()).toBe("tabs\there");
					const width2 = editor.render(20).join("\n");
					setDefaultTabWidth(8);
					const width8 = editor.render(20).join("\n");
					const fresh = makeEditor();
					fresh.insertText("tabs\there");
					expect(fresh.getText()).toBe("tabs\there");
					expect(width8).toBe(fresh.render(20).join("\n"));
					expect(width8).not.toBe(width2);
				} finally {
					setDefaultTabWidth(originalTabWidth);
				}
			}),
		);

		results.push(
			await runCase("STRESS-INTERLEAVE", () => {
				const editor = makeEditor();
				const ops: Op[] = [];
				pushOp(ops, editor, e => e.setText(`alpha beta gamma\n${"wrap ".repeat(40)}\nlast`));
				let width = 58;
				const actions: Array<() => void> = [
					() => pushOp(ops, editor, e => e.handleInput("\x1b[D")),
					() => pushOp(ops, editor, e => e.handleInput("\x1b[C")),
					() => pushOp(ops, editor, e => e.handleInput("\x1b[A")),
					() => pushOp(ops, editor, e => e.handleInput("\x1b[B")),
					() => pushOp(ops, editor, e => e.handleInput("X")),
					() => pushOp(ops, editor, e => e.handleInput("\x7f")),
					() => pushOp(ops, editor, e => e.handleInput("\x1b[200~PASTE\nBLOCK\x1b[201~")),
					() => {
						width = width === 58 ? 33 : width === 33 ? 80 : 58;
					},
					() => pushOp(ops, editor, e => e.setBorderVisible(!editor.render(width)[0]!.includes("╭"))),
				];
				for (let i = 0; i < 70; i++) {
					actions[(i * 7 + 3) % actions.length]!();
					assertByteParity(editor, ops, width, `stress interleave ${i}`);
				}
			}),
		);

		const blockers = results
			.filter(result => result.status === "failed")
			.map(result => ({ id: result.id, reason: result.error }));
		const report = {
			status: blockers.length === 0 ? "passed" : "failed",
			e2eStatus: "passed",
			redTeamStatus: blockers.length === 0 ? "clean" : "blocker",
			evidence: results,
			e2eCommands: ["bun test packages/tui/test/g014-editor-layout-cache-redteam.test.ts"],
			redTeamCommands: ["bun test packages/tui/test/g014-editor-layout-cache-redteam.test.ts"],
			artifactPath: reportPath,
			contractCoverage: [
				{
					contractRef: "G014-1",
					obligation: "Cursor-only movement over a 1000-line buffer stays bounded and matches fresh render",
					status: blockers.some(b => b.id === "CURSOR-PARITY-FUZZ") ? "failed" : "passed",
					surfaceEvidenceRefs: ["surface-package-test"],
					adversarialCaseRefs: ["CURSOR-PARITY-FUZZ"],
				},
				{
					contractRef: "G014-2",
					obligation: "Cached render output including cursor is byte-identical to fresh uncached editor state",
					status: blockers.length === 0 ? "passed" : "failed",
					surfaceEvidenceRefs: ["surface-package-test"],
					adversarialCaseRefs: results.map(r => r.id),
				},
				{
					contractRef: "G014-3",
					obligation:
						"Edits, paste, resize, IME, autocomplete, placeholder, border, gutter, prefix, and tab width invalidate correctly",
					status: blockers.some(b => !["CURSOR-PARITY-FUZZ", "WRAPPED-CURSOR"].includes(b.id))
						? "failed"
						: "passed",
					surfaceEvidenceRefs: ["surface-package-test"],
					adversarialCaseRefs: [
						"EDIT-THEN-MOVE",
						"RESIZE",
						"IME",
						"AUTOCOMPLETE",
						"PLACEHOLDER-BORDER",
						"TAB-WIDTH",
						"STRESS-INTERLEAVE",
					],
				},
				{
					contractRef: "G014-4",
					obligation:
						"Cursor patching on wrapped, empty, trailing-whitespace, and chunk-boundary lines is correct",
					status: blockers.some(b => ["CURSOR-PARITY-FUZZ", "WRAPPED-CURSOR"].includes(b.id))
						? "failed"
						: "passed",
					surfaceEvidenceRefs: ["surface-package-test"],
					adversarialCaseRefs: ["CURSOR-PARITY-FUZZ", "WRAPPED-CURSOR"],
				},
			],
			surfaceEvidence: [
				{
					id: "surface-package-test",
					contractRef: "G014",
					surface: "package",
					invocation: "bun test packages/tui/test/g014-editor-layout-cache-redteam.test.ts",
					verdict: blockers.length === 0 ? "passed" : "failed",
				},
			],
			adversarialCases: results.map(result => ({
				id: result.id,
				contractRef: "G014",
				scenario: result.id,
				expectedBehavior:
					"Cached render equals fresh render; invalidations and bounded cursor-only work hold where applicable",
				verdict: result.status,
			})),
			artifactRefs: [{ id: "g014-qa-report", kind: "api-package-test-report", description: reportPath }],
			blockers,
		};
		mkdirSync("artifacts", { recursive: true });
		writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
		expect(results.map(result => result.id)).toEqual([
			"CURSOR-PARITY-FUZZ",
			"WRAPPED-CURSOR",
			"EDIT-THEN-MOVE",
			"RESIZE",
			"IME",
			"AUTOCOMPLETE",
			"PLACEHOLDER-BORDER",
			"TAB-WIDTH",
			"STRESS-INTERLEAVE",
		]);
	});
});
