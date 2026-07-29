import { describe, expect, it } from "bun:test";
import { isCompleteJson, parseJsonWithRepair, parseStreamingJson, repairJson } from "@gajae-code/ai/utils/json-parse";

describe("JSON repair", () => {
	it("leaves valid string escapes unchanged", () => {
		const json = String.raw`{"text":"quote: \" unicode: \u2028 slash: \/ newline: \n"}`;

		expect(repairJson(json)).toBe(json);
		const expectedText = ['quote: " unicode: ', String.fromCharCode(0x2028), " slash: / newline: \n"].join("");
		expect(parseJsonWithRepair<{ text: string }>(json)).toEqual({ text: expectedText });
	});

	it("escapes raw control characters inside string literals", () => {
		const json = '{"text":"a\nb\u0001c"}';

		expect(repairJson(json)).toBe(String.raw`{"text":"a\nb\u0001c"}`);
		expect(parseJsonWithRepair<{ text: string }>(json)).toEqual({ text: "a\nb\u0001c" });
	});

	it("preserves invalid simple escapes as literal backslashes", () => {
		const json = String.raw`{"value":"a\qb"}`;

		expect(repairJson(json)).toBe(String.raw`{"value":"a\\qb"}`);
		expect(parseJsonWithRepair<{ value: string }>(json)).toEqual({ value: String.raw`a\qb` });
	});
	it("returns an empty object for whitespace-only streaming JSON", () => {
		expect(parseStreamingJson<Record<string, unknown>>(" \t\n\r")).toEqual({});
	});
});

describe("isCompleteJson", () => {
	it("treats empty and whitespace-only inputs as complete", () => {
		expect(isCompleteJson("")).toBe(true);
		expect(isCompleteJson("   ")).toBe(true);
		expect(isCompleteJson(undefined)).toBe(true);
	});

	it("accepts complete JSON", () => {
		expect(isCompleteJson('{"a":1}')).toBe(true);
		expect(isCompleteJson("[1,2,3]")).toBe(true);
		expect(isCompleteJson('"str"')).toBe(true);
	});

	it("rejects truncated JSON", () => {
		expect(isCompleteJson('{"a":1')).toBe(false);
		expect(isCompleteJson('{"path":"/etc/hosts","content":"line1')).toBe(false);
		expect(isCompleteJson("[1,2,")).toBe(false);
	});
});
