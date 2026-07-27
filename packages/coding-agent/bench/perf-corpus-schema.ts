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
	profile: MemoryWorkloadProfile;
	iterations: number;
	operations: number;
	operationsPerSecond: number;
	samples: MemoryUsageSample[];
	slopeSamples: MemoryUsageSample[];
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
	schema: "gjc.perf-corpus/2";
	generatedAt: string;
	gitSha: string;
	gitDirty: boolean;
	runner: {
		command: string;
		argv: string[];
		environment: Record<string, string>;
		platform: NodeJS.Platform;
		arch: string;
		bunVersion?: string;
		ci?: boolean;
		profile: MemoryWorkloadProfile;
		durationTargetMs?: number;
		memoryIsolation: "in-process" | "process-per-surface";
		iterationsTarget: number;
		gcExposed: boolean;
		memoryChildGcExposed: boolean;
		memoryChildExecArgv: string[];
	};
	fixtures: PerfCorpusFixtureResult[];
	hotspotClassifications: HotspotClassification[];
	thresholdLedger?: ThresholdLedgerReference[];
}

export const PERF_CORPUS_SCHEMA = "gjc.perf-corpus/2" as const;

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
function isValidMemoryUsageSample(value: unknown): value is MemoryUsageSample {
	if (typeof value !== "object" || value === null) return false;
	const sample = value as Record<string, unknown>;
	return MEMORY_USAGE_SAMPLE_FIELDS.every(
		name => Object.hasOwn(sample, name) && Number.isFinite(sample[name]) && Number(sample[name]) >= 0,
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
	if (report.schema !== PERF_CORPUS_SCHEMA) {
		errors.push(`invalid schema "${report.schema}", expected "${PERF_CORPUS_SCHEMA}"`);
	}
	if (!/^[0-9a-f]{40}$/i.test(report.gitSha)) {
		errors.push("gitSha must be a full 40-character commit SHA");
	}
	if (typeof report.gitDirty !== "boolean") {
		errors.push("gitDirty invalid");
	}
	if (typeof report.runner.command !== "string" || report.runner.command.trim().length === 0) {
		errors.push("runner.command must record the resolved invocation");
	}
	if (
		!Array.isArray(report.runner.argv) ||
		report.runner.argv.length === 0 ||
		report.runner.argv.some(value => typeof value !== "string" || value.length === 0)
	) {
		errors.push("runner.argv invalid");
	}
	if (
		typeof report.runner.environment !== "object" ||
		report.runner.environment === null ||
		Object.values(report.runner.environment).some(value => typeof value !== "string")
	) {
		errors.push("runner.environment invalid");
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
			: report.runner.environment.GJC_MEMORY_DURATION_MS !== undefined)
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
		if (fixture.privacy.rawPrivateTranscriptCommitted !== false) {
			errors.push(`fixture ${fixture.fixtureId}: rawPrivateTranscriptCommitted must be false`);
		}
		for (const [phase, metric] of Object.entries(fixture.wallClockPhase)) {
			if (!Number.isFinite(metric.elapsedMs)) errors.push(`fixture ${fixture.fixtureId}: wallClockPhase.${phase}.elapsedMs not finite`);
		}
		for (const [phase, metric] of Object.entries(fixture.processCpuUsage)) {
			if (!Number.isFinite(metric.userMicros) || !Number.isFinite(metric.systemMicros)) {
				errors.push(`fixture ${fixture.fixtureId}: processCpuUsage.${phase} not finite`);
			}
		}
		if (!Number.isFinite(fixture.rssMemory.growthBytes)) {
			errors.push(`fixture ${fixture.fixtureId}: rssMemory.growthBytes not finite`);
		}
		const baseline = fixture.memoryBaseline;
		if (baseline) {
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
			if (!Array.isArray(baseline.samples) || baseline.samples.length < 2) {
				errors.push(`fixture ${fixture.fixtureId}: memoryBaseline requires at least two samples`);
			}
			if (!Array.isArray(baseline.slopeSamples) || baseline.slopeSamples.length < 2) {
				errors.push(`fixture ${fixture.fixtureId}: memoryBaseline requires at least two slope samples`);
			}
			const slopeSamples = Array.isArray(baseline.slopeSamples) ? baseline.slopeSamples : [];
			const samples = Array.isArray(baseline.samples) ? baseline.samples : [];
			for (const [index, sample] of [...samples, baseline.postTeardown].entries()) {
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
				if (
					Object.hasOwn(sample, "arrayBuffersBytes") &&
					Object.hasOwn(sample, "externalBytes") &&
					sample.arrayBuffersBytes > sample.externalBytes
				) {
					errors.push(`fixture ${fixture.fixtureId}: memoryBaseline sample ${index} arrayBuffersBytes exceeds externalBytes`);
				}
				if (Object.hasOwn(sample, "activeResourceCount") && !Number.isInteger(sample.activeResourceCount)) {
					errors.push(`fixture ${fixture.fixtureId}: memoryBaseline sample ${index}.activeResourceCount must be an integer`);
				}
			}
			for (const [index, sample] of slopeSamples.entries()) {
				if (!isValidMemoryUsageSample(sample)) {
					errors.push(`fixture ${fixture.fixtureId}: memoryBaseline slope sample ${index} invalid`);
				}
			}
			const samplesAreValid = samples.every(isValidMemoryUsageSample);
			if (samplesAreValid) {
				for (let index = 1; index < samples.length; index++) {
					if (samples[index].elapsedMs < samples[index - 1].elapsedMs) {
						errors.push(`fixture ${fixture.fixtureId}: memoryBaseline samples must be chronological`);
						break;
					}
				}
			}
			const slopeSamplesAreValid = slopeSamples.every(isValidMemoryUsageSample);
			if (slopeSamplesAreValid) {
				for (let index = 1; index < slopeSamples.length; index++) {
					if (slopeSamples[index].elapsedMs < slopeSamples[index - 1].elapsedMs) {
						errors.push(`fixture ${fixture.fixtureId}: memoryBaseline slope samples must be chronological`);
						break;
					}
				}
			}
			if (
				report.runner.profile === "soak" &&
				slopeSamplesAreValid &&
				(slopeSamples.at(-1)?.elapsedMs ?? 0) < (report.runner.durationTargetMs ?? 0)
			) {
				errors.push(`fixture ${fixture.fixtureId}: soak samples shorter than runner duration target`);
			}
			for (const [name, key] of [
				["rssSlopeBytesPerSecond", "rssBytes"],
				["heapSlopeBytesPerSecond", "heapUsedBytes"],
			] as const) {
				const value = baseline[name];
				if (value !== null && !Number.isFinite(value)) {
					errors.push(`fixture ${fixture.fixtureId}: memoryBaseline.${name} invalid`);
				}
				if (!slopeSamplesAreValid) continue;
				const expected = calculateMemorySlope(slopeSamples, key);
				if (
					(value === null) !== (expected === null) ||
					(value !== null && expected !== null && Math.abs(value - expected) > Math.max(1e-9, Math.abs(expected) * 1e-12))
				) {
					errors.push(`fixture ${fixture.fixtureId}: memoryBaseline.${name} does not match slope samples`);
				}
			}
			const postTeardownIsValid = isValidMemoryUsageSample(baseline.postTeardown);
			if (
				samplesAreValid &&
				samples.length > 0 &&
				postTeardownIsValid &&
				baseline.postTeardown.elapsedMs < (samples.at(-1)?.elapsedMs ?? 0)
			) {
				errors.push(`fixture ${fixture.fixtureId}: memoryBaseline postTeardown predates workload samples`);
			}
			if (samplesAreValid && samples.length > 0 && postTeardownIsValid) {
				const firstSample = samples[0];
				let peakRssBytes = firstSample.rssBytes;
				for (const sample of samples) peakRssBytes = Math.max(peakRssBytes, sample.rssBytes);
				const childGcExposed =
					report.runner.memoryIsolation === "process-per-surface"
						? report.runner.memoryChildGcExposed
						: report.runner.gcExposed;
				const expectedSummary = {
					baselineBytes: firstSample.rssBytes,
					peakBytes: peakRssBytes,
					growthBytes: peakRssBytes - firstSample.rssBytes,
					returnBytes: childGcExposed ? baseline.postTeardown.rssBytes : null,
					heapBaselineBytes: firstSample.heapUsedBytes,
					heapReturnBytes: childGcExposed ? baseline.postTeardown.heapUsedBytes : null,
				};
				for (const [name, expected] of Object.entries(expectedSummary)) {
					if (fixture.rssMemory[name as keyof typeof expectedSummary] !== expected) {
						errors.push(`fixture ${fixture.fixtureId}: rssMemory.${name} does not match detailed samples`);
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
	const measuredSurfaces = new Set(
		report.fixtures.flatMap(fixture => (fixture.memoryBaseline ? [fixture.memoryBaseline.surface] : [])),
	);
	for (const surface of REQUIRED_MEMORY_SURFACES) {
		if (!measuredSurfaces.has(surface)) errors.push(`memory baseline missing required surface "${surface}"`);
	}
	for (const classification of report.hotspotClassifications) {
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
