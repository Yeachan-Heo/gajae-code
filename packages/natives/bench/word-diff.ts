// A/B adapter for the native word-diff entrypoint, checked against jsdiff.
import { diffWords as nativeDiffWords } from "@gajae-code/natives";
import { diffWords as jsDiffWords } from "diff";
import { runAbSuite } from "./ab-adapter";

interface WordChange {
	value: string;
	count?: number;
	added?: boolean;
	removed?: boolean;
}

interface Fixture {
	id: string;
	oldText: string;
	newText: string;
}

function makeFixture(id: string, recordCount: number): Fixture {
	const oldLines = Array.from(
		{ length: recordCount },
		(_, index) =>
			`record ${index.toString().padStart(4, "0")} keeps alpha amber gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon`,
	);
	const newLines = oldLines.map((line, index) => (index % 31 === 0 ? line.replace("amber", "violet") : line));
	return { id, oldText: oldLines.join("\n"), newText: newLines.join("\n") };
}

const fixtures = [makeFixture("D01", 20), makeFixture("D02", 170), makeFixture("D03", 850)];

function outputBytes(changes: readonly WordChange[]): number {
	return changes.reduce((size, change) => size + Buffer.byteLength(change.value), 0);
}

function assertParity(id: string, actual: readonly WordChange[], expected: readonly WordChange[]): void {
	if (outputBytes(actual) !== outputBytes(expected) || actual.length !== expected.length) {
		throw new Error(`${id}: native and jsdiff word-diff output sizes differ`);
	}
	for (let index = 0; index < actual.length; index++) {
		const nativeChange = actual[index];
		const jsChange = expected[index];
		if (
				nativeChange?.value !== jsChange?.value ||
				nativeChange?.count !== jsChange?.count ||
				nativeChange?.added !== (jsChange?.added ?? false) ||
				nativeChange?.removed !== (jsChange?.removed ?? false)
		) {
			throw new Error(`${id}: native and jsdiff word-diff output differs at change ${index}`);
		}
	}
}

for (const fixture of fixtures) {
	const expected = jsDiffWords(fixture.oldText, fixture.newText);
	const actual = await nativeDiffWords(fixture.oldText, fixture.newText);
	assertParity(fixture.id, actual, expected);
}

await runAbSuite(
	"word-diff",
	fixtures.map(fixture => ({
		id: fixture.id,
		run: () => nativeDiffWords(fixture.oldText, fixture.newText),
	})),
	20,
);
