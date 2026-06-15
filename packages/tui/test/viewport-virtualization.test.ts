import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { type Component, renderMetrics, TUI } from "@gajae-code/tui";
import { VirtualTerminal } from "./virtual-terminal";

const FLAG = "PI_TUI_VIRTUAL_VIEWPORT";

/**
 * Component that returns STABLE string instances for unchanged lines (mirroring the
 * real caching components). The virtual-viewport optimization relies on this: an
 * unchanged off-screen line keeps its reference, so its normalized form can be reused.
 */
class CachedLines implements Component {
	#lines: string[];
	constructor(lines: string[]) {
		this.#lines = lines.slice();
	}
	setLine(index: number, value: string): void {
		const next = this.#lines.slice(); // new array, but unchanged entries keep their instances
		next[index] = value;
		this.#lines = next;
	}
	append(value: string): void {
		this.#lines = [...this.#lines, value];
	}
	invalidate(): void {}
	render(_width: number): string[] {
		return this.#lines; // stable array + stable string instances for unchanged lines
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

describe("virtual viewport rendering (W1b / F1)", () => {
	let prevFlag: string | undefined;
	let prevTmux: string | undefined;
	let monotonicNow = 0;

	beforeEach(() => {
		prevFlag = Bun.env[FLAG];
		prevTmux = Bun.env.TMUX;
		delete Bun.env.TMUX;
		monotonicNow = 0;
		vi.spyOn(performance, "now").mockImplementation(() => {
			monotonicNow += 20;
			return monotonicNow;
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		if (prevFlag === undefined) delete Bun.env[FLAG];
		else Bun.env[FLAG] = prevFlag;
		if (prevTmux === undefined) delete Bun.env.TMUX;
		else Bun.env.TMUX = prevTmux;
	});

	/** Run a scripted transcript scenario and capture the visible viewport after each step. */
	async function runScenario(flagOn: boolean): Promise<string[][]> {
		if (flagOn) Bun.env[FLAG] = "1";
		else delete Bun.env[FLAG];
		const term = new VirtualTerminal(40, 12);
		const tui = new TUI(term);
		const rows = Array.from({ length: 80 }, (_v, i) => `line-${i}`);
		const content = new CachedLines(rows);
		tui.addChild(content);
		const snaps: string[][] = [];
		try {
			tui.start();
			await settle(term);
			snaps.push(visible(term)); // initial

			// Append (streaming-like): touches only the bottom/viewport.
			content.append("appended-A");
			content.append("appended-B");
			tui.requestRender();
			await settle(term);
			snaps.push(visible(term));

			// In-place change of a visible (bottom) line.
			content.setLine(81, "appended-A-edited");
			tui.requestRender();
			await settle(term);
			snaps.push(visible(term));

			// Off-screen change (forces the fallback to full normalize/diff).
			content.setLine(0, "line-0-edited-offscreen");
			tui.requestRender();
			await settle(term);
			snaps.push(visible(term));

			// No-op re-render (spinner-like): nothing changed.
			tui.requestRender();
			await settle(term);
			snaps.push(visible(term));

			// Overlay composition (show, then hide).
			const overlay = new CachedLines(["overlay-row-1", "overlay-row-2"]);
			tui.showOverlay(overlay, { anchor: "center" });
			tui.requestRender();
			await settle(term);
			snaps.push(visible(term));

			tui.hideOverlay();
			tui.requestRender();
			await settle(term);
			snaps.push(visible(term));

			// Resize width (forces the full-redraw path) and height.
			term.resize(30, 12);
			await settle(term);
			snaps.push(visible(term));

			term.resize(30, 18);
			await settle(term);
			snaps.push(visible(term));

			// Append after resize so the post-resize windowed path is exercised too.
			content.append("post-resize-append");
			tui.requestRender();
			await settle(term);
			snaps.push(visible(term));
		} finally {
			tui.stop();
		}
		return snaps;
	}

	it("produces byte-identical visible output with the flag on vs off", async () => {
		const off = await runScenario(false);
		const on = await runScenario(true);
		expect(on).toEqual(off);
	});

	it("bounds normalize/diff work to ~viewport on a 100k-line transcript (flag on)", async () => {
		Bun.env[FLAG] = "1";
		const wasEnabled = renderMetrics.enabled;
		renderMetrics.reset();
		renderMetrics.enable();
		const term = new VirtualTerminal(40, 40);
		const tui = new TUI(term);
		const big = Array.from({ length: 100_000 }, (_v, i) => `row-${i}`);
		const content = new CachedLines(big);
		tui.addChild(content);
		try {
			tui.start();
			await settle(term); // first render: full normalize (100k)

			const afterFirst = renderMetrics.snapshot().lineCounts;
			expect(afterFirst.normalized?.max).toBeGreaterThanOrEqual(100_000);

			// Change only the bottom line, then re-render: off-screen prefix is reused.
			content.setLine(99_999, "row-99999-edited");
			tui.requestRender();
			await settle(term);

			const lc = renderMetrics.snapshot().lineCounts;
			// Visible window is 40 rows + 8 overscan; normalized/diffed last value must be bounded,
			// not the full 100k transcript.
			expect(lc.normalized?.last).toBeLessThanOrEqual(60);
			expect(lc.diffed?.last).toBeLessThanOrEqual(60);
			expect(lc.offscreenScan?.last).toBeGreaterThan(99_000);
		} finally {
			tui.stop();
			renderMetrics.reset();
			if (!wasEnabled) renderMetrics.disable();
		}
	});
});
