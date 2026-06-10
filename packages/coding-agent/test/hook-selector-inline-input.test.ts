import { beforeAll, describe, expect, it } from "bun:test";
import { HookSelectorComponent } from "@gajae-code/coding-agent/modes/components/hook-selector";
import { getThemeByName, setThemeInstance } from "@gajae-code/coding-agent/modes/theme/theme";

beforeAll(async () => {
	const themeInstance = await getThemeByName("red-claw");
	if (!themeInstance) {
		throw new Error("Failed to load dark theme for tests");
	}
	setThemeInstance(themeInstance);
});

const TITLE = "Deep Interview question body\n\nLong explanation line one\nLong explanation line two";
const OPTIONS = ["1. Option A", "2. Option B", "3. Other (type your own)"];
const OTHER = OPTIONS[2]!;

interface Callbacks {
	selected: string[];
	cancelled: number;
	submitted: string[];
}

function createSelector(opts?: { scrollTitleRows?: number }): {
	component: HookSelectorComponent;
	calls: Callbacks;
} {
	const calls: Callbacks = { selected: [], cancelled: 0, submitted: [] };
	const component = new HookSelectorComponent(
		TITLE,
		OPTIONS,
		option => calls.selected.push(option),
		() => calls.cancelled++,
		{
			customInput: {
				optionLabel: OTHER,
				onSubmit: text => calls.submitted.push(text),
			},
			scrollTitleRows: opts?.scrollTitleRows,
		},
	);
	return { component, calls };
}

function renderText(component: HookSelectorComponent, width = 80): string {
	return Bun.stripANSI(component.render(width).join("\n"));
}

function moveToOther(component: HookSelectorComponent): void {
	component.handleInput("\x1b[B"); // down
	component.handleInput("\x1b[B"); // down
}

describe("HookSelectorComponent inline custom input", () => {
	it("keeps the title and option list visible after opening the input", () => {
		const { component, calls } = createSelector();
		moveToOther(component);
		component.handleInput("\r");

		const rendered = renderText(component);
		expect(rendered).toContain("Deep Interview question body");
		expect(rendered).toContain("1. Option A");
		expect(rendered).toContain("2. Option B");
		expect(rendered).toContain("3. Other (type your own)");
		// The selector must not resolve yet — input mode is internal.
		expect(calls.selected).toEqual([]);
		expect(calls.submitted).toEqual([]);
		expect(calls.cancelled).toBe(0);
	});

	it("shows input-mode help text and an inline prompt below the options", () => {
		const { component } = createSelector();
		const before = renderText(component);
		expect(before).toContain("enter select");

		moveToOther(component);
		component.handleInput("\r");

		const after = renderText(component);
		expect(after).toContain("enter submit  esc back to options");
		const optionRow = after.indexOf("3. Other");
		const promptRow = after.indexOf("> ");
		expect(promptRow).toBeGreaterThan(optionRow);
	});

	it("submits typed text via onSubmit instead of resolving an option", () => {
		const { component, calls } = createSelector();
		moveToOther(component);
		component.handleInput("\r");

		component.handleInput("h");
		component.handleInput("i");
		component.handleInput("\r");

		expect(calls.submitted).toEqual(["hi"]);
		expect(calls.selected).toEqual([]);
		expect(calls.cancelled).toBe(0);
	});

	it("escape returns to option selection without cancelling the dialog", () => {
		const { component, calls } = createSelector();
		moveToOther(component);
		component.handleInput("\r");
		component.handleInput("x");
		component.handleInput("\x1b");

		expect(calls.cancelled).toBe(0);
		const rendered = renderText(component);
		expect(rendered).not.toContain("esc back to options");
		expect(rendered).toContain("enter select");

		// Selection mode is fully restored: enter on a normal option resolves it.
		component.handleInput("\x1b[A"); // up to "2. Option B"
		component.handleInput("\r");
		expect(calls.selected).toEqual(["2. Option B"]);
	});

	it("escape in selection mode still cancels the dialog", () => {
		const { component, calls } = createSelector();
		component.handleInput("\x1b");
		expect(calls.cancelled).toBe(1);
	});

	it("selecting a regular option resolves immediately without input mode", () => {
		const { component, calls } = createSelector();
		component.handleInput("\r");
		expect(calls.selected).toEqual(["1. Option A"]);
		expect(calls.submitted).toEqual([]);
	});

	it("without customInput, selecting the Other label resolves like any option", () => {
		const selected: string[] = [];
		const component = new HookSelectorComponent(
			TITLE,
			OPTIONS,
			option => selected.push(option),
			() => {},
		);
		moveToOther(component);
		component.handleInput("\r");
		expect(selected).toEqual([OTHER]);
	});

	it("keeps the question scrollable from input mode when scrollTitleRows is set", () => {
		const { component } = createSelector({ scrollTitleRows: 2 });
		moveToOther(component);
		component.handleInput("\r");

		const before = renderText(component);
		expect(before).toContain("Deep Interview question body");
		component.handleInput("\x1b[6~"); // PgDn scrolls the title, not the editor
		const after = renderText(component);
		expect(after).not.toContain("Deep Interview question body");
		expect(after).toContain("esc back to options");
	});
});
