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
