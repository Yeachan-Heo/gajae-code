/**
 * Hangul-aware matching primitives shared by the fuzzy matchers.
 *
 * Two independent matchers need the same two behaviors, so they live here rather than being
 * duplicated: initial-consonant (초성) matching, and NFC folding. Folding matters because macOS
 * hands back canonically decomposed filenames, and a decomposed syllable shares no code point
 * with its composed form — an unfolded comparison silently never matches.
 */

/** Modern compatibility jamo in Unicode initial-consonant order (`0xAC00` syllable layout). */
const HANGUL_INITIAL_COMPAT_JAMO = "ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ";

const HANGUL_SYLLABLE_BASE = 0xac00;
const HANGUL_SYLLABLE_COUNT = 11172;
/** Syllables per initial consonant: 21 medials × 28 finals. */
const HANGUL_SYLLABLES_PER_INITIAL = 588;

/** The compatibility jamo for a precomposed syllable's initial consonant, or `undefined`. */
export function hangulInitialJamo(char: string): string | undefined {
	const offset = char.charCodeAt(0) - HANGUL_SYLLABLE_BASE;
	if (offset < 0 || offset >= HANGUL_SYLLABLE_COUNT) return undefined;
	return HANGUL_INITIAL_COMPAT_JAMO[Math.floor(offset / HANGUL_SYLLABLES_PER_INITIAL)];
}

/**
 * Single-character equality that also lets a bare Hangul consonant match a syllable's initial,
 * so `ㅎㄱ` matches `한글` (초성 검색).
 */
export function hangulFuzzyCharMatches(queryChar: string, targetChar: string): boolean {
	return queryChar === targetChar || hangulInitialJamo(targetChar) === queryChar;
}

/**
 * Composes Hangul so decomposed and precomposed spellings compare equal.
 *
 * Callers must fold both sides before comparing: initial-jamo lookup is defined only for
 * precomposed syllables, so a decomposed target matches neither a composed query nor a chosung.
 */
export function foldHangulText(value: string): string {
	return value.normalize("NFC");
}
