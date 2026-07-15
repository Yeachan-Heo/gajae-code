import { describe, expect, it } from "bun:test";
import { neutralizeReservedControlTokens, neutralizeResponsesInputControlTokens } from "../src/utils";

// Follow-up to #2144/#2192/#2197. The reserved-control-token sanitizer only
// neutralized simple `<|ident|>` markers, so a leaked *header-form* Harmony
// marker whose body contains a space / `=` / `.` (e.g. `<|assistant to=functions.bash|>`)
// survived replay and kept the gpt-5.6 / Codex endpoint rejecting every turn with
// `Request blocked (code=invalid_prompt)`, permanently wedging the session.
const HEADER_FORM = "<|assistant to=functions.bash|>";

function hasRawControlToken(text: string): boolean {
	return text.includes("<|");
}

describe("neutralizeReservedControlTokens header-form markers", () => {
	it("neutralizes a leaked role-header marker with spaces/=/. in the body", () => {
		const out = neutralizeReservedControlTokens(`before ${HEADER_FORM} after`);
		expect(hasRawControlToken(out)).toBe(false);
		expect(out).toContain("<\u200b|assistant to=functions.bash|>");
	});

	it("still neutralizes simple markers and mixed dumps", () => {
		const dump = "Not blocked.<|assistant to=functions.bash|>run<|channel|>analysis<|end|>";
		const out = neutralizeReservedControlTokens(dump);
		expect(hasRawControlToken(out)).toBe(false);
	});

	it("is idempotent: already-neutralized text is left unchanged", () => {
		const once = neutralizeReservedControlTokens(`x ${HEADER_FORM} y`);
		const twice = neutralizeReservedControlTokens(once);
		expect(twice).toBe(once);
	});

	it("neutralizes header-form markers nested anywhere in the responses input", () => {
		const input = [
			{
				type: "message",
				role: "assistant",
				content: [{ type: "output_text", text: `plan ${HEADER_FORM}` }],
			},
			{ type: "function_call_output", output: `tool said ${HEADER_FORM}` },
		];
		const out = neutralizeResponsesInputControlTokens(input);
		expect(hasRawControlToken(JSON.stringify(out))).toBe(false);
	});

	it("does not touch ordinary text without control-token markers", () => {
		const plain = "a < b and c > d, ratio a|b";
		expect(neutralizeReservedControlTokens(plain)).toBe(plain);
	});
});
