import type { UsageStatistics } from "../session/session-manager";

export type GoalStatus = "active" | "paused" | "complete" | "dropped";

export interface Goal {
	id: string;
	objective: string;
	status: GoalStatus;
	tokensUsed: number;
	timeUsedSeconds: number;
	createdAt: number;
	updatedAt: number;
}

export interface GoalModeState {
	enabled: boolean;
	mode: "active" | "exiting";
	reason?: "completed";
	goal: Goal;
}
export interface GoalToolDetails {
	op: "create" | "get" | "complete" | "resume" | "drop";
	goal?: Goal | null;
}

export type GoalRuntimeEvent =
	| { type: "goal_updated"; goal: Goal | null; state?: GoalModeState }
	| { type: "goal_continuation_requested"; prompt: string };

export type GoalTokenUsage = Pick<UsageStatistics, "input" | "output" | "cacheRead" | "cacheWrite">;

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
	return {
		id: value.id,
		objective: value.objective,
		status,
		tokensUsed: value.tokensUsed,
		timeUsedSeconds: value.timeUsedSeconds,
		createdAt: value.createdAt,
		updatedAt: value.updatedAt,
	};
}

export function normalizeGoalModeState(candidate: GoalModeState | undefined): GoalModeState | undefined {
	if (!candidate) return undefined;
	const goal = normalizeGoal(candidate.goal);
	if (!goal) return undefined;
	return { ...candidate, goal };
}
