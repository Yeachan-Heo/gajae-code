import { describe, expect, it } from "bun:test";
import { TOKEN_LOG_HIGH_CACHE, TOKEN_LOG_LOW_CACHE } from "../src/fixtures";
import {
	assertTokenLogShape,
	cacheHitRate,
	computeTokenMetrics,
	forkClonedTokens,
	receiptArtifactRatio,
	type TokenLogEntry,
} from "../src/metrics";

describe("cacheHitRate", () => {
	it("returns 0 with no input-class traffic (no NaN)", () => {
		expect(cacheHitRate(0, 0)).toBe(0);
	});

	it("computes cached fraction of input-class tokens", () => {
		expect(cacheHitRate(50, 150)).toBeCloseTo(0.75, 10);
	});

	it("is 1 when all input is served from cache", () => {
		expect(cacheHitRate(0, 1000)).toBe(1);
	});
});

describe("computeTokenMetrics", () => {
	it("aggregates an empty set to zeros", () => {
		expect(computeTokenMetrics([])).toEqual({
			turns: 0,
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			totalTokens: 0,
			cacheHitRate: 0,
		});
	});

	it("aggregates the high-cache fixture deterministically", () => {
		const m = computeTokenMetrics(TOKEN_LOG_HIGH_CACHE);
		expect(m.turns).toBe(3);
		expect(m.inputTokens).toBe(1100);
		expect(m.cacheReadTokens).toBe(2050);
		expect(m.cacheHitRate).toBeCloseTo(2050 / 3150, 10);
	});

	it("shows the high-cache fixture beats the low-cache fixture on hit rate", () => {
		const high = computeTokenMetrics(TOKEN_LOG_HIGH_CACHE);
		const low = computeTokenMetrics(TOKEN_LOG_LOW_CACHE);
		expect(high.cacheHitRate).toBeGreaterThan(low.cacheHitRate);
		expect(low.cacheHitRate).toBe(0);
	});

	it("is pure: repeated calls return equal results", () => {
		expect(computeTokenMetrics(TOKEN_LOG_HIGH_CACHE)).toEqual(computeTokenMetrics(TOKEN_LOG_HIGH_CACHE));
	});
});

describe("receiptArtifactRatio", () => {
	it("returns 0 for an empty artifact", () => {
		expect(receiptArtifactRatio(100, 0)).toBe(0);
	});

	it("is small when the receipt is much smaller than the artifact", () => {
		expect(receiptArtifactRatio(200, 100_000)).toBeCloseTo(0.002, 10);
	});
});

describe("forkClonedTokens", () => {
	it("never returns negative", () => {
		expect(forkClonedTokens(100, 250)).toBe(0);
	});

	it("returns the bounded difference", () => {
		expect(forkClonedTokens(1000, 200)).toBe(800);
	});
});

describe("assertTokenLogShape", () => {
	it("accepts the fixtures", () => {
		for (const log of [...TOKEN_LOG_HIGH_CACHE, ...TOKEN_LOG_LOW_CACHE]) {
			expect(() => assertTokenLogShape(log)).not.toThrow();
		}
	});

	it("rejects a non-object", () => {
		expect(() => assertTokenLogShape(null)).toThrow();
		expect(() => assertTokenLogShape(42)).toThrow();
	});

	it("rejects a missing subagentId", () => {
		const bad = { turn: 1, at: "x", input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
		expect(() => assertTokenLogShape(bad)).toThrow();
	});

	it("rejects a negative numeric field", () => {
		const bad: TokenLogEntry = {
			subagentId: "root",
			turn: 1,
			at: "2026-01-01T00:00:00.000Z",
			input: -1,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
		};
		expect(() => assertTokenLogShape(bad)).toThrow();
	});
});
