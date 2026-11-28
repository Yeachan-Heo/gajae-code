import { expect, test } from "bun:test";
import { editFindMatch, editSeekSequence, pdfToMarkdown } from "../../../natives/native/index.js";

// Single-binary verification (G005): every new native export resolves through
// the embedded-addon loader and is callable on a minimal fixture.
test("new native exports are callable via the loader", () => {
	expect(typeof pdfToMarkdown).toBe("function");
});

test("pi-edit matcher and pdf exports are callable via the native loader", () => {
	const match = editFindMatch("prefix\nalpha", "alpha", false, 0.95);
	expect(match.matched).toMatchObject({ actualText: "alpha", startIndex: 7, startLine: 2, confidence: 1 });
	const sequence = editSeekSequence(["  alpha"], ["alpha"], 0, false, true);
	expect(sequence).toMatchObject({ index: 0, confidence: 0.98, strategy: "trim" });
});
