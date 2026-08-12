import type { KindAwareReconciliation } from "./bus/kind-aware-reconciliation";
import type { InvocationCorrelation, InvocationReconciliation } from "./host/session-runtime";
import {
	createPromptDeadlineLease,
	isAttributableProgressEventType,
	type PromptDeadlineLease,
	promptDeadlineAt,
	recordAttributableProgress,
} from "./prompt-deadline-lease";

type DeadlineReconciliation = InvocationReconciliation | KindAwareReconciliation;
export type PromptDeadlineOutcome = {
	kind: "failed";
	code: "prompt_deadline_exceeded";
	message: string;
	provenance: "deadline";
};

function leaseKey(correlation: InvocationCorrelation): string {
	return `${correlation.commandId}:${correlation.turnId}`;
}

export class PromptDeadlineManager {
	readonly #leases = new Map<string, PromptDeadlineLease>();
	readonly #correlations = new Map<string, InvocationCorrelation>();
	readonly #timers = new Map<string, ReturnType<typeof setTimeout>>();
	readonly #reconciliation: DeadlineReconciliation;
	readonly #getLeaseMs: () => number;
	readonly #getMaxMs: () => number;
	readonly #now: () => number;

	constructor(options: {
		reconciliation: DeadlineReconciliation;
		getLeaseMs: () => number;
		getMaxMs: () => number;
		now?: () => number;
	}) {
		this.#reconciliation = options.reconciliation;
		this.#getLeaseMs = options.getLeaseMs;
		this.#getMaxMs = options.getMaxMs;
		this.#now = options.now ?? Date.now;
	}

	#clearTimer(key: string): void {
		const timer = this.#timers.get(key);
		if (timer !== undefined) {
			clearTimeout(timer);
			this.#timers.delete(key);
		}
	}

	#schedule(key: string): void {
		const lease = this.#leases.get(key);
		if (!lease) return;
		this.#clearTimer(key);
		const deadlineAt = promptDeadlineAt(lease);
		const delayMs = Math.max(0, deadlineAt - this.#now());
		const timer = setTimeout(() => {
			void this.#onDeadline(key);
		}, delayMs);
		// Allow process to exit without waiting for deadline timer.
		(timer as unknown as { unref?: () => void }).unref?.();
		this.#timers.set(key, timer);
	}

	async #onDeadline(key: string): Promise<void> {
		const correlation = this.#correlations.get(key);
		const lease = this.#leases.get(key);
		if (!correlation || !lease) return;
		// Re-check deadline still due (monotonic, but handle clock skew).
		if (this.#now() < promptDeadlineAt(lease)) {
			this.#schedule(key);
			return;
		}
		const lookup = this.#reconciliation.lookup("prompt", correlation) as { status: string };
		if (lookup.status === "terminal_ok" || lookup.status === "failed") {
			this.clear(correlation);
			return;
		}
		const outcome: PromptDeadlineOutcome = {
			kind: "failed",
			code: "prompt_deadline_exceeded",
			message: "Prompt deadline exceeded.",
			provenance: "deadline",
		};
		try {
			await this.#reconciliation.claimPendingOutcome("prompt", correlation, outcome);
		} catch {
			// claim may fail if already claimed (e.g., cancellation won); ignore.
		}
		try {
			await this.#reconciliation.finalizeOutcome("prompt", correlation, outcome);
		} catch {
			// finalize may race with normal terminalization; ignore.
		} finally {
			this.clear(correlation);
		}
	}

	onAccepted(correlation: InvocationCorrelation): void {
		const key = leaseKey(correlation);
		if (this.#leases.has(key)) return;
		const now = this.#now();
		const lease = createPromptDeadlineLease({ now, leaseMs: this.#getLeaseMs(), maxMs: this.#getMaxMs() });
		this.#leases.set(key, lease);
		this.#correlations.set(key, correlation);
		this.#schedule(key);
	}

	onProgress(correlation: InvocationCorrelation, now = this.#now()): void {
		const key = leaseKey(correlation);
		const lease = this.#leases.get(key);
		if (!lease) return;
		const beforeDeadline = promptDeadlineAt(lease);
		recordAttributableProgress(lease, now);
		const afterDeadline = promptDeadlineAt(lease);
		if (afterDeadline !== beforeDeadline) this.#schedule(key);
	}

	onAttributableEvent(correlation: InvocationCorrelation, eventType: string, now = this.#now()): void {
		if (!isAttributableProgressEventType(eventType)) return;
		this.onProgress(correlation, now);
	}

	clear(correlation: InvocationCorrelation): void {
		const key = leaseKey(correlation);
		this.#clearTimer(key);
		this.#leases.delete(key);
		this.#correlations.delete(key);
	}

	clearAll(): void {
		for (const key of [...this.#timers.keys()]) this.#clearTimer(key);
		this.#leases.clear();
		this.#correlations.clear();
	}

	/** For tests: current deadline or undefined if no lease. */
	deadlineAt(correlation: InvocationCorrelation): number | undefined {
		const lease = this.#leases.get(leaseKey(correlation));
		return lease ? promptDeadlineAt(lease) : undefined;
	}

	/** For tests: whether a lease exists. */
	has(correlation: InvocationCorrelation): boolean {
		return this.#leases.has(leaseKey(correlation));
	}
}
