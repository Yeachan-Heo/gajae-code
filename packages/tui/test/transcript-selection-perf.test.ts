import { describe, expect, it } from "bun:test";
import { type Component, renderMetrics, Text, TUI } from "@gajae-code/tui";
import { Markdown } from "@gajae-code/tui/components/markdown";
import { $flag } from "@gajae-code/utils";
import { defaultMarkdownTheme } from "./test-themes";
import { VirtualTerminal } from "./virtual-terminal";

const PERF_GATES = $flag("PI_TUI_PERF_GATES");
const PROMOTION_GATE = PERF_GATES && $flag("PI_TUI_PROMOTION_GATE");
const TRANSCRIPT_ROWS = 100_000;
const FRAMES_PER_RUN = 12;
const RUNS = 3;
const GUTTER = "  ";
const SELECTED_GUTTER = "\x1b[48;5;24m> \x1b[0m";
const MAX_RATIO = 1.15;
const MAX_SELECTION_NORMALIZED = 64;
const MAX_SELECTION_DIFFED = 64;
const MAX_SELECTION_OFFSCREEN_SCAN = 64;

type LineCounts = { normalized: number; diffed: number; offscreenScan: number };
type FrameMeasurement = { renderTreeMs: number; totalFrameMs: number; lineCounts: LineCounts };
type ArmMeasurement = FrameMeasurement & { frames: number };

class TranscriptRows implements Component {
	readonly #rows: Text[];
	#selectedRow: number | null = null;

	constructor(content: string[]) {
		// This intentionally creates a real 100k-row component tree. Text owns the
		// wrapping/cache behavior used by ordinary transcript rows; this local wrapper
		// adds only the permanently-reserved decoration gutter.
		this.#rows = content.map(line => new Text(line, 0, 0));
	}

	select(row: number | null): void {
		this.#selectedRow = row;
	}

	render(width: number): string[] {
		const contentWidth = Math.max(1, width - GUTTER.length);
		const lines: string[] = [];
		for (let row = 0; row < this.#rows.length; row++) {
			const gutter = row === this.#selectedRow ? SELECTED_GUTTER : GUTTER;
			for (const line of this.#rows[row].render(contentWidth)) lines.push(gutter + line);
		}
		return lines;
	}

	invalidate(): void {
		for (const row of this.#rows) row.invalidate();
	}
}

function rows(): string[] {
	return Array.from(
		{ length: TRANSCRIPT_ROWS },
		(_, index) => `${index.toString().padStart(6, "0")} transcript row carrying stable selection benchmark content`,
	);
}

async function settle(term: VirtualTerminal): Promise<void> {
	await new Promise<void>(resolve => process.nextTick(resolve));
	await Bun.sleep(20);
	await term.flush();
}

function lineCount(snapshot: ReturnType<typeof renderMetrics.snapshot>, name: keyof LineCounts): number {
	return snapshot.lineCounts[name]?.last ?? 0;
}

async function renderFrame(tui: TUI, term: VirtualTerminal, source: string): Promise<FrameMeasurement> {
	renderMetrics.reset();
	tui.requestRender(false, source);
	await settle(term);
	const snapshot = renderMetrics.snapshot();
	const renderTreeMs = snapshot.helperStats.renderTree?.totalMs ?? 0;
	const totalFrameMs = snapshot.renderDurations.meanMs;
	expect(snapshot.renderCount).toBe(1);
	expect(snapshot.helperStats.renderTree?.count).toBe(1);
	expect(renderTreeMs).toBeGreaterThan(0);
	expect(totalFrameMs).toBeGreaterThan(0);
	return {
		renderTreeMs,
		totalFrameMs,
		lineCounts: {
			normalized: lineCount(snapshot, "normalized"),
			diffed: lineCount(snapshot, "diffed"),
			offscreenScan: lineCount(snapshot, "offscreenScan"),
		},
	};
}

function combine(frames: FrameMeasurement[]): ArmMeasurement {
	const total = (key: "renderTreeMs" | "totalFrameMs") => frames.reduce((sum, frame) => sum + frame[key], 0);
	const maximum = (key: keyof LineCounts) => Math.max(...frames.map(frame => frame.lineCounts[key]));
	return {
		frames: frames.length,
		renderTreeMs: total("renderTreeMs"),
		totalFrameMs: total("totalFrameMs"),
		lineCounts: {
			normalized: maximum("normalized"),
			diffed: maximum("diffed"),
			offscreenScan: maximum("offscreenScan"),
		},
	};
}

async function measurePairedRun(): Promise<{ control: ArmMeasurement; selection: ArmMeasurement }> {
	const content = rows();
	const controlTerm = new VirtualTerminal(120, 20);
	const selectionTerm = new VirtualTerminal(120, 20);
	const controlTui = new TUI(controlTerm);
	const selectionTui = new TUI(selectionTerm);
	const controlRows = new TranscriptRows(content);
	const selectionRows = new TranscriptRows(content);
	controlTui.addChild(controlRows);
	selectionTui.addChild(selectionRows);
	controlTui.start();
	selectionTui.start();
	try {
		await settle(controlTerm);
		await settle(selectionTerm);
		const controlFrames: FrameMeasurement[] = [];
		const selectionFrames: FrameMeasurement[] = [];
		for (let frame = 0; frame < FRAMES_PER_RUN; frame++) {
			// Interleave equivalent requested frames. The control arm intentionally
			// suppresses navigation state while the selection arm changes one row.
			controlFrames.push(await renderFrame(controlTui, controlTerm, "selection-perf.control"));
			selectionRows.select(Math.floor((frame * (TRANSCRIPT_ROWS - 1)) / (FRAMES_PER_RUN - 1)));
			selectionFrames.push(await renderFrame(selectionTui, selectionTerm, "selection-perf.selection"));
		}
		return { control: combine(controlFrames), selection: combine(selectionFrames) };
	} finally {
		controlTui.stop();
		selectionTui.stop();
	}
}

function assertGutterInvariants(): void {
	const content = "CJK 선택 항목은 폭이 좁을 때 정확하게 줄바꿈되어야 합니다. stable payload";
	for (const width of [40, 120]) {
		const text = new Text(content, 0, 0);
		const markdown = new Markdown(content, 0, 0, defaultMarkdownTheme);
		const controlAnchor = new Markdown(content, 0, 0, defaultMarkdownTheme).renderWithViewportAnchorSource(
			width - GUTTER.length,
			{
				id: "control",
			},
		);
		const selectionAnchor = new Markdown(content, 0, 0, defaultMarkdownTheme).renderWithViewportAnchorSource(
			width - GUTTER.length,
			{ id: "selection" },
		);
		expect(text.render(width - GUTTER.length).length).toBeGreaterThan(0);
		expect(markdown.render(width - GUTTER.length).length).toBeGreaterThan(0);
		// The row content gets the same width in either arm, so source anchors
		// resolve over an identical wrapped line topology.
		expect(selectionAnchor.lines).toEqual(controlAnchor.lines);
	}

	const fixture = ["first CJK 선택 항목", "middle content", "last CJK 선택 항목"];
	const control = new TranscriptRows(fixture);
	const selected = new TranscriptRows(fixture);
	for (const index of [0, 1, fixture.length - 1]) {
		selected.select(index);
		const controlLines = control.render(120);
		const selectedLines = selected.render(120);
		for (let row = 0; row < fixture.length; row++) {
			const plainControl = Bun.stripANSI(controlLines[row]);
			const plainSelected = Bun.stripANSI(selectedLines[row]);
			expect(plainControl.slice(GUTTER.length)).toBe(plainSelected.slice(GUTTER.length));
			expect(Bun.stringWidth(plainControl.slice(0, GUTTER.length))).toBe(GUTTER.length);
			expect(Bun.stringWidth(plainSelected.slice(0, GUTTER.length))).toBe(GUTTER.length);
			if (row === index) {
				expect(selectedLines[row].startsWith(SELECTED_GUTTER)).toBe(true);
				expect(selectedLines[row].slice(SELECTED_GUTTER.length)).toBe(controlLines[row].slice(GUTTER.length));
			} else {
				expect(selectedLines[row]).toBe(controlLines[row]);
			}
		}
	}
}

function report(run: number, control: ArmMeasurement, selection: ArmMeasurement): void {
	console.log(
		`[transcript-selection-perf] run=${run} control renderTree=${control.renderTreeMs.toFixed(2)}ms totalFrame=${control.totalFrameMs.toFixed(2)}ms ` +
			`lines=n${control.lineCounts.normalized}/d${control.lineCounts.diffed}/o${control.lineCounts.offscreenScan}; ` +
			`selection renderTree=${selection.renderTreeMs.toFixed(2)}ms totalFrame=${selection.totalFrameMs.toFixed(2)}ms ` +
			`ratios=renderTree:${(selection.renderTreeMs / control.renderTreeMs).toFixed(3)},totalFrame:${(selection.totalFrameMs / control.totalFrameMs).toFixed(3)} ` +
			`lines=n${selection.lineCounts.normalized}/d${selection.lineCounts.diffed}/o${selection.lineCounts.offscreenScan}`,
	);
}

describe("inline transcript selection benchmark", () => {
	it("uses real paired TUI frames and retains fixed-gutter content/anchor parity", async () => {
		assertGutterInvariants();
		renderMetrics.enable();
		try {
			for (let run = 1; run <= RUNS; run++) {
				const { control, selection } = await measurePairedRun();
				report(run, control, selection);
				const renderTreeRatio = selection.renderTreeMs / control.renderTreeMs;
				const totalFrameRatio = selection.totalFrameMs / control.totalFrameMs;
				expect(Number.isFinite(renderTreeRatio)).toBe(true);
				expect(Number.isFinite(totalFrameRatio)).toBe(true);
				expect(control.lineCounts.normalized).toBeGreaterThan(0);
				expect(selection.lineCounts.normalized).toBeGreaterThan(0);
				if (PROMOTION_GATE) {
					expect(renderTreeRatio).toBeLessThanOrEqual(MAX_RATIO);
					expect(totalFrameRatio).toBeLessThanOrEqual(MAX_RATIO);
					expect(selection.lineCounts.normalized).toBeLessThanOrEqual(MAX_SELECTION_NORMALIZED);
					expect(selection.lineCounts.diffed).toBeLessThanOrEqual(MAX_SELECTION_DIFFED);
					expect(selection.lineCounts.offscreenScan).toBeLessThanOrEqual(MAX_SELECTION_OFFSCREEN_SCAN);
				}
			}
		} finally {
			renderMetrics.disable();
			renderMetrics.reset();
		}
	}, 300_000);
});
