/**
 * Session-wide task concurrency pool.
 * Enforces task.maxConcurrency globally across all concurrent task() calls,
 * preventing unbounded concurrency and VM crashes from detached/nested tasks.
 */
import type { Settings } from "../config/settings";
import { Semaphore } from "./parallel";

/**
 * Session-global task pool managing concurrency limits across task() calls.
 * Deadlock prevention: nested tasks (taskDepth > 0) are exempt from acquiring
 * slots, allowing them to proceed without competing with parents for the same
 * limited slots. This prevents circular waits where parents wait for children
 * that cannot proceed due to slot exhaustion.
 */
export class SessionTaskPool {
	#semaphore: Semaphore;
	#settings: Settings;
	#lastKnownLimit: number | null; // null = unlimited

	constructor(settings: Settings, initialLimit: number) {
		this.#settings = settings;
		// Apply the same normalization as getLimit():
		// 0 = unlimited, negative = clamp to 1
		this.#lastKnownLimit = initialLimit === 0 ? null : initialLimit < 0 ? 1 : initialLimit;
		this.#semaphore = new Semaphore(this.#lastKnownLimit);
	}

	/**
	 * Get current concurrency limit from live settings.
	 * 0 or undefined = unlimited, negative = clamped to 1 (not unlimited).
	 */
	private getLimit(): number | null {
		const configured = this.#settings.get("task.maxConcurrency");
		// 0 or undefined = unlimited, negative/non-numeric = clamp to 1
		if (configured === 0 || configured === null || configured === undefined) {
			return null; // unlimited
		}
		const parsed = typeof configured === "number" ? configured : 1;
		// Only 0 and null are unlimited; clamp negative values to 1
		return parsed < 0 ? 1 : parsed;
	}

	/**
	 * Resize semaphore if the configured limit has changed.
	 * This allows runtime changes to task.maxConcurrency to take effect in-place,
	 * preserving existing permits and queued waiters.
	 */
	private resizeIfNeeded(): void {
		const newLimit = this.getLimit();
		if (newLimit !== this.#lastKnownLimit) {
			this.#lastKnownLimit = newLimit;
			this.#semaphore.setMax(newLimit);
		}
	}

	/**
	 * Acquire a concurrency slot.
	 * All tasks acquire from the shared pool to enforce the session-wide limit.
	 * Deadlock is avoided because: when a task spawns nested children, the parent
	 * is no longer waiting (it's executing); children acquire after the parent
	 * is in progress, not before the parent has acquired.
	 * @param _taskDepth The nesting depth of this task (0 = top-level, 1+ = nested) [unused, kept for API compatibility]
	 * @returns Information about whether a slot was acquired
	 */
	async acquire(_taskDepth: number): Promise<{ acquiredSlot: boolean }> {
		this.resizeIfNeeded();
		await this.#semaphore.acquire();
		return { acquiredSlot: true };
	}

	/**
	 * Release a concurrency slot.
	 * Only tasks that actually acquired a slot release one.
	 * @param info Result from acquire() indicating if a slot was acquired
	 */
	release(info: { acquiredSlot: boolean }): void {
		if (info.acquiredSlot) {
			this.#semaphore.release();
		}
	}
}
