export interface DefaultReductionEvidence {
	name: string;
	before: number;
	after: number;
	tokenMetricBefore: number;
	tokenMetricAfter: number;
	fixtureSuccessRateBefore: number;
	fixtureSuccessRateAfter: number;
	latencyRegressionWithinBudget: boolean;
	humanApproved: boolean;
	benchmarkEvidence?: DefaultReductionBenchmarkEvidence;
	humanApprovalEvidence?: DefaultReductionHumanApprovalEvidence;
}

export interface DefaultReductionBenchmarkEvidence {
	suite: "orchestration-token-benchmark";
	command: string;
	fixtureSuccessCriterion: "after>=before";
	tokenMetricCriterion: "after<before";
	status: "passed";
}

export interface DefaultReductionHumanApprovalEvidence {
	approved: true;
	source: "github-pr";
	prNumber: 272;
	approver: string;
	reference: string;
}

export type DefaultReductionDecision = { outcome: "allowed" | "blocked"; reasons: string[] };

function isFiniteNumber(value: number): boolean {
	return Number.isFinite(value);
}

function hasText(value: string): boolean {
	return value.trim().length > 0;
}

function isRate(value: number): boolean {
	return Number.isFinite(value) && value >= 0 && value <= 1;
}

function validateBenchmarkEvidence(evidence: DefaultReductionEvidence, reasons: string[]): void {
	const benchmark = evidence.benchmarkEvidence;
	if (!benchmark) {
		reasons.push("benchmark evidence is required");
		return;
	}
	if (benchmark.suite !== "orchestration-token-benchmark") {
		reasons.push("benchmark evidence must come from orchestration-token-benchmark");
	}
	if (!hasText(benchmark.command)) {
		reasons.push("benchmark evidence command is required");
	}
	if (benchmark.fixtureSuccessCriterion !== "after>=before") {
		reasons.push("benchmark fixture success criterion must be after>=before");
	}
	if (benchmark.tokenMetricCriterion !== "after<before") {
		reasons.push("benchmark token metric criterion must be after<before");
	}
	if (benchmark.status !== "passed") {
		reasons.push("benchmark evidence must be passing");
	}
}

function validateHumanApprovalEvidence(evidence: DefaultReductionEvidence, reasons: string[]): void {
	const approval = evidence.humanApprovalEvidence;
	if (!approval) {
		reasons.push("human approval evidence is required");
		return;
	}
	if (approval.approved !== true) {
		reasons.push("human approval evidence must be approved");
	}
	if (approval.source !== "github-pr" || approval.prNumber !== 272) {
		reasons.push("human approval evidence must be anchored to PR #272");
	}
	if (!hasText(approval.approver)) {
		reasons.push("human approval approver is required");
	}
	if (!approval.reference.startsWith("https://github.com/Yeachan-Heo/gajae-code/pull/272")) {
		reasons.push("human approval reference must point at PR #272");
	}
}

export function evaluateDefaultReduction(evidence: DefaultReductionEvidence): DefaultReductionDecision {
	const reasons: string[] = [];

	if (!hasText(evidence.name)) {
		reasons.push("name is required");
	}
	if (!isFiniteNumber(evidence.before) || !isFiniteNumber(evidence.after)) {
		reasons.push("before and after must be finite numbers");
	} else if (evidence.after >= evidence.before) {
		reasons.push("after must be lower than before");
	}
	if (!isFiniteNumber(evidence.tokenMetricBefore) || !isFiniteNumber(evidence.tokenMetricAfter)) {
		reasons.push("token metrics must be finite numbers");
	} else if (evidence.tokenMetricAfter >= evidence.tokenMetricBefore) {
		reasons.push("token metric regressed or did not decrease");
	}
	if (!isRate(evidence.fixtureSuccessRateBefore) || !isRate(evidence.fixtureSuccessRateAfter)) {
		reasons.push("fixture success rates must be finite numbers in [0, 1]");
	} else if (evidence.fixtureSuccessRateAfter < evidence.fixtureSuccessRateBefore) {
		reasons.push("fixture success rate regressed");
	}
	if (!evidence.latencyRegressionWithinBudget) {
		reasons.push("latency regression is outside budget or unproven");
	}
	if (evidence.humanApproved !== true) {
		reasons.push("human approval is required");
	}
	validateBenchmarkEvidence(evidence, reasons);
	validateHumanApprovalEvidence(evidence, reasons);

	return { outcome: reasons.length === 0 ? "allowed" : "blocked", reasons };
}
