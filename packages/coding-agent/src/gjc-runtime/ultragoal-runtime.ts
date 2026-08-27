import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isPlaceholderToken } from "@gajae-code/utils";
import type { WorkflowHudSummary } from "../skill-state/active-state";
import { buildUltragoalHudSummary as buildWorkflowUltragoalHudSummary } from "../skill-state/workflow-hud";
import { renderCliWriteReceipt } from "./cli-write-receipt";
import { DEFAULT_ULTRAGOAL_OBJECTIVE } from "./goal-mode-request";
import {
	assertCwdMatchesRepositoryBinding,
	captureRepositoryBinding,
	parseRepositoryBinding,
	type RepositoryBinding,
} from "./repository-binding";
import {
	CRITIC_GATE_HARD_STOP_EVENT,
	CRITIC_GATE_OVERRIDE_EVENT,
	CRITIC_VERDICT_EVENT,
	type CriticVerdict,
	computeCriticVerdictPlanGeneration,
	computeUltragoalPlanGeneration,
	countNonOkayTerminalCriticVerdicts,
	finalAggregateReceiptMissingCriticOkay,
	findFreshBatchCloseReceipt,
	findLedgerReceiptEvent,
	isCleanPauseCriticVerdictShape,
	requiredUltragoalGoals,
	TERMINAL_CRITIC_CEILING,
	terminalCriticCeilingReached,
	terminalCriticGateOverridden,
	terminalCriticHardStopReached,
	validateDeferredMemberReceiptFresh,
	validateReceiptFreshBase,
} from "./ultragoal-receipt-freshness";

export {
	CRITIC_GATE_HARD_STOP_EVENT,
	CRITIC_GATE_OVERRIDE_EVENT,
	CRITIC_VERDICT_EVENT,
	type CriticVerdict,
	computeUltragoalPlanGeneration,
	countTerminalCriticVerdicts,
	receiptRelevantGoals,
	TERMINAL_CRITIC_CEILING,
	terminalCriticCeilingReached,
	terminalCriticGateOverridden,
} from "./ultragoal-receipt-freshness";

import { isSettingsInitialized, Settings } from "../config/settings";
import { gjcRoot, sessionUltragoalDir } from "./session-layout";
import {
	resolveGjcSessionForRead,
	resolveGjcSessionForWrite,
	SessionResolutionError,
	writeSessionActivityMarker,
} from "./session-resolution";
import { renderUltragoalStatusMarkdown } from "./state-renderer";
import { reconcileWorkflowSkillState } from "./state-runtime";
import {
	appendJsonl,
	persistedStateRevision,
	withWorkflowStateLock,
	writeArtifact,
	writeGuardedJsonAtomic,
} from "./state-writer";
import {
	categorizeComputerChangePath,
	ciDevChangedPathRows,
	computeCheckpointChangeSet,
	computeUltragoalReviewSourceHash,
	mergeChangeSetPaths,
	normalizeChangeSetPath,
	parseGitNameStatus,
	parseGitUntrackedPaths,
	parseUnifiedDiffPaths,
	resolveGitBase,
	spawnText,
	type UltragoalChangeCategory,
	type UltragoalChangeSet,
	type UltragoalChangeSetPath,
	type UltragoalChangeStatus,
} from "./ultragoal-change-set";
import {
	resolveUltragoalValidationApplicability,
	type UltragoalValidationApplicability,
	type UltragoalValidationLane,
	type UltragoalValidationLaneSelection,
	validationLaneSelectionFor,
} from "./ultragoal-validation-policy";
import { resolveWorkflowSetting } from "./workflow-settings";

export {
	categorizeComputerChangePath,
	ciDevChangedPathRows,
	computeCheckpointChangeSet,
	computeUltragoalReviewSourceHash,
	mergeChangeSetPaths,
	normalizeChangeSetPath,
	normalizeRepoPath,
	parseGitNameStatus,
	parseGitUntrackedPaths,
	parseUnifiedDiffPaths,
	resolveGitBase,
	spawnText,
	type UltragoalChangeCategory,
	type UltragoalChangeSet,
	type UltragoalChangeSetPath,
	type UltragoalChangeStatus,
} from "./ultragoal-change-set";

export {
	captureUltragoalRecoverySnapshot,
	parseStrictTerminalTranscript,
	persistUltragoalRecoveryDecision,
	planUltragoalOwnerLossRecovery,
	type UltragoalOwnerLossReceipt,
	type UltragoalRecoveryBinding,
	type UltragoalRecoveryDecision,
	type UltragoalRecoverySnapshot,
	validateOwnerLossBinding,
	validateRawUltragoalEvidence,
	validateRecoveryAdmission,
	validateRecoveryPath,
} from "./ultragoal-owner-loss-recovery";
export type UltragoalGjcGoalMode = "aggregate" | "per-story";
export type UltragoalGoalStatus =
	| "pending"
	| "active"
	| "complete"
	| "failed"
	| "blocked"
	| "review_blocked"
	| "superseded";

export interface UltragoalValidationBatchMetadata extends JsonObject {
	schemaVersion: 1;
	batchId: string;
	memberIds: string[];
	finalGoalId: string;
	mode: "aggregate-only";
	metadataHash: string;
}

export interface UltragoalValidationBatchInput {
	schemaVersion: 1;
	batchId: string;
	memberIds: string[];
	finalGoalId: string;
}

export interface UltragoalGoal {
	id: string;
	title: string;
	objective: string;
	status: UltragoalGoalStatus;
	createdAt: string;
	updatedAt: string;
	startedAt?: string;
	completedAt?: string;
	evidence?: string;
	steering?: Record<string, unknown>;
	completionVerification?: UltragoalCompletionVerification;
	validationBatch?: UltragoalValidationBatchMetadata;
}

export interface UltragoalPlan {
	version: 1;
	brief: string;
	gjcGoalMode: UltragoalGjcGoalMode;
	gjcObjective: string;
	gjcObjectiveAliases?: string[];
	goals: UltragoalGoal[];
	/** Authoritative repository identity for multi-repo fail-closed spawn (#2901). */
	repositoryBinding?: RepositoryBinding;
	createdAt: string;
	updatedAt: string;
	[key: string]: unknown;
}

export type UltragoalReceiptKind = "per-goal" | "final-aggregate";

export interface UltragoalCompletionVerification {
	schemaVersion: 1;
	receiptId: string;
	verifiedAt: string;
	goalId: string;
	receiptKind: UltragoalReceiptKind;
	goalStatusBeforeCheckpoint: UltragoalGoalStatus;
	gjcGoalMode: UltragoalGjcGoalMode;
	gjcObjective: string;
	qualityGateHash: string;
	planGeneration: string;
	basis: {
		planHashBeforeCheckpoint: string;
		latestRelevantLedgerEventIdBeforeCheckpoint: string | null;
		goalUpdatedAtBeforeCheckpoint: string;
		relevantGoalIdsBeforeCheckpoint: string[];
		requiredGoalSetHashBeforeCheckpoint: string;
	};
	checkpointLedgerEventId: string;
	validationBatch?:
		| {
				schemaVersion: 1;
				role: "deferred-member";
				batchId: string;
				memberIds: string[];
				finalGoalId: string;
				metadataHash: string;
				changeSetHash: string;
		  }
		| {
				schemaVersion: 1;
				role: "batch-close";
				batchId: string;
				memberIds: string[];
				finalGoalId: string;
				memberMetadataHashes: Record<string, string>;
				memberReceiptIds: Record<string, string>;
				memberCheckpointLedgerEventIds: Record<string, string>;
				memberChangeSetHashes: Record<string, string>;
				unionHash: string;
		  };
}

type UltragoalDeferredCompletionVerification = UltragoalCompletionVerification & {
	validationBatch: Extract<
		NonNullable<UltragoalCompletionVerification["validationBatch"]>,
		{ role: "deferred-member" }
	>;
};

export interface UltragoalLedgerEvent extends JsonObject {
	eventId?: string;
	event?: string;
	goalId?: string;
	timestamp?: string;
}

export type UltragoalNudgeSurface = "pause" | "drop" | "ask" | "premature_complete";
export type UltragoalNudgeTargetKind = "story" | "final_aggregate_receipt";

export interface UltragoalNudgeLedgerEvent extends UltragoalLedgerEvent {
	event: "nudge";
	goalId: string;
	targetKind: UltragoalNudgeTargetKind;
	surface: UltragoalNudgeSurface;
	attempt: number;
	budget: number;
	reason: string;
	currentGoalObjective?: string;
}

export interface UltragoalNudgeTarget {
	goalId: string;
	targetKind: UltragoalNudgeTargetKind;
}

export type UltragoalNudgeOutcome =
	| {
			nudged: true;
			attempt: number;
			budget: number;
			goalId: string;
			targetKind: UltragoalNudgeTargetKind;
			event: UltragoalNudgeLedgerEvent;
	  }
	| {
			nudged: false;
			exhausted: true;
			count: number;
			budget: number;
			goalId: string;
			targetKind: UltragoalNudgeTargetKind;
	  }
	| { nudged: false; inactive: true; reason: string };

export interface UltragoalPaths {
	dir: string;
	briefPath: string;
	goalsPath: string;
	ledgerPath: string;
}

export interface UltragoalStatusSummary {
	exists: boolean;
	status: "missing" | "pending" | "active" | "complete" | "blocked" | "failed";
	paths: UltragoalPaths;
	gjcObjective?: string;
	currentGoal?: UltragoalGoal;
	counts: Record<UltragoalGoalStatus, number>;
	goals: UltragoalGoal[];
	nudgeBudget?: number;
	nudgeCount?: number;
	nudgeRemaining?: number;
	nudgeGoalId?: string;
	nudgeTargetKind?: UltragoalNudgeTargetKind;
}

export interface UltragoalCommandResult {
	reviewBlockerGoalIds?: string[];
	createdReviewPlan?: boolean;
	status: number;
	stdout?: string;
	stderr?: string;
	createdPlan?: boolean;
}

export interface JsonObject {
	[key: string]: unknown;
}

export function currentUltragoalSessionId(cwd: string): string {
	return resolveGjcSessionForWrite(cwd, { envSessionId: process.env.GJC_SESSION_ID }).gjcSessionId;
}

const TERMINAL_OR_SKIPPED_STATUSES = new Set<UltragoalGoalStatus>(["complete", "superseded"]);
const CLEAN_ARCHITECT_STATUS = "CLEAR";
const APPROVE_RECOMMENDATION = "APPROVE";
export const PASSED_STATUS = "passed";
const NOT_APPLICABLE_STATUS = "not_applicable";
const COVERED_STATUS = "covered";
const ACCEPTED_PROOF_STATUSES = new Set([COVERED_STATUS, "passed", "verified"]);
const MIN_SUBSTANTIVE_EVIDENCE_WORDS = 5;
const MIN_SUBSTANTIVE_EVIDENCE_CHARS = 32;

const SCHEDULABLE_STATUSES = new Set<UltragoalGoalStatus>(["pending", "active", "failed"]);
const COMPLETE_CHECKPOINT_ALLOWED_PRE_STATUSES = new Set<UltragoalGoalStatus>(["active", "failed"]);

const NATIVE_STEERING_KINDS = [
	"add_subgoal",
	"split_subgoal",
	"reorder_pending",
	"revise_pending_wording",
	"annotate_ledger",
	"mark_blocked_superseded",
] as const;
type UltragoalSteeringKind = (typeof NATIVE_STEERING_KINDS)[number];
const NATIVE_STEERING_KIND_SET = new Set<string>(NATIVE_STEERING_KINDS);

interface ReplacementSpec {
	title: string;
	objective: string;
}

interface SteeringCommandResult {
	kind: UltragoalSteeringKind;
	message: string;
	receipt: JsonObject;
}

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

export function hashStructuredValue(value: unknown): string {
	return crypto
		.createHash("sha256")
		.update(JSON.stringify(stableStructuredValue(value)))
		.digest("hex");
}

export function getUltragoalPaths(cwd: string, sessionId?: string | null): UltragoalPaths {
	const explicitSessionId = sessionId?.trim() || process.env.GJC_SESSION_ID?.trim();
	const dir = explicitSessionId ? sessionUltragoalDir(cwd, explicitSessionId) : path.join(gjcRoot(cwd), "ultragoal");
	return {
		dir,
		briefPath: path.join(dir, "brief.md"),
		goalsPath: path.join(dir, "goals.json"),
		ledgerPath: path.join(dir, "ledger.jsonl"),
	};
}

export function isEnoent(error: unknown): boolean {
	return (
		typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT"
	);
}

export async function appendLedger(
	cwd: string,
	event: JsonObject,
	sessionId?: string | null,
): Promise<UltragoalLedgerEvent> {
	const resolvedSessionId =
		sessionId?.trim() || resolveGjcSessionForWrite(cwd, { envSessionId: process.env.GJC_SESSION_ID }).gjcSessionId;
	const paths = getUltragoalPaths(cwd, resolvedSessionId);
	const entry: UltragoalLedgerEvent = {
		eventId: typeof event.eventId === "string" ? event.eventId : crypto.randomUUID(),
		...event,
		timestamp: new Date().toISOString(),
	};
	await appendJsonl(paths.ledgerPath, entry, {
		cwd,
		audit: { category: "ledger", verb: "append", owner: "gjc-runtime", sessionId: resolvedSessionId },
	});
	await writeSessionActivityMarker(cwd, resolvedSessionId, { writer: "ultragoal-runtime", path: paths.ledgerPath });
	return entry;
}

export async function readUltragoalLedger(cwd: string, sessionId?: string | null): Promise<UltragoalLedgerEvent[]> {
	const resolvedSessionId =
		sessionId?.trim() ||
		(await resolveGjcSessionForRead(cwd, { envSessionId: process.env.GJC_SESSION_ID })).gjcSessionId;
	try {
		const raw = await Bun.file(getUltragoalPaths(cwd, resolvedSessionId).ledgerPath).text();
		return raw
			.split(/\r?\n/)
			.map(line => line.trim())
			.filter(line => line.length > 0)
			.map(line => JSON.parse(line) as UltragoalLedgerEvent);
	} catch (error) {
		if (isEnoent(error)) return [];
		throw error;
	}
}

export const DEFAULT_ULTRAGOAL_NUDGE_BUDGET = 10;

/** Pure: count ledger `nudge` rows for an exact goalId. */
export function countUltragoalNudges(ledger: readonly UltragoalLedgerEvent[], goalId: string): number {
	return ledger.filter(event => event.event === "nudge" && event.goalId === goalId).length;
}
function parseNudgeBudgetValue(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= 0 ? value : null;
}

/**
 * Resolve the per-story nudge budget through the shared five-layer resolver.
 * Ultragoal stays tolerant: an invalid optional settings file continues to the
 * next layer and finally to the built-in default (10).
 */
export async function resolveUltragoalNudgeBudget(
	cwd: string,
	agentDir?: string,
): Promise<{ budget: number; source: string }> {
	const resolution = await resolveWorkflowSetting(cwd, "gjc.ultragoal.nudgeBudget", {
		defaultValue: DEFAULT_ULTRAGOAL_NUDGE_BUDGET,
		parse: value => {
			const parsed = parseNudgeBudgetValue(value);
			return parsed === null
				? { kind: "invalid", reason: "expected gjc.ultragoal.nudgeBudget to be a non-negative integer" }
				: { kind: "valid", value: parsed };
		},
		// The session's effective agent profile: an SDK session created with
		// `createAgentSession({ agentDir })` resolves against that directory
		// instead of the process-global default.
		agentDir: agentDir ?? (isSettingsInitialized() ? Settings.instance.getAgentDir() : undefined),
	});
	return { budget: resolution.value, source: resolution.source };
}

/**
 * Pure canonical selector shared by guards and status so `nudgeGoalId` can never
 * diverge between what a guard consumes and what status displays. Prefers the active
 * current-goal objective, then active > pending > failed (matching `chooseNextGoal`),
 * then the aggregate final-receipt target when all stories are complete but the
 * aggregate run still needs a final receipt. Returns null for verified-complete or
 * absent/unrelated plans.
 */
export function selectUltragoalNudgeTarget(
	plan: UltragoalPlan,
	options: { currentGoalObjective?: string; retryFailed?: boolean } = {},
): UltragoalNudgeTarget | null {
	const objective = options.currentGoalObjective?.trim();
	if (objective) {
		const matched = plan.goals.find(
			goal => goal.objective.trim() === objective && SCHEDULABLE_STATUSES.has(goal.status),
		);
		if (matched) return { goalId: matched.id, targetKind: "story" };
	}
	const next = chooseNextGoal(plan, options.retryFailed === true);
	if (next) return { goalId: next.id, targetKind: "story" };
	const completion = getUltragoalRunCompletionState(plan, { retryFailed: options.retryFailed });
	if (completion.needsFinalAggregateReceipt) {
		const required = requiredUltragoalGoals(plan);
		const finalGoal = required.at(-1);
		if (finalGoal) return { goalId: finalGoal.id, targetKind: "final_aggregate_receipt" };
	}
	return null;
}

/**
 * Atomic consuming writer. Locks the ledger path, rereads + counts nudge rows for the
 * target story, and appends exactly one `nudge` row inside the same critical section
 * only while budget remains. Reuses the lockless `appendLedger` inside the lock (it
 * does not acquire a conflicting lock), so concurrent guarded attempts cannot both
 * observe `count = budget - 1` and overshoot the budget.
 */
export async function recordUltragoalNudgeIfBudgetRemaining(input: {
	cwd: string;
	sessionId?: string | null;
	target: UltragoalNudgeTarget;
	surface: UltragoalNudgeSurface;
	budget: number;
	reason: string;
	currentGoalObjective?: string;
}): Promise<UltragoalNudgeOutcome> {
	const { cwd, sessionId, target, surface, budget, reason } = input;
	if (!Number.isFinite(budget) || budget <= 0) {
		return {
			nudged: false,
			exhausted: true,
			count: 0,
			budget: Math.max(0, budget | 0),
			goalId: target.goalId,
			targetKind: target.targetKind,
		};
	}
	const resolvedSessionId =
		sessionId?.trim() || resolveGjcSessionForWrite(cwd, { envSessionId: process.env.GJC_SESSION_ID }).gjcSessionId;
	const paths = getUltragoalPaths(cwd, resolvedSessionId);
	return withWorkflowStateLock(
		paths.ledgerPath,
		async () => {
			const ledger = await readUltragoalLedger(cwd, resolvedSessionId);
			const count = countUltragoalNudges(ledger, target.goalId);
			if (count >= budget) {
				return {
					nudged: false,
					exhausted: true,
					count,
					budget,
					goalId: target.goalId,
					targetKind: target.targetKind,
				} as const;
			}
			const attempt = count + 1;
			const entry = (await appendLedger(
				cwd,
				{
					event: "nudge",
					goalId: target.goalId,
					targetKind: target.targetKind,
					surface,
					attempt,
					budget,
					reason,
					...(input.currentGoalObjective ? { currentGoalObjective: input.currentGoalObjective } : {}),
				},
				resolvedSessionId,
			)) as UltragoalNudgeLedgerEvent;
			return {
				nudged: true,
				attempt,
				budget,
				goalId: target.goalId,
				targetKind: target.targetKind,
				event: entry,
			} as const;
		},
		{ cwd },
	);
}

export async function writePlan(cwd: string, plan: UltragoalPlan, sessionId?: string | null): Promise<void> {
	const resolvedSessionId =
		sessionId?.trim() || resolveGjcSessionForWrite(cwd, { envSessionId: process.env.GJC_SESSION_ID }).gjcSessionId;
	const paths = getUltragoalPaths(cwd, resolvedSessionId);
	await writeArtifact(paths.briefPath, `${plan.brief.trim()}\n`, {
		cwd,
		audit: { category: "artifact", verb: "write", owner: "gjc-runtime", sessionId: resolvedSessionId },
	});
	await writeGuardedJsonAtomic(paths.goalsPath, plan, {
		cwd,
		policy: "source",
		expectedRevision: typeof plan.state_revision === "number" ? persistedStateRevision(plan) : undefined,
		audit: { category: "state", verb: "write", owner: "gjc-runtime", sessionId: resolvedSessionId },
	});
	await writeSessionActivityMarker(cwd, resolvedSessionId, { writer: "ultragoal-runtime", path: paths.goalsPath });
}

function chooseReceiptKind(
	plan: UltragoalPlan,
	ledger: readonly UltragoalLedgerEvent[],
	goal: UltragoalGoal,
	status: UltragoalGoalStatus,
): UltragoalReceiptKind {
	if (plan.gjcGoalMode === "per-story") return "per-goal";
	if (status !== "complete") return "per-goal";
	// A non-final validation-batch member must always carry a per-goal
	// deferred receipt; only the batch's final goal may close the batch and
	// (in aggregate mode) carry the final-aggregate receipt. Without this, a
	// context-stale re-verification replay of a member could mint an invalid
	// final-aggregate receipt with validationBatch.role "deferred-member".
	if (goal.validationBatch && goal.validationBatch.finalGoalId !== goal.id) return "per-goal";
	const requiredGoals = requiredUltragoalGoals(plan);
	// Only a still-fresh final-aggregate receipt on another goal defers this
	// checkpoint to per-goal. A stale one (e.g. staled by `steer add_subgoal`
	// appending goals after a terminal run) must not suppress re-minting,
	// otherwise the run can never regain a verifiable final-aggregate receipt:
	// the completion guard demands a fresh final-aggregate receipt while this
	// gate would keep answering per-goal forever.
	const existingFreshFinalAggregateGoal = requiredGoals.find(item => {
		if (item.id === goal.id) return false;
		const receipt = item.completionVerification;
		if (receipt?.receiptKind !== "final-aggregate") return false;
		return validateReceiptFreshBase({ plan, ledger, goal: item, receipt, receiptKind: "final-aggregate" }) === null;
	});
	if (existingFreshFinalAggregateGoal) return "per-goal";
	const unfinishedRequiredGoals = requiredGoals.filter(
		item => item.id !== goal.id && !TERMINAL_OR_SKIPPED_STATUSES.has(item.status),
	);
	return unfinishedRequiredGoals.length === 0 ? "final-aggregate" : "per-goal";
}

function buildCompletionReceipt(input: {
	plan: UltragoalPlan;
	ledger: readonly UltragoalLedgerEvent[];
	goal: UltragoalGoal;
	receiptKind: UltragoalReceiptKind;
	beforeStatus: UltragoalGoalStatus;
	qualityGateJson: JsonObject;
	now: string;
	checkpointLedgerEventId: string;
}): UltragoalCompletionVerification {
	const generation = computeUltragoalPlanGeneration({
		plan: input.plan,
		ledger: input.ledger,
		goal: input.goal,
		receiptKind: input.receiptKind,
		beforeStatus: input.beforeStatus,
		targetGoalUpdatedAt: input.now,
		excludeEventId: input.checkpointLedgerEventId,
	});
	let validationBatch: UltragoalCompletionVerification["validationBatch"];
	if (input.goal.validationBatch) {
		if (input.goal.id !== input.goal.validationBatch.finalGoalId) {
			const deferred = qualityGateObject(input.qualityGateJson.deferredToBatch);
			const changeSet = qualityGateObject(deferred?.changeSet);
			validationBatch = {
				schemaVersion: 1,
				role: "deferred-member",
				batchId: input.goal.validationBatch.batchId,
				memberIds: [...input.goal.validationBatch.memberIds],
				finalGoalId: input.goal.validationBatch.finalGoalId,
				metadataHash: input.goal.validationBatch.metadataHash,
				changeSetHash: String(changeSet?.changeSetHash ?? ""),
			};
		} else {
			const close = qualityGateObject(input.qualityGateJson.validationBatchClose);
			const union = qualityGateObject(close?.unionChangeSet);
			const memberReceiptIds: Record<string, string> = {};
			const memberCheckpointLedgerEventIds: Record<string, string> = {};
			const rows = Array.isArray(close?.memberReceipts) ? close.memberReceipts : [];
			for (const row of rows) {
				if (typeof row === "object" && row !== null && !Array.isArray(row)) {
					const record = row as JsonObject;
					const goalId = nonEmptyString(record.goalId);
					if (goalId) {
						memberReceiptIds[goalId] = String(record.receiptId ?? "");
						memberCheckpointLedgerEventIds[goalId] = String(record.checkpointLedgerEventId ?? "");
					}
				}
			}
			validationBatch = {
				schemaVersion: 1,
				role: "batch-close",
				batchId: input.goal.validationBatch.batchId,
				memberIds: [...input.goal.validationBatch.memberIds],
				finalGoalId: input.goal.validationBatch.finalGoalId,
				memberMetadataHashes: {
					...(qualityGateObject(close?.memberMetadataHashes) as Record<string, string> | undefined),
				},
				memberReceiptIds,
				memberCheckpointLedgerEventIds,
				memberChangeSetHashes: {
					...(qualityGateObject(union?.memberChangeSetHashes) as Record<string, string> | undefined),
				},
				unionHash: String(union?.unionHash ?? ""),
			};
		}
	}
	return {
		schemaVersion: 1,
		receiptId: crypto.randomUUID(),
		verifiedAt: input.now,
		goalId: input.goal.id,
		receiptKind: input.receiptKind,
		goalStatusBeforeCheckpoint: input.beforeStatus,
		gjcGoalMode: input.plan.gjcGoalMode,
		gjcObjective: input.plan.gjcObjective,
		qualityGateHash: hashStructuredValue(input.qualityGateJson),
		planGeneration: generation.planGeneration,
		basis: generation.basis,
		checkpointLedgerEventId: input.checkpointLedgerEventId,
		validationBatch,
	};
}

export function nonEmptyString(value: unknown): string | null {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function exactNonEmptyString(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}
export function stringArray(value: unknown): string[] | null {
	return Array.isArray(value) && value.every(item => typeof item === "string") ? value.map(item => item.trim()) : null;
}

function validationBatchHashBasis(metadata: Omit<UltragoalValidationBatchMetadata, "metadataHash">): JsonObject {
	return {
		schemaVersion: metadata.schemaVersion,
		batchId: metadata.batchId,
		memberIds: metadata.memberIds,
		finalGoalId: metadata.finalGoalId,
		mode: metadata.mode,
	};
}

function hashValidationBatch(metadata: Omit<UltragoalValidationBatchMetadata, "metadataHash">): string {
	return hashStructuredValue(validationBatchHashBasis(metadata));
}

function withValidationBatchHash(
	metadata: Omit<UltragoalValidationBatchMetadata, "metadataHash">,
): UltragoalValidationBatchMetadata {
	return { ...metadata, metadataHash: hashValidationBatch(metadata) } as UltragoalValidationBatchMetadata;
}

function parseValidationBatchInput(
	value: unknown,
	goalIds: ReadonlySet<string>,
	gjcGoalMode: UltragoalGjcGoalMode,
): UltragoalValidationBatchMetadata[] {
	if (!Array.isArray(value)) throw new Error("validation batch JSON must be an array");
	if (value.length === 0) return [];
	if (gjcGoalMode !== "aggregate") throw new Error("validation batches require aggregate ultragoal mode");
	const goalOrder = new Map([...goalIds].map((id, index) => [id, index]));
	const assigned = new Set<string>();
	const batches: UltragoalValidationBatchMetadata[] = [];
	for (const row of value) {
		if (typeof row !== "object" || row === null || Array.isArray(row))
			throw new Error("validation batch rows must be objects");
		const record = row as JsonObject;
		if (record.schemaVersion !== 1) throw new Error("validation batch schemaVersion must be 1");
		const batchId = nonEmptyString(record.batchId);
		if (!batchId) throw new Error("validation batch batchId is required");
		const finalGoalId = nonEmptyString(record.finalGoalId);
		if (!finalGoalId || !goalIds.has(finalGoalId))
			throw new Error(`validation batch ${batchId} references unknown finalGoalId ${finalGoalId ?? ""}`);
		const memberIds = stringArray(record.memberIds);
		if (!memberIds || memberIds.length === 0)
			throw new Error(`validation batch ${batchId} memberIds must be non-empty`);
		if (memberIds.some(id => id.length === 0))
			throw new Error(`validation batch ${batchId} memberIds must contain only non-empty strings`);
		if (new Set(memberIds).size !== memberIds.length)
			throw new Error(`validation batch ${batchId} contains duplicate memberIds`);
		for (const memberId of memberIds) {
			if (!goalIds.has(memberId))
				throw new Error(`validation batch ${batchId} references unknown member ${memberId}`);
			if (assigned.has(memberId)) throw new Error(`Goal ${memberId} belongs to more than one validation batch`);
		}
		if (!memberIds.includes(finalGoalId))
			throw new Error(`validation batch ${batchId} memberIds must contain finalGoalId ${finalGoalId}`);
		for (const memberId of memberIds) assigned.add(memberId);
		const canonicalMemberIds = [...memberIds].sort(
			(left, right) => (goalOrder.get(left) ?? 0) - (goalOrder.get(right) ?? 0),
		);
		batches.push(
			withValidationBatchHash({
				schemaVersion: 1,
				batchId,
				memberIds: canonicalMemberIds,
				finalGoalId,
				mode: "aggregate-only",
			}),
		);
	}
	return batches;
}

function normalizeSavedValidationBatch(record: unknown, id: string): UltragoalValidationBatchMetadata | undefined {
	if (typeof record !== "object" || record === null || Array.isArray(record)) return undefined;
	const value = record as JsonObject;
	if (value.schemaVersion !== 1) throw new Error(`Goal ${id} validation batch schemaVersion must be 1`);
	const batchId = nonEmptyString(value.batchId);
	if (!batchId) throw new Error(`Goal ${id} validation batch batchId is required`);
	const memberIds = stringArray(value.memberIds);
	if (!memberIds || memberIds.length === 0) throw new Error(`Goal ${id} validation batch memberIds must be non-empty`);
	if (new Set(memberIds).size !== memberIds.length || memberIds.some(memberId => memberId.length === 0)) {
		throw new Error(`Goal ${id} validation batch memberIds must be unique non-empty strings`);
	}
	if (!memberIds.includes(id)) throw new Error(`Goal ${id} validation batch must include its goal id`);
	const finalGoalId = nonEmptyString(value.finalGoalId);
	if (!finalGoalId || !memberIds.includes(finalGoalId))
		throw new Error(`Goal ${id} validation batch finalGoalId must be a member`);
	if (value.mode !== "aggregate-only") throw new Error(`Goal ${id} validation batch mode must be aggregate-only`);
	const basis: Omit<UltragoalValidationBatchMetadata, "metadataHash"> = {
		schemaVersion: 1,
		batchId,
		memberIds,
		finalGoalId,
		mode: "aggregate-only",
	};
	const metadataHash = nonEmptyString(value.metadataHash);
	if (!metadataHash) throw new Error(`Goal ${id} validation batch metadataHash is required`);
	const normalized = { ...basis, metadataHash } as UltragoalValidationBatchMetadata;
	if (metadataHash !== hashValidationBatch(basis))
		throw new Error(`Goal ${id} has stale validation batch metadata hash`);
	return normalized;
}

function requireFreshValidationBatchMetadata(goal: UltragoalGoal): UltragoalValidationBatchMetadata | undefined {
	const metadata = goal.validationBatch;
	if (!metadata) return undefined;
	const { metadataHash, ...basis } = metadata;
	if (metadataHash !== hashValidationBatch(basis))
		throw new Error(`Goal ${goal.id} has stale validation batch metadata hash`);
	return metadata;
}

function findFreshValidationBatchClose(
	plan: UltragoalPlan,
	metadata: UltragoalValidationBatchMetadata,
	member: UltragoalGoal,
	ledger: readonly UltragoalLedgerEvent[],
): UltragoalGoal | undefined {
	const receipt = member.completionVerification;
	if (!receipt) return undefined;
	const finalReceipt = findFreshBatchCloseReceipt({ plan, ledger, deferredGoal: member, deferredReceipt: receipt });
	if (!finalReceipt) return undefined;
	const finalGoal = plan.goals.find(goal => goal.id === metadata.finalGoalId);
	const close = finalReceipt.validationBatch;
	if (!finalGoal || close?.role !== "batch-close") return undefined;
	if (close.batchId !== metadata.batchId || close.finalGoalId !== metadata.finalGoalId) return undefined;
	if (
		close.memberIds.length !== metadata.memberIds.length ||
		close.memberIds.some((id, index) => id !== metadata.memberIds[index])
	)
		return undefined;
	if (close.memberMetadataHashes[member.id] !== metadata.metadataHash) return undefined;
	return finalGoal;
}

function requireDeferredMemberReceiptFresh(
	plan: UltragoalPlan,
	ledger: readonly UltragoalLedgerEvent[],
	member: UltragoalGoal,
	fieldName: string,
): UltragoalDeferredCompletionVerification {
	const receipt = member.completionVerification;
	if (!receipt) throw new Error(`${fieldName} requires fresh deferred receipt for ${member.id}`);
	if (receipt.validationBatch?.role !== "deferred-member")
		throw new Error(`${fieldName} requires fresh deferred receipt for ${member.id}`);
	const diagnostic = validateDeferredMemberReceiptFresh({
		plan,
		ledger,
		goal: member,
		receipt,
		receiptKind: "per-goal",
		requireClose: false,
	});
	if (diagnostic.state !== "active_verified_complete")
		throw new Error(`${fieldName}.${member.id} ${diagnostic.message}`);
	return receipt as UltragoalDeferredCompletionVerification;
}

function requireFreshBatchCloseReceiptBasis(
	plan: UltragoalPlan,
	ledger: readonly UltragoalLedgerEvent[],
	goal: UltragoalGoal,
	receipt: UltragoalCompletionVerification,
	event: UltragoalLedgerEvent,
): void {
	const batch = receipt.validationBatch;
	if (batch?.role !== "batch-close") return;
	const base = validateReceiptFreshBase({ plan, ledger, goal, receipt, receiptKind: receipt.receiptKind });
	if (base) throw new Error(base.message);
	for (const memberId of batch.memberIds) {
		const member = plan.goals.find(item => item.id === memberId);
		if (
			!member?.validationBatch ||
			member.validationBatch.batchId !== batch.batchId ||
			member.validationBatch.metadataHash !== batch.memberMetadataHashes[memberId]
		) {
			throw new Error(`Goal ${goal.id} has stale validation batch close receipt for ${batch.batchId}`);
		}
		if (memberId === batch.finalGoalId) continue;
		const memberReceipt = requireDeferredMemberReceiptFresh(
			plan,
			ledger,
			member,
			`Goal ${goal.id} batch-close receipt`,
		);
		if (
			batch.memberReceiptIds[memberId] !== memberReceipt.receiptId ||
			batch.memberCheckpointLedgerEventIds[memberId] !== memberReceipt.checkpointLedgerEventId ||
			batch.memberChangeSetHashes[memberId] !== memberReceipt.validationBatch!.changeSetHash
		) {
			throw new Error(`Goal ${goal.id} batch-close receipt is stale for deferred member ${memberId}`);
		}
	}
	const close = qualityGateObject(qualityGateObject(event.qualityGateJson)?.validationBatchClose);
	const unionHash = String(qualityGateObject(close?.unionChangeSet)?.unionHash ?? "");
	if (batch.unionHash !== unionHash)
		throw new Error(`Goal ${goal.id} validation batch close receipt union hash is stale`);
}

function clearValidationBatchForBatch(
	plan: UltragoalPlan,
	metadata: UltragoalValidationBatchMetadata | undefined,
): void {
	if (!metadata) return;
	for (const member of plan.goals) {
		if (member.validationBatch?.batchId === metadata.batchId) delete member.validationBatch;
	}
}

function freshDeferredValidationBatchBlocker(
	plan: UltragoalPlan,
	metadata: UltragoalValidationBatchMetadata,
	ledger: readonly UltragoalLedgerEvent[],
): UltragoalGoal | undefined {
	for (const memberId of metadata.memberIds) {
		const member = plan.goals.find(goal => goal.id === memberId);
		if (!member?.validationBatch || member.status !== "complete") continue;
		try {
			requireDeferredMemberReceiptFresh(plan, ledger, member, "validation batch steering");
		} catch {
			continue;
		}
		if (!findFreshValidationBatchClose(plan, member.validationBatch, member, ledger)) return member;
	}
	return undefined;
}

function requireValidationBatchSteeringAllowed(
	plan: UltragoalPlan,
	goal: UltragoalGoal,
	kind: UltragoalSteeringKind,
	ledger: readonly UltragoalLedgerEvent[],
): void {
	const metadata = goal.validationBatch;
	if (!metadata) return;
	const blocker = freshDeferredValidationBatchBlocker(plan, metadata, ledger);
	if (blocker)
		throw new Error(
			`steer ${kind} cannot invalidate validation batch ${metadata.batchId} while member ${blocker.id} has a fresh deferred receipt`,
		);
}
function normalizeGoalStatus(value: unknown): UltragoalGoalStatus {
	switch (value) {
		case "pending":
		case "active":
		case "complete":
		case "failed":
		case "blocked":
		case "review_blocked":
		case "superseded":
			return value;
		default:
			return "pending";
	}
}

function parseGoalStatus(value: unknown): UltragoalGoalStatus {
	const status = normalizeGoalStatus(value);
	if (status === "pending" && value !== "pending") {
		throw new Error(
			"checkpoint --status must be pending, active, complete, failed, blocked, review_blocked, or superseded",
		);
	}
	return status;
}

function normalizePlan(raw: unknown): UltragoalPlan {
	if (typeof raw !== "object" || raw === null) throw new Error("Invalid ultragoal plan: expected object");
	const record = raw as JsonObject;
	const brief = nonEmptyString(record.brief) ?? "";
	const createdAt = nonEmptyString(record.createdAt) ?? new Date().toISOString();
	const updatedAt = nonEmptyString(record.updatedAt) ?? createdAt;
	const gjcGoalMode = record.gjcGoalMode === "per-story" ? "per-story" : "aggregate";
	const gjcObjective = nonEmptyString(record.gjcObjective) ?? DEFAULT_ULTRAGOAL_OBJECTIVE;
	const rawGoals = Array.isArray(record.goals) ? record.goals : [];
	const goals: UltragoalGoal[] = rawGoals.map((item, index) => {
		const goalRecord = typeof item === "object" && item !== null ? (item as JsonObject) : {};
		const id = nonEmptyString(goalRecord.id) ?? `G${String(index + 1).padStart(3, "0")}`;
		const title = nonEmptyString(goalRecord.title) ?? id;
		const objective = nonEmptyString(goalRecord.objective) ?? title;
		const goalCreatedAt = nonEmptyString(goalRecord.createdAt) ?? createdAt;
		const validationBatch = normalizeSavedValidationBatch(goalRecord.validationBatch, id);
		return {
			...goalRecord,
			id,
			title,
			objective,
			status: normalizeGoalStatus(goalRecord.status),
			createdAt: goalCreatedAt,
			updatedAt: nonEmptyString(goalRecord.updatedAt) ?? goalCreatedAt,
			startedAt: nonEmptyString(goalRecord.startedAt) ?? undefined,
			completedAt: nonEmptyString(goalRecord.completedAt) ?? undefined,
			evidence: nonEmptyString(goalRecord.evidence) ?? undefined,
			steering:
				typeof goalRecord.steering === "object" && goalRecord.steering !== null
					? (goalRecord.steering as Record<string, unknown>)
					: undefined,
			completionVerification:
				typeof goalRecord.completionVerification === "object" && goalRecord.completionVerification !== null
					? (goalRecord.completionVerification as UltragoalCompletionVerification)
					: undefined,
			validationBatch,
		};
	});
	const aliases = Array.isArray(record.gjcObjectiveAliases)
		? record.gjcObjectiveAliases.filter(
				(value): value is string => typeof value === "string" && value.trim().length > 0,
			)
		: undefined;
	let repositoryBinding: RepositoryBinding | undefined;
	if (record.repositoryBinding !== undefined) {
		repositoryBinding = parseRepositoryBinding(record.repositoryBinding);
	}
	return {
		version: 1,
		brief,
		gjcGoalMode,
		gjcObjective,
		gjcObjectiveAliases: aliases,
		goals,
		createdAt,
		updatedAt,
		...(repositoryBinding ? { repositoryBinding } : {}),
		...(typeof record.state_revision === "number" && Number.isFinite(record.state_revision)
			? { state_revision: record.state_revision }
			: {}),
	};
}

export async function readUltragoalPlan(cwd: string, sessionId?: string | null): Promise<UltragoalPlan | null> {
	const resolvedSessionId =
		sessionId?.trim() ||
		(await resolveGjcSessionForRead(cwd, { envSessionId: process.env.GJC_SESSION_ID })).gjcSessionId;
	try {
		return normalizePlan(await Bun.file(getUltragoalPaths(cwd, resolvedSessionId).goalsPath).json());
	} catch (error) {
		if (isEnoent(error)) return null;
		throw error;
	}
}

function emptyCounts(): Record<UltragoalGoalStatus, number> {
	return {
		pending: 0,
		active: 0,
		complete: 0,
		failed: 0,
		blocked: 0,
		review_blocked: 0,
		superseded: 0,
	};
}

export async function getUltragoalStatus(
	cwd: string,
	sessionId?: string | null,
	agentDir?: string,
): Promise<UltragoalStatusSummary> {
	const resolvedSessionId =
		sessionId?.trim() ||
		(await resolveGjcSessionForRead(cwd, { envSessionId: process.env.GJC_SESSION_ID })).gjcSessionId;
	const paths = getUltragoalPaths(cwd, resolvedSessionId);
	const plan = await readUltragoalPlan(cwd, resolvedSessionId);
	const counts = emptyCounts();
	if (!plan) return { exists: false, status: "missing", paths, counts, goals: [] };
	for (const goal of plan.goals) counts[goal.status] += 1;
	const currentGoal = plan.goals.find(goal => SCHEDULABLE_STATUSES.has(goal.status));
	let status: UltragoalStatusSummary["status"] = "pending";
	if (plan.goals.length > 0 && plan.goals.every(goal => TERMINAL_OR_SKIPPED_STATUSES.has(goal.status)))
		status = "complete";
	else if (counts.active > 0) status = "active";
	else if (counts.failed > 0) status = "failed";
	else if (counts.blocked > 0 || counts.review_blocked > 0) status = "blocked";
	const nudgeTarget = selectUltragoalNudgeTarget(plan, { currentGoalObjective: currentGoal?.objective });
	let nudgeFields: Partial<UltragoalStatusSummary> = {};
	if (nudgeTarget) {
		const { budget } = await resolveUltragoalNudgeBudget(cwd, agentDir);
		const ledger = await readUltragoalLedger(cwd, resolvedSessionId);
		const nudgeCount = countUltragoalNudges(ledger, nudgeTarget.goalId);
		nudgeFields = {
			nudgeBudget: budget,
			nudgeCount,
			nudgeRemaining: Math.max(0, budget - nudgeCount),
			nudgeGoalId: nudgeTarget.goalId,
			nudgeTargetKind: nudgeTarget.targetKind,
		};
	}
	return {
		exists: true,
		status,
		paths,
		gjcObjective: plan.gjcObjective,
		currentGoal,
		counts,
		goals: plan.goals,
		...nudgeFields,
	};
}
export function buildUltragoalHudSummary(
	summary: UltragoalStatusSummary,
	latestLedger?: UltragoalLedgerEvent,
): WorkflowHudSummary {
	return buildWorkflowUltragoalHudSummary({
		status: summary.status,
		currentGoal: summary.currentGoal,
		counts: summary.counts,
		goals: summary.goals,
		latestLedgerEvent: latestLedger,
		updatedAt: new Date().toISOString(),
	});
}
function clampTitle(title: string): string {
	return title.length > 80 ? `${title.slice(0, 77)}...` : title;
}

function firstNonEmptyLine(text: string): string | undefined {
	return text
		.split(/\r?\n/)
		.map(line => line.trim())
		.find(line => line.length > 0);
}

function titleFromBrief(brief: string): string {
	const firstLine = firstNonEmptyLine(brief);
	if (!firstLine) return "Complete ultragoal brief";
	return clampTitle(firstLine);
}

// A reserved, column-0 (unindented) `@goal` line opens a story. The character
// right after `@goal` must be `:`, an ASCII space or tab, or end-of-line, so
// `@goalish`, `@goals:`, `@goal-foo`, `@goal.foo`, `@goal/foo`, a non-breaking
// space, and indented or mid-line `@goal:` are all ordinary objective text and
// never delimiters.
const GOAL_DELIMITER = /^@goal(?::|[ \t]+|$)[ \t]*(.*)$/;

interface ParsedGoal {
	title: string;
	objective: string;
}

function parseGoalsFromBrief(brief: string): ParsedGoal[] {
	const sections: { title: string; body: string[] }[] = [];
	let current: { title: string; body: string[] } | undefined;
	for (const line of brief.split(/\r?\n/)) {
		const match = GOAL_DELIMITER.exec(line);
		if (match) {
			current = { title: match[1].trim(), body: [] };
			sections.push(current);
			continue;
		}
		current?.body.push(line);
	}
	if (sections.length === 0) {
		return [{ title: titleFromBrief(brief), objective: brief.trim() }];
	}
	return sections.map((section, index) => {
		const body = section.body.join("\n").trim();
		const title = section.title || firstNonEmptyLine(body) || "";
		if (!title && !body) {
			throw new Error(`ultragoal @goal block ${index + 1} has no title or objective`);
		}
		return { title: clampTitle(title), objective: body || title };
	});
}

export async function createUltragoalPlan(input: {
	cwd: string;
	brief: string;
	gjcGoalMode?: UltragoalGjcGoalMode;
	sessionId?: string | null;
	validationBatches?: UltragoalValidationBatchInput[];
	validationBatchJson?: string;
}): Promise<UltragoalPlan> {
	const brief = input.brief.trim();
	if (!brief) throw new Error("ultragoal brief is required");
	const now = new Date().toISOString();
	// Parse the untrimmed brief so the raw-line delimiter contract holds: a
	// leading-indented `@goal` on the first line must stay objective text rather
	// than being promoted to column 0 by trimming.
	const goals: UltragoalGoal[] = parseGoalsFromBrief(input.brief).map((goal, index) => ({
		id: `G${String(index + 1).padStart(3, "0")}`,
		title: goal.title,
		objective: goal.objective,
		status: "pending",
		createdAt: now,
		updatedAt: now,
	}));
	const goalIds = new Set(goals.map(goal => goal.id));
	const validationBatchInput = input.validationBatchJson
		? await readStructuredValue(input.cwd, input.validationBatchJson)
		: input.validationBatches;
	const validationBatches =
		validationBatchInput === undefined
			? []
			: parseValidationBatchInput(validationBatchInput, goalIds, input.gjcGoalMode ?? "aggregate");
	const validationBatchByGoalId = new Map<string, UltragoalValidationBatchMetadata>();
	for (const batch of validationBatches)
		for (const memberId of batch.memberIds) validationBatchByGoalId.set(memberId, batch);
	for (const goal of goals) {
		goal.validationBatch = validationBatchByGoalId.get(goal.id);
	}
	const repositoryBinding = await captureRepositoryBinding(input.cwd, {
		displayPath: input.cwd,
	});
	const plan: UltragoalPlan = {
		version: 1,
		brief,
		gjcGoalMode: input.gjcGoalMode ?? "aggregate",
		gjcObjective: DEFAULT_ULTRAGOAL_OBJECTIVE,
		goals,
		repositoryBinding,
		createdAt: now,
		updatedAt: now,
	};
	await writePlan(input.cwd, plan, input.sessionId);
	await appendLedger(input.cwd, { event: "plan_created", goalIds: plan.goals.map(goal => goal.id) }, input.sessionId);
	return plan;
}

function chooseNextGoal(plan: UltragoalPlan, retryFailed: boolean): UltragoalGoal | undefined {
	return (
		plan.goals.find(goal => goal.status === "active") ??
		plan.goals.find(goal => goal.status === "pending") ??
		(retryFailed ? plan.goals.find(goal => goal.status === "failed") : undefined)
	);
}
export interface UltragoalRunCompletionState {
	requiredGoals: UltragoalGoal[];
	incompleteGoals: UltragoalGoal[];
	nextGoal?: UltragoalGoal;
	allComplete: boolean;
	hasBlockers: boolean;
	needsFinalAggregateReceipt: boolean;
}
export function getUltragoalRunCompletionState(
	plan: UltragoalPlan,
	options: { retryFailed?: boolean } = {},
): UltragoalRunCompletionState {
	const requiredGoals = requiredUltragoalGoals(plan);
	const incompleteGoals = requiredGoals.filter(goal => !TERMINAL_OR_SKIPPED_STATUSES.has(goal.status));
	const nextGoal = chooseNextGoal(plan, options.retryFailed === true);
	return {
		requiredGoals,
		incompleteGoals,
		nextGoal,
		allComplete: requiredGoals.length > 0 && incompleteGoals.length === 0,
		hasBlockers: incompleteGoals.some(goal => goal.status === "blocked" || goal.status === "review_blocked"),
		needsFinalAggregateReceipt: plan.gjcGoalMode === "aggregate" && incompleteGoals.length === 0,
	};
}

/**
 * Discriminated next-action for `complete-goals` handoff (#2903).
 * `none` is reserved for genuine completion; `execute-goal` always carries a goal.
 */
export type UltragoalCompleteNextActionKind =
	| "none"
	| "execute-goal"
	| "retry-failed"
	| "resolve-blockers"
	| "final-aggregate-receipt";

export type UltragoalCompleteNextAction = {
	kind: UltragoalCompleteNextActionKind;
	goal?: UltragoalGoal;
	blockedGoals?: UltragoalGoal[];
	failedGoals?: UltragoalGoal[];
};

/**
 * Resolve the actionable next step after scheduling / complete-goals.
 * Blocked and review_blocked goals remain unschedulable; they surface as
 * `resolve-blockers` instead of a contradictory `execute-goal` without goal_id.
 */
export function resolveUltragoalCompleteNextAction(
	plan: UltragoalPlan,
	options: { retryFailed?: boolean; selectedGoal?: UltragoalGoal } = {},
): UltragoalCompleteNextAction {
	const state = getUltragoalRunCompletionState(plan, { retryFailed: options.retryFailed });
	// Genuine completion keeps next_action=`none` (historical complete-goals contract).
	// final-aggregate-receipt is reserved for a future dedicated handoff; do not remap
	// allComplete here so aggregate runs still finish with `none` / complete text.
	if (state.allComplete) return { kind: "none" };
	const goal = options.selectedGoal ?? state.nextGoal;
	if (goal) return { kind: "execute-goal", goal };
	const blockedGoals = state.incompleteGoals.filter(
		item => item.status === "blocked" || item.status === "review_blocked",
	);
	if (blockedGoals.length > 0) return { kind: "resolve-blockers", blockedGoals };
	const failedGoals = state.incompleteGoals.filter(item => item.status === "failed");
	if (failedGoals.length > 0) return { kind: "retry-failed", failedGoals };
	// Incomplete but not schedulable (unexpected statuses): still actionable, not "none".
	return { kind: "resolve-blockers", blockedGoals: state.incompleteGoals };
}

export async function startNextUltragoalGoal(input: {
	cwd: string;
	retryFailed?: boolean;
	sessionId?: string | null;
}): Promise<{
	plan: UltragoalPlan;
	goal?: UltragoalGoal;
	allComplete: boolean;
	nextAction: UltragoalCompleteNextAction;
}> {
	const plan = await readUltragoalPlan(input.cwd, input.sessionId);
	if (!plan) throw new Error("No ultragoal plan found. Run `gjc ultragoal create-goals --brief ...` first.");
	// Fail closed: delegated execution requires stamped repository authority (#2901).
	if (!plan.repositoryBinding) {
		throw new Error(
			"Ultragoal plan is missing repositoryBinding; recreate goals so the plan is bound to an authoritative repository identity.",
		);
	}
	await assertCwdMatchesRepositoryBinding(input.cwd, plan.repositoryBinding);
	const retryFailed = input.retryFailed === true;
	const goal = chooseNextGoal(plan, retryFailed);
	if (!goal) {
		const state = getUltragoalRunCompletionState(plan, { retryFailed });
		return {
			plan,
			allComplete: state.allComplete,
			nextAction: resolveUltragoalCompleteNextAction(plan, { retryFailed }),
		};
	}
	if (goal.status !== "active") {
		const now = new Date().toISOString();
		goal.status = "active";
		goal.startedAt = goal.startedAt ?? now;
		goal.updatedAt = now;
		plan.updatedAt = now;
		await writePlan(input.cwd, plan, input.sessionId);
		await appendLedger(input.cwd, { event: "goal_started", goalId: goal.id }, input.sessionId);
	}
	return {
		plan,
		goal,
		allComplete: false,
		nextAction: { kind: "execute-goal", goal },
	};
}

async function readStructuredValue(cwd: string, value: string): Promise<unknown> {
	const trimmed = value.trim();
	if (!trimmed) return "";
	if (trimmed.startsWith("{") || trimmed.startsWith("[")) return JSON.parse(trimmed) as unknown;
	try {
		return await Bun.file(path.resolve(cwd, trimmed)).json();
	} catch (error) {
		if (isEnoent(error)) return value;
		throw error;
	}
}
export function qualityGateObject(value: unknown): JsonObject | null {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonObject) : null;
}

export function nonEmptyStringArray(value: unknown): string[] | null {
	if (!Array.isArray(value)) return null;
	const strings = value.filter(item => typeof item === "string" && item.trim().length > 0);
	return strings.length === value.length && strings.length > 0 ? strings : null;
}

export interface UltragoalQualityGateDiagnostic {
	path: string;
	code: string;
	message: string;
}

/**
 * Collects every quality-gate defect in one pass instead of throwing on the first.
 * Authoring a valid gate is otherwise an edit/retry loop at the most expensive phase
 * of a run (#3474). The aggregate error message keeps each individual message verbatim
 * so existing callers and assertions that match on a single message still work, and
 * `diagnostics` carries the machine-readable stable `path` + `code` pairs.
 */
export class UltragoalQualityGateError extends Error {
	readonly diagnostics: readonly UltragoalQualityGateDiagnostic[];
	constructor(diagnostics: readonly UltragoalQualityGateDiagnostic[]) {
		super(diagnostics.map(diagnostic => diagnostic.message).join("\n"));
		this.name = "UltragoalQualityGateError";
		this.diagnostics = diagnostics;
	}
}

class QualityGateDiagnostics {
	private readonly collected: UltragoalQualityGateDiagnostic[] = [];

	/**
	 * Runs one independent check. A thrown error is recorded and swallowed so later
	 * checks still run; unrelated defects therefore surface together.
	 */
	check(path: string, code: string, run: () => void): boolean {
		try {
			run();
			return true;
		} catch (error) {
			this.add(path, code, error instanceof Error ? error.message : String(error));
			return false;
		}
	}

	async checkAsync(path: string, code: string, run: () => Promise<void>): Promise<boolean> {
		try {
			await run();
			return true;
		} catch (error) {
			this.add(path, code, error instanceof Error ? error.message : String(error));
			return false;
		}
	}

	add(path: string, code: string, message: string): void {
		this.collected.push({ path, code, message });
	}

	get empty(): boolean {
		return this.collected.length === 0;
	}

	get diagnostics(): readonly UltragoalQualityGateDiagnostic[] {
		return this.collected;
	}

	throwIfAny(): void {
		if (this.collected.length > 0) throw new UltragoalQualityGateError(this.collected);
	}
}

function requireNonEmptyString(value: unknown, fieldName: string): void {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new Error(`qualityGate ${fieldName} must be a non-empty string`);
	}
}

function requireEmptyBlockers(value: unknown, fieldName: string): void {
	if (!Array.isArray(value) || value.length !== 0) {
		throw new Error(`qualityGate ${fieldName} must be an empty blockers array`);
	}
}
export function requireQualityGateObject(value: unknown, fieldName: string): JsonObject {
	const object = qualityGateObject(value);
	if (!object) throw new Error(`qualityGate ${fieldName} must be an object`);
	return object;
}

export function requireObjectArray(value: unknown, fieldName: string): JsonObject[] {
	if (!Array.isArray(value) || value.length === 0) {
		throw new Error(`qualityGate ${fieldName} must be a non-empty object array`);
	}
	return value.map((item, index) => requireQualityGateObject(item, `${fieldName}[${index}]`));
}

export function requiredStringField(row: JsonObject, key: string, fieldName: string): string {
	const value = row[key];
	if (typeof value !== "string" || value.trim().length === 0) {
		const hint =
			key === "obligation" && typeof row.description === "string" && row.description.trim().length > 0
				? "; found description, but complete-checkpoint contractCoverage rows require obligation"
				: "";
		throw new Error(`qualityGate ${fieldName}.${key} must be a non-empty string${hint}`);
	}
	return value.trim();
}

function optionalStatusField(row: JsonObject, fieldName: string): string | null {
	if (row.status === undefined) return null;
	const status = requiredStringField(row, "status", fieldName).toLowerCase();
	if (status === "todo") throw new Error(`qualityGate ${fieldName}.status must not be todo`);
	return status;
}

function requireProofStatus(status: string, fieldName: string): void {
	if (!ACCEPTED_PROOF_STATUSES.has(status) && status !== NOT_APPLICABLE_STATUS) {
		throw new Error(`qualityGate ${fieldName}.status must be covered, passed, verified, or not_applicable`);
	}
}
function requireSuccessStatus(status: string, fieldName: string): void {
	requireProofStatus(status, fieldName);
	if (status === NOT_APPLICABLE_STATUS) {
		throw new Error(`qualityGate ${fieldName}.status must be covered, passed, or verified`);
	}
}

function rowOutcomeStatuses(row: JsonObject, fieldName: string): string[] {
	const statuses: string[] = [];
	const status = optionalStatusField(row, fieldName);
	if (status) statuses.push(status);
	const verdict = row.verdict;
	if (typeof verdict === "string" && verdict.trim().length > 0) statuses.push(verdict.trim().toLowerCase());
	const result = row.result;
	if (typeof result === "string" && result.trim().length > 0) statuses.push(result.trim().toLowerCase());
	if (statuses.length === 0) throw new Error(`qualityGate ${fieldName}.verdict must be a non-empty string`);
	return statuses;
}

function requireSuccessfulRowOutcome(row: JsonObject, fieldName: string): void {
	for (const status of rowOutcomeStatuses(row, fieldName)) {
		requireSuccessStatus(status, fieldName);
	}
}

export function requireStringLinks(value: unknown, fieldName: string): string[] {
	const strings = nonEmptyStringArray(value);
	if (!strings) throw new Error(`qualityGate ${fieldName} must be a non-empty string array`);
	return strings.map(item => item.trim());
}

function optionalStringLinks(row: JsonObject, key: string, fieldName: string): string[] | null {
	if (row[key] === undefined) return null;
	return requireStringLinks(row[key], `${fieldName}.${key}`);
}

function buildRowIdMap(rows: JsonObject[], fieldName: string): Map<string, JsonObject> {
	const ids = new Map<string, JsonObject>();
	for (const [index, row] of rows.entries()) {
		const id = requiredStringField(row, "id", `${fieldName}[${index}]`);
		if (ids.has(id)) throw new Error(`qualityGate ${fieldName} contains duplicate id ${id}`);
		ids.set(id, row);
	}
	return ids;
}

export function requireResolvedLinks(ids: string[], map: Map<string, JsonObject>, fieldName: string): void {
	for (const id of ids) {
		if (!map.has(id)) throw new Error(`qualityGate ${fieldName} references unknown id ${id}`);
	}
}
function successfulLinkedRows(
	ids: string[],
	map: Map<string, JsonObject>,
	fieldName: string,
	expectedContractRef: string,
): JsonObject[] {
	const rows: JsonObject[] = [];
	for (const id of ids) {
		const row = map.get(id);
		if (!row) throw new Error(`qualityGate ${fieldName} references unknown id ${id}`);
		requireSuccessfulRowOutcome(row, `${fieldName}.${id}`);
		if (requiredStringField(row, "contractRef", `${fieldName}.${id}`) !== expectedContractRef) {
			throw new Error(`qualityGate ${fieldName}.${id}.contractRef must match ${expectedContractRef}`);
		}
		rows.push(row);
	}
	return rows;
}

export function normalizedEvidenceKind(row: JsonObject): string {
	return requiredStringField(row, "kind", "executorQa.artifactRefs[]").toLowerCase().replaceAll("_", "-");
}

export function evidenceKindMatches(kind: string, words: string[]): boolean {
	return words.some(word => kind.includes(word));
}
function formatActualArtifactKinds(artifactIds: string[], kinds: string[]): string {
	if (artifactIds.length === 0) return "none";
	return artifactIds.map((id, index) => `${id}=${kinds[index] ?? "<missing-kind>"}`).join(", ");
}

function formatExpectedKindWords(words: string[]): string {
	return words.map(word => `"${word}"`).join(", ");
}

export type SurfaceFamily = "web" | "cli" | "native" | "api-package" | "algorithm-math" | "unknown";

const MANDATORY_COMPUTER_CASE_IDS = [
	"kill-switch-bypass",
	"suspended-enforcement",
	"permission-revoked",
	"display-stale",
	"out-of-bounds-drift",
	"runaway-loop-halt",
	"blast-radius",
] as const;

function isComputerControlSurfaceCategory(category: UltragoalChangeCategory): boolean {
	// Shared behavior registries are intentionally conservative: a path-only or
	// uninspectable change cannot prove that computer controls were untouched.
	// Generated bindings remain excluded because their behavior-bearing Rust
	// source is captured separately.
	return category === "code" || category === "tool" || category === "settings-registry";
}

function isComputerControlSurfaceChangePath(row: UltragoalChangeSetPath): boolean {
	const category = row.category ?? categorizeComputerChangePath(row.path);
	const oldCategory = row.oldPath ? categorizeComputerChangePath(row.oldPath) : category;
	return isComputerControlSurfaceCategory(category) || isComputerControlSurfaceCategory(oldCategory);
}

function trustedChangeSetRequiresComputerSuite(changeSet: UltragoalChangeSet | undefined): boolean {
	if (!changeSet?.trusted) return false;
	if (changeSet.captureIncomplete) return true;
	return changeSet.paths.some(isComputerControlSurfaceChangePath);
}

function requiresComputerRedTeamSuite(executorQa: JsonObject, changeSet: UltragoalChangeSet | undefined): boolean {
	if (trustedChangeSetRequiresComputerSuite(changeSet)) return true;
	const declaredPaths = Array.isArray(executorQa.changedPaths) ? executorQa.changedPaths : [];
	return declaredPaths.some(
		value => typeof value === "string" && isComputerControlSurfaceCategory(categorizeComputerChangePath(value)),
	);
}

function normalizeAdversarialCaseId(value: string): string {
	return normalizeSurfaceToken(value).replace(/\s+/g, "-");
}

export function normalizeSurfaceToken(value: string): string {
	return value.toLowerCase().replaceAll("_", "-").trim();
}

export function surfaceFamily(value: string): SurfaceFamily {
	const normalized = normalizeSurfaceToken(value);
	if (
		["computer", "computer-use", "desktop-input", "native-input", "native", "desktop", "tui"].some(word =>
			normalized.includes(word),
		)
	)
		return "native";
	if (["gui", "web", "browser", "ui", "visual"].some(word => normalized.includes(word))) return "web";
	if (["cli", "terminal", "command"].some(word => normalized.includes(word))) return "cli";
	if (["api", "package", "library", "sdk"].some(word => normalized.includes(word))) return "api-package";
	if (["algorithm", "math", "mathematical", "equation"].some(word => normalized.includes(word))) {
		return "algorithm-math";
	}
	return "unknown";
}

export function isLiveSurfaceFamily(family: SurfaceFamily): boolean {
	return family === "web" || family === "cli" || family === "native";
}

function validateSurfaceArtifactCompatibility(
	surface: string,
	artifactIds: string[],
	artifactRefs: Map<string, JsonObject>,
	fieldName: string,
): void {
	const family = surfaceFamily(surface);
	const kinds = artifactIds.map(id => normalizedEvidenceKind(artifactRefs.get(id)!));
	if (family === "web") {
		const hasBrowser = kinds.some(kind =>
			evidenceKindMatches(kind, ["browser", "playwright", "pandawright", "automation"]),
		);
		const hasVisual = kinds.some(kind => evidenceKindMatches(kind, ["screenshot", "image", "visual"]));
		if (!hasBrowser || !hasVisual) {
			throw new Error(
				`qualityGate ${fieldName} for GUI/web surfaces must reference browser automation plus screenshot or image-verdict artifacts; surface "${surface}" expected one artifact kind containing one of ${formatExpectedKindWords(["browser", "playwright", "pandawright", "automation"])} and one containing one of ${formatExpectedKindWords(["screenshot", "image", "visual"])}; actual artifact kinds: ${formatActualArtifactKinds(artifactIds, kinds)}`,
			);
		}
		return;
	}
	const surfaceFamilies: Record<Exclude<SurfaceFamily, "web" | "unknown">, { evidence: string[]; label: string }> = {
		cli: {
			evidence: ["cli", "log", "transcript", "terminal", "command", "test-report"],
			label: "CLI",
		},
		native: {
			evidence: ["native", "desktop", "tui", "terminal", "pty", "transcript", "screenshot", "image", "automation"],
			label: "native",
		},
		"api-package": {
			evidence: ["api", "package", "consumer", "black-box", "test-report"],
			label: "API/package",
		},
		"algorithm-math": {
			evidence: ["property", "boundary", "edge", "adversarial", "failure", "math", "algorithm", "test-report"],
			label: "algorithm/math",
		},
	};
	if (family !== "unknown") {
		const expected = surfaceFamilies[family];
		if (!kinds.some(kind => evidenceKindMatches(kind, expected.evidence))) {
			throw new Error(
				`qualityGate ${fieldName} for ${expected.label} surfaces must reference compatible artifact kinds; surface "${surface}" expected at least one artifact kind containing one of ${formatExpectedKindWords(expected.evidence)}; actual artifact kinds: ${formatActualArtifactKinds(artifactIds, kinds)}`,
			);
		}
	}
}

export function isSubstantiveEvidence(value: unknown): boolean {
	if (typeof value !== "string") return false;
	const trimmed = value.trim();
	if (trimmed.length < MIN_SUBSTANTIVE_EVIDENCE_CHARS) return false;
	const words = trimmed.split(/\s+/).filter(word => /[a-z0-9]/i.test(word));
	if (words.length < MIN_SUBSTANTIVE_EVIDENCE_WORDS) return false;
	const normalized = trimmed.toLowerCase();
	// Shared with the ask contract screen so the two lists cannot drift (#5002).
	return !isPlaceholderToken(normalized);
}

export function hasTypedVerifiedReceipt(value: unknown): boolean {
	const receipt = qualityGateObject(value);
	if (!receipt) return false;
	const type = nonEmptyString(receipt.type) ?? nonEmptyString(receipt.kind) ?? nonEmptyString(receipt.receiptType);
	const id = nonEmptyString(receipt.id) ?? nonEmptyString(receipt.receiptId) ?? nonEmptyString(receipt.ref);
	const status = (nonEmptyString(receipt.status) ?? nonEmptyString(receipt.verdict) ?? "").toLowerCase();
	return Boolean(type && id && (status === "verified" || status === "passed"));
}

async function resolveExistingArtifactPathUnderCwd(
	cwd: string,
	value: unknown,
	fieldName: string,
): Promise<string | null> {
	const artifactPath = nonEmptyString(value);
	if (!artifactPath) return null;
	const lexicalRoot = path.resolve(cwd);
	const lexical = path.resolve(lexicalRoot, artifactPath);
	const lexicalRelative = path.relative(lexicalRoot, lexical);
	if (lexicalRelative === ".." || lexicalRelative.startsWith(`..${path.sep}`) || path.isAbsolute(lexicalRelative)) {
		throw new Error(`qualityGate ${fieldName} artifact path must resolve under the repository cwd`);
	}
	try {
		const [root, resolved] = await Promise.all([fs.realpath(lexicalRoot), fs.realpath(lexical)]);
		const relative = path.relative(root, resolved);
		if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
			throw new Error(`qualityGate ${fieldName} artifact path must not escape the repository cwd through symlinks`);
		}
		if (!(await fs.stat(resolved)).isFile()) {
			throw new Error(`qualityGate ${fieldName} artifact path must reference a regular file`);
		}
		return resolved;
	} catch (error) {
		if (isEnoent(error)) return null;
		throw error;
	}
}

export async function hasExistingNonEmptyArtifact(cwd: string, value: unknown): Promise<boolean> {
	const resolved = await resolveExistingArtifactPathUnderCwd(cwd, value, "artifact");
	if (!resolved) return false;
	return (await fs.stat(resolved)).size > 0;
}

export async function readArtifactBytes(cwd: string, row: JsonObject, fieldName: string): Promise<Buffer | null> {
	const resolved = await resolveExistingArtifactPathUnderCwd(cwd, row.path, fieldName);
	if (!resolved) return null;
	try {
		return Buffer.from(await Bun.file(resolved).arrayBuffer());
	} catch (error) {
		if (isEnoent(error)) return null;
		throw new Error(`qualityGate ${fieldName} artifact could not be read: ${String(error)}`);
	}
}

import {
	readCliReplayRecord,
	resolveCliReplayCommand,
	validateArtifactProof,
	validateCliReplay,
	validateLiveSurfaceProofPresence,
	validateReplayExemptFallback,
	validateStructuralArtifact,
	validateSurfaceStructuralRequirement,
	waitForReplayProcessWithTimeout,
} from "./ultragoal-evidence";

export type { ReplayProcessHandle } from "./ultragoal-evidence";
export {
	resolveCliReplayCommand,
	validateArtifactProof,
	validateCliReplay,
	validateLiveSurfaceProofPresence,
	validateReplayExemptFallback,
	validateStructuralArtifact,
	validateSurfaceStructuralRequirement,
	waitForReplayProcessWithTimeout,
};

async function validateArtifactRefs(cwd: string, executorQa: JsonObject): Promise<Map<string, JsonObject>> {
	void cwd;
	const rows = requireObjectArray(executorQa.artifactRefs, "executorQa.artifactRefs");
	const idMap = buildRowIdMap(rows, "executorQa.artifactRefs");
	for (const [index, row] of rows.entries()) {
		const fieldName = `executorQa.artifactRefs[${index}]`;
		requiredStringField(row, "kind", fieldName);
		requiredStringField(row, "description", fieldName);
	}
	return idMap;
}

async function validateSurfaceEvidence(
	cwd: string,
	executorQa: JsonObject,
	artifactRefs: Map<string, JsonObject>,
): Promise<Map<string, JsonObject>> {
	const rows = requireObjectArray(executorQa.surfaceEvidence, "executorQa.surfaceEvidence");
	const idMap = buildRowIdMap(rows, "executorQa.surfaceEvidence");
	for (const [index, row] of rows.entries()) {
		const fieldName = `executorQa.surfaceEvidence[${index}]`;
		const status = optionalStatusField(row, fieldName);
		requiredStringField(row, "contractRef", fieldName);
		if (status === NOT_APPLICABLE_STATUS) {
			requiredStringField(row, "reason", fieldName);
			continue;
		}
		const surface = requiredStringField(row, "surface", fieldName);
		const family = surfaceFamily(surface);
		requireSuccessfulRowOutcome(row, fieldName);
		requiredStringField(row, "invocation", fieldName);
		if (typeof row.verdict !== "string" || row.verdict.trim().length === 0) {
			requiredStringField(row, "result", fieldName);
		}
		const artifactIds = requireStringLinks(row.artifactRefs, `${fieldName}.artifactRefs`);
		requireResolvedLinks(artifactIds, artifactRefs, `${fieldName}.artifactRefs`);
		if (!isLiveSurfaceFamily(family)) {
			for (const artifactId of artifactIds) {
				const artifact = artifactRefs.get(artifactId)!;
				if (!(await hasExistingNonEmptyArtifact(cwd, artifact.path))) {
					throw new Error(
						`qualityGate executorQa.artifactRefs.${artifactId} non-live surface evidence requires an existing non-empty file`,
					);
				}
			}
		}
		await validateLiveSurfaceProofPresence(cwd, family, artifactIds, artifactRefs);
		validateSurfaceArtifactCompatibility(surface, artifactIds, artifactRefs, `${fieldName}.artifactRefs`);
		await validateSurfaceStructuralRequirement(cwd, family, artifactIds, artifactRefs, `${fieldName}.artifactRefs`);
		if (family === "cli") {
			let hasPassingReplay = false;
			for (const artifactId of artifactIds) {
				const artifact = artifactRefs.get(artifactId)!;
				const artifactField = `executorQa.artifactRefs.${artifactId}`;
				const record = await readCliReplayRecord(cwd, artifact, artifactField);
				if (!record) continue;
				if (record.replayExempt !== undefined) {
					if (
						await validateReplayExemptFallback(cwd, { ...record, id: artifactId }, artifactField, artifactRefs, {
							surfaceFamily: family,
							live: true,
						})
					) {
						hasPassingReplay = true;
					}
				} else if (await validateCliReplay(cwd, artifact, artifactField, { live: true })) {
					hasPassingReplay = true;
				}
			}
			if (!hasPassingReplay) {
				throw new Error(
					`qualityGate ${fieldName} for CLI surfaces must include a passing argv CLI replay or valid replayExempt fallback`,
				);
			}
		}
		for (const artifactId of artifactIds) {
			if (family === "cli") {
				const record = await readCliReplayRecord(
					cwd,
					artifactRefs.get(artifactId)!,
					`executorQa.artifactRefs.${artifactId}`,
				);
				if (record?.replayExempt !== undefined) continue;
			}
			await validateArtifactProof(cwd, artifactRefs.get(artifactId)!, `executorQa.artifactRefs.${artifactId}`, {
				surfaceFamily: family,
				live: isLiveSurfaceFamily(family),
			});
		}
	}
	return idMap;
}

function validateAdversarialCases(
	executorQa: JsonObject,
	artifactRefs: Map<string, JsonObject>,
): Map<string, JsonObject> {
	const rows = requireObjectArray(executorQa.adversarialCases, "executorQa.adversarialCases");
	const idMap = buildRowIdMap(rows, "executorQa.adversarialCases");
	for (const [index, row] of rows.entries()) {
		const fieldName = `executorQa.adversarialCases[${index}]`;
		const status = optionalStatusField(row, fieldName);
		if (status === NOT_APPLICABLE_STATUS) {
			throw new Error(`qualityGate ${fieldName}.status must not be not_applicable`);
		}
		requireSuccessfulRowOutcome(row, fieldName);
		requiredStringField(row, "contractRef", fieldName);
		requiredStringField(row, "scenario", fieldName);
		requiredStringField(row, "expectedBehavior", fieldName);
		if (typeof row.verdict !== "string" || row.verdict.trim().length === 0) {
			requiredStringField(row, "result", fieldName);
		}
		const artifactIds = requireStringLinks(row.artifactRefs, `${fieldName}.artifactRefs`);
		requireResolvedLinks(artifactIds, artifactRefs, `${fieldName}.artifactRefs`);
	}
	return idMap;
}

async function validateMandatoryComputerAdversarialCases(
	cwd: string,
	contractCoverage: JsonObject[],
	adversarialCases: Map<string, JsonObject>,
	artifactRefs: Map<string, JsonObject>,
): Promise<void> {
	const linkedCaseIds = new Set<string>();
	for (const [index, row] of contractCoverage.entries()) {
		const ids = optionalStringLinks(row, "adversarialCaseRefs", `executorQa.contractCoverage[${index}]`);
		for (const id of ids ?? []) linkedCaseIds.add(normalizeAdversarialCaseId(id));
	}
	for (const caseId of MANDATORY_COMPUTER_CASE_IDS) {
		const row = adversarialCases.get(caseId);
		if (!row)
			throw new Error(
				`COMPUTER_REDTEAM_CASE_MISSING: qualityGate executorQa.adversarialCases must include ${caseId}`,
			);
		if (optionalStatusField(row, `executorQa.adversarialCases.${caseId}`) === NOT_APPLICABLE_STATUS) {
			throw new Error(
				`COMPUTER_REDTEAM_CASE_NOT_APPLICABLE: mandatory computer adversarial case ${caseId} must not be not_applicable`,
			);
		}
		if (!linkedCaseIds.has(caseId)) {
			throw new Error(
				`COMPUTER_REDTEAM_CASE_UNLINKED: mandatory computer adversarial case ${caseId} must be linked from contractCoverage.adversarialCaseRefs`,
			);
		}
		const artifactIds = requireStringLinks(row.artifactRefs, `executorQa.adversarialCases.${caseId}.artifactRefs`);
		let hasValidLiveNativeProof = false;
		let sawInlineOnly = false;
		let sawReceiptOnly = false;
		let sawMetadataOnly = false;
		for (const artifactId of artifactIds) {
			const artifact = artifactRefs.get(artifactId);
			if (!artifact)
				throw new Error(
					`qualityGate executorQa.adversarialCases.${caseId}.artifactRefs references unknown id ${artifactId}`,
				);
			const fieldName = `executorQa.artifactRefs.${artifactId}`;
			if (artifact.inlineEvidence !== undefined && !nonEmptyString(artifact.path)) sawInlineOnly = true;
			if (
				(artifact.verifiedReceipt !== undefined || artifact.receipt !== undefined) &&
				!nonEmptyString(artifact.path)
			)
				sawReceiptOnly = true;
			if (
				!nonEmptyString(artifact.path) &&
				artifact.inlineEvidence === undefined &&
				artifact.verifiedReceipt === undefined &&
				artifact.receipt === undefined
			)
				sawMetadataOnly = true;
			try {
				await validateArtifactProof(cwd, artifact, fieldName, { surfaceFamily: "native", live: true });
				if (await validateStructuralArtifact(cwd, artifact, fieldName, { surfaceFamily: "native", live: true }))
					hasValidLiveNativeProof = true;
			} catch {
				// Preserve the explicit computer red-team error taxonomy below.
			}
		}
		if (!hasValidLiveNativeProof) {
			if (sawInlineOnly)
				throw new Error(
					`COMPUTER_REDTEAM_INLINE_ONLY: mandatory computer adversarial case ${caseId} requires live structural native proof`,
				);
			if (sawReceiptOnly)
				throw new Error(
					`COMPUTER_REDTEAM_RECEIPT_ONLY: mandatory computer adversarial case ${caseId} requires live structural native proof`,
				);
			if (sawMetadataOnly)
				throw new Error(
					`COMPUTER_REDTEAM_ARTIFACT_METADATA_ONLY: mandatory computer adversarial case ${caseId} requires durable live structural native proof`,
				);
			throw new Error(
				`COMPUTER_REDTEAM_ARTIFACT_MISSING: mandatory computer adversarial case ${caseId} requires at least one valid live structural native proof artifact`,
			);
		}
	}
}

async function validateContractCoverage(
	cwd: string,
	executorQa: JsonObject,
	surfaceEvidence: Map<string, JsonObject>,
	adversarialCases: Map<string, JsonObject>,
	artifactRefs: Map<string, JsonObject>,
): Promise<JsonObject[]> {
	const rows = requireObjectArray(executorQa.contractCoverage, "executorQa.contractCoverage");
	buildRowIdMap(rows, "executorQa.contractCoverage");
	let hasSuccessfulContractCoverage = false;
	for (const [index, row] of rows.entries()) {
		const fieldName = `executorQa.contractCoverage[${index}]`;
		const contractRef = requiredStringField(row, "contractRef", fieldName);
		const status = optionalStatusField(row, fieldName);
		if (status === NOT_APPLICABLE_STATUS) {
			requiredStringField(row, "reason", fieldName);
			continue;
		}
		requiredStringField(row, "obligation", fieldName);
		if (!status) throw new Error(`qualityGate ${fieldName}.status must be a non-empty string`);
		requireSuccessStatus(status, fieldName);
		hasSuccessfulContractCoverage = true;
		const surfaceIds = optionalStringLinks(row, "surfaceEvidenceRefs", fieldName);
		const adversarialIds = optionalStringLinks(row, "adversarialCaseRefs", fieldName);
		const artifactIds = optionalStringLinks(row, "artifactRefs", fieldName);
		if (!surfaceIds && !adversarialIds && !artifactIds) {
			throw new Error(
				`qualityGate ${fieldName} must link to surfaceEvidenceRefs, adversarialCaseRefs, or artifactRefs`,
			);
		}
		let successfulProofLinks = 0;
		let successfulSurfaceProofLinks = 0;
		if (surfaceIds) {
			successfulSurfaceProofLinks = successfulLinkedRows(
				surfaceIds,
				surfaceEvidence,
				`${fieldName}.surfaceEvidenceRefs`,
				contractRef,
			).length;
			successfulProofLinks += successfulSurfaceProofLinks;
		}
		if (adversarialIds) {
			const successfulAdversarialRows = successfulLinkedRows(
				adversarialIds,
				adversarialCases,
				`${fieldName}.adversarialCaseRefs`,
				contractRef,
			);
			for (const adversarialRow of successfulAdversarialRows) {
				const caseArtifactIds = requireStringLinks(
					adversarialRow.artifactRefs,
					`${fieldName}.adversarialCaseRefs.artifactRefs`,
				);
				for (const artifactId of caseArtifactIds) {
					const artifact = artifactRefs.get(artifactId)!;
					if (!(await hasExistingNonEmptyArtifact(cwd, artifact.path))) {
						throw new Error(
							`qualityGate executorQa.artifactRefs.${artifactId} adversarial coverage requires an existing non-empty file`,
						);
					}
					await validateArtifactProof(cwd, artifact, `executorQa.artifactRefs.${artifactId}`, {
						surfaceFamily: "native",
						live: false,
					});
				}
			}
			successfulProofLinks += successfulAdversarialRows.length;
		}
		if (artifactIds) {
			requireResolvedLinks(artifactIds, artifactRefs, `${fieldName}.artifactRefs`);
			for (const artifactId of artifactIds) {
				const artifact = artifactRefs.get(artifactId)!;
				if (!(await hasExistingNonEmptyArtifact(cwd, artifact.path))) {
					throw new Error(
						`qualityGate executorQa.artifactRefs.${artifactId} artifact-only coverage requires an existing non-empty file`,
					);
				}
				await validateArtifactProof(cwd, artifact, `executorQa.artifactRefs.${artifactId}`, {
					surfaceFamily: "native",
					live: false,
				});
			}
			successfulProofLinks += artifactIds.length;
		}
		if (successfulProofLinks === 0) {
			throw new Error(`qualityGate ${fieldName} must link to at least one successful proof row or artifact`);
		}
	}
	if (!hasSuccessfulContractCoverage) {
		throw new Error(
			"qualityGate executorQa.contractCoverage must include at least one row with status covered, passed, or verified",
		);
	}
	return rows;
}

async function validateExecutorQaRedTeamEvidenceInternal(
	cwd: string,
	executorQa: JsonObject,
	options: { mode?: "checkpoint" | "review"; changeSet?: UltragoalChangeSet } = {},
): Promise<void> {
	const artifactRefs = await validateArtifactRefs(cwd, executorQa);
	const surfaceEvidence = await validateSurfaceEvidence(cwd, executorQa, artifactRefs);
	const adversarialCases = validateAdversarialCases(executorQa, artifactRefs);
	const contractCoverage = await validateContractCoverage(
		cwd,
		executorQa,
		surfaceEvidence,
		adversarialCases,
		artifactRefs,
	);
	if (requiresComputerRedTeamSuite(executorQa, options.changeSet)) {
		await validateMandatoryComputerAdversarialCases(cwd, contractCoverage, adversarialCases, artifactRefs);
	}
}

async function validateExecutorQaRedTeamEvidence(
	cwd: string,
	executorQa: JsonObject,
	options: { changeSet?: UltragoalChangeSet } = {},
): Promise<void> {
	await validateExecutorQaRedTeamEvidenceInternal(cwd, executorQa, {
		mode: "checkpoint",
		changeSet: options.changeSet,
	});
}

export async function validateExecutorQaRedTeamEvidenceForReview(
	cwd: string,
	executorQa: Record<string, unknown>,
	options: { mode?: "review"; changeSet?: UltragoalChangeSet } = {},
): Promise<void> {
	await validateExecutorQaRedTeamEvidenceInternal(cwd, executorQa as JsonObject, options);
}

function canonicalChangeSetRows(value: unknown, fieldName: string): UltragoalChangeSetPath[] {
	if (!Array.isArray(value)) throw new Error(`${fieldName} must be an array`);
	return value.map((row, index) => {
		if (typeof row !== "object" || row === null || Array.isArray(row))
			throw new Error(`${fieldName}[${index}] must be an object`);
		const record = row as JsonObject;
		requireAllowedRecordKeys(record, ["path", "status", "oldPath"], `${fieldName}[${index}]`);
		const pathValue = exactNonEmptyString(record.path);
		if (!pathValue) throw new Error(`${fieldName}[${index}].path is required`);
		if ("goalId" in record) throw new Error(`${fieldName}[${index}] must not contain goalId attribution`);
		const status = nonEmptyString(record.status);
		if (!status) throw new Error(`${fieldName}[${index}].status is required`);
		const oldPath = exactNonEmptyString(record.oldPath);
		return {
			path: normalizeChangeSetPath(pathValue),
			status: status as UltragoalChangeStatus,
			...(oldPath ? { oldPath: normalizeChangeSetPath(oldPath) } : {}),
		};
	});
}

function changeSetHashForPaths(paths: readonly UltragoalChangeSetPath[]): string {
	return hashStructuredValue(paths.map(row => ({ path: row.path, status: row.status, oldPath: row.oldPath })));
}

function requireChangeSetCoverage(
	expected: UltragoalChangeSet | undefined,
	declared: readonly UltragoalChangeSetPath[],
	fieldName: string,
): void {
	if (!expected) throw new Error(`${fieldName} requires an authoritative computed checkpoint change set`);
	if (expected.captureIncomplete)
		throw new Error(`${fieldName} requires a complete authoritative checkpoint change set`);
	const expectedExactRows = expected.paths.map(row => `${row.oldPath ?? ""}\u0000${row.path}\u0000${row.status}`);
	const declaredExactRows = declared.map(row => `${row.oldPath ?? ""}\u0000${row.path}\u0000${row.status}`);
	const declaredExactKeys = new Set(declaredExactRows);
	for (const [index, row] of expected.paths.entries()) {
		if (!declaredExactKeys.has(expectedExactRows[index]!)) {
			throw new Error(`${fieldName} does not cover computed checkpoint change-set path ${row.path}`);
		}
	}
	if (
		declaredExactRows.length !== expectedExactRows.length ||
		declaredExactRows.some((key, index) => key !== expectedExactRows[index])
	) {
		throw new Error(`${fieldName} must exactly match the computed checkpoint change set`);
	}
}

function requireExactRecordKeys(record: JsonObject, expectedKeys: readonly string[], fieldName: string): void {
	const actual = Object.keys(record).sort();
	const expected = [...expectedKeys].sort();
	if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
		throw new Error(`${fieldName} keys must exactly match durable validationBatch memberIds`);
	}
}

function requireAllowedRecordKeys(record: JsonObject, allowedKeys: readonly string[], fieldName: string): void {
	const allowed = new Set(allowedKeys);
	const unsupported = Object.keys(record).filter(key => !allowed.has(key));
	if (unsupported.length > 0) throw new Error(`${fieldName} contains unsupported keys: ${unsupported.join(", ")}`);
}

function requireValidationBatchTuple(
	metadata: UltragoalValidationBatchMetadata,
	record: JsonObject,
	fieldName: string,
): void {
	if (record.schemaVersion !== 1) throw new Error(`${fieldName}.schemaVersion must be 1`);
	if (record.batchId !== metadata.batchId) throw new Error(`${fieldName}.batchId must match durable validationBatch`);
	if (record.finalGoalId !== metadata.finalGoalId)
		throw new Error(`${fieldName}.finalGoalId must match durable validationBatch`);
	if (record.metadataHash !== metadata.metadataHash)
		throw new Error(`${fieldName}.metadataHash must match durable validationBatch`);
	const memberIds = stringArray(record.memberIds);
	if (
		!memberIds ||
		memberIds.length !== metadata.memberIds.length ||
		memberIds.some((id, index) => id !== metadata.memberIds[index])
	) {
		throw new Error(`${fieldName}.memberIds must match durable validationBatch order`);
	}
}

const DEFERRABLE_REVIEW_LANES = new Set(["architectReview", "executorQa"]);
const DECLARABLE_DEFERRED_LANES: Record<string, string> = {
	targetedVerification: "targetedVerification",
	aiSlopCleaner: "aiSlopCleaner",
	iteration: "iteration",
};

/**
 * Declaration-vs-evidence check. Per-subgoal enforcement is relaxed: the agent
 * chooses which verification lanes to run and declares them in `ranLanes`. The
 * runtime does not dictate that set, but it fails closed when the declaration and
 * the submitted evidence disagree in either direction, so a declaration can never
 * be cheaper than the proof behind it.
 */
function validateDeferredLaneDeclaration(deferred: JsonObject, fieldName: string): void {
	const declared = stringArray(deferred.ranLanes)?.filter(lane => lane.length > 0);
	// `ranLanes` is optional for compatibility with gates that only carry the
	// mandatory targeted-verification lane; an explicit empty array is a claim
	// that nothing ran and is rejected, because targetedVerification is required.
	if (declared === undefined) return;
	const declaredSet = new Set(declared);
	if (declaredSet.size !== declared.length) throw new Error(`${fieldName}.ranLanes must not repeat a lane`);
	for (const lane of declaredSet) {
		if (DEFERRABLE_REVIEW_LANES.has(lane)) {
			throw new Error(
				`${fieldName}.ranLanes cannot declare ${lane}: a deferred gate structurally cannot carry review-lane evidence, so it is deferred to the boundary`,
			);
		}
		const evidenceKey = DECLARABLE_DEFERRED_LANES[lane];
		if (!evidenceKey) throw new Error(`${fieldName}.ranLanes contains unknown lane ${lane}`);
		const laneRecord = qualityGateObject(deferred[evidenceKey]);
		if (!laneRecord || !nonEmptyString(laneRecord.evidence)) {
			throw new Error(`${fieldName}.ranLanes declares ${lane} but ${fieldName}.${evidenceKey}.evidence is missing`);
		}
	}
	if (!declaredSet.has("targetedVerification")) {
		throw new Error(`${fieldName}.ranLanes must declare targetedVerification`);
	}
	for (const [lane, evidenceKey] of Object.entries(DECLARABLE_DEFERRED_LANES)) {
		if (declaredSet.has(lane)) continue;
		if (qualityGateObject(deferred[evidenceKey])) {
			throw new Error(`${fieldName}.${evidenceKey} is present but ${lane} is not declared in ${fieldName}.ranLanes`);
		}
	}
}

/**
 * Agent-friendly deferred-gate hydration: the runtime already stores the durable
 * batch tuple and computes the cumulative change set itself, so a deferred gate
 * only has to prove what the runtime cannot know — that targeted verification ran.
 * Every mechanical field (`kind`, the batch tuple, `deferredLanes`, and the whole
 * `changeSet` block including `paths` and `changeSetHash`) is auto-filled when
 * omitted. Explicitly supplied values are never overwritten, so a wrong
 * declaration still fails closed.
 */
function hydrateDeferredGateDefaults(
	gate: JsonObject,
	goal: UltragoalGoal,
	changeSet: UltragoalChangeSet | undefined,
): JsonObject {
	const deferred = qualityGateObject(gate.deferredToBatch);
	if (!deferred) return gate;
	const metadata = goal.validationBatch;
	// The final member must carry the full strict gate; never help it defer.
	if (metadata && goal.id === metadata.finalGoalId) return gate;
	const hydrated: JsonObject = { ...deferred };
	if (hydrated.kind === undefined) hydrated.kind = "validation-batch-deferred";
	if (metadata) {
		if (hydrated.schemaVersion === undefined) hydrated.schemaVersion = metadata.schemaVersion;
		if (hydrated.batchId === undefined) hydrated.batchId = metadata.batchId;
		if (hydrated.memberIds === undefined) hydrated.memberIds = [...metadata.memberIds];
		if (hydrated.finalGoalId === undefined) hydrated.finalGoalId = metadata.finalGoalId;
		if (hydrated.metadataHash === undefined) hydrated.metadataHash = metadata.metadataHash;
	}
	if (hydrated.deferredLanes === undefined) hydrated.deferredLanes = ["architectReview", "executorQa"];
	const computedRows = (changeSet?.paths ?? []).map(row => ({
		path: row.path,
		status: row.status,
		...(row.oldPath ? { oldPath: row.oldPath } : {}),
	}));
	const computedByPath = new Map(computedRows.map(row => [row.path, row]));
	const declared = qualityGateObject(hydrated.changeSet);
	if (hydrated.changeSet !== undefined && !declared) return { ...gate, deferredToBatch: hydrated };
	const changeSetRecord: JsonObject = declared ? { ...declared } : {};
	if (changeSetRecord.memberGoalId === undefined) changeSetRecord.memberGoalId = goal.id;
	if (changeSetRecord.cumulativeFromBase === undefined) changeSetRecord.cumulativeFromBase = true;
	if (changeSetRecord.paths === undefined) {
		changeSetRecord.paths = computedRows;
	} else if (Array.isArray(changeSetRecord.paths)) {
		// Accept plain-string rows and rows without a status; resolve the status
		// from the computed change set instead of demanding git trivia.
		changeSetRecord.paths = changeSetRecord.paths.map(row => {
			const record = typeof row === "string" ? { path: row } : qualityGateObject(row);
			if (!record) return row;
			const pathValue = exactNonEmptyString(record.path);
			if (!pathValue || nonEmptyString(record.status)) return record;
			const computed = computedByPath.get(normalizeChangeSetPath(pathValue));
			return {
				...record,
				status: computed?.status ?? "unknown",
				...(computed?.oldPath && record.oldPath === undefined ? { oldPath: computed.oldPath } : {}),
			};
		});
	}
	if (changeSetRecord.changeSetHash === undefined) {
		try {
			changeSetRecord.changeSetHash = changeSetHashForPaths(
				canonicalChangeSetRows(changeSetRecord.paths, "deferredToBatch.changeSet.paths"),
			);
		} catch {
			// Malformed rows: leave the hash unset so validation reports the row defect.
		}
	}
	hydrated.changeSet = changeSetRecord;
	return { ...gate, deferredToBatch: hydrated };
}

/**
 * Agent-friendly batch-close hydration, mirroring `hydrateDeferredGateDefaults`:
 * every `validationBatchClose` field except `coverageEvidence` is derivable from
 * durable state (batch metadata, member receipts) and the computed cumulative
 * change set, so it is auto-filled when omitted. Supplied values are never
 * overwritten and still fail closed when wrong. The minimal close is the full
 * strict gate plus `{"validationBatchClose":{"coverageEvidence":"..."}}`.
 */
function hydrateBatchCloseDefaults(input: {
	gate: JsonObject;
	plan: UltragoalPlan;
	goal: UltragoalGoal;
	ledger: readonly UltragoalLedgerEvent[];
	changeSet?: UltragoalChangeSet;
}): JsonObject {
	const metadata = input.goal.validationBatch;
	if (!metadata || input.goal.id !== metadata.finalGoalId) return input.gate;
	const requested = qualityGateObject(input.gate.validationBatchClose);
	if (!requested) return input.gate;
	// The replacement-close kind has its own dedicated hydrator.
	if (requested.kind === "review-blocker-replacement-close") return input.gate;
	const close: JsonObject = { ...requested };
	if (close.schemaVersion === undefined) close.schemaVersion = 1;
	if (close.kind === undefined) close.kind = "validation-batch-close";
	if (close.batchId === undefined) close.batchId = metadata.batchId;
	if (close.finalGoalId === undefined) close.finalGoalId = metadata.finalGoalId;
	if (close.memberIds === undefined) close.memberIds = [...metadata.memberIds];
	const derivedMetadataHashes: Record<string, string> = {};
	const derivedChangeSetHashes: Record<string, string> = {};
	const derivedReceipts: JsonObject[] = [];
	for (const memberId of metadata.memberIds) {
		const member = input.plan.goals.find(goal => goal.id === memberId);
		if (member?.validationBatch) derivedMetadataHashes[memberId] = member.validationBatch.metadataHash;
		if (!member || memberId === input.goal.id) continue;
		try {
			const receipt = requireDeferredMemberReceiptFresh(
				input.plan,
				input.ledger,
				member,
				"validationBatchClose hydration",
			);
			derivedChangeSetHashes[memberId] = receipt.validationBatch.changeSetHash;
			derivedReceipts.push({
				goalId: memberId,
				receiptId: receipt.receiptId,
				checkpointLedgerEventId: receipt.checkpointLedgerEventId,
				qualityGateHash: receipt.qualityGateHash,
				changeSetHash: receipt.validationBatch.changeSetHash,
				role: "deferred-member",
			});
		} catch {
			// Member not fresh/complete: omit it so validation reports the real defect.
		}
	}
	if (close.memberMetadataHashes === undefined) close.memberMetadataHashes = derivedMetadataHashes;
	if (close.memberReceipts === undefined) close.memberReceipts = derivedReceipts;
	const requestedUnion = qualityGateObject(close.unionChangeSet);
	if (close.unionChangeSet !== undefined && !requestedUnion) {
		return { ...input.gate, validationBatchClose: close };
	}
	const union: JsonObject = requestedUnion ? { ...requestedUnion } : {};
	if (union.source === undefined) union.source = "validation-batch";
	if (union.paths === undefined) {
		union.paths = (input.changeSet?.paths ?? []).map(row => ({
			path: row.path,
			status: row.status,
			...(row.oldPath ? { oldPath: row.oldPath } : {}),
		}));
	}
	try {
		const unionRows = canonicalChangeSetRows(union.paths, "validationBatchClose.unionChangeSet.paths");
		const suppliedChangeSetHashes = qualityGateObject(union.memberChangeSetHashes);
		const derivedMemberChangeSetHashes: Record<string, unknown> = {
			...derivedChangeSetHashes,
			[metadata.finalGoalId]: changeSetHashForPaths(unionRows),
		};
		if (union.memberChangeSetHashes === undefined) {
			union.memberChangeSetHashes = derivedMemberChangeSetHashes;
		}
		if (union.unionHash === undefined) {
			union.unionHash = hashStructuredValue({
				memberChangeSetHashes: suppliedChangeSetHashes ?? derivedMemberChangeSetHashes,
				paths: unionRows.map(row => ({ path: row.path, status: row.status, oldPath: row.oldPath })),
			});
		}
	} catch {
		// Malformed rows: leave derived hashes unset so validation reports the row defect.
	}
	close.unionChangeSet = union;
	return { ...input.gate, validationBatchClose: close };
}

function validateDeferredCompletionQualityGate(
	gate: JsonObject,
	goal: UltragoalGoal,
	metadata: UltragoalValidationBatchMetadata | undefined,
	changeSet?: UltragoalChangeSet,
): void {
	const allowedKeys = new Set(["deferredToBatch"]);
	const unsupportedKeys = Object.keys(gate).filter(key => !allowedKeys.has(key));
	if (unsupportedKeys.length > 0)
		throw new Error(`deferred qualityGate contains unsupported keys: ${unsupportedKeys.join(", ")}`);
	const deferred = qualityGateObject(gate.deferredToBatch);
	if (!deferred) throw new Error("deferred qualityGate requires deferredToBatch object");
	requireAllowedRecordKeys(
		deferred,
		[
			"schemaVersion",
			"kind",
			"batchId",
			"memberIds",
			"finalGoalId",
			"metadataHash",
			"deferredLanes",
			"ranLanes",
			"targetedVerification",
			"aiSlopCleaner",
			"iteration",
			"changeSet",
		],
		"deferredToBatch",
	);
	if (deferred.kind !== "validation-batch-deferred")
		throw new Error("deferredToBatch.kind must be validation-batch-deferred");
	if (metadata) {
		requireValidationBatchTuple(metadata, deferred, "deferredToBatch");
		if (goal.id === metadata.finalGoalId)
			throw new Error("final validation batch goal cannot use deferredToBatch quality gate");
	}
	const deferredLanes = stringArray(deferred.deferredLanes)?.filter(Boolean).sort();
	if (deferredLanes?.join(",") !== "architectReview,executorQa")
		throw new Error(
			"deferredToBatch.deferredLanes must be architectReview and executorQa (or omitted; the runtime fills it)",
		);
	const targeted = qualityGateObject(deferred.targetedVerification);
	if (!targeted || targeted.status !== PASSED_STATUS || !nonEmptyStringArray(targeted.commands))
		throw new Error("deferredToBatch.targetedVerification must pass with non-empty commands");
	requireNonEmptyString(targeted.evidence, "deferredToBatch.targetedVerification.evidence");
	// The ai-slop-cleaner pass and a full verification rerun are no longer
	// mandatory per subgoal; they are boundary duties. When either is supplied it
	// must still be internally consistent and blocker-free.
	const cleaner = qualityGateObject(deferred.aiSlopCleaner);
	if (cleaner) {
		if (cleaner.status !== PASSED_STATUS) throw new Error("deferredToBatch.aiSlopCleaner must pass when present");
		requireNonEmptyString(cleaner.evidence, "deferredToBatch.aiSlopCleaner.evidence");
	}
	const iteration = qualityGateObject(deferred.iteration);
	if (iteration) {
		if (iteration.status !== PASSED_STATUS) throw new Error("deferredToBatch.iteration must pass when present");
		if (!nonEmptyStringArray(iteration.rerunCommands))
			throw new Error("deferredToBatch.iteration.rerunCommands must be non-empty");
		requireNonEmptyString(iteration.evidence, "deferredToBatch.iteration.evidence");
		requireEmptyBlockers(iteration.blockers, "deferredToBatch.iteration.blockers");
	}
	validateDeferredLaneDeclaration(deferred, "deferredToBatch");
	const declaredChangeSet = qualityGateObject(deferred.changeSet);
	if (!declaredChangeSet) throw new Error("deferredToBatch.changeSet is required");
	requireAllowedRecordKeys(
		declaredChangeSet,
		["memberGoalId", "cumulativeFromBase", "paths", "changeSetHash"],
		"deferredToBatch.changeSet",
	);
	if (declaredChangeSet.memberGoalId !== goal.id)
		throw new Error(
			`deferredToBatch.changeSet.memberGoalId must label the checkpointed goal ${goal.id} (or be omitted; the runtime fills it)`,
		);
	if (declaredChangeSet.cumulativeFromBase !== true)
		throw new Error("deferredToBatch.changeSet.cumulativeFromBase must be true (or omitted; the runtime fills it)");
	const paths = canonicalChangeSetRows(declaredChangeSet.paths, "deferredToBatch.changeSet.paths");
	requireChangeSetCoverage(changeSet, paths, "deferredToBatch.changeSet.paths");
	if (declaredChangeSet.changeSetHash !== changeSetHashForPaths(paths))
		throw new Error(
			"deferredToBatch.changeSet.changeSetHash does not match declared paths; omit changeSetHash and the runtime computes it",
		);
}
/** #4560: declared lane-selection proof shape on the quality gate. */
type DeclaredValidationLaneSelection = UltragoalValidationLaneSelection;

function readDeclaredValidationLaneSelection(gate: JsonObject): DeclaredValidationLaneSelection | undefined {
	const declared = qualityGateObject(gate.validationLaneSelection);
	if (!declared) return undefined;
	const riskClass = nonEmptyString(declared.riskClass);
	const reasons = stringArray(declared.reasons);
	const omittedLanes = stringArray(declared.omittedLanes);
	if (!riskClass || !reasons || !omittedLanes) {
		throw new Error(
			"validationLaneSelection must carry riskClass, reasons, and omittedLanes string arrays mirroring the runtime selection",
		);
	}
	if (riskClass !== "low" && riskClass !== "high")
		throw new Error('validationLaneSelection.riskClass must be "low" or "high"');
	if (omittedLanes.some(lane => !["cleaner", "architect", "qa", "terminal-critic"].includes(lane)))
		throw new Error("validationLaneSelection.omittedLanes contains an unsupported lane");
	return { riskClass, reasons, omittedLanes: omittedLanes as UltragoalValidationLane[] };
}

/**
 * #4560: validate a declared low-risk lane reduction against the
 * runtime-computed applicability. The runtime selection is authoritative: a
 * declaration that disagrees with the computed risk class, reasons, or
 * omitted-lane set fails closed and the full cohort stays mandatory.
 */
function validateDeclaredValidationLaneSelection(
	declared: DeclaredValidationLaneSelection,
	applicability: UltragoalValidationApplicability,
	found: QualityGateDiagnostics,
): boolean {
	if (declared.riskClass !== applicability.riskClass) {
		found.add(
			"validationLaneSelection",
			"selection_mismatch",
			"declared validationLaneSelection riskClass does not match the runtime-computed risk class",
		);
		return false;
	}
	const expected = validationLaneSelectionFor(applicability);
	if (
		declared.reasons.length !== expected.reasons.length ||
		declared.reasons.some((reason, index) => reason !== expected.reasons[index])
	) {
		found.add(
			"validationLaneSelection.reasons",
			"reasons_mismatch",
			"declared validationLaneSelection reasons must exactly mirror the runtime-computed selection basis",
		);
		return false;
	}
	const expectedOmitted = expected.omittedLanes;
	const declaredOmitted = new Set(declared.omittedLanes);
	if (declaredOmitted.has("qa")) {
		found.add(
			"validationLaneSelection",
			"qa_lane_mandatory",
			"validationLaneSelection can never omit the qa lane; verification is mandatory at every boundary",
		);
		return false;
	}
	if (declaredOmitted.size !== expectedOmitted.length || expectedOmitted.some(lane => !declaredOmitted.has(lane))) {
		found.add(
			"validationLaneSelection",
			"omitted_lanes_mismatch",
			"declared validationLaneSelection omittedLanes must exactly mirror the runtime-computed inapplicable lanes",
		);
		return false;
	}
	return applicability.riskClass === "low";
}

/** #4560: newest joined cohort (generation + frozen sourceHash) in the ledger. */
function latestJoinedCohortSourceHash(
	ledger: readonly UltragoalLedgerEvent[],
): { reviewGeneration: number; sourceHash: string } | undefined {
	let latest: { reviewGeneration: number; sourceHash: string } | undefined;
	for (const event of ledger) {
		if (event.event !== "goal_checkpointed" || event.status !== "complete") continue;
		const cohort = qualityGateObject(
			qualityGateObject(event.qualityGateJson)?.iteration as JsonObject | undefined,
		)?.reviewCohort;
		const record = qualityGateObject(cohort);
		if (!record) continue;
		const reviewGeneration = record.reviewGeneration;
		const sourceHash = nonEmptyString(record.sourceHash);
		if (typeof reviewGeneration !== "number" || !sourceHash) continue;
		if (!latest || reviewGeneration >= latest.reviewGeneration) latest = { reviewGeneration, sourceHash };
	}
	return latest;
}
const COHORT_LANE_KEYS = ["cleaner", "architect", "qa"] as const;

/**
 * Frozen-source-hash review cohort (#3473). One boundary generation runs at most one
 * cleaner, one architect, and one QA lane, every lane verdict is bound to the same
 * immutable source hash, and findings must be joined before any repair starts. Later
 * generations are delta-only. Cohort state rides the existing `iteration` gate key so
 * no new top-level quality-gate key is introduced.
 */
function validateReviewCohort(
	gate: JsonObject,
	iteration: JsonObject,
	options: { lowRiskReduced?: boolean } = {},
): void {
	const cohort = qualityGateObject(iteration.reviewCohort);
	if (!cohort) throw new Error("qualityGate iteration.reviewCohort is required at the review boundary");
	const generation = cohort.reviewGeneration;
	if (typeof generation !== "number" || !Number.isInteger(generation) || generation < 1)
		throw new Error("iteration.reviewCohort.reviewGeneration must be an integer >= 1");
	const sourceHash = nonEmptyString(cohort.sourceHash);
	if (!sourceHash) throw new Error("iteration.reviewCohort.sourceHash is required");
	if (cohort.joined !== true)
		throw new Error("iteration.reviewCohort.joined must be true: all lane findings must join before checkpoint");
	const lanes = qualityGateObject(cohort.lanes);
	if (!lanes) throw new Error("iteration.reviewCohort.lanes is required");
	const unsupportedLanes = Object.keys(lanes).filter(key => !(COHORT_LANE_KEYS as readonly string[]).includes(key));
	if (unsupportedLanes.length > 0)
		throw new Error(`iteration.reviewCohort.lanes contains unsupported lanes: ${unsupportedLanes.join(", ")}`);
	// #4560: on a runtime-selected low-risk single-goal boundary, cleaner and
	// architect may be omitted only through the deterministic
	// validationLaneSelection proof validated by the caller; the QA lane and
	// the frozen source hash stay mandatory, and cohort parallelism is
	// untouched whenever lanes do run.
	const requiredLanes: readonly (typeof COHORT_LANE_KEYS)[number][] = options.lowRiskReduced
		? COHORT_LANE_KEYS.filter(lane => lane === "qa")
		: [...COHORT_LANE_KEYS];
	for (const lane of requiredLanes) {
		if (Array.isArray(lanes[lane]))
			throw new Error(`iteration.reviewCohort.lanes.${lane} must be one lane per generation, not a list`);
		const record = qualityGateObject(lanes[lane]);
		if (!record) throw new Error(`iteration.reviewCohort.lanes.${lane} is required`);
		const laneHash = nonEmptyString(record.sourceHash);
		if (!laneHash) throw new Error(`iteration.reviewCohort.lanes.${lane}.sourceHash is required`);
		if (laneHash !== sourceHash)
			throw new Error(
				`iteration.reviewCohort.lanes.${lane}.sourceHash does not match the frozen cohort sourceHash: every lane must inspect the same immutable source`,
			);
		if (record.status !== "CLEAR" && record.status !== PASSED_STATUS)
			throw new Error(`iteration.reviewCohort.lanes.${lane}.status must be CLEAR or passed`);
		requireNonEmptyString(record.evidence, `iteration.reviewCohort.lanes.${lane}.evidence`);
		requireEmptyBlockers(record.blockers, `iteration.reviewCohort.lanes.${lane}.blockers`);
	}
	// Generation 1 is the full cohort review; every later generation exists only
	// because one consolidated blocker batch produced it, so its scope is the delta.
	if (generation > 1) {
		if (cohort.deltaOnly !== true)
			throw new Error("iteration.reviewCohort.deltaOnly must be true for reviewGeneration > 1");
		requireNonEmptyString(cohort.priorGenerationSourceHash, "iteration.reviewCohort.priorGenerationSourceHash");
		if (nonEmptyString(cohort.priorGenerationSourceHash) === sourceHash)
			throw new Error(
				"iteration.reviewCohort.priorGenerationSourceHash must differ from sourceHash: a new generation requires a new frozen source",
			);
		const deltaPaths = stringArray(cohort.deltaPaths)?.filter(path => path.length > 0);
		if (!deltaPaths || deltaPaths.length === 0)
			throw new Error("iteration.reviewCohort.deltaPaths must be non-empty for reviewGeneration > 1");
		const expansion = qualityGateObject(cohort.scopeExpansion);
		if (expansion) {
			requireNonEmptyString(expansion.severity, "iteration.reviewCohort.scopeExpansion.severity");
			requireNonEmptyString(expansion.novelty, "iteration.reviewCohort.scopeExpansion.novelty");
			requireNonEmptyString(expansion.justification, "iteration.reviewCohort.scopeExpansion.justification");
		}
	} else if (cohort.deltaOnly === true) {
		throw new Error("iteration.reviewCohort.deltaOnly cannot be true for the first reviewGeneration");
	}
	// The terminal critic is one verdict on the final joined generation, never a
	// per-lane or per-generation vote.
	const critic = qualityGateObject(gate.criticReview);
	if (critic) {
		const criticHash = nonEmptyString(critic.sourceHash);
		if (criticHash && criticHash !== sourceHash)
			throw new Error(
				"criticReview.sourceHash must match the final joined cohort sourceHash: the terminal critic runs once on the terminal generation",
			);
	}
}

async function validateCompletionQualityGate(
	cwd: string,
	gate: JsonObject,
	options: {
		changeSet?: UltragoalChangeSet;
		plan?: UltragoalPlan;
		goal?: UltragoalGoal;
		ledger?: readonly UltragoalLedgerEvent[];
	} = {},
): Promise<void> {
	const batchMode = options.goal?.validationBatch;
	const receiptKind =
		options.plan && options.goal && options.ledger
			? chooseReceiptKind(options.plan, options.ledger, options.goal, "complete")
			: undefined;
	const isFinalAggregate = receiptKind === "final-aggregate";
	// Every independent defect is collected instead of thrown, so one validate run
	// reports the whole list rather than forcing an edit/retry loop per field (#3474).
	const found = new QualityGateDiagnostics();
	if (batchMode && options.goal && options.goal.id !== batchMode.finalGoalId) {
		found.check("deferredToBatch", "deferred_gate_invalid", () => {
			validateDeferredCompletionQualityGate(gate, options.goal!, batchMode, options.changeSet);
		});
		found.throwIfAny();
		return;
	}
	// Boundary-by-default: in aggregate mode every checkpoint before the run's
	// final boundary may present the lightweight deferred gate, so heavyweight
	// architect/QA review runs once per boundary instead of once per story. The
	// boundary is derived from `chooseReceiptKind` rather than from synthesized
	// durable batch metadata, which would restale/deadlock on appended goals.
	if (!batchMode && options.goal && receiptKind === "per-goal" && qualityGateObject(gate.deferredToBatch)) {
		found.check("deferredToBatch", "deferred_gate_invalid", () => {
			validateDeferredCompletionQualityGate(gate, options.goal!, undefined, options.changeSet);
		});
		found.throwIfAny();
		return;
	}
	if (batchMode && options.goal && options.goal.id === batchMode.finalGoalId) {
		const allowedKeys = new Set([
			"architectReview",
			"executorQa",
			"iteration",
			"validationBatchClose",
			"validationLaneSelection",
			"criticReview",
		]);
		const unsupportedKeys = Object.keys(gate).filter(key => !allowedKeys.has(key));
		if (unsupportedKeys.length > 0)
			found.add(
				"qualityGate",
				"unsupported_keys",
				`qualityGate contains unsupported keys: ${unsupportedKeys.join(", ")}`,
			);
		if (!qualityGateObject(gate.validationBatchClose))
			found.add(
				"validationBatchClose",
				"missing_validation_batch_close",
				"final validation batch goal requires validationBatchClose",
			);
	}
	if (qualityGateObject(gate.codeReview)) {
		found.add(
			"codeReview",
			"legacy_code_review_gate",
			"checkpoint --status complete requires architect review approval through architectReview, executorQa, and iteration quality-gate evidence; legacy codeReview-only gates are not sufficient",
		);
	}
	const allowedKeys = new Set(
		batchMode
			? [
					"architectReview",
					"executorQa",
					"iteration",
					"validationBatchClose",
					"criticReview",
					"validationLaneSelection",
				]
			: ["architectReview", "executorQa", "iteration", "criticReview", "validationLaneSelection"],
	);
	const unsupportedKeys = Object.keys(gate).filter(key => !allowedKeys.has(key));
	if (unsupportedKeys.length > 0) {
		found.add(
			"qualityGate",
			"unsupported_keys",
			`qualityGate contains unsupported keys: ${unsupportedKeys.join(", ")}`,
		);
	}
	// #4560: deterministic risk/applicability selection for expensive boundary
	// lanes. The runtime — never free-form model prose — decides whether a
	// low-risk single-goal boundary may omit redundant review ceremony
	// (cleaner/architect/terminal-critic). QA/targeted verification and the
	// hash/receipt/join guarantees always remain mandatory. Anything risky or
	// unprovable keeps today's full heavyweight cohort unchanged. The current
	// frozen source under review is the gate's own cohort sourceHash.
	const gateIteration = qualityGateObject(gate.iteration);
	const gateCohortSourceHash = nonEmptyString(qualityGateObject(gateIteration?.reviewCohort)?.sourceHash);
	const authoritativeSourceHash = computeUltragoalReviewSourceHash(options.changeSet);
	if (gateCohortSourceHash && authoritativeSourceHash && gateCohortSourceHash !== authoritativeSourceHash) {
		found.add(
			"iteration.reviewCohort.sourceHash",
			"source_hash_mismatch",
			"iteration.reviewCohort.sourceHash must equal the runtime-computed digest of the authoritative current source basis",
		);
	}
	const applicability = resolveUltragoalValidationApplicability({
		changeSet: options.changeSet,
		requiredGoals: options.plan?.goals.filter(goal => goal.status !== "superseded").length,
		hasOpenReviewBlockers: options.plan?.goals.some(goal => goal.status === "review_blocked") ?? false,
		latestCohortSourceHash: options.ledger ? latestJoinedCohortSourceHash(options.ledger)?.sourceHash : undefined,
		currentSourceHash: gateCohortSourceHash ?? undefined,
		authoritativeSourceHash,
	});
	let laneSelection: DeclaredValidationLaneSelection | undefined;
	found.check("validationLaneSelection", "selection_invalid", () => {
		laneSelection = readDeclaredValidationLaneSelection(gate);
	});
	const lowRiskReduced =
		laneSelection !== undefined && validateDeclaredValidationLaneSelection(laneSelection, applicability, found);
	const architectReview = qualityGateObject(gate.architectReview);
	const executorQa = qualityGateObject(gate.executorQa);
	const iteration = qualityGateObject(gate.iteration);
	// #4560: when the runtime-verified selection omits the architect lane, the
	// boundary must not still demand architect evidence \u2014 otherwise the advertised
	// omission is unusable and the caller has to run or fabricate the lane anyway.
	// QA and iteration evidence stay mandatory in every case.
	const architectRequired = !lowRiskReduced || applicability.lanes.architect.applicable;
	if ((architectRequired && !architectReview) || !executorQa || !iteration) {
		found.add(
			"qualityGate",
			"missing_required_sections",
			architectRequired
				? "qualityGate requires architectReview, executorQa, and iteration objects"
				: "qualityGate requires executorQa and iteration objects",
		);
		found.throwIfAny();
		return;
	}
	if (isFinalAggregate) {
		if (
			options.ledger &&
			terminalCriticCeilingReached(options.ledger) &&
			!terminalCriticGateOverridden(options.ledger)
		) {
			found.add(
				"criticReview",
				"terminal_critic_ceiling",
				"checkpoint --status complete blocked: terminal-critic ceiling reached; requires human/leader gjc ultragoal record-critic-gate-override before completion",
			);
		}
		// #4560: terminal-critic proportionality. The critic verdict is
		// mandatory on multi-goal/boundary, high-risk, or evidence-uncertain
		// runs. A single-goal low-risk run whose joined cohort is clean and
		// whose immutable source basis is unchanged may satisfy the terminus
		// through the runtime-verified validationLaneSelection proof instead
		// of duplicating the already-joined review with another read pass.
		const criticReview = qualityGateObject(gate.criticReview);
		const criticProportionallySatisfied =
			lowRiskReduced && applicability.basisUnchanged && !applicability.hasOpenReviewBlockers;
		if (criticReview?.verdict !== "OKAY" && !criticProportionallySatisfied) {
			found.add(
				"criticReview.verdict",
				"critic_verdict_not_okay",
				"checkpoint --status complete (final aggregate) requires criticReview with verdict OKAY, non-empty evidence, and empty blockers",
			);
		}
		if (criticReview) {
			found.check("criticReview.evidence", "missing_evidence", () =>
				requireNonEmptyString(criticReview.evidence, "criticReview.evidence"),
			);
			found.check("criticReview.blockers", "non_empty_blockers", () =>
				requireEmptyBlockers(criticReview.blockers, "criticReview.blockers"),
			);
		}
	}
	if (architectReview) {
		if (
			architectReview.architectureStatus !== CLEAN_ARCHITECT_STATUS ||
			architectReview.productStatus !== CLEAN_ARCHITECT_STATUS ||
			architectReview.codeStatus !== CLEAN_ARCHITECT_STATUS ||
			architectReview.recommendation !== APPROVE_RECOMMENDATION
		) {
			found.add(
				"architectReview",
				"architect_not_clear",
				"checkpoint --status complete requires architect review approval: architectReview architecture/product/code must be CLEAR and recommendation must be APPROVE",
			);
		}
		if (!nonEmptyStringArray(architectReview.commands)) {
			found.add(
				"architectReview.commands",
				"missing_command_array",
				"qualityGate architectReview.commands must be a non-empty string array",
			);
		}
		found.check("architectReview.evidence", "missing_evidence", () =>
			requireNonEmptyString(architectReview.evidence, "architectReview.evidence"),
		);
		found.check("architectReview.blockers", "non_empty_blockers", () =>
			requireEmptyBlockers(architectReview.blockers, "architectReview.blockers"),
		);
	}
	if (
		executorQa.status !== PASSED_STATUS ||
		executorQa.e2eStatus !== PASSED_STATUS ||
		executorQa.redTeamStatus !== PASSED_STATUS
	) {
		found.add(
			"executorQa",
			"executor_qa_not_passed",
			"qualityGate executorQa status, e2eStatus, and redTeamStatus must be passed",
		);
	}
	if (!nonEmptyStringArray(executorQa.e2eCommands) || !nonEmptyStringArray(executorQa.redTeamCommands)) {
		found.add(
			"executorQa.e2eCommands",
			"missing_command_array",
			"qualityGate executorQa e2eCommands and redTeamCommands must be non-empty string arrays",
		);
	}
	found.check("executorQa.evidence", "missing_evidence", () =>
		requireNonEmptyString(executorQa.evidence, "executorQa.evidence"),
	);
	found.check("executorQa.blockers", "non_empty_blockers", () =>
		requireEmptyBlockers(executorQa.blockers, "executorQa.blockers"),
	);
	await found.checkAsync("executorQa", "executor_qa_evidence_invalid", () =>
		validateExecutorQaRedTeamEvidence(cwd, executorQa, { changeSet: options.changeSet }),
	);
	if (iteration.status !== PASSED_STATUS || iteration.fullRerun !== true) {
		found.add("iteration", "iteration_not_passed", "qualityGate iteration must be passed with fullRerun true");
	}
	if (!nonEmptyStringArray(iteration.rerunCommands)) {
		found.add(
			"iteration.rerunCommands",
			"missing_command_array",
			"qualityGate iteration.rerunCommands must be a non-empty string array",
		);
	}
	found.check("iteration.evidence", "missing_evidence", () =>
		requireNonEmptyString(iteration.evidence, "iteration.evidence"),
	);
	found.check("iteration.blockers", "non_empty_blockers", () =>
		requireEmptyBlockers(iteration.blockers, "iteration.blockers"),
	);
	found.check("iteration.reviewCohort", "review_cohort_invalid", () =>
		validateReviewCohort(gate, iteration, { lowRiskReduced }),
	);
	if (batchMode && options.goal && options.plan && options.ledger) {
		found.check("validationBatchClose", "batch_close_invalid", () =>
			validateBatchCloseQualityGate(gate, options.plan!, batchMode, options.ledger!, options.changeSet),
		);
	}
	found.throwIfAny();
}

function validateBatchCloseQualityGate(
	gate: JsonObject,
	plan: UltragoalPlan,
	metadata: UltragoalValidationBatchMetadata,
	ledger: readonly UltragoalLedgerEvent[],
	changeSet?: UltragoalChangeSet,
): void {
	const close = qualityGateObject(gate.validationBatchClose);
	if (!close) throw new Error("validationBatchClose is required");
	requireAllowedRecordKeys(
		close,
		[
			"schemaVersion",
			"kind",
			"batchId",
			"finalGoalId",
			"memberIds",
			"memberMetadataHashes",
			"memberReceipts",
			"unionChangeSet",
			"coverageEvidence",
		],
		"validationBatchClose",
	);
	if (close.schemaVersion !== 1 || close.kind !== "validation-batch-close")
		throw new Error("validationBatchClose.kind must be validation-batch-close");
	if (close.batchId !== metadata.batchId || close.finalGoalId !== metadata.finalGoalId)
		throw new Error("validationBatchClose tuple must match durable validationBatch");
	const memberIds = stringArray(close.memberIds);
	if (
		!memberIds ||
		memberIds.length !== metadata.memberIds.length ||
		memberIds.some((id, index) => id !== metadata.memberIds[index])
	)
		throw new Error("validationBatchClose.memberIds must match durable validationBatch order");
	const memberMetadataHashes = qualityGateObject(close.memberMetadataHashes);
	const memberChangeSetHashes = qualityGateObject(qualityGateObject(close.unionChangeSet)?.memberChangeSetHashes);
	if (!memberMetadataHashes || !memberChangeSetHashes)
		throw new Error("validationBatchClose member metadata and change-set hashes are required");
	const seenReceipts = new Set<string>();
	const receiptRows = Array.isArray(close.memberReceipts) ? close.memberReceipts : [];
	const nonFinalIds = metadata.memberIds.filter(memberId => memberId !== metadata.finalGoalId);
	for (const memberId of metadata.memberIds) {
		const member = plan.goals.find(item => item.id === memberId);
		if (!member?.validationBatch) throw new Error(`validationBatchClose references missing batch member ${memberId}`);
		if (member.validationBatch.metadataHash !== memberMetadataHashes[memberId])
			throw new Error(`validationBatchClose.memberMetadataHashes.${memberId} does not match durable metadata`);
		if (memberId !== metadata.finalGoalId && member.status !== "complete")
			throw new Error(`validationBatchClose cannot close before ${memberId} is complete`);
	}
	requireExactRecordKeys(memberMetadataHashes, metadata.memberIds, "validationBatchClose.memberMetadataHashes");
	requireExactRecordKeys(
		memberChangeSetHashes,
		metadata.memberIds,
		"validationBatchClose.unionChangeSet.memberChangeSetHashes",
	);
	if (receiptRows.length !== nonFinalIds.length)
		throw new Error("validationBatchClose.memberReceipts must list every non-final member exactly once");
	for (const row of receiptRows) {
		if (typeof row !== "object" || row === null || Array.isArray(row))
			throw new Error("validationBatchClose.memberReceipts rows must be objects");
		const record = row as JsonObject;
		const memberId = nonEmptyString(record.goalId);
		if (!memberId || !nonFinalIds.includes(memberId))
			throw new Error("validationBatchClose.memberReceipts contains invalid member goalId");
		requireAllowedRecordKeys(
			record,
			["goalId", "receiptId", "checkpointLedgerEventId", "qualityGateHash", "changeSetHash", "role"],
			`validationBatchClose.memberReceipts.${memberId}`,
		);
		if (seenReceipts.has(memberId))
			throw new Error(`validationBatchClose.memberReceipts contains duplicate member ${memberId}`);
		seenReceipts.add(memberId);
		const member = plan.goals.find(item => item.id === memberId)!;
		const receipt = requireDeferredMemberReceiptFresh(plan, ledger, member, "validationBatchClose.memberReceipts");
		if (
			record.role !== "deferred-member" ||
			record.receiptId !== receipt.receiptId ||
			record.qualityGateHash !== receipt.qualityGateHash ||
			record.changeSetHash !== receipt.validationBatch.changeSetHash ||
			record.checkpointLedgerEventId !== receipt.checkpointLedgerEventId
		) {
			throw new Error(`validationBatchClose.memberReceipts.${memberId} does not match deferred receipt`);
		}
		if (memberChangeSetHashes[memberId] !== receipt.validationBatch.changeSetHash)
			throw new Error(
				`validationBatchClose.unionChangeSet.memberChangeSetHashes.${memberId} does not match deferred receipt`,
			);
	}
	if (seenReceipts.size !== nonFinalIds.length)
		throw new Error("validationBatchClose.memberReceipts is missing a non-final member");
	const union = qualityGateObject(close.unionChangeSet);
	if (union?.source !== "validation-batch")
		throw new Error("validationBatchClose.unionChangeSet.source must be validation-batch");
	requireAllowedRecordKeys(
		union,
		["source", "memberChangeSetHashes", "paths", "unionHash"],
		"validationBatchClose.unionChangeSet",
	);
	const unionPaths = canonicalChangeSetRows(union.paths, "validationBatchClose.unionChangeSet.paths");
	requireChangeSetCoverage(changeSet, unionPaths, "validationBatchClose.unionChangeSet.paths");
	const finalHash = changeSetHashForPaths(unionPaths);
	if (memberChangeSetHashes[metadata.finalGoalId] !== finalHash)
		throw new Error(
			"validationBatchClose.unionChangeSet.memberChangeSetHashes final member hash does not match current change set",
		);
	if (
		union.unionHash !==
		hashStructuredValue({
			memberChangeSetHashes,
			paths: unionPaths.map(row => ({ path: row.path, status: row.status, oldPath: row.oldPath })),
		})
	)
		throw new Error("validationBatchClose.unionChangeSet.unionHash does not match declared union");
	requireNonEmptyString(close.coverageEvidence, "validationBatchClose.coverageEvidence");
}

function hydrateReviewedBatchReplacementClose(input: {
	gate: JsonObject;
	plan: UltragoalPlan;
	goal: UltragoalGoal;
	metadata: UltragoalValidationBatchMetadata;
	ledger: readonly UltragoalLedgerEvent[];
	changeSet?: UltragoalChangeSet;
}): JsonObject {
	const requested = qualityGateObject(input.gate.validationBatchClose);
	if (requested?.kind !== "review-blocker-replacement-close") return input.gate;
	const expectedKeys = new Set(["schemaVersion", "kind", "replacementGoalId", "coverageEvidence"]);
	if (Object.keys(requested).some(key => !expectedKeys.has(key)))
		throw new Error("review-blocker replacement close contains unsupported fields");
	const replacementGoalId = nonEmptyString(requested.replacementGoalId);
	const coverageEvidence = nonEmptyString(requested.coverageEvidence);
	if (requested.schemaVersion !== 1 || !replacementGoalId || !coverageEvidence)
		throw new Error("review-blocker replacement close is malformed");
	if (input.goal.status !== "active" || input.metadata.finalGoalId !== input.goal.id)
		throw new Error("review-blocker replacement close requires the active durable validation-batch final goal");
	if (!input.changeSet) throw new Error("review-blocker replacement close requires a current cumulative change set");

	const replacements = input.plan.goals.filter(
		goal => goal.steering?.kind === "review_blocker" && goal.steering.blockedGoalId === input.goal.id,
	);
	if (replacements.length !== 1 || replacements[0]?.id !== replacementGoalId)
		throw new Error("review-blocker replacement close requires exactly the declared replacement");
	const replacement = replacements[0]!;
	const replacementReceipt = replacement.completionVerification;
	if (replacement.status !== "complete" || replacementReceipt?.receiptKind !== "per-goal")
		throw new Error("review-blocker replacement close requires a completed per-goal replacement receipt");
	const replacementDiagnostic = validateReceiptFreshBase({
		plan: input.plan,
		ledger: input.ledger,
		goal: replacement,
		receipt: replacementReceipt,
		receiptKind: "per-goal",
	});
	if (replacementDiagnostic) throw new Error(`review-blocker replacement close ${replacementDiagnostic.message}`);
	const replacementCheckpointIndex = input.ledger.findIndex(
		event => event.eventId === replacementReceipt.checkpointLedgerEventId,
	);
	const reviewRecordedIndex = input.ledger.findIndex(
		event =>
			event.event === "review_blockers_recorded" &&
			event.goalId === input.goal.id &&
			event.blockerGoalId === replacement.id,
	);
	const reactivatedIndex = input.ledger.findIndex(
		(event, index) =>
			index > replacementCheckpointIndex &&
			event.event === "goal_checkpointed" &&
			event.goalId === input.goal.id &&
			event.status === "active",
	);
	if (reviewRecordedIndex < 0 || reviewRecordedIndex >= replacementCheckpointIndex || reactivatedIndex < 0)
		throw new Error("review-blocker replacement close lacks durable supersession and reopening evidence");

	const historicalRequiredGoalIds = input.plan.goals
		.filter(goal => goal.id !== input.goal.id && goal.status !== "superseded")
		.map(goal => goal.id);
	const aggregateGoals = input.plan.goals.filter(goal => {
		const receipt = goal.completionVerification;
		return goal.status === "complete" && receipt?.receiptKind === "final-aggregate";
	});
	const aggregateGoal = aggregateGoals.find(goal => {
		const receipt = goal.completionVerification!;
		const event = findLedgerReceiptEvent(input.ledger, receipt);
		const eventReceipt = event?.completionVerification as UltragoalCompletionVerification | undefined;
		return (
			event !== null &&
			eventReceipt !== undefined &&
			hashStructuredValue(eventReceipt) === hashStructuredValue(receipt) &&
			hashStructuredValue(event.qualityGateJson) === receipt.qualityGateHash &&
			goal.updatedAt === receipt.verifiedAt &&
			receipt.basis.relevantGoalIdsBeforeCheckpoint.length === historicalRequiredGoalIds.length &&
			receipt.basis.relevantGoalIdsBeforeCheckpoint.every(
				(goalId, index) => goalId === historicalRequiredGoalIds[index],
			)
		);
	});
	if (!aggregateGoal)
		throw new Error(
			"review-blocker replacement close requires a fresh final-aggregate receipt covering required goals",
		);

	const memberMetadataHashes: Record<string, string> = {};
	const memberChangeSetHashes: Record<string, string> = {};
	const memberReceipts: JsonObject[] = [];
	for (const memberId of input.metadata.memberIds) {
		const member = input.plan.goals.find(goal => goal.id === memberId);
		if (!member?.validationBatch)
			throw new Error(`review-blocker replacement close references missing batch member ${memberId}`);
		memberMetadataHashes[memberId] = member.validationBatch.metadataHash;
		if (memberId === input.goal.id) continue;
		const receipt = requireDeferredMemberReceiptFresh(
			input.plan,
			input.ledger,
			member,
			"review-blocker replacement close",
		);
		memberChangeSetHashes[memberId] = receipt.validationBatch.changeSetHash;
		memberReceipts.push({
			goalId: memberId,
			receiptId: receipt.receiptId,
			checkpointLedgerEventId: receipt.checkpointLedgerEventId,
			qualityGateHash: receipt.qualityGateHash,
			changeSetHash: receipt.validationBatch.changeSetHash,
			role: "deferred-member",
		});
	}
	const paths = input.changeSet.paths.map(row => ({
		path: row.path,
		status: row.status,
		...(row.oldPath ? { oldPath: row.oldPath } : {}),
	}));
	memberChangeSetHashes[input.goal.id] = changeSetHashForPaths(paths);
	const unionHash = hashStructuredValue({
		memberChangeSetHashes,
		paths: paths.map(row => ({ path: row.path, status: row.status, oldPath: row.oldPath })),
	});
	return {
		...input.gate,
		validationBatchClose: {
			schemaVersion: 1,
			kind: "validation-batch-close",
			batchId: input.metadata.batchId,
			finalGoalId: input.metadata.finalGoalId,
			memberIds: [...input.metadata.memberIds],
			memberMetadataHashes,
			memberReceipts,
			unionChangeSet: {
				source: "validation-batch",
				memberChangeSetHashes,
				paths,
				unionHash,
			},
			coverageEvidence,
		},
	};
}
/**
 * Scaffold a schema-shaped quality-gate template for selected surfaces (#3474).
 * The template is intentionally incomplete for live artifact proofs so `quality-gate
 * validate` can report remaining evidence gaps in one pass after the author fills paths.
 */
export function buildQualityGateInitTemplate(surfaces: readonly string[]): JsonObject {
	const normalized = surfaces.length > 0 ? surfaces.map(surface => surface.trim()).filter(Boolean) : ["web"];
	const unique: string[] = [];
	for (const surface of normalized) {
		if (!unique.includes(surface)) unique.push(surface);
	}

	const artifactRefs: JsonObject[] = [
		{
			id: "adversarial-report",
			kind: "failure-mode-test",
			path: "artifacts/adversarial-report.txt",
			description: "Adversarial boundary and failure-mode test output",
			inlineEvidence:
				"Adversarial boundary cases exercised invalid input, missing state, and repeated submission without violating the contract.",
		},
	];
	const surfaceEvidence: JsonObject[] = [];
	const contractCoverage: JsonObject[] = [];
	const adversarialCases: JsonObject[] = [
		{
			id: "case-invalid-input",
			contractRef: "approved-plan:goal",
			scenario: "Submit invalid or boundary input through the user-facing surface",
			expectedBehavior: "The implementation rejects or handles the case according to the approved contract",
			verdict: "passed",
			artifactRefs: ["adversarial-report"],
		},
	];

	unique.forEach((surface, index) => {
		const surfaceId = `surface-${index + 1}`;
		const family = surface.toLowerCase();
		const linked: string[] = [];
		if (family.includes("web") || family.includes("gui")) {
			const browserId = `browser-run-${index + 1}`;
			const shotId = `gui-screenshot-${index + 1}`;
			linked.push(browserId, shotId);
			artifactRefs.push(
				{
					id: browserId,
					kind: "browser-automation",
					path: `artifacts/${browserId}.json`,
					description: "Browser automation transcript for the approved user-facing flow",
					inlineEvidence:
						"Browser automation executed the approved flow, asserted the expected visible result, and captured the final DOM state.",
				},
				{
					id: shotId,
					kind: "screenshot",
					path: `artifacts/${shotId}.png`,
					description: "Screenshot evidence for the GUI/web surface verdict",
					inlineEvidence:
						"Screenshot review confirmed the approved screen state, including the success message and absence of regression indicators.",
				},
			);
		} else if (family.includes("cli")) {
			const replayId = `cli-replay-${index + 1}`;
			linked.push(replayId);
			artifactRefs.push({
				id: replayId,
				kind: "cli-replay",
				path: `artifacts/${replayId}.json`,
				description: "CLI argv replay transcript for the approved command surface",
				inlineEvidence:
					"CLI replay executed the allowlisted command and verified recorded stdout against the approved contract.",
			});
		} else if (family.includes("api") || family.includes("package")) {
			const reportId = `api-report-${index + 1}`;
			linked.push(reportId);
			artifactRefs.push({
				id: reportId,
				kind: "test-report",
				path: `artifacts/${reportId}.xml`,
				description: "API/package black-box test report",
				inlineEvidence:
					"API/package suite covered happy path, auth failure, and contract-breaking payloads with non-empty report output.",
			});
		} else {
			const evidenceId = `surface-evidence-${index + 1}`;
			linked.push(evidenceId);
			artifactRefs.push({
				id: evidenceId,
				kind: "transcript",
				path: `artifacts/${evidenceId}.txt`,
				description: `Evidence transcript for surface ${surface}`,
				inlineEvidence: `Surface ${surface} was exercised against the approved contract with recorded transcript evidence.`,
			});
		}

		surfaceEvidence.push({
			id: surfaceId,
			surface: family.includes("web") || family.includes("gui") ? "gui/web" : surface,
			contractRef: "approved-plan:goal",
			invocation: `Exercise surface ${surface} against the approved contract`,
			verdict: "passed",
			artifactRefs: linked,
		});
		contractCoverage.push({
			id: `contract-${index + 1}`,
			contractRef: "approved-plan:goal",
			obligation: `The completed story satisfies the approved contract on surface ${surface}`,
			status: "covered",
			surfaceEvidenceRefs: [surfaceId],
			adversarialCaseRefs: ["case-invalid-input"],
		});
	});

	return {
		architectReview: {
			architectureStatus: "CLEAR",
			productStatus: "CLEAR",
			codeStatus: "CLEAR",
			recommendation: "APPROVE",
			evidence: "architect reviewed architecture, product behavior, and code changes",
			commands: ["architect-review"],
			blockers: [],
		},
		executorQa: {
			status: "passed",
			e2eStatus: "passed",
			redTeamStatus: "passed",
			evidence: "executor built and ran e2e plus red-team QA suite",
			e2eCommands: ["bun test:e2e"],
			redTeamCommands: ["bun test:red-team"],
			artifactRefs,
			contractCoverage,
			surfaceEvidence,
			adversarialCases,
			blockers: [],
		},
		criticReview: {
			verdict: "OKAY",
			evidence: "critic approved final aggregate",
			blockers: [],
		},
		iteration: {
			status: "passed",
			evidence: "no verification findings remain after steering iterations",
			fullRerun: true,
			reviewCohort: {
				reviewGeneration: 1,
				sourceHash: "sha256:replace-with-frozen-source-hash",
				joined: true,
				lanes: {
					cleaner: {
						status: "passed",
						sourceHash: "sha256:replace-with-frozen-source-hash",
						evidence: "cleaner clean",
						blockers: [],
					},
					architect: {
						status: "CLEAR",
						sourceHash: "sha256:replace-with-frozen-source-hash",
						evidence: "architect clear",
						blockers: [],
					},
					qa: {
						status: "passed",
						sourceHash: "sha256:replace-with-frozen-source-hash",
						evidence: "qa passed",
						blockers: [],
					},
				},
			},
			rerunCommands: ["bun test:e2e", "bun test:red-team"],
			blockers: [],
		},
	};
}

/**
 * Read-only quality-gate validation (#3474). Applies exactly the same rules as
 * `checkpoint --status complete` — including deferred-vs-boundary gate selection and
 * artifact existence checks — but never touches `goals.json`, `ledger.jsonl`, or goal
 * state, and reports every diagnostic in one run instead of the first failure.
 */
export async function validateUltragoalQualityGateReadOnly(input: {
	cwd: string;
	qualityGateJson: string;
	goalId?: string;
	sessionId?: string | null;
}): Promise<{ valid: boolean; errors: readonly UltragoalQualityGateDiagnostic[] }> {
	const sessionId = input.sessionId?.trim() || currentUltragoalSessionId(input.cwd);
	const plan = await readUltragoalPlan(input.cwd, sessionId);
	const goal = input.goalId
		? plan?.goals.find(item => item.id === input.goalId)
		: plan?.goals.find(item => SCHEDULABLE_STATUSES.has(item.status));
	if (input.goalId && !goal) {
		return {
			valid: false,
			errors: [{ path: "goalId", code: "unknown_goal", message: `Unknown ultragoal goal ${input.goalId}` }],
		};
	}
	const gate = qualityGateObject(await readStructuredValue(input.cwd, input.qualityGateJson));
	if (!gate) {
		return {
			valid: false,
			errors: [{ path: "qualityGate", code: "not_an_object", message: "qualityGate must be a JSON object" }],
		};
	}
	const ledger = plan ? await readUltragoalLedger(input.cwd, sessionId) : undefined;
	const changeSet = await computeCheckpointChangeSet(input.cwd);
	try {
		const validationBatch = goal ? requireFreshValidationBatchMetadata(goal) : undefined;
		let hydratedGate =
			validationBatch && plan && goal && ledger
				? hydrateReviewedBatchReplacementClose({
						gate,
						plan,
						goal,
						metadata: validationBatch,
						ledger,
						changeSet,
					})
				: gate;
		if (goal) hydratedGate = hydrateDeferredGateDefaults(hydratedGate, goal, changeSet);
		if (goal && plan && ledger) {
			hydratedGate = hydrateBatchCloseDefaults({ gate: hydratedGate, plan, goal, ledger, changeSet });
		}
		await validateCompletionQualityGate(input.cwd, hydratedGate, {
			changeSet,
			plan: plan ?? undefined,
			goal,
			ledger,
		});
		return { valid: true, errors: [] };
	} catch (error) {
		if (error instanceof UltragoalQualityGateError) return { valid: false, errors: error.diagnostics };
		return {
			valid: false,
			errors: [
				{
					path: "qualityGate",
					code: "validation_failed",
					message: error instanceof Error ? error.message : String(error),
				},
			],
		};
	}
}

async function readRequiredCompletionQualityGate(
	cwd: string,
	value: string | undefined,
	options: {
		changeSet?: UltragoalChangeSet;
		plan?: UltragoalPlan;
		goal?: UltragoalGoal;
		ledger?: readonly UltragoalLedgerEvent[];
	} = {},
): Promise<unknown> {
	if (!value?.trim()) {
		throw new Error(
			"complete checkpoints require --quality-gate-json with architectReview, executorQa, and iteration evidence",
		);
	}
	const gate = await readStructuredValue(cwd, value);
	const gateObject = qualityGateObject(gate);
	if (!gateObject) throw new Error("qualityGate must be a JSON object");
	const validationBatch = options.goal ? requireFreshValidationBatchMetadata(options.goal) : undefined;
	const hydratedGate =
		validationBatch && options.plan && options.goal && options.ledger
			? hydrateReviewedBatchReplacementClose({
					gate: gateObject,
					plan: options.plan,
					goal: options.goal,
					metadata: validationBatch,
					ledger: options.ledger,
					changeSet: options.changeSet,
				})
			: gateObject;
	let completionGate = options.goal
		? hydrateDeferredGateDefaults(hydratedGate, options.goal, options.changeSet)
		: hydratedGate;
	if (options.goal && options.plan && options.ledger) {
		completionGate = hydrateBatchCloseDefaults({
			gate: completionGate,
			plan: options.plan,
			goal: options.goal,
			ledger: options.ledger,
			changeSet: options.changeSet,
		});
	}
	await validateCompletionQualityGate(cwd, completionGate, {
		changeSet: options.changeSet,
		plan: options.plan,
		goal: options.goal,
		ledger: options.ledger,
	});
	return completionGate;
}

function validateCompleteCheckpointTargetGoal(goal: UltragoalGoal): void {
	if (COMPLETE_CHECKPOINT_ALLOWED_PRE_STATUSES.has(goal.status)) return;
	if (goal.status === "pending") {
		throw new Error(
			`Cannot checkpoint ${goal.id} as complete while its durable goals.json status is pending; start the goal before completing it.`,
		);
	}
	if (goal.status === "complete") {
		throw new Error(
			`Cannot checkpoint ${goal.id} as complete with different evidence because its durable goals.json status is already complete.`,
		);
	}
	if (goal.status === "superseded") {
		throw new Error(`Cannot checkpoint ${goal.id} as complete because its durable goals.json status is superseded.`);
	}
	throw new Error(
		`Cannot checkpoint ${goal.id} as complete while its durable goals.json status is ${goal.status}; only active or retryable failed goals can be completed.`,
	);
}

export async function checkpointUltragoalGoal(input: {
	cwd: string;
	goalId: string;
	status: UltragoalGoalStatus;
	evidence: string;
	qualityGateJson?: string;
}): Promise<UltragoalPlan> {
	const plan = await readUltragoalPlan(input.cwd);
	if (!plan) throw new Error("No ultragoal plan found. Run `gjc ultragoal create-goals --brief ...` first.");
	const goal = plan.goals.find(item => item.id === input.goalId);
	if (!goal) throw new Error(`No ultragoal goal found for ${input.goalId}.`);
	const evidence = input.evidence.trim();
	if (!evidence) throw new Error("checkpoint evidence is required");
	const ledgerBefore = await readUltragoalLedger(input.cwd);
	const matchingIdempotentEvents = ledgerBefore.filter(
		event =>
			event.event === "goal_checkpointed" &&
			event.goalId === goal.id &&
			event.status === input.status &&
			event.evidence === evidence,
	);
	// Re-verification replays legitimately append repeated same-status,
	// same-evidence checkpoint events for one goal. The recorded receipt must
	// be compared against ITS OWN checkpoint event — resolved by the receipt's
	// checkpointLedgerEventId, falling back to the latest match — never the
	// oldest duplicate, which would wrongly report the current receipt stale.
	const matchingIdempotentEvent =
		matchingIdempotentEvents.find(event => event.eventId === goal.completionVerification?.checkpointLedgerEventId) ??
		matchingIdempotentEvents.at(-1);
	const batchMetadata = input.status === "complete" ? requireFreshValidationBatchMetadata(goal) : undefined;
	if (batchMetadata && goal.completionVerification?.validationBatch) {
		const receiptBatch = goal.completionVerification.validationBatch;
		if (receiptBatch.role === "deferred-member" && receiptBatch.metadataHash !== batchMetadata.metadataHash) {
			throw new Error(`Goal ${goal.id} has stale validation batch completion receipt for ${batchMetadata.batchId}`);
		}
		if (
			receiptBatch.role === "batch-close" &&
			receiptBatch.memberMetadataHashes[goal.id] !== batchMetadata.metadataHash
		) {
			throw new Error(`Goal ${goal.id} has stale validation batch close receipt for ${batchMetadata.batchId}`);
		}
	}
	if (input.status === "complete" && goal.completionVerification?.validationBatch && !batchMetadata) {
		throw new Error(`Goal ${goal.id} has stale validation batch completion receipt`);
	}
	// An identical-evidence complete replay is only a no-op while the recorded
	// receipt still validates fresh. When the goal row itself is untouched
	// (updatedAt still matches the receipt's verifiedAt) but later goal-tagged
	// ledger events (e.g. blocker classifications) or plan growth staled the
	// receipt, the replay is a genuine re-verification: it must run the full
	// quality gate and mint a fresh receipt, otherwise a completed goal with a
	// context-staled receipt can never be repaired (different evidence is
	// rejected on complete goals by design). A final-aggregate receipt whose
	// recorded checkpoint gate lacks a clean criticReview OKAY is likewise
	// repair-eligible: it is not "stale", but the completion guard rejects it
	// forever (active_missing_critic_verdict), so a no-op replay would leave
	// the run permanently unable to complete even after the terminal critic
	// records OKAY. A mutated goal row keeps the fail-loud tamper handling in
	// the idempotent branch below.
	const staleCompleteReceiptReplay =
		input.status === "complete" &&
		goal.status === "complete" &&
		goal.evidence === evidence &&
		Boolean(matchingIdempotentEvent) &&
		(!goal.completionVerification ||
			(goal.completionVerification.verifiedAt === goal.updatedAt &&
				(validateReceiptFreshBase({
					plan,
					ledger: ledgerBefore,
					goal,
					receipt: goal.completionVerification,
					receiptKind: goal.completionVerification.receiptKind,
				}) !== null ||
					finalAggregateReceiptMissingCriticOkay(ledgerBefore, goal.completionVerification))));
	if (
		goal.status === input.status &&
		goal.evidence === evidence &&
		matchingIdempotentEvent &&
		!staleCompleteReceiptReplay
	) {
		if (batchMetadata) {
			const receipt = goal.completionVerification;
			const receiptBatch = receipt?.validationBatch;
			if (!receipt || !receiptBatch)
				throw new Error(
					`Goal ${goal.id} has validation batch ${batchMetadata.batchId} but no matching completion receipt`,
				);
			if (receipt.checkpointLedgerEventId !== matchingIdempotentEvent.eventId)
				throw new Error(`Goal ${goal.id} validation batch receipt does not match prior checkpoint event`);
			if (hashStructuredValue(matchingIdempotentEvent.qualityGateJson) !== receipt.qualityGateHash)
				throw new Error(`Goal ${goal.id} validation batch receipt quality gate is stale`);
			if (receiptBatch.role === "deferred-member" && receiptBatch.metadataHash !== batchMetadata.metadataHash)
				throw new Error(`Goal ${goal.id} has stale validation batch metadata hash in deferred receipt`);
			if (receiptBatch.role === "batch-close")
				requireFreshBatchCloseReceiptBasis(plan, ledgerBefore, goal, receipt, matchingIdempotentEvent);
			if (
				receiptBatch.role === "batch-close" &&
				receiptBatch.memberMetadataHashes[goal.id] !== batchMetadata.metadataHash
			)
				throw new Error(`Goal ${goal.id} has stale validation batch metadata hash in close receipt`);
		}
		// A complete goal whose row changed after its receipt was verified is
		// neither a clean no-op nor a repairable context-stale replay: fail loud
		// instead of silently laundering a tampered/inconsistent durable row.
		if (
			input.status === "complete" &&
			goal.completionVerification &&
			goal.completionVerification.verifiedAt !== goal.updatedAt
		) {
			throw new Error(
				`Goal ${goal.id} changed after its completion receipt was verified; refusing idempotent replay. Investigate the durable goals.json row before re-checkpointing.`,
			);
		}
		// Idempotent re-checkpoint: this goal is already recorded in the target status with the same
		// evidence, so skip the plan rewrite and ledger append to avoid duplicate goal_checkpointed
		// events. The ledger is the dedup source of truth because it is exactly what a duplicate write
		// would corrupt (mirrors the ralplan #638 guard). Requiring a matching ledger row means an
		// interrupted prior write (plan persisted, ledger append lost) still re-appends the event
		// instead of silently dropping it.
		return plan;
	}
	const changeSet = input.status === "complete" ? await computeCheckpointChangeSet(input.cwd) : undefined;
	if (input.status === "complete" && !staleCompleteReceiptReplay) {
		validateCompleteCheckpointTargetGoal(goal);
	}
	const qualityGateJson =
		input.status === "complete"
			? await readRequiredCompletionQualityGate(input.cwd, input.qualityGateJson, {
					changeSet,
					plan,
					goal,
					ledger: ledgerBefore,
				})
			: input.qualityGateJson
				? await readStructuredValue(input.cwd, input.qualityGateJson)
				: undefined;
	if (input.status === "complete" && !staleCompleteReceiptReplay) {
		// Validation consumes an asynchronous source snapshot. Re-capture directly
		// after it returns and require the authoritative digest to remain identical;
		// otherwise a concurrent edit could be committed against bytes that were not
		// the reviewed basis.
		const finalChangeSet = await computeCheckpointChangeSet(input.cwd);
		const initialSourceHash = computeUltragoalReviewSourceHash(changeSet);
		const finalSourceHash = computeUltragoalReviewSourceHash(finalChangeSet);
		if (
			((initialSourceHash || finalSourceHash) && initialSourceHash !== finalSourceHash) ||
			changeSet?.captureIncomplete ||
			finalChangeSet?.captureIncomplete
		) {
			throw new Error(
				"completion source changed or could not be captured consistently during validation; retry the checkpoint against a stable repository state",
			);
		}
	}
	const now = new Date().toISOString();
	const beforeStatus = goal.status;
	if (input.status === "complete") {
		const blockedGoalId =
			typeof goal.steering?.kind === "string" && goal.steering.kind === "review_blocker"
				? nonEmptyString(goal.steering.blockedGoalId)
				: null;
		const blockedGoal = blockedGoalId ? plan.goals.find(item => item.id === blockedGoalId) : undefined;
		if (blockedGoal?.status === "review_blocked") {
			blockedGoal.status = "superseded";
			blockedGoal.evidence = `Resolved by verification blocker story ${goal.id}: ${evidence}`;
			blockedGoal.updatedAt = now;
		}
	}
	const receiptKind = input.status === "complete" ? chooseReceiptKind(plan, ledgerBefore, goal, input.status) : null;
	const pendingCheckpointEventId = crypto.randomUUID();
	if (input.status === "complete" && receiptKind && qualityGateJson && !Array.isArray(qualityGateJson)) {
		goal.completionVerification = buildCompletionReceipt({
			plan,
			ledger: ledgerBefore,
			goal,
			receiptKind,
			beforeStatus,
			qualityGateJson: qualityGateJson as JsonObject,
			now,
			checkpointLedgerEventId: pendingCheckpointEventId,
		});
	}
	goal.status = input.status;
	goal.evidence = evidence;
	goal.updatedAt = now;
	if (input.status === "complete") goal.completedAt = now;
	plan.updatedAt = now;
	await writePlan(input.cwd, plan);
	const persistedPlan = await readUltragoalPlan(input.cwd);
	if (persistedPlan?.state_revision !== undefined) plan.state_revision = persistedPlan.state_revision;
	await appendLedger(input.cwd, {
		eventId: pendingCheckpointEventId,
		event: "goal_checkpointed",
		goalId: goal.id,
		status: input.status,
		evidence,
		qualityGateJson,
		completionVerification: goal.completionVerification,
	});
	return plan;
}
export interface UltragoalCheckpointContinuation {
	plan: UltragoalPlan;
	checkpointedGoal: UltragoalGoal;
	nextGoal?: UltragoalGoal;
	startedNext: boolean;
	allComplete: boolean;
	incompleteGoals: UltragoalGoal[];
}

export async function checkpointAndContinueUltragoalGoal(input: {
	cwd: string;
	goalId: string;
	status: UltragoalGoalStatus;
	evidence: string;
	qualityGateJson?: string;
	advanceNext?: boolean;
	retryFailed?: boolean;
}): Promise<UltragoalCheckpointContinuation> {
	let plan = await checkpointUltragoalGoal(input);
	const checkpointedGoal = plan.goals.find(goal => goal.id === input.goalId);
	if (!checkpointedGoal) throw new Error(`No ultragoal goal found for ${input.goalId}.`);
	if (input.status === "complete" && input.advanceNext === true) {
		const beforeAdvance = getUltragoalRunCompletionState(plan, { retryFailed: input.retryFailed });
		if (beforeAdvance.nextGoal && beforeAdvance.nextGoal.status !== "active") {
			const started = await startNextUltragoalGoal({ cwd: input.cwd, retryFailed: input.retryFailed });
			plan = started.plan;
			const afterAdvance = getUltragoalRunCompletionState(plan, { retryFailed: input.retryFailed });
			return {
				plan,
				checkpointedGoal,
				nextGoal: started.goal,
				startedNext: Boolean(started.goal),
				allComplete: afterAdvance.allComplete,
				incompleteGoals: afterAdvance.incompleteGoals,
			};
		}
	}
	const state = getUltragoalRunCompletionState(plan, { retryFailed: input.retryFailed });
	return {
		plan,
		checkpointedGoal,
		nextGoal: state.nextGoal,
		startedNext: false,
		allComplete: state.allComplete,
		incompleteGoals: state.incompleteGoals,
	};
}

function nextUltragoalGoalId(plan: UltragoalPlan, offset = 1): string {
	return `G${String(plan.goals.length + offset).padStart(3, "0")}`;
}

function requireSteeringText(value: string, label: string, kind: UltragoalSteeringKind): string {
	const trimmed = value.trim();
	if (!trimmed) throw new Error(`steer --${label} is required for ${kind}`);
	return trimmed;
}

function requireSteeringEvidence(input: { kind: UltragoalSteeringKind; evidence: string; rationale: string }): {
	evidence: string;
	rationale: string;
} {
	return {
		evidence: requireSteeringText(input.evidence, "evidence", input.kind),
		rationale: requireSteeringText(input.rationale, "rationale", input.kind),
	};
}

function findGoalOrThrow(plan: UltragoalPlan, goalId: string, kind: UltragoalSteeringKind): UltragoalGoal {
	const id = goalId.trim();
	if (!id) throw new Error(`steer --goal-id is required for ${kind}`);
	const goal = plan.goals.find(item => item.id === id);
	if (!goal) throw new Error(`No ultragoal goal found for ${id}.`);
	return goal;
}

function requireGoalStatus(
	goal: UltragoalGoal,
	allowed: readonly UltragoalGoalStatus[],
	kind: UltragoalSteeringKind,
): void {
	if (!allowed.includes(goal.status)) {
		throw new Error(`steer ${kind} requires goal ${goal.id} status ${allowed.join(" or ")}; found ${goal.status}`);
	}
}

function parseJsonFlag(value: string, label: string, kind: UltragoalSteeringKind): unknown {
	const trimmed = requireSteeringText(value, label, kind);
	try {
		return JSON.parse(trimmed) as unknown;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`steer --${label} must be valid JSON for ${kind}: ${message}`);
	}
}

function parseReplacementSpecs(value: string, kind: UltragoalSteeringKind): ReplacementSpec[] {
	const raw = parseJsonFlag(value, "replacements-json", kind);
	if (!Array.isArray(raw) || raw.length < 2) {
		throw new Error("steer --replacements-json must be an array with at least two replacements");
	}
	const seen = new Set<string>();
	return raw.map((item, index) => {
		if (typeof item !== "object" || item === null || Array.isArray(item)) {
			throw new Error(`steer --replacements-json[${index}] must be an object`);
		}
		const record = item as Record<string, unknown>;
		const title = typeof record.title === "string" ? record.title.trim() : "";
		const objective = typeof record.objective === "string" ? record.objective.trim() : "";
		if (!title || !objective) {
			throw new Error(`steer --replacements-json[${index}] requires non-empty title and objective`);
		}
		const key = `${title}\u0000${objective}`;
		if (seen.has(key)) throw new Error(`steer --replacements-json[${index}] duplicates an earlier replacement`);
		seen.add(key);
		return { title, objective };
	});
}

function parsePendingOrder(value: string, kind: UltragoalSteeringKind): string[] {
	const raw = parseJsonFlag(value, "order-json", kind);
	if (!Array.isArray(raw) || raw.length === 0) {
		throw new Error("steer --order-json must be a non-empty array of goal ids");
	}
	const seen = new Set<string>();
	return raw.map((item, index) => {
		if (typeof item !== "string" || item.trim().length === 0) {
			throw new Error(`steer --order-json[${index}] must be a non-empty goal id string`);
		}
		const id = item.trim();
		if (seen.has(id)) throw new Error(`steer --order-json contains duplicate goal id ${id}`);
		seen.add(id);
		return id;
	});
}

async function appendSteeringRejected(input: {
	cwd: string;
	kind: UltragoalSteeringKind;
	reason: string;
	goalId?: string;
	evidence?: string;
	rationale?: string;
	payload?: JsonObject;
}): Promise<void> {
	await appendLedger(input.cwd, {
		event: "steering_rejected",
		kind: input.kind,
		goalId: input.goalId?.trim() || undefined,
		reason: input.reason,
		evidence: input.evidence?.trim() || undefined,
		rationale: input.rationale?.trim() || undefined,
		payload: input.payload,
	});
}

function steeringPayloadSummary(args: readonly string[]): JsonObject {
	return {
		goalId: flagValue(args, "--goal-id"),
		title: flagValue(args, "--title"),
		objective: flagValue(args, "--objective"),
		replacementsJson: flagValue(args, "--replacements-json"),
		orderJson: flagValue(args, "--order-json"),
	};
}

function parseNativeSteeringKind(value: string | undefined): UltragoalSteeringKind {
	if (typeof value === "string" && NATIVE_STEERING_KIND_SET.has(value)) return value as UltragoalSteeringKind;
	throw new Error(`native steering currently supports --kind ${NATIVE_STEERING_KINDS.join(", ")}`);
}

async function addUltragoalSubgoalToPlan(input: {
	cwd: string;
	plan: UltragoalPlan;
	title: string;
	objective: string;
	evidence: string;
	rationale: string;
}): Promise<{ plan: UltragoalPlan; goalId: string }> {
	const kind = "add_subgoal";
	const title = requireSteeringText(input.title, "title", kind);
	const objective = requireSteeringText(input.objective, "objective", kind);
	const { evidence, rationale } = requireSteeringEvidence({
		kind,
		evidence: input.evidence,
		rationale: input.rationale,
	});
	const now = new Date().toISOString();
	const nextId = nextUltragoalGoalId(input.plan);
	input.plan.goals.push({
		id: nextId,
		title,
		objective,
		status: "pending",
		createdAt: now,
		updatedAt: now,
		steering: { kind, evidence, rationale },
	});
	input.plan.updatedAt = now;
	await writePlan(input.cwd, input.plan);
	await appendLedger(input.cwd, {
		event: "steering_accepted",
		kind,
		goalId: nextId,
		evidence,
		rationale,
	});
	return { plan: input.plan, goalId: nextId };
}

export async function addUltragoalSubgoal(input: {
	cwd: string;
	title: string;
	objective: string;
	evidence: string;
	rationale: string;
}): Promise<UltragoalPlan> {
	const plan = await readUltragoalPlan(input.cwd);
	if (!plan) throw new Error("No ultragoal plan found. Run `gjc ultragoal create-goals --brief ...` first.");
	return (await addUltragoalSubgoalToPlan({ ...input, plan })).plan;
}

async function splitUltragoalSubgoal(input: {
	cwd: string;
	plan: UltragoalPlan;
	goalId: string;
	replacementsJson: string;
	evidence: string;
	rationale: string;
}): Promise<{ plan: UltragoalPlan; goalId: string; replacementGoalIds: string[] }> {
	const kind = "split_subgoal";
	const { evidence, rationale } = requireSteeringEvidence({
		kind,
		evidence: input.evidence,
		rationale: input.rationale,
	});
	const target = findGoalOrThrow(input.plan, input.goalId, kind);
	requireGoalStatus(target, ["pending"], kind);
	const ledger = await readUltragoalLedger(input.cwd);
	requireValidationBatchSteeringAllowed(input.plan, target, kind, ledger);
	const replacements = parseReplacementSpecs(input.replacementsJson, kind);
	const now = new Date().toISOString();
	const replacementGoalIds = replacements.map((_, index) => nextUltragoalGoalId(input.plan, index + 1));
	target.status = "superseded";
	target.evidence = evidence;
	target.updatedAt = now;
	target.steering = { kind, evidence, rationale, replacementGoalIds };
	clearValidationBatchForBatch(input.plan, target.validationBatch);
	const replacementGoals = replacements.map(
		(replacement, index): UltragoalGoal => ({
			id: replacementGoalIds[index]!,
			title: replacement.title,
			objective: replacement.objective,
			status: "pending",
			createdAt: now,
			updatedAt: now,
			steering: { kind: "split_replacement", sourceGoalId: target.id, evidence, rationale },
		}),
	);
	const targetIndex = input.plan.goals.findIndex(goal => goal.id === target.id);
	input.plan.goals.splice(targetIndex + 1, 0, ...replacementGoals);
	input.plan.updatedAt = now;
	await writePlan(input.cwd, input.plan);
	await appendLedger(input.cwd, {
		event: "steering_accepted",
		kind,
		goalId: target.id,
		replacementGoalIds,
		evidence,
		rationale,
	});
	return { plan: input.plan, goalId: target.id, replacementGoalIds };
}

async function reorderPendingUltragoalGoals(input: {
	cwd: string;
	plan: UltragoalPlan;
	orderJson: string;
	evidence: string;
	rationale: string;
}): Promise<{ plan: UltragoalPlan; pendingGoalIds: string[] }> {
	const kind = "reorder_pending";
	const { evidence, rationale } = requireSteeringEvidence({
		kind,
		evidence: input.evidence,
		rationale: input.rationale,
	});
	const pendingGoalIds = input.plan.goals.filter(goal => goal.status === "pending").map(goal => goal.id);
	const requestedOrder = parsePendingOrder(input.orderJson, kind);
	const pendingSet = new Set(pendingGoalIds);
	for (const id of requestedOrder) {
		const goal = input.plan.goals.find(item => item.id === id);
		if (!goal) throw new Error(`steer --order-json references unknown goal id ${id}`);
		if (goal.status !== "pending") throw new Error(`steer --order-json references non-pending goal id ${id}`);
	}
	const missing = pendingGoalIds.filter(id => !requestedOrder.includes(id));
	if (missing.length > 0) throw new Error(`steer --order-json missing pending goal id(s): ${missing.join(", ")}`);
	if (requestedOrder.length !== pendingSet.size)
		throw new Error("steer --order-json must include every pending goal exactly once");
	const pendingById = new Map(input.plan.goals.map(goal => [goal.id, goal]));
	const remaining = [...requestedOrder];
	input.plan.goals = input.plan.goals.map(goal =>
		goal.status === "pending" ? pendingById.get(remaining.shift()!)! : goal,
	);
	input.plan.updatedAt = new Date().toISOString();
	await writePlan(input.cwd, input.plan);
	await appendLedger(input.cwd, {
		event: "steering_accepted",
		kind,
		previousPendingGoalIds: pendingGoalIds,
		pendingGoalIds: requestedOrder,
		evidence,
		rationale,
	});
	return { plan: input.plan, pendingGoalIds: requestedOrder };
}

async function revisePendingUltragoalWording(input: {
	cwd: string;
	plan: UltragoalPlan;
	goalId: string;
	title?: string;
	objective?: string;
	evidence: string;
	rationale: string;
}): Promise<{ plan: UltragoalPlan; goalId: string; changedFields: string[] }> {
	const kind = "revise_pending_wording";
	const { evidence, rationale } = requireSteeringEvidence({
		kind,
		evidence: input.evidence,
		rationale: input.rationale,
	});
	const goal = findGoalOrThrow(input.plan, input.goalId, kind);
	requireGoalStatus(goal, ["pending"], kind);
	const ledger = await readUltragoalLedger(input.cwd);
	requireValidationBatchSteeringAllowed(input.plan, goal, kind, ledger);
	const title = input.title === undefined ? undefined : input.title.trim();
	const objective = input.objective === undefined ? undefined : input.objective.trim();
	if (input.title !== undefined && !title)
		throw new Error("steer --title must be non-empty for revise_pending_wording");
	if (input.objective !== undefined && !objective)
		throw new Error("steer --objective must be non-empty for revise_pending_wording");
	if (!title && !objective) throw new Error("revise_pending_wording requires --title and/or --objective");
	const changedFields: string[] = [];
	if (title !== undefined) {
		goal.title = title;
		changedFields.push("title");
	}
	if (objective !== undefined) {
		goal.objective = objective;
		changedFields.push("objective");
	}
	const now = new Date().toISOString();
	goal.updatedAt = now;
	goal.steering = { kind, evidence, rationale, changedFields };
	clearValidationBatchForBatch(input.plan, goal.validationBatch);
	input.plan.updatedAt = now;
	await writePlan(input.cwd, input.plan);
	await appendLedger(input.cwd, {
		event: "steering_accepted",
		kind,
		goalId: goal.id,
		changedFields,
		evidence,
		rationale,
	});
	return { plan: input.plan, goalId: goal.id, changedFields };
}

async function annotateUltragoalLedger(input: {
	cwd: string;
	plan: UltragoalPlan;
	evidence: string;
	rationale: string;
}): Promise<{ plan: UltragoalPlan }> {
	const kind = "annotate_ledger";
	const { evidence, rationale } = requireSteeringEvidence({
		kind,
		evidence: input.evidence,
		rationale: input.rationale,
	});
	await appendLedger(input.cwd, { event: "steering_accepted", kind, evidence, rationale });
	return { plan: input.plan };
}

async function markBlockedUltragoalSuperseded(input: {
	cwd: string;
	plan: UltragoalPlan;
	goalId: string;
	evidence: string;
	rationale: string;
}): Promise<{ plan: UltragoalPlan; goalId: string }> {
	const kind = "mark_blocked_superseded";
	const { evidence, rationale } = requireSteeringEvidence({
		kind,
		evidence: input.evidence,
		rationale: input.rationale,
	});
	const goal = findGoalOrThrow(input.plan, input.goalId, kind);
	requireGoalStatus(goal, ["blocked", "review_blocked"], kind);
	const ledger = await readUltragoalLedger(input.cwd);
	requireValidationBatchSteeringAllowed(input.plan, goal, kind, ledger);
	const remainingRequiredGoals = requiredUltragoalGoals(input.plan).filter(item => item.id !== goal.id);
	if (remainingRequiredGoals.length === 0) {
		throw new Error(`steer ${kind} cannot supersede ${goal.id} because it is the only remaining required goal`);
	}
	const now = new Date().toISOString();
	goal.status = "superseded";
	goal.evidence = evidence;
	goal.updatedAt = now;
	goal.steering = { kind, evidence, rationale, noReplacementRequired: true };
	clearValidationBatchForBatch(input.plan, goal.validationBatch);
	input.plan.updatedAt = now;
	await writePlan(input.cwd, input.plan);
	await appendLedger(input.cwd, {
		event: "steering_accepted",
		kind,
		goalId: goal.id,
		noReplacementRequired: true,
		evidence,
		rationale,
	});
	return { plan: input.plan, goalId: goal.id };
}

export async function recordUltragoalReviewBlockers(input: {
	cwd: string;
	goalId: string;
	title: string;
	objective: string;
	evidence: string;
}): Promise<{ plan: UltragoalPlan; blockerGoalId: string }> {
	const objective = input.objective.trim();
	if (!objective) throw new Error("record-review-blockers --objective is required");
	// Pre-check on the persisted plan BEFORE any mutation (#3613): dedup and cap are
	// evaluated against the durable state so a dedup-hit is a pure idempotent return
	// (no checkpoint, no writePlan, no appendLedger) and a cap-hit throws before any
	// partial write corrupts goals.json/ledger. Read-check-then-write on this snapshot.
	const prePlan = await readUltragoalPlan(input.cwd);
	if (!prePlan) throw new Error("No ultragoal plan found. Run `gjc ultragoal create-goals --brief ...` first.");
	// Dedup BEFORE the budget check: an identical-objective open review_blocker already
	// descending from this blocked goal is returned idempotently — mirroring
	// recordReviewFindingGoals' findOpenReviewBlockerGoal path and the checkpoint #645
	// dedup discipline. Identity = review_blocker kind + trimmed objective +
	// same blockedGoalId + non-resolved status.
	const existing = findOpenReviewBlockerGoal(prePlan, objective);
	if (existing && existing.steering?.kind === "review_blocker" && existing.steering.blockedGoalId === input.goalId) {
		return { plan: prePlan, blockerGoalId: existing.id };
	}
	// Bounded cap: count unresolved descents off this blocked goal BEFORE any mutation.
	// Resolved (complete/superseded) ancestors never count, so legitimate multi-generation
	// review is not falsely capped. Descents 1..3 may exist; creating the 4th triggers the
	// deterministic terminal human handoff. Durable across replay/restart/concurrency:
	// recomputed from the persisted plan snapshot each call.
	const unresolvedDescents = countUnresolvedReviewBlockerDescents(prePlan, input.goalId);
	if (unresolvedDescents >= MAX_REVIEW_BLOCKER_DESCENTS)
		throw new UltragoalReviewBlockerRecursionCapError(input.goalId, unresolvedDescents);
	// Only now transition the blocked goal to review_blocked and record the new descent.
	const plan = await checkpointUltragoalGoal({
		cwd: input.cwd,
		goalId: input.goalId,
		status: "review_blocked",
		evidence: input.evidence,
	});
	const persistedPlan = await readUltragoalPlan(input.cwd);
	if (persistedPlan?.state_revision !== undefined) plan.state_revision = persistedPlan.state_revision;
	const now = new Date().toISOString();
	const nextId = nextUltragoalGoalId(plan);
	plan.goals.push({
		id: nextId,
		title: input.title.trim() || "Resolve final code-review blockers",
		objective,
		status: "pending",
		createdAt: now,
		updatedAt: now,
		steering: { kind: "review_blocker", blockedGoalId: input.goalId },
	});
	plan.updatedAt = now;
	await writePlan(input.cwd, plan);
	await appendLedger(input.cwd, { event: "review_blockers_recorded", goalId: input.goalId, blockerGoalId: nextId });
	return { plan, blockerGoalId: nextId };
}

export type UltragoalBlockerClassification = "human_blocked" | "resolvable";

/**
 * Record an audited blocker triage classification in the durable ledger. Pause
 * requires the latest `blocker_classified` event to be `human_blocked` and a
 * later clean pause terminal critic verdict bound to that classification; `resolvable`
 * is an audit note and never unblocks pause.
 */
export async function recordUltragoalBlockerClassification(input: {
	cwd: string;
	classification: UltragoalBlockerClassification;
	evidence: string;
	goalId?: string;
}): Promise<UltragoalLedgerEvent> {
	const evidence = input.evidence.trim();
	if (!evidence) throw new Error("classify-blocker --evidence is required");
	if (input.classification !== "human_blocked" && input.classification !== "resolvable") {
		throw new Error('classify-blocker --classification must be "human_blocked" or "resolvable"');
	}
	return appendLedger(input.cwd, {
		event: "blocker_classified",
		classification: input.classification,
		...(input.goalId?.trim() ? { goalId: input.goalId.trim() } : {}),
		evidence,
	});
}

export async function recordUltragoalCriticVerdict(input: {
	cwd: string;
	terminus: "completion" | "pause";
	verdict: CriticVerdict;
	evidence: string;
	blockers?: string[];
	goalId?: string;
	classificationEventId?: string;
}): Promise<UltragoalLedgerEvent> {
	const evidence = input.evidence.trim();
	if (!evidence) throw new Error("record-critic-verdict --evidence is required");
	if (input.terminus !== "completion" && input.terminus !== "pause") {
		throw new Error('record-critic-verdict --terminus must be "completion" or "pause"');
	}
	if (input.verdict !== "OKAY" && input.verdict !== "ITERATE" && input.verdict !== "REJECT") {
		throw new Error("record-critic-verdict --verdict must be OKAY, ITERATE, or REJECT");
	}
	const blockers = stringArray(input.blockers ?? []);
	if (!blockers) throw new Error("record-critic-verdict --blockers-json must be a JSON string array");
	if (input.terminus === "completion" && input.verdict === "OKAY" && blockers.length > 0) {
		throw new Error("OKAY critic verdict must have empty blockers");
	}
	const classificationEventId = input.classificationEventId?.trim();
	if (input.terminus === "pause" && !classificationEventId) {
		throw new Error("record-critic-verdict --classification-event-id is required for pause verdicts");
	}
	const resolvedSessionId = resolveGjcSessionForWrite(input.cwd, {
		envSessionId: process.env.GJC_SESSION_ID,
	}).gjcSessionId;
	const paths = getUltragoalPaths(input.cwd, resolvedSessionId);
	return withWorkflowStateLock(
		paths.ledgerPath,
		async () => {
			const plan = await readUltragoalPlan(input.cwd, resolvedSessionId);
			if (!plan) throw new Error("record-critic-verdict requires an active ultragoal plan");
			const ledger = await readUltragoalLedger(input.cwd, resolvedSessionId);
			if (input.terminus === "pause") {
				const latestClassification = [...ledger].reverse().find(event => event.event === "blocker_classified");
				if (
					latestClassification?.classification !== "human_blocked" ||
					latestClassification.eventId !== classificationEventId
				) {
					throw new Error(
						"record-critic-verdict pause requires --classification-event-id to name the latest human_blocked classification",
					);
				}
			}
			const planGeneration = computeCriticVerdictPlanGeneration(plan);
			if (
				input.terminus === "pause" &&
				input.verdict === "OKAY" &&
				!isCleanPauseCriticVerdictShape(
					{
						event: CRITIC_VERDICT_EVENT,
						terminus: input.terminus,
						verdict: input.verdict,
						evidence,
						blockers,
						planGeneration,
						classificationEventId,
					},
					planGeneration,
					classificationEventId!,
				)
			) {
				throw new Error("OKAY critic verdict must have empty blockers");
			}
			const criticVerdict = await appendLedger(
				input.cwd,
				{
					event: CRITIC_VERDICT_EVENT,
					terminus: input.terminus,
					verdict: input.verdict,
					evidence,
					blockers,
					planGeneration,
					...(classificationEventId ? { classificationEventId } : {}),
					...(input.goalId?.trim() ? { goalId: input.goalId.trim() } : {}),
				},
				resolvedSessionId,
			);
			const updatedLedger = [...ledger, criticVerdict];
			const count = countNonOkayTerminalCriticVerdicts(updatedLedger);
			if (count >= TERMINAL_CRITIC_CEILING && !terminalCriticHardStopReached(updatedLedger)) {
				await appendLedger(
					input.cwd,
					{
						event: CRITIC_GATE_HARD_STOP_EVENT,
						planGeneration,
						reason: "Terminal critic verdict ceiling reached.",
						count,
					},
					resolvedSessionId,
				);
			}
			return criticVerdict;
		},
		{ cwd: input.cwd },
	);
}

export async function recordUltragoalCriticGateOverride(input: {
	cwd: string;
	evidence: string;
}): Promise<UltragoalLedgerEvent> {
	const evidence = input.evidence.trim();
	if (!evidence) throw new Error("record-critic-gate-override --evidence is required");
	const resolvedSessionId = resolveGjcSessionForWrite(input.cwd, {
		envSessionId: process.env.GJC_SESSION_ID,
	}).gjcSessionId;
	const paths = getUltragoalPaths(input.cwd, resolvedSessionId);
	return withWorkflowStateLock(
		paths.ledgerPath,
		async () => {
			const ledger = await readUltragoalLedger(input.cwd, resolvedSessionId);
			if (!terminalCriticHardStopReached(ledger)) {
				throw new Error("record-critic-gate-override requires a durably recorded terminal critic hard stop");
			}
			return appendLedger(input.cwd, { event: CRITIC_GATE_OVERRIDE_EVENT, evidence }, resolvedSessionId);
		},
		{ cwd: input.cwd },
	);
}

type UltragoalReviewMode = "review-only" | "review-start";
type UltragoalReviewContractStrength = "strong" | "thin-derived";

interface UltragoalReviewFinding extends JsonObject {
	severity: "blocker";
	message: string;
}

interface UltragoalReviewResult extends JsonObject {
	verdict: "pass" | "fail" | "inconclusive: weak-contract";
	contractStrength: UltragoalReviewContractStrength;
	cleanPassEligible: boolean;
	source: JsonObject;
	findings: UltragoalReviewFinding[];
	artifactValidationSummary: JsonObject;
	weakContractCapApplied: boolean;
	blockerGoalIds?: string[];
}

function parseReviewMode(value: string | undefined): UltragoalReviewMode {
	if (value === undefined || value === "review-only") return "review-only";
	if (value === "review-start") return "review-start";
	throw new Error("review --mode must be review-only or review-start");
}

async function readOptionalExecutorQa(cwd: string, value: string | undefined): Promise<JsonObject> {
	if (!value) {
		return {
			status: "passed",
			e2eStatus: "passed",
			redTeamStatus: "passed",
			evidence: "review evidence bundle was not supplied; runtime reports this as a finding",
			e2eCommands: ["gjc ultragoal review"],
			redTeamCommands: ["gjc ultragoal review"],
			artifactRefs: [],
			contractCoverage: [],
			surfaceEvidence: [],
			adversarialCases: [],
			blockers: [],
		};
	}
	const structured = await readStructuredValue(cwd, value);
	if (typeof structured !== "object" || structured === null || Array.isArray(structured)) {
		throw new Error("review --executor-qa-json must resolve to an executorQa object");
	}
	return structured as JsonObject;
}

function changeSetFromReviewSource(source: JsonObject): UltragoalChangeSet | undefined {
	const kind = nonEmptyString(source.kind);
	if (kind === "spec") {
		const codeSource = qualityGateObject(source.codeSource);
		return codeSource ? changeSetFromReviewSource(codeSource) : undefined;
	}
	if (kind === "pr" && typeof source.diff === "string") {
		const paths = parseUnifiedDiffPaths(source.diff);
		return {
			source: "review-pr",
			paths,
			rawDiffStat: source.diff,
			rawDiff: source.diff,
			captureIncomplete: true,
			trusted: true,
		};
	}
	const local = qualityGateObject(source.local);
	if (kind === "pr" && local) {
		const localChangeSet = changeSetFromReviewSource(local);
		return localChangeSet ? { ...localChangeSet, captureIncomplete: true } : undefined;
	}
	if (kind === "worktree")
		return {
			source: "review-worktree",
			paths: mergeChangeSetPaths([
				parseGitNameStatus(String(source.nameStatus ?? source.status ?? "")),
				parseGitUntrackedPaths(String(source.untracked ?? "")),
				ciDevChangedPathRows(),
			]),
			rawDiffStat: typeof source.diffStat === "string" ? source.diffStat : undefined,
			rawDiff: typeof source.diff === "string" ? source.diff : undefined,
			captureIncomplete: source.captureIncomplete === true,
			trusted: true,
		};
	if (kind === "branch" || kind === "pr-fallback")
		return {
			source: "review-branch",
			baseRef: nonEmptyString(source.base) ?? undefined,
			headRef: "HEAD",
			paths: mergeChangeSetPaths([parseGitNameStatus(String(source.nameStatus ?? "")), ciDevChangedPathRows()]),
			rawDiffStat: typeof source.diffStat === "string" ? source.diffStat : undefined,
			rawDiff: typeof source.diff === "string" ? source.diff : undefined,
			captureIncomplete: source.captureIncomplete === true,
			trusted: true,
		};
	return undefined;
}

async function localDiffSource(cwd: string, sourceKind: string, branch?: string): Promise<JsonObject> {
	if (sourceKind === "worktree") {
		const [status, diffStat, unstaged, staged, untracked, unstagedDiff, stagedDiff] = await Promise.all([
			spawnText(["git", "status", "--short"], { cwd, timeoutMs: 5000 }),
			spawnText(["git", "diff", "--stat"], { cwd, timeoutMs: 5000 }),
			spawnText(["git", "diff", "--name-status", "-z"], { cwd, timeoutMs: 5000 }),
			spawnText(["git", "diff", "--cached", "--name-status", "-z"], { cwd, timeoutMs: 5000 }),
			spawnText(["git", "ls-files", "--others", "--exclude-standard", "-z"], { cwd, timeoutMs: 5000 }),
			spawnText(["git", "diff"], { cwd, timeoutMs: 5000 }),
			spawnText(["git", "diff", "--cached"], { cwd, timeoutMs: 5000 }),
		]);
		return {
			kind: "worktree",
			...(status.ok ? { status: status.stdout } : {}),
			...(diffStat.ok ? { diffStat: diffStat.stdout } : {}),
			...(unstagedDiff.ok && stagedDiff.ok
				? { diff: [unstagedDiff.stdout, stagedDiff.stdout].filter(Boolean).join("\n") }
				: {}),
			nameStatus: [unstaged.ok ? unstaged.stdout : "", staged.ok ? staged.stdout : ""].join(""),
			...(untracked.ok ? { untracked: untracked.stdout } : {}),
			captureIncomplete:
				!status.ok ||
				!diffStat.ok ||
				!unstaged.ok ||
				!staged.ok ||
				!untracked.ok ||
				!unstagedDiff.ok ||
				!stagedDiff.ok,
		};
	}
	if (branch) {
		const branchExists = await spawnText(["git", "rev-parse", "--verify", branch], { cwd, timeoutMs: 3000 });
		if (!branchExists.ok) throw new Error(`review branch ${branch} does not resolve`);
	}
	const base = await resolveGitBase(cwd, branch);
	const [diffStat, nameStatus, diff] = await Promise.all([
		spawnText(["git", "diff", "--stat", `${base}...HEAD`], { cwd, timeoutMs: 5000 }),
		spawnText(["git", "diff", "--name-status", "-z", `${base}...HEAD`], { cwd, timeoutMs: 5000 }),
		spawnText(["git", "diff", `${base}...HEAD`], { cwd, timeoutMs: 5000 }),
	]);
	return {
		kind: sourceKind,
		base,
		branch,
		...(diffStat.ok ? { diffStat: diffStat.stdout } : {}),
		...(diff.ok ? { diff: diff.stdout } : {}),
		nameStatus: nameStatus.ok ? nameStatus.stdout : "",
		captureIncomplete: !diffStat.ok || !nameStatus.ok || !diff.ok,
	};
}

async function resolveReviewSource(
	cwd: string,
	args: readonly string[],
	specPath: string | undefined,
): Promise<{ contractStrength: UltragoalReviewContractStrength; source: JsonObject }> {
	if (specPath) {
		const absolute = path.resolve(cwd, specPath);
		const codeReviewSource = await resolveReviewSource(cwd, args, undefined);
		return {
			contractStrength: "strong",
			source: {
				kind: "spec",
				path: specPath,
				contract: await Bun.file(absolute).text(),
				codeSource: codeReviewSource.source,
			},
		};
	}
	const pr = flagValue(args, "--pr");
	if (pr) {
		const [view, diff] = await Promise.all([
			spawnText(["gh", "pr", "view", pr, "--json", "title,body,baseRefName"], { cwd, timeoutMs: 5000 }),
			spawnText(["gh", "pr", "diff", pr], { cwd, timeoutMs: 5000 }),
		]);
		if (view.ok && diff.ok)
			return {
				contractStrength: "thin-derived",
				source: { kind: "pr", pr, prSource: "gh", metadata: view.stdout, diff: diff.stdout },
			};
		return {
			contractStrength: "thin-derived",
			source: {
				kind: "pr",
				pr,
				prSource: "gh-unavailable",
				ghError: `${view.stderr}${diff.stderr}`.trim(),
				local: await localDiffSource(cwd, "pr-fallback"),
			},
		};
	}
	const branch = flagValue(args, "--branch");
	if (branch) return { contractStrength: "thin-derived", source: await localDiffSource(cwd, "branch", branch) };
	return { contractStrength: "thin-derived", source: await localDiffSource(cwd, "worktree") };
}

function findingFromError(error: unknown): UltragoalReviewFinding {
	return { severity: "blocker", message: error instanceof Error ? error.message : String(error) };
}

function executorQaBlockers(executorQa: JsonObject): UltragoalReviewFinding[] {
	const blockers = nonEmptyStringArray(executorQa.blockers);
	return (blockers ?? []).map(message => ({ severity: "blocker", message: `executorQa.blockers: ${message}` }));
}

const RESOLVED_REVIEW_BLOCKER_STATUSES = new Set<UltragoalGoalStatus>(["complete", "superseded"]);

function findOpenReviewBlockerGoal(plan: UltragoalPlan, message: string): UltragoalGoal | undefined {
	const objective = message.trim();
	return plan.goals.find(
		goal =>
			goal.steering?.kind === "review_blocker" &&
			goal.objective.trim() === objective &&
			!RESOLVED_REVIEW_BLOCKER_STATUSES.has(goal.status),
	);
}

/**
 * Maximum unresolved review_blocker descents chained off a single blocked goal.
 * Descents 1..3 may exist; an attempt to create the 4th triggers the deterministic
 * terminal {@link UltragoalReviewBlockerRecursionCapError} handoff (#3613).
 */
const MAX_REVIEW_BLOCKER_DESCENTS = 3;

/**
 * Typed terminal handoff thrown when {@link recordUltragoalReviewBlockers} would
 * exceed {@link MAX_REVIEW_BLOCKER_DESCENTS} unresolved review_blocker descents
 * off a single blocked goal (#3613). Never silently marks unresolved technical
 * findings complete; the operator/leader must pause and escalate.
 */
export class UltragoalReviewBlockerRecursionCapError extends Error {
	readonly code = "review_blocker_recursion_cap" as const;
	readonly blockedGoalId: string;
	readonly unresolvedDescents: number;
	readonly cap: number;
	constructor(blockedGoalId: string, unresolvedDescents: number, cap = MAX_REVIEW_BLOCKER_DESCENTS) {
		super(
			`review_blocker_recursion_cap: goal ${blockedGoalId} already has ${unresolvedDescents} unresolved review_blocker descents (cap=${cap}). ` +
				"Record a human pause/escalation or resolve existing blockers before recording more. " +
				"Unresolved technical findings are never auto-completed.",
		);
		this.name = "UltragoalReviewBlockerRecursionCapError";
		this.blockedGoalId = blockedGoalId;
		this.unresolvedDescents = unresolvedDescents;
		this.cap = cap;
	}
}

/**
 * Count unresolved review_blocker descents off a single blocked goal. A descent
 * counts iff `steering.kind === "review_blocker"` AND
 * `steering.blockedGoalId === goalId` AND status is not resolved
 * (complete/superseded). Resolved ancestors never count, so legitimate
 * multi-generation review is not falsely capped (#3613). Durable across
 * replay/restart/concurrency: computed from the persisted plan snapshot each call.
 */
function countUnresolvedReviewBlockerDescents(plan: UltragoalPlan, goalId: string): number {
	return plan.goals.reduce((count, goal) => {
		if (
			goal.steering?.kind === "review_blocker" &&
			goal.steering.blockedGoalId === goalId &&
			!RESOLVED_REVIEW_BLOCKER_STATUSES.has(goal.status)
		)
			return count + 1;
		return count;
	}, 0);
}

async function recordReviewFindingGoals(cwd: string, findings: readonly UltragoalReviewFinding[]): Promise<string[]> {
	let plan = await readUltragoalPlan(cwd);
	const now = new Date().toISOString();
	if (!plan) {
		plan = {
			version: 1,
			gjcObjective: DEFAULT_ULTRAGOAL_OBJECTIVE,
			brief: "Ultragoal review-start findings",
			gjcGoalMode: "aggregate",
			createdAt: now,
			updatedAt: now,
			goals: [],
		};
	}
	const blockerGoalIds: string[] = [];
	const createdGoalIds: string[] = [];
	for (const finding of findings) {
		const existing = findOpenReviewBlockerGoal(plan, finding.message);
		if (existing) {
			if (!blockerGoalIds.includes(existing.id)) blockerGoalIds.push(existing.id);
			continue;
		}
		const id = nextUltragoalGoalId(plan);
		plan.goals.push({
			id,
			title: "Resolve ultragoal review finding",
			objective: finding.message,
			status: "pending",
			createdAt: now,
			updatedAt: now,
			steering: { kind: "review_blocker" },
		});
		blockerGoalIds.push(id);
		createdGoalIds.push(id);
	}
	if (createdGoalIds.length > 0) {
		plan.updatedAt = now;
		await writePlan(cwd, plan);
		await appendLedger(cwd, {
			event: "review_blockers_recorded",
			blockerGoalIds: createdGoalIds,
			findings: findings.map(finding => finding.message),
		});
	}
	return blockerGoalIds;
}

export async function runUltragoalReview(cwd: string, args: readonly string[]): Promise<UltragoalReviewResult> {
	const mode = parseReviewMode(flagValue(args, "--mode"));
	const specPath = flagValue(args, "--spec");
	const { contractStrength, source } = await resolveReviewSource(cwd, args, specPath);
	const changeSet = changeSetFromReviewSource(source);
	const executorQa = await readOptionalExecutorQa(
		cwd,
		flagValue(args, "--executor-qa-json") ?? flagValue(args, "--executor-qa"),
	);
	const findings: UltragoalReviewFinding[] = [];
	try {
		await validateExecutorQaRedTeamEvidenceForReview(cwd, executorQa, { mode: "review", changeSet });
	} catch (error) {
		findings.push(findingFromError(error));
	}
	findings.push(...executorQaBlockers(executorQa));
	const weakContractCapApplied = contractStrength === "thin-derived";
	const cleanPassEligible = contractStrength === "strong" && findings.length === 0;
	const result: UltragoalReviewResult = {
		verdict: cleanPassEligible
			? "pass"
			: weakContractCapApplied && findings.length === 0
				? "inconclusive: weak-contract"
				: "fail",
		contractStrength,
		cleanPassEligible,
		source,
		findings,
		artifactValidationSummary: {
			validator: "validateExecutorQaRedTeamEvidenceForReview",
			mode: "review",
			passed: findings.length === 0,
			findingCount: findings.length,
		},
		weakContractCapApplied,
	};
	if (mode === "review-start" && findings.length > 0)
		result.blockerGoalIds = await recordReviewFindingGoals(cwd, findings);
	return result;
}

function flagValue(args: readonly string[], flag: string): string | undefined {
	const index = args.indexOf(flag);
	if (index < 0) return undefined;
	return args[index + 1];
}

function flagValues(args: readonly string[], flag: string): string[] {
	const values: string[] = [];
	for (let index = 0; index < args.length; index += 1) {
		if (args[index] !== flag) continue;
		const value = args[index + 1];
		if (value === undefined || value.startsWith("-")) continue;
		values.push(value);
		index += 1;
	}
	return values;
}

function hasFlag(args: readonly string[], flag: string): boolean {
	return args.includes(flag);
}

const HELP_FLAGS = new Set(["--help", "-h"]);

const FLAGS_WITH_VALUES = new Set([
	"--brief",
	"--brief-file",
	"--gjc-goal-mode",
	"--goal-id",
	"--status",
	"--evidence",
	"--quality-gate-json",
	"--executor-qa-json",
	"--executor-qa",
	"--pr",
	"--branch",
	"--spec",
	"--mode",
	"--kind",
	"--title",
	"--objective",
	"--rationale",
	"--replacements-json",
	"--order-json",
	"--classification",
	"--validation-batch-json",
	"--out",
	"--surface",
]);

function isHelpArg(arg: string): boolean {
	return HELP_FLAGS.has(arg);
}

function commandName(args: readonly string[]): string {
	let skipNext = false;
	for (const arg of args) {
		if (skipNext) {
			skipNext = false;
			continue;
		}
		if (FLAGS_WITH_VALUES.has(arg)) {
			skipNext = true;
			continue;
		}
		if (isHelpArg(arg)) continue;
		if (!arg.startsWith("-")) return arg;
	}
	return "status";
}

function renderUltragoalHelp(args: readonly string[]): string | null {
	if (!args.some(isHelpArg) && args[0] !== "help") return null;
	const subject =
		args[0] === "help" ? args.find((arg, index) => index > 0 && !arg.startsWith("-")) : commandName(args);
	if (subject === "checkpoint") {
		return [
			"Run native GJC Ultragoal workflow commands",
			"",
			"USAGE",
			"  $ gjc ultragoal checkpoint --goal-id <id> --status <status> --evidence <text> [FLAGS]",
			"",
			"FLAGS",
			"      --goal-id=<value>            Durable .gjc/ultragoal goal id, e.g. G001",
			"      --status=<value>             pending|active|complete|failed|blocked|review_blocked|superseded",
			"      --evidence=<value>           Completion or checkpoint evidence text",
			"      --quality-gate-json=<value>  JSON string or path for complete checkpoints",
			"      --json                       Output a machine-readable receipt",
			"",
			"COMPLETE CHECKPOINT RECEIPTS",
			"  --quality-gate-json must be an object with architectReview, executorQa, and iteration.",
			"  executorQa.contractCoverage[] rows require an obligation field; description is not a substitute.",
			"  Complete checkpoints validate the target durable goals.json record before writing a receipt.",
			"",
			"EXAMPLES",
			'  $ gjc ultragoal checkpoint --goal-id G001 --status blocked --evidence "waiting on review"',
			'  $ gjc ultragoal checkpoint --goal-id G001 --status complete --evidence "tests passed" --quality-gate-json ./quality-gate.json --json',
			"",
		].join("\n");
	}
	if (subject === "review") {
		return [
			"Run native GJC Ultragoal workflow commands",
			"",
			"USAGE",
			"  $ gjc ultragoal review [--pr <n> | --branch <ref>] [--spec <path>] [--executor-qa-json <json-or-path>] [FLAGS]",
			"",
			"FLAGS",
			"      --pr=<value>                  Review a GitHub PR; falls back to local diff when gh is unavailable",
			"      --branch=<value>              Review the current branch against a base ref",
			"      --spec=<value>                Contract/spec override; enables strong-contract clean PASS eligibility",
			"      --executor-qa-json=<value>    executorQa JSON string or path using checkpoint qualityGate.executorQa shape",
			"      --mode=<value>                review-only|review-start (default review-only)",
			"      --json                        Output the machine-readable verdict report",
			"",
			"OUTPUT",
			"  JSON includes verdict, contractStrength, cleanPassEligible, source, findings, artifactValidationSummary, and weakContractCapApplied.",
			"",
		].join("\n");
	}
	if (subject === "classify-blocker") {
		return [
			"Run native GJC Ultragoal workflow commands",
			"",
			"USAGE",
			"  $ gjc ultragoal classify-blocker --classification <human_blocked|resolvable> --evidence <text> [FLAGS]",
			"",
			"FLAGS",
			"      --classification=<value>     Required. human_blocked must be the latest blocker_classified event; pause also requires a later bound clean pause terminal critic OKAY verdict; resolvable never authorizes pause",
			"      --evidence=<value>           Required. Specific blocker evidence; must name the human-only dependency for human_blocked",
			"      --goal-id=<value>            Optional durable .gjc/ultragoal goal id, e.g. G001",
			"      --json                       Output a machine-readable receipt",
			"",
			"EXAMPLES",
			'  $ gjc ultragoal classify-blocker --classification resolvable --evidence "failing test can be fixed autonomously"',
			'  $ gjc ultragoal classify-blocker --classification human_blocked --evidence "user must provide production API credentials" --goal-id G001',
			"",
		].join("\n");
	}
	if (subject === "record-critic-verdict") {
		return [
			"Run native GJC Ultragoal workflow commands",
			"",
			"USAGE",
			"  $ gjc ultragoal record-critic-verdict --terminus <completion|pause> --verdict <OKAY|ITERATE|REJECT> --evidence <text> [--blockers-json <json>] [--goal-id <id>] [--classification-event-id <id>]",
			"",
			"FLAGS",
			"      --terminus=<value>           Required. completion or pause",
			"      --verdict=<value>            Required. OKAY, ITERATE, or REJECT",
			"      --evidence=<value>           Required. Specific evidence supporting the verdict",
			"      --blockers-json=<value>      Optional JSON string array of blockers",
			"      --goal-id=<value>            Optional durable .gjc/ultragoal goal id, e.g. G001",
			"      --classification-event-id=<id> Required for pause verdicts; binds the human_blocked classification",
			"      --json                       Output a machine-readable receipt",
			"",
			"EXAMPLES",
			'  $ gjc ultragoal record-critic-verdict --terminus completion --verdict OKAY --evidence "all final-aggregate checkpoint evidence is current"',
			"",
		].join("\n");
	}
	if (subject === "record-critic-gate-override") {
		return [
			"Run native GJC Ultragoal workflow commands",
			"",
			"USAGE",
			"  $ gjc ultragoal record-critic-gate-override --evidence <text> [--json]",
			"",
			"FLAGS",
			"      --evidence=<value>           Required. Human/leader authorization evidence for the terminal-critic ceiling override",
			"      --json                       Output a machine-readable receipt",
			"",
			"EXAMPLES",
			'  $ gjc ultragoal record-critic-gate-override --evidence "leader approved another terminal attempt after reviewing all five findings"',
			"",
		].join("\n");
	}

	if (subject === "quality-gate") {
		return [
			"Run native GJC Ultragoal workflow commands",
			"",
			"USAGE",
			"  $ gjc ultragoal quality-gate init [--surface <name> ...] --out <path>",
			"  $ gjc ultragoal quality-gate source-hash [--json]",
			"  $ gjc ultragoal quality-gate validate --quality-gate-json <json-or-path> [--goal-id <id>] [--json]",
			"",
			"FLAGS",
			"      --surface=<value>            Surface to scaffold (repeatable; default web)",
			"      --out=<value>                Output path for quality-gate init",
			"      --quality-gate-json=<value>  JSON string or path for quality-gate validate",
			"      --goal-id=<value>            Optional durable goal id for rule-identical validation",
			"      --json                       Machine-readable output",
			"",
			"EXAMPLES",
			"  $ gjc ultragoal quality-gate init --surface web --surface api --out ./quality-gate.json",
			"  $ gjc ultragoal quality-gate source-hash --json",
			"  $ gjc ultragoal quality-gate validate --quality-gate-json ./quality-gate.json --json",
			"",
		].join("\n");
	}

	return [
		"Run native GJC Ultragoal workflow commands",
		"",
		"USAGE",
		"  $ gjc ultragoal <command> [FLAGS]",
		"",
		"COMMANDS",
		"  status",
		"  create-goals",
		"  complete-goals",
		"  checkpoint",
		"  review",
		"  steer",
		"  record-review-blockers",
		"  classify-blocker",
		"  record-critic-verdict",
		"  record-critic-gate-override",
		"  quality-gate init",
		"  quality-gate source-hash",
		"  quality-gate lane-selection",
		"  quality-gate validate",

		"",
		"Run `gjc ultragoal checkpoint --help`, `gjc ultragoal review --help`, `gjc ultragoal classify-blocker --help`, `gjc ultragoal record-critic-verdict --help`, or `gjc ultragoal record-critic-gate-override --help`, or `gjc ultragoal quality-gate --help` for command-specific requirements.",
		"",
	].join("\n");
}

async function readBrief(cwd: string, args: readonly string[]): Promise<string> {
	const inline = flagValue(args, "--brief");
	if (inline !== undefined) return inline;
	const briefFile = flagValue(args, "--brief-file");
	if (briefFile !== undefined) return await Bun.file(path.resolve(cwd, briefFile)).text();
	if (hasFlag(args, "--from-stdin")) return await Bun.stdin.text();
	throw new Error("create-goals requires --brief, --brief-file, or --from-stdin");
}

function renderStatus(summary: UltragoalStatusSummary, json: boolean): string {
	if (json) return `${JSON.stringify(summary, null, 2)}\n`;
	return renderUltragoalStatusMarkdown(summary);
}

function summarizeBlockedGoalForHandoff(goal: UltragoalGoal): {
	id: string;
	status: UltragoalGoalStatus;
	evidence?: string;
} {
	const evidence = typeof goal.evidence === "string" && goal.evidence.trim() ? goal.evidence.trim() : undefined;
	return {
		id: goal.id,
		status: goal.status,
		...(evidence ? { evidence } : {}),
	};
}

function renderCompleteHandoff(
	result: {
		plan: UltragoalPlan;
		goal?: UltragoalGoal;
		allComplete: boolean;
		nextAction?: UltragoalCompleteNextAction;
	},
	json: boolean,
	cwd: string,
): string {
	const nextAction =
		result.nextAction ??
		resolveUltragoalCompleteNextAction(result.plan, {
			selectedGoal: result.goal,
		});
	const goalsPath = getUltragoalPaths(cwd, currentUltragoalSessionId(cwd)).goalsPath;

	if (json) {
		const receipt: Record<string, unknown> = {
			ok: true,
			all_complete: result.allComplete,
			next_action: nextAction.kind,
			gjc_objective: result.plan.gjcObjective,
			goals_path: goalsPath,
		};
		if (nextAction.kind === "execute-goal" && nextAction.goal) {
			receipt.goal_id = nextAction.goal.id;
			receipt.goal_status = nextAction.goal.status;
		}
		if (nextAction.kind === "resolve-blockers" && nextAction.blockedGoals) {
			receipt.blocked_goals = nextAction.blockedGoals.map(summarizeBlockedGoalForHandoff);
			receipt.blocked_goal_ids = nextAction.blockedGoals.map(goal => goal.id);
			receipt.recovery_hints = [
				"gjc ultragoal classify-blocker --help",
				"gjc ultragoal record-review-blockers --help",
				"gjc ultragoal steer --kind add_subgoal --help",
				"gjc ultragoal steer --kind mark_blocked_superseded --help",
			];
		}
		if (nextAction.kind === "retry-failed" && nextAction.failedGoals) {
			receipt.failed_goal_ids = nextAction.failedGoals.map(goal => goal.id);
			receipt.recovery_hints = ["gjc ultragoal complete-goals --retry-failed"];
		}
		if (nextAction.kind === "final-aggregate-receipt") {
			receipt.recovery_hints = [
				"Finalize the aggregate completion receipt before treating the ultragoal run as closed.",
			];
		}
		return renderCliWriteReceipt(receipt);
	}

	if (nextAction.kind === "none" || (result.allComplete && nextAction.kind !== "final-aggregate-receipt")) {
		return "ultragoal complete all=true\n";
	}
	if (nextAction.kind === "final-aggregate-receipt") {
		return [
			"ultragoal next-action=final-aggregate-receipt",
			"hint=finalize the aggregate completion receipt before treating the run as closed",
			"",
		].join("\n");
	}
	if (nextAction.kind === "execute-goal" && nextAction.goal) {
		return [
			`ultragoal next-action=execute-goal goal-id=${nextAction.goal.id}`,
			`objective=${nextAction.goal.objective}`,
			`gjc-objective=${result.plan.gjcObjective}`,
			"checkpoint requires=architectReview:CLEAR+APPROVE,executorQa:passed",
			"",
		].join("\n");
	}
	if (nextAction.kind === "resolve-blockers" && nextAction.blockedGoals && nextAction.blockedGoals.length > 0) {
		const ids = nextAction.blockedGoals.map(goal => goal.id).join(",");
		const statuses = nextAction.blockedGoals.map(goal => `${goal.id}:${goal.status}`).join(",");
		return [
			"ultragoal next-action=resolve-blockers",
			`blocked-goal-ids=${ids}`,
			`blocked-statuses=${statuses}`,
			"hint=resolve blockers via classify-blocker / record-review-blockers / steer --kind add_subgoal (or audited mark_blocked_superseded); blocked goals stay unschedulable",
			"",
		].join("\n");
	}
	if (nextAction.kind === "retry-failed" && nextAction.failedGoals && nextAction.failedGoals.length > 0) {
		const ids = nextAction.failedGoals.map(goal => goal.id).join(",");
		return [
			"ultragoal next-action=retry-failed",
			`failed-goal-ids=${ids}`,
			"hint=run `gjc ultragoal complete-goals --retry-failed` after the failure is addressed",
			"",
		].join("\n");
	}
	// Fail closed: never claim complete or execute-goal without a goal id.
	return "ultragoal next-action=resolve-blockers\nhint=no schedulable goal; inspect goals.json and ledger\n";
}
function renderCheckpointContinuation(
	result: UltragoalCheckpointContinuation,
	status: UltragoalGoalStatus,
	json: boolean,
	cwd: string,
): string {
	if (json)
		return renderCliWriteReceipt({
			ok: true,
			goal_id: result.checkpointedGoal.id,
			status,
			goals_path: getUltragoalPaths(cwd, currentUltragoalSessionId(cwd)).goalsPath,
			completion_receipt_kind: result.checkpointedGoal.completionVerification?.receiptKind,
			quality_gate_hash: result.checkpointedGoal.completionVerification?.qualityGateHash,
			all_complete: result.allComplete,
			next_goal_id: result.nextGoal?.id,
			next_goal_status: result.nextGoal?.status,
			started_next: result.startedNext,
			incomplete_goal_ids: result.incompleteGoals.map(goal => goal.id),
		});
	const lines = [`Checkpointed ${result.checkpointedGoal.id} as ${status}.`];
	if (status === "complete") {
		if (result.allComplete) {
			lines.push("All ultragoal goals are complete.");
		} else if (result.nextGoal) {
			lines.push(`Next ultragoal goal: ${result.nextGoal.id} — ${result.nextGoal.title}`);
			lines.push(`Objective: ${result.nextGoal.objective}`);
			lines.push(`GJC objective: ${result.plan.gjcObjective}`);
			lines.push(
				result.startedNext
					? "The next ultragoal goal is active; continue the current aggregate GJC goal and checkpoint this story when verified."
					: "Run `gjc ultragoal complete-goals` to activate the next ultragoal story.",
			);
		}
	} else if (status === "failed") {
		lines.push("Resume failed goals with `gjc ultragoal complete-goals --retry-failed` after the blocker is fixed.");
	} else if (status === "blocked" || status === "review_blocked") {
		lines.push(
			"Blocked ultragoal work must be resolved with explicit blocker work or steering before final completion.",
		);
	}
	lines.push("");
	return lines.join("\n");
}

async function executeUltragoalSteeringCommand(args: readonly string[], cwd: string): Promise<SteeringCommandResult> {
	const kind = parseNativeSteeringKind(flagValue(args, "--kind"));
	const plan = await readUltragoalPlan(cwd);
	if (!plan) throw new Error("No ultragoal plan found. Run `gjc ultragoal create-goals --brief ...` first.");
	const evidence = flagValue(args, "--evidence") ?? "";
	const rationale = flagValue(args, "--rationale") ?? "";
	try {
		switch (kind) {
			case "add_subgoal": {
				const result = await addUltragoalSubgoalToPlan({
					cwd,
					plan,
					title: flagValue(args, "--title") ?? "",
					objective: flagValue(args, "--objective") ?? "",
					evidence,
					rationale,
				});
				return {
					kind,
					message: "Accepted add_subgoal steering.\n",
					receipt: {
						ok: true,
						kind,
						goal_id: result.goalId,
						goals_path: getUltragoalPaths(cwd, currentUltragoalSessionId(cwd)).goalsPath,
					},
				};
			}
			case "split_subgoal": {
				const result = await splitUltragoalSubgoal({
					cwd,
					plan,
					goalId: flagValue(args, "--goal-id") ?? "",
					replacementsJson: flagValue(args, "--replacements-json") ?? "",
					evidence,
					rationale,
				});
				return {
					kind,
					message: "Accepted split_subgoal steering.\n",
					receipt: {
						ok: true,
						kind,
						goal_id: result.goalId,
						replacement_goal_ids: result.replacementGoalIds,
						goals_path: getUltragoalPaths(cwd, currentUltragoalSessionId(cwd)).goalsPath,
					},
				};
			}
			case "reorder_pending": {
				const result = await reorderPendingUltragoalGoals({
					cwd,
					plan,
					orderJson: flagValue(args, "--order-json") ?? "",
					evidence,
					rationale,
				});
				return {
					kind,
					message: "Accepted reorder_pending steering.\n",
					receipt: {
						ok: true,
						kind,
						pending_goal_ids: result.pendingGoalIds,
						goals_path: getUltragoalPaths(cwd, currentUltragoalSessionId(cwd)).goalsPath,
					},
				};
			}
			case "revise_pending_wording": {
				const result = await revisePendingUltragoalWording({
					cwd,
					plan,
					goalId: flagValue(args, "--goal-id") ?? "",
					title: flagValue(args, "--title"),
					objective: flagValue(args, "--objective"),
					evidence,
					rationale,
				});
				return {
					kind,
					message: "Accepted revise_pending_wording steering.\n",
					receipt: {
						ok: true,
						kind,
						goal_id: result.goalId,
						changed_fields: result.changedFields,
						goals_path: getUltragoalPaths(cwd, currentUltragoalSessionId(cwd)).goalsPath,
					},
				};
			}
			case "annotate_ledger": {
				await annotateUltragoalLedger({ cwd, plan, evidence, rationale });
				return {
					kind,
					message: "Accepted annotate_ledger steering.\n",
					receipt: {
						ok: true,
						kind,
						ledger_path: getUltragoalPaths(cwd, currentUltragoalSessionId(cwd)).ledgerPath,
					},
				};
			}
			case "mark_blocked_superseded": {
				const result = await markBlockedUltragoalSuperseded({
					cwd,
					plan,
					goalId: flagValue(args, "--goal-id") ?? "",
					evidence,
					rationale,
				});
				return {
					kind,
					message: "Accepted mark_blocked_superseded steering.\n",
					receipt: {
						ok: true,
						kind,
						goal_id: result.goalId,
						no_replacement_required: true,
						goals_path: getUltragoalPaths(cwd, currentUltragoalSessionId(cwd)).goalsPath,
					},
				};
			}
		}
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		await appendSteeringRejected({
			cwd,
			kind,
			reason,
			goalId: flagValue(args, "--goal-id"),
			evidence,
			rationale,
			payload: steeringPayloadSummary(args),
		});
		throw error;
	}
}

async function dispatchUltragoalCommand(
	args: string[],
	cwd: string,
	agentDir?: string,
): Promise<UltragoalCommandResult> {
	// Help must not require a resolvable session; render it before session resolution.
	const help = renderUltragoalHelp(args);
	if (help) return { status: 0, stdout: help };
	let sessionId: string;
	try {
		sessionId = currentUltragoalSessionId(cwd);
	} catch (error) {
		// A missing/ambiguous session is an operator input error, not a crash:
		// surface the guidance on stderr instead of an uncaught-exception dump.
		if (error instanceof SessionResolutionError) return { status: 1, stderr: `${error.message}\n` };
		throw error;
	}
	try {
		const command = commandName(args);
		const json = hasFlag(args, "--json");
		switch (command) {
			case "status":
				return { status: 0, stdout: renderStatus(await getUltragoalStatus(cwd, sessionId, agentDir), json) };
			case "create":
			case "create-goals": {
				const mode = flagValue(args, "--gjc-goal-mode") === "per-story" ? "per-story" : "aggregate";
				const plan = await createUltragoalPlan({
					cwd,
					brief: await readBrief(cwd, args),
					gjcGoalMode: mode,
					validationBatchJson: flagValue(args, "--validation-batch-json"),
				});
				return {
					status: 0,
					createdPlan: true,
					stdout: json
						? renderCliWriteReceipt({
								ok: true,
								goals_count: plan.goals.length,
								goal_ids: plan.goals.map(goal => goal.id),
								goals_path: getUltragoalPaths(cwd, currentUltragoalSessionId(cwd)).goalsPath,
							})
						: `Created ultragoal plan with ${plan.goals.length} goal${plan.goals.length === 1 ? "" : "s"} at ${getUltragoalPaths(cwd, currentUltragoalSessionId(cwd)).goalsPath}.\n`,
				};
			}
			case "complete-goals":
				return {
					status: 0,
					stdout: renderCompleteHandoff(
						await startNextUltragoalGoal({ cwd, retryFailed: hasFlag(args, "--retry-failed") }),
						json,
						cwd,
					),
				};
			case "checkpoint": {
				const goalId = flagValue(args, "--goal-id") ?? "";
				const status = parseGoalStatus(flagValue(args, "--status"));
				const evidence = flagValue(args, "--evidence") ?? "";
				const result = await checkpointAndContinueUltragoalGoal({
					cwd,
					goalId,
					status,
					evidence,
					qualityGateJson: flagValue(args, "--quality-gate-json"),
					advanceNext: status === "complete",
				});
				return {
					status: 0,
					stdout: renderCheckpointContinuation(result, status, json, cwd),
				};
			}
			case "quality-gate": {
				const positional = args.filter(arg => !arg.startsWith("-"));
				const subcommand = positional[1];
				if (subcommand === "source-hash") {
					const changeSet = await computeCheckpointChangeSet(cwd);
					const sourceHash = computeUltragoalReviewSourceHash(changeSet);
					if (!sourceHash) {
						return {
							status: 1,
							stderr:
								"Unable to compute an authoritative source hash: change-set capture is incomplete, untrusted, or contains unknown-status paths.\n",
						};
					}
					const payload = {
						sourceHash,
						baseRef: changeSet?.baseRef,
						mergeBase: changeSet?.mergeBase,
						headRef: changeSet?.headRef,
						pathCount: changeSet?.paths.length ?? 0,
					};
					return json
						? { status: 0, stdout: `${JSON.stringify(payload, null, 2)}\n` }
						: { status: 0, stdout: `${sourceHash}\n` };
				}
				if (subcommand === "lane-selection") {
					// #4560: expose the authoritative computed selection so a caller can
					// declare `validationLaneSelection` without running or fabricating the
					// very lanes the selection may omit.
					const sessionId = currentUltragoalSessionId(cwd);
					const changeSet = await computeCheckpointChangeSet(cwd);
					const plan = await readUltragoalPlan(cwd, sessionId).catch(() => null);
					const ledger = await readUltragoalLedger(cwd, sessionId).catch(() => null);
					const authoritativeSourceHash = computeUltragoalReviewSourceHash(changeSet);
					const applicability = resolveUltragoalValidationApplicability({
						changeSet,
						requiredGoals: plan?.goals.filter(goal => goal.status !== "superseded").length,
						hasOpenReviewBlockers: plan?.goals.some(goal => goal.status === "review_blocked") ?? false,
						latestCohortSourceHash: ledger ? latestJoinedCohortSourceHash(ledger)?.sourceHash : undefined,
						currentSourceHash: authoritativeSourceHash ?? undefined,
						authoritativeSourceHash,
					});
					const laneSelection = validationLaneSelectionFor(applicability);
					const payload = {
						validationLaneSelection: laneSelection,
						basisUnchanged: applicability.basisUnchanged,
						sourceHash: authoritativeSourceHash,
					};
					return json
						? { status: 0, stdout: `${JSON.stringify(payload, null, 2)}\n` }
						: {
								status: 0,
								stdout: `riskClass=${applicability.riskClass} omittedLanes=${laneSelection.omittedLanes.join(",") || "(none)"}\n`,
							};
				}
				if (subcommand === "init") {
					const out = flagValue(args, "--out");
					if (!out?.trim()) {
						return { status: 1, stderr: "quality-gate init requires --out <path>\n" };
					}
					const surfaces = flagValues(args, "--surface");
					const template = buildQualityGateInitTemplate(surfaces);
					const resolved = path.resolve(cwd, out);
					await Bun.write(resolved, `${JSON.stringify(template, null, 2)}\n`);
					if (json) {
						return {
							status: 0,
							stdout: `${JSON.stringify({ ok: true, out: resolved, surfaces: surfaces.length > 0 ? surfaces : ["web"] }, null, 2)}\n`,
						};
					}
					return {
						status: 0,
						stdout: `Wrote quality-gate template to ${resolved}\n`,
					};
				}
				if (subcommand !== "validate") {
					return {
						status: 1,
						stderr: `Unknown gjc ultragoal quality-gate subcommand: ${subcommand ?? "(missing)"}; supported: init, source-hash, lane-selection, validate\n`,
					};
				}
				const qualityGateJson = flagValue(args, "--quality-gate-json");
				if (!qualityGateJson?.trim()) {
					return { status: 1, stderr: "quality-gate validate requires --quality-gate-json\n" };
				}
				const result = await validateUltragoalQualityGateReadOnly({
					cwd,
					qualityGateJson,
					goalId: flagValue(args, "--goal-id"),
				});
				if (json) {
					return {
						status: result.valid ? 0 : 1,
						stdout: `${JSON.stringify({ valid: result.valid, errors: result.errors }, null, 2)}\n`,
					};
				}
				if (result.valid) return { status: 0, stdout: "quality gate is valid.\n" };
				return {
					status: 1,
					stderr: `${result.errors.length} quality-gate error(s):\n${result.errors
						.map(diagnostic => `  ${diagnostic.path} [${diagnostic.code}]: ${diagnostic.message}`)
						.join("\n")}\n`,
				};
			}
			case "review": {
				const result = await runUltragoalReview(cwd, args);
				return {
					status: 0,
					stdout: json ? `${JSON.stringify(result, null, 2)}\n` : `${result.verdict}\n`,
					reviewBlockerGoalIds: result.blockerGoalIds,
					createdReviewPlan: (result.blockerGoalIds?.length ?? 0) > 0,
				};
			}
			case "steer": {
				const result = await executeUltragoalSteeringCommand(args, cwd);
				return {
					status: 0,
					stdout: json ? renderCliWriteReceipt(result.receipt) : result.message,
				};
			}
			case "record-review-blockers": {
				const { blockerGoalId } = await recordUltragoalReviewBlockers({
					cwd,
					goalId: flagValue(args, "--goal-id") ?? "",
					title: flagValue(args, "--title") ?? "Resolve final code-review blockers",
					objective: flagValue(args, "--objective") ?? "",
					evidence: flagValue(args, "--evidence") ?? "",
				});
				return {
					status: 0,
					stdout: json
						? renderCliWriteReceipt({
								ok: true,
								goal_id: blockerGoalId,
								goals_path: getUltragoalPaths(cwd, currentUltragoalSessionId(cwd)).goalsPath,
							})
						: "Recorded review blockers.\n",
				};
			}
			case "classify-blocker": {
				const event = await recordUltragoalBlockerClassification({
					cwd,
					classification: (flagValue(args, "--classification") ?? "") as UltragoalBlockerClassification,
					evidence: flagValue(args, "--evidence") ?? "",
					goalId: flagValue(args, "--goal-id"),
				});
				return {
					status: 0,
					stdout: json
						? renderCliWriteReceipt({
								ok: true,
								event: "blocker_classified",
								classification: event.classification,
								event_id: event.eventId,
							})
						: `Recorded blocker classification: ${String(event.classification)} event-id=${String(event.eventId)}.\n`,
				};
			}
			case "record-critic-verdict": {
				const blockersJson = flagValue(args, "--blockers-json");
				const blockers =
					blockersJson === undefined ? undefined : stringArray(await readStructuredValue(cwd, blockersJson));
				if (blockersJson !== undefined && !blockers) {
					throw new Error("record-critic-verdict --blockers-json must be a JSON string array");
				}
				const event = await recordUltragoalCriticVerdict({
					cwd,
					terminus: (flagValue(args, "--terminus") ?? "") as "completion" | "pause",
					verdict: (flagValue(args, "--verdict") ?? "") as CriticVerdict,
					evidence: flagValue(args, "--evidence") ?? "",
					blockers: blockers ?? undefined,
					goalId: flagValue(args, "--goal-id"),
					classificationEventId: flagValue(args, "--classification-event-id"),
				});
				return {
					status: 0,
					stdout: json
						? renderCliWriteReceipt({
								ok: true,
								event: CRITIC_VERDICT_EVENT,
								terminus: event.terminus,
								verdict: event.verdict,
							})
						: `Recorded critic verdict: ${String(event.verdict)} (${String(event.terminus)}).\n`,
				};
			}
			case "record-critic-gate-override": {
				const event = await recordUltragoalCriticGateOverride({
					cwd,
					evidence: flagValue(args, "--evidence") ?? "",
				});
				return {
					status: 0,
					stdout: json
						? renderCliWriteReceipt({
								ok: true,
								event: CRITIC_GATE_OVERRIDE_EVENT,
								event_id: event.eventId,
							})
						: `Recorded terminal critic gate override event-id=${String(event.eventId)}.\n`,
				};
			}
			default:
				return { status: 1, stderr: `Unknown gjc ultragoal command: ${command}\n` };
		}
	} catch (error) {
		return { status: 1, stderr: `${error instanceof Error ? error.message : String(error)}\n` };
	}
}

const RECONCILE_COMMANDS = new Set([
	"status",
	"create",
	"create-goals",
	"complete-goals",
	"checkpoint",
	"steer",
	"record-review-blockers",
	"review",
	"classify-blocker",
	"record-critic-verdict",
	"record-critic-gate-override",
]);

/**
 * Derive a workflow-state payload from the ultragoal plan/ledger and reconcile the
 * ultragoal mode-state + active-state/HUD so `gjc state ultragoal read`, the
 * skill-tool chain guard, and the HUD chip mirror the plan/ledger. Session scope
 * follows `gjc state` (`GJC_SESSION_ID`). This is a derived repair: it never changes
 * the triggering command's status/stdout, but a failure is surfaced (stderr + a
 * `reconcile_failed` ledger audit event) rather than silently swallowed. `status` is
 * therefore a read PLUS a derived repair; it never mutates goals.json/ledger.jsonl
 * beyond that reconcile-failure audit event.
 */
async function reconcileUltragoalState(cwd: string, agentDir?: string): Promise<void> {
	const sessionId = currentUltragoalSessionId(cwd);
	try {
		const summary = await getUltragoalStatus(cwd, sessionId, agentDir);
		const status = summary.status;
		const active = summary.exists && status !== "complete";
		const payload: Record<string, unknown> = {
			skill: "ultragoal",
			status,
			current_phase: status,
			active,
			goals: summary.goals.map(goal => ({ id: goal.id, title: goal.title, status: goal.status })),
			counts: summary.counts,
			active_goal_id: summary.currentGoal?.id ?? null,
			ledger_path: summary.paths.ledgerPath,
			brief_path: summary.paths.briefPath,
			goals_path: summary.paths.goalsPath,
		};
		if (summary.gjcObjective) payload.gjc_objective = summary.gjcObjective;
		if (summary.nudgeBudget !== undefined) payload.nudge_budget = summary.nudgeBudget;
		if (summary.nudgeCount !== undefined) payload.nudge_count = summary.nudgeCount;
		if (summary.nudgeRemaining !== undefined) payload.nudge_remaining = summary.nudgeRemaining;
		if (summary.nudgeGoalId !== undefined) payload.nudge_goal_id = summary.nudgeGoalId;
		if (summary.nudgeTargetKind !== undefined) payload.nudge_target_kind = summary.nudgeTargetKind;
		const ledgerText = await Bun.file(summary.paths.ledgerPath)
			.text()
			.catch(() => "");
		const latestLedger = ledgerText
			.split(/\r?\n/)
			.map(line => line.trim())
			.filter(Boolean)
			.toReversed()
			.map(line => {
				try {
					const row = JSON.parse(line) as Record<string, unknown>;
					const event =
						typeof row.event === "string" ? row.event : typeof row.type === "string" ? row.type : undefined;
					return event ? { ...row, event } : undefined;
				} catch {
					return undefined;
				}
			})
			.find((row): row is Record<string, unknown> & { event: string } => Boolean(row));
		if (latestLedger) {
			payload.latestLedgerEvent = {
				event: latestLedger.event,
				...(latestLedger.goalId ? { goalId: latestLedger.goalId } : {}),
				...(latestLedger.timestamp ? { timestamp: latestLedger.timestamp } : {}),
				...(typeof latestLedger.kind === "string" ? { kind: latestLedger.kind } : {}),
				...(typeof latestLedger.evidence === "string" ? { evidence: latestLedger.evidence } : {}),
			};
		}
		const sourceRevision = Math.max(
			persistedStateRevision(await readUltragoalPlan(cwd, sessionId)),
			ledgerText.split(/\r?\n/).filter(line => line.trim().length > 0).length,
		);
		await reconcileWorkflowSkillState({
			cwd,
			mode: "ultragoal",
			sessionId,
			active,
			phase: status,
			payload,
			...(sourceRevision > 0 ? { sourceRevision } : {}),
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		process.stderr.write(`ultragoal state reconciliation failed: ${message}\n`);
		try {
			await appendLedger(cwd, { type: "reconcile_failed", error: message });
		} catch {
			// Best-effort audit; never let a secondary failure change command semantics.
		}
	}
}

export async function runNativeUltragoalCommand(
	args: string[],
	cwd = process.cwd(),
	options: { agentDir?: string } = {},
): Promise<UltragoalCommandResult> {
	const command = commandName(args);
	const result = await dispatchUltragoalCommand(args, cwd, options.agentDir);
	const isHelp = args.some(isHelpArg) || args[0] === "help";
	if (!isHelp && result.status === 0 && RECONCILE_COMMANDS.has(command)) {
		await reconcileUltragoalState(cwd, options.agentDir);
	}
	return result;
}
