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

import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as url from "node:url";
import { APPLIED_PERF_THRESHOLDS } from "./perf-threshold.ledger";
import { createMemoryBaselineWorkloads, type MemoryWorkload, workloadIterations } from "./memory-baseline-workloads";
import {
	calculateMemorySlope,
	memoryRuntimeControlIdentity,
	isExactMemorySurfaceOrder,
	MEMORY_CAPTURE_SEMANTICS_ID,
	type MemoryUsageSample,
	type MemoryObservedExtrema,
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

export interface MeasurementRuntimeProvenance {
	bunVersion: string;
	bunExecutable: string;
	bunExecutableSha256: string;
	closureDigest: string;
	closureManifest: readonly string[];
}

const MEASUREMENT_CLOSURE_SELECTORS: readonly string[] = [
	"bun.lock",
	"Cargo.lock",
	"Cargo.toml",
	"package.json",
	"packages/agent/package.json",
	"packages/agent/src",
	"packages/ai/package.json",
	"packages/ai/src",
	"packages/coding-agent/package.json",
	"packages/coding-agent/bench",
	"packages/coding-agent/src",
	"packages/natives/package.json",
	"packages/natives/native",
	"packages/tui/package.json",
	"packages/tui/src",
	"packages/utils/package.json",
	"packages/utils/src",
];
const LOGICAL_RUNNER_SCRIPT = "packages/coding-agent/bench/perf-corpus.bench.ts";
const CANONICAL_RUNNER_MODULE_MAIN = import.meta.main;
const CANONICAL_RUNNER_EXEC_ARGV: readonly (readonly string[])[] = [
	[],
	["--smol"],
	["--expose-gc"],
	["--smol", "--expose-gc"],
];

function isCanonicalRunnerExecArgv(value: readonly string[]): boolean {
	return CANONICAL_RUNNER_EXEC_ARGV.some(
		expected => value.length === expected.length && value.every((argument, index) => argument === expected[index]),
	);
}

function kernelProcessArguments(): string[] {
	if (process.platform === "linux") {
		return fs
			.readFileSync(`/proc/${process.pid}/cmdline`, "utf8")
			.split("\0")
			.filter(Boolean);
	}
	if (process.platform === "darwin") {
		const result = childProcess.spawnSync("/bin/ps", ["-ww", "-p", String(process.pid), "-o", "args="]);
		if (result.status !== 0) {
			throw new Error("kernel process arguments unavailable");
		}
		return new TextDecoder()
			.decode(result.stdout)
			.trim()
			.split(/\s+/)
			.filter(Boolean);
	}
	throw new Error("kernel process arguments unavailable");
}

function authenticateCanonicalRunnerEntrypoint(): readonly string[] {
	if (!CANONICAL_RUNNER_MODULE_MAIN) {
		throw new Error("benchmark runner invocation is outside the frozen public contract");
	}
	const actualEntrypoint = Bun.main;
	const argvEntrypoint = process.argv[1];
	let canonicalEntrypoint: string;
	let resolvedActualEntrypoint: string;
	let resolvedArgvEntrypoint: string;
	let kernelExecArgv: string[];
	let resolvedKernelEntrypoint: string;
	try {
		canonicalEntrypoint = fs.realpathSync(import.meta.path);
		resolvedActualEntrypoint = fs.realpathSync(actualEntrypoint);
		resolvedArgvEntrypoint = fs.realpathSync(argvEntrypoint ?? "");
		const kernelArguments = kernelProcessArguments();
		const kernelEntrypoint = kernelArguments.at(-1);
		kernelExecArgv = kernelArguments.slice(1, -1);
		resolvedKernelEntrypoint = fs.realpathSync(kernelEntrypoint ?? "");
	} catch (error) {
		throw new Error("benchmark runner invocation is outside the frozen public contract", { cause: error });
	}
	if (
		resolvedActualEntrypoint !== canonicalEntrypoint ||
		resolvedArgvEntrypoint !== canonicalEntrypoint ||
		resolvedKernelEntrypoint !== canonicalEntrypoint ||
		process.argv.length !== 2 ||
		!isCanonicalRunnerExecArgv(process.execArgv) ||
		!isCanonicalRunnerExecArgv(kernelExecArgv) ||
		process.execArgv.join("\0") !== kernelExecArgv.join("\0")
	) {
		throw new Error("benchmark runner invocation is outside the frozen public contract");
	}
	return kernelExecArgv;
}

function sha256Bytes(value: Uint8Array | string): string {
	return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

export function resolveMeasurementRuntimeProvenance(repositoryRoot: string): MeasurementRuntimeProvenance {
	const bunVersion = process.versions.bun;
	if (!bunVersion) throw new Error("Bun version unavailable");
	const bunExecutable = fs.realpathSync(process.execPath);
	const trackedClosure = Bun.spawnSync(
		["git", "ls-files", "-z", "--error-unmatch", "--", ...MEASUREMENT_CLOSURE_SELECTORS],
		{ cwd: repositoryRoot },
	);
	if (trackedClosure.exitCode !== 0) {
		throw new Error("measurement closure contains an untracked or missing source");
	}
	const closurePaths = new TextDecoder()
		.decode(trackedClosure.stdout)
		.split("\0")
		.filter(Boolean);
	const uniqueClosurePaths = [...new Set(closurePaths)].sort();
	const closureManifest = uniqueClosurePaths
		.map(relativePath => {
			const sourcePath = path.join(repositoryRoot, relativePath);
			return `${relativePath}:${sha256Bytes(fs.readFileSync(sourcePath))}`;
		})
		.sort();
	return {
		bunVersion,
		bunExecutable,
		bunExecutableSha256: sha256Bytes(fs.readFileSync(bunExecutable)),
		closureDigest: sha256Bytes(`${closureManifest.join("\n")}\n`),
		closureManifest,
	};
}

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
	const repositoryRoot = path.resolve(import.meta.dir, "../../..");
	let revision: Bun.SyncSubprocess<"pipe", "pipe">;
	try {
		revision = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: repositoryRoot });
	} catch (error) {
		throw new Error("git HEAD provenance unavailable", { cause: error });
	}
	if (revision.exitCode !== 0) {
		throw new Error("git HEAD provenance unavailable");
	}
	const sha = new TextDecoder().decode(revision.stdout).trim();
	if (!/^[0-9a-f]{40}$/i.test(sha)) {
		throw new Error("git HEAD provenance is not a full commit SHA");
	}
	const worktree = gitWorktreeFingerprint(repositoryRoot);
	return { sha, dirty: worktree.dirty, worktreeFingerprint: worktree.fingerprint };
}

function reproductionInvocation(
	runnerExecArgv: readonly string[],
	profile: MemoryWorkloadProfile,
	durationTargetMs: number,
	iterationsTarget: number,
	memorySurfaceOrder: readonly MemorySurface[],
): { command: string; argv: string[]; environment: Record<string, string> } {
	const environment: Record<string, string> = {
		GJC_MEMORY_PROFILE: profile,
		GJC_MEMORY_ITERATIONS: String(iterationsTarget),
		GJC_MEMORY_SURFACE_ORDER: memorySurfaceOrder.join(","),
	};
	if (profile === "soak") environment.GJC_MEMORY_DURATION_MS = String(durationTargetMs);
	const argv = ["bun", ...runnerExecArgv, LOGICAL_RUNNER_SCRIPT];
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
function createMemoryObservedExtrema(sample: MemoryUsageSample): MemoryObservedExtrema {
	return {
		rssBytes: { valueBytes: sample.rssBytes, elapsedMs: sample.elapsedMs },
		heapUsedBytes: { valueBytes: sample.heapUsedBytes, elapsedMs: sample.elapsedMs },
		externalBytes: { valueBytes: sample.externalBytes, elapsedMs: sample.elapsedMs },
		arrayBuffersBytes: { valueBytes: sample.arrayBuffersBytes, elapsedMs: sample.elapsedMs },
	};
}

export function updateMemoryObservedExtrema(extrema: MemoryObservedExtrema, sample: MemoryUsageSample): void {
	if (sample.rssBytes > extrema.rssBytes.valueBytes) {
		extrema.rssBytes = { valueBytes: sample.rssBytes, elapsedMs: sample.elapsedMs };
	}
	if (sample.heapUsedBytes > extrema.heapUsedBytes.valueBytes) {
		extrema.heapUsedBytes = { valueBytes: sample.heapUsedBytes, elapsedMs: sample.elapsedMs };
	}
	if (sample.externalBytes > extrema.externalBytes.valueBytes) {
		extrema.externalBytes = { valueBytes: sample.externalBytes, elapsedMs: sample.elapsedMs };
	}
	if (sample.arrayBuffersBytes > extrema.arrayBuffersBytes.valueBytes) {
		extrema.arrayBuffersBytes = { valueBytes: sample.arrayBuffersBytes, elapsedMs: sample.elapsedMs };
	}
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

function surfaceOrdinal(surface: MemorySurface): number {
	const configured = process.argv.includes(MEMORY_CHILD_ARGUMENT)
		? Number(process.env.GJC_MEMORY_SURFACE_ORDINAL)
		: Number.NaN;
	if (Number.isSafeInteger(configured) && configured >= 0 && configured < REQUIRED_MEMORY_SURFACES.length) {
		return configured;
	}
	return REQUIRED_MEMORY_SURFACES.indexOf(surface);
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
	const periodicSamples = [baselineSample];
	const observedExtrema = createMemoryObservedExtrema(baselineSample);
	let operations = 0;
	let iterations = 0;
	const chunkSize = profile === "soak" ? 1 : Math.max(1, Math.ceil(minimumIterations / 20));
	const periodicCadenceTargetMs = profile === "soak" ? 50 : 0;
	const highWaterCadenceTargetMs = profile === "soak" ? 10 : 0;
	let nextPeriodicDeadlineMs = periodicCadenceTargetMs;
	let periodicDeadlinesMissed = 0;
	let highWaterCallbacks = 0;
	let highWaterProbes = 0;
	let forcedHighWaterProbes = 0;
	let throttledHighWaterCallbacks = 0;
	let lastHighWaterSampleAt = Number.NEGATIVE_INFINITY;
	const capturePeriodic = () => {
		const sample = memorySample(startedAt);
		periodicSamples.push(sample);
		updateMemoryObservedExtrema(observedExtrema, sample);
	};
	const captureHighWater = (force = false) => {
		highWaterCallbacks++;
		const now = performance.now();
		if (!force && now - lastHighWaterSampleAt < highWaterCadenceTargetMs) {
			throttledHighWaterCallbacks++;
			return;
		}
		lastHighWaterSampleAt = now;
		highWaterProbes++;
		if (force) forcedHighWaterProbes++;
		updateMemoryObservedExtrema(observedExtrema, memorySample(startedAt));
	};
	while (iterations < minimumIterations || performance.now() - startedAt < targetDurationMs) {
		operations += workload.run(chunkSize, captureHighWater);
		iterations += chunkSize;
		if (periodicCadenceTargetMs === 0) {
			capturePeriodic();
			continue;
		}
		const elapsedMs = performance.now() - startedAt;
		if (elapsedMs >= nextPeriodicDeadlineMs) {
			const deadlinesReached = Math.floor((elapsedMs - nextPeriodicDeadlineMs) / periodicCadenceTargetMs) + 1;
			periodicDeadlinesMissed += deadlinesReached - 1;
			nextPeriodicDeadlineMs += deadlinesReached * periodicCadenceTargetMs;
			capturePeriodic();
		}
	}
	const loopCompletedElapsedMs = performance.now() - startedAt;
	if ((periodicSamples.at(-1)?.elapsedMs ?? 0) < loopCompletedElapsedMs) capturePeriodic();
	const elapsedMs = periodicSamples.at(-1)?.elapsedMs ?? loopCompletedElapsedMs;
	const cpu = process.cpuUsage(cpuStart);
	workload.teardown();
	gc?.();
	const postTeardown = memorySample(startedAt);
	const processTreePostTeardownRssBytes = processTreeRssBytes();
	const processTree = normalizeProcessTreeRss(processTreeBaselineRssBytes, processTreePostTeardownRssBytes);
	const baselineBytes = periodicSamples[0]?.rssBytes ?? null;
	const peakBytes = observedExtrema.rssBytes.valueBytes;
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
			heapBaselineBytes: periodicSamples[0]?.heapUsedBytes ?? null,
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
			ordinal: surfaceOrdinal(workload.surface),
			childPid: process.pid,
			parentPid: process.ppid,
			captureSemanticsId: MEMORY_CAPTURE_SEMANTICS_ID,
			profile,
			iterations,
			operations,
			operationsPerSecond: operations / Math.max(elapsedMs / 1_000, 1e-6),
			periodicSamples,
			observedExtrema,
			sampling: {
				periodicCadenceTargetMs,
				highWaterCadenceTargetMs,
				periodicDeadlinesMissed,
				highWaterCallbacks,
				highWaterProbes,
				forcedHighWaterProbes,
				throttledHighWaterCallbacks,
			},
			postTeardown,
			rssSlopeBytesPerSecond: calculateMemorySlope(periodicSamples, "rssBytes"),
			heapSlopeBytesPerSecond: calculateMemorySlope(periodicSamples, "heapUsedBytes"),
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
function resolveMemorySurfaceOrder(isolatedMemory: boolean): MemorySurface[] {
	if (!isolatedMemory) return [...REQUIRED_MEMORY_SURFACES];
	const configured = process.env.GJC_MEMORY_SURFACE_ORDER;
	if (configured === undefined) return [...REQUIRED_MEMORY_SURFACES];
	const order = configured.split(",");
	if (!isExactMemorySurfaceOrder(order)) {
		throw new Error(
			`GJC_MEMORY_SURFACE_ORDER must be an exact comma-separated permutation of: ${REQUIRED_MEMORY_SURFACES.join(",")}`,
		);
	}
	return order;
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
	memorySurfaceOrder: readonly MemorySurface[],
): PerfCorpusFixtureResult[] {
	return memorySurfaceOrder.map((surface, ordinal) => {
		const result = Bun.spawnSync([process.execPath, "--smol", "--expose-gc", isolatedMemoryEntry(surface), MEMORY_CHILD_ARGUMENT], {
			env: {
				...process.env,
				GJC_MEMORY_CHILD_SURFACE: surface,
				GJC_MEMORY_PROFILE: profile,
				GJC_MEMORY_DURATION_MS: String(targetDurationMs),
				GJC_MEMORY_SURFACE_ORDINAL: String(ordinal),
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

function computePerfCorpusBenchmark(
	runnerExecArgv: readonly string[],
	options: { isolatedMemory?: boolean } = {},
): PerfCorpusReport {
	const profile: MemoryWorkloadProfile = process.env.GJC_MEMORY_PROFILE === "soak" ? "soak" : "short";
	const configuredDurationMs = Number(process.env.GJC_MEMORY_DURATION_MS);
	const durationTargetMs =
		profile === "soak"
			? Number.isSafeInteger(configuredDurationMs) && configuredDurationMs >= 250 && configuredDurationMs <= 60_000
				? configuredDurationMs
				: 1_000
			: 0;
	const iterationsTarget = workloadIterations(profile);
	const memorySurfaceOrder = resolveMemorySurfaceOrder(options.isolatedMemory === true);
	const initialGit = resolveGitProvenance();
	const repositoryRoot = path.resolve(import.meta.dir, "../../..");
	const initialRuntime = resolveMeasurementRuntimeProvenance(repositoryRoot);
	const fixtures: PerfCorpusFixtureResult[] = [
		buildFixture("startup-load", "startup-session-load", ["startup", "session-load"], startupWorkload, 0x51ed),
		buildFixture("streaming-ttft", "streaming-ttft", ["streaming", "ttft"], streamingWorkload, 0x9e37),
		buildFixture("large-transcript", "large-transcript", ["transcript", "scroll"], largeTranscriptWorkload, 0xc0de),
		...(options.isolatedMemory
			? buildIsolatedMemoryFixtures(profile, durationTargetMs, memorySurfaceOrder)
			: buildMemoryFixtures(profile, durationTargetMs)),
	];
	const finalGit = resolveGitProvenance();
	const finalRuntime = resolveMeasurementRuntimeProvenance(repositoryRoot);
	if (
		initialGit.sha !== finalGit.sha ||
		initialGit.dirty !== finalGit.dirty ||
		initialGit.worktreeFingerprint !== finalGit.worktreeFingerprint ||
		initialRuntime.bunVersion !== finalRuntime.bunVersion ||
		initialRuntime.bunExecutable !== finalRuntime.bunExecutable ||
		initialRuntime.bunExecutableSha256 !== finalRuntime.bunExecutableSha256 ||
		initialRuntime.closureDigest !== finalRuntime.closureDigest
	) {
		throw new Error("benchmark checkout provenance changed while workloads were running");
	}
	const git = initialGit;
	const invocation = reproductionInvocation(runnerExecArgv, profile, durationTargetMs, iterationsTarget, memorySurfaceOrder);
	const runner: PerfCorpusReport["runner"] = {
		command: invocation.command,
		runtimeCommand: invocation.command,
		runtimeControlIdentity: "",
		argv: invocation.argv,
		environment: invocation.environment,
		platform: process.platform,
		arch: process.arch,
		bunVersion: initialRuntime.bunVersion,
		bunExecutable: "bun",
		bunExecutableSha256: initialRuntime.bunExecutableSha256,
		worktreeFingerprint: git.worktreeFingerprint,
		closureDigest: initialRuntime.closureDigest,
		closureManifest: initialRuntime.closureManifest,
		ci: process.env.CI === "true",
		profile,
		durationTargetMs,
		memoryIsolation: options.isolatedMemory ? "process-per-surface" : "in-process",
		memorySurfaceOrder,
		iterationsTarget,
		gcExposed: typeof globalThis.gc === "function",
		memoryChildGcExposed: options.isolatedMemory ? true : typeof globalThis.gc === "function",
		memoryChildExecArgv: options.isolatedMemory ? ["--smol", "--expose-gc"] : [],
		runnerPid: process.pid,
	};
	runner.runtimeControlIdentity = memoryRuntimeControlIdentity(runner);
	const report: PerfCorpusReport = {
		schema: PERF_CORPUS_SCHEMA,
		generatedAt: new Date().toISOString(),
		gitSha: git.sha,
		gitDirty: git.dirty,
		runner,
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

export function runPerfCorpusBenchmark(options: { isolatedMemory?: boolean } = {}): PerfCorpusReport {
	return computePerfCorpusBenchmark(authenticateCanonicalRunnerEntrypoint(), options);
}

if (CANONICAL_RUNNER_MODULE_MAIN) {
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
