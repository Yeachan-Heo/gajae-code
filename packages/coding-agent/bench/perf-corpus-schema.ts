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
	schema: "gjc.perf-corpus/1";
	generatedAt: string;
	gitSha?: string;
	runner: {
		command: string;
		platform: NodeJS.Platform;
		arch: string;
		bunVersion?: string;
		ci?: boolean;
	};
	fixtures: PerfCorpusFixtureResult[];
	hotspotClassifications: HotspotClassification[];
	thresholdLedger?: ThresholdLedgerReference[];
}

export const PERF_CORPUS_SCHEMA = "gjc.perf-corpus/1" as const;

export const REQUIRED_FIXTURE_CLASSES: readonly FixtureClass[] = ["startup-session-load", "streaming-ttft", "large-transcript"];

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
