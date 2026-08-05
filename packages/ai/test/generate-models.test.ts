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
	it("pins the Qwen3.8 variants and DeepSeek fallback exactly once", () => {
		const models: Model[] = [];

		injectAlibabaTokenPlanModels(models);
		for (const model of models) {
			model.name = "raw discovery name";
			model.reasoning = false;
			if (model.id === "qwen3.8-max") model.api = "openai-responses";
			if (model.id === "qwen3.8-max-preview") {
				model.api = "openai-completions";
				model.input = ["text"];
				model.maxTokens = 131_072;
			}
		}
		injectAlibabaTokenPlanModels(models);

		expect(models).toHaveLength(3);
		expect(models).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: "qwen3.8-max",
					name: "Qwen3.8 Max",
					api: "openai-completions",
					provider: "alibaba-token-plan",
					reasoning: true,
					input: ["text", "image"],
					contextWindow: 1_000_000,
					maxTokens: 131_072,
					compat: expect.objectContaining({
						supportsReasoningEffort: true,
						thinkingFormat: "qwen",
						reasoningEffortMap: { minimal: "low", high: "xhigh", max: "xhigh" },
						requiresReasoningContentForToolCalls: true,
						allowsSyntheticReasoningContentForToolCalls: false,
						disableReasoningOnForcedToolChoice: true,
					}),
				}),
				expect.objectContaining({
					id: "qwen3.8-max-preview",
					name: "Qwen3.8 Max Preview",
					api: "openai-responses",
					provider: "alibaba-token-plan",
					reasoning: true,
					input: ["text", "image"],
					contextWindow: 1_000_000,
					maxTokens: 65_536,
				}),
				expect.objectContaining({
					id: "deepseek-v4-flash-0731",
					name: "DeepSeek V4 Flash 0731",
					api: "openai-completions",
					provider: "alibaba-token-plan",
					reasoning: true,
					contextWindow: 1_000_000,
					maxTokens: 384_000,
				}),
			]),
		);
	});
});
