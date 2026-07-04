import { describe, expect, it } from "bun:test";
import { buildTaskReceipt, type TaskResultReceipt } from "../../src/task/receipt";
import { reconcileSpawnRoi } from "../../src/task/roi-reconciliation";
import type { SpawnPlanReceipt } from "../../src/task/spawn-gate";

const plan = (maxInlineTokens: number): SpawnPlanReceipt => ({
	whyParallel: "independent children",
	whyNotLocal: "separate scoped work",
	independence: "children do not overlap",
	expectedReceiptShape: "short receipt preview",
	maxInlineTokens,
});

function receipt(overrides: Partial<TaskResultReceipt> & Pick<TaskResultReceipt, "id" | "preview">): TaskResultReceipt {
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

describe("spawn ROI reconciliation", () => {
	it("returns undefined when there is no spawn plan promise to reconcile", () => {
		expect(reconcileSpawnRoi(undefined, [receipt({ id: "child-a", preview: "preview" })])).toBeUndefined();
	});

	it("marks an over-budget child and reports deterministic overage totals", () => {
		const result = reconcileSpawnRoi(plan(2), [receipt({ id: "child-a", preview: "123456789" })]);

		expect(result).toEqual({
			childCount: 1,
			promisedMaxInlineTokens: 2,
			children: [
				{
					id: "child-a",
					inlineTokens: 3,
					maxInlineTokens: 2,
					overBudget: true,
					overageTokens: 1,
					lowRoi: false,
				},
			],
			overBudgetChildIds: ["child-a"],
			lowRoiChildIds: [],
			totalInlineTokens: 3,
			totalOverageTokens: 1,
			advisoryFlags: ["over-inline-budget"],
		});
	});

	it("keeps an under-budget child advisory-only with no flags", () => {
		const result = reconcileSpawnRoi(plan(4), [receipt({ id: "child-a", preview: "123456789" })]);

		expect(result?.children).toEqual([
			{
				id: "child-a",
				inlineTokens: 3,
				maxInlineTokens: 4,
				overBudget: false,
				overageTokens: 0,
				lowRoi: false,
			},
		]);
		expect(result?.overBudgetChildIds).toEqual([]);
		expect(result?.advisoryFlags).toEqual([]);
	});

	it("reconciles mixed over-budget and low-ROI children", () => {
		const result = reconcileSpawnRoi(plan(3), [
			receipt({
				id: "child-b",
				preview: "1234567890123",
				roi: { tokens: 20, producedChanges: false, materialContribution: false, lowRoi: true },
			}),
			receipt({
				id: "child-a",
				preview: "1234",
				roi: { tokens: 5, producedChanges: true, materialContribution: true, lowRoi: false },
			}),
		]);

		expect(result?.children).toEqual([
			{
				id: "child-b",
				inlineTokens: 4,
				maxInlineTokens: 3,
				overBudget: true,
				overageTokens: 1,
				lowRoi: true,
			},
			{
				id: "child-a",
				inlineTokens: 1,
				maxInlineTokens: 3,
				overBudget: false,
				overageTokens: 0,
				lowRoi: false,
			},
		]);
		expect(result?.overBudgetChildIds).toEqual(["child-b"]);
		expect(result?.lowRoiChildIds).toEqual(["child-b"]);
		expect(result?.totalInlineTokens).toBe(5);
		expect(result?.totalOverageTokens).toBe(1);
		expect(result?.advisoryFlags).toEqual(["over-inline-budget", "low-roi-children"]);
	});

	it("returns an empty reconciliation for an empty batch", () => {
		expect(reconcileSpawnRoi(plan(5), [])).toEqual({
			childCount: 0,
			promisedMaxInlineTokens: 5,
			children: [],
			overBudgetChildIds: [],
			lowRoiChildIds: [],
			totalInlineTokens: 0,
			totalOverageTokens: 0,
			advisoryFlags: [],
		});
	});

	it("adds the all-low-roi flag only when every child is low ROI", () => {
		const result = reconcileSpawnRoi(plan(10), [
			receipt({
				id: "child-b",
				preview: "one",
				roi: { tokens: 1, producedChanges: false, materialContribution: false, lowRoi: true },
			}),
			receipt({
				id: "child-a",
				preview: "two",
				roi: { tokens: 1, producedChanges: false, materialContribution: false, lowRoi: true },
			}),
		]);

		expect(result?.lowRoiChildIds).toEqual(["child-a", "child-b"]);
		expect(result?.advisoryFlags).toEqual(["low-roi-children", "all-children-low-roi"]);
	});

	it("sorts advisory child id lists deterministically without reordering child details", () => {
		const result = reconcileSpawnRoi(plan(1), [
			receipt({
				id: "child-c",
				preview: "12345",
				roi: { tokens: 1, producedChanges: false, materialContribution: false, lowRoi: true },
			}),
			receipt({
				id: "child-a",
				preview: "12345",
				roi: { tokens: 1, producedChanges: false, materialContribution: false, lowRoi: true },
			}),
			receipt({
				id: "child-b",
				preview: "12345",
				roi: { tokens: 1, producedChanges: false, materialContribution: false, lowRoi: true },
			}),
		]);

		expect(result?.children.map(child => child.id)).toEqual(["child-c", "child-a", "child-b"]);
		expect(result?.overBudgetChildIds).toEqual(["child-a", "child-b", "child-c"]);
		expect(result?.lowRoiChildIds).toEqual(["child-a", "child-b", "child-c"]);
	});

	it("includes review summary text in the inline token proxy", () => {
		const result = reconcileSpawnRoi(plan(2), [
			receipt({
				id: "reviewed-child",
				preview: "1234",
				review: {
					overallCorrectness: "abcd",
					findingCount: 1,
					findings: [{ severity: "warning", summary: "abcdefgh" }],
				},
			}),
		]);

		expect(result?.children[0]?.inlineTokens).toBe(4);
		expect(result?.overBudgetChildIds).toEqual(["reviewed-child"]);
	});

	it("counts bounded review correctness from task receipts", () => {
		const receipt = buildTaskReceipt({
			index: 0,
			id: "reviewed-child",
			agent: "executor",
			agentSource: "bundled",
			task: "task",
			exitCode: 0,
			output: "small",
			stderr: "",
			truncated: false,
			durationMs: 1,
			tokens: 10,
			extractedToolData: {
				yield: [{ data: { overall_correctness: "x".repeat(50_000) } }],
			},
		});

		const result = reconcileSpawnRoi(plan(60), [receipt]);

		expect(receipt.review?.overallCorrectness).toHaveLength(200);
		expect(result?.children[0]?.inlineTokens).toBe(61);
		expect(result?.overBudgetChildIds).toEqual(["reviewed-child"]);
		expect(result?.totalOverageTokens).toBe(1);
	});

	it("is advisory-only and does not mutate receipts or expose status mutation fields", () => {
		const receipts = [
			receipt({
				id: "child-a",
				preview: "123456789",
				status: "failed",
				exitCode: 7,
				roi: { tokens: 1, producedChanges: false, materialContribution: false, lowRoi: true },
			}),
		];
		const before = JSON.stringify(receipts);

		const result = reconcileSpawnRoi(plan(2), receipts);

		expect(JSON.stringify(receipts)).toBe(before);
		expect(JSON.stringify(result)).not.toContain("status");
		expect(JSON.stringify(result)).not.toContain("exitCode");
	});
});
