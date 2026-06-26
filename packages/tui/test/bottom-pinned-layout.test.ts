import { describe, expect, it } from "bun:test";
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
});
