import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@gajae-code/agent-core";
import { getBundledModel } from "@gajae-code/ai/models";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import type { Goal } from "../../src/goals/state";
import { AgentSession } from "../../src/session/agent-session";
import { AuthStorage } from "../../src/session/auth-storage";
import { SessionManager } from "../../src/session/session-manager";

function testModel() {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected bundled Anthropic test model");
	return model;
}

describe("goal SDK restoration regression test for issue #7947", () => {
	let root: string;
	let cwd: string;
	let agentDir: string;

	beforeEach(() => {
		root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "goal-sdk-restoration-"));
		cwd = path.join(root, "work");
		agentDir = path.join(root, "agent");
		fs.mkdirSync(cwd);
		fs.mkdirSync(agentDir);
	});

	afterEach(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});

	it("preserves completed goal state disabled during SDK restoration (issue #7947)", async () => {
		// Setup: Create a session manager with a completed goal
		const manager = SessionManager.create(cwd, SessionManager.managedDestination(cwd, agentDir));
		manager.appendMessage({ role: "user", content: "test", timestamp: Date.now() });
		manager.appendMessage({
			role: "assistant",
			content: [{ type: "text" as const, text: "response" }],
			api: "anthropic-messages" as const,
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "stop",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		});

		// Create a completed goal state - when a goal is completed, it has:
		// - status: "complete"
		// - enabled: false (in the state)
		// - mode: "exiting" (in the state)
		const completedGoal: Goal = {
			id: "goal-123",
			objective: "Test objective",
			status: "complete",
			tokensUsed: 100,
			timeUsedSeconds: 10,
			createdAt: Date.now(),
			updatedAt: Date.now(),
		};

		// Persist the completed goal state using mode_change entry
		manager.appendModeChange("goal", { goal: completedGoal });
		await manager.flush();

		// Create AgentSession which runs #restoreGoalModeStateFromBranch()
		const sessionContext = manager.buildSessionContext();
		const agent = new Agent({
			initialState: {
				model: testModel(),
				systemPrompt: ["Test"],
				tools: [],
				messages: sessionContext.messages,
			},
		});

		const authStorage = await AuthStorage.create(":memory:");
		const session = new AgentSession({
			agent,
			sessionManager: manager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: new ModelRegistry(authStorage),
		});

		try {
			// This is the critical part: after initialization, the goal mode restoration
			// should NOT set enabled=true, mode="active" for completed goals.
			// Issue #7947: The restore function was blindly setting mode="active" for all
			// goals with mode="goal", without checking if goal.status="complete".

			// Wait for async goal restoration
			await new Promise(resolve => setTimeout(resolve, 50));

			const goalState = session.getGoalModeState();

			// A completed goal MUST NOT be enabled or in active mode
			if (goalState && goalState.goal.status === "complete") {
				// The fix requires:
				// - enabled MUST be false
				// - mode MUST be "exiting"
				// - reason MUST be "completed"
				expect(goalState.enabled).toBe(false);
				expect(goalState.mode).toBe("exiting");
				expect(goalState.reason).toBe("completed");
			}
		} finally {
			await session.dispose();
			await manager.close();
		}
	});
});
