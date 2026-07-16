import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@gajae-code/agent-core";
import { getBundledModel } from "@gajae-code/ai/models";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { ensureWorkflowSkillActivationState } from "@gajae-code/coding-agent/hooks/skill-state";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { TempDir } from "@gajae-code/utils";
import { createAssistantMessage } from "./helpers/agent-session-setup";

describe("AgentSession deep-interview continuation", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-deep-interview-continuation-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected built-in anthropic model to exist");
		const sessionManager = SessionManager.inMemory(tempDir.path());
		session = new AgentSession({
			agent: new Agent({
				initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			}),
			sessionManager,
			settings: Settings.isolated(),
			modelRegistry,
		});
		await ensureWorkflowSkillActivationState({
			cwd: tempDir.path(),
			skill: "deep-interview",
			sessionId: sessionManager.getSessionId(),
		});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await session.dispose();
		authStorage.close();
		tempDir.removeSync();
	});

	async function emitAssistantStop(timestamp: number): Promise<void> {
		const assistantMessage = { ...createAssistantMessage("Round recorded."), timestamp };
		session.agent.emitExternalEvent({ type: "message_end", message: assistantMessage });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMessage] });
		await Bun.sleep(50);
		await session.waitForIdle();
	}

	it("continues when the model stops during an active interview", async () => {
		const continueSpy = vi.spyOn(session.agent, "continue").mockResolvedValue();

		await emitAssistantStop(100);

		expect(continueSpy).toHaveBeenCalledTimes(1);
		const reminder = session.agent.state.messages.find(message => message.role === "developer");
		expect(JSON.stringify(reminder?.content)).toContain("score and persist an answered round");
		expect(JSON.stringify(reminder?.content)).toContain("Use the ask tool for the next question");
	});

	it("bounds automatic continuation attempts", async () => {
		const continueSpy = vi.spyOn(session.agent, "continue").mockResolvedValue();

		await emitAssistantStop(100);
		await emitAssistantStop(200);
		await emitAssistantStop(300);

		expect(continueSpy).toHaveBeenCalledTimes(2);
	});
});
