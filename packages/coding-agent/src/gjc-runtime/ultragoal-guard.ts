import * as fs from "node:fs/promises";
import { DEFAULT_ULTRAGOAL_OBJECTIVE } from "./goal-mode-request";
import { resolveGjcSessionForRead, SessionResolutionError } from "./session-resolution";
import {
	computeUltragoalPlanGeneration,
	getUltragoalPaths,
	getUltragoalRunCompletionState,
	hashStructuredValue,
	readUltragoalLedger,
	readUltragoalPlan,
	recordUltragoalNudgeIfBudgetRemaining,
	resolveUltragoalNudgeBudget,
	selectUltragoalNudgeTarget,
	type UltragoalCompletionVerification,
	type UltragoalGoal,
	type UltragoalLedgerEvent,
	type UltragoalNudgeSurface,
	type UltragoalPaths,
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

export interface UltragoalAskBlockDiagnostic {
	active: boolean;
	reason: string;
	source: "absent" | "durable_state" | "durable_state_unreadable" | "ledger" | "goals_json";
	goalsPath?: string;
	ledgerPath?: string;
	goalIds?: string[];
	message: string;
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

async function ultragoalReadPaths(cwd: string): Promise<{ paths: UltragoalPaths; sessionId: string | null }> {
	const envSessionId = process.env.GJC_SESSION_ID?.trim();
	if (envSessionId) return { paths: getUltragoalPaths(cwd, envSessionId), sessionId: envSessionId };
	try {
		const session = await resolveGjcSessionForRead(cwd, { envSessionId: process.env.GJC_SESSION_ID });
		return { paths: getUltragoalPaths(cwd, session.gjcSessionId), sessionId: session.gjcSessionId };
	} catch (error) {
		if (error instanceof SessionResolutionError && error.code === "no_session") {
			// No session could be resolved (no env, no auto-detectable active session).
			// Surface the null session id so callers can decide; ask-guard treats it as inactive.
			return { paths: getUltragoalPaths(cwd, null), sessionId: null };
		}
		throw error;
	}
}

async function hasDurableUltragoalState(cwd: string): Promise<boolean> {
	let paths: UltragoalPaths;
	try {
		({ paths } = await ultragoalReadPaths(cwd));
	} catch (error) {
		if (error instanceof SessionResolutionError) return true;
		throw error;
	}
	try {
		await fs.stat(paths.dir);
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

function isEnoent(error: unknown): boolean {
	return (
		typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT"
	);
}

function activeAskDiagnostic(input: {
	reason: string;
	source: UltragoalAskBlockDiagnostic["source"];
	goalsPath?: string;
	ledgerPath?: string;
	goalIds?: string[];
}): UltragoalAskBlockDiagnostic {
	return {
		active: true,
		reason: input.reason,
		source: input.source,
		goalsPath: input.goalsPath,
		ledgerPath: input.ledgerPath,
		goalIds: input.goalIds,
		message: `${input.reason} Use \`gjc ultragoal record-review-blockers\` instead of asking the user.`,
	};
}

function inactiveAskDiagnostic(input: {
	reason: string;
	source: UltragoalAskBlockDiagnostic["source"];
	goalsPath?: string;
	ledgerPath?: string;
	goalIds?: string[];
}): UltragoalAskBlockDiagnostic {
	return {
		active: false,
		reason: input.reason,
		source: input.source,
		goalsPath: input.goalsPath,
		ledgerPath: input.ledgerPath,
		goalIds: input.goalIds,
		message: input.reason,
	};
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
			message: `Ultragoal ${input.goal.id} receipt goal({"op":"get"}) snapshot hash does not match ledger.`,
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
	sessionId?: string | null;
}): Promise<UltragoalGuardDiagnostic> {
	const currentObjective = input.currentGoal?.objective?.trim() ?? "";
	if (!currentObjective) return { state: "inactive", message: "No current goal objective is active." };
	let plan: UltragoalPlan | null;
	let ledger: UltragoalLedgerEvent[];
	try {
		plan = await readUltragoalPlan(input.cwd, input.sessionId ?? undefined);
		ledger = await readUltragoalLedger(input.cwd, input.sessionId ?? undefined);
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
	const runState = getUltragoalRunCompletionState(plan);
	if (runState.incompleteGoals.some(goal => goal.status === "blocked" || goal.status === "failed")) {
		return {
			state: "active_dirty_quality_gate",
			message: "Ultragoal has blocked or failed goals; record blockers or rerun verification.",
		};
	}
	const receiptTarget = findReceiptGoal(plan, currentObjective);
	if (!receiptTarget) {
		// When earlier required goals are already complete but later ones remain, name the
		// specific blocking goals (a final-aggregate receipt cannot exist yet anyway). Only
		// fall back to the generic missing-receipt message when no progress has been verified.
		const completedRequired = requiredGoals(plan).filter(goal => goal.status === "complete");
		if (completedRequired.length > 0 && runState.incompleteGoals.length > 0) {
			return {
				state: "active_missing_final_receipt",
				message: `Ultragoal still has incomplete required goals: ${runState.incompleteGoals
					.map(goal => goal.id)
					.join(", ")}. Run \`gjc ultragoal complete-goals\` to continue.`,
			};
		}
		return {
			state: "active_missing_final_receipt",
			message: "Ultragoal aggregate completion requires a fresh final aggregate receipt.",
		};
	}
	const receiptDiagnostic = validateCompletionReceipt({
		plan,
		ledger,
		goal: receiptTarget.goal,
		receiptKind: receiptTarget.receiptKind,
	});
	if (receiptDiagnostic.state !== "active_verified_complete") return receiptDiagnostic;
	if (runState.incompleteGoals.length > 0) {
		return {
			state: "active_missing_final_receipt",
			message: `Ultragoal still has incomplete required goals: ${runState.incompleteGoals.map(goal => goal.id).join(", ")}. Run \`gjc ultragoal complete-goals\` to continue.`,
			goalId: receiptTarget.goal.id,
		};
	}
	return receiptDiagnostic;
}

export async function isUltragoalAskBlocked(cwd: string): Promise<UltragoalAskBlockDiagnostic> {
	let paths: UltragoalPaths;
	let sessionId: string | null;
	try {
		({ paths, sessionId } = await ultragoalReadPaths(cwd));
	} catch (error) {
		return activeAskDiagnostic({
			reason: `Unable to resolve durable Ultragoal state: ${error instanceof Error ? error.message : String(error)}`,
			source: "durable_state_unreadable",
		});
	}
	// Ultragoal state is session-scoped. When no session can be resolved (no env,
	// no auto-detectable active session) there is no active run to protect, so the
	// ask guard must fall open rather than block on legacy/global durable state.
	if (sessionId === null) {
		return inactiveAskDiagnostic({
			reason: "No active GJC session resolved; ultragoal is inactive.",
			source: "absent",
			goalsPath: paths.goalsPath,
			ledgerPath: paths.ledgerPath,
		});
	}
	try {
		await fs.stat(paths.dir);
	} catch (error) {
		if (isEnoent(error)) {
			return inactiveAskDiagnostic({
				reason: "No durable .gjc/ultragoal state exists.",
				source: "absent",
				goalsPath: paths.goalsPath,
				ledgerPath: paths.ledgerPath,
			});
		}
		return activeAskDiagnostic({
			reason: `Durable .gjc/ultragoal state is present but unreadable: ${error instanceof Error ? error.message : String(error)}`,
			source: "durable_state_unreadable",
			goalsPath: paths.goalsPath,
			ledgerPath: paths.ledgerPath,
		});
	}

	let plan: UltragoalPlan | null;
	let ledger: UltragoalLedgerEvent[];
	try {
		plan = await readUltragoalPlan(cwd, sessionId);
		ledger = await readUltragoalLedger(cwd, sessionId);
	} catch (error) {
		return activeAskDiagnostic({
			reason: `Unable to read durable Ultragoal state: ${error instanceof Error ? error.message : String(error)}`,
			source: "durable_state_unreadable",
			goalsPath: paths.goalsPath,
			ledgerPath: paths.ledgerPath,
		});
	}
	if (!plan) {
		// goals.json absent or empty while the state dir exists is an inconsistent
		// durable state, not a clean "no run". Fail closed so the pause guard (which
		// relies on this `durable_state_unreadable` signal) keeps blocking give-ups.
		return activeAskDiagnostic({
			reason: "Durable .gjc/ultragoal state exists but goals.json is missing or empty.",
			source: "durable_state_unreadable",
			goalsPath: paths.goalsPath,
			ledgerPath: paths.ledgerPath,
		});
	}

	if (plan.goals.some(goal => goal.status === "review_blocked")) {
		const goalIds = plan.goals.filter(goal => goal.status === "review_blocked").map(goal => goal.id);
		return activeAskDiagnostic({
			reason: `Ultragoal has recorded review blockers: ${goalIds.join(", ")}.`,
			source: "goals_json",
			goalsPath: paths.goalsPath,
			ledgerPath: paths.ledgerPath,
			goalIds,
		});
	}

	const runState = getUltragoalRunCompletionState(plan);
	if (runState.incompleteGoals.length > 0) {
		const goalIds = runState.incompleteGoals.map(goal => goal.id);
		return activeAskDiagnostic({
			reason: `Ultragoal has incomplete required goals: ${goalIds.join(", ")}.`,
			source: "goals_json",
			goalsPath: paths.goalsPath,
			ledgerPath: paths.ledgerPath,
			goalIds,
		});
	}

	const finalReceiptGoal = [...requiredGoals(plan)]
		.reverse()
		.find(goal => goal.completionVerification?.receiptKind === "final-aggregate");
	if (!finalReceiptGoal) {
		return activeAskDiagnostic({
			reason: "Ultragoal aggregate completion is missing a final aggregate receipt.",
			source: "durable_state",
			goalsPath: paths.goalsPath,
			ledgerPath: paths.ledgerPath,
			goalIds: requiredGoals(plan).map(goal => goal.id),
		});
	}

	const diagnostic = validateCompletionReceipt({
		plan,
		ledger,
		goal: finalReceiptGoal,
		receiptKind: "final-aggregate",
	});
	if (diagnostic.state !== "active_verified_complete") {
		return activeAskDiagnostic({
			reason: diagnostic.message,
			source: diagnostic.state === "active_dirty_quality_gate" ? "ledger" : "durable_state",
			goalsPath: paths.goalsPath,
			ledgerPath: paths.ledgerPath,
			goalIds: diagnostic.goalId ? [diagnostic.goalId] : undefined,
		});
	}
	return inactiveAskDiagnostic({
		reason: "Ultragoal run is verified complete.",
		source: "durable_state",
		goalsPath: paths.goalsPath,
		ledgerPath: paths.ledgerPath,
		goalIds: [finalReceiptGoal.id],
	});
}

const NUDGE_SURFACE_LABEL: Record<UltragoalNudgeSurface, string> = {
	pause: "pausing the goal",
	drop: "dropping the run",
	ask: "asking the user",
	premature_complete: "finishing the story early",
};

const NUDGE_SURFACE_REASON: Record<UltragoalNudgeSurface, string> = {
	pause: "an active story still has resolvable work",
	drop: "the aggregate run still has unfinished stories",
	ask: "the decision can be resolved as durable story work",
	premature_complete: "story verification is not yet satisfied",
};

/**
 * Escalating per-attempt refusal text. Deliberately avoids every
 * `isUltragoalBypassPrompt` trigger: no `update_goal(`, no "skip/weaken verification",
 * no "mark ... complete", no "--status complete", and the word "complete" never
 * appears (so the `goal` ... `complete` proximity rule cannot match).
 */
export function formatUltragoalNudgeMessage(input: {
	surface: UltragoalNudgeSurface;
	attempt: number;
	budget: number;
	goalId: string;
}): string {
	const label = NUDGE_SURFACE_LABEL[input.surface];
	const reason = NUDGE_SURFACE_REASON[input.surface];
	return [
		`Ultragoal try-harder nudge (${input.attempt}/${input.budget}) for ${input.goalId}: ${label} was refused before the normal gate.`,
		`Resolving this is part of the goal, not a reason to stop. Try a different approach first: inspect the failure, run a focused test or replay, find local credentials/config if access is the blocker, split the obstacle with \`gjc ultragoal steer --kind add_subgoal\`, delegate an executor, or record concrete review blockers.`,
		`Reason: ${reason}.`,
	].join("\n");
}

/**
 * Consume one nudge for a guarded give-up attempt. MUST only be called from assert/
 * consume paths, never from read-style `is...Blocked` diagnostics. Returns a nudge
 * message while the per-story budget remains; otherwise reports not-nudged so the
 * caller falls through to today's gate.
 */
async function consumeUltragoalNudge(input: {
	cwd: string;
	surface: UltragoalNudgeSurface;
	currentGoal?: CurrentGoalLike | null;
	sessionId?: string | null;
}): Promise<{ nudged: true; message: string } | { nudged: false }> {
	const sessionId = input.sessionId?.trim() || (await ultragoalReadPaths(input.cwd)).sessionId;
	if (!sessionId) return { nudged: false };
	const plan = await readUltragoalPlan(input.cwd, sessionId);
	if (!plan) return { nudged: false };
	const target = selectUltragoalNudgeTarget(plan, { currentGoalObjective: input.currentGoal?.objective });
	if (!target) return { nudged: false };
	const { budget } = await resolveUltragoalNudgeBudget(input.cwd);
	const outcome = await recordUltragoalNudgeIfBudgetRemaining({
		cwd: input.cwd,
		sessionId,
		target,
		surface: input.surface,
		budget,
		reason: NUDGE_SURFACE_REASON[input.surface],
		...(input.currentGoal?.objective ? { currentGoalObjective: input.currentGoal.objective } : {}),
	});
	if (outcome.nudged) {
		return {
			nudged: true,
			message: formatUltragoalNudgeMessage({
				surface: input.surface,
				attempt: outcome.attempt,
				budget: outcome.budget,
				goalId: outcome.goalId,
			}),
		};
	}
	return { nudged: false };
}

/**
 * Assert-path entry for the `ask` surface (the ask guard lives in another module).
 * Resolves the active (leader) Ultragoal session so subagent/headless asks consume
 * the leader run's budget rather than a fresh child ledger.
 */
export async function consumeUltragoalAskNudge(
	cwd: string,
	sessionId?: string | null,
): Promise<{ nudged: true; message: string } | { nudged: false }> {
	if (!cwd) return { nudged: false };
	return consumeUltragoalNudge({ cwd, surface: "ask", sessionId });
}

export async function assertCanCompleteCurrentGoal(input: {
	cwd: string;
	currentGoal?: CurrentGoalLike | null;
	sessionId?: string | null;
}): Promise<void> {
	if (!input.cwd) return;
	const diagnostic = await readUltragoalVerificationState(input);
	if (["inactive", "unrelated_goal", "active_verified_complete"].includes(diagnostic.state)) return;
	const nudge = await consumeUltragoalNudge({
		cwd: input.cwd,
		surface: "premature_complete",
		currentGoal: input.currentGoal,
		sessionId: input.sessionId,
	});
	if (nudge.nudged) throw new Error(nudge.message);
	throw new Error(
		`${diagnostic.message} Run strict \`gjc ultragoal checkpoint --status complete --quality-gate-json <file> --gjc-goal-json <file>\` first, or record review blockers and rerun verification.`,
	);
}

export function isUltragoalBypassPrompt(prompt: string): boolean {
	const normalized = prompt.replace(/\\?"/g, '"');
	return (
		/update_goal\s*\(|goal\s+complete|checkpoint[^\n]+--status\s+complete|skip\s+verification|weaken\s+verification|mark\s+.*complete/i.test(
			normalized,
		) || /goal[\s\S]{0,80}complete/i.test(normalized)
	);
}
export interface UltragoalPauseBlockDiagnostic {
	blocked: boolean;
	reason: string;
}

/**
 * While an Ultragoal run is active, `goal({"op":"pause"})` is only allowed when the
 * current durable Ultragoal state is readable and the latest durable ledger event
 * classifies the current blocker as `human_blocked`. Resolvable blockers must be
 * worked, not parked. Reads fail closed so unreadable durable state or ledger data
 * blocks pause rather than silently allowing a give-up.
 */
export async function isUltragoalPauseBlocked(cwd: string): Promise<UltragoalPauseBlockDiagnostic> {
	if (!cwd) return { blocked: false, reason: "No cwd to resolve durable Ultragoal state." };
	const ask = await isUltragoalAskBlocked(cwd);
	if (ask.source === "durable_state_unreadable") {
		return {
			blocked: true,
			reason: `Unable to verify current durable Ultragoal state for pause: ${ask.reason}`,
		};
	}
	if (!ask.active) return { blocked: false, reason: "No active Ultragoal run." };
	let ledger: UltragoalLedgerEvent[];
	try {
		ledger = await readUltragoalLedger(cwd);
	} catch (error) {
		return {
			blocked: true,
			reason: `Unable to read durable Ultragoal ledger: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
	const latest = ledger.at(-1);
	if (latest?.event === "blocker_classified" && latest.classification === "human_blocked") {
		return { blocked: false, reason: "Latest Ultragoal ledger event classifies the blocker as human_blocked." };
	}
	return {
		blocked: true,
		reason:
			"An Ultragoal run is active. Pausing requires the current blocker to be classified human_blocked as the latest ledger event.",
	};
}

export async function assertUltragoalPauseAllowed(cwd: string): Promise<void> {
	if (cwd) {
		const nudge = await consumeUltragoalNudge({ cwd, surface: "pause" });
		if (nudge.nudged) throw new Error(nudge.message);
	}
	const diagnostic = await isUltragoalPauseBlocked(cwd);
	if (!diagnostic.blocked) return;
	throw new Error(
		[
			diagnostic.reason,
			"Resolvable blockers must be worked, not paused: investigate, `gjc ultragoal steer --kind add_subgoal`, delegate an executor, or `gjc ultragoal record-review-blockers`.",
			'If the blocker is genuinely human-only, record `gjc ultragoal classify-blocker --classification human_blocked --evidence "<human-only dependency>"` immediately before pausing.',
		].join("\n"),
	);
}
/**
 * Guard `goal({"op":"drop"})` during an active Ultragoal run. A *real give-up* (an
 * aggregate run still mid-flight with incomplete required stories) is nudged while
 * budget remains; once exhausted it falls through to today's drop behavior. Legitimate
 * aggregate-reset drops — no durable run, unrelated goal, an already dropped/stale
 * aggregate, or an all-stories-complete run — are never nudged. If durable state
 * exists but cannot be read to classify the drop, fail closed.
 */
export async function assertUltragoalDropAllowed(input: {
	cwd: string;
	currentGoal?: CurrentGoalLike | null;
	sessionId?: string | null;
}): Promise<void> {
	if (!input.cwd) return;
	let paths: UltragoalPaths;
	let sessionId: string | null;
	try {
		({ paths, sessionId } = await ultragoalReadPaths(input.cwd));
	} catch (error) {
		throw new Error(
			`Unable to classify Ultragoal drop (durable state unreadable): ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (sessionId === null) return;
	try {
		await fs.stat(paths.dir);
	} catch (error) {
		if (isEnoent(error)) return;
		throw new Error(
			`Unable to classify Ultragoal drop (durable state present but unreadable): ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	let plan: UltragoalPlan | null;
	try {
		plan = await readUltragoalPlan(input.cwd, sessionId);
	} catch (error) {
		throw new Error(
			`Unable to classify Ultragoal drop (goals.json unreadable): ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (!plan) {
		throw new Error("Unable to classify Ultragoal drop: durable state exists but goals.json is missing or empty.");
	}
	// Out of scope: per-story mode drops keep today's behavior.
	if (plan.gjcGoalMode !== "aggregate") return;
	// A real give-up requires an active aggregate goal to actually be abandoned. With no
	// current goal-mode goal (or a non-active one), `drop` is a no-op/reset before a fresh
	// `create`, never a give-up — so it is left un-nudged.
	if (!input.currentGoal) return;
	if (input.currentGoal.status !== "active") return;
	// Unrelated active goal: not this aggregate run.
	if (!objectiveMatches(input.currentGoal.objective, plan)) return;
	// All required stories complete: a legitimate reset, not a give-up.
	if (getUltragoalRunCompletionState(plan).allComplete) return;
	const nudge = await consumeUltragoalNudge({
		cwd: input.cwd,
		surface: "drop",
		currentGoal: input.currentGoal,
		sessionId,
	});
	if (nudge.nudged) throw new Error(nudge.message);
}
