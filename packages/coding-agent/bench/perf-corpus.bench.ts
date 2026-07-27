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

import * as path from "node:path";
import * as url from "node:url";
import { APPLIED_PERF_THRESHOLDS } from "./perf-threshold.ledger";
import { createMemoryBaselineWorkloads, type MemoryWorkload, workloadIterations } from "./memory-baseline-workloads";
import {
	calculateMemorySlope,
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
export function gitWorktreeFingerprint(repositoryRoot: string): { dirty: boolean; fingerprint: string } {
	const status = Bun.spawnSync(["git", "status", "--porcelain=v1", "-z", "--untracked-files=all"], {
		cwd: repositoryRoot,
	});
	const diff = Bun.spawnSync(["git", "diff", "--binary", "HEAD", "--"], { cwd: repositoryRoot });
	const untracked = Bun.spawnSync(["git", "ls-files", "--others", "--exclude-standard", "-z"], {
		cwd: repositoryRoot,
	});
	if (status.exitCode !== 0 || diff.exitCode !== 0 || untracked.exitCode !== 0) {
		throw new Error("git worktree fingerprint commands failed");
	}
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(status.stdout);
	hasher.update(diff.stdout);
	const untrackedPaths = new TextDecoder().decode(untracked.stdout).split("\0").filter(Boolean);
	for (const untrackedPath of untrackedPaths) {
		const contentHash = Bun.spawnSync(["git", "hash-object", "--", untrackedPath], { cwd: repositoryRoot });
		if (contentHash.exitCode !== 0) throw new Error(`git hash-object failed for ${untrackedPath}`);
		hasher.update(untrackedPath);
		hasher.update(contentHash.stdout);
	}
	return {
		dirty: status.stdout.length > 0,
		fingerprint: hasher.digest("hex"),
	};
}

export function resolveGitProvenance(): { sha: string; dirty: boolean; worktreeFingerprint: string } {
	const environmentSha = process.env.GITHUB_SHA?.trim();
	const repositoryRoot = path.resolve(import.meta.dir, "../../..");
	let sha = "";
	let dirty = true;
	let worktreeFingerprint = "unavailable";
	let revision: Bun.SyncSubprocess<"pipe", "pipe"> | null = null;
	try {
		revision = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: repositoryRoot });
	} catch {
		// Exported source bundles may provide GITHUB_SHA without shipping Git.
	}
	if (revision?.exitCode === 0) {
		sha = new TextDecoder().decode(revision.stdout).trim();
		const worktree = gitWorktreeFingerprint(repositoryRoot);
		worktreeFingerprint = worktree.fingerprint;
		dirty = worktree.dirty;
	}
	if (!sha) sha = environmentSha ?? "";
	return { sha, dirty, worktreeFingerprint };
}

function reproductionInvocation(
	profile: MemoryWorkloadProfile,
	durationTargetMs: number,
	iterationsTarget: number,
): { command: string; argv: string[]; environment: Record<string, string> } {
	const environment: Record<string, string> = {
		GJC_MEMORY_PROFILE: profile,
		GJC_MEMORY_ITERATIONS: String(iterationsTarget),
	};
	if (profile === "soak") environment.GJC_MEMORY_DURATION_MS = String(durationTargetMs);
	const argv = [process.execPath, ...process.execArgv, ...process.argv.slice(1)];
	return { command: argv.join(" "), argv, environment };
}
const MEMORY_CHILD_ARGUMENT = "--gjc-memory-child";
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
interface MemoryHighWaterSamples {
	rss: MemoryUsageSample;
	heap: MemoryUsageSample;
	external: MemoryUsageSample;
	arrayBuffers: MemoryUsageSample;
}

export function updateMemoryHighWaterSamples(peaks: MemoryHighWaterSamples, sample: MemoryUsageSample): void {
	if (sample.rssBytes > peaks.rss.rssBytes) peaks.rss = sample;
	if (sample.heapUsedBytes > peaks.heap.heapUsedBytes) peaks.heap = sample;
	if (sample.externalBytes > peaks.external.externalBytes) peaks.external = sample;
	if (sample.arrayBuffersBytes > peaks.arrayBuffers.arrayBuffersBytes) peaks.arrayBuffers = sample;
}

export { calculateMemorySlope };
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
export function normalizeProcessTreeRss(
	baselineBytes: number | null,
	postTeardownBytes: number | null,
): {
	baselineBytes: number | null;
	postTeardownBytes: number | null;
	sampler: "ps" | "unavailable";
} {
	if (baselineBytes === null || postTeardownBytes === null) {
		return { baselineBytes: null, postTeardownBytes: null, sampler: "unavailable" };
	}
	return { baselineBytes, postTeardownBytes, sampler: "ps" };
}

export function buildMemoryFixture(
	workload: MemoryWorkload,
	profile: MemoryWorkloadProfile,
	targetDurationMs: number,
): PerfCorpusFixtureResult {
	const gc = (globalThis as { gc?: () => void }).gc;
	const minimumIterations = workloadIterations(profile);
	workload.teardown();
	gc?.();
	const processTreeBaselineRssBytes = processTreeRssBytes();
	gc?.();
	const baselineSample = { ...memorySample(performance.now()), elapsedMs: 0 };
	const startedAt = performance.now();
	const cpuStart = process.cpuUsage();
	const samples = [baselineSample];
	const highWaterSamples = {
		rss: baselineSample,
		heap: baselineSample,
		external: baselineSample,
		arrayBuffers: baselineSample,
	};
	let operations = 0;
	let iterations = 0;
	const chunkSize = profile === "soak" ? 1 : Math.max(1, Math.ceil(minimumIterations / 20));
	const sampleIntervalMs = profile === "soak" ? 50 : 0;
	const highWaterIntervalMs = profile === "soak" ? 10 : 0;
	let lastHighWaterSampleAt = Number.NEGATIVE_INFINITY;
	const captureHighWater = (force = false) => {
		const now = performance.now();
		if (!force && now - lastHighWaterSampleAt < highWaterIntervalMs) return;
		lastHighWaterSampleAt = now;
		const sample = memorySample(startedAt);
		updateMemoryHighWaterSamples(highWaterSamples, sample);
	};
	while (iterations < minimumIterations || performance.now() - startedAt < targetDurationMs) {
		operations += workload.run(chunkSize, captureHighWater);
		iterations += chunkSize;
		const elapsedSinceLastSample = performance.now() - startedAt - (samples.at(-1)?.elapsedMs ?? 0);
		if (elapsedSinceLastSample >= sampleIntervalMs) samples.push(memorySample(startedAt));
	}
	const elapsedMs = performance.now() - startedAt;
	if ((samples.at(-1)?.elapsedMs ?? 0) < elapsedMs) samples.push(memorySample(startedAt));
	const slopeSamples = [...samples];
	for (const sample of new Set(Object.values(highWaterSamples))) {
		if (sample !== baselineSample && !samples.includes(sample)) samples.push(sample);
	}
	samples.sort((left, right) => left.elapsedMs - right.elapsedMs);
	const cpu = process.cpuUsage(cpuStart);
	workload.teardown();
	gc?.();
	const postTeardown = memorySample(startedAt);
	const processTreePostTeardownRssBytes = processTreeRssBytes();
	const processTree = normalizeProcessTreeRss(processTreeBaselineRssBytes, processTreePostTeardownRssBytes);
	const baselineBytes = samples[0]?.rssBytes ?? null;
	const peakBytes = samples.reduce((peak, sample) => Math.max(peak, sample.rssBytes), 0);
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
			slopeSamples,
			postTeardown,
			rssSlopeBytesPerSecond: calculateMemorySlope(slopeSamples, "rssBytes"),
			heapSlopeBytesPerSecond: calculateMemorySlope(slopeSamples, "heapUsedBytes"),
			processTreeBaselineRssBytes: processTree.baselineBytes,
			processTreePostTeardownRssBytes: processTree.postTeardownBytes,
			processTreeSampler: processTree.sampler,
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

function isolatedMemoryEntry(surface: MemorySurface): string {
	if (surface === "agent-session") {
		return url.fileURLToPath(new URL("./memory-baseline-session-child.ts", import.meta.url));
	}
	if (surface === "tui") {
		return url.fileURLToPath(new URL("./memory-baseline-tui-child.ts", import.meta.url));
	}
	return import.meta.path;
}

function buildIsolatedMemoryFixtures(
	profile: MemoryWorkloadProfile,
	targetDurationMs: number,
): PerfCorpusFixtureResult[] {
	return REQUIRED_MEMORY_SURFACES.map(surface => {
		const result = Bun.spawnSync([process.execPath, "--smol", "--expose-gc", isolatedMemoryEntry(surface), MEMORY_CHILD_ARGUMENT], {
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
	const iterationsTarget = workloadIterations(profile);
	const initialGit = resolveGitProvenance();
	const fixtures: PerfCorpusFixtureResult[] = [
		buildFixture("startup-load", "startup-session-load", ["startup", "session-load"], startupWorkload, 0x51ed),
		buildFixture("streaming-ttft", "streaming-ttft", ["streaming", "ttft"], streamingWorkload, 0x9e37),
		buildFixture("large-transcript", "large-transcript", ["transcript", "scroll"], largeTranscriptWorkload, 0xc0de),
		...(options.isolatedMemory
			? buildIsolatedMemoryFixtures(profile, durationTargetMs)
			: buildMemoryFixtures(profile, durationTargetMs)),
	];
	const finalGit = resolveGitProvenance();
	if (
		initialGit.sha !== finalGit.sha ||
		initialGit.dirty !== finalGit.dirty ||
		initialGit.worktreeFingerprint !== finalGit.worktreeFingerprint
	) {
		throw new Error("benchmark checkout provenance changed while workloads were running");
	}
	const git = initialGit;
	const invocation = reproductionInvocation(profile, durationTargetMs, iterationsTarget);
	const report: PerfCorpusReport = {
		schema: PERF_CORPUS_SCHEMA,
		generatedAt: new Date().toISOString(),
		gitSha: git.sha,
		gitDirty: git.dirty,
		runner: {
			command: invocation.command,
			argv: invocation.argv,
			environment: invocation.environment,
			platform: process.platform,
			arch: process.arch,
			bunVersion: process.versions.bun,
			ci: process.env.CI === "true",
			profile,
			durationTargetMs,
			memoryIsolation: options.isolatedMemory ? "process-per-surface" : "in-process",
			iterationsTarget,
			gcExposed: typeof globalThis.gc === "function",
			memoryChildGcExposed: options.isolatedMemory ? true : typeof globalThis.gc === "function",
			memoryChildExecArgv: options.isolatedMemory ? ["--smol", "--expose-gc"] : [],
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
	const childSurface = process.argv.includes(MEMORY_CHILD_ARGUMENT) ? process.env.GJC_MEMORY_CHILD_SURFACE : undefined;
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
