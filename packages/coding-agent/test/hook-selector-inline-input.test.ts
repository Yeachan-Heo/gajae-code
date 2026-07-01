import { beforeAll, describe, expect, it } from "bun:test";
import { HookSelectorComponent } from "@gajae-code/coding-agent/modes/components/hook-selector";
import { getThemeByName, setThemeInstance } from "@gajae-code/coding-agent/modes/theme/theme";
import { CURSOR_MARKER, type TUI } from "@gajae-code/tui";
import type { AutocompleteItem, AutocompleteProvider } from "@gajae-code/tui/autocomplete";

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

const CLARIFY = "4. Ask about these choices";
interface Callbacks {
	selected: string[];
	cancelled: number;
	submitted: string[];
}

function createSelector(opts?: { scrollTitleRows?: number; autocompleteProvider?: AutocompleteProvider; tui?: TUI }): {
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
			autocompleteProvider: opts?.autocompleteProvider,
			tui: opts?.tui,
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

// Minimal provider that completes an "@" file-link prefix, mirroring the real
// CombinedAutocompleteProvider's `@` behavior closely enough to exercise wiring.
class AtFileProvider implements AutocompleteProvider {
	async getSuggestions(
		lines: string[],
		_cursorLine: number,
		cursorCol: number,
	): Promise<{ items: AutocompleteItem[]; prefix: string } | null> {
		const prefix = (lines[0] || "").slice(0, cursorCol);
		if (!prefix.startsWith("@")) return null;
		return { prefix, items: [{ value: "@src/app.ts", label: "src/app.ts" }] };
	}

	applyCompletion(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		item: AutocompleteItem,
		prefix: string,
	): { lines: string[]; cursorLine: number; cursorCol: number } {
		const line = lines[cursorLine] || "";
		const start = cursorCol - prefix.length;
		const newLine = line.slice(0, start) + item.value + line.slice(cursorCol);
		return { lines: [newLine], cursorLine, cursorCol: start + item.value.length };
	}
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

	it("marks the Other inline editor focused and mirrors hardware cursor mode", () => {
		const component = createSelector({
			tui: { getShowHardwareCursor: () => true } as TUI,
		}).component;
		moveToOther(component);
		component.handleInput("\r");

		const rendered = component.render(80).join("\n");
		const markerIndex = rendered.indexOf(CURSOR_MARKER);
		const promptIndex = Bun.stripANSI(rendered).indexOf("> ");

		expect(markerIndex).toBeGreaterThanOrEqual(0);
		expect(promptIndex).toBeGreaterThan(rendered.indexOf("3. Other"));
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

	it("submits clarification text through the separate inline input callback", () => {
		const calls: Callbacks = { selected: [], cancelled: 0, submitted: [] };
		const clarifications: string[] = [];
		const component = new HookSelectorComponent(
			TITLE,
			[...OPTIONS, CLARIFY],
			option => calls.selected.push(option),
			() => calls.cancelled++,
			{
				customInput: {
					optionLabel: OTHER,
					onSubmit: text => calls.submitted.push(text),
				},
				clarificationInput: {
					optionLabel: CLARIFY,
					allowEmpty: false,
					onSubmit: text => clarifications.push(text),
				},
			},
		);

		component.handleInput("\x1b[B");
		component.handleInput("\x1b[B");
		component.handleInput("\x1b[B");
		component.handleInput("\r");
		component.handleInput("\r");
		expect(clarifications).toEqual([]);

		component.handleInput("?");
		component.handleInput("\r");

		expect(clarifications).toEqual(["?"]);
		expect(calls.submitted).toEqual([]);
		expect(calls.selected).toEqual([]);
		expect(calls.cancelled).toBe(0);
	});

	it("submits expanded large paste content instead of the display marker", () => {
		const { component, calls } = createSelector();
		moveToOther(component);
		component.handleInput("\r");

		const pastedText = Array.from({ length: 12 }, (_, index) => `pasted line ${index + 1}`).join("\n");
		component.handleInput(`\x1b[200~${pastedText}\x1b[201~`);

		const rendered = renderText(component);
		expect(rendered).toContain("[paste #");
		expect(calls.submitted).toEqual([]);

		component.handleInput("\r");

		expect(calls.submitted).toEqual([pastedText]);
		expect(calls.submitted[0]).not.toContain("[paste #");
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

	it("opens @ file autocomplete in the inline input and applies it with enter", async () => {
		const { component, calls } = createSelector({ autocompleteProvider: new AtFileProvider() });
		moveToOther(component);
		component.handleInput("\r");

		component.handleInput("@");
		await Bun.sleep(0); // let async getSuggestions resolve and open the dropdown

		// Enter belongs to the open dropdown: it applies the completion, not submit.
		component.handleInput("\r");
		expect(calls.submitted).toEqual([]);
		expect(renderText(component)).toContain("@src/app.ts");

		// With the dropdown closed, enter now submits the completed file link.
		component.handleInput("\r");
		expect(calls.submitted).toEqual(["@src/app.ts"]);
	});

	it("without an autocomplete provider, @ stays literal and enter submits it", async () => {
		const { component, calls } = createSelector();
		moveToOther(component);
		component.handleInput("\r");

		component.handleInput("@");
		await Bun.sleep(0);
		component.handleInput("\r");

		expect(calls.submitted).toEqual(["@"]);
	});
});
