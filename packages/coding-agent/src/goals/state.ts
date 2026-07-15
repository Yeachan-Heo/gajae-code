import type { UsageStatistics } from "../session/session-manager";

export type GoalStatus = "active" | "paused" | "complete" | "dropped";

export const GOAL_LAST_ERROR_CLASSES = [
	"connection_refused",
	"dns",
	"config",
	"stream_stall",
	"timeout",
	"first_event_timeout",
	"usage_limit",
	"local_unavailable",
	"terminal",
	"cancelled",
	"retry_recovery_failed",
	"compaction_recovery_failed",
	"unknown",
] as const;

export type GoalLastErrorClass = (typeof GOAL_LAST_ERROR_CLASSES)[number];

export const GOAL_LAST_ERROR_PAUSE_CAUSES = [
	"provider_final_error",
	"retry_cap_exceeded",
	"retry_cancelled",
	"retry_recovery_failed",
	"compaction_recovery_failed",
	"terminal_error",
] as const;

export type GoalLastErrorPauseCause = (typeof GOAL_LAST_ERROR_PAUSE_CAUSES)[number];

export interface GoalLastError {
	source: "goal-continuation";
	class: GoalLastErrorClass;
	message: string;
	occurred_at: number;
	pause_cause: GoalLastErrorPauseCause;
	retry_attempt?: number;
	generation_id?: string;
}

export interface Goal {
	id: string;
	objective: string;
	status: GoalStatus;
	tokensUsed: number;
	timeUsedSeconds: number;
	createdAt: number;
	updatedAt: number;
	last_error?: GoalLastError;
}

export interface GoalModeState {
	enabled: boolean;
	mode: "active" | "exiting";
	reason?: "completed";
	goal: Goal;
}
export interface GoalToolDetails {
	op: "create" | "get" | "complete" | "resume" | "drop" | "pause";
	goal?: Goal | null;
}

export type GoalRuntimeEvent =
	| { type: "goal_updated"; goal: Goal | null; state?: GoalModeState }
	| { type: "goal_continuation_requested"; prompt: string };

export type GoalTokenUsage = Pick<UsageStatistics, "input" | "output" | "cacheRead" | "cacheWrite">;

function isGoalLastErrorClass(value: unknown): value is GoalLastErrorClass {
	return GOAL_LAST_ERROR_CLASSES.includes(value as GoalLastErrorClass);
}

function isGoalLastErrorPauseCause(value: unknown): value is GoalLastErrorPauseCause {
	return GOAL_LAST_ERROR_PAUSE_CAUSES.includes(value as GoalLastErrorPauseCause);
}

export function normalizeGoalLastError(candidate: unknown): GoalLastError | undefined {
	if (typeof candidate !== "object" || candidate === null) return undefined;
	const value = candidate as Record<string, unknown>;
	if (
		value.source !== "goal-continuation" ||
		!isGoalLastErrorClass(value.class) ||
		typeof value.message !== "string" ||
		typeof value.occurred_at !== "number" ||
		!isGoalLastErrorPauseCause(value.pause_cause)
	) {
		return undefined;
	}
	if (value.retry_attempt !== undefined && typeof value.retry_attempt !== "number") return undefined;
	if (value.generation_id !== undefined && typeof value.generation_id !== "string") return undefined;
	return {
		source: value.source,
		class: value.class,
		message: value.message,
		occurred_at: value.occurred_at,
		pause_cause: value.pause_cause,
		...(value.retry_attempt !== undefined ? { retry_attempt: value.retry_attempt } : {}),
		...(value.generation_id !== undefined ? { generation_id: value.generation_id } : {}),
	};
}

export function normalizeGoal(candidate: unknown): Goal | null {
	if (typeof candidate !== "object" || candidate === null) return null;
	const value = candidate as Record<string, unknown>;
	if (
		typeof value.id !== "string" ||
		typeof value.objective !== "string" ||
		typeof value.status !== "string" ||
		typeof value.tokensUsed !== "number" ||
		typeof value.timeUsedSeconds !== "number" ||
		typeof value.createdAt !== "number" ||
		typeof value.updatedAt !== "number"
	) {
		return null;
	}
	const status = value.status === "budget-limited" ? "active" : value.status;
	if (status !== "active" && status !== "paused" && status !== "complete" && status !== "dropped") {
		return null;
	}
	const last_error = normalizeGoalLastError(value.last_error);
	return {
		id: value.id,
		objective: value.objective,
		status,
		tokensUsed: value.tokensUsed,
		timeUsedSeconds: value.timeUsedSeconds,
		createdAt: value.createdAt,
		updatedAt: value.updatedAt,
		...(last_error ? { last_error } : {}),
	};
}

export function normalizeGoalModeState(candidate: GoalModeState | undefined): GoalModeState | undefined {
	if (!candidate) return undefined;
	const goal = normalizeGoal(candidate.goal);
	if (!goal) return undefined;
	return { ...candidate, goal };
}
