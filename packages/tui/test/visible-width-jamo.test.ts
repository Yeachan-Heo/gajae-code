/**
 * Regression guard for the Hangul Compatibility Jamo width correction in
 * `visibleWidthRaw`.
 *
 * `Bun.stringWidth` (and the underlying UAX#11 EAW tables) classify Hangul
 * Compatibility Jamo (U+3131..U+318E) as Wide (2 cells), but every macOS
 * terminal we ship to (Ghostty, Terminal.app, iTerm2) actually renders them
 * as a single cell. Without the correction, `#extractCursorPosition` doubles
 * the column count for every jamo emitted by a Korean IME during
 * composition, displacing the hardware cursor (and therefore the IME
 * candidate window) `N_jamo` cells past the actual glyph.
 *
 * Hangul Syllables (U+AC00..U+D7A3, e.g. `안`) are correctly 2 cells in both
 * Bun and the terminal — make sure the fix did NOT regress that. The
 * Halfwidth Hangul block (U+FFA0..U+FFDC) is already classified as Narrow
 * by Bun, so it does not appear in the correction and the test below is a
 * regression sanity check.
 */
import { describe, expect, it } from "bun:test";
import { Ellipsis, sliceWithWidth, truncateToWidth, visibleWidth } from "@gajae-code/tui/utils";

describe("visibleWidth — Hangul Compatibility Jamo correction", () => {
	it("single compatibility jamo is 1 cell (not 2)", () => {
		// U+3141 HANGUL LETTER MIEUM
		expect(visibleWidth("ㅁ")).toBe(1);
		// U+3134 HANGUL LETTER NIEUN
		expect(visibleWidth("ㄴ")).toBe(1);
		// U+3147 HANGUL LETTER IEUNG
		expect(visibleWidth("ㅇ")).toBe(1);
		// U+3142 HANGUL LETTER PIEUP
		expect(visibleWidth("ㅂ")).toBe(1);
		// U+3148 HANGUL LETTER JIEUJ
		expect(visibleWidth("ㅈ")).toBe(1);
	});

	it("range edges U+3131 and U+318E are corrected", () => {
		// U+3131 HANGUL LETTER KIYEOK — first jamo in the block
		expect(visibleWidth("\u3131")).toBe(1);
		// U+318E HANGUL LETTER ARAEAE — last jamo in the block
		expect(visibleWidth("\u318e")).toBe(1);
	});

	it("U+3164 HANGUL FILLER (inside the corrected range) is 1 cell", () => {
		// Often emitted by IME for empty-syllable placeholders.
		expect(visibleWidth("\u3164")).toBe(1);
	});

	it("string of 8 consecutive jamo is 8 cells, not 16", () => {
		// Matches the user-typed sequence in the v2 screen recording —
		// before the fix this returned 16 and produced an 8-cell gap.
		expect(visibleWidth("ㅁㄴㅁㄴㅇㅂㄴㅂ")).toBe(8);
	});

	it("Hangul Syllables (U+AC00..U+D7A3) stay at 2 cells", () => {
		// `안` U+C548 — composed syllable, must remain 2 cells
		expect(visibleWidth("안")).toBe(2);
		// `녕` U+B155 — composed syllable
		expect(visibleWidth("녕")).toBe(2);
		// Whole word: 안녕 = 4 cells
		expect(visibleWidth("안녕")).toBe(4);
		// First & last in the block, for boundary coverage
		expect(visibleWidth("\uac00")).toBe(2); // 가
		expect(visibleWidth("\ud7a3")).toBe(2); // 힣
	});
	it("conjoining jamo sequences use NFC terminal width", () => {
		// Some macOS input paths deliver Hangul syllables as conjoining jamo
		// (NFD). Terminals render them as the composed syllable, so width must
		// match NFC or the hardware cursor drifts one cell per syllable.
		expect(visibleWidth("하")).toBe(2);
		expect(visibleWidth("한")).toBe(2);
		expect(visibleWidth("한글")).toBe(4);
	});

	it("mixed ASCII + syllable + jamo strings add correctly", () => {
		// a (1) + 안 (2) + ㅂ (1) + b (1) = 5
		expect(visibleWidth("a안ㅂb")).toBe(5);
		// 11 ASCII letters + 1 syllable + 4 jamo = 11 + 2 + 4 = 17
		expect(visibleWidth("hello world안ㅁㄴㅇㅂ")).toBe(11 + 2 + 4);
	});

	it("does not regress ASCII fast path or empty input", () => {
		expect(visibleWidth("")).toBe(0);
		expect(visibleWidth("hello")).toBe(5);
		expect(visibleWidth("a")).toBe(1);
		// Tab character (ASCII 0x09) inside the fast path expands to >2
		expect(visibleWidth("a\tb")).toBeGreaterThan(2);
	});

	it("does not change width for other CJK characters", () => {
		// Chinese: 漢字 (each 2 cells)
		expect(visibleWidth("漢字")).toBe(4);
		// Japanese hiragana: あい (each 2 cells)
		expect(visibleWidth("あい")).toBe(4);
		// Japanese katakana: アイ (each 2 cells)
		expect(visibleWidth("アイ")).toBe(4);
	});

	it("Halfwidth Hangul block is unaffected (already Narrow in Bun)", () => {
		// U+FFA1 HALFWIDTH HANGUL LETTER KIYEOK — Bun reports 1, untouched.
		expect(visibleWidth("\uffa1")).toBe(1);
		// U+FFDC HALFWIDTH HANGUL LETTER I
		expect(visibleWidth("\uffdc")).toBe(1);
	});
});

describe("native text helpers — Hangul Compatibility Jamo correction", () => {
	// These exercise the Rust-side `char_width_corrected` wrapper in
	// crates/pi-natives/src/text.rs. They will fail until the native
	// binding is rebuilt (`bun run build:native`); CI rebuilds natives so
	// they pass there. Mirrors the TS-side range U+3131..=U+318E.

	it("sliceWithWidth treats jamo as 1 cell per character", () => {
		// 8 jamo at 1 cell each must fit fully in an 8-cell slice
		// (pre-fix: native counted 2 cells/jamo and returned 4 chars).
		const input = "ㅁ".repeat(8);
		const { text, width } = sliceWithWidth(input, 0, 8, true);
		expect(text).toBe(input);
		expect(width).toBe(8);
	});

	it("truncateToWidth keeps 8 jamo within an 8-cell budget", () => {
		// Pre-fix: native truncated to 4 jamo because each was 2 cells.
		const result = truncateToWidth("ㅁ".repeat(20), 8, Ellipsis.Omit);
		// Strip any trailing pad to count jamo content.
		const jamo = result.replaceAll(/[^\u3131-\u318E]/g, "");
		expect(jamo.length).toBe(8);
	});

	it("native and TS visibleWidth agree on a jamo run", () => {
		// Cross-layer parity guard: without the native fix, the TS path
		// (Bun.stringWidth + manual correction) and the native path
		// (unicode_width) disagreed by a factor of 2.
		const input = "ㅁㄴㅇㅂㅈㄷㄱㅅ";
		expect(visibleWidth(input)).toBe(8);
		expect(sliceWithWidth(input, 0, 8, true).width).toBe(8);
	});
});
