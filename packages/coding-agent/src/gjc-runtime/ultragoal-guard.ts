import * as fs from "node:fs/promises";
import { DEFAULT_ULTRAGOAL_OBJECTIVE } from "./goal-mode-request";
import { resolveGjcSessionForRead, SessionResolutionError } from "./session-resolution";
import {
	findCleanPauseCriticVerdict,
	findLedgerReceiptEvent,
	terminalCriticCeilingReached,
	terminalCriticGateOverridden,
	validateDeferredMemberReceiptFresh,
	validateReceiptFreshBase,
	validateSupersededFinalAggregateReceipt,
} from "./ultragoal-receipt-freshness";
import {
	getUltragoalPaths,
	getUltragoalRunCompletionState,
	readUltragoalLedger,
	readUltragoalPlan,
	recordUltragoalNudgeIfBudgetRemaining,
	resolveUltragoalNudgeBudget,
	selectUltragoalNudgeTarget,
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
	| "active_missing_critic_verdict"
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
	provenance?: { source: "ultragoal"; runId: string; goalId: string } | { source: "user" };
}

function objectiveMatches(currentGoal: CurrentGoalLike, plan: UltragoalPlan, sessionId?: string | null): boolean {
	const provenance = currentGoal.provenance;
	if (provenance?.source === "ultragoal") {
		return (
			provenance.runId === sessionId &&
			(provenance.goalId === "aggregate" || plan.goals.some(goal => goal.id === provenance.goalId))
		);
	}
	const normalized = currentGoal.objective.trim();
	if (!normalized) return false;
	if (normalized === plan.gjcObjective || normalized === DEFAULT_ULTRAGOAL_OBJECTIVE) return true;
	if (plan.gjcObjectiveAliases?.some(alias => alias === normalized)) return true;
	return plan.goals.some(goal => goal.objective === normalized);
}

export function isKnownUltragoalObjective(currentObjective: string): boolean {
	const normalized = currentObjective.trim();
	// Exact default aggregate objective only. Substring path sniffing previously
	// treated arbitrary objectives that merely mentioned goals.json/ledger paths
	// as Ultragoal-owned, which could mis-arm guards. Prefer fail-closed.
	return normalized === DEFAULT_ULTRAGOAL_OBJECTIVE;
}

async function ultragoalReadPaths(
	cwd: string,
	options: { sessionId?: string | null } = {},
): Promise<{ paths: UltragoalPaths; sessionId: string | null }> {
	const explicitSessionId = options.sessionId?.trim() || process.env.GJC_SESSION_ID?.trim();
	if (explicitSessionId) return { paths: getUltragoalPaths(cwd, explicitSessionId), sessionId: explicitSessionId };
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

/**
 * Select the goal whose final-aggregate receipt should represent the run.
 * Prefer a receipt that still validates fresh; several goals can hold
 * final-aggregate receipts once plan growth (e.g. `steer add_subgoal`) stales
 * an earlier one and a later checkpoint re-mints. Fall back to the newest
 * holder (array-last) purely for diagnostics when none validates.
 */
function findFinalAggregateReceiptGoal(
	plan: UltragoalPlan,
	ledger: readonly UltragoalLedgerEvent[],
): UltragoalGoal | null {
	const candidates = [...requiredGoals(plan)]
		.reverse()
		.filter(goal => goal.completionVerification?.receiptKind === "final-aggregate");
	if (candidates.length === 0) return null;
	return (
		candidates.find(
			goal =>
				validateCompletionReceipt({ plan, ledger, goal, receiptKind: "final-aggregate" }).state ===
				"active_verified_complete",
		) ?? candidates[0]!
	);
}

function findReceiptGoal(
	plan: UltragoalPlan,
	ledger: readonly UltragoalLedgerEvent[],
	currentObjective: string,
): { goal: UltragoalGoal; receiptKind: UltragoalReceiptKind } | null {
	if (
		currentObjective === plan.gjcObjective ||
		currentObjective === DEFAULT_ULTRAGOAL_OBJECTIVE ||
		plan.gjcObjectiveAliases?.some(alias => alias === currentObjective)
	) {
		const finalGoal = findFinalAggregateReceiptGoal(plan, ledger);
		return finalGoal ? { goal: finalGoal, receiptKind: "final-aggregate" } : null;
	}
	const storyGoal = plan.goals.find(goal => goal.objective === currentObjective);
	return storyGoal ? { goal: storyGoal, receiptKind: "per-goal" } : null;
}

/**
 * A review-blocker replacement can stand in for a superseded validation-batch
 * final only while validating the run's final aggregate receipt. Ordinary
 * per-goal validation continues to require the original batch-close receipt.
 */
function hasFreshReviewedBatchFinalReplacement(input: {
	plan: UltragoalPlan;
	ledger: readonly UltragoalLedgerEvent[];
	deferredGoal: UltragoalGoal;
}): boolean {
	const finalGoalId = input.deferredGoal.completionVerification?.validationBatch?.finalGoalId;
	const finalGoal = finalGoalId ? input.plan.goals.find(goal => goal.id === finalGoalId) : undefined;
	if (finalGoal?.status !== "superseded") return false;
	const replacements = input.plan.goals.filter(
		goal =>
			goal.status === "complete" &&
			goal.steering?.kind === "review_blocker" &&
			goal.steering.blockedGoalId === finalGoal.id,
	);
	if (replacements.length !== 1) return false;
	const replacement = replacements[0]!;
	const receipt = replacement.completionVerification;
	if (receipt?.receiptKind !== "per-goal") return false;
	return (
		validateCompletionReceipt({
			plan: input.plan,
			ledger: input.ledger,
			goal: replacement,
			receiptKind: "per-goal",
		}).state === "active_verified_complete"
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
	if (input.receiptKind === "final-aggregate") {
		const checkpointEvent = findLedgerReceiptEvent(input.ledger, receipt);
		if (checkpointEvent) {
			const qualityGate =
				typeof checkpointEvent.qualityGateJson === "object" &&
				checkpointEvent.qualityGateJson !== null &&
				!Array.isArray(checkpointEvent.qualityGateJson)
					? (checkpointEvent.qualityGateJson as Record<string, unknown>)
					: undefined;
			const criticReview =
				qualityGate &&
				typeof qualityGate.criticReview === "object" &&
				qualityGate.criticReview !== null &&
				!Array.isArray(qualityGate.criticReview)
					? (qualityGate.criticReview as Record<string, unknown>)
					: undefined;
			if (criticReview?.verdict !== "OKAY") {
				return {
					state: "active_missing_critic_verdict",
					message: `Ultragoal ${input.goal.id} final aggregate receipt checkpoint requires criticReview with verdict OKAY.`,
					goalId: input.goal.id,
				};
			}
		}
	}
	if (receipt.validationBatch?.role === "deferred-member") {
		return validateDeferredMemberReceiptFresh({
			plan: input.plan,
			ledger: input.ledger,
			goal: input.goal,
			receipt,
			receiptKind: input.receiptKind,
			requireClose: true,
		});
	}
	const baseDiagnostic = validateReceiptFreshBase({
		plan: input.plan,
		ledger: input.ledger,
		goal: input.goal,
		receipt,
		receiptKind: input.receiptKind,
	});
	if (baseDiagnostic) return baseDiagnostic;
	if (input.receiptKind === "final-aggregate") {
		if (terminalCriticCeilingReached(input.ledger) && !terminalCriticGateOverridden(input.ledger)) {
			return {
				state: "active_stale_receipt",
				message: `Ultragoal ${input.goal.id} final aggregate receipt is stale because the terminal-critic ceiling is currently reached.`,
				goalId: input.goal.id,
			};
		}
	}
	if (receipt.validationBatch?.role === "batch-close") {
		for (const memberId of receipt.validationBatch.memberIds) {
			const member = input.plan.goals.find(goal => goal.id === memberId);
			if (
				!member?.validationBatch ||
				member.validationBatch.metadataHash !== receipt.validationBatch.memberMetadataHashes[memberId]
			) {
				return {
					state: "active_stale_receipt",
					message: `Ultragoal ${input.goal.id} batch-close receipt has stale member metadata for ${memberId}.`,
					goalId: input.goal.id,
				};
			}
			if (memberId === receipt.validationBatch.finalGoalId) continue;
			const memberReceipt = member.completionVerification;
			if (memberReceipt?.validationBatch?.role !== "deferred-member") {
				return {
					state: "active_missing_final_receipt",
					message: `Ultragoal ${input.goal.id} batch-close receipt requires deferred member receipt for ${memberId}.`,
					goalId: input.goal.id,
				};
			}
			const memberDiagnostic = validateDeferredMemberReceiptFresh({
				plan: input.plan,
				ledger: input.ledger,
				goal: member,
				receipt: memberReceipt,
				receiptKind: "per-goal",
				requireClose: false,
			});
			if (memberDiagnostic.state !== "active_verified_complete") return memberDiagnostic;
			if (
				receipt.validationBatch.memberReceiptIds[memberId] !== memberReceipt.receiptId ||
				receipt.validationBatch.memberChangeSetHashes[memberId] !== memberReceipt.validationBatch.changeSetHash
			) {
				return {
					state: "active_stale_receipt",
					message: `Ultragoal ${input.goal.id} batch-close receipt is stale for deferred member ${memberId}.`,
					goalId: input.goal.id,
				};
			}
		}
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
		for (const priorGoal of requiredGoals(input.plan)) {
			if (priorGoal.id === input.goal.id) continue;
			if (!priorGoal.completionVerification) {
				return {
					state: "active_missing_receipt",
					message: `Ultragoal final receipt is missing per-goal evidence for: ${priorGoal.id}.`,
					goalId: input.goal.id,
				};
			}
			if (
				priorGoal.completionVerification.validationBatch?.role !== "deferred-member" &&
				priorGoal.completionVerification.receiptKind === "final-aggregate"
			) {
				// A prior goal may hold the run's previous final-aggregate receipt
				// when plan growth staled it and a later checkpoint re-minted the
				// aggregate receipt. Accept it as historical evidence for its own
				// goal instead of demanding an impossible per-goal receipt.
				const supersededDiagnostic = validateSupersededFinalAggregateReceipt({
					ledger: input.ledger,
					goal: priorGoal,
					receipt: priorGoal.completionVerification,
				});
				if (supersededDiagnostic) {
					return {
						state: supersededDiagnostic.state,
						message: `Ultragoal final receipt requires valid historical evidence for ${priorGoal.id}: ${supersededDiagnostic.message}`,
						goalId: input.goal.id,
					};
				}
				continue;
			}
			const priorDiagnostic =
				priorGoal.completionVerification.validationBatch?.role === "deferred-member"
					? validateDeferredMemberReceiptFresh({
							plan: input.plan,
							ledger: input.ledger,
							goal: priorGoal,
							receipt: priorGoal.completionVerification,
							receiptKind: "per-goal",
							requireClose: !hasFreshReviewedBatchFinalReplacement({
								plan: input.plan,
								ledger: input.ledger,
								deferredGoal: priorGoal,
							}),
						})
					: validateCompletionReceipt({
							plan: input.plan,
							ledger: input.ledger,
							goal: priorGoal,
							receiptKind: "per-goal",
						});
			if (priorDiagnostic.state !== "active_verified_complete") {
				return {
					state: priorDiagnostic.state,
					message: `Ultragoal final receipt requires a valid per-goal receipt for ${priorGoal.id}: ${priorDiagnostic.message}`,
					goalId: input.goal.id,
				};
			}
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
	const currentGoal = input.currentGoal;

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
	if (!currentGoal || !objectiveMatches(currentGoal, plan, input.sessionId))
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
	const provenance = currentGoal.provenance;

	const receiptTarget =
		provenance?.source === "ultragoal"
			? provenance.goalId === "aggregate" || plan.gjcGoalMode === "aggregate"
				? (() => {
						const goal = findFinalAggregateReceiptGoal(plan, ledger);
						return goal ? { goal, receiptKind: "final-aggregate" as const } : null;
					})()
				: (() => {
						const goal = plan.goals.find(item => item.id === provenance.goalId);
						return goal ? { goal, receiptKind: "per-goal" as const } : null;
					})()
			: findReceiptGoal(plan, ledger, currentObjective);

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

export async function verifyUltragoalDurableCompletionState(input: {
	cwd: string;
	sessionId?: string | null;
}): Promise<UltragoalGuardDiagnostic> {
	let paths: UltragoalPaths;
	let sessionId: string | null;
	try {
		({ paths, sessionId } = await ultragoalReadPaths(input.cwd, { sessionId: input.sessionId }));
	} catch (error) {
		return {
			state: "unreadable_fail_closed",
			message: `Unable to resolve durable Ultragoal state: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
	if (sessionId === null)
		return { state: "inactive", message: "No active GJC session resolved; ultragoal is inactive." };
	try {
		await fs.stat(paths.dir);
	} catch (error) {
		if (isEnoent(error)) return { state: "inactive", message: "No durable .gjc/ultragoal state exists." };
		return {
			state: "unreadable_fail_closed",
			message: `Durable .gjc/ultragoal state is present but unreadable: ${error instanceof Error ? error.message : String(error)}`,
		};
	}

	let plan: UltragoalPlan | null;
	let ledger: UltragoalLedgerEvent[];
	try {
		plan = await readUltragoalPlan(input.cwd, sessionId);
		ledger = await readUltragoalLedger(input.cwd, sessionId);
	} catch (error) {
		return {
			state: "unreadable_fail_closed",
			message: `Unable to read durable Ultragoal state: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
	if (!plan) return { state: "inactive", message: "No Ultragoal plan exists." };

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

	if (plan.gjcGoalMode === "per-story") {
		const incomplete = requiredGoals(plan).filter(goal => goal.status !== "complete");
		if (incomplete.length > 0) {
			return {
				state: "active_missing_receipt",
				message: `Ultragoal per-story completion requires all required stories to be complete; incomplete: ${incomplete.map(goal => goal.id).join(", ")}.`,
				goalId: incomplete[0]?.id,
			};
		}
		for (const goal of requiredGoals(plan)) {
			const diagnostic = validateCompletionReceipt({
				plan,
				ledger,
				goal,
				receiptKind: "per-goal",
			});
			if (diagnostic.state !== "active_verified_complete") return diagnostic;
		}
		return {
			state: "active_verified_complete",
			message: "Ultragoal per-story run is verified complete.",
		};
	}

	const ask = await isUltragoalAskBlocked(input.cwd, { sessionId });
	if (!ask.active) {
		return {
			state: "active_verified_complete",
			message: ask.reason,
			goalId: ask.goalIds?.at(0),
		};
	}
	if (ask.source === "durable_state_unreadable") {
		return {
			state: "unreadable_fail_closed",
			message: ask.reason,
			goalId: ask.goalIds?.at(0),
		};
	}
	if (ask.reason.includes("recorded review blockers")) {
		return {
			state: "active_review_blocked_recorded",
			message: ask.reason,
			goalId: ask.goalIds?.at(0),
		};
	}
	if (ask.reason.includes("incomplete required goals")) {
		return {
			state: "active_missing_final_receipt",
			message: ask.reason,
			goalId: ask.goalIds?.at(0),
		};
	}
	return {
		state: "active_missing_final_receipt",
		message: ask.reason,
		goalId: ask.goalIds?.at(0),
	};
}

export async function isUltragoalAskBlocked(
	cwd: string,
	options: { sessionId?: string | null } = {},
): Promise<UltragoalAskBlockDiagnostic> {
	let paths: UltragoalPaths;
	let sessionId: string | null;
	try {
		({ paths, sessionId } = await ultragoalReadPaths(cwd, options));
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

	const finalReceiptGoal = findFinalAggregateReceiptGoal(plan, ledger);
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
	const diagnostic = await verifyUltragoalDurableCompletionState(input);
	if (["inactive", "active_verified_complete"].includes(diagnostic.state)) return;
	const nudge = await consumeUltragoalNudge({
		cwd: input.cwd,
		surface: "premature_complete",
		currentGoal: input.currentGoal,
		sessionId: input.sessionId,
	});
	if (nudge.nudged) throw new Error(nudge.message);
	throw new Error(
		`${diagnostic.message} Run \`gjc ultragoal checkpoint --status complete --quality-gate-json <file>\` first, or record review blockers and rerun verification.`,
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
 * current durable Ultragoal state is readable, the latest `blocker_classified`
 * event is `human_blocked`, and a later fresh clean pause terminal critic verdict is bound to
 * that exact classification. Reads fail closed so unreadable durable state or
 * ledger data blocks pause rather than silently allowing a give-up.
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
	if (terminalCriticCeilingReached(ledger) && !terminalCriticGateOverridden(ledger)) {
		return {
			blocked: true,
			reason:
				"The Ultragoal run hit the terminal-critic ceiling; requires human/leader `gjc ultragoal record-critic-gate-override` before further terminal attempts.",
		};
	}

	const classification = [...ledger].reverse().find(event => event.event === "blocker_classified");
	if (classification?.classification !== "human_blocked") {
		return {
			blocked: true,
			reason:
				"An Ultragoal run is active. Pausing requires the latest blocker_classified event to be human_blocked, followed by a bound clean pause terminal critic verdict.",
		};
	}
	if (typeof classification.eventId !== "string" || !classification.eventId.trim()) {
		return {
			blocked: true,
			reason:
				"Pausing requires a later fresh clean pause terminal critic OKAY verdict bound to the latest human_blocked blocker_classified event; a REJECT/ITERATE/stale/missing verdict blocks the pause and the run must keep executing.",
		};
	}
	let plan: UltragoalPlan | null;
	try {
		plan = await readUltragoalPlan(cwd);
	} catch (error) {
		return {
			blocked: true,
			reason: `Unable to read durable Ultragoal plan for pause critic verdict: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
	if (!plan) {
		return { blocked: true, reason: "Unable to read durable Ultragoal plan for pause critic verdict." };
	}
	const criticVerdict = findCleanPauseCriticVerdict(plan, ledger, classification.eventId);
	if (!criticVerdict) {
		return {
			blocked: true,
			reason:
				"Pausing requires a later fresh clean pause terminal critic OKAY verdict bound to the latest human_blocked blocker_classified event; a REJECT/ITERATE/stale/missing verdict blocks the pause and the run must keep executing.",
		};
	}
	return {
		blocked: false,
		reason:
			"Latest blocker_classified event is human_blocked with a later fresh clean bound pause terminal critic verdict.",
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
			'If the blocker is genuinely human-only, record `gjc ultragoal classify-blocker --classification human_blocked --evidence "<human-only dependency>"`, then record a clean bound `gjc ultragoal record-critic-verdict --terminus pause --classification-event-id <eventId> --verdict OKAY --evidence "<critic evidence>"` before pausing.',
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
	if (!objectiveMatches(input.currentGoal, plan, sessionId)) return;
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
