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

// GPT-6 Astra: $10/$50 standard, cache read $1, cache write $12.50; inputs past
// 272K apply 2x to input/cache and 1.5x to output.
const GPT_6_ASTRA_PRICING: TieredPricing = {
	cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
	longContextPricing: {
		threshold: LONG_CONTEXT_THRESHOLD,
		cost: { input: 20, output: 75, cacheRead: 2, cacheWrite: 25 },
	},
};

// GPT-6 Sol: $2/$10 standard, cache read $0.20, cache write $2.50; inputs past
// 272K apply 2x to input/cache and 1.5x to output.
const GPT_6_SOL_PRICING: TieredPricing = {
	cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
	longContextPricing: {
		threshold: LONG_CONTEXT_THRESHOLD,
		cost: { input: 4, output: 15, cacheRead: 0.4, cacheWrite: 5 },
	},
};

// TODO(gpt-6.1-sol): cache-write and long-context prices not yet published; derived from gpt-6-sol / 2x-1.5x rule
const GPT_6_1_SOL_PRICING: TieredPricing = {
	cost: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
	longContextPricing: {
		threshold: LONG_CONTEXT_THRESHOLD,
		cost: { input: 4, output: 15, cacheRead: 0.2, cacheWrite: 5 },
	},
};

// GPT-6 Luna: $0.10/$0.50 standard, cache read $0.01, cache write $0.125;
// inputs past 272K apply 2x to input/cache and 1.5x to output.
const GPT_6_LUNA_PRICING: TieredPricing = {
	cost: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
	longContextPricing: {
		threshold: LONG_CONTEXT_THRESHOLD,
		cost: { input: 0.2, output: 0.75, cacheRead: 0.02, cacheWrite: 0.25 },
	},
};

// OpenAI Standard pricing: https://developers.openai.com/api/docs/pricing
const OPENAI_GPT_5_6_PRICING: ReadonlyMap<string, TieredPricing> = new Map([
	["gpt-6-astra", GPT_6_ASTRA_PRICING],
	["gpt-6-sol", GPT_6_SOL_PRICING],
	["gpt-6.1-sol", GPT_6_1_SOL_PRICING],
	["gpt-6-luna", GPT_6_LUNA_PRICING],
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

const CLAUDE_HAIKU_5_5_LONG_CONTEXT_THRESHOLD = 100_000;

function firstPartyClaudeModelId<TApi extends Api>(model: Model<TApi>): string | undefined {
	if (model.provider === "anthropic" && model.api === "anthropic-messages") {
		return model.id;
	}
	if (model.provider === "amazon-bedrock" && model.api === "bedrock-converse-stream") {
		return model.id.replace(/^(?:au|eu|global|jp|us)\./, "").replace(/^anthropic\./, "");
	}
	return undefined;
}

function multiplyCost(cost: ModelCost, multiplier: number): ModelCost {
	return {
		input: cost.input * multiplier,
		output: cost.output * multiplier,
		cacheRead: cost.cacheRead * multiplier,
		cacheWrite: cost.cacheWrite * multiplier,
	};
}

/** Persist first-party Anthropic pricing corrections into the generated catalog. */
export function applyAnthropicModelPricing<TApi extends Api>(model: Model<TApi>): void {
	const modelId = firstPartyClaudeModelId(model);
	if (modelId === "claude-sonnet-5-5") {
		// Anthropic documents Sonnet 5.5 cache hits at 5% of base input, not 10%.
		// https://platform.claude.com/docs/en/about-claude/pricing#model-pricing
		model.cost.cacheRead = Number((model.cost.input / 20).toPrecision(12));
	}
	if (modelId === "claude-haiku-5-5") {
		// Haiku 5.5 charges 5x each rate when the prompt exceeds 100,000 tokens.
		// https://platform.claude.com/docs/en/about-claude/pricing#model-pricing
		model.longContextPricing = {
			threshold: CLAUDE_HAIKU_5_5_LONG_CONTEXT_THRESHOLD,
			cost: multiplyCost(model.cost, 5),
		};
	}
}

/** Return the audited Haiku 5.5 over-100K rates for first-party Anthropic routes. */
export function getAnthropicModelCost<TApi extends Api>(
	model: Model<TApi>,
	inputTokens: number,
): ModelCost | undefined {
	if (
		firstPartyClaudeModelId(model) !== "claude-haiku-5-5" ||
		inputTokens <= CLAUDE_HAIKU_5_5_LONG_CONTEXT_THRESHOLD
	) {
		return undefined;
	}
	return multiplyCost(model.cost, 5);
}

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
