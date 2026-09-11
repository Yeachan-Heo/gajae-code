import { describe, expect, test } from "bun:test";
import { fuzzyFilter, fuzzyMatch } from "@gajae-code/tui/fuzzy";
import { foldHangulText, hangulFuzzyCharMatches, hangulInitialJamo } from "@gajae-code/tui/hangul";

const NFC = (value: string): string => value.normalize("NFC");
const NFD = (value: string): string => value.normalize("NFD");

describe("hangul primitives", () => {
	test("maps precomposed syllables to their initial consonant", () => {
		expect(hangulInitialJamo("한")).toBe("ㅎ");
		expect(hangulInitialJamo("글")).toBe("ㄱ");
		expect(hangulInitialJamo("설")).toBe("ㅅ");
		expect(hangulInitialJamo("따")).toBe("ㄸ");
	});

	test("returns undefined outside the syllable block, including decomposed jamo", () => {
		expect(hangulInitialJamo("a")).toBeUndefined();
		expect(hangulInitialJamo("ㅎ")).toBeUndefined();
		// A decomposed syllable starts with a conjoining jamo, not a syllable code point.
		expect(hangulInitialJamo(NFD("한")[0]!)).toBeUndefined();
	});

	test("matches a bare consonant against a syllable initial but not the reverse", () => {
		expect(hangulFuzzyCharMatches("ㅎ", "한")).toBe(true);
		expect(hangulFuzzyCharMatches("한", "한")).toBe(true);
		expect(hangulFuzzyCharMatches("한", "ㅎ")).toBe(false);
		expect(hangulFuzzyCharMatches("ㄱ", "한")).toBe(false);
	});

	test("folds decomposed text to its composed form", () => {
		expect(foldHangulText(NFD("한글"))).toBe(NFC("한글"));
		expect(foldHangulText("ascii-untouched")).toBe("ascii-untouched");
	});
});

describe("fuzzyMatch hangul support", () => {
	test("matches a chosung query against precomposed text", () => {
		expect(fuzzyMatch("ㅎㄱ", NFC("한글")).matches).toBe(true);
		expect(fuzzyMatch("ㅅㅈㅍㅇ", NFC("설정파일.ts")).matches).toBe(true);
	});

	test("matches a chosung query against decomposed text", () => {
		// macOS hands back NFD filenames; before folding this never matched.
		expect(fuzzyMatch("ㅎㄱ", NFD("한글")).matches).toBe(true);
		expect(fuzzyMatch("ㅅㅈㅍㅇ", NFD("설정파일.ts")).matches).toBe(true);
	});

	test("matches across normalization forms in both directions", () => {
		expect(fuzzyMatch(NFC("한글"), NFD("한글경로")).matches).toBe(true);
		expect(fuzzyMatch(NFD("한글"), NFC("한글경로")).matches).toBe(true);
		expect(fuzzyMatch(NFD("한글"), NFD("한글경로")).matches).toBe(true);
	});

	test("still rejects a non-matching chosung", () => {
		expect(fuzzyMatch("ㄱㄱ", NFC("한글")).matches).toBe(false);
		expect(fuzzyMatch("ㅎㄱ", "hangul").matches).toBe(false);
	});

	test("scores a decomposed target identically to its composed form", () => {
		const composed = fuzzyMatch("ㅎㄱ", NFC("한글경로"));
		const decomposed = fuzzyMatch("ㅎㄱ", NFD("한글경로"));
		expect(decomposed.matches).toBe(composed.matches);
		expect(decomposed.score).toBe(composed.score);
	});

	test("preserves existing ASCII behavior", () => {
		expect(fuzzyMatch("wig", "skill:wig").matches).toBe(true);
		expect(fuzzyMatch("", "anything").matches).toBe(true);
		expect(fuzzyMatch("zzz", "abc").matches).toBe(false);
		// A prefix match still outranks a scattered subsequence.
		expect(fuzzyMatch("abc", "abcdef").score).toBeLessThan(fuzzyMatch("abc", "axbxcx").score);
	});

	test("keeps the alphanumeric swap fallback working", () => {
		expect(fuzzyMatch("a1", "1a-thing").matches).toBe(true);
	});
});

describe("fuzzyFilter hangul support", () => {
	const items = [NFC("한글경로 설정"), NFD("한글경로 설정"), "hangul settings"];

	test("returns both normalization forms for a composed query", () => {
		// Measured before the fix: 1 of 2 Hangul items, the NFD entry silently invisible.
		expect(fuzzyFilter(items, NFC("한글"), value => value)).toHaveLength(2);
	});

	test("returns both normalization forms for a decomposed query", () => {
		expect(fuzzyFilter(items, NFD("한글"), value => value)).toHaveLength(2);
	});

	test("returns both normalization forms for a chosung query", () => {
		// Measured before the fix: 0 matches — the feature was absent from this matcher.
		expect(fuzzyFilter(items, "ㅎㄱ", value => value)).toHaveLength(2);
	});

	test("still requires every whitespace-separated token to match", () => {
		expect(fuzzyFilter(items, "ㅎㄱ ㅅㅈ", value => value)).toHaveLength(2);
		expect(fuzzyFilter(items, "ㅎㄱ zzz", value => value)).toHaveLength(0);
	});

	test("leaves ASCII-only filtering unchanged", () => {
		expect(fuzzyFilter(items, "hangul", value => value)).toEqual(["hangul settings"]);
		expect(fuzzyFilter(items, "   ", value => value)).toEqual(items);
	});
});
