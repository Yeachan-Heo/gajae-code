import * as os from "node:os";
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { Editor } from "../src/components/editor";
import type { EditorTheme } from "../src/components/editor";
const defaultSymbols = {
	cursor: ">",
	inputCursor: "|",
	boxRound: { topLeft: "+", topRight: "+", bottomLeft: "+", bottomRight: "+", horizontal: "-", vertical: "|" },
	boxSharp: {
		topLeft: "+",
		topRight: "+",
		bottomLeft: "+",
		bottomRight: "+",
		horizontal: "-",
		vertical: "|",
		teeDown: "+",
		teeUp: "+",
		teeLeft: "+",
		teeRight: "+",
		cross: "+",
	},
	table: {
		topLeft: "+",
		topRight: "+",
		bottomLeft: "+",
		bottomRight: "+",
		horizontal: "-",
		vertical: "|",
		teeDown: "+",
		teeUp: "+",
		teeLeft: "+",
		teeRight: "+",
		cross: "+",
	},
	quoteBorder: "│",
	hrChar: "-",
	spinnerFrames: ["-", "\\", "|", "/"],
};

const WARMUP_ITERATIONS = 100;
const MEASURE_ITERATIONS = 1000;
const WIDTH = 120;

const theme: EditorTheme = {
	borderColor: text => text,
	selectList: {
		borderColor: text => text,
		highlight: text => text,
		dim: text => text,
		item: text => text,
		itemDetails: text => text,
		symbols: defaultSymbols,
	},
	symbols: defaultSymbols,
};

type Fixture = {
	name: string;
	text: string;
	operation: "insert" | "move";
};

type FixtureResult = {
	name: string;
	operation: Fixture["operation"];
	width: number;
	warmupIterations: number;
	measureIterations: number;
	medianMs: number;
	p95Ms: number;
	p99Ms: number;
	minMs: number;
	maxMs: number;
	cursorChecksum: string;
	renderChecksum: string;
	samples: number[];
};

function gitCommit(): string | null {
	const result = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" });
	return result.status === 0 ? result.stdout.trim() : null;
}

function metadata() {
	return {
		bench: "packages/tui/bench/editor-layout.ts",
		package: "@gajae-code/tui",
		createdAt: new Date().toISOString(),
		gitCommit: gitCommit(),
		layoutCache: "enabled",
		runtime: {
			bunVersion: Bun.version,
			nodeVersion: process.version,
			platform: process.platform,
			arch: process.arch,
			cpu: os.cpus()[0]?.model ?? null,
		},
	};
}

function percentile(sorted: number[], p: number): number {
	if (sorted.length === 0) return 0;
	const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
	return sorted[index]!;
}

function checksum(parts: string[]): string {
	let hash = 2166136261;
	for (const part of parts) {
		for (let i = 0; i < part.length; i++) {
			hash ^= part.charCodeAt(i);
			hash = Math.imul(hash, 16777619);
		}
		hash ^= 10;
		hash = Math.imul(hash, 16777619);
	}
	return (hash >>> 0).toString(16).padStart(8, "0");
}

function makeFixtures(): Fixture[] {
	const ascii = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
	const single10k = ascii.repeat(Math.ceil(10_240 / ascii.length)).slice(0, 10_240);
	const line120 = ascii.repeat(Math.ceil(120 / ascii.length)).slice(0, 120);
	const hundredLines = Array.from({ length: 100 }, (_, i) => `${String(i).padStart(3, "0")}:${line120.slice(4)}`).join("\n");
	const thousandLinePaste = Array.from({ length: 1000 }, (_, i) => `paste-${String(i).padStart(4, "0")}-${line120}`).join("\n");
	const mixedUnit = "ASCII 한글 カナ 中國 😀👩‍💻 한글 café ";
	const mixed = Array.from({ length: 180 }, (_, i) => `${i}:${mixedUnit.repeat(4)}`).join("\n");
	return [
		{ name: "single-10kb-line", text: single10k, operation: "move" },
		{ name: "100-lines-120-chars", text: hundredLines, operation: "move" },
		{ name: "1000-line-paste", text: thousandLinePaste, operation: "move" },
		{ name: "mixed-ascii-cjk-emoji-jamo", text: mixed, operation: "move" },
		{ name: "incremental-insert", text: "", operation: "insert" },
	];
}

function createEditor(text: string): Editor {
	const editor = new Editor(theme);
	editor.setBorderVisible(false);
	editor.focused = true;
	editor.setText(text);
	editor.moveToMessageEnd();
	editor.render(WIDTH);
	return editor;
}

function clearEditorLayoutCache(editor: Editor): void {
	editor.invalidate();
}

function runOperation(editor: Editor, fixture: Fixture, iteration: number, options: { clearCachePerRender?: boolean } = {}): string[] {
	if (fixture.operation === "insert") {
		editor.handleInput(String.fromCharCode(97 + (iteration % 26)));
	} else if (fixture.name === "single-10kb-line") {
		editor.handleInput(iteration % 2 === 0 ? "\x1b[D" : "\x1b[C");
		for (let i = 0; i < 8; i++) {
			if (options.clearCachePerRender) clearEditorLayoutCache(editor);
			editor.render(WIDTH);
		}
	} else {
		editor.handleInput(iteration % 2 === 0 ? "\x1b[D" : "\x1b[C");
	}
	if (options.clearCachePerRender) clearEditorLayoutCache(editor);
	const rendered = editor.render(WIDTH);
	const cursor = editor.getCursor();
	return [`${cursor.line}:${cursor.col}`, ...rendered];
}

function benchFixture(fixture: Fixture): FixtureResult {
	const warmEditor = createEditor(fixture.text);
	for (let i = 0; i < WARMUP_ITERATIONS; i++) runOperation(warmEditor, fixture, i);
	Bun.gc(true);

	const editor = createEditor(fixture.text);
	const samples: number[] = [];
	const cursorParts: string[] = [];
	const renderParts: string[] = [];
	for (let i = 0; i < MEASURE_ITERATIONS; i++) {
		const start = performance.now();
		const result = runOperation(editor, fixture, i);
		samples.push(performance.now() - start);
		cursorParts.push(result[0]!);
		renderParts.push(result.join("\n"));
	}

	const sorted = samples.toSorted((a, b) => a - b);
	return {
		name: fixture.name,
		operation: fixture.operation,
		width: WIDTH,
		warmupIterations: WARMUP_ITERATIONS,
		measureIterations: MEASURE_ITERATIONS,
		medianMs: percentile(sorted, 50),
		p95Ms: percentile(sorted, 95),
		p99Ms: percentile(sorted, 99),
		minMs: sorted[0] ?? 0,
		maxMs: sorted.at(-1) ?? 0,
		cursorChecksum: checksum(cursorParts),
		renderChecksum: checksum(renderParts),
		samples,
	};
}

const fixtures = makeFixtures();
const samples = fixtures.map(benchFixture);
console.log(JSON.stringify({ metadata: metadata(), samples }, null, 2));
