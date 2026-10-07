/**
 * Parallel execution with concurrency control.
 */
/** Result of parallel execution */
export interface ParallelResult<R> {
	/** Results array - undefined entries indicate tasks that were skipped due to abort */
	results: (R | undefined)[];
	/** Whether execution was aborted before all tasks completed */
	aborted: boolean;
}

function isAbortFailure(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	return error.name === "AbortError" || ("code" in error && error.code === "ABORT_ERR");
}

/**
 * Execute items with a concurrency limit using a worker pool pattern.
 * Results are returned in the same order as input items.
 *
 * On abort: returns partial results with `aborted: true`. Completed tasks are preserved,
 * in-progress tasks will complete with their abort handling, skipped tasks are `undefined`.
 *
 * On error: aborts peer workers, stops scheduling new items, waits for every
 * in-flight worker (including its cleanup) to settle, then rethrows the first
 * failure. Worker functions must honor the supplied signal for cancellation
 * to complete promptly.
 *
 * @param items - Items to process
 * @param concurrency - Maximum concurrent operations
 * @param fn - Async function to execute for each item
 * @param signal - Optional abort signal to stop scheduling new work
 */
export async function mapWithConcurrencyLimit<T, R>(
	items: T[],
	concurrency: number,
	fn: (item: T, index: number, signal: AbortSignal) => Promise<R>,
	signal?: AbortSignal,
): Promise<ParallelResult<R>> {
	const normalizedConcurrency = Number.isFinite(concurrency) ? Math.floor(concurrency) : items.length;
	const effectiveConcurrency = normalizedConcurrency > 0 ? normalizedConcurrency : items.length;
	const limit = Math.max(1, Math.min(effectiveConcurrency, items.length));
	const results: (R | undefined)[] = new Array(items.length);
	let nextIndex = 0;

	// Create internal abort controller to cancel workers on any rejection
	const abortController = new AbortController();
	const workerSignal = signal ? AbortSignal.any([signal, abortController.signal]) : abortController.signal;

	let firstError: { error: unknown } | undefined;

	const worker = async (): Promise<void> => {
		while (true) {
			// On abort, stop picking up new work - but don't throw
			if (workerSignal.aborted) return;
			const index = nextIndex++;
			if (index >= items.length) return;
			try {
				results[index] = await fn(items[index], index, workerSignal);
			} catch (error) {
				// External cancellation is an ordinary partial-result outcome. A
				// worker failure aborts peers, but is not surfaced until all their
				// in-flight cleanup has settled below.
				const expectedExternalAbort = signal?.aborted && isAbortFailure(error);
				if (!expectedExternalAbort && !firstError) {
					firstError = { error };
					abortController.abort();
				}
				return;
			}
		}
	};

	// Create worker pool
	const workers = Array(limit)
		.fill(null)
		.map(() => worker());

	// Do not release the batch while sibling workers are still unwinding. Their
	// finally blocks may own subprocess, worktree, or session cleanup.
	await Promise.allSettled(workers);
	if (firstError) throw firstError.error;

	return { results, aborted: signal?.aborted ?? false };
}

/**
 * Simple counting semaphore for limiting concurrency across independently-scheduled async work.
 */
export class Semaphore {
	#max: number;
	#current = 0;
	#queue: Array<() => void> = [];

	constructor(max: number) {
		this.#max = Math.max(1, max);
	}

	async acquire(): Promise<void> {
		if (this.#current < this.#max) {
			this.#current++;
			return;
		}
		const { promise, resolve } = Promise.withResolvers<void>();
		this.#queue.push(resolve);
		return promise;
	}

	release(): void {
		const next = this.#queue.shift();
		if (next) {
			next();
		} else {
			this.#current--;
		}
	}
}
