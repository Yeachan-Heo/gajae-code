/**
 * Perf threshold / evidence ledger.
 *
 * Models `packages/orchestration-token-benchmark/src/default-reductions.ledger.ts`:
 * threshold changes are explicit, evidence-backed records. Wall-clock and RSS
 * thresholds START advisory (report-only, never fail default CI) until variance
 * is characterized; promotion to an enforced hard gate requires a clean
 * before/after benchmark evidence record AND human approval.
 *
 * See `docs/perf-profiling-corpus.md` (threshold-promotion process) and
 * `packages/tui/test/perf-gates.test.ts` (the gate surface being promoted into).
 */

import type { EvidenceClass } from "./perf-corpus-schema";

export interface PerfThresholdBenchmarkEvidence {
	suite: string;
	command: string;
	/** Comparable before/after sample, e.g. baseline vs candidate p95. */
	beforeAfter: { metric: string; before: number; after: number; unit: string };
	status: "passed" | "pending";
}

export interface PerfThresholdHumanApprovalEvidence {
	approved: boolean;
	source: string;
	reference: string;
}

export interface PerfThresholdEvidence {
	name: string;
	/** Which evidence class the threshold gates. */
	metricClass: EvidenceClass;
	/** Advisory thresholds report-only; enforced thresholds fail CI. */
	advisoryOrEnforced: "advisory" | "enforced";
	fixtureId: string;
	command: string;
	benchmarkEvidence?: PerfThresholdBenchmarkEvidence;
	humanApprovalEvidence?: PerfThresholdHumanApprovalEvidence;
	rationale: string;
	varianceCharacterized: boolean;
}

/**
 * Applied perf thresholds. Initially advisory-only: the corpus has not yet
 * characterized CI variance for wall-clock/RSS metrics, so nothing is promoted
 * to an enforced hard gate. New advisory thresholds may be added freely;
 * enforced thresholds must carry benchmark + human approval evidence and
 * `varianceCharacterized: true`.
 */
export const APPLIED_PERF_THRESHOLDS: readonly PerfThresholdEvidence[] = [
	{
		name: "perf-corpus.startup-session-load.wallclock.advisory",
		metricClass: "wall-clock-proxy",
		advisoryOrEnforced: "advisory",
		fixtureId: "startup-load",
		command: "bun packages/coding-agent/bench/perf-corpus.bench.ts",
		rationale: "Report startup/session-load wall-clock phase timing as advisory; not enforced until CI variance across machines/arch is characterized.",
		varianceCharacterized: false,
	},
	{
		name: "perf-corpus.large-transcript.rss.advisory",
		metricClass: "rss-memory",
		advisoryOrEnforced: "advisory",
		fixtureId: "large-transcript",
		command: "bun packages/coding-agent/bench/perf-corpus.bench.ts",
		rationale: "Report large-transcript RSS growth/return as advisory; RSS is sensitive to GC scheduling, so it stays report-only until variance is measured.",
		varianceCharacterized: false,
	},
] as const;

/** Thresholds proposed but held until live before/after variance evidence exists. */
export const HELD_PERF_THRESHOLDS: readonly { candidate: string; reason: string; requiresEvidenceVia: string }[] = [
	{
		candidate: "perf-corpus.streaming-ttft.wallclock.enforced",
		reason: "HELD: hard-gating TTFT wall-clock p95 risks flakiness from scheduler/GC noise; needs characterized CI variance + ledger approval before enforcement.",
		requiresEvidenceVia: "perf-corpus variance run + human approval",
	},
] as const;

/** Validate ledger invariants. Returns the list of violations (empty == valid). */
export function validatePerfThresholdLedger(applied: readonly PerfThresholdEvidence[] = APPLIED_PERF_THRESHOLDS): string[] {
	const errors: string[] = [];
	const seen = new Set<string>();
	for (const t of applied) {
		if (seen.has(t.name)) errors.push(`duplicate threshold name: ${t.name}`);
		seen.add(t.name);
		if (t.advisoryOrEnforced === "enforced") {
			if (!t.varianceCharacterized) errors.push(`enforced threshold ${t.name} requires varianceCharacterized: true`);
			if (!t.benchmarkEvidence || t.benchmarkEvidence.status !== "passed") {
				errors.push(`enforced threshold ${t.name} requires passed benchmarkEvidence with a before/after sample`);
			}
			if (!t.humanApprovalEvidence?.approved) errors.push(`enforced threshold ${t.name} requires human approval evidence`);
		}
	}
	return errors;
}
