import type { Usage } from "@gajae-code/ai";

const TOKENS_PER_MILLION = 1_000_000;
const MATERIAL_COST_USD = 0.01;
const MATERIAL_CACHE_TOKENS = 10_000;
const EXPENSIVE_MISS_COST_USD = 0.05;
const LARGE_INPUT_TOKENS = 20_000;
const LARGE_CACHE_WRITE_TOKENS = 25_000;
const TRANSCRIPT_WARNING_CAP = 3;

export interface CacheEconomicsPricing {
	input: number;
	cacheRead: number;
	cacheWrite: number;
}

export interface CacheEconomicsModelCost extends CacheEconomicsPricing {
	output: number;
}

export interface CacheEconomicsUsage {
	input: number;
	output?: number;
	cacheRead: number;
	cacheWrite: number;
	total?: number;
	cost?: {
		input?: number;
		output?: number;
		cacheRead?: number;
		cacheWrite?: number;
		total?: number;
	};
}

export interface CacheMissCostSummary {
	inputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	inputCostUsd: number;
	cacheReadCostUsd: number;
	cacheWriteCostUsd: number;
	cacheHitRate: number | undefined;
	missPremiumUsd: number | undefined;
}

export interface CacheBehaviorWarning {
	code: "expensive_cache_miss" | "cache_write_spike";
	reason: string;
	nextStep: string;
	costUsd: number;
}

export interface CacheWarningBuildState {
	warningsEmitted: number;
}

function positiveFinite(value: number | undefined): value is number {
	return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function bucketCost(
	tokens: number,
	bucketCostUsd: number | undefined,
	pricePerMillionTokens: number | undefined,
): number {
	if (positiveFinite(bucketCostUsd)) return bucketCostUsd;
	if (!positiveFinite(tokens) || !positiveFinite(pricePerMillionTokens)) return 0;
	return (tokens / TOKENS_PER_MILLION) * pricePerMillionTokens;
}

function hasMaterialEvidence(usage: CacheEconomicsUsage, costs: readonly number[]): boolean {
	const tokenEvidence = usage.input + usage.cacheRead + usage.cacheWrite >= MATERIAL_CACHE_TOKENS;
	const costEvidence = costs.some(cost => cost >= MATERIAL_COST_USD);
	return tokenEvidence || costEvidence;
}

export function computeCacheMissCostSummary(
	usage: CacheEconomicsUsage | undefined,
	pricing: CacheEconomicsPricing | undefined,
): CacheMissCostSummary | undefined {
	if (!usage || !pricing) return undefined;
	const inputCostUsd = bucketCost(usage.input, usage.cost?.input, pricing.input);
	const cacheReadCostUsd = bucketCost(usage.cacheRead, usage.cost?.cacheRead, pricing.cacheRead);
	const cacheWriteCostUsd = bucketCost(usage.cacheWrite, usage.cost?.cacheWrite, pricing.cacheWrite);
	if (usage.input <= 0 && cacheWriteCostUsd <= 0) return undefined;
	if (!hasMaterialEvidence(usage, [inputCostUsd, cacheReadCostUsd, cacheWriteCostUsd])) return undefined;
	if (inputCostUsd <= 0 && cacheWriteCostUsd <= 0) return undefined;

	const totalReusableInput = usage.input + usage.cacheRead;
	const cacheHitRate = totalReusableInput > 0 ? usage.cacheRead / totalReusableInput : undefined;
	const missPremiumUsd =
		positiveFinite(pricing.input) &&
		positiveFinite(pricing.cacheRead) &&
		pricing.input > pricing.cacheRead &&
		usage.input > 0
			? ((pricing.input - pricing.cacheRead) * usage.input) / TOKENS_PER_MILLION
			: undefined;

	return {
		inputTokens: usage.input,
		cacheReadTokens: usage.cacheRead,
		cacheWriteTokens: usage.cacheWrite,
		inputCostUsd,
		cacheReadCostUsd,
		cacheWriteCostUsd,
		cacheHitRate,
		missPremiumUsd: positiveFinite(missPremiumUsd) ? missPremiumUsd : undefined,
	};
}

function formatUsd(cost: number): string {
	return cost < 0.01 ? `$${cost.toFixed(4)}` : `$${cost.toFixed(2)}`;
}

function formatPercent(value: number): string {
	return `${(value * 100).toFixed(1)}%`;
}

export function formatCacheMissSummaryLines(summary: CacheMissCostSummary): string[] {
	const lines = [`Uncached Input Cost: ${formatUsd(summary.inputCostUsd)}`];
	if (summary.missPremiumUsd !== undefined) {
		lines.push(`Estimated Miss Premium: ${formatUsd(summary.missPremiumUsd)} vs cache-read pricing`);
	}
	if (summary.cacheHitRate !== undefined) {
		lines.push(`Cache Hit Rate: ${formatPercent(summary.cacheHitRate)}`);
	}
	if (summary.cacheWriteCostUsd >= MATERIAL_COST_USD) {
		lines.push(`Cache Write Cost: ${formatUsd(summary.cacheWriteCostUsd)}`);
	}
	return lines;
}

export function buildCacheBehaviorWarning(
	usage: Usage | undefined,
	model: { cost: CacheEconomicsModelCost } | undefined | null,
): CacheBehaviorWarning | undefined {
	const summary = computeCacheMissCostSummary(usage, model?.cost);
	if (!summary) return undefined;
	if (
		summary.inputTokens >= LARGE_INPUT_TOKENS &&
		(summary.cacheHitRate === undefined || summary.cacheHitRate < 0.25) &&
		summary.inputCostUsd >= EXPENSIVE_MISS_COST_USD
	) {
		return {
			code: "expensive_cache_miss",
			reason: `large uncached input with low cache hits (${formatUsd(summary.inputCostUsd)})`,
			nextStep: "keep the stable prefix; avoid rereading unchanged context before the next turn",
			costUsd: summary.inputCostUsd,
		};
	}
	if (summary.cacheWriteTokens >= LARGE_CACHE_WRITE_TOKENS && summary.cacheWriteCostUsd >= EXPENSIVE_MISS_COST_USD) {
		return {
			code: "cache_write_spike",
			reason: `large cache write without enough matching reads (${formatUsd(summary.cacheWriteCostUsd)})`,
			nextStep: "make the next turn reuse the same context; avoid changing system or tool prefixes",
			costUsd: summary.cacheWriteCostUsd,
		};
	}
	return undefined;
}

export function buildCacheEconomicsWarning(
	usage: Usage | undefined,
	model: { cost: CacheEconomicsModelCost } | undefined | null,
	state: CacheWarningBuildState,
): string | undefined {
	if (state.warningsEmitted >= TRANSCRIPT_WARNING_CAP) return undefined;
	const warning = buildCacheBehaviorWarning(usage, model);
	if (!warning) return undefined;
	state.warningsEmitted += 1;
	return `Cache warning: ${warning.reason}; next step: ${warning.nextStep}.`;
}
