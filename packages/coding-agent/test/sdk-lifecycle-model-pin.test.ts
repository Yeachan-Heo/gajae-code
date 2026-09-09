import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, Effort } from "@gajae-code/ai";
import { getSupportedEfforts } from "@gajae-code/ai/model-thinking";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { hookFetch } from "@gajae-code/utils";
import { initializeLifecycleModelSelection, openLifecycleSessionManager } from "../src/commands/sdk";
import { applyStartupModelProfiles } from "../src/main";
import { createNetworkPrewarmService } from "../src/runtime/network-prewarm-service";
import { deriveLifecycleDeadlines } from "../src/sdk/broker/lifecycle";
import { createLifecycleAgentSession } from "../src/sdk/lifecycle-session";

/**
 * The coordinator model pin (#4707) validates a selector against its own
 * registry and the child resolves it against the registry that actually serves
 * requests. Those two can disagree. These tests pin the seam where that
 * disagreement used to become a silent substitution: construction succeeded
 * with no model, the discarded fallback warning let startup profile
 * application choose `modelProfile.default`/`mpreset` instead, and the
 * coordinator still reported the requested pin.
 */
describe("lifecycle session explicit model pin", () => {
	const createdDirs = new Set<string>();
	const ownedRegistries = new Set<ModelRegistry>();
	let authStorage: AuthStorage;
	let priorRegistryDisabled: string | undefined;

	const createRegistry = (cwd: string, settings: Settings): ModelRegistry => {
		const registry = new ModelRegistry(authStorage, path.join(cwd, "models.yml"), settings, {
			automaticRefresh: false,
		});
		ownedRegistries.add(registry);
		return registry;
	};

	const lifecycleOptions = (cwd: string, settings: Settings) => ({
		cwd,
		agentDir: cwd,
		authStorage,
		modelRegistry: createRegistry(cwd, settings),
		// Model-host preconnect is independent of registry refresh and is not
		// intercepted by hookFetch. Use the real disabled service for this fixture.
		runtimeServices: {
			networkPrewarm: createNetworkPrewarmService(Settings.isolated({ "startup.networkPrewarm": false })),
		},
		sessionManager: SessionManager.inMemory(cwd),
		settings,
		disableExtensionDiscovery: true,
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		enableLsp: false,
		toolNames: [],
	});

	beforeEach(async () => {
		priorRegistryDisabled = process.env.GJC_MODEL_PRESET_REGISTRY_DISABLED;
		process.env.GJC_MODEL_PRESET_REGISTRY_DISABLED = "1";
		authStorage = await AuthStorage.create(":memory:");
		// The pin must apply on a credential the CLI would also accept; the issue's
		// evidence is a stored Cursor credential without a usage probe.
		authStorage.setRuntimeApiKey("cursor", "test-key");
		authStorage.setRuntimeApiKey("anthropic", "test-key");
	});

	afterEach(async () => {
		try {
			// This fixture exercises synthetic model pins, not the online preset registry.
			await Promise.all([...ownedRegistries].map(registry => registry.dispose()));
			ownedRegistries.clear();
			authStorage.close();
			for (const dir of createdDirs) {
				await fs.promises.rm(dir, { recursive: true, force: true });
			}
			createdDirs.clear();
		} finally {
			if (priorRegistryDisabled === undefined) delete process.env.GJC_MODEL_PRESET_REGISTRY_DISABLED;
			else process.env.GJC_MODEL_PRESET_REGISTRY_DISABLED = priorRegistryDisabled;
		}
	});

	const tempCwd = (): string => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-lifecycle-model-pin-"));
		createdDirs.add(cwd);
		return cwd;
	};

	test("lifecycle manager initialization leaves pending global migrations untouched", async () => {
		const cwd = tempCwd();
		const configPath = path.join(cwd, "config.yml");
		const legacyPath = path.join(cwd, "settings.json");
		const originalBytes = "# Uninitialized schema\nautoResume: false\nmodelProfile:\n  default: synthetic-global\n";
		const legacyBytes = '{"theme":"synthetic-legacy"}\n';
		await Bun.write(configPath, originalBytes);
		await Bun.write(legacyPath, legacyBytes);
		const opened = await openLifecycleSessionManager(
			{
				operation: "session.create",
				sessionId: "synthetic-session",
				cwd,
				stateRoot: path.join(cwd, "state"),
				...deriveLifecycleDeadlines(1_000_000, 4_000),
			},
			cwd,
			cwd,
		);
		try {
			expect(opened.parsed.continue).toBeUndefined();
			await Bun.sleep(150);
			expect(await Bun.file(configPath).text()).toBe(originalBytes);
			expect(await Bun.file(legacyPath).text()).toBe(legacyBytes);
		} finally {
			await opened.sessionManager?.close();
		}
		expect(await Bun.file(configPath).text()).toBe(originalBytes);
		expect(await Bun.file(legacyPath).text()).toBe(legacyBytes);
	});

	for (const profile of ["global-fixture", "session-fixture", undefined]) {
		test(`startup modelId preserves shared config with ${profile ?? "no profile"}`, async () => {
			const requests: string[] = [];
			using _fetch = hookFetch(input => {
				let target = "unparseable-request-target";
				try {
					const url = new URL(input instanceof Request ? input.url : String(input));
					target = `${url.hostname}${url.pathname}`;
				} catch {
					// Never include raw input: it may contain credentials or query data.
				}
				requests.push(target);
				throw new Error(`Synthetic lifecycle blocked network request: ${target}`);
			});
			const cwd = tempCwd();
			const configPath = path.join(cwd, "config.yml");
			const originalBytes = JSON.stringify({
				modelProfile: profile ? { default: "global-fixture" } : {},
				modelRoles: { default: "cursor/composer-2.5" },
				task: { agentModelOverrides: { critic: "cursor/composer-2.5" } },
			});
			await Bun.write(configPath, originalBytes);
			const options = lifecycleOptions(cwd, Settings.isolated());
			const registry = options.modelRegistry;
			await registry.saveCustomModelProfile("global-fixture", {
				required_providers: ["cursor"],
				model_mapping: { default: "cursor/composer-2.5", critic: "cursor/composer-2.5" },
			});
			await registry.saveCustomModelProfile("session-fixture", {
				required_providers: ["anthropic"],
				model_mapping: { default: "anthropic/claude-sonnet-4-5", critic: "anthropic/claude-sonnet-4-5" },
			});
			// The catalog is synthetic and already loaded; startup refresh is not
			// part of this regression and must not perform provider discovery.
			using _refresh = vi.spyOn(registry, "refresh").mockResolvedValue(undefined);
			using _background = vi.spyOn(registry, "refreshInBackground").mockImplementation(() => {});
			const created = await createLifecycleAgentSession({
				...options,
				settings: undefined,
				modelId: "anthropic/claude-sonnet-4-5",
				enableMCP: false,
				rules: [],
				workspaceTree: { rootPath: cwd, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
			});
			try {
				if ("failure" in created) throw new Error(created.failure.message);
				await applyStartupModelProfiles({
					session: created.session,
					settings: created.session.settings,
					modelRegistry: registry,
					parsedArgs: {
						model: "anthropic/claude-sonnet-4-5",
						...(profile === "session-fixture" ? { mpreset: profile } : {}),
					},
				});
				expect(created.session.model?.id).toBe("claude-sonnet-4-5");
				expect(created.session.getActiveModelProfile()).toBeUndefined();
				expect(created.session.getSessionDefaultModelSelector()).toBe("anthropic/claude-sonnet-4-5");
				expect(created.session.settings.get("task.agentModelOverrides").critic).toBe("cursor/composer-2.5");
				expect(created.session.settings.getGlobal("modelProfile.default")).toBe(
					profile ? "global-fixture" : undefined,
				);
				expect(created.session.settings.getGlobal("modelRoles")).toEqual({ default: "cursor/composer-2.5" });
				await Bun.sleep(150);
				await created.session.settings.flushOrThrow();
				expect(await Bun.file(configPath).text()).toBe(originalBytes);
				expect(requests).toEqual([]);
			} finally {
				try {
					if (!("failure" in created)) await created.session.dispose();
				} finally {
					await registry.dispose();
					ownedRegistries.delete(registry);
				}
			}
			// Keep the guard installed through both session and registry shutdown.
			expect(requests).toEqual([]);
			expect(await Bun.file(configPath).text()).toBe(originalBytes);
		}, 30_000);
	}

	for (const mode of ["keep", "missing-default-credential", "modelId", "modelPreset", "useCurrentDefault"] as const) {
		test(`host resume restores only runtime profile roles: ${mode}`, async () => {
			const requests: string[] = [];
			using _fetch = hookFetch(input => {
				const url = new URL(input instanceof Request ? input.url : String(input));
				requests.push(`${url.hostname}${url.pathname}`);
				throw new Error("Synthetic host resume must remain offline");
			});
			const cwd = tempCwd();
			const configPath = path.join(cwd, "config.yml");
			const configBytes = JSON.stringify({
				modelProfile: { default: "saved-fixture" },
				session: { resumeModelBehavior: mode === "useCurrentDefault" ? "useCurrentDefault" : "keepSessionModel" },
			});
			await Bun.write(configPath, configBytes);
			// A provider name and reasoning metadata alone do not authorize effort
			// on an arbitrary OPENAI_BASE_URL. Pin the audited transport in the
			// fixture's models config, which outranks the inherited environment.
			// The fetch guard and disabled prewarm still prohibit provider traffic.
			const providers = { openai: { baseUrl: "https://api.openai.com/v1" } };
			await Bun.write(path.join(cwd, "models.yml"), JSON.stringify({ providers }));
			const options = lifecycleOptions(cwd, Settings.isolated());
			const registry = options.modelRegistry;
			const a = "anthropic/claude-sonnet-4-5";
			const b = "openai/gpt-5.2";
			if (mode !== "missing-default-credential") authStorage.setRuntimeApiKey("openai", "synthetic-key");
			await registry.saveCustomModelProfile("saved-fixture", {
				required_providers: ["anthropic"],
				model_mapping: { default: `${a}:low`, critic: a },
			});
			const saved = SessionManager.create(cwd, path.join(cwd, "sessions"));
			saved.appendModelChange(a, "default");
			saved.appendConfiguredModelChain({
				role: "default",
				entries: [a],
				origin: "profile-activation",
				identity: "saved-fixture",
				explicitHead: true,
			});
			saved.appendThinkingLevelChange(Effort.High, true);
			await saved.ensureOnDisk();
			await saved.flush();
			const sessionFile = saved.getSessionFile();
			await saved.close();
			if (!sessionFile) throw new Error("Expected saved synthetic session");
			// Edit the profile after saving A. Its new default must not own resume.
			await Bun.write(
				path.join(cwd, "models.yml"),
				JSON.stringify({
					providers,
					profiles: {
						"saved-fixture": {
							required_providers: ["openai"],
							model_mapping: { default: `${b}:low`, critic: `${a}:low` },
						},
					},
				}),
			);
			await registry.refreshStatic();
			const target = registry.find("openai", "gpt-5.2");
			if (!target) throw new Error("Expected bundled GPT-5.2 fixture model");
			expect(target.baseUrl).toBe("https://api.openai.com/v1");
			expect(getSupportedEfforts(target)).toEqual([Effort.Low, Effort.Medium, Effort.High, Effort.XHigh]);
			using _refresh = vi.spyOn(registry, "refresh").mockResolvedValue(undefined);
			using _background = vi.spyOn(registry, "refreshInBackground").mockImplementation(() => {});
			const resumedManager = await SessionManager.open(sessionFile, cwd);
			const created = await createLifecycleAgentSession({
				...options,
				settings: undefined,
				sessionManager: resumedManager,
				...(mode === "modelId" ? { modelId: `${b}:low` } : {}),
				enableMcpAutoload: false,
				rules: [],
				workspaceTree: { rootPath: cwd, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
			});
			if ("failure" in created) throw new Error(created.failure.message);
			try {
				const session = created.session;
				const keep = mode === "keep" || mode === "missing-default-credential";
				if (keep || mode === "modelPreset") {
					expect(session.model?.id).toBe("claude-sonnet-4-5");
					expect(session.thinkingLevel).toBe(Effort.High);
					expect(session.getThinkingScopeForControl()).toBe("session");
				}
				const beforeModel = session.model;
				const beforeChain = session.getConfiguredModelChainState("default");
				const beforeEntries = structuredClone(resumedManager.getEntries());
				const beforeAffinity = registry.getSessionCanonicalVariant(session.credentialSessionId);
				using keyProbe = vi.spyOn(registry, "getApiKeyForProvider");
				using modelMutation = vi.spyOn(session, "setModelTemporary");
				await initializeLifecycleModelSelection(
					session,
					{
						operation: "session.resume",
						...(mode === "modelId" ? { modelId: `${b}:low` } : {}),
						...(mode === "modelPreset" ? { modelPreset: "saved-fixture" } : {}),
					},
					{
						...(mode === "modelId" ? { model: `${b}:low` } : {}),
						...(mode === "modelPreset" ? { mpreset: "saved-fixture" } : {}),
					},
				);
				if (keep) {
					expect(session.model).toBe(beforeModel);
					expect(session.thinkingLevel).toBe(Effort.High);
					expect(session.getThinkingScopeForControl()).toBe("session");
					expect(session.getConfiguredModelChainState("default")).toEqual(beforeChain);
					expect(session.getSessionDefaultModelSelector()).toBe(a);
					expect(resumedManager.getEntries()).toEqual(beforeEntries);
					expect(registry.getSessionCanonicalVariant(session.credentialSessionId)).toBe(beforeAffinity);
					expect(keyProbe).not.toHaveBeenCalled();
					expect(modelMutation).not.toHaveBeenCalled();
					expect(session.settings.get("task.agentModelOverrides").critic).toBe(`${a}:low`);
					expect(session.getProfileInstalledOverrideKeys().agentModelOverrides).toContain("critic");
				} else {
					expect(session.model?.id).toBe("gpt-5.2");
					expect(session.thinkingLevel).toBe(Effort.Low);
					expect(modelMutation).toHaveBeenCalledWith(
						expect.objectContaining({ provider: "openai", id: "gpt-5.2" }),
						Effort.Low,
						expect.objectContaining({ cause: mode === "modelId" ? "startup-override" : "profile-activation" }),
					);
					const thinkingEntries = resumedManager
						.getEntries()
						.filter(entry => entry.type === "thinking_level_change");
					expect(thinkingEntries.at(-1)).toMatchObject({ thinkingLevel: Effort.Low });
				}
				await Bun.sleep(150);
				await session.settings.flushOrThrow();
				expect(await Bun.file(configPath).text()).toBe(configBytes);
				await resumedManager.flush();
			} finally {
				await created.session.dispose();
			}
			if (mode === "modelId") {
				// No modelId on the next launch: only the on-disk selection may
				// supply B/low. Reuse the real host policy, not a replay imitation.
				const reopenedManager = await SessionManager.open(sessionFile, cwd);
				const reopened = await createLifecycleAgentSession({
					...options,
					settings: undefined,
					sessionManager: reopenedManager,
					enableMcpAutoload: false,
					rules: [],
					workspaceTree: { rootPath: cwd, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
				});
				if ("failure" in reopened) throw new Error(reopened.failure.message);
				try {
					expect(reopened.session.model?.id).toBe("gpt-5.2");
					expect(reopened.session.thinkingLevel).toBe(Effort.Low);
					await initializeLifecycleModelSelection(reopened.session, { operation: "session.resume" }, {});
					expect(reopened.session.model?.id).toBe("gpt-5.2");
					expect(reopened.session.thinkingLevel).toBe(Effort.Low);
					expect(reopened.session.getSessionDefaultModelSelector()).toBe(b);
					expect(reopened.session.getConfiguredModelChain("default")).toEqual([b]);
				} finally {
					await reopened.session.dispose();
				}
			}
			await registry.dispose();
			ownedRegistries.delete(registry);
			expect(await Bun.file(configPath).text()).toBe(configBytes);
			expect(requests).toEqual([]);
		}, 30_000);
	}

	test("fails before readiness when the child registry cannot resolve the pin", async () => {
		const cwd = tempCwd();
		// A project-scoped default profile is exactly what would otherwise be
		// activated in the pin's place once construction returned no model.
		const settings = Settings.isolated({ "modelProfile.default": "codex-medium" });
		const created = await createLifecycleAgentSession({
			...lifecycleOptions(cwd, settings),
			modelId: "cursor/model-removed-since-coordinator-validated-it",
		});

		expect("failure" in created).toBe(true);
		if (!("failure" in created)) return;
		expect(created.failure.phase).toBe("registration");
		// The error names the exact pinned selector so the caller can tell a
		// drifted pin apart from an unrelated startup failure.
		expect(created.failure.message).toContain("cursor/model-removed-since-coordinator-validated-it");
		expect(created.failure.message).toContain("--list-models");
		// No session escaped, so startup profile application never runs and no
		// alternate model can activate behind the reported pin.
		expect("session" in created).toBe(false);
	}, 30_000);

	test("keeps the pin as the effective model after default-profile and mpreset processing", async () => {
		const cwd = tempCwd();
		const settings = Settings.isolated();
		const created = await createLifecycleAgentSession({
			...lifecycleOptions(cwd, settings),
			modelId: "cursor/composer-2.5",
		});

		if ("failure" in created) throw new Error(`Lifecycle construction failed: ${created.failure.message}`);
		try {
			expect(`${created.session.model?.provider}/${created.session.model?.id}`).toBe("cursor/composer-2.5");

			// The host runs this next. `--model` precedence must survive it: the
			// pin is threaded as `parsedArgs.model`, so an activated profile
			// cannot outrank it.
			await applyStartupModelProfiles({
				session: created.session,
				settings,
				modelRegistry: created.session.modelRegistry,
				parsedArgs: { model: "cursor/composer-2.5" },
			});

			expect(`${created.session.model?.provider}/${created.session.model?.id}`).toBe("cursor/composer-2.5");
		} finally {
			await created.session.dispose();
		}
	}, 30_000);

	test("preserves an explicit thinking suffix through lifecycle validation", async () => {
		const cwd = tempCwd();
		const settings = Settings.isolated();
		const created = await createLifecycleAgentSession({
			...lifecycleOptions(cwd, settings),
			modelId: "anthropic/claude-sonnet-4-5:high",
		});

		if ("failure" in created) throw new Error(`Lifecycle construction failed: ${created.failure.message}`);
		try {
			expect(`${created.session.model?.provider}/${created.session.model?.id}`).toBe("anthropic/claude-sonnet-4-5");
			expect(String(created.session.thinkingLevel)).toBe("high");
			await applyStartupModelProfiles({
				session: created.session,
				settings,
				modelRegistry: created.session.modelRegistry,
				parsedArgs: { model: "anthropic/claude-sonnet-4-5:high" },
				startupThinkingLevel: "high" as never,
			});
			expect(String(created.session.thinkingLevel)).toBe("high");
		} finally {
			await created.session.dispose();
		}
	}, 30_000);
});
