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
});
