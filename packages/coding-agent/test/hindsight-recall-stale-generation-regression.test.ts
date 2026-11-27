import { afterEach, describe, expect, it, vi } from "bun:test";
import { HindsightSessionState } from "@gajae-code/coding-agent/hindsight/state";

describe("Hindsight recall stale generation regression", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("fences stale recall writes after session reset - epoch mismatch prevents state write", async () => {
		// Regression test for PR #7048 Finding #1:
		// A pending Hindsight recall from epoch N must not write state
		// if resetConversationTracking is called (incrementing the epoch) before the recall completes.
		//
		// The fence works by:
		// 1. Capturing the epoch when recall starts: const epoch = this.#conversationEpoch
		// 2. When recall completes, checking: if (this.#conversationEpoch !== epoch) return;
		// 3. When session resets, incrementing the fence: this.#conversationEpoch++

		// Create a minimal HindsightSessionState for testing
		const state = new HindsightSessionState({
			sessionId: "test-epoch-fence",
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
					getSessionId: () => "test-epoch-fence",
				},
			} as any,
			missionsSet: new Set(),
		});

		// Before starting: state should be clean
		expect(state.hasRecalledForFirstTurn).toBe(false);
		expect(state.getRecallSnippet()).toBeUndefined();

		// Create a deferred recall promise that we control
		const recallPromise = Promise.withResolvers<{ context: string; ok: boolean }>();

		// Spy on recallForContext to return our deferred promise
		vi.spyOn(state, "recallForContext" as any).mockReturnValue(recallPromise.promise);

		// Step 1: Start recall at epoch 0
		// This captures: const epoch = this.#conversationEpoch (epoch = 0)
		const recall1Promise = state.maybeRecallOnAgentStart();

		// Give the recall a moment to capture the epoch
		await Bun.sleep(10);

		// Step 2: Reset the conversation tracking
		// This increments the epoch: this.#conversationEpoch++ (now 1)
		state.resetConversationTracking();

		// Step 3: Resolve the stale recall
		// When the promise resolves, maybeRecallOnAgentStart will:
		// - Extract context: { context: "STALE", ok: true }
		// - Check the fence: if (this.#conversationEpoch !== epoch)
		//   - this.#conversationEpoch = 1 (was incremented)
		//   - epoch = 0 (captured at start)
		//   - 1 !== 0 is true, so we RETURN early without writing state
		recallPromise.resolve({ context: "STALE_CONTEXT", ok: true });

		// Wait for the recall to complete
		await recall1Promise;

		// Step 4: Verify the stale recall did NOT write state
		// This is the key assertion: with the fix, the fence prevents the write
		expect(state.hasRecalledForFirstTurn).toBe(false);
		expect(state.getRecallSnippet()).toBeUndefined();
	});

	it("allows legitimate recalls to write state when epoch is stable", async () => {
		// Verify that the fence doesn't prevent legitimate recalls
		// i.e., when resetConversationTracking is not called

		const state = new HindsightSessionState({
			sessionId: "test-epoch-match",
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
					getSessionId: () => "test-epoch-match",
				},
			} as any,
			missionsSet: new Set(),
		});

		// Create a deferred recall promise
		const recallPromise = Promise.withResolvers<{ context: string; ok: boolean }>();
		vi.spyOn(state, "recallForContext" as any).mockReturnValue(recallPromise.promise);

		// Call maybeRecallOnAgentStart at epoch 0
		const recall1Promise = state.maybeRecallOnAgentStart();

		await Bun.sleep(10);

		// Resolve with legitimate data WITHOUT changing the epoch
		recallPromise.resolve({ context: "LEGITIMATE_CONTEXT", ok: true });

		// Wait for completion
		await recall1Promise;

		// Verify state WAS written (epoch didn't change)
		expect(state.hasRecalledForFirstTurn).toBe(true);
		expect(state.getRecallSnippet()).toBe("LEGITIMATE_CONTEXT");
	});

	it("prevents stale recalls by using epoch-based fencing", async () => {
		// This test verifies the new epoch-based fence implementation.
		// It demonstrates that stale recalls from an old epoch are blocked
		// while new recalls after a reset can proceed normally.

		const state = new HindsightSessionState({
			sessionId: "test-epoch-transition",
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
								content: "initial user message",
								timestamp: 0,
							},
						},
					],
					getCwd: () => "/tmp",
					getSessionFile: () => null,
					getSessionId: () => "test-epoch-transition",
				},
			} as any,
			missionsSet: new Set(),
		});

		// Deferred recall promises
		const recallPromise1 = Promise.withResolvers<{ context: string; ok: boolean }>();
		const recallPromise2 = Promise.withResolvers<{ context: string; ok: boolean }>();

		let recallCount = 0;
		vi.spyOn(state, "recallForContext" as any).mockImplementation(async () => {
			recallCount++;
			if (recallCount === 1) return recallPromise1.promise;
			return recallPromise2.promise;
		});

		// Scenario: Epoch 0 starts a recall
		const epoch0Promise = state.maybeRecallOnAgentStart();
		await Bun.sleep(10);

		// Session reset happens (epoch incremented to 1)
		state.resetConversationTracking();

		// Stale recall from epoch 0 completes
		recallPromise1.resolve({ context: "STALE_FROM_EPOCH_0", ok: true });
		await epoch0Promise;

		// Stale recall should NOT have written state
		expect(state.hasRecalledForFirstTurn).toBe(false);
		expect(state.getRecallSnippet()).toBeUndefined();

		// Now epoch 1 starts (after the reset)
		const epoch1Promise = state.maybeRecallOnAgentStart();
		await Bun.sleep(10);

		// Epoch 1's recall completes with legitimate data
		recallPromise2.resolve({ context: "LEGITIMATE_FROM_EPOCH_1", ok: true });
		await epoch1Promise;

		// Epoch 1's recall SHOULD have written state
		expect(state.hasRecalledForFirstTurn).toBe(true);
		expect(state.getRecallSnippet()).toBe("LEGITIMATE_FROM_EPOCH_1");
	});
});
