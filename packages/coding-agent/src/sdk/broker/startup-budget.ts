/** Readiness budget the broker grants a lifecycle request that does not size one itself. */
export const DEFAULT_READINESS_TIMEOUT_MS = 10_000;
export const MIN_READINESS_TIMEOUT_MS = 4_000;
export const MAX_READINESS_TIMEOUT_MS = 60_000;

export function isValidReadinessTimeoutMs(value: unknown): value is number {
	return (
		typeof value === "number" &&
		Number.isSafeInteger(value) &&
		value >= MIN_READINESS_TIMEOUT_MS &&
		value <= MAX_READINESS_TIMEOUT_MS
	);
}

export const READINESS_TIMEOUT_INVALID_MESSAGE = `readinessTimeoutMs must be an integer between ${MIN_READINESS_TIMEOUT_MS} and ${MAX_READINESS_TIMEOUT_MS}.`;
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
	if (isStartupLifecycleOperation(operation))
		return lifecycleStartupBudgetMs(supplied ?? DEFAULT_READINESS_TIMEOUT_MS) + CALLER_DEADLINE_SLACK_MS;
	return supplied === undefined ? undefined : supplied + CALLER_DEADLINE_SLACK_MS;
}
