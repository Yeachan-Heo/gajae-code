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
import { createMemoryBaselineWorkloads, type MemoryWorkload, workloadIterations } from "./memory-baseline-workloads";
import {
	type MemoryUsageSample,
	type MemoryWorkloadProfile,
	type MemorySurface,
	type PerfCorpusFixtureResult,
	type PerfCorpusReport,
	PERF_CORPUS_SCHEMA,
	type ProcessCpuUsageMetric,
	type RssMemoryMetric,
	REQUIRED_MEMORY_SURFACES,
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
function memorySample(startedAt: number): MemoryUsageSample {
	const usage = process.memoryUsage();
	return {
		elapsedMs: performance.now() - startedAt,
		rssBytes: usage.rss,
		heapUsedBytes: usage.heapUsed,
		heapTotalBytes: usage.heapTotal,
		externalBytes: usage.external,
		arrayBuffersBytes: usage.arrayBuffers,
		activeResourceCount: process.getActiveResourcesInfo().length,
	};
}

export function calculateMemorySlope(samples: MemoryUsageSample[], key: "rssBytes" | "heapUsedBytes"): number | null {
	const first = samples[0];
	const last = samples.at(-1);
	if (!first || !last) return null;
	const observedDurationMs = last.elapsedMs - first.elapsedMs;
	if (observedDurationMs < 250) return null;
	const warmupCutoffMs = first.elapsedMs + Math.min(250, observedDurationMs / 4);
	const steadyStateSamples = samples.filter(sample => sample.elapsedMs >= warmupCutoffMs);
	const steadyStateFirst = steadyStateSamples[0];
	const steadyStateLast = steadyStateSamples.at(-1);
	if (!steadyStateFirst || !steadyStateLast || steadyStateLast.elapsedMs - steadyStateFirst.elapsedMs < 250) return null;
	return ((steadyStateLast[key] - steadyStateFirst[key]) * 1_000) / (steadyStateLast.elapsedMs - steadyStateFirst.elapsedMs);
}
function processTreeRssBytes(): number | null {
	if (process.platform === "win32") return null;
	let result: Bun.SyncSubprocess<"pipe", "pipe">;
	try {
		result = Bun.spawnSync(["ps", "-axo", "pid=,ppid=,rss="]);
	} catch {
		return null;
	}
	if (result.exitCode !== 0) return null;
	const rows = new TextDecoder().decode(result.stdout).trim().split("\n");
	const parents = new Map<number, number>();
	const rssByPid = new Map<number, number>();
	for (const row of rows) {
		const [pidText, parentText, rssText] = row.trim().split(/\s+/);
		const pid = Number(pidText);
		const parent = Number(parentText);
		const rssKiB = Number(rssText);
		if (!Number.isInteger(pid) || !Number.isInteger(parent) || !Number.isFinite(rssKiB)) continue;
		parents.set(pid, parent);
		rssByPid.set(pid, rssKiB * 1_024);
	}
	rssByPid.delete(result.pid);
	parents.delete(result.pid);
	const descendants = new Set([process.pid]);
	let changed = true;
	while (changed) {
		changed = false;
		for (const [pid, parent] of parents) {
			if (descendants.has(parent) && !descendants.has(pid)) {
				descendants.add(pid);
				changed = true;
			}
		}
	}
	let total = 0;
	for (const pid of descendants) total += rssByPid.get(pid) ?? 0;
	return total > 0 ? total : null;
}

function buildMemoryFixture(
	workload: MemoryWorkload,
	profile: MemoryWorkloadProfile,
	targetDurationMs: number,
): PerfCorpusFixtureResult {
	const gc = (globalThis as { gc?: () => void }).gc;
	const minimumIterations = workloadIterations(profile);
	workload.teardown();
	gc?.();
	const baselineSample = { ...memorySample(performance.now()), elapsedMs: 0 };
	const processTreeBaselineRssBytes = processTreeRssBytes();
	const startedAt = performance.now();
	const cpuStart = process.cpuUsage();
	const samples = [baselineSample];
	let operations = 0;
	let iterations = 0;
	const chunkSize = profile === "soak" ? 5_000 : Math.max(1, Math.ceil(minimumIterations / 4));
	const sampleIntervalMs = profile === "soak" ? 50 : 0;
	while (iterations < minimumIterations || performance.now() - startedAt < targetDurationMs) {
		operations += workload.run(chunkSize);
		iterations += chunkSize;
		const elapsedSinceLastSample = performance.now() - startedAt - (samples.at(-1)?.elapsedMs ?? 0);
		if (elapsedSinceLastSample >= sampleIntervalMs) samples.push(memorySample(startedAt));
	}
	const elapsedMs = performance.now() - startedAt;
	if ((samples.at(-1)?.elapsedMs ?? 0) < elapsedMs) samples.push(memorySample(startedAt));
	const cpu = process.cpuUsage(cpuStart);
	workload.teardown();
	gc?.();
	const postTeardown = memorySample(startedAt);
	const processTreePostTeardownRssBytes = processTreeRssBytes();
	const baselineBytes = samples[0]?.rssBytes ?? null;
	const peakBytes = Math.max(...samples.map(sample => sample.rssBytes));
	const fixtureClass =
		workload.surface === "cli"
			? "startup-session-load"
			: workload.surface === "agent-session" || workload.surface === "blob-store"
				? "large-transcript"
				: "high-output-tool";
	return {
		fixtureId: `memory-${workload.id}`,
		fixtureClass,
		sourceClass: "synthetic",
		workloadTags: ["memory-baseline", workload.surface, ...workload.tags],
		privacy: {
			rawPrivateTranscriptCommitted: false,
			redactionNotes: "synthetic or deterministic production lifecycle workload; no user, provider, or transcript data",
		},
		wallClockPhase: { run: { elapsedMs, advisoryOnly: true } },
		processCpuUsage: {
			run: {
				userMicros: cpu.user,
				systemMicros: cpu.system,
				elapsedMs,
				cpuFraction: (cpu.user + cpu.system) / 1_000 / Math.max(elapsedMs, 1e-6),
			},
		},
		profilerSelfTime: { profiler: "none" },
		rssMemory: {
			baselineBytes,
			peakBytes,
			growthBytes: peakBytes - (baselineBytes ?? peakBytes),
			returnBytes: gc ? postTeardown.rssBytes : null,
			heapBaselineBytes: samples[0]?.heapUsedBytes ?? null,
			heapReturnBytes: gc ? postTeardown.heapUsedBytes : null,
		},
		byteParity: {
			renderedGolden: "not-run",
			persistedJsonlGolden: "not-run",
			providerPayloadGolden: "not-run",
			materializedSessionGolden: "not-run",
		},
		memoryBaseline: {
			surface: workload.surface,
			profile,
			iterations,
			operations,
			operationsPerSecond: operations / Math.max(elapsedMs / 1_000, 1e-6),
			samples,
			postTeardown,
			rssSlopeBytesPerSecond: calculateMemorySlope(samples, "rssBytes"),
			heapSlopeBytesPerSecond: calculateMemorySlope(samples, "heapUsedBytes"),
			processTreeBaselineRssBytes,
			processTreePostTeardownRssBytes,
			processTreeSampler:
				processTreeBaselineRssBytes === null || processTreePostTeardownRssBytes === null ? "unavailable" : "ps",
		},
	};
}

function buildMemoryFixtures(
	profile: MemoryWorkloadProfile,
	targetDurationMs: number,
): PerfCorpusFixtureResult[] {
	return createMemoryBaselineWorkloads().map(workload => buildMemoryFixture(workload, profile, targetDurationMs));
}

function isMemorySurface(value: string | undefined): value is MemorySurface {
	return value !== undefined && (REQUIRED_MEMORY_SURFACES as readonly string[]).includes(value);
}

function buildIsolatedMemoryFixtures(
	profile: MemoryWorkloadProfile,
	targetDurationMs: number,
): PerfCorpusFixtureResult[] {
	return REQUIRED_MEMORY_SURFACES.map(surface => {
		const result = Bun.spawnSync([process.execPath, "--smol", "--expose-gc", import.meta.path], {
			env: {
				...process.env,
				GJC_MEMORY_CHILD_SURFACE: surface,
				GJC_MEMORY_PROFILE: profile,
				GJC_MEMORY_DURATION_MS: String(targetDurationMs),
			},
		});
		if (result.exitCode !== 0) {
			throw new Error(
				`memory baseline child failed for ${surface}: ${new TextDecoder().decode(result.stderr).trim()}`,
			);
		}
		return JSON.parse(new TextDecoder().decode(result.stdout)) as PerfCorpusFixtureResult;
	});
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

export function runPerfCorpusBenchmark(options: { isolatedMemory?: boolean } = {}): PerfCorpusReport {
	const profile: MemoryWorkloadProfile = process.env.GJC_MEMORY_PROFILE === "soak" ? "soak" : "short";
	const configuredDurationMs = Number(process.env.GJC_MEMORY_DURATION_MS);
	const durationTargetMs =
		profile === "soak"
			? Number.isSafeInteger(configuredDurationMs) && configuredDurationMs >= 250 && configuredDurationMs <= 60_000
				? configuredDurationMs
				: 1_000
			: 0;
	const fixtures: PerfCorpusFixtureResult[] = [
		buildFixture("startup-load", "startup-session-load", ["startup", "session-load"], startupWorkload, 0x51ed),
		buildFixture("streaming-ttft", "streaming-ttft", ["streaming", "ttft"], streamingWorkload, 0x9e37),
		buildFixture("large-transcript", "large-transcript", ["transcript", "scroll"], largeTranscriptWorkload, 0xc0de),
		...(options.isolatedMemory
			? buildIsolatedMemoryFixtures(profile, durationTargetMs)
			: buildMemoryFixtures(profile, durationTargetMs)),
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
			profile,
			durationTargetMs,
			memoryIsolation: options.isolatedMemory ? "process-per-surface" : "in-process",
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
	const childSurface = process.env.GJC_MEMORY_CHILD_SURFACE;
	if (isMemorySurface(childSurface)) {
		const profile: MemoryWorkloadProfile = process.env.GJC_MEMORY_PROFILE === "soak" ? "soak" : "short";
		const durationTargetMs = Number(process.env.GJC_MEMORY_DURATION_MS) || 0;
		const workload = createMemoryBaselineWorkloads().find(candidate => candidate.surface === childSurface);
		if (!workload) throw new Error(`memory baseline workload unavailable for ${childSurface}`);
		process.stdout.write(`${JSON.stringify(buildMemoryFixture(workload, profile, durationTargetMs))}\n`);
	} else {
		const report = runPerfCorpusBenchmark({ isolatedMemory: true });
		process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
	}
}
