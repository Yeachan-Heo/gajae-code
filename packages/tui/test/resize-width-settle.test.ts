import { describe, expect, it } from "bun:test";
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
});
