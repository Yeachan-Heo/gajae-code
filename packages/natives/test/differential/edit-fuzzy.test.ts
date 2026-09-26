import { expect, test } from "bun:test";
import * as path from "node:path";
import { type EditFuzzyOutput, editFuzzyDifferential } from "./cases/edit-fuzzy";
import { readGoldens, verifyDifferential } from "./harness";

const goldenPath = path.join(import.meta.dir, "golden", "edit-fuzzy.jsonl");
const report = await verifyDifferential(editFuzzyDifferential, goldenPath);

test("pi-edit matchers preserve edit-benchmark TS outputs, confidences, and error strings", () => {
	expect(report).toEqual({
		total: 80,
		identical: 80,
		accepted: [],
		unlisted: [],
		stale: [],
	});
});

function confidences(output: EditFuzzyOutput): Array<number | undefined> {
	return [
		output.strict.match?.confidence,
		output.strict.closest?.confidence,
		output.fuzzy.match?.confidence,
		output.fuzzy.closest?.confidence,
		output.sequence.confidence,
		output.missing.strict.match?.confidence,
		output.missing.strict.closest?.confidence,
		output.missing.fuzzy.match?.confidence,
		output.missing.fuzzy.closest?.confidence,
	];
}

test("edit-benchmark match decisions and every confidence match the TS golden", async () => {
	const records = await readGoldens(goldenPath);
	const byId = new Map(records.map(record => [record.caseId, record.output as EditFuzzyOutput]));
	for (const testCase of editFuzzyDifferential.cases) {
		const expected = byId.get(testCase.id);
		if (!expected) throw new Error(`missing edit-fuzzy golden for ${testCase.id}`);
		const actual = await editFuzzyDifferential.native(testCase.input);
		const decisions = (output: EditFuzzyOutput) => ({
			strictMatched: output.strict.match !== undefined,
			strictAmbiguous: (output.strict.occurrences ?? 0) > 1,
			fuzzyMatched: output.fuzzy.match !== undefined,
			fuzzyOccurrenceAmbiguous: (output.fuzzy.occurrences ?? 0) > 1,
			fuzzyMatchAmbiguous: (output.fuzzy.fuzzyMatches ?? 0) > 1,
			dominantFuzzy: output.fuzzy.dominantFuzzy === true,
			sequenceMatched: output.sequence.index !== undefined,
			sequenceAmbiguous: (output.sequence.matchCount ?? 0) > 1,
			sequenceDominant: output.sequence.strategy === "fuzzy-dominant",
		});
		expect(decisions(actual), testCase.id).toEqual(decisions(expected));
		expect(confidences(actual), testCase.id).toEqual(confidences(expected));
	}
});
