import { describe, expect, it } from "bun:test";
import { type Component, TUI } from "@gajae-code/tui";
import { VirtualTerminal } from "./virtual-terminal";

class FixedLines implements Component {
	#lines: string[];

	constructor(lines: string[]) {
		this.#lines = [...lines];
	}

	invalidate(): void {}

	render(width: number): string[] {
		return this.#lines.map(line => line.slice(0, width));
	}
}

/** Wait past the next-tick debounce and the 16ms frame-budget timer. */
async function settle(term: VirtualTerminal): Promise<void> {
	await new Promise<void>(resolve => process.nextTick(resolve));
	await Bun.sleep(25);
	await term.flush();
}

/** Joined writes excluding the bracketed-paste toggle emitted by terminal start/stop. */
function paintedOutput(term: VirtualTerminal): string {
	return term
		.getWriteLog()
		.filter(w => w !== "\x1b[?2004h" && w !== "\x1b[?2004l")
		.join("");
}

describe("TUI deferred first render", () => {
	it("start() without options paints the first frame immediately (default unchanged)", async () => {
		const term = new VirtualTerminal(40, 8);
		const tui = new TUI(term);
		tui.addChild(new FixedLines(["hello"]));
		try {
			tui.start();
			await settle(term);
			expect(paintedOutput(term)).toContain("hello");
		} finally {
			tui.stop();
		}
	});

	it("deferFirstRender holds all painting until the releasing forced render", async () => {
		const term = new VirtualTerminal(40, 8);
		const tui = new TUI(term);
		tui.addChild(new FixedLines(["themed-content"]));
		try {
			tui.start({ deferFirstRender: true });
			await settle(term);
			expect(paintedOutput(term)).not.toContain("themed-content");

			// Non-forced renders (e.g. theme-change invalidations while the initial
			// appearance detection is still settling) must stay held.
			tui.requestRender();
			await settle(term);
			expect(paintedOutput(term)).not.toContain("themed-content");

			// The releasing forced render paints the full frame.
			tui.requestRender(true);
			await settle(term);
			expect(paintedOutput(term)).toContain("themed-content");
		} finally {
			tui.stop();
		}
	});

	it("renders normally after the hold is released", async () => {
		const term = new VirtualTerminal(40, 8);
		const tui = new TUI(term);
		tui.addChild(new FixedLines(["first"]));
		try {
			tui.start({ deferFirstRender: true });
			tui.requestRender(true);
			await settle(term);
			expect(paintedOutput(term)).toContain("first");

			tui.addChild(new FixedLines(["second"]));
			tui.requestRender();
			await settle(term);
			expect(paintedOutput(term)).toContain("second");
		} finally {
			tui.stop();
		}
	});
});
