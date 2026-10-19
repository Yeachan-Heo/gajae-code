import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as path from "node:path";
import { Agent, ThinkingLevel } from "@gajae-code/agent-core";
import type { Model } from "@gajae-code/ai";
import {
	activateModelProfile,
	applyPreparedModelProfileActivation,
	ModelProfileCredentialError,
	materializeActiveModelProfileAssignments,
	prepareModelProfileActivation,
} from "@gajae-code/coding-agent/config/model-profile-activation";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import type { AgentStorage } from "@gajae-code/coding-agent/session/agent-storage";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { TempDir } from "@gajae-code/utils";

// Regression coverage for the combo-preset resume bug: activating a model
// profile (e.g. opus-codex) whose main model differs from the startup base
// model used to record the main model with role="temporary". On resume the
// session restored `models.default` (the stale pre-profile base model, e.g.
// openai-codex/gpt-5.5), flipping the main provider away from the profile's
// intended main model. Profile activation records its concrete main model as
// the session default only after the activation transaction succeeds, while
// transient switches (retry/fallback/context-promotion/plan mode) stay role="temporary".
describe("AgentSession profile resume defaults", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	let modelRegistry: ModelRegistry;
	let authStorage: AuthStorage;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-profile-resume-default-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("openai-codex", "test-key");
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
		}
		authStorage.close();
		tempDir.removeSync();
	});

	function makeSession(
		startModel: Model,
		settings = Settings.isolated({ "compaction.enabled": false }),
	): AgentSession {
		const agent = new Agent({
			initialState: {
				model: startModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
		});
		return new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
	}

	function resolveModels(): { base: Model; profileMain: Model } {
		const base = modelRegistry.find("openai-codex", "gpt-5.5");
		const profileMain = modelRegistry.find("anthropic", "claude-opus-5-5");
		if (!base || !profileMain) {
			throw new Error("Expected codex and anthropic opus models to exist");
		}
		return { base, profileMain };
	}

	it("records the profile main model as the resume default without touching global settings", async () => {
		const { base, profileMain } = resolveModels();
		session = makeSession(base);

		// Session start records the base default model.
		await session.setModel(base);
		expect(session.sessionManager.buildSessionContext().models.default).toBe("openai-codex/gpt-5.5");
		const globalDefaultBefore = session.settings.getModelRole("default");

		// Combo-profile activation applies the main model for this session only.
		await session.setModelTemporary(profileMain, undefined, { persistAsSessionDefault: true });

		// The default that resume restores is now the profile's main model.
		expect(session.sessionManager.buildSessionContext().models.default).toBe("anthropic/claude-opus-5-5");
		// Global default setting is untouched (apply-for-this-session semantics).
		expect(session.settings.getModelRole("default")).toBe(globalDefaultBefore);
	});

	it("clears an unavailable-profile marker after recovery or a concrete user model selection", async () => {
		const { base } = resolveModels();
		session = makeSession(base);

		session.setUnavailableModelProfile("stale-profile");
		session.setActiveModelProfile("recovered-profile");
		expect(session.getUnavailableModelProfile()).toBeUndefined();

		session.setUnavailableModelProfile("stale-profile");
		const revision = session.getUserModelSelectionRevision();
		await session.setModel(base);
		expect(session.getUnavailableModelProfile()).toBeUndefined();
		expect(session.getUserModelSelectionRevision()).toBeGreaterThan(revision);
	});

	it("fences explicit model selections assigned to non-default roles", async () => {
		const { base, profileMain } = resolveModels();
		session = makeSession(base);
		const revision = session.getUserModelSelectionRevision();

		await session.setModel(profileMain, "executor");

		expect(session.model).toEqual(profileMain);
		expect(session.getUserModelSelectionRevision()).toBe(revision + 1);
	});

	it("records the concrete sticky canonical selector for a user model choice", async () => {
		const { base, profileMain } = resolveModels();
		session = makeSession(base);
		const canonicalId = modelRegistry.getCanonicalId(profileMain);
		if (!canonicalId) throw new Error("Expected profile model to have a canonical identity");

		await session.setModel(profileMain);

		expect(session.getUserCanonicalVariantSelection()).toEqual({
			revision: 1,
			canonicalVariant: `${profileMain.provider}/${profileMain.id}`,
		});
		expect(session.getUserCanonicalVariantSelection().canonicalVariant).toBe(
			modelRegistry.getSessionCanonicalVariant(session.sessionId),
		);
	});

	it("advances the recovery fence for explicit control-surface selections", () => {
		const { base } = resolveModels();
		session = makeSession(base);
		const revision = session.getUserModelSelectionRevision();

		session.markUserModelSelection();

		expect(session.getUserModelSelectionRevision()).toBe(revision + 1);
	});

	it("preserves an unavailable-profile marker when the active profile is reset", () => {
		const { base } = resolveModels();
		session = makeSession(base);

		session.setActiveModelProfile("unavailable-profile");
		session.setUnavailableModelProfile("unavailable-profile");
		session.setActiveModelProfile(undefined);

		expect(session.getUnavailableModelProfile()).toBe("unavailable-profile");
	});

	it("preserves the unavailable-profile marker when startup only overrides thinking", async () => {
		const { base } = resolveModels();
		session = makeSession(base);
		session.setUnavailableModelProfile("unavailable-profile");

		await session.setModelTemporary(base, ThinkingLevel.High, { cause: "startup-override" });

		expect(session.getUnavailableModelProfile()).toBe("unavailable-profile");
	});

	it("keeps a startup model override out of global settings and usage history", async () => {
		const { base } = resolveModels();
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"modelProfile.default": "claude-opus",
		});
		settings.overrideModelRoles({ default: `${base.provider}/${base.id}` });
		session = makeSession(base, settings);
		await activateModelProfile({ session, modelRegistry, settings, profileName: "claude-opus" });
		const activatedDefaultChain = session.getConfiguredModelChainState("default");
		expect(activatedDefaultChain?.origin).toBe("profile-activation");
		const installedProfileState = session.getProfileInstalledOverrideState();
		expect(installedProfileState.configuredDefaultChain).toBeDefined();
		expect(installedProfileState.configuredDefaultChain).toEqual(activatedDefaultChain?.entries);

		const storage = { recordModelUsage: (_selector: string) => {} };
		const recordModelUsage = spyOn(storage, "recordModelUsage");
		const getStorage = spyOn(settings, "getStorage").mockReturnValue(storage as unknown as AgentStorage);
		try {
			await session.setModelTemporary(base, ThinkingLevel.XHigh, {
				persistAsSessionDefault: true,
				cause: "startup-override",
			});

			expect(session.model).toEqual(base);
			expect(session.sessionManager.buildSessionContext().models.default).toBe("openai-codex/gpt-5.5");
			expect(session.getProfileInstalledOverrideState().configuredDefaultChain).toEqual(
				activatedDefaultChain?.entries,
			);
			expect(settings.getGlobal("modelProfile.default")).toBe("claude-opus");
			expect(settings.getGlobal("modelRoles")).toBeUndefined();
			expect(settings.getGlobal("task.agentModelOverrides")).toBeUndefined();
			expect(recordModelUsage).not.toHaveBeenCalled();
		} finally {
			getStorage.mockRestore();
			recordModelUsage.mockRestore();
		}
	});

	it("keeps a durable aliased profile active through a startup model override", async () => {
		const { base } = resolveModels();
		const profileDefault = modelRegistry.find("openai-codex", "gpt-6.1-sol");
		if (!profileDefault) throw new Error("Expected the codex-medium profile default model to exist");
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"modelProfile.default": "codex-standard",
		});
		session = makeSession(base, settings);
		await activateModelProfile({ session, modelRegistry, settings, profileName: "codex-standard" });
		const activeAgentOverrides = { ...settings.get("task.agentModelOverrides") };

		expect(session.getActiveModelProfile()).toBe("codex-medium");
		expect(Object.keys(activeAgentOverrides).length).toBeGreaterThan(0);

		await session.setModelTemporary(base, ThinkingLevel.High, {
			persistAsSessionDefault: true,
			cause: "startup-override",
		});

		expect(session.getActiveModelProfile()).toBe("codex-medium");
		expect(settings.getGlobal("modelProfile.default")).toBe("codex-standard");
		expect(settings.get("task.agentModelOverrides")).toEqual(activeAgentOverrides);

		await session.setModelTemporary(profileDefault, undefined, { cause: "restore" });
		await session.newSession();

		expect(session.model).toMatchObject({ provider: profileDefault.provider, id: profileDefault.id });
		expect(session.getActiveModelProfile()).toBe("codex-medium");
		expect(settings.getGlobal("modelProfile.default")).toBe("codex-standard");
		expect(settings.get("task.agentModelOverrides")).toEqual(activeAgentOverrides);
	});

	it("keeps a durable profile whose activation failed when a later role selection follows a startup override", async () => {
		const { base, profileMain } = resolveModels();
		const baseSelector = `${base.provider}/${base.id}`;
		const roleSelector = `${profileMain.provider}/${profileMain.id}`;
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"modelProfile.default": "glm-eco",
		});
		session = makeSession(base, settings);
		// The durable profile's required provider (zai) has no credentials.
		await expect(
			activateModelProfile({ session, modelRegistry, settings, profileName: "glm-eco" }),
		).rejects.toBeInstanceOf(ModelProfileCredentialError);
		expect(session.getActiveModelProfile()).toBeUndefined();

		// CLI --model startup override (main.ts applyStartupModelProfiles).
		await session.setModelTemporary(base, undefined, { persistAsSessionDefault: true, cause: "startup-override" });
		session.setConfiguredModelChain("default", [baseSelector], "startup-override", undefined, true);
		session.seedDefaultFallbackResolution(0, []);

		// Role-only selection (selector-controller non-default role path).
		session.markUserModelSelection();
		const materialized = materializeActiveModelProfileAssignments({
			session,
			settings,
			assignments: new Map([["executor", roleSelector]]),
		});
		expect(materialized).toBe(false);
		session.markProfileRoleOverrideManual("task.agentModelOverrides", "executor");
		settings.setAgentModelOverride("executor", roleSelector);

		expect(session.model).toEqual(base);
		expect(session.getConfiguredModelChainState("default")).toMatchObject({
			entries: [baseSelector],
			origin: "startup-override",
		});
		const reloadedSettings = Settings.isolated({
			modelRoles: settings.getGlobal("modelRoles"),
			"task.agentModelOverrides": settings.getGlobal("task.agentModelOverrides"),
			"modelProfile.default": settings.getGlobal("modelProfile.default"),
		});
		expect(reloadedSettings.getGlobal("modelProfile.default")).toBe("glm-eco");
		expect(reloadedSettings.getGlobal("modelRoles")).toBeUndefined();
		expect(reloadedSettings.getGlobal("task.agentModelOverrides")).toEqual({ executor: roleSelector });
	});

	it("does not materialize a history-restored profile whose activation fails", async () => {
		const { base, profileMain } = resolveModels();
		const baseSelector = `${base.provider}/${base.id}`;
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"modelProfile.default": "glm-eco",
		});
		session = makeSession(base, settings);

		// Session history can restore the profile identity before this process has
		// successfully activated it.
		session.setActiveModelProfile("glm-eco");
		expect(session.getActivatedModelProfile()).toBeUndefined();
		await expect(
			activateModelProfile({ session, modelRegistry, settings, profileName: "glm-eco" }),
		).rejects.toBeInstanceOf(ModelProfileCredentialError);
		expect(session.getActiveModelProfile()).toBe("glm-eco");
		expect(session.getActivatedModelProfile()).toBeUndefined();

		await session.setModelTemporary(base, undefined, {
			persistAsSessionDefault: true,
			cause: "startup-override",
		});
		session.setConfiguredModelChain("default", [baseSelector], "startup-override", undefined, true);

		const materialized = materializeActiveModelProfileAssignments({
			session,
			settings,
			assignments: new Map([["executor", `${profileMain.provider}/${profileMain.id}`]]),
		});

		expect(materialized).toBe(false);
		expect(session.getConfiguredModelChainState("default")).toMatchObject({ origin: "startup-override" });
		expect(settings.getGlobal("modelProfile.default")).toBe("glm-eco");
		expect(settings.getGlobal("modelRoles")).toBeUndefined();
	});

	it("cancels a guarded profile model change after a newer user selection", async () => {
		const { base, profileMain } = resolveModels();
		session = makeSession(base);
		const apiKey = Promise.withResolvers<string | undefined>();
		const getApiKey = spyOn(modelRegistry, "getApiKey").mockImplementation(() => apiKey.promise);
		let selectionIsCurrent = true;
		let mutationStarted = false;

		try {
			const activation = session.setModelTemporary(profileMain, undefined, {
				cause: "profile-activation",
				shouldMutate: () => selectionIsCurrent,
				onMutationStarted: () => {
					mutationStarted = true;
				},
			});
			selectionIsCurrent = false;
			apiKey.resolve("test-key");
			await activation;

			expect(session.model).toEqual(base);
			expect(mutationStarted).toBe(false);
		} finally {
			getApiKey.mockRestore();
		}
	});

	it("restores prior fallback state when profile model mutation is canceled", async () => {
		const { base } = resolveModels();
		session = makeSession(base);
		session.setConfiguredModelChain("default", ["openai-codex/gpt-5.5"], "model_selection", "explicit", true);
		session.setDefaultFallbackRuntimeModel("openai-codex/gpt-5.5");
		const previousChain = session.getConfiguredModelChainState("default");
		const previousFallbackState = session.getDefaultFallbackRuntimeState();
		const apiKey = Promise.withResolvers<string | undefined>();
		const mutationWaiting = Promise.withResolvers<void>();
		const getApiKey = spyOn(modelRegistry, "getApiKey").mockImplementation(() => {
			mutationWaiting.resolve();
			return apiKey.promise;
		});
		const selectionRevision = session.getUserModelSelectionRevision();

		try {
			const activation = activateModelProfile(
				{ session, modelRegistry, settings: session.settings, profileName: "claude-opus" },
				{ isCurrent: () => session.getUserModelSelectionRevision() === selectionRevision },
			);
			await mutationWaiting.promise;
			session.markUserModelSelection();
			apiKey.resolve("test-key");
			await activation;

			expect(session.model).toEqual(base);
			expect(session.getConfiguredModelChainState("default")).toEqual(previousChain);
			expect(session.getDefaultFallbackRuntimeState()).toEqual(previousFallbackState);
			expect(session.getActiveModelProfile()).toBeUndefined();
		} finally {
			getApiKey.mockRestore();
		}
	});

	it("keeps a transient switch as role=temporary so resume does not adopt it", async () => {
		const { base, profileMain } = resolveModels();
		session = makeSession(base);

		await session.setModel(base);
		// No persistAsSessionDefault: simulates a retry/fallback/plan-mode switch.
		await session.setModelTemporary(profileMain);

		expect(session.model?.provider).toBe("anthropic");
		expect(session.model?.id).toBe("claude-opus-5-5");
		// Resume still restores the explicit base default, not the transient model.
		expect(session.sessionManager.buildSessionContext().models.default).toBe("openai-codex/gpt-5.5");
	});

	it("restores an in-memory runtime fallback chain without persisting it", () => {
		const { base } = resolveModels();
		session = makeSession(base);
		session.setDefaultFallbackRuntimeModel("anthropic/claude-opus-5:high");
		const snapshot = session.getDefaultFallbackRuntimeState();
		expect(snapshot.chain).toEqual({
			role: "default",
			entries: ["anthropic/claude-opus-5:high"],
			origin: "runtime",
			explicitHead: true,
		});

		session.setConfiguredModelChain("default", ["openai-codex/gpt-5.5"], "model_profile", "profile-a");
		session.restoreDefaultFallbackRuntimeState(snapshot);

		expect(session.getDefaultFallbackRuntimeState().chain).toEqual(snapshot.chain);
		expect(session.getConfiguredModelChain("default")).toEqual(["openai-codex/gpt-5.5"]);
	});

	it("preserves a restored runtime fallback chain during model rollback", async () => {
		const { base } = resolveModels();
		session = makeSession(base);
		session.setDefaultFallbackRuntimeModel("anthropic/claude-opus-5:high");
		const snapshot = session.getDefaultFallbackRuntimeState();

		// Mirror SelectorController.#restoreDefaultAssignmentRollback: restore the
		// fallback snapshot before restoring the live model.
		session.setDefaultFallbackRuntimeModel("openai-codex/gpt-5.5");
		session.restoreDefaultFallbackRuntimeState(snapshot);
		await session.restoreModelSelectionForRollback(base, undefined);

		expect(session.getDefaultFallbackRuntimeState().chain).toEqual(snapshot.chain);
	});

	it("rollback of a failed activation restores the pre-activation resume default, not the transient live model", async () => {
		// A = persisted resume default, B = transient live model (e.g. retry/
		// fallback/plan switch), profileMain = the profile's main model the failed
		// activation already recorded as the session default before throwing.
		const base = modelRegistry.find("openai-codex", "gpt-5.5");
		const transient = modelRegistry.find("anthropic", "claude-sonnet-4-6");
		const profileMain = modelRegistry.find("anthropic", "claude-opus-5-5");
		if (!base || !transient || !profileMain) {
			throw new Error("Expected codex gpt-5.5 + anthropic sonnet/opus models to exist");
		}
		session = makeSession(base);

		// Persisted resume default A.
		await session.setModel(base);
		// Transient switch to B (role=temporary): resume default stays A (#849).
		await session.setModelTemporary(transient);
		expect(session.sessionManager.buildSessionContext().models.default).toBe("openai-codex/gpt-5.5");
		expect(session.model?.id).toBe("claude-sonnet-4-6");
		const globalProfileDefaultBefore = session.settings.get("modelProfile.default");

		// Prepare snapshots the pre-activation state: the live model is B, but the
		// resume default is A — captured separately.
		const prepared = await prepareModelProfileActivation({
			session,
			modelRegistry,
			settings: session.settings,
			profileName: "opus-codex",
		});
		expect(prepared.previousModel?.id).toBe("claude-sonnet-4-6");
		expect(prepared.previousSessionDefaultModel).toBe("openai-codex/gpt-5.5");
		expect(prepared.defaultModel?.id).toBe("claude-opus-5-5");

		// Force the activation to fail after the live model changes but before the
		// profile main model is committed as the session resume default.
		prepared.settings = new Proxy(session.settings, {
			get(target, prop, receiver) {
				if (prop === "override") {
					return () => {
						throw new Error("simulated activation failure after model change");
					};
				}
				const value = Reflect.get(target, prop, receiver);
				return typeof value === "function" ? value.bind(target) : value;
			},
		}) as typeof prepared.settings;

		await expect(applyPreparedModelProfileActivation(prepared)).rejects.toThrow(
			"simulated activation failure after model change",
		);

		// Resume default remains A: the failed profile main model did not poison it,
		// and the transient live model B was NOT promoted to the resume default.
		expect(session.sessionManager.buildSessionContext().models.default).toBe("openai-codex/gpt-5.5");
		// Runtime rollback is intentional: the live model returns to B as temporary.
		expect(session.model?.id).toBe("claude-sonnet-4-6");
		expect(session.sessionManager.buildSessionContext().models.temporary).toBe("anthropic/claude-sonnet-4-6");
		// Apply-for-this-session setting untouched.
		expect(session.settings.get("modelProfile.default")).toBe(globalProfileDefaultBefore);
	});
	it("replaces a configured fallback chain when the user explicitly selects a default model", async () => {
		const { base } = resolveModels();
		session = makeSession(base);

		// Simulate a profile-activated configured chain [A, B].
		session.setConfiguredModelChain(
			"default",
			["anthropic/claude-opus-5", "openai-codex/gpt-5.5"],
			"profile-activation",
		);
		expect(session.getConfiguredModelChain("default")).toEqual(["anthropic/claude-opus-5", "openai-codex/gpt-5.5"]);

		// Explicit user selection of C supersedes the stale chain: resume and
		// snapshots must follow the latest choice, without the old tail.
		await session.setModel(base);
		expect(session.getConfiguredModelChain("default")).toEqual(["openai-codex/gpt-5.5"]);
		expect(session.sessionManager.buildSessionContext().models.default).toBe("openai-codex/gpt-5.5");
	});
});
