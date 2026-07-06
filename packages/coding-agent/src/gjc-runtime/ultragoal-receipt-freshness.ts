import * as crypto from "node:crypto";
import type {
	UltragoalCompletionVerification,
	UltragoalGoal,
	UltragoalGoalStatus,
	UltragoalLedgerEvent,
	UltragoalPlan,
	UltragoalReceiptKind,
} from "./ultragoal-runtime";

export type UltragoalReceiptFreshnessDiagnostic = {
	state:
		| "inactive"
		| "unrelated_goal"
		| "active_verified_complete"
		| "active_missing_receipt"
		| "active_stale_receipt"
		| "active_missing_final_receipt"
		| "active_dirty_quality_gate"
		| "active_review_blocked_unrecorded"
		| "active_review_blocked_recorded"
		| "unreadable_fail_closed";
	message: string;
	goalId?: string;
};
function stableStructuredValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(item => stableStructuredValue(item));
	if (typeof value !== "object" || value === null) return value;
	const record = value as Record<string, unknown>;
	const sorted: Record<string, unknown> = {};
	for (const key of Object.keys(record).sort()) {
		const item = record[key];
		if (item !== undefined) sorted[key] = stableStructuredValue(item);
	}
	return sorted;
}

function hashStructuredValue(value: unknown): string {
	return crypto
		.createHash("sha256")
		.update(JSON.stringify(stableStructuredValue(value)))
		.digest("hex");
}

export function requiredUltragoalGoals(plan: UltragoalPlan): UltragoalGoal[] {
	return plan.goals.filter(goal => goal.status !== "superseded");
}

export function receiptRelevantGoals(
	plan: UltragoalPlan,
	goal: UltragoalGoal,
	receiptKind: UltragoalReceiptKind,
): UltragoalGoal[] {
	if (goal.validationBatch?.finalGoalId === goal.id) {
		return goal.validationBatch.memberIds.map(memberId => {
			const member = plan.goals.find(item => item.id === memberId);
			if (!member)
				throw new Error(`validation batch ${goal.validationBatch?.batchId} references missing goal ${memberId}`);
			return member;
		});
	}
	return receiptKind === "final-aggregate" ? requiredUltragoalGoals(plan) : [goal];
}

function ledgerEventId(event: UltragoalLedgerEvent): string | null {
	return typeof event.eventId === "string" && event.eventId.trim().length > 0 ? event.eventId : null;
}

function isReceiptFreshnessBookkeepingEvent(event: UltragoalLedgerEvent): boolean {
	return event.event === "nudge";
}

function latestRelevantLedgerEventId(
	ledger: readonly UltragoalLedgerEvent[],
	relevantGoalIds: readonly string[],
	excludeEventId?: string,
): string | null {
	const relevant = new Set(relevantGoalIds);
	for (const event of [...ledger].reverse()) {
		const eventId = ledgerEventId(event);
		if (eventId && eventId === excludeEventId) continue;
		if (isReceiptFreshnessBookkeepingEvent(event)) continue;
		const goalId = typeof event.goalId === "string" ? event.goalId.trim() : "";
		if (goalId && relevant.has(goalId)) return eventId;
	}
	return null;
}

function planSnapshotForReceipt(input: {
	plan: UltragoalPlan;
	goal: UltragoalGoal;
	beforeStatus: UltragoalGoalStatus;
	targetGoalUpdatedAt: string;
	receiptKind: UltragoalReceiptKind;
}): unknown {
	const targetGoalSnapshot = {
		...input.goal,
		status: input.beforeStatus,
		updatedAt: input.targetGoalUpdatedAt,
		evidence: undefined,
		completedAt: undefined,
		completionVerification: undefined,
	};
	const goals =
		input.receiptKind === "final-aggregate"
			? input.plan.goals.map(goal => ({
					...goal,
					status: goal.id === input.goal.id ? input.beforeStatus : goal.status,
					updatedAt: goal.id === input.goal.id ? input.targetGoalUpdatedAt : goal.updatedAt,
					evidence: goal.id === input.goal.id ? undefined : goal.evidence,
					completedAt: goal.id === input.goal.id ? undefined : goal.completedAt,
					completionVerification: undefined,
				}))
			: [targetGoalSnapshot];
	return {
		version: input.plan.version,
		brief: input.plan.brief,
		gjcGoalMode: input.plan.gjcGoalMode,
		gjcObjective: input.plan.gjcObjective,
		gjcObjectiveAliases: input.plan.gjcObjectiveAliases,
		createdAt: input.plan.createdAt,
		goals,
	};
}

export function computeUltragoalPlanGeneration(input: {
	plan: UltragoalPlan;
	ledger: readonly UltragoalLedgerEvent[];
	goal: UltragoalGoal;
	receiptKind: UltragoalReceiptKind;
	beforeStatus: UltragoalGoalStatus;
	excludeEventId?: string;
	targetGoalUpdatedAt?: string;
}): {
	planGeneration: string;
	basis: UltragoalCompletionVerification["basis"];
} {
	const relevantGoals = receiptRelevantGoals(input.plan, input.goal, input.receiptKind);
	const relevantGoalIds = relevantGoals.map(goal => goal.id);
	const targetGoalUpdatedAt = input.targetGoalUpdatedAt ?? input.goal.updatedAt;
	const planHashBeforeCheckpoint = hashStructuredValue(
		planSnapshotForReceipt({
			plan: input.plan,
			goal: input.goal,
			beforeStatus: input.beforeStatus,
			targetGoalUpdatedAt,
			receiptKind: input.receiptKind,
		}),
	);
	const requiredGoalSetHashBeforeCheckpoint = hashStructuredValue(
		relevantGoals.map(goal => ({
			id: goal.id,
			status: goal.id === input.goal.id ? input.beforeStatus : goal.status,
			updatedAt: goal.id === input.goal.id ? targetGoalUpdatedAt : goal.updatedAt,
		})),
	);
	const basis: UltragoalCompletionVerification["basis"] = {
		planHashBeforeCheckpoint,
		latestRelevantLedgerEventIdBeforeCheckpoint: latestRelevantLedgerEventId(
			input.ledger,
			relevantGoalIds,
			input.excludeEventId,
		),
		goalUpdatedAtBeforeCheckpoint: targetGoalUpdatedAt,
		relevantGoalIdsBeforeCheckpoint: relevantGoalIds,
		requiredGoalSetHashBeforeCheckpoint,
	};
	return { planGeneration: hashStructuredValue(basis), basis };
}

export function findLedgerReceiptEvent(
	ledger: readonly UltragoalLedgerEvent[],
	receipt: UltragoalCompletionVerification,
): UltragoalLedgerEvent | null {
	return (
		ledger.find(event => {
			if (event.eventId !== receipt.checkpointLedgerEventId) return false;
			if (event.event !== "goal_checkpointed") return false;
			if (event.goalId !== receipt.goalId) return false;
			const eventReceipt = event.completionVerification as UltragoalCompletionVerification | undefined;
			return (
				event.status === "complete" &&
				eventReceipt?.receiptId === receipt.receiptId &&
				eventReceipt.receiptKind === receipt.receiptKind &&
				eventReceipt.planGeneration === receipt.planGeneration
			);
		}) ?? null
	);
}

export function validateReceiptFreshBase(input: {
	plan: UltragoalPlan;
	ledger: readonly UltragoalLedgerEvent[];
	goal: UltragoalGoal;
	receipt: UltragoalCompletionVerification;
	receiptKind: UltragoalReceiptKind;
}): UltragoalReceiptFreshnessDiagnostic | null {
	if (
		input.receipt.schemaVersion !== 1 ||
		input.receipt.goalId !== input.goal.id ||
		input.receipt.receiptKind !== input.receiptKind ||
		!input.receipt.planGeneration ||
		!input.receipt.checkpointLedgerEventId
	) {
		return {
			state: "active_stale_receipt",
			message: `Ultragoal ${input.goal.id} receipt is malformed or stale.`,
			goalId: input.goal.id,
		};
	}
	const event = findLedgerReceiptEvent(input.ledger, input.receipt);
	if (!event)
		return {
			state: "active_stale_receipt",
			message: `Ultragoal ${input.goal.id} receipt ledger event is missing.`,
			goalId: input.goal.id,
		};
	const generation = computeUltragoalPlanGeneration({
		plan: input.plan,
		ledger: input.ledger,
		goal: input.goal,
		receiptKind: input.receiptKind,
		beforeStatus: input.receipt.goalStatusBeforeCheckpoint,
		excludeEventId: input.receipt.checkpointLedgerEventId,
	});
	if (generation.planGeneration !== input.receipt.planGeneration)
		return {
			state: "active_stale_receipt",
			message: `Ultragoal ${input.goal.id} receipt generation is stale.`,
			goalId: input.goal.id,
		};
	if (hashStructuredValue(event.qualityGateJson) !== input.receipt.qualityGateHash)
		return {
			state: "active_dirty_quality_gate",
			message: `Ultragoal ${input.goal.id} receipt quality-gate hash does not match ledger.`,
			goalId: input.goal.id,
		};
	if (input.goal.updatedAt !== input.receipt.verifiedAt)
		return {
			state: "active_stale_receipt",
			message: `Ultragoal ${input.goal.id} receipt target changed after verification.`,
			goalId: input.goal.id,
		};
	return null;
}

export function findFreshBatchCloseReceipt(input: {
	plan: UltragoalPlan;
	ledger: readonly UltragoalLedgerEvent[];
	deferredGoal: UltragoalGoal;
	deferredReceipt: UltragoalCompletionVerification;
}): UltragoalCompletionVerification | null {
	const batch = input.deferredReceipt.validationBatch;
	if (batch?.role !== "deferred-member") return null;
	const finalGoal = input.plan.goals.find(goal => goal.id === batch.finalGoalId);
	const finalReceipt = finalGoal?.completionVerification;
	if (!finalGoal || finalReceipt?.validationBatch?.role !== "batch-close") return null;
	if (
		finalReceipt.validationBatch.batchId !== batch.batchId ||
		finalReceipt.validationBatch.memberReceiptIds[input.deferredGoal.id] !== input.deferredReceipt.receiptId
	)
		return null;
	const diagnostic = validateReceiptFreshBase({
		plan: input.plan,
		ledger: input.ledger,
		goal: finalGoal,
		receipt: finalReceipt,
		receiptKind: finalReceipt.receiptKind,
	});
	return diagnostic ? null : finalReceipt;
}

export function validateDeferredMemberReceiptFresh(input: {
	plan: UltragoalPlan;
	ledger: readonly UltragoalLedgerEvent[];
	goal: UltragoalGoal;
	receipt: UltragoalCompletionVerification;
	receiptKind: UltragoalReceiptKind;
	requireClose: boolean;
}): UltragoalReceiptFreshnessDiagnostic {
	const batch = input.receipt.validationBatch;
	if (
		batch?.role !== "deferred-member" ||
		input.goal.validationBatch?.metadataHash !== batch.metadataHash ||
		input.goal.validationBatch.batchId !== batch.batchId
	) {
		return {
			state: "active_stale_receipt",
			message: `Ultragoal ${input.goal.id} deferred receipt is malformed or stale.`,
			goalId: input.goal.id,
		};
	}
	const base = validateReceiptFreshBase(input);
	if (base) return base;
	if (
		input.requireClose &&
		!findFreshBatchCloseReceipt({
			plan: input.plan,
			ledger: input.ledger,
			deferredGoal: input.goal,
			deferredReceipt: input.receipt,
		})
	) {
		return {
			state: "active_missing_final_receipt",
			message: `Ultragoal ${input.goal.id} is deferred to validation batch ${batch.batchId} until final goal ${batch.finalGoalId} closes the batch`,
			goalId: input.goal.id,
		};
	}
	return {
		state: "active_verified_complete",
		message: `Ultragoal ${input.goal.id} has a fresh deferred validation batch receipt.`,
		goalId: input.goal.id,
	};
}
