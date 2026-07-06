import { afterEach, describe, expect, it } from "bun:test";
import { type Component, TUI } from "@gajae-code/tui";
import {
	__textHelperPerfCounters,
	Ellipsis,
	extractSegments,
	invalidateTabWidthCache,
	sliceWithWidth,
	truncateLinesToWidth,
	truncateToWidth,
	visibleWidth,
	visibleWidths,
} from "@gajae-code/tui/utils";
import { getDefaultTabWidth, setDefaultTabWidth } from "@gajae-code/utils";
import { VirtualTerminal } from "./virtual-terminal";

const originalTabWidth = getDefaultTabWidth();

afterEach(() => {
	setDefaultTabWidth(originalTabWidth);
	invalidateTabWidthCache();
	__textHelperPerfCounters.reset();
});
class LinesComponent implements Component {
	constructor(private readonly lines: string[]) {}
	invalidate(): void {}
	render(): string[] {
		return this.lines;
	}
}
describe("text utils", () => {
	it("computes visible width for ANSI and tabs", () => {
		const text = `\x1b[31mhi\tthere\x1b[0m`;
		expect(visibleWidth(text)).toBe(2 + 3 + 5);
	});

	it("ignores OSC hyperlinks in visible width", () => {
		const text = "\x1b]8;;https://example.com\x07link\x1b]8;;\x07";
		expect(visibleWidth(text)).toBe(4);
	});

	it("truncates ANSI text with ellipsis", () => {
		const text = "\x1b[31mhello world\x1b[0m";
		const result = truncateToWidth(text, 6);
		expect(result.includes("\x1b[0m…")).toBe(true);
		expect(visibleWidth(result)).toBe(6);
	});

	it("slices visible columns while preserving ANSI", () => {
		const text = "\x1b[31mhello\x1b[0m world";
		const result = sliceWithWidth(text, 1, 4, true);
		expect(result.text.startsWith("\x1b[31mello")).toBe(true);
		expect(result.width).toBe(4);
	});

	it("extracts segments with inherited styling", () => {
		const text = "\x1b[31mhello world\x1b[0m";
		const result = extractSegments(text, 3, 6, 5, true);
		expect(result.before).toContain("hel");
		expect(result.after.startsWith("\x1b[31m")).toBe(true);
		expect(result.afterWidth).toBeGreaterThan(0);
	});

	it("batched helpers match single-string helpers across terminal text cases", () => {
		const lines = [
			"",
			"plain ascii",
			"a\tb",
			"\x1b[31mred text that truncates\x1b[0m",
			"한글 jamo 한",
			"ไทยคำลาวຄໍາ",
			"emoji 👩‍💻 wide",
		];

		expect(truncateLinesToWidth(lines, 8, Ellipsis.Omit)).toEqual(
			lines.map(line => truncateToWidth(line, 8, Ellipsis.Omit)),
		);
		expect(visibleWidths(lines)).toEqual(lines.map(line => visibleWidth(line)));
	});

	it("invalidates the cached tab width automatically", () => {
		setDefaultTabWidth(2);
		expect(visibleWidth("a\tb")).toBe(4);
		setDefaultTabWidth(5);
		expect(visibleWidth("a\tb")).toBe(7);
		expect(visibleWidths(["a\tb"])).toEqual([7]);
	});

	it("normalizes transcript frames with batched native calls instead of per-line truncation calls", async () => {
		const term = new VirtualTerminal(16, 100);
		const tui = new TUI(term);
		tui.start();
		tui.addChild(
			new LinesComponent(
				Array.from(
					{ length: 80 },
					(_, i) => `unicode-${i}-한글-ไทย-ลาว-\x1b[31mcolored tail that must truncate\x1b[0m`,
				),
			),
		);
		__textHelperPerfCounters.reset();
		tui.requestRender(true, "batch-count-test");
		await term.waitForRender();
		expect(__textHelperPerfCounters.visibleWidthsCalls).toBe(1);
		expect(__textHelperPerfCounters.truncateLinesToWidthCalls).toBe(1);
		expect(__textHelperPerfCounters.truncateToWidthCalls).toBe(0);
		tui.stop();
	});
});
