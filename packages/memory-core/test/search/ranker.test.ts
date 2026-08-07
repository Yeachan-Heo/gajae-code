import { describe, expect, it } from "bun:test";

import { RANK_SCORE_SCALE, type RankCandidate, type RankContext, rankCandidates } from "../../src/search/ranker";

const AS_OF = "2026-07-29T00:00:00.000Z";
const context: RankContext = { asOf: AS_OF };

function signalCandidate(uri: string, overrides: Partial<RankCandidate> = {}): RankCandidate {
	return {
		uri,
		componentScores: { stage: 1, metadata: 0, heading: 0, lexical: 0, fuzzy: 0 },
		authority: "user-confirmed",
		scope: "session",
		freshnessScore: 1,
		volatility: "stable",
		...overrides,
	};
}

describe("M2 ranker", () => {
	it("preserves stage, metadata, heading, lexical, and fuzzy factors in the weighted signal", () => {
		const result = rankCandidates(
			[
				{
					uri: "project://signals.md",
					componentScores: { stage: 1, metadata: 0.8, heading: 0.6, lexical: 0.4, fuzzy: 0.2 },
					authority: "user-confirmed",
					scope: "session",
					freshnessScore: 1,
					volatility: "stable",
				},
			],
			context,
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const ranked = result.value[0];
		expect(ranked).toBeDefined();
		if (ranked === undefined) return;
		expect(ranked.score).toBe(660_000);
		expect(ranked.factors.stage).toBe(1);
		expect(ranked.factors.metadata).toBe(0.8);
		expect(ranked.factors.heading).toBe(0.6);
		expect(ranked.factors.lexical).toBe(0.4);
		expect(ranked.factors.fuzzy).toBe(0.2);
		expect(ranked.factors.authority).toBe(1);
		expect(ranked.factors.scope).toBe(1);
		expect(ranked.factors.freshness).toBe(1);
		expect(ranked.factors.volatility).toBe(1);
		expect(ranked.factors.weightedSignal).toBeCloseTo(0.66, 12);
		expect(ranked.factors.contextMultiplier).toBe(1);
	});

	it("uses the strongest retrieval stage and honors deterministic stage-weight inputs", () => {
		const strongestCandidates: readonly RankCandidate[] = [
			signalCandidate("global://map.md", { componentScores: undefined, stages: ["fuzzy", "map-route"] }),
			signalCandidate("global://fuzzy.md", { componentScores: undefined, stage: "fuzzy" }),
		];
		const defaults = rankCandidates(strongestCandidates, context);
		expect(defaults.ok).toBe(true);
		if (!defaults.ok) return;
		expect(defaults.value.map(candidate => candidate.uri)).toEqual(["global://map.md", "global://fuzzy.md"]);
		expect(defaults.value[0]?.factors.stage).toBe(1);
		expect(defaults.value[1]?.factors.stage).toBe(0.55);

		const overridden = rankCandidates(
			[
				signalCandidate("global://map-only.md", { componentScores: undefined, stage: "map-route" }),
				signalCandidate("global://fuzzy.md", { componentScores: undefined, stage: "fuzzy" }),
			],
			{
				...context,
				stageWeights: { "map-route": 0.1, fuzzy: 0.9 },
			},
		);
		expect(overridden.ok).toBe(true);
		if (!overridden.ok) return;
		expect(overridden.value.map(candidate => candidate.uri)).toEqual(["global://fuzzy.md", "global://map-only.md"]);
		expect(overridden.value[0]?.factors.stage).toBe(0.9);
		expect(overridden.value[1]?.factors.stage).toBe(0.1);
	});

	it("orders candidates by authority, scope, and freshness inputs", () => {
		const authority = rankCandidates(
			[
				signalCandidate("global://unverified.md", { authority: "unverified" }),
				signalCandidate("global://confirmed.md", { authority: "user-confirmed" }),
				signalCandidate("global://reviewed.md", { authority: "repository-reviewed" }),
			],
			context,
		);
		expect(authority.ok).toBe(true);
		if (!authority.ok) return;
		expect(authority.value.map(candidate => candidate.uri)).toEqual([
			"global://confirmed.md",
			"global://reviewed.md",
			"global://unverified.md",
		]);

		const scopes = rankCandidates(
			[
				signalCandidate("global://global.md", { scope: "global" }),
				signalCandidate("global://project.md", { scope: "project" }),
				signalCandidate("global://session.md", { scope: "session" }),
			],
			context,
		);
		expect(scopes.ok).toBe(true);
		if (!scopes.ok) return;
		expect(scopes.value.map(candidate => candidate.uri)).toEqual([
			"global://session.md",
			"global://project.md",
			"global://global.md",
		]);

		const freshness = rankCandidates(
			[
				signalCandidate("global://old.md", {
					freshnessScore: undefined,
					updatedAt: "2026-05-30T00:00:00.000Z",
				}),
				signalCandidate("global://fresh.md", {
					freshnessScore: undefined,
					updatedAt: AS_OF,
				}),
			],
			{ ...context, freshnessHalfLifeDays: 30 },
		);
		expect(freshness.ok).toBe(true);
		if (!freshness.ok) return;
		expect(freshness.value.map(candidate => candidate.uri)).toEqual(["global://fresh.md", "global://old.md"]);
		expect(freshness.value[0]?.factors.freshness).toBe(1);
		expect(freshness.value[1]?.factors.freshness).toBeLessThan(1);
	});

	it("downranks volatility without changing the retrieval signal", () => {
		const result = rankCandidates(
			[
				signalCandidate("global://volatile.md", { volatility: "volatile" }),
				signalCandidate("global://historical.md", { volatility: "historical" }),
				signalCandidate("global://stable.md", { volatility: "stable" }),
			],
			context,
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.map(candidate => candidate.uri)).toEqual([
			"global://stable.md",
			"global://historical.md",
			"global://volatile.md",
		]);
		const stable = result.value.find(candidate => candidate.uri === "global://stable.md");
		const historical = result.value.find(candidate => candidate.uri === "global://historical.md");
		const volatile = result.value.find(candidate => candidate.uri === "global://volatile.md");
		expect(stable).toBeDefined();
		expect(historical).toBeDefined();
		expect(volatile).toBeDefined();
		if (stable === undefined || historical === undefined || volatile === undefined) return;
		expect(stable.factors.weightedSignal).toBe(historical.factors.weightedSignal);
		expect(stable.factors.weightedSignal).toBe(volatile.factors.weightedSignal);
		expect(stable.factors.volatility).toBe(1);
		expect(historical.factors.volatility).toBe(0.85);
		expect(volatile.factors.volatility).toBe(0.65);
		expect(stable.score).toBeGreaterThan(historical.score);
		expect(historical.score).toBeGreaterThan(volatile.score);
	});

	it("is repeatable, independent of input order, and ties by canonical UTF-8 URI", () => {
		const fixture: readonly RankCandidate[] = [
			signalCandidate("global://é.md", { componentScores: { stage: 0.5 } }),
			signalCandidate("global://z.md", { componentScores: { stage: 0.5 } }),
			signalCandidate("global://a.md", { componentScores: { stage: 0.5 } }),
		];
		const first = rankCandidates(fixture, context);
		const second = rankCandidates([...fixture].reverse(), context);
		expect(first).toEqual(second);
		expect(first.ok).toBe(true);
		if (!first.ok) return;
		expect(first.value.map(candidate => candidate.uri)).toEqual(["global://a.md", "global://z.md", "global://é.md"]);
		for (const candidate of first.value) {
			expect(Number.isFinite(candidate.score)).toBe(true);
			expect(Number.isInteger(candidate.score)).toBe(true);
			expect(candidate.score).toBeGreaterThanOrEqual(0);
			expect(candidate.score).toBeLessThanOrEqual(RANK_SCORE_SCALE);
		}
	});

	it("fails closed for non-finite scores, invalid timestamps, unsafe duplicates, and unknown stages", () => {
		const invalidCandidates: readonly RankCandidate[] = [
			signalCandidate("global://nan.md", { componentScores: { stage: Number.NaN } }),
			signalCandidate("global://infinity.md", { componentScores: { metadata: Number.POSITIVE_INFINITY } }),
			signalCandidate("global://negative.md", { componentScores: { heading: -1 } }),
			signalCandidate("global://too-large.md", { componentScores: { lexical: RANK_SCORE_SCALE + 1 } }),
			signalCandidate("global://unknown-stage.md", {
				componentScores: undefined,
				stage: "unknown" as unknown as RankCandidate["stage"],
			}),
		];
		for (const candidate of invalidCandidates) {
			const result = rankCandidates([candidate], context);
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.error.code).toBe("invalid-input");
		}

		const invalidAsOf = rankCandidates([], { asOf: "2026-07-29T00:00:00+00:00" });
		expect(invalidAsOf.ok).toBe(false);
		const invalidFreshness = rankCandidates(
			[
				signalCandidate("global://bad-freshness.md", {
					freshnessScore: undefined,
					updatedAt: "not-a-timestamp",
				}),
			],
			context,
		);
		expect(invalidFreshness.ok).toBe(false);
		const emptyUri = rankCandidates([signalCandidate("")], context);
		expect(emptyUri.ok).toBe(false);

		const duplicateUri = rankCandidates(
			[signalCandidate("global://cafe\u0301.md"), signalCandidate("global://café.md")],
			context,
		);
		expect(duplicateUri.ok).toBe(false);
	});
});
