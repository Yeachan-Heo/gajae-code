import type { Api, LongContextPricing, Model, ModelCost } from "./types";

interface TieredPricing {
	cost: ModelCost;
	longContextPricing: LongContextPricing;
}

const LONG_CONTEXT_THRESHOLD = 272_000;
// Anthropic Haiku 5.5's direct Messages API charges five times the base rates
// when prompt input exceeds 100K tokens, including cached input.
// https://platform.claude.com/docs/en/models/haiku-5-5/overview#pricing
const ANTHROPIC_HAIKU_5_5_LONG_CONTEXT_PRICING: LongContextPricing = {
	threshold: 100_000,
	cost: { input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 },
};
// `ModelCost.cacheWrite` is the 5-minute cache-write rate. Haiku 5.5 charges 1-hour
// writes at twice the base input rate in each prompt-length tier ($0.20 up to 100K
// tokens, $1 above), and the provider defaults to `ttl: "1h"`.
const ANTHROPIC_HAIKU_5_5_CACHE_WRITE_1H = { standard: 0.2, longContext: 1 };

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

const BEDROCK_HAIKU_5_5_ID = /^(?:(?:au|eu|global|jp|us).)?anthropic.claude-haiku-5-5$/;
// Bedrock bills Haiku 5.5 prompts above 100K tokens at higher "Long Context" rates.
// AWS documents the threshold but the per-token rates only on its pricing page,
// which is not machine-readable; mirror Anthropic's published 5x multiplier on each
// inference profile's own base rates.
// https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-haiku-5-5.html#model-card-anthropic-claude-haiku-5-5-pricing
const BEDROCK_HAIKU_5_5_LONG_CONTEXT_MULTIPLIER = 5;

function getAnthropicLongContextPricing<TApi extends Api>(model: Model<TApi>): LongContextPricing | undefined {
	if (model.provider === "anthropic" && model.api === "anthropic-messages" && model.id === "claude-haiku-5-5") {
		return {
			threshold: ANTHROPIC_HAIKU_5_5_LONG_CONTEXT_PRICING.threshold,
			cost: { ...ANTHROPIC_HAIKU_5_5_LONG_CONTEXT_PRICING.cost },
		};
	}
	if (
		model.provider === "amazon-bedrock" &&
		model.api === "bedrock-converse-stream" &&
		BEDROCK_HAIKU_5_5_ID.test(model.id)
	) {
		const m = BEDROCK_HAIKU_5_5_LONG_CONTEXT_MULTIPLIER;
		const scale = (rate: number): number => Math.round(rate * m * 1e9) / 1e9;
		return {
			threshold: ANTHROPIC_HAIKU_5_5_LONG_CONTEXT_PRICING.threshold,
			cost: {
				input: scale(model.cost.input),
				output: scale(model.cost.output),
				cacheRead: scale(model.cost.cacheRead),
				cacheWrite: scale(model.cost.cacheWrite),
			},
		};
	}
	return undefined;
}

export function getAnthropicModelCost<TApi extends Api>(
	model: Model<TApi>,
	inputTokens: number,
): ModelCost | undefined {
	const pricing = getAnthropicLongContextPricing(model);
	if (!pricing || inputTokens <= pricing.threshold) return undefined;
	return pricing.cost;
}

/**
 * $/million rate for 1-hour cache writes, or undefined when the model has a single
 * cache-write rate. Cost calculation applies it to `usage.cttl.ephemeral1h` and bills
 * the remaining cache-write tokens at `ModelCost.cacheWrite`.
 */
export function getAnthropicCacheWriteOneHourRate<TApi extends Api>(
	model: Model<TApi>,
	inputTokens: number,
): number | undefined {
	const aboveThreshold = inputTokens > ANTHROPIC_HAIKU_5_5_LONG_CONTEXT_PRICING.threshold;
	if (model.provider === "anthropic" && model.api === "anthropic-messages" && model.id === "claude-haiku-5-5") {
		return aboveThreshold
			? ANTHROPIC_HAIKU_5_5_CACHE_WRITE_1H.longContext
			: ANTHROPIC_HAIKU_5_5_CACHE_WRITE_1H.standard;
	}
	if (
		model.provider === "amazon-bedrock" &&
		model.api === "bedrock-converse-stream" &&
		BEDROCK_HAIKU_5_5_ID.test(model.id)
	) {
		// Same structure as direct: 1-hour writes cost twice the tier's input rate.
		const multiplier = aboveThreshold ? BEDROCK_HAIKU_5_5_LONG_CONTEXT_MULTIPLIER : 1;
		return Math.round(2 * model.cost.input * multiplier * 1e9) / 1e9;
	}
	return undefined;
}

export function applyAnthropicModelPricing<TApi extends Api>(model: Model<TApi>): void {
	const pricing = getAnthropicLongContextPricing(model);
	if (pricing) model.longContextPricing = pricing;
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
