import { describe, expect, it } from "bun:test";
import {
	type Component,
	Container,
	CURSOR_MARKER,
	DEFAULT_WHEEL_LINES,
	Editor,
	encodeKittyPlacementDelete,
	extractKittyPlacementReferences,
	getCellDimensions,
	Image,
	ImageProtocol,
	Markdown,
	renderComponentWithViewportAnchors,
	resetKittyTransmissions,
	setCellDimensions,
	setKittyTransmitWriter,
	setTerminalImageProtocol,
	shouldUseViewportRepaintForHost,
	shouldUseViewportRepaintForTerminal,
	TERMINAL,
	Text,
	TUI,
	VIEWPORT_ANCHOR_PREFIX,
	type ViewportAnchorRender,
	type ViewportAnchorSource,
	visibleWidth,
} from "@gajae-code/tui";
import { renderMetrics } from "@gajae-code/tui/metrics";
import { defaultEditorTheme, defaultMarkdownTheme } from "./test-themes";
import { VirtualTerminal } from "./virtual-terminal";

class Lines implements Component {
	static #nextId = 0;
	readonly id = `test-lines-${Lines.#nextId++}`;

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

	renderWithViewportAnchors(_width: number): ViewportAnchorRender {
		let graphemeOffset = 0;
		let cellOffset = 0;
		const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
		const anchors = this.#lines.map(line => {
			const graphemeCount = [...segmenter.segment(Bun.stripANSI(line))].length;
			const cellCount = Bun.stringWidth(line);
			const anchor =
				graphemeCount === 0
					? null
					: {
							id: this.id,
							graphemeStart: graphemeOffset,
							graphemeEnd: graphemeOffset + graphemeCount,
							cellStart: cellOffset,
							cellEnd: cellOffset + Math.max(1, cellCount),
						};
			graphemeOffset += graphemeCount + 1;
			cellOffset += cellCount;
			return anchor;
		});
		return { lines: this.#lines, anchors };
	}

	getText(): string {
		return this.#lines.join("\n");
	}

	invalidate(): void {}
}

class FocusedEditor extends Lines {
	focused = false;

	override render(width: number): string[] {
		return this.focused ? [`${CURSOR_MARKER}${super.render(width)[0]}`] : super.render(width);
	}

	override renderWithViewportAnchors(width: number): ViewportAnchorRender {
		const lines = this.render(width);
		return { lines, anchors: lines.map(() => null) };
	}
}
class AnchoredTranscript extends Container {
	addRow(id: string, text: string): Text {
		const component = new Text(text, 0, 0);
		this.addChild(component);
		this.setViewportAnchorSource(component, { id });
		return component;
	}

	removeFirst(count: number): void {
		for (const child of this.children.slice(0, count)) this.detachChild(child);
	}
}

class RecoveringText extends Text {
	fail = false;

	override renderWithViewportAnchorSource(width: number, source: ViewportAnchorSource): ViewportAnchorRender {
		if (this.fail) throw new Error("recoverable anchor render failure");
		return super.renderWithViewportAnchorSource(width, source);
	}
}

async function settle(term: VirtualTerminal): Promise<void> {
	await term.waitForRender();
}

function visible(term: VirtualTerminal): string[] {
	return term.getViewport().map(line => line.trimEnd());
}

function cursorPosition(term: VirtualTerminal): { row: number; col: number } {
	const buffer = (
		term as unknown as {
			xterm: { buffer: { active: { cursorX: number; cursorY: number } } };
		}
	).xterm.buffer.active;
	return { row: buffer.cursorY, col: buffer.cursorX };
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
	it("scrolls the viewport by discrete wheel-sized row steps", async () => {
		const term = new VirtualTerminal(30, 5);
		const tui = new TUI(term);
		const content = new Lines(Array.from({ length: 12 }, (_value, index) => `line-${index}`));
		tui.addChild(content);

		try {
			tui.start();
			await settle(term);
			expect(visible(term)).toEqual(["line-7", "line-8", "line-9", "line-10", "line-11"]);

			expect(tui.scrollViewportBy(-DEFAULT_WHEEL_LINES, { pin: "stable" })).toBe(true);
			await term.flush();
			expect(visible(term)).toEqual(["line-4", "line-5", "line-6", "line-7", "line-8"]);

			expect(tui.scrollViewportBy(-DEFAULT_WHEEL_LINES, { pin: "stable" })).toBe(true);
			await term.flush();
			expect(visible(term)).toEqual(["line-1", "line-2", "line-3", "line-4", "line-5"]);

			expect(tui.scrollViewportBy(DEFAULT_WHEEL_LINES, { pin: "stable" })).toBe(true);
			await term.flush();
			expect(visible(term)).toEqual(["line-4", "line-5", "line-6", "line-7", "line-8"]);

			// Page stepping remains larger than a single wheel notch.
			expect(tui.scrollViewportPages(1)).toBe(true);
			await term.flush();
			expect(visible(term)).toEqual(["line-7", "line-8", "line-9", "line-10", "line-11"]);
		} finally {
			tui.stop();
		}
	});

	it("rejects a zero-row viewport delta", async () => {
		const term = new VirtualTerminal(30, 5);
		const tui = new TUI(term);
		tui.addChild(new Lines(Array.from({ length: 10 }, (_value, index) => `line-${index}`)));

		try {
			tui.start();
			await settle(term);
			expect(tui.scrollViewportBy(0)).toBe(false);
		} finally {
			tui.stop();
		}
	});

	it("repaints all rows when content contracts from height plus one to height minus one", async () => {
		const term = new VirtualTerminal(30, 5);
		const tui = new TUI(term);
		const content = new Lines(Array.from({ length: 6 }, (_value, index) => `line-${index}`));
		tui.addChild(content);

		try {
			tui.start();
			await settle(term);
			expect(visible(term)).toEqual(["line-1", "line-2", "line-3", "line-4", "line-5"]);

			content.replace(["line-0", "line-1", "line-2", "line-3"]);
			tui.requestRender();
			await settle(term);

			expect(visible(term)).toEqual(["line-0", "line-1", "line-2", "line-3", ""]);
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

	it("clamps providerless manual paging to a full viewport after shrink", async () => {
		const term = new VirtualTerminal(30, 5);
		const tui = new TUI(term);
		const content = new Lines(Array.from({ length: 10 }, (_value, index) => `line-${index}`));
		tui.addChild(content);
		try {
			tui.start();
			await settle(term);
			expect(tui.scrollViewportPages(-1)).toBe(true);
			await term.flush();
			content.replace(["line-0", "line-1", "line-2", "line-3"]);
			tui.requestRender();
			await settle(term);
			expect(visible(term)).toEqual(["line-0", "line-1", "line-2", "line-3", ""]);
		} finally {
			tui.stop();
		}
	});

	it("keeps manual viewport control after a partial downward move while transient panel streams", async () => {
		const term = new VirtualTerminal(30, 6);
		const tui = new TUI(term);
		const content = new Lines(Array.from({ length: 12 }, (_value, index) => `line-${index}`));
		const transientPanel = new Lines([]);
		const status = new Lines(["status"]);
		const editor = new Lines(["editor"]);
		tui.addChild(content);
		tui.addChild(transientPanel);
		tui.addChild(status);
		tui.addChild(editor);
		tui.setBottomPinnedComponent(status);

		try {
			tui.start();
			await settle(term);
			expect(visible(term)).toEqual(["line-8", "line-9", "line-10", "line-11", "status", "editor"]);

			expect(tui.scrollViewportPages(-1)).toBe(true);
			await term.flush();
			expect(visible(term)).toEqual(["line-5", "line-6", "line-7", "line-8", "status", "editor"]);

			// Partial downward move stays manual instead of auto-following live.
			expect(tui.scrollViewportBy(2, { pin: "stable" })).toBe(true);
			await term.flush();
			expect(visible(term)).toEqual(["line-7", "line-8", "line-9", "line-10", "status", "editor"]);

			transientPanel.replace(["btw-0", "btw-1"]);
			tui.requestRender();
			await settle(term);

			expect(visible(term)).toEqual(["line-7", "line-8", "line-9", "line-10", "status", "editor"]);
			expect(tui.followLiveViewport()).toBe(true);
			await term.flush();
			expect(visible(term)).toEqual(["line-10", "line-11", "btw-0", "btw-1", "status", "editor"]);
		} finally {
			tui.stop();
		}
	});

	it("keeps the pinned suffix visible and reports one semantic output revision while manually scrolled", async () => {
		const term = new VirtualTerminal(30, 6);
		const tui = new TUI(term);
		const transcript = new Lines(Array.from({ length: 12 }, (_value, index) => `line-${index}`));
		const status = new Lines(["status"]);
		const editor = new Lines(["editor"]);
		tui.addChild(transcript);
		tui.addChild(status);
		tui.addChild(editor);
		tui.setBottomPinnedComponent(status);
		tui.setViewportOutputSource({ identity: "assistant", revision: 0n });
		try {
			tui.start();
			await settle(term);
			expect(tui.scrollViewportPages(-1)).toBe(true);
			await term.flush();
			expect(visible(term)).toEqual(["line-5", "line-6", "line-7", "line-8", "status", "editor"]);

			tui.setViewportOutputSource({ identity: "assistant", revision: 1n });
			await settle(term);
			expect(visible(term)).toEqual([
				"line-5",
				"line-6",
				"line-7",
				"New output — type to follow",
				"status",
				"editor",
			]);
			expect(tui.followLiveViewport()).toBe(true);
			await term.flush();
			expect(visible(term)).toEqual(["line-8", "line-9", "line-10", "line-11", "status", "editor"]);
		} finally {
			tui.stop();
		}
	});
	it("activates a pinned suffix without an output source and keeps notices source-driven", async () => {
		const term = new VirtualTerminal(30, 6);
		const tui = new TUI(term);
		const transcript = new Lines(Array.from({ length: 12 }, (_value, index) => `line-${index}`));
		const status = new Lines(["status"]);
		const editor = new Lines(["editor"]);
		tui.addChild(transcript);
		tui.addChild(status);
		tui.addChild(editor);
		tui.setBottomPinnedComponent(status);
		try {
			tui.start();
			await settle(term);
			expect(tui.scrollViewportPages(-1)).toBe(true);
			await term.flush();
			expect(visible(term)).toEqual(["line-5", "line-6", "line-7", "line-8", "status", "editor"]);

			tui.setViewportOutputSource({ identity: "assistant", revision: 0n });
			tui.setViewportOutputSource({ identity: "assistant", revision: 1n });
			await settle(term);
			expect(visible(term)).toEqual([
				"line-5",
				"line-6",
				"line-7",
				"New output — type to follow",
				"status",
				"editor",
			]);
			tui.setViewportOutputSource({ identity: "assistant", revision: 0n });
			await settle(term);
			expect(visible(term)).toContain("New output — type to follow");
			tui.setViewportOutputSource({ identity: "other", revision: 0n });
			await settle(term);
			expect(visible(term)).not.toContain("New output — type to follow");
		} finally {
			tui.stop();
		}
	});

	it("keeps short manual transcripts above one copy of each pinned suffix row after rerendering", async () => {
		const term = new VirtualTerminal(30, 5);
		const tui = new TUI(term);
		tui.addChild(new Lines(["line-0", "line-1"]));
		const status = new Lines(["status"]);
		const editor = new Lines(["editor"]);
		tui.addChild(status);
		tui.addChild(editor);
		tui.setBottomPinnedComponent(status);
		try {
			tui.start();
			await settle(term);
			expect(tui.scrollViewportPages(-1)).toBe(true);
			await term.flush();
			tui.requestRender();
			await settle(term);

			expect(visible(term)).toEqual(["line-0", "line-1", "", "status", "editor"]);
		} finally {
			tui.stop();
		}
	});

	it("follows a contracted short manual frame with the pinned suffix at the live bottom", async () => {
		const term = new VirtualTerminal(30, 5);
		const tui = new TUI(term);
		const transcript = new Lines(Array.from({ length: 6 }, (_value, index) => `line-${index}`));
		const status = new Lines(["status"]);
		const editor = new Lines(["editor"]);
		tui.addChild(transcript);
		tui.addChild(status);
		tui.addChild(editor);
		tui.setBottomPinnedComponent(status);
		try {
			tui.start();
			await settle(term);
			expect(tui.scrollViewportPages(-1)).toBe(true);
			await term.flush();

			transcript.replace(["line-0", "line-1"]);
			tui.requestRender();
			await settle(term);
			expect(visible(term)).toEqual(["line-0", "line-1", "", "status", "editor"]);

			expect(tui.followLiveViewport()).toBe(true);
			await term.flush();
			expect(visible(term)).toEqual(["line-0", "line-1", "", "status", "editor"]);
		} finally {
			tui.stop();
		}
	});

	it("rebases a nested editor cursor when following a contracted manual viewport with IME reanchoring", async () => {
		const previousImeCursor = Bun.env.GJC_TUI_IME_CURSOR;
		Bun.env.GJC_TUI_IME_CURSOR = "1";
		const term = new VirtualTerminal(30, 6);
		const tui = new TUI(term);
		const transcript = new Lines(Array.from({ length: 6 }, (_value, index) => `line-${index}`));
		const status = new Lines(["status"]);
		const editor = new Editor(defaultEditorTheme);
		editor.setBorderVisible(false);
		editor.setText("editor");
		editor.setUseTerminalCursor(true);
		const editorContainer = new Container();
		editorContainer.addChild(editor);
		tui.addChild(transcript);
		tui.addChild(status);
		tui.addChild(editorContainer);
		tui.setBottomPinnedComponent(status);
		tui.setFocus(editor);
		try {
			tui.start();
			await settle(term);
			expect(tui.scrollViewportPages(-1)).toBe(true);
			await term.flush();

			transcript.replace(["line-0"]);
			tui.requestRender();
			await settle(term);
			expect(visible(term)).toEqual(["line-0", "", "", "", "status", "editor"]);

			term.clearWriteLog();
			expect(tui.followLiveViewport()).toBe(true);
			await term.flush();
			expect(visible(term)).toEqual(["line-0", "", "", "", "status", "editor"]);
			expect(cursorPosition(term)).toEqual({ row: 5, col: 6 });
			expect(term.getWriteLog().at(-1)).toContain("\x1b[?25h");
		} finally {
			if (previousImeCursor === undefined) delete Bun.env.GJC_TUI_IME_CURSOR;
			else Bun.env.GJC_TUI_IME_CURSOR = previousImeCursor;
			tui.stop();
		}
	});

	it("treats same-identity output revisions as a manual-view high-water mark", async () => {
		const cases: Array<{
			name: string;
			apply: (tui: TUI) => void;
			expectsNotice: boolean;
		}> = [
			{
				name: "same revision",
				apply: tui => tui.setViewportOutputSource({ identity: "assistant", revision: 10n }),
				expectsNotice: false,
			},
			{
				name: "repeated revision",
				apply: tui => {
					tui.setViewportOutputSource({ identity: "assistant", revision: 10n });
					tui.setViewportOutputSource({ identity: "assistant", revision: 10n });
				},
				expectsNotice: false,
			},
			{
				name: "live advance",
				apply: tui => {
					tui.followLiveViewport();
					tui.setViewportOutputSource({ identity: "assistant", revision: 11n });
				},
				expectsNotice: false,
			},
			{
				name: "null reset",
				apply: tui => tui.setViewportOutputSource(null),
				expectsNotice: false,
			},
			{
				name: "identity reset",
				apply: tui => tui.setViewportOutputSource({ identity: "other", revision: 0n }),
				expectsNotice: false,
			},
			{
				name: "armed rollback",
				apply: tui => {
					tui.setViewportOutputSource({ identity: "assistant", revision: 11n });
					tui.setViewportOutputSource({ identity: "assistant", revision: 10n });
				},
				expectsNotice: true,
			},
			{
				name: "10 to 9 to 10",
				apply: tui => {
					tui.setViewportOutputSource({ identity: "assistant", revision: 9n });
					tui.setViewportOutputSource({ identity: "assistant", revision: 10n });
				},
				expectsNotice: false,
			},
		];

		for (const state of cases) {
			const term = new VirtualTerminal(30, 6);
			const tui = new TUI(term);
			tui.addChild(new Lines(Array.from({ length: 12 }, (_value, index) => `line-${index}`)));
			const status = new Lines(["status"]);
			tui.addChild(status);
			tui.addChild(new Lines(["editor"]));
			tui.setBottomPinnedComponent(status);
			tui.setViewportOutputSource({ identity: "assistant", revision: 10n });
			try {
				tui.start();
				await settle(term);
				expect(tui.scrollViewportPages(-1), state.name).toBe(true);
				await term.flush();
				state.apply(tui);
				await settle(term);
				expect(visible(term).includes("New output — type to follow"), state.name).toBe(state.expectsNotice);
			} finally {
				tui.stop();
			}
		}
	});

	it("makes identical output-source updates, including repeated clears, true render-request no-ops", async () => {
		const term = new VirtualTerminal(30, 6);
		const tui = new TUI(term);
		tui.addChild(new Lines(["line"]));
		const wasMetricsEnabled = renderMetrics.enabled;
		renderMetrics.enable();
		try {
			tui.setViewportOutputSource({ identity: "assistant", revision: 10n });
			tui.start();
			await settle(term);
			renderMetrics.reset();
			const before = renderMetrics.snapshot();

			tui.setViewportOutputSource({ identity: "assistant", revision: 10n });
			tui.setViewportOutputSource(null);
			await settle(term);
			const afterClear = renderMetrics.snapshot();
			tui.setViewportOutputSource(null);
			await Promise.resolve();
			await term.flush();

			const after = renderMetrics.snapshot();
			expect(afterClear.renderCount).toBe(before.renderCount + 1);
			expect(after.renderCount).toBe(afterClear.renderCount);
			expect(after.requestSources).toEqual(afterClear.requestSources);
			expect(after.structuralCounters.viewportOutputSourceEqualNoops).toBe(2);
		} finally {
			tui.stop();
			renderMetrics.reset();
			if (!wasMetricsEnabled) renderMetrics.disable();
		}
	});

	it("constrains oversized suffixes without slicing the large flat transcript frame", async () => {
		for (const transcriptRows of [10_000, 100_000]) {
			const term = new VirtualTerminal(30, 3);
			const tui = new TUI(term);
			tui.addChild(new Lines(Array.from({ length: transcriptRows }, (_value, index) => `line-${index}`)));
			const status = new Lines(["status"]);
			tui.addChild(status);
			tui.addChild(new FocusedEditor(["editor"]));
			tui.addChild(new Lines(["help"]));
			tui.addChild(new Lines(["pet"]));
			tui.setBottomPinnedComponent(status);
			const wasMetricsEnabled = renderMetrics.enabled;
			renderMetrics.enable();
			renderMetrics.reset();
			const flatFrameRows = transcriptRows + 4;
			const originalSlice = Array.prototype.slice;
			let flatFrameSlices = 0;
			let negativeControlSlices = 0;
			const isLargeFlatFrame = (receiver: unknown[]): boolean =>
				receiver.length === flatFrameRows &&
				receiver[0] === "line-0" &&
				receiver[transcriptRows - 1] === `line-${transcriptRows - 1}`;
			try {
				Array.prototype.slice = function <T>(this: T[], start?: number, end?: number): T[] {
					if (isLargeFlatFrame(this)) flatFrameSlices++;
					return originalSlice.call(this, start, end);
				};
				const negativeControl = Array.from({ length: flatFrameRows }, (_value, index) =>
					index < transcriptRows ? `line-${index}` : "suffix",
				);
				negativeControl.slice(0, 1);
				negativeControlSlices = flatFrameSlices;
				flatFrameSlices = 0;
				tui.start();
				await settle(term);
				expect(visible(term), `${transcriptRows} rows`).toEqual(["status", "help", "pet"]);
				expect(negativeControlSlices).toBe(1);
				expect(flatFrameSlices).toBe(0);
				const counters = renderMetrics.snapshot().structuralCounters;
				expect(counters.pinnedSuffixOverflowFrames).toBeGreaterThan(0);
			} finally {
				Array.prototype.slice = originalSlice;
				tui.stop();
				renderMetrics.reset();
				if (!wasMetricsEnabled) renderMetrics.disable();
			}
		}
	});

	it("bounds short transcripts and prioritizes the focused cursor, status boundary, and trailing suffix children", async () => {
		const term = new VirtualTerminal(30, 4);
		const tui = new TUI(term);
		const transcript = new Lines(["line-0"]);
		const decoration = new Lines(["decoration"]);
		const status = new Lines(["status"]);
		const editor = new FocusedEditor(["editor"]);
		const editorContainer = new Container();
		editorContainer.addChild(editor);
		editorContainer.addChild(new Lines(["help"]));
		const pet = new Lines(["pet"]);

		tui.addChild(transcript);
		tui.addChild(decoration);
		tui.addChild(status);
		tui.addChild(editorContainer);
		tui.addChild(pet);
		tui.setBottomPinnedComponent(status);
		tui.setFocus(editor);
		try {
			tui.start();
			await settle(term);
			for (const [height, expected] of [
				[1, ["editor"]],
				[2, ["status", "editor"]],
				[3, ["status", "editor", "pet"]],
				[4, ["status", "editor", "help", "pet"]],
			] as const) {
				term.resize(30, height);
				await settle(term);
				const rows = visible(term);
				expect(rows).toEqual([...expected]);
				expect(rows).toContain("editor");
				expect(rows.filter(row => row === "editor")).toHaveLength(1);
			}
			expect(tui.scrollViewportBy(Number.POSITIVE_INFINITY)).toBe(false);
			expect(tui.scrollViewportBy(Number.NaN)).toBe(false);
		} finally {
			tui.stop();
		}
	});

	it("keeps Windows Terminal pinned when a normal assistant answer starts before status/editor", async () => {
		const term = new VirtualTerminal(30, 6, { isProcessTerminal: true });
		const tui = new TUI(term);
		const chat = new Lines(Array.from({ length: 12 }, (_value, index) => `line-${index}`));
		const working = new Lines(["thinking"]);
		const status = new Lines(["status"]);
		const editor = new Lines(["editor"]);
		tui.addChild(chat);
		tui.addChild(working);
		tui.addChild(status);
		tui.addChild(editor);
		tui.setBottomPinnedComponent(status);
		const previousWtSession = Bun.env.WT_SESSION;
		Bun.env.WT_SESSION = "test-windows-terminal-session";

		try {
			tui.start();
			await settle(term);
			expect(visible(term)).toEqual(["line-9", "line-10", "line-11", "thinking", "status", "editor"]);
			term.clearWriteLog();

			chat.append("assistant-0");
			tui.requestRender();
			await settle(term);

			expect(visible(term)).toEqual(["line-10", "line-11", "assistant-0", "thinking", "status", "editor"]);
			expect(term.getWriteLog().join("")).not.toContain("\x1b[2J\x1b[H");

			term.clearWriteLog();
			chat.setLine(12, "assistant-0 token");
			tui.requestRender();
			await settle(term);

			expect(visible(term)).toEqual(["line-10", "line-11", "assistant-0 token", "thinking", "status", "editor"]);
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

	it("keeps Windows Terminal live output pinned when offscreen lines change during streaming", async () => {
		const term = new VirtualTerminal(30, 5, { isProcessTerminal: true });
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
		const term = new VirtualTerminal(30, 5, { isProcessTerminal: true });
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
	it("auto-follows live on an exact wheel-down to the transcript bottom", async () => {
		const term = new VirtualTerminal(30, 5);
		const tui = new TUI(term);
		const content = new Lines(Array.from({ length: 12 }, (_value, index) => `line-${index}`));
		tui.addChild(content);

		try {
			tui.start();
			await settle(term);
			expect(visible(term)).toEqual(["line-7", "line-8", "line-9", "line-10", "line-11"]);

			expect(tui.scrollViewportBy(-DEFAULT_WHEEL_LINES, { pin: "stable" })).toBe(true);
			await term.flush();
			expect(tui.scrollViewportBy(-DEFAULT_WHEEL_LINES, { pin: "stable" })).toBe(true);
			await term.flush();
			// Two wheel-ups from the live bottom land two steps above the max top.
			expect(visible(term)).toEqual(["line-1", "line-2", "line-3", "line-4", "line-5"]);

			// A partial wheel-down does not reach the bottom yet.
			expect(tui.scrollViewportBy(DEFAULT_WHEEL_LINES, { pin: "stable" })).toBe(true);
			await term.flush();
			expect(visible(term)).toEqual(["line-4", "line-5", "line-6", "line-7", "line-8"]);

			// The final wheel-down clamps to the exact bottom and follows live.
			expect(tui.scrollViewportBy(DEFAULT_WHEEL_LINES, { pin: "stable" })).toBe(true);
			await term.flush();
			expect(visible(term)).toEqual(["line-7", "line-8", "line-9", "line-10", "line-11"]);
			expect(tui.followLiveViewport()).toBe(false);
		} finally {
			tui.stop();
		}
	});

	it("auto-follows live on PageDown at the transcript bottom", async () => {
		const term = new VirtualTerminal(30, 5);
		const tui = new TUI(term);
		tui.addChild(new Lines(Array.from({ length: 12 }, (_value, index) => `line-${index}`)));

		try {
			tui.start();
			await settle(term);
			expect(visible(term)).toEqual(["line-7", "line-8", "line-9", "line-10", "line-11"]);

			expect(tui.scrollViewportPages(-1)).toBe(true);
			await term.flush();
			expect(visible(term)).toEqual(["line-3", "line-4", "line-5", "line-6", "line-7"]);

			expect(tui.scrollViewportPages(1)).toBe(true);
			await term.flush();
			expect(visible(term)).toEqual(["line-7", "line-8", "line-9", "line-10", "line-11"]);
			expect(tui.followLiveViewport()).toBe(false);
		} finally {
			tui.stop();
		}
	});
	it("keeps wheel-down and PageDown at the live bottom as no-ops", async () => {
		for (const mode of ["wheel", "page"] as const) {
			const term = new VirtualTerminal(30, 5);
			const tui = new TUI(term);
			const content = new Lines(Array.from({ length: 12 }, (_value, index) => `line-${index}`));
			tui.addChild(content);
			tui.setViewportOutputSource({ identity: `live-bottom-${mode}`, revision: 0n });
			try {
				tui.start();
				await settle(term);
				const moved =
					mode === "wheel"
						? tui.scrollViewportBy(DEFAULT_WHEEL_LINES, { pin: "stable" })
						: tui.scrollViewportPages(1);
				expect(moved).toBe(true);

				content.replace(Array.from({ length: 13 }, (_value, index) => `line-${index}`));
				tui.setViewportOutputSource({ identity: `live-bottom-${mode}`, revision: 1n });
				tui.requestRender();
				await settle(term);
				expect(visible(term)).toEqual(["line-8", "line-9", "line-10", "line-11", "line-12"]);
				expect(visible(term).join("\n")).not.toContain("New output — type to follow");
				expect(tui.followLiveViewport()).toBe(false);
			} finally {
				tui.stop();
			}
		}
	});

	it("retains manual ownership and the exact notice on a partial downward move", async () => {
		const term = new VirtualTerminal(30, 6);
		const tui = new TUI(term);
		const transcript = new Lines(Array.from({ length: 12 }, (_value, index) => `line-${index}`));
		const status = new Lines(["status"]);
		const editor = new Lines(["editor"]);
		tui.addChild(transcript);
		tui.addChild(status);
		tui.addChild(editor);
		tui.setBottomPinnedComponent(status);
		tui.setViewportOutputSource({ identity: "assistant", revision: 0n });
		try {
			tui.start();
			await settle(term);
			expect(tui.scrollViewportPages(-1)).toBe(true);
			await term.flush();
			expect(visible(term)).toEqual(["line-5", "line-6", "line-7", "line-8", "status", "editor"]);

			tui.setViewportOutputSource({ identity: "assistant", revision: 1n });
			await settle(term);
			expect(visible(term)).toEqual([
				"line-5",
				"line-6",
				"line-7",
				"New output — type to follow",
				"status",
				"editor",
			]);

			// Partial downward move stays manual with the notice intact.
			expect(tui.scrollViewportBy(1, { pin: "stable" })).toBe(true);
			await term.flush();
			expect(visible(term)).toEqual([
				"line-6",
				"line-7",
				"line-8",
				"New output — type to follow",
				"status",
				"editor",
			]);
			expect(tui.followLiveViewport()).toBe(true);
		} finally {
			tui.stop();
		}
	});

	it("auto-follows at the transcript bottom across capacity 0, 1, and many rows", async () => {
		for (const [height, label] of [
			[2, "capacity-0"],
			[3, "capacity-1"],
			[6, "capacity-many"],
		] as const) {
			const term = new VirtualTerminal(30, height);
			const tui = new TUI(term);
			tui.addChild(new Lines(Array.from({ length: 12 }, (_value, index) => `line-${index}`)));
			const status = new Lines(["status"]);
			const editor = new Lines(["editor"]);
			tui.addChild(status);
			tui.addChild(editor);
			tui.setBottomPinnedComponent(status);
			try {
				tui.start();
				await settle(term);

				expect(tui.scrollViewportPages(-1), label).toBe(true);
				await term.flush();
				expect(tui.followLiveViewport(), label).toBe(true);
				await term.flush();

				expect(tui.scrollViewportPages(-1), label).toBe(true);
				await term.flush();
				expect(tui.scrollViewportPages(1), label).toBe(true);
				await term.flush();
				expect(tui.followLiveViewport(), label).toBe(false);
			} finally {
				tui.stop();
			}
		}
	});

	it("auto-follows with a constrained suffix that exceeds the viewport height", async () => {
		const term = new VirtualTerminal(30, 3);
		const tui = new TUI(term);
		tui.addChild(new Lines(Array.from({ length: 50 }, (_value, index) => `line-${index}`)));
		const status = new Lines(["status"]);
		tui.addChild(status);
		tui.addChild(new Lines(["editor"]));
		tui.addChild(new Lines(["help"]));
		tui.addChild(new Lines(["pet"]));
		tui.setBottomPinnedComponent(status);
		try {
			tui.start();
			await settle(term);
			expect(visible(term)).toEqual(["status", "help", "pet"]);

			expect(tui.scrollViewportPages(-1)).toBe(true);
			await term.flush();
			expect(tui.followLiveViewport()).toBe(true);
			await term.flush();

			expect(tui.scrollViewportPages(-1)).toBe(true);
			await term.flush();
			expect(tui.scrollViewportPages(1)).toBe(true);
			await term.flush();
			expect(tui.followLiveViewport()).toBe(false);
		} finally {
			tui.stop();
		}
	});

	it("preserves editor focus after auto-following at the bottom", async () => {
		const term = new VirtualTerminal(30, 6);
		const tui = new TUI(term);
		tui.addChild(new Lines(Array.from({ length: 12 }, (_value, index) => `line-${index}`)));
		const status = new Lines(["status"]);
		const editor = new FocusedEditor(["editor"]);
		tui.addChild(status);
		tui.addChild(editor);
		tui.setBottomPinnedComponent(status);
		tui.setFocus(editor);
		try {
			tui.start();
			await settle(term);
			expect(editor.focused).toBe(true);

			expect(tui.scrollViewportPages(-1)).toBe(true);
			await term.flush();
			expect(editor.focused).toBe(true);

			expect(tui.scrollViewportPages(1)).toBe(true);
			await term.flush();
			expect(editor.focused).toBe(true);
			expect(visible(term)).toEqual(["line-8", "line-9", "line-10", "line-11", "status", "editor"]);
		} finally {
			tui.stop();
		}
	});

	it("clears the output notice when auto-following at the bottom", async () => {
		const term = new VirtualTerminal(30, 6);
		const tui = new TUI(term);
		const transcript = new Lines(Array.from({ length: 12 }, (_value, index) => `line-${index}`));
		const status = new Lines(["status"]);
		const editor = new Lines(["editor"]);
		tui.addChild(transcript);
		tui.addChild(status);
		tui.addChild(editor);
		tui.setBottomPinnedComponent(status);
		tui.setViewportOutputSource({ identity: "assistant", revision: 0n });
		try {
			tui.start();
			await settle(term);
			// capacity 4, maxViewportTop 8; PageUp lands at 5.
			expect(tui.scrollViewportPages(-1)).toBe(true);
			await term.flush();

			// The notice drops capacity to 3 and raises maxViewportTop to 9.
			tui.setViewportOutputSource({ identity: "assistant", revision: 1n });
			await settle(term);
			expect(visible(term)).toContain("New output — type to follow");

			// First PageDown (step 2) reaches 7 — still below the notice-adjusted bottom.
			expect(tui.scrollViewportPages(1)).toBe(true);
			await term.flush();
			expect(visible(term)).toContain("New output — type to follow");

			// Second PageDown clamps to 9 == maxViewportTop and auto-follows live,
			// clearing the notice.
			expect(tui.scrollViewportPages(1)).toBe(true);
			await term.flush();
			expect(visible(term)).not.toContain("New output — type to follow");
			expect(visible(term)).toEqual(["line-8", "line-9", "line-10", "line-11", "status", "editor"]);
		} finally {
			tui.stop();
		}
	});

	it("appends new output through one live frontier without clearing scrollback after auto-follow", async () => {
		const term = new VirtualTerminal(30, 6, { isProcessTerminal: true });
		const tui = new TUI(term);
		const transcript = new Lines(Array.from({ length: 20 }, (_value, index) => `line-${index}`));
		tui.addChild(transcript);
		const previousWtSession = Bun.env.WT_SESSION;
		Bun.env.WT_SESSION = "test-windows-terminal-session";

		try {
			tui.start();
			await settle(term);
			expect(visible(term)).toEqual(["line-14", "line-15", "line-16", "line-17", "line-18", "line-19"]);

			expect(tui.scrollViewportPages(-1)).toBe(true);
			await term.flush();
			expect(visible(term)).toEqual(["line-9", "line-10", "line-11", "line-12", "line-13", "line-14"]);

			term.clearWriteLog();
			expect(tui.scrollViewportPages(1)).toBe(true);
			await term.flush();

			const followWrites = term.getWriteLog().join("");
			expect(followWrites).not.toContain("\x1b[2J\x1b[H");
			expect(followWrites).not.toContain("\x1b[3J");

			term.clearWriteLog();
			transcript.append("fresh-output");
			tui.requestRender();
			await settle(term);

			expect(visible(term)).toEqual(["line-15", "line-16", "line-17", "line-18", "line-19", "fresh-output"]);

			const appendWrites = term.getWriteLog().join("");
			expect(appendWrites).not.toContain("\x1b[2J\x1b[H");
			expect(appendWrites).not.toContain("\x1b[3J");
			expect(appendWrites).toContain("fresh-output");
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

describe("registered viewport anchor", () => {
	it("pages through excluded rows and reacquires transcript anchoring", async () => {
		const envKeys = [
			"SSH_CONNECTION",
			"TERM",
			"COLORTERM",
			"WT_SESSION",
			"TERM_PROGRAM",
			"TMUX",
			"TMUX_PANE",
			"STY",
			"ZELLIJ",
			"GJC_TMUX_LAUNCHED",
			"TERMUX_VERSION",
			"PI_TUI_LEGACY_MULTIPLEXER_FULL_RENDER",
			"PI_TUI_VIRTUAL_VIEWPORT",
		] as const;
		const previous = new Map<string, string | undefined>(envKeys.map(key => [key, Bun.env[key]]));
		for (const key of envKeys) delete Bun.env[key];
		Bun.env.SSH_CONNECTION = "203.0.113.10 54321 198.51.100.20 22";
		Bun.env.TERM = "xterm-256color";
		Bun.env.COLORTERM = "truecolor";
		const term = new VirtualTerminal(30, 6, { isProcessTerminal: true });
		const tui = new TUI(term);
		const transcript = new Lines(Array.from({ length: 12 }, (_value, index) => `transcript-${index}`));
		const transient = new Lines(Array.from({ length: 6 }, (_value, index) => `transient-${index}`));
		const synthetic = new Lines(Array.from({ length: 4 }, (_value, index) => `synthetic-${index}`));
		const pinned = new Lines(["status", "editor"]);
		tui.addChild(transcript);
		tui.addChild(transient);
		tui.addChild(synthetic);
		tui.addChild(pinned);
		tui.setViewportAnchorComponent(transcript);
		tui.setBottomPinnedComponent(pinned);
		try {
			tui.start();
			await settle(term);
			expect(tui.scrollViewportPages(-1)).toBe(true);
			await term.flush();
			expect(tui.scrollViewportPages(-1)).toBe(true);
			await term.flush();
			expect(visible(term)).toEqual([
				"transient-0",
				"transient-1",
				"transient-2",
				"transient-3",
				"status",
				"editor",
			]);
			term.clearWriteLog();
			expect(tui.scrollViewportPages(1)).toBe(true);
			await term.flush();
			expect(visible(term)).toEqual([
				"transient-3",
				"transient-4",
				"transient-5",
				"synthetic-0",
				"status",
				"editor",
			]);

			transient.setLine(3, "transient-3 live");
			tui.requestRender();
			await settle(term);
			expect(visible(term)).toEqual([
				"transient-3 live",
				"transient-4",
				"transient-5",
				"synthetic-0",
				"status",
				"editor",
			]);

			expect(tui.scrollViewportPages(-1)).toBe(true);
			await term.flush();
			expect(visible(term)).toEqual([
				"transient-0",
				"transient-1",
				"transient-2",
				"transient-3 live",
				"status",
				"editor",
			]);
			transcript.setLine(8, "transcript-8 final");
			term.clearWriteLog();
			transient.replace([]);
			synthetic.replace([]);
			tui.requestRender();
			await settle(term);
			expect(visible(term)).toEqual([
				"transcript-8 final",
				"transcript-9",
				"transcript-10",
				"transcript-11",
				"status",
				"editor",
			]);
			const writes = term.getWriteLog().join("");
			expect(writes).not.toContain("\x1b[2J\x1b[H");
			expect(writes).not.toContain("\x1b[3J");
			expect(writes).not.toContain("transcript-0");
			term.clearWriteLog();
			tui.requestRender();
			await settle(term);
			expect(visible(term)).toEqual([
				"transcript-8 final",
				"transcript-9",
				"transcript-10",
				"transcript-11",
				"status",
				"editor",
			]);
		} finally {
			tui.stop();
			for (const key of envKeys) {
				const value = previous.get(key);
				if (value === undefined) delete Bun.env[key];
				else Bun.env[key] = value;
			}
		}
	});

	it("emits authoritative emoji grapheme and cell spans from production Text wrapping", () => {
		const container = new Container();
		const text = new Text("\x1b[31m가가❤️👍🏽🙂e\u0301가\x1b[0m", 0, 0);
		container.addChild(text);
		container.setViewportAnchorSource(text, { id: "semantic-text" });
		const rendered = container.renderWithViewportAnchors(4);
		expect(rendered.lines.join("")).not.toContain("GJC_ANCHOR");
		expect(rendered.anchors).toEqual([
			{ id: "semantic-text", graphemeStart: 0, graphemeEnd: 2, cellStart: 0, cellEnd: 4 },
			{ id: "semantic-text", graphemeStart: 2, graphemeEnd: 4, cellStart: 4, cellEnd: 8 },
			{ id: "semantic-text", graphemeStart: 4, graphemeEnd: 6, cellStart: 8, cellEnd: 11 },
			{ id: "semantic-text", graphemeStart: 6, graphemeEnd: 7, cellStart: 11, cellEnd: 13 },
		]);
		expect(rendered.lines).toEqual(text.render(4));
	});

	it("explicitly excludes whitespace-only Text rows from semantic anchoring", () => {
		const container = new Container();
		const whitespace = new Text(" \t ", 0, 0);
		container.addChild(whitespace);
		container.setViewportAnchorSource(whitespace, { id: "blank" });
		expect(container.renderWithViewportAnchors(20)).toEqual({ lines: [], anchors: [] });
	});

	it("rejects malformed or non-provider anchor registrations", () => {
		const malformed: Component & { renderWithViewportAnchors(width: number): ViewportAnchorRender } = {
			render: () => ["unsafe"],
			renderWithViewportAnchors: () => ({ lines: ["unsafe"], anchors: [] }),
			invalidate: () => {},
		};
		expect(() => renderComponentWithViewportAnchors(malformed, 20)).toThrow("returned 0 anchors for 1 lines");
		const tui = new TUI(new VirtualTerminal(20, 4));
		expect(() => tui.setViewportAnchorComponent({ render: () => ["plain"], invalidate: () => {} })).toThrow(
			"must provide renderer-owned row metadata",
		);
	});

	it("does not strip or trust user-supplied anchor-like APC content", () => {
		const literalMarker = "\x1b_AGJC_ANCHOR:0:1:0:1\x1b\\";
		const container = new Container();
		const text = new Text(`${literalMarker}visible`, 0, 0);
		container.addChild(text);
		container.setViewportAnchorSource(text, { id: "literal-apc" });
		const rendered = container.renderWithViewportAnchors(80);
		expect(rendered.lines.join("")).toContain(literalMarker);
		expect(rendered.anchors.some(anchor => anchor?.id === "literal-apc")).toBe(true);
	});

	it("wraps Kitty-protocol anchored prose into bounded rows without marker leakage while a genuine Kitty line bypasses", () => {
		const previousProtocol = TERMINAL.imageProtocol;
		setTerminalImageProtocol(ImageProtocol.Kitty);
		try {
			// The anchor marker must never begin with (or contain) the Kitty graphics
			// prefix. Otherwise TERMINAL.isImageLine() misclassifies every annotated
			// prose row as an image line and skips wrapping (the #2012 regression).
			expect(VIEWPORT_ANCHOR_PREFIX.startsWith(ImageProtocol.Kitty)).toBe(false);
			expect(VIEWPORT_ANCHOR_PREFIX.includes(ImageProtocol.Kitty)).toBe(false);

			const width = 24;
			const prose = "the quick brown fox jumps over the lazy dog ".repeat(6).trim();
			// renderWithViewportAnchorSource runs the real annotate -> isImageLine-gated
			// wrap -> extract pipeline, which is exactly where the old marker collided.
			const rendered = new Markdown(prose, 0, 0, defaultMarkdownTheme).renderWithViewportAnchorSource(width, {
				id: "kitty-prose",
			});

			// Wrapping still happens under an active Kitty classification: many bounded rows.
			expect(rendered.lines.length).toBeGreaterThan(1);
			for (const line of rendered.lines) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(width);
				expect(TERMINAL.isImageLine(line)).toBe(false);
			}

			// Anchors stay row-aligned and carry the shared source id.
			expect(rendered.anchors.length).toBe(rendered.lines.length);
			expect(rendered.anchors.some(anchor => anchor?.id === "kitty-prose")).toBe(true);

			// No anchor marker (or stray Kitty prefix) leaks into the visible output.
			const joined = rendered.lines.join("");
			expect(joined).not.toContain(VIEWPORT_ANCHOR_PREFIX);
			expect(joined).not.toContain("GJC_ANCHOR");
			expect(joined).not.toContain(ImageProtocol.Kitty);

			// A genuine Kitty graphics line is still classified as an image and bypasses
			// wrapping: it survives the same pipeline verbatim as a single unwrapped row.
			const kittyImageLine = `${ImageProtocol.Kitty}f=100,a=T,t=d;${"QUJD".repeat(64)}\x1b\\`;
			expect(TERMINAL.isImageLine(kittyImageLine)).toBe(true);
			expect(kittyImageLine.length).toBeGreaterThan(width);
			const bypassed = new Markdown(kittyImageLine, 0, 0, defaultMarkdownTheme).renderWithViewportAnchorSource(
				width,
				{ id: "kitty-image" },
			);
			expect(bypassed.lines).toEqual([kittyImageLine]);
		} finally {
			setTerminalImageProtocol(previousProtocol);
		}
	});

	it("preserves a CJK emoji ANSI anchor across arbitrary repeated reflow", async () => {
		const term = new VirtualTerminal(80, 6);
		const tui = new TUI(term);
		const transcript = new AnchoredTranscript();
		for (let index = 0; index < 30; index++) {
			transcript.addRow(
				`prefix-${index}`,
				`\x1b[36m접두-${index}-가나다라마바사아자차카타파하🙂-display-width-prefix-reflow\x1b[0m`,
			);
		}
		transcript.addRow("target", "\x1b[35m가나다라마바사아자차카타파하🙂끝\x1b[0m");
		tui.addChild(transcript);
		tui.setViewportAnchorComponent(transcript);
		try {
			tui.start();
			await settle(term);
			expect(tui.revealViewportAnchor("target", "bottom")).toBe(true);
			await term.flush();
			expect(visible(term)[5]).toContain("끝");
			for (const width of [12, 80, 8, 80, 12]) {
				term.resize(width, 6);
				await settle(term);
				expect(visible(term)[5], `width=${width}`).toContain("끝");
			}
			tui.requestRender();
			await settle(term);
			expect(visible(term)[5]).toContain("끝");
		} finally {
			tui.stop();
		}
	});

	it("resolves duplicate rendered text by semantic identity", async () => {
		const term = new VirtualTerminal(30, 6);
		const tui = new TUI(term);
		const original = new AnchoredTranscript();
		for (let index = 0; index < 20; index++) {
			original.addRow(`row-${index}`, index === 10 ? "target-neighbor" : "duplicate");
		}
		tui.addChild(original);
		tui.setViewportAnchorComponent(original);
		try {
			tui.start();
			await settle(term);
			expect(tui.scrollViewportPages(-1)).toBe(true);
			await term.flush();
			expect(visible(term).slice(0, 2)).toEqual(["duplicate", "target-neighbor"]);

			const replacement = new AnchoredTranscript();
			for (let index = 0; index < 20; index++) replacement.addRow(`prefix-${index}`, "duplicate");
			replacement.addRow("row-9", "duplicate");
			replacement.addRow("row-10", "target-neighbor");
			for (let index = 11; index < 20; index++) replacement.addRow(`row-${index}`, "duplicate");
			tui.detachChild(original);
			tui.addChild(replacement);
			tui.setViewportAnchorComponent(replacement);
			tui.requestRender();
			await settle(term);
			expect(visible(term).slice(0, 2)).toEqual(["duplicate", "target-neighbor"]);
		} finally {
			tui.stop();
		}
	});

	it("preserves a production-wrapped anchor through resize loops and completion contraction", async () => {
		const envKeys = [
			"SSH_CONNECTION",
			"TERM",
			"COLORTERM",
			"WT_SESSION",
			"TERM_PROGRAM",
			"TMUX",
			"TMUX_PANE",
			"STY",
			"ZELLIJ",
			"GJC_TMUX_LAUNCHED",
			"TERMUX_VERSION",
			"PI_TUI_LEGACY_MULTIPLEXER_FULL_RENDER",
		] as const;
		const previous = new Map(envKeys.map(key => [key, Bun.env[key]]));
		try {
			for (const key of envKeys) delete Bun.env[key];
			Bun.env.SSH_CONNECTION = "10.0.0.1 50000 10.0.0.2 22";
			Bun.env.TERM = "xterm-256color";
			const term = new VirtualTerminal(30, 6, { isProcessTerminal: true });
			const tui = new TUI(term);
			const transcript = new AnchoredTranscript();
			for (let index = 0; index < 5; index++) {
				transcript.addRow(`prefix-${index}`, `접두-${index}-가나다라마바사🙂-production-wrap`);
			}
			transcript.addRow("target", "\x1b[35m가나다라마바사아자차카타파하🙂끝\x1b[0m");
			const transient = new Lines(["transient-0"]);
			const synthetic = new Lines(["synthetic-0"]);
			const pinned = new Lines(["status", "editor"]);
			tui.addChild(transcript);
			tui.addChild(transient);
			tui.addChild(synthetic);
			tui.addChild(pinned);
			tui.setViewportAnchorComponent(transcript);
			tui.setBottomPinnedComponent(pinned);
			try {
				tui.start();
				await settle(term);
				expect(visible(term).some(line => line.includes("끝"))).toBe(true);
				expect(tui.scrollViewportPages(1)).toBe(true);
				await term.flush();
				const targetScreenRow = visible(term).findIndex(line => line.includes("끝"));
				expect(targetScreenRow).toBeGreaterThanOrEqual(0);
				for (const width of [14, 70, 10, 30]) {
					term.resize(width, 6);
					await settle(term);
					expect(visible(term).some(line => line.includes("끝"))).toBe(true);
					expect(tui.revealViewportAnchor("target", "bottom")).toBe(true);
					await term.flush();
					let targetScreenRow = visible(term).findIndex(line => line.includes("끝"));
					expect(targetScreenRow).toBeGreaterThanOrEqual(0);
					for (const width of [14, 70, 10, 30]) {
						term.resize(width, 6);
						await settle(term);
						targetScreenRow = visible(term).findIndex(line => line.includes("끝"));
						expect(targetScreenRow, `width=${width}`).toBeGreaterThanOrEqual(0);
						expect(visible(term)[targetScreenRow], `width=${width}`).toContain("끝");
					}
				}
				term.clearWriteLog();
				transient.replace([]);
				synthetic.replace([]);
				tui.requestRender();
				await settle(term);
				const finalTargetScreenRow = visible(term).findIndex(line => line.includes("끝"));
				expect(finalTargetScreenRow).toBeGreaterThanOrEqual(0);
				expect(visible(term)[finalTargetScreenRow]).toContain("끝");
				const writes = term.getWriteLog().join("");
				expect(writes).not.toContain("\x1b[2J\x1b[H");
				expect(writes).not.toContain("\x1b[3J");
			} finally {
				tui.stop();
			}
		} finally {
			for (const [key, value] of previous) {
				if (value === undefined) delete Bun.env[key];
				else Bun.env[key] = value;
			}
		}
	});

	it("preserves a still-present semantic row after prefix scrollback eviction", async () => {
		const term = new VirtualTerminal(30, 6);
		const tui = new TUI(term);
		const transcript = new AnchoredTranscript();
		for (let index = 0; index < 40; index++) transcript.addRow(`history-${index}`, `history-${index}`);
		tui.addChild(transcript);
		tui.setViewportAnchorComponent(transcript);
		try {
			tui.start();
			await settle(term);
			expect(tui.scrollViewportPages(-1)).toBe(true);
			await term.flush();
			expect(visible(term)[0]).toBe("history-29");
			transcript.removeFirst(10);
			tui.requestRender();
			await settle(term);
			expect(visible(term)[0]).toBe("history-29");
			tui.requestRender();
			await settle(term);
			expect(visible(term)[0]).toBe("history-29");
		} finally {
			tui.stop();
		}
	});

	it("retains unresolved intent when the anchored object is deleted", async () => {
		const term = new VirtualTerminal(30, 6);
		const tui = new TUI(term);
		const transcript = new AnchoredTranscript();
		for (let index = 0; index < 20; index++) transcript.addRow(`history-${index}`, `history-${index}`);
		tui.addChild(transcript);
		tui.setViewportAnchorComponent(transcript);
		try {
			tui.start();
			await settle(term);
			expect(tui.scrollViewportPages(-1)).toBe(true);
			await term.flush();
			expect(visible(term)[0]).toBe("history-9");

			transcript.removeFirst(10);
			tui.requestRender();
			await settle(term);
			expect(visible(term)[0]).toBe("history-9");

			transcript.addRow("history-9", "history-9 restored");
			tui.requestRender();
			await settle(term);
			expect(visible(term)[0]).toBe("history-9 restored");
		} finally {
			tui.stop();
		}
	});

	it("follows the latest transcript after an unresolved anchor", async () => {
		const term = new VirtualTerminal(30, 6);
		const tui = new TUI(term);
		const transcript = new AnchoredTranscript();
		for (let index = 0; index < 20; index++) transcript.addRow(`history-${index}`, `history-${index}`);
		tui.addChild(transcript);
		tui.setViewportAnchorComponent(transcript);
		try {
			tui.start();
			await settle(term);
			expect(tui.scrollViewportPages(-1)).toBe(true);
			await term.flush();
			expect(visible(term)[0]).toBe("history-9");

			transcript.removeFirst(10);
			tui.requestRender();
			await settle(term);
			expect(visible(term)[0]).toBe("history-9");

			expect(tui.followLiveViewport()).toBe(true);
			await term.flush();
			expect(visible(term).at(-1)).toBe("history-19");
			expect(visible(term).some(line => line === "history-9")).toBe(false);
		} finally {
			tui.stop();
		}
	});

	it("tracks retained and replacement Kitty placements across unresolved follow-live", async () => {
		const originalProtocol = TERMINAL.imageProtocol;
		const originalCellDimensions = getCellDimensions();
		setCellDimensions({ widthPx: 10, heightPx: 10 });
		setTerminalImageProtocol(ImageProtocol.Kitty);
		resetKittyTransmissions();
		setKittyTransmitWriter(() => {});

		const term = new VirtualTerminal(30, 6);
		const tui = new TUI(term);
		const transcript = new AnchoredTranscript();
		for (let index = 0; index < 10; index++) transcript.addRow(`history-${index}`, `history-${index}`);
		transcript.addChild(
			new Image(
				"AA==",
				"image/png",
				{ fallbackColor: value => value },
				{ maxWidthCells: 4, maxHeightCells: 2 },
				{ widthPx: 20, heightPx: 20 },
			),
		);
		let firstLiveRow: Text | undefined;
		for (let index = 10; index < 20; index++) {
			const row = transcript.addRow(`history-${index}`, `history-${index}`);
			if (index === 10) firstLiveRow = row;
		}
		tui.addChild(transcript);
		tui.setViewportAnchorComponent(transcript);

		try {
			tui.start();
			await settle(term);
			expect(tui.revealViewportAnchor("history-9", "top")).toBe(true);
			await settle(term);
			const [retainedPlacement] = extractKittyPlacementReferences(term.getWriteLog().join(""));
			expect(retainedPlacement).toBeDefined();

			term.clearWriteLog();
			transcript.removeFirst(11);
			transcript.addChild(
				new Image(
					"AQ==",
					"image/png",
					{ fallbackColor: value => value },
					{ maxWidthCells: 4, maxHeightCells: 2 },
					{ widthPx: 20, heightPx: 20 },
				),
			);
			for (let index = 0; index < 4; index++) transcript.addRow(`tail-${index}`, `tail-${index}`);
			tui.requestRender();
			await settle(term);
			const retainedOutput = term.getWriteLog().join("");
			expect(retainedOutput).toContain(encodeKittyPlacementDelete(retainedPlacement!));
			expect(extractKittyPlacementReferences(retainedOutput)).toContainEqual(retainedPlacement);

			term.clearWriteLog();
			expect(tui.followLiveViewport()).toBe(true);
			await term.flush();
			const followedOutput = term.getWriteLog().join("");
			expect(followedOutput).toContain(encodeKittyPlacementDelete(retainedPlacement!));
			const [replacementPlacement] = extractKittyPlacementReferences(followedOutput);
			expect(replacementPlacement).toBeDefined();
			expect(replacementPlacement?.imageId).not.toBe(retainedPlacement?.imageId);

			term.clearWriteLog();
			firstLiveRow!.setText("history-10 updated");
			transcript.addRow("tail-4", "tail-4");
			tui.requestRender();
			await settle(term);
			const grownOutput = term.getWriteLog().join("");
			expect(grownOutput).toContain(encodeKittyPlacementDelete(replacementPlacement!));
			expect(extractKittyPlacementReferences(grownOutput)).toEqual([]);
		} finally {
			tui.stop();
			setCellDimensions(originalCellDimensions);
			setTerminalImageProtocol(originalProtocol);
			resetKittyTransmissions();
			setKittyTransmitWriter(sequence => process.stdout.write(sequence));
		}
	});
	it("retains unresolved intent through provider removal and resolves a replacement", async () => {
		const term = new VirtualTerminal(30, 6);
		const tui = new TUI(term);
		const original = new AnchoredTranscript();
		for (let index = 0; index < 20; index++) original.addRow(`history-${index}`, `history-${index}`);
		tui.addChild(original);
		tui.setViewportAnchorComponent(original);
		try {
			tui.start();
			await settle(term);
			expect(tui.scrollViewportPages(-1)).toBe(true);
			await term.flush();
			expect(visible(term)[0]).toBe("history-9");

			tui.setViewportAnchorComponent(null);
			original.removeFirst(10);
			tui.requestRender();
			await settle(term);
			expect(visible(term)[0]).toBe("history-9");

			term.clearWriteLog();
			const unresolvedViewport = visible(term);
			expect(tui.scrollViewportPages(-1)).toBe(false);
			expect(tui.scrollViewportPages(1)).toBe(false);
			await term.flush();
			expect(visible(term)).toEqual(unresolvedViewport);
			expect(term.getWriteLog()).toEqual([]);

			const replacement = new AnchoredTranscript();
			for (let index = 0; index < 5; index++) replacement.addRow(`replacement-${index}`, `replacement-${index}`);
			for (let index = 10; index < 20; index++) replacement.addRow(`history-${index}`, `history-${index}`);
			tui.detachChild(original);
			tui.addChild(replacement);
			tui.setViewportAnchorComponent(replacement);
			tui.requestRender();
			await settle(term);
			expect(visible(term)[0]).toBe("history-9");

			term.clearWriteLog();
			expect(tui.scrollViewportPages(-1)).toBe(false);
			expect(tui.scrollViewportPages(1)).toBe(false);
			await term.flush();
			expect(term.getWriteLog()).toEqual([]);

			replacement.addRow("history-9", "history-9");
			tui.requestRender();
			await settle(term);
			expect(visible(term)[0]).toBe("history-9");
		} finally {
			tui.stop();
		}
	});
	it("resets stale manual intent when the transcript identity changes", async () => {
		const term = new VirtualTerminal(30, 6);
		const tui = new TUI(term);
		const transcriptA = new AnchoredTranscript();
		for (let index = 0; index < 20; index++) transcriptA.addRow(`session-a-${index}`, `session-a-${index}`);
		tui.addChild(transcriptA);
		tui.setViewportAnchorComponent(transcriptA);
		try {
			tui.start();
			await settle(term);
			expect(tui.scrollViewportPages(-1)).toBe(true);
			await term.flush();
			expect(visible(term).some(line => line.includes("session-a-"))).toBe(true);

			const transcriptB = new AnchoredTranscript();
			for (let index = 0; index < 8; index++) transcriptB.addRow(`session-b-${index}`, `session-b-${index}`);
			tui.resetViewportAnchorIntent();
			tui.detachChild(transcriptA);
			tui.addChild(transcriptB);
			tui.setViewportAnchorComponent(transcriptB);
			tui.requestRender();
			await settle(term);
			expect(visible(term).some(line => line.includes("session-b-"))).toBe(true);
			expect(visible(term).some(line => line.includes("session-a-"))).toBe(false);
		} finally {
			tui.stop();
		}
	});

	it("reconciles an evicted anchor to a surviving semantic neighbor after rebuild", async () => {
		const term = new VirtualTerminal(30, 6);
		const tui = new TUI(term);
		const transcript = new AnchoredTranscript();
		for (let index = 0; index < 20; index++) transcript.addRow(`history-${index}`, `history-${index}`);
		tui.addChild(transcript);
		tui.setViewportAnchorComponent(transcript);
		try {
			tui.start();
			await settle(term);
			expect(tui.scrollViewportPages(-1)).toBe(true);
			await term.flush();
			expect(visible(term)[0]).toBe("history-9");

			tui.prepareViewportAnchorForTranscriptRebuild();
			transcript.removeFirst(10);
			tui.requestRender();
			await settle(term);
			expect(visible(term).some(line => line === "history-10")).toBe(true);
			expect(visible(term).some(line => line === "history-9")).toBe(false);
		} finally {
			tui.stop();
		}
	});

	it("surfaces anchor render failures while retaining intent for recovery", async () => {
		const term = new VirtualTerminal(30, 6);
		const tui = new TUI(term);
		const transcript = new AnchoredTranscript();
		for (let index = 0; index < 10; index++) transcript.addRow(`history-${index}`, `history-${index}`);
		const recovering = new RecoveringText("history-10", 0, 0);
		transcript.addChild(recovering);
		transcript.setViewportAnchorSource(recovering, { id: "history-10" });
		for (let index = 11; index < 21; index++) transcript.addRow(`history-${index}`, `history-${index}`);
		tui.addChild(transcript);
		tui.setViewportAnchorComponent(transcript);
		try {
			tui.start();
			await settle(term);
			expect(tui.scrollViewportPages(-1)).toBe(true);
			await term.flush();
			expect(visible(term)).toContain("history-10");

			recovering.fail = true;
			tui.requestRender();
			await settle(term);
			expect(visible(term).some(line => line.includes("[render error: RecoveringText]"))).toBe(true);

			recovering.fail = false;
			tui.requestRender();
			await settle(term);
			expect(visible(term)).toContain("history-10");
		} finally {
			tui.stop();
		}
	});

	it("preserves manual completion anchors across supported terminal host paths", async () => {
		const envKeys = [
			"SSH_CONNECTION",
			"TERM",
			"COLORTERM",
			"WT_SESSION",
			"TERM_PROGRAM",
			"TMUX",
			"TMUX_PANE",
			"STY",
			"ZELLIJ",
			"GJC_TMUX_LAUNCHED",
			"TERMUX_VERSION",
			"PI_TUI_LEGACY_MULTIPLEXER_FULL_RENDER",
			"PI_TUI_VIRTUAL_VIEWPORT",
		] as const;
		const previous = new Map<string, string | undefined>(envKeys.map(key => [key, Bun.env[key]]));
		const cases = [
			{ label: "plain-ssh", env: { SSH_CONNECTION: "client server", TERM: "xterm-256color" } },
			{ label: "tmux-default", env: { TMUX: "/tmp/tmux,1,0", TERM: "tmux-256color" } },
			{
				label: "tmux-legacy",
				env: { TMUX: "/tmp/tmux,1,0", TERM: "tmux-256color", PI_TUI_LEGACY_MULTIPLEXER_FULL_RENDER: "1" },
			},
			{ label: "termux-height", env: { TERMUX_VERSION: "0.118", TERM: "xterm-256color" }, resizeHeight: 7 },
			{
				label: "windows-markers",
				env: { WT_SESSION: "forwarded", TERM_PROGRAM: "Windows_Terminal", TERM: "xterm-256color" },
			},
			{ label: "native-windows-selector", env: { TERM: "xterm-256color" }, nativeWindows: true },
		] as const;
		try {
			for (const testCase of cases) {
				for (const key of envKeys) delete Bun.env[key];
				Object.assign(Bun.env, testCase.env);
				if ("nativeWindows" in testCase) {
					expect(
						shouldUseViewportRepaintForHost({}, "win32", { includeNativeWindows: testCase.nativeWindows }),
					).toBe(true);
				}
				const term = new VirtualTerminal(30, 6, { isProcessTerminal: true });
				const tui = new TUI(term);
				const transcript = new Lines(Array.from({ length: 12 }, (_value, index) => `transcript-${index}`));
				const transient = new Lines(Array.from({ length: 6 }, (_value, index) => `transient-${index}`));
				const synthetic = new Lines(Array.from({ length: 4 }, (_value, index) => `synthetic-${index}`));
				const pinned = new Lines(["status", "editor"]);
				tui.addChild(transcript);
				tui.addChild(transient);
				tui.addChild(synthetic);
				tui.addChild(pinned);
				tui.setViewportAnchorComponent(transcript);
				tui.setBottomPinnedComponent(pinned);
				try {
					tui.start();
					await settle(term);
					expect(tui.scrollViewportPages(-1), `${testCase.label} page 1`).toBe(true);
					await term.flush();
					expect(tui.scrollViewportPages(-1), `${testCase.label} page 2`).toBe(true);
					await term.flush();
					if ("resizeHeight" in testCase) {
						term.resize(30, testCase.resizeHeight);
						await settle(term);
					}
					term.clearWriteLog();
					transcript.setLine(8, "transcript-8 final");
					transient.replace([]);
					synthetic.replace([]);
					tui.requestRender();
					await settle(term);
					const viewport = visible(term);
					const transcriptCapacity = Math.max(0, term.rows - 2);
					const expectedStart = 12 - transcriptCapacity;
					expect(viewport.slice(0, transcriptCapacity), testCase.label).toEqual(
						Array.from({ length: transcriptCapacity }, (_value, index) => {
							const transcriptIndex = expectedStart + index;
							return transcriptIndex === 8 ? "transcript-8 final" : `transcript-${transcriptIndex}`;
						}),
					);
					expect(viewport).toContain("status");
					expect(viewport).toContain("editor");
					expect(viewport.indexOf("status")).toBeLessThan(viewport.indexOf("editor"));
					const writes = term.getWriteLog().join("");
					expect(writes).not.toContain("\x1b[2J\x1b[H");
					expect(writes).not.toContain("\x1b[3J");
					expect(writes).not.toContain("transcript-0");
				} finally {
					tui.stop();
				}
			}
		} finally {
			for (const key of envKeys) {
				const value = previous.get(key);
				if (value === undefined) delete Bun.env[key];
				else Bun.env[key] = value;
			}
		}
	});
	it("writes only the new live frontier after following a manual viewport", async () => {
		const term = new VirtualTerminal(30, 5);
		const tui = new TUI(term);
		const transcript = new Lines(Array.from({ length: 10 }, (_value, index) => `frontier-${index}`));
		tui.addChild(transcript);
		try {
			tui.start();
			await settle(term);
			expect(tui.scrollViewportPages(-1)).toBe(true);
			await term.flush();
			transcript.append("frontier-manual-era");
			transcript.setLine(3, "frontier-mutated-manual-era");
			tui.requestRender();
			await settle(term);
			expect(tui.followLiveViewport()).toBe(true);
			await term.flush();
			term.clearWriteLog();

			transcript.append("frontier-live-once");
			tui.requestRender();
			await settle(term);
			const writes = term.getWriteLog().join("");
			const scrollback = term.getScrollBuffer().map(line => line.trim());
			const oldSentinels = [
				...Array.from({ length: 10 }, (_value, index) => `frontier-${index}`),
				"frontier-manual-era",
				"frontier-mutated-manual-era",
			];
			expect(writes.split("frontier-live-once")).toHaveLength(2);
			for (const sentinel of oldSentinels) expect(writes).not.toContain(sentinel);
			expect(writes).not.toContain("\x1b[2J");
			expect(writes).not.toContain("\x1b[3J");
			expect(writes).not.toContain("\x1b[H\x1b[0J");
			expect(scrollback.filter(line => line === "frontier-live-once")).toHaveLength(1);
			expect(scrollback.slice(-5)).toEqual([
				"frontier-7",
				"frontier-8",
				"frontier-9",
				"frontier-manual-era",
				"frontier-live-once",
			]);
			expect(visible(term)).toEqual([
				"frontier-7",
				"frontier-8",
				"frontier-9",
				"frontier-manual-era",
				"frontier-live-once",
			]);
		} finally {
			tui.stop();
		}
	});

	// A terminal that reports `isProcessTerminal: false` has answered the
	// capability question. Platform identity is only a fallback for hosts that
	// cannot answer, so win32 must not promote such a terminal onto the
	// viewport-repaint path — doing so suppresses durable history replay and
	// leaves contracted rows behind as duplicates.
	it.each([
		{ label: "explicit process terminal", isProcessTerminal: true, expected: true },
		{ label: "explicit non-process terminal", isProcessTerminal: false, expected: false },
		{ label: "unreported capability", isProcessTerminal: undefined, expected: true },
	])("resolves the win32 viewport-repaint gate for an $label", ({ isProcessTerminal, expected }) => {
		expect(shouldUseViewportRepaintForTerminal(isProcessTerminal, {}, "win32")).toBe(expected);
	});

	it("keeps non-win32 hosts off the viewport-repaint path regardless of capability", () => {
		for (const isProcessTerminal of [false, undefined] as const) {
			expect(shouldUseViewportRepaintForTerminal(isProcessTerminal, {}, "linux")).toBe(false);
		}
		expect(shouldUseViewportRepaintForTerminal(true, {}, "linux")).toBe(true);
	});

	it("still honors explicit Windows Terminal markers for a non-process terminal", () => {
		expect(shouldUseViewportRepaintForTerminal(false, { WT_SESSION: "1" }, "win32")).toBe(true);
	});
});
