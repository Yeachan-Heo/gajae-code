import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Agent } from "@gajae-code/agent-core";
import { type ConfigHotReloadCandidate, ConfigHotReloadWatcher } from "../src/config/config-hot-reload";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";

const provider = "reload-test";
const modelId = "active-model";

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("Timed out waiting for configuration reload");
		await Bun.sleep(10);
	}
}

describe("AgentSession configuration reload", () => {
	let tempDir: string | undefined;
	let session: AgentSession | undefined;
	let modelRegistry: ModelRegistry | undefined;
	let authStorage: AuthStorage | undefined;

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
		await modelRegistry?.dispose();
		modelRegistry = undefined;
		authStorage?.close();
		authStorage = undefined;
		if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
		tempDir = undefined;
	});

	function settingsText(options: {
		todoEnabled: boolean;
		compactionEnabled: boolean;
		defaultProfile?: string;
	}): string {
		return [
			`todo:\n  enabled: ${options.todoEnabled}`,
			`compaction:\n  enabled: ${options.compactionEnabled}`,
			...(options.defaultProfile ? [`modelProfile:\n  default: ${options.defaultProfile}`] : []),
			"",
		].join("\n");
	}

	function unsetEnvironmentVariables(...names: string[]): () => void {
		const previous = new Map(names.map(name => [name, Bun.env[name]] as const));
		for (const name of names) delete Bun.env[name];
		return () => {
			for (const [name, value] of previous) {
				if (value === undefined) delete Bun.env[name];
				else Bun.env[name] = value;
			}
		};
	}

	function modelsText(options: {
		providerId?: string;
		modelId?: string;
		api?: string;
		name: string;
		baseUrl: string;
		apiKey?: string;
		withProfile?: boolean;
		requiresProvider?: boolean;
		apiKeyEnv?: string;
	}): string {
		const providerId = options.providerId ?? provider;
		const modelIdValue = options.modelId ?? modelId;
		return [
			"providers:",
			`  ${providerId}:`,
			`    baseUrl: ${options.baseUrl}`,
			`    api: ${options.api ?? "openai-completions"}`,
			...(options.apiKeyEnv || options.apiKey
				? [
						"    auth: apiKey",
						...(options.apiKeyEnv ? [`    apiKeyEnv: ${options.apiKeyEnv}`] : []),
						...(options.apiKey ? [`    apiKey: ${options.apiKey}`] : []),
					]
				: ["    auth: none"]),
			"    models:",
			`      - id: ${modelIdValue}`,
			`        name: ${options.name}`,
			"        contextWindow: 32768",
			"        maxTokens: 4096",
			...(options.withProfile
				? [
						"profiles:",
						"  active-profile:",
						`    required_providers: ${options.requiresProvider ? `[${providerId}]` : "[]"}`,
						"    model_mapping:",
						`      default: ${providerId}/${modelIdValue}`,
					]
				: []),
			"",
		].join("\n");
	}

	async function createSession(options?: {
		providerId?: string;
		modelId?: string;
		api?: string;
		withProfile?: boolean;
		requiresProvider?: boolean;
		apiKeyEnv?: string;
		credentialSessionId?: string;
	}) {
		const evidenceRoot = path.resolve(import.meta.dir, "../../../.gjc/evidence/config-hot-reload");
		await fs.mkdir(evidenceRoot, { recursive: true });
		tempDir = await fs.mkdtemp(path.join(evidenceRoot, "session-"));
		const configPath = path.join(tempDir, "config.yml");
		const modelsPath = path.join(tempDir, "models.yml");
		await Bun.write(configPath, settingsText({ todoEnabled: false, compactionEnabled: false }));
		await Bun.write(
			modelsPath,
			modelsText({
				providerId: options?.providerId,
				modelId: options?.modelId,
				api: options?.api,
				name: "Before",
				baseUrl: "https://before.example/v1",
				withProfile: options?.withProfile,
				requiresProvider: options?.requiresProvider,
				apiKeyEnv: options?.apiKeyEnv,
			}),
		);
		const settings = await Settings.loadForScope({ cwd: tempDir, agentDir: tempDir });
		authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
		modelRegistry = new ModelRegistry(authStorage, modelsPath, settings, {
			agentDir: tempDir,
			automaticRefresh: false,
		});
		const initialModel = modelRegistry
			.getAll()
			.find(
				model => model.provider === (options?.providerId ?? provider) && model.id === (options?.modelId ?? modelId),
			);
		if (!initialModel) throw new Error("Expected configured test model in the real model registry");
		const agent = new Agent({ initialState: { model: initialModel, systemPrompt: ["Test"], tools: [] } });
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
			credentialSessionId: options?.credentialSessionId,
		});
		return { configPath, modelsPath, initialModel };
	}

	function candidate(
		revision: number,
		configPath: string,
		modelsPath: string,
		configText: string,
		modelsConfigText: string,
	): ConfigHotReloadCandidate {
		return {
			revision,
			config: { path: configPath, text: configText, identity: `config-${revision}` },
			models: { path: modelsPath, text: modelsConfigText, identity: `models-${revision}` },
		};
	}

	it("validates without mutation, then applies after admission drains and rebases turn writes", async () => {
		const { configPath, modelsPath, initialModel } = await createSession();
		const nextConfig = settingsText({ todoEnabled: true, compactionEnabled: false });
		const nextModels = modelsText({ name: "After", baseUrl: "https://after.example/v1" });
		const staged = candidate(1, configPath, modelsPath, nextConfig, nextModels);

		await session!.validateConfiguration(staged);
		expect(session!.settings.get("todo.enabled")).toBe(false);
		expect(session!.model).toBe(initialModel);
		expect(modelRegistry!.getAll().find(model => model.provider === provider && model.id === modelId)?.name).toBe(
			"Before",
		);
		session!.setConfiguredModelChain("default", [`${provider}/${modelId}`], "model_selection");
		const manualChain = session!.getConfiguredModelChainState("default");
		const fallbackState = session!.getDefaultFallbackRuntimeState();

		const promptGate = Promise.withResolvers<void>();
		const promptEntered = Promise.withResolvers<void>();
		const heldPrompt = session!.runWithPromptAdmissionForTests(async () => {
			promptEntered.resolve();
			await promptGate.promise;
		});
		await promptEntered.promise;
		const reload = session!.reloadConfiguration(staged, new AbortController().signal);
		session!.settings.set("compaction.enabled", true);
		promptGate.resolve();
		await heldPrompt;

		const result = await reload;
		expect(result).toMatchObject({ applied: true, settingsChanged: true, modelsChanged: true });
		expect(result.changedSettings).toContain("todo.enabled");
		expect(session!.settings.get("todo.enabled")).toBe(true);
		expect(session!.settings.get("compaction.enabled")).toBe(true);
		expect(session!.model).toMatchObject({ name: "After", baseUrl: "https://after.example/v1" });
		expect(modelRegistry!.getAll().find(model => model.provider === provider && model.id === modelId)).toMatchObject({
			name: "After",
			baseUrl: "https://after.example/v1",
		});
		expect(session!.getConfiguredModelChainState("default")).toEqual(manualChain);
		expect(session!.getDefaultFallbackRuntimeState()).toEqual(fallbackState);
	});

	it("returns applied false for an unchanged real settings and model catalog candidate", async () => {
		const { configPath, modelsPath } = await createSession();
		const config = await Bun.file(configPath).text();
		const models = await Bun.file(modelsPath).text();
		const staged = candidate(2, configPath, modelsPath, config, models);

		await session!.validateConfiguration(staged);
		await expect(session!.reloadConfiguration(staged, new AbortController().signal)).resolves.toEqual({
			applied: false,
			settingsChanged: false,
			modelsChanged: false,
			changedSettings: [],
		});
	});

	it("rejects removing the current manually selected model before superseding pending work", async () => {
		const { configPath, modelsPath, initialModel } = await createSession();
		const staged = candidate(8, configPath, modelsPath, await Bun.file(configPath).text(), "providers: {}\n");
		await expect(session!.validateConfiguration(staged)).rejects.toMatchObject({ code: "MODEL_UNAVAILABLE" });
		await expect(session!.reloadConfiguration(staged, new AbortController().signal)).rejects.toMatchObject({
			code: "MODEL_UNAVAILABLE",
		});
		expect(session!.model).toBe(initialModel);
		expect(modelRegistry!.find(provider, modelId)).toBeDefined();
	});

	it("does not freeze durable roles beneath an active preset overlay", async () => {
		const { configPath, modelsPath } = await createSession({ withProfile: true });
		session!.settings.set("modelRoles", { planner: `${provider}/${modelId}` });
		await session!.settings.flushOrThrow();
		await session!.activateModelProfileForControl("active-profile");
		expect(session!.settings.getOverride("modelRoles")?.planner).toBeUndefined();
		const nextConfig = `${settingsText({ todoEnabled: false, compactionEnabled: false })}modelRoles:\n  planner: ${provider}/new-durable\n`;
		const staged = candidate(10, configPath, modelsPath, nextConfig, await Bun.file(modelsPath).text());
		await session!.reloadConfiguration(staged, new AbortController().signal);
		expect(session!.settings.get("modelRoles").planner).toBe(`${provider}/new-durable`);
		expect(session!.settings.getOverride("modelRoles")?.planner).toBeUndefined();
	});

	it("cancels a queued reload without publishing or blocking the next admission", async () => {
		const { configPath, modelsPath, initialModel } = await createSession();
		const staged = candidate(
			9,
			configPath,
			modelsPath,
			settingsText({ todoEnabled: true, compactionEnabled: false }),
			modelsText({ name: "Cancelled", baseUrl: "https://cancelled.example/v1" }),
		);
		const started = Promise.withResolvers<void>();
		const complete = Promise.withResolvers<void>();
		const prompt = session!.runWithPromptAdmissionForTests(async () => {
			started.resolve();
			await complete.promise;
		});
		await started.promise;
		const controller = new AbortController();
		const reload = session!.reloadConfiguration(staged, controller.signal);
		controller.abort(new Error("superseded"));
		try {
			await expect(reload).rejects.toMatchObject({ code: "PUBLICATION_FAILED" });
		} finally {
			complete.resolve();
		}
		await prompt;
		expect(session!.model).toBe(initialModel);
		expect(session!.settings.get("todo.enabled")).toBe(false);
		await session!.runWithPromptAdmissionForTests(async () => {
			expect(modelRegistry!.find(provider, modelId)?.name).toBe("Before");
		});
	});

	it("retries a validated reload after a session transition cancels publication", async () => {
		const { configPath, modelsPath } = await createSession();
		const resumePublicationFence = Promise.withResolvers<void>();
		const originalAcquirePublicationFence = modelRegistry!.acquirePublicationFence.bind(modelRegistry!);
		let publicationFenceEntered = false;
		const publicationFenceSpy = vi
			.spyOn(modelRegistry!, "acquirePublicationFence")
			.mockImplementation(async signal => {
				if (!publicationFenceEntered) {
					publicationFenceEntered = true;
					await resumePublicationFence.promise;
				}
				return await originalAcquirePublicationFence(signal);
			});
		let applyFinished = false;
		let applyResult: unknown;
		let applyError: unknown;
		const watcherErrors: unknown[] = [];
		const watcher = new ConfigHotReloadWatcher({
			onValidate: candidate => session!.validateConfiguration(candidate),
			onCandidate: async (candidate, signal) => {
				try {
					applyResult = await session!.reloadConfiguration(candidate, signal);
				} catch (error) {
					applyError = error;
					throw error;
				} finally {
					applyFinished = true;
				}
			},
			onError: error => watcherErrors.push(error),
		});
		try {
			await watcher.start({ configPath, modelsPath });
			await Bun.write(configPath, settingsText({ todoEnabled: true, compactionEnabled: false }));
			await waitFor(() => publicationFenceEntered);

			const transition = session!.newSession();
			resumePublicationFence.resolve();
			await expect(transition).resolves.toBe(true);
			await waitFor(() => applyFinished);

			expect(applyError).toBeUndefined();
			expect(applyResult).toMatchObject({ applied: true, settingsChanged: true });
			expect(session!.settings.get("todo.enabled")).toBe(true);
			expect(watcherErrors).toEqual([]);
		} finally {
			resumePublicationFence.resolve();
			watcher.dispose();
			publicationFenceSpy.mockRestore();
		}
	});

	it("publishes global setting changes even when a runtime override shadows their effective value", async () => {
		const { configPath, modelsPath } = await createSession();
		session!.settings.override("modelRoles", { planner: `${provider}/manual` });
		const nextConfig = `${settingsText({ todoEnabled: false, compactionEnabled: false })}modelRoles:\n  planner: ${provider}/configured\n`;
		await Bun.write(configPath, nextConfig);
		const models = await Bun.file(modelsPath).text();
		const staged = candidate(5, configPath, modelsPath, nextConfig, models);

		await session!.validateConfiguration(staged);
		const result = await session!.reloadConfiguration(staged, new AbortController().signal);
		expect(result).toMatchObject({ applied: true, settingsChanged: true, modelsChanged: false });
		expect(result.changedSettings).toContain("modelRoles");
		expect(session!.settings.getGlobal("modelRoles")).toEqual({ planner: `${provider}/configured` });
		expect(session!.settings.get("modelRoles")).toEqual({ planner: `${provider}/manual` });
	});

	it("keeps the active preset when the configured next-startup default changes and rejects preset removal", async () => {
		const { configPath, modelsPath } = await createSession({ withProfile: true });
		session!.setActiveModelProfile("active-profile");
		session!.setConfiguredModelChain("default", [`${provider}/${modelId}`], "profile-activation", "active-profile");
		const nextModels = modelsText({
			name: "After",
			baseUrl: "https://after.example/v1",
			withProfile: true,
		});
		const newDefault = settingsText({
			todoEnabled: false,
			compactionEnabled: false,
			defaultProfile: "next-startup-profile",
		});
		await Bun.write(configPath, newDefault);
		await Bun.write(modelsPath, nextModels);
		const defaultCandidate = candidate(3, configPath, modelsPath, newDefault, nextModels);

		await session!.validateConfiguration(defaultCandidate);
		await expect(session!.reloadConfiguration(defaultCandidate, new AbortController().signal)).resolves.toMatchObject(
			{
				applied: true,
				settingsChanged: true,
				modelsChanged: true,
			},
		);
		expect(session!.settings.get("modelProfile.default")).toBe("next-startup-profile");
		expect(session!.getActiveModelProfile()).toBe("active-profile");
		expect(session!.model).toMatchObject({ name: "After", baseUrl: "https://after.example/v1" });

		const removedModels = modelsText({ name: "After", baseUrl: "https://after.example/v1" });
		await Bun.write(modelsPath, removedModels);
		const removalCandidate = candidate(4, configPath, modelsPath, newDefault, removedModels);
		await expect(session!.validateConfiguration(removalCandidate)).rejects.toMatchObject({
			name: "ConfigurationReloadError",
			code: "ACTIVE_PROFILE_INVALID",
		});
		expect(session!.getActiveModelProfile()).toBe("active-profile");
		expect(modelRegistry!.getModelProfile("active-profile")?.name).toBe("active-profile");
	});

	it("keeps an expired refreshable OAuth provider eligible during a read-only reload preflight", async () => {
		const oauthProvider = "anthropic";
		const oauthModelId = "claude-sonnet-4-5";
		const apiKeyEnv = "GJC_TEST_RELOAD_EXPIRED_OAUTH_KEY";
		const restoreEnvironment = unsetEnvironmentVariables(
			apiKeyEnv,
			"ANTHROPIC_API_KEY",
			"ANTHROPIC_OAUTH_TOKEN",
			"ANTHROPIC_FOUNDRY_API_KEY",
		);
		try {
			const { configPath, modelsPath } = await createSession({
				providerId: oauthProvider,
				modelId: oauthModelId,
				api: "anthropic-messages",
				withProfile: true,
				requiresProvider: true,
				apiKeyEnv,
			});
			await authStorage!.set(oauthProvider, [
				{
					type: "oauth",
					access: "expired-profile-access",
					refresh: "refresh-profile-token",
					expires: Date.now() - 60_000,
					email: "profile@example.com",
				},
			]);
			authStorage!.setRuntimeCredentialSelector(oauthProvider, { kind: "email", value: "profile@example.com" });
			session!.setActiveModelProfile("active-profile");
			expect(await authStorage!.peekApiKey(oauthProvider, { sessionId: session!.sessionId })).toBeUndefined();
			expect(authStorage!.hasUsableAuth(oauthProvider, { sessionId: session!.sessionId })).toBe(true);
			const getApiKey = vi.spyOn(authStorage!, "getApiKey");
			const nextConfig = settingsText({ todoEnabled: true, compactionEnabled: false });
			const models = await Bun.file(modelsPath).text();
			const staged = candidate(11, configPath, modelsPath, nextConfig, models);

			try {
				await expect(session!.reloadConfiguration(staged, new AbortController().signal)).resolves.toMatchObject({
					applied: true,
					settingsChanged: true,
					modelsChanged: false,
				});
				expect(getApiKey).not.toHaveBeenCalled();
				expect(authStorage!.hasRuntimeCredentialSelector(oauthProvider)).toBe(true);
				expect(authStorage!.getEffectiveCredentialType(oauthProvider, session!.sessionId)).toBe("oauth");
			} finally {
				getApiKey.mockRestore();
			}
		} finally {
			restoreEnvironment();
		}
	});

	it("rejects a literal key that conflicts with the credential scope without an active profile", async () => {
		const oauthProvider = "anthropic";
		const oauthModelId = "claude-sonnet-4-5";
		const credentialSessionId = "reload-credential-scope";
		const apiKeyEnv = "GJC_TEST_RELOAD_PINNED_OAUTH_KEY";
		const restoreEnvironment = unsetEnvironmentVariables(
			apiKeyEnv,
			"ANTHROPIC_API_KEY",
			"ANTHROPIC_OAUTH_TOKEN",
			"ANTHROPIC_FOUNDRY_API_KEY",
		);
		try {
			const { configPath, modelsPath, initialModel } = await createSession({
				providerId: oauthProvider,
				modelId: oauthModelId,
				api: "anthropic-messages",
				apiKeyEnv,
				credentialSessionId,
			});
			await authStorage!.set(oauthProvider, [
				{
					type: "oauth",
					access: "pinned-profile-access",
					refresh: "pinned-profile-refresh",
					expires: Date.now() + 60_000,
					email: "pinned-profile@example.com",
				},
			]);
			await session!.setCredentialPin(oauthProvider, {
				kind: "email",
				value: "pinned-profile@example.com",
			});
			expect(session!.credentialSessionId).toBe(credentialSessionId);
			expect(session!.credentialSessionId).not.toBe(session!.sessionId);
			expect(session!.getActiveModelProfile()).toBeUndefined();

			const nextModels = modelsText({
				providerId: oauthProvider,
				modelId: oauthModelId,
				api: "anthropic-messages",
				name: "After",
				baseUrl: "https://before.example/v1",
				apiKey: "candidate-literal-key",
			});
			await Bun.write(modelsPath, nextModels);
			const nextConfig = settingsText({ todoEnabled: false, compactionEnabled: false });
			const stagedForValidation = candidate(12, configPath, modelsPath, nextConfig, nextModels);
			await expect(session!.validateConfiguration(stagedForValidation)).rejects.toMatchObject({
				name: "ConfigurationReloadError",
				code: "MODELS_INVALID",
			});
			const stagedForReload = candidate(13, configPath, modelsPath, nextConfig, nextModels);
			await expect(
				session!.reloadConfiguration(stagedForReload, new AbortController().signal),
			).rejects.toMatchObject({
				name: "ConfigurationReloadError",
				code: "MODELS_INVALID",
			});
			expect(modelRegistry!.find(oauthProvider, oauthModelId)).toBe(initialModel);
			expect(session!.model).toBe(initialModel);
			expect(authStorage!.hasConfigApiKey(oauthProvider, modelRegistry!.getAuthStorageOwner())).toBe(false);
			expect(await authStorage!.peekApiKey(oauthProvider, { sessionId: credentialSessionId })).toBe(
				"pinned-profile-access",
			);
			expect(authStorage!.hasEffectiveCredentialSelector(oauthProvider, credentialSessionId)).toBe(true);
		} finally {
			restoreEnvironment();
		}
	});
});
