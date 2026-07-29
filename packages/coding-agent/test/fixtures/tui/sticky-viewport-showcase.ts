import { Container, Text, TUI } from "@gajae-code/tui";
import chalk from "chalk";
import { VirtualTerminal } from "../../../../tui/test/virtual-terminal";
import { CustomEditor } from "../../../src/modes/components/custom-editor";
import { getEditorTheme, initTheme, theme } from "../../../src/modes/theme/theme";

export const STICKY_VIEWPORT_SHOWCASE_KEYS = [
	"live-overflow/80x24/unicode-color",
	"live-overflow/120x36/unicode-color",
	"manual-history/80x24/unicode-color",
	"manual-history/120x36/unicode-color",
	"manual-new-output/80x24/unicode-color",
	"manual-new-output/120x36/unicode-color",
	"multiline-editor-hooks-pet/80x24/unicode-color",
	"multiline-editor-hooks-pet/120x36/unicode-color",
	"capacity-many/80x24/unicode-color",
	"capacity-many/120x36/unicode-color",
	"capacity-one/80x24/unicode-color",
	"capacity-one/120x36/unicode-color",
	"capacity-zero/80x24/unicode-color",
	"capacity-zero/120x36/unicode-color",
	"selection-boundary/80x24/unicode-color",
	"selection-boundary/120x36/unicode-color",
	"manual-new-output/80x24/ascii-no-color",
	"capacity-zero/48x10/ascii-no-color",
	"multiline-editor-hooks-pet/48x10/unicode-color",
	"narrow-cjk/48x10/unicode-color",
] as const;
export type StickyViewportShowcaseKey = (typeof STICKY_VIEWPORT_SHOWCASE_KEYS)[number];
export type StickyViewportShowcaseEntry = {
	key: StickyViewportShowcaseKey;
	stateId: string;
	viewport: { id: string; columns: number; rows: number };
	renderMode: "unicode-color" | "ascii-no-color";
};
export type StickyViewportShowcaseRender = {
	terminalText: string;
	terminalAnsiText: string;
	sourceRevision: string;
	outputRevision: string;
	cjkPhraseBoundaries: readonly string[];
	state: Record<string, unknown>;
};

export const STICKY_VIEWPORT_SHOWCASE_ENTRIES: readonly StickyViewportShowcaseEntry[] =
	STICKY_VIEWPORT_SHOWCASE_KEYS.map(key => {
		const [stateId, id, renderMode] = key.split("/") as [string, string, "unicode-color" | "ascii-no-color"];
		const [columns, rows] = id.split("x").map(Number) as [number, number];
		return { key, stateId, viewport: { id, columns, rows }, renderMode };
	});

const transcriptCapacityFromFrame = (frame: string) => {
	const rows = Bun.stripANSI(frame).split("\n");
	const statusRow = rows.findIndex(row => row.includes("status:"));
	if (statusRow < 0) throw new Error("Pinned status row was not rendered");
	return statusRow;
};

const CJK_BOUNDARIES = ["의미 있는 문장 경계", "意味のある文の境界", "保留语义短语边界"] as const;

/** Fixed-clock, no-network harness which captures a live production TUI VirtualTerminal frame. */
export async function renderStickyViewportShowcase(
	entry: StickyViewportShowcaseEntry,
): Promise<StickyViewportShowcaseRender> {
	const oldLevel = chalk.level;
	chalk.level = entry.renderMode === "ascii-no-color" ? 0 : 3;
	await initTheme(false, entry.renderMode === "ascii-no-color" ? "ascii" : "unicode", false, "red-claw", "red-claw");
	const terminal = new VirtualTerminal(entry.viewport.columns, entry.viewport.rows, { isProcessTerminal: true });
	const copied: string[] = [];
	const ui = new TUI(terminal, undefined, {
		enableMouse: true,
		copySelection: text => {
			copied.push(text);
		},
	});
	const transcript = new Container();
	const status = new Container();
	const hooks = new Container();
	const editor = new CustomEditor(getEditorTheme());
	try {
		for (let index = 0; index < 40; index += 1)
			transcript.addChild(new Text(`assistant ${index}: transcript output remains selectable`, 0, 0));
		if (entry.stateId === "narrow-cjk") {
			transcript.addChild(new Text(`Korean: ${CJK_BOUNDARIES[0]} mixed LatinOverflowToken`, 0, 0));
			transcript.addChild(new Text(`Japanese: ${CJK_BOUNDARIES[1]} mixed LatinOverflowToken`, 0, 0));
			transcript.addChild(new Text(`Chinese: ${CJK_BOUNDARIES[2]} mixed LatinOverflowToken`, 0, 0));
		}
		status.addChild(
			new Text(
				entry.stateId === "live-overflow" ? "status: live follow" : "status: manual history · composer pinned",
				0,
				0,
			),
		);
		if (entry.stateId === "multiline-editor-hooks-pet") {
			hooks.addChild(new Text("hook: ready", 0, 0));
			hooks.addChild(new Text(theme.strikethrough("completed: visual proof"), 0, 0));
			hooks.addChild(new Text("pet: ◕‿◕", 0, 0));
			editor.setText("first composer line\nsecond composer line");
		}
		editor.setBorderVisible(true);
		editor.setClosedBorderBox(true);
		editor.setInputPrefix(theme.fg("accent", "> "));
		editor.setPlaceholder("Ask about this transcript");
		if (entry.stateId === "capacity-one" || entry.stateId === "capacity-zero") {
			const targetCapacity = entry.stateId === "capacity-one" ? 1 : 0;
			const suffixRows = status.render(entry.viewport.columns).length + editor.render(entry.viewport.columns).length;
			const hookRows = entry.viewport.rows - targetCapacity - suffixRows;
			if (hookRows < 0) throw new Error(`${entry.key}: focused suffix exceeds constrained viewport`);
			for (let row = 0; row < hookRows; row += 1) hooks.addChild(new Text(`hook capacity row ${row}`, 0, 0));
		}
		ui.addChild(transcript);
		ui.setViewportAnchorComponent(transcript);
		ui.addChild(status);
		ui.addChild(hooks);
		ui.addChild(editor);
		ui.setBottomPinnedComponent(status);
		ui.setFocus(editor);
		ui.setViewportOutputSource({ identity: "sticky-viewport-showcase", revision: 0n });
		ui.start();
		await terminal.waitForRender();
		let historicalTranscriptRows: string[] = [];
		let manualPreOutputCapacity = 0;
		const manual = entry.stateId !== "live-overflow";
		if (manual) {
			const wheelMoved = ui.scrollViewportBy(-3, { pin: "stable" }); // production wheel step
			const pageUpMoved = ui.scrollViewportPages(-1); // production PageUp path
			if (!wheelMoved || !pageUpMoved)
				throw new Error(`${entry.key}: manual wheel/PageUp did not move the viewport`);
			if (entry.stateId === "narrow-cjk") ui.scrollViewportBy(entry.viewport.rows, { pin: "edge" });
			await terminal.waitForRender();
			const preOutputFrame = terminal.getViewportAnsi();
			const preOutputRows = Bun.stripANSI(preOutputFrame).split("\n");
			const preOutputCapacity = transcriptCapacityFromFrame(preOutputFrame);
			manualPreOutputCapacity = preOutputCapacity;
			if (preOutputCapacity > 0) {
				const semanticRow = preOutputRows.slice(0, preOutputCapacity).find(row => row.trim());
				if (!semanticRow) throw new Error(`${entry.key}: manual frame has no semantic transcript evidence`);
				historicalTranscriptRows = [semanticRow];
			}
		}
		await terminal.waitForRender();
		if (entry.stateId === "manual-new-output") {
			transcript.addChild(new Text("agent output after manual scroll", 0, 0));
			ui.setViewportOutputSource({ identity: "sticky-viewport-showcase", revision: 1n });
		}
		if (entry.stateId === "selection-boundary") {
			const transcriptRows = transcriptCapacityFromFrame(`${terminal.getViewport().join("\n")}\n`);
			if (transcriptRows < 1) throw new Error(`${entry.key}: selection has no transcript row`);
			terminal.sendInput("\x1b[<0;1;1M");
			terminal.sendInput("\x1b[<32;40;1M");
			terminal.sendInput(`\x1b[<32;40;${Math.min(entry.viewport.rows, transcriptRows + 2)}M`);
			terminal.sendInput(`\x1b[<0;40;${Math.min(entry.viewport.rows, transcriptRows + 2)}m`);
			await terminal.waitForRender();
			if (
				copied.length !== 1 ||
				!copied[0]?.includes("assistant") ||
				copied[0].includes("status:") ||
				copied[0].includes("> ")
			)
				throw new Error(`${entry.key}: mouse copy crossed pinned chrome`);
		}
		ui.requestRender();
		await terminal.waitForRender();
		const frame = terminal.getViewportAnsi();
		if (manual && historicalTranscriptRows.some(row => !Bun.stripANSI(frame).split("\n").includes(row)))
			throw new Error(`${entry.key}: manual transcript evidence was not preserved after rerender`);
		const capacity = transcriptCapacityFromFrame(frame);
		const cjkPhraseBoundaries = CJK_BOUNDARIES.filter(boundary => Bun.stripANSI(frame).includes(boundary));
		if (entry.stateId === "manual-new-output" && !Bun.stripANSI(frame).includes("New output — type to follow"))
			throw new Error(`${entry.key}: source revision did not paint the manual output notice`);
		if (entry.stateId === "narrow-cjk" && cjkPhraseBoundaries.length !== CJK_BOUNDARIES.length)
			throw new Error(`${entry.key}: CJK phrase boundaries were not visible in the wrapped terminal frame`);
		if (entry.stateId === "capacity-one" && capacity !== 1)
			throw new Error(`${entry.key}: expected one transcript row, rendered ${capacity}`);
		if (entry.stateId === "capacity-zero" && capacity !== 0)
			throw new Error(`${entry.key}: expected zero transcript rows, rendered ${capacity}`);
		if (entry.stateId === "capacity-many" && capacity < 2)
			throw new Error(`${entry.key}: expected multiple transcript rows, rendered ${capacity}`);
		return {
			terminalText: Bun.stripANSI(frame),
			terminalAnsiText: entry.renderMode === "ascii-no-color" ? Bun.stripANSI(frame) : frame,
			sourceRevision: "production-tui-virtual-terminal-v2",
			outputRevision: entry.stateId === "manual-new-output" ? "1" : "0",
			cjkPhraseBoundaries,
			state: {
				manual,
				notice: entry.stateId === "manual-new-output",
				transcript_capacity: capacity,
				manual_pre_output_capacity: manualPreOutputCapacity,
				manual_historical_rows: historicalTranscriptRows,
				selection_scope: entry.stateId === "selection-boundary" ? "transcript" : "none",
				selection_copied_text: entry.stateId === "selection-boundary" ? copied[0] : "",
				composer_visible: Bun.stripANSI(frame).includes("> "),
			},
		};
	} finally {
		ui.stop();
		chalk.level = oldLevel;
	}
}
