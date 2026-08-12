/** A reveal request addressed to an existing JobsObserver owner. */

export interface JobsTaskRevealRoute {
	readonly kind: "jobs";
	readonly taskId: string;
	readonly sourceKind: "bash" | "cron";
}

export type TaskRevealUnavailableReason = "unsupported_kind" | "malformed_id";

/** A fail-closed route that carries no task data beyond a stable reason. */
export interface UnavailableTaskRevealRoute {
	readonly kind: "unavailable";
	readonly reason: TaskRevealUnavailableReason;
}

export type TaskRevealRoute = JobsTaskRevealRoute | UnavailableTaskRevealRoute;

const SAFE_TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isJobsTaskKind(value: unknown): value is JobsTaskRevealRoute["sourceKind"] {
	return value === "bash" || value === "cron";
}

function isSafeTaskId(value: unknown): value is string {
	return typeof value === "string" && SAFE_TASK_ID.test(value);
}

/**
 * Resolve a task identity to the only owner surfaces that can actually reveal
 * it. Subagent rows intentionally fail closed because they do not have a
 * JobsObserver owner/detail surface.
 */
export function resolveTaskRevealRoute(input: unknown): TaskRevealRoute {
	if (!isRecord(input)) return { kind: "unavailable", reason: "malformed_id" };
	try {
		const sourceKind = input.kind;
		if (!isJobsTaskKind(sourceKind)) return { kind: "unavailable", reason: "unsupported_kind" };
		if (typeof input.id !== "string") return { kind: "unavailable", reason: "malformed_id" };

		const prefix = `${sourceKind}:`;
		if (!input.id.startsWith(prefix)) return { kind: "unavailable", reason: "malformed_id" };
		const taskId = input.id.slice(prefix.length);
		if (!isSafeTaskId(taskId)) return { kind: "unavailable", reason: "malformed_id" };

		return { kind: "jobs", taskId, sourceKind };
	} catch {
		return { kind: "unavailable", reason: "malformed_id" };
	}
}

/** Validate a route before passing it to an owner callback. */
export function isTaskRevealRoute(value: unknown): value is JobsTaskRevealRoute {
	if (!isRecord(value)) return false;
	try {
		return value.kind === "jobs" && isSafeTaskId(value.taskId) && isJobsTaskKind(value.sourceKind);
	} catch {
		return false;
	}
}
