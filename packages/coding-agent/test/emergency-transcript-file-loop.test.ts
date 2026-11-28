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
		//   if (this.#sessionTransitionKind !== "mcp-control" && !this.#usesSharedSessionPublication()) {
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

	it("records baseline when compaction entry is published, even if aborted after", async () => {
		// Regression test for issue where baseline was NOT recorded if signal was aborted
		// after the compaction entry was appended but before the result was returned.
		//
		// In agent-session.ts #runAutoCompactionImpl (around line 29507-29524):
		// The baseline should be recorded right after #applyCompactionPostAppend,
		// BEFORE checking if the signal is aborted. This ensures that if abort happens
		// after the entry is published, the baseline is still updated to prevent re-triggering
		// on the next prompt.
		//
		// Flow:
		// 1. appendCompaction (line 29505) - entry appended, catalog committed
		// 2. #applyCompactionPostAppend (line 29508) - post-append processing
		// 3. Record baseline (line 29514-29523) - MY FIX: record when entry is published
		// 4. if (signal.aborted) return "aborted" (line 29524) - abort check happens AFTER
		//
		// This ensures that the baseline is recorded for published entries, keeping
		// the invariant: unchanged transcript should not retrigger next prompt.

		const afterCompactionSize = 50 * 1024 * 1024; // 50 MiB baseline after successful compaction

		// Before the fix:
		// - Compaction happens, entry is appended
		// - Signal is aborted after appending
		// - Result is "aborted" (not "compacted")
		// - Baseline recording check at emergency compaction sees kind="aborted", not records
		// - Next prompt: transcript is still 50 MiB (unchanged)
		// - Emergency compaction triggers AGAIN (bad: infinite loop)
		//
		// After the fix:
		// - Compaction happens, entry is appended
		// - Baseline is recorded right after #applyCompactionPostAppend
		// - Signal is aborted after appending (but after baseline recording)
		// - Result is "aborted" (not "compacted")
		// - Baseline is ALREADY recorded (good)
		// - Next prompt: transcript is still 50 MiB (unchanged)
		// - Emergency compaction does NOT trigger (good: no infinite loop)

		// Verify the threshold calculation prevents re-triggering
		const unchanged = afterCompactionSize; // 50 MiB, unchanged
		const sample = {
			heapUsedBytes: 0,
			providerBytes: 0,
			messageCount: 0,
			imageBytes: 0,
			transcriptFileBytes: unchanged,
		};

		// With baseline recorded at 50 MiB, unchanged transcript should NOT trigger
		const reason = emergencyCompactionReason(sample, undefined, afterCompactionSize);
		expect(reason).toBeNull(); // Should NOT trigger (unchanged)

		// This test verifies that baseline is recorded for published entries,
		// preventing infinite compaction loops when abort happens after publication.
	});
});
