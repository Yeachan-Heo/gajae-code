import { describe, expect, it, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ThinkingLevel } from "@gajae-code/agent-core";
import type { Model } from "@gajae-code/ai";
import {
	activateModelProfile,
	applyPreparedModelProfileActivation,
	formatModelProfileCredentialError,
	materializeActiveModelProfileAssignment,
	materializeActiveModelProfileAssignments,
	prepareModelProfileActivation,
	resolveProjectModelProfileShadow,
} from "../src/config/model-profile-activation";
import type { ModelProfileDefinition } from "../src/config/model-profiles";
import { BUILTIN_MODEL_PROFILES, mergeModelProfiles } from "../src/config/model-profiles";
import type { ModelRegistry } from "../src/config/model-registry";
import { resetSettingsForTest, Settings } from "../src/config/settings";

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
				minLevel: ThinkingLevel.Medium,
				maxLevel: ThinkingLevel.Max,
			}),
			model("openai-codex", "gpt-5.3-codex-spark"),
			model("minimax-code", "minimax-m3"),
			model("minimax-code-cn", "minimax-m3"),
			model("kimi-code", "kimi-k2.5"),
			model("zai", "glm-5.1"),
		],
		resolveCanonicalModel: () => undefined,
		getCanonicalVariants: () => [],
		getCanonicalId: () => undefined,
	};
}

function fakeSession(initial = model("provider-a", "initial"), initialResumeDefault?: string) {
	let activeModelProfile: string | undefined;
	let resumeDefault = initialResumeDefault;
	return {
		model: initial as Model | undefined,
		thinkingLevel: ThinkingLevel.Low as ThinkingLevel | undefined,
		sessionId: "session-1",
		setModelTemporaryCalls: [] as Array<{ model: Model; thinkingLevel?: ThinkingLevel }>,
		resumeDefaultChanges: [] as string[],
		async setModelTemporary(
			next: Model,
			thinkingLevel?: ThinkingLevel,
			options?: { persistAsSessionDefault?: boolean },
		) {
			this.setModelTemporaryCalls.push({ model: next, thinkingLevel });
			this.model = next;
			this.thinkingLevel = thinkingLevel;
			if (options?.persistAsSessionDefault) {
				resumeDefault = `${next.provider}/${next.id}`;
				this.resumeDefaultChanges.push(resumeDefault);
			}
		},
		setActiveModelProfile(name: string | undefined) {
			activeModelProfile = name;
		},
		getActiveModelProfile() {
			return activeModelProfile;
		},
		getSessionDefaultModelSelector() {
			return resumeDefault;
		},
		recordResumeDefaultModel(selector: string) {
			resumeDefault = selector;
			this.resumeDefaultChanges.push(selector);
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
	test("project profile shadow resolution honors fallback aliases and partial bindings", () => {
		const profiles: ModelProfileDefinition[] = [
			{
				name: "codex-medium",
				requiredProviders: ["provider-a"],
				modelMapping: { architect: "provider-a/architect" },
				source: "user",
			},
		];
		const settings = Settings.isolated();
		settings.getProject = ((path: string) =>
			path === "modelProfile.default" ? "codex-standard" : undefined) as typeof settings.getProject;

		expect(resolveProjectModelProfileShadow(settings, fakeRegistry({ profiles }))).toEqual({
			profileName: "codex-medium",
			targetIds: ["architect"],
		});
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
	test("builtin codex-eco executor selector clamps below-catalog effort up to the model minimum", async () => {
		const registry = fakeRegistry({ profiles: [...BUILTIN_MODEL_PROFILES] });
		const catalog = BUILTIN_MODEL_PROFILES.find(profile => profile.name === "codex-eco");
		expect(catalog?.modelMapping.executor).toBe("openai-codex/gpt-5.6-luna:low");

		const prepared = await prepareModelProfileActivation({
			session: fakeSession(),
			modelRegistry: registry,
			settings: Settings.isolated(),
			profileName: "codex-eco",
		});
		// The fake luna catalog entry has minLevel medium, so :low clamps up.
		expect(prepared.agentModelOverrides.executor).toBe("openai-codex/gpt-5.6-luna:medium");
		expect(prepared.agentModelOverrides.architect).toBe("openai-codex/gpt-5.6-sol:medium");
		expect(prepared.agentModelOverrides.planner).toBe("openai-codex/gpt-5.6-luna:medium");
		expect(prepared.agentModelOverrides.critic).toBe("openai-codex/gpt-5.6-luna:medium");
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

	test("switching profiles drops omitted assignments back to the pre-profile baseline", async () => {
		const session = fakeSession(model("provider-c", "default"));
		const settings = Settings.isolated();
		settings.set("modelRoles", { default: "provider-c/default:medium" });
		settings.set("task.agentModelOverrides", {
			architect: "configured/architect:low",
			critic: "configured/critic:high",
		});
		const registry = fakeRegistry({
			profiles: [
				{
					name: "profile-a",
					requiredProviders: ["provider-a", "provider-b"],
					modelMapping: {
						default: "provider-a/default:high",
						executor: "provider-b/executor",
						architect: "provider-a/architect",
					},
					source: "user",
				},
				{
					name: "profile-b",
					requiredProviders: ["provider-c"],
					modelMapping: {
						default: "provider-c/default:low",
						executor: "provider-c/executor",
					},
					source: "user",
				},
			],
		});

		await activateModelProfile({ session, modelRegistry: registry, settings, profileName: "profile-a" });
		expect(settings.get("task.agentModelOverrides").architect).toBe("provider-a/architect");

		await activateModelProfile({ session, modelRegistry: registry, settings, profileName: "profile-b" });

		expect(session.model?.provider).toBe("provider-c");
		expect(session.model?.id).toBe("default");
		expect(settings.get("task.agentModelOverrides")).toEqual({
			architect: "configured/architect:low",
			critic: "configured/critic:high",
			executor: "provider-c/executor",
		});
		expect(session.getActiveModelProfile()).toBe("profile-b");
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

	test("materialization persists only leaves changed from the loaded global baseline", async () => {
		const session = fakeSession();
		const settings = Settings.isolated();
		settings.set("task.agentModelOverrides", { critic: "configured/critic:high" });
		await activateModelProfile({ session, modelRegistry: fakeRegistry(), settings, profileName: "profile-a" });
		const persistedAgents: string[] = [];
		const originalSetAgentModelOverride = settings.setAgentModelOverride.bind(settings);
		settings.setAgentModelOverride = (agentName: string, selector: string) => {
			persistedAgents.push(agentName);
			originalSetAgentModelOverride(agentName, selector);
		};
		const originalSetAgentModelOverrideIfUnchanged = settings.setAgentModelOverrideIfUnchanged.bind(settings);
		settings.setAgentModelOverrideIfUnchanged = (
			agentName: string,
			expectedSelector: string | undefined,
			selector: string | undefined,
		) => {
			persistedAgents.push(agentName);
			originalSetAgentModelOverrideIfUnchanged(agentName, expectedSelector, selector);
		};

		materializeActiveModelProfileAssignment({
			session,
			settings,
			role: "executor",
			selector: "provider-c/executor:medium",
		});

		expect(persistedAgents).toEqual(["executor", "architect"]);
		expect(persistedAgents).not.toContain("critic");
	});
	test("materialization preserves pending explicit sibling and profile choices in the same Settings instance", async () => {
		const settings = Settings.isolated();
		const session = fakeSession();
		await activateModelProfile({ session, modelRegistry: fakeRegistry(), settings, profileName: "profile-a" });

		settings.setAgentModelOverride("architect", "provider-a/user-architect:medium");
		settings.set("modelProfile.default", "profile-b");
		expect(
			materializeActiveModelProfileAssignment({
				session,
				settings,
				role: "executor",
				selector: "provider-a/manual-executor:low",
			}),
		).toBe(true);

		expect(settings.get("task.agentModelOverrides")).toEqual({
			architect: "provider-a/user-architect:medium",
			executor: "provider-a/manual-executor:low",
		});
		expect(settings.get("modelProfile.default")).toBe("profile-b");
	});
	test("materialization preserves an already-flushed profile choice from the same Settings instance", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-profile-materialization-owner-"));
		resetSettingsForTest();
		try {
			const settings = await Settings.init({ agentDir: tempDir, cwd: tempDir });
			const session = fakeSession();
			await activateModelProfile({ session, modelRegistry: fakeRegistry(), settings, profileName: "profile-a" });

			settings.set("modelProfile.default", "profile-b");
			await settings.flushOrThrow();
			expect(
				materializeActiveModelProfileAssignment({
					session,
					settings,
					role: "executor",
					selector: "provider-a/manual-executor:low",
				}),
			).toBe(true);
			await settings.flushOrThrow();

			expect(settings.get("modelProfile.default")).toBe("profile-b");
			expect(settings.get("task.agentModelOverrides")).toEqual({
				architect: "provider-a/architect",
				executor: "provider-a/manual-executor:low",
			});
		} finally {
			resetSettingsForTest();
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});
	test("materializing one profile role preserves a later durable sibling assignment", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-profile-materialization-sibling-"));
		resetSettingsForTest();
		try {
			const settingsA = await Settings.init({ agentDir: tempDir, cwd: tempDir });
			const settingsB = await settingsA.cloneForCwd(tempDir);
			const session = fakeSession();

			await activateModelProfile({
				session,
				modelRegistry: fakeRegistry(),
				settings: settingsA,
				profileName: "profile-a",
			});
			settingsB.setAgentModelOverride("architect", "provider-a/user-architect:medium");
			settingsB.setAgentModelOverride("executor", "provider-a/external-executor:medium");
			settingsB.set("modelProfile.default", "profile-b");
			settingsB.setModelRole("default", "provider-a/external-default:medium");
			await settingsB.flushOrThrow();

			expect(
				materializeActiveModelProfileAssignment({
					session,
					settings: settingsA,
					role: "executor",
					selector: "provider-a/manual-executor:low",
				}),
			).toBe(true);
			await settingsA.flushOrThrow();
			expect(settingsA.get("task.agentModelOverrides")).toEqual({
				architect: "provider-a/user-architect:medium",
				executor: "provider-a/manual-executor:low",
			});
			expect(settingsA.get("modelRoles")).toEqual({
				default: "provider-a/external-default:medium",
			});
			expect(settingsA.get("modelProfile.default")).toBe("profile-b");

			resetSettingsForTest();
			const reopened = await Settings.init({ agentDir: tempDir, cwd: tempDir });
			expect(reopened.getGlobal("task.agentModelOverrides")).toEqual({
				architect: "provider-a/user-architect:medium",
				executor: "provider-a/manual-executor:low",
			});
			expect(reopened.getGlobal("modelProfile.default")).toBe("profile-b");
			expect(reopened.getGlobal("modelRoles")).toEqual({
				default: "provider-a/external-default:medium",
			});
		} finally {
			resetSettingsForTest();
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	test("failed profile detachment retains transition state for the next activation", async () => {
		const session = fakeSession();
		const settings = Settings.isolated();
		const profileA = fakeRegistry().getModelProfile("profile-a");
		if (!profileA) throw new Error("missing profile-a fixture");
		const registry = fakeRegistry({
			profiles: [
				profileA,
				{
					name: "profile-b",
					requiredProviders: ["provider-c"],
					modelMapping: {
						default: "provider-c/default:low",
						executor: "provider-c/executor",
					},
					source: "user",
				},
			],
		});
		await activateModelProfile({ session, modelRegistry: registry, settings, profileName: "profile-a" });
		const setActiveModelProfile = session.setActiveModelProfile.bind(session);
		session.setActiveModelProfile = (name: string | undefined) => {
			if (name === undefined) throw new Error("detach failed");
			setActiveModelProfile(name);
		};

		expect(() =>
			materializeActiveModelProfileAssignment({
				session,
				settings,
				role: "critic",
				selector: "provider-c/critic:low",
			}),
		).toThrow("detach failed");
		expect(session.getActiveModelProfile()).toBe("profile-a");

		session.setActiveModelProfile = setActiveModelProfile;
		await activateModelProfile({ session, modelRegistry: registry, settings, profileName: "profile-b" });

		expect(settings.get("task.agentModelOverrides")).toEqual({
			executor: "provider-c/executor",
		});
	});

	test("role-only materialization persists the active profile default, not a transient live model", async () => {
		const session = fakeSession(model("provider-c", "default"));
		const settings = Settings.isolated({
			modelRoles: { default: "configured/default:medium" },
			"task.agentModelOverrides": { critic: "configured/critic:high" },
		});
		await activateModelProfile({ session, modelRegistry: fakeRegistry(), settings, profileName: "profile-a" });

		session.model = model("provider-c", "architect");
		session.thinkingLevel = ThinkingLevel.Low;
		const materialized = materializeActiveModelProfileAssignment({
			session,
			settings,
			role: "executor",
			selector: "provider-c/executor:medium",
		});

		expect(materialized).toBe(true);
		expect(settings.getGlobal("modelRoles")).toEqual({
			default: "provider-a/default:high",
		});
		expect(settings.getGlobal("task.agentModelOverrides")).toEqual({
			architect: "provider-a/architect",
			critic: "configured/critic:high",
			executor: "provider-c/executor:medium",
		});
	});
	test("materialization uses an activation effort override for the active profile DEFAULT", async () => {
		const session = fakeSession();
		const settings = Settings.isolated();
		await activateModelProfile(
			{ session, modelRegistry: fakeRegistry(), settings, profileName: "profile-a" },
			{ thinkingLevelOverride: ThinkingLevel.Low },
		);

		expect(
			materializeActiveModelProfileAssignments({
				session,
				settings,
				assignments: { executor: "provider-c/executor:medium" },
			}),
		).toBe(true);
		expect(settings.getGlobal("modelRoles")).toEqual({
			default: "provider-a/default:low",
		});
	});
	test("role-only profile detach preserves the exact persisted DEFAULT selector", async () => {
		const profiles: ModelProfileDefinition[] = [
			{
				name: "role-only",
				requiredProviders: ["provider-b"],
				modelMapping: { executor: "provider-b/executor:low" },
				source: "user",
			},
		];
		const settings = Settings.isolated();
		settings.set("modelRoles", { default: "configured/resume:high" });
		const session = fakeSession(model("provider-c", "default"), "provider-c/resume");
		await activateModelProfile({
			session,
			modelRegistry: fakeRegistry({ profiles }),
			settings,
			profileName: "role-only",
		});

		expect(
			materializeActiveModelProfileAssignment({
				session,
				settings,
				role: "executor",
				selector: "provider-c/executor:medium",
			}),
		).toBe(true);
		expect(settings.getGlobal("modelRoles")).toEqual({
			default: "configured/resume:high",
		});
	});

	test("suffixless profile DEFAULT remains inherited when detached", async () => {
		const profiles: ModelProfileDefinition[] = [
			{
				name: "inherits-effort",
				requiredProviders: ["provider-a"],
				modelMapping: {
					default: "provider-a/default",
					executor: "provider-b/executor:low",
				},
				source: "user",
			},
		];
		const settings = Settings.isolated({ defaultThinkingLevel: ThinkingLevel.High });
		const session = fakeSession();
		await activateModelProfile(
			{
				session,
				modelRegistry: fakeRegistry({ profiles }),
				settings,
				profileName: "inherits-effort",
			},
			{ thinkingLevelOverride: ThinkingLevel.High },
		);

		expect(
			materializeActiveModelProfileAssignment({
				session,
				settings,
				role: "executor",
				selector: "provider-c/executor:medium",
			}),
		).toBe(true);
		expect(settings.getGlobal("modelRoles")).toEqual({
			default: "provider-a/default",
		});
		expect(settings.get("defaultThinkingLevel")).toBe(ThinkingLevel.High);
	});

	test("detached sessions do not re-materialize a still-configured project default", async () => {
		const session = fakeSession();
		const settings = Settings.isolated();
		settings.set("modelProfile.default", "profile-a");
		await activateModelProfile({ session, modelRegistry: fakeRegistry(), settings, profileName: "profile-a" });
		expect(
			materializeActiveModelProfileAssignment({
				session,
				settings,
				role: "executor",
				selector: "provider-c/executor:medium",
			}),
		).toBe(true);

		settings.override("modelProfile.default", "profile-a");
		expect(
			materializeActiveModelProfileAssignment({
				session,
				settings,
				role: "critic",
				selector: "provider-c/architect:low",
			}),
		).toBe(false);
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

	test("switching profiles preserves an explicit role clear instead of resurrecting the saved baseline", async () => {
		const profiles: ModelProfileDefinition[] = [
			{
				name: "profile-a",
				requiredProviders: ["provider-a"],
				modelMapping: { critic: "provider-a/architect" },
				source: "user",
			},
			{
				name: "profile-b",
				requiredProviders: ["provider-b"],
				modelMapping: { executor: "provider-b/executor" },
				source: "user",
			},
		];
		const settings = Settings.isolated();
		settings.setAgentModelOverride("critic", "user/critic");
		settings.override("task.agentModelOverrides", { critic: "user/critic" });
		const session = fakeSession();

		await activateModelProfile({
			session,
			modelRegistry: fakeRegistry({ profiles }),
			settings,
			profileName: "profile-a",
		});
		settings.clearAgentModelOverride("critic");
		await activateModelProfile({
			session,
			modelRegistry: fakeRegistry({ profiles }),
			settings,
			profileName: "profile-b",
		});

		expect(settings.get("task.agentModelOverrides")).toEqual({ executor: "provider-b/executor" });
		expect(settings.getGlobal("task.agentModelOverrides")).toEqual({});
	});

	test("materializing one role does not restore another profile role that the user cleared", async () => {
		const profiles: ModelProfileDefinition[] = [
			{
				name: "profile-a",
				requiredProviders: ["provider-a", "provider-b"],
				modelMapping: {
					architect: "provider-a/architect",
					executor: "provider-b/executor",
				},
				source: "user",
			},
		];
		const settings = Settings.isolated();
		const session = fakeSession();
		await activateModelProfile({
			session,
			modelRegistry: fakeRegistry({ profiles }),
			settings,
			profileName: "profile-a",
		});

		settings.clearAgentModelOverride("architect");
		materializeActiveModelProfileAssignment({
			session,
			settings,
			role: "executor",
			selector: "provider-c/executor:low",
		});
		settings.clearOverride("task.agentModelOverrides");

		expect(settings.getGlobal("task.agentModelOverrides")).toEqual({
			executor: "provider-c/executor:low",
		});
	});

	test("failed persisted profile switch detaches to baseline and retries without omitted roles", async () => {
		const profiles: ModelProfileDefinition[] = [
			{
				name: "profile-a",
				requiredProviders: ["provider-a"],
				modelMapping: { architect: "provider-a/architect" },
				source: "user",
			},
			{
				name: "profile-b",
				requiredProviders: ["provider-b"],
				modelMapping: { executor: "provider-b/executor" },
				source: "user",
			},
		];
		const registry = fakeRegistry({ profiles });
		const settings = Settings.isolated();
		const session = fakeSession();
		await activateModelProfile(
			{ session, modelRegistry: registry, settings, profileName: "profile-a" },
			{ persistDefault: true },
		);
		const durableFlush = settings.flushOrThrow.bind(settings);
		let failOnce = true;
		settings.flushOrThrow = async () => {
			if (failOnce) {
				failOnce = false;
				throw new Error("flush failed");
			}
			await durableFlush();
		};

		await expect(
			activateModelProfile(
				{ session, modelRegistry: registry, settings, profileName: "profile-b" },
				{ persistDefault: true },
			),
		).rejects.toThrow("flush failed");
		expect(session.getActiveModelProfile()).toBeUndefined();
		expect(settings.get("task.agentModelOverrides")).toEqual({});

		await activateModelProfile(
			{ session, modelRegistry: registry, settings, profileName: "profile-b" },
			{ persistDefault: true },
		);
		expect(session.getActiveModelProfile()).toBe("profile-b");
		expect(settings.get("task.agentModelOverrides")).toEqual({ executor: "provider-b/executor" });
		expect(settings.get("task.agentModelOverrides").architect).toBeUndefined();
	});

	test("role-only switching preserves the pre-profile resume default and configured effort", async () => {
		const transientModel = model("provider-c", "default");
		const profiles: ModelProfileDefinition[] = [
			{
				name: "profile-a",
				requiredProviders: ["provider-a"],
				modelMapping: { default: "provider-a/default:high" },
				source: "user",
			},
			{
				name: "role-only-b",
				requiredProviders: ["provider-b"],
				modelMapping: { executor: "provider-b/executor:low" },
				source: "user",
			},
		];
		const settings = Settings.isolated();
		settings.set("defaultThinkingLevel", ThinkingLevel.Medium);
		const session = fakeSession(transientModel, "provider-a/resume");
		session.thinkingLevel = ThinkingLevel.XHigh;
		const registry = fakeRegistry({ profiles });

		await activateModelProfile({ session, modelRegistry: registry, settings, profileName: "profile-a" });
		await activateModelProfile(
			{ session, modelRegistry: registry, settings, profileName: "role-only-b" },
			{ persistDefault: true },
		);

		expect(session.model).toBe(transientModel);
		expect(session.thinkingLevel).toBe(ThinkingLevel.XHigh);
		expect(session.getSessionDefaultModelSelector()).toBe("provider-a/resume");
		expect(settings.getGlobal("defaultThinkingLevel")).toBe(ThinkingLevel.Medium);
	});

	test("--default persists the profile while retaining inherited role defaults", async () => {
		const session = fakeSession();
		const settings = Settings.isolated();
		settings.set("modelRoles", { default: "configured/default" });
		settings.set("task.agentModelOverrides", { critic: "configured/critic" });
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

		expect(setCalls).toEqual(["defaultThinkingLevel", "modelProfile.default"]);
		expect(settings.getGlobal("modelRoles")).toEqual({ default: "configured/default" });
		expect(settings.getGlobal("task.agentModelOverrides")).toEqual({ critic: "configured/critic" });
		expect(settings.get("defaultThinkingLevel")).toBe(ThinkingLevel.High);
		expect(settings.get("modelProfile.default")).toBe("profile-a");
		expect(flushCount).toBe(1);
		expect(session.getActiveModelProfile()).toBe("profile-a");
	});

	test("role-only profile effort remains consistent after durable restart", async () => {
		const baselineModel = model("openai-codex", "gpt-5.6-sol", {
			mode: "effort",
			minLevel: ThinkingLevel.Low,
			maxLevel: ThinkingLevel.Max,
		});
		const profiles: ModelProfileDefinition[] = [
			{
				name: "profile-a",
				requiredProviders: ["openai-codex"],
				modelMapping: { default: "openai-codex/gpt-5.6-sol:xhigh" },
				source: "user",
			},
			{
				name: "role-only-b",
				requiredProviders: ["openai-codex"],
				modelMapping: { executor: "openai-codex/gpt-5.6-terra:low" },
				source: "user",
			},
		];
		const registry = fakeRegistry({ profiles });
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-role-only-profile-"));
		try {
			const session = fakeSession(baselineModel);
			const settings = await Settings.init({ agentDir: tempDir, cwd: tempDir });
			settings.set("defaultThinkingLevel", ThinkingLevel.Low);
			await settings.flushOrThrow();

			await activateModelProfile(
				{ session, modelRegistry: registry, settings, profileName: "profile-a" },
				{ persistDefault: true },
			);
			expect(session.thinkingLevel).toBe(ThinkingLevel.XHigh);

			await activateModelProfile(
				{ session, modelRegistry: registry, settings, profileName: "role-only-b" },
				{ persistDefault: true },
			);
			expect(session.model).toBe(baselineModel);
			expect(session.thinkingLevel).toBe(ThinkingLevel.Low);
			expect(settings.getGlobal("defaultThinkingLevel")).toBe(ThinkingLevel.Low);
			expect(settings.getGlobal("modelProfile.default")).toBe("role-only-b");

			resetSettingsForTest();
			const restartedSettings = await Settings.init({ agentDir: tempDir, cwd: tempDir });
			const restartedProfile = restartedSettings.getGlobal("modelProfile.default");
			if (!restartedProfile) throw new Error("Expected persisted model profile");
			const restartedSession = fakeSession(baselineModel);
			restartedSession.thinkingLevel = restartedSettings.get("defaultThinkingLevel");
			await activateModelProfile(
				{
					session: restartedSession,
					modelRegistry: registry,
					settings: restartedSettings,
					profileName: restartedProfile,
				},
				{ thinkingLevelOverride: restartedSettings.get("defaultThinkingLevel") },
			);

			expect(restartedProfile).toBe("role-only-b");
			expect(restartedSettings.getGlobal("defaultThinkingLevel")).toBe(ThinkingLevel.Low);
			expect(restartedSession.model).toBe(baselineModel);
			expect(restartedSession.thinkingLevel).toBe(ThinkingLevel.Low);
			expect(restartedSession.getActiveModelProfile()).toBe("role-only-b");
		} finally {
			resetSettingsForTest();
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});
	test("an effort-less profile switch applies the configured default after a non-reasoning session and survives restart", async () => {
		const profiles: ModelProfileDefinition[] = [
			{
				name: "implicit-effort",
				requiredProviders: ["openai-codex"],
				modelMapping: { default: "openai-codex/gpt-5.6-sol" },
				source: "user",
			},
		];
		const registry = fakeRegistry({ profiles });
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-implicit-profile-effort-"));
		try {
			const session = fakeSession(model("provider-c", "non-reasoning"));
			session.thinkingLevel = undefined;
			const settings = await Settings.init({ agentDir: tempDir, cwd: tempDir });
			settings.set("defaultThinkingLevel", ThinkingLevel.High);
			await settings.flushOrThrow();

			await activateModelProfile(
				{ session, modelRegistry: registry, settings, profileName: "implicit-effort" },
				{ persistDefault: true },
			);

			expect(session.model?.id).toBe("gpt-5.6-sol");
			expect(session.thinkingLevel as ThinkingLevel | undefined).toBe(ThinkingLevel.High);
			expect(settings.getGlobal("defaultThinkingLevel")).toBe(ThinkingLevel.High);
			expect(settings.getGlobal("modelProfile.default")).toBe("implicit-effort");

			resetSettingsForTest();
			const restartedSettings = await Settings.init({ agentDir: tempDir, cwd: tempDir });
			const restartedProfile = restartedSettings.getGlobal("modelProfile.default");
			if (!restartedProfile) throw new Error("Expected persisted model profile");
			const restartedSession = fakeSession(model("provider-c", "non-reasoning"));
			restartedSession.thinkingLevel = undefined;

			await activateModelProfile(
				{
					session: restartedSession,
					modelRegistry: registry,
					settings: restartedSettings,
					profileName: restartedProfile,
				},
				{ thinkingLevelOverride: restartedSettings.get("defaultThinkingLevel") },
			);

			expect(restartedSettings.getGlobal("defaultThinkingLevel")).toBe(ThinkingLevel.High);
			expect(restartedSession.model?.id).toBe("gpt-5.6-sol");
			expect(restartedSession.thinkingLevel as ThinkingLevel | undefined).toBe(ThinkingLevel.High);
		} finally {
			resetSettingsForTest();
			await fs.rm(tempDir, { recursive: true, force: true });
		}
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

	test("rolls back when setModelTemporary mutates before rejecting", async () => {
		const initialModel = model("provider-c", "default");
		const session = fakeSession(initialModel, "provider-c/resume");
		session.thinkingLevel = ThinkingLevel.Low;
		const originalSetModelTemporary = session.setModelTemporary.bind(session);
		let rejectAfterMutation = true;
		session.setModelTemporary = async (next, thinkingLevel, options) => {
			await originalSetModelTemporary(next, thinkingLevel, options);
			if (rejectAfterMutation) {
				rejectAfterMutation = false;
				throw new Error("prompt refresh failed");
			}
		};

		await expect(
			activateModelProfile({
				session,
				modelRegistry: fakeRegistry(),
				settings: Settings.isolated(),
				profileName: "profile-a",
			}),
		).rejects.toThrow("prompt refresh failed");

		expect(session.model).toBe(initialModel);
		expect(session.thinkingLevel).toBe(ThinkingLevel.Low);
		expect(session.getSessionDefaultModelSelector()).toBe("provider-c/resume");
		expect(session.getActiveModelProfile()).toBeUndefined();
	});
	test("detaches an ambiguous persisted activation without stale compensation", async () => {
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
		settings.flushOrThrow = async () => {
			throw new Error("flush failed");
		};

		await expect(applyPreparedModelProfileActivation(prepared, { persistDefault: true })).rejects.toThrow(
			"flush failed",
		);

		expect(session.model?.id).toBe("initial");
		expect(session.thinkingLevel).toBe(ThinkingLevel.Low);
		expect(settings.get("task.agentModelOverrides")).toEqual({ executor: "provider-a/original" });
		expect(settings.get("modelProfile.default")).toBe("profile-a");
		expect(settings.getGlobal("defaultThinkingLevel")).toBe(ThinkingLevel.High);
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
	return {
		model: undefined,
		thinkingLevel: ThinkingLevel.Medium,
		sessionId: "test-session",
		setModelTemporary: async () => {},
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
