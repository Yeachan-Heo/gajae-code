import { describe, expect, it } from "bun:test";
import { type Component, TUI } from "@gajae-code/tui";
import { VirtualTerminal } from "./virtual-terminal";

class Lines implements Component {
	#lines: string[];

	constructor(lines: string[]) {
		this.#lines = [...lines];
	}

	append(line: string): void {
		this.#lines = [...this.#lines, line];
	}

	setLine(index: number, line: string): void {
		this.#lines = this.#lines.map((value, currentIndex) => (currentIndex === index ? line : value));
	}

	replace(lines: string[]): void {
		this.#lines = [...lines];
	}

	render(_width: number): string[] {
		return this.#lines;
	}

	invalidate(): void {}
}

async function settle(term: VirtualTerminal): Promise<void> {
	await term.waitForRender();
}

function visible(term: VirtualTerminal): string[] {
	return term.getViewport().map(line => line.trimEnd());
}

describe("TUI manual viewport paging", () => {
	it("pages through the rendered transcript without editing content", async () => {
		const term = new VirtualTerminal(30, 5);
		const tui = new TUI(term);
		const content = new Lines(Array.from({ length: 10 }, (_value, index) => `line-${index}`));
		tui.addChild(content);

		try {
			tui.start();
			await settle(term);
			expect(visible(term)).toEqual(["line-5", "line-6", "line-7", "line-8", "line-9"]);

			expect(tui.scrollViewportPages(-1)).toBe(true);
			await term.flush();
			expect(visible(term)).toEqual(["line-1", "line-2", "line-3", "line-4", "line-5"]);

			expect(tui.scrollViewportPages(1)).toBe(true);
			await term.flush();
			expect(visible(term)).toEqual(["line-5", "line-6", "line-7", "line-8", "line-9"]);
		} finally {
			tui.stop();
		}
	});

	it("keeps the manual viewport stable across new output until following live", async () => {
		const term = new VirtualTerminal(30, 5);
		const tui = new TUI(term);
		const content = new Lines(Array.from({ length: 10 }, (_value, index) => `line-${index}`));
		tui.addChild(content);

		try {
			tui.start();
			await settle(term);

			expect(tui.scrollViewportPages(-1)).toBe(true);
			await term.flush();
			expect(visible(term)).toEqual(["line-1", "line-2", "line-3", "line-4", "line-5"]);

			content.append("line-10");
			tui.requestRender();
			await settle(term);
			expect(visible(term)).toEqual(["line-1", "line-2", "line-3", "line-4", "line-5"]);

			expect(tui.followLiveViewport()).toBe(true);
			await term.flush();
			expect(visible(term)).toEqual(["line-6", "line-7", "line-8", "line-9", "line-10"]);
		} finally {
			tui.stop();
		}
	});

	it("keeps Windows Terminal live output pinned when offscreen lines change during streaming", async () => {
		const term = new VirtualTerminal(30, 5);
		const tui = new TUI(term);
		const content = new Lines(["status-0", ...Array.from({ length: 11 }, (_value, index) => `line-${index}`)]);
		tui.addChild(content);
		const previousWtSession = Bun.env.WT_SESSION;
		Bun.env.WT_SESSION = "test-windows-terminal-session";

		try {
			tui.start();
			await settle(term);
			expect(visible(term)).toEqual(["line-6", "line-7", "line-8", "line-9", "line-10"]);
			term.clearWriteLog();

			content.setLine(0, "status-1");
			content.append("line-11");
			tui.requestRender();
			await settle(term);

			expect(visible(term)).toEqual(["line-7", "line-8", "line-9", "line-10", "line-11"]);
			expect(term.getWriteLog().join("")).not.toContain("\x1b[2J\x1b[H");
		} finally {
			tui.stop();
			if (previousWtSession === undefined) {
				delete Bun.env.WT_SESSION;
			} else {
				Bun.env.WT_SESSION = previousWtSession;
			}
		}
	});

	it("keeps Windows Terminal pinned when offscreen status lines disappear", async () => {
		const term = new VirtualTerminal(30, 5);
		const tui = new TUI(term);
		const content = new Lines(["status-0", ...Array.from({ length: 11 }, (_value, index) => `line-${index}`)]);
		tui.addChild(content);
		const previousWtSession = Bun.env.WT_SESSION;
		Bun.env.WT_SESSION = "test-windows-terminal-session";

		try {
			tui.start();
			await settle(term);
			expect(visible(term)).toEqual(["line-6", "line-7", "line-8", "line-9", "line-10"]);
			term.clearWriteLog();

			content.replace(Array.from({ length: 11 }, (_value, index) => `line-${index}`));
			tui.requestRender();
			await settle(term);

			expect(visible(term)).toEqual(["line-6", "line-7", "line-8", "line-9", "line-10"]);
			expect(term.getWriteLog().join("")).not.toContain("\x1b[2J\x1b[H");
		} finally {
			tui.stop();
			if (previousWtSession === undefined) {
				delete Bun.env.WT_SESSION;
			} else {
				Bun.env.WT_SESSION = previousWtSession;
			}
		}
	});
});
