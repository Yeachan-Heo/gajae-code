import {
	type AsyncJob,
	type AsyncJobManager,
	type AsyncJobSnapshotEntry,
	type SubagentControlCapabilities,
	SubagentControlError,
	type SubagentControlErrorCode,
	type SubagentControlSuccess,
	type SubagentControlTarget,
	type SubagentLifecycle,
} from "../async/job-manager";
import { JobsObserver, type JobsSnapshot } from "../modes/jobs-observer";
import { deleteCronJobById, listCronSnapshots } from "../tools/cron";

export interface JobObservationTarget {
	id: string;
	generation: string;
}

export interface CronObservationTarget {
	id: string;
	createdAt: number;
}

/** Opaque per-lifecycle CAS token, safe for a host's renderer-ref mapping. */
export type TaskObservationTarget = SubagentControlTarget;

export type TaskObservationCapabilities = SubagentControlCapabilities;

export interface TaskPauseResult {
	status: SubagentLifecycle;
}

export interface TaskResumeResult {
	status: SubagentLifecycle;
	jobId?: string;
	queued: boolean;
}

/** Canonical detached-task lifecycle, not a live session/control handle. */
export interface TaskObservation {
	target: TaskObservationTarget;
	capabilities: TaskObservationCapabilities;
	id: string;
	status: SubagentLifecycle;
	currentJobId: string | null;
	currentJobGeneration?: string;
	terminalGeneration?: string;
	requestedModel?: string;
	effectiveModel?: string;
}

export interface JobObservationSnapshot extends JobsSnapshot {
	/** Opaque CAS revision of this view's observed failure evidence. */
	failureRevision: string;
	jobs: AsyncJobSnapshotEntry[];
	/** Canonical records survive job eviction and include queued/paused tasks. */
	tasks: TaskObservation[];
}

export type JobObservationErrorCode =
	| SubagentControlErrorCode
	| "invalid_owner"
	| "disposed"
	| "not_found"
	| "stale_generation"
	| "read_only"
	| "already_terminal";

export class JobObservationError extends Error {
	constructor(readonly code: JobObservationErrorCode) {
		super(`Job observation: ${code}`);
		this.name = "JobObservationError";
	}
}

/**
 * Standalone trusted-host facade; not a session-installed SDK capability.
 * The host captures its registry owner here, never from a remote control request.
 */
export class JobObservation {
	readonly #manager: AsyncJobManager;
	readonly #ownerId: string;
	readonly #observer: JobsObserver;
	readonly #taskControlScope: string;
	readonly #unsubscribeFailures: () => void;
	#failureSignature = "";
	#failureRevision = crypto.randomUUID();
	#disposed = false;

	constructor(manager: AsyncJobManager, ownerId: string) {
		// The cron store reserves this key for unowned legacy schedules.
		if (typeof ownerId !== "string" || !ownerId.trim() || ownerId !== ownerId.trim() || ownerId === "__legacy__") {
			throw new JobObservationError("invalid_owner");
		}
		this.#manager = manager;
		this.#ownerId = ownerId;
		this.#taskControlScope = manager.getSubagentControlScope();
		this.#observer = new JobsObserver(manager, ownerId);
		this.#refreshFailureRevision();
		// Track synchronously, before a failed generation can be evicted or replaced.
		// Debounced observer wakeups alone would miss an intervening failure (ABA).
		this.#unsubscribeFailures = manager.onChange(() => this.#refreshFailureRevision());
	}

	#refreshFailureRevision(): void {
		const snapshot = this.#manager.getJobsSnapshot({ ownerId: this.#ownerId });
		const signature = JSON.stringify({
			jobs: snapshot.jobs
				.filter(entry => entry.status === "failed" || entry.deliveryState === "failed-visible")
				.map(entry => [
					entry.id,
					entry.generation,
					entry.status,
					entry.deliveryState === "failed-visible",
					entry.backgrounded,
				]),
			deadLettered: snapshot.deadLettered,
			tasks: this.#manager
				.getSubagentRecords({ ownerId: this.#ownerId })
				.filter(record => record.status === "failed")
				.map(record => [record.subagentId, record.currentJobGeneration, record.terminalGeneration]),
		});
		if (signature === this.#failureSignature) return;
		this.#failureSignature = signature;
		this.#failureRevision = crypto.randomUUID();
	}

	#assertActive(): void {
		if (this.#disposed) throw new JobObservationError("disposed");
	}

	/** Detached DTOs: mutations cannot change observer caches or backend records. */
	getSnapshot(): JobObservationSnapshot {
		this.#assertActive();
		const jobs = this.#manager.getJobsSnapshot({ ownerId: this.#ownerId }).jobs;
		let tasks: TaskObservation[];
		try {
			tasks = this.#manager.getSubagentControlSnapshot(this.#ownerId, this.#taskControlScope);
		} catch (error) {
			if (error instanceof SubagentControlError) throw new JobObservationError(error.code);
			throw error;
		}
		this.#refreshFailureRevision();
		return structuredClone({ ...this.#observer.getSnapshot(), jobs, tasks, failureRevision: this.#failureRevision });
	}

	/** Count only this owner's running jobs that are not monitors. */
	getRunningNonMonitorCount(): number {
		this.#assertActive();
		return this.#manager.getRunningJobs({ ownerId: this.#ownerId }).filter(job => job.metadata?.monitor !== true)
			.length;
	}

	/** Debounced invalidation without payload; foreign changes may also invalidate. */
	onChange(listener: () => void): () => void {
		this.#assertActive();
		return this.#observer.onChange(listener);
	}

	#assertMonitor(id: string, generation: string): AsyncJob {
		this.#assertActive();
		const job = this.#manager.getJob(id);
		// Ownership precedes generation checks: foreign IDs reveal no state.
		if (!job || job.ownerId !== this.#ownerId) throw new JobObservationError("not_found");
		if (job.generation !== generation) throw new JobObservationError("stale_generation");
		if (
			job.type !== "bash" ||
			job.metadata?.monitor !== true ||
			job.metadata.backgrounded ||
			this.#observer.getSnapshot().foldedJobs?.some(entry => entry.id === id && entry.generation === generation)
		) {
			throw new JobObservationError("read_only");
		}
		return job;
	}

	/** Retained terminal monitors are readable unless classified as read-only folded work. */
	getMonitorOutput(target: JobObservationTarget): string {
		this.#assertActive();
		const { id, generation } = target;
		this.#assertMonitor(id, generation);
		// No await or external callbacks between validation and the backend lookup.
		// Capture request properties once so getters cannot replace a validated target.
		const output = this.#manager.readOutputSince(id, 0, { ownerId: this.#ownerId });
		if (!output) throw new JobObservationError("not_found");
		return output.text;
	}

	/** Refuses terminal/evicted jobs explicitly; never silently succeeds or cancels a successor. */
	cancelMonitor(target: JobObservationTarget): true {
		this.#assertActive();
		const { id, generation } = target;
		const job = this.#assertMonitor(id, generation);
		if (job.status !== "running") throw new JobObservationError("already_terminal");
		// cancel captures the live record synchronously, before invoking lifecycle callbacks.
		if (!this.#manager.cancel(id, { ownerId: this.#ownerId })) throw new JobObservationError("not_found");
		return true;
	}

	#controlTask(
		target: TaskObservationTarget,
		action: "cancel" | "pause" | "resume",
		message?: string,
	): SubagentControlSuccess {
		this.#assertActive();
		// Materialize untrusted accessors before the manager's final CAS, and
		// recheck disposal because a target getter can dispose this facade.
		const { id, generation } = target;
		this.#assertActive();
		const result = this.#manager.controlOwnedSubagent(
			this.#ownerId,
			this.#taskControlScope,
			{ id, generation },
			action,
			message,
		);
		if (!result.ok) throw new JobObservationError(result.reason);
		return result;
	}

	/** Stop exactly the observed owned task, including retained paused/queued work. */
	cancelTask(target: TaskObservationTarget): true {
		this.#controlTask(target, "cancel");
		return true;
	}

	/** Requests a cooperative safe-boundary pause; does not claim the run has stopped. */
	pauseTask(target: TaskObservationTarget): TaskPauseResult {
		const result = this.#controlTask(target, "pause");
		return { status: result.status };
	}

	/** Uses only the original owner-compatible captured runner; admission failures are not success. */
	resumeTask(target: TaskObservationTarget, message?: string): TaskResumeResult {
		const result = this.#controlTask(target, "resume", message);
		return { status: result.status, jobId: result.jobId, queued: result.queued === true };
	}

	/** createdAt is the existing schedule identity token, not its changing nextFireAt. */
	deleteCron(target: CronObservationTarget): true {
		this.#assertActive();
		const { id, createdAt } = target;
		this.#assertActive();
		const cron = listCronSnapshots(this.#ownerId).find(entry => entry.id === id);
		if (!cron) throw new JobObservationError("not_found");
		if (cron.createdAt !== createdAt) throw new JobObservationError("stale_generation");
		// The real cron backend removes synchronously, notifying listeners only afterwards.
		if (!deleteCronJobById(this.#ownerId, id)) throw new JobObservationError("not_found");
		return true;
	}

	/** No revision preserves the trusted overlay's unscoped ACK semantics. */
	acknowledgeFailures(expectedRevision?: string): void {
		this.#assertActive();
		this.#refreshFailureRevision();
		if (expectedRevision !== undefined && expectedRevision !== this.#failureRevision) {
			throw new JobObservationError("stale_generation");
		}
		// No await or callbacks between the revision comparison and the observer's
		// synchronous failure capture. Delivery state is never consumed here.
		this.#observer.acknowledgeFailures();
		this.#failureRevision = crypto.randomUUID();
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#unsubscribeFailures();
		this.#observer.dispose();
	}
}
