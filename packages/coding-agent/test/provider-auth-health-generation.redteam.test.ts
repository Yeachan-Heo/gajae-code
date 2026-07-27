import { afterEach, beforeEach, describe, expect, type Mock, test, vi } from "bun:test";
import type { Model } from "@gajae-code/ai";
import type { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import {
	clearProviderAuthHealth,
	getProviderAuthHealth,
	recordProviderAuthHealth,
} from "@gajae-code/coding-agent/config/provider-auth-health";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { ModelSelectorComponent } from "@gajae-code/coding-agent/modes/components/model-selector";
import { getThemeByName, setThemeInstance } from "@gajae-code/coding-agent/modes/theme/theme";
import { AuthStorage, type AuthStorage as AuthStorageType } from "@gajae-code/coding-agent/session/auth-storage";
import type { TUI } from "@gajae-code/tui";

const model = (provider: string, id: string): Model =>
	({ provider, id, name: id, api: "openai-responses", contextWindow: 1000, maxTokens: 1000 }) as Model;

const apiKey = (key: string) => ({ type: "api_key" as const, key });
const oauthCredential = (suffix: string) => ({
	type: "oauth" as const,
	access: `access-${suffix}`,
	refresh: `refresh-${suffix}`,
	expires: 0,
	accountId: `account-${suffix}`,
});

let testTheme = await getThemeByName("red-claw");
const trackedAuthStorages = new Set<AuthStorageType>();

function installTestTheme(): void {
	if (!testTheme) throw new Error("Failed to load red-claw test theme");
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

async function createAuthStorage(options: ConstructorParameters<typeof AuthStorage>[1] = {}): Promise<AuthStorageType> {
	const authStorage = await AuthStorage.create(":memory:", options);
	trackedAuthStorages.add(authStorage);
	return authStorage;
}

type ProviderAuthSpy = Mock<(provider: string) => boolean>;

function createModelRegistry(
	models: readonly Model[],
	authStorage: AuthStorageType,
	configuredProviders: readonly string[] = [],
): { registry: ModelRegistry; hasConfiguredProviderAuth: ProviderAuthSpy } {
	const configured = new Set(configuredProviders);
	const hasConfiguredProviderAuth = vi.fn(
		(provider: string) => configured.has(provider) || authStorage.hasAuth(provider),
	);
	const registry = {
		authStorage,
		refresh: vi.fn(async () => {}),
		refreshProvider: vi.fn(async () => {}),
		getError: () => undefined,
		getAvailable: () => [...models],
		getAll: () => [...models],
		hasConfiguredProviderAuth,
		getDiscoverableProviders: () => [],
		getCanonicalModels: () => [],
		resolveCanonicalModel: () => undefined,
		getModelProfiles: () => new Map(),
		getApiKeyForProvider: async () => undefined,
		getApiKey: async () => undefined,
	} as unknown as ModelRegistry;
	return { registry, hasConfiguredProviderAuth };
}

async function createModelSelector(
	models: readonly Model[],
	authStorage: AuthStorageType,
	configuredProviders: readonly string[] = [],
): Promise<{ selector: ModelSelectorComponent; registry: ModelRegistry; hasConfiguredProviderAuth: ProviderAuthSpy }> {
	const { registry, hasConfiguredProviderAuth } = createModelRegistry(models, authStorage, configuredProviders);
	const selector = new ModelSelectorComponent(
		{ requestRender: vi.fn() } as unknown as TUI,
		undefined,
		Settings.isolated(),
		registry,
		[],
		() => {},
		() => {},
		{ temporaryOnly: true },
	);
	await Bun.sleep(10);
	return { selector, registry, hasConfiguredProviderAuth };
}

type GenerationObservation = {
	method: string;
	before: number;
	after: number;
	bumped: boolean;
};

async function observeGeneration(
	method: string,
	setup: ((authStorage: AuthStorageType) => void | Promise<void>) | undefined,
	mutation: (authStorage: AuthStorageType) => void | Promise<void>,
	options: ConstructorParameters<typeof AuthStorage>[1] = {},
): Promise<GenerationObservation> {
	const authStorage = await createAuthStorage(options);
	if (setup) await setup(authStorage);
	const before = authStorage.getGeneration();
	await mutation(authStorage);
	const after = authStorage.getGeneration();
	return { method, before, after, bumped: after > before };
}

beforeEach(async () => {
	testTheme = await getThemeByName("red-claw");
	installTestTheme();
});

afterEach(() => {
	for (const authStorage of trackedAuthStorages) {
		clearProviderAuthHealth(authStorage);
		authStorage.close();
	}
	trackedAuthStorages.clear();
});

describe("generation-scoped provider auth health", () => {
	test("uses the new generation for a newer write and replaces the old provider entry", async () => {
		const authStorage = await createAuthStorage();
		const provider = "generation-race-provider";
		const initialGeneration = authStorage.getGeneration();

		recordProviderAuthHealth(authStorage, provider, "invalid");
		expect(getProviderAuthHealth(authStorage, provider)).toBe("invalid");

		// The first validation result is now stale. A real credential mutation creates
		// the next generation before the newer validation result is recorded.
		authStorage.setRuntimeApiKey(provider, "fresh-runtime-key");
		expect(authStorage.getGeneration()).toBeGreaterThan(initialGeneration);
		recordProviderAuthHealth(authStorage, provider, "valid");

		expect(getProviderAuthHealth(authStorage, provider)).toBe("valid");
		// A subsequent generation bump must invalidate the latest entry, not reveal the
		// original invalid result that was replaced in the per-storage map.
		authStorage.removeRuntimeApiKey(provider);
		expect(getProviderAuthHealth(authStorage, provider)).toBeUndefined();
	});

	test("keeps generations strictly monotonic so an old entry cannot revive", async () => {
		const authStorage = await createAuthStorage();
		const provider = "monotonic-provider";
		recordProviderAuthHealth(authStorage, provider, "valid");

		const generations = [authStorage.getGeneration()];
		await authStorage.set("stored-provider", apiKey("stored-key"));
		generations.push(authStorage.getGeneration());
		authStorage.setRuntimeApiKey("runtime-provider", "runtime-key");
		generations.push(authStorage.getGeneration());
		authStorage.removeRuntimeApiKey("runtime-provider");
		generations.push(authStorage.getGeneration());
		authStorage.setConfigApiKey("config-provider", "config-key");
		generations.push(authStorage.getGeneration());
		authStorage.removeConfigApiKey("config-provider");
		generations.push(authStorage.getGeneration());
		await authStorage.remove("stored-provider");
		generations.push(authStorage.getGeneration());

		for (let index = 1; index < generations.length; index += 1) {
			expect(generations[index]).toBeGreaterThan(generations[index - 1]!);
		}
		expect(getProviderAuthHealth(authStorage, provider)).toBeUndefined();

		// The entry is only visible again after an explicit write at the current
		// generation; no earlier generation can become valid by arithmetic reversal.
		recordProviderAuthHealth(authStorage, provider, "invalid");
		expect(getProviderAuthHealth(authStorage, provider)).toBe("invalid");
	});

	test("invalidates only providers that were not revalidated after a bump", async () => {
		const authStorage = await createAuthStorage();
		const revalidatedProvider = "revalidated-provider";
		const staleProvider = "stale-after-bump-provider";
		recordProviderAuthHealth(authStorage, revalidatedProvider, "invalid");
		recordProviderAuthHealth(authStorage, staleProvider, "valid");

		authStorage.setRuntimeApiKey(revalidatedProvider, "revalidated-key");
		recordProviderAuthHealth(authStorage, revalidatedProvider, "valid");

		expect(getProviderAuthHealth(authStorage, revalidatedProvider)).toBe("valid");
		expect(getProviderAuthHealth(authStorage, staleProvider)).toBeUndefined();
	});

	test("scopes health by AuthStorage identity even when generations match", async () => {
		const [storageA, storageB] = await Promise.all([createAuthStorage(), createAuthStorage()]);
		expect(storageA.getGeneration()).toBe(storageB.getGeneration());

		recordProviderAuthHealth(storageA, "same-generation-provider", "valid");
		expect(getProviderAuthHealth(storageA, "same-generation-provider")).toBe("valid");
		expect(getProviderAuthHealth(storageB, "same-generation-provider")).toBeUndefined();

		recordProviderAuthHealth(storageB, "same-generation-provider", "invalid");
		clearProviderAuthHealth(storageA);
		expect(getProviderAuthHealth(storageA, "same-generation-provider")).toBeUndefined();
		expect(getProviderAuthHealth(storageB, "same-generation-provider")).toBe("invalid");

		clearProviderAuthHealth(storageB);
		expect(getProviderAuthHealth(storageB, "same-generation-provider")).toBeUndefined();
	});

	test("returns undefined for a storage with no recorded entries", async () => {
		const authStorage = await createAuthStorage();
		expect(getProviderAuthHealth(authStorage, "never-recorded")).toBeUndefined();
	});
});

describe("AuthStorage generation mutation inventory", () => {
	test("empirically confirms the login/logout and credential mutation generation contract", async () => {
		const observations = await Promise.all([
			observeGeneration("setRuntimeApiKey", undefined, authStorage => {
				authStorage.setRuntimeApiKey("runtime-provider", "runtime-key");
			}),
			observeGeneration(
				"removeRuntimeApiKey",
				authStorage => authStorage.setRuntimeApiKey("runtime-provider", "runtime-key"),
				authStorage => authStorage.removeRuntimeApiKey("runtime-provider"),
			),
			observeGeneration("setConfigApiKey", undefined, authStorage => {
				authStorage.setConfigApiKey("config-provider", "config-key");
			}),
			observeGeneration(
				"removeConfigApiKey",
				authStorage => authStorage.setConfigApiKey("config-provider", "config-key"),
				authStorage => authStorage.removeConfigApiKey("config-provider"),
			),
			observeGeneration(
				"clearConfigApiKeys",
				authStorage => authStorage.setConfigApiKey("config-provider", "config-key"),
				authStorage => authStorage.clearConfigApiKeys(),
			),
			observeGeneration("set", undefined, authStorage => authStorage.set("set-provider", apiKey("set-key"))),
			observeGeneration("login", undefined, authStorage =>
				authStorage.login("opencode-go", {
					onAuth: () => {},
					onPrompt: async () => "login-key",
				}),
			),
			observeGeneration("importCredentialIfAbsent", undefined, async authStorage => {
				await authStorage.importCredentialIfAbsent("import-provider", apiKey("import-key"));
			}),
			observeGeneration(
				"remove",
				authStorage => authStorage.set("remove-provider", apiKey("remove-key")),
				authStorage => authStorage.remove("remove-provider"),
			),
			observeGeneration(
				"logout",
				authStorage => authStorage.set("logout-provider", apiKey("logout-key")),
				authStorage => authStorage.logout("logout-provider"),
			),
			observeGeneration("upsertCredential", undefined, authStorage => {
				authStorage.upsertCredential("upsert-provider", apiKey("upsert-key"));
			}),
			observeGeneration(
				"disableCredentialById",
				async authStorage => {
					await authStorage.set("disable-provider", apiKey("disable-key"));
				},
				authStorage => {
					const entry = authStorage
						.exportSnapshot()
						.credentials.find(item => item.provider === "disable-provider");
					if (!entry) throw new Error("Expected credential to disable");
					expect(authStorage.disableCredentialById(entry.id, "red-team disable")).toBe(true);
				},
			),
			observeGeneration(
				"refreshCredentialById",
				async authStorage => {
					await authStorage.set("refresh-provider", oauthCredential("refresh"));
				},
				async authStorage => {
					const entry = authStorage
						.exportSnapshot()
						.credentials.find(item => item.provider === "refresh-provider");
					if (!entry) throw new Error("Expected OAuth credential to refresh");
					await authStorage.refreshCredentialById(entry.id);
				},
				{
					refreshOAuthCredential: async (_provider, _id, credential) => ({
						access: `${credential.access}-refreshed`,
						refresh: `${credential.refresh}-refreshed`,
						expires: Date.now() + 3_600_000,
					}),
				},
			),
			observeGeneration(
				"forceRefreshCredentialById",
				async authStorage => {
					await authStorage.set("force-refresh-provider", oauthCredential("force-refresh"));
				},
				async authStorage => {
					const entry = authStorage
						.exportSnapshot()
						.credentials.find(item => item.provider === "force-refresh-provider");
					if (!entry) throw new Error("Expected OAuth credential to force-refresh");
					await authStorage.forceRefreshCredentialById(entry.id);
				},
				{
					refreshOAuthCredential: async (_provider, _id, credential) => ({
						access: `${credential.access}-forced`,
						refresh: `${credential.refresh}-forced`,
						expires: Date.now() + 3_600_000,
					}),
				},
			),
			observeGeneration(
				"forceRefreshOAuthCredential",
				async authStorage => {
					await authStorage.set("force-refresh-oauth-provider", oauthCredential("force-refresh-oauth"));
				},
				async authStorage => {
					const credential = authStorage.getOAuthCredential("force-refresh-oauth-provider");
					if (!credential) throw new Error("Expected OAuth credential to force-refresh by provider");
					await authStorage.forceRefreshOAuthCredential("force-refresh-oauth-provider", credential);
				},
				{
					refreshOAuthCredential: async (_provider, _id, credential) => ({
						access: `${credential.access}-forced-by-provider`,
						refresh: `${credential.refresh}-forced-by-provider`,
						expires: Date.now() + 3_600_000,
					}),
				},
			),
		]);

		const bumpingMethods = observations
			.filter(observation => observation.bumped)
			.map(observation => observation.method);
		expect(bumpingMethods).toEqual([
			"setRuntimeApiKey",
			"removeRuntimeApiKey",
			"setConfigApiKey",
			"removeConfigApiKey",
			"clearConfigApiKeys",
			"set",
			"login",
			"importCredentialIfAbsent",
			"remove",
			"logout",
			"upsertCredential",
			"disableCredentialById",
			"refreshCredentialById",
			"forceRefreshCredentialById",
			"forceRefreshOAuthCredential",
		]);

		// These are deliberately no-op/non-persistent paths, not credential deletion
		// paths: a local SQLite invalidation only marks a request as blocked and reloads
		// the unchanged row; reload alone also has no new credential snapshot.
		const noBump = await observeGeneration(
			"invalidateCredentialMatching (local active row)",
			authStorage => authStorage.set("invalidate-provider", apiKey("invalidate-key")),
			async authStorage => {
				await authStorage.invalidateCredentialMatching("invalidate-provider", "invalidate-key");
			},
		);
		expect(noBump.bumped).toBe(false);

		const reload = await observeGeneration("reload (unchanged store)", undefined, authStorage =>
			authStorage.reload(),
		);
		expect(reload.bumped).toBe(false);

		const missingRemove = await observeGeneration("remove (missing provider)", undefined, authStorage =>
			authStorage.remove("missing-remove-provider"),
		);
		expect(missingRemove.bumped).toBe(false);
	});

	test("does not bump for duplicate writes, but does bump for the first real mutation", async () => {
		const authStorage = await createAuthStorage();
		await authStorage.set("duplicate-provider", apiKey("same-key"));
		const afterFirstSet = authStorage.getGeneration();
		await authStorage.set("duplicate-provider", apiKey("same-key"));
		expect(authStorage.getGeneration()).toBe(afterFirstSet);

		const firstImport = await authStorage.importCredentialIfAbsent("import-duplicate-provider", apiKey("import-key"));
		expect(firstImport.inserted).toBe(true);
		const afterFirstImport = authStorage.getGeneration();
		const secondImport = await authStorage.importCredentialIfAbsent(
			"import-duplicate-provider",
			apiKey("import-key-2"),
		);
		expect(secondImport.inserted).toBe(false);
		expect(authStorage.getGeneration()).toBe(afterFirstImport);

		const afterFirstUpsert = authStorage.getGeneration();
		authStorage.upsertCredential("duplicate-provider", apiKey("same-key"));
		expect(authStorage.getGeneration()).toBe(afterFirstUpsert);
	});
});

describe("generation invalidation in visible model ranking", () => {
	test("moves an invalid provider out of tier one after a real generation bump", async () => {
		const authStorage = await createAuthStorage();
		const invalidProvider = "generation-visible-invalid-provider";
		const invalidModel = model(invalidProvider, "invalid-model");
		const famousModel = model("anthropic", "famous-model");

		recordProviderAuthHealth(authStorage, invalidProvider, "invalid");
		const before = await createModelSelector([famousModel, invalidModel], authStorage);
		try {
			expect(modelRows(before.selector, [invalidModel, famousModel])).toEqual([
				`${invalidProvider}/invalid-model`,
				"anthropic/famous-model",
			]);
		} finally {
			before.selector.dispose();
		}

		const generationBeforeMutation = authStorage.getGeneration();
		authStorage.setRuntimeApiKey(invalidProvider, "temporary-key");
		authStorage.removeRuntimeApiKey(invalidProvider);
		expect(authStorage.getGeneration()).toBeGreaterThan(generationBeforeMutation);
		expect(getProviderAuthHealth(authStorage, invalidProvider)).toBeUndefined();

		const after = await createModelSelector([famousModel, invalidModel], authStorage);
		try {
			// The health hint is gone, so the provider falls back to `none` and the
			// famous provider wins tier 2 ordering over this tier 3 provider.
			expect(modelRows(after.selector, [invalidModel, famousModel])).toEqual([
				"anthropic/famous-model",
				`${invalidProvider}/invalid-model`,
			]);
			expect(after.hasConfiguredProviderAuth).toHaveBeenCalledWith(invalidProvider);
		} finally {
			after.selector.dispose();
		}
	});
});
