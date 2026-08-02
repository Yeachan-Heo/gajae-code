import { describe, expect, it } from "bun:test";
import type { Model } from "@gajae-code/ai";
import { AUTOROUTING_SELECTOR_PATTERN, type AutoroutingTier } from "../src/config/autorouting-contract";
import {
	CURATED_TIER_LABELS,
	CURATED_TIER_MAP,
	type CuratedTierLabels,
	computeMapFingerprint,
	TIER_MAP_SKIP_LIST,
	type TierMapKey,
	validateTierMap,
} from "../src/config/autorouting-tier-map";

function model(provider: string, id: string, reasoning = true): Model {
	return {
		provider,
		id,
		name: id,
		api: "openai-completions",
		baseUrl: "https://example.invalid",
		reasoning,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 4096,
	};
}

function mapWith(labels: CuratedTierLabels, skips: Record<string, { rationale: string }> = {}) {
	return { labels, skips, version: 1 };
}

describe("autorouting tier map", () => {
	it("keeps every curated key provider-qualified and effort values within the selector union", () => {
		const pattern = new RegExp(AUTOROUTING_SELECTOR_PATTERN);
		const efforts = new Set(["minimal", "low", "medium", "high", "xhigh"]);
		for (const [key, assignments] of Object.entries(CURATED_TIER_LABELS)) {
			expect(pattern.test(key)).toBe(true);
			for (const assignment of assignments) {
				if ("effort" in assignment && assignment.effort !== undefined)
					expect(efforts.has(assignment.effort)).toBe(true);
			}
		}
		const typedKey: TierMapKey = "example/provider-model";
		expect(typedKey).toContain("/");
	});

	it("accepts multi-assignment with one assignment per tier and effort variants", () => {
		const labels = {
			"example/model": [
				{ tier: "fast" as AutoroutingTier, effort: "low" as const, rank: 1 },
				{ tier: "balanced" as AutoroutingTier, effort: "medium" as const, rank: 1 },
				{ tier: "strong" as AutoroutingTier, effort: "high" as const, rank: 1 },
			],
		} satisfies CuratedTierLabels;
		expect(() => validateTierMap(mapWith(labels), [model("example", "model")])).not.toThrow();
	});

	it("rejects duplicate tier assignments and cross-model provider/tier rank collisions", () => {
		const duplicate = {
			"example/model": [
				{ tier: "fast" as const, rank: 1 },
				{ tier: "fast" as const, effort: "low" as const, rank: 2 },
			],
		} satisfies CuratedTierLabels;
		expect(() => validateTierMap(mapWith(duplicate), [model("example", "model")])).toThrow("at most one assignment");

		const collision = {
			"example/one": [{ tier: "fast" as const, rank: 1 }],
			"example/two": [{ tier: "fast" as const, rank: 1 }],
		} satisfies CuratedTierLabels;
		expect(() => validateTierMap(mapWith(collision), [model("example", "one"), model("example", "two")])).toThrow(
			"collides",
		);
	});

	it("rejects label/skip overlap and effort on non-reasoning models", () => {
		const labels = {
			"example/model": [{ tier: "fast" as const, effort: "low" as const, rank: 1 }],
		} satisfies CuratedTierLabels;
		expect(() =>
			validateTierMap(mapWith(labels, { "example/model": { rationale: "overlap" } }), [
				model("example", "model", false),
			]),
		).toThrow("Effort is only valid");
		expect(() =>
			validateTierMap(mapWith(labels, { "example/model": { rationale: "overlap" } }), [model("example", "model")]),
		).toThrow("both labeled and skipped");
	});

	it("moves the fingerprint when labels, skips, or version data changes", () => {
		const original = computeMapFingerprint(CURATED_TIER_MAP);
		const labels = {
			...CURATED_TIER_LABELS,
			"fingerprint/model": [{ tier: "fast" as const, rank: 1 }],
		} satisfies CuratedTierLabels;
		const changedLabels = computeMapFingerprint({ labels, skips: TIER_MAP_SKIP_LIST, version: 1 });
		expect(changedLabels).not.toBe(original);
		const changedSkips = computeMapFingerprint({
			labels: CURATED_TIER_LABELS,
			skips: { "fingerprint/model": { rationale: "test" } },
			version: 1,
		});
		expect(changedSkips).not.toBe(original);
		expect(computeMapFingerprint({ labels: CURATED_TIER_LABELS, skips: TIER_MAP_SKIP_LIST, version: 2 })).not.toBe(
			original,
		);
	});
});
