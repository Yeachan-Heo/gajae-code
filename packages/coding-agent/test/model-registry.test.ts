import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Effort, type Model, type OpenAICompat, type ThinkingConfig, writeModelCache } from "@gajae-code/ai";
import { kNoAuth, MODEL_ROLE_IDS, ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@gajae-code/coding-agent/config/settings";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { addApiCompatibleProvider } from "@gajae-code/coding-agent/setup/provider-onboarding";
import { hookFetch, Snowflake } from "@gajae-code/utils";

describe("model roles", () => {
	test("only the default role remains after legacy role cleanup", () => {
		expect(MODEL_ROLE_IDS).toEqual(["default"]);
	});
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
			const opusVariants = registry.getCanonicalVariants("claude-opus-4-8");
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
				const registry = new ModelRegistry(authStorage, modelsJsonPath);
				const openaiModels = getModelsForProvider(registry, "openai");
				const codexModels = getModelsForProvider(registry, "openai-codex");

				expect(openaiModels.length).toBeGreaterThan(0);
				expect(codexModels.length).toBeGreaterThan(0);
				expect(registry.getAvailable().some(model => model.provider === "openai")).toBe(true);
				expect(registry.getAvailable().some(model => model.provider === "openai-codex")).toBe(false);
				await expect(registry.getApiKey(openaiModels[0])).resolves.toBe("env-openai-key");
				await expect(registry.getApiKey(codexModels[0])).resolves.toBeUndefined();
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
	});
	describe("runtime discovery", () => {
		test("auto-discovers ollama models without provider config", async () => {
			using _hook = mockOllamaDiscovery(["phi4-mini"]);
			const _restoreOllamaKey = unsetEnvForTest("OLLAMA_API_KEY");
			try {
				const registry = new ModelRegistry(authStorage, modelsJsonPath);
				await registry.refresh();
				const ollamaModels = getModelsForProvider(registry, "ollama");
				expect(ollamaModels.some(m => m.id === "phi4-mini")).toBe(true);
				expect(registry.getAvailable().some(m => m.provider === "ollama" && m.id === "phi4-mini")).toBe(true);
				expect(await registry.getApiKey(ollamaModels[0])).toBe(kNoAuth);
			} finally {
				_restoreOllamaKey();
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
});
