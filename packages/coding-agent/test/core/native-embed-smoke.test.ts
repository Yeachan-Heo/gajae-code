import { expect, test } from "bun:test";
import {
	editFindMatch,
	editSeekSequence,
	h01FindBestFuzzyMatch,
	h02ScoreSequenceFuzzy,
	h06FormatHashLines,
	pdfToMarkdown,
} from "../../../natives/native/index.js";

// Single-binary verification (G005): every new native export resolves through
// the embedded-addon loader and is callable on a minimal fixture.
test("new native exports are callable via the loader", () => {
	expect(typeof h06FormatHashLines).toBe("function");
	expect(typeof h02ScoreSequenceFuzzy).toBe("function");
	expect(typeof h01FindBestFuzzyMatch).toBe("function");
	expect(typeof pdfToMarkdown).toBe("function");
});

test("h06FormatHashLines produces LINE+HASH|TEXT output", () => {
	const out = h06FormatHashLines("alpha\nbeta", 1);
	const lines = out.split("\n");
	expect(lines.length).toBe(2);
	expect(lines[0]).toMatch(/^1[a-z]{2}\|alpha$/);
	expect(lines[1]).toMatch(/^2[a-z]{2}\|beta$/);
});

test("h02ScoreSequenceFuzzy returns a result shape", () => {
	const r = h02ScoreSequenceFuzzy(["function alpha() {}", "x"], ["function alpha() {}"], 0, false);
	expect(r).toBeTruthy();
	expect(typeof r.matchCount).toBe("number");
});

test("pi-edit matcher exports are callable via the native loader", () => {
	const match = editFindMatch("prefix\nalpha", "alpha", false, 0.95);
	expect(match.matched).toMatchObject({ actualText: "alpha", startIndex: 7, startLine: 2, confidence: 1 });
	const sequence = editSeekSequence(["  alpha"], ["alpha"], 0, false, true);
	expect(sequence).toMatchObject({ index: 0, confidence: 0.98, strategy: "trim" });
});
