import { describe, expect, it } from "bun:test";
import { BracketedPasteHandler } from "@gajae-code/tui/bracketed-paste";

describe("BracketedPasteHandler", () => {
	it("keeps normal prefix outside paste when the start marker is split before tilde", () => {
		const handler = new BracketedPasteHandler();

		const first = handler.process("prefix\x1b[200");
		const second = handler.process("~payload\x1b[201~");

		expect(first).toEqual({ handled: true, normalText: "prefix", remaining: "" });
		expect(second).toEqual({ handled: true, pasteContent: "payload", remaining: "" });
	});

	it("keeps normal prefix outside paste when a complete start marker shares the first chunk", () => {
		const handler = new BracketedPasteHandler();

		const first = handler.process("prefix\x1b[200~pay");
		const second = handler.process("load\x1b[201~");

		expect(first).toEqual({ handled: true, normalText: "prefix", remaining: "" });
		expect(second).toEqual({ handled: true, pasteContent: "payload", remaining: "" });
	});

	it("replays false partial start markers as normal text", () => {
		const handler = new BracketedPasteHandler();

		const first = handler.process("prefix\x1b[20");
		const second = handler.process("x");

		expect(first).toEqual({ handled: true, normalText: "prefix", remaining: "" });
		expect(second).toEqual({ handled: true, normalText: "\x1b[20x", remaining: "" });
	});

	it("does not hold a standalone escape key as a partial paste marker", () => {
		const handler = new BracketedPasteHandler();

		expect(handler.process("\x1b")).toEqual({ handled: false });
	});
});
