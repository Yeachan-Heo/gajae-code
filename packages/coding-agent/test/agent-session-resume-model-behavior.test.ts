import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent, ThinkingLevel } from "@gajae-code/agent-core";
import { Effort, getBundledModel, type Model } from "@gajae-code/ai";
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
		targetSession.setConfiguredModelChain("default", [`${model.provider}/${model.id}`], "legacy_session");
		const sessionFile = targetSession.sessionFile;
		if (!sessionFile) throw new Error("Expected persisted target session");
		await targetSession.sessionManager.ensureOnDisk();
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

	it("uses the resolved multi-entry settings chain for useCurrentDefault fallback", async () => {
		const sonnet = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"session.resumeModelBehavior": "useCurrentDefault",
		});
		const sessionFile = await createPersistedTarget(sonnet, settings);
		targetSession!.setConfiguredModelChain("default", ["unknown-provider/saved-model"], "legacy_session");
		await targetSession!.sessionManager.flush();
		const configuredEntries = ["unknown-provider/current-model", `${sonnet.provider}/${sonnet.id}`];
		settings.override("modelRoles", { default: configuredEntries });

		session = new AgentSession({
			agent: new Agent({ initialState: { model: sonnet, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings,
			modelRegistry,
		});

		expect(await session.switchSession(sessionFile)).toBe(true);
		expect(session.model?.id).toBe(sonnet.id);
		expect(session.getDefaultFallbackRuntimeState().chain.entries).toEqual(configuredEntries);
		expect(session.getConfiguredModelChainState("default")).toMatchObject({
			entries: ["unknown-provider/saved-model"],
			origin: "legacy_session",
		});
	});

	it("cleans a predecessor session profile before resolving useCurrentDefault", async () => {
		const sonnet = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const opus = getBundledModel("anthropic", "claude-opus-4-8")!;
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"session.resumeModelBehavior": "useCurrentDefault",
		});
		const sessionFile = await createPersistedTarget(sonnet, settings);
		settings.setModelRole("default", `${opus.provider}/${opus.id}`);

		session = new AgentSession({
			agent: new Agent({ initialState: { model: sonnet, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings,
			modelRegistry,
		});
		settings.override("modelRoles", { default: "unknown-provider/predecessor-model" });
		session.setActiveModelProfile("session-only-profile", "session");
		session.noteProfileInstalledOverrides(["default"], [], sonnet, { default: `${opus.provider}/${opus.id}` });
		expect(settings.getModelRole("default")).toBe("unknown-provider/predecessor-model");

		expect(await session.switchSession(sessionFile)).toBe(true);
		expect(session.model?.id).toBe(opus.id);
		expect(session.getActiveModelProfile()).toBeUndefined();
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
		await targetSession!.sessionManager.flush();

		session = new AgentSession({
			agent: new Agent({ initialState: { model: sonnet, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings,
			modelRegistry,
		});
		settings.override("modelRoles", { reviewer: `${sonnet.provider}/${sonnet.id}` });
		session.setActiveModelProfile("session-only-profile");
		session.noteProfileInstalledOverrides(["reviewer"], [], sonnet);
		vi.spyOn(modelRegistry, "getAvailable").mockReturnValue([codex]);
		vi.spyOn(modelRegistry, "getAll").mockReturnValue([codex]);
		const setConfiguredChain = vi.spyOn(session, "setConfiguredModelChain");
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
		expect(settings.get("modelRoles").reviewer).toBeUndefined();
		expect(setConfiguredChain).not.toHaveBeenCalled();
		expect(notice).toHaveBeenCalledWith(
			"warning",
			"Saved session model is no longer registered; restored the durable default preset instead.",
			"fallback",
		);
	});

	it("does not materialize current settings into a legacy saved chain during recovery", async () => {
		const sonnet = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const codex = getBundledModel("openai-codex", "gpt-5.6-sol")!;
		authStorage.setRuntimeApiKey("openai-codex", "test-key");
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"modelProfile.default": "codex-medium",
			"session.resumeModelBehavior": "keepSessionModel",
		});
		const sessionFile = await createPersistedTarget(sonnet, settings);

		session = new AgentSession({
			agent: new Agent({ initialState: { model: sonnet, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings,
			modelRegistry,
		});
		settings.override("modelRoles", {
			default: ["anthropic/removed-model", `${codex.provider}/${codex.id}`],
		});
		vi.spyOn(modelRegistry, "getAvailable").mockReturnValue([codex]);
		vi.spyOn(modelRegistry, "getAll").mockReturnValue([codex]);
		const setConfiguredChain = vi.spyOn(session, "setConfiguredModelChain");

		expect(await session.switchSession(sessionFile)).toBe(true);
		expect(session.model?.id).toBe(codex.id);
		expect(session.getConfiguredModelChainState("default")).toEqual({
			entries: [`${sonnet.provider}/${sonnet.id}`],
			origin: "legacy_session",
			explicitHead: true,
		});
		expect(setConfiguredChain).not.toHaveBeenCalled();
	});

	it("publishes a listener-visible event for a normal saved-chain fallback", async () => {
		const sonnet = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const codex = getBundledModel("openai-codex", "gpt-5.6-sol")!;
		authStorage.setRuntimeApiKey("openai-codex", "test-key");
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"session.resumeModelBehavior": "keepSessionModel",
		});
		const sessionFile = await createPersistedTarget(sonnet, settings);
		const unknownSelector = "missing-provider/missing-model";
		targetSession!.setConfiguredModelChain("default", [unknownSelector, `${codex.provider}/${codex.id}`], "test");
		await targetSession!.sessionManager.flush();

		session = new AgentSession({
			agent: new Agent({ initialState: { model: sonnet, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings,
			modelRegistry,
		});
		vi.spyOn(modelRegistry, "getAvailable").mockReturnValue([codex]);
		vi.spyOn(modelRegistry, "getAll").mockReturnValue([codex]);
		const fallbackEvents: Array<Record<string, unknown>> = [];
		session.subscribe(event => {
			if (event.type === "model_fallback_switched") fallbackEvents.push(event);
		});

		expect(await session.switchSession(sessionFile)).toBe(true);
		expect(fallbackEvents).toHaveLength(1);
		expect(fallbackEvents[0]).toMatchObject({
			from: unknownSelector,
			to: `${codex.provider}/${codex.id}`,
			reason: "resolution",
			role: "default",
			scope: "session",
			activeIndex: 1,
			chainLength: 2,
			attemptsUsed: 0,
		});
	});

	it("does not mask strict durable-profile provider failures during recovery", async () => {
		const sonnet = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const codex = getBundledModel("openai-codex", "gpt-5.6-sol")!;
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"modelProfile.default": "codex-medium",
			"session.resumeModelBehavior": "keepSessionModel",
		});
		const sessionFile = await createPersistedTarget(sonnet, settings);

		session = new AgentSession({
			agent: new Agent({ initialState: { model: sonnet, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings,
			modelRegistry,
		});
		vi.spyOn(modelRegistry, "getAvailable").mockReturnValue([codex]);
		vi.spyOn(modelRegistry, "getAll").mockReturnValue([codex]);
		vi.spyOn(modelRegistry, "getApiKeyForProvider").mockImplementation(async provider => {
			if (provider === "openai-codex") throw new Error("required provider lookup failed");
			return "test-key";
		});

		await expect(session.switchSession(sessionFile)).rejects.toThrow("required provider lookup failed");
	});

	it("does not mask strict proxy failures during recovery", async () => {
		const sonnet = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const codex = getBundledModel("openai-codex", "gpt-5.6-sol")!;
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"modelProfile.default": "codex-medium",
			"modelProfile.proxyMode": "always",
			"modelProfile.proxyProvider": "proxy",
			"session.resumeModelBehavior": "keepSessionModel",
		});
		const sessionFile = await createPersistedTarget(sonnet, settings);

		session = new AgentSession({
			agent: new Agent({ initialState: { model: sonnet, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings,
			modelRegistry,
		});
		vi.spyOn(modelRegistry, "getAvailable").mockReturnValue([codex]);
		vi.spyOn(modelRegistry, "getAll").mockReturnValue([codex]);
		vi.spyOn(modelRegistry, "getConfiguredProviderIds").mockReturnValue(["proxy"]);
		vi.spyOn(modelRegistry, "getApiKeyForProvider").mockImplementation(async provider => {
			if (provider === "proxy") throw new Error("proxy provider lookup failed");
			return "test-key";
		});

		await expect(session.switchSession(sessionFile)).rejects.toThrow("proxy provider lookup failed");
	});

	it("does not mask an unresolved durable profile default as saved-chain exhaustion", async () => {
		const sonnet = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const codex = getBundledModel("openai-codex", "gpt-5.6-sol")!;
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"modelProfile.default": "broken-profile",
			"session.resumeModelBehavior": "keepSessionModel",
		});
		const sessionFile = await createPersistedTarget(sonnet, settings);
		session = new AgentSession({
			agent: new Agent({ initialState: { model: sonnet, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings,
			modelRegistry,
		});
		const profiles = new Map(modelRegistry.getModelProfiles());
		profiles.set("broken-profile", {
			name: "broken-profile",
			requiredProviders: [],
			modelMapping: { default: "missing-provider/missing-model" },
			source: "user",
		});
		vi.spyOn(modelRegistry, "getModelProfiles").mockReturnValue(profiles);
		vi.spyOn(modelRegistry, "getAvailable").mockReturnValue([codex]);
		vi.spyOn(modelRegistry, "getAll").mockReturnValue([codex]);

		await expect(session.switchSession(sessionFile)).rejects.toThrow(
			'Model profile "broken-profile" default selectors do not match any catalog model',
		);
	});

	it("restores predecessor profile cleanup state when successor persistence fails", async () => {
		const sonnet = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const settings = Settings.isolated({ "compaction.enabled": false });
		const sessionFile = await createPersistedTarget(sonnet, settings);
		session = new AgentSession({
			agent: new Agent({ initialState: { model: sonnet, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings,
			modelRegistry,
		});
		settings.override("modelRoles", { reviewer: `${sonnet.provider}/${sonnet.id}` });
		settings.override("task.agentModelOverrides", { executor: `${sonnet.provider}/${sonnet.id}` });
		session.setActiveModelProfile("session-only-profile");
		session.noteProfileInstalledOverrides(["reviewer"], ["executor"], sonnet);
		session.setDefaultFallbackRuntimeModel(`${sonnet.provider}/${sonnet.id}:low`);
		const fallbackState = session.getDefaultFallbackRuntimeState();
		session.restoreDefaultFallbackRuntimeState({
			chain: {
				...fallbackState.chain,
				entries: [`${sonnet.provider}/${sonnet.id}:low`, `${sonnet.provider}/${sonnet.id}:high`],
				identity: "predecessor-profile",
			},
			controller: {
				...fallbackState.controller,
				activeIndex: 1,
				attemptsUsed: 2,
				totalAttemptsUsed: 3,
				attemptStarted: true,
				restoredEntryIndices: [0],
				tried: [
					{
						selector: `${sonnet.provider}/${sonnet.id}:low`,
						triggerClass: "unknown",
						reason: "previous failure",
					},
				],
				skips: [{ selector: `${sonnet.provider}/${sonnet.id}:low`, reason: "previous skip" }],
				exhaustedForTurn: false,
			},
			exhaustedLastTurn: true,
		});
		const previousFallbackState = session.getDefaultFallbackRuntimeState();
		vi.spyOn(session.sessionManager, "ensureOnDisk").mockRejectedValueOnce(new Error("disk commit failed"));

		await expect(session.switchSession(sessionFile)).rejects.toThrow("disk commit failed");
		expect(session.getActiveModelProfile()).toBe("session-only-profile");
		expect(session.getProfileInstalledOverrideKeys()).toEqual({
			modelRoles: ["reviewer"],
			agentModelOverrides: ["executor"],
		});
		expect(settings.get("modelRoles")).toMatchObject({ reviewer: `${sonnet.provider}/${sonnet.id}` });
		expect(settings.get("task.agentModelOverrides")).toMatchObject({ executor: `${sonnet.provider}/${sonnet.id}` });
		expect(session.getDefaultFallbackRuntimeState()).toEqual(previousFallbackState);
	});

	it("cleans a session-only profile when the successor restores the same durable profile", async () => {
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
			"codex-medium",
		);
		await targetSession!.sessionManager.flush();

		session = new AgentSession({
			agent: new Agent({ initialState: { model: sonnet, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings,
			modelRegistry,
		});
		settings.override("modelRoles", { reviewer: "provider/session" });
		session.setActiveModelProfile("codex-medium", "session");
		session.noteProfileInstalledOverrides(["reviewer"], [], sonnet, { reviewer: "provider/durable" });

		expect(await session.switchSession(sessionFile)).toBe(true);
		expect(session.getActiveModelProfile()).toBe("codex-medium");
		expect(session.getConfiguredModelChainState("default")).toMatchObject({
			origin: "profile-activation",
			identity: "codex-medium",
		});
		expect(settings.get("modelRoles").reviewer).toBe("provider/durable");
	});

	it("replaces stale profile ownership keys when a successor profile omits a role", async () => {
		const sonnet = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const settings = Settings.isolated({ "compaction.enabled": false });
		session = new AgentSession({
			agent: new Agent({ initialState: { model: sonnet, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings,
			modelRegistry,
		});

		session.noteProfileInstalledOverrides(["reviewer"], ["executor"], sonnet);
		session.noteProfileInstalledOverrides(["planner"], [], sonnet);

		expect(session.getProfileInstalledOverrideKeys()).toEqual({
			modelRoles: ["planner"],
			agentModelOverrides: [],
		});
	});

	it("treats a legacy durable profile alias as the canonical successor identity", async () => {
		const sonnet = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"modelProfile.default": "codex-standard",
			"session.resumeModelBehavior": "keepSessionModel",
		});
		const sessionFile = await createPersistedTarget(sonnet, settings);
		targetSession!.setConfiguredModelChain(
			"default",
			[`${sonnet.provider}/${sonnet.id}`],
			"profile-activation",
			"codex-medium",
		);
		await targetSession!.sessionManager.flush();

		session = new AgentSession({
			agent: new Agent({ initialState: { model: sonnet, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings,
			modelRegistry,
		});

		expect(await session.switchSession(sessionFile)).toBe(true);
		expect(session.getActiveModelProfile()).toBe("codex-medium");
		expect(session.getConfiguredModelChainState("default")).toMatchObject({
			origin: "profile-activation",
			identity: "codex-medium",
		});
	});

	it("restores the durable role layer beneath a session-only profile", async () => {
		const sonnet = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const settings = Settings.isolated({ "compaction.enabled": false });
		session = new AgentSession({
			agent: new Agent({ initialState: { model: sonnet, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings,
			modelRegistry,
		});

		settings.override("modelRoles", { default: "provider/durable-default" });
		settings.override("task.agentModelOverrides", { executor: "provider/durable-executor" });
		session.setActiveModelProfile("durable-profile", "durable");
		session.noteProfileInstalledOverrides(["default"], ["executor"], sonnet, {
			default: "provider/global-default",
		});
		settings.override("modelRoles", { default: "provider/session-default" });
		settings.override("task.agentModelOverrides", { executor: "provider/session-executor" });
		session.setActiveModelProfile("session-profile", "session");
		session.noteProfileInstalledOverrides(
			["default"],
			["executor"],
			sonnet,
			{ default: "provider/durable-default" },
			{ executor: "provider/durable-executor" },
		);

		session.clearSessionOnlyModelProfileState();

		expect(settings.get("task.agentModelOverrides").executor).toBe("provider/durable-executor");
		expect(settings.getModelRole("default")).toBe("provider/durable-default");
		expect(session.getActiveModelProfile()).toBeUndefined();
	});

	it("keeps an explicit default selection after clearing profile ownership", async () => {
		const sonnet = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const opus = getBundledModel("anthropic", "claude-opus-4-8")!;
		const settings = Settings.isolated({ "compaction.enabled": false });
		session = new AgentSession({
			agent: new Agent({ initialState: { model: sonnet, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings,
			modelRegistry,
		});

		settings.override("modelRoles", { default: `${sonnet.provider}/${sonnet.id}` });
		session.setActiveModelProfile("session-profile", "session");
		session.noteProfileInstalledOverrides(["default"], [], sonnet, { default: "anthropic/durable-default" });

		await session.setDefaultModelSelection(opus, ThinkingLevel.Low);

		expect(session.model?.id).toBe(opus.id);
		expect(settings.getModelRole("default")).toBe(`${opus.provider}/${opus.id}`);
		expect(session.getActiveModelProfile()).toBeUndefined();
	});

	it("does not recover a saved selector that still exists in the full catalog", async () => {
		const sonnet = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"modelProfile.default": "codex-medium",
			"session.resumeModelBehavior": "keepSessionModel",
		});
		const sessionFile = await createPersistedTarget(sonnet, settings);

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
