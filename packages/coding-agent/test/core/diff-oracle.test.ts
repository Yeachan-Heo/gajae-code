import { beforeAll, describe, expect, test } from "bun:test";
import * as Diff from "diff";
import { generateDiffString, generateUnifiedDiffString } from "../../src/edit/diff";
import { renderDiff } from "../../src/modes/components/diff";
import { initTheme } from "../../src/modes/theme/theme";

const fixtures = [
	{
		name: "single-line word change",
		oldText: "alpha beta gamma\nunchanged\n",
		newText: "alpha delta gamma\nunchanged\n",
	},
	{
		name: "insert delete with context collapse",
		oldText: Array.from({ length: 18 }, (_, i) => `line ${i + 1}`).join("\n"),
		newText: Array.from({ length: 18 }, (_, i) =>
			i === 2 ? "line THREE" : i === 14 ? "line FIFTEEN" : `line ${i + 1}`,
		).join("\n"),
	},
	{
		name: "CRLF unicode and tabs",
		oldText: "\talpha — beta\r\nemoji 😀 old\r\ncombining cafe\u0301\r\n",
		newText: "\talpha – beta\r\nemoji 😀 new\r\ncombining café\r\nadded\r\n",
	},
	{
		name: "blank and no final newline",
		oldText: "alpha\n\n beta  \nlast",
		newText: "alpha\nblank\n beta\t\nlast\nEOF",
	},
];

beforeAll(async () => {
	Bun.env.COLORTERM = "truecolor";
	await initTheme();
});

function oracle(oldText: string, newText: string) {
	const generated = generateDiffString(oldText, newText, 2);
	const unified = generateUnifiedDiffString(oldText, newText, 2);
	return {
		diffLines: Diff.diffLines(oldText, newText),
		structuredPatch: Diff.structuredPatch("old.txt", "new.txt", oldText, newText, "old", "new", { context: 2 }),
		diffWords: Diff.diffWords(oldText, newText),
		generateDiffString: generated,
		generateUnifiedDiffString: unified,
		renderedGenerateDiffString: renderDiff(generated.diff, { filePath: "fixture.ts" }),
		renderedUnifiedDiffString: renderDiff(unified.diff, { filePath: "fixture.ts" }),
	};
}

describe("diff oracle snapshots", () => {
	for (const fixture of fixtures) {
		test(fixture.name, () => {
			expect(oracle(fixture.oldText, fixture.newText)).toMatchSnapshot();
		});
	}
});
