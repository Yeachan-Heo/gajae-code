import { afterEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@gajae-code/agent-core";
import * as compactionModule from "@gajae-code/agent-core/compaction";
import type { Model } from "@gajae-code/ai/core";
import { setModelPresetRegistryDisabled } from "@gajae-code/coding-agent/config/model-preset-registry";
import {
	ModelProfileRegistryError,
	UnknownModelProfileError,
} from "@gajae-code/coding-agent/config/model-profile-contract";
import {
	commitDurableModelProfileOwnership,
	type DurableModelProfileOwnership,
	readDurableModelProfileOwnership,
} from "@gajae-code/coding-agent/config/model-profile-ownership";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { CONFIG_SCHEMA_VERSION } from "@gajae-code/coding-agent/config/settings-schema";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { createDesktopPreferencesController, DesktopPreferenceError } from "../src/preferences-controls";
import type { DesktopPreferenceAction, DesktopSamplingParameter } from "../src/preferences-protocol";

const provider = "desktop-preferences-fixture";
const key = "private-fixture-key-never-send";
const sampling: readonly DesktopSamplingParameter[] = [
	"temperature",
	"topP",
	"topK",
	"minP",
	"presencePenalty",
	"repetitionPenalty",
];
const selector = (id: string) => `${provider}/${id}`;
const model = (id: string): Model => ({
	id,
	name: `Fixture ${id}`,
	provider,
	api: "openai-completions",
	baseUrl: "https://example.invalid/private-endpoint",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 4096,
	maxTokens: 1024,
});
const profile = (defaultModel: string) => ({
	display_name: `Desktop ${defaultModel}`,
	required_providers: [provider],
	model_mapping: { default: selector(defaultModel), executor: selector("worker") },
});

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	vi.restoreAllMocks();
	while (cleanups.length > 0) await cleanups.pop()?.();
});

/** Real public SDK session, registry, catalog and persistence. No provider turns or online refresh. */
async function fixture(
	options: { durable?: boolean; invalidRegistry?: boolean; noModel?: boolean; project?: boolean } = {},
) {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-preferences-"));
	const agentDir = path.join(directory, "custom-agent");
	await fs.mkdir(agentDir);
	if (options.project) {
		await fs.mkdir(path.join(directory, ".gjc"));
		await Bun.write(
			path.join(directory, ".gjc", "config.yml"),
			JSON.stringify({
				modelProfile: { default: "desk-a" },
				task: { agentModelOverrides: { planner: selector("worker") } },
			}),
		);
	}
	await setModelPresetRegistryDisabled({ agentDir, disabled: true });
	const settings = options.durable
		? await Settings.loadForScope({ cwd: directory, agentDir })
		: Settings.isolated({ "compaction.enabled": false });
	if (options.durable) {
		// Initialize the same fixture setting as the memory case and finish normal
		// schema migration before any controller/config-preservation baseline.
		settings.set("compaction.enabled", false);
		await settings.flushOrThrow();
	}
	const auth = await AuthStorage.create(path.join(agentDir, "auth.db"));
	auth.setRuntimeApiKey(provider, key);
	const modelsPath = path.join(agentDir, "models.yml");
	// Local test input for the real registry parser, never a production settings writer.
	await Bun.write(
		modelsPath,
		options.invalidRegistry
			? "profiles: [invalid-registry-shape]"
			: JSON.stringify({
					providers: {
						[provider]: {
							api: "openai-completions",
							baseUrl: "https://example.invalid/private-endpoint",
							apiKey: key,
							models: ["base", "next", "worker", "newer"].map(id => ({
								id,
								name: `Fixture ${id}`,
								reasoning: false,
								input: ["text"],
								contextWindow: 4096,
								maxTokens: 1024,
							})),
						},
					},
					profiles: {
						"desk-a": profile("base"),
						"desk-b": profile("next"),
						"role-only": { required_providers: [provider], model_mapping: { executor: selector("worker") } },
						"codex-medium": profile("next"),
					},
				}),
	);
	const registry = new ModelRegistry(auth, modelsPath, settings, { agentDir });
	const manager = SessionManager.inMemory(directory);
	const agent = new Agent({
		getApiKey: () => {
			throw new Error("No provider turns in preferences tests");
		},
		streamFn: () => {
			throw new Error("No provider turns in preferences tests");
		},
		initialState: {
			model: options.noModel ? undefined : (registry.find(provider, "base") ?? model("base")),
			messages: [],
			tools: [],
			systemPrompt: ["private-system-prompt"],
		},
	});
	const session = new AgentSession({
		agent,
		sessionManager: manager,
		settings,
		modelRegistry: registry,
		agentDir,
		disposeAsyncJobManager: false,
	});
	const controller = createDesktopPreferencesController(session);
	cleanups.push(async () => {
		controller.dispose();
		await session.dispose();
		await registry.dispose();
		await settings.close();
		auth.close();
		await fs.rm(directory, { recursive: true, force: true });
	});
	return { directory, agentDir, settings, auth, registry, manager, agent, session, controller };
}

function select(name: string, scope: "session" | "default" = "session"): DesktopPreferenceAction {
	return { type: "profile.select", name, scope };
}

describe("desktop public preferences projection", () => {
	test("projects detached profile labels, active/default state and capabilities without raw configuration", async () => {
		const { controller, settings, session } = await fixture();
		await commitDurableModelProfileOwnership(settings, { kind: "profile", profile: "desk-a" });
		await controller.apply(select("desk-b"));
		const dto = controller.read();
		expect(dto.profiles.find(item => item.id === "desk-a")).toMatchObject({
			name: "Desktop base",
			description: null,
			source: "configured",
			active: false,
			default: true,
			capabilities: { selectSession: { available: true }, persistDefault: { available: false } },
		});
		expect(dto.profiles.find(item => item.id === "desk-b")).toMatchObject({ active: true, default: false });
		const serialized = JSON.stringify(dto);
		for (const withheld of [
			key,
			"private-endpoint",
			"private-system-prompt",
			'"modelMapping":',
			'"requiredProviders":',
			'"ownership":',
			'"version":',
			'"agentDir":',
		])
			expect(serialized).not.toContain(withheld);
		dto.profiles[0]!.name = "caller mutation";
		expect(controller.listProfiles()[0]!.name).not.toBe("caller mutation");
		expect(session.getActiveModelProfile()).toBe("desk-b");
	});

	test("keeps canonical unknown-profile errors distinct from invalid registry errors without mutating intent", async () => {
		const { controller, session } = await fixture();
		const revision = session.getUserModelSelectionRevision();
		await expect(controller.apply(select("missing-profile"))).rejects.toBeInstanceOf(UnknownModelProfileError);
		await expect(controller.apply(select("missing-profile"))).rejects.toMatchObject({
			code: "unknown_model_profile",
			details: { requestedProfile: "missing-profile", discoveryQuery: "models.profiles.list" },
		});
		expect(session.getUserModelSelectionRevision()).toBe(revision);
		const invalid = await fixture({ invalidRegistry: true });
		expect(() => invalid.controller.listProfiles()).toThrow(ModelProfileRegistryError);
		await expect(invalid.controller.apply(select("missing-profile"))).rejects.toMatchObject({
			code: "model_profile_registry_error",
			details: { availableProfiles: [], discoveryQuery: "models.profiles.list" },
		});
	});

	test("uses canonical alias resolution and a role-only preset does not replace the live model", async () => {
		const { controller, session } = await fixture();
		const result = await controller.apply(select("codex-standard"));
		expect(result).toMatchObject({ profileId: "codex-medium", scope: "session", durability: "session" });
		expect(session.model?.id).toBe("next");
		await controller.apply(select("role-only"));
		expect(session.getActiveModelProfile()).toBe("role-only");
		expect(session.model?.id).toBe("next");
		expect(controller.read().roles.find(role => role.id === "executor")).toMatchObject({
			configured: true,
			model: { id: "worker", provider },
			canApply: { available: true },
			scope: "session",
			canClear: { available: false },
		});
	});

	test("exposes merged sampling values and layer provenance, never claims provider capability or writer scope", async () => {
		const { controller, settings } = await fixture();
		await settings.commitAtomicBatch([
			{ path: "temperature", op: "set", value: 0 },
			{ path: "topP", op: "set", value: 1 },
			{ path: "topK", op: "set", value: -1 },
		]);
		settings.override("temperature", 0.75);
		expect(controller.read().sampling.find(item => item.parameter === "temperature")).toEqual({
			parameter: "temperature",
			configuredValue: 0.75,
			effectiveValue: 0.75,
			mode: "value",
			resolution: { origin: "runtime", layers: ["global", "runtime"] },
			application: "next-run",
			modelSupport: "unknown",
			canApply: { available: false, reason: expect.any(String) },
		});
		expect(controller.read().sampling.find(item => item.parameter === "topP")).toMatchObject({
			configuredValue: 1,
			effectiveValue: 1,
			mode: "value",
			resolution: { origin: "global" },
		});
		expect(controller.read().sampling.find(item => item.parameter === "topK")).toMatchObject({
			configuredValue: -1,
			effectiveValue: null,
			mode: "provider-default",
		});
		settings.clearOverride("temperature");
		expect(controller.read().sampling.find(item => item.parameter === "temperature")).toMatchObject({
			effectiveValue: 0,
			resolution: { origin: "global" },
		});
	});

	test("keeps malformed sampling JSON-safe and distinguishes no selected model", async () => {
		const { controller, settings } = await fixture({ noModel: true });
		settings.override("temperature", Number.NaN);
		settings.override("topK", -2);
		expect(controller.read().sampling.find(item => item.parameter === "temperature")).toMatchObject({
			configuredValue: null,
			effectiveValue: null,
			mode: "invalid",
		});
		expect(controller.read().sampling.find(item => item.parameter === "topK")).toMatchObject({
			configuredValue: -2,
			effectiveValue: null,
			mode: "invalid",
			modelSupport: "unknown",
		});
		expect(controller.read().roles.find(item => item.id === "default")?.model).toBeNull();
		expect(JSON.parse(JSON.stringify(controller.read()))).toEqual(controller.read());
	});
});

describe("desktop preference mutation ownership and refusal", () => {
	test.each([
		"executor",
		"planner",
		"critic",
		"architect",
	] as const)("sets and clears %s only for the live session, revealing inherited configuration", async role => {
		const { controller, session, settings, agentDir } = await fixture({ durable: true });
		settings.override("task.agentModelOverrides", { planner: selector("worker") });
		const before = controller.read();
		const inherited = before.roles.find(item => item.id === role)!;
		const current = session.model;
		const thinking = session.thinkingLevel;
		const overrides = structuredClone(settings.get("task.agentModelOverrides"));
		const ownership = readDurableModelProfileOwnership(settings);
		const disk = await Bun.file(path.join(agentDir, "config.yml")).text();
		const set = await controller.apply({ type: "role.set", role, modelId: selector("next") });
		expect(set).toMatchObject({ applied: "role.set", role, scope: "session", durability: "session" });
		expect(set.preferences.roles.find(item => item.id === role)).toMatchObject({
			configured: true,
			scope: "session",
			model: { id: "next", provider },
			canApply: { available: true },
			canClear: { available: true },
		});
		expect(controller.read()).toEqual(set.preferences);
		expect(session.model).toEqual(current);
		expect(session.thinkingLevel).toBe(thinking);
		expect(settings.get("task.agentModelOverrides")).toEqual(overrides);
		expect(readDurableModelProfileOwnership(settings)).toEqual(ownership);
		expect(await Bun.file(path.join(agentDir, "config.yml")).text()).toBe(disk);
		const clear = await controller.apply({ type: "role.set", role, modelId: null });
		expect(clear).toMatchObject({ applied: "role.set", role, scope: "session", durability: "session" });
		expect(clear.preferences.roles.find(item => item.id === role)).toEqual(inherited);
		expect(clear.preferences.roles.find(item => item.id === role)?.canClear.available).toBe(false);
		if (role === "planner") expect(inherited).toMatchObject({ configured: true, model: { id: "worker", provider } });
		expect(settings.get("task.agentModelOverrides")).toEqual(overrides);
		expect(await Bun.file(path.join(agentDir, "config.yml")).text()).toBe(disk);
	});

	test("rejects concurrent role mutation while the SDK selection is pending", async () => {
		const { controller, session } = await fixture();
		const setSelection = session.setSessionAgentModelSelection.bind(session);
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		vi.spyOn(session, "setSessionAgentModelSelection").mockImplementationOnce(async (role, model) => {
			entered.resolve();
			await release.promise;
			return setSelection(role, model);
		});
		const first = controller.apply({ type: "role.set", role: "executor", modelId: selector("next") });
		try {
			await entered.promise;
			await expect(
				controller.apply({ type: "role.set", role: "planner", modelId: selector("worker") }),
			).rejects.toMatchObject({ code: "preference_busy" });
		} finally {
			release.resolve();
		}
		const result = await first;
		expect(result.preferences.roles.find(role => role.id === "executor")).toMatchObject({
			model: { id: "next", provider },
			canClear: { available: true },
		});
		expect(result.preferences.roles.find(role => role.id === "planner")?.canClear.available).toBe(false);
	});

	test("default model selection is durable and reports its own result", async () => {
		const { controller, session, settings, agentDir } = await fixture({ durable: true });
		const disk = await Bun.file(path.join(agentDir, "config.yml")).text();
		const result = await controller.apply({ type: "role.set", role: "default", modelId: selector("next") });
		expect(result).toMatchObject({ applied: "role.set", role: "default", scope: "default", durability: "persisted" });
		expect(result.preferences.roles.find(role => role.id === "default")).toMatchObject({
			scope: "default",
			model: { id: "next", provider },
			canClear: { available: false },
		});
		expect(session.model?.id).toBe("next");
		expect(await Bun.file(path.join(agentDir, "config.yml")).text()).not.toBe(disk);
		expect(settings.get("task.agentModelOverrides")).toEqual({});
	});

	test("rejects unavailable models, unsupported targets and malformed role actions without writes", async () => {
		const { controller, settings, session } = await fixture();
		const before = controller.read();
		const revision = session.getUserModelSelectionRevision();
		const commit = vi.spyOn(settings, "commitAtomicBatch");
		const override = vi.spyOn(settings, "override");
		for (const modelId of ["", "missing", selector("missing")]) {
			await expect(controller.apply({ type: "role.set", role: "executor", modelId })).rejects.toMatchObject({
				code: "invalid_input",
			});
		}
		for (const action of [
			{ type: "role.set", role: "image", modelId: selector("next") },
			{ type: "role.set", role: "image", modelId: null },
			{ type: "role.set", role: "default", modelId: null },
			{ type: "role.set", role: "default", modelId: selector("next") },
		])
			await expect(controller.apply(action)).rejects.toMatchObject({ code: "unsupported_preference" });
		for (const action of [
			{ type: "role.set", role: "plan", modelId: selector("next") },
			{ type: "role.set", role: "executor", modelId: 1 },
			{ type: "role.set", role: "executor", modelId: selector("next"), scope: "default" },
		])
			await expect(controller.apply(action)).rejects.toMatchObject({ code: "invalid_input" });
		expect(controller.read()).toEqual(before);
		expect(session.getUserModelSelectionRevision()).toBe(revision);
		expect(commit).not.toHaveBeenCalled();
		expect(override).not.toHaveBeenCalled();
	});

	test("session selection preserves durable ownership/defaults and another real session's scoped settings", async () => {
		const { controller, session, settings, registry, agentDir, directory } = await fixture({ durable: true });
		await commitDurableModelProfileOwnership(settings, { kind: "profile", profile: "desk-a" });
		const ownership = readDurableModelProfileOwnership(settings);
		const other = await Settings.loadForScope({ cwd: directory, agentDir });
		const otherSession = new AgentSession({
			agent: new Agent({
				getApiKey: () => {
					throw new Error("No provider turns in preferences tests");
				},
				streamFn: () => {
					throw new Error("No provider turns in preferences tests");
				},
				initialState: { model: registry.find(provider, "base"), messages: [], tools: [], systemPrompt: [] },
			}),
			sessionManager: SessionManager.inMemory(directory),
			settings: other,
			modelRegistry: registry,
			agentDir,
			disposeAsyncJobManager: false,
		});
		const otherController = createDesktopPreferencesController(otherSession);
		try {
			// Finish both fixture-owned Settings loads before measuring activation.
			// Loading an unversioned file can itself persist configSchemaVersion.
			await Promise.all([settings.flushOrThrow(), other.flushOrThrow()]);
			const diskBefore = await Bun.file(path.join(agentDir, "config.yml")).text();
			expect(Bun.YAML.parse(diskBefore)).toMatchObject({ configSchemaVersion: CONFIG_SCHEMA_VERSION });
			const beforeOther = otherController.read().roles;
			const commit = vi.spyOn(settings, "commitAtomicBatch");
			const override = vi.spyOn(settings, "override");
			const assignment = await controller.apply({ type: "role.set", role: "executor", modelId: selector("worker") });
			expect(assignment).toMatchObject({
				applied: "role.set",
				role: "executor",
				scope: "session",
				durability: "session",
			});
			expect(assignment.preferences.roles.find(role => role.id === "executor")).toMatchObject({
				model: { id: "worker" },
				canClear: { available: true },
			});
			expect(otherController.read().roles).toEqual(beforeOther);
			expect(settings.get("task.agentModelOverrides").executor).toBeUndefined();
			expect(await Bun.file(path.join(agentDir, "config.yml")).text()).toBe(diskBefore);
			expect(commit).not.toHaveBeenCalled();
			expect(override).not.toHaveBeenCalled();
			await controller.apply({ type: "role.set", role: "executor", modelId: null });
			expect(otherController.read().roles).toEqual(beforeOther);
			expect(commit).not.toHaveBeenCalled();
			expect(override).not.toHaveBeenCalled();
			await controller.apply(select("desk-b"));
			expect(session.model?.id).toBe("next");
			expect(settings.get("task.agentModelOverrides").executor).toBe(selector("worker"));
			expect(other.get("task.agentModelOverrides").executor).toBeUndefined();
			expect(otherSession.model?.id).toBe("base");
			expect(otherController.listProfiles().some(item => item.active)).toBe(false);
			expect(readDurableModelProfileOwnership(settings)).toEqual(ownership);
			expect(readDurableModelProfileOwnership(other)).toEqual(ownership);
			expect(await Bun.file(path.join(agentDir, "config.yml")).text()).toBe(diskBefore);
			// Session scope preserves configuration, not a zero-storage-writes promise.
			expect(settings.getStorage()!.getModelUsageOrder()[0]).toBe(selector("next"));
		} finally {
			otherController.dispose();
			await otherSession.dispose();
			await other.close();
		}
	});

	test("refuses default writes for memory-only captured Settings before recording operator intent", async () => {
		const { controller, session } = await fixture();
		const revision = session.getUserModelSelectionRevision();
		const activate = vi.spyOn(session, "setDefaultModelProfileForControl");
		expect(controller.listProfiles().find(item => item.id === "desk-b")?.capabilities.persistDefault.available).toBe(
			false,
		);
		await expect(controller.apply(select("desk-b", "default"))).rejects.toMatchObject({
			code: "unsupported_preference",
		});
		expect(activate).not.toHaveBeenCalled();
		expect(session.getUserModelSelectionRevision()).toBe(revision);
	});

	test("canonical default persistence failure leaves config, ownership, runtime and MRU unchanged", async () => {
		const { controller, session, settings, agentDir } = await fixture({ durable: true });
		const ownership = readDurableModelProfileOwnership(settings);
		const disk = await Bun.file(path.join(agentDir, "config.yml")).text();
		const usage = settings.getStorage()!.getModelUsageOrder();
		const commit = vi
			.spyOn(settings, "commitAtomicBatchWithCurrent")
			.mockRejectedValueOnce(new Error("disk write failure"));
		await expect(controller.apply(select("desk-b", "default"))).rejects.toThrow("disk write failure");
		expect(commit).toHaveBeenCalledTimes(1);
		expect(session.model?.id).toBe("base");
		expect(session.getActiveModelProfile()).toBeUndefined();
		expect(readDurableModelProfileOwnership(settings)).toEqual(ownership);
		expect(await Bun.file(path.join(agentDir, "config.yml")).text()).toBe(disk);
		expect(settings.getStorage()!.getModelUsageOrder()).toEqual(usage);
	});

	test("durable selection advances canonical ownership in the injected project scope while another SDK session keeps manual intent", async () => {
		const { controller, session, settings, registry, agentDir, directory } = await fixture({
			durable: true,
			project: true,
		});
		const otherSettings = await Settings.loadForScope({ cwd: directory, agentDir });
		const otherSession = new AgentSession({
			agent: new Agent({
				getApiKey: () => {
					throw new Error("No provider turns in preferences tests");
				},
				streamFn: () => {
					throw new Error("No provider turns in preferences tests");
				},
				initialState: { model: registry.find(provider, "base"), tools: [], messages: [], systemPrompt: [] },
			}),
			sessionManager: SessionManager.inMemory(directory),
			settings: otherSettings,
			modelRegistry: registry,
			agentDir,
			disposeAsyncJobManager: false,
		});
		try {
			await otherSession.setModelTemporary(registry.find(provider, "newer")!, undefined, {
				cause: "user-selection",
				persistAsSessionDefault: true,
			});
			otherSettings.override("task.agentModelOverrides", {
				executor: selector("newer"),
				critic: selector("worker"),
			});
			settings.override("task.agentModelOverrides", { architect: selector("newer") });
			const manualChain = otherSession.getConfiguredModelChainState("default");
			await Promise.all([settings.flushOrThrow(), otherSettings.flushOrThrow()]);
			const owner = await commitDurableModelProfileOwnership(settings, { kind: "profile", profile: "desk-a" });
			const projectBefore = await Bun.file(path.join(directory, ".gjc", "config.yml")).text();
			expect(controller.listProfiles().find(item => item.id === "desk-b")?.capabilities.persistDefault).toEqual({
				available: true,
				reason: null,
			});
			const control = vi.spyOn(session, "setDefaultModelProfileForControl");
			expect(settings.getStorage()!.getModelUsageOrder()).toContain(selector("newer"));
			expect(settings.getStorage()!.getModelUsageOrder()).not.toContain(selector("next"));
			const result = await controller.apply(select("desk-b", "default"));
			expect(control).toHaveBeenCalledWith("desk-b", {
				persistDefault: true,
				onBeforeActivation: expect.any(Function),
			});
			expect(result).toMatchObject({
				applied: "profile.select",
				profileId: "desk-b",
				scope: "default",
				durability: "persisted",
			});
			expect(session.settings).toBe(settings);
			expect(session.model?.id).toBe("next");
			expect(session.getActiveModelProfile()).toBe("desk-b");
			expect(settings.getOverride("task.agentModelOverrides")).toMatchObject({
				architect: selector("newer"),
				executor: selector("worker"),
			});
			const expectedOwner: DurableModelProfileOwnership = {
				schemaVersion: 1,
				version: owner.version + 1,
				marker: { kind: "profile", profile: "desk-b" },
			};
			expect(readDurableModelProfileOwnership(settings)).toEqual(expectedOwner);
			expect(settings.getGlobal("modelProfile.default")).toBe("desk-b");
			const raw = Bun.YAML.parse(await Bun.file(path.join(agentDir, "config.yml")).text());
			expect(raw).toMatchObject({
				modelProfile: { ownership: expectedOwner, default: "desk-b" },
				modelRoles: {},
				task: { agentModelOverrides: {} },
			});
			expect(await Bun.file(path.join(directory, ".gjc", "config.yml")).text()).toBe(projectBefore);
			expect(otherSession.model?.id).toBe("newer");
			expect(otherSession.getConfiguredModelChainState("default")).toEqual(manualChain);
			expect(otherSettings.getOverride("task.agentModelOverrides")).toEqual({
				executor: selector("newer"),
				critic: selector("worker"),
			});
			// Both selections record shared usage. SQLite timestamp ties do not
			// guarantee their relative order, so retain proof of both actual writes.
			expect(settings.getStorage()!.getModelUsageOrder()).toEqual(
				expect.arrayContaining([selector("next"), selector("newer")]),
			);
			const reopened = await Settings.loadForScope({ cwd: directory, agentDir });
			try {
				expect(readDurableModelProfileOwnership(reopened)).toEqual(expectedOwner);
				expect(reopened.getGlobal("modelProfile.default")).toBe("desk-b");
				expect(reopened.getStorage()!.getModelUsageOrder()).toEqual(
					expect.arrayContaining([selector("next"), selector("newer")]),
				);
			} finally {
				await reopened.close();
			}
			// A same-name request must still reach canonical preflight and CAS.
			await controller.apply(select("desk-b", "default"));
			expect(control).toHaveBeenCalledTimes(2);
			expect(readDurableModelProfileOwnership(settings)).toEqual(expectedOwner);
		} finally {
			await otherSession.dispose();
			await otherSettings.close();
		}
	});

	test.each([
		true,
		false,
	])("adapter durable selection preserves the canonical %s local predecessor receipt", async predecessorSucceeds => {
		const { controller, session, settings } = await fixture({ durable: true });
		const reached = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const commit = settings.commitAtomicBatchWithCurrent.bind(settings);
		let count = 0;
		vi.spyOn(settings, "commitAtomicBatchWithCurrent").mockImplementation(async build => {
			if (++count === 1) {
				reached.resolve();
				await release.promise;
				if (!predecessorSucceeds) throw new Error("predecessor commit failed");
			}
			return commit(build);
		});
		const first = session.setDefaultModelProfileForControl("desk-a", { persistDefault: true });
		void first.catch(() => undefined);
		let pending: Promise<unknown> | undefined;
		try {
			await Promise.race([
				reached.promise,
				first.then(() => {
					throw new Error("Expected held predecessor");
				}),
			]);
			pending = controller.apply(select("desk-b", "default"));
			release.resolve();
			if (predecessorSucceeds) await expect(first).resolves.toEqual({ changed: true, id: "desk-a" });
			else await expect(first).rejects.toThrow("predecessor commit failed");
			await expect(pending).resolves.toMatchObject({
				profileId: "desk-b",
				scope: "default",
				durability: "persisted",
			});
			expect(count).toBe(2);
			expect(readDurableModelProfileOwnership(settings)).toMatchObject({
				version: predecessorSucceeds ? 2 : 1,
				marker: { kind: "profile", profile: "desk-b" },
			});
			expect(session.model?.id).toBe("next");
		} finally {
			release.resolve();
			await Promise.allSettled([first, pending]);
		}
	});

	test("a same-name durable request rejects an external ownership ABA instead of treating it as a no-op", async () => {
		const { controller, session, settings, agentDir, directory } = await fixture({ durable: true });
		await controller.apply(select("desk-a", "default"));
		const observed = readDurableModelProfileOwnership(settings);
		const external = await Settings.loadForScope({ cwd: directory, agentDir });
		const reached = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		vi.spyOn(session, "waitForIdle").mockImplementationOnce(async () => {
			reached.resolve();
			await release.promise;
		});
		const pending = controller.apply(select("desk-a", "default"));
		try {
			await Promise.race([
				reached.promise,
				pending.then(() => {
					throw new Error("Expected pending profile request");
				}),
			]);
			await commitDurableModelProfileOwnership(external, { kind: "profile", profile: "desk-b" });
			const winner = await commitDurableModelProfileOwnership(external, { kind: "profile", profile: "desk-a" });
			expect(winner.version).toBe(observed.version + 2);
			release.resolve();
			await expect(pending).rejects.toMatchObject({
				code: "model_profile_ownership_conflict",
				expectedVersion: observed.version,
				actualVersion: winner.version,
			});
			expect(readDurableModelProfileOwnership(external)).toEqual(winner);
			const raw = Bun.YAML.parse(await Bun.file(path.join(agentDir, "config.yml")).text());
			expect(raw).toMatchObject({ modelProfile: { ownership: winner, default: "desk-a" } });
			expect(session.model?.id).toBe("base");
			expect(session.getActiveModelProfile()).toBe("desk-a");
		} finally {
			release.resolve();
			await pending.catch(() => undefined);
			await external.close();
		}
	});

	test("committed publication failure preserves its durable error and winner without adapter compensation", async () => {
		const { controller, session, settings, agentDir } = await fixture({ durable: true });
		vi.spyOn(session, "commitPreparedProfileModelSelection").mockImplementationOnce(() => {
			throw new Error("publication failed");
		});
		await expect(controller.apply(select("desk-b", "default"))).rejects.toMatchObject({
			code: "model_profile_apply_committed",
			committedVersion: 1,
		});
		expect(readDurableModelProfileOwnership(settings)).toMatchObject({
			version: 1,
			marker: { kind: "profile", profile: "desk-b" },
		});
		expect(Bun.YAML.parse(await Bun.file(path.join(agentDir, "config.yml")).text())).toMatchObject({
			modelProfile: { default: "desk-b", ownership: { version: 1 } },
		});
		await session.awaitDisposeCompletion();
		await expect(controller.apply(select("desk-a", "default"))).rejects.toMatchObject({ code: "stale_preferences" });
	});

	test("rejects unsupported and invalid sampling values before mutation, including numeric boundaries", async () => {
		const { controller, session, settings } = await fixture();
		const revision = session.getUserModelSelectionRevision();
		const commit = vi.spyOn(settings, "commitAtomicBatch");
		const override = vi.spyOn(settings, "override");
		for (const parameter of sampling) {
			for (const value of [-2, -1, 0, Number.MIN_VALUE, 0.5, 1, 2, 1.5, Number.MAX_SAFE_INTEGER]) {
				await expect(
					controller.apply({ type: "sampling.set", parameter, value, scope: "session" }),
				).rejects.toMatchObject({ code: "unsupported_preference" });
			}
			for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, "1", null, true, {}]) {
				await expect(
					controller.apply({
						type: "sampling.set",
						parameter,
						value,
						scope: "default",
					} as DesktopPreferenceAction),
				).rejects.toMatchObject({ code: "invalid_input" });
			}
		}
		await expect(
			controller.apply({
				type: "sampling.set",
				parameter: "maxTokens",
				value: 1,
				scope: "session",
			} as unknown as DesktopPreferenceAction),
		).rejects.toBeInstanceOf(DesktopPreferenceError);
		expect(commit).not.toHaveBeenCalled();
		expect(override).not.toHaveBeenCalled();
		expect(session.getUserModelSelectionRevision()).toBe(revision);
		for (const parameter of sampling) expect(settings.get(parameter)).toBe(-1);
	});

	test("refuses arbitrary paths, scope flags, or caller authority fields", async () => {
		const { controller, session } = await fixture();
		const activate = vi.spyOn(session, "activateModelProfileForControl");
		const persist = vi.spyOn(session, "setDefaultModelProfileForControl");
		for (const action of [
			{ ...select("desk-b"), owner: true },
			{ ...select("desk-b"), profileAuthority: "default" },
			{ ...select("desk-b"), persistDefault: true },
			{ type: "config.patch", path: "modelProfile.default", value: "desk-b" },
			{ type: "role.set", role: "__proto__", modelId: selector("next") },
		])
			await expect(controller.apply(action as DesktopPreferenceAction)).rejects.toMatchObject({
				code: "invalid_input",
			});
		expect(activate).not.toHaveBeenCalled();
		expect(persist).not.toHaveBeenCalled();
	});

	test("rolls back a real session model publication failure and retains settings/ownership", async () => {
		const { controller, session, manager, settings } = await fixture();
		await commitDurableModelProfileOwnership(settings, { kind: "profile", profile: "desk-a" });
		const before = readDurableModelProfileOwnership(settings);
		session.setConfiguredModelChain("default", [selector("base")], "model_selection");
		const chain = session.getConfiguredModelChainState("default");
		vi.spyOn(manager, "appendModelChange").mockImplementationOnce(() => {
			throw new Error("session persistence failure");
		});
		await expect(controller.apply(select("desk-b"))).rejects.toThrow("session persistence failure");
		expect(session.model?.id).toBe("base");
		expect(session.getActiveModelProfile()).toBeUndefined();
		expect(settings.getOverride("modelRoles")).toBeUndefined();
		expect(settings.getOverride("task.agentModelOverrides")).toBeUndefined();
		expect(session.getConfiguredModelChainState("default")).toEqual(chain);
		expect(readDurableModelProfileOwnership(settings)).toEqual(before);
	});

	test.each([
		"session",
		"default",
	] as const)("rejects missing credentials during %s canonical preflight without partial activation", async scope => {
		const { controller, session, registry, settings, agentDir } = await fixture({ durable: true });
		const before = readDurableModelProfileOwnership(settings);
		const disk = await Bun.file(path.join(agentDir, "config.yml")).text();
		const usage = settings.getStorage()!.getModelUsageOrder();
		vi.spyOn(registry, "getApiKeyForProvider").mockResolvedValue(undefined);
		await expect(controller.apply(select("desk-b", scope))).rejects.toMatchObject({
			name: "ModelProfileCredentialError",
		});
		expect(session.model?.id).toBe("base");
		expect(session.getActiveModelProfile()).toBeUndefined();
		expect(settings.getOverride("task.agentModelOverrides")).toBeUndefined();
		expect(readDurableModelProfileOwnership(settings)).toEqual(before);
		expect(await Bun.file(path.join(agentDir, "config.yml")).text()).toBe(disk);
		expect(settings.getStorage()!.getModelUsageOrder()).toEqual(usage);
	});

	test.each([
		{ selected: "newer", scope: "session" as const },
		{ selected: "base", scope: "session" as const },
		{ selected: "newer", scope: "default" as const },
		{ selected: "base", scope: "default" as const },
	])("later operator intent supersedes pending profile in both scopes, including same-model picks: %o", async ({
		selected,
		scope,
	}) => {
		const { controller, session, registry, settings } = await fixture({ durable: true });
		const ownership = readDurableModelProfileOwnership(settings);
		const reached = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const getKey = registry.getApiKeyForProvider.bind(registry);
		let paused = false;
		vi.spyOn(registry, "getApiKeyForProvider").mockImplementation(async (...args) => {
			if (!paused) {
				paused = true;
				reached.resolve();
				await release.promise;
			}
			return getKey(...args);
		});
		const pending = controller.apply(select("desk-b", scope));
		try {
			await Promise.race([
				reached.promise,
				pending.then(() => {
					throw new Error("Profile activation settled before the race checkpoint");
				}),
			]);
			const revision = session.getUserModelSelectionRevision();
			await expect(controller.apply(select("desk-a", scope))).rejects.toMatchObject({ code: "preference_busy" });
			expect(session.getUserModelSelectionRevision()).toBe(revision);
			await session.setModelTemporary(registry.find(provider, selected)!, undefined, {
				cause: "user-selection",
				persistAsSessionDefault: true,
			});
		} finally {
			release.resolve();
		}
		await expect(pending).rejects.toMatchObject({ code: "preference_superseded" });
		expect(session.model?.id).toBe(selected);
		expect(session.getActiveModelProfile()).toBeUndefined();
		expect(session.getConfiguredModelChain("default")).toEqual([selector(selected)]);
		expect(readDurableModelProfileOwnership(settings)).toEqual(ownership);
	});

	test("failed activation rollback cannot overwrite a newer model/default-chain choice", async () => {
		const { controller, session, registry, settings } = await fixture();
		const reached = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const restore = session.restoreModelSelectionForRollback.bind(session);
		vi.spyOn(session, "restoreModelSelectionForRollback").mockImplementationOnce(async (...args) => {
			await restore(...args);
			reached.resolve();
			await release.promise;
		});
		vi.spyOn(settings, "override").mockImplementationOnce(() => {
			throw new Error("role publication failure");
		});
		const pending = controller.apply(select("desk-b"));
		try {
			await Promise.race([
				reached.promise,
				pending.then(() => {
					throw new Error("Profile activation settled before the race checkpoint");
				}),
			]);
			await session.setModelTemporary(registry.find(provider, "newer")!, undefined, {
				cause: "user-selection",
				persistAsSessionDefault: true,
			});
		} finally {
			release.resolve();
		}
		await expect(pending).rejects.toMatchObject({ code: "preference_superseded" });
		expect(session.model?.id).toBe("newer");
		expect(session.getConfiguredModelChain("default")).toEqual([selector("newer")]);
		expect(session.getActiveModelProfile()).toBeUndefined();
	});

	test.each([
		"session",
		"default",
	] as const)("notification-only identity wakeups preserve %s preferences without inventing a generation", async scope => {
		const { controller, session } = await fixture({ durable: true });
		const initial = session.sessionLifecycle;
		expect(Object.isFrozen(initial)).toBe(true);
		const revision = session.getUserModelSelectionRevision();
		await session.notifySessionIdentityChanged();
		await session.notifySessionIdentityChanged();
		expect(session.sessionLifecycle).toEqual(initial);
		expect(controller.read().profiles.some(item => item.id === "desk-b")).toBe(true);
		expect(session.getUserModelSelectionRevision()).toBe(revision);
		await expect(controller.apply(select("desk-b", scope))).resolves.toMatchObject({ profileId: "desk-b", scope });
	});

	test("cancelled and failed public handoff preparation only temporarily rejects preferences", async () => {
		const { controller, session, manager } = await fixture({ durable: true });
		manager.appendMessage({ role: "user", content: "First context", timestamp: 1 });
		manager.appendMessage({ role: "user", content: "Second context", timestamp: 2 });
		const initial = session.sessionLifecycle;
		const cancelled = new AbortController();
		cancelled.abort();
		await expect(session.handoff(undefined, { signal: cancelled.signal })).rejects.toThrow("Handoff cancelled");
		expect(session.sessionLifecycle).toEqual(initial);
		expect(controller.listProfiles().some(item => item.id === "desk-a")).toBe(true);

		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		vi.spyOn(compactionModule, "generateHandoff").mockImplementationOnce(async () => {
			entered.resolve();
			await release.promise;
			throw new Error("owned handoff preparation failed");
		});
		const handoff = session.handoff();
		void handoff.catch(() => undefined);
		try {
			await Promise.race([
				entered.promise,
				handoff.then(() => {
					throw new Error("Expected handoff preparation checkpoint");
				}),
			]);
			expect(session.sessionLifecycle).toEqual({ ...initial, transitioning: true });
			await session.notifySessionIdentityChanged();
			expect(() => controller.read()).toThrow("temporarily unavailable");
			const revision = session.getUserModelSelectionRevision();
			await expect(controller.apply(select("desk-b", "default"))).rejects.toMatchObject({ code: "preference_busy" });
			await expect(
				controller.apply({ type: "role.set", role: "executor", modelId: selector("next") }),
			).rejects.toMatchObject({ code: "preference_busy" });
			expect(session.getUserModelSelectionRevision()).toBe(revision);
		} finally {
			release.resolve();
		}
		await expect(handoff).rejects.toThrow("owned handoff preparation failed");
		expect(session.sessionLifecycle).toEqual(initial);
		await session.notifySessionIdentityChanged();
		await expect(controller.apply(select("desk-b", "default"))).resolves.toMatchObject({
			profileId: "desk-b",
			durability: "persisted",
		});
	});

	test("committed generation changes permanently stale the old controller even with unchanged identity", async () => {
		const { controller, session } = await fixture({ durable: true });
		const initial = session.sessionLifecycle;
		const id = session.sessionId;
		await session.clearContext();
		expect(session.sessionId).toBe(id);
		expect(session.sessionLifecycle.generation).toBe(initial.generation + 1);
		await session.notifySessionIdentityChanged();
		await expect(controller.apply(select("desk-b", "default"))).rejects.toMatchObject({ code: "stale_preferences" });
		await expect(
			controller.apply({ type: "role.set", role: "executor", modelId: selector("next") }),
		).rejects.toMatchObject({ code: "stale_preferences" });
		await session.notifySessionIdentityChanged();
		expect(() => controller.read()).toThrow("identity changed");
	});

	test("an observed same-generation manager replacement permanently retires preferences across ABA", async () => {
		const { controller, session, manager, directory } = await fixture({ durable: true });
		const initial = session.sessionLifecycle;
		try {
			session.sessionManager = SessionManager.inMemory(directory);
			await session.notifySessionIdentityChanged();
			expect(session.sessionLifecycle).toEqual(initial);
		} finally {
			session.sessionManager = manager;
		}
		await session.notifySessionIdentityChanged();
		expect(() => controller.read()).toThrow("identity changed");
		await expect(controller.apply(select("desk-b", "default"))).rejects.toMatchObject({ code: "stale_preferences" });
	});

	test("identity retirement during preflight prevents activation without publishing successor preferences", async () => {
		const { controller, session, registry } = await fixture();
		const getKey = registry.getApiKeyForProvider.bind(registry);
		let retired = false;
		vi.spyOn(registry, "getApiKeyForProvider").mockImplementation(async (...args) => {
			if (!retired) {
				retired = true;
				await session.clearContext();
			}
			return getKey(...args);
		});
		await expect(controller.apply(select("desk-b"))).rejects.toMatchObject({ code: "stale_preferences" });
		expect(session.model?.id).toBe("base");
		expect(session.getActiveModelProfile()).toBeUndefined();
	});
});
