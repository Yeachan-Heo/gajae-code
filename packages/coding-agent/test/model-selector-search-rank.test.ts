import { expect, test } from "bun:test";
import { fuzzyMatch } from "@gajae-code/tui";

/**
 * Tests for model selector search ranking fix:
 * When a query is typed, models should be ordered by match quality (fuzzy score),
 * not by default-role rank, MRU, provider tier, or version.
 * Substring matches should rank above scattered subsequence matches regardless of MRU.
 */

test("fuzzyMatch: contiguous substring has lower score than scattered subsequence", () => {
	// "argon" as contiguous substring
	const contiguousMatch = fuzzyMatch("argon", "argon");
	// "argon" as scattered letters (a-r-g-o-n scattered throughout)
	const scatteredMatch = fuzzyMatch("argon", "anthropic-gpt-argon");

	// Lower score is better
	expect(contiguousMatch.matches).toBe(true);
	expect(scatteredMatch.matches).toBe(true);
	expect(contiguousMatch.score).toBeLessThan(scatteredMatch.score);
});

test("fuzzyMatch: word-boundary matches score better", () => {
	// "argon" at word boundary
	const boundaryMatch = fuzzyMatch("argon", "argon-mini");
	// "argon" scattered
	const scatteredMatch = fuzzyMatch("argon", "a-r-g-o-n-mini");

	expect(boundaryMatch.matches).toBe(true);
	expect(scatteredMatch.matches).toBe(true);
	expect(boundaryMatch.score).toBeLessThan(scatteredMatch.score);
});

test("fuzzyMatch: consecutive character matches reward bonus", () => {
	// Full consecutive sequence
	const consecutive = fuzzyMatch("test", "test");
	// Same letters but not consecutive
	const scattered = fuzzyMatch("test", "t-e-s-t");

	expect(consecutive.matches).toBe(true);
	expect(scattered.matches).toBe(true);
	expect(consecutive.score).toBeLessThan(scattered.score);
});

test("fuzzyMatch: gap penalty applies to non-consecutive matches", () => {
	// "abc" with small gap
	const smallGap = fuzzyMatch("abc", "a-b-c");
	// "abc" with large gap
	const largeGap = fuzzyMatch("abc", "a----b----c");

	expect(smallGap.matches).toBe(true);
	expect(largeGap.matches).toBe(true);
	expect(smallGap.score).toBeLessThan(largeGap.score);
});

test("fuzzyMatch: partial match followed by contiguous match ranks high", () => {
	// "gpt4" as scattered letters first
	const scattered = fuzzyMatch("gpt4", "great-powerful-transformer-4");
	// "gpt4" with contiguous substring
	const contiguous = fuzzyMatch("gpt4", "gpt-4");

	expect(scattered.matches).toBe(true);
	expect(contiguous.matches).toBe(true);
	expect(contiguous.score).toBeLessThan(scattered.score);
});

import { ThinkingLevel } from "@gajae-code/agent-core";
import type { Model } from "@gajae-code/ai";
import { fuzzyFilter } from "@gajae-code/tui";
import {
	assignFuzzyScoresToCanonicalModels,
	assignFuzzyScoresToModels,
	compareCanonicalModelItemsForRanking,
	compareModelItemsForRanking,
} from "../src/modes/components/model-selector";

interface TestModel extends Model {
	priority?: number;
}

function testModel(provider: string, id: string): TestModel {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider,
		baseUrl: "https://example.invalid/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 100_000,
		maxTokens: 8_000,
	};
}

function modelItem(provider: string, id: string) {
	return {
		kind: "provider" as const,
		provider,
		id,
		model: testModel(provider, id),
		selector: `${provider}/${id}`,
		fuzzyScore: undefined as number | undefined,
	};
}

function canonicalItem(provider: string, id: string) {
	const searchText = `${id} ${provider}`;
	return {
		kind: "canonical" as const,
		id,
		model: testModel(provider, id),
		selector: `${provider}/${id}`,
		variantCount: 1,
		searchText,
		normalizedSearchText: searchText,
		compactSearchText: searchText,
		fuzzyScore: undefined as number | undefined,
	};
}

function rolesWithDefault(model: Model) {
	return { default: { model, thinkingLevel: ThinkingLevel.Off } };
}

function context(
	mru: readonly string[] = [],
	providerAuth: ReadonlyMap<string, "oauth" | "api_key" | "none"> = new Map(),
) {
	return {
		roles: {} as Record<string, { model: Model; thinkingLevel: ThinkingLevel } | undefined>,
		mruIndex: new Map(mru.map((key, index) => [key, index])),
		providerAuthStateById: providerAuth as ReadonlyMap<string, never>,
	};
}

test("multi-token scores follow fuzzyFilter token semantics and overwrite stale scores", () => {
	const items = [modelItem("demo", "xyabcd"), modelItem("demo", "abcxy")];
	assignFuzzyScoresToModels(items, "demo");
	expect(items.every(item => item.fuzzyScore !== undefined)).toBe(true);

	assignFuzzyScoresToModels(items, "demo xy");
	const [xyFirst, xyLast] = items;
	expect(xyFirst.fuzzyScore).toBeDefined();
	expect(xyLast.fuzzyScore).toBeDefined();
	// The previous query's scores must not survive the raw-query miss: the ranking
	// now agrees with fuzzyFilter's token aggregate, not a stale full-query score.
	const filtered = fuzzyFilter(items, "demo xy", item => `${item.id} ${item.provider}`);
	expect(filtered).toHaveLength(2);
	const best = filtered[0]!;
	expect(Math.min(xyFirst.fuzzyScore!, xyLast.fuzzyScore!)).toBe(best.fuzzyScore!);
	expect(xyFirst.fuzzyScore).not.toBe(xyLast.fuzzyScore);

	assignFuzzyScoresToModels(items, "zzz");
	expect(items.map(item => item.fuzzyScore)).toEqual([undefined, undefined]);
});

test("selector ranking agrees with tokenized fuzzy match quality", () => {
	let seed = 0x51ce;
	const next = () => {
		seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
		return seed / 4_294_967_296;
	};
	const alphabet = "abcde -123";
	const word = () =>
		Array.from({ length: 3 + Math.floor(next() * 6) }, () => alphabet[Math.floor(next() * alphabet.length)]).join("");
	for (let sample = 0; sample < 200; sample += 1) {
		const items = Array.from({ length: 2 + Math.floor(next() * 6) }, (_, index) =>
			modelItem("demo", `${word()}-${index}`),
		);
		const query = `${word()} ${word()}`.trim();
		assignFuzzyScoresToModels(items, query);
		const filtered = fuzzyFilter(items, query, item => `${item.id} ${item.provider}`);
		for (const item of items) {
			const accepted = filtered.includes(item);
			expect(item.fuzzyScore !== undefined, `${query} ${item.id}`).toBe(accepted);
		}
		// Ranking by the assigned score must be monotonic in fuzzyFilter's order.
		const scoresInFilterOrder = filtered.map(item => item.fuzzyScore ?? Number.MAX_SAFE_INTEGER);
		for (let index = 1; index < scoresInFilterOrder.length; index += 1) {
			expect(scoresInFilterOrder[index]!).toBeGreaterThanOrEqual(scoresInFilterOrder[index - 1]!);
		}
	}
});

test("equal fuzzy scores keep default-model precedence over MRU", () => {
	const recent = modelItem("anthropic", "claude-haiku-5-5");
	const configuredDefault = modelItem("anthropic", "claude-sonnet-5-5");
	assignFuzzyScoresToModels([recent, configuredDefault], "claude");
	expect(recent.fuzzyScore).toBe(configuredDefault.fuzzyScore);
	const base = context(["anthropic/claude-haiku-5-5"]);
	const ranking = {
		...base,
		roles: rolesWithDefault(configuredDefault.model),
	};
	expect(compareModelItemsForRanking(recent, configuredDefault, ranking)).toBeGreaterThan(0);
	expect(compareModelItemsForRanking(configuredDefault, recent, ranking)).toBeLessThan(0);
});

test("canonical equal fuzzy scores keep default-model precedence over MRU", () => {
	const recent = canonicalItem("anthropic", "claude-haiku-5-5");
	const configuredDefault = canonicalItem("anthropic", "claude-sonnet-5-5");
	assignFuzzyScoresToCanonicalModels([recent, configuredDefault], "claude");
	expect(recent.fuzzyScore).toBe(configuredDefault.fuzzyScore);
	const ranking = {
		...context(["anthropic/claude-haiku-5-5"]),
		roles: rolesWithDefault(configuredDefault.model),
	};
	expect(compareCanonicalModelItemsForRanking(recent, configuredDefault, ranking)).toBeGreaterThan(0);
});
