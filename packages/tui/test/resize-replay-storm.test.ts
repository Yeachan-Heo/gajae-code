import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Text } from "../src/components/text";
import { shouldUseViewportRepaintForHost, TUI } from "../src/tui";
import { VirtualTerminal } from "./virtual-terminal";

// Regression test for the multiplexer scrollback replay storm.
//
// Symptom: in a terminal multiplexer (tmux/screen/zellij), resizing the
// terminal — or any forced render — must not replay the whole transcript from
// the top of the screen down to the prompt at high speed. Native scrollback
// remains durable while only the live viewport is repainted.
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
//
// Scope note: these tests observe the IMMEDIATE per-event resize frames only.
// The debounced width-settle repair (resize-width-settle*.test.ts) intentionally
// performs ONE full clear+replay ~1000ms after the last width change — that
// single settled replay is the sanctioned exception to the per-event guard
// pinned here, made safe by running once per settled sequence.
// The renderer keeps the latest logical frame as transient state. Dimension
// changes and historical mutations repaint the viewport rather than clearing or
// replaying the transcript.

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
	let originalLegacyMultiplexerFullRender: string | undefined;

	beforeEach(() => {
		originalLegacyMultiplexerFullRender = process.env.PI_TUI_LEGACY_MULTIPLEXER_FULL_RENDER;
		delete process.env.PI_TUI_LEGACY_MULTIPLEXER_FULL_RENDER;
	});

	afterEach(() => {
		if (originalLegacyMultiplexerFullRender === undefined) delete process.env.PI_TUI_LEGACY_MULTIPLEXER_FULL_RENDER;
		else process.env.PI_TUI_LEGACY_MULTIPLEXER_FULL_RENDER = originalLegacyMultiplexerFullRender;
	});
	describe("viewport-sensitive host detection", () => {
		it("uses viewport repaint for native Windows even when WT_SESSION is missing", () => {
			expect(shouldUseViewportRepaintForHost({ TERM: "xterm-256color" }, "win32")).toBe(true);
		});

		it("uses viewport repaint for real process terminals", () => {
			expect(
				shouldUseViewportRepaintForHost({ TERM: "xterm-256color" }, "darwin", {
					includeNativeWindows: false,
					includeProcessTerminal: true,
				}),
			).toBe(true);
		});
		it("restores legacy full replay when explicitly enabled under a multiplexer", () => {
			expect(
				shouldUseViewportRepaintForHost(
					{ TMUX: "/tmp/fake-tmux,4242,0", PI_TUI_LEGACY_MULTIPLEXER_FULL_RENDER: "1" },
					"darwin",
					{ includeProcessTerminal: true },
				),
			).toBe(false);
			expect(
				shouldUseViewportRepaintForHost(
					{ TERM: "screen-256color", PI_TUI_LEGACY_MULTIPLEXER_FULL_RENDER: "yes" },
					"darwin",
					{ includeProcessTerminal: true },
				),
			).toBe(false);
		});
	});
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
			const term = new VirtualTerminal(COLS, 30, { isProcessTerminal: true });
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
			const term = new VirtualTerminal(COLS, 30, { isProcessTerminal: true });
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
			expect(out).not.toContain("\x1b[29A\r");

			tui.stop();
		});
		it("viewport-only repaint on a width+height resize (the case from the blocking review)", async () => {
			const term = new VirtualTerminal(COLS, 30, { isProcessTerminal: true });
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
		it("uses a bounded viewport repaint for headless forced renders and resize", async () => {
			const term = new VirtualTerminal(COLS, 30);
			const tui = new TUI(term);
			tui.start();
			await term.waitForRender();
			await buildTranscript(tui, term, 60);

			for (let attempt = 0; attempt < 2; attempt++) {
				term.clearWriteLog();
				tui.requestRender(true, `test.headless.force.${attempt}`);
				await term.waitForRender();

				const out = term.getWriteLog().join("");
				expect(distinctReplayedLineMarkers(out)).toBeLessThanOrEqual(term.rows + 2);
				expect(out).not.toContain("\x1b[3J");
			}

			term.clearWriteLog();
			term.resize(COLS, 20);
			await term.waitForRender();
			const resizeOut = term.getWriteLog().join("");
			expect(distinctReplayedLineMarkers(resizeOut)).toBeLessThanOrEqual(term.rows + 2);
			expect(resizeOut).not.toContain("\x1b[3J");

			tui.stop();
		});
	});

	describe("in Windows Terminal", () => {
		let origWtSession: string | undefined;
		let origTermProgram: string | undefined;
		let origTmux: string | undefined;
		let origTmuxPane: string | undefined;
		let origSty: string | undefined;
		let origZellij: string | undefined;
		let origLaunched: string | undefined;

		beforeEach(() => {
			origWtSession = Bun.env.WT_SESSION;
			origTermProgram = Bun.env.TERM_PROGRAM;
			origTmux = Bun.env.TMUX;
			origTmuxPane = Bun.env.TMUX_PANE;
			origSty = Bun.env.STY;
			origZellij = Bun.env.ZELLIJ;
			origLaunched = Bun.env.GJC_TMUX_LAUNCHED;
			Bun.env.WT_SESSION = "test-windows-terminal-session";
			delete Bun.env.TMUX;
			delete Bun.env.TMUX_PANE;
			delete Bun.env.STY;
			delete Bun.env.ZELLIJ;
			delete Bun.env.GJC_TMUX_LAUNCHED;
		});

		afterEach(() => {
			if (origWtSession === undefined) delete Bun.env.WT_SESSION;
			else Bun.env.WT_SESSION = origWtSession;
			if (origTermProgram === undefined) delete Bun.env.TERM_PROGRAM;
			else Bun.env.TERM_PROGRAM = origTermProgram;
			if (origTmux === undefined) delete Bun.env.TMUX;
			else Bun.env.TMUX = origTmux;
			if (origTmuxPane === undefined) delete Bun.env.TMUX_PANE;
			else Bun.env.TMUX_PANE = origTmuxPane;
			if (origSty === undefined) delete Bun.env.STY;
			else Bun.env.STY = origSty;
			if (origZellij === undefined) delete Bun.env.ZELLIJ;
			else Bun.env.ZELLIJ = origZellij;
			if (origLaunched === undefined) delete Bun.env.GJC_TMUX_LAUNCHED;
			else Bun.env.GJC_TMUX_LAUNCHED = origLaunched;
		});

		it("requestRender(true) repaints only the viewport without clearing scrollback", async () => {
			const term = new VirtualTerminal(COLS, 30, { isProcessTerminal: true });
			const tui = new TUI(term);
			tui.start();
			await term.waitForRender();

			await buildTranscript(tui, term, 60);
			term.clearWriteLog();

			// Prompt bells and compaction rebuilds can force a render while the
			// transcript is long. Windows Terminal must not receive a 2J/H/3J full replay.
			tui.requestRender(true, "test.windows.force");
			await term.waitForRender();

			const out = term.getWriteLog().join("");
			expect(distinctReplayedLineMarkers(out)).toBeLessThanOrEqual(term.rows + 2);
			expect(out).not.toContain("\x1b[3J");

			tui.stop();
		});
		it("uses a bounded viewport repaint for headless forced renders", async () => {
			const term = new VirtualTerminal(COLS, 30);
			const tui = new TUI(term);
			tui.start();
			await term.waitForRender();
			await buildTranscript(tui, term, 60);
			term.clearWriteLog();

			tui.requestRender(true, "test.windows.headless.force");
			await term.waitForRender();

			const out = term.getWriteLog().join("");
			expect(distinctReplayedLineMarkers(out)).toBeLessThanOrEqual(term.rows + 2);
			expect(out).not.toContain("\x1b[3J");

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
			const term = new VirtualTerminal(COLS, 30, { isProcessTerminal: true });
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
		let origTmuxPane: string | undefined;
		let origSty: string | undefined;
		let origZellij: string | undefined;
		let origLaunched: string | undefined;

		beforeEach(() => {
			origTermuxVersion = process.env.TERMUX_VERSION;
			origTmux = process.env.TMUX;
			origTmuxPane = process.env.TMUX_PANE;
			origSty = process.env.STY;
			origZellij = process.env.ZELLIJ;
			origLaunched = process.env.GJC_TMUX_LAUNCHED;
			process.env.TERMUX_VERSION = "1";
			delete process.env.TMUX;
			delete process.env.TMUX_PANE;
			delete process.env.STY;
			delete process.env.ZELLIJ;
			delete process.env.GJC_TMUX_LAUNCHED;
		});

		afterEach(() => {
			if (origTermuxVersion === undefined) delete process.env.TERMUX_VERSION;
			else process.env.TERMUX_VERSION = origTermuxVersion;
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
		});

		it("does not full-clear or replay the transcript on a height-only resize", async () => {
			const term = new VirtualTerminal(COLS, 30, { isProcessTerminal: true });
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
		it("uses a bounded viewport repaint for headless height resizes", async () => {
			const term = new VirtualTerminal(COLS, 30, { isProcessTerminal: true });
			const tui = new TUI(term);
			tui.start();
			await term.waitForRender();
			await buildTranscript(tui, term, 60);
			term.clearWriteLog();

			term.resize(COLS, 20);
			await term.waitForRender();

			const out = term.getWriteLog().join("");
			expect(distinctReplayedLineMarkers(out)).toBeLessThanOrEqual(term.rows + 2);
			expect(out).not.toContain("\x1b[3J");

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
		let origWtSession: string | undefined;
		let origTermProgram: string | undefined;

		beforeEach(() => {
			origTmux = process.env.TMUX;
			origTmuxPane = process.env.TMUX_PANE;
			origSty = process.env.STY;
			origZellij = process.env.ZELLIJ;
			origLaunched = process.env.GJC_TMUX_LAUNCHED;
			origTerm = process.env.TERM;
			origWtSession = process.env.WT_SESSION;
			origTermProgram = process.env.TERM_PROGRAM;
			delete process.env.TMUX;
			delete process.env.TMUX_PANE;
			delete process.env.STY;
			delete process.env.ZELLIJ;
			delete process.env.GJC_TMUX_LAUNCHED;
			delete process.env.WT_SESSION;
			delete process.env.TERM_PROGRAM;
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
			if (origWtSession === undefined) delete process.env.WT_SESSION;
			else process.env.WT_SESSION = origWtSession;
			if (origTermProgram === undefined) delete process.env.TERM_PROGRAM;
			else process.env.TERM_PROGRAM = origTermProgram;
		});

		it("uses the host-appropriate forced redraw policy without multiplexer markers", async () => {
			const term = new VirtualTerminal(COLS, 30);
			const tui = new TUI(term);
			tui.start();
			await term.waitForRender();

			await buildTranscript(tui, term, 60);
			term.clearWriteLog();

			tui.requestRender(true, "test.force");
			await term.waitForRender();

			const out = term.getWriteLog().join("");
			// Plain terminals use fullRender on forced redraws, which clears
			// scrollback and replays the full transcript.
			expect(distinctReplayedLineMarkers(out)).toBe(60);
			expect(out).toContain("\x1b[3J");
			expect(out).toContain("\x1b[2J");

			tui.stop();
		});

		it("ignores same-dimension resize events instead of clearing scrollback and replaying (iTerm2 tab switch)", async () => {
			const term = new VirtualTerminal(COLS, 30);
			const tui = new TUI(term);
			tui.start();
			await term.waitForRender();

			await buildTranscript(tui, term, 60);
			term.clearWriteLog();

			// iTerm2 delivers SIGWINCH-driven resize events on tab activation and
			// window focus changes without changing the grid size. Forcing the
			// 2J/H/3J clear+replay on those events rebuilds scrollback and can park
			// the native viewport at the transcript top ("thread jumps to the top
			// after switching tabs"). A same-size event must be a plain diff render.
			term.resize(COLS, 30);
			await term.waitForRender();

			const out = term.getWriteLog().join("");
			expect(out).not.toContain("\x1b[3J");
			expect(out).not.toContain("\x1b[2J");
			expect(distinctReplayedLineMarkers(out)).toBe(0);

			tui.stop();
		});
	});
});

describe("synchronized output compatibility framing", () => {
	const begin = "\x1b[?2026h";
	const end = "\x1b[?2026l";
	const original = Bun.env.GJC_TUI_SYNCHRONIZED_OUTPUT;

	afterEach(() => {
		if (original === undefined) delete Bun.env.GJC_TUI_SYNCHRONIZED_OUTPUT;
		else Bun.env.GJC_TUI_SYNCHRONIZED_OUTPUT = original;
	});

	async function capture(value: string | undefined): Promise<{ writes: string[]; steps: Record<string, string[]> }> {
		if (value === undefined) delete Bun.env.GJC_TUI_SYNCHRONIZED_OUTPUT;
		else Bun.env.GJC_TUI_SYNCHRONIZED_OUTPUT = value;

		const term = new VirtualTerminal(40, 8, { isProcessTerminal: true });
		const tui = new TUI(term, true, { widthSettleMs: 0 });
		const text = new Text("first", 1, 0);
		const steps: Record<string, string[]> = {};
		let writeOffset = 0;
		tui.addChild(text);

		const record = async (name: string, action: () => void): Promise<void> => {
			action();
			await term.waitForRender();
			const writes = term.getWriteLog();
			steps[name] = writes.slice(writeOffset);
			writeOffset = writes.length;
		};

		try {
			await record("full", () => tui.start());
			await record("differential", () => {
				text.setText("second");
				tui.requestRender(false, "test.synchronized-output-differential");
			});
			await record("deletion", () => {
				text.setText("");
				tui.requestRender(false, "test.synchronized-output-delete");
			});
			await record("restart-base", () => {
				text.setText("restart base");
				tui.requestRender(false, "test.synchronized-output-restart-base");
			});
			tui.stop();
			tui.addChild(new Text("restart suffix", 1, 0));
			await record("restart", () => tui.start());
			await record("viewport", () => term.resize(40, 7));
			tui.setPostRenderEmitter(() => "\x1b[?25l");
			await record("overlay", () => {
				text.setText("overlay frame");
				tui.requestRender(false, "test.synchronized-output-overlay");
			});
			return { writes: term.getWriteLog(), steps };
		} finally {
			tui.stop();
		}
	}

	function stripFraming(write: string): string {
		if (write.startsWith(begin) && write.endsWith(end)) {
			return write.slice(begin.length, -end.length);
		}
		return write;
	}

	it("keeps every renderer context framed and preserves write boundaries when disabled", async () => {
		const enabled = await capture(undefined);
		const disabled = await capture("0");

		for (const context of ["full", "differential", "deletion", "restart", "viewport"]) {
			expect(enabled.steps[context]?.some(write => write.startsWith(begin) && write.endsWith(end))).toBe(true);
			expect(disabled.steps[context]?.some(write => write.includes(begin) || write.includes(end))).toBe(false);
		}
		expect(enabled.steps.overlay).toHaveLength(2);
		expect(enabled.steps.overlay?.every(write => write.startsWith(begin) && write.endsWith(end))).toBe(true);
		expect(disabled.steps.overlay).toHaveLength(2);
		expect(disabled.steps.overlay?.some(write => write.includes(begin) || write.includes(end))).toBe(false);
		expect(disabled.writes.length).toBe(enabled.writes.length);
		expect(enabled.writes.map(stripFraming)).toEqual(disabled.writes);
	});

	it("samples the opt-out once when the TUI is constructed", async () => {
		delete Bun.env.GJC_TUI_SYNCHRONIZED_OUTPUT;
		const enabledTerm = new VirtualTerminal(40, 8);
		const enabledTui = new TUI(enabledTerm, true, { widthSettleMs: 0 });
		Bun.env.GJC_TUI_SYNCHRONIZED_OUTPUT = "0";
		enabledTui.addChild(new Text("enabled", 1, 0));
		enabledTui.start();
		await enabledTerm.waitForRender();
		expect(enabledTerm.getWriteLog().some(write => write.includes(begin))).toBe(true);
		enabledTui.stop();

		Bun.env.GJC_TUI_SYNCHRONIZED_OUTPUT = "0";
		const disabledTerm = new VirtualTerminal(40, 8);
		const disabledTui = new TUI(disabledTerm, true, { widthSettleMs: 0 });
		delete Bun.env.GJC_TUI_SYNCHRONIZED_OUTPUT;
		disabledTui.addChild(new Text("disabled", 1, 0));
		disabledTui.start();
		await disabledTerm.waitForRender();
		expect(disabledTerm.getWriteLog().some(write => write.includes(begin) || write.includes(end))).toBe(false);
		disabledTui.stop();
	});
});
