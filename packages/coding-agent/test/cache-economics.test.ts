import { describe, expect, it } from "bun:test";
import type { Model, Usage } from "@gajae-code/ai";
import {
	buildCacheEconomicsWarning,
	computeCacheMissCostSummary,
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

describe("cache economics", () => {
	it("omits zero or absent usage", () => {
		expect(computeCacheMissCostSummary(undefined, priced)).toBeUndefined();
		expect(computeCacheMissCostSummary(usage({}), priced)).toBeUndefined();
	});

	it("uses usage.cost buckets as factual costs in material summaries", () => {
		const summary = computeCacheMissCostSummary(
			usage({
				input: 100,
				cacheRead: 20_000,
				cost: { input: 0.25, cacheRead: 0.02, output: 0, cacheWrite: 0, total: 0.27 },
			}),
			priced,
		);

		expect(summary?.inputCostUsd).toBe(0.25);
		expect(summary?.cacheReadCostUsd).toBe(0.02);
		expect(summary?.missPremiumUsd).toBeCloseTo(0.00027);
	});

	it("computes miss premium only when input and cache-read prices are both positive", () => {
		const noCacheReadPrice = computeCacheMissCostSummary(usage({ input: 20_000 }), {
			input: 3,
			cacheRead: 0,
			cacheWrite: 0,
		});
		const withBothPrices = computeCacheMissCostSummary(usage({ input: 20_000 }), priced);

		expect(noCacheReadPrice?.missPremiumUsd).toBeUndefined();
		expect(withBothPrices?.missPremiumUsd).toBeCloseTo(0.054);
	});

	it("allows cache-write-only pricing to report write cost without miss premium", () => {
		const summary = computeCacheMissCostSummary(usage({ cacheWrite: 20_000 }), {
			input: 0,
			cacheRead: 0,
			cacheWrite: 3.75,
		});

		expect(summary?.cacheWriteCostUsd).toBeCloseTo(0.075);
		expect(summary?.missPremiumUsd).toBeUndefined();
	});

	it("prioritizes miss premium warnings and caps transcript warnings", () => {
		const state = { warningsEmitted: 0 };
		const warningUsage = usage({ input: 20_000, cacheRead: 1_000, cacheWrite: 20_000 });
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
