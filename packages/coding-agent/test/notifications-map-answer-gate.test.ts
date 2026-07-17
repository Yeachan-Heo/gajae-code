import { describe, expect, test } from "bun:test";
import { mapAnswerToGate } from "../src/sdk/bus";

const options = ["alpha", "beta", "gamma"];

describe("mapAnswerToGate discriminated result (issue #2030)", () => {
	test("in-range numeric index (zero) selects the first option", () => {
		expect(mapAnswerToGate("0", options)).toEqual({ ok: true, answer: { selected: ["alpha"] } });
	});

	test("in-range numeric index at the upper bound selects the last option", () => {
		expect(mapAnswerToGate(String(options.length - 1), options)).toEqual({
			ok: true,
			answer: { selected: ["gamma"] },
		});
	});

	test("out-of-range numeric index (99) is invalid, never free-text Other", () => {
		expect(mapAnswerToGate("99", options)).toEqual({ ok: false, reason: "numeric_selector_out_of_range" });
	});

	test("numeric index equal to options.length (just past the bound) is invalid", () => {
		expect(mapAnswerToGate(String(options.length), options)).toEqual({
			ok: false,
			reason: "numeric_selector_out_of_range",
		});
	});

	test("negative numeric index is invalid", () => {
		expect(mapAnswerToGate("-1", options)).toEqual({ ok: false, reason: "numeric_selector_out_of_range" });
	});

	test("any numeric index against empty options is invalid", () => {
		expect(mapAnswerToGate("0", [])).toEqual({ ok: false, reason: "numeric_selector_out_of_range" });
	});

	test("JSON string matching an option selects it", () => {
		expect(mapAnswerToGate(JSON.stringify("beta"), options)).toEqual({
			ok: true,
			answer: { selected: ["beta"] },
		});
	});

	test("JSON string outside options preserves the free-text/Other path", () => {
		expect(mapAnswerToGate(JSON.stringify("something else"), options)).toEqual({
			ok: true,
			answer: { selected: [], other: true, custom: "something else" },
		});
	});

	test("numeric-looking JSON string is free text, not an out-of-range index", () => {
		expect(mapAnswerToGate(JSON.stringify("99"), options)).toEqual({
			ok: true,
			answer: { selected: [], other: true, custom: "99" },
		});
	});

	test("non-JSON payload is treated as a free-text string, not a number", () => {
		expect(mapAnswerToGate("not json", options)).toEqual({
			ok: true,
			answer: { selected: [], other: true, custom: "not json" },
		});
	});

	test("structured object with selected indices maps to labels", () => {
		expect(mapAnswerToGate(JSON.stringify({ selected: [0, 2] }), options)).toEqual({
			ok: true,
			answer: { selected: ["alpha", "gamma"], other: false, custom: undefined },
		});
	});

	test("structured object with custom text keeps the Other path", () => {
		expect(mapAnswerToGate(JSON.stringify({ selected: [], custom: "typed" }), options)).toEqual({
			ok: true,
			answer: { selected: [], other: true, custom: "typed" },
		});
	});

	test("empty object yields an empty (valid) selection", () => {
		expect(mapAnswerToGate(JSON.stringify({}), options)).toEqual({
			ok: true,
			answer: { selected: [], other: false, custom: undefined },
		});
	});
});
