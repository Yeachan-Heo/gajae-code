import { describe, expect, it } from "bun:test";
import { type Component, TUI } from "@gajae-code/tui";
import { VirtualTerminal } from "./virtual-terminal";

class LinesComponent implements Component {
	constructor(public lines: string[]) {}

	render(_width: number): string[] {
		return this.lines;
	}

	invalidate(): void {}
}

/**
 * Reproduces issue #6501: TUI intermittently goes blank after stop/start cycle.
 *
 * Root cause: #hardwareCursorRow is not reset in stop(), so after a terminal
 * is stopped and restarted, the stale cursor row position causes viewport
 * calculations to become incorrect, resulting in blank or incorrect content display.
 */
describe("TUI frame state consistency (issue #6501)", () => {
	it("renders content after stop-restart cycle", async () => {
		const term = new VirtualTerminal(40, 8);
		const tui = new TUI(term);
		const component = new LinesComponent(["line-0", "line-1", "line-2"]);

		tui.addChild(component);

		try {
			// Initial render
			tui.start();
			await term.waitForRender();

			let viewport = term.getViewport().map(line => line.trimEnd());
			expect(viewport[0]).toBe("line-0");
			expect(viewport[1]).toBe("line-1");
			expect(viewport[2]).toBe("line-2");

			// Stop and restart (simulates suspend+restart or editor mode transitions)
			tui.stop();
			await Bun.sleep(10);

			// Clear the terminal and log to verify content is actually re-painted after start()
			term.clear();
			term.clearWriteLog();

			tui.start();
			await term.waitForRender();

			// Verify that content was actually written to the terminal after restart
			// (this catches the bug where #hardwareCursorRow was stale, preventing repaints)
			const writeLog = term.getWriteLog();
			expect(writeLog.length).toBeGreaterThan(0);

			// Verify content is still visible (not blank)
			viewport = term.getViewport().map(line => line.trimEnd());
			expect(viewport[0]).toBe("line-0");
			expect(viewport[1]).toBe("line-1");
			expect(viewport[2]).toBe("line-2");
		} finally {
			tui.stop();
		}
	});

	it("clears stale pre-stop content on the first frame after restart", async () => {
		const term = new VirtualTerminal(40, 8);
		const tui = new TUI(term);
		const component = new LinesComponent(["line-0", "line-1", "line-2"]);

		tui.addChild(component);

		try {
			tui.start();
			await term.waitForRender();
			expect(term.getViewport()[2]?.trimEnd()).toBe("line-2");

			// stop() leaves the old frame on screen; the restarted TUI must not paint over it blindly.
			tui.stop();
			await Bun.sleep(10);
			component.lines = ["only"];

			tui.start();
			await term.waitForRender();

			const viewport = term.getViewport().map(line => line.trimEnd());
			expect(viewport[0]).toBe("only");
			expect(viewport.slice(1).every(line => line === "")).toBe(true);
		} finally {
			tui.stop();
		}
	});

	it("renders after multiple stop-restart cycles", async () => {
		const term = new VirtualTerminal(40, 4);
		const tui = new TUI(term);
		const component = new LinesComponent(["content"]);

		tui.addChild(component);

		try {
			for (let i = 0; i < 3; i++) {
				term.clear();
				term.clearWriteLog();

				tui.start();
				await term.waitForRender();

				// Verify content is visible on each cycle
				const viewport = term.getViewport().map(line => line.trimEnd());
				expect(viewport.some(line => line.includes("content"))).toBe(true);

				// Verify that content was actually written to the terminal
				const writeLog = term.getWriteLog();
				expect(writeLog.length).toBeGreaterThan(0);

				tui.stop();
				await Bun.sleep(10);
			}
		} finally {
			tui.stop();
		}
	});

	it("renders correctly with content at viewport boundaries after restart", async () => {
		const term = new VirtualTerminal(50, 7);
		const tui = new TUI(term);
		const component = new LinesComponent(["first", "second", "third", "fourth"]);

		tui.addChild(component);

		try {
			tui.start();
			await term.waitForRender();

			let viewport = term.getViewport().map(line => line.trimEnd());
			expect(viewport[0]).toBe("first");
			expect(viewport[1]).toBe("second");

			tui.stop();
			await Bun.sleep(10);

			// Clear the terminal and log to verify content is actually re-painted after start()
			term.clear();
			term.clearWriteLog();

			// Restart and render - content must be displayed correctly from the beginning
			tui.start();
			await term.waitForRender();

			// Verify that content was actually written to the terminal after restart
			const writeLog = term.getWriteLog();
			expect(writeLog.length).toBeGreaterThan(0);

			viewport = term.getViewport().map(line => line.trimEnd());
			// Critical check: viewport must start with the first line, not skip content
			expect(viewport[0]).toBe("first");
			expect(viewport[1]).toBe("second");
			expect(viewport[2]).toBe("third");
		} finally {
			tui.stop();
		}
	});
});
