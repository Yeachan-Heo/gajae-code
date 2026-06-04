/**
 * Recorded real-session replay harness (Stage 1 observability foundation).
 *
 * Drives a `TUI` over the in-repo `VirtualTerminal` with a scripted, deterministic
 * session fixture (streamed assistant output, tool blocks, high-output/read-like
 * blocks, idle gaps, terminal resizes, growing transcript) and collects
 * renderer/runtime metrics plus golden output. It is a test/bench utility, not
 * shipped runtime code, so it can enable the otherwise opt-in `renderMetrics`.
 *
 * Fixtures are plain data (`ReplayFixture`) so they can be serialized to and
 * loaded from JSON — the "recorded session" format. A representative fixture is
 * committed at test/fixtures/recorded-session.json and consumed by the gates.
 */
import { performance } from "node:perf_hooks";
import { TUI } from "@gajae-code/tui";
import { Text } from "@gajae-code/tui/components/text";
import { type RenderMetricsSnapshot, renderMetrics } from "@gajae-code/tui/metrics";
import { VirtualTerminal } from "./virtual-terminal";

export interface ReplayTurn {
	userText: string;
	/** Assistant output streamed across one or more chunks. */
	assistantChunks: string[];
	/** Optional tool-result lines appended after the assistant turn. */
	toolLines?: string[];
	/** Optional high-output / read-like block (e.g. command or file output). */
	outputBlock?: string[];
	/** Optional terminal resize applied before this turn (UI churn). */
	resizeTo?: { cols: number; rows: number };
	/** Number of idle render cycles (no state change) after the turn. */
	idleTicks?: number;
}

export interface ReplayFixture {
	cols: number;
	rows: number;
	turns: ReplayTurn[];
}

export interface ReplayResult {
	metrics: RenderMetricsSnapshot;
	finalViewport: string[];
	scrollback: string[];
	writeCount: number;
	turns: number;
}

export interface ReplayOptions {
	/** Collect metrics during the replay (default true). */
	metrics?: boolean;
}

/** Deterministic 32-bit PRNG (mulberry32) for reproducible fixtures. */
function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const WORDS = [
	"render",
	"buffer",
	"diff",
	"stream",
	"token",
	"layout",
	"width",
	"cursor",
	"overlay",
	"viewport",
	"session",
	"timer",
	"gauge",
	"replay",
	"metric",
	"frame",
];

function sentence(rand: () => number, words: number): string {
	const out: string[] = [];
	for (let i = 0; i < words; i++) {
		out.push(WORDS[Math.floor(rand() * WORDS.length)]);
	}
	return out.join(" ");
}

/**
 * Build a deterministic ~`turnCount`-turn recorded session fixture that
 * exercises streamed assistant output, tool blocks, high-output/read-like
 * output, idle gaps, terminal resizes, and a growing transcript.
 */
export function makeRecordedSession(turnCount = 300, seed = 0x9e3779b9, cols = 100, rows = 30): ReplayFixture {
	const rand = mulberry32(seed);
	const turns: ReplayTurn[] = [];
	for (let i = 0; i < turnCount; i++) {
		const chunkCount = 1 + Math.floor(rand() * 3);
		const assistantChunks: string[] = [];
		for (let c = 0; c < chunkCount; c++) {
			assistantChunks.push(`${sentence(rand, 4 + Math.floor(rand() * 8))} `);
		}
		const hasTool = rand() < 0.4;
		const toolLines = hasTool
			? Array.from({ length: 1 + Math.floor(rand() * 3) }, () => `  | ${sentence(rand, 3 + Math.floor(rand() * 5))}`)
			: undefined;
		// ~15% of turns emit a large read-like / command output block.
		const hasOutput = rand() < 0.15;
		const outputBlock = hasOutput
			? Array.from(
					{ length: 20 + Math.floor(rand() * 40) },
					(_unused, n) => `${n.toString().padStart(4)}  ${sentence(rand, 8 + Math.floor(rand() * 10))}`,
				)
			: undefined;
		// ~8% of turns resize the terminal (UI churn / width+height change paths).
		const hasResize = rand() < 0.08;
		const resizeTo = hasResize
			? { cols: 70 + Math.floor(rand() * 60), rows: 20 + Math.floor(rand() * 20) }
			: undefined;
		turns.push({
			userText: sentence(rand, 3 + Math.floor(rand() * 5)),
			assistantChunks,
			toolLines,
			outputBlock,
			resizeTo,
			idleTicks: rand() < 0.3 ? 1 : 0,
		});
	}
	return { cols, rows, turns };
}

/** Serialize a fixture to the recorded-session JSON format. */
export function serializeFixture(fixture: ReplayFixture): string {
	return JSON.stringify(fixture, null, 2);
}

/** Parse a recorded-session JSON string into a fixture (shape-validated). */
export function loadFixture(json: string): ReplayFixture {
	const data = JSON.parse(json) as ReplayFixture;
	if (!data || typeof data.cols !== "number" || typeof data.rows !== "number" || !Array.isArray(data.turns)) {
		throw new Error("invalid replay fixture: expected { cols, rows, turns[] }");
	}
	return data;
}

/**
 * Replay a fixture through a TUI over a virtual terminal and return metrics plus
 * golden output. When `metrics` is true (default), `renderMetrics` is reset,
 * enabled for the duration, and disabled again afterward so callers always get a
 * clean, isolated snapshot and global state is restored. A post-replay forced-GC
 * RSS "return" sample is taken after releasing the transcript so the memory-leak
 * gate measures reclaimable growth.
 */
export async function runReplay(fixture: ReplayFixture, opts: ReplayOptions = {}): Promise<ReplayResult> {
	const collect = opts.metrics ?? true;
	if (collect) {
		renderMetrics.reset();
		renderMetrics.enable();
	}

	const term = new VirtualTerminal(fixture.cols, fixture.rows);
	const tui = new TUI(term);
	tui.start();
	if (collect) renderMetrics.sampleRss(); // baseline

	let turnIndex = 0;
	let componentCount = 0;
	for (const turn of fixture.turns) {
		turnIndex += 1;
		if (collect) renderMetrics.setOwnerGauge("transcript.components", componentCount);

		if (turn.resizeTo) {
			term.resize(turn.resizeTo.cols, turn.resizeTo.rows);
			await term.waitForRender();
		}

		tui.addChild(new Text(`> ${turn.userText}`, 1, 0));
		componentCount += 1;
		tui.requestRender(false, "replay.user");
		await term.waitForRender();

		const stream = new Text("", 1, 0);
		tui.addChild(stream);
		componentCount += 1;

		// Stream in two coalesced checkpoints (mid + final) to keep the replay
		// fast while still exercising the streaming render cadence.
		let acc = "";
		const mid = Math.ceil(turn.assistantChunks.length / 2);
		for (let c = 0; c < turn.assistantChunks.length; c++) {
			acc += turn.assistantChunks[c];
			if (c === mid - 1 || c === turn.assistantChunks.length - 1) {
				stream.setText(acc);
				tui.requestRender(false, "replay.stream");
				await term.waitForRender();
			}
		}

		if (turn.outputBlock) {
			tui.addChild(new Text(turn.outputBlock.join("\n"), 1, 0));
			componentCount += 1;
			tui.requestRender(false, "replay.output");
			await term.waitForRender();
		}

		if (turn.toolLines) {
			for (const line of turn.toolLines) {
				tui.addChild(new Text(line, 1, 0));
				componentCount += 1;
			}
			tui.requestRender(false, "replay.tool");
			await term.waitForRender();
		}

		for (let t = 0; t < (turn.idleTicks ?? 0); t++) {
			// Idle gap: no state change, no render request. Used to measure that
			// the renderer does not perform avoidable work when nothing changed.
			await term.waitForRender();
		}

		if (collect) renderMetrics.sampleRss();
	}

	const finalViewport = await term.flushAndGetViewport();
	const scrollback = term.getScrollBuffer();
	const writeCount = term.getWriteLog().length;
	tui.stop();

	// Release retained transcript/terminal state, then sample post-GC RSS so the
	// memory-leak/return gate measures reclaimable growth rather than live data.
	if (collect) {
		tui.clear();
		term.reset();
		renderMetrics.sampleReturn();
	}

	const metrics = renderMetrics.snapshot();
	if (collect) renderMetrics.disable();

	return { metrics, finalViewport, scrollback, writeCount, turns: turnIndex };
}

/**
 * Measure idle CPU as a fraction of one core over `idleMs` on a quiescent TUI
 * (rendered once, then no further render requests). Used by the idle-CPU gate.
 */
export async function measureIdleCpuFraction(idleMs = 1000): Promise<number> {
	const term = new VirtualTerminal(100, 30);
	const tui = new TUI(term);
	tui.start();
	tui.addChild(new Text("idle baseline", 1, 0));
	tui.requestRender(false, "idle.setup");
	await term.waitForRender();
	await new Promise<void>(resolve => setTimeout(resolve, 50)); // settle

	const cpu0 = process.cpuUsage();
	const t0 = performance.now();
	await new Promise<void>(resolve => setTimeout(resolve, idleMs));
	const elapsedMs = performance.now() - t0;
	const cpu = process.cpuUsage(cpu0);
	tui.stop();

	const cpuMicros = cpu.user + cpu.system;
	return cpuMicros / (elapsedMs * 1000);
}
