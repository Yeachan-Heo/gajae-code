import { expect, test } from "bun:test";
import { seekSequence } from "../../src/edit/modes/replace";

test("native sequence fuzzy matching preserves case differences", async () => {
	const content = ["function ALPHA() {}", "function beta() {}"];
	const result = await seekSequence(content, ["function alpha() {}"], 0, false, { allowFuzzy: true });
	expect(result.confidence).toBeLessThan(1);
});
