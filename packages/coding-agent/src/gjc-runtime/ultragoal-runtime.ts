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
}): unknown {
	return {
		...input.plan,
		updatedAt: undefined,
		goals: input.plan.goals.map(goal => ({
			...goal,
			status: goal.id === input.goal.id ? input.beforeStatus : goal.status,
			updatedAt: goal.id === input.goal.id ? input.targetGoalUpdatedAt : goal.updatedAt,
			evidence: goal.id === input.goal.id ? undefined : goal.evidence,
			completedAt: goal.id === input.goal.id ? undefined : goal.completedAt,
			completionVerification: undefined,
		})),
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

export async function startNextUltragoalGoal(input: { cwd: string; retryFailed?: boolean }): Promise<{
	plan: UltragoalPlan;
	goal?: UltragoalGoal;
	allComplete: boolean;
}> {
	const plan = await readUltragoalPlan(input.cwd);
	if (!plan) throw new Error("No ultragoal plan found. Run `gjc ultragoal create-goals --brief ...` first.");
	const goal = chooseNextGoal(plan, input.retryFailed === true);
	if (!goal) return { plan, allComplete: plan.goals.every(item => TERMINAL_OR_SKIPPED_STATUSES.has(item.status)) };
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
		throw new Error(`qualityGate ${fieldName}.${key} must be a non-empty string`);
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
		throw new Error(`${input.errorPrefix} require --gjc-goal-json from a fresh active goal({"op":"get"}) snapshot`);
	}
	const snapshot = await readStructuredValue(input.cwd, input.value);
	const snapshotObject = qualityGateObject(snapshot);
	const detailsObject = qualityGateObject(snapshotObject?.details);
	const goalObject = qualityGateObject(snapshotObject?.goal) ?? qualityGateObject(detailsObject?.goal);
	if (!goalObject) throw new Error(`${input.errorPrefix} require --gjc-goal-json with a goal object`);
	const updatedAt = typeof goalObject.updatedAt === "number" ? goalObject.updatedAt : null;
	if (!updatedAt)
		throw new Error(`${input.errorPrefix} require --gjc-goal-json goal.updatedAt from goal({"op":"get"})`);
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
		throw new Error(`${input.errorPrefix} require --gjc-goal-json objective to match the active Ultragoal objective`);
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

export async function addUltragoalSubgoal(input: {
	cwd: string;
	title: string;
	objective: string;
	evidence: string;
	rationale: string;
}): Promise<UltragoalPlan> {
	const plan = await readUltragoalPlan(input.cwd);
	if (!plan) throw new Error("No ultragoal plan found. Run `gjc ultragoal create-goals --brief ...` first.");
	for (const [label, value] of [
		["title", input.title],
		["objective", input.objective],
		["evidence", input.evidence],
		["rationale", input.rationale],
	] as const) {
		if (!value.trim()) throw new Error(`steer --${label} is required for add_subgoal`);
	}
	const now = new Date().toISOString();
	const nextId = `G${String(plan.goals.length + 1).padStart(3, "0")}`;
	plan.goals.push({
		id: nextId,
		title: input.title.trim(),
		objective: input.objective.trim(),
		status: "pending",
		createdAt: now,
		updatedAt: now,
		steering: { kind: "add_subgoal", evidence: input.evidence.trim(), rationale: input.rationale.trim() },
	});
	plan.updatedAt = now;
	await writePlan(input.cwd, plan);
	await appendLedger(input.cwd, {
		event: "steering_accepted",
		kind: "add_subgoal",
		goalId: nextId,
		evidence: input.evidence.trim(),
		rationale: input.rationale.trim(),
	});
	return plan;
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
]);

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
		if (!arg.startsWith("-")) return arg;
	}
	return "status";
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

async function dispatchUltragoalCommand(args: string[], cwd: string): Promise<UltragoalCommandResult> {
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
				const plan = await checkpointUltragoalGoal({
					cwd,
					goalId,
					status,
					evidence,
					gjcGoalJson: flagValue(args, "--gjc-goal-json"),
					qualityGateJson: flagValue(args, "--quality-gate-json"),
				});
				const goal = plan.goals.find(item => item.id === goalId);
				return {
					status: 0,
					stdout: json
						? renderCliWriteReceipt({
								ok: true,
								goal_id: goalId,
								status,
								goals_path: getUltragoalPaths(cwd).goalsPath,
								completion_receipt_kind: goal?.completionVerification?.receiptKind,
								quality_gate_hash: goal?.completionVerification?.qualityGateHash,
							})
						: `ultragoal checkpoint goal-id=${goalId} status=${status}\n`,
				};
			}
			case "steer": {
				const kind = flagValue(args, "--kind");
				if (kind !== "add_subgoal") throw new Error("native steering currently supports --kind add_subgoal");
				const plan = await addUltragoalSubgoal({
					cwd,
					title: flagValue(args, "--title") ?? "",
					objective: flagValue(args, "--objective") ?? "",
					evidence: flagValue(args, "--evidence") ?? "",
					rationale: flagValue(args, "--rationale") ?? "",
				});
				const goal = plan.goals.at(-1);
				return {
					status: 0,
					stdout: json
						? renderCliWriteReceipt({
								ok: true,
								kind,
								goal_id: goal?.id,
								goals_path: getUltragoalPaths(cwd).goalsPath,
							})
						: "Accepted add_subgoal steering.\n",
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
	if (result.status === 0 && RECONCILE_COMMANDS.has(command)) {
		await reconcileUltragoalState(cwd);
	}
	return result;
}
