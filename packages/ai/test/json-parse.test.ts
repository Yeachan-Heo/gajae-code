import { describe, expect, it } from "bun:test";
import {
	captureUnicodeEscapeEvidence,
	collectUnicodeEscapeEvidence,
	collectUnsafeUnicodeEscapeEvidence,
	findUnnecessaryUnicodeEscape,
	isCompleteJson,
	parseJsonWithRepair,
	parseStreamingJson,
	repairJson,
	type UnicodeEscapeEvidence,
	unicodeEscapePathTag,
	unicodeEscapeScalarTag,
	verifyUnicodeEscapeEvidence,
} from "@gajae-code/ai/utils/json-parse";

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

describe("findUnnecessaryUnicodeEscape", () => {
	it("flags a printable non-ASCII character spelled as an escape", () => {
		expect(findUnnecessaryUnicodeEscape(String.raw`{"q":"\ubcd1\ubaa9"}`)).toBe(String.raw`\ubcd1`);
		expect(findUnnecessaryUnicodeEscape(String.raw`{"q":"ok \u00e9"}`)).toBe(String.raw`\u00e9`);
	});

	it("flags a completed surrogate pair but not a lone surrogate", () => {
		expect(findUnnecessaryUnicodeEscape(String.raw`{"q":"\ud83d\ude00"}`)).toBe(String.raw`\ud83d\ude00`);
		expect(findUnnecessaryUnicodeEscape(String.raw`{"q":"\ud83d tail"}`)).toBeUndefined();
		expect(findUnnecessaryUnicodeEscape(String.raw`{"q":"\ude00 tail"}`)).toBeUndefined();
	});

	it("ignores literal UTF-8, required control escapes, and DEL", () => {
		expect(findUnnecessaryUnicodeEscape('{"q":"병목 café 😀"}')).toBeUndefined();
		expect(findUnnecessaryUnicodeEscape(String.raw`{"q":"a\u0000b\u001fc"}`)).toBeUndefined();
		expect(findUnnecessaryUnicodeEscape(String.raw`{"q":"a\nb\"c\u007f"}`)).toBeUndefined();
	});

	it("flags printable ASCII escapes because they can be one-nibble mutations of non-ASCII", () => {
		expect(findUnnecessaryUnicodeEscape(String.raw`{"q":"\u0077"}`)).toBe(String.raw`\u0077`);
		expect(findUnnecessaryUnicodeEscape(String.raw`{"q":"\u0026"}`)).toBe(String.raw`\u0026`);
	});

	it("ignores an escaped backslash followed by u — the source syntax of code being written", () => {
		// The model wrote `\uac00` as literal text (e.g. a Python source line), which
		// reaches the wire as `\\uac00` and decodes to a backslash, not a character.
		expect(findUnnecessaryUnicodeEscape(String.raw`{"content":"if c == \\uac00:"}`)).toBeUndefined();
	});

	it("ignores non-ASCII escape-looking text outside string literals", () => {
		expect(findUnnecessaryUnicodeEscape("   ")).toBeUndefined();
		expect(findUnnecessaryUnicodeEscape("")).toBeUndefined();
		expect(findUnnecessaryUnicodeEscape(String.raw`{"q":"\uzz11"}`)).toBeUndefined();
	});

	it("still flags em-dash and every other punctuation/symbol/separator escape — the bounded exemption lives in the agent loop, not the scanner", () => {
		// The scanner stays strictly evidence-based: any non-ASCII escape flags.
		// The display-safe-tool carve-out for benign typographic punctuation is
		// decided at execution time against the DECODED arguments (agent-loop
		// isDisplaySafeEscapedArguments), never by widening this detector.
		expect(findUnnecessaryUnicodeEscape(String.raw`{"q":"sessions \u2014 in-process?"}`)).toBe(String.raw`\u2014`);
		expect(findUnnecessaryUnicodeEscape(String.raw`{"q":"\u201cquoted\u201d"}`)).toBe(String.raw`\u201c`);
		expect(findUnnecessaryUnicodeEscape(String.raw`{"q":"a\u00a0b"}`)).toBe(String.raw`\u00a0`);
		expect(findUnnecessaryUnicodeEscape(String.raw`{"q":"\u20a9"}`)).toBe(String.raw`\u20a9`);
		expect(findUnnecessaryUnicodeEscape(String.raw`{"q":"\uff01"}`)).toBe(String.raw`\uff01`);
	});

	it("does not flag a truncated escape at the end of a streaming buffer", () => {
		expect(findUnnecessaryUnicodeEscape(String.raw`{"q":"\ubc`)).toBeUndefined();
	});

	// Adversarial table: every case is a way the string/escape state machine could
	// be desynchronized into a false accept (corrupted text executes) or a false
	// reject (legitimate work is blocked). `true` = must flag.
	const redteam: ReadonlyArray<readonly [string, string, boolean]> = [
		["escaped quote does not close the string", String.raw`{"a":"say \"hi\" \uc548"}`, true],
		["escaped backslash then a real escape", String.raw`{"a":"\\\uc548"}`, true],
		["two escaped backslashes leave literal text", String.raw`{"a":"\\\\uc548"}`, false],
		["escaped backslash then escaped quote then escape", String.raw`{"a":"\\\"\uc548"}`, true],
		["escape hidden in a key name", String.raw`{"\uc774":1}`, true],
		["escape-looking text outside any string", '{"a":1} \\uc548', false],
		["braces and quotes inside the string body", String.raw`{"a":"} \" { \uc548"}`, true],
		["escape nested in an array element", String.raw`{"a":[{"b":"\uc548"}]}`, true],
		["escaped solidus then escape", String.raw`{"a":"\/\uc548"}`, true],
		["escape in a string the stream never closed", String.raw`{"a":"\uc548`, true],
		["stream cut on a lone trailing backslash", '{"a":"tail\\', false],
		["stream cut mid `\\u`", '{"a":"x\\u', false],
		["stream cut after a high surrogate", '{"a":"\\ud83d', false],
		["high surrogate followed by a literal char", '{"a":"\\ud83d\uac00"}', false],
		["high surrogate followed by a printable ASCII escape", String.raw`{"a":"\ud83d\u0041"}`, true],
		["surrogates in the wrong order", String.raw`{"a":"\ude00\ud83d"}`, false],
		["C1 control is still non-ASCII", String.raw`{"a":"\u0085"}`, true],
		["DEL stays non-printing ASCII", String.raw`{"a":"\u007f"}`, false],
		["U+0080 is the first flagged codepoint", String.raw`{"a":"\u0080"}`, true],
		["uppercase hex digits", String.raw`{"a":"\uBCD1"}`, true],
		["mixed-case hex digits", String.raw`{"a":"\uBcD1"}`, true],
		["printable ASCII escapes retain mutation evidence", String.raw`{"a":"\u0041\u007a\u0020"}`, true],
		["no strings at all", "{}", false],
		["bare numeric value", '{"a":123}', false],
	];

	it.each(redteam)("red team: %s", (_label, json, shouldFlag) => {
		expect(findUnnecessaryUnicodeEscape(json) !== undefined).toBe(shouldFlag);
	});

	it("carries bounded payload-free positions and scalars through nested arrays and objects", () => {
		const evidence = collectUnicodeEscapeEvidence(
			String.raw`{"questions":[{"question":"a\u2014b\u0077"},{"question":"\u2014"}],"meta":{"note":"\u0026"}}`,
		);
		expect(evidence).toMatchObject({
			positions: [
				{
					offset: 28,
					scalarTag: unicodeEscapeScalarTag(0x2014),
					pathTag: unicodeEscapePathTag(["questions", "question"]),
					location: "value",
					valueOrdinal: 0,
					valueOffset: 1,
				},
				{
					offset: 35,
					scalarTag: unicodeEscapeScalarTag(0x77),
					pathTag: unicodeEscapePathTag(["questions", "question"]),
					location: "value",
					valueOrdinal: 0,
					valueOffset: 3,
				},
				{
					offset: 57,
					scalarTag: unicodeEscapeScalarTag(0x2014),
					pathTag: unicodeEscapePathTag(["questions", "question"]),
					location: "value",
					valueOrdinal: 1,
					valueOffset: 0,
				},
				{
					offset: 83,
					scalarTag: unicodeEscapeScalarTag(0x26),
					pathTag: unicodeEscapePathTag(["meta", "note"]),
					location: "value",
					valueOrdinal: 0,
					valueOffset: 0,
				},
			],
			totalPositions: 4,
			truncated: false,
			malformed: false,
		});
		expect(evidence?.integrity).toMatch(/^[0-9a-f]{64}$/);
		expect(evidence && verifyUnicodeEscapeEvidence(evidence)).toBe(true);
		expect(JSON.stringify(evidence)).not.toContain("questions");
		expect(JSON.stringify(evidence)).not.toContain("note");
		expect(JSON.stringify(evidence)).not.toContain("codePoint");
	});

	it("retains duplicate escapes and marks escaped keys as structural", () => {
		const evidence = collectUnicodeEscapeEvidence(String.raw`{"\u006b":"\u2014\u2014"}`);
		expect(
			evidence?.positions.map(position => [position.scalarTag, position.location, position.valueOffset]),
		).toEqual([
			[unicodeEscapeScalarTag(0x6b), "key", 0],
			[unicodeEscapeScalarTag(0x2014), "value", 0],
			[unicodeEscapeScalarTag(0x2014), "value", 1],
		]);
	});

	it("fails closed without carrying partial positions when the raw JSON is malformed", () => {
		expect(collectUnicodeEscapeEvidence(String.raw`{"q":"\u2014"`)).toMatchObject({
			positions: [],
			totalPositions: 0,
			truncated: false,
			malformed: true,
		});
	});

	it.each([
		["Hangul", String.raw`{"q":"\ub9c8\uc9c0\ub9c9 \ubcd1\ubaa9"}`],
		["emoji surrogate pair", String.raw`{"q":"\ud83d\ude00"}`],
		["printable ASCII", String.raw`{"q":"\u0077"}`],
		["valid one-nibble-different scalar", String.raw`{"q":"\ub123"}`],
		["escaped source syntax", String.raw`{"q":"\\u2014"}`],
	])("treats valid JSON escapes as canonical decoded arguments: %s", (_label, raw) => {
		expect(collectUnsafeUnicodeEscapeEvidence(raw)).toBeUndefined();
	});

	it.each([
		["malformed JSON", String.raw`{"q":"\u2014"`],
		["duplicate object member", String.raw`{"q":"\u2014","q":"—"}`],
		["lone high surrogate", String.raw`{"q":"\ud83d"}`],
		["lone low surrogate", String.raw`{"q":"\ude00"}`],
		["literal lone high surrogate", `{"q":"${String.fromCharCode(0xd83d)}"}`],
	])("keeps unsafe Unicode argument data fail-closed: %s", (_label, raw) => {
		expect(collectUnsafeUnicodeEscapeEvidence(raw)).toMatchObject({
			positions: [],
			totalPositions: 0,
			truncated: false,
			malformed: true,
		});
	});

	it("attaches guard metadata only for unsafe Unicode argument data", () => {
		const valid: {
			escapedNonAsciiArguments?: boolean;
			escapedUnicodeArgumentEvidence?: UnicodeEscapeEvidence;
		} = {};
		expect(captureUnicodeEscapeEvidence(valid, String.raw`{"q":"\ub9c8\uc9c0\ub9c9"}`)).toBe(false);
		expect(valid.escapedNonAsciiArguments).toBeUndefined();
		expect(valid.escapedUnicodeArgumentEvidence).toBeUndefined();

		const unsafe: typeof valid = {};
		expect(captureUnicodeEscapeEvidence(unsafe, String.raw`{"q":"\ud83d"}`)).toBe(true);
		expect(unsafe.escapedNonAsciiArguments).toBe(true);
		expect(unsafe.escapedUnicodeArgumentEvidence?.malformed).toBe(true);
	});

	it("keeps dotted keys distinct from nested display paths", () => {
		expect(unicodeEscapePathTag(["questions.question"])).not.toBe(unicodeEscapePathTag(["questions", "question"]));
		const evidence = collectUnicodeEscapeEvidence(String.raw`{"questions.question":"\u2014"}`);
		expect(evidence?.positions[0]?.pathTag).toBe(unicodeEscapePathTag(["questions.question"]));
	});

	it("fails closed on duplicate object members", () => {
		const evidence = collectUnicodeEscapeEvidence(String.raw`{"question":"\u2014","question":"—"}`);
		expect(evidence).toMatchObject({ positions: [], totalPositions: 0, truncated: false, malformed: true });
	});

	it("fails closed before recursive evidence traversal exceeds its depth bound", () => {
		let raw = String.raw`"\u2014"`;
		for (let depth = 0; depth < 66; depth++) raw = `{"nested":${raw}}`;
		expect(collectUnicodeEscapeEvidence(raw)).toMatchObject({ malformed: true });
	});

	it("rejects partial or altered evidence envelopes", () => {
		const evidence = collectUnicodeEscapeEvidence(String.raw`{"question":"\u2014\u2014"}`);
		expect(evidence).toBeDefined();
		if (!evidence) return;
		expect(verifyUnicodeEscapeEvidence({ ...evidence, positions: evidence.positions.slice(0, 1) })).toBe(false);
		expect(verifyUnicodeEscapeEvidence({ ...evidence, totalPositions: 1 })).toBe(false);
	});

	it("bounds retained positions and reports overflow", () => {
		const evidence = collectUnicodeEscapeEvidence(
			JSON.stringify({ q: "—" }).replace("—", String.raw`\u2014`.repeat(40)),
		);
		expect(evidence?.positions).toHaveLength(32);
		expect(evidence?.totalPositions).toBe(40);
		expect(evidence?.truncated).toBe(true);
	});

	it("scans a megabyte of literal UTF-8 without a per-character walk", () => {
		const payload = JSON.stringify({ q: "마지막 병목 ".repeat(120_000) });
		expect(payload.length).toBeGreaterThan(800_000);
		for (let warmup = 0; warmup < 3; warmup++) findUnnecessaryUnicodeEscape(payload);
		const started = performance.now();
		expect(findUnnecessaryUnicodeEscape(payload)).toBeUndefined();
		// The rejected per-character version took ~40ms here; the indexOf jumps make
		// the common (clean, large `write`) payload effectively free.
		expect(performance.now() - started).toBeLessThan(15);
	});
});
