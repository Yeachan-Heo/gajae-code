import { describe, expect, it, test, vi } from "bun:test";
import { Agent, type AgentTool, ThinkingLevel } from "@gajae-code/agent-core";
import * as compactionModule from "@gajae-code/agent-core/compaction";

import type { Model } from "@gajae-code/ai";
import { hookFetch, TempDir } from "@gajae-code/utils";
import { z } from "zod";
import {
	activateModelProfile,
	applyModelProfileRuntimeBindings,
	applyPreparedModelProfileActivation,
	formatModelProfileCredentialError,
	ModelProfileCredentialError,
	ModelProfileUnknownProviderError,
	materializeActiveModelProfileAssignment,
	materializeActiveModelProfileAssignments,
	materializeModelProfileForDeletion,
	prepareModelProfileActivation,
	publishPreparedModelProfileActivation,
	resolveMaterializationProfileIdentity,
	resolveMaterializedDefaultSelector,
	resolveModelProfileDefaultChain,
	restoreMaterializedModelProfileForDeletion,
	rewriteSelectorForProxy,
	rollbackPreparedModelProfileActivation,
} from "../src/config/model-profile-activation";

import {
	commitDurableModelProfileOwnership,
	readDurableModelProfileOwnership,
	readDurableModelProfileOwnershipFromRaw,
} from "../src/config/model-profile-ownership";
import type { ModelProfileDefinition } from "../src/config/model-profiles";
import { BUILTIN_MODEL_PROFILES, mergeModelProfiles } from "../src/config/model-profiles";
import { kNoAuth, ModelRegistry } from "../src/config/model-registry";
import { Settings, type SettingsAtomicPatch } from "../src/config/settings";
import {
	AgentSession,
	type AgentSessionConfig,
	type AgentSessionProfileInstalledOverrideState,
	type DefaultFallbackRuntimeState,
	type PreparedProfileModelSelection,
} from "../src/session/agent-session";
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

function seededRandom(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		return (state >>> 0) / 0x1_0000_0000;
	};
}

function generatedSelector(random: () => number, label: string, index: number): string {
	const provider = Math.floor(random() * 5);
	const modelId = Math.floor(random() * 1000);
	return `provider-${provider}/${label}-${index}-${modelId}`;
}

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
			model("openai-codex", "gpt-6-sol", {
				mode: "effort",
				minLevel: ThinkingLevel.Low,
				maxLevel: ThinkingLevel.Max,
			}),
			model("openai-codex", "gpt-6.1-sol", {
				mode: "effort",
				minLevel: ThinkingLevel.Low,
				maxLevel: ThinkingLevel.Max,
			}),
			model("openai-codex", "gpt-5.6-terra", {
				mode: "effort",
				minLevel: ThinkingLevel.Low,
				maxLevel: ThinkingLevel.Max,
			}),
			model("openai-codex", "gpt-6-luna", {
				mode: "effort",
				minLevel: ThinkingLevel.Low,
				maxLevel: ThinkingLevel.Max,
			}),
			model("openai-codex", "gpt-5.3-codex-spark"),
			model("anthropic", "claude-opus-5-5", {
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
			model("anthropic", "claude-sonnet-5-5"),
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
		isSelectorCircuitOpen: () => false,
	};
}

function fakeSession(initial = model("provider-a", "initial")) {
	let activeModelProfile: string | undefined;
	let activatedModelProfile: string | undefined;
	return {
		model: initial as Model | undefined,
		thinkingLevel: ThinkingLevel.Low as ThinkingLevel | undefined,
		sessionId: "session-1",
		modelRegistry: undefined as ModelRegistry | undefined,
		disposed: false,
		get sessionLifecycle() {
			return Object.freeze({ generation: 0, transitioning: false, disposed: this.disposed });
		},
		async dispose() {
			this.disposed = true;
		},
		async prepareModelSelectionForProfileActivation(
			next: Model,
			thinkingLevel?: ThinkingLevel,
			signal?: AbortSignal,
		): Promise<PreparedProfileModelSelection> {
			return {
				sessionId: this.sessionId,
				model: next,
				thinkingLevel,
				committedThinkingLevel: thinkingLevel,
				previousModel: this.model,
				previousThinkingLevel: this.thinkingLevel,
				previousThinkingLevelMutationRevision: 0,
				previousEditMode: "hashline",
				signal,
			};
		},
		commitPreparedProfileModelSelection(selection: PreparedProfileModelSelection) {
			selection.signal?.throwIfAborted();
			if (this.model !== selection.previousModel || this.thinkingLevel !== selection.previousThinkingLevel)
				throw new Error("Session changed while publishing profile");
			this.model = selection.model;
			this.thinkingLevel = selection.committedThinkingLevel;
		},
		setThinkingLevel(level: ThinkingLevel | undefined) {
			this.thinkingLevel = level;
		},
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
		async setModelTemporary(
			next: Model,
			thinkingLevel?: ThinkingLevel,
			options?: { shouldMutate?: () => boolean; onMutationStarted?: () => void },
		) {
			if (options?.shouldMutate && !options.shouldMutate()) return;
			options?.onMutationStarted?.();
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
		setActiveModelProfile(name: string | undefined, activatedByThisProcess = false) {
			activeModelProfile = name;
			activatedModelProfile = activatedByThisProcess ? name : undefined;
		},
		getActiveModelProfile() {
			return activeModelProfile;
		},
		getActivatedModelProfile() {
			return activatedModelProfile === activeModelProfile ? activeModelProfile : undefined;
		},
	};
}

function rejectProfileRuntimePublication(settings: Settings, onReject?: () => void) {
	const override = settings.override.bind(settings);
	return vi.spyOn(settings, "override").mockImplementation((key, value) => {
		if (key === "task.agentModelOverrides") {
			onReject?.();
			throw new Error("runtime publication failed");
		}
		return override(key, value);
	});
}

function controlProfileFixture(
	settings = Settings.isolated({ "compaction.enabled": false }),
	options: Pick<AgentSessionConfig, "rebuildSystemPrompt"> & { tools?: AgentTool[] } = {},
) {
	const tempDir = TempDir.createSync("@gjc-profile-control-");
	const manager = SessionManager.create(tempDir.path(), tempDir.path());
	const base = fakeRegistry({
		profiles: [
			...fakeRegistry().getModelProfiles().values(),
			{
				name: "profile-b",
				requiredProviders: ["provider-c"],
				modelMapping: { default: "provider-c/default", executor: "provider-c/executor" },
				source: "user",
			},
			{
				name: "roles-only",
				requiredProviders: ["provider-b"],
				modelMapping: { executor: "provider-b/executor" },
				source: "user",
			},
		],
	});
	const registry = {
		...base,
		getAvailable: () => base.getAll(),
		getApiKey: async () => kNoAuth,
		withConsumerLease: async <T>(body: () => T | Promise<T>): Promise<T> => await body(),
	};
	const initial = base.getAll().find(candidate => candidate.provider === "openai-codex" && candidate.id === "gpt-5.5");
	if (!initial) throw new Error("Expected reasoning-capable fixture model");
	const tools = options.tools ?? [];
	const session = new AgentSession({
		agent: new Agent({ initialState: { model: initial, systemPrompt: [], tools, messages: [] } }),
		sessionManager: manager,
		settings,
		modelRegistry: registry as unknown as ModelRegistry,
		toolRegistry: new Map(tools.map(tool => [tool.name, tool])),
		rebuildSystemPrompt: options.rebuildSystemPrompt,
	});
	return {
		session,
		manager,
		settings,
		registry,
		async dispose() {
			await session.dispose();
			await settings.close();
			tempDir.removeSync();
		},
	};
}

function captureControlProfileState(session: AgentSession, settings: Settings) {
	return {
		model: session.model,
		thinking: session.thinkingLevel,
		chain: session.getConfiguredModelChainState("default"),
		fallback: session.getDefaultFallbackRuntimeState(),
		resumeDefault: session.getSessionDefaultModelSelector(),
		active: session.getActiveModelProfile(),
		activated: session.getActivatedModelProfile(),
		modelRoles: structuredClone(settings.getOverride("modelRoles")),
		agentOverrides: structuredClone(settings.getOverride("task.agentModelOverrides")),
		installed: session.getProfileInstalledOverrideState(),
	};
}

describe("model profile activation", () => {
	test("handoff lifecycle authority ignores notifications and fences preparation, committed cleanup, and disposal", async () => {
		const tempDir = TempDir.createSync("@gjc-session-lifecycle-");
		const manager = SessionManager.create(tempDir.path(), tempDir.path());
		const settings = Settings.isolated({ "compaction.enabled": false });
		const initialModel = model("provider-c", "default");
		const registry = { ...fakeRegistry(), getApiKey: async () => kNoAuth };
		const session = new AgentSession({
			agent: new Agent({ initialState: { model: initialModel, systemPrompt: [], tools: [], messages: [] } }),
			sessionManager: manager,
			settings,
			modelRegistry: registry as unknown as ModelRegistry,
		});
		const readLifecycle = () => session.sessionLifecycle;
		const generated = Promise.withResolvers<string>();
		const generationEntered = Promise.withResolvers<void>();
		const cleanupEntered = Promise.withResolvers<void>();
		const releaseCleanup = Promise.withResolvers<void>();
		const generate = vi.spyOn(compactionModule, "generateHandoff").mockImplementation(async () => {
			generationEntered.resolve();
			return generated.promise;
		});
		const unregisterCleanup = session.registerToolSessionTransitionCleanup(async () => {
			cleanupEntered.resolve();
			await releaseCleanup.promise;
		});
		const identityNotice = vi.fn();
		const unsubscribe = session.subscribeSessionIdentityChanges(identityNotice);
		let handoff: Promise<unknown> | undefined;
		try {
			manager.appendMessage({ role: "user", content: "First context", timestamp: 1 });
			manager.appendMessage({ role: "user", content: "Second context", timestamp: 2 });
			const originalId = session.sessionId;
			const initial = readLifecycle();
			expect(Object.isFrozen(initial)).toBe(true);
			expect(Reflect.set(initial, "generation", initial.generation + 100)).toBe(false);
			await session.notifySessionIdentityChanged();
			await session.notifySessionIdentityChanged();
			expect(identityNotice).toHaveBeenCalledTimes(2);
			expect(readLifecycle()).toEqual(initial);

			const cancelled = new AbortController();
			cancelled.abort();
			await expect(session.handoff(undefined, { signal: cancelled.signal })).rejects.toThrow("Handoff cancelled");
			expect(generate).not.toHaveBeenCalled();
			expect(readLifecycle()).toEqual(initial);

			handoff = session.handoff();
			void handoff.catch(() => undefined);
			expect(readLifecycle()).toEqual({ ...initial, transitioning: true });
			await Promise.race([
				generationEntered.promise,
				handoff.then(() => {
					throw new Error("Handoff completed without reaching generation");
				}),
			]);
			expect(session.sessionId).toBe(originalId);
			expect(readLifecycle()).toEqual({ ...initial, transitioning: true });
			generated.resolve("## Goal\nContinue without a provider turn");
			await Promise.race([
				cleanupEntered.promise,
				handoff.then(() => {
					throw new Error("Handoff completed without reaching committed cleanup");
				}),
			]);
			expect(session.sessionId).not.toBe(originalId);
			expect(readLifecycle()).toEqual({
				generation: initial.generation + 1,
				transitioning: true,
				disposed: false,
			});
			releaseCleanup.resolve();
			await expect(handoff).resolves.toMatchObject({ document: "## Goal\nContinue without a provider turn" });
			const completed = readLifecycle();
			expect(completed).toEqual({ generation: initial.generation + 1, transitioning: false, disposed: false });
			expect(initial.generation).toBe(completed.generation - 1);
			expect(initial.transitioning).toBe(false);
			await session.notifySessionIdentityChanged();
			expect(readLifecycle()).toEqual(completed);

			const clear = session.clearContext();
			expect(readLifecycle().transitioning).toBe(true);
			await expect(clear).resolves.toBe(true);
			expect(readLifecycle()).toEqual({
				generation: completed.generation + 1,
				transitioning: false,
				disposed: false,
			});
			const beforeDisposal = readLifecycle();
			const disposal = session.dispose();
			expect(readLifecycle()).toEqual({ ...beforeDisposal, disposed: true });
			await disposal;
			expect(readLifecycle()).toEqual({ ...beforeDisposal, disposed: true });
		} finally {
			generated.resolve("## Goal\nContinue without a provider turn");
			releaseCleanup.resolve();
			await handoff?.catch(() => undefined);
			unregisterCleanup();
			unsubscribe();
			generate.mockRestore();
			await session.dispose();
			await settings.close();
			tempDir.removeSync();
		}
	});

	test("trusted MCP control admission excludes competing transitions and reentry without advancing lifecycle generation", async () => {
		const fixture = controlProfileFixture();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const generation = fixture.session.sessionLifecycle.generation;
		let operation: Promise<string> | undefined;
		try {
			operation = fixture.session.withMcpControlAdmission(generation, async signal => {
				expect(signal.aborted).toBe(false);
				expect(fixture.session.sessionLifecycle).toEqual({ generation, transitioning: true, disposed: false });
				entered.resolve();
				await expect(fixture.session.withMcpControlAdmission(generation, async () => "nested")).rejects.toThrow();
				await release.promise;
				return "applied";
			});
			await entered.promise;
			expect(() => fixture.session.newSession()).toThrow("mcp-control");
			await expect(fixture.session.withMcpControlAdmission(generation, async () => "competing")).rejects.toThrow();
			release.resolve();
			await expect(operation).resolves.toBe("applied");
			expect(fixture.session.sessionLifecycle).toEqual({ generation, transitioning: false, disposed: false });
		} finally {
			release.resolve();
			await operation?.catch(() => undefined);
			await fixture.dispose();
		}
	});

	test("trusted MCP admission rejects stale identity before invoking its callback", async () => {
		const fixture = controlProfileFixture();
		const callback = vi.fn(async () => "must not run");
		try {
			const generation = fixture.session.sessionLifecycle.generation;
			expect(await fixture.session.clearContext()).toBe(true);
			await expect(fixture.session.withMcpControlAdmission(generation, callback)).rejects.toMatchObject({
				code: "resource_gone",
			});
			expect(callback).not.toHaveBeenCalled();
			const currentGeneration = fixture.session.sessionLifecycle.generation;
			const admitted = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const lease = vi.spyOn(fixture.registry, "withConsumerLease").mockImplementationOnce(async body => {
				admitted.resolve();
				await release.promise;
				return await body();
			});
			const operation = fixture.session.withMcpControlAdmission(currentGeneration, callback);
			void operation.catch(() => undefined);
			try {
				await admitted.promise;
				await fixture.manager.newSession();
				release.resolve();
				await expect(operation).rejects.toMatchObject({ code: "resource_gone" });
				expect(callback).not.toHaveBeenCalled();
			} finally {
				release.resolve();
				await operation.catch(() => undefined);
				lease.mockRestore();
			}
		} finally {
			await fixture.dispose();
		}
	});

	for (const cancellation of ["abort", "dispose"] as const) {
		test(`trusted MCP admission propagates ${cancellation} without waiting on its own held lease`, async () => {
			const fixture = controlProfileFixture();
			const entered = Promise.withResolvers<AbortSignal>();
			const cancelled = Promise.withResolvers<void>();
			let operation: Promise<void> | undefined;
			let disposal: Promise<void> | undefined;
			try {
				const generation = fixture.session.sessionLifecycle.generation;
				operation = fixture.session.withMcpControlAdmission(generation, async signal => {
					signal.addEventListener("abort", () => cancelled.resolve(), { once: true });
					entered.resolve(signal);
					await cancelled.promise;
					signal.throwIfAborted();
				});
				void operation.catch(() => undefined);
				const signal = await entered.promise;
				if (cancellation === "abort") await fixture.session.abort();
				else {
					disposal = fixture.session.dispose();
					void disposal.catch(() => undefined);
				}
				expect(signal.aborted).toBe(true);
				await expect(operation).rejects.toBeDefined();
				await disposal;
				expect(fixture.session.sessionLifecycle.generation).toBe(generation);
				expect(fixture.session.sessionLifecycle.transitioning).toBe(false);
			} finally {
				cancelled.resolve();
				await operation?.catch(() => undefined);
				await disposal;
				await fixture.dispose();
			}
		});
	}

	test("reload-compatible model preparation never probes live credentials while persistent activation still validates them before CAS", async () => {
		const fixture = controlProfileFixture();
		const failure = new Error("held or refreshable live credential");
		const probe = vi.spyOn(fixture.registry, "getApiKey").mockRejectedValue(failure);
		const commit = vi.spyOn(fixture.settings, "commitAtomicBatchWithCurrent");
		const originalModel = fixture.session.model;
		const originalThinking = fixture.session.thinkingLevel;
		if (!originalModel) throw new Error("Expected fixture model");
		try {
			const prepared = await fixture.session.prepareModelSelectionForProfileActivation(
				originalModel,
				originalThinking,
			);
			expect(prepared).toMatchObject({ model: originalModel, previousModel: originalModel });
			expect(probe).not.toHaveBeenCalled();
			await expect(
				fixture.session.setDefaultModelProfileForControl("profile-a", { persistDefault: true }),
			).rejects.toBe(failure);
			expect(probe).toHaveBeenCalledTimes(1);
			expect(commit).not.toHaveBeenCalled();
			expect(fixture.session.model).toBe(originalModel);
			expect(fixture.session.thinkingLevel).toBe(originalThinking);
			expect(readDurableModelProfileOwnership(fixture.settings)).toMatchObject({
				version: 0,
				marker: { kind: "inherit" },
			});
		} finally {
			probe.mockRestore();
			commit.mockRestore();
			await fixture.dispose();
		}
	});

	for (const predecessorSucceeds of [true, false]) {
		test(`queued persistent profiles use only a ${predecessorSucceeds ? "successful" : "failed"} local predecessor receipt`, async () => {
			const fixture = controlProfileFixture();
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const commit = fixture.settings.commitAtomicBatchWithCurrent.bind(fixture.settings);
			let commits = 0;
			const commitSpy = vi
				.spyOn(fixture.settings, "commitAtomicBatchWithCurrent")
				.mockImplementation(async build => {
					if (++commits === 1) {
						entered.resolve();
						await release.promise;
						if (!predecessorSucceeds) throw new Error("first commit rejected");
					}
					return commit(build);
				});
			let first: Promise<unknown> | undefined;
			let second: Promise<unknown> | undefined;
			try {
				first = fixture.session.setDefaultModelProfileForControl("profile-a", { persistDefault: true });
				void first.catch(() => undefined);
				await entered.promise;
				second = fixture.session.setDefaultModelProfileForControl("profile-b", { persistDefault: true });
				void second.catch(() => undefined);
				release.resolve();
				if (predecessorSucceeds) await expect(first).resolves.toEqual({ changed: true, id: "profile-a" });
				else await expect(first).rejects.toThrow("first commit rejected");
				await expect(second).resolves.toEqual({ changed: true, id: "profile-b" });
				expect(readDurableModelProfileOwnership(fixture.settings)).toEqual({
					schemaVersion: 1,
					version: predecessorSucceeds ? 2 : 1,
					marker: { kind: "profile", profile: "profile-b" },
				});
				expect(fixture.settings.getGlobal("modelProfile.default")).toBe("profile-b");
				expect(fixture.session.model).toMatchObject({ provider: "provider-c", id: "default" });
				expect(commits).toBe(2);
			} finally {
				release.resolve();
				await Promise.allSettled([first, second]);
				commitSpy.mockRestore();
				await fixture.dispose();
			}
		});
	}

	for (const conflict of ["ABA", "same-version marker change"] as const) {
		test(`persistent control rejects an observed-owner ${conflict} without refreshing its expected owner`, async () => {
			const fixture = controlProfileFixture();
			const observed = await commitDurableModelProfileOwnership(fixture.settings, {
				kind: "profile",
				profile: "profile-a",
			});
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const idle = vi.spyOn(fixture.session, "waitForIdle").mockImplementationOnce(async () => {
				entered.resolve();
				await release.promise;
			});
			let request: Promise<unknown> | undefined;
			try {
				const prior = fixture.session.model;
				request = fixture.session.setDefaultModelProfileForControl("profile-a", { persistDefault: true });
				void request.catch(() => undefined);
				await entered.promise;
				if (conflict === "ABA") {
					await commitDurableModelProfileOwnership(fixture.settings, { kind: "profile", profile: "profile-b" });
					await commitDurableModelProfileOwnership(fixture.settings, { kind: "profile", profile: "profile-a" });
				} else {
					await fixture.settings.commitAtomicBatch([
						{
							path: "modelProfile.ownership",
							op: "set",
							value: { ...observed, marker: { kind: "profile", profile: "profile-b" } },
						},
						{ path: "modelProfile.default", op: "set", value: "profile-b" },
					]);
				}
				const winner = readDurableModelProfileOwnership(fixture.settings);
				release.resolve();
				await expect(request).rejects.toMatchObject({
					code: "model_profile_ownership_conflict",
					expectedVersion: observed.version,
					actualVersion: winner.version,
				});
				expect(readDurableModelProfileOwnership(fixture.settings)).toEqual(winner);
				expect(fixture.session.model).toBe(prior);
				expect(fixture.settings.getOverride("task.agentModelOverrides")).toBeUndefined();
			} finally {
				release.resolve();
				await request?.catch(() => undefined);
				idle.mockRestore();
				await fixture.dispose();
			}
		});
	}

	test("same-name persistent activation still performs credential preflight and cannot infer success from its active marker", async () => {
		const fixture = controlProfileFixture();
		const owner = await commitDurableModelProfileOwnership(fixture.settings, {
			kind: "profile",
			profile: "profile-a",
		});
		fixture.session.setActiveModelProfile("profile-a", true);
		const probe = vi.spyOn(fixture.registry, "getApiKeyForProvider").mockResolvedValue(undefined);
		const commit = vi.spyOn(fixture.settings, "commitAtomicBatchWithCurrent");
		try {
			await expect(
				fixture.session.setDefaultModelProfileForControl("profile-a", { persistDefault: true }),
			).rejects.toBeInstanceOf(ModelProfileCredentialError);
			expect(commit).not.toHaveBeenCalled();
			expect(readDurableModelProfileOwnership(fixture.settings)).toEqual(owner);
		} finally {
			probe.mockRestore();
			commit.mockRestore();
			await fixture.dispose();
		}
	});

	test("committed publication failure retains durable ownership and actually fail-closes the requesting session", async () => {
		const fixture = controlProfileFixture();
		const failure = new Error("publication failed");
		const publish = vi.spyOn(fixture.session, "commitPreparedProfileModelSelection").mockImplementation(() => {
			throw failure;
		});
		try {
			await expect(
				fixture.session.setDefaultModelProfileForControl("profile-a", { persistDefault: true }),
			).rejects.toMatchObject({
				code: "model_profile_apply_committed",
				profileName: "profile-a",
				committedVersion: 1,
				cause: failure,
			});
			expect(readDurableModelProfileOwnership(fixture.settings)).toEqual({
				schemaVersion: 1,
				version: 1,
				marker: { kind: "profile", profile: "profile-a" },
			});
			expect(fixture.settings.getGlobal("modelProfile.default")).toBe("profile-a");
			expect(fixture.session.sessionLifecycle.disposed).toBe(true);
			await expect(
				fixture.session.setDefaultModelProfileForControl("profile-b", { persistDefault: true }),
			).rejects.toThrow();
			await fixture.session.awaitDisposeCompletion();
		} finally {
			publish.mockRestore();
			await fixture.dispose();
		}
	});

	test("a newer same-value thinking intent after commit is preserved and fail-closes instead of publishing the stale profile", async () => {
		const fixture = controlProfileFixture();
		const priorModel = fixture.session.model;
		const priorThinking = fixture.session.thinkingLevel;
		const commit = fixture.settings.commitAtomicBatchWithCurrent.bind(fixture.settings);
		const commitSpy = vi.spyOn(fixture.settings, "commitAtomicBatchWithCurrent").mockImplementation(async build => {
			const receipt = await commit(build);
			fixture.session.setThinkingLevel(priorThinking);
			return receipt;
		});
		try {
			await expect(
				fixture.session.setDefaultModelProfileForControl("profile-a", { persistDefault: true }),
			).rejects.toMatchObject({ code: "model_profile_apply_committed", committedVersion: 1 });
			expect(fixture.session.model).toBe(priorModel);
			expect(fixture.session.thinkingLevel).toBe(priorThinking);
			expect(fixture.session.getActiveModelProfile()).toBeUndefined();
			expect(readDurableModelProfileOwnership(fixture.settings)).toMatchObject({
				version: 1,
				marker: { kind: "profile", profile: "profile-a" },
			});
			expect(fixture.session.sessionLifecycle.disposed).toBe(true);
			await fixture.session.awaitDisposeCompletion();
		} finally {
			commitSpy.mockRestore();
			await fixture.dispose();
		}
	});

	for (const newerIntent of ["thinking", "concrete", "manual roles"] as const) {
		test(`locked profile validation preserves a newer ${newerIntent} choice without patches or compensation`, async () => {
			const fixture = controlProfileFixture();
			const before = readDurableModelProfileOwnership(fixture.settings);
			const commit = fixture.settings.commitAtomicBatchWithCurrent.bind(fixture.settings);
			const chosen = model("provider-c", "default");
			const commitSpy = vi
				.spyOn(fixture.settings, "commitAtomicBatchWithCurrent")
				.mockImplementation(async build => {
					if (newerIntent === "thinking") fixture.session.setThinkingLevel(ThinkingLevel.Medium);
					if (newerIntent === "concrete")
						await fixture.session.setModelTemporary(chosen, ThinkingLevel.Off, { cause: "user-selection" });
					if (newerIntent === "manual roles")
						fixture.settings.override("task.agentModelOverrides", { executor: "provider-c/executor" });
					return commit(build);
				});
			try {
				await expect(
					fixture.session.setDefaultModelProfileForControl("profile-a", { persistDefault: true }),
				).rejects.toThrow(/changed|supersed/i);
				expect(readDurableModelProfileOwnership(fixture.settings)).toEqual(before);
				expect(fixture.settings.getGlobal("modelProfile.default")).toBeUndefined();
				expect(fixture.session.getActiveModelProfile()).toBeUndefined();
				if (newerIntent === "thinking") expect(fixture.session.thinkingLevel).toBe(ThinkingLevel.Medium);
				if (newerIntent === "concrete") expect(fixture.session.model).toBe(chosen);
				if (newerIntent === "manual roles")
					expect(fixture.settings.getOverride("task.agentModelOverrides")).toEqual({
						executor: "provider-c/executor",
					});
				expect(fixture.session.sessionLifecycle.disposed).toBe(false);
			} finally {
				commitSpy.mockRestore();
				await fixture.dispose();
			}
		});
	}

	for (const cancellation of ["abort", "dispose"] as const) {
		test(`${cancellation} during profile credential preflight leaves ownership and runtime unmodified`, async () => {
			const fixture = controlProfileFixture();
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const getKey = fixture.registry.getApiKeyForProvider;
			const probe = vi.spyOn(fixture.registry, "getApiKeyForProvider").mockImplementation(async provider => {
				if (provider === "provider-a") {
					entered.resolve();
					await release.promise;
				}
				return getKey(provider);
			});
			const prior = fixture.session.model;
			const commit = vi.spyOn(fixture.settings, "commitAtomicBatchWithCurrent");
			let request: Promise<unknown> | undefined;
			let disposal: Promise<void> | undefined;
			try {
				request = fixture.session.setDefaultModelProfileForControl("profile-a", { persistDefault: true });
				void request.catch(() => undefined);
				await entered.promise;
				if (cancellation === "abort") await fixture.session.abort();
				else {
					disposal = fixture.session.dispose();
					void disposal.catch(() => undefined);
				}
				release.resolve();
				await expect(request).rejects.toThrow(/changed|supersed|abort/i);
				expect(fixture.session.model).toBe(prior);
				expect(readDurableModelProfileOwnership(fixture.settings)).toMatchObject({
					version: 0,
					marker: { kind: "inherit" },
				});
				expect(commit).not.toHaveBeenCalled();
			} finally {
				release.resolve();
				await request?.catch(() => undefined);
				await disposal;
				probe.mockRestore();
				commit.mockRestore();
				await fixture.dispose();
			}
		});
	}

	for (const profileName of ["profile-a", "roles-only"] as const) {
		test(`session-only ${profileName} callback failure restores the complete previous runtime publication`, async () => {
			const fixture = controlProfileFixture();
			const failure = new Error("after activation rejected");
			try {
				await fixture.session.setDefaultModelProfileForControl("roles-only");
				fixture.session.setThinkingLevel(ThinkingLevel.Low);
				fixture.session.setConfiguredModelChain(
					"default",
					["openai-codex/gpt-5.5:low", "provider-c/default"],
					"model_selection",
				);
				fixture.session.seedDefaultFallbackResolution(1, []);
				fixture.session.recordResumeDefaultModel("provider-c/default");
				fixture.settings.override("modelRoles", { critic: "provider-c/architect" });
				fixture.settings.override("task.agentModelOverrides", {
					...fixture.settings.get("task.agentModelOverrides"),
					planner: "provider-c/executor",
				});
				fixture.session.markProfileRoleOverrideManual("modelRoles", "critic");
				fixture.session.markProfileRoleOverrideManual("task.agentModelOverrides", "planner");
				const previous = captureControlProfileState(fixture.session, fixture.settings);
				const owner = readDurableModelProfileOwnership(fixture.settings);
				const afterActivation = vi.fn(() => {
					expect(fixture.session.getActiveModelProfile()).toBe(profileName);
					expect(fixture.session.getActivatedModelProfile()).toBe(profileName);
					expect(fixture.session.getConfiguredModelChainState("default")).toMatchObject({
						origin: "profile-activation",
						identity: profileName,
					});
					if (profileName === "profile-a") {
						expect(fixture.session.model).toMatchObject({ provider: "provider-a", id: "default" });
						expect(fixture.session.getSessionDefaultModelSelector()).toBe("provider-a/default");
					} else {
						expect(fixture.session.model).toBe(previous.model);
						expect(fixture.session.thinkingLevel).toBe(ThinkingLevel.High);
						expect(fixture.session.getSessionDefaultModelSelector()).toBe(previous.resumeDefault);
					}
					throw failure;
				});
				await expect(
					fixture.session.setDefaultModelProfileForControl(profileName, {
						thinkingLevelOverride: ThinkingLevel.High,
						onAfterActivation: afterActivation,
					}),
				).rejects.toBe(failure);
				expect(afterActivation).toHaveBeenCalledTimes(1);
				expect(fixture.session.model).toBe(previous.model);
				expect(captureControlProfileState(fixture.session, fixture.settings)).toEqual(previous);
				expect(readDurableModelProfileOwnership(fixture.settings)).toEqual(owner);
				expect(fixture.settings.getGlobal("modelProfile.default")).toBeUndefined();
				expect(fixture.session.sessionLifecycle.disposed).toBe(false);
			} finally {
				await fixture.dispose();
			}
		});

		test(`session-only ${profileName} callback rollback preserves a newer same-value thinking intent`, async () => {
			const fixture = controlProfileFixture();
			const failure = new Error("callback rejected after thinking choice");
			try {
				fixture.session.setThinkingLevel(ThinkingLevel.Low);
				fixture.session.setConfiguredModelChain("default", ["openai-codex/gpt-5.5:low"], "model_selection");
				fixture.session.recordResumeDefaultModel("provider-c/default");
				const previous = captureControlProfileState(fixture.session, fixture.settings);
				const newerThinking = profileName === "profile-a" ? undefined : ThinkingLevel.High;
				await expect(
					fixture.session.setDefaultModelProfileForControl(profileName, {
						thinkingLevelOverride: ThinkingLevel.High,
						onAfterActivation: () => {
							expect(fixture.session.thinkingLevel).toBe(newerThinking);
							fixture.session.setThinkingLevel(newerThinking);
							fixture.settings.set("modelRoles", { critic: "provider-c/architect" });
							throw failure;
						},
					}),
				).rejects.toBe(failure);
				expect(fixture.session.model).toBe(previous.model);
				expect(captureControlProfileState(fixture.session, fixture.settings)).toEqual({
					...previous,
					thinking: newerThinking,
				});
				expect(fixture.settings.getGlobal("modelRoles")).toEqual({ critic: "provider-c/architect" });
				expect(readDurableModelProfileOwnership(fixture.settings)).toMatchObject({
					version: 0,
					marker: { kind: "inherit" },
				});
			} finally {
				await fixture.dispose();
			}
		});

		test(`committed ${profileName} callback failure never compensates durable or runtime ownership`, async () => {
			const fixture = controlProfileFixture();
			const failure = new Error("committed callback rejected");
			const restore = vi.spyOn(fixture.session, "restoreModelSelectionForRollback");
			try {
				await expect(
					fixture.session.setDefaultModelProfileForControl(profileName, {
						persistDefault: true,
						thinkingLevelOverride: ThinkingLevel.High,
						onAfterActivation: () => {
							throw failure;
						},
					}),
				).rejects.toMatchObject({
					code: "model_profile_apply_committed",
					committedVersion: 1,
					cause: failure,
				});
				expect(restore).not.toHaveBeenCalled();
				expect(fixture.settings.getGlobal("modelProfile.default")).toBe(profileName);
				expect(readDurableModelProfileOwnership(fixture.settings)).toMatchObject({
					version: 1,
					marker: { kind: "profile", profile: profileName },
				});
				expect(fixture.session.getActiveModelProfile()).toBe(profileName);
				expect(fixture.session.getActivatedModelProfile()).toBe(profileName);
				expect(fixture.session.sessionLifecycle.disposed).toBe(true);
				await fixture.session.awaitDisposeCompletion();
			} finally {
				restore.mockRestore();
				await fixture.dispose();
			}
		});
	}

	for (const persistDefault of [false, true]) {
		for (const firstProfile of ["profile-a", "roles-only"] as const) {
			for (const interveningIntent of ["none", "thinking", "global roles"] as const) {
				test(`queued B after held ${persistDefault ? "persistent" : "session-only"} ${firstProfile} finish ${interveningIntent === "none" ? "accepts owned succession" : `rejects newer ${interveningIntent}`}`, async () => {
					const fixture = controlProfileFixture();
					const entered = Promise.withResolvers<void>();
					const release = Promise.withResolvers<void>();
					const sync = fixture.session.syncEagerDelegation.bind(fixture.session);
					const finish = vi.spyOn(fixture.session, "syncEagerDelegation").mockImplementationOnce(async () => {
						entered.resolve();
						await release.promise;
						await sync();
					});
					const beforeSecond = vi.fn();
					let first: Promise<unknown> | undefined;
					let second: Promise<unknown> | undefined;
					try {
						fixture.session.setThinkingLevel(ThinkingLevel.Low);
						first = fixture.session.setDefaultModelProfileForControl(firstProfile, {
							persistDefault,
							thinkingLevelOverride: ThinkingLevel.High,
						});
						void first.catch(() => undefined);
						// Both requests observe the same pre-publication durable owner.
						second = fixture.session.setDefaultModelProfileForControl("profile-b", {
							persistDefault: true,
							onBeforeActivation: beforeSecond,
						});
						void second.catch(() => undefined);
						await Promise.race([
							entered.promise,
							first.then(() => {
								throw new Error("Profile activation completed without reaching finish");
							}),
						]);
						expect(fixture.session.getActiveModelProfile()).toBe(firstProfile);
						expect(fixture.session.getActivatedModelProfile()).toBe(firstProfile);
						expect(fixture.session.thinkingLevel).toBe(
							firstProfile === "profile-a" ? undefined : ThinkingLevel.High,
						);
						expect(readDurableModelProfileOwnership(fixture.settings)).toMatchObject({
							version: persistDefault ? 1 : 0,
							marker: persistDefault ? { kind: "profile", profile: firstProfile } : { kind: "inherit" },
						});
						if (interveningIntent === "thinking") {
							// DEFAULT is non-reasoning, so this is deliberately same-value intent;
							// role-only keeps the reasoning model and changes the effective level.
							fixture.session.setThinkingLevel(
								firstProfile === "profile-a" ? undefined : ThinkingLevel.Medium,
							);
						}
						if (interveningIntent === "global roles") {
							await fixture.settings.commitAtomicBatch([
								{ path: "modelRoles", op: "set", value: { critic: "provider-c/architect" } },
							]);
						}
						const owned = readDurableModelProfileOwnership(fixture.settings);
						const newerRuntime = captureControlProfileState(fixture.session, fixture.settings);
						const thinkingRevision = fixture.session.getThinkingLevelMutationRevision();
						release.resolve();
						await expect(first).resolves.toEqual({ changed: true, id: firstProfile });
						if (interveningIntent === "none") {
							await expect(second).resolves.toEqual({ changed: true, id: "profile-b" });
							expect(beforeSecond).toHaveBeenCalledTimes(1);
							expect(fixture.session.model).toMatchObject({ provider: "provider-c", id: "default" });
							expect(readDurableModelProfileOwnership(fixture.settings)).toMatchObject({
								version: persistDefault ? 2 : 1,
								marker: { kind: "profile", profile: "profile-b" },
							});
						} else {
							await expect(second).rejects.toThrow("intent changed while selecting profile");
							expect(beforeSecond).not.toHaveBeenCalled();
							expect(captureControlProfileState(fixture.session, fixture.settings)).toEqual(newerRuntime);
							expect(fixture.session.getThinkingLevelMutationRevision()).toBe(thinkingRevision);
							expect(readDurableModelProfileOwnership(fixture.settings)).toEqual(owned);
							expect(fixture.settings.getGlobal("modelProfile.default")).toBe(
								persistDefault ? firstProfile : undefined,
							);
							if (interveningIntent === "global roles")
								expect(fixture.settings.getGlobal("modelRoles")).toEqual({ critic: "provider-c/architect" });
						}
						expect(fixture.session.sessionLifecycle.disposed).toBe(false);
					} finally {
						release.resolve();
						await Promise.allSettled([first, second]);
						finish.mockRestore();
						await fixture.dispose();
					}
				});
			}
		}
	}

	for (const interveningIntent of ["none", "thinking", "global roles"] as const) {
		test(`queued B before session-only DEFAULT publication with held edit refresh ${interveningIntent === "none" ? "accepts owned succession" : `rejects newer ${interveningIntent}`}`, async () => {
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			let held = false;
			const editTool: AgentTool = {
				name: "edit",
				label: "Edit",
				description: "Edit files",
				parameters: z.object({}),
				execute: async () => ({ content: [] }),
			};
			const fixture = controlProfileFixture(undefined, {
				tools: [editTool],
				rebuildSystemPrompt: async () => {
					if (!held) {
						held = true;
						entered.resolve();
						await release.promise;
					}
					return { systemPrompt: ["Refreshed edit prompt"] };
				},
			});
			const beforeSecond = vi.fn();
			let first: Promise<unknown> | undefined;
			let second: Promise<unknown> | undefined;
			try {
				fixture.session.setThinkingLevel(ThinkingLevel.Low);
				const before = captureControlProfileState(fixture.session, fixture.settings);
				expect(fixture.session.getActiveToolNames()).toContain("edit");
				first = fixture.session.setDefaultModelProfileForControl("profile-a", { persistDefault: false });
				void first.catch(() => undefined);
				second = fixture.session.setDefaultModelProfileForControl("profile-b", {
					persistDefault: true,
					onBeforeActivation: beforeSecond,
				});
				void second.catch(() => undefined);
				// B is admitted against the same owner/runtime, before A can publish.
				expect(captureControlProfileState(fixture.session, fixture.settings)).toEqual(before);
				await Promise.race([
					entered.promise,
					first.then(() => {
						throw new Error("Profile activation completed without reaching edit refresh");
					}),
				]);
				expect(fixture.session.model).toMatchObject({ provider: "provider-a", id: "default" });
				expect(fixture.session.getActiveModelProfile()).toBe("profile-a");
				expect(fixture.session.getActivatedModelProfile()).toBe("profile-a");
				expect(fixture.session.thinkingLevel).toBeUndefined();
				expect(fixture.settings.getOverride("task.agentModelOverrides")?.executor).toBe("provider-b/executor");
				expect(fixture.session.getSessionDefaultModelSelector()).toBe("provider-a/default");
				expect(beforeSecond).not.toHaveBeenCalled();
				if (interveningIntent === "thinking") fixture.session.setThinkingLevel(undefined);
				if (interveningIntent === "global roles") {
					await fixture.settings.commitAtomicBatch([
						{ path: "modelRoles", op: "set", value: { critic: "provider-c/architect" } },
					]);
				}
				const newerRuntime = captureControlProfileState(fixture.session, fixture.settings);
				const thinkingRevision = fixture.session.getThinkingLevelMutationRevision();
				const ownership = readDurableModelProfileOwnership(fixture.settings);
				release.resolve();
				await expect(first).resolves.toEqual({ changed: true, id: "profile-a" });
				if (interveningIntent === "none") {
					await expect(second).resolves.toEqual({ changed: true, id: "profile-b" });
					expect(beforeSecond).toHaveBeenCalledTimes(1);
					expect(readDurableModelProfileOwnership(fixture.settings)).toMatchObject({
						version: 1,
						marker: { kind: "profile", profile: "profile-b" },
					});
				} else {
					await expect(second).rejects.toThrow("intent changed while selecting profile");
					expect(beforeSecond).not.toHaveBeenCalled();
					expect(captureControlProfileState(fixture.session, fixture.settings)).toEqual(newerRuntime);
					expect(fixture.session.getThinkingLevelMutationRevision()).toBe(thinkingRevision);
					expect(readDurableModelProfileOwnership(fixture.settings)).toEqual(ownership);
					expect(fixture.settings.getGlobal("modelProfile.default")).toBeUndefined();
					if (interveningIntent === "global roles")
						expect(fixture.settings.getGlobal("modelRoles")).toEqual({ critic: "provider-c/architect" });
				}
				expect(fixture.session.sessionLifecycle.disposed).toBe(false);
			} finally {
				release.resolve();
				await Promise.allSettled([first, second]);
				await fixture.dispose();
			}
		});
	}

	for (const newerIntent of ["thinking", "model"] as const) {
		test(`guarded session-only preparation rejection cancels after newer ${newerIntent} intent`, async () => {
			const fixture = controlProfileFixture();
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const probe = vi.spyOn(fixture.registry, "getApiKey").mockImplementationOnce(async () => {
				entered.resolve();
				await release.promise;
				return kNoAuth;
			});
			const publish = vi.spyOn(fixture.session, "commitPreparedProfileModelSelection");
			let activation: Promise<void> | undefined;
			try {
				fixture.session.setThinkingLevel(ThinkingLevel.Low);
				const revision = fixture.session.getUserModelSelectionRevision();
				activation = activateModelProfile(
					{
						session: fixture.session,
						modelRegistry: fixture.registry,
						settings: fixture.settings,
						profileName: "profile-a",
					},
					{ isCurrent: () => fixture.session.getUserModelSelectionRevision() === revision },
				);
				void activation.catch(() => undefined);
				await Promise.race([
					entered.promise,
					activation.then(() => {
						throw new Error("Profile activation completed without reaching credential preparation");
					}),
				]);
				if (newerIntent === "thinking") {
					fixture.session.setThinkingLevel(ThinkingLevel.High);
					fixture.session.markUserModelSelection();
				} else {
					const nextModel = fixture.registry.getAll().find(candidate => candidate.provider === "provider-c");
					if (!nextModel) throw new Error("Expected a newer model selection fixture");
					await fixture.session.setModelTemporary(nextModel, undefined, { cause: "user-selection" });
				}
				const newer = captureControlProfileState(fixture.session, fixture.settings);
				const thinkingRevision = fixture.session.getThinkingLevelMutationRevision();
				const ownership = readDurableModelProfileOwnership(fixture.settings);
				release.resolve();
				await expect(activation).resolves.toBeUndefined();
				expect(publish).not.toHaveBeenCalled();
				expect(captureControlProfileState(fixture.session, fixture.settings)).toEqual(newer);
				expect(fixture.session.getThinkingLevelMutationRevision()).toBe(thinkingRevision);
				expect(readDurableModelProfileOwnership(fixture.settings)).toEqual(ownership);
				expect(fixture.settings.getGlobal("modelProfile.default")).toBeUndefined();
				expect(fixture.session.sessionLifecycle.disposed).toBe(false);
			} finally {
				release.resolve();
				await Promise.allSettled([activation]);
				probe.mockRestore();
				publish.mockRestore();
				await fixture.dispose();
			}
		});
	}

	for (const failureKind of ["current thinking drift", "current credential failure", "explicit abort"] as const) {
		test(`guarded session-only preparation preserves rejection for ${failureKind}`, async () => {
			const fixture = controlProfileFixture();
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const failure = new Error(failureKind);
			const controller = new AbortController();
			const probe = vi.spyOn(fixture.registry, "getApiKey").mockImplementationOnce(async () => {
				entered.resolve();
				await release.promise;
				if (failureKind === "current credential failure") throw failure;
				return kNoAuth;
			});
			const publish = vi.spyOn(fixture.session, "commitPreparedProfileModelSelection");
			let activation: Promise<void> | undefined;
			try {
				fixture.session.setThinkingLevel(ThinkingLevel.Low);
				const revision = fixture.session.getUserModelSelectionRevision();
				activation = activateModelProfile(
					{
						session: fixture.session,
						modelRegistry: fixture.registry,
						settings: fixture.settings,
						profileName: "profile-a",
					},
					{
						isCurrent: () => fixture.session.getUserModelSelectionRevision() === revision,
						signal: controller.signal,
					},
				);
				void activation.catch(() => undefined);
				await Promise.race([
					entered.promise,
					activation.then(() => {
						throw new Error("Profile activation completed without reaching credential preparation");
					}),
				]);
				if (failureKind !== "current credential failure") fixture.session.setThinkingLevel(ThinkingLevel.High);
				if (failureKind === "explicit abort") {
					fixture.session.markUserModelSelection();
					controller.abort(failure);
				}
				const beforeRelease = captureControlProfileState(fixture.session, fixture.settings);
				const thinkingRevision = fixture.session.getThinkingLevelMutationRevision();
				const ownership = readDurableModelProfileOwnership(fixture.settings);
				release.resolve();
				if (failureKind === "current thinking drift") {
					await expect(activation).rejects.toThrow("Session changed while preparing profile model selection");
				} else {
					await expect(activation).rejects.toBe(failure);
				}
				expect(publish).not.toHaveBeenCalled();
				expect(captureControlProfileState(fixture.session, fixture.settings)).toEqual(beforeRelease);
				expect(fixture.session.getThinkingLevelMutationRevision()).toBe(thinkingRevision);
				expect(readDurableModelProfileOwnership(fixture.settings)).toEqual(ownership);
				expect(fixture.session.sessionLifecycle.disposed).toBe(false);
			} finally {
				release.resolve();
				await Promise.allSettled([activation]);
				probe.mockRestore();
				publish.mockRestore();
				await fixture.dispose();
			}
		});
	}

	test("session-only DEFAULT edit refresh rejection restores its complete runtime publication", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const failure = new Error("edit prompt refresh failed");
		let rejected = false;
		const editTool: AgentTool = {
			name: "edit",
			label: "Edit",
			description: "Edit files",
			parameters: z.object({}),
			execute: async () => ({ content: [] }),
		};
		const fixture = controlProfileFixture(undefined, {
			tools: [editTool],
			rebuildSystemPrompt: async () => {
				if (!rejected) {
					rejected = true;
					entered.resolve();
					await release.promise;
					throw failure;
				}
				return { systemPrompt: ["Restored edit prompt"] };
			},
		});
		let activation: Promise<unknown> | undefined;
		try {
			fixture.session.setThinkingLevel(ThinkingLevel.Low);
			fixture.session.setConfiguredModelChain("default", ["openai-codex/gpt-5.5:low"], "model_selection");
			fixture.session.recordResumeDefaultModel("openai-codex/gpt-5.5");
			const before = captureControlProfileState(fixture.session, fixture.settings);
			const ownership = readDurableModelProfileOwnership(fixture.settings);
			const after = vi.fn();
			activation = fixture.session.setDefaultModelProfileForControl("profile-a", {
				persistDefault: false,
				onAfterActivation: after,
			});
			void activation.catch(() => undefined);
			await Promise.race([
				entered.promise,
				activation.then(() => {
					throw new Error("Profile activation completed without reaching edit refresh");
				}),
			]);
			expect(fixture.session.getActiveModelProfile()).toBe("profile-a");
			expect(fixture.session.thinkingLevel).toBeUndefined();
			release.resolve();
			await expect(activation).rejects.toBe(failure);
			expect(after).not.toHaveBeenCalled();
			expect(captureControlProfileState(fixture.session, fixture.settings)).toEqual(before);
			expect(readDurableModelProfileOwnership(fixture.settings)).toEqual(ownership);
			expect(fixture.settings.getGlobal("modelProfile.default")).toBeUndefined();
			expect(fixture.session.sessionLifecycle.disposed).toBe(false);
		} finally {
			release.resolve();
			await Promise.allSettled([activation]);
			await fixture.dispose();
		}
	});

	test("role-only persistent activation applies its thinking override without inventing a DEFAULT or resume selection", async () => {
		const fixture = controlProfileFixture();
		const priorModel = fixture.session.model;
		const priorResume = fixture.manager.buildSessionContext().models.default;
		try {
			await expect(
				fixture.session.setDefaultModelProfileForControl("roles-only", {
					persistDefault: true,
					thinkingLevelOverride: ThinkingLevel.High,
				}),
			).resolves.toEqual({ changed: true, id: "roles-only" });
			expect(fixture.session.model).toBe(priorModel);
			expect(fixture.session.thinkingLevel).toBe(ThinkingLevel.High);
			expect(fixture.manager.buildSessionContext().models.default).toBe(priorResume);
			expect(fixture.settings.getGlobal("defaultThinkingLevel")).toBeUndefined();
			expect(readDurableModelProfileOwnership(fixture.settings)).toMatchObject({
				version: 1,
				marker: { kind: "profile", profile: "roles-only" },
			});
			expect(fixture.settings.getOverride("task.agentModelOverrides")?.executor).toBe("provider-b/executor");
		} finally {
			await fixture.dispose();
		}
	});

	for (const persistDefault of [false, true]) {
		test(`${persistDefault ? "persistent" : "session-only"} successful DEFAULT records MRU in the injected storage, failed activation does not`, async () => {
			const scope = TempDir.createSync("@gjc-profile-injected-storage-");
			const settings = await Settings.loadForScope({ cwd: scope.path(), agentDir: scope.path() });
			const fixture = controlProfileFixture(settings);
			const storage = settings.getStorage();
			if (!storage) throw new Error("Expected injected scoped storage");
			const usage = vi.spyOn(storage, "recordModelUsage");
			const load = vi.spyOn(Settings, "loadForScope");
			try {
				await fixture.session.setDefaultModelProfileForControl("profile-b", { persistDefault });
				expect(usage).toHaveBeenCalledTimes(1);
				expect(usage).toHaveBeenCalledWith("provider-c/default");
				expect(load).not.toHaveBeenCalled();
				if (persistDefault) {
					const raw = Bun.YAML.parse(await Bun.file(`${scope.path()}/config.yml`).text()) as Record<
						string,
						unknown
					>;
					expect(readDurableModelProfileOwnershipFromRaw(raw)).toEqual(readDurableModelProfileOwnership(settings));
				} else {
					expect(readDurableModelProfileOwnership(settings)).toMatchObject({
						version: 0,
						marker: { kind: "inherit" },
					});
				}
				const failure = vi
					.spyOn(settings, "commitAtomicBatchWithCurrent")
					.mockRejectedValueOnce(new Error("commit rejected"));
				try {
					await expect(
						fixture.session.setDefaultModelProfileForControl("profile-a", { persistDefault: true }),
					).rejects.toThrow("commit rejected");
					expect(usage).toHaveBeenCalledTimes(1);
				} finally {
					failure.mockRestore();
				}
			} finally {
				load.mockRestore();
				usage.mockRestore();
				await fixture.dispose();
				scope.removeSync();
			}
		});
	}

	test("persistent activation preserves runtime profile overrides and manual role baselines on injected settings", async () => {
		const settings = Settings.isolated(
			{},
			{
				overrides: {
					"modelProfile.default": "runtime-shadow",
					modelRoles: { critic: "provider-c/architect" },
					"task.agentModelOverrides": { planner: "provider-c/executor" },
				},
			},
		);
		const fixture = controlProfileFixture(settings);
		try {
			await fixture.session.setDefaultModelProfileForControl("profile-b", { persistDefault: true });
			expect(fixture.session.settings).toBe(settings);
			expect(settings.getGlobal("modelProfile.default")).toBe("profile-b");
			expect(settings.get("modelProfile.default")).toBe("runtime-shadow");
			expect(settings.getOverride("modelRoles")?.critic).toBe("provider-c/architect");
			expect(settings.getOverride("task.agentModelOverrides")?.planner).toBe("provider-c/executor");
			expect(settings.getGlobal("modelRoles")).toEqual({});
			expect(settings.getGlobal("task.agentModelOverrides")).toEqual({});
		} finally {
			await fixture.dispose();
		}
	});

	test("persistent canonical activation advances versioned ownership and its default projection together", async () => {
		const settings = Settings.isolated();
		const prior = await commitDurableModelProfileOwnership(settings, { kind: "profile", profile: "profile-a" });
		const profileB: ModelProfileDefinition = {
			name: "profile-b",
			requiredProviders: ["provider-c"],
			modelMapping: { default: "provider-c/default", executor: "provider-c/executor" },
			source: "user",
		};
		const registry = fakeRegistry({ profiles: [...fakeRegistry().getModelProfiles().values(), profileB] });
		const session = fakeSession();
		try {
			await activateModelProfile(
				{ session, modelRegistry: registry, settings, profileName: profileB.name },
				{ persistDefault: true },
			);

			expect(readDurableModelProfileOwnership(settings)).toEqual({
				schemaVersion: 1,
				version: prior.version + 1,
				marker: { kind: "profile", profile: profileB.name },
			});
			expect(settings.getGlobal("modelProfile.default")).toBe(profileB.name);
			expect(session.getActiveModelProfile()).toBe(profileB.name);
		} finally {
			await settings.close();
		}
	});

	for (const profileKind of ["DEFAULT", "role-only"] as const) {
		for (const transition of ["new-session", "same-ID context clear", "session ID return"] as const) {
			test(`rejects an idle-wait ${profileKind} profile request after ${transition} without successor effects`, async () => {
				const tempDir = TempDir.createSync("@gjc-profile-idle-transition-");
				const manager = SessionManager.create(tempDir.path(), tempDir.path());
				const settings = Settings.isolated({ "compaction.enabled": false });
				const profile: ModelProfileDefinition = {
					name: "idle-profile",
					requiredProviders: ["provider-a", "provider-b"],
					modelMapping:
						profileKind === "DEFAULT"
							? { default: "provider-a/default", executor: "provider-b/executor" }
							: { executor: "provider-b/executor" },
					source: "user",
				};
				const baseRegistry = fakeRegistry({ profiles: [profile] });
				const registry = {
					...baseRegistry,
					getAvailable: () => baseRegistry.getAll(),
					getApiKey: async () => kNoAuth,
					withConsumerLease: async <T>(body: () => T | Promise<T>): Promise<T> => await body(),
				};
				const session = new AgentSession({
					agent: new Agent({
						initialState: { model: model("provider-c", "default"), systemPrompt: [], tools: [], messages: [] },
					}),
					sessionManager: manager,
					settings,
					modelRegistry: registry as unknown as ModelRegistry,
				});
				const idleEntered = Promise.withResolvers<void>();
				const releaseIdle = Promise.withResolvers<void>();
				const waitForIdle = vi.spyOn(session, "waitForIdle").mockImplementationOnce(async () => {
					idleEntered.resolve();
					await releaseIdle.promise;
				});
				const beforeActivation = vi.fn();
				const afterActivation = vi.fn();
				let request: Promise<{ status: "fulfilled" | "rejected"; error?: unknown }> | undefined;
				try {
					manager.appendModelChange("provider-c/default");
					await manager.ensureOnDisk();
					await manager.flush();
					const originalId = session.sessionId;
					const originalFile = manager.getSessionFile();
					if (!originalFile) throw new Error("Expected persisted predecessor session");
					request = session
						.setDefaultModelProfileForControl(profile.name, {
							persistDefault: true,
							onBeforeActivation: beforeActivation,
							onAfterActivation: afterActivation,
						})
						.then(
							() => ({ status: "fulfilled" as const }),
							error => ({ status: "rejected" as const, error }),
						);
					await idleEntered.promise;
					if (transition === "same-ID context clear") {
						expect(await session.clearContext()).toBe(true);
						expect(session.sessionId).toBe(originalId);
					} else {
						expect(await session.newSession()).toBe(true);
						expect(session.sessionId).not.toBe(originalId);
						if (transition === "session ID return") {
							expect(await session.switchSession(originalFile)).toBe(true);
							expect(session.sessionId).toBe(originalId);
						}
					}
					const successorModel = session.model;
					const successorThinking = session.thinkingLevel;
					const successorContext = manager.buildSessionContext();
					const successorRoles = settings.getOverride("modelRoles");
					const successorAgentOverrides = settings.getOverride("task.agentModelOverrides");
					releaseIdle.resolve();
					const outcome = await request;

					expect(outcome.status).toBe("rejected");
					expect(outcome.error).toEqual(
						expect.objectContaining({
							message: expect.stringMatching(/session.*changed|supersed|abort|cancel/i),
						}),
					);
					expect(beforeActivation).not.toHaveBeenCalled();
					expect(afterActivation).not.toHaveBeenCalled();
					expect(session.model).toBe(successorModel);
					expect(session.thinkingLevel).toBe(successorThinking);
					expect(manager.buildSessionContext()).toEqual(successorContext);
					expect(session.getActiveModelProfile()).toBeUndefined();
					expect(settings.getOverride("modelRoles")).toEqual(successorRoles);
					expect(settings.getOverride("task.agentModelOverrides")).toEqual(successorAgentOverrides);
					expect(readDurableModelProfileOwnership(settings)).toEqual({
						schemaVersion: 1,
						version: 0,
						marker: { kind: "inherit" },
					});
					expect(settings.getGlobal("modelProfile.default")).toBeUndefined();
				} finally {
					releaseIdle.resolve();
					await request;
					waitForIdle.mockRestore();
					await session.dispose();
					await settings.close();
					tempDir.removeSync();
				}
			});
		}
	}

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

	it("does not restore a captured model over a newer user selection during rollback", async () => {
		const session = fakeSession();
		const prepared = await prepareModelProfileActivation({
			session,
			modelRegistry: fakeRegistry(),
			settings: Settings.isolated(),
			profileName: "profile-a",
		});
		const newerSelection = model("provider-c", "user-selection");
		session.model = newerSelection;
		prepared.defaultModelPublished = true;

		await rollbackPreparedModelProfileActivation(prepared, { isCurrent: () => false });

		expect(session.model).toBe(newerSelection);
	});

	test("does not restore fallback state after a newer selection during model rollback", async () => {
		const restoreStarted = Promise.withResolvers<void>();
		const allowRestore = Promise.withResolvers<void>();
		let selectionRevision = 0;
		let fallbackState = {
			chain: {
				role: "default",
				entries: ["provider-c/default"],
				origin: "model_selection",
				explicitHead: true,
			},
			controller: {
				activeIndex: 0,
				attemptsUsed: 0,
				totalAttemptsUsed: 0,
				attemptStarted: false,
				restoredEntryIndices: [],
				tried: [],
				skips: [],
				exhaustedForTurn: false,
			},
			exhaustedLastTurn: false,
		} satisfies DefaultFallbackRuntimeState;
		const newerFallbackState = {
			...fallbackState,
			chain: { ...fallbackState.chain, entries: ["provider-b/executor"] },
			controller: { ...fallbackState.controller, activeIndex: 1 },
		};
		const restoreFallback = vi.fn();
		const session = Object.assign(fakeSession(), {
			getUserModelSelectionRevision: () => selectionRevision,
			getDefaultFallbackRuntimeState: () => fallbackState,
			restoreDefaultFallbackRuntimeState: restoreFallback,
			commitPreparedProfileModelSelection: () => {
				throw new Error("profile model selection failed");
			},
			restoreModelSelectionForRollback: async (
				_previousModel: Model | undefined,
				_previousThinkingLevel: ThinkingLevel | undefined,
			) => {
				restoreStarted.resolve();
				await allowRestore.promise;
			},
		});
		const activation = await prepareModelProfileActivation({
			session,
			modelRegistry: fakeRegistry(),
			settings: Settings.isolated(),
			profileName: "profile-a",
		});
		let applying: Promise<void> | undefined;
		try {
			applying = applyPreparedModelProfileActivation(activation, {
				isCurrent: () => selectionRevision === 0,
			});
			await restoreStarted.promise;
			selectionRevision++;
			fallbackState = newerFallbackState;
			allowRestore.resolve();
			await expect(applying).rejects.toThrow("profile model selection failed");

			expect(restoreFallback).not.toHaveBeenCalled();
			expect(fallbackState).toEqual(newerFallbackState);
		} finally {
			allowRestore.resolve();
			if (applying) await Promise.allSettled([applying]);
		}
	});

	test("keeps a same-model resume choice made during rollback model restoration", async () => {
		const baseSession = fakeSession();
		const restoreStarted = Promise.withResolvers<void>();
		const allowRestore = Promise.withResolvers<void>();
		const session = Object.assign(baseSession, {
			prepareModelSelectionForProfileActivation: async (
				nextModel: Model,
				thinkingLevel: ThinkingLevel | undefined,
				signal?: AbortSignal,
			): Promise<PreparedProfileModelSelection> => ({
				sessionId: baseSession.sessionId,
				model: nextModel,
				thinkingLevel,
				committedThinkingLevel: thinkingLevel,
				previousModel: baseSession.model,
				previousThinkingLevel: baseSession.thinkingLevel,
				previousThinkingLevelMutationRevision: 0,
				previousEditMode: "hashline",
				signal,
			}),
			commitPreparedProfileModelSelection: (selection: PreparedProfileModelSelection) => {
				baseSession.model = selection.model;
				baseSession.thinkingLevel = selection.committedThinkingLevel;
			},
			restoreModelSelectionForRollback: async (
				previousModel: Model | undefined,
				previousThinkingLevel: ThinkingLevel | undefined,
			) => {
				baseSession.model = previousModel;
				baseSession.thinkingLevel = previousThinkingLevel;
				restoreStarted.resolve();
				await allowRestore.promise;
			},
		});
		baseSession.recordResumeDefaultModel("provider-c/previous-default");
		const settings = Settings.isolated();
		const prepared = await prepareModelProfileActivation({
			session,
			modelRegistry: fakeRegistry(),
			settings,
			profileName: "profile-a",
			prepareSessionModelSelection: true,
		});
		const profileDefault = prepared.defaultModel;
		if (!profileDefault) throw new Error("Expected a prepared profile default model");
		publishPreparedModelProfileActivation(prepared);
		const publishedDefault = `${profileDefault.provider}/${profileDefault.id}`;
		let selectionIsCurrent = true;
		let rollback: Promise<void> | undefined;
		try {
			rollback = rollbackPreparedModelProfileActivation(prepared, {
				isCurrent: () => selectionIsCurrent,
			});
			await restoreStarted.promise;
			selectionIsCurrent = false;
			baseSession.model = profileDefault;
			baseSession.thinkingLevel = ThinkingLevel.Low;
			baseSession.recordResumeDefaultModel(publishedDefault);
			allowRestore.resolve();
			await rollback;

			expect(baseSession.model).toBe(profileDefault);
			expect(baseSession.thinkingLevel).toBe(ThinkingLevel.Low);
			expect(baseSession.getSessionDefaultModelSelector()).toBe(publishedDefault);
		} finally {
			allowRestore.resolve();
			if (rollback) await Promise.allSettled([rollback]);
		}
	});

	test("skips profile preparation when the recovery fence is already stale", async () => {
		const session = fakeSession();
		const registry = fakeRegistry();
		const getProfiles = vi.spyOn(registry, "getModelProfiles");
		const clearCanonicalVariant = vi.fn();
		Object.assign(registry, { clearCanonicalVariant });

		await activateModelProfile(
			{ session, modelRegistry: registry as never, settings: Settings.isolated(), profileName: "profile-a" },
			{ isCurrent: () => false },
		);

		expect(getProfiles).not.toHaveBeenCalled();
		expect(clearCanonicalVariant).not.toHaveBeenCalled();
		expect(session.setModelTemporaryCalls).toEqual([]);
	});

	test("preserves a newer fallback chain selected during profile model activation", async () => {
		const modelMutationStarted = Promise.withResolvers<void>();
		const allowModelMutation = Promise.withResolvers<void>();
		const session = Object.assign(fakeSession(), {
			finishPreparedProfileModelSelection: async () => {
				modelMutationStarted.resolve();
				await allowModelMutation.promise;
			},
		});
		const registry = fakeRegistry();
		const activation = activateModelProfile({
			session,
			modelRegistry: registry as never,
			settings: Settings.isolated(),
			profileName: "profile-a",
		});

		try {
			await Promise.race([
				modelMutationStarted.promise,
				activation.then(() => {
					throw new Error("Profile activation completed without reaching model finish");
				}),
			]);
			session.setConfiguredModelChain("default", ["provider-c/default"], "model-selection", "user-selection", true);
			allowModelMutation.resolve();
			await activation;

			expect(session.getConfiguredModelChain("default")).toEqual(["provider-c/default"]);
			expect(session.getConfiguredModelChainState("default")).toMatchObject({
				origin: "model-selection",
				identity: "user-selection",
				explicitHead: true,
			});
		} finally {
			allowModelMutation.resolve();
			await Promise.allSettled([activation]);
		}
	});

	test("leaves a newer fallback chain untouched when guarded profile preparation is superseded", async () => {
		const session = fakeSession();
		const registry = fakeRegistry();
		const modelMutationStarted = Promise.withResolvers<void>();
		const allowModelMutation = Promise.withResolvers<void>();
		const prepareSelection = session.prepareModelSelectionForProfileActivation.bind(session);
		session.prepareModelSelectionForProfileActivation = async (next, thinkingLevel, signal) => {
			modelMutationStarted.resolve();
			await allowModelMutation.promise;
			return prepareSelection(next, thinkingLevel, signal);
		};
		const commitSelection = vi.spyOn(session, "commitPreparedProfileModelSelection");
		let selectionIsCurrent = true;
		const activation = activateModelProfile(
			{
				session,
				modelRegistry: registry as never,
				settings: Settings.isolated(),
				profileName: "profile-a",
			},
			{ isCurrent: () => selectionIsCurrent },
		);

		try {
			await Promise.race([
				modelMutationStarted.promise,
				activation.then(() => {
					throw new Error("Profile activation completed without reaching model preparation");
				}),
			]);
			selectionIsCurrent = false;
			session.setConfiguredModelChain("default", ["provider-c/selected"], "model-selection", "user-selection", true);
			allowModelMutation.resolve();
			await activation;

			expect(commitSelection).not.toHaveBeenCalled();
			expect(session.setModelTemporaryCalls).toEqual([]);
			expect(session.getConfiguredModelChain("default")).toEqual(["provider-c/selected"]);
			expect(session.getConfiguredModelChainState("default")).toMatchObject({ origin: "model-selection" });
			expect(session.getActiveModelProfile()).toBeUndefined();
		} finally {
			allowModelMutation.resolve();
			await Promise.allSettled([activation]);
			commitSelection.mockRestore();
		}
	});

	test("cancels recovered runtime bindings when selection changes during preparation", async () => {
		const session = fakeSession();
		const registry = fakeRegistry();
		const apiKey = Promise.withResolvers<string | undefined>();
		const apiProbeStarted = Promise.withResolvers<void>();
		vi.spyOn(registry, "getApiKeyForProvider").mockImplementation(async provider => {
			if (provider === "provider-a") {
				apiProbeStarted.resolve();
				return apiKey.promise;
			}
			return `key-${provider}`;
		});
		const settings = Settings.isolated({ modelRoles: { default: "provider-c/original" } });
		let selectionIsCurrent = true;
		const activation = applyModelProfileRuntimeBindings(
			{ session, modelRegistry: registry as never, settings, profileName: "profile-a" },
			() => selectionIsCurrent,
		);

		await apiProbeStarted.promise;
		selectionIsCurrent = false;
		apiKey.resolve("key-provider-a");
		await activation;

		expect(session.getActiveModelProfile()).toBeUndefined();
		expect(settings.getOverride("modelRoles")).toBeUndefined();
		expect(settings.getOverride("task.agentModelOverrides")).toBeUndefined();
	});

	test("records recovered role ownership baselines for later profile reloads", async () => {
		const session = fakeSession();
		const settings = Settings.isolated();
		const baselineModelRoles = { planner: "provider-c/manual-planner" };
		const baselineAgentModelOverrides = { architect: "provider-c/manual-architect" };
		settings.override("modelRoles", baselineModelRoles);
		settings.override("task.agentModelOverrides", baselineAgentModelOverrides);
		const noteProfileInstalledOverrides = vi.fn();
		Object.assign(session, { noteProfileInstalledOverrides });

		await applyModelProfileRuntimeBindings({
			session,
			modelRegistry: fakeRegistry() as never,
			settings,
			profileName: "profile-a",
		});

		expect(noteProfileInstalledOverrides).toHaveBeenCalledWith(
			[],
			["executor", "architect"],
			session.model,
			{ modelRoles: baselineModelRoles, agentModelOverrides: baselineAgentModelOverrides },
			{
				modelRoles: {},
				agentModelOverrides: {
					executor: "provider-b/executor",
					architect: "provider-a/architect",
				},
			},
			{ modelRoles: [], agentModelOverrides: [] },
			["provider-a/default:high"],
		);
	});

	test("restores recovered runtime bindings when selection changes during delegation sync", async () => {
		const session = fakeSession();
		session.setActiveModelProfile("previous-profile");
		const registry = fakeRegistry();
		const settings = Settings.isolated({
			modelRoles: { default: "provider-c/global-default", critic: "provider-c/global-critic" },
			"task.agentModelOverrides": { planner: "provider-c/global-planner" },
		});
		const previousModelRolesOverride = { default: "provider-c/old-default", critic: "provider-c/old-critic" };
		const previousAgentModelOverridesOverride = { planner: "provider-c/old-planner" };
		settings.override("modelRoles", previousModelRolesOverride);
		settings.override("task.agentModelOverrides", previousAgentModelOverridesOverride);
		const syncStarted = Promise.withResolvers<void>();
		const allowSync = Promise.withResolvers<void>();
		let syncCalls = 0;
		const syncEagerDelegation = vi.fn(async () => {
			syncCalls += 1;
			if (syncCalls === 1) {
				syncStarted.resolve();
				await allowSync.promise;
			}
		});
		const noteProfileInstalledOverrides = vi.fn();
		Object.assign(session, { syncEagerDelegation, noteProfileInstalledOverrides });
		let selectionIsCurrent = true;
		const activation = applyModelProfileRuntimeBindings(
			{ session, modelRegistry: registry as never, settings, profileName: "profile-a" },
			() => selectionIsCurrent,
		);

		await syncStarted.promise;
		selectionIsCurrent = false;
		settings.setAgentModelOverride("executor", "provider-c/user-executor");
		allowSync.resolve();
		await activation;

		expect(settings.getOverride("modelRoles")).toEqual(previousModelRolesOverride);
		expect(settings.getOverride("task.agentModelOverrides")).toEqual({
			...previousAgentModelOverridesOverride,
			executor: "provider-c/user-executor",
		});
		expect(session.getActiveModelProfile()).toBe("previous-profile");
		expect(noteProfileInstalledOverrides).not.toHaveBeenCalled();
		expect(syncEagerDelegation).toHaveBeenCalledTimes(2);
	});

	test("built-in claude-opus falls back to Opus 4.6 when Opus 5.5 is absent", async () => {
		const profile = BUILTIN_MODEL_PROFILES.find(candidate => candidate.name === "claude-opus");
		expect(profile).toBeDefined();
		const baseRegistry = fakeRegistry({ profiles: [profile!] });
		const available = baseRegistry.getAll().filter(candidate => candidate.id !== "claude-opus-5-5");
		const session = fakeSession();

		const prepared = await prepareModelProfileActivation({
			session,
			modelRegistry: {
				...baseRegistry,
				getAvailable: () => available,
				withConsumerLease: async <T>(body: () => T | Promise<T>): Promise<T> => await body(),
			} as unknown as ModelRegistry,
			settings: Settings.isolated(),
			profileName: "claude-opus",
		});

		expect(prepared.defaultModel).toMatchObject({ provider: "anthropic", id: "claude-opus-4-6" });
		expect(prepared.defaultThinkingLevel).toBe(ThinkingLevel.XHigh);
		expect(prepared.defaultChain).toEqual(["anthropic/claude-opus-5-5:medium", "anthropic/claude-opus-4-6:xhigh"]);
		expect(prepared.agentModelOverrides).toEqual({
			executor: "anthropic/claude-sonnet-5-5",
			planner: ["anthropic/claude-opus-5-5:medium", "anthropic/claude-opus-4-6:low"],
			critic: ["anthropic/claude-opus-5-5:high", "anthropic/claude-opus-4-6:high"],
			architect: ["anthropic/claude-opus-5-5:high", "anthropic/claude-opus-4-6:xhigh"],
		});
	});

	test("built-in claude-opus retains Opus 5.5 when the catalog exposes it", async () => {
		const profile = BUILTIN_MODEL_PROFILES.find(candidate => candidate.name === "claude-opus");
		expect(profile).toBeDefined();

		const prepared = await prepareModelProfileActivation({
			session: fakeSession(),
			modelRegistry: fakeRegistry({ profiles: [profile!] }),
			settings: Settings.isolated(),
			profileName: "claude-opus",
		});

		expect(prepared.defaultModel).toMatchObject({ provider: "anthropic", id: "claude-opus-5-5" });
		expect(prepared.defaultThinkingLevel).toBe(ThinkingLevel.Medium);
	});

	test("built-in claude-opus keeps a bundled Opus 5.5 omitted from fresh live catalog evidence", async () => {
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
			// Live discovery enriches the catalog but never removes a bundled entry:
			// Opus 5.5 stays selectable even though the live response omitted it, and
			// the provider reports its own error if the account cannot use it.
			const anthropicIds = registry
				.getAvailable()
				.filter(candidate => candidate.provider === "anthropic")
				.map(candidate => candidate.id)
				.sort();
			expect(anthropicIds).toContain("claude-opus-5-5");
			expect(anthropicIds).toContain("claude-opus-4-6");
			expect(anthropicIds).toContain("claude-sonnet-5");
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

			expect(prepared.defaultModel).toMatchObject({ provider: "anthropic", id: "claude-opus-5-5" });
			expect(prepared.defaultResolutionSkips).toEqual([]);
			expect(prepared.agentModelOverrides).toMatchObject({
				executor: "anthropic/claude-sonnet-5-5",
				planner: ["anthropic/claude-opus-5-5:medium", "anthropic/claude-opus-4-6:low"],
				critic: ["anthropic/claude-opus-5-5:high", "anthropic/claude-opus-4-6:high"],
				architect: ["anthropic/claude-opus-5-5:high", "anthropic/claude-opus-4-6:high"],
			});
		} finally {
			authStorage.close();
			tempDir.removeSync();
		}
	});

	test("materialization resolves a bare assignment against the available catalog, not the full catalog", () => {
		const opus5 = model("anthropic", "claude-opus-5-5");
		const opus46 = model("anthropic", "claude-opus-4-6");
		const baseRegistry = fakeRegistry();
		const registry = {
			...baseRegistry,
			getAll: () => [opus5, opus46, ...baseRegistry.getAll()],
			// Only Opus 4.6 is usable; the full catalog still lists Opus 5.5.
			getAvailable: () => [opus46],
			lookupAliasExists: (alias: string) => alias === "opus",
			resolveModelByLookupAlias: (alias: string, lookupOptions?: { candidates?: readonly Model[] }) =>
				alias === "opus"
					? (lookupOptions?.candidates ?? []).find(candidate => candidate.provider === "anthropic")
					: undefined,
		} as unknown as ModelRegistry;
		const session = fakeSession();
		session.modelRegistry = registry;
		const settings = Settings.isolated({ "modelProfile.default": "live-narrow" });

		const materialized = materializeActiveModelProfileAssignments({
			session,
			settings,
			assignments: new Map([["default", "opus"]]),
		});

		expect(materialized).toBe(true);
		// The full catalog still lists Opus 5.5, but the assignment is persisted for
		// later profile execution, so it must resolve against the usable catalog.
		expect(settings.get("modelRoles")).toMatchObject({ default: "anthropic/claude-opus-4-6" });
	});

	test("durable default recovery excludes a bundled default absent from the available catalog", async () => {
		const profile: ModelProfileDefinition = {
			name: "excluded-bundled-default",
			requiredProviders: ["anthropic"],
			modelMapping: { default: "anthropic/claude-opus-5-5" },
			source: "builtin",
		};
		const baseRegistry = fakeRegistry({ profiles: [profile] });
		const registry = {
			...baseRegistry,
			getAvailable: () => baseRegistry.getAll().filter(candidate => candidate.id !== "claude-opus-5-5"),
		} as unknown as ModelRegistry;

		expect(registry.getAvailable().some(candidate => candidate.id === "claude-opus-5-5")).toBe(false);
		const recovery = await resolveModelProfileDefaultChain({
			modelRegistry: registry,
			settings: Settings.isolated(),
			profileName: profile.name,
			credentialSessionId: "resume-session",
		});

		expect(recovery).toMatchObject({
			profileName: profile.name,
			entries: ["anthropic/claude-opus-5-5"],
			activeIndex: 1,
			skips: [{ selector: "anthropic/claude-opus-5-5", reason: "unknown_model" }],
		});
		expect(recovery.model).toBeUndefined();
	});

	test.each([
		"user",
		"registry",
	] as const)("durable %s profile recovery rejects an unresolved qualified executor when its default resolves", async source => {
		const profile: ModelProfileDefinition = {
			name: `${source}-unresolved-executor`,
			requiredProviders: ["provider-a"],
			modelMapping: { default: "provider-a/default", executor: "provider-b/missing-executor" },
			source,
		};

		await expect(
			resolveModelProfileDefaultChain({
				modelRegistry: fakeRegistry({ profiles: [profile] }) as unknown as ModelRegistry,
				settings: Settings.isolated(),
				profileName: profile.name,
				credentialSessionId: "resume-session",
			}),
		).rejects.toThrow(/executor selectors do not match any catalog model/);
	});

	test("durable default recovery rejects unknown required providers before credential probing", async () => {
		const profile: ModelProfileDefinition = {
			name: "unknown-recovery-provider",
			requiredProviders: ["future-provider"],
			modelMapping: { default: "provider-a/default" },
			source: "user",
		};
		const baseRegistry = fakeRegistry({ profiles: [profile] });
		const getApiKeyForProvider = vi.fn(async () => "key-provider-a");
		const registry = {
			...baseRegistry,
			getConfiguredProviderIds: () => ["provider-a"],
			isKnownProvider: (provider: string) => provider === "provider-a",
			getApiKeyForProvider,
		} as unknown as ModelRegistry;

		await expect(
			resolveModelProfileDefaultChain({
				modelRegistry: registry,
				settings: Settings.isolated(),
				profileName: profile.name,
				credentialSessionId: "resume-session",
			}),
		).rejects.toBeInstanceOf(ModelProfileUnknownProviderError);
		expect(getApiKeyForProvider).not.toHaveBeenCalled();
	});

	test("durable default recovery reports an unavailable session pin without probing another account", async () => {
		const profile: ModelProfileDefinition = {
			name: "unavailable-pin-recovery",
			requiredProviders: ["provider-a"],
			modelMapping: { default: "provider-a/default" },
			source: "user",
		};
		const getApiKeyForProvider = vi.fn(async () => "another-account-key");
		const registry = {
			...fakeRegistry({ profiles: [profile] }),
			getApiKeyForProvider,
			authStorage: {
				hasRuntimeApiKey: () => false,
				hasLiteralConfigApiKey: () => false,
				hasSessionCredentialUnavailable: (provider: string, scope: string) =>
					provider === "provider-a" && scope === "resume-session",
			},
		} as unknown as ModelRegistry;
		await expect(
			resolveModelProfileDefaultChain({
				modelRegistry: registry,
				settings: Settings.isolated(),
				profileName: profile.name,
				credentialSessionId: "resume-session",
			}),
		).rejects.toMatchObject({ name: "ModelProfileCredentialError", providers: ["provider-a"] });
		expect(getApiKeyForProvider).not.toHaveBeenCalled();
	});

	test("durable default recovery respects runtime API key when OAuth pin is unavailable", async () => {
		const profile: ModelProfileDefinition = {
			name: "unavailable-pin-with-runtime-key",
			requiredProviders: ["provider-a"],
			modelMapping: { default: "provider-a/default" },
			source: "user",
		};
		const getApiKeyForProvider = vi.fn(async () => "runtime-key-value");
		const registry = {
			...fakeRegistry({ profiles: [profile] }),
			getApiKeyForProvider,
			authStorage: {
				hasRuntimeApiKey: () => true,
				hasLiteralConfigApiKey: () => false,
				hasSessionCredentialUnavailable: (provider: string, scope: string) =>
					provider === "provider-a" && scope === "resume-session",
			},
		} as unknown as ModelRegistry;
		const result = await resolveModelProfileDefaultChain({
			modelRegistry: registry,
			settings: Settings.isolated(),
			profileName: profile.name,
			credentialSessionId: "resume-session",
		});
		expect(result.model).toBeDefined();
		expect(getApiKeyForProvider).toHaveBeenCalled();
	});

	test("profile activation reports a pin invalidated during credential probing", async () => {
		const profile: ModelProfileDefinition = {
			name: "pin-invalidated-during-probe",
			requiredProviders: ["provider-a"],
			modelMapping: { default: "provider-a/default" },
			source: "user",
		};
		let unavailable = false;
		const failure = new Error("Selected credential for provider-a (id:13) is unavailable");
		const registry = {
			...fakeRegistry({ profiles: [profile] }),
			getApiKeyForProvider: async () => {
				unavailable = true;
				throw failure;
			},
			authStorage: {
				hasRuntimeApiKey: () => false,
				hasLiteralConfigApiKey: () => false,
				hasSessionCredentialUnavailable: (provider: string, scope: string) =>
					provider === "provider-a" && scope === "session-1" && unavailable,
			},
		} as unknown as ModelRegistry;
		await expect(
			prepareModelProfileActivation({
				session: fakeSession(),
				modelRegistry: registry,
				settings: Settings.isolated(),
				profileName: profile.name,
			}),
		).rejects.toMatchObject({ name: "ModelProfileCredentialError", providers: ["provider-a"] });
	});

	test("profile activation preserves unrelated credential lookup failures", async () => {
		const profile: ModelProfileDefinition = {
			name: "unrelated-auth-failure",
			requiredProviders: ["provider-a"],
			modelMapping: { default: "provider-a/default" },
			source: "user",
		};
		const failure = new Error("OAuth broker failed");
		const registry = {
			...fakeRegistry({ profiles: [profile] }),
			getApiKeyForProvider: async () => {
				throw failure;
			},
			authStorage: {
				hasRuntimeApiKey: () => false,
				hasLiteralConfigApiKey: () => false,
				hasSessionCredentialUnavailable: () => false,
			},
		} as unknown as ModelRegistry;
		await expect(
			prepareModelProfileActivation({
				session: fakeSession(),
				modelRegistry: registry,
				settings: Settings.isolated(),
				profileName: profile.name,
			}),
		).rejects.toBe(failure);
	});

	test("profile activation respects runtime API key precedence over unavailable OAuth pin", async () => {
		const profile: ModelProfileDefinition = {
			name: "runtime-key-unavailable-pin",
			requiredProviders: ["provider-a"],
			modelMapping: { default: "provider-a/default" },
			source: "user",
		};
		const registry = {
			...fakeRegistry({ profiles: [profile] }),
			getApiKeyForProvider: async () => "runtime-key-value",
			authStorage: {
				hasRuntimeApiKey: (provider: string) => provider === "provider-a",
				hasLiteralConfigApiKey: () => false,
				hasSessionCredentialUnavailable: (provider: string, scope: string) =>
					provider === "provider-a" && scope === "session-1",
			},
		} as unknown as ModelRegistry;
		const prepared = await prepareModelProfileActivation({
			session: fakeSession(),
			modelRegistry: registry,
			settings: Settings.isolated(),
			profileName: profile.name,
		});
		expect(prepared.profileName).toBe(profile.name);
	});

	test("profile activation respects config API key precedence over unavailable OAuth pin", async () => {
		const profile: ModelProfileDefinition = {
			name: "config-key-unavailable-pin",
			requiredProviders: ["provider-a"],
			modelMapping: { default: "provider-a/default" },
			source: "user",
		};
		const owner = {};
		const registry = {
			...fakeRegistry({ profiles: [profile] }),
			getAuthStorageOwner: () => owner,
			getApiKeyForProvider: async () => "config-key-value",
			authStorage: {
				hasRuntimeApiKey: () => false,
				// The models.yml key is registered for this registry's owner only.
				hasLiteralConfigApiKey: (provider: string, keyOwner?: object) =>
					provider === "provider-a" && keyOwner === owner,
				hasSessionCredentialUnavailable: (provider: string, scope: string) =>
					provider === "provider-a" && scope === "session-1",
			},
		} as unknown as ModelRegistry;
		const prepared = await prepareModelProfileActivation({
			session: fakeSession(),
			modelRegistry: registry,
			settings: Settings.isolated(),
			profileName: profile.name,
		});
		expect(prepared.profileName).toBe(profile.name);
	});

	test("profile activation fails when OAuth pin unavailable and no explicit credential exists", async () => {
		const profile: ModelProfileDefinition = {
			name: "unavailable-pin-no-explicit-key",
			requiredProviders: ["provider-a"],
			modelMapping: { default: "provider-a/default" },
			source: "user",
		};
		let unavailable = false;
		const failure = new Error("Selected credential for provider-a is unavailable");
		const registry = {
			...fakeRegistry({ profiles: [profile] }),
			getApiKeyForProvider: async () => {
				unavailable = true;
				throw failure;
			},
			authStorage: {
				hasRuntimeApiKey: () => false,
				hasLiteralConfigApiKey: () => false,
				hasSessionCredentialUnavailable: (provider: string, scope: string) =>
					provider === "provider-a" && scope === "session-1" && unavailable,
			},
		} as unknown as ModelRegistry;
		await expect(
			prepareModelProfileActivation({
				session: fakeSession(),
				modelRegistry: registry,
				settings: Settings.isolated(),
				profileName: profile.name,
			}),
		).rejects.toMatchObject({ name: "ModelProfileCredentialError", providers: ["provider-a"] });
	});

	test("durable default recovery accepts a credentialless OpenCodex proxy", async () => {
		const profile: ModelProfileDefinition = {
			name: "credentialless-opencodex-recovery",
			requiredProviders: ["provider-a"],
			modelMapping: { default: "provider-a/default" },
			source: "registry",
		};
		const baseRegistry = fakeRegistry({ profiles: [profile] });
		const proxyModel = model("opencodex", "provider-a/default");
		const registry = {
			...baseRegistry,
			getAll: () => [...baseRegistry.getAll(), proxyModel],
			getAvailable: () => [proxyModel],
			getConfiguredProviderIds: () => [],
			isKnownProvider: (provider: string) => provider === "provider-a" || provider === "opencodex",
			getApiKeyForProvider: async (provider: string) => (provider === "opencodex" ? kNoAuth : "key-provider-a"),
		} as unknown as ModelRegistry;

		const recovery = await resolveModelProfileDefaultChain({
			modelRegistry: registry,
			settings: Settings.isolated({
				"modelProfile.proxyProvider": "opencodex",
				"modelProfile.proxyMode": "always",
			}),
			profileName: profile.name,
			credentialSessionId: "resume-session",
		});

		expect(recovery.model).toMatchObject({ provider: "opencodex", id: "provider-a/default" });
	});

	test("durable default recovery ignores an optional mapped provider auth probe failure", async () => {
		const profile: ModelProfileDefinition = {
			name: "optional-mapped-provider",
			requiredProviders: ["provider-a"],
			modelMapping: { default: "provider-a/default", executor: "provider-b/executor" },
			source: "user",
		};
		const baseRegistry = fakeRegistry({ profiles: [profile] });
		const registry = {
			...baseRegistry,
			getApiKeyForProvider: async (provider: string) => {
				if (provider === "provider-b") throw new Error("optional provider lookup failed");
				return "key-provider-a";
			},
		} as unknown as ModelRegistry;

		await expect(
			resolveModelProfileDefaultChain({
				modelRegistry: registry,
				settings: Settings.isolated(),
				profileName: profile.name,
				credentialSessionId: "resume-session",
			}),
		).resolves.toMatchObject({
			profileName: profile.name,
			entries: ["provider-a/default"],
			model: expect.objectContaining({ provider: "provider-a", id: "default" }),
			activeIndex: 0,
			skips: [],
		});
	});

	test("durable default recovery retains a Cursor head and applies managed fallback safety", async () => {
		const cursor = { ...model("cursor", "agent"), api: "cursor-agent" } as Model;
		const fallback = model("provider-a", "default");
		const profile: ModelProfileDefinition = {
			name: "cursor-recovery",
			requiredProviders: [],
			modelMapping: { default: ["cursor/agent", "provider-a/default"] },
			source: "user",
		};
		const baseRegistry = fakeRegistry({ profiles: [profile] });
		const registry = { ...baseRegistry, getAll: () => [cursor, fallback] } as unknown as ModelRegistry;

		const recovery = await resolveModelProfileDefaultChain({
			modelRegistry: registry,
			settings: Settings.isolated(),
			profileName: profile.name,
			credentialSessionId: "resume-session",
		});

		expect(recovery.entries).toEqual(["cursor/agent", "provider-a/default"]);
		expect(recovery.model).toMatchObject({ provider: "provider-a", id: "default" });
		expect(recovery.activeIndex).toBe(1);
		expect(recovery.skips[0]?.reason).toContain("requires provider-side tool execution");
	});

	test("durable default recovery does not probe a throwing fallback after a callable head", async () => {
		const profile: ModelProfileDefinition = {
			name: "callable-head",
			requiredProviders: ["provider-a"],
			modelMapping: { default: ["provider-a/default", "provider-b/tail"] },
			source: "user",
		};
		const head = model("provider-a", "default");
		const tail = model("provider-b", "tail");
		const baseRegistry = fakeRegistry({ profiles: [profile] });
		const getApiKeyForProvider = vi.fn(async (provider: string) => {
			if (provider === "provider-b") throw new Error("tail credential lookup must not run");
			return "key-provider-a";
		});
		const registry = {
			...baseRegistry,
			getAll: () => [head, tail],
			getApiKeyForProvider,
		} as unknown as ModelRegistry;

		const recovery = await resolveModelProfileDefaultChain({
			modelRegistry: registry,
			settings: Settings.isolated(),
			profileName: profile.name,
			credentialSessionId: "resume-session",
		});

		expect(recovery.entries).toEqual(["provider-a/default", "provider-b/tail"]);
		expect(recovery.model).toMatchObject({ provider: "provider-a", id: "default" });
		expect(recovery.activeIndex).toBe(0);
	});

	test("durable default recovery rejects a required provider auth probe failure", async () => {
		const profile: ModelProfileDefinition = {
			name: "required-provider",
			requiredProviders: ["provider-a"],
			modelMapping: { default: "provider-a/default" },
			source: "user",
		};
		const baseRegistry = fakeRegistry({ profiles: [profile] });
		const registry = {
			...baseRegistry,
			getApiKeyForProvider: async () => {
				throw new Error("required provider lookup failed");
			},
		} as unknown as ModelRegistry;

		await expect(
			resolveModelProfileDefaultChain({
				modelRegistry: registry,
				settings: Settings.isolated(),
				profileName: profile.name,
				credentialSessionId: "resume-session",
			}),
		).rejects.toThrow("required provider lookup failed");
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
				return new Response(JSON.stringify({ data: discoveryCount === 1 ? [{ id: "claude-opus-5-5" }] : [] }), {
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
					.getAvailable()
					.some(candidate => candidate.provider === "anthropic" && candidate.id === "claude-opus-5-5"),
			).toBe(true);
			const notificationsAfterNonEmpty = catalogNotifications;

			await registry.refreshProvider("anthropic", "online");
			expect(catalogNotifications).toBeGreaterThan(notificationsAfterNonEmpty);
			// The bundled Opus 5.5 survives the now-empty live catalog, and the
			// catalog-change notification still fires on the evidence change.
			expect(
				registry
					.getAvailable()
					.some(candidate => candidate.provider === "anthropic" && candidate.id === "claude-opus-5-5"),
			).toBe(true);
		} finally {
			authStorage.close();
			tempDir.removeSync();
		}
	});

	test("built-in claude-opus retains bundled Opus 5.5 after live catalog discovery fails", async () => {
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

			expect(prepared.defaultModel).toMatchObject({ provider: "anthropic", id: "claude-opus-5-5" });
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
							models: [{ id: "claude-opus-5-5" }],
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

			expect(registry.find("anthropic", "claude-opus-5-5")?.baseUrl).toBe(
				"https://custom-anthropic.example.test/v1",
			);
			expect(
				registry
					.getAvailable()
					.some(candidate => candidate.provider === "anthropic" && candidate.id === "claude-opus-5-5"),
			).toBe(true);

			registry.registerProvider("anthropic", {
				baseUrl: "https://runtime-anthropic.example.test/v1",
				api: "anthropic-messages",
				apiKey: "TEST_RUNTIME_ANTHROPIC_KEY",
				models: [
					{
						id: "claude-opus-5-5",
						name: "Runtime Opus 5.5",
						reasoning: true,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 200_000,
						maxTokens: 8_000,
					},
				],
			});
			expect(registry.find("anthropic", "claude-opus-5-5")?.baseUrl).toBe(
				"https://runtime-anthropic.example.test/v1",
			);
			expect(
				registry
					.getAvailable()
					.some(candidate => candidate.provider === "anthropic" && candidate.id === "claude-opus-5-5"),
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

	test("preflight retains its original cause when sticky-variant restoration also fails", async () => {
		const rollbackFailure = new Error("secret-sticky-variant");
		const registry = {
			...fakeRegistry({ missingProviders: ["provider-a"] }),
			getSessionCanonicalVariant: () => "provider-c/default",
			clearCanonicalVariant: () => true,
			restoreSessionCanonicalVariant: () => {
				throw rollbackFailure;
			},
		};
		let failure: unknown;
		try {
			await prepareModelProfileActivation({
				session: fakeSession(),
				modelRegistry: registry,
				settings: Settings.isolated(),
				profileName: "profile-a",
			});
		} catch (error) {
			failure = error;
		}
		expect(failure).toBeInstanceOf(AggregateError);
		const aggregate = failure as AggregateError;
		const stages = aggregate.errors as Error[];
		expect(stages[0]?.cause).toBeInstanceOf(ModelProfileCredentialError);
		expect(stages[1]?.cause).toBe(rollbackFailure);
		expect(aggregate.message).toContain("profile preflight (required credentials unavailable)");
		expect(aggregate.message).toContain("restore canonical model variant (operation failed)");
		expect(aggregate.message).not.toContain("secret-sticky-variant");
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
		const reject = rejectProfileRuntimePublication(settings);
		try {
			await expect(applyPreparedModelProfileActivation(prepared)).rejects.toThrow("runtime publication failed");
			expect(session.getConfiguredModelChain("default")).toEqual(["provider-c/default"]);
		} finally {
			reject.mockRestore();
		}
	});

	test("rollback restores the previous live model even when its credentials are unavailable", async () => {
		const tempDir = TempDir.createSync("@gjc-profile-credential-rollback-");
		const manager = SessionManager.create(tempDir.path(), tempDir.path());
		try {
			const previousModel = model("provider-c", "default");
			const registry = {
				...fakeRegistry(),
				getApiKey: async (candidate: Model) => (candidate.provider === "provider-c" ? undefined : kNoAuth),
			};
			const session = new AgentSession({
				agent: new Agent({ initialState: { model: previousModel, systemPrompt: [], tools: [], messages: [] } }),
				sessionManager: manager,
				settings: Settings.isolated({ "compaction.enabled": false }),
				modelRegistry: registry as unknown as ModelRegistry,
			});
			const settings = Settings.isolated();
			const prepared = await prepareModelProfileActivation({
				session,
				modelRegistry: registry,
				settings,
				profileName: "profile-a",
			});
			const reject = rejectProfileRuntimePublication(settings);
			try {
				await expect(applyPreparedModelProfileActivation(prepared)).rejects.toThrow("runtime publication failed");
				expect(session.model).toBe(previousModel);
				expect(settings.getGlobal("modelProfile.default")).toBeUndefined();
			} finally {
				reject.mockRestore();
			}
		} finally {
			await manager.close();
			tempDir.removeSync();
		}
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
		const reject = rejectProfileRuntimePublication(settings);
		try {
			await expect(applyPreparedModelProfileActivation(prepared)).rejects.toThrow("runtime publication failed");
			expect(session.model).toBeUndefined();
			expect(session.resumeDefaultSelectors).toEqual([]);
		} finally {
			reject.mockRestore();
		}
	});

	test("does not disturb the old session when target authentication fails before mutation", async () => {
		const tempDir = TempDir.createSync("@gjc-profile-pre-mutation-");
		const manager = SessionManager.create(tempDir.path(), tempDir.path());
		try {
			const previousModel = model("provider-c", "default");
			const registry = {
				...fakeRegistry(),
				getApiKey: async () => undefined,
			};
			const session = new AgentSession({
				agent: new Agent({ initialState: { model: previousModel, systemPrompt: [], tools: [], messages: [] } }),
				sessionManager: manager,
				settings: Settings.isolated({ "compaction.enabled": false }),
				modelRegistry: registry as unknown as ModelRegistry,
			});
			const append = vi.spyOn(manager, "appendModelChange");
			const settings = Settings.isolated();
			const prepared = await prepareModelProfileActivation({
				session,
				modelRegistry: registry,
				settings,
				profileName: "profile-a",
			});
			await expect(applyPreparedModelProfileActivation(prepared, { persistDefault: true })).rejects.toThrow(
				"No API key for provider-a/default",
			);
			expect(session.model).toBe(previousModel);
			expect(append).not.toHaveBeenCalled();
			expect(settings.getGlobal("modelProfile.default")).toBeUndefined();
		} finally {
			await manager.close();
			tempDir.removeSync();
		}
	});

	test("model-less rollback disables forward append-only context", async () => {
		const tempDir = TempDir.createSync("@gjc-profile-append-only-rollback-");
		const manager = SessionManager.create(tempDir.path(), tempDir.path());
		try {
			const agent = new Agent({ initialState: { model: undefined, systemPrompt: [], tools: [], messages: [] } });
			const targetModel = model("anthropic", "claude-test");
			const profile: ModelProfileDefinition = {
				name: "append-only-profile",
				requiredProviders: ["anthropic"],
				modelMapping: { default: "anthropic/claude-test" },
				source: "user",
			};
			const base = fakeRegistry({ profiles: [profile] });
			const registry = {
				...base,
				getAll: () => [...base.getAll(), targetModel],
				getApiKey: async () => kNoAuth,
			};
			const session = new AgentSession({
				agent,
				sessionManager: manager,
				settings: Settings.isolated({ "compaction.enabled": false }),
				modelRegistry: registry as unknown as ModelRegistry,
			});
			const settings = Settings.isolated();
			const prepared = await prepareModelProfileActivation({
				session,
				modelRegistry: registry,
				settings,
				profileName: profile.name,
			});
			const reject = rejectProfileRuntimePublication(settings, () => {
				expect(agent.appendOnlyContext).toBeDefined();
			});
			try {
				await expect(applyPreparedModelProfileActivation(prepared)).rejects.toThrow("runtime publication failed");
				expect(session.model).toBeUndefined();
				expect(agent.appendOnlyContext).toBeUndefined();
			} finally {
				reject.mockRestore();
			}
		} finally {
			await manager.close();
			tempDir.removeSync();
		}
	});

	test("retains the original atomic commit error without compensating unchanged durable state", async () => {
		const session = fakeSession();
		const settings = Settings.isolated({ "modelProfile.default": "old-profile" });
		const prepared = await prepareModelProfileActivation({
			session,
			modelRegistry: fakeRegistry(),
			settings,
			profileName: "profile-a",
		});
		const firstFailure = new Error("forward secret-settings-value");
		const commit = vi.spyOn(settings, "commitAtomicBatchWithCurrent").mockRejectedValueOnce(firstFailure);
		const flush = vi.spyOn(settings, "flushOrThrow");
		const restoreModel = vi.spyOn(session, "restoreModelSelectionForRollback");

		let failure: unknown;
		try {
			await applyPreparedModelProfileActivation(prepared, { persistDefault: true });
		} catch (error) {
			failure = error;
		}
		expect(failure).toBe(firstFailure);
		expect(commit).toHaveBeenCalledTimes(1);
		expect(flush).not.toHaveBeenCalled();
		expect(restoreModel).not.toHaveBeenCalled();
		expect(readDurableModelProfileOwnership(settings)).toEqual(prepared.observedOwnership);
		expect(settings.getGlobal("modelProfile.default")).toBe("old-profile");
		expect(session.model?.id).toBe("initial");
	});

	test("labels independent rollback failures without exposing error contents", async () => {
		const session = fakeSession();
		session.setConfiguredModelChain("default", ["provider-c/default"]);
		const settings = Settings.isolated({ "modelProfile.default": "old-profile" });
		const prepared = await prepareModelProfileActivation({
			session,
			modelRegistry: fakeRegistry(),
			settings,
			profileName: "profile-a",
		});
		const original = new Error("forward override token-secret-123");
		const modelRollback = new Error("rollback model token-secret-123");
		const overrideRollback = new Error("rollback override token-secret-123");
		const override = settings.override.bind(settings);
		vi.spyOn(settings, "override").mockImplementation((key, value) => {
			if (key === "task.agentModelOverrides") throw original;
			return override(key, value);
		});
		vi.spyOn(settings, "clearOverride").mockImplementation(() => {
			throw overrideRollback;
		});
		session.restoreModelSelectionForRollback = async () => {
			throw modelRollback;
		};

		let failure: unknown;
		try {
			await applyPreparedModelProfileActivation(prepared);
		} catch (error) {
			failure = error;
		}
		expect(failure).toBeInstanceOf(AggregateError);
		const aggregate = failure as AggregateError;
		const stages = aggregate.errors as Error[];
		expect(stages.map(stage => stage.cause)).toEqual([original, overrideRollback, modelRollback]);
		expect(stages.map(stage => stage.message)).toEqual([
			"agent role overrides (operation failed)",
			"restore model role overrides (operation failed)",
			"restore live model (operation failed)",
		]);
		expect(aggregate.message).toContain("Prior state may be unverified");
		expect(aggregate.message).not.toContain("token-secret-123");
		expect(settings.getGlobal("modelProfile.default")).toBe("old-profile");
		expect(session.getConfiguredModelChain("default")).toEqual(["provider-c/default"]);
		// The failed live-model restore leaves a different runtime model despite the restored settings.
		expect(session.model?.id).toBe("default");
	});

	test("atomic rejection leaves all persisted assignments intact without raw writes or resume lineage", async () => {
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
		const set = vi.spyOn(settings, "set");
		const unset = vi.spyOn(settings, "unset");
		vi.spyOn(settings, "commitAtomicBatchWithCurrent").mockRejectedValueOnce(new Error("set failed"));

		await expect(applyPreparedModelProfileActivation(prepared, { persistDefault: true })).rejects.toThrow(
			"set failed",
		);
		expect(settings.getGlobal("modelRoles")).toEqual({ default: "provider-c/default" });
		expect(settings.getGlobal("task.agentModelOverrides")).toEqual({ executor: "provider-c/executor" });
		expect(settings.getGlobal("modelProfile.default")).toBe("old-profile");
		expect(session.model?.id).toBe("initial");
		expect(session.resumeDefaultSelectors).toEqual([]);
		expect(set).not.toHaveBeenCalled();
		expect(unset).not.toHaveBeenCalled();
	});

	test("atomic rejection from an unconfigured session creates neither a chain nor a resume default", async () => {
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
			vi.spyOn(settings, "commitAtomicBatchWithCurrent").mockRejectedValueOnce(new Error("flush failed"));

			await expect(applyPreparedModelProfileActivation(prepared, { persistDefault: true })).rejects.toThrow(
				"flush failed",
			);
			expect(manager.buildSessionContext().configuredModelChains.default).toBeUndefined();

			await manager.ensureOnDisk();
			await manager.flush();
			const sessionFile = manager.getSessionFile();
			if (!sessionFile) throw new Error("Expected persisted session file");
			await manager.close();

			const reopened = await SessionManager.open(sessionFile);
			try {
				expect(reopened.buildSessionContext().models.default).toBeUndefined();
				expect(reopened.buildSessionContext().configuredModelChains.default).toBeUndefined();
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
					isSelectorCircuitOpen: () => false,
					withConsumerLease: async <T>(body: () => T | Promise<T>): Promise<T> => await body(),
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
					isSelectorCircuitOpen: () => false,
					withConsumerLease: async <T>(body: () => T | Promise<T>): Promise<T> => await body(),
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
				default: "openai-codex/gpt-6-luna:low",
				executor: "openai-codex/gpt-6-luna:low",
				planner: "openai-codex/gpt-6-luna:high",
				critic: "openai-codex/gpt-6-luna:xhigh",
				architect: "openai-codex/gpt-6-luna:high",
			},
		],
		[
			"codex-medium",
			{
				default: "openai-codex/gpt-6.1-sol:low",
				executor: "openai-codex/gpt-6.1-sol:low",
				planner: "openai-codex/gpt-6.1-sol:high",
				critic: "openai-codex/gpt-6.1-sol:xhigh",
				architect: "openai-codex/gpt-6.1-sol:high",
			},
		],
		[
			"codex-pro",
			{
				default: "openai-codex/gpt-6.1-sol:medium",
				executor: "openai-codex/gpt-6.1-sol:medium",
				planner: "openai-codex/gpt-6.1-sol:high",
				critic: "openai-codex/gpt-6.1-sol:max",
				architect: "openai-codex/gpt-6.1-sol:xhigh",
			},
		],
		[
			"opus-codex",
			{
				default: "anthropic/claude-opus-5-5:medium",
				executor: "openai-codex/gpt-6.1-sol:low",
				planner: "anthropic/claude-sonnet-5-5",
				critic: "openai-codex/gpt-6.1-sol:xhigh",
				architect: "openai-codex/gpt-6.1-sol:high",
			},
		],
		[
			"lunamaxxing",
			{
				default: "openai-codex/gpt-6-luna:medium",
				executor: "openai-codex/gpt-6-luna:xhigh",
				planner: "openai-codex/gpt-6-luna:max",
				critic: "openai-codex/gpt-6-luna:max",
				architect: "openai-codex/gpt-6-luna:max",
			},
		],
		[
			"codex-opencodego",
			{
				default: "openai-codex/gpt-6.1-sol:low",
				executor: "opencode-go/deepseek-v4-pro",
				planner: "opencode-go/kimi-k3",
				critic: "opencode-go/mimo-v2.5-pro",
				architect: "openai-codex/gpt-6.1-sol:high",
			},
		],
		[
			"fable-opus-codex",
			{
				default: "anthropic/claude-fable-5-1:high",
				executor: "openai-codex/gpt-6.1-sol:medium",
				planner: "anthropic/claude-opus-5-5:medium",
				critic: "anthropic/claude-opus-5-5:high",
				architect: "openai-codex/gpt-6.1-sol:xhigh",
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

		const commitSelection = vi.spyOn(session, "commitPreparedProfileModelSelection");
		try {
			await activateModelProfile({ session, modelRegistry: fakeRegistry(), settings, profileName: "profile-a" });
			expect(commitSelection).toHaveBeenCalledTimes(1);
		} finally {
			commitSelection.mockRestore();
		}

		expect(session.setModelTemporaryCalls).toEqual([]);
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
		vi.spyOn(settings, "commitAtomicBatchWithCurrent").mockRejectedValueOnce(new Error("flush failed"));

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
		session.setActiveModelProfile("provider-agnostic-profile", true);
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
		expect(session.getActivatedModelProfile()).toBe("profile-a");
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
		session.setActiveModelProfile("profile-a", true);
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

	test("role materialization keeps the activated alternative provider after a CLI override", async () => {
		const profile: ModelProfileDefinition = {
			name: "alternative-provider-profile",
			requiredProviders: [],
			alternativeProviderGroups: [["provider-a", "provider-b"]],
			modelMapping: { default: "provider-a/default", executor: "provider-a/executor" },
			source: "user",
		};
		const baseRegistry = fakeRegistry({ profiles: [profile], missingProviders: ["provider-a"] });
		const defaultAlternative = model("provider-b", "default");
		const executorAlternative = model("provider-b", "executor");
		const registry = {
			...baseRegistry,
			getAll: () => [...baseRegistry.getAll(), defaultAlternative, executorAlternative],
			getAvailable: () => [...baseRegistry.getAll(), defaultAlternative, executorAlternative],
		};
		const startupModel = model("provider-c", "cli-model");
		let profileState: AgentSessionProfileInstalledOverrideState = {
			modelRoles: new Map(),
			agentModelOverrides: new Map(),
			installedModelRoles: new Map(),
			installedAgentModelOverrides: new Map(),
			manualModelRoles: new Set(),
			manualAgentModelOverrides: new Set(),
			configuredAgentModelOverrides: new Set(),
			preProfileModel: undefined,
		};
		const baseSession = fakeSession(model("provider-a", "default"));
		const session = Object.assign(baseSession, {
			modelRegistry: registry as unknown as ModelRegistry,
			getProfileInstalledOverrideState: () => profileState,
			noteProfileInstalledOverrides: (...args: Parameters<AgentSession["noteProfileInstalledOverrides"]>) => {
				const currentChain = baseSession.getConfiguredModelChainState("default");
				const chain =
					args[6] ??
					(currentChain?.origin === "profile-activation" &&
					currentChain.identity === baseSession.getActiveModelProfile()
						? currentChain.entries
						: undefined);
				profileState = {
					...profileState,
					configuredDefaultChain: chain ? [...chain] : undefined,
				};
			},
		});
		const settings = Settings.isolated({ "modelProfile.default": profile.name });
		settings.overrideModelRoles({ default: "cli-model-alias" });
		expect(await registry.getApiKeyForProvider("provider-a")).toBeUndefined();
		expect(await registry.getApiKeyForProvider("provider-b")).toBe("key-provider-b");
		await activateModelProfile({ session, modelRegistry: registry, settings, profileName: profile.name });
		expect(session.getConfiguredModelChain("default")).toEqual(["provider-b/default"]);
		expect(profileState.configuredDefaultChain).toEqual(["provider-b/default"]);

		session.model = startupModel;
		session.setConfiguredModelChain("default", [`${startupModel.provider}/${startupModel.id}`], "startup-override");
		await applyModelProfileRuntimeBindings({ session, modelRegistry: registry, settings, profileName: profile.name });
		expect(session.getConfiguredModelChainState("default")?.origin).toBe("startup-override");
		expect(profileState.configuredDefaultChain).toEqual(["provider-b/default"]);

		materializeActiveModelProfileAssignment({
			session,
			settings,
			role: "executor",
			selector: "provider-c/executor",
		});
		expect(session.model).toBe(startupModel);
		expect(session.getConfiguredModelChainState("default")).toMatchObject({
			entries: [`${startupModel.provider}/${startupModel.id}`],
			origin: "startup-override",
		});

		const reloadedSettings = Settings.isolated({
			modelRoles: settings.getGlobal("modelRoles"),
			"task.agentModelOverrides": settings.getGlobal("task.agentModelOverrides"),
			"modelProfile.default": settings.getGlobal("modelProfile.default"),
		});
		expect(settings.getGlobal("modelRoles")?.default).toBe("provider-b/default");
		expect(reloadedSettings.getModelRole("default")).toBe("provider-b/default");
		expect(reloadedSettings.getGlobal("modelProfile.default")).toBeUndefined();
	});

	test("materializing a role-only profile does not promote a startup model to the global default", async () => {
		const profile: ModelProfileDefinition = {
			name: "role-only-profile",
			requiredProviders: [],
			modelMapping: { executor: "provider-b/executor" },
			source: "user",
		};
		const baseRegistry = fakeRegistry({ profiles: [profile] });
		const registry = { ...baseRegistry, getAvailable: () => baseRegistry.getAll() };
		const startupModel = model("provider-c", "cli-model");
		const session = Object.assign(fakeSession(startupModel), { modelRegistry: registry as unknown as ModelRegistry });
		const settings = Settings.isolated({ "modelProfile.default": profile.name });
		settings.overrideModelRoles({ default: "cli-model-alias" });
		await activateModelProfile({ session, modelRegistry: registry, settings, profileName: profile.name });

		session.model = startupModel;
		session.setConfiguredModelChain("default", [`${startupModel.provider}/${startupModel.id}`], "startup-override");

		materializeActiveModelProfileAssignment({
			session,
			settings,
			role: "executor",
			selector: "provider-c/executor",
		});

		expect(settings.getGlobal("modelRoles")?.default).toBeUndefined();
	});

	test("role selections never materialize a persisted profile whose activation failed", async () => {
		const baseRegistry = fakeRegistry({ missingProviders: ["provider-a"] });
		const registry = { ...baseRegistry, getAvailable: () => baseRegistry.getAll() };
		const startupModel = model("provider-c", "cli-model");
		const startupSelector = `${startupModel.provider}/${startupModel.id}`;
		const session = Object.assign(fakeSession(startupModel), { modelRegistry: registry as unknown as ModelRegistry });
		const settings = Settings.isolated({ "modelProfile.default": "profile-a" });
		await expect(
			activateModelProfile({ session, modelRegistry: registry, settings, profileName: "profile-a" }),
		).rejects.toBeInstanceOf(ModelProfileCredentialError);
		expect(session.getActiveModelProfile()).toBeUndefined();

		settings.overrideModelRoles({ default: startupSelector });
		session.setConfiguredModelChain("default", [startupSelector], "startup-override");

		expect(
			materializeActiveModelProfileAssignments({
				session,
				settings,
				assignments: new Map([["executor", "provider-c/executor"]]),
			}),
		).toBe(false);
		expect(
			materializeActiveModelProfileAssignment({
				session,
				settings,
				role: "architect",
				selector: "provider-c/architect",
			}),
		).toBe(false);
		// Callers fall back to persisting only the requested roles.
		settings.setAgentModelOverride("executor", "provider-c/executor");
		settings.setAgentModelOverride("architect", "provider-c/architect");

		expect(session.getConfiguredModelChainState("default")).toMatchObject({
			entries: [startupSelector],
			origin: "startup-override",
		});
		const reloadedSettings = Settings.isolated({
			modelRoles: settings.getGlobal("modelRoles"),
			"task.agentModelOverrides": settings.getGlobal("task.agentModelOverrides"),
			"modelProfile.default": settings.getGlobal("modelProfile.default"),
		});
		expect(reloadedSettings.getGlobal("modelProfile.default")).toBe("profile-a");
		expect(reloadedSettings.getModelRole("default")).toBeUndefined();
		expect(reloadedSettings.getGlobal("task.agentModelOverrides")).toEqual({
			executor: "provider-c/executor",
			architect: "provider-c/architect",
		});
	});

	test("an explicit default selection still supersedes a persisted profile whose activation failed", async () => {
		const registry = fakeRegistry({ missingProviders: ["provider-a"] });
		const session = Object.assign(fakeSession(model("provider-c", "cli-model")), {
			modelRegistry: { ...registry, getAvailable: () => registry.getAll() } as unknown as ModelRegistry,
		});
		const settings = Settings.isolated({ "modelProfile.default": "profile-a" });
		await expect(
			activateModelProfile({ session, modelRegistry: registry, settings, profileName: "profile-a" }),
		).rejects.toBeInstanceOf(ModelProfileCredentialError);
		session.setConfiguredModelChain("default", ["provider-c/cli-model"], "startup-override");

		expect(
			materializeActiveModelProfileAssignment({
				session,
				settings,
				role: "default",
				selector: "provider-c/default",
			}),
		).toBe(true);
		expect(settings.getGlobal("modelRoles")).toEqual({ default: "provider-c/default" });
		expect(settings.getGlobal("modelProfile.default")).toBeUndefined();
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

	test("seeded materialization properties preserve failed profiles and startup defaults", () => {
		const seed = 0x6881;
		const random = seededRandom(seed);
		const assignmentKinds = ["single", "batch"] as const;

		for (let index = 0; index < 24; index++) {
			const durableProfile = `durable-profile-${index}`;
			const durableDefault = generatedSelector(random, "durable-default", index);
			const startupSelector = generatedSelector(random, "startup", index);
			const storedExecutor = generatedSelector(random, "stored-executor", index);

			for (const kind of assignmentKinds) {
				const inactiveSession = fakeSession(model("startup-provider", `startup-model-${index}`));
				inactiveSession.setConfiguredModelChain("default", [startupSelector], "startup-override");
				const inactiveSettings = Settings.isolated({
					"modelProfile.default": durableProfile,
					modelRoles: { default: durableDefault },
					"task.agentModelOverrides": { executor: storedExecutor },
				});
				const inactiveMaterialized =
					kind === "single"
						? materializeActiveModelProfileAssignment({
								session: inactiveSession,
								settings: inactiveSettings,
								role: "executor",
								selector: generatedSelector(random, "selected-single", index),
							})
						: materializeActiveModelProfileAssignments({
								session: inactiveSession,
								settings: inactiveSettings,
								assignments: new Map([
									["executor", generatedSelector(random, "selected-executor", index)],
									["architect", generatedSelector(random, "selected-architect", index)],
								]),
							});
				expect(inactiveMaterialized).toBe(false);
				expect(inactiveSettings.getGlobal("modelProfile.default")).toBe(durableProfile);
				expect(inactiveSettings.getGlobal("modelRoles")?.default).toBe(durableDefault);
				expect(inactiveSettings.getGlobal("task.agentModelOverrides")?.executor).toBe(storedExecutor);
			}

			const activeProfile = `activated-profile-${index}`;
			const profileDefault =
				index % 4 === 3
					? undefined
					: index % 4 === 2
						? [
								generatedSelector(random, "profile-default-head", index),
								generatedSelector(random, "profile-default-fallback", index),
							]
						: generatedSelector(random, "profile-default", index);
			const globalDefault =
				index % 5 === 4
					? undefined
					: index % 5 === 2
						? [
								generatedSelector(random, "global-default-head", index),
								generatedSelector(random, "global-default-fallback", index),
							]
						: generatedSelector(random, "global-default", index);
			const activatedDefaultChain =
				index % 4 === 0
					? [
							generatedSelector(random, "activated-chain-head", index),
							generatedSelector(random, "activated-chain-fallback", index),
						]
					: index % 4 === 1
						? [generatedSelector(random, "activated-chain-head", index)]
						: undefined;
			const expectedDefault = activatedDefaultChain?.length
				? activatedDefaultChain.length === 1
					? activatedDefaultChain[0]
					: [...activatedDefaultChain]
				: (profileDefault ?? globalDefault);
			expect(resolveMaterializationProfileIdentity(undefined, durableProfile, false)).toBeUndefined();
			expect(resolveMaterializationProfileIdentity(undefined, durableProfile, true)).toBe(durableProfile);
			expect(resolveMaterializationProfileIdentity(activeProfile, durableProfile, false)).toBe(activeProfile);
			expect(resolveMaterializedDefaultSelector(activatedDefaultChain, profileDefault, globalDefault)).toEqual(
				expectedDefault,
			);

			const profile: ModelProfileDefinition = {
				name: activeProfile,
				requiredProviders: [],
				modelMapping: profileDefault === undefined ? {} : { default: profileDefault },
				source: "user",
			};
			const baseRegistry = fakeRegistry({ profiles: [profile] });
			const registry = {
				...baseRegistry,
				getAvailable: () => [],
			} as unknown as ModelRegistry;
			const profileInstalledState: AgentSessionProfileInstalledOverrideState = {
				modelRoles: new Map(),
				agentModelOverrides: new Map(),
				installedModelRoles: new Map(),
				installedAgentModelOverrides: new Map(),
				manualModelRoles: new Set(),
				manualAgentModelOverrides: new Set(),
				configuredAgentModelOverrides: new Set(),
				configuredDefaultChain: activatedDefaultChain,
				preProfileModel: undefined,
			};

			for (const kind of assignmentKinds) {
				const activeSession = Object.assign(fakeSession(model("startup-provider", `startup-model-${index}`)), {
					modelRegistry: registry,
					getProfileInstalledOverrideState: () => profileInstalledState,
				});
				activeSession.setActiveModelProfile(activeProfile, true);
				activeSession.setConfiguredModelChain("default", [startupSelector], "startup-override");
				const activeSettings = Settings.isolated({
					"modelProfile.default": activeProfile,
					modelRoles: globalDefault === undefined ? {} : { default: globalDefault },
				});
				activeSettings.overrideModelRoles({ default: startupSelector });

				const activeMaterialized =
					kind === "single"
						? materializeActiveModelProfileAssignment({
								session: activeSession,
								settings: activeSettings,
								role: "executor",
								selector: generatedSelector(random, "active-single", index),
							})
						: materializeActiveModelProfileAssignments({
								session: activeSession,
								settings: activeSettings,
								assignments: new Map([
									["executor", generatedSelector(random, "active-executor", index)],
									["architect", generatedSelector(random, "active-architect", index)],
								]),
							});
				expect(activeMaterialized).toBe(true);
				expect(activeSettings.getGlobal("modelRoles")?.default).toEqual(expectedDefault);
				expect(activeSettings.getGlobal("modelRoles")?.default).not.toBe(startupSelector);
				expect(activeSettings.getGlobal("modelProfile.default")).toBeUndefined();
				expect(activeSession.getConfiguredModelChainState("default")).toMatchObject({
					entries: [startupSelector],
					origin: "startup-override",
				});
			}
		}
	});

	test("--default commits ownership, projection, cleared assignments, and effective thinking in one atomic batch without raw writes", async () => {
		const session = fakeSession();
		const settings = Settings.isolated({
			modelRoles: { default: "provider-c/default" },
			"task.agentModelOverrides": { critic: "provider-c/architect" },
		});
		const set = vi.spyOn(settings, "set");
		const unset = vi.spyOn(settings, "unset");
		const flush = vi.spyOn(settings, "flushOrThrow");
		const commit = settings.commitAtomicBatchWithCurrent.bind(settings);
		const batches: Array<readonly SettingsAtomicPatch[]> = [];
		vi.spyOn(settings, "commitAtomicBatchWithCurrent").mockImplementation(build =>
			commit(async current => {
				expect(session.model?.id).toBe("initial");
				expect(session.getActiveModelProfile()).toBeUndefined();
				const patches = await build(current);
				batches.push(patches);
				return patches;
			}),
		);

		await activateModelProfile(
			{ session, modelRegistry: fakeRegistry(), settings, profileName: "profile-a" },
			{ persistDefault: true, thinkingLevelOverride: ThinkingLevel.Low },
		);

		expect(batches).toEqual([
			[
				{
					path: "modelProfile.ownership",
					op: "set",
					value: { schemaVersion: 1, version: 1, marker: { kind: "profile", profile: "profile-a" } },
				},
				{ path: "modelProfile.default", op: "set", value: "profile-a" },
				{ path: "modelRoles", op: "set", value: {} },
				{ path: "task.agentModelOverrides", op: "set", value: {} },
				{ path: "defaultThinkingLevel", op: "set", value: ThinkingLevel.Low },
			],
		]);
		expect(set).not.toHaveBeenCalled();
		expect(unset).not.toHaveBeenCalled();
		expect(flush).not.toHaveBeenCalled();
		expect(settings.getGlobal("modelRoles")).toEqual({});
		expect(settings.getGlobal("task.agentModelOverrides")).toEqual({});
		expect(settings.getGlobal("defaultThinkingLevel")).toBe(ThinkingLevel.Low);
		expect(settings.getGlobal("modelProfile.default")).toBe("profile-a");
		expect(readDurableModelProfileOwnership(settings)).toEqual({
			schemaVersion: 1,
			version: 1,
			marker: { kind: "profile", profile: "profile-a" },
		});
		expect(session.thinkingLevel).toBe(ThinkingLevel.Low);
		expect(session.getActiveModelProfile()).toBe("profile-a");
	});

	test("rolls back stale persisted activation without overwriting the newer model selection", async () => {
		const session = fakeSession();
		const settings = Settings.isolated({
			modelRoles: { default: "provider-a/previous", architect: "provider-c/previous-architect" },
			"task.agentModelOverrides": { critic: "provider-c/previous-critic" },
			"modelProfile.default": "old-profile",
			defaultThinkingLevel: ThinkingLevel.Low,
		});
		const prepared = await prepareModelProfileActivation({
			session,
			modelRegistry: fakeRegistry(),
			settings,
			profileName: "profile-a",
		});
		const selectedModel = model("provider-c", "selected");
		let selectionRevision = 0;
		let commitCount = 0;
		const commit = settings.commitAtomicBatchWithCurrent.bind(settings);
		vi.spyOn(settings, "commitAtomicBatchWithCurrent").mockImplementation(async build => {
			commitCount += 1;
			selectionRevision += 1;
			session.model = selectedModel;
			session.thinkingLevel = ThinkingLevel.Medium;
			settings.setModelRole("default", "provider-c/selected");
			settings.clearOverride("modelRoles");
			settings.clearOverride("task.agentModelOverrides");
			settings.setAgentModelOverride("executor", "provider-c/selected-executor");
			settings.unset("modelProfile.default");
			session.setConfiguredModelChain("default", ["provider-c/selected"], "model_selection");
			return commit(build);
		});

		await expect(
			applyPreparedModelProfileActivation(prepared, {
				persistDefault: true,
				isCurrent: () => selectionRevision === 0,
			}),
		).rejects.toThrow(/changed|supersed|concurrent/i);

		expect(session.model).toBe(selectedModel);
		expect(session.getConfiguredModelChainState("default")?.origin).toBe("model_selection");
		expect(settings.getModelRole("default")).toBe("provider-c/selected");
		expect(settings.getGlobal("modelRoles")).toEqual({
			default: "provider-c/selected",
			architect: "provider-c/previous-architect",
		});
		expect(settings.get("modelProfile.default")).toBeUndefined();
		expect(settings.get("task.agentModelOverrides")).toEqual({
			critic: "provider-c/previous-critic",
			executor: "provider-c/selected-executor",
		});
		expect(settings.getOverride("modelRoles")).toBeUndefined();
		expect(settings.getOverride("task.agentModelOverrides")).toBeUndefined();
		expect(settings.get("defaultThinkingLevel")).toBe(ThinkingLevel.Low);
		expect(commitCount).toBe(1);
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
	test("required provider this build does not know is a build mismatch, not a credential gap", async () => {
		const session = fakeSession();
		const settings = Settings.isolated({
			"task.agentModelOverrides": { executor: "provider-a/original" },
			"modelProfile.default": "old-profile",
		});
		const profile: ModelProfileDefinition = {
			name: "from-newer-build",
			requiredProviders: ["openai-codex", "future-provider-x"],
			modelMapping: { default: "future-provider-x/default" },
			source: "user",
		};
		const registry = {
			...fakeRegistry({ profiles: [profile] }),
			getConfiguredProviderIds: () => [],
		} as unknown as ModelRegistry;

		const error = (await prepareModelProfileActivation({
			session,
			modelRegistry: registry,
			settings,
			profileName: profile.name,
		}).catch((caught: unknown) => caught)) as ModelProfileUnknownProviderError;

		expect(error).toBeInstanceOf(ModelProfileUnknownProviderError);
		expect(error).toBeInstanceOf(ModelProfileCredentialError);
		expect(error.code).toBe("unknown_provider");
		// Only the undeclared, unshipped provider is named; openai-codex ships in
		// every build and stays a credential concern.
		expect(error.providers).toEqual(["future-provider-x"]);
		expect(error.message).toBe(
			'Model profile "from-newer-build" requires provider(s) this build does not know: future-provider-x. The profile likely targets a newer or custom build; declare the provider(s) in models.yml or use a build that ships them.',
		);
		expect(error.message).not.toContain("Run /login");
		expect(session.setModelTemporaryCalls).toEqual([]);
		expect(settings.get("modelProfile.default")).toBe("old-profile");
	});

	test("required provider declared in models.yml keeps the credential diagnosis", async () => {
		const profile: ModelProfileDefinition = {
			name: "declared-provider",
			requiredProviders: ["future-provider-x"],
			modelMapping: { default: "future-provider-x/default" },
			source: "user",
		};
		const registry = {
			...fakeRegistry({ missingProviders: ["future-provider-x"], profiles: [profile] }),
			getConfiguredProviderIds: () => ["future-provider-x"],
		} as unknown as ModelRegistry;

		await expect(
			activateModelProfile({
				session: fakeSession(),
				modelRegistry: registry,
				settings: Settings.isolated(),
				profileName: profile.name,
			}),
		).rejects.toThrow(
			'Model profile "declared-provider" requires credentials for: future-provider-x. Run /login and configure the missing provider(s), then retry.',
		);
	});

	test("alternative groups only report unknown providers when every member is unknown", async () => {
		const profile: ModelProfileDefinition = {
			name: "alternative-provider-group",
			requiredProviders: ["future-provider-x", "provider-a"],
			alternativeProviderGroups: [["future-provider-x", "provider-a"]],
			modelMapping: { default: "provider-a/default" },
			source: "user",
		};
		const registry = {
			...fakeRegistry({ missingProviders: ["future-provider-x"], profiles: [profile] }),
			getConfiguredProviderIds: () => ["provider-a"],
		} as unknown as ModelRegistry;

		const prepared = await prepareModelProfileActivation({
			session: fakeSession(),
			modelRegistry: registry,
			settings: Settings.isolated(),
			profileName: profile.name,
		});

		expect(prepared.defaultModel).toMatchObject({ provider: "provider-a", id: "default" });
	});

	test("runtime-registered provider satisfies the unknown-provider gate", async () => {
		const tempDir = TempDir.createSync("@gjc-profile-runtime-provider-");
		const authStorage = await AuthStorage.create(`${tempDir.path()}/auth.db`);
		const runtimeRegistry = new ModelRegistry(authStorage, `${tempDir.path()}/models.yml`);
		try {
			runtimeRegistry.registerProvider("runtime-provider", {
				baseUrl: "https://runtime-provider.example.test/v1",
				api: "openai-completions",
				apiKey: "RUNTIME_PROVIDER_KEY",
				models: [
					{
						id: "default",
						name: "Runtime Default",
						reasoning: false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 1000,
						maxTokens: 1000,
					},
				],
			});
			expect(runtimeRegistry.isKnownProvider("runtime-provider")).toBe(true);

			const profile: ModelProfileDefinition = {
				name: "runtime-provider-profile",
				requiredProviders: ["runtime-provider"],
				modelMapping: { default: "runtime-provider/default" },
				source: "user",
			};
			const baseRegistry = fakeRegistry({ profiles: [profile] });
			const registry = {
				...baseRegistry,
				getConfiguredProviderIds: () => [],
				isKnownProvider: runtimeRegistry.isKnownProvider.bind(runtimeRegistry),
				getApiKeyForProvider: runtimeRegistry.getApiKeyForProvider.bind(runtimeRegistry),
				getAll: runtimeRegistry.getAll.bind(runtimeRegistry),
				getAvailable: runtimeRegistry.getAvailable.bind(runtimeRegistry),
			} as unknown as ModelRegistry;

			const prepared = await prepareModelProfileActivation({
				session: fakeSession(),
				modelRegistry: registry,
				settings: Settings.isolated(),
				profileName: profile.name,
			});

			expect(prepared.defaultModel).toMatchObject({ provider: "runtime-provider", id: "default" });
		} finally {
			await runtimeRegistry.dispose();
			authStorage.close();
			tempDir.removeSync();
		}
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
		vi.spyOn(settings, "commitAtomicBatchWithCurrent").mockRejectedValueOnce(new Error("flush failed"));

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
	| "isSelectorCircuitOpen"
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
		isSelectorCircuitOpen: () => false,
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
					withConsumerLease: async <T>(body: () => T | Promise<T>): Promise<T> => await body(),
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

	test("canceled recovered runtime preparation restores sticky state for temporary choices", async () => {
		const profile: ModelProfileDefinition = {
			name: "credential-gated",
			requiredProviders: ["provider-a"],
			modelMapping: { default: "opus" },
			source: "user",
		};
		const { registry, sticky } = stickyAliasRegistry({ profiles: [profile] });
		const session = fakeSession(model("provider-a", "opus-real"));
		sticky.set(session.sessionId, "provider-a/opus-real");
		Object.assign(session, {
			getUserCanonicalVariantSelection: () => ({ revision: 0, canonicalVariant: "provider-a/opus-real" }),
		});
		const apiKey = Promise.withResolvers<string | undefined>();
		const probeStarted = Promise.withResolvers<void>();
		let probeBlocked = false;
		vi.spyOn(registry, "getApiKeyForProvider").mockImplementation(async () => {
			if (probeBlocked) return "key-provider-a";
			probeBlocked = true;
			probeStarted.resolve();
			return apiKey.promise;
		});
		let current = true;
		const activation = applyModelProfileRuntimeBindings(
			{ session, modelRegistry: registry, settings: Settings.isolated(), profileName: profile.name },
			() => current,
		);

		await probeStarted.promise;
		current = false;
		apiKey.resolve("key-provider-a");
		await activation;

		expect(sticky.get(session.sessionId)).toBe("provider-a/opus-real");
		expect(session.getActiveModelProfile()).toBeUndefined();
	});

	test("canceled preparation preserves a newer concrete canonical selection", async () => {
		const profile: ModelProfileDefinition = {
			name: "credential-gated",
			requiredProviders: ["provider-a"],
			modelMapping: { default: "opus" },
			source: "user",
		};
		const { registry, sticky } = stickyAliasRegistry({ profiles: [profile] });
		const session = fakeSession(model("provider-a", "opus-real"));
		sticky.set(session.sessionId, "provider-a/opus-real");
		let userCanonicalSelection = { revision: 0, canonicalVariant: "provider-a/opus-real" as string | undefined };
		Object.assign(session, { getUserCanonicalVariantSelection: () => userCanonicalSelection });
		const apiKey = Promise.withResolvers<string | undefined>();
		const probeStarted = Promise.withResolvers<void>();
		let probeBlocked = false;
		vi.spyOn(registry, "getApiKeyForProvider").mockImplementation(async () => {
			if (probeBlocked) return "key-provider-a";
			probeBlocked = true;
			probeStarted.resolve();
			return apiKey.promise;
		});
		let current = true;
		const activation = applyModelProfileRuntimeBindings(
			{ session, modelRegistry: registry, settings: Settings.isolated(), profileName: profile.name },
			() => current,
		);

		await probeStarted.promise;
		userCanonicalSelection = { revision: 1, canonicalVariant: "provider-b/opus-real" };
		sticky.set(session.sessionId, "provider-b/opus-real");
		current = false;
		apiKey.resolve("key-provider-a");
		await activation;

		expect(sticky.get(session.sessionId)).toBe("provider-b/opus-real");
		expect(session.getActiveModelProfile()).toBeUndefined();
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

		vi.spyOn(settings, "commitAtomicBatchWithCurrent").mockRejectedValueOnce(new Error("flush failed"));
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

	test("profile deletion failure and restore retain explicit same-value role ownership", async () => {
		const profile: ModelProfileDefinition = {
			name: "delete-owner-profile",
			requiredProviders: [],
			modelMapping: { default: "provider-a/default", planner: "provider-b/executor" },
			source: "user",
		};
		const initialOwnership: AgentSessionProfileInstalledOverrideState = {
			modelRoles: new Map(),
			agentModelOverrides: new Map([["planner", "provider-b/executor"]]),
			installedModelRoles: new Map(),
			installedAgentModelOverrides: new Map([["planner", "provider-b/executor"]]),
			manualModelRoles: new Set<string>(),
			manualAgentModelOverrides: new Set(["planner"]),
			configuredAgentModelOverrides: new Set<string>(),
			preProfileModel: undefined,
		};
		const emptyOwnership = (): AgentSessionProfileInstalledOverrideState => ({
			modelRoles: new Map(),
			agentModelOverrides: new Map(),
			installedModelRoles: new Map(),
			installedAgentModelOverrides: new Map(),
			manualModelRoles: new Set(),
			manualAgentModelOverrides: new Set(),
			configuredAgentModelOverrides: new Set(),
			preProfileModel: undefined,
		});
		let activeProfile: string | undefined = profile.name;
		let ownership = initialOwnership;
		const session = Object.assign(fakeSession(), {
			getActiveModelProfile: () => activeProfile,
			setActiveModelProfile: (name: string | undefined) => {
				if (name !== activeProfile) {
					ownership = {
						...ownership,
						manualModelRoles: new Set(),
						manualAgentModelOverrides: new Set(),
					};
				}
				activeProfile = name;
			},
			getProfileInstalledOverrideKeys: () => ({ modelRoles: [], agentModelOverrides: ["planner"] }),
			getProfileInstalledOverrideState: () => ownership,
			restoreProfileInstalledOverrideState: (state: AgentSessionProfileInstalledOverrideState) => {
				ownership = state;
			},
			clearProfileInstalledOverrides: () => {
				ownership = emptyOwnership();
			},
		});
		const registry = fakeRegistry({ profiles: [profile] });
		const settings = Settings.isolated({
			"modelProfile.default": profile.name,
			"task.agentModelOverrides": { planner: "provider-b/executor" },
		});
		settings.override("task.agentModelOverrides", { planner: "provider-b/executor" });
		vi.spyOn(settings, "flushOrThrow").mockRejectedValueOnce(new Error("flush failed"));

		await expect(
			materializeModelProfileForDeletion({ session, modelRegistry: registry, settings, profileName: profile.name }),
		).rejects.toThrow("flush failed");
		expect(session.getActiveModelProfile()).toBe(profile.name);
		expect(ownership).toEqual(initialOwnership);

		const snapshot = await materializeModelProfileForDeletion({
			session,
			modelRegistry: registry,
			settings,
			profileName: profile.name,
		});
		expect(ownership.manualAgentModelOverrides.size).toBe(0);
		await restoreMaterializedModelProfileForDeletion({ settings, session, snapshot });

		expect(session.getActiveModelProfile()).toBe(profile.name);
		expect(ownership).toEqual(initialOwnership);
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
	test("preserves an exported model when native discovery also exposes its wire id", () => {
		const models = [
			model("opencodex", "anthropic/claude-opus-5-5"),
			{ ...model("opencodex", "opencodex/anthropic/claude-opus-5-5"), wireModelId: "anthropic/claude-opus-5-5" },
		];
		expect(
			rewriteSelectorForProxy(
				"anthropic/claude-opus-5-5",
				"opencodex",
				"always",
				models,
				new Set(),
				new Set(["anthropic"]),
			),
		).toBe("opencodex/anthropic/claude-opus-5-5");
	});

	test("retains public proxy aliases when a distinct wire id is configured", () => {
		const alias = { ...model("litellm", "xai/grok-4.3"), wireModelId: "deployment-42" };
		expect(
			rewriteSelectorForProxy("xai/grok-4.3:high", "litellm", "always", [alias], new Set(), new Set(["xai"])),
		).toBe("litellm/xai/grok-4.3:high");
	});

	test("rejects ambiguous wire ids instead of choosing an arbitrary pool route", () => {
		const aliases = ["one", "two"].map(id => ({ ...model("opencodex", id), wireModelId: "gpt-5.6-terra" }));
		expect(() =>
			rewriteSelectorForProxy(
				"openai-codex/gpt-5.6-terra",
				"opencodex",
				"always",
				aliases,
				new Set(),
				new Set(["openai-codex"]),
			),
		).toThrow("ambiguous models");
	});

	test("routes every Opus + Codex role through discovered OpenCodex without a models.yml entry", async () => {
		const profile = BUILTIN_MODEL_PROFILES.find(candidate => candidate.name === "opus-codex")!;
		const base = fakeRegistry({ profiles: [profile] });
		const discovered = base
			.getAll()
			.filter(model => model.provider === "anthropic" || model.provider === "openai-codex")
			.map(model => {
				const wireModelId = model.provider === "anthropic" ? `anthropic/${model.id}` : model.id;
				return { ...model, provider: "opencodex", id: `opencodex/${wireModelId}`, wireModelId };
			});
		const registry = {
			...base,
			getAll: () => [...base.getAll(), ...discovered],
			getConfiguredProviderIds: () => [],
			getApiKeyForProvider: async (provider: string) => (provider === "opencodex" ? kNoAuth : `key-${provider}`),
		};
		const prepared = await prepareModelProfileActivation({
			session: fakeSession(),
			modelRegistry: registry as unknown as ModelRegistry,
			settings: Settings.isolated({ "modelProfile.proxyProvider": "opencodex", "modelProfile.proxyMode": "always" }),
			profileName: "opus-codex",
		});
		expect(prepared.defaultModel?.provider).toBe("opencodex");
		expect(prepared.defaultModel?.wireModelId).toBe("anthropic/claude-opus-5-5");
		expect(prepared.agentModelOverrides).toEqual({
			executor: "opencodex/opencodex/gpt-6.1-sol:low",
			architect: "opencodex/opencodex/gpt-6.1-sol:high",
			planner: "opencodex/opencodex/anthropic/claude-sonnet-5-5",
			critic: "opencodex/opencodex/gpt-6.1-sol:xhigh",
		});
	});

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
				withConsumerLease: async <T>(body: () => T | Promise<T>): Promise<T> => await body(),
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
					withConsumerLease: async <T>(body: () => T | Promise<T>): Promise<T> => await body(),
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
			// acme-private models a user-declared custom provider, so it must be
			// part of the configured ids or activation diagnoses it as a provider
			// this build does not know instead of a missing credential.
			getConfiguredProviderIds: () => ["litellm", "acme-private"],
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
				withConsumerLease: async <T>(body: () => T | Promise<T>): Promise<T> => await body(),
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
					withConsumerLease: async <T>(body: () => T | Promise<T>): Promise<T> => await body(),
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
