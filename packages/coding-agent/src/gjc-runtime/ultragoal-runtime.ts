import * as crypto from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import type { WorkflowHudSummary } from "../skill-state/active-state";
import { buildUltragoalHudSummary as buildWorkflowUltragoalHudSummary } from "../skill-state/workflow-hud";
import { renderCliWriteReceipt } from "./cli-write-receipt";
import { DEFAULT_ULTRAGOAL_OBJECTIVE } from "./goal-mode-request";
import {
	CRITIC_GATE_HARD_STOP_EVENT,
	CRITIC_GATE_OVERRIDE_EVENT,
	CRITIC_VERDICT_EVENT,
	type CriticVerdict,
	computeCriticVerdictPlanGeneration,
	computeUltragoalPlanGeneration,
	countNonOkayTerminalCriticVerdicts,
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

export type UltragoalPipelineMetadataSource = "original_plan_graph" | "legacy_brief_only" | "steering";
export type UltragoalPipelineOverlapState =
	| "none"
	| "open"
	| "joined_clean"
	| "blocked_disjoint_continue"
	| "quarantine_required"
	| "rebaseline_complete";

export interface UltragoalPipelineTargets extends JsonObject {
	files: string[];
	surfaces: string[];
}

export interface UltragoalPipelineMetadata extends JsonObject {
	schemaVersion: 1;
	goalId: string;
	source: UltragoalPipelineMetadataSource;
	eligible: boolean;
	dependsOn: string[];
	independentOf: string[];
	targets: UltragoalPipelineTargets;
	metadataHash: string;
	overlap: UltragoalPipelineOverlapState;
	overlapId?: string;
	priorGoalId?: string;
	nextGoalId?: string;
	blockerFootprints?: UltragoalPipelineTargets[];
	invalidationReason?: string;
	invalidatedAt?: string;
}

export interface UltragoalGoalMetadataInput {
	schemaVersion: 1;
	goalId: string;
	source: UltragoalPipelineMetadataSource;
	dependsOn?: string[];
	independentOf?: string[];
	targets?: Partial<UltragoalPipelineTargets>;
}

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

export interface UltragoalPipelineOverlapHandles extends JsonObject {
	review: JsonObject;
	qa: JsonObject;
	implementation: JsonObject;
}

export interface UltragoalPipelineOverlapReceipt extends JsonObject {
	ok: true;
	event: string;
	overlap_id: string;
	prior_goal_id: string;
	next_goal_id?: string;
	goal_id?: string;
	status?: UltragoalPipelineOverlapState;
	next_goal_status?: UltragoalGoalStatus;
	goals_path: string;
	ledger_path: string;
}

export type UltragoalPipelineLedgerEventName =
	| "pipeline_overlap_started"
	| "pipeline_overlap_joined"
	| "pipeline_overlap_blocked"
	| "pipeline_overlap_quarantined"
	| "pipeline_overlap_rebaselined";

export interface UltragoalPipelineLedgerEvent extends UltragoalLedgerEvent {
	event: UltragoalPipelineLedgerEventName;
	schemaVersion: 1;
	overlapId: string;
	priorGoalId: string;
	nextGoalId: string;
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
	pipelineMetadata?: UltragoalPipelineMetadata;
	validationBatch?: UltragoalValidationBatchMetadata;
}

export interface UltragoalPlan {
	version: 1;
	brief: string;
	gjcGoalMode: UltragoalGjcGoalMode;
	gjcObjective: string;
	gjcObjectiveAliases?: string[];
	goals: UltragoalGoal[];
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
	pipelineOverlap?: JsonObject;
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

async function readSettingsNudgeBudget(settingsPath: string): Promise<number | null> {
	try {
		const raw = await Bun.file(settingsPath).text();
		const parsed = JSON.parse(raw) as Record<string, unknown>;
		// Support both the flat dotted key and a nested gjc.ultragoal.nudgeBudget shape.
		const flat = parseNudgeBudgetValue(parsed["gjc.ultragoal.nudgeBudget"]);
		if (flat !== null) return flat;
		const gjc = parsed.gjc;
		if (gjc && typeof gjc === "object") {
			const ultragoal = (gjc as Record<string, unknown>).ultragoal;
			if (ultragoal && typeof ultragoal === "object") {
				return parseNudgeBudgetValue((ultragoal as Record<string, unknown>).nudgeBudget);
			}
		}
		return null;
	} catch {
		return null;
	}
}

/**
 * Resolve the per-story nudge budget. Project `./.gjc/settings.json` overrides the
 * user settings (`$GJC_CONFIG_DIR/settings.json` or `~/.gjc/settings.json`), else the
 * default. Mirrors the `gjc.deepInterview.ambiguityThreshold` user+project precedence.
 */
export async function resolveUltragoalNudgeBudget(cwd: string): Promise<{ budget: number; source: string }> {
	const projectPath = path.join(gjcRoot(cwd), "settings.json");
	const project = await readSettingsNudgeBudget(projectPath);
	if (project !== null) return { budget: project, source: projectPath };
	const userDir = process.env.GJC_CONFIG_DIR?.trim() || path.join(os.homedir(), ".gjc");
	const userPath = path.join(userDir, "settings.json");
	const user = await readSettingsNudgeBudget(userPath);
	if (user !== null) return { budget: user, source: userPath };
	return { budget: DEFAULT_ULTRAGOAL_NUDGE_BUDGET, source: "default" };
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
export function stringArray(value: unknown): string[] | null {
	return Array.isArray(value) && value.every(item => typeof item === "string") ? value.map(item => item.trim()) : null;
}

function normalizePipelineStringArray(value: unknown, fieldName: string): string[] {
	const items = stringArray(value) ?? [];
	const filtered = items.filter(item => item.length > 0);
	if (items.length !== filtered.length) throw new Error(`${fieldName} must contain only non-empty strings`);
	return filtered;
}

function normalizePipelinePath(value: string, fieldName: string): string {
	const raw = value.trim();
	if (raw.split(/[\\/]+/).includes("..")) throw new Error(`${fieldName} contains unsafe path ${value}`);
	const normalized = normalizeRepoPath(raw);
	if (
		!normalized ||
		normalized.startsWith("../") ||
		normalized === ".." ||
		path.isAbsolute(normalized) ||
		normalized.includes("\0")
	) {
		throw new Error(`${fieldName} contains unsafe path ${value}`);
	}
	return normalized;
}

function normalizePipelineTargets(value: unknown, fieldName: string): UltragoalPipelineTargets {
	const record = typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonObject) : {};
	const files = normalizePipelineStringArray(record.files, `${fieldName}.files`).map(item =>
		normalizePipelinePath(item, `${fieldName}.files`),
	);
	const surfaces = normalizePipelineStringArray(record.surfaces, `${fieldName}.surfaces`).map(normalizeSurfaceToken);
	if (new Set(files).size !== files.length) throw new Error(`${fieldName}.files contains duplicate normalized paths`);
	if (new Set(surfaces).size !== surfaces.length)
		throw new Error(`${fieldName}.surfaces contains duplicate normalized surfaces`);
	return { files, surfaces };
}

function pipelineMetadataHashBasis(metadata: Omit<UltragoalPipelineMetadata, "metadataHash">): JsonObject {
	return {
		schemaVersion: metadata.schemaVersion,
		goalId: metadata.goalId,
		source: metadata.source,
		dependsOn: metadata.dependsOn,
		independentOf: metadata.independentOf,
		targets: metadata.targets,
	};
}

export function hashPipelineMetadata(metadata: Omit<UltragoalPipelineMetadata, "metadataHash">): string {
	return hashStructuredValue(pipelineMetadataHashBasis(metadata));
}

function withPipelineMetadataHash(
	metadata: Omit<UltragoalPipelineMetadata, "metadataHash">,
): UltragoalPipelineMetadata {
	return { ...metadata, metadataHash: hashPipelineMetadata(metadata) } as UltragoalPipelineMetadata;
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

function pipelineMetadataConflictsWithValidationBatch(metadata: UltragoalPipelineMetadata | undefined): boolean {
	return metadata?.eligible === true || metadata?.source === "original_plan_graph" || metadata?.source === "steering";
}

export function validateValidationBatchPipelineExclusion(goal: UltragoalGoal): void {
	if (goal.validationBatch && pipelineMetadataConflictsWithValidationBatch(goal.pipelineMetadata)) {
		throw new Error(`Goal ${goal.id} cannot combine validationBatch with eligible pipeline metadata`);
	}
}
function requireFreshValidationBatchMetadata(goal: UltragoalGoal): UltragoalValidationBatchMetadata | undefined {
	const metadata = goal.validationBatch;
	if (!metadata) return undefined;
	const { metadataHash, ...basis } = metadata;
	if (metadataHash !== hashValidationBatch(basis))
		throw new Error(`Goal ${goal.id} has stale validation batch metadata hash`);
	validateValidationBatchPipelineExclusion(goal);
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
function legacyPipelineMetadata(goalId: string): UltragoalPipelineMetadata {
	const basis: Omit<UltragoalPipelineMetadata, "metadataHash"> = {
		schemaVersion: 1,
		goalId,
		source: "legacy_brief_only",
		eligible: false,
		dependsOn: [],
		independentOf: [],
		targets: { files: [], surfaces: [] },
		overlap: "none",
		invalidationReason: "missing_pipeline_metadata",
	};
	return withPipelineMetadataHash(basis);
}

function normalizePipelineMetadataRecord(value: unknown, goalIds: ReadonlySet<string>): UltragoalPipelineMetadata {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new Error("goal metadata rows must be objects");
	const record = value as JsonObject;
	if (record.schemaVersion !== 1) throw new Error("goal metadata schemaVersion must be 1");
	const goalId = nonEmptyString(record.goalId);
	if (!goalId || !goalIds.has(goalId)) throw new Error(`goal metadata references unknown goal id ${goalId ?? ""}`);
	const source = record.source;
	if (source !== "original_plan_graph" && source !== "legacy_brief_only" && source !== "steering") {
		throw new Error("goal metadata source must be original_plan_graph, legacy_brief_only, or steering");
	}
	const dependsOn = normalizePipelineStringArray(record.dependsOn, `metadata ${goalId}.dependsOn`);
	const independentOf = normalizePipelineStringArray(record.independentOf, `metadata ${goalId}.independentOf`);
	if (dependsOn.includes(goalId) || independentOf.includes(goalId))
		throw new Error(`goal metadata ${goalId} cannot reference itself`);
	for (const id of [...dependsOn, ...independentOf]) {
		if (!goalIds.has(id)) throw new Error(`goal metadata ${goalId} references unknown goal id ${id}`);
	}
	if (dependsOn.some(id => independentOf.includes(id)))
		throw new Error(`goal metadata ${goalId} has dependency/independence conflict`);
	const targets = requireNonEmptyPipelineTargets(record.targets, `metadata ${goalId}.targets`);
	const basis: Omit<UltragoalPipelineMetadata, "metadataHash"> = {
		schemaVersion: 1,
		goalId,
		source,
		eligible: false,
		dependsOn,
		independentOf,
		targets,
		overlap: "none",
	};
	return withPipelineMetadataHash(basis);
}

export function targetsAreDisjoint(left: UltragoalPipelineTargets, right: UltragoalPipelineTargets): boolean {
	return (
		left.files.every(file => !right.files.includes(file)) &&
		left.surfaces.every(surface => !right.surfaces.includes(surface))
	);
}

export function targetsOverlap(left: UltragoalPipelineTargets, right: UltragoalPipelineTargets): boolean {
	return (
		left.files.some(file => right.files.includes(file)) ||
		left.surfaces.some(surface => right.surfaces.includes(surface))
	);
}

export function requireNonEmptyPipelineTargets(value: unknown, fieldName: string): UltragoalPipelineTargets {
	const targets = normalizePipelineTargets(value, fieldName);
	if (targets.files.length === 0 && targets.surfaces.length === 0)
		throw new Error(`${fieldName} requires files or surfaces`);
	return targets;
}

export function collectPipelineBlockerFootprints(result: JsonObject, fieldName: string): UltragoalPipelineTargets[] {
	const raw = Array.isArray(result.blockers)
		? result.blockers
		: Array.isArray(result.blockerFootprints)
			? result.blockerFootprints
			: [];
	return raw.map((item, index) => {
		const record = requireJsonObjectValue(item, `${fieldName}.blockers[${index}]`);
		const footprint = typeof record.footprint === "object" && record.footprint !== null ? record.footprint : record;
		return requireNonEmptyPipelineTargets(footprint, `${fieldName}.blockers[${index}].footprint`);
	});
}

function pipelineTargetsCoverPath(targets: UltragoalPipelineTargets, filePath: string): boolean {
	const normalized = normalizeRepoPath(filePath);
	return targets.files.some(target => normalized === target || normalized.startsWith(`${target}/`));
}

export function pipelinePeer(plan: UltragoalPlan, metadata: UltragoalPipelineMetadata): UltragoalGoal | undefined {
	const peerId = metadata.goalId === metadata.priorGoalId ? metadata.nextGoalId : metadata.priorGoalId;
	return peerId ? plan.goals.find(goal => goal.id === peerId) : undefined;
}

export function handleIdsFromValue(value: JsonObject | JsonObject[], fieldName: string): string[] {
	const records = Array.isArray(value) ? value : [value];
	const ids = records.map(
		(record, index) =>
			nonEmptyString(record.id) ??
			nonEmptyString(record.handleId) ??
			nonEmptyString(record.name) ??
			`${fieldName}-${index}`,
	);
	if (ids.some(id => id.length === 0)) throw new Error(`${fieldName} handles require ids`);
	return ids;
}

export function resultHandleIds(value: JsonObject, fieldName: string): string[] {
	const ids = stringArray(value.handleIds) ?? stringArray(value.handles) ?? [];
	if (ids.length === 0) throw new Error(`${fieldName} requires handleIds`);
	return ids;
}

export function requireCoveredHandles(expected: readonly string[], actual: readonly string[], fieldName: string): void {
	const missing = expected.filter(id => !actual.includes(id));
	if (missing.length > 0) throw new Error(`${fieldName} is missing handle coverage for ${missing.join(", ")}`);
}

function validatePipelineEligibility(metadata: UltragoalPipelineMetadata[]): UltragoalPipelineMetadata[] {
	const byId = new Map(metadata.map(item => [item.goalId, item]));
	return metadata.map(item => {
		const invalidationReasons: string[] = [];
		if (item.source !== "original_plan_graph") invalidationReasons.push("not_original_plan_graph");
		if (item.targets.files.length === 0 && item.targets.surfaces.length === 0)
			invalidationReasons.push("empty_targets");
		for (const otherId of item.independentOf) {
			const other = byId.get(otherId);
			if (!other?.independentOf.includes(item.goalId))
				invalidationReasons.push(`missing_symmetric_independence:${otherId}`);
			if (other && !targetsAreDisjoint(item.targets, other.targets))
				invalidationReasons.push(`shared_targets:${otherId}`);
		}
		const eligible = invalidationReasons.length === 0;
		return {
			...item,
			eligible,
			...(eligible ? {} : { invalidationReason: invalidationReasons.join(",") || "ineligible" }),
		};
	});
}

function parseGoalMetadataInput(value: unknown, goalIds: ReadonlySet<string>): UltragoalPipelineMetadata[] {
	if (!Array.isArray(value)) throw new Error("goal metadata JSON must be an array");
	const seen = new Set<string>();
	const metadata = value.map(row => {
		const item = normalizePipelineMetadataRecord(row, goalIds);
		if (seen.has(item.goalId)) throw new Error(`duplicate goal metadata for ${item.goalId}`);
		seen.add(item.goalId);
		return item;
	});
	return validatePipelineEligibility(metadata);
}
function normalizeSavedPipelineMetadata(value: unknown, goalId: string): UltragoalPipelineMetadata | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const record = value as JsonObject;
	const source =
		record.source === "original_plan_graph" || record.source === "legacy_brief_only" || record.source === "steering"
			? record.source
			: "legacy_brief_only";
	const overlap =
		record.overlap === "open" ||
		record.overlap === "joined_clean" ||
		record.overlap === "blocked_disjoint_continue" ||
		record.overlap === "quarantine_required" ||
		record.overlap === "rebaseline_complete"
			? record.overlap
			: "none";
	const basis: Omit<UltragoalPipelineMetadata, "metadataHash"> = {
		schemaVersion: 1,
		goalId,
		source,
		eligible: record.eligible === true,
		dependsOn: normalizePipelineStringArray(record.dependsOn, `metadata ${goalId}.dependsOn`),
		independentOf: normalizePipelineStringArray(record.independentOf, `metadata ${goalId}.independentOf`),
		targets: normalizePipelineTargets(record.targets, `metadata ${goalId}.targets`),
		overlap,
		...(nonEmptyString(record.overlapId) ? { overlapId: nonEmptyString(record.overlapId)! } : {}),
		...(nonEmptyString(record.priorGoalId) ? { priorGoalId: nonEmptyString(record.priorGoalId)! } : {}),
		...(nonEmptyString(record.nextGoalId) ? { nextGoalId: nonEmptyString(record.nextGoalId)! } : {}),
		...(Array.isArray(record.blockerFootprints)
			? {
					blockerFootprints: record.blockerFootprints.map((item, index) =>
						normalizePipelineTargets(item, `metadata ${goalId}.blockerFootprints[${index}]`),
					),
				}
			: {}),
		...(nonEmptyString(record.invalidationReason)
			? { invalidationReason: nonEmptyString(record.invalidationReason)! }
			: {}),
		...(nonEmptyString(record.invalidatedAt) ? { invalidatedAt: nonEmptyString(record.invalidatedAt)! } : {}),
	};
	return {
		...basis,
		metadataHash: nonEmptyString(record.metadataHash) ?? hashPipelineMetadata(basis),
	} as UltragoalPipelineMetadata;
}

function currentPipelineHash(metadata: UltragoalPipelineMetadata): string {
	return hashPipelineMetadata(metadata);
}

export function requireFreshPipelineMetadata(goal: UltragoalGoal): UltragoalPipelineMetadata {
	const metadata = goal.pipelineMetadata;
	if (!metadata) throw new Error(`Goal ${goal.id} has no pipeline metadata`);
	if (metadata.metadataHash !== currentPipelineHash(metadata))
		throw new Error(`Goal ${goal.id} has stale pipeline metadata hash`);
	return metadata;
}

export function openPipelineOverlap(
	plan: UltragoalPlan,
): { prior: UltragoalGoal; next: UltragoalGoal; overlapId: string } | null {
	const openGoals = plan.goals.filter(goal => goal.pipelineMetadata?.overlap === "open");
	if (openGoals.length === 0) return null;
	const overlapId = openGoals[0]?.pipelineMetadata?.overlapId;
	if (!overlapId) return null;
	const peers = openGoals.filter(goal => goal.pipelineMetadata?.overlapId === overlapId);
	if (peers.length !== 2) return null;
	const prior = peers[0];
	const next = peers[1];
	if (!prior || !next) return null;
	return { prior, next, overlapId };
}

function invalidatePipelineMetadata(goal: UltragoalGoal, reason: string, now: string): void {
	const basis: Omit<UltragoalPipelineMetadata, "metadataHash"> = {
		schemaVersion: 1,
		goalId: goal.id,
		source: goal.pipelineMetadata?.source ?? "steering",
		eligible: false,
		dependsOn: goal.pipelineMetadata?.dependsOn ?? [],
		independentOf: goal.pipelineMetadata?.independentOf ?? [],
		targets: goal.pipelineMetadata?.targets ?? { files: [], surfaces: [] },
		overlap: "none",
		invalidationReason: reason,
		invalidatedAt: now,
	};
	goal.pipelineMetadata = withPipelineMetadataHash(basis);
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
		const pipelineMetadata = normalizeSavedPipelineMetadata(goalRecord.pipelineMetadata, id);
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
			pipelineMetadata,
			validationBatch,
		};
	});
	const aliases = Array.isArray(record.gjcObjectiveAliases)
		? record.gjcObjectiveAliases.filter(
				(value): value is string => typeof value === "string" && value.trim().length > 0,
			)
		: undefined;
	return {
		version: 1,
		brief,
		gjcGoalMode,
		gjcObjective,
		gjcObjectiveAliases: aliases,
		goals,
		createdAt,
		updatedAt,
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

export async function getUltragoalStatus(cwd: string, sessionId?: string | null): Promise<UltragoalStatusSummary> {
	const resolvedSessionId =
		sessionId?.trim() ||
		(await resolveGjcSessionForRead(cwd, { envSessionId: process.env.GJC_SESSION_ID })).gjcSessionId;
	const paths = getUltragoalPaths(cwd, resolvedSessionId);
	const plan = await readUltragoalPlan(cwd, resolvedSessionId);
	const counts = emptyCounts();
	if (!plan) return { exists: false, status: "missing", paths, counts, goals: [] };
	for (const goal of plan.goals) counts[goal.status] += 1;
	const currentGoal = plan.goals.find(goal => SCHEDULABLE_STATUSES.has(goal.status));
	const overlap = openPipelineOverlap(plan);
	let status: UltragoalStatusSummary["status"] = "pending";
	if (plan.goals.length > 0 && plan.goals.every(goal => TERMINAL_OR_SKIPPED_STATUSES.has(goal.status)))
		status = "complete";
	else if (counts.active > 0) status = "active";
	else if (counts.failed > 0) status = "failed";
	else if (counts.blocked > 0 || counts.review_blocked > 0) status = "blocked";
	const nudgeTarget = selectUltragoalNudgeTarget(plan, { currentGoalObjective: currentGoal?.objective });
	let nudgeFields: Partial<UltragoalStatusSummary> = {};
	if (nudgeTarget) {
		const { budget } = await resolveUltragoalNudgeBudget(cwd);
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
		...(overlap
			? {
					pipelineOverlap: {
						overlapId: overlap.overlapId,
						priorGoalId: overlap.prior.id,
						nextGoalId: overlap.next.id,
						status: overlap.next.pipelineMetadata?.overlap,
					},
				}
			: {}),
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
	goalMetadata?: UltragoalGoalMetadataInput[];
	goalMetadataJson?: string;
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
	const metadataInput = input.goalMetadataJson
		? await readStructuredValue(input.cwd, input.goalMetadataJson)
		: input.goalMetadata;
	const validationBatchInput = input.validationBatchJson
		? await readStructuredValue(input.cwd, input.validationBatchJson)
		: input.validationBatches;
	if (metadataInput !== undefined && validationBatchInput !== undefined) {
		const metadataRows = Array.isArray(metadataInput) ? metadataInput : [];
		const batchRows = Array.isArray(validationBatchInput) ? validationBatchInput : [];
		if (metadataRows.length > 0 && batchRows.length > 0)
			throw new Error("validation-batch-json and goal-metadata-json are mutually exclusive");
	}
	const metadata = metadataInput === undefined ? [] : parseGoalMetadataInput(metadataInput, goalIds);
	const validationBatches =
		validationBatchInput === undefined
			? []
			: parseValidationBatchInput(validationBatchInput, goalIds, input.gjcGoalMode ?? "aggregate");
	const metadataByGoalId = new Map(metadata.map(item => [item.goalId, item]));
	const validationBatchByGoalId = new Map<string, UltragoalValidationBatchMetadata>();
	for (const batch of validationBatches)
		for (const memberId of batch.memberIds) validationBatchByGoalId.set(memberId, batch);
	for (const goal of goals) {
		goal.pipelineMetadata = metadataByGoalId.get(goal.id) ?? legacyPipelineMetadata(goal.id);
		goal.validationBatch = validationBatchByGoalId.get(goal.id);
		validateValidationBatchPipelineExclusion(goal);
	}
	const plan: UltragoalPlan = {
		version: 1,
		brief,
		gjcGoalMode: input.gjcGoalMode ?? "aggregate",
		gjcObjective: DEFAULT_ULTRAGOAL_OBJECTIVE,
		goals,
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
export function requireJsonObjectValue(value: unknown, fieldName: string): JsonObject {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new Error(`${fieldName} must be an object`);
	if (Object.keys(value).length === 0) throw new Error(`${fieldName} must be non-empty`);
	return value as JsonObject;
}

export function requireJsonObjectOrArrayValue(value: unknown, fieldName: string): JsonObject | JsonObject[] {
	if (Array.isArray(value)) {
		if (value.length === 0) throw new Error(`${fieldName} must be non-empty`);
		return value.map((item, index) => requireJsonObjectValue(item, `${fieldName}[${index}]`));
	}
	return requireJsonObjectValue(value, fieldName);
}

async function readRequiredJsonObject(cwd: string, value: string, fieldName: string): Promise<JsonObject> {
	return requireJsonObjectValue(await readStructuredValue(cwd, value), fieldName);
}

async function readRequiredJsonObjectOrArray(
	cwd: string,
	value: string,
	fieldName: string,
): Promise<JsonObject | JsonObject[]> {
	return requireJsonObjectOrArrayValue(await readStructuredValue(cwd, value), fieldName);
}

import {
	joinUltragoalPipelineOverlap,
	rebaselineUltragoalPipelineOverlap,
	startUltragoalPipelineOverlap,
} from "./ultragoal-pipeline";

export { joinUltragoalPipelineOverlap, rebaselineUltragoalPipelineOverlap, startUltragoalPipelineOverlap };

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

export async function startNextUltragoalGoal(input: {
	cwd: string;
	retryFailed?: boolean;
	sessionId?: string | null;
}): Promise<{
	plan: UltragoalPlan;
	goal?: UltragoalGoal;
	allComplete: boolean;
}> {
	const plan = await readUltragoalPlan(input.cwd, input.sessionId);
	if (!plan) throw new Error("No ultragoal plan found. Run `gjc ultragoal create-goals --brief ...` first.");
	const goal = chooseNextGoal(plan, input.retryFailed === true);
	if (!goal) return { plan, allComplete: getUltragoalRunCompletionState(plan).allComplete };
	if (goal.status !== "active") {
		const now = new Date().toISOString();
		goal.status = "active";
		goal.startedAt = goal.startedAt ?? now;
		goal.updatedAt = now;
		plan.updatedAt = now;
		await writePlan(input.cwd, plan, input.sessionId);
		await appendLedger(input.cwd, { event: "goal_started", goalId: goal.id }, input.sessionId);
	}
	return { plan, goal, allComplete: false };
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
function successfulLinkedRows(ids: string[], map: Map<string, JsonObject>, fieldName: string): JsonObject[] {
	const rows: JsonObject[] = [];
	for (const id of ids) {
		const row = map.get(id);
		if (!row) throw new Error(`qualityGate ${fieldName} references unknown id ${id}`);
		requireSuccessfulRowOutcome(row, `${fieldName}.${id}`);
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

export type UltragoalChangeStatus = "added" | "modified" | "deleted" | "renamed" | "copied" | "unknown";
export type UltragoalChangeCategory =
	| "code"
	| "generated-binding"
	| "tool"
	| "settings-registry"
	| "prompt-doc-behavior"
	| "docs-static"
	| "other";
export interface UltragoalChangeSetPath extends JsonObject {
	path: string;
	status: UltragoalChangeStatus;
	oldPath?: string;
	category?: UltragoalChangeCategory;
}
export interface UltragoalChangeSet extends JsonObject {
	source: "checkpoint-git" | "review-pr" | "review-branch" | "review-worktree" | "review-spec";
	baseRef?: string;
	headRef?: string;
	mergeBase?: string;
	paths: UltragoalChangeSetPath[];
	rawDiffStat?: string;
	rawDiff?: string;
	trusted: true;
}

const MANDATORY_COMPUTER_CASE_IDS = [
	"kill-switch-bypass",
	"suspended-enforcement",
	"permission-revoked",
	"display-stale",
	"out-of-bounds-drift",
	"runaway-loop-halt",
	"blast-radius",
] as const;
const TOOLS_INDEX_PATH = "packages/coding-agent/src/tools/index.ts";

export function normalizeRepoPath(value: string): string {
	return value.replaceAll("\\\\", "/").replace(/^\.\//, "");
}

function isToolsIndexPath(value: string): boolean {
	return normalizeRepoPath(value) === TOOLS_INDEX_PATH;
}

export function categorizeComputerChangePath(value: string): UltragoalChangeCategory {
	const normalized = normalizeRepoPath(value);
	if (normalized.startsWith("crates/pi-natives/src/computer/")) return "code";
	if (/^packages\/natives\/native\/index\.(?:d\.ts|js)$/.test(normalized)) return "generated-binding";
	if (
		normalized === "packages/coding-agent/src/tools/computer.ts" ||
		normalized.startsWith("packages/coding-agent/src/tools/computer/")
	)
		return "tool";
	if (
		normalized === "packages/coding-agent/src/tools/renderers.ts" ||
		normalized === "packages/coding-agent/src/config/settings-schema.ts"
	)
		return "settings-registry";
	if (
		normalized === "packages/coding-agent/src/prompts/tools/computer.md" ||
		normalized === "packages/coding-agent/src/defaults/gjc/skills/ultragoal/SKILL.md" ||
		normalized === "packages/coding-agent/src/prompts/agents/executor.md"
	)
		return "prompt-doc-behavior";
	if (normalized === "docs/tools/computer.md" || normalized === "docs/computer-use/README.md") return "docs-static";
	return "other";
}

function isComputerControlSurfaceCategory(category: UltragoalChangeCategory): boolean {
	// The computer-use red-team suite is conditional, not universal (see the
	// ultragoal SKILL): require it only when the change actually touches
	// computer-control source — the computer tool (`tool`), its behavior-bearing
	// settings/renderer wiring (`settings-registry`), or computer Rust (`code`).
	// A bare regeneration of the SHARED native binding (`generated-binding`:
	// packages/natives/native/index.{d.ts,js}) is NOT by itself a computer-use
	// change: that file is generated from Rust, so any real computer-use behavior
	// change must also touch one of the categories above and will still trigger
	// the suite. Treating aggregate binding or registration files as a computer
	// surface forced the suite on unrelated changes, which the SKILL explicitly
	// warns against, so they are excluded here.
	return category === "code" || category === "tool" || category === "settings-registry";
}

function isComputerSpecificToolsIndexDiff(diff: string | undefined, targetPath: string): boolean {
	if (!diff || !isToolsIndexPath(targetPath)) return false;
	let inTargetFile = false;
	for (const line of diff.split("\n")) {
		if (line.startsWith("diff --git ")) {
			const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
			inTargetFile = !!match && (isToolsIndexPath(match[1]!) || isToolsIndexPath(match[2]!));
			continue;
		}
		if (!inTargetFile || line.startsWith("+++") || line.startsWith("---")) continue;
		if (!line.startsWith("+") && !line.startsWith("-")) continue;
		const changedLine = line.slice(1);
		if (
			/\bComputerTool\b/.test(changedLine) ||
			/\bisComputerCallable\b/.test(changedLine) ||
			/\bisComputerLoadablePlatform\b/.test(changedLine) ||
			/["']computer["']/.test(changedLine) ||
			/["']\.\/computer["']/.test(changedLine) ||
			/\bcomputer\s*:/.test(changedLine)
		) {
			return true;
		}
	}
	return false;
}

/** Settings registry file that holds ALL settings, most of them unrelated to computer control. */
const SETTINGS_SCHEMA_PATH = "packages/coding-agent/src/config/settings-schema.ts";

export function isSettingsSchemaPath(value: string): boolean {
	return normalizeRepoPath(value) === SETTINGS_SCHEMA_PATH;
}

/**
 * The settings registry holds every setting (themes, tool output sizes, retry
 * knobs, …), so a bare `settings-schema.ts` edit is NOT by itself a computer
 * change. Mirror {@link isComputerSpecificToolsIndexDiff}: only treat it as a
 * computer-control surface when the diff actually adds/removes a `computer.*`
 * setting key. When no diff is available, callers fall back to the conservative
 * (fail-closed) categorization instead of this narrowing.
 */
function isComputerSpecificSettingsDiff(diff: string | undefined, targetPath: string): boolean {
	if (!diff || !isSettingsSchemaPath(targetPath)) return false;
	let inTargetFile = false;
	for (const line of diff.split("\n")) {
		if (line.startsWith("diff --git ")) {
			const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
			inTargetFile = !!match && (isSettingsSchemaPath(match[1]!) || isSettingsSchemaPath(match[2]!));
			continue;
		}
		if (!inTargetFile || line.startsWith("+++") || line.startsWith("---")) continue;
		if (!line.startsWith("+") && !line.startsWith("-")) continue;
		const changedLine = line.slice(1);
		if (/["']computer\./.test(changedLine)) return true;
	}
	return false;
}

function isComputerControlSurfaceChangePath(row: UltragoalChangeSetPath): boolean {
	const category = row.category ?? categorizeComputerChangePath(row.path);
	const oldCategory = row.oldPath ? categorizeComputerChangePath(row.oldPath) : category;
	return isComputerControlSurfaceCategory(category) || isComputerControlSurfaceCategory(oldCategory);
}

function trustedChangeSetRequiresComputerSuite(changeSet: UltragoalChangeSet | undefined): boolean {
	if (!changeSet?.trusted) return false;
	return changeSet.paths.some(row => {
		if (isComputerControlSurfaceChangePath(row)) {
			// The settings registry mixes computer and non-computer settings. Narrow it
			// with the diff so unrelated settings edits do not force the computer suite;
			// fall back to the conservative categorization when no diff is available.
			const touchesSettingsSchema =
				isSettingsSchemaPath(row.path) || (row.oldPath ? isSettingsSchemaPath(row.oldPath) : false);
			if (touchesSettingsSchema && changeSet.rawDiff !== undefined) {
				return (
					isComputerSpecificSettingsDiff(changeSet.rawDiff, row.path) ||
					(row.oldPath ? isComputerSpecificSettingsDiff(changeSet.rawDiff, row.oldPath) : false)
				);
			}
			return true;
		}
		return (
			isComputerSpecificToolsIndexDiff(changeSet.rawDiff, row.path) ||
			(row.oldPath ? isComputerSpecificToolsIndexDiff(changeSet.rawDiff, row.oldPath) : false)
		);
	});
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
	return !["todo", "tbd", "n/a", "na", "none", "placeholder", "empty", "stub"].includes(normalized);
}

export function hasTypedVerifiedReceipt(value: unknown): boolean {
	const receipt = qualityGateObject(value);
	if (!receipt) return false;
	const type = nonEmptyString(receipt.type) ?? nonEmptyString(receipt.kind) ?? nonEmptyString(receipt.receiptType);
	const id = nonEmptyString(receipt.id) ?? nonEmptyString(receipt.receiptId) ?? nonEmptyString(receipt.ref);
	const status = (nonEmptyString(receipt.status) ?? nonEmptyString(receipt.verdict) ?? "").toLowerCase();
	return Boolean(type && id && (status === "verified" || status === "passed"));
}

export async function hasExistingNonEmptyArtifact(cwd: string, value: unknown): Promise<boolean> {
	const artifactPath = nonEmptyString(value);
	if (!artifactPath) return false;
	const resolved = path.resolve(cwd, artifactPath);
	try {
		const file = Bun.file(resolved);
		return (await file.exists()) && file.size > 0;
	} catch (error) {
		if (isEnoent(error)) return false;
		throw error;
	}
}

export async function readArtifactBytes(cwd: string, row: JsonObject, fieldName: string): Promise<Buffer | null> {
	const artifactPath = nonEmptyString(row.path);
	if (!artifactPath) return null;
	const resolved = path.resolve(cwd, artifactPath);
	try {
		const file = Bun.file(resolved);
		if (!(await file.exists())) return null;
		return Buffer.from(await file.arrayBuffer());
	} catch (error) {
		if (isEnoent(error)) return null;
		throw new Error(`qualityGate ${fieldName} artifact could not be read: ${String(error)}`);
	}
}

import {
	readCliReplayRecord,
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

function validateContractCoverage(
	executorQa: JsonObject,
	surfaceEvidence: Map<string, JsonObject>,
	adversarialCases: Map<string, JsonObject>,
	artifactRefs: Map<string, JsonObject>,
): JsonObject[] {
	const rows = requireObjectArray(executorQa.contractCoverage, "executorQa.contractCoverage");
	buildRowIdMap(rows, "executorQa.contractCoverage");
	let hasSuccessfulContractCoverage = false;
	for (const [index, row] of rows.entries()) {
		const fieldName = `executorQa.contractCoverage[${index}]`;
		requiredStringField(row, "contractRef", fieldName);
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
		if (surfaceIds)
			successfulProofLinks += successfulLinkedRows(
				surfaceIds,
				surfaceEvidence,
				`${fieldName}.surfaceEvidenceRefs`,
			).length;
		if (adversarialIds) {
			successfulProofLinks += successfulLinkedRows(
				adversarialIds,
				adversarialCases,
				`${fieldName}.adversarialCaseRefs`,
			).length;
		}
		if (artifactIds) {
			requireResolvedLinks(artifactIds, artifactRefs, `${fieldName}.artifactRefs`);
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
	const contractCoverage = validateContractCoverage(executorQa, surfaceEvidence, adversarialCases, artifactRefs);
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
		const pathValue = nonEmptyString(record.path);
		if (!pathValue) throw new Error(`${fieldName}[${index}].path is required`);
		if ("goalId" in record) throw new Error(`${fieldName}[${index}] must not contain goalId attribution`);
		const status = nonEmptyString(record.status);
		if (!status) throw new Error(`${fieldName}[${index}].status is required`);
		const oldPath = nonEmptyString(record.oldPath);
		return {
			path: normalizeRepoPath(pathValue),
			status: status as UltragoalChangeStatus,
			...(oldPath ? { oldPath: normalizeRepoPath(oldPath) } : {}),
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
	if (!expected) return;
	const declaredExactKeys = new Set(declared.map(row => `${row.oldPath ?? ""}\u0000${row.path}\u0000${row.status}`));
	const declaredPathKeys = new Set(declared.map(row => `${row.oldPath ?? ""}\u0000${row.path}`));
	for (const row of expected.paths) {
		const pathKey = `${row.oldPath ?? ""}\u0000${row.path}`;
		const exactKey = `${pathKey}\u0000${row.status}`;
		const covered = row.status === "unknown" ? declaredPathKeys.has(pathKey) : declaredExactKeys.has(exactKey);
		if (!covered) throw new Error(`${fieldName} does not cover computed checkpoint change-set path ${row.path}`);
	}
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

function validateDeferredCompletionQualityGate(
	gate: JsonObject,
	goal: UltragoalGoal,
	metadata: UltragoalValidationBatchMetadata,
	changeSet?: UltragoalChangeSet,
): void {
	const allowedKeys = new Set(["deferredToBatch"]);
	const unsupportedKeys = Object.keys(gate).filter(key => !allowedKeys.has(key));
	if (unsupportedKeys.length > 0)
		throw new Error(`deferred qualityGate contains unsupported keys: ${unsupportedKeys.join(", ")}`);
	const deferred = qualityGateObject(gate.deferredToBatch);
	if (!deferred) throw new Error("deferred qualityGate requires deferredToBatch object");
	if (deferred.kind !== "validation-batch-deferred")
		throw new Error("deferredToBatch.kind must be validation-batch-deferred");
	requireValidationBatchTuple(metadata, deferred, "deferredToBatch");
	if (goal.id === metadata.finalGoalId)
		throw new Error("final validation batch goal cannot use deferredToBatch quality gate");
	const deferredLanes = stringArray(deferred.deferredLanes)?.filter(Boolean).sort();
	if (deferredLanes?.join(",") !== "architectReview,executorQa")
		throw new Error("deferredToBatch.deferredLanes must be architectReview and executorQa");
	const targeted = qualityGateObject(deferred.targetedVerification);
	if (!targeted || targeted.status !== PASSED_STATUS || !nonEmptyStringArray(targeted.commands))
		throw new Error("deferredToBatch.targetedVerification must pass with non-empty commands");
	requireNonEmptyString(targeted.evidence, "deferredToBatch.targetedVerification.evidence");
	const cleaner = qualityGateObject(deferred.aiSlopCleaner);
	if (!cleaner || cleaner.status !== PASSED_STATUS) throw new Error("deferredToBatch.aiSlopCleaner must pass");
	requireNonEmptyString(cleaner.evidence, "deferredToBatch.aiSlopCleaner.evidence");
	const iteration = qualityGateObject(deferred.iteration);
	if (!iteration || iteration.status !== PASSED_STATUS || iteration.fullRerun !== true)
		throw new Error("deferredToBatch.iteration must pass with fullRerun true");
	if (!nonEmptyStringArray(iteration.rerunCommands))
		throw new Error("deferredToBatch.iteration.rerunCommands must be non-empty");
	requireNonEmptyString(iteration.evidence, "deferredToBatch.iteration.evidence");
	requireEmptyBlockers(iteration.blockers, "deferredToBatch.iteration.blockers");
	const declaredChangeSet = qualityGateObject(deferred.changeSet);
	if (!declaredChangeSet) throw new Error("deferredToBatch.changeSet is required");
	if (declaredChangeSet.memberGoalId !== goal.id)
		throw new Error("deferredToBatch.changeSet.memberGoalId must label the checkpointed goal");
	if (declaredChangeSet.cumulativeFromBase !== true)
		throw new Error("deferredToBatch.changeSet.cumulativeFromBase must be true");
	const paths = canonicalChangeSetRows(declaredChangeSet.paths, "deferredToBatch.changeSet.paths");
	requireChangeSetCoverage(changeSet, paths, "deferredToBatch.changeSet.paths");
	if (declaredChangeSet.changeSetHash !== changeSetHashForPaths(paths))
		throw new Error("deferredToBatch.changeSet.changeSetHash does not match declared paths");
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
	if (batchMode && options.goal && options.goal.id !== batchMode.finalGoalId) {
		validateDeferredCompletionQualityGate(gate, options.goal, batchMode, options.changeSet);
		return;
	}
	if (batchMode && options.goal && options.goal.id === batchMode.finalGoalId) {
		const allowedKeys = new Set([
			"architectReview",
			"executorQa",
			"iteration",
			"validationBatchClose",
			"criticReview",
		]);
		const unsupportedKeys = Object.keys(gate).filter(key => !allowedKeys.has(key));
		if (unsupportedKeys.length > 0)
			throw new Error(`qualityGate contains unsupported keys: ${unsupportedKeys.join(", ")}`);
		if (!qualityGateObject(gate.validationBatchClose))
			throw new Error("final validation batch goal requires validationBatchClose");
	}
	const codeReview = qualityGateObject(gate.codeReview);
	if (codeReview) {
		throw new Error(
			"checkpoint --status complete requires architect review approval through architectReview, executorQa, and iteration quality-gate evidence; legacy codeReview-only gates are not sufficient",
		);
	}
	const allowedKeys = new Set(
		batchMode
			? ["architectReview", "executorQa", "iteration", "validationBatchClose", "criticReview"]
			: ["architectReview", "executorQa", "iteration", "criticReview"],
	);
	const unsupportedKeys = Object.keys(gate).filter(key => !allowedKeys.has(key));
	if (unsupportedKeys.length > 0) {
		throw new Error(`qualityGate contains unsupported keys: ${unsupportedKeys.join(", ")}`);
	}
	const architectReview = qualityGateObject(gate.architectReview);
	const executorQa = qualityGateObject(gate.executorQa);
	const iteration = qualityGateObject(gate.iteration);
	if (!architectReview || !executorQa || !iteration) {
		throw new Error("qualityGate requires architectReview, executorQa, and iteration objects");
	}
	if (isFinalAggregate) {
		if (
			options.ledger &&
			terminalCriticCeilingReached(options.ledger) &&
			!terminalCriticGateOverridden(options.ledger)
		) {
			throw new Error(
				"checkpoint --status complete blocked: terminal-critic ceiling reached; requires human/leader gjc ultragoal record-critic-gate-override before completion",
			);
		}
		const criticReview = qualityGateObject(gate.criticReview);
		if (criticReview?.verdict !== "OKAY") {
			throw new Error(
				"checkpoint --status complete (final aggregate) requires criticReview with verdict OKAY, non-empty evidence, and empty blockers",
			);
		}
		requireNonEmptyString(criticReview.evidence, "criticReview.evidence");
		requireEmptyBlockers(criticReview.blockers, "criticReview.blockers");
	}
	if (
		architectReview.architectureStatus !== CLEAN_ARCHITECT_STATUS ||
		architectReview.productStatus !== CLEAN_ARCHITECT_STATUS ||
		architectReview.codeStatus !== CLEAN_ARCHITECT_STATUS ||
		architectReview.recommendation !== APPROVE_RECOMMENDATION
	) {
		throw new Error(
			"checkpoint --status complete requires architect review approval: architectReview architecture/product/code must be CLEAR and recommendation must be APPROVE",
		);
	}
	if (!nonEmptyStringArray(architectReview.commands)) {
		throw new Error("qualityGate architectReview.commands must be a non-empty string array");
	}
	requireNonEmptyString(architectReview.evidence, "architectReview.evidence");
	requireEmptyBlockers(architectReview.blockers, "architectReview.blockers");
	if (
		executorQa.status !== PASSED_STATUS ||
		executorQa.e2eStatus !== PASSED_STATUS ||
		executorQa.redTeamStatus !== PASSED_STATUS
	) {
		throw new Error("qualityGate executorQa status, e2eStatus, and redTeamStatus must be passed");
	}
	if (!nonEmptyStringArray(executorQa.e2eCommands) || !nonEmptyStringArray(executorQa.redTeamCommands)) {
		throw new Error("qualityGate executorQa e2eCommands and redTeamCommands must be non-empty string arrays");
	}
	requireNonEmptyString(executorQa.evidence, "executorQa.evidence");
	requireEmptyBlockers(executorQa.blockers, "executorQa.blockers");
	await validateExecutorQaRedTeamEvidence(cwd, executorQa, { changeSet: options.changeSet });
	if (iteration.status !== PASSED_STATUS || iteration.fullRerun !== true) {
		throw new Error("qualityGate iteration must be passed with fullRerun true");
	}
	if (!nonEmptyStringArray(iteration.rerunCommands)) {
		throw new Error("qualityGate iteration.rerunCommands must be a non-empty string array");
	}
	requireNonEmptyString(iteration.evidence, "iteration.evidence");
	requireEmptyBlockers(iteration.blockers, "iteration.blockers");
	if (batchMode && options.goal && options.plan && options.ledger) {
		validateBatchCloseQualityGate(gate, options.plan, batchMode, options.ledger, options.changeSet);
	}
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
	if (receiptRows.length !== nonFinalIds.length)
		throw new Error("validationBatchClose.memberReceipts must list every non-final member exactly once");
	for (const row of receiptRows) {
		if (typeof row !== "object" || row === null || Array.isArray(row))
			throw new Error("validationBatchClose.memberReceipts rows must be objects");
		const record = row as JsonObject;
		const memberId = nonEmptyString(record.goalId);
		if (!memberId || !nonFinalIds.includes(memberId))
			throw new Error("validationBatchClose.memberReceipts contains invalid member goalId");
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
		return (
			event !== null &&
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
	const paths = input.changeSet.paths.map(row => ({ ...row }));
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
	await validateCompletionQualityGate(cwd, hydratedGate, {
		changeSet: options.changeSet,
		plan: options.plan,
		goal: options.goal,
		ledger: options.ledger,
	});
	return hydratedGate;
}

function validatePipelineCheckpointSafety(
	plan: UltragoalPlan,
	goal: UltragoalGoal,
	changeSet?: UltragoalChangeSet,
): void {
	const metadata = goal.pipelineMetadata;
	if (!metadata) return;
	validateValidationBatchPipelineExclusion(goal);
	requireFreshPipelineMetadata(goal);
	if (metadata.overlap === "open") {
		throw new Error(
			`Cannot complete ${goal.id} while pipeline overlap ${metadata.overlapId ?? ""} is open; join or quarantine first.`,
		);
	}
	if (metadata.overlap === "quarantine_required") {
		throw new Error(
			`Cannot complete ${goal.id} while pipeline overlap ${metadata.overlapId ?? ""} requires rebaseline.`,
		);
	}
	if (metadata.goalId === metadata.priorGoalId && metadata.overlap !== "none" && metadata.overlap !== "joined_clean") {
		throw new Error(
			`Cannot complete ${goal.id} without a clean join for pipeline overlap ${metadata.overlapId ?? ""}.`,
		);
	}
	const peer = pipelinePeer(plan, metadata);
	if (changeSet && metadata.overlap !== "none") {
		const peerTargets = peer?.pipelineMetadata?.targets;
		for (const row of changeSet.paths) {
			const ownedByGoal = pipelineTargetsCoverPath(metadata.targets, row.path);
			const ownedByPeer = peerTargets ? pipelineTargetsCoverPath(peerTargets, row.path) : false;
			if (ownedByGoal && ownedByPeer)
				throw new Error(`Cannot complete ${goal.id} with shared pipeline change-set path ${row.path}.`);
			if (!ownedByGoal && !ownedByPeer)
				throw new Error(`Cannot complete ${goal.id} with unattributable pipeline change-set path ${row.path}.`);
			if (!ownedByGoal && ownedByPeer)
				throw new Error(`Cannot complete ${goal.id} with next-goal pipeline change-set path ${row.path}.`);
		}
	}
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
	// rejected on complete goals by design). A mutated goal row keeps the
	// fail-loud tamper handling in the idempotent branch below.
	const staleCompleteReceiptReplay =
		input.status === "complete" &&
		goal.status === "complete" &&
		goal.evidence === evidence &&
		Boolean(matchingIdempotentEvent) &&
		(!goal.completionVerification ||
			(goal.completionVerification.verifiedAt === goal.updatedAt &&
				validateReceiptFreshBase({
					plan,
					ledger: ledgerBefore,
					goal,
					receipt: goal.completionVerification,
					receiptKind: goal.completionVerification.receiptKind,
				}) !== null));
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
	if (input.status === "complete") {
		validatePipelineCheckpointSafety(plan, goal, changeSet);
		if (!staleCompleteReceiptReplay) validateCompleteCheckpointTargetGoal(goal);
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
		pipelineMetadata: legacyPipelineMetadata(nextId),
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
	invalidatePipelineMetadata(target, "split_subgoal_superseded", now);
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
			pipelineMetadata: legacyPipelineMetadata(replacementGoalIds[index]!),
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
	invalidatePipelineMetadata(goal, "revised_pending_wording", now);
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
}): Promise<UltragoalPlan> {
	const objective = input.objective.trim();
	if (!objective) throw new Error("record-review-blockers --objective is required");
	const plan = await checkpointUltragoalGoal({
		cwd: input.cwd,
		goalId: input.goalId,
		status: "review_blocked",
		evidence: input.evidence,
	});
	const persistedPlan = await readUltragoalPlan(input.cwd);
	if (persistedPlan?.state_revision !== undefined) plan.state_revision = persistedPlan.state_revision;
	const now = new Date().toISOString();
	const nextId = `G${String(plan.goals.length + 1).padStart(3, "0")}`;
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
	return plan;
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

import {
	computeCheckpointChangeSet,
	parseGitNameStatus,
	parseUnifiedDiffPaths,
	resolveGitBase,
	spawnText,
} from "./ultragoal-change-set";

export { computeCheckpointChangeSet, parseGitNameStatus, parseUnifiedDiffPaths, resolveGitBase, spawnText };

function changeSetFromReviewSource(source: JsonObject): UltragoalChangeSet | undefined {
	const kind = nonEmptyString(source.kind);
	if (kind === "spec") return { source: "review-spec", paths: [], trusted: true };
	if (kind === "pr" && typeof source.diff === "string")
		return {
			source: "review-pr",
			paths: parseUnifiedDiffPaths(source.diff),
			rawDiffStat: source.diff,
			rawDiff: source.diff,
			trusted: true,
		};
	const local = qualityGateObject(source.local);
	if (kind === "pr" && local) return changeSetFromReviewSource(local);
	if (kind === "worktree")
		return {
			source: "review-worktree",
			paths: parseGitNameStatus(String(source.nameStatus ?? source.status ?? "")),
			rawDiffStat: String(source.diffStat ?? ""),
			rawDiff: String(source.diff ?? ""),
			trusted: true,
		};
	if (kind === "branch" || kind === "pr-fallback")
		return {
			source: "review-branch",
			baseRef: nonEmptyString(source.base) ?? undefined,
			headRef: "HEAD",
			paths: parseGitNameStatus(String(source.nameStatus ?? "")),
			rawDiffStat: String(source.diffStat ?? ""),
			rawDiff: String(source.diff ?? ""),
			trusted: true,
		};
	return undefined;
}

async function localDiffSource(cwd: string, sourceKind: string, branch?: string): Promise<JsonObject> {
	if (sourceKind === "worktree") {
		const [status, diffStat, unstaged, staged, unstagedDiff, stagedDiff] = await Promise.all([
			spawnText(["git", "status", "--short"], { cwd, timeoutMs: 5000 }),
			spawnText(["git", "diff", "--stat"], { cwd, timeoutMs: 5000 }),
			spawnText(["git", "diff", "--name-status"], { cwd, timeoutMs: 5000 }),
			spawnText(["git", "diff", "--cached", "--name-status"], { cwd, timeoutMs: 5000 }),
			spawnText(["git", "diff"], { cwd, timeoutMs: 5000 }),
			spawnText(["git", "diff", "--cached"], { cwd, timeoutMs: 5000 }),
		]);
		return {
			kind: "worktree",
			status: status.stdout,
			diffStat: diffStat.stdout,
			diff: [unstagedDiff.stdout, stagedDiff.stdout].filter(Boolean).join("\n"),
			nameStatus: `${unstaged.stdout}\n${staged.stdout}`,
		};
	}
	const base = await resolveGitBase(cwd, branch);
	const [diffStat, nameStatus, diff] = await Promise.all([
		spawnText(["git", "diff", "--stat", `${base}...HEAD`], { cwd, timeoutMs: 5000 }),
		spawnText(["git", "diff", "--name-status", `${base}...HEAD`], { cwd, timeoutMs: 5000 }),
		spawnText(["git", "diff", `${base}...HEAD`], { cwd, timeoutMs: 5000 }),
	]);
	return {
		kind: sourceKind,
		base,
		branch,
		diffStat: diffStat.stdout,
		diff: diff.stdout,
		nameStatus: nameStatus.stdout,
	};
}

async function resolveReviewSource(
	cwd: string,
	args: readonly string[],
	specPath: string | undefined,
): Promise<{ contractStrength: UltragoalReviewContractStrength; source: JsonObject }> {
	if (specPath) {
		const absolute = path.resolve(cwd, specPath);
		return {
			contractStrength: "strong",
			source: { kind: "spec", path: specPath, contract: await Bun.file(absolute).text() },
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
	"--goal-metadata-json",
	"--validation-batch-json",
	"--prior-goal-id",
	"--next-goal-id",
	"--review-handles-json",
	"--qa-handles-json",
	"--implementation-handle-json",
	"--overlap-id",
	"--review-result-json",
	"--qa-result-json",
	"--target-state-json",
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

		"  start-pipeline-overlap",
		"  join-pipeline-overlap",
		"  rebaseline-pipeline-overlap",
		"",
		"Run `gjc ultragoal checkpoint --help`, `gjc ultragoal review --help`, `gjc ultragoal classify-blocker --help`, `gjc ultragoal record-critic-verdict --help`, or `gjc ultragoal record-critic-gate-override --help` for command-specific requirements.",
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

function renderCompleteHandoff(
	result: { plan: UltragoalPlan; goal?: UltragoalGoal; allComplete: boolean },
	json: boolean,
	cwd: string,
): string {
	if (json) {
		return renderCliWriteReceipt({
			ok: true,
			all_complete: result.allComplete,
			next_action: result.allComplete ? "none" : "execute-goal",
			goal_id: result.goal?.id,
			goal_status: result.goal?.status,
			gjc_objective: result.plan.gjcObjective,
			goals_path: getUltragoalPaths(cwd, currentUltragoalSessionId(cwd)).goalsPath,
		});
	}
	if (result.allComplete) return "ultragoal complete all=true\n";
	if (!result.goal) return "ultragoal next-action=none\n";
	return [
		`ultragoal next-action=execute-goal goal-id=${result.goal.id}`,
		`objective=${result.goal.objective}`,
		`gjc-objective=${result.plan.gjcObjective}`,
		"checkpoint requires=architectReview:CLEAR+APPROVE,executorQa:passed",
		"",
	].join("\n");
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

async function dispatchUltragoalCommand(args: string[], cwd: string): Promise<UltragoalCommandResult> {
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
				return { status: 0, stdout: renderStatus(await getUltragoalStatus(cwd, sessionId), json) };
			case "create":
			case "create-goals": {
				if (
					flagValue(args, "--goal-metadata-json") !== undefined &&
					flagValue(args, "--validation-batch-json") !== undefined
				) {
					throw new Error("--validation-batch-json and --goal-metadata-json are mutually exclusive");
				}
				const mode = flagValue(args, "--gjc-goal-mode") === "per-story" ? "per-story" : "aggregate";
				const plan = await createUltragoalPlan({
					cwd,
					brief: await readBrief(cwd, args),
					gjcGoalMode: mode,
					goalMetadataJson: flagValue(args, "--goal-metadata-json"),
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
				const plan = await recordUltragoalReviewBlockers({
					cwd,
					goalId: flagValue(args, "--goal-id") ?? "",
					title: flagValue(args, "--title") ?? "Resolve final code-review blockers",
					objective: flagValue(args, "--objective") ?? "",
					evidence: flagValue(args, "--evidence") ?? "",
				});
				const goal = plan.goals.at(-1);
				return {
					status: 0,
					stdout: json
						? renderCliWriteReceipt({
								ok: true,
								goal_id: goal?.id,
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
			case "start-pipeline-overlap": {
				const receipt = await startUltragoalPipelineOverlap({
					cwd,
					priorGoalId: flagValue(args, "--prior-goal-id") ?? "",
					nextGoalId: flagValue(args, "--next-goal-id") ?? "",
					reviewHandles: await readRequiredJsonObjectOrArray(
						cwd,
						flagValue(args, "--review-handles-json") ?? "",
						"review handles",
					),
					qaHandles: await readRequiredJsonObjectOrArray(
						cwd,
						flagValue(args, "--qa-handles-json") ?? "",
						"QA handles",
					),
					implementationHandle: await readRequiredJsonObject(
						cwd,
						flagValue(args, "--implementation-handle-json") ?? "",
						"implementation handle",
					),
				});
				return {
					status: 0,
					stdout: json ? renderCliWriteReceipt(receipt) : `Started pipeline overlap ${receipt.overlap_id}.\n`,
				};
			}
			case "join-pipeline-overlap": {
				const receipt = await joinUltragoalPipelineOverlap({
					cwd,
					overlapId: flagValue(args, "--overlap-id") ?? "",
					reviewResult: await readRequiredJsonObject(
						cwd,
						flagValue(args, "--review-result-json") ?? "",
						"review result",
					),
					qaResult: await readRequiredJsonObject(cwd, flagValue(args, "--qa-result-json") ?? "", "QA result"),
				});
				return {
					status: 0,
					stdout: json ? renderCliWriteReceipt(receipt) : `Joined pipeline overlap ${receipt.overlap_id}.\n`,
				};
			}
			case "rebaseline-pipeline-overlap": {
				const receipt = await rebaselineUltragoalPipelineOverlap({
					cwd,
					overlapId: flagValue(args, "--overlap-id") ?? "",
					goalId: flagValue(args, "--goal-id") ?? "",
					evidence: flagValue(args, "--evidence") ?? "",
					targetState: await readRequiredJsonObject(
						cwd,
						flagValue(args, "--target-state-json") ?? "",
						"target state",
					),
				});
				return {
					status: 0,
					stdout: json ? renderCliWriteReceipt(receipt) : `Rebaselined pipeline overlap ${receipt.overlap_id}.\n`,
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
	"start-pipeline-overlap",
	"join-pipeline-overlap",
	"rebaseline-pipeline-overlap",
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
async function reconcileUltragoalState(cwd: string): Promise<void> {
	const sessionId = currentUltragoalSessionId(cwd);
	try {
		const summary = await getUltragoalStatus(cwd, sessionId);
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
		if (summary.pipelineOverlap) payload.pipeline_overlap = summary.pipelineOverlap;
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

export async function runNativeUltragoalCommand(args: string[], cwd = process.cwd()): Promise<UltragoalCommandResult> {
	const command = commandName(args);
	const result = await dispatchUltragoalCommand(args, cwd);
	const isHelp = args.some(isHelpArg) || args[0] === "help";
	if (!isHelp && result.status === 0 && RECONCILE_COMMANDS.has(command)) {
		await reconcileUltragoalState(cwd);
	}
	return result;
}
