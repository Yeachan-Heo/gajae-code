import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type AssistantMessageEventStream, clearCustomApis, getCustomApi } from "@gajae-code/ai";
import { ModelRegistry, type ProviderConfigInput } from "@gajae-code/coding-agent/config/model-registry";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { hookFetch, Snowflake } from "@gajae-code/utils";

describe("ModelRegistry runtime source cleanup", () => {
	let tempDir: string;
	let modelsJsonPath: string;
	let authStorage: AuthStorage;

	const sourceId = "ext://runtime-cleanup";
	const baseModel: NonNullable<ProviderConfigInput["models"]>[number] = {
		id: "runtime-model",
		name: "Runtime Model",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 8192,
	};

	const streamSimple: NonNullable<ProviderConfigInput["streamSimple"]> = () =>
		({}) as unknown as AssistantMessageEventStream;

	beforeEach(async () => {
		tempDir = path.join(os.tmpdir(), `pi-test-model-registry-runtime-cleanup-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		modelsJsonPath = path.join(tempDir, "models.json");
		authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"));
	});

	afterEach(() => {
		clearCustomApis();
		authStorage.close();
		if (tempDir && fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	test("clearSourceRegistrations removes runtime overlays and fallback auth for that source", () => {
		const registry = new ModelRegistry(authStorage, modelsJsonPath);
		const config: ProviderConfigInput = {
			baseUrl: "https://runtime.example.com/v1",
			apiKey: "RUNTIME_KEY",
			api: "custom-runtime-cleanup-api",
			streamSimple,
			models: [baseModel],
		};

		registry.registerProvider("runtime-provider", config, sourceId);

		expect(registry.find("runtime-provider", "runtime-model")).toBeDefined();
		expect(registry.authStorage.hasAuth("runtime-provider")).toBe(true);
		expect(getCustomApi("custom-runtime-cleanup-api")).toBeDefined();

		registry.clearSourceRegistrations(sourceId);

		expect(registry.find("runtime-provider", "runtime-model")).toBeUndefined();
		expect(registry.authStorage.hasAuth("runtime-provider")).toBe(false);
		expect(getCustomApi("custom-runtime-cleanup-api")).toBeUndefined();
	});

	test("shared AuthStorage keeps registry config and fallback ownership isolated", async () => {
		const secondModelsJsonPath = path.join(tempDir, "models-second.json");
		await Bun.write(
			modelsJsonPath,
			JSON.stringify({
				providers: {
					"first-provider": {
						baseUrl: "https://first.example.com/v1",
						api: "openai-responses",
						apiKey: "first-key",
						models: [{ id: "first-model" }],
					},
				},
			}),
		);
		await Bun.write(
			secondModelsJsonPath,
			JSON.stringify({
				providers: {
					"second-provider": {
						baseUrl: "https://second.example.com/v1",
						api: "openai-responses",
						apiKey: "second-key",
						models: [{ id: "second-model" }],
					},
				},
			}),
		);

		const firstRegistry = new ModelRegistry(authStorage, modelsJsonPath, undefined, { automaticRefresh: false });
		const secondRegistry = new ModelRegistry(authStorage, secondModelsJsonPath, undefined, {
			automaticRefresh: false,
		});
		try {
			expect(await firstRegistry.getApiKeyForProvider("first-provider")).toBe("first-key");
			expect(await secondRegistry.getApiKeyForProvider("second-provider")).toBe("second-key");

			// A static reload removes only the reloading registry's owned config key.
			await Bun.write(modelsJsonPath, JSON.stringify({ providers: {} }));
			const updatedAt = new Date(Date.now() + 1000);
			fs.utimesSync(modelsJsonPath, updatedAt, updatedAt);
			await firstRegistry.refresh("offline");
			expect(await secondRegistry.getApiKeyForProvider("second-provider")).toBe("second-key");

			// Clearing the shared active config surface must leave each registry's
			// fallback resolver available until that registry is disposed.
			authStorage.clearConfigApiKeys();
			expect(await secondRegistry.getApiKeyForProvider("second-provider")).toBe("second-key");
			firstRegistry.dispose();
			expect(await secondRegistry.getApiKeyForProvider("second-provider")).toBe("second-key");
		} finally {
			firstRegistry.dispose();
			secondRegistry.dispose();
		}
	});

	test("extension cleanup and replacement preserve unrelated Antigravity discovery", async () => {
		await authStorage.set("google-antigravity", {
			type: "oauth",
			access: "antigravity-access",
			refresh: "antigravity-refresh",
			expires: Date.now() + 60 * 60 * 1000,
			email: "catalog@example.com",
			projectId: "catalog-project",
		});
		let discoveryFetches = 0;
		using _hook = hookFetch(input => {
			if (!String(input).endsWith("/v1internal:fetchAvailableModels")) {
				throw new Error(`Unexpected URL: ${String(input)}`);
			}
			discoveryFetches++;
			return new Response(
				JSON.stringify({ models: { "gemini-cleanup-dynamic": { displayName: "Cleanup regression" } } }),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		});
		const registry = new ModelRegistry(authStorage, modelsJsonPath, undefined, {
			automaticRefresh: false,
		});
		try {
			registry.registerProvider(
				"runtime-provider",
				{
					baseUrl: "https://runtime.example.com/v1",
					apiKey: "runtime-key",
					api: "openai-responses",
					models: [baseModel],
				},
				sourceId,
			);
			await registry.refreshProvider("google-antigravity", "online");
			const discovered = registry.find("google-antigravity", "gemini-cleanup-dynamic");
			expect(discovered).toBeDefined();
			if (!discovered) throw new Error("Antigravity discovery did not publish its model");
			const fetchesAfterDiscovery = discoveryFetches;
			const assertDiscoveryPreserved = () => {
				expect(registry.find("google-antigravity", "gemini-cleanup-dynamic")).toEqual(discovered);
				expect(registry.getAvailable()).toContainEqual(discovered);
				expect(registry.getActiveProviders()).toContainEqual({
					provider: "google-antigravity",
					connectionKind: "credential",
				});
				expect(discoveryFetches).toBe(fetchesAfterDiscovery);
			};

			registry.clearSourceRegistrations(sourceId);
			assertDiscoveryPreserved();
			expect(registry.find("runtime-provider", "runtime-model")).toBeUndefined();
			expect(await registry.getApiKeyForProvider("runtime-provider")).toBeUndefined();

			registry.registerProvider(
				"runtime-provider",
				{
					baseUrl: "https://runtime.example.com/v1",
					apiKey: "runtime-key",
					api: "openai-responses",
					models: [baseModel],
				},
				sourceId,
			);
			assertDiscoveryPreserved();
			registry.registerProvider(
				"runtime-provider",
				{
					baseUrl: "https://replacement.example.com/v1",
					apiKey: "replacement-key",
					api: "openai-responses",
					models: [{ ...baseModel, id: "replacement-model" }],
				},
				"ext://replacement",
			);
			assertDiscoveryPreserved();
			expect(registry.find("runtime-provider", "runtime-model")).toBeUndefined();
			expect(registry.find("runtime-provider", "replacement-model")?.baseUrl).toBe(
				"https://replacement.example.com/v1",
			);
			expect(await registry.getApiKeyForProvider("runtime-provider")).toBe("replacement-key");
			registry.syncExtensionSources([]);
			assertDiscoveryPreserved();
			expect(registry.find("runtime-provider", "replacement-model")).toBeUndefined();
			await registry.refreshProvider("google-antigravity", "offline");
			assertDiscoveryPreserved();

			// A signed-preset update must not publish an intermediate catalog that
			// loses live discovery while rebuilding unrelated model metadata.
			const publishedAvailability: boolean[] = [];
			const unsubscribe = registry.onCatalogChanged(() => {
				publishedAvailability.push(registry.find("google-antigravity", "gemini-cleanup-dynamic") !== undefined);
			});
			await Bun.write(
				path.join(tempDir, "model-presets", "control.json"),
				JSON.stringify({ version: 1, disabled: true }),
			);
			await registry.refreshStatic();
			assertDiscoveryPreserved();
			expect(publishedAvailability.length).toBeGreaterThan(0);
			expect(publishedAvailability.every(Boolean)).toBe(true);
			unsubscribe();

			// Preserving the catalog must still reject discovery from an account
			// whose credentials were removed before the next preset publication.
			await authStorage.remove("google-antigravity");
			await Bun.write(
				path.join(tempDir, "model-presets", "control.json"),
				JSON.stringify({ version: 1, disabled: false }),
			);
			await registry.refreshStatic();
			expect(registry.find("google-antigravity", "gemini-cleanup-dynamic")).toBeUndefined();
		} finally {
			await registry.dispose();
		}
	});

	test("shared AuthStorage keeps same-provider credentials owner-bound", async () => {
		const secondModelsJsonPath = path.join(tempDir, "models-second.json");
		const provider = "shared-provider";
		const modelId = "shared-model";
		await Bun.write(
			modelsJsonPath,
			JSON.stringify({
				providers: {
					[provider]: {
						baseUrl: "https://first.example.com/v1",
						api: "openai-responses",
						apiKey: "first-key",
						models: [{ id: modelId }],
					},
				},
			}),
		);
		await Bun.write(
			secondModelsJsonPath,
			JSON.stringify({
				providers: {
					[provider]: {
						baseUrl: "https://second.example.com/v1",
						api: "openai-responses",
						apiKey: "second-key",
						models: [{ id: modelId }],
					},
				},
			}),
		);

		const firstRegistry = new ModelRegistry(authStorage, modelsJsonPath, undefined, { automaticRefresh: false });
		const secondRegistry = new ModelRegistry(authStorage, secondModelsJsonPath, undefined, {
			automaticRefresh: false,
		});
		try {
			const firstModel = firstRegistry.find(provider, modelId);
			const secondModel = secondRegistry.find(provider, modelId);
			expect(firstModel?.baseUrl).toBe("https://first.example.com/v1");
			expect(secondModel?.baseUrl).toBe("https://second.example.com/v1");
			expect(await firstRegistry.getApiKeyForProvider(provider)).toBe("first-key");
			expect(await secondRegistry.getApiKeyForProvider(provider)).toBe("second-key");

			const firstSearch = firstRegistry.getActiveSearchModelContext(firstModel!);
			const secondSearch = secondRegistry.getActiveSearchModelContext(secondModel!);
			expect((await firstSearch.resolveCredentials!({})).apiKey).toBe("first-key");
			expect((await secondSearch.resolveCredentials!({})).apiKey).toBe("second-key");

			await firstRegistry.refresh("offline");
			expect(await firstRegistry.getApiKeyForProvider(provider)).toBe("first-key");
			expect(await secondRegistry.getApiKeyForProvider(provider)).toBe("second-key");
			await secondRegistry.refresh("offline");
			expect(await firstRegistry.getApiKeyForProvider(provider)).toBe("first-key");
			expect(await secondRegistry.getApiKeyForProvider(provider)).toBe("second-key");
			authStorage.clearConfigApiKeys();
			expect(await firstRegistry.getApiKeyForProvider(provider)).toBe("first-key");
			expect(await secondRegistry.getApiKeyForProvider(provider)).toBe("second-key");

			firstRegistry.dispose();
			expect(await secondRegistry.getApiKeyForProvider(provider)).toBe("second-key");
			expect((await secondSearch.resolveCredentials!({})).apiKey).toBe("second-key");
		} finally {
			firstRegistry.dispose();
			secondRegistry.dispose();
		}
	});

	test("cleanup restores configured credentials and transport instead of removed runtime state", async () => {
		await Bun.write(
			modelsJsonPath,
			JSON.stringify({
				providers: {
					"runtime-provider": {
						baseUrl: "https://configured.example.com/v1",
						apiKey: "configured-key",
						api: "openai-responses",
						models: [{ id: "configured-model" }],
					},
				},
			}),
		);
		const registry = new ModelRegistry(authStorage, modelsJsonPath, undefined, { automaticRefresh: false });
		try {
			registry.registerProvider(
				"runtime-provider",
				{
					baseUrl: "https://runtime.example.com/v1",
					apiKey: "runtime-key",
					api: "openai-responses",
					models: [baseModel],
				},
				sourceId,
			);
			expect(await registry.getApiKeyForProvider("runtime-provider")).toBe("runtime-key");
			registry.clearSourceRegistrations(sourceId);
			expect(await registry.getApiKeyForProvider("runtime-provider")).toBe("configured-key");
			expect(registry.find("runtime-provider", "runtime-model")).toBeUndefined();
			expect(registry.find("runtime-provider", "configured-model")?.baseUrl).toBe(
				"https://configured.example.com/v1",
			);
		} finally {
			await registry.dispose();
		}
	});

	test("cleanup does not retain discovery from the removed provider endpoint", async () => {
		await Bun.write(
			modelsJsonPath,
			JSON.stringify({
				providers: {
					"runtime-provider": {
						baseUrl: "https://configured.example.com/v1",
						apiKey: "configured-key",
						api: "openai-responses",
						models: [{ id: "configured-model" }],
					},
				},
			}),
		);
		using _hook = hookFetch(input => {
			expect(String(input)).toBe("https://runtime.example.com/v1/models");
			return new Response(JSON.stringify({ data: [{ id: "runtime-discovered" }] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		});
		const registry = new ModelRegistry(authStorage, modelsJsonPath, undefined, { automaticRefresh: false });
		try {
			registry.registerProvider(
				"runtime-provider",
				{
					baseUrl: "https://runtime.example.com/v1",
					apiKey: "runtime-key",
					api: "openai-responses",
					models: [baseModel],
				},
				sourceId,
			);
			await registry.refreshProvider("runtime-provider", "online");
			expect(registry.find("runtime-provider", "runtime-discovered")?.baseUrl).toBe(
				"https://runtime.example.com/v1",
			);
			registry.clearSourceRegistrations(sourceId);
			expect(registry.find("runtime-provider", "runtime-discovered")).toBeUndefined();
			expect(registry.getProviderDiscoveryState("runtime-provider")?.status).toBe("idle");
			expect(await registry.getApiKeyForProvider("runtime-provider")).toBe("configured-key");
		} finally {
			await registry.dispose();
		}
	});
});
