import { expect, test } from "bun:test";
import { editFindMatch, editSeekSequence } from "../../../natives/native/index.js";
import { findMatch, seekSequence } from "../../src/edit/modes/replace";

const content = "alpha 👩‍💻\nbeta 😀\ngamma";
const target = "beta 😃";

function expectSameConfidence(actual: number | undefined, expected: number | undefined) {
	expect(actual).toBeDefined();
	expect(expected).toBeDefined();
	expect(Math.abs(actual! - expected!)).toBeLessThanOrEqual(1e-12);
}

test("native replace and sequence scoring match the TypeScript UTF-16 surrogate golden", async () => {
	const typescriptReplace = await findMatch(content, target, { allowFuzzy: true, threshold: 0.88 });
	const nativeReplace = editFindMatch(content, target, true, 0.88);

	expect(typescriptReplace.match).toMatchObject({
		actualText: "beta 😀",
		startIndex: 12,
		startLine: 2,
	});
	expect(nativeReplace.matched).toMatchObject({
		actualText: typescriptReplace.match!.actualText,
		startIndex: typescriptReplace.match!.startIndex,
		startLine: typescriptReplace.match!.startLine,
	});
	expect(typescriptReplace.match!.confidence).toBe(0.8888888888888888);
	expect(nativeReplace.matched?.confidence).toBe(0.8888888888888888);
	expectSameConfidence(nativeReplace.matched?.confidence, typescriptReplace.match?.confidence);

	const typescriptRejected = await findMatch(content, target, { allowFuzzy: true, threshold: 0.95 });
	const nativeRejected = editFindMatch(content, target, true, 0.95);
	expect(typescriptRejected.match).toBeUndefined();
	expect(nativeRejected.matched).toBeUndefined();
	expectSameConfidence(nativeRejected.closest?.confidence, typescriptRejected.closest?.confidence);

	const typescriptSequence = await seekSequence(content.split("\n"), target.split("\n"), 0, false, {
		allowFuzzy: true,
	});
	const nativeSequence = editSeekSequence(content.split("\n"), target.split("\n"), 0, false, true);
	expect(typescriptSequence.index).toBeUndefined();
	expect(nativeSequence.index).toBeUndefined();
	expect(typescriptSequence.confidence).toBe(0.8571428571428572);
	expect(nativeSequence.confidence).toBe(0.8571428571428572);
	expectSameConfidence(nativeSequence.confidence, typescriptSequence.confidence);
});
