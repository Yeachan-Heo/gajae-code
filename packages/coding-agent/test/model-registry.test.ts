import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	type Api,
	type Context,
	Effort,
	type Model,
	type OpenAICompat,
	readModelCache,
	type ThinkingConfig,
	writeModelCache,
} from "@gajae-code/ai";
import { streamOpenAICompletions } from "@gajae-code/ai/providers/openai-completions";
import { kNoAuth, MODEL_ROLE_IDS, ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import {
	type ModelLookupRegistry,
	resolveModelFromString,
	resolveModelOverride,
	resolveModelOverrideWithAuthFallback,
} from "@gajae-code/coding-agent/config/model-resolver";
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

describe("ModelRegistry", () => {
	let tempDir: string;
	let modelsJsonPath: string;
	let cacheDbPath: string;
	let authStorage: AuthStorage;

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = path.join(os.tmpdir(), `pi-test-model-registry-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		modelsJsonPath = path.join(tempDir, "models.json");
		cacheDbPath = path.join(tempDir, "models.db");
		authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"));
	});

	afterEach(() => {
		resetSettingsForTest();
		authStorage.close();
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
		// All custom-model compat overrides flow through OpenAICompatSchema regardless of
		// the underlying api ("openai-completions" vs "openai-responses"), so we can read
		// the field for any model in this fixture.
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

			expect(getApiKey).toHaveBeenNthCalledWith(1, "anthropic", "model-session", {
				baseUrl: model.baseUrl,
				modelId: model.id,
				credentialSelector,
				signal: controller.signal,
			});
			expect(getApiKey).toHaveBeenNthCalledWith(2, "anthropic", "provider-session", {
				baseUrl: "https://proxy.example.com",
				credentialSelector,
				signal: controller.signal,
			});
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
			await Settings.init({
				inMemory: true,
				overrides: {
					modelProviderOrder: ["demo", "anthropic"],
				},
			});
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
			const initial = registry.resolveCanonicalModel("claude-sonnet-4-5", {
				availableOnly: true,
				candidates: candidates(),
				sessionId: "session-0",
			});
			for (let index = 1; index < 65; index += 1) {
				registry.resolveCanonicalModel("claude-sonnet-4-5", {
					availableOnly: true,
					candidates: candidates(),
					sessionId: `session-${index}`,
				});
			}
			const reversedCandidates = [...candidates()].reverse();
			expect(
				registry.resolveCanonicalModel("claude-sonnet-4-5", {
					availableOnly: true,
					candidates: reversedCandidates,
					sessionId: "session-0",
				}),
			).not.toBe(initial);
		});

		test("prefers vision-capable variant over configured provider order", async () => {
			await Settings.init({
				inMemory: true,
				overrides: {
					modelProviderOrder: ["demo", "anthropic"],
				},
			});
			// demo's variant is text-only and ranked first by provider order, but the
			// vision-capable bundled variant must win so an ambiguous id never resolves
			// to a text-only namesake when a vision-capable variant is available.
			writeRawModelsJson({
				demo: providerConfig("https://demo.example.com/v1", [{ id: "anthropic/claude-sonnet-4.5" }]),
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const resolved = registry.resolveCanonicalModel("claude-sonnet-4-5", {
				availableOnly: false,
				candidates: registry.getAll(),
			});

			expect(resolved?.input.includes("image")).toBe(true);
			expect(resolved?.provider).toBe("anthropic");
		});
		test("ranks bare aliases and canonical ids identically across provider order conflicts", async () => {
			await Settings.init({
				inMemory: true,
				overrides: { modelProviderOrder: ["beta", "alpha"] },
			});
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
				expect(available).not.toBe(afterFirst);
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
				await expect(authStorage.peekApiKey("xai")).resolves.toBeUndefined();
				expect(registry.getAvailable().some(model => model.provider === "xai")).toBe(true);
				expect(registry.getActiveProviders().some(provider => provider.provider === "xai")).toBe(false);

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
			// The child-first canonical lookup must not populate the parent scope.
			expect(
				registry.resolveCanonicalModel("claude-sonnet-4-5", {
					availableOnly: true,
					candidates: [...fixtureModels()].reverse(),
					sessionId: "parent-session",
				}),
			).toBe(betaModel);
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

		test("provider presets load through the model registry with expected OpenAI-compatible settings", async () => {
			const presetModelsPath = path.join(tempDir, "preset-models.yml");
			await addApiCompatibleProvider({ preset: "minimax", modelsPath: presetModelsPath });
			await addApiCompatibleProvider({ preset: "zai", modelsPath: presetModelsPath });

			const registry = new ModelRegistry(authStorage, presetModelsPath);
			const minimax = registry.find("minimax-code", "minimax-m3");
			const glm = registry.find("glm-proxy", "glm-4.6");

			expect(minimax?.api).toBe("openai-completions");
			// #614: preset-onboarded models inherit the bundled canonical display
			// name (MiniMax-M3) while preserving the lowercase machine id.
			expect(minimax?.id).toBe("minimax-m3");
			expect(minimax?.name).toBe("MiniMax-M3");
			expect(minimax?.baseUrl).toBe("https://api.minimax.io/v1");
			expect(getOpenAICompat(minimax)?.supportsStore).toBe(false);
			expect(getOpenAICompat(minimax)?.reasoningContentField).toBe("reasoning_content");
			expect(glm?.api).toBe("openai-completions");
			expect(glm?.baseUrl).toBe("https://api.z.ai/api/paas/v4");
			expect(getOpenAICompat(glm)?.thinkingFormat).toBe("zai");
			expect(getOpenAICompat(glm)?.supportsReasoningEffort).toBe(false);
		});

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
					disabledProviders: ["llama.cpp", "lm-studio", "ollama"],
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
					disabledProviders: ["llama.cpp", "lm-studio", "ollama"],
				},
			});
			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			expect(registry.getDiscoverableProviders()).not.toContain("ollama");

			settings.override("disabledProviders", []);
			await registry.refresh("offline");

			expect(registry.getDiscoverableProviders()).toContain("ollama");
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

			expect(ollama?.api).toBe("openai-responses");
			expect(ollama?.baseUrl).toBe("http://127.0.0.1:11434/v1");
			expect(registry.getProviderDiscoveryState("ollama")?.status).toBe("cached");
		});

		test("discovers ollama thinking capabilities from show metadata", async () => {
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
			expect(qwen?.thinking).toEqual({
				mode: "effort",
				minLevel: Effort.Minimal,
				maxLevel: Effort.High,
			});

			const llama = registry.find("ollama", "llama3.2:3b");
			expect(llama?.reasoning).toBe(false);
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

		test("keeps the newest same-provider discovery result when overlapping refreshes complete out of order", async () => {
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
			await registry.refreshProvider("race", "online");
			firstResponse.resolve(
				new Response(JSON.stringify({ data: [{ id: "old-model" }] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			);
			await firstRefresh;

			expect(registry.getProviderDiscoveryState("race")?.models).toEqual(["new-model"]);
			expect(registry.find("race", "new-model")).toBeDefined();
			expect(registry.find("race", "old-model")).toBeUndefined();
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
				true,
			);
			const state = cachedRegistry.getProviderDiscoveryState("custom-local");
			expect(state?.status).toBe("unauthenticated");
			expect(state?.models).toContain("local-coder");
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

					expect(getApiKeySpy).toHaveBeenCalledWith("llama.cpp", undefined, {
						baseUrl: "http://127.0.0.1:8080",
					});
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
		test("newer optional-auth preflight state wins when overlapping refreshes finish out of order", async () => {
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
					while (credentialCalls < 2) await Bun.sleep(0);

					newerCredential.resolve(undefined);
					await newerRefresh;
					expect(await registry.getApiKeyForProvider("llama.cpp")).toBe(kNoAuth);

					olderCredential.resolve("older-preflight-key");
					await olderRefresh;
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

		expect(registry.find("ollama-cloud", "deepseek-v4-pro")?.maxTokens).toBe(384_000);
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
		expect(cachedRegistry.find("proxy", "cached-proxy-model")?.requestTransform).toEqual({
			profile: "openai-proxy",
			setHeaders: { "x-proxy": "enabled" },
			extraBody: { proxy: true },
		});

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

			expect(registry.getActiveProviders()).toEqual([{ provider: "local", connectionKind: "credential" }]);
			expect(await registry.getApiKeyForProvider("local")).toBe("STORED_TEST_KEY");
			await authStorage.set("local", []);

			expect(registry.find("local", "local-model")).toBeDefined();
			expect(registry.getActiveProviders()).toEqual([]);
		});
	});
	describe("active provider resolution", () => {
		const activeRowsFor = (registry: ModelRegistry, providerIds: readonly string[]) => {
			const selected = new Set(providerIds);
			return registry.getActiveProviders().filter(provider => selected.has(provider.provider));
		};
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

			expect(registry.getActiveProviders()).toEqual([
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
			authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"), {
				configValueResolver: async () => undefined,
			});
			await authStorage.set("anthropic", [{ type: "api_key", key: "!missing-anthropic-key" }]);

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			await registry.refresh();

			expect(registry.getAll().some(model => model.provider === "anthropic")).toBe(true);
			expect(activeRowsFor(registry, ["anthropic"])).toEqual([]);
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
			expect(registry.getProviderDiscoveryState("discovery-provider")?.status).toBe("cached");
			expect(activeRowsFor(registry, ["discovery-provider"])).toEqual([]);
			await registry.refreshProvider("discovery-provider", "online-if-uncached");
			expect(registry.getProviderDiscoveryState("discovery-provider")?.status).toBe("ok");
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

			expect(registry.getProviderDiscoveryState("credentialless-provider")?.status).toBe("cached");
			expect(activeRowsFor(registry, ["credentialless-provider"])).toEqual([
				{ provider: "credentialless-provider", connectionKind: "credentialless" },
			]);
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

			expect(activeRowsFor(registry, ["custom-lm-studio"])).toEqual([
				{ provider: "custom-lm-studio", connectionKind: "credentialless" },
			]);
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

			expect(registry.getProviderDiscoveryState("vllm")?.status).toBe("cached");
			expect(activeRowsFor(registry, ["vllm"])).toEqual([{ provider: "vllm", connectionKind: "credentialless" }]);
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

			expect(registry.getProviderDiscoveryState("credentialless-provider")?.status).toBe("cached");
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

				expect(registry.getProviderDiscoveryState("ollama")?.status).toBe("cached");
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

				expect(registry.getProviderDiscoveryState("lm-studio")?.status).toBe("cached");
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
		});
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
		test("does not let a stale configured refresh clear newer credential evidence", async () => {
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
			resolveNewer(
				new Response(JSON.stringify({ data: [{ id: "discovered-model" }] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			);
			await newerRefresh;
			resolveOlder(
				new Response(JSON.stringify({ data: [{ id: "discovered-model" }] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			);
			await olderRefresh;

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
			expect(JSON.stringify(cached)).not.toContain("runtime-secret");
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
			expect(cachedRegistry.find("discovery-provider", "runtime-model")?.baseUrl).toBe(
				"https://runtime.example.com/v1?sig=runtime-secret",
			);
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

			expect(registry.find("vllm", "cached-vllm-model")).toBeDefined();
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

			expect(registry.find("vllm", "cached-vllm-model")).toBeDefined();
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
				expect(JSON.stringify(cached)).not.toContain("descriptor-secret");
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
		test("does not let an older descriptor refresh overwrite a newer failed probe", async () => {
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
			resolveNewer(new Response("unavailable", { status: 503 }));
			await newerRefresh;
			resolveOlder(
				new Response(JSON.stringify({ data: [{ id: "older-model" }] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			);
			await olderRefresh;
			expect(readModelCache("vllm", 24 * 60 * 60 * 1000, Date.now, cacheDbPath)?.models).toEqual([]);

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
			await registry.refreshProvider("openai", "offline");

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

				expect(getApiKeySpy).toHaveBeenCalledWith("oauth-discovery", undefined, {
					baseUrl: "https://oauth-discovery.example.com/v1",
				});
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
