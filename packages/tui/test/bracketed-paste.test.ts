import { describe, expect, it } from "bun:test";
import { BRACKETED_PASTE_FRAME_TIMEOUT_MS, BracketedPasteHandler } from "../src/bracketed-paste";

describe("BracketedPasteHandler", () => {
	it("leaves ordinary input unhandled", () => {
		expect(new BracketedPasteHandler().process("hello")).toEqual({ handled: false });
	});

	it("retains leading input when the start marker is split across chunks", () => {
		const handler = new BracketedPasteHandler();
		expect(handler.process("!echo before\n\x1b[20")).toEqual({ handled: true, leading: "", remaining: "" });
		expect(handler.process("0~/tmp/one.png /tmp/two.png\x1b[201~after")).toEqual({
			handled: true,
			leading: "!echo before\n",
			pasteContent: "/tmp/one.png /tmp/two.png",
			remaining: "after",
		});
	});

	it("retains a split end marker without changing paste bytes", () => {
		const handler = new BracketedPasteHandler();
		expect(handler.process("\x1b[200~화면 기록\x1b[20")).toEqual({ handled: true, leading: "", remaining: "" });
		expect(handler.process("1~tail")).toEqual({
			handled: true,
			leading: "",
			pasteContent: "화면 기록",
			remaining: "tail",
		});
	});

	it("returns coalesced input before the first marker separately", () => {
		const handler = new BracketedPasteHandler();
		expect(handler.process("\r\x1b[200~pasted\x1b[201~")).toEqual({
			handled: true,
			leading: "\r",
			pasteContent: "pasted",
			remaining: "",
		});
	});

	it("releases a false partial marker as ordinary leading input", () => {
		const handler = new BracketedPasteHandler();
		expect(handler.process("abc\x1b[2")).toEqual({ handled: true, leading: "", remaining: "" });
		expect(handler.process("x")).toEqual({ handled: true, leading: "abc\x1b[2x", remaining: "" });
	});

	it("releases a false split prefix beginning at byte zero", () => {
		const handler = new BracketedPasteHandler();
		expect(handler.process("\x1b[2")).toEqual({ handled: true, leading: "", remaining: "" });
		expect(handler.process("x")).toEqual({ handled: true, leading: "\x1b[2x", remaining: "" });
	});

	it("flushes a stale incomplete paste as paste content before later input", () => {
		const handler = new BracketedPasteHandler();
		expect(handler.process("\x1b[200~unfinished", 0)).toEqual({ handled: true, leading: "", remaining: "" });
		expect(handler.process("next", BRACKETED_PASTE_FRAME_TIMEOUT_MS)).toEqual({
			handled: true,
			leading: "",
			pasteContent: "unfinished",
			remaining: "next",
		});
	});

	it("leaves subsequent framed pastes in remaining for ordered reprocessing", () => {
		const handler = new BracketedPasteHandler();
		expect(handler.process("\x1b[200~one\x1b[201~\x1b[200~two\x1b[201~")).toEqual({
			handled: true,
			leading: "",
			pasteContent: "one",
			remaining: "\x1b[200~two\x1b[201~",
		});
	});

	it("keeps buffering a slow multi-chunk paste when idle gaps stay under the timeout", () => {
		const handler = new BracketedPasteHandler();
		let now = 1_000_000;
		expect(handler.process("\x1b[200~line1\n", now)).toEqual({ handled: true, leading: "", remaining: "" });

		// Stream for >1s total with small idle gaps (old wall-clock timer would truncate).
		for (let i = 0; i < 30; i++) {
			now += 100;
			expect(handler.process(`chunk-${i}\n`, now)).toEqual({ handled: true, leading: "", remaining: "" });
		}

		expect(handler.process("\x1b[201~", now + 10)).toEqual({
			handled: true,
			leading: "",
			pasteContent: `line1\n${Array.from({ length: 30 }, (_, i) => `chunk-${i}\n`).join("")}`,
			remaining: "",
		});
	});

	it("refreshes the idle timer so a 1.1s gap after recent chunks does not flush early", () => {
		const handler = new BracketedPasteHandler();
		const t0 = 2_000_000;
		expect(handler.process("\x1b[200~a", t0)).toEqual({ handled: true, leading: "", remaining: "" });
		expect(handler.process("b", t0 + 1_100)).toEqual({ handled: true, leading: "", remaining: "" });
		expect(handler.process("\x1b[201~", t0 + 1_200)).toEqual({
			handled: true,
			leading: "",
			pasteContent: "ab",
			remaining: "",
		});
	});

	it("still flushes when no chunk arrives for the full idle timeout", () => {
		const handler = new BracketedPasteHandler();
		expect(handler.process("\x1b[200~partial", 0)).toEqual({ handled: true, leading: "", remaining: "" });
		expect(handler.process("more", BRACKETED_PASTE_FRAME_TIMEOUT_MS + 1)).toEqual({
			handled: true,
			leading: "",
			pasteContent: "partial",
			remaining: "more",
		});
	});
});
