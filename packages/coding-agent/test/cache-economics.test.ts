import { describe, expect, it } from "bun:test";
import type { Model, Usage } from "@gajae-code/ai";
import {
	buildCacheBehaviorWarning,
	buildCacheEconomicsWarning,
	type CacheEconomicsBasis,
	type CacheEconomicsUsage,
	computeCacheMissCostSummary,
	formatCacheWarningLine,
} from "@gajae-code/coding-agent/session/cache-economics";

function usage(overrides: Partial<Usage>): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		...overrides,
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: 0,
			...overrides.cost,
		},
	};
}

function modelWithCost(cost: Model["cost"]): Pick<Model, "cost"> {
	return { cost };
}

const priced = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
const currentModelEstimate: CacheEconomicsBasis = { kind: "current-model-estimate", pricing: priced };

function usageWithoutPersistedCosts(overrides: Partial<CacheEconomicsUsage>): CacheEconomicsUsage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		...overrides,
	};
}

function persistedAggregate(costBreakdown: Usage["cost"]): CacheEconomicsBasis {
	return { kind: "persisted-aggregate", costBreakdown };
}

describe("cache economics", () => {
	it("omits zero or absent usage", () => {
		expect(computeCacheMissCostSummary(undefined, currentModelEstimate)).toBeUndefined();
		expect(computeCacheMissCostSummary(usage({}), currentModelEstimate)).toBeUndefined();
	});

	it("uses persisted aggregate facts without a model or miss premium", () => {
		const summary = computeCacheMissCostSummary(
			usageWithoutPersistedCosts({ input: 100, cacheRead: 20_000 }),
			persistedAggregate({ input: 0.25, cacheRead: 0.02, output: 0, cacheWrite: 0, total: 0.27 }),
		);

		expect(summary?.inputCostUsd).toBe(0.25);
		expect(summary?.cacheReadCostUsd).toBe(0.02);
		expect(summary?.missPremiumUsd).toBeUndefined();
	});

	it("retains persisted direct costs and estimates only structurally absent buckets", () => {
		const factual = computeCacheMissCostSummary(
			usage({
				input: 100,
				cacheRead: 20_000,
				cost: { input: 0.25, cacheRead: 0.02, output: 0, cacheWrite: 0, total: 0.27 },
			}),
			currentModelEstimate,
		);
		const estimated = computeCacheMissCostSummary(
			usageWithoutPersistedCosts({ input: 20_000 }),
			currentModelEstimate,
		);

		expect(factual?.inputCostUsd).toBe(0.25);
		expect(factual?.cacheReadCostUsd).toBe(0.02);
		expect(factual?.missPremiumUsd).toBeCloseTo(0.00027);
		expect(estimated?.inputCostUsd).toBeCloseTo(0.06);
	});

	it("treats explicit zero persisted cost as factual instead of repricing it", () => {
		const persistedZeroUsage = usage({ input: 20_000 });
		const summary = computeCacheMissCostSummary(persistedZeroUsage, currentModelEstimate);
		const warning = buildCacheEconomicsWarning(persistedZeroUsage, modelWithCost(priced), { warningsEmitted: 0 });

		expect(summary).toBeUndefined();
		expect(warning).toBeUndefined();
	});

	it("suppresses malformed persisted costs instead of falling back to pricing", () => {
		const summary = computeCacheMissCostSummary(
			usageWithoutPersistedCosts({ input: 20_000, cost: { input: Number.NaN } }),
			currentModelEstimate,
		);
		const aggregate = computeCacheMissCostSummary(
			usageWithoutPersistedCosts({ input: 20_000 }),
			persistedAggregate({ input: 0.06, cacheRead: 0, output: 0, cacheWrite: 0, total: -0.06 }),
		);

		expect(summary).toBeUndefined();
		expect(aggregate).toBeUndefined();
	});

	it("fails closed when any persisted aggregate cost bucket is missing or non-finite", () => {
		const completeAggregate = { input: 0.25, output: 0.15, cacheRead: 0.02, cacheWrite: 0.08, total: 0.5 };
		const buckets = ["input", "output", "cacheRead", "cacheWrite", "total"] as const;

		const accepted = computeCacheMissCostSummary(
			usageWithoutPersistedCosts({ input: 20_000 }),
			persistedAggregate(completeAggregate),
		);
		expect(accepted).toMatchObject({
			inputCostUsd: 0.25,
			cacheReadCostUsd: 0.02,
			cacheWriteCostUsd: 0.08,
		});

		for (const bucket of buckets) {
			const missing = { ...completeAggregate } as Partial<Usage["cost"]>;
			delete missing[bucket];
			const infinite = { ...completeAggregate, [bucket]: Number.POSITIVE_INFINITY };
			const negative = { ...completeAggregate, [bucket]: -0.01 };

			expect(
				computeCacheMissCostSummary(
					usageWithoutPersistedCosts({ input: 20_000 }),
					persistedAggregate(missing as Usage["cost"]),
				),
				`missing persisted aggregate ${bucket} cost`,
			).toBeUndefined();
			expect(
				computeCacheMissCostSummary(usageWithoutPersistedCosts({ input: 20_000 }), persistedAggregate(infinite)),
				`non-finite persisted aggregate ${bucket} cost`,
			).toBeUndefined();
			expect(
				computeCacheMissCostSummary(usageWithoutPersistedCosts({ input: 20_000 }), persistedAggregate(negative)),
				`negative persisted aggregate ${bucket} cost`,
			).toBeUndefined();
		}
	});

	it("computes miss premium only when input and cache-read prices are both positive", () => {
		const noCacheReadPrice = computeCacheMissCostSummary(usageWithoutPersistedCosts({ input: 20_000 }), {
			kind: "current-model-estimate",
			pricing: { input: 3, cacheRead: 0, cacheWrite: 0 },
		});
		const withBothPrices = computeCacheMissCostSummary(
			usageWithoutPersistedCosts({ input: 20_000 }),
			currentModelEstimate,
		);

		expect(noCacheReadPrice?.missPremiumUsd).toBeUndefined();
		expect(withBothPrices?.missPremiumUsd).toBeCloseTo(0.054);
	});

	it("allows cache-write-only pricing to report write cost without miss premium", () => {
		const summary = computeCacheMissCostSummary(usageWithoutPersistedCosts({ cacheWrite: 20_000 }), {
			kind: "current-model-estimate",
			pricing: { input: 0, cacheRead: 0, cacheWrite: 3.75 },
		});

		expect(summary?.cacheWriteCostUsd).toBeCloseTo(0.075);
		expect(summary?.missPremiumUsd).toBeUndefined();
	});

	it("includes cache-write re-write premium in the miss premium", () => {
		const summary = computeCacheMissCostSummary(usageWithoutPersistedCosts({ input: 20_000, cacheWrite: 10_000 }), {
			kind: "current-model-estimate",
			pricing: { input: 3, cacheRead: 0.3, cacheWrite: 3.75 },
		});

		expect(summary?.missPremiumUsd).toBeCloseTo(0.0885);
	});

	it("uses token-only warning gates for all-zero-priced models", () => {
		const warning = buildCacheBehaviorWarning(
			noPersistedCost({ input: 20_000 }),
			modelWithCost({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }),
		);

		expect(warning?.code).toBe("provider_side_cache_miss");
	});

	it("prioritizes miss premium warnings and caps transcript warnings", () => {
		const state = { warningsEmitted: 0 };
		const warningUsage = {
			...usage({ input: 20_000, cacheRead: 1_000, cacheWrite: 20_000 }),
			cost: {} as Usage["cost"],
		};
		const model = modelWithCost(priced);
		const warnings = [
			buildCacheEconomicsWarning(warningUsage, model, state),
			buildCacheEconomicsWarning(warningUsage, model, state),
			buildCacheEconomicsWarning(warningUsage, model, state),
			buildCacheEconomicsWarning(warningUsage, model, state),
		];

		expect(
			warnings.slice(0, 3).every(text => text?.includes("large uncached input") && text.includes("next step:")),
		).toBe(true);
		expect(warnings[3]).toBeUndefined();
		expect(state.warningsEmitted).toBe(3);
	});
});

const noPersistedCost = (overrides: Partial<Usage>): Usage => ({
	...usage(overrides),
	cost: {} as Usage["cost"],
});

describe("cache-miss attribution (#2020)", () => {
	const model = modelWithCost(priced);

	it("marks a large costly miss with zero cache activity as provider-side suspected, not user-actionable", () => {
		const warning = buildCacheBehaviorWarning(noPersistedCost({ input: 20_000 }), model);

		expect(warning?.code).toBe("provider_side_cache_miss");
		expect(warning?.attribution).toBe("provider-side-suspected");
		expect(warning?.nextStep).toBeUndefined();
		expect(warning?.unknown).toBeDefined();

		const line = formatCacheWarningLine(warning as NonNullable<typeof warning>);
		expect(line).toContain("provider-side suspected / not user-actionable");
		expect(line).not.toContain("keep the stable prefix");
		expect(line).not.toContain("next step:");
	});

	it("reports partial reuse without writes as diagnostic-only and asserts no single cause", () => {
		const warning = buildCacheBehaviorWarning(noPersistedCost({ input: 20_000, cacheRead: 1_000 }), model);

		expect(warning?.code).toBe("expensive_cache_miss");
		expect(warning?.attribution).toBe("diagnostic-only");
		expect(warning?.nextStep).toBeUndefined();

		const line = formatCacheWarningLine(warning as NonNullable<typeof warning>);
		expect(line).toContain("Cache notice:");
		expect(line).toContain("partial cache reuse");
		expect(line).not.toContain("next step:");
		expect(line).not.toContain("provider-side suspected");
	});

	it("keeps the actionable prefix remediation when writes land but reuse is low", () => {
		const warning = buildCacheBehaviorWarning(
			noPersistedCost({ input: 20_000, cacheRead: 1_000, cacheWrite: 5_000 }),
			model,
		);

		expect(warning?.code).toBe("expensive_cache_miss");
		expect(warning?.attribution).toBe("actionable");
		expect(warning?.nextStep).toContain("keep the stable prefix");

		const line = formatCacheWarningLine(warning as NonNullable<typeof warning>);
		expect(line).toContain("Cache warning:");
		expect(line).toContain("next step: keep the stable prefix");
	});

	it("does not claim a cache-write spike when reads cover the writes", () => {
		const healthy = buildCacheBehaviorWarning(noPersistedCost({ cacheWrite: 30_000, cacheRead: 100_000 }), model);
		expect(healthy).toBeUndefined();
	});

	it("flags a cache-write spike only when reads fail to cover the writes", () => {
		const spike = buildCacheBehaviorWarning(noPersistedCost({ cacheWrite: 30_000, cacheRead: 0 }), model);

		expect(spike?.code).toBe("cache_write_spike");
		expect(spike?.attribution).toBe("actionable");
		expect(spike?.nextStep).toContain("reuse the same context");
	});
});
