import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Model } from "@gajae-code/ai";
import { getOAuthProviders } from "@gajae-code/ai/utils/oauth";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import {
	clearProviderAuthHealth,
	getProviderAuthHealth,
	recordProviderAuthHealth,
} from "@gajae-code/coding-agent/config/provider-auth-health";
import {
	compareRankedProviders,
	PROVIDER_RANK_TIER,
	providerRankTier,
	type RankableProvider,
} from "@gajae-code/coding-agent/config/provider-ranking";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { ModelSelectorComponent } from "@gajae-code/coding-agent/modes/components/model-selector";
import { OAuthSelectorComponent } from "@gajae-code/coding-agent/modes/components/oauth-selector";
import { getThemeByName, setThemeInstance } from "@gajae-code/coding-agent/modes/theme/theme";
import { AuthStorage, type AuthStorage as AuthStorageType } from "@gajae-code/coding-agent/session/auth-storage";
import type { TUI } from "@gajae-code/tui";

const model = (provider: string, id: string): Model =>
	({ provider, id, name: id, api: "openai-responses", contextWindow: 1000, maxTokens: 1000 }) as Model;

const PROBE_API_KEY_ENV = "GJC_REDTEAM_PROVIDER_AUTH_HEALTH_PROBE_KEY";

let testTheme = await getThemeByName("red-claw");

function installTestTheme(): void {
	if (!testTheme) throw new Error("Failed to load test theme");
	setThemeInstance(testTheme);
}

function stripAnsi(value: string): string {
	return value.replace(/\x1b\[[0-9;]*m/g, "");
}

function renderedLines(component: { render(width: number): string[] }): string[] {
	installTestTheme();
	return component.render(240).map(stripAnsi);
}

function modelRows(selector: ModelSelectorComponent, models: readonly Model[]): string[] {
	const keys = models.map(candidate => `${candidate.provider}/${candidate.id}`).sort((a, b) => b.length - a.length);
	return renderedLines(selector).flatMap(line => {
		const normalized = line.trimStart().replace(/^❯\s+/, "");
		const key = keys.find(candidate => normalized.startsWith(candidate));
		return key ? [key] : [];
	});
}

type AuthStorageDouble = Pick<AuthStorageType, "hasAuth" | "getGeneration">;
type MutableAuthStorageDouble = AuthStorageType & { bumpGeneration(): void };

const trackedAuthStorages = new Set<AuthStorageType>();

function trackAuthStorage<T extends AuthStorageType>(authStorage: T): T {
	trackedAuthStorages.add(authStorage);
	return authStorage;
}

function clearTrackedProviderAuthHealth(): void {
	for (const authStorage of trackedAuthStorages) clearProviderAuthHealth(authStorage);
	trackedAuthStorages.clear();
}

function createAuthStorageDouble(authenticatedProviders: readonly string[] = []): MutableAuthStorageDouble {
	let generation = 1;
	const providers = new Set(authenticatedProviders);
	const authStorage = {
		hasAuth: (provider: string) => providers.has(provider),
		getGeneration: () => generation,
		bumpGeneration: () => {
			generation += 1;
		},
	};
	return trackAuthStorage(authStorage as unknown as AuthStorageType) as unknown as MutableAuthStorageDouble;
}

type ModelRegistryOptions = {
	models: readonly Model[];
	configuredProviders?: readonly string[];
	authStorage?: AuthStorageDouble;
};

function createModelRegistry(options: ModelRegistryOptions): ModelRegistry {
	const configuredProviders = new Set(options.configuredProviders ?? []);
	const authStorage = options.authStorage ?? createAuthStorageDouble([...configuredProviders]);
	trackAuthStorage(authStorage as unknown as AuthStorageType);
	const hasConfiguredProviderAuth = vi.fn(
		(provider: string) => configuredProviders.has(provider) || authStorage.hasAuth(provider),
	);
	return {
		authStorage,
		refresh: vi.fn(async () => {}),
		refreshProvider: vi.fn(async () => {}),
		getError: () => undefined,
		getAvailable: () => [...options.models],
		getAll: () => [...options.models],
		hasConfiguredProviderAuth,
		getDiscoverableProviders: () => [],
		getCanonicalModels: () => [],
		resolveCanonicalModel: () => undefined,
		getModelProfiles: () => new Map(),
		getApiKeyForProvider: async () => undefined,
		getApiKey: async () => undefined,
	} as unknown as ModelRegistry;
}

async function createModelSelector(
	models: readonly Model[],
	options: { registry?: ModelRegistry; configuredProviders?: readonly string[]; authStorage?: AuthStorageDouble } = {},
): Promise<ModelSelectorComponent> {
	const selector = new ModelSelectorComponent(
		{ requestRender: vi.fn() } as unknown as TUI,
		undefined,
		Settings.isolated(),
		options.registry ??
			createModelRegistry({
				models,
				configuredProviders: options.configuredProviders,
				authStorage: options.authStorage,
			}),
		[],
		() => {},
		() => {},
		{ temporaryOnly: true },
	);
	await Bun.sleep(10);
	return selector;
}

async function waitFor(condition: () => boolean): Promise<void> {
	const deadline = Date.now() + 2_000;
	while (!condition() && Date.now() < deadline) await Bun.sleep(10);
	expect(condition()).toBe(true);
}

beforeEach(async () => {
	clearTrackedProviderAuthHealth();
	testTheme = await getThemeByName("red-claw");
	installTestTheme();
});

afterEach(() => {
	clearTrackedProviderAuthHealth();
});

describe("provider auth health state attacks", () => {
	test("records last-write-wins health and clear fully removes every entry", () => {
		const authStorage = createAuthStorageDouble();
		recordProviderAuthHealth(authStorage, "last-write", "invalid");
		recordProviderAuthHealth(authStorage, "last-write", "valid");
		recordProviderAuthHealth(authStorage, "other-entry", "invalid");

		expect(getProviderAuthHealth(authStorage, "last-write")).toBe("valid");
		expect(getProviderAuthHealth(authStorage, "other-entry")).toBe("invalid");

		clearProviderAuthHealth(authStorage);
		expect(getProviderAuthHealth(authStorage, "last-write")).toBeUndefined();
		expect(getProviderAuthHealth(authStorage, "other-entry")).toBeUndefined();
	});

	test("uses Map-safe keys without prototype pollution", () => {
		const authStorage = createAuthStorageDouble();
		const ids = ["", "x".repeat(100_000), "零😀e\u0301", "__proto__", "constructor", "toString"];
		const objectPrototypeKeysBefore = Reflect.ownKeys(Object.prototype);

		for (const id of ids) {
			recordProviderAuthHealth(authStorage, id, "valid");
			expect(getProviderAuthHealth(authStorage, id)).toBe("valid");
		}

		expect(Reflect.ownKeys(Object.prototype)).toEqual(objectPrototypeKeysBefore);
		expect(({} as Record<string, unknown>).polluted).toBeUndefined();
		expect(Object.prototype.constructor).toBe(Object);
		expect(typeof Object.prototype.toString).toBe("function");

		clearProviderAuthHealth(authStorage);
		for (const id of ids) expect(getProviderAuthHealth(authStorage, id)).toBeUndefined();
	});

	test("isolates OAuth validation health between unrelated AuthStorage instances", async () => {
		const target = getOAuthProviders().find(provider => provider.id === "cursor");
		if (!target) throw new Error("Expected cursor OAuth provider");

		const oauthStorage = trackAuthStorage(await AuthStorage.create(":memory:"));
		const modelStorage = trackAuthStorage(await AuthStorage.create(":memory:"));
		oauthStorage.setRuntimeApiKey(target.id, "oauth-test-key");
		const oauthSelector = new OAuthSelectorComponent(
			"login",
			oauthStorage,
			() => {},
			() => {},
			{ validateAuth: async () => false, requestRender: vi.fn() },
		);

		try {
			await waitFor(() => getProviderAuthHealth(oauthStorage, target.id) === "invalid");
			expect(getProviderAuthHealth(oauthStorage, target.id)).toBe("invalid");
			expect(getProviderAuthHealth(modelStorage, target.id)).toBeUndefined();

			const cursorModel = model("cursor", "cursor-model");
			const anthropicModel = model("anthropic", "anthropic-model");
			const selector = await createModelSelector([anthropicModel, cursorModel], { authStorage: modelStorage });
			try {
				// The model selector's storage has no validation hint, so famous-list order remains anthropic before cursor.
				expect(modelRows(selector, [cursorModel, anthropicModel])).toEqual([
					"anthropic/anthropic-model",
					"cursor/cursor-model",
				]);
			} finally {
				selector.dispose();
			}
		} finally {
			oauthSelector.dispose();
			modelStorage.close();
			oauthStorage.close();
		}
	});

	test("discards a valid hint after the AuthStorage generation changes", async () => {
		const staleProvider = "stale-custom-provider";
		const staleModel = model(staleProvider, "stale-model");
		const famousModel = model("anthropic", "anthropic-model");
		const authStorage = createAuthStorageDouble();
		const registry = createModelRegistry({ models: [famousModel, staleModel], authStorage });

		recordProviderAuthHealth(authStorage, staleProvider, "valid");
		expect(getProviderAuthHealth(authStorage, staleProvider)).toBe("valid");
		authStorage.bumpGeneration();
		expect(getProviderAuthHealth(authStorage, staleProvider)).toBeUndefined();
		expect(authStorage.hasAuth(staleProvider)).toBe(false);

		const selector = await createModelSelector([famousModel, staleModel], { registry });
		try {
			// Once the generation changes, /model falls back to hasConfiguredProviderAuth instead of the old hint.
			expect(modelRows(selector, [staleModel, famousModel])).toEqual([
				"anthropic/anthropic-model",
				"stale-custom-provider/stale-model",
			]);
			expect(registry.hasConfiguredProviderAuth).toHaveBeenCalledWith(staleProvider);
		} finally {
			selector.dispose();
		}
	});

	test("ranks recorded invalid famous providers above tier-three unknown providers", async () => {
		const staleInvalid = model("cursor", "cursor-model");
		const unknown = model("tier-three-unknown", "unknown-model");
		const authStorage = createAuthStorageDouble();
		recordProviderAuthHealth(authStorage, staleInvalid.provider, "invalid");

		const selector = await createModelSelector([unknown, staleInvalid], { authStorage });
		try {
			expect(modelRows(selector, [staleInvalid, unknown])).toEqual([
				"cursor/cursor-model",
				"tier-three-unknown/unknown-model",
			]);
		} finally {
			selector.dispose();
		}

		const staleInvalidEntry: RankableProvider = { id: "cursor", label: "Cursor", authState: "invalid" };
		const unknownEntry: RankableProvider = {
			id: "tier-three-unknown",
			label: "AAA Unknown",
			authState: "none",
		};
		expect(providerRankTier(staleInvalidEntry.authState, staleInvalidEntry.id)).toBe(PROVIDER_RANK_TIER.problematic);
		expect(compareRankedProviders(staleInvalidEntry, unknownEntry)).toBeLessThan(0);
		expect(compareRankedProviders(unknownEntry, staleInvalidEntry)).toBeGreaterThan(0);
	});

	test("discards invalid health after a public credential mutation bumps generation", async () => {
		const provider = "relogin-provider";
		const authStorage = trackAuthStorage(await AuthStorage.create(":memory:"));
		try {
			const initialGeneration = authStorage.getGeneration();
			recordProviderAuthHealth(authStorage, provider, "invalid");
			expect(getProviderAuthHealth(authStorage, provider)).toBe("invalid");

			authStorage.setRuntimeApiKey(provider, "relogin-key");
			expect(authStorage.getGeneration()).toBeGreaterThan(initialGeneration);
			expect(authStorage.hasAuth(provider)).toBe(true);
			expect(getProviderAuthHealth(authStorage, provider)).toBeUndefined();
		} finally {
			clearProviderAuthHealth(authStorage);
			authStorage.close();
		}
	});

	test("discards valid health after runtime-key logout and falls back to configured auth", async () => {
		const provider = "configured-after-logout";
		const configuredModel = model(provider, "configured-model");
		const famousModel = model("anthropic", "anthropic-model");
		const authStorage = trackAuthStorage(await AuthStorage.create(":memory:"));
		try {
			authStorage.setRuntimeApiKey(provider, "configured-key");
			const registry = createModelRegistry({
				models: [famousModel, configuredModel],
				configuredProviders: [provider],
				authStorage,
			});
			recordProviderAuthHealth(authStorage, provider, "valid");
			expect(getProviderAuthHealth(authStorage, provider)).toBe("valid");

			authStorage.removeRuntimeApiKey(provider);
			expect(authStorage.hasAuth(provider)).toBe(false);
			expect(getProviderAuthHealth(authStorage, provider)).toBeUndefined();

			const selector = await createModelSelector([famousModel, configuredModel], { registry });
			try {
				expect(modelRows(selector, [configuredModel, famousModel])).toEqual([
					"configured-after-logout/configured-model",
					"anthropic/anthropic-model",
				]);
				expect(registry.hasConfiguredProviderAuth).toHaveBeenCalledWith(provider);
			} finally {
				selector.dispose();
			}
		} finally {
			clearProviderAuthHealth(authStorage);
			authStorage.close();
		}
	});
});

describe("hasConfiguredProviderAuth contract attacks", () => {
	test("agrees with hasConfiguredAuth for a configured provider that owns a model", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-provider-auth-health-"));
		const modelsPath = path.join(root, "models.yml");
		const authStorage = trackAuthStorage(await AuthStorage.create(":memory:"));
		const previousProbeKey = process.env[PROBE_API_KEY_ENV];
		delete process.env[PROBE_API_KEY_ENV];

		try {
			await Bun.write(
				modelsPath,
				JSON.stringify({
					providers: {
						"configured-probe": {
							baseUrl: "https://configured-probe.example/v1",
							api: "openai-responses",
							apiKeyEnv: PROBE_API_KEY_ENV,
							models: [{ id: "probe-model", name: "Probe Model", reasoning: false, input: ["text"] }],
						},
						"keyless-probe": {
							baseUrl: "https://keyless-probe.example/v1",
							api: "openai-responses",
							auth: "none",
							models: [{ id: "probe-model", name: "Keyless Probe", reasoning: false, input: ["text"] }],
						},
					},
				}),
			);

			const registry = new ModelRegistry(authStorage, modelsPath);
			await registry.refresh("offline");
			const configuredModel = registry.find("configured-probe", "probe-model");
			const keylessModel = registry.find("keyless-probe", "probe-model");
			if (!configuredModel || !keylessModel) throw new Error("Expected probe models in registry");

			expect(authStorage.hasAuth(configuredModel.provider)).toBe(false);
			expect(registry.hasConfiguredAuth(configuredModel)).toBe(false);
			expect(registry.hasConfiguredProviderAuth(configuredModel.provider)).toBe(false);

			authStorage.setRuntimeApiKey(configuredModel.provider, "probe-key");
			expect(registry.hasConfiguredAuth(configuredModel)).toBe(true);
			expect(registry.hasConfiguredProviderAuth(configuredModel.provider)).toBe(true);
			expect(registry.hasConfiguredAuth(configuredModel)).toBe(
				registry.hasConfiguredProviderAuth(configuredModel.provider),
			);
		} finally {
			if (previousProbeKey === undefined) delete process.env[PROBE_API_KEY_ENV];
			else process.env[PROBE_API_KEY_ENV] = previousProbeKey;
			authStorage.close();
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test("returns true for a keyless provider with no stored credentials", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-provider-auth-health-keyless-"));
		const modelsPath = path.join(root, "models.yml");
		const authStorage = trackAuthStorage(await AuthStorage.create(":memory:"));
		await Bun.write(
			modelsPath,
			JSON.stringify({
				providers: {
					"keyless-probe": {
						baseUrl: "https://keyless-probe.example/v1",
						api: "openai-responses",
						auth: "none",
						models: [{ id: "probe-model", name: "Keyless Probe", reasoning: false, input: ["text"] }],
					},
				},
			}),
		);

		try {
			const registry = new ModelRegistry(authStorage, modelsPath);
			await registry.refresh("offline");
			const keylessModel = registry.find("keyless-probe", "probe-model");
			if (!keylessModel) throw new Error("Expected keyless probe model in registry");

			expect(authStorage.hasAuth(keylessModel.provider)).toBe(false);
			expect(registry.hasConfiguredAuth(keylessModel)).toBe(true);
			expect(registry.hasConfiguredProviderAuth(keylessModel.provider)).toBe(true);
		} finally {
			authStorage.close();
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});
