/**
 * The strict seam for suites that gate on the write-path detector (single-owner design §7.4 G1:
 * zero `session_write_without_claim` in the strict-seam tests).
 *
 * The strict throw is not enough on its own: where the check sits inside a `try` that turns errors
 * into outcomes, the throw becomes a failed outcome and the test can still pass. The counter cannot
 * be swallowed, so each test's counter delta must equal the detections it declared (zero unless it
 * calls `expectStrictDetections`). Register it inside the suite's `describe`, so its `afterEach`
 * reads the counter before a file-level `afterEach` resets ownership state.
 */
import { afterEach, beforeEach, expect } from "bun:test";
import { SessionOwnershipTestHooks, sessionOwnershipCounters } from "../../src/session/session-ownership";

let baseline = 0;
let declared = 0;

function detections(): number {
	return sessionOwnershipCounters().session_write_without_claim - baseline;
}

/** Declare detections this test causes on purpose; the `afterEach` check then expects exactly that many. */
export function expectStrictDetections(count: number): void {
	declared += count;
}

/** Detections so far in this test that it did not declare. */
export function undeclaredStrictDetections(): number {
	return detections() - declared;
}

/** Build a fixture outside the strict seam; the detections it causes are not counted. */
export async function outsideStrictSeam<T>(setup: () => Promise<T>): Promise<T> {
	const strict = SessionOwnershipTestHooks.strictWriteDetection;
	delete SessionOwnershipTestHooks.strictWriteDetection;
	const before = sessionOwnershipCounters().session_write_without_claim;
	try {
		return await setup();
	} finally {
		baseline += sessionOwnershipCounters().session_write_without_claim - before;
		if (strict === undefined) delete SessionOwnershipTestHooks.strictWriteDetection;
		else SessionOwnershipTestHooks.strictWriteDetection = strict;
	}
}

/**
 * Turn the strict seam on for each test of the enclosing `describe`. `settle` runs before the
 * counter is read, so writes a test leaves for close (rewrite debt) are counted too.
 */
export function useStrictWriteDetection(settle?: () => Promise<void>): void {
	beforeEach(() => {
		SessionOwnershipTestHooks.strictWriteDetection = true;
		baseline = sessionOwnershipCounters().session_write_without_claim;
		declared = 0;
	});
	afterEach(async () => {
		try {
			await settle?.();
		} finally {
			delete SessionOwnershipTestHooks.strictWriteDetection;
		}
		expect(detections()).toBe(declared);
	});
}
