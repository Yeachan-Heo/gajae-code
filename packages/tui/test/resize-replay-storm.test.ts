import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Text } from "../src/components/text";
import { TUI } from "../src/tui";
import { VirtualTerminal } from "./virtual-terminal";

// Regression test for the tmux resize replay storm.
//
// Symptom: in a terminal multiplexer (tmux/screen/zellij), resizing the
// terminal — especially changing only the height — caused the whole transcript
// to replay from the top of the screen down to the prompt at high speed. The
// effect was invisible outside multiplexers because fullRender clears
// scrollback there.
//
// Root cause: InteractiveMode's resize handler unconditionally called
// requestRender(true, "resize"). force=true resets #previousWidth/#previousHeight
// to -1, so #doRender always sees widthChanged===true and routes through
// fullRender. In multiplexers fullRender skips the scrollback-clearing 3J
// escape (users navigate scrollback), so replaying every line piles it back on
// top of scrollback — the visible storm. The fix (requestResizeRender) keeps
// force off in multiplexers so #doRender's height-change branch takes the
// viewport-only multiplexerViewportRepaint path.
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

describe("tmux resize replay storm regression", () => {
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
		// multiplexerViewportRepaint emits at most `height` (20) distinct lines;
		// fullRender would replay all 60.
		expect(distinctReplayedLineMarkers(out)).toBeLessThanOrEqual(22);

		tui.stop();
	});

	it("requestRender(true, resize) still replays the whole transcript (pins why requestResizeRender exists)", async () => {
		const term = new VirtualTerminal(COLS, 30);
		const tui = new TUI(term);
		tui.start();
		await term.waitForRender();

		await buildTranscript(tui, term, 60);
		term.clearWriteLog();

		term.resize(COLS, 20);
		// The old buggy call: force=true forces widthChanged, routing through
		// fullRender → full transcript replay into multiplexer scrollback.
		tui.requestRender(true, "resize");
		await term.waitForRender();

		const out = term.getWriteLog().join("");
		expect(distinctReplayedLineMarkers(out)).toBeGreaterThanOrEqual(55);

		tui.stop();
	});
});
