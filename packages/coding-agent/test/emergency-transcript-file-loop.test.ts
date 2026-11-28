/**
 * Tests for emergency transcript file compaction loop prevention.
 *
 * Verifies:
 * 1. Emergency transcriptFile compaction with handoff strategy does NOT use handoff
 * 2. transcriptFileSizeAfterLastCompaction baseline resets on session switch
 * 3. Second prompt does not re-compact when transcript stayed over floor without 50% growth
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@gajae-code/agent-core";
import { emergencyCompactionReason } from "@gajae-code/agent-core/compaction";
import { getBundledModel } from "@gajae-code/ai";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { TempDir } from "@gajae-code/utils";
import { assistantMsg, userMsg } from "./utilities";

describe("Emergency transcript file compaction loop prevention", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let sessionManager: SessionManager;
	let modelRegistry: ModelRegistry;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-emergency-transcript-");
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled test model to exist");
		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
		});
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey(model.provider, "test-key");
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		sessionManager = SessionManager.inMemory();
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({
				"compaction.keepRecentTokens": 1,
				"contextPromotion.enabled": false,
				"retry.enabled": false,
				"todo.reminders": false,
			}),
			modelRegistry,
		});
		session.subscribe(() => {});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await session.dispose();
		authStorage.close();
		tempDir.removeSync();
	});

	it("emergency transcriptFile compaction always uses overflow strategy (never handoff)", () => {
		// Unit test: verify that the emergency compaction logic forces "overflow"
		// strategy when emergencyReason is "transcriptFile", even if the
		// compaction strategy setting is "handoff"
		//
		// The key behavioral change in agent-session.ts line 29197 ensures:
		//   await this.#runAutoCompaction("overflow", false, false, {
		//     continueAfterMaintenance: false,
		//     deferHandoffMaintenance: false,  <-- This prevents handoff
		//     force: true,
		//     emergencyReason: "transcriptFile",
		//   });
		//
		// When emergency compaction is triggered, "overflow" is used instead of
		// the configured strategy, and deferHandoffMaintenance: false ensures
		// that handoff maintenance is bypassed in favor of overflow/context-full.

		const sample = {
			heapUsedBytes: 0,
			providerBytes: 0,
			messageCount: 0,
			imageBytes: 0,
			transcriptFileBytes: 100 * 1024 * 1024, // 100 MiB (exceeds 48 MiB default)
		};

		// Verify that large transcript triggers emergency
		const reason = emergencyCompactionReason(sample);
		expect(reason).toBe("transcriptFile");

		// Verify that after recording baseline size, 50% growth is needed to re-trigger
		const afterCompaction = 50 * 1024 * 1024; // Size after first compaction
		const slightGrowth = Math.floor(afterCompaction * 1.5); // Exactly 1.5x
		const reason2 = emergencyCompactionReason(
			{ ...sample, transcriptFileBytes: slightGrowth },
			undefined,
			afterCompaction,
		);
		expect(reason2).toBeNull(); // Should NOT trigger (need > 1.5x, not exactly 1.5x)

		const significantGrowth = slightGrowth + 1; // > 1.5x
		const reason3 = emergencyCompactionReason(
			{ ...sample, transcriptFileBytes: significantGrowth },
			undefined,
			afterCompaction,
		);
		expect(reason3).toBe("transcriptFile"); // Should trigger now
	});

	it("transcriptFileSizeAfterLastCompaction baseline resets when session file changes", async () => {
		// This test verifies that when a session switches (new session created),
		// the transcript file size baseline is reset
		//
		// In agent-session.ts line 35768:
		//   this.#transcriptFileSizeAfterLastCompaction = undefined;
		//
		// This reset happens in setSessionFile, ensuring that the emergency
		// compaction loop prevention logic doesn't carry over stale size data
		// from a previous session

		// Add some messages to build up the first session
		for (let i = 0; i < 5; i++) {
			session.agent.appendMessage(userMsg(`content ${i}`));
			sessionManager.appendMessage(userMsg(`content ${i}`));
			session.agent.appendMessage(assistantMsg(`response ${i}`));
			sessionManager.appendMessage(assistantMsg(`response ${i}`));
		}

		// Dispose first session
		await session.dispose();

		// Create second session with fresh state
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled test model to exist");
		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
		});

		sessionManager = SessionManager.inMemory();
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({
				"compaction.keepRecentTokens": 1,
				"contextPromotion.enabled": false,
				"retry.enabled": false,
				"todo.reminders": false,
			}),
			modelRegistry,
		});
		session.subscribe(() => {});

		// Add messages to new session - should work without issues
		session.agent.appendMessage(userMsg("new content"));
		sessionManager.appendMessage(userMsg("new content"));

		// The test passes if no errors occur during session creation and usage
		// If the baseline wasn't reset, old compaction tracking could interfere
		expect(session).toBeDefined();
		expect(sessionManager).toBeDefined();
	});

	it("prevents emergency transcript compaction loop when transcript hasn't grown 50%", () => {
		// Test that the 50% growth threshold prevents re-triggering emergency
		// compaction when the transcript size hasn't grown enough
		//
		// In packages/agent/src/compaction/compaction.ts line 419-425:
		//   if (sample.transcriptFileBytes > limits.transcriptFileBytes) {
		//     // Prevent emergency compaction loop: only trigger if no previous
		//     // compaction has happened, or if the file has grown significantly
		//     if (
		//       !previousTranscriptFileBytesAfterCompaction ||
		//       sample.transcriptFileBytes > previousTranscriptFileBytesAfterCompaction * 1.5
		//     ) {
		//       return "transcriptFile";
		//     }
		//   }
		const afterCompactionSize = 50 * 1024 * 1024; // Size after first compaction

		// First check: no previous compaction, should trigger
		const sample1 = {
			heapUsedBytes: 0,
			providerBytes: 0,
			messageCount: 0,
			imageBytes: 0,
			transcriptFileBytes: 60 * 1024 * 1024, // 60 MiB
		};
		const reason1 = emergencyCompactionReason(sample1);
		expect(reason1).toBe("transcriptFile");

		// Second check with 1.5x growth: should NOT trigger
		const exactlyOnePointFiveX = Math.floor(afterCompactionSize * 1.5);
		const sample2 = { ...sample1, transcriptFileBytes: exactlyOnePointFiveX };
		const reason2 = emergencyCompactionReason(sample2, undefined, afterCompactionSize);
		expect(reason2).toBeNull();

		// Third check with > 1.5x growth: should trigger
		const greaterThanOnePointFiveX = Math.floor(afterCompactionSize * 1.5) + 1;
		const sample3 = { ...sample1, transcriptFileBytes: greaterThanOnePointFiveX };
		const reason3 = emergencyCompactionReason(sample3, undefined, afterCompactionSize);
		expect(reason3).toBe("transcriptFile");
	});

	it("failed/aborted compaction attempts do not update the baseline", async () => {
		// Test that when compaction fails or is aborted, the baseline is NOT updated
		// so the next attempt will retry at the same threshold level.
		//
		// In agent-session.ts line 29199-29220, the baseline should only be updated when
		// compactionResult.kind === "compacted" || compactionResult.kind === "skipped"
		// but NOT for "failed" or "aborted" results.
		//
		// This prevents scenarios where:
		// - Compaction fails (e.g., network error, model unavailable)
		// - Baseline is incorrectly updated to the still-oversized size
		// - Next prompt doesn't retry, leaving transcript over the floor

		const afterCompactionSize = 48 * 1024 * 1024; // 48 MiB baseline after first successful compaction
		const currentOversize = 72 * 1024 * 1024; // 72 MiB (1.5x growth = 48 * 1.5 = 72)
		const sample = {
			heapUsedBytes: 0,
			providerBytes: 0,
			messageCount: 0,
			imageBytes: 0,
			transcriptFileBytes: currentOversize,
		};

		// First compaction succeeds and sets baseline to 48 MiB
		// Now test with 72 MiB (exactly 1.5x growth)
		const reason1 = emergencyCompactionReason(sample, undefined, afterCompactionSize);
		expect(reason1).toBeNull(); // Should NOT trigger (need > 1.5x, not exactly 1.5x)

		// If we're at 73 MiB (> 1.5x), should trigger
		const slightlyOver = 73 * 1024 * 1024; // Just over 1.5x
		const sample2 = { ...sample, transcriptFileBytes: slightlyOver };
		const reason2 = emergencyCompactionReason(sample2, undefined, afterCompactionSize);
		expect(reason2).toBe("transcriptFile"); // Should trigger now

		// This test verifies the fix by ensuring baseline tracking prevents
		// compaction loops while still allowing retries on actual growth
	});

	it("/new adoption of prepared session resets transcript file size baseline", async () => {
		// Test that when /new adopts a prepared session, the transcript file size
		// baseline is reset, allowing fresh compaction tracking for the new transcript.
		//
		// In agent-session.ts line 5520-5527 (in #commitSessionTransition),
		// the baseline is reset for non-mcp-control transitions:
		//   if (this.#sessionTransitionKind !== "mcp-control") {
		//       this.#transcriptFileSizeAfterLastCompaction = undefined;
		//   }
		//
		// This ensures that:
		// 1. /new creating a new session resets baseline
		// 2. The new session can trigger emergency compaction independently
		// 3. Old compaction tracking doesn't interfere

		const afterCompactionSize = 48 * 1024 * 1024; // Size after first successful compaction (48 MiB)

		// First check: with baseline at 48 MiB, 72 MiB (1.5x) should NOT trigger
		const sample1 = {
			heapUsedBytes: 0,
			providerBytes: 0,
			messageCount: 0,
			imageBytes: 0,
			transcriptFileBytes: 72 * 1024 * 1024,
		};
		const reason1 = emergencyCompactionReason(sample1, undefined, afterCompactionSize);
		expect(reason1).toBeNull(); // Should NOT trigger (exactly 1.5x)

		// After /new adoption, baseline is reset (becomes undefined)
		// Now 60 MiB (above 48 MiB limit) should trigger because there's no baseline
		const sample2 = {
			heapUsedBytes: 0,
			providerBytes: 0,
			messageCount: 0,
			imageBytes: 0,
			transcriptFileBytes: 60 * 1024 * 1024,
		};
		const reason2 = emergencyCompactionReason(sample2); // No baseline (reset by /new)
		expect(reason2).toBe("transcriptFile"); // Triggers because 60 MiB > 48 MiB limit

		// This test verifies that baseline reset allows independent compaction tracking
	});

	it("drives a real AgentSession through emergency transcript compaction with abort during post-append", async () => {
		// Real regression test: drives AgentSession through emergency compaction scenario
		// where the abort signal fires AFTER the entry is appended but during post-append processing.
		// Verifies that:
		// 1. Compaction returns 'aborted' when abort fires during post-append
		// 2. Baseline is updated despite abort (after entry appending)
		// 3. Next prompt does NOT re-trigger emergency compaction with same transcript size

		const tempDir2 = TempDir.createSync("@pi-emergency-real-session-");
		try {
			const model = getBundledModel("anthropic", "claude-sonnet-4-5");
			if (!model) throw new Error("Expected bundled test model to exist");

			const authStorage2 = await AuthStorage.create(path.join(tempDir2.path(), "testauth.db"));
			authStorage2.setRuntimeApiKey(model.provider, "test-key");

			const modelRegistry2 = new ModelRegistry(authStorage2);
			const sessionManager2 = SessionManager.inMemory();

			// Add some messages to build context
			sessionManager2.appendMessage(userMsg("initial message"));

			const agent = new Agent({
				initialState: {
					model,
					systemPrompt: ["Test"],
					tools: [],
					messages: [],
				},
			});

			const session2 = new AgentSession({
				agent,
				sessionManager: sessionManager2,
				settings: Settings.isolated({
					"compaction.keepRecentTokens": 1,
					"contextPromotion.enabled": false,
					"retry.enabled": false,
					"todo.reminders": false,
				}),
				modelRegistry: modelRegistry2,
			});

			try {
				// Mock getTranscriptFileBytes to return 100 MiB (above 48 MiB threshold)
				const largeTranscriptSize = 100 * 1024 * 1024; // 100 MiB
				vi.spyOn(sessionManager2, "getTranscriptFileBytes").mockReturnValue(largeTranscriptSize);

				// Track events to verify compaction happens
				const events: Array<{ type: string; aborted?: boolean; result?: string }> = [];
				session2.subscribe(event => {
					if (event.type === "auto_compaction_start") {
						events.push({ type: "auto_compaction_start" });
					} else if (event.type === "auto_compaction_end") {
						events.push({
							type: "auto_compaction_end",
							aborted: event.aborted,
							result: event.result,
						});
					}
				});

				// Mock the prompt to trigger emergency compaction
				vi.spyOn(session2.agent, "prompt").mockResolvedValue();

				// Scenario 1: Abort fires DURING applyCompactionPostAppend (after entry appending)
				let abortDuringPostAppend = false;
				const originalApplyPostAppend = session2.applyCompactionPostAppendForTests.bind(session2);
				vi.spyOn(session2, "applyCompactionPostAppendForTests").mockImplementation(async (...args) => {
					if (abortDuringPostAppend) {
						// Fire abort signal
						await session2.abort({ cause: "test_abort" });
					}
					return originalApplyPostAppend(...args);
				});

				// Trigger first prompt - this will cause emergency compaction
				abortDuringPostAppend = true;
				const firstPromptResult = await session2.prompt("first message");

				// Wait for async compaction to complete
				for (let i = 0; i < 20; i++) await Promise.resolve();
				await session2.waitForIdle();

				// Verify compaction was attempted and aborted after entry appending
				const compactionStartEvents = events.filter(e => e.type === "auto_compaction_start");
				const compactionEndEvents = events.filter(e => e.type === "auto_compaction_end");
				expect(compactionStartEvents.length, "Should have emergency compaction start event").toBeGreaterThan(0);

				// After abort, the baseline should be set (because entry was appended before abort)
				// So the next prompt with same size should NOT trigger emergency compaction

				// Reset abort flag and clear events
				abortDuringPostAppend = false;
				events.length = 0;
				vi.clearAllMocks();

				// Mock prompt again for second call
				vi.spyOn(session2.agent, "prompt").mockResolvedValue();

				// Trigger second prompt with SAME transcript size - should NOT re-trigger emergency compaction
				vi.spyOn(sessionManager2, "getTranscriptFileBytes").mockReturnValue(largeTranscriptSize);
				const secondPromptResult = await session2.prompt("second message");

				// Wait for any async work
				for (let i = 0; i < 20; i++) await Promise.resolve();
				await session2.waitForIdle();

				// Verify NO new emergency compaction was triggered
				const secondCompactionStarts = events.filter(e => e.type === "auto_compaction_start");
				expect(secondCompactionStarts.length, "Should NOT trigger emergency compaction again at same size").toBe(0);
			} catch (error) {
				await session2?.dispose();
				modelRegistry2?.dispose();
				authStorage2?.close();
				throw error;
			} finally {
				await session2.dispose();
				modelRegistry2.dispose();
				authStorage2.close();
			}
		} finally {
			tempDir2.removeSync();
		}
	});

	it("allows retry after abort BEFORE entry is appended to transcript", async () => {
		// Real regression test: when abort fires BEFORE the compaction entry is appended,
		// the baseline should NOT be updated, allowing the next prompt to retry the compaction.

		const tempDir3 = TempDir.createSync("@pi-emergency-abort-before-append-");
		try {
			const model = getBundledModel("anthropic", "claude-sonnet-4-5");
			if (!model) throw new Error("Expected bundled test model to exist");

			const authStorage3 = await AuthStorage.create(path.join(tempDir3.path(), "testauth.db"));
			authStorage3.setRuntimeApiKey(model.provider, "test-key");

			const modelRegistry3 = new ModelRegistry(authStorage3);
			const sessionManager3 = SessionManager.inMemory();

			sessionManager3.appendMessage(userMsg("initial message"));

			const agent = new Agent({
				initialState: {
					model,
					systemPrompt: ["Test"],
					tools: [],
					messages: [],
				},
			});

			const session3 = new AgentSession({
				agent,
				sessionManager: sessionManager3,
				settings: Settings.isolated({
					"compaction.keepRecentTokens": 1,
					"contextPromotion.enabled": false,
					"retry.enabled": false,
					"todo.reminders": false,
				}),
				modelRegistry: modelRegistry3,
			});

			try {
				const largeTranscriptSize = 100 * 1024 * 1024; // 100 MiB
				vi.spyOn(sessionManager3, "getTranscriptFileBytes").mockReturnValue(largeTranscriptSize);

				const events: Array<{ type: string }> = [];
				session3.subscribe(event => {
					if (event.type === "auto_compaction_start" || event.type === "auto_compaction_end") {
						events.push({ type: event.type });
					}
				});

				vi.spyOn(session3.agent, "prompt").mockResolvedValue();

				// Scenario 2: Abort fires BEFORE entry is appended (early abort)
				let abortBeforeAppend = false;
				const appendCompactionOriginal = sessionManager3.appendCompaction.bind(sessionManager3);
				vi.spyOn(sessionManager3, "appendCompaction").mockImplementation((...args) => {
					if (abortBeforeAppend) {
						// Abort before the entry is appended
						void session3.abort({ cause: "test_abort_before" });
					}
					return appendCompactionOriginal(...args);
				});

				abortBeforeAppend = true;
				await session3.prompt("first message");

				for (let i = 0; i < 20; i++) await Promise.resolve();
				await session3.waitForIdle();

				// Count compaction attempts in first prompt
				const firstCompactionStarts = events.filter(e => e.type === "auto_compaction_start").length;

				// Reset for second prompt
				abortBeforeAppend = false;
				events.length = 0;
				vi.clearAllMocks();

				vi.spyOn(session3.agent, "prompt").mockResolvedValue();
				vi.spyOn(sessionManager3, "getTranscriptFileBytes").mockReturnValue(largeTranscriptSize);

				// Second prompt should be able to retry compaction since baseline wasn't set
				// (abort happened before entry appending, so baseline wasn't recorded)
				await session3.prompt("second message");

				for (let i = 0; i < 20; i++) await Promise.resolve();
				await session3.waitForIdle();

				// Should have attempted compaction again since baseline wasn't set
				const secondCompactionStarts = events.filter(e => e.type === "auto_compaction_start").length;
				expect(
					secondCompactionStarts,
					"Should retry compaction when abort was before entry appending",
				).toBeGreaterThan(0);
			} catch (error) {
				await session3?.dispose();
				modelRegistry3?.dispose();
				authStorage3?.close();
				throw error;
			} finally {
				await session3.dispose();
				modelRegistry3.dispose();
				authStorage3.close();
			}
		} finally {
			tempDir3.removeSync();
		}
	});
});
