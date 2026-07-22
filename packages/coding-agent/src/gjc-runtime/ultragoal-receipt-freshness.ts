import * as crypto from "node:crypto";
import type {
	UltragoalCompletionVerification,
	UltragoalGoal,
	UltragoalGoalStatus,
	UltragoalLedgerEvent,
	UltragoalPlan,
	UltragoalReceiptKind,
} from "./ultragoal-runtime";

export const CRITIC_VERDICT_EVENT = "critic_verdict";
export const CRITIC_GATE_HARD_STOP_EVENT = "critic_gate_hard_stop";
export const CRITIC_GATE_OVERRIDE_EVENT = "critic_gate_override";
export const TERMINAL_CRITIC_CEILING = 5;
export type CriticVerdict = "OKAY" | "ITERATE" | "REJECT";

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

/** Hash the current required-goal set for terminal critic verdict freshness. */
export function computeCriticVerdictPlanGeneration(plan: UltragoalPlan): string {
	return hashStructuredValue(
		requiredUltragoalGoals(plan).map(goal => ({
			id: goal.id,
			status: goal.status,
			updatedAt: goal.updatedAt,
		})),
	);
}

export function isCleanPauseCriticVerdictShape(
	candidate: UltragoalLedgerEvent,
	planGeneration: string,
	classificationEventId: string,
): boolean {
	return (
		candidate.event === CRITIC_VERDICT_EVENT &&
		candidate.terminus === "pause" &&
		candidate.verdict === "OKAY" &&
		typeof candidate.evidence === "string" &&
		candidate.evidence.trim().length > 0 &&
		Array.isArray(candidate.blockers) &&
		candidate.blockers.length === 0 &&
		candidate.planGeneration === planGeneration &&
		candidate.classificationEventId === classificationEventId
	);
}

export function isCleanPauseCriticVerdict(
	event: UltragoalLedgerEvent,
	opts: { planGeneration: string; classificationEventId: string },
): boolean {
	return isCleanPauseCriticVerdictShape(event, opts.planGeneration, opts.classificationEventId);
}

export function findCleanPauseCriticVerdict(
	plan: UltragoalPlan,
	ledger: readonly UltragoalLedgerEvent[],
	classificationEventId: string,
): UltragoalLedgerEvent | null {
	const classificationIndex = ledger.findIndex(event => event.eventId === classificationEventId);
	if (classificationIndex < 0) return null;
	const planGeneration = computeCriticVerdictPlanGeneration(plan);
	for (let index = ledger.length - 1; index > classificationIndex; index--) {
		const event = ledger[index];
		if (
			event.event !== CRITIC_VERDICT_EVENT ||
			event.terminus !== "pause" ||
			event.planGeneration !== planGeneration ||
			event.classificationEventId !== classificationEventId
		)
			continue;
		return isCleanPauseCriticVerdict(event, { planGeneration, classificationEventId }) ? event : null;
	}
	return null;
}

/** Pure: count all ledger `critic_verdict` rows for an exact plan generation. */
export function countTerminalCriticVerdicts(ledger: readonly UltragoalLedgerEvent[], planGeneration: string): number {
	return ledger.filter(event => event.event === CRITIC_VERDICT_EVENT && event.planGeneration === planGeneration)
		.length;
}
/** Pure: count every non-OKAY terminal critic verdict recorded for this run. */
export function countNonOkayTerminalCriticVerdicts(
	ledger: readonly UltragoalLedgerEvent[],
	_legacyPlanGeneration?: string,
): number {
	return ledger.filter(event => event.event === CRITIC_VERDICT_EVENT && event.verdict !== "OKAY").length;
}

export function terminalCriticHardStopReached(
	ledger: readonly UltragoalLedgerEvent[],
	_legacyPlanGeneration?: string,
): boolean {
	return ledger.some(event => event.event === CRITIC_GATE_HARD_STOP_EVENT);
}

export function terminalCriticGateOverridden(ledger: readonly UltragoalLedgerEvent[]): boolean {
	let overrideAfterLatestHardStop = false;
	for (let index = ledger.length - 1; index >= 0; index--) {
		const event = ledger[index];
		if (event.event === CRITIC_GATE_OVERRIDE_EVENT) overrideAfterLatestHardStop = true;
		if (event.event === CRITIC_GATE_HARD_STOP_EVENT) return overrideAfterLatestHardStop;
	}
	return false;
}

export function terminalCriticCeilingReached(
	ledger: readonly UltragoalLedgerEvent[],
	_legacyPlanGeneration?: string,
): boolean {
	return (
		countNonOkayTerminalCriticVerdicts(ledger) >= TERMINAL_CRITIC_CEILING || terminalCriticHardStopReached(ledger)
	);
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

/**
 * Validate a receipt whose plan-generation freshness was legitimately staled
 * by later plan growth as a historical attestation for its own goal:
 * internally consistent, anchored to a ledger checkpoint event that carries a
 * byte-identical receipt, quality gate untampered, and the goal row untouched
 * since verification. Plan-generation freshness against the CURRENT plan is
 * intentionally not required; that is exactly what later plan growth
 * invalidates by design. Returns null when the receipt stands as valid
 * historical evidence.
 */
function validateLedgerAnchoredHistoricalReceipt(input: {
	ledger: readonly UltragoalLedgerEvent[];
	goal: UltragoalGoal;
	receipt: UltragoalCompletionVerification;
	label: string;
}): UltragoalReceiptFreshnessDiagnostic | null {
	if (
		input.receipt.schemaVersion !== 1 ||
		input.receipt.goalId !== input.goal.id ||
		!input.receipt.planGeneration ||
		!input.receipt.checkpointLedgerEventId ||
		hashStructuredValue(input.receipt.basis) !== input.receipt.planGeneration
	) {
		return {
			state: "active_stale_receipt",
			message: `Ultragoal ${input.goal.id} ${input.label} is malformed.`,
			goalId: input.goal.id,
		};
	}
	const event = findLedgerReceiptEvent(input.ledger, input.receipt);
	if (!event)
		return {
			state: "active_stale_receipt",
			message: `Ultragoal ${input.goal.id} ${input.label} ledger event is missing.`,
			goalId: input.goal.id,
		};
	// Bind the goals.json receipt to the FULL receipt recorded on the ledger
	// event. Field-selective matching would accept a coordinated edit of the
	// goals-row basis/generation paired with only the event generation.
	const eventReceipt = event.completionVerification as UltragoalCompletionVerification | undefined;
	if (!eventReceipt || hashStructuredValue(eventReceipt) !== hashStructuredValue(input.receipt))
		return {
			state: "active_stale_receipt",
			message: `Ultragoal ${input.goal.id} ${input.label} does not match its ledger event receipt.`,
			goalId: input.goal.id,
		};
	if (hashStructuredValue(event.qualityGateJson) !== input.receipt.qualityGateHash)
		return {
			state: "active_dirty_quality_gate",
			message: `Ultragoal ${input.goal.id} ${input.label} quality-gate hash does not match ledger.`,
			goalId: input.goal.id,
		};
	if (input.goal.updatedAt !== input.receipt.verifiedAt)
		return {
			state: "active_stale_receipt",
			message: `Ultragoal ${input.goal.id} changed after its ${input.label} was verified.`,
			goalId: input.goal.id,
		};
	return null;
}

/**
 * Validate a final-aggregate receipt that was legitimately superseded — its
 * aggregate claim staled by later plan growth (e.g. `steer add_subgoal`
 * appending goals after a terminal run) — as historical evidence for its own
 * goal. Returns null when the receipt stands.
 */
export function validateSupersededFinalAggregateReceipt(input: {
	ledger: readonly UltragoalLedgerEvent[];
	goal: UltragoalGoal;
	receipt: UltragoalCompletionVerification;
}): UltragoalReceiptFreshnessDiagnostic | null {
	if (input.receipt.receiptKind !== "final-aggregate") {
		return {
			state: "active_stale_receipt",
			message: `Ultragoal ${input.goal.id} superseded final-aggregate receipt is malformed.`,
			goalId: input.goal.id,
		};
	}
	return validateLedgerAnchoredHistoricalReceipt({
		ledger: input.ledger,
		goal: input.goal,
		receipt: input.receipt,
		label: "superseded final-aggregate receipt",
	});
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
	if (!diagnostic) return finalReceipt;
	// A batch close staled only by later plan growth (e.g. `steer add_subgoal`
	// after the batch completed) still proves the batch was validly closed:
	// the member receipts are freshness-checked separately, the close is
	// anchored to its ledger event, and the final goal's row is untouched.
	// Without this, completing a goal appended after a closed batch can never
	// validate, because the old close can never be fresh against the grown
	// plan and identical-evidence replays of fresh receipts are no-ops.
	const historicalDiagnostic = validateLedgerAnchoredHistoricalReceipt({
		ledger: input.ledger,
		goal: finalGoal,
		receipt: finalReceipt,
		label: "superseded batch-close receipt",
	});
	return historicalDiagnostic ? null : finalReceipt;
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
