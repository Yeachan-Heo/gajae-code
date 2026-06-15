import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { type Component, TUI } from "@gajae-code/tui";
import { renderMetrics } from "@gajae-code/tui/metrics";
import { VirtualTerminal } from "./virtual-terminal";

/**
 * Deterministic `PI_TUI_METRICS` repro for the subagent-await UI perf work.
 *
 * The flicker/CPU problem is mechanical: when a streaming `subagent` await panel
 * sits ABOVE the viewport and its lines change, the TUI must full-repaint
 * (`tui.ts` `firstChanged < viewportTop`) — a full clear + whole-tree re-render.
 * Per-await 500ms churn turned this into a repaint storm that compounded with the
 * number of concurrent awaits and the transcript height.
 *
 * This test pins that cost model with the shared render metrics and proves the two
 * post-fix steady states are cheap:
 *  - PR1 (producer gating) stops idle emits, so the transcript above the viewport
 *    does not change -> zero `firstChanged < viewportTop` full redraws while idle.
 *  - In-viewport changes always patch differentially regardless.
 *
 * It is fully deterministic: no wall clock, `settle()` drives the nextTick render
 * coalescing, and assertions are on counts/causes, not durations.
 */
class MutableLines implements Component {
	#lines: string[];

	constructor(lines: string[]) {
		this.#lines = [...lines];
	}

	set(index: number, value: string): void {
		this.#lines[index] = value;
	}

	invalidate(): void {}

	render(width: number): string[] {
		return this.#lines.map(line => line.slice(0, width));
	}
}

async function settle(term: VirtualTerminal): Promise<void> {
	await new Promise<void>(resolve => process.nextTick(resolve));
	await Bun.sleep(1);
	await term.flush();
}

// Viewport of 8 rows over a 30-line transcript: lines 0..21 are above the viewport
// (earlier subagent await panels), lines 22..29 are visible.
const VIEWPORT_ROWS = 8;
const TRANSCRIPT_LINES = 30;
const ABOVE_VIEWPORT_LINE = 5;
const BOTTOM_LINE = TRANSCRIPT_LINES - 1;

function setup(): { term: VirtualTerminal; tui: TUI; component: MutableLines } {
	const term = new VirtualTerminal(40, VIEWPORT_ROWS);
	const tui = new TUI(term);
	const component = new MutableLines(Array.from({ length: TRANSCRIPT_LINES }, (_v, i) => `line-${i}`));
	tui.addChild(component);
	return { term, tui, component };
}

describe("subagent await panel above-viewport redraw cost (PI_TUI_METRICS)", () => {
	let prevTmux: string | undefined;
	let prevSty: string | undefined;
	let prevZellij: string | undefined;
	let monotonicNow = 0;

	beforeEach(() => {
		// Force the non-multiplexer full-render path so the cost model is deterministic.
		// Keep the TUI render-throttle deterministic without sleeping a real frame per
		// render, so each `requestRender` + `settle` commits its own frame.
		monotonicNow = 0;
		vi.spyOn(performance, "now").mockImplementation(() => {
			monotonicNow += 20;
			return monotonicNow;
		});
		prevTmux = Bun.env.TMUX;
		prevSty = Bun.env.STY;
		prevZellij = Bun.env.ZELLIJ;
		delete Bun.env.TMUX;
		delete Bun.env.STY;
		delete Bun.env.ZELLIJ;
		renderMetrics.enable();
		renderMetrics.reset();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		renderMetrics.disable();
		renderMetrics.reset();
		if (prevTmux === undefined) delete Bun.env.TMUX;
		else Bun.env.TMUX = prevTmux;
		if (prevSty === undefined) delete Bun.env.STY;
		else Bun.env.STY = prevSty;
		if (prevZellij === undefined) delete Bun.env.ZELLIJ;
		else Bun.env.ZELLIJ = prevZellij;
	});

	it("an above-viewport await-panel line change forces a full redraw on every tick (the cost the fix removes)", async () => {
		const { term, tui, component } = setup();
		try {
			tui.start();
			await settle(term);
			renderMetrics.reset();
			const baseFullRedraws = tui.fullRedraws;

			// Five idle await "ticks" that, pre-fix, mutated an above-viewport panel line.
			for (let i = 0; i < 5; i++) {
				component.set(ABOVE_VIEWPORT_LINE, `await-panel tick ${i}`);
				tui.requestRender();
				await settle(term);
			}

			expect(tui.fullRedraws - baseFullRedraws).toBe(5);
			const snapshot = renderMetrics.snapshot();
			expect(snapshot.fullRedrawCauses["firstChanged < viewportTop"]).toBe(5);
			// The render-tree helper timing is recorded — this is the measurement the
			// effort uses to validate the win.
			expect(snapshot.helperStats.renderTree?.count ?? 0).toBeGreaterThan(0);
		} finally {
			tui.stop();
		}
	});

	it("idle re-renders with no above-viewport change cause zero full redraws (PR1-gated steady state)", async () => {
		const { term, tui } = setup();
		try {
			tui.start();
			await settle(term);
			renderMetrics.reset();
			const baseFullRedraws = tui.fullRedraws;

			// PR1 gating means the await producer no longer emits while idle, so the
			// transcript lines above the viewport never change.
			for (let i = 0; i < 5; i++) {
				tui.requestRender();
				await settle(term);
			}

			expect(tui.fullRedraws - baseFullRedraws).toBe(0);
			const snapshot = renderMetrics.snapshot();
			expect(snapshot.fullRedrawCauses["firstChanged < viewportTop"] ?? 0).toBe(0);
			expect(snapshot.repaintStorms).toBe(0);
		} finally {
			tui.stop();
		}
	});

	it("an in-viewport (bottom) change patches differentially without a full redraw", async () => {
		const { term, tui, component } = setup();
		try {
			tui.start();
			await settle(term);
			renderMetrics.reset();
			const baseFullRedraws = tui.fullRedraws;

			for (let i = 0; i < 5; i++) {
				component.set(BOTTOM_LINE, `bottom ${i}`);
				tui.requestRender();
				await settle(term);
			}

			expect(tui.fullRedraws - baseFullRedraws).toBe(0);
			const snapshot = renderMetrics.snapshot();
			expect(snapshot.fullRedrawCauses["firstChanged < viewportTop"] ?? 0).toBe(0);
		} finally {
			tui.stop();
		}
	});
});
