import { describe, expect, test } from "bun:test";
import { ThinkingLevel } from "@gajae-code/agent-core";
import type { Model } from "@gajae-code/ai";
import { parseArgs } from "../src/cli/args";
import { activateModelProfile } from "../src/config/model-profile-activation";
import type { ModelProfileDefinition } from "../src/config/model-profiles";
import { Settings } from "../src/config/settings";

const model = (provider: string, id: string): Model =>
	({ provider, id, name: id, api: "openai-responses", contextWindow: 1000, maxTokens: 1000 }) as Model;

function fakeRegistry(options?: {
	missingProviders?: string[];
	profiles?: ModelProfileDefinition[];
	models?: Model[];
}) {
	const profiles = new Map<string, ModelProfileDefinition>();
	for (const profile of options?.profiles ?? []) {
		profiles.set(profile.name, profile);
	}
	const missing = new Set(options?.missingProviders ?? []);
	const models = options?.models ?? [
		model("provider-a", "default"),
		model("provider-a", "alternate"),
		model("provider-b", "executor"),
		model("provider-a", "architect"),
	];
	return {
		getModelProfile: (name: string) => profiles.get(name),
		getModelProfiles: () => new Map(profiles),
		getAvailableModelProfileNames: () => [...profiles.keys()].sort(),
		getApiKeyForProvider: async (provider: string) => (missing.has(provider) ? undefined : `key-${provider}`),
		getAll: () => models,
		resolveCanonicalModel: () => undefined,
		getCanonicalVariants: () => [],
		getCanonicalId: () => undefined,
	};
}

function fakeSession(initial = model("provider-a", "initial")) {
	return {
		model: initial as Model | undefined,
		thinkingLevel: ThinkingLevel.Low as ThinkingLevel | undefined,
		sessionId: "session-1",
		setModelTemporaryCalls: [] as Array<{ model: Model; thinkingLevel?: ThinkingLevel }>,
		configuredModelChains: new Map<string, readonly string[]>(),
		getConfiguredModelChain(role: string) {
			return this.configuredModelChains.get(role);
		},
		setConfiguredModelChain(role: string, entries: readonly string[]) {
			this.configuredModelChains.set(role, [...entries]);
		},
		async setModelTemporary(next: Model, thinkingLevel?: ThinkingLevel) {
			this.setModelTemporaryCalls.push({ model: next, thinkingLevel });
			this.model = next;
			this.thinkingLevel = thinkingLevel;
		},
	};
}

function instrumentSettings(settings: Settings) {
	const setCalls: string[] = [];
	const overrideCalls: string[] = [];
	let flushCount = 0;
	const originalSet = settings.set.bind(settings);
	const originalOverride = settings.override.bind(settings);
	settings.set = ((path: never, value: never) => {
		setCalls.push(path);
		return originalSet(path, value);
	}) as typeof settings.set;
	settings.override = ((path: never, value: never) => {
		overrideCalls.push(path);
		return originalOverride(path, value);
	}) as typeof settings.override;
	settings.flush = async () => {
		flushCount += 1;
	};
	return {
		setCalls,
		overrideCalls,
		get flushCount() {
			return flushCount;
		},
	};
}

describe("model profile activation red-team", () => {
	test("fully unresolved non-default role selector activates and preserves the configured selector", async () => {
		const session = fakeSession();
		const settings = Settings.isolated({
			"task.agentModelOverrides": { executor: "provider-a/original" },
			"modelProfile.default": "old-profile",
		});
		const calls = instrumentSettings(settings);
		const registry = fakeRegistry({
			profiles: [
				{
					name: "unresolved-role",
					requiredProviders: [],
					modelMapping: { default: "provider-a/default:high", executor: "provider-b/missing" },
					source: "user",
				},
			],
		});

		await activateModelProfile({ session, modelRegistry: registry, settings, profileName: "unresolved-role" });
		expect(session.model?.id).toBe("default");
		expect(session.thinkingLevel).toBe(ThinkingLevel.High);
		expect(settings.get("task.agentModelOverrides")).toEqual({ executor: "provider-b/missing" });
		expect(settings.get("modelProfile.default")).toBe("old-profile");
		expect(calls.setCalls).toEqual([]);
		expect(calls.overrideCalls).toEqual(["task.agentModelOverrides"]);
		expect(calls.flushCount).toBe(0);
	});

	test("ATOMICITY: one missing required provider hard-blocks naming only missing providers with zero mutation", async () => {
		const session = fakeSession();
		const settings = Settings.isolated({
			"task.agentModelOverrides": { executor: "provider-a/original" },
			"modelProfile.default": "old-profile",
		});
		const calls = instrumentSettings(settings);
		const registry = fakeRegistry({
			missingProviders: ["provider-b"],
			profiles: [
				{
					name: "needs-two",
					requiredProviders: ["provider-a", "provider-b"],
					modelMapping: { default: "provider-a/default", executor: "provider-b/executor" },
					source: "user",
				},
			],
		});

		await expect(
			activateModelProfile({ session, modelRegistry: registry, settings, profileName: "needs-two" }),
		).rejects.toThrow(
			'Model profile "needs-two" requires credentials for: provider-b. Run /login and configure the missing provider(s), then retry.',
		);
		expect(session.model?.id).toBe("initial");
		expect(session.thinkingLevel).toBe(ThinkingLevel.Low);
		expect(session.setModelTemporaryCalls).toEqual([]);
		expect(settings.get("task.agentModelOverrides")).toEqual({ executor: "provider-a/original" });
		expect(settings.get("modelProfile.default")).toBe("old-profile");
		expect(calls.setCalls).toEqual([]);
		expect(calls.overrideCalls).toEqual([]);
		expect(calls.flushCount).toBe(0);
	});

	test("AUTHZ: underdeclared mapped provider is a resolution-time candidate, not an activation gate", async () => {
		const session = fakeSession();
		const settings = Settings.isolated({
			"task.agentModelOverrides": { executor: "provider-a/original" },
			"modelProfile.default": "old-profile",
		});
		instrumentSettings(settings);
		const registry = fakeRegistry({
			missingProviders: ["provider-b"],
			profiles: [
				{
					name: "underdeclared-provider",
					requiredProviders: ["provider-a"],
					modelMapping: { default: "provider-a/default", executor: "provider-b/executor" },
					source: "user",
				},
			],
		});

		// Only explicitly declared requiredProviders hard-gate activation.
		// Mapped fallback providers (provider-b) are resolved entry-by-entry at
		// request time, so activation succeeds and the mapped selector is kept.
		await activateModelProfile({ session, modelRegistry: registry, settings, profileName: "underdeclared-provider" });
		expect(settings.get("task.agentModelOverrides").executor).toBe("provider-b/executor");
	});

	test("--default failure path does not persist or flush modelProfile.default", async () => {
		const session = fakeSession();
		const settings = Settings.isolated({ "modelProfile.default": "old-profile" });
		const calls = instrumentSettings(settings);
		const registry = fakeRegistry({
			profiles: [
				{
					name: "bad-default",
					requiredProviders: [],
					modelMapping: { default: "provider-a/missing" },
					source: "user",
				},
			],
		});

		await expect(
			activateModelProfile(
				{ session, modelRegistry: registry, settings, profileName: "bad-default" },
				{ persistDefault: true },
			),
		).rejects.toThrow('Model profile "bad-default" default selector did not resolve: provider-a/missing');
		expect(settings.get("modelProfile.default")).toBe("old-profile");
		expect(calls.setCalls).toEqual([]);
		expect(calls.overrideCalls).toEqual([]);
		expect(calls.flushCount).toBe(0);
	});

	test("session-only activation does not persist model roles, agent overrides, default profile, or models config", async () => {
		const session = fakeSession();
		const settings = Settings.isolated({
			modelRoles: { default: "provider-a/original-default" },
			"task.agentModelOverrides": { critic: "provider-a/original-critic" },
			"modelProfile.default": "old-profile",
		});
		const calls = instrumentSettings(settings);
		const registry = fakeRegistry({
			profiles: [
				{
					name: "session-only",
					requiredProviders: [],
					modelMapping: { default: "provider-a/default", executor: "provider-b/executor" },
					source: "user",
				},
			],
		});

		await activateModelProfile({ session, modelRegistry: registry, settings, profileName: "session-only" });
		expect(session.setModelTemporaryCalls).toHaveLength(1);
		expect(settings.get("modelRoles")).toEqual({ default: "provider-a/original-default" });
		expect(settings.get("task.agentModelOverrides")).toEqual({
			critic: "provider-a/original-critic",
			executor: "provider-b/executor",
		});
		expect(settings.get("modelProfile.default")).toBe("old-profile");
		expect(calls.setCalls).toEqual([]);
		expect(calls.overrideCalls).toEqual(["task.agentModelOverrides"]);
		expect(calls.flushCount).toBe(0);
	});

	test("unknown profile name lists available names", async () => {
		const registry = fakeRegistry({
			profiles: [
				{ name: "zeta", requiredProviders: [], modelMapping: {}, source: "user" },
				{ name: "alpha", requiredProviders: [], modelMapping: {}, source: "user" },
			],
		});

		await expect(
			activateModelProfile({
				session: fakeSession(),
				modelRegistry: registry,
				settings: Settings.isolated(),
				profileName: "missing",
			}),
		).rejects.toThrow('Unknown model profile "missing". Available profiles: alpha, zeta');
	});

	test("precedence: default profile then --mpreset session override, explicit role flag wins for that role", async () => {
		const session = fakeSession();
		const settings = Settings.isolated({ "modelProfile.default": "default-profile" });
		const registry = fakeRegistry({
			profiles: [
				{
					name: "default-profile",
					requiredProviders: [],
					modelMapping: { default: "provider-a/default", executor: "provider-b/executor" },
					source: "user",
				},
				{
					name: "session-profile",
					requiredProviders: [],
					modelMapping: {
						default: "provider-a/alternate",
						executor: "provider-a/architect",
						architect: "provider-b/executor",
					},
					source: "user",
				},
			],
		});

		await activateModelProfile({
			session,
			modelRegistry: registry,
			settings,
			profileName: settings.get("modelProfile.default")!,
		});
		await activateModelProfile({ session, modelRegistry: registry, settings, profileName: "session-profile" });
		settings.override("task.agentModelOverrides", {
			...settings.get("task.agentModelOverrides"),
			executor: "explicit/executor",
		});

		expect(session.setModelTemporaryCalls.map(call => `${call.model.provider}/${call.model.id}`)).toEqual([
			"provider-a/default",
			"provider-a/alternate",
		]);
		expect(session.model?.id).toBe("alternate");
		expect(settings.get("task.agentModelOverrides")).toEqual({
			executor: "explicit/executor",
			architect: "provider-b/executor",
		});
		expect(settings.get("modelProfile.default")).toBe("default-profile");
	});

	test("CLI rejects --default without --mpreset and parses both --mpreset forms", () => {
		expect(() => parseArgs(["--default"])).toThrow("--default requires --mpreset <name>");
		expect(parseArgs(["--mpreset=alpha"]).mpreset).toBe("alpha");
		expect(parseArgs(["--mpreset", "beta"]).mpreset).toBe("beta");
		expect(parseArgs(["--mpreset", "gamma", "--default"])).toMatchObject({ mpreset: "gamma", default: true });
	});
});
