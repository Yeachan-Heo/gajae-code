import { afterEach, describe, expect, it, vi } from "bun:test";
import { HindsightSessionState } from "@gajae-code/coding-agent/hindsight/state";

describe("Hindsight recall stale generation regression", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("fences stale recall writes after session reset - generation mismatch prevents state write", async () => {
		// Regression test for PR #7048 Finding #1:
		// A pending Hindsight recall from generation N must not write state
		// if the session/generation changes to M before the recall completes.
		//
		// The fence works by:
		// 1. Capturing the generation when recall starts: this.#recallGeneration = generation
		// 2. When recall completes, checking: if (generation !== undefined && this.#recallGeneration !== generation) return;
		// 3. When session resets, clearing the fence: this.#recallGeneration = undefined;

		// Create a minimal HindsightSessionState for testing
		const state = new HindsightSessionState({
			sessionId: "test-gen-fence",
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
					getSessionId: () => "test-gen-fence",
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

		// Step 1: Start recall with generation 1
		// This sets this.#recallGeneration = 1
		const generation1 = 1;
		const recall1Promise = state.maybeRecallOnAgentStart(generation1);

		// Give the recall a moment to capture the generation
		await Bun.sleep(10);

		// Step 2: Reset the conversation tracking
		// This clears the generation fence: this.#recallGeneration = undefined
		state.resetConversationTracking();

		// Step 3: Resolve the stale recall
		// When the promise resolves, maybeRecallOnAgentStart will:
		// - Extract context: { context: "STALE", ok: true }
		// - Check the fence: if (generation !== undefined && this.#recallGeneration !== generation)
		//   - generation = 1 (not undefined)
		//   - this.#recallGeneration = undefined (was cleared)
		//   - undefined !== 1 is true, so we RETURN early without writing state
		recallPromise.resolve({ context: "STALE_CONTEXT", ok: true });

		// Wait for the recall to complete
		await recall1Promise;

		// Step 4: Verify the stale recall did NOT write state
		// This is the key assertion: with the fix, the fence prevents the write
		expect(state.hasRecalledForFirstTurn).toBe(false);
		expect(state.getRecallSnippet()).toBeUndefined();
	});

	it("allows legitimate recalls to write state when generation matches", async () => {
		// Verify that the fence doesn't prevent legitimate recalls
		// i.e., when the session/generation doesn't change

		const state = new HindsightSessionState({
			sessionId: "test-gen-match",
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
					getSessionId: () => "test-gen-match",
				},
			} as any,
			missionsSet: new Set(),
		});

		// Create a deferred recall promise
		const recallPromise = Promise.withResolvers<{ context: string; ok: boolean }>();
		vi.spyOn(state, "recallForContext" as any).mockReturnValue(recallPromise.promise);

		// Call with generation 1, and keep it unchanged (no reset)
		const generation1 = 1;
		const recall1Promise = state.maybeRecallOnAgentStart(generation1);

		await Bun.sleep(10);

		// Resolve with legitimate data WITHOUT changing the generation
		recallPromise.resolve({ context: "LEGITIMATE_CONTEXT", ok: true });

		// Wait for completion
		await recall1Promise;

		// Verify state WAS written (generation didn't change)
		expect(state.hasRecalledForFirstTurn).toBe(true);
		expect(state.getRecallSnippet()).toBe("LEGITIMATE_CONTEXT");
	});

	it("prevents stale recalls in old code: demonstrates the old code would have a bug", async () => {
		// This test documents what would happen with the old code (87fda1075d)
		// where maybeRecallOnAgentStart had NO generation parameter and NO fence check.
		//
		// In the old code:
		// - async maybeRecallOnAgentStart(): Promise<void> { ... }
		// - No #recallGeneration field
		// - No fence check: just writes state after recall completes
		//
		// The old code would ALWAYS write state when recall succeeds, even if
		// the session has changed. This is the bug.
		//
		// With the new code:
		// - async maybeRecallOnAgentStart(generation?: number): Promise<void> { ... }
		// - #recallGeneration captures the generation
		// - Fence check prevents writes: if (generation !== undefined && this.#recallGeneration !== generation) return;
		//
		// This test verifies the fence works by showing that:
		// 1. When generation matches: state is written ✓
		// 2. When generation changes (reset): state is NOT written ✓ (the fix)

		const state = new HindsightSessionState({
			sessionId: "test-gen-old-code",
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
					getSessionId: () => "test-gen-old-code",
				},
			} as any,
			missionsSet: new Set(),
		});

		// Deferred recall promise
		const recallPromise1 = Promise.withResolvers<{ context: string; ok: boolean }>();
		const recallPromise2 = Promise.withResolvers<{ context: string; ok: boolean }>();

		let recallCount = 0;
		vi.spyOn(state, "recallForContext" as any).mockImplementation(async () => {
			recallCount++;
			if (recallCount === 1) return recallPromise1.promise;
			return recallPromise2.promise;
		});

		// Scenario: Generation 1 starts a recall
		const gen1Promise = state.maybeRecallOnAgentStart(1);
		await Bun.sleep(10);

		// Session reset happens (generation fence cleared)
		state.resetConversationTracking();

		// Stale recall from gen 1 completes
		recallPromise1.resolve({ context: "STALE_FROM_GEN_1", ok: true });
		await gen1Promise;

		// Stale recall should NOT have written state
		expect(state.hasRecalledForFirstTurn).toBe(false);
		expect(state.getRecallSnippet()).toBeUndefined();

		// Now generation 2 starts (after the session change)
		const gen2Promise = state.maybeRecallOnAgentStart(2);
		await Bun.sleep(10);

		// Gen 2's recall completes with legitimate data
		recallPromise2.resolve({ context: "LEGITIMATE_FROM_GEN_2", ok: true });
		await gen2Promise;

		// Gen 2's recall SHOULD have written state
		expect(state.hasRecalledForFirstTurn).toBe(true);
		expect(state.getRecallSnippet()).toBe("LEGITIMATE_FROM_GEN_2");
	});
});
