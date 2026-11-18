import { describe, expect, it } from "bun:test";
import { format } from "date-fns";
import { buildModelPreferenceSeries, buildTopNByModelSeries } from "../src/client/components/chart-shared";

const DAY = 86_400_000;

function point(model: string, provider: string, requests: number, timestamp = DAY) {
	return { timestamp, model, provider, requests };
}

describe("buildModelPreferenceSeries model labels", () => {
	it("shares ordinary models on one day", () => {
		const { data, series } = buildModelPreferenceSeries([
			point("gpt-5", "openai", 3),
			point("claude", "anthropic", 1),
		]);
		expect(series).toEqual(["gpt-5", "claude"]);
		expect(data).toEqual([{ timestamp: DAY, total: 4, shares: { "gpt-5": 75, claude: 25 } }]);
	});

	it("returns empty output for no points", () => {
		expect(buildModelPreferenceSeries([])).toEqual({ data: [], series: [] });
	});

	it("qualifies labels with the provider when two providers share a model", () => {
		const { data, series } = buildModelPreferenceSeries([point("gpt-5", "openai", 2), point("gpt-5", "copilot", 1)]);
		expect(series).toEqual(["gpt-5 (openai)", "gpt-5 (copilot)"]);
		expect(data[0].shares["gpt-5 (openai)"]).toBeCloseTo((2 / 3) * 100, 10);
		expect(data[0].shares["gpt-5 (copilot)"]).toBeCloseTo((1 / 3) * 100, 10);
	});

	it("does not treat constructor as an inherited chart bucket", () => {
		const { data, series } = buildModelPreferenceSeries([
			point("gpt-5", "openai", 3),
			point("constructor", "openai", 1),
		]);
		expect(series).toEqual(["gpt-5", "constructor"]);
		expect(data[0].shares.constructor).toBe(25);
		expect(Object.hasOwn(Object.prototype, "total")).toBe(false);
	});

	it("does not treat __proto__ as an inherited chart bucket", () => {
		expect(Object.hasOwn(Object.prototype, "total")).toBe(false);
		const { data, series } = buildModelPreferenceSeries([
			point("gpt-5", "openai", 3),
			point("__proto__", "openai", 1),
		]);
		expect(series).toEqual(["gpt-5", "__proto__"]);
		expect(Object.hasOwn(data[0].shares, "__proto__")).toBe(true);
		const protoEntry = Object.entries(data[0].shares).find(([key]) => key === "__proto__");
		expect(protoEntry?.[1]).toBe(25);
		expect(Object.hasOwn(Object.prototype, "total")).toBe(false);
	});

	it("keeps row bookkeeping when models are named total or timestamp", () => {
		const { data } = buildModelPreferenceSeries([
			point("gpt-5", "openai", 3),
			point("total", "openai", 1),
			point("timestamp", "openai", 1),
		]);
		expect(data[0].timestamp).toBe(DAY);
		expect(data[0].total).toBe(5);
		expect(data[0].shares["gpt-5"]).toBe(60);
		expect(data[0].shares.total).toBe(20);
		expect(data[0].shares.timestamp).toBe(20);
	});

	it("disambiguates the synthetic Other rollup from a model named Other", () => {
		const points = [point("Other", "openai", 50)];
		for (let i = 0; i < 7; i++) points.push(point(`m${i}`, "p", i + 1));
		const { data, series } = buildModelPreferenceSeries(points);
		expect(new Set(series).size).toBe(series.length);
		// The top-ranked model literally named "Other" keeps its own share; the
		// rollup of the remaining models must not be merged into it.
		expect(data[0].shares.Other).toBeCloseTo((50 / 78) * 100, 10);
	});

	it("keeps labels unique when a model is named like a provider-qualified label", () => {
		const points = [point("foo (bar)", "baz", 50), point("foo", "bar", 40), point("foo", "qux", 30)];
		const { data, series } = buildModelPreferenceSeries(points);
		// Provider-qualified labels keep their contract regardless of ranking: the
		// literal model is qualified with its own provider instead of taking over
		// "foo (bar)" or merging foo/bar's share into it.
		expect(new Set(series).size).toBe(series.length);
		expect(data[0].shares["foo (bar) (baz)"]).toBeCloseTo((50 / 120) * 100, 10);
		expect(data[0].shares["foo (bar)"]).toBeCloseTo((40 / 120) * 100, 10);
		expect(data[0].shares["foo (qux)"]).toBeCloseTo((30 / 120) * 100, 10);
	});

	it("does not merge distinct model/provider pairs whose names contain the key delimiter", () => {
		const points = [point("a::b", "c", 50), point("a", "b::c", 40)];
		const { data, series } = buildModelPreferenceSeries(points);
		// "a::b" from provider c and "a" from provider "b::c" are distinct models;
		// a delimiter-joined key would merge them into one series.
		expect(new Set(series).size).toBe(series.length);
		expect(series.length).toBe(2);
		expect(data[0].total).toBe(90);
		expect(Object.values(data[0].shares).reduce((sum, v) => sum + v, 0)).toBeCloseTo(100, 10);
		expect(Math.max(...Object.values(data[0].shares))).toBeCloseTo((50 / 90) * 100, 10);
	});

	it("keeps provider-qualified labels unique when names nest", () => {
		const points = [point("a (b", "c", 50), point("a (b", "d", 40), point("a", "b (c", 30), point("a", "e", 20)];
		const { data, series } = buildModelPreferenceSeries(points);
		// Without a uniqueness check, both ("a (b", c) and ("a", "b (c") would be
		// labeled "a (b (c)" and their shares would merge.
		expect(new Set(series).size).toBe(series.length);
		expect(Object.values(data[0].shares).reduce((sum, v) => sum + v, 0)).toBeCloseTo(100, 10);
	});
	it("keeps the rollup label unique when top models are named Other and Other models", () => {
		const points = [
			point("Other", "openai", 50),
			point("Other models", "openai", 40),
			point("a", "p", 5),
			point("b", "p", 4),
			point("c", "p", 3),
			point("d", "p", 2),
			point("e", "p", 1),
		];
		const { data, series } = buildModelPreferenceSeries(points);
		// Top 5: Other (50), Other models (40), a, b, c; d and e roll up. The
		// rollup must not reuse either taken label, or its share would merge
		// into a real model's series and Chart.js would get duplicate labels.
		expect(new Set(series).size).toBe(series.length);
		expect(series).toContain("Other models models");
		expect(data[0].shares.Other).toBeCloseTo((50 / 105) * 100, 10);
		expect(data[0].shares["Other models"]).toBeCloseTo((40 / 105) * 100, 10);
		expect(data[0].shares["Other models models"]).toBeCloseTo((3 / 105) * 100, 10);
	});

	it("rolls models past topN into the synthetic Other series", () => {
		const points = [];
		for (let i = 0; i < 7; i++) points.push(point(`m${i}`, "p", i + 1));
		const { data, series } = buildModelPreferenceSeries(points);
		expect(series).toEqual(["m6", "m5", "m4", "m3", "m2", "Other"]);
		expect(data[0].shares.Other).toBeCloseTo((3 / 28) * 100, 10);
	});
});

describe("buildTopNByModelSeries normal control", () => {
	it("ranks models, buckets by day, and rolls the rest into Other", () => {
		const DAY = 86_400_000;
		const points = [
			{ timestamp: DAY, model: "gpt-5", provider: "openai", cost: 3 },
			{ timestamp: DAY, model: "claude", provider: "anthropic", cost: 2 },
			{ timestamp: DAY, model: "gemini", provider: "google", cost: 1 },
			{ timestamp: 2 * DAY, model: "gpt-5", provider: "openai", cost: 1 },
		];
		const out = buildTopNByModelSeries(points, {
			topN: 2,
			rankWeight: p => p.cost,
			initBucket: () => ({ cost: 0 }),
			accumulate: (bucket, p) => {
				bucket.cost += p.cost;
			},
			bucketToValue: bucket => bucket.cost,
		});
		// Guards the production topN builder against accidental key/label changes:
		// if topKeys membership broke, every model would collapse into "Other".
		expect(out.labels).toEqual([format(new Date(DAY), "MMM d"), format(new Date(2 * DAY), "MMM d")]);
		expect(out.datasets.map(d => d.label)).toEqual(["gpt-5", "claude", "Other"]);
		expect(out.datasets[0].data).toEqual([3, 1]);
		expect(out.datasets[1].data).toEqual([2, 0]);
		expect(out.datasets[2].data).toEqual([1, 0]);
	});
});
