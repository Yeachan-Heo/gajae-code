import type {
	CapacityState,
	MasterQueueDocument,
	QueueStateSummary,
	TaskPriority,
	TaskRecord,
	TaskState,
	WorkerLease,
} from "./types";
import { DEFAULT_MAX_CONCURRENT_WORKERS } from "./types";

export const USER_FAIRNESS_LIMIT = 3;
export const DEFAULT_QUEUE_MAX_CONCURRENT_WORKERS = DEFAULT_MAX_CONCURRENT_WORKERS;

export function isSafeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value);
}

export function isPositiveSafeInteger(value: unknown): value is number {
	return isSafeInteger(value) && value >= 1;
}

export function assertPositiveSafeInteger(value: unknown, field = "value"): asserts value is number {
	if (!isPositiveSafeInteger(value)) throw new Error(`${field} must be a positive safe integer.`);
}

export function assertCapacityInvariant(
	activeWorkerCount: unknown,
	maxConcurrentWorkers: unknown,
	capacityState: unknown,
): void {
	if (!isSafeInteger(activeWorkerCount) || activeWorkerCount < 0)
		throw new Error("activeWorkerCount must be a non-negative safe integer.");
	assertPositiveSafeInteger(maxConcurrentWorkers, "maxConcurrentWorkers");
	if (capacityState !== "within_limit" && capacityState !== "draining_over_capacity")
		throw new Error("capacityState is invalid.");
	if (capacityState === "within_limit" && activeWorkerCount > maxConcurrentWorkers)
		throw new Error("within_limit cannot exceed maxConcurrentWorkers.");
	if (capacityState === "draining_over_capacity" && activeWorkerCount <= maxConcurrentWorkers)
		throw new Error("draining_over_capacity requires activeWorkerCount above maxConcurrentWorkers.");
}

export function validateQueueSummary(value: unknown): asserts value is QueueStateSummary {
	if (typeof value !== "object" || value === null) throw new Error("queue summary must be an object.");
	const summary = value as Partial<QueueStateSummary>;
	if (!isSafeInteger(summary.queueRevision) || summary.queueRevision < 0) throw new Error("queueRevision is invalid.");
	if (!isSafeInteger(summary.pendingCount) || summary.pendingCount < 0) throw new Error("pendingCount is invalid.");
	if (!isSafeInteger(summary.userDispatchStreak) || summary.userDispatchStreak < 0)
		throw new Error("userDispatchStreak is invalid.");
	assertCapacityInvariant(summary.activeWorkerCount, summary.maxConcurrentWorkers, summary.capacityState);
}

export function isValidQueueSummary(value: unknown): value is QueueStateSummary {
	try {
		validateQueueSummary(value);
		return true;
	} catch {
		return false;
	}
}

export const assertQueueSummary = validateQueueSummary;
export const assertQueueState = validateQueueState;
export const isValidCapacityState = (
	activeWorkerCount: number,
	maxConcurrentWorkers: number,
	capacityState: CapacityState,
): boolean => {
	try {
		assertCapacityInvariant(activeWorkerCount, maxConcurrentWorkers, capacityState);
		return true;
	} catch {
		return false;
	}
};

export function validateCapacityState(
	activeWorkerCount: unknown,
	maxConcurrentWorkers: unknown,
	capacityState: unknown,
): asserts capacityState is CapacityState {
	assertCapacityInvariant(activeWorkerCount, maxConcurrentWorkers, capacityState);
}

export function validateQueueState(value: unknown): asserts value is MasterQueueDocument {
	if (typeof value !== "object" || value === null) throw new Error("queue state must be an object.");
	const queue = value as Partial<MasterQueueDocument>;
	if (queue.version !== 1 || queue.schema_version !== 1 || queue.kind !== "master_queue")
		throw new Error("unsupported queue state version.");
	if (typeof queue.masterName !== "string" || queue.masterName.length === 0)
		throw new Error("queue masterName is invalid.");
	if (!isSafeInteger(queue.queueRevision) || queue.queueRevision < 0) throw new Error("queueRevision is invalid.");
	if (!isPositiveSafeInteger(queue.nextEnqueueSeq)) throw new Error("nextEnqueueSeq is invalid.");
	if (!isSafeInteger(queue.userDispatchStreak) || queue.userDispatchStreak < 0)
		throw new Error("userDispatchStreak is invalid.");
	assertCapacityInvariant(queue.activeWorkerCount, queue.maxConcurrentWorkers, queue.capacityState);
	if (!Array.isArray(queue.tasks)) throw new Error("queue tasks are invalid.");
	if (
		typeof queue.idempotencyReceipts !== "object" ||
		queue.idempotencyReceipts === null ||
		Array.isArray(queue.idempotencyReceipts)
	)
		throw new Error("queue idempotency receipts are invalid.");
	if (
		typeof queue.releaseReceipts !== "object" ||
		queue.releaseReceipts === null ||
		Array.isArray(queue.releaseReceipts)
	)
		throw new Error("queue release receipts are invalid.");
	for (const task of queue.tasks) validateTaskRecord(task);
}

export function isValidQueueState(value: unknown): value is MasterQueueDocument {
	try {
		validateQueueState(value);
		return true;
	} catch {
		return false;
	}
}

export function validateTaskRecord(value: unknown): asserts value is TaskRecord {
	if (typeof value !== "object" || value === null) throw new Error("task must be an object.");
	const task = value as Partial<TaskRecord>;
	if (typeof task.taskId !== "string" || task.taskId.length === 0) throw new Error("taskId is invalid.");
	if (!isPositiveSafeInteger(task.enqueueSeq)) throw new Error("enqueueSeq is invalid.");
	if (task.priority !== "urgent_user" && task.priority !== "user" && task.priority !== "autonomous")
		throw new Error("task priority is invalid.");
	if (task.source !== "user" && task.source !== "master") throw new Error("task source is invalid.");
	if (task.source === "master" && task.priority !== "autonomous")
		throw new Error("master tasks must use autonomous priority.");
	if (task.source === "user" && task.priority === "autonomous")
		throw new Error("user tasks cannot use autonomous priority.");
	if (
		task.state !== "queued" &&
		task.state !== "leased" &&
		task.state !== "assigned" &&
		task.state !== "completed" &&
		task.state !== "failed" &&
		task.state !== "retry_pending" &&
		task.state !== "blocked"
	)
		throw new Error("task state is invalid.");
	if (!isPositiveSafeInteger(task.attempt)) throw new Error("task attempt is invalid.");
	if (typeof task.summary !== "string" || task.summary.length === 0) throw new Error("task summary is invalid.");
	if (typeof task.createdAt !== "string" || typeof task.updatedAt !== "string")
		throw new Error("task timestamps are invalid.");
	if (task.workerSessionId !== null && typeof task.workerSessionId !== "string")
		throw new Error("workerSessionId is invalid.");
	if (typeof task.idempotencyKey !== "string" || task.idempotencyKey.length === 0)
		throw new Error("idempotencyKey is invalid.");
	if (typeof task.bodyDigest !== "string" || task.bodyDigest.length !== 64) throw new Error("bodyDigest is invalid.");
	if (task.leaseId !== null && typeof task.leaseId !== "string") throw new Error("leaseId is invalid.");
	if (task.workdir !== null && typeof task.workdir !== "string") throw new Error("workdir is invalid.");
}

export function countActiveWorkerLeases(workers: readonly WorkerLease[]): number {
	return workers.reduce((count, worker) => count + (worker.state === "terminal" ? 0 : 1), 0);
}

export const countActiveLeases = countActiveWorkerLeases;

export function assertExactActiveWorkerCount(activeWorkerCount: number, workers: readonly WorkerLease[]): void {
	const computed = countActiveWorkerLeases(workers);
	if (activeWorkerCount !== computed)
		throw new Error(`activeWorkerCount ${activeWorkerCount} does not match ${computed} active leases.`);
}

export function canAdmitWorker(summary: QueueStateSummary): boolean {
	validateQueueSummary(summary);
	return summary.capacityState === "within_limit" && summary.activeWorkerCount < summary.maxConcurrentWorkers;
}

export function hasCapacity(summary: QueueStateSummary): boolean {
	return canAdmitWorker(summary);
}

function oldest(tasks: readonly TaskRecord[], priority: TaskPriority): TaskRecord | null {
	let selected: TaskRecord | null = null;
	for (const task of tasks) {
		if ((task.state !== "queued" && task.state !== "retry_pending") || task.priority !== priority) continue;
		if (selected === null || task.enqueueSeq < selected.enqueueSeq) selected = task;
	}
	return selected;
}

export function pendingTasks(tasks: readonly TaskRecord[]): TaskRecord[] {
	return tasks
		.filter(task => task.state === "queued" || task.state === "retry_pending")
		.sort((left, right) => left.enqueueSeq - right.enqueueSeq);
}

export function selectNextTask(tasks: readonly TaskRecord[], userDispatchStreak: number): TaskRecord | null {
	if (!isSafeInteger(userDispatchStreak) || userDispatchStreak < 0) throw new Error("userDispatchStreak is invalid.");
	const urgent = oldest(tasks, "urgent_user");
	if (urgent !== null) return urgent;
	const user = oldest(tasks, "user");
	const autonomous = oldest(tasks, "autonomous");
	if (user === null) return autonomous;
	if (autonomous === null) return user;
	return userDispatchStreak >= USER_FAIRNESS_LIMIT ? autonomous : user;
}

/**
 * Selects exactly the requested admissible task. An explicit `master_worker_create`
 * task selection must never fall back to the queue's own ordering, or the request's
 * prompt/workdir/worker would bind to a different task.
 */
export function selectRequestedTask(tasks: readonly TaskRecord[], taskId: string): TaskRecord | null {
	for (const task of tasks) {
		if (task.taskId !== taskId) continue;
		return task.state === "queued" || task.state === "retry_pending" ? task : null;
	}
	return null;
}

export const chooseNextTask = selectNextTask;
export const nextDispatchTask = selectNextTask;

export function nextUserDispatchStreak(current: number, selected: TaskRecord | null): number {
	if (!isSafeInteger(current) || current < 0) throw new Error("userDispatchStreak is invalid.");
	if (selected === null || selected.priority === "urgent_user" || selected.priority === "autonomous")
		return selected?.priority === "autonomous" ? 0 : current;
	return current + 1;
}

export function computeCapacityState(activeWorkerCount: number, maxConcurrentWorkers: number): CapacityState {
	assertPositiveSafeInteger(maxConcurrentWorkers, "maxConcurrentWorkers");
	if (!isSafeInteger(activeWorkerCount) || activeWorkerCount < 0) throw new Error("activeWorkerCount is invalid.");
	return activeWorkerCount > maxConcurrentWorkers ? "draining_over_capacity" : "within_limit";
}

export function queueSummaryFromDocument(queue: MasterQueueDocument): QueueStateSummary {
	validateQueueState(queue);
	return {
		queueRevision: queue.queueRevision,
		pendingCount: queue.tasks.filter(task => task.state === "queued" || task.state === "retry_pending").length,
		activeWorkerCount: queue.activeWorkerCount,
		maxConcurrentWorkers: queue.maxConcurrentWorkers,
		capacityState: queue.capacityState,
		userDispatchStreak: queue.userDispatchStreak,
	};
}

export function taskStateIsTerminal(state: TaskState): boolean {
	return state === "completed" || state === "failed" || state === "blocked";
}
