import type { AsyncJob, AsyncJobManager, SubagentRecord } from "../async/job-manager";
import type { CronJobView, JobsObserver } from "./jobs-observer";
import type { ObservableSession, SessionObserverRegistry } from "./session-observer-registry";

export type TaskStatus = "running" | "waiting" | "done" | "failed" | "cancelled";
export type TaskKind = "bash" | "subagent" | "cron";

export interface TaskRow {
	id: string;
	kind: TaskKind;
	label: string;
	status: TaskStatus;
	startedAt: number;
	resumable?: boolean;
	monitorOutputLines?: number;
}

export interface TasksSnapshot {
	rows: TaskRow[];
	worstState: TaskStatus | "none";
	failedUnacknowledged: boolean;
}

export const EMPTY_TASKS_SNAPSHOT: TasksSnapshot = { rows: [], worstState: "none", failedUnacknowledged: false };

const ASYNC_STATUS: Record<AsyncJob["status"], TaskStatus> = {
	running: "running",
	paused: "waiting",
	completed: "done",
	failed: "failed",
	cancelled: "cancelled",
};
const SESSION_STATUS: Record<ObservableSession["status"], TaskStatus> = {
	active: "running",
	completed: "done",
	failed: "failed",
	aborted: "cancelled",
};
const SUBAGENT_STATUS: Record<SubagentRecord["status"], TaskStatus> = {
	running: "running",
	queued: "waiting",
	paused: "waiting",
	completed: "done",
	failed: "failed",
	cancelled: "cancelled",
};
const STATUS_RANK: Record<TaskStatus, number> = { done: 1, cancelled: 2, waiting: 3, running: 4, failed: 5 };

const MAX_TERMINAL_HISTORY_ROWS = 100;

export function mapAsyncJobStatus(status: AsyncJob["status"]): TaskStatus {
	return ASYNC_STATUS[status];
}

export function mapSessionStatus(status: ObservableSession["status"]): TaskStatus {
	return SESSION_STATUS[status];
}

export function mapSubagentStatus(status: SubagentRecord["status"]): TaskStatus {
	return SUBAGENT_STATUS[status];
}

export function mapCronStatus(cron: Pick<CronJobView, "firing">): TaskStatus {
	return cron.firing ? "running" : "waiting";
}

/** Joins manager jobs, monitor/cron views, and live session metadata. Stable
 * subagent records are canonical for lifecycle state; the registry contributes
 * only the current display label and timestamp. */
export class TasksAggregator {
	readonly #listeners = new Set<() => void>();
	readonly #unsubscribers: Array<() => void> = [];
	#snapshot: TasksSnapshot = EMPTY_TASKS_SNAPSHOT;
	#scheduled = false;
	#disposed = false;

	constructor(
		readonly manager: AsyncJobManager,
		readonly jobsObserver: JobsObserver,
		readonly sessions: SessionObserverRegistry,
		readonly ownerId?: string,
	) {
		this.#unsubscribers.push(manager.onChange(() => this.#changed()));
		this.#unsubscribers.push(jobsObserver.onChange(() => this.#changed()));
		this.#unsubscribers.push(sessions.onChange(() => this.#changed()));
		this.#recompute();
	}

	onChange(cb: () => void): () => void {
		this.#listeners.add(cb);
		return () => this.#listeners.delete(cb);
	}

	getSnapshot(): TasksSnapshot {
		return this.#snapshot;
	}

	acknowledgeFailures(): void {
		this.jobsObserver.acknowledgeFailures();
		this.#recompute();
	}

	#changed(): void {
		if (this.#disposed) return;
		this.#recompute();
		if (this.#scheduled) return;
		this.#scheduled = true;
		queueMicrotask(() => {
			this.#scheduled = false;
			if (!this.#disposed) for (const listener of this.#listeners) listener();
		});
	}

	#recompute(): void {
		const rows: TaskRow[] = [];
		const filter = this.ownerId ? { ownerId: this.ownerId } : undefined;
		const jobs = this.manager.getAllJobs(filter);
		const monitorIds = new Set(this.jobsObserver.getSnapshot().monitors.map(monitor => monitor.id));
		for (const job of jobs) {
			// A subagent task is represented by its stable control-plane record.
			if (job.metadata?.subagent) continue;
			if (job.type !== "bash") continue;
			rows.push({
				id: `bash:${job.id}`,
				kind: "bash",
				label: job.label,
				status: ASYNC_STATUS[job.status],
				startedAt: job.startTime,
				monitorOutputLines: monitorIds.has(job.id)
					? lineCount(this.jobsObserver.getMonitorOutput(job.id))
					: undefined,
			});
		}

		const records = new Map(this.manager.getSubagentRecords(filter).map(record => [record.subagentId, record]));
		const liveIds = new Set<string>();
		for (const session of this.sessions.getSessions()) {
			if (session.kind !== "subagent") continue;
			liveIds.add(session.id);
			const record = records.get(session.id);
			rows.push({
				id: `subagent:${session.id}`,
				kind: "subagent",
				label: session.label,
				status: record ? SUBAGENT_STATUS[record.status] : SESSION_STATUS[session.status],
				startedAt: session.lastUpdate,
				resumable: record?.resumable,
			});
		}
		for (const record of records.values()) {
			if (liveIds.has(record.subagentId)) continue;
			rows.push({
				id: `subagent:${record.subagentId}`,
				kind: "subagent",
				label: record.subagentId,
				status: SUBAGENT_STATUS[record.status],
				startedAt: record.queued?.createdAt ?? 0,
				resumable: record.resumable,
			});
		}
		for (const cron of this.jobsObserver.getSnapshot().crons) rows.push(cronRow(cron));
		rows.sort((a, b) => b.startedAt - a.startedAt || a.id.localeCompare(b.id));
		let terminalRows = 0;
		const boundedRows = rows.filter(row => {
			if (row.status !== "done" && row.status !== "failed" && row.status !== "cancelled") return true;
			terminalRows++;
			return terminalRows <= MAX_TERMINAL_HISTORY_ROWS;
		});
		const failedUnacknowledged = this.jobsObserver.getSnapshot().failedUnacknowledged;
		const worstState = failedUnacknowledged
			? "failed"
			: boundedRows.reduce<TasksSnapshot["worstState"]>(
					(worst, row) => (worst === "none" || STATUS_RANK[row.status] > STATUS_RANK[worst] ? row.status : worst),
					"none",
				);
		this.#snapshot = { rows: boundedRows, worstState, failedUnacknowledged };
	}

	dispose(): void {
		this.#disposed = true;
		for (const unsubscribe of this.#unsubscribers) unsubscribe();
		this.#unsubscribers.length = 0;
		this.#listeners.clear();
	}
}

function cronRow(cron: CronJobView): TaskRow {
	return {
		id: `cron:${cron.id}`,
		kind: "cron",
		label: cron.humanSchedule,
		status: cron.firing ? "running" : "waiting",
		startedAt: cron.createdAt,
	};
}

function lineCount(output: string): number {
	return output.length === 0 ? 0 : output.split("\n").length;
}
