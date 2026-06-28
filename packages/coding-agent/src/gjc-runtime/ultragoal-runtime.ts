import * as crypto from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import { inflateSync } from "node:zlib";
import { normalizeGoal } from "../goals/state";
import { buildSessionContext, loadEntriesFromFile, type SessionEntry } from "../session/session-manager";
import type { WorkflowHudSummary } from "../skill-state/active-state";
import { buildUltragoalHudSummary as buildWorkflowUltragoalHudSummary } from "../skill-state/workflow-hud";
import { renderCliWriteReceipt } from "./cli-write-receipt";
import { DEFAULT_ULTRAGOAL_OBJECTIVE, GJC_SESSION_FILE_ENV } from "./goal-mode-request";
import { gjcRoot, sessionUltragoalDir } from "./session-layout";
import { resolveGjcSessionForRead, resolveGjcSessionForWrite, writeSessionActivityMarker } from "./session-resolution";
import { renderUltragoalStatusMarkdown } from "./state-renderer";
import { reconcileWorkflowSkillState } from "./state-runtime";
import {
	appendJsonl,
	persistedStateRevision,
	withWorkflowStateLock,
	writeArtifact,
	writeGuardedJsonAtomic,
} from "./state-writer";

export type UltragoalGjcGoalMode = "aggregate" | "per-story";
export type UltragoalGoalStatus =
	| "pending"
	| "active"
	| "complete"
	| "failed"
	| "blocked"
	| "review_blocked"
	| "superseded";

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
	gjcGoalSnapshotHash: string;
	planGeneration: string;
	basis: {
		planHashBeforeCheckpoint: string;
		latestRelevantLedgerEventIdBeforeCheckpoint: string | null;
		goalUpdatedAtBeforeCheckpoint: string;
		relevantGoalIdsBeforeCheckpoint: string[];
		requiredGoalSetHashBeforeCheckpoint: string;
	};
	checkpointLedgerEventId: string;
}

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

interface JsonObject {
	[key: string]: unknown;
}

function currentUltragoalSessionId(cwd: string): string {
	return resolveGjcSessionForWrite(cwd, { envSessionId: process.env.GJC_SESSION_ID }).gjcSessionId;
}

const TERMINAL_OR_SKIPPED_STATUSES = new Set<UltragoalGoalStatus>(["complete", "superseded"]);
const CLEAN_ARCHITECT_STATUS = "CLEAR";
const APPROVE_RECOMMENDATION = "APPROVE";
const PASSED_STATUS = "passed";
const NOT_APPLICABLE_STATUS = "not_applicable";
const COVERED_STATUS = "covered";
const ACCEPTED_PROOF_STATUSES = new Set([COVERED_STATUS, "passed", "verified"]);
const MIN_SUBSTANTIVE_EVIDENCE_WORDS = 5;
const MIN_SUBSTANTIVE_EVIDENCE_CHARS = 32;

const GJC_GOAL_SNAPSHOT_MAX_AGE_MILLISECONDS = 10 * 60 * 1000;
const GJC_GOAL_SNAPSHOT_MAX_FUTURE_SKEW_MILLISECONDS = 60 * 1000;

const SCHEDULABLE_STATUSES = new Set<UltragoalGoalStatus>(["pending", "active", "failed"]);
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

function isEnoent(error: unknown): boolean {
	return (
		typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT"
	);
}

async function appendLedger(cwd: string, event: JsonObject, sessionId?: string | null): Promise<UltragoalLedgerEvent> {
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

async function writePlan(cwd: string, plan: UltragoalPlan, sessionId?: string | null): Promise<void> {
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

function requiredUltragoalGoals(plan: UltragoalPlan): UltragoalGoal[] {
	return plan.goals.filter(goal => goal.status !== "superseded");
}

function receiptRelevantGoals(
	plan: UltragoalPlan,
	goal: UltragoalGoal,
	receiptKind: UltragoalReceiptKind,
): UltragoalGoal[] {
	return receiptKind === "final-aggregate" ? requiredUltragoalGoals(plan) : [goal];
}

function ledgerEventId(event: UltragoalLedgerEvent): string | null {
	return typeof event.eventId === "string" && event.eventId.trim().length > 0 ? event.eventId : null;
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
		const goalId = typeof event.goalId === "string" ? event.goalId : null;
		if (!goalId || relevant.has(goalId)) return eventId;
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

function chooseReceiptKind(
	plan: UltragoalPlan,
	goal: UltragoalGoal,
	status: UltragoalGoalStatus,
): UltragoalReceiptKind {
	if (plan.gjcGoalMode === "per-story") return "per-goal";
	if (status !== "complete") return "per-goal";
	const unfinishedRequiredGoals = requiredUltragoalGoals(plan).filter(
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
	gjcGoalJson: JsonObject;
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
		gjcGoalSnapshotHash: hashStructuredValue(input.gjcGoalJson),
		planGeneration: generation.planGeneration,
		basis: generation.basis,
		checkpointLedgerEventId: input.checkpointLedgerEventId,
	};
}

function nonEmptyString(value: unknown): string | null {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
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
function qualityGateObject(value: unknown): JsonObject | null {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonObject) : null;
}

function nonEmptyStringArray(value: unknown): string[] | null {
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
function requireQualityGateObject(value: unknown, fieldName: string): JsonObject {
	const object = qualityGateObject(value);
	if (!object) throw new Error(`qualityGate ${fieldName} must be an object`);
	return object;
}

function requireObjectArray(value: unknown, fieldName: string): JsonObject[] {
	if (!Array.isArray(value) || value.length === 0) {
		throw new Error(`qualityGate ${fieldName} must be a non-empty object array`);
	}
	return value.map((item, index) => requireQualityGateObject(item, `${fieldName}[${index}]`));
}

function requiredStringField(row: JsonObject, key: string, fieldName: string): string {
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

function requireStringLinks(value: unknown, fieldName: string): string[] {
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

function requireResolvedLinks(ids: string[], map: Map<string, JsonObject>, fieldName: string): void {
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

function normalizedEvidenceKind(row: JsonObject): string {
	return requiredStringField(row, "kind", "executorQa.artifactRefs[]").toLowerCase().replaceAll("_", "-");
}

function evidenceKindMatches(kind: string, words: string[]): boolean {
	return words.some(word => kind.includes(word));
}
function formatActualArtifactKinds(artifactIds: string[], kinds: string[]): string {
	if (artifactIds.length === 0) return "none";
	return artifactIds.map((id, index) => `${id}=${kinds[index] ?? "<missing-kind>"}`).join(", ");
}

function formatExpectedKindWords(words: string[]): string {
	return words.map(word => `"${word}"`).join(", ");
}

type SurfaceFamily = "web" | "cli" | "native" | "api-package" | "algorithm-math" | "unknown";

type UltragoalChangeStatus = "added" | "modified" | "deleted" | "renamed" | "copied" | "unknown";
type UltragoalChangeCategory =
	| "code"
	| "generated-binding"
	| "tool"
	| "settings-registry"
	| "prompt-doc-behavior"
	| "docs-static"
	| "other";
interface UltragoalChangeSetPath extends JsonObject {
	path: string;
	status: UltragoalChangeStatus;
	oldPath?: string;
	category?: UltragoalChangeCategory;
}
interface UltragoalChangeSet extends JsonObject {
	source: "checkpoint-git" | "review-pr" | "review-branch" | "review-worktree" | "review-spec";
	baseRef?: string;
	headRef?: string;
	mergeBase?: string;
	paths: UltragoalChangeSetPath[];
	rawDiffStat?: string;
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

function normalizeRepoPath(value: string): string {
	return value.replaceAll("\\\\", "/").replace(/^\.\//, "");
}

function categorizeComputerChangePath(value: string): UltragoalChangeCategory {
	const normalized = normalizeRepoPath(value);
	if (normalized.startsWith("crates/pi-natives/src/computer/")) return "code";
	if (/^packages\/natives\/native\/index\.(?:d\.ts|js)$/.test(normalized)) return "generated-binding";
	if (
		normalized === "packages/coding-agent/src/tools/computer.ts" ||
		normalized.startsWith("packages/coding-agent/src/tools/computer/")
	)
		return "tool";
	if (
		normalized === "packages/coding-agent/src/tools/index.ts" ||
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
	// computer-control source — the computer tool (`tool`), its settings/registry
	// wiring (`settings-registry`), or computer Rust (`code`). A bare regeneration
	// of the SHARED native binding (`generated-binding`: packages/natives/native/
	// index.{d.ts,js}) is NOT by itself a computer-use change: that file is
	// generated from Rust, so any real computer-use behavior change must also
	// touch one of the categories above and will still trigger the suite. Treating
	// the regenerated aggregate binding as a computer surface forced the suite on
	// unrelated features (e.g. notifications), which the SKILL explicitly warns
	// against, so it is excluded here.
	return category === "code" || category === "tool" || category === "settings-registry";
}

function isComputerControlSurfaceChangePath(row: UltragoalChangeSetPath): boolean {
	const category = row.category ?? categorizeComputerChangePath(row.path);
	const oldCategory = row.oldPath ? categorizeComputerChangePath(row.oldPath) : category;
	return isComputerControlSurfaceCategory(category) || isComputerControlSurfaceCategory(oldCategory);
}

function trustedChangeSetRequiresComputerSuite(changeSet: UltragoalChangeSet | undefined): boolean {
	if (!changeSet?.trusted) return false;
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

function isLiveSurfaceFamily(family: SurfaceFamily): boolean {
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

function isSubstantiveEvidence(value: unknown): boolean {
	if (typeof value !== "string") return false;
	const trimmed = value.trim();
	if (trimmed.length < MIN_SUBSTANTIVE_EVIDENCE_CHARS) return false;
	const words = trimmed.split(/\s+/).filter(word => /[a-z0-9]/i.test(word));
	if (words.length < MIN_SUBSTANTIVE_EVIDENCE_WORDS) return false;
	const normalized = trimmed.toLowerCase();
	return !["todo", "tbd", "n/a", "na", "none", "placeholder", "empty", "stub"].includes(normalized);
}

function hasTypedVerifiedReceipt(value: unknown): boolean {
	const receipt = qualityGateObject(value);
	if (!receipt) return false;
	const type = nonEmptyString(receipt.type) ?? nonEmptyString(receipt.kind) ?? nonEmptyString(receipt.receiptType);
	const id = nonEmptyString(receipt.id) ?? nonEmptyString(receipt.receiptId) ?? nonEmptyString(receipt.ref);
	const status = (nonEmptyString(receipt.status) ?? nonEmptyString(receipt.verdict) ?? "").toLowerCase();
	return Boolean(type && id && (status === "verified" || status === "passed"));
}

async function hasExistingNonEmptyArtifact(cwd: string, value: unknown): Promise<boolean> {
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

async function readArtifactBytes(cwd: string, row: JsonObject, fieldName: string): Promise<Buffer | null> {
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

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_START_OF_IMAGE = 0xd8;
const JPEG_END_OF_IMAGE = 0xd9;
const JPEG_START_OF_SCAN = 0xda;
const JPEG_STANDALONE_MARKERS = new Set([0x01, 0xd0, 0xd1, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7]);
const PNG_CRC_TABLE = new Uint32Array(256).map((_, index) => {
	let crc = index;
	for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
	return crc >>> 0;
});

function pngCrc32(bytes: Buffer): number {
	let crc = 0xffffffff;
	for (const byte of bytes) crc = PNG_CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
	return (crc ^ 0xffffffff) >>> 0;
}

function parsePngDimensions(
	bytes: Buffer,
): { width: number; height: number; headerBytes: number; sampleBytes?: Buffer } | null {
	if (bytes.length < 45) return null;
	if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
	let offset = 8;
	let width = 0;
	let height = 0;
	let sawIhdr = false;
	let sawIdat = false;
	const idatChunks: Buffer[] = [];
	while (offset + 12 <= bytes.length) {
		const chunkStart = offset;
		const length = bytes.readUInt32BE(offset);
		offset += 4;
		const type = bytes.toString("ascii", offset, offset + 4);
		offset += 4;
		if (offset + length + 4 > bytes.length) return null;
		const data = bytes.subarray(offset, offset + length);
		offset += length;
		const expectedCrc = bytes.readUInt32BE(offset);
		offset += 4;
		if (pngCrc32(bytes.subarray(chunkStart + 4, offset - 4)) !== expectedCrc) return null;
		if (!sawIhdr) {
			if (type !== "IHDR" || length !== 13) return null;
			width = data.readUInt32BE(0);
			height = data.readUInt32BE(4);
			if (
				width === 0 ||
				height === 0 ||
				data[8] !== 8 ||
				![2, 6].includes(data[9]!) ||
				data[10] !== 0 ||
				data[11] !== 0 ||
				data[12] !== 0
			)
				return null;
			sawIhdr = true;
		} else if (type === "IHDR") return null;
		if (type === "IDAT") {
			if (!sawIhdr || length === 0) return null;
			sawIdat = true;
			idatChunks.push(data);
		}
		if (type === "IEND") {
			if (length !== 0 || !sawIhdr || !sawIdat || offset !== bytes.length) return null;
			try {
				return { width, height, headerBytes: 8, sampleBytes: inflateSync(Buffer.concat(idatChunks)) };
			} catch {
				return null;
			}
		}
	}
	return null;
}

function parseJpegDimensions(
	bytes: Buffer,
): { width: number; height: number; headerBytes: number; sampleBytes?: Buffer } | null {
	if (bytes.length < 8 || bytes[0] !== 0xff || bytes[1] !== JPEG_START_OF_IMAGE) return null;
	let offset = 2;
	let dimensions: { width: number; height: number; headerBytes: number } | null = null;
	let sawStartOfScan = false;
	let scanStart = -1;
	while (offset < bytes.length) {
		if (bytes[offset] !== 0xff) return null;
		while (offset < bytes.length && bytes[offset] === 0xff) offset++;
		if (offset >= bytes.length) return null;
		const marker = bytes[offset++];
		if (marker === 0x00) return null;
		if (marker === JPEG_END_OF_IMAGE) return null;
		if (JPEG_STANDALONE_MARKERS.has(marker)) continue;
		if (offset + 2 > bytes.length) return null;
		const segmentLength = bytes.readUInt16BE(offset);
		if (segmentLength < 2 || offset + segmentLength > bytes.length) return null;
		const segmentDataEnd = offset + segmentLength;
		if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
			if (segmentLength < 8) return null;
			dimensions = {
				width: bytes.readUInt16BE(offset + 5),
				height: bytes.readUInt16BE(offset + 3),
				headerBytes: offset + segmentLength,
			};
		}
		if (marker === JPEG_START_OF_SCAN) {
			if (!dimensions || segmentDataEnd >= bytes.length) return null;
			sawStartOfScan = true;
			scanStart = segmentDataEnd;
			break;
		}
		offset += segmentLength;
	}
	if (!dimensions || !sawStartOfScan || scanStart < 0) return null;
	let scanOffset = scanStart;
	let entropyBytes = 0;
	while (scanOffset < bytes.length) {
		const byte = bytes[scanOffset++]!;
		if (byte !== 0xff) {
			entropyBytes++;
			continue;
		}
		if (scanOffset >= bytes.length) return null;
		const marker = bytes[scanOffset++]!;
		if (marker === 0x00) {
			entropyBytes++;
			continue;
		}
		if (JPEG_STANDALONE_MARKERS.has(marker)) continue;
		if (marker === JPEG_END_OF_IMAGE) {
			if (scanOffset !== bytes.length || entropyBytes < 32) return null;
			return { ...dimensions, sampleBytes: bytes.subarray(scanStart, scanOffset - 2) };
		}
		return null;
	}
	return null;
}

function unsupportedScreenshotFormat(bytes: Buffer): string | null {
	if (bytes.toString("ascii", 0, 6) === "GIF87a" || bytes.toString("ascii", 0, 6) === "GIF89a") return "GIF";
	if (bytes.toString("ascii", 0, 2) === "BM") return "BMP";
	if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP")
		return "WebP";
	return null;
}

function parseImageDimensions(
	bytes: Buffer,
): { width: number; height: number; headerBytes: number; sampleBytes?: Buffer } | null {
	return parsePngDimensions(bytes) ?? parseJpegDimensions(bytes);
}

function hasNonUniformImageBytes(bytes: Buffer, headerBytes: number, sampleBytes?: Buffer): boolean {
	const source = sampleBytes ?? bytes;
	const sampleStart = sampleBytes ? 0 : Math.min(Math.max(headerBytes, 0), source.length);
	const sampleLength = source.length - sampleStart;
	if (sampleLength < 32) return false;
	const windows: Buffer[] = [];
	for (let index = 0; index < 64; index++) {
		const offset = sampleStart + Math.floor(((sampleLength - 32) * index) / 63);
		windows.push(source.subarray(offset, offset + 32));
	}
	const byteCounts = new Map<number, number>();
	let total = 0;
	for (const window of windows) {
		for (const byte of window) {
			byteCounts.set(byte, (byteCounts.get(byte) ?? 0) + 1);
			total++;
		}
	}
	const first = windows[0]!;
	const differingWindows = windows.slice(1).filter(window => !window.equals(first)).length;
	const maxCount = Math.max(...byteCounts.values());
	return byteCounts.size >= 16 && differingWindows >= 8 && maxCount / total <= 0.95;
}

async function validateScreenshotArtifact(cwd: string, row: JsonObject, fieldName: string): Promise<boolean> {
	const bytes = await readArtifactBytes(cwd, row, fieldName);
	if (!bytes) throw new Error(`qualityGate ${fieldName} screenshot artifact path must resolve to an existing file`);
	if (bytes.length < 4096) throw new Error(`qualityGate ${fieldName} screenshot artifact must be at least 4096 bytes`);
	const unsupportedFormat = unsupportedScreenshotFormat(bytes);
	if (unsupportedFormat) {
		throw new Error(
			`qualityGate ${fieldName} unsupported/undecodable screenshot format ${unsupportedFormat}; use PNG or fully marker-validated JPEG`,
		);
	}
	const dimensions = parseImageDimensions(bytes);
	if (!dimensions)
		throw new Error(`qualityGate ${fieldName} screenshot artifact must be a decodable PNG or JPEG image`);
	if (dimensions.width < 320 || dimensions.height < 180) {
		throw new Error(`qualityGate ${fieldName} screenshot artifact must be at least 320x180 pixels`);
	}
	if (!hasNonUniformImageBytes(bytes, dimensions.headerBytes, dimensions.sampleBytes)) {
		throw new Error(
			`qualityGate ${fieldName} screenshot artifact must be non-uniform, not blank, solid, tiny, or placeholder imagery`,
		);
	}
	return true;
}

function normalizeTranscriptTimestamp(value: unknown): number | null {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value !== "string" || value.trim().length === 0) return null;
	const numeric = Number(value);
	if (Number.isFinite(numeric)) return numeric;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : null;
}

function transcriptSurfaceCompatible(value: unknown, family: SurfaceFamily): boolean {
	const surface = nonEmptyString(value);
	return !surface || family === "unknown" || surfaceFamily(surface) === family;
}

function actionSelectorRequired(type: string): boolean {
	return ["click", "fill", "press", "assert", "screenshot", "observe"].includes(type);
}

async function validateAutomationTranscriptArtifact(
	cwd: string,
	row: JsonObject,
	fieldName: string,
	options: { surfaceFamily: SurfaceFamily },
): Promise<boolean> {
	const bytes = await readArtifactBytes(cwd, row, fieldName);
	if (!bytes) throw new Error(`qualityGate ${fieldName} automation transcript path must resolve to an existing file`);
	let transcript: JsonObject;
	try {
		const parsed = JSON.parse(bytes.toString("utf8"));
		transcript = requireQualityGateObject(parsed, `${fieldName}.transcript`);
	} catch (error) {
		throw new Error(`qualityGate ${fieldName} automation transcript must be valid JSON: ${String(error)}`);
	}
	if (transcript.schemaVersion !== 1)
		throw new Error(`qualityGate ${fieldName} automation transcript schemaVersion must be 1`);
	if (!transcriptSurfaceCompatible(transcript.surface, options.surfaceFamily)) {
		throw new Error(
			`qualityGate ${fieldName} automation transcript surface is not compatible with ${options.surfaceFamily}`,
		);
	}
	if (!nonEmptyString(transcript.tool))
		throw new Error(`qualityGate ${fieldName} automation transcript tool must be non-empty`);
	const actions = requireObjectArray(transcript.actions, `${fieldName}.actions`);
	if (actions.length < 1) throw new Error(`qualityGate ${fieldName} automation transcript actions must be non-empty`);
	const assertionsValue = transcript.assertions;
	const assertions =
		assertionsValue === undefined ? [] : requireObjectArray(assertionsValue, `${fieldName}.assertions`);
	const timestamps: number[] = [];
	let hasSelectorBearingEntry = false;
	for (const [index, action] of actions.entries()) {
		const actionField = `${fieldName}.actions[${index}]`;
		const type = requiredStringField(action, "type", actionField).toLowerCase();
		const timestamp = normalizeTranscriptTimestamp(action.timestamp);
		if (timestamp === null) throw new Error(`qualityGate ${actionField}.timestamp must be present and parseable`);
		timestamps.push(timestamp);
		const selector = nonEmptyString(action.selector);
		if (actionSelectorRequired(type) && !selector)
			throw new Error(`qualityGate ${actionField}.selector must be non-empty`);
		if (type === "goto" && !nonEmptyString(action.url))
			throw new Error(`qualityGate ${actionField}.url must be non-empty`);
		if (type === "custom" && !selector && !nonEmptyString(action.target)) {
			throw new Error(`qualityGate ${actionField}.selector or target must be non-empty`);
		}
		if (selector) hasSelectorBearingEntry = true;
	}
	for (const [index, assertion] of assertions.entries()) {
		const assertionField = `${fieldName}.assertions[${index}]`;
		const timestamp = normalizeTranscriptTimestamp(assertion.timestamp);
		if (timestamp === null) throw new Error(`qualityGate ${assertionField}.timestamp must be present and parseable`);
		timestamps.push(timestamp);
		if (nonEmptyString(assertion.status)?.toLowerCase() !== PASSED_STATUS) {
			throw new Error(`qualityGate ${assertionField}.status must be passed`);
		}
		if (nonEmptyString(assertion.selector)) hasSelectorBearingEntry = true;
	}
	for (let index = 1; index < timestamps.length; index++) {
		if (timestamps[index]! < timestamps[index - 1]!) {
			throw new Error(`qualityGate ${fieldName} automation transcript timestamps must be monotonic non-decreasing`);
		}
	}
	if (!hasSelectorBearingEntry) {
		throw new Error(
			`qualityGate ${fieldName} automation transcript must include at least one selector-bearing action or assertion`,
		);
	}
	return true;
}

async function validatePtyCaptureArtifact(cwd: string, row: JsonObject, fieldName: string): Promise<boolean> {
	const bytes = await readArtifactBytes(cwd, row, fieldName);
	if (!bytes) throw new Error(`qualityGate ${fieldName} PTY capture path must resolve to an existing file`);
	if (bytes.length < 512) throw new Error(`qualityGate ${fieldName} PTY capture must be at least 512 bytes`);
	const text = bytes.toString("utf8");
	const hasCsi = /\x1b\[[0-?]*[ -/]*[@-~]/.test(text);
	const hasOsc = /\x1b\][^\x07]*(?:\x07|\x1b\\)/.test(text);
	const hasAltOrCursor = /\x1b\[\?1049[hl]|\x1b\[H|\x1b\[2J/.test(text);
	const hasRedraw = /[\r\b]/.test(text) && hasCsi;
	if (!hasCsi && !hasOsc && !hasAltOrCursor && !hasRedraw) {
		throw new Error(`qualityGate ${fieldName} PTY capture must contain terminal control sequences`);
	}
	if (!/[\x20-\x7e]{10,}/.test(text)) {
		throw new Error(
			`qualityGate ${fieldName} PTY capture must contain a printable text run of at least 10 characters`,
		);
	}
	return true;
}

function structuralArtifactKind(row: JsonObject): "screenshot" | "automation" | "pty" | null {
	const kind = normalizedEvidenceKind(row);
	if (evidenceKindMatches(kind, ["screenshot", "image", "visual"])) return "screenshot";
	if (evidenceKindMatches(kind, ["browser", "playwright", "pandawright", "automation", "app-automation"]))
		return "automation";
	if (evidenceKindMatches(kind, ["pty", "tui", "terminal-capture"])) return "pty";
	return null;
}

async function validateStructuralArtifact(
	cwd: string,
	row: JsonObject,
	fieldName: string,
	options: { surfaceFamily: SurfaceFamily; live: boolean },
): Promise<boolean> {
	void options.live;
	const kind = structuralArtifactKind(row);
	if (!kind) return false;
	if (kind === "screenshot") return validateScreenshotArtifact(cwd, row, fieldName);
	if (kind === "automation") return validateAutomationTranscriptArtifact(cwd, row, fieldName, options);
	if (kind === "pty") return validatePtyCaptureArtifact(cwd, row, fieldName);
	return false;
}

const CLI_REPLAY_MAX_OUTPUT_BYTES = 1024 * 1024;
const CLI_REPLAY_DEFAULT_TIMEOUT_MS = 10_000;
const CLI_REPLAY_MIN_TIMEOUT_MS = 1_000;
const CLI_REPLAY_MAX_TIMEOUT_MS = 30_000;
const CLI_REPLAY_EXEMPT_REASON_CODES = [
	"unsafe_side_effect",
	"requires_credentials",
	"requires_network",
	"non_deterministic_external",
	"destructive",
	"interactive_only",
	"platform_unavailable",
] as const;
const CLI_REPLAY_EXEMPT_REASON_CODE_SET = new Set<string>(CLI_REPLAY_EXEMPT_REASON_CODES);
const CLI_REPLAY_ENV_BASE: Record<string, string> = { CI: "1", NO_COLOR: "1", GJC_ULTRAGOAL_REPLAY: "1" };
const CLI_REPLAY_EXEMPT_REASON_CODE_LIST = CLI_REPLAY_EXEMPT_REASON_CODES.join(", ");
const CLI_REPLAY_SAFE_ENV_NAMES = new Set(["LANG", "LC_ALL", "LC_CTYPE", "TZ"]);
const CLI_REPLAY_DANGEROUS_ENV_NAME_PATTERN =
	/^(?:NODE_OPTIONS|GIT_EXTERNAL_DIFF|GIT_SSH|GIT_SSH_COMMAND|GIT_PAGER|PATH|LD_PRELOAD|LD_LIBRARY_PATH)$|^(?:GIT_CONFIG|DYLD_|BUN_|NPM_CONFIG_)|(?:^|_)OPTIONS$|PRELOAD$/;
const ANSI_ESCAPE_PATTERN = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\)|[@-Z\\-_])/g;

function clampCliReplayTimeout(value: unknown): number {
	if (value === undefined) return CLI_REPLAY_DEFAULT_TIMEOUT_MS;
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new Error("qualityGate CLI replay timeoutMs must be a finite number");
	}
	return Math.min(CLI_REPLAY_MAX_TIMEOUT_MS, Math.max(CLI_REPLAY_MIN_TIMEOUT_MS, Math.trunc(value)));
}

function basenameCommand(value: string): string {
	return path.basename(value).toLowerCase();
}

function isDeterministicConsoleLogReplay(code: string): boolean {
	let remaining = code.trim();
	if (remaining.length === 0) return false;
	let matched = false;
	while (remaining.length > 0) {
		const match =
			/^console\.log\(\s*("(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|`(?:\\[\s\S]|[^`\\$])*`)\s*\)\s*;?\s*/.exec(
				remaining,
			);
		if (!match) return false;
		const statement = match[0]!;
		const literal = match[1]!;
		if (literal.startsWith("`") && literal.includes("${")) return false;
		matched = true;
		remaining = remaining.slice(statement.length);
	}
	return matched;
}

function hasShellRedirectionToken(value: string): boolean {
	return /^(?:[<>]|\d?[<>]|\d?>&\d|\|\|?|&&|;)$/.test(value) || /(?:^|[^\w])-?>/.test(value);
}

function isSafeRefOrPathspec(value: string): boolean {
	return value.length > 0 && !value.startsWith("-") && !/[\0\n\r]/.test(value) && !hasShellRedirectionToken(value);
}

function isAllowedGitReplayCommand(args: readonly string[]): boolean {
	const subcommand = args[0];
	const rest = args.slice(1);
	if (subcommand === "status") return rest.every(arg => ["--short", "--porcelain", "--branch"].includes(arg));
	if (subcommand === "rev-parse" || subcommand === "merge-base")
		return rest.length > 0 && rest.every(isSafeRefOrPathspec);
	if (subcommand !== "diff" && subcommand !== "show" && subcommand !== "log") return false;
	let pathspecMode = false;
	for (const arg of rest) {
		if (arg === "--") {
			pathspecMode = true;
			continue;
		}
		if (pathspecMode) {
			if (!isSafeRefOrPathspec(arg)) return false;
			continue;
		}
		if (["--stat", "--name-only", "--oneline", "--no-ext-diff"].includes(arg)) continue;
		if (!isSafeRefOrPathspec(arg)) return false;
	}
	return true;
}

function isBareExecutableName(value: string): boolean {
	// The allowlist is keyed on the basename, but the raw command[0] is what gets spawned.
	// Reject path-qualified or case-spoofed executables (e.g. ./git, /tmp/npm, scripts/node, GIT)
	// so an attacker-controlled binary cannot impersonate a trusted tool.
	return (
		value.length > 0 &&
		!value.includes("/") &&
		!value.includes("\\") &&
		value === path.basename(value) &&
		value === value.toLowerCase()
	);
}

function isAllowedCliReplayCommand(command: readonly string[]): boolean {
	if (
		command.length === 0 ||
		command.some(arg => arg.trim() !== arg || arg.length === 0 || hasShellRedirectionToken(arg))
	)
		return false;
	if (!isBareExecutableName(command[0]!)) return false;
	const executable = basenameCommand(command[0]!);
	const args = command.slice(1);
	if (executable === "bun" || executable === "node") {
		if (args.length === 1 && args[0] === "--version") return true;
		return args.length === 2 && args[0] === "-e" && isDeterministicConsoleLogReplay(args[1]!);
	}
	if (executable === "npm" || executable === "pnpm" || executable === "yarn") {
		return (args.length === 1 && args[0] === "--version") || (args.length === 1 && args[0] === "list");
	}
	if (executable === "git") return isAllowedGitReplayCommand(args);
	if (executable === "gjc") return args.length === 1 && ["read", "status"].includes(args[0] ?? "");
	return false;
}
function summarizeBlockedCliReplayCommand(command: readonly string[]): string {
	const executable = command[0] ? basenameCommand(command[0]) : "<missing>";
	const argCount = Math.max(0, command.length - 1);
	return `${JSON.stringify(executable)} with ${argCount} arg${argCount === 1 ? "" : "s"}`;
}

function cliReplayAllowlistDescription(): string {
	return [
		'`bun --version`, `node --version`, or deterministic `bun/node -e "console.log(...)"`',
		"`npm|pnpm|yarn --version` or `npm|pnpm|yarn list`",
		"read-only `git status|rev-parse|merge-base|diff|show|log` with safe args",
		"`gjc read` or `gjc status`",
	].join("; ");
}

function resolveCliReplayCommand(command: string[]): string[] {
	if (basenameCommand(command[0]!) === "bun") return [process.execPath, ...command.slice(1)];
	return command;
}

function resolveUnderCwd(cwd: string, replayCwd: unknown, fieldName: string): string {
	const relative = replayCwd === undefined ? "." : nonEmptyString(replayCwd);
	if (!relative) throw new Error(`qualityGate ${fieldName}.cwd must be a non-empty string when provided`);
	const root = path.resolve(cwd);
	const resolved = path.resolve(root, relative);
	const relativeToRoot = path.relative(root, resolved);
	if (relativeToRoot === ".." || relativeToRoot.startsWith(`..${path.sep}`) || path.isAbsolute(relativeToRoot)) {
		throw new Error(`qualityGate ${fieldName}.cwd must resolve under the repository cwd`);
	}
	return resolved;
}

function buildCliReplayEnv(value: unknown, fieldName: string): Record<string, string> {
	const env: Record<string, string> = { ...CLI_REPLAY_ENV_BASE };
	if (value === undefined) return env;
	const object = requireQualityGateObject(value, `${fieldName}.env`);
	for (const [key, envValue] of Object.entries(object)) {
		if (!/^[A-Z_][A-Z0-9_]*$/.test(key))
			throw new Error(`qualityGate ${fieldName}.env.${key} must be an uppercase environment key`);
		if (CLI_REPLAY_DANGEROUS_ENV_NAME_PATTERN.test(key) || !CLI_REPLAY_SAFE_ENV_NAMES.has(key)) {
			throw new Error(`qualityGate ${fieldName}.env.${key} is not in the CLI replay safe environment allowlist`);
		}
		if (typeof envValue !== "string") throw new Error(`qualityGate ${fieldName}.env.${key} must be a string`);
		env[key] = envValue;
	}
	return env;
}

function normalizeCliReplayOutput(value: string, cwd: string): string {
	let normalized = value.replace(ANSI_ESCAPE_PATTERN, "").replace(/\r\n?/g, "\n");
	const home = process.env.HOME;
	const replacements: Array<[RegExp, string]> = [
		[/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/g, "<TIMESTAMP>"],
		[/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, "<UUID>"],
		[/\b[0-9a-f]{7,}\b/gi, "<HASH>"],
		[/(?:\/private)?\/var\/folders\/[^\s"']+|\/tmp\/[^\s"']+|\/var\/tmp\/[^\s"']+/g, "<TMP>"],
	];
	for (const candidate of [path.resolve(cwd), home]) {
		if (!candidate) continue;
		const escaped = candidate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		normalized = normalized.replace(new RegExp(escaped, "g"), candidate === home ? "<HOME>" : "<CWD>");
	}
	for (const [pattern, replacement] of replacements) normalized = normalized.replace(pattern, replacement);
	const lines = normalized.split("\n").map(line => line.replace(/[ \t]+$/g, ""));
	while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	return lines.join("\n");
}

async function readCliReplayRecord(cwd: string, row: JsonObject, fieldName: string): Promise<JsonObject | null> {
	const inline = qualityGateObject(row.replay) ?? (row.kind === "cli-replay" ? row : null);
	if (inline) return inline;
	if (!evidenceKindMatches(normalizedEvidenceKind(row), ["cli-replay", "command-replay"])) return null;
	const bytes = await readArtifactBytes(cwd, row, fieldName);
	if (!bytes) return null;
	try {
		return requireQualityGateObject(JSON.parse(bytes.toString("utf8")), `${fieldName}.replay`);
	} catch (error) {
		throw new Error(`qualityGate ${fieldName} CLI replay artifact must be valid JSON: ${String(error)}`);
	}
}

function parseCliReplayRecord(
	record: JsonObject,
	fieldName: string,
): {
	command: string[];
	replayCwd: unknown;
	env: Record<string, string>;
	timeoutMs: number;
	expectedExitCode: number;
	recordedStdout: string;
	invariants: JsonObject[];
} {
	if (record.schemaVersion !== 1) throw new Error(`qualityGate ${fieldName}.schemaVersion must be 1`);
	if (record.kind !== "cli-replay") throw new Error(`qualityGate ${fieldName}.kind must be cli-replay`);
	if (record.command !== undefined && typeof record.command === "string") {
		throw new Error(`qualityGate ${fieldName}.command must be an argv string array, not a shell string`);
	}
	const command = nonEmptyStringArray(record.command);
	if (!command) throw new Error(`qualityGate ${fieldName}.command must be a non-empty string array`);
	if (record.replaySafe !== true)
		throw new Error(`qualityGate ${fieldName}.replaySafe must be true before CLI replay executes`);
	if (!isAllowedCliReplayCommand(command)) {
		throw new Error(
			`qualityGate ${fieldName}.command is not in the conservative CLI replay allowlist; command ${summarizeBlockedCliReplayCommand(command)} is blocked. Allowed replay commands: ${cliReplayAllowlistDescription()}. For other commands, provide audited replayExempt metadata with reasonCode, reason, approvedBy, and fallbackArtifactRefs that point to a structurally valid fallback artifact.`,
		);
	}
	if (record.normalization !== undefined && record.normalization !== "default") {
		throw new Error(`qualityGate ${fieldName}.normalization must be default when provided`);
	}
	if (typeof record.recordedStdout !== "string")
		throw new Error(`qualityGate ${fieldName}.recordedStdout must be a string`);
	if (record.recordedStderr !== undefined && typeof record.recordedStderr !== "string") {
		throw new Error(`qualityGate ${fieldName}.recordedStderr must be a string when provided`);
	}
	const expectedExitCode = record.expectedExitCode === undefined ? 0 : record.expectedExitCode;
	if (typeof expectedExitCode !== "number" || !Number.isInteger(expectedExitCode)) {
		throw new Error(`qualityGate ${fieldName}.expectedExitCode must be an integer`);
	}
	const invariants =
		record.invariants === undefined ? [] : requireObjectArray(record.invariants, `${fieldName}.invariants`);
	return {
		command: command.map(item => item.trim()),
		replayCwd: record.cwd,
		env: buildCliReplayEnv(record.env, fieldName),
		timeoutMs: clampCliReplayTimeout(record.timeoutMs),
		expectedExitCode,
		recordedStdout: record.recordedStdout,
		invariants,
	};
}

function validateCliReplayInvariants(invariants: JsonObject[], stdout: string, fieldName: string): void {
	for (const [index, invariant] of invariants.entries()) {
		const invariantField = `${fieldName}.invariants[${index}]`;
		const type = requiredStringField(invariant, "type", invariantField);
		const value = requiredStringField(invariant, "value", invariantField);
		if (type === "substring" && !stdout.includes(value))
			throw new Error(`qualityGate ${invariantField} substring invariant did not match stdout`);
		else if (type === "not_substring" && stdout.includes(value))
			throw new Error(`qualityGate ${invariantField} not_substring invariant matched stdout`);
		else if (type === "regex") {
			const flags = invariant.flags === undefined ? "" : requiredStringField(invariant, "flags", invariantField);
			if (!/^[im]*$/.test(flags)) throw new Error(`qualityGate ${invariantField}.flags may only contain i and m`);
			if (!new RegExp(value, flags).test(stdout))
				throw new Error(`qualityGate ${invariantField} regex invariant did not match stdout`);
		} else if (type !== "substring" && type !== "not_substring") {
			throw new Error(`qualityGate ${invariantField}.type must be substring, regex, or not_substring`);
		}
	}
}

async function collectCliReplayOutput(
	stream: ReadableStream<Uint8Array> | null,
): Promise<{ text: string; truncated: boolean }> {
	if (!stream) return { text: "", truncated: false };
	const reader = stream.getReader();
	const chunks: Buffer[] = [];
	let size = 0;
	let truncated = false;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (size < CLI_REPLAY_MAX_OUTPUT_BYTES) {
				const remaining = CLI_REPLAY_MAX_OUTPUT_BYTES - size;
				const chunk = Buffer.from(value.subarray(0, remaining));
				chunks.push(chunk);
				size += chunk.length;
			}
			if (value.length > 0 && size >= CLI_REPLAY_MAX_OUTPUT_BYTES) {
				truncated = true;
				await reader.cancel().catch(() => undefined);
				break;
			}
		}
	} finally {
		reader.releaseLock();
	}
	return { text: Buffer.concat(chunks).toString("utf8"), truncated };
}

export interface ReplayProcessHandle {
	readonly exited: Promise<number>;
	kill(signal?: number | NodeJS.Signals): void;
}

export async function waitForReplayProcessWithTimeout(
	process: ReplayProcessHandle,
	timeoutMs: number,
	graceMs = 2000,
): Promise<number> {
	let timeoutTimer: NodeJS.Timeout | undefined;
	let graceTimer: NodeJS.Timeout | undefined;
	const timedOut = Symbol("timedOut");
	const timeout = new Promise<typeof timedOut>(resolve => {
		timeoutTimer = setTimeout(() => resolve(timedOut), timeoutMs);
	});
	const first = await Promise.race([process.exited, timeout]);
	if (first !== timedOut) {
		if (timeoutTimer) clearTimeout(timeoutTimer);
		return first;
	}
	process.kill("SIGTERM");
	const killed = Symbol("killed");
	const grace = new Promise<typeof killed>(resolve => {
		graceTimer = setTimeout(() => {
			process.kill("SIGKILL");
			resolve(killed);
		}, graceMs);
	});
	await Promise.race([process.exited, grace]);
	await process.exited.catch(() => undefined);
	if (timeoutTimer) clearTimeout(timeoutTimer);
	if (graceTimer) clearTimeout(graceTimer);
	throw new Error("timeout");
}

async function validateReplayExemptFallback(
	cwd: string,
	record: JsonObject,
	fieldName: string,
	artifactRefs: Map<string, JsonObject>,
	options: { surfaceFamily: SurfaceFamily; live: boolean },
): Promise<boolean> {
	const exempt = qualityGateObject(record.replayExempt);
	if (!exempt) return false;
	const reasonCode = requiredStringField(exempt, "reasonCode", `${fieldName}.replayExempt`);
	if (!CLI_REPLAY_EXEMPT_REASON_CODE_SET.has(reasonCode))
		throw new Error(
			`qualityGate ${fieldName}.replayExempt.reasonCode must be one of: ${CLI_REPLAY_EXEMPT_REASON_CODE_LIST}`,
		);
	const reason = requiredStringField(exempt, "reason", `${fieldName}.replayExempt`);
	if (!isSubstantiveEvidence(reason) || reason.length < 30)
		throw new Error(`qualityGate ${fieldName}.replayExempt.reason must be audited and substantive`);
	requiredStringField(exempt, "approvedBy", `${fieldName}.replayExempt`);
	const fallbackRefs = requireStringLinks(
		exempt.fallbackArtifactRefs,
		`${fieldName}.replayExempt.fallbackArtifactRefs`,
	);
	requireResolvedLinks(fallbackRefs, artifactRefs, `${fieldName}.replayExempt.fallbackArtifactRefs`);
	let validFallback = false;
	for (const fallbackRef of fallbackRefs) {
		if (fallbackRef === requiredStringField(record, "id", fieldName)) {
			throw new Error(`qualityGate ${fieldName}.replayExempt fallback must not reference the replay record itself`);
		}
		const fallback = artifactRefs.get(fallbackRef)!;
		if (await validateStructuralArtifact(cwd, fallback, `executorQa.artifactRefs.${fallbackRef}`, options))
			validFallback = true;
	}
	if (!validFallback)
		throw new Error(
			`qualityGate ${fieldName}.replayExempt requires at least one structurally-valid fallback artifact`,
		);
	return true;
}
async function validateCliReplay(
	cwd: string,
	row: JsonObject,
	fieldName: string,
	options: { live: boolean },
): Promise<boolean> {
	const record = await readCliReplayRecord(cwd, row, fieldName);
	if (!record) return false;
	if (record.replayExempt !== undefined) {
		throw new Error(
			`qualityGate ${fieldName}.replayExempt can only be validated from surfaceEvidence with fallback context`,
		);
	}
	void options.live;
	const replay = parseCliReplayRecord(record, fieldName);
	const replayCwd = resolveUnderCwd(cwd, replay.replayCwd, fieldName);
	const process = Bun.spawn(resolveCliReplayCommand(replay.command), {
		cwd: replayCwd,
		env: replay.env,
		stdout: "pipe",
		stderr: "pipe",
	});
	try {
		const [stdout, stderr, exitCode] = await Promise.all([
			collectCliReplayOutput(process.stdout),
			collectCliReplayOutput(process.stderr),
			waitForReplayProcessWithTimeout(process, replay.timeoutMs),
		]);
		if (stdout.truncated || stderr.truncated)
			throw new Error(`qualityGate ${fieldName} CLI replay output exceeded 1 MiB buffer cap`);
		if (exitCode !== replay.expectedExitCode) {
			throw new Error(
				`qualityGate ${fieldName} CLI replay exit code ${exitCode} did not match expected ${replay.expectedExitCode}`,
			);
		}
		const actualStdout = normalizeCliReplayOutput(stdout.text, cwd);
		const recordedStdout = normalizeCliReplayOutput(replay.recordedStdout, cwd);
		if (replay.invariants.length > 0) {
			validateCliReplayInvariants(replay.invariants, actualStdout, fieldName);
		} else if (actualStdout !== recordedStdout) {
			throw new Error(`qualityGate ${fieldName} CLI replay stdout did not match recordedStdout after normalization`);
		}
		return true;
	} catch (error) {
		if (error instanceof Error && error.message === "timeout") {
			throw new Error(`qualityGate ${fieldName} CLI replay timed out after ${replay.timeoutMs}ms`);
		}
		throw error;
	}
}

async function hasLiveProofPresence(
	cwd: string,
	row: JsonObject,
	fieldName: string,
	family: SurfaceFamily,
): Promise<boolean> {
	if (await hasExistingNonEmptyArtifact(cwd, row.path)) return true;
	if (family === "cli") {
		const record = await readCliReplayRecord(cwd, row, fieldName);
		if (record) return true;
	}
	return false;
}

async function validateLiveSurfaceProofPresence(
	cwd: string,
	family: SurfaceFamily,
	artifactIds: string[],
	artifactRefs: Map<string, JsonObject>,
): Promise<void> {
	if (!isLiveSurfaceFamily(family)) return;
	for (const artifactId of artifactIds) {
		if (
			await hasLiveProofPresence(cwd, artifactRefs.get(artifactId)!, `executorQa.artifactRefs.${artifactId}`, family)
		)
			return;
	}
	throw new Error(
		`qualityGate ${artifactIds.map(id => `executorQa.artifactRefs.${id}`).join(", ")} must reference a live proof artifact, structural capture, or CLI replay; inlineEvidence and typed verifiedReceipt do not prove live surfaces`,
	);
}
async function validateSurfaceStructuralRequirement(
	cwd: string,
	family: SurfaceFamily,
	artifactIds: string[],
	artifactRefs: Map<string, JsonObject>,
	fieldName: string,
): Promise<void> {
	if (family !== "web" && family !== "native") return;
	let hasScreenshot = false;
	let hasAutomation = false;
	let hasPty = false;
	for (const artifactId of artifactIds) {
		const artifact = artifactRefs.get(artifactId)!;
		const kind = structuralArtifactKind(artifact);
		if (!kind) continue;
		const valid = await validateStructuralArtifact(cwd, artifact, `executorQa.artifactRefs.${artifactId}`, {
			surfaceFamily: family,
			live: true,
		});
		if (kind === "screenshot" && valid) hasScreenshot = true;
		if (kind === "automation" && valid) hasAutomation = true;
		if (kind === "pty" && valid) hasPty = true;
	}
	if (family === "web" && (!hasScreenshot || !hasAutomation)) {
		throw new Error(
			`qualityGate ${fieldName} for GUI/web surfaces must include a valid automation transcript and non-uniform screenshot`,
		);
	}
	if (family === "native" && !hasScreenshot && !hasAutomation && !hasPty) {
		throw new Error(
			`qualityGate ${fieldName} for native surfaces must include a valid screenshot, PTY capture, or app-automation transcript`,
		);
	}
}

async function validateArtifactProof(
	cwd: string,
	row: JsonObject,
	fieldName: string,
	options: { surfaceFamily: SurfaceFamily; live: boolean },
): Promise<void> {
	if (await hasExistingNonEmptyArtifact(cwd, row.path)) return;
	if (await validateStructuralArtifact(cwd, row, fieldName, options)) return;
	if (options.surfaceFamily === "cli" && (await validateCliReplay(cwd, row, fieldName, { live: options.live })))
		return;
	if (!options.live && (hasTypedVerifiedReceipt(row.verifiedReceipt) || hasTypedVerifiedReceipt(row.receipt))) return;
	const proofLabel = options.live
		? "a live proof artifact, structural capture, or CLI replay; inlineEvidence and typed verifiedReceipt do not prove live surfaces"
		: "an existing non-empty artifact path or a typed verifiedReceipt; inlineEvidence alone is not sufficient";
	throw new Error(`qualityGate ${fieldName} must reference ${proofLabel}`);
}

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

async function validateCompletionQualityGate(
	cwd: string,
	gate: JsonObject,
	options: { changeSet?: UltragoalChangeSet } = {},
): Promise<void> {
	const codeReview = qualityGateObject(gate.codeReview);
	if (codeReview) {
		throw new Error(
			"checkpoint --status complete requires architect review approval through architectReview, executorQa, and iteration quality-gate evidence; legacy codeReview-only gates are not sufficient",
		);
	}
	const allowedKeys = new Set(["architectReview", "executorQa", "iteration"]);
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
}

async function readRequiredCompletionQualityGate(
	cwd: string,
	value: string | undefined,
	options: { changeSet?: UltragoalChangeSet } = {},
): Promise<unknown> {
	if (!value?.trim()) {
		throw new Error(
			"complete checkpoints require --quality-gate-json with architectReview, executorQa, and iteration evidence",
		);
	}
	const gate = await readStructuredValue(cwd, value);
	const gateObject = qualityGateObject(gate);
	if (!gateObject) throw new Error("qualityGate must be a JSON object");
	await validateCompletionQualityGate(cwd, gateObject, { changeSet: options.changeSet });
	return gate;
}

function snapshotUpdatedAtMilliseconds(value: unknown): number | null {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value !== "string" || value.trim().length === 0) return null;
	const trimmed = value.trim();
	if (/^\d+$/.test(trimmed)) {
		const parsed = Number.parseInt(trimmed, 10);
		return Number.isFinite(parsed) ? parsed : null;
	}
	const parsed = Date.parse(trimmed);
	return Number.isFinite(parsed) ? parsed : null;
}

function singleSessionLeafId(entries: readonly SessionEntry[]): string | undefined {
	if (entries.length === 0) return undefined;
	const parentIds = new Set(
		entries.map(entry => entry.parentId).filter((parentId): parentId is string => typeof parentId === "string"),
	);
	const leafIds = entries.map(entry => entry.id).filter(id => !parentIds.has(id));
	return leafIds.length === 1 ? leafIds[0] : undefined;
}

async function readCurrentSessionGjcGoalSnapshot(): Promise<unknown | undefined> {
	const sessionFile = process.env[GJC_SESSION_FILE_ENV]?.trim();
	if (!sessionFile) return undefined;
	const fileEntries = await loadEntriesFromFile(sessionFile);
	const entries = fileEntries.filter((entry): entry is SessionEntry => entry.type !== "session");
	const leafId = singleSessionLeafId(entries);
	if (!leafId) return undefined;
	const context = buildSessionContext(entries, leafId);
	if (context.mode !== "goal" && context.mode !== "goal_paused") return undefined;
	const goal = normalizeGoal(context.modeData?.goal);
	return goal ? { goal } : undefined;
}
async function readGjcGoalSnapshot(input: {
	cwd: string;
	value: string | undefined;
	plan: UltragoalPlan;
	goal?: UltragoalGoal;
	required: boolean;
	errorPrefix: string;
	allowCompletedLegacyBlocker?: boolean;
}): Promise<unknown> {
	const snapshot = input.value?.trim()
		? await readStructuredValue(input.cwd, input.value)
		: await readCurrentSessionGjcGoalSnapshot();
	if (snapshot === undefined) {
		if (!input.required) return undefined;
		throw new Error(
			`${input.errorPrefix} require an active GJC goal-mode snapshot from the current session or --gjc-goal-json; this is the GJC goal-mode receipt, not the .gjc/ultragoal/goals.json goal record`,
		);
	}
	const snapshotObject = qualityGateObject(snapshot);
	const detailsObject = qualityGateObject(snapshotObject?.details);
	const goalObject = qualityGateObject(snapshotObject?.goal) ?? qualityGateObject(detailsObject?.goal);
	if (!goalObject)
		throw new Error(
			`${input.errorPrefix} require --gjc-goal-json with a goal object from goal({"op":"get"}); pass the active GJC goal-mode snapshot, not the .gjc/ultragoal/goals.json goal record`,
		);
	const updatedAt = snapshotUpdatedAtMilliseconds(goalObject.updatedAt);
	if (!updatedAt)
		throw new Error(
			`${input.errorPrefix} require --gjc-goal-json goal.updatedAt as epoch milliseconds or an ISO timestamp from goal({"op":"get"}); pass the active GJC goal-mode snapshot, not the .gjc/ultragoal/goals.json goal record`,
		);
	const nowMilliseconds = Date.now();
	if (updatedAt < nowMilliseconds - GJC_GOAL_SNAPSHOT_MAX_AGE_MILLISECONDS) {
		throw new Error(`${input.errorPrefix} require a fresh --gjc-goal-json snapshot`);
	}
	if (updatedAt > nowMilliseconds + GJC_GOAL_SNAPSHOT_MAX_FUTURE_SKEW_MILLISECONDS) {
		throw new Error(`${input.errorPrefix} require --gjc-goal-json goal.updatedAt that is not from the future`);
	}
	const objective = typeof goalObject.objective === "string" ? goalObject.objective : "";
	const expectedObjectives = new Set([input.plan.gjcObjective, ...(input.plan.gjcObjectiveAliases ?? [])]);
	if (input.plan.gjcGoalMode === "per-story" && input.goal?.objective) {
		expectedObjectives.add(input.goal.objective);
	}
	if (input.allowCompletedLegacyBlocker && goalObject.status === "complete" && !expectedObjectives.has(objective)) {
		return snapshot;
	}
	if (!expectedObjectives.has(objective)) {
		throw new Error(
			`${input.errorPrefix} require --gjc-goal-json objective to match the active GJC goal-mode objective from goal({"op":"get"}), not the .gjc/ultragoal/goals.json goal ${input.goal?.id ?? "record"}`,
		);
	}
	if (goalObject.status !== "active") {
		throw new Error(`${input.errorPrefix} require --gjc-goal-json goal.status to be active`);
	}
	return snapshot;
}

export async function checkpointUltragoalGoal(input: {
	cwd: string;
	goalId: string;
	status: UltragoalGoalStatus;
	evidence: string;
	gjcGoalJson?: string;
	qualityGateJson?: string;
}): Promise<UltragoalPlan> {
	const plan = await readUltragoalPlan(input.cwd);
	if (!plan) throw new Error("No ultragoal plan found. Run `gjc ultragoal create-goals --brief ...` first.");
	const goal = plan.goals.find(item => item.id === input.goalId);
	if (!goal) throw new Error(`No ultragoal goal found for ${input.goalId}.`);
	const evidence = input.evidence.trim();
	if (!evidence) throw new Error("checkpoint evidence is required");
	const ledgerBefore = await readUltragoalLedger(input.cwd);
	if (
		goal.status === input.status &&
		goal.evidence === evidence &&
		ledgerBefore.some(
			event =>
				event.event === "goal_checkpointed" &&
				event.goalId === goal.id &&
				event.status === input.status &&
				event.evidence === evidence,
		)
	) {
		// Idempotent re-checkpoint: this goal is already recorded in the target status with the same
		// evidence, so skip the plan rewrite and ledger append to avoid duplicate goal_checkpointed
		// events. The ledger is the dedup source of truth because it is exactly what a duplicate write
		// would corrupt (mirrors the ralplan #638 guard). Requiring a matching ledger row means an
		// interrupted prior write (plan persisted, ledger append lost) still re-appends the event
		// instead of silently dropping it.
		return plan;
	}
	const changeSet = input.status === "complete" ? await computeCheckpointChangeSet(input.cwd) : undefined;
	const qualityGateJson =
		input.status === "complete"
			? await readRequiredCompletionQualityGate(input.cwd, input.qualityGateJson, { changeSet })
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
	const receiptKind = input.status === "complete" ? chooseReceiptKind(plan, goal, input.status) : null;
	const gjcGoalJson =
		input.status === "complete"
			? await readGjcGoalSnapshot({
					cwd: input.cwd,
					value: input.gjcGoalJson,
					plan,
					goal,
					required: true,
					errorPrefix: "complete checkpoints",
				})
			: await readGjcGoalSnapshot({
					cwd: input.cwd,
					value: input.gjcGoalJson,
					plan,
					goal,
					required: false,
					errorPrefix: `${input.status} checkpoints`,
					allowCompletedLegacyBlocker: input.status === "blocked",
				});
	const pendingCheckpointEventId = crypto.randomUUID();
	if (input.status === "complete" && receiptKind && qualityGateJson && !Array.isArray(qualityGateJson)) {
		goal.completionVerification = buildCompletionReceipt({
			plan,
			ledger: ledgerBefore,
			goal,
			receiptKind,
			beforeStatus,
			qualityGateJson: qualityGateJson as JsonObject,
			gjcGoalJson: gjcGoalJson as JsonObject,
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
		gjcGoalJson,
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
	gjcGoalJson?: string;
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
	const replacements = parseReplacementSpecs(input.replacementsJson, kind);
	const now = new Date().toISOString();
	const replacementGoalIds = replacements.map((_, index) => nextUltragoalGoalId(input.plan, index + 1));
	target.status = "superseded";
	target.evidence = evidence;
	target.updatedAt = now;
	target.steering = { kind, evidence, rationale, replacementGoalIds };
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
	const remainingRequiredGoals = requiredUltragoalGoals(input.plan).filter(item => item.id !== goal.id);
	if (remainingRequiredGoals.length === 0) {
		throw new Error(`steer ${kind} cannot supersede ${goal.id} because it is the only remaining required goal`);
	}
	const now = new Date().toISOString();
	goal.status = "superseded";
	goal.evidence = evidence;
	goal.updatedAt = now;
	goal.steering = { kind, evidence, rationale, noReplacementRequired: true };
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
	gjcGoalJson?: string;
}): Promise<UltragoalPlan> {
	const objective = input.objective.trim();
	if (!objective) throw new Error("record-review-blockers --objective is required");
	if (!input.gjcGoalJson?.trim()) {
		throw new Error('record-review-blockers require --gjc-goal-json from a fresh active goal({"op":"get"}) snapshot');
	}
	const plan = await checkpointUltragoalGoal({
		cwd: input.cwd,
		goalId: input.goalId,
		status: "review_blocked",
		evidence: input.evidence,
		gjcGoalJson: input.gjcGoalJson,
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
 * Record an audited blocker triage classification in the durable ledger. A
 * `human_blocked` classification is the only thing that authorizes
 * `goal({"op":"pause"})` while an Ultragoal run is active; `resolvable` is an
 * audit note and never unblocks pause.
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

async function spawnText(
	command: string[],
	options: { cwd: string; timeoutMs?: number },
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
	try {
		const proc = Bun.spawn(command, { cwd: options.cwd, stdout: "pipe", stderr: "pipe" });
		const timeout = setTimeout(() => proc.kill(), options.timeoutMs ?? 5000);
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		clearTimeout(timeout);
		return { ok: exitCode === 0, stdout, stderr };
	} catch (error) {
		return { ok: false, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
	}
}

export async function resolveGitBase(cwd: string, branch?: string): Promise<string> {
	if (branch) {
		const exists = await spawnText(["git", "rev-parse", "--verify", branch], { cwd, timeoutMs: 3000 });
		if (exists.ok) return branch;
	} else {
		// Prefer the NEAREST integration base (the branch this work actually forks
		// from) rather than always `main`. A branch opened against `dev` must be
		// scoped to `dev`; using a stale `main` sweeps in unrelated trunk history
		// and mis-attributes other people's changes to this story (e.g. falsely
		// tripping change-scoped gates). Among existing candidates, pick the one
		// whose merge-base with HEAD is closest to HEAD (fewest commits ahead).
		const candidates = ["origin/dev", "dev", "origin/main", "origin/master", "main", "master"];
		let best: { ref: string; ahead: number } | undefined;
		for (const candidate of candidates) {
			const exists = await spawnText(["git", "rev-parse", "--verify", candidate], { cwd, timeoutMs: 3000 });
			if (!exists.ok) continue;
			const mergeBase = await spawnText(["git", "merge-base", "HEAD", candidate], { cwd, timeoutMs: 3000 });
			if (!mergeBase.ok || !mergeBase.stdout.trim()) continue;
			const count = await spawnText(["git", "rev-list", "--count", `${mergeBase.stdout.trim()}..HEAD`], {
				cwd,
				timeoutMs: 3000,
			});
			const ahead = Number.parseInt(count.stdout.trim(), 10);
			if (!Number.isFinite(ahead)) continue;
			if (!best || ahead < best.ahead) best = { ref: candidate, ahead };
		}
		if (best) return best.ref;
	}
	const mergeBase = await spawnText(["git", "merge-base", "HEAD", "origin/main"], { cwd, timeoutMs: 3000 });
	if (mergeBase.ok && mergeBase.stdout.trim()) return mergeBase.stdout.trim();
	return "HEAD~1";
}

function parseGitNameStatus(output: string): UltragoalChangeSetPath[] {
	const rows: UltragoalChangeSetPath[] = [];
	for (const line of output.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		const parts = trimmed.split(/\s+/);
		const statusCode = parts[0] ?? "";
		let status: UltragoalChangeStatus = "unknown";
		if (statusCode.startsWith("A")) status = "added";
		else if (statusCode.startsWith("M")) status = "modified";
		else if (statusCode.startsWith("D")) status = "deleted";
		else if (statusCode.startsWith("R")) status = "renamed";
		else if (statusCode.startsWith("C")) status = "copied";
		const pathValue = status === "renamed" || status === "copied" ? parts[2] : parts[1];
		if (!pathValue) continue;
		const oldPath = status === "renamed" || status === "copied" ? parts[1] : undefined;
		rows.push({
			path: normalizeRepoPath(pathValue),
			oldPath: oldPath ? normalizeRepoPath(oldPath) : undefined,
			status,
			category: categorizeComputerChangePath(pathValue),
		});
	}
	return rows;
}

function mergeChangeSetPaths(groups: UltragoalChangeSetPath[][]): UltragoalChangeSetPath[] {
	const byKey = new Map<string, UltragoalChangeSetPath>();
	for (const row of groups.flat()) byKey.set(`${row.oldPath ?? ""}\u0000${row.path}`, row);
	return [...byKey.values()];
}

async function computeCheckpointChangeSet(cwd: string): Promise<UltragoalChangeSet | undefined> {
	const inGit = await spawnText(["git", "rev-parse", "--is-inside-work-tree"], { cwd, timeoutMs: 3000 });
	if (!inGit.ok || inGit.stdout.trim() !== "true") return undefined;
	if (!(await Bun.file(path.join(cwd, ".git")).exists())) return undefined;
	const baseRef = await resolveGitBase(cwd);
	const base = baseRef;
	const mergeBase = await spawnText(["git", "merge-base", "HEAD", baseRef], { cwd, timeoutMs: 3000 });
	const [committed, unstaged, staged, stat] = await Promise.all([
		spawnText(["git", "diff", "--name-status", `${base}...HEAD`], { cwd, timeoutMs: 5000 }),
		spawnText(["git", "diff", "--name-status"], { cwd, timeoutMs: 5000 }),
		spawnText(["git", "diff", "--cached", "--name-status"], { cwd, timeoutMs: 5000 }),
		spawnText(["git", "diff", "--stat", `${base}...HEAD`], { cwd, timeoutMs: 5000 }),
	]);
	if (!committed.ok && !unstaged.ok && !staged.ok) return undefined;
	return {
		source: "checkpoint-git",
		baseRef,
		mergeBase: mergeBase.ok && mergeBase.stdout.trim() ? mergeBase.stdout.trim() : undefined,
		headRef: "HEAD",
		paths: mergeChangeSetPaths([
			parseGitNameStatus(committed.stdout),
			parseGitNameStatus(unstaged.stdout),
			parseGitNameStatus(staged.stdout),
		]),
		rawDiffStat: stat.stdout,
		trusted: true,
	};
}

function parseUnifiedDiffPaths(diff: string): UltragoalChangeSetPath[] {
	const paths: UltragoalChangeSetPath[] = [];
	for (const line of diff.split("\n")) {
		if (!line.startsWith("diff --git ")) continue;
		const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
		if (!match) continue;
		const oldPath = normalizeRepoPath(match[1]!);
		const newPath = normalizeRepoPath(match[2]!);
		paths.push({
			path: newPath,
			oldPath: oldPath === newPath ? undefined : oldPath,
			status: oldPath === newPath ? "modified" : "renamed",
			category: categorizeComputerChangePath(newPath),
		});
	}
	return paths;
}

function changeSetFromReviewSource(source: JsonObject): UltragoalChangeSet | undefined {
	const kind = nonEmptyString(source.kind);
	if (kind === "spec") return { source: "review-spec", paths: [], trusted: true };
	if (kind === "pr" && typeof source.diff === "string")
		return {
			source: "review-pr",
			paths: parseUnifiedDiffPaths(source.diff),
			rawDiffStat: source.diff,
			trusted: true,
		};
	const local = qualityGateObject(source.local);
	if (kind === "pr" && local) return changeSetFromReviewSource(local);
	if (kind === "worktree")
		return {
			source: "review-worktree",
			paths: parseGitNameStatus(String(source.nameStatus ?? source.status ?? "")),
			rawDiffStat: String(source.diffStat ?? ""),
			trusted: true,
		};
	if (kind === "branch" || kind === "pr-fallback")
		return {
			source: "review-branch",
			baseRef: nonEmptyString(source.base) ?? undefined,
			headRef: "HEAD",
			paths: parseGitNameStatus(String(source.nameStatus ?? "")),
			rawDiffStat: String(source.diffStat ?? ""),
			trusted: true,
		};
	return undefined;
}

async function localDiffSource(cwd: string, sourceKind: string, branch?: string): Promise<JsonObject> {
	if (sourceKind === "worktree") {
		const [status, diff, unstaged, staged] = await Promise.all([
			spawnText(["git", "status", "--short"], { cwd, timeoutMs: 5000 }),
			spawnText(["git", "diff", "--stat"], { cwd, timeoutMs: 5000 }),
			spawnText(["git", "diff", "--name-status"], { cwd, timeoutMs: 5000 }),
			spawnText(["git", "diff", "--cached", "--name-status"], { cwd, timeoutMs: 5000 }),
		]);
		return {
			kind: "worktree",
			status: status.stdout,
			diffStat: diff.stdout,
			nameStatus: `${unstaged.stdout}\n${staged.stdout}`,
		};
	}
	const base = await resolveGitBase(cwd, branch);
	const [diff, nameStatus] = await Promise.all([
		spawnText(["git", "diff", "--stat", `${base}...HEAD`], { cwd, timeoutMs: 5000 }),
		spawnText(["git", "diff", "--name-status", `${base}...HEAD`], { cwd, timeoutMs: 5000 }),
	]);
	return { kind: sourceKind, base, branch, diffStat: diff.stdout, nameStatus: nameStatus.stdout };
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
	"--gjc-goal-json",
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
			"      --gjc-goal-json=<value>      Optional JSON/path override for current goal snapshot; omitted complete checkpoints read current session goal state",
			"      --json                       Output a machine-readable receipt",
			"",
			"COMPLETE CHECKPOINT RECEIPTS",
			"  --quality-gate-json must be an object with architectReview, executorQa, and iteration.",
			"  executorQa.contractCoverage[] rows require an obligation field; description is not a substitute.",
			"  Complete checkpoints use the current session's active GJC goal-mode snapshot when --gjc-goal-json is omitted.",
			"  Explicit --gjc-goal-json values must contain an active GJC goal-mode snapshot, not the .gjc/ultragoal/goals.json goal record.",
			"  goal.updatedAt may be epoch milliseconds or an ISO timestamp and must be fresh.",
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
			"      --classification=<value>     Required. human_blocked authorizes pause only as the latest ledger event; resolvable never authorizes pause",
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
		"",
		"Run `gjc ultragoal checkpoint --help`, `gjc ultragoal review --help`, or `gjc ultragoal classify-blocker --help` for command-specific requirements.",
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
	const sessionId = currentUltragoalSessionId(cwd);
	const help = renderUltragoalHelp(args);
	if (help) return { status: 0, stdout: help };
	try {
		const command = commandName(args);
		const json = hasFlag(args, "--json");
		switch (command) {
			case "status":
				return { status: 0, stdout: renderStatus(await getUltragoalStatus(cwd, sessionId), json) };
			case "create":
			case "create-goals": {
				const mode = flagValue(args, "--gjc-goal-mode") === "per-story" ? "per-story" : "aggregate";
				const plan = await createUltragoalPlan({ cwd, brief: await readBrief(cwd, args), gjcGoalMode: mode });
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
					gjcGoalJson: flagValue(args, "--gjc-goal-json"),
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
					gjcGoalJson: flagValue(args, "--gjc-goal-json"),
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
							})
						: `Recorded blocker classification: ${String(event.classification)}.\n`,
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
