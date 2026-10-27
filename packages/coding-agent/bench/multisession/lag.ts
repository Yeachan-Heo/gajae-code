export const LAG_INTERVAL_MS = 100;

/**
 * Event-loop lag from a repeating timer: each sample is how late one tick fired
 * relative to the previous tick plus the interval. Measuring per interval keeps
 * a single stall from shifting every later sample, unlike a fixed schedule from
 * the start time, which accumulates the timer's ordinary per-tick drift.
 */
export class LagSampler {
	readonly samplesMs: number[] = [];
	#lastTickAt: number;

	constructor(startedAt: number) {
		this.#lastTickAt = startedAt;
	}

	tick(now: number): void {
		this.samplesMs.push(Math.max(0, now - this.#lastTickAt - LAG_INTERVAL_MS));
		this.#lastTickAt = now;
	}
}
