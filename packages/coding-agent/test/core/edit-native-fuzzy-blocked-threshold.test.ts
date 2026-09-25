import { expect, test } from "bun:test";
import { editFindMatch, editSeekSequence } from "../../../natives/native/index.js";
import { findMatch, seekSequence } from "../../src/edit/modes/replace";

const content = "alpha 👩‍💻\nbeta 😀\ngamma";
const target = "beta 😃";

test("BLOCKED: Unicode scalar scoring flips a supported custom replace threshold", () => {
	const typescript = findMatch(content, target, { allowFuzzy: true, threshold: 0.88 });
	const native = editFindMatch(content, target, true, 0.88);

	expect(typescript.match).toMatchObject({
		actualText: "beta 😀",
		startIndex: 12,
		startLine: 2,
		confidence: 0.8888888888888888,
	});
	expect(native.matched).toBeUndefined();
	expect(native.closest).toMatchObject({
		actualText: "beta 😀",
		startIndex: 12,
		startLine: 2,
		confidence: 0.875,
	});
});

test("BLOCKED: default replace and sequence thresholds do not flip this fixture", () => {
	const typescriptReplace = findMatch(content, target, { allowFuzzy: true, threshold: 0.95 });
	const nativeReplace = editFindMatch(content, target, true, 0.95);
	const typescriptSequence = seekSequence(content.split("\n"), target.split("\n"), 0, false, { allowFuzzy: true });
	const nativeSequence = editSeekSequence(content.split("\n"), target.split("\n"), 0, false, true);

	expect(typescriptReplace.match).toBeUndefined();
	expect(nativeReplace.matched).toBeUndefined();
	expect(typescriptSequence.index).toBeUndefined();
	expect(nativeSequence.index).toBeUndefined();
	expect(typescriptSequence.confidence).toBe(0.8571428571428572);
	expect(nativeSequence.confidence).toBe(0.8333333333333334);
});
