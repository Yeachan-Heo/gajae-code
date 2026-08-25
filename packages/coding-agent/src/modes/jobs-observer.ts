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
export type JobDeliveryState = "pending" | "delivered" | "failed-visible";

/** The manager-owned, one-pass job projection consumed by this observer. */
export interface AsyncJobSnapshotEntry {
	id: string;
	kind: string;
	label: string;
	status: AsyncJob["status"];
	generation: string;
	backgrounded: boolean;
	deliveryState: JobDeliveryState;
}

/** Scalar delivery failure evidence that may outlive the AsyncJob record. */
export interface DeadLetteredJobSnapshotEntry {
	jobId: string;
	generation: string;
	ownerId?: string;
	attempt: number;
	lastError?: string;
	recordedAt: number;
}

export interface AsyncJobsSnapshot {
	jobs: AsyncJobSnapshotEntry[];
	deadLettered: DeadLetteredJobSnapshotEntry[];
}

export interface MonitorJobView {
	id: string;
	label: string;
	status: AsyncJob["status"];
	startTime: number;
	generation?: string;
	backgrounded?: boolean;
	deliveryState?: JobDeliveryState;
}

export interface FoldedJobView extends AsyncJobSnapshotEntry {
	/** Safe diagnostic retained for a dead-lettered delivery, when available. */
	errorText?: string;
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
	/** Backgrounded work and undeliverable terminal work that must stay visible. */
	foldedJobs?: FoldedJobView[];
	/** Scalar dead-letter evidence retained for diagnostics and red-drill-in. */
	deadLettered?: DeadLetteredJobSnapshotEntry[];
	activeMonitorCount: number;
	activeCronCount: number;
	worstState: JobsWorstState;
	failedUnacknowledged: boolean;
}

export const EMPTY_JOBS_SNAPSHOT: JobsSnapshot = {
	monitors: [],
	crons: [],
	foldedJobs: [],
	deadLettered: [],
	activeMonitorCount: 0,
	activeCronCount: 0,
	worstState: "none",
	failedUnacknowledged: false,
};

function jobKey(id: string, generation: string): string {
	return `${id}\u0000${generation}`;
}

interface AsyncJobSnapshotSource {
	getJobsSnapshot?: (filter?: { ownerId?: string }) => AsyncJobsSnapshot;
}

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

	#readAsyncJobsSnapshot(): AsyncJobsSnapshot {
		const source = this.#manager as AsyncJobSnapshotSource;
		if (typeof source.getJobsSnapshot !== "function") return { jobs: [], deadLettered: [] };
		return source.getJobsSnapshot(this.#ownerId ? { ownerId: this.#ownerId } : undefined);
	}

	#listMonitorJobs(): AsyncJob[] {
		if (typeof this.#manager.getAllJobs !== "function") return [];
		const filter = this.#ownerId ? { ownerId: this.#ownerId } : undefined;
		return this.#manager.getAllJobs(filter).filter(job => job.type === "bash" && job.metadata?.monitor === true);
	}

	/**
	 * Recompute and store the snapshot. Called on construction and on every
	 * upstream change; the status-line render path only reads the stored
	 * snapshot (never scans the manager/cron stores).
	 */
	#recompute(): void {
		const asyncSnapshot = this.#readAsyncJobsSnapshot();
		const snapshotEntries = new Map<string, AsyncJobSnapshotEntry>();
		for (const entry of asyncSnapshot.jobs) snapshotEntries.set(jobKey(entry.id, entry.generation), entry);

		const monitorJobs = this.#listMonitorJobs();
		const presentKeys = new Set<string>([
			...asyncSnapshot.jobs.map(entry => jobKey(entry.id, entry.generation)),
			...asyncSnapshot.deadLettered.map(entry => jobKey(entry.jobId, entry.generation)),
		]);
		// Prune acknowledged keys whose jobs and scalar dead letters have been evicted.
		for (const key of this.#acknowledgedFailedIds) {
			if (!presentKeys.has(key)) this.#acknowledgedFailedIds.delete(key);
		}

		// Sticky failure latch: the manager's terminal status and delivery
		// classification are authoritative; neither is reconstructed from getters.
		const hasUnacknowledgedFailure =
			asyncSnapshot.jobs.some(
				entry =>
					(entry.status === "failed" || entry.deliveryState === "failed-visible") &&
					!this.#acknowledgedFailedIds.has(jobKey(entry.id, entry.generation)),
			) ||
			asyncSnapshot.deadLettered.some(
				entry => !this.#acknowledgedFailedIds.has(jobKey(entry.jobId, entry.generation)),
			);
		if (hasUnacknowledgedFailure) this.#failedUnacknowledged = true;

		const monitors: MonitorJobView[] = monitorJobs
			.flatMap(job => {
				const entry = snapshotEntries.get(jobKey(job.id, job.generation));
				if (!entry) return [];
				return [
					{
						id: entry.id,
						label: entry.label,
						status: entry.status,
						startTime: job.startTime,
						generation: entry.generation,
						backgrounded: entry.backgrounded,
						deliveryState: entry.deliveryState,
					},
				];
			})
			.sort((a, b) => b.startTime - a.startTime);

		// Keep every backgrounded job visible. A non-delivered terminal entry is
		// also retained here so pending/failed delivery can never disappear merely
		// because it was not marked backgrounded by its producer.
		const foldedJobs: FoldedJobView[] = asyncSnapshot.jobs
			.filter(
				entry =>
					entry.backgrounded ||
					(entry.status !== "running" && (entry.status === "failed" || entry.deliveryState !== "delivered")),
			)
			.map(entry => ({ ...entry }));
		const foldedKeys = new Set(foldedJobs.map(entry => jobKey(entry.id, entry.generation)));
		for (const entry of asyncSnapshot.deadLettered) {
			const key = jobKey(entry.jobId, entry.generation);
			if (foldedKeys.has(key)) continue;
			foldedKeys.add(key);
			foldedJobs.push({
				id: entry.jobId,
				kind: "dead-letter",
				label: entry.jobId,
				status: "failed",
				generation: entry.generation,
				backgrounded: true,
				deliveryState: "failed-visible",
				errorText: entry.lastError,
			});
		}

		const activeMonitors = monitors.filter(monitor => monitor.status === "running");
		const cronSnapshots = listCronSnapshots(this.#ownerId);
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
		const hasRunningFoldedJob = foldedJobs.some(job => job.status === "running");
		const worstState: JobsWorstState = this.#failedUnacknowledged
			? "failed"
			: activeMonitors.length > 0 || crons.length > 0 || hasRunningFoldedJob
				? "running"
				: "none";
		this.#snapshot = {
			monitors,
			crons,
			foldedJobs,
			deadLettered: asyncSnapshot.deadLettered.map(entry => ({ ...entry })),
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
		const asyncSnapshot = this.#readAsyncJobsSnapshot();
		for (const entry of asyncSnapshot.jobs) {
			if (entry.status === "failed" || entry.deliveryState === "failed-visible") {
				this.#acknowledgedFailedIds.add(jobKey(entry.id, entry.generation));
			}
		}
		for (const entry of asyncSnapshot.deadLettered) {
			this.#acknowledgedFailedIds.add(jobKey(entry.jobId, entry.generation));
		}
		if (!this.#failedUnacknowledged) return;
		this.#failedUnacknowledged = false;
		this.#recompute();
		this.#emit();
	}

	/** Cancel a running monitor job. Returns true when the job was cancelled. */
	cancelMonitor(id: string): boolean {
		return this.#manager.cancel(id, this.#ownerId ? { ownerId: this.#ownerId } : undefined);
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
