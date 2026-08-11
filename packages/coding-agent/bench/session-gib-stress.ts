import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SessionManager, type SessionMemoryStats, type StrictSessionCaptureResult } from "../src/session/session-manager";

const SOURCE_ENTRY_COUNT = 1_023;
const PAYLOAD_BYTES = 1024 * 1024;
const TARGET_TRANSCRIPT_BYTES = 1024 ** 3 - PAYLOAD_BYTES;
const FULL_PAYLOAD_ENTRY_COUNT = SOURCE_ENTRY_COUNT - 1;
const LOOKUP_COUNT = 16;
const DEFAULT_ITERATIONS = 3;
const SCHEMA_VERSION = 2;

type Mode = "direct" | "captured";
type OperationClass = "direct-fork" | "captured-fork";
type GcStrategy = "current" | "none" | "async" | "pressure";
type SecondaryArtifacts = "current" | "off" | "lazy";

type MemorySample = {
	rssBytes: number;
	heapUsedBytes: number;
	heapTotalBytes: number;
	externalBytes: number;
	arrayBuffersBytes: number;
};

type CpuMetric = {
	userMicros: number;
	systemMicros: number;
};

type PhaseMetric = {
	elapsedMs: number;
	cpu: CpuMetric | null;
};

type ForkPhaseEvidence = {
	wholeFork: PhaseMetric | null;
	preflightScan: PhaseMetric | null;
	copyScan: PhaseMetric | null;
	stagedWriterPublication: PhaseMetric | null;
	destinationFirstOpen: PhaseMetric | null;
	sourceRevalidation: PhaseMetric | null;
};

type CounterEvidence = {
	gcRequests: number | null;
	gcElapsedMs: number | null;
	bytesRead: number | null;
	bytesWritten: number | null;
	recordsParsed: number | null;
	indexWriteCalls: number | null;
	fsyncCount: number | null;
};

type Summary = {
	min: number;
	median: number;
	p95: number;
	max: number;
};

type TelemetryValue = number | boolean | string | null;

type WorkerResult = {
	mode: Mode;
	operationClass: OperationClass;
	gcStrategy: GcStrategy;
	secondaryArtifacts: SecondaryArtifacts;
	repetitions: number;
	sourceBytes: number;
	destinationBytes: number;
	outputToSourceRatio: number;
	phases: {
		fixtureGeneration: PhaseMetric;
		capture?: PhaseMetric;
		fork: PhaseMetric;
		closeFork: PhaseMetric;
		reopen: PhaseMetric;
		coldLookups: PhaseMetric;
		warmLookups: PhaseMetric;
		buildContext: PhaseMetric;
		closeReopened: PhaseMetric;
	};
	phaseEvidence: ForkPhaseEvidence;
	counters: CounterEvidence;
	throughput: {
		fixtureGenerationMiBPerSecond: number;
		forkMiBPerSecond: number;
	};
	latency: {
		coldLookupMs: Summary & { samples: number[] };
		warmLookupMs: Summary & { samples: number[] };
	};
	memory: {
		baseline: MemorySample;
		afterFixture: MemorySample;
		afterCapture: MemorySample;
		afterFork: MemorySample;
		afterForkClose: MemorySample;
		afterReopen: MemorySample;
		afterColdLookups: MemorySample;
		afterWarmLookups: MemorySample;
		afterContext: MemorySample;
		afterTeardown: MemorySample;
		forkRssGrowthBytes: number;
		reopenRssGrowthBytes: number;
		lookupRssGrowthBytes: number;
		teardownRssGrowthBytes: number;
		maxRssBytes: number;
	};
	io: {
		coldRangeReads: number;
		warmRangeReads: number;
		coldEntriesReloaded: number;
	};
	guards: {
		contextMessageCount: number;
		lookupPayloadBytes: number;
	};
	forkStats: SessionMemoryStats;
	reopenStats: SessionMemoryStats;
	sessionMemoryTelemetry: Record<string, TelemetryValue>;
};

type BenchmarkReport = {
	schemaVersion: number;
	bench: "session-gib-stress";
	generatedAt: string;
	gitSha: string | null;
	platform: NodeJS.Platform;
	arch: string;
	cpu: string | null;
	bunVersion: string;
	gcStrategy: GcStrategy;
	secondaryArtifacts: SecondaryArtifacts;
	repetitions: number;
	operations: OperationClass[];
	fixture: {
		entryCount: number;
		nominalPayloadBytes: number;
		fullPayloadEntryCount: number;
		targetTranscriptBytes: number;
		lookupCount: number;
	};
	iterationsPerMode: number;
	runs: WorkerResult[];
	summary: Partial<Record<Mode, {
		forkElapsedMs: Summary;
		forkCpuMicros: Summary | null;
		forkRssGrowthBytes: Summary;
		reopenElapsedMs: Summary;
		coldLookupP95Ms: Summary;
		warmLookupP95Ms: Summary;
		teardownRssGrowthBytes: Summary;
	}>>;

};

function percentile(sorted: number[], percentileValue: number): number {
	if (sorted.length === 0) return 0;
	const index = Math.min(sorted.length - 1, Math.ceil((percentileValue / 100) * sorted.length) - 1);
	return sorted[index] ?? 0;
}

function summarize(values: number[]): Summary {
	const sorted = [...values].sort((left, right) => left - right);
	return {
		min: sorted[0] ?? 0,
		median: percentile(sorted, 50),
		p95: percentile(sorted, 95),
		max: sorted.at(-1) ?? 0,
	};
}

function memorySample(): MemorySample {
	Bun.gc(true);
	const usage = process.memoryUsage();
	return {
		rssBytes: usage.rss,
		heapUsedBytes: usage.heapUsed,
		heapTotalBytes: usage.heapTotal,
		externalBytes: usage.external,
		arrayBuffersBytes: usage.arrayBuffers,
	};
}

async function settledMemorySample(): Promise<MemorySample> {
	await Bun.sleep(0);
	Bun.gc(true);
	await Bun.sleep(0);
	return memorySample();
}

async function measure<T>(operation: () => T | Promise<T>): Promise<{ value: T; metric: PhaseMetric }> {
	const cpuStart = process.cpuUsage();
	const startedAt = performance.now();
	const value = await operation();
	const elapsedMs = performance.now() - startedAt;
	const cpu = process.cpuUsage(cpuStart);
	return { value, metric: { elapsedMs, cpu: { userMicros: cpu.user, systemMicros: cpu.system } } };
}

function parseMode(value: string | undefined): Mode {
	if (value === "direct" || value === "captured") return value;
	throw new Error("worker mode must be direct or captured");
}

function parseGcStrategy(value: string | undefined): GcStrategy {
	if (value === "current" || value === "none" || value === "async" || value === "pressure") return value;
	throw new Error(`invalid GC strategy: ${value ?? ""}`);
}

function parseSecondaryArtifacts(value: string | undefined): SecondaryArtifacts {
	if (value === "current" || value === "off" || value === "lazy") return value;
	throw new Error(`invalid secondary artifact mode: ${value ?? ""}`);
}

function benchmarkEnv(gcStrategy: GcStrategy, secondaryArtifacts: SecondaryArtifacts): NodeJS.ProcessEnv {
	return {
		...process.env,
		GJC_SESSION_MEMORY_GC_STRATEGY: gcStrategy,
		GJC_SESSION_MEMORY_SECONDARY_ARTIFACT_MODE:
			secondaryArtifacts === "current" ? "auto" : "disabled",
	};
}

function emptyForkPhaseEvidence(wholeFork: PhaseMetric | null = null): ForkPhaseEvidence {
	return { wholeFork, preflightScan: null, copyScan: null, stagedWriterPublication: null, destinationFirstOpen: null, sourceRevalidation: null };
}

function statsRecord(stats: SessionMemoryStats): Record<string, unknown> {
	return stats as unknown as Record<string, unknown>;
}

function firstOpenRecord(stats: SessionMemoryStats): Record<string, unknown> {
	const value = statsRecord(stats).firstOpen;
	return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function optionalNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function sessionTelemetry(stats: SessionMemoryStats): Record<string, TelemetryValue> {
	const telemetry: Record<string, TelemetryValue> = {};
	for (const [key, value] of Object.entries(statsRecord(stats))) {
		if (typeof value === "number" && Number.isFinite(value)) telemetry[key] = value;
		else if (typeof value === "boolean" || typeof value === "string") telemetry[key] = value;
	}
	return telemetry;
}

function counterFromStats(stats: SessionMemoryStats): CounterEvidence {
	const containers = [statsRecord(stats), firstOpenRecord(stats)];
	const read = (aliases: readonly string[]): number | null => {
		for (const container of containers) {
			for (const alias of aliases) {
				const value = optionalNumber(container[alias]);
				if (value !== undefined) return value;
			}
		}
		return null;
	};
	return {
		gcRequests: read(["gcRequests", "gcRequestCount", "forcedGcCount"]),
		gcElapsedMs: read(["gcElapsedMs", "gcTimeMs", "forcedGcElapsedMs"]),
		bytesRead: read(["bytesRead", "readBytes", "transcriptBytesRead"]),
		bytesWritten: read(["bytesWritten", "writeBytes", "sidecarBytesWritten"]),
		recordsParsed: read(["recordsParsed", "parsedRecordCount", "recordCount"]),
		indexWriteCalls: read(["indexWriteCalls", "indexWriteCount"]),
		fsyncCount: read(["fsyncCount", "fsyncCalls"]),
	};
}

function phaseEvidenceFromStats(stats: SessionMemoryStats[], wholeFork: PhaseMetric): ForkPhaseEvidence {
	const evidence = emptyForkPhaseEvidence(wholeFork);
	const names: Array<keyof ForkPhaseEvidence> = ["preflightScan", "copyScan", "stagedWriterPublication", "destinationFirstOpen", "sourceRevalidation"];
	for (const stat of stats) {
		const record = statsRecord(stat);
		for (const container of [record.phaseEvidence, record.phaseTelemetry, record.phaseTimings]) {
			if (!container || typeof container !== "object") continue;
			const values = container as Record<string, unknown>;
			for (const name of names) {
				if (evidence[name] !== null) continue;
				const candidate = values[name];
				if (typeof candidate === "number" && Number.isFinite(candidate)) {
					evidence[name] = { elapsedMs: candidate, cpu: null };
				} else if (candidate && typeof candidate === "object") {
					const value = candidate as Record<string, unknown>;
					const elapsedMs = optionalNumber(value.elapsedMs ?? value.wallMs ?? value.durationMs);
					if (elapsedMs !== undefined) {
						evidence[name] = {
							elapsedMs,
							cpu: null,
						};
					}
				}
			}
		}
	}
	return evidence;
}

async function generateFixture(sourceFile: string, root: string): Promise<void> {
	const writer = Bun.file(sourceFile).writer();
	await fs.chmod(sourceFile, 0o600);
	const payload = "x".repeat(PAYLOAD_BYTES);
	const serializeRecord = (value: unknown): string => `${JSON.stringify(value)}\n`;
	try {
		await writer.write(serializeRecord({ type: "session", version: 5, id: "gib-stress-source", timestamp: "0", cwd: root }));
		for (let index = 0; index < FULL_PAYLOAD_ENTRY_COUNT; index++) {
			await writer.write(
				serializeRecord({
					type: "custom",
					id: `entry-${index}`,
					parentId: index === 0 ? null : `entry-${index - 1}`,
					timestamp: "0",
					customType: "gib-stress",
					data: { index, payload },
				}),
			);
		}
		const finalIndex = SOURCE_ENTRY_COUNT - 1;
		const finalEntry = (finalPayload: string): string =>
			serializeRecord({
				type: "custom",
				id: `entry-${finalIndex}`,
				parentId: `entry-${finalIndex - 1}`,
				timestamp: "0",
				customType: "gib-stress",
				data: { index: finalIndex, payload: finalPayload },
			});
		const compaction = serializeRecord({
			type: "compaction",
			id: "gib-stress-compaction",
			parentId: `entry-${finalIndex}`,
			timestamp: "0",
			summary: "one GiB stress fixture",
			firstKeptEntryId: `entry-${finalIndex}`,
			tokensBefore: SOURCE_ENTRY_COUNT,
		});
		await writer.flush();
		const currentBytes = (await fs.stat(sourceFile)).size;
		const finalEntryOverhead = Buffer.byteLength(finalEntry(""));
		const remainingPayloadBytes = TARGET_TRANSCRIPT_BYTES - currentBytes - finalEntryOverhead - Buffer.byteLength(compaction);
		if (remainingPayloadBytes < 0 || remainingPayloadBytes > PAYLOAD_BYTES) {
			throw new Error(`cannot size exact GiB fixture: ${remainingPayloadBytes}`);
		}
		await writer.write(finalEntry("x".repeat(remainingPayloadBytes)));
		await writer.write(compaction);
		await writer.flush();
	} finally {
		await writer.end();
	}
}

function lookupIds(): string[] {
	return Array.from({ length: LOOKUP_COUNT }, (_, index) => {
		const ordinal = Math.floor((index * (SOURCE_ENTRY_COUNT - 2)) / Math.max(1, LOOKUP_COUNT - 1));
		return `entry-${ordinal}`;
	});
}

function lookup(manager: SessionManager, ids: string[]): { latencies: number[]; payloadBytes: number } {
	const latencies: number[] = [];
	let payloadBytes = 0;
	for (const id of ids) {
		const startedAt = performance.now();
		const entry = manager.getEntry(id);
		latencies.push(performance.now() - startedAt);
		if (entry?.type !== "custom") throw new Error(`missing custom entry ${id}`);
		const payload = (entry.data as { payload?: unknown }).payload;
		if (typeof payload !== "string") throw new Error(`missing payload for ${id}`);
		payloadBytes += Buffer.byteLength(payload);
	}
	return { latencies, payloadBytes };
}

async function runWorker(
	mode: Mode,
	gcStrategy: GcStrategy = "current",
	secondaryArtifacts: SecondaryArtifacts = "current",
	repetitions = DEFAULT_ITERATIONS,
): Promise<WorkerResult> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), `gjc-session-gib-stress-${mode}-`));
	const sourceFile = path.join(root, "source.jsonl");
	const destinationDirectory = path.join(root, "forks");
	await fs.mkdir(destinationDirectory);
	const baseline = memorySample();
	let captured: StrictSessionCaptureResult | undefined;
	let forkedManager: SessionManager | undefined;
	let reopenedManager: SessionManager | undefined;
	try {
		const fixture = await measure(() => generateFixture(sourceFile, root));
		const afterFixture = await settledMemorySample();
		const sourceBytes = Bun.file(sourceFile).size;
		if (sourceBytes !== TARGET_TRANSCRIPT_BYTES) throw new Error(`fixture size mismatch: ${sourceBytes}`);
		let captureMetric: PhaseMetric | undefined;
		if (mode === "captured") {
			const capture = await measure(() => SessionManager.captureTranscriptStrict(sourceFile));
			captured = capture.value;
			captureMetric = capture.metric;
			if (captured.kind !== "captured") throw new Error(`capture_${captured.reason}`);
		}
		const afterCapture = await settledMemorySample();
		const forkBaselineRss = afterCapture.rssBytes;
		const fork = await measure(async () => {
			if (captured?.kind === "captured") {
				const result = await SessionManager.forkFromCaptured(
					captured.snapshot,
					root,
					SessionManager.explicitDestination(destinationDirectory),
					"copy-retain",
					"enabled",
				);
				if (result.kind !== "forked") throw new Error(`captured_fork_${result.reason}`);
				return result.manager;
			}
			return SessionManager.forkFrom(
				sourceFile,
				root,
				SessionManager.explicitDestination(destinationDirectory),
				undefined,
				"copy-retain",
				"enabled",
			);
		});
		forkedManager = fork.value;
		const afterFork = await settledMemorySample();
		const forkStats = forkedManager.getSessionMemoryStats();
		const destinationFile = forkedManager.getSessionFile();
		if (!destinationFile) throw new Error("fork did not expose a destination file");
		const destinationBytes = Bun.file(destinationFile).size;
		const closeFork = await measure(() => forkedManager?.close());
		forkedManager = undefined;
		const afterForkClose = await settledMemorySample();
		const reopenBaselineRss = afterForkClose.rssBytes;
		const reopen = await measure(() =>
			SessionManager.open(
				destinationFile,
				SessionManager.explicitDestination(destinationDirectory),
				undefined,
				"copy-retain",
				"enabled",
			),
		);
		reopenedManager = reopen.value;
		const afterReopen = await settledMemorySample();
		const ids = lookupIds();
		const beforeColdStats = reopenedManager.getSessionMemoryStats();
		const cold = await measure(() => lookup(reopenedManager as SessionManager, ids));
		const afterColdLookups = await settledMemorySample();
		const afterColdStats = reopenedManager.getSessionMemoryStats();
		const warm = await measure(() => lookup(reopenedManager as SessionManager, ids));
		const afterWarmLookups = await settledMemorySample();
		const afterWarmStats = reopenedManager.getSessionMemoryStats();
		const context = await measure(() => reopenedManager?.buildSessionContext().messages.length ?? 0);
		const afterContext = await settledMemorySample();
		const reopenStats = reopenedManager.getSessionMemoryStats();
		const closeReopened = await measure(() => reopenedManager?.close());
		reopenedManager = undefined;
		captured?.kind === "captured" && captured.snapshot.close();
		captured = undefined;
		const afterTeardown = await settledMemorySample();
		return {
			operationClass: mode === "direct" ? "direct-fork" : "captured-fork",
			gcStrategy,
			secondaryArtifacts,
			repetitions,
			mode,
			sourceBytes,
			destinationBytes,
			outputToSourceRatio: destinationBytes / sourceBytes,
			phases: {
				fixtureGeneration: fixture.metric,
				capture: captureMetric,
				fork: fork.metric,
				closeFork: closeFork.metric,
				reopen: reopen.metric,
				coldLookups: cold.metric,
				warmLookups: warm.metric,
				buildContext: context.metric,
				closeReopened: closeReopened.metric,
			},
			phaseEvidence: phaseEvidenceFromStats([forkStats, reopenStats], fork.metric),
			counters: counterFromStats(reopenStats),
			throughput: {
				fixtureGenerationMiBPerSecond: sourceBytes / (1024 * 1024) / (fixture.metric.elapsedMs / 1_000),
				forkMiBPerSecond: sourceBytes / (1024 * 1024) / (fork.metric.elapsedMs / 1_000),
			},
			latency: {
				coldLookupMs: { samples: cold.value.latencies, ...summarize(cold.value.latencies) },
				warmLookupMs: { samples: warm.value.latencies, ...summarize(warm.value.latencies) },
			},
			memory: {
				baseline,
				afterFixture,
				afterCapture,
				afterFork,
				afterForkClose,
				afterReopen,
				afterColdLookups,
				afterWarmLookups,
				afterContext,
				afterTeardown,
				forkRssGrowthBytes: afterFork.rssBytes - forkBaselineRss,
				reopenRssGrowthBytes: afterReopen.rssBytes - reopenBaselineRss,
				lookupRssGrowthBytes: afterWarmLookups.rssBytes - afterReopen.rssBytes,
				teardownRssGrowthBytes: afterTeardown.rssBytes - baseline.rssBytes,
				maxRssBytes: process.resourceUsage().maxRSS * (process.platform === "darwin" ? 1 : 1024),
			},
			io: {
				coldRangeReads: afterColdStats.rangeReadCount - beforeColdStats.rangeReadCount,
				warmRangeReads: afterWarmStats.rangeReadCount - afterColdStats.rangeReadCount,
				coldEntriesReloaded: afterWarmStats.coldEntriesReloaded - beforeColdStats.coldEntriesReloaded,
			},
			guards: {
				contextMessageCount: context.value,
				lookupPayloadBytes: cold.value.payloadBytes + warm.value.payloadBytes,
			},
			forkStats,
			reopenStats,
			sessionMemoryTelemetry: {
				...sessionTelemetry(forkStats),
				...Object.fromEntries(Object.entries(sessionTelemetry(reopenStats)).map(([key, value]) => [`reopen.${key}`, value])),
			},
		};
	} finally {
		await forkedManager?.close();
		await reopenedManager?.close();
		if (captured?.kind === "captured") captured.snapshot.close();
		await fs.rm(root, { recursive: true, force: true });
	}
}

function gitSha(): string | null {
	const result = Bun.spawnSync({ cmd: ["git", "rev-parse", "HEAD"], stdout: "pipe", stderr: "ignore" });
	return result.exitCode === 0 ? result.stdout.toString().trim() : null;
}

function parseParentArgs(argv: string[]): { iterations: number; outPath?: string; gcStrategy: GcStrategy; secondaryArtifacts: SecondaryArtifacts; modes: Mode[] } {
	let iterations = DEFAULT_ITERATIONS;
	let outPath: string | undefined;
	let gcStrategy: GcStrategy = "current";
	let secondaryArtifacts: SecondaryArtifacts = "current";
	let modes: Mode[] = ["direct", "captured"];
	for (let index = 2; index < argv.length; index++) {
		const argument = argv[index];
		if (argument === "--iterations" || argument === "--repetitions") {
			const value = Number.parseInt(argv[++index] ?? "", 10);
			if (!Number.isSafeInteger(value) || value < 1 || value > 100) throw new Error("--repetitions must be between 1 and 100");
			iterations = value;
		} else if (argument === "--gc-strategy") {
			gcStrategy = parseGcStrategy(argv[++index]);
		} else if (argument === "--secondary-artifacts") {
			secondaryArtifacts = parseSecondaryArtifacts(argv[++index]);
		} else if (argument === "--modes" || argument === "--mode" || argument === "--operation" || argument === "--operations") {
			const values = (argv[++index] ?? "").split(",").map(value => value.trim()).filter(Boolean).map(value => {
				if (value === "direct-fork") return "direct" as const;
				if (value === "captured-fork") return "captured" as const;
				return parseMode(value);
			});
			if (values.length === 0) throw new Error("--modes requires at least one mode");
			modes = values;
		} else if (argument === "--out") {
			outPath = argv[++index];
			if (!outPath) throw new Error("--out requires a path");
		} else {
			throw new Error(`unknown argument: ${argument}`);
		}
	}
	return { iterations, outPath, gcStrategy, secondaryArtifacts, modes };
}

function summarizeMode(runs: WorkerResult[], mode: Mode): NonNullable<BenchmarkReport["summary"][Mode]> | undefined {
	const selected = runs.filter(run => run.mode === mode);
	if (selected.length === 0) return undefined;
	return {
		forkElapsedMs: summarize(selected.map(run => run.phases.fork.elapsedMs)),
		forkCpuMicros: selected.some(run => run.phases.fork.cpu)
			? summarize(selected.flatMap(run => run.phases.fork.cpu ? [run.phases.fork.cpu.userMicros + run.phases.fork.cpu.systemMicros] : []))
			: null,
		forkRssGrowthBytes: summarize(selected.map(run => run.memory.forkRssGrowthBytes)),
		reopenElapsedMs: summarize(selected.map(run => run.phases.reopen.elapsedMs)),
		coldLookupP95Ms: summarize(selected.map(run => run.latency.coldLookupMs.p95)),
		warmLookupP95Ms: summarize(selected.map(run => run.latency.warmLookupMs.p95)),
		teardownRssGrowthBytes: summarize(selected.map(run => run.memory.teardownRssGrowthBytes)),
	};
}

async function runParent(): Promise<void> {
	const args = parseParentArgs(Bun.argv);
	const runs: WorkerResult[] = [];
	for (const mode of args.modes) {
		for (let iteration = 0; iteration < args.iterations; iteration++) {
			const child = Bun.spawnSync({
				cmd: [process.execPath, "--smol", "--expose-gc", import.meta.path, "--worker", mode, args.gcStrategy, args.secondaryArtifacts, String(args.iterations)],
				stdout: "pipe",
				stderr: "pipe",
				env: benchmarkEnv(args.gcStrategy, args.secondaryArtifacts),
			});
			if (child.exitCode !== 0) throw new Error(child.stderr.toString() || `worker exited ${child.exitCode}`);
			runs.push(JSON.parse(child.stdout.toString()) as WorkerResult);
		}
	}
	const report: BenchmarkReport = {
		schemaVersion: SCHEMA_VERSION,
		bench: "session-gib-stress",
		generatedAt: new Date().toISOString(),
		gitSha: gitSha(),
		platform: process.platform,
		arch: process.arch,
		cpu: os.cpus()[0]?.model ?? null,
		bunVersion: Bun.version,
		gcStrategy: args.gcStrategy,
		secondaryArtifacts: args.secondaryArtifacts,
		repetitions: args.iterations,
		operations: args.modes.map(mode => mode === "direct" ? "direct-fork" : "captured-fork"),
		fixture: {
			entryCount: SOURCE_ENTRY_COUNT,
			nominalPayloadBytes: PAYLOAD_BYTES,
			fullPayloadEntryCount: FULL_PAYLOAD_ENTRY_COUNT,
			targetTranscriptBytes: TARGET_TRANSCRIPT_BYTES,
			lookupCount: LOOKUP_COUNT,
		},
		iterationsPerMode: args.iterations,
		runs,
		summary: Object.fromEntries(
			args.modes.flatMap(mode => {
				const value = summarizeMode(runs, mode);
				return value ? [[mode, value]] : [];
			}),
		) as BenchmarkReport["summary"],
	};
	const serialized = `${JSON.stringify(report, null, 2)}\n`;
	if (args.outPath) await Bun.write(args.outPath, serialized);
	process.stdout.write(serialized);
}

if (Bun.argv[2] === "--worker") {
	const mode = parseMode(Bun.argv[3]);
	const gcStrategy = parseGcStrategy(Bun.argv[4] ?? "current");
	const secondaryArtifacts = parseSecondaryArtifacts(Bun.argv[5] ?? "current");
	const repetitions = Number.parseInt(Bun.argv[6] ?? String(DEFAULT_ITERATIONS), 10);
	if (!Number.isSafeInteger(repetitions) || repetitions < 1) throw new Error("invalid worker repetitions");
	process.stdout.write(`${JSON.stringify(await runWorker(mode, gcStrategy, secondaryArtifacts, repetitions))}\n`);
} else {
	await runParent();
}
