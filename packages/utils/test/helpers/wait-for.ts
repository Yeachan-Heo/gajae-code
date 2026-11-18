/**
 * Polling helpers shared by async test suites. Each suite passes its own timing
 * knobs explicitly: the poll interval and timeout are flake-avoidance guarantees,
 * not defaults worth guessing.
 */

export interface WaitForOptions {
	/** Label included in the timeout error. */
	label?: string;
	/** Poll interval; suites pick a value that stays stable under load. */
	intervalMs?: number;
	/** Deadline clock; defaults to `Date.now`. */
	clock?: () => number;
	/** Interval timer; defaults to `Bun.sleep`. */
	sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> => Bun.sleep(ms);

/** Polls `predicate` until it returns true or the deadline passes, then throws. */
export async function waitForCondition(
	predicate: () => boolean | Promise<boolean>,
	timeoutMs: number,
	options: WaitForOptions = {},
): Promise<void> {
	const { label = "condition", intervalMs = 10, clock = Date.now, sleep = defaultSleep } = options;
	const deadline = clock() + timeoutMs;
	while (clock() < deadline) {
		if (await predicate()) return;
		await sleep(intervalMs);
	}
	throw new Error(`Timed out waiting for ${label}`);
}

/** Polls `check` until it returns true and returns its final verdict. */
export async function waitForCheck(
	check: () => Promise<boolean>,
	timeoutMs: number,
	options: WaitForOptions = {},
): Promise<boolean> {
	const { intervalMs = 20, clock = Date.now, sleep = defaultSleep } = options;
	const deadline = clock() + timeoutMs;
	while (clock() < deadline) {
		if (await check()) return true;
		await sleep(intervalMs);
	}
	return check();
}

/** Retries a throwing assertion until it passes, rethrowing the last failure on timeout. */
export async function retryUntil(
	assertion: () => Promise<void> | void,
	timeoutMs: number,
	options: WaitForOptions = {},
): Promise<void> {
	const { intervalMs = 20, clock = Date.now, sleep = defaultSleep } = options;
	const start = clock();
	let lastError: unknown;
	while (clock() - start < timeoutMs) {
		try {
			await assertion();
			return;
		} catch (error) {
			lastError = error;
		}
		await sleep(intervalMs);
	}
	throw lastError;
}

/** Drains `attempts` microtask turns until `condition` holds; for timer-free render assertions. */
export async function waitForMicrotasks(condition: () => boolean, attempts: number, message: string): Promise<void> {
	for (let attempt = 0; attempt < attempts; attempt++) {
		if (condition()) return;
		await Promise.resolve();
	}
	throw new Error(message);
}
