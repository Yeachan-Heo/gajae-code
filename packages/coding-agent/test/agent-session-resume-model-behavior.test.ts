import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@gajae-code/agent-core";
import { Effort, getBundledModel, type Model } from "@gajae-code/ai";
import type { ModelProfileDefinition } from "@gajae-code/coding-agent/config/model-profiles";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { TempDir } from "@gajae-code/utils";

// Coverage for `session.resumeModelBehavior`: by default (`keepSessionModel`),
// resuming a session restores the model the session last used, even if the
// global default model has since changed. With `useCurrentDefault`, resume
// instead picks up whatever `modelRoles.default` currently resolves to.
describe("AgentSession switchSession resumeModelBehavior", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	let targetSession: AgentSession | undefined;
	let modelRegistry: ModelRegistry;
	let authStorage: AuthStorage;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-resume-model-behavior-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		if (targetSession) {
			await targetSession.dispose();
			targetSession = undefined;
		}
		if (session) {
			await session.dispose();
		}
		authStorage.close();
		tempDir.removeSync();
	});

	async function createPersistedTarget(model: Model, settings: Settings): Promise<string> {
		targetSession = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings,
			modelRegistry,
		});
		await targetSession.setModel(model);
		targetSession.agent.appendMessage({ role: "user", content: "saved resume message", timestamp: Date.now() });
		targetSession.setConfiguredModelChain("default", [`${model.provider}/${model.id}`], "legacy_session");
		const sessionFile = targetSession.sessionFile;
		if (!sessionFile) throw new Error("Expected persisted target session");
		await targetSession.sessionManager.ensureOnDisk();
		await targetSession.sessionManager.flush();
		return sessionFile;
	}

	it("keeps the session's saved model by default when the global default changes", async () => {
		const sonnet = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		const agent = new Agent({ initialState: { model: sonnet, systemPrompt: ["Test"], tools: [], messages: [] } });
		const settings = Settings.isolated({ "compaction.enabled": false });
		session = new AgentSession({ agent, sessionManager, settings, modelRegistry });

		await session.setModel(sonnet);
		const sessionFile = session.sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");
		await session.sessionManager.flush();

		// Global default changes after the session was recorded.
		settings.setModelRole("default", "anthropic/claude-opus-4-8");

		expect(await session.switchSession(sessionFile)).toBe(true);
		expect(session.model?.id).toBe("claude-sonnet-4-5");
	});

	it("adopts the currently configured default model when resumeModelBehavior is useCurrentDefault", async () => {
		const sonnet = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const opus = getBundledModel("anthropic", "claude-opus-4-8")!;
		const sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		const agent = new Agent({ initialState: { model: sonnet, systemPrompt: ["Test"], tools: [], messages: [] } });
		const settings = Settings.isolated({ "compaction.enabled": false });
		session = new AgentSession({ agent, sessionManager, settings, modelRegistry });

		await session.setModel(sonnet);
		const sessionFile = session.sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");
		await session.sessionManager.flush();

		settings.setModelRole("default", "anthropic/claude-opus-4-8");
		settings.set("session.resumeModelBehavior", "useCurrentDefault");

		expect(await session.switchSession(sessionFile)).toBe(true);
		expect(session.model?.id).toBe(opus.id);
	});

	it("retains a session-only active profile when useCurrentDefault reloads its runtime defaults", async () => {
		const sonnet = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const opus = getBundledModel("anthropic", "claude-opus-4-8")!;
		const sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		const agent = new Agent({ initialState: { model: sonnet, systemPrompt: ["Test"], tools: [], messages: [] } });
		const settings = Settings.isolated({ "compaction.enabled": false });
		session = new AgentSession({ agent, sessionManager, settings, modelRegistry });

		await session.setModel(sonnet);
		const sessionFile = session.sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");
		await session.sessionManager.flush();

		settings.override("modelRoles", { default: "anthropic/claude-opus-4-8" });
		settings.set("session.resumeModelBehavior", "useCurrentDefault");
		session.setActiveModelProfile("codex-medium");

		expect(await session.switchSession(sessionFile)).toBe(true);
		expect(session.model?.id).toBe(opus.id);
		expect(session.getActiveModelProfile()).toBe("codex-medium");
	});
	it("clears predecessor session-only profile roles before resolving a cross-file current default", async () => {
		const sonnet = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const opus = getBundledModel("anthropic", "claude-opus-4-8")!;
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"modelProfile.default": "opus-codex",
			"session.resumeModelBehavior": "useCurrentDefault",
		});
		const sessionFile = await createPersistedTarget(sonnet, settings);
		session = new AgentSession({
			agent: new Agent({ initialState: { model: sonnet, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings,
			modelRegistry,
		});

		settings.override("modelRoles", { default: `${opus.provider}/${opus.id}` });
		settings.override("task.agentModelOverrides", { executor: `${opus.provider}/${opus.id}` });
		session.setActiveModelProfile("codex-medium");
		session.noteProfileInstalledOverrides(["default"], ["executor"], sonnet);

		expect(await session.switchSession(sessionFile)).toBe(true);
		expect(session.model?.id).toBe(sonnet.id);
		expect(session.getActiveModelProfile()).toBe("opus-codex");
		expect(settings.getOverride("modelRoles")).toEqual({ default: `${sonnet.provider}/${sonnet.id}` });
		expect(settings.getOverride("task.agentModelOverrides")).toEqual({});
	});

	it("retains a matching durable profile's runtime role layer across a cross-file resume", async () => {
		const sonnet = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const opus = getBundledModel("anthropic", "claude-opus-4-8")!;
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"modelProfile.default": "opus-codex",
			"session.resumeModelBehavior": "useCurrentDefault",
		});
		const sessionFile = await createPersistedTarget(sonnet, settings);
		session = new AgentSession({
			agent: new Agent({ initialState: { model: sonnet, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings,
			modelRegistry,
		});
		const modelRoles = { default: `${sonnet.provider}/${sonnet.id}`, planner: `${opus.provider}/${opus.id}` };
		const agentModelOverrides = { executor: `${opus.provider}/${opus.id}` };
		settings.override("modelRoles", modelRoles);
		settings.override("task.agentModelOverrides", agentModelOverrides);
		session.setActiveModelProfile("opus-codex");
		session.noteProfileInstalledOverrides(["default", "planner"], ["executor"], sonnet);

		expect(await session.switchSession(sessionFile)).toBe(true);
		expect(session.getActiveModelProfile()).toBe("opus-codex");
		expect(settings.getOverride("modelRoles")).toEqual(modelRoles);
		expect(settings.getOverride("task.agentModelOverrides")).toEqual(agentModelOverrides);
	});

	it("restores predecessor profile state when target current-default resolution fails", async () => {
		const sonnet = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const opus = getBundledModel("anthropic", "claude-opus-4-8")!;
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"session.resumeModelBehavior": "useCurrentDefault",
		});
		const sessionFile = await createPersistedTarget(sonnet, settings);
		session = new AgentSession({
			agent: new Agent({ initialState: { model: sonnet, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings,
			modelRegistry,
		});
		const modelRolesOverride = { default: `${opus.provider}/${opus.id}` };
		const agentOverridesOverride = { executor: `${opus.provider}/${opus.id}` };
		settings.override("modelRoles", modelRolesOverride);
		settings.override("task.agentModelOverrides", agentOverridesOverride);
		session.setActiveModelProfile("codex-medium");
		session.noteProfileInstalledOverrides(["default"], ["executor"], sonnet);
		vi.spyOn(modelRegistry, "getAvailable").mockReturnValue([]);
		vi.spyOn(modelRegistry, "getAll").mockReturnValue([]);

		expect(await session.switchSession(sessionFile)).toBe(false);
		expect(session.getActiveModelProfile()).toBe("codex-medium");
		expect(settings.getOverride("modelRoles")).toEqual(modelRolesOverride);
		expect(settings.getOverride("task.agentModelOverrides")).toEqual(agentOverridesOverride);
		expect(session.getProfileInstalledOverrideKeys()).toEqual({
			modelRoles: ["default"],
			agentModelOverrides: ["executor"],
		});
	});

	it("does not recover the durable preset when useCurrentDefault cannot resolve the live default", async () => {
		const sonnet = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const codex = getBundledModel("openai-codex", "gpt-5.6-sol")!;
		authStorage.setRuntimeApiKey("openai-codex", "test-key");
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"modelProfile.default": "codex-medium",
			"session.resumeModelBehavior": "useCurrentDefault",
		});
		const sessionFile = await createPersistedTarget(sonnet, settings);
		session = new AgentSession({
			agent: new Agent({ initialState: { model: sonnet, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings,
			modelRegistry,
		});
		settings.setModelRole("default", "unknown-provider/unknown-model");
		vi.spyOn(modelRegistry, "getAvailable").mockReturnValue([codex]);
		vi.spyOn(modelRegistry, "getAll").mockReturnValue([codex]);
		const notice = vi.spyOn(session, "emitNotice");

		expect(await session.switchSession(sessionFile)).toBe(false);
		expect(session.getDefaultFallbackRuntimeState().chain).not.toMatchObject({
			origin: "runtime",
			identity: "codex-medium",
		});
		expect(notice).not.toHaveBeenCalledWith(
			"warning",
			"Saved session model is no longer registered; restored the durable default preset instead.",
			"fallback",
		);
	});

	it("preserves an unknown identity-bearing saved chain and recovered runtime fallback across different-file cleanup", async () => {
		const sonnet = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const codex = getBundledModel("openai-codex", "gpt-5.6-sol")!;
		authStorage.setRuntimeApiKey("openai-codex", "test-key");
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"modelProfile.default": "codex-medium",
			"session.resumeModelBehavior": "keepSessionModel",
		});
		const sessionFile = await createPersistedTarget(sonnet, settings);
		targetSession!.setConfiguredModelChain(
			"default",
			[`${sonnet.provider}/${sonnet.id}`],
			"profile-activation",
			"removed-profile",
		);
		await targetSession!.sessionManager.ensureOnDisk();

		session = new AgentSession({
			agent: new Agent({ initialState: { model: sonnet, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings,
			modelRegistry,
		});
		vi.spyOn(modelRegistry, "getAvailable").mockReturnValue([codex]);
		vi.spyOn(modelRegistry, "getAll").mockReturnValue([codex]);
		const setConfiguredChain = vi.spyOn(session, "setConfiguredModelChain");
		const ensureOnDisk = vi.spyOn(session.sessionManager, "ensureOnDisk");
		const notice = vi.spyOn(session, "emitNotice");

		expect(await session.switchSession(sessionFile)).toBe(true);
		expect(session.model?.id).toBe(codex.id);
		expect(session.getConfiguredModelChainState("default")).toEqual({
			entries: [`${sonnet.provider}/${sonnet.id}`],
			origin: "profile-activation",
			identity: "removed-profile",
			explicitHead: true,
		});
		expect(session.getDefaultFallbackRuntimeState().chain).toMatchObject({
			entries: [`${codex.provider}/${codex.id}:low`],
			origin: "runtime",
			identity: "codex-medium",
		});
		expect(setConfiguredChain).not.toHaveBeenCalled();
		expect(notice).toHaveBeenCalledWith(
			"warning",
			"Saved session model is no longer registered; restored the durable default preset instead.",
			"fallback",
		);
		const commitOrder = ensureOnDisk.mock.invocationCallOrder.at(-1);
		const warningOrder = notice.mock.invocationCallOrder.at(-1);
		if (commitOrder === undefined || warningOrder === undefined) throw new Error("Expected commit and warning calls");
		expect(commitOrder).toBeLessThan(warningOrder);
	});

	it.each([
		"user",
		"registry",
	] as const)("rolls back without durable fallback when the %s durable profile has an unresolved qualified executor", async source => {
		const sonnet = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const codex = getBundledModel("openai-codex", "gpt-5.6-sol")!;
		authStorage.setRuntimeApiKey("openai-codex", "test-key");
		const profile: ModelProfileDefinition = {
			name: `${source}-resume-unresolved-executor`,
			requiredProviders: ["openai-codex"],
			modelMapping: {
				default: `${codex.provider}/${codex.id}`,
				executor: "openai-codex/missing-executor",
			},
			source,
		};
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"modelProfile.default": profile.name,
			"session.resumeModelBehavior": "keepSessionModel",
		});
		const sessionFile = await createPersistedTarget(sonnet, settings);
		targetSession!.setConfiguredModelChain(
			"default",
			[`${sonnet.provider}/${sonnet.id}`],
			"profile-activation",
			"removed-profile",
		);
		await targetSession!.sessionManager.ensureOnDisk();
		session = new AgentSession({
			agent: new Agent({ initialState: { model: sonnet, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings,
			modelRegistry,
		});
		vi.spyOn(modelRegistry, "getAvailable").mockReturnValue([codex]);
		vi.spyOn(modelRegistry, "getAll").mockReturnValue([codex]);
		vi.spyOn(modelRegistry, "getModelProfiles").mockReturnValue(new Map([[profile.name, profile]]));
		vi.spyOn(modelRegistry, "getModelProfile").mockImplementation(name =>
			name === profile.name ? profile : undefined,
		);
		const notice = vi.spyOn(session, "emitNotice");

		expect(await session.switchSession(sessionFile)).toBe(false);
		expect(session.model?.id).toBe(sonnet.id);
		expect(session.getDefaultFallbackRuntimeState().chain).not.toMatchObject({
			origin: "runtime",
			identity: profile.name,
		});
		expect(notice).not.toHaveBeenCalledWith(
			"warning",
			"Saved session model is no longer registered; restored the durable default preset instead.",
			"fallback",
		);
		expect(notice).toHaveBeenCalledWith(
			"error",
			expect.stringContaining("missing-executor"),
			"fallback",
		);
	});

	it("fails without rewriting the saved chain when the durable default is unavailable", async () => {
		const sonnet = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"modelProfile.default": "codex-medium",
			"session.resumeModelBehavior": "keepSessionModel",
		});
		const sessionFile = await createPersistedTarget(sonnet, settings);
		targetSession!.setConfiguredModelChain(
			"default",
			[`${sonnet.provider}/${sonnet.id}`],
			"profile-activation",
			"removed-profile",
		);
		await targetSession!.sessionManager.ensureOnDisk();
		session = new AgentSession({
			agent: new Agent({ initialState: { model: sonnet, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings,
			modelRegistry,
		});
		vi.spyOn(modelRegistry, "getAvailable").mockReturnValue([]);
		vi.spyOn(modelRegistry, "getAll").mockReturnValue([]);
		const setConfiguredChain = vi.spyOn(session, "setConfiguredModelChain");

		expect(await session.switchSession(sessionFile)).toBe(false);
		expect(targetSession!.getConfiguredModelChainState("default")).toEqual({
			entries: [`${sonnet.provider}/${sonnet.id}`],
			origin: "profile-activation",
			identity: "removed-profile",
			explicitHead: true,
		});
		expect(setConfiguredChain).not.toHaveBeenCalled();
	});

	it("does not recover a saved selector that still exists in the full catalog", async () => {
		const sonnet = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"modelProfile.default": "codex-medium",
			"session.resumeModelBehavior": "keepSessionModel",
		});
		const sessionFile = await createPersistedTarget(sonnet, settings);
		// The saved configured selector is stale, but the concrete last-used
		// model remains registered. Recovery must not replace it with the durable
		// profile merely because the selector alias disappeared.
		targetSession!.setConfiguredModelChain("default", ["removed/alias"], "legacy_session");
		await targetSession!.sessionManager.ensureOnDisk();

		session = new AgentSession({
			agent: new Agent({ initialState: { model: sonnet, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings,
			modelRegistry,
		});
		vi.spyOn(modelRegistry, "getAvailable").mockReturnValue([]);
		vi.spyOn(modelRegistry, "getAll").mockReturnValue([sonnet]);
		const recover = vi.spyOn(modelRegistry, "getModelProfile");

		expect(await session.switchSession(sessionFile)).toBe(false);
		expect(recover).not.toHaveBeenCalled();
	});

	it("does not recover a bare saved alias that remains registered but unavailable", async () => {
		const registeredAlias = {
			...getBundledModel("anthropic", "claude-sonnet-4-5")!,
			provider: "disabled-provider",
			id: "catalog/registered-alias",
		};
		const removedModel = getBundledModel("anthropic", "claude-opus-4-8")!;
		const codex = getBundledModel("openai-codex", "gpt-5.6-sol")!;
		authStorage.setRuntimeApiKey("openai-codex", "test-key");
		const profile: ModelProfileDefinition = {
			name: "bare-alias-durable-default",
			requiredProviders: ["openai-codex"],
			modelMapping: { default: `${codex.provider}/${codex.id}` },
			source: "user",
		};
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"modelProfile.default": profile.name,
			"session.resumeModelBehavior": "keepSessionModel",
		});
		const sessionFile = await createPersistedTarget(removedModel, settings);
		targetSession!.setConfiguredModelChain(
			"default",
			["registered-alias"],
			"profile-activation",
			profile.name,
		);
		await targetSession!.sessionManager.ensureOnDisk();
		session = new AgentSession({
			agent: new Agent({ initialState: { model: removedModel, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings,
			modelRegistry,
		});
		vi.spyOn(modelRegistry, "getAvailable").mockReturnValue([codex]);
		vi.spyOn(modelRegistry, "getAll").mockReturnValue([registeredAlias, codex]);
		vi.spyOn(modelRegistry, "getModelProfiles").mockReturnValue(new Map([[profile.name, profile]]));
		vi.spyOn(modelRegistry, "getModelProfile").mockImplementation(name =>
			name === profile.name ? profile : undefined,
		);
		vi.spyOn(modelRegistry, "lookupAliasExists").mockReturnValue(true);
		vi.spyOn(modelRegistry, "resolveModelByLookupAlias").mockReturnValue(undefined);
		const notice = vi.spyOn(session, "emitNotice");

		expect(await session.switchSession(sessionFile)).toBe(false);
		expect(notice).not.toHaveBeenCalledWith(
			"warning",
			"Saved session model is no longer registered; restored the durable default preset instead.",
			"fallback",
		);
	});

	it("restore shares one thinking-level rule: no stray thinking_level_change, recompute from defaultThinkingLevel", async () => {
		const sonnet = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const settings = Settings.isolated({ "compaction.enabled": false, defaultThinkingLevel: Effort.Medium });

		// Session A persists a default chain whose selector carries an explicit
		// `:low` suffix. Its branch has no thinking_level_change entry of its own.
		const sessionA = new AgentSession({
			agent: new Agent({
				initialState: {
					model: sonnet,
					systemPrompt: ["Test"],
					tools: [],
					messages: [],
					thinkingLevel: Effort.High,
				},
			}),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings,
			modelRegistry,
		});
		sessionA.setConfiguredModelChain("default", [`${sonnet.provider}/${sonnet.id}:low`], "test");
		const sessionFileA = sessionA.sessionManager.getSessionFile();
		if (!sessionFileA) throw new Error("Expected session file");
		await sessionA.sessionManager.ensureOnDisk();
		await sessionA.sessionManager.flush();
		await sessionA.dispose();

		// A different session restores A's file.
		session = new AgentSession({
			agent: new Agent({
				initialState: {
					model: sonnet,
					systemPrompt: ["Test"],
					tools: [],
					messages: [],
					thinkingLevel: Effort.Minimal,
				},
			}),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings,
			modelRegistry,
		});
		const setThinkingLevel = vi.spyOn(AgentSession.prototype, "setThinkingLevel");
		const appendThinkingLevelChange = vi.spyOn(SessionManager.prototype, "appendThinkingLevelChange");

		expect(await session.switchSession(sessionFileA)).toBe(true);

		// Restore applies one rule at all chain-resolution sites: the unconditional
		// recompute from defaultThinkingLevel. The resolved `:low` suffix must not
		// be written through setThinkingLevel — that appended a stray
		// thinking_level_change entry, flipped the recompute's hasThinkingEntry,
		// and restored the wrong level (observed: `minimal` instead of `medium`).
		expect(setThinkingLevel).not.toHaveBeenCalled();
		expect(appendThinkingLevelChange).not.toHaveBeenCalled();
		expect(session.thinkingLevel).toBe(Effort.Medium);
	});
});
