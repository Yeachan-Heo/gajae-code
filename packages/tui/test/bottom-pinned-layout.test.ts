import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { type Component, TUI } from "@gajae-code/tui";
import { VirtualTerminal } from "./virtual-terminal";

class LinesComponent implements Component {
	constructor(private readonly lines: string[]) {}

	invalidate(): void {}

	render(_width: number): string[] {
		return this.lines;
	}
}

describe("TUI bottom-pinned layout", () => {
	it("pads short content so the pinned component reaches the bottom row", async () => {
		const term = new VirtualTerminal(40, 8);
		const tui = new TUI(term);
		const header = new LinesComponent(["forge"]);
		const pinned = new LinesComponent(["status", "composer"]);

		tui.addChild(header);
		tui.addChild(pinned);
		tui.setBottomPinnedComponent(pinned);

		try {
			tui.start();
			await term.waitForRender();

			const viewport = term.getViewport().map(line => line.trimEnd());
			expect(viewport[0]).toBe("forge");
			expect(viewport.slice(1, 6)).toEqual(["", "", "", "", ""]);
			expect(viewport[6]).toBe("status");
			expect(viewport[7]).toBe("composer");
		} finally {
			tui.stop();
		}
	});

	it("does not insert spacer rows when content already exceeds the viewport", async () => {
		const term = new VirtualTerminal(40, 4);
		const tui = new TUI(term);
		const header = new LinesComponent(["line-0", "line-1", "line-2"]);
		const pinned = new LinesComponent(["status", "composer"]);

		tui.addChild(header);
		tui.addChild(pinned);
		tui.setBottomPinnedComponent(pinned);

		try {
			tui.start();
			await term.waitForRender();

			const viewport = term.getViewport().map(line => line.trimEnd());
			expect(viewport).toEqual(["line-1", "line-2", "status", "composer"]);
		} finally {
			tui.stop();
		}
	});

	describe("with the GJC psmux launch marker", () => {
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

		it("keeps the pinned group on the last row after a viewport resize", async () => {
			const term = new VirtualTerminal(40, 6, { isProcessTerminal: true });
			const tui = new TUI(term);
			const header = new LinesComponent(["forge"]);
			const pinned = new LinesComponent(["status", "composer"]);

			tui.addChild(header);
			tui.addChild(pinned);
			tui.setBottomPinnedComponent(pinned);

			try {
				tui.start();
				await term.waitForRender();

				term.clearWriteLog();
				term.resize(40, 9);
				await term.waitForRender();

				const viewport = term.getViewport().map(line => line.trimEnd());
				expect(viewport[0]).toBe("forge");
				expect(viewport.slice(1, 7)).toEqual(["", "", "", "", "", ""]);
				expect(viewport[7]).toBe("status");
				expect(viewport[8]).toBe("composer");
				expect(term.getWriteLog().join("")).not.toContain("\x1b[3J");
			} finally {
				tui.stop();
			}
		});
	});
});
