import type { TaskResultReceipt } from "./receipt";
import type { SpawnPlanReceipt } from "./spawn-gate";

/**
 * Pure, advisory-only reconciliation between a spawn plan's inline-token promise
 * and receipt-safe child outputs. These signals never change task success/failure
 * semantics or runtime behavior; they only describe budget/ROI observations for
 * model-facing summaries.
 */
export interface SpawnRoiChildReconciliation {
	id: string;
	inlineTokens: number;
	maxInlineTokens: number;
	overBudget: boolean;
	overageTokens: number;
	lowRoi: boolean;
}

export interface SpawnRoiReconciliation {
	childCount: number;
	promisedMaxInlineTokens: number;
	children: SpawnRoiChildReconciliation[];
	overBudgetChildIds: string[];
	lowRoiChildIds: string[];
	totalInlineTokens: number;
	totalOverageTokens: number;
	advisoryFlags: string[];
}

function estimateTextTokens(text: string | undefined): number {
	if (!text) return 0;
	return Math.ceil(text.length / 4);
}

/**
 * Estimate model-facing inline cost from receipt-safe fields only. The proxy uses
 * one token per four characters, rounded up independently for the preview and
 * review summaries that may be inlined for the parent model.
 */
function estimateInlineTokens(receipt: TaskResultReceipt): number {
	const review = receipt.review;
	const reviewSummaryChars =
		(review?.overallCorrectness?.length ?? 0) +
		(review?.findings?.reduce((total, finding) => total + finding.summary.length, 0) ?? 0);
	return estimateTextTokens(receipt.preview) + Math.ceil(reviewSummaryChars / 4);
}

export function reconcileSpawnRoi(
	plan: SpawnPlanReceipt | undefined,
	receipts: readonly TaskResultReceipt[],
): SpawnRoiReconciliation | undefined {
	if (!plan) return undefined;

	const children = receipts.map(receipt => {
		const inlineTokens = estimateInlineTokens(receipt);
		const overageTokens = Math.max(0, inlineTokens - plan.maxInlineTokens);
		return {
			id: receipt.id,
			inlineTokens,
			maxInlineTokens: plan.maxInlineTokens,
			overBudget: overageTokens > 0,
			overageTokens,
			lowRoi: Boolean(receipt.roi?.lowRoi),
		};
	});
	const overBudgetChildIds = children
		.filter(child => child.overBudget)
		.map(child => child.id)
		.toSorted();
	const lowRoiChildIds = children
		.filter(child => child.lowRoi)
		.map(child => child.id)
		.toSorted();
	const advisoryFlags = [
		...(overBudgetChildIds.length > 0 ? ["over-inline-budget"] : []),
		...(lowRoiChildIds.length > 0 ? ["low-roi-children"] : []),
		...(children.length > 0 && lowRoiChildIds.length === children.length ? ["all-children-low-roi"] : []),
	];

	return {
		childCount: children.length,
		promisedMaxInlineTokens: plan.maxInlineTokens,
		children,
		overBudgetChildIds,
		lowRoiChildIds,
		totalInlineTokens: children.reduce((total, child) => total + child.inlineTokens, 0),
		totalOverageTokens: children.reduce((total, child) => total + child.overageTokens, 0),
		advisoryFlags,
	};
}
