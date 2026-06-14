// MUST be first: pins terminal-capability env before @gajae-code/tui evaluates.
import "./render-goldens-env";
import { describe, expect, it } from "bun:test";
import { Editor, Text, TUI } from "@gajae-code/tui";
import { $flag } from "@gajae-code/utils";
import { defaultEditorTheme } from "./test-themes";
import { VirtualTerminal } from "./virtual-terminal";

/**
 * Repro for the keyboard render-staleness regression.
 *
 * The bug: keystrokes are captured correctly (no key loss), but while the render
 * cadence is hot (model streaming / busy event loop) an input keystroke's render
 * request is coalesced behind the streaming render timer and is NOT prioritized,
 * so the *displayed* editor lags the input buffer (freeze-then-burst, stale
 * cursor/spacing) until a later frame commits. Content-agnostic.
 *
 * Deterministic discriminator: non-forced renders only ever commit via setTimeout
 * (`#scheduleRender`), never on `process.nextTick`. So observing the viewport at a
 * pure `process.nextTick` boundary after input-while-streaming is stale on the
 * buggy scheduler and fresh once input renders are expedited. This is independent
 * of wall-clock timing, so it is not flaky under machine/CI load.
 */

const nextTick = (): Promise<void> => new Promise<void>(r => process.nextTick(r));
const macro0 = (): Promise<void> => new Promise<void>(r => setTimeout(r, 0));

interface Harness {
	term: VirtualTerminal;
	tui: TUI;
	editor: Editor;
}

function setup(cols = 80, rows = 20, transcriptLines = 40): Harness {
	const term = new VirtualTerminal(cols, rows);
	const tui = new TUI(term);
	tui.start();
	for (let i = 0; i < transcriptLines; i++) {
		tui.addChild(new Text(`transcript line ${String(i).padStart(2, "0")} :: streamed assistant content`, 1, 0));
	}
	const editor = new Editor(defaultEditorTheme);
	tui.addChild(editor);
	tui.setFocus(editor);
	tui.requestRender(false, "init");
	return { term, tui, editor };
}

/** Make `#lastRenderAt` fresh so the next non-forced render is delayed by the frame budget. */
async function hotRender(h: Harness): Promise<void> {
	h.tui.requestRender(false, "stream.hot");
	await macro0();
	await h.term.flush();
}

describe("keyboard input render latency under streaming load", () => {
	it("never drops keystrokes during fast typing interleaved with streaming (hard gate)", async () => {
		const h = setup();
		await h.term.waitForRender();

		const typed = "the quick brown fox 0123456789";
		let expected = "";
		for (const ch of typed) {
			// Streaming keeps the render cadence hot, then a keystroke arrives.
			h.tui.requestRender(false, "stream.chunk");
			h.term.sendInput(ch);
			expected += ch;
			await nextTick();
		}
		await h.term.waitForRender();

		expect(h.editor.getText()).toBe(expected); // no key loss
		expect((await h.term.flushAndGetViewport()).join("\n")).toContain(typed); // visible after settle
		h.tui.stop();
	}, 20000);

	it("renders ASCII, Korean/CJK, and emoji correctly under load (content-agnostic, hard gate)", async () => {
		const h = setup();
		await h.term.waitForRender();

		const segments = ["ascii123", "한글입력", "👨‍👩‍👧‍👦", "x"];
		let expected = "";
		for (const seg of segments) {
			h.tui.requestRender(false, "stream.chunk");
			h.term.sendInput(seg);
			expected += seg;
			await nextTick();
		}
		await h.term.waitForRender();

		expect(h.editor.getText()).toBe(expected); // no loss / no mojibake
		const viewport = (await h.term.flushAndGetViewport()).join("\n");
		expect(viewport).toContain("ascii123");
		expect(viewport).toContain("한글입력");
		h.tui.stop();
	}, 20000);

	it("echoes input within one frame while a streaming render is pending (regression gate)", async () => {
		const h = setup();
		await h.term.waitForRender();
		await hotRender(h); // cadence hot: a non-forced render is now delayed ~16ms

		// Streaming render is pending; a keystroke arrives in that window.
		h.tui.requestRender(false, "stream.next");
		h.term.sendInput("ZQX");

		// Observe at a pure microtask boundary (no timer). On the buggy scheduler the
		// keystroke is starved behind the streaming setTimeout and is not yet visible;
		// once input renders are expedited it commits here.
		await nextTick();
		await h.term.flush();
		const echoedWithinFrame = h.term.getViewport().join("\n").includes("ZQX");

		await h.term.waitForRender();
		const echoedAfterSettle = h.term.getViewport().join("\n").includes("ZQX");

		expect(h.editor.getText()).toBe("ZQX"); // captured regardless (no key loss)
		expect(echoedAfterSettle).toBe(true); // eventually consistent on any scheduler
		expect(echoedWithinFrame).toBe(true); // FAILS on the buggy scheduler; passes once expedited
		h.tui.stop();
	}, 20000);

	// Advisory wall-clock evidence only (never a hard gate): records how many frame
	// budgets elapse before a keystroke is visible under hot streaming cadence.
	it("records advisory input-to-visible-render evidence", async () => {
		const h = setup();
		await h.term.waitForRender();

		const samples: number[] = [];
		for (let k = 0; k < 12; k++) {
			await hotRender(h);
			h.tui.requestRender(false, "stream.next");
			const t0 = performance.now();
			h.term.sendInput("k");
			// Poll until the keystroke is visible, capped to avoid hangs.
			let elapsed = 0;
			for (let i = 0; i < 64; i++) {
				await macro0();
				await h.term.flush();
				if (
					h.term
						.getViewport()
						.join("\n")
						.includes("kkkkk".slice(0, k + 1))
				) {
					elapsed = performance.now() - t0;
					break;
				}
			}
			samples.push(elapsed);
		}
		samples.sort((a, b) => a - b);
		const p50 = samples[Math.floor(samples.length * 0.5)] ?? 0;
		const p95 = samples[Math.floor(samples.length * 0.95)] ?? 0;
		const max = samples[samples.length - 1] ?? 0;
		console.log(
			`[input-latency][advisory] p50=${p50.toFixed(2)}ms p95=${p95.toFixed(2)}ms max=${max.toFixed(2)}ms (n=${samples.length})`,
		);
		// Advisory: only enforced when explicitly opted in for calibrated runs.
		if ($flag("PI_TUI_INPUT_LATENCY_GATE")) {
			expect(p95).toBeLessThan(16);
		}
		expect(Number.isFinite(p95)).toBe(true);
		h.tui.stop();
	}, 30000);
});
