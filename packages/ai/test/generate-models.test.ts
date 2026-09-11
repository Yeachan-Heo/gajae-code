import { describe, expect, it } from "bun:test";
import {
	injectAlibabaTokenPlanModels,
	injectCodexAstraModel,
	injectImageGenerationModels,
	injectMuseSparkModels,
} from "../scripts/generate-models";
import type { Model } from "../src/types";

describe("injectCodexAstraModel", () => {
	it("adds the reviewed Codex fallback exactly once", () => {
		const models: Model[] = [];

		injectCodexAstraModel(models);
		injectCodexAstraModel(models);

		expect(models).toEqual([
			expect.objectContaining({
				id: "gpt-6-astra",
				name: "GPT-6-Astra",
				api: "openai-codex-responses",
				provider: "openai-codex",
				reasoning: true,
				input: ["text", "image"],
				contextWindow: 272_000,
				maxTokens: 128_000,
				preferWebsockets: true,
				priority: 1,
			}),
		]);
	});

	it("preserves authenticated discovery metadata", () => {
		const discovered: Model<"openai-codex-responses"> = {
			id: "gpt-6-astra",
			name: "Newer discovery name",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 300_000,
			maxTokens: 128_000,
		};
		const models: Model[] = [discovered];

		injectCodexAstraModel(models);

		expect(models).toEqual([discovered]);
	});
});

describe("injectImageGenerationModels", () => {
	it("adds typed image-output models once for OpenAI and Codex", () => {
		const models: Model[] = [];

		injectImageGenerationModels(models);
		injectImageGenerationModels(models);

		expect(models).toEqual([
			expect.objectContaining({
				id: "gpt-image-2",
				api: "openai-responses",
				provider: "openai",
				input: ["text"],
				output: ["text", "image"],
			}),
			expect.objectContaining({
				id: "gpt-image-2",
				api: "openai-codex-responses",
				provider: "openai-codex",
				input: ["text"],
				output: ["text", "image"],
			}),
			expect.objectContaining({
				id: "gpt-image-2.5-sunburst",
				api: "openai-responses",
				provider: "openai",
				input: ["text"],
				output: ["text", "image"],
			}),
			expect.objectContaining({
				id: "gpt-image-2.5-sunburst",
				api: "openai-codex-responses",
				provider: "openai-codex",
				input: ["text"],
				output: ["text", "image"],
			}),
			expect.objectContaining({
				id: "gpt-image-2.5-flare",
				api: "openai-responses",
				provider: "openai",
				input: ["text"],
				output: ["text", "image"],
			}),
			expect.objectContaining({
				id: "gpt-image-2.5-flare",
				api: "openai-codex-responses",
				provider: "openai-codex",
				input: ["text"],
				output: ["text", "image"],
			}),
		]);
	});
});

describe("injectAlibabaTokenPlanModels", () => {
	it("adds the DeepSeek and Qwen 3.8 Max fallbacks exactly once", () => {
		const models: Model[] = [];

		injectAlibabaTokenPlanModels(models);
		models[0]!.name = "raw discovery name";
		models[0]!.reasoning = false;
		models[1]!.name = "raw discovery name";
		models[1]!.reasoning = false;
		injectAlibabaTokenPlanModels(models);

		expect(models).toEqual([
			expect.objectContaining({
				id: "deepseek-v4-flash-0731",
				name: "DeepSeek V4 Flash 0731",
				api: "openai-completions",
				provider: "alibaba-token-plan",
				reasoning: true,
				contextWindow: 1_000_000,
				maxTokens: 384_000,
			}),
			expect.objectContaining({
				id: "qwen3.8-max",
				name: "Qwen3.8 Max",
				api: "openai-responses",
				provider: "alibaba-token-plan",
				reasoning: true,
				contextWindow: 1_000_000,
				maxTokens: 65_536,
			}),
			expect.objectContaining({
				id: "qwen3.8-max-preview",
				name: "Qwen3.8 Max Preview",
				api: "openai-responses",
				provider: "alibaba-token-plan",
				reasoning: true,
				input: ["text"],
				contextWindow: 1_000_000,
				maxTokens: 65_536,
			}),
		]);
	});

	it("restores the Qwen preview Responses transport over discovered metadata", () => {
		const models: Model[] = [
			{
				id: "qwen3.8-max-preview",
				name: "Discovered preview",
				api: "openai-completions",
				provider: "alibaba-token-plan",
				baseUrl: "https://example.invalid",
				reasoning: true,
				input: ["text", "image"],
				cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
				contextWindow: 1,
				maxTokens: 1,
			},
		];

		injectAlibabaTokenPlanModels(models);

		expect(models[0]).toMatchObject({
			api: "openai-responses",
			input: ["text"],
			contextWindow: 1_000_000,
			maxTokens: 65_536,
		});
	});

	it("removes every legacy Qwen 3.8 Max alias before restoring the canonical model", () => {
		const legacy = (): Model<"openai-responses"> => ({
			id: "qwen-3.8-max",
			name: "Legacy Qwen",
			api: "openai-responses",
			provider: "alibaba-token-plan",
			baseUrl: "https://example.invalid",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1,
			maxTokens: 1,
		});
		const models: Model[] = [legacy(), legacy(), { ...legacy(), id: "qwen3.8-max" }];

		injectAlibabaTokenPlanModels(models);

		expect(models.filter(model => model.provider === "alibaba-token-plan" && model.id === "qwen-3.8-max")).toEqual(
			[],
		);
		expect(
			models.filter(model => model.provider === "alibaba-token-plan" && model.id === "qwen3.8-max"),
		).toHaveLength(1);
	});
});

describe("injectMuseSparkModels", () => {
	it("adds and corrects the authoritative OpenRouter Muse Spark route exactly once", () => {
		const models: Model[] = [];

		injectMuseSparkModels(models);
		models[0]!.reasoning = false;
		models[0]!.contextWindow = 1;
		injectMuseSparkModels(models);

		expect(models).toEqual([
			expect.objectContaining({
				id: "meta/muse-spark-1.2",
				provider: "openrouter",
				api: "openai-completions",
				reasoning: true,
				contextWindow: 1_048_576,
				maxTokens: 131_072,
				input: ["text", "image"],
				thinking: {
					mode: "effort",
					minLevel: "minimal",
					maxLevel: "xhigh",
				},
			}),
		]);
	});
});
