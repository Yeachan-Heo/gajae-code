import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { visibleWidth } from "@gajae-code/tui/utils";
import { SelectList } from "../src/components/select-list";
import { KeybindingsManager, setKeybindings, TUI_KEYBINDINGS } from "../src/keybindings";

const testTheme = {
	selectedPrefix: (text: string) => text,
	selectedText: (text: string) => text,
	description: (text: string) => text,
	scrollInfo: (text: string) => text,
	noMatch: (text: string) => text,
	symbols: {
		cursor: "→",
		inputCursor: "|",
		hrChar: "─",
		quoteBorder: "│",
		boxRound: { topLeft: "╭", topRight: "╮", bottomLeft: "╰", bottomRight: "╯", horizontal: "─", vertical: "│" },
		boxSharp: {
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
		},
		table: {
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
		},
		spinnerFrames: ["|"],
	},
};

const visibleIndexOf = (line: string, text: string): number => {
	const index = line.indexOf(text);
	expect(index).not.toBe(-1);
	return visibleWidth(line.slice(0, index));
};

describe("SelectList", () => {
	beforeEach(() => {
		setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
	});

	afterEach(() => {
		setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
	});

	it("normalizes multiline descriptions to single line", () => {
		const items = [
			{
				value: "test",
				label: "test",
				description: "Line one\nLine two\nLine three",
			},
		];

		const list = new SelectList(items, 5, testTheme);
		const rendered = list.render(80);

		expect(rendered.length).toBeGreaterThanOrEqual(1);
		expect(rendered[0]).not.toContain("\n");
		expect(rendered[0]).toContain("Line one Line two Line three");
	});

	it("keeps descriptions aligned when the primary text is truncated", () => {
		const items = [
			{ value: "short", label: "short", description: "short description" },
			{
				value: "very-long-command-name-that-needs-truncation",
				label: "very-long-command-name-that-needs-truncation",
				description: "long description",
			},
		];

		const list = new SelectList(items, 5, testTheme);
		const rendered = list.render(80);

		expect(visibleIndexOf(rendered[0], "short description")).toBe(visibleIndexOf(rendered[1], "long description"));
	});

	it("uses the configured minimum primary column width", () => {
		const items = [
			{ value: "a", label: "a", description: "first" },
			{ value: "bb", label: "bb", description: "second" },
		];

		const list = new SelectList(items, 5, testTheme, {
			minPrimaryColumnWidth: 12,
			maxPrimaryColumnWidth: 20,
		});
		const rendered = list.render(80);

		expect(rendered[0].indexOf("first")).toBe(14);
		expect(rendered[1].indexOf("second")).toBe(14);
	});

	it("uses the configured maximum primary column width", () => {
		const items = [
			{
				value: "very-long-command-name-that-needs-truncation",
				label: "very-long-command-name-that-needs-truncation",
				description: "first",
			},
			{ value: "short", label: "short", description: "second" },
		];

		const list = new SelectList(items, 5, testTheme, {
			minPrimaryColumnWidth: 12,
			maxPrimaryColumnWidth: 20,
		});
		const rendered = list.render(80);

		expect(visibleIndexOf(rendered[0], "first")).toBe(22);
		expect(visibleIndexOf(rendered[1], "second")).toBe(22);
	});

	it("allows overriding primary truncation while preserving description alignment", () => {
		const items = [
			{
				value: "very-long-command-name-that-needs-truncation",
				label: "very-long-command-name-that-needs-truncation",
				description: "first",
			},
			{ value: "short", label: "short", description: "second" },
		];

		const list = new SelectList(items, 5, testTheme, {
			minPrimaryColumnWidth: 12,
			maxPrimaryColumnWidth: 12,
			truncatePrimary: ({ text, maxWidth }) => {
				if (text.length <= maxWidth) {
					return text;
				}

				return `${text.slice(0, Math.max(0, maxWidth - 1))}…`;
			},
		});
		const rendered = list.render(80);

		expect(rendered[0]).toContain("…");
		expect(visibleIndexOf(rendered[0], "first")).toBe(visibleIndexOf(rendered[1], "second"));
	});

	it("confirms the selected item when Enter arrives as LF", () => {
		const items = [{ value: "run", label: "run" }];
		const list = new SelectList(items, 5, testTheme);
		let selectedValue: string | undefined;
		list.onSelect = item => {
			selectedValue = item.value;
		};

		list.handleInput("\n");

		expect(selectedValue).toBe("run");
	});
	it("keeps populated confirm precedence when cancel also matches Enter", () => {
		setKeybindings(
			new KeybindingsManager(TUI_KEYBINDINGS, {
				"tui.select.cancel": "enter",
			}),
		);
		const list = new SelectList([{ value: "run", label: "run" }], 5, testTheme);
		let selectedValue: string | undefined;
		let cancelled = false;
		list.onSelect = item => {
			selectedValue = item.value;
		};
		list.onCancel = () => {
			cancelled = true;
		};

		list.handleInput("\n");

		expect(selectedValue).toBe("run");
		expect(cancelled).toBe(false);
	});
	it("allows cancelling when no filtered items are visible", () => {
		const list = new SelectList([{ value: "run", label: "run" }], 5, testTheme);
		let cancelled = false;
		list.onCancel = () => {
			cancelled = true;
		};

		list.setFilter("missing");
		list.handleInput("\x1b");

		expect(list.render(80)).toContain("  No matching commands");
		expect(cancelled).toBe(true);
	});

	it("preserves enabled-only callbacks when arrow navigation wraps to the same item", () => {
		const changed: string[] = [];
		const list = new SelectList([{ value: "only", label: "only" }], 5, testTheme);
		list.onSelectionChange = item => changed.push(item.value);

		list.handleInput("\x1b[B");
		list.handleInput("\x1b[A");

		expect(changed).toEqual(["only", "only"]);
	});

	it("preserves enabled-only callbacks at page boundaries", () => {
		const changed: string[] = [];
		const list = new SelectList(
			[
				{ value: "one", label: "one" },
				{ value: "two", label: "two" },
				{ value: "three", label: "three" },
			],
			2,
			testTheme,
		);
		list.onSelectionChange = item => changed.push(item.value);

		list.handleInput("\x1b[5~");
		list.setSelectedIndex(2);
		list.handleInput("\x1b[6~");

		expect(changed).toEqual(["one", "three"]);
	});

	it("dims disabled items and excludes them from selection", () => {
		const selected: string[] = [];
		const list = new SelectList(
			[
				{ value: "enabled", label: "enabled" },
				{ value: "blocked", label: "blocked", disabled: true },
			],
			5,
			{ ...testTheme, description: text => `<dim>${text}</dim>` },
		);
		list.onSelect = item => selected.push(item.value);

		const blockedLine = list.render(80).find(line => line.includes("blocked"));
		expect(blockedLine).toStartWith("<dim>");
		list.setSelectedIndex(1);
		expect(list.getSelectedItem()?.value).toBe("enabled");
		list.handleInput("\n");

		expect(selected).toEqual(["enabled"]);
	});

	it("keeps page navigation inside disabled boundaries", () => {
		const list = new SelectList(
			[
				{ value: "top-blocked", label: "top-blocked", disabled: true },
				{ value: "one", label: "one" },
				{ value: "middle-blocked", label: "middle-blocked", disabled: true },
				{ value: "three", label: "three" },
				{ value: "bottom-blocked", label: "bottom-blocked", disabled: true },
			],
			2,
			testTheme,
		);

		list.handleInput("\x1b[5~");
		expect(list.getSelectedItem()?.value).toBe("one");
		list.handleInput("\x1b[6~");
		expect(list.getSelectedItem()?.value).toBe("three");
		list.handleInput("\x1b[6~");
		expect(list.getSelectedItem()?.value).toBe("three");
	});

	it("skips disabled runs while wrapping arrow navigation", () => {
		const changed: string[] = [];
		const list = new SelectList(
			[
				{ value: "one", label: "one" },
				{ value: "blocked-a", label: "blocked-a", disabled: true },
				{ value: "blocked-b", label: "blocked-b", disabled: true },
				{ value: "four", label: "four" },
			],
			5,
			testTheme,
		);
		list.onSelectionChange = item => changed.push(item.value);

		list.handleInput("\x1b[B");
		list.handleInput("\x1b[B");
		list.handleInput("\x1b[A");

		expect(changed).toEqual(["four", "one", "four"]);
	});

	it("suppresses no-op callbacks when disabled items leave one enabled choice", () => {
		const changed: string[] = [];
		const list = new SelectList(
			[
				{ value: "off", label: "off" },
				{ value: "blocked-a", label: "blocked-a", disabled: true },
				{ value: "blocked-b", label: "blocked-b", disabled: true },
			],
			2,
			testTheme,
		);
		list.onSelectionChange = item => changed.push(item.value);

		list.handleInput("\x1b[B");
		list.handleInput("\x1b[A");
		list.handleInput("\x1b[6~");
		list.handleInput("\x1b[5~");

		expect(list.getSelectedItem()?.value).toBe("off");
		expect(changed).toEqual([]);
	});

	it("suppresses selection and callbacks when filtering to disabled items", () => {
		const selected: string[] = [];
		const changed: string[] = [];
		const list = new SelectList(
			[
				{ value: "enabled", label: "enabled" },
				{ value: "blocked", label: "blocked", disabled: true },
			],
			5,
			testTheme,
		);
		list.onSelect = item => selected.push(item.value);
		list.onSelectionChange = item => changed.push(item.value);

		list.setFilter("blocked");
		list.handleInput("\x1b[B");
		list.handleInput("\n");

		expect(list.getSelectedItem()).toBeNull();
		expect(selected).toEqual([]);
		expect(changed).toEqual([]);
	});

	it("resolves programmatic selection around disabled boundaries", () => {
		const list = new SelectList(
			[
				{ value: "one", label: "one" },
				{ value: "blocked-a", label: "blocked-a", disabled: true },
				{ value: "blocked-b", label: "blocked-b", disabled: true },
				{ value: "four", label: "four" },
				{ value: "blocked-end", label: "blocked-end", disabled: true },
			],
			5,
			testTheme,
		);

		list.setSelectedIndex(1);
		expect(list.getSelectedItem()?.value).toBe("four");
		list.setSelectedIndex(4);
		expect(list.getSelectedItem()?.value).toBe("four");
	});

	it("moves the viewport without creating a selection when every item is disabled", () => {
		const selected: string[] = [];
		const changed: string[] = [];
		const items = ["a", "b", "c", "d", "e", "f"].map(value => ({ value, label: value, disabled: true }));
		const list = new SelectList(items, 3, testTheme);
		list.onSelect = item => selected.push(item.value);
		list.onSelectionChange = item => changed.push(item.value);

		const firstPage = list.render(80);
		expect(firstPage).toContain("  a");
		expect(firstPage).toContain("  c");
		expect(firstPage).not.toContain("  d");
		expect(firstPage).toContain("  (-/6)");
		expect(firstPage.some(line => line.includes("→"))).toBe(false);

		list.handleInput("\x1b[6~"); // page down clamps to the last viewport
		const lastPage = list.render(80);
		expect(lastPage).not.toContain("  a");
		expect(lastPage).toContain("  d");
		expect(lastPage).toContain("  f");
		expect(lastPage).toContain("  (-/6)");

		list.handleInput("\x1b[5~"); // page up returns to the first viewport
		expect(list.render(80)).toContain("  a");
		list.handleInput("\x1b[A"); // up wraps the viewport to the end
		expect(list.render(80)).toContain("  f");
		list.handleInput("\x1b[B"); // down wraps it back to the start
		expect(list.render(80)).toContain("  a");

		list.setSelectedIndex(3); // programmatic navigation moves the viewport only
		expect(list.render(80)).toContain("  d");
		list.handleInput("\n");

		expect(list.getSelectedItem()).toBeNull();
		expect(selected).toEqual([]);
		expect(changed).toEqual([]);
	});

	it("regains a selection when a filter change re-exposes enabled items", () => {
		const list = new SelectList(
			[
				{ value: "enabled", label: "enabled" },
				{ value: "blocked", label: "blocked", disabled: true },
			],
			5,
			testTheme,
		);

		list.setFilter("blocked");
		expect(list.getSelectedItem()).toBeNull();

		list.setFilter("");
		expect(list.getSelectedItem()?.value).toBe("enabled");
	});
});
