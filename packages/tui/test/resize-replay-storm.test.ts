import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Text } from "../src/components/text";
import { TUI } from "../src/tui";
import { VirtualTerminal } from "./virtual-terminal";

// Regression test for the multiplexer scrollback replay storm.
//
// Symptom: in a terminal multiplexer (tmux/screen/zellij), resizing the
// terminal — or any forced render — replayed the whole transcript from the
// top of the screen down to the prompt at high speed. Invisible outside
// multiplexers because the same path clears scrollback there.
//
// Root cause (now fixed at the source): requestRender(true) resets
// #previousWidth/#previousHeight to -1, so #doRender always sees widthChanged
// and routed through fullRender. The widthChanged branch was checked BEFORE
// the multiplexer-guarded heightChanged branch and had NO guard of its own, so
// every forced render (resize, autocomplete cancel, resume) replayed the full
// transcript into multiplexer scrollback.
//
// Fix: (1) requestResizeRender() keeps force off in multiplexers for the
// dedicated resize path; (2) the widthChanged branch now takes the
// multiplexerViewportRepaint path in multiplexers, neutralizing the fake width
// change for ALL force-render call sites; (3) onAutocompleteCancel no longer
// forces.
//
// Set PI_TUI_LEGACY_MULTIPLEXER_FULL_RENDER=1 to opt back into the old behavior.

const COLS = 100;

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

describe("multiplexer resize replay storm regression", () => {
	describe("in a multiplexer (TMUX set)", () => {
		let origTmux: string | undefined;

		beforeEach(() => {
			origTmux = process.env.TMUX;
			// Any truthy value trips isMultiplexerSession() in tui.ts.
			process.env.TMUX = "/tmp/fake-tmux,4242,0";
		});

		afterEach(() => {
			if (origTmux === undefined) delete process.env.TMUX;
			else process.env.TMUX = origTmux;
		});

		it("requestResizeRender repaints only the viewport on a height-only change", async () => {
			const term = new VirtualTerminal(COLS, 30);
			const tui = new TUI(term);
			tui.start();
			await term.waitForRender();

			await buildTranscript(tui, term, 60);
			term.clearWriteLog();

			// Height-only shrink. VirtualTerminal.resize() invokes the TUI resize
			// callback, which now calls requestResizeRender().
			term.resize(COLS, 20);
			await term.waitForRender();

			const out = term.getWriteLog().join("");
			// multiplexerViewportRepaint emits at most `height` (20) distinct lines.
			expect(distinctReplayedLineMarkers(out)).toBeLessThanOrEqual(22);

			tui.stop();
		});

		it("requestRender(true) is safe in multiplexers (widthChanged guard neutralizes the fake width change)", async () => {
			const term = new VirtualTerminal(COLS, 30);
			const tui = new TUI(term);
			tui.start();
			await term.waitForRender();

			await buildTranscript(tui, term, 60);
			term.clearWriteLog();

			// force=true resets #previousWidth to -1, which used to force widthChanged
			// and a full replay. The widthChanged branch now routes to viewport repaint.
			tui.requestRender(true, "test.force");
			await term.waitForRender();

			const out = term.getWriteLog().join("");
			// force=true still resets #previousWidth to -1, but the widthChanged guard
			// now routes to viewport repaint: at most `rows` distinct lines, never the
			// full 60-line transcript.
			expect(distinctReplayedLineMarkers(out)).toBeLessThanOrEqual(term.rows + 2);

			tui.stop();
		});
		it("viewport-only repaint on a width+height resize (the case from the blocking review)", async () => {
			const term = new VirtualTerminal(COLS, 30);
			const tui = new TUI(term);
			tui.start();
			await term.waitForRender();

			await buildTranscript(tui, term, 60);
			term.clearWriteLog();

			// Width+height resize (100x30 -> 90x20): the exact scenario that returned
			// distinct=60 in the review before the widthChanged guard. term.resize()
			// fires the resize callback (requestResizeRender); the widthChanged branch
			// now takes the viewport-repaint path in multiplexers instead of replaying
			// all 60 transcript lines.
			term.resize(COLS - 10, 20);
			await term.waitForRender();

			const out = term.getWriteLog().join("");
			expect(distinctReplayedLineMarkers(out)).toBeLessThanOrEqual(term.rows + 2);

			tui.stop();
		});
	});

	describe("in a GJC-launched psmux pane without TMUX env", () => {
		let origTmux: string | undefined;
		let origTmuxPane: string | undefined;
		let origLaunched: string | undefined;

		beforeEach(() => {
			origTmux = process.env.TMUX;
			origTmuxPane = process.env.TMUX_PANE;
			origLaunched = process.env.GJC_TMUX_LAUNCHED;
			delete process.env.TMUX;
			delete process.env.TMUX_PANE;
			process.env.GJC_TMUX_LAUNCHED = "1";
		});

		afterEach(() => {
			if (origTmux === undefined) delete process.env.TMUX;
			else process.env.TMUX = origTmux;
			if (origTmuxPane === undefined) delete process.env.TMUX_PANE;
			else process.env.TMUX_PANE = origTmuxPane;
			if (origLaunched === undefined) delete process.env.GJC_TMUX_LAUNCHED;
			else process.env.GJC_TMUX_LAUNCHED = origLaunched;
		});

		it("treats the launched pane as a multiplexer for forced redraws", async () => {
			const term = new VirtualTerminal(COLS, 30);
			const tui = new TUI(term);
			tui.start();
			await term.waitForRender();

			await buildTranscript(tui, term, 60);
			term.clearWriteLog();

			tui.requestRender(true, "test.psmux.force");
			await term.waitForRender();

			const out = term.getWriteLog().join("");
			expect(distinctReplayedLineMarkers(out)).toBeLessThanOrEqual(term.rows + 2);
			expect(out).not.toContain("\x1b[3J");

			tui.stop();
		});
	});

	describe("in Termux", () => {
		let origTermuxVersion: string | undefined;
		let origTmux: string | undefined;
		let origSty: string | undefined;
		let origZellij: string | undefined;
		let origLaunched: string | undefined;

		beforeEach(() => {
			origTermuxVersion = process.env.TERMUX_VERSION;
			origTmux = process.env.TMUX;
			origSty = process.env.STY;
			origZellij = process.env.ZELLIJ;
			origLaunched = process.env.GJC_TMUX_LAUNCHED;
			process.env.TERMUX_VERSION = "1";
			delete process.env.TMUX;
			delete process.env.STY;
			delete process.env.ZELLIJ;
			delete process.env.GJC_TMUX_LAUNCHED;
		});

		afterEach(() => {
			if (origTermuxVersion === undefined) delete process.env.TERMUX_VERSION;
			else process.env.TERMUX_VERSION = origTermuxVersion;
			if (origTmux === undefined) delete process.env.TMUX;
			else process.env.TMUX = origTmux;
			if (origSty === undefined) delete process.env.STY;
			else process.env.STY = origSty;
			if (origZellij === undefined) delete process.env.ZELLIJ;
			else process.env.ZELLIJ = origZellij;
			if (origLaunched === undefined) delete process.env.GJC_TMUX_LAUNCHED;
			else process.env.GJC_TMUX_LAUNCHED = origLaunched;
		});

		it("does not full-clear or replay the transcript on a height-only resize", async () => {
			const term = new VirtualTerminal(COLS, 30);
			const tui = new TUI(term);
			tui.start();
			await term.waitForRender();

			await buildTranscript(tui, term, 60);
			term.clearWriteLog();

			term.resize(COLS, 20);
			await term.waitForRender();

			const out = term.getWriteLog().join("");
			expect(out).not.toContain("\x1b[3J");
			expect(distinctReplayedLineMarkers(out)).toBeLessThan(60);

			tui.stop();
		});
	});
	describe("in a plain terminal (no multiplexer markers)", () => {
		let origTmux: string | undefined;
		let origTmuxPane: string | undefined;
		let origSty: string | undefined;
		let origZellij: string | undefined;
		let origLaunched: string | undefined;
		let origTerm: string | undefined;

		beforeEach(() => {
			origTmux = process.env.TMUX;
			origTmuxPane = process.env.TMUX_PANE;
			origSty = process.env.STY;
			origZellij = process.env.ZELLIJ;
			origLaunched = process.env.GJC_TMUX_LAUNCHED;
			origTerm = process.env.TERM;
			delete process.env.TMUX;
			delete process.env.TMUX_PANE;
			delete process.env.STY;
			delete process.env.ZELLIJ;
			delete process.env.GJC_TMUX_LAUNCHED;
			process.env.TERM = "xterm-256color";
		});

		afterEach(() => {
			if (origTmux === undefined) delete process.env.TMUX;
			else process.env.TMUX = origTmux;
			if (origTmuxPane === undefined) delete process.env.TMUX_PANE;
			else process.env.TMUX_PANE = origTmuxPane;
			if (origSty === undefined) delete process.env.STY;
			else process.env.STY = origSty;
			if (origZellij === undefined) delete process.env.ZELLIJ;
			else process.env.ZELLIJ = origZellij;
			if (origLaunched === undefined) delete process.env.GJC_TMUX_LAUNCHED;
			else process.env.GJC_TMUX_LAUNCHED = origLaunched;
			if (origTerm === undefined) delete process.env.TERM;
			else process.env.TERM = origTerm;
		});

		it("requestRender(true) replays the whole transcript (fullRender + 3J clears scrollback cleanly)", async () => {
			const term = new VirtualTerminal(COLS, 30);
			const tui = new TUI(term);
			tui.start();
			await term.waitForRender();

			await buildTranscript(tui, term, 60);
			term.clearWriteLog();

			tui.requestRender(true, "test.force");
			await term.waitForRender();

			const out = term.getWriteLog().join("");
			// Outside multiplexers fullRender replays every line (and 3J clears the
			// scrollback, so it is visually clean). This pins that the guard only
			// changes behavior under multiplexers.
			expect(distinctReplayedLineMarkers(out)).toBeGreaterThanOrEqual(55);

			tui.stop();
		});
	});
});
