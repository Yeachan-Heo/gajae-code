import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { Snowflake } from "@gajae-code/utils";
import { type Goal, type GoalModeState, normalizeGoal } from "../goals/state";
import {
	buildSessionContext,
	loadEntriesFromFile,
	type ModeChangeEntry,
	type SessionEntry,
} from "../session/session-manager";
import { sessionStateDir, sessionUltragoalDir } from "./session-layout";
import { resolveGjcSessionForRead, resolveGjcSessionForWrite, writeSessionActivityMarker } from "./session-resolution";
import { removeFileAudited, writeJsonAtomic } from "./state-writer";

export const GJC_SESSION_FILE_ENV = "GJC_SESSION_FILE";
export const GJC_SESSION_ID_ENV = "GJC_SESSION_ID";
export const GJC_SESSION_CWD_ENV = "GJC_SESSION_CWD";

const REQUEST_VERSION = 1;
export const DEFAULT_ULTRAGOAL_OBJECTIVE =
	"Complete the durable ultragoal plan in .gjc/ultragoal/goals.json, including later accepted/appended stories, under the original brief constraints; use .gjc/ultragoal/ledger.jsonl as the audit trail.";

export interface PendingGoalModeRequest {
	version: typeof REQUEST_VERSION;
	kind: "goal_mode_request";
	source: "ultragoal";
	objective: string;
	createdAt: string;
	goalsPath?: string;
	sourcePlanPath?: string;
	sourceBriefHash?: string;
	planStatus?: string;
	/** Aggregate objective aliases for live/offline equivalence. */
	gjcObjectiveAliases?: string[];
	/**
	 * Session id that produced this request (from GJC_SESSION_ID). When present,
	 * only the originating session may consume it, so concurrent sessions sharing
	 * the same `.gjc` project state never auto-run each other's ultragoal.
	 */
	sessionId?: string;
}

export type CurrentSessionGoalModeWriteResult =
	| { status: "unavailable"; reason: "missing_session_file" | "empty_session_file" }
	| { status: "existing_goal"; goal: Goal }
	| { status: "needs_reconcile"; goal: Goal }
	| { status: "updated"; goal: Goal; sessionFile: string };

interface UltragoalPlanShape {
	gjcObjective?: unknown;
	gjcObjectiveAliases?: unknown;
	goals?: unknown[];
}

function isEnoent(error: unknown): boolean {
	return (
		typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT"
	);
}

function requestPath(cwd: string, sessionId: string): string {
	return path.join(sessionStateDir(cwd, sessionId), "goal-mode-request.json");
}

function ultragoalGoalsPath(cwd: string, sessionId: string): string {
	return path.join(sessionUltragoalDir(cwd, sessionId), "goals.json");
}

function ultragoalBriefPath(cwd: string, sessionId: string): string {
	return path.join(sessionUltragoalDir(cwd, sessionId), "brief.md");
}

const TERMINAL_OR_SKIPPED_GOAL_STATUSES = new Set([
	"complete",
	"failed",
	"blocked",
	"review_blocked",
	"superseded",
]);

function computePlanStatus(plan: UltragoalPlanShape): string | undefined {
	const goals = Array.isArray(plan.goals) ? plan.goals : [];
	if (goals.length === 0) return "pending";
	const allTerminal = goals.every(goal => {
		if (typeof goal !== "object" || goal === null) return false;
		const status = (goal as { status?: unknown }).status;
		return typeof status === "string" && TERMINAL_OR_SKIPPED_GOAL_STATUSES.has(status);
	});
	if (allTerminal) return "complete";
	const hasActive = goals.some(goal => {
		if (typeof goal !== "object" || goal === null) return false;
		return (goal as { status?: unknown }).status === "active";
	});
	if (hasActive) return "active";
	return "pending";
}

async function computeBriefHash(briefPath: string): Promise<string | undefined> {
	try {
		const content = await Bun.file(briefPath).text();
		return createHash("sha256").update(content).digest("hex");
	} catch (error) {
		if (isEnoent(error)) return undefined;
		throw error;
	}
}

function isCreateGoalsArg(value: string): boolean {
	return value === "create-goals" || value === "create";
}

export function isUltragoalCreateGoalsInvocation(args: readonly string[]): boolean {
	const command = args.find(arg => !arg.startsWith("-"));
	return command !== undefined && isCreateGoalsArg(command);
}

export async function readUltragoalGjcObjective(
	cwd: string,
	sessionId?: string | null,
): Promise<{
	objective: string;
	goalsPath: string;
	briefHash?: string;
	planStatus?: string;
	aliases?: string[];
}> {
	const session = sessionId?.trim()
		? { gjcSessionId: sessionId.trim() }
		: await resolveGjcSessionForRead(cwd, { envSessionId: process.env.GJC_SESSION_ID });
	const goalsPath = ultragoalGoalsPath(cwd, session.gjcSessionId);
	const briefPath = ultragoalBriefPath(cwd, session.gjcSessionId);
	try {
		const plan = (await Bun.file(goalsPath).json()) as UltragoalPlanShape;
		const objective = typeof plan.gjcObjective === "string" ? plan.gjcObjective.trim() : "";
		const aliases = Array.isArray(plan.gjcObjectiveAliases)
			? plan.gjcObjectiveAliases.filter(
					(value): value is string => typeof value === "string" && value.trim().length > 0,
				)
			: undefined;
		const briefHash = await computeBriefHash(briefPath);
		const planStatus = computePlanStatus(plan);
		return {
			objective: objective || DEFAULT_ULTRAGOAL_OBJECTIVE,
			goalsPath,
			...(briefHash ? { briefHash } : {}),
			...(planStatus ? { planStatus } : {}),
			...(aliases && aliases.length > 0 ? { aliases } : {}),
		};
	} catch (error) {
		if (isEnoent(error)) {
			return { objective: DEFAULT_ULTRAGOAL_OBJECTIVE, goalsPath };
		}
		throw error;
	}
}

export async function writePendingGoalModeRequest(input: {
	cwd: string;
	objective: string;
	goalsPath?: string;
	sourcePlanPath?: string;
	sourceBriefHash?: string;
	planStatus?: string;
	gjcObjectiveAliases?: string[];
	sessionId?: string | null;
}): Promise<PendingGoalModeRequest> {
	const objective = input.objective.trim();
	if (!objective) throw new Error("goal objective is required");
	const resolvedSessionId =
		input.sessionId?.trim() ||
		resolveGjcSessionForWrite(input.cwd, { envSessionId: process.env.GJC_SESSION_ID }).gjcSessionId;
	const sessionId = resolvedSessionId;
	const aliases = input.gjcObjectiveAliases?.map(alias => alias.trim()).filter(Boolean);
	const request: PendingGoalModeRequest = {
		version: REQUEST_VERSION,
		kind: "goal_mode_request",
		source: "ultragoal",
		objective,
		createdAt: new Date().toISOString(),
		goalsPath: input.goalsPath,
		...(input.sourcePlanPath ? { sourcePlanPath: input.sourcePlanPath } : {}),
		...(input.sourceBriefHash ? { sourceBriefHash: input.sourceBriefHash } : {}),
		...(input.planStatus ? { planStatus: input.planStatus } : {}),
		...(aliases && aliases.length > 0 ? { gjcObjectiveAliases: aliases } : {}),
		...(sessionId ? { sessionId } : {}),
	};
	const filePath = requestPath(input.cwd, sessionId);
	await writeJsonAtomic(filePath, request, {
		cwd: input.cwd,
		audit: { category: "state", verb: "write", owner: "gjc-runtime", sessionId },
	});
	await writeSessionActivityMarker(input.cwd, sessionId, { writer: "goal-mode-request", path: filePath });
	return request;
}

function goalFromModeData(modeData: Record<string, unknown> | undefined): Goal | null {
	return normalizeGoal(modeData?.goal);
}

function isNonTerminalGoal(goal: Goal | null): goal is Goal {
	return goal !== null && goal.status !== "complete" && goal.status !== "dropped";
}

function createGoalModeState(objective: string): GoalModeState {
	const now = Date.now();
	const goal: Goal = {
		id: String(Snowflake.next()),
		objective,
		status: "active",
		tokensUsed: 0,
		timeUsedSeconds: 0,
		createdAt: now,
		updatedAt: now,
	};
	return { enabled: true, mode: "active", goal };
}

function nextSessionEntryId(entries: readonly SessionEntry[]): string {
	const existing = new Set(entries.map(entry => entry.id));
	for (let index = 0; index < 100; index++) {
		const id = crypto.randomUUID().slice(-8);
		if (!existing.has(id)) return id;
	}
	return String(Snowflake.next());
}

/**
 * True if `current` equals `planObjective`, the default ultragoal objective,
 * or any alias entry. Used by both the session-file writer and the live
 * reconciliation bridge to classify whether an existing goal matches the
 * aggregate plan.
 */
export function aggregateObjectiveMatches(current: string, planObjective: string, aliases?: string[]): boolean {
	const normalized = current.trim();
	if (!normalized) return false;
	if (normalized === planObjective.trim()) return true;
	if (normalized === DEFAULT_ULTRAGOAL_OBJECTIVE) return true;
	if (aliases?.some(alias => alias.trim() === normalized)) return true;
	return false;
}

/**
 * Decide how the live activation path should handle a pending request relative
 * to the current goal. Returns one of:
 * - "create": no current goal, or current goal is terminal (complete/dropped)
 * - "keep": same objective and no provenance conflict
 * - "replace": mismatched objective with an ultragoal pending request
 * - "block": unclassifiable (e.g. provenance conflict on matching objective)
 */
export function shouldReconcileGoal(
	current: { objective: string; status: string; source?: string; sourcePlanPath?: string; sourceBriefHash?: string } | null,
	pending: {
		objective: string;
		sourcePlanPath?: string;
		sourceBriefHash?: string;
		gjcObjectiveAliases?: string[];
	},
): "create" | "keep" | "replace" | "block" {
	if (current === null) return "create";
	if (current.status === "complete" || current.status === "dropped") return "create";
	// Use the same aggregate equivalence model as the offline session-file writer.
	const sameObjective = aggregateObjectiveMatches(
		current.objective,
		pending.objective,
		pending.gjcObjectiveAliases,
	);
	if (!sameObjective) return "replace";
	// Same objective: check for provenance conflict (only when both sides have values).
	const planPathConflict =
		current.sourcePlanPath !== undefined &&
		pending.sourcePlanPath !== undefined &&
		current.sourcePlanPath !== pending.sourcePlanPath;
	const briefHashConflict =
		current.sourceBriefHash !== undefined &&
		pending.sourceBriefHash !== undefined &&
		current.sourceBriefHash !== pending.sourceBriefHash;
	if (planPathConflict || briefHashConflict) return "block";
	return "keep";
}

export async function writeCurrentSessionGoalModeState(input: {
	sessionFile?: string | null;
	objective: string;
	aggregateObjective?: string;
	aliases?: string[];
}): Promise<CurrentSessionGoalModeWriteResult> {
	const sessionFile = input.sessionFile?.trim();
	if (!sessionFile) return { status: "unavailable", reason: "missing_session_file" };

	const objective = input.objective.trim();
	if (!objective) throw new Error("goal objective is required");

	const fileEntries = await loadEntriesFromFile(sessionFile);
	const entries = fileEntries.filter((entry): entry is SessionEntry => entry.type !== "session");
	if (fileEntries.length === 0) return { status: "unavailable", reason: "empty_session_file" };

	const context = buildSessionContext(entries);
	const existingGoal = goalFromModeData(context.modeData);
	if ((context.mode === "goal" || context.mode === "goal_paused") && isNonTerminalGoal(existingGoal)) {
		// Authority split: the session-file writer never replaces a live goal.
		// If the existing objective matches the aggregate plan, return existing_goal.
		// If mismatched, return needs_reconcile WITHOUT mutating the session file —
		// the live pending-request path (GoalRuntime.reconcileGoalFromSource) handles
		// the actual replacement.
		const aggregateObjective = input.aggregateObjective?.trim() || objective;
		if (aggregateObjectiveMatches(existingGoal.objective, aggregateObjective, input.aliases)) {
			return { status: "existing_goal", goal: existingGoal };
		}
		return { status: "needs_reconcile", goal: existingGoal };
	}

	const state = createGoalModeState(objective);
	const entry: ModeChangeEntry = {
		type: "mode_change",
		id: nextSessionEntryId(entries),
		parentId: entries.at(-1)?.id ?? null,
		timestamp: new Date().toISOString(),
		mode: "goal",
		data: { goal: state.goal },
	};
	// The session transcript file lives outside `.gjc/` (GJC_SESSION_FILE), so it is not a
	// sanctioned-writer target; append directly.
	await fs.appendFile(sessionFile, `${JSON.stringify(entry)}\n`);
	return { status: "updated", goal: state.goal, sessionFile };
}

export async function peekPendingGoalModeRequest(
	cwd: string,
	currentSessionId?: string | null,
): Promise<PendingGoalModeRequest | null> {
	const session = currentSessionId?.trim()
		? { gjcSessionId: currentSessionId.trim() }
		: await resolveGjcSessionForRead(cwd, { envSessionId: process.env.GJC_SESSION_ID });
	const filePath = requestPath(cwd, session.gjcSessionId);
	let raw: unknown;
	try {
		raw = await Bun.file(filePath).json();
	} catch (error) {
		if (isEnoent(error)) return null;
		throw error;
	}
	const candidate = raw as Partial<PendingGoalModeRequest>;
	if (
		candidate.version !== REQUEST_VERSION ||
		candidate.kind !== "goal_mode_request" ||
		candidate.source !== "ultragoal" ||
		typeof candidate.objective !== "string" ||
		candidate.objective.trim().length === 0
	) {
		return null;
	}
	// Session isolation: a request stamped with an owning session id may only be
	// consumed by that same session. Leave another session's request untouched
	// (do not delete it) so its rightful owner can still pick it up. Legacy/unscoped
	// requests (no sessionId) remain consumable by any session in this cwd.
	const ownerSessionId = typeof candidate.sessionId === "string" ? candidate.sessionId.trim() : "";
	if (ownerSessionId && ownerSessionId !== (currentSessionId?.trim() ?? "")) {
		return null;
	}
	const aliases = Array.isArray(candidate.gjcObjectiveAliases)
		? candidate.gjcObjectiveAliases.filter(
				(alias): alias is string => typeof alias === "string" && alias.trim().length > 0,
			)
		: undefined;
	return {
		...candidate,
		objective: candidate.objective.trim(),
		...(aliases && aliases.length > 0 ? { gjcObjectiveAliases: aliases } : {}),
	} as PendingGoalModeRequest;
}

/** Delete a previously peeked pending request after successful reconciliation. */
export async function ackPendingGoalModeRequest(
	cwd: string,
	currentSessionId?: string | null,
): Promise<void> {
	const session = currentSessionId?.trim()
		? { gjcSessionId: currentSessionId.trim() }
		: await resolveGjcSessionForRead(cwd, { envSessionId: process.env.GJC_SESSION_ID });
	const filePath = requestPath(cwd, session.gjcSessionId);
	await removeFileAudited(filePath, {
		cwd,
		audit: { category: "prune", verb: "remove", owner: "gjc-runtime", sessionId: session.gjcSessionId },
	}).catch(error => {
		if (!isEnoent(error)) throw error;
	});
}

export async function consumePendingGoalModeRequest(
	cwd: string,
	currentSessionId?: string | null,
): Promise<PendingGoalModeRequest | null> {
	const pending = await peekPendingGoalModeRequest(cwd, currentSessionId);
	if (!pending) return null;
	await ackPendingGoalModeRequest(cwd, currentSessionId);
	return pending;
}

export function buildGjcRuntimeSessionEnv(input: {
	sessionFile?: string | null;
	sessionId?: string | null;
	cwd?: string | null;
}): Record<string, string> {
	const env: Record<string, string> = {};
	if (input.sessionFile) env[GJC_SESSION_FILE_ENV] = input.sessionFile;
	if (input.sessionId) env[GJC_SESSION_ID_ENV] = input.sessionId;
	if (input.cwd) env[GJC_SESSION_CWD_ENV] = input.cwd;
	return env;
}
