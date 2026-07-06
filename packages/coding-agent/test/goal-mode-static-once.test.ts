import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentMessage } from "@gajae-code/agent-core";
import { getBundledModel } from "@gajae-code/ai";
import { createMockModel } from "@gajae-code/ai/providers/mock";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { TempDir } from "@gajae-code/utils";

describe("goal-mode static-once context injection", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	let authStorage: AuthStorage | undefined;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-goal-static-once-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		if (session) await session.dispose();
		authStorage?.close();
		authStorage = undefined;
		tempDir.removeSync();
	});

	function createSession(): void {
		if (!authStorage) throw new Error("authStorage not initialized");
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: createMockModel({ responses: [{ content: ["Done"] }, { content: ["Done"] }, { content: ["Done"] }] })
				.stream,
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false, "goal.enabled": true }),
			modelRegistry: new ModelRegistry(authStorage),
		});
	}

	function goalContextCount(messages: AgentMessage[]): number {
		return messages.filter(m => m.role === "custom" && m.customType === "goal-mode-context").length;
	}

	function setActiveGoal(objective: string, id: string): void {
		session.setGoalModeState({
			enabled: true,
			mode: "active",
			goal: { id, objective, status: "active", tokensUsed: 0, timeUsedSeconds: 0, createdAt: 0, updatedAt: 0 },
		});
	}

	it("injects goal-mode-context exactly once across multiple turns with an unchanged goal", async () => {
		createSession();
		setActiveGoal("Ship the release", "goal-1");

		for (let turn = 0; turn < 5; turn++) {
			await session.prompt(`turn ${turn}`);
		}

		// Static-once: exactly one durable goal-mode-context copy despite 5 turns.
		expect(goalContextCount(session.messages)).toBe(1);
		// The single copy must be counter-free (no live usage counters).
		const injected = session.messages.find(m => m.role === "custom" && m.customType === "goal-mode-context");
		const content = injected?.role === "custom" && typeof injected.content === "string" ? injected.content : "";
		expect(content).toContain("Ship the release");
		expect(content).not.toContain("Tokens used");
		expect(content).not.toContain("Time used");
	});

	it("re-injects once when the active goal is replaced", async () => {
		createSession();
		setActiveGoal("First objective", "goal-1");
		await session.prompt("turn a");
		await session.prompt("turn b");
		expect(goalContextCount(session.messages)).toBe(1);

		setActiveGoal("Second objective", "goal-2");
		await session.prompt("turn c");

		// A new activation identity triggers exactly one more injection.
		expect(goalContextCount(session.messages)).toBe(2);
	});
});
