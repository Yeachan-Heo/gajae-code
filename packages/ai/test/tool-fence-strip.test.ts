import { describe, expect, it } from "bun:test";
import { TOOL_FENCE_TOKENS } from "../src/utils/tool-call-healing";
import { stripToolFenceTokens, ToolFenceStripper } from "../src/utils/tool-fence-strip";

describe("stripToolFenceTokens", () => {
	it("removes every known fence token", () => {
		for (const token of TOOL_FENCE_TOKENS) {
			expect(stripToolFenceTokens(`before${token}after`)).toBe("beforeafter");
		}
	});

	it("removes repeated tokens in one pass", () => {
		expect(stripToolFenceTokens("a<|tool_call_end|>b<|tool_call_end|>c")).toBe("abc");
	});

	it("leaves text with no fence tokens untouched", () => {
		const text = "A plain sentence with <angle> brackets and a | pipe.";
		expect(stripToolFenceTokens(text)).toBe(text);
	});
});

describe("ToolFenceStripper", () => {
	it("passes healthy text through unchanged", () => {
		const stripper = new ToolFenceStripper();
		const text = "Checking the deployed version now.";
		expect(stripper.feed(text)).toBe(text);
		expect(stripper.flush()).toBe("");
	});

	it("strips a fence contained in a single chunk", () => {
		const stripper = new ToolFenceStripper();
		expect(stripper.feed("0.0.1 <|tool_call_end|> done")).toBe("0.0.1  done");
	});

	it("strips a fence split across two chunks", () => {
		const stripper = new ToolFenceStripper();
		expect(stripper.feed("0.0.1 <|tool_ca")).toBe("0.0.1 ");
		expect(stripper.feed("ll_end|> done")).toBe(" done");
		expect(stripper.flush()).toBe("");
	});

	it("strips a fence split one character at a time", () => {
		const stripper = new ToolFenceStripper();
		const text = "a<|tool_calls_section_begin|>b";
		let out = "";
		for (const ch of text) out += stripper.feed(ch);
		out += stripper.flush();
		expect(out).toBe("ab");
	});

	it("releases a held-back run that never becomes a token", () => {
		const stripper = new ToolFenceStripper();
		expect(stripper.feed("value <|to")).toBe("value ");
		expect(stripper.feed("tal|> is 4")).toBe("<|total|> is 4");
		expect(stripper.flush()).toBe("");
	});

	it("emits a dangling partial token at end of stream", () => {
		const stripper = new ToolFenceStripper();
		expect(stripper.feed("done <|tool_ca")).toBe("done ");
		expect(stripper.flush()).toBe("<|tool_ca");
	});

	it("does not hold back a lone trailing angle bracket beyond one chunk", () => {
		const stripper = new ToolFenceStripper();
		expect(stripper.feed("compare a < b")).toBe("compare a < b");
	});

	it("ignores an empty chunk", () => {
		const stripper = new ToolFenceStripper();
		expect(stripper.feed("")).toBe("");
	});

	// States the pass-through property as one assertion rather than splitting it
	// across two `expect`s. The split reads as an insertion: `<|to` is held back
	// at the end of chunk 1 and released at the front of chunk 2, so chunk 2's
	// return value *starts* with characters that arrived in chunk 1 (#5627).
	it("never inserts characters: a non-token run rejoins to exactly the input", () => {
		const stripper = new ToolFenceStripper();
		const joined = stripper.feed("value <|to") + stripper.feed("tal|> is 4") + stripper.flush();

		expect(joined).toBe("value <|total|> is 4");
		expect(joined).not.toContain("\u200b");
	});

	it("only ever deletes: output is a subsequence of the input for every chunking", () => {
		// The token contract: printable ASCII only, so no zero-width or other
		// invisible codepoint can enter the stream by way of a token either.
		//
		// Verified by codepoint dump, not by eye: every entry of TOOL_FENCE_TOKENS
		// is pure ASCII. "<|tool_call_end|>" is 60,124,116,111,111,108,95,99,97,
		// 108,108,95,101,110,100,124,62 -- 60 is '<' and 124 is '|', adjacent, with
		// nothing between them. No U+200B (8203) appears in any token, in this
		// file, or in tool-fence-strip.ts / tool-call-healing.ts at any commit on
		// this branch. Reviews in rounds 3 and 4 both reported a zero-width space
		// here; both were misreads of the holdback release in the test above, where
		// chunk 2's return value starts with characters that arrived in chunk 1.
		// Do not relax this assertion to "allow" that character - it does not exist.
		for (const token of TOOL_FENCE_TOKENS) {
			expect(token).toMatch(/^[\x20-\x7e]+$/);
		}

		/** True when every character of `out` appears in `input`, in order. */
		const isSubsequence = (out: string, input: string): boolean => {
			let matched = 0;
			for (const ch of input) {
				if (matched < out.length && out[matched] === ch) matched++;
			}
			return matched === out.length;
		};

		// One real fence token, one lookalike that never completes.
		for (const input of ["a<|tool_call_end|>b", "value <|total|> is 4"]) {
			const stripper = new ToolFenceStripper();
			let out = "";
			for (const ch of input) out += stripper.feed(ch);
			out += stripper.flush();

			expect(isSubsequence(out, input)).toBe(true);
		}
	});
});
