import { describe, expect, test } from "bun:test";
import { findBestFuzzyMatch } from "../../src/edit/modes/replace";

const native = await import("../../../natives/native/index.js").catch(() => undefined);

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
