import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { type Component, TUI } from "@gajae-code/tui";
import { visibleWidth } from "@gajae-code/tui/utils";
import { VirtualTerminal } from "./virtual-terminal";

const widthReflowEvidence = {
	lineCount: 0,
	sameWidthLayoutFrames: 0,
	sameWidthReflowVisibleWidthCalls: -1,
	wouldHaveScannedBefore: 0,
	resizeStillFitsReflowVisibleWidthCalls: -1,
	resizeOverflowReflowVisibleWidthCalls: -1,
};

class MutableLinesComponent implements Component {
	#lines: string[];

	constructor(lines: string[]) {
		this.#lines = [...lines];
	}

	setLines(lines: string[]): void {
		this.#lines = [...lines];
	}

	invalidate(): void {}

	render(_width: number): string[] {
		return [...this.#lines];
	}
}

async function settle(term: VirtualTerminal): Promise<void> {
	await new Promise<void>(resolve => process.nextTick(resolve));
	await Bun.sleep(1);
	await term.flush();
}

function visible(term: VirtualTerminal): string[] {
	return term.getViewport().map(line => line.trimEnd());
}

afterAll(async () => {
	const capturedAt = new Date().toISOString();
	const receipt = {
		title: "Same-width frames skip the widthReflow visibleWidth scan",
		capturedAt,
		contract: {
			hotPath: "packages/tui/src/tui.ts #doRender widthReflowRequired",
			before: "every #doRender walked all rawLines with visibleWidth() even when widthChanged was false, then discarded the result",
			after: "the scan runs only when widthChanged && previousWidth > 0; same-width layout ticks measure 0 reflow rows",
			counter: "TUI.getRenderCountersForTest().widthReflowVisibleWidthCalls",
		},
		measured: widthReflowEvidence,
		expected: {
			sameWidthReflowVisibleWidthCalls: 0,
			resizeStillFitsReflowVisibleWidthCalls: widthReflowEvidence.lineCount,
			resizeOverflowReflowVisibleWidthCalls: 1,
			wouldHaveScannedBefore:
				widthReflowEvidence.lineCount * widthReflowEvidence.sameWidthLayoutFrames,
		},
		reproducibleTests: [
			{
				command:
					'bun test packages/tui/test/render-helper-counts.test.ts -t "does not scan raw rows with visibleWidth when width is unchanged"',
				asserts: "8 same-width requestLayoutRender frames over 80 ANSI/CJK rows -> widthReflowVisibleWidthCalls === 0 (would have been 640 before)",
			},
			{
				command:
					'bun test packages/tui/test/render-helper-counts.test.ts -t "still walks raw rows on a column change that does not overflow"',
				asserts: "48->44 resize, rows still fit -> widthReflowVisibleWidthCalls === 80",
			},
			{
				command:
					'bun test packages/tui/test/render-helper-counts.test.ts -t "stops the width-reflow scan at the first overflowing raw row"',
				asserts: "80->30 resize, first row overflows -> widthReflowVisibleWidthCalls === 1",
			},
		],
	};
	await Bun.write(
		"artifacts/width-reflow-visible-width-evidence.json",
		`${JSON.stringify(receipt, null, "\t")}\n`,
	);
});

describe("TUI render helper counters", () => {
	let previousDebugRedraw: string | undefined;
	let monotonicNow = 0;

	beforeEach(() => {
		previousDebugRedraw = Bun.env.PI_DEBUG_REDRAW;
		delete Bun.env.PI_DEBUG_REDRAW;
		monotonicNow = 0;
		TUI.resetRenderCountersForTest();
		vi.spyOn(performance, "now").mockImplementation(() => {
			monotonicNow += 20;
			return monotonicNow;
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		TUI.resetRenderCountersForTest();
		if (previousDebugRedraw === undefined) {
			delete Bun.env.PI_DEBUG_REDRAW;
		} else {
			Bun.env.PI_DEBUG_REDRAW = previousDebugRedraw;
		}
	});

	it("caches PI_DEBUG_REDRAW and does not append debug logs when disabled", async () => {
		const term = new VirtualTerminal(40, 8);
		const component = new MutableLinesComponent(["one", "two"]);
		const tui = new TUI(term);
		tui.addChild(component);

		try {
			tui.start();
			await settle(term);

			for (let i = 0; i < 5; i++) {
				component.setLines([`one-${i}`, "two"]);
				tui.requestRender(true, "debug-cache-test");
				await settle(term);
			}

			const counters = TUI.getRenderCountersForTest();
			expect(counters.debugRedrawEnvReads).toBeLessThanOrEqual(1);
			expect(counters.debugRedrawAppendWrites).toBe(0);
		} finally {
			tui.stop();
		}
	});

	it("reuses normalized line widths in the differential truncation guard", async () => {
		const term = new VirtualTerminal(12, 8);
		const component = new MutableLinesComponent(Array.from({ length: 6 }, (_v, i) => `stable-${i}`));
		const tui = new TUI(term);
		tui.addChild(component);

		try {
			tui.start();
			await settle(term);
			TUI.resetRenderCountersForTest();

			const wideLines = Array.from({ length: 6 }, (_v, i) => `${"界".repeat(10)}-${i}`);
			component.setLines(wideLines);
			tui.requestRender(true, "width-reuse-test");
			await settle(term);

			const counters = TUI.getRenderCountersForTest();
			expect(counters.differentialGuardVisibleWidthCalls).toBe(0);
			const viewport = visible(term);
			expect(viewport[0]).toBe("界".repeat(6));
			expect(visibleWidth(viewport[0]!)).toBe(12);
		} finally {
			tui.stop();
		}
	});

	it("does not scan raw rows with visibleWidth when width is unchanged", async () => {
		const lineCount = 80;
		const layoutFrames = 8;
		const lines = Array.from(
			{ length: lineCount },
			(_v, i) => `\x1b[38;2;80;160;255m${"漢".repeat(8)}-${i}\x1b[0m`,
		);
		const term = new VirtualTerminal(48, 12);
		const component = new MutableLinesComponent(lines);
		const tui = new TUI(term, undefined, { widthSettleMs: 0 });
		tui.addChild(component);

		try {
			tui.start();
			await settle(term);
			TUI.resetRenderCountersForTest();

			for (let i = 0; i < layoutFrames; i++) {
				tui.requestLayoutRender("loader");
				await settle(term);
			}

			expect(TUI.getRenderCountersForTest().widthReflowVisibleWidthCalls).toBe(0);
			widthReflowEvidence.lineCount = lineCount;
			widthReflowEvidence.sameWidthLayoutFrames = layoutFrames;
			widthReflowEvidence.sameWidthReflowVisibleWidthCalls =
				TUI.getRenderCountersForTest().widthReflowVisibleWidthCalls;
			widthReflowEvidence.wouldHaveScannedBefore = lineCount * layoutFrames;
		} finally {
			tui.stop();
		}
	});

	it("still walks raw rows on a column change that does not overflow", async () => {
		const lineCount = 80;
		const lines = Array.from(
			{ length: lineCount },
			(_v, i) => `\x1b[38;2;80;160;255m${"漢".repeat(8)}-${i}\x1b[0m`,
		);
		const term = new VirtualTerminal(48, 12);
		const component = new MutableLinesComponent(lines);
		const tui = new TUI(term, undefined, { widthSettleMs: 0 });
		tui.addChild(component);

		try {
			tui.start();
			await settle(term);
			TUI.resetRenderCountersForTest();

			term.resize(44, 12);
			await settle(term);

			expect(TUI.getRenderCountersForTest().widthReflowVisibleWidthCalls).toBe(lineCount);
			widthReflowEvidence.resizeStillFitsReflowVisibleWidthCalls =
				TUI.getRenderCountersForTest().widthReflowVisibleWidthCalls;
		} finally {
			tui.stop();
		}
	});

	it("stops the width-reflow scan at the first overflowing raw row", async () => {
		const lines = Array.from({ length: 40 }, (_v, i) => `\x1b[31m${"漢".repeat(20)}-${i}\x1b[0m`);
		const term = new VirtualTerminal(80, 12);
		const component = new MutableLinesComponent(lines);
		const tui = new TUI(term, undefined, { widthSettleMs: 0 });
		tui.addChild(component);

		try {
			tui.start();
			await settle(term);
			TUI.resetRenderCountersForTest();

			term.resize(30, 12);
			await settle(term);

			expect(TUI.getRenderCountersForTest().widthReflowVisibleWidthCalls).toBe(1);
			widthReflowEvidence.resizeOverflowReflowVisibleWidthCalls =
				TUI.getRenderCountersForTest().widthReflowVisibleWidthCalls;
		} finally {
			tui.stop();
		}
	});

	it("treats empty differential rows as zero-width without measuring them", async () => {
		const term = new VirtualTerminal(12, 8);
		const component = new MutableLinesComponent(["before", "", ""]);
		const tui = new TUI(term);
		tui.addChild(component);

		try {
			tui.start();
			await settle(term);
			TUI.resetRenderCountersForTest();

			component.setLines(["after", "", ""]);
			tui.requestRender(true, "empty-row-width-test");
			await settle(term);

			expect(TUI.getRenderCountersForTest().differentialGuardVisibleWidthCalls).toBe(0);
		} finally {
			tui.stop();
		}
	});
});
