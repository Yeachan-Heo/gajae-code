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
}

export type DefaultReductionDecision = { outcome: "allowed" | "blocked"; reasons: string[] };

function isFiniteNumber(value: number): boolean {
	return Number.isFinite(value);
}

export function evaluateDefaultReduction(evidence: DefaultReductionEvidence): DefaultReductionDecision {
	const reasons: string[] = [];

	if (evidence.name.trim().length === 0) {
		reasons.push("name is required");
	}
	if (!isFiniteNumber(evidence.before) || !isFiniteNumber(evidence.after)) {
		reasons.push("before and after must be finite numbers");
	} else if (evidence.after >= evidence.before) {
		reasons.push("after must be lower than before");
	}
	if (!isFiniteNumber(evidence.tokenMetricBefore) || !isFiniteNumber(evidence.tokenMetricAfter)) {
		reasons.push("token metrics must be finite numbers");
	}
	if (!isFiniteNumber(evidence.fixtureSuccessRateBefore) || !isFiniteNumber(evidence.fixtureSuccessRateAfter)) {
		reasons.push("fixture success rates must be finite numbers");
	} else if (evidence.fixtureSuccessRateAfter < evidence.fixtureSuccessRateBefore) {
		reasons.push("fixture success rate regressed");
	}
	if (!evidence.latencyRegressionWithinBudget) {
		reasons.push("latency regression is outside budget or unproven");
	}
	if (evidence.humanApproved !== true) {
		reasons.push("human approval is required");
	}

	return { outcome: reasons.length === 0 ? "allowed" : "blocked", reasons };
}
