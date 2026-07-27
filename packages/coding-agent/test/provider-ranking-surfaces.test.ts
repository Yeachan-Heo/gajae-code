import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import type { Model } from "@gajae-code/ai";
import { getOAuthProviders } from "@gajae-code/ai/utils/oauth";
import type { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import {
	clearProviderAuthHealth,
	getProviderAuthHealth,
	recordProviderAuthHealth,
} from "@gajae-code/coding-agent/config/provider-auth-health";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { ModelSelectorComponent } from "@gajae-code/coding-agent/modes/components/model-selector";
import { OAuthSelectorComponent } from "@gajae-code/coding-agent/modes/components/oauth-selector";
import { getThemeByName, setThemeInstance } from "@gajae-code/coding-agent/modes/theme/theme";
import { AuthStorage, type AuthStorage as AuthStorageType } from "@gajae-code/coding-agent/session/auth-storage";
import type { TUI } from "@gajae-code/tui";

const model = (provider: string, id: string): Model =>
	({ provider, id, name: id, api: "openai-responses", contextWindow: 1000, maxTokens: 1000 }) as Model;

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

function oauthRows(selector: OAuthSelectorComponent): string[] {
	const providers = getOAuthProviders().sort((left, right) => right.name.length - left.name.length);
	return renderedLines(selector).flatMap(line => {
		const normalized = line.trimStart().replace(/^❯\s+/, "");
		const provider = providers.find(candidate => normalized.startsWith(candidate.name));
		return provider ? [provider.id] : [];
	});
}

type AuthStorageDouble = Pick<AuthStorageType, "hasAuth" | "getGeneration">;

const trackedAuthStorages = new Set<AuthStorageType>();

function trackAuthStorage<T extends AuthStorageType>(authStorage: T): T {
	trackedAuthStorages.add(authStorage);
	return authStorage;
}

function clearTrackedProviderAuthHealth(): void {
	for (const authStorage of trackedAuthStorages) clearProviderAuthHealth(authStorage);
	trackedAuthStorages.clear();
}

function createAuthStorage(authenticatedProviders: string | readonly string[] = []): AuthStorageType {
	let generation = 1;
	const providers = new Set(
		typeof authenticatedProviders === "string" ? [authenticatedProviders] : authenticatedProviders,
	);
	const authStorage = {
		hasAuth: (provider: string) => providers.has(provider),
		getGeneration: () => generation,
		bumpGeneration: () => {
			generation += 1;
		},
	};
	return trackAuthStorage(authStorage as unknown as AuthStorageType);
}

function createModelRegistry(options: {
	models: readonly Model[];
	discoverableProviders?: readonly string[];
	configuredProviders?: readonly string[];
	authStorage?: AuthStorageDouble;
}): ModelRegistry {
	const configuredProviders = new Set(options.configuredProviders ?? []);
	const authStorage = options.authStorage ?? createAuthStorage([...configuredProviders]);
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
		getDiscoverableProviders: () => [...(options.discoverableProviders ?? [])],
		getCanonicalModels: () => [],
		resolveCanonicalModel: () => undefined,
		getModelProfiles: () => new Map(),
		getApiKeyForProvider: async () => undefined,
		getApiKey: async () => undefined,
	} as unknown as ModelRegistry;
}

async function createModelSelector(
	models: readonly Model[],
	options: {
		configuredProviders?: readonly string[];
		discoverableProviders?: readonly string[];
		settings?: Settings;
		authStorage?: AuthStorageDouble;
		registry?: ModelRegistry;
	} = {},
): Promise<ModelSelectorComponent> {
	const selector = new ModelSelectorComponent(
		{ requestRender: vi.fn() } as unknown as TUI,
		undefined,
		options.settings ?? Settings.isolated(),
		options.registry ??
			createModelRegistry({
				models,
				configuredProviders: options.configuredProviders,
				discoverableProviders: options.discoverableProviders,
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

beforeEach(async () => {
	clearTrackedProviderAuthHealth();
	testTheme = await getThemeByName("red-claw");
	installTestTheme();
});

afterEach(() => {
	clearTrackedProviderAuthHealth();
});

describe("/login provider ranking surface", () => {
	test("preserves the selected provider id when validation re-sorts rows", async () => {
		const target = getOAuthProviders().find(provider => provider.id === "anthropic");
		if (!target) throw new Error("Expected anthropic OAuth provider");
		const validation = Promise.withResolvers<boolean>();
		const selected: string[] = [];
		const selector = new OAuthSelectorComponent(
			"login",
			createAuthStorage(target.id),
			providerId => selected.push(providerId),
			() => {},
			{ validateAuth: async () => validation.promise, requestRender: vi.fn() },
		);

		await Bun.sleep(0);
		selector.handleInput("\x1b[A");
		validation.resolve(false);
		await Bun.sleep(0);
		selector.handleInput("\n");

		expect(selected).toEqual([target.id]);
		selector.dispose();
	});

	test("keeps row order stable when checking credentials become valid", async () => {
		const target = getOAuthProviders().find(provider => provider.id === "anthropic");
		if (!target) throw new Error("Expected anthropic OAuth provider");
		const validation = Promise.withResolvers<boolean>();
		const selector = new OAuthSelectorComponent(
			"login",
			createAuthStorage(target.id),
			() => {},
			() => {},
			{ validateAuth: async () => validation.promise, requestRender: vi.fn() },
		);

		await Bun.sleep(0);
		const before = oauthRows(selector);
		validation.resolve(true);
		await Bun.sleep(0);
		const after = oauthRows(selector);

		expect(after).toEqual(before);
		selector.dispose();
	});
});

describe("/model provider ranking surface", () => {
	test("keeps static tabs first and preserves role and MRU precedence over provider tier", async () => {
		const defaultModel = model("anthropic", "default");
		const mruModel = model("cursor", "mru");
		const configuredModel = model("configured-provider", "configured");
		const settings = Settings.isolated({ modelRoles: { default: "anthropic/default" } });
		vi.spyOn(settings, "getStorage").mockReturnValue({
			getModelUsageOrder: () => [`${mruModel.provider}/${mruModel.id}`],
		} as never);
		const selector = await createModelSelector([configuredModel, mruModel, defaultModel], {
			configuredProviders: [configuredModel.provider],
			settings,
		});

		const rows = modelRows(selector, [defaultModel, mruModel, configuredModel]);
		const rendered = renderedLines(selector).join("\n");
		expect(rows).toEqual([
			`${defaultModel.provider}/${defaultModel.id}`,
			`${mruModel.provider}/${mruModel.id}`,
			`${configuredModel.provider}/${configuredModel.id}`,
		]);
		expect(rendered.indexOf("ALL")).toBeLessThan(rendered.indexOf("CANONICAL"));
		selector.dispose();
	});

	test("ranks invalid health below tier zero and above famous providers, including zero-model discovery auth", async () => {
		const configuredModel = model("configured-provider", "configured");
		const invalidModel = model("invalid-provider", "invalid");
		const famousModel = model("anthropic", "famous");
		const registry = createModelRegistry({
			models: [famousModel, invalidModel, configuredModel],
			configuredProviders: [configuredModel.provider, "configured-discovery"],
			discoverableProviders: ["configured-discovery"],
		});
		recordProviderAuthHealth(registry.authStorage, invalidModel.provider, "invalid");
		const selector = await createModelSelector([famousModel, invalidModel, configuredModel], { registry });

		const rows = modelRows(selector, [configuredModel, invalidModel, famousModel]);
		const rendered = renderedLines(selector).join("\n");
		expect(rows).toEqual([
			`${configuredModel.provider}/${configuredModel.id}`,
			`${invalidModel.provider}/${invalidModel.id}`,
			`${famousModel.provider}/${famousModel.id}`,
		]);
		expect(rendered.indexOf("CONFIGURED-DISCOVERY")).toBeLessThan(rendered.indexOf("ANTHROPIC"));
		selector.dispose();
	});

	test("drops an invalid provider out of tier one after an AuthStorage generation bump", async () => {
		const invalidProvider = "generation-invalid-provider";
		const invalidModel = model(invalidProvider, "invalid");
		const famousModel = model("anthropic", "famous");
		const authStorage = trackAuthStorage(await AuthStorage.create(":memory:"));
		try {
			const registry = createModelRegistry({ models: [famousModel, invalidModel], authStorage });
			recordProviderAuthHealth(registry.authStorage, invalidProvider, "invalid");

			const beforeSelector = await createModelSelector([famousModel, invalidModel], { registry });
			try {
				expect(modelRows(beforeSelector, [invalidModel, famousModel])).toEqual([
					"generation-invalid-provider/invalid",
					"anthropic/famous",
				]);
			} finally {
				beforeSelector.dispose();
			}

			const initialGeneration = authStorage.getGeneration();
			authStorage.setRuntimeApiKey(invalidProvider, "fresh-key");
			authStorage.removeRuntimeApiKey(invalidProvider);
			expect(authStorage.getGeneration()).toBeGreaterThan(initialGeneration);
			expect(getProviderAuthHealth(authStorage, invalidProvider)).toBeUndefined();

			const afterSelector = await createModelSelector([famousModel, invalidModel], { registry });
			try {
				expect(modelRows(afterSelector, [invalidModel, famousModel])).toEqual([
					"anthropic/famous",
					"generation-invalid-provider/invalid",
				]);
			} finally {
				afterSelector.dispose();
			}
		} finally {
			clearProviderAuthHealth(authStorage);
			authStorage.close();
		}
	});
});
