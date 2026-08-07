import { describe, expect, it } from "bun:test";

import { type AliasDefinition, expandAliases, normalizeAlias } from "../../src/search/alias-expansion";
import { type LexicalDocument, lexicalSearch, SCORE_SCALE, tokenizeLexical } from "../../src/search/lexical-search";

describe("M2 lexical search", () => {
	it("tokenizes NFC-normalized Unicode letters and numbers without stemming or stopwords", () => {
		expect(tokenizeLexical("  Cafe\u0301—CAFÉ 42 déjà-vu can't 世界! ")).toEqual([
			"café",
			"café",
			"42",
			"déjà",
			"vu",
			"can",
			"t",
			"世界",
		]);
		expect(normalizeAlias("PullRequest")).toBe("pull request");
	});

	it("matches document bodies only and reports query tokens once", () => {
		const documents: readonly LexicalDocument[] = [
			{ uri: "global://needle.md", text: "the document name is not its body" },
			{ uri: "global://other.md", text: "The NEEDLE appears twice: needle" },
			{ uri: "global://unrelated.md", text: "a body without the requested term" },
		];
		const result = lexicalSearch("needle, NEEDLE", documents);

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.candidateCount).toBe(3);
		expect(result.value.hits).toHaveLength(1);
		expect(result.value.hits[0]).toMatchObject({ uri: "global://other.md", score: SCORE_SCALE });
		expect(result.value.hits[0]?.matchedTokens).toEqual(["needle"]);
	});

	it("computes IDF over the supplied candidate set rather than an external corpus", () => {
		const firstSet: readonly LexicalDocument[] = [
			{ uri: "global://a.md", text: "alpha beta" },
			{ uri: "global://b.md", text: "alpha" },
		];
		const expandedSet: readonly LexicalDocument[] = [...firstSet, { uri: "global://c.md", text: "beta" }];
		const local = lexicalSearch("alpha beta", firstSet);
		const expanded = lexicalSearch("alpha beta", expandedSet);

		expect(local.ok).toBe(true);
		expect(expanded.ok).toBe(true);
		if (!local.ok || !expanded.ok) return;
		const localB = local.value.hits.find(hit => hit.uri === "global://b.md");
		const expandedB = expanded.value.hits.find(hit => hit.uri === "global://b.md");
		expect(local.value.candidateCount).toBe(2);
		expect(expanded.value.candidateCount).toBe(3);
		expect(localB).toBeDefined();
		expect(expandedB).toBeDefined();
		if (localB === undefined || expandedB === undefined) return;
		expect(expandedB.score).toBeGreaterThan(localB.score);
		expect(local.value.hits[0]?.score).toBe(SCORE_SCALE);
		expect(expanded.value.hits[0]?.score).toBe(SCORE_SCALE);
	});

	it("quantizes every hit to a finite integer score in the closed scale and orders ties by canonical URI", () => {
		const result = lexicalSearch("same", [
			{ uri: "global://é.md", text: "same" },
			{ uri: "global://z.md", text: "same" },
			{ uri: "global://a.md", text: "same" },
		]);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.hits.map(hit => hit.uri)).toEqual(["global://a.md", "global://z.md", "global://é.md"]);
		for (const hit of result.value.hits) {
			expect(Number.isFinite(hit.score)).toBe(true);
			expect(Number.isInteger(hit.score)).toBe(true);
			expect(hit.score).toBeGreaterThanOrEqual(0);
			expect(hit.score).toBeLessThanOrEqual(SCORE_SCALE);
		}
		expect(new Set(result.value.hits.map(hit => hit.score)).size).toBe(1);
	});

	it("fails closed for empty queries, malformed document collections, empty URIs, and canonical duplicates", () => {
		const emptyQuery = lexicalSearch("--- \t", []);
		expect(emptyQuery.ok).toBe(false);
		if (!emptyQuery.ok) expect(emptyQuery.error.code).toBe("invalid-input");

		const malformedDocuments = lexicalSearch("needle", null as unknown as readonly LexicalDocument[]);
		expect(malformedDocuments.ok).toBe(false);
		if (!malformedDocuments.ok) expect(malformedDocuments.error.code).toBe("invalid-input");

		const emptyUri = lexicalSearch("needle", [{ uri: "", text: "needle" }]);
		expect(emptyUri.ok).toBe(false);
		if (!emptyUri.ok) expect(emptyUri.error.code).toBe("invalid-input");

		const duplicateUri = lexicalSearch("needle", [
			{ uri: "global://cafe\u0301.md", text: "needle" },
			{ uri: "global://café.md", text: "needle" },
		]);
		expect(duplicateUri.ok).toBe(false);
		if (!duplicateUri.ok) {
			expect(duplicateUri.error.code).toBe("invalid-input");
			if (duplicateUri.error.code === "invalid-input") {
				expect(duplicateUri.error.detail).toContain("duplicate document URI");
			}
		}

		const allEmpty = lexicalSearch("needle", [{ uri: "global://empty.md", text: "" }]);
		expect(allEmpty).toEqual({
			ok: true,
			value: { hits: [], candidateCount: 1, averageLength: 0 },
		});
		const nonFiniteQuery = lexicalSearch(Number.NaN as unknown as string, []);
		expect(nonFiniteQuery.ok).toBe(false);
		if (!nonFiniteQuery.ok) expect(nonFiniteQuery.error.code).toBe("invalid-input");

		const nonFiniteText = lexicalSearch("needle", [
			{ uri: "global://non-finite.md", text: Number.POSITIVE_INFINITY as unknown as string },
		]);
		expect(nonFiniteText.ok).toBe(false);
		if (!nonFiniteText.ok) expect(nonFiniteText.error.code).toBe("invalid-input");
	});

	it("bounds alias expansion, normalizes aliases, and deduplicates repeated forms", () => {
		const definition: AliasDefinition = {
			term: "PullRequest",
			aliases: ["PR", "pr", "pull-request", "pull request", "PR"],
		};
		const exact = expandAliases("PR", [definition], 10);
		expect(exact).toHaveLength(1);
		expect(exact[0]).toEqual({ term: "pull request", alias: "pr", score: 1_000_000, reason: "exact" });

		const duplicateDefinitions = expandAliases("PR", [definition, { term: "pull request", aliases: ["pr"] }], 10);
		expect(duplicateDefinitions).toHaveLength(1);
		expect(duplicateDefinitions[0]).toEqual(exact[0]);

		const fuzzy = expandAliases("pull requst", [definition], 10);
		expect(fuzzy).toHaveLength(1);
		expect(fuzzy[0]?.term).toBe("pull request");
		expect(fuzzy[0]?.alias).toBe("pull request");
		expect(fuzzy[0]?.reason).toBe("fuzzy");
		if (fuzzy[0] !== undefined) {
			expect(Number.isFinite(fuzzy[0].score)).toBe(true);
			expect(Number.isInteger(fuzzy[0].score)).toBe(true);
			expect(fuzzy[0].score).toBeGreaterThan(0);
			expect(fuzzy[0].score).toBeLessThan(1_000_000);
		}

		const manyDefinitions: AliasDefinition[] = Array.from({ length: 100 }, (_, index) => ({
			term: `term-${index}`,
			aliases: ["needle", "needle"],
		}));
		const bounded = expandAliases("needle", manyDefinitions, 100);
		expect(bounded).toHaveLength(64);
		expect(new Set(bounded.map(expansion => `${expansion.term}\u0000${expansion.alias}`)).size).toBe(64);
		expect(expandAliases("needle", manyDefinitions, 0)).toEqual([]);
		expect(expandAliases("needle", manyDefinitions, Number.NaN)).toEqual([]);
	});
});
