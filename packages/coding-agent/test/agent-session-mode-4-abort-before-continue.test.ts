import { afterEach, describe, expect, it } from "bun:test";
import { Agent, type AgentMessage } from "@gajae-code/agent-core";
import type { AssistantMessage } from "@gajae-code/ai";
import { getBundledModel } from "@gajae-code/ai/models";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";

/**
 * Mode 4: Session startup continuation abort-before-continue race.
 *
 * Bug: If abort() is called before continue() creates its controller,
 * the abort is recorded nowhere and the continuation hangs.
 *
 * Post-fix: Record pending abort and check it in continue()
 */

describe("Mode 4: Session startup continuation abort-before-continue race", () => {
	let session: AgentSession | null = null;

	function testModel() {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled Anthropic test model");
		return model;
	}

	function userMessageTail(): AgentMessage {
		return {
			role: "user",
			content: [{ type: "text", text: "continue" }],
			timestamp: Date.now(),
		};
	}

	async function createSessionWithMessages(messages: AgentMessage[]): Promise<AgentSession> {
		const agent = new Agent({
			initialState: { model: testModel(), systemPrompt: ["Test"], tools: [], messages },
		});
		const authStorage = await AuthStorage.create(":memory:");
		const sess = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: new ModelRegistry(authStorage),
		});
		return sess;
	}

	afterEach(async () => {
		if (session) {
			await session.dispose();
			session = null;
		}
	});

	it("POST-FIX: abort before continue() causes immediate AbortError", async () => {
		const messages: AgentMessage[] = [
			{
				role: "user",
				content: [{ type: "text", text: "initial" }],
				timestamp: Date.now(),
			},
			userMessageTail(),
		];

		session = await createSessionWithMessages(messages);

		const controller = new AbortController();
		session.setPendingContinuationAbort(controller.signal);
		controller.abort(); // Abort BEFORE continue()

		// POST-FIX: continuePersistedHistory() checks for pending abort
		// Result: AbortError thrown immediately (no hang)
		let abortReceived = false;
		try {
			await Promise.race([
				session.continuePersistedHistory(),
				new Promise((_, reject) =>
					setTimeout(
						() => reject(new Error("Timeout: continuation did not respect pre-abort")),
						1000,
					),
				),
			]);
		} catch (error) {
			if (error instanceof DOMException && error.name === "AbortError") {
				abortReceived = true;
				console.log(`✓ POST-FIX: Received AbortError: ${error.message}`);
			} else {
				throw error;
			}
		}

		expect(abortReceived).toBe(true);
	});

	it("documents the fix in session layer", () => {
		console.log("✓ Fix location: packages/coding-agent/src/session/agent-session.ts");
		console.log("  Pattern: Record pending abort, check before continue()");
		console.log("  Method: setPendingContinuationAbort(signal)");
		console.log("  Check: if (this.#pendingContinuationAbort?.aborted)");
		console.log("  Result: throw AbortError if pre-aborted");
	});
});
