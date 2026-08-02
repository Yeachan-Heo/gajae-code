import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import {
	type Component,
	encodeKittyPlacementDelete,
	extractKittyPlacementReferences,
	getCellDimensions,
	Image,
	ImageProtocol,
	resetKittyTransmissions,
	setCellDimensions,
	setKittyTransmitWriter,
	setTerminalImageProtocol,
	TERMINAL,
	TUI,
} from "@gajae-code/tui";
import type { Terminal, TerminalAppearance } from "@gajae-code/tui/terminal";
import { visibleWidth } from "@gajae-code/tui/utils";
import { getDefaultTabWidth, setDefaultTabWidth } from "@gajae-code/utils";
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

	render(width: number): string[] {
		return this.#lines.map(line => line.slice(0, width));
	}
}

class RawMutableLinesComponent implements Component {
	#lines: string[];

	constructor(lines: string[]) {
		this.#lines = [...lines];
	}

	setLines(lines: string[]): void {
		this.#lines = [...lines];
	}

	invalidate(): void {}

	render(): string[] {
		return this.#lines;
	}
}
class SemanticMutableLinesComponent implements Component {
	#lines: string[];
	#anchorIds: Array<string | null>;

	constructor(lines: string[], anchorIds: Array<string | null>) {
		this.#lines = [...lines];
		this.#anchorIds = [...anchorIds];
	}

	setLines(lines: string[], anchorIds: Array<string | null>): void {
		this.#lines = [...lines];
		this.#anchorIds = [...anchorIds];
	}

	invalidate(): void {}

	render(): string[] {
		return [...this.#lines];
	}

	renderWithViewportAnchors(): {
		lines: string[];
		anchors: Array<{
			id: string;
			graphemeStart: number;
			graphemeEnd: number;
			cellStart: number;
			cellEnd: number;
		} | null>;
	} {
		let graphemeOffset = 0;
		let cellOffset = 0;
		const anchors = this.#lines.map((line, index) => {
			const id = this.#anchorIds[index];
			const graphemeCount = [...Bun.stripANSI(line)].length;
			const cellCount = Math.max(1, Bun.stringWidth(line));
			const anchor =
				id === null || id === undefined
					? null
					: {
							id,
							graphemeStart: graphemeOffset,
							graphemeEnd: graphemeOffset + graphemeCount,
							cellStart: cellOffset,
							cellEnd: cellOffset + cellCount,
						};
			graphemeOffset += graphemeCount + 1;
			cellOffset += cellCount;
			return anchor;
		});
		return { lines: [...this.#lines], anchors };
	}
}

class FaultingVirtualTerminal implements Terminal {
	#available = true;
	#writeFailureAt: number | undefined;
	#writes = 0;

	constructor(readonly terminal: VirtualTerminal) {}

	setWriteFailureAt(writeFailureAt: number | undefined): void {
		this.#writeFailureAt = writeFailureAt;
		if (writeFailureAt === undefined) this.#available = true;
	}

	get writeCount(): number {
		return this.#writes;
	}

	start(onInput: (data: string) => void, onResize: () => void): void {
		this.terminal.start(onInput, onResize);
	}

	stop(): void {
		this.terminal.stop();
	}

	drainInput(maxMs?: number, idleMs?: number): Promise<void> {
		return this.terminal.drainInput(maxMs, idleMs);
	}

	write(data: string): void {
		if (!this.#available || (this.#writeFailureAt !== undefined && this.#writes + 1 >= this.#writeFailureAt)) {
			this.#available = false;
			throw Object.assign(new Error("deterministic image repaint failure"), { code: "EIO" });
		}
		this.#writes += 1;
		this.terminal.write(data);
	}

	get available(): boolean {
		return this.#available;
	}

	get isProcessTerminal(): boolean | undefined {
		return this.terminal.isProcessTerminal;
	}

	get columns(): number {
		return this.terminal.columns;
	}

	get rows(): number {
		return this.terminal.rows;
	}

	get kittyProtocolActive(): boolean {
		return this.terminal.kittyProtocolActive;
	}

	get appearance(): TerminalAppearance | undefined {
		return this.terminal.appearance;
	}

	onAppearanceChange(callback: (appearance: TerminalAppearance) => void): void {
		this.terminal.onAppearanceChange(callback);
	}

	moveBy(lines: number): void {
		this.write(lines > 0 ? `\x1b[${lines}B` : `\x1b[${-lines}A`);
	}

	hideCursor(): void {
		this.write("\x1b[?25l");
	}

	showCursor(): void {
		this.write("\x1b[?25h");
	}

	clearLine(): void {
		this.write("\x1b[K");
	}

	clearFromCursor(): void {
		this.write("\x1b[J");
	}

	clearScreen(): void {
		this.write("\x1b[H\x1b[0J");
	}

	setTitle(title: string): void {
		this.write(`\x1b]0;${title}\x07`);
	}

	setProgress(active: boolean): void {
		this.write(active ? "\x1b]9;4;3\x07" : "\x1b]9;4;0;\x07");
	}
}

class StreamingImageTranscript implements Component {
	#revision = 0;
	#tailCount = 3;
	#image: Image;

	constructor(image: Image) {
		this.#image = image;
	}

	append(): void {
		this.#revision += 1;
		this.#tailCount += 1;
	}

	invalidate(): void {}

	render(width: number): string[] {
		return [`status-${this.#revision}`, ...this.#image.render(width), ...rows("tail-", this.#tailCount)];
	}
}
class WidthSensitiveComponent implements Component {
	#appendedRows: string[] = [];

	append(): void {
		this.appendRows("ordinary-new-row");
	}

	appendRows(...rowsToAppend: string[]): void {
		this.#appendedRows.push(...rowsToAppend);
	}

	invalidate(): void {}

	render(width: number): string[] {
		const historic = rows("historic-", 8);
		if (width >= 24) return this.#appendedRows.length > 0 ? [...historic, ...this.#appendedRows] : historic;

		const expanded = Array.from({ length: 8 }, (_value, index) => [`historic-${index}`, `wrapped-${index}`]).flat();
		return this.#appendedRows.length > 0 ? [...expanded, ...this.#appendedRows] : expanded;
	}
}
class StableGapAppendComponent implements Component {
	#appended = false;

	append(): void {
		this.#appended = true;
	}

	invalidate(): void {}

	render(width: number): string[] {
		if (width >= 24) {
			return this.#appended
				? ["old-row-0123456789", "old-row-abcdefghij", "new-row-0123456789"]
				: ["old-row-0123456789", "old-row-abcdefghij"];
		}
		const reflowed = ["old-row-012", "3456789", "old-row-abc", "defghij"];
		return this.#appended ? [...reflowed, "new-row-012", "append-cont"] : reflowed;
	}
}

class MutationAppendReflowComponent implements Component {
	#mutated = false;

	mutateAndAppend(): void {
		this.#mutated = true;
	}

	invalidate(): void {}

	render(width: number): string[] {
		if (width >= 24 || !this.#mutated) return ["alpha", "omega"];
		return ["xalpha", "changed", "omega", "new out", "put"];
	}
}

class ReflowableHeaderComponent implements Component {
	#status = 0;

	setStatus(status: number): void {
		this.#status = status;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const history = rows("history-", 8);
		if (width >= 24) return [`status-${this.#status}`, ...history];
		return [
			`status-${this.#status}`,
			...Array.from({ length: 8 }, (_value, index) => [`history-${index}`, `wrapped-${index}`]).flat(),
		];
	}
}

class CoalescedMutationAppendComponent implements Component {
	#status = "old-status";
	#appendedRows: string[] = [];

	setStatus(status: string): void {
		this.#status = status;
	}

	appendRows(...rowsToAppend: string[]): void {
		this.#appendedRows.push(...rowsToAppend);
	}

	invalidate(): void {}

	render(_width: number): string[] {
		return ["history-0", "history-1", this.#status, ...this.#appendedRows];
	}
}
class NonFinalMutationAppendComponent implements Component {
	#status = "old-status";
	#appendedRows: string[] = [];

	setStatus(status: string): void {
		this.#status = status;
	}

	appendRows(...rowsToAppend: string[]): void {
		this.#appendedRows.push(...rowsToAppend);
	}

	invalidate(): void {}

	render(_width: number): string[] {
		return [`${this.#status}`, "stable-row", ...this.#appendedRows];
	}
}
class WhitespaceReflowAppendComponent implements Component {
	#appended = false;

	append(): void {
		this.#appended = true;
	}

	invalidate(): void {}

	render(width: number): string[] {
		if (width >= 24) return ["A", " BC"];
		return this.#appended ? ["AB", "C", "NEW"] : ["A", " BC"];
	}
}
class InsertedPrefixReflowComponent implements Component {
	#appended = false;

	append(): void {
		this.#appended = true;
	}

	invalidate(): void {}

	render(width: number): string[] {
		if (width >= 24) return ["A", "B"];
		return this.#appended ? ["X", "A", "B", "NEW"] : ["A", "B"];
	}
}

class FinalWrappingStatusComponent implements Component {
	#status = "old";

	setStatus(status: string): void {
		this.#status = status;
	}

	invalidate(): void {}

	render(width: number): string[] {
		if (width >= 24) return ["history-0", "history-1", `status-${this.#status}`];
		return ["history-0", "history-1", `status-${this.#status}-part`, "status-continuation"];
	}
}

function rows(prefix: string, count: number): string[] {
	return Array.from({ length: count }, (_v, i) => `${prefix}${i}`);
}

async function settle(term: VirtualTerminal): Promise<void> {
	await new Promise<void>(resolve => process.nextTick(resolve));
	await Bun.sleep(1);
	await term.flush();
}

function visible(term: VirtualTerminal): string[] {
	return term.getViewport().map(line => line.trimEnd());
}

function countMatches(lines: string[], pattern: RegExp): number {
	let count = 0;
	for (const line of lines) {
		if (pattern.test(line)) count += 1;
	}
	return count;
}

describe("TUI terminal-state regressions", () => {
	let monotonicNow = 0;
	const hostEnvKeys = [
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
	let previousHostEnv = new Map<string, string | undefined>();
	// Keep TUI's 16ms render throttle deterministic without sleeping a real frame per render.

	beforeEach(() => {
		previousHostEnv = new Map(hostEnvKeys.map(key => [key, Bun.env[key]]));
		for (const key of hostEnvKeys) delete Bun.env[key];
		monotonicNow = 0;
		vi.spyOn(performance, "now").mockImplementation(() => {
			monotonicNow += 20;
			return monotonicNow;
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		for (const key of hostEnvKeys) {
			const value = previousHostEnv.get(key);
			if (value === undefined) delete Bun.env[key];
			else Bun.env[key] = value;
		}
	});

	describe("cursor + differential stability", () => {
		it("keeps stable output across repeated no-op renders", async () => {
			const term = new VirtualTerminal(40, 10);
			const tui = new TUI(term);
			const component = new MutableLinesComponent(["hello", "world", "stable"]);
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);
				const before = visible(term);

				for (let i = 0; i < 8; i++) {
					tui.requestRender();
					await settle(term);
				}

				expect(visible(term)).toEqual(before);
			} finally {
				tui.stop();
			}
		});

		it("updates only changed middle line without corrupting neighbors", async () => {
			const term = new VirtualTerminal(40, 10);
			const tui = new TUI(term);
			const component = new MutableLinesComponent(["AAA", "BBB", "CCC", "DDD", "EEE"]);
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);
				const before = visible(term);

				component.setLines(["AAA", "BBB", "XXX", "DDD", "EEE"]);
				tui.requestRender();
				await settle(term);

				const after = visible(term);
				expect(after[0]).toBe(before[0]);
				expect(after[1]).toBe(before[1]);
				expect(after[2]?.trim()).toBe("XXX");
				expect(after[3]).toBe(before[3]);
				expect(after[4]).toBe(before[4]);
			} finally {
				tui.stop();
			}
		});

		it("clears removed tail lines after shrink", async () => {
			const term = new VirtualTerminal(40, 10);
			const tui = new TUI(term);
			const component = new MutableLinesComponent(["A", "B", "C", "D", "E"]);
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);

				component.setLines(["A", "B"]);
				tui.requestRender();
				await settle(term);

				const viewport = visible(term);
				expect(viewport[0]?.trim()).toBe("A");
				expect(viewport[1]?.trim()).toBe("B");
				expect(viewport[2]?.trim()).toBe("");
				expect(viewport[3]?.trim()).toBe("");
				expect(viewport[4]?.trim()).toBe("");
			} finally {
				tui.stop();
			}
		});

		it("does not retain a duplicated row when streaming reflow pulls history back into the viewport", async () => {
			const term = new VirtualTerminal(64, 10, { isProcessTerminal: true });
			const tui = new TUI(term);
			const repeated = "이 요구사항은 작은 인증 변경이 아니라 제품 아키텍처 변경입니다.";
			const prefix = ["context-0", "context-1", "context-2", "context-3", "현재 PRD에 미치는 영향", repeated];
			const component = new MutableLinesComponent([...prefix, ...rows("initial-", 6)]);
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);
				expect(countMatches(visible(term), /제품 아키텍처 변경입니다/)).toBe(1);

				component.setLines([...prefix, ...rows("draft-", 14)]);
				tui.requestRender();
				await settle(term);
				expect(countMatches(term.getScrollBuffer(), /제품 아키텍처 변경입니다/)).toBe(1);

				component.setLines([...prefix, ...rows("reflowed-", 6)]);
				tui.requestRender();
				await settle(term);
				expect(countMatches(visible(term), /제품 아키텍처 변경입니다/)).toBe(1);

				component.setLines([...prefix, ...rows("final-", 18)]);
				tui.requestRender();
				await settle(term);

				expect(countMatches(term.getScrollBuffer(), /제품 아키텍처 변경입니다/)).toBe(1);
				expect(countMatches(term.getScrollBuffer(), /final-4/)).toBe(1);

				component.setLines([...prefix, ...rows("final-", 22)]);
				tui.requestRender();
				await settle(term);

				expect(countMatches(term.getScrollBuffer(), /제품 아키텍처 변경입니다/)).toBe(1);
				expect(countMatches(term.getScrollBuffer(), /final-8/)).toBe(1);
			} finally {
				tui.stop();
			}
		});

		it("removes a Kitty placement when sticky live viewport repaint moves its anchor into scrollback", async () => {
			const originalProtocol = TERMINAL.imageProtocol;
			const originalCellDimensions = getCellDimensions();
			setCellDimensions({ widthPx: 10, heightPx: 10 });
			setTerminalImageProtocol(ImageProtocol.Kitty);
			resetKittyTransmissions();
			setKittyTransmitWriter(() => {});

			const term = new VirtualTerminal(40, 6, { isProcessTerminal: true });
			const tui = new TUI(term);
			const transcript = new StreamingImageTranscript(
				new Image(
					"AA==",
					"image/png",
					{ fallbackColor: value => value },
					{ maxWidthCells: 4, maxHeightCells: 2 },
					{ widthPx: 20, heightPx: 20 },
				),
			);
			const composer = new MutableLinesComponent(["composer"]);
			tui.addChild(transcript);
			tui.addChild(composer);
			tui.setBottomPinnedComponent(composer);

			try {
				tui.start();
				await settle(term);
				const [placement] = extractKittyPlacementReferences(term.getWriteLog().join(""));
				expect(placement).toBeDefined();

				term.clearWriteLog();
				transcript.append();
				tui.requestRender();
				await settle(term);
				const liveOutput = term.getWriteLog().join("");
				expect(liveOutput).toContain(encodeKittyPlacementDelete(placement!));
				expect(extractKittyPlacementReferences(liveOutput)).toEqual([]);

				term.clearWriteLog();
				expect(tui.scrollViewportPages(-1)).toBe(true);
				await term.flush();
				expect(extractKittyPlacementReferences(term.getWriteLog().join(""))).toEqual([placement]);

				term.clearWriteLog();
				expect(tui.followLiveViewport()).toBe(true);
				await term.flush();
				const followedOutput = term.getWriteLog().join("");
				expect(followedOutput).toContain(encodeKittyPlacementDelete(placement!));
				expect(extractKittyPlacementReferences(followedOutput)).toEqual([]);
			} finally {
				tui.stop();
				setCellDimensions(originalCellDimensions);
				setTerminalImageProtocol(originalProtocol);
				resetKittyTransmissions();
				setKittyTransmitWriter(sequence => process.stdout.write(sequence));
			}
		});

		it("soft-deletes a same-row Kitty placement before differential replacement and replays without retransmit", async () => {
			const originalProtocol = TERMINAL.imageProtocol;
			const originalCellDimensions = getCellDimensions();
			const transmissions: string[] = [];
			setCellDimensions({ widthPx: 10, heightPx: 10 });
			setTerminalImageProtocol(ImageProtocol.Kitty);
			resetKittyTransmissions();
			setKittyTransmitWriter(sequence => transmissions.push(sequence));

			const image = new Image(
				"AA==",
				"image/png",
				{ fallbackColor: value => value },
				{ maxWidthCells: 4, maxHeightCells: 2 },
				{ widthPx: 20, heightPx: 20 },
			);
			const imageLines = image.render(40);
			const component = new RawMutableLinesComponent(["header", ...imageLines, "footer"]);
			const term = new VirtualTerminal(40, 8);
			const tui = new TUI(term);
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);
				const [placement] = extractKittyPlacementReferences(term.getWriteLog().join(""));
				expect(placement).toBeDefined();
				expect(transmissions).toHaveLength(1);

				term.clearWriteLog();
				component.setLines(["header", "replacement", "", "footer"]);
				tui.requestRender();
				await settle(term);
				const replacedOutput = term.getWriteLog().join("");
				const deleteSequence = encodeKittyPlacementDelete(placement!);
				expect(replacedOutput).toContain(deleteSequence);
				expect(replacedOutput.indexOf(deleteSequence)).toBeLessThan(replacedOutput.indexOf("\x1b[2K"));
				expect(extractKittyPlacementReferences(replacedOutput)).toEqual([]);

				term.clearWriteLog();
				component.setLines(["header", ...imageLines, "footer"]);
				tui.requestRender();
				await settle(term);
				expect(extractKittyPlacementReferences(term.getWriteLog().join(""))).toEqual([placement]);
				expect(transmissions).toHaveLength(1);
			} finally {
				tui.stop();
				setCellDimensions(originalCellDimensions);
				setTerminalImageProtocol(originalProtocol);
				resetKittyTransmissions();
				setKittyTransmitWriter(sequence => process.stdout.write(sequence));
			}
		});

		it("preserves the committed Kitty placement ledger when a differential paint fails", async () => {
			const originalProtocol = TERMINAL.imageProtocol;
			const originalCellDimensions = getCellDimensions();
			setCellDimensions({ widthPx: 10, heightPx: 10 });
			setTerminalImageProtocol(ImageProtocol.Kitty);
			resetKittyTransmissions();
			setKittyTransmitWriter(() => {});

			const image = new Image(
				"AA==",
				"image/png",
				{ fallbackColor: value => value },
				{ maxWidthCells: 4, maxHeightCells: 2 },
				{ widthPx: 20, heightPx: 20 },
			);
			const imageLines = image.render(40);
			const component = new RawMutableLinesComponent(["header", ...imageLines, "footer"]);
			const baseTerminal = new VirtualTerminal(40, 8);
			const terminal = new FaultingVirtualTerminal(baseTerminal);
			const tui = new TUI(terminal);
			tui.addChild(component);

			try {
				tui.start();
				await settle(baseTerminal);
				const [placement] = extractKittyPlacementReferences(baseTerminal.getWriteLog().join(""));
				expect(placement).toBeDefined();

				baseTerminal.clearWriteLog();
				terminal.setWriteFailureAt(terminal.writeCount + 1);
				component.setLines(["header", "replacement", "", "footer"]);
				tui.requestRender();
				await settle(baseTerminal);
				expect(baseTerminal.getWriteLog()).toEqual([]);

				terminal.setWriteFailureAt(undefined);
				baseTerminal.clearWriteLog();
				tui.start();
				await settle(baseTerminal);
				expect(baseTerminal.getWriteLog().join("")).toContain(encodeKittyPlacementDelete(placement!));
			} finally {
				tui.stop();
				setCellDimensions(originalCellDimensions);
				setTerminalImageProtocol(originalProtocol);
				resetKittyTransmissions();
				setKittyTransmitWriter(sequence => process.stdout.write(sequence));
			}
		});

		it("rolls back manual viewport ownership when the scroll repaint fails", async () => {
			const baseTerminal = new VirtualTerminal(30, 6);
			const terminal = new FaultingVirtualTerminal(baseTerminal);
			const tui = new TUI(terminal);
			tui.addChild(new MutableLinesComponent(rows("history-", 20)));

			try {
				tui.start();
				await settle(baseTerminal);
				terminal.setWriteFailureAt(terminal.writeCount + 1);
				expect(tui.scrollViewportPages(-1)).toBe(false);

				terminal.setWriteFailureAt(undefined);
				baseTerminal.clearWriteLog();
				tui.start();
				await settle(baseTerminal);
				expect(visible(baseTerminal)).toEqual(rows("history-", 20).slice(-6));
			} finally {
				tui.stop();
			}
		});

		it("soft-deletes and replays a Kitty placement across terminal resize", async () => {
			const originalProtocol = TERMINAL.imageProtocol;
			const originalCellDimensions = getCellDimensions();
			const transmissions: string[] = [];
			setCellDimensions({ widthPx: 10, heightPx: 10 });
			setTerminalImageProtocol(ImageProtocol.Kitty);
			resetKittyTransmissions();
			setKittyTransmitWriter(sequence => transmissions.push(sequence));

			const term = new VirtualTerminal(40, 8);
			const tui = new TUI(term, undefined, { widthSettleMs: 0 });
			tui.addChild(
				new Image(
					"AA==",
					"image/png",
					{ fallbackColor: value => value },
					{ maxWidthCells: 4, maxHeightCells: 2, refetch: () => "AA==" },
					{ widthPx: 20, heightPx: 20 },
				),
			);

			try {
				tui.start();
				await settle(term);
				const [placement] = extractKittyPlacementReferences(term.getWriteLog().join(""));
				expect(placement).toBeDefined();

				term.clearWriteLog();
				term.resize(30, 8);
				await settle(term);
				const resizedOutput = term.getWriteLog().join("");
				expect(resizedOutput).toContain(encodeKittyPlacementDelete(placement!));
				expect(extractKittyPlacementReferences(resizedOutput)).toEqual([placement]);
				expect(transmissions).toHaveLength(1);
			} finally {
				tui.stop();
				setCellDimensions(originalCellDimensions);
				setTerminalImageProtocol(originalProtocol);
				resetKittyTransmissions();
				setKittyTransmitWriter(sequence => process.stdout.write(sequence));
			}
		});

		it("cleans a partial Kitty span and replays it when manual navigation revisits the anchor", async () => {
			const originalProtocol = TERMINAL.imageProtocol;
			setTerminalImageProtocol(ImageProtocol.Kitty);
			const placement = "\x1b_Ga=p,i=301,p=302,c=2,r=3,C=1,q=2\x1b\\";
			const term = new VirtualTerminal(40, 5, { isProcessTerminal: true });
			const tui = new TUI(term, undefined, { widthSettleMs: 0 });
			tui.addChild(new RawMutableLinesComponent([placement, "", "", "tail-0", "tail-1"]));

			try {
				tui.start();
				await settle(term);
				term.clearWriteLog();
				term.resize(40, 4);
				await settle(term);
				const output = term.getWriteLog().join("");
				expect(output).toContain(encodeKittyPlacementDelete({ imageId: 301, placementId: 302, rows: 3 }));
				expect(extractKittyPlacementReferences(output)).toEqual([]);

				term.clearWriteLog();
				expect(tui.scrollViewportBy(-1)).toBe(true);
				await term.flush();
				expect(extractKittyPlacementReferences(term.getWriteLog().join(""))).toEqual([
					{ imageId: 301, placementId: 302, rows: 3 },
				]);
			} finally {
				tui.stop();
				setTerminalImageProtocol(originalProtocol);
			}
		});

		it("keeps an unchanged Kitty placement when unpin coalesces with an unrelated edit", async () => {
			const originalProtocol = TERMINAL.imageProtocol;
			const originalCellDimensions = getCellDimensions();
			setCellDimensions({ widthPx: 10, heightPx: 10 });
			setTerminalImageProtocol(ImageProtocol.Kitty);
			resetKittyTransmissions();
			setKittyTransmitWriter(() => {});

			const term = new VirtualTerminal(40, 3);
			const tui = new TUI(term);
			const transcript = new MutableLinesComponent(["body"]);
			const image = new Image(
				"AA==",
				"image/png",
				{ fallbackColor: value => value },
				{ maxWidthCells: 4, maxHeightCells: 2 },
				{ widthPx: 20, heightPx: 20 },
			);
			tui.addChild(transcript);
			tui.addChild(image);
			tui.setBottomPinnedComponent(image);

			try {
				tui.start();
				await settle(term);
				const [placement] = extractKittyPlacementReferences(term.getWriteLog().join(""));
				expect(placement).toBeDefined();

				term.clearWriteLog();
				tui.setBottomPinnedComponent(null);
				transcript.setLines(["changed"]);
				tui.requestRender();
				await settle(term);
				expect(term.getWriteLog().join("")).not.toContain(encodeKittyPlacementDelete(placement!));
			} finally {
				tui.stop();
				setCellDimensions(originalCellDimensions);
				setTerminalImageProtocol(originalProtocol);
				resetKittyTransmissions();
				setKittyTransmitWriter(sequence => process.stdout.write(sequence));
			}
		});

		it("cleans a formerly pinned placement when manual repaint adopts transcript geometry", async () => {
			const originalProtocol = TERMINAL.imageProtocol;
			const originalCellDimensions = getCellDimensions();
			setCellDimensions({ widthPx: 10, heightPx: 10 });
			setTerminalImageProtocol(ImageProtocol.Kitty);
			resetKittyTransmissions();
			setKittyTransmitWriter(() => {});

			const term = new VirtualTerminal(40, 6);
			const tui = new TUI(term);
			const transcript = new MutableLinesComponent(rows("history-", 10));
			const image = new Image(
				"AA==",
				"image/png",
				{ fallbackColor: value => value },
				{ maxWidthCells: 4, maxHeightCells: 2 },
				{ widthPx: 20, heightPx: 20 },
			);
			tui.addChild(transcript);
			tui.addChild(image);
			tui.setBottomPinnedComponent(image);

			try {
				tui.start();
				await settle(term);
				const [placement] = extractKittyPlacementReferences(term.getWriteLog().join(""));
				expect(placement).toBeDefined();
				expect(tui.scrollViewportPages(-1)).toBe(true);
				await term.flush();

				term.clearWriteLog();
				tui.setBottomPinnedComponent(null);
				await settle(term);
				expect(term.getWriteLog().join("")).not.toContain(encodeKittyPlacementDelete(placement!));

				term.clearWriteLog();
				expect(tui.scrollViewportBy(-1)).toBe(true);
				await term.flush();
				const output = term.getWriteLog().join("");
				expect(output).toContain(encodeKittyPlacementDelete(placement!));
				expect(extractKittyPlacementReferences(output)).toEqual([]);
			} finally {
				tui.stop();
				setCellDimensions(originalCellDimensions);
				setTerminalImageProtocol(originalProtocol);
				resetKittyTransmissions();
				setKittyTransmitWriter(sequence => process.stdout.write(sequence));
			}
		});

		it("replays every overlapping Kitty span after fixed-point differential expansion", async () => {
			const originalProtocol = TERMINAL.imageProtocol;
			setTerminalImageProtocol(ImageProtocol.Kitty);
			const placementA = "\x1b_Ga=p,i=101,p=102,c=2,r=2,C=1,q=2\x1b\\";
			const placementB = "\x1b_Ga=p,i=201,p=202,c=2,r=2,C=1,q=2\x1b\\";
			const component = new RawMutableLinesComponent([placementA, placementB, "old", "tail"]);
			const term = new VirtualTerminal(40, 6);
			const tui = new TUI(term);
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);
				term.clearWriteLog();
				component.setLines([placementA, placementB, "new", "tail"]);
				tui.requestRender();
				await settle(term);
				const output = term.getWriteLog().join("");
				expect(output).toContain(encodeKittyPlacementDelete({ imageId: 101, placementId: 102, rows: 2 }));
				expect(output).toContain(encodeKittyPlacementDelete({ imageId: 201, placementId: 202, rows: 2 }));
				expect(extractKittyPlacementReferences(output)).toEqual([
					{ imageId: 101, placementId: 102, rows: 2 },
					{ imageId: 201, placementId: 202, rows: 2 },
				]);
			} finally {
				tui.stop();
				setTerminalImageProtocol(originalProtocol);
			}
		});

		it("soft-deletes a high logical-row placement before forced full replay", async () => {
			const originalProtocol = TERMINAL.imageProtocol;
			const originalCellDimensions = getCellDimensions();
			setCellDimensions({ widthPx: 10, heightPx: 10 });
			setTerminalImageProtocol(ImageProtocol.Kitty);
			resetKittyTransmissions();
			setKittyTransmitWriter(() => {});

			const image = new Image(
				"AA==",
				"image/png",
				{ fallbackColor: value => value },
				{ maxWidthCells: 4, maxHeightCells: 2 },
				{ widthPx: 20, heightPx: 20 },
			);
			const initialLines = [...rows("history-", 18), ...image.render(40), "tail"];
			const component = new RawMutableLinesComponent(initialLines);
			const term = new VirtualTerminal(40, 6);
			const tui = new TUI(term);
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);
				const [placement] = extractKittyPlacementReferences(term.getWriteLog().join(""));
				expect(placement).toBeDefined();

				term.clearWriteLog();
				component.setLines([...rows("history-", 18), "replacement", "", "tail"]);
				tui.requestRender(true, "test.forced-image-removal");
				await settle(term);
				expect(term.getWriteLog().join("")).toContain(encodeKittyPlacementDelete(placement!));
			} finally {
				tui.stop();
				setCellDimensions(originalCellDimensions);
				setTerminalImageProtocol(originalProtocol);
				resetKittyTransmissions();
				setKittyTransmitWriter(sequence => process.stdout.write(sequence));
			}
		});

		it("soft-deletes Kitty placements on stop and restores them without retransmit on restart", async () => {
			const originalProtocol = TERMINAL.imageProtocol;
			const originalCellDimensions = getCellDimensions();
			const transmissions: string[] = [];
			setCellDimensions({ widthPx: 10, heightPx: 10 });
			setTerminalImageProtocol(ImageProtocol.Kitty);
			resetKittyTransmissions();
			setKittyTransmitWriter(sequence => transmissions.push(sequence));

			const term = new VirtualTerminal(40, 6);
			const tui = new TUI(term);
			tui.addChild(
				new Image(
					"AA==",
					"image/png",
					{ fallbackColor: value => value },
					{ maxWidthCells: 4, maxHeightCells: 2, refetch: () => "AA==" },
					{ widthPx: 20, heightPx: 20 },
				),
			);

			try {
				tui.start();
				await settle(term);
				const [placement] = extractKittyPlacementReferences(term.getWriteLog().join(""));
				expect(placement).toBeDefined();

				term.clearWriteLog();
				tui.stop();
				expect(term.getWriteLog().join("")).toContain(encodeKittyPlacementDelete(placement!));

				term.clearWriteLog();
				tui.start();
				await settle(term);
				expect(extractKittyPlacementReferences(term.getWriteLog().join(""))).toEqual([placement]);
				expect(transmissions).toHaveLength(1);
			} finally {
				tui.stop();
				setCellDimensions(originalCellDimensions);
				setTerminalImageProtocol(originalProtocol);
				resetKittyTransmissions();
				setKittyTransmitWriter(sequence => process.stdout.write(sequence));
			}
		});

		it("tracks and cleans a removed bottom-pinned Kitty placement", async () => {
			const originalProtocol = TERMINAL.imageProtocol;
			const originalCellDimensions = getCellDimensions();
			setCellDimensions({ widthPx: 10, heightPx: 10 });
			setTerminalImageProtocol(ImageProtocol.Kitty);
			resetKittyTransmissions();
			setKittyTransmitWriter(() => {});

			const term = new VirtualTerminal(40, 6);
			const tui = new TUI(term);
			const transcript = new MutableLinesComponent(["body"]);
			const pinnedImage = new Image(
				"AA==",
				"image/png",
				{ fallbackColor: value => value },
				{ maxWidthCells: 4, maxHeightCells: 2 },
				{ widthPx: 20, heightPx: 20 },
			);
			tui.addChild(transcript);
			tui.addChild(pinnedImage);
			tui.setBottomPinnedComponent(pinnedImage);

			try {
				tui.start();
				await settle(term);
				const [placement] = extractKittyPlacementReferences(term.getWriteLog().join(""));
				expect(placement).toBeDefined();

				term.clearWriteLog();
				tui.setBottomPinnedComponent(null);
				tui.detachChild(pinnedImage);
				tui.requestRender();
				await settle(term);
				expect(term.getWriteLog().join("")).toContain(encodeKittyPlacementDelete(placement!));
			} finally {
				tui.stop();
				setCellDimensions(originalCellDimensions);
				setTerminalImageProtocol(originalProtocol);
				resetKittyTransmissions();
				setKittyTransmitWriter(sequence => process.stdout.write(sequence));
			}
		});

		it("tracks and cleans a hidden Kitty image overlay", async () => {
			const originalProtocol = TERMINAL.imageProtocol;
			const originalCellDimensions = getCellDimensions();
			setCellDimensions({ widthPx: 10, heightPx: 10 });
			setTerminalImageProtocol(ImageProtocol.Kitty);
			resetKittyTransmissions();
			setKittyTransmitWriter(() => {});

			const term = new VirtualTerminal(40, 8);
			const tui = new TUI(term);
			tui.addChild(new MutableLinesComponent(["base-0", "base-1", "base-2", "base-3"]));

			try {
				tui.start();
				await settle(term);
				term.clearWriteLog();
				const overlay = tui.showOverlay(
					new Image(
						"AA==",
						"image/png",
						{ fallbackColor: value => value },
						{ maxWidthCells: 4, maxHeightCells: 2 },
						{ widthPx: 20, heightPx: 20 },
					),
					{ anchor: "center", width: 10 },
				);
				await settle(term);
				const [placement] = extractKittyPlacementReferences(term.getWriteLog().join(""));
				expect(placement).toBeDefined();

				term.clearWriteLog();
				overlay.hide();
				await settle(term);
				expect(term.getWriteLog().join("")).toContain(encodeKittyPlacementDelete(placement!));
			} finally {
				tui.stop();
				setCellDimensions(originalCellDimensions);
				setTerminalImageProtocol(originalProtocol);
				resetKittyTransmissions();
				setKittyTransmitWriter(sequence => process.stdout.write(sequence));
			}
		});

		it("re-enables native scrollback admission after transcript identity replacement", async () => {
			const term = new VirtualTerminal(40, 6, { isProcessTerminal: true });
			const tui = new TUI(term);
			const component = new MutableLinesComponent(rows("old-", 8));
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);
				component.setLines(rows("old-expanded-", 14));
				tui.requestRender();
				await settle(term);
				component.setLines(rows("old-contracted-", 8));
				tui.requestRender();
				await settle(term);

				tui.resetViewportAnchorIntent();
				const replacement = ["new-0", "new-1", "new-2", "new-sentinel", ...rows("new-tail-", 4)];
				component.setLines(replacement);
				tui.requestRender();
				await settle(term);
				term.clearWriteLog();
				component.setLines([...replacement, ...rows("new-growth-", 6)]);
				tui.requestRender();
				await settle(term);
				expect(term.getWriteLog().join("")).not.toContain("\x1b[3J");

				expect(countMatches(term.getScrollBuffer(), /new-sentinel/)).toBe(1);
			} finally {
				tui.stop();
			}
		});

		it("keeps scrollback admission suspended across a preserving forced contraction", async () => {
			Bun.env.TMUX = "1";
			Bun.env.PI_TUI_LEGACY_MULTIPLEXER_FULL_RENDER = "1";
			const term = new VirtualTerminal(48, 8, { isProcessTerminal: true });
			const tui = new TUI(term);
			const marker = "forced-reflow-marker";
			const prefix = ["a", "b", "c", marker];
			const component = new MutableLinesComponent([...prefix, ...rows("initial-", 6)]);
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);
				component.setLines([...prefix, ...rows("expanded-", 14)]);
				tui.requestRender();
				await settle(term);
				expect(countMatches(term.getScrollBuffer(), /forced-reflow-marker/)).toBe(1);

				component.setLines([...prefix, ...rows("contracted-", 6)]);
				tui.requestRender(true);
				await settle(term);
				component.setLines([...prefix, ...rows("regrown-", 18)]);
				tui.requestRender();
				await settle(term);

				expect(countMatches(term.getScrollBuffer(), /forced-reflow-marker/)).toBe(1);
				expect(countMatches(term.getScrollBuffer(), /regrown-6/)).toBe(1);
			} finally {
				tui.stop();
			}
		});

		it("uses the native committed frontier after manual viewport contraction", async () => {
			const term = new VirtualTerminal(40, 10, { isProcessTerminal: true });
			const tui = new TUI(term);
			const component = new MutableLinesComponent(rows("history-", 20));
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);
				component.setLines(rows("history-", 30));
				tui.requestRender();
				await settle(term);
				expect(countMatches(term.getScrollBuffer(), /history-12/)).toBe(1);
				expect(tui.scrollViewportPages(-1)).toBe(true);
				await term.flush();

				component.setLines(rows("history-", 20));
				tui.requestRender();
				await settle(term);
				component.setLines([...rows("history-", 20), ...rows("growth-", 14)]);
				tui.requestRender();
				await settle(term);
				expect(tui.followLiveViewport()).toBe(true);
				await term.flush();

				component.setLines([...rows("history-", 20), ...rows("growth-", 15)]);
				tui.requestRender();
				await settle(term);
				expect(visible(term)).toEqual(rows("growth-", 15).slice(-10));

				expect(countMatches(term.getScrollBuffer(), /history-12/)).toBe(1);
				expect(countMatches(term.getScrollBuffer(), /growth-0/)).toBe(1);
			} finally {
				tui.stop();
			}
		});

		it("does not re-emit an off-screen tool block that grows in place", async () => {
			const term = new VirtualTerminal(40, 10);
			const tui = new TUI(term);
			const component = new MutableLinesComponent([]);
			tui.addChild(component);

			try {
				tui.start();
				const history = rows("history-", 6);
				const chrome = rows("chrome-", 12);
				const block = (state: string, output: number) => [
					`tool-${state}-top`,
					"tool-command",
					"tool-output-label",
					...rows("tool-out-", output),
				];

				// Pending compact render, then the block grows in place while it sits
				// above the live viewport top (the bottom chrome keeps it off-screen).
				component.setLines([...history, "tool-pending-compact", ...chrome]);
				tui.requestRender();
				await settle(term);

				component.setLines([...history, ...block("partial", 0), ...chrome]);
				tui.requestRender();
				await settle(term);

				component.setLines([...history, ...block("done", 2), ...chrome]);
				tui.requestRender();
				await settle(term);

				const scrollback = term.getScrollBuffer();
				// The stale pending copies must not be stranded above the finished block,
				// and no chrome row may be committed twice.
				expect(countMatches(scrollback, /tool-pending-compact/)).toBe(0);
				expect(countMatches(scrollback, /tool-partial-top/)).toBe(0);
				expect(countMatches(scrollback, /tool-done-top/)).toBe(1);
				expect(countMatches(scrollback, /\bchrome-0\b/)).toBe(1);
				expect(countMatches(scrollback, /\bchrome-1\b/)).toBe(1);
				expect(visible(term)).toEqual(rows("chrome-", 12).slice(-10));
			} finally {
				tui.stop();
			}
		});

		for (const isProcessTerminal of [false, true]) {
			it(`does not re-emit an off-screen block whose boundary row repeats (isProcessTerminal=${isProcessTerminal})`, async () => {
				// The row at the committed frontier is byte-identical before and after the
				// insertion, so a single-row boundary check cannot see the shift.
				const term = new VirtualTerminal(40, 5, { isProcessTerminal });
				const tui = new TUI(term);
				const component = new MutableLinesComponent([
					"prefix",
					"block-old",
					"pre-2",
					"FILL",
					"FILL",
					...rows("old-", 5),
				]);
				tui.addChild(component);

				try {
					tui.start();
					await settle(term);

					component.setLines([
						"prefix",
						"block-new-0",
						"block-new-1",
						"pre-2",
						"FILL",
						"FILL",
						...rows("old-", 5),
					]);
					tui.requestRender();
					await settle(term);

					const scrollback = term.getScrollBuffer().map(line => line.trimEnd());
					// The insertion must not push a second copy of the committed FILL rows
					// into scrollback, and the new block must not be emitted twice.
					expect(countMatches(scrollback, /^FILL$/)).toBe(2);
					// A full render replays the frame, so it must reconstruct the block
					// exactly once; a viewport repaint paints it into the live region.
					expect(countMatches(scrollback, /^block-new-0$/)).toBe(isProcessTerminal ? 0 : 1);
					// A viewport repaint cannot retract the already committed stale row, but
					// it must never remain visible alongside its replacement.
					expect(visible(term)).toEqual(rows("old-", 5));
					expect(countMatches(scrollback, /^block-old$/)).toBeLessThanOrEqual(1);
				} finally {
					tui.stop();
				}
			});
		}

		// Repeated and blank rows make byte identity ambiguous, so an off-screen
		// insertion can leave the frontier row, a majority of rows, or every row it
		// is measured against looking unmoved. Each case duplicates a committed row
		// unless the displaced run is detected at its own offset.
		const ambiguousShiftCases = [
			{
				id: "a run of identical rows spans the frontier",
				before: ["p0", "p1", "p2", "p3", "p4", "SAME", "SAME", "keep-a", "keep-b", "keep-c"],
				after: ["p0", "p1", "INSERT", "p2", "p3", "p4", "SAME", "SAME", "keep-a", "keep-b", "keep-c", "APPEND"],
				duplicated: /^p4$/,
				limit: 1,
			},
			{
				id: "most visible rows still match at their own index",
				before: ["p0", "p1", "p2", "p3", "S", "S", "S", "X", "Y", "Z"],
				after: ["p0", "p1", "p2", "INSERT", "p3", "S", "S", "S", "X", "Y", "Z", "APPEND"],
				duplicated: /^S$/,
				limit: 3,
			},
			{
				id: "aligned and shifted readings are exactly tied",
				before: ["p0", "p1", "p2", "p3", "p4", "A", "A", "B", "B", "C"],
				after: ["p0", "p1", "INSERT", "p2", "p3", "p4", "A", "A", "B", "B", "C", "APPEND"],
				duplicated: /^p4$/,
				limit: 1,
			},
			{
				// Every measured row matches at its own index, so an alignment count
				// finds nothing wrong even though the frontier row moved.
				id: "the displaced rows below the frontier are identical",
				before: ["p0", "p1", "p2", "p3", "X", "A", "A", "A", "A", "A"],
				after: ["p0", "p1", "INSERT", "p2", "p3", "X", "A", "A", "A", "A", "A"],
				duplicated: /^X$/,
				limit: 1,
				appended: false,
			},
			{
				// The append is larger than the visible region, so a tolerance scaled to
				// the growth would permit the frame with no evidence at all.
				id: "the append is larger than the visible region",
				before: ["p0", "p1", "p2", "p3", "X", "A", "B", "C", "D", "E"],
				after: ["p0", "I", "p1", "p2", "p3", "X", "A", "B", "C", "D", "E", "Q0", "Q1", "Q2", "APPEND"],
				duplicated: /^X$/,
				limit: 1,
			},
		];
		for (const ambiguous of ambiguousShiftCases) {
			for (const isProcessTerminal of [false, true]) {
				it(`repaints an off-screen insertion when ${ambiguous.id} (isProcessTerminal=${isProcessTerminal})`, async () => {
					const term = new VirtualTerminal(40, 5, { isProcessTerminal });
					const tui = new TUI(term);
					const component = new MutableLinesComponent(ambiguous.before);
					tui.addChild(component);

					try {
						tui.start();
						await settle(term);

						component.setLines(ambiguous.after);
						tui.requestRender();
						await settle(term);

						const scrollback = term.getScrollBuffer().map(line => line.trimEnd());
						expect(countMatches(scrollback, ambiguous.duplicated)).toBeLessThanOrEqual(ambiguous.limit);
						if (ambiguous.appended !== false) expect(countMatches(scrollback, /^APPEND$/)).toBe(1);
						expect(visible(term)).toEqual(ambiguous.after.slice(-5));
					} finally {
						tui.stop();
					}
				});
			}
		}

		for (const isProcessTerminal of [false, true]) {
			it(`still commits when every visible row is rewritten in place (isProcessTerminal=${isProcessTerminal})`, async () => {
				// Nothing moves here: the off-screen row and all five visible rows are
				// substituted while one row is appended. Rejecting this as "unaligned"
				// would repaint and silently drop the first replacement row.
				const term = new VirtualTerminal(40, 5, { isProcessTerminal });
				const tui = new TUI(term);
				const component = new MutableLinesComponent(["status-0", ...rows("A", 5)]);
				tui.addChild(component);

				try {
					tui.start();
					await settle(term);

					component.setLines(["status-1", "B0", "B1", "B2", "B3", "A4", "APP"]);
					tui.requestRender();
					await settle(term);
					component.setLines(["status-1", "B0", "B1", "B2", "B3", "A4", "APP", "TAIL"]);
					tui.requestRender();
					await settle(term);

					const scrollback = term.getScrollBuffer().map(line => line.trimEnd());
					for (const row of ["B0", "B1", "APP"]) {
						expect(countMatches(scrollback, new RegExp(`^${row}$`)), `${row} exactly once`).toBe(1);
					}
					expect(visible(term)).toEqual(["B2", "B3", "A4", "APP", "TAIL"]);
				} finally {
					tui.stop();
				}
			});
		}
		for (const isProcessTerminal of [false, true]) {
			it(`still commits an append behind a run of repeated rows (isProcessTerminal=${isProcessTerminal})`, async () => {
				// Byte-wise this is indistinguishable from inserting a row above the
				// viewport: the repeated rows match at a shifted offset. Nothing moved
				// though, so repainting here would drop the top row from scrollback.
				const term = new VirtualTerminal(40, 5, { isProcessTerminal });
				const tui = new TUI(term);
				const component = new MutableLinesComponent(["status-0", "M", "M", "A", "A", "A"]);
				tui.addChild(component);

				try {
					tui.start();
					await settle(term);

					component.setLines(["status-1", "M", "M", "A", "A", "A", "A"]);
					tui.requestRender();
					await settle(term);
					component.setLines(["status-1", "M", "M", "A", "A", "A", "A", "T"]);
					tui.requestRender();
					await settle(term);

					const scrollback = term.getScrollBuffer().map(line => line.trimEnd());
					expect(countMatches(scrollback, /^M$/)).toBe(2);
					expect(countMatches(scrollback, /^A$/)).toBe(4);
					expect(visible(term)).toEqual(["M", "A", "A", "A", "A", "T"].slice(-5));
				} finally {
					tui.stop();
				}
			});
		}

		for (const isProcessTerminal of [false, true]) {
			it(`repaints a two-row off-screen insertion at a two-row frontier (isProcessTerminal=${isProcessTerminal})`, async () => {
				// Only offset 2 explains this frame, and it needs both committed rows to
				// re-enter the viewport, so it exercises the upper end of the offset scan.
				const term = new VirtualTerminal(40, 3, { isProcessTerminal });
				const tui = new TUI(term);
				const component = new MutableLinesComponent(["P0", "P1", "V0", "V1", "V2"]);
				tui.addChild(component);

				try {
					tui.start();
					await settle(term);

					component.setLines(["I0", "I1", "P0", "P1", "V0", "V1", "V2"]);
					tui.requestRender();
					await settle(term);

					const scrollback = term.getScrollBuffer().map(line => line.trimEnd());
					expect(countMatches(scrollback, /^P0$/)).toBe(1);
					expect(countMatches(scrollback, /^P1$/)).toBe(1);
					expect(visible(term)).toEqual(["V0", "V1", "V2"]);
				} finally {
					tui.stop();
				}
			});
		}

		it("still commits appended rows when an off-screen boundary row is substituted", async () => {
			// The mutated off-screen row is the last committed row, but nothing moves:
			// the appended rows must still reach native scrollback exactly once.
			const term = new VirtualTerminal(36, 6, { isProcessTerminal: true });
			const tui = new TUI(term);
			const status = new MutableLinesComponent(["status-0"]);
			const body = new MutableLinesComponent(rows("line-", 6));
			tui.addChild(status);
			tui.addChild(body);

			try {
				tui.start();
				await settle(term);

				for (let i = 1; i <= 6; i++) {
					status.setLines([`status-${i}`]);
					body.setLines(rows("line-", 6 + i));
					tui.requestRender();
					await settle(term);
				}

				const scrollback = term.getScrollBuffer().map(line => line.trimEnd());
				for (let i = 0; i < 12; i++) {
					expect(countMatches(scrollback, new RegExp(`^line-${i}$`)), `line-${i} exactly once`).toBe(1);
				}
				expect(visible(term)).toEqual(rows("line-", 12).slice(-6));
			} finally {
				tui.stop();
			}
		});

		it("repaints live viewport when overflowed content shrinks only at the tail", async () => {
			const term = new VirtualTerminal(20, 5);
			const tui = new TUI(term);
			const component = new MutableLinesComponent(rows("row-", 10));
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);
				expect(visible(term)).toEqual(["row-5", "row-6", "row-7", "row-8", "row-9"]);

				component.setLines(rows("row-", 8));
				tui.requestRender(false, "test.tail-shrink");
				await settle(term);

				expect(visible(term)).toEqual(["row-3", "row-4", "row-5", "row-6", "row-7"]);
			} finally {
				tui.stop();
			}
		});

		it("clears row 0 when content shrinks to empty", async () => {
			const term = new VirtualTerminal(40, 10);
			const tui = new TUI(term);
			const component = new MutableLinesComponent(["A"]);
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);

				component.setLines([]);
				tui.requestRender();
				await settle(term);

				const viewport = visible(term);
				expect(viewport[0]?.trim()).toBe("");
			} finally {
				tui.stop();
			}
		});

		describe("overflow contraction", () => {
			it("repaints a clean process terminal instead of clearing and replaying overflow history", async () => {
				Bun.env.SSH_CONNECTION = "203.0.113.10 54321 198.51.100.20 22";
				Bun.env.TERM = "xterm-256color";
				Bun.env.COLORTERM = "truecolor";
				Bun.env.PI_TUI_VIRTUAL_VIEWPORT = "1";
				const term = new VirtualTerminal(20, 5, { isProcessTerminal: true });
				const tui = new TUI(term);
				const component = new MutableLinesComponent(rows("line-", 12));
				tui.addChild(component);
				try {
					tui.start();
					await settle(term);
					term.clearWriteLog();
					component.setLines(rows("line-", 8));
					tui.requestRender();
					await settle(term);
					expect(visible(term)).toEqual(["line-3", "line-4", "line-5", "line-6", "line-7"]);
					expect(term.getWriteLog().join("")).not.toContain("\x1b[2J\x1b[H");
				} finally {
					tui.stop();
				}
			});
		});
		describe("forced render lifecycle", () => {
			it("does not replay an overflow transcript after a viewport-safe force and ordinary no-op", async () => {
				Bun.env.PI_TUI_VIRTUAL_VIEWPORT = "1";
				const term = new VirtualTerminal(24, 5, { isProcessTerminal: true });
				const tui = new TUI(term);
				const component = new MutableLinesComponent(rows("line-", 12));
				tui.addChild(component);

				try {
					tui.start();
					await settle(term);

					term.clearWriteLog();
					tui.requestRender(true, "test.overflow.force");
					await settle(term);

					term.clearWriteLog();
					tui.requestRender(false, "test.overflow.noop");
					await settle(term);

					const writes = term.getWriteLog().join("");
					expect(writes).not.toContain("line-0");
					expect(writes).not.toContain("\x1b[2J\x1b[H");

					const scrollback = term.getScrollBuffer();
					for (let i = 0; i < 12; i++) {
						expect(countMatches(scrollback, new RegExp(`\\bline-${i}\\b`))).toBe(1);
					}
				} finally {
					tui.stop();
				}
			});

			it("keeps the final stream row intact when the shell writes after a transient viewport paint", async () => {
				const term = new VirtualTerminal(32, 5, { isProcessTerminal: true });
				const tui = new TUI(term);
				const component = new MutableLinesComponent(rows("stream-", 8));
				tui.addChild(component);
				let stopped = false;

				try {
					tui.start();
					await settle(term);

					component.setLines([...rows("stream-", 9), "FINAL_STREAM_ROW"]);
					tui.requestRender(true, "test.transient.final-stream");
					await settle(term);

					tui.stop();
					stopped = true;
					term.write("SHELL_MARKER");
					await term.flush();

					const scrollback = term.getScrollBuffer().map(line => line.trim());
					const finalRow = scrollback.lastIndexOf("FINAL_STREAM_ROW");
					const shellMarker = scrollback.lastIndexOf("SHELL_MARKER");
					expect(finalRow).toBeGreaterThanOrEqual(0);
					expect(shellMarker).toBeGreaterThan(finalRow);
				} finally {
					if (!stopped) tui.stop();
				}
			});
		});
	});
	describe("render line cache bounds", () => {
		it("keeps normalization and truncation caches bounded for streaming unique lines", async () => {
			const term = new VirtualTerminal(40, 10);
			const tui = new TUI(term);
			const component = new MutableLinesComponent([]);
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);

				for (let i = 0; i < 10_000; i++) component.setLines([`stream-${i}-${"x".repeat(80)}`]);
				tui.requestRender();
				await settle(term);

				const stats = tui.getLineRenderCacheStats();
				expect(stats.normalizationSize).toBeLessThanOrEqual(stats.normalizationLimit);
				expect(stats.truncationSize).toBeLessThanOrEqual(stats.truncationLimit);
				expect(stats.normalizationLimit).toBe(2);
				expect(stats.truncationLimit).toBe(2);
			} finally {
				tui.stop();
			}
		});
		it("pads cached truncated wide text to erase a prior final cell", async () => {
			const term = new VirtualTerminal(4, 2);
			const tui = new TUI(term);
			const component = new RawMutableLinesComponent(["abcd"]);
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);

				component.setLines(["abc界"]);
				tui.requestRender();
				await settle(term);

				component.setLines(["abcd"]);
				tui.requestRender();
				await settle(term);

				component.setLines(["abc界"]);
				tui.requestRender();
				await settle(term);

				expect(term.getViewport()[0]).toBe("abc ");
			} finally {
				tui.stop();
			}
		});
	});

	describe("resize + viewport behavior", () => {
		it("preserves preexisting shell rows without startup clear", async () => {
			const term = new VirtualTerminal(50, 5, { isProcessTerminal: true });
			term.write("shell-0\r\nshell-1\r\nshell-2\r\nshell-3\r\nshell-4\r\n");
			await settle(term);
			term.clearWriteLog();

			const tui = new TUI(term);
			const component = new MutableLinesComponent(rows("ui-", 8));
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);

				term.resize(49, 5);
				await settle(term);

				const buffer = term.getScrollBuffer().join("\n");
				expect(buffer).toContain("shell-");
				const writes = term.getWriteLog().join("");
				expect(writes).not.toContain("\x1b[2J");
				expect(writes).not.toContain("\x1b[3J");
			} finally {
				tui.stop();
			}
		});

		it("retains the pre-render logical frame when a semantic viewport anchor disappears", async () => {
			const term = new VirtualTerminal(30, 4);
			const component = new SemanticMutableLinesComponent(
				["old-0", "old-1", "old-target", "old-3", "old-4", "old-5"],
				["old-0", "old-1", "target", "old-3", "old-4", "old-5"],
			);
			const tui = new TUI(term);
			tui.addChild(component);
			tui.setViewportAnchorComponent(component);

			try {
				tui.start();
				await settle(term);
				expect(tui.revealViewportAnchor("target", "center")).toBe(true);
				await settle(term);
				const retainedViewport = visible(term);

				component.setLines(
					["new-0", "new-1", "new-2", "new-3", "new-4", "new-5"],
					["new-0", "new-1", "new-2", "new-3", "new-4", "new-5"],
				);
				tui.requestRender();
				await settle(term);

				expect(visible(term)).toEqual(retainedViewport);
				tui.requestRender();
				await settle(term);
				expect(visible(term)).toEqual(retainedViewport);
			} finally {
				tui.stop();
			}
		});
		it("positions the stop cursor after the retained semantic viewport frame", async () => {
			const term = new VirtualTerminal(30, 4);
			const component = new SemanticMutableLinesComponent(
				["old-0", "old-1", "old-2", "old-target", "old-4", "old-5", "old-6", "old-7"],
				["old-0", "old-1", "old-2", "target", "old-4", "old-5", "old-6", "old-7"],
			);
			const tui = new TUI(term);
			tui.addChild(component);
			tui.setViewportAnchorComponent(component);

			tui.start();
			await settle(term);
			expect(tui.revealViewportAnchor("target", "center")).toBe(true);
			await settle(term);

			component.setLines(["hidden-0"], ["hidden-0"]);
			tui.requestRender();
			await settle(term);
			term.clearWriteLog();

			tui.stop();

			expect(term.getWriteLog().join("")).not.toMatch(/\x1b\[\d+A/);
		});
		it("fully repairs scrollback after a tab-width change", async () => {
			const originalTabWidth = getDefaultTabWidth();
			const term = new VirtualTerminal(16, 2, { isProcessTerminal: true });
			const tui = new TUI(term);
			tui.addChild(
				new MutableLinesComponent(["first\tcolumn", "second\tcolumn", "third\tcolumn", "fourth\tcolumn"]),
			);

			try {
				setDefaultTabWidth(2);
				tui.start();
				await settle(term);
				term.clearWriteLog();

				setDefaultTabWidth(8);
				await settle(term);

				expect(term.getWriteLog().join("")).toContain("\x1b[2J\x1b[H\x1b[3J");
			} finally {
				tui.stop();
				setDefaultTabWidth(originalTabWidth);
			}
		});
		it("copies the retained viewport frame while a semantic anchor is temporarily absent", async () => {
			const term = new VirtualTerminal(30, 4);
			const copied: string[] = [];
			const component = new SemanticMutableLinesComponent(
				["old-0", "old-1", "old-target", "old-3", "old-4", "old-5"],
				["old-0", "old-1", "target", "old-3", "old-4", "old-5"],
			);
			const tui = new TUI(term, undefined, {
				enableMouse: true,
				copySelection: text => {
					copied.push(text);
				},
			});
			tui.addChild(component);
			tui.setViewportAnchorComponent(component);

			try {
				tui.start();
				await settle(term);
				expect(tui.revealViewportAnchor("target", "center")).toBe(true);
				await settle(term);
				const retainedRow = visible(term)[0]!.slice(0, 5);

				component.setLines(
					["new-0", "new-1", "new-2", "new-3", "new-4", "new-5"],
					["new-0", "new-1", "new-2", "new-3", "new-4", "new-5"],
				);
				tui.requestRender();
				await settle(term);

				term.sendInput("\x1b[<0;1;1M");
				term.sendInput("\x1b[<32;5;1M");
				term.sendInput("\x1b[<0;5;1m");
				await settle(term);

				expect(copied).toEqual([retainedRow]);
			} finally {
				tui.stop();
			}
		});
		it("resizing width truncates visible lines without ghost wrap rows", async () => {
			const term = new VirtualTerminal(30, 6);
			const tui = new TUI(term);
			const component = new MutableLinesComponent([
				"012345678901234567890123456789012345",
				"ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890",
			]);
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);

				term.resize(16, 6);
				await settle(term);

				const viewport = visible(term);
				expect(viewport[0]!.length).toBeLessThanOrEqual(16);
				expect(viewport[1]!.length).toBeLessThanOrEqual(16);
				expect(viewport[2]?.trim()).toBe("");
			} finally {
				tui.stop();
			}
		});
		it("truncates compatibility jamo before the terminal can auto-wrap them", async () => {
			const term = new VirtualTerminal(10, 6);
			const tui = new TUI(term);
			const component = new MutableLinesComponent(["ㅁ".repeat(20)]);
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);

				const viewport = visible(term);
				expect(viewport[0]).toBe("ㅁ".repeat(5));
				expect(visibleWidth(viewport[0]!)).toBe(10);
				expect(viewport[1]?.trim()).toBe("");
			} finally {
				tui.stop();
			}
		});

		it("normalizes decomposed Korean jamo before terminal emission", async () => {
			const term = new VirtualTerminal(20, 6);
			const tui = new TUI(term);
			const decomposed = "한글 출력";
			const component = new MutableLinesComponent([decomposed]);
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);

				const viewport = visible(term);
				expect(viewport[0]).toBe("한글 출력");
				expect(viewport.join("\n")).not.toContain("ᄒ");
				expect(viewport.join("\n")).not.toContain("\\u");
			} finally {
				tui.stop();
			}
		});

		it("maintains exact viewport rows across repeated width reflow on sparse mixed content", async () => {
			const term = new VirtualTerminal(80, 18);
			const tui = new TUI(term);
			const lines = [
				"doesnt matter",
				"",
				"doesnt matter",
				"",
				"doesnt matter",
				"",
				"",
				"",
				"",
				"doesnt matter",
				"",
				"doesnt matter",
				"",
				"",
				"Operation aborted",
				"",
				"Operation aborted",
				"",
				"┌──────────────┐",
				"",
				"┌──────────────┐",
				"│              │",
				"┌──────────────┐",
				"│              │",
				"│ coding-agent │",
				"│              │",
				"│ coding-agent │",
				"┌──────────────┐",
				"│              │",
				"│ coding-agent │",
				"│              │",
				"└───────┬──────┘",
				"        │",
				"        │",
			];
			tui.addChild(new MutableLinesComponent(lines));

			const expectedViewport = (width: number, height: number): string[] => {
				const rendered = lines.map(line => line.slice(0, width));
				const top = Math.max(0, rendered.length - height);
				const viewport = rendered.slice(top, top + height);
				while (viewport.length < height) viewport.push("");
				return viewport.map(line => line.trimEnd());
			};

			try {
				tui.start();
				await settle(term);
				expect(visible(term)).toEqual(expectedViewport(80, 18));

				const widths = [72, 64, 56, 68, 52, 80];
				for (const width of widths) {
					term.resize(width, 18);
					await settle(term);
					expect(visible(term)).toEqual(expectedViewport(width, 18));
				}
			} finally {
				tui.stop();
			}
		});
		it("repaints width reflow without appending existing rows to scrollback", async () => {
			const term = new VirtualTerminal(24, 5, { isProcessTerminal: true });
			const tui = new TUI(term);
			const component = new MutableLinesComponent(rows("existing-", 8));
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);
				term.clearWriteLog();

				term.resize(16, 5);
				await settle(term);

				const writes = term.getWriteLog().join("");
				expect(writes).toContain("\x1b[?2026h\x1b[H");
				expect(writes).not.toContain("\r\n");
				expect(visible(term)).toEqual(["existing-3", "existing-4", "existing-5", "existing-6", "existing-7"]);
			} finally {
				tui.stop();
			}
		});
		it("repaints width reflow that increases row count without re-emitting historic rows", async () => {
			const term = new VirtualTerminal(24, 5, { isProcessTerminal: true });
			const tui = new TUI(term);
			tui.addChild(new WidthSensitiveComponent());

			try {
				tui.start();
				await settle(term);
				term.clearWriteLog();

				term.resize(16, 5);
				await settle(term);

				expect(visible(term)).toEqual(["wrapped-5", "historic-6", "wrapped-6", "historic-7", "wrapped-7"]);
				expect(term.getWriteLog().join("")).not.toContain("\r\n");

				const scrollback = term.getScrollBuffer();
				for (let i = 0; i < 8; i++) {
					expect(countMatches(scrollback, new RegExp(`\\bhistoric-${i}\\b`))).toBeLessThanOrEqual(1);
				}
			} finally {
				tui.stop();
			}
		});
		it("repaints an offscreen same-length mutation after width reflow growth without replaying history", async () => {
			const term = new VirtualTerminal(24, 5, { isProcessTerminal: true });
			const tui = new TUI(term);
			const component = new ReflowableHeaderComponent();
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);

				term.resize(16, 5);
				await settle(term);
				term.clearWriteLog();

				component.setStatus(1);
				tui.requestRender(false, "test.offscreen-reflow-header");
				await settle(term);

				expect(visible(term)).toEqual(["wrapped-5", "history-6", "wrapped-6", "history-7", "wrapped-7"]);
				const writes = term.getWriteLog().join("");
				expect(writes).not.toContain("\r\n");
				expect(writes).not.toContain("status-1");
				expect(writes).not.toContain("history-0");
				expect(writes).not.toContain("wrapped-0");

				const scrollback = term.getScrollBuffer();
				expect(countMatches(scrollback, /status-0/)).toBe(1);
				for (let i = 0; i < 8; i++) {
					expect(countMatches(scrollback, new RegExp(`\\bhistory-${i}\\b`))).toBeLessThanOrEqual(1);
				}
			} finally {
				tui.stop();
			}
		});
		it("records a successful full render as the next resize raw baseline", async () => {
			const term = new VirtualTerminal(24, 10);
			const tui = new TUI(term);
			const component = new WidthSensitiveComponent();
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);
				tui.requestRender(true, "test.full-render-baseline");
				await settle(term);
				term.clearWriteLog();

				term.resize(16, 10);
				component.append();
				tui.requestRender();
				await settle(term);

				const writes = term.getWriteLog().join("");
				expect(writes).toContain("ordinary-new-row");
				expect(countMatches(term.getScrollBuffer(), /ordinary-new-row/g)).toBe(1);
				for (let i = 0; i < 8; i++) {
					expect(countMatches(term.getScrollBuffer(), new RegExp(`\\bhistoric-${i}\\b`))).toBeLessThanOrEqual(1);
				}
			} finally {
				tui.stop();
			}
		});
		it("appends only the new row after a width reflow grows the rendered frame", async () => {
			const term = new VirtualTerminal(24, 10);
			const tui = new TUI(term);
			const component = new WidthSensitiveComponent();
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);

				term.resize(16, 10);
				await settle(term);
				term.clearWriteLog();

				component.append();
				tui.requestRender();
				await settle(term);

				const writes = term.getWriteLog().join("");
				expect(writes).toContain("ordinary-new-row");
				for (let i = 0; i < 8; i++) {
					expect(countMatches(term.getScrollBuffer(), new RegExp(`\\bhistoric-${i}\\b`))).toBeLessThanOrEqual(1);
				}
				expect(writes).not.toContain("historic-");
				expect(writes).not.toContain("wrapped-");
				expect(countMatches(term.getScrollBuffer(), /ordinary-new-row/g)).toBe(1);
			} finally {
				tui.stop();
			}
		});
		it("repaints newly exposed rows after transient width reflow before a height-only resize", async () => {
			const term = new VirtualTerminal(24, 10, { isProcessTerminal: true });
			const tui = new TUI(term);
			const component = new WidthSensitiveComponent();
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);

				term.resize(16, 10);
				await settle(term);
				term.clearWriteLog();

				term.resize(16, 14);
				await settle(term);

				const expected = Array.from({ length: 8 }, (_value, index) => [`historic-${index}`, `wrapped-${index}`])
					.flat()
					.slice(2);
				expect(visible(term)).toEqual(expected);
				const writes = term.getWriteLog().join("");
				expect(writes).toContain("historic-1");
				expect(writes).toContain("wrapped-1");
				expect(writes).not.toContain("\r\n");
			} finally {
				tui.stop();
			}
		});
		it("commits a row appended before the coalesced resize render without replaying reflow", async () => {
			const term = new VirtualTerminal(24, 10);
			const tui = new TUI(term);
			const component = new WidthSensitiveComponent();
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);
				term.clearWriteLog();

				term.resize(16, 10);
				component.append();
				tui.requestRender();
				await settle(term);

				const writes = term.getWriteLog().join("");
				expect(writes).toContain("ordinary-new-row");
				expect(countMatches(term.getScrollBuffer(), /ordinary-new-row/g)).toBe(1);
				for (let i = 0; i < 8; i++) {
					expect(countMatches(term.getScrollBuffer(), new RegExp(`\\bhistoric-${i}\\b`))).toBeLessThanOrEqual(1);
				}
				expect(visible(term).at(-1)?.trim()).toBe("ordinary-new-row");
				const beforeNoop = visible(term);

				term.clearWriteLog();
				tui.requestRender();
				await settle(term);

				expect(visible(term)).toEqual(beforeNoop);
				expect(term.getWriteLog().join("")).not.toContain("\r\n");
			} finally {
				tui.stop();
			}
		});
		it("does not treat repeated old status text as reflow evidence and commits coalesced tool output once", async () => {
			const term = new VirtualTerminal(24, 3);
			const tui = new TUI(term);
			const component = new CoalescedMutationAppendComponent();
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);
				term.clearWriteLog();

				term.resize(16, 3);
				component.setStatus("new-status");
				component.appendRows("old-status", "old-status", "tool-row");
				tui.requestRender();
				await settle(term);

				const writes = term.getWriteLog().join("");
				expect(writes).toContain("old-status");
				expect(writes).toContain("tool-row");
				expect(countMatches(term.getScrollBuffer(), /old-status/g)).toBe(2);
				expect(countMatches(term.getScrollBuffer(), /tool-row/g)).toBe(1);
				for (const row of ["history-0", "history-1"]) {
					expect(countMatches(term.getScrollBuffer(), new RegExp(`\\b${row}\\b`))).toBe(1);
				}
				const beforeNoop = visible(term);

				term.clearWriteLog();
				tui.requestRender();
				await settle(term);

				expect(visible(term)).toEqual(beforeNoop);
				expect(term.getWriteLog().join("")).not.toContain("\r\n");
				expect(countMatches(term.getScrollBuffer(), /tool-row/g)).toBe(1);
			} finally {
				tui.stop();
			}
		});
		it("repaints a non-final mutation before a coalesced resize append", async () => {
			const term = new VirtualTerminal(24, 4);
			const tui = new TUI(term);
			const component = new NonFinalMutationAppendComponent();
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);
				term.clearWriteLog();

				term.resize(16, 4);
				component.setStatus("new-status");
				component.appendRows("new-row");
				tui.requestRender();
				await settle(term);

				expect(visible(term).some(line => line.includes("new-status"))).toBe(true);
				expect(term.getWriteLog().join("")).toContain("new-row");
			} finally {
				tui.stop();
			}
		});
		it("repaints ANSI-only mutations before a coalesced resize append", async () => {
			const term = new VirtualTerminal(24, 4);
			const tui = new TUI(term);
			let append = false;
			const component: Component = {
				render: width => (width >= 24 || !append ? ["A", "\x1b[31mBC\x1b[0m"] : ["AB", "\x1b[32mC\x1b[0m", "NEW"]),
				invalidate: () => {},
			};
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);
				term.clearWriteLog();

				append = true;
				term.resize(16, 4);
				tui.requestRender();
				await settle(term);

				const writes = term.getWriteLog().join("");
				expect(writes).toContain("\x1b[32mC");
				expect(writes).toContain("NEW");
			} finally {
				tui.stop();
			}
		});
		it("repaints whitespace-sensitive reflow shifts before appending", async () => {
			const term = new VirtualTerminal(24, 4);
			const tui = new TUI(term);
			const component = new WhitespaceReflowAppendComponent();
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);
				term.clearWriteLog();

				term.resize(16, 4);
				component.append();
				tui.requestRender();
				await settle(term);

				expect(term.getScrollBuffer().some(line => line.trim() === "AB")).toBe(true);
				expect(term.getScrollBuffer().some(line => line.trim() === "C")).toBe(true);
				expect(term.getScrollBuffer().some(line => line.trim() === "NEW")).toBe(true);
			} finally {
				tui.stop();
			}
		});
		it("repaints Unicode-whitespace reflow shifts before appending", async () => {
			const term = new VirtualTerminal(24, 4);
			const tui = new TUI(term);
			let append = false;
			const component: Component = {
				render: width => (width >= 24 || !append ? ["A", "\u00a0BC"] : ["AB", "C", "NEW"]),
				invalidate: () => {},
			};
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);
				term.clearWriteLog();

				append = true;
				term.resize(16, 4);
				tui.requestRender();
				await settle(term);

				const scrollback = term.getScrollBuffer();
				for (const row of ["AB", "C", "NEW"]) {
					expect(scrollback.some(line => line.trim() === row)).toBe(true);
				}
			} finally {
				tui.stop();
			}
		});
		it("admits newly populated rows after a blank-frame resize", async () => {
			const term = new VirtualTerminal(24, 2, { isProcessTerminal: true });
			const tui = new TUI(term);
			const component = new MutableLinesComponent(["", ""]);
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);

				term.resize(16, 2);
				component.setLines(["X", "Y", "NEW"]);
				tui.requestRender();
				await settle(term);

				const scrollback = term.getScrollBuffer();
				for (const row of ["X", "Y", "NEW"]) {
					expect(scrollback.some(line => line.trim() === row)).toBe(true);
				}
			} finally {
				tui.stop();
			}
		});
		it("repaints inserted rows before a coalesced resize append", async () => {
			const term = new VirtualTerminal(24, 4);
			const tui = new TUI(term);
			const component = new InsertedPrefixReflowComponent();
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);
				term.clearWriteLog();

				term.resize(16, 4);
				component.append();
				tui.requestRender();
				await settle(term);

				for (const row of ["X", "A", "B", "NEW"]) {
					expect(term.getScrollBuffer().some(line => line.trim() === row)).toBe(true);
				}
			} finally {
				tui.stop();
			}
		});
		it("repaints an ambiguous final-row mutation instead of committing its reflow continuation", async () => {
			const term = new VirtualTerminal(24, 4, { isProcessTerminal: true });
			const tui = new TUI(term);
			const component = new FinalWrappingStatusComponent();
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);
				term.clearWriteLog();

				term.resize(16, 4);
				component.setStatus("new");
				tui.requestRender();
				await settle(term);

				expect(visible(term)).toEqual(["history-0", "history-1", "status-new-part", "status-continuat"]);
				const writes = term.getWriteLog().join("");
				expect(writes).not.toContain("\r\n");
				expect(writes).toContain("status-continuat");
			} finally {
				tui.stop();
			}
		});
		it("repaints a prefix-extending final-row mutation instead of committing its reflow continuation", async () => {
			const term = new VirtualTerminal(24, 4, { isProcessTerminal: true });
			const tui = new TUI(term);
			const component = new FinalWrappingStatusComponent();
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);
				term.clearWriteLog();

				term.resize(16, 4);
				component.setStatus("old-extended");
				tui.requestRender();
				await settle(term);

				const writes = term.getWriteLog().join("");
				expect(writes).not.toContain("\r\n");
				expect(writes).toContain("status-continuat");
			} finally {
				tui.stop();
			}
		});
		it("preserves the durable appended suffix when mutation precedes the resize event", async () => {
			const term = new VirtualTerminal(24, 10);
			const tui = new TUI(term);
			const component = new WidthSensitiveComponent();
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);
				term.clearWriteLog();

				component.append();
				tui.requestRender();
				term.resize(16, 10);
				await settle(term);

				const writes = term.getWriteLog().join("");
				expect(writes).toContain("ordinary-new-row");
				expect(countMatches(term.getScrollBuffer(), /ordinary-new-row/g)).toBe(1);
				expect(term.getScrollBuffer().at(-1)?.trim()).toBe("ordinary-new-row");
				for (let i = 0; i < 8; i++) {
					expect(countMatches(term.getScrollBuffer(), new RegExp(`\\bhistoric-${i}\\b`))).toBeLessThanOrEqual(1);
				}
				expect(visible(term).at(-1)?.trim()).toBe("ordinary-new-row");
			} finally {
				tui.stop();
			}
		});
		it("does not consume a singleton reflow gap before an appended row", async () => {
			const term = new VirtualTerminal(24, 2);
			const tui = new TUI(term);
			const component = new MutableLinesComponent(["ab", "cd"]);
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);
				term.clearWriteLog();

				term.resize(16, 2);
				component.setLines(["ab", "xx", "cd", "new"]);
				tui.requestRender();
				await settle(term);

				term.clearWriteLog();
				tui.requestRender();
				await settle(term);

				const scrollback = term.getScrollBuffer();
				expect(countMatches(scrollback, /\bnew\b/g)).toBe(1);
				for (const row of ["ab", "cd"]) {
					expect(countMatches(scrollback, new RegExp(`\\b${row}\\b`))).toBeLessThanOrEqual(1);
				}
			} finally {
				tui.stop();
			}
		});
		it("does not extrapolate a final-row reflow from earlier in-place insertions", async () => {
			const term = new VirtualTerminal(24, 3);
			const tui = new TUI(term);
			const component = new MutableLinesComponent(["a", "b", "c"]);
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);
				term.clearWriteLog();

				term.resize(16, 3);
				component.setLines(["a", "detail-a", "b", "detail-b", "c", "new output"]);
				tui.requestRender();
				await settle(term);

				tui.requestRender();
				await settle(term);

				const scrollback = term.getScrollBuffer();
				expect(countMatches(scrollback, /\bnew output\b/g)).toBe(1);
				for (const row of ["a", "detail-a", "b", "detail-b", "c"]) {
					expect(countMatches(scrollback, new RegExp(`\\b${row}\\b`))).toBeLessThanOrEqual(1);
				}
			} finally {
				tui.stop();
			}
		});
		it("retains the first wrapped appended row after a stable reflow gap", async () => {
			const term = new VirtualTerminal(24, 10);
			const tui = new TUI(term);
			const component = new StableGapAppendComponent();
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);
				term.clearWriteLog();

				term.resize(16, 10);
				component.append();
				tui.requestRender();
				await settle(term);

				const writes = term.getWriteLog().join("");
				for (const row of ["new-row-012", "append-cont"]) {
					expect(writes).toContain(row);
					expect(countMatches(term.getScrollBuffer(), new RegExp(`\\b${row}\\b`))).toBe(1);
				}
				for (const row of ["old-row-012", "old-row-abc", "3456789"]) {
					expect(countMatches(term.getScrollBuffer(), new RegExp(`\\b${row}\\b`))).toBeLessThanOrEqual(1);
				}
			} finally {
				tui.stop();
			}
		});
		it("preserves a mutation plus wrapped append across the following stable render", async () => {
			const term = new VirtualTerminal(24, 2);
			const tui = new TUI(term);
			const component = new MutationAppendReflowComponent();
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);
				term.clearWriteLog();

				term.resize(8, 2);
				component.mutateAndAppend();
				tui.requestRender();
				await settle(term);

				term.clearWriteLog();
				tui.requestRender();
				await settle(term);

				const scrollback = term.getScrollBuffer();
				expect(countMatches(scrollback, /new out/g)).toBe(1);
				expect(countMatches(scrollback, /put/g)).toBe(1);
			} finally {
				tui.stop();
			}
		});
		it("commits every row appended before the coalesced resize render without replaying reflow", async () => {
			const term = new VirtualTerminal(24, 10);
			const tui = new TUI(term);
			const component = new WidthSensitiveComponent();
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);
				term.clearWriteLog();

				term.resize(16, 10);
				component.appendRows("new-row-a", "new-row-b");
				tui.requestRender();
				await settle(term);

				const writes = term.getWriteLog().join("");
				for (const row of ["new-row-a", "new-row-b"]) {
					expect(writes).toContain(row);
					expect(countMatches(term.getScrollBuffer(), new RegExp(`\\b${row}\\b`))).toBe(1);
				}
				for (let i = 0; i < 8; i++) {
					expect(countMatches(term.getScrollBuffer(), new RegExp(`\\bhistoric-${i}\\b`))).toBeLessThanOrEqual(1);
				}
				expect(writes).not.toContain("historic-");
				expect(
					visible(term)
						.slice(-2)
						.map(line => line.trim()),
				).toEqual(["new-row-a", "new-row-b"]);
				const beforeNoop = visible(term);

				term.clearWriteLog();
				tui.requestRender();
				await settle(term);

				expect(visible(term)).toEqual(beforeNoop);
				expect(term.getWriteLog().join("")).not.toContain("\r\n");
			} finally {
				tui.stop();
			}
		});
		it("commits coalesced resize appends beyond the viewport exactly once", async () => {
			const term = new VirtualTerminal(24, 3);
			const tui = new TUI(term);
			const component = new WidthSensitiveComponent();
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);
				term.clearWriteLog();

				term.resize(16, 3);
				component.appendRows("resize-row-a", "resize-row-b", "resize-row-c", "resize-row-d");
				tui.requestRender();
				await settle(term);

				const scrollback = term.getScrollBuffer();
				for (const row of ["resize-row-a", "resize-row-b", "resize-row-c", "resize-row-d"]) {
					expect(term.getWriteLog().join("")).toContain(row);
					expect(countMatches(scrollback, new RegExp(`\\b${row}\\b`))).toBe(1);
				}

				tui.requestRender();
				await settle(term);
				for (const row of ["resize-row-a", "resize-row-b", "resize-row-c", "resize-row-d"]) {
					expect(countMatches(term.getScrollBuffer(), new RegExp(`\\b${row}\\b`))).toBe(1);
				}
			} finally {
				tui.stop();
			}
		});
		it("aggressive resize storm does not duplicate viewport content", async () => {
			const term = new VirtualTerminal(80, 18);
			const tui = new TUI(term);
			const lines = [
				"doesnt matter",
				"",
				"doesnt matter",
				"",
				"doesnt matter",
				"",
				"",
				"",
				"",
				"doesnt matter",
				"",
				"doesnt matter",
				"",
				"",
				"Operation aborted",
				"",
				"Operation aborted",
				"",
				"┌──────────────┐",
				"",
				"┌──────────────┐",
				"│              │",
				"┌──────────────┐",
				"│              │",
				"│ coding-agent │",
				"│              │",
				"│ coding-agent │",
				"┌──────────────┐",
				"│              │",
				"│ coding-agent │",
				"│              │",
				"└───────┬──────┘",
				"        │",
				"        │",
			];
			tui.addChild(new MutableLinesComponent(lines));

			const expectedViewport = (width: number, height: number): string[] => {
				const rendered = lines.map(line => line.slice(0, width));
				const top = Math.max(0, rendered.length - height);
				const viewport = rendered.slice(top, top + height);
				while (viewport.length < height) viewport.push("");
				return viewport.map(line => line.trimEnd());
			};

			try {
				tui.start();
				await settle(term);

				const sizes: Array<[number, number]> = [];
				for (let i = 0; i < 240; i++) {
					sizes.push([i % 2 === 0 ? 79 : 80, i % 3 === 0 ? 17 : 18]);
				}

				for (const [w, h] of sizes) {
					term.resize(w, h);
				}
				await settle(term);

				const [finalWidth, finalHeight] = sizes[sizes.length - 1]!;
				expect(visible(term)).toEqual(expectedViewport(finalWidth, finalHeight));
			} finally {
				tui.stop();
			}
		});
		it("height-only resize recovers from cursor drift without duplicate rows", async () => {
			const term = new VirtualTerminal(80, 18);
			const tui = new TUI(term);
			const lines = [
				"doesnt matter",
				"",
				"doesnt matter",
				"",
				"doesnt matter",
				"",
				"",
				"",
				"",
				"doesnt matter",
				"",
				"doesnt matter",
				"",
				"",
				"Operation aborted",
				"",
				"Operation aborted",
				"",
				"┌──────────────┐",
				"",
				"┌──────────────┐",
				"│              │",
				"┌──────────────┐",
				"│              │",
				"│ coding-agent │",
				"│              │",
				"│ coding-agent │",
				"┌──────────────┐",
				"│              │",
				"│ coding-agent │",
				"│              │",
				"└───────┬──────┘",
				"        │",
				"        │",
			];
			tui.addChild(new MutableLinesComponent(lines));

			const expectedViewport = (width: number, height: number): string[] => {
				const rendered = lines.map(line => line.slice(0, width));
				const top = Math.max(0, rendered.length - height);
				const viewport = rendered.slice(top, top + height);
				while (viewport.length < height) viewport.push("");
				return viewport.map(line => line.trimEnd());
			};

			try {
				tui.start();
				await settle(term);

				// Simulate terminal-managed cursor relocation during aggressive UI changes/resizes.
				// TUI's internal cursor row bookkeeping does not observe this external movement.
				term.write("\x1b[18;1H");
				await settle(term);

				term.resize(80, 17);
				await settle(term);

				expect(visible(term)).toEqual(expectedViewport(80, 17));
			} finally {
				tui.stop();
			}
		});
		it("streaming content under aggressive resize keeps a single consistent viewport", async () => {
			const term = new VirtualTerminal(80, 18);
			const tui = new TUI(term);
			const source = [
				"doesnt matter",
				"",
				"doesnt matter",
				"",
				"doesnt matter",
				"",
				"",
				"",
				"",
				"doesnt matter",
				"",
				"doesnt matter",
				"",
				"",
				"Operation aborted",
				"",
				"Operation aborted",
				"",
				"┌──────────────┐",
				"",
				"┌──────────────┐",
				"│              │",
				"┌──────────────┐",
				"│              │",
				"│ coding-agent │",
				"│              │",
				"│ coding-agent │",
				"┌──────────────┐",
				"│              │",
				"│ coding-agent │",
				"│              │",
				"└───────┬──────┘",
				"        │",
				"        │",
				"        ├─────────┬─────────┬────────┬──────┬──────────────┬──────────────┐",
				"        │         │         │        │      │              │              │",
				"        ▼         │         ▼        │      ▼              ▼              ▼",
				"┌──────────────┐  │  ┌────────────┐  │  ┌───────┐     ┌─────────┐     ┌───────┐",
				"│    agent     │  │  │    tui     │  │  │ utils │     │ natives │     │ stats │",
				"└───────┬──────┘  │  └──────┬─────┘  │  └───────┘     └────┬────┘     └───────┘",
				"        ├─────────┘         └────────┘                     │",
				"        ▼                                                  │",
				"┌──────────────┐     ┌────────────┐                        │",
				"│      ai      │     │ pi-natives │◄───────────────────────┘",
				"└──────────────┘     └────────────┘",
			];
			const working: string[] = [];
			const component = new MutableLinesComponent(working);
			tui.addChild(component);

			const expectedViewport = (width: number, height: number): string[] => {
				const rendered = working.map(line => line.slice(0, width));
				const top = Math.max(0, rendered.length - height);
				const viewport = rendered.slice(top, top + height);
				while (viewport.length < height) viewport.push("");
				return viewport.map(line => line.trimEnd());
			};

			try {
				tui.start();
				await settle(term);

				let nextLine = 0;
				let finalWidth = term.columns;
				let finalHeight = term.rows;
				for (let i = 0; i < 180; i++) {
					if (i % 3 === 0 && nextLine < source.length) {
						working.push(source[nextLine++]!);
						component.setLines(working);
					}

					finalWidth = i % 2 === 0 ? 79 : 80;
					finalHeight = i % 4 < 2 ? 17 : 18;
					term.resize(finalWidth, finalHeight);
					tui.requestRender();
					await settle(term);
				}

				expect(visible(term)).toEqual(expectedViewport(finalWidth, finalHeight));
			} finally {
				tui.stop();
			}
		});
		it("forced renders during resize storm stay stable under cursor relocation", async () => {
			const term = new VirtualTerminal(80, 18);
			const tui = new TUI(term);
			const lines = Array.from({ length: 40 }, (_v, i) => `row-${i}`);
			const component = new MutableLinesComponent(lines);
			tui.addChild(component);

			const expectedViewport = (width: number, height: number): string[] => {
				const rendered = lines.map(line => line.slice(0, width));
				const top = Math.max(0, rendered.length - height);
				const viewport = rendered.slice(top, top + height);
				while (viewport.length < height) viewport.push("");
				return viewport.map(line => line.trimEnd());
			};

			try {
				tui.start();
				await settle(term);

				let finalWidth = term.columns;
				let finalHeight = term.rows;
				for (let i = 0; i < 80; i++) {
					finalWidth = i % 2 === 0 ? 79 : 80;
					finalHeight = i % 3 === 0 ? 17 : 18;
					term.resize(finalWidth, finalHeight);
					term.write("\x1b[18;1H");
					tui.requestRender(true);
					await settle(term);
				}

				expect(visible(term)).toEqual(expectedViewport(finalWidth, finalHeight));
			} finally {
				tui.stop();
			}
		});
		it("shrink then grow keeps tail anchored to latest rows", async () => {
			const term = new VirtualTerminal(24, 6);
			const tui = new TUI(term);
			const component = new MutableLinesComponent(rows("row-", 30));
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);

				component.setLines(rows("row-", 16));
				tui.requestRender();
				await settle(term);

				component.setLines(rows("row-", 24));
				tui.requestRender();
				await settle(term);

				const viewport = visible(term).filter(line => line.trim().length > 0);
				expect(viewport).toHaveLength(6);
				expect(viewport[0]?.trim()).toBe("row-18");
				expect(viewport[5]?.trim()).toBe("row-23");
			} finally {
				tui.stop();
			}
		});
		it("mixed width/height resize storm keeps scrollback bounded for static content", async () => {
			const term = new VirtualTerminal(80, 18);
			const tui = new TUI(term);
			const lines = [
				"doesnt matter",
				"",
				"doesnt matter",
				"",
				"doesnt matter",
				"",
				"",
				"",
				"",
				"doesnt matter",
				"",
				"doesnt matter",
				"",
				"",
				"Operation aborted",
				"",
				"Operation aborted",
				"",
				"┌──────────────┐",
				"",
				"┌──────────────┐",
				"│              │",
				"┌──────────────┐",
				"│              │",
				"│ coding-agent │",
				"│              │",
				"│ coding-agent │",
				"┌──────────────┐",
				"│              │",
				"│ coding-agent │",
				"│              │",
				"└───────┬──────┘",
				"        │",
				"        │",
				"        ├─────────┬─────────┬────────┬──────┬──────────────┬──────────────┐",
				"        │         │         │        │      │              │              │",
				"        ▼         │         ▼        │      ▼              ▼              ▼",
				"┌──────────────┐  │  ┌────────────┐  │  ┌───────┐     ┌─────────┐     ┌───────┐",
				"│    agent     │  │  │    tui     │  │  │ utils │     │ natives │     │ stats │",
				"└───────┬──────┘  │  └──────┬─────┘  │  └───────┘     └────┬────┘     └───────┘",
				"        ├─────────┘         └────────┘                     │",
				"        ▼                                                  │",
				"┌──────────────┐     ┌────────────┐                        │",
				"│      ai      │     │ pi-natives │◄───────────────────────┘",
				"└──────────────┘     └────────────┘",
			];
			tui.addChild(new MutableLinesComponent(lines));

			try {
				tui.start();
				await settle(term);
				const before = term.getScrollBuffer().length;

				for (let i = 0; i < 220; i++) {
					term.resize(i % 2 === 0 ? 79 : 80, i % 3 === 0 ? 17 : 18);
					await settle(term);
				}

				const after = term.getScrollBuffer().length;
				expect(after - before).toBeLessThan(120);
			} finally {
				tui.stop();
			}
		}, 15_000);
	});

	describe("scrollback integrity", () => {
		it("repaints only the visible viewport for offscreen changes in tmux", async () => {
			const previousTmux = Bun.env.TMUX;
			Bun.env.TMUX = "1";

			const term = new VirtualTerminal(32, 5, { isProcessTerminal: true });
			const tui = new TUI(term);
			const lines = rows("line-", 80);
			const component = new MutableLinesComponent(lines);
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);
				const before = visible(term);

				term.clearWriteLog();
				const nextLines = [...lines];
				nextLines[0] = "updated-offscreen-header";
				component.setLines(nextLines);
				tui.requestRender();
				await settle(term);

				expect(visible(term)).toEqual(before);
				const writes = term.getWriteLog().join("");
				expect(writes).not.toContain("\x1b[3J");
				expect(writes).not.toContain("\x1b[2J");
				expect(writes).not.toContain("updated-offscreen-header");
				expect(writes).toContain("line-79");
			} finally {
				tui.stop();
				if (previousTmux === undefined) delete Bun.env.TMUX;
				else Bun.env.TMUX = previousTmux;
			}
		});

		it("refreshes newly visible rows after a tmux height increase", async () => {
			const previousTmux = Bun.env.TMUX;
			const previousLegacyMultiplexerFullRender = Bun.env.PI_TUI_LEGACY_MULTIPLEXER_FULL_RENDER;
			Bun.env.TMUX = "1";
			delete Bun.env.PI_TUI_LEGACY_MULTIPLEXER_FULL_RENDER;

			const term = new VirtualTerminal(32, 5, { isProcessTerminal: true });
			const tui = new TUI(term);
			const lines = rows("line-", 80);
			const component = new MutableLinesComponent(lines);
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);

				const nextLines = [...lines];
				nextLines[70] = "UPDATED-70";
				component.setLines(nextLines);
				tui.requestRender();
				await settle(term);
				expect(visible(term).join("\n")).not.toContain("UPDATED-70");

				term.clearWriteLog();
				term.resize(32, 12);
				await settle(term);

				const viewport = visible(term).join("\n");
				expect(viewport).toContain("UPDATED-70");
				expect(viewport).not.toContain("line-70");
				const writes = term.getWriteLog().join("");
				expect(writes).not.toContain("\x1b[3J");
				expect(writes).not.toContain("\x1b[2J");
				expect(writes).not.toContain("line-0");
				expect(writes).toContain("UPDATED-70");
			} finally {
				tui.stop();
				if (previousTmux === undefined) delete Bun.env.TMUX;
				else Bun.env.TMUX = previousTmux;
				if (previousLegacyMultiplexerFullRender === undefined) delete Bun.env.PI_TUI_LEGACY_MULTIPLEXER_FULL_RENDER;
				else Bun.env.PI_TUI_LEGACY_MULTIPLEXER_FULL_RENDER = previousLegacyMultiplexerFullRender;
			}
		});

		it("overflow content appears once across buffer without duplicate row IDs", async () => {
			const term = new VirtualTerminal(32, 5);
			const tui = new TUI(term);
			const component = new MutableLinesComponent(rows("line-", 10));
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);

				const all = term.getScrollBuffer();
				for (let i = 0; i < 10; i++) {
					const pattern = new RegExp(`\\bline-${i}\\b`);
					expect(countMatches(all, pattern), `line-${i} should appear exactly once`).toBe(1);
				}
			} finally {
				tui.stop();
			}
		});

		it("appending lines during aggressive resize does not duplicate history rows", async () => {
			const term = new VirtualTerminal(80, 18);
			const tui = new TUI(term);
			const lines: string[] = [];
			const component = new MutableLinesComponent(lines);
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);

				for (let i = 0; i < 140; i++) {
					lines.push(`line-${i}`);
					component.setLines(lines);
					term.resize(i % 2 === 0 ? 79 : 80, i % 3 === 0 ? 17 : 18);
					tui.requestRender();
					await settle(term);
				}

				const scrollback = term.getScrollBuffer();
				const duplicated: number[] = [];
				let presentCount = 0;
				for (let i = 0; i < 140; i++) {
					const pattern = new RegExp(`\\bline-${i}\\b`);
					const count = countMatches(scrollback, pattern);
					if (count > 0) presentCount += 1;
					if (count > 1) duplicated.push(i);
				}
				expect(presentCount).toBeGreaterThan(30);
				expect(duplicated).toEqual([]);
			} finally {
				tui.stop();
			}
		});

		it("retains append history when offscreen header changes during overflow growth", async () => {
			const term = new VirtualTerminal(32, 6);
			const tui = new TUI(term);
			const logLines = rows("line-", 6);
			let tick = 0;
			const component = new MutableLinesComponent([`status-${tick}`, ...logLines]);
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);

				for (let i = 6; i < 70; i++) {
					tick += 1;
					logLines.push(`line-${i}`);
					component.setLines([`status-${tick}`, ...logLines]);
					tui.requestRender();
					await settle(term);
				}

				const scrollback = term.getScrollBuffer();
				for (let i = 0; i < 70; i++) {
					expect(countMatches(scrollback, new RegExp(`\\bline-${i}\\b`))).toBe(1);
				}
				for (let i = 0; i <= tick; i++) {
					expect(countMatches(scrollback, new RegExp(`\\bstatus-${i}\\b`))).toBeLessThanOrEqual(1);
				}

				const viewport = visible(term).map(line => line.trim());
				expect(viewport.at(-1)).toBe("line-69");
				for (let i = 1; i < viewport.length; i++) {
					const prev = Number.parseInt(viewport[i - 1]!.slice(5), 10);
					const next = Number.parseInt(viewport[i]!.slice(5), 10);
					expect(next - prev).toBe(1);
				}
			} finally {
				tui.stop();
			}
		});
		it("keeps numbered streaming rows durable when offscreen history mutates during viewport repaint", async () => {
			const term = new VirtualTerminal(36, 6, { isProcessTerminal: true });
			const tui = new TUI(term);
			const history = new MutableLinesComponent(rows("history-", 8));
			const streamRows = ["stream-0"];
			const stream = new MutableLinesComponent(streamRows);
			const footer = new MutableLinesComponent(["FOOTER_MARKER"]);
			tui.addChild(history);
			tui.addChild(stream);
			tui.addChild(footer);

			try {
				tui.start();
				await settle(term);

				for (let i = 1; i <= 32; i++) {
					history.setLines([`history-mutated-${i}`, ...rows("history-", 7)]);
					streamRows.push(`stream-${i}`);
					stream.setLines(streamRows);
					term.clearWriteLog();
					tui.requestRender(false, "test.offscreen-history-stream");
					await settle(term);

					const writes = term.getWriteLog().join("");
					expect(writes).toContain("FOOTER_MARKER");
					expect(writes).not.toContain(`history-mutated-${i}`);

					const viewport = visible(term);
					expect(viewport.filter(line => line.trim() === "FOOTER_MARKER")).toHaveLength(1);

					const scrollback = term.getScrollBuffer();
					expect(scrollback.filter(line => line.trim() === "FOOTER_MARKER")).toHaveLength(1);
					for (const label of streamRows) {
						expect(
							scrollback.filter(line => line.trim() === label),
							`${label} should appear exactly once`,
						).toHaveLength(1);
					}
				}

				const scrollback = term.getScrollBuffer();
				let previousPosition = -1;
				for (const label of streamRows) {
					const position = scrollback.findIndex(line => line.trim() === label);
					expect(position).toBeGreaterThan(previousPosition);
					previousPosition = position;
				}
			} finally {
				tui.stop();
			}
		});
		it("repaints only the live viewport after a temporary non-manual restart", async () => {
			const term = new VirtualTerminal(32, 5, { isProcessTerminal: true });
			const tui = new TUI(term);
			tui.addChild(new MutableLinesComponent(rows("restart-", 20)));

			try {
				tui.start();
				await settle(term);
				term.clearWriteLog();

				tui.stop();
				term.clearWriteLog();
				tui.start();
				await settle(term);

				const writes = term.getWriteLog().join("");
				expect(writes).not.toContain("\r\n");
				expect(new Set(writes.match(/restart-\d+/g) ?? []).size).toBeLessThanOrEqual(term.rows);
			} finally {
				tui.stop();
			}
		});
		it("admits append-only rows produced while temporarily stopped before repainting", async () => {
			const term = new VirtualTerminal(32, 5, { isProcessTerminal: true });
			const tui = new TUI(term);
			const initialRows = rows("restart-", 20);
			const stoppedRows = rows("stopped-", 8);
			const component = new MutableLinesComponent(initialRows);
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);

				tui.stop();
				component.setLines([...initialRows, ...stoppedRows]);
				term.clearWriteLog();
				tui.start();
				await settle(term);

				const restartWrites = term.getWriteLog().join("");
				expect(restartWrites).not.toContain("restart-0");

				component.setLines([...initialRows, ...stoppedRows, "after-restart"]);
				tui.requestRender();
				await settle(term);

				const scrollback = term.getScrollBuffer();
				for (const row of [...stoppedRows, "after-restart"]) {
					expect(
						scrollback.filter(line => line.trim() === row),
						`${row} should appear exactly once`,
					).toHaveLength(1);
				}
			} finally {
				tui.stop();
			}
		});
		it("does not re-admit restart rows when the viewport repaint write fails", async () => {
			const backingTerminal = new VirtualTerminal(32, 5, { isProcessTerminal: true });
			const terminal = new FaultingVirtualTerminal(backingTerminal);
			const tui = new TUI(terminal);
			const initialRows = rows("restart-", 20);
			const stoppedRows = rows("stopped-", 8);
			const component = new MutableLinesComponent(initialRows);
			tui.addChild(component);

			try {
				tui.start();
				await settle(backingTerminal);

				tui.stop();
				component.setLines([...initialRows, ...stoppedRows]);
				tui.start();
				// start() has completed its synchronous terminal setup. Let the suffix
				// append succeed, then fail the following viewport paint.
				terminal.setWriteFailureAt(terminal.writeCount + 2);
				await settle(backingTerminal);
				expect(terminal.available).toBe(false);

				terminal.setWriteFailureAt(undefined);
				tui.start();
				await settle(backingTerminal);

				const scrollback = backingTerminal.getScrollBuffer();
				for (const row of stoppedRows) {
					expect(
						scrollback.filter(line => line.trim() === row),
						`${row} should be admitted once`,
					).toHaveLength(1);
				}
			} finally {
				tui.stop();
			}
		});
		it("does not append rows that regrow below the durable boundary after contraction", async () => {
			const term = new VirtualTerminal(32, 10);
			const tui = new TUI(term);
			const lines = rows("durable-", 8);
			const component = new MutableLinesComponent(lines);
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);

				component.setLines(lines.slice(0, 5));
				tui.requestRender(false, "test.contract");
				await settle(term);
				term.clearWriteLog();

				component.setLines(lines.slice(0, 7));
				tui.requestRender(false, "test.sub-durable-regrowth");
				await settle(term);

				const writes = term.getWriteLog().join("");
				expect(writes).not.toContain("\r\n");
				expect(visible(term).slice(0, 7)).toEqual([
					"durable-0",
					"durable-1",
					"durable-2",
					"durable-3",
					"durable-4",
					"durable-5",
					"durable-6",
				]);
			} finally {
				tui.stop();
			}
		});
		it("does not append width-reflowed rows that regrow below the durable boundary", async () => {
			const term = new VirtualTerminal(32, 5, { isProcessTerminal: true });
			const tui = new TUI(term);
			const original = ["prefix", `wide-${"x".repeat(40)}`, "tail"];
			const component = new RawMutableLinesComponent(original);
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);

				component.setLines(original.slice(0, 1));
				tui.requestRender(false, "test.contract-before-width-change");
				await settle(term);
				term.clearWriteLog();

				term.resize(16, 5);
				component.setLines(original);
				tui.requestRender(false, "test.width-regrowth");
				await settle(term);

				expect(term.getWriteLog().join("")).not.toContain("\r\n");
				expect(countMatches(term.getScrollBuffer(), /\btail\b/g)).toBe(1);
			} finally {
				tui.stop();
			}
		});
		it("rebases the durable frontier after a successful contraction replay before regrowth", async () => {
			const term = new VirtualTerminal(32, 3);
			const tui = new TUI(term);
			tui.setClearOnShrink(true);
			const initial = rows("history-", 8);
			const component = new MutableLinesComponent(initial);
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);

				const committed = ["changed-0", ...initial.slice(1)];
				component.setLines(committed);
				tui.requestRender(false, "test.establish-durable-frontier");
				await settle(term);

				component.setLines(committed.slice(0, 3));
				tui.requestRender(false, "test.full-render-contraction");
				await settle(term);
				term.clearWriteLog();

				component.setLines(committed.slice(0, 5));
				tui.requestRender(false, "test.regrow-after-full-render-contraction");
				await settle(term);

				const writes = term.getWriteLog().join("");
				expect(writes).toContain("\r\n");
				const scrollback = term.getScrollBuffer();
				expect(countMatches(scrollback, /\bhistory-3\b/g)).toBe(1);
				expect(countMatches(scrollback, /\bhistory-4\b/g)).toBe(1);
			} finally {
				tui.stop();
			}
		});
		it("durably appends distinct rows that replace the contracted suffix below the old high-water mark", async () => {
			const term = new VirtualTerminal(32, 5);
			const tui = new TUI(term);
			const originalRows = rows("durable-", 8);
			const component = new MutableLinesComponent(originalRows);
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);

				component.setLines(originalRows.slice(0, 5));
				tui.requestRender(false, "test.contract-distinct");
				await settle(term);
				term.clearWriteLog();

				component.setLines([...originalRows.slice(0, 5), "post-contract-0", "post-contract-1"]);
				tui.requestRender(false, "test.distinct-regrowth");
				await settle(term);

				const writes = term.getWriteLog().join("");
				expect(writes).not.toContain("durable-");
				expect(writes).toContain("post-contract-0");
				expect(writes).toContain("post-contract-1");
				expect(countMatches(term.getScrollBuffer(), /post-contract-0/g)).toBe(1);
				expect(countMatches(term.getScrollBuffer(), /post-contract-1/g)).toBe(1);
			} finally {
				tui.stop();
			}
		});
		it("restarts durable history ownership when replacing the transcript identity", async () => {
			const term = new VirtualTerminal(32, 5);
			const tui = new TUI(term);
			const component = new MutableLinesComponent(rows("old-", 24));
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);

				tui.resetViewportAnchorIntent();
				const successorRows = ["new-0", "new-1"];
				component.setLines(successorRows);
				tui.requestRender(false, "test.replace-identity");
				await settle(term);

				for (let i = 0; i < 8; i++) {
					component.setLines([...successorRows, ...rows("successor-", i + 1)]);
					tui.requestRender(false, "test.replace-identity.append");
					await settle(term);
				}

				const scrollback = term.getScrollBuffer().map(line => line.trim());
				expect(scrollback).toContain("successor-0");
				expect(scrollback).toContain("successor-1");
			} finally {
				tui.stop();
			}
		});

		it("strips component erase controls while retaining text for later renders", async () => {
			const term = new VirtualTerminal(40, 5);
			const tui = new TUI(term);
			const component = new MutableLinesComponent(["before\x1b[Kafter"]);
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);

				expect(visible(term)[0]?.trim()).toBe("beforeafter");
				expect(term.getWriteLog().join("")).not.toContain("\x1b[K");

				component.setLines(["next-safe-frame"]);
				term.clearWriteLog();
				tui.requestRender(false, "test.erase-followup");
				await settle(term);

				expect(visible(term)[0]?.trim()).toBe("next-safe-frame");
				expect(term.getWriteLog().join("")).toContain("next-safe-frame");
			} finally {
				tui.stop();
			}
		});
		it("drops incomplete CSI parameters from component output", async () => {
			const term = new VirtualTerminal(40, 5);
			const tui = new TUI(term);
			tui.addChild(new MutableLinesComponent(["before\x1b[31"]));

			try {
				tui.start();
				await settle(term);

				expect(visible(term)[0]?.trim()).toBe("before");
				expect(term.getWriteLog().join("")).not.toContain("before31");
			} finally {
				tui.stop();
			}
		});
		it("updates visible tail line when appending during overflow", async () => {
			const term = new VirtualTerminal(32, 5);
			const tui = new TUI(term);
			const lines = [...rows("line-", 7), "tail-0"];
			const component = new MutableLinesComponent(lines);
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);

				for (let tick = 1; tick <= 30; tick++) {
					lines[lines.length - 1] = `tail-${tick}`;
					lines.push(`new-${tick}`);
					component.setLines(lines);
					tui.requestRender();
					await settle(term);

					const viewport = visible(term).map(line => line.trim());
					const expectedViewport = lines.slice(Math.max(0, lines.length - term.rows)).map(line => line.trim());
					expect(viewport).toEqual(expectedViewport);
				}
			} finally {
				tui.stop();
			}
		});
		it("forced full redraws do not duplicate persistent content", async () => {
			const term = new VirtualTerminal(40, 5);
			const tui = new TUI(term);
			const component = new MutableLinesComponent(["alpha", "beta", "gamma"]);
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);

				for (let i = 0; i < 5; i++) {
					tui.requestRender(true);
					await settle(term);
				}

				const allText = term.getScrollBuffer().join("\n");
				expect((allText.match(/alpha/g) ?? []).length).toBe(1);
				expect((allText.match(/beta/g) ?? []).length).toBe(1);
				expect((allText.match(/gamma/g) ?? []).length).toBe(1);
			} finally {
				tui.stop();
			}
		});
	});

	describe("overlay compositing", () => {
		it("overlay show/hide restores underlying content", async () => {
			const term = new VirtualTerminal(40, 8);
			const tui = new TUI(term);
			const base = new MutableLinesComponent(rows("base-", 8));
			tui.addChild(base);

			try {
				tui.start();
				await settle(term);

				const handle = tui.showOverlay(new MutableLinesComponent(["OVERLAY-0", "OVERLAY-1"]), {
					anchor: "top-left",
					row: 2,
					col: 4,
				});
				await settle(term);

				expect(visible(term)[2]?.includes("OVERLAY-0")).toBeTruthy();
				expect(visible(term)[3]?.includes("OVERLAY-1")).toBeTruthy();

				handle.hide();
				await settle(term);

				const viewport = visible(term);
				expect(viewport[2]?.trim()).toBe("base-2");
				expect(viewport[3]?.trim()).toBe("base-3");
			} finally {
				tui.stop();
			}
		});
	});

	describe("stress scenarios", () => {
		it("rapid content mutations converge to final expected screen", async () => {
			const term = new VirtualTerminal(30, 8);
			const tui = new TUI(term);
			const component = new MutableLinesComponent(["init"]);
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);

				for (let i = 0; i < 80; i++) {
					const n = (i % 7) + 1;
					component.setLines(Array.from({ length: n }, (_v, j) => `iter-${i}-line-${j}`));
					tui.requestRender();
					await settle(term);
				}

				const expected = Array.from({ length: 3 }, (_v, j) => `iter-79-line-${j}`);
				const viewport = visible(term);
				expect(viewport[0]?.trim()).toBe(expected[0]);
				expect(viewport[1]?.trim()).toBe(expected[1]);
				expect(viewport[2]?.trim()).toBe(expected[2]);
				expect(viewport[3]?.trim()).toBe("");
			} finally {
				tui.stop();
			}
		});
	});
	describe("cursor escape sequences stay inside synchronized output blocks", () => {
		// Cursor placement sequences that must not leak outside \x1b[?2026h…\x1b[?2026l
		const CURSOR_SEQ = /\x1b\[\?(?:25[hl]|\d+[A-G])/g;
		const BSU = "\x1b[?2026h";
		const ESU = "\x1b[?2026l";

		function getWrites(term: VirtualTerminal): string[] {
			const writes: string[] = [];
			const originalWrite = term.write.bind(term);
			const spy = vi.spyOn(term, "write");
			spy.mockImplementation((data: string) => {
				writes.push(data);
				originalWrite(data);
			});
			return writes;
		}

		afterEach(() => {
			vi.restoreAllMocks();
		});

		it("all cursor sequences fall inside BSU/ESU brackets on full render", async () => {
			const term = new VirtualTerminal(40, 10);
			const tui = new TUI(term);
			const writes = getWrites(term);

			const component = new MutableLinesComponent(["hello", "world"]);
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);
				assertCursorSequencesInsideSyncBlocks(writes);
			} finally {
				tui.stop();
			}
		});

		it("all cursor sequences fall inside BSU/ESU brackets on differential render", async () => {
			const term = new VirtualTerminal(40, 10);
			const tui = new TUI(term);

			const component = new MutableLinesComponent(["AAA", "BBB", "CCC"]);
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);

				const writes = getWrites(term);
				component.setLines(["AAA", "XXX", "CCC"]);
				tui.requestRender();
				await settle(term);
				assertCursorSequencesInsideSyncBlocks(writes);
			} finally {
				tui.stop();
			}
		});

		it("all cursor sequences fall inside BSU/ESU brackets on deleted-lines render", async () => {
			const term = new VirtualTerminal(40, 10);
			const tui = new TUI(term);

			const component = new MutableLinesComponent(["A", "B", "C", "D"]);
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);

				const writes = getWrites(term);
				component.setLines(["A", "B"]);
				tui.requestRender();
				await settle(term);
				assertCursorSequencesInsideSyncBlocks(writes);
			} finally {
				tui.stop();
			}
		});

		it("all cursor sequences fall inside BSU/ESU brackets on repeated no-op renders", async () => {
			const term = new VirtualTerminal(40, 10);
			const tui = new TUI(term);

			const component = new MutableLinesComponent(["hello", "world", "stable"]);
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);

				const writes = getWrites(term);
				for (let i = 0; i < 4; i++) {
					tui.requestRender();
					await settle(term);
				}
				assertCursorSequencesInsideSyncBlocks(writes);
			} finally {
				tui.stop();
			}
		});

		/**
		 * Assert that every cursor escape sequence in every write call appears
		 * strictly between a matched BSU/ESU pair, or is the sole payload of a
		 * standalone hideCursor call (from a no-change path).
		 */
		function assertCursorSequencesInsideSyncBlocks(writes: string[]): void {
			for (const write of writes) {
				if (write === "\x1b[?25l") {
					// Standalone hideCursor — allowed (no-change path)
					continue;
				}
				// Walk through the write, tracking BSU/ESU nesting
				let depth = 0;
				let idx = 0;
				while (idx < write.length) {
					CURSOR_SEQ.lastIndex = idx;
					const match = CURSOR_SEQ.exec(write);
					if (!match) break;

					const matchIdx = match.index;
					// Count BSU/ESU depth up to the match position
					let scanIdx = idx;
					while (scanIdx < matchIdx) {
						if (write.startsWith(BSU, scanIdx)) {
							depth++;
							scanIdx += BSU.length;
						} else if (write.startsWith(ESU, scanIdx)) {
							depth--;
							scanIdx += ESU.length;
						} else {
							scanIdx++;
						}
					}

					expect(depth).toBeGreaterThan(0);

					idx = matchIdx + match[0].length;
				}
			}
		}
	});
});
