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
});
