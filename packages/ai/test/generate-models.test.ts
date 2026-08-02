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
	it("adds the DeepSeek V4 Flash 0731 fallback exactly once", () => {
		const models: Model[] = [];

		injectAlibabaTokenPlanModels(models);
		models[0]!.name = "raw discovery name";
		models[0]!.reasoning = false;
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
		]);
	});
});
