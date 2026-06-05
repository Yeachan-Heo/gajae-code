import { expect, test } from "bun:test";
import { h02ScoreSequenceFuzzy } from "../../../natives/native/index.js";
import { seekSequence } from "../../src/edit/modes/replace";

// Regression for the H02 native parity blocker (architect 15-ReviewG003):
// the native fuzzy normalizer must NOT lowercase (it previously mapped A-Z to
// a-z, so ABC could wrongly match abc at confidence 1). Smart-quote/dash parity
// with native active is covered by the "Unicode punctuation" seekSequence case
// in edit-hotspots-golden (snapshot oracle, no --update).
test("no lowercasing: case-only difference is not a perfect normalized match", () => {
	const content = ["function ALPHA() {}", "function beta() {}"];
	const r = seekSequence(content, ["function alpha() {}"], 0, false, { allowFuzzy: true });
	if (r && typeof r.confidence === "number") expect(r.confidence).toBeLessThan(1);
});

test("native h02 scorer export is callable", () => {
	expect(typeof h02ScoreSequenceFuzzy).toBe("function");
});
