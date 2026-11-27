import { afterEach, describe, expect, it, vi } from "bun:test";
import { HindsightSessionState } from "@gajae-code/coding-agent/hindsight/state";

describe("Hindsight recall stale generation regression", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("invalidateOutstandingRecall prevents stale recalls from writing state", async () => {
		// Regression test for PR #7048 Finding #2:
		// A pending Hindsight recall must not write state if invalidateOutstandingRecall()
		// is called before the recall completes.
		//
		// The invalidation works by:
		// 1. Starting a recall and capturing its pending promise
		// 2. Calling invalidateOutstandingRecall() which resets the pending state
		// 3. When recall completes, it should not update the state

		const state = new HindsightSessionState({
			sessionId: "test-invalidate-recall",
			client: {} as any,
			bankId: "test-bank",
			config: {
				autoRecall: true,
				mentalModelsEnabled: false,
				recallContextTurns: 3,
				recallMaxQueryChars: 2000,
			} as any,
			session: {
				sessionManager: {
					getEntries: () => [
						{
							id: "e0",
							parentId: null,
							timestamp: new Date(0).toISOString(),
							type: "message" as const,
							message: {
								role: "user" as const,
								content: "test message",
								timestamp: 0,
							},
						},
					],
					getCwd: () => "/tmp",
					getSessionFile: () => null,
					getSessionId: () => "test-invalidate-recall",
				},
			} as any,
			missionsSet: new Set(),
		});

		// Before starting: state should be clean
		expect(state.hasRecalledForFirstTurn).toBe(false);
		expect(state.getRecallSnippet()).toBeUndefined();

		// Create a deferred recall promise
		const recallPromise = Promise.withResolvers<{ context: string; ok: boolean }>();
		vi.spyOn(state, "recallForContext" as any).mockReturnValue(recallPromise.promise);

		// Step 1: Start a recall
		const recallPromiseHandle = state.maybeRecallOnAgentStart();

		// Give the recall a moment to start
		await Bun.sleep(10);

		// Step 2: Invalidate the outstanding recall
		// This should prevent the pending recall from writing state
		state.invalidateOutstandingRecall();

		// Step 3: Resolve the now-invalidated recall with legitimate data
		// The critical behavior is that this data should NOT be written to state
		recallPromise.resolve({ context: "INVALIDATED_CONTEXT", ok: true });

		// Wait for the recall promise to settle
		await recallPromiseHandle;

		// Step 4: Verify the invalidated recall did NOT write state
		// This is the key assertion: even though the recall completed with data,
		// invalidateOutstandingRecall prevents it from being written
		expect(state.hasRecalledForFirstTurn).toBe(false);
		expect(state.getRecallSnippet()).toBeUndefined();
	});
});
