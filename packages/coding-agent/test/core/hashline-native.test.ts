import { describe, expect, it } from "bun:test";
import { formatHashLine } from "@gajae-code/coding-agent/hashline/hash";
import { h06FormatHashLines } from "../../../natives/native/index.js";

function formatHashLinesTs(text: string, startLine = 1): string {
	const lines = text.split("\n");
	return lines.map((line, i) => formatHashLine(startLine + i, line)).join("\n");
}

describe("native hashline formatting", () => {
	it("matches the TypeScript formatter across byte-identical edge cases", () => {
		const cases = [
			{ text: "", startLine: 1 },
			{ text: "alpha\nbeta\ngamma", startLine: 37 },
			{ text: "alpha\r\nbeta\r\ngamma\r", startLine: 7 },
			{ text: "embedded\rcarriage\rreturn\nkeeps\rdisplay", startLine: 3 },
			{ text: "space \t\u00a0\u1680\u2000\u200a\u2028\u2029\u202f\u205f\u3000\ufeff\nzwsp\u200b", startLine: 11 },
			{ text: "emoji 👩‍💻 😀\ncombining e\u0301 café", startLine: 99 },
			{ text: "lone high \ud800\nlone low \udc00\npair \ud83d\ude00", startLine: 1234 },
			{ text: `${"x".repeat(4096)} trailing   \n${"z".repeat(8192)}\u00a0`, startLine: 42 },
			{ text: "final newline\n", startLine: 5 },
		];

		for (const { text, startLine } of cases) {
			expect(h06FormatHashLines(text, startLine)).toBe(formatHashLinesTs(text, startLine));
		}
	});
});
