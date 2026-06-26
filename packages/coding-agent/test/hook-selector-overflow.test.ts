import { beforeAll, describe, expect, it } from "bun:test";
import { HookSelectorComponent } from "@gajae-code/coding-agent/modes/components/hook-selector";
import { getThemeByName, setThemeInstance, theme } from "@gajae-code/coding-agent/modes/theme/theme";
import { visibleWidth } from "@gajae-code/tui";

// =============================================================================
// Helpers shared across required tests.
// =============================================================================

/**
 * For outlined render, strip the leading box border glyph from each row so
 * downstream column-aware assertions can inspect the option-content cell
 * directly. Rows that don't start with the border are returned untouched.
 */
function stripBorder(line: string, glyph: string): string {
	return line.startsWith(glyph) ? line.slice(glyph.length) : line;
}

/**
 * Bare (ANSI-stripped) selected-prefix the focused option uses on its first
 * wrapped row. Mirrors `theme.fg("accent", `${theme.nav.cursor} `)` used in
 * `FocusAwareList.render` so tests don't depend on the styled (ANSI) form.
 */
function bareSelectedPrefix(): string {
	return Bun.stripANSI(theme.fg("accent", `${theme.nav.cursor} `));
}

beforeAll(async () => {
	const themeInstance = await getThemeByName("red-claw");
	if (!themeInstance) {
		throw new Error("Failed to load dark theme for tests");
	}
	setThemeInstance(themeInstance);
});

// =============================================================================
// Required Test 3 — True baseline legacy regression
//
// Captured from pre-implementation `HookSelectorComponent.render(80)` BEFORE
// any `wrapFocused` behavior was added. Both omitted and `wrapFocused:false`
// must exactly equal this fixture; any drift means today's bytes regressed
// for shared selector consumers (plan-mode, session-delete, MCP wizard,
// registry-search, restart picker, branch-summary).
// =============================================================================

const BASELINE_LONG_FOCUSED =
	"Alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango";
const BASELINE_LONG_NON_FOCUSED =
	"Zulu yankee xray whiskey victor uniform tango sierra romeo quebec papa oscar november mike lima kilo juliet india hotel golf";
const BASELINE_SHORT = "short option";

const BASELINE_OUTLINED_RENDER_80_STRIPPED = [
	"────────────────────────────────────────────────────────────────────────────────",
	"",
	" Choose an option                                                               ",
	"",
	"────────────────────────────────────────────────────────────────────────────────",
	"│❯ Alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mi…│",
	"│  Zulu yankee xray whiskey victor uniform tango sierra romeo quebec papa osca…│",
	"│  short option                                                                │",
	"────────────────────────────────────────────────────────────────────────────────",
	"",
	" up/down navigate  enter select  esc cancel                                     ",
	"",
	"────────────────────────────────────────────────────────────────────────────────",
].join("\n");

function renderStripped(
	width: number,
	opts: {
		outline?: boolean;
		wrapFocused?: boolean;
		scrollTitleRows?: number;
		initialIndex?: number;
		maxVisible?: number;
	},
	options: string[] = [BASELINE_LONG_FOCUSED, BASELINE_LONG_NON_FOCUSED, BASELINE_SHORT],
): string {
	const component = new HookSelectorComponent(
		"Choose an option",
		options,
		() => {},
		() => {},
		opts,
	);
	return Bun.stripANSI(component.render(width).join("\n"));
}

describe("HookSelectorComponent", () => {
	it("keeps outlined options within render width", () => {
		const options = [
			"aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;b",
			"bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;a",
			"a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b",
		];
		const component = new HookSelectorComponent(
			"Which pattern do you prefer?",
			options,
			() => {},
			() => {},
			{ outline: true, initialIndex: 0 },
		);

		const width = 80;
		const lines = component.render(width);
		for (const line of lines) {
			expect(visibleWidth(Bun.stripANSI(line))).toBeLessThanOrEqual(width);
		}
	});

	it("legacy outlined render at width 80 is byte-identical to captured baseline (wrapFocused unset)", () => {
		const rendered = renderStripped(80, { outline: true, initialIndex: 0, maxVisible: 5 });
		expect(rendered).toBe(BASELINE_OUTLINED_RENDER_80_STRIPPED);
	});

	it("legacy outlined render at width 80 is byte-identical to captured baseline (wrapFocused:false)", () => {
		const rendered = renderStripped(80, { outline: true, initialIndex: 0, maxVisible: 5, wrapFocused: false });
		expect(rendered).toBe(BASELINE_OUTLINED_RENDER_80_STRIPPED);
	});

	it("Required Test 1 — focused long option wraps fully without ellipsis", () => {
		const longLabel =
			"Alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango";
		const rendered = renderStripped(32, { outline: true, initialIndex: 0, maxVisible: 5, wrapFocused: true }, [
			longLabel,
			"short",
		]);
		const lines = rendered.split("\n");

		// Identify the lines that hold rendered focused-label segments. We
		// strip the outline border glyph so we can match on the inner cell.
		const innerLines = lines.map(line => stripBorder(line, "│"));
		const focusedFragments = innerLines.filter(
			line => line.includes("Alpha") || line.includes("kilo") || line.includes("juliet"),
		);
		expect(focusedFragments.length).toBeGreaterThan(1);

		// Full label text must appear across the wrapped rows.
		expect(rendered).toContain("Alpha bravo");
		expect(rendered).toContain("sierra tango");

		// No truncation glyph inside the focused block.
		const focusedBlock = focusedFragments.join("\n");
		expect(focusedBlock).not.toContain("…");
		expect(focusedBlock).not.toContain("...");
	});

	it("Required Test 2 — non-focused long option remains single-row with ellipsis", () => {
		const longNonFocused =
			"Zulu yankee xray whiskey victor uniform tango sierra romeo quebec papa oscar november mike lima kilo juliet india hotel golf";
		const rendered = renderStripped(34, { outline: true, initialIndex: 0, maxVisible: 5, wrapFocused: true }, [
			"selected short",
			longNonFocused,
		]);

		const innerLines = rendered.split("\n").map(line => stripBorder(line, "│"));
		const nonFocusedLines = innerLines.filter(line => line.includes("Zulu yankee"));
		expect(nonFocusedLines).toHaveLength(1);
		expect(nonFocusedLines[0]).toContain("…");
		// The truncated row must not contain text from the far end of the
		// label — it is still one-line behavior.
		expect(nonFocusedLines[0]).not.toContain("hotel golf");
	});

	it("Required Test 4 — cursor prefix-column assertion (single cursor row, aligned continuations)", () => {
		const longLabel =
			"Alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango";
		const rendered = renderStripped(32, { outline: true, initialIndex: 0, maxVisible: 5, wrapFocused: true }, [
			longLabel,
			"short",
		]);
		const lines = rendered.split("\n");

		const cursorPrefix = bareSelectedPrefix();
		const continuationPrefix = " ".repeat(visibleWidth(cursorPrefix));

		// Walk the rows inside the outline border. Only one row is allowed to
		// start with the bare cursor prefix at the option-content column.
		const innerLines = lines.map(line => stripBorder(line, "│"));

		// Rows that belong to the focused wrapped block contain pieces of
		// `longLabel`. We collect them and verify cursor + continuation
		// columns.
		const focusedRows = innerLines.filter(line =>
			["Alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "kilo", "lima", "juliet", "sierra", "tango"].some(
				token => line.includes(token),
			),
		);
		expect(focusedRows.length).toBeGreaterThan(1);

		const cursorRows = focusedRows.filter(line => line.startsWith(cursorPrefix));
		expect(cursorRows).toHaveLength(1);

		const continuationRows = focusedRows.filter(line => !line.startsWith(cursorPrefix));
		expect(continuationRows.length).toBeGreaterThan(0);
		for (const row of continuationRows) {
			expect(row.startsWith(continuationPrefix)).toBe(true);
			// Continuation rows must contain wrapped focused-label text, not
			// the cursor glyph itself.
			expect(row.slice(continuationPrefix.length).trim().length).toBeGreaterThan(0);
		}
	});

	it("Required Test 5 — mandatory row-budget keeps focused block intact and shrinks siblings", () => {
		const longLabel =
			"Alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango";
		const options = ["above-1", "above-2", longLabel, "below-1", "below-2", "below-3"];
		const rendered = renderStripped(
			32,
			{ outline: true, initialIndex: 2, maxVisible: 4, wrapFocused: true },
			options,
		);

		// Focused block stays intact: first and last segments are both present.
		expect(rendered).toContain("Alpha bravo");
		expect(rendered).toContain("sierra tango");

		// Siblings must shrink — fewer than the full 5 non-focused options can
		// appear in the window.
		const visibleSiblings = ["above-1", "above-2", "below-1", "below-2", "below-3"].filter(label =>
			rendered.includes(label),
		);
		expect(visibleSiblings.length).toBeLessThan(5);

		// Marker is present because the window omits at least one option.
		expect(rendered).toContain("(3/6)");
	});

	it("Required Test 6 — non-outline parity (wrapFocused:true, outline:false)", () => {
		const longLabel =
			"Alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango";
		const rendered = renderStripped(32, { outline: false, initialIndex: 0, maxVisible: 8, wrapFocused: true }, [
			longLabel,
			"short non-focused",
		]);
		const lines = rendered.split("\n");

		const cursorPrefix = bareSelectedPrefix();
		const continuationPrefix = " ".repeat(visibleWidth(cursorPrefix));

		// Focused option spans multiple rows.
		const focusedRows = lines.filter(line =>
			["Alpha", "bravo", "kilo", "juliet", "sierra"].some(token => line.includes(token)),
		);
		expect(focusedRows.length).toBeGreaterThan(1);

		// Exactly one row carries the cursor prefix at the option-content column.
		const cursorRows = focusedRows.filter(line => line.startsWith(cursorPrefix));
		expect(cursorRows).toHaveLength(1);

		// Continuation rows start with whitespace aligned under the label.
		const continuationRows = focusedRows.filter(line => !line.startsWith(cursorPrefix));
		expect(continuationRows.length).toBeGreaterThan(0);
		for (const row of continuationRows) {
			expect(row.startsWith(continuationPrefix)).toBe(true);
		}

		// Non-focused short label appears exactly once.
		const shortLines = lines.filter(line => line.includes("short non-focused"));
		expect(shortLines).toHaveLength(1);

		// No truncation glyph in the focused block.
		const focusedBlock = focusedRows.join("\n");
		expect(focusedBlock).not.toContain("…");
		expect(focusedBlock).not.toContain("...");
	});

	it("Required Test 6b — non-outline path truncates long non-focused siblings with ellipsis", () => {
		// Architect blocker fix: the non-outline path also has to render
		// long non-focused options as one row with `…`, mirroring outline
		// behavior. Without per-row truncation in `FocusAwareList.render`,
		// non-focused labels would overflow uncontrolled in non-outline mode.
		const focused = "selected short";
		const longNonFocused =
			"Zulu yankee xray whiskey victor uniform tango sierra romeo quebec papa oscar november mike lima kilo juliet india hotel golf";
		const rendered = renderStripped(34, { outline: false, initialIndex: 0, maxVisible: 6, wrapFocused: true }, [
			focused,
			longNonFocused,
		]);

		const nonFocusedLines = rendered.split("\n").filter(line => line.includes("Zulu yankee"));
		expect(nonFocusedLines).toHaveLength(1);
		expect(nonFocusedLines[0]).toContain("…");
		// The truncated row must not contain text from the far end of the
		// label — it is still one-line behavior.
		expect(nonFocusedLines[0]).not.toContain("hotel golf");
	});

	it("caps extremely long focused options to maxVisible rows with an omitted marker", () => {
		const longLabel = Array.from({ length: 400 }, (_, index) => `token-${index}`).join(" ");
		const maxVisible = 5;
		const rendered = renderStripped(28, { outline: true, initialIndex: 1, maxVisible, wrapFocused: true }, [
			"above option",
			longLabel,
			"below option",
		]);
		const lines = rendered.split("\n");
		const innerRows = lines.map(line => stripBorder(line, "│"));
		const optionRows = innerRows.filter(
			line =>
				line.includes("above option") ||
				line.includes("token-") ||
				line.includes("wrapped rows omitted") ||
				line.includes("below option") ||
				line.includes("(2/3)"),
		);

		expect(optionRows.length).toBeLessThanOrEqual(maxVisible);
		expect(rendered).toContain("wrapped rows omit");
		expect(rendered).toContain("(2/3)");
		expect(rendered).not.toContain("below option");
	});

	it("keeps controls reachable when focused option budget leaves one content row", () => {
		const longLabel = Array.from({ length: 200 }, (_, index) => `word${index}`).join(" ");
		const rendered = renderStripped(24, { outline: false, initialIndex: 0, maxVisible: 3, wrapFocused: true }, [
			longLabel,
			"second choice",
		]);
		const lines = rendered.split("\n");
		const optionRows = lines.filter(
			line =>
				line.includes("word") ||
				line.includes("wrapped rows omitted") ||
				line.includes("second choice") ||
				line.includes("(1/2)"),
		);

		expect(optionRows.length).toBeLessThanOrEqual(3);
		expect(rendered).toContain("wrapped rows omi");
		expect(rendered).toContain("(1/2)");
		expect(rendered).toContain("up/down navigate");
	});
	it("caps scrollable title rows while keeping options and help visible", () => {
		const title = Array.from({ length: 10 }, (_, index) => `Prompt row ${index + 1}`).join("\n\n");
		const component = new HookSelectorComponent(
			title,
			["answer-a", "answer-b"],
			() => {},
			() => {},
			{
				outline: true,
				wrapFocused: true,
				scrollTitleRows: 3,
				maxVisible: 2,
				helpText: "↑/↓ select  enter  esc  PgUp/PgDn/Ctrl+u/d: question · Wheel: transcript",
			},
		);

		const rendered = Bun.stripANSI(component.render(88).join("\n"));
		const titleRows = rendered.split("\n").filter(line => line.includes("Prompt row"));

		expect(titleRows.length).toBeLessThanOrEqual(3);
		expect(rendered).toContain("answer-a");
		expect(rendered).toContain("answer-b");
		expect(rendered).toContain("PgUp/PgDn/Ctrl+u/d: question");
		expect(rendered).toContain("Wheel: transcript");
		expect(rendered).toContain("▼ more");
	});

	it("uses selector-local PageUp/PageDown for title scrolling without moving option focus", () => {
		const title = Array.from({ length: 8 }, (_, index) => `Question segment ${index + 1}`).join("\n\n");
		let selected: string | undefined;
		const component = new HookSelectorComponent(
			title,
			["first-choice", "second-choice"],
			option => {
				selected = option;
			},
			() => {},
			{ outline: true, wrapFocused: true, scrollTitleRows: 2, maxVisible: 2 },
		);

		const initial = Bun.stripANSI(component.render(56).join("\n"));
		expect(initial).toContain("Question segment 1");
		expect(initial).not.toContain("Question segment 8");
		expect(initial).toContain("first-choice");

		for (let i = 0; i < 8; i++) component.handleInput("\x1b[6~");
		const afterPageDown = Bun.stripANSI(component.render(56).join("\n"));
		expect(afterPageDown).not.toContain("Question segment 1");
		expect(afterPageDown).toContain("Question segment 8");
		expect(afterPageDown).toContain("first-choice");

		component.handleInput("\n");
		expect(selected).toBe("first-choice");

		for (let i = 0; i < 8; i++) component.handleInput("\x1b[5~");
		const afterPageUp = Bun.stripANSI(component.render(56).join("\n"));
		expect(afterPageUp).toContain("Question segment 1");
	});
	it("uses selector-local Ctrl+u/Ctrl+d aliases for title scrolling without moving option focus", () => {
		const title = Array.from({ length: 8 }, (_, index) => `Ctrl segment ${index + 1}`).join("\n\n");
		let selected: string | undefined;
		const component = new HookSelectorComponent(
			title,
			["first-choice", "second-choice"],
			option => {
				selected = option;
			},
			() => {},
			{ outline: true, wrapFocused: true, scrollTitleRows: 2, maxVisible: 2 },
		);

		const initial = Bun.stripANSI(component.render(56).join("\n"));
		expect(initial).toContain("Ctrl segment 1");
		expect(initial).not.toContain("Ctrl segment 8");

		for (let i = 0; i < 8; i++) component.handleInput("\x04");
		const afterCtrlD = Bun.stripANSI(component.render(56).join("\n"));
		expect(afterCtrlD).not.toContain("Ctrl segment 1");
		expect(afterCtrlD).toContain("Ctrl segment 8");
		expect(afterCtrlD).toContain("first-choice");

		component.handleInput("\n");
		expect(selected).toBe("first-choice");

		for (let i = 0; i < 8; i++) component.handleInput("\x15");
		const afterCtrlU = Bun.stripANSI(component.render(56).join("\n"));
		expect(afterCtrlU).toContain("Ctrl segment 1");
	});
});
