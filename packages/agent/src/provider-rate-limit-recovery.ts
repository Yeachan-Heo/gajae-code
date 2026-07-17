export interface ProviderRateLimitModel {
	provider: string;
	id: string;
}

export type ProviderRateLimitRecoveryOutcome =
	| { type: "success" }
	| { type: "aborted" }
	| { type: "threw" }
	| { type: "error"; status?: number };

export interface ProviderRateLimitRecoveryTicket {
	readonly scope: object;
	readonly key: string;
	readonly kind: "healthy" | "probe";
	readonly generation: number;
	settled: boolean;
}

export interface ProviderRateLimitRecoveryClock {
	now(): number;
	setTimeout(callback: () => void, delayMs: number): unknown;
	clearTimeout(handle: unknown): void;
}

interface Waiter {
	resolve(ticket: ProviderRateLimitRecoveryTicket): void;
	reject(reason: unknown): void;
	signal?: AbortSignal;
	onAbort?: () => void;
}

interface Bucket {
	generation: number;
	deadline: number;
	probeInFlight: boolean;
	probeGeneration?: number;
	waiters: Waiter[];
	timer?: unknown;
}

const realClock: ProviderRateLimitRecoveryClock = {
	now: () => Date.now(),
	setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
	clearTimeout: handle => clearTimeout(handle as number),
};

function abortReason(signal: AbortSignal): unknown {
	return signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

function keyFor(model: ProviderRateLimitModel): string {
	return JSON.stringify([model.provider, model.id]);
}

function delayOrZero(delayMs: number): number {
	return Number.isFinite(delayMs) && delayMs >= 0 ? delayMs : 0;
}
const MAX_TIMEOUT_DELAY_MS = 2_147_483_647;

function timeoutDelay(delayMs: number): number {
	return Math.min(Math.max(0, delayMs), MAX_TIMEOUT_DELAY_MS);
}

/**
 * Coordinates logical stream recovery after final, structured provider 429s.
 * Scope identity is intentionally opaque and only used as a WeakMap key.
 */
export class ProviderRateLimitRecoveryGate {
	#buckets = new WeakMap<object, Map<string, Bucket>>();
	#clock: ProviderRateLimitRecoveryClock;

	constructor(clock: ProviderRateLimitRecoveryClock = realClock) {
		this.#clock = clock;
	}

	acquire(
		scope: object,
		model: ProviderRateLimitModel,
		signal?: AbortSignal,
	): Promise<ProviderRateLimitRecoveryTicket> {
		if (signal?.aborted) return Promise.reject(abortReason(signal));
		const key = keyFor(model);
		const bucket = this.#bucket(scope, key);
		if (!bucket) return Promise.resolve(this.#ticket(scope, key, "healthy", 0));
		if (!bucket.probeInFlight && this.#clock.now() >= bucket.deadline) {
			return Promise.resolve(this.#admitProbe(scope, key, bucket));
		}
		return new Promise<ProviderRateLimitRecoveryTicket>((resolve, reject) => {
			const waiter: Waiter = { resolve, reject, signal };
			if (signal) {
				waiter.onAbort = () => {
					const live = this.#bucket(scope, key);
					if (live) {
						const index = live.waiters.indexOf(waiter);
						if (index >= 0) live.waiters.splice(index, 1);
						this.#advanceRecovery(scope, key, live);
					}
					reject(abortReason(signal));
				};
				signal.addEventListener("abort", waiter.onAbort, { once: true });
			}
			bucket.waiters.push(waiter);
			this.#advanceRecovery(scope, key, bucket);
		});
	}

	settle(ticket: ProviderRateLimitRecoveryTicket, outcome: ProviderRateLimitRecoveryOutcome, retryAfterMs = 0): void {
		if (ticket.settled) return;
		ticket.settled = true;
		const isRateLimit = outcome.type === "error" && outcome.status === 429;
		let bucket = this.#bucket(ticket.scope, ticket.key);

		if (isRateLimit) {
			bucket = this.#enterRecovery(ticket.scope, ticket.key, bucket, retryAfterMs);
			this.#clearProbeOwnership(bucket, ticket);
			this.#advanceRecovery(ticket.scope, ticket.key, bucket);
			return;
		}

		if (ticket.kind !== "probe" || !bucket) return;
		if (outcome.type === "success" && bucket.generation === ticket.generation) {
			this.#closeRecovery(ticket.scope, ticket.key, bucket);
			return;
		}
		this.#clearProbeOwnership(bucket, ticket);
		this.#advanceRecovery(ticket.scope, ticket.key, bucket);
	}

	#bucket(scope: object, key: string): Bucket | undefined {
		return this.#buckets.get(scope)?.get(key);
	}

	#enterRecovery(scope: object, key: string, bucket: Bucket | undefined, retryAfterMs: number): Bucket {
		let live = bucket;
		if (!live) {
			const byModel = this.#buckets.get(scope) ?? new Map<string, Bucket>();
			if (!this.#buckets.has(scope)) this.#buckets.set(scope, byModel);
			live = { generation: 0, deadline: this.#clock.now(), probeInFlight: false, waiters: [] };
			byModel.set(key, live);
		}
		live.generation += 1;
		live.deadline = Math.max(live.deadline, this.#clock.now() + delayOrZero(retryAfterMs));
		if (live.timer !== undefined) this.#clock.clearTimeout(live.timer);
		const generation = live.generation;
		live.timer = this.#clock.setTimeout(
			() => this.#onTimer(scope, key, live, generation),
			timeoutDelay(live.deadline - this.#clock.now()),
		);
		return live;
	}

	#onTimer(scope: object, key: string, bucket: Bucket, generation: number): void {
		if (this.#bucket(scope, key) !== bucket || bucket.generation !== generation) return;
		bucket.timer = undefined;
		const remaining = bucket.deadline - this.#clock.now();
		if (remaining > 0) {
			bucket.timer = this.#clock.setTimeout(
				() => this.#onTimer(scope, key, bucket, generation),
				timeoutDelay(remaining),
			);
			return;
		}
		this.#advanceRecovery(scope, key, bucket);
	}

	#advanceRecovery(scope: object, key: string, bucket: Bucket): void {
		if (this.#bucket(scope, key) !== bucket || bucket.probeInFlight || this.#clock.now() < bucket.deadline) return;
		const waiter = bucket.waiters.shift();
		if (!waiter) return;
		if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
		waiter.resolve(this.#admitProbe(scope, key, bucket));
	}

	#admitProbe(scope: object, key: string, bucket: Bucket): ProviderRateLimitRecoveryTicket {
		bucket.probeInFlight = true;
		bucket.probeGeneration = bucket.generation;
		return this.#ticket(scope, key, "probe", bucket.generation);
	}

	#clearProbeOwnership(bucket: Bucket, ticket: ProviderRateLimitRecoveryTicket): void {
		if (bucket.probeInFlight && bucket.probeGeneration === ticket.generation) {
			bucket.probeInFlight = false;
			bucket.probeGeneration = undefined;
		}
	}

	#closeRecovery(scope: object, key: string, bucket: Bucket): void {
		if (bucket.timer !== undefined) this.#clock.clearTimeout(bucket.timer);
		const byModel = this.#buckets.get(scope);
		byModel?.delete(key);
		if (byModel?.size === 0) this.#buckets.delete(scope);
		for (const waiter of bucket.waiters.splice(0)) {
			if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
			if (!waiter.signal?.aborted) waiter.resolve(this.#ticket(scope, key, "healthy", 0));
			else waiter.reject(abortReason(waiter.signal));
		}
	}

	#ticket(scope: object, key: string, kind: "healthy" | "probe", generation: number): ProviderRateLimitRecoveryTicket {
		return { scope, key, kind, generation, settled: false };
	}
}
