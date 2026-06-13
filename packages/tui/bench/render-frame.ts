import { mkdir } from "node:fs/promises";
import * as os from "node:os";
import { spawnSync } from "node:child_process";
import { TUI } from "../src/tui";
import { Text } from "../src/components/text";
import { renderMetrics } from "../src/metrics";
import { makeRecordedSession } from "../test/replay-harness";
import { VirtualTerminal } from "../test/virtual-terminal";

type BenchMetadata = {
	gitSha: string | null;
	date: string;
	os: string;
	arch: string;
	cpu: string | null;
	bunVersion: string;
	nodeVersion: string | null;
};

type DurationStats = {
	medianMs: number;
	p95Ms: number;
	p99Ms: number;
	maxMs: number;
};

type BenchResult = DurationStats & {
	_meta: BenchMetadata;
	fixture: {
		cols: number;
		rows: number;
		turns: number;
		componentLines: number;
		warmupFrames: number;
		measuredFrames: number;
	};
	heap: {
		beforeBytes: number;
		afterBytes: number;
		deltaBytes: number;
	};
	renderMetrics: ReturnType<typeof renderMetrics.snapshot>;
};

const WARMUP_FRAMES = 50;
const MEASURED_FRAMES = 500;
const COLS = 120;
const ROWS = 40;

function percentile(sorted: number[], p: number): number {
	if (sorted.length === 0) return 0;
	const rank = (p / 100) * (sorted.length - 1);
	const lo = Math.floor(rank);
	const hi = Math.ceil(rank);
	if (lo === hi) return sorted[lo];
	const frac = rank - lo;
	return sorted[lo] * (1 - frac) + sorted[hi] * frac;
}

async function metadata(): Promise<BenchMetadata> {
	const git = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" });
	return {
		gitSha: git.status === 0 ? git.stdout.trim() : null,
		date: new Date().toISOString(),
		os: os.platform(),
		arch: os.arch(),
		cpu: os.cpus()[0]?.model ?? null,
		bunVersion: Bun.version,
		nodeVersion: process.versions.node ?? null,
	};
}

function fixtureLines(): string[] {
	const fixture = makeRecordedSession(260, 0x6002, COLS, ROWS);
	const lines: string[] = [];
	for (const [index, turn] of fixture.turns.entries()) {
		lines.push(`> ${turn.userText}`);
		lines.push(`**assistant ${index + 1}** ${turn.assistantChunks.join("")}`);
		if (turn.outputBlock) {
			lines.push("```text");
			lines.push(...turn.outputBlock);
			lines.push("```");
		}
		if (turn.toolLines) lines.push(...turn.toolLines);
	}
	if (lines.length < 1000) throw new Error(`render-frame fixture too small: ${lines.length} lines`);
	return lines;
}

async function renderFrame(tui: TUI, term: VirtualTerminal, source: string): Promise<void> {
	const before = term.getWriteLog().length;
	tui.requestRender(false, source);
	await term.waitForRender();
	if (term.getWriteLog().length === before) {
		throw new Error(`render did not flush for ${source}`);
	}
}

async function main(): Promise<void> {
	const outputArg = process.argv.find(arg => arg.startsWith("--output="));
	const outputPath = outputArg?.slice("--output=".length) ?? "/tmp/ug-evidence/g002/render-frame.json";
	await mkdir(outputPath.slice(0, outputPath.lastIndexOf("/")), { recursive: true });

	const lines = fixtureLines();
	const term = new VirtualTerminal(COLS, ROWS);
	const tui = new TUI(term);
	tui.start();
	tui.addChild(new Text(lines.join("\n"), 1, 0));
	await renderFrame(tui, term, "render-frame.initial");

	for (let i = 0; i < WARMUP_FRAMES; i++) {
		await renderFrame(tui, term, "render-frame.warmup");
	}

	renderMetrics.reset();
	renderMetrics.enable();
	renderMetrics.sampleRss();
	const heapBefore = process.memoryUsage().heapUsed;
	for (let i = 0; i < MEASURED_FRAMES; i++) {
		await renderFrame(tui, term, "render-frame.measure");
	}
	const heapAfter = process.memoryUsage().heapUsed;
	renderMetrics.sampleRss();
	const snapshot = renderMetrics.snapshot();
	renderMetrics.disable();
	tui.stop();

	const durations = [
		snapshot.renderDurations.p50Ms,
		snapshot.renderDurations.p95Ms,
		snapshot.renderDurations.p99Ms,
		snapshot.renderDurations.maxMs,
	];
	if (snapshot.renderDurations.count !== MEASURED_FRAMES || durations.some(v => !Number.isFinite(v))) {
		throw new Error(`invalid render metrics: ${JSON.stringify(snapshot.renderDurations)}`);
	}

	const result: BenchResult = {
		_meta: await metadata(),
		fixture: {
			cols: COLS,
			rows: ROWS,
			turns: 260,
			componentLines: lines.length,
			warmupFrames: WARMUP_FRAMES,
			measuredFrames: MEASURED_FRAMES,
		},
		medianMs: snapshot.renderDurations.p50Ms,
		p95Ms: snapshot.renderDurations.p95Ms,
		p99Ms: snapshot.renderDurations.p99Ms,
		maxMs: snapshot.renderDurations.maxMs,
		heap: {
			beforeBytes: heapBefore,
			afterBytes: heapAfter,
			deltaBytes: heapAfter - heapBefore,
		},
		renderMetrics: snapshot,
	};
	await Bun.write(outputPath, `${JSON.stringify(result, null, 2)}\n`);
	console.log(JSON.stringify(result, null, 2));
}

await main();
