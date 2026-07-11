import { afterEach, describe, expect, it, vi } from "bun:test";
import {
	__animationSchedulerTestHooks,
	Container,
	getCellDimensions,
	setCellDimensions,
	type TUI,
} from "@gajae-code/tui";
import type { CustomEditor } from "../src/modes/components/custom-editor";
import { GajaePetWidget, PetFramedEditor } from "../src/modes/components/gajae-pet-widget";

function makeStubs(columns = 80, rows = 30) {
	const written: string[] = [];
	let renderedWidth = 0;
	const editor = {
		setTopBorder(_border: unknown) {},
		getTopBorderAvailableWidth(terminalWidth: number) {
			return Math.max(0, terminalWidth - 4);
		},
		render(width: number) {
			renderedWidth = width;
			return [`+${"-".repeat(Math.max(0, width - 2))}+`, `| input${" ".repeat(Math.max(0, width - 9))}-+`];
		},
		invalidate() {},
	} as unknown as CustomEditor;
	let emitter: (() => string | null) | undefined;
	const ui = {
		requestRender: () => {},
		setPostRenderEmitter: (fn?: () => string | null) => {
			emitter = fn;
		},
		terminalAvailable: true,
		terminal: {
			columns,
			rows,
			write: (data: string) => {
				written.push(data);
			},
		},
	} as unknown as TUI;
	const editorContainer = new Container();
	const floorContainer = new Container();
	editorContainer.addChild(editor);
	return {
		editor,
		ui,
		editorContainer,
		floorContainer,
		written,
		getEmitter: () => emitter,
		getRenderedWidth: () => renderedWidth,
	};
}

function makeWidget(
	columns = 80,
	rows = 30,
	options: {
		bottomOffset?: number;
		isWorking?: () => boolean;
		autoFlexGapMs?: [number, number] | null;
		protocol?: "sixel" | "kitty";
	} = {},
) {
	const stubs = makeStubs(columns, rows);
	const widget = new GajaePetWidget({
		ui: stubs.ui,
		editor: stubs.editor,
		editorContainer: stubs.editorContainer,
		floorContainer: stubs.floorContainer,
		isWorking: options.isWorking ?? (() => false),
		getComposerBottomOffset: () => stubs.floorContainer.render(columns).length + (options.bottomOffset ?? 0),
		forcePixelProtocol: options.protocol ?? "sixel",
		autoFlexGapMs: options.autoFlexGapMs !== undefined ? options.autoFlexGapMs : null,
	});
	return { ...stubs, widget };
}

describe("GajaePetWidget", () => {
	afterEach(() => {
		__animationSchedulerTestHooks.reset();
		vi.useRealTimers();
	});

	it("on: reserves a side area and registers the overlay emitter", () => {
		const { widget, editorContainer, getEmitter, getRenderedWidth } = makeWidget();
		try {
			widget.setMode("red");
			editorContainer.render(80);
			// The 36px pet reserves its 4 sprite columns + a 1-column side margin, so
			// the editor renders 5 columns narrower than the terminal.
			expect(getRenderedWidth()).toBe(80 - 5);
			expect(getEmitter()).toBeDefined();
			const payload = getEmitter()?.();
			expect(payload).toContain("\x1bP0;1;0q");
			// Pet is inset one column from the right edge (x = 80 - 4 - 1 = 75 -> col 76).
			expect(payload).toContain(`;${80 - 4 - 1 + 1}H`);
		} finally {
			widget.dispose();
		}
	});

	it("hides the overlay instead of covering editor text on a narrow terminal", () => {
		const { widget, editorContainer, getEmitter, getRenderedWidth } = makeWidget(12, 30);
		try {
			widget.setMode("red");
			editorContainer.render(12);
			expect(getRenderedWidth()).toBe(12);
			expect(getEmitter()?.()).toBeNull();
		} finally {
			widget.dispose();
		}
	});

	it("lifts the pet so its feet align with the composer's visual bottom edge", () => {
		// 2 hook rows below the composer; no floor row is reserved.
		const { widget, getEmitter } = makeWidget(80, 30, { bottomOffset: 2 });
		try {
			widget.setMode("red");
			// composerBottom = 30 - 2 hooks = 28; the two-row pet lifted one safety
			// row sits at zero-based row 25 -> cursor row 26.
			expect(getEmitter()?.()).toContain("\x1b[26;");
		} finally {
			widget.dispose();
		}
	});

	it("drops the kitty pet by a sub-cell Y offset instead of a full-row jump", () => {
		// 2 hook rows below the composer; no pet floor row is reserved.
		const { widget, getEmitter } = makeWidget(80, 30, { bottomOffset: 2, protocol: "kitty" });
		try {
			widget.setMode("red");
			const payload = getEmitter()?.();
			// composerBottom = 30 - 2 hooks = 28; the two-row pet lifted one safety
			// row draws at zero-based row 25 -> cursor row 26...
			expect(payload).toContain("\x1b[26;");
			// ...then nudged back down within the cell by a native kitty Y offset
			// proportional to the cell height (round(18 * 0.45) = 8 at the 18px default
			// cell) so the sprite tracks the composer border at any font size.
			expect(payload).toContain("\x1b_Ga=T");
			expect(payload).toContain(",Y=8,");
		} finally {
			widget.dispose();
		}
	});

	it("rebuilds the kitty pet when the terminal cell size changes (font resize)", () => {
		vi.useFakeTimers();
		const original = getCellDimensions();
		const { widget, getEmitter } = makeWidget(80, 30, { protocol: "kitty", autoFlexGapMs: null });
		try {
			widget.setMode("red");
			// default 18px cell -> Y = floor(18 * 0.45) = 8
			expect(getEmitter()?.()).toContain(",Y=8,");
			// A font/zoom change resizes the cells; the next tick must rebuild.
			setCellDimensions({ widthPx: 9, heightPx: 30 });
			vi.advanceTimersByTime(100);
			// 30px cell -> Y = floor(30 * 0.45) = 13, tracking the new metrics.
			expect(getEmitter()?.()).toContain(",Y=13,");
			expect(getEmitter()?.()).not.toContain(",Y=8,");
		} finally {
			setCellDimensions(original);
			widget.dispose();
		}
	});

	it("writes frames directly to the terminal when the UI is quiet", () => {
		vi.useFakeTimers();
		const { widget, written } = makeWidget();
		try {
			widget.setMode("red");
			written.length = 0;
			// Idle loop leaves "base" at 1100ms; advance into the gazeL window.
			vi.advanceTimersByTime(1200);
			expect(written.length).toBeGreaterThan(0);
			expect(written.some(chunk => chunk.includes("\x1b[?2026h\x1b7") && chunk.includes("\x1bP0;1;0q"))).toBe(true);
			// Transparent sixel frames clear only the reserved pet cells inside
			// the same synchronized write, avoiding opaque image rectangles.
			expect(written.some(chunk => chunk.includes("\x1b[0m") && chunk.includes("\x1b[4X"))).toBe(true);
		} finally {
			widget.dispose();
		}
	});

	it("reserves no floor row so the composer stays pinned to the terminal bottom", () => {
		const { widget, getEmitter, floorContainer } = makeWidget(80, 30); // sixel
		try {
			widget.setMode("red");
			// No floor row is reserved, so enabling the pet does not push the composer
			// up. composerBottom stays at row 30 and the pet overlays its bottom rows.
			expect(floorContainer.render(80).length).toBe(0);
			expect(getEmitter()?.()).toContain("\x1b[28;");
		} finally {
			widget.dispose();
		}
	});

	it("reserves no floor row for kitty either", () => {
		const { widget, getEmitter, floorContainer } = makeWidget(80, 30, { protocol: "kitty" });
		try {
			widget.setMode("red");
			expect(floorContainer.render(80).length).toBe(0);
			expect(getEmitter()?.()).toContain("\x1b[28;");
		} finally {
			widget.dispose();
		}
	});

	it("auto-flexes randomly in both idle and working states", () => {
		vi.useFakeTimers();
		const idle = makeWidget(80, 30, { autoFlexGapMs: [500, 500] });
		const busy = makeWidget(80, 30, { autoFlexGapMs: [500, 500], isWorking: () => true });
		try {
			idle.widget.setMode("red");
			busy.widget.setMode("red");
			// First tick schedules; the flex fires ~500ms later.
			vi.advanceTimersByTime(700);
			expect(idle.widget.isFlexing).toBe(true);
			expect(busy.widget.isFlexing).toBe(true);
			// The multi-beat burst (~2.6s) ends before the next scheduled flex (~3.7s).
			vi.advanceTimersByTime(2800);
			expect(idle.widget.isFlexing).toBe(false);
			expect(busy.widget.isFlexing).toBe(false);
		} finally {
			idle.widget.dispose();
			busy.widget.dispose();
		}
	});

	it("runs a para-para-then-sob burst for BlueGajae", () => {
		vi.useFakeTimers();
		const { widget } = makeWidget(80, 30, { autoFlexGapMs: [500, 500] });
		try {
			widget.setMode("blue");
			// Burst fires ~500ms in; the para-para (~1.6s) plus sobbing tail (~1s) keeps
			// it flexing at the 2s mark, well into the burst.
			vi.advanceTimersByTime(2000);
			expect(widget.isFlexing).toBe(true);
			// The whole ~2.6s burst clears before the next scheduled burst.
			vi.advanceTimersByTime(1400);
			expect(widget.isFlexing).toBe(false);
		} finally {
			widget.dispose();
		}
	});

	it("demos the signature burst shortly after a skin is previewed", () => {
		vi.useFakeTimers();
		const { widget } = makeWidget(80, 30, { autoFlexGapMs: [12_000, 40_000] });
		try {
			widget.previewMode("red");
			// Live auto-flex is 12-40s out; a preview forces the demo burst right after
			// the idle eye-roll (~2.3s) so the selector shows the animation immediately.
			vi.advanceTimersByTime(2600);
			expect(widget.isFlexing).toBe(true);
		} finally {
			widget.dispose();
		}
	});

	it("cycles the para-para dance sequence while working", () => {
		vi.useFakeTimers();
		const { widget, written } = makeWidget(80, 30, { isWorking: () => true, autoFlexGapMs: null });
		try {
			widget.setMode("red");
			written.length = 0;
			// 1500ms spans 450ms steps L -> R -> both-up -> rest, so the working pet
			// must emit at least three distinct dance frames.
			vi.advanceTimersByTime(1500);
			const danceFrames = new Set(written.filter(chunk => chunk.includes("\x1b[?2026h")));
			expect(danceFrames.size).toBeGreaterThanOrEqual(3);
		} finally {
			widget.dispose();
		}
	});

	it("off: unregisters emitter, floor, width and timers", () => {
		const { widget, editorContainer, floorContainer, getEmitter, getRenderedWidth } = makeWidget();
		widget.setMode("red");
		widget.setMode("off");
		expect(getEmitter()).toBeUndefined();
		expect(floorContainer.render(80).length).toBe(0);
		editorContainer.render(80);
		expect(getRenderedWidth()).toBe(80);
		expect(__animationSchedulerTestHooks.getRegistrantCount(80)).toBe(0);
	});

	it("stays off when no pixel protocol is available", () => {
		const stubs = makeStubs();
		const widget = new GajaePetWidget({
			ui: stubs.ui,
			editor: stubs.editor,
			editorContainer: stubs.editorContainer,
			floorContainer: stubs.floorContainer,
			isWorking: () => false,
			getComposerBottomOffset: () => 0,
		});
		widget.setMode("red");
		expect(widget.mode).toBe("off");
		expect(stubs.getEmitter()).toBeUndefined();
		widget.dispose();
	});
});

describe("PetFramedEditor", () => {
	it("passes through untouched when no reserve is set", () => {
		const { editor } = makeStubs(80);
		const framed = new PetFramedEditor(editor);
		expect(framed.render(80)).toEqual(editor.render(80));
	});
});
