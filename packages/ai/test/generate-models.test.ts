import { describe, expect, it } from "bun:test";
import { injectAlibabaTokenPlanModels, injectImageGenerationModels } from "../scripts/generate-models";
import type { Model } from "../src/types";

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
		]);
	});
});

describe("injectAlibabaTokenPlanModels", () => {
	it("adds the DeepSeek V4 Flash 0731 and Qwen 3.8 Max fallbacks exactly once", () => {
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
		]);
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
