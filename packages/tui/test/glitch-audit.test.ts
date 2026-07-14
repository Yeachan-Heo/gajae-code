import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { type Component, TUI } from "@gajae-code/tui";
import { Text } from "@gajae-code/tui/components/text";
import { renderMetrics } from "@gajae-code/tui/metrics";
import { ImageProtocol, TERMINAL } from "@gajae-code/tui/terminal-capabilities";
import { VirtualTerminal } from "./virtual-terminal";

/**
 * Glitch repro audit for the user-reported renderer glitch classes:
 *   1. flicker / unnecessary full repaint
 *   2. cursor / image-cell artifacts
 *   3. lag / freeze under high CPU
 *   4. resize / offscreen scrollback corruption
 *
 * Findings (see the per-test comments): classes 1, 2, and 4 are already
 * substantially guarded — flicker by zero-repaint-storm + differential-render
 * coverage, cursor placement by the BSU/ESU synchronized-block tests, and
 * resize/offscreen scrollback by the extensive `render-regressions.test.ts`
 * resize-storm / multiplexer suite. This file adds the mechanical guards that
 * were genuinely missing:
 *   - a reusable no-alternate-buffer invariant (the inline-scrollback hard line),
 *   - a cause-level flicker assertion for append-only streaming,
 *   - image-payload atomicity through both the full and differential render paths.
 *
 * `assertNoAltBuffer` / `ALT_BUFFER_SEQUENCES` are exported for reuse by later
 * optimization phases.
 */

/**
 * Alternate-screen / alternate-buffer enter+exit sequences. The renderer MUST
 * NEVER emit any of these: it renders inline so the terminal scrollback
 * transcript stays correct. This is the project's hard invariant. Both the
 * modern xterm modes (1049/1047/1048) and the legacy DEC private mode (47) are
 * covered so a regression to either form is caught.
 */
export const ALT_BUFFER_SEQUENCES = [
	"\x1b[?1049h",
	"\x1b[?1049l",
	"\x1b[?1047h",
	"\x1b[?1047l",
	"\x1b[?1048h",
	"\x1b[?1048l",
	"\x1b[?47h",
	"\x1b[?47l",
];

/** Assert that a joined terminal write log contains no alternate-buffer sequence. */
export function assertNoAltBuffer(writes: string): void {
	for (const seq of ALT_BUFFER_SEQUENCES) {
		const human = JSON.stringify(seq);
		expect(writes.includes(seq), `unexpected alternate-buffer sequence ${human} emitted`).toBe(false);
	}
}

class MutableLinesComponent implements Component {
	#lines: string[];

	constructor(lines: string[]) {
		this.#lines = [...lines];
	}

	setLines(lines: string[]): void {
		this.#lines = [...lines];
	}

	invalidate(): void {}

	render(width: number): string[] {
		return this.#lines.map(line => line.slice(0, width));
	}
}

/** Like MutableLinesComponent but never slices, so image payloads stay intact. */
class RawLinesComponent implements Component {
	#lines: string[];

	constructor(lines: string[]) {
		this.#lines = [...lines];
	}

	setLines(lines: string[]): void {
		this.#lines = [...lines];
	}

	invalidate(): void {}

	render(): string[] {
		return [...this.#lines];
	}
}

async function settle(term: VirtualTerminal): Promise<void> {
	await new Promise<void>(resolve => process.nextTick(resolve));
	await Bun.sleep(1);
	await term.flush();
}

describe("TUI glitch audit (reported glitch classes)", () => {
	let previousTmux: string | undefined;
	let previousLegacy: string | undefined;
	let monotonicNow = 0;

	beforeEach(() => {
		previousTmux = Bun.env.TMUX;
		previousLegacy = Bun.env.PI_TUI_LEGACY_MULTIPLEXER_FULL_RENDER;
		delete Bun.env.TMUX;
		delete Bun.env.PI_TUI_LEGACY_MULTIPLEXER_FULL_RENDER;
		// Defeat the 16ms render throttle deterministically (advance > the throttle
		// per call) so each requestRender actually executes the intended frame.
		monotonicNow = 0;
		vi.spyOn(performance, "now").mockImplementation(() => {
			monotonicNow += 20;
			return monotonicNow;
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		if (renderMetrics.enabled) renderMetrics.disable();
		if (previousTmux === undefined) delete Bun.env.TMUX;
		else Bun.env.TMUX = previousTmux;
		if (previousLegacy === undefined) delete Bun.env.PI_TUI_LEGACY_MULTIPLEXER_FULL_RENDER;
		else Bun.env.PI_TUI_LEGACY_MULTIPLEXER_FULL_RENDER = previousLegacy;
	});

	it("flicker: append-only streaming stays differential (0 storms, only the first frame is a full redraw)", async () => {
		renderMetrics.reset();
		renderMetrics.enable();

		const term = new VirtualTerminal(60, 12);
		const tui = new TUI(term);
		tui.start();

		const stream = new Text("", 1, 0);
		tui.addChild(stream);

		// Stream growing assistant output across many coalesced renders, no resize.
		let acc = "";
		for (let i = 0; i < 40; i++) {
			acc += `token-${i} chunk of streamed assistant output `;
			stream.setText(acc);
			tui.requestRender(false, "audit.stream");
			await settle(term);
		}

		const m = renderMetrics.snapshot();
		tui.stop();
		renderMetrics.disable();

		// Prove many frames actually executed (not coalesced away by the throttle),
		// then prove streaming did not storm or full-repaint beyond the first frame.
		expect(m.renderCount).toBeGreaterThanOrEqual(10);
		expect(m.repaintStorms).toBe(0);
		expect(m.fullRedrawCount).toBeLessThanOrEqual(1);
		assertNoAltBuffer(term.getWriteLog().join(""));
	});

	it("no alternate-buffer sequences across full / differential / deleted-lines paths", async () => {
		const term = new VirtualTerminal(40, 8);
		const tui = new TUI(term);
		// clearOnShrink disabled so the shrink hits the real deleted-lines diff
		// branch (firstChanged >= newLines.length) rather than a full clear.
		tui.setClearOnShrink(false);
		tui.start();

		const component = new MutableLinesComponent(["alpha", "beta", "gamma", "delta"]);
		tui.addChild(component);

		// Full render (first frame).
		tui.requestRender(false, "audit.full");
		await settle(term);

		// Differential render (change one middle line).
		component.setLines(["alpha", "BETA", "gamma", "delta"]);
		tui.requestRender(false, "audit.diff");
		await settle(term);

		// Deleted-lines render (shrink with clearOnShrink off => deleted-lines branch).
		component.setLines(["alpha", "BETA"]);
		tui.requestRender(false, "audit.shrink");
		await settle(term);

		tui.stop();
		assertNoAltBuffer(term.getWriteLog().join(""));
	});

	it("no alternate-buffer sequences across the width/height resize full-repair path", async () => {
		const term = new VirtualTerminal(40, 8);
		const tui = new TUI(term);
		tui.start();
		const component = new MutableLinesComponent(["alpha", "beta", "gamma", "delta"]);
		tui.addChild(component);
		tui.requestRender(false, "audit.full");
		await settle(term);

		term.resize(24, 5);
		await settle(term);
		component.setLines(["alpha", "beta", "gamma"]);
		tui.requestRender(false, "audit.resize");
		await settle(term);

		tui.stop();
		assertNoAltBuffer(term.getWriteLog().join(""));
	});

	it("no alternate-buffer sequences in a multiplexer full-clear path (uses 2J, never alt-buffer)", async () => {
		Bun.env.TMUX = "1";
		Bun.env.PI_TUI_LEGACY_MULTIPLEXER_FULL_RENDER = "1";
		const term = new VirtualTerminal(40, 6, { isProcessTerminal: true });
		const tui = new TUI(term);
		tui.start();
		const component = new MutableLinesComponent(["m-0", "m-1", "m-2"]);
		tui.addChild(component);
		tui.requestRender(false, "audit.mux.full");
		await settle(term);
		term.resize(48, 8);
		await settle(term);
		tui.stop();

		const writes = term.getWriteLog().join("");
		// The legacy multiplexer full render uses 2J (never 3J, never alt-buffer).
		expect(writes.includes("\x1b[2J")).toBe(true);
		expect(writes.includes("\x1b[3J")).toBe(false);
		assertNoAltBuffer(writes);
	});

	it("image artifacts: an over-width image line survives both the full and differential render path", async () => {
		const term = new VirtualTerminal(20, 6);
		const tui = new TUI(term);
		const mutable = TERMINAL as unknown as { imageProtocol: ImageProtocol | null };
		const originalProtocol = mutable.imageProtocol;
		mutable.imageProtocol = ImageProtocol.Kitty;
		try {
			// Kitty image payloads far wider than the 20-column terminal. The renderer
			// must never truncate, split, reset-append, or clear through an image line,
			// on either the first (full) frame or a later differential update.
			const imageA = `${ImageProtocol.Kitty}a=T,f=100;${"Q".repeat(200)}\x1b\\`;
			const imageB = `${ImageProtocol.Kitty}a=T,f=100;${"Z".repeat(220)}\x1b\\`;
			tui.start();
			const component = new RawLinesComponent(["header", imageA, "footer"]);
			tui.addChild(component);

			// Full render: image A must appear intact.
			tui.requestRender(false, "audit.image.full");
			await settle(term);
			expect(term.getWriteLog().join("").includes(imageA)).toBe(true);

			// Differential render: change only the image line; image B must appear
			// intact in the differential write (the diff path bypasses truncation
			// for image lines).
			term.clearWriteLog();
			component.setLines(["header", imageB, "footer"]);
			tui.requestRender(false, "audit.image.diff");
			await settle(term);
			const diffWrites = term.getWriteLog().join("");
			tui.stop();

			expect(diffWrites.includes(imageB)).toBe(true);
			assertNoAltBuffer(diffWrites);
		} finally {
			mutable.imageProtocol = originalProtocol;
		}
	});

	it("resize/offscreen scrollback: a resize storm keeps visible rows unique and emits no alt-buffer", async () => {
		const term = new VirtualTerminal(50, 10);
		const tui = new TUI(term);
		tui.start();
		const component = new MutableLinesComponent(Array.from({ length: 40 }, (_v, i) => `row-${i}`));
		tui.addChild(component);
		tui.requestRender(false, "audit.storm.init");
		await settle(term);

		const sizes: Array<[number, number]> = [
			[60, 14],
			[40, 8],
			[72, 18],
			[50, 10],
		];
		for (const [cols, rowsN] of sizes) {
			term.resize(cols, rowsN);
			await settle(term);
			tui.requestRender(false, "audit.storm.resize");
			await settle(term);
		}

		const viewport = term
			.getViewport()
			.map(line => line.trimEnd())
			.filter(line => line.length > 0);
		tui.stop();

		// No visible row id should appear twice (no duplicated scrollback rows).
		const seen = new Set<string>();
		for (const line of viewport) {
			expect(seen.has(line), `duplicate visible row after resize storm: ${line}`).toBe(false);
			seen.add(line);
		}
		assertNoAltBuffer(term.getWriteLog().join(""));
	});
});
