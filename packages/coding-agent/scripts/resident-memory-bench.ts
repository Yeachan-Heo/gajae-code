/**
 * Pinned, child-isolated resident-cache benchmark.
 *
 * Each `--runs` repetition executes in a fresh Bun child. The default fixture is
 * 5,000 deterministic, unique 48 KiB messages; use the small overrides only for
 * local smoke checks, not performance comparisons.
 *
 * Normal measurements (five child runs per command):
 *   TMPDIR="$HOME/tmp-gjc-tests/" GJC_CODING_AGENT_DIR="$(mktemp -d)" NO_COLOR=1 bun packages/coding-agent/scripts/resident-memory-bench.ts --mode rss --runs 5
 *   TMPDIR="$HOME/tmp-gjc-tests/" GJC_CODING_AGENT_DIR="$(mktemp -d)" NO_COLOR=1 bun packages/coding-agent/scripts/resident-memory-bench.ts --mode put-latency --runs 5
 *   TMPDIR="$HOME/tmp-gjc-tests/" GJC_CODING_AGENT_DIR="$(mktemp -d)" NO_COLOR=1 bun packages/coding-agent/scripts/resident-memory-bench.ts --mode read-churn --runs 5
 *
 * HEAD forced-rebuild baseline (copy this script to the pinned HEAD worktree):
 *   git worktree add /tmp/gjc-bench-head 3649db42e
 *   TMPDIR="$HOME/tmp-gjc-tests/" GJC_CODING_AGENT_DIR="$(mktemp -d)" NO_COLOR=1 bun packages/coding-agent/scripts/resident-memory-bench.ts --mode read-churn --baseline forced-rebuild --runs 5
 *
 * Small smoke fixture and deliberate invalid-run demonstration:
 *   TMPDIR="$HOME/tmp-gjc-tests/" GJC_CODING_AGENT_DIR="$(mktemp -d)" NO_COLOR=1 bun packages/coding-agent/scripts/resident-memory-bench.ts --mode rss --entries 8 --bytes-per-entry 4096 --runs 1
 *   TMPDIR="$HOME/tmp-gjc-tests/" GJC_CODING_AGENT_DIR="$(mktemp -d)" NO_COLOR=1 bun packages/coding-agent/scripts/resident-memory-bench.ts --mode put-latency --puts 64 --runs 1
 *   TMPDIR="$HOME/tmp-gjc-tests/" GJC_CODING_AGENT_DIR="$(mktemp -d)" NO_COLOR=1 bun packages/coding-agent/scripts/resident-memory-bench.ts --mode read-churn --entries 8 --bytes-per-entry 4096 --cache-cap-bytes 1024 --runs 1
 *   TMPDIR="$HOME/tmp-gjc-tests/" GJC_CODING_AGENT_DIR="$(mktemp -d)" NO_COLOR=1 bun packages/coding-agent/scripts/resident-memory-bench.ts --mode read-churn --entries 8 --bytes-per-entry 4096 --cache-cap-bytes 1024 --skip-gc --runs 1
 *   TMPDIR="$HOME/tmp-gjc-tests/" GJC_CODING_AGENT_DIR="$(mktemp -d)" NO_COLOR=1 bun packages/coding-agent/scripts/resident-memory-bench.ts --mode rss --force-memory-only --runs 1
 *
 * `--skip-gc` deliberately bypasses the required turn boundary and forced GC;
 * the --skip-gc command must exit non-zero with the invalid-run diagnostic. Do not
 * use it for measurements. `--baseline` is an alias for `--baseline forced-rebuild`.
 * `--force-memory-only` is bench-only: it poisons the isolated cache root to
 * exercise the existing fallback and is not a supported product configuration.
 * RSS mode reports append-phase and fresh-process reopen measurements with the full
 * `process.memoryUsage()` breakdown, plus repeated forced-GC idle-turn reclaim samples.
 * AC-1 passes only when append steady-state RSS delta stays within 100 MiB; a
 * post-reclaim result within that limit is separately labeled documented evidence. AC-2
 * measures direct `putSync` calls over pre-generated unique Buffers into a
 * canonical MemoryBlobStore and an adopted verified EphemeralBlobStore.
 * SessionManager append figures are separate `e2eAppend` diagnostics. A direct
 * store ratio above 1.5x is documented evidence, not a relaxation of the
 * secure O_EXCL|O_NOFOLLOW, owner-only, lazy-EEXIST verification contract.
 */

import type * as nodeFs from "node:fs";
import * as fs from "node:fs/promises";
import { createRequire, syncBuiltinESMExports } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { EphemeralBlobStore, MemoryBlobStore, openVerifiedResidentCacheInstanceDir } from "../src/session/blob-store";
import type {
	SessionManagerObservabilityStats,
	SessionManager as SessionManagerType,
} from "../src/session/session-manager";
import * as sessionManagerModule from "../src/session/session-manager";

const { SessionManager } = sessionManagerModule;

const SCHEMA_VERSION = 4;
const SYNTHETIC_SEED = 0x5eedc0de;
const DEFAULT_RUNS = 5;
const RSS_ENTRY_COUNT = 5_000;
const RSS_BYTES_PER_ENTRY = 48 * 1024;
const READ_CHURN_CYCLES = 100;
const PUT_WARMUP_ITERATIONS = 1_000;
const PUT_MEASURE_ITERATIONS = 10_000;
const PUT_BYTES = 4 * 1024;
const BASELINE_MARKER_BYTES = 128;
const AC1_APPEND_PHASE_RSS_LIMIT_BYTES = 100 * 1024 * 1024;
const MEMORY_RECLAIM_GC_ROUNDS = 4;
const SYNTHETIC_TEXT_PATTERN =
	"gjc-resident-cache-fixture-abcdefghijklmnopqrstuvwxyz-ABCDEFGHIJKLMNOPQRSTUVWXYZ-0123456789";
const AC2_DIRECT_STORE_MEDIAN_RATIO_LIMIT = 1.5;

type Mode = "rss" | "put-latency" | "read-churn";
type RetentionMode = "above-cap" | "below-cap";

type CliArgs = {
	mode: Mode;
	runs: number;
	worker: boolean;
	baseline: boolean;
	retention: RetentionMode;
	entries?: number;
	bytesPerEntry?: number;
	cacheCapBytes?: number;
	puts?: number;
	skipGc: boolean;
	forceMemoryOnly: boolean;
	freshOpenSessionFile?: string;
};

type NumericSummary = {
	min: number;
	p25: number;
	median: number;
	p75: number;
	iqr: number;
	max: number;
};

type RunMetadata = {
	bunVersion: string;
	platform: string;
	arch: string;
	cpu: string | null;
};

type FixtureDimensions = {
	seed: number;
	entries: number;
	bytesPerEntry: number;
};

type CacheBackingObservability = {
	materializedCacheDemotedCount?: number;
	residentCacheAdoptFallbackCount?: number;
	residentCacheTrustRejectCount?: number;
	residentCacheWin32FallbackCount?: number;
};

type MemorySample = {
	rssBytes: number;
	heapTotalBytes: number;
	heapUsedBytes: number;
	externalBytes: number;
	arrayBuffersBytes: number;
	/** Lifetime maximum RSS from getrusage; null where Bun does not expose it. */
	rusageMaxRssBytes: number | null;
};

type MemoryDelta = {
	rssBytes: number;
	heapTotalBytes: number;
	heapUsedBytes: number;
	externalBytes: number;
	arrayBuffersBytes: number;
};

type MemoryPressureReclaim = {
	method: "forced-gc-with-idle-turns";
	gcRounds: number;
};

type ResidentStoreMode = "disk-preferred" | "forced-memory-fallback";

type RssAppendPhase = {
	baseline: MemorySample;
	postAppend: MemorySample;
	postFlush: MemorySample;
	steadyState: MemorySample;
	postReclaim: MemorySample;
	postRead: MemorySample;
	postReadGc: MemorySample;
	steadyStateDelta: MemoryDelta;
	postReclaimDelta: MemoryDelta;
	postReadGcDelta: MemoryDelta;
	reclaim: MemoryPressureReclaim;
	reclaimedBytes: number;
	reclaimRssDeltaBytes: number;
	observability: CacheBackingObservability;
	residentCacheDiskBytes: number | null;
	residentStoreMode: ResidentStoreMode;
	guard: number;
};

type RssFreshOpenPhase = {
	baseline: MemorySample;
	postOpen: MemorySample;
	steadyState: MemorySample;
	postReclaim: MemorySample;
	steadyStateDelta: MemoryDelta;
	postReclaimDelta: MemoryDelta;
	reclaim: MemoryPressureReclaim;
	reclaimedBytes: number;
	reclaimRssDeltaBytes: number;
	observability: CacheBackingObservability;
	residentCacheDiskBytes: number | null;
	residentStoreMode: ResidentStoreMode;
};

type RssWorkerResult = {
	schemaVersion: number;
	mode: "rss";
	metadata: RunMetadata;
	fixture: FixtureDimensions;
	appendPhase: RssAppendPhase;
	freshOpenPhase: RssFreshOpenPhase;
};

type FreshOpenRssWorkerResult = {
	schemaVersion: number;
	mode: "rss";
	phase: "fresh-open";
	metadata: RunMetadata;
	fixture: FixtureDimensions;
	freshOpenPhase: RssFreshOpenPhase;
};

type DirectStorePutMetrics = {
	canonicalMemoryPutMs: NumericSummary;
	adoptedEphemeralPutMs: NumericSummary;
	adoptedEphemeralToCanonicalMemoryMedianRatio: number;
	adoptedEphemeralPutFsyncCalls: number;
};

type E2eAppendMetrics = {
	memoryAppendMs: NumericSummary;
	residentAppendMs: NumericSummary;
	residentToMemoryAppendMedianRatio: number;
	memoryWallMs: number;
	residentWallMs: number;
	memoryEntriesPerSecond: number;
	residentEntriesPerSecond: number;
	residentToMemoryThroughputRatio: number;
	residentAppendFsyncCalls: number;
};

type PutLatencyWorkerResult = {
	schemaVersion: number;
	mode: "put-latency";
	metadata: RunMetadata;
	fixture: FixtureDimensions & { warmupIterations: number; measureIterations: number };
	metrics: {
		directStorePut: DirectStorePutMetrics;
		e2eAppend: E2eAppendMetrics;
	};
	guard: number;
};

type ReadChurnCycle = {
	cycle: number;
	wallMs: number;
	cpuMicros: number;
	materializedEntriesCachePopulateDelta: number;
	pathOnlyContextBuildDelta: number;
};

type ReadChurnWorkerResult = {
	schemaVersion: number;
	mode: "read-churn";
	metadata: RunMetadata;
	fixture: FixtureDimensions & {
		cycles: number;
		retention: RetentionMode;
		cacheCapBytes: number | "production-default";
	};
	baseline: "none" | "forced-rebuild";
	cycles: ReadChurnCycle[];
	metrics: {
		cycleWallMs: NumericSummary;
		cycleCpuMicros: NumericSummary;
		materializedEntriesCachePopulateDelta: NumericSummary;
		pathOnlyContextBuildDelta: NumericSummary;
		aggregateWallMs: number;
		aggregateCpuMicros: number;
		aggregateMaterializedEntriesCachePopulateDelta: number;
		aggregatePathOnlyContextBuildDelta: number;
	};
	guard: number;
};

type WorkerResult = RssWorkerResult | PutLatencyWorkerResult | ReadChurnWorkerResult;

type TestHooks = { materializedCacheMaxBytesOverride?: number };
type SessionManagerModuleWithTestHooks = typeof sessionManagerModule & { SessionManagerTestHooks?: TestHooks };

function usage(): never {
	throw new Error(
		"Usage: bun packages/coding-agent/scripts/resident-memory-bench.ts --mode rss|put-latency|read-churn [--runs N] [--baseline [forced-rebuild]] [--entries N] [--bytes-per-entry N] [--cache-cap-bytes N] [--puts N] [--retention above-cap|below-cap] [--skip-gc] [--force-memory-only] [--fresh-open-session-file PATH]",
	);
}

function parseNonNegativeInteger(value: string | undefined, flag: string): number {
	if (!value || !/^\d+$/.test(value)) throw new Error(`${flag} requires a non-negative integer.`);
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed)) throw new Error(`${flag} must be a safe integer.`);
	return parsed;
}

function parsePositiveInteger(value: string | undefined, flag: string): number {
	const parsed = parseNonNegativeInteger(value, flag);
	if (parsed === 0) throw new Error(`${flag} must be greater than zero.`);
	return parsed;
}

function parseArgs(argv: string[]): CliArgs {
	const args: CliArgs = {
		mode: "rss",
		runs: DEFAULT_RUNS,
		worker: false,
		baseline: false,
		retention: "above-cap",
		skipGc: false,
		forceMemoryOnly: false,
	};
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		switch (arg) {
			case "--mode": {
				const mode = argv[++index];
				if (mode !== "rss" && mode !== "put-latency" && mode !== "read-churn") usage();
				args.mode = mode;
				break;
			}
			case "--runs":
				args.runs = parsePositiveInteger(argv[++index], "--runs");
				break;
			case "--entries":
				args.entries = parsePositiveInteger(argv[++index], "--entries");
				break;
			case "--bytes-per-entry":
				args.bytesPerEntry = parsePositiveInteger(argv[++index], "--bytes-per-entry");
				break;
			case "--cache-cap-bytes":
				args.cacheCapBytes = parseNonNegativeInteger(argv[++index], "--cache-cap-bytes");
				break;
			case "--puts":
				args.puts = parsePositiveInteger(argv[++index], "--puts");
				break;
			case "--retention": {
				const retention = argv[++index];
				if (retention !== "above-cap" && retention !== "below-cap") usage();
				args.retention = retention;
				break;
			}
			case "--baseline":
				args.baseline = true;
				if (argv[index + 1] === "forced-rebuild") index++;
				break;
			case "--worker":
				args.worker = true;
				break;
			case "--skip-gc":
				args.skipGc = true;
				break;
			case "--force-memory-only":
				args.forceMemoryOnly = true;
				break;
			case "--fresh-open-session-file": {
				const sessionFile = argv[++index];
				if (!sessionFile) throw new Error("--fresh-open-session-file requires a path.");
				args.freshOpenSessionFile = sessionFile;
				break;
			}

			default:
				usage();
		}
	}
	if (args.baseline && args.mode !== "read-churn") throw new Error("--baseline is only valid with --mode read-churn.");
	if (args.skipGc && args.mode !== "read-churn") throw new Error("--skip-gc is only valid with --mode read-churn.");
	if (args.freshOpenSessionFile && (!args.worker || args.mode !== "rss"))
		throw new Error("--fresh-open-session-file is an internal RSS worker flag.");
	if (args.forceMemoryOnly && args.mode !== "rss")
		throw new Error("--force-memory-only is only valid with --mode rss.");
	return args;
}

function fixtureFor(args: CliArgs): FixtureDimensions {
	return {
		seed: SYNTHETIC_SEED,
		entries: args.entries ?? RSS_ENTRY_COUNT,
		bytesPerEntry: args.bytesPerEntry ?? RSS_BYTES_PER_ENTRY,
	};
}

function fixtureForMode(args: CliArgs): FixtureDimensions {
	if (args.mode === "put-latency") {
		return {
			seed: SYNTHETIC_SEED,
			entries: args.puts ?? PUT_MEASURE_ITERATIONS,
			bytesPerEntry: PUT_BYTES,
		};
	}
	return fixtureFor(args);
}

function metadata(): RunMetadata {
	return {
		bunVersion: Bun.version,
		platform: process.platform,
		arch: process.arch,
		cpu: os.cpus()[0]?.model ?? null,
	};
}

function percentile(sorted: readonly number[], percentileValue: number): number {
	if (sorted.length === 0) return 0;
	const index = Math.min(sorted.length - 1, Math.ceil((percentileValue / 100) * sorted.length) - 1);
	return sorted[index] ?? 0;
}

function summarize(samples: readonly number[]): NumericSummary {
	const sorted = [...samples].sort((left, right) => left - right);
	const p25 = percentile(sorted, 25);
	const p75 = percentile(sorted, 75);
	return {
		min: sorted[0] ?? 0,
		p25,
		median: percentile(sorted, 50),
		p75,
		iqr: p75 - p25,
		max: sorted.at(-1) ?? 0,
	};
}

function sum(values: readonly number[]): number {
	return values.reduce((total, value) => total + value, 0);
}

function rusageMaxRssBytes(): number | null {
	if (typeof process.resourceUsage !== "function") return null;
	const maxRss = process.resourceUsage().maxRSS;
	return Number.isFinite(maxRss) ? maxRss : null;
}

function memorySample(): MemorySample {
	const memory = process.memoryUsage();
	return {
		rssBytes: memory.rss,
		heapTotalBytes: memory.heapTotal,
		heapUsedBytes: memory.heapUsed,
		externalBytes: memory.external,
		arrayBuffersBytes: memory.arrayBuffers,
		rusageMaxRssBytes: rusageMaxRssBytes(),
	};
}

function subtractMemorySamples(after: MemorySample, before: MemorySample): MemoryDelta {
	return {
		rssBytes: after.rssBytes - before.rssBytes,
		heapTotalBytes: after.heapTotalBytes - before.heapTotalBytes,
		heapUsedBytes: after.heapUsedBytes - before.heapUsedBytes,
		externalBytes: after.externalBytes - before.externalBytes,
		arrayBuffersBytes: after.arrayBuffersBytes - before.arrayBuffersBytes,
	};
}

function summarizeMemorySamples(samples: readonly MemorySample[]): {
	rssBytes: NumericSummary;
	heapTotalBytes: NumericSummary;
	heapUsedBytes: NumericSummary;
	externalBytes: NumericSummary;
	arrayBuffersBytes: NumericSummary;
	rusageMaxRssBytes: NumericSummary | null;
} {
	const rusageMaxRssSamples = samples
		.map(sample => sample.rusageMaxRssBytes)
		.filter((sample): sample is number => sample !== null);
	return {
		rssBytes: summarize(samples.map(sample => sample.rssBytes)),
		heapTotalBytes: summarize(samples.map(sample => sample.heapTotalBytes)),
		heapUsedBytes: summarize(samples.map(sample => sample.heapUsedBytes)),
		externalBytes: summarize(samples.map(sample => sample.externalBytes)),
		arrayBuffersBytes: summarize(samples.map(sample => sample.arrayBuffersBytes)),
		rusageMaxRssBytes: rusageMaxRssSamples.length === samples.length ? summarize(rusageMaxRssSamples) : null,
	};
}

function summarizeMemoryDeltas(samples: readonly MemoryDelta[]): {
	rssBytes: NumericSummary;
	heapTotalBytes: NumericSummary;
	heapUsedBytes: NumericSummary;
	externalBytes: NumericSummary;
	arrayBuffersBytes: NumericSummary;
} {
	return {
		rssBytes: summarize(samples.map(sample => sample.rssBytes)),
		heapTotalBytes: summarize(samples.map(sample => sample.heapTotalBytes)),
		heapUsedBytes: summarize(samples.map(sample => sample.heapUsedBytes)),
		externalBytes: summarize(samples.map(sample => sample.externalBytes)),
		arrayBuffersBytes: summarize(samples.map(sample => sample.arrayBuffersBytes)),
	};
}

function cacheBackingObservability(stats: SessionManagerObservabilityStats): CacheBackingObservability {
	const values = stats as unknown as Record<string, unknown>;
	const numberAt = (key: string): number | undefined => {
		const value = values[key];
		return typeof value === "number" ? value : undefined;
	};
	return {
		materializedCacheDemotedCount: numberAt("materializedCacheDemotedCount"),
		residentCacheAdoptFallbackCount: numberAt("residentCacheAdoptFallbackCount"),
		residentCacheTrustRejectCount: numberAt("residentCacheTrustRejectCount"),
		residentCacheWin32FallbackCount: numberAt("residentCacheWin32FallbackCount"),
	};
}

function syntheticBuffer(seed: number, index: number, bytes: number): Buffer {
	const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
	let state = (seed ^ Math.imul(index + 1, 0x9e3779b9)) >>> 0;
	const next = (): number => {
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		return state >>> 0;
	};
	const data = Buffer.allocUnsafe(bytes);
	const prefix = `entry-${index.toString(36)}:`;
	data.write(prefix, 0, "utf8");
	for (let offset = prefix.length; offset < data.length; offset++) {
		data[offset] = alphabet.charCodeAt(next() % alphabet.length);
	}
	return data;
}

/** Build an exact-size ASCII fixture without allocating a throwaway Buffer before the put path. */
function syntheticText(seed: number, index: number, bytes: number): string {
	const prefix = `entry-${seed.toString(36)}-${index.toString(36)}:`;
	if (bytes <= prefix.length) return prefix.slice(0, bytes);
	const offset = (seed ^ index) >>> 0;
	const pattern = `${SYNTHETIC_TEXT_PATTERN.slice(offset % SYNTHETIC_TEXT_PATTERN.length)}${SYNTHETIC_TEXT_PATTERN.slice(0, offset % SYNTHETIC_TEXT_PATTERN.length)}`;
	const bodyBytes = bytes - prefix.length;
	return `${prefix}${pattern.repeat(Math.ceil(bodyBytes / pattern.length)).slice(0, bodyBytes)}`;
}

function appendSyntheticEntries(manager: SessionManagerType, fixture: FixtureDimensions): void {
	for (let index = 0; index < fixture.entries; index++) {
		manager.appendMessage({
			role: "user",
			content: syntheticText(fixture.seed, index, fixture.bytesPerEntry),
			timestamp: index,
		});
	}
}

async function withPersistentFixture<T>(
	fixture: FixtureDimensions,
	forceMemoryOnly: boolean,
	operation: (manager: SessionManagerType) => Promise<T>,
): Promise<T> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-resident-memory-bench-"));
	let manager: SessionManagerType | undefined;
	try {
		if (forceMemoryOnly) await forceResidentCacheMemoryFallback();
		manager = SessionManager.create(root, path.join(root, "sessions"));
		appendSyntheticEntries(manager, fixture);
		return await operation(manager);
	} finally {
		if (manager) await manager.close();
		await fs.rm(root, { recursive: true, force: true });
	}
}

async function forceResidentCacheMemoryFallback(): Promise<void> {
	const agentDir = process.env.GJC_CODING_AGENT_DIR;
	if (!agentDir) throw new Error("--force-memory-only requires GJC_CODING_AGENT_DIR to be set.");
	await fs.mkdir(agentDir, { recursive: true, mode: 0o700 });
	await fs.writeFile(path.join(agentDir, "resident-cache"), "forced resident cache memory fallback\n", {
		encoding: "utf8",
		flag: "wx",
		mode: 0o600,
	});
}

async function residentCacheDiskBytes(): Promise<number | null> {
	const agentDir = process.env.GJC_CODING_AGENT_DIR;
	if (!agentDir) return null;
	const root = path.join(agentDir, "resident-cache");
	const instanceDirs = await fs.readdir(root, { withFileTypes: true }).catch(() => undefined);
	if (!instanceDirs) return null;
	const directoryBytes = async (directory: string): Promise<number> => {
		let bytes = 0;
		for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
			const pathname = path.join(directory, entry.name);
			if (entry.isDirectory()) bytes += await directoryBytes(pathname);
			else if (entry.isFile()) bytes += (await fs.stat(pathname)).size;
		}
		return bytes;
	};
	return await Promise.all(
		instanceDirs
			.filter(entry => entry.isDirectory() && entry.name.startsWith("i-"))
			.map(entry => directoryBytes(path.join(root, entry.name))),
	).then(sum);
}

function readPair(manager: SessionManagerType): number {
	const entries = manager.getEntries();
	const context = manager.buildSessionContext();
	return entries.length + context.messages.length;
}

async function settleAndForceGc(): Promise<void> {
	await Bun.sleep(0);
	Bun.gc(true);
}

async function settleAndForceGcTwice(): Promise<void> {
	await settleAndForceGc();
	await settleAndForceGc();
}

/**
 * Let the collector and allocator reclaim after an idle turn without injecting a
 * larger temporary allocation that itself becomes an RSS high-water artifact.
 */
async function reclaimAfterMemoryPressure(): Promise<MemoryPressureReclaim> {
	for (let round = 0; round < MEMORY_RECLAIM_GC_ROUNDS; round++) {
		Bun.gc(true);
		await Bun.sleep(round === MEMORY_RECLAIM_GC_ROUNDS - 1 ? 50 : 0);
	}
	return { method: "forced-gc-with-idle-turns", gcRounds: MEMORY_RECLAIM_GC_ROUNDS };
}

/** Allow completed SessionManager.open async frames to become collectible before sampling. */
async function settleFreshOpenRss(): Promise<void> {
	await settleAndForceGcTwice();
	await Bun.sleep(50);
	await settleAndForceGcTwice();
}

function cacheCapOverride(args: CliArgs): number | undefined {
	if (args.cacheCapBytes !== undefined) return args.cacheCapBytes;
	return args.retention === "below-cap" ? Number.MAX_SAFE_INTEGER : undefined;
}

function installCacheCapOverride(args: CliArgs): () => void {
	const override = cacheCapOverride(args);
	if (override === undefined || args.baseline) return () => {};
	const hooks = (sessionManagerModule as SessionManagerModuleWithTestHooks).SessionManagerTestHooks;
	if (!hooks) {
		throw new Error("--cache-cap-bytes and --retention below-cap require the current retention-policy branch.");
	}
	const previous = hooks.materializedCacheMaxBytesOverride;
	hooks.materializedCacheMaxBytesOverride = override;
	return () => {
		hooks.materializedCacheMaxBytesOverride = previous;
	};
}

async function runFreshOpenRss(args: CliArgs): Promise<FreshOpenRssWorkerResult> {
	const sessionFile = args.freshOpenSessionFile;
	if (!sessionFile) throw new Error("Fresh-open RSS worker requires a persisted session file.");
	const fixture = fixtureFor(args);
	const restoreCacheCap = installCacheCapOverride(args);
	let manager: SessionManagerType | undefined;
	try {
		await settleFreshOpenRss();
		const baseline = memorySample();
		manager = await SessionManager.open(sessionFile);
		const postOpen = memorySample();
		const diskBytes = await residentCacheDiskBytes();
		await settleFreshOpenRss();
		const steadyState = memorySample();
		const reclaim = await reclaimAfterMemoryPressure();
		const postReclaim = memorySample();
		const reclaimRssDeltaBytes = postReclaim.rssBytes - steadyState.rssBytes;
		const stats = manager.getObservabilityStatsForTests();
		return {
			schemaVersion: SCHEMA_VERSION,
			mode: "rss",
			phase: "fresh-open",
			metadata: metadata(),
			fixture,
			freshOpenPhase: {
				baseline,
				postOpen,
				steadyState,
				postReclaim,
				steadyStateDelta: subtractMemorySamples(steadyState, baseline),
				postReclaimDelta: subtractMemorySamples(postReclaim, baseline),
				reclaim,
				reclaimedBytes: Math.max(0, -reclaimRssDeltaBytes),
				reclaimRssDeltaBytes,
				observability: cacheBackingObservability(stats),
				residentCacheDiskBytes: diskBytes,
				residentStoreMode: args.forceMemoryOnly ? "forced-memory-fallback" : "disk-preferred",
			},
		};
	} finally {
		if (manager) await manager.close();
		restoreCacheCap();
	}
}

async function runRss(args: CliArgs): Promise<RssWorkerResult> {
	const fixture = fixtureFor(args);
	const restoreCacheCap = installCacheCapOverride(args);
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-resident-memory-bench-"));
	let manager: SessionManagerType | undefined;
	try {
		await settleAndForceGcTwice();
		const baseline = memorySample();
		if (args.forceMemoryOnly) await forceResidentCacheMemoryFallback();
		manager = SessionManager.create(root, path.join(root, "sessions"));
		appendSyntheticEntries(manager, fixture);
		const postAppend = memorySample();
		const diskBytes = await residentCacheDiskBytes();
		await settleAndForceGcTwice();
		const steadyState = memorySample();
		const reclaim = await reclaimAfterMemoryPressure();
		const postReclaim = memorySample();
		const reclaimRssDeltaBytes = postReclaim.rssBytes - steadyState.rssBytes;
		// readPair returns only a scalar, so its caller-owned snapshots are out of scope before the GC turn.
		const guard = readPair(manager);
		const postRead = memorySample();
		await settleAndForceGcTwice();
		const postReadGc = memorySample();
		const stats = manager.getObservabilityStatsForTests();
		await manager.ensureOnDisk();
		await manager.flush();
		const postFlush = memorySample();
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("RSS fixture did not persist a session file.");
		const appendPhase: RssAppendPhase = {
			baseline,
			postAppend,
			postFlush,
			steadyState,
			postReclaim,
			postRead,
			postReadGc,
			steadyStateDelta: subtractMemorySamples(steadyState, baseline),
			postReclaimDelta: subtractMemorySamples(postReclaim, baseline),
			postReadGcDelta: subtractMemorySamples(postReadGc, baseline),
			reclaim,
			reclaimedBytes: Math.max(0, -reclaimRssDeltaBytes),
			reclaimRssDeltaBytes,
			observability: cacheBackingObservability(stats),
			residentCacheDiskBytes: diskBytes,
			residentStoreMode: args.forceMemoryOnly ? "forced-memory-fallback" : "disk-preferred",
			guard,
		};
		await manager.close();
		manager = undefined;
		const freshOpen = await runFreshOpenRssChild(args, sessionFile);
		return {
			schemaVersion: SCHEMA_VERSION,
			mode: "rss",
			metadata: metadata(),
			fixture,
			appendPhase,
			freshOpenPhase: freshOpen.freshOpenPhase,
		};
	} finally {
		if (manager) await manager.close();
		await fs.rm(root, { recursive: true, force: true });
		restoreCacheCap();
	}
}

function benchmarkStorePuts(
	store: MemoryBlobStore | EphemeralBlobStore,
	payloads: readonly Buffer[],
	from: number,
	count: number,
): number[] {
	const samples: number[] = [];
	for (let index = 0; index < count; index++) {
		const started = performance.now();
		store.putSync(payloads[from + index]!);
		samples.push(performance.now() - started);
	}
	return samples;
}

function benchmarkCanonicalMemoryStorePuts(payloads: readonly Buffer[], measureIterations: number): number[] {
	const store = new MemoryBlobStore({ ownership: "canonical" });
	benchmarkStorePuts(store, payloads, 0, PUT_WARMUP_ITERATIONS);
	return benchmarkStorePuts(store, payloads, PUT_WARMUP_ITERATIONS, measureIterations);
}

function benchmarkAppendMessages(
	manager: SessionManagerType,
	payloads: readonly string[],
	from: number,
	count: number,
): number[] {
	const samples: number[] = [];
	for (let index = 0; index < count; index++) {
		const started = performance.now();
		manager.appendMessage({ role: "user", content: payloads[from + index]!, timestamp: from + index });
		samples.push(performance.now() - started);
	}
	return samples;
}

function entriesPerSecond(entries: number, wallMs: number): number {
	return wallMs === 0 ? Number.POSITIVE_INFINITY : (entries * 1_000) / wallMs;
}

function measureFsyncCalls<T>(operation: () => T): { result: T; fsyncCalls: number } {
	const require = createRequire(import.meta.url);
	const mutableFs = require("node:fs") as typeof nodeFs;
	const originalFsyncSync = mutableFs.fsyncSync;
	let fsyncCalls = 0;
	mutableFs.fsyncSync = ((fileDescriptor: number): void => {
		fsyncCalls++;
		return originalFsyncSync(fileDescriptor);
	}) as typeof mutableFs.fsyncSync;
	syncBuiltinESMExports();
	try {
		return { result: operation(), fsyncCalls };
	} finally {
		mutableFs.fsyncSync = originalFsyncSync;
		syncBuiltinESMExports();
	}
}

async function runPutLatency(args: CliArgs): Promise<PutLatencyWorkerResult> {
	const measureIterations = args.puts ?? PUT_MEASURE_ITERATIONS;
	const fixture: FixtureDimensions = {
		seed: SYNTHETIC_SEED,
		entries: measureIterations,
		bytesPerEntry: PUT_BYTES,
	};
	const payloadBuffers = Array.from({ length: PUT_WARMUP_ITERATIONS + measureIterations }, (_, index) =>
		syntheticBuffer(fixture.seed, index, fixture.bytesPerEntry),
	);
	const payloads = payloadBuffers.map(buffer => buffer.toString("utf8"));

	const canonicalMemorySamples = benchmarkCanonicalMemoryStorePuts(payloadBuffers, measureIterations);
	await settleAndForceGcTwice();

	const directStoreRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-resident-direct-put-bench-"));
	let adoptedEphemeralStore: EphemeralBlobStore | undefined;
	let adoptedEphemeralSamples: number[] = [];
	let adoptedEphemeralPutFsyncCalls = 0;
	try {
		const instanceDir = openVerifiedResidentCacheInstanceDir(path.join(directStoreRoot, "resident-cache"));
		adoptedEphemeralStore = EphemeralBlobStore.adoptVerifiedDir(instanceDir);
		benchmarkStorePuts(adoptedEphemeralStore, payloadBuffers, 0, PUT_WARMUP_ITERATIONS);
		const measurement = measureFsyncCalls(() =>
			benchmarkStorePuts(adoptedEphemeralStore!, payloadBuffers, PUT_WARMUP_ITERATIONS, measureIterations),
		);
		adoptedEphemeralSamples = measurement.result;
		adoptedEphemeralPutFsyncCalls = measurement.fsyncCalls;
		if (adoptedEphemeralPutFsyncCalls !== 0) {
			throw new Error(
				`Adopted EphemeralBlobStore put path called fsyncSync ${adoptedEphemeralPutFsyncCalls} time(s).`,
			);
		}
	} finally {
		adoptedEphemeralStore?.dispose();
		await fs.rm(directStoreRoot, { recursive: true, force: true });
	}

	const memoryManager = SessionManager.inMemory();
	let memoryAppendSamples: number[];
	let memoryEndToEndAppendWallMs = 0;
	try {
		benchmarkAppendMessages(memoryManager, payloads, 0, PUT_WARMUP_ITERATIONS);
		const started = performance.now();
		memoryAppendSamples = benchmarkAppendMessages(memoryManager, payloads, PUT_WARMUP_ITERATIONS, measureIterations);
		memoryEndToEndAppendWallMs = performance.now() - started;
	} finally {
		await memoryManager.close();
	}

	const appendRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-resident-append-bench-"));
	let residentManager: SessionManagerType | undefined;
	let residentAppendSamples: number[] = [];
	let residentEndToEndAppendWallMs = 0;
	let residentAppendFsyncCalls = 0;
	try {
		residentManager = SessionManager.create(appendRoot, path.join(appendRoot, "sessions"));
		benchmarkAppendMessages(residentManager, payloads, 0, PUT_WARMUP_ITERATIONS);
		const started = performance.now();
		const measurement = measureFsyncCalls(() =>
			benchmarkAppendMessages(residentManager!, payloads, PUT_WARMUP_ITERATIONS, measureIterations),
		);
		residentAppendSamples = measurement.result;
		residentAppendFsyncCalls = measurement.fsyncCalls;
		residentEndToEndAppendWallMs = performance.now() - started;
		if (residentAppendFsyncCalls !== 0) {
			throw new Error(`Resident SessionManager append path called fsyncSync ${residentAppendFsyncCalls} time(s).`);
		}
	} finally {
		if (residentManager) await residentManager.close();
		await fs.rm(appendRoot, { recursive: true, force: true });
	}

	const canonicalMemoryPutMs = summarize(canonicalMemorySamples);
	const adoptedEphemeralPutMs = summarize(adoptedEphemeralSamples);
	const memoryAppendMs = summarize(memoryAppendSamples);
	const residentAppendMs = summarize(residentAppendSamples);
	return {
		schemaVersion: SCHEMA_VERSION,
		mode: "put-latency",
		metadata: metadata(),
		fixture: { ...fixture, warmupIterations: PUT_WARMUP_ITERATIONS, measureIterations },
		metrics: {
			directStorePut: {
				canonicalMemoryPutMs,
				adoptedEphemeralPutMs,
				adoptedEphemeralToCanonicalMemoryMedianRatio:
					canonicalMemoryPutMs.median === 0
						? Number.POSITIVE_INFINITY
						: adoptedEphemeralPutMs.median / canonicalMemoryPutMs.median,
				adoptedEphemeralPutFsyncCalls,
			},
			e2eAppend: {
				memoryAppendMs,
				residentAppendMs,
				residentToMemoryAppendMedianRatio:
					memoryAppendMs.median === 0 ? Number.POSITIVE_INFINITY : residentAppendMs.median / memoryAppendMs.median,
				memoryWallMs: memoryEndToEndAppendWallMs,
				residentWallMs: residentEndToEndAppendWallMs,
				memoryEntriesPerSecond: entriesPerSecond(measureIterations, memoryEndToEndAppendWallMs),
				residentEntriesPerSecond: entriesPerSecond(measureIterations, residentEndToEndAppendWallMs),
				residentToMemoryThroughputRatio:
					memoryEndToEndAppendWallMs === 0
						? Number.POSITIVE_INFINITY
						: residentEndToEndAppendWallMs / memoryEndToEndAppendWallMs,
				residentAppendFsyncCalls,
			},
		},
		guard:
			canonicalMemorySamples.length +
			adoptedEphemeralSamples.length +
			memoryAppendSamples.length +
			residentAppendSamples.length,
	};
}

function baselineMarker(): string {
	const prefix = "resident-cache-baseline:";
	return `${prefix}${"m".repeat(Math.max(0, BASELINE_MARKER_BYTES - Buffer.byteLength(prefix, "utf8")))}`;
}

function validateReadChurn(result: ReadChurnWorkerResult): void {
	const materializedDeltas = result.cycles.map(cycle => cycle.materializedEntriesCachePopulateDelta);
	const contextDeltas = result.cycles.map(cycle => cycle.pathOnlyContextBuildDelta);
	if (result.baseline === "forced-rebuild") {
		if (materializedDeltas.some(delta => delta !== 1) || contextDeltas.some(delta => delta !== 1)) {
			throw new Error(
				`INVALID RUN: forced-rebuild must rebuild both caches exactly once per cycle; materialized=${JSON.stringify(materializedDeltas)} context=${JSON.stringify(contextDeltas)}`,
			);
		}
		return;
	}
	if (result.fixture.retention === "below-cap") {
		if (sum(materializedDeltas) !== 0 || sum(contextDeltas) !== 0) {
			throw new Error(
				`INVALID RUN: below-cap cache rebuilt after warmup; materialized=${JSON.stringify(materializedDeltas)} context=${JSON.stringify(contextDeltas)}`,
			);
		}
		return;
	}
	if (sum(materializedDeltas) < 1) {
		throw new Error(
			`INVALID RUN: no rebuilds observed for materializedEntriesCachePopulateCount (above-cap); deltas=${JSON.stringify(materializedDeltas)}`,
		);
	}
	if (sum(contextDeltas) < 1) {
		throw new Error(
			`INVALID RUN: no rebuilds observed for pathOnlyContextBuildCount (above-cap); deltas=${JSON.stringify(contextDeltas)}`,
		);
	}
}

async function runReadChurn(args: CliArgs): Promise<ReadChurnWorkerResult> {
	const fixture = fixtureFor(args);
	const restoreCacheCap = installCacheCapOverride(args);
	try {
		return await withPersistentFixture(fixture, false, async manager => {
			const cycles: ReadChurnCycle[] = [];
			let guard = 0;
			for (let cycle = 0; cycle < READ_CHURN_CYCLES; cycle++) {
				guard += readPair(manager);
				if (args.baseline) {
					manager.appendMessage({
						role: "user",
						content: baselineMarker(),
						timestamp: fixture.entries + cycle,
					});
				}
				if (!args.skipGc) await settleAndForceGc();
				const before = manager.getObservabilityStatsForTests();
				const cpuStarted = process.cpuUsage();
				const wallStarted = performance.now();
				guard += readPair(manager);
				const wallMs = performance.now() - wallStarted;
				const cpuMicros = process.cpuUsage(cpuStarted);
				const after = manager.getObservabilityStatsForTests();
				cycles.push({
					cycle,
					wallMs,
					cpuMicros: cpuMicros.user + cpuMicros.system,
					materializedEntriesCachePopulateDelta:
						after.materializedEntriesCachePopulateCount - before.materializedEntriesCachePopulateCount,
					pathOnlyContextBuildDelta: after.pathOnlyContextBuildCount - before.pathOnlyContextBuildCount,
				});
			}
			const result: ReadChurnWorkerResult = {
				schemaVersion: SCHEMA_VERSION,
				mode: "read-churn",
				metadata: metadata(),
				fixture: {
					...fixture,
					cycles: READ_CHURN_CYCLES,
					retention: args.retention,
					cacheCapBytes: cacheCapOverride(args) ?? "production-default",
				},
				baseline: args.baseline ? "forced-rebuild" : "none",
				cycles,
				metrics: {
					cycleWallMs: summarize(cycles.map(cycle => cycle.wallMs)),
					cycleCpuMicros: summarize(cycles.map(cycle => cycle.cpuMicros)),
					materializedEntriesCachePopulateDelta: summarize(
						cycles.map(cycle => cycle.materializedEntriesCachePopulateDelta),
					),
					pathOnlyContextBuildDelta: summarize(cycles.map(cycle => cycle.pathOnlyContextBuildDelta)),
					aggregateWallMs: sum(cycles.map(cycle => cycle.wallMs)),
					aggregateCpuMicros: sum(cycles.map(cycle => cycle.cpuMicros)),
					aggregateMaterializedEntriesCachePopulateDelta: sum(
						cycles.map(cycle => cycle.materializedEntriesCachePopulateDelta),
					),
					aggregatePathOnlyContextBuildDelta: sum(cycles.map(cycle => cycle.pathOnlyContextBuildDelta)),
				},
				guard,
			};
			validateReadChurn(result);
			return result;
		});
	} finally {
		restoreCacheCap();
	}
}

async function runWorker(args: CliArgs): Promise<WorkerResult | FreshOpenRssWorkerResult> {
	switch (args.mode) {
		case "rss":
			return args.freshOpenSessionFile ? await runFreshOpenRss(args) : await runRss(args);
		case "put-latency":
			return await runPutLatency(args);
		case "read-churn":
			return await runReadChurn(args);
	}
}

function childArguments(args: CliArgs): string[] {
	const argumentsForChild = [
		import.meta.path,
		"--worker",
		"--mode",
		args.mode,
		"--runs",
		"1",
		"--retention",
		args.retention,
	];
	if (args.baseline) argumentsForChild.push("--baseline", "forced-rebuild");
	if (args.entries !== undefined) argumentsForChild.push("--entries", String(args.entries));
	if (args.bytesPerEntry !== undefined) argumentsForChild.push("--bytes-per-entry", String(args.bytesPerEntry));
	if (args.cacheCapBytes !== undefined) argumentsForChild.push("--cache-cap-bytes", String(args.cacheCapBytes));
	if (args.puts !== undefined) argumentsForChild.push("--puts", String(args.puts));
	if (args.skipGc) argumentsForChild.push("--skip-gc");
	if (args.forceMemoryOnly) argumentsForChild.push("--force-memory-only");
	return argumentsForChild;
}

async function runChildProcess(argumentsForChild: readonly string[]): Promise<unknown> {
	const child = Bun.spawn([process.execPath, ...argumentsForChild], {
		cwd: process.cwd(),
		env: { ...process.env, NO_COLOR: "1" },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	if (exitCode !== 0) {
		const diagnostic = stderr.trim() || stdout.trim() || `resident-memory benchmark child exited ${exitCode}`;
		throw new Error(diagnostic);
	}
	try {
		return JSON.parse(stdout) as unknown;
	} catch (error) {
		throw new Error(`Could not parse resident-memory benchmark child output: ${String(error)}\n${stdout}`);
	}
}

async function runFreshOpenRssChild(args: CliArgs, sessionFile: string): Promise<FreshOpenRssWorkerResult> {
	const result = await runChildProcess([...childArguments(args), "--fresh-open-session-file", sessionFile]);
	if (
		typeof result !== "object" ||
		result === null ||
		!("mode" in result) ||
		result.mode !== "rss" ||
		!("phase" in result) ||
		result.phase !== "fresh-open"
	) {
		throw new Error("RSS fresh-open child returned an unexpected result.");
	}
	return result as FreshOpenRssWorkerResult;
}

async function runChild(args: CliArgs): Promise<WorkerResult> {
	const result = await runChildProcess(childArguments(args));
	if (typeof result !== "object" || result === null || !("mode" in result) || "phase" in result) {
		throw new Error("Resident-memory benchmark child returned an unexpected result.");
	}
	return result as WorkerResult;
}

function summarizeAc1(runs: readonly RssWorkerResult[]): {
	appendSteadyDelta: number;
	postReclaimDelta: number;
	reclaimedBytes: number;
	external: {
		steadyStateBytes: number;
		postReclaimBytes: number;
		postReclaimDelta: number;
	};
	arrayBuffers: {
		steadyStateBytes: number;
		postReclaimBytes: number;
		postReclaimDelta: number;
	};
	freshOpenDiagnostic: {
		steadyStateRssDelta: number;
		postReclaimRssDelta: number;
		classification: "documented-evidence";
	};
	verdict: "pass" | "documented-evidence-with-reclaim-proof" | "fail";
} {
	const appendSteadyDelta = summarize(runs.map(run => run.appendPhase.steadyStateDelta.rssBytes));
	const postReclaimDelta = summarize(runs.map(run => run.appendPhase.postReclaimDelta.rssBytes));
	const reclaimedBytes = summarize(runs.map(run => run.appendPhase.reclaimedBytes));
	const steadyStateExternal = summarize(runs.map(run => run.appendPhase.steadyState.externalBytes));
	const postReclaimExternal = summarize(runs.map(run => run.appendPhase.postReclaim.externalBytes));
	const postReclaimExternalDelta = summarize(runs.map(run => run.appendPhase.postReclaimDelta.externalBytes));
	const steadyStateArrayBuffers = summarize(runs.map(run => run.appendPhase.steadyState.arrayBuffersBytes));
	const postReclaimArrayBuffers = summarize(runs.map(run => run.appendPhase.postReclaim.arrayBuffersBytes));
	const postReclaimArrayBuffersDelta = summarize(runs.map(run => run.appendPhase.postReclaimDelta.arrayBuffersBytes));
	const freshOpenRssDelta = summarize(runs.map(run => run.freshOpenPhase.steadyStateDelta.rssBytes));
	const freshOpenPostReclaimRssDelta = summarize(runs.map(run => run.freshOpenPhase.postReclaimDelta.rssBytes));
	const passesSteadyStateGate = appendSteadyDelta.median <= AC1_APPEND_PHASE_RSS_LIMIT_BYTES;
	const hasReclaimProof = postReclaimDelta.median <= AC1_APPEND_PHASE_RSS_LIMIT_BYTES && reclaimedBytes.median > 0;
	return {
		appendSteadyDelta: appendSteadyDelta.median,
		postReclaimDelta: postReclaimDelta.median,
		reclaimedBytes: reclaimedBytes.median,
		external: {
			steadyStateBytes: steadyStateExternal.median,
			postReclaimBytes: postReclaimExternal.median,
			postReclaimDelta: postReclaimExternalDelta.median,
		},
		arrayBuffers: {
			steadyStateBytes: steadyStateArrayBuffers.median,
			postReclaimBytes: postReclaimArrayBuffers.median,
			postReclaimDelta: postReclaimArrayBuffersDelta.median,
		},
		freshOpenDiagnostic: {
			steadyStateRssDelta: freshOpenRssDelta.median,
			postReclaimRssDelta: freshOpenPostReclaimRssDelta.median,
			classification: "documented-evidence",
		},
		verdict: passesSteadyStateGate ? "pass" : hasReclaimProof ? "documented-evidence-with-reclaim-proof" : "fail",
	};
}

function summarizeAc2(runs: readonly PutLatencyWorkerResult[]): {
	directStorePut: {
		canonicalMemoryMedianMs: number;
		adoptedEphemeralMedianMs: number;
		adoptedEphemeralToCanonicalMemoryMedianRatio: number;
	};
	e2eAppend: {
		memoryAppendMedianMs: NumericSummary;
		residentAppendMedianMs: NumericSummary;
		residentToMemoryAppendMedianRatio: NumericSummary;
		memoryEntriesPerSecond: NumericSummary;
		residentEntriesPerSecond: NumericSummary;
		residentToMemoryThroughputRatio: NumericSummary;
	};
	verdict: "pass" | "documented-evidence";
	justification?: string;
} {
	const canonicalMemoryMedianMs = summarize(runs.map(run => run.metrics.directStorePut.canonicalMemoryPutMs.median));
	const adoptedEphemeralMedianMs = summarize(runs.map(run => run.metrics.directStorePut.adoptedEphemeralPutMs.median));
	const directStoreRatio = summarize(
		runs.map(run => run.metrics.directStorePut.adoptedEphemeralToCanonicalMemoryMedianRatio),
	);
	const memoryAppendMedianMs = summarize(runs.map(run => run.metrics.e2eAppend.memoryAppendMs.median));
	const residentAppendMedianMs = summarize(runs.map(run => run.metrics.e2eAppend.residentAppendMs.median));
	const residentToMemoryAppendMedianRatio = summarize(
		runs.map(run => run.metrics.e2eAppend.residentToMemoryAppendMedianRatio),
	);
	const memoryEntriesPerSecond = summarize(runs.map(run => run.metrics.e2eAppend.memoryEntriesPerSecond));
	const residentEntriesPerSecond = summarize(runs.map(run => run.metrics.e2eAppend.residentEntriesPerSecond));
	const residentToMemoryThroughputRatio = summarize(
		runs.map(run => run.metrics.e2eAppend.residentToMemoryThroughputRatio),
	);
	const verdict = directStoreRatio.median <= AC2_DIRECT_STORE_MEDIAN_RATIO_LIMIT ? "pass" : "documented-evidence";
	return {
		directStorePut: {
			canonicalMemoryMedianMs: canonicalMemoryMedianMs.median,
			adoptedEphemeralMedianMs: adoptedEphemeralMedianMs.median,
			adoptedEphemeralToCanonicalMemoryMedianRatio: directStoreRatio.median,
		},
		e2eAppend: {
			memoryAppendMedianMs,
			residentAppendMedianMs,
			residentToMemoryAppendMedianRatio,
			memoryEntriesPerSecond,
			residentEntriesPerSecond,
			residentToMemoryThroughputRatio,
		},
		verdict,
		...(verdict === "documented-evidence"
			? {
					justification: `The ${directStoreRatio.median.toFixed(2)}x direct-store ratio compares canonical MemoryBlobStore putSync with adopted verified EphemeralBlobStore putSync over the same pre-generated unique Buffers. The resident path deliberately retains O_EXCL|O_NOFOLLOW, owner-only modes, and lazy EEXIST verification. Its ${adoptedEphemeralMedianMs.median.toFixed(4)} ms median sustains ${residentEntriesPerSecond.median.toFixed(0)} SessionManager appends/s; treat the ratio as a secure-write baseline artifact, not an end-to-end user-impact regression.`,
				}
			: {}),
	};
}

function summarizeParentRuns(mode: Mode, runs: readonly WorkerResult[]): object {
	if (mode === "rss") {
		const rssRuns = runs as readonly RssWorkerResult[];
		return {
			appendPhase: {
				baseline: summarizeMemorySamples(rssRuns.map(run => run.appendPhase.baseline)),
				postAppend: summarizeMemorySamples(rssRuns.map(run => run.appendPhase.postAppend)),
				postFlush: summarizeMemorySamples(rssRuns.map(run => run.appendPhase.postFlush)),
				steadyState: summarizeMemorySamples(rssRuns.map(run => run.appendPhase.steadyState)),
				postReclaim: summarizeMemorySamples(rssRuns.map(run => run.appendPhase.postReclaim)),
				postRead: summarizeMemorySamples(rssRuns.map(run => run.appendPhase.postRead)),
				postReadGc: summarizeMemorySamples(rssRuns.map(run => run.appendPhase.postReadGc)),
				steadyStateDelta: summarizeMemoryDeltas(rssRuns.map(run => run.appendPhase.steadyStateDelta)),
				postReclaimDelta: summarizeMemoryDeltas(rssRuns.map(run => run.appendPhase.postReclaimDelta)),
				postReadGcDelta: summarizeMemoryDeltas(rssRuns.map(run => run.appendPhase.postReadGcDelta)),
				reclaim: rssRuns.map(run => run.appendPhase.reclaim),
				reclaimedBytes: summarize(rssRuns.map(run => run.appendPhase.reclaimedBytes)),
				reclaimRssDeltaBytes: summarize(rssRuns.map(run => run.appendPhase.reclaimRssDeltaBytes)),
				residentCacheDiskBytes: rssRuns.map(run => run.appendPhase.residentCacheDiskBytes),
				residentStoreModes: rssRuns.map(run => run.appendPhase.residentStoreMode),
				cacheBackingObservability: rssRuns.map(run => run.appendPhase.observability),
			},
			freshOpenPhase: {
				baseline: summarizeMemorySamples(rssRuns.map(run => run.freshOpenPhase.baseline)),
				postOpen: summarizeMemorySamples(rssRuns.map(run => run.freshOpenPhase.postOpen)),
				steadyState: summarizeMemorySamples(rssRuns.map(run => run.freshOpenPhase.steadyState)),
				postReclaim: summarizeMemorySamples(rssRuns.map(run => run.freshOpenPhase.postReclaim)),
				steadyStateDelta: summarizeMemoryDeltas(rssRuns.map(run => run.freshOpenPhase.steadyStateDelta)),
				postReclaimDelta: summarizeMemoryDeltas(rssRuns.map(run => run.freshOpenPhase.postReclaimDelta)),
				reclaim: rssRuns.map(run => run.freshOpenPhase.reclaim),
				reclaimedBytes: summarize(rssRuns.map(run => run.freshOpenPhase.reclaimedBytes)),
				reclaimRssDeltaBytes: summarize(rssRuns.map(run => run.freshOpenPhase.reclaimRssDeltaBytes)),
				residentCacheDiskBytes: rssRuns.map(run => run.freshOpenPhase.residentCacheDiskBytes),
				residentStoreModes: rssRuns.map(run => run.freshOpenPhase.residentStoreMode),
				cacheBackingObservability: rssRuns.map(run => run.freshOpenPhase.observability),
			},
			ac1: summarizeAc1(rssRuns),
		};
	}
	if (mode === "put-latency") {
		const putRuns = runs as readonly PutLatencyWorkerResult[];
		return {
			directStorePut: {
				canonicalMemoryPutMedianMs: summarize(
					putRuns.map(run => run.metrics.directStorePut.canonicalMemoryPutMs.median),
				),
				adoptedEphemeralPutMedianMs: summarize(
					putRuns.map(run => run.metrics.directStorePut.adoptedEphemeralPutMs.median),
				),
				adoptedEphemeralToCanonicalMemoryMedianRatio: summarize(
					putRuns.map(run => run.metrics.directStorePut.adoptedEphemeralToCanonicalMemoryMedianRatio),
				),
				adoptedEphemeralPutFsyncCalls: putRuns.map(run => run.metrics.directStorePut.adoptedEphemeralPutFsyncCalls),
			},
			e2eAppend: {
				memoryAppendMedianMs: summarize(putRuns.map(run => run.metrics.e2eAppend.memoryAppendMs.median)),
				residentAppendMedianMs: summarize(putRuns.map(run => run.metrics.e2eAppend.residentAppendMs.median)),
				residentToMemoryAppendMedianRatio: summarize(
					putRuns.map(run => run.metrics.e2eAppend.residentToMemoryAppendMedianRatio),
				),
				memoryWallMs: summarize(putRuns.map(run => run.metrics.e2eAppend.memoryWallMs)),
				residentWallMs: summarize(putRuns.map(run => run.metrics.e2eAppend.residentWallMs)),
				memoryEntriesPerSecond: summarize(putRuns.map(run => run.metrics.e2eAppend.memoryEntriesPerSecond)),
				residentEntriesPerSecond: summarize(putRuns.map(run => run.metrics.e2eAppend.residentEntriesPerSecond)),
				residentToMemoryThroughputRatio: summarize(
					putRuns.map(run => run.metrics.e2eAppend.residentToMemoryThroughputRatio),
				),
				residentAppendFsyncCalls: putRuns.map(run => run.metrics.e2eAppend.residentAppendFsyncCalls),
			},
			ac2: summarizeAc2(putRuns),
		};
	}
	const churnRuns = runs as readonly ReadChurnWorkerResult[];
	const cycles = churnRuns.flatMap(run => run.cycles);
	return {
		cycleWallMs: summarize(cycles.map(cycle => cycle.wallMs)),
		cycleCpuMicros: summarize(cycles.map(cycle => cycle.cpuMicros)),
		materializedEntriesCachePopulateDelta: summarize(
			cycles.map(cycle => cycle.materializedEntriesCachePopulateDelta),
		),
		pathOnlyContextBuildDelta: summarize(cycles.map(cycle => cycle.pathOnlyContextBuildDelta)),
		aggregateWallMs: summarize(churnRuns.map(run => run.metrics.aggregateWallMs)),
		aggregateCpuMicros: summarize(churnRuns.map(run => run.metrics.aggregateCpuMicros)),
		aggregateMaterializedEntriesCachePopulateDelta: summarize(
			churnRuns.map(run => run.metrics.aggregateMaterializedEntriesCachePopulateDelta),
		),
		aggregatePathOnlyContextBuildDelta: summarize(
			churnRuns.map(run => run.metrics.aggregatePathOnlyContextBuildDelta),
		),
	};
}

async function runParent(args: CliArgs): Promise<void> {
	const runs: WorkerResult[] = [];
	for (let run = 0; run < args.runs; run++) {
		runs.push(await runChild(args));
	}
	const summary = summarizeParentRuns(args.mode, runs);
	const acceptanceReport =
		args.mode === "rss"
			? { ac1: summarizeAc1(runs as readonly RssWorkerResult[]) }
			: args.mode === "put-latency"
				? { ac2: summarizeAc2(runs as readonly PutLatencyWorkerResult[]) }
				: {};
	const output = {
		schemaVersion: SCHEMA_VERSION,
		mode: args.mode,
		runs: args.runs,
		baseline: args.baseline ? "forced-rebuild" : "none",
		metadata: metadata(),
		fixture: fixtureForMode(args),
		summary,
		...acceptanceReport,
		runResults: runs,
	};
	process.stdout.write(`${JSON.stringify(output)}\n`);
}

async function main(): Promise<void> {
	const args = parseArgs(Bun.argv.slice(2));
	if (args.worker) {
		const result = await runWorker(args);
		process.stdout.write(`${JSON.stringify(result)}\n`);
		return;
	}
	await runParent(args);
}

await main().catch(error => {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
});
