/**
 * JobsObserver
 *
 * Single, event-driven aggregator over the two background-work sources surfaced
 * by the status-line jobs widget and the jobs overlay:
 *  - monitor jobs (bash jobs started by the `monitor` tool, tracked in `AsyncJobManager`)
 *  - cron jobs (tracked in the cron module's owner-scoped schedule store)
 *
 * It subscribes to change hooks on both sources (no polling), debounces bursts
 * to a microtask, and exposes a precomputed snapshot so the status-line render
 * loop never scans the underlying stores. A failure latch keeps the widget red
 * until `acknowledgeFailures()` is called (when the overlay opens), so a failed
 * job that evicts before the user looks is not silently lost.
 */
import type { AsyncJob, AsyncJobManager } from "../async";
import { deleteCronJobById, listCronSnapshots, onCronChange } from "../tools/cron";

export type JobsWorstState = "none" | "running" | "failed";

export interface MonitorJobView {
	id: string;
	label: string;
	status: AsyncJob["status"];
	startTime: number;
}

export interface CronJobView {
	id: string;
	humanSchedule: string;
	cronExpression: string;
	prompt: string;
	recurring: boolean;
	nextFireAt?: number;
	/** A cron firing whose spawned job is currently running. */
	firing?: boolean;
	createdAt: number;
}

export interface JobsSnapshot {
	monitors: MonitorJobView[];
	crons: CronJobView[];
	activeMonitorCount: number;
	activeCronCount: number;
	worstState: JobsWorstState;
	failedUnacknowledged: boolean;
}

export const EMPTY_JOBS_SNAPSHOT: JobsSnapshot = {
	monitors: [],
	crons: [],
	activeMonitorCount: 0,
	activeCronCount: 0,
	worstState: "none",
	failedUnacknowledged: false,
};

export class JobsObserver {
	readonly #manager: AsyncJobManager;
	readonly #ownerId: string | undefined;
	readonly #unsubscribers: Array<() => void> = [];
	readonly #listeners = new Set<() => void>();
	#failedUnacknowledged = false;
	#notifyScheduled = false;
	#disposed = false;
	#snapshot: JobsSnapshot = EMPTY_JOBS_SNAPSHOT;
	readonly #acknowledgedFailedIds = new Set<string>();

	constructor(manager: AsyncJobManager, ownerId: string | undefined) {
		this.#manager = manager;
		this.#ownerId = ownerId;
		this.#unsubscribers.push(manager.onChange(() => this.#onUpstreamChange()));
		this.#unsubscribers.push(onCronChange(() => this.#onUpstreamChange()));
		this.#recompute();
	}

	/** Subscribe to debounced change events. Returns an unsubscribe function. */
	onChange(cb: () => void): () => void {
		this.#listeners.add(cb);
		return () => {
			this.#listeners.delete(cb);
		};
	}

	#onUpstreamChange(): void {
		if (this.#disposed) return;
		this.#recompute();
		if (this.#notifyScheduled) return;
		this.#notifyScheduled = true;
		queueMicrotask(() => {
			this.#notifyScheduled = false;
			if (this.#disposed) return;
			this.#emit();
		});
	}

	#emit(): void {
		for (const cb of this.#listeners) {
			try {
				cb();
			} catch {
				// Listener errors are isolated; a bad subscriber must not break others.
			}
		}
	}

	#listMonitorJobs(): AsyncJob[] {
		const filter = this.#ownerId ? { ownerId: this.#ownerId } : undefined;
		return this.#manager.getAllJobs(filter).filter(job => job.type === "bash" && job.metadata?.monitor === true);
	}

	/**
	 * Recompute and store the snapshot. Called on construction and on every
	 * upstream change; the status-line render path only reads the stored
	 * snapshot (never scans the manager/cron stores).
	 */
	#recompute(): void {
		const monitorJobs = this.#listMonitorJobs();
		const presentIds = new Set(monitorJobs.map(job => job.id));
		// Prune acknowledged ids whose jobs have been evicted.
		for (const id of this.#acknowledgedFailedIds) {
			if (!presentIds.has(id)) this.#acknowledgedFailedIds.delete(id);
		}
		// Sticky failure latch: set when an unacknowledged failed monitor is seen
		// (including at construction); stays set even after the failed job evicts,
		// until acknowledgeFailures() clears it.
		const hasUnacknowledgedFailure = monitorJobs.some(
			job => job.status === "failed" && !this.#acknowledgedFailedIds.has(job.id),
		);
		if (hasUnacknowledgedFailure) this.#failedUnacknowledged = true;

		const activeMonitors = monitorJobs.filter(job => job.status === "running");
		const cronSnapshots = listCronSnapshots(this.#ownerId);
		const monitors: MonitorJobView[] = monitorJobs
			.map(job => ({ id: job.id, label: job.label, status: job.status, startTime: job.startTime }))
			.sort((a, b) => b.startTime - a.startTime);
		const crons: CronJobView[] = cronSnapshots
			.map(snapshot => ({
				id: snapshot.id,
				humanSchedule: snapshot.humanSchedule,
				cronExpression: snapshot.cron_expression,
				prompt: snapshot.prompt,
				recurring: snapshot.recurring,
				nextFireAt: snapshot.nextFireAt,
				createdAt: snapshot.createdAt,
				firing: snapshot.firing,
			}))
			.sort((a, b) => b.createdAt - a.createdAt);
		const worstState: JobsWorstState = this.#failedUnacknowledged
			? "failed"
			: activeMonitors.length > 0 || crons.length > 0
				? "running"
				: "none";
		this.#snapshot = {
			monitors,
			crons,
			activeMonitorCount: activeMonitors.length,
			activeCronCount: crons.length,
			worstState,
			failedUnacknowledged: this.#failedUnacknowledged,
		};
	}

	/** Return the precomputed snapshot (recomputed on each upstream change). */
	getSnapshot(): JobsSnapshot {
		return this.#snapshot;
	}

	/** Clear the failure latch (called when the user opens the jobs overlay). */
	acknowledgeFailures(): void {
		for (const job of this.#listMonitorJobs()) {
			if (job.status === "failed") this.#acknowledgedFailedIds.add(job.id);
		}
		if (!this.#failedUnacknowledged) return;
		this.#failedUnacknowledged = false;
		this.#recompute();
		this.#emit();
	}

	/** Cancel a running monitor job. Returns true when the job was cancelled. */
	cancelMonitor(id: string): boolean {
		return this.#manager.cancel(id);
	}

	/** Delete a visible scheduled cron job. Returns true when removed. */
	deleteCron(id: string): boolean {
		return deleteCronJobById(this.#ownerId, id);
	}

	/** Bounded tail of a monitor job's captured output (for the detail view). */
	getMonitorOutput(id: string): string {
		const slice = this.#manager.readOutputSince(id, 0, this.#ownerId ? { ownerId: this.#ownerId } : undefined);
		return slice?.text ?? "";
	}

	dispose(): void {
		this.#disposed = true;
		for (const unsubscribe of this.#unsubscribers) {
			try {
				unsubscribe();
			} catch {
				// best-effort teardown
			}
		}
		this.#unsubscribers.length = 0;
		this.#listeners.clear();
	}
}
