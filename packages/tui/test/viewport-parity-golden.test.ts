import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { type Component, renderMetrics, TUI } from "@gajae-code/tui";
import { makeRecordedSession, runReplay } from "./replay-harness";
import { VirtualTerminal } from "./virtual-terminal";

const FLAG = "PI_TUI_VIRTUAL_VIEWPORT";
const OVERSCAN = 8;

class MutableLines implements Component {
	#lines: string[];

	constructor(lines: string[]) {
		this.#lines = lines.slice();
	}

	setLine(index: number, value: string): void {
		const next = this.#lines.slice();
		next[index] = value;
		this.#lines = next;
	}

	append(value: string): void {
		this.#lines = [...this.#lines, value];
	}

	get length(): number {
		return this.#lines.length;
	}

	invalidate(): void {}

	render(_width: number): string[] {
		return this.#lines;
	}
}

function rows(count: number, prefix = "row"): string[] {
	return Array.from({ length: count }, (_unused, index) => `${prefix}-${index}`);
}

async function settle(term: VirtualTerminal): Promise<void> {
	await term.waitForRender();
}

function capture(term: VirtualTerminal): { viewport: string[]; scrollback: string[]; writes: string[] } {
	return {
		viewport: term.getViewport(),
		scrollback: term.getScrollBuffer(),
		writes: term.getWriteLog(),
	};
}

async function withViewportFlag<T>(value: "0" | "1", fn: () => Promise<T>): Promise<T> {
	Bun.env[FLAG] = value;
	return await fn();
}

async function runInteractiveScenario(
	flag: "0" | "1",
): Promise<{ viewport: string[]; scrollback: string[]; writes: string[] }> {
	return await withViewportFlag(flag, async () => {
		const term = new VirtualTerminal(52, 12);
		const tui = new TUI(term);
		const content = new MutableLines([
			...rows(70),
			"wide-start-abcdefghijklmnopqrstuvwxyz-ABCDEFGHIJKLMNOPQRSTUVWXYZ",
		]);
		tui.addChild(content);

		try {
			tui.start();
			await settle(term);

			// Bottom append storm: unchanged off-screen prefix plus changing visible tail.
			for (let i = 0; i < 16; i++) content.append(`append-storm-${i}`);
			tui.requestRender(false, "parity.append-storm");
			await settle(term);

			// Visible edit.
			content.setLine(content.length - 2, "append-storm-visible-edit");
			tui.requestRender(false, "parity.visible-edit");
			await settle(term);

			// Off-screen mutation: must fall back to full normalization/diff equivalence.
			content.setLine(1, "row-1-offscreen-edited");
			tui.requestRender(false, "parity.offscreen-edit");
			await settle(term);

			// Overlay open/close over overflowing content.
			const handle = tui.showOverlay(new MutableLines(["overlay-open", "choice-A", "choice-B"]), {
				anchor: "top-left",
				row: 2,
				col: 4,
			});
			await settle(term);
			handle.hide();
			await settle(term);

			// Width and height changes.
			term.resize(37, 12);
			await settle(term);
			term.resize(64, 9);
			await settle(term);
			term.resize(52, 12);
			await settle(term);

			// Manual viewport scrollback up/down, then follow live.
			expect(tui.scrollViewportPages(-1)).toBe(true);
			await term.flush();
			expect(tui.scrollViewportPages(1)).toBe(true);
			await term.flush();
			tui.followLiveViewport();
			await term.flush();

			content.append("after-manual-viewport-follow");
			tui.requestRender(false, "parity.after-manual");
			await settle(term);

			await term.flush();
			return capture(term);
		} finally {
			tui.stop();
		}
	});
}

describe("virtual viewport golden parity", () => {
	let previousFlag: string | undefined;
	let previousTmux: string | undefined;
	let monotonicNow = 0;

	beforeEach(() => {
		previousFlag = Bun.env[FLAG];
		previousTmux = Bun.env.TMUX;
		delete Bun.env.TMUX;
		monotonicNow = 0;
		vi.spyOn(performance, "now").mockImplementation(() => {
			monotonicNow += 20;
			return monotonicNow;
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		if (previousFlag === undefined) delete Bun.env[FLAG];
		else Bun.env[FLAG] = previousFlag;
		if (previousTmux === undefined) delete Bun.env.TMUX;
		else Bun.env.TMUX = previousTmux;
		renderMetrics.disable();
		renderMetrics.reset();
	});

	it("replays recorded sessions with byte-identical viewport, scrollback, and writes", async () => {
		const fixture = makeRecordedSession(45, 0x600d, 64, 18);
		const off = await withViewportFlag("0", () => runReplay(fixture));
		const on = await withViewportFlag("1", () => runReplay(fixture));

		expect(on.finalViewport).toEqual(off.finalViewport);
		expect(on.scrollback).toEqual(off.scrollback);
		expect(on.writeLog).toEqual(off.writeLog);
	}, 60000);

	it("keeps byte-identical output across append, edits, overlays, resize, width change, and manual viewport", async () => {
		const off = await runInteractiveScenario("0");
		const on = await runInteractiveScenario("1");

		expect(on.viewport).toEqual(off.viewport);
		expect(on.scrollback).toEqual(off.scrollback);
		expect(on.writes).toEqual(off.writes);
	}, 60000);

	it("normalizes at most viewport plus overscan lines for a large bottom append", async () => {
		await withViewportFlag("1", async () => {
			renderMetrics.reset();
			renderMetrics.enable();
			const term = new VirtualTerminal(80, 40);
			const tui = new TUI(term);
			const content = new MutableLines(rows(100_000, "large-row"));
			tui.addChild(content);

			try {
				tui.start();
				await settle(term);
				expect(renderMetrics.snapshot().lineCounts.normalized?.max).toBeGreaterThanOrEqual(100_000);

				content.append("large-row-bottom-append");
				tui.requestRender(false, "parity.large-bottom-append");
				await settle(term);

				const lineCounts = renderMetrics.snapshot().lineCounts;
				expect(lineCounts.normalized?.last).toBeLessThanOrEqual(term.rows + OVERSCAN);
				expect(lineCounts.measured?.last).toBeLessThanOrEqual(term.rows + OVERSCAN);
				expect(lineCounts.diffed?.last).toBeLessThanOrEqual(term.rows + OVERSCAN);
				expect(lineCounts.offscreenScan?.last).toBe(100_001 - term.rows - OVERSCAN);
			} finally {
				tui.stop();
			}
		});
	}, 60000);
});
