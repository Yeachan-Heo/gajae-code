import { describe, expect, test } from "bun:test";
import { validateDisplayLine } from "../src/modes/components/ansi-display-validator";

describe("validateDisplayLine", () => {
	test("preserves only numeric SGR styling", () => {
		const sgr = "\x1b[1;31mred\x1b[0m";
		expect(validateDisplayLine(sgr)).toBe(sgr);
	});

	test.each([
		"\x1b[38;5;;m",
		"\x1b[;31m",
		"\x1b[31;m",
		"\x1b[999999999m",
		`\x1b[${"1;".repeat(32)}1m`,
	])("rejects malformed or oversized SGR parameters: %p", fixture =>
		expect(validateDisplayLine(`safe${fixture}text`)).toBe("safetext"));

	test.each([
		"\x1b]52;c;copy\x07",
		"\x1b]8;;https://example.test\x1b\\text\x1b]8;;\x1b\\",
		"\x1b]8;;https://example.test",
		"\x1b]1337;File=name=x\x07",
		"\x1bPpayload\x1b\\",
		"\x1b_payload\x1b\\",
		"\x1b^payload\x1b\\",
		"\x1bXpayload\x1b\\",
		"\x1b_Gf=100,a=T;payload\x1b\\",
		"\x1bPqSIXEL\x1b\\",
		"\x1b[2Jcursor\x1b[H\x1b[10A",
		"\x00\x01\x1f\x7f\x80\x9f",
	])("removes hostile terminal control data: %p", fixture => {
		const rendered = validateDisplayLine(`safe${fixture}text`);
		expect(rendered).not.toContain("\x1b");
		expect(rendered).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
	});
});
