import { describe, expect, it } from "bun:test";
import {
	MODEL_SWITCH_FAIL,
	MODEL_SWITCH_RESET,
	PREFIX_MUTATION_FAIL,
	PREFIX_STABLE,
	TOKEN_LOG_HIGH_CACHE,
	TOKEN_LOG_LOW_CACHE,
} from "../src/fixtures";
import { computeTokenMetrics } from "../src/metrics";
import { checkPrefixStability, hashPrefix, type PrefixTurn } from "../src/prefix-stability";

describe("hashPrefix", () => {
	it("is stable for identical input", () => {
		expect(hashPrefix("SYSTEM+TOOLS")).toBe(hashPrefix("SYSTEM+TOOLS"));
	});

	it("differs for different input", () => {
		expect(hashPrefix("SYSTEM+TOOLS")).not.toBe(hashPrefix("SYSTEM+TOOLS+EXTRA"));
	});
});

const APPEND_ONLY_PREFIX = JSON.stringify({
	systemPrompt: ["You are GJC.", "Use tools deterministically."],
	tools: [
		{
			name: "read",
			description: "Read a file",
			parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
		},
	],
});

const appendOnlyStableFixture: readonly PrefixTurn[] = [
	{ turn: 1, prefix: APPEND_ONLY_PREFIX, model: "model-a", cacheKey: "session-cache-key" },
	{ turn: 2, prefix: APPEND_ONLY_PREFIX, model: "model-a", cacheKey: "session-cache-key" },
	{ turn: 3, prefix: APPEND_ONLY_PREFIX, model: "model-a", cacheKey: "session-cache-key" },
];

describe("checkPrefixStability", () => {
	it("passes a stable single epoch", () => {
		const result = checkPrefixStability(PREFIX_STABLE);
		expect(result.stable).toBe(true);
		expect(result.epochs).toBe(1);
		expect(result.violations).toHaveLength(0);
	});

	it("flags a mid-epoch prefix mutation", () => {
		const result = checkPrefixStability(PREFIX_MUTATION_FAIL);
		expect(result.stable).toBe(false);
		expect(result.violations).toHaveLength(1);
		expect(result.violations[0]?.kind).toBe("prefix-mutation");
		expect(result.violations[0]?.turn).toBe(2);
	});

	it("flags a mid-epoch model switch without a reset marker", () => {
		const result = checkPrefixStability(MODEL_SWITCH_FAIL);
		expect(result.stable).toBe(false);
		expect(result.violations.some(v => v.kind === "model-switch")).toBe(true);
	});

	it("allows a model switch that carries a deliberate reset marker", () => {
		const result = checkPrefixStability(MODEL_SWITCH_RESET);
		expect(result.stable).toBe(true);
		expect(result.epochs).toBe(2);
		expect(result.violations).toHaveLength(0);
	});

	it("treats an empty sequence as stable with zero epochs", () => {
		expect(checkPrefixStability([])).toEqual({ stable: true, epochs: 0, violations: [] });
	});

	it("flags a cache-key change within an epoch", () => {
		const result = checkPrefixStability([
			{ turn: 1, prefix: "P", model: "m", cacheKey: "k1" },
			{ turn: 2, prefix: "P", model: "m", cacheKey: "k2" },
		]);
		expect(result.stable).toBe(false);
		expect(result.violations[0]?.kind).toBe("cache-key-change");
	});

	it("append-only-stable: repeated turns preserve prefix hash", () => {
		const hashes = appendOnlyStableFixture.map(turn => hashPrefix(turn.prefix));
		const result = checkPrefixStability(appendOnlyStableFixture);

		expect(new Set(hashes).size).toBe(1);
		expect(result.stable).toBe(true);
		expect(result.epochs).toBe(1);
		expect(result.violations).toHaveLength(0);
	});

	it("mid-session-mutation.fail: injected prefix mutation reports prefix-mutation", () => {
		const result = checkPrefixStability([
			...appendOnlyStableFixture.slice(0, 1),
			{ turn: 2, prefix: `${APPEND_ONLY_PREFIX}\nMUTATED`, model: "model-a", cacheKey: "session-cache-key" },
		]);

		expect(result.stable).toBe(false);
		expect(result.epochs).toBe(1);
		expect(result.violations).toEqual([expect.objectContaining({ turn: 2, epoch: 1, kind: "prefix-mutation" })]);
	});

	it("model-switch.fail: model switch without reset marker reports model-switch", () => {
		const result = checkPrefixStability([
			{ turn: 1, prefix: APPEND_ONLY_PREFIX, model: "model-a", cacheKey: "session-cache-key" },
			{ turn: 2, prefix: APPEND_ONLY_PREFIX, model: "model-b", cacheKey: "session-cache-key" },
		]);

		expect(result.stable).toBe(false);
		expect(result.violations).toEqual([expect.objectContaining({ turn: 2, epoch: 1, kind: "model-switch" })]);
	});

	it("compaction-reset.allowed: declared reset marker creates a new epoch", () => {
		const compactedPrefix = JSON.stringify({ summary: "prior conversation compacted", prefix: APPEND_ONLY_PREFIX });
		const result = checkPrefixStability([
			{ turn: 1, prefix: APPEND_ONLY_PREFIX, model: "model-a", cacheKey: "session-cache-key" },
			{
				turn: 2,
				prefix: compactedPrefix,
				model: "model-a",
				cacheKey: "session-cache-key-after-compaction",
				resetMarker: {
					reason: "compaction",
					priorPrefixHash: hashPrefix(APPEND_ONLY_PREFIX),
					newPrefixHash: hashPrefix(compactedPrefix),
				},
			},
			{ turn: 3, prefix: compactedPrefix, model: "model-a", cacheKey: "session-cache-key-after-compaction" },
		]);

		expect(result.stable).toBe(true);
		expect(result.epochs).toBe(2);
		expect(result.violations).toHaveLength(0);
	});

	it("model-switch-reset.allowed: model switch passes with a declared reset marker", () => {
		const result = checkPrefixStability([
			{ turn: 1, prefix: APPEND_ONLY_PREFIX, model: "model-a", cacheKey: "session-cache-key-a" },
			{
				turn: 2,
				prefix: APPEND_ONLY_PREFIX,
				model: "model-b",
				cacheKey: "session-cache-key-b",
				resetMarker: { reason: "deliberate-reset", priorPrefixHash: hashPrefix(APPEND_ONLY_PREFIX) },
			},
		]);

		expect(result.stable).toBe(true);
		expect(result.epochs).toBe(2);
		expect(result.violations).toHaveLength(0);
	});

	it("cache-hit-primary: cache hit rate and stable prefix are primary signals", () => {
		const highCache = computeTokenMetrics(TOKEN_LOG_HIGH_CACHE);
		const lowCache = computeTokenMetrics(TOKEN_LOG_LOW_CACHE);
		const stablePrefix = checkPrefixStability(appendOnlyStableFixture);

		expect(stablePrefix.stable).toBe(true);
		expect(highCache.cacheHitRate).toBeGreaterThan(lowCache.cacheHitRate);
		expect(highCache.cacheHitRate).toBeCloseTo(2050 / 3150, 10);
		expect(highCache.totalTokens).toBeGreaterThan(lowCache.totalTokens);
	});
});
