import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@gajae-code/agent-core";
import { Effort, getBundledModel } from "@gajae-code/ai";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { TempDir } from "@gajae-code/utils";

describe("AgentSession role model thinking behavior", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	let sessionSettings: Settings;
	const authStorages: AuthStorage[] = [];

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-role-thinking-");
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
		}
		for (const authStorage of authStorages.splice(0)) {
			authStorage.close();
		}
		tempDir.removeSync();
	});

	function getAnthropicModelOrThrow(id: string) {
		const model = getBundledModel("anthropic", id);
		if (!model) throw new Error(`Expected anthropic model ${id} to exist`);
		return model;
	}

	async function createSession(options: {
		initialModelId: string;
		initialThinkingLevel: Effort;
		modelRoles: Record<string, string>;
	}) {
		const model = getAnthropicModelOrThrow(options.initialModelId);
		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
				thinkingLevel: options.initialThinkingLevel,
			},
		});
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));

		sessionSettings = Settings.isolated();
		for (const [role, modelRoleValue] of Object.entries(options.modelRoles)) {
			sessionSettings.setModelRole(role, modelRoleValue);
		}
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: sessionSettings,
			modelRegistry,
		});
	}

	it("re-applies explicit role thinking each time that role is selected", async () => {
		const defaultModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const slowModel = getAnthropicModelOrThrow("claude-sonnet-4-6");

		await createSession({
			initialModelId: defaultModel.id,
			initialThinkingLevel: Effort.High,
			modelRoles: {
				default: `${defaultModel.provider}/${defaultModel.id}`,
				slow: `${slowModel.provider}/${slowModel.id}:off`,
			},
		});

		const firstSwitch = await session.cycleRoleModels(["default", "slow"]);
		expect(firstSwitch?.role).toBe("slow");
		expect(firstSwitch?.model.id).toBe(slowModel.id);
		expect(firstSwitch?.thinkingLevel).toBe("off");
		expect(session.thinkingLevel).toBe("off");

		session.setThinkingLevel(Effort.High);
		expect(session.thinkingLevel).toBe(Effort.High);

		const secondSwitch = await session.cycleRoleModels(["default", "slow"]);
		expect(secondSwitch?.role).toBe("default");
		expect(secondSwitch?.model.id).toBe(defaultModel.id);
		expect(session.thinkingLevel).toBe(Effort.High);

		const thirdSwitch = await session.cycleRoleModels(["default", "slow"]);
		expect(thirdSwitch?.role).toBe("slow");
		expect(thirdSwitch?.model.id).toBe(slowModel.id);
		expect(thirdSwitch?.thinkingLevel).toBe("off");
		expect(session.thinkingLevel).toBe("off");
	});

	it("preserves current thinking when switching into default/no-suffix role", async () => {
		const defaultModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const slowModel = getAnthropicModelOrThrow("claude-sonnet-4-6");

		await createSession({
			initialModelId: defaultModel.id,
			initialThinkingLevel: Effort.Low,
			modelRoles: {
				default: `${defaultModel.provider}/${defaultModel.id}`,
				slow: `${slowModel.provider}/${slowModel.id}:high`,
			},
		});

		const toSlow = await session.cycleRoleModels(["default", "slow"]);
		expect(toSlow?.role).toBe("slow");
		expect(toSlow?.thinkingLevel).toBe(Effort.High);
		expect(session.thinkingLevel).toBe(Effort.High);

		session.setThinkingLevel(Effort.Minimal);
		expect(session.thinkingLevel).toBe(Effort.Minimal);

		const toDefault = await session.cycleRoleModels(["default", "slow"]);
		expect(toDefault?.role).toBe("default");
		expect(toDefault?.model.id).toBe(defaultModel.id);
		expect(toDefault?.thinkingLevel).toBe(Effort.Minimal);
		expect(session.thinkingLevel).toBe(Effort.Minimal);
	});

	it("applies slow role thinking even when plan shares the same model", async () => {
		const defaultModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const smolModel = getAnthropicModelOrThrow("claude-sonnet-4-6");
		const slowPlanModel = getAnthropicModelOrThrow("claude-opus-4-5");

		await createSession({
			initialModelId: defaultModel.id,
			initialThinkingLevel: Effort.Medium,
			modelRoles: {
				default: `${defaultModel.provider}/${defaultModel.id}`,
				smol: `${smolModel.provider}/${smolModel.id}:low`,
				slow: `${slowPlanModel.provider}/${slowPlanModel.id}:high`,
				plan: `${slowPlanModel.provider}/${slowPlanModel.id}:off`,
			},
		});

		const toSmol = await session.cycleRoleModels(["slow", "default", "smol"]);
		expect(toSmol?.role).toBe("smol");
		expect(toSmol?.thinkingLevel).toBe(Effort.Low);
		expect(session.thinkingLevel).toBe(Effort.Low);

		const toSlow = await session.cycleRoleModels(["slow", "default", "smol"]);
		expect(toSlow?.role).toBe("slow");
		expect(toSlow?.model.id).toBe(slowPlanModel.id);
		expect(toSlow?.thinkingLevel).toBe(Effort.High);
		expect(session.thinkingLevel).toBe(Effort.High);
	});

	it("preserves explicit role thinking when updating default model despite unresolved previous model", async () => {
		const defaultModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const slowModel = getAnthropicModelOrThrow("claude-sonnet-4-6");

		await createSession({
			initialModelId: defaultModel.id,
			initialThinkingLevel: Effort.High,
			modelRoles: {
				default: "anthropic/nonexistent-model:off",
			},
		});

		await session.setModel(slowModel);

		expect(sessionSettings.getModelRole("default")).toBe(`${slowModel.provider}/${slowModel.id}:off`);
	});

	it("applies selected default role thinking to agent invocation state", async () => {
		const initialModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const selectedModel = getAnthropicModelOrThrow("claude-sonnet-4-6");

		await createSession({
			initialModelId: initialModel.id,
			initialThinkingLevel: Effort.Low,
			modelRoles: {
				default: `${initialModel.provider}/${initialModel.id}:low`,
			},
		});

		await session.setModel(selectedModel, "default", {
			selector: `${selectedModel.provider}/${selectedModel.id}`,
			thinkingLevel: Effort.High,
		});

		expect(session.thinkingLevel).toBe(Effort.High);
		expect(sessionSettings.getModelRole("default")).toBe(`${selectedModel.provider}/${selectedModel.id}:high`);
		expect(session.agent.state.thinkingLevel).toBe(Effort.High);
	});

	it("resolves subagent model assignments from task.agentModelOverrides", async () => {
		const defaultModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const executorModel = getAnthropicModelOrThrow("claude-sonnet-4-6");

		await createSession({
			initialModelId: defaultModel.id,
			initialThinkingLevel: Effort.Low,
			modelRoles: {
				default: `${defaultModel.provider}/${defaultModel.id}:low`,
			},
		});
		sessionSettings.set("task.agentModelOverrides", {
			executor: `${executorModel.provider}/${executorModel.id}:high`,
		});

		const resolved = session.resolveRoleModelWithThinking("executor");

		expect(resolved.model?.id).toBe(executorModel.id);
		expect(resolved.thinkingLevel).toBe(Effort.High);
		expect(resolved.explicitThinkingLevel).toBe(true);
	});

	it("clamps unsupported selections from model metadata", async () => {
		const model = getAnthropicModelOrThrow("claude-sonnet-4-6");
		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
				thinkingLevel: undefined,
			},
		});
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth-non-xhigh.db"));
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models-non-xhigh.yml"));

		sessionSettings = Settings.isolated();
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: sessionSettings,
			modelRegistry,
		});

		session.setThinkingLevel(Effort.XHigh);
		expect(session.thinkingLevel).toBe(Effort.High);
		expect(session.getAvailableThinkingLevels()).not.toContain("xhigh");
	});

	it("cycles through off before returning to effort levels", async () => {
		const model = getAnthropicModelOrThrow("claude-sonnet-4-5");

		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
				thinkingLevel: Effort.High,
			},
		});
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth-cycle-thinking.db"));
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models-cycle-thinking.yml"));

		sessionSettings = Settings.isolated();
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: sessionSettings,
			modelRegistry,
		});

		expect(session.cycleThinkingLevel()).toBe("off");
		expect(session.thinkingLevel).toBe("off");
		expect(session.cycleThinkingLevel()).toBe(Effort.Minimal);
		expect(session.thinkingLevel).toBe(Effort.Minimal);
	});
});
