import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Agent, ThinkingLevel } from "@gajae-code/agent-core";
import { type ConfigHotReloadCandidate, ConfigHotReloadWatcher } from "../src/config/config-hot-reload";
import * as modelProfileActivation from "../src/config/model-profile-activation";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";

const provider = "reload-test";
const modelId = "active-model";
type TestModelThinking = { minLevel: string; maxLevel: string; defaultLevel?: string };

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
		additionalModelId?: string;
		api?: string;
		name: string;
		baseUrl: string;
		apiKey?: string;
		withProfile?: boolean;
		profileRoleMapping?: boolean;
		profilePlannerModelId?: string;
		requiresProvider?: boolean;
		apiKeyEnv?: string;
		thinking?: TestModelThinking;
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
			...(options.thinking
				? [
						"        reasoning: true",
						"        compat:",
						"          supportsReasoningEffort: true",
						"        thinking:",
						"          mode: effort",
						`          minLevel: ${options.thinking.minLevel}`,
						`          maxLevel: ${options.thinking.maxLevel}`,
						...(options.thinking.defaultLevel
							? [`          defaultLevel: ${options.thinking.defaultLevel}`]
							: []),
					]
				: []),
			...(options.additionalModelId
				? [
						`      - id: ${options.additionalModelId}`,
						"        name: Destination",
						"        contextWindow: 32768",
						"        maxTokens: 4096",
					]
				: []),
			...(options.withProfile
				? [
						"profiles:",
						"  active-profile:",
						`    required_providers: ${options.requiresProvider ? `[${providerId}]` : "[]"}`,
						"    model_mapping:",
						`      default: ${providerId}/${modelIdValue}`,
						...(options.profileRoleMapping
							? [`      planner: ${providerId}/${options.profilePlannerModelId ?? modelIdValue}`]
							: []),
					]
				: []),
			"",
		].join("\n");
	}

	async function createSession(options?: {
		providerId?: string;
		modelId?: string;
		additionalModelId?: string;
		api?: string;
		withProfile?: boolean;
		profileRoleMapping?: boolean;
		profilePlannerModelId?: string;
		requiresProvider?: boolean;
		apiKeyEnv?: string;
		thinking?: TestModelThinking;
		credentialSessionId?: string;
		persistentSession?: boolean;
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
				additionalModelId: options?.additionalModelId,
				api: options?.api,
				name: "Before",
				baseUrl: "https://before.example/v1",
				withProfile: options?.withProfile,
				profileRoleMapping: options?.profileRoleMapping,
				profilePlannerModelId: options?.profilePlannerModelId,
				requiresProvider: options?.requiresProvider,
				apiKeyEnv: options?.apiKeyEnv,
				thinking: options?.thinking,
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
		const sessionManager = options?.persistentSession
			? SessionManager.create(tempDir!, tempDir!)
			: SessionManager.inMemory();
		session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
			credentialSessionId: options?.credentialSessionId,
		});
		return { configPath, modelsPath, initialModel, sessionManager };
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

	it("re-stages the same snapshot after a safe offline catalog refresh", async () => {
		const { configPath, modelsPath } = await createSession();
		const staged = candidate(
			3,
			configPath,
			modelsPath,
			settingsText({ todoEnabled: true, compactionEnabled: false }),
			modelsText({ name: "After refresh", baseUrl: "https://after-refresh.example/v1" }),
		);
		const originalStage = modelRegistry!.stageModelsConfigReload.bind(modelRegistry!);
		let stageCount = 0;
		const stageSpy = vi.spyOn(modelRegistry!, "stageModelsConfigReload").mockImplementation(async (...args) => {
			const stagedModels = await originalStage(...args);
			stageCount++;
			if (stageCount === 1) await modelRegistry!.refresh("offline");
			return stagedModels;
		});

		await expect(session!.reloadConfiguration(staged, new AbortController().signal)).resolves.toMatchObject({
			applied: true,
			settingsChanged: true,
			modelsChanged: true,
		});
		expect(stageSpy).toHaveBeenCalledTimes(2);
		expect(session!.settings.get("todo.enabled")).toBe(true);
		expect(session!.model).toMatchObject({ name: "After refresh", baseUrl: "https://after-refresh.example/v1" });
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

	it("preserves an explicit same-value role override during profile refresh", async () => {
		const { configPath, modelsPath } = await createSession({
			withProfile: true,
			profileRoleMapping: true,
			additionalModelId: "refreshed-planner",
		});
		await session!.activateModelProfileForControl("active-profile");
		const explicitValue = `${provider}/${modelId}`;
		expect(session!.settings.getOverride("task.agentModelOverrides")?.planner).toBe(explicitValue);

		// Selecting the already-installed value is still an explicit ownership choice.
		session!.settings.setAgentModelOverride("planner", explicitValue);
		session!.markProfileRoleOverrideManual("task.agentModelOverrides", "planner");

		const staged = candidate(
			11,
			configPath,
			modelsPath,
			await Bun.file(configPath).text(),
			modelsText({
				name: "Before",
				baseUrl: "https://before.example/v1",
				additionalModelId: "refreshed-planner",
				withProfile: true,
				profileRoleMapping: true,
				profilePlannerModelId: "refreshed-planner",
			}),
		);
		await session!.reloadConfiguration(staged, new AbortController().signal);

		expect(session!.settings.getOverride("task.agentModelOverrides")?.planner).toBe(explicitValue);
		expect(session!.getProfileInstalledOverrideState().manualAgentModelOverrides).toEqual(new Set(["planner"]));
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

	it("revalidates a watcher snapshot after an overlapping session transition", async () => {
		const destinationModelId = "destination-model";
		const { configPath, modelsPath, sessionManager } = await createSession({
			additionalModelId: destinationModelId,
			persistentSession: true,
		});
		const targetSessionManager = SessionManager.create(tempDir!, tempDir!);
		targetSessionManager.appendModelChange(`${provider}/${destinationModelId}`);
		await targetSessionManager.ensureOnDisk();
		await targetSessionManager.flush();
		const targetSessionFile = targetSessionManager.getSessionFile();
		await targetSessionManager.close();
		if (!targetSessionFile) throw new Error("Expected target session file");

		const releaseTransitionFlush = Promise.withResolvers<void>();
		const transitionFlushEntered = Promise.withResolvers<void>();
		const originalFlush = sessionManager.flush.bind(sessionManager);
		let heldTransitionFlush = false;
		const flushSpy = vi.spyOn(sessionManager, "flush").mockImplementation(async () => {
			if (!heldTransitionFlush) {
				heldTransitionFlush = true;
				transitionFlushEntered.resolve();
				await releaseTransitionFlush.promise;
			}
			await originalFlush();
		});

		const originalStage = modelRegistry!.stageModelsConfigReload.bind(modelRegistry!);
		const transitionStarted = Promise.withResolvers<void>();
		const firstAvailabilityCheck = Promise.withResolvers<void>();
		let transition: Promise<boolean> | undefined;
		let stagedCandidateCount = 0;
		let firstCheckModelId: string | undefined;
		let recordedFirstCheck = false;
		const stageSpy = vi.spyOn(modelRegistry!, "stageModelsConfigReload").mockImplementation(async (...args) => {
			stagedCandidateCount += 1;
			const staged = await originalStage(...args);
			if (!transition) {
				const originalGetAvailable = staged.registry.getAvailable.bind(staged.registry);
				vi.spyOn(staged.registry, "getAvailable").mockImplementation(() => {
					if (!recordedFirstCheck) {
						recordedFirstCheck = true;
						firstCheckModelId = session!.model?.id;
						firstAvailabilityCheck.resolve();
					}
					return originalGetAvailable();
				});
				transition = session!.switchSession(targetSessionFile);
				transitionStarted.resolve();
				await transitionFlushEntered.promise;
			}
			return staged;
		});

		const validationResult = Promise.withResolvers<{ error?: unknown }>();
		const applyFinished = Promise.withResolvers<void>();
		const watcherErrors: unknown[] = [];
		let validationStageCount = 0;
		let applyError: unknown;
		let applyResult: unknown;
		const watcher = new ConfigHotReloadWatcher({
			onValidate: async candidate => {
				try {
					await session!.validateConfiguration(candidate);
					validationStageCount = stagedCandidateCount;
					validationResult.resolve({});
				} catch (error) {
					validationResult.resolve({ error });
					throw error;
				}
			},
			onCandidate: async (candidate, signal) => {
				try {
					applyResult = await session!.reloadConfiguration(candidate, signal);
				} catch (error) {
					applyError = error;
					throw error;
				} finally {
					applyFinished.resolve();
				}
			},
			onError: error => watcherErrors.push(error),
		});
		try {
			await watcher.start({ configPath, modelsPath });
			const nextConfig = settingsText({ todoEnabled: true, compactionEnabled: false });
			const nextModels = modelsText({
				modelId: destinationModelId,
				name: "Destination",
				baseUrl: "https://before.example/v1",
			});
			await Promise.all([Bun.write(configPath, nextConfig), Bun.write(modelsPath, nextModels)]);

			await transitionStarted.promise;
			await firstAvailabilityCheck.promise;
			expect(firstCheckModelId).toBe(modelId);
			expect(session!.model?.id).toBe(modelId);
			releaseTransitionFlush.resolve();
			if (!transition) throw new Error("Expected overlapping session transition");
			await expect(transition).resolves.toBe(true);

			const validation = await validationResult.promise;
			expect(validation.error).toBeUndefined();
			expect(validationStageCount).toBeGreaterThanOrEqual(2);
			await applyFinished.promise;

			expect(applyError).toBeUndefined();
			expect(applyResult).toMatchObject({ applied: true, settingsChanged: true });
			expect(session!.model?.id).toBe(destinationModelId);
			expect(session!.settings.get("todo.enabled")).toBe(true);
			expect(watcherErrors).toEqual([]);
		} finally {
			releaseTransitionFlush.resolve();
			watcher.dispose();
			stageSpy.mockRestore();
			flushSpy.mockRestore();
			await transition?.catch(() => {});
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

	it("preserves a newer temporary model selection while applying the active profile reload", async () => {
		const releasePublicationFence = Promise.withResolvers<void>();
		let publicationFenceEntered = false;
		let restorePublicationFence: (() => void) | undefined;
		let restoreModelRegistryApiKey: (() => void) | undefined;
		try {
			const { configPath, modelsPath } = await createSession({
				modelId: "default-model",
				additionalModelId: "manual-model",
				withProfile: true,
			});
			session!.settings.set("modelRoles", { planner: `${provider}/manual-model` });
			await session!.settings.flushOrThrow();
			await session!.activateModelProfileForControl("active-profile");
			expect(session!.getConfiguredModelChainState("default")).toMatchObject({
				entries: [`${provider}/default-model`],
				origin: "profile-activation",
				identity: "active-profile",
			});

			const originalAcquirePublicationFence = modelRegistry!.acquirePublicationFence.bind(modelRegistry!);
			const publicationFenceSpy = vi
				.spyOn(modelRegistry!, "acquirePublicationFence")
				.mockImplementation(async signal => {
					publicationFenceEntered = true;
					await releasePublicationFence.promise;
					return await originalAcquirePublicationFence(signal);
				});
			restorePublicationFence = () => publicationFenceSpy.mockRestore();

			const nextModels = modelsText({
				modelId: "next-default-model",
				additionalModelId: "manual-model",
				name: "After",
				baseUrl: "https://after.example/v1",
				withProfile: true,
			});
			const staged = candidate(
				20,
				configPath,
				modelsPath,
				settingsText({ todoEnabled: false, compactionEnabled: false }),
				nextModels,
			);
			const reload = session!.reloadConfiguration(staged, new AbortController().signal);
			await waitFor(() => publicationFenceEntered);

			const apiKeySpy = vi.spyOn(modelRegistry!, "getApiKey").mockResolvedValue("temporary-cycle-key");
			restoreModelRegistryApiKey = () => apiKeySpy.mockRestore();
			const cycled = await session!.cycleRoleModels(["default", "planner"], { temporary: true });
			expect(cycled?.model.id).toBe("manual-model");
			releasePublicationFence.resolve();
			await expect(reload).resolves.toMatchObject({ applied: true, modelsChanged: true });

			expect(session!.model).toMatchObject({ id: "manual-model", baseUrl: "https://after.example/v1" });
			expect(session!.getConfiguredModelChainState("default")).toMatchObject({
				entries: [`${provider}/next-default-model`],
				origin: "profile-activation",
				identity: "active-profile",
			});
		} finally {
			releasePublicationFence.resolve();
			restorePublicationFence?.();
			restoreModelRegistryApiKey?.();
		}
	});

	it("keeps a newer selection when the staged catalog removes that model", async () => {
		const releasePublicationFence = Promise.withResolvers<void>();
		let publicationFenceEntered = false;
		let restorePublicationFence: (() => void) | undefined;
		let restoreModelRegistryApiKey: (() => void) | undefined;
		try {
			const { configPath, modelsPath } = await createSession({
				modelId: "default-model",
				additionalModelId: "manual-model",
				withProfile: true,
			});
			session!.settings.set("modelRoles", { planner: `${provider}/manual-model` });
			await session!.settings.flushOrThrow();
			await session!.activateModelProfileForControl("active-profile");

			const originalAcquirePublicationFence = modelRegistry!.acquirePublicationFence.bind(modelRegistry!);
			const publicationFenceSpy = vi
				.spyOn(modelRegistry!, "acquirePublicationFence")
				.mockImplementation(async signal => {
					publicationFenceEntered = true;
					await releasePublicationFence.promise;
					return await originalAcquirePublicationFence(signal);
				});
			restorePublicationFence = () => publicationFenceSpy.mockRestore();

			const staged = candidate(
				21,
				configPath,
				modelsPath,
				settingsText({ todoEnabled: false, compactionEnabled: false }),
				modelsText({
					modelId: "next-default-model",
					name: "After",
					baseUrl: "https://after.example/v1",
					withProfile: true,
				}),
			);
			const reload = session!.reloadConfiguration(staged, new AbortController().signal);
			await waitFor(() => publicationFenceEntered);

			const apiKeySpy = vi.spyOn(modelRegistry!, "getApiKey").mockResolvedValue("temporary-cycle-key");
			restoreModelRegistryApiKey = () => apiKeySpy.mockRestore();
			const cycled = await session!.cycleRoleModels(["default", "planner"], { temporary: true });
			expect(cycled?.model.id).toBe("manual-model");
			releasePublicationFence.resolve();
			await expect(reload).rejects.toMatchObject({ code: "MODEL_UNAVAILABLE" });

			expect(session!.model?.id).toBe("manual-model");
			expect(modelRegistry!.find(provider, "default-model")).toBeDefined();
			expect(session!.getConfiguredModelChainState("default")).toMatchObject({
				entries: [`${provider}/default-model`],
				identity: "active-profile",
			});
		} finally {
			releasePublicationFence.resolve();
			restorePublicationFence?.();
			restoreModelRegistryApiKey?.();
		}
	});

	it("does not restore a stale selection when a cycle finishes during reload preparation", async () => {
		const releasePublicationFence = Promise.withResolvers<void>();
		const cycleApiKey = Promise.withResolvers<string>();
		const releasePreparedSelection = Promise.withResolvers<void>();
		let publicationFenceEntered = false;
		let cycleApiKeyRequested = false;
		let livePreparationEntered = false;
		let restorePublicationFence: (() => void) | undefined;
		let restoreModelRegistryApiKey: (() => void) | undefined;
		let restorePrepareModelSelection: (() => void) | undefined;
		let reload: Promise<unknown> | undefined;
		let cycle: Promise<unknown> | undefined;
		try {
			const { configPath, modelsPath } = await createSession({
				modelId: "default-model",
				additionalModelId: "manual-model",
				withProfile: true,
			});
			session!.settings.set("modelRoles", { planner: `${provider}/manual-model` });
			await session!.settings.flushOrThrow();
			await session!.activateModelProfileForControl("active-profile");

			const originalAcquirePublicationFence = modelRegistry!.acquirePublicationFence.bind(modelRegistry!);
			const publicationFenceSpy = vi
				.spyOn(modelRegistry!, "acquirePublicationFence")
				.mockImplementation(async signal => {
					publicationFenceEntered = true;
					await releasePublicationFence.promise;
					return await originalAcquirePublicationFence(signal);
				});
			restorePublicationFence = () => publicationFenceSpy.mockRestore();

			const staged = candidate(
				22,
				configPath,
				modelsPath,
				settingsText({ todoEnabled: false, compactionEnabled: false }),
				modelsText({
					modelId: "manual-model",
					additionalModelId: "default-model",
					name: "After",
					baseUrl: "https://after.example/v1",
					withProfile: true,
				}),
			);
			reload = session!.reloadConfiguration(staged, new AbortController().signal);
			await waitFor(() => publicationFenceEntered);

			const apiKeySpy = vi.spyOn(modelRegistry!, "getApiKey").mockImplementation(async () => {
				cycleApiKeyRequested = true;
				return await cycleApiKey.promise;
			});
			restoreModelRegistryApiKey = () => apiKeySpy.mockRestore();
			cycle = session!.cycleRoleModels(["default", "planner"], { temporary: true });

			const originalPrepareModelSelection = session!.prepareModelSelectionForProfileActivation.bind(session!);
			const prepareSpy = vi
				.spyOn(session!, "prepareModelSelectionForProfileActivation")
				.mockImplementation(async (model, thinkingLevel, signal) => {
					const prepared = await originalPrepareModelSelection(model, thinkingLevel, signal);
					if (model.id === "default-model") {
						livePreparationEntered = true;
						await releasePreparedSelection.promise;
					}
					return prepared;
				});
			restorePrepareModelSelection = () => prepareSpy.mockRestore();

			await waitFor(() => cycleApiKeyRequested);
			releasePublicationFence.resolve();
			await waitFor(() => livePreparationEntered);
			cycleApiKey.resolve("temporary-cycle-key");
			await expect(cycle).resolves.toMatchObject({ model: { id: "manual-model" } });
			releasePreparedSelection.resolve();
			await expect(reload).rejects.toMatchObject({ code: "PUBLICATION_FAILED" });

			expect(session!.model).toMatchObject({ id: "manual-model", baseUrl: "https://before.example/v1" });
			expect(session!.getConfiguredModelChainState("default")).toMatchObject({
				entries: [`${provider}/default-model`],
				identity: "active-profile",
			});
			expect(modelRegistry!.find(provider, "default-model")?.baseUrl).toBe("https://before.example/v1");
		} finally {
			releasePublicationFence.resolve();
			cycleApiKey.resolve("cleanup-cycle-key");
			releasePreparedSelection.resolve();
			await Promise.allSettled(
				[reload, cycle].filter((operation): operation is Promise<unknown> => operation !== undefined),
			);
			restorePublicationFence?.();
			restoreModelRegistryApiKey?.();
			restorePrepareModelSelection?.();
		}
	});

	it("preserves a newer user selection and role state during profile reload rollback", async () => {
		const releasePublicationFence = Promise.withResolvers<void>();
		const releaseProfileRollback = Promise.withResolvers<void>();
		const cycleApiKey = Promise.withResolvers<string>();
		let publicationFenceEntered = false;
		let profileRollbackStarted = false;
		let cycleApiKeyRequested = false;
		let restorePublicationFence: (() => void) | undefined;
		let restoreModelRegistryApiKey: (() => void) | undefined;
		let restoreStageModelsReload: (() => void) | undefined;
		let restoreStagedFinalize: (() => void) | undefined;
		let restoreModelRollback: (() => void) | undefined;
		let restoreProfileRollback: (() => void) | undefined;
		let reload: Promise<unknown> | undefined;
		let cycle: Promise<unknown> | undefined;
		try {
			const { configPath, modelsPath } = await createSession({
				modelId: "default-model",
				additionalModelId: "manual-model",
				withProfile: true,
				profileRoleMapping: true,
			});
			session!.settings.set("modelRoles", { planner: `${provider}/manual-model` });
			await session!.settings.flushOrThrow();
			await session!.activateModelProfileForControl("active-profile");
			const originalProfileRollback = modelProfileActivation.rollbackPreparedModelProfileActivation;
			const profileRollbackSpy = vi
				.spyOn(modelProfileActivation, "rollbackPreparedModelProfileActivation")
				.mockImplementation(async (...args) => {
					profileRollbackStarted = true;
					await releaseProfileRollback.promise;
					return await originalProfileRollback(...args);
				});
			restoreProfileRollback = () => profileRollbackSpy.mockRestore();

			const originalAcquirePublicationFence = modelRegistry!.acquirePublicationFence.bind(modelRegistry!);
			const publicationFenceSpy = vi
				.spyOn(modelRegistry!, "acquirePublicationFence")
				.mockImplementation(async signal => {
					publicationFenceEntered = true;
					await releasePublicationFence.promise;
					return await originalAcquirePublicationFence(signal);
				});
			restorePublicationFence = () => publicationFenceSpy.mockRestore();

			const originalStageModelsReload = modelRegistry!.stageModelsConfigReload.bind(modelRegistry!);
			const stageModelsReloadSpy = vi
				.spyOn(modelRegistry!, "stageModelsConfigReload")
				.mockImplementation(async (...args) => {
					const stagedModels = await originalStageModelsReload(...args);
					const finalizeSpy = vi.spyOn(stagedModels, "finalize").mockImplementation(() => {
						throw new Error("Injected failure after publication");
					});
					restoreStagedFinalize = () => finalizeSpy.mockRestore();
					return stagedModels;
				});
			restoreStageModelsReload = () => stageModelsReloadSpy.mockRestore();

			const originalRestoreModelSelection = session!.restoreModelSelectionForRollback.bind(session!);
			const restoreModelSpy = vi
				.spyOn(session!, "restoreModelSelectionForRollback")
				.mockImplementation(
					async (model, thinkingLevel) => await originalRestoreModelSelection(model, thinkingLevel),
				);
			restoreModelRollback = () => restoreModelSpy.mockRestore();

			const staged = candidate(
				23,
				configPath,
				modelsPath,
				settingsText({ todoEnabled: false, compactionEnabled: false }),
				modelsText({
					modelId: "manual-model",
					additionalModelId: "default-model",
					name: "After",
					baseUrl: "https://after.example/v1",
					withProfile: true,
					profileRoleMapping: true,
				}),
			);
			reload = session!.reloadConfiguration(staged, new AbortController().signal);
			await waitFor(() => publicationFenceEntered);

			const apiKeySpy = vi.spyOn(modelRegistry!, "getApiKey").mockImplementation(async () => {
				cycleApiKeyRequested = true;
				return await cycleApiKey.promise;
			});
			restoreModelRegistryApiKey = () => apiKeySpy.mockRestore();
			cycle = session!.cycleRoleModels(["default", "planner"], { temporary: true });
			await waitFor(() => cycleApiKeyRequested);
			releasePublicationFence.resolve();
			await waitFor(() => profileRollbackStarted);
			cycleApiKey.resolve("temporary-cycle-key");
			await expect(cycle).resolves.toMatchObject({ model: { id: "manual-model" }, role: "planner" });
			const manualModel = modelRegistry!.find(provider, "manual-model");
			if (!manualModel) throw new Error("Expected the manual model to remain available during rollback");
			await session!.setModelTemporary(manualModel, undefined, {
				cause: "user-selection",
				persistAsSessionDefault: true,
			});
			const selectedModel = session!.model;
			const selectedChain = session!.getConfiguredModelChainState("default");
			const selectedAgentOverrides = session!.settings.getOverride("task.agentModelOverrides");
			const selectedProfile = session!.getActiveModelProfile();
			const selectedInstalledOverrides = session!.getProfileInstalledOverrideState();
			expect(selectedAgentOverrides?.planner).not.toBe(`${provider}/manual-model`);
			expect(selectedProfile).toBeUndefined();
			releaseProfileRollback.resolve();
			await expect(reload).rejects.toMatchObject({ code: "PUBLICATION_FAILED" });

			expect(restoreModelSpy).toHaveBeenCalledTimes(1);
			expect(restoreModelSpy.mock.calls[0]?.[0]).toMatchObject({
				id: "manual-model",
				baseUrl: "https://before.example/v1",
			});
			expect(session!.model).toMatchObject({ id: "manual-model", baseUrl: "https://before.example/v1" });
			expect(modelRegistry!.find(provider, "default-model")?.baseUrl).toBe("https://before.example/v1");
			expect(session!.model).not.toBe(selectedModel);
			expect(session!.getConfiguredModelChainState("default")).toEqual(selectedChain);
			expect(session!.settings.getOverride("task.agentModelOverrides")).toEqual(selectedAgentOverrides);
			expect(session!.getActiveModelProfile()).toBe(selectedProfile);
			expect(session!.getProfileInstalledOverrideState()).toEqual(selectedInstalledOverrides);
		} finally {
			releasePublicationFence.resolve();
			releaseProfileRollback.resolve();
			cycleApiKey.resolve("cleanup-cycle-key");
			await Promise.allSettled(
				[reload, cycle].filter((operation): operation is Promise<unknown> => operation !== undefined),
			);
			restorePublicationFence?.();
			restoreModelRegistryApiKey?.();
			restoreStagedFinalize?.();
			restoreStageModelsReload?.();
			restoreModelRollback?.();
			restoreProfileRollback?.();
		}
	});

	it.each([
		{
			name: "restores the captured level",
			thinkingControlLevel: undefined,
			expectedLevel: ThinkingLevel.High,
		},
		{
			name: "preserves a same-effective explicit level",
			thinkingControlLevel: ThinkingLevel.Low,
			expectedLevel: ThinkingLevel.Low,
		},
	])("$name after a clamped reload rollback", async ({ thinkingControlLevel, expectedLevel }) => {
		const releasePublicationFence = Promise.withResolvers<void>();
		const releaseLivePreparation = Promise.withResolvers<void>();
		const releaseProfileRollback = Promise.withResolvers<void>();
		const cycleApiKey = Promise.withResolvers<string | undefined>();
		let publicationFenceEntered = false;
		let livePreparationEntered = false;
		let profileRollbackStarted = false;
		let cycleApiKeyRequested = false;
		let restorePublicationFence: (() => void) | undefined;
		let restoreLivePreparation: (() => void) | undefined;
		let restoreModelRegistryApiKey: (() => void) | undefined;
		let restoreStageModelsReload: (() => void) | undefined;
		let restoreStagedFinalize: (() => void) | undefined;
		let restoreModelRollback: (() => void) | undefined;
		let restoreProfileRollback: (() => void) | undefined;
		let reload: Promise<unknown> | undefined;
		let cycle: Promise<unknown> | undefined;
		try {
			const { configPath, modelsPath } = await createSession({
				modelId: "default-model",
				additionalModelId: "manual-model",
				withProfile: true,
				thinking: { minLevel: "low", maxLevel: "high", defaultLevel: "high" },
			});
			session!.setThinkingLevel(ThinkingLevel.High);
			session!.settings.set("modelRoles", { planner: `${provider}/manual-model` });
			await session!.settings.flushOrThrow();
			await session!.activateModelProfileForControl("active-profile");
			const originalProfileRollback = modelProfileActivation.rollbackPreparedModelProfileActivation;
			const profileRollbackSpy = vi
				.spyOn(modelProfileActivation, "rollbackPreparedModelProfileActivation")
				.mockImplementation(async (...args) => {
					profileRollbackStarted = true;
					await releaseProfileRollback.promise;
					return await originalProfileRollback(...args);
				});
			restoreProfileRollback = () => profileRollbackSpy.mockRestore();

			const originalAcquirePublicationFence = modelRegistry!.acquirePublicationFence.bind(modelRegistry!);
			const publicationFenceSpy = vi
				.spyOn(modelRegistry!, "acquirePublicationFence")
				.mockImplementation(async signal => {
					publicationFenceEntered = true;
					await releasePublicationFence.promise;
					return await originalAcquirePublicationFence(signal);
				});
			restorePublicationFence = () => publicationFenceSpy.mockRestore();

			const originalStageModelsReload = modelRegistry!.stageModelsConfigReload.bind(modelRegistry!);
			const stageModelsReloadSpy = vi
				.spyOn(modelRegistry!, "stageModelsConfigReload")
				.mockImplementation(async (...args) => {
					const stagedModels = await originalStageModelsReload(...args);
					const finalizeSpy = vi.spyOn(stagedModels, "finalize").mockImplementation(() => {
						throw new Error("Injected failure after publication");
					});
					restoreStagedFinalize = () => finalizeSpy.mockRestore();
					return stagedModels;
				});
			restoreStageModelsReload = () => stageModelsReloadSpy.mockRestore();

			const originalRestoreModelSelection = session!.restoreModelSelectionForRollback.bind(session!);
			const restoreModelSpy = vi
				.spyOn(session!, "restoreModelSelectionForRollback")
				.mockImplementation(
					async (model, thinkingLevel) => await originalRestoreModelSelection(model, thinkingLevel),
				);
			restoreModelRollback = () => restoreModelSpy.mockRestore();

			const staged = candidate(
				24,
				configPath,
				modelsPath,
				settingsText({ todoEnabled: false, compactionEnabled: false }),
				modelsText({
					modelId: "default-model",
					additionalModelId: "manual-model",
					name: "After",
					baseUrl: "https://after.example/v1",
					withProfile: true,
					thinking: { minLevel: "low", maxLevel: "low", defaultLevel: "low" },
				}),
			);
			reload = session!.reloadConfiguration(staged, new AbortController().signal);
			await waitFor(() => publicationFenceEntered);

			const apiKeySpy = vi.spyOn(modelRegistry!, "getApiKey").mockImplementation(async () => {
				cycleApiKeyRequested = true;
				return await cycleApiKey.promise;
			});
			restoreModelRegistryApiKey = () => apiKeySpy.mockRestore();
			const originalPrepareModelSelection = session!.prepareModelSelectionForProfileActivation.bind(session!);
			const prepareModelSelectionSpy = vi
				.spyOn(session!, "prepareModelSelectionForProfileActivation")
				.mockImplementation(async (model, thinkingLevel, signal) => {
					const prepared = await originalPrepareModelSelection(model, thinkingLevel, signal);
					if (model.id === "default-model") {
						livePreparationEntered = true;
						await releaseLivePreparation.promise;
					}
					return prepared;
				});
			restoreLivePreparation = () => prepareModelSelectionSpy.mockRestore();
			const cycleOperation = session!.cycleRoleModels(["default", "planner"], { temporary: true });
			cycle = cycleOperation;
			const cycleOutcome = cycleOperation.then(
				() => ({ status: "resolved" as const }),
				error => ({ status: "rejected" as const, error }),
			);
			expect(cycleApiKeyRequested).toBe(true);
			releasePublicationFence.resolve();
			await waitFor(() => livePreparationEntered);
			cycleApiKey.resolve(undefined);
			const outcome = await cycleOutcome;
			if (outcome.status === "resolved") throw new Error("Expected role cycle to reject without an API key");
			expect(outcome.error).toMatchObject({ message: "No API key for reload-test/manual-model" });
			releaseLivePreparation.resolve();
			await waitFor(() => profileRollbackStarted);
			expect(session!.thinkingLevel).toBe(ThinkingLevel.Low);
			if (thinkingControlLevel !== undefined) {
				await session!.setThinkingLevelForControl(thinkingControlLevel, false);
			}
			releaseProfileRollback.resolve();
			await expect(reload).rejects.toMatchObject({ code: "PUBLICATION_FAILED" });

			expect(restoreModelSpy).toHaveBeenCalledTimes(1);
			expect(session!.model).toMatchObject({ id: "default-model", baseUrl: "https://before.example/v1" });
			expect(session!.thinkingLevel).toBe(expectedLevel);
			expect(modelRegistry!.find(provider, "default-model")?.baseUrl).toBe("https://before.example/v1");
		} finally {
			releasePublicationFence.resolve();
			releaseLivePreparation.resolve();
			releaseProfileRollback.resolve();
			cycleApiKey.resolve(undefined);
			await Promise.allSettled(
				[reload, cycle].filter((operation): operation is Promise<unknown> => operation !== undefined),
			);
			restorePublicationFence?.();
			restoreLivePreparation?.();
			restoreModelRegistryApiKey?.();
			restoreStagedFinalize?.();
			restoreStageModelsReload?.();
			restoreModelRollback?.();
			restoreProfileRollback?.();
		}
	});

	it("restores the current model when prepared selection commit fails before thinking update", async () => {
		const { configPath, modelsPath, sessionManager } = await createSession({
			modelId: "default-model",
			thinking: { minLevel: "low", maxLevel: "high", defaultLevel: "high" },
		});
		session!.setThinkingLevel(ThinkingLevel.High);

		const originalAppendModelChange = sessionManager.appendModelChange.bind(sessionManager);
		let failTemporaryAppend = true;
		const appendModelChangeSpy = vi.spyOn(sessionManager, "appendModelChange").mockImplementation((model, role) => {
			if (failTemporaryAppend && role === "temporary") {
				failTemporaryAppend = false;
				throw new Error("Injected session append failure");
			}
			return originalAppendModelChange(model, role);
		});
		try {
			const staged = candidate(
				25,
				configPath,
				modelsPath,
				settingsText({ todoEnabled: false, compactionEnabled: false }),
				modelsText({
					modelId: "default-model",
					name: "After",
					baseUrl: "https://after.example/v1",
					thinking: { minLevel: "low", maxLevel: "low", defaultLevel: "low" },
				}),
			);
			await expect(session!.reloadConfiguration(staged, new AbortController().signal)).rejects.toMatchObject({
				code: "PUBLICATION_FAILED",
			});

			expect(failTemporaryAppend).toBe(false);
			expect(session!.model).toMatchObject({ id: "default-model", baseUrl: "https://before.example/v1" });
			expect(session!.thinkingLevel).toBe(ThinkingLevel.High);
			expect(modelRegistry!.find(provider, "default-model")?.baseUrl).toBe("https://before.example/v1");
		} finally {
			appendModelChangeSpy.mockRestore();
		}
	});

	it("preserves a reentrant same-effective thinking control during reload rollback", async () => {
		const { configPath, modelsPath } = await createSession({
			modelId: "default-model",
			thinking: { minLevel: "low", maxLevel: "high", defaultLevel: "high" },
		});
		session!.setThinkingLevel(ThinkingLevel.High);

		const originalStageModelsReload = modelRegistry!.stageModelsConfigReload.bind(modelRegistry!);
		let restoreStagedFinalize: (() => void) | undefined;
		const stageModelsReloadSpy = vi
			.spyOn(modelRegistry!, "stageModelsConfigReload")
			.mockImplementation(async (...args) => {
				const stagedModels = await originalStageModelsReload(...args);
				const finalizeSpy = vi.spyOn(stagedModels, "finalize").mockImplementation(() => {
					throw new Error("Injected failure after publication");
				});
				restoreStagedFinalize = () => finalizeSpy.mockRestore();
				return stagedModels;
			});
		let explicitControlApplied = false;
		const unsubscribe = session!.subscribe(event => {
			if (
				!explicitControlApplied &&
				event.type === "thinking_level_changed" &&
				event.thinkingLevel === ThinkingLevel.Low
			) {
				explicitControlApplied = true;
				void session!.setThinkingLevelForControl(ThinkingLevel.Low, false);
			}
		});
		try {
			const staged = candidate(
				26,
				configPath,
				modelsPath,
				settingsText({ todoEnabled: false, compactionEnabled: false }),
				modelsText({
					modelId: "default-model",
					name: "After",
					baseUrl: "https://after.example/v1",
					thinking: { minLevel: "low", maxLevel: "low", defaultLevel: "low" },
				}),
			);
			await expect(session!.reloadConfiguration(staged, new AbortController().signal)).rejects.toMatchObject({
				code: "PUBLICATION_FAILED",
			});

			expect(explicitControlApplied).toBe(true);
			expect(session!.model).toMatchObject({ id: "default-model", baseUrl: "https://before.example/v1" });
			expect(session!.thinkingLevel).toBe(ThinkingLevel.Low);
			expect(modelRegistry!.find(provider, "default-model")?.baseUrl).toBe("https://before.example/v1");
		} finally {
			unsubscribe();
			restoreStagedFinalize?.();
			stageModelsReloadSpy.mockRestore();
		}
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
