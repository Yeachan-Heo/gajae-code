import { cleanReason } from "@gajae-code/ai/auth-broker/redact";
import type { FallbackTriggerClass } from "@gajae-code/ai/utils/fallback-transport";

/** Immutable configured fallback intent. Transient attempt state never belongs here. */
export interface ConfiguredFallbackChain {
	role: string;
	entries: readonly string[];
	origin: string;
	identity?: string;
	explicitHead: boolean;
}

export interface FallbackFailure {
	selector: string;
	triggerClass: FallbackTriggerClass;
	reason: string;
}

export type FallbackFailureResult = "retry" | "advance" | "exhausted";

export interface FallbackChainRuntimeState {
	activeIndex: number;
	attemptsUsed: number;
	totalAttemptsUsed: number;
	attemptStarted: boolean;
	restoredEntryIndices: number[];
	tried: FallbackFailure[];
	skips: Array<{ selector: string; reason: string }>;
	exhaustedForTurn: boolean;
}

/**
 * In-memory policy state for one fallback-chain scope. A controller is deliberately
 * not serializable: configured chain intent is durable, current position is not.
 */
export class FallbackChainController {
	readonly chain: ConfiguredFallbackChain;
	readonly maxAttempts: number;
	activeIndex = 0;
	attemptsUsed = 0;
	tried: FallbackFailure[] = [];

	#attemptStarted = false;
	#totalAttemptsUsed = 0;
	#restoredEntryIndices = new Set<number>();
	skips: Array<{ selector: string; reason: string }> = [];
	exhaustedForTurn = false;

	constructor(chain: ConfiguredFallbackChain, maxAttempts: number) {
		if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
			throw new Error("fallback.maxAttempts must be a positive integer");
		}
		this.chain = { ...chain, entries: [...chain.entries] };
		this.maxAttempts = maxAttempts;
		if (this.chain.entries.length === 0) this.exhaustedForTurn = true;
	}

	snapshotRuntimeState(): FallbackChainRuntimeState {
		return {
			activeIndex: this.activeIndex,
			attemptsUsed: this.attemptsUsed,
			totalAttemptsUsed: this.#totalAttemptsUsed,
			attemptStarted: this.#attemptStarted,
			restoredEntryIndices: [...this.#restoredEntryIndices],
			tried: this.tried.map(failure => ({ ...failure })),
			skips: this.skips.map(skip => ({ ...skip })),
			exhaustedForTurn: this.exhaustedForTurn,
		};
	}

	restoreRuntimeState(state: FallbackChainRuntimeState): void {
		this.activeIndex = state.activeIndex;
		this.attemptsUsed = state.attemptsUsed;
		this.#totalAttemptsUsed = state.totalAttemptsUsed;
		this.#attemptStarted = state.attemptStarted;
		this.#restoredEntryIndices = new Set(state.restoredEntryIndices);
		this.tried = state.tried.map(failure => ({ ...failure }));
		this.skips = state.skips.map(skip => ({ ...skip }));
		this.exhaustedForTurn = state.exhaustedForTurn;
	}

	get totalAttemptsUsed(): number {
		return this.#totalAttemptsUsed;
	}

	#maxTotalAttempts(): number {
		return this.maxAttempts * this.chain.entries.length + this.#restoredEntryIndices.size;
	}

	currentSelector(): string | undefined {
		return this.chain.entries[this.activeIndex];
	}

	onResolutionSkip(reason: string): boolean {
		const selector = this.currentSelector();
		if (selector) this.skips.push({ selector, reason });
		return this.advance();
	}

	/** Charge an upstream request at its concrete transport boundary. */
	onAttemptStarted(): void {
		if (!this.currentSelector() || this.exhaustedForTurn) return;
		if (this.#totalAttemptsUsed >= this.#maxTotalAttempts()) {
			this.activeIndex = this.chain.entries.length;
			this.exhaustedForTurn = true;
			return;
		}
		this.attemptsUsed += 1;
		this.#totalAttemptsUsed += 1;
		this.#attemptStarted = true;
	}

	/** Remove the current started request from fallback-policy accounting without erasing prior failures. */
	discardStartedAttempt(): void {
		if (!this.#attemptStarted) return;
		this.attemptsUsed = Math.max(0, this.attemptsUsed - 1);
		this.#totalAttemptsUsed = Math.max(0, this.#totalAttemptsUsed - 1);
		this.#attemptStarted = false;
	}

	/** Start a logically new request with a fresh fallback-chain budget. */
	resetAttemptBudget(): void {
		this.attemptsUsed = 0;
		this.#totalAttemptsUsed = 0;
		this.tried = [];
		this.#restoredEntryIndices.clear();
		this.#attemptStarted = false;
	}

	/** Seed a controller from auth-aware resolution without charging requests. */
	seedResolution(activeIndex: number, skips: Array<{ selector: string; reason: string }>): void {
		this.activeIndex = Math.min(Math.max(0, activeIndex), this.chain.entries.length);
		this.skips = [...skips];
		this.attemptsUsed = 0;
		this.#totalAttemptsUsed = 0;
		this.#restoredEntryIndices.clear();
		this.#attemptStarted = false;
		this.exhaustedForTurn = this.activeIndex >= this.chain.entries.length;
	}

	onAttemptFailure(triggerClass: FallbackTriggerClass, reason: string): FallbackFailureResult {
		const selector = this.currentSelector();
		if (!selector || this.exhaustedForTurn) return "exhausted";
		if (!this.#attemptStarted) {
			this.attemptsUsed += 1;
			this.#totalAttemptsUsed += 1;
		}
		this.#attemptStarted = false;
		this.tried.push({ selector, triggerClass, reason });
		if (this.#totalAttemptsUsed >= this.#maxTotalAttempts()) {
			this.activeIndex = this.chain.entries.length;
			this.exhaustedForTurn = true;
			return "exhausted";
		}
		if (this.attemptsUsed < this.maxAttempts) return "retry";
		return this.advance() ? "advance" : "exhausted";
	}

	/**
	 * Record one bounded escaped-argument exhaustion for the active model and
	 * advance immediately. The discarded wire attempts are intentionally not
	 * provider charges; this single policy charge prevents the same model from
	 * being retried forever while still allowing every eligible fallback model
	 * its own literal-UTF-8 recovery budget.
	 */
	recordEscapedArgumentsFailure(reason: string, advance = true): boolean {
		const selector = this.currentSelector();
		if (!selector || this.exhaustedForTurn) return false;
		this.#attemptStarted = false;
		this.attemptsUsed = this.maxAttempts;
		this.#totalAttemptsUsed += 1;
		this.tried.push({ selector, triggerClass: "unknown", reason });
		return advance ? this.advance() : this.activeIndex + 1 < this.chain.entries.length;
	}

	advance(): boolean {
		if (this.exhaustedForTurn) return false;
		this.activeIndex += 1;
		this.attemptsUsed = 0;
		this.#attemptStarted = false;
		if (this.activeIndex >= this.chain.entries.length) {
			this.exhaustedForTurn = true;
			return false;
		}
		return true;
	}

	/**
	 * Restore the entry that just advanced for one attempt with a rotated credential.
	 * Each non-terminal entry may be restored once, so credential rotation remains
	 * bounded and cannot consume the attempts reserved for downstream entries.
	 */
	restorePreviousEntryForRetry(): boolean {
		const previousIndex = this.activeIndex - 1;
		if (
			previousIndex < 0 ||
			this.exhaustedForTurn ||
			this.#restoredEntryIndices.has(previousIndex) ||
			this.#totalAttemptsUsed >= this.#maxTotalAttempts()
		) {
			return false;
		}
		this.#restoredEntryIndices.add(previousIndex);
		this.activeIndex = previousIndex;
		this.attemptsUsed = this.maxAttempts - 1;
		this.exhaustedForTurn = false;
		this.#attemptStarted = false;
		return true;
	}

	isExhausted(): boolean {
		return this.exhaustedForTurn;
	}

	resetForNewTurn(): void {
		this.resetSticky();
	}

	resetSticky(): void {
		this.activeIndex = 0;
		this.attemptsUsed = 0;
		this.#totalAttemptsUsed = 0;
		this.tried = [];
		this.#restoredEntryIndices.clear();
		this.skips = [];
		this.exhaustedForTurn = this.chain.entries.length === 0;
		this.#attemptStarted = false;
	}
}

export function cappedExponentialWithFullJitter(
	baseDelayMs: number,
	maxDelayMs: number,
	attemptK: number,
	random: () => number = Math.random,
): number {
	const exponential = baseDelayMs * 2 ** Math.max(0, attemptK - 1);
	const cap = maxDelayMs > 0 ? Math.min(exponential, maxDelayMs) : exponential;
	return Math.floor(Math.max(0, cap) * Math.max(0, Math.min(1, random())));
}

/**
 * Legacy auto-compaction retry delay.
 *
 * Deliberately the mirror image of `effectiveFallbackDelay`: this path recovers
 * Retry-After by regex over provider error prose (`#parseRetryAfterMsFromError`),
 * so it follows the documented legacy rule — `retry.maxDelayMs` caps every
 * legacy session retry delay, including provider retry-after hints. Managed
 * fallback stays uncapped because it retries within its own per-entry budget;
 * compaction has no such budget, so the final candidate would otherwise sleep
 * for the full server-suggested duration.
 *
 * `maxDelayMs <= 0` means "no cap", matching `cappedExponentialWithFullJitter`.
 * A missing, NaN, or infinite hint collapses to "no usable hint".
 */
export function compactionRetryDelay(
	baseDelayMs: number,
	maxDelayMs: number,
	attempt: number,
	retryAfterMs: number | undefined,
): number {
	const exponential = baseDelayMs * 2 ** Math.max(0, attempt);
	const hint = Number.isFinite(retryAfterMs) ? Math.max(0, retryAfterMs as number) : 0;
	const hinted = Math.max(exponential, hint);
	const bounded = maxDelayMs > 0 ? Math.min(hinted, maxDelayMs) : hinted;
	return Math.max(0, bounded);
}

export interface CompactionCandidateFailure {
	readonly model: string;
	readonly message: string;
}

function sanitizeCompactionCandidateFailureMessage(message: string): string {
	const cleaned = cleanReason(message) ?? "Compaction candidate failed.";
	return cleaned.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s<>'"]+/gi, "[redacted URL]");
}

/**
 * Error for an auto-compaction run whose every candidate failed.
 *
 * The candidate chain starts at the session model and ends on a same-provider
 * largest-context fallback, so surfacing only the final error named a model
 * the user never chose and hid that their own model had already failed the
 * same way. The message leads with the first failure (the one the user can act
 * on), then lists every candidate that was tried with its own error. `cause`
 * is the final error so callers that classify by type keep the same object.
 */
export function describeCompactionCandidateFailures(
	failures: readonly CompactionCandidateFailure[],
	lastError: unknown,
): Error {
	if (failures.length === 0)
		return new Error("Compaction failed: no candidate failure details available.", { cause: lastError });
	const first = failures[0]!;
	const firstMessage = sanitizeCompactionCandidateFailureMessage(first.message);
	const lines = failures.map(
		failure => `  ${failure.model}: ${sanitizeCompactionCandidateFailureMessage(failure.message)}`,
	);
	return new Error(
		`${firstMessage} (${first.model}); ${failures.length} compaction candidates failed:\n${lines.join("\n")}`,
		{ cause: lastError },
	);
}

/** Retry-After is intentionally uncapped. */
export function effectiveFallbackDelay(
	baseDelayMs: number,
	maxDelayMs: number,
	attemptK: number,
	retryAfterMs: number | undefined,
	random: () => number = Math.random,
): number {
	return Math.max(cappedExponentialWithFullJitter(baseDelayMs, maxDelayMs, attemptK, random), retryAfterMs ?? 0);
}
