/**
 * Bounded exponential backoff tracker for broker recovery failures per agent dir.
 * Tracks repeated recovery failures and implements exponential backoff with a cap
 * to prevent repeated spawns from destabilizing the system.
 */

/** Configuration for recovery backoff behavior. */
export interface RecoveryBackoffConfig {
	/** Initial backoff delay in milliseconds (default: 1000ms). */
	initialDelayMs: number;
	/** Maximum backoff delay in milliseconds (default: 30000ms = 30s). */
	maxDelayMs: number;
	/** Backoff multiplier applied each retry (default: 2). */
	multiplier: number;
	/** Maximum number of recovery attempts per session (default: 5). */
	maxAttempts: number;
}

/** State for a single agent dir's recovery backoff. */
export interface RecoveryBackoffState {
	/** Timestamp of the last recovery failure. */
	lastFailureAt: number;
	/** Current backoff delay in milliseconds. */
	currentDelayMs: number;
	/** Number of consecutive failures. */
	failureCount: number;
	/** Whether recovery has been permanently stopped due to max attempts. */
	stopped: boolean;
}

const DEFAULTS: RecoveryBackoffConfig = {
	initialDelayMs: 1_000,
	maxDelayMs: 30_000,
	multiplier: 2,
	maxAttempts: 5,
};

/** Manages per-agent-dir recovery backoff state. */
export class RecoveryBackoffTracker {
	#state = new Map<string, RecoveryBackoffState>();
	#config: RecoveryBackoffConfig;
	#clock: { now(): number } = { now: Date.now };

	constructor(config: Partial<RecoveryBackoffConfig> = {}) {
		this.#config = { ...DEFAULTS, ...config };
	}

	/** Test hook: inject a custom clock. */
	setClockForTest(clock: { now(): number }): void {
		this.#clock = clock;
	}

	/**
	 * Check if recovery should proceed now, considering backoff.
	 * Returns true if sufficient time has elapsed since the last failure.
	 */
	canAttemptRecovery(agentDir: string): boolean {
		const state = this.#state.get(agentDir);
		if (!state) return true;
		if (state.stopped) return false;

		const now = this.#clock.now();
		return now >= state.lastFailureAt + state.currentDelayMs;
	}

	/**
	 * Record a recovery failure and update backoff state.
	 * Returns true if recovery should continue to be attempted, false if max attempts reached.
	 */
	recordFailure(agentDir: string): boolean {
		let state = this.#state.get(agentDir);
		if (!state) {
			state = {
				lastFailureAt: this.#clock.now(),
				currentDelayMs: this.#config.initialDelayMs,
				failureCount: 1,
				stopped: false,
			};
			this.#state.set(agentDir, state);
		} else {
			state.lastFailureAt = this.#clock.now();
			state.failureCount += 1;

			// Apply exponential backoff
			state.currentDelayMs = Math.min(state.currentDelayMs * this.#config.multiplier, this.#config.maxDelayMs);

			// Stop if we've hit max attempts
			if (state.failureCount >= this.#config.maxAttempts) {
				state.stopped = true;
			}
		}

		return !state.stopped;
	}

	/**
	 * Record a successful recovery and reset backoff state.
	 */
	recordSuccess(agentDir: string): void {
		this.#state.delete(agentDir);
	}

	/**
	 * Get the current backoff state for an agent dir (for testing/diagnostics).
	 */
	getState(agentDir: string): RecoveryBackoffState | undefined {
		return this.#state.get(agentDir);
	}

	/**
	 * Get milliseconds until the next recovery attempt can proceed.
	 */
	getBackoffWaitMs(agentDir: string): number {
		const state = this.#state.get(agentDir);
		if (!state) return 0;

		const now = this.#clock.now();
		const nextAttemptAt = state.lastFailureAt + state.currentDelayMs;
		return Math.max(0, nextAttemptAt - now);
	}

	/**
	 * Reset all backoff state (for testing).
	 */
	resetForTest(): void {
		this.#state.clear();
	}
}
