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
import { deleteCronJobAndCaptureDelivery, deleteCronJobById, listCronSnapshots } from "../tools/cron";

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

export interface WorkSettlementResult {
	/** Cancellation/deletion acceptance is separate from physical settlement. */
	accepted: boolean;
	status: "settled" | "pending" | "unknown";
	runner: "settled" | "pending" | "unknown";
	delivery: "settled" | "pending" | "unknown";
}

interface ObservedExecution {
	promise: Promise<void>;
	settled: boolean;
}

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
	/** Retained actual executions, including eagerly cancelled/evicted rows. */
	unsettledJobs: JobObservationTarget[];
	/** Deleted schedules with an actually pending captured delivery. */
	unsettledCrons: CronObservationTarget[];
}

export type JobObservationErrorCode =
	| SubagentControlErrorCode
	| "invalid_owner"
	| "disposed"
	| "not_found"
	| "stale_generation"
	| "read_only"
	| "session_transitioning"
	| "already_terminal";

export class JobObservationError extends Error {
	constructor(readonly code: JobObservationErrorCode) {
		super(`Job observation: ${code}`);
		this.name = "JobObservationError";
	}
}

/**
 * Owner-scoped trusted-host facade. Factory views additionally fence mutations
 * to their captured native session lifecycle; standalone views retain host authority.
 * The host captures its registry owner here, never from a remote control request.
 */
export class JobObservation {
	readonly #manager: AsyncJobManager;
	readonly #ownerId: string;
	readonly #observer: JobsObserver;
	readonly #taskControlScope: string;
	readonly #unsubscribeFailures: () => void;
	readonly #assertMutationAllowed?: () => void;
	#failureSignature = "";
	#failureRevision = crypto.randomUUID();
	#disposed = false;
	readonly #executions = new Map<string, { target: JobObservationTarget; execution: ObservedExecution }>();
	readonly #unsettledCrons = new Map<string, CronObservationTarget>();
	readonly #unprovenExecutions = new Map<string, JobObservationTarget>();
	readonly #deliveryExecutions = new Map<string, { target: JobObservationTarget; execution: ObservedExecution }>();
	readonly #observedPendingDeliveries = new Map<string, JobObservationTarget>();

	constructor(manager: AsyncJobManager, ownerId: string, assertMutationAllowed?: () => void) {
		// The cron store reserves this key for unowned legacy schedules.
		if (typeof ownerId !== "string" || !ownerId.trim() || ownerId !== ownerId.trim() || ownerId === "__legacy__") {
			throw new JobObservationError("invalid_owner");
		}
		this.#manager = manager;
		this.#ownerId = ownerId;
		this.#assertMutationAllowed = assertMutationAllowed;
		this.#taskControlScope = manager.getSubagentControlScope();
		this.#observer = new JobsObserver(manager, ownerId);
		this.#refreshFailureRevision();
		// Track synchronously, before a failed generation can be evicted or replaced.
		// Debounced observer wakeups alone would miss an intervening failure (ABA).
		this.#unsubscribeFailures = manager.onChange(() => {
			this.#refreshFailureRevision();
			for (const job of manager.getJobsSnapshot({ ownerId: this.#ownerId }).jobs) this.#captureDelivery(job);
		});
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

	#assertMutable(): void {
		this.#assertActive();
		this.#assertMutationAllowed?.();
		this.#assertActive();
	}

	/** Detached DTOs: mutations cannot change observer caches or backend records. */
	getSnapshot(): JobObservationSnapshot {
		this.#assertActive();
		const jobs = this.#manager.getJobsSnapshot({ ownerId: this.#ownerId }).jobs;
		for (const job of jobs) {
			this.#captureExecution(job);
			this.#captureDelivery(job);
		}
		for (const [generation, entry] of this.#executions) {
			if (entry.execution.settled && !jobs.some(job => job.id === entry.target.id && job.generation === generation))
				this.#executions.delete(generation);
		}
		for (const [generation, entry] of this.#deliveryExecutions) {
			if (
				entry.execution.settled &&
				!jobs.some(job => job.generation === generation && job.deliveryState === "pending")
			) {
				this.#observedPendingDeliveries.delete(generation);
				if (!jobs.some(job => job.generation === generation)) this.#deliveryExecutions.delete(generation);
			}
		}
		let tasks: TaskObservation[];
		try {
			tasks = this.#manager.getSubagentControlSnapshot(this.#ownerId, this.#taskControlScope);
		} catch (error) {
			if (error instanceof SubagentControlError) throw new JobObservationError(error.code);
			throw error;
		}
		this.#refreshFailureRevision();
		return structuredClone({
			...this.#observer.getSnapshot(),
			jobs,
			tasks,
			failureRevision: this.#failureRevision,
			unsettledJobs: [
				...new Map([
					...[...this.#executions.values()]
						.filter(entry => !entry.execution.settled)
						.map(entry => [entry.target.generation, entry.target] as const),
					...this.#unprovenExecutions,
					...this.#observedPendingDeliveries,
				]).values(),
			],
			unsettledCrons: [...this.#unsettledCrons.values()],
		});
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
		this.#assertMutable();
		const { id, generation } = target;
		const job = this.#assertMonitor(id, generation);
		if (job.status !== "running") throw new JobObservationError("already_terminal");
		// Check after materializing target accessors and immediately before admission.
		this.#assertMutable();
		// cancel captures the live record synchronously, before invoking lifecycle callbacks.
		if (!this.#manager.cancel(id, { ownerId: this.#ownerId })) throw new JobObservationError("not_found");
		return true;
	}

	#assertControlScope(): void {
		this.#assertActive();
		if (this.#manager.getSubagentControlScope() !== this.#taskControlScope)
			throw new JobObservationError("stale_generation");
	}

	#captureExecution(target: JobObservationTarget): ObservedExecution | undefined {
		const retained = this.#executions.get(target.generation);
		if (retained?.target.id === target.id) return retained.execution;
		const job = this.#manager.getJob(target.id);
		if (!job || job.ownerId !== this.#ownerId || job.generation !== target.generation) return undefined;
		const promise = this.#manager.getJobPromise(target.id, target.generation);
		if (!promise) return undefined;
		const execution: ObservedExecution = { promise, settled: false };
		this.#executions.set(target.generation, { target: { ...target }, execution });
		void promise.then(
			() => {
				execution.settled = true;
			},
			() => {
				execution.settled = true;
			},
		);
		return execution;
	}

	#captureDelivery(job: AsyncJobSnapshotEntry): void {
		const target = { id: job.id, generation: job.generation };
		if (job.deliveryState === "pending" && job.status !== "running" && job.status !== "paused")
			this.#observedPendingDeliveries.set(job.generation, target);
		const promise = this.#manager.getJobDeliveryPromise(job.id, job.generation, { ownerId: this.#ownerId });
		if (!promise || this.#deliveryExecutions.get(job.generation)?.execution.promise === promise) return;
		const execution: ObservedExecution = { promise, settled: false };
		this.#deliveryExecutions.set(job.generation, { target, execution });
		void promise.then(
			() => {
				execution.settled = true;
			},
			() => {
				execution.settled = true;
			},
		);
	}

	async #joinExecution(
		target: JobObservationTarget | undefined,
		execution: ObservedExecution | undefined,
		timeoutMs: number,
		accepted: boolean,
		noRunner = false,
	): Promise<WorkSettlementResult> {
		if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new RangeError("Invalid settlement timeout");
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const runner = execution ? (execution.settled ? "settled" : "pending") : noRunner ? "settled" : "unknown";
			const row =
				target &&
				this.#manager
					.getJobsSnapshot({ ownerId: this.#ownerId })
					.jobs.find(job => job.id === target.id && job.generation === target.generation);
			if (row) this.#captureDelivery(row);
			const deliveryExecution = target && this.#deliveryExecutions.get(target.generation)?.execution;
			const observedPending = target && this.#observedPendingDeliveries.has(target.generation);
			const delivery =
				row?.deliveryState === "pending" || (deliveryExecution && !deliveryExecution.settled)
					? "pending"
					: observedPending && !deliveryExecution
						? "unknown"
						: "settled";
			const status =
				runner === "unknown" || delivery === "unknown"
					? "unknown"
					: runner === "pending" || delivery === "pending"
						? "pending"
						: "settled";
			if (status !== "pending" || Date.now() >= deadline) {
				if (status === "unknown" && target) this.#unprovenExecutions.set(target.generation, target);
				return { accepted, status, runner, delivery };
			}
			// Poll exact projected delivery state as well as the retained physical promise.
			// A terminal/cancel event alone is deliberately not a join signal.
			await Bun.sleep(Math.min(10, Math.max(0, deadline - Date.now())));
		}
	}

	/** Exact owned generic/folded job cancellation, followed by a bounded physical join. */
	async cancelJobAndWait(target: JobObservationTarget, timeoutMs = 1_000): Promise<WorkSettlementResult> {
		const { id, generation } = target;
		if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new RangeError("Invalid settlement timeout");
		this.#assertControlScope();
		const job = this.#manager.getJob(id);
		const projected = this.#manager
			.getJobsSnapshot({ ownerId: this.#ownerId })
			.jobs.find(entry => entry.id === id && entry.generation === generation);
		if (job && job.ownerId !== this.#ownerId) throw new JobObservationError("not_found");
		if (job && job.generation !== generation) throw new JobObservationError("stale_generation");
		if (!job && !projected && this.#executions.get(generation)?.target.id !== id)
			throw new JobObservationError("not_found");
		const exact = { id, generation };
		const execution = this.#captureExecution(exact);
		this.#assertControlScope();
		// No await or untrusted getters between this final identity CAS and cancel.
		if (job && this.#manager.getJob(id) !== job) throw new JobObservationError("stale_generation");
		const accepted =
			job?.status === "running" || job?.status === "paused"
				? this.#manager.cancel(id, { ownerId: this.#ownerId })
				: false;
		return this.#joinExecution(exact, execution, timeoutMs, accepted);
	}

	/** Canonical control handles running, paused and queued tasks without resuming them. */
	async cancelTaskAndWait(target: TaskObservationTarget, timeoutMs = 1_000): Promise<WorkSettlementResult> {
		const { id, generation } = target;
		if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new RangeError("Invalid settlement timeout");
		this.#assertControlScope();
		const task = this.#manager
			.getSubagentControlSnapshot(this.#ownerId, this.#taskControlScope)
			.find(entry => entry.id === id);
		if (!task) throw new JobObservationError("not_found");
		if (task.target.generation !== generation) throw new JobObservationError("stale_generation");
		const exact =
			task.currentJobId && task.currentJobGeneration
				? { id: task.currentJobId, generation: task.currentJobGeneration }
				: undefined;
		const execution = exact && this.#captureExecution(exact);
		this.#controlTask({ id, generation }, "cancel");
		return this.#joinExecution(exact, execution, timeoutMs, true, task.status !== "running" && exact === undefined);
	}

	/** Delete only this schedule and join its captured delivery, not the turn it may enqueue. */
	async deleteCronAndWait(target: CronObservationTarget, timeoutMs = 1_000): Promise<WorkSettlementResult> {
		const { id, createdAt } = target;
		if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new RangeError("Invalid settlement timeout");
		this.#assertControlScope();
		const result = deleteCronJobAndCaptureDelivery(this.#ownerId, { id, createdAt });
		if (result.kind !== "deleted") throw new JobObservationError(result.kind);
		const key = `${id}:${createdAt}`;
		if (!result.isSettled()) {
			this.#unsettledCrons.set(key, { id, createdAt });
			void result.completion.then(() => {
				this.#unsettledCrons.delete(key);
			});
			await Promise.race([result.completion, Bun.sleep(timeoutMs)]);
		}
		const delivery = result.isSettled() ? "settled" : "pending";
		return { accepted: true, status: delivery, runner: "settled", delivery };
	}

	#controlTask(
		target: TaskObservationTarget,
		action: "cancel" | "pause" | "resume",
		message?: string,
	): SubagentControlSuccess {
		this.#assertMutable();
		// Materialize untrusted accessors before the manager's final CAS, then
		// recheck native session admission as well as facade disposal.
		const { id, generation } = target;
		this.#assertMutable();
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
		this.#assertMutable();
		const { id, createdAt } = target;
		this.#assertActive();
		const cron = listCronSnapshots(this.#ownerId).find(entry => entry.id === id);
		if (!cron) throw new JobObservationError("not_found");
		if (cron.createdAt !== createdAt) throw new JobObservationError("stale_generation");
		this.#assertMutable();
		// The real cron backend removes synchronously, notifying listeners only afterwards.
		if (!deleteCronJobById(this.#ownerId, id)) throw new JobObservationError("not_found");
		return true;
	}

	/** No revision preserves the trusted overlay's unscoped ACK semantics. */
	acknowledgeFailures(expectedRevision?: string): void {
		this.#assertMutable();
		this.#refreshFailureRevision();
		if (expectedRevision !== undefined && expectedRevision !== this.#failureRevision) {
			throw new JobObservationError("stale_generation");
		}
		this.#assertMutable();
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
