/** Readiness budget the broker grants a lifecycle request that does not size one itself. */
export const DEFAULT_READINESS_TIMEOUT_MS = 10_000;
export const MIN_READINESS_TIMEOUT_MS = 4_000;
export const MAX_READINESS_TIMEOUT_MS = 60_000;

/** Bounded git worktree add/reuse window; independent of child semantic readiness. */
export const DEFAULT_WORKTREE_PREPARATION_TIMEOUT_MS = 30_000;
export const MIN_PREPARATION_TIMEOUT_MS = 1_000;
export const MAX_PREPARATION_TIMEOUT_MS = 120_000;

/** Bounded workspace install window; independent of child semantic readiness. */
export const DEFAULT_DEPENDENCY_PREPARATION_TIMEOUT_MS = 30_000;

/** Non-worktree broker pre-spawn cap, also limited by the admission window remaining since receipt. */
export const DEFAULT_BROKER_PRESPAWN_PREPARATION_TIMEOUT_MS = 30_000;

export function isValidReadinessTimeoutMs(value: unknown): value is number {
	return (
		typeof value === "number" &&
		Number.isSafeInteger(value) &&
		value >= MIN_READINESS_TIMEOUT_MS &&
		value <= MAX_READINESS_TIMEOUT_MS
	);
}

export function isValidPreparationTimeoutMs(value: unknown): value is number {
	return (
		typeof value === "number" &&
		Number.isSafeInteger(value) &&
		value >= MIN_PREPARATION_TIMEOUT_MS &&
		value <= MAX_PREPARATION_TIMEOUT_MS
	);
}

export const READINESS_TIMEOUT_INVALID_MESSAGE = `readinessTimeoutMs must be an integer between ${MIN_READINESS_TIMEOUT_MS} and ${MAX_READINESS_TIMEOUT_MS}.`;
export const PREPARATION_TIMEOUT_INVALID_MESSAGE = `worktreePreparationTimeoutMs and dependencyPreparationTimeoutMs must be integers between ${MIN_PREPARATION_TIMEOUT_MS} and ${MAX_PREPARATION_TIMEOUT_MS}.`;
/**
 * Sleep until the duration elapses or the caller cancels the wait. Queue admission
 * uses this so a granted or refused waiter does not retain its cutoff timer for the
 * rest of the readiness budget.
 */
export function cancellableSleep(ms: number, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted || ms <= 0) return Promise.resolve();
	const settled = Promise.withResolvers<void>();
	const cancel = (): void => {
		clearTimeout(timer);
		signal?.removeEventListener("abort", cancel);
		settled.resolve();
	};
	const timer = setTimeout(cancel, ms);
	signal?.addEventListener("abort", cancel, { once: true });
	return settled.promise;
}

/**
 * Slack a caller adds over the broker-side budget so that a startup which runs to the
 * very edge of its window is reported as the broker's own terminal result rather than
 * as the caller's timeout.
 */
const CALLER_DEADLINE_SLACK_MS = 1_000;

/**
 * Whether a broker operation waits in the host-startup admission queue before it runs.
 * Only these spawn a host, so only these can be parked behind a full queue; the other
 * lifecycle operations start their readiness clock as soon as they are received.
 */
export function isStartupLifecycleOperation(operation: string): boolean {
	return operation === "session.create" || operation === "session.fork" || operation === "session.resume";
}

/**
 * Bounded time a lifecycle startup may wait for a host-startup admission slot. It
 * is the readiness budget itself: a startup still queued after that long has spent
 * the whole window the request was sized for, so refusing it beats launching a host
 * that is already late.
 */
export function startupQueueWaitMs(requestedReadinessTimeoutMs: number): number {
	return requestedReadinessTimeoutMs;
}

/**
 * Broker-side wall clock a lifecycle startup may consume: the admission wait plus
 * the readiness budget, which is granted fresh at admission and so is never shortened
 * by queueing. Callers MUST size their own request deadline against this rather than
 * `readinessTimeoutMs` alone, or a request admitted late fails client-side while the
 * broker keeps running it to a durably persisted terminal result.
 */
export function lifecycleStartupBudgetMs(requestedReadinessTimeoutMs: number): number {
	return startupQueueWaitMs(requestedReadinessTimeoutMs) + requestedReadinessTimeoutMs;
}

/**
 * Request deadline a caller MUST grant a broker operation, or `undefined` when the
 * operation carries no readiness budget of its own and the client default already
 * covers it.
 *
 * A request that omits `readinessTimeoutMs` is sized against the broker's default
 * rather than left unextended: the broker queues it for exactly as long as one that
 * asked, so the common path would otherwise fail client-side while the broker runs
 * the startup to a durably persisted terminal result.
 *
 * Worktree launches add independent preparation budgets so git add / install cannot
 * cut the caller while the broker still owns the request. One-arg
 * {@link lifecycleStartupBudgetMs} stays queue+readiness for no-worktree callers:
 * broker-derived pre-spawn work uses only the unspent admission window from receipt,
 * and the fresh readiness window ends within that unchanged caller budget.
 */
export function lifecycleRequestTimeoutMs(operation: string, input: Record<string, unknown>): number | undefined {
	const deadlineFields = [
		input.receivedAt,
		input.requestedReadinessTimeoutMs,
		input.semanticReadyDeadlineAt,
		input.terminationStartDeadlineAt,
		input.lifecycleCleanupDeadlineAt,
	];
	const hasDeadlineTuple = deadlineFields.some(value => value !== undefined);
	let supplied: number | undefined;
	if (hasDeadlineTuple) {
		if (!deadlineFields.every(value => typeof value === "number" && Number.isSafeInteger(value))) return undefined;
		if (!isValidReadinessTimeoutMs(input.requestedReadinessTimeoutMs)) return undefined;
		supplied = input.requestedReadinessTimeoutMs;
	} else {
		const requested = input.readinessTimeoutMs;
		if (requested !== undefined && !isValidReadinessTimeoutMs(requested)) return undefined;
		supplied = requested as number | undefined;
	}
	if (isStartupLifecycleOperation(operation)) {
		const readiness = supplied ?? DEFAULT_READINESS_TIMEOUT_MS;
		const preparation = preparationBudgetMs(input);
		if (preparation === undefined) return undefined;
		return lifecycleStartupBudgetMs(readiness) + preparation + CALLER_DEADLINE_SLACK_MS;
	}
	return supplied === undefined ? undefined : supplied + CALLER_DEADLINE_SLACK_MS;
}

function recordEnabled(value: unknown): boolean {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		(value as Record<string, unknown>).enabled === true
	);
}

function worktreeNamePresent(value: unknown): boolean {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const name = (value as Record<string, unknown>).name;
	return typeof name === "string" && name.length > 0;
}

/**
 * True when this request will run named or detached worktree preparation.
 * Coordinator nests the selector at `target.worktree`; Direct/lifecycle service
 * put `worktree` on the mutation target itself; broker serialization also
 * accepts `{ worktree: { name } }` without `enabled`.
 */
export function lifecycleRequestHasWorktree(input: Record<string, unknown>): boolean {
	const nested = input.target;
	if (typeof nested === "object" && nested !== null && !Array.isArray(nested)) {
		const nestedWorktree = (nested as Record<string, unknown>).worktree;
		if (recordEnabled(nestedWorktree) || worktreeNamePresent(nestedWorktree)) return true;
	}
	const worktree = input.worktree;
	if (worktree === true) return true;
	return recordEnabled(worktree) || worktreeNamePresent(worktree);
}

function readPreparationTimeout(
	input: Record<string, unknown>,
	key: "worktreePreparationTimeoutMs" | "dependencyPreparationTimeoutMs",
): number | undefined | "invalid" {
	const value = input[key];
	if (value === undefined) return undefined;
	return isValidPreparationTimeoutMs(value) ? value : "invalid";
}

/**
 * Sum of worktree and dependency preparation budgets, or 0 when the request
 * has no worktree. Returns `undefined` when an explicit prep field is present
 * but invalid so callers fail closed instead of silently dropping prep time.
 */
export function preparationBudgetMs(input: Record<string, unknown>): number | undefined {
	const worktreeTimeout = readPreparationTimeout(input, "worktreePreparationTimeoutMs");
	const dependencyTimeout = readPreparationTimeout(input, "dependencyPreparationTimeoutMs");
	if (worktreeTimeout === "invalid" || dependencyTimeout === "invalid") return undefined;
	if (!lifecycleRequestHasWorktree(input)) return 0;
	return (
		(worktreeTimeout ?? DEFAULT_WORKTREE_PREPARATION_TIMEOUT_MS) +
		(dependencyTimeout ?? DEFAULT_DEPENDENCY_PREPARATION_TIMEOUT_MS)
	);
}

export interface LifecycleOuterDeadlines {
	admittedAt: number;
	worktreePrepTimeoutMs: number;
	dependencyPrepTimeoutMs: number;
	requestedReadinessTimeoutMs: number;
	worktreePreparationDeadlineAt: number;
	lifecycleCleanupDeadlineAt: number;
}

/**
 * Whole-request outer deadlines for a worktree launch. Child semantic readiness
 * is still derived later at prepSucceededAt. Dependency start is sequential:
 * callers clip remaining dep budget against `lifecycleCleanupDeadlineAt`
 * after worktreeDoneAt.
 */
export function deriveLifecycleOuterDeadlines(input: {
	admittedAt: number;
	worktreePrepTimeoutMs: number;
	dependencyPrepTimeoutMs: number;
	requestedReadinessTimeoutMs: number;
}): LifecycleOuterDeadlines {
	const { admittedAt, worktreePrepTimeoutMs, dependencyPrepTimeoutMs, requestedReadinessTimeoutMs } = input;
	if (
		!Number.isSafeInteger(admittedAt) ||
		!isValidPreparationTimeoutMs(worktreePrepTimeoutMs) ||
		!isValidPreparationTimeoutMs(dependencyPrepTimeoutMs) ||
		!isValidReadinessTimeoutMs(requestedReadinessTimeoutMs)
	) {
		throw new Error("Lifecycle outer timing values must be safe integers in the approved ranges.");
	}
	const worktreePreparationDeadlineAt = admittedAt + worktreePrepTimeoutMs;
	const lifecycleCleanupDeadlineAt =
		admittedAt + worktreePrepTimeoutMs + dependencyPrepTimeoutMs + requestedReadinessTimeoutMs;
	if (!Number.isSafeInteger(worktreePreparationDeadlineAt) || !Number.isSafeInteger(lifecycleCleanupDeadlineAt)) {
		throw new Error("Lifecycle outer timing values overflow the safe integer range.");
	}
	return {
		admittedAt,
		worktreePrepTimeoutMs,
		dependencyPrepTimeoutMs,
		requestedReadinessTimeoutMs,
		worktreePreparationDeadlineAt,
		lifecycleCleanupDeadlineAt,
	};
}

export function readPreparationTimeouts(
	input: Record<string, unknown>,
): { ok: true; worktreePrepTimeoutMs: number; dependencyPrepTimeoutMs: number } | { ok: false } {
	const worktreeTimeout = readPreparationTimeout(input, "worktreePreparationTimeoutMs");
	const dependencyTimeout = readPreparationTimeout(input, "dependencyPreparationTimeoutMs");
	if (worktreeTimeout === "invalid" || dependencyTimeout === "invalid") return { ok: false };
	return {
		ok: true,
		worktreePrepTimeoutMs: worktreeTimeout ?? DEFAULT_WORKTREE_PREPARATION_TIMEOUT_MS,
		dependencyPrepTimeoutMs: dependencyTimeout ?? DEFAULT_DEPENDENCY_PREPARATION_TIMEOUT_MS,
	};
}
