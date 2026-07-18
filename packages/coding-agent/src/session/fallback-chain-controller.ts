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

	get totalAttemptsUsed(): number {
		return this.#totalAttemptsUsed;
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
		if (this.#totalAttemptsUsed >= this.maxAttempts * this.chain.entries.length) {
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
		this.#attemptStarted = false;
	}

	/** Seed a controller from auth-aware resolution without charging requests. */
	seedResolution(activeIndex: number, skips: Array<{ selector: string; reason: string }>): void {
		this.activeIndex = Math.min(Math.max(0, activeIndex), this.chain.entries.length);
		this.skips = [...skips];
		this.attemptsUsed = 0;
		this.#totalAttemptsUsed = 0;
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
		if (this.#totalAttemptsUsed >= this.maxAttempts * this.chain.entries.length) {
			this.activeIndex = this.chain.entries.length;
			this.exhaustedForTurn = true;
			return "exhausted";
		}
		if (this.attemptsUsed < this.maxAttempts) return "retry";
		return this.advance() ? "advance" : "exhausted";
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
	 * Restore the entry that just advanced when credential rotation permits a retry.
	 * The chain-wide budget and failure history remain charged.
	 */
	restorePreviousEntryForRetry(): boolean {
		if (
			this.activeIndex === 0 ||
			this.exhaustedForTurn ||
			this.#totalAttemptsUsed >= this.maxAttempts * this.chain.entries.length
		) {
			return false;
		}
		this.activeIndex -= 1;
		this.attemptsUsed = 0;
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
