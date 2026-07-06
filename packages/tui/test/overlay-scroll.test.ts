import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { type Component, CURSOR_MARKER, TUI } from "@gajae-code/tui";
import { VirtualTerminal } from "./virtual-terminal";

class LineComponent implements Component {
	constructor(
		private readonly prefix: string,
		private readonly count: number,
	) {}

	invalidate(): void {
		// No cached state
	}

	render(_width: number): string[] {
		return Array.from({ length: this.count }, (_v, i) => `${this.prefix}${i}`);
	}
}

class MutableContentComponent implements Component {
	#lines: string[];

	constructor(lines: string[]) {
		this.#lines = [...lines];
	}

	setLines(lines: string[]): void {
		this.#lines = [...lines];
	}

	invalidate(): void {
		// No cached state
	}

	render(_width: number): string[] {
		return [...this.#lines];
	}
}

class CursorOnlyComponent implements Component {
	#cursorCol = 0;
	readonly #line = "cursor-anchor";

	setCursorCol(col: number): void {
		this.#cursorCol = Math.max(0, Math.min(col, this.#line.length));
	}

	invalidate(): void {
		// No cached state
	}

	render(_width: number): string[] {
		return [`${this.#line.slice(0, this.#cursorCol)}${CURSOR_MARKER}${this.#line.slice(this.#cursorCol)}`];
	}
}

function buildRows(count: number): string[] {
	return Array.from({ length: count }, (_v, i) => `row-${i}`);
}

function viewportRowNumbers(term: VirtualTerminal): number[] {
	const rows: number[] = [];
	for (const line of term.getViewport()) {
		const match = line.trim().match(/^row-(\d+)$/);
		if (match) rows.push(Number.parseInt(match[1], 10));
	}
	return rows;
}

function longestBlankRun(lines: string[]): number {
	let longest = 0;
	let current = 0;
	for (const line of lines) {
		if (line.trim().length === 0) {
			current += 1;
			longest = Math.max(longest, current);
		} else {
			current = 0;
		}
	}
	return longest;
}

async function flushRender(term: VirtualTerminal): Promise<void> {
	await new Promise<void>(resolve => process.nextTick(resolve));
	await Bun.sleep(17);
	await term.flush();
}

describe("TUI overlays", () => {
	let previousTmux: string | undefined;
	let previousSty: string | undefined;
	let previousZellij: string | undefined;
	let previousTmuxPane: string | undefined;
	let previousGjcTmuxLaunched: string | undefined;
	let previousTerm: string | undefined;
	let previousLegacyFullRender: string | undefined;

	beforeEach(() => {
		previousTmux = Bun.env.TMUX;
		previousSty = Bun.env.STY;
		previousZellij = Bun.env.ZELLIJ;
		previousLegacyFullRender = Bun.env.PI_TUI_LEGACY_MULTIPLEXER_FULL_RENDER;
		previousTmuxPane = Bun.env.TMUX_PANE;
		previousGjcTmuxLaunched = Bun.env.GJC_TMUX_LAUNCHED;
		previousTerm = Bun.env.TERM;
		delete Bun.env.TMUX;
		delete Bun.env.STY;
		delete Bun.env.ZELLIJ;
		delete Bun.env.PI_TUI_LEGACY_MULTIPLEXER_FULL_RENDER;
		delete Bun.env.TMUX_PANE;
		delete Bun.env.GJC_TMUX_LAUNCHED;
		Bun.env.TERM = "xterm-256color";
	});

	afterEach(() => {
		if (previousTmux === undefined) {
			delete Bun.env.TMUX;
		} else {
			Bun.env.TMUX = previousTmux;
		}
		if (previousSty === undefined) {
			delete Bun.env.STY;
		} else {
			Bun.env.STY = previousSty;
		}
		if (previousZellij === undefined) {
			delete Bun.env.ZELLIJ;
		} else {
			Bun.env.ZELLIJ = previousZellij;
		}
		if (previousLegacyFullRender === undefined) {
			delete Bun.env.PI_TUI_LEGACY_MULTIPLEXER_FULL_RENDER;
		} else {
			Bun.env.PI_TUI_LEGACY_MULTIPLEXER_FULL_RENDER = previousLegacyFullRender;
		}
		if (previousTmuxPane === undefined) {
			delete Bun.env.TMUX_PANE;
		} else {
			Bun.env.TMUX_PANE = previousTmuxPane;
		}
		if (previousGjcTmuxLaunched === undefined) {
			delete Bun.env.GJC_TMUX_LAUNCHED;
		} else {
			Bun.env.GJC_TMUX_LAUNCHED = previousGjcTmuxLaunched;
		}
		if (previousTerm === undefined) {
			delete Bun.env.TERM;
		} else {
			Bun.env.TERM = previousTerm;
		}
	});

	it("does not scroll the terminal when an overlay is shown with a large historical working area", async () => {
		const term = new VirtualTerminal(80, 24);
		const tui = new TUI(term);

		tui.addChild(new LineComponent("base-", 5));

		tui.start();
		await flushRender(term);

		// Simulate a large historical working area (max lines ever rendered) without actually
		// rendering that many lines in the current view.
		(tui as unknown as { maxLinesRendered: number }).maxLinesRendered = 1500;

		tui.showOverlay(new LineComponent("overlay-", 3), { anchor: "center" });
		await flushRender(term);

		// The scroll buffer should stay small; we should not have printed hundreds/thousands of blank lines.
		expect(term.getScrollBuffer().length).toBeLessThan(200);
	});

	it("clears preexisting terminal scrollback on startup full redraw", async () => {
		const term = new VirtualTerminal(40, 4);
		term.write("shell-0\r\nshell-1\r\nshell-2\r\nshell-3\r\nshell-4\r\n");
		await flushRender(term);

		const tui = new TUI(term);
		const component = new MutableContentComponent(["ui-0", "ui-1", "ui-2", "ui-3", "ui-4", "ui-5"]);
		tui.addChild(component);

		tui.start();
		await flushRender(term);

		term.resize(39, 4);
		await flushRender(term);

		const scrollback = term.getScrollBuffer().join("\n");
		expect(scrollback.includes("shell-0")).toBeFalsy();

		tui.stop();
	});

	it("preserves rendered scrollback on forced redraw after startup", async () => {
		const term = new VirtualTerminal(40, 4);
		const tui = new TUI(term);
		const component = new MutableContentComponent(buildRows(120));
		tui.addChild(component);

		tui.start();
		await flushRender(term);

		const before = term.getScrollBuffer().join("\n");
		expect(before.includes("row-0")).toBeTruthy();

		tui.requestRender(true);
		await flushRender(term);

		const after = term.getScrollBuffer().join("\n");
		expect(after.includes("row-0")).toBeTruthy();

		tui.stop();
	});
	it("fully redraws on height increase to avoid stale viewport rows", async () => {
		const term = new VirtualTerminal(40, 4);
		term.write("shell-0\r\nshell-1\r\nshell-2\r\nshell-3\r\nshell-4\r\n");
		await flushRender(term);

		const tui = new TUI(term);
		const component = new MutableContentComponent(["ui-0", "ui-1", "ui-2", "ui-3"]);
		tui.addChild(component);

		tui.start();
		await flushRender(term);

		term.resize(40, 8);
		await flushRender(term);

		const viewport = term.getViewport().join("\n");
		expect(viewport.includes("shell-")).toBeFalsy();

		tui.stop();
	});
	it("renders viewport-only on resize when content size is stable", async () => {
		const term = new VirtualTerminal(60, 8);
		const tui = new TUI(term);
		const component = new MutableContentComponent(Array.from({ length: 140 }, (_v, i) => `row-${i}`));
		tui.addChild(component);
		try {
			tui.start();
			await flushRender(term);
			const before = term.getScrollBuffer().length;

			for (let i = 0; i < 8; i++) {
				term.resize(i % 2 === 0 ? 59 : 60, i % 2 === 0 ? 9 : 8);
				await flushRender(term);
			}

			const after = term.getScrollBuffer().length;
			expect(after - before).toBeLessThan(120);
		} finally {
			tui.stop();
		}
	});

	it("renders a fresh viewport on resize when content grows before resize", async () => {
		const term = new VirtualTerminal(60, 8);
		const tui = new TUI(term);
		const component = new MutableContentComponent(Array.from({ length: 8 }, (_v, i) => `row-${i}`));
		tui.addChild(component);
		try {
			tui.start();
			await flushRender(term);
			component.setLines(Array.from({ length: 140 }, (_v, i) => `row-${i}`));
			term.resize(59, 9);
			await flushRender(term);
			const viewport = term.getViewport();
			expect(viewport.at(-1)?.includes("row-139")).toBeTruthy();
		} finally {
			tui.stop();
		}
	});

	it("keeps scrollback on viewport-only resize redraw", async () => {
		const term = new VirtualTerminal(40, 4);
		term.write("shell-0\r\nshell-1\r\nshell-2\r\nshell-3\r\n");
		await flushRender(term);
		const tui = new TUI(term);
		tui.addChild(new MutableContentComponent(["ui-0", "ui-1", "ui-2", "ui-3", "ui-4"]));
		try {
			tui.start();
			await flushRender(term);
			term.resize(39, 4);
			await flushRender(term);
			const scrollback = term.getScrollBuffer().join("\n");
			expect(scrollback.includes("shell-0")).toBeFalsy();
		} finally {
			tui.stop();
		}
	});

	it("pushes overflow growth into scrollback during viewport repaint", async () => {
		const term = new VirtualTerminal(40, 4);
		const tui = new TUI(term);
		const component = new MutableContentComponent(buildRows(4));
		tui.addChild(component);
		try {
			tui.start();
			await flushRender(term);

			for (let count = 5; count <= 29; count++) {
				component.setLines(buildRows(count));
				term.resize(40, count % 2 === 0 ? 4 : 5);
				await flushRender(term);
			}

			const scrollbackLines = term.getScrollBuffer().map(line => line.trim());
			expect(scrollbackLines).toContain("row-0");
			expect(scrollbackLines).toContain("row-12");
			const viewport = term.getViewport().map(line => line.trim());
			expect(viewport.at(-1)).toBe("row-28");
		} finally {
			tui.stop();
		}
	});

	it("stays anchored across shrink-grow cycles while overflowing viewport", async () => {
		const term = new VirtualTerminal(30, 6);
		const tui = new TUI(term);
		const component = new MutableContentComponent(Array.from({ length: 64 }, (_v, i) => `row-${i}`));
		tui.addChild(component);
		try {
			tui.start();
			await flushRender(term);

			for (let cycle = 0; cycle < 3; cycle++) {
				component.setLines(Array.from({ length: 64 - cycle * 8 }, (_v, i) => `row-${i}`));
				tui.requestRender();
				await flushRender(term);

				component.setLines(Array.from({ length: 64 - cycle * 8 + 4 }, (_v, i) => `row-${i}`));
				tui.requestRender();
				await flushRender(term);
			}

			const viewport = term.getViewport().map(line => line.trim());
			expect(viewport.every(line => /^row-\d+$/.test(line))).toBeTruthy();
			const viewportRows = viewport.map(line => Number.parseInt(line.slice(4), 10));
			expect(viewportRows.at(-1)).toBe(51);
			expect(viewportRows[0]).toBeGreaterThanOrEqual(40);
		} finally {
			tui.stop();
		}
	});

	it("updates hardware cursor without redrawing content", async () => {
		const term = new VirtualTerminal(40, 6);
		const tui = new TUI(term, true);
		const component = new CursorOnlyComponent();
		tui.addChild(component);
		try {
			tui.start();
			await flushRender(term);
			const before = term.getScrollBuffer().length;

			for (let col = 0; col <= 10; col++) {
				component.setCursorCol(col);
				tui.requestRender();
				await flushRender(term);
			}

			const viewport = term.getViewport();
			expect(viewport[0]?.trim()).toBe("cursor-anchor");
			expect(term.getScrollBuffer().length - before).toBeLessThan(2);
		} finally {
			tui.stop();
		}
	});

	it("limits scrollback growth during resize oscillation with overflowing content", async () => {
		const term = new VirtualTerminal(60, 10);
		const tui = new TUI(term);
		const component = new MutableContentComponent(buildRows(160));
		tui.addChild(component);
		try {
			tui.start();
			await flushRender(term);
			const before = term.getScrollBuffer().length;

			for (let i = 0; i < 18; i++) {
				component.setLines(buildRows(140 + (i % 6) * 8));
				term.resize(i % 2 === 0 ? 59 : 60, i % 3 === 0 ? 11 : 10);
				tui.requestRender();
				await flushRender(term);
				const viewportRows = viewportRowNumbers(term);
				expect(viewportRows.length).toBeGreaterThan(0);
			}

			const scrollback = term.getScrollBuffer();
			expect(scrollback.length - before).toBeLessThan(220);
			expect(longestBlankRun(scrollback)).toBeLessThan(30);
		} finally {
			tui.stop();
		}
	});

	it("limits scrollback while toggling overlays over overflowing content", async () => {
		const term = new VirtualTerminal(60, 10);
		const tui = new TUI(term);
		const component = new MutableContentComponent(buildRows(150));
		tui.addChild(component);
		try {
			tui.start();
			await flushRender(term);
			const before = term.getScrollBuffer().length;

			for (let i = 0; i < 12; i++) {
				const handle = tui.showOverlay(new LineComponent(`overlay-${i}-`, 3), { anchor: "center" });
				await flushRender(term);
				handle.hide();
				await flushRender(term);

				if (i % 4 === 0) {
					component.setLines(buildRows(140 + (i % 4) * 10));
					tui.requestRender();
					await flushRender(term);
				}

				expect(viewportRowNumbers(term).length).toBeGreaterThan(0);
			}

			const scrollback = term.getScrollBuffer();
			expect(scrollback.length - before).toBeLessThan(320);
			expect(longestBlankRun(scrollback)).toBeLessThan(50);
		} finally {
			tui.stop();
		}
	});

	it("keeps scrollback bounded under rapid micro-resize oscillation", async () => {
		const term = new VirtualTerminal(80, 12);
		const tui = new TUI(term);
		const component = new MutableContentComponent(buildRows(180));
		tui.addChild(component);
		try {
			tui.start();
			await flushRender(term);
			const before = term.getScrollBuffer().length;

			for (let i = 0; i < 24; i++) {
				term.resize(i % 2 === 0 ? 79 : 80, i % 3 === 0 ? 11 : 12);
				await flushRender(term);
				expect(viewportRowNumbers(term).length).toBeGreaterThan(0);
			}

			const scrollback = term.getScrollBuffer();
			expect(scrollback.length - before).toBeLessThan(320);
			expect(longestBlankRun(scrollback)).toBeLessThan(60);
		} finally {
			tui.stop();
		}
	});

	it("avoids scrollback growth on repeated no-op renders with overflowing content", async () => {
		const term = new VirtualTerminal(70, 10);
		const tui = new TUI(term);
		tui.addChild(new MutableContentComponent(buildRows(130)));
		try {
			tui.start();
			await flushRender(term);
			const before = term.getScrollBuffer().length;

			for (let i = 0; i < 16; i++) {
				tui.requestRender();
				await flushRender(term);
			}

			const scrollback = term.getScrollBuffer();
			expect(scrollback.length - before).toBeLessThan(30);
		} finally {
			tui.stop();
		}
	});
	it("stays stable with direct row-delta movement", async () => {
		const term = new VirtualTerminal(50, 10);
		const tui = new TUI(term);
		const component = new MutableContentComponent(buildRows(150));
		tui.addChild(component);
		try {
			tui.start();
			await flushRender(term);
			const before = term.getScrollBuffer().length;

			for (let i = 0; i < 18; i++) {
				component.setLines(buildRows(120 + (i % 8) * 6));
				term.resize(i % 2 === 0 ? 50 : 49, i % 3 === 0 ? 11 : 10);
				tui.requestRender();
				await flushRender(term);
				expect(viewportRowNumbers(term).length).toBeGreaterThan(0);
			}

			const scrollback = term.getScrollBuffer();
			expect(scrollback.length - before).toBeLessThan(260);
			expect(longestBlankRun(scrollback)).toBeLessThan(40);
		} finally {
			tui.stop();
		}
	});
});
