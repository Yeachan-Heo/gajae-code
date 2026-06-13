import * as crypto from "node:crypto";
import * as path from "node:path";
import type { WorkflowHudSummary } from "../skill-state/active-state";
import { buildUltragoalHudSummary as buildWorkflowUltragoalHudSummary } from "../skill-state/workflow-hud";
import { renderCliWriteReceipt } from "./cli-write-receipt";
import { DEFAULT_ULTRAGOAL_OBJECTIVE } from "./goal-mode-request";
import { renderUltragoalStatusMarkdown } from "./state-renderer";
import { reconcileWorkflowSkillState } from "./state-runtime";
import { appendJsonl, writeArtifact, writeJsonAtomic } from "./state-writer";

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
}

export interface UltragoalCommandResult {
	status: number;
	stdout?: string;
	stderr?: string;
	createdPlan?: boolean;
}

interface JsonObject {
	[key: string]: unknown;
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

export function getUltragoalPaths(cwd: string): UltragoalPaths {
	const dir = path.join(cwd, ".gjc", "ultragoal");
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

async function appendLedger(cwd: string, event: JsonObject): Promise<UltragoalLedgerEvent> {
	const paths = getUltragoalPaths(cwd);
	const entry: UltragoalLedgerEvent = {
		eventId: typeof event.eventId === "string" ? event.eventId : crypto.randomUUID(),
		...event,
		timestamp: new Date().toISOString(),
	};
	await appendJsonl(paths.ledgerPath, entry, {
		cwd,
		audit: { category: "ledger", verb: "append", owner: "gjc-runtime" },
	});
	return entry;
}

export async function readUltragoalLedger(cwd: string): Promise<UltragoalLedgerEvent[]> {
	try {
		const raw = await Bun.file(getUltragoalPaths(cwd).ledgerPath).text();
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

async function writePlan(cwd: string, plan: UltragoalPlan): Promise<void> {
	const paths = getUltragoalPaths(cwd);
	await writeArtifact(paths.briefPath, `${plan.brief.trim()}\n`, {
		cwd,
		audit: { category: "artifact", verb: "write", owner: "gjc-runtime" },
	});
	await writeJsonAtomic(paths.goalsPath, plan, {
		cwd,
		audit: { category: "state", verb: "write", owner: "gjc-runtime" },
	});
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
	};
}

export async function readUltragoalPlan(cwd: string): Promise<UltragoalPlan | null> {
	try {
		return normalizePlan(await Bun.file(getUltragoalPaths(cwd).goalsPath).json());
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

export async function getUltragoalStatus(cwd: string): Promise<UltragoalStatusSummary> {
	const paths = getUltragoalPaths(cwd);
	const plan = await readUltragoalPlan(cwd);
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
	return {
		exists: true,
		status,
		paths,
		gjcObjective: plan.gjcObjective,
		currentGoal,
		counts,
		goals: plan.goals,
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
	await writePlan(input.cwd, plan);
	await appendLedger(input.cwd, { event: "plan_created", goalIds: plan.goals.map(goal => goal.id) });
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

export async function startNextUltragoalGoal(input: { cwd: string; retryFailed?: boolean }): Promise<{
	plan: UltragoalPlan;
	goal?: UltragoalGoal;
	allComplete: boolean;
}> {
	const plan = await readUltragoalPlan(input.cwd);
	if (!plan) throw new Error("No ultragoal plan found. Run `gjc ultragoal create-goals --brief ...` first.");
	const goal = chooseNextGoal(plan, input.retryFailed === true);
	if (!goal) return { plan, allComplete: getUltragoalRunCompletionState(plan).allComplete };
	if (goal.status !== "active") {
		const now = new Date().toISOString();
		goal.status = "active";
		goal.startedAt = goal.startedAt ?? now;
		goal.updatedAt = now;
		plan.updatedAt = now;
		await writePlan(input.cwd, plan);
		await appendLedger(input.cwd, { event: "goal_started", goalId: goal.id });
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

function validateSurfaceArtifactCompatibility(
	surface: string,
	artifactIds: string[],
	artifactRefs: Map<string, JsonObject>,
	fieldName: string,
): void {
	const normalizedSurface = surface.toLowerCase().replaceAll("_", "-");
	const kinds = artifactIds.map(id => normalizedEvidenceKind(artifactRefs.get(id)!));
	const isGuiOrWeb = ["gui", "web", "browser", "ui", "visual"].some(word => normalizedSurface.includes(word));
	if (isGuiOrWeb) {
		const hasBrowser = kinds.some(kind =>
			evidenceKindMatches(kind, ["browser", "playwright", "pandawright", "automation"]),
		);
		const hasVisual = kinds.some(kind => evidenceKindMatches(kind, ["screenshot", "image", "visual"]));
		if (!hasBrowser || !hasVisual) {
			throw new Error(
				`qualityGate ${fieldName} for GUI/web surfaces must reference browser automation plus screenshot or image-verdict artifacts`,
			);
		}
		return;
	}
	const surfaceFamilies: Array<{ surface: string[]; evidence: string[]; label: string }> = [
		{
			surface: ["cli", "terminal", "command"],
			evidence: ["cli", "log", "transcript", "terminal", "command", "test-report"],
			label: "CLI",
		},
		{
			surface: ["api", "package", "library", "sdk"],
			evidence: ["api", "package", "consumer", "black-box", "test-report"],
			label: "API/package",
		},
		{
			surface: ["algorithm", "math", "mathematical", "equation"],
			evidence: ["property", "boundary", "edge", "adversarial", "failure", "math", "algorithm", "test-report"],
			label: "algorithm/math",
		},
	];
	for (const family of surfaceFamilies) {
		if (family.surface.some(word => normalizedSurface.includes(word))) {
			if (!kinds.some(kind => evidenceKindMatches(kind, family.evidence))) {
				throw new Error(
					`qualityGate ${fieldName} for ${family.label} surfaces must reference compatible artifact kinds`,
				);
			}
			return;
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

async function requireSubstantiveArtifactEvidence(cwd: string, row: JsonObject, fieldName: string): Promise<void> {
	if (isSubstantiveEvidence(row.inlineEvidence) || isSubstantiveEvidence(row.evidence)) return;
	if (hasTypedVerifiedReceipt(row.verifiedReceipt) || hasTypedVerifiedReceipt(row.receipt)) return;
	if (await hasExistingNonEmptyArtifact(cwd, row.path)) return;
	throw new Error(
		`qualityGate ${fieldName} must reference an existing non-empty artifact path, substantive inlineEvidence, or a typed verifiedReceipt`,
	);
}

async function validateArtifactRefs(cwd: string, executorQa: JsonObject): Promise<Map<string, JsonObject>> {
	const rows = requireObjectArray(executorQa.artifactRefs, "executorQa.artifactRefs");
	const idMap = buildRowIdMap(rows, "executorQa.artifactRefs");
	for (const [index, row] of rows.entries()) {
		const fieldName = `executorQa.artifactRefs[${index}]`;
		requiredStringField(row, "kind", fieldName);
		requiredStringField(row, "description", fieldName);
		await requireSubstantiveArtifactEvidence(cwd, row, fieldName);
	}
	return idMap;
}

function validateSurfaceEvidence(
	executorQa: JsonObject,
	artifactRefs: Map<string, JsonObject>,
): Map<string, JsonObject> {
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
		requireSuccessfulRowOutcome(row, fieldName);
		requiredStringField(row, "invocation", fieldName);
		if (typeof row.verdict !== "string" || row.verdict.trim().length === 0) {
			requiredStringField(row, "result", fieldName);
		}
		const artifactIds = requireStringLinks(row.artifactRefs, `${fieldName}.artifactRefs`);
		requireResolvedLinks(artifactIds, artifactRefs, `${fieldName}.artifactRefs`);
		validateSurfaceArtifactCompatibility(surface, artifactIds, artifactRefs, `${fieldName}.artifactRefs`);
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

function validateContractCoverage(
	executorQa: JsonObject,
	surfaceEvidence: Map<string, JsonObject>,
	adversarialCases: Map<string, JsonObject>,
	artifactRefs: Map<string, JsonObject>,
): void {
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
}

async function validateExecutorQaRedTeamEvidence(cwd: string, executorQa: JsonObject): Promise<void> {
	const artifactRefs = await validateArtifactRefs(cwd, executorQa);
	const surfaceEvidence = validateSurfaceEvidence(executorQa, artifactRefs);
	const adversarialCases = validateAdversarialCases(executorQa, artifactRefs);
	validateContractCoverage(executorQa, surfaceEvidence, adversarialCases, artifactRefs);
}

async function validateCompletionQualityGate(cwd: string, gate: JsonObject): Promise<void> {
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
	await validateExecutorQaRedTeamEvidence(cwd, executorQa);
	if (iteration.status !== PASSED_STATUS || iteration.fullRerun !== true) {
		throw new Error("qualityGate iteration must be passed with fullRerun true");
	}
	if (!nonEmptyStringArray(iteration.rerunCommands)) {
		throw new Error("qualityGate iteration.rerunCommands must be a non-empty string array");
	}
	requireNonEmptyString(iteration.evidence, "iteration.evidence");
	requireEmptyBlockers(iteration.blockers, "iteration.blockers");
}

async function readRequiredCompletionQualityGate(cwd: string, value: string | undefined): Promise<unknown> {
	if (!value?.trim()) {
		throw new Error(
			"complete checkpoints require --quality-gate-json with architectReview, executorQa, and iteration evidence",
		);
	}
	const gate = await readStructuredValue(cwd, value);
	const gateObject = qualityGateObject(gate);
	if (!gateObject) throw new Error("qualityGate must be a JSON object");
	await validateCompletionQualityGate(cwd, gateObject);
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
async function readGjcGoalSnapshot(input: {
	cwd: string;
	value: string | undefined;
	plan: UltragoalPlan;
	goal?: UltragoalGoal;
	required: boolean;
	errorPrefix: string;
	allowCompletedLegacyBlocker?: boolean;
}): Promise<unknown> {
	if (!input.value?.trim()) {
		if (!input.required) return undefined;
		throw new Error(
			`${input.errorPrefix} require --gjc-goal-json from a fresh active goal({"op":"get"}) snapshot; this is the GJC goal-mode receipt, not the .gjc/ultragoal/goals.json goal record`,
		);
	}
	const snapshot = await readStructuredValue(input.cwd, input.value);
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
	const qualityGateJson =
		input.status === "complete"
			? await readRequiredCompletionQualityGate(input.cwd, input.qualityGateJson)
			: input.qualityGateJson
				? await readStructuredValue(input.cwd, input.qualityGateJson)
				: undefined;
	const now = new Date().toISOString();
	const ledgerBefore = await readUltragoalLedger(input.cwd);
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
	"--kind",
	"--title",
	"--objective",
	"--rationale",
	"--replacements-json",
	"--order-json",
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
			'      --gjc-goal-json=<value>      JSON string or path containing the current goal({"op":"get"}) snapshot',
			"      --json                       Output a machine-readable receipt",
			"",
			"COMPLETE CHECKPOINT RECEIPTS",
			"  --quality-gate-json must be an object with architectReview, executorQa, and iteration.",
			"  executorQa.contractCoverage[] rows require an obligation field; description is not a substitute.",
			'  --gjc-goal-json must contain the active GJC goal-mode snapshot from goal({"op":"get"}), not the .gjc/ultragoal/goals.json goal record.',
			"  goal.updatedAt may be epoch milliseconds or an ISO timestamp and must be fresh.",
			"",
			"EXAMPLES",
			'  $ gjc ultragoal checkpoint --goal-id G001 --status blocked --evidence "waiting on review"',
			'  $ gjc ultragoal checkpoint --goal-id G001 --status complete --evidence "tests passed" --gjc-goal-json ./goal.json --quality-gate-json ./quality-gate.json --json',
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
		"  steer",
		"  record-review-blockers",
		"",
		"Run `gjc ultragoal checkpoint --help` for complete checkpoint receipt requirements.",
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
			goals_path: getUltragoalPaths(cwd).goalsPath,
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
			goals_path: getUltragoalPaths(cwd).goalsPath,
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
					receipt: { ok: true, kind, goal_id: result.goalId, goals_path: getUltragoalPaths(cwd).goalsPath },
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
						goals_path: getUltragoalPaths(cwd).goalsPath,
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
						goals_path: getUltragoalPaths(cwd).goalsPath,
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
						goals_path: getUltragoalPaths(cwd).goalsPath,
					},
				};
			}
			case "annotate_ledger": {
				await annotateUltragoalLedger({ cwd, plan, evidence, rationale });
				return {
					kind,
					message: "Accepted annotate_ledger steering.\n",
					receipt: { ok: true, kind, ledger_path: getUltragoalPaths(cwd).ledgerPath },
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
						goals_path: getUltragoalPaths(cwd).goalsPath,
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
	const help = renderUltragoalHelp(args);
	if (help) return { status: 0, stdout: help };
	try {
		const command = commandName(args);
		const json = hasFlag(args, "--json");
		switch (command) {
			case "status":
				return { status: 0, stdout: renderStatus(await getUltragoalStatus(cwd), json) };
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
								goals_path: getUltragoalPaths(cwd).goalsPath,
							})
						: `Created ultragoal plan with ${plan.goals.length} goal${plan.goals.length === 1 ? "" : "s"} at ${getUltragoalPaths(cwd).goalsPath}.\n`,
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
						? renderCliWriteReceipt({ ok: true, goal_id: goal?.id, goals_path: getUltragoalPaths(cwd).goalsPath })
						: "Recorded review blockers.\n",
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
	const sessionId = process.env.GJC_SESSION_ID?.trim() || undefined;
	try {
		const summary = await getUltragoalStatus(cwd);
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
		await reconcileWorkflowSkillState({ cwd, mode: "ultragoal", sessionId, active, phase: status, payload });
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
