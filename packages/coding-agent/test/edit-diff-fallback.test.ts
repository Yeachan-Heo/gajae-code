import { afterEach, describe, expect, test } from "bun:test";
import {
	__clearDiffLinesForTest,
	__getNativeDiffLinesForTest,
	__setDiffLinesForTest,
	generateDiffString,
} from "../src/edit/diff";

const cases = [
	{
		name: "unicode",
		oldContent: "hello\ncafe\nemoji 😀\n",
		newContent: "hello\ncafé\nemoji 😎\n",
	},
	{
		name: "lf trailing newline",
		oldContent: "one\ntwo\nthree\n",
		newContent: "one\n2\nthree\n",
	},
	{
		name: "lf no trailing newline",
		oldContent: "one\ntwo\nthree",
		newContent: "one\n2\nthree",
	},
	{
		name: "crlf trailing newline",
		oldContent: "one\r\ntwo\r\nthree\r\n",
		newContent: "one\r\n2\r\nthree\r\n",
	},
	{
		name: "crlf no trailing newline",
		oldContent: "one\r\ntwo\r\nthree",
		newContent: "one\r\n2\r\nthree",
	},
	{
		name: "cr-only trailing newline",
		oldContent: "one\rtwo\rthree\r",
		newContent: "one\r2\rthree\r",
	},
	{
		name: "cr-only no trailing newline",
		oldContent: "one\rtwo\rthree",
		newContent: "one\r2\rthree",
	},
	{
		name: "adjacent insert and remove blocks",
		oldContent: "alpha\nremove-a\nremove-b\nshared\nomega\n",
		newContent: "alpha\nadd-a\nadd-b\nshared\nomega\n",
	},
];

describe("generateDiffString native diff fallback", () => {
	afterEach(() => {
		__clearDiffLinesForTest();
	});

	for (const item of cases) {
		test(`uses JS fallback when native diff export is missing: ${item.name}`, () => {
			__setDiffLinesForTest(null);
			const fallback = generateDiffString(item.oldContent, item.newContent);

			__clearDiffLinesForTest();
			const resolvedResult = generateDiffString(item.oldContent, item.newContent);

			expect(fallback).toEqual(resolvedResult);
		});

		test(`uses JS fallback when native diff export throws: ${item.name}`, () => {
			__setDiffLinesForTest(() => {
				throw new Error("native diff failed");
			});
			const fallback = generateDiffString(item.oldContent, item.newContent);

			__clearDiffLinesForTest();
			const resolvedResult = generateDiffString(item.oldContent, item.newContent);

			expect(fallback).toEqual(resolvedResult);
		});
	}

	test("matches native diff output when the native export is available", () => {
		__clearDiffLinesForTest();
		const nativeDiffLines = __getNativeDiffLinesForTest();
		if (!nativeDiffLines) {
			return;
		}

		for (const item of cases) {
			__setDiffLinesForTest(nativeDiffLines);
			const nativeResult = generateDiffString(item.oldContent, item.newContent);

			__setDiffLinesForTest(null);
			const fallbackResult = generateDiffString(item.oldContent, item.newContent);

			expect(fallbackResult).toEqual(nativeResult);
		}
	});
});
