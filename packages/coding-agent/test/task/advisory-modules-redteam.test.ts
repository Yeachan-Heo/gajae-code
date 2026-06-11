import { describe, expect, it } from "bun:test";
import { adviseForkContextMode } from "../../src/task/fork-context-advisory";
import type { TaskResultReceipt } from "../../src/task/receipt";
import { reconcileSpawnRoi } from "../../src/task/roi-reconciliation";
import type { SpawnPlanReceipt } from "../../src/task/spawn-gate";

function plan(maxInlineTokens: number): SpawnPlanReceipt {
	return {
		whyParallel: "children are independent",
		whyNotLocal: "separate bounded reviews",
		independence: "no overlapping files",
		expectedReceiptShape: "short receipt previews",
		maxInlineTokens,
	};
}

function taskReceipt(
	overrides: Partial<TaskResultReceipt> & Pick<TaskResultReceipt, "id" | "preview">,
): TaskResultReceipt {
	return {
		index: 0,
		agent: "executor",
		agentSource: "bundled",
		task: "task",
		status: "completed",
		exitCode: 0,
		truncated: false,
		durationMs: 1,
		tokens: 10,
		previewTruncated: false,
		...overrides,
	};
}

describe("advisory modules red-team", () => {
	describe("spawn ROI reconciliation", () => {
		it("handles zero-token previews, one-token budget boundaries, unicode lengths, duplicate ids, huge budgets, and input purity", () => {
			const hugeBudget = Number.MAX_SAFE_INTEGER - 1;
			const receipts = [
				taskReceipt({ id: "empty", preview: "" }),
				taskReceipt({ id: "one-token", preview: "abcd" }),
				taskReceipt({ id: "two-token", preview: "abcde" }),
				taskReceipt({ id: "unicode", preview: "🚀🚀🚀" }),
				taskReceipt({ id: "dup", preview: "abcde" }),
				taskReceipt({ id: "dup", preview: "abcdefgh" }),
				taskReceipt({
					id: "huge",
					preview: "x".repeat(128),
					roi: { tokens: 1, producedChanges: true, materialContribution: true, lowRoi: true },
				}),
			];
			const beforeReceipts = JSON.stringify(receipts);
			const spawnPlan = plan(1);
			const beforePlan = JSON.stringify(spawnPlan);

			const result = reconcileSpawnRoi(spawnPlan, receipts);
			const hugeResult = reconcileSpawnRoi(plan(hugeBudget), [
				taskReceipt({ id: "huge", preview: "x".repeat(128) }),
			]);

			expect(result?.children).toEqual([
				{ id: "empty", inlineTokens: 0, maxInlineTokens: 1, overBudget: false, overageTokens: 0, lowRoi: false },
				{
					id: "one-token",
					inlineTokens: 1,
					maxInlineTokens: 1,
					overBudget: false,
					overageTokens: 0,
					lowRoi: false,
				},
				{ id: "two-token", inlineTokens: 2, maxInlineTokens: 1, overBudget: true, overageTokens: 1, lowRoi: false },
				{ id: "unicode", inlineTokens: 2, maxInlineTokens: 1, overBudget: true, overageTokens: 1, lowRoi: false },
				{ id: "dup", inlineTokens: 2, maxInlineTokens: 1, overBudget: true, overageTokens: 1, lowRoi: false },
				{ id: "dup", inlineTokens: 2, maxInlineTokens: 1, overBudget: true, overageTokens: 1, lowRoi: false },
				{ id: "huge", inlineTokens: 32, maxInlineTokens: 1, overBudget: true, overageTokens: 31, lowRoi: true },
			]);
			expect(result?.overBudgetChildIds).toEqual(["dup", "dup", "huge", "two-token", "unicode"]);
			expect(result?.lowRoiChildIds).toEqual(["huge"]);
			expect(hugeResult?.children[0]).toMatchObject({ overBudget: false, overageTokens: 0 });
			expect(JSON.stringify(receipts)).toBe(beforeReceipts);
			expect(JSON.stringify(spawnPlan)).toBe(beforePlan);
		});

		it("counts every inlined review finding summary in the token proxy", () => {
			const findings = Array.from({ length: 20 }, (_, index) => ({ summary: `${index}`.padStart(4, "x") }));
			const result = reconcileSpawnRoi(plan(20), [
				taskReceipt({
					id: "many-findings",
					preview: "",
					review: { overallCorrectness: "abcd", findingCount: 100, findings },
				}),
			]);

			expect(result?.children[0]?.inlineTokens).toBe(21);
			expect(result?.overBudgetChildIds).toEqual(["many-findings"]);
		});
	});

	describe("fork context advisory", () => {
		it("documents that trigger phrases in code blocks and URLs still activate heuristics", () => {
			const advisory = adviseForkContextMode({
				assignment: "```txt\nsee above\n```\nUse https://example.test/.gjc/plans/plan.md for context.",
			});

			expect(advisory.recommendedMode).toBe("last-turn");
			expect(advisory.reasons).toEqual(["last-turn-reference:see-above", "prior-session-reference:gjc-plans-path"]);
		});

		it("chooses a deterministic winner for conflicting receipt and last-turn triggers", () => {
			const advisory = adviseForkContextMode({
				assignment: "As discussed, use the previous turn and .gjc/specs/context.md.",
			});

			expect(advisory.recommendedMode).toBe("last-turn");
			expect(advisory.reasons).toEqual([
				"last-turn-reference:the-previous-turn",
				"prior-session-reference:as-discussed",
				"prior-session-reference:gjc-specs-path",
			]);
		});

		it("respects explicit none even when receipt and last-turn triggers are strong", () => {
			const advisory = adviseForkContextMode({
				assignment: "As decided earlier in this session, see above and use .gjc/plans/x.md.",
				explicitMode: "none",
				parentContextTokens: 50_000,
			});

			expect(advisory.recommendedMode).toBe("none");
			expect(advisory.reasons).toEqual(["explicit-caller-mode"]);
		});

		it("keeps empty assignments at none; zero/negative parents clone zero in every mode", () => {
			expect(adviseForkContextMode({ assignment: "" })).toMatchObject({
				recommendedMode: "none",
				reasons: [],
				estimatedClonedTokens: { none: 0, receipt: 0, "last-turn": 0, bounded: 0, full: 0 },
			});
			expect(adviseForkContextMode({ assignment: "", parentContextTokens: 0 }).estimatedClonedTokens).toEqual({
				none: 0,
				receipt: 0,
				"last-turn": 0,
				bounded: 0,
				full: 0,
			});
			expect(adviseForkContextMode({ assignment: "", parentContextTokens: -10 }).estimatedClonedTokens).toEqual({
				none: 0,
				receipt: 0,
				"last-turn": 0,
				bounded: 0,
				full: 0,
			});
		});

		it("matches trigger phrases case-insensitively", () => {
			const advisory = adviseForkContextMode({ assignment: "SEE ABOVE and AS DISCUSSED." });

			expect(advisory.recommendedMode).toBe("last-turn");
			expect(advisory.reasons).toEqual(["last-turn-reference:see-above", "prior-session-reference:as-discussed"]);
		});
	});
});
