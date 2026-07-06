export type AnimationCadence = 16 | 80;

type TimerHandle = ReturnType<typeof setInterval>;
type AnimationCallback = (now: number) => void;

interface CadenceBucket {
	callbacks: Set<AnimationCallback>;
	timer?: TimerHandle;
	startedTimers: number;
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
	reset(): void {
		for (const bucket of buckets.values()) {
			stopBucket(bucket);
			bucket.callbacks.clear();
			bucket.startedTimers = 0;
		}
	},
};
