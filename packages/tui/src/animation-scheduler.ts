export type AnimationCadence = 16 | 80;

type TimerHandle = ReturnType<typeof setInterval>;
type AnimationCallback = (now: number) => void;

interface CadenceBucket {
	callbacks: Set<AnimationCallback>;
	timer?: TimerHandle;
	startedTimers: number;
}

// Animation ticks are decorative. When the output sink cannot keep up — a
// remote terminal over SSH, a multiplexer, a slow pipe — those frames are not
// merely wasted, they queue. Bun buffers whatever `write()` could not hand to
// the OS, so the renderer runs ahead of the wire and the user watches a backlog
// drain instead of the current frame.
//
// Dropping a decorative tick loses nothing: the next one redraws from live state.
// Skipping is therefore always safe here, and must never be extended to renders
// that carry content, which the diff renderer must still emit in order.
const DEFAULT_CONGESTION_THRESHOLD_BYTES = 64 * 1024;

let bufferedOutputBytesProbe: (() => number | undefined) | undefined;
let skippedTicks = 0;

function outputIsCongested(): boolean {
	const stdout = globalThis.process?.stdout as { writableLength?: number } | undefined;
	const buffered = bufferedOutputBytesProbe ? bufferedOutputBytesProbe() : stdout?.writableLength;
	// A healthy TTY drains synchronously and reports 0 here, so this is a no-op
	// locally and only engages once bytes are genuinely stuck.
	return typeof buffered === "number" && buffered > DEFAULT_CONGESTION_THRESHOLD_BYTES;
}

const buckets = new Map<AnimationCadence, CadenceBucket>();

function getBucket(cadence: AnimationCadence): CadenceBucket {
	let bucket = buckets.get(cadence);
	if (!bucket) {
		bucket = { callbacks: new Set(), startedTimers: 0 };
		buckets.set(cadence, bucket);
	}
	return bucket;
}

function startBucket(cadence: AnimationCadence, bucket: CadenceBucket): void {
	if (bucket.timer) return;
	bucket.timer = setInterval(() => {
		// Skip the whole tick, not each callback: the decision is about the shared
		// output sink, so sampling it once keeps every registrant on the same frame.
		if (outputIsCongested()) {
			skippedTicks += 1;
			return;
		}
		const now = performance.now();
		// Snapshot so re-entrant register/unregister during a tick is safe, and
		// isolate each callback so one throwing registrant cannot starve siblings
		// or surface as an uncaught exception that kills the shared timer.
		for (const callback of [...bucket.callbacks]) {
			try {
				callback(now);
			} catch (err) {
				console.error("[animation-scheduler] callback threw:", err);
			}
		}
	}, cadence);
	bucket.startedTimers += 1;
	bucket.timer?.unref?.();
}

function stopBucket(bucket: CadenceBucket): void {
	if (!bucket.timer) return;
	clearInterval(bucket.timer);
	bucket.timer = undefined;
}

export interface AnimationRegistration {
	unregister(): void;
}

export function registerAnimationCallback(
	callback: AnimationCallback,
	cadence: AnimationCadence = 80,
): AnimationRegistration {
	const bucket = getBucket(cadence);
	bucket.callbacks.add(callback);
	startBucket(cadence, bucket);
	let registered = true;

	return {
		unregister(): void {
			if (!registered) return;
			registered = false;
			bucket.callbacks.delete(callback);
			if (bucket.callbacks.size === 0) stopBucket(bucket);
		},
	};
}

export const __animationSchedulerTestHooks = {
	getActiveTimerCount(cadence?: AnimationCadence): number {
		if (cadence !== undefined) return getBucket(cadence).timer ? 1 : 0;
		let count = 0;
		for (const bucket of buckets.values()) {
			if (bucket.timer) count += 1;
		}
		return count;
	},
	getRegistrantCount(cadence?: AnimationCadence): number {
		if (cadence !== undefined) return getBucket(cadence).callbacks.size;
		let count = 0;
		for (const bucket of buckets.values()) count += bucket.callbacks.size;
		return count;
	},
	getStartedTimerCount(cadence?: AnimationCadence): number {
		if (cadence !== undefined) return getBucket(cadence).startedTimers;
		let count = 0;
		for (const bucket of buckets.values()) count += bucket.startedTimers;
		return count;
	},
	getSkippedTickCount(): number {
		return skippedTicks;
	},
	getCongestionThresholdBytes(): number {
		return DEFAULT_CONGESTION_THRESHOLD_BYTES;
	},
	setBufferedOutputBytesProbe(probe: (() => number | undefined) | undefined): void {
		bufferedOutputBytesProbe = probe;
	},
	reset(): void {
		for (const bucket of buckets.values()) {
			stopBucket(bucket);
			bucket.callbacks.clear();
			bucket.startedTimers = 0;
		}
		skippedTicks = 0;
		bufferedOutputBytesProbe = undefined;
	},
};
