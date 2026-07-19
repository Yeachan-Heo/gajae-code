import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Snowflake } from "@gajae-code/utils";
import { type Goal, type GoalModeState, type GoalProvenance, normalizeGoal } from "../goals/state";

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
	provenance: Extract<GoalProvenance, { source: "ultragoal" }>;

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
	| { status: "updated"; goal: Goal; sessionFile: string };

interface UltragoalPlanShape {
	gjcObjective?: unknown;
	goals?: Array<{ id?: unknown }>;
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
): Promise<{ objective: string; goalsPath: string; provenance: Extract<GoalProvenance, { source: "ultragoal" }> }> {
	const session = sessionId?.trim()
		? { gjcSessionId: sessionId.trim() }
		: await resolveGjcSessionForRead(cwd, { envSessionId: process.env.GJC_SESSION_ID });
	const goalsPath = ultragoalGoalsPath(cwd, session.gjcSessionId);
	try {
		const plan = (await Bun.file(goalsPath).json()) as UltragoalPlanShape;
		const objective = typeof plan.gjcObjective === "string" ? plan.gjcObjective.trim() : "";
		const goalId = typeof plan.goals?.[0]?.id === "string" ? plan.goals[0].id : "aggregate";
		return {
			objective: objective || DEFAULT_ULTRAGOAL_OBJECTIVE,
			goalsPath,
			provenance: { source: "ultragoal", runId: session.gjcSessionId, goalId },
		};
	} catch (error) {
		if (isEnoent(error)) {
			return {
				objective: DEFAULT_ULTRAGOAL_OBJECTIVE,
				goalsPath,
				provenance: { source: "ultragoal", runId: session.gjcSessionId, goalId: "aggregate" },
			};
		}

		throw error;
	}
}

export async function writePendingGoalModeRequest(input: {
	cwd: string;
	objective: string;
	goalsPath?: string;
	sessionId?: string | null;
	provenance?: Extract<GoalProvenance, { source: "ultragoal" }>;
}): Promise<PendingGoalModeRequest> {
	const objective = input.objective.trim();
	if (!objective) throw new Error("goal objective is required");
	const resolvedSessionId =
		input.sessionId?.trim() ||
		resolveGjcSessionForWrite(input.cwd, { envSessionId: process.env.GJC_SESSION_ID }).gjcSessionId;
	const sessionId = resolvedSessionId;
	const request: PendingGoalModeRequest = {
		version: REQUEST_VERSION,
		kind: "goal_mode_request",
		source: "ultragoal",
		objective,
		createdAt: new Date().toISOString(),
		goalsPath: input.goalsPath,
		provenance: input.provenance ?? { source: "ultragoal", runId: sessionId, goalId: "aggregate" },

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

function matchesGoalModeRequest(existingGoal: Goal, objective: string, provenance: Goal["provenance"]): boolean {
	const existingProvenance = existingGoal.provenance;
	if (existingProvenance?.source === "ultragoal" && provenance?.source === "ultragoal") {
		return existingProvenance.runId === provenance.runId && existingProvenance.goalId === provenance.goalId;
	}
	// Legacy goals have no durable identity. Only an exact normalized objective can
	// establish that they are the same goal.
	return existingGoal.objective.trim() === objective;
}

function hasProvenDifferentDurablePlan(existingGoal: Goal, provenance: Goal["provenance"]): boolean {
	const existingProvenance = existingGoal.provenance;
	return (
		existingProvenance?.source === "ultragoal" &&
		provenance?.source === "ultragoal" &&
		existingProvenance.runId !== provenance.runId
	);
}

function createGoalModeState(objective: string, provenance: Goal["provenance"]): GoalModeState {
	const now = Date.now();
	const goal: Goal = {
		id: String(Snowflake.next()),
		objective,
		status: "active",
		tokensUsed: 0,
		timeUsedSeconds: 0,
		createdAt: now,
		updatedAt: now,
		...(provenance ? { provenance } : {}),
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

export async function writeCurrentSessionGoalModeState(input: {
	sessionFile?: string | null;
	objective: string;
	provenance?: Goal["provenance"];
}): Promise<CurrentSessionGoalModeWriteResult> {
	const sessionFile = input.sessionFile?.trim();
	if (!sessionFile) return { status: "unavailable", reason: "missing_session_file" };

	const objective = input.objective.trim();
	if (!objective) throw new Error("goal objective is required");

	const fileEntries = await loadEntriesFromFile(sessionFile);
	const entries = fileEntries.filter((entry): entry is SessionEntry => entry.type !== "session");
	if (fileEntries.length === 0) return { status: "unavailable", reason: "empty_session_file" };

	const requestedProvenance = input.provenance;
	const context = buildSessionContext(entries);
	const existingGoal = goalFromModeData(context.modeData);
	if ((context.mode === "goal" || context.mode === "goal_paused") && isNonTerminalGoal(existingGoal)) {
		if (matchesGoalModeRequest(existingGoal, objective, requestedProvenance)) {
			return { status: "existing_goal", goal: existingGoal };
		}
		// A legacy or user goal cannot establish that the incoming ultragoal request
		// belongs to a different durable plan. Preserve it rather than overwriting
		// active user work; only a distinct ultragoal run ID may replace it.
		if (!hasProvenDifferentDurablePlan(existingGoal, requestedProvenance)) {
			return { status: "existing_goal", goal: existingGoal };
		}
	}

	const state = createGoalModeState(objective, requestedProvenance);
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

export async function consumePendingGoalModeRequest(
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
	if (ownerSessionId && ownerSessionId !== session.gjcSessionId) {
		return null;
	}
	await removeFileAudited(filePath, {
		cwd,
		audit: { category: "prune", verb: "remove", owner: "gjc-runtime", sessionId: session.gjcSessionId },
	}).catch(error => {
		if (!isEnoent(error)) throw error;
	});
	return { ...candidate, objective: candidate.objective.trim() } as PendingGoalModeRequest;
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
