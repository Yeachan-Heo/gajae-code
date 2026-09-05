import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { type Component, TUI } from "@gajae-code/tui";
import { Loader } from "@gajae-code/tui/components/loader";
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

	it("updates the loader over a long transcript without measuring same-width reflow", async () => {
		const term = new VirtualTerminal(48, 12);
		const lines = Array.from({ length: 2_000 }, (_, i) => `\x1b[36m履歴 ${i} 漢字\x1b[0m`);
		const component = new MutableLinesComponent(lines);
		const tui = new TUI(term, undefined, { widthSettleMs: 0 });
		const loader = new Loader(
			tui,
			text => text,
			text => text,
			"Working",
			["⠋"],
			{ renderScope: "layout" },
		);
		loader.stop();
		tui.addChild(component);
		tui.addChild(loader);
		tui.setBottomPinnedComponent(loader);

		try {
			tui.start();
			await settle(term);
			TUI.resetRenderCountersForTest();

			for (let frame = 0; frame < 8; frame++) {
				loader.setMessage(`Working ${frame}`);
				await settle(term);
				expect(visible(term).join("\n")).toContain(`⠋ Working ${frame}`);
				expect(visible(term).join("\n")).toContain("履歴 1999 漢字");
			}

			expect(TUI.getRenderCountersForTest().widthReflowVisibleWidthCalls).toBe(0);
		} finally {
			loader.stop();
			tui.stop();
		}
	});

	it.each([
		{ columns: 44, text: "漢".repeat(8), expectedMeasurements: 80, visibleText: "漢".repeat(8) },
		{ columns: 12, text: "漢".repeat(20), expectedMeasurements: 1, visibleText: "漢".repeat(6) },
	])("preserves width-change reflow at $columns columns", async ({
		columns,
		text,
		expectedMeasurements,
		visibleText,
	}) => {
		const term = new VirtualTerminal(48, 12);
		const component = new MutableLinesComponent(Array.from({ length: 80 }, () => `\x1b[36m${text}\x1b[0m`));
		const tui = new TUI(term, undefined, { widthSettleMs: 0 });
		tui.addChild(component);

		try {
			tui.start();
			await settle(term);
			TUI.resetRenderCountersForTest();
			term.resize(columns, 12);
			await settle(term);

			expect(TUI.getRenderCountersForTest().widthReflowVisibleWidthCalls).toBe(expectedMeasurements);
			expect(visible(term).filter(Boolean)).toContain(visibleText);
			expect(term.getViewportAnsi()).toContain("\x1b[36m");
			for (const line of visible(term)) expect(visibleWidth(line)).toBeLessThanOrEqual(columns);
		} finally {
			tui.stop();
		}
	});
});
