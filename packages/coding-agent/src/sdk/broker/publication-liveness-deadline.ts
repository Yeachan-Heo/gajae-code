/**
 * Pure deadline for the off-thread publication watchdog.
 *
 * The JS interval in {@link Broker.#watchPublication} already exits on this
 * same grace, but only when the event loop can run. A discovery fsync/rename
 * that never returns to that loop leaves the interval queued behind the
 * syscall. This predicate is evaluated from a worker that does not share the
 * stalled call: publication age is the liveness deadline, and loop age is the
 * proof the JS watchdog is still being scheduled. A fresh loop keeps the
 * graceful in-process exit; a loop that has also stopped is the blocked-thread
 * case and must be killed.
 */
export const PUBLICATION_LIVENESS_SLOT_COUNT = 128;
export const PUBLICATION_LIVENESS_SLOT_STRIDE = 5;
export const PUBLICATION_LIVENESS_INDEX_PUBLISHED = 0;
export const PUBLICATION_LIVENESS_INDEX_LOOP = 1;
export const PUBLICATION_LIVENESS_INDEX_GRACE = 2;
export const PUBLICATION_LIVENESS_INDEX_CADENCE = 3;
export const PUBLICATION_LIVENESS_INDEX_ACTIVE = 4;
/** Slot is visible to the worker. */
export const PUBLICATION_LIVENESS_ACTIVE = 1n;
/** Slot is reserved while its timestamps are being published. */
export const PUBLICATION_LIVENESS_CLAIMING = 2n;

export interface PublicationLivenessSample {
	nowMs: bigint;
	publishedMs: bigint;
	loopMs: bigint;
	graceMs: bigint;
	cadenceMs: bigint;
	active: bigint;
}

/**
 * Hard-kill switch. Production leaves it unset and arms the watchdog. The test
 * runner sets `BUN_ENV=test` / `NODE_ENV=test`, where a false kill would take
 * down the runner, so the watchdog stays disarmed unless a child opts in.
 * That opt-out is the only startup path that may succeed without a worker.
 * When this is enabled, failing to arm the worker rejects broker startup.
 */
export function publicationLivenessHardExitEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const flag = env.GJC_BROKER_LIVENESS_HARD_EXIT;
	if (flag === "0") return false;
	if (flag === "1") return true;
	return env.BUN_ENV !== "test" && env.NODE_ENV !== "test";
}

export function publicationLivenessMustExit(sample: PublicationLivenessSample): boolean {
	if (sample.active !== PUBLICATION_LIVENESS_ACTIVE) return false;
	if (sample.graceMs <= 0n || sample.publishedMs <= 0n || sample.loopMs <= 0n) return false;
	const publicationAge = sample.nowMs - sample.publishedMs;
	const loopAge = sample.nowMs - sample.loopMs;
	if (publicationAge < 0n || loopAge < 0n) return false;
	if (publicationAge < sample.graceMs) return false;
	const cadence = sample.cadenceMs > 0n ? sample.cadenceMs : sample.graceMs;
	const loopStuck = cadence * 4n;
	const loopLimit = loopStuck < sample.graceMs ? loopStuck : sample.graceMs;
	return loopAge >= loopLimit;
}
