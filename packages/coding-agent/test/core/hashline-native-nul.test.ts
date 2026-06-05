import { expect, test } from "bun:test";
import { h06FormatHashLines } from "../../../natives/native/index.js";
import { formatHashLine } from "../../src/hashline/hash";

function tsFormat(text: string, startLine = 1): string {
	return text
		.split("\n")
		.map((l, i) => formatHashLine(startLine + i, l))
		.join("\n");
}
const cases: [string, string][] = [
	["trailing-NUL", "a\u0000"],
	["NUL-midline", "x\u0000y\nz"],
	["only-NUL", "\u0000"],
	["NUL-then-LF", "a\u0000\nb"],
	["multi-trailing-NUL", "a\u0000\u0000"],
];
for (const [name, text] of cases) {
	test(`byte-identical: ${name}`, () => {
		expect(h06FormatHashLines(text, 1)).toBe(tsFormat(text, 1));
	});
}
test("startLine 0 native==TS", () => {
	expect(h06FormatHashLines("a\nb", 0)).toBe(tsFormat("a\nb", 0));
});
