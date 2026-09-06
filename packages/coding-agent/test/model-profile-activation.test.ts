import { describe, expect, it, test, vi } from "bun:test";
import { Agent, ThinkingLevel } from "@gajae-code/agent-core";

import type { Model } from "@gajae-code/ai";
import { hookFetch, TempDir } from "@gajae-code/utils";
import {
	activateModelProfile,
	applyPreparedModelProfileActivation,
	formatModelProfileCredentialError,
	ModelProfileCredentialError,
	materializeActiveModelProfileAssignment,
	materializeActiveModelProfileAssignments,
	materializeModelProfileForDeletion,
	prepareModelProfileActivation,
	restoreMaterializedModelProfileForDeletion,
} from "../src/config/model-profile-activation";

import type { ModelProfileDefinition } from "../src/config/model-profiles";
import { BUILTIN_MODEL_PROFILES, mergeModelProfiles } from "../src/config/model-profiles";
import { kNoAuth, ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { AgentSession, type DefaultFallbackRuntimeState } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";

const model = (provider: string, id: string, thinking?: Model["thinking"]): Model =>
	({
		provider,
		id,
		name: id,
		api: "openai-responses",
		contextWindow: 1000,
		maxTokens: 1000,
		input: ["text"],
		thinking,
		reasoning: thinking !== undefined,
		compat: thinking ? { supportsReasoningEffort: true } : undefined,
	}) as Model;

function fakeRegistry(options?: { missingProviders?: string[]; profiles?: ModelProfileDefinition[] }) {
	const profiles = new Map<string, ModelProfileDefinition>();
	for (const profile of options?.profiles ?? [
		{
			name: "profile-a",
			requiredProviders: ["provider-a", "provider-b"],
			modelMapping: {
				default: "provider-a/default:high",
				executor: "provider-b/executor",
				architect: "provider-a/architect",
			},
			source: "user" as const,
		},
	]) {
		profiles.set(profile.name, profile);
	}
	const missing = new Set(options?.missingProviders ?? []);
	return {
		getModelProfile: (name: string) => profiles.get(name),
		getModelProfiles: () => new Map(profiles),
		getAvailableModelProfileNames: () => [...profiles.keys()].sort(),
		getApiKeyForProvider: async (provider: string) => (missing.has(provider) ? undefined : `key-${provider}`),
		getAll: () => [
			model("provider-a", "default"),
			model("provider-b", "executor"),
			model("provider-a", "architect"),
			model("provider-c", "default"),
			model("provider-c", "executor"),
			model("provider-c", "architect"),
			model("openai-codex", "gpt-5.4"),
			model("openai-codex", "gpt-5.1-codex-max"),
			model("openai-codex", "gpt-5.2-codex"),
			model("openai-codex", "gpt-5.5", {
				mode: "effort",
				minLevel: ThinkingLevel.Low,
				maxLevel: ThinkingLevel.XHigh,
			}),
			model("openai-codex", "gpt-5.6-sol", {
				mode: "effort",
				minLevel: ThinkingLevel.Low,
				maxLevel: ThinkingLevel.Max,
			}),
			model("openai-codex", "gpt-5.6-terra", {
				mode: "effort",
				minLevel: ThinkingLevel.Low,
				maxLevel: ThinkingLevel.Max,
			}),
			model("openai-codex", "gpt-5.6-luna", {
				mode: "effort",
				minLevel: ThinkingLevel.Low,
				maxLevel: ThinkingLevel.Max,
			}),
			model("openai-codex", "gpt-5.3-codex-spark"),
			model("anthropic", "claude-opus-5", {
				mode: "effort",
				minLevel: ThinkingLevel.Low,
				maxLevel: ThinkingLevel.XHigh,
			}),
			model("anthropic", "claude-fable-5", {
				mode: "effort",
				minLevel: ThinkingLevel.Low,
				maxLevel: ThinkingLevel.XHigh,
			}),
			model("anthropic", "claude-fable-5-1", {
				mode: "effort",
				minLevel: ThinkingLevel.Low,
				maxLevel: ThinkingLevel.XHigh,
			}),
			model("anthropic", "claude-sonnet-5"),
			model("anthropic", "claude-opus-4-6", {
				mode: "effort",
				minLevel: ThinkingLevel.Low,
				maxLevel: ThinkingLevel.XHigh,
			}),
			model("opencode-go", "deepseek-v4-pro"),
			model("opencode-go", "kimi-k3"),
			model("opencode-go", "mimo-v2.5-pro"),
			model("minimax-code", "MiniMax-M3"),
			model("minimax-code-cn", "MiniMax-M3"),
			model("kimi-code", "kimi-k2.5"),
			model("zai", "glm-5.1"),
			model("alibaba-token-plan", "qwen3.8-max-preview", {
				mode: "effort",
				minLevel: ThinkingLevel.Minimal,
				maxLevel: ThinkingLevel.XHigh,
			}),
			model("alibaba-token-plan", "qwen3.8-max", {
				mode: "effort",
				minLevel: ThinkingLevel.Minimal,
				maxLevel: ThinkingLevel.XHigh,
			}),
			model("alibaba-token-plan", "glm-5.2", {
				mode: "effort",
				minLevel: ThinkingLevel.Minimal,
				maxLevel: ThinkingLevel.XHigh,
			}),
			model("alibaba-token-plan", "deepseek-v4-pro", {
				mode: "effort",
				minLevel: ThinkingLevel.Minimal,
				maxLevel: ThinkingLevel.XHigh,
			}),
		],
		resolveCanonicalModel: () => undefined,
		getCanonicalVariants: () => [],
		getCanonicalId: () => undefined,
	};
}

function fakeSession(initial = model("provider-a", "initial")) {
	let activeModelProfile: string | undefined;
	return {
		model: initial as Model | undefined,
		thinkingLevel: ThinkingLevel.Low as ThinkingLevel | undefined,
		sessionId: "session-1",
		setModelTemporaryCalls: [] as Array<{ model: Model; thinkingLevel?: ThinkingLevel }>,
		configuredModelChains: new Map<string, readonly string[]>(),
		configuredModelChainStates: new Map<
			string,
			{ entries: readonly string[]; origin: string; identity?: string; explicitHead: boolean }
		>(),
		seedDefaultFallbackResolutionCalls: [] as Array<{
			activeIndex: number;
			skips: Array<{ selector: string; reason: string }>;
		}>,
		resumeDefaultSelectors: [] as Array<string | undefined>,
		getConfiguredModelChain(role: string) {
			return this.configuredModelChains.get(role);
		},
		getConfiguredModelChainState(role: string) {
			return this.configuredModelChainStates.get(role);
		},
		setConfiguredModelChain(
			role: string,
			entries: readonly string[],
			origin = "test",
			identity?: string,
			explicitHead = true,
		) {
			this.configuredModelChains.set(role, [...entries]);
			this.configuredModelChainStates.set(role, { entries: [...entries], origin, identity, explicitHead });
		},
		seedDefaultFallbackResolution(activeIndex: number, skips: Array<{ selector: string; reason: string }>) {
			this.seedDefaultFallbackResolutionCalls.push({ activeIndex, skips });
		},
		async setModelTemporary(next: Model, thinkingLevel?: ThinkingLevel) {
			this.setModelTemporaryCalls.push({ model: next, thinkingLevel });
			this.model = next;
			this.thinkingLevel = thinkingLevel;
		},
		async restoreModelSelectionForRollback(next: Model | undefined, thinkingLevel: ThinkingLevel | undefined) {
			this.model = next;
			this.thinkingLevel = thinkingLevel;
		},
		recordResumeDefaultModel(selector: string | undefined) {
			this.resumeDefaultSelectors.push(selector);
		},
		getSessionDefaultModelSelector() {
			return this.resumeDefaultSelectors.at(-1);
		},
		setActiveModelProfile(name: string | undefined) {
			activeModelProfile = name;
		},
		getActiveModelProfile() {
			return activeModelProfile;
		},
	};
}

describe("model profile activation", () => {
	test("prepared activation resolves default and agent selectors", async () => {
		const prepared = await prepareModelProfileActivation({
			session: fakeSession(),
			modelRegistry: fakeRegistry(),
			settings: Settings.isolated(),
			profileName: "profile-a",
		});

		expect(prepared.defaultModel?.provider).toBe("provider-a");
		expect(prepared.defaultModel?.id).toBe("default");
		expect(prepared.defaultThinkingLevel).toBe(ThinkingLevel.High);
		expect(prepared.modelRoles).toEqual({});
		expect(prepared.agentModelOverrides).toEqual({
			executor: "provider-b/executor",
			architect: "provider-a/architect",
		});
	});

	test("built-in claude-opus falls back to Opus 4.6 when Opus 5 is absent", async () => {
		const profile = BUILTIN_MODEL_PROFILES.find(candidate => candidate.name === "claude-opus");
		expect(profile).toBeDefined();
		const baseRegistry = fakeRegistry({ profiles: [profile!] });
		const available = baseRegistry.getAll().filter(candidate => candidate.id !== "claude-opus-5");
		const session = fakeSession();

		const prepared = await prepareModelProfileActivation({
			session,
			modelRegistry: {
				...baseRegistry,
				getAvailable: baseRegistry.getAll,
				getAvailableForProfileActivation: () => available,
			} as unknown as ModelRegistry,
			settings: Settings.isolated(),
			profileName: "claude-opus",
		});

		expect(prepared.defaultModel).toMatchObject({ provider: "anthropic", id: "claude-opus-4-6" });
		expect(prepared.defaultThinkingLevel).toBe(ThinkingLevel.XHigh);
		expect(prepared.defaultChain).toEqual(["anthropic/claude-opus-5:xhigh", "anthropic/claude-opus-4-6:xhigh"]);
		expect(prepared.agentModelOverrides).toEqual({
			executor: "anthropic/claude-sonnet-5",
			planner: ["anthropic/claude-opus-5:low", "anthropic/claude-opus-4-6:low"],
			critic: ["anthropic/claude-opus-5:high", "anthropic/claude-opus-4-6:high"],
			architect: ["anthropic/claude-opus-5:xhigh", "anthropic/claude-opus-4-6:xhigh"],
		});
	});

	test("built-in claude-opus retains Opus 5 when the catalog exposes it", async () => {
		const profile = BUILTIN_MODEL_PROFILES.find(candidate => candidate.name === "claude-opus");
		expect(profile).toBeDefined();

		const prepared = await prepareModelProfileActivation({
			session: fakeSession(),
			modelRegistry: fakeRegistry({ profiles: [profile!] }),
			settings: Settings.isolated(),
			profileName: "claude-opus",
		});

		expect(prepared.defaultModel).toMatchObject({ provider: "anthropic", id: "claude-opus-5" });
		expect(prepared.defaultThinkingLevel).toBe(ThinkingLevel.XHigh);
	});

	test("built-in claude-opus skips a bundled Opus 5 absent from fresh live catalog evidence", async () => {
		const tempDir = TempDir.createSync("@gjc-profile-live-catalog-");
		const authStorage = await AuthStorage.create(`${tempDir.path()}/auth.db`);
		try {
			authStorage.setRuntimeApiKey("anthropic", "test-anthropic-key");
			const requests: string[] = [];
			using _hook = hookFetch(input => {
				const url = String(input);
				requests.push(url);
				switch (url) {
					case "https://models.dev/api.json":
						return new Response(JSON.stringify({ anthropic: { models: {} } }), {
							headers: { "Content-Type": "application/json" },
						});
					default:
						if (!url.endsWith("/models")) {
							throw new Error(`Unexpected model discovery request: ${input}`);
						}
						return new Response(
							JSON.stringify({ data: [{ id: "claude-opus-4-6" }, { id: "claude-sonnet-5" }] }),
							{ headers: { "Content-Type": "application/json" } },
						);
				}
			});
			const registry = new ModelRegistry(authStorage, `${tempDir.path()}/models.yml`);
			await registry.refreshProvider("anthropic", "online");

			expect(requests.some(url => url.endsWith("/models"))).toBe(true);
			expect(registry.getAvailable().some(candidate => candidate.id === "claude-opus-5")).toBe(true);
			expect(
				registry
					.getAvailableForProfileActivation()
					.filter(candidate => candidate.provider === "anthropic")
					.map(candidate => candidate.id),
			).not.toContain("claude-opus-5");
			const expectedIds = new Set(["claude-opus-4-6", "claude-sonnet-5"]);
			expect(
				registry.getAvailableForProfileActivation().filter(candidate => candidate.provider === "anthropic"),
			).toEqual(
				registry
					.getAvailable()
					.filter(candidate => candidate.provider === "anthropic" && expectedIds.has(candidate.id)),
			);
			const session = fakeSession();
			session.model = undefined;
			session.thinkingLevel = undefined;
			session.sessionId = "parent-session";
			const prepared = await prepareModelProfileActivation({
				session: session as unknown as AgentSession,
				modelRegistry: registry,
				settings: Settings.isolated(),
				profileName: "claude-opus",
			});

			expect(prepared.defaultModel).toMatchObject({ provider: "anthropic", id: "claude-opus-4-6" });
			expect(prepared.defaultResolutionSkips).toEqual([
				{ selector: "anthropic/claude-opus-5:xhigh", reason: "unknown_model" },
			]);
			expect(prepared.agentModelOverrides).toMatchObject({
				executor: "anthropic/claude-sonnet-5",
				planner: ["anthropic/claude-opus-5:low", "anthropic/claude-opus-4-6:low"],
				critic: ["anthropic/claude-opus-5:high", "anthropic/claude-opus-4-6:high"],
				architect: ["anthropic/claude-opus-5:xhigh", "anthropic/claude-opus-4-6:high"],
			});
		} finally {
			authStorage.close();
			tempDir.removeSync();
		}
	});

	test("notifies mounted consumers when fresh discovery evidence changes from non-empty to empty", async () => {
		const tempDir = TempDir.createSync("@gjc-profile-live-catalog-notify-");
		const authStorage = await AuthStorage.create(`${tempDir.path()}/auth.db`);
		try {
			authStorage.setRuntimeApiKey("anthropic", "test-anthropic-key");
			let discoveryCount = 0;
			using _hook = hookFetch(input => {
				const url = String(input);
				if (url === "https://models.dev/api.json") {
					return new Response(JSON.stringify({ anthropic: { models: {} } }), {
						headers: { "Content-Type": "application/json" },
					});
				}
				if (!url.endsWith("/models")) throw new Error(`Unexpected model discovery request: ${input}`);
				discoveryCount += 1;
				return new Response(JSON.stringify({ data: discoveryCount === 1 ? [{ id: "claude-opus-5" }] : [] }), {
					headers: { "Content-Type": "application/json" },
				});
			});
			const registry = new ModelRegistry(authStorage, `${tempDir.path()}/models.yml`);
			let catalogNotifications = 0;
			registry.onCatalogChanged(() => {
				catalogNotifications += 1;
			});

			await registry.refreshProvider("anthropic", "online");
			expect(
				registry
					.getAvailableForProfileActivation()
					.some(candidate => candidate.provider === "anthropic" && candidate.id === "claude-opus-5"),
			).toBe(true);
			const notificationsAfterNonEmpty = catalogNotifications;

			await registry.refreshProvider("anthropic", "online");
			expect(catalogNotifications).toBeGreaterThan(notificationsAfterNonEmpty);
			expect(
				registry
					.getAvailableForProfileActivation()
					.some(candidate => candidate.provider === "anthropic" && candidate.id === "claude-opus-5"),
			).toBe(false);
		} finally {
			authStorage.close();
			tempDir.removeSync();
		}
	});

	test("built-in claude-opus retains bundled Opus 5 after live catalog discovery fails", async () => {
		const tempDir = TempDir.createSync("@gjc-profile-stale-catalog-");
		const authStorage = await AuthStorage.create(`${tempDir.path()}/auth.db`);
		try {
			authStorage.setRuntimeApiKey("anthropic", "test-anthropic-key");
			using _hook = hookFetch(input => {
				const url = String(input);
				switch (url) {
					case "https://models.dev/api.json":
						return new Response(JSON.stringify({ anthropic: { models: {} } }), {
							headers: { "Content-Type": "application/json" },
						});
					default:
						if (!url.endsWith("/models")) {
							throw new Error(`Unexpected model discovery request: ${input}`);
						}
						return new Response("unavailable", { status: 503 });
				}
			});
			const registry = new ModelRegistry(authStorage, `${tempDir.path()}/models.yml`);
			await registry.refreshProvider("anthropic", "online");
			const prepared = await prepareModelProfileActivation({
				session: fakeSession() as unknown as AgentSession,
				modelRegistry: registry,
				settings: Settings.isolated(),
				profileName: "claude-opus",
			});

			expect(prepared.defaultModel).toMatchObject({ provider: "anthropic", id: "claude-opus-5" });
			expect(prepared.defaultResolutionSkips).toEqual([]);
		} finally {
			authStorage.close();
			tempDir.removeSync();
		}
	});

	test("fresh catalog omission does not exclude a same-id custom Anthropic replacement", async () => {
		const tempDir = TempDir.createSync("@gjc-profile-custom-overlay-");
		const modelsPath = `${tempDir.path()}/models.yml`;
		const authStorage = await AuthStorage.create(`${tempDir.path()}/auth.db`);
		try {
			await Bun.write(
				modelsPath,
				JSON.stringify({
					providers: {
						anthropic: {
							baseUrl: "https://custom-anthropic.example.test/v1",
							api: "anthropic-messages",
							apiKey: "TEST_ANTHROPIC_KEY",
							models: [{ id: "claude-opus-5" }],
						},
					},
				}),
			);
			using _hook = hookFetch(input => {
				const url = String(input);
				if (url === "https://models.dev/api.json") {
					return new Response(JSON.stringify({ anthropic: { models: {} } }), {
						headers: { "Content-Type": "application/json" },
					});
				}
				if (url === "https://custom-anthropic.example.test/models") {
					return new Response(JSON.stringify({ data: [{ id: "claude-opus-4-6" }] }), {
						headers: { "Content-Type": "application/json" },
					});
				}
				throw new Error(`Unexpected model discovery request: ${input}`);
			});
			const registry = new ModelRegistry(authStorage, modelsPath);
			await registry.refreshProvider("anthropic", "online");

			expect(registry.find("anthropic", "claude-opus-5")?.baseUrl).toBe("https://custom-anthropic.example.test/v1");
			expect(
				registry
					.getAvailableForProfileActivation()
					.some(candidate => candidate.provider === "anthropic" && candidate.id === "claude-opus-5"),
			).toBe(true);

			registry.registerProvider("anthropic", {
				baseUrl: "https://runtime-anthropic.example.test/v1",
				api: "anthropic-messages",
				apiKey: "TEST_RUNTIME_ANTHROPIC_KEY",
				models: [
					{
						id: "claude-opus-5",
						name: "Runtime Opus 5",
						reasoning: true,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 200_000,
						maxTokens: 8_000,
					},
				],
			});
			expect(registry.find("anthropic", "claude-opus-5")?.baseUrl).toBe("https://runtime-anthropic.example.test/v1");
			expect(
				registry
					.getAvailableForProfileActivation()
					.some(candidate => candidate.provider === "anthropic" && candidate.id === "claude-opus-5"),
			).toBe(true);
		} finally {
			authStorage.close();
			tempDir.removeSync();
		}
	});

	test("rejects a mixed provider-agnostic profile before mutation when a role alias is unavailable", async () => {
		const profile: ModelProfileDefinition = {
			name: "open-weights-glm-deepseek",
			requiredProviders: [],
			modelMapping: {
				default: "glm-5.2:medium",
				executor: "deepseek-v4-flash:high",
				critic: "deepseek-v4-flash:high",
			},
			source: "builtin",
		};
		const glm = model("custom-router", "zai/glm-5.2");
		const baseRegistry = fakeRegistry({ profiles: [profile] });
		const registry = {
			...baseRegistry,
			getAll: () => [glm],
			getAvailable: () => [glm],
			lookupAliasExists: (alias: string) => alias === "glm-5.2" || alias === "deepseek-v4-flash",
			resolveModelByLookupAlias: (alias: string, options?: { candidates?: readonly Model[] }) =>
				options?.candidates?.find(
					candidate => candidate.id.split("/").at(-1)?.toLowerCase() === alias.toLowerCase(),
				),
		};
		const session = fakeSession();
		const settings = Settings.isolated({ "task.agentModelOverrides": { executor: "provider-a/original" } });

		await expect(
			prepareModelProfileActivation({
				session,
				modelRegistry: registry as unknown as ModelRegistry,
				settings,
				profileName: profile.name,
			}),
		).rejects.toMatchObject({
			constructor: ModelProfileCredentialError,
			code: "authentication_failed",
			profileLabel: profile.name,
			providers: ["deepseek-v4-flash"],
			role: "executor",
		});
		expect(session.model?.id).toBe("initial");
		expect(settings.get("task.agentModelOverrides")).toEqual({ executor: "provider-a/original" });
		expect(session.getActiveModelProfile()).toBeUndefined();
	});

	test("accepts a matching single-family provider-agnostic profile", async () => {
		const profile: ModelProfileDefinition = {
			name: "open-weights-glm",
			requiredProviders: [],
			modelMapping: { default: "glm-5.2:medium", executor: "glm-5.2:low" },
			source: "builtin",
		};
		const glm = model("custom-router", "zai/glm-5.2");
		const baseRegistry = fakeRegistry({ profiles: [profile] });
		const registry = {
			...baseRegistry,
			getAll: () => [glm],
			getAvailable: () => [glm],
			lookupAliasExists: (alias: string) => alias === "glm-5.2",
			resolveModelByLookupAlias: (_alias: string, options?: { candidates?: readonly Model[] }) =>
				options?.candidates?.[0],
		};

		const prepared = await prepareModelProfileActivation({
			session: fakeSession(),
			modelRegistry: registry as unknown as ModelRegistry,
			settings: Settings.isolated(),
			profileName: profile.name,
		});

		expect(prepared.defaultModel).toBe(glm);
		expect(prepared.agentModelOverrides.executor).toBe("glm-5.2:low");
	});

	test("clamps bare alias thinking suffixes to the resolved model", async () => {
		const profile: ModelProfileDefinition = {
			name: "clamped-open-weight",
			requiredProviders: [],
			modelMapping: { default: "glm-5.2:max", executor: "glm-5.2:max" },
			source: "user",
		};
		const glm = model("custom-router", "zai/glm-5.2", {
			mode: "effort",
			minLevel: ThinkingLevel.Low,
			maxLevel: ThinkingLevel.XHigh,
		});
		const baseRegistry = fakeRegistry({ profiles: [profile] });
		const registry = {
			...baseRegistry,
			getAll: () => [glm],
			getAvailable: () => [glm],
			lookupAliasExists: (alias: string) => alias === "glm-5.2",
			resolveModelByLookupAlias: (_alias: string, options?: { candidates?: readonly Model[] }) =>
				options?.candidates?.[0],
		};

		const prepared = await prepareModelProfileActivation({
			session: fakeSession(),
			modelRegistry: registry as unknown as ModelRegistry,
			settings: Settings.isolated(),
			profileName: profile.name,
		});

		expect(prepared.defaultChain).toEqual(["glm-5.2:xhigh"]);
		expect(prepared.agentModelOverrides.executor).toBe("glm-5.2:xhigh");
	});

	test("retries another provider variant when the preferred bare alias fails authentication", async () => {
		const profile: ModelProfileDefinition = {
			name: "open-weights-glm",
			requiredProviders: [],
			modelMapping: { default: "glm-5.2:medium", executor: "glm-5.2:low" },
			source: "builtin",
		};
		const alpha = model("alpha", "zai/glm-5.2");
		const beta = model("beta", "zai/glm-5.2");
		const baseRegistry = fakeRegistry({ profiles: [profile] });
		const registry = {
			...baseRegistry,
			getAll: () => [alpha, beta],
			getAvailable: () => [alpha, beta],
			getApiKeyForProvider: async (provider: string) => (provider === "beta" ? "key-beta" : undefined),
			lookupAliasExists: (alias: string) => alias === "glm-5.2",
			resolveModelByLookupAlias: (_alias: string, options?: { candidates?: readonly Model[] }) =>
				options?.candidates?.[0],
		};

		const prepared = await prepareModelProfileActivation({
			session: fakeSession(),
			modelRegistry: registry as unknown as ModelRegistry,
			settings: Settings.isolated(),
			profileName: profile.name,
		});

		expect(prepared.defaultModel).toBe(beta);
		expect(prepared.agentModelOverrides.executor).toBe("glm-5.2:low");
	});

	test("resolves Muse Spark through an authenticated provider and preserves xhigh effort", async () => {
		const profile = BUILTIN_MODEL_PROFILES.find(candidate => candidate.name === "open-weights-spark");
		if (!profile) throw new Error("Missing open-weights-spark profile");
		const kilo = model("kilo", "meta/muse-spark-1.2", {
			mode: "effort",
			minLevel: ThinkingLevel.Minimal,
			maxLevel: ThinkingLevel.XHigh,
		});
		const openrouter = model("openrouter", "meta/muse-spark-1.2", {
			mode: "effort",
			minLevel: ThinkingLevel.Minimal,
			maxLevel: ThinkingLevel.XHigh,
		});
		const baseRegistry = fakeRegistry({ profiles: [profile] });
		const registry = {
			...baseRegistry,
			getAll: () => [kilo, openrouter],
			getAvailable: () => [kilo, openrouter],
			getApiKeyForProvider: async (provider: string) => (provider === "openrouter" ? "key-openrouter" : undefined),
			lookupAliasExists: (alias: string) => alias === "muse-spark-1.2",
			resolveModelByLookupAlias: (_alias: string, options?: { candidates?: readonly Model[] }) =>
				options?.candidates?.[0],
		};

		const prepared = await prepareModelProfileActivation({
			session: fakeSession(),
			modelRegistry: registry as unknown as ModelRegistry,
			settings: Settings.isolated(),
			profileName: profile.name,
		});

		expect(prepared.defaultModel).toBe(openrouter);
		expect(prepared.defaultThinkingLevel).toBe(ThinkingLevel.Medium);
		expect(prepared.agentModelOverrides).toEqual({
			executor: "muse-spark-1.2:low",
			planner: "muse-spark-1.2:high",
			critic: "muse-spark-1.2:high",
			architect: "muse-spark-1.2:xhigh",
		});
	});

	test("fails Muse Spark preset activation before mutation when no provider exposes the alias", async () => {
		const profile = BUILTIN_MODEL_PROFILES.find(candidate => candidate.name === "open-weights-spark");
		if (!profile) throw new Error("Missing open-weights-spark profile");
		const registry = {
			...fakeRegistry({ profiles: [profile] }),
			getAll: () => [],
			getAvailable: () => [],
			lookupAliasExists: (alias: string) => alias === "muse-spark-1.2",
			resolveModelByLookupAlias: () => undefined,
		};
		const session = fakeSession();

		await expect(
			prepareModelProfileActivation({
				session,
				modelRegistry: registry as unknown as ModelRegistry,
				settings: Settings.isolated(),
				profileName: profile.name,
			}),
		).rejects.toMatchObject({
			constructor: ModelProfileCredentialError,
			code: "authentication_failed",
			providers: ["muse-spark-1.2"],
		});
		expect(session.model?.id).toBe("initial");
		expect(session.getActiveModelProfile()).toBeUndefined();
	});

	test("keeps unauthenticated fallback heads and authenticated mixed-provider tails", async () => {
		const profile: ModelProfileDefinition = {
			name: "fallback-profile",
			requiredProviders: [],
			modelMapping: {
				default: ["provider-a/default:high", "provider-b/executor"],
				executor: ["provider-c/executor", "provider-b/executor"],
			},
			source: "user",
		};
		const session = fakeSession();
		const prepared = await prepareModelProfileActivation({
			session,
			modelRegistry: fakeRegistry({ missingProviders: ["provider-a", "provider-c"], profiles: [profile] }),
			settings: Settings.isolated(),
			profileName: profile.name,
		});

		expect(prepared.defaultChain).toEqual(["provider-a/default:high", "provider-b/executor"]);
		expect(prepared.agentModelOverrides.executor).toEqual(["provider-c/executor", "provider-b/executor"]);
		await applyPreparedModelProfileActivation(prepared);
		expect(session.getConfiguredModelChain("default")).toEqual(["provider-a/default:high", "provider-b/executor"]);
	});

	test("preserves unavailable default-chain entries and activates the valid tail", async () => {
		const profile: ModelProfileDefinition = {
			name: "unavailable-head",
			requiredProviders: [],
			modelMapping: { default: ["provider-a/missing", "provider-b/executor"] },
			source: "user",
		};
		const session = fakeSession();
		await activateModelProfile({
			session,
			modelRegistry: fakeRegistry({ profiles: [profile] }),
			settings: Settings.isolated(),
			profileName: profile.name,
		});

		expect(session.model).toMatchObject({ provider: "provider-b", id: "executor" });
		expect(session.getConfiguredModelChain("default")).toEqual(["provider-a/missing", "provider-b/executor"]);
		expect(session.seedDefaultFallbackResolutionCalls).toEqual([
			{ activeIndex: 1, skips: [{ selector: "provider-a/missing", reason: "unknown_model" }] },
		]);
	});

	test("preserves an unavailable bare alias and activates a valid fallback tail", async () => {
		const profile: ModelProfileDefinition = {
			name: "unavailable-bare-head",
			requiredProviders: [],
			modelMapping: { default: ["missing-alias", "provider-b/executor"] },
			source: "user",
		};
		const session = fakeSession();
		await activateModelProfile({
			session,
			modelRegistry: fakeRegistry({ profiles: [profile] }),
			settings: Settings.isolated(),
			profileName: profile.name,
		});

		expect(session.model).toMatchObject({ provider: "provider-b", id: "executor" });
		expect(session.getConfiguredModelChain("default")).toEqual(["missing-alias", "provider-b/executor"]);
		expect(session.seedDefaultFallbackResolutionCalls).toEqual([
			{ activeIndex: 1, skips: [{ selector: "missing-alias", reason: "unknown_model" }] },
		]);
	});
	test("reports an unavailable single bare alias as a recoverable credential error", async () => {
		const profile: ModelProfileDefinition = {
			name: "unavailable-bare-only",
			requiredProviders: [],
			modelMapping: { default: "default" },
			source: "user",
		};

		await expect(
			prepareModelProfileActivation({
				session: fakeSession(),
				modelRegistry: fakeRegistry({ missingProviders: ["provider-a", "provider-c"], profiles: [profile] }),
				settings: Settings.isolated(),
				profileName: profile.name,
			}),
		).rejects.toMatchObject({
			constructor: ModelProfileCredentialError,
			code: "authentication_failed",
			profileLabel: profile.name,
			providers: ["provider-a", "provider-c"],
			role: "default",
		});
	});

	test("reports an exhausted known bare alias array as a recoverable credential error", async () => {
		const profile: ModelProfileDefinition = {
			name: "unavailable-bare-fallbacks",
			requiredProviders: [],
			modelMapping: { default: ["default", "executor"] },
			source: "user",
		};

		await expect(
			prepareModelProfileActivation({
				session: fakeSession(),
				modelRegistry: fakeRegistry({
					missingProviders: ["provider-a", "provider-b", "provider-c"],
					profiles: [profile],
				}),
				settings: Settings.isolated(),
				profileName: profile.name,
			}),
		).rejects.toMatchObject({
			constructor: ModelProfileCredentialError,
			code: "authentication_failed",
			profileLabel: profile.name,
			providers: ["provider-a", "provider-b", "provider-c"],
			role: "default",
		});
	});

	test("reports an unknown bare alias as a profile configuration error", async () => {
		const profile: ModelProfileDefinition = {
			name: "unknown-bare-only",
			requiredProviders: [],
			modelMapping: { default: "typo-model" },
			source: "user",
		};
		const registry = {
			...fakeRegistry({ profiles: [profile] }),
			getAll: () => [],
			getAvailable: () => [],
			lookupAliasExists: () => false,
			resolveModelByLookupAlias: () => undefined,
		};
		let error: unknown;
		try {
			await prepareModelProfileActivation({
				session: fakeSession(),
				modelRegistry: registry as unknown as ModelRegistry,
				settings: Settings.isolated(),
				profileName: profile.name,
			});
		} catch (caught) {
			error = caught;
		}

		expect(error).toBeInstanceOf(Error);
		expect(error).not.toBeInstanceOf(ModelProfileCredentialError);
		expect((error as Error).message).toBe(
			'Model profile "unknown-bare-only" default selector "typo-model" does not match any catalog model',
		);
	});

	test("rejects a fully unresolved qualified executor chain", async () => {
		const executorChain = ["provider-a/unknown-executor", "provider-b/unknown-executor"];
		const profile: ModelProfileDefinition = {
			name: "unresolved-executor",
			requiredProviders: [],
			modelMapping: { default: "provider-a/default", executor: executorChain },
			source: "user",
		};
		const settings = Settings.isolated();

		await expect(
			activateModelProfile({
				session: fakeSession(),
				modelRegistry: fakeRegistry({ profiles: [profile] }),
				settings,
				profileName: profile.name,
			}),
		).rejects.toThrow(/executor selectors do not match any catalog model/);
		expect(settings.get("task.agentModelOverrides")).toEqual({});
	});

	test("persists profile ownership when a partial profile has no default mapping", async () => {
		const profile: ModelProfileDefinition = {
			name: "executor-only-profile",
			requiredProviders: [],
			modelMapping: { executor: "provider-b/executor" },
			source: "user",
		};
		const session = fakeSession();
		await activateModelProfile({
			session,
			modelRegistry: fakeRegistry({ profiles: [profile] }),
			settings: Settings.isolated(),
			profileName: profile.name,
		});

		expect(session.getConfiguredModelChainState("default")).toEqual({
			entries: ["provider-a/initial"],
			origin: "profile-activation",
			identity: profile.name,
			explicitHead: true,
		});
		expect(session.getActiveModelProfile()).toBe(profile.name);
	});

	test("preserves unavailable middle and tail entries while resolving the first usable default", async () => {
		const profile: ModelProfileDefinition = {
			name: "unavailable-middle-tail",
			requiredProviders: [],
			modelMapping: { default: ["provider-a/default", "provider-a/missing", "provider-b/missing"] },
			source: "user",
		};
		const session = fakeSession();
		await activateModelProfile({
			session,
			modelRegistry: fakeRegistry({ profiles: [profile] }),
			settings: Settings.isolated(),
			profileName: profile.name,
		});

		expect(session.model).toMatchObject({ provider: "provider-a", id: "default" });
		expect(session.getConfiguredModelChain("default")).toEqual([
			"provider-a/default",
			"provider-a/missing",
			"provider-b/missing",
		]);
		expect(session.seedDefaultFallbackResolutionCalls).toEqual([{ activeIndex: 0, skips: [] }]);
	});

	test("skips authenticated Cursor default heads before seeding a retryable fallback chain", async () => {
		const cursor = { ...model("cursor", "agent"), api: "cursor-agent" } as Model;
		const fallback = model("provider-b", "executor");
		const profile: ModelProfileDefinition = {
			name: "cursor-default-head",
			requiredProviders: [],
			modelMapping: { default: ["cursor/agent", "provider-b/executor"] },
			source: "user",
		};
		const session = fakeSession();
		const registry = { ...fakeRegistry({ profiles: [profile] }), getAll: () => [cursor, fallback] };
		await activateModelProfile({
			session,
			modelRegistry: registry,
			settings: Settings.isolated(),
			profileName: profile.name,
		});

		expect(session.model).toMatchObject({ provider: "provider-b", id: "executor" });
		expect(session.getConfiguredModelChain("default")).toEqual(["cursor/agent", "provider-b/executor"]);
		expect(session.seedDefaultFallbackResolutionCalls).toEqual([
			{
				activeIndex: 1,
				skips: [
					{
						selector: "cursor/agent",
						reason:
							"Cursor model cursor/agent requires provider-side tool execution and cannot be used in a retryable fallback chain",
					},
				],
			},
		]);
	});

	test("skips unauthenticated default-chain entries and seeds the authenticated tail", async () => {
		const profile: ModelProfileDefinition = {
			name: "unauthenticated-head",
			requiredProviders: [],
			modelMapping: { default: ["provider-a/default:high", "provider-b/executor"] },
			source: "user",
		};
		const session = fakeSession();
		await activateModelProfile({
			session,
			modelRegistry: fakeRegistry({ missingProviders: ["provider-a"], profiles: [profile] }),
			settings: Settings.isolated(),
			profileName: profile.name,
		});

		expect(session.model).toMatchObject({ provider: "provider-b", id: "executor" });
		expect(session.getConfiguredModelChain("default")).toEqual(["provider-a/default:high", "provider-b/executor"]);
		expect(session.seedDefaultFallbackResolutionCalls).toEqual([
			{ activeIndex: 1, skips: [{ selector: "provider-a/default:high", reason: "unauthenticated" }] },
		]);
	});

	test("hard required providers still gate activation", async () => {
		const profile: ModelProfileDefinition = {
			name: "hard-required",
			requiredProviders: ["provider-a"],
			modelMapping: { default: ["provider-b/executor", "provider-c/executor"] },
			source: "user",
		};
		await expect(
			prepareModelProfileActivation({
				session: fakeSession(),
				modelRegistry: fakeRegistry({ missingProviders: ["provider-a"], profiles: [profile] }),
				settings: Settings.isolated(),
				profileName: profile.name,
			}),
		).rejects.toThrow('Model profile "hard-required" requires credentials for: provider-a.');
	});

	test("accepts the kNoAuth sentinel for required keyless providers", async () => {
		const profile: ModelProfileDefinition = {
			name: "keyless-required",
			requiredProviders: ["provider-a"],
			modelMapping: { default: "provider-a/default" },
			source: "user",
		};
		const registry = {
			...fakeRegistry({ profiles: [profile] }),
			getApiKeyForProvider: async () => kNoAuth,
		};

		await expect(
			prepareModelProfileActivation({
				session: fakeSession(),
				modelRegistry: registry as unknown as ModelRegistry,
				settings: Settings.isolated(),
				profileName: profile.name,
			}),
		).resolves.toMatchObject({ profileName: profile.name });
	});

	test("installs the default chain and restores the previous chain on rollback", async () => {
		const session = fakeSession();
		session.setConfiguredModelChain("default", ["provider-c/default"]);
		const settings = Settings.isolated();
		const prepared = await prepareModelProfileActivation({
			session,
			modelRegistry: fakeRegistry(),
			settings,
			profileName: "profile-a",
		});
		vi.spyOn(settings, "flushOrThrow").mockRejectedValueOnce(new Error("flush failed"));

		await expect(applyPreparedModelProfileActivation(prepared, { persistDefault: true })).rejects.toThrow(
			"flush failed",
		);
		expect(session.getConfiguredModelChain("default")).toEqual(["provider-c/default"]);
	});

	test("rollback restores a model-less session without creating resume lineage", async () => {
		const session = fakeSession();
		session.model = undefined;
		const settings = Settings.isolated();
		const prepared = await prepareModelProfileActivation({
			session,
			modelRegistry: fakeRegistry(),
			settings,
			profileName: "profile-a",
		});
		vi.spyOn(settings, "flushOrThrow").mockRejectedValueOnce(new Error("flush failed"));

		await expect(applyPreparedModelProfileActivation(prepared, { persistDefault: true })).rejects.toThrow(
			"flush failed",
		);
		expect(session.model).toBeUndefined();
		expect(session.resumeDefaultSelectors).toEqual([]);
	});

	test("rolls back partial synchronous persistent writes before durable flush", async () => {
		const session = fakeSession();
		const settings = Settings.isolated();
		settings.set("modelRoles", { default: "provider-c/default" });
		settings.set("task.agentModelOverrides", { executor: "provider-c/executor" });
		settings.set("modelProfile.default", "old-profile");
		const prepared = await prepareModelProfileActivation({
			session,
			modelRegistry: fakeRegistry(),
			settings,
			profileName: "profile-a",
		});
		const originalSet = settings.set.bind(settings);
		let rejected = false;
		settings.set = ((path: never, value: never) => {
			if (path === "task.agentModelOverrides" && !rejected) {
				rejected = true;
				throw new Error("set failed");
			}
			return originalSet(path, value);
		}) as typeof settings.set;

		await expect(applyPreparedModelProfileActivation(prepared, { persistDefault: true })).rejects.toThrow(
			"set failed",
		);
		expect(settings.getGlobal("modelRoles")).toEqual({ default: "provider-c/default" });
		expect(settings.getGlobal("task.agentModelOverrides")).toEqual({ executor: "provider-c/executor" });
		expect(settings.getGlobal("modelProfile.default")).toBe("old-profile");
		expect(session.model?.id).toBe("initial");
		expect(session.resumeDefaultSelectors).toEqual([]);
	});

	test("rollback from an unconfigured session restores its concrete chain without inventing a resume default", async () => {
		const tempDir = TempDir.createSync("@gjc-profile-chain-rollback-");
		try {
			const previousModel = model("provider-c", "default");
			const manager = SessionManager.create(tempDir.path(), tempDir.path());
			const sessionRegistry = { ...fakeRegistry(), getApiKey: async () => kNoAuth };
			const session = new AgentSession({
				agent: new Agent({ initialState: { model: previousModel, systemPrompt: [], tools: [], messages: [] } }),
				sessionManager: manager,
				settings: Settings.isolated({ "compaction.enabled": false }),
				modelRegistry: sessionRegistry as unknown as ModelRegistry,
			});
			const settings = Settings.isolated();
			const prepared = await prepareModelProfileActivation({
				session,
				modelRegistry: sessionRegistry as unknown as ModelRegistry,
				settings,
				profileName: "profile-a",
			});
			vi.spyOn(settings, "flushOrThrow").mockRejectedValueOnce(new Error("flush failed"));

			await expect(applyPreparedModelProfileActivation(prepared, { persistDefault: true })).rejects.toThrow(
				"flush failed",
			);
			expect(manager.buildSessionContext().configuredModelChains.default?.entries).toEqual(["provider-c/default"]);

			await manager.ensureOnDisk();
			await manager.flush();
			const sessionFile = manager.getSessionFile();
			if (!sessionFile) throw new Error("Expected persisted session file");
			await manager.close();

			const reopened = await SessionManager.open(sessionFile);
			try {
				expect(reopened.buildSessionContext().models.default).toBeUndefined();
				expect(reopened.buildSessionContext().configuredModelChains.default?.entries).toEqual([
					"provider-c/default",
				]);
			} finally {
				await reopened.close();
			}
		} finally {
			tempDir.removeSync();
		}
	});

	test("restores a persisted AgentSession configured chain and activates its head on resume", async () => {
		const tempDir = TempDir.createSync("@gjc-profile-chain-resume-");
		try {
			const head = model("provider-a", "default");
			const fallback = model("provider-b", "executor");
			const manager = SessionManager.create(tempDir.path(), tempDir.path());
			const configuringSession = new AgentSession({
				agent: new Agent({ initialState: { model: fallback, systemPrompt: [], tools: [], messages: [] } }),
				sessionManager: manager,
				settings: Settings.isolated({ "compaction.enabled": false }),
				modelRegistry: {
					getAvailable: () => [head, fallback],
					getApiKey: async () => kNoAuth,
				} as unknown as ModelRegistry,
			});
			configuringSession.setConfiguredModelChain(
				"default",
				["provider-a/default", "provider-b/executor"],
				"profile-activation",
			);
			manager.appendModelChange("provider-b/executor", "default");
			await manager.ensureOnDisk();
			await manager.flush();
			const sessionFile = manager.getSessionFile();
			if (!sessionFile) throw new Error("Expected persisted session file");
			await manager.close();

			const reopened = await SessionManager.open(sessionFile);
			const session = new AgentSession({
				agent: new Agent({ initialState: { model: fallback, systemPrompt: [], tools: [], messages: [] } }),
				sessionManager: reopened,
				settings: Settings.isolated({ "compaction.enabled": false }),
				modelRegistry: {
					getAvailable: () => [head, fallback],
					getApiKey: async () => kNoAuth,
				} as unknown as ModelRegistry,
			});
			try {
				expect(await session.switchSession(sessionFile)).toBe(true);
				expect(session.getConfiguredModelChain("default")).toEqual(["provider-a/default", "provider-b/executor"]);
				expect(session.model).toMatchObject({ provider: "provider-a", id: "default" });
			} finally {
				await session.dispose();
			}
		} finally {
			tempDir.removeSync();
		}
	});

	test("alternative selector rewrite stays within matching provider group", async () => {
		const prepared = await prepareModelProfileActivation({
			session: fakeSession(),
			modelRegistry: fakeRegistry({
				missingProviders: ["provider-a"],
				profiles: [
					{
						name: "mixed-profile",
						requiredProviders: ["provider-a", "provider-b", "provider-c"],
						alternativeProviderGroups: [["provider-a", "provider-c"]],
						modelMapping: {
							default: "provider-a/default:high",
							executor: "provider-a/executor",
							architect: "provider-b/executor",
						},
						source: "user",
					},
				],
			}),
			settings: Settings.isolated(),
			profileName: "mixed-profile",
		});

		expect(prepared.defaultModel?.provider).toBe("provider-c");
		expect(prepared.agentModelOverrides).toEqual({
			executor: "provider-c/executor",
			architect: "provider-b/executor",
		});
	});
	test.each([
		[
			"codex-eco",
			{
				default: "openai-codex/gpt-5.6-terra:low",
				executor: "openai-codex/gpt-5.6-luna:low",
				planner: "openai-codex/gpt-5.6-luna:high",
				critic: "openai-codex/gpt-5.6-terra:xhigh",
				architect: "openai-codex/gpt-5.6-terra:high",
			},
		],
		[
			"codex-medium",
			{
				default: "openai-codex/gpt-5.6-sol:low",
				executor: "openai-codex/gpt-5.6-terra:low",
				planner: "openai-codex/gpt-5.6-terra:high",
				critic: "openai-codex/gpt-5.6-sol:xhigh",
				architect: "openai-codex/gpt-5.6-sol:high",
			},
		],
		[
			"codex-pro",
			{
				default: "openai-codex/gpt-5.6-sol:medium",
				executor: "openai-codex/gpt-5.6-terra:medium",
				planner: "openai-codex/gpt-5.6-sol:high",
				critic: "openai-codex/gpt-5.6-sol:max",
				architect: "openai-codex/gpt-5.6-sol:xhigh",
			},
		],
		[
			"opus-codex",
			{
				default: "anthropic/claude-opus-5:xhigh",
				executor: "openai-codex/gpt-5.6-terra:low",
				planner: "anthropic/claude-sonnet-5",
				critic: "openai-codex/gpt-5.6-sol:xhigh",
				architect: "openai-codex/gpt-5.6-sol:high",
			},
		],
		[
			"lunamaxxing",
			{
				default: "openai-codex/gpt-5.6-luna:medium",
				executor: "openai-codex/gpt-5.6-luna:xhigh",
				planner: "openai-codex/gpt-5.6-luna:max",
				critic: "openai-codex/gpt-5.6-luna:max",
				architect: "openai-codex/gpt-5.6-luna:max",
			},
		],
		[
			"codex-opencodego",
			{
				default: "openai-codex/gpt-5.6-sol:low",
				executor: "opencode-go/deepseek-v4-pro",
				planner: "opencode-go/kimi-k3",
				critic: "opencode-go/mimo-v2.5-pro",
				architect: "openai-codex/gpt-5.6-sol:high",
			},
		],
		[
			"fable-opus-codex",
			{
				default: "anthropic/claude-fable-5-1:high",
				executor: "openai-codex/gpt-5.6-terra:medium",
				planner: "anthropic/claude-opus-5:medium",
				critic: "anthropic/claude-opus-5:high",
				architect: "openai-codex/gpt-5.6-sol:xhigh",
			},
		],
		[
			"alibaba-token-plan-balanced",
			{
				default: "alibaba-token-plan/qwen3.8-max-preview:medium",
				executor: "alibaba-token-plan/deepseek-v4-pro:xhigh",
				planner: "alibaba-token-plan/glm-5.2:high",
				critic: "alibaba-token-plan/glm-5.2:high",
				architect: "alibaba-token-plan/qwen3.8-max-preview:xhigh",
			},
		],
		[
			"alibaba-token-plan-pro",
			{
				default: "alibaba-token-plan/qwen3.8-max-preview:medium",
				executor: "alibaba-token-plan/deepseek-v4-flash-0731:max",
				planner: "alibaba-token-plan/glm-5.2:high",
				critic: "alibaba-token-plan/glm-5.2:xhigh",
				architect: "alibaba-token-plan/qwen3.8-max-preview:xhigh",
			},
		],
		[
			"alibaba-token-plan-qwenmaxxing",
			{
				default: "alibaba-token-plan/qwen3.8-max-preview:medium",
				executor: "alibaba-token-plan/qwen3.8-max-preview:low",
				planner: "alibaba-token-plan/qwen3.8-max-preview:medium",
				critic: "alibaba-token-plan/qwen3.8-max-preview:xhigh",
				architect: "alibaba-token-plan/qwen3.8-max-preview:xhigh",
			},
		],
		[
			"alibaba-token-plan-qwen-deepseek",
			{
				default: "alibaba-token-plan/qwen3.8-max:high",
				executor: "alibaba-token-plan/deepseek-v4-flash-0731:high",
				planner: "alibaba-token-plan/deepseek-v4-flash-0731:max",
				critic: "alibaba-token-plan/qwen3.8-max:xhigh",
				architect: "alibaba-token-plan/qwen3.8-max:xhigh",
			},
		],
		[
			"alibaba-token-plan-glm-deepseek",
			{
				default: "alibaba-token-plan/glm-5.2:high",
				executor: "alibaba-token-plan/deepseek-v4-flash-0731:high",
				planner: "alibaba-token-plan/deepseek-v4-flash-0731:max",
				critic: "alibaba-token-plan/glm-5.2:xhigh",
				architect: "alibaba-token-plan/glm-5.2:xhigh",
			},
		],
	] satisfies Array<
		[string, Record<string, string>]
	>)("prepares the reconstructed five-role mapping for %s", async (profileName, expected) => {
		const prepared = await prepareModelProfileActivation({
			session: fakeSession(),
			modelRegistry: fakeRegistry({ profiles: [...BUILTIN_MODEL_PROFILES] }),
			settings: Settings.isolated(),
			profileName,
		});

		const defaultSelector = `${prepared.defaultModel?.provider}/${prepared.defaultModel?.id}:${prepared.defaultThinkingLevel}`;
		expect({ default: defaultSelector, ...prepared.agentModelOverrides }).toEqual(expected);
	});

	test("session-only changes active model and replaces runtime overrides without persisted sets", async () => {
		const session = fakeSession();
		const settings = Settings.isolated({ "task.agentModelOverrides": { critic: "provider-a/old" } });
		const setCalls: string[] = [];
		const originalSet = settings.set.bind(settings);
		settings.set = ((path: never, value: never) => {
			setCalls.push(path);
			return originalSet(path, value);
		}) as typeof settings.set;

		await activateModelProfile({ session, modelRegistry: fakeRegistry(), settings, profileName: "profile-a" });

		expect(session.setModelTemporaryCalls).toHaveLength(1);
		expect(session.model?.id).toBe("default");
		expect(settings.get("modelRoles")).toEqual({});
		expect(settings.get("task.agentModelOverrides")).toEqual({
			critic: "provider-a/old",
			executor: "provider-b/executor",
			architect: "provider-a/architect",
		});
		expect(setCalls).toEqual([]);
		expect(settings.get("modelProfile.default")).toBeUndefined();
		expect(session.getActiveModelProfile()).toBe("profile-a");
	});

	test("re-applies eager delegation after a successful activation but not after rollback", async () => {
		const session = Object.assign(fakeSession(), { syncEagerDelegation: vi.fn(async () => {}) });
		await activateModelProfile({
			session,
			modelRegistry: fakeRegistry(),
			settings: Settings.isolated(),
			profileName: "profile-a",
		});
		expect(session.syncEagerDelegation).toHaveBeenCalledTimes(1);

		const rollbackSession = Object.assign(fakeSession(), { syncEagerDelegation: vi.fn(async () => {}) });
		const settings = Settings.isolated();
		const prepared = await prepareModelProfileActivation({
			session: rollbackSession,
			modelRegistry: fakeRegistry(),
			settings,
			profileName: "profile-a",
		});
		vi.spyOn(settings, "flushOrThrow").mockRejectedValueOnce(new Error("flush failed"));

		await expect(applyPreparedModelProfileActivation(prepared, { persistDefault: true })).rejects.toThrow(
			"flush failed",
		);
		expect(rollbackSession.syncEagerDelegation).not.toHaveBeenCalled();
	});

	test("a failing delegation sync never fails an already-applied activation", async () => {
		const session = Object.assign(fakeSession(), {
			syncEagerDelegation: vi.fn(async () => {
				throw new Error("prompt refresh failed");
			}),
		});
		const settings = Settings.isolated();

		await activateModelProfile({ session, modelRegistry: fakeRegistry(), settings, profileName: "profile-a" });

		expect(session.getActiveModelProfile()).toBe("profile-a");
		expect(settings.get("task.agentModelOverrides")).toMatchObject({ executor: "provider-b/executor" });
	});

	test("materializing a profile role override persists the full effective assignment set and clears the profile", async () => {
		const session = fakeSession();
		const settings = Settings.isolated({
			"modelProfile.default": "codex-medium",
			"task.agentModelOverrides": { critic: "provider-a/old-critic" },
		});

		await activateModelProfile({ session, modelRegistry: fakeRegistry(), settings, profileName: "profile-a" });

		const materialized = materializeActiveModelProfileAssignment({
			session,
			settings,
			role: "executor",
			selector: "provider-c/executor:medium",
		});

		expect(materialized).toBe(true);
		expect(settings.get("modelRoles")).toEqual({
			default: "provider-a/default:high",
		});
		expect(settings.get("task.agentModelOverrides")).toEqual({
			critic: "provider-a/old-critic",
			executor: "provider-c/executor:medium",
			architect: "provider-a/architect",
		});
		expect(settings.get("modelProfile.default")).toBeUndefined();
		expect(session.getActiveModelProfile()).toBeUndefined();
	});

	test("materializing one profile assignment concretizes every remaining bare alias before clearing ownership", () => {
		const selected = model("provider-b", "shared-model");
		const registry = {
			getAvailable: () => [selected],
			lookupAliasExists: (alias: string) => alias === "shared-model",
			resolveModelByLookupAlias: (alias: string) => (alias === "shared-model" ? selected : undefined),
		} as unknown as ModelRegistry;
		const session = Object.assign(fakeSession(), { modelRegistry: registry });
		session.setActiveModelProfile("provider-agnostic-profile");
		const settings = Settings.isolated({ "modelProfile.default": "provider-agnostic-profile" });
		settings.override("modelRoles", { default: "shared-model" });
		settings.override("task.agentModelOverrides", {
			executor: "shared-model",
			architect: ["shared-model", "provider-c/architect"],
		});

		const materialized = materializeActiveModelProfileAssignment({
			session,
			settings,
			role: "executor",
			selector: "provider-c/executor",
		});

		expect(materialized).toBe(true);
		expect(settings.get("modelRoles")).toEqual({ default: "provider-b/shared-model" });
		expect(settings.get("task.agentModelOverrides")).toEqual({
			executor: "provider-c/executor",
			architect: ["provider-b/shared-model", "provider-c/architect"],
		});
		expect(session.getActiveModelProfile()).toBeUndefined();
	});

	test("materialization restores settings and ownership when chain persistence fails", async () => {
		const session = fakeSession();
		const settings = Settings.isolated({ "modelProfile.default": "profile-a" });
		await activateModelProfile({ session, modelRegistry: fakeRegistry(), settings, profileName: "profile-a" });
		const previousRoles = settings.get("modelRoles");
		const previousOverrides = settings.get("task.agentModelOverrides");
		const setConfiguredModelChain = session.setConfiguredModelChain.bind(session);
		let calls = 0;
		session.setConfiguredModelChain = (role: string, entries: readonly string[]) => {
			calls++;
			if (calls === 1) throw new Error("persist failed");
			setConfiguredModelChain(role, entries);
		};

		expect(() =>
			materializeActiveModelProfileAssignment({
				session,
				settings,
				role: "executor",
				selector: "provider-c/executor",
			}),
		).toThrow("persist failed");
		expect(settings.get("modelProfile.default")).toBe("profile-a");
		expect(settings.get("modelRoles")).toEqual(previousRoles);
		expect(settings.get("task.agentModelOverrides")).toEqual(previousOverrides);
		expect(session.getActiveModelProfile()).toBe("profile-a");
	});

	test("materialization restores canonical affinity when concretization mutates before persistence fails", () => {
		const selected = model("provider-b", "shared-model");
		const session = fakeSession();
		const sticky = new Map([[session.sessionId, "provider-a/shared-model"]]);
		const registry = {
			getAvailable: () => [selected],
			lookupAliasExists: (alias: string) => alias === "shared-model",
			resolveModelByLookupAlias: (_alias: string, options?: { sessionId?: string }) => {
				if (options?.sessionId) sticky.set(options.sessionId, "provider-b/shared-model");
				return selected;
			},
			getSessionCanonicalVariant: (id: string) => sticky.get(id),
			clearCanonicalVariant: (id: string) => sticky.delete(id),
			restoreSessionCanonicalVariant: (id: string, selector: string) => {
				sticky.set(id, selector);
				return true;
			},
		} as unknown as ModelRegistry;
		Object.assign(session, { modelRegistry: registry });
		session.setActiveModelProfile("profile-a");
		const setConfiguredModelChain = session.setConfiguredModelChain.bind(session);
		let chainWrites = 0;
		session.setConfiguredModelChain = (role: string, entries: readonly string[]) => {
			chainWrites++;
			if (chainWrites === 1) throw new Error("persist failed");
			setConfiguredModelChain(role, entries);
		};
		const settings = Settings.isolated({ "modelProfile.default": "profile-a" });
		settings.override("modelRoles", { default: "shared-model" });
		settings.override("task.agentModelOverrides", { executor: "shared-model" });

		expect(() =>
			materializeActiveModelProfileAssignment({
				session,
				settings,
				role: "executor",
				selector: "provider-c/executor",
			}),
		).toThrow("persist failed");
		expect(sticky.get(session.sessionId)).toBe("provider-a/shared-model");
	});

	test("materializing a non-default role persists only the concrete active default", async () => {
		const profile: ModelProfileDefinition = {
			name: "default-chain-profile",
			requiredProviders: [],
			modelMapping: { default: ["provider-a/default", "provider-b/executor", "provider-c/default"] },
			source: "user",
		};
		const session = fakeSession();
		const settings = Settings.isolated({ "modelProfile.default": profile.name });
		await activateModelProfile({
			session,
			modelRegistry: fakeRegistry({ profiles: [profile] }),
			settings,
			profileName: profile.name,
		});
		session.model = model("provider-b", "executor");
		session.thinkingLevel = undefined;

		materializeActiveModelProfileAssignment({
			session,
			settings,
			role: "executor",
			selector: "provider-c/executor",
		});

		expect(settings.get("modelRoles").default).toBe("provider-b/executor");
	});

	test("profile deletion materializes the complete default fallback chain", async () => {
		const profile: ModelProfileDefinition = {
			name: "delete-chain-profile",
			requiredProviders: [],
			modelMapping: { default: ["provider-a/default:high", "provider-b/executor", "provider-c/default"] },
			source: "user",
		};
		const settings = Settings.isolated({ "modelProfile.default": profile.name });
		await materializeModelProfileForDeletion({
			session: fakeSession(),
			modelRegistry: fakeRegistry({ profiles: [profile] }),
			settings,
			profileName: profile.name,
		});

		expect(settings.get("modelRoles").default).toEqual([
			"provider-a/default:high",
			"provider-b/executor",
			"provider-c/default",
		]);
	});

	test("profile deletion concretizes bare aliases before clearing ownership", async () => {
		const profile: ModelProfileDefinition = {
			name: "delete-alias-profile",
			requiredProviders: [],
			modelMapping: { default: "default", executor: "executor" },
			source: "user",
		};
		const settings = Settings.isolated({ "modelProfile.default": profile.name });
		await materializeModelProfileForDeletion({
			session: fakeSession(),
			modelRegistry: fakeRegistry({ profiles: [profile] }),
			settings,
			profileName: profile.name,
		});

		expect(settings.get("modelRoles").default).toBe("provider-a/default");
		expect(settings.get("task.agentModelOverrides").executor).toBe("provider-b/executor");
	});

	test("profile deletion uses an authenticated available alias variant and preserves a partial profile default chain", async () => {
		const profile: ModelProfileDefinition = {
			name: "delete-partial-alias-profile",
			requiredProviders: [],
			modelMapping: { executor: ["glm-5.2:low", "kimi-k3"] },
			source: "user",
		};
		const unavailable = model("alpha", "zai/glm-5.2");
		const available = model("beta", "zai/glm-5.2");
		const baseRegistry = fakeRegistry({ profiles: [profile] });
		const registry = {
			...baseRegistry,
			getAll: () => [unavailable, available],
			getAvailable: () => [available],
			getApiKeyForProvider: async (provider: string) => (provider === "beta" ? "key-beta" : undefined),
			lookupAliasExists: (alias: string) => alias === "glm-5.2" || alias === "kimi-k3",
			resolveModelByLookupAlias: (alias: string, options?: { candidates?: readonly Model[] }) =>
				alias === "glm-5.2" ? options?.candidates?.[0] : undefined,
		};
		const session = fakeSession();
		session.configuredModelChains.set("default", ["provider-c/default"]);
		const settings = Settings.isolated({
			"modelProfile.default": profile.name,
			modelRoles: { default: "provider-c/default" },
		});

		await materializeModelProfileForDeletion({
			session,
			modelRegistry: registry as unknown as ModelRegistry,
			settings,
			profileName: profile.name,
		});

		expect(settings.get("task.agentModelOverrides").executor).toEqual(["beta/zai/glm-5.2:low"]);
		expect(settings.get("modelRoles").default).toBe("provider-c/default");
		expect(session.getConfiguredModelChain("default")).toEqual(["provider-c/default"]);
	});

	test("profile deletion retains ownership when a bare alias loses authentication during concretization", async () => {
		const profile: ModelProfileDefinition = {
			name: "delete-alias-auth-race",
			requiredProviders: [],
			modelMapping: { executor: "glm-5.2" },
			source: "user",
		};
		const available = model("beta", "zai/glm-5.2");
		const baseRegistry = fakeRegistry({ profiles: [profile] });
		const getApiKeyForProvider = vi
			.fn(async (): Promise<string | undefined> => "key-beta")
			.mockResolvedValueOnce("key-beta")
			.mockResolvedValueOnce(undefined);
		const session = fakeSession();
		const sticky = new Map([[session.sessionId, "alpha/zai/glm-5.2"]]);
		const registry = {
			...baseRegistry,
			getAll: () => [available],
			getAvailable: () => [available],
			getApiKeyForProvider,
			lookupAliasExists: (alias: string) => alias === "glm-5.2",
			resolveModelByLookupAlias: (_alias: string, options?: { candidates?: readonly Model[] }) =>
				options?.candidates?.[0],
			getSessionCanonicalVariant: (id: string) => sticky.get(id),
			clearCanonicalVariant: (id: string) => sticky.delete(id),
			restoreSessionCanonicalVariant: (id: string, selector: string) => {
				sticky.set(id, selector);
				return true;
			},
		};
		const settings = Settings.isolated({ "modelProfile.default": profile.name });

		await expect(
			materializeModelProfileForDeletion({
				session,
				modelRegistry: registry as unknown as ModelRegistry,
				settings,
				profileName: profile.name,
			}),
		).rejects.toThrow("could not concretize authenticated selector: glm-5.2");
		expect(settings.get("modelProfile.default")).toBe(profile.name);
		expect(session.getActiveModelProfile()).toBeUndefined();
		expect(sticky.get(session.sessionId)).toBe("alpha/zai/glm-5.2");
	});

	test("materializing a default override stores the selected default and clears the profile", async () => {
		const session = fakeSession();
		const settings = Settings.isolated({ "modelProfile.default": "profile-a" });

		await activateModelProfile({ session, modelRegistry: fakeRegistry(), settings, profileName: "profile-a" });

		const materialized = materializeActiveModelProfileAssignment({
			session,
			settings,
			role: "default",
			selector: "provider-c/default:low",
		});

		expect(materialized).toBe(true);
		expect(settings.get("modelRoles")).toMatchObject({
			default: "provider-c/default:low",
		});
		expect(settings.get("modelProfile.default")).toBeUndefined();
		expect(session.getActiveModelProfile()).toBeUndefined();
	});

	test("batch materialization writes role agents once and clears the active profile once", async () => {
		const session = fakeSession();
		const settings = Settings.isolated({
			"modelProfile.default": "profile-a",
			"task.agentModelOverrides": { critic: "provider-a/old-critic" },
		});
		await activateModelProfile({ session, modelRegistry: fakeRegistry(), settings, profileName: "profile-a" });
		let clearedActiveProfile = 0;
		const originalSetActiveModelProfile = session.setActiveModelProfile.bind(session);
		session.setActiveModelProfile = (name: string | undefined) => {
			if (name === undefined) clearedActiveProfile++;
			originalSetActiveModelProfile(name);
		};

		const materialized = materializeActiveModelProfileAssignments({
			session,
			settings,
			assignments: new Map([
				["executor", "provider-c/executor:low"],
				["architect", "provider-c/architect:medium"],
			]),
		});

		expect(materialized).toBe(true);
		expect(clearedActiveProfile).toBe(1);
		expect(settings.get("modelRoles")).toEqual({ default: "provider-a/default:high" });
		expect(settings.get("task.agentModelOverrides")).toEqual({
			critic: "provider-a/old-critic",
			executor: "provider-c/executor:low",
			architect: "provider-c/architect:medium",
		});
		expect(session.getActiveModelProfile()).toBeUndefined();
	});
	test("colon-tagged concrete model selector materializes whole with optional effort", async () => {
		const session = fakeSession();
		const settings = Settings.isolated({ "task.agentModelOverrides": { executor: "provider-a/old-executor" } });
		const registry = fakeRegistry({
			profiles: [
				{
					name: "colon-tag",
					requiredProviders: ["ollama-cloud"],
					modelMapping: {
						default: "ollama-cloud/deepseek-v4-flash:0731",
						executor: "ollama-cloud/deepseek-v4-flash:0731:xhigh",
					},
					source: "user",
				},
			],
		});
		registry.getAll = () => [model("ollama-cloud", "deepseek-v4-flash:0731"), ...fakeRegistry().getAll()];

		await activateModelProfile({ session, modelRegistry: registry, settings, profileName: "colon-tag" });

		expect(session.getConfiguredModelChain("default")).toEqual(["ollama-cloud/deepseek-v4-flash:0731"]);
		expect(session.model?.provider).toBe("ollama-cloud");
		expect(session.model?.id).toBe("deepseek-v4-flash:0731");
		expect(settings.get("task.agentModelOverrides")).toEqual({
			executor: "ollama-cloud/deepseek-v4-flash:0731:xhigh",
		});
	});

	test("batch materialization is inactive without an active profile", () => {
		const session = fakeSession();
		const settings = Settings.isolated({ "task.agentModelOverrides": { critic: "provider-a/old-critic" } });

		const materialized = materializeActiveModelProfileAssignments({
			session,
			settings,
			assignments: { executor: "provider-c/executor:low" },
		});

		expect(materialized).toBe(false);
		expect(settings.get("task.agentModelOverrides")).toEqual({ critic: "provider-a/old-critic" });
		expect(session.getActiveModelProfile()).toBeUndefined();
	});

	test("--default persists profile default, clears persisted assignments, and flushes", async () => {
		const session = fakeSession();
		const settings = Settings.isolated();
		const setCalls: string[] = [];
		const originalSet = settings.set.bind(settings);
		settings.set = ((path: never, value: never) => {
			setCalls.push(path);
			return originalSet(path, value);
		}) as typeof settings.set;
		let flushCount = 0;
		settings.flushOrThrow = async () => {
			flushCount += 1;
		};

		await activateModelProfile(
			{ session, modelRegistry: fakeRegistry(), settings, profileName: "profile-a" },
			{ persistDefault: true },
		);

		expect(setCalls).toEqual([
			"modelRoles",
			"task.agentModelOverrides",
			"defaultThinkingLevel",
			"modelProfile.default",
		]);
		expect(settings.get("defaultThinkingLevel")).toBe(ThinkingLevel.High);
		expect(settings.get("modelProfile.default")).toBe("profile-a");
		expect(flushCount).toBe(1);
		expect(session.getActiveModelProfile()).toBe("profile-a");
	});

	test("missing credentials hard-block before mutation", async () => {
		const session = fakeSession();
		const settings = Settings.isolated({
			"task.agentModelOverrides": { executor: "provider-a/original" },
			"modelProfile.default": "old-profile",
		});

		await expect(
			activateModelProfile({
				session,
				modelRegistry: fakeRegistry({ missingProviders: ["provider-a", "provider-b"] }),
				settings,
				profileName: "profile-a",
			}),
		).rejects.toThrow(
			'Model profile "profile-a" requires credentials for: provider-a, provider-b. Run /login and configure the missing provider(s), then retry.',
		);
		expect(session.model?.id).toBe("initial");
		expect(session.thinkingLevel).toBe(ThinkingLevel.Low);
		expect(session.setModelTemporaryCalls).toEqual([]);
		expect(settings.get("task.agentModelOverrides")).toEqual({ executor: "provider-a/original" });
		expect(settings.get("modelProfile.default")).toBe("old-profile");
	});

	test("unknown profile error lists available profiles", async () => {
		await expect(
			prepareModelProfileActivation({
				session: fakeSession(),
				modelRegistry: fakeRegistry({
					profiles: [
						{ name: "alpha", requiredProviders: [], modelMapping: {}, source: "user" },
						{ name: "beta", requiredProviders: [], modelMapping: {}, source: "user" },
					],
				}),
				settings: Settings.isolated(),
				profileName: "missing",
			}),
		).rejects.toThrow('Unknown model profile "missing". Available profiles: alpha, beta');
	});

	test("apply rolls back runtime changes when persistence throws", async () => {
		const session = fakeSession();
		const settings = Settings.isolated({
			"task.agentModelOverrides": { executor: "provider-a/original" },
			defaultThinkingLevel: ThinkingLevel.Low,
		});
		const prepared = await prepareModelProfileActivation({
			session,
			modelRegistry: fakeRegistry(),
			settings,
			profileName: "profile-a",
		});
		vi.spyOn(settings, "flushOrThrow").mockRejectedValueOnce(new Error("flush failed"));

		await expect(applyPreparedModelProfileActivation(prepared, { persistDefault: true })).rejects.toThrow(
			"flush failed",
		);

		expect(session.model?.id).toBe("initial");
		expect(session.thinkingLevel).toBe(ThinkingLevel.Low);
		expect(settings.get("task.agentModelOverrides")).toEqual({ executor: "provider-a/original" });
		expect(settings.get("modelProfile.default")).toBeUndefined();
		expect(settings.get("defaultThinkingLevel")).toBe(ThinkingLevel.Low);
		expect(session.getActiveModelProfile()).toBeUndefined();
	});

	test("precedence composes configured, default, mpreset, and explicit overrides", async () => {
		const settings = Settings.isolated({ "task.agentModelOverrides": { executor: "configured/executor" } });
		const session = fakeSession();
		await activateModelProfile({ session, modelRegistry: fakeRegistry(), settings, profileName: "profile-a" });
		settings.override("task.agentModelOverrides", {
			...settings.get("task.agentModelOverrides"),
			executor: "explicit/executor",
		});
		expect(settings.get("task.agentModelOverrides")).toEqual({
			executor: "explicit/executor",
			architect: "provider-a/architect",
		});
	});
});

// ---------------------------------------------------------------------------
// Xiaomi Token Plan region activation tests
// ---------------------------------------------------------------------------

function stubXiaomiRegistry(
	authenticatedProviders: string[],
): Pick<
	ModelRegistry,
	| "getModelProfile"
	| "getModelProfiles"
	| "getAvailableModelProfileNames"
	| "getApiKeyForProvider"
	| "getAll"
	| "resolveCanonicalModel"
	| "getCanonicalVariants"
	| "getCanonicalId"
> {
	const profiles = mergeModelProfiles();
	const xiaomiProviders = ["xiaomi", "xiaomi-token-plan-sgp", "xiaomi-token-plan-ams", "xiaomi-token-plan-cn"];
	const models = xiaomiProviders.map(provider => ({
		id: "mimo-v2.5-pro",
		provider,
		api: "openai-completions",
	}));
	return {
		getModelProfiles: () => profiles,
		getModelProfile: name => profiles.get(name) ?? undefined,
		getAvailableModelProfileNames: () => [...profiles.keys()],
		getApiKeyForProvider: async (provider: string) =>
			authenticatedProviders.includes(provider) ? "test-key" : undefined,
		getAll: () => models as never[],
		resolveCanonicalModel: () => undefined,
		getCanonicalVariants: () => [],
		getCanonicalId: (item: Model) => item.id,
	};
}

function stubXiaomiSession() {
	const configuredModelChains = new Map<string, readonly string[]>();
	return {
		model: undefined,
		thinkingLevel: ThinkingLevel.Medium,
		sessionId: "test-session",
		setModelTemporary: async () => {},
		setConfiguredModelChain: (role: string, entries: readonly string[]) => {
			configuredModelChains.set(role, [...entries]);
		},
		getConfiguredModelChain: (role: string) => configuredModelChains.get(role),
		setActiveModelProfile: () => {},
		getActiveModelProfile: () => undefined,
	};
}

function stubXiaomiSettings() {
	return Settings.isolated();
}

describe("model-profile-activation: xiaomi token-plan regions", () => {
	it("mimo-pro includes all four xiaomi providers in requiredProviders", () => {
		const profiles = mergeModelProfiles();
		const mimoPro = profiles.get("mimo-pro");
		expect(mimoPro).toBeDefined();
		const providers = mimoPro!.requiredProviders;
		expect(providers).toContain("xiaomi");
		expect(providers).toContain("xiaomi-token-plan-sgp");
		expect(providers).toContain("xiaomi-token-plan-ams");
		expect(providers).toContain("xiaomi-token-plan-cn");
	});

	it("mimo-medium includes all four xiaomi providers in requiredProviders", () => {
		const profiles = mergeModelProfiles();
		const mimoMedium = profiles.get("mimo-medium");
		expect(mimoMedium).toBeDefined();
		const providers = mimoMedium!.requiredProviders;
		expect(providers).toContain("xiaomi");
		expect(providers).toContain("xiaomi-token-plan-sgp");
		expect(providers).toContain("xiaomi-token-plan-ams");
		expect(providers).toContain("xiaomi-token-plan-cn");
	});

	it("mimo-eco only requires xiaomi (no token-plan fallback)", () => {
		const profiles = mergeModelProfiles();
		const mimoEco = profiles.get("mimo-eco");
		expect(mimoEco).toBeDefined();
		expect(mimoEco!.requiredProviders).toEqual(["xiaomi"]);
	});

	it("activation succeeds with only xiaomi-token-plan-sgp", async () => {
		const registry = stubXiaomiRegistry(["xiaomi-token-plan-sgp"]);
		const session = stubXiaomiSession();
		const settings = stubXiaomiSettings();
		const prepared = await prepareModelProfileActivation({
			session,
			modelRegistry: registry as unknown as ModelRegistry,
			settings,
			profileName: "mimo-pro",
		});
		expect(prepared.profileName).toBe("mimo-pro");
	});

	it("activation succeeds with only xiaomi-token-plan-ams", async () => {
		const registry = stubXiaomiRegistry(["xiaomi-token-plan-ams"]);
		const session = stubXiaomiSession();
		const settings = stubXiaomiSettings();
		const prepared = await prepareModelProfileActivation({
			session,
			modelRegistry: registry as unknown as ModelRegistry,
			settings,
			profileName: "mimo-pro",
		});
		expect(prepared.profileName).toBe("mimo-pro");
	});

	it("activation succeeds with only xiaomi-token-plan-cn", async () => {
		const registry = stubXiaomiRegistry(["xiaomi-token-plan-cn"]);
		const session = stubXiaomiSession();
		const settings = stubXiaomiSettings();
		const prepared = await prepareModelProfileActivation({
			session,
			modelRegistry: registry as unknown as ModelRegistry,
			settings,
			profileName: "mimo-pro",
		});
		expect(prepared.profileName).toBe("mimo-pro");
	});

	it("activation fails with no xiaomi credentials", async () => {
		const registry = stubXiaomiRegistry([]);
		const session = stubXiaomiSession();
		const settings = stubXiaomiSettings();
		await expect(
			prepareModelProfileActivation({
				session,
				modelRegistry: registry as unknown as ModelRegistry,
				settings,
				profileName: "mimo-pro",
			}),
		).rejects.toThrow(
			formatModelProfileCredentialError("mimo-pro", [
				"xiaomi",
				"xiaomi-token-plan-sgp",
				"xiaomi-token-plan-ams",
				"xiaomi-token-plan-cn",
			]),
		);
	});

	it("profiles without alternativeProviderGroups require ALL providers strictly", async () => {
		// codex-eco requires openai-codex. If only anthropic is authenticated,
		// activation should fail (not treat them as interchangeable).
		const registry = stubXiaomiRegistry(["anthropic"]);
		const session = stubXiaomiSession();
		const settings = stubXiaomiSettings();
		await expect(
			prepareModelProfileActivation({
				session,
				modelRegistry: registry as unknown as ModelRegistry,
				settings,
				profileName: "codex-eco",
			}),
		).rejects.toThrow(/requires credentials/);
	});
});
describe("preset-equivalent profile activation", () => {
	const opusReal = model("provider-a", "opus-real");
	const sonnetReal = model("provider-b", "sonnet-real");
	const opusB = model("provider-b", "opus-real");

	test("resolves preset aliases for profile default, roles, and overrides", async () => {
		const profile: ModelProfileDefinition = {
			name: "preset-profile",
			requiredProviders: [],
			modelMapping: {
				default: "opus",
				executor: "sonnet",
				architect: "opus",
			},
			source: "user",
		};
		const registry = {
			...fakeRegistry({ profiles: [profile] }),
			getAll: () => [opusReal, sonnetReal],
			lookupAliasExists: (alias: string) => alias === "opus" || alias === "sonnet",
			resolveModelByLookupAlias: (alias: string, options?: { candidates?: Model[] }) =>
				alias === "opus"
					? options?.candidates?.find(m => m.provider === opusReal.provider && m.id === opusReal.id)
					: alias === "sonnet"
						? options?.candidates?.find(m => m.provider === sonnetReal.provider && m.id === sonnetReal.id)
						: undefined,
		};

		const prepared = await prepareModelProfileActivation({
			session: fakeSession(),
			modelRegistry: registry as unknown as ModelRegistry,
			settings: Settings.isolated(),
			profileName: profile.name,
		});

		expect(prepared.defaultModel).toMatchObject({ provider: "provider-a", id: "opus-real" });
		expect(prepared.defaultChain).toEqual(["opus"]);
		// Materialized selectors preserve the full alias selector/wire identity.
		expect(prepared.modelRoles).toEqual({});
		expect(prepared.agentModelOverrides.executor).toBe("sonnet");
		expect(prepared.agentModelOverrides.architect).toBe("opus");
	});

	test("explicit user reselection prevents old sticky provider resurrection", async () => {
		const tempDir = TempDir.createSync("@gjc-reselect-sticky-");
		try {
			const manager = SessionManager.create(tempDir.path(), tempDir.path());
			const oldProviderModel = model("provider-a", "default");
			const nextModel = model("provider-b", "executor");
			const seedCanonicalVariant = vi.fn((_sessionId: string, _selected: Model) => true);
			const clearCanonicalVariant = vi.fn(() => true);
			const getCanonicalId = vi.fn((selected: Model) =>
				selected.provider === "provider-b" ? "provider-b-executor" : undefined,
			);
			const session = new AgentSession({
				agent: new Agent({ initialState: { model: oldProviderModel, systemPrompt: [], tools: [], messages: [] } }),
				sessionManager: manager,
				settings: Settings.isolated({ "compaction.enabled": false }),
				modelRegistry: {
					...fakeRegistry(),
					getApiKey: async () => kNoAuth,
					getCanonicalId,
					seedCanonicalVariant,
					clearCanonicalVariant,
				} as unknown as ModelRegistry,
			});
			try {
				// The old provider-a model has no canonical identity, so an explicit
				// selection clears any stale sticky variant rather than remapping it.
				await session.setModel(oldProviderModel, "default", { cause: "user-selection" });
				expect(clearCanonicalVariant).toHaveBeenCalledWith(session.sessionId);
				expect(seedCanonicalVariant).not.toHaveBeenCalledWith(session.sessionId, oldProviderModel);

				// Reselecting a model with a canonical identity seeds it as the new
				// sticky variant, so the old provider-a sticky cannot resurrect.
				clearCanonicalVariant.mockClear();
				await session.setModel(nextModel, "default", { cause: "user-selection" });
				expect(seedCanonicalVariant).toHaveBeenCalledWith(session.sessionId, nextModel);
				expect(seedCanonicalVariant).not.toHaveBeenCalledWith(session.sessionId, oldProviderModel);
			} finally {
				await session.dispose();
			}
		} finally {
			tempDir.removeSync();
		}
	});
	// Fake registry that mirrors the real registry's per-session canonical
	// sticky behavior: alias resolution honors a seeded sticky variant and
	// otherwise returns the ranked (provider-b) winner.
	function stickyAliasRegistry(options: {
		profiles: ModelProfileDefinition[];
		missingProviders?: string[];
		sticky?: Map<string, string>;
	}) {
		const sticky = options.sticky ?? new Map<string, string>();
		const clearCanonicalVariant = vi.fn((sessionId: string) => sticky.delete(sessionId));
		const seedCanonicalVariant = vi.fn((sessionId: string, selected: Model) => {
			sticky.set(sessionId, `${selected.provider}/${selected.id}`);
			return true;
		});
		const getSessionCanonicalVariant = vi.fn((sessionId: string) => sticky.get(sessionId));
		const restoreSessionCanonicalVariant = vi.fn((sessionId: string, selector: string) => {
			sticky.set(sessionId, selector);
			return true;
		});
		const registry = {
			...fakeRegistry({ missingProviders: options.missingProviders, profiles: options.profiles }),
			getAll: () => [opusReal, opusB],
			lookupAliasExists: (alias: string) => alias === "opus",
			resolveModelByLookupAlias: (alias: string, lookupOptions?: { candidates?: Model[]; sessionId?: string }) => {
				if (alias !== "opus") return undefined;
				const candidates = lookupOptions?.candidates ?? [];
				const stickySelector = lookupOptions?.sessionId ? sticky.get(lookupOptions.sessionId) : undefined;
				const stickyHit = candidates.find(candidate => `${candidate.provider}/${candidate.id}` === stickySelector);
				if (stickyHit) return stickyHit;
				return candidates.find(candidate => candidate.provider === "provider-b");
			},
			getCanonicalId: (selected: Model) => (selected.id === "opus-real" ? "opus" : undefined),
			clearCanonicalVariant,
			seedCanonicalVariant,
			getSessionCanonicalVariant,
			restoreSessionCanonicalVariant,
		};
		return {
			registry: registry as unknown as ModelRegistry,
			sticky,
			clearCanonicalVariant,
			seedCanonicalVariant,
			getSessionCanonicalVariant,
			restoreSessionCanonicalVariant,
		};
	}

	test("old sticky provider does not influence a new profile's alias", async () => {
		const profile: ModelProfileDefinition = {
			name: "preset-profile",
			requiredProviders: [],
			modelMapping: { default: "opus" },
			source: "user",
		};
		const { registry, sticky, clearCanonicalVariant, seedCanonicalVariant } = stickyAliasRegistry({
			profiles: [profile],
		});
		const session = fakeSession();
		// A prior explicit selection made provider-a's variant sticky for the session.
		sticky.set(session.sessionId, "provider-a/opus-real");

		const prepared = await prepareModelProfileActivation({
			session,
			modelRegistry: registry,
			settings: Settings.isolated(),
			profileName: profile.name,
		});

		// The stale sticky was invalidated before alias resolution, so the ranked
		// provider-b variant won instead of the old provider-a sticky.
		expect(clearCanonicalVariant).toHaveBeenCalledWith(session.sessionId);
		expect(sticky.has(session.sessionId)).toBe(false);
		expect(prepared.defaultModel).toMatchObject({ provider: "provider-b", id: "opus-real" });
		// Prepare never seeds a winner; the successful activation path owns the seed.
		expect(seedCanonicalVariant).not.toHaveBeenCalled();
	});

	test("prepare failure restores the prior canonical sticky", async () => {
		const profile: ModelProfileDefinition = {
			name: "credential-gated",
			requiredProviders: ["provider-a"],
			modelMapping: { default: "opus" },
			source: "user",
		};
		const priorModel = model("provider-a", "opus-real");
		const { registry, sticky, clearCanonicalVariant } = stickyAliasRegistry({
			profiles: [profile],
			missingProviders: ["provider-a"],
		});
		const session = fakeSession(priorModel);
		sticky.set(session.sessionId, "provider-a/opus-real");

		await expect(
			prepareModelProfileActivation({
				session,
				modelRegistry: registry,
				settings: Settings.isolated(),
				profileName: profile.name,
			}),
		).rejects.toThrow(/requires credentials/);

		// The prior model carries a canonical identity, so prepare restored it.
		expect(clearCanonicalVariant).toHaveBeenCalledWith(session.sessionId);
		expect(sticky.get(session.sessionId)).toBe("provider-a/opus-real");
	});

	test("failed exact sticky restoration clears any transaction-local winner", async () => {
		const profile: ModelProfileDefinition = {
			name: "credential-gated",
			requiredProviders: ["provider-a"],
			modelMapping: { default: "opus" },
			source: "user",
		};
		const priorModel = model("provider-a", "opus-real");
		const {
			registry: baseRegistry,
			sticky,
			clearCanonicalVariant,
		} = stickyAliasRegistry({
			profiles: [profile],
			missingProviders: ["provider-a"],
		});
		const registry = Object.assign(baseRegistry, {
			restoreSessionCanonicalVariant: () => false,
		});
		const session = fakeSession(priorModel);
		sticky.set(session.sessionId, "provider-a/opus-real");

		await expect(
			prepareModelProfileActivation({
				session,
				modelRegistry: registry,
				settings: Settings.isolated(),
				profileName: profile.name,
			}),
		).rejects.toThrow(/requires credentials/);

		expect(clearCanonicalVariant).toHaveBeenCalledTimes(2);
		expect(sticky.has(session.sessionId)).toBe(false);
	});

	test("apply rollback restores the prior canonical sticky", async () => {
		const profile: ModelProfileDefinition = {
			name: "preset-profile",
			requiredProviders: [],
			modelMapping: { default: "opus" },
			source: "user",
		};
		const priorModel = model("provider-a", "opus-real");
		const { registry, sticky, clearCanonicalVariant } = stickyAliasRegistry({ profiles: [profile] });
		const session = fakeSession(priorModel);
		const settings = Settings.isolated();
		sticky.set(session.sessionId, "provider-a/opus-real");
		session.recordResumeDefaultModel("provider-a/opus-real");

		const prepared = await prepareModelProfileActivation({
			session,
			modelRegistry: registry,
			settings,
			profileName: profile.name,
		});
		// Prepare invalidated the sticky so alias resolution was unbiased.
		expect(clearCanonicalVariant).toHaveBeenCalledWith(session.sessionId);
		expect(sticky.has(session.sessionId)).toBe(false);

		Object.assign(session, {
			noteProfileInstalledOverrides: () => {
				throw new Error("note failed");
			},
		});
		await expect(applyPreparedModelProfileActivation(prepared)).rejects.toThrow("note failed");

		// Rollback re-seeded the prior model's canonical variant.
		expect(session.model).toBe(priorModel);
		expect(sticky.get(session.sessionId)).toBe("provider-a/opus-real");
		expect(session.getSessionDefaultModelSelector()).toBe("provider-a/opus-real");
	});

	// A transient live-model switch (no canonical identity, unrelated to the
	// prior selection) must not clobber the exactly-sticky provider on rollback.
	test("transient live model cannot clobber the prior sticky on rollback", async () => {
		const profile: ModelProfileDefinition = {
			name: "preset-profile",
			requiredProviders: [],
			modelMapping: { default: "opus" },
			source: "user",
		};
		const transientModel = model("provider-c", "transient");
		const { registry, sticky, clearCanonicalVariant } = stickyAliasRegistry({ profiles: [profile] });
		const session = fakeSession(transientModel);
		const settings = Settings.isolated();
		// A prior explicit selection left provider-a sticky, independent of the
		// current (transient) live model — which carries no canonical identity.
		sticky.set(session.sessionId, "provider-a/opus-real");

		const prepared = await prepareModelProfileActivation({
			session,
			modelRegistry: registry,
			settings,
			profileName: profile.name,
		});
		// Prepare snapshotted the exact sticky selector before invalidating it.
		expect(clearCanonicalVariant).toHaveBeenCalledWith(session.sessionId);
		expect(sticky.has(session.sessionId)).toBe(false);

		vi.spyOn(settings, "flushOrThrow").mockRejectedValueOnce(new Error("flush failed"));
		await expect(applyPreparedModelProfileActivation(prepared, { persistDefault: true })).rejects.toThrow(
			"flush failed",
		);

		// Rollback restores the exact pre-clear sticky selector, not the
		// transient live model's (absent) canonical identity.
		expect(session.model).toBe(transientModel);
		expect(sticky.get(session.sessionId)).toBe("provider-a/opus-real");
	});

	// A successful materialize clears the sticky during prepare; restoring the
	// materialization must return the prior sticky via the snapshot's closure.
	test("deletion restore returns the prior sticky canonical variant", async () => {
		const profile: ModelProfileDefinition = {
			name: "preset-profile",
			requiredProviders: [],
			modelMapping: { default: "opus" },
			source: "user",
		};
		const { registry, sticky } = stickyAliasRegistry({ profiles: [profile] });
		const session = fakeSession();
		const fallbackRuntimeState = {
			chain: {
				role: "default",
				entries: ["provider-a/opus-real", "provider-b/opus-real"],
				origin: "runtime",
				explicitHead: true,
			},
			controller: {
				activeIndex: 1,
				attemptsUsed: 2,
				totalAttemptsUsed: 3,
				attemptStarted: true,
				restoredEntryIndices: [0],
				tried: [{ selector: "provider-a/opus-real", triggerClass: "rate_limit", reason: "retry" }],
				skips: [{ selector: "provider-b/opus-real", reason: "unauthenticated" }],
				exhaustedForTurn: true,
			},
			exhaustedLastTurn: true,
		} satisfies DefaultFallbackRuntimeState;
		const restoreDefaultFallbackRuntimeState = vi.fn();
		const sessionWithFallback = Object.assign(session, {
			getDefaultFallbackRuntimeState: () => fallbackRuntimeState,
			restoreDefaultFallbackRuntimeState,
		});
		const settings = Settings.isolated();
		// A prior explicit selection made provider-a sticky for the session.
		sticky.set(session.sessionId, "provider-a/opus-real");

		const snapshot = await materializeModelProfileForDeletion({
			session: sessionWithFallback,
			modelRegistry: registry,
			settings,
			profileName: profile.name,
		});
		// Materialization invalidated the sticky during prepare.
		expect(sticky.has(session.sessionId)).toBe(false);

		await restoreMaterializedModelProfileForDeletion({ settings, session: sessionWithFallback, snapshot });

		// The snapshot's internal closure restored the exact pre-clear sticky.
		expect(sticky.get(session.sessionId)).toBe("provider-a/opus-real");
		expect(restoreDefaultFallbackRuntimeState).toHaveBeenCalledWith(fallbackRuntimeState);
	});

	test("successful activation leaves the new model sticky", async () => {
		const tempDir = TempDir.createSync("@gjc-profile-sticky-success-");
		try {
			const manager = SessionManager.create(tempDir.path(), tempDir.path());
			const profile: ModelProfileDefinition = {
				name: "preset-profile",
				requiredProviders: [],
				modelMapping: { default: "opus" },
				source: "user",
			};
			const nextModel = model("provider-b", "opus-real");
			const seedCanonicalVariant = vi.fn((_sessionId: string, _selected: Model) => true);
			const clearCanonicalVariant = vi.fn(() => true);
			const getCanonicalId = vi.fn((selected: Model) => (selected.id === "opus-real" ? "opus" : undefined));
			const registry = {
				...fakeRegistry({ profiles: [profile] }),
				getApiKey: async () => kNoAuth,
				getAll: () => [model("provider-a", "opus-real"), nextModel],
				lookupAliasExists: (alias: string) => alias === "opus",
				resolveModelByLookupAlias: (_alias: string, lookupOptions?: { candidates?: Model[] }) =>
					lookupOptions?.candidates?.find(candidate => candidate.provider === "provider-b"),
				getCanonicalId,
				clearCanonicalVariant,
				seedCanonicalVariant,
			} as unknown as ModelRegistry;
			const session = new AgentSession({
				agent: new Agent({
					initialState: { model: model("provider-a", "initial"), systemPrompt: [], tools: [], messages: [] },
				}),
				sessionManager: manager,
				settings: Settings.isolated({ "compaction.enabled": false }),
				modelRegistry: registry,
			});
			try {
				await activateModelProfile({
					session,
					modelRegistry: registry,
					settings: Settings.isolated(),
					profileName: profile.name,
				});

				// Prepare invalidated any old sticky; the successful activation
				// path seeded the new winner through the session-default behavior.
				expect(clearCanonicalVariant).toHaveBeenCalledWith(session.sessionId);
				expect(session.model).toBe(nextModel);
				expect(seedCanonicalVariant).toHaveBeenCalledWith(session.sessionId, nextModel);
			} finally {
				await session.dispose();
			}
		} finally {
			tempDir.removeSync();
		}
	});
});

describe("model-profile-activation: OpenAI-compatible proxy routing", () => {
	const proxyModel = (id: string, thinking?: Model["thinking"]): Model => model("litellm", id, thinking);

	// xai/grok-4.3 is pinned by builtin grok profiles and is proxy-routable.
	const grokProfile: ModelProfileDefinition = {
		name: "grok-pro",
		requiredProviders: ["xai"],
		modelMapping: {
			default: "xai/grok-4.3:medium",
			executor: "xai/grok-4.3:high",
		},
		source: "builtin",
	};

	function proxyRegistry(
		options: { proxyApiKey?: string; missing?: string[]; profiles?: ModelProfileDefinition[] } = {},
	) {
		const base = fakeRegistry({ missingProviders: options.missing, profiles: options.profiles });
		return {
			...base,
			getAll: () => [
				...base.getAll(),
				model("xai", "grok-4.3", {
					mode: "effort",
					minLevel: ThinkingLevel.Low,
					maxLevel: ThinkingLevel.XHigh,
				}),
				proxyModel("xai/grok-4.3", {
					mode: "effort",
					minLevel: ThinkingLevel.Low,
					maxLevel: ThinkingLevel.XHigh,
				}),
			],
			getConfiguredProviderIds: () => ["litellm"],
			getApiKeyForProvider: async (provider: string) => {
				if (provider === "litellm") {
					// Explicit undefined means "proxy not authenticated"; the default
					// (no key passed) means "authenticated".
					return "proxyApiKey" in options ? options.proxyApiKey : "key-litellm";
				}
				return base.getApiKeyForProvider(provider);
			},
		};
	}

	test("routes builtin preset selectors through the proxy when the direct provider is unauthenticated", async () => {
		const settings = Settings.isolated({ "modelProfile.proxyProvider": "litellm" });
		const prepared = await prepareModelProfileActivation({
			session: fakeSession(),
			modelRegistry: proxyRegistry({ missing: ["xai"], profiles: [grokProfile] }) as unknown as ModelRegistry,
			settings,
			profileName: grokProfile.name,
		});

		expect(prepared.defaultModel?.provider).toBe("litellm");
		expect(prepared.defaultModel?.id).toBe("xai/grok-4.3");
		expect(prepared.defaultChain).toEqual(["litellm/xai/grok-4.3:medium"]);
		expect(prepared.agentModelOverrides.executor).toBe("litellm/xai/grok-4.3:high");
	});

	test("keeps registry role bindings available after a documented proxy rewrite", async () => {
		const profile: ModelProfileDefinition = { ...grokProfile, name: "registry-grok", source: "registry" };
		const settings = Settings.isolated({ "modelProfile.proxyProvider": "litellm" });
		const prepared = await prepareModelProfileActivation({
			session: fakeSession(),
			modelRegistry: proxyRegistry({ missing: ["xai"], profiles: [profile] }) as unknown as ModelRegistry,
			settings,
			profileName: profile.name,
		});

		expect(prepared.defaultChain).toEqual(["litellm/xai/grok-4.3:medium"]);
		expect(prepared.agentModelOverrides.executor).toBe("litellm/xai/grok-4.3:high");
	});

	test("keeps direct selectors when the direct provider is authenticated even with a proxy configured", async () => {
		const settings = Settings.isolated({ "modelProfile.proxyProvider": "litellm" });
		const prepared = await prepareModelProfileActivation({
			session: fakeSession(),
			modelRegistry: proxyRegistry({ profiles: [grokProfile] }) as unknown as ModelRegistry,
			settings,
			profileName: grokProfile.name,
		});

		expect(prepared.defaultModel?.provider).toBe("xai");
		expect(prepared.defaultModel?.id).toBe("grok-4.3");
		expect(prepared.defaultChain).toEqual(["xai/grok-4.3:medium"]);
		expect(prepared.agentModelOverrides.executor).toBe("xai/grok-4.3:high");
	});

	test("routes builtin preset selectors through the proxy in always mode despite direct credentials", async () => {
		const settings = Settings.isolated({
			"modelProfile.proxyProvider": "litellm",
			"modelProfile.proxyMode": "always",
		});
		const prepared = await prepareModelProfileActivation({
			session: fakeSession(),
			modelRegistry: proxyRegistry({ profiles: [grokProfile] }) as unknown as ModelRegistry,
			settings,
			profileName: grokProfile.name,
		});

		expect(prepared.defaultModel?.provider).toBe("litellm");
		expect(prepared.defaultChain).toEqual(["litellm/xai/grok-4.3:medium"]);
		expect(prepared.agentModelOverrides.executor).toBe("litellm/xai/grok-4.3:high");
	});

	test("routes provider-agnostic builtin aliases through an exact proxy model in always mode", async () => {
		const profile: ModelProfileDefinition = {
			name: "open-weights-grok",
			requiredProviders: [],
			modelMapping: { default: "grok-4.3:medium" },
			source: "builtin",
		};
		const registry = proxyRegistry({ profiles: [profile] });
		const prepared = await prepareModelProfileActivation({
			session: fakeSession(),
			modelRegistry: {
				...registry,
				getAll: () => [...registry.getAll(), proxyModel("grok-4.3")],
			} as unknown as ModelRegistry,
			settings: Settings.isolated({ "modelProfile.proxyProvider": "litellm", "modelProfile.proxyMode": "always" }),
			profileName: profile.name,
		});
		expect(prepared.defaultChain).toEqual(["litellm/grok-4.3:medium"]);
	});

	test("routes Muse Spark's bare alias through a unique provider-prefixed proxy model in always mode", async () => {
		const profile = BUILTIN_MODEL_PROFILES.find(candidate => candidate.name === "open-weights-spark");
		if (!profile) throw new Error("Missing open-weights-spark profile");
		const registry = proxyRegistry({ profiles: [profile] });
		const prepared = await prepareModelProfileActivation({
			session: fakeSession(),
			modelRegistry: {
				...registry,
				getAll: () => [
					...registry.getAll(),
					proxyModel("meta/muse-spark-1.2", {
						mode: "effort",
						minLevel: ThinkingLevel.Minimal,
						maxLevel: ThinkingLevel.XHigh,
					}),
				],
			} as unknown as ModelRegistry,
			settings: Settings.isolated({ "modelProfile.proxyProvider": "litellm", "modelProfile.proxyMode": "always" }),
			profileName: profile.name,
		});

		expect(prepared.defaultChain).toEqual(["litellm/meta/muse-spark-1.2:medium"]);
		expect(prepared.agentModelOverrides.architect).toBe("litellm/meta/muse-spark-1.2:xhigh");
	});

	test("fails closed when multiple provider-prefixed proxy models share the Muse Spark alias", async () => {
		const profile = BUILTIN_MODEL_PROFILES.find(candidate => candidate.name === "open-weights-spark");
		if (!profile) throw new Error("Missing open-weights-spark profile");
		const registry = proxyRegistry({ profiles: [profile] });

		await expect(
			prepareModelProfileActivation({
				session: fakeSession(),
				modelRegistry: {
					...registry,
					getAll: () => [
						...registry.getAll(),
						proxyModel("meta/muse-spark-1.2"),
						proxyModel("other/muse-spark-1.2"),
					],
				} as unknown as ModelRegistry,
				settings: Settings.isolated({
					"modelProfile.proxyProvider": "litellm",
					"modelProfile.proxyMode": "always",
				}),
				profileName: profile.name,
			}),
		).rejects.toThrow(/does not expose an unambiguous model for "muse-spark-1\.2"/);
	});

	test("fails closed pointing at the proxy when a routable provider is missing and the proxy is unauthenticated", async () => {
		const settings = Settings.isolated({ "modelProfile.proxyProvider": "litellm" });
		await expect(
			prepareModelProfileActivation({
				session: fakeSession(),
				modelRegistry: proxyRegistry({
					missing: ["xai"],
					proxyApiKey: undefined,
					profiles: [grokProfile],
				}) as unknown as ModelRegistry,
				settings,
				profileName: grokProfile.name,
			}),
		).rejects.toMatchObject({
			constructor: ModelProfileCredentialError,
			profileLabel: grokProfile.name,
			providers: ["litellm"],
		});
	});

	test("keeps the direct provider credential error when no proxy is configured", async () => {
		await expect(
			prepareModelProfileActivation({
				session: fakeSession(),
				modelRegistry: proxyRegistry({ missing: ["xai"], profiles: [grokProfile] }) as unknown as ModelRegistry,
				settings: Settings.isolated(),
				profileName: grokProfile.name,
			}),
		).rejects.toMatchObject({
			constructor: ModelProfileCredentialError,
			profileLabel: grokProfile.name,
			providers: ["xai"],
		});
	});

	test("treats a keyless proxy as authenticated for routing", async () => {
		const settings = Settings.isolated({ "modelProfile.proxyProvider": "litellm" });
		const prepared = await prepareModelProfileActivation({
			session: fakeSession(),
			modelRegistry: proxyRegistry({
				missing: ["xai"],
				proxyApiKey: kNoAuth,
				profiles: [grokProfile],
			}) as unknown as ModelRegistry,
			settings,
			profileName: grokProfile.name,
		});

		expect(prepared.defaultModel?.provider).toBe("litellm");
	});

	test("never routes user-defined profiles through the proxy", async () => {
		const userProfile: ModelProfileDefinition = { ...grokProfile, name: "user-grok", source: "user" };
		const settings = Settings.isolated({ "modelProfile.proxyProvider": "litellm" });
		await expect(
			prepareModelProfileActivation({
				session: fakeSession(),
				modelRegistry: proxyRegistry({ missing: ["xai"], profiles: [userProfile] }) as unknown as ModelRegistry,
				settings,
				profileName: userProfile.name,
			}),
		).rejects.toMatchObject({
			constructor: ModelProfileCredentialError,
			profileLabel: userProfile.name,
			providers: ["xai"],
		});
	});

	test("satisfies an all-routable alternative group through the proxy", async () => {
		const group = ["xiaomi", "xiaomi-token-plan-sgp", "xiaomi-token-plan-ams", "xiaomi-token-plan-cn"];
		const mimoProfile: ModelProfileDefinition = {
			name: "mimo-medium",
			requiredProviders: [...group],
			modelMapping: { default: "xiaomi/mimo-v2.5-pro:medium" },
			alternativeProviderGroups: [group],
			source: "builtin",
		};
		const registry = proxyRegistry({ missing: group, profiles: [mimoProfile] });
		const settings = Settings.isolated({ "modelProfile.proxyProvider": "litellm" });
		const prepared = await prepareModelProfileActivation({
			session: fakeSession(),
			modelRegistry: {
				...registry,
				getAll: () => [
					...registry.getAll(),
					proxyModel("xiaomi/mimo-v2.5-pro", {
						mode: "effort",
						minLevel: ThinkingLevel.Low,
						maxLevel: ThinkingLevel.XHigh,
					}),
				],
			} as unknown as ModelRegistry,
			settings,
			profileName: mimoProfile.name,
		});

		expect(prepared.defaultModel?.provider).toBe("litellm");
		expect(prepared.defaultModel?.id).toBe("xiaomi/mimo-v2.5-pro");
	});

	test("rejects a non-routable missing provider even when the proxy is configured", async () => {
		const profile: ModelProfileDefinition = {
			name: "custom-strict",
			requiredProviders: ["acme-private"],
			modelMapping: { default: "acme-private/alpha:medium" },
			source: "builtin",
		};
		const base = fakeRegistry({ missingProviders: ["acme-private"], profiles: [profile] });
		const registry = {
			...base,
			getAll: () => [...base.getAll(), proxyModel("acme-private/alpha")],
			getConfiguredProviderIds: () => ["litellm"],
			getApiKeyForProvider: async (provider: string) =>
				provider === "litellm" ? "key-litellm" : base.getApiKeyForProvider(provider),
		};
		await expect(
			prepareModelProfileActivation({
				session: fakeSession(),
				modelRegistry: registry as unknown as ModelRegistry,
				settings: Settings.isolated({ "modelProfile.proxyProvider": "litellm" }),
				profileName: profile.name,
			}),
		).rejects.toMatchObject({
			constructor: ModelProfileCredentialError,
			providers: ["acme-private"],
		});
	});

	test("rejects an invalid or unconfigured proxy provider id with a config error", async () => {
		await expect(
			prepareModelProfileActivation({
				session: fakeSession(),
				modelRegistry: proxyRegistry({ profiles: [grokProfile] }) as unknown as ModelRegistry,
				settings: Settings.isolated({ "modelProfile.proxyProvider": "Bad Proxy!" }),
				profileName: grokProfile.name,
			}),
		).rejects.toThrow(/proxyProvider must be a lowercase provider id/);
		await expect(
			prepareModelProfileActivation({
				session: fakeSession(),
				modelRegistry: proxyRegistry({ profiles: [grokProfile] }) as unknown as ModelRegistry,
				settings: Settings.isolated({ "modelProfile.proxyProvider": "litelm" }),
				profileName: grokProfile.name,
			}),
		).rejects.toThrow(/proxyProvider "litelm" is not configured/);
	});

	test("fails closed when any proxy-routed preset binding has no proxy model", async () => {
		const profile: ModelProfileDefinition = {
			...grokProfile,
			modelMapping: {
				default: "xai/grok-4.3:medium",
				executor: "xai/grok-4.4:high",
			},
		};
		await expect(
			prepareModelProfileActivation({
				session: fakeSession(),
				modelRegistry: proxyRegistry({ missing: ["xai"], profiles: [profile] }) as unknown as ModelRegistry,
				settings: Settings.isolated({ "modelProfile.proxyProvider": "litellm" }),
				profileName: profile.name,
			}),
		).rejects.toThrow(/does not expose a model for "xai\/grok-4.4"/);
	});

	test("uses an exact upstream-prefixed proxy model instead of ambiguous suffix matches", async () => {
		const profile: ModelProfileDefinition = {
			...grokProfile,
			modelMapping: { default: "xai/grok-4.3:medium" },
		};
		const registry = proxyRegistry({ missing: ["xai"], profiles: [profile] });
		const prepared = await prepareModelProfileActivation({
			session: fakeSession(),
			modelRegistry: {
				...registry,
				getAll: () => [...registry.getAll(), proxyModel("other/grok-4.3")],
			} as unknown as ModelRegistry,
			settings: Settings.isolated({ "modelProfile.proxyProvider": "litellm" }),
			profileName: profile.name,
		});
		expect(prepared.defaultChain).toEqual(["litellm/xai/grok-4.3:medium"]);
	});

	test("rejects differently prefixed proxy model matches", async () => {
		const profile: ModelProfileDefinition = {
			...grokProfile,
			modelMapping: { default: "xai/grok-4.4:medium" },
		};
		const registry = proxyRegistry({ missing: ["xai"], profiles: [profile] });
		await expect(
			prepareModelProfileActivation({
				session: fakeSession(),
				modelRegistry: {
					...registry,
					getAll: () => [...registry.getAll(), proxyModel("foo/grok-4.4"), proxyModel("bar/grok-4.4")],
				} as unknown as ModelRegistry,
				settings: Settings.isolated({ "modelProfile.proxyProvider": "litellm" }),
				profileName: profile.name,
			}),
		).rejects.toThrow(/does not expose a model for "xai\/grok-4.4"/);
	});

	test("rejects a direct provider configured as its own always-mode proxy", async () => {
		await expect(
			prepareModelProfileActivation({
				session: fakeSession(),
				modelRegistry: {
					...proxyRegistry({ profiles: [grokProfile] }),
					getConfiguredProviderIds: () => ["xai"],
					getApiKeyForProvider: async () => "key-xai",
				} as unknown as ModelRegistry,
				settings: Settings.isolated({ "modelProfile.proxyProvider": "xai", "modelProfile.proxyMode": "always" }),
				profileName: grokProfile.name,
			}),
		).rejects.toThrow(/cannot route its own direct selector/);
	});
});
