import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	type Api,
	type Context,
	Effort,
	getSupportedEfforts,
	type Model,
	type OpenAICompat,
	readModelCache,
	type ThinkingConfig,
	writeModelCache,
} from "@gajae-code/ai";
import { streamOpenAICompletions } from "@gajae-code/ai/providers/openai-completions";
import {
	isQuietLocalDiscoveryFailure,
	kNoAuth,
	MODEL_ROLE_IDS,
	ModelRegistry,
} from "@gajae-code/coding-agent/config/model-registry";
import {
	type ModelLookupRegistry,
	resolveModelFromString,
	resolveModelOverride,
	resolveModelOverrideWithAuthFallback,
} from "@gajae-code/coding-agent/config/model-resolver";
import {
	buildProviderSelectionCatalog,
	createProviderSelectionPolicy,
} from "@gajae-code/coding-agent/config/provider-selection-policy";
import { resetSettingsForTest, Settings, settings } from "@gajae-code/coding-agent/config/settings";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { addApiCompatibleProvider } from "@gajae-code/coding-agent/setup/provider-onboarding";
import { $credentialEnv, hookFetch, Snowflake } from "@gajae-code/utils";

describe("model roles", () => {
	test("default is the only built-in model role", () => {
		expect(MODEL_ROLE_IDS).toEqual(["default"]);
	});
});

test("package exports keep extracted model helpers internal", () => {
	const packageJson = JSON.parse(fs.readFileSync(path.resolve(import.meta.dir, "../package.json"), "utf8")) as {
		exports: Record<string, unknown>;
	};

	expect(packageJson.exports["./config/model-auth"]).toBeNull();
	expect(packageJson.exports["./config/model-bindings-applier"]).toBeNull();
	expect(packageJson.exports["./config/model-discovery-manager"]).toBeNull();
	expect(packageJson.exports["./config/model-equivalence"]).toBeUndefined();
	expect(packageJson.exports["./config/*"]).toBeDefined();
	expect(packageJson.exports["./*"]).toBeDefined();
});

test("Command Code fresh descriptor routes Claude through Anthropic and others through OpenAI", async () => {
	resetSettingsForTest();
	const tempDir = path.join(os.tmpdir(), `pi-test-commandcode-fresh-${Snowflake.next()}`);
	fs.mkdirSync(tempDir, { recursive: true });
	const modelsPath = path.join(tempDir, "models.json");
	const auth = await AuthStorage.create(path.join(tempDir, "auth.db"));
	const previousFetch = globalThis.fetch;
	globalThis.fetch = (async () =>
		new Response(JSON.stringify({ data: [{ id: "claude-opus-5.5" }, { id: "zai-org/GLM-5.3" }] }), {
			status: 200,
		})) as unknown as typeof fetch;
	try {
		await auth.set("commandcode-goat", { type: "api_key", key: "cmd-test-key" });
		const registry = new ModelRegistry(auth, modelsPath);
		await registry.refreshProvider("commandcode-goat", "online");
		const models = registry.getAll().filter(model => model.provider === "commandcode-goat");
		expect(models.find(model => model.id === "claude-opus-5.5")).toMatchObject({
			api: "anthropic-messages",
			baseUrl: "https://api.commandcode.ai/provider",
		});
	} finally {
		globalThis.fetch = previousFetch;
		auth.close();
		fs.rmSync(tempDir, { recursive: true, force: true });
		resetSettingsForTest();
	}
});

describe("ModelRegistry", () => {
	let tempDir: string;
	let modelsJsonPath: string;
	let cacheDbPath: string;
	let authStorage: AuthStorage;
	let previousPresetRegistryDisabled: string | undefined;

	beforeEach(async () => {
		resetSettingsForTest();
		previousPresetRegistryDisabled = Bun.env.GJC_MODEL_PRESET_REGISTRY_DISABLED;
		Bun.env.GJC_MODEL_PRESET_REGISTRY_DISABLED = "true";
		tempDir = path.join(os.tmpdir(), `pi-test-model-registry-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		modelsJsonPath = path.join(tempDir, "models.json");
		cacheDbPath = path.join(tempDir, "models.db");
		authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"));
	});

	afterEach(() => {
		resetSettingsForTest();
		authStorage.close();
		if (previousPresetRegistryDisabled === undefined) delete Bun.env.GJC_MODEL_PRESET_REGISTRY_DISABLED;
		else Bun.env.GJC_MODEL_PRESET_REGISTRY_DISABLED = previousPresetRegistryDisabled;
		if (tempDir && fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true });
		}
	});

	type ProviderConfig = {
		baseUrl: string;
		apiKey: string;
		api: string;
		models: Array<{
			id: string;
			name: string;
			reasoning: boolean;
			thinking?: ThinkingConfig;
			input: string[];
			cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
			contextWindow: number;
			maxTokens: number;
		}>;
	};

	/** Create minimal provider config  */
	function providerConfig(
		baseUrl: string,
		models: Array<{
			id: string;
			name?: string;
			reasoning?: boolean;
			thinking?: ThinkingConfig;
			contextWindow?: number;
		}>,
		api: string = "anthropic-messages",
	) {
		return {
			baseUrl,
			apiKey: "TEST_KEY",
			api,
			models: models.map(m => ({
				id: m.id,
				name: m.name ?? m.id,
				reasoning: m.reasoning ?? false,
				thinking: m.thinking,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: m.contextWindow ?? 100000,
				maxTokens: 8000,
			})),
		};
	}

	function writeModelsJson(providers: Record<string, ProviderConfig>) {
		fs.writeFileSync(modelsJsonPath, JSON.stringify({ providers }));
	}

	function writeCachedOllamaModels(models: Model<"openai-completions">[]) {
		writeModelCache("ollama", Date.now(), models, true, "", cacheDbPath);
	}

	function getModelsForProvider(registry: ModelRegistry, provider: string) {
		return registry.getAll().filter(m => m.provider === provider);
	}

	function getOpenAICompat(model: Model | undefined): OpenAICompat | undefined {
		// All custom-model compat overrides flow through ModelCompatSchema regardless of
		// the underlying API, so OpenAI-specific fields can be read for any model in
		// this fixture.
		return model?.compat as OpenAICompat | undefined;
	}

	/** Create a baseUrl-only override (no custom models) */
	function overrideConfig(baseUrl: string, headers?: Record<string, string>) {
		return { baseUrl, ...(headers && { headers }) };
	}

	/** Write raw providers config (for mixed override/replacement scenarios) */
	function writeRawModelsJson(providers: Record<string, unknown>) {
		fs.writeFileSync(modelsJsonPath, JSON.stringify({ providers }));
	}

	function writeRawModelsConfig(config: Record<string, unknown>) {
		fs.writeFileSync(modelsJsonPath, JSON.stringify(config));
	}

	function setEnvForTest(key: string, value: string): () => void {
		const previous = Bun.env[key];
		Bun.env[key] = value;
		return () => {
			if (previous === undefined) {
				delete Bun.env[key];
			} else {
				Bun.env[key] = previous;
			}
		};
	}

	function unsetEnvForTest(key: string): () => void {
		const previous = Bun.env[key];
		delete Bun.env[key];
		return () => {
			if (previous !== undefined) {
				Bun.env[key] = previous;
			}
		};
	}

	test("forwards caller cancellation through model and provider key lookups", async () => {
		const registry = new ModelRegistry(authStorage, modelsJsonPath);
		const model = registry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled Anthropic model");
		const controller = new AbortController();
		const credentialSelector = { kind: "email" as const, value: "worker@example.com" };
		const getApiKey = vi.spyOn(authStorage, "getApiKey").mockResolvedValue("test-key");

		try {
			await registry.getApiKey(model, "model-session", {
				credentialSelector,
				signal: controller.signal,
			});
			await registry.getApiKeyForProvider("anthropic", "provider-session", "https://proxy.example.com", {
				credentialSelector,
				signal: controller.signal,
			});

			expect(getApiKey).toHaveBeenNthCalledWith(
				1,
				"anthropic",
				"model-session",
				expect.objectContaining({
					baseUrl: model.baseUrl,
					modelId: model.id,
					credentialSelector,
					signal: controller.signal,
				}),
			);
			expect(getApiKey).toHaveBeenNthCalledWith(
				2,
				"anthropic",
				"provider-session",
				expect.objectContaining({
					baseUrl: "https://proxy.example.com",
					credentialSelector,
					signal: controller.signal,
				}),
			);
		} finally {
			getApiKey.mockRestore();
		}
	});

	function mockOpenAiCompatibleModels(url: string, modelIds: string[]) {
		return hookFetch(input => {
			const requestUrl = String(input);
			if (requestUrl === url) {
				return new Response(JSON.stringify({ data: modelIds.map(id => ({ id })) }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			throw new Error(`Unexpected URL: ${requestUrl}`);
		});
	}

	function mockOllamaDiscovery(modelNames: string[]) {
		return hookFetch(input => {
			const url = String(input);
			if (url === "http://127.0.0.1:11434/api/tags") {
				return new Response(JSON.stringify({ models: modelNames.map(name => ({ name })) }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			if (url === "http://127.0.0.1:11434/api/show") {
				return new Response(JSON.stringify({ capabilities: ["completion"] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			throw new Error(`Unexpected URL: ${url}`);
		});
	}

	test("preserves process-relative models paths independently of registry agent scope", async () => {
		const relativeDirectory = path.join(tempDir, "relative-models-dir");
		const scopedAgentDir = path.join(tempDir, "relative-agent-dir");
		fs.mkdirSync(relativeDirectory, { recursive: true });
		fs.mkdirSync(scopedAgentDir, { recursive: true });
		await Bun.write(
			path.join(relativeDirectory, "models.yml"),
			`providers:
  relative-provider:
    baseUrl: https://relative.example/v1
    api: openai-completions
    auth: none
    models:
      - id: relative-model
`,
		);
		const previousCwd = process.cwd();
		process.chdir(relativeDirectory);
		try {
			const registry = new ModelRegistry(authStorage, "models.yml", undefined, {
				agentDir: scopedAgentDir,
				automaticRefresh: false,
			});
			expect(registry.find("relative-provider", "relative-model")).toBeDefined();
			registry.dispose();
		} finally {
			process.chdir(previousCwd);
		}
	});

	describe("provider base URL environment variables", () => {
		test("does not bake the public OpenAI API URL into bundled OpenAI models", () => {
			const restore = unsetEnvForTest("OPENAI_BASE_URL");
			try {
				const registry = new ModelRegistry(authStorage, modelsJsonPath);
				const openaiModels = getModelsForProvider(registry, "openai");

				expect(openaiModels.length).toBeGreaterThan(0);
				expect(openaiModels.some(model => model.baseUrl.includes("api.openai.com"))).toBe(false);
			} finally {
				restore();
			}
		});

		test("uses OPENAI_BASE_URL for bundled OpenAI models when models config has no baseUrl override", () => {
			const restore = setEnvForTest("OPENAI_BASE_URL", "https://openai-proxy.example.com/v1");
			try {
				const registry = new ModelRegistry(authStorage, modelsJsonPath);
				const openaiModels = getModelsForProvider(registry, "openai");

				expect(openaiModels.length).toBeGreaterThan(0);
				expect(openaiModels.every(model => model.baseUrl === "https://openai-proxy.example.com/v1")).toBe(true);
				expect(registry.getProviderBaseUrl("openai")).toBe("https://openai-proxy.example.com/v1");
			} finally {
				restore();
			}
		});
		test("reloads bundled OpenAI models when OPENAI_BASE_URL changes without a models config", async () => {
			const restore = setEnvForTest("OPENAI_BASE_URL", "https://openai-first.example.com/v1");
			try {
				const registry = new ModelRegistry(authStorage, modelsJsonPath);
				expect(
					getModelsForProvider(registry, "openai").every(model => model.baseUrl === Bun.env.OPENAI_BASE_URL),
				).toBe(true);

				Bun.env.OPENAI_BASE_URL = "https://openai-second.example.com/v1";
				await registry.refresh("offline");

				expect(
					getModelsForProvider(registry, "openai").every(model => model.baseUrl === Bun.env.OPENAI_BASE_URL),
				).toBe(true);
			} finally {
				restore();
			}
		});

		test("does not apply OPENAI_BASE_URL to OpenAI Codex models", () => {
			const restore = setEnvForTest("OPENAI_BASE_URL", "https://openai-proxy.example.com/v1");
			try {
				const registry = new ModelRegistry(authStorage, modelsJsonPath);
				const codexModels = getModelsForProvider(registry, "openai-codex");

				expect(codexModels.length).toBeGreaterThan(0);
				expect(codexModels.every(model => model.baseUrl !== "https://openai-proxy.example.com/v1")).toBe(true);
				expect(registry.getProviderBaseUrl("openai-codex")).not.toBe("https://openai-proxy.example.com/v1");
			} finally {
				restore();
			}
		});

		test("user contextWindow override survives the Codex GPT-5.6 cap; invalid values are ignored", () => {
			writeRawModelsJson({
				"openai-codex": {
					modelOverrides: {
						"gpt-5.6-sol": { contextWindow: 373_000 },
						"gpt-5.6-terra": { contextWindow: -5 },
					},
				},
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const codexModels = getModelsForProvider(registry, "openai-codex");
			const sol = codexModels.find(model => model.id === "gpt-5.6-sol");
			const terra = codexModels.find(model => model.id === "gpt-5.6-terra");

			expect(sol?.contextWindow).toBe(373_000);
			expect(terra?.contextWindow).toBe(372_000);
		});
		test("registerProvider reapplies an openai-codex contextWindow override before the final cap", () => {
			writeRawModelsJson({
				"openai-codex": {
					modelOverrides: {
						"gpt-5.6-sol": { contextWindow: 373_000 },
					},
				},
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			registry.registerProvider("openai-codex", {
				baseUrl: "https://chatgpt.com/backend-api",
				api: "openai-codex-responses",
				apiKey: "TEST_KEY",
				models: [
					{
						id: "gpt-5.6-sol",
						name: "Runtime GPT-5.6 Sol",
						reasoning: true,
						input: ["text", "image"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 1_000_000,
						maxTokens: 128_000,
					},
				],
			});

			expect(registry.find("openai-codex", "gpt-5.6-sol")?.contextWindow).toBe(373_000);
		});
		test("openai-codex contextWindow override does not exempt same-id models on other Codex-transport providers", () => {
			writeRawModelsJson({
				"openai-codex": {
					modelOverrides: {
						"gpt-5.6-sol": { contextWindow: 373_000 },
					},
				},
				"codex-extension": {
					baseUrl: "https://codex-extension.example.com/v1",
					apiKey: "TEST_KEY",
					api: "openai-codex-responses",
					models: [{ id: "gpt-5.6-sol", contextWindow: 1_000_000 }],
				},
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const codexModels = getModelsForProvider(registry, "openai-codex");
			const openaiCodexSol = codexModels.find(model => model.id === "gpt-5.6-sol");
			const extensionSol = getModelsForProvider(registry, "codex-extension").find(
				model => model.id === "gpt-5.6-sol",
			);

			expect(openaiCodexSol?.contextWindow).toBe(373_000);
			expect(extensionSol?.contextWindow).toBe(372_000);
		});
		test("non-Codex contextWindow overrides that are not positive finite numbers are ignored without corrupting the bundled model", () => {
			writeRawModelsJson({
				openai: {
					modelOverrides: {
						"gpt-4o": { contextWindow: -5, maxTokens: -5 },
						"gpt-4.1": { contextWindow: Number.NaN },
					},
				},
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const models = getModelsForProvider(registry, "openai");
			for (const id of ["gpt-4o", "gpt-4.1"]) {
				const model = models.find(candidate => candidate.id === id);
				expect(model?.contextWindow).toBeTypeOf("number");
				expect(Number.isFinite(model!.contextWindow!)).toBe(true);
				expect(model!.contextWindow!).toBeGreaterThan(0);
			}
		});

		test("mixed-case modelOverrides keys match the bundled lowercase models and the Codex cap exemption", () => {
			writeRawModelsJson({
				"openai-codex": {
					modelOverrides: {
						"GPT-5.6-SOL": { contextWindow: 380_000 },
					},
				},
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const codexModels = getModelsForProvider(registry, "openai-codex");
			const sol = codexModels.find(model => model.id === "gpt-5.6-sol");

			// The mixed-case key is normalized to gpt-5.6-sol, so the value is
			// merged AND the cap exemption matches the same normalized key.
			expect(sol?.contextWindow).toBe(380_000);
		});
		test("keeps models config baseUrl ahead of provider base URL env vars", () => {
			const restore = setEnvForTest("OPENAI_BASE_URL", "https://openai-env.example.com/v1");
			try {
				writeRawModelsJson({
					openai: overrideConfig("https://openai-models-config.example.com/v1"),
				});

				const registry = new ModelRegistry(authStorage, modelsJsonPath);
				const openaiModels = getModelsForProvider(registry, "openai");

				expect(openaiModels.length).toBeGreaterThan(0);
				expect(openaiModels.every(model => model.baseUrl === "https://openai-models-config.example.com/v1")).toBe(
					true,
				);
				expect(registry.getProviderBaseUrl("openai")).toBe("https://openai-models-config.example.com/v1");
			} finally {
				restore();
			}
		});

		test("uses GEMINI_BASE_URL as a Google provider base URL alias", () => {
			const restore = setEnvForTest("GEMINI_BASE_URL", "https://gemini-proxy.example.com/v1beta");
			try {
				const registry = new ModelRegistry(authStorage, modelsJsonPath);
				const googleModels = getModelsForProvider(registry, "google");

				expect(googleModels.length).toBeGreaterThan(0);
				expect(googleModels.every(model => model.baseUrl === "https://gemini-proxy.example.com/v1beta")).toBe(true);
				expect(registry.getProviderBaseUrl("google")).toBe("https://gemini-proxy.example.com/v1beta");
			} finally {
				restore();
			}
		});

		test("derives base URL env var names for custom provider ids", () => {
			const restore = setEnvForTest("MY_PROXY_BASE_URL", "https://custom-provider.example.com/v1");
			try {
				const registry = new ModelRegistry(authStorage, modelsJsonPath);

				expect(registry.getProviderBaseUrl("my-proxy")).toBe("https://custom-provider.example.com/v1");
			} finally {
				restore();
			}
		});
	});

	describe("custom reasoning capability metadata", () => {
		test("persists explicit opt-in and keeps unsupported OpenAI-compatible models unavailable after reload", () => {
			writeRawModelsJson({
				"reasoning-proxy": {
					baseUrl: "https://proxy.example.com/v1",
					apiKey: "TEST_KEY",
					api: "openai-completions",
					models: [
						{
							id: "eligible-reasoner",
							reasoning: true,
							thinking: { mode: "effort", minLevel: "low", maxLevel: "high" },
							compat: { supportsReasoningEffort: true },
						},
						{
							id: "explicitly-disabled-reasoner",
							reasoning: true,
							thinking: { mode: "effort", minLevel: "low", maxLevel: "high" },
							compat: { supportsReasoningEffort: false },
						},
						{
							id: "implicit-reasoner",
							reasoning: true,
							thinking: { mode: "effort", minLevel: "low", maxLevel: "high" },
						},
					],
				},
			});

			for (let load = 0; load < 2; load++) {
				const registry = new ModelRegistry(authStorage, modelsJsonPath);
				const eligible = registry.find("reasoning-proxy", "eligible-reasoner");
				const disabled = registry.find("reasoning-proxy", "explicitly-disabled-reasoner");
				const implicit = registry.find("reasoning-proxy", "implicit-reasoner");

				expect(eligible?.thinking).toEqual({ mode: "effort", minLevel: Effort.Low, maxLevel: Effort.High });
				expect(eligible ? getSupportedEfforts(eligible) : []).toEqual([Effort.Low, Effort.Medium, Effort.High]);
				expect(disabled?.thinking).toBeUndefined();
				expect(disabled ? getSupportedEfforts(disabled) : []).toEqual([]);
				expect(implicit?.thinking).toBeUndefined();
				expect(implicit ? getSupportedEfforts(implicit) : []).toEqual([]);
			}
		});
	});

	describe("cache retention config", () => {
		test("applies provider cacheRetention to bundled provider models", () => {
			writeRawModelsJson({
				openai: { cacheRetention: "long" },
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const openaiModel = registry.find("openai", "gpt-5-mini");

			expect(openaiModel?.cacheRetention).toBe("long");
		});

		test("propagates declared image output capability for custom models", () => {
			writeRawModelsJson({
				layofflabs: {
					baseUrl: "https://api.layofflabs.com/v1",
					apiKey: "TEST_KEY",
					api: "openai-responses",
					models: [
						{
							id: "gpt-5.5",
							input: ["text", "image"],
							output: ["text", "image"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 400000,
							maxTokens: 128000,
						},
						{
							id: "gpt-5.5-text",
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 400000,
							maxTokens: 128000,
						},
					],
				},
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			expect(registry.find("layofflabs", "gpt-5.5")?.output).toEqual(["text", "image"]);
			expect(registry.find("layofflabs", "gpt-5.5-text")?.output).toBeUndefined();
		});

		test("modelOverrides can set image output capability", () => {
			writeRawModelsJson({
				openai: {
					modelOverrides: {
						"gpt-5-mini": { output: ["text", "image"] },
					},
				},
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			expect(registry.find("openai", "gpt-5-mini")?.output).toEqual(["text", "image"]);
		});

		test("modelOverrides cacheRetention wins over provider cacheRetention", () => {
			writeRawModelsJson({
				openai: {
					cacheRetention: "long",
					modelOverrides: {
						"gpt-5-mini": { cacheRetention: "none" },
					},
				},
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const overridden = registry.find("openai", "gpt-5-mini");
			const inherited = registry.find("openai", "gpt-5");

			expect(overridden?.cacheRetention).toBe("none");
			expect(inherited?.cacheRetention).toBe("long");
		});

		test("inline custom model cacheRetention wins over provider cacheRetention", () => {
			writeRawModelsJson({
				custom: {
					baseUrl: "https://custom.example.com/v1",
					apiKey: "TEST_KEY",
					api: "openai-responses",
					cacheRetention: "long",
					models: [
						{
							id: "fast",
							cacheRetention: "short",
						},
						{ id: "defaulted" },
					],
				},
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);

			expect(registry.find("custom", "fast")?.cacheRetention).toBe("short");
			expect(registry.find("custom", "defaulted")?.cacheRetention).toBe("long");
		});
	});

	describe("canonical equivalence", () => {
		test("groups dotted provider variants under the bundled canonical id", () => {
			writeRawModelsJson({
				demo: providerConfig("https://demo.example.com/v1", [{ id: "anthropic/claude-sonnet-4.5" }]),
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const variants = registry.getCanonicalVariants("claude-sonnet-4-5");

			expect(variants.some(variant => variant.selector === "anthropic/claude-sonnet-4-5")).toBe(true);
			expect(variants.some(variant => variant.selector === "demo/anthropic/claude-sonnet-4.5")).toBe(true);
		});

		test("collapses wrapped, dated, and tuned anthropic variants under the base canonical id", () => {
			writeRawModelsJson({
				demo: providerConfig("https://demo.example.com/v1", [
					{ id: "anthropic/claude-opus-4.5" },
					{ id: "claude-opus-4-5-20251101" },
					{ id: "claude-4.5-opus-high-thinking" },
				]),
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const variants = registry.getCanonicalVariants("claude-opus-4-5");

			expect(variants.some(variant => variant.selector === "demo/anthropic/claude-opus-4.5")).toBe(true);
			expect(variants.some(variant => variant.selector === "demo/claude-opus-4-5-20251101")).toBe(true);
			expect(variants.some(variant => variant.selector === "demo/claude-4.5-opus-high-thinking")).toBe(true);
		});

		test("collapses gitlab duo chat wrapper ids into the upstream canonical id", () => {
			writeRawModelsJson({
				"gitlab-duo": providerConfig("https://demo.example.com/v1", [{ id: "duo-chat-opus-4-6" }]),
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const variants = registry.getCanonicalVariants("claude-opus-4-6");

			expect(variants.some(variant => variant.selector === "gitlab-duo/duo-chat-opus-4-6")).toBe(true);
		});

		test("collapses synthetic and vendor-prefixed glm wrappers into the upstream canonical id", () => {
			writeRawModelsJson({
				demo: providerConfig("https://demo.example.com/v1", [{ id: "hf:zai-org/GLM-4.7" }, { id: "zai-glm-4.7" }]),
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const variants = registry.getCanonicalVariants("glm-4.7");

			expect(variants.some(variant => variant.selector === "demo/hf:zai-org/GLM-4.7")).toBe(true);
			expect(variants.some(variant => variant.selector === "demo/zai-glm-4.7")).toBe(true);
		});

		test("collapses compact and reordered claude aliases into the upstream canonical id", () => {
			writeRawModelsJson({
				demo: providerConfig("https://demo.example.com/v1", [
					{ id: "claude-opus-45" },
					{ id: "claude-4.5-sonnet" },
				]),
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const opusVariants = registry.getCanonicalVariants("claude-opus-4-5");
			const sonnetVariants = registry.getCanonicalVariants("claude-sonnet-4-5");

			expect(opusVariants.some(variant => variant.selector === "demo/claude-opus-45")).toBe(true);
			expect(sonnetVariants.some(variant => variant.selector === "demo/claude-4.5-sonnet")).toBe(true);
		});

		test("collapses nitro-suffixed OpenRouter variants under the upstream canonical id", () => {
			writeRawModelsJson({
				openrouter: providerConfig("https://openrouter.ai/api/v1", [{ id: "z-ai/glm-4.7-20251222:nitro" }]),
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const variants = registry.getCanonicalVariants("glm-4.7");

			expect(variants.some(variant => variant.selector === "openrouter/z-ai/glm-4.7-20251222:nitro")).toBe(true);
		});

		test("uses bundled metadata for Ollama cloud aliases in custom local-proxy configs", () => {
			writeRawModelsJson({
				ollama: {
					baseUrl: "http://127.0.0.1:11434/v1",
					api: "openai-completions",
					auth: "none",
					models: [
						{
							id: "deepseek-v4-pro:cloud",
							name: "DeepSeek V4 Pro (Ollama Cloud)",
							reasoning: true,
							input: ["text"],
							contextWindow: 1_048_576,
							maxTokens: 65_536,
						},
					],
				},
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const model = registry.find("ollama", "deepseek-v4-pro:cloud");
			const variants = registry.getCanonicalVariants("deepseek-v4-pro");

			expect(model?.cost.cacheRead).toBeGreaterThan(0);
			expect(model?.thinking?.maxLevel).toBe(Effort.XHigh);
			expect(variants.some(variant => variant.selector === "ollama/deepseek-v4-pro:cloud")).toBe(true);
		});

		test("collapses anthropic latest aliases into the best upstream claude family id", () => {
			writeRawModelsJson({
				demo: providerConfig("https://demo.example.com/v1", [
					{ id: "anthropic/claude-opus-latest" },
					{ id: "anthropic/claude-haiku-latest" },
				]),
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const opusVariants = registry.getCanonicalVariants("claude-opus-5");
			const haikuVariants = registry.getCanonicalVariants("claude-haiku-4-5");

			expect(opusVariants.some(variant => variant.selector === "demo/anthropic/claude-opus-latest")).toBe(true);
			expect(haikuVariants.some(variant => variant.selector === "demo/anthropic/claude-haiku-latest")).toBe(true);
			expect(
				registry
					.getCanonicalVariants("claude-haiku-4-5-20251001-thinking")
					.some(variant => variant.selector === "demo/anthropic/claude-haiku-latest"),
			).toBe(false);
		});

		test("collapses wrapped gemini tool and tuning variants under the base preview id", () => {
			writeRawModelsJson({
				demo: providerConfig("https://demo.example.com/v1", [
					{ id: "google/gemini-3.1-pro-preview" },
					{ id: "google/gemini-3.1-pro-preview-customtools" },
					{ id: "google/gemini-3.1-pro-preview-high" },
				]),
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const variants = registry.getCanonicalVariants("gemini-3.1-pro-preview");

			expect(variants.some(variant => variant.selector === "demo/google/gemini-3.1-pro-preview")).toBe(true);
			expect(variants.some(variant => variant.selector === "demo/google/gemini-3.1-pro-preview-customtools")).toBe(
				true,
			);
			expect(variants.some(variant => variant.selector === "demo/google/gemini-3.1-pro-preview-high")).toBe(true);
		});

		test("collapses compact version aliases and hardware suffixes into clean canonical ids", () => {
			writeRawModelsJson({
				demo: providerConfig("https://demo.example.com/v1", [
					{ id: "hf:nvidia/Kimi-K2.5-NVFP4" },
					{ id: "kimi-k2-5" },
					{ id: "z-ai/glm4.7" },
					{ id: "z-ai/glm5" },
				]),
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const kimiVariants = registry.getCanonicalVariants("kimi-k2.5");
			const glm47Variants = registry.getCanonicalVariants("glm-4.7");
			const glm5Variants = registry.getCanonicalVariants("glm-5");

			expect(kimiVariants.some(variant => variant.selector === "demo/hf:nvidia/Kimi-K2.5-NVFP4")).toBe(true);
			expect(kimiVariants.some(variant => variant.selector === "demo/kimi-k2-5")).toBe(true);
			expect(glm47Variants.some(variant => variant.selector === "demo/z-ai/glm4.7")).toBe(true);
			expect(glm5Variants.some(variant => variant.selector === "demo/z-ai/glm5")).toBe(true);
		});

		test("prefers clean canonical ids over bundled wrapper ids when available", () => {
			writeRawModelsJson({
				demo: providerConfig("https://demo.example.com/v1", [
					{ id: "zai/glm-4.6v-flash" },
					{ id: "hf:deepseek-ai/DeepSeek-V3" },
					{ id: "google/gemini-pro-latest" },
				]),
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);

			expect(
				registry
					.getCanonicalVariants("glm-4.6v-flash")
					.some(variant => variant.selector === "demo/zai/glm-4.6v-flash"),
			).toBe(true);
			expect(
				registry
					.getCanonicalVariants("deepseek-v3")
					.some(variant => variant.selector === "demo/hf:deepseek-ai/DeepSeek-V3"),
			).toBe(true);
			expect(
				registry
					.getCanonicalVariants("gemini-pro")
					.some(variant => variant.selector === "demo/google/gemini-pro-latest"),
			).toBe(true);
		});

		test("applies explicit equivalence overrides from config", () => {
			writeRawModelsConfig({
				providers: {
					"proxy-anthropic": providerConfig("https://demo.example.com/v1", [{ id: "corp-sonnet" }]),
				},
				equivalence: {
					overrides: {
						"proxy-anthropic/corp-sonnet": "claude-sonnet-4-5",
					},
				},
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const variants = registry.getCanonicalVariants("claude-sonnet-4-5");

			expect(variants.some(variant => variant.selector === "proxy-anthropic/corp-sonnet")).toBe(true);
		});

		test("provider-level pi-native transport reaches custom models", () => {
			writeRawModelsConfig({
				providers: {
					gateway: {
						...providerConfig("http://127.0.0.1:4000", [{ id: "upstream/custom-model" }], "openai-completions"),
						transport: "pi-native",
					},
				},
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const model = registry.find("gateway", "upstream/custom-model");

			expect(model?.transport).toBe("pi-native");
		});

		test("exclusions keep variants out of canonical grouping", () => {
			writeRawModelsConfig({
				providers: {
					demo: providerConfig("https://demo.example.com/v1", [{ id: "anthropic/claude-sonnet-4.5" }]),
				},
				equivalence: {
					exclude: ["demo/anthropic/claude-sonnet-4.5"],
				},
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const grouped = registry.getCanonicalVariants("claude-sonnet-4-5");
			const fallback = registry.getCanonicalVariants("anthropic/claude-sonnet-4.5");

			expect(grouped.some(variant => variant.selector === "demo/anthropic/claude-sonnet-4.5")).toBe(false);
			expect(fallback.some(variant => variant.selector === "demo/anthropic/claude-sonnet-4.5")).toBe(true);
		});

		test("resolves canonical models using configured provider order", async () => {
			await Settings.init({ inMemory: true });
			settings.set("modelProviderOrder", ["demo", "anthropic"]);
			// Both variants are vision-capable, so provider order is the deciding factor.
			writeRawModelsJson({
				demo: {
					baseUrl: "https://demo.example.com/v1",
					apiKey: "TEST_KEY",
					api: "anthropic-messages",
					models: [
						{
							id: "anthropic/claude-sonnet-4.5",
							name: "anthropic/claude-sonnet-4.5",
							reasoning: false,
							input: ["text", "image"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 100000,
							maxTokens: 8000,
						},
					],
				},
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const resolved = registry.resolveCanonicalModel("claude-sonnet-4-5", {
				availableOnly: false,
				candidates: registry.getAll(),
			});

			expect(resolved?.provider).toBe("demo");
			expect(resolved?.id).toBe("anthropic/claude-sonnet-4.5");
		});
		/** Hermetic candidate set for fixture providers only (excludes ambient host providers). */
		function fixtureCandidates(
			registry: ModelRegistry,
			providers: readonly string[] = ["alpha", "beta"],
			modelId = "anthropic/claude-sonnet-4.5",
		) {
			return providers
				.map(provider => registry.find(provider, modelId))
				.filter((model): model is NonNullable<typeof model> => model !== undefined);
		}

		test("keeps available canonical variants sticky across refreshes and releases unavailable variants", async () => {
			const alpha = providerConfig("https://alpha.example.com/v1", [{ id: "anthropic/claude-sonnet-4.5" }]);
			const beta = providerConfig("https://beta.example.com/v1", [{ id: "anthropic/claude-sonnet-4.5" }]);
			writeRawModelsJson({ alpha, beta });
			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const candidates = () => fixtureCandidates(registry);
			const initial = registry.resolveCanonicalModel("claude-sonnet-4-5", {
				availableOnly: true,
				candidates: candidates(),
				sessionId: "session-a",
			});
			expect(initial).toBeDefined();
			expect(["alpha", "beta"]).toContain(initial!.provider);

			await Bun.sleep(10);
			writeRawModelsJson({ beta, alpha });
			await registry.refresh("offline");
			expect(
				registry.resolveCanonicalModel("claude-sonnet-4-5", {
					availableOnly: true,
					candidates: candidates(),
					sessionId: "session-a",
				}),
			).toMatchObject({ provider: initial!.provider, id: initial!.id });

			const { apiKey: _apiKey, ...unavailableInitialProvider } = initial!.provider === "alpha" ? alpha : beta;
			await Bun.sleep(10);
			writeRawModelsJson(
				initial!.provider === "alpha"
					? { beta, alpha: unavailableInitialProvider }
					: { beta: unavailableInitialProvider, alpha },
			);
			await registry.refresh("offline");
			expect(
				registry.resolveCanonicalModel("claude-sonnet-4-5", {
					availableOnly: true,
					candidates: candidates(),
					sessionId: "session-a",
				})?.provider,
			).not.toBe(initial!.provider);
		});

		test("bounds session canonical variants to 64 entries", () => {
			writeRawModelsJson({
				alpha: providerConfig("https://alpha.example.com/v1", [{ id: "anthropic/claude-sonnet-4.5" }]),
				beta: providerConfig("https://beta.example.com/v1", [{ id: "anthropic/claude-sonnet-4.5" }]),
			});
			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const candidates = () => fixtureCandidates(registry);
			const alphaModel = registry.find("alpha", "anthropic/claude-sonnet-4.5")!;
			const betaModel = registry.find("beta", "anthropic/claude-sonnet-4.5")!;
			// Seed a non-catalog winner so eviction observably releases the session.
			expect(registry.seedCanonicalVariant("session-0", betaModel)).toBe(true);
			expect(
				registry.resolveCanonicalModel("claude-sonnet-4-5", {
					availableOnly: true,
					candidates: candidates(),
					sessionId: "session-0",
				}),
			).toBe(betaModel);
			for (let index = 1; index < 65; index += 1) {
				registry.resolveCanonicalModel("claude-sonnet-4-5", {
					availableOnly: true,
					candidates: candidates(),
					sessionId: `session-${index}`,
				});
			}
			// The 64-entry cap evicted session-0; it re-resolves to the catalog winner
			// even when the caller reorders candidates.
			const reversedCandidates = [...candidates()].reverse();
			expect(
				registry.resolveCanonicalModel("claude-sonnet-4-5", {
					availableOnly: true,
					candidates: reversedCandidates,
					sessionId: "session-0",
				}),
			).toBe(alphaModel);
		});

		test("prefers configured provider order before vision capability", async () => {
			await Settings.init({ inMemory: true });
			settings.set("modelProviderOrder", ["demo", "anthropic"]);
			// Explicit provider order is the first automatic-resolution axis, so the
			// listed text-only provider wins before the later vision capability axis.
			writeRawModelsJson({
				demo: providerConfig("https://demo.example.com/v1", [{ id: "anthropic/claude-sonnet-4.5" }]),
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const resolved = registry.resolveCanonicalModel("claude-sonnet-4-5", {
				availableOnly: false,
				candidates: registry.getAll(),
			});

			expect(resolved?.input.includes("image")).toBe(false);
			expect(resolved?.provider).toBe("demo");
		});
		test("ranks bare aliases and canonical ids identically across provider order conflicts", async () => {
			await Settings.init({ inMemory: true });
			settings.set("modelProviderOrder", ["beta", "alpha"]);
			writeRawModelsJson({
				alpha: providerConfig("https://alpha.example.com/v1", [{ id: "claude-sonnet-4.5" }]),
				beta: providerConfig("https://beta.example.com/v1", [{ id: "claude-sonnet-4.5" }]),
			});
			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const candidates = [registry.find("alpha", "claude-sonnet-4.5")!, registry.find("beta", "claude-sonnet-4.5")!];
			const variants = registry.getCanonicalVariants("claude-sonnet-4-5", { candidates });
			const canonical = registry.resolveCanonicalModel("claude-sonnet-4-5", {
				availableOnly: false,
				candidates,
			});
			const bare = resolveModelFromString("claude-sonnet-4.5", candidates, undefined, registry);

			// Vision, canonical exactness, source, and input plus cache-read cost all tie.
			// Provider rank must win even though alpha appears first in catalog order.
			expect(variants).toHaveLength(2);
			expect(variants.every(variant => variant.model.id !== "claude-sonnet-4-5")).toBe(true);
			expect(new Set(variants.map(variant => variant.source)).size).toBe(1);
			expect(variants.map(variant => variant.model.cost.input + variant.model.cost.cacheRead)).toEqual([0, 0]);
			expect(canonical).toMatchObject({ provider: "beta", id: "claude-sonnet-4.5" });
			expect(bare).toBe(canonical);
		});
		test("keeps an explicitly seeded canonical variant sticky for a session", () => {
			writeRawModelsJson({
				demo: providerConfig("https://demo.example.com/v1", [{ id: "anthropic/claude-sonnet-4.5" }]),
			});
			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const demoVariant = registry
				.getCanonicalVariants("claude-sonnet-4-5")
				.find(entry => entry.model.provider === "demo");

			expect(demoVariant).toBeDefined();
			expect(registry.seedCanonicalVariant("session", demoVariant!.model)).toBe(true);
			expect(
				registry.resolveCanonicalModel("claude-sonnet-4-5", {
					availableOnly: false,
					candidates: registry.getAll(),
					sessionId: "session",
				}),
			).toBe(demoVariant!.model);
		});
		test("caches available models until disabled providers change", async () => {
			await Settings.init({ inMemory: true });
			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const initial = registry.getAvailable();
			expect(registry.getAvailable()).toBe(initial);

			settings.setDisabledProviders(["anthropic"]);
			expect(registry.getAvailable()).not.toBe(initial);
		});

		test("invalidates available models when a runtime API-key override is set", async () => {
			await Settings.init({ inMemory: true });
			const previous = process.env.XAI_API_KEY;
			delete process.env.XAI_API_KEY;
			try {
				const registry = new ModelRegistry(authStorage, modelsJsonPath);
				const initial = registry.getAvailable();
				expect(initial.some(model => model.provider === "xai")).toBe(false);
				authStorage.setRuntimeApiKey("xai", "runtime-test-key");
				expect(registry.getAvailable()).not.toBe(initial);
				expect(registry.getAvailable().some(model => model.provider === "xai")).toBe(true);
			} finally {
				if (previous === undefined) delete process.env.XAI_API_KEY;
				else process.env.XAI_API_KEY = previous;
			}
		});
		test("keeps normal availability while excluding a failed stored command key from Q29", async () => {
			const restoreXaiKey = unsetEnvForTest("XAI_API_KEY");
			try {
				authStorage.close();
				authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"), {
					configValueResolver: async () => undefined,
				});
				await authStorage.set("xai", [{ type: "api_key", key: "!missing-xai-key" }]);

				const registry = new ModelRegistry(authStorage, modelsJsonPath);
				const initial = registry.getAvailable();
				expect(initial.some(model => model.provider === "xai")).toBe(true);
				expect(registry.getActiveProviders().some(provider => provider.provider === "xai")).toBe(false);

				await expect(authStorage.peekApiKey("xai")).resolves.toBeUndefined();

				const available = registry.getAvailable();
				expect(available).not.toBe(initial);
				expect(available.some(model => model.provider === "xai")).toBe(true);
				expect(registry.getActiveProviders().some(provider => provider.provider === "xai")).toBe(false);
			} finally {
				restoreXaiKey();
			}
		});
		test("recovers a failed stored command key through ordinary provider key lookup", async () => {
			const restoreXaiKey = unsetEnvForTest("XAI_API_KEY");
			let resolvedKey: string | undefined;
			try {
				authStorage.close();
				authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"), {
					configValueResolver: async config => (config === "!recovering-xai-key" ? resolvedKey : undefined),
				});
				await authStorage.set("xai", [{ type: "api_key", key: "!recovering-xai-key" }]);

				const registry = new ModelRegistry(authStorage, modelsJsonPath);
				await expect(authStorage.peekApiKey("xai")).resolves.toBeUndefined();
				expect(registry.getActiveProviders().some(provider => provider.provider === "xai")).toBe(false);

				resolvedKey = "recovered-xai-key";
				await expect(registry.getApiKeyForProvider("xai")).resolves.toBe("recovered-xai-key");
				expect(registry.getActiveProviders()).toContainEqual({
					provider: "xai",
					connectionKind: "credential",
				});
			} finally {
				restoreXaiKey();
			}
		});
		test("keeps normal availability after every stored command key resolves undefined", async () => {
			const restoreXaiKey = unsetEnvForTest("XAI_API_KEY");
			try {
				authStorage.close();
				authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"), {
					configValueResolver: async () => undefined,
				});
				await authStorage.set("xai", [
					{ type: "api_key", key: "!missing-xai-key-a" },
					{ type: "api_key", key: "!missing-xai-key-b" },
				]);

				const registry = new ModelRegistry(authStorage, modelsJsonPath);
				const initial = registry.getAvailable();
				expect(initial.some(model => model.provider === "xai")).toBe(true);

				await expect(authStorage.peekApiKey("xai")).resolves.toBeUndefined();
				const afterFirst = registry.getAvailable();
				expect(afterFirst.some(model => model.provider === "xai")).toBe(true);

				await expect(authStorage.peekApiKey("xai")).resolves.toBeUndefined();
				const available = registry.getAvailable();
				expect(available).toBe(afterFirst);
				expect(available.some(model => model.provider === "xai")).toBe(true);
				expect(registry.getActiveProviders().some(provider => provider.provider === "xai")).toBe(false);
			} finally {
				restoreXaiKey();
			}
		});
		test("preserves mixed-credential and selector auth precedence after stored API-key resolution", async () => {
			const restoreXaiKey = unsetEnvForTest("XAI_API_KEY");
			try {
				authStorage.close();
				authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"), {
					configValueResolver: async () => undefined,
				});
				await authStorage.set("xai", [
					{ type: "api_key", key: "!missing-xai-key" },
					{
						type: "oauth",
						access: "selected-access",
						refresh: "selected-refresh",
						expires: Date.now() + 60_000,
						email: "selected@example.com",
					},
				]);

				const registry = new ModelRegistry(authStorage, modelsJsonPath);
				expect(registry.getAvailable().some(model => model.provider === "xai")).toBe(true);
				await expect(authStorage.peekApiKey("xai")).resolves.toBe("selected-access");
				expect(registry.getAvailable().some(model => model.provider === "xai")).toBe(true);
				expect(registry.getActiveProviders().some(provider => provider.provider === "xai")).toBe(true);

				authStorage.setRuntimeCredentialSelector("xai", {
					kind: "email",
					value: "selected@example.com",
				});
				expect(registry.getAvailable().some(model => model.provider === "xai")).toBe(true);

				authStorage.removeRuntimeCredentialSelector("xai");
				authStorage.setRuntimeApiKey("xai", "runtime-test-key");
				expect(registry.getAvailable().some(model => model.provider === "xai")).toBe(true);
			} finally {
				restoreXaiKey();
			}
		});
		test("rejects a dangling credential selector even when a runtime API-key override exists", async () => {
			const previous = process.env.XAI_API_KEY;
			delete process.env.XAI_API_KEY;
			try {
				await authStorage.set("xai", [
					{
						type: "oauth",
						access: "selected-access",
						refresh: "selected-refresh",
						expires: Date.now() + 60_000,
						email: "selected@example.com",
					},
				]);
				authStorage.setRuntimeCredentialSelector("xai", {
					kind: "email",
					value: "selected@example.com",
				});
				await authStorage.set("xai", []);
				authStorage.setRuntimeApiKey("xai", "runtime-test-key");

				const registry = new ModelRegistry(authStorage, modelsJsonPath);
				expect(registry.getAvailable().some(model => model.provider === "xai")).toBe(false);
			} finally {
				if (previous === undefined) delete process.env.XAI_API_KEY;
				else process.env.XAI_API_KEY = previous;
			}
		});

		test("refreshes available models when an API-key environment variable changes", async () => {
			await Settings.init({ inMemory: true });
			const previous = process.env.XAI_API_KEY;
			delete process.env.XAI_API_KEY;
			try {
				const registry = new ModelRegistry(authStorage, modelsJsonPath);
				const initial = registry.getAvailable();
				expect(initial.some(model => model.provider === "xai")).toBe(false);
				process.env.XAI_API_KEY = "environment-test-key";
				expect(registry.getAvailable()).not.toBe(initial);
				expect(registry.getAvailable().some(model => model.provider === "xai")).toBe(true);
			} finally {
				if (previous === undefined) delete process.env.XAI_API_KEY;
				else process.env.XAI_API_KEY = previous;
			}
		});
		test("refresh reloads custom apiKeyEnv presence changes without a models file change", async () => {
			const keyEnv = `GJC_TEST_REFRESH_PROVIDER_KEY_${Snowflake.next()}`;
			const restoreKey = unsetEnvForTest(keyEnv);
			try {
				writeRawModelsJson({
					"env-provider": {
						baseUrl: "https://env-provider.example/v1",
						api: "openai-responses",
						apiKeyEnv: keyEnv,
						models: [{ id: "env-model" }],
					},
				});
				const registry = new ModelRegistry(authStorage, modelsJsonPath);
				expect(registry.getAvailable().some(model => model.provider === "env-provider")).toBe(false);

				Bun.env[keyEnv] = "refresh-env-key";
				await registry.refresh("offline");
				expect(registry.getAvailable().some(model => model.provider === "env-provider")).toBe(true);
				await expect(registry.getApiKeyForProvider("env-provider")).resolves.toBe("refresh-env-key");

				delete Bun.env[keyEnv];
				await registry.refresh("offline");
				expect(registry.getAvailable().some(model => model.provider === "env-provider")).toBe(false);
				await expect(registry.getApiKeyForProvider("env-provider")).resolves.toBeUndefined();
			} finally {
				restoreKey();
			}
		});
		test("resolves a rotated custom apiKeyEnv on the next credential request", async () => {
			const keyEnv = `GJC_TEST_ROTATING_PROVIDER_KEY_${Snowflake.next()}`;
			const restoreKey = setEnvForTest(keyEnv, "initial-env-key");
			try {
				writeRawModelsJson({
					"rotating-provider": {
						baseUrl: "https://rotating-provider.example/v1",
						api: "openai-responses",
						apiKeyEnv: keyEnv,
						models: [{ id: "rotating-model" }],
					},
				});
				const registry = new ModelRegistry(authStorage, modelsJsonPath);

				await expect(registry.getApiKeyForProvider("rotating-provider")).resolves.toBe("initial-env-key");
				Bun.env[keyEnv] = "rotated-env-key";
				await expect(registry.getApiKeyForProvider("rotating-provider")).resolves.toBe("rotated-env-key");
				delete Bun.env[keyEnv];
				await expect(registry.getApiKeyForProvider("rotating-provider")).resolves.toBeUndefined();
			} finally {
				restoreKey();
			}
		});
		test("refreshes openaiCompat apiKeyEnv and preserves a literal apiKey", async () => {
			const compatKeyEnv = `GJC_TEST_ROTATING_COMPAT_KEY_${Snowflake.next()}`;
			const literalKeyEnv = `GJC_TEST_LITERAL_API_KEY_ENV_${Snowflake.next()}`;
			const restoreCompatKey = setEnvForTest(compatKeyEnv, "compat-initial-key");
			const restoreLiteralKey = setEnvForTest(literalKeyEnv, "env-shadow-key");
			try {
				writeRawModelsJson({
					"compat-rotating-provider": {
						baseUrl: "https://compat-rotating-provider.example/v1",
						api: "openai-responses",
						openaiCompat: {
							baseUrl: "https://compat-rotating-provider.example/v1",
							apiKeyEnv: compatKeyEnv,
						},
					},
					"literal-provider": {
						baseUrl: "https://literal-provider.example/v1",
						api: "openai-responses",
						apiKey: "literal-config-key",
						apiKeyEnv: literalKeyEnv,
						models: [{ id: "literal-model" }],
					},
				});
				const registry = new ModelRegistry(authStorage, modelsJsonPath);

				await expect(registry.getApiKeyForProvider("compat-rotating-provider")).resolves.toBe("compat-initial-key");
				Bun.env[compatKeyEnv] = "compat-rotated-key";
				await expect(registry.getApiKeyForProvider("compat-rotating-provider")).resolves.toBe("compat-rotated-key");
				delete Bun.env[compatKeyEnv];
				await expect(registry.getApiKeyForProvider("compat-rotating-provider")).resolves.toBeUndefined();

				await expect(registry.getApiKeyForProvider("literal-provider")).resolves.toBe("literal-config-key");
				delete Bun.env[literalKeyEnv];
				await expect(registry.getApiKeyForProvider("literal-provider")).resolves.toBe("literal-config-key");
			} finally {
				restoreCompatKey();
				restoreLiteralKey();
			}
		});
		test("refresh reloads custom apiKey environment-name values without a models file change", async () => {
			const keyEnv = `GJC_TEST_REFRESH_PROVIDER_API_KEY_${Snowflake.next()}`;
			const restoreKey = setEnvForTest(keyEnv, "initial-env-key");
			try {
				writeRawModelsJson({
					"api-key-provider": {
						baseUrl: "https://api-key-provider.example/v1",
						api: "openai-responses",
						apiKey: keyEnv,
						models: [{ id: "api-key-model" }],
					},
				});
				const registry = new ModelRegistry(authStorage, modelsJsonPath);

				await expect(registry.getApiKeyForProvider("api-key-provider")).resolves.toBe("initial-env-key");
				Bun.env[keyEnv] = "rotated-env-key";
				await registry.refresh("offline");
				await expect(registry.getApiKeyForProvider("api-key-provider")).resolves.toBe("rotated-env-key");
			} finally {
				restoreKey();
			}
		});

		test("keeps a session canonical variant while it remains available", () => {
			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const initial = registry.resolveCanonicalModel("claude-sonnet-4-5", {
				availableOnly: false,
				candidates: registry.getAll(),
				sessionId: "sticky-session",
			});
			const resolved = registry.resolveCanonicalModel("claude-sonnet-4-5", {
				availableOnly: false,
				candidates: registry.getAll().reverse(),
				sessionId: "sticky-session",
			});
			expect(resolved).toBe(initial);
		});
		test("getCanonicalModelSelections matches per-record resolution across the whole catalog", () => {
			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const candidates = registry.getAll();
			const selections = registry.getCanonicalModelSelections({ availableOnly: false, candidates });
			const records = registry.getCanonicalModels({ availableOnly: false, candidates });

			expect(selections.length).toBe(records.length);
			expect(selections.length).toBeGreaterThan(0);
			for (let index = 0; index < records.length; index += 1) {
				const record = records[index]!;
				const selection = selections[index]!;
				expect(selection.record.id).toBe(record.id);
				expect(selection.record.name).toBe(record.name);
				expect(selection.record.variants).toEqual(record.variants);
				const resolved = registry.resolveCanonicalModel(record.id, { availableOnly: false, candidates });
				expect(selection.model).toBe(resolved);
			}
		});
		// Sticky state mutates per call, so each scenario runs batch and per-record
		// passes in the same order on independent registries. Split into one test
		// per scenario: a single combined test exceeded the default 5s test
		// timeout on slower CI runners.
		function assertBatchMatchesPerRecord(scenario: { availableOnly: boolean; sessionId: string | undefined }): void {
			if (scenario.availableOnly) {
				// Deterministic availability: without seeded credentials this
				// scenario is vacuous locally (0 records) and environment-dependent
				// in CI (ambient credentials enable arbitrary bundled providers).
				authStorage.setRuntimeApiKey("anthropic", "equivalence-key");
				authStorage.setRuntimeApiKey("openai", "equivalence-key");
			}
			const batchRegistry = new ModelRegistry(authStorage, modelsJsonPath);
			const perRecordRegistry = new ModelRegistry(authStorage, modelsJsonPath);
			// Candidate subset: even-index models drop roughly half the catalog,
			// exercising per-variant candidate-key filtering on both paths.
			const candidates = batchRegistry.getAll().filter((_, index) => index % 2 === 0);
			const options = {
				availableOnly: scenario.availableOnly,
				candidates,
				sessionId: scenario.sessionId,
			};
			const selections = batchRegistry.getCanonicalModelSelections(options);
			const records = perRecordRegistry.getCanonicalModels(options);

			expect(selections.length).toBe(records.length);
			expect(selections.length).toBeGreaterThan(0);
			for (let index = 0; index < records.length; index += 1) {
				const resolved = perRecordRegistry.resolveCanonicalModel(records[index]!.id, options);
				// Cross-registry comparison: assert the winning model (provider/id),
				// not object identity — policy-applied models are distinct
				// instances per registry even when structurally identical.
				expect(selections[index]!.model?.provider).toBe(resolved?.provider);
				expect(selections[index]!.model?.id).toBe(resolved?.id);
			}
			if (scenario.sessionId !== undefined) {
				expect(batchRegistry.getSessionCanonicalVariant("batch-parity-session")).toBe(
					perRecordRegistry.getSessionCanonicalVariant("batch-parity-session"),
				);
			}
		}
		test("getCanonicalModelSelections matches per-record resolution with full availability", () => {
			assertBatchMatchesPerRecord({ availableOnly: false, sessionId: undefined });
		});
		test("getCanonicalModelSelections matches per-record resolution with availability filtering", () => {
			assertBatchMatchesPerRecord({ availableOnly: true, sessionId: undefined });
		});
		test("getCanonicalModelSelections matches per-record resolution with a whitespace session id", () => {
			assertBatchMatchesPerRecord({ availableOnly: false, sessionId: "  batch-parity-session  " });
		});
		test("getCanonicalModelSelections matches per-record resolution with availability and session id", () => {
			assertBatchMatchesPerRecord({ availableOnly: true, sessionId: "  batch-parity-session  " });
		});
		test("normalizes sticky session IDs when recording canonical variants", () => {
			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const resolved = registry.resolveCanonicalModel("claude-sonnet-4-5", {
				availableOnly: false,
				candidates: registry.getAll(),
				sessionId: "  sticky-session  ",
			});

			expect(resolved).toBeDefined();
			expect(registry.getSessionCanonicalVariant("sticky-session")).toBe(`${resolved!.provider}/${resolved!.id}`);
			expect(registry.clearCanonicalVariant("sticky-session")).toBe(true);
		});
		test("restores case-variant sticky selectors using canonical catalog spelling", () => {
			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const variant = registry.getCanonicalVariants("claude-sonnet-4-5")[0]!;

			expect(registry.restoreSessionCanonicalVariant("sticky-session", variant.selector.toUpperCase())).toBe(true);
			expect(registry.getSessionCanonicalVariant("sticky-session")).toBe(variant.selector);
			expect(
				registry.resolveCanonicalModel("claude-sonnet-4-5", {
					availableOnly: false,
					candidates: registry.getAll(),
					sessionId: "sticky-session",
				}),
			).toBe(variant.model);
		});
		test("seeds isolated child canonical scopes from a concrete parent model", async () => {
			const alpha = providerConfig("https://alpha.example.com/v1", [{ id: "anthropic/claude-sonnet-4.5" }]);
			const beta = providerConfig("https://beta.example.com/v1", [{ id: "anthropic/claude-sonnet-4.5" }]);
			writeRawModelsJson({ alpha, beta });
			const parentRegistry = new ModelRegistry(authStorage, modelsJsonPath);
			const parentModel = parentRegistry.find("alpha", "anthropic/claude-sonnet-4.5");
			expect(parentModel).toBeDefined();
			const parentActiveModelPattern = `${parentModel!.provider}/${parentModel!.id}`;

			// A fresh registry has no in-memory parent session stickiness, but its
			// persisted concrete active model still seeds the child scope.
			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const alphaModel = registry.find("alpha", "anthropic/claude-sonnet-4.5")!;
			const betaModel = registry.find("beta", "anthropic/claude-sonnet-4.5")!;
			const fixtureModels = () => fixtureCandidates(registry);
			const childA = "subagent:parent-session:child-a";
			const childB = "subagent:parent-session:child-b";
			const lookup: ModelLookupRegistry & Pick<ModelRegistry, "getApiKey"> = {
				// Pin availability to fixture providers so ambient host credentials
				// (e.g. OpenGateway) cannot change canonical resolution in this test.
				getAvailable: () => fixtureModels(),
				resolveCanonicalModel: registry.resolveCanonicalModel.bind(registry),
				seedCanonicalVariant: registry.seedCanonicalVariant.bind(registry),
				getApiKey: async model => (model.provider === "alpha" ? "test-key" : undefined),
			};
			const resumed = await resolveModelOverrideWithAuthFallback(
				["claude-sonnet-4-5"],
				parentActiveModelPattern,
				lookup,
				undefined,
				"parent-session",
				undefined,
				childA,
			);
			expect(resumed.model).toBe(alphaModel);
			// The child-first canonical lookup must not populate the parent scope;
			// with no sticky parent entry, deterministic catalog order picks alpha.
			expect(
				registry.resolveCanonicalModel("claude-sonnet-4-5", {
					availableOnly: true,
					candidates: [...fixtureModels()].reverse(),
					sessionId: "parent-session",
				}),
			).toBe(alphaModel);
			expect(registry.seedCanonicalVariant(childB, betaModel)).toBe(true);
			expect(
				registry.resolveCanonicalModel("claude-sonnet-4-5", {
					availableOnly: true,
					candidates: fixtureModels(),
					sessionId: childB,
				}),
			).toBe(betaModel);
			// Repeated attempts for a child retain its own seeded variant.
			expect(
				registry.resolveCanonicalModel("claude-sonnet-4-5", {
					availableOnly: true,
					candidates: [...fixtureModels()].reverse(),
					sessionId: childA,
				}),
			).toBe(alphaModel);

			const explicit = resolveModelOverride(["beta/anthropic/claude-sonnet-4.5"], registry, undefined, childA);
			expect(explicit.model).toBe(betaModel);
			const fallback = await resolveModelOverrideWithAuthFallback(
				["beta/anthropic/claude-sonnet-4.5"],
				parentActiveModelPattern,
				lookup,
				undefined,
				"parent-session",
				undefined,
				childA,
			);
			expect(fallback.model).toBe(alphaModel);
			expect(fallback.authFallbackUsed).toBe(true);
		});
	});

	/** Hermetic candidate set for fixture providers only (excludes ambient host providers). */
	function fixtureCandidates(registry: ModelRegistry, providers: readonly string[], modelId: string): Model<Api>[] {
		return providers
			.map(provider => registry.find(provider, modelId))
			.filter((model): model is NonNullable<typeof model> => model !== undefined);
	}

	describe("provider selection policy and alias resolution", () => {
		test("dedupes explicit provider order and assigns disjoint rank bands", () => {
			const policy = createProviderSelectionPolicy({
				explicitProviderOrder: ["Alpha", "alpha", " beta ", ""],
				effectiveAuth: new Map([
					["beta", "oauth"],
					["gamma", "oauth"],
					["delta", "key"],
					["epsilon", "keyless"],
				]),
				catalogProviders: ["alpha", "beta", "gamma", "delta", "epsilon"],
				catalogModels: [],
			});

			expect(policy.explicitProviders()).toEqual(["alpha", "beta"]);
			expect(policy.rank("alpha")).toBe(0);
			expect(policy.rank("beta")).toBe(1);
			// Omitted effective-OAuth providers share rank n.
			expect(policy.rank("gamma")).toBe(2);
			// Omitted non-OAuth/unknown/keyless providers share rank n+1.
			expect(policy.rank("delta")).toBe(3);
			expect(policy.rank("epsilon")).toBe(3);
			expect(policy.rank("unknown-provider")).toBe(3);
			expect(policy.isExplicit("ALPHA")).toBe(true);
			expect(policy.isExplicit("gamma")).toBe(false);
		});

		test("ordered providers follow explicit order then catalog order", () => {
			const policy = createProviderSelectionPolicy({
				explicitProviderOrder: ["beta"],
				effectiveAuth: new Map(),
				catalogProviders: ["alpha", "beta", "gamma"],
				catalogModels: [],
			});

			expect(policy.orderedProviders()).toEqual(["beta", "alpha", "gamma"]);
			expect(policy.providerCatalogIndex("alpha")).toBe(0);
			expect(policy.providerCatalogIndex("gamma")).toBe(2);
			expect(policy.providerCatalogIndex("zeta")).toBe(Number.MAX_SAFE_INTEGER);
		});

		test("automatic provider order keeps explicit priority ahead of OAuth bands", async () => {
			await authStorage.set("anthropic", [
				{
					type: "oauth",
					access: "anthropic-policy-access",
					refresh: "anthropic-policy-refresh",
					expires: Date.now() + 60 * 60_000,
					email: "anthropic-policy@example.test",
				},
			]);
			authStorage.setRuntimeApiKey("amazon-bedrock", "bedrock-policy-key");
			const registrySettings = Settings.isolated();
			const registry = new ModelRegistry(authStorage, modelsJsonPath, registrySettings, { automaticRefresh: false });
			try {
				const explicitOrder = registry.automaticProviderOrder();
				expect(explicitOrder.indexOf("anthropic")).toBeLessThan(explicitOrder.indexOf("amazon-bedrock"));

				registrySettings.set("modelProviderOrder", ["amazon-bedrock"]);
				const configuredOrder = registry.automaticProviderOrder();
				expect(configuredOrder.indexOf("amazon-bedrock")).toBeLessThan(configuredOrder.indexOf("anthropic"));
			} finally {
				await registry.dispose();
			}
		});

		test("builds stable catalog tie data from registry model order", () => {
			const makeCatalogModel = (provider: string, id: string): Model<Api> =>
				({
					id,
					name: id,
					api: "anthropic-messages",
					provider,
					baseUrl: `https://${provider}.example.com/v1`,
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 128000,
					maxTokens: 8192,
				}) as Model<Api>;

			const { catalogProviders, catalogModels } = buildProviderSelectionCatalog([
				makeCatalogModel("alpha", "m1"),
				makeCatalogModel("beta", "m2"),
				makeCatalogModel("alpha", "m3"),
			]);

			expect(catalogProviders).toEqual(["alpha", "beta"]);
			expect(catalogModels).toEqual(["alpha/m1", "beta/m2", "alpha/m3"]);
		});

		test("resolves final-slash-segment aliases through canonical records", () => {
			writeRawModelsJson({
				demo: providerConfig("https://demo.example.com/v1", [{ id: "anthropic/claude-sonnet-4.5" }]),
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			// Pin candidates to the demo fixture plus the bundled anthropic exact-id
			// variant (hermetic pattern from #3207) so ambient host credentials (e.g.
			// GH_TOKEN/GITHUB_TOKEN enabling other bundled providers) cannot change
			// alias or canonical resolution in this test.
			const demoVariants = fixtureCandidates(registry, ["demo"], "anthropic/claude-sonnet-4.5");
			const candidates = [...demoVariants, ...fixtureCandidates(registry, ["anthropic"], "claude-sonnet-4-5")];
			const resolved = registry.resolveModelByLookupAlias("claude-sonnet-4.5", {
				availableOnly: false,
				candidates,
			});

			expect(resolved?.provider).toBe("demo");
			expect(resolved?.id).toBe("anthropic/claude-sonnet-4.5");
			expect(registry.lookupAliasExists("claude-sonnet-4.5")).toBe(true);
			// A concrete model whose final segment equals the canonical id may also
			// expose that spelling as an alias; exact canonical lookup still wins first.
			expect(registry.lookupAliasExists("claude-sonnet-4-5")).toBe(true);
			expect(registry.lookupAliasExists("unknown-alias")).toBe(false);
			// Exact canonical resolution stays exact-first and alias-unaware.
			expect(
				registry.resolveCanonicalModel("claude-sonnet-4-5", {
					availableOnly: false,
					candidates,
				}),
			).toMatchObject({ id: "claude-sonnet-4-5" });
			expect(
				registry.resolveCanonicalModel("claude-sonnet-4.5", {
					availableOnly: false,
					candidates,
				}),
			).toBeUndefined();
		});

		test("resolves aliases at arbitrary slash depth", () => {
			writeRawModelsJson({
				demo: providerConfig("https://demo.example.com/v1", [{ id: "org/team/project/deep-model" }]),
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const model = registry.resolveModelByLookupAlias("deep-model", {
				availableOnly: false,
				candidates: registry.getAll(),
			});

			expect(model?.provider).toBe("demo");
			expect(model?.id).toBe("org/team/project/deep-model");
		});

		test("includes runtime custom providers in provider-agnostic alias selection", async () => {
			await Settings.init({ inMemory: true });
			settings.set("modelProviderOrder", ["custom-open-model", "catalog-provider"]);
			writeRawModelsJson({
				"catalog-provider": providerConfig("https://catalog.example.com/v1", [{ id: "zai-org/GLM-5.2" }]),
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			registry.registerProvider("custom-open-model", {
				baseUrl: "https://custom.example.com/v1",
				apiKey: "CUSTOM_OPEN_MODEL_KEY",
				api: "openai-completions",
				models: [
					{
						id: "hosted/glm-5.2",
						name: "Custom GLM-5.2",
						reasoning: true,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 128000,
						maxTokens: 8192,
					},
				],
			});
			authStorage.setRuntimeApiKey("custom-open-model", "custom-key");

			const resolved = registry.resolveModelByLookupAlias("glm-5.2", {
				availableOnly: true,
				candidates: registry.getAvailable(),
			});
			expect(resolved).toMatchObject({ provider: "custom-open-model", id: "hosted/glm-5.2" });
		});

		test("preserves full model and wire ids when resolving via alias", () => {
			writeRawModelsJson({
				demo: {
					baseUrl: "https://demo.example.com/v1",
					apiKey: "TEST_KEY",
					api: "anthropic-messages",
					models: [
						{
							id: "anthropic/claude-sonnet-4.5",
							name: "Sonnet via demo",
							wireModelId: "wire-sonnet-4.5",
							reasoning: true,
							input: ["text", "image"],
							cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 },
							contextWindow: 200000,
							maxTokens: 16000,
						},
					],
				},
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			// Pin candidates to the demo fixture (hermetic pattern from #3207): the
			// fixture's inline wire id must survive alias resolution regardless of
			// ambient host credentials enabling other bundled providers.
			const resolved = registry.resolveModelByLookupAlias("claude-sonnet-4.5", {
				availableOnly: false,
				candidates: fixtureCandidates(registry, ["demo"], "anthropic/claude-sonnet-4.5"),
			});

			expect(resolved?.provider).toBe("demo");
			expect(resolved?.id).toBe("anthropic/claude-sonnet-4.5");
			expect(resolved?.wireModelId).toBe("wire-sonnet-4.5");
			expect(resolved?.name).toBe("Sonnet via demo");
		});

		test("fails closed for known aliases with no eligible variants", async () => {
			writeRawModelsJson({
				demo: {
					baseUrl: "https://demo.example.com/v1",
					api: "anthropic-messages",
					apiKeyEnv: "GJC_TEST_MISSING_ALIAS_AUTH_KEY",
					models: [{ id: "anthropic/claude-sonnet-4.5" }],
				},
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			// Pin candidates to the demo fixture (hermetic pattern from #3207): the
			// alias must fail closed because the only fixture variant is
			// credential-less, regardless of ambient host credentials enabling other
			// bundled providers' claude-sonnet-4.5 variants.
			const fixtureModel = registry.find("demo", "anthropic/claude-sonnet-4.5")!;
			expect(registry.lookupAliasExists("claude-sonnet-4.5")).toBe(true);
			// Canonical-id access stays alias-unaware.
			expect(registry.getCanonicalVariants("claude-sonnet-4.5")).toEqual([]);
			expect(
				registry.resolveModelByLookupAlias("claude-sonnet-4.5", {
					availableOnly: true,
					candidates: [fixtureModel],
				}),
			).toBeUndefined();
			expect(
				registry.resolveModelByLookupAlias("claude-sonnet-4.5", {
					availableOnly: false,
					candidates: [fixtureModel],
				}),
			).toBeUndefined();
		});

		test("intersects alias variants with filtered supplied candidates", () => {
			writeRawModelsJson({
				alpha: providerConfig("https://alpha.example.com/v1", [{ id: "anthropic/claude-sonnet-4.5" }]),
				beta: {
					baseUrl: "https://beta.example.com/v1",
					api: "anthropic-messages",
					apiKeyEnv: "GJC_TEST_MISSING_ALIAS_BETA_KEY",
					models: [{ id: "anthropic/claude-sonnet-4.5" }],
				},
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const alphaModel = registry.find("alpha", "anthropic/claude-sonnet-4.5")!;
			const betaModel = registry.find("beta", "anthropic/claude-sonnet-4.5")!;

			// Both candidates supplied, but beta is not available → alpha wins.
			expect(
				registry.resolveModelByLookupAlias("claude-sonnet-4.5", {
					availableOnly: false,
					candidates: [betaModel, alphaModel],
				}),
			).toBe(alphaModel);
			// Supplied candidates that only reference the unavailable variant fail closed.
			expect(
				registry.resolveModelByLookupAlias("claude-sonnet-4.5", {
					availableOnly: false,
					candidates: [betaModel],
				}),
			).toBeUndefined();
		});

		test("ranks explicit, omitted-OAuth, and omitted non-OAuth providers disjointly", async () => {
			await Settings.init({ inMemory: true });
			settings.set("modelProviderOrder", ["alpha"]);
			writeRawModelsJson({
				gamma: providerConfig("https://gamma.example.com/v1", [{ id: "anthropic/claude-sonnet-4.5" }]),
				beta: {
					baseUrl: "https://beta.example.com/v1",
					api: "anthropic-messages",
					apiKeyEnv: "GJC_TEST_MISSING_ALIAS_BETA_KEY",
					models: [{ id: "anthropic/claude-sonnet-4.5" }],
				},
				alpha: providerConfig("https://alpha.example.com/v1", [{ id: "anthropic/claude-sonnet-4.5" }]),
			});
			await authStorage.set("beta", [
				{
					type: "oauth",
					access: "beta-oauth-access",
					refresh: "beta-oauth-refresh",
					expires: Date.now() + 60_000,
					email: "beta@example.com",
				},
			]);

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const gammaModel = registry.find("gamma", "anthropic/claude-sonnet-4.5")!;
			const betaModel = registry.find("beta", "anthropic/claude-sonnet-4.5")!;
			const alphaModel = registry.find("alpha", "anthropic/claude-sonnet-4.5")!;

			expect(registry.getEffectiveProviderAuth("alpha")).toBe("key");
			expect(registry.getEffectiveProviderAuth("beta")).toBe("oauth");
			expect(registry.getEffectiveProviderAuth("gamma")).toBe("key");

			// Catalog order is gamma, beta, alpha — the explicit provider still wins.
			expect(
				registry.resolveCanonicalModel("claude-sonnet-4-5", {
					availableOnly: true,
					candidates: [gammaModel, betaModel, alphaModel],
				})?.provider,
			).toBe("alpha");
			// Omitted effective-OAuth (beta) beats omitted non-OAuth (gamma).
			expect(
				registry.resolveModelByLookupAlias("claude-sonnet-4.5", {
					availableOnly: true,
					candidates: [gammaModel, betaModel],
				})?.provider,
			).toBe("beta");
			// Explicit providers stay ahead of both omitted bands.
			expect(
				registry.resolveModelByLookupAlias("claude-sonnet-4.5", {
					availableOnly: true,
					candidates: [betaModel, alphaModel],
				})?.provider,
			).toBe("alpha");

			vi.spyOn(authStorage, "getSessionCredentialType").mockReturnValue("oauth");
			expect(registry.getEffectiveProviderAuth("beta", "session-with-oauth")).toBe("oauth");
			authStorage.setRuntimeApiKey("beta", "runtime-beta-key");
			expect(registry.getEffectiveProviderAuth("beta", "session-with-oauth")).toBe("key");
			authStorage.removeRuntimeApiKey("beta");
			authStorage.setConfigApiKey("beta", "config-beta-key");
			expect(registry.getEffectiveProviderAuth("beta", "session-with-oauth")).toBe("key");
		});

		test("ranks colliding alias targets by provider order, not catalog first-wins", async () => {
			await Settings.init({ inMemory: true });
			settings.set("modelProviderOrder", ["beta", "alpha"]);
			writeRawModelsJson({
				alpha: providerConfig("https://alpha.example.com/v1", [{ id: "org/conflict-model" }]),
				beta: providerConfig("https://beta.example.com/v1", [{ id: "team/conflict-model" }]),
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const alphaModel = registry.find("alpha", "org/conflict-model")!;
			const betaModel = registry.find("beta", "team/conflict-model")!;

			expect(registry.lookupAliasExists("conflict-model")).toBe(true);
			// Catalog order is alpha-first, but the explicit provider order wins.
			expect(
				registry.resolveModelByLookupAlias("conflict-model", {
					availableOnly: true,
					candidates: [alphaModel, betaModel],
				}),
			).toBe(betaModel);
		});

		test("ranks colliding alias targets by OAuth provenance over non-OAuth", async () => {
			writeRawModelsJson({
				alpha: providerConfig("https://alpha.example.com/v1", [{ id: "org/conflict-model" }]),
				beta: {
					baseUrl: "https://beta.example.com/v1",
					api: "anthropic-messages",
					apiKeyEnv: "GJC_TEST_MISSING_ALIAS_BETA_KEY",
					models: [{ id: "team/conflict-model" }],
				},
			});
			await authStorage.set("beta", [
				{
					type: "oauth",
					access: "beta-oauth-access",
					refresh: "beta-oauth-refresh",
					expires: Date.now() + 60_000,
					email: "beta@example.com",
				},
			]);

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const alphaModel = registry.find("alpha", "org/conflict-model")!;
			const betaModel = registry.find("beta", "team/conflict-model")!;

			expect(registry.getEffectiveProviderAuth("alpha")).toBe("key");
			expect(registry.getEffectiveProviderAuth("beta")).toBe("oauth");
			// Catalog order is alpha-first; the omitted-OAuth band still outranks
			// the omitted non-OAuth band for the colliding alias.
			expect(
				registry.resolveModelByLookupAlias("conflict-model", {
					availableOnly: true,
					candidates: [alphaModel, betaModel],
				}),
			).toBe(betaModel);
		});

		test("session-selected OAuth and API-key provenance change a mixed provider's alias rank", async () => {
			writeRawModelsJson({
				alpha: providerConfig("https://alpha.example.com/v1", [{ id: "org/conflict-model" }]),
				beta: {
					baseUrl: "https://beta.example.com/v1",
					api: "anthropic-messages",
					apiKeyEnv: "GJC_TEST_MISSING_ALIAS_BETA_KEY",
					models: [{ id: "team/conflict-model" }],
				},
			});
			await authStorage.set("beta", [
				{ type: "api_key", key: "stored-beta-key" },
				{
					type: "oauth",
					access: "beta-oauth-access",
					refresh: "beta-oauth-refresh",
					expires: Date.now() + 120_000,
					email: "beta@example.com",
				},
			]);

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const alphaModel = registry.find("alpha", "org/conflict-model")!;
			const betaModel = registry.find("beta", "team/conflict-model")!;

			// Surface-derived: beta has a stored manual key alongside OAuth, so
			// the API-key surface wins — beta's omitted non-OAuth band collides
			// with alpha's and catalog order (alpha first) decides.
			expect(registry.getEffectiveProviderAuth("beta")).toBe("key");
			expect(
				registry.resolveModelByLookupAlias("conflict-model", {
					availableOnly: true,
					candidates: [alphaModel, betaModel],
				}),
			).toBe(alphaModel);

			// A session that explicitly selected beta's OAuth credential moves
			// beta into the OAuth band ahead of alpha.
			await registry.getApiKey(betaModel, "oauth-session", {
				credentialSelector: { kind: "email", value: "beta@example.com" },
			});
			expect(authStorage.getSessionCredentialType("beta", "oauth-session")).toBe("oauth");
			expect(registry.getEffectiveProviderAuth("beta", "oauth-session")).toBe("oauth");
			expect(
				registry.resolveModelByLookupAlias("conflict-model", {
					availableOnly: true,
					candidates: [alphaModel, betaModel],
					sessionId: "oauth-session",
				}),
			).toBe(betaModel);

			expect(
				registry.resolveModelByLookupAlias("conflict-model", {
					availableOnly: true,
					candidates: [alphaModel, betaModel],
					sessionId: "logical-session",
					credentialSessionId: "oauth-session",
				}),
			).toBe(betaModel);
			// A session that authenticated with beta's manual key keeps beta in
			// the non-OAuth band; both collide at n+1 and catalog order (alpha
			// first) decides — session provenance changed the rank.
			await registry.getApiKey(betaModel, "key-session");
			expect(authStorage.getSessionCredentialType("beta", "key-session")).toBe("api_key");
			expect(registry.getEffectiveProviderAuth("beta", "key-session")).toBe("key");
			expect(
				registry.resolveModelByLookupAlias("conflict-model", {
					availableOnly: true,
					candidates: [alphaModel, betaModel],
					sessionId: "key-session",
				}),
			).toBe(alphaModel);
		});

		test("ranks a provider by OAuth after its stored command key resolves unusable", async () => {
			const restoreAnthropicKey = unsetEnvForTest("ANTHROPIC_API_KEY");
			try {
				authStorage.close();
				authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"), {
					configValueResolver: async () => undefined,
				});
				writeRawModelsJson({
					alpha: providerConfig("https://alpha.example.com/v1", [{ id: "org/conflict-model" }]),
					anthropic: {
						baseUrl: "https://api.anthropic.com",
						api: "anthropic-messages",
						apiKeyEnv: "ANTHROPIC_API_KEY",
						models: [{ id: "team/conflict-model" }],
					},
				});
				await authStorage.set("anthropic", [
					{ type: "api_key", key: "!missing-anthropic-key" },
					{
						type: "oauth",
						access: "anthropic-oauth-access",
						refresh: "anthropic-oauth-refresh",
						expires: Date.now() + 60 * 60_000,
					},
				]);

				const registry = new ModelRegistry(authStorage, modelsJsonPath);
				const alphaModel = registry.find("alpha", "org/conflict-model")!;
				const anthropicModel = registry.find("anthropic", "team/conflict-model")!;

				await expect(registry.getApiKeyForProvider("anthropic")).resolves.toBe("anthropic-oauth-access");
				expect(registry.getEffectiveProviderAuth("anthropic")).toBe("oauth");
				expect(
					registry.resolveModelByLookupAlias("conflict-model", {
						availableOnly: true,
						candidates: [alphaModel, anthropicModel],
					}),
				).toBe(anthropicModel);
			} finally {
				restoreAnthropicKey();
			}
		});

		test("ranks expired OAuth ahead of an environment key because requests refresh OAuth first", async () => {
			// Pin the anthropic env surface before writing the fixture value: the
			// credential env resolver prefers an ambient ANTHROPIC_OAUTH_TOKEN from
			// the launching shell over any in-process ANTHROPIC_API_KEY write, so
			// unset it to keep the fixture key the effective environment key.
			const restoreAnthropicOAuthToken = unsetEnvForTest("ANTHROPIC_OAUTH_TOKEN");
			const restoreAnthropicKey = setEnvForTest("ANTHROPIC_API_KEY", "environment-anthropic-key");
			try {
				await authStorage.set("anthropic", [
					{
						type: "oauth",
						access: "expired-oauth-access",
						refresh: "expired-oauth-refresh",
						expires: Date.now() - 1,
					},
				]);
				const registry = new ModelRegistry(authStorage, modelsJsonPath);

				await expect(authStorage.peekApiKey("anthropic")).resolves.toBe("environment-anthropic-key");
				expect(registry.getEffectiveProviderAuth("anthropic")).toBe("oauth");
			} finally {
				restoreAnthropicKey();
				restoreAnthropicOAuthToken();
			}
		});
		test("ranks a mixed manual+OAuth provider in the non-OAuth band by default", async () => {
			writeRawModelsJson({
				manualOnly: providerConfig("https://manual.example.com/v1", [{ id: "org/conflict-model" }]),
				mixed: providerConfig("https://mixed.example.com/v1", [{ id: "team/conflict-model" }]),
				oauthOnly: {
					baseUrl: "https://oauth.example.com/v1",
					api: "anthropic-messages",
					apiKeyEnv: "GJC_TEST_MISSING_ALIAS_OAUTH_KEY",
					models: [{ id: "other/conflict-model" }],
				},
			});
			await authStorage.set("mixed", [
				{ type: "api_key", key: "stored-mixed-key" },
				{
					type: "oauth",
					access: "mixed-oauth-access",
					refresh: "mixed-oauth-refresh",
					expires: Date.now() + 60_000,
					email: "mixed@example.com",
				},
			]);
			await authStorage.set("oauthOnly", [
				{
					type: "oauth",
					access: "oauth-only-access",
					refresh: "oauth-only-refresh",
					expires: Date.now() + 60_000,
					email: "oauth@example.com",
				},
			]);

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const manualModel = registry.find("manualOnly", "org/conflict-model")!;
			const mixedModel = registry.find("mixed", "team/conflict-model")!;
			const oauthModel = registry.find("oauthOnly", "other/conflict-model")!;

			// The mixed provider has a manual key (models.yml apiKey) AND stored
			// OAuth — the API-key surface wins by default.
			expect(registry.getEffectiveProviderAuth("manualOnly")).toBe("key");
			expect(registry.getEffectiveProviderAuth("mixed")).toBe("key");
			expect(registry.getEffectiveProviderAuth("oauthOnly")).toBe("oauth");

			// The OAuth-only provider still outranks both key providers, and the
			// mixed provider does NOT jump into the OAuth band.
			expect(
				registry.resolveModelByLookupAlias("conflict-model", {
					availableOnly: true,
					candidates: [manualModel, mixedModel, oauthModel],
				}),
			).toBe(oauthModel);

			// Without the OAuth-only candidate the manual and mixed providers
			// collide in the non-OAuth band; catalog order (manualOnly first)
			// decides the tie.
			expect(
				registry.resolveModelByLookupAlias("conflict-model", {
					availableOnly: true,
					candidates: [mixedModel, manualModel],
				}),
			).toBe(manualModel);
		});

		test("keeps key-shaped OAuth access tokens OAuth for glm-zcode/kimi-code presets versus manual keys", async () => {
			writeRawModelsJson({
				manualGlm: providerConfig("https://manual.example.com/v1", [{ id: "glm-zcode" }]),
				manualKimi: providerConfig("https://manual-kimi.example.com/v1", [{ id: "kimi-code" }]),
				zhipu: {
					baseUrl: "https://zhipu.example.com/v1",
					api: "anthropic-messages",
					apiKeyEnv: "GJC_TEST_MISSING_GLM_ZCODE_KEY",
					models: [{ id: "zai/glm-zcode" }],
				},
				moonshot: {
					baseUrl: "https://moonshot.example.com/v1",
					api: "anthropic-messages",
					apiKeyEnv: "GJC_TEST_MISSING_KIMI_CODE_KEY",
					models: [{ id: "moonshot/kimi-code" }],
				},
			});
			await authStorage.set("zhipu", [
				{
					type: "oauth",
					access: "glm-zcode",
					refresh: "zhipu-oauth-refresh",
					expires: Date.now() + 120_000,
					email: "zhipu@example.com",
				},
			]);
			await authStorage.set("moonshot", [
				{
					type: "oauth",
					access: "kimi-code",
					refresh: "moonshot-oauth-refresh",
					expires: Date.now() + 120_000,
					email: "moonshot@example.com",
				},
			]);

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const manualGlm = registry.find("manualGlm", "glm-zcode")!;
			const zhipuGlm = registry.find("zhipu", "zai/glm-zcode")!;
			const manualKimi = registry.find("manualKimi", "kimi-code")!;
			const moonshotKimi = registry.find("moonshot", "moonshot/kimi-code")!;

			// OAuth access strings that look like bare model ids stay OAuth —
			// provenance comes from the credential type, never token shape.
			expect(registry.getEffectiveProviderAuth("zhipu")).toBe("oauth");
			expect(registry.getEffectiveProviderAuth("moonshot")).toBe("oauth");
			expect(registry.getEffectiveProviderAuth("manualGlm")).toBe("key");
			expect(registry.getEffectiveProviderAuth("manualKimi")).toBe("key");

			// The OAuth provider outranks the manual-key provider for the shared
			// glm-zcode alias even though its model id is slash-prefixed.
			expect(
				registry.resolveModelByLookupAlias("glm-zcode", {
					availableOnly: true,
					candidates: [manualGlm, zhipuGlm],
				}),
			).toBe(zhipuGlm);

			// kimi-code likewise resolves from the OAuth-backed provider over the
			// manual-key provider.
			expect(
				registry.resolveModelByLookupAlias("kimi-code", {
					availableOnly: true,
					candidates: [manualKimi, moonshotKimi],
				}),
			).toBe(moonshotKimi);
		});

		test("resolves exact-id alias targets before slash-prefixed ids on ties", () => {
			writeRawModelsJson({
				prefixed: providerConfig("https://prefixed.example.com/v1", [{ id: "team/zebra-model" }]),
				exact: providerConfig("https://exact.example.com/v1", [{ id: "zebra-model" }]),
			});
			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const prefixedModel = registry.find("prefixed", "team/zebra-model")!;
			const exactModel = registry.find("exact", "zebra-model")!;

			// The prefixed and exact ids land in different canonical records, so
			// the shared-canonical-id exactness axis is inactive for this alias.
			expect(registry.getCanonicalId(prefixedModel)).toBe("team/zebra-model");
			expect(registry.getCanonicalId(exactModel)).toBe("zebra-model");

			// Same provider band (both manual keys), same source (override), same
			// cost — catalog order (prefixed first) would win without the alias
			// exactness axis, but `model.id === alias` beats the slash-prefixed id.
			expect(
				registry.resolveModelByLookupAlias("zebra-model", {
					availableOnly: true,
					candidates: [prefixedModel, exactModel],
				}),
			).toBe(exactModel);
		});
		test("resolves mixed-case exact-id alias targets case-insensitively", () => {
			writeRawModelsJson({
				shared: providerConfig("https://shared.example.com/v1", [
					{ id: "team/zebra-model" },
					{ id: "Zebra-Model" },
				]),
			});
			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const prefixedModel = registry.find("shared", "team/zebra-model")!;
			const exactModel = registry.find("shared", "Zebra-Model")!;

			// The alias key is normalized to lowercase ("zebra-model"), while the
			// exact model id carries mixed case ("Zebra-Model"). Alias exactness
			// must compare normalized ids case-insensitively so the mixed-case id
			// still beats the slash-prefixed id instead of tying on catalog order.
			expect(registry.lookupAliasExists("zebra-model")).toBe(true);
			expect(
				registry.resolveModelByLookupAlias("zebra-model", {
					availableOnly: true,
					candidates: [prefixedModel, exactModel],
				}),
			).toBe(exactModel);
		});

		test("keeps alias winners sticky across priority edits and reranks when the winner is unavailable", async () => {
			await Settings.init({ inMemory: true });
			const alpha = providerConfig("https://alpha.example.com/v1", [{ id: "anthropic/claude-sonnet-4.5" }]);
			const beta = providerConfig("https://beta.example.com/v1", [{ id: "anthropic/claude-sonnet-4.5" }]);
			writeRawModelsJson({ alpha, beta });
			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const alphaModel = registry.find("alpha", "anthropic/claude-sonnet-4.5")!;
			const betaModel = registry.find("beta", "anthropic/claude-sonnet-4.5")!;

			// Default resolution: catalog order picks alpha first.
			expect(
				registry.resolveModelByLookupAlias("claude-sonnet-4.5", {
					availableOnly: true,
					candidates: [alphaModel, betaModel],
					sessionId: "editor-session",
				}),
			).toBe(alphaModel);

			// The provider priority editor flips the order to beta-first.
			settings.set("modelProviderOrder", ["beta", "alpha"]);

			// The session's remembered winner stays sticky despite the priority
			// edit re-ranking beta first.
			expect(
				registry.resolveModelByLookupAlias("claude-sonnet-4.5", {
					availableOnly: true,
					candidates: [betaModel, alphaModel],
					sessionId: "editor-session",
				}),
			).toBe(alphaModel);

			// A fresh session honors the new priority.
			expect(
				registry.resolveModelByLookupAlias("claude-sonnet-4.5", {
					availableOnly: true,
					candidates: [betaModel, alphaModel],
					sessionId: "fresh-session",
				}),
			).toBe(betaModel);

			// The sticky winner becomes unavailable; the session re-ranks to the
			// new priority instead of staying pinned to an ineligible variant.
			settings.set("disabledProviders", ["alpha"]);
			expect(
				registry.resolveModelByLookupAlias("claude-sonnet-4.5", {
					availableOnly: true,
					candidates: [betaModel],
					sessionId: "editor-session",
				}),
			).toBe(betaModel);
		});

		test("alias A cannot select a sibling variant that only has alias B in the same record", () => {
			writeRawModelsJson({
				demo: providerConfig("https://demo.example.com/v1", [
					{ id: "anthropic/claude-sonnet-4.5" },
					{ id: "claude-sonnet-45" },
				]),
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const dotVariant = registry.find("demo", "anthropic/claude-sonnet-4.5")!;
			const compactVariant = registry.find("demo", "claude-sonnet-45")!;

			// Both variants live in the same canonical record with different
			// final segments.
			expect(
				registry.getCanonicalVariants("claude-sonnet-4-5", { candidates: [dotVariant, compactVariant] }),
			).toHaveLength(2);
			expect(registry.lookupAliasExists("claude-sonnet-4.5")).toBe(true);
			expect(registry.lookupAliasExists("claude-sonnet-45")).toBe(true);

			// Alias `claude-sonnet-4.5` resolves only the dotted variant. Candidates
			// are pinned to the demo fixture (hermetic pattern from #3207) so ambient
			// host credentials cannot inject sibling variants from other providers.
			expect(
				registry.resolveModelByLookupAlias("claude-sonnet-4.5", {
					availableOnly: true,
					candidates: [dotVariant, compactVariant],
				}),
			).toBe(dotVariant);
			// Alias `claude-sonnet-45` resolves only the compact variant.
			expect(
				registry.resolveModelByLookupAlias("claude-sonnet-45", {
					availableOnly: true,
					candidates: [dotVariant, compactVariant],
				}),
			).toBe(compactVariant);
			// Supplying only the compact variant cannot satisfy the dotted alias.
			expect(
				registry.resolveModelByLookupAlias("claude-sonnet-4.5", {
					availableOnly: true,
					candidates: [compactVariant],
				}),
			).toBeUndefined();
		});

		test("derives effective credential provenance from session and credential surfaces", async () => {
			const restoreAnthropicToken = unsetEnvForTest("ANTHROPIC_OAUTH_TOKEN");
			const restoreAnthropicKey = unsetEnvForTest("ANTHROPIC_API_KEY");
			try {
				await authStorage.set("anthropic", [
					{ type: "api_key", key: "stored-anthropic-key" },
					{
						type: "oauth",
						access: "stored-anthropic-oauth",
						refresh: "stored-anthropic-refresh",
						expires: Date.now() + 60_000,
						email: "anthropic@example.com",
					},
				]);
				await authStorage.set("github-copilot", [
					{
						type: "oauth",
						access: "ghu_key_like_access",
						refresh: "ghu_key_like_refresh",
						expires: Date.now() + 60_000,
					},
				]);
				writeRawModelsJson({
					manual: providerConfig("https://manual.example.com/v1", [{ id: "manual-model" }]),
					keyless: {
						baseUrl: "http://127.0.0.1:1234/v1",
						api: "openai-completions",
						auth: "none",
						models: [{ id: "keyless-model" }],
					},
				});

				const registry = new ModelRegistry(authStorage, modelsJsonPath);

				expect(registry.getEffectiveProviderAuth("manual")).toBe("key");
				expect(registry.getEffectiveProviderAuth("keyless")).toBe("keyless");
				expect(registry.getEffectiveProviderAuth("no-such-provider")).toBe("unknown");
				// OAuth-provisioned key-like tokens stay OAuth — no token-shape sniffing.
				expect(registry.getEffectiveProviderAuth("github-copilot")).toBe("oauth");
				// A stored manual key wins over OAuth presence: a provider with
				// both an API key and OAuth is "key" unless a session selected OAuth.
				expect(registry.getEffectiveProviderAuth("anthropic")).toBe("key");

				const model = registry.find("anthropic", "claude-sonnet-4-5");
				expect(model).toBeDefined();
				await registry.getApiKey(model!, "session-a");
				expect(authStorage.getSessionCredentialType("anthropic", "session-a")).toBe("api_key");
				// Session-specific provenance agrees with the surface-derived
				// answer for a mixed provider: both are key.
				expect(registry.getEffectiveProviderAuth("anthropic", "session-a")).toBe("key");
				expect(registry.getEffectiveProviderAuth("anthropic")).toBe("key");
			} finally {
				restoreAnthropicKey();
				restoreAnthropicToken();
			}
		});

		test("resolves deterministically from registry catalog order regardless of candidate order", () => {
			writeRawModelsJson({
				alpha: providerConfig("https://alpha.example.com/v1", [{ id: "anthropic/claude-sonnet-4.5" }]),
				beta: providerConfig("https://beta.example.com/v1", [{ id: "anthropic/claude-sonnet-4.5" }]),
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const candidates = () =>
				["alpha", "beta"]
					.map(provider => registry.find(provider, "anthropic/claude-sonnet-4.5"))
					.filter((model): model is Model<Api> => model !== undefined);
			const forward = registry.resolveCanonicalModel("claude-sonnet-4-5", {
				availableOnly: true,
				candidates: candidates(),
			});
			const reversed = registry.resolveCanonicalModel("claude-sonnet-4-5", {
				availableOnly: true,
				candidates: [...candidates()].reverse(),
			});

			expect(forward?.provider).toBe("alpha");
			expect(reversed).toBe(forward);
		});

		test("keeps alias winners sticky per session and clears on explicit reselection", () => {
			writeRawModelsJson({
				alpha: providerConfig("https://alpha.example.com/v1", [{ id: "anthropic/claude-sonnet-4.5" }]),
				beta: providerConfig("https://beta.example.com/v1", [{ id: "anthropic/claude-sonnet-4.5" }]),
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const alphaModel = registry.find("alpha", "anthropic/claude-sonnet-4.5")!;
			const betaModel = registry.find("beta", "anthropic/claude-sonnet-4.5")!;
			// Seed a non-catalog winner so stickiness is observable.
			expect(registry.seedCanonicalVariant("alias-session", betaModel)).toBe(true);
			expect(
				registry.resolveModelByLookupAlias("claude-sonnet-4.5", {
					availableOnly: true,
					candidates: [alphaModel, betaModel],
					sessionId: "alias-session",
				}),
			).toBe(betaModel);
			// Reordered candidates keep the remembered winner.
			expect(
				registry.resolveModelByLookupAlias("claude-sonnet-4.5", {
					availableOnly: true,
					candidates: [betaModel, alphaModel],
					sessionId: "alias-session",
				}),
			).toBe(betaModel);
			// Explicit reselection clears the sticky winner.
			expect(registry.clearCanonicalVariant("alias-session")).toBe(true);
			expect(
				registry.resolveModelByLookupAlias("claude-sonnet-4.5", {
					availableOnly: true,
					candidates: [betaModel, alphaModel],
					sessionId: "alias-session",
				}),
			).toBe(alphaModel);
			expect(registry.clearCanonicalVariant("alias-session")).toBe(true);
		});
	});
	describe("OpenRouter routed suffix fallback", () => {
		test("find synthesizes a routed model id from the base OpenRouter metadata", () => {
			writeRawModelsJson({
				openrouter: providerConfig("https://openrouter.ai/api/v1", [{ id: "z-ai/glm-4.7" }]),
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const model = registry.find("openrouter", "z-ai/glm-4.7-20251222:nitro");

			expect(model?.provider).toBe("openrouter");
			expect(model?.id).toBe("z-ai/glm-4.7-20251222:nitro");
			expect(model?.name).toBe("z-ai/glm-4.7-20251222:nitro");
		});
	});

	describe("baseUrl override (no custom models)", () => {
		test("overriding baseUrl keeps all built-in models", () => {
			writeRawModelsJson({
				anthropic: overrideConfig("https://my-proxy.example.com/v1"),
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const anthropicModels = getModelsForProvider(registry, "anthropic");

			// Should have multiple built-in models, not just one
			expect(anthropicModels.length).toBeGreaterThan(1);
			expect(anthropicModels.some(m => m.id.includes("claude"))).toBe(true);
		});

		test("overriding baseUrl changes URL on all built-in models", () => {
			writeRawModelsJson({
				anthropic: overrideConfig("https://my-proxy.example.com/v1"),
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const anthropicModels = getModelsForProvider(registry, "anthropic");

			// All models should have the new baseUrl
			for (const model of anthropicModels) {
				expect(model.baseUrl).toBe("https://my-proxy.example.com/v1");
			}
		});

		test("overriding headers merges with model headers", () => {
			writeRawModelsJson({
				anthropic: overrideConfig("https://my-proxy.example.com/v1", {
					"X-Custom-Header": "custom-value",
				}),
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const anthropicModels = getModelsForProvider(registry, "anthropic");

			for (const model of anthropicModels) {
				expect(model.headers?.["X-Custom-Header"]).toBe("custom-value");
			}
		});

		test("headers-only override applies to built-in models", () => {
			writeRawModelsJson({
				anthropic: {
					headers: { "X-Custom-Header": "custom-only" },
				},
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const anthropicModels = getModelsForProvider(registry, "anthropic");

			expect(anthropicModels.length).toBeGreaterThan(1);
			for (const model of anthropicModels) {
				expect(model.headers?.["X-Custom-Header"]).toBe("custom-only");
			}
		});

		test("authHeader override applies bearer auth to built-in models without custom models", () => {
			writeRawModelsJson({
				anthropic: {
					baseUrl: "https://anthropic-proxy.example.com/v1",
					apiKey: "issue-929-key",
					authHeader: true,
				},
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const anthropicModels = getModelsForProvider(registry, "anthropic");

			expect(anthropicModels.length).toBeGreaterThan(1);
			for (const model of anthropicModels) {
				expect(model.headers?.Authorization).toBe("Bearer issue-929-key");
			}
		});

		test("authHeader uses the already-resolved apiKeyEnv token exactly once", () => {
			const keyEnv = `GJC_TEST_AUTH_HEADER_KEY_${Snowflake.next()}`;
			const tokenEnv = `GJC_TEST_AUTH_HEADER_TOKEN_${Snowflake.next()}`;
			const restoreKey = setEnvForTest(keyEnv, tokenEnv);
			const restoreToken = setEnvForTest(tokenEnv, "resolved-token");
			try {
				writeRawModelsJson({
					anthropic: {
						baseUrl: "https://anthropic-proxy.example.com/v1",
						apiKey: tokenEnv,
						authHeader: true,
					},
				});

				const registry = new ModelRegistry(authStorage, modelsJsonPath);
				const anthropicModels = getModelsForProvider(registry, "anthropic");

				expect(anthropicModels.length).toBeGreaterThan(1);
				for (const model of anthropicModels) {
					expect(model.headers?.Authorization).toBe("Bearer resolved-token");
				}
			} finally {
				restoreToken();
				restoreKey();
			}
		});

		test("refreshes auth headers when an apiKeyEnv credential rotates", async () => {
			const keyEnv = `GJC_TEST_ROTATING_AUTH_HEADER_KEY_${Snowflake.next()}`;
			const restoreKey = setEnvForTest(keyEnv, "initial-rotating-key");
			try {
				writeRawModelsJson({
					anthropic: {
						baseUrl: "https://anthropic-proxy.example.com/v1",
						apiKeyEnv: keyEnv,
						authHeader: true,
					},
				});
				const registry = new ModelRegistry(authStorage, modelsJsonPath);
				expect(getModelsForProvider(registry, "anthropic")[0]?.headers?.Authorization).toBe(
					"Bearer initial-rotating-key",
				);
				Bun.env[keyEnv] = "rotated-key";
				await registry.getApiKeyForProvider("anthropic");
				expect(getModelsForProvider(registry, "anthropic")[0]?.headers?.Authorization).toBe("Bearer rotated-key");
			} finally {
				restoreKey();
			}
		});

		test("apiKey-only override supplies fallback auth for built-in models", async () => {
			const originalOpenAiKey = Bun.env.OPENAI_API_KEY;
			delete Bun.env.OPENAI_API_KEY;
			try {
				writeRawModelsJson({
					openai: {
						apiKey: "issue-typed-key",
					},
				});

				const registry = new ModelRegistry(authStorage, modelsJsonPath);
				const openaiModels = getModelsForProvider(registry, "openai");

				expect(openaiModels.length).toBeGreaterThan(0);
				await expect(registry.getApiKey(openaiModels[0])).resolves.toBe("issue-typed-key");
			} finally {
				if (originalOpenAiKey === undefined) delete Bun.env.OPENAI_API_KEY;
				else Bun.env.OPENAI_API_KEY = originalOpenAiKey;
			}
		});

		test("OPENAI_API_KEY supplies env auth for bundled OpenAI models only", async () => {
			const restoreOpenAiKey = setEnvForTest("OPENAI_API_KEY", "env-openai-key");
			const restoreCodexToken = unsetEnvForTest("OPENAI_CODEX_OAUTH_TOKEN");
			try {
				const expectedOpenAiKey = $credentialEnv("OPENAI_API_KEY");
				const expectedCodexToken = $credentialEnv("OPENAI_CODEX_OAUTH_TOKEN");
				const registry = new ModelRegistry(authStorage, modelsJsonPath);
				const openaiModels = getModelsForProvider(registry, "openai");
				const codexModels = getModelsForProvider(registry, "openai-codex");

				expect(openaiModels.length).toBeGreaterThan(0);
				expect(codexModels.length).toBeGreaterThan(0);
				expect(registry.getAvailable().some(model => model.provider === "openai")).toBe(true);
				expect(registry.getAvailable().some(model => model.provider === "openai-codex")).toBe(
					Boolean(expectedCodexToken),
				);
				await expect(registry.getApiKey(openaiModels[0])).resolves.toBe(expectedOpenAiKey);
				await expect(registry.getApiKey(codexModels[0])).resolves.toBe(expectedCodexToken);
			} finally {
				restoreCodexToken();
				restoreOpenAiKey();
			}
		});

		test("baseUrl-only override does not affect other providers", () => {
			writeRawModelsJson({
				anthropic: overrideConfig("https://my-proxy.example.com/v1"),
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const googleModels = getModelsForProvider(registry, "google");

			// Google models should still have their original baseUrl
			expect(googleModels.length).toBeGreaterThan(0);
			expect(googleModels[0].baseUrl).not.toBe("https://my-proxy.example.com/v1");
		});

		test("can mix baseUrl override and models merge", () => {
			writeRawModelsJson({
				// baseUrl-only for anthropic
				anthropic: overrideConfig("https://anthropic-proxy.example.com/v1"),
				// Add custom model for google (merged with built-ins)
				google: providerConfig(
					"https://google-proxy.example.com/v1",
					[{ id: "gemini-custom" }],
					"google-generative-ai",
				),
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);

			// Anthropic: multiple built-in models with new baseUrl
			const anthropicModels = getModelsForProvider(registry, "anthropic");
			expect(anthropicModels.length).toBeGreaterThan(1);
			expect(anthropicModels[0].baseUrl).toBe("https://anthropic-proxy.example.com/v1");

			// Google: built-ins plus custom model
			const googleModels = getModelsForProvider(registry, "google");
			expect(googleModels.length).toBeGreaterThan(1);
			expect(googleModels.some(m => m.id === "gemini-custom")).toBe(true);
		});

		test("refresh() picks up baseUrl override changes", async () => {
			writeRawModelsJson({
				anthropic: overrideConfig("https://first-proxy.example.com/v1"),
			});
			const registry = new ModelRegistry(authStorage, modelsJsonPath);

			expect(getModelsForProvider(registry, "anthropic")[0].baseUrl).toBe("https://first-proxy.example.com/v1");

			// Update and refresh
			writeRawModelsJson({
				anthropic: overrideConfig("https://second-proxy.example.com/v1"),
			});
			await registry.refresh("offline");

			expect(getModelsForProvider(registry, "anthropic")[0].baseUrl).toBe("https://second-proxy.example.com/v1");
		});
	});

	describe("provider compat overrides", () => {
		test("provider-level compat applies to built-in models", () => {
			writeRawModelsJson({
				openrouter: {
					compat: {
						supportsUsageInStreaming: false,
						supportsStrictMode: false,
						supportsMultipleSystemMessages: false,
						disableReasoningOnToolChoice: true,
						allowsSyntheticReasoningContentForToolCalls: false,
					},
				},
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const models = getModelsForProvider(registry, "openrouter");
			expect(models.length).toBeGreaterThan(0);
			for (const model of models) {
				expect(getOpenAICompat(model)?.supportsUsageInStreaming).toBe(false);
				expect(getOpenAICompat(model)?.supportsStrictMode).toBe(false);
				expect(getOpenAICompat(model)?.supportsMultipleSystemMessages).toBe(false);
				expect(getOpenAICompat(model)?.disableReasoningOnToolChoice).toBe(true);
				expect(getOpenAICompat(model)?.allowsSyntheticReasoningContentForToolCalls).toBe(false);
			}
		});
		test("provider-level responses affinity applies to bundled OpenAI models", async () => {
			writeRawModelsJson({
				openai: {
					baseUrl: "https://openai-relay.example.com/v1",
					api: "openai-responses",
					apiKey: "TEST_KEY",
					compat: { supportsResponsesSessionAffinity: true },
				},
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			expect(getOpenAICompat(registry.find("openai", "gpt-4o-mini"))?.supportsResponsesSessionAffinity).toBe(true);
			await registry.refresh("offline");
			expect(getOpenAICompat(registry.find("openai", "gpt-4o-mini"))?.supportsResponsesSessionAffinity).toBe(true);
		});

		test("provider-level compat applies to custom models", () => {
			writeRawModelsJson({
				demo: {
					baseUrl: "https://example.com/v1",
					apiKey: "DEMO_KEY",
					api: "openai-completions",
					compat: {
						supportsUsageInStreaming: false,
						maxTokensField: "max_tokens",
					},
					models: [
						{
							id: "demo-model",
							reasoning: false,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 1000,
							maxTokens: 100,
						},
					],
				},
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const model = registry.find("demo", "demo-model");
			const compat = getOpenAICompat(model);
			expect(compat?.supportsUsageInStreaming).toBe(false);
			expect(compat?.maxTokensField).toBe("max_tokens");
		});

		test("model-level compat overrides provider-level compat for custom models", () => {
			writeRawModelsJson({
				demo: {
					baseUrl: "https://example.com/v1",
					apiKey: "DEMO_KEY",
					api: "openai-completions",
					compat: {
						supportsUsageInStreaming: false,
						maxTokensField: "max_tokens",
					},
					models: [
						{
							id: "demo-model",
							reasoning: false,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 1000,
							maxTokens: 100,
							compat: {
								supportsUsageInStreaming: true,
								maxTokensField: "max_completion_tokens",
							},
						},
					],
				},
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const model = registry.find("demo", "demo-model");
			const compat = getOpenAICompat(model);
			expect(compat?.supportsUsageInStreaming).toBe(true);
			expect(compat?.maxTokensField).toBe("max_completion_tokens");
		});
		test("model-level false overrides provider-level responses affinity", async () => {
			writeRawModelsJson({
				relay: {
					baseUrl: "https://relay.example.com/v1",
					apiKey: "TEST_KEY",
					api: "openai-responses",
					compat: { supportsResponsesSessionAffinity: true },
					models: [
						{
							id: "relay-model",
							reasoning: false,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 128000,
							maxTokens: 8192,
							compat: { supportsResponsesSessionAffinity: false },
						},
					],
				},
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			expect(getOpenAICompat(registry.find("relay", "relay-model"))?.supportsResponsesSessionAffinity).toBe(false);
			await registry.refresh("offline");
			expect(getOpenAICompat(registry.find("relay", "relay-model"))?.supportsResponsesSessionAffinity).toBe(false);
		});
	});

	describe("custom models merge behavior", () => {
		test("custom provider with same name as built-in merges with built-in models", () => {
			writeModelsJson({
				anthropic: providerConfig("https://my-proxy.example.com/v1", [{ id: "claude-custom" }]),
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const anthropicModels = getModelsForProvider(registry, "anthropic");

			// Built-in models still present, custom model merged in
			expect(anthropicModels.length).toBeGreaterThan(1);
			const custom = anthropicModels.find(m => m.id === "claude-custom");
			expect(custom).toBeDefined();
			expect(custom!.baseUrl).toBe("https://my-proxy.example.com/v1");
		});

		test("custom model with same id replaces built-in model by id", () => {
			writeModelsJson({
				openrouter: providerConfig(
					"https://my-proxy.example.com/v1",
					[{ id: "anthropic/claude-sonnet-4" }],
					"openai-completions",
				),
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const models = getModelsForProvider(registry, "openrouter");
			const sonnetModels = models.filter(m => m.id === "anthropic/claude-sonnet-4");

			expect(sonnetModels).toHaveLength(1);
			expect(sonnetModels[0].baseUrl).toBe("https://my-proxy.example.com/v1");
		});

		test("same-ID custom maxTokens remains authoritative after replacement", () => {
			writeRawModelsJson({
				openrouter: {
					baseUrl: "https://my-proxy.example.com/v1",
					apiKey: "TEST_KEY",
					api: "openai-completions",
					models: [{ id: "anthropic/claude-sonnet-4", maxTokens: 65_536 }],
				},
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const model = registry.find("openrouter", "anthropic/claude-sonnet-4");

			expect(model?.maxTokens).toBe(65_536);
			expect(model?.maxTokensSource).toBe("configured");
		});

		test("custom same-id replacement does not keep bundled headers", () => {
			writeRawModelsJson({
				"github-copilot": {
					baseUrl: "https://proxy.example.com/v1",
					headers: { "X-Proxy": "proxy" },
					apiKey: "TEST_KEY",
					api: "openai-completions",
					models: [{ id: "gpt-4o" }],
				},
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const model = registry.find("github-copilot", "gpt-4o");

			expect(model?.headers).toEqual({ "X-Proxy": "proxy" });
			expect(model?.headers?.["User-Agent"]).toBeUndefined();
			expect(model?.headers?.["Editor-Version"]).toBeUndefined();
		});

		test("custom provider with same name as built-in does not affect other built-in providers", () => {
			writeModelsJson({
				anthropic: providerConfig("https://my-proxy.example.com/v1", [{ id: "claude-custom" }]),
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);

			expect(getModelsForProvider(registry, "google").length).toBeGreaterThan(0);
			expect(getModelsForProvider(registry, "openai").length).toBeGreaterThan(0);
		});

		test("provider-level baseUrl applies to both built-in and custom models", () => {
			writeModelsJson({
				anthropic: providerConfig("https://merged-proxy.example.com/v1", [{ id: "claude-custom" }]),
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const anthropicModels = getModelsForProvider(registry, "anthropic");

			for (const model of anthropicModels) {
				expect(model.baseUrl).toBe("https://merged-proxy.example.com/v1");
			}
		});

		test("model-level baseUrl overrides provider-level baseUrl for custom models", () => {
			writeRawModelsJson({
				"opencode-go": {
					baseUrl: "https://opencode.ai/zen/go/v1",
					apiKey: "TEST_KEY",
					models: [
						{
							id: "minimax-m2.5",
							api: "anthropic-messages",
							baseUrl: "https://opencode.ai/zen/go",
							reasoning: true,
							input: ["text"],
							cost: { input: 0.3, output: 1.2, cacheRead: 0.03, cacheWrite: 0 },
							contextWindow: 204800,
							maxTokens: 131072,
						},
						{
							id: "glm-5",
							api: "openai-completions",
							reasoning: true,
							input: ["text"],
							cost: { input: 1, output: 3.2, cacheRead: 0.2, cacheWrite: 0 },
							contextWindow: 204800,
							maxTokens: 131072,
						},
					],
				},
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const m25 = registry.find("opencode-go", "minimax-m2.5");
			const glm5 = registry.find("opencode-go", "glm-5");

			expect(m25?.baseUrl).toBe("https://opencode.ai/zen/go");
			expect(glm5?.baseUrl).toBe("https://opencode.ai/zen/go/v1");
		});

		test("modelOverrides still apply when provider also defines models", () => {
			writeRawModelsJson({
				openrouter: {
					baseUrl: "https://my-proxy.example.com/v1",
					apiKey: "OPENROUTER_API_KEY",
					api: "openai-completions",
					models: [
						{
							id: "custom/openrouter-model",
							name: "Custom OpenRouter Model",
							reasoning: false,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 128000,
							maxTokens: 16384,
						},
					],
					modelOverrides: {
						"anthropic/claude-sonnet-4": {
							name: "Overridden Built-in Sonnet",
						},
					},
				},
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const models = getModelsForProvider(registry, "openrouter");

			expect(models.some(m => m.id === "custom/openrouter-model")).toBe(true);
			expect(models.some(m => m.id === "anthropic/claude-sonnet-4" && m.name === "Overridden Built-in Sonnet")).toBe(
				true,
			);
		});

		test("refresh() reloads merged custom models from disk", async () => {
			writeModelsJson({
				anthropic: providerConfig("https://first-proxy.example.com/v1", [{ id: "claude-custom" }]),
			});
			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			expect(getModelsForProvider(registry, "anthropic").some(m => m.id === "claude-custom")).toBe(true);

			// Update and refresh
			writeModelsJson({
				anthropic: providerConfig("https://second-proxy.example.com/v1", [{ id: "claude-custom-2" }]),
			});
			await registry.refresh("offline");

			const anthropicModels = getModelsForProvider(registry, "anthropic");
			expect(anthropicModels.some(m => m.id === "claude-custom")).toBe(false);
			expect(anthropicModels.some(m => m.id === "claude-custom-2")).toBe(true);
			expect(anthropicModels.some(m => m.id.includes("claude"))).toBe(true);
		});

		test("built-in gpt-5.4 applies the hardcoded context window policy", () => {
			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			expect(registry.find("openai", "gpt-5.4")?.contextWindow).toBe(1_000_000);
		});

		test("custom gpt-5.4 replacement keeps the hardcoded context window when contextWindow is omitted", () => {
			writeRawModelsJson({
				openai: {
					baseUrl: "https://my-proxy.example.com/v1",
					apiKey: "TEST_KEY",
					api: "openai-responses",
					models: [{ id: "gpt-5.4" }],
				},
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const model = registry.find("openai", "gpt-5.4");
			expect(model?.contextWindow).toBe(1_000_000);
			expect(model?.baseUrl).toBe("https://my-proxy.example.com/v1");
		});

		test("custom-only gpt-5.4 provider keeps the hardcoded context window when contextWindow is omitted", () => {
			writeRawModelsJson({
				"my-proxy": {
					baseUrl: "https://my-proxy.example.com/v1",
					apiKey: "TEST_KEY",
					api: "openai-responses",
					models: [{ id: "gpt-5.4" }],
				},
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const model = registry.find("my-proxy", "gpt-5.4");
			expect(model?.contextWindow).toBe(1_000_000);
			expect(model?.baseUrl).toBe("https://my-proxy.example.com/v1");
		});

		test("custom gpt-5.4 replacement preserves its explicit context window", () => {
			writeModelsJson({
				openai: providerConfig(
					"https://my-proxy.example.com/v1",
					[{ id: "gpt-5.4", contextWindow: 256000 }],
					"openai-responses",
				),
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			expect(registry.find("openai", "gpt-5.4")?.contextWindow).toBe(256000);
		});

		test("custom-only gpt-5.5 completions provider defaults to the Codex-safe context window", () => {
			writeRawModelsJson({
				"my-proxy": {
					baseUrl: "http://127.0.0.1:8317/v1",
					apiKey: "TEST_KEY",
					api: "openai-completions",
					models: [{ id: "gpt-5.5" }],
				},
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const model = registry.find("my-proxy", "gpt-5.5");
			expect(model?.contextWindow).toBe(272_000);
			expect(model?.baseUrl).toBe("http://127.0.0.1:8317/v1");
		});
		test("id-only custom OpenAI-compatible models default to text-only input", () => {
			writeRawModelsJson({
				ali: {
					baseUrl: "https://token-plan.example.com/compatible-mode/v1",
					apiKey: "TEST_KEY",
					api: "openai-completions",
					models: [{ id: "qwen3.8-max-preview" }],
				},
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const model = registry.find("ali", "qwen3.8-max-preview");
			// No bundled reference and no explicit input → safe text-only default.
			// Vision backends must set input: [text, image] or images are stripped.
			expect(model?.input).toEqual(["text"]);
			expect(model?.input.includes("image")).toBe(false);
		});

		test("custom OpenAI-compatible models honor explicit vision input", () => {
			writeRawModelsJson({
				ali: {
					baseUrl: "https://token-plan.example.com/compatible-mode/v1",
					apiKey: "TEST_KEY",
					api: "openai-completions",
					models: [
						{
							id: "qwen3.8-max-preview",
							name: "Qwen3.8 Max Preview",
							reasoning: true,
							input: ["text", "image"],
						},
					],
				},
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const model = registry.find("ali", "qwen3.8-max-preview");
			expect(model?.input).toEqual(["text", "image"]);
			expect(model?.input.includes("image")).toBe(true);
		});

		test("custom gpt-5.5 responses provider keeps the first-party context window when contextWindow is omitted", () => {
			writeRawModelsJson({
				"my-proxy": {
					baseUrl: "https://my-proxy.example.com/v1",
					apiKey: "TEST_KEY",
					api: "openai-responses",
					models: [{ id: "gpt-5.5" }],
				},
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			expect(registry.find("my-proxy", "gpt-5.5")?.contextWindow).toBe(1_000_000);
		});

		test("custom gpt-5.5 completions provider preserves its explicit context window", () => {
			writeRawModelsJson({
				"my-proxy": {
					baseUrl: "http://127.0.0.1:8317/v1",
					apiKey: "TEST_KEY",
					api: "openai-completions",
					models: [{ id: "gpt-5.5", contextWindow: 400000 }],
				},
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			expect(registry.find("my-proxy", "gpt-5.5")?.contextWindow).toBe(400000);
		});

		test("modelOverrides can still patch a custom gpt-5.4 replacement", () => {
			writeRawModelsJson({
				openai: {
					baseUrl: "https://my-proxy.example.com/v1",
					apiKey: "TEST_KEY",
					api: "openai-responses",
					models: [
						{
							id: "gpt-5.4",
							name: "gpt-5.4",
							reasoning: false,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 256000,
							maxTokens: 128000,
						},
					],
					modelOverrides: {
						"gpt-5.4": {
							contextWindow: 512000,
						},
					},
				},
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			expect(registry.find("openai", "gpt-5.4")?.contextWindow).toBe(512000);
		});

		test("discoverable bundled replacement survives refresh", async () => {
			writeModelsJson({
				openai: providerConfig(
					"https://my-proxy.example.com/v1",
					[{ id: "gpt-5.4", name: "Proxy GPT-5.4", contextWindow: 256000 }],
					"openai-responses",
				),
			});
			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			expect(registry.find("openai", "gpt-5.4")?.name).toBe("Proxy GPT-5.4");
			expect(registry.find("openai", "gpt-5.4")?.contextWindow).toBe(256000);

			using _hook = mockOpenAiCompatibleModels("https://my-proxy.example.com/v1/models", ["gpt-5.4"]);
			await registry.refreshProvider("openai", "online");

			const model = registry.find("openai", "gpt-5.4");
			expect(model?.name).toBe("Proxy GPT-5.4");
			expect(model?.contextWindow).toBe(256000);
			expect(model?.baseUrl).toBe("https://my-proxy.example.com/v1");
		});

		test("bundled jetbrains-junie gpt-5.4 keeps its probed 922K window", () => {
			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			// The generic gpt-5.4 policy raises the window to 1M for everyone except
			// gateway-fronted providers. JetBrains AI enforces 922K, so the measured
			// bundled value must survive; raising it would delay compaction past the
			// point the gateway accepts.
			expect(registry.find("jetbrains-junie", "gpt-5.4")?.contextWindow).toBe(922_000);
			expect(registry.find("openai-codex", "gpt-5.4")?.contextWindow).toBe(1_000_000);
		});

		test("discoverable custom-only gpt-5.4 survives refresh", async () => {
			writeRawModelsJson({
				"custom-local": {
					baseUrl: "http://127.0.0.1:8080",
					apiKey: "TEST_KEY",
					api: "openai-responses",
					discovery: { type: "llama.cpp" },
					models: [{ id: "gpt-5.4" }],
				},
			});
			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			expect(registry.find("custom-local", "gpt-5.4")?.contextWindow).toBe(1_000_000);

			using _hook = mockOpenAiCompatibleModels("http://127.0.0.1:8080/models", ["gpt-5.4"]);
			await registry.refreshProvider("custom-local", "online");

			const model = registry.find("custom-local", "gpt-5.4");
			expect(model?.contextWindow).toBe(1_000_000);
			expect(model?.baseUrl).toBe("http://127.0.0.1:8080");
		});

		test("discoverable custom compat survives refresh", async () => {
			writeRawModelsJson({
				openai: {
					baseUrl: "https://my-proxy.example.com/v1",
					apiKey: "TEST_KEY",
					api: "openai-responses",
					models: [
						{
							id: "gpt-5.4",
							compat: {
								extraBody: { source: "proxy" },
							},
						},
					],
				},
			});
			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			expect(getOpenAICompat(registry.find("openai", "gpt-5.4"))?.extraBody).toEqual({ source: "proxy" });

			using _hook = mockOpenAiCompatibleModels("https://my-proxy.example.com/v1/models", ["gpt-5.4"]);
			await registry.refreshProvider("openai", "online");

			expect(getOpenAICompat(registry.find("openai", "gpt-5.4"))?.extraBody).toEqual({ source: "proxy" });
		});

		test("dynamically discovered built-in model survives a later offline refresh", async () => {
			// Regression: the built-in discovery freshness filter memoizes provider-keyed
			// evidence per provider instead of recomputing it per model. A model that was
			// freshly discovered online must still pass the offline freshness filter (its
			// provider evidence is current) and remain in the catalog.
			writeRawModelsJson({
				openai: {
					baseUrl: "https://my-proxy.example.com/v1",
					apiKey: "TEST_KEY",
					api: "openai-responses",
					models: [{ id: "gpt-5.4" }],
				},
			});
			const registry = new ModelRegistry(authStorage, modelsJsonPath);

			using _hook = mockOpenAiCompatibleModels("https://my-proxy.example.com/v1/models", ["gpt-5.4", "gpt-5.5"]);
			await registry.refreshProvider("openai", "online");
			const discoveredIds = getModelsForProvider(registry, "openai")
				.map(model => model.id)
				.sort();
			expect(discoveredIds).toContain("gpt-5.5");

			// The offline refresh re-runs the memoized built-in freshness filter over
			// the whole cached catalog; the provider's evidence is still current, so the
			// exact discovered id set must be preserved (not dropped by the filter).
			await registry.refresh("offline");
			const afterOfflineIds = getModelsForProvider(registry, "openai")
				.map(model => model.id)
				.sort();
			expect(afterOfflineIds).toEqual(discoveredIds);
		});

		test("modelOverrides still apply after discoverable refresh", async () => {
			writeRawModelsJson({
				openai: {
					baseUrl: "https://my-proxy.example.com/v1",
					apiKey: "TEST_KEY",
					api: "openai-responses",
					models: [
						{
							id: "gpt-5.4",
							contextWindow: 256000,
						},
					],
					modelOverrides: {
						"gpt-5.4": {
							contextWindow: 512000,
						},
					},
				},
			});
			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			expect(registry.find("openai", "gpt-5.4")?.contextWindow).toBe(512000);

			using _hook = mockOpenAiCompatibleModels("https://my-proxy.example.com/v1/models", ["gpt-5.4"]);
			await registry.refreshProvider("openai", "online");

			expect(registry.find("openai", "gpt-5.4")?.contextWindow).toBe(512000);
		});

		test("newly discovered ids inherit provider fields, not another model's custom fields", async () => {
			writeRawModelsJson({
				openai: {
					baseUrl: "https://provider.example.com/v1",
					headers: { "X-Provider": "provider" },
					apiKey: "TEST_KEY",
					api: "openai-responses",
					models: [
						{
							id: "gpt-5.4",
							baseUrl: "https://special.example.com/v1",
							headers: { "X-Model": "special" },
						},
					],
				},
			});
			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			expect(registry.find("openai", "gpt-5.4")?.baseUrl).toBe("https://special.example.com/v1");

			using _hook = mockOpenAiCompatibleModels("https://provider.example.com/v1/models", ["gpt-5.4", "gpt-5.5"]);
			await registry.refreshProvider("openai", "online");

			const discovered = registry.find("openai", "gpt-5.5");
			expect(discovered?.baseUrl).toBe("https://provider.example.com/v1");
			expect(discovered?.headers?.["X-Provider"]).toBe("provider");
			expect(discovered?.headers?.["X-Model"]).toBeUndefined();
		});

		test("provider presets discover ClinePass and Command Code catalogs without hardcoded model rows", async () => {
			const presetModelsPath = path.join(tempDir, "preset-models.yml");
			await addApiCompatibleProvider({ preset: "minimax", modelsPath: presetModelsPath });
			await addApiCompatibleProvider({ preset: "zai", modelsPath: presetModelsPath });
			await addApiCompatibleProvider({ preset: "cline-pass", modelsPath: presetModelsPath });
			await addApiCompatibleProvider({ preset: "commandcode-goat", modelsPath: presetModelsPath });
			authStorage.setRuntimeApiKey("commandcode-goat", "test-key");

			using _hook = hookFetch(input => {
				const url = String(input);
				if (url === "https://models.dev/api.json") {
					return new Response(
						JSON.stringify({
							"cline-pass": {
								models: {
									"cline-pass/live-coder": {
										id: "cline-pass/live-coder",
										name: "Live Coder",
										tool_call: true,
										reasoning: true,
										modalities: { input: ["text", "image"], output: ["text"] },
										limit: { context: 1_000_000, output: 64_000 },
										cost: { input: 0.4, output: 1.6, cache_read: 0.04, cache_write: 0.5 },
									},
								},
							},
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				}
				if (url === "https://api.commandcode.ai/provider/v1/models") {
					return new Response(JSON.stringify({ data: [{ id: "claude-opus-5.5" }, { id: "Qwen/Qwen3.8-Max" }] }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					});
				}
				throw new Error(`Unexpected URL: ${url}`);
			});

			const registry = new ModelRegistry(authStorage, presetModelsPath);
			expect(registry.find("cline-pass", "cline-pass/live-coder")).toBeUndefined();
			expect(registry.find("commandcode-goat", "claude-opus-5.5")).toBeUndefined();

			await registry.refreshProvider("cline-pass", "online");
			await registry.refreshProvider("commandcode-goat", "online");

			const minimax = registry.find("minimax-code", "MiniMax-M3");
			const glm = registry.find("glm-proxy", "glm-4.6");
			const clinePass = registry.find("cline-pass", "cline-pass/live-coder");

			expect(minimax?.api).toBe("openai-completions");
			// #614: preset-onboarded models inherit the bundled canonical display
			// name (MiniMax-M3) while preserving the requested machine id.
			expect(minimax?.id).toBe("MiniMax-M3");
			expect(minimax?.name).toBe("MiniMax-M3");
			expect(minimax?.baseUrl).toBe("https://api.minimax.io/v1");
			expect(getOpenAICompat(minimax)?.supportsStore).toBe(false);
			expect(getOpenAICompat(minimax)?.reasoningContentField).toBe("reasoning_content");
			expect(glm?.api).toBe("openai-completions");
			expect(glm?.baseUrl).toBe("https://api.z.ai/api/paas/v4");
			expect(getOpenAICompat(glm)?.thinkingFormat).toBe("zai");
			expect(getOpenAICompat(glm)?.supportsReasoningEffort).toBe(false);
			expect(clinePass).toMatchObject({
				name: "Live Coder",
				api: "openai-completions",
				baseUrl: "https://api.cline.bot/api/v1",
				reasoning: true,
				input: ["text", "image"],
				contextWindow: 1_000_000,
				maxTokens: 64_000,
			});
			expect(registry.find("commandcode-goat", "claude-opus-5.5")).toMatchObject({
				api: "anthropic-messages",
				baseUrl: "https://api.commandcode.ai/provider/v1",
			});
			expect(registry.find("commandcode-goat", "claude-opus-5.5")?.headers?.Authorization).toBeUndefined();
			expect(registry.find("commandcode-goat", "Qwen/Qwen3.8-Max")?.api).toBe("openai-completions");
		}, 120_000);

		test("#614: custom provider referencing a bundled model id inherits canonical display name", () => {
			// A user-defined provider whose name does not match a bundled provider but
			// references a bundled model id (e.g. the documented `minimax-custom` proxy
			// with `id: minimax-m3` and no explicit name). It must surface the canonical
			// `MiniMax-M3` display casing while keeping the lowercase machine id.
			writeRawModelsJson({
				"minimax-custom": {
					baseUrl: "https://api.minimax.io/v1",
					apiKey: "TEST_KEY",
					api: "openai-completions",
					models: [{ id: "minimax-m3" }],
				},
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const model = registry.find("minimax-custom", "minimax-m3");
			expect(model?.id).toBe("minimax-m3");
			expect(model?.name).toBe("MiniMax-M3");
		});

		test("#3856: namespaced custom model id inherits canonical leaf metadata when omitted", () => {
			// Proxy wire IDs often namespace the upstream model (`vendor/model-id`).
			// When contextWindow/maxTokens are omitted, inherit from the bundled leaf
			// id while retaining the namespaced wire id for the request.
			writeRawModelsJson({
				clinepass: {
					baseUrl: "https://api.cline.bot/api/v1",
					apiKey: "TEST_KEY",
					api: "openai-completions",
					auth: "apiKey",
					compat: {
						supportsStore: false,
						supportsDeveloperRole: false,
					},
					models: [
						{
							id: "cline-pass/deepseek-v4-flash",
							name: "DeepSeek V4 Flash via ClinePass",
							reasoning: true,
							input: ["text"],
						},
					],
				},
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const model = registry.find("clinepass", "cline-pass/deepseek-v4-flash");
			expect(model?.id).toBe("cline-pass/deepseek-v4-flash");
			expect(model?.name).toBe("DeepSeek V4 Flash via ClinePass");
			expect(model?.contextWindow).toBe(1_000_000);
			expect(model?.maxTokens).toBe(384_000);
			expect(model?.maxTokensSource).toBeUndefined();
			expect(model?.reasoning).toBe(true);
			expect(model?.baseUrl).toBe("https://api.cline.bot/api/v1");
		});

		test("#3856: true unknown namespaced custom models still use generic defaults", () => {
			writeRawModelsJson({
				clinepass: {
					baseUrl: "https://api.cline.bot/api/v1",
					apiKey: "TEST_KEY",
					api: "openai-completions",
					models: [
						{
							id: "cline-pass/totally-unknown-model-xyz",
							name: "Unknown via ClinePass",
							reasoning: false,
							input: ["text"],
						},
					],
				},
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const model = registry.find("clinepass", "cline-pass/totally-unknown-model-xyz");
			expect(model?.id).toBe("cline-pass/totally-unknown-model-xyz");
			expect(model?.contextWindow).toBe(128_000);
			expect(model?.maxTokens).toBe(16_384);
			expect(model?.maxTokensSource).toBeUndefined();
		});

		test("#3856: explicit contextWindow on namespaced custom model is preserved", () => {
			writeRawModelsJson({
				clinepass: {
					baseUrl: "https://api.cline.bot/api/v1",
					apiKey: "TEST_KEY",
					api: "openai-completions",
					models: [
						{
							id: "cline-pass/deepseek-v4-flash",
							name: "DeepSeek V4 Flash via ClinePass",
							reasoning: true,
							input: ["text"],
							contextWindow: 512_000,
							maxTokens: 32_000,
						},
					],
				},
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const model = registry.find("clinepass", "cline-pass/deepseek-v4-flash");
			expect(model?.contextWindow).toBe(512_000);
			expect(model?.maxTokens).toBe(32_000);
			expect(model?.maxTokensSource).toBe("configured");
		});

		test("same-id replacement uses configured compat without bundled compat leak", () => {
			writeRawModelsJson({
				"minimax-code": {
					baseUrl: "https://proxy.example.com/v1",
					apiKey: "TEST_KEY",
					api: "openai-completions",
					compat: {
						extraBody: { source: "proxy" },
					},
					models: [{ id: "minimax-m3" }],
				},
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const model = registry.find("minimax-code", "minimax-m3");
			const compat = getOpenAICompat(model);
			expect(compat?.thinkingFormat).toBeUndefined();
			expect(compat?.reasoningContentField).toBeUndefined();
			expect(compat?.extraBody).toEqual({ source: "proxy" });
		});

		test("removing custom models from models.json keeps built-in provider models", async () => {
			writeModelsJson({
				anthropic: providerConfig("https://proxy.example.com/v1", [{ id: "claude-custom" }]),
			});
			const registry = new ModelRegistry(authStorage, modelsJsonPath);

			expect(getModelsForProvider(registry, "anthropic").some(m => m.id === "claude-custom")).toBe(true);

			// Remove custom models and refresh
			writeModelsJson({});
			await registry.refresh("offline");

			const anthropicModels = getModelsForProvider(registry, "anthropic");
			expect(anthropicModels.length).toBeGreaterThan(1);
			expect(anthropicModels.some(m => m.id === "claude-custom")).toBe(false);
			expect(anthropicModels.some(m => m.id.includes("claude"))).toBe(true);
		});
	});

	describe("thinking metadata normalization", () => {
		test("custom models preserve explicit thinking", () => {
			const thinking: ThinkingConfig = {
				mode: "anthropic-adaptive",
				minLevel: Effort.Minimal,
				maxLevel: Effort.High,
				levels: [Effort.Minimal, Effort.High],
			};

			writeModelsJson({
				anthropic: providerConfig("https://my-proxy.example.com/v1", [
					{ id: "claude-custom", reasoning: true, thinking },
				]),
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const model = getModelsForProvider(registry, "anthropic").find(m => m.id === "claude-custom");

			expect(model?.thinking).toEqual(thinking);
		});

		test("model overrides can replace canonical thinking metadata", () => {
			writeRawModelsJson({
				openrouter: {
					modelOverrides: {
						"anthropic/claude-sonnet-4": {
							thinking: { mode: "budget", minLevel: Effort.Low, maxLevel: Effort.Medium },
						},
					},
				},
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const model = getModelsForProvider(registry, "openrouter").find(m => m.id === "anthropic/claude-sonnet-4");

			expect(model?.thinking).toEqual({
				mode: "budget",
				minLevel: Effort.Low,
				maxLevel: Effort.Medium,
			});
		});
	});

	describe("modelOverrides (per-model customization)", () => {
		test("model override applies to a single built-in model", () => {
			writeRawModelsJson({
				openrouter: {
					modelOverrides: {
						"anthropic/claude-sonnet-4": {
							name: "Custom Sonnet Name",
						},
					},
				},
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const models = getModelsForProvider(registry, "openrouter");

			const sonnet = models.find(m => m.id === "anthropic/claude-sonnet-4");
			expect(sonnet?.name).toBe("Custom Sonnet Name");

			// Other models should be unchanged
			const opus = models.find(m => m.id === "anthropic/claude-opus-4");
			expect(opus?.name).not.toBe("Custom Sonnet Name");
		});

		test("model override with compat.openRouterRouting", () => {
			writeRawModelsJson({
				openrouter: {
					modelOverrides: {
						"anthropic/claude-sonnet-4": {
							compat: {
								openRouterRouting: { only: ["amazon-bedrock"] },
							},
						},
					},
				},
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const models = getModelsForProvider(registry, "openrouter");

			const sonnet = models.find(m => m.id === "anthropic/claude-sonnet-4");
			const compat = sonnet?.compat as OpenAICompat | undefined;
			expect(compat?.openRouterRouting).toEqual({ only: ["amazon-bedrock"] });
		});

		test("model override deep merges compat settings", () => {
			writeRawModelsJson({
				openrouter: {
					modelOverrides: {
						"anthropic/claude-sonnet-4": {
							compat: {
								openRouterRouting: { order: ["anthropic", "together"] },
							},
						},
					},
				},
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const models = getModelsForProvider(registry, "openrouter");
			const sonnet = models.find(m => m.id === "anthropic/claude-sonnet-4");

			const compat = sonnet?.compat as OpenAICompat | undefined;
			expect(compat?.openRouterRouting).toEqual({ order: ["anthropic", "together"] });
		});

		test("model override merges compat.extraBody across provider+model", () => {
			writeRawModelsJson({
				openrouter: {
					compat: {
						extraBody: {
							gateway: "default-gateway",
							controller: "provider-controller",
						},
					},
					modelOverrides: {
						"anthropic/claude-sonnet-4": {
							compat: {
								extraBody: {
									controller: "model-controller",
								},
							},
						},
					},
				},
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const models = getModelsForProvider(registry, "openrouter");
			const sonnet = models.find(m => m.id === "anthropic/claude-sonnet-4");

			const compat = sonnet?.compat as OpenAICompat | undefined;
			expect(compat?.extraBody).toEqual({ gateway: "default-gateway", controller: "model-controller" });
		});

		test("multiple model overrides on same provider", () => {
			writeRawModelsJson({
				openrouter: {
					modelOverrides: {
						"anthropic/claude-sonnet-4": {
							compat: { openRouterRouting: { only: ["amazon-bedrock"] } },
						},
						"anthropic/claude-opus-4": {
							compat: { openRouterRouting: { only: ["anthropic"] } },
						},
					},
				},
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const models = getModelsForProvider(registry, "openrouter");

			const sonnet = models.find(m => m.id === "anthropic/claude-sonnet-4");
			const opus = models.find(m => m.id === "anthropic/claude-opus-4");

			const sonnetCompat = sonnet?.compat as OpenAICompat | undefined;
			const opusCompat = opus?.compat as OpenAICompat | undefined;
			expect(sonnetCompat?.openRouterRouting).toEqual({ only: ["amazon-bedrock"] });
			expect(opusCompat?.openRouterRouting).toEqual({ only: ["anthropic"] });
		});

		test("model override combined with baseUrl override", () => {
			writeRawModelsJson({
				openrouter: {
					baseUrl: "https://my-proxy.example.com/v1",
					modelOverrides: {
						"anthropic/claude-sonnet-4": {
							name: "Proxied Sonnet",
						},
					},
				},
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const models = getModelsForProvider(registry, "openrouter");
			const sonnet = models.find(m => m.id === "anthropic/claude-sonnet-4");

			// Both overrides should apply
			expect(sonnet?.baseUrl).toBe("https://my-proxy.example.com/v1");
			expect(sonnet?.name).toBe("Proxied Sonnet");

			// Other models should have the baseUrl but not the name override
			const opus = models.find(m => m.id === "anthropic/claude-opus-4");
			expect(opus?.baseUrl).toBe("https://my-proxy.example.com/v1");
			expect(opus?.name).not.toBe("Proxied Sonnet");
		});

		test("model override for non-existent model ID is ignored", () => {
			writeRawModelsJson({
				openrouter: {
					modelOverrides: {
						"nonexistent/model-id": {
							name: "This should not appear",
						},
					},
				},
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const models = getModelsForProvider(registry, "openrouter");

			// Should not create a new model
			expect(models.find(m => m.id === "nonexistent/model-id")).toBeUndefined();
			// Should not crash or show error
			expect(registry.getError()).toBeUndefined();
		});

		test("model override can change cost fields partially", () => {
			writeRawModelsJson({
				openrouter: {
					modelOverrides: {
						"anthropic/claude-sonnet-4": {
							cost: { input: 99 },
						},
					},
				},
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const models = getModelsForProvider(registry, "openrouter");
			const sonnet = models.find(m => m.id === "anthropic/claude-sonnet-4");

			// Input cost should be overridden
			expect(sonnet?.cost.input).toBe(99);
			// Other cost fields should be preserved from built-in
			expect(sonnet?.cost.output).toBeGreaterThan(0);
		});

		test("model override can add headers", () => {
			writeRawModelsJson({
				openrouter: {
					modelOverrides: {
						"anthropic/claude-sonnet-4": {
							headers: { "X-Custom-Model-Header": "value" },
						},
					},
				},
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const models = getModelsForProvider(registry, "openrouter");
			const sonnet = models.find(m => m.id === "anthropic/claude-sonnet-4");

			expect(sonnet?.headers?.["X-Custom-Model-Header"]).toBe("value");
		});

		test("refresh() picks up model override changes", async () => {
			writeRawModelsJson({
				openrouter: {
					modelOverrides: {
						"anthropic/claude-sonnet-4": {
							name: "First Name",
						},
					},
				},
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			expect(
				getModelsForProvider(registry, "openrouter").find(m => m.id === "anthropic/claude-sonnet-4")?.name,
			).toBe("First Name");

			// Update and refresh
			writeRawModelsJson({
				openrouter: {
					modelOverrides: {
						"anthropic/claude-sonnet-4": {
							name: "Second Name",
						},
					},
				},
			});
			await registry.refresh("offline");

			expect(
				getModelsForProvider(registry, "openrouter").find(m => m.id === "anthropic/claude-sonnet-4")?.name,
			).toBe("Second Name");
		});

		test("removing model override restores built-in values", async () => {
			writeRawModelsJson({
				openrouter: {
					modelOverrides: {
						"anthropic/claude-sonnet-4": {
							name: "Custom Name",
						},
					},
				},
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const customName = getModelsForProvider(registry, "openrouter").find(
				m => m.id === "anthropic/claude-sonnet-4",
			)?.name;
			expect(customName).toBe("Custom Name");

			// Remove override and refresh
			writeRawModelsJson({});
			await registry.refresh("offline");

			const restoredName = getModelsForProvider(registry, "openrouter").find(
				m => m.id === "anthropic/claude-sonnet-4",
			)?.name;
			expect(restoredName).not.toBe("Custom Name");
		});
	});

	describe("github-copilot oauth endpoint alignment", () => {
		test("getApiKey does not mutate bundled github-copilot baseUrl", async () => {
			await authStorage.set("github-copilot", [
				{
					type: "oauth",
					access: "ghu_individual_token_123",
					refresh: "ghu_individual_token_123",
					expires: Date.now() + 60_000,
				},
				{
					type: "oauth",
					access: "ghu_enterprise_token_456",
					refresh: "ghu_enterprise_token_456",
					expires: Date.now() + 60_000,
					enterpriseUrl: "ghe.example.com",
				},
			]);

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const model = registry.find("github-copilot", "gpt-4o");
			expect(model).toBeDefined();
			if (!model) throw new Error("Expected github-copilot/gpt-4o model");

			const initialBaseUrl = model.baseUrl;
			const firstApiKey = await registry.getApiKey(model);
			expect(firstApiKey).toBeDefined();
			const firstParsed = JSON.parse(firstApiKey!) as { token?: string; enterpriseUrl?: string };
			expect(firstParsed.token).toBe("ghu_individual_token_123");
			expect(firstParsed.enterpriseUrl).toBeUndefined();
			const secondApiKey = await registry.getApiKey(model);
			expect(secondApiKey).toBeDefined();
			const secondParsed = JSON.parse(secondApiKey!) as { token?: string; enterpriseUrl?: string };
			expect(secondParsed.token).toBe("ghu_enterprise_token_456");
			expect(secondParsed.enterpriseUrl).toBe("ghe.example.com");
			expect(model.baseUrl).toBe(initialBaseUrl);
		});

		test("refreshProvider uses enterprise Copilot discovery host for peeked credentials", async () => {
			await authStorage.set("github-copilot", [
				{
					type: "oauth",
					access: "ghu_enterprise_token_456",
					refresh: "ghu_enterprise_token_456",
					expires: Date.now() + 60_000,
					enterpriseUrl: "ghe.example.com",
				},
			]);

			const requestedUrls: string[] = [];
			using _hook = hookFetch((input: string | URL | Request, init?: RequestInit) => {
				const url = input instanceof Request ? input.url : String(input);
				requestedUrls.push(url);
				if (url === "https://copilot-api.ghe.example.com/models") {
					const authHeader =
						input instanceof Request
							? input.headers.get("Authorization")
							: new Headers(init?.headers).get("Authorization");
					expect(authHeader).toBe("Bearer ghu_enterprise_token_456");
					return new Response(
						JSON.stringify({
							data: [
								{
									id: "gpt-5-mini",
									name: "GPT-5 mini",
								},
							],
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				}
				throw new Error(`Unexpected URL: ${url}`);
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			await registry.refreshProvider("github-copilot", "online");
			expect(requestedUrls).toContain("https://copilot-api.ghe.example.com/models");
			expect(requestedUrls).not.toContain("https://api.githubcopilot.com/models");
		});
	});

	describe("disabled provider filtering", () => {
		test("getAvailable and getDiscoverableProviders exclude disabled providers from settings", async () => {
			writeRawModelsJson({
				ollama: {
					baseUrl: "http://127.0.0.1:11434/v1",
					api: "openai-completions",
					auth: "none",
					discovery: { type: "ollama" },
				},
			});
			await authStorage.set("github-copilot", [
				{
					type: "oauth",
					access: "ghu_test_token_for_disabled",
					refresh: "ghu_test_token_for_disabled",
					expires: Date.now() + 60_000,
				},
			]);
			await Settings.init({
				inMemory: true,
				overrides: {
					disabledProviders: ["github-copilot", "ollama"],
				},
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);

			expect(registry.getAvailable().some(model => model.provider === "github-copilot")).toBe(false);
			expect(registry.getDiscoverableProviders()).not.toContain("ollama");
			expect(registry.getActiveProviders().some(provider => provider.provider === "github-copilot")).toBe(false);
			expect(registry.getActiveProviders().some(provider => provider.provider === "ollama")).toBe(false);
		});

		test("refresh skips discovery probes for disabled local providers", async () => {
			await Settings.init({
				inMemory: true,
				overrides: {
					disabledProviders: ["llama.cpp", "lm-studio", "ollama", "omlx"],
				},
			});
			const requestedUrls: string[] = [];
			using _hook = hookFetch(input => {
				requestedUrls.push(String(input));
				throw new Error(`Unexpected URL: ${String(input)}`);
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			await registry.refresh("online");

			const disabledProbeUrls = requestedUrls.filter(
				url => url.includes("127.0.0.1:11434") || url.includes("127.0.0.1:8080") || url.includes("127.0.0.1:1234"),
			);
			expect(disabledProbeUrls).toEqual([]);
		});
		test("rebuilds implicit discovery when disabled providers change without models.json", async () => {
			await Settings.init({
				inMemory: true,
				overrides: {
					disabledProviders: ["llama.cpp", "lm-studio", "ollama", "omlx"],
				},
			});
			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			expect(registry.getDiscoverableProviders()).not.toContain("ollama");
			expect(registry.getDiscoverableProviders()).not.toContain("omlx");

			settings.override("disabledProviders", []);
			await registry.refresh("offline");

			expect(registry.getDiscoverableProviders()).toContain("ollama");
			expect(registry.getDiscoverableProviders()).toContain("omlx");
		});
		test("rebuilds implicit discovery when endpoint environment changes without models.json", async () => {
			const firstBaseUrl = "http://127.0.0.1:21334";
			const secondBaseUrl = "http://127.0.0.1:21434";
			const requestedUrls: string[] = [];
			using _hook = hookFetch((input, init, next) => {
				const url = String(input);
				if (url === `${firstBaseUrl}/api/tags` || url === `${secondBaseUrl}/api/tags`) {
					requestedUrls.push(url);
					return new Response(JSON.stringify({ models: [{ name: "phi4-mini" }] }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					});
				}
				if (url === `${firstBaseUrl}/api/show` || url === `${secondBaseUrl}/api/show`) {
					requestedUrls.push(url);
					return new Response(JSON.stringify({ capabilities: ["completion"] }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					});
				}
				return next(input, init);
			});

			const restoreInitialBaseUrl = setEnvForTest("OLLAMA_BASE_URL", firstBaseUrl);
			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const firstRefresh = registry.refreshProvider("ollama", "online");
			restoreInitialBaseUrl();
			await firstRefresh;
			const restoreChangedBaseUrl = setEnvForTest("OLLAMA_BASE_URL", secondBaseUrl);
			const refresh = registry.refreshProvider("ollama", "online");
			restoreChangedBaseUrl();
			await refresh;

			expect(requestedUrls).toContain(`${firstBaseUrl}/api/tags`);
			expect(requestedUrls).toContain(`${secondBaseUrl}/api/tags`);
		});
	});
	describe("runtime discovery", () => {
		test("auto-discovers ollama models without provider config", async () => {
			using _hook = mockOllamaDiscovery(["phi4-mini"]);
			const restoreOllamaBaseUrl = setEnvForTest("OLLAMA_BASE_URL", "http://127.0.0.1:11434");
			const restoreOllamaKey = unsetEnvForTest("OLLAMA_API_KEY");
			try {
				const registry = new ModelRegistry(authStorage, modelsJsonPath);
				await registry.refresh();
				const ollamaModels = getModelsForProvider(registry, "ollama");
				expect(ollamaModels.some(m => m.id === "phi4-mini")).toBe(true);
				expect(registry.getAvailable().some(m => m.provider === "ollama" && m.id === "phi4-mini")).toBe(true);
				expect(await registry.getApiKey(ollamaModels[0])).toBe(kNoAuth);
				expect(registry.getActiveProviders()).toContainEqual({
					provider: "ollama",
					connectionKind: "credentialless",
				});
			} finally {
				restoreOllamaKey();
				restoreOllamaBaseUrl();
			}
		});
		test("uses credentials for implicit Ollama discovery and model requests", async () => {
			const restoreOllamaKey = setEnvForTest("OLLAMA_API_KEY", "implicit-ollama-key");
			using _hook = hookFetch((input, init) => {
				const url = String(input);
				if (url === "http://127.0.0.1:11434/api/tags") {
					expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer implicit-ollama-key");
					return new Response(JSON.stringify({ models: [{ name: "phi4-mini" }] }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					});
				}
				if (url === "http://127.0.0.1:11434/api/show") {
					expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer implicit-ollama-key");
					return new Response(JSON.stringify({ capabilities: ["completion"] }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					});
				}
				throw new Error(`Unexpected URL: ${url}`);
			});
			try {
				const registry = new ModelRegistry(authStorage, modelsJsonPath);
				await registry.refresh();

				const ollamaModel = getModelsForProvider(registry, "ollama")[0];
				expect(await registry.getApiKey(ollamaModel)).toBe("implicit-ollama-key");
			} finally {
				restoreOllamaKey();
			}
		});
		test("discovers ollama-cloud through built-in descriptor flow without regressing local implicit ollama", async () => {
			authStorage.setRuntimeApiKey("ollama-cloud", "cloud-test-key");

			using _hook = hookFetch((input, init) => {
				const url = String(input);
				if (url === "http://127.0.0.1:11434/api/tags") {
					return new Response(JSON.stringify({ models: [{ name: "phi4-mini" }] }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					});
				}
				if (url === "http://127.0.0.1:11434/api/show") {
					return new Response(JSON.stringify({ capabilities: ["completion"] }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					});
				}
				if (url === "https://ollama.com/api/tags") {
					const headers = new Headers(init?.headers);
					expect(headers.get("Authorization")).toBe("Bearer cloud-test-key");
					return new Response(JSON.stringify({ models: [{ name: "gpt-oss:120b" }] }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					});
				}
				if (url === "https://ollama.com/api/show") {
					const headers = new Headers(init?.headers);
					expect(headers.get("Authorization")).toBe("Bearer cloud-test-key");
					const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
					expect(body.model).toBe("gpt-oss:120b");
					return new Response(
						JSON.stringify({
							capabilities: ["completion", "thinking"],
							model_info: { "gpt-oss.context_length": 262144 },
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				}
				throw new Error(`Unexpected URL: ${url}`);
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			await registry.refresh();

			const local = registry.find("ollama", "phi4-mini");
			const cloud = registry.find("ollama-cloud", "gpt-oss:120b");

			expect(local?.provider).toBe("ollama");
			expect(local?.api).toBe("openai-responses");
			expect(cloud?.provider).toBe("ollama-cloud");
			expect(cloud?.api).toBe("ollama-chat");
			expect(cloud?.baseUrl).toBe("https://ollama.com");
			expect(cloud?.reasoning).toBe(true);
			expect(cloud?.contextWindow).toBe(262144);
			expect(await registry.getApiKey(cloud!)).toBe("cloud-test-key");
			expect(registry.getAvailable().some(model => model.provider === "ollama" && model.id === "phi4-mini")).toBe(
				true,
			);
			expect(
				registry.getAvailable().some(model => model.provider === "ollama-cloud" && model.id === "gpt-oss:120b"),
			).toBe(true);
		});
		test("discovers ollama models at runtime and treats auth:none providers as available", async () => {
			const _restoreOllamaKey = unsetEnvForTest("OLLAMA_API_KEY");
			try {
				writeRawModelsJson({
					ollama: {
						baseUrl: "http://127.0.0.1:11434/v1",
						api: "openai-completions",
						auth: "none",
						discovery: { type: "ollama" },
					},
				});

				using _hook = hookFetch(input => {
					const url = String(input);
					if (url === "http://127.0.0.1:11434/api/tags") {
						return new Response(
							JSON.stringify({
								models: [{ name: "qwen2.5-coder:7b" }, { model: "llama3.2:3b", name: "llama3.2:3b" }],
							}),
							{ status: 200, headers: { "Content-Type": "application/json" } },
						);
					}
					if (url === "http://127.0.0.1:11434/api/show") {
						return new Response(JSON.stringify({ capabilities: ["completion"] }), {
							status: 200,
							headers: { "Content-Type": "application/json" },
						});
					}
					throw new Error(`Unexpected URL: ${url}`);
				});

				const registry = new ModelRegistry(authStorage, modelsJsonPath);
				await registry.refresh();

				const ollamaModels = getModelsForProvider(registry, "ollama");
				expect(ollamaModels.some(m => m.id === "qwen2.5-coder:7b")).toBe(true);
				expect(ollamaModels.some(m => m.id === "llama3.2:3b")).toBe(true);

				const available = registry.getAvailable().filter(m => m.provider === "ollama");
				expect(available.length).toBe(2);
				expect(await registry.getApiKey(available[0])).toBe(kNoAuth);
			} finally {
				_restoreOllamaKey();
			}
		});

		test("normalizes cached ollama completions rows to responses on load", () => {
			writeRawModelsJson({
				ollama: {
					baseUrl: "http://127.0.0.1:11434/v1",
					api: "openai-responses",
					auth: "none",
					discovery: { type: "ollama" },
				},
			});
			writeCachedOllamaModels([
				{
					id: "phi4-mini",
					name: "phi4-mini",
					api: "openai-completions",
					provider: "ollama",
					baseUrl: "http://127.0.0.1:11434/v1",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 128000,
					maxTokens: 8192,
				},
			]);

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const ollama = registry.find("ollama", "phi4-mini");

			expect(ollama).toBeUndefined();
			expect(registry.getProviderDiscoveryState("ollama")?.status).toBe("idle");
		});

		test("records Ollama model reasoning without inventing OpenAI effort controls", async () => {
			writeRawModelsJson({
				ollama: {
					baseUrl: "http://127.0.0.1:11434/v1",
					api: "openai-completions",
					auth: "none",
					discovery: { type: "ollama" },
				},
			});

			using _hook = hookFetch((input, init) => {
				const url = String(input);
				if (url === "http://127.0.0.1:11434/api/tags") {
					return new Response(
						JSON.stringify({
							models: [{ name: "qwen3.5:397b-cloud" }, { name: "llama3.2:3b" }],
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				}
				if (url === "http://127.0.0.1:11434/api/show") {
					const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
					if (body.model === "qwen3.5:397b-cloud") {
						return new Response(JSON.stringify({ capabilities: ["completion", "thinking"] }), {
							status: 200,
							headers: { "Content-Type": "application/json" },
						});
					}
					if (body.model === "llama3.2:3b") {
						return new Response(JSON.stringify({ capabilities: ["completion"] }), {
							status: 200,
							headers: { "Content-Type": "application/json" },
						});
					}
				}
				throw new Error(`Unexpected request: ${url}`);
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			await registry.refresh();

			const qwen = registry.find("ollama", "qwen3.5:397b-cloud");
			expect(qwen?.reasoning).toBe(true);
			expect(qwen?.thinking).toBeUndefined();

			const llama = registry.find("ollama", "llama3.2:3b");
			expect(llama?.reasoning).toBe(false);
		});

		test("preserves explicit reasoning effort opt-in through OpenAI models-list discovery", async () => {
			writeRawModelsJson({
				"reasoning-discovery": {
					baseUrl: "https://proxy.example.com/v1",
					api: "openai-completions",
					auth: "none",
					compat: { supportsReasoningEffort: true },
					discovery: { type: "openai-models-list" },
				},
			});

			using _hook = hookFetch(input => {
				expect(String(input)).toBe("https://proxy.example.com/v1/models");
				return new Response(JSON.stringify({ data: [{ id: "gpt-5.4", max_output_tokens: 66_000 }] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			await registry.refresh();
			const model = registry.find("reasoning-discovery", "gpt-5.4");

			expect(getOpenAICompat(model)?.supportsReasoningEffort).toBe(true);
			expect(model?.thinking).toBeDefined();
			expect(model?.maxTokens).toBe(66_000);
			expect(model?.maxTokensSource).toBe("discovered");
			expect(model ? getSupportedEfforts(model) : []).toContain(Effort.High);
		});

		test("preserves explicit reasoning effort opt-in through models.dev discovery", async () => {
			writeRawModelsJson({
				"models-dev-reasoning": {
					baseUrl: "https://proxy.example.com/v1",
					api: "openai-completions",
					auth: "none",
					compat: { supportsReasoningEffort: true },
					discovery: { type: "models-dev", modelsDevProvider: "openai" },
				},
			});

			using _hook = hookFetch(input => {
				expect(String(input)).toBe("https://models.dev/api.json");
				return new Response(
					JSON.stringify({
						openai: {
							models: {
								"gpt-5.4": {
									id: "gpt-5.4",
									name: "GPT-5.4",
									tool_call: true,
									reasoning: true,
									modalities: { input: ["text"], output: ["text"] },
									limit: { context: 128_000, output: 32_000 },
								},
							},
						},
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			await registry.refresh();
			const model = registry.find("models-dev-reasoning", "gpt-5.4");

			expect(getOpenAICompat(model)?.supportsReasoningEffort).toBe(true);
			expect(model ? getSupportedEfforts(model) : []).toContain(Effort.High);
		});

		test("re-enriches reasoning metadata after a runtime provider capability override", () => {
			writeRawModelsJson({
				"runtime-reasoning": {
					baseUrl: "https://proxy.example.com/v1",
					api: "openai-completions",
					auth: "none",
					models: [
						{
							id: "gpt-5.4",
							reasoning: true,
							thinking: {
								mode: "effort",
								minLevel: Effort.Low,
								maxLevel: Effort.High,
								levels: [Effort.Low, Effort.High],
								defaultLevel: Effort.High,
							},
						},
					],
				},
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			expect(registry.find("runtime-reasoning", "gpt-5.4")?.thinking).toBeUndefined();

			registry.registerProvider("runtime-reasoning", {
				compat: { supportsReasoningEffort: true },
			});

			const model = registry.find("runtime-reasoning", "gpt-5.4");
			expect(getOpenAICompat(model)?.supportsReasoningEffort).toBe(true);
			expect(model?.thinking).toEqual({
				mode: "effort",
				minLevel: Effort.Low,
				maxLevel: Effort.High,
				levels: [Effort.Low, Effort.High],
				defaultLevel: Effort.High,
			});
			expect(model ? getSupportedEfforts(model) : []).toEqual([Effort.Low, Effort.High]);
		});

		test("preserves explicit thinking metadata when a model override enables capability", () => {
			writeRawModelsJson({
				"configured-reasoning": {
					baseUrl: "https://proxy.example.com/v1",
					api: "openai-completions",
					auth: "none",
					models: [
						{
							id: "custom-reasoner",
							reasoning: true,
							thinking: {
								mode: "effort",
								minLevel: Effort.Low,
								maxLevel: Effort.High,
								levels: [Effort.Low, Effort.High],
								defaultLevel: Effort.High,
							},
						},
					],
					modelOverrides: {
						"custom-reasoner": { compat: { supportsReasoningEffort: true } },
					},
				},
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const model = registry.find("configured-reasoning", "custom-reasoner");

			expect(getOpenAICompat(model)?.supportsReasoningEffort).toBe(true);
			expect(model ? getSupportedEfforts(model) : []).toEqual([Effort.Low, Effort.High]);
			expect(model?.thinking?.defaultLevel).toBe(Effort.High);
		});

		test("keeps a model-level reasoning effort opt-out over runtime provider opt-in", () => {
			writeRawModelsJson({
				"runtime-disabled-reasoning": {
					baseUrl: "https://proxy.example.com/v1",
					api: "openai-completions",
					auth: "none",
					models: [
						{
							id: "disabled-reasoner",
							reasoning: true,
							thinking: { mode: "effort", minLevel: Effort.Low, maxLevel: Effort.High },
							compat: { supportsReasoningEffort: false },
						},
					],
				},
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			registry.registerProvider("runtime-disabled-reasoning", {
				compat: { supportsReasoningEffort: true },
			});
			const model = registry.find("runtime-disabled-reasoning", "disabled-reasoner");

			expect(getOpenAICompat(model)?.supportsReasoningEffort).toBe(false);
			expect(model ? getSupportedEfforts(model) : []).toEqual([]);
		});

		test("discovers ollama context window from show model_info", async () => {
			using _hook = hookFetch((input, init) => {
				const url = String(input);
				if (url === "http://127.0.0.1:11434/api/tags") {
					return new Response(JSON.stringify({ models: [{ name: "gemma3:4b" }] }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					});
				}
				if (url === "http://127.0.0.1:11434/api/show") {
					const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
					if (body.model === "gemma3:4b") {
						return new Response(
							JSON.stringify({
								model_info: {
									"gemma3.context_length": 131072,
								},
							}),
							{
								status: 200,
								headers: { "Content-Type": "application/json" },
							},
						);
					}
				}
				throw new Error(`Unexpected request: ${url}`);
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			await registry.refresh();

			const gemma = registry.find("ollama", "gemma3:4b");
			expect(gemma?.contextWindow).toBe(131072);
			expect(gemma?.maxTokens).toBe(8192);
			expect(gemma?.input).toEqual(["text"]);
			expect(gemma?.reasoning).toBe(false);
		});

		test("serializes same-provider discovery refresh publication", async () => {
			writeRawModelsJson({
				race: {
					baseUrl: "https://race.example.com/v1",
					api: "openai-completions",
					auth: "none",
					discovery: { type: "openai-models-list" },
				},
			});
			const firstResponse = Promise.withResolvers<Response>();
			const firstRequest = Promise.withResolvers<void>();
			let requests = 0;
			using _hook = hookFetch(input => {
				expect(String(input)).toBe("https://race.example.com/v1/models");
				requests += 1;
				if (requests === 1) {
					firstRequest.resolve();
					return firstResponse.promise;
				}
				return new Response(JSON.stringify({ data: [{ id: "new-model" }] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const firstRefresh = registry.refreshProvider("race", "online");
			await firstRequest.promise;
			const secondRefresh = registry.refreshProvider("race", "online");
			await Bun.sleep(0);
			expect(requests).toBe(1);
			firstResponse.resolve(
				new Response(JSON.stringify({ data: [{ id: "old-model" }] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			);
			await firstRefresh;
			await secondRefresh;

			expect(registry.getProviderDiscoveryState("race")?.models).toEqual(["new-model"]);
			expect(registry.find("race", "new-model")).toBeDefined();
			expect(registry.find("race", "old-model")).toBeUndefined();
		});

		test("does not invalidate an in-flight full refresh when a provider refresh is queued", async () => {
			writeRawModelsJson({
				"race-a": {
					baseUrl: "https://race-a.example.com/v1",
					api: "openai-completions",
					auth: "none",
					discovery: { type: "openai-models-list" },
				},
				"race-b": {
					baseUrl: "https://race-b.example.com/v1",
					api: "openai-completions",
					auth: "none",
					discovery: { type: "openai-models-list" },
				},
			});
			const firstAResponse = Promise.withResolvers<Response>();
			const firstBResponse = Promise.withResolvers<Response>();
			const firstRequest = Promise.withResolvers<void>();
			let aRequests = 0;
			let bRequests = 0;
			using _hook = hookFetch(input => {
				const url = String(input);
				if (url === "https://race-a.example.com/v1/models") {
					aRequests += 1;
					if (aRequests === 1) {
						firstRequest.resolve();
						return firstAResponse.promise;
					}
					return new Response(JSON.stringify({ data: [{ id: "a-targeted" }] }), { status: 200 });
				}
				if (url === "https://race-b.example.com/v1/models") {
					bRequests += 1;
					if (bRequests === 1) return firstBResponse.promise;
					throw new Error(`Unexpected second race-b request: ${url}`);
				}
				throw new Error(`Unexpected request: ${url}`);
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const fullRefresh = registry.refresh("online");
			await firstRequest.promise;
			const targetedRefresh = registry.refreshProvider("race-a", "online");
			await Bun.sleep(0);
			firstAResponse.resolve(new Response(JSON.stringify({ data: [{ id: "a-full" }] }), { status: 200 }));
			firstBResponse.resolve(new Response(JSON.stringify({ data: [{ id: "b-full" }] }), { status: 200 }));
			await fullRefresh;
			await targetedRefresh;

			expect(registry.find("race-a", "a-targeted")).toBeDefined();
			expect(registry.find("race-a", "a-full")).toBeDefined();
			expect(registry.find("race-b", "b-full")).toBeDefined();
			expect(aRequests).toBe(2);
			expect(bRequests).toBe(1);
		});

		test("does not cache stale configured discovery during overlapping online-if-uncached refreshes", async () => {
			writeRawModelsJson({
				"race-cache": {
					baseUrl: "https://race-cache.example.com/v1",
					api: "openai-completions",
					auth: "none",
					discovery: { type: "openai-models-list" },
				},
			});
			const firstResponse = Promise.withResolvers<Response>();
			const firstRequest = Promise.withResolvers<void>();
			let requests = 0;
			using _hook = hookFetch(input => {
				expect(String(input)).toBe("https://race-cache.example.com/v1/models");
				requests += 1;
				if (requests === 1) {
					firstRequest.resolve();
					return firstResponse.promise;
				}
				return new Response(JSON.stringify({ data: [{ id: "new-configured-model" }] }), { status: 200 });
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const firstRefresh = registry.refreshProvider("race-cache", "online-if-uncached");
			await firstRequest.promise;
			const secondRefresh = registry.refreshProvider("race-cache", "online-if-uncached");
			firstResponse.resolve(
				new Response(JSON.stringify({ data: [{ id: "stale-configured-model" }] }), { status: 200 }),
			);
			await firstRefresh;
			await secondRefresh;

			expect(requests).toBe(2);
			expect(registry.find("race-cache", "new-configured-model")).toBeDefined();
			expect(registry.find("race-cache", "stale-configured-model")).toBeUndefined();
		});

		test("does not cache online full-refresh configured discovery after a targeted refresh is queued", async () => {
			writeRawModelsJson({
				"race-full": {
					baseUrl: "https://race-full.example.com/v1",
					api: "openai-completions",
					auth: "none",
					discovery: { type: "openai-models-list" },
				},
			});
			const firstResponse = Promise.withResolvers<Response>();
			const firstRequest = Promise.withResolvers<void>();
			let requests = 0;
			using _hook = hookFetch(input => {
				expect(String(input)).toBe("https://race-full.example.com/v1/models");
				requests += 1;
				if (requests === 1) {
					firstRequest.resolve();
					return firstResponse.promise;
				}
				return new Response(JSON.stringify({ data: [{ id: "new-full-targeted-model" }] }), { status: 200 });
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const fullRefresh = registry.refresh("online");
			await firstRequest.promise;
			const targetedRefresh = registry.refreshProvider("race-full", "online-if-uncached");
			firstResponse.resolve(new Response(JSON.stringify({ data: [{ id: "stale-full-model" }] }), { status: 200 }));
			await fullRefresh;
			await targetedRefresh;

			expect(requests).toBe(2);
			expect(registry.find("race-full", "new-full-targeted-model")).toBeDefined();
			expect(readModelCache("race-full", 24 * 60 * 60 * 1000, Date.now, cacheDbPath)?.models).toEqual(
				expect.arrayContaining([expect.objectContaining({ id: "new-full-targeted-model" })]),
			);
			expect(readModelCache("race-full", 24 * 60 * 60 * 1000, Date.now, cacheDbPath)?.models).not.toEqual(
				expect.arrayContaining([expect.objectContaining({ id: "stale-full-model" })]),
			);
		});

		test("discovery failure does not fail model registry refresh", async () => {
			writeRawModelsJson({
				ollama: {
					baseUrl: "http://127.0.0.1:11434",
					api: "openai-completions",
					auth: "none",
					discovery: { type: "ollama" },
				},
			});

			using _hook = hookFetch(() => {
				throw new Error("connection refused");
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			await registry.refresh();
			expect(getModelsForProvider(registry, "ollama")).toHaveLength(0);
			expect(registry.getError()).toBeUndefined();
		});
		test("loads cached local models before live refresh and preserves them on failure", async () => {
			writeRawModelsJson({
				ollama: {
					baseUrl: "http://127.0.0.1:11434/v1",
					api: "openai-completions",
					auth: "none",
					discovery: { type: "ollama" },
				},
			});

			{
				using _hook = mockOllamaDiscovery(["phi4-mini"]);
				const primedRegistry = new ModelRegistry(authStorage, modelsJsonPath);
				await primedRegistry.refresh();
			}

			const cachedRegistry = new ModelRegistry(authStorage, modelsJsonPath);
			expect(getModelsForProvider(cachedRegistry, "ollama").some(model => model.id === "phi4-mini")).toBe(true);
			expect(cachedRegistry.getProviderDiscoveryState("ollama")?.status).toBe("cached");

			{
				using _hook = hookFetch(() => {
					throw new Error("connection refused");
				});
				await cachedRegistry.refreshProvider("ollama");
			}

			expect(getModelsForProvider(cachedRegistry, "ollama").some(model => model.id === "phi4-mini")).toBe(true);
			const state = cachedRegistry.getProviderDiscoveryState("ollama");
			expect(state?.status).toBe("cached");
			expect(state?.error).toContain("connection refused");
		});

		test("reports unauthenticated discoverable providers without discarding cached models", async () => {
			writeRawModelsJson({
				"custom-local": {
					baseUrl: "http://127.0.0.1:11434/v1",
					api: "openai-completions",
					discovery: { type: "ollama" },
				},
			});
			authStorage.setRuntimeApiKey("custom-local", "test-key");

			{
				using _hook = hookFetch(input => {
					const url = String(input);
					if (url === "http://127.0.0.1:11434/api/tags") {
						return new Response(JSON.stringify({ models: [{ name: "local-coder" }] }), {
							status: 200,
							headers: { "Content-Type": "application/json" },
						});
					}
					if (url === "http://127.0.0.1:11434/api/show") {
						return new Response(JSON.stringify({ capabilities: ["completion"] }), {
							status: 200,
							headers: { "Content-Type": "application/json" },
						});
					}
					throw new Error(`Unexpected URL: ${url}`);
				});
				const primedRegistry = new ModelRegistry(authStorage, modelsJsonPath);
				await primedRegistry.refreshProvider("custom-local");
			}

			authStorage.setRuntimeApiKey("custom-local", "");
			const cachedRegistry = new ModelRegistry(authStorage, modelsJsonPath);
			await cachedRegistry.refreshProvider("custom-local");

			expect(getModelsForProvider(cachedRegistry, "custom-local").some(model => model.id === "local-coder")).toBe(
				false,
			);
			const state = cachedRegistry.getProviderDiscoveryState("custom-local");
			expect(state?.status).toBe("unauthenticated");
			expect(state?.models).toEqual([]);
		});
		test("llama.cpp discovery honors configured API key", async () => {
			authStorage.setRuntimeApiKey("llama.cpp", "test-llama-key");
			using _hook = hookFetch((input, init) => {
				const url = String(input);
				if (url === "http://127.0.0.1:8080/models") {
					const headers = init?.headers as Headers | Record<string, string> | undefined;
					let authHeader: string | null = null;
					if (headers instanceof Headers) {
						authHeader = headers.get("Authorization");
					} else if (typeof headers === "object") {
						authHeader = headers.Authorization;
					}
					expect(String(authHeader ?? "")).toBe("Bearer test-llama-key");
					return new Response(JSON.stringify({ data: [{ id: "llama-3.2:3b" }, { id: "mistral:7b" }] }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					});
				}
				if (url === "http://127.0.0.1:8080/props") {
					const headers = init?.headers as Headers | Record<string, string> | undefined;
					let authHeader: string | null = null;
					if (headers instanceof Headers) {
						authHeader = headers.get("Authorization");
					} else if (typeof headers === "object") {
						authHeader = headers.Authorization;
					}
					expect(String(authHeader ?? "")).toBe("Bearer test-llama-key");
					return new Response(JSON.stringify({ default_generation_settings: { n_ctx: 262144 } }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					});
				}
				throw new Error(`Unexpected URL: ${url}`);
			});
			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			await registry.refresh();
			const llamaModels = getModelsForProvider(registry, "llama.cpp");
			expect(llamaModels.some(m => m.id === "llama-3.2:3b")).toBe(true);
			expect(llamaModels.every(model => model.headers?.Authorization === undefined)).toBe(true);
			const apiKey = await registry.getApiKey(llamaModels[0]);
			expect(apiKey).toBe("test-llama-key");
			expect(apiKey).not.toBe(kNoAuth);
		});
		test("llama.cpp discovery without API key is treated as keyless", async () => {
			using _hook = hookFetch((input, init) => {
				const url = String(input);
				if (url === "http://127.0.0.1:8080/models") {
					const headers = init?.headers as Headers | Record<string, string> | undefined;
					let authHeader: string | null = null;
					if (headers instanceof Headers) {
						authHeader = headers.get("Authorization");
					} else if (typeof headers === "object") {
						authHeader = headers.Authorization;
					}
					// When no API key, headers should be empty object or undefined
					expect(authHeader).toBeUndefined();
					return new Response(JSON.stringify({ data: [{ id: "llama-3.2:3b" }] }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					});
				}
				if (url === "http://127.0.0.1:8080/props") {
					const headers = init?.headers as Headers | Record<string, string> | undefined;
					let authHeader: string | null = null;
					if (headers instanceof Headers) {
						authHeader = headers.get("Authorization");
					} else if (typeof headers === "object") {
						authHeader = headers.Authorization;
					}
					expect(authHeader).toBeUndefined();
					return new Response(JSON.stringify({ default_generation_settings: { n_ctx: 262144 } }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					});
				}
				throw new Error(`Unexpected URL: ${url}`);
			});
			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			await registry.refresh();
			const state = registry.getProviderDiscoveryState("llama.cpp");
			if (state?.status !== "ok") {
				throw new Error(`Discovery failed with status ${state?.status}: ${state?.error}`);
			}
			const llamaModels = getModelsForProvider(registry, "llama.cpp");
			const apiKey = await registry.getApiKey(llamaModels[0]);
			expect(apiKey).toBe(kNoAuth);
		});
		test("llama.cpp implicit optional auth rechecks credentials added after startup", async () => {
			const restoreLlamaKey = unsetEnvForTest("LLAMA_CPP_API_KEY");
			const restoreLlamaBaseUrl = unsetEnvForTest("LLAMA_CPP_BASE_URL");
			try {
				const registry = new ModelRegistry(authStorage, modelsJsonPath);

				authStorage.setRuntimeApiKey("llama.cpp", "added-after-startup-key");
				using _hook = hookFetch((input, init) => {
					const url = String(input);
					if (url === "http://127.0.0.1:8080/models" || url === "http://127.0.0.1:8080/props") {
						const headers = new Headers(init?.headers);
						expect(headers.get("Authorization")).toBe("Bearer added-after-startup-key");
						if (url.endsWith("/props")) {
							return new Response(JSON.stringify({ default_generation_settings: { n_ctx: 65536 } }), {
								status: 200,
								headers: { "Content-Type": "application/json" },
							});
						}
						return new Response(JSON.stringify({ data: [{ id: "Q29-llama-model" }] }), {
							status: 200,
							headers: { "Content-Type": "application/json" },
						});
					}
					throw new Error(`Unexpected URL: ${url}`);
				});

				await registry.refresh();

				expect(registry.find("llama.cpp", "Q29-llama-model")).toBeDefined();
				expect(registry.getActiveProviders()).toContainEqual({
					provider: "llama.cpp",
					connectionKind: "credential",
				});
			} finally {
				restoreLlamaBaseUrl();
				restoreLlamaKey();
			}
		});
		test("llama.cpp implicit optional auth falls back to credentialless discovery when stored auth is unusable", async () => {
			const restoreLlamaKey = unsetEnvForTest("LLAMA_CPP_API_KEY");
			const restoreLlamaBaseUrl = unsetEnvForTest("LLAMA_CPP_BASE_URL");
			try {
				await authStorage.set("llama.cpp", [
					{
						type: "oauth",
						access: "expired-llama-access",
						refresh: "expired-llama-refresh",
						expires: Date.now() - 60_000,
						email: "llama@example.com",
					},
				]);
				const registry = new ModelRegistry(authStorage, modelsJsonPath);
				expect(await authStorage.peekApiKey("llama.cpp")).toBeUndefined();

				using _hook = hookFetch((input, init) => {
					const url = String(input);
					if (url === "http://127.0.0.1:8080/models" || url === "http://127.0.0.1:8080/props") {
						expect(new Headers(init?.headers).get("Authorization")).toBeNull();
						if (url.endsWith("/props")) {
							return new Response(JSON.stringify({ default_generation_settings: { n_ctx: 65536 } }), {
								status: 200,
								headers: { "Content-Type": "application/json" },
							});
						}
						return new Response(JSON.stringify({ data: [{ id: "Q29-llama-model" }] }), {
							status: 200,
							headers: { "Content-Type": "application/json" },
						});
					}
					throw new Error(`Unexpected URL: ${url}`);
				});

				await registry.refresh();

				expect(registry.find("llama.cpp", "Q29-llama-model")).toBeDefined();
				expect(registry.getActiveProviders()).toContainEqual({
					provider: "llama.cpp",
					connectionKind: "credentialless",
				});
			} finally {
				restoreLlamaBaseUrl();
				restoreLlamaKey();
			}
		});
		test("llama.cpp optional-auth fallback follows credential evidence without a second discovery refresh", async () => {
			const restoreLlamaKey = unsetEnvForTest("LLAMA_CPP_API_KEY");
			const restoreLlamaBaseUrl = unsetEnvForTest("LLAMA_CPP_BASE_URL");
			try {
				authStorage.close();
				authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"), {
					configValueResolver: async () => undefined,
				});
				let unavailable = false;
				await authStorage.set("llama.cpp", [{ type: "api_key", key: "!missing-llama-key" }]);
				const requestApiKeys: string[] = [];
				using _hook = hookFetch((input, init) => {
					const url = String(input);
					if (unavailable) return new Response("unavailable", { status: 503 });
					if (url === "http://127.0.0.1:8080/models" || url === "http://127.0.0.1:8080/props") {
						requestApiKeys.push(new Headers(init?.headers).get("Authorization") ?? "");
						if (url.endsWith("/props")) {
							return new Response(JSON.stringify({ default_generation_settings: { n_ctx: 65536 } }), {
								status: 200,
								headers: { "Content-Type": "application/json" },
							});
						}
						return new Response(JSON.stringify({ data: [{ id: "Q29-fallback-llama-model" }] }), {
							status: 200,
							headers: { "Content-Type": "application/json" },
						});
					}
					throw new Error(`Unexpected URL: ${url}`);
				});
				const registry = new ModelRegistry(authStorage, modelsJsonPath);
				await registry.refreshProvider("llama.cpp", "online");

				const activeLlama = () =>
					registry.getActiveProviders().filter(provider => provider.provider === "llama.cpp");
				expect(activeLlama()).toEqual([{ provider: "llama.cpp", connectionKind: "credentialless" }]);
				await expect(registry.getApiKeyForProvider("llama.cpp")).resolves.toBe(kNoAuth);
				unavailable = true;
				await registry.refreshProvider("llama.cpp", "online");
				expect(registry.getProviderDiscoveryState("llama.cpp")?.status).toBe("cached");
				expect(activeLlama()).toEqual([]);

				unavailable = false;

				authStorage.setRuntimeApiKey("llama.cpp", "added-after-fallback-key");

				expect(activeLlama()).toEqual([]);
				await expect(registry.getApiKeyForProvider("llama.cpp")).resolves.toBe("added-after-fallback-key");

				await registry.refreshProvider("llama.cpp", "online");

				expect(requestApiKeys).toEqual([
					"",
					"",
					"Bearer added-after-fallback-key",
					"Bearer added-after-fallback-key",
				]);
				expect(registry.find("llama.cpp", "Q29-fallback-llama-model")).toBeDefined();
				expect(activeLlama()).toEqual([{ provider: "llama.cpp", connectionKind: "credential" }]);
			} finally {
				restoreLlamaBaseUrl();
				restoreLlamaKey();
			}
		});
		test("llama.cpp optional-auth preflight retries a recovered command credential", async () => {
			const restoreLlamaKey = unsetEnvForTest("LLAMA_CPP_API_KEY");
			const restoreLlamaBaseUrl = unsetEnvForTest("LLAMA_CPP_BASE_URL");
			let resolvedKey: string | undefined;
			try {
				authStorage.close();
				authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"), {
					configValueResolver: async config => (config === "!recovering-llama-key" ? resolvedKey : undefined),
				});
				await authStorage.set("llama.cpp", [{ type: "api_key", key: "!recovering-llama-key" }]);
				const requestApiKeys: string[] = [];
				using _hook = hookFetch((input, init) => {
					const url = String(input);
					if (url === "http://127.0.0.1:8080/models" || url === "http://127.0.0.1:8080/props") {
						requestApiKeys.push(new Headers(init?.headers).get("Authorization") ?? "");
						if (url.endsWith("/props")) {
							return new Response(JSON.stringify({ default_generation_settings: { n_ctx: 65536 } }), {
								status: 200,
								headers: { "Content-Type": "application/json" },
							});
						}
						return new Response(JSON.stringify({ data: [{ id: "recovered-llama-model" }] }), {
							status: 200,
							headers: { "Content-Type": "application/json" },
						});
					}
					throw new Error(`Unexpected URL: ${url}`);
				});

				const registry = new ModelRegistry(authStorage, modelsJsonPath);
				await registry.refreshProvider("llama.cpp", "online");
				expect(registry.getActiveProviders()).toContainEqual({
					provider: "llama.cpp",
					connectionKind: "credentialless",
				});
				await expect(
					registry.getApiKeyForProvider("llama.cpp", undefined, undefined, {
						credentialSelector: { kind: "email", value: "missing@example.com" },
					}),
				).rejects.toThrow("No credential found");

				resolvedKey = "recovered-llama-key";
				await expect(registry.getApiKeyForProvider("llama.cpp")).resolves.toBe("recovered-llama-key");
				await registry.refreshProvider("llama.cpp", "online");

				expect(requestApiKeys).toEqual(["", "", "Bearer recovered-llama-key", "Bearer recovered-llama-key"]);
				expect(registry.getActiveProviders()).toContainEqual({
					provider: "llama.cpp",
					connectionKind: "credential",
				});
			} finally {
				restoreLlamaBaseUrl();
				restoreLlamaKey();
			}
		});
		test("llama.cpp implicit optional auth reuses the preflight credential for discovery", async () => {
			const restoreLlamaKey = unsetEnvForTest("LLAMA_CPP_API_KEY");
			const restoreLlamaBaseUrl = unsetEnvForTest("LLAMA_CPP_BASE_URL");
			try {
				authStorage.close();
				authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"), {
					configValueResolver: async config => (config === "!working-llama-key" ? "working-llama-key" : undefined),
				});
				await authStorage.set("llama.cpp", [
					{ type: "api_key", key: "!working-llama-key" },
					{ type: "api_key", key: "!dangling-llama-key" },
				]);

				const requestApiKeys: string[] = [];
				using _hook = hookFetch((input, init) => {
					const url = String(input);
					if (url === "http://127.0.0.1:8080/models" || url === "http://127.0.0.1:8080/props") {
						requestApiKeys.push(new Headers(init?.headers).get("Authorization") ?? "");
						if (url.endsWith("/props")) {
							return new Response(JSON.stringify({ default_generation_settings: { n_ctx: 65536 } }), {
								status: 200,
								headers: { "Content-Type": "application/json" },
							});
						}
						return new Response(JSON.stringify({ data: [{ id: "preflight-llama-model" }] }), {
							status: 200,
							headers: { "Content-Type": "application/json" },
						});
					}
					throw new Error(`Unexpected URL: ${url}`);
				});

				const registry = new ModelRegistry(authStorage, modelsJsonPath);
				await registry.refresh();

				expect(requestApiKeys).toEqual(["Bearer working-llama-key", "Bearer working-llama-key"]);
				expect(registry.find("llama.cpp", "preflight-llama-model")).toBeDefined();
				expect(registry.getProviderDiscoveryState("llama.cpp")?.status).toBe("ok");
				expect(registry.getActiveProviders()).toContainEqual({
					provider: "llama.cpp",
					connectionKind: "credential",
				});
			} finally {
				restoreLlamaBaseUrl();
				restoreLlamaKey();
			}
		});
		test("llama.cpp optional-auth preflight uses a refresh-aware OAuth credential for discovery", async () => {
			const restoreLlamaKey = unsetEnvForTest("LLAMA_CPP_API_KEY");
			const restoreLlamaBaseUrl = unsetEnvForTest("LLAMA_CPP_BASE_URL");
			try {
				await authStorage.set("llama.cpp", [
					{
						type: "oauth",
						access: "expiring-llama-access",
						refresh: "refresh-llama-access",
						expires: Date.now() + 30_000,
						email: "llama@example.com",
					},
				]);
				const getApiKeySpy = vi.spyOn(authStorage, "getApiKey").mockResolvedValue("refreshed-llama-access");
				const requestApiKeys: string[] = [];
				using _hook = hookFetch((input, init) => {
					const url = String(input);
					if (url === "http://127.0.0.1:8080/models" || url === "http://127.0.0.1:8080/props") {
						requestApiKeys.push(new Headers(init?.headers).get("Authorization") ?? "");
						if (url.endsWith("/props")) {
							return new Response(JSON.stringify({ default_generation_settings: { n_ctx: 65536 } }), {
								status: 200,
								headers: { "Content-Type": "application/json" },
							});
						}
						return new Response(JSON.stringify({ data: [{ id: "refresh-aware-llama-model" }] }), {
							status: 200,
							headers: { "Content-Type": "application/json" },
						});
					}
					throw new Error(`Unexpected URL: ${url}`);
				});
				try {
					const registry = new ModelRegistry(authStorage, modelsJsonPath);
					await registry.refreshProvider("llama.cpp", "online");

					expect(getApiKeySpy).toHaveBeenCalledWith(
						"llama.cpp",
						undefined,
						expect.objectContaining({
							baseUrl: "http://127.0.0.1:8080",
						}),
					);
					expect(requestApiKeys).toEqual(["Bearer refreshed-llama-access", "Bearer refreshed-llama-access"]);
				} finally {
					getApiKeySpy.mockRestore();
				}
			} finally {
				restoreLlamaBaseUrl();
				restoreLlamaKey();
			}
		});
		test("does not retain credentialless fallback after optional OAuth preflight failure", async () => {
			const restoreLlamaKey = unsetEnvForTest("LLAMA_CPP_API_KEY");
			const restoreLlamaBaseUrl = unsetEnvForTest("LLAMA_CPP_BASE_URL");
			try {
				await authStorage.set("llama.cpp", [
					{
						type: "oauth",
						access: "expiring-llama-access",
						refresh: "refresh-llama-access",
						expires: Date.now() + 30_000,
						email: "llama@example.com",
					},
				]);
				const getApiKeySpy = vi
					.spyOn(authStorage, "getApiKey")
					.mockRejectedValueOnce(new Error("transient refresh failure"))
					.mockResolvedValue("recovered-llama-access");
				try {
					const registry = new ModelRegistry(authStorage, modelsJsonPath);
					await registry.refreshProvider("llama.cpp", "online");

					expect(await registry.getApiKeyForProvider("llama.cpp")).toBe("recovered-llama-access");
				} finally {
					getApiKeySpy.mockRestore();
				}
			} finally {
				restoreLlamaBaseUrl();
				restoreLlamaKey();
			}
		});
		test("does not advertise optional discovery after its selected credential is removed", async () => {
			const restoreLlamaKey = unsetEnvForTest("LLAMA_CPP_API_KEY");
			const restoreLlamaBaseUrl = unsetEnvForTest("LLAMA_CPP_BASE_URL");
			try {
				await authStorage.set("llama.cpp", [
					{
						type: "oauth",
						access: "selected-llama-access",
						refresh: "selected-llama-refresh",
						expires: Date.now() + 60_000,
						email: "selected@example.com",
					},
				]);
				authStorage.setRuntimeCredentialSelector("llama.cpp", {
					kind: "email",
					value: "selected@example.com",
				});
				await authStorage.set("llama.cpp", [{ type: "api_key", key: "other-llama-key" }]);
				using _hook = hookFetch(() => {
					throw new Error("optional discovery must not fall back after a selector failure");
				});
				const registry = new ModelRegistry(authStorage, modelsJsonPath);

				await registry.refreshProvider("llama.cpp", "online");

				expect(registry.getActiveProviders().filter(provider => provider.provider === "llama.cpp")).toEqual([]);
				await expect(registry.getApiKeyForProvider("llama.cpp")).rejects.toThrow("No credential found");
			} finally {
				authStorage.removeRuntimeCredentialSelector("llama.cpp");
				restoreLlamaBaseUrl();
				restoreLlamaKey();
			}
		});
		test("serializes optional-auth preflight refresh publication", async () => {
			const restoreLlamaKey = unsetEnvForTest("LLAMA_CPP_API_KEY");
			const restoreLlamaBaseUrl = unsetEnvForTest("LLAMA_CPP_BASE_URL");
			try {
				await authStorage.set("llama.cpp", [
					{
						type: "oauth",
						access: "valid-llama-access",
						refresh: "valid-llama-refresh",
						expires: Date.now() + 60_000,
						email: "llama@example.com",
					},
				]);
				const registry = new ModelRegistry(authStorage, modelsJsonPath);
				const olderCredential = Promise.withResolvers<string | undefined>();
				const newerCredential = Promise.withResolvers<string | undefined>();
				let credentialCalls = 0;
				const credentialSpy = vi.spyOn(authStorage, "getApiKey").mockImplementation(async () => {
					credentialCalls += 1;
					return credentialCalls === 1 ? olderCredential.promise : newerCredential.promise;
				});
				try {
					const olderRefresh = registry.refreshProvider("llama.cpp", "offline");
					while (credentialCalls < 1) await Bun.sleep(0);

					const newerRefresh = registry.refreshProvider("llama.cpp", "offline");
					await Bun.sleep(0);
					expect(credentialCalls).toBe(1);
					olderCredential.resolve("older-preflight-key");
					await olderRefresh;
					while (credentialCalls < 2) await Bun.sleep(0);
					newerCredential.resolve(undefined);
					await newerRefresh;
					expect(await registry.getApiKeyForProvider("llama.cpp")).toBe(kNoAuth);
				} finally {
					credentialSpy.mockRestore();
				}
			} finally {
				restoreLlamaBaseUrl();
				restoreLlamaKey();
			}
		});
		test("credentialless OpenAI-compatible and llama.cpp discovery bypass dangling credential selectors", async () => {
			writeRawModelsJson({
				"credentialless-openai": {
					baseUrl: "https://credentialless-openai.example/v1",
					api: "openai-completions",
					auth: "none",
					discovery: { type: "openai-models-list" },
				},
				"credentialless-llama": {
					baseUrl: "https://credentialless-llama.example/v1",
					api: "openai-completions",
					auth: "none",
					discovery: { type: "llama.cpp" },
				},
			});
			for (const provider of ["credentialless-openai", "credentialless-llama"]) {
				await authStorage.set(provider, [
					{
						type: "oauth",
						access: "stale-access",
						refresh: "stale-refresh",
						expires: Date.now() + 60_000,
						email: `${provider}@example.com`,
					},
				]);
				authStorage.setRuntimeCredentialSelector(provider, {
					kind: "email",
					value: `${provider}@example.com`,
				});
				await authStorage.set(provider, []);
			}

			using _hook = hookFetch(input => {
				const url = String(input);
				if (url === "https://credentialless-openai.example/v1/models") {
					return new Response(JSON.stringify({ data: [{ id: "openai-local-model" }] }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					});
				}
				if (url === "https://credentialless-llama.example/v1/models") {
					return new Response(JSON.stringify({ data: [{ id: "llama-local-model" }] }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					});
				}
				if (url === "https://credentialless-llama.example/props") {
					return new Response(JSON.stringify({ default_generation_settings: { n_ctx: 32768 } }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					});
				}
				throw new Error(`Unexpected URL: ${url}`);
			});
			const getApiKey = vi.spyOn(authStorage, "getApiKey").mockRejectedValue(new Error("dangling selector"));
			try {
				const registry = new ModelRegistry(authStorage, modelsJsonPath);
				await registry.refreshProvider("credentialless-openai", "online");
				await registry.refreshProvider("credentialless-llama", "online");

				expect(registry.find("credentialless-openai", "openai-local-model")).toBeDefined();
				expect(registry.find("credentialless-llama", "llama-local-model")).toBeDefined();
				expect(getApiKey).not.toHaveBeenCalled();
			} finally {
				getApiKey.mockRestore();
			}
		});
		test("llama.cpp discovery reads context window from props n_ctx", async () => {
			using _hook = hookFetch(input => {
				const url = String(input);
				if (url === "http://127.0.0.1:8080/models") {
					return new Response(JSON.stringify({ data: [{ id: "qwen35-35b-a3b" }] }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					});
				}
				if (url === "http://127.0.0.1:8080/props") {
					return new Response(
						JSON.stringify({
							default_generation_settings: {
								n_ctx: 262144,
							},
							modalities: {
								vision: true,
								audio: false,
							},
						}),
						{
							status: 200,
							headers: { "Content-Type": "application/json" },
						},
					);
				}
				throw new Error(`Unexpected URL: ${url}`);
			});
			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			await registry.refresh();
			const llama = registry.find("llama.cpp", "qwen35-35b-a3b");
			expect(llama?.contextWindow).toBe(262144);
			expect(llama?.maxTokens).toBe(8192);
			expect(llama?.input).toEqual(["text", "image"]);
		});
	});
	describe("bundled Anthropic catalog availability", () => {
		test("includes native Opus 4.7 in available models when Anthropic auth exists", async () => {
			await authStorage.set("anthropic", [{ type: "api_key", key: "sk-ant-api-test" }]);

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			await registry.refresh("offline");

			expect(
				registry.getAvailable().some(model => model.provider === "anthropic" && model.id === "claude-opus-4-7"),
			).toBe(true);
		});
	});
	describe("disableStrictTools", () => {
		test("custom provider with models gets disableStrictTools merged into compat", () => {
			writeRawModelsJson({
				"bedrock-anthropic": {
					baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com/anthropic",
					apiKey: "TEST_KEY",
					api: "anthropic-messages",
					disableStrictTools: true,
					models: [
						{
							id: "claude-sonnet-4-20250514",
							name: "Claude Sonnet 4",
							reasoning: false,
							input: ["text", "image"],
							cost: { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 },
							contextWindow: 200000,
							maxTokens: 16384,
						},
					],
				},
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const model = registry.find("bedrock-anthropic", "claude-sonnet-4-20250514");

			expect(model).toBeDefined();
			expect((model?.compat as { disableStrictTools?: boolean } | undefined)?.disableStrictTools).toBe(true);
		});

		test("disableStrictTools on override-only provider applies to built-in models", () => {
			writeRawModelsJson({ anthropic: { disableStrictTools: true } });

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const models = getModelsForProvider(registry, "anthropic");

			expect(models.length).toBeGreaterThan(0);
			for (const model of models) {
				expect((model.compat as { disableStrictTools?: boolean } | undefined)?.disableStrictTools).toBe(true);
			}
		});

		test("disableStrictTools is absent on built-in models without override", () => {
			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const models = getModelsForProvider(registry, "anthropic");

			expect(models.length).toBeGreaterThan(0);
			for (const model of models) {
				expect((model.compat as { disableStrictTools?: boolean } | undefined)?.disableStrictTools).toBeUndefined();
			}
		});

		test("disableStrictTools is merged with explicit compat on custom provider", () => {
			writeRawModelsJson({
				"my-proxy": {
					baseUrl: "https://proxy.example.com/anthropic",
					apiKey: "TEST_KEY",
					api: "anthropic-messages",
					disableStrictTools: true,
					models: [
						{
							id: "claude-sonnet-4",
							name: "Sonnet",
							reasoning: false,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 200000,
							maxTokens: 16384,
						},
					],
				},
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const model = registry.find("my-proxy", "claude-sonnet-4");

			expect(model).toBeDefined();
			expect((model?.compat as { disableStrictTools?: boolean } | undefined)?.disableStrictTools).toBe(true);
		});
	});
	describe("Anthropic prompt-cache compatibility", () => {
		test("propagates provider, model, and override prompt-cache settings", () => {
			writeRawModelsJson({
				"proxy-anthropic": {
					baseUrl: "https://proxy.example.com/anthropic",
					apiKey: "TEST_KEY",
					api: "anthropic-messages",
					compat: { promptCacheMode: "explicit", supportsLongCacheRetention: false },
					models: [
						{ id: "claude-inherited" },
						{
							id: "claude-model-override",
							compat: { promptCacheMode: "automatic", supportsLongCacheRetention: true },
						},
						{ id: "claude-provider-override" },
					],
					modelOverrides: {
						"claude-provider-override": { compat: { promptCacheMode: "none" } },
					},
				},
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const inherited = registry.find("proxy-anthropic", "claude-inherited");
			const modelOverride = registry.find("proxy-anthropic", "claude-model-override");
			const providerOverride = registry.find("proxy-anthropic", "claude-provider-override");

			expect(inherited?.compat).toMatchObject({
				promptCacheMode: "explicit",
				supportsLongCacheRetention: false,
			});
			expect(modelOverride?.compat).toMatchObject({
				promptCacheMode: "automatic",
				supportsLongCacheRetention: true,
			});
			expect(providerOverride?.compat).toMatchObject({
				promptCacheMode: "none",
				supportsLongCacheRetention: false,
			});
		});
	});

	describe("provider auth: oauth", () => {
		test("models from a provider with auth: oauth are marked isOAuth=true", async () => {
			writeRawModelsJson({
				"proxy-anthropic": {
					baseUrl: "https://proxy.example.com",
					apiKey: "literal-key",
					api: "anthropic-messages",
					auth: "oauth",
					models: [
						{
							id: "claude-sonnet-4-5",
							name: "Claude Sonnet 4.5",
							reasoning: true,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 200000,
							maxTokens: 8000,
						},
					],
				},
			});
			await authStorage.setRuntimeApiKey("proxy-anthropic", "literal-key");

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			await registry.refresh("offline");

			const model = registry.find("proxy-anthropic", "claude-sonnet-4-5");
			expect(model).toBeDefined();
			expect(model?.isOAuth).toBe(true);
		});

		test("anthropic-messages providers default to isOAuth=true even without explicit auth", async () => {
			writeRawModelsJson({
				"proxy-anthropic": {
					baseUrl: "https://proxy.example.com",
					apiKey: "literal-key",
					api: "anthropic-messages",
					models: [
						{
							id: "claude-sonnet-4-5",
							name: "Claude Sonnet 4.5",
							reasoning: true,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 200000,
							maxTokens: 8000,
						},
					],
				},
			});
			await authStorage.setRuntimeApiKey("proxy-anthropic", "literal-key");

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			await registry.refresh("offline");

			const model = registry.find("proxy-anthropic", "claude-sonnet-4-5");
			expect(model).toBeDefined();
			expect(model?.isOAuth).toBe(true);
		});

		test("auth: apiKey opts out of the anthropic-messages default", async () => {
			writeRawModelsJson({
				"proxy-anthropic": {
					baseUrl: "https://proxy.example.com",
					apiKey: "literal-key",
					api: "anthropic-messages",
					auth: "apiKey",
					models: [
						{
							id: "claude-sonnet-4-5",
							name: "Claude Sonnet 4.5",
							reasoning: true,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 200000,
							maxTokens: 8000,
						},
					],
				},
			});
			await authStorage.setRuntimeApiKey("proxy-anthropic", "literal-key");

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			await registry.refresh("offline");

			const model = registry.find("proxy-anthropic", "claude-sonnet-4-5");
			expect(model).toBeDefined();
			expect(model?.isOAuth).toBeUndefined();
		});

		test("non-anthropic apis do not get the OAuth default", async () => {
			writeRawModelsJson({
				"proxy-openai": {
					baseUrl: "https://proxy.example.com/v1",
					apiKey: "literal-key",
					api: "openai-completions",
					models: [
						{
							id: "gpt-5",
							name: "GPT-5",
							reasoning: true,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 200000,
							maxTokens: 8000,
						},
					],
				},
			});
			await authStorage.setRuntimeApiKey("proxy-openai", "literal-key");

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			await registry.refresh("offline");

			const model = registry.find("proxy-openai", "gpt-5");
			expect(model).toBeDefined();
			expect(model?.isOAuth).toBeUndefined();
		});
	});

	test("cached discovery with UNK contextWindow preserves bundled value", () => {
		// Configure openai as a discoverable provider through models.json
		writeRawModelsJson({
			openai: {
				baseUrl: "https://my-proxy.example.com/v1",
				apiKey: "TEST_KEY",
				api: "openai-completions",
				discovery: { type: "openai-models-list" },
				models: [],
			},
		});
		// Pre-populate the cache with a model that has UNK sentinel values
		// (simulating a discovery that didn't return limit.context)
		writeModelCache<"openai-completions">(
			"openai",
			Date.now(),
			[
				{
					id: "gpt-4o",
					name: "GPT-4o",
					api: "openai-completions",
					provider: "openai",
					baseUrl: "https://my-proxy.example.com/v1",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 222_222, // UNK_CONTEXT_WINDOW
					maxTokens: 8_888, // UNK_MAX_TOKENS
				},
			],
			true,
			cacheDbPath,
		);
		const registry = new ModelRegistry(authStorage, modelsJsonPath);
		const model = registry.find("openai", "gpt-4o");

		expect(model).toBeDefined();
		// The bundled gpt-4o has a correct contextWindow, not the UNK sentinel
		expect(model!.contextWindow).not.toBe(222_222);
		expect(model!.contextWindow).toBeGreaterThan(100_000);
		expect(model!.maxTokens).not.toBe(8_888);
		expect(model!.maxTokens).toBeGreaterThan(1000);
	});

	test("loads cached standard provider discovery models on startup", () => {
		const cachedModel: Model<"ollama-chat"> = {
			id: "deepseek-v4-pro",
			name: "DeepSeek V4 Pro",
			api: "ollama-chat",
			provider: "ollama-cloud",
			baseUrl: "https://ollama.com",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1_000_000,
			maxTokens: 384_000,
		};
		writeModelCache("ollama-cloud", Date.now(), [cachedModel], true, "", cacheDbPath);

		const registry = new ModelRegistry(authStorage, modelsJsonPath);

		expect(registry.find("ollama-cloud", "deepseek-v4-pro")).toBeUndefined();
	});

	test("normalizes cached Muse Spark discovery metadata through shared policy", () => {
		const cachedModel: Model<"openai-completions"> = {
			id: "meta/muse-spark-1.2",
			name: "Meta: Muse Spark 1.2",
			api: "openai-completions",
			provider: "kilo",
			baseUrl: "https://api.kilo.ai/api/gateway",
			reasoning: false,
			input: ["text", "image"],
			cost: { input: 1.25, output: 4.25, cacheRead: 0.15, cacheWrite: 0 },
			contextWindow: 1_048_576,
			maxTokens: 131_072,
		};
		writeModelCache("kilo", Date.now(), [cachedModel], true, "", cacheDbPath);

		const registry = new ModelRegistry(authStorage, modelsJsonPath);

		// Kilo has a bundled static entry; its normalization remains independent
		// of the rejected legacy cache row.
		expect(registry.find("kilo", "meta/muse-spark-1.2")).toMatchObject({
			reasoning: true,
			thinking: { mode: "effort", minLevel: Effort.Minimal, maxLevel: Effort.XHigh },
		});
	});

	test("normalizes configured discovery Muse caches through shared policy", () => {
		writeRawModelsJson({
			"muse-proxy": {
				baseUrl: "https://proxy.example/v1",
				apiKey: "TEST_KEY",
				api: "openai-completions",
				discovery: { type: "openai-models-list" },
			},
		});
		const cachedModel: Model<"openai-completions"> = {
			id: "meta/muse-spark-1.2",
			name: "Meta: Muse Spark 1.2",
			api: "openai-completions",
			provider: "muse-proxy",
			baseUrl: "https://proxy.example/v1",
			reasoning: false,
			input: ["text", "image"],
			cost: { input: 1.25, output: 4.25, cacheRead: 0.15, cacheWrite: 0 },
			contextWindow: 1_048_576,
			maxTokens: 131_072,
		};
		writeModelCache("muse-proxy", Date.now(), [cachedModel], true, "", cacheDbPath);

		const registry = new ModelRegistry(authStorage, modelsJsonPath);

		expect(registry.find("muse-proxy", "meta/muse-spark-1.2")).toBeUndefined();
	});

	test("preserves request shaping and wire aliases when replacing a built-in model", () => {
		writeRawModelsJson({
			openai: {
				baseUrl: "https://proxy.example/v1",
				apiKey: "TEST_KEY",
				api: "openai-completions",
				requestTransform: { setHeaders: { "x-provider": "provider" } },
				models: [
					{
						id: "gpt-4o-mini",
						wireModelId: "proxy-gpt-4o-mini",
						reasoning: false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 128000,
						maxTokens: 16384,
						requestTransform: { extraBody: { routed: true } },
					},
				],
			},
		});

		const registry = new ModelRegistry(authStorage, modelsJsonPath);
		const model = registry.find("openai", "gpt-4o-mini");

		expect(model?.wireModelId).toBe("proxy-gpt-4o-mini");
		expect(model?.requestTransform).toEqual({
			setHeaders: { "x-provider": "provider" },
			extraBody: { routed: true },
		});
	});

	test("loads request shaping, wire aliases, thinking metadata, and model bindings from models config", async () => {
		await Settings.init({
			inMemory: true,
			overrides: {
				modelRoles: { default: "openai/gpt-4o-mini" },
				"task.agentModelOverrides": { executor: "openai/gpt-4o-mini" },
			},
		});
		writeRawModelsConfig({
			modelBindings: {
				modelRoles: { default: "proxy/local-selector:high" },
				agentModelOverrides: { executor: "proxy/executor-selector" },
			},
			providers: {
				proxy: {
					baseUrl: "https://proxy.example/v1",
					apiKey: "TEST_KEY",
					api: "openai-completions",
					requestTransform: {
						profile: "openai-proxy",
						stripHeaders: ["x-provider-strip"],
						setHeaders: { "x-provider": "provider" },
						extraBody: { providerBody: true },
					},
					models: [
						{
							id: "local-selector",
							wireModelId: "upstream-wire-id",
							name: "Local Selector",
							reasoning: true,
							thinking: {
								minLevel: "low",
								maxLevel: "xhigh",
								mode: "effort",
								defaultLevel: "high",
								levels: ["low", "high", "xhigh"],
							},
							compat: { supportsReasoningEffort: true },
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 128000,
							maxTokens: 16384,
							requestTransform: {
								setHeaders: { "x-model": "model" },
								extraBody: { providerBody: false, modelBody: "yes" },
							},
						},
					],
				},
			},
		});

		const registry = new ModelRegistry(authStorage, modelsJsonPath);
		registry.applyConfiguredModelBindings(Settings.instance);
		const model = registry.find("proxy", "local-selector");

		expect(model?.wireModelId).toBe("upstream-wire-id");
		expect(model?.thinking?.defaultLevel).toBe(Effort.High);
		expect(model?.thinking?.levels).toEqual([Effort.Low, Effort.High, Effort.XHigh]);
		expect(model?.requestTransform).toEqual({
			profile: "openai-proxy",
			stripHeaders: ["x-provider-strip"],
			setHeaders: { "x-provider": "provider", "x-model": "model" },
			extraBody: { providerBody: false, modelBody: "yes" },
		});
		expect(Settings.instance.getModelRole("default")).toBe("proxy/local-selector:high");
		expect(Settings.instance.get("task.agentModelOverrides").executor).toBe("proxy/executor-selector");
	});

	test("applies full fallback chains from model bindings", async () => {
		await Settings.init({ inMemory: true });
		writeRawModelsConfig({
			modelBindings: {
				modelRoles: { default: ["proxy/primary", "proxy/fallback"] },
				agentModelOverrides: { executor: ["proxy/executor", "proxy/executor-fallback"] },
			},
			providers: {
				proxy: providerConfig("https://proxy.example/v1", [{ id: "primary" }], "openai-completions"),
			},
		});

		const registry = new ModelRegistry(authStorage, modelsJsonPath);
		registry.applyConfiguredModelBindings(Settings.instance);

		expect(Settings.instance.get("modelRoles").default).toEqual(["proxy/primary", "proxy/fallback"]);
		expect(Settings.instance.get("task.agentModelOverrides").executor).toEqual([
			"proxy/executor",
			"proxy/executor-fallback",
		]);
	});

	test("defers model bindings until settings are initialized", () => {
		writeRawModelsConfig({
			modelBindings: {
				modelRoles: { default: "proxy/local-selector:high" },
			},
			providers: {
				proxy: providerConfig(
					"https://proxy.example/v1",
					[{ id: "local-selector", reasoning: true }],
					"openai-completions",
				),
			},
		});

		expect(() => new ModelRegistry(authStorage, modelsJsonPath)).not.toThrow();
	});

	test("removes stale model bindings after config removal or partial replacement", async () => {
		await Settings.init({
			inMemory: true,
			overrides: {
				modelRoles: { default: "openai/gpt-4o-mini", smol: "openai/gpt-4o-mini" },
				"task.agentModelOverrides": { executor: "openai/gpt-4o-mini", architect: "openai/gpt-4o-mini" },
			},
		});
		writeRawModelsConfig({
			modelBindings: {
				modelRoles: { default: "proxy/local-selector:high", smol: "proxy/local-selector:low" },
				agentModelOverrides: { executor: "proxy/executor-selector", architect: "proxy/architect-selector" },
			},
			providers: {
				proxy: providerConfig(
					"https://proxy.example/v1",
					[{ id: "local-selector", reasoning: true }],
					"openai-completions",
				),
			},
		});

		const registry = new ModelRegistry(authStorage, modelsJsonPath);
		registry.applyConfiguredModelBindings(Settings.instance);
		expect(Settings.instance.getModelRole("default")).toBe("proxy/local-selector:high");
		expect(Settings.instance.getModelRole("smol")).toBe("proxy/local-selector:low");
		expect(Settings.instance.get("task.agentModelOverrides").executor).toBe("proxy/executor-selector");
		expect(Settings.instance.get("task.agentModelOverrides").architect).toBe("proxy/architect-selector");

		writeRawModelsConfig({
			modelBindings: {
				modelRoles: { smol: "proxy/local-selector:medium" },
				agentModelOverrides: { architect: "proxy/architect-selector-v2" },
			},
			providers: {
				proxy: providerConfig(
					"https://proxy.example/v1",
					[{ id: "local-selector", reasoning: true }],
					"openai-completions",
				),
			},
		});
		await Bun.sleep(5);
		await registry.refresh("online-if-uncached");
		expect(Settings.instance.getModelRole("default")).toBe("openai/gpt-4o-mini");
		expect(Settings.instance.getModelRole("smol")).toBe("proxy/local-selector:medium");
		expect(Settings.instance.get("task.agentModelOverrides").executor).toBe("openai/gpt-4o-mini");
		expect(Settings.instance.get("task.agentModelOverrides").architect).toBe("proxy/architect-selector-v2");

		writeRawModelsConfig({
			providers: {
				proxy: providerConfig(
					"https://proxy.example/v1",
					[{ id: "local-selector", reasoning: true }],
					"openai-completions",
				),
			},
		});
		await Bun.sleep(5);
		await registry.refresh("online-if-uncached");
		expect(Settings.instance.getModelRole("default")).toBe("openai/gpt-4o-mini");
		expect(Settings.instance.getModelRole("smol")).toBe("openai/gpt-4o-mini");
		expect(Settings.instance.get("task.agentModelOverrides").executor).toBe("openai/gpt-4o-mini");
		expect(Settings.instance.get("task.agentModelOverrides").architect).toBe("openai/gpt-4o-mini");
	});

	test("preserves user model binding changes across refresh and config removal", async () => {
		await Settings.init({
			inMemory: true,
			overrides: {
				modelRoles: { default: "openai/gpt-4o-mini" },
				"task.agentModelOverrides": { executor: "openai/gpt-4o-mini" },
			},
		});
		writeRawModelsConfig({
			modelBindings: {
				modelRoles: { default: "proxy/local-selector:high" },
				agentModelOverrides: { executor: "proxy/executor-selector" },
			},
			providers: {
				proxy: providerConfig(
					"https://proxy.example/v1",
					[{ id: "local-selector", reasoning: true }],
					"openai-completions",
				),
			},
		});

		const registry = new ModelRegistry(authStorage, modelsJsonPath);
		registry.applyConfiguredModelBindings(Settings.instance);
		expect(Settings.instance.getModelRole("default")).toBe("proxy/local-selector:high");
		expect(Settings.instance.get("task.agentModelOverrides").executor).toBe("proxy/executor-selector");

		Settings.instance.override("modelRoles", { default: "user/default-choice" });
		Settings.instance.override("task.agentModelOverrides", { executor: "user/executor-choice" });
		await registry.refresh("online-if-uncached");
		expect(Settings.instance.getModelRole("default")).toBe("user/default-choice");
		expect(Settings.instance.get("task.agentModelOverrides").executor).toBe("user/executor-choice");

		writeRawModelsConfig({
			providers: {
				proxy: providerConfig(
					"https://proxy.example/v1",
					[{ id: "local-selector", reasoning: true }],
					"openai-completions",
				),
			},
		});
		await Bun.sleep(5);
		await registry.refresh("online-if-uncached");
		expect(Settings.instance.getModelRole("default")).toBe("user/default-choice");
		expect(Settings.instance.get("task.agentModelOverrides").executor).toBe("user/executor-choice");
	});

	test("applies provider request shaping to discovered and cached models", async () => {
		writeRawModelsJson({
			proxy: {
				baseUrl: "https://proxy.example/v1",
				apiKey: "TEST_KEY",
				api: "openai-completions",
				discovery: { type: "openai-models-list" },
				requestTransform: {
					profile: "openai-proxy",
					setHeaders: { "x-proxy": "enabled" },
					extraBody: { proxy: true },
				},
			},
		});
		using _hook = mockOpenAiCompatibleModels("https://proxy.example/v1/models", ["proxy-model"]);

		const registry = new ModelRegistry(authStorage, modelsJsonPath);
		await registry.refresh("online");

		expect(registry.find("proxy", "proxy-model")?.requestTransform).toEqual({
			profile: "openai-proxy",
			setHeaders: { "x-proxy": "enabled" },
			extraBody: { proxy: true },
		});

		writeModelCache<"openai-completions">(
			"proxy",
			Date.now(),
			[
				{
					id: "cached-proxy-model",
					name: "cached-proxy-model",
					api: "openai-completions",
					provider: "proxy",
					baseUrl: "https://proxy.example/v1",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 128000,
					maxTokens: 8192,
					requestTransform: { setHeaders: { "x-stale": "old" } },
				},
			],
			true,
			"",
			cacheDbPath,
		);

		const cachedRegistry = new ModelRegistry(authStorage, modelsJsonPath);
		expect(cachedRegistry.find("proxy", "cached-proxy-model")).toBeUndefined();

		writeRawModelsJson({
			proxy: {
				baseUrl: "https://proxy.example/v1",
				apiKey: "TEST_KEY",
				api: "openai-completions",
				discovery: { type: "openai-models-list" },
			},
		});
		const unshapedCachedRegistry = new ModelRegistry(authStorage, modelsJsonPath);
		expect(unshapedCachedRegistry.find("proxy", "cached-proxy-model")?.requestTransform).toBeUndefined();
	});

	test("rejects request shaping on non-OpenAI-compatible APIs", () => {
		writeRawModelsConfig({
			providers: {
				bad: {
					baseUrl: "https://bad.example/v1",
					apiKey: "TEST_KEY",
					api: "anthropic-messages",
					requestTransform: { extraBody: { proxy: true } },
					models: [
						{
							id: "anthropic-model",
							name: "Anthropic Model",
							reasoning: false,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 128000,
							maxTokens: 16384,
						},
					],
				},
			},
		});

		const registry = new ModelRegistry(authStorage, modelsJsonPath);
		expect(String(registry.getError()?.message)).toContain(
			'"requestTransform" is only supported with openai-completions or openai-responses APIs',
		);
	});

	test("rejects unknown provider and model config keys before provider dispatch", () => {
		writeRawModelsConfig({
			providers: {
				layofflabs: {
					baseUrl: "https://api.layofflabs.com/v1",
					apiKeyEnv: "OPENAI_API_KEY",
					api: "openai-completions",
					auth: "apiKey",
					requestTransform: { profile: "openai-proxy" },
					models: [
						{
							id: "gpt-5.5",
							name: "GPT 5.5 via Layofflabs",
							reasoning: true,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 400000,
							maxTokens: 128000,
							unsupportedModelKey: true,
						},
					],
					unsupportedProviderKey: true,
				},
			},
		});

		const registry = new ModelRegistry(authStorage, modelsJsonPath);
		const message = String(registry.getError()?.message);

		expect(message).toContain("/providers/layofflabs");
		expect(message).toContain("unsupportedProviderKey");
		expect(message).toContain("/providers/layofflabs/models/0");
		expect(message).toContain("unsupportedModelKey");
	});

	test("rejects model-level request shaping on non-OpenAI-compatible APIs", () => {
		writeRawModelsConfig({
			providers: {
				bad: {
					baseUrl: "https://bad.example/v1",
					apiKey: "TEST_KEY",
					api: "anthropic-messages",
					models: [
						{
							id: "anthropic-model",
							name: "Anthropic Model",
							reasoning: false,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 128000,
							maxTokens: 16384,
							requestTransform: { extraBody: { proxy: true } },
						},
					],
				},
			},
		});

		const registry = new ModelRegistry(authStorage, modelsJsonPath);
		expect(String(registry.getError()?.message)).toContain(
			'model "requestTransform" is only supported with openai-completions or openai-responses APIs',
		);
	});

	test("rejects provider-only request shaping on non-OpenAI-compatible built-ins", () => {
		writeRawModelsConfig({
			providers: {
				anthropic: {
					requestTransform: { extraBody: { proxy: true } },
				},
			},
		});

		const registry = new ModelRegistry(authStorage, modelsJsonPath);
		expect(String(registry.getError()?.message)).toContain(
			'"requestTransform" is only supported with openai-completions or openai-responses APIs',
		);
	});

	test("rejects runtime provider-only request shaping without an OpenAI-compatible API", () => {
		const registry = new ModelRegistry(authStorage, modelsJsonPath);

		expect(() =>
			registry.registerProvider("anthropic", {
				baseUrl: "https://proxy.example/v1",
				apiKey: "TEST_KEY",
				requestTransform: { extraBody: { proxy: true } },
			}),
		).toThrow('"requestTransform" is only supported with openai-completions or openai-responses APIs');
	});

	test("restores resolved runtime provider keys ahead of stored OAuth after a static reload", async () => {
		const envName = "GJC_TEST_RUNTIME_PROVIDER_RELOAD_KEY";
		const restoreKey = setEnvForTest(envName, "resolved-runtime-provider-key");
		try {
			await authStorage.set("runtime-proxy", [
				{
					type: "oauth",
					access: "stored-oauth-access",
					refresh: "stored-oauth-refresh",
					expires: Date.now() + 60_000,
				},
			]);
			writeRawModelsJson({
				"runtime-proxy": {
					...providerConfig("https://static-proxy.example/v1", [{ id: "static-model" }], "openai-completions"),
					apiKey: "static-provider-key-before",
				},
			});
			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			registry.registerProvider("runtime-proxy", {
				baseUrl: "https://runtime-proxy.example/v1",
				apiKey: envName,
				api: "openai-completions",
				models: [
					{
						id: "runtime-model",
						name: "Runtime Model",
						reasoning: false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 100_000,
						maxTokens: 8_000,
					},
				],
			});

			await expect(registry.getApiKeyForProvider("runtime-proxy")).resolves.toBe("resolved-runtime-provider-key");
			writeRawModelsJson({
				"runtime-proxy": {
					...providerConfig("https://static-proxy.example/v1", [{ id: "static-model" }], "openai-completions"),
					apiKey: "static-provider-key-after",
				},
			});
			await registry.refresh("offline");
			await expect(registry.getApiKeyForProvider("runtime-proxy")).resolves.toBe("resolved-runtime-provider-key");
			expect(registry.getEffectiveProviderAuth("runtime-proxy")).toBe("key");
		} finally {
			restoreKey();
		}
	});

	test("materializes a resolved runtime apiKey in auth headers", async () => {
		const envName = "GJC_TEST_RUNTIME_AUTH_HEADER_KEY";
		const restoreKey = setEnvForTest(envName, "resolved-runtime-auth-key");
		try {
			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			registry.registerProvider("runtime-auth", {
				baseUrl: "https://runtime-auth.example/v1",
				api: "openai-completions",
				apiKey: envName,
				authHeader: true,
				models: [
					{
						id: "runtime-auth-model",
						name: "Runtime Auth Model",
						reasoning: false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 100_000,
						maxTokens: 8_000,
					},
				],
			});

			expect(registry.find("runtime-auth", "runtime-auth-model")?.headers?.Authorization).toBe(
				"Bearer resolved-runtime-auth-key",
			);
			Bun.env[envName] = "rotated-runtime-auth-key";
			writeRawModelsJson({});
			await registry.refresh("offline");
			expect(registry.find("runtime-auth", "runtime-auth-model")?.headers?.Authorization).toBe(
				"Bearer rotated-runtime-auth-key",
			);
		} finally {
			restoreKey();
		}
	});

	test("rejects model override request shaping on non-OpenAI-compatible models", () => {
		writeRawModelsConfig({
			providers: {
				anthropic: {
					modelOverrides: {
						"claude-sonnet-4-5": {
							requestTransform: { extraBody: { proxy: true } },
						},
					},
				},
			},
		});

		const registry = new ModelRegistry(authStorage, modelsJsonPath);
		expect(String(registry.getError()?.message)).toContain(
			'modelOverrides "requestTransform" is only supported with openai-completions or openai-responses APIs',
		);
	});

	test("applies provider-only request shaping overrides without models", () => {
		writeRawModelsConfig({
			providers: {
				openai: {
					requestTransform: {
						profile: "openai-proxy",
						setHeaders: { "x-proxy": "enabled" },
						extraBody: { proxy: true },
					},
				},
			},
		});

		const registry = new ModelRegistry(authStorage, modelsJsonPath);
		const model = registry.find("openai", "gpt-4o-mini");

		expect(model?.requestTransform).toEqual({
			profile: "openai-proxy",
			setHeaders: { "x-proxy": "enabled" },
			extraBody: { proxy: true },
		});
	});

	test("applies model override request shaping on OpenAI-compatible models", () => {
		writeRawModelsConfig({
			providers: {
				openai: {
					modelOverrides: {
						"gpt-4o-mini": {
							wireModelId: "proxy-gpt-4o-mini",
							requestTransform: { extraBody: { routed: true } },
						},
					},
				},
			},
		});

		const registry = new ModelRegistry(authStorage, modelsJsonPath);
		const model = registry.find("openai", "gpt-4o-mini");

		expect(model?.wireModelId).toBe("proxy-gpt-4o-mini");
		expect(model?.requestTransform).toEqual({ extraBody: { routed: true } });
	});
	test("rejects responses affinity on known non-target providers", () => {
		writeRawModelsConfig({
			providers: {
				anthropic: {
					baseUrl: "https://relay.example.com/v1",
					api: "openai-responses",
					compat: { supportsResponsesSessionAffinity: true },
				},
			},
		});

		const registry = new ModelRegistry(authStorage, modelsJsonPath);
		expect(String(registry.getError()?.message)).toContain("only supported for the openai provider");
	});

	test.each([
		"https://api.openai.com",
		"https://api.openai.com/v1",
		"https://api.openai.com/",
	])("rejects unknown-provider responses affinity on a canonical OpenAI base URL %s", baseUrl => {
		writeRawModelsConfig({
			providers: {
				relay: {
					baseUrl,
					api: "openai-responses",
					compat: { supportsResponsesSessionAffinity: true },
				},
			},
		});

		const registry = new ModelRegistry(authStorage, modelsJsonPath);
		expect(String(registry.getError()?.message)).toContain("requires a genuinely custom base URL");
	});
	test("rejects unknown-provider responses affinity without a base URL", () => {
		writeRawModelsConfig({
			providers: {
				relay: {
					api: "openai-responses",
					compat: { supportsResponsesSessionAffinity: true },
				},
			},
		});

		const registry = new ModelRegistry(authStorage, modelsJsonPath);
		expect(String(registry.getError()?.message)).toContain("requires a genuinely custom base URL");
	});
	test("rejects responses affinity on non-Responses APIs", () => {
		writeRawModelsConfig({
			providers: {
				relay: {
					baseUrl: "https://relay.example.com/v1",
					apiKey: "TEST_KEY",
					api: "openai-completions",
					compat: { supportsResponsesSessionAffinity: true },
				},
			},
		});

		const registry = new ModelRegistry(authStorage, modelsJsonPath);
		expect(String(registry.getError()?.message)).toContain("only supported with the openai-responses API");
	});

	test("rejects provider affinity inherited by a non-Responses model API", () => {
		writeRawModelsConfig({
			providers: {
				relay: {
					baseUrl: "https://relay.example.com/v1",
					api: "openai-responses",
					apiKey: "TEST_KEY",
					compat: { supportsResponsesSessionAffinity: true },
					models: [{ id: "chat-model", api: "openai-completions" }],
				},
			},
		});

		const registry = new ModelRegistry(authStorage, modelsJsonPath);
		expect(String(registry.getError()?.message)).toContain("only supported with the openai-responses API");
	});
	describe("generic local OpenAI-compatible provider config", () => {
		test("does not add a generic local provider by default", () => {
			const registry = new ModelRegistry(authStorage, modelsJsonPath);

			expect(getModelsForProvider(registry, "local")).toHaveLength(0);
			expect(registry.getProviderBaseUrl("local")).toBeUndefined();
		});

		test("parses providers.local.openaiCompat and discovers OpenAI-compatible models", async () => {
			writeRawModelsJson({
				local: {
					openaiCompat: {
						baseUrl: "http://127.0.0.1:1234",
						apiKey: "LOCAL_TEST_KEY",
					},
				},
			});
			using _hook = hookFetch((input, init) => {
				const url = String(input);
				if (url !== "http://127.0.0.1:1234/v1/models") {
					throw new Error(`Unexpected URL: ${url}`);
				}
				expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer LOCAL_TEST_KEY");
				return new Response(JSON.stringify({ data: [{ id: "local-model" }] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			await registry.refresh();
			const model = registry.find("local", "local-model");

			expect(model?.api).toBe("openai-completions");
			expect(model?.baseUrl).toBe("http://127.0.0.1:1234/v1");
			expect(getOpenAICompat(model)?.supportsStore).toBe(false);
			expect(await registry.getApiKeyForProvider("local")).toBe("LOCAL_TEST_KEY");
		});
		test("uses stored credentials for OpenAI-compatible providers without inline auth", async () => {
			await authStorage.set("local", [{ type: "api_key", key: "STORED_TEST_KEY" }]);
			writeRawModelsJson({
				local: {
					openaiCompat: {
						baseUrl: "http://127.0.0.1:1234",
					},
				},
			});
			using _hook = hookFetch((input, init) => {
				expect(String(input)).toBe("http://127.0.0.1:1234/v1/models");
				expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer STORED_TEST_KEY");
				return new Response(JSON.stringify({ data: [{ id: "local-model" }] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			await registry.refresh();

			// Rows are scoped to the local fixture (hermetic pattern from #3207) so
			// ambient host credentials (e.g. OPENAI_API_KEY) enabling unrelated bundled
			// providers cannot change this provider's credential/discovery activity.
			expect(activeRowsFor(registry, ["local"])).toEqual([{ provider: "local", connectionKind: "credential" }]);
			expect(await registry.getApiKeyForProvider("local")).toBe("STORED_TEST_KEY");
			await authStorage.set("local", []);

			expect(registry.find("local", "local-model")).toBeDefined();
			expect(activeRowsFor(registry, ["local"])).toEqual([]);
		});
	});
	/** Active-provider rows scoped to fixture providers only (excludes ambient host providers). */
	const activeRowsFor = (registry: ModelRegistry, providerIds: readonly string[]) => {
		const selected = new Set(providerIds);
		return registry.getActiveProviders().filter(provider => selected.has(provider.provider));
	};
	describe("active provider resolution", () => {
		test("rechecks non-fingerprinted environment credentials for active providers", () => {
			const previous = process.env.GITLAB_TOKEN;
			delete process.env.GITLAB_TOKEN;
			try {
				writeRawModelsJson({
					"gitlab-duo": {
						baseUrl: "https://gitlab.example.com/v1",
						api: "openai-completions",
						models: [{ id: "duo-chat" }],
					},
				});
				const registry = new ModelRegistry(authStorage, modelsJsonPath);
				expect(registry.getAvailable().some(model => model.provider === "gitlab-duo")).toBe(false);
				expect(activeRowsFor(registry, ["gitlab-duo"])).toEqual([]);

				process.env.GITLAB_TOKEN = "gitlab-token";
				expect(activeRowsFor(registry, ["gitlab-duo"])).toEqual([
					{ provider: "gitlab-duo", connectionKind: "credential" },
				]);

				delete process.env.GITLAB_TOKEN;
				expect(activeRowsFor(registry, ["gitlab-duo"])).toEqual([]);
			} finally {
				if (previous === undefined) delete process.env.GITLAB_TOKEN;
				else process.env.GITLAB_TOKEN = previous;
			}
		});
		test("does not advertise a static optional provider after its selected credential is removed", async () => {
			writeRawModelsJson({
				local: {
					openaiCompat: { baseUrl: "http://127.0.0.1:1234" },
					models: [{ id: "static-local-model" }],
				},
			});
			await authStorage.set("local", [
				{
					type: "oauth",
					access: "selected-local-access",
					refresh: "selected-local-refresh",
					expires: Date.now() + 60_000,
					email: "selected@example.com",
				},
			]);
			authStorage.setRuntimeCredentialSelector("local", {
				kind: "email",
				value: "selected@example.com",
			});
			await authStorage.set("local", [{ type: "api_key", key: "other-local-key" }]);
			try {
				const registry = new ModelRegistry(authStorage, modelsJsonPath);

				expect(activeRowsFor(registry, ["local"])).toEqual([]);
				await expect(registry.getApiKeyForProvider("local")).rejects.toThrow("No credential found");
			} finally {
				authStorage.removeRuntimeCredentialSelector("local");
			}
		});
		test("keeps credentialless discovery active with an irrelevant dangling selector", async () => {
			writeRawModelsJson({
				"credentialless-provider": {
					baseUrl: "https://credentialless.example.com/v1",
					api: "openai-responses",
					auth: "none",
					discovery: { type: "openai-models-list" },
				},
			});
			await authStorage.set("credentialless-provider", [
				{
					type: "oauth",
					access: "stale-access",
					refresh: "stale-refresh",
					expires: Date.now() + 60_000,
					email: "stale@example.com",
				},
			]);
			authStorage.setRuntimeCredentialSelector("credentialless-provider", {
				kind: "email",
				value: "stale@example.com",
			});

			using _hook = hookFetch(input => {
				expect(String(input)).toBe("https://credentialless.example.com/v1/models");
				return new Response(JSON.stringify({ data: [{ id: "credentialless-model" }] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			});
			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			await registry.refreshProvider("credentialless-provider", "online");
			await authStorage.set("credentialless-provider", []);

			// Rows are scoped to the fixture provider (hermetic pattern from #3207)
			// so ambient host credentials enabling unrelated bundled providers cannot
			// affect this provider's credentialless discovery activity.
			expect(activeRowsFor(registry, ["credentialless-provider"])).toEqual([
				{ provider: "credentialless-provider", connectionKind: "credentialless" },
			]);
			expect(registry.getAvailable().some(model => model.provider === "credentialless-provider")).toBe(true);
			await expect(registry.getApiKeyForProvider("credentialless-provider")).resolves.toBe(kNoAuth);
		});
		test("resolves active providers from credentials and configured credentialless models without I/O", () => {
			writeRawModelsJson({
				"zeta.provider": {
					baseUrl: "https://zeta.example.com/v1",
					api: "openai-responses",
					apiKey: "ZETA_KEY",
					models: [{ id: "zeta-model" }],
				},
				"alpha-provider": {
					baseUrl: "https://alpha.example.com/v1",
					api: "openai-responses",
					apiKey: "ALPHA_KEY",
					models: [{ id: "alpha-model" }],
				},
				"local-provider": {
					baseUrl: "http://127.0.0.1:1234/v1",
					api: "openai-responses",
					auth: "none",
					models: [{ id: "local-model" }],
				},
			});
			using _hook = hookFetch(() => {
				throw new Error("active-provider resolution must not perform I/O");
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			expect(activeRowsFor(registry, ["alpha-provider", "local-provider", "zeta.provider"])).toEqual([
				{ provider: "alpha-provider", connectionKind: "credential" },
				{ provider: "local-provider", connectionKind: "credentialless" },
				{ provider: "zeta.provider", connectionKind: "credential" },
			]);
		});
		test("keeps bundled credentialed providers active when discovery is configured", () => {
			writeRawModelsJson({
				openai: {
					baseUrl: "https://openai.example.com/v1",
					apiKey: "OPENAI_TEST_KEY",
					api: "openai-completions",
					discovery: { type: "openai-models-list" },
					models: [],
				},
			});
			using _hook = hookFetch(() => {
				throw new Error("active-provider resolution must not perform discovery I/O");
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);

			expect(registry.getProviderDiscoveryState("openai")?.status).toBe("idle");
			expect(registry.find("openai", "gpt-4o-mini")).toBeDefined();
			expect(activeRowsFor(registry, ["openai"])).toEqual([{ provider: "openai", connectionKind: "credential" }]);
		});
		test("excludes bundled providers when the selected stored key resolver returns undefined", async () => {
			authStorage.close();
			const restoreAnthropicKey = unsetEnvForTest("ANTHROPIC_API_KEY");
			const restoreAnthropicToken = unsetEnvForTest("ANTHROPIC_OAUTH_TOKEN");
			authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"), {
				configValueResolver: async () => undefined,
			});
			await authStorage.set("anthropic", [{ type: "api_key", key: "!missing-anthropic-key" }]);

			try {
				const registry = new ModelRegistry(authStorage, modelsJsonPath);
				await registry.refresh();

				expect(registry.getAll().some(model => model.provider === "anthropic")).toBe(true);
				expect(activeRowsFor(registry, ["anthropic"])).toEqual([]);
			} finally {
				restoreAnthropicKey();
				restoreAnthropicToken();
			}
		});
		test("tracks credential addition, replacement, removal, dedupe, and registry-only exclusions", async () => {
			writeRawModelsJson({
				"tracked-provider": {
					baseUrl: "https://tracked.example.com/v1",
					api: "openai-responses",
					apiKeyEnv: "GJC_TEST_MISSING_TRACKED_PROVIDER_KEY",
					models: [{ id: "tracked-model" }],
				},
			});
			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const trackedRows = () => activeRowsFor(registry, ["tracked-provider"]);

			expect(registry.find("tracked-provider", "tracked-model")).toBeDefined();
			expect(trackedRows()).toEqual([]);
			authStorage.setRuntimeApiKey("tracked-provider", "");
			expect(trackedRows()).toEqual([]);

			await authStorage.set("tracked-provider", [
				{ type: "api_key", key: "account-a" },
				{ type: "api_key", key: "account-b" },
			]);
			expect(trackedRows()).toEqual([{ provider: "tracked-provider", connectionKind: "credential" }]);

			await authStorage.set("tracked-provider", [{ type: "api_key", key: "replacement" }]);
			expect(trackedRows()).toEqual([{ provider: "tracked-provider", connectionKind: "credential" }]);

			authStorage.setRuntimeApiKey("unknown-provider", "unknown-provider-key");
			expect(registry.getActiveProviders().some(provider => provider.provider === "unknown-provider")).toBe(false);

			await authStorage.set("tracked-provider", []);
			expect(trackedRows()).toEqual([]);
		});

		test("does not advertise a fresh configured-discovery cache reused without a probe", async () => {
			const cachedModel: Model<"openai-responses"> = {
				id: "cached-model",
				name: "Cached Model",
				api: "openai-responses",
				provider: "discovery-provider",
				baseUrl: "http://127.0.0.1:1234/v1",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 8192,
			};
			writeRawModelsJson({
				"discovery-provider": {
					baseUrl: "http://127.0.0.1:1234/v1",
					api: "openai-responses",
					apiKey: "DISCOVERY_KEY",
					discovery: { type: "openai-models-list" },
				},
			});
			writeModelCache("discovery-provider", Date.now(), [cachedModel], true, "", cacheDbPath);
			using _hook = hookFetch(() => {
				throw new Error("online-if-uncached must reuse the fresh cache");
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			expect(registry.getProviderDiscoveryState("discovery-provider")?.status).toBe("idle");
			expect(activeRowsFor(registry, ["discovery-provider"])).toEqual([]);
			await registry.refreshProvider("discovery-provider", "online-if-uncached");
			expect(registry.getProviderDiscoveryState("discovery-provider")?.status).toBe("unavailable");
			expect(activeRowsFor(registry, ["discovery-provider"])).toEqual([]);
		});
		test("advertises credentialless cached discovery without credential evidence", () => {
			const cachedModel: Model<"openai-responses"> = {
				id: "cached-model",
				name: "Cached Model",
				api: "openai-responses",
				provider: "credentialless-provider",
				baseUrl: "http://127.0.0.1:1234/v1",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 8192,
			};
			writeRawModelsJson({
				"credentialless-provider": {
					baseUrl: "http://127.0.0.1:1234/v1",
					api: "openai-responses",
					auth: "none",
					discovery: { type: "openai-models-list" },
				},
			});
			writeModelCache("credentialless-provider", Date.now(), [cachedModel], true, "", cacheDbPath);

			const registry = new ModelRegistry(authStorage, modelsJsonPath);

			expect(registry.getProviderDiscoveryState("credentialless-provider")?.status).toBe("idle");
			expect(activeRowsFor(registry, ["credentialless-provider"])).toEqual([]);
		});
		test("normalizes cached LM Studio root endpoints for custom providers", () => {
			const cachedModel: Model<"openai-completions"> = {
				id: "cached-model",
				name: "Cached Model",
				api: "openai-completions",
				provider: "custom-lm-studio",
				baseUrl: "http://127.0.0.1:1234/v1",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 8192,
			};
			writeRawModelsJson({
				"custom-lm-studio": {
					baseUrl: "http://127.0.0.1:1234",
					api: "openai-completions",
					auth: "none",
					discovery: { type: "lm-studio" },
				},
			});
			writeModelCache("custom-lm-studio", Date.now(), [cachedModel], true, "", cacheDbPath);

			const registry = new ModelRegistry(authStorage, modelsJsonPath);

			expect(activeRowsFor(registry, ["custom-lm-studio"])).toEqual([]);
		});
		test("advertises configured vLLM cached discovery without descriptor evidence", () => {
			const cachedModel: Model<"openai-completions"> = {
				id: "cached-model",
				name: "Cached Model",
				api: "openai-completions",
				provider: "vllm",
				baseUrl: "http://127.0.0.1:8000/v1",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 8192,
			};
			writeRawModelsJson({
				vllm: {
					baseUrl: "http://127.0.0.1:8000/v1",
					api: "openai-completions",
					auth: "none",
					discovery: { type: "openai-models-list" },
				},
			});
			writeModelCache("vllm", Date.now(), [cachedModel], true, "", cacheDbPath);

			const registry = new ModelRegistry(authStorage, modelsJsonPath);

			expect(registry.getProviderDiscoveryState("vllm")?.status).toBe("idle");
			expect(activeRowsFor(registry, ["vllm"])).toEqual([]);
		});
		test("does not advertise credentialless cached discovery from an obsolete endpoint", () => {
			const cachedModel: Model<"openai-responses"> = {
				id: "cached-model",
				name: "Cached Model",
				api: "openai-responses",
				provider: "credentialless-provider",
				baseUrl: "http://127.0.0.1:1234/v1",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 8192,
			};
			writeRawModelsJson({
				"credentialless-provider": {
					baseUrl: "http://127.0.0.1:5678/v1",
					api: "openai-responses",
					auth: "none",
					discovery: { type: "openai-models-list" },
				},
			});
			writeModelCache("credentialless-provider", Date.now(), [cachedModel], true, "", cacheDbPath);

			const registry = new ModelRegistry(authStorage, modelsJsonPath);

			expect(registry.getProviderDiscoveryState("credentialless-provider")?.status).toBe("idle");
			expect(activeRowsFor(registry, ["credentialless-provider"])).toEqual([]);
		});
		test("does not advertise cached Ollama models without credentialless discovery provenance", () => {
			const restoreBaseUrl = setEnvForTest("OLLAMA_BASE_URL", "http://127.0.0.1:11434");
			const restoreApiKey = unsetEnvForTest("OLLAMA_API_KEY");
			try {
				const cachedModel: Model<"openai-completions"> = {
					id: "cached-ollama-model",
					name: "Cached Ollama Model",
					api: "openai-completions",
					provider: "ollama",
					baseUrl: "http://127.0.0.1:11434/v1",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 128000,
					maxTokens: 8192,
				};
				writeModelCache("ollama", Date.now(), [cachedModel], true, "", cacheDbPath);

				const registry = new ModelRegistry(authStorage, modelsJsonPath);

				expect(registry.getProviderDiscoveryState("ollama")?.status).toBe("idle");
				expect(activeRowsFor(registry, ["ollama"])).toEqual([]);
			} finally {
				restoreApiKey();
				restoreBaseUrl();
			}
		});
		test("does not advertise cached LM Studio models without credentialless discovery provenance", () => {
			const restoreBaseUrl = setEnvForTest("LM_STUDIO_BASE_URL", "http://127.0.0.1:1234");
			const restoreApiKey = unsetEnvForTest("LM_STUDIO_API_KEY");
			try {
				const cachedModel: Model<"openai-completions"> = {
					id: "cached-lm-studio-model",
					name: "Cached LM Studio Model",
					api: "openai-completions",
					provider: "lm-studio",
					baseUrl: "http://127.0.0.1:1234/v1",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 128000,
					maxTokens: 8192,
				};
				writeModelCache("lm-studio", Date.now(), [cachedModel], true, "", cacheDbPath);

				const registry = new ModelRegistry(authStorage, modelsJsonPath);

				expect(registry.getProviderDiscoveryState("lm-studio")?.status).toBe("idle");
				expect(activeRowsFor(registry, ["lm-studio"])).toEqual([]);
			} finally {
				restoreApiKey();
				restoreBaseUrl();
			}
		});
		test("keeps signed LM Studio endpoint queries out of the model cache", async () => {
			const restoreBaseUrl = setEnvForTest("LM_STUDIO_BASE_URL", "https://lm-studio.example?sig=lm-studio-secret");
			const restoreApiKey = unsetEnvForTest("LM_STUDIO_API_KEY");
			try {
				using _hook = hookFetch(input => {
					expect(String(input)).toBe("https://lm-studio.example/v1/models?sig=lm-studio-secret");
					return new Response(JSON.stringify({ data: [{ id: "lm-studio-model" }] }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					});
				});
				const registry = new ModelRegistry(authStorage, modelsJsonPath);

				await registry.refreshProvider("lm-studio", "online");

				expect(registry.find("lm-studio", "lm-studio-model")?.baseUrl).toBe(
					"https://lm-studio.example?sig=lm-studio-secret",
				);
				const cached = readModelCache<Api>("lm-studio", 24 * 60 * 60 * 1000, Date.now, cacheDbPath);
				expect(cached?.models[0]?.baseUrl).toBe("https://lm-studio.example/v1");
				expect(cached?.dynamicModelProvenance).toStartWith("gajae:non-cacheable-configured:");
				expect(JSON.stringify(cached)).not.toContain("lm-studio-secret");
			} finally {
				restoreApiKey();
				restoreBaseUrl();
			}
		});
		test("records configured discovery evidence after resolving a stored command key", async () => {
			authStorage.close();
			authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"), {
				configValueResolver: async config => (config === "!discovery-key" ? "resolved-discovery-key" : undefined),
			});
			writeRawModelsJson({
				"discovery-provider": {
					baseUrl: "https://discovery.example.com/v1",
					api: "openai-responses",
					discovery: { type: "openai-models-list" },
				},
			});
			await authStorage.set("discovery-provider", [{ type: "api_key", key: "!discovery-key" }]);
			using _hook = hookFetch(
				() =>
					new Response(JSON.stringify({ data: [{ id: "discovered-model" }] }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					}),
			);
			const registry = new ModelRegistry(authStorage, modelsJsonPath);

			await registry.refreshProvider("discovery-provider", "online");

			expect(activeRowsFor(registry, ["discovery-provider"])).toEqual([
				{ provider: "discovery-provider", connectionKind: "credential" },
			]);
			await registry.refreshProvider("discovery-provider", "online-if-uncached");

			expect(registry.getProviderDiscoveryState("discovery-provider")?.status).toBe("ok");
			expect(activeRowsFor(registry, ["discovery-provider"])).toEqual([
				{ provider: "discovery-provider", connectionKind: "credential" },
			]);
		});
		test("forces an online configured discovery probe after the credential changes", async () => {
			writeRawModelsJson({
				"discovery-provider": {
					baseUrl: "https://discovery.example.com/v1",
					api: "openai-responses",
					discovery: { type: "openai-models-list" },
				},
			});
			authStorage.setRuntimeApiKey("discovery-provider", "credential-a");
			let requests = 0;
			using _hook = hookFetch(() => {
				requests++;
				return new Response(JSON.stringify({ data: [{ id: `discovered-model-${requests}` }] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			});
			const registry = new ModelRegistry(authStorage, modelsJsonPath);

			await registry.refreshProvider("discovery-provider", "online");
			authStorage.setRuntimeApiKey("discovery-provider", "credential-b");
			await registry.refreshProvider("discovery-provider", "online-if-uncached");

			expect(requests).toBe(2);
			expect(registry.find("discovery-provider", "discovered-model-2")).toBeDefined();
			expect(activeRowsFor(registry, ["discovery-provider"])).toEqual([
				{ provider: "discovery-provider", connectionKind: "credential" },
			]);
		});
		test("reuses a fresh configured discovery cache with zero fetches on provider-tab revisit", async () => {
			writeRawModelsJson({
				"discovery-provider": {
					baseUrl: "https://discovery.example.com/v1",
					api: "openai-responses",
					discovery: { type: "openai-models-list" },
				},
			});
			authStorage.setRuntimeApiKey("discovery-provider", "credential-a");
			let requests = 0;
			using _hook = hookFetch(() => {
				requests++;
				return new Response(JSON.stringify({ data: [{ id: "discovered-model" }] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			});
			const registry = new ModelRegistry(authStorage, modelsJsonPath);

			await registry.refreshProvider("discovery-provider", "online-if-uncached");
			expect(requests).toBeGreaterThan(0);
			expect(registry.find("discovery-provider", "discovered-model")).toBeDefined();

			// Same credentials and endpoint: the published provenance fingerprint
			// matches, so a fresh-cache revisit must not touch the network.
			const requestsAfterFetch = requests;
			await registry.refreshProvider("discovery-provider", "online-if-uncached");

			expect(requests).toBe(requestsAfterFetch);
			expect(registry.find("discovery-provider", "discovered-model")).toBeDefined();
			const state = registry.getProviderDiscoveryState("discovery-provider");
			expect(state?.status).toBe("ok");
			// Cache-served revisit reports the cache row's fetch time, not "now".
			const row = readModelCache(
				"discovery-provider",
				24 * 60 * 60 * 1000,
				Date.now,
				path.join(tempDir, "models.db"),
			);
			expect(state?.fetchedAt).toBe(row?.updatedAt);
		});

		test("restores non-secret provider transport headers on cached configured-discovery models after a reboot", async () => {
			writeRawModelsJson({
				"discovery-provider": {
					baseUrl: "https://discovery.example.com/v1",
					api: "openai-responses",
					auth: "none",
					discovery: { type: "openai-models-list" },
					headers: { "X-Tenant-Id": "tenant-a" },
				},
			});
			using _hook = hookFetch(
				() =>
					new Response(JSON.stringify({ data: [{ id: "discovered-model" }] }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					}),
			);
			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			await registry.refreshProvider("discovery-provider", "online-if-uncached");
			const liveModel = registry.find("discovery-provider", "discovered-model");
			expect(liveModel?.headers?.["X-Tenant-Id"]).toBe("tenant-a");
			// The persisted cache row itself is header-sanitized.
			const row = readModelCache(
				"discovery-provider",
				24 * 60 * 60 * 1000,
				Date.now,
				path.join(tempDir, "models.db"),
			);
			expect(row?.models[0]?.headers?.["X-Tenant-Id"]).toBeUndefined();

			// A rebooted registry serves the same cache row synchronously and must
			// re-derive the provider transport override, so the model keeps its
			// non-secret request headers without waiting for an online refetch.
			const rebooted = new ModelRegistry(authStorage, modelsJsonPath);
			const rebootedModel = rebooted.find("discovery-provider", "discovered-model");
			expect(rebootedModel).toBeDefined();
			expect(rebootedModel?.headers?.["X-Tenant-Id"]).toBe("tenant-a");
		});
		test("re-fetches configured discovery when an effective request header changes under constant credential and endpoint", async () => {
			const discoveryConfigWithHeaders = (headers: Record<string, string>) => ({
				"discovery-provider": {
					baseUrl: "https://discovery.example.com/v1",
					api: "openai-responses",
					discovery: { type: "openai-models-list" },
					headers,
				},
			});
			writeRawModelsJson(discoveryConfigWithHeaders({ "X-Tenant-Id": "tenant-a" }));
			authStorage.setRuntimeApiKey("discovery-provider", "credential-a");
			let requests = 0;
			const seenTenantHeaders: Array<string | null> = [];
			using _hook = hookFetch((_input, init) => {
				requests++;
				seenTenantHeaders.push(new Headers(init?.headers).get("X-Tenant-Id"));
				return new Response(JSON.stringify({ data: [{ id: "discovered-model" }] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			});
			const registry = new ModelRegistry(authStorage, modelsJsonPath);

			await registry.refreshProvider("discovery-provider", "online-if-uncached");
			expect(requests).toBeGreaterThan(0);
			expect(seenTenantHeaders.at(-1)).toBe("tenant-a");
			const requestsBeforeHeaderChange = requests;

			// Same credential and endpoint, different tenant header: the cached
			// catalog was discovered under a different effective request context,
			// so the published provenance must not vouch for it — a fresh-cache
			// visit has to re-fetch instead of serving the old tenant's models.
			writeRawModelsJson(discoveryConfigWithHeaders({ "X-Tenant-Id": "tenant-b" }));
			const rebootedRegistry = new ModelRegistry(authStorage, modelsJsonPath);
			await rebootedRegistry.refreshProvider("discovery-provider", "online-if-uncached");

			expect(requests).toBeGreaterThan(requestsBeforeHeaderChange);
			expect(seenTenantHeaders.at(-1)).toBe("tenant-b");
		});
		test("never persists secret-header-derived provenance and fails closed on cache reuse", async () => {
			const secretHeaders = [
				"aUtHoRiZaTiOn",
				"X-API-KEY",
				"Cookie",
				"X-Custom-Service-Token",
				"X-AuthToken",
				"X-ClientSecret",
				"X-DbPassword",
				"X-ServiceCredential",
				"X-CustomApiKey",
				"X-Access-Key",
				"X-Auth",
				"X-Functions-Key",
				"X-Signature",
				"X-AccessKey",
				"X-SignatureV1",
				"CF-Access-Jwt-Assertion",
				"X-Hockey-Team",
				"X-Monkey-Id",
				"X-Vendor-Nonce",
			];
			for (const headerName of secretHeaders) {
				const config = (value: string) => ({
					"discovery-provider": {
						baseUrl: "https://discovery.example.com/v1",
						api: "openai-responses",
						discovery: { type: "openai-models-list" },
						headers: { [headerName]: value },
					},
				});
				writeRawModelsJson(config("pin-0001"));
				authStorage.setRuntimeApiKey("discovery-provider", "credential-a");
				let requests = 0;
				using _hook = hookFetch(() => {
					requests++;
					return new Response(JSON.stringify({ data: [{ id: `secret-model-${requests}` }] }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					});
				});

				const registry = new ModelRegistry(authStorage, modelsJsonPath);
				await registry.refreshProvider("discovery-provider", "online-if-uncached");
				const row = readModelCache("discovery-provider", 24 * 60 * 60 * 1000, Date.now, cacheDbPath);
				const authEvidence = authStorage.getProviderEvidenceGeneration("discovery-provider", "credential-a");
				const candidateDigests = ["pin-0000", "pin-0001", "pin-0002"].map(value =>
					crypto
						.createHash("sha256")
						.update("gajae:model-discovery-provenance\0")
						.update(
							JSON.stringify({
								authEvidence,
								endpoint: "https://discovery.example.com/v1;authority=",
								headers: [[headerName.toLowerCase(), value]],
								discoveryType: "openai-models-list",
								api: "openai-responses",
								apiByModelPrefix: [],
								modelsDevProvider: "",
							}),
						)
						.digest("hex"),
				);
				expect(candidateDigests).not.toContain(row?.dynamicModelProvenance);
				expect(row?.dynamicModelProvenance).toStartWith("gajae:non-cacheable-configured:");
				expect(JSON.stringify(row?.models)).not.toContain("pin-0001");
				expect(row?.models.every(model => model.headers === undefined)).toBe(true);

				const requestsAfterFirstFetch = requests;
				const offlineRegistry = new ModelRegistry(authStorage, modelsJsonPath);
				await offlineRegistry.refreshProvider("discovery-provider", "offline");
				expect(requests).toBe(requestsAfterFirstFetch);
				expect(offlineRegistry.find("discovery-provider", "secret-model-1")).toBeUndefined();

				const sameSecretRegistry = new ModelRegistry(authStorage, modelsJsonPath);
				await sameSecretRegistry.refreshProvider("discovery-provider", "online-if-uncached");
				expect(requests).toBeGreaterThan(requestsAfterFirstFetch);

				writeRawModelsJson(config("pin-0002"));
				const changedSecretRegistry = new ModelRegistry(authStorage, modelsJsonPath);
				const requestsBeforeChange = requests;
				await changedSecretRegistry.refreshProvider("discovery-provider", "online-if-uncached");
				expect(requests).toBeGreaterThan(requestsBeforeChange);
			}
		}, 60_000);
		test("does not expose a prior non-secret cache after switching to secret headers offline", async () => {
			const config = (headers: Record<string, string>) => ({
				"discovery-provider": {
					baseUrl: "https://discovery.example.com/v1",
					api: "openai-responses",
					discovery: { type: "openai-models-list" },
					headers,
				},
			});
			writeRawModelsJson(config({ "X-Tenant-Id": "tenant-a" }));
			authStorage.setRuntimeApiKey("discovery-provider", "credential-a");
			using _hook = hookFetch(
				() =>
					new Response(JSON.stringify({ data: [{ id: "prior-tenant-model" }] }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					}),
			);
			const first = new ModelRegistry(authStorage, modelsJsonPath);
			await first.refreshProvider("discovery-provider", "online");
			expect(first.find("discovery-provider", "prior-tenant-model")).toBeDefined();

			writeRawModelsJson(config({ Authorization: "Bearer pin-0001" }));
			const secretContext = new ModelRegistry(authStorage, modelsJsonPath);
			await secretContext.refreshProvider("discovery-provider", "offline");
			expect(secretContext.find("discovery-provider", "prior-tenant-model")).toBeUndefined();
		});
		test("removes already-published secret-context models on same-registry offline refresh", async () => {
			writeRawModelsJson({
				"discovery-provider": {
					baseUrl: "https://discovery.example.com/v1",
					api: "openai-responses",
					discovery: { type: "openai-models-list" },
					headers: { Authorization: "Bearer pin-0001" },
				},
			});
			authStorage.setRuntimeApiKey("discovery-provider", "credential-a");
			using _hook = hookFetch(
				() =>
					new Response(JSON.stringify({ data: [{ id: "secret-live-model" }] }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					}),
			);
			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			await registry.refreshProvider("discovery-provider", "online");
			expect(registry.find("discovery-provider", "secret-live-model")).toBeDefined();
			await registry.refreshProvider("discovery-provider", "offline");
			expect(registry.find("discovery-provider", "secret-live-model")).toBeUndefined();
		});
		test("preserves bundled same-id models when secret-context dynamic rows are cleared", async () => {
			writeRawModelsJson({
				anthropic: {
					baseUrl: "https://discovery.example.com/v1",
					api: "anthropic-messages",
					discovery: { type: "openai-models-list" },
					headers: { Authorization: "Bearer pin-0001" },
				},
			});
			authStorage.setRuntimeApiKey("anthropic", "credential-a");
			using _hook = hookFetch(
				() =>
					new Response(JSON.stringify({ data: [{ id: "claude-sonnet-4-5" }] }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					}),
			);
			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			await registry.refreshProvider("anthropic", "online");
			expect(registry.find("anthropic", "claude-sonnet-4-5")).toBeDefined();
			await registry.refreshProvider("anthropic", "offline");
			expect(registry.find("anthropic", "claude-sonnet-4-5")).toBeDefined();
		});
		test("keeps audited non-secret request-shaping headers cacheable", async () => {
			for (const headerName of ["X-Tenant-Id", "X-Project-Id", "OpenAI-Organization"]) {
				writeRawModelsJson({
					"discovery-provider": {
						baseUrl: "https://discovery.example.com/v1",
						api: "openai-responses",
						discovery: { type: "openai-models-list" },
						headers: { [headerName]: "team-a" },
					},
				});
				authStorage.setRuntimeApiKey("discovery-provider", "credential-a");
				let requests = 0;
				using _hook = hookFetch(() => {
					requests++;
					return new Response(JSON.stringify({ data: [{ id: "cacheable-model" }] }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					});
				});

				const first = new ModelRegistry(authStorage, modelsJsonPath);
				await first.refreshProvider("discovery-provider", "online-if-uncached");
				const requestsAfterFirstFetch = requests;
				const second = new ModelRegistry(authStorage, modelsJsonPath);
				await second.refreshProvider("discovery-provider", "online-if-uncached");
				expect(requests).toBe(requestsAfterFirstFetch);
				expect(second.find("discovery-provider", "cacheable-model")).toBeDefined();
			}
		});
		test("never persists userinfo-derived provenance or reuses its cache", async () => {
			const config = (baseUrl: string) => ({
				"discovery-provider": {
					baseUrl,
					api: "openai-responses",
					discovery: { type: "openai-models-list" },
				},
			});
			writeRawModelsJson(config("https://tenant-a:tenant-a-secret@discovery.example.com/v1"));
			authStorage.setRuntimeApiKey("discovery-provider", "credential-a");
			let requests = 0;
			using _hook = hookFetch(() => {
				requests++;
				return new Response(JSON.stringify({ data: [{ id: "userinfo-model" }] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			});
			const firstRegistry = new ModelRegistry(authStorage, modelsJsonPath);
			await firstRegistry.refreshProvider("discovery-provider", "online-if-uncached");
			const requestsAfterFirstFetch = requests;
			expect(
				readModelCache("discovery-provider", 24 * 60 * 60 * 1000, Date.now, cacheDbPath)?.dynamicModelProvenance,
			).toStartWith("gajae:non-cacheable-configured:");

			const sameContextRegistry = new ModelRegistry(authStorage, modelsJsonPath);
			await sameContextRegistry.refreshProvider("discovery-provider", "online-if-uncached");
			expect(requests).toBeGreaterThan(requestsAfterFirstFetch);
			expect(sameContextRegistry.find("discovery-provider", "userinfo-model")).toBeDefined();
			const offlineRegistry = new ModelRegistry(authStorage, modelsJsonPath);
			await offlineRegistry.refreshProvider("discovery-provider", "offline");
			expect(offlineRegistry.find("discovery-provider", "userinfo-model")).toBeUndefined();

			await Bun.sleep(10);
			writeRawModelsJson(config("https://tenant-b:tenant-b-secret@discovery.example.com/v1"));
			const changedContextRegistry = new ModelRegistry(authStorage, modelsJsonPath);
			await changedContextRegistry.refreshProvider("discovery-provider", "online-if-uncached");
			expect(requests).toBeGreaterThan(requestsAfterFirstFetch + 1);
		}, 120_000);
		test("does not serve the previous tenant's cached models when a provenance-forced refetch fails", async () => {
			const discoveryConfigWithHeaders = (headers: Record<string, string>) => ({
				"discovery-provider": {
					baseUrl: "https://discovery.example.com/v1",
					api: "openai-responses",
					discovery: { type: "openai-models-list" },
					headers,
				},
			});
			writeRawModelsJson(discoveryConfigWithHeaders({ "X-Tenant-Id": "tenant-a" }));
			authStorage.setRuntimeApiKey("discovery-provider", "credential-a");
			let failSubsequentFetches = false;
			using _hook = hookFetch((_input, _init) => {
				if (failSubsequentFetches) {
					return new Response("service unavailable", { status: 503 });
				}
				return new Response(JSON.stringify({ data: [{ id: "tenant-a-model" }] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			});
			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			await registry.refreshProvider("discovery-provider", "online-if-uncached");
			expect(getModelsForProvider(registry, "discovery-provider").map(model => model.id)).toContain(
				"tenant-a-model",
			);

			// Switch tenants, then make the forced refetch fail. The cached rows
			// belong to tenant A's discovery context; the mismatched provenance
			// must keep them out of the selectable catalog — stale-while-error
			// never crosses a provenance boundary.
			writeRawModelsJson(discoveryConfigWithHeaders({ "X-Tenant-Id": "tenant-b" }));
			failSubsequentFetches = true;
			const rebootedRegistry = new ModelRegistry(authStorage, modelsJsonPath);
			await rebootedRegistry.refreshProvider("discovery-provider", "online-if-uncached");
			expect(getModelsForProvider(rebootedRegistry, "discovery-provider").map(model => model.id)).not.toContain(
				"tenant-a-model",
			);
		});
		test("refreshes configured discovery when round-robin credentials change", async () => {
			writeRawModelsJson({
				"discovery-provider": {
					baseUrl: "https://discovery.example.com/v1",
					api: "openai-responses",
					discovery: { type: "openai-models-list" },
				},
			});
			await authStorage.set("discovery-provider", [
				{ type: "api_key", key: "credential-a" },
				{ type: "api_key", key: "credential-b" },
			]);
			const requestKeys: string[] = [];
			using _hook = hookFetch((_input, init) => {
				const key = (init?.headers as Record<string, string>).Authorization;
				requestKeys.push(key);
				return new Response(JSON.stringify({ data: [{ id: `discovered-model-${requestKeys.length}` }] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			});
			const registry = new ModelRegistry(authStorage, modelsJsonPath);

			await registry.refreshProvider("discovery-provider", "online");
			await registry.refreshProvider("discovery-provider", "online-if-uncached");

			expect(requestKeys).toEqual(["Bearer credential-a", "Bearer credential-b"]);
			expect(registry.find("discovery-provider", "discovered-model-2")).toBeDefined();
		});
		test("keeps selected discovery evidence local to each registry", async () => {
			writeRawModelsJson({
				"discovery-provider": {
					baseUrl: "https://discovery.example.com/v1",
					api: "openai-responses",
					discovery: { type: "openai-models-list" },
				},
			});
			await authStorage.set("discovery-provider", [
				{ type: "api_key", key: "credential-a" },
				{ type: "api_key", key: "credential-b" },
			]);
			const requestKeys: string[] = [];
			using _hook = hookFetch((_input, init) => {
				requestKeys.push((init?.headers as Record<string, string>).Authorization);
				return new Response(JSON.stringify({ data: [{ id: "discovered-model" }] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			});
			const firstRegistry = new ModelRegistry(authStorage, modelsJsonPath);
			await firstRegistry.refreshProvider("discovery-provider", "online");

			const secondRegistry = new ModelRegistry(authStorage, modelsJsonPath);
			await secondRegistry.refreshProvider("discovery-provider", "online");

			expect(requestKeys).toEqual(["Bearer credential-a", "Bearer credential-b"]);
			expect(activeRowsFor(firstRegistry, ["discovery-provider"])).toEqual([
				{ provider: "discovery-provider", connectionKind: "credential" },
			]);
			expect(activeRowsFor(secondRegistry, ["discovery-provider"])).toEqual([
				{ provider: "discovery-provider", connectionKind: "credential" },
			]);
		});
		test("does not publish a command-backed discovery after its credentials are replaced during preflight", async () => {
			writeRawModelsJson({
				"discovery-provider": {
					baseUrl: "https://discovery.example.com/v1",
					api: "openai-responses",
					discovery: { type: "openai-models-list" },
				},
			});
			authStorage.close();
			const firstKeyResolution = Promise.withResolvers<string | undefined>();
			const firstKeyRequested = Promise.withResolvers<void>();
			authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"), {
				configValueResolver: async config => {
					if (config === "!credential-a") {
						firstKeyRequested.resolve();
						return firstKeyResolution.promise;
					}
					return config === "!credential-b" ? "credential-b" : undefined;
				},
			});
			await authStorage.set("discovery-provider", [{ type: "api_key", key: "!credential-a" }]);
			const requestKeys: string[] = [];
			using _hook = hookFetch((_input, init) => {
				requestKeys.push((init?.headers as Record<string, string>).Authorization);
				return new Response(JSON.stringify({ data: [{ id: "discovered-model" }] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			});
			const registry = new ModelRegistry(authStorage, modelsJsonPath);

			const staleRefresh = registry.refreshProvider("discovery-provider", "online");
			await firstKeyRequested.promise;
			await authStorage.set("discovery-provider", [{ type: "api_key", key: "!credential-b" }]);
			firstKeyResolution.resolve("credential-a");
			await staleRefresh;

			expect(requestKeys).toEqual([]);
			expect(registry.find("discovery-provider", "discovered-model")).toBeUndefined();

			await registry.refreshProvider("discovery-provider", "online");

			expect(requestKeys).toEqual(["Bearer credential-b"]);
			expect(activeRowsFor(registry, ["discovery-provider"])).toEqual([
				{ provider: "discovery-provider", connectionKind: "credential" },
			]);
		}, 120_000);
		test("does not retain configured discovery evidence after an in-flight credential change", async () => {
			writeRawModelsJson({
				"discovery-provider": {
					baseUrl: "https://discovery.example.com/v1",
					api: "openai-responses",
					discovery: { type: "openai-models-list" },
				},
			});
			authStorage.setRuntimeApiKey("discovery-provider", "credential-a");
			const { promise: response, resolve: resolveResponse } = Promise.withResolvers<Response>();
			using _hook = hookFetch(() => response);
			const registry = new ModelRegistry(authStorage, modelsJsonPath);

			const refresh = registry.refreshProvider("discovery-provider", "online");
			await Bun.sleep(0);
			authStorage.setRuntimeApiKey("discovery-provider", "credential-b");
			resolveResponse(
				new Response(JSON.stringify({ data: [{ id: "discovered-model" }] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			);
			await refresh;

			expect(activeRowsFor(registry, ["discovery-provider"])).toEqual([]);
			expect(registry.find("discovery-provider", "discovered-model")).toBeUndefined();
			expect(registry.getProviderDiscoveryState("discovery-provider")?.status).toBe("idle");
		});
		test("discards a completed configured discovery after another provider delays the aggregate refresh", async () => {
			writeRawModelsJson({
				"first-discovery-provider": {
					baseUrl: "https://first-discovery.example.com/v1",
					api: "openai-responses",
					discovery: { type: "openai-models-list" },
				},
				"second-discovery-provider": {
					baseUrl: "https://second-discovery.example.com/v1",
					api: "openai-responses",
					discovery: { type: "openai-models-list" },
				},
			});
			authStorage.setRuntimeApiKey("first-discovery-provider", "credential-a");
			authStorage.setRuntimeApiKey("second-discovery-provider", "credential-b");
			const { promise: secondResponse, resolve: resolveSecondResponse } = Promise.withResolvers<Response>();
			using _hook = hookFetch(input => {
				switch (String(input)) {
					case "https://first-discovery.example.com/v1/models":
						return new Response(JSON.stringify({ data: [{ id: "first-model" }] }), {
							status: 200,
							headers: { "Content-Type": "application/json" },
						});
					case "https://second-discovery.example.com/v1/models":
						return secondResponse;
					default:
						throw new Error(`Unexpected URL: ${input}`);
				}
			});
			const registry = new ModelRegistry(authStorage, modelsJsonPath);

			const refresh = registry.refresh();
			await Bun.sleep(0);
			authStorage.setRuntimeApiKey("first-discovery-provider", "credential-a-rotated");
			resolveSecondResponse(
				new Response(JSON.stringify({ data: [{ id: "second-model" }] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			);
			await refresh;

			expect(registry.find("first-discovery-provider", "first-model")).toBeUndefined();
			expect(registry.find("second-discovery-provider", "second-model")).toBeDefined();
			expect(activeRowsFor(registry, ["first-discovery-provider"])).toEqual([]);
			expect(registry.getProviderDiscoveryState("first-discovery-provider")).toBeUndefined();
		});
		test("invalidates a completed discovery state after an aggregate environment credential change", async () => {
			const restoreFirstKey = setEnvForTest("GJC_TEST_FIRST_DISCOVERY_KEY", "credential-a");
			try {
				writeRawModelsJson({
					"first-discovery-provider": {
						baseUrl: "https://first-discovery.example.com/v1",
						api: "openai-responses",
						discovery: { type: "openai-models-list" },
					},
					"second-discovery-provider": {
						baseUrl: "https://second-discovery.example.com/v1",
						api: "openai-responses",
						discovery: { type: "openai-models-list" },
					},
				});
				await authStorage.set("first-discovery-provider", [
					{ type: "api_key", key: "GJC_TEST_FIRST_DISCOVERY_KEY" },
				]);
				authStorage.setRuntimeApiKey("second-discovery-provider", "credential-b");
				const { promise: secondResponse, resolve: resolveSecondResponse } = Promise.withResolvers<Response>();
				using _hook = hookFetch(input => {
					switch (String(input)) {
						case "https://first-discovery.example.com/v1/models":
							return new Response(JSON.stringify({ data: [{ id: "first-model" }] }), {
								status: 200,
								headers: { "Content-Type": "application/json" },
							});
						case "https://second-discovery.example.com/v1/models":
							return secondResponse;
						default:
							throw new Error(`Unexpected URL: ${input}`);
					}
				});
				const registry = new ModelRegistry(authStorage, modelsJsonPath);

				const refresh = registry.refresh();
				await Bun.sleep(0);
				process.env.GJC_TEST_FIRST_DISCOVERY_KEY = "credential-a-rotated";
				resolveSecondResponse(
					new Response(JSON.stringify({ data: [{ id: "second-model" }] }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					}),
				);
				await refresh;

				expect(registry.find("first-discovery-provider", "first-model")).toBeUndefined();
				expect(registry.getProviderDiscoveryState("first-discovery-provider")).toBeUndefined();
			} finally {
				restoreFirstKey();
			}
		});
		test("does not retain configured discovery evidence after an in-flight endpoint change", async () => {
			writeRawModelsJson({
				"discovery-provider": {
					api: "openai-responses",
					apiKey: "DISCOVERY_KEY",
					discovery: { type: "openai-models-list" },
				},
			});
			const restore = setEnvForTest("DISCOVERY_PROVIDER_BASE_URL", "https://tenant-a.example.com/v1");
			try {
				const { promise: response, resolve: resolveResponse } = Promise.withResolvers<Response>();
				using _hook = hookFetch(() => response);
				const registry = new ModelRegistry(authStorage, modelsJsonPath);

				const refresh = registry.refreshProvider("discovery-provider", "online");
				await Bun.sleep(0);
				Bun.env.DISCOVERY_PROVIDER_BASE_URL = "https://tenant-b.example.com/v1";
				resolveResponse(
					new Response(JSON.stringify({ data: [{ id: "discovered-model" }] }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					}),
				);
				await refresh;

				expect(activeRowsFor(registry, ["discovery-provider"])).toEqual([]);
				expect(registry.find("discovery-provider", "discovered-model")).toBeUndefined();
				expect(readModelCache("discovery-provider", 24 * 60 * 60 * 1000, Date.now, cacheDbPath)).toBeNull();
			} finally {
				restore();
			}
		});
		test("serializes configured refresh credential evidence publication", async () => {
			writeRawModelsJson({
				"discovery-provider": {
					baseUrl: "https://discovery.example.com/v1",
					api: "openai-responses",
					discovery: { type: "openai-models-list" },
				},
			});
			authStorage.setRuntimeApiKey("discovery-provider", "credential-a");
			const { promise: olderResponse, resolve: resolveOlder } = Promise.withResolvers<Response>();
			const { promise: newerResponse, resolve: resolveNewer } = Promise.withResolvers<Response>();
			let calls = 0;
			using _hook = hookFetch(() => (calls++ === 0 ? olderResponse : newerResponse));
			const registry = new ModelRegistry(authStorage, modelsJsonPath);

			const olderRefresh = registry.refreshProvider("discovery-provider", "online");
			await Bun.sleep(0);
			authStorage.setRuntimeApiKey("discovery-provider", "credential-b");
			const newerRefresh = registry.refreshProvider("discovery-provider", "online");
			await Bun.sleep(0);
			expect(calls).toBe(1);
			resolveOlder(
				new Response(JSON.stringify({ data: [{ id: "discovered-model" }] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			);
			await olderRefresh;
			while (calls < 2) await Bun.sleep(0);
			resolveNewer(
				new Response(JSON.stringify({ data: [{ id: "discovered-model" }] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			);
			await newerRefresh;

			expect(activeRowsFor(registry, ["discovery-provider"])).toEqual([
				{ provider: "discovery-provider", connectionKind: "credential" },
			]);
		});
		test("retains configured discovery proof across an offline cache refresh", async () => {
			writeRawModelsJson({
				"discovery-provider": {
					baseUrl: "https://discovery.example.com/v1",
					api: "openai-responses",
					apiKey: "DISCOVERY_KEY",
					discovery: { type: "openai-models-list" },
				},
			});
			using _hook = hookFetch(
				() =>
					new Response(JSON.stringify({ data: [{ id: "discovered-model" }] }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					}),
			);
			const registry = new ModelRegistry(authStorage, modelsJsonPath);

			await registry.refreshProvider("discovery-provider", "online");
			await registry.refreshProvider("discovery-provider", "offline");

			expect(registry.getProviderDiscoveryState("discovery-provider")?.status).toBe("cached");
			expect(activeRowsFor(registry, ["discovery-provider"])).toEqual([
				{ provider: "discovery-provider", connectionKind: "credential" },
			]);
		});
		test("invalidates configured discovery proof when its environment endpoint changes", async () => {
			writeRawModelsJson({
				"discovery-provider": {
					api: "openai-responses",
					apiKey: "DISCOVERY_KEY",
					discovery: { type: "openai-models-list" },
				},
			});
			const restore = setEnvForTest("DISCOVERY_PROVIDER_BASE_URL", "https://tenant-a.example.com/v1");
			try {
				using _hook = hookFetch(input => {
					expect(String(input)).toBe("https://tenant-a.example.com/v1/models");
					return new Response(JSON.stringify({ data: [{ id: "discovered-model" }] }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					});
				});
				const registry = new ModelRegistry(authStorage, modelsJsonPath);

				await registry.refreshProvider("discovery-provider", "online");
				Bun.env.DISCOVERY_PROVIDER_BASE_URL = "https://tenant-b.example.com/v1";
				await registry.refreshProvider("discovery-provider", "offline");

				expect(activeRowsFor(registry, ["discovery-provider"])).toEqual([]);
			} finally {
				restore();
			}
		});
		test("re-resolves an environment endpoint before an online configured discovery", async () => {
			writeRawModelsJson({
				"discovery-provider": {
					api: "openai-responses",
					apiKey: "DISCOVERY_KEY",
					discovery: { type: "openai-models-list" },
				},
			});
			const restore = setEnvForTest("DISCOVERY_PROVIDER_BASE_URL", "https://tenant-a.example.com/v1");
			try {
				const requestedUrls: string[] = [];
				using _hook = hookFetch(input => {
					requestedUrls.push(String(input));
					return new Response(JSON.stringify({ data: [{ id: "discovered-model" }] }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					});
				});
				const registry = new ModelRegistry(authStorage, modelsJsonPath);

				await registry.refreshProvider("discovery-provider", "online");
				Bun.env.DISCOVERY_PROVIDER_BASE_URL = "https://tenant-b.example.com/v1";
				await registry.refreshProvider("discovery-provider", "online");

				expect(requestedUrls).toEqual([
					"https://tenant-a.example.com/v1/models",
					"https://tenant-b.example.com/v1/models",
				]);
			} finally {
				restore();
			}
		});
		test("clears configured discovery proof after a failed online probe", async () => {
			writeRawModelsJson({
				"discovery-provider": {
					baseUrl: "https://discovery.example.com/v1",
					api: "openai-responses",
					apiKey: "DISCOVERY_KEY",
					discovery: { type: "openai-models-list" },
				},
			});
			let available = true;
			using _hook = hookFetch(() =>
				available
					? new Response(JSON.stringify({ data: [{ id: "discovered-model" }] }), {
							status: 200,
							headers: { "Content-Type": "application/json" },
						})
					: new Response("unavailable", { status: 503 }),
			);
			const registry = new ModelRegistry(authStorage, modelsJsonPath);

			await registry.refreshProvider("discovery-provider", "online");
			available = false;
			await registry.refreshProvider("discovery-provider", "online");

			expect(registry.getProviderDiscoveryState("discovery-provider")?.status).toBe("cached");
			expect(activeRowsFor(registry, ["discovery-provider"])).toEqual([]);
		});
		test("uses the runtime endpoint query for configured discovery and completion", async () => {
			writeRawModelsJson({
				"discovery-provider": {
					baseUrl: "https://configured.example.com/v1",
					api: "openai-completions",
					apiKey: "DISCOVERY_KEY",
					discovery: { type: "openai-models-list" },
				},
			});
			const discoveryUrl = "https://runtime.example.com/v1/models?sig=runtime-secret";
			const completionUrl = "https://runtime.example.com/v1/chat/completions?sig=runtime-secret";
			const requestedUrls: string[] = [];
			using _hook = hookFetch(input => {
				const url = String(input);
				requestedUrls.push(url);
				if (url === discoveryUrl) {
					return new Response(JSON.stringify({ data: [{ id: "runtime-model" }] }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					});
				}
				if (url === completionUrl) {
					const body = [
						`data: ${JSON.stringify({
							id: "chatcmpl-query",
							object: "chat.completion.chunk",
							created: 0,
							model: "runtime-model",
							choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }],
						})}`,
						`data: ${JSON.stringify({
							id: "chatcmpl-query",
							object: "chat.completion.chunk",
							created: 0,
							model: "runtime-model",
							choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
							usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
						})}`,
						"data: [DONE]",
						"",
					].join("\n\n");
					return new Response(body, {
						status: 200,
						headers: { "Content-Type": "text/event-stream" },
					});
				}
				throw new Error(`Unexpected URL: ${url}`);
			});
			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			registry.registerProvider("discovery-provider", {
				baseUrl: "https://runtime.example.com/v1?sig=runtime-secret",
			});

			await registry.refreshProvider("discovery-provider", "online");

			const model = registry.find("discovery-provider", "runtime-model");
			expect(model?.baseUrl).toBe("https://runtime.example.com/v1?sig=runtime-secret");
			const cached = readModelCache<Api>("discovery-provider", 24 * 60 * 60 * 1000, Date.now, cacheDbPath);
			expect(cached?.models).toHaveLength(1);
			expect(cached?.models[0]?.baseUrl).toBe("https://runtime.example.com/v1");
			expect(cached?.dynamicModelProvenance).toStartWith("gajae:non-cacheable-configured:");
			expect(JSON.stringify(cached)).not.toContain("runtime-secret");
			expect(JSON.stringify(cached)).not.toContain("DISCOVERY_KEY");
			expect(activeRowsFor(registry, ["discovery-provider"])).toEqual([
				{ provider: "discovery-provider", connectionKind: "credential" },
			]);

			const result = await streamOpenAICompletions(
				model as Model<"openai-completions">,
				{
					messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
				} satisfies Context,
				{ apiKey: "DISCOVERY_KEY" },
			).result();
			expect(result.stopReason).toBe("stop");
			expect(requestedUrls).toEqual([discoveryUrl, completionUrl]);
			const cachedRegistry = new ModelRegistry(authStorage, modelsJsonPath);
			cachedRegistry.registerProvider("discovery-provider", {
				baseUrl: "https://runtime.example.com/v1?sig=runtime-secret",
			});
			// Registration occurs after construction, so no synchronous cache row is
			// trusted before current discovery provenance is established.
			expect(cachedRegistry.find("discovery-provider", "runtime-model")).toBeUndefined();
			const changedAuthorityRegistry = new ModelRegistry(authStorage, modelsJsonPath);
			changedAuthorityRegistry.registerProvider("discovery-provider", {
				baseUrl: "https://runtime.example.com/v1?sig=other-tenant-secret",
			});
			expect(changedAuthorityRegistry.find("discovery-provider", "runtime-model")).toBeUndefined();
			expect(
				JSON.stringify(readModelCache<Api>("discovery-provider", 24 * 60 * 60 * 1000, Date.now, cacheDbPath)),
			).not.toContain("runtime-secret");
		});
		test("strips runtime endpoint userinfo from discovered model URLs without changing path or query", async () => {
			writeRawModelsJson({
				"discovery-provider": {
					baseUrl: "https://configured.example.com/v1",
					api: "openai-completions",
					apiKey: "DISCOVERY_KEY",
					discovery: { type: "openai-models-list" },
				},
			});
			const secret = "raw-userinfo-secret";
			using _hook = mockOpenAiCompatibleModels(
				`https://runtime-user:${secret}@runtime.example.com/api/v1/models?tenant=alpha%2F`,
				["runtime-model"],
			);
			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			registry.registerProvider("discovery-provider", {
				baseUrl: `https://runtime-user:${secret}@runtime.example.com/api/v1/?tenant=alpha%2F`,
			});

			await registry.refreshProvider("discovery-provider", "online");

			const model = registry.find("discovery-provider", "runtime-model");
			expect(model?.baseUrl).toBe("https://runtime.example.com/api/v1/?tenant=alpha%2F");
			expect(model?.baseUrl).not.toContain("runtime-user");
			expect(model?.baseUrl).not.toContain(secret);
			expect(JSON.stringify(model)).not.toContain(secret);
		});
		test("drops malformed discovery URLs before persisting models", async () => {
			const secret = "plain-secret-0001";
			writeRawModelsJson({
				"discovery-provider": {
					baseUrl: `https://user:${secret}@[bad/v1`,
					api: "anthropic-messages",
					discovery: { type: "models-dev", modelsDevProvider: "anthropic" },
				},
			});
			authStorage.setRuntimeApiKey("discovery-provider", "credential-a");
			using _hook = hookFetch(
				() =>
					new Response(
						JSON.stringify({
							anthropic: {
								models: {
									"malformed-url-model": {
										name: "Malformed URL Model",
										modalities: { input: ["text"] },
										cost: { input: 1, output: 1 },
										limit: { context: 8192, output: 1024 },
									},
								},
							},
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					),
			);
			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			await registry.refreshProvider("discovery-provider", "online");
			const cached = readModelCache<Api>("discovery-provider", 24 * 60 * 60 * 1000, Date.now, cacheDbPath);
			expect(JSON.stringify(cached)).not.toContain(secret);
			expect(cached?.models.find(model => model.id === "malformed-url-model")?.baseUrl).toBeUndefined();
		});
		test("does not restore configured discovery evidence after a transport override", async () => {
			writeRawModelsJson({
				"discovery-provider": {
					baseUrl: "https://discovery.example.com/v1",
					api: "openai-responses",
					apiKey: "DISCOVERY_KEY",
					discovery: { type: "openai-models-list" },
				},
			});
			const { promise: response, resolve: resolveResponse } = Promise.withResolvers<Response>();
			using _hook = hookFetch(() => response);
			const registry = new ModelRegistry(authStorage, modelsJsonPath);

			const refresh = registry.refreshProvider("discovery-provider", "online");
			await Bun.sleep(0);
			registry.registerProvider("discovery-provider", { baseUrl: "https://override.example.com/v1" });
			resolveResponse(
				new Response(JSON.stringify({ data: [{ id: "discovered-model" }] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			);
			await refresh;

			expect(activeRowsFor(registry, ["discovery-provider"])).toEqual([]);
		});
		test("does not advertise authenticated descriptor-only cached models without activity evidence", () => {
			const cachedModel: Model<"openai-completions"> = {
				id: "cached-vllm-model",
				name: "Cached vLLM Model",
				api: "openai-completions",
				provider: "vllm",
				baseUrl: "http://127.0.0.1:8000/v1",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 8192,
			};
			writeModelCache("vllm", Date.now(), [cachedModel], true, "", cacheDbPath);
			authStorage.setRuntimeApiKey("vllm", "cached-vllm-key");

			const registry = new ModelRegistry(authStorage, modelsJsonPath);

			expect(registry.find("vllm", "cached-vllm-model")).toBeUndefined();
			expect(activeRowsFor(registry, ["vllm"])).toEqual([]);
		});
		test("does not treat descriptor overrides as configured static models", () => {
			const cachedModel: Model<"openai-completions"> = {
				id: "cached-vllm-model",
				name: "Cached vLLM Model",
				api: "openai-completions",
				provider: "vllm",
				baseUrl: "http://127.0.0.1:8000/v1",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 8192,
			};
			writeRawModelsJson({
				vllm: { baseUrl: "http://127.0.0.1:8000/v1", apiKey: "configured-vllm-key" },
			});
			writeModelCache("vllm", Date.now(), [cachedModel], true, "", cacheDbPath);
			authStorage.setRuntimeApiKey("vllm", "cached-vllm-key");

			const registry = new ModelRegistry(authStorage, modelsJsonPath);

			expect(registry.find("vllm", "cached-vllm-model")).toBeUndefined();
			expect(activeRowsFor(registry, ["vllm"])).toEqual([]);
		});
		test("does not advertise descriptor-only providers from a fresh cache reused offline", async () => {
			const cachedModel: Model<"openai-completions"> = {
				id: "cached-vllm-model",
				name: "Cached vLLM Model",
				api: "openai-completions",
				provider: "vllm",
				baseUrl: "http://127.0.0.1:8000/v1",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 8192,
			};
			writeModelCache("vllm", Date.now(), [cachedModel], true, "", cacheDbPath);
			authStorage.setRuntimeApiKey("vllm", "cached-vllm-key");
			using _hook = hookFetch(() => {
				throw new Error("online-if-uncached must reuse the fresh cache");
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			await registry.refreshProvider("vllm", "online-if-uncached");

			expect(activeRowsFor(registry, ["vllm"])).toEqual([]);
		});
		test("discovers OpenCodex as credentialless when the local proxy is healthy", async () => {
			const restoreOpenCodexHome = setEnvForTest("OPENCODEX_HOME", tempDir);
			await Bun.write(
				path.join(tempDir, "runtime-port.json"),
				JSON.stringify({ hostname: "127.0.0.1", port: 10201 }),
			);
			using _hook = hookFetch(input => {
				const url = String(input);
				if (url === "http://127.0.0.1:10201/healthz") {
					return new Response(JSON.stringify({ ok: true, version: "opencodex", port: 10201 }), { status: 200 });
				}
				if (url === "http://127.0.0.1:10201/api/models") {
					return new Response(JSON.stringify([{ id: "provider/model", name: "Provider Model" }]), { status: 200 });
				}
				throw new Error(`Unexpected URL: ${url}`);
			});
			try {
				const registry = new ModelRegistry(authStorage, modelsJsonPath);
				await registry.refreshProvider("opencodex", "online");

				expect(registry.find("opencodex", "opencodex/provider/model")).toBeDefined();
				expect(registry.getAvailable().map(model => `${model.provider}/${model.id}`)).toContain(
					"opencodex/opencodex/provider/model",
				);
				expect(activeRowsFor(registry, ["opencodex"])).toEqual([
					{ provider: "opencodex", connectionKind: "credentialless" },
				]);
			} finally {
				restoreOpenCodexHome();
			}
		});
		test("discovers OpenCodex as credentialless after a command credential resolves empty", async () => {
			authStorage.close();
			authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"), {
				configValueResolver: async () => undefined,
			});
			await authStorage.set("opencodex", [{ type: "api_key", key: "!missing-opencodex-key" }]);
			const restoreOpenCodexHome = setEnvForTest("OPENCODEX_HOME", tempDir);
			await Bun.write(
				path.join(tempDir, "runtime-port.json"),
				JSON.stringify({ hostname: "127.0.0.1", port: 10201 }),
			);
			using _hook = hookFetch(input => {
				const url = String(input);
				if (url === "http://127.0.0.1:10201/healthz") {
					return new Response(JSON.stringify({ ok: true, version: "opencodex", port: 10201 }), { status: 200 });
				}
				if (url === "http://127.0.0.1:10201/api/models") {
					return new Response(JSON.stringify([{ id: "provider/model", name: "Provider Model" }]), { status: 200 });
				}
				throw new Error(`Unexpected URL: ${url}`);
			});
			try {
				const registry = new ModelRegistry(authStorage, modelsJsonPath);
				await registry.refreshProvider("opencodex", "online");

				expect(activeRowsFor(registry, ["opencodex"])).toEqual([
					{ provider: "opencodex", connectionKind: "credentialless" },
				]);
				await expect(registry.getApiKeyForProvider("opencodex")).resolves.toBe(kNoAuth);
			} finally {
				restoreOpenCodexHome();
			}
		});
		test("advertises descriptor-only providers after a fresh online-if-uncached discovery", async () => {
			authStorage.setRuntimeApiKey("vllm", "fresh-vllm-key");
			using _hook = hookFetch(input => {
				expect(String(input)).toBe("http://127.0.0.1:8000/v1/models");
				return new Response(JSON.stringify({ data: [{ id: "fresh-vllm-model" }] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			await registry.refreshProvider("vllm", "online-if-uncached");

			expect(registry.find("vllm", "fresh-vllm-model")).toBeDefined();
			expect(activeRowsFor(registry, ["vllm"])).toEqual([{ provider: "vllm", connectionKind: "credential" }]);
		});
		test("discovers Xiaomi token-plan models at their credential-derived endpoint", async () => {
			authStorage.setRuntimeApiKey("xiaomi", "tp-sgp-token");
			using _hook = hookFetch(input => {
				expect(String(input)).toBe("https://token-plan-sgp.xiaomimimo.com/v1/models");
				return new Response(JSON.stringify({ data: [{ id: "token-plan-model" }] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			});
			const registry = new ModelRegistry(authStorage, modelsJsonPath);

			await registry.refreshProvider("xiaomi", "online");

			expect(registry.find("xiaomi", "token-plan-model")?.baseUrl).toBe("https://token-plan-sgp.xiaomimimo.com/v1");
			expect(activeRowsFor(registry, ["xiaomi"])).toEqual([{ provider: "xiaomi", connectionKind: "credential" }]);
		});
		test("keeps signed descriptor endpoints out of the model cache", async () => {
			const restoreBaseUrl = setEnvForTest("VLLM_BASE_URL", "https://vllm.example.com/v1?sig=descriptor-secret");
			authStorage.setRuntimeApiKey("vllm", "fresh-vllm-key");
			using _hook = hookFetch(input => {
				expect(String(input)).toBe("https://vllm.example.com/v1/models?sig=descriptor-secret");
				return new Response(JSON.stringify({ data: [{ id: "signed-vllm-model" }] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			});
			try {
				const registry = new ModelRegistry(authStorage, modelsJsonPath);
				await registry.refreshProvider("vllm", "online");

				expect(registry.find("vllm", "signed-vllm-model")?.baseUrl).toBe(
					"https://vllm.example.com/v1?sig=descriptor-secret",
				);
				const cached = readModelCache<Api>("vllm", 24 * 60 * 60 * 1000, Date.now, cacheDbPath);
				expect(cached?.models[0]?.baseUrl).toBe("https://vllm.example.com/v1");
				expect(cached?.dynamicModelProvenance).toStartWith("gajae:non-cacheable-endpoint:");
				expect(JSON.stringify(cached)).not.toContain("descriptor-secret");
			} finally {
				restoreBaseUrl();
			}
		});
		test("does not reuse descriptor caches for endpoints containing userinfo", async () => {
			const restoreBaseUrl = setEnvForTest("VLLM_BASE_URL", "https://tenant-a:secret-a@vllm.example.com/v1");
			authStorage.setRuntimeApiKey("vllm", "fresh-vllm-key");
			let requests = 0;
			using _hook = hookFetch(() => {
				requests++;
				return new Response(JSON.stringify({ data: [{ id: "userinfo-vllm-model" }] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			});
			try {
				const first = new ModelRegistry(authStorage, modelsJsonPath);
				await first.refreshProvider("vllm", "online");
				expect(
					readModelCache("vllm", 24 * 60 * 60 * 1000, Date.now, cacheDbPath)?.dynamicModelProvenance,
				).toStartWith("gajae:non-cacheable-endpoint:");
				const requestsAfterFirstFetch = requests;
				const second = new ModelRegistry(authStorage, modelsJsonPath);
				await second.refreshProvider("vllm", "online-if-uncached");
				expect(requests).toBeGreaterThan(requestsAfterFirstFetch);
				const offline = new ModelRegistry(authStorage, modelsJsonPath);
				await offline.refreshProvider("vllm", "offline");
				expect(offline.find("vllm", "userinfo-vllm-model")).toBeUndefined();
			} finally {
				restoreBaseUrl();
			}
		});
		test("keeps signed models.dev descriptor rows out of the model cache", async () => {
			const restoreBaseUrl = setEnvForTest(
				"ANTHROPIC_BASE_URL",
				"https://anthropic.example.com/v1?sig=models-dev-secret",
			);
			authStorage.setRuntimeApiKey("anthropic", "fresh-anthropic-key");
			using _hook = hookFetch(input => {
				const url = String(input);
				if (url === "https://models.dev/api.json") {
					return new Response(
						JSON.stringify({
							anthropic: {
								models: {
									"models-dev-only": {
										name: "Models.dev Only",
										tool_call: true,
										modalities: { input: ["text"] },
										cost: { input: 1, output: 1 },
										limit: { context: 128000, output: 8192 },
									},
								},
							},
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				}
				if (url === "https://anthropic.example.com/v1/models?sig=models-dev-secret") {
					return new Response(JSON.stringify({ data: [] }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					});
				}
				throw new Error(`Unexpected URL: ${url}`);
			});
			try {
				const registry = new ModelRegistry(authStorage, modelsJsonPath);
				await registry.refreshProvider("anthropic", "online");

				const cached = readModelCache<Api>("anthropic", 24 * 60 * 60 * 1000, Date.now, cacheDbPath);
				expect(cached?.models.find(model => model.id === "models-dev-only")?.baseUrl).toBe(
					"https://anthropic.example.com/v1",
				);
				expect(JSON.stringify(cached)).not.toContain("models-dev-secret");
			} finally {
				restoreBaseUrl();
			}
		});
		test("discovers descriptor-only providers on the first refresh with a stored API key", async () => {
			await authStorage.set("vllm", [{ type: "api_key", key: "stored-vllm-key" }]);
			using _hook = hookFetch(input => {
				expect(String(input)).toBe("http://127.0.0.1:8000/v1/models");
				return new Response(JSON.stringify({ data: [{ id: "stored-vllm-model" }] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			await registry.refreshProvider("vllm", "online-if-uncached");

			expect(registry.find("vllm", "stored-vllm-model")).toBeDefined();
			expect(activeRowsFor(registry, ["vllm"])).toEqual([{ provider: "vllm", connectionKind: "credential" }]);
		});
		test("does not publish descriptor discovery after its command credential is replaced during preflight", async () => {
			authStorage.close();
			const firstKeyResolution = Promise.withResolvers<string | undefined>();
			const firstKeyRequested = Promise.withResolvers<void>();
			authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"), {
				configValueResolver: async config => {
					if (config === "!vllm-key-a") {
						firstKeyRequested.resolve();
						return firstKeyResolution.promise;
					}
					return config === "!vllm-key-b" ? "vllm-key-b" : undefined;
				},
			});
			await authStorage.set("vllm", [{ type: "api_key", key: "!vllm-key-a" }]);
			const requestApiKeys: string[] = [];
			using _hook = hookFetch((_input, init) => {
				requestApiKeys.push(new Headers(init?.headers).get("Authorization") ?? "");
				return new Response(JSON.stringify({ data: [{ id: "command-vllm-model" }] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			});
			const registry = new ModelRegistry(authStorage, modelsJsonPath);

			const staleRefresh = registry.refreshProvider("vllm", "online");
			await firstKeyRequested.promise;
			await authStorage.set("vllm", [{ type: "api_key", key: "!vllm-key-b" }]);
			firstKeyResolution.resolve("vllm-key-a");
			await staleRefresh;

			expect(requestApiKeys).toEqual([]);
			expect(registry.find("vllm", "command-vllm-model")).toBeUndefined();
			expect(readModelCache("vllm", 24 * 60 * 60 * 1000, Date.now, cacheDbPath)).toBeNull();

			await registry.refreshProvider("vllm", "online");

			expect(requestApiKeys).toEqual(["Bearer vllm-key-b"]);
			expect(activeRowsFor(registry, ["vllm"])).toEqual([{ provider: "vllm", connectionKind: "credential" }]);
		});
		test("discovers descriptor-only providers with the first stored command-backed key", async () => {
			authStorage.close();
			authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"), {
				configValueResolver: async config => {
					if (config === "!vllm-key-a") return "vllm-key-a";
					if (config === "!vllm-key-b") return "vllm-key-b";
					return undefined;
				},
			});
			await authStorage.set("vllm", [
				{ type: "api_key", key: "!vllm-key-a" },
				{ type: "api_key", key: "!vllm-key-b" },
			]);

			const requestApiKeys: string[] = [];
			using _hook = hookFetch((input, init) => {
				expect(String(input)).toBe("http://127.0.0.1:8000/v1/models");
				requestApiKeys.push(new Headers(init?.headers).get("Authorization") ?? "");
				return new Response(JSON.stringify({ data: [{ id: "command-vllm-model" }] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			await registry.refreshProvider("vllm", "online-if-uncached");

			expect(requestApiKeys).toEqual(["Bearer vllm-key-a"]);
			expect(registry.find("vllm", "command-vllm-model")).toBeDefined();
			expect(activeRowsFor(registry, ["vllm"])).toEqual([{ provider: "vllm", connectionKind: "credential" }]);
		});
		test("preserves descriptor discovery evidence across an offline refresh", async () => {
			authStorage.setRuntimeApiKey("vllm", "fresh-vllm-key");
			using _hook = hookFetch(input => {
				expect(String(input)).toBe("http://127.0.0.1:8000/v1/models");
				return new Response(JSON.stringify({ data: [{ id: "fresh-vllm-model" }] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			await registry.refreshProvider("vllm", "online");
			await registry.refreshProvider("vllm", "offline");

			expect(activeRowsFor(registry, ["vllm"])).toEqual([{ provider: "vllm", connectionKind: "credential" }]);
		});
		test("preserves descriptor discovery evidence with a normalized endpoint across an offline refresh", async () => {
			const restore = setEnvForTest("VLLM_BASE_URL", "https://gateway.example/v1/");
			try {
				authStorage.setRuntimeApiKey("vllm", "fresh-vllm-key");
				using _hook = hookFetch(input => {
					expect(String(input)).toBe("https://gateway.example/v1/models");
					return new Response(JSON.stringify({ data: [{ id: "fresh-vllm-model" }] }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					});
				});
				const registry = new ModelRegistry(authStorage, modelsJsonPath);

				await registry.refreshProvider("vllm", "online");
				await registry.refreshProvider("vllm", "offline");

				expect(activeRowsFor(registry, ["vllm"])).toEqual([{ provider: "vllm", connectionKind: "credential" }]);
			} finally {
				restore();
			}
		});
		test("forces an online descriptor probe when its endpoint query changes", async () => {
			const restore = setEnvForTest("VLLM_BASE_URL", "https://gateway.example/v1?tenant=a/&scope=one&scope=two");
			try {
				authStorage.setRuntimeApiKey("vllm", "fresh-vllm-key");
				const requestedUrls: string[] = [];
				using _hook = hookFetch(input => {
					requestedUrls.push(String(input));
					return new Response(JSON.stringify({ data: [{ id: "fresh-vllm-model" }] }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					});
				});
				const registry = new ModelRegistry(authStorage, modelsJsonPath);

				await registry.refreshProvider("vllm", "online");
				Bun.env.VLLM_BASE_URL = "https://gateway.example/v1?tenant=b/&scope=one&scope=two";
				await registry.refreshProvider("vllm", "online-if-uncached");

				expect(requestedUrls).toEqual([
					"https://gateway.example/v1/models?tenant=a/&scope=one&scope=two",
					"https://gateway.example/v1/models?tenant=b/&scope=one&scope=two",
				]);
				expect(registry.find("vllm", "fresh-vllm-model")?.baseUrl).toBe(
					"https://gateway.example/v1?tenant=b/&scope=one&scope=two",
				);
				expect(activeRowsFor(registry, ["vllm"])).toEqual([{ provider: "vllm", connectionKind: "credential" }]);
			} finally {
				restore();
			}
		});
		test("discards an in-flight descriptor discovery after its endpoint changes", async () => {
			const restore = setEnvForTest("VLLM_BASE_URL", "https://tenant-a.example.com/v1");
			try {
				authStorage.setRuntimeApiKey("vllm", "fresh-vllm-key");
				const { promise: response, resolve: resolveResponse } = Promise.withResolvers<Response>();
				using _hook = hookFetch(() => response);
				const registry = new ModelRegistry(authStorage, modelsJsonPath);

				const refresh = registry.refreshProvider("vllm", "online");
				await Bun.sleep(0);
				Bun.env.VLLM_BASE_URL = "https://tenant-b.example.com/v1";
				resolveResponse(
					new Response(JSON.stringify({ data: [{ id: "tenant-a-model" }] }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					}),
				);
				await refresh;

				expect(registry.find("vllm", "tenant-a-model")).toBeUndefined();
				expect(activeRowsFor(registry, ["vllm"])).toEqual([]);
				expect(readModelCache("vllm", 24 * 60 * 60 * 1000, Date.now, cacheDbPath)).toBeNull();
			} finally {
				restore();
			}
		});
		test("clears descriptor discovery evidence after a failed conditional online probe", async () => {
			authStorage.setRuntimeApiKey("vllm", "fresh-vllm-key");
			let calls = 0;
			using _hook = hookFetch(() =>
				calls++ === 0
					? new Response(JSON.stringify({ data: [{ id: "fresh-vllm-model" }] }), {
							status: 200,
							headers: { "Content-Type": "application/json" },
						})
					: new Response("unavailable", { status: 503 }),
			);
			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			await registry.refreshProvider("vllm", "online");
			expect(activeRowsFor(registry, ["vllm"])).toEqual([{ provider: "vllm", connectionKind: "credential" }]);
			await registry.refreshProvider("vllm", "online-if-uncached");
			expect(activeRowsFor(registry, ["vllm"])).toEqual([{ provider: "vllm", connectionKind: "credential" }]);

			writeModelCache("vllm", Date.now() - 5 * 60 * 1000, [], false, "", cacheDbPath);
			await registry.refreshProvider("vllm", "online-if-uncached");

			expect(activeRowsFor(registry, ["vllm"])).toEqual([]);
		});
		test("invalidates descriptor discovery evidence when the credential changes", async () => {
			authStorage.setRuntimeApiKey("vllm", "credential-a");
			using _hook = hookFetch(
				() =>
					new Response(JSON.stringify({ data: [{ id: "fresh-vllm-model" }] }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					}),
			);

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			await registry.refreshProvider("vllm", "online");
			authStorage.setRuntimeApiKey("vllm", "credential-b");

			expect(activeRowsFor(registry, ["vllm"])).toEqual([]);
		});
		test("invalidates descriptor discovery evidence after a transport override", async () => {
			authStorage.setRuntimeApiKey("vllm", "fresh-vllm-key");
			using _hook = hookFetch(input => {
				expect(String(input)).toBe("http://127.0.0.1:8000/v1/models");
				return new Response(JSON.stringify({ data: [{ id: "fresh-vllm-model" }] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			await registry.refreshProvider("vllm", "online");
			registry.registerProvider("vllm", { baseUrl: "http://127.0.0.1:9000/v1" });

			expect(activeRowsFor(registry, ["vllm"])).toEqual([]);
		});
		test("invalidates descriptor discovery evidence after an OAuth-only registration", async () => {
			authStorage.setRuntimeApiKey("vllm", "fresh-vllm-key");
			using _hook = hookFetch(
				() =>
					new Response(JSON.stringify({ data: [{ id: "fresh-vllm-model" }] }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					}),
			);
			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			await registry.refreshProvider("vllm", "online");
			expect(activeRowsFor(registry, ["vllm"])).toEqual([{ provider: "vllm", connectionKind: "credential" }]);

			registry.registerProvider(
				"vllm",
				{
					oauth: {
						name: "VLLM",
						login: async () => "unused",
					},
				},
				"test-vllm-oauth",
			);

			expect(activeRowsFor(registry, ["vllm"])).toEqual([]);
			registry.clearSourceRegistrations("test-vllm-oauth");
		});
		test("does not restore descriptor evidence after an in-flight discovery is invalidated", async () => {
			authStorage.setRuntimeApiKey("vllm", "fresh-vllm-key");
			const { promise: response, resolve: resolveResponse } = Promise.withResolvers<Response>();
			using _hook = hookFetch(input => {
				expect(String(input)).toBe("http://127.0.0.1:8000/v1/models");
				return response;
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const refresh = registry.refreshProvider("vllm", "online");
			await Bun.sleep(0);
			registry.registerProvider("vllm", { baseUrl: "http://127.0.0.1:9000/v1" });
			resolveResponse(
				new Response(JSON.stringify({ data: [{ id: "fresh-vllm-model" }] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			);
			await refresh;

			expect(activeRowsFor(registry, ["vllm"])).toEqual([]);
		});
		test("does not cache stale descriptor discovery during overlapping online-if-uncached refreshes", async () => {
			authStorage.setRuntimeApiKey("vllm", "fresh-vllm-key");
			const firstResponse = Promise.withResolvers<Response>();
			const firstRequest = Promise.withResolvers<void>();
			let requests = 0;
			using _hook = hookFetch(input => {
				expect(String(input)).toBe("http://127.0.0.1:8000/v1/models");
				requests += 1;
				if (requests === 1) {
					firstRequest.resolve();
					return firstResponse.promise;
				}
				return new Response(JSON.stringify({ data: [{ id: "new-descriptor-model" }] }), { status: 200 });
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const firstRefresh = registry.refreshProvider("vllm", "online-if-uncached");
			await firstRequest.promise;
			const secondRefresh = registry.refreshProvider("vllm", "online-if-uncached");
			firstResponse.resolve(
				new Response(JSON.stringify({ data: [{ id: "stale-descriptor-model" }] }), { status: 200 }),
			);
			await firstRefresh;
			await secondRefresh;

			expect(requests).toBe(2);
			expect(registry.find("vllm", "new-descriptor-model")).toBeDefined();
			expect(registry.find("vllm", "stale-descriptor-model")).toBeUndefined();
		});
		test("does not cache online full-refresh descriptor discovery after a targeted refresh is queued", async () => {
			authStorage.setRuntimeApiKey("vllm", "fresh-vllm-key");
			const firstResponse = Promise.withResolvers<Response>();
			const firstRequest = Promise.withResolvers<void>();
			let requests = 0;
			using _hook = hookFetch(input => {
				expect(String(input)).toBe("http://127.0.0.1:8000/v1/models");
				requests += 1;
				if (requests === 1) {
					firstRequest.resolve();
					return firstResponse.promise;
				}
				return new Response(JSON.stringify({ data: [{ id: "new-full-descriptor-model" }] }), { status: 200 });
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const fullRefresh = registry.refresh("online");
			await firstRequest.promise;
			const targetedRefresh = registry.refreshProvider("vllm", "online-if-uncached");
			firstResponse.resolve(
				new Response(JSON.stringify({ data: [{ id: "stale-full-descriptor-model" }] }), { status: 200 }),
			);
			await fullRefresh;
			await targetedRefresh;

			expect(requests).toBe(2);
			expect(registry.find("vllm", "new-full-descriptor-model")).toBeDefined();
			expect(readModelCache("vllm", 24 * 60 * 60 * 1000, Date.now, cacheDbPath)?.models).toEqual(
				expect.arrayContaining([expect.objectContaining({ id: "new-full-descriptor-model" })]),
			);
			expect(readModelCache("vllm", 24 * 60 * 60 * 1000, Date.now, cacheDbPath)?.models).not.toEqual(
				expect.arrayContaining([expect.objectContaining({ id: "stale-full-descriptor-model" })]),
			);
		});
		test("serializes descriptor discovery publication before a newer failed probe", async () => {
			authStorage.setRuntimeApiKey("vllm", "fresh-vllm-key");
			let calls = 0;
			const { promise: olderResponse, resolve: resolveOlder } = Promise.withResolvers<Response>();
			const { promise: newerResponse, resolve: resolveNewer } = Promise.withResolvers<Response>();
			using _hook = hookFetch(() => (calls++ === 0 ? olderResponse : newerResponse));
			const registry = new ModelRegistry(authStorage, modelsJsonPath);

			const olderRefresh = registry.refreshProvider("vllm", "online");
			await Bun.sleep(0);
			const newerRefresh = registry.refreshProvider("vllm", "online");
			await Bun.sleep(0);
			resolveOlder(
				new Response(JSON.stringify({ data: [{ id: "older-model" }] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			);
			await olderRefresh;
			while (calls < 2) await Bun.sleep(0);
			resolveNewer(new Response("unavailable", { status: 503 }));
			await newerRefresh;
			expect(readModelCache("vllm", 24 * 60 * 60 * 1000, Date.now, cacheDbPath)?.models).toEqual(
				expect.arrayContaining([expect.objectContaining({ id: "older-model" })]),
			);

			expect(activeRowsFor(registry, ["vllm"])).toEqual([]);
		});
		test("invalidates descriptor discovery evidence after a config reload", async () => {
			authStorage.setRuntimeApiKey("vllm", "fresh-vllm-key");
			using _hook = hookFetch(input => {
				expect(String(input)).toBe("http://127.0.0.1:8000/v1/models");
				return new Response(JSON.stringify({ data: [{ id: "fresh-vllm-model" }] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			await registry.refreshProvider("vllm", "online");
			writeRawModelsJson({ vllm: { baseUrl: "http://127.0.0.1:9000/v1", apiKey: "fresh-vllm-key" } });
			const updatedAt = new Date(Date.now() + 1000);
			fs.utimesSync(modelsJsonPath, updatedAt, updatedAt);
			await registry.refresh("offline");

			expect(activeRowsFor(registry, ["vllm"])).toEqual([]);
		});
		test("requires fresh exact discovery evidence while static models stay active", async () => {
			let response: "empty" | "unavailable" | "ok" = "empty";
			writeRawModelsJson({
				"discovery-provider": {
					baseUrl: "https://discovery.example.com/v1",
					api: "openai-responses",
					apiKey: "DISCOVERY_KEY",
					discovery: { type: "openai-models-list" },
				},
				mixed: {
					baseUrl: "https://mixed.example.com/v1",
					api: "openai-responses",
					auth: "none",
					discovery: { type: "openai-models-list" },
					models: [{ id: "mixed-static" }],
				},
				"unauthenticated-provider": {
					baseUrl: "https://unauthenticated.example.com/v1",
					api: "openai-responses",
					apiKeyEnv: "GJC_TEST_MISSING_ACTIVE_PROVIDER_KEY",
					discovery: { type: "openai-models-list" },
				},
			});
			using _hook = hookFetch(input => {
				const url = String(input);
				if (url.includes("unauthenticated.example.com"))
					throw new Error("unauthenticated discovery must not fetch");
				if (response === "unavailable") return new Response("unavailable", { status: 503 });
				return new Response(JSON.stringify({ data: response === "ok" ? [{ id: "fresh-model" }] : [] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			expect(registry.getProviderDiscoveryState("discovery-provider")?.status).toBe("idle");
			expect(activeRowsFor(registry, ["discovery-provider", "mixed"])).toEqual([
				{ provider: "mixed", connectionKind: "credentialless" },
			]);

			await registry.refreshProvider("discovery-provider", "online");
			expect(registry.getProviderDiscoveryState("discovery-provider")?.status).toBe("empty");
			expect(activeRowsFor(registry, ["discovery-provider", "mixed"])).toEqual([
				{ provider: "mixed", connectionKind: "credentialless" },
			]);

			response = "unavailable";
			await registry.refreshProvider("discovery-provider", "online");
			expect(registry.getProviderDiscoveryState("discovery-provider")?.status).toBe("unavailable");
			expect(activeRowsFor(registry, ["discovery-provider", "mixed"])).toEqual([
				{ provider: "mixed", connectionKind: "credentialless" },
			]);

			await registry.refreshProvider("unauthenticated-provider", "online");
			expect(registry.getProviderDiscoveryState("unauthenticated-provider")?.status).toBe("unauthenticated");
			expect(activeRowsFor(registry, ["discovery-provider", "mixed"])).toEqual([
				{ provider: "mixed", connectionKind: "credentialless" },
			]);

			response = "ok";
			await registry.refreshProvider("discovery-provider", "online");
			expect(registry.getProviderDiscoveryState("discovery-provider")?.status).toBe("ok");
			expect(activeRowsFor(registry, ["discovery-provider", "mixed"])).toEqual([
				{ provider: "discovery-provider", connectionKind: "credential" },
				{ provider: "mixed", connectionKind: "credentialless" },
			]);
		});
		test("normalizes credentialless custom discovery endpoints for Q29", async () => {
			let hasModels = true;
			writeRawModelsJson({
				"credentialless-discovery": {
					baseUrl: "https://credentialless-discovery.example.com",
					api: "openai-responses",
					auth: "none",
					discovery: { type: "openai-models-list" },
				},
			});
			using _hook = hookFetch(input => {
				if (String(input) !== "https://credentialless-discovery.example.com/v1/models") {
					throw new Error(`Unexpected URL: ${input}`);
				}
				return new Response(JSON.stringify({ data: hasModels ? [{ id: "discovered-model" }] : [] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			await registry.refreshProvider("credentialless-discovery", "online");
			expect(activeRowsFor(registry, ["credentialless-discovery"])).toEqual([
				{ provider: "credentialless-discovery", connectionKind: "credentialless" },
			]);

			hasModels = false;
			await registry.refreshProvider("credentialless-discovery", "online");

			expect(registry.getProviderDiscoveryState("credentialless-discovery")?.status).toBe("empty");
			expect(registry.find("credentialless-discovery", "discovered-model")).toBeDefined();
			expect(activeRowsFor(registry, ["credentialless-discovery"])).toEqual([]);
		});
		test("uses the default endpoint for credentialed custom discovery evidence", async () => {
			writeRawModelsJson({
				"default-endpoint-discovery": {
					api: "openai-responses",
					discovery: { type: "openai-models-list" },
				},
			});
			authStorage.setRuntimeApiKey("default-endpoint-discovery", "credential");
			using _hook = hookFetch(input => {
				expect(String(input)).toBe("http://127.0.0.1:1234/v1/models");
				return new Response(JSON.stringify({ data: [{ id: "discovered-model" }] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			await registry.refreshProvider("default-endpoint-discovery", "online");

			expect(activeRowsFor(registry, ["default-endpoint-discovery"])).toEqual([
				{ provider: "default-endpoint-discovery", connectionKind: "credential" },
			]);
		});
		test("does not advertise credentialless cached discovery after a failed probe", async () => {
			let unauthorized = false;
			writeRawModelsJson({
				"credentialless-discovery": {
					baseUrl: "https://credentialless-discovery.example.com/v1",
					api: "openai-responses",
					auth: "none",
					discovery: { type: "openai-models-list" },
				},
			});
			using _hook = hookFetch(() => {
				if (unauthorized) return new Response("unauthorized", { status: 401 });
				return new Response(JSON.stringify({ data: [{ id: "discovered-model" }] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			await registry.refreshProvider("credentialless-discovery", "online");
			expect(activeRowsFor(registry, ["credentialless-discovery"])).toEqual([
				{ provider: "credentialless-discovery", connectionKind: "credentialless" },
			]);

			unauthorized = true;
			await registry.refreshProvider("credentialless-discovery", "online");

			expect(registry.getProviderDiscoveryState("credentialless-discovery")?.error).toContain("401");
			expect(activeRowsFor(registry, ["credentialless-discovery"])).toEqual([]);
		});
		test("redacts signed discovery endpoint queries from errors", async () => {
			writeRawModelsJson({
				"redacted-discovery": {
					baseUrl: "https://gateway.example.com/v1?sig=discovery-secret",
					api: "openai-responses",
					auth: "none",
					discovery: { type: "openai-models-list" },
				},
			});
			using _hook = hookFetch(input => {
				expect(String(input)).toBe("https://gateway.example.com/v1/models?sig=discovery-secret");
				return new Response("unavailable", { status: 503 });
			});
			const registry = new ModelRegistry(authStorage, modelsJsonPath);

			await registry.refreshProvider("redacted-discovery", "online");

			const error = registry.getProviderDiscoveryState("redacted-discovery")?.error;
			expect(error).toContain("https://gateway.example.com/v1/models");
			expect(error).not.toContain("discovery-secret");
		});
		test("uses refresh-aware OAuth credentials for configured discovery", async () => {
			writeRawModelsJson({
				"oauth-discovery": {
					baseUrl: "https://oauth-discovery.example.com/v1",
					api: "openai-responses",
					discovery: { type: "openai-models-list" },
				},
			});
			await authStorage.set("oauth-discovery", [
				{
					type: "oauth",
					access: "expiring-access",
					refresh: "refresh-access",
					expires: Date.now() + 30_000,
					email: "oauth@example.com",
				},
			]);
			let fetchCalls = 0;
			let oauthRefreshGeneration = 0;
			const getOAuthRefreshGenerationSpy = vi
				.spyOn(authStorage, "getProviderOAuthRefreshGeneration")
				.mockImplementation(() => oauthRefreshGeneration);
			const getApiKeySpy = vi.spyOn(authStorage, "getApiKey").mockImplementationOnce(async () => {
				await authStorage.set("oauth-discovery", [
					{
						type: "oauth",
						access: "refreshed-access",
						refresh: "refresh-access",
						expires: Date.now() + 60 * 60 * 1000,
						email: "oauth@example.com",
					},
				]);
				oauthRefreshGeneration += 1;
				return "refreshed-access";
			});
			using _hook = hookFetch((input, init) => {
				expect(String(input)).toBe("https://oauth-discovery.example.com/v1/models");
				expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer refreshed-access");
				fetchCalls += 1;
				return new Response(JSON.stringify({ data: [{ id: "oauth-model" }] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			});
			try {
				const registry = new ModelRegistry(authStorage, modelsJsonPath);
				await registry.refreshProvider("oauth-discovery", "online");

				expect(getApiKeySpy).toHaveBeenCalledWith(
					"oauth-discovery",
					undefined,
					expect.objectContaining({
						baseUrl: "https://oauth-discovery.example.com/v1",
					}),
				);
				expect(getApiKeySpy).toHaveBeenCalledTimes(1);
				expect(fetchCalls).toBe(1);
			} finally {
				getApiKeySpy.mockRestore();
				getOAuthRefreshGenerationSpy.mockRestore();
			}
		});
		test("discards configured discovery when a runtime credential changes during OAuth preflight", async () => {
			writeRawModelsJson({
				"oauth-discovery": {
					baseUrl: "https://oauth-discovery.example.com/v1",
					api: "openai-responses",
					discovery: { type: "openai-models-list" },
				},
			});
			await authStorage.set("oauth-discovery", [
				{
					type: "oauth",
					access: "expiring-access",
					refresh: "refresh-access",
					expires: Date.now() + 30_000,
					email: "oauth@example.com",
				},
			]);
			let oauthRefreshGeneration = 0;
			const getOAuthRefreshGenerationSpy = vi
				.spyOn(authStorage, "getProviderOAuthRefreshGeneration")
				.mockImplementation(() => oauthRefreshGeneration);
			const getApiKeySpy = vi.spyOn(authStorage, "getApiKey").mockImplementationOnce(async () => {
				await authStorage.set("oauth-discovery", [
					{
						type: "oauth",
						access: "refreshed-access",
						refresh: "refresh-access",
						expires: Date.now() + 60 * 60 * 1000,
						email: "oauth@example.com",
					},
				]);
				oauthRefreshGeneration += 1;
				authStorage.setRuntimeApiKey("oauth-discovery", "runtime-access");
				return "refreshed-access";
			});
			using _hook = hookFetch(() => {
				throw new Error("stale OAuth preflight must not start discovery");
			});
			try {
				const registry = new ModelRegistry(authStorage, modelsJsonPath);

				await registry.refreshProvider("oauth-discovery", "online");

				expect(getApiKeySpy).toHaveBeenCalledTimes(1);
				expect(registry.find("oauth-discovery", "oauth-model")).toBeUndefined();
				expect(readModelCache("oauth-discovery", 24 * 60 * 60 * 1000, Date.now, cacheDbPath)).toBeNull();
			} finally {
				getApiKeySpy.mockRestore();
				getOAuthRefreshGenerationSpy.mockRestore();
			}
		});
		test("keeps configured discovery provider-local when OAuth preflight fails", async () => {
			writeRawModelsJson({
				"failing-oauth-discovery": {
					baseUrl: "https://failing-oauth.example.com/v1",
					api: "openai-responses",
					discovery: { type: "openai-models-list" },
				},
			});
			await authStorage.set("failing-oauth-discovery", [
				{
					type: "oauth",
					access: "expiring-access",
					refresh: "refresh-access",
					expires: Date.now() + 30_000,
					email: "oauth@example.com",
				},
			]);
			authStorage.setRuntimeCredentialSelector("failing-oauth-discovery", {
				kind: "email",
				value: "oauth@example.com",
			});
			const getApiKeySpy = vi
				.spyOn(authStorage, "getApiKey")
				.mockRejectedValue(new Error("OAuth refresh unavailable"));
			try {
				const registry = new ModelRegistry(authStorage, modelsJsonPath);

				await expect(registry.refreshProvider("failing-oauth-discovery", "online")).resolves.toBeUndefined();

				expect(registry.getProviderDiscoveryState("failing-oauth-discovery")?.status).toBe("unauthenticated");
				expect(activeRowsFor(registry, ["failing-oauth-discovery"])).toEqual([]);
			} finally {
				getApiKeySpy.mockRestore();
			}
		});
	});
});

describe("isQuietLocalDiscoveryFailure", () => {
	const refused = Object.assign(new Error("unable to connect"), { code: "ECONNREFUSED" });

	test("accepts structured connection-refused evidence for loopback", () => {
		expect(isQuietLocalDiscoveryFailure("http://127.0.0.1:11434/v1", refused.message, refused)).toBe(true);
		expect(isQuietLocalDiscoveryFailure("http://[::1]:1234/v1", refused.message, { cause: refused })).toBe(true);
	});

	test("keeps DNS, routing, and generic message failures noisy", () => {
		expect(
			isQuietLocalDiscoveryFailure(
				"http://127.0.0.1:11434/v1",
				"unable to connect",
				Object.assign(new Error("unable to connect"), { code: "ENOTFOUND" }),
			),
		).toBe(false);
		expect(
			isQuietLocalDiscoveryFailure(
				"http://127.0.0.1:11434/v1",
				"connection refused",
				Object.assign(new Error("connection refused"), { code: "EHOSTUNREACH" }),
			),
		).toBe(false);
		expect(isQuietLocalDiscoveryFailure("http://127.0.0.1:11434/v1", "connection refused")).toBe(false);
	});

	test("keeps structured connection refusal for a remote host at warn", () => {
		expect(isQuietLocalDiscoveryFailure("https://ollama.example.com/v1", refused.message, refused)).toBe(false);
	});
});
