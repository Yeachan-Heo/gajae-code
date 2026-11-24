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
	#lastKnownLimit: number;

	constructor(settings: Settings, initialLimit: number) {
		this.#settings = settings;
		this.#lastKnownLimit = Math.max(1, initialLimit);
		this.#semaphore = new Semaphore(this.#lastKnownLimit);
	}

	/**
	 * Get current concurrency limit from live settings.
	 * Settings changes take effect on the next acquire() call.
	 */
	private getLimit(): number {
		const configured = this.#settings.get("task.maxConcurrency");
		return Math.max(1, configured);
	}

	/**
	 * Resize semaphore if the configured limit has changed.
	 * This allows runtime changes to task.maxConcurrency to take effect.
	 */
	private resizeIfNeeded(): void {
		const newLimit = this.getLimit();
		if (newLimit !== this.#lastKnownLimit) {
			this.#lastKnownLimit = newLimit;
			// Recreate semaphore with new limit to reflect the change
			// (The Semaphore class doesn't support in-place resizing)
			this.#semaphore = new Semaphore(newLimit);
		}
	}

	/**
	 * Acquire a concurrency slot.
	 * Deadlock prevention: nested tasks (taskDepth > 0) skip acquiring,
	 * allowing them to proceed without competing with parents for slots.
	 * @param taskDepth The nesting depth of this task (0 = top-level, 1+ = nested)
	 * @returns Information about whether a slot was acquired
	 */
	async acquire(taskDepth: number): Promise<{ acquiredSlot: boolean }> {
		const isTopLevel = taskDepth === 0;
		let acquiredSlot = false;

		if (isTopLevel) {
			// Only top-level tasks acquire slots from the shared pool
			this.resizeIfNeeded();
			await this.#semaphore.acquire();
			acquiredSlot = true;
		}
		// Nested tasks (taskDepth > 0) skip acquiring to prevent deadlock

		return { acquiredSlot };
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
