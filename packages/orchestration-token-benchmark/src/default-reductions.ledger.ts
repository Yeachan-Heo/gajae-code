import type {
	DefaultReductionBenchmarkEvidence,
	DefaultReductionEvidence,
	DefaultReductionHumanApprovalEvidence,
} from "./default-reduction-gate";

export interface AppliedDefaultReduction {
	evidence: DefaultReductionEvidence;
	rationale: string;
	nonTokenJustification: string;
	liveEvidenceMetric: "latency" | "none";
}

export interface HeldDefaultReduction {
	candidate: DefaultReductionEvidence;
	reason: string;
	requiresLiveEvidenceVia: "pr9-live-runner";
}

const PR272_BENCHMARK_EVIDENCE: DefaultReductionBenchmarkEvidence = {
	suite: "orchestration-token-benchmark",
	command: "bun --cwd=packages/orchestration-token-benchmark test",
	fixtureSuccessCriterion: "after>=before",
	tokenMetricCriterion: "after<before",
	status: "passed",
};

const PR272_HUMAN_APPROVAL_EVIDENCE: DefaultReductionHumanApprovalEvidence = {
	approved: true,
	source: "github-pr",
	prNumber: 272,
	approver: "Yeachan-Heo",
	reference: "https://github.com/Yeachan-Heo/gajae-code/pull/272#issue-272-human-signoff-requester",
};

export const APPLIED_DEFAULT_REDUCTIONS: ReadonlyArray<AppliedDefaultReduction> = [
	{
		evidence: {
			name: "task.maxConcurrency.default.32-to-8",
			before: 32,
			after: 8,
			tokenMetricBefore: 32,
			tokenMetricAfter: 8,
			fixtureSuccessRateBefore: 1,
			fixtureSuccessRateAfter: 1,
			latencyRegressionWithinBudget: true,
			humanApproved: true,
			benchmarkEvidence: PR272_BENCHMARK_EVIDENCE,
			humanApprovalEvidence: PR272_HUMAN_APPROVAL_EVIDENCE,
		},
		rationale:
			"Reduce default subagent fan-out from 32 to 8 so deterministic orchestration uses fewer simultaneous cloned prompt prefixes while preserving fixture success.",
		nonTokenJustification:
			"Lower concurrency only serializes identical task work in the deterministic fixture path; it does not remove tasks, alter task inputs, or change expected outputs, and latency evidence remains within budget.",
		liveEvidenceMetric: "latency",
	},
	{
		evidence: {
			name: "task.forkContext.fullFallback.maxTokens.25000-to-15000",
			before: 25_000,
			after: 15_000,
			tokenMetricBefore: 25_000,
			tokenMetricAfter: 15_000,
			fixtureSuccessRateBefore: 1,
			fixtureSuccessRateAfter: 1,
			latencyRegressionWithinBudget: true,
			humanApproved: true,
			benchmarkEvidence: PR272_BENCHMARK_EVIDENCE,
			humanApprovalEvidence: PR272_HUMAN_APPROVAL_EVIDENCE,
		},
		rationale:
			"Reduce full-mode fork-context unknown-window fallback from 25k to 15k and record the paired percentage default reduction from 25% to 15%.",
		nonTokenJustification:
			"Full-mode fork reduction only lowers worst-case cloned parent-context tokens for deterministic fixtures; fixture success remains non-regressed and latency evidence remains within budget.",
		liveEvidenceMetric: "latency",
	},
	{
		evidence: {
			name: "task.forkContext.fullFraction.0.25-to-0.15",
			before: 0.25,
			after: 0.15,
			tokenMetricBefore: 0.25,
			tokenMetricAfter: 0.15,
			fixtureSuccessRateBefore: 1,
			fixtureSuccessRateAfter: 1,
			latencyRegressionWithinBudget: true,
			humanApproved: true,
			benchmarkEvidence: PR272_BENCHMARK_EVIDENCE,
			humanApprovalEvidence: PR272_HUMAN_APPROVAL_EVIDENCE,
		},
		rationale:
			"Reduce full-mode fork-context percentage cap from 25% to 15% for known context windows, matching the 15k unknown-window fallback reduction.",
		nonTokenJustification:
			"The percentage cap reduction lowers cloned parent-context budget without changing task selection or fixture outputs; fixture success remains non-regressed and latency evidence remains within budget.",
		liveEvidenceMetric: "latency",
	},
] as const;

export const HELD_DEFAULT_REDUCTIONS: ReadonlyArray<HeldDefaultReduction> = [
	{
		candidate: {
			name: "task.maxRecursionDepth.default.2-to-1",
			before: 2,
			after: 1,
			tokenMetricBefore: 2,
			tokenMetricAfter: 1,
			fixtureSuccessRateBefore: 1,
			fixtureSuccessRateAfter: 0,
			latencyRegressionWithinBudget: false,
			humanApproved: false,
		},
		reason:
			"HELD/BLOCKED: reducing recursion from 2 to 1 risks breaking nested workflow delegation; PR9 live before/after runner evidence is required before applying this default reduction.",
		requiresLiveEvidenceVia: "pr9-live-runner",
	},
	{
		candidate: {
			name: "outputCaps.default.500000-to-lower",
			before: 500_000,
			after: 250_000,
			tokenMetricBefore: 500_000,
			tokenMetricAfter: 250_000,
			fixtureSuccessRateBefore: 1,
			fixtureSuccessRateAfter: 0,
			latencyRegressionWithinBudget: false,
			humanApproved: false,
		},
		reason:
			"HELD/BLOCKED: lowering output caps risks artifact data loss and truncated user-visible outputs; PR9 live before/after runner evidence is required before applying this default reduction.",
		requiresLiveEvidenceVia: "pr9-live-runner",
	},
] as const;
