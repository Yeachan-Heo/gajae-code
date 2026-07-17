// MUST be first: pins terminal-capability env before @gajae-code/tui evaluates.
// (Bare side-effect import — biome keeps it as a chunk boundary, so it cannot
// be re-sorted below the @gajae-code/tui imports.)
import "./render-goldens-env";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	type AutocompleteItem,
	type AutocompleteProvider,
	type Component,
	Editor,
	Image,
	Markdown,
	Text,
	TUI,
} from "@gajae-code/tui";
import { ImageProtocol } from "@gajae-code/tui/terminal-capabilities";
import { GOLDEN_BASELINE_ENV } from "./render-goldens-env";
import { defaultEditorTheme, defaultMarkdownTheme } from "./test-themes";
import { VirtualTerminal } from "./virtual-terminal";

export interface RenderGoldenMeta {
	schemaVersion: 1;
	fixtureName: string;
	terminalWidth: number;
	terminalHeight: number;
	capabilities: {
		kittyProtocolActive: boolean;
		hyperlinks: boolean;
		imageProtocol: string | null;
	};
	coverage: string[];
	artifacts: {
		viewport: { file: "viewport.txt"; sha256: string };
		scrollback: { file: "scrollback.txt"; sha256: string };
		writelog: { file: "writelog.bin"; sha256: string };
	};
}

export interface RenderGoldenCapture {
	fixtureName: string;
	viewport: string[];
	scrollback: string[];
	writeLog: Uint8Array;
	meta: RenderGoldenMeta;
}

interface GoldenFixture {
	name: string;
	cols: number;
	rows: number;
	coverage: string[];
	env?: Record<string, string | undefined>;
	isProcessTerminal?: boolean;
	imageProtocol?: ImageProtocol | null;
	run(tui: TUI, term: VirtualTerminal): Promise<void>;
}

const encoder = new TextEncoder();
const BASE64_ONE_PIXEL_PNG =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==";

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

class StaticAutocompleteProvider implements AutocompleteProvider {
	async getSuggestions(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
	): Promise<{ items: AutocompleteItem[]; prefix: string } | null> {
		const line = lines[cursorLine] ?? "";
		const prefix = line.slice(0, cursorCol);
		if (!prefix.startsWith("/")) return null;
		return {
			prefix,
			items: [
				{ value: "help", label: "/help", description: "Show help" },
				{ value: "history", label: "/history", description: "Show history" },
				{ value: "handoff", label: "/handoff", description: "Create handoff" },
			],
		};
	}

	applyCompletion(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		item: AutocompleteItem,
		prefix: string,
	): { lines: string[]; cursorLine: number; cursorCol: number } {
		const next = [...lines];
		const line = next[cursorLine] ?? "";
		next[cursorLine] = `${line.slice(0, cursorCol - prefix.length)}/${item.value} ${line.slice(cursorCol)}`;
		return { lines: next, cursorLine, cursorCol: cursorCol - prefix.length + item.value.length + 2 };
	}
}

async function settle(term: VirtualTerminal): Promise<void> {
	await term.waitForRender();
}

function sha256(data: string | Uint8Array): string {
	return createHash("sha256").update(data).digest("hex");
}

function joinLines(lines: string[]): string {
	return `${lines.join("\n")}\n`;
}

function textBytes(text: string): Uint8Array {
	return encoder.encode(text);
}

function concatWriteLog(writes: string[]): Uint8Array {
	return textBytes(writes.join(""));
}

export const RENDER_GOLDEN_FIXTURES: GoldenFixture[] = [
	{
		name: "layout-resize-rich-text",
		cols: 76,
		rows: 18,
		coverage: [
			"resize",
			"width change",
			"height change",
			"OSC 8 hyperlink",
			"markdown code block",
			"markdown table",
			"markdown list",
			"markdown blockquote",
			"wide/CJK",
			"emoji ZWJ",
			"Jamo",
		],
		async run(tui, term) {
			const markdown = new Markdown(
				[
					"# Golden rich text",
					"",
					"> Deterministic quote with [link](https://example.test/golden).",
					"",
					"- list alpha",
					"- list beta with CJK 表示 and 한글 jamo 한",
					"",
					"| Glyph | Value |",
					"| --- | --- |",
					"| family | 👨‍👩‍👧‍👦 |",
					"| wide | コンニチハ |",
					"",
					"```ts",
					"const width = 'stable';",
					"console.log(width);",
					"```",
				].join("\n"),
				1,
				0,
				defaultMarkdownTheme,
			);
			tui.addChild(markdown);
			tui.addChild(new Text("\x1b]8;;https://example.test/osc8\x07OSC8 link\x1b]8;;\x07 end", 1, 0));
			tui.requestRender(false, "golden.rich.initial");
			await settle(term);
			term.resize(58, 14);
			await settle(term);
			term.resize(84, 20);
			await settle(term);
		},
	},
	{
		name: "interactive-editor-overlay",
		cols: 64,
		rows: 16,
		coverage: ["overlay", "autocomplete popup", "focused editor cursor", "no-change render"],
		async run(tui, term) {
			const editor = new Editor(defaultEditorTheme);
			editor.setAutocompleteProvider(new StaticAutocompleteProvider());
			editor.setTopBorder({ content: " GOLDEN EDIT ", width: 13 });
			editor.setText("/h");
			tui.addChild(new Text("Before editor", 1, 0));
			tui.addChild(editor);
			tui.setFocus(editor);
			tui.requestRender(false, "golden.editor.initial");
			await settle(term);
			editor.handleInput("e");
			await Bun.sleep(0);
			tui.requestRender(false, "golden.editor.autocomplete");
			await settle(term);
			const handle = tui.showOverlay(new MutableLinesComponent(["OVERLAY", "choice: help", "stable"]), {
				anchor: "top-left",
				row: 7,
				col: 8,
			});
			await settle(term);
			handle.hide();
			await settle(term);
			tui.requestRender(false, "golden.editor.nochange");
			await settle(term);
		},
	},
	{
		name: "transcript-shrink-clear",
		cols: 52,
		rows: 12,
		coverage: ["long transcript append", "shrink clear", "height change"],
		async run(tui, term) {
			tui.setClearOnShrink(true);
			const component = new MutableLinesComponent(
				Array.from({ length: 26 }, (_v, i) => `transcript-${String(i).padStart(2, "0")} :: stable append`),
			);
			tui.addChild(component);
			tui.requestRender(false, "golden.transcript.long");
			await settle(term);
			term.resize(52, 8);
			await settle(term);
			component.setLines(["short-0", "short-1", "short-2"]);
			tui.requestRender(false, "golden.transcript.shrink");
			await settle(term);
		},
	},
	{
		name: "multiplexer-viewport-repaint",
		cols: 32,
		rows: 5,
		env: { TMUX: "golden-tmux", PI_TUI_LEGACY_MULTIPLEXER_FULL_RENDER: undefined },
		isProcessTerminal: true,
		coverage: ["multiplexer repaint", "TMUX env branch", "offscreen change", "no 3J scrollback clear"],
		async run(tui, term) {
			const lines = Array.from({ length: 16 }, (_v, i) => `mux-line-${String(i).padStart(2, "0")}`);
			const component = new MutableLinesComponent(lines);
			tui.addChild(component);
			tui.requestRender(false, "golden.mux.initial");
			await settle(term);
			const nextLines = [...lines];
			nextLines[0] = "mux-offscreen-header-updated";
			component.setLines(nextLines);
			tui.requestRender(false, "golden.mux.repaint");
			await settle(term);
		},
	},
	{
		name: "termux-height-diff",
		cols: 42,
		rows: 10,
		env: { TERMUX_VERSION: "golden-termux" },
		isProcessTerminal: true,
		coverage: [
			"Termux height branch",
			"TERMUX_VERSION env branch",
			"height change without full scrollback clear",
			"differential render after resize",
		],
		async run(tui, term) {
			const component = new MutableLinesComponent(
				Array.from({ length: 8 }, (_v, i) => `termux-line-${String(i).padStart(2, "0")}`),
			);
			tui.addChild(component);
			tui.requestRender(false, "golden.termux.initial");
			await settle(term);
			term.resize(42, 6);
			await settle(term);
			component.setLines(["termux-line-00", "termux-keyboard-height", "termux-line-02", "termux-line-03"]);
			tui.requestRender(false, "golden.termux.diff");
			await settle(term);
		},
	},
	{
		name: "sixel-image-line-preservation",
		cols: 44,
		rows: 8,
		imageProtocol: ImageProtocol.Sixel,
		coverage: [
			"image/sixel line preservation",
			"TERMINAL.isImageLine sixel branch",
			"no line terminator on image passthrough",
			"DCS sixel marker",
		],
		async run(tui, term) {
			const image = new Image(
				BASE64_ONE_PIXEL_PNG,
				"image/png",
				{ fallbackColor: text => text },
				{ maxWidthCells: 8, maxHeightCells: 1, filename: "golden-one-pixel.png" },
				{ widthPx: 1, heightPx: 1 },
			);
			const component = new MutableLinesComponent(["before-sixel", ...image.render(term.columns), "after-sixel"]);
			tui.addChild(component);
			tui.requestRender(false, "golden.sixel.initial");
			await settle(term);
		},
	},
];

export async function captureRenderGolden(fixture: GoldenFixture): Promise<RenderGoldenCapture> {
	const previousEnv = new Map<string, string | undefined>();
	let terminalCapabilities: typeof import("@gajae-code/tui/terminal-capabilities") | null = null;
	let previousImageProtocol: ImageProtocol | null | undefined;
	let tui: TUI | null = null;
	try {
		const pinnedEnv: Record<string, string | undefined> = { ...GOLDEN_BASELINE_ENV, ...(fixture.env ?? {}) };
		for (const [key, value] of Object.entries(pinnedEnv)) {
			previousEnv.set(key, Bun.env[key]);
			if (value === undefined) delete Bun.env[key];
			else Bun.env[key] = value;
		}

		terminalCapabilities =
			fixture.imageProtocol === undefined ? null : await import("@gajae-code/tui/terminal-capabilities");
		previousImageProtocol = terminalCapabilities?.TERMINAL.imageProtocol;
		if (terminalCapabilities && fixture.imageProtocol !== undefined) {
			terminalCapabilities.setTerminalImageProtocol(fixture.imageProtocol);
		}

		const term = new VirtualTerminal(fixture.cols, fixture.rows, {
			isProcessTerminal: fixture.isProcessTerminal,
		});
		tui = new TUI(term);
		tui.start();
		await fixture.run(tui, term);
		const viewport = term.getViewport();
		const scrollback = term.getScrollBuffer();
		const writeLog = concatWriteLog(term.getWriteLog());
		const viewportText = joinLines(viewport);
		const scrollbackText = joinLines(scrollback);
		const meta: RenderGoldenMeta = {
			schemaVersion: 1,
			fixtureName: fixture.name,
			terminalWidth: term.columns,
			terminalHeight: term.rows,
			capabilities: {
				kittyProtocolActive: term.kittyProtocolActive,
				hyperlinks: true,
				imageProtocol: fixture.imageProtocol ?? null,
			},
			coverage: fixture.coverage,
			artifacts: {
				viewport: { file: "viewport.txt", sha256: sha256(viewportText) },
				scrollback: { file: "scrollback.txt", sha256: sha256(scrollbackText) },
				writelog: { file: "writelog.bin", sha256: sha256(writeLog) },
			},
		};
		return { fixtureName: fixture.name, viewport, scrollback, writeLog, meta };
	} finally {
		tui?.stop();
		if (terminalCapabilities) terminalCapabilities.setTerminalImageProtocol(previousImageProtocol ?? null);
		for (const [key, value] of previousEnv) {
			if (value === undefined) delete Bun.env[key];
			else Bun.env[key] = value;
		}
	}
}

export function renderGoldenDir(fixtureName: string): string {
	return join(import.meta.dir, "fixtures", "render-goldens", fixtureName);
}

export async function writeRenderGolden(capture: RenderGoldenCapture): Promise<void> {
	const dir = renderGoldenDir(capture.fixtureName);
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, "viewport.txt"), joinLines(capture.viewport));
	await writeFile(join(dir, "scrollback.txt"), joinLines(capture.scrollback));
	await writeFile(join(dir, "writelog.bin"), capture.writeLog);
	await writeFile(join(dir, "meta.json"), `${JSON.stringify(capture.meta, null, 2)}\n`);
}

export async function readRenderGolden(fixtureName: string): Promise<{
	viewportText: string;
	scrollbackText: string;
	writeLog: Uint8Array;
	meta: RenderGoldenMeta;
}> {
	const dir = renderGoldenDir(fixtureName);
	const [viewportText, scrollbackText, writeLog, metaText] = await Promise.all([
		readFile(join(dir, "viewport.txt"), "utf8"),
		readFile(join(dir, "scrollback.txt"), "utf8"),
		readFile(join(dir, "writelog.bin")),
		readFile(join(dir, "meta.json"), "utf8"),
	]);
	return { viewportText, scrollbackText, writeLog, meta: JSON.parse(metaText) as RenderGoldenMeta };
}

export function verifyCaptureHashes(capture: RenderGoldenCapture): void {
	const viewportText = joinLines(capture.viewport);
	const scrollbackText = joinLines(capture.scrollback);
	capture.meta.artifacts.viewport.sha256 = sha256(viewportText);
	capture.meta.artifacts.scrollback.sha256 = sha256(scrollbackText);
	capture.meta.artifacts.writelog.sha256 = sha256(capture.writeLog);
}

export function captureTexts(capture: RenderGoldenCapture): { viewportText: string; scrollbackText: string } {
	return { viewportText: joinLines(capture.viewport), scrollbackText: joinLines(capture.scrollback) };
}
