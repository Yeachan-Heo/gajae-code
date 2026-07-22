import { describe, expect, it, test } from "bun:test";
import { Agent, ThinkingLevel } from "@gajae-code/agent-core";

import type { Model } from "@gajae-code/ai";
import { TempDir } from "@gajae-code/utils";
import {
	activateModelProfile,
	applyPreparedModelProfileActivation,
	formatModelProfileCredentialError,
	materializeActiveModelProfileAssignment,
	materializeActiveModelProfileAssignments,
	materializeModelProfileForDeletion,
	prepareModelProfileActivation,
} from "../src/config/model-profile-activation";

import type { ModelProfileDefinition } from "../src/config/model-profiles";
import { BUILTIN_MODEL_PROFILES, mergeModelProfiles } from "../src/config/model-profiles";
import { kNoAuth, type ModelRegistry } from "../src/config/model-registry";
import { resolveModelChainWithAuth } from "../src/config/model-resolver";
import { Settings } from "../src/config/settings";
import { AgentSession } from "../src/session/agent-session";
import { SessionManager } from "../src/session/session-manager";

const model = (provider: string, id: string, thinking?: Model["thinking"]): Model =>
	({
		provider,
		id,
		name: id,
		api: "openai-responses",
		contextWindow: 1000,
		maxTokens: 1000,
		thinking,
		reasoning: thinking !== undefined,
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
			model("anthropic", "claude-opus-4-8", {
				mode: "effort",
				minLevel: ThinkingLevel.Low,
				maxLevel: ThinkingLevel.XHigh,
			}),
			model("anthropic", "claude-fable-5", {
				mode: "effort",
				minLevel: ThinkingLevel.Low,
				maxLevel: ThinkingLevel.XHigh,
			}),
			model("anthropic", "claude-sonnet-5"),
			model("opencode-go", "deepseek-v4-pro"),
			model("opencode-go", "kimi-k2.6"),
			model("opencode-go", "mimo-v2.5-pro"),
			model("minimax-code", "minimax-m3"),
			model("minimax-code-cn", "minimax-m3"),
			model("kimi-code", "kimi-k2.5"),
			model("zai", "glm-5.1"),
			model("alibaba-token-plan", "qwen3.8-max-preview", {
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
		seedDefaultFallbackResolutionCalls: [] as Array<{
			activeIndex: number;
			skips: Array<{ selector: string; reason: string }>;
		}>,
		getConfiguredModelChain(role: string) {
			return this.configuredModelChains.get(role);
		},
		setConfiguredModelChain(role: string, entries: readonly string[]) {
			this.configuredModelChains.set(role, [...entries]);
		},
		seedDefaultFallbackResolution(activeIndex: number, skips: Array<{ selector: string; reason: string }>) {
			this.seedDefaultFallbackResolutionCalls.push({ activeIndex, skips });
		},
		async setModelTemporary(next: Model, thinkingLevel?: ThinkingLevel) {
			this.setModelTemporaryCalls.push({ model: next, thinkingLevel });
			this.model = next;
			this.thinkingLevel = thinkingLevel;
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

	test("preserves a fully unresolved executor chain and skips it without request attempts", async () => {
		const executorChain = ["provider-a/unknown-executor", "provider-b/unknown-executor"];
		const profile: ModelProfileDefinition = {
			name: "unresolved-executor",
			requiredProviders: [],
			modelMapping: { default: "provider-a/default", executor: executorChain },
			source: "user",
		};
		const settings = Settings.isolated();
		await activateModelProfile({
			session: fakeSession(),
			modelRegistry: fakeRegistry({ profiles: [profile] }),
			settings,
			profileName: profile.name,
		});

		expect(settings.get("task.agentModelOverrides").executor).toEqual(executorChain);
		let credentialLookups = 0;
		const resolution = await resolveModelChainWithAuth(
			executorChain,
			{
				getAvailable: () => [],
				getApiKey: async () => {
					credentialLookups += 1;
					return kNoAuth;
				},
			},
			settings,
			"session-1",
			{ managedFallback: true },
		);
		expect(resolution.model).toBeUndefined();
		expect(resolution).toMatchObject({
			activeIndex: executorChain.length,
			skips: executorChain.map(selector => ({ selector, reason: "unknown_model" })),
		});
		expect(credentialLookups).toBe(0);
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
		settings.flush = async () => {
			throw new Error("flush failed");
		};

		await expect(applyPreparedModelProfileActivation(prepared, { persistDefault: true })).rejects.toThrow(
			"flush failed",
		);
		expect(session.getConfiguredModelChain("default")).toEqual(["provider-c/default"]);
	});

	test("rollback from an unconfigured session clears the profile chain before reopen", async () => {
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
			settings.flush = async () => {
				throw new Error("flush failed");
			};

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
				expect(reopened.buildSessionContext().models.default).toBe("provider-c/default");
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
				default: "anthropic/claude-opus-4-8:xhigh",
				executor: "openai-codex/gpt-5.6-terra:low",
				planner: "anthropic/claude-sonnet-5",
				critic: "openai-codex/gpt-5.6-sol:xhigh",
				architect: "openai-codex/gpt-5.6-sol:high",
			},
		],
		[
			"codex-opencodego",
			{
				default: "openai-codex/gpt-5.6-sol:low",
				executor: "opencode-go/deepseek-v4-pro",
				planner: "opencode-go/kimi-k2.6",
				critic: "opencode-go/mimo-v2.5-pro",
				architect: "openai-codex/gpt-5.6-sol:high",
			},
		],
		[
			"fable-opus-codex",
			{
				default: "anthropic/claude-fable-5:high",
				executor: "openai-codex/gpt-5.6-terra:medium",
				planner: "anthropic/claude-opus-4-8:medium",
				critic: "anthropic/claude-opus-4-8:high",
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
			"alibaba-token-plan-qwenmaxxing",
			{
				default: "alibaba-token-plan/qwen3.8-max-preview:medium",
				executor: "alibaba-token-plan/qwen3.8-max-preview:low",
				planner: "alibaba-token-plan/qwen3.8-max-preview:medium",
				critic: "alibaba-token-plan/qwen3.8-max-preview:xhigh",
				architect: "alibaba-token-plan/qwen3.8-max-preview:xhigh",
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

	test("materializing a non-default role retains the active default chain from the live fallback", async () => {
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

		expect(settings.get("modelRoles").default).toEqual(["provider-b/executor", "provider-c/default"]);
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
		settings.flush = async () => {
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
		settings.flush = async () => {
			throw new Error("flush failed");
		};

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
