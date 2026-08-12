import type { AsyncJob, AsyncJobManager, SubagentRecord } from "../async/job-manager";
import type {
	AttentionEventAcknowledgement,
	AttentionEventStatus,
	AttentionEventStore,
	AttentionStoreMutationResult,
	AttentionStoreStatus,
} from "./attention-event-store";
import { attentionIdentityKey } from "./attention-event-store";

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
	/** Number of current rows omitted by the hard task-list bound. */
	overflowCount?: number;
	/** Attention persistence condition that needs a safe, non-failure status. */
	attentionStatus?: AttentionStoreStatus;
}

export const EMPTY_TASKS_SNAPSHOT: TasksSnapshot = {
	rows: [],
	worstState: "none",
	failedUnacknowledged: false,
	overflowCount: 0,
};

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
const MAX_TASK_ROWS = 500;
const MAX_SESSION_GENERATIONS = MAX_TASK_ROWS;

export interface TasksAcknowledgementReceipt extends AttentionStoreMutationResult {
	readonly state: "acknowledged" | "failed";
}

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
	readonly #sessionGenerations = new Map<string, string>();
	readonly manager: AsyncJobManager;
	readonly jobsObserver: JobsObserver;
	readonly sessions: SessionObserverRegistry;
	readonly ownerId: string | undefined;
	readonly attentionStore: AttentionEventStore | undefined;
	#snapshot: TasksSnapshot = EMPTY_TASKS_SNAPSHOT;
	#scheduled = false;
	#disposed = false;
	#storeObservationStatus: AttentionStoreStatus | undefined;

	constructor(
		manager: AsyncJobManager,
		jobsObserver: JobsObserver,
		sessions: SessionObserverRegistry,
		ownerIdOrStore?: string | AttentionEventStore,
		attentionStore?: AttentionEventStore,
	) {
		this.manager = manager;
		this.jobsObserver = jobsObserver;
		this.sessions = sessions;
		this.ownerId = typeof ownerIdOrStore === "string" ? ownerIdOrStore : undefined;
		this.attentionStore = typeof ownerIdOrStore === "string" ? attentionStore : (ownerIdOrStore ?? attentionStore);
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

	async acknowledgeFailures(): Promise<TasksAcknowledgementReceipt> {
		if (!this.attentionStore) {
			this.jobsObserver.acknowledgeFailures();
			this.#recompute();
			return { ok: true, status: "ready", changed: false, state: "acknowledged" };
		}

		const storeSnapshot = this.attentionStore.getSnapshot();
		const expected: AttentionEventAcknowledgement[] = storeSnapshot.events
			.filter(event => event.status === "failed" && event.acknowledgedRevision !== event.revision)
			.map(event => ({
				kind: event.kind,
				sourceId: event.sourceId,
				generation: event.generation,
				revision: event.revision,
			}));
		const durable = storeSnapshot.status === "ready";
		const localMemory = storeSnapshot.status === "memory_only" && this.attentionStore.filePath === undefined;
		if (!durable && !localMemory) {
			this.#recompute();
			return { ok: false, status: storeSnapshot.status, changed: false, state: "failed" };
		}
		const managerFailedAtInvocation = this.jobsObserver.getSnapshot().failedUnacknowledged;
		if (expected.length === 0 && managerFailedAtInvocation) {
			this.#recompute();
			return { ok: false, status: storeSnapshot.status, changed: false, state: "failed" };
		}

		const result = await this.attentionStore.acknowledgeFailures(expected);
		const committed =
			result.ok &&
			(result.status === "ready" || (result.status === "memory_only" && this.attentionStore.filePath === undefined));
		const storeStillClear = !this.attentionStore.getSnapshot().failedUnacknowledged;
		if (committed && storeStillClear && this.#managerFailuresCoveredBy(expected))
			this.jobsObserver.acknowledgeFailures();
		this.#recompute();
		const state = committed && !this.jobsObserver.getSnapshot().failedUnacknowledged ? "acknowledged" : "failed";
		return { ...result, ok: state === "acknowledged", state };
	}

	async flush(): Promise<void> {
		if (!this.attentionStore) return;
		try {
			await this.attentionStore.flush();
		} catch {
			// Store flush is best effort during teardown; never surface raw errors.
		}
	}

	#managerFailuresCoveredBy(expected: readonly AttentionEventAcknowledgement[]): boolean {
		const captured = new Set(expected.map(attentionIdentityKey));
		const filter = this.ownerId ? { ownerId: this.ownerId } : undefined;
		return this.manager
			.getAllJobs(filter)
			.filter(job => job.type === "bash" && job.metadata?.monitor === true && job.status === "failed")
			.every(job =>
				captured.has(
					attentionIdentityKey({
						kind: "bash",
						sourceId: job.id,
						generation: job.generation || String(job.startTime),
					}),
				),
			);
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
		const rowGenerations = new Map<string, string>();
		const filter = this.ownerId ? { ownerId: this.ownerId } : undefined;
		const jobs = this.manager.getAllJobs(filter);
		const jobsSnapshot = this.jobsObserver.getSnapshot();
		const sessions = this.sessions.getSessions();
		const monitorIds = new Set(jobsSnapshot.monitors.map(monitor => monitor.id));

		for (const job of jobs) {
			// A subagent task is represented by its stable control-plane record.
			if (job.metadata?.subagent) continue;
			if (job.type !== "bash") continue;
			const row: TaskRow = {
				id: `bash:${job.id}`,
				kind: "bash",
				label: job.label,
				status: ASYNC_STATUS[job.status],
				startedAt: job.startTime,
				monitorOutputLines: monitorIds.has(job.id)
					? lineCount(this.jobsObserver.getMonitorOutput(job.id))
					: undefined,
			};
			rows.push(row);
			rowGenerations.set(row.id, job.generation || String(job.startTime));
		}

		const records = new Map(this.manager.getSubagentRecords(filter).map(record => [record.subagentId, record]));
		const currentSessionIds = new Set<string>(records.keys());
		for (const session of sessions) {
			if (session.kind === "subagent") currentSessionIds.add(session.id);
		}
		this.#cleanupSessionGenerations(currentSessionIds);

		const liveIds = new Set<string>();
		for (const session of sessions) {
			if (session.kind !== "subagent") continue;
			liveIds.add(session.id);
			const record = records.get(session.id);
			const row: TaskRow = {
				id: `subagent:${session.id}`,
				kind: "subagent",
				label: session.label,
				status: record ? SUBAGENT_STATUS[record.status] : SESSION_STATUS[session.status],
				startedAt: session.lastUpdate,
				resumable: record?.resumable,
			};
			rows.push(row);
			rowGenerations.set(row.id, this.#generationForSession(session, record));
		}
		for (const record of records.values()) {
			if (liveIds.has(record.subagentId)) continue;
			const startedAt = record.queued?.createdAt ?? 0;
			const row: TaskRow = {
				id: `subagent:${record.subagentId}`,
				kind: "subagent",
				label: record.subagentId,
				status: SUBAGENT_STATUS[record.status],
				startedAt,
				resumable: record.resumable,
			};
			rows.push(row);
			rowGenerations.set(row.id, record.currentJobGeneration ?? record.terminalGeneration ?? String(startedAt));
		}
		this.#cleanupSessionGenerations(currentSessionIds);

		for (const cron of jobsSnapshot.crons) {
			const row = cronRow(cron);
			rows.push(row);
			rowGenerations.set(row.id, String(cron.createdAt));
		}

		// Prioritize actionable severity, then recency, then an explicit identity tie-break.
		rows.sort(
			(a, b) =>
				STATUS_RANK[b.status] - STATUS_RANK[a.status] || b.startedAt - a.startedAt || a.id.localeCompare(b.id),
		);
		let terminalRows = 0;
		const historyBoundRows = rows.filter(row => {
			if (!isTerminalStatus(row.status)) return true;
			terminalRows++;
			return terminalRows <= MAX_TERMINAL_HISTORY_ROWS;
		});
		const overflowCount = Math.min(MAX_TASK_ROWS, Math.max(0, historyBoundRows.length - MAX_TASK_ROWS));
		const boundedRows = historyBoundRows.slice(0, MAX_TASK_ROWS);
		// Only current visible rows are observed. This keeps one recompute from
		// asking the durable store to retain more identities than the UI can show.
		for (const row of boundedRows) this.#observe(row, rowGenerations.get(row.id) ?? String(row.startedAt));

		const storeSnapshot = this.attentionStore?.getSnapshot();
		const storeStatus = storeSnapshot?.status;
		const storeStatusFailed = isAttentionFailureStatus(storeStatus);
		const failedUnacknowledged =
			jobsSnapshot.failedUnacknowledged ||
			(this.#storeObservationStatus !== undefined && isAttentionFailureStatus(this.#storeObservationStatus)) ||
			storeStatusFailed ||
			(storeSnapshot?.failedUnacknowledged ?? false);
		const attentionStatus =
			storeStatus === "overflow" || storeStatusFailed
				? storeStatus
				: this.#storeObservationStatus === "overflow" || isAttentionFailureStatus(this.#storeObservationStatus)
					? this.#storeObservationStatus
					: undefined;
		const storeOverflow = storeStatus === "overflow" || this.#storeObservationStatus === "overflow" ? 1 : 0;
		const totalOverflowCount = Math.min(MAX_TASK_ROWS, overflowCount + storeOverflow);
		const worstState = failedUnacknowledged
			? "failed"
			: boundedRows.reduce<TasksSnapshot["worstState"]>(
					(worst, row) => (worst === "none" || STATUS_RANK[row.status] > STATUS_RANK[worst] ? row.status : worst),
					"none",
				);
		this.#snapshot = {
			rows: boundedRows,
			worstState,
			failedUnacknowledged,
			overflowCount: totalOverflowCount,
			...(attentionStatus === undefined ? {} : { attentionStatus }),
		};
	}

	#observe(row: TaskRow, generation: string): void {
		if (!this.attentionStore) return;
		const status: AttentionEventStatus = row.status;
		const sourceId = row.id.slice(row.kind.length + 1);
		void this.attentionStore
			.observe({
				kind: row.kind,
				sourceId,
				generation,
				label: row.label,
				status,
				startedAt: row.startedAt,
			})
			.then(result => {
				if (this.#disposed) return;
				const nextStatus =
					result.status === "overflow" || isAttentionFailureStatus(result.status) ? result.status : undefined;
				if (this.#storeObservationStatus === nextStatus) return;
				this.#storeObservationStatus = nextStatus;
				this.#changed();
			})
			.catch(() => {
				if (this.#disposed || this.#storeObservationStatus === "unavailable") return;
				this.#storeObservationStatus = "unavailable";
				this.#changed();
			});
	}

	#cleanupSessionGenerations(currentSessionIds: ReadonlySet<string>): void {
		for (const id of this.#sessionGenerations.keys()) {
			if (!currentSessionIds.has(id)) this.#sessionGenerations.delete(id);
		}
		if (this.#sessionGenerations.size <= MAX_SESSION_GENERATIONS) return;
		const excess = [...this.#sessionGenerations.keys()].sort().slice(MAX_SESSION_GENERATIONS);
		for (const id of excess) this.#sessionGenerations.delete(id);
	}

	#generationForSession(session: ObservableSession, record: SubagentRecord | undefined): string {
		const canonical = record?.currentJobGeneration ?? record?.terminalGeneration;
		if (canonical !== undefined) {
			this.#sessionGenerations.delete(session.id);
			return canonical;
		}
		const existing = this.#sessionGenerations.get(session.id);
		if (existing) return existing;
		const generation = String(session.lastUpdate);
		if (this.#sessionGenerations.size >= MAX_SESSION_GENERATIONS) return generation;
		this.#sessionGenerations.set(session.id, generation);
		return generation;
	}

	async dispose(): Promise<void> {
		if (this.#disposed) return;
		this.#disposed = true;
		for (const unsubscribe of this.#unsubscribers) unsubscribe();
		this.#unsubscribers.length = 0;
		this.#listeners.clear();
		if (this.attentionStore) {
			await this.flush();
			this.attentionStore.dispose();
		}
	}
}

function isTerminalStatus(status: TaskStatus): boolean {
	return status === "done" || status === "failed" || status === "cancelled";
}

function isAttentionFailureStatus(status: AttentionStoreStatus | undefined): boolean {
	return status === "corrupt" || status === "invalid_path" || status === "unavailable" || status === "write_failed";
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
