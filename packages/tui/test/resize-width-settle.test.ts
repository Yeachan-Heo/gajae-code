import { describe, expect, it } from "bun:test";
import { getDefaultTabWidth, setDefaultTabWidth } from "@gajae-code/utils";
import { Text } from "../src/components/text";
import { TUI } from "../src/tui";
import { VirtualTerminal } from "./virtual-terminal";

// Width reflow can leave stale wrapped bands that the immediate resize frame
// does not repair. The immediate frame is unchanged; what these tests pin is the
// trailing repair: exactly one extra forced redraw 1000ms after the last observed
// width change, no matter how many SIGWINCHes arrived. Height-only changes keep
// their existing behavior and never arm the timer.

const COLS = 100;
const SETTLE_MS = 1000;

async function buildTranscript(tui: TUI, term: VirtualTerminal, count: number): Promise<void> {
	for (let i = 0; i < count; i++) {
		tui.addChild(new Text(`L${i}:${"x".repeat(20)}`, 1, 0));
	}
	tui.requestRender(false, "setup");
	await term.waitForRender();
}

function distinctReplayedLineMarkers(out: string): number {
	return new Set(out.match(/L\d+:/g) ?? []).size;
}

describe("debounced full redraw on terminal width change", () => {
	it("emits exactly one extra full redraw after the width settles", async () => {
		const term = new VirtualTerminal(COLS, 30);
		const tui = new TUI(term);
		tui.start();
		await term.waitForRender();
		await buildTranscript(tui, term, 60);
		term.clearWriteLog();

		// Drag-resize storm: several width changes in quick succession.
		for (let i = 1; i <= 5; i++) {
			term.resize(COLS - i, 30);
			await term.waitForRender();
		}
		const beforeSettle = tui.fullRedraws;

		await Bun.sleep(SETTLE_MS + 200);
		// One deferred forced redraw, not one per SIGWINCH.
		expect(tui.fullRedraws).toBe(beforeSettle + 1);
		const out = term.getWriteLog().join("");
		expect(distinctReplayedLineMarkers(out)).toBeGreaterThanOrEqual(55);

		tui.stop();
	});

	it("does not schedule a settled redraw for a height-only change", async () => {
		const term = new VirtualTerminal(COLS, 30);
		const tui = new TUI(term);
		tui.start();
		await term.waitForRender();
		await buildTranscript(tui, term, 60);

		term.resize(COLS, 24);
		await term.waitForRender();
		// The height change itself still renders through the existing path.
		term.clearWriteLog();

		await Bun.sleep(SETTLE_MS + 200);
		expect(term.getWriteLog().join("")).toBe("");

		tui.stop();
	});

	it("still repairs once when the width returns to its original value", async () => {
		const term = new VirtualTerminal(COLS, 30);
		const tui = new TUI(term);
		tui.start();
		await term.waitForRender();
		await buildTranscript(tui, term, 60);
		term.resize(COLS - 10, 30);
		await term.waitForRender();
		term.resize(COLS, 30);
		await term.waitForRender();
		const beforeSettle = tui.fullRedraws;

		await Bun.sleep(SETTLE_MS + 200);
		expect(tui.fullRedraws).toBe(beforeSettle + 1);

		tui.stop();
	});

	it("cancels a pending settled redraw when the TUI stops, even if it restarts before the deadline", async () => {
		const term = new VirtualTerminal(COLS, 30);
		const tui = new TUI(term);
		tui.start();
		await term.waitForRender();
		await buildTranscript(tui, term, 60);

		term.resize(COLS - 10, 30);
		await term.waitForRender();
		tui.stop();

		// Restart WELL BEFORE the original deadline. A stopped-guard alone would not
		// catch a leaked timer here: the TUI is running again when it would fire, so
		// only real cancellation in stop() keeps the count flat.
		await Bun.sleep(SETTLE_MS / 4);
		tui.start();
		await term.waitForRender();
		const afterRestart = tui.fullRedraws;

		await Bun.sleep(SETTLE_MS + 200);
		expect(tui.fullRedraws).toBe(afterRestart);

		tui.stop();
	});

	it("repairs a coalesced width burst that never commits an intermediate frame", async () => {
		const term = new VirtualTerminal(COLS, 30);
		const tui = new TUI(term);
		tui.start();
		await term.waitForRender();
		await buildTranscript(tui, term, 60);
		const beforeBurst = tui.fullRedraws;

		// No waitForRender between these: #previousWidth stays at COLS for the whole
		// burst, so a debounce keyed to the committed frame width would never see the
		// second transition and would skip the only repair.
		term.resize(COLS - 10, 30);
		term.resize(COLS, 30);
		await term.waitForRender();

		await Bun.sleep(SETTLE_MS + 200);
		expect(tui.fullRedraws).toBeGreaterThan(beforeBurst);

		tui.stop();
	});

	it("does not arm the timer for a same-width resize event right after start", async () => {
		const term = new VirtualTerminal(COLS, 30);
		const tui = new TUI(term);
		tui.start();
		await term.waitForRender();
		await buildTranscript(tui, term, 60);
		const beforeSpurious = tui.fullRedraws;

		// iTerm2 tab activation and the self-sent SIGWINCH after resume deliver a
		// resize event with unchanged dimensions.
		term.resize(COLS, 30);
		await term.waitForRender();

		await Bun.sleep(SETTLE_MS + 200);
		expect(tui.fullRedraws).toBe(beforeSpurious);

		tui.stop();
	});

	it("defers the settled repair while the user reads scrollback and runs it on follow-live", async () => {
		const term = new VirtualTerminal(COLS, 30);
		const tui = new TUI(term);
		tui.start();
		await term.waitForRender();
		await buildTranscript(tui, term, 60);

		// Enter manual viewport (user reading history), then resize the width.
		expect(tui.scrollViewportPages(-1)).toBe(true);
		await term.waitForRender();
		term.resize(COLS - 15, 30);
		await term.waitForRender();
		const beforeDeadline = tui.fullRedraws;

		// The deadline passes while manual: no forced replay may rip the user out.
		await Bun.sleep(SETTLE_MS + 200);
		expect(tui.fullRedraws).toBe(beforeDeadline);

		// Returning to live runs the deferred repair: one full clear+replay at the
		// new width, landing at the live bottom with no stale pending flag. The
		// write log is cleared here so the assertions below prove the FOLLOW-LIVE
		// frames contain the repair — not leftovers from startup or setup.
		term.clearWriteLog();
		expect(tui.followLiveViewport()).toBe(true);
		await term.waitForRender();
		const afterFollow = tui.fullRedraws;
		expect(afterFollow).toBe(beforeDeadline + 1);
		const out = term.getWriteLog().join("");
		expect(out).toContain("\x1b[2J\x1b[H\x1b[3J");
		expect(distinctReplayedLineMarkers(out)).toBeGreaterThanOrEqual(55);

		// The flag was consumed: nothing further fires after another window.
		await Bun.sleep(SETTLE_MS + 200);
		expect(tui.fullRedraws).toBe(afterFollow);

		tui.stop();
	});

	it("keeps the deferred repair across stop/start while manual viewport survives", async () => {
		const term = new VirtualTerminal(COLS, 30);
		const tui = new TUI(term);
		tui.start();
		await term.waitForRender();
		await buildTranscript(tui, term, 60);

		// Manual viewport, width change, deadline passes while manual -> deferred.
		expect(tui.scrollViewportPages(-1)).toBe(true);
		await term.waitForRender();
		term.resize(COLS - 15, 30);
		await term.waitForRender();
		await Bun.sleep(SETTLE_MS + 200);

		// Ctrl-Z resume / external editor: temporary stop/start. Manual viewport
		// ownership survives restart, and so must the deferred repair.
		tui.stop();
		tui.start();
		await term.waitForRender();

		term.clearWriteLog();
		expect(tui.followLiveViewport()).toBe(true);
		await term.waitForRender();
		const out = term.getWriteLog().join("");
		expect(out).toContain("\x1b[2J\x1b[H\x1b[3J");
		expect(distinctReplayedLineMarkers(out)).toBeGreaterThanOrEqual(55);

		tui.stop();
	});
	it("defers tab-width scrollback repair until manual history returns live", async () => {
		const originalTabWidth = getDefaultTabWidth();
		const term = new VirtualTerminal(COLS, 30);
		const tui = new TUI(term);

		try {
			tui.start();
			await term.waitForRender();
			await buildTranscript(tui, term, 60);
			expect(tui.scrollViewportPages(-1)).toBe(true);
			await term.waitForRender();

			const beforeTabWidthChange = tui.fullRedraws;
			term.clearWriteLog();
			setDefaultTabWidth(originalTabWidth === 8 ? 4 : 8);
			await term.waitForRender();
			expect(tui.fullRedraws).toBe(beforeTabWidthChange);

			expect(tui.followLiveViewport()).toBe(true);
			await term.waitForRender();
			const output = term.getWriteLog().join("");
			expect(tui.fullRedraws).toBe(beforeTabWidthChange + 1);
			expect(output).toContain("\x1b[2J\x1b[H\x1b[3J");
		} finally {
			tui.stop();
			setDefaultTabWidth(originalTabWidth);
		}
	});
	it("keeps a deferred tab-width repair across a temporary manual-history restart", async () => {
		const originalTabWidth = getDefaultTabWidth();
		const term = new VirtualTerminal(COLS, 30);
		const tui = new TUI(term);

		try {
			tui.start();
			await term.waitForRender();
			await buildTranscript(tui, term, 60);
			expect(tui.scrollViewportPages(-1)).toBe(true);
			await term.waitForRender();

			setDefaultTabWidth(originalTabWidth === 8 ? 4 : 8);
			await term.waitForRender();
			tui.stop();
			tui.start();
			await term.waitForRender();

			term.clearWriteLog();
			expect(tui.followLiveViewport()).toBe(true);
			await term.waitForRender();
			expect(term.getWriteLog().join("")).toContain("\x1b[2J\x1b[H\x1b[3J");
		} finally {
			tui.stop();
			setDefaultTabWidth(originalTabWidth);
		}
	});
});
