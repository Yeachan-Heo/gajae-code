import type { KindAwareReconciliation } from "./bus/kind-aware-reconciliation";
import type { InvocationCorrelation, InvocationReconciliation } from "./host/session-runtime";
import {
	createPromptDeadlineLease,
	isAttributableProgressEventType,
	type PromptDeadlineLease,
	promptDeadlineAt,
	recordAttributableProgress,
} from "./prompt-deadline-lease";

const MAX_EXPIRY_RETRIES = 5;
const MAX_UNCERTAINTY_RETRIES = 3;
const EXPIRY_RETRY_DELAY_MS = 1_000;
const UNCERTAINTY_RETRY_DELAY_MS = 1_000;

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
	readonly #expiryRetries = new Map<string, number>();
	readonly #uncertaintyRetries = new Map<string, number>();
	readonly #uncertaintyRecoveryPending = new Set<string>();
	readonly #expiring = new Set<string>();
	readonly #pendingTerminalTransitions = new Set<string>();
	readonly #pendingTerminalFailureReasons = new Map<string, { code: string; message: string }>();
	readonly #getLeaseMs: () => number;
	readonly #getMaxMs: () => number;
	readonly #now: () => number;
	readonly #onExpired?: (correlation: InvocationCorrelation) => void;

	constructor(options: {
		reconciliation: DeadlineReconciliation;
		getLeaseMs: () => number;
		getMaxMs: () => number;
		now?: () => number;
		onExpired?: (correlation: InvocationCorrelation) => void;
	}) {
		this.#reconciliation = options.reconciliation;
		this.#getLeaseMs = options.getLeaseMs;
		this.#getMaxMs = options.getMaxMs;
		this.#now = options.now ?? Date.now;
		this.#onExpired = options.onExpired;
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
		// Fence lifecycle adoption before replaying a real terminal transition.
		// A successor agent_start must not drain this correlation while its
		// durable upgrade is still pending or being retried.
		this.#expiring.add(key);
		if (this.#pendingTerminalTransitions.has(key)) {
			const failureReason = this.#pendingTerminalFailureReasons.get(key);
			try {
				if (failureReason !== undefined) {
					// Re-record the durable failure reason first: without it the terminal
					// boundary below classifies the abandoned prompt as terminal_ok.
					await this.#reconciliation.noteTransition("prompt", correlation, {
						type: "agent_failed",
						error: Object.assign(new Error(failureReason.message), { code: failureReason.code }),
					} as never);
				}
				await this.#reconciliation.noteTransition("prompt", correlation, { type: "agent_end" });
				// Supersession check before retiring ownership (exact-head review P1):
				// attributable progress during the awaited writes renews the lease
				// past its deadline, so this replay instance must back off and
				// reschedule instead of clearing a live prompt's lease.
				if (this.#backOffIfSuperseded(key, lease, lease.generation)) return;
				this.#expiryRetries.delete(key);
				this.#onExpired?.(correlation);
				this.clear(correlation);
			} catch {
				this.#retry(key);
			}
			return;
		}
		let lookup: { status: string };
		try {
			lookup = this.#reconciliation.lookup("prompt", correlation) as { status: string };
		} catch {
			this.#retry(key);
			return;
		}
		if (lookup.status === "terminal_ok" || lookup.status === "failed") {
			this.clear(correlation);
			return;
		}
		const generation = lease.generation;
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
		// Re-verify the captured lease is still authoritative after the claim
		// await (exact-head review P2): fresh attributable progress during the
		// claim must cancel this expiry instance instead of surfacing an exceeded
		// outcome for a prompt that is demonstrably alive.
		if (this.#backOffIfSuperseded(key, lease, generation)) return;
		try {
			await this.#reconciliation.finalizeOutcome("prompt", correlation, outcome, () => {
				const current = this.#leases.get(key);
				return current === lease && current.generation === generation;
			});
		} catch {
			// Do not infer durable confirmation from an in-memory lookup after a
			// failed write. The accepted lease and ownership stay recoverable until
			// a later retry observes a successful finalization.
			this.#retry(key);
			return;
		}
		// Finalization is generation-aware too (exact-head review P2): progress
		// observed during the finalize await renews the lease past its deadline,
		// so this expiry pass must not retire the now-live invocation's pending
		// ownership even though the finalize write landed.
		if (this.#backOffIfSuperseded(key, lease, generation)) return;
		// Retire pending ownership ONLY after durable terminal confirmation with
		// no superseding progress (#4668 review P1): retiring earlier strands an
		// accepted/in-flight invocation without an owner, retry, or deadline
		// recovery path.
		try {
			this.#onExpired?.(correlation);
		} catch {}
		this.#expiryRetries.delete(key);
		this.clear(correlation);
	}

	/**
	 * After an awaited reconciliation call, verify the captured lease is still
	 * authoritative. Fresh attributable progress during the await advances the
	 * lease generation and its deadline; when superseded, cancel this expiry
	 * instance (release the expiration fence, clear any retry budget, and
	 * reschedule the deadline) and report it so the caller stops. A cleared or
	 * re-accepted lease is stale by identity too.
	 */
	#backOffIfSuperseded(key: string, lease: PromptDeadlineLease, generation: number): boolean {
		const current = this.#leases.get(key);
		if (current !== lease || current.generation !== generation || this.#now() < promptDeadlineAt(current)) {
			this.#expiring.delete(key);
			this.#expiryRetries.delete(key);
			if (current) this.#schedule(key);
			return true;
		}
		return false;
	}

	#retry(key: string): void {
		const attempts = (this.#expiryRetries.get(key) ?? 0) + 1;
		this.#expiryRetries.set(key, attempts);
		this.#clearTimer(key);
		if (attempts > MAX_EXPIRY_RETRIES) {
			const correlation = this.#correlations.get(key);
			const lease = this.#leases.get(key);
			if (correlation && lease) this.#recoverUncertainty(key, correlation, lease, lease.generation);
			return;
		}
		const timer = setTimeout(() => void this.#onDeadline(key), EXPIRY_RETRY_DELAY_MS);
		(timer as unknown as { unref?: () => void }).unref?.();
		this.#timers.set(key, timer);
	}

	#recoverUncertainty(
		key: string,
		correlation: InvocationCorrelation,
		lease: PromptDeadlineLease,
		generation: number,
	): void {
		const current = this.#leases.get(key);
		if (
			!correlation ||
			current !== lease ||
			current.generation !== generation ||
			typeof this.#reconciliation.markUncertain !== "function"
		)
			return;
		const attempts = (this.#uncertaintyRetries.get(key) ?? 0) + 1;
		this.#uncertaintyRetries.set(key, attempts);
		void this.#reconciliation
			.markUncertain("prompt", correlation, () => {
				const current = this.#leases.get(key);
				return current === lease && current.generation === generation;
			})
			.then(() => {
				const current = this.#leases.get(key);
				if (current === lease && current.generation === generation) {
					// The uncertainty write succeeded, so the record is durably
					// recoverable. Re-anchor and reschedule a fresh bounded lease
					// instead of clearing (#4668 review P2): clearing leaves the
					// persisted deadlineRecoveryPending record with no in-process
					// bound, and a wedged run then strands it accepted forever.
					// A new lease keeps the maxMs hard cap from the original
					// acceptance, so recovery still terminalizes boundedly.
					const reanchored = createPromptDeadlineLease({
						now: this.#now(),
						leaseMs: Math.max(1, lease.leaseMs),
						maxMs: Math.max(lease.maxMs - (this.#now() - lease.acceptedAt), 1),
					});
					this.#leases.set(key, reanchored);
					this.#expiring.delete(key);
					this.#expiryRetries.delete(key);
					this.#uncertaintyRetries.delete(key);
					this.#schedule(key);
				}
			})
			.catch(() => {
				if (attempts >= MAX_UNCERTAINTY_RETRIES) {
					// Keep an explicit in-memory recovery state AND a live retry timer: a
					// later real agent_end can still reconcile the retained lease, and the
					// scheduled recovery attempt keeps retrying the durable uncertainty
					// write so accepted work is never left indefinitely unbounded (exact-
					// head review P1: parking without a timer strands the accepted row).
					this.#uncertaintyRecoveryPending.add(key);
					const live = this.#leases.get(key);
					if (live === lease) {
						this.#clearTimer(key);
						const recoveryTimer = setTimeout(
							() => this.#recoverUncertainty(key, correlation, live, live.generation),
							UNCERTAINTY_RETRY_DELAY_MS,
						);
						(recoveryTimer as unknown as { unref?: () => void }).unref?.();
						this.#timers.set(key, recoveryTimer);
					}
					return;
				}
				const current = this.#leases.get(key);
				if (current !== lease || current.generation !== generation) {
					// The timer map is keyed by correlation, so never clear or replace
					// it after this failed attempt has become stale. The current owner
					// already owns its own timer; reschedule only that live lease.
					// This recovery attempt is over: release the adoption fence and
					// the exhausted retry budget so the live lease restarts clean.
					this.#expiring.delete(key);
					this.#expiryRetries.delete(key);
					if (current) this.#schedule(key);
					return;
				}
				this.#clearTimer(key);
				const timer = setTimeout(
					() => this.#recoverUncertainty(key, correlation, lease, generation),
					UNCERTAINTY_RETRY_DELAY_MS,
				);
				(timer as unknown as { unref?: () => void }).unref?.();
				this.#timers.set(key, timer);
			});
	}

	onAccepted(correlation: InvocationCorrelation): void {
		const key = leaseKey(correlation);
		if (this.#leases.has(key)) return;
		const now = this.#now();
		const lease = createPromptDeadlineLease({ now, leaseMs: this.#getLeaseMs(), maxMs: this.#getMaxMs() });
		this.#leases.set(key, lease);
		this.#correlations.set(key, correlation);
		this.#uncertaintyRetries.delete(key);
		this.#uncertaintyRecoveryPending.delete(key);
		this.#schedule(key);
	}

	/** Re-arm a durable uncertainty-recovery record after process startup without
	 * resetting its acceptance-anchored hard maximum runtime. */
	recoverPending(correlation: InvocationCorrelation, acceptedAt: number): void {
		const key = leaseKey(correlation);
		if (this.#leases.has(key)) return;
		const now = this.#now();
		const lease = createPromptDeadlineLease({ now, leaseMs: this.#getLeaseMs(), maxMs: this.#getMaxMs() });
		this.#leases.set(key, { ...lease, acceptedAt });
		this.#correlations.set(key, correlation);
		this.#uncertaintyRecoveryPending.add(key);
		this.#schedule(key);
	}

	onProgress(correlation: InvocationCorrelation, now = this.#now()): void {
		const key = leaseKey(correlation);
		const lease = this.#leases.get(key);
		if (!lease) return;
		this.#uncertaintyRetries.delete(key);
		const beforeDeadline = promptDeadlineAt(lease);
		recordAttributableProgress(lease, now);
		const afterDeadline = promptDeadlineAt(lease);
		if (this.#expiring.delete(key)) this.#expiryRetries.delete(key);
		if (afterDeadline !== beforeDeadline || !this.#expiring.has(key)) this.#schedule(key);
	}

	onAttributableEvent(correlation: InvocationCorrelation, eventType: string, now = this.#now()): void {
		if (!isAttributableProgressEventType(eventType)) return;
		this.onProgress(correlation, now);
	}

	/** Mark a real agent_end before durable reconciliation begins. If its upgrade
	 * write fails, deadline retry replays this event instead of reasserting the
	 * synthetic prompt_deadline_exceeded outcome. */
	noteTerminalTransition(
		correlation: InvocationCorrelation,
		pendingFailure?: { code: string; message: string },
	): void {
		const key = leaseKey(correlation);
		if (!this.#leases.has(key)) return;
		this.#pendingTerminalTransitions.add(key);
		// Compound failure-plus-terminal recovery intent (exact-head review HIGH):
		// when expiry replays this real terminal transition after a failed write, it
		// must re-record the failure reason BEFORE agent_end, or the abandoned or
		// rejected prompt terminalizes as terminal_ok and loses its cause.
		if (pendingFailure !== undefined) this.#pendingTerminalFailureReasons.set(key, pendingFailure);
	}

	clear(correlation: InvocationCorrelation): void {
		const key = leaseKey(correlation);
		this.#clearTimer(key);
		this.#leases.delete(key);
		this.#correlations.delete(key);
		this.#expiryRetries.delete(key);
		this.#uncertaintyRetries.delete(key);
		this.#uncertaintyRecoveryPending.delete(key);
		this.#expiring.delete(key);
		this.#pendingTerminalTransitions.delete(key);
		this.#pendingTerminalFailureReasons.delete(key);
	}

	clearAll(): void {
		for (const key of [...this.#timers.keys()]) this.#clearTimer(key);
		this.#leases.clear();
		this.#correlations.clear();
		this.#expiryRetries.clear();
		this.#uncertaintyRetries.clear();
		this.#uncertaintyRecoveryPending.clear();
		this.#expiring.clear();
		this.#pendingTerminalTransitions.clear();
		this.#pendingTerminalFailureReasons.clear();
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

	/** Whether expiry has fenced this correlation from late run adoption. */
	isExpiring(correlation: InvocationCorrelation): boolean {
		return this.#expiring.has(leaseKey(correlation));
	}

	/** Whether bounded uncertainty writes exhausted with recovery ownership retained. */
	hasRecoveryPending(correlation: InvocationCorrelation): boolean {
		return this.#uncertaintyRecoveryPending.has(leaseKey(correlation));
	}
}
