import { describe, expect, test } from "bun:test";
import { findBestFuzzyMatch } from "../../src/edit/modes/replace";

const native = await import("../../../natives/native/index.js").catch(() => undefined);

const repeatedWords = (unitCount: number, tail: string) =>
	`${"alpha ".repeat(Math.floor(unitCount / 6))}${"b".repeat(unitCount % 6)}${tail}`;

const cases: Array<{ name: string; content: string; target: string; threshold?: number }> = [
	{ name: "exact", content: "alpha\nbeta\ngamma", target: "beta" },
	{
		name: "fuzzy",
		content: "alpha\n    return alphaBetaGamma(value, options);\nomega",
		target: "    return alphaBetaGamme(value, options);",
		threshold: 0.9,
	},
	{ name: "ambiguous", content: "foo bar baz\nfoo bor baz\nfoo bur baz", target: "foo bir baz", threshold: 0.8 },
	{ name: "dominant", content: "needle almost\nneedle exactish\nnoise", target: "needle exact", threshold: 0.8 },
	{ name: "below-threshold", content: "short\nfar away\nother", target: "completely different", threshold: 0.95 },
	{ name: "no-match", content: "tiny", target: "this target has many more lines\nthan content", threshold: 0.9 },
	{ name: "EOF", content: "first\nsecond\nlast-ish", target: "last-is", threshold: 0.8 },
	{ name: "CRLF", content: "one\r\ntwo-ish\r\nthree", target: "two", threshold: 0.8 },
	{ name: "Unicode", content: "quote “hello”\ndash – café\nemoji 👩‍💻", target: 'quote "hello"', threshold: 0.8 },
	{ name: "indent", content: "if (x) {\n    callThing();\n}\ncallThing();", target: "callThang();", threshold: 0.8 },
	{ name: "case-only", content: "AlphaBetaGamma", target: "alphabetagamma", threshold: 0.8 },
	{
		name: "long-pattern-dp-fallback",
		content: `${"a".repeat(140)}x\n${"a".repeat(140)}y`,
		target: `${"a".repeat(140)}z`,
		threshold: 0.9,
	},
	{
		name: "multi-line-ambiguous-depth-fallback",
		content: "root\n  alpha beta\n    gamma delta\nother\nalpha beta\ngamma delto",
		target: "alpha beta\ngamma delta",
		threshold: 0.9,
	},
	{
		name: "dash-and-space-normalization",
		content: "alpha\t beta — gamma\nalpha beta - gammo",
		target: "alpha beta - gamma",
		threshold: 0.9,
	},
	{
		name: "boundary-64-units",
		content: `${"a".repeat(63)}x\n${"a".repeat(63)}y`,
		target: `${"a".repeat(63)}z`,
		threshold: 0.9,
	},
	{
		name: "boundary-65-units",
		content: `${"a".repeat(64)}x\n${"a".repeat(64)}y`,
		target: `${"a".repeat(64)}z`,
		threshold: 0.9,
	},
	{
		name: "boundary-128-units",
		content: `${"a".repeat(127)}x\n${"a".repeat(127)}y`,
		target: `${"a".repeat(127)}z`,
		threshold: 0.9,
	},
	{
		name: "boundary-129-units",
		content: `${"a".repeat(128)}x\n${"a".repeat(128)}y`,
		target: `${"a".repeat(128)}z`,
		threshold: 0.9,
	},
	{
		name: "boundary-300-units-multi-word",
		content: `${repeatedWords(299, "x")}\n${repeatedWords(299, "y")}`,
		target: repeatedWords(299, "z"),
		threshold: 0.9,
	},
];

describe("H01 native findBestFuzzyMatch differential", () => {
	test.skipIf(!native?.h01FindBestFuzzyMatch)("matches TS findMatch fuzzy fields across fixture matrix", () => {
		for (const c of cases) {
			const threshold = c.threshold ?? 0.9;
			const ts = findBestFuzzyMatch(c.content, c.target, threshold);
			const nativeResult = native!.h01FindBestFuzzyMatch(c.content, c.target, threshold);
			expect(nativeResult, c.name).toEqual(ts);
		}
	});
});
