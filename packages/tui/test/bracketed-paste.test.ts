import { describe, expect, it } from "bun:test";
import { BracketedPasteHandler } from "../src/bracketed-paste";

describe("BracketedPasteHandler", () => {
	it("assembles a paste when the start marker arrives in one chunk", () => {
		const handler = new BracketedPasteHandler();

		expect(handler.process("\x1b[200~hello\x1b[201~")).toEqual({
			handled: true,
			pasteContent: "hello",
			remaining: "",
		});
	});
	it("does not treat a standalone Escape key as a pending paste", () => {
		const handler = new BracketedPasteHandler();

		expect(handler.process("\x1b")).toEqual({ handled: false });
	});

	it("buffers a split start marker before collecting paste content", () => {
		const handler = new BracketedPasteHandler();

		expect(handler.process("\x1b[200")).toEqual({ handled: true, remaining: "" });
		expect(handler.process("~hello\x1b[201~")).toEqual({
			handled: true,
			pasteContent: "hello",
			remaining: "",
		});
	});

	it("keeps normal text before a split start marker replayable", () => {
		const handler = new BracketedPasteHandler();

		expect(handler.process("prefix\x1b[200")).toEqual({
			handled: true,
			normalText: "prefix",
			remaining: "",
		});
		expect(handler.process("~payload\x1b[201~suffix")).toEqual({
			handled: true,
			pasteContent: "payload",
			remaining: "suffix",
		});
	});

	it("keeps split end marker buffering intact", () => {
		const handler = new BracketedPasteHandler();

		expect(handler.process("\x1b[200~hello\x1b[201")).toEqual({ handled: true, remaining: "" });
		expect(handler.process("~tail")).toEqual({
			handled: true,
			pasteContent: "hello",
			remaining: "tail",
		});
	});
});
