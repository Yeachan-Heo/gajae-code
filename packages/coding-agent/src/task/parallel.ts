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

/**
 * Execute items with a concurrency limit using a worker pool pattern.
 * Results are returned in the same order as input items.
 *
 * On abort: returns partial results with `aborted: true`. Completed tasks are preserved,
 * in-progress tasks will complete with their abort handling, skipped tasks are `undefined`.
 *
 * On error: fails fast - does not wait for other workers to complete.
 *
 * @param items - Items to process
 * @param concurrency - Maximum concurrent operations
 * @param fn - Async function to execute for each item
 * @param signal - Optional abort signal to stop scheduling new work
 */
export async function mapWithConcurrencyLimit<T, R>(
	items: T[],
	concurrency: number,
	fn: (item: T, index: number) => Promise<R>,
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

	// Promise that rejects on first error - used to fail fast (not for abort)
	let rejectFirst: (error: unknown) => void;
	const firstErrorPromise = new Promise<never>((_, reject) => {
		rejectFirst = reject;
	});

	const worker = async (): Promise<void> => {
		while (true) {
			// On abort, stop picking up new work - but don't throw
			if (workerSignal.aborted) return;
			const index = nextIndex++;
			if (index >= items.length) return;
			try {
				results[index] = await fn(items[index], index);
			} catch (error) {
				// On abort, the fn itself handles it and returns a result
				// Only propagate non-abort errors
				if (!workerSignal.aborted) {
					abortController.abort();
					rejectFirst(error);
					throw error;
				}
			}
		}
	};

	// Create worker pool
	const workers = Array(limit)
		.fill(null)
		.map(() => worker());

	try {
		await Promise.race([Promise.all(workers), firstErrorPromise]);
	} catch (error) {
		// If aborted, don't rethrow - return partial results
		if (signal?.aborted) {
			return { results, aborted: true };
		}
		throw error;
	}

	return { results, aborted: signal?.aborted ?? false };
}

interface QueuedWaiter {
	resolve: () => void;
	preAllocated?: boolean;
}

/**
 * Simple counting semaphore for limiting concurrency across independently-scheduled async work.
 * Supports in-place resizing while preserving active permits and queued waiters.
 */
export class Semaphore {
	#max: number | null; // null = unlimited
	#current = 0;
	#queue: QueuedWaiter[] = [];

	constructor(max: number | null) {
		if (max === null || max === 0) {
			this.#max = null; // unlimited
		} else {
			this.#max = Math.max(1, max);
		}
	}

	async acquire(): Promise<void> {
		// Unlimited: always acquire immediately
		if (this.#max === null) {
			this.#current++; // Track active count even in unlimited mode
			return;
		}

		if (this.#current < this.#max) {
			this.#current++;
			return;
		}
		const { promise, resolve } = Promise.withResolvers<void>();
		const waiter: QueuedWaiter = { resolve };
		this.#queue.push(waiter);
		await promise;
		// If pre-allocated by release/setMax, don't increment. Otherwise increment now.
		if (!waiter.preAllocated) {
			this.#current++;
		}
	}

	release(): void {
		// Unlimited: decrement the active count we incremented in acquire
		if (this.#max === null) {
			this.#current--;
			return;
		}

		// First, decrement since we're releasing
		this.#current--;

		// If we still have waiters and capacity is available, wake a waiter
		if (this.#current < this.#max && this.#queue.length > 0) {
			const waiter = this.#queue.shift();
			if (waiter) {
				// Mark as pre-allocated and increment #current for this waiter
				waiter.preAllocated = true;
				this.#current++;
				// Resolve the waiter; it will NOT re-increment in its acquire() return
				waiter.resolve();
			}
		}
	}

	/**
	 * Resize the semaphore limit while preserving existing permits and queued waiters.
	 * When shrinking: existing holders drain naturally, new acquires blocked if over limit.
	 * When growing: queued waiters are woken to fill new slots, with permits reserved.
	 */
	setMax(newMax: number | null): void {
		if (newMax === null || newMax === 0) {
			this.#max = null; // Switch to unlimited
			// Wake all queued waiters since we're now unlimited
			// Reserve permits for each waiter being woken
			while (this.#queue.length > 0) {
				const waiter = this.#queue.shift();
				if (waiter) {
					waiter.preAllocated = true;
					this.#current++;
					waiter.resolve();
				}
			}
			return;
		}

		const normalized = Math.max(1, newMax);

		// If currently unlimited, convert to limited
		if (this.#max === null) {
			this.#max = normalized;
			// Keep #current as-is; it represents actual holders
			// If #current > normalized, new acquires will block until releases bring it down
			return;
		}

		const oldMax = this.#max;
		this.#max = normalized;

		// If growing, wake waiters to fill new slots.
		// Only wake if the new limit provides additional capacity
		if (normalized > oldMax) {
			const availableSlots = normalized - this.#current;
			for (let i = 0; i < availableSlots && this.#queue.length > 0; i++) {
				const waiter = this.#queue.shift();
				if (waiter) {
					// Mark as pre-allocated and reserve the permit
					waiter.preAllocated = true;
					this.#current++;
					// Resolve the waiter; it will NOT re-increment in its acquire() return
					waiter.resolve();
				}
			}
		}
		// If shrinking: nothing to do. Existing holders drain naturally.
		// When they release(), we'll check if we're over the new limit.
	}
}
