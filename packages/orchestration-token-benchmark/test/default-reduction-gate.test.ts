import { describe, expect, test } from "bun:test";
import { type DefaultReductionEvidence, evaluateDefaultReduction } from "../src/default-reduction-gate";

const PASSING_EVIDENCE: Omit<
	DefaultReductionEvidence,
	"name" | "before" | "after" | "tokenMetricBefore" | "tokenMetricAfter"
> = {
	fixtureSuccessRateBefore: 1,
	fixtureSuccessRateAfter: 1,
	latencyRegressionWithinBudget: true,
	humanApproved: true,
	benchmarkEvidence: {
		suite: "orchestration-token-benchmark",
		command: "bun --cwd=packages/orchestration-token-benchmark test",
		fixtureSuccessCriterion: "after>=before",
		tokenMetricCriterion: "after<before",
		status: "passed",
	},
	humanApprovalEvidence: {
		approved: true,
		source: "github-pr",
		prNumber: 272,
		approver: "Yeachan-Heo",
		reference: "https://github.com/Yeachan-Heo/gajae-code/pull/272#issue-272-human-signoff-requester",
	},
};

describe("evaluateDefaultReduction", () => {
	test("defaults.concurrency.before-after", () => {
		const decision = evaluateDefaultReduction({
			...PASSING_EVIDENCE,
			name: "defaults.concurrency.before-after",
			before: 32,
			after: 8,
			tokenMetricBefore: 32,
			tokenMetricAfter: 8,
		});

		expect(decision).toEqual({ outcome: "allowed", reasons: [] });
	});

	test("defaults.fork-fallback.before-after", () => {
		const decision = evaluateDefaultReduction({
			...PASSING_EVIDENCE,
			name: "defaults.fork-fallback.before-after",
			before: 25_000,
			after: 15_000,
			tokenMetricBefore: 25_000,
			tokenMetricAfter: 15_000,
		});

		expect(decision).toEqual({ outcome: "allowed", reasons: [] });
	});

	test("defaults.metrics-disagree", () => {
		const decision = evaluateDefaultReduction({
			...PASSING_EVIDENCE,
			name: "defaults.metrics-disagree",
			before: 32,
			after: 8,
			tokenMetricBefore: 32,
			tokenMetricAfter: 8,
			fixtureSuccessRateAfter: 0.95,
		});

		expect(decision.outcome).toBe("blocked");
		expect(decision.reasons).toContain("fixture success rate regressed");
	});

	test("defaults.token-metrics-must-decrease", () => {
		const decision = evaluateDefaultReduction({
			...PASSING_EVIDENCE,
			name: "defaults.token-metrics-must-decrease",
			before: 32,
			after: 8,
			tokenMetricBefore: 32,
			tokenMetricAfter: 32,
		});

		expect(decision.outcome).toBe("blocked");
		expect(decision.reasons).toContain("token metric regressed or did not decrease");
	});

	test("defaults.human-signoff-required", () => {
		const decision = evaluateDefaultReduction({
			...PASSING_EVIDENCE,
			name: "defaults.human-signoff-required",
			before: 32,
			after: 8,
			tokenMetricBefore: 32,
			tokenMetricAfter: 8,
			humanApproved: false,
		});

		expect(decision.outcome).toBe("blocked");
		expect(decision.reasons).toContain("human approval is required");
	});

	test("defaults.human-signoff-must-be-anchored", () => {
		const decision = evaluateDefaultReduction({
			...PASSING_EVIDENCE,
			name: "defaults.human-signoff-must-be-anchored",
			before: 32,
			after: 8,
			tokenMetricBefore: 32,
			tokenMetricAfter: 8,
			humanApprovalEvidence: undefined,
		});

		expect(decision.outcome).toBe("blocked");
		expect(decision.reasons).toContain("human approval evidence is required");
	});

	test("defaults.benchmark-evidence-required", () => {
		const decision = evaluateDefaultReduction({
			...PASSING_EVIDENCE,
			name: "defaults.benchmark-evidence-required",
			before: 32,
			after: 8,
			tokenMetricBefore: 32,
			tokenMetricAfter: 8,
			benchmarkEvidence: undefined,
		});

		expect(decision.outcome).toBe("blocked");
		expect(decision.reasons).toContain("benchmark evidence is required");
	});

	test("defaults.fixture-success-rate-must-be-bounded", () => {
		const decision = evaluateDefaultReduction({
			...PASSING_EVIDENCE,
			name: "defaults.fixture-success-rate-must-be-bounded",
			before: 32,
			after: 8,
			tokenMetricBefore: 32,
			tokenMetricAfter: 8,
			fixtureSuccessRateAfter: 1.1,
		});

		expect(decision.outcome).toBe("blocked");
		expect(decision.reasons).toContain("fixture success rates must be finite numbers in [0, 1]");
	});

	test("defaults.recursion-held", () => {
		const decision = evaluateDefaultReduction({
			...PASSING_EVIDENCE,
			name: "defaults.recursion-held",
			before: 2,
			after: 1,
			tokenMetricBefore: 2,
			tokenMetricAfter: 1,
			fixtureSuccessRateAfter: 0,
		});

		expect(decision.outcome).toBe("blocked");
		expect(decision.reasons).toContain("fixture success rate regressed");
	});

	test("defaults.output-caps-held", () => {
		const decision = evaluateDefaultReduction({
			...PASSING_EVIDENCE,
			name: "defaults.output-caps-held",
			before: 500_000,
			after: 250_000,
			tokenMetricBefore: 500_000,
			tokenMetricAfter: 250_000,
			fixtureSuccessRateAfter: 0,
		});

		expect(decision.outcome).toBe("blocked");
		expect(decision.reasons).toContain("fixture success rate regressed");
	});

	test("premortem.risky-default-lifecycle", () => {
		const decision = evaluateDefaultReduction({
			name: "premortem.risky-default-lifecycle",
			before: 32,
			after: 32,
			tokenMetricBefore: Number.NaN,
			tokenMetricAfter: Number.NaN,
			fixtureSuccessRateBefore: Number.NaN,
			fixtureSuccessRateAfter: Number.NaN,
			latencyRegressionWithinBudget: false,
			humanApproved: false,
		});

		expect(decision.outcome).toBe("blocked");
		expect(decision.reasons).toContain("after must be lower than before");
		expect(decision.reasons).toContain("token metrics must be finite numbers");
		expect(decision.reasons).toContain("fixture success rates must be finite numbers in [0, 1]");
		expect(decision.reasons).toContain("latency regression is outside budget or unproven");
		expect(decision.reasons).toContain("human approval is required");
		expect(decision.reasons).toContain("benchmark evidence is required");
		expect(decision.reasons).toContain("human approval evidence is required");
	});
});
