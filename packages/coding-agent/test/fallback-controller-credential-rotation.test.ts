import { describe, expect, it } from "bun:test";

import { FallbackChainController } from "../src/session/fallback-chain-controller";

/**
 * Pins the precondition of `restorePreviousEntryForRetry()`.
 *
 * `#handleRetryableError` calls it when a credential rotation should keep the
 * session on the SAME model instead of advancing the chain. The helper rewinds
 * to `activeIndex - 1` unconditionally, so calling it while the controller has
 * NOT advanced silently desynchronizes controller accounting from the session's
 * live model: attempts get charged to one entry while requests go to another,
 * and sticky resolution can later revert to the wrong model.
 */
describe("FallbackChainController — credential-rotation restore precondition", () => {
	const chain = (entries: string[]) =>
		new FallbackChainController({ role: "default", entries, origin: "modelRoles", explicitHead: true }, 3);

	it("refuses to rewind while still on the first entry", () => {
		const controller = chain(["a/one", "b/two"]);
		expect(controller.activeIndex).toBe(0);
		// Nothing to rewind to: a rotation here must not move the controller.
		expect(controller.restorePreviousEntryForRetry()).toBe(false);
		expect(controller.activeIndex).toBe(0);
		expect(controller.currentSelector()).toBe("a/one");
	});

	it("rewinds exactly one entry after the controller actually advanced", () => {
		const controller = chain(["a/one", "b/two"]);
		controller.onAttemptStarted();
		expect(controller.onAttemptFailure("quota", "one exhausted")).toBe("retry");
		controller.onAttemptStarted();
		expect(controller.onAttemptFailure("quota", "one exhausted")).toBe("retry");
		controller.onAttemptStarted();
		expect(controller.onAttemptFailure("quota", "one exhausted")).toBe("advance");
		expect(controller.activeIndex).toBe(1);

		expect(controller.restorePreviousEntryForRetry()).toBe(true);
		expect(controller.activeIndex).toBe(0);
		expect(controller.currentSelector()).toBe("a/one");
	});

	it("refuses to rewind twice, which is the case the caller must not ignore", () => {
		// Drives the caller invariant: after an entry's restore budget is consumed,
		// a LATER rotation gets `false` back. A caller that assumed success would
		// force a same-model retry while `activeIndex` stays on the next entry —
		// exactly the desynchronization `#handleRetryableError` now guards against
		// by branching on this boolean instead of discarding it.
		const controller = chain(["a/one", "b/two", "c/three"]);
		const failUntilAdvance = (reason: string) => {
			// `restorePreviousEntryForRetry()` leaves the restored entry with exactly
			// one attempt left, so a fixed loop count would spill extra failures onto
			// the NEXT entry and stop exercising the case under test. Drive to the
			// advance boundary instead.
			for (let guard = 0; guard < 10; guard++) {
				controller.onAttemptStarted();
				if (controller.onAttemptFailure("quota", reason) === "advance") return true;
			}
			return false;
		};

		expect(failUntilAdvance("one exhausted")).toBe(true);
		expect(controller.currentSelector()).toBe("b/two");
		expect(controller.restorePreviousEntryForRetry()).toBe(true);
		expect(controller.currentSelector()).toBe("a/one");

		// The restored entry has one attempt left. Spending it advances again, and
		// the entry's per-entry restore budget is now consumed.
		expect(failUntilAdvance("one exhausted again")).toBe(true);
		expect(controller.currentSelector()).toBe("b/two");
		expect(controller.restorePreviousEntryForRetry()).toBe(false);
		// The controller did NOT move. A caller that forced a same-model retry here
		// would request a model the controller is no longer positioned on.
		expect(controller.currentSelector()).toBe("b/two");
	});

	it("never rewinds more than one entry per successful restore", () => {
		const controller = chain(["a/one", "b/two", "c/three"]);
		for (let attempt = 0; attempt < 3; attempt++) {
			controller.onAttemptStarted();
			controller.onAttemptFailure("quota", "one");
		}
		expect(controller.activeIndex).toBe(1);
		expect(controller.restorePreviousEntryForRetry()).toBe(true);
		expect(controller.activeIndex).toBe(0);
	});

	it("restores each entry at most once, so rotation cannot loop the chain", () => {
		const controller = chain(["a/one", "b/two"]);
		controller.onAttemptStarted();
		controller.onAttemptFailure("quota", "x");
		controller.onAttemptStarted();
		controller.onAttemptFailure("quota", "x");
		controller.onAttemptStarted();
		expect(controller.onAttemptFailure("quota", "x")).toBe("advance");

		expect(controller.restorePreviousEntryForRetry()).toBe(true);
		// Second restore of the same entry is refused; a rotating credential pool
		// therefore cannot consume attempts reserved for downstream entries.
		expect(controller.restorePreviousEntryForRetry()).toBe(false);
	});
});
