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

export type CacheEconomicsBasis =
	| { kind: "persisted-aggregate"; costBreakdown: Usage["cost"] }
	| { kind: "current-model-estimate"; pricing: CacheEconomicsPricing };

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

/**
 * How a detected cache-miss pattern is attributed, per issue #2020.
 *
 * - `actionable`: usage evidence points to a user-controllable cause and GJC
 *   has a concrete remediation.
 * - `diagnostic-only`: a miss pattern is observed but the cause is not
 *   determinable from usage alone; describe what is unknown, assert no cause.
 * - `provider-side-suspected`: the provider returned no cache activity, so the
 *   miss cannot be attributed to the user's prompt; not user-actionable.
 */
export type CacheMissAttribution = "actionable" | "diagnostic-only" | "provider-side-suspected";

export interface CacheBehaviorWarning {
	code: "expensive_cache_miss" | "cache_write_spike" | "provider_side_cache_miss";
	attribution: CacheMissAttribution;
	reason: string;
	/** Concrete remediation — present only when `attribution` is `actionable`. */
	nextStep?: string;
	/** What GJC cannot determine — present for non-actionable attributions. */
	unknown?: string;
	costUsd: number;
}

export interface CacheWarningBuildState {
	warningsEmitted: number;
}

function finiteNonNegative(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function positiveFinite(value: number | undefined): value is number {
	return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function currentModelBucketCost(
	tokens: number,
	persistedCostUsd: number | undefined,
	pricePerMillionTokens: number | undefined,
): number | undefined {
	if (persistedCostUsd !== undefined) {
		return finiteNonNegative(persistedCostUsd) ? persistedCostUsd : undefined;
	}
	if (!positiveFinite(tokens) || !positiveFinite(pricePerMillionTokens)) return 0;
	return (tokens / TOKENS_PER_MILLION) * pricePerMillionTokens;
}

function persistedAggregateCosts(costBreakdown: Usage["cost"] | undefined): [number, number, number] | undefined {
	if (!costBreakdown) return undefined;
	const { input, cacheRead, cacheWrite, output, total } = costBreakdown;
	if (![input, cacheRead, cacheWrite, output, total].every(finiteNonNegative)) return undefined;
	return [input, cacheRead, cacheWrite];
}

function hasMaterialEvidence(usage: CacheEconomicsUsage, costs: readonly number[]): boolean {
	const tokenEvidence = usage.input + usage.cacheRead + usage.cacheWrite >= MATERIAL_CACHE_TOKENS;
	const costEvidence = costs.some(cost => cost >= MATERIAL_COST_USD);
	return tokenEvidence || costEvidence;
}

export function computeCacheMissCostSummary(
	usage: CacheEconomicsUsage | undefined,
	basis: CacheEconomicsBasis,
): CacheMissCostSummary | undefined {
	if (!usage) return undefined;

	const costs =
		basis.kind === "persisted-aggregate"
			? persistedAggregateCosts(basis.costBreakdown)
			: [
					currentModelBucketCost(usage.input, usage.cost?.input, basis.pricing.input),
					currentModelBucketCost(usage.cacheRead, usage.cost?.cacheRead, basis.pricing.cacheRead),
					currentModelBucketCost(usage.cacheWrite, usage.cost?.cacheWrite, basis.pricing.cacheWrite),
				];
	if (!costs) return undefined;
	const [inputCostUsd, cacheReadCostUsd, cacheWriteCostUsd] = costs;
	if (inputCostUsd === undefined || cacheReadCostUsd === undefined || cacheWriteCostUsd === undefined)
		return undefined;
	if (usage.input <= 0 && cacheWriteCostUsd <= 0) return undefined;
	if (!hasMaterialEvidence(usage, [inputCostUsd, cacheReadCostUsd, cacheWriteCostUsd])) return undefined;
	const hasAllZeroModelPrices =
		basis.kind === "current-model-estimate" &&
		basis.pricing.input === 0 &&
		basis.pricing.cacheRead === 0 &&
		basis.pricing.cacheWrite === 0;
	if (inputCostUsd <= 0 && cacheWriteCostUsd <= 0 && !hasAllZeroModelPrices) return undefined;

	const totalReusableInput = usage.input + usage.cacheRead;
	const cacheHitRate = totalReusableInput > 0 ? usage.cacheRead / totalReusableInput : undefined;
	const inputMissPremiumUsd =
		basis.kind === "current-model-estimate" &&
		positiveFinite(basis.pricing.input) &&
		positiveFinite(basis.pricing.cacheRead) &&
		basis.pricing.input > basis.pricing.cacheRead &&
		usage.input > 0
			? ((basis.pricing.input - basis.pricing.cacheRead) * usage.input) / TOKENS_PER_MILLION
			: 0;
	const cacheWritePremiumUsd =
		basis.kind === "current-model-estimate" &&
		positiveFinite(basis.pricing.cacheWrite) &&
		positiveFinite(basis.pricing.cacheRead) &&
		basis.pricing.cacheWrite > basis.pricing.cacheRead &&
		usage.cacheWrite > 0
			? ((basis.pricing.cacheWrite - basis.pricing.cacheRead) * usage.cacheWrite) / TOKENS_PER_MILLION
			: 0;
	const missPremiumUsd = inputMissPremiumUsd + cacheWritePremiumUsd;

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
	if (!model) return undefined;
	const summary = computeCacheMissCostSummary(usage, {
		kind: "current-model-estimate",
		pricing: model.cost,
	});
	if (!summary) return undefined;
	const tokenOnlyPricing = model.cost.input === 0 && model.cost.cacheRead === 0 && model.cost.cacheWrite === 0;
	if (
		summary.inputTokens >= LARGE_INPUT_TOKENS &&
		(summary.cacheHitRate === undefined || summary.cacheHitRate < 0.25) &&
		(tokenOnlyPricing || summary.inputCostUsd >= EXPENSIVE_MISS_COST_USD)
	) {
		// Attribute by observable cache activity rather than asserting a cause (#2020).
		const noCacheActivity = summary.cacheReadTokens <= 0 && summary.cacheWriteTokens <= 0;
		if (noCacheActivity) {
			// The provider returned zero cache read/write tokens for a large, costly
			// prompt: the miss cannot be traced to the user's prefix, and keeping a
			// stable prefix cannot help when nothing is being cached at all.
			return {
				code: "provider_side_cache_miss",
				attribution: "provider-side-suspected",
				reason: `large uncached input with no cache activity (${formatUsd(summary.inputCostUsd)})`,
				unknown:
					"the provider reported no cache reads or writes, so GJC cannot tell whether prompt caching is unsupported, missing cache-control fields, or provider-side eviction",
				costUsd: summary.inputCostUsd,
			};
		}
		if (summary.cacheWriteTokens > 0) {
			// Writes are landing but reuse is low: the cacheable prefix is churning
			// between turns, which is user-controllable.
			return {
				code: "expensive_cache_miss",
				attribution: "actionable",
				reason: `large uncached input with low cache reuse (${formatUsd(summary.inputCostUsd)})`,
				nextStep: "keep the stable prefix; avoid rereading unchanged context before the next turn",
				costUsd: summary.inputCostUsd,
			};
		}
		// Reads happened but no writes this turn: part of the prefix was reused, yet
		// the large new input was not cached. From usage alone GJC cannot tell new
		// content apart from a provider-side gap, so it reports without asserting.
		return {
			code: "expensive_cache_miss",
			attribution: "diagnostic-only",
			reason: `large uncached input with partial cache reuse (${formatUsd(summary.inputCostUsd)})`,
			unknown:
				"the uncached tokens may be genuinely new content or a provider-side gap; usage alone cannot attribute a single cause",
			costUsd: summary.inputCostUsd,
		};
	}
	if (
		summary.cacheWriteTokens >= LARGE_CACHE_WRITE_TOKENS &&
		(tokenOnlyPricing || summary.cacheWriteCostUsd >= EXPENSIVE_MISS_COST_USD) &&
		// Only claim reuse is insufficient when reads actually fail to cover the
		// writes; a large write that is being read back is healthy, not a spike.
		summary.cacheReadTokens < summary.cacheWriteTokens
	) {
		return {
			code: "cache_write_spike",
			attribution: "actionable",
			reason: `large cache write without enough matching reads (${formatUsd(summary.cacheWriteCostUsd)})`,
			nextStep: "make the next turn reuse the same context; avoid changing system or tool prefixes",
			costUsd: summary.cacheWriteCostUsd,
		};
	}
	return undefined;
}

/**
 * Render a cache warning as a single transcript line. Actionable attributions
 * carry a concrete next step; non-actionable ones state what is unknown and,
 * for provider-side patterns, that the miss is not user-actionable — never
 * asserting a cause or blaming the provider (#2020).
 */
export function formatCacheWarningLine(warning: CacheBehaviorWarning): string {
	if (warning.attribution === "actionable" && warning.nextStep) {
		return `Cache warning: ${warning.reason}; next step: ${warning.nextStep}.`;
	}
	if (warning.attribution === "provider-side-suspected") {
		const detail = warning.unknown ? ` — ${warning.unknown}` : "";
		return `Cache notice: ${warning.reason}; provider-side suspected / not user-actionable${detail}.`;
	}
	const detail = warning.unknown ? `; ${warning.unknown}` : "";
	return `Cache notice: ${warning.reason}${detail}.`;
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
	return formatCacheWarningLine(warning);
}
