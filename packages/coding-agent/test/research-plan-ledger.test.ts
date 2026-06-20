import { describe, expect, it } from "bun:test";
import {
	evaluateResearchLedger,
	type ResearchEvidenceEntry,
	type ResearchPlanItem,
	validateResearchPlanItem,
} from "../src/research-plan";

function makePlanItem(partial: Partial<ResearchPlanItem> = {}): ResearchPlanItem {
	return {
		claim: "Model X reduces latency by 30% on production-like workloads",
		confidence: "medium",
		unknowns: ["production workload mix"],
		evidenceNeeded: ["benchmark with production-like fixture", "baseline comparison"],
		counterexampleQueries: ["regression on long-context workload", "cold-start latency increase"],
		sourceConflictPolicy: "Reject the claim when any credible counterexample contradicts the benchmark.",
		dropCondition: "Drop if a counterexample contradicts the claim or key unknowns remain unresolved.",
		verifierChecks: ["check source freshness", "compare benchmark harness", "inspect counterexample evidence"],
		...partial,
	};
}

describe("research plan ledger", () => {
	it("validates the product-facing research plan item contract", () => {
		const result = validateResearchPlanItem(makePlanItem());
		expect(result).toEqual({ valid: true, errors: [] });
	});

	it("rejects incomplete plan items before workers collect evidence", () => {
		const result = validateResearchPlanItem({
			claim: " ",
			confidence: "medium",
			unknowns: [],
			evidenceNeeded: [],
			counterexampleQueries: [],
			sourceConflictPolicy: "",
			dropCondition: "",
			verifierChecks: [],
		});
		expect(result.valid).toBe(false);
		expect(result.errors).toContain("claim must be a non-empty string");
		expect(result.errors).toContain("evidenceNeeded must contain at least 1 item(s)");
		expect(result.errors).toContain("counterexampleQueries must contain at least 1 item(s)");
		expect(result.errors).toContain("sourceConflictPolicy must be a non-empty string");
		expect(result.errors).toContain("dropCondition must be a non-empty string");
		expect(result.errors).toContain("verifierChecks must contain at least 1 item(s)");
	});

	it("accepts a claim only when supporting evidence survives verification", () => {
		const item = makePlanItem();
		const evidence: ResearchEvidenceEntry[] = [
			{
				claim: item.claim,
				source: "benchmarks/latency-prod-fixture.md",
				confidence: "high",
				verdict: "support",
			},
		];

		const verdict = evaluateResearchLedger(item, evidence);
		expect(verdict).toMatchObject({
			claim: item.claim,
			finalVerdict: "accepted",
			unresolvedUnknowns: [],
		});
		expect(verdict.rejectReason).toBeUndefined();
	});

	it("rejects a plausible claim when counterexample evidence triggers the drop condition", () => {
		const item = makePlanItem();
		const evidence: ResearchEvidenceEntry[] = [
			{
				claim: item.claim,
				source: "benchmarks/latency-prod-fixture.md",
				confidence: "high",
				verdict: "support",
			},
			{
				claim: item.claim,
				source: "counterexamples/long-context-regression.md",
				confidence: "high",
				verdict: "contradict",
				notes: "Long-context p95 latency regressed by 18%, contradicting the broad latency-reduction claim.",
			},
		];

		const verdict = evaluateResearchLedger(item, evidence);
		expect(verdict.finalVerdict).toBe("rejected");
		expect(verdict.rejectReason).toContain("contradictory source");
		expect(verdict.rejectReason).toContain("counterexamples/long-context-regression.md");
	});

	it("marks claims uncertain when evidence collection never covers the plan item", () => {
		const item = makePlanItem();
		expect(evaluateResearchLedger(item, [])).toMatchObject({
			claim: item.claim,
			finalVerdict: "uncertain",
			rejectReason: "no evidence collected for claim",
			unresolvedUnknowns: ["production workload mix"],
		});
	});
});
