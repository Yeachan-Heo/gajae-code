/**
 * Profiling-corpus schema and evidence taxonomy.
 *
 * Successor to the static `docs/cpu-hotspot-map.json` ranking: future perf
 * prioritization comes from a real profiling corpus that keeps wall-clock,
 * process-CPU, and profiler self-time evidence as SEPARATE classes. A hotspot
 * may only be labeled `CPU-self-time confirmed` when profiler self-time
 * evidence exists; see `docs/perf-profiling-corpus.md` and
 * `docs/native-ffi-optimization-policy.md`.
 */

/** Evidence classes. These must never be conflated. */
export type EvidenceClass =
	| "wall-clock-proxy"
	| "process-cpu-usage"
	| "profiler-self-time"
	| "rss-memory"
	| "byte-parity"
	| "ledger-approved-threshold";

/** Optimization status vocabulary for a hotspot. */
export type HotspotStatus =
	| "CPU-self-time confirmed"
	| "fallback-toggle-confirmed"
	| "covered-current"
	| "not-visible"
	| "needs-trace-coverage";

/** Fixture workload classes the corpus must cover. */
export type FixtureClass = "startup-session-load" | "streaming-ttft" | "large-transcript" | "high-output-tool" | "edit-diff";

export type ParityVerdict = "pass" | "fail" | "not-run";

export type ProfilerKind = "bun" | "node" | "clinic" | "instruments" | "perf" | "other" | "none";

export interface WallClockPhaseMetric {
	elapsedMs: number;
	startMs?: number;
	p50Ms?: number;
	p95Ms?: number;
	/** Wall-clock thresholds start advisory until variance is characterized + ledger-approved. */
	advisoryOnly: boolean;
}

export interface ProcessCpuUsageMetric {
	userMicros: number;
	systemMicros: number;
	elapsedMs: number;
	cpuFraction?: number;
}

export interface ProfilerSelfTimeSample {
	symbol: string;
	selfTimeMs: number;
	totalTimeMs?: number;
	package?: string;
}

export interface ProfilerSelfTime {
	profiler: ProfilerKind;
	/** Set only when a real profiler artifact was captured. Required for CPU-self-time confirmation. */
	artifactPath?: string;
	samples?: ProfilerSelfTimeSample[];
}

export interface RssMemoryMetric {
	baselineBytes: number | null;
	peakBytes?: number | null;
	growthBytes: number;
	returnBytes: number | null;
	heapBaselineBytes?: number | null;
	heapReturnBytes?: number | null;
}
export type MemorySurface =
	| "cli"
	| "agent-session"
	| "blob-store"
	| "worker"
	| "telegram-daemon"
	| "tui"
	| "shared-native";

export type MemoryWorkloadProfile = "short" | "soak";

export interface MemoryUsageSample {
	elapsedMs: number;
	rssBytes: number;
	heapUsedBytes: number;
	heapTotalBytes: number;
	externalBytes: number;
	arrayBuffersBytes: number;
	activeResourceCount: number;
}
export type MemoryExtremumDomain = "rssBytes" | "heapUsedBytes" | "externalBytes" | "arrayBuffersBytes";

export interface MemoryObservedExtremum {
	valueBytes: number;
	elapsedMs: number;
}

export type MemoryObservedExtrema = Record<MemoryExtremumDomain, MemoryObservedExtremum>;

export const MEMORY_CAPTURE_SEMANTICS_ID = "gjc.memory-baseline.capture/3" as const;

export interface MemorySamplingMetadata {
	periodicCadenceTargetMs: number;
	highWaterCadenceTargetMs: number;
	periodicDeadlinesMissed: number;
	highWaterCallbacks: number;
	highWaterProbes: number;
	forcedHighWaterProbes: number;
	throttledHighWaterCallbacks: number;
}
const MEMORY_USAGE_SAMPLE_FIELDS = [
	"elapsedMs",
	"rssBytes",
	"heapUsedBytes",
	"heapTotalBytes",
	"externalBytes",
	"arrayBuffersBytes",
	"activeResourceCount",
] as const satisfies readonly (keyof MemoryUsageSample)[];

export interface MemoryBaselineMetric {
	surface: MemorySurface;
	ordinal: number;
	childPid: number;
	parentPid: number;
	captureSemanticsId: typeof MEMORY_CAPTURE_SEMANTICS_ID;
	profile: MemoryWorkloadProfile;
	iterations: number;
	operations: number;
	operationsPerSecond: number;
	periodicSamples: MemoryUsageSample[];
	observedExtrema: MemoryObservedExtrema;
	sampling: MemorySamplingMetadata;
	postTeardown: MemoryUsageSample;
	rssSlopeBytesPerSecond: number | null;
	heapSlopeBytesPerSecond: number | null;
	processTreeBaselineRssBytes: number | null;
	processTreePostTeardownRssBytes: number | null;
	processTreeSampler: "ps" | "unavailable";
}

export interface ByteParityMetric {
	renderedGolden?: ParityVerdict;
	persistedJsonlGolden?: ParityVerdict;
	providerPayloadGolden?: ParityVerdict;
	materializedSessionGolden?: ParityVerdict;
}

export interface PerfCorpusFixtureResult {
	fixtureId: string;
	fixtureClass: FixtureClass;
	sourceClass: "synthetic" | "sanitized-real" | "dogfood-redacted";
	workloadTags: string[];
	privacy: {
		/** Raw private transcripts must never be committed. */
		rawPrivateTranscriptCommitted: false;
		redactionNotes?: string;
	};
	wallClockPhase: Record<string, WallClockPhaseMetric>;
	processCpuUsage: Record<string, ProcessCpuUsageMetric>;
	profilerSelfTime: ProfilerSelfTime;
	rssMemory: RssMemoryMetric;
	byteParity: ByteParityMetric;
	memoryBaseline?: MemoryBaselineMetric;
}

export interface HotspotClassification {
	hotspotId: string;
	status: HotspotStatus;
	evidenceClass: EvidenceClass;
	artifactRefs: string[];
	notes: string;
}

export interface ThresholdLedgerReference {
	name: string;
	advisoryOrEnforced: "advisory" | "enforced";
}

export interface PerfCorpusReport {
	schema: "gjc.perf-corpus/3";
	generatedAt: string;
	gitSha: string;
	gitDirty: boolean;
	runner: {
		command: string;
		runtimeCommand: string;
		runtimeControlIdentity: string;
		argv: string[];
		environment: Record<string, string>;
		platform: NodeJS.Platform;
		arch: string;
		bunVersion: string;
		bunExecutable: string;
		bunExecutableSha256: string;
		worktreeFingerprint: string;
		closureDigest: string;
		closureManifest: readonly string[];
		ci?: boolean;
		profile: MemoryWorkloadProfile;
		durationTargetMs?: number;
		memoryIsolation: "in-process" | "process-per-surface";
		memorySurfaceOrder: MemorySurface[];
		iterationsTarget: number;
		gcExposed: boolean;
		memoryChildGcExposed: boolean;
		memoryChildExecArgv: string[];
		runnerPid: number;
	};
	fixtures: PerfCorpusFixtureResult[];
	hotspotClassifications: HotspotClassification[];
	thresholdLedger?: ThresholdLedgerReference[];
}

export const PERF_CORPUS_SCHEMA = "gjc.perf-corpus/3" as const;

export const REQUIRED_FIXTURE_CLASSES: readonly FixtureClass[] = ["startup-session-load", "streaming-ttft", "large-transcript"];
export const REQUIRED_MEMORY_SURFACES: readonly MemorySurface[] = [
	"cli",
	"agent-session",
	"blob-store",
	"worker",
	"telegram-daemon",
	"tui",
	"shared-native",
];
const MEMORY_WORKLOAD_PROFILES: readonly MemoryWorkloadProfile[] = ["short", "soak"];
const PROCESS_TREE_SAMPLERS: readonly MemoryBaselineMetric["processTreeSampler"][] = ["ps", "unavailable"];
const MEMORY_ISOLATION_MODES: readonly PerfCorpusReport["runner"]["memoryIsolation"][] = ["in-process", "process-per-surface"];
const SOURCE_CLASS_VALUES: readonly PerfCorpusFixtureResult["sourceClass"][] = [
	"synthetic",
	"sanitized-real",
	"dogfood-redacted",
];
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const LOGICAL_BUN_EXECUTABLE = "bun";
const LOGICAL_RUNNER_SCRIPT = "packages/coding-agent/bench/perf-corpus.bench.ts";
const LOGICAL_RUNNER_ARGV: readonly (readonly string[])[] = [
	[LOGICAL_BUN_EXECUTABLE, LOGICAL_RUNNER_SCRIPT],
	[LOGICAL_BUN_EXECUTABLE, "--smol", LOGICAL_RUNNER_SCRIPT],
	[LOGICAL_BUN_EXECUTABLE, "--expose-gc", LOGICAL_RUNNER_SCRIPT],
	[LOGICAL_BUN_EXECUTABLE, "--smol", "--expose-gc", LOGICAL_RUNNER_SCRIPT],
];

function isLogicalRunnerArgv(value: unknown): value is string[] {
	return (
		Array.isArray(value) &&
		LOGICAL_RUNNER_ARGV.some(
			expected =>
				value.length === expected.length && value.every((argument, index) => argument === expected[index]),
		)
	);
}
const REPORT_FIELDS = [
	"schema",
	"generatedAt",
	"gitSha",
	"gitDirty",
	"runner",
	"fixtures",
	"hotspotClassifications",
	"thresholdLedger",
] as const;
const RUNNER_FIELDS = [
	"command",
	"runtimeCommand",
	"runtimeControlIdentity",
	"argv",
	"environment",
	"platform",
	"arch",
	"bunVersion",
	"bunExecutable",
	"bunExecutableSha256",
	"worktreeFingerprint",
	"closureDigest",
	"closureManifest",
	"ci",
	"profile",
	"durationTargetMs",
	"memoryIsolation",
	"memorySurfaceOrder",
	"iterationsTarget",
	"gcExposed",
	"memoryChildGcExposed",
	"memoryChildExecArgv",
	"runnerPid",
] as const;
const FIXTURE_FIELDS = [
	"fixtureId",
	"fixtureClass",
	"sourceClass",
	"workloadTags",
	"privacy",
	"wallClockPhase",
	"processCpuUsage",
	"profilerSelfTime",
	"rssMemory",
	"byteParity",
	"memoryBaseline",
] as const;
const PRIVACY_FIELDS = ["rawPrivateTranscriptCommitted", "redactionNotes"] as const;
const WALL_CLOCK_FIELDS = ["elapsedMs", "startMs", "p50Ms", "p95Ms", "advisoryOnly"] as const;
const PROCESS_CPU_FIELDS = ["userMicros", "systemMicros", "elapsedMs", "cpuFraction"] as const;
const PROFILER_FIELDS = ["profiler", "artifactPath", "samples"] as const;
const PROFILER_SAMPLE_FIELDS = ["symbol", "selfTimeMs", "totalTimeMs", "package"] as const;
const RSS_MEMORY_FIELDS = [
	"baselineBytes",
	"peakBytes",
	"growthBytes",
	"returnBytes",
	"heapBaselineBytes",
	"heapReturnBytes",
] as const;
const BYTE_PARITY_FIELDS = [
	"renderedGolden",
	"persistedJsonlGolden",
	"providerPayloadGolden",
	"materializedSessionGolden",
] as const;
const MEMORY_BASELINE_FIELDS = [
	"surface",
	"ordinal",
	"childPid",
	"parentPid",
	"captureSemanticsId",
	"profile",
	"iterations",
	"operations",
	"operationsPerSecond",
	"periodicSamples",
	"observedExtrema",
	"sampling",
	"postTeardown",
	"rssSlopeBytesPerSecond",
	"heapSlopeBytesPerSecond",
	"processTreeBaselineRssBytes",
	"processTreePostTeardownRssBytes",
	"processTreeSampler",
] as const;
const HOTSPOT_CLASSIFICATION_FIELDS = ["hotspotId", "status", "evidenceClass", "artifactRefs", "notes"] as const;
const THRESHOLD_LEDGER_FIELDS = ["name", "advisoryOrEnforced"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rejectUnexpectedKeys(
	value: unknown,
	allowed: readonly string[],
	context: string,
	errors: string[],
): value is Record<string, unknown> {
	if (!isRecord(value)) {
		errors.push(`${context} must be an object`);
		return false;
	}
	for (const key of Object.keys(value)) {
		if (!allowed.includes(key)) errors.push(`${context}.${key} is not allowed`);
	}
	return true;
}

function sha256(value: string): string {
	return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

export function memoryRuntimeControlIdentity(runner: PerfCorpusReport["runner"]): string {
	const controls = {
		runtimeCommand: runner.runtimeCommand,
		argv: runner.argv,
		environment: runner.environment,
		platform: runner.platform,
		arch: runner.arch,
		bunVersion: runner.bunVersion,
		bunExecutable: runner.bunExecutable,
		bunExecutableSha256: runner.bunExecutableSha256,
		worktreeFingerprint: runner.worktreeFingerprint,
		closureDigest: runner.closureDigest,
		closureManifest: runner.closureManifest,
		profile: runner.profile,
		durationTargetMs: runner.durationTargetMs,
		memoryIsolation: runner.memoryIsolation,
		memorySurfaceOrder: runner.memorySurfaceOrder,
		iterationsTarget: runner.iterationsTarget,
		gcExposed: runner.gcExposed,
		memoryChildGcExposed: runner.memoryChildGcExposed,
		memoryChildExecArgv: runner.memoryChildExecArgv,
		runnerPid: runner.runnerPid,
		captureSemanticsId: MEMORY_CAPTURE_SEMANTICS_ID,
	};
	return sha256(JSON.stringify(controls));
}

function isValidClosureManifest(value: unknown): value is readonly string[] {
	if (!Array.isArray(value) || value.length === 0 || value.some(entry => typeof entry !== "string")) return false;
	const entries = value as string[];
	if (new Set(entries).size !== entries.length) return false;
	if (entries.some((entry, index) => index > 0 && entries[index - 1] >= entry)) return false;
	return entries.every(entry => {
		const separator = entry.lastIndexOf(":");
		if (separator <= 0) return false;
		const relativePath = entry.slice(0, separator);
		const digest = entry.slice(separator + 1);
		return (
			!relativePath.startsWith("/") &&
			!relativePath.includes("\\") &&
			!relativePath.split("/").includes("..") &&
			SHA256_PATTERN.test(digest)
		);
	});
}
export function isExactMemorySurfaceOrder(value: unknown): value is MemorySurface[] {
	return (
		Array.isArray(value) &&
		value.length === REQUIRED_MEMORY_SURFACES.length &&
		value.every(
			surface =>
				typeof surface === "string" && (REQUIRED_MEMORY_SURFACES as readonly string[]).includes(surface),
		) &&
		new Set(value).size === REQUIRED_MEMORY_SURFACES.length
	);
}

const MEMORY_EXTREMUM_DOMAINS: readonly MemoryExtremumDomain[] = [
	"rssBytes",
	"heapUsedBytes",
	"externalBytes",
	"arrayBuffersBytes",
];

const HOTSPOT_STATUS_VALUES: readonly HotspotStatus[] = [
	"CPU-self-time confirmed",
	"fallback-toggle-confirmed",
	"covered-current",
	"not-visible",
	"needs-trace-coverage",
];

export function isHotspotStatus(value: unknown): value is HotspotStatus {
	return typeof value === "string" && (HOTSPOT_STATUS_VALUES as readonly string[]).includes(value);
}

/** True when a profiler self-time artifact or non-empty samples exist. */
export function hasProfilerSelfTimeEvidence(profiler: ProfilerSelfTime): boolean {
	if (profiler.profiler === "none") return false;
	if (typeof profiler.artifactPath === "string" && profiler.artifactPath.trim().length > 0) return true;
	return Array.isArray(profiler.samples) && profiler.samples.length > 0;
}

/**
 * Validate a single classification in isolation. A `CPU-self-time confirmed`
 * status requires the `profiler-self-time` evidence class and at least one
 * artifact reference; a `fallback-toggle-confirmed` status requires comparable
 * (non wall-clock-only) evidence plus an artifact reference.
 */
export function validateHotspotClassification(c: HotspotClassification): string[] {
	const errors: string[] = [];
	if (!isHotspotStatus(c.status)) {
		errors.push(`hotspot ${c.hotspotId}: invalid status "${c.status}"`);
		return errors;
	}
	if (c.status === "CPU-self-time confirmed") {
		if (c.evidenceClass !== "profiler-self-time") {
			errors.push(`hotspot ${c.hotspotId}: "CPU-self-time confirmed" requires evidenceClass "profiler-self-time", got "${c.evidenceClass}"`);
		}
		if (c.artifactRefs.length === 0) {
			errors.push(`hotspot ${c.hotspotId}: "CPU-self-time confirmed" requires a profiler self-time artifact reference`);
		}
	}
	if (c.status === "fallback-toggle-confirmed") {
		if (c.evidenceClass === "wall-clock-proxy") {
			errors.push(`hotspot ${c.hotspotId}: "fallback-toggle-confirmed" needs comparable before/after evidence, not wall-clock-proxy alone`);
		}
		if (c.artifactRefs.length === 0) {
			errors.push(`hotspot ${c.hotspotId}: "fallback-toggle-confirmed" requires a toggle/before-after artifact reference`);
		}
	}
	return errors;
}

export function calculateMemorySlope(
	samples: MemoryUsageSample[],
	key: "rssBytes" | "heapUsedBytes",
): number | null {
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
function isValidMemoryByteValue(value: unknown): value is number {
	return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isValidMemoryUsageSample(value: unknown): value is MemoryUsageSample {
	if (!isRecord(value)) return false;
	return (
		Object.keys(value).length === MEMORY_USAGE_SAMPLE_FIELDS.length &&
		MEMORY_USAGE_SAMPLE_FIELDS.every(name => Object.hasOwn(value, name) && Number.isFinite(value[name]) && Number(value[name]) >= 0) &&
		isValidMemoryByteValue(value.rssBytes) &&
		isValidMemoryByteValue(value.heapUsedBytes) &&
		isValidMemoryByteValue(value.heapTotalBytes) &&
		isValidMemoryByteValue(value.externalBytes) &&
		isValidMemoryByteValue(value.arrayBuffersBytes) &&
		Number.isSafeInteger(value.activeResourceCount)
	);
}


/**
 * Validate a whole report. Beyond per-classification rules, a hotspot may not
 * be `CPU-self-time confirmed` unless the report actually carries profiler
 * self-time evidence (an `artifactPath` or non-empty `samples`) in at least one
 * fixture. This is the structural guard that prevents promoting wall-clock or
 * process-cpu proxy data into a CPU self-time claim.
 */
export function validatePerfCorpusReport(report: PerfCorpusReport): { ok: boolean; errors: string[] } {
	const errors: string[] = [];
	rejectUnexpectedKeys(report, REPORT_FIELDS, "report", errors);
	rejectUnexpectedKeys(report.runner, RUNNER_FIELDS, "runner", errors);
	const schema = (report as { schema?: unknown }).schema;
	if (schema === "gjc.perf-corpus/2") {
		errors.push(`schema "${schema}" is incompatible with the v3 validator; expected "${PERF_CORPUS_SCHEMA}"`);
	} else if (schema !== PERF_CORPUS_SCHEMA) {
		errors.push(`invalid schema "${String(schema)}", expected "${PERF_CORPUS_SCHEMA}"`);
	}
	if (!/^[0-9a-f]{40}$/i.test(report.gitSha)) {
		errors.push("gitSha must be a full 40-character commit SHA");
	}
	if (typeof report.gitDirty !== "boolean") {
		errors.push("gitDirty invalid");
	}
	if (typeof report.generatedAt !== "string" || !Number.isFinite(Date.parse(report.generatedAt))) {
		errors.push("generatedAt invalid");
	}
	if (!Number.isSafeInteger(report.runner.runnerPid) || report.runner.runnerPid <= 0) {
		errors.push("runner.runnerPid invalid");
	}
	if (typeof report.runner.runtimeCommand !== "string" || report.runner.runtimeCommand !== report.runner.command) {
		errors.push("runner.runtimeCommand must exactly match runner.command");
	}
	if (typeof report.runner.bunVersion !== "string" || report.runner.bunVersion.trim().length === 0) {
		errors.push("runner.bunVersion invalid");
	}
	if (report.runner.bunExecutable !== LOGICAL_BUN_EXECUTABLE) {
		errors.push('runner.bunExecutable must be the logical identifier "bun"');
	}
	if (!SHA256_PATTERN.test(report.runner.bunExecutableSha256)) {
		errors.push("runner.bunExecutableSha256 invalid");
	}
	if (!SHA256_PATTERN.test(report.runner.worktreeFingerprint)) {
		errors.push("runner.worktreeFingerprint invalid");
	}
	if (!isValidClosureManifest(report.runner.closureManifest)) {
		errors.push("runner.closureManifest invalid");
	} else {
		const expectedClosureDigest = sha256(`${report.runner.closureManifest.join("\n")}\n`);
		if (report.runner.closureDigest !== expectedClosureDigest) {
			errors.push("runner.closureDigest does not match closureManifest");
		}
	}
	if (!SHA256_PATTERN.test(report.runner.closureDigest)) {
		errors.push("runner.closureDigest invalid");
	}
	if (report.runner.runtimeControlIdentity !== memoryRuntimeControlIdentity(report.runner)) {
		errors.push("runner.runtimeControlIdentity does not match runtime controls");
	}
	if (!isLogicalRunnerArgv(report.runner.argv)) {
		errors.push("runner.argv must begin with bun and contain only logical repository-relative values");
	}
	if (
		typeof report.runner.command !== "string" ||
		!Array.isArray(report.runner.argv) ||
		report.runner.command !== report.runner.argv.join(" ")
	) {
		errors.push("runner.command must exactly match the logical runner.argv");
	}
	if (
		typeof report.runner.environment !== "object" ||
		report.runner.environment === null ||
		Object.values(report.runner.environment).some(value => typeof value !== "string")
	) {
		errors.push("runner.environment invalid");
	}
	const expectedEnvironmentKeys = [
		"GJC_MEMORY_ITERATIONS",
		"GJC_MEMORY_PROFILE",
		"GJC_MEMORY_SURFACE_ORDER",
		...(report.runner.profile === "soak" ? ["GJC_MEMORY_DURATION_MS"] : []),
	].sort();
	if (
		isRecord(report.runner.environment) &&
		Object.keys(report.runner.environment).sort().join("\0") !== expectedEnvironmentKeys.join("\0")
	) {
		errors.push("runner.environment contains unexpected capture controls");
	}
	if (!Number.isInteger(report.runner.iterationsTarget) || report.runner.iterationsTarget <= 0) {
		errors.push("runner.iterationsTarget invalid");
	}
	if (typeof report.runner.gcExposed !== "boolean") {
		errors.push("runner.gcExposed invalid");
	}
	if (typeof report.runner.memoryChildGcExposed !== "boolean") {
		errors.push("runner.memoryChildGcExposed invalid");
	}
	if (
		!Array.isArray(report.runner.memoryChildExecArgv) ||
		report.runner.memoryChildExecArgv.some(value => typeof value !== "string" || value.length === 0) ||
		(report.runner.memoryIsolation === "process-per-surface"
			? report.runner.memoryChildExecArgv.join("\0") !== ["--smol", "--expose-gc"].join("\0")
			: report.runner.memoryChildExecArgv.length !== 0)
	) {
		errors.push("runner.memoryChildExecArgv invalid");
	}
	if (!(MEMORY_ISOLATION_MODES as readonly string[]).includes(report.runner.memoryIsolation)) {
		errors.push("runner.memoryIsolation invalid");
	}
	const memorySurfaceOrderValid = isExactMemorySurfaceOrder(report.runner.memorySurfaceOrder);
	if (!memorySurfaceOrderValid) {
		errors.push("runner.memorySurfaceOrder must be an exact permutation of required memory surfaces");
	}
	if (!(MEMORY_WORKLOAD_PROFILES as readonly string[]).includes(report.runner.profile)) {
		errors.push("runner.profile invalid");
	}
	if (
		report.runner.durationTargetMs !== undefined &&
		(!Number.isFinite(report.runner.durationTargetMs) || report.runner.durationTargetMs < 0)
	) {
		errors.push("runner.durationTargetMs invalid");
	}
	if (
		(report.runner.profile === "soak" &&
			(!Number.isSafeInteger(report.runner.durationTargetMs) ||
				(report.runner.durationTargetMs ?? 0) < 250 ||
				(report.runner.durationTargetMs ?? 0) > 60_000)) ||
		(report.runner.profile === "short" && report.runner.durationTargetMs !== 0)
	) {
		errors.push("runner.durationTargetMs does not match profile bounds");
	}
	if (
		typeof report.runner.environment !== "object" ||
		report.runner.environment === null ||
		report.runner.environment.GJC_MEMORY_PROFILE !== report.runner.profile ||
		report.runner.environment.GJC_MEMORY_ITERATIONS !== String(report.runner.iterationsTarget) ||
		(report.runner.profile === "soak"
			? report.runner.environment.GJC_MEMORY_DURATION_MS !== String(report.runner.durationTargetMs)
			: report.runner.environment.GJC_MEMORY_DURATION_MS !== undefined) ||
		(memorySurfaceOrderValid &&
			report.runner.environment.GJC_MEMORY_SURFACE_ORDER !== report.runner.memorySurfaceOrder.join(","))
	) {
		errors.push("runner.environment does not match memory controls");
	}
	// Anchor CPU-self-time claims to ACTUAL captured profiler evidence: collect the
	// real artifact paths and sample symbols present in fixtures. A claim must name
	// one of these, so one unrelated profiler artifact cannot license an unrelated
	// hotspot to be promoted.
	const knownProfilerArtifacts = new Set<string>();
	const knownProfilerSymbols = new Set<string>();
	for (const fixture of report.fixtures) {
		const profiler = fixture.profilerSelfTime;
		// A fixture declaring profiler "none" carries no real self-time evidence even if it
		// has a stray artifactPath/samples; do not let such a fixture anchor a CPU-self-time claim.
		if (!hasProfilerSelfTimeEvidence(profiler)) continue;
		if (typeof profiler.artifactPath === "string" && profiler.artifactPath.trim().length > 0) {
			knownProfilerArtifacts.add(profiler.artifactPath);
		}
		for (const sample of profiler.samples ?? []) knownProfilerSymbols.add(sample.symbol);
	}
	for (const fixture of report.fixtures) {
		rejectUnexpectedKeys(fixture, FIXTURE_FIELDS, `fixture ${fixture.fixtureId}`, errors);
		rejectUnexpectedKeys(fixture.privacy, PRIVACY_FIELDS, `fixture ${fixture.fixtureId}.privacy`, errors);
		rejectUnexpectedKeys(fixture.profilerSelfTime, PROFILER_FIELDS, `fixture ${fixture.fixtureId}.profilerSelfTime`, errors);
		rejectUnexpectedKeys(fixture.rssMemory, RSS_MEMORY_FIELDS, `fixture ${fixture.fixtureId}.rssMemory`, errors);
		rejectUnexpectedKeys(fixture.byteParity, BYTE_PARITY_FIELDS, `fixture ${fixture.fixtureId}.byteParity`, errors);
		if (!(SOURCE_CLASS_VALUES as readonly string[]).includes(fixture.sourceClass)) {
			errors.push(`fixture ${fixture.fixtureId}: sourceClass invalid`);
		}
		for (const [index, sample] of (fixture.profilerSelfTime.samples ?? []).entries()) {
			rejectUnexpectedKeys(
				sample,
				PROFILER_SAMPLE_FIELDS,
				`fixture ${fixture.fixtureId}.profilerSelfTime.samples.${index}`,
				errors,
			);
		}
		if (fixture.privacy.rawPrivateTranscriptCommitted !== false) {
			errors.push(`fixture ${fixture.fixtureId}: rawPrivateTranscriptCommitted must be false`);
		}
		for (const [phase, metric] of Object.entries(fixture.wallClockPhase)) {
			rejectUnexpectedKeys(metric, WALL_CLOCK_FIELDS, `fixture ${fixture.fixtureId}.wallClockPhase.${phase}`, errors);
			if (!Number.isFinite(metric.elapsedMs)) errors.push(`fixture ${fixture.fixtureId}: wallClockPhase.${phase}.elapsedMs not finite`);
		}
		for (const [phase, metric] of Object.entries(fixture.processCpuUsage)) {
			rejectUnexpectedKeys(metric, PROCESS_CPU_FIELDS, `fixture ${fixture.fixtureId}.processCpuUsage.${phase}`, errors);
			if (!Number.isFinite(metric.userMicros) || !Number.isFinite(metric.systemMicros)) {
				errors.push(`fixture ${fixture.fixtureId}: processCpuUsage.${phase} not finite`);
			}
		}
		if (!Number.isFinite(fixture.rssMemory.growthBytes)) {
			errors.push(`fixture ${fixture.fixtureId}: rssMemory.growthBytes not finite`);
		}
		const baseline = fixture.memoryBaseline;
		if (baseline) {
			rejectUnexpectedKeys(baseline, MEMORY_BASELINE_FIELDS, `fixture ${fixture.fixtureId}.memoryBaseline`, errors);
			if (!Number.isSafeInteger(baseline.ordinal) || baseline.ordinal < 0) {
				errors.push(`fixture ${fixture.fixtureId}: memoryBaseline.ordinal invalid`);
			}
			if (!Number.isSafeInteger(baseline.childPid) || baseline.childPid <= 0) {
				errors.push(`fixture ${fixture.fixtureId}: memoryBaseline.childPid invalid`);
			}
			if (!Number.isSafeInteger(baseline.parentPid) || baseline.parentPid <= 0) {
				errors.push(`fixture ${fixture.fixtureId}: memoryBaseline.parentPid invalid`);
			}
			if (baseline.captureSemanticsId !== MEMORY_CAPTURE_SEMANTICS_ID) {
				errors.push(`fixture ${fixture.fixtureId}: memoryBaseline.captureSemanticsId invalid`);
			}
			if (!(REQUIRED_MEMORY_SURFACES as readonly string[]).includes(baseline.surface)) {
				errors.push(`fixture ${fixture.fixtureId}: memoryBaseline.surface invalid`);
			}
			if (!(MEMORY_WORKLOAD_PROFILES as readonly string[]).includes(baseline.profile)) {
				errors.push(`fixture ${fixture.fixtureId}: memoryBaseline.profile invalid`);
			}
			if (baseline.profile !== report.runner.profile) {
				errors.push(`fixture ${fixture.fixtureId}: memoryBaseline.profile must match runner.profile`);
			}
			if (!Number.isInteger(baseline.iterations) || baseline.iterations <= 0) {
				errors.push(`fixture ${fixture.fixtureId}: memoryBaseline.iterations must be a positive integer`);
			}
			if (baseline.iterations < report.runner.iterationsTarget) {
				errors.push(`fixture ${fixture.fixtureId}: memoryBaseline.iterations below runner target`);
			}
			if (!Number.isInteger(baseline.operations) || baseline.operations < 0) {
				errors.push(`fixture ${fixture.fixtureId}: memoryBaseline.operations must be a non-negative integer`);
			}
			if (!Number.isFinite(baseline.operationsPerSecond) || baseline.operationsPerSecond < 0) {
				errors.push(`fixture ${fixture.fixtureId}: memoryBaseline.operationsPerSecond not finite`);
			}
			const runElapsedMs = fixture.wallClockPhase.run?.elapsedMs;
			if (
				Number.isInteger(baseline.operations) &&
				baseline.operations >= 0 &&
				Number.isFinite(runElapsedMs) &&
				runElapsedMs !== undefined
			) {
				const expectedThroughput = baseline.operations / Math.max(runElapsedMs / 1_000, 1e-6);
				if (
					!Number.isFinite(baseline.operationsPerSecond) ||
					Math.abs(baseline.operationsPerSecond - expectedThroughput) >
						Math.max(1e-9, Math.abs(expectedThroughput) * 1e-12)
				) {
					errors.push(`fixture ${fixture.fixtureId}: memoryBaseline.operationsPerSecond does not match operations`);
				}
			}
			if (
				report.runner.profile === "soak" &&
				(!Number.isFinite(runElapsedMs) ||
					runElapsedMs === undefined ||
					runElapsedMs < (report.runner.durationTargetMs ?? 0))
			) {
				errors.push(`fixture ${fixture.fixtureId}: soak run shorter than runner duration target`);
			}
			for (const [name, value] of [
				["processTreeBaselineRssBytes", baseline.processTreeBaselineRssBytes],
				["processTreePostTeardownRssBytes", baseline.processTreePostTeardownRssBytes],
			] as const) {
				if (value !== null && (!Number.isFinite(value) || value < 0)) {
					errors.push(`fixture ${fixture.fixtureId}: memoryBaseline.${name} invalid`);
				}
			}
			if (!(PROCESS_TREE_SAMPLERS as readonly string[]).includes(baseline.processTreeSampler)) {
				errors.push(`fixture ${fixture.fixtureId}: memoryBaseline.processTreeSampler invalid`);
			}
			if (
				baseline.processTreeSampler === "ps" &&
				(baseline.processTreeBaselineRssBytes === null || baseline.processTreePostTeardownRssBytes === null)
			) {
				errors.push(`fixture ${fixture.fixtureId}: memoryBaseline ps sampler requires process-tree RSS`);
			}
			if (
				baseline.processTreeSampler === "unavailable" &&
				(baseline.processTreeBaselineRssBytes !== null || baseline.processTreePostTeardownRssBytes !== null)
			) {
				errors.push(`fixture ${fixture.fixtureId}: unavailable sampler requires null process-tree RSS`);
			}
			if (Object.hasOwn(baseline, "samples")) {
				errors.push(`fixture ${fixture.fixtureId}: memoryBaseline.samples is not allowed in schema v3`);
			}
			if (!Array.isArray(baseline.periodicSamples) || baseline.periodicSamples.length < 2) {
				errors.push(`fixture ${fixture.fixtureId}: memoryBaseline requires at least two periodicSamples`);
			}
			const periodicSamples = Array.isArray(baseline.periodicSamples) ? baseline.periodicSamples : [];
			const lastPeriodicElapsedMs =
				periodicSamples.length > 0 && isValidMemoryUsageSample(periodicSamples.at(-1))
					? (periodicSamples.at(-1)?.elapsedMs ?? 0)
					: 0;
			const shortChunkSize = Math.max(1, Math.ceil(report.runner.iterationsTarget / 20));
			const maximumPeriodicSamples =
				baseline.profile === "soak"
					? Math.floor(lastPeriodicElapsedMs / 50) + 3
					: Math.ceil(Math.max(0, baseline.iterations) / shortChunkSize) + 2;
			const periodicCountIsBounded = periodicSamples.length <= maximumPeriodicSamples;
			if (!periodicCountIsBounded) {
				errors.push(`fixture ${fixture.fixtureId}: memoryBaseline.periodicSamples exceeds cadence bound`);
			}
			const samplesToValidate = periodicCountIsBounded ? periodicSamples : [];
			for (const [index, sample] of [...samplesToValidate, baseline.postTeardown].entries()) {
				if (typeof sample !== "object" || sample === null) {
					errors.push(`fixture ${fixture.fixtureId}: memoryBaseline sample ${index} invalid`);
					continue;
				}
				for (const name of MEMORY_USAGE_SAMPLE_FIELDS) {
					const value = sample[name];
					if (!Object.hasOwn(sample, name) || !Number.isFinite(value) || value < 0) {
						errors.push(`fixture ${fixture.fixtureId}: memoryBaseline sample ${index}.${name} invalid`);
					}
				}
				rejectUnexpectedKeys(
					sample,
					MEMORY_USAGE_SAMPLE_FIELDS,
					`fixture ${fixture.fixtureId}.memoryBaseline sample ${index}`,
					errors,
				);
				for (const name of [
					"rssBytes",
					"heapUsedBytes",
					"heapTotalBytes",
					"externalBytes",
					"arrayBuffersBytes",
				] as const) {
					if (Object.hasOwn(sample, name) && !isValidMemoryByteValue(sample[name])) {
						errors.push(`fixture ${fixture.fixtureId}: memoryBaseline sample ${index}.${name} must be a safe integer`);
					}
				}
				if (
					Object.hasOwn(sample, "arrayBuffersBytes") &&
					Object.hasOwn(sample, "externalBytes") &&
					sample.arrayBuffersBytes > sample.externalBytes
				) {
					errors.push(`fixture ${fixture.fixtureId}: memoryBaseline sample ${index} arrayBuffersBytes exceeds externalBytes`);
				}
				if (Object.hasOwn(sample, "activeResourceCount") && !Number.isSafeInteger(sample.activeResourceCount)) {
					errors.push(`fixture ${fixture.fixtureId}: memoryBaseline sample ${index}.activeResourceCount must be an integer`);
				}
			}
			const samplesAreValid = periodicCountIsBounded && periodicSamples.every(isValidMemoryUsageSample);
			if (samplesAreValid) {
				for (let index = 1; index < periodicSamples.length; index++) {
					if (periodicSamples[index].elapsedMs < periodicSamples[index - 1].elapsedMs) {
						errors.push(`fixture ${fixture.fixtureId}: memoryBaseline.periodicSamples must be chronological`);
						break;
					}
				}
			}
			if (samplesAreValid && periodicSamples.length > 0 && periodicSamples[0].elapsedMs !== 0) {
				errors.push(`fixture ${fixture.fixtureId}: memoryBaseline.periodicSamples must start at elapsedMs 0`);
			}
			if (
				samplesAreValid &&
				Number.isFinite(runElapsedMs) &&
				runElapsedMs !== periodicSamples.at(-1)?.elapsedMs
			) {
				errors.push(`fixture ${fixture.fixtureId}: memoryBaseline final periodicSample must match run duration`);
			}
			if (
				report.runner.profile === "soak" &&
				samplesAreValid &&
				(periodicSamples.at(-1)?.elapsedMs ?? 0) < (report.runner.durationTargetMs ?? 0)
			) {
				errors.push(`fixture ${fixture.fixtureId}: soak periodicSamples shorter than runner duration target`);
			}
			const observedExtremaValue: unknown = baseline.observedExtrema;
			const observedExtrema =
				typeof observedExtremaValue === "object" && observedExtremaValue !== null && !Array.isArray(observedExtremaValue)
					? (observedExtremaValue as Partial<MemoryObservedExtrema>)
					: {};
			const observedExtremaKeys = Object.keys(observedExtrema);
			let extremaAreValid =
				observedExtremaKeys.length === MEMORY_EXTREMUM_DOMAINS.length &&
				observedExtremaKeys.every(key => (MEMORY_EXTREMUM_DOMAINS as readonly string[]).includes(key));
			if (!extremaAreValid) {
				errors.push(`fixture ${fixture.fixtureId}: memoryBaseline.observedExtrema must contain exactly four memory domains`);
			}
			for (const domain of MEMORY_EXTREMUM_DOMAINS) {
				const extremum = observedExtrema[domain];
				if (
					typeof extremum !== "object" ||
					extremum === null ||
					Array.isArray(extremum) ||
					Object.keys(extremum).length !== 2 ||
					!Object.hasOwn(extremum, "valueBytes") ||
					!Object.hasOwn(extremum, "elapsedMs") ||
					!isValidMemoryByteValue(extremum.valueBytes) ||
					!Number.isFinite(extremum.elapsedMs) ||
					extremum.elapsedMs < 0
				) {
					errors.push(`fixture ${fixture.fixtureId}: memoryBaseline.observedExtrema.${domain} invalid`);
					extremaAreValid = false;
					continue;
				}
				if (samplesAreValid && extremum.elapsedMs > lastPeriodicElapsedMs) {
					errors.push(`fixture ${fixture.fixtureId}: memoryBaseline.observedExtrema.${domain} outside measurement lifecycle`);
					extremaAreValid = false;
				}
				if (
					samplesAreValid &&
					periodicSamples.some(sample => sample[domain] > extremum.valueBytes)
				) {
					errors.push(`fixture ${fixture.fixtureId}: memoryBaseline.observedExtrema.${domain} below periodic observation`);
					extremaAreValid = false;
				}
			}
			const externalExtremum = observedExtrema.externalBytes;
			const arrayBuffersExtremum = observedExtrema.arrayBuffersBytes;
			if (
				extremaAreValid &&
				externalExtremum &&
				arrayBuffersExtremum &&
				arrayBuffersExtremum.valueBytes > externalExtremum.valueBytes
			) {
				errors.push(`fixture ${fixture.fixtureId}: memoryBaseline observed arrayBuffersBytes exceeds externalBytes`);
				extremaAreValid = false;
			}
			const samplingValue: unknown = baseline.sampling;
			const sampling =
				typeof samplingValue === "object" && samplingValue !== null && !Array.isArray(samplingValue)
					? (samplingValue as Partial<MemorySamplingMetadata>)
					: {};
			const samplingFields = [
				"periodicCadenceTargetMs",
				"highWaterCadenceTargetMs",
				"periodicDeadlinesMissed",
				"highWaterCallbacks",
				"highWaterProbes",
				"forcedHighWaterProbes",
				"throttledHighWaterCallbacks",
			] as const satisfies readonly (keyof MemorySamplingMetadata)[];
			if (
				Object.keys(sampling).length !== samplingFields.length ||
				!samplingFields.every(name => Number.isSafeInteger(sampling[name]) && Number(sampling[name]) >= 0)
			) {
				errors.push(`fixture ${fixture.fixtureId}: memoryBaseline.sampling invalid`);
			}
			const expectedPeriodicCadenceMs = baseline.profile === "soak" ? 50 : 0;
			const expectedHighWaterCadenceMs = baseline.profile === "soak" ? 10 : 0;
			if (
				sampling.periodicCadenceTargetMs !== expectedPeriodicCadenceMs ||
				sampling.highWaterCadenceTargetMs !== expectedHighWaterCadenceMs
			) {
				errors.push(`fixture ${fixture.fixtureId}: memoryBaseline.sampling cadence does not match profile`);
			}
			if (
				typeof sampling.highWaterCallbacks === "number" &&
				typeof sampling.highWaterProbes === "number" &&
				typeof sampling.throttledHighWaterCallbacks === "number" &&
				sampling.highWaterCallbacks !== sampling.highWaterProbes + sampling.throttledHighWaterCallbacks
			) {
				errors.push(`fixture ${fixture.fixtureId}: memoryBaseline.sampling callback counts inconsistent`);
			}
			if (
				typeof sampling.forcedHighWaterProbes === "number" &&
				typeof sampling.highWaterProbes === "number" &&
				sampling.forcedHighWaterProbes > sampling.highWaterProbes
			) {
				errors.push(`fixture ${fixture.fixtureId}: memoryBaseline.sampling forced probes exceed probes`);
			}
			if (
				baseline.profile === "short" &&
				(sampling.periodicDeadlinesMissed !== 0 || sampling.throttledHighWaterCallbacks !== 0)
			) {
				errors.push(`fixture ${fixture.fixtureId}: memoryBaseline.sampling short profile cannot report throttling`);
			}
			if (
				baseline.profile === "soak" &&
				typeof sampling.highWaterProbes === "number" &&
				typeof sampling.forcedHighWaterProbes === "number" &&
				sampling.highWaterProbes - sampling.forcedHighWaterProbes > Math.floor(lastPeriodicElapsedMs / 10) + 1
			) {
				errors.push(`fixture ${fixture.fixtureId}: memoryBaseline.sampling high-water probes exceed cadence bound`);
			}
			for (const [name, key] of [
				["rssSlopeBytesPerSecond", "rssBytes"],
				["heapSlopeBytesPerSecond", "heapUsedBytes"],
			] as const) {
				const value = baseline[name];
				if (value !== null && !Number.isFinite(value)) {
					errors.push(`fixture ${fixture.fixtureId}: memoryBaseline.${name} invalid`);
				}
				if (!samplesAreValid) continue;
				const expected = calculateMemorySlope(periodicSamples, key);
				if (
					(value === null) !== (expected === null) ||
					(value !== null && expected !== null && Math.abs(value - expected) > Math.max(1e-9, Math.abs(expected) * 1e-12))
				) {
					errors.push(`fixture ${fixture.fixtureId}: memoryBaseline.${name} does not match periodicSamples`);
				}
			}
			const postTeardownIsValid = isValidMemoryUsageSample(baseline.postTeardown);
			if (
				samplesAreValid &&
				periodicSamples.length > 0 &&
				postTeardownIsValid &&
				baseline.postTeardown.elapsedMs < (periodicSamples.at(-1)?.elapsedMs ?? 0)
			) {
				errors.push(`fixture ${fixture.fixtureId}: memoryBaseline postTeardown predates periodicSamples`);
			}
			if (samplesAreValid && periodicSamples.length > 0 && postTeardownIsValid && extremaAreValid) {
				const firstSample = periodicSamples[0];
				const rssExtremum = observedExtrema.rssBytes;
				if (rssExtremum) {
					const childGcExposed =
						report.runner.memoryIsolation === "process-per-surface"
							? report.runner.memoryChildGcExposed
							: report.runner.gcExposed;
					const expectedSummary = {
						baselineBytes: firstSample.rssBytes,
						peakBytes: rssExtremum.valueBytes,
						growthBytes: rssExtremum.valueBytes - firstSample.rssBytes,
						returnBytes: childGcExposed ? baseline.postTeardown.rssBytes : null,
						heapBaselineBytes: firstSample.heapUsedBytes,
						heapReturnBytes: childGcExposed ? baseline.postTeardown.heapUsedBytes : null,
					};
					for (const [name, expected] of Object.entries(expectedSummary)) {
						if (fixture.rssMemory[name as keyof typeof expectedSummary] !== expected) {
							errors.push(`fixture ${fixture.fixtureId}: rssMemory.${name} does not match periodic/extrema evidence`);
						}
					}
				}
			}
			const memoryGcExposed =
				report.runner.memoryIsolation === "process-per-surface"
					? report.runner.memoryChildGcExposed
					: report.runner.gcExposed;
			if (
				memoryGcExposed &&
				(fixture.rssMemory.returnBytes === null || fixture.rssMemory.heapReturnBytes === null)
			) {
				errors.push(`fixture ${fixture.fixtureId}: exposed memory GC requires post-GC return metrics`);
			}
			if (
				!memoryGcExposed &&
				(fixture.rssMemory.returnBytes !== null || fixture.rssMemory.heapReturnBytes !== null)
			) {
				errors.push(`fixture ${fixture.fixtureId}: unavailable memory GC requires null return metrics`);
			}
		}
	}
	const measuredBaselines = report.fixtures.flatMap(fixture =>
		fixture.memoryBaseline ? [fixture.memoryBaseline] : [],
	);
	const measuredSurfaceOrder = measuredBaselines.map(baseline => baseline.surface);
	const measuredSurfaces = new Set(measuredSurfaceOrder);
	for (const surface of REQUIRED_MEMORY_SURFACES) {
		if (!measuredSurfaces.has(surface)) errors.push(`memory baseline missing required surface "${surface}"`);
	}
	if (
		report.runner.memoryIsolation === "process-per-surface" &&
		memorySurfaceOrderValid &&
		(measuredSurfaceOrder.length !== report.runner.memorySurfaceOrder.length ||
			measuredSurfaceOrder.some((surface, index) => surface !== report.runner.memorySurfaceOrder[index]))
	) {
		errors.push("memory baseline order must match runner.memorySurfaceOrder for process-per-surface");
	}
	if (
		memorySurfaceOrderValid &&
		measuredBaselines.some(
			(baseline, index) =>
				baseline.ordinal !== index || baseline.surface !== report.runner.memorySurfaceOrder[index],
		)
	) {
		errors.push("memory baseline ordinal/surface identity must match runner.memorySurfaceOrder");
	}
	if (new Set(measuredBaselines.map(baseline => baseline.parentPid)).size !== 1) {
		errors.push("memory baseline surfaces must have exactly one parent PID");
	}
	if (report.runner.memoryIsolation === "process-per-surface") {
		if (
			measuredBaselines.some(
				baseline => baseline.parentPid !== report.runner.runnerPid || baseline.childPid === report.runner.runnerPid,
			)
		) {
			errors.push("isolated memory baseline process tree does not match runner PID");
		}
		if (new Set(measuredBaselines.map(baseline => baseline.childPid)).size !== measuredBaselines.length) {
			errors.push("isolated memory baseline child PIDs must be distinct");
		}
	} else if (measuredBaselines.some(baseline => baseline.childPid !== report.runner.runnerPid)) {
		errors.push("in-process memory baseline child PID must equal runner PID");
	}
	for (const classification of report.hotspotClassifications) {
		rejectUnexpectedKeys(
			classification,
			HOTSPOT_CLASSIFICATION_FIELDS,
			`hotspot ${classification.hotspotId}`,
			errors,
		);
		errors.push(...validateHotspotClassification(classification));
		if (classification.status === "CPU-self-time confirmed") {
			const anchored = classification.artifactRefs.some(ref => knownProfilerArtifacts.has(ref) || knownProfilerSymbols.has(ref));
			if (!anchored) {
				errors.push(
					`hotspot ${classification.hotspotId}: "CPU-self-time confirmed" must reference an actual fixture profiler artifactPath or sample symbol; none of [${classification.artifactRefs.join(", ")}] match captured profiler evidence`,
				);
			}
		}
	}
	for (const [index, threshold] of (report.thresholdLedger ?? []).entries()) {
		rejectUnexpectedKeys(threshold, THRESHOLD_LEDGER_FIELDS, `thresholdLedger.${index}`, errors);
	}
	return { ok: errors.length === 0, errors };
}

/**
 * Reclassification of the closed-out v1-v3 hotspot map under the new evidence
 * vocabulary. No entry is `CPU-self-time confirmed` because the profiling
 * corpus has not yet captured profiler self-time artifacts for these paths —
 * this is the no-overclaiming guard made concrete. Promote entries only when a
 * corpus run with profiler artifacts (or fallback-toggle evidence) lands.
 */
export const V1_V3_RECLASSIFICATION: readonly HotspotClassification[] = [
	{ hotspotId: "H01", status: "covered-current", evidenceClass: "wall-clock-proxy", artifactRefs: [], notes: "native fuzzy match shipped (v1); microbench-only, needs corpus trace coverage" },
	{ hotspotId: "H02", status: "covered-current", evidenceClass: "wall-clock-proxy", artifactRefs: [], notes: "native levenshtein/similarity shipped (v1); microbench-only" },
	{ hotspotId: "H03", status: "covered-current", evidenceClass: "wall-clock-proxy", artifactRefs: [], notes: "native diffLines shipped (v2); microbench-only" },
	{ hotspotId: "H04", status: "needs-trace-coverage", evidenceClass: "wall-clock-proxy", artifactRefs: [], notes: "word-diff TS fast paths only (v3); native rejected without fresh FFI gate" },
	{ hotspotId: "H05", status: "needs-trace-coverage", evidenceClass: "wall-clock-proxy", artifactRefs: [], notes: "LCS dense-DP retained; Hunt-Szymanski reverted for byte divergence" },
	{ hotspotId: "H06", status: "covered-current", evidenceClass: "wall-clock-proxy", artifactRefs: [], notes: "native whole-text hash+format shipped (v1)" },
	{ hotspotId: "H07", status: "covered-current", evidenceClass: "wall-clock-proxy", artifactRefs: [], notes: "per-entry token estimate cache (v3); repeated-estimate microbench only" },
	{ hotspotId: "H08", status: "not-visible", evidenceClass: "wall-clock-proxy", artifactRefs: [], notes: "O(n) trim shipped; custom JSON length counter deleted (native faster)" },
	{ hotspotId: "H09", status: "covered-current", evidenceClass: "wall-clock-proxy", artifactRefs: [], notes: "JSON-semantic cloneJson (v3); microbench-only" },
	{ hotspotId: "H10", status: "covered-current", evidenceClass: "wall-clock-proxy", artifactRefs: [], notes: "xxHash64-accelerated session equality (v3); microbench-only" },
	{ hotspotId: "H11", status: "needs-trace-coverage", evidenceClass: "wall-clock-proxy", artifactRefs: [], notes: "single-pass obfuscator (v3); fires only when secrets configured" },
	{ hotspotId: "M01", status: "covered-current", evidenceClass: "rss-memory", artifactRefs: [], notes: "EphemeralBlobStore externalization (v3); fixture retained-heap only" },
	{ hotspotId: "M02", status: "covered-current", evidenceClass: "rss-memory", artifactRefs: [], notes: "revision-keyed WeakRef materialization cache (v3)" },
	{ hotspotId: "M03", status: "covered-current", evidenceClass: "rss-memory", artifactRefs: [], notes: "WeakRef buildSessionContext cache (v3)" },
	{ hotspotId: "M04", status: "covered-current", evidenceClass: "rss-memory", artifactRefs: [], notes: "fingerprint caching + JSON-semantic clone (v2/v3)" },
	{ hotspotId: "M05", status: "covered-current", evidenceClass: "rss-memory", artifactRefs: [], notes: "revision-bumped capture/restore (v3)" },
];
