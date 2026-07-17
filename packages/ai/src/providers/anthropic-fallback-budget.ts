// Keyed sliding-window retry budget for the Anthropic fallback-capacity
// downgrade (see providers/anthropic.ts). Extracted as its own unit so the
// lifecycle and clock semantics are directly testable without a public
// test-reset hook on the provider surface.
//
// - KEYED: each policy identity (origin + non-secret credential hash) owns
//   its slots; one credential/endpoint can never consume another's
//   allowance (#2464 third-review blocker).
// - MONOTONIC: the clock defaults to performance.now(), so wall-clock
//   rollback/forward cannot inflate or wedge a window. The clock is
//   injectable for tests; the only assumption is non-decreasing time, and a
//   non-advancing clock simply keeps the window full (conservative).
// - LIFECYCLE: every take() prunes expired timestamps and deletes empty
//   keys, so the map is bounded by the number of identities active within
//   one window.
// - CONCURRENCY: take() is synchronous, so interleaved async requests in
//   one JS runtime cannot double-spend a slot.
export class SlidingWindowBudget {
	readonly #timesByKey = new Map<string, number[]>();
	readonly #maxPerWindow: number;
	readonly #windowMs: number;
	readonly #now: () => number;

	constructor(maxPerWindow: number, windowMs: number, now: () => number = () => performance.now()) {
		this.#maxPerWindow = maxPerWindow;
		this.#windowMs = windowMs;
		this.#now = now;
	}

	/** Consume one slot for `key`; false = that key's window budget is spent. */
	take(key: string): boolean {
		const now = this.#now();
		for (const [existingKey, times] of this.#timesByKey) {
			const alive = times.filter(time => now - time < this.#windowMs);
			if (alive.length === 0) this.#timesByKey.delete(existingKey);
			else this.#timesByKey.set(existingKey, alive);
		}
		const times = this.#timesByKey.get(key) ?? [];
		if (times.length >= this.#maxPerWindow) return false;
		times.push(now);
		this.#timesByKey.set(key, times);
		return true;
	}

	/** Number of identities currently holding live slots (lifecycle tests). */
	get activeKeyCount(): number {
		return this.#timesByKey.size;
	}
}
