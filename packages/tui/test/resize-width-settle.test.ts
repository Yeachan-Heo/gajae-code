import { describe, expect, it } from "bun:test";
import { Text } from "../src/components/text";
import { TUI } from "../src/tui";
import { VirtualTerminal } from "./virtual-terminal";

// Width reflow leaves stale wrapped bands that a differential render cannot
// repair, so a width change must end in a full redraw. Forcing one per SIGWINCH
// during a drag-resize is a replay storm, so the redraw is deferred until the
// width has been stable for 1000ms. Height-only changes keep their behavior.

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

	it("skips the settled redraw when the width returns to its original value", async () => {
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
		expect(tui.fullRedraws).toBe(beforeSettle);

		tui.stop();
	});

	it("cancels a pending settled redraw when the TUI stops", async () => {
		const term = new VirtualTerminal(COLS, 30);
		const tui = new TUI(term);
		tui.start();
		await term.waitForRender();
		await buildTranscript(tui, term, 60);

		term.resize(COLS - 10, 30);
		await term.waitForRender();
		tui.stop();
		term.clearWriteLog();

		await Bun.sleep(SETTLE_MS + 200);
		expect(term.getWriteLog().join("")).toBe("");
	});
});
