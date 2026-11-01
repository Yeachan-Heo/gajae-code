import type { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import type { DesktopGoal, DesktopSession, DesktopTodoPhase } from "./protocol";

/** Bounded well below any frame budget; a task list is a checklist, not a document. */
const MAX_PHASES = 24;
const MAX_TASKS = 120;
const MAX_TEXT = 300;

function text(value: unknown): string {
	if (typeof value !== "string") return "";
	return value.length > MAX_TEXT ? value.slice(0, MAX_TEXT) : value;
}

/**
 * Live `todo_write` state, so the desktop can show the checklist the tool maintains.
 * Returns no property at all when the list is empty, so the frame stays small.
 */
export function projectTodos(session?: AgentSession): Pick<DesktopSession, "todos"> | Record<string, never> {
	if (!session) return {};
	let phases: unknown;
	try {
		phases = session.getTodoPhases();
	} catch {
		return {};
	}
	if (!Array.isArray(phases) || phases.length === 0) return {};
	const projected: DesktopTodoPhase[] = [];
	let remaining = MAX_TASKS;
	for (const phase of phases.slice(0, MAX_PHASES)) {
		if (!phase || typeof phase !== "object") continue;
		const record = phase as { name?: unknown; tasks?: unknown };
		const tasks = Array.isArray(record.tasks) ? record.tasks : [];
		const items: DesktopTodoPhase["tasks"] = [];
		for (const task of tasks) {
			if (remaining <= 0) break;
			if (!task || typeof task !== "object") continue;
			const item = task as { content?: unknown; status?: unknown };
			const content = text(item.content);
			if (!content) continue;
			const status =
				item.status === "completed" || item.status === "in_progress" || item.status === "abandoned"
					? item.status
					: "pending";
			items.push({ content, status });
			remaining--;
		}
		if (items.length > 0) projected.push({ name: text(record.name), tasks: items });
	}
	return projected.length > 0 ? { todos: projected } : {};
}

/**
 * Active or retained goal state from the `goal` tool. Only the fields the desktop shows are
 * projected; the goal runtime's internal bookkeeping never leaves the host.
 */
export function projectGoal(session?: AgentSession): Pick<DesktopSession, "goal"> | Record<string, never> {
	if (!session) return {};
	let state: unknown;
	try {
		state = session.getGoalModeState();
	} catch {
		return {};
	}
	if (!state || typeof state !== "object") return {};
	const goal = (state as { goal?: unknown }).goal;
	if (!goal || typeof goal !== "object") return {};
	const record = goal as { objective?: unknown; status?: unknown; tokensUsed?: unknown; timeUsedSeconds?: unknown };
	const objective = text(record.objective);
	if (!objective) return {};
	// Only a recognised status is shown: guessing "active" would let the strip offer pause,
	// complete and drop for a state the SDK never reported.
	if (
		record.status !== "active" &&
		record.status !== "paused" &&
		record.status !== "complete" &&
		record.status !== "dropped"
	)
		return {};
	return {
		goal: {
			objective,
			status: record.status,
			...(typeof record.tokensUsed === "number" && record.tokensUsed >= 0 ? { tokensUsed: record.tokensUsed } : {}),
			...(typeof record.timeUsedSeconds === "number" && record.timeUsedSeconds >= 0
				? { timeUsedSeconds: record.timeUsedSeconds }
				: {}),
		},
	};
}

export type { DesktopGoal };
