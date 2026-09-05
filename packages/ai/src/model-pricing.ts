import type { Api, LongContextPricing, Model, ModelCost } from "./types";

interface TieredPricing {
	cost: ModelCost;
	longContextPricing: LongContextPricing;
}

const LONG_CONTEXT_THRESHOLD = 272_000;

const GPT_5_6_SOL_PRICING: TieredPricing = {
	cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
	longContextPricing: {
		threshold: LONG_CONTEXT_THRESHOLD,
		cost: { input: 10, output: 45, cacheRead: 1, cacheWrite: 12.5 },
	},
};

const GPT_6_ASTRA_PRICING: TieredPricing = {
	cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
	longContextPricing: {
		threshold: LONG_CONTEXT_THRESHOLD,
		cost: { input: 20, output: 75, cacheRead: 2, cacheWrite: 25 },
	},
};

// OpenAI Standard pricing: https://developers.openai.com/api/docs/pricing
const OPENAI_GPT_5_6_PRICING: ReadonlyMap<string, TieredPricing> = new Map([
	["gpt-6-astra", GPT_6_ASTRA_PRICING],
	["gpt-5.6", GPT_5_6_SOL_PRICING],
	["gpt-5.6-sol", GPT_5_6_SOL_PRICING],
	[
		"gpt-5.6-terra",
		{
			cost: { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 2.5 },
			longContextPricing: {
				threshold: LONG_CONTEXT_THRESHOLD,
				cost: { input: 4, output: 18, cacheRead: 0.4, cacheWrite: 5 },
			},
		},
	],
	[
		"gpt-5.6-luna",
		{
			cost: { input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite: 0.25 },
			longContextPricing: {
				threshold: LONG_CONTEXT_THRESHOLD,
				cost: { input: 0.4, output: 1.8, cacheRead: 0.04, cacheWrite: 0.5 },
			},
		},
	],
]);

export function getOpenAIModelCost<TApi extends Api>(model: Model<TApi>, inputTokens: number): ModelCost | undefined {
	if (model.provider !== "openai" && model.provider !== "openai-codex") {
		return undefined;
	}
	const pricing = OPENAI_GPT_5_6_PRICING.get(model.id);
	if (!pricing) {
		return undefined;
	}
	return inputTokens > pricing.longContextPricing.threshold ? pricing.longContextPricing.cost : pricing.cost;
}

export function applyOpenAIModelPricing<TApi extends Api>(model: Model<TApi>): void {
	if (model.provider !== "openai" && model.provider !== "openai-codex") {
		return;
	}
	const pricing = OPENAI_GPT_5_6_PRICING.get(model.id);
	if (!pricing) {
		return;
	}
	model.cost = { ...pricing.cost };
	model.longContextPricing = {
		threshold: pricing.longContextPricing.threshold,
		cost: { ...pricing.longContextPricing.cost },
	};
}
