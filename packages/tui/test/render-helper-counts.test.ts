import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { type Component, Container, Editor, Text, TUI } from "@gajae-code/tui";
import { ImageProtocol, setTerminalImageProtocol, TERMINAL } from "@gajae-code/tui/terminal-capabilities";
import { visibleWidth } from "@gajae-code/tui/utils";
import { defaultEditorTheme } from "./test-themes";
import { VirtualTerminal } from "./virtual-terminal";

class MutableLinesComponent implements Component {
	#lines: string[];

	constructor(lines: string[]) {
		this.#lines = [...lines];
	}

	setLines(lines: string[]): void {
		this.#lines = [...lines];
	}

	invalidate(): void {}

	render(_width: number): string[] {
		return [...this.#lines];
	}
}

async function settle(term: VirtualTerminal): Promise<void> {
	await new Promise<void>(resolve => process.nextTick(resolve));
	await Bun.sleep(1);
	await term.flush();
}

function visible(term: VirtualTerminal): string[] {
	return term.getViewport().map(line => line.trimEnd());
}

describe("TUI render helper counters", () => {
	let previousDebugRedraw: string | undefined;
	let monotonicNow = 0;
	const previousEnvironment = new Map<string, string | undefined>();
	const behaviorTraces: Array<{ scenario: string; frames: unknown[] }> = [];

	beforeEach(() => {
		previousDebugRedraw = Bun.env.PI_DEBUG_REDRAW;
		delete Bun.env.PI_DEBUG_REDRAW;
		for (const key of ["TMUX", "STY", "WT_SESSION", "PI_TUI_VIRTUAL_VIEWPORT", "GJC_TUI_IME_CURSOR"]) {
			previousEnvironment.set(key, Bun.env[key]);
			delete Bun.env[key];
		}
		Bun.env.GJC_TUI_IME_CURSOR = "0";
		monotonicNow = 0;
		TUI.resetRenderCountersForTest();
		vi.spyOn(performance, "now").mockImplementation(() => {
			monotonicNow += 20;
			return monotonicNow;
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		TUI.resetRenderCountersForTest();
		for (const [key, value] of previousEnvironment) {
			if (value === undefined) delete Bun.env[key];
			else Bun.env[key] = value;
		}
		previousEnvironment.clear();
		if (previousDebugRedraw === undefined) {
			delete Bun.env.PI_DEBUG_REDRAW;
		} else {
			Bun.env.PI_DEBUG_REDRAW = previousDebugRedraw;
		}
	});

	afterAll(async () => {
		if (behaviorTraces.length && Bun.env.GJC_WIDTH_SCAN_BEHAVIOR_REPORT)
			await Bun.write(Bun.env.GJC_WIDTH_SCAN_BEHAVIOR_REPORT, JSON.stringify(behaviorTraces, null, 2));
	});

	it("caches PI_DEBUG_REDRAW and does not append debug logs when disabled", async () => {
		const term = new VirtualTerminal(40, 8);
		const component = new MutableLinesComponent(["one", "two"]);
		const tui = new TUI(term);
		tui.addChild(component);

		try {
			tui.start();
			await settle(term);

			for (let i = 0; i < 5; i++) {
				component.setLines([`one-${i}`, "two"]);
				tui.requestRender(true, "debug-cache-test");
				await settle(term);
			}

			const counters = TUI.getRenderCountersForTest();
			expect(counters.debugRedrawEnvReads).toBeLessThanOrEqual(1);
			expect(counters.debugRedrawAppendWrites).toBe(0);
		} finally {
			tui.stop();
		}
	});

	it("reuses normalized line widths in the differential truncation guard", async () => {
		const term = new VirtualTerminal(12, 8);
		const component = new MutableLinesComponent(Array.from({ length: 6 }, (_v, i) => `stable-${i}`));
		const tui = new TUI(term);
		tui.addChild(component);

		try {
			tui.start();
			await settle(term);
			TUI.resetRenderCountersForTest();

			const wideLines = Array.from({ length: 6 }, (_v, i) => `${"界".repeat(10)}-${i}`);
			component.setLines(wideLines);
			tui.requestRender(true, "width-reuse-test");
			await settle(term);

			const counters = TUI.getRenderCountersForTest();
			expect(counters.differentialGuardVisibleWidthCalls).toBe(0);
			const viewport = visible(term);
			expect(viewport[0]).toBe("界".repeat(6));
			expect(visibleWidth(viewport[0]!)).toBe(12);
		} finally {
			tui.stop();
		}
	});

	it("treats empty differential rows as zero-width without measuring them", async () => {
		const term = new VirtualTerminal(12, 8);
		const component = new MutableLinesComponent(["before", "", ""]);
		const tui = new TUI(term);
		tui.addChild(component);

		try {
			tui.start();
			await settle(term);
			TUI.resetRenderCountersForTest();

			component.setLines(["after", "", ""]);
			tui.requestRender(true, "empty-row-width-test");
			await settle(term);

			expect(TUI.getRenderCountersForTest().differentialGuardVisibleWidthCalls).toBe(0);
		} finally {
			tui.stop();
		}
	});

	it("skips width-scan row visits on established non-forced live frames", async () => {
		const term = new VirtualTerminal(40, 8);
		const lines = Array.from({ length: 40 }, (_value, index) => `row-${index}`);
		const component = new MutableLinesComponent(lines);
		const editor = new Editor(defaultEditorTheme);
		editor.setBorderVisible(false);
		editor.setText("input");
		const tui = new TUI(term, false, { widthSettleMs: 0 });
		tui.addChild(component);
		tui.addChild(editor);
		tui.setFocus(editor);
		try {
			tui.start();
			await committedFrame(tui, term, "setup");
			for (const action of ["mutate", "append", "input", "same-size", "forced", "after-forced"]) {
				TUI.resetRenderCountersForTest();
				const marker = `tail-${action}`;
				if (action === "append") lines.push(marker);
				else lines[lines.length - 1] = marker;
				component.setLines(lines);
				if (action === "input") term.sendInput("A");
				if (action === "same-size") term.resize(40, 8);
				await committedFrame(tui, term, action, action === "forced");
				expect(visible(term)).toContain(marker);
				if (action === "input") {
					expect(editor.getText()).toBe("inputA");
					expect(visible(term)).toContain(`inputA${defaultEditorTheme.symbols.inputCursor}`);
				}
				expect(TUI.getRenderCountersForTest().widthReflowScanRows).toBe(0);
			}
		} finally {
			tui.stop();
			tui.dispose();
			term.reset();
		}
	});

	for (const virtual of ["0", "1"]) {
		for (const overwide of [false, true]) {
			it(`preserves width-scan resize visits and image exclusion: virtual=${virtual} overwide=${overwide}`, async () => {
				Bun.env.PI_TUI_VIRTUAL_VIEWPORT = virtual;
				const previousProtocol = TERMINAL.imageProtocol;
				const image = `\x1b_Ga=T,f=32,s=1,v=1;AAAAAA==\x1b\\${"界".repeat(20)}`;
				const equal = `\x1b[31m${"界".repeat(6)}\x1b[0m`;
				const lines = [image, equal, overwide ? "界".repeat(7) : "fitting", "last"];
				const term = new VirtualTerminal(12, 12);
				const tui = new TUI(term, false, { widthSettleMs: 0 });
				try {
					setTerminalImageProtocol(ImageProtocol.Kitty);
					expect(TERMINAL.isImageLine(image)).toBe(true);
					expect(visibleWidth(image)).toBeGreaterThan(12);
					expect(visibleWidth(equal)).toBe(12);
					tui.addChild(new MutableLinesComponent(lines));
					tui.start();
					await committedFrame(tui, term, "setup");
					TUI.resetRenderCountersForTest();
					term.resize(14, 12);
					await committedFrame(tui, term, "resize");
					expect(TUI.getRenderCountersForTest().widthReflowScanRows).toBe(overwide ? 3 : lines.length);
					TUI.resetRenderCountersForTest();
					await committedFrame(tui, term, "forced", true);
					expect(TUI.getRenderCountersForTest().widthReflowScanRows).toBe(0);
				} finally {
					try {
						tui.stop();
						tui.dispose();
						term.reset();
					} finally {
						setTerminalImageProtocol(previousProtocol);
					}
				}
			});
		}

		for (const processHost of [false, true]) {
			it(`preserves width-scan behavior: virtual=${virtual} viewportHost=${processHost}`, async () => {
				Bun.env.PI_TUI_VIRTUAL_VIEWPORT = virtual;
				const term = new VirtualTerminal(40, 8, { isProcessTerminal: processHost });
				const lines = Array.from({ length: 60 }, (_value, index) => `row-${index.toString().padStart(2, "0")}`);
				const component = new MutableLinesComponent(lines);
				const tui = new TUI(term, false, { widthSettleMs: 0 });
				tui.addChild(component);
				const frames: unknown[] = [];
				const capture = async (label: string, force = false, resizeOnly = false) => {
					await committedFrame(tui, term, resizeOnly ? "resize" : label, force);
					frames.push(frameObservation(label, tui, term));
					term.clearWriteLog();
				};
				try {
					tui.start();
					await capture("setup");
					for (const label of ["mutation", "append", "same-size", "forced", "after-forced"]) {
						if (label === "append") lines.push(label);
						else lines[lines.length - 1] = label;
						component.setLines(lines);
						if (label === "same-size") term.resize(40, 8);
						await capture(label, label === "forced");
						expect(visible(term)).toContain(label);
					}
					for (const [width, height] of [
						[40, 10],
						[24, 10],
						[40, 10],
					] as const) {
						term.resize(width, height);
						await capture(`resize-${width}-${height}`, false, true);
						expect(visible(term)).toContain("after-forced");
					}
					for (const resizeFirst of [true, false]) {
						const marker = resizeFirst ? "once-resize-first" : "once-mutation-first";
						if (resizeFirst) term.resize(30, 10);
						lines.push(marker);
						component.setLines(lines);
						tui.requestRender(false, "mutation");
						if (!resizeFirst) term.resize(40, 10);
						await capture(marker);
						expect(term.getScrollBuffer().filter(line => line.trimEnd() === marker)).toHaveLength(1);
					}
					lines[0] = "界".repeat(30);
					lines.push("unproven-append");
					component.setLines(lines);
					term.resize(24, 10);
					await capture("unproven-reflow");
					expect(visible(term)).toContain("unproven-append");
					behaviorTraces.push({ scenario: `virtual=${virtual},viewportHost=${processHost}`, frames });
				} finally {
					tui.stop();
					tui.dispose();
					term.reset();
				}
			});
		}
	}

	it("preserves width-scan behavior for renderer-owned anchors and manual history", async () => {
		const term = new VirtualTerminal(40, 8, { isProcessTerminal: true });
		const tui = new TUI(term, false, { widthSettleMs: 0 });
		const transcript = new Container();
		const texts = Array.from(
			{ length: 60 },
			(_value, index) => new Text(`row-${index} alpha beta gamma delta`, 0, 0),
		);
		for (const [index, text] of texts.entries()) {
			transcript.addChild(text);
			transcript.setViewportAnchorSource(text, { id: `message-${index}` });
		}
		tui.addChild(transcript);
		tui.setViewportAnchorComponent(transcript);
		tui.setViewportOutputSource({ identity: "width-scan", revision: 0n });
		const frames: unknown[] = [];
		const capture = async (label: string, directPaint = false) => {
			if (directPaint) await term.flush();
			else await committedFrame(tui, term, label);
			frames.push({ directPaint, ...frameObservation(label, tui, term) });
			term.clearWriteLog();
		};
		try {
			tui.start();
			await capture("setup");
			expect(tui.getViewportAnchorSnapshot()?.anchors.some(anchor => anchor?.id === "message-59")).toBe(true);
			// Edge pinning makes the first-visible semantic observation the retained anchor.
			expect(tui.scrollViewportBy(-12, { pin: "edge" })).toBe(true);
			await capture("manual", true);
			const anchored = tui.getViewportObservation()?.semanticAnchor;
			expect(anchored).toMatchObject({ id: "message-40", graphemeStart: 0, cellStart: 0 });
			expect(tui.getViewportObservation()?.manualHistory).toBe(true);
			texts[59]!.setText("hidden live mutation");
			tui.setViewportOutputSource({ identity: "width-scan", revision: 1n });
			await capture("manual-mutation");
			expect(tui.getViewportObservation()?.semanticAnchor?.id).toBe(anchored?.id);
			term.resize(24, 8);
			await capture("manual-resize");
			const reflowed = tui.getViewportObservation()?.semanticAnchor;
			expect(reflowed?.id).toBe(anchored?.id);
			expect(reflowed!.graphemeStart).toBeLessThanOrEqual(anchored!.graphemeStart);
			expect(reflowed!.graphemeEnd).toBeGreaterThan(anchored!.graphemeStart);
			expect(tui.followLiveViewport()).toBe(true);
			await capture("follow-live", true);
			expect(tui.getViewportObservation()?.manualHistory).toBe(false);
			expect(visible(term)).toContain("hidden live mutation");
			behaviorTraces.push({ scenario: "semantic-anchors", frames });
		} finally {
			tui.stop();
			tui.dispose();
			term.reset();
		}
	});
});

async function committedFrame(tui: TUI, term: VirtualTerminal, source: string, force = false): Promise<void> {
	const generation = tui.requestRenderWithGeneration(force, source);
	expect(await tui.waitForRenderCommit(generation, 1_000)).toBe(true);
	await term.flush();
}

function frameObservation(label: string, tui: TUI, term: VirtualTerminal) {
	return {
		label,
		writes: term.getWriteLog(),
		viewport: term.getViewport(),
		scrollback: term.getScrollBuffer(),
		observation: tui.getViewportObservation(),
		anchors: tui.getViewportAnchorSnapshot(),
	};
}
