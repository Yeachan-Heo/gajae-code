export interface AdaptiveCompactionState {
	turnsSinceCompact: number;
	callsInWindow: number;
	windowStart: number;
	lastContextTokens: number;
	lastCompactContextTokens: number | null;
	lastCompactTs: number | null;
}

export interface AdaptiveCompactionDecisionState {
	turnsSinceCompact: number;
	callsInWindow: number;
	lastContextTokens?: number;
}

export interface AdaptiveCompactionOptions {
	enabled: boolean;
	turnWindow: number;
	baseThresholdPercent: number;
	aggression: number;
	minThresholdPercent?: number;
}

export class AdaptiveCompactionTracker {
	#state: AdaptiveCompactionState;
	windowMs: number;

	constructor(windowMs = 60_000, now = Date.now()) {
		this.windowMs = Number.isFinite(windowMs) && windowMs > 0 ? windowMs : 60_000;
		this.#state = {
			turnsSinceCompact: 0,
			callsInWindow: 0,
			windowStart: now,
			lastContextTokens: 0,
			lastCompactContextTokens: null,
			lastCompactTs: null,
		};
	}

	setWindowMs(windowMs: number, now = Date.now()): void {
		if (!Number.isFinite(windowMs)) return;
		const nextWindowMs = Math.max(1, windowMs);
		if (nextWindowMs === this.windowMs) return;
		this.windowMs = nextWindowMs;
		this.#state.windowStart = now;
		this.#state.callsInWindow = 0;
	}

	reset(now = Date.now()): void {
		this.#state = {
			turnsSinceCompact: 0,
			callsInWindow: 0,
			windowStart: now,
			lastContextTokens: 0,
			lastCompactContextTokens: null,
			lastCompactTs: null,
		};
	}

	recordCall(contextTokens: number, now = Date.now()): void {
		const timestamp = Number.isFinite(now) ? now : Date.now();
		this.#state.turnsSinceCompact += 1;
		if (timestamp - this.#state.windowStart >= this.windowMs) {
			this.#state.windowStart = timestamp;
			this.#state.callsInWindow = 0;
		}
		this.#state.callsInWindow += 1;
		this.#state.lastContextTokens = contextTokens;
	}

	recordCompact(contextTokens: number, now = Date.now()): void {
		const timestamp = Number.isFinite(now) ? now : Date.now();
		this.#state.turnsSinceCompact = 0;
		this.#state.callsInWindow = 0;
		this.#state.windowStart = timestamp;
		this.#state.lastContextTokens = contextTokens;
		this.#state.lastCompactContextTokens = contextTokens;
		this.#state.lastCompactTs = timestamp;
	}

	snapshot(): AdaptiveCompactionState {
		return { ...this.#state };
	}

	decisionState(): AdaptiveCompactionDecisionState {
		return {
			turnsSinceCompact: this.#state.turnsSinceCompact,
			callsInWindow: this.#state.callsInWindow,
			lastContextTokens: this.#state.lastContextTokens,
		};
	}
}
