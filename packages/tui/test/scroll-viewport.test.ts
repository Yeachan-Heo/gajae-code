import { describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { Editor, ScrollViewport, type ScrollViewportSource } from "@gajae-code/tui";
import { defaultEditorTheme } from "./test-themes";

interface RowRequest {
	width: number;
	startRow: number;
	endRow: number;
}

class MutableRowSource implements ScrollViewportSource {
	requests: RowRequest[] = [];

	constructor(public rows: string[]) {}

	getRowCount(_width: number): number {
		return this.rows.length;
	}

	renderRows(width: number, startRow: number, endRow: number): string[] {
		this.requests.push({ width, startRow, endRow });
		return this.rows.slice(startRow, endRow);
	}
}

class ReflowingRowSource implements ScrollViewportSource {
	constructor(
		public wideRows: string[],
		public narrowRows: string[],
	) {}

	#rows(width: number): string[] {
		return width >= 20 ? this.wideRows : this.narrowRows;
	}

	getRowCount(width: number): number {
		return this.#rows(width).length;
	}

	renderRows(width: number, startRow: number, endRow: number): string[] {
		return this.#rows(width).slice(startRow, endRow);
	}
}

class SemanticallyReflowingRowSource implements ScrollViewportSource {
	#currentRows: Array<{ id: string; graphemeOffset: number; text: string }> = [];
	appendedMessages = 0;
	captureRanges: Array<{ startRow: number; endRow: number }> = [];

	#rows(width: number): Array<{ id: string; graphemeOffset: number; text: string }> {
		const rows =
			width >= 20
				? [
						{ id: "a", graphemeOffset: 0, text: "a-wide" },
						{ id: "a", graphemeOffset: 8, text: "a-tail" },
						{ id: "b", graphemeOffset: 0, text: "b-wide" },
						{ id: "b", graphemeOffset: 8, text: "b-tail" },
						{ id: "c", graphemeOffset: 0, text: "c-wide" },
					]
				: [
						{ id: "a", graphemeOffset: 0, text: "a-narrow-0" },
						{ id: "a", graphemeOffset: 4, text: "a-narrow-1" },
						{ id: "a", graphemeOffset: 8, text: "a-narrow-2" },
						{ id: "b", graphemeOffset: 0, text: "b-narrow-0" },
						{ id: "b", graphemeOffset: 4, text: "b-narrow-1" },
						{ id: "b", graphemeOffset: 8, text: "b-narrow-2" },
						{ id: "c", graphemeOffset: 0, text: "c-narrow-0" },
					];
		for (let index = 1; index <= this.appendedMessages; index++) {
			rows.push({ id: `d-${index}`, graphemeOffset: 0, text: `d-${index}-0` });
			if (width < 20) rows.push({ id: `d-${index}`, graphemeOffset: 4, text: `d-${index}-1` });
		}
		return rows;
	}

	getRowCount(width: number): number {
		this.#currentRows = this.#rows(width);
		return this.#currentRows.length;
	}

	renderRows(_width: number, startRow: number, endRow: number): string[] {
		return this.#currentRows.slice(startRow, endRow).map(row => row.text);
	}

	captureReflowAnchor(startRow: number, endRow: number) {
		this.captureRanges.push({ startRow, endRow });
		const row = this.#currentRows.slice(startRow, endRow).at(0);
		return row ? { id: row.id, graphemeOffset: row.graphemeOffset, viewportRow: 0 } : undefined;
	}

	resolveReflowAnchor(anchor: { id: string; graphemeOffset: number }): number | undefined {
		const exact = this.#currentRows.findIndex(
			row => row.id === anchor.id && row.graphemeOffset === anchor.graphemeOffset,
		);
		return exact < 0 ? undefined : exact;
	}

	captureReflowSeenState(rowExclusive: number): unknown {
		const seen = new Map<string, number>();
		for (const row of this.#currentRows.slice(0, rowExclusive)) {
			seen.set(row.id, Math.max(seen.get(row.id) ?? 0, row.graphemeOffset + 1));
		}
		return seen;
	}

	resolveReflowUnseenRows(seenState: unknown): number | undefined {
		if (!(seenState instanceof Map)) return undefined;
		const seen = seenState as Map<unknown, unknown>;
		return this.#currentRows.filter(row => {
			const seenEnd = seen.get(row.id);
			return typeof seenEnd !== "number" || row.graphemeOffset >= seenEnd;
		}).length;
	}
}

const makeRows = (count: number): string[] => Array.from({ length: count }, (_value, index) => `row-${index}`);

const plain = (lines: string[]): string[] => lines.map(line => stripVTControlCharacters(line));

async function openAutocomplete(editor: Editor): Promise<void> {
	editor.setAutocompleteProvider({
		async getSuggestions() {
			return {
				items: [
					{ label: "one", value: "one" },
					{ label: "two", value: "two" },
					{ label: "three", value: "three" },
					{ label: "four", value: "four" },
				],
				prefix: "/",
			};
		},
		applyCompletion(lines, cursorLine, cursorCol) {
			return { lines, cursorLine, cursorCol };
		},
	});
	editor.handleInput("/");
	await Bun.sleep(0);
}

describe("ScrollViewport", () => {
	it("renders top, middle, and tail windows", () => {
		const source = new MutableRowSource(makeRows(10));
		const viewport = new ScrollViewport(source, { height: 3, followTail: false });

		expect(viewport.render(40)).toEqual(["row-0", "row-1", "row-2"]);

		viewport.setOffset(4);
		expect(viewport.render(40)).toEqual(["row-4", "row-5", "row-6"]);

		viewport.scrollToTail();
		expect(viewport.render(40)).toEqual(["row-7", "row-8", "row-9"]);
		expect(viewport.getState()).toEqual({
			offset: 7,
			height: 3,
			totalRows: 10,
			atTail: true,
			followTail: true,
			unseenRows: 0,
		});
	});

	it("pads short content above the transcript tail", () => {
		const viewport = new ScrollViewport(new MutableRowSource(["row"]), { height: 3 });

		expect(viewport.render(40)).toEqual(["", "", "row"]);
	});

	it("follows appended rows while pinned to the tail", () => {
		const source = new MutableRowSource(makeRows(5));
		const viewport = new ScrollViewport(source, { height: 2 });

		expect(viewport.render(20)).toEqual(["row-3", "row-4"]);
		source.rows.push("row-5", "row-6");

		expect(viewport.render(20)).toEqual(["row-5", "row-6"]);
		expect(viewport.getState().unseenRows).toBe(0);
	});

	it("keeps a paused window stable and reports appended unseen rows", () => {
		const source = new MutableRowSource(makeRows(5));
		const viewport = new ScrollViewport(source, { height: 2 });

		viewport.render(20);
		viewport.setFollowTail(false);
		source.rows.push("row-5", "row-6");

		expect(viewport.render(20)).toEqual(["row-3", "row-4"]);
		expect(viewport.getState()).toEqual({
			offset: 3,
			height: 2,
			totalRows: 7,
			atTail: false,
			followTail: false,
			unseenRows: 2,
		});

		viewport.scrollBy(2);
		expect(viewport.render(20)).toEqual(["row-5", "row-6"]);
		expect(viewport.getState()).toMatchObject({ atTail: true, followTail: false, unseenRows: 0 });

		source.rows.push("row-7");
		expect(viewport.render(20)).toEqual(["row-5", "row-6"]);
		expect(viewport.getState().unseenRows).toBe(1);

		viewport.scrollToTail();
		expect(viewport.render(20)).toEqual(["row-6", "row-7"]);
		expect(viewport.getState().unseenRows).toBe(0);
	});

	it("preserves distance from tail across paused wide-to-narrow reflow without false unseen rows", () => {
		const source = new ReflowingRowSource(makeRows(8), makeRows(12));
		const viewport = new ScrollViewport(source, { height: 3 });

		expect(viewport.render(40)).toEqual(["row-5", "row-6", "row-7"]);
		viewport.scrollBy(-2);

		expect(viewport.render(10)).toEqual(["row-7", "row-8", "row-9"]);
		expect(viewport.getState()).toMatchObject({ offset: 7, unseenRows: 0, followTail: false });
	});

	it("preserves distance from tail across paused narrow-to-wide reflow without false unseen rows", () => {
		const source = new ReflowingRowSource(makeRows(8), makeRows(12));
		const viewport = new ScrollViewport(source, { height: 3 });

		expect(viewport.render(10)).toEqual(["row-9", "row-10", "row-11"]);
		viewport.scrollBy(-2);

		expect(viewport.render(40)).toEqual(["row-3", "row-4", "row-5"]);
		expect(viewport.getState()).toMatchObject({ offset: 3, unseenRows: 0, followTail: false });
	});

	it("preserves the semantic reading point across width reflow when the source supplies anchors", () => {
		const viewport = new ScrollViewport(new SemanticallyReflowingRowSource(), { height: 2, followTail: false });

		expect(viewport.render(40)).toEqual(["a-wide", "a-tail"]);
		viewport.setOffset(2);
		expect(viewport.render(40)).toEqual(["b-wide", "b-tail"]);

		expect(viewport.render(10)).toEqual(["b-narrow-0", "b-narrow-1"]);
		expect(viewport.getState()).toMatchObject({ offset: 3, followTail: false, unseenRows: 0 });
	});

	it("keeps appended rows unseen when content growth and width reflow happen together", () => {
		const source = new SemanticallyReflowingRowSource();
		const viewport = new ScrollViewport(source, { height: 2 });

		viewport.render(40);
		viewport.setOffset(2);
		source.appendedMessages = 1;
		viewport.render(40);
		expect(viewport.getState().unseenRows).toBe(1);

		source.appendedMessages = 2;
		expect(viewport.render(10)).toEqual(["b-narrow-0", "b-narrow-1"]);
		expect(viewport.getState()).toMatchObject({ offset: 3, unseenRows: 4, followTail: false });
	});

	it("retains semantic unseen state across repeated width reflows", () => {
		const source = new SemanticallyReflowingRowSource();
		const viewport = new ScrollViewport(source, { height: 2 });

		viewport.render(40);
		viewport.setOffset(2);
		source.appendedMessages = 2;
		viewport.render(10);
		const firstUnseenRows = viewport.getState().unseenRows;
		expect(firstUnseenRows).toBe(4);

		viewport.render(40);
		expect(viewport.getState().unseenRows).toBe(2);
	});

	it("does not anchor width reflow to the row replaced by a one-row unseen indicator", () => {
		const source = new SemanticallyReflowingRowSource();
		const viewport = new ScrollViewport(source, { height: 1 });

		viewport.render(40);
		viewport.scrollBy(-1);
		source.appendedMessages = 1;
		viewport.render(40);
		expect(viewport.getState().unseenRows).toBe(1);

		viewport.render(10);
		expect(source.captureRanges.at(-1)).toEqual({ startRow: 3, endRow: 3 });
	});

	it("counts real appended rows as unseen when width is unchanged", () => {
		const source = new ReflowingRowSource(makeRows(8), makeRows(12));
		const viewport = new ScrollViewport(source, { height: 3 });

		viewport.render(40);
		viewport.scrollBy(-2);
		source.wideRows.push("row-8", "row-9");

		expect(viewport.render(40)).toEqual(["row-3", "row-4", "row-5"]);
		expect(viewport.getState().unseenRows).toBe(2);
	});

	it("clamps the offset when the source shrinks", () => {
		const source = new MutableRowSource(makeRows(10));
		const viewport = new ScrollViewport(source, { height: 3 });

		viewport.render(20);
		viewport.setFollowTail(false);
		source.rows = makeRows(4);

		expect(viewport.render(20)).toEqual(["row-1", "row-2", "row-3"]);
		expect(viewport.getState()).toMatchObject({ offset: 1, totalRows: 4, atTail: true, unseenRows: 0 });
	});

	it("recomputes and clamps the window when resized", () => {
		const source = new MutableRowSource(makeRows(10));
		const viewport = new ScrollViewport(source, { height: 3 });

		expect(viewport.render(20)).toEqual(["row-7", "row-8", "row-9"]);
		viewport.setHeight(5);
		expect(viewport.render(20)).toEqual(["row-5", "row-6", "row-7", "row-8", "row-9"]);

		viewport.setOffset(4);
		viewport.setHeight(9);
		expect(viewport.render(20)).toEqual(makeRows(10).slice(1));
		expect(viewport.getState().offset).toBe(1);
	});

	it("bounds source requests and applies overscan without rendering overscan rows", () => {
		const source = new MutableRowSource(makeRows(10));
		const viewport = new ScrollViewport(source, { height: 3, overscan: 2, followTail: false });

		expect(viewport.render(30)).toEqual(["row-0", "row-1", "row-2"]);
		expect(source.requests.at(-1)).toEqual({ width: 30, startRow: 0, endRow: 5 });

		viewport.setOffset(4);
		expect(viewport.render(30)).toEqual(["row-4", "row-5", "row-6"]);
		expect(source.requests.at(-1)).toEqual({ width: 30, startRow: 2, endRow: 9 });

		viewport.setOffset(999);
		expect(viewport.render(30)).toEqual(["row-7", "row-8", "row-9"]);
		expect(source.requests.at(-1)).toEqual({ width: 30, startRow: 5, endRow: 10 });

		viewport.setOffset(-10);
		expect(viewport.render(30)).toEqual(["row-0", "row-1", "row-2"]);
		expect(source.requests.at(-1)).toEqual({ width: 30, startRow: 0, endRow: 5 });

		viewport.setHeight(0);
		expect(viewport.render(30)).toEqual([]);
	});
});

describe("Editor autocomplete runtime row budget", () => {
	it("supports zero rows without closing or resetting autocomplete", async () => {
		const editor = new Editor(defaultEditorTheme);
		await openAutocomplete(editor);
		editor.setAutocompleteRowBudget(0);
		const hidden = editor.render(40);

		expect(editor.getAutocompleteRowBudget()).toBe(0);
		expect(editor.isAutocompleteOpen()).toBe(true);

		editor.handleInput("\x1b[B");
		editor.setAutocompleteRowBudget(1);
		const shown = plain(editor.render(40).slice(hidden.length));
		expect(shown).toHaveLength(1);
		expect(shown[0]).toContain("two");
	});

	it("keeps the selected item visible within one and two total rows", async () => {
		const editor = new Editor(defaultEditorTheme);
		editor.setAutocompleteMaxVisible(3);
		await openAutocomplete(editor);
		editor.handleInput("\x1b[B");
		editor.handleInput("\x1b[B");

		editor.setAutocompleteRowBudget(0);
		const editorRows = editor.render(40).length;

		editor.setAutocompleteRowBudget(1);
		const oneRow = plain(editor.render(40).slice(editorRows));
		expect(oneRow).toHaveLength(1);
		expect(oneRow[0]).toContain("three");

		editor.setAutocompleteRowBudget(2);
		const twoRows = plain(editor.render(40).slice(editorRows));
		expect(twoRows).toHaveLength(2);
		expect(twoRows[0]).toContain("three");
		expect(twoRows[1]).toContain("(3/4)");
	});

	it("preserves configured autocomplete output when the runtime budget is unset", async () => {
		const editor = new Editor(defaultEditorTheme);
		editor.setAutocompleteMaxVisible(3);
		await openAutocomplete(editor);

		editor.setAutocompleteRowBudget(0);
		const editorRows = editor.render(40).length;
		editor.setAutocompleteRowBudget(undefined);
		const autocompleteRows = editor.render(40).slice(editorRows);

		expect(editor.getAutocompleteRowBudget()).toBeUndefined();
		expect(autocompleteRows).toHaveLength(4);
	});
});
