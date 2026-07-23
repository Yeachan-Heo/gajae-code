import { afterEach, describe, expect, it, vi } from "bun:test";
import {
	__animationSchedulerTestHooks,
	Container,
	getCellDimensions,
	setCellDimensions,
	type TUI,
	wrapITerm2RecordForTmux,
} from "@gajae-code/tui";
import type { CustomEditor } from "../src/modes/components/custom-editor";
import { GajaePetWidget, PetFramedEditor } from "../src/modes/components/gajae-pet-widget";
import { setVerifiedItermPetAvailability } from "../src/modes/components/pet-capability";

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
	let available = true;
	let failWrites = false;
	let rasterToken = 0;
	const rasterOutputs: Uint8Array[] = [];
	const rasterCursorVisibilityRestores: Array<boolean | undefined> = [];
	const invalidatedRasterLeases: Array<{ token: unknown; cause?: string }> = [];
	let delayRasterAcquire = false;
	const rasterAcquireWaiters: Array<() => void> = [];
	const pendingTerminalCleanup: Array<{ payload: string; onDelivered?: () => void }> = [];
	const flushTerminalCleanup = () => {
		while (available && pendingTerminalCleanup.length > 0) {
			const pending = pendingTerminalCleanup[0];
			try {
				terminal.write(pending.payload);
			} catch {
				return;
			}
			pendingTerminalCleanup.shift();
			pending.onDelivered?.();
		}
	};
	const terminal = {
		columns,
		rows,
		write: (data: string) => {
			if (failWrites) throw new Error("injected terminal write failure");
			written.push(data);
		},
	};
	const ui = {
		requestRender: () => {},
		setPostRenderEmitter: (fn?: () => string | null) => {
			emitter = fn;
		},
		queueTerminalCleanup: (payload: string, onDelivered?: () => void) => {
			pendingTerminalCleanup.push({ payload, onDelivered });
			flushTerminalCleanup();
		},
		get terminalAvailable() {
			return available;
		},
		terminal,
		acquireRasterLease: async (request: {
			ownerId: string;
			rect: { column: number; row: number; width: number; height: number };
		}) => {
			const result = {
				status: "acquired",
				token: { ownerId: request.ownerId, generation: ++rasterToken, rect: request.rect },
			};
			if (!delayRasterAcquire) return result;
			return await new Promise(resolve => rasterAcquireWaiters.push(() => resolve(result)));
		},
		invalidateRasterLease: async (request: { token: unknown; cause?: string }) => {
			invalidatedRasterLeases.push(request);
			return { status: "invalidated" };
		},
		queueTerminalOutput: async (payload: string) => {
			if (failWrites || !available) return { status: "failed" as const };
			written.push(payload);
			return { status: "written" as const };
		},
		submitTerminalOutput: async (request: {
			operation: {
				prefix?: Uint8Array;
				replayPrefix?: Uint8Array;
				records: Uint8Array[];
				suffix?: Uint8Array;
				restoreCursorVisibility?: boolean;
			};
		}) => {
			rasterCursorVisibilityRestores.push(request.operation.restoreCursorVisibility);
			if (request.operation.prefix) rasterOutputs.push(request.operation.prefix);
			if (request.operation.replayPrefix) rasterOutputs.push(request.operation.replayPrefix);
			rasterOutputs.push(...request.operation.records);
			if (request.operation.suffix) rasterOutputs.push(request.operation.suffix);
			return { status: "written" };
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
		setTerminalSize: (nextColumns: number, nextRows: number) => {
			terminal.columns = nextColumns;
			terminal.rows = nextRows;
		},
		setTerminalAvailable: (value: boolean) => {
			available = value;
		},
		setWriteFailure: (value: boolean) => {
			failWrites = value;
		},
		flushTerminalCleanup,
		getPendingTerminalCleanupCount: () => pendingTerminalCleanup.length,
		getRasterOutputs: () => rasterOutputs,
		getInvalidatedRasterLeases: () => invalidatedRasterLeases,
		getRasterCursorVisibilityRestores: () => rasterCursorVisibilityRestores,
		getPendingRasterAcquireCount: () => rasterAcquireWaiters.length,
		setRasterAcquireDelayed: (value: boolean) => {
			delayRasterAcquire = value;
			if (!value) while (rasterAcquireWaiters.length) rasterAcquireWaiters.shift()?.();
		},
	};
}

async function flushAsyncChain() {
	for (let i = 0; i < 4; i++) await Promise.resolve();
}

function makeWidget(
	columns = 80,
	rows = 30,
	options: {
		bottomOffset?: number;
		isWorking?: () => boolean;
		autoFlexGapMs?: [number, number] | null;
		protocol?: "sixel" | "kitty" | null;
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
		syncManagedItermCursor: async () => true,
		forcePixelProtocol: options.protocol === null ? undefined : (options.protocol ?? "sixel"),
		autoFlexGapMs: options.autoFlexGapMs !== undefined ? options.autoFlexGapMs : null,
	});
	return { ...stubs, widget };
}

describe("GajaePetWidget", () => {
	afterEach(() => {
		__animationSchedulerTestHooks.reset();
		vi.useRealTimers();
		vi.restoreAllMocks();
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

	it("owns and deletes a distinct Kitty image ID per widget", () => {
		const first = makeWidget(80, 30, { protocol: "kitty" });
		const second = makeWidget(80, 30, { protocol: "kitty" });
		try {
			first.widget.setMode("red");
			second.widget.setMode("red");
			const firstPayload = first.getEmitter()?.();
			const secondPayload = second.getEmitter()?.();
			const firstId = firstPayload?.match(/i=(\d+)/)?.[1];
			const secondId = secondPayload?.match(/i=(\d+)/)?.[1];

			expect(firstId).toBeDefined();
			expect(secondId).toBeDefined();
			expect(firstId).not.toBe(secondId);
			expect(Number(firstId)).toBeGreaterThan(0);
			expect(Number(secondId)).toBeGreaterThan(0);

			first.written.length = 0;
			first.widget.setMode("off");
			expect(first.written.some(chunk => chunk.includes(`a=d,d=I,i=${firstId}`))).toBe(true);
			expect(first.written.some(chunk => chunk.includes(`i=${secondId}`))).toBe(false);
		} finally {
			first.widget.dispose();
			second.widget.dispose();
		}
	});

	it("clears the last Sixel footprint when disabled", () => {
		const { widget, written, getEmitter } = makeWidget();
		try {
			widget.setMode("red");
			expect(getEmitter()?.()).toContain("\x1bP0;1;0q");
			written.length = 0;

			widget.setMode("off");

			expect(written.some(chunk => chunk.includes("\x1b[28;76H\x1b[4X"))).toBe(true);
		} finally {
			widget.dispose();
		}
	});

	it("clears the previous Sixel footprint after the terminal becomes too narrow", () => {
		const { widget, getEmitter, setTerminalSize } = makeWidget();
		try {
			widget.setMode("red");
			expect(getEmitter()?.()).toContain("\x1b[28;76H");
			setTerminalSize(12, 30);

			const cleanup = getEmitter()?.();

			expect(cleanup).toContain("\x1b[28;76H\x1b[4X");
			expect(cleanup).not.toContain("\x1bP0;1;0q");
			expect(getEmitter()?.()).toBeNull();
		} finally {
			widget.dispose();
		}
	});

	it("retains cleanup authority when the queued TUI output fails, and dispose retries", () => {
		const { widget, written, getEmitter, setTerminalSize, setTerminalAvailable } = makeWidget();
		widget.setMode("red");
		expect(getEmitter()?.()).toContain("\x1bP0;1;0q");
		setTerminalSize(12, 30);

		// The emitter hands the cleanup payload to the TUI, but queued delivery
		// fails (availability drops), so delivery is never acknowledged and the authority must survive.
		expect(getEmitter()?.()).toContain("\x1b[28;76H\x1b[4X");
		setTerminalAvailable(false);
		expect(getEmitter()?.()).toBeNull();

		written.length = 0;
		setTerminalAvailable(true);
		widget.dispose();

		expect(written.some(chunk => chunk.includes("\x1b[28;76H\x1b[4X"))).toBe(true);
	});

	it("re-emits the retained cleanup through the emitter once the terminal recovers", () => {
		const { widget, getEmitter, setTerminalSize, setTerminalAvailable } = makeWidget();
		try {
			widget.setMode("red");
			expect(getEmitter()?.()).toContain("\x1bP0;1;0q");
			setTerminalSize(12, 30);
			expect(getEmitter()?.()).toContain("\x1b[28;76H\x1b[4X");

			// Frame write fails; authority is retained.
			setTerminalAvailable(false);
			expect(getEmitter()?.()).toBeNull();

			// Recovered terminal: the emitter carries the erase again, and the
			// following pass acknowledges the successful delivery.
			setTerminalAvailable(true);
			expect(getEmitter()?.()).toContain("\x1b[28;76H\x1b[4X");
			expect(getEmitter()?.()).toBeNull();
		} finally {
			widget.dispose();
		}
	});

	it("retries Sixel cleanup that fails during final disposal", () => {
		const { flushTerminalCleanup, getEmitter, getPendingTerminalCleanupCount, setWriteFailure, widget, written } =
			makeWidget();
		widget.setMode("red");
		expect(getEmitter()?.()).toContain("\x1bP0;1;0q");
		written.length = 0;

		setWriteFailure(true);
		widget.dispose();
		expect(getPendingTerminalCleanupCount()).toBe(1);
		expect(written).toHaveLength(0);

		setWriteFailure(false);
		flushTerminalCleanup();
		expect(getPendingTerminalCleanupCount()).toBe(0);
		expect(written.some(chunk => chunk.includes("\x1b[28;76H\x1b[4X"))).toBe(true);
	});

	it("reserves a Kitty image ID until failed final-disposal cleanup is delivered", () => {
		const imageIds = [101, 101, 202, 101];
		vi.spyOn(crypto, "getRandomValues").mockImplementation(values => {
			if (!values) throw new Error("Expected a typed array");
			const ids = new Uint32Array(
				values.buffer,
				values.byteOffset,
				values.byteLength / Uint32Array.BYTES_PER_ELEMENT,
			);
			ids[0] = imageIds.shift() ?? 303;
			return values;
		});

		const stubs = makeStubs();
		const makeKitty = () =>
			new GajaePetWidget({
				ui: stubs.ui,
				editor: stubs.editor,
				editorContainer: stubs.editorContainer,
				floorContainer: stubs.floorContainer,
				isWorking: () => false,
				getComposerBottomOffset: () => 0,
				syncManagedItermCursor: async () => true,
				forcePixelProtocol: "kitty",
				autoFlexGapMs: null,
			});

		const first = makeKitty();
		first.setMode("red");
		expect(stubs.getEmitter()?.()).toContain("i=101");
		stubs.setWriteFailure(true);
		first.dispose();
		expect(stubs.getPendingTerminalCleanupCount()).toBe(1);

		const second = makeKitty();
		second.setMode("red");
		expect(stubs.getEmitter()?.()).toContain("i=202");

		stubs.setWriteFailure(false);
		stubs.flushTerminalCleanup();
		expect(stubs.getPendingTerminalCleanupCount()).toBe(0);
		expect(stubs.written.some(chunk => chunk.includes("a=d,d=I,i=101"))).toBe(true);

		const third = makeKitty();
		third.setMode("red");
		expect(stubs.getEmitter()?.()).toContain("i=101");
		second.dispose();
		third.dispose();
	});

	it("completes logical teardown when the queued cleanup output fails", () => {
		const { widget, editorContainer, getEmitter, getRenderedWidth, setWriteFailure } = makeWidget();
		widget.setMode("red");
		expect(getEmitter()?.()).toContain("\x1bP0;1;0q");

		setWriteFailure(true);
		widget.dispose();

		// The failed queued output must not abort teardown: the shared emitter slot is
		// released, the composer is unframed, and the widget is terminal.
		expect(getEmitter()).toBeUndefined();
		expect(widget.mode).toBe("off");
		editorContainer.render(80);
		expect(getRenderedWidth()).toBe(80);
		widget.setMode("red");
		expect(getEmitter()).toBeUndefined();
	});

	it("keeps a disposed widget from clearing its successor's overlay emitter", () => {
		const stubs = makeStubs();
		const make = () =>
			new GajaePetWidget({
				ui: stubs.ui,
				editor: stubs.editor,
				editorContainer: stubs.editorContainer,
				floorContainer: stubs.floorContainer,
				isWorking: () => false,
				getComposerBottomOffset: () => stubs.floorContainer.render(80).length,
				syncManagedItermCursor: async () => true,
				forcePixelProtocol: "sixel",
				autoFlexGapMs: null,
			});
		const first = make();
		first.setMode("red");
		first.dispose();

		const second = make();
		try {
			second.setMode("red");
			const successorEmitter = stubs.getEmitter();
			expect(successorEmitter).toBeDefined();

			first.dispose();

			expect(stubs.getEmitter()).toBe(successorEmitter);
		} finally {
			second.dispose();
		}
	});

	it("keeps a stale first-time dispose from stealing a successor's emitter or composer mount", () => {
		const stubs = makeStubs();
		const make = () =>
			new GajaePetWidget({
				ui: stubs.ui,
				editor: stubs.editor,
				editorContainer: stubs.editorContainer,
				floorContainer: stubs.floorContainer,
				isWorking: () => false,
				getComposerBottomOffset: () => stubs.floorContainer.render(80).length,
				syncManagedItermCursor: async () => true,
				forcePixelProtocol: "sixel",
				autoFlexGapMs: null,
			});
		// The predecessor is never disposed before the successor takes over.
		const first = make();
		first.setMode("red");
		const second = make();
		try {
			second.setMode("red");
			const successorEmitter = stubs.getEmitter();
			expect(successorEmitter).toBeDefined();

			first.dispose();

			expect(stubs.getEmitter()).toBe(successorEmitter);
			// The successor's framed composer stays mounted (editor still narrowed).
			stubs.editorContainer.render(80);
			expect(stubs.getRenderedWidth()).toBe(80 - 5);
		} finally {
			second.dispose();
		}
	});

	it("re-arms Kitty cleanup when the pet is re-placed after a narrow-terminal pass consumed it", () => {
		const { widget, written, getEmitter, setTerminalSize } = makeWidget(12, 30, { protocol: "kitty" });
		try {
			widget.setMode("red");
			// Too narrow: the emitter returns the delete escape and consumes the
			// pending cleanup.
			expect(getEmitter()?.()).toContain("\x1b_Ga=d");
			expect(getEmitter()?.()).toBeNull();

			// Wide again: the next frame re-places the image.
			setTerminalSize(80, 30);
			expect(getEmitter()?.()).toContain("\x1b_G");
			written.length = 0;

			widget.dispose();

			expect(written.some(chunk => chunk.includes("\x1b_Ga=d,d=I,i="))).toBe(true);
		} finally {
			widget.dispose();
		}
	});

	it("retains Sixel cleanup authority while the terminal is unavailable and erases once it returns", () => {
		const { widget, written, getEmitter, setTerminalAvailable } = makeWidget();
		widget.setMode("red");
		expect(getEmitter()?.()).toContain("\x1bP0;1;0q");
		written.length = 0;

		setTerminalAvailable(false);
		widget.setMode("off");
		expect(written).toHaveLength(0);

		setTerminalAvailable(true);
		widget.dispose();

		expect(written.some(chunk => chunk.includes("\x1b[28;76H\x1b[4X"))).toBe(true);
	});

	it("retains Sixel cleanup authority when queued erase output fails and retries on dispose", () => {
		const { widget, written, getEmitter, setWriteFailure } = makeWidget();
		widget.setMode("red");
		expect(getEmitter()?.()).toContain("\x1bP0;1;0q");
		written.length = 0;

		setWriteFailure(true);
		widget.setMode("off");
		expect(written).toHaveLength(0);

		setWriteFailure(false);
		widget.dispose();

		expect(written.some(chunk => chunk.includes("\x1b[28;76H\x1b[4X"))).toBe(true);
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

	it("queues frames through the TUI when the UI is quiet", async () => {
		vi.useFakeTimers();
		const { widget, written } = makeWidget();
		try {
			widget.setMode("red");
			written.length = 0;
			// Idle loop leaves "base" at 1100ms; advance into the gazeL window.
			vi.advanceTimersByTime(1200);
			await flushAsyncChain();
			expect(written.length).toBeGreaterThan(0);
			expect(written.some(chunk => chunk.includes("\x1b[?2026h\x1b7") && chunk.includes("\x1bP0;1;0q"))).toBe(true);
			// Transparent sixel frames clear only the reserved pet cells inside
			// the same synchronized write, avoiding opaque image rectangles.
			expect(written.some(chunk => chunk.includes("\x1b[0m") && chunk.includes("\x1b[4X"))).toBe(true);
		} finally {
			widget.dispose();
			await flushAsyncChain();
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
		vi.spyOn(GajaePetWidget, "pixelProtocol").mockReturnValue(null);
		const stubs = makeStubs();
		const widget = new GajaePetWidget({
			ui: stubs.ui,
			editor: stubs.editor,
			editorContainer: stubs.editorContainer,
			floorContainer: stubs.floorContainer,
			isWorking: () => false,
			getComposerBottomOffset: () => 0,
			syncManagedItermCursor: async () => true,
		});
		widget.setMode("red");
		expect(widget.mode).toBe("off");
		expect(stubs.getEmitter()).toBeUndefined();
		widget.dispose();
	});
	it("anchors the iTerm pet bottom row to the composer's bottom edge", async () => {
		vi.useFakeTimers();
		const stubs = makeWidget(80, 30, { bottomOffset: 2, protocol: null });
		try {
			setVerifiedItermPetAvailability({ available: true, mode: "direct", epoch: 1 });
			stubs.widget.setMode("red");
			vi.advanceTimersByTime(80);
			await flushAsyncChain();

			// composerBottom = 28; a two-row image starts at zero-based row 26,
			// so its second row shares the composer's zero-based bottom row 27.
			const records = stubs.getRasterOutputs().map(record => new TextDecoder().decode(record));
			expect(records[0]).toBe("\x1b[?2026h\x1b7\x1b[?25l\x1b[27;76H");
		} finally {
			setVerifiedItermPetAvailability(undefined);
			stubs.widget.dispose();
		}
	});

	it("keeps cursor and multipart ordering for direct and managed iTerm records", async () => {
		vi.useFakeTimers();
		const stubs = makeWidget(80, 30, { protocol: null });
		try {
			setVerifiedItermPetAvailability({ available: true, mode: "direct", epoch: 1 });
			stubs.widget.setMode("red");
			vi.advanceTimersByTime(80);
			await flushAsyncChain();
			const directRecords = stubs.getRasterOutputs().map(record => new TextDecoder().decode(record));
			expect(directRecords[0]).toBe("\x1b[?2026h\x1b7\x1b[?25l\x1b[28;76H");
			expect(directRecords[1]).toContain("\x1b]1337;MultipartFile=");
			expect(directRecords[1]).toContain("width=4;height=2;");
			expect(directRecords[1]).toContain("size=");
			expect(directRecords[1]).toContain("inline=1;preserveAspectRatio=0:");
			expect(directRecords.slice(1).filter(record => record.includes("\x1b[28;76H")).length).toBe(0);
			expect(directRecords.slice(1).every(record => !record.includes("\x1b[28;76H"))).toBe(true);
			expect(directRecords.at(-2)).toBe("\x1b]1337;FileEnd\x07");
			expect(directRecords.at(-1)).toBe("\x1b8\x1b[?2026l");

			stubs.widget.setMode("off");
			await flushAsyncChain();
			setVerifiedItermPetAvailability({ available: true, mode: "managed", epoch: 1 });
			stubs.widget.setMode("red");
			vi.advanceTimersByTime(80);
			await flushAsyncChain();
			const managedRecords = stubs
				.getRasterOutputs()
				.slice(directRecords.length)
				.map(record => new TextDecoder().decode(record));
			expect(managedRecords[0]).toBe(`${wrapITerm2RecordForTmux("\x1b[?2026h\x1b7\x1b[?25l")}\x1b7\x1b[28;76H`);
			expect(managedRecords[1]).toBe("\x1b[28;76H");
			expect(managedRecords[2]).toContain("\x1bPtmux;\x1b\x1b]1337;MultipartFile=");
			expect(managedRecords[2]).toContain("width=4;height=2;");
			expect(managedRecords[2]).not.toContain("\x1b[28;76H");
			expect(managedRecords.at(-2)).toBe("\x1bPtmux;\x1b\x1b]1337;FileEnd\x07\x1b\\");
			expect(managedRecords.at(-1)).toBe(`${wrapITerm2RecordForTmux("\x1b8\x1b[?2026l")}\x1b8`);
			expect(managedRecords.slice(3, -2).every(record => record.startsWith("\x1bPtmux;"))).toBe(true);
			expect(managedRecords.slice(3, -2).every(record => !record.includes("\x1b[28;76H"))).toBe(true);
		} finally {
			setVerifiedItermPetAvailability(undefined);
			stubs.widget.dispose();
		}
	});
	it("updates iTerm cell geometry atomically when font metrics change", async () => {
		vi.useFakeTimers();
		const original = getCellDimensions();
		const stubs = makeWidget(80, 30, { protocol: null });
		try {
			setVerifiedItermPetAvailability({ available: true, mode: "direct", epoch: 1 });
			stubs.widget.setMode("red");
			vi.advanceTimersByTime(80);
			await flushAsyncChain();
			stubs.editorContainer.render(80);
			const previousRecordCount = stubs.getRasterOutputs().length;
			expect(stubs.getRenderedWidth()).toBe(75);

			setCellDimensions({ widthPx: 18, heightPx: 18 });
			vi.advanceTimersByTime(80);
			await flushAsyncChain();
			stubs.editorContainer.render(80);
			const resizedRecords = stubs
				.getRasterOutputs()
				.slice(previousRecordCount)
				.map(record => new TextDecoder().decode(record));
			expect(stubs.getRenderedWidth()).toBe(77);
			expect(resizedRecords[0]).toBe("\x1b[?2026h\x1b7\x1b[?25l\x1b[28;78H");
			expect(resizedRecords[1]).toContain("width=2;height=2;");
		} finally {
			setCellDimensions(original);
			setVerifiedItermPetAvailability(undefined);
			stubs.widget.dispose();
		}
	});

	it("guards direct and managed iTerm raster submission when the framed editor cannot fit", async () => {
		vi.useFakeTimers();
		for (const mode of ["direct", "managed"] as const) {
			const stubs = makeWidget(12, 30, { protocol: null });
			try {
				setVerifiedItermPetAvailability({ available: true, mode, epoch: 1 });
				stubs.widget.setMode("red");
				stubs.editorContainer.render(12);
				vi.advanceTimersByTime(80);
				await flushAsyncChain();
				expect(stubs.getRasterOutputs()).toHaveLength(0);
				expect(stubs.getRenderedWidth()).toBe(12);

				stubs.setTerminalSize(80, 30);
				stubs.editorContainer.render(80);
				expect(stubs.getRenderedWidth()).toBe(75);
				vi.advanceTimersByTime(80);
				await flushAsyncChain();
				const normalRecords = stubs.getRasterOutputs().map(record => new TextDecoder().decode(record));
				expect(normalRecords[0]).toBe(
					mode === "managed"
						? `${wrapITerm2RecordForTmux("\x1b[?2026h\x1b7\x1b[?25l")}\x1b7\x1b[28;76H`
						: "\x1b[?2026h\x1b7\x1b[?25l\x1b[28;76H",
				);
				expect(normalRecords.some(record => record.includes("MultipartFile="))).toBe(true);
				expect(normalRecords.at(-2)).toContain("FileEnd");
				expect(normalRecords.at(-1)).toContain("\x1b[?2026l");

				stubs.setTerminalSize(12, 30);
				stubs.editorContainer.render(12);
				expect(stubs.getRenderedWidth()).toBe(12);
				vi.advanceTimersByTime(80);
				await flushAsyncChain();
				const beforeNarrowing = stubs.getRasterOutputs().length;
				const cleanup = stubs.getEmitter()?.();
				expect(cleanup ?? "").not.toContain("MultipartFile=");
				await flushAsyncChain();
				expect(stubs.getRasterOutputs()).toHaveLength(beforeNarrowing);
				expect(stubs.getInvalidatedRasterLeases().at(-1)?.cause).toBe("resize");
			} finally {
				setVerifiedItermPetAvailability(undefined);
				stubs.widget.dispose();
			}
		}
	});
	it("drops stale async completion after mode-off", async () => {
		vi.useFakeTimers();
		const stubs = makeWidget(80, 30, { protocol: null });
		try {
			setVerifiedItermPetAvailability({ available: true, mode: "direct", epoch: 1 });
			stubs.setRasterAcquireDelayed(true);
			stubs.widget.setMode("red");
			vi.advanceTimersByTime(80);
			await flushAsyncChain();
			stubs.widget.setMode("off");
			stubs.setRasterAcquireDelayed(false);
			await flushAsyncChain();
			expect(stubs.getRasterOutputs()).toHaveLength(0);
		} finally {
			setVerifiedItermPetAvailability(undefined);
			stubs.widget.dispose();
		}
	});
	it("coalesces animation ticks while an iTerm raster submission is pending", async () => {
		vi.useFakeTimers();
		const stubs = makeWidget(80, 30, { protocol: null });
		try {
			setVerifiedItermPetAvailability({ available: true, mode: "direct", epoch: 1 });
			stubs.setRasterAcquireDelayed(true);
			stubs.widget.setMode("red");
			vi.advanceTimersByTime(800);
			await flushAsyncChain();

			expect(stubs.getPendingRasterAcquireCount()).toBe(1);
			expect(stubs.getRasterOutputs()).toHaveLength(0);

			stubs.setRasterAcquireDelayed(false);
			await flushAsyncChain();
			const headers = stubs
				.getRasterOutputs()
				.map(record => new TextDecoder().decode(record))
				.filter(record => record.includes("MultipartFile="));
			expect(headers).toHaveLength(1);
			expect(stubs.getInvalidatedRasterLeases()).toHaveLength(0);
		} finally {
			setVerifiedItermPetAvailability(undefined);
			stubs.widget.dispose();
		}
	});
	it("runs scheduled auto-flex bursts on the iTerm raster path", async () => {
		vi.useFakeTimers();
		const stubs = makeWidget(80, 30, {
			protocol: null,
			autoFlexGapMs: [500, 500],
			isWorking: () => true,
		});
		try {
			setVerifiedItermPetAvailability({ available: true, mode: "direct", epoch: 1 });
			stubs.widget.setMode("red");
			vi.advanceTimersByTime(80);
			await flushAsyncChain();
			expect(stubs.widget.isFlexing).toBe(false);

			vi.advanceTimersByTime(560);
			await flushAsyncChain();

			expect(stubs.widget.isFlexing).toBe(true);
			const headers = stubs
				.getRasterOutputs()
				.map(record => new TextDecoder().decode(record))
				.filter(record => record.includes("MultipartFile="));
			expect(headers).toHaveLength(2);
			const sizes = headers.map(header => Number(/;size=(\d+);/u.exec(header)?.[1]));
			expect(sizes[1]).toBeGreaterThan(sizes[0]);
		} finally {
			setVerifiedItermPetAvailability(undefined);
			stubs.widget.dispose();
		}
	});
	it("reuses one raster lease and applies cursor visibility for idle-working-idle transitions", async () => {
		vi.useFakeTimers();
		let working = false;
		const stubs = makeWidget(80, 30, { protocol: null, isWorking: () => working });
		try {
			setVerifiedItermPetAvailability({ available: true, mode: "direct", epoch: 1 });
			stubs.widget.setMode("red");
			vi.advanceTimersByTime(80);
			await flushAsyncChain();
			expect(stubs.getRasterCursorVisibilityRestores()).toEqual([true]);

			working = true;
			vi.advanceTimersByTime(80);
			await flushAsyncChain();
			expect(stubs.getRasterCursorVisibilityRestores()).toEqual([true, true]);

			working = false;
			vi.advanceTimersByTime(80);
			await flushAsyncChain();
			expect(stubs.getRasterCursorVisibilityRestores()).toEqual([true, true, true]);
			expect(stubs.getInvalidatedRasterLeases()).toHaveLength(0);
		} finally {
			setVerifiedItermPetAvailability(undefined);
			stubs.widget.dispose();
		}
	});
	it("settles after replacing the idle raster with the working raster", async () => {
		vi.useFakeTimers();
		let working = false;
		const stubs = makeWidget(80, 30, { protocol: null, isWorking: () => working });
		try {
			setVerifiedItermPetAvailability({ available: true, mode: "direct", epoch: 1 });
			stubs.widget.setMode("red");
			vi.advanceTimersByTime(80);
			await flushAsyncChain();

			working = true;
			vi.advanceTimersByTime(80);
			await flushAsyncChain();
			vi.advanceTimersByTime(800);
			await flushAsyncChain();

			const headers = stubs
				.getRasterOutputs()
				.map(record => new TextDecoder().decode(record))
				.filter(record => record.includes("MultipartFile="));
			expect(headers).toHaveLength(2);
			expect(stubs.getInvalidatedRasterLeases()).toHaveLength(0);
		} finally {
			setVerifiedItermPetAvailability(undefined);
			stubs.widget.dispose();
		}
	});
});

describe("PetFramedEditor", () => {
	it("passes through untouched when no reserve is set", () => {
		const { editor } = makeStubs(80);
		const framed = new PetFramedEditor(editor);
		expect(framed.render(80)).toEqual(editor.render(80));
	});
});
