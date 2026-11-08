import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import type { AgentOptions } from "@gajae-code/agent-core";
import { Agent } from "@gajae-code/agent-core";
import { Effort, getBundledModel } from "@gajae-code/ai";
import { createMockModel } from "@gajae-code/ai/providers/mock";
import {
	commitDurableModelProfileOwnership,
	readDurableModelProfileOwnership,
} from "@gajae-code/coding-agent/config/model-profile-ownership";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import type { ModelSelectorValue } from "@gajae-code/coding-agent/config/model-selector-value";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { TempDir } from "@gajae-code/utils";

describe("AgentSession role model thinking behavior", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	let sessionSettings: Settings;
	let modelRegistry: ModelRegistry;
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
		modelRoles: Record<string, ModelSelectorValue>;
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
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));

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

	it("counts provider-agnostic cycle roles without changing canonical affinity", async () => {
		const defaultModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		await createSession({
			initialModelId: defaultModel.id,
			initialThinkingLevel: Effort.High,
			modelRoles: {
				default: "claude-sonnet-4-5",
				slow: "claude-sonnet-4-6",
			},
		});
		session.setActiveModelProfile("provider-agnostic-profile");
		modelRegistry.seedCanonicalVariant(session.sessionId, defaultModel);
		const before = modelRegistry.getSessionCanonicalVariant(session.sessionId);

		expect(session.getRoleModelCycleCandidateCount(["default", "slow"])).toBe(2);
		expect(modelRegistry.getSessionCanonicalVariant(session.sessionId)).toBe(before);
	});

	it("resolves a profile-owned role without changing canonical affinity", async () => {
		const defaultModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const executorModel = getAnthropicModelOrThrow("claude-sonnet-4-6");
		await createSession({
			initialModelId: defaultModel.id,
			initialThinkingLevel: Effort.High,
			modelRoles: {},
		});
		sessionSettings.set("task.agentModelOverrides", { executor: "profile-alias" });
		vi.spyOn(modelRegistry, "getModelProfile").mockReturnValue({
			name: "executor-profile",
			requiredProviders: [],
			modelMapping: { executor: "profile-alias" },
			source: "user",
		});
		vi.spyOn(modelRegistry, "getAvailable").mockReturnValue([executorModel]);
		vi.spyOn(modelRegistry, "lookupAliasExists").mockReturnValue(true);
		const aliasLookup = vi.spyOn(modelRegistry, "resolveModelByLookupAlias").mockReturnValue(executorModel);
		session.setActiveModelProfile("executor-profile");
		modelRegistry.seedCanonicalVariant(session.sessionId, defaultModel);
		const before = modelRegistry.getSessionCanonicalVariant(session.sessionId);

		expect(session.resolveRoleModelWithThinking("executor").model?.id).toBe(executorModel.id);
		expect(aliasLookup).toHaveBeenCalled();
		expect(modelRegistry.getSessionCanonicalVariant(session.sessionId)).toBe(before);
	});

	it("keeps manual role aliases exact when a partial profile does not own the role", async () => {
		const defaultModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		await createSession({
			initialModelId: defaultModel.id,
			initialThinkingLevel: Effort.High,
			modelRoles: { executor: "claude-sonnet-4-6" },
		});
		sessionSettings.set("task.agentModelOverrides", { executor: "claude-sonnet-4-6" });
		vi.spyOn(modelRegistry, "getModelProfile").mockReturnValue({
			name: "planner-only",
			requiredProviders: [],
			modelMapping: { planner: "claude-sonnet-4-5" },
			source: "user",
		});
		vi.spyOn(modelRegistry, "getAvailable").mockReturnValue([getAnthropicModelOrThrow("claude-sonnet-4-6")]);
		const aliasLookup = vi.spyOn(modelRegistry, "resolveModelByLookupAlias");
		session.setActiveModelProfile("planner-only");

		expect(session.resolveRoleModelWithThinking("executor").model?.id).toBe("claude-sonnet-4-6");
		expect(aliasLookup).not.toHaveBeenCalled();
	});

	it("keeps a manual default exact when a partial profile does not own default", async () => {
		const defaultModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		await createSession({
			initialModelId: defaultModel.id,
			initialThinkingLevel: Effort.High,
			modelRoles: { default: "claude-sonnet-4-5" },
		});
		vi.spyOn(modelRegistry, "getModelProfile").mockReturnValue({
			name: "planner-only",
			requiredProviders: [],
			modelMapping: { planner: "claude-sonnet-4-6" },
			source: "user",
		});
		vi.spyOn(modelRegistry, "getAvailable").mockReturnValue([defaultModel]);
		const aliasLookup = vi.spyOn(modelRegistry, "resolveModelByLookupAlias");
		session.setActiveModelProfile("planner-only");

		expect(session.resolveConfiguredDefaultModel()?.id).toBe(defaultModel.id);
		expect(aliasLookup).not.toHaveBeenCalled();
	});

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

	it.each([false, true])("preserves cycle roles and chains with durable profile=%s", async durableProfile => {
		const defaultModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const slowModel = getAnthropicModelOrThrow("claude-sonnet-4-6");
		const fallbackModel = getAnthropicModelOrThrow("claude-opus-4-5");
		const defaultChain = [
			`${defaultModel.provider}/${defaultModel.id}`,
			`${fallbackModel.provider}/${fallbackModel.id}:low`,
		];
		const slowChain = [
			`${slowModel.provider}/${slowModel.id}:off`,
			`${fallbackModel.provider}/${fallbackModel.id}:high`,
		];
		const roles = { default: defaultChain, slow: slowChain };
		await createSession({
			initialModelId: defaultModel.id,
			initialThinkingLevel: Effort.High,
			modelRoles: roles,
		});
		if (durableProfile) {
			await commitDurableModelProfileOwnership(sessionSettings, { kind: "profile", profile: "cycle-profile" });
			session.setActiveModelProfile("cycle-profile", true);
			vi.spyOn(modelRegistry, "getAvailable").mockReturnValue([defaultModel, slowModel, fallbackModel]);
			sessionSettings.override("modelRoles", {
				default: [defaultModel.id, `${fallbackModel.id}:low`],
				slow: [`${slowModel.id}:off`, `${fallbackModel.id}:high`],
			});
		}
		const owner = readDurableModelProfileOwnership(sessionSettings);

		const toSlow = await session.cycleRoleModels(["default", "slow"]);
		expect(toSlow).toMatchObject({ role: "slow", model: { id: slowModel.id }, thinkingLevel: "off" });
		expect(sessionSettings.getGlobal("modelRoles")).toEqual(roles);
		expect(sessionSettings.get("modelRoles")).toEqual(roles);
		expect(session.sessionManager.getLastModelChangeRole()).toBe("slow");
		expect(session.sessionManager.buildSessionContext().models.default).toBe(`${slowModel.provider}/${slowModel.id}`);
		expect(session.getConfiguredModelChain("default")).toEqual(slowChain);
		expect(session.getActiveModelProfile()).toBeUndefined();
		expect(readDurableModelProfileOwnership(sessionSettings)).toMatchObject({
			version: owner.version + (durableProfile ? 1 : 0),
			marker: { kind: durableProfile ? "cleared" : "inherit" },
		});

		session.setThinkingLevel(Effort.Minimal);
		const toDefault = await session.cycleRoleModels(["default", "slow"]);
		expect(toDefault).toMatchObject({
			role: "default",
			model: { id: defaultModel.id },
			thinkingLevel: Effort.Minimal,
		});
		expect(session.sessionManager.getLastModelChangeRole()).toBe("default");
		expect(session.getConfiguredModelChain("default")).toEqual(defaultChain);
		expect(sessionSettings.get("modelRoles")).toEqual(roles);
		expect(sessionSettings.getGlobal("modelRoles")).toEqual(roles);

		const backToSlow = await session.cycleRoleModels(["default", "slow"]);
		expect(backToSlow).toMatchObject({ role: "slow", model: { id: slowModel.id }, thinkingLevel: "off" });
		expect(session.getConfiguredModelChain("default")).toEqual(slowChain);
		expect(readDurableModelProfileOwnership(sessionSettings).version).toBe(owner.version + (durableProfile ? 1 : 0));
	});

	it("rejects a role cycle when a newer durable profile wins during credential lookup", async () => {
		const defaultModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const slowModel = getAnthropicModelOrThrow("claude-sonnet-4-6");
		const roles = {
			default: `${defaultModel.provider}/${defaultModel.id}`,
			slow: `${slowModel.provider}/${slowModel.id}:off`,
		};
		await createSession({ initialModelId: defaultModel.id, initialThinkingLevel: Effort.High, modelRoles: roles });
		await commitDurableModelProfileOwnership(sessionSettings, { kind: "profile", profile: "cycle-profile" });
		session.setActiveModelProfile("cycle-profile", true);
		session.setThinkingLevel(Effort.High);
		const before = session.sessionManager.buildSessionContext();
		const credentialRequested = Promise.withResolvers<void>();
		const credential = Promise.withResolvers<string>();
		const apiKey = vi.spyOn(modelRegistry, "getApiKey").mockImplementationOnce(() => {
			credentialRequested.resolve();
			return credential.promise;
		});
		try {
			const cycle = session.cycleRoleModels(["default", "slow"]);
			await credentialRequested.promise;
			const winner = await commitDurableModelProfileOwnership(sessionSettings, {
				kind: "profile",
				profile: "newer-profile",
			});
			credential.resolve("test-key");
			await expect(cycle).rejects.toMatchObject({ code: "model_profile_ownership_conflict" });
			expect(readDurableModelProfileOwnership(sessionSettings)).toEqual(winner);
			expect(sessionSettings.getGlobal("modelRoles")).toEqual(roles);
			expect(session.sessionManager.buildSessionContext()).toEqual(before);
			expect(session.model?.id).toBe(defaultModel.id);
			expect(session.thinkingLevel).toBe(Effort.High);
			expect(session.getActiveModelProfile()).toBe("cycle-profile");
		} finally {
			credential.resolve("test-key");
			apiKey.mockRestore();
		}
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
	it("keeps a session thinking override across a suffixed default-chain re-resolution", async () => {
		const primary = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const fallback = getBundledModel("openai", "gpt-4o-mini");
		if (!fallback) throw new Error("Expected openai/gpt-4o-mini");

		const streamFn: AgentOptions["streamFn"] = (model, context, options) =>
			createMockModel({ responses: [{ content: ["ok"] }] }).stream(model, context, options);
		const agent = new Agent({
			getApiKey: provider => `${provider}-test-key`,
			initialState: {
				model: primary,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
				thinkingLevel: Effort.High,
			},
			streamFn,
		});
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth-session-effort.db"));
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		authStorage.setRuntimeApiKey("openai", "test-key");
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models-session-effort.yml"));

		sessionSettings = Settings.isolated({
			"compaction.enabled": false,
			defaultThinkingLevel: Effort.High,
		});
		sessionSettings.setModelRole("default", `${primary.provider}/${primary.id}:high`);
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: sessionSettings,
			modelRegistry,
		});
		session.setConfiguredModelChain(
			"default",
			[`${primary.provider}/${primary.id}:high`, `${fallback.provider}/${fallback.id}`],
			"test",
		);

		await session.setThinkingLevelForControl(Effort.XHigh, false);
		expect(session.thinkingLevel).toBe(Effort.XHigh);
		expect(session.getThinkingScopeForControl()).toBe("session");

		await session.prompt("keep session xhigh through chain re-resolution");
		await session.waitForIdle();

		expect(session.thinkingLevel).toBe(Effort.XHigh);
		expect(session.getThinkingScopeForControl()).toBe("session");
	});

	it("does not mint session scope from a model-default append (issue #4695)", async () => {
		const primary = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const codex = getBundledModel("openai-codex", "gpt-5.5");
		if (!codex) throw new Error("Expected openai-codex/gpt-5.5");
		if (codex.thinking?.defaultLevel === undefined) throw new Error("gpt-5.5 expected to carry defaultLevel");

		const agent = new Agent({
			initialState: {
				model: primary,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
				thinkingLevel: Effort.High,
			},
		});
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth-model-default.db"));
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		authStorage.setRuntimeApiKey("openai-codex", "test-key");
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models-model-default.yml"));
		sessionSettings = Settings.isolated();
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: sessionSettings,
			modelRegistry,
		});

		expect(session.getThinkingScopeForControl()).toBe("global config");
		await session.setModelTemporary(codex);
		expect(session.thinkingLevel).toBe(codex.thinking.defaultLevel);
		expect(session.getThinkingScopeForControl()).toBe("global config");
	});

	it("treats a Shift+Tab cycle as operator session intent (issue #4695)", async () => {
		const primary = getAnthropicModelOrThrow("claude-sonnet-4-5");
		await createSession({
			initialModelId: primary.id,
			initialThinkingLevel: Effort.High,
			modelRoles: {},
		});
		const cycled = session.cycleThinkingLevel();
		expect(cycled).toBeDefined();
		expect(session.getThinkingScopeForControl()).toBe("session");
	});
});
