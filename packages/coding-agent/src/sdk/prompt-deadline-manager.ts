import { logger } from "@gajae-code/utils";
import type { KindAwareReconciliation } from "./bus/kind-aware-reconciliation";
import type { InvocationCorrelation, InvocationReconciliation } from "./host/session-runtime";
import {
	createPromptDeadlineLease,
	isAttributableProgressEventType,
	type PromptDeadlineLease,
	promptDeadlineAt,
	recordAttributableProgress,
} from "./prompt-deadline-lease";
import { failedPromptOutcome } from "./prompt-failure";
import type { SdkPromptTerminalOutcome } from "./prompt-status";
import type { TurnResultContent } from "./turn-result";

const MAX_EXPIRY_RETRIES = 5;
const MAX_UNCERTAINTY_RETRIES = 3;
const EXPIRY_RETRY_DELAY_MS = 1_000;
const UNCERTAINTY_RETRY_DELAY_MS = 1_000;

/**
 * Hard real-time bound on the best-effort durability hook, shared with
 * `prompt-deadline-flush` so the manager's race and the flush's own abort
 * signal cannot drift apart.
 */
export const DEADLINE_FLUSH_TIMEOUT_MS = 10_000;

/**
 * Run a best-effort durability flush under a hard real-time bound that ALWAYS
 * settles, and never let its result reach the caller.
 *
 * Shared by both expiry paths — this manager and the notification bus's own
 * terminalization (#5583) — so there is one bound, one abort, and one warning,
 * with no drift between them. A rejection is swallowed; a `run` that never
 * settles is abandoned after `timeoutMs` with its signal aborted so any git
 * subprocess dies. The signal alone is not sufficient: `git.withRepoLock`
 * awaits its predecessor before honouring it, so a hung predecessor in the
 * per-repo write chain is cut only by this outer race.
 */
export async function runBoundedDeadlineFlush(
	run: (signal: AbortSignal) => unknown,
	timeoutMs: number = DEADLINE_FLUSH_TIMEOUT_MS,
): Promise<void> {
	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	// An async wrapper so a `run` that throws synchronously becomes a rejection.
	const flushed = (async () => {
		await run(controller.signal);
	})();
	// The abandoned promise may still reject long after we stop awaiting it.
	flushed.catch(() => {});
	try {
		const bound = new Promise<"timeout">(resolve => {
			timer = setTimeout(() => resolve("timeout"), timeoutMs);
			// Never let a pending bound keep the process alive.
			(timer as unknown as { unref?: () => void }).unref?.();
		});
		if ((await Promise.race([flushed.then(() => "flushed" as const), bound])) === "timeout") {
			controller.abort(new Error(`prompt deadline flush exceeded ${timeoutMs}ms`));
			logger.warn(
				`sdk: prompt deadline flush exceeded its ${timeoutMs}ms bound; abandoning it and continuing teardown`,
			);
		}
	} catch {
		// A failing flush never changes the deadline outcome.
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

type DeadlineReconciliation = InvocationReconciliation | KindAwareReconciliation;

export type PromptDeadlineOutcome = Extract<SdkPromptTerminalOutcome, { kind: "failed" }> & {
	code: "prompt_deadline_exceeded";
	provenance: "deadline";
};

export interface PromptTerminalTransitionEvidence {
	content?: TurnResultContent;
	hasActivity?: boolean;
	outcome?: SdkPromptTerminalOutcome;
}

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
	readonly #pendingTerminalEvidence = new Map<string, PromptTerminalTransitionEvidence>();
	readonly #getLeaseMs: () => number;
	readonly #getMaxMs: () => number;
	readonly #now: () => number;
	readonly #onExpired?: (correlation: InvocationCorrelation, outcome?: PromptDeadlineOutcome) => void;
	readonly #onDeadlineExceeded?: (correlation: InvocationCorrelation, signal: AbortSignal) => void | Promise<void>;
	readonly #deadlineFlushTimeoutMs: number;

	constructor(options: {
		reconciliation: DeadlineReconciliation;
		getLeaseMs: () => number;
		getMaxMs: () => number;
		now?: () => number;
		onExpired?: (correlation: InvocationCorrelation, outcome?: PromptDeadlineOutcome) => void;
		/**
		 * Best-effort durability hook for the single path that genuinely retires a
		 * prompt as `prompt_deadline_exceeded` (#5583). Awaited after the durable
		 * pending claim but BEFORE the durable terminal, so a crash in that window
		 * leaves the record pending and recovery retries the prompt; a
		 * rejection is swallowed and never changes the deadline outcome. Not called
		 * when a real terminal transition or a real failure won the race, nor when
		 * renewed progress supersedes this expiry instance. The hook receives an
		 * abort signal that fires when it outruns `deadlineFlushTimeoutMs`.
		 */
		onDeadlineExceeded?: (correlation: InvocationCorrelation, signal: AbortSignal) => void | Promise<void>;
		/**
		 * Hard bound on `onDeadlineExceeded`. Measured with a real timer, not
		 * `now`, because it guards real subprocesses — which is also why it is a
		 * constructor option: a fake clock cannot shorten it for tests.
		 */
		deadlineFlushTimeoutMs?: number;
	}) {
		this.#reconciliation = options.reconciliation;
		this.#getLeaseMs = options.getLeaseMs;
		this.#getMaxMs = options.getMaxMs;
		this.#now = options.now ?? Date.now;
		this.#onExpired = options.onExpired;
		this.#onDeadlineExceeded = options.onDeadlineExceeded;
		this.#deadlineFlushTimeoutMs = options.deadlineFlushTimeoutMs ?? DEADLINE_FLUSH_TIMEOUT_MS;
	}

	/** Run the durability hook under the shared bound; see `runBoundedDeadlineFlush`. */
	async #runDeadlineFlush(correlation: InvocationCorrelation): Promise<void> {
		const hook = this.#onDeadlineExceeded;
		if (hook === undefined) return;
		await runBoundedDeadlineFlush(signal => hook(correlation, signal), this.#deadlineFlushTimeoutMs);
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
				await this.#reconciliation.noteTransition("prompt", correlation, {
					type: "agent_end",
					...this.#pendingTerminalEvidence.get(key),
				});
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
		let lookup: { status: string; error?: { code: string; message: string } };
		try {
			lookup = this.#reconciliation.lookup("prompt", correlation) as {
				status: string;
				error?: { code: string; message: string };
			};
		} catch {
			this.#retry(key);
			return;
		}
		if (lookup.status === "terminal_ok" || lookup.status === "failed") {
			this.clear(correlation);
			return;
		}
		if (lookup.error !== undefined) {
			// A real agent_failed diagnostic already won before the zero-activity
			// deadline. Use the synthetic boundary only to close that failed run;
			// never overwrite its authenticated classifier with
			// prompt_deadline_exceeded, which a late real agent_end could otherwise
			// upgrade to terminal_ok.
			try {
				await this.#reconciliation.noteTransition("prompt", correlation, { type: "agent_end" });
			} catch {
				this.#retry(key);
				return;
			}
			if (this.#backOffIfSuperseded(key, lease, lease.generation)) return;
			this.#expiryRetries.delete(key);
			this.#onExpired?.(correlation);
			this.clear(correlation);
			return;
		}
		const generation = lease.generation;
		const outcome: PromptDeadlineOutcome = failedPromptOutcome({
			code: "prompt_deadline_exceeded",
			provenance: "deadline",
			evidence: {},
		}) as PromptDeadlineOutcome;
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
		// Durability BEFORE the durable terminal (#5583, #5623 review round 4). The
		// claim above is already the durable pending marker, so a process death
		// anywhere in this window leaves the record PENDING and restart recovery
		// retries the prompt — work that was never autosaved is never reported as
		// finished. Running the flush after `finalizeOutcome` instead made the
		// autosave the one step a crash could silently skip, which is the whole
		// durability guarantee of this change. The cost is that the durable terminal
		// is delayed by at most the flush's bound.
		//
		// The wait is BOUNDED, not just guarded (#5623 review round 2): a hook that
		// never settles — a blocking git lock, a credential prompt — would leave the
		// finalize, `#onExpired` and `clear` below unreachable, stranding the prompt
		// with neither a terminal nor an owner. A try/catch cannot rescue a promise
		// that never settles, so the flush is raced against a real timer and
		// abandoned if it outruns it.
		await this.#runDeadlineFlush(correlation);
		// Fence again AFTER the flush (#5623 review round 2): the flush is an await
		// like any other here, and up to ten seconds long, so progress can land and
		// renew the lease while it runs. A renewed prompt must not be terminalized as
		// deadline-exceeded by this stale pass; `#backOffIfSuperseded` reschedules on
		// the way out, so it keeps a live deadline.
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
			this.#onExpired?.(correlation, outcome);
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
			.markUncertain(
				"prompt",
				correlation,
				() => {
					const current = this.#leases.get(key);
					return current === lease && current.generation === generation;
				},
				lease.acceptedAt + lease.maxMs,
			)
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
				const current = this.#leases.get(key);
				if (current !== lease || current.generation !== generation) {
					// Validate authority before applying the exhaustion branch too. A stale
					// third rejection must not mark or reschedule a renewed/replacement
					// lease's recovery state.
					this.#expiring.delete(key);
					this.#expiryRetries.delete(key);
					if (current) this.#schedule(key);
					return;
				}
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
	recoverPending(correlation: InvocationCorrelation, acceptedAt: number, deadlineMaxAt?: number): void {
		const key = leaseKey(correlation);
		if (this.#leases.has(key)) return;
		const now = this.#now();
		const lease = createPromptDeadlineLease({
			now,
			leaseMs: this.#getLeaseMs(),
			maxMs: deadlineMaxAt === undefined ? this.#getMaxMs() : Math.max(1, deadlineMaxAt - acceptedAt),
		});
		this.#leases.set(key, { ...lease, acceptedAt });
		this.#correlations.set(key, correlation);
		this.#uncertaintyRecoveryPending.add(key);
		this.#schedule(key);
	}

	onProgress(correlation: InvocationCorrelation, now = this.#now()): void {
		const key = leaseKey(correlation);
		const lease = this.#leases.get(key);
		if (!lease) return;
		const beforeGeneration = lease.generation;
		recordAttributableProgress(lease, now);
		if (lease.generation === beforeGeneration) return;
		this.#uncertaintyRetries.delete(key);
		if (this.#expiring.delete(key)) this.#expiryRetries.delete(key);
		this.#schedule(key);
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
		evidence?: PromptTerminalTransitionEvidence,
	): void {
		const key = leaseKey(correlation);
		if (!this.#leases.has(key)) {
			// A real agent_end may arrive after a synthetic deadline already cleared
			// its lease. Re-arm a bounded replay owner before the durable upgrade so a
			// failed terminal_ok write is retried rather than leaving the synthetic
			// deadline result permanently visible.
			this.onAccepted(correlation);
		}
		this.#pendingTerminalTransitions.add(key);
		if (evidence !== undefined) this.#pendingTerminalEvidence.set(key, evidence);
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
		this.#pendingTerminalEvidence.delete(key);
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
		this.#pendingTerminalEvidence.clear();
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
