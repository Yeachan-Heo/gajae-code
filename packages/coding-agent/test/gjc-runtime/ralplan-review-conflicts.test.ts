import { describe, expect, it } from "bun:test";
import {
	actionsAreIncompatible,
	detectReviewConflicts,
	evaluateReviewJoinGate,
	parseReviewConflictDocument,
	RALPLAN_REVIEW_CONFLICTS_SCHEMA,
	type ReviewFinding,
	serializeReviewConflictDocument,
} from "../../src/gjc-runtime/ralplan-review-conflicts";

function finding(
	partial: Pick<ReviewFinding, "findingId" | "targetId" | "action" | "sourceRole"> &
		Partial<ReviewFinding>,
): ReviewFinding {
	return {
		severity: "block",
		evidence: "fixture evidence",
		sourceReceipt: {
			stage: partial.sourceRole,
			stageN: 1,
			path: `/tmp/${partial.sourceRole}.md`,
			sha256: "abc",
		},
		...partial,
	};
}

describe("ralplan review conflicts (#2902)", () => {
	it("treats add vs remove on the same target as incompatible", () => {
		expect(actionsAreIncompatible("add", "remove")).toBe(true);
		expect(actionsAreIncompatible("remove", "change")).toBe(true);
		expect(actionsAreIncompatible("add", "add")).toBe(false);
		expect(actionsAreIncompatible("add", "clarify")).toBe(false);
	});

	it("detects a deterministic conflict for Architect remove vs Critic add", () => {
		const findings = [
			finding({
				findingId: "arch-1",
				targetId: "contract.state_classification",
				action: "remove",
				sourceRole: "architect",
			}),
			finding({
				findingId: "crit-1",
				targetId: "contract.state_classification",
				action: "add",
				sourceRole: "critic",
			}),
		];
		const conflicts = detectReviewConflicts(findings);
		expect(conflicts).toHaveLength(1);
		expect(conflicts[0]!.conflictId).toBe(
			"conflict:contract.state_classification:arch-1:crit-1",
		);
		expect(conflicts[0]!.status).toBe("open");
		expect(conflicts[0]!.sourceRoles.sort()).toEqual(["architect", "critic"]);
	});

	it("blocks join until every conflict is dispositioned with owner and rationale", () => {
		const findings = [
			finding({
				findingId: "arch-1",
				targetId: "section.auth",
				action: "remove",
				sourceRole: "architect",
			}),
			finding({
				findingId: "crit-1",
				targetId: "section.auth",
				action: "add",
				sourceRole: "critic",
			}),
		];
		const open = evaluateReviewJoinGate(findings, []);
		expect(open.ok).toBe(false);
		expect(open.openConflictIds).toHaveLength(1);

		const conflictId = open.openConflictIds[0]!;
		const closed = evaluateReviewJoinGate(findings, [
			{
				conflictId,
				choice: "accept_architect",
				rationale: "Field is redundant with existing session identity.",
				decisionOwner: "ralplan-leader",
				affectedSections: ["## Contracts"],
			},
		]);
		expect(closed.ok).toBe(true);
		expect(closed.openConflictIds).toHaveLength(0);
	});

	it("parseReviewConflictDocument fails closed on open conflicts and accepts a clean disposition set", () => {
		const openDoc = {
			schema: RALPLAN_REVIEW_CONFLICTS_SCHEMA,
			plannerStageN: 1,
			findings: [
				finding({
					findingId: "arch-1",
					targetId: "target.x",
					action: "remove",
					sourceRole: "architect",
				}),
				finding({
					findingId: "crit-1",
					targetId: "target.x",
					action: "add",
					sourceRole: "critic",
				}),
			],
			dispositions: [],
		};
		expect(() => parseReviewConflictDocument(openDoc)).toThrow(/Join blocked/);

		const conflictId = detectReviewConflicts(openDoc.findings)[0]!.conflictId;
		const closed = parseReviewConflictDocument({
			...openDoc,
			dispositions: [
				{
					conflictId,
					choice: "synthesize",
					rationale: "Keep target.x optional with explicit migration note.",
					decisionOwner: "ralplan-leader",
					affectedSections: ["## Data model"],
				},
			],
		});
		expect(closed.conflicts).toHaveLength(1);
		expect(closed.conflicts[0]!.status).toBe("dispositioned");
		expect(serializeReviewConflictDocument(closed)).toContain(RALPLAN_REVIEW_CONFLICTS_SCHEMA);
	});
});
