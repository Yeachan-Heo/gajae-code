import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { DEFAULT_ULTRAGOAL_OBJECTIVE } from "./goal-mode-request";

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

const SCHEDULABLE_STATUSES = new Set<UltragoalGoalStatus>(["pending", "active", "failed"]);

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

async function ensureUltragoalDir(paths: UltragoalPaths): Promise<void> {
	await fs.mkdir(paths.dir, { recursive: true });
}

async function appendLedger(cwd: string, event: JsonObject): Promise<UltragoalLedgerEvent> {
	const paths = getUltragoalPaths(cwd);
	await ensureUltragoalDir(paths);
	const entry: UltragoalLedgerEvent = {
		eventId: typeof event.eventId === "string" ? event.eventId : crypto.randomUUID(),
		...event,
		timestamp: new Date().toISOString(),
	};
	await fs.appendFile(paths.ledgerPath, `${JSON.stringify(entry)}\n`);
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
	await ensureUltragoalDir(paths);
	await Bun.write(paths.briefPath, `${plan.brief.trim()}\n`);
	await Bun.write(paths.goalsPath, `${JSON.stringify(plan, null, 2)}\n`);
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

function titleFromBrief(brief: string): string {
	const firstLine = brief
		.split(/\r?\n/)
		.map(line => line.trim())
		.find(line => line.length > 0);
	if (!firstLine) return "Complete ultragoal brief";
	return firstLine.length > 80 ? `${firstLine.slice(0, 77)}...` : firstLine;
}

export async function createUltragoalPlan(input: {
	cwd: string;
	brief: string;
	gjcGoalMode?: UltragoalGjcGoalMode;
}): Promise<UltragoalPlan> {
	const brief = input.brief.trim();
	if (!brief) throw new Error("ultragoal brief is required");
	const now = new Date().toISOString();
	const plan: UltragoalPlan = {
		version: 1,
		brief,
		gjcGoalMode: input.gjcGoalMode ?? "aggregate",
		gjcObjective: DEFAULT_ULTRAGOAL_OBJECTIVE,
		goals: [
			{
				id: "G001",
				title: titleFromBrief(brief),
				objective: brief,
				status: "pending",
				createdAt: now,
				updatedAt: now,
			},
		],
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

async function readRequiredCompletionQualityGate(cwd: string, value: string | undefined): Promise<unknown> {
	if (!value?.trim()) {
		throw new Error(
			"checkpoint --status complete requires --quality-gate-json with codeReview.recommendation APPROVE and codeReview.architectStatus CLEAR",
		);
	}
	const gate = await readStructuredValue(cwd, value);
	const gateObject = qualityGateObject(gate);
	const codeReview = qualityGateObject(gateObject?.codeReview);
	if (codeReview?.recommendation !== "APPROVE" || codeReview.architectStatus !== "CLEAR") {
		throw new Error(
			"checkpoint --status complete requires architect review approval: codeReview.recommendation must be APPROVE and codeReview.architectStatus must be CLEAR",
		);
	}
	return gate;
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
	await appendLedger(input.cwd, {
		eventId: pendingCheckpointEventId,
		event: "goal_checkpointed",
		goalId: goal.id,
		status: input.status,
		evidence,
		gjcGoalJson: input.gjcGoalJson ? await readStructuredValue(input.cwd, input.gjcGoalJson) : undefined,
		qualityGateJson,
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
	if (!summary.exists) {
		return `No ultragoal plan found at ${summary.paths.goalsPath}. Run \`gjc ultragoal create-goals --brief "..."\` first.\n`;
	}
	const current = summary.currentGoal ? ` Current: ${summary.currentGoal.id} (${summary.currentGoal.status}).` : "";
	return `Ultragoal ${summary.status}: ${summary.counts.complete}/${summary.goals.length} complete.${current}\n`;
}

function renderCompleteHandoff(
	result: { plan: UltragoalPlan; goal?: UltragoalGoal; allComplete: boolean },
	json: boolean,
): string {
	if (json) return `${JSON.stringify(result, null, 2)}\n`;
	if (result.allComplete) return "All ultragoal goals are complete.\n";
	if (!result.goal) return "No schedulable ultragoal goal found.\n";
	return [
		`Ultragoal handoff: ${result.goal.id} — ${result.goal.title}`,
		`Objective: ${result.goal.objective}`,
		`GJC objective: ${result.plan.gjcObjective}`,
		"Call get_goal({}); create_goal only if no active GJC goal exists, then complete this GJC story.",
		"Before checkpointing complete, obtain a passing architectReview (architecture/product/code CLEAR + APPROVE) and executorQa (e2e/red-team passed); record blockers instead of completing on any finding.",
		"",
	].join("\n");
}

export async function runNativeUltragoalCommand(args: string[], cwd = process.cwd()): Promise<UltragoalCommandResult> {
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
						? `${JSON.stringify(plan, null, 2)}\n`
						: `Created ultragoal plan with ${plan.goals.length} goal at ${getUltragoalPaths(cwd).goalsPath}.\n`,
				};
			}
			case "complete-goals":
				return {
					status: 0,
					stdout: renderCompleteHandoff(
						await startNextUltragoalGoal({ cwd, retryFailed: hasFlag(args, "--retry-failed") }),
						json,
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
				return {
					status: 0,
					stdout: json ? `${JSON.stringify(plan, null, 2)}\n` : `Checkpointed ${goalId} as ${status}.\n`,
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
				return {
					status: 0,
					stdout: json ? `${JSON.stringify(plan, null, 2)}\n` : "Accepted add_subgoal steering.\n",
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
				return { status: 0, stdout: json ? `${JSON.stringify(plan, null, 2)}\n` : "Recorded review blockers.\n" };
			}
			default:
				return { status: 1, stderr: `Unknown gjc ultragoal command: ${command}\n` };
		}
	} catch (error) {
		return { status: 1, stderr: `${error instanceof Error ? error.message : String(error)}\n` };
	}
}
