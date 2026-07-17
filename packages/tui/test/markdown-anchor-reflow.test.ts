import { describe, expect, it } from "bun:test";
import { Container, Markdown, TUI, VIEWPORT_ANCHOR_PREFIX, type ViewportAnchorRow } from "@gajae-code/tui";
import { defaultMarkdownTheme } from "./test-themes";
import { VirtualTerminal } from "./virtual-terminal";

// Mirrors TUI #resolveManualAnchor: find the row whose span contains the stored
// (graphemeIndex, cellOffset) for the matching source id.
function resolveRow(
	anchors: Array<ViewportAnchorRow | null>,
	stored: { id: string; graphemeIndex: number; cellOffset: number },
): number {
	return anchors.findIndex(
		candidate =>
			candidate !== null &&
			candidate.id === stored.id &&
			candidate.graphemeStart <= stored.graphemeIndex &&
			stored.graphemeIndex < candidate.graphemeEnd &&
			candidate.cellStart <= stored.cellOffset &&
			stored.cellOffset < candidate.cellEnd,
	);
}

function rowWithText(lines: string[], needle: string): number {
	return lines.findIndex(line => Bun.stripANSI(line).includes(needle));
}

function render(text: string, width: number, id: string) {
	return new Markdown(text, 0, 0, defaultMarkdownTheme).renderWithViewportAnchorSource(width, { id });
}

// Render at two widths and assert that the anchor captured for `needle` at the
// source width resolves back to the same logical row at the target width — i.e.
// a topology-changing reflow does not drift the anchor to unrelated content or
// drop it entirely (which would strand a stale viewport).
function expectAnchorSurvivesReflow(text: string, needle: string, from: number, to: number, id: string): void {
	const source = render(text, from, id);
	const sourceRow = rowWithText(source.lines, needle);
	expect(sourceRow, `${needle} missing at width ${from}`).toBeGreaterThanOrEqual(0);
	const anchor = source.anchors[sourceRow];
	if (!anchor) throw new Error(`${needle} row carried no anchor at width ${from}`);
	const stored = { id, graphemeIndex: anchor.graphemeStart, cellOffset: anchor.cellStart };

	const target = render(text, to, id);
	const targetRow = rowWithText(target.lines, needle);
	expect(targetRow, `${needle} missing at width ${to}`).toBeGreaterThanOrEqual(0);
	expect(resolveRow(target.anchors, stored), `${needle} drifted ${from}->${to}`).toBe(targetRow);
}

// The page-down capture (see TUI.scrollViewportPages) stores the END of the
// pinned row's span (max(graphemeStart, graphemeEnd - 1)), not its start. That
// exposes within-token drift a start-of-row capture masks: an earlier row's span
// end must not migrate into a later sibling row when that sibling rewraps.
function expectPageDownAnchorSurvivesReflow(text: string, needle: string, from: number, to: number, id: string): void {
	const source = render(text, from, id);
	const sourceRow = rowWithText(source.lines, needle);
	expect(sourceRow, `${needle} missing at width ${from}`).toBeGreaterThanOrEqual(0);
	const anchor = source.anchors[sourceRow];
	if (!anchor) throw new Error(`${needle} row carried no anchor at width ${from}`);
	const stored = {
		id,
		graphemeIndex: Math.max(anchor.graphemeStart, anchor.graphemeEnd - 1),
		cellOffset: Math.max(anchor.cellStart, anchor.cellEnd - 1),
	};

	const target = render(text, to, id);
	const targetRow = rowWithText(target.lines, needle);
	expect(targetRow, `${needle} missing at width ${to}`).toBeGreaterThanOrEqual(0);
	expect(resolveRow(target.anchors, stored), `${needle} drifted ${from}->${to}`).toBe(targetRow);
}

function assertAnchorContract(anchors: Array<ViewportAnchorRow | null>): void {
	const present = anchors.filter((anchor): anchor is ViewportAnchorRow => anchor !== null);
	expect(present.length).toBeGreaterThan(1);
	expect(present[0].graphemeStart).toBe(0);
	for (let index = 0; index < present.length; index++) {
		const anchor = present[index];
		expect(anchor.graphemeEnd).toBeGreaterThan(anchor.graphemeStart);
		expect(anchor.cellEnd).toBeGreaterThan(anchor.cellStart);
		if (index > 0) {
			expect(anchor.graphemeStart).toBeGreaterThanOrEqual(present[index - 1].graphemeEnd);
			expect(anchor.cellStart).toBeGreaterThanOrEqual(present[index - 1].cellEnd);
		}
	}
}

const HR_DOC = [
	"intro paragraph with several words so it wraps when narrow",
	"",
	"---",
	"",
	"TARGET paragraph immediately after the horizontal rule",
	"",
	"trailing paragraph with several words so it also wraps",
].join("\n");

const BLOCKQUOTE_DOC = [
	"lead paragraph with several words so it wraps when the terminal narrows",
	"",
	"> quoted line one with several words that rewrap across widths",
	"> quoted line two with several words that rewrap across widths",
	"",
	"TARGET paragraph immediately after the blockquote block",
].join("\n");

const TABLE_DOC = [
	"heading paragraph with several words so it wraps when narrow",
	"",
	"| Column Alpha | Column Beta |",
	"| --- | --- |",
	"| alpha one | beta one |",
	"| alpha two | beta two |",
	"",
	"TARGET paragraph immediately after the table block",
].join("\n");

// A two-item bullet list is a single top-level token. The first item is short
// (one row at every width); the second is long and rewraps into several rows as
// the terminal narrows. A page-down anchor pinned on the first item must not
// drift into the second when the second item rewraps.
const LIST_DOC = [
	"- ITEMONE",
	"- ITEMTWO followed by lots and lots of extra words that will wrap into several rows once the terminal is narrow enough to force multiple line wrapping here",
].join("\n");

// A table is one top-level token; its rows are the width-invariant source units.
// The second data cell is long and rewraps into several rows as the terminal
// narrows. A page-down anchor pinned on the header must not drift into a data row.
const TABLE_ROWS_DOC = [
	"| HEADA | HEADB |",
	"| --- | --- |",
	"| shortcell | a very long cell body with lots and lots of extra words to force wrapping across several rows once the terminal narrows indeed yes more here |",
].join("\n");

// A blockquote with two separate paragraph blocks (blank quoted line between).
// The second block rewraps as the terminal narrows; a page-down anchor pinned on
// the first block must not drift into the second.
const MULTIBLOCK_QUOTE_DOC = [
	"> QHEAD",
	">",
	"> QTAIL second quoted paragraph with lots and lots of extra words that wrap into several rows once the terminal is narrow enough to force wrapping here indeed",
].join("\n");

describe("markdown viewport anchors across topology-changing reflow (#2031)", () => {
	it("keeps the post-HR paragraph anchored wide<->narrow", () => {
		expectAnchorSurvivesReflow(HR_DOC, "TARGET", 100, 24, "hr");
		expectAnchorSurvivesReflow(HR_DOC, "TARGET", 24, 100, "hr");
		expectAnchorSurvivesReflow(HR_DOC, "TARGET", 80, 40, "hr");
	});

	it("keeps the post-blockquote paragraph anchored wide<->narrow", () => {
		expectAnchorSurvivesReflow(BLOCKQUOTE_DOC, "TARGET", 100, 20, "bq");
		expectAnchorSurvivesReflow(BLOCKQUOTE_DOC, "TARGET", 20, 100, "bq");
	});

	it("keeps the post-table paragraph anchored across boxed<->fallback reflow", () => {
		// width 10 forces the raw-markdown table fallback; width 100 renders boxed.
		expectAnchorSurvivesReflow(TABLE_DOC, "TARGET", 100, 10, "tbl");
		expectAnchorSurvivesReflow(TABLE_DOC, "TARGET", 10, 100, "tbl");
		// boxed->boxed with cell rewrap (the off-by-one drift from the report).
		expectAnchorSurvivesReflow(TABLE_DOC, "TARGET", 100, 24, "tbl");
	});

	it("keeps an earlier list item pinned when a later item rewraps (page-down capture)", () => {
		// At width 120 both items occupy one row; at width 30 the second item wraps
		// across several rows. The page-down capture stores ITEMONE's span end, which
		// must resolve back to ITEMONE — not slide into ITEMTWO — after the reflow.
		expectPageDownAnchorSurvivesReflow(LIST_DOC, "ITEMONE", 120, 30, "list");
		expectPageDownAnchorSurvivesReflow(LIST_DOC, "ITEMONE", 30, 120, "list");
	});

	it("keeps an earlier table row / quote block pinned when a later one rewraps (page-down capture)", () => {
		// A table header must not slide into a data row when a data cell rewraps.
		expectPageDownAnchorSurvivesReflow(TABLE_ROWS_DOC, "HEADA", 120, 40, "tblrows");
		expectPageDownAnchorSurvivesReflow(TABLE_ROWS_DOC, "HEADA", 40, 120, "tblrows");
		// The first quote block must not slide into the second when the second rewraps.
		expectPageDownAnchorSurvivesReflow(MULTIBLOCK_QUOTE_DOC, "QHEAD", 120, 30, "bqblocks");
		expectPageDownAnchorSurvivesReflow(MULTIBLOCK_QUOTE_DOC, "QHEAD", 30, 120, "bqblocks");
	});

	it("preserves the monotonic, non-overlapping anchor contract and leaks no markers", () => {
		for (const doc of [HR_DOC, BLOCKQUOTE_DOC, TABLE_DOC, LIST_DOC, TABLE_ROWS_DOC, MULTIBLOCK_QUOTE_DOC]) {
			for (const width of [100, 40, 24, 10]) {
				const rendered = render(doc, width, "contract");
				expect(rendered.anchors.length).toBe(rendered.lines.length);
				const joined = rendered.lines.join("");
				expect(joined).not.toContain(VIEWPORT_ANCHOR_PREFIX);
				expect(joined).not.toContain("GJC_ANCHOR");
				assertAnchorContract(rendered.anchors);
			}
		}
	});

	it("keeps anchor lines byte-identical to the plain render", () => {
		for (const doc of [HR_DOC, BLOCKQUOTE_DOC, TABLE_DOC, LIST_DOC, TABLE_ROWS_DOC, MULTIBLOCK_QUOTE_DOC]) {
			for (const width of [100, 40, 24, 10]) {
				const md = new Markdown(doc, 0, 0, defaultMarkdownTheme);
				const withAnchors = md.renderWithViewportAnchorSource(width, { id: "parity" });
				expect(withAnchors.lines).toEqual(new Markdown(doc, 0, 0, defaultMarkdownTheme).render(width));
			}
		}
	});
});

class MarkdownTranscript extends Container {
	constructor(text: string, id: string) {
		super();
		const markdown = new Markdown(text, 0, 0, defaultMarkdownTheme);
		this.addChild(markdown);
		this.setViewportAnchorSource(markdown, { id });
	}
}

async function settle(term: VirtualTerminal): Promise<void> {
	await term.waitForRender();
}

function visible(term: VirtualTerminal): string[] {
	return term.getViewport().map(line => line.trimEnd());
}

describe("TUI holds a Markdown viewport anchor across resize reflow (#2031)", () => {
	// A short, unwrappable marker after each topology element must stay pinned to
	// the same screen row while the width-dependent decoration above it reflows.
	const doc = [
		...Array.from({ length: 6 }, (_v, i) => `filler paragraph number ${i} with enough words to rewrap when narrow`),
		"| Column Alpha | Column Beta |",
		"| --- | --- |",
		"| alpha one | beta one |",
		"| alpha two | beta two |",
		"> quoted context line with several words that rewrap across widths",
		"---",
		"ANCHORXYZ",
		"tail-one",
		"tail-two",
	].join("\n\n");

	it("pins a post-topology marker to a fixed screen row through a resize sweep", async () => {
		const term = new VirtualTerminal(72, 6);
		const tui = new TUI(term);
		const transcript = new MarkdownTranscript(doc, "reflow");
		tui.addChild(transcript);
		tui.setViewportAnchorComponent(transcript);
		try {
			tui.start();
			await settle(term);
			expect(visible(term).some(line => line.includes("ANCHORXYZ"))).toBe(true);
			expect(tui.scrollViewportPages(1)).toBe(true);
			await term.flush();
			const targetScreenRow = visible(term).findIndex(line => line.includes("ANCHORXYZ"));
			expect(targetScreenRow).toBeGreaterThanOrEqual(0);
			for (const width of [40, 60, 24, 50, 30]) {
				term.resize(width, 6);
				await settle(term);
				expect(visible(term)[targetScreenRow], `width=${width}`).toContain("ANCHORXYZ");
			}
		} finally {
			tui.stop();
		}
	});
});
