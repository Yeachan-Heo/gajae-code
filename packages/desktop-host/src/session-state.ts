import type { CreateAgentSessionResult } from "@gajae-code/coding-agent/sdk";
import type { DesktopGoal, DesktopSession, DesktopTodoPhase } from "./protocol";

type Session = CreateAgentSessionResult["session"];

/** Bounded well below any frame budget; a task list is a checklist, not a document. */
const MAX_PHASES = 24;
const MAX_TASKS = 120;
const MAX_TEXT = 300;
const MAX_SOURCE_TEXT = 8 * 1024 * 1024;
/** Notes kept per task: the newest ones, since notes are append-only and the latest says the most. */
const MAX_NOTES = 5;

function text(value: unknown, redact: (value: string) => string): string {
	if (typeof value !== "string" || value.length > MAX_SOURCE_TEXT) return "";
	const redacted = redact(value);
	return redacted.length > MAX_TEXT ? redacted.slice(0, MAX_TEXT) : redacted;
}

/**
 * A task's newest notes in the order they were written. `todo_write` never validates its notes
 * array, so non-string and empty entries are skipped rather than shown.
 */
function notes(value: unknown, redact: (value: string) => string): string[] {
	if (!Array.isArray(value)) return [];
	const projected: string[] = [];
	for (let index = value.length - 1; index >= 0 && projected.length < MAX_NOTES; index--) {
		const note = text(value[index], redact);
		if (note.trim()) projected.push(note);
	}
	return projected.reverse();
}

/**
 * Live `todo_write` state, so the desktop can show the checklist the tool maintains.
 * Returns no property at all when the list is empty, so the frame stays small. Each task keeps
 * at most its newest `MAX_NOTES` notes, each redacted whole before it is cut like task text.
 */
export function projectTodos(
	session?: Pick<Session, "getTodoPhases">,
	redact: (value: string) => string = value => value,
): Pick<DesktopSession, "todos"> | Record<string, never> {
	if (!session) return {};
	let phases: unknown;
	try {
		phases = session.getTodoPhases();
	} catch {
		return {};
	}
	const todos = projectTodoPhases(phases, redact);
	return todos ? { todos } : {};
}

/**
 * The same projection for phases of any origin, such as a `todo_write` result's `details`: every
 * field is checked here, so the value needs no type. Undefined when no task can be shown.
 */
export function projectTodoPhases(
	phases: unknown,
	redact: (value: string) => string = value => value,
): DesktopTodoPhase[] | undefined {
	if (!Array.isArray(phases) || phases.length === 0) return undefined;
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
			const item = task as { content?: unknown; status?: unknown; notes?: unknown };
			const content = text(item.content, redact);
			if (!content) continue;
			const status =
				item.status === "completed" || item.status === "in_progress" || item.status === "abandoned"
					? item.status
					: "pending";
			const taskNotes = notes(item.notes, redact);
			items.push(taskNotes.length > 0 ? { content, status, notes: taskNotes } : { content, status });
			remaining--;
		}
		if (items.length > 0) projected.push({ name: text(record.name, redact), tasks: items });
	}
	return projected.length > 0 ? projected : undefined;
}

/**
 * Active or retained goal state from the `goal` tool. Only the fields the desktop shows are
 * projected; the goal runtime's internal bookkeeping never leaves the host.
 */
export function projectGoal(
	session?: Pick<Session, "getGoalModeState">,
	redact: (value: string) => string = value => value,
): Pick<DesktopSession, "goal"> | Record<string, never> {
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
	const objective = text(record.objective, redact);
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
