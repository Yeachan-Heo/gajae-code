import * as fs from "node:fs/promises";
import { DEFAULT_ULTRAGOAL_OBJECTIVE } from "./goal-mode-request";
import {
	computeUltragoalPlanGeneration,
	getUltragoalPaths,
	hashStructuredValue,
	readUltragoalLedger,
	readUltragoalPlan,
	type UltragoalCompletionVerification,
	type UltragoalGoal,
	type UltragoalLedgerEvent,
	type UltragoalPlan,
	type UltragoalReceiptKind,
} from "./ultragoal-runtime";

export type UltragoalGuardState =
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

export interface UltragoalGuardDiagnostic {
	state: UltragoalGuardState;
	message: string;
	goalId?: string;
}

export interface CurrentGoalLike {
	objective: string;
	status?: string;
}

function objectiveMatches(currentObjective: string, plan: UltragoalPlan): boolean {
	const normalized = currentObjective.trim();
	if (!normalized) return false;
	if (normalized === plan.gjcObjective || normalized === DEFAULT_ULTRAGOAL_OBJECTIVE) return true;
	if (plan.gjcObjectiveAliases?.some(alias => alias === normalized)) return true;
	return plan.goals.some(goal => goal.objective === normalized);
}

function isKnownUltragoalObjective(currentObjective: string): boolean {
	const normalized = currentObjective.trim();
	return (
		normalized === DEFAULT_ULTRAGOAL_OBJECTIVE ||
		(normalized.includes(".gjc/ultragoal/goals.json") && normalized.includes(".gjc/ultragoal/ledger.jsonl"))
	);
}

async function hasDurableUltragoalState(cwd: string): Promise<boolean> {
	try {
		await fs.stat(getUltragoalPaths(cwd).dir);
		return true;
	} catch (error) {
		if (
			typeof error === "object" &&
			error !== null &&
			"code" in error &&
			(error as { code?: unknown }).code === "ENOENT"
		) {
			return false;
		}
		throw error;
	}
}

function requiredGoals(plan: UltragoalPlan): UltragoalGoal[] {
	return plan.goals.filter(goal => goal.status !== "superseded");
}

function findReceiptGoal(
	plan: UltragoalPlan,
	currentObjective: string,
): { goal: UltragoalGoal; receiptKind: UltragoalReceiptKind } | null {
	if (
		currentObjective === plan.gjcObjective ||
		currentObjective === DEFAULT_ULTRAGOAL_OBJECTIVE ||
		plan.gjcObjectiveAliases?.some(alias => alias === currentObjective)
	) {
		const finalGoal = [...requiredGoals(plan)]
			.reverse()
			.find(goal => goal.completionVerification?.receiptKind === "final-aggregate");
		return finalGoal ? { goal: finalGoal, receiptKind: "final-aggregate" } : null;
	}
	const storyGoal = plan.goals.find(goal => goal.objective === currentObjective);
	return storyGoal ? { goal: storyGoal, receiptKind: "per-goal" } : null;
}

function findLedgerReceiptEvent(
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

export function validateCompletionReceipt(input: {
	plan: UltragoalPlan;
	ledger: readonly UltragoalLedgerEvent[];
	goal: UltragoalGoal;
	receiptKind: UltragoalReceiptKind;
}): UltragoalGuardDiagnostic {
	const receipt = input.goal.completionVerification;
	if (!receipt) {
		return {
			state: input.receiptKind === "final-aggregate" ? "active_missing_final_receipt" : "active_missing_receipt",
			message: `Ultragoal ${input.goal.id} has no ${input.receiptKind} completion verification receipt.`,
			goalId: input.goal.id,
		};
	}
	if (
		receipt.schemaVersion !== 1 ||
		receipt.goalId !== input.goal.id ||
		receipt.receiptKind !== input.receiptKind ||
		!receipt.planGeneration ||
		!receipt.checkpointLedgerEventId
	) {
		return {
			state: "active_stale_receipt",
			message: `Ultragoal ${input.goal.id} receipt is malformed or stale.`,
			goalId: input.goal.id,
		};
	}
	const event = findLedgerReceiptEvent(input.ledger, receipt);
	if (!event) {
		return {
			state: "active_stale_receipt",
			message: `Ultragoal ${input.goal.id} receipt ledger event is missing.`,
			goalId: input.goal.id,
		};
	}
	const generation = computeUltragoalPlanGeneration({
		plan: input.plan,
		ledger: input.ledger,
		goal: input.goal,
		receiptKind: input.receiptKind,
		beforeStatus: receipt.goalStatusBeforeCheckpoint,
		excludeEventId: receipt.checkpointLedgerEventId,
	});
	if (generation.planGeneration !== receipt.planGeneration) {
		return {
			state: "active_stale_receipt",
			message: `Ultragoal ${input.goal.id} receipt generation is stale.`,
			goalId: input.goal.id,
		};
	}
	if (hashStructuredValue(event.qualityGateJson) !== receipt.qualityGateHash) {
		return {
			state: "active_dirty_quality_gate",
			message: `Ultragoal ${input.goal.id} receipt quality-gate hash does not match ledger.`,
			goalId: input.goal.id,
		};
	}
	if (hashStructuredValue(event.gjcGoalJson) !== receipt.gjcGoalSnapshotHash) {
		return {
			state: "active_stale_receipt",
			message: `Ultragoal ${input.goal.id} receipt get_goal snapshot hash does not match ledger.`,
			goalId: input.goal.id,
		};
	}
	if (input.goal.updatedAt !== receipt.verifiedAt) {
		return {
			state: "active_stale_receipt",
			message: `Ultragoal ${input.goal.id} receipt target changed after verification.`,
			goalId: input.goal.id,
		};
	}
	if (input.receiptKind === "final-aggregate") {
		const incomplete = requiredGoals(input.plan).filter(goal => goal.status !== "complete");
		if (incomplete.length > 0) {
			return {
				state: "active_missing_final_receipt",
				message: `Ultragoal final receipt is not valid while required goals remain incomplete: ${incomplete.map(goal => goal.id).join(", ")}.`,
				goalId: input.goal.id,
			};
		}
		const missingReceipts = requiredGoals(input.plan).filter(
			goal => goal.id !== input.goal.id && !goal.completionVerification,
		);
		if (missingReceipts.length > 0) {
			return {
				state: "active_missing_receipt",
				message: `Ultragoal final receipt is missing per-goal evidence for: ${missingReceipts.map(goal => goal.id).join(", ")}.`,
				goalId: input.goal.id,
			};
		}
	}
	return {
		state: "active_verified_complete",
		message: `Ultragoal ${input.goal.id} has a fresh ${input.receiptKind} receipt.`,
		goalId: input.goal.id,
	};
}

export async function readUltragoalVerificationState(input: {
	cwd: string;
	currentGoal?: CurrentGoalLike | null;
}): Promise<UltragoalGuardDiagnostic> {
	const currentObjective = input.currentGoal?.objective?.trim() ?? "";
	if (!currentObjective) return { state: "inactive", message: "No current goal objective is active." };
	let plan: UltragoalPlan | null;
	let ledger: UltragoalLedgerEvent[];
	try {
		plan = await readUltragoalPlan(input.cwd);
		ledger = await readUltragoalLedger(input.cwd);
	} catch (error) {
		if (currentObjective === DEFAULT_ULTRAGOAL_OBJECTIVE) {
			return {
				state: "unreadable_fail_closed",
				message: `Unable to read Ultragoal verification state: ${error instanceof Error ? error.message : String(error)}`,
			};
		}
		return { state: "unrelated_goal", message: "Current goal is not an active Ultragoal objective." };
	}
	if (!plan) {
		if (isKnownUltragoalObjective(currentObjective) || (await hasDurableUltragoalState(input.cwd))) {
			return {
				state: "unreadable_fail_closed",
				message: "Active Ultragoal objective is missing durable .gjc/ultragoal/goals.json state.",
			};
		}
		return { state: "inactive", message: "No Ultragoal plan exists." };
	}
	if (!objectiveMatches(currentObjective, plan))
		return { state: "unrelated_goal", message: "Current goal is not an active Ultragoal objective." };
	if (plan.goals.some(goal => goal.status === "review_blocked")) {
		return {
			state: "active_review_blocked_recorded",
			message: "Ultragoal has recorded review blockers; complete blocker work and rerun verification.",
		};
	}
	if (plan.goals.some(goal => goal.status === "blocked" || goal.status === "failed")) {
		return {
			state: "active_dirty_quality_gate",
			message: "Ultragoal has blocked or failed goals; record blockers or rerun verification.",
		};
	}
	const receiptTarget = findReceiptGoal(plan, currentObjective);
	if (!receiptTarget) {
		return {
			state: "active_missing_final_receipt",
			message: "Ultragoal aggregate completion requires a fresh final aggregate receipt.",
		};
	}
	return validateCompletionReceipt({ plan, ledger, goal: receiptTarget.goal, receiptKind: receiptTarget.receiptKind });
}

export async function assertCanCompleteCurrentGoal(input: {
	cwd: string;
	currentGoal?: CurrentGoalLike | null;
}): Promise<void> {
	if (!input.cwd) return;
	const diagnostic = await readUltragoalVerificationState(input);
	if (["inactive", "unrelated_goal", "active_verified_complete"].includes(diagnostic.state)) return;
	throw new Error(
		`${diagnostic.message} Run strict \`gjc ultragoal checkpoint --status complete --quality-gate-json <file> --gjc-goal-json <file>\` first, or record review blockers and rerun verification.`,
	);
}

export function isUltragoalBypassPrompt(prompt: string): boolean {
	return /update_goal\s*\(|goal\s+complete|checkpoint[^\n]+--status\s+complete|skip\s+verification|weaken\s+verification|mark\s+.*complete/i.test(
		prompt,
	);
}
