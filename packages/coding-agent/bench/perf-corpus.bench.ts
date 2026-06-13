/**
 * Profiling-corpus runner.
 *
 * Emits a stable `PerfCorpusReport` (JSON) over representative fixture classes,
 * keeping wall-clock, process-CPU, and profiler self-time as separate evidence.
 * The base runner attaches no profiler, so `profilerSelfTime.profiler` is
 * "none" and no hotspot can be promoted to `CPU-self-time confirmed` from this
 * run alone — that requires a profiler artifact (see docs/perf-profiling-corpus.md).
 *
 * Run: `bun packages/coding-agent/bench/perf-corpus.bench.ts`
 */

import { APPLIED_PERF_THRESHOLDS } from "./perf-threshold.ledger";
import {
	type PerfCorpusFixtureResult,
	type PerfCorpusReport,
	PERF_CORPUS_SCHEMA,
	type ProcessCpuUsageMetric,
	type RssMemoryMetric,
	V1_V3_RECLASSIFICATION,
	validatePerfCorpusReport,
	type WallClockPhaseMetric,
} from "./perf-corpus-schema";

/** Deterministic PRNG (mulberry32) so fixtures are identical on every run. */
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

interface PhaseMeasurement {
	wall: WallClockPhaseMetric;
	cpu: ProcessCpuUsageMetric;
}

function measurePhase(work: () => void, advisoryOnly: boolean): PhaseMeasurement {
	const cpuStart = process.cpuUsage();
	const start = performance.now();
	work();
	const elapsedMs = performance.now() - start;
	const cpuDelta = process.cpuUsage(cpuStart);
	const elapsedForFraction = Math.max(elapsedMs, 1e-6);
	return {
		wall: { elapsedMs, advisoryOnly },
		cpu: {
			userMicros: cpuDelta.user,
			systemMicros: cpuDelta.system,
			elapsedMs,
			cpuFraction: (cpuDelta.user + cpuDelta.system) / 1000 / elapsedForFraction,
		},
	};
}

function measureRss(work: () => void): RssMemoryMetric {
	const gc = (globalThis as { gc?: () => void }).gc;
	gc?.();
	const baselineBytes = process.memoryUsage().rss;
	const heapBaselineBytes = process.memoryUsage().heapUsed;
	work();
	const peakBytes = process.memoryUsage().rss;
	gc?.();
	const returnBytes = gc ? process.memoryUsage().rss : null;
	const heapReturnBytes = gc ? process.memoryUsage().heapUsed : null;
	return {
		baselineBytes,
		peakBytes,
		growthBytes: peakBytes - baselineBytes,
		returnBytes,
		heapBaselineBytes,
		heapReturnBytes,
	};
}

/** Synthetic startup/session-load workload: allocate + index a small session. */
function startupWorkload(rand: () => number): void {
	const entries: string[] = [];
	for (let i = 0; i < 2_000; i++) {
		entries.push(`entry-${i}-${Math.floor(rand() * 1e6).toString(36)}`);
	}
	const byId = new Map<string, number>();
	for (let i = 0; i < entries.length; i++) byId.set(entries[i], i);
	if (byId.size !== entries.length) throw new Error("startup workload index mismatch");
}

/** Synthetic streaming/TTFT workload: many small incremental chunk appends. */
function streamingWorkload(rand: () => number): void {
	let buffer = "";
	for (let i = 0; i < 5_000; i++) {
		buffer += String.fromCharCode(33 + Math.floor(rand() * 90));
		if (buffer.length > 4_096) buffer = buffer.slice(buffer.length - 4_096);
	}
	if (buffer.length === 0) throw new Error("streaming workload produced no output");
}

/** Synthetic large-transcript workload: build + scan a big transcript array. */
function largeTranscriptWorkload(rand: () => number): void {
	const lines: string[] = [];
	for (let i = 0; i < 20_000; i++) {
		lines.push(`line ${i}: ${"x".repeat(8 + Math.floor(rand() * 24))}`);
	}
	let total = 0;
	for (const line of lines) total += line.length;
	if (total <= 0) throw new Error("large-transcript workload empty");
}

function buildFixture(
	fixtureId: string,
	fixtureClass: PerfCorpusFixtureResult["fixtureClass"],
	workloadTags: string[],
	work: (rand: () => number) => void,
	seed: number,
): PerfCorpusFixtureResult {
	const phaseRand = mulberry32(seed);
	const phase = measurePhase(() => work(phaseRand), true);
	const rssRand = mulberry32(seed + 1);
	const rss = measureRss(() => work(rssRand));
	return {
		fixtureId,
		fixtureClass,
		sourceClass: "synthetic",
		workloadTags,
		privacy: { rawPrivateTranscriptCommitted: false, redactionNotes: "fully synthetic; deterministic PRNG, no real session data" },
		wallClockPhase: { run: phase.wall },
		processCpuUsage: { run: phase.cpu },
		profilerSelfTime: { profiler: "none" },
		rssMemory: rss,
		byteParity: { renderedGolden: "not-run", persistedJsonlGolden: "not-run", providerPayloadGolden: "not-run", materializedSessionGolden: "not-run" },
	};
}

export function runPerfCorpusBenchmark(): PerfCorpusReport {
	const fixtures: PerfCorpusFixtureResult[] = [
		buildFixture("startup-load", "startup-session-load", ["startup", "session-load"], startupWorkload, 0x51ed),
		buildFixture("streaming-ttft", "streaming-ttft", ["streaming", "ttft"], streamingWorkload, 0x9e37),
		buildFixture("large-transcript", "large-transcript", ["transcript", "scroll"], largeTranscriptWorkload, 0xc0de),
	];
	const report: PerfCorpusReport = {
		schema: PERF_CORPUS_SCHEMA,
		generatedAt: new Date().toISOString(),
		gitSha: process.env.GITHUB_SHA,
		runner: {
			command: "bun packages/coding-agent/bench/perf-corpus.bench.ts",
			platform: process.platform,
			arch: process.arch,
			bunVersion: process.versions.bun,
			ci: process.env.CI === "true",
		},
		fixtures,
		hotspotClassifications: [...V1_V3_RECLASSIFICATION],
		thresholdLedger: APPLIED_PERF_THRESHOLDS.map(t => ({ name: t.name, advisoryOrEnforced: t.advisoryOrEnforced })),
	};
	const validation = validatePerfCorpusReport(report);
	if (!validation.ok) {
		throw new Error(`perf corpus report failed validation:\n${validation.errors.join("\n")}`);
	}
	return report;
}

if (import.meta.main) {
	const report = runPerfCorpusBenchmark();
	process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
