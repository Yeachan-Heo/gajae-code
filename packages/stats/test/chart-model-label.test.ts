import { describe, expect, it } from "bun:test";
import { buildTopNByModelSeries } from "../src/client/components/chart-shared.tsx";

const costOptions = {
	rankWeight: (point: { cost: number }) => point.cost,
	initBucket: () => ({ total: 0 }),
	accumulate: (bucket: { total: number }, point: { cost: number }) => {
		bucket.total += point.cost;
	},
	bucketToValue: (bucket: { total: number }) => bucket.total,
};

describe("buildTopNByModelSeries model labels", () => {
	it("sums an ordinary model on one day", () => {
		const series = buildTopNByModelSeries(
			[
				{ timestamp: 1_700_000_000_000, model: "gpt", provider: "openai", cost: 1 },
				{ timestamp: 1_700_000_000_000, model: "gpt", provider: "openai", cost: 2 },
			],
			costOptions,
		);
		expect(series.datasets.find(dataset => dataset.label === "gpt")?.data).toEqual([3]);
		expect(Object.hasOwn(Object.prototype, "total")).toBe(false);
	});

	it("does not treat __proto__ as an inherited chart bucket", () => {
		expect(Object.hasOwn(Object.prototype, "total")).toBe(false);
		const series = buildTopNByModelSeries(
			[{ timestamp: 1_700_000_000_000, model: "__proto__", provider: "openai", cost: 4 }],
			costOptions,
		);
		expect(Object.hasOwn(Object.prototype, "total")).toBe(false);
		expect(series.datasets.find(dataset => dataset.label === "__proto__")?.data).toEqual([4]);
		expect(Object.hasOwn(Object.prototype, "total")).toBe(false);
	});
});
