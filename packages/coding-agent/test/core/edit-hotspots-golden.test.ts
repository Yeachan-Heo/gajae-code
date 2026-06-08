import { describe, expect, test } from "bun:test";
import { replaceText } from "../../src/edit/diff";
import { findMatch, seekSequence } from "../../src/edit/modes/replace";
import { normalizeToLF } from "../../src/edit/normalize";
import { formatHashLines } from "../../src/hashline/hash";

const longLine = `${"a".repeat(512)} TARGET ${"b".repeat(512)}`;

const cases = [
	{ name: "LF", content: "alpha\nbeta\ngamma\n", target: "beta", replacement: "BETA", startLine: 1 },
	{ name: "CRLF", content: "alpha\r\nbeta\r\ngamma\r\n", target: "beta", replacement: "BETA", startLine: 3 },
	{ name: "embedded CR", content: "alpha\nbet\ra\ngamma", target: "beta", replacement: "BETA", startLine: 5 },
	{ name: "no-final-newline", content: "alpha\nbeta\ngamma", target: "gamma", replacement: "GAMMA", startLine: 7 },
	{ name: "blank lines", content: "alpha\n\n\tbeta\n\n", target: "\tbeta", replacement: "\tBETA", startLine: 11 },
	{
		name: "trailing whitespace",
		content: "alpha   \nbeta\t\ngamma  ",
		target: "beta",
		replacement: "BETA",
		startLine: 13,
	},
	{ name: "tabs", content: "\talpha\n\t\tbeta\n\tgamma", target: "    beta", replacement: "    BETA", startLine: 17 },
	{
		name: "Unicode punctuation",
		content: "alpha — beta\nquote “smart”\nellipsis …",
		target: 'quote "smart"',
		replacement: "quote 'plain'",
		startLine: 19,
	},
	{
		name: "surrogate pairs",
		content: "alpha 👩‍💻\nbeta 😀\ngamma",
		target: "beta 😃",
		replacement: "BETA 😀",
		startLine: 23,
	},
	{
		name: "combining marks",
		content: "cafe\u0301\nmañana\nresume\u0301",
		target: "café",
		replacement: "CAFÉ",
		startLine: 29,
	},
	{
		name: "long lines",
		content: `before\n${longLine}\nafter`,
		target: `${"a".repeat(512)} TARGET ${"b".repeat(511)}c`,
		replacement: "LONG",
		startLine: 31,
	},
	{
		name: "ambiguous fuzzy",
		content: "item1\nitem2\nitem3",
		target: "itemX",
		replacement: "ITEM",
		startLine: 37,
		threshold: 0.7,
	},
	{
		name: "dominant fuzzy",
		content:
			"function alphaBetaGamma(value) {}\nfunction alphaBetaGimme(value) {}\nfunction completelyDifferent(value) {}",
		target: "function alphaBetaGammx(value) {}",
		replacement: "function winner(value) {}",
		startLine: 41,
		threshold: 0.9,
	},
	{
		name: "below-threshold-closest",
		content: "function alpha() {}\nfunction beta() {}",
		target: "class omega {}",
		replacement: "class replaced {}",
		startLine: 43,
		threshold: 0.99,
	},
	{ name: "no-match", content: "alpha\nbeta\ngamma", target: "zzz", replacement: "ZZZ", startLine: 47 },
	{ name: "EOF", content: "alpha\nbeta\ngamma", target: "gamma", replacement: "GAMMA", startLine: 53, eof: true },
	{ name: "non-1 startLine", content: "alpha\nbeta\ngamma", target: "alpha", replacement: "ALPHA", startLine: 101 },
];

type JsonValue = unknown;

function stable(value: JsonValue): JsonValue {
	return JSON.parse(JSON.stringify(value));
}

function runCase(c: (typeof cases)[number]) {
	const normalizedContent = normalizeToLF(c.content);
	const lines = normalizedContent.split("\n");
	const pattern = normalizeToLF(c.target).split("\n");
	let replaceResult: JsonValue;
	try {
		replaceResult = replaceText(c.content, c.target, c.replacement, {
			fuzzy: true,
			all: false,
			threshold: c.threshold,
		});
	} catch (error) {
		replaceResult = { error: error instanceof Error ? error.message : String(error) };
	}
	return {
		name: c.name,
		formatHashLines: formatHashLines(c.content, c.startLine),
		findMatchStrict: stable(findMatch(c.content, c.target, { allowFuzzy: false, threshold: c.threshold })),
		findMatchFuzzy: stable(findMatch(c.content, c.target, { allowFuzzy: true, threshold: c.threshold })),
		replaceText: replaceResult,
		seekSequence: stable(
			seekSequence(lines, pattern, c.name === "non-1 startLine" ? 1 : 0, Boolean(c.eof), { allowFuzzy: true }),
		),
	};
}

describe("edit hotspot golden oracle", () => {
	for (const c of cases) {
		test(c.name, () => {
			expect(runCase(c)).toMatchSnapshot();
		});
	}
});
