import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { type Component, TUI } from "@gajae-code/tui";
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
});
