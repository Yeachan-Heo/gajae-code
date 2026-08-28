import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { type Component, Container, TUI } from "@gajae-code/tui";
import { visibleWidth } from "@gajae-code/tui/utils";
import { VirtualTerminal } from "./virtual-terminal";

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
		} finally {
			tui.stop();
		}
	});

	it("does not remeasure unchanged viewport rows with visibleWidths", async () => {
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

			expect(TUI.getRenderCountersForTest().emitVisibleWidthsLineCount).toBe(0);
		} finally {
			tui.stop();
		}
	});

	it("measures only the dirty viewport row when one raw line changes", async () => {
		const lineCount = 80;
		const edits = 8;
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

			for (let i = 0; i < edits; i++) {
				const next = [...lines];
				next[lineCount - 1] = `\x1b[38;2;80;160;255m${"漢".repeat(8)}-edit-${i}\x1b[0m`;
				component.setLines(next);
				tui.requestLayoutRender("loader");
				await settle(term);
			}

			expect(TUI.getRenderCountersForTest().emitVisibleWidthsLineCount).toBe(edits);
			expect(visible(term).some(line => line.includes("edit-7"))).toBe(true);
		} finally {
			tui.stop();
		}
	});

	it("does not copy the transcript prefix on layout-only ticks when the viewport-anchor cache hits", async () => {
		const transcriptLines = 80;
		const layoutFrames = 8;
		const term = new VirtualTerminal(48, 12);
		const tui = new TUI(term, undefined, { widthSettleMs: 0 });
		const transcript = new Container();
		for (let index = 0; index < transcriptLines; index++) {
			transcript.addChild(new MutableLinesComponent([`line-${index}`]));
		}
		const suffix = new MutableLinesComponent(["status-0"]);
		tui.addChild(transcript);
		tui.addChild(suffix);
		tui.setBottomPinnedComponent(suffix);
		tui.setViewportAnchorComponent(transcript);
		tui.setViewportOutputSource({ identity: "session:layout-reuse", revision: 0n });

		try {
			tui.start();
			await settle(term);

			suffix.setLines(["status-warmup"]);
			tui.requestLayoutRender("layout-reuse-warmup");
			await settle(term);
			TUI.resetRenderCountersForTest();

			for (let index = 1; index <= layoutFrames; index++) {
				suffix.setLines([`status-${index}`]);
				tui.requestLayoutRender("layout-reuse");
				await settle(term);
			}

			const counters = TUI.getRenderCountersForTest();
			expect(counters.offscreenPrefixCompares).toBe(0);
			expect(counters.layoutFrameLineCopies).toBe(0);
			expect(visible(term).some(line => line.includes("status-8"))).toBe(true);
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
