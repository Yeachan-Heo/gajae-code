import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Model } from "@gajae-code/ai/core";
import {
	isModelProfileProviderAvailable,
	MODEL_PROFILE_DISCOVERY_QUERY,
	MODEL_PROFILE_ERROR_DETAIL_MAX_BYTES,
	ModelProfileRegistryError,
	projectModelProfileCatalog,
	UnknownModelProfileError,
	validateModelProfileName,
} from "../src/config/model-profile-contract";
import { mergeModelProfiles } from "../src/config/model-profiles";
import { kNoAuth, type ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import type { ExtensionAPI, ExtensionContext } from "../src/extensibility/extensions";
import { Broker } from "../src/sdk/broker/broker";
import {
	readSessionLifecycleFailureForTest,
	setLifecycleCommandResolverForTest,
	validateBrokerModelPresetForTest,
	writeSessionLifecycleFailure,
} from "../src/sdk/broker/lifecycle";
import { CursorRegistry, QueryHandlers, RevisionStore } from "../src/sdk/host/query/index.js";
import { createSdkSurfaceFactory } from "../src/sdk/host/session-runtime";
import { normalizeSdkStartupFailure } from "../src/sdk/startup-capability";

const dirs: string[] = [];
afterEach(async () => {
	await Promise.all(dirs.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});

async function temp(): Promise<string> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-sdk-profiles-"));
	dirs.push(directory);
	return directory;
}

function configuredProfile(displayName = "Configured Profile") {
	return {
		display_name: displayName,
		required_providers: ["provider-a"],
		model_mapping: { default: "provider-a/model" },
	};
}

function querySurface(getModelProfiles: () => unknown[]) {
	return {
		getTranscriptEntries: () => [],
		getContextSnapshot: () => ({}),
		getGoalState: () => [],
		getTodoState: () => [],
		getDiff: () => [],
		getUsage: () => ({}),
		getModels: () => [],
		getSkillState: () => [],
		getGates: () => [],
		getConfigItems: () => [],
		getSessionMetadata: () => ({}),
		getStats: () => ({}),
		getBranchCandidates: () => [],
		getLastAssistant: () => ({}),
		getCapabilities: () => ({}),
		getAuthProviders: () => [],
		getTools: () => [],
		getQueueMessages: () => [],
		getExtensions: () => [],
		getJobs: () => [],
		getModelProfiles,
	};
}

describe("model profile capability contract", () => {
	it("projects the effective sorted catalog with configured override identity and display label", () => {
		const profiles = mergeModelProfiles({
			"codex-eco": configuredProfile("Overridden Eco"),
			"custom/profile !": configuredProfile("Custom Display"),
		});
		const catalog = projectModelProfileCatalog(profiles);
		expect(catalog.map(item => item.id)).toEqual(
			[...catalog.map(item => item.id)].sort((a, b) => a.localeCompare(b)),
		);
		expect(catalog.find(item => item.id === "codex-eco")).toEqual({
			id: "codex-eco",
			displayName: "Overridden Eco",
			source: "configured",
		});
		expect(catalog.find(item => item.id === "custom/profile !")).toEqual({
			id: "custom/profile !",
			displayName: "Custom Display",
			source: "configured",
		});
		expect(catalog.some(item => Object.hasOwn(item, "description"))).toBe(false);
	});

	it("projects accepted registry provenance distinctly from embedded and user profiles", () => {
		const profiles = mergeModelProfiles(
			undefined,
			new Map([
				[
					"registry-profile",
					{
						name: "registry-profile",
						displayName: "Registry Profile",
						requiredProviders: ["provider-a"],
						modelMapping: { default: "provider-a/model" },
						source: "registry" as const,
					},
				],
			]),
		);
		expect(projectModelProfileCatalog(profiles).find(item => item.id === "registry-profile")).toEqual({
			id: "registry-profile",
			displayName: "Registry Profile",
			source: "configured",
		});
	});

	it("classifies strict and alternative provider requirements for clients", () => {
		const [strict] = [...mergeModelProfiles().values()].filter(profile => profile.name === "codex-medium");
		expect(strict).toBeDefined();
		expect(isModelProfileProviderAvailable(strict!, new Set(["openai-codex"]))).toBe(true);
		expect(isModelProfileProviderAvailable(strict!, new Set())).toBe(false);

		const alternative = {
			...strict!,
			requiredProviders: ["provider-a", "provider-b"],
			alternativeProviderGroups: [["provider-a", "provider-b"]],
		};
		expect(isModelProfileProviderAvailable(alternative, new Set(["provider-b"]))).toBe(true);
		expect(isModelProfileProviderAvailable(alternative, new Set())).toBe(false);
	});

	it("uses exact membership before the fallback-only legacy alias", () => {
		const aliasOnly = new Map<string, unknown>([["codex-medium", {}]]);
		expect(validateModelProfileName("codex-standard", aliasOnly)).toBe("codex-medium");
		const exactShadow = new Map<string, unknown>([
			["codex-standard", {}],
			["codex-medium", {}],
		]);
		expect(validateModelProfileName("codex-standard", exactShadow)).toBe("codex-standard");
		expect(validateModelProfileName(" custom/profile ! ", new Map([[" custom/profile ! ", {}]]))).toBe(
			" custom/profile ! ",
		);
	});

	it("bounds unknown-profile details without truncating any available ID", () => {
		const profiles = new Map<string, unknown>();
		for (let index = 0; index < 100; index++) profiles.set(`profile-${index}-${"x".repeat(80)}`, {});
		const error = new UnknownModelProfileError("missing\nprofile", profiles);
		expect(error.code).toBe("unknown_model_profile");
		expect(error.details.discoveryQuery).toBe(MODEL_PROFILE_DISCOVERY_QUERY);
		expect(error.details.requestedProfile).toBe("missing profile");
		expect(Buffer.byteLength(JSON.stringify(error.details))).toBeLessThanOrEqual(
			MODEL_PROFILE_ERROR_DETAIL_MAX_BYTES,
		);
		for (const id of error.details.availableProfiles) expect(profiles.has(id)).toBe(true);
	});

	it("fails closed when the effective registry has an error", () => {
		expect(() => projectModelProfileCatalog(mergeModelProfiles(), new Error("private parse path"))).toThrow(
			ModelProfileRegistryError,
		);
		try {
			validateModelProfileName("codex-eco", mergeModelProfiles(), new Error("private parse path"));
			throw new Error("expected model profile registry failure");
		} catch (error) {
			expect(error).toBeInstanceOf(ModelProfileRegistryError);
			expect((error as ModelProfileRegistryError).message).not.toContain("private parse path");
			expect((error as ModelProfileRegistryError).details).toEqual({
				requestedProfile: "codex-eco",
				availableProfiles: [],
				discoveryQuery: MODEL_PROFILE_DISCOVERY_QUERY,
			});
		}
	});
});

describe("Q27 models.profiles.list", () => {
	it("marks a registry profile unavailable when a qualified role is absent from the effective catalog", async () => {
		const model = (provider: string, id: string): Model =>
			({ provider, id, name: id, api: "openai-responses", contextWindow: 1000, maxTokens: 1000 }) as Model;
		const profile = {
			name: "registry-role-missing",
			displayName: "Registry Role Missing",
			requiredProviders: ["provider-a"],
			modelMapping: { default: "provider-a/default", executor: "provider-a/missing" },
			source: "registry" as const,
		};
		const defaultModel = model("provider-a", "default");
		const registry = {
			getModelProfiles: () => new Map([[profile.name, profile]]),
			getError: () => undefined,
			getApiKeyForProvider: async () => "provider-a-key",
			getConfiguredProviderIds: () => [],
			getAvailable: () => [defaultModel, model("provider-a", "missing")],
			getAvailableForProfileActivation: () => [defaultModel],
			getApiKey: async () => "provider-a-key",
			resolveCanonicalModel: () => undefined,
			getCanonicalVariants: () => [],
			getCanonicalId: () => undefined,
		} as unknown as ModelRegistry;
		const settings = Settings.isolated();
		const ctx = {
			cwd: "/tmp",
			workflowGate: undefined,
			sdkBindings: () => [],
			sessionManager: {
				getSessionId: () => "q27-profile-session",
				getSessionFile: () => "/tmp/q27-profile-session.json",
				getSessionName: () => undefined,
				getBranch: () => [],
			},
			getGoalState: () => undefined,
			modelRegistry: registry,
			settings,
		} as unknown as ExtensionContext;

		const surface = createSdkSurfaceFactory({
			ctx,
			id: "q27-profile-session",
			api: {} as ExtensionAPI,
		});
		if (!surface.query) throw new Error("query surface is unavailable");
		if (typeof surface.query.getModelProfiles !== "function") throw new Error("profile query is unavailable");
		const profiles = await surface.query.getModelProfiles();
		const item = profiles.find(candidate => (candidate as { id: string }).id === profile.name) as
			| { available: unknown }
			| undefined;

		expect(item).toBeDefined();
		expect(item?.available).toBe(false);
		expect(typeof item?.available).toBe("boolean");
	});

	it("uses authenticated alternative credentials for qualified profile mappings", async () => {
		const model = (provider: string, id: string): Model =>
			({ provider, id, name: id, api: "openai-responses", contextWindow: 1000, maxTokens: 1000 }) as Model;
		const profile = {
			name: "registry-alternative-mapped",
			displayName: "Registry Alternative Mapped",
			requiredProviders: ["provider-a"],
			alternativeProviderGroups: [["provider-b", "provider-c"]],
			modelMapping: { default: "provider-a/default", executor: "provider-b/executor" },
			source: "registry" as const,
		};
		const defaultModel = model("provider-a", "default");
		const fallbackModel = model("provider-c", "executor");
		const credentials = new Map<string, string | undefined>([
			["provider-a", "provider-a-key"],
			["provider-b", undefined],
			["provider-c", "provider-c-key"],
		]);
		const registry = {
			getModelProfiles: () => new Map([[profile.name, profile]]),
			getError: () => undefined,
			getApiKeyForProvider: async (provider: string) => credentials.get(provider),
			getConfiguredProviderIds: () => [],
			getAvailable: () => [defaultModel, fallbackModel],
			getAvailableForProfileActivation: () => [defaultModel, fallbackModel],
			getApiKey: async (candidate: Model) => credentials.get(candidate.provider),
			resolveCanonicalModel: () => undefined,
			getCanonicalVariants: () => [],
			getCanonicalId: () => undefined,
		} as unknown as ModelRegistry;
		const settings = Settings.isolated();
		const ctx = {
			cwd: "/tmp",
			workflowGate: undefined,
			sdkBindings: () => [],
			sessionManager: {
				getSessionId: () => "q27-alternative-session",
				getSessionFile: () => "/tmp/q27-alternative-session.json",
				getSessionName: () => undefined,
				getBranch: () => [],
			},
			getGoalState: () => undefined,
			modelRegistry: registry,
			settings,
		} as unknown as ExtensionContext;

		const surface = createSdkSurfaceFactory({ ctx, id: "q27-alternative-session", api: {} as ExtensionAPI });
		const profiles = await surface.query.getModelProfiles!();
		const item = profiles.find(candidate => (candidate as { id: string }).id === profile.name) as
			| { available: unknown }
			| undefined;

		expect(item?.available).toBe(true);
		expect(typeof item?.available).toBe("boolean");
	});

	for (const proxyMode of ["fallback", "always"] as const) {
		for (const [provider, apiKey, available] of [
			["opencodex", kNoAuth, true],
			["opencodex", undefined, false],
			["opencodex", "unconfigured-key", false],
			["custom-proxy", kNoAuth, false],
		] as const) {
			it(`discovered proxy SDK availability: ${proxyMode}, ${provider}, ${apiKey}`, async () => {
				const profile = {
					name: "discovered-ocx",
					requiredProviders: ["anthropic"],
					modelMapping: { default: "anthropic/claude-opus-5" },
					source: "registry" as const,
				};
				const proxyModel = {
					provider,
					id: "opencodex/claude-opus-5",
					wireModelId: "claude-opus-5",
					name: "Opus",
					api: "openai-responses",
					contextWindow: 1000,
					maxTokens: 1000,
				} as Model;
				const registry = {
					getModelProfiles: () => new Map([[profile.name, profile]]),
					getError: () => undefined,
					getConfiguredProviderIds: () => [],
					getApiKeyForProvider: async (id: string) => (id === provider ? apiKey : undefined),
					getAvailable: () => [proxyModel],
					getAvailableForProfileActivation: () => [proxyModel],
					resolveCanonicalModel: () => undefined,
					getCanonicalVariants: () => [],
					getCanonicalId: () => undefined,
				} as unknown as ModelRegistry;
				const settings = Settings.isolated({
					"modelProfile.proxyProvider": provider,
					"modelProfile.proxyMode": proxyMode,
				});
				const ctx = {
					cwd: "/tmp",
					sdkBindings: () => [],
					sessionManager: {
						getSessionId: () => "ocx-availability",
						getSessionFile: () => "/tmp/ocx-availability.json",
						getSessionName: () => undefined,
						getBranch: () => [],
					},
					getGoalState: () => undefined,
					modelRegistry: registry,
					settings,
				} as unknown as ExtensionContext;
				const surface = createSdkSurfaceFactory({ ctx, id: "ocx-availability", api: {} as ExtensionAPI });
				const profiles = await surface.query.getModelProfiles!();
				const item = profiles.find(candidate => (candidate as { id: string }).id === profile.name) as
					| { available: boolean }
					| undefined;
				expect(item?.available).toBe(available);
			});
		}
	}

	it("keeps fallback-mode availability when a configured proxy is not authenticated but direct auth works", async () => {
		const model = (provider: string, id: string): Model =>
			({ provider, id, name: id, api: "openai-responses", contextWindow: 1000, maxTokens: 1000 }) as Model;
		const profile = {
			name: "registry-fallback-proxy",
			displayName: "Registry Fallback Proxy",
			requiredProviders: ["provider-a"],
			modelMapping: { default: "provider-a/default" },
			source: "registry" as const,
		};
		const registry = {
			getModelProfiles: () => new Map([[profile.name, profile]]),
			getError: () => undefined,
			getApiKeyForProvider: async (provider: string) => (provider === "provider-a" ? "provider-a-key" : undefined),
			getConfiguredProviderIds: () => ["litellm"],
			getAvailable: () => [model("provider-a", "default")],
			getAvailableForProfileActivation: () => [model("provider-a", "default")],
			getApiKey: async () => "provider-a-key",
			resolveCanonicalModel: () => undefined,
			getCanonicalVariants: () => [],
			getCanonicalId: () => undefined,
		} as unknown as ModelRegistry;
		const settings = Settings.isolated({
			"modelProfile.proxyProvider": "litellm",
			"modelProfile.proxyMode": "fallback",
		});
		const ctx = {
			cwd: "/tmp",
			workflowGate: undefined,
			sdkBindings: () => [],
			sessionManager: {
				getSessionId: () => "q27-fallback-proxy-session",
				getSessionFile: () => "/tmp/q27-fallback-proxy-session.json",
				getSessionName: () => undefined,
				getBranch: () => [],
			},
			getGoalState: () => undefined,
			modelRegistry: registry,
			settings,
		} as unknown as ExtensionContext;

		const surface = createSdkSurfaceFactory({ ctx, id: "q27-fallback-proxy-session", api: {} as ExtensionAPI });
		const profiles = await surface.query.getModelProfiles!();
		const item = profiles.find(candidate => (candidate as { id: string }).id === profile.name) as
			| { available: unknown }
			| undefined;

		expect(item?.available).toBe(true);
		expect(typeof item?.available).toBe("boolean");
	});

	it("rejects always-mode availability when its configured proxy is unavailable", async () => {
		const model = (provider: string, id: string): Model =>
			({ provider, id, name: id, api: "openai-responses", contextWindow: 1000, maxTokens: 1000 }) as Model;
		const profile = {
			name: "registry-always-proxy",
			displayName: "Registry Always Proxy",
			requiredProviders: ["provider-a"],
			modelMapping: { default: "provider-a/default" },
			source: "registry" as const,
		};
		const registry = {
			getModelProfiles: () => new Map([[profile.name, profile]]),
			getError: () => undefined,
			getApiKeyForProvider: async (provider: string) => (provider === "provider-a" ? "provider-a-key" : undefined),
			getConfiguredProviderIds: () => [],
			getAvailable: () => [model("provider-a", "default")],
			getAvailableForProfileActivation: () => [model("provider-a", "default")],
			getApiKey: async () => "provider-a-key",
			resolveCanonicalModel: () => undefined,
			getCanonicalVariants: () => [],
			getCanonicalId: () => undefined,
		} as unknown as ModelRegistry;
		const settings = Settings.isolated({
			"modelProfile.proxyProvider": "litellm",
			"modelProfile.proxyMode": "always",
		});
		const ctx = {
			cwd: "/tmp",
			workflowGate: undefined,
			sdkBindings: () => [],
			sessionManager: {
				getSessionId: () => "q27-always-proxy-session",
				getSessionFile: () => "/tmp/q27-always-proxy-session.json",
				getSessionName: () => undefined,
				getBranch: () => [],
			},
			getGoalState: () => undefined,
			modelRegistry: registry,
			settings,
		} as unknown as ExtensionContext;

		const surface = createSdkSurfaceFactory({ ctx, id: "q27-always-proxy-session", api: {} as ExtensionAPI });
		const profiles = await surface.query.getModelProfiles!();
		const item = profiles.find(candidate => (candidate as { id: string }).id === profile.name) as
			| { available: unknown }
			| undefined;

		expect(item?.available).toBe(false);
		expect(typeof item?.available).toBe("boolean");
	});

	it("retains one sorted catalog revision across pages and refreshes on a cursorless request", async () => {
		const oldCatalog = Array.from({ length: 6 }, (_, index) => ({
			id: `old-${index}`,
			displayName: `${index}-${"x".repeat(90_000)}`,
			source: "configured" as const,
		}));
		let currentCatalog = oldCatalog;
		const store = new RevisionStore("s1");
		const cursors = new CursorRegistry("token", store);
		const handlers = new QueryHandlers(
			querySurface(() => currentCatalog),
			"s1",
			store,
			cursors,
		);
		const first = await handlers.dispatch({ query: "models.profiles.list", connectionId: "c" });
		expect(first.ok).toBe(true);
		expect(first.page?.complete).toBe(false);
		currentCatalog = [{ id: "new", displayName: "New", source: "configured" }];
		const second = await handlers.dispatch({
			query: "Q27",
			cursor: first.page?.continuationCursor,
			connectionId: "c",
		});
		const retainedIds = [...(first.page?.items ?? []), ...(second.page?.items ?? [])].map(
			item => (item as { id: string }).id,
		);
		expect(retainedIds.every(id => id.startsWith("old-"))).toBe(true);
		const refreshed = await handlers.dispatch({ query: "models.profiles.list", connectionId: "c" });
		expect(refreshed.page?.items).toEqual(currentCatalog);
	});

	it("rejects selectors, gates installation, and preserves typed registry details", async () => {
		const store = new RevisionStore("s1");
		const handlers = new QueryHandlers(
			{
				...querySurface(() => {
					throw new ModelProfileRegistryError();
				}),
				installedQueries: new Set(["models.profiles.list"]),
			},
			"s1",
			store,
			new CursorRegistry("token", store),
		);
		expect(await handlers.dispatch({ query: "Q27", input: { root: "/tmp" }, connectionId: "c" })).toMatchObject({
			ok: false,
			error: { code: "invalid_request" },
		});
		expect(await handlers.dispatch({ query: "Q27", connectionId: "c" })).toMatchObject({
			ok: false,
			error: {
				code: "model_profile_registry_error",
				details: { availableProfiles: [], discoveryQuery: MODEL_PROFILE_DISCOVERY_QUERY },
			},
		});
		const restricted = new QueryHandlers(
			{ ...querySurface(() => []), installedQueries: new Set(["models.list/current"]) },
			"s1",
			new RevisionStore("s1"),
			new CursorRegistry("token", new RevisionStore("s1")),
		);
		expect(await restricted.dispatch({ query: "models.profiles.list", connectionId: "c" })).toMatchObject({
			ok: false,
			error: { code: "operation_not_session_owned" },
		});
	});
});

describe("broker model-profile validation", () => {
	it("loads exact custom IDs from broker.settings.agentDir and fails closed on invalid config", async () => {
		const agentDir = await temp();
		await Bun.write(
			path.join(agentDir, "models.yml"),
			`profiles:\n  "custom/profile !":\n    display_name: Agent Dir Profile\n    required_providers: [provider-a]\n    model_mapping:\n      default: provider-a/model\n`,
		);
		expect(validateBrokerModelPresetForTest(agentDir, "custom/profile !")).toBe("custom/profile !");
		expect(validateBrokerModelPresetForTest(agentDir, "codex-standard")).toBe("codex-medium");
		const cwd = await temp();
		const stateRoot = path.join(cwd, ".gjc", "state");
		await fs.mkdir(stateRoot, { recursive: true });
		await Bun.write(
			path.join(cwd, "models.yml"),
			`profiles:\n  cwd-only:\n    required_providers: [provider-b]\n    model_mapping:\n      default: provider-b/model\n`,
		);
		expect(validateBrokerModelPresetForTest(agentDir, "cwd-only")).toMatchObject({
			ok: false,
			error: { code: "unknown_model_profile" },
		});
		expect(stateRoot).not.toBe(agentDir);
		const unknown = validateBrokerModelPresetForTest(agentDir, "missing");
		expect(unknown).toMatchObject({
			ok: false,
			error: {
				code: "unknown_model_profile",
				details: { requestedProfile: "missing", discoveryQuery: MODEL_PROFILE_DISCOVERY_QUERY },
			},
		});
		await Bun.write(path.join(agentDir, "models.yml"), "profiles: [invalid");
		const invalid = validateBrokerModelPresetForTest(agentDir, "custom/profile !");
		expect(invalid).toMatchObject({
			ok: false,
			error: {
				code: "model_profile_registry_error",
				details: { requestedProfile: "custom/profile !", availableProfiles: [] },
			},
		});
		expect(JSON.stringify(invalid)).not.toContain(agentDir);
	});

	it("rejects an unknown session.create preset before a child can spawn", async () => {
		const agentDir = await temp();
		const cwd = path.join(await temp(), "repo");
		await fs.mkdir(cwd);
		const broker = new Broker({ agentDir });
		let spawnResolverCalls = 0;
		setLifecycleCommandResolverForTest(broker, () => {
			spawnResolverCalls++;
			return { file: process.execPath, args: ["-e", "process.exit(0)"] };
		});
		await broker.start();
		try {
			for (const [modelPreset, key] of [
				["", "q27-empty-pre-spawn"],
				[42, "q27-non-string-pre-spawn"],
			] as const) {
				expect(await broker.handleRequest("session.create", { cwd, modelPreset }, key)).toMatchObject({
					ok: false,
					error: { code: "invalid_input" },
				});
			}
			const response = await broker.handleRequest(
				"session.create",
				{ cwd, modelPreset: "definitely-missing" },
				"q27-unknown-pre-spawn",
			);
			expect(response).toMatchObject({
				ok: false,
				error: {
					code: "unknown_model_profile",
					details: { requestedProfile: "definitely-missing", discoveryQuery: MODEL_PROFILE_DISCOVERY_QUERY },
				},
			});
			await Bun.write(path.join(agentDir, "models.yml"), "profiles: [invalid");
			expect(
				await broker.handleRequest(
					"session.create",
					{ cwd, modelPreset: "definitely-missing" },
					"q27-invalid-registry-pre-spawn",
				),
			).toMatchObject({
				ok: false,
				error: { code: "model_profile_registry_error", details: { availableProfiles: [] } },
			});
			expect(spawnResolverCalls).toBe(0);
		} finally {
			setLifecycleCommandResolverForTest(broker, undefined);
			await broker.stop();
		}
	});
});

describe("model-profile startup failure propagation", () => {
	it("normalizes, persists, and reads both typed profile errors without collapsing their codes", async () => {
		const root = await temp();
		const manyProfiles = new Map<string, unknown>();
		for (let index = 0; index < 100; index++) manyProfiles.set(`profile-${index}-${"x".repeat(80)}`, {});
		const failures = [
			normalizeSdkStartupFailure("startup", "failed", new UnknownModelProfileError("missing", manyProfiles)),
			normalizeSdkStartupFailure("startup", "failed", new ModelProfileRegistryError("requested")),
		];
		expect(failures[0]).toMatchObject({
			code: "unknown_model_profile",
			details: { requestedProfile: "missing", discoveryQuery: MODEL_PROFILE_DISCOVERY_QUERY },
		});
		expect(failures[1]).toMatchObject({
			code: "model_profile_registry_error",
			details: { requestedProfile: "requested", availableProfiles: [] },
		});
		const rollback = {
			endpointGeneration: null,
			fenced: true,
			runtimeRemoved: true,
			hostStopped: true,
			brokerRegistrationReleased: true,
		};
		for (const [index, failure] of failures.entries()) {
			const id = `profile-session-${index}`;
			const expected = {
				pid: process.pid,
				effectMarker: `profile-failure-${index}`,
				incarnation: "test-incarnation",
			};
			await writeSessionLifecycleFailure(
				root,
				id,
				expected.effectMarker,
				failure,
				rollback,
				undefined,
				expected.incarnation,
			);
			await expect(readSessionLifecycleFailureForTest(root, id, expected)).resolves.toEqual(failure);
		}
	});
});
