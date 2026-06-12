import { describe, expect, it } from "bun:test";
import {
	extractSegments,
	sliceWithWidth,
	truncateToWidth,
	visibleWidth,
	visibleWidthExceeds,
} from "@gajae-code/tui/utils";

describe("text utils", () => {
	it("computes visible width for ANSI and tabs", () => {
		const text = `\x1b[31mhi\tthere\x1b[0m`;
		expect(visibleWidth(text)).toBe(2 + 3 + 5);
	});

	it("ignores OSC hyperlinks in visible width", () => {
		const text = "\x1b]8;;https://example.com\x07link\x1b]8;;\x07";
		expect(visibleWidth(text)).toBe(4);
	});

	it("truncates ANSI text with ellipsis", () => {
		const text = "\x1b[31mhello world\x1b[0m";
		const result = truncateToWidth(text, 6);
		expect(result.includes("\x1b[0m…")).toBe(true);
		expect(visibleWidth(result)).toBe(6);
	});

	it("slices visible columns while preserving ANSI", () => {
		const text = "\x1b[31mhello\x1b[0m world";
		const result = sliceWithWidth(text, 1, 4, true);
		expect(result.text.startsWith("\x1b[31mello")).toBe(true);
		expect(result.width).toBe(4);
	});

	it("extracts segments with inherited styling", () => {
		const text = "\x1b[31mhello world\x1b[0m";
		const result = extractSegments(text, 3, 6, 5, true);
		expect(result.before).toContain("hel");
		expect(result.after.startsWith("\x1b[31m")).toBe(true);
		expect(result.afterWidth).toBeGreaterThan(0);
	});

	it("checks ASCII/ANSI overflow without counting escape bytes", () => {
		expect(visibleWidthExceeds("abc\x1b[0m", 3)).toBe(false);
		expect(visibleWidthExceeds("abc\x1b[0m", 2)).toBe(true);
		expect(visibleWidthExceeds("hi\t", 5)).toBe(false);
		expect(visibleWidthExceeds("hi\t", 4)).toBe(true);
		expect(visibleWidthExceeds("", -1)).toBe(true);
		expect(visibleWidthExceeds("x", Number.NaN)).toBe(false);
	});

	it("checks OSC hyperlinks and wide text overflow exactly", () => {
		const link = "\x1b]8;;https://example.com\x07link\x1b]8;;\x07";
		expect(visibleWidthExceeds(link, 4)).toBe(false);
		expect(visibleWidthExceeds(link, 3)).toBe(true);
		expect(visibleWidthExceeds("ㅁ", 2)).toBe(false);
		expect(visibleWidthExceeds("ㅁ", 1)).toBe(true);
	});
});
