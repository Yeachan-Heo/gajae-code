import { describe, expect, it } from "bun:test";
import { encodeGajaePetGif } from "@gajae-code/tui";
import {
	encodeITerm2Multipart,
	ImageProtocol,
	Iterm2CapabilitiesParser,
	renderImage,
	TERMINAL,
	wrapITerm2RecordForTmux,
} from "@gajae-code/tui/terminal-capabilities";

type MutableTerminalInfo = {
	imageProtocol: ImageProtocol | null;
};

const terminal = TERMINAL as unknown as MutableTerminalInfo;

describe("iTerm2 multipart protocol", () => {
	it("emits exact file, 200-character parts, and end records", () => {
		const data = "ABCD".repeat(151);
		const records = encodeITerm2Multipart(data, { width: 80, height: "auto" });
		expect(records[0]).toBe(
			"\x1b]1337;MultipartFile=;name=Z2FqYWUtcGV0LmdpZg==;size=453;width=80;height=auto;inline=1;preserveAspectRatio=0:\x07",
		);
		expect(records.at(-1)).toBe("\x1b]1337;FileEnd\x07");
		const parts = records.slice(1, -1).map(record => record.slice("\x1b]1337;FilePart=".length, -1));
		expect(parts.map(part => part.length)).toEqual([200, 200, 200, 4]);
		expect(parts.join("")).toBe(data);
	});
	it("uses explicit pixel units for generated Gajae GIF dimensions", () => {
		const artifact = encodeGajaePetGif({ rectangle: { width: 7, height: 5 } });
		const header = artifact.multipart[0];
		expect(header).toContain(";width=7px;height=5px;");
		expect(header).not.toMatch(/;(?:width|height)=\d+(?:;|:)/u);
		expect([artifact.width, artifact.height]).toEqual([7, 5]);
	});
	it("can present a high-resolution GIF in terminal-cell units", () => {
		const artifact = encodeGajaePetGif({
			rectangle: { width: 36, height: 36 },
			displaySize: { width: 4, height: 2 },
		});
		expect(artifact.multipart[0]).toContain(";width=4;height=2;");
		expect([artifact.width, artifact.height]).toEqual([36, 36]);
	});
	it("recognizes ordinary renderImage sequences without text terminators", () => {
		const previousProtocol = terminal.imageProtocol;
		terminal.imageProtocol = ImageProtocol.Iterm2;
		try {
			const rendered = renderImage("AA==", { widthPx: 1, heightPx: 1 });
			expect(rendered).not.toBeNull();
			const sequence = rendered?.sequence ?? "";
			expect(sequence).toMatch(/^\x1b\]1337;File=/u);
			expect(TERMINAL.isImageLine(sequence)).toBe(true);
			expect(sequence.endsWith("\x07")).toBe(true);
			expect(sequence.endsWith("\x1b[K")).toBe(false);
			expect(TERMINAL.isImageLine("\x1b]1337;MultipartFile=;name=pet;size=1;width=1;height=1;inline=1:\x07")).toBe(
				true,
			);
		} finally {
			terminal.imageProtocol = previousProtocol;
		}
	});
	it("wraps every complete multipart record independently under tmux byte limits", () => {
		const records = encodeITerm2Multipart("A".repeat(400), { width: 1, height: 1 });
		const wrapped = records.map(wrapITerm2RecordForTmux);
		expect(wrapped).toHaveLength(4);
		expect(wrapped.every(record => Buffer.byteLength(record) <= 256)).toBe(true);
		expect(wrapped.map(record => record.slice(0, 7))).toEqual([
			"\x1bPtmux;",
			"\x1bPtmux;",
			"\x1bPtmux;",
			"\x1bPtmux;",
		]);
		expect(wrapped.map(record => record.endsWith("\x1b\\"))).toEqual([true, true, true, true]);
		expect(wrapped.map(record => record.includes("\x1b\x1b"))).toEqual([true, true, true, true]);
	});

	it("rejects malformed base64", () => {
		expect(() => encodeITerm2Multipart("not base64!")).toThrow("Invalid RFC 4648 base64");
		expect(() => encodeITerm2Multipart("abc")).toThrow("Invalid RFC 4648 base64");
	});

	it("doubles ESC for tmux and keeps wrapped records within the limit", () => {
		const record = `\x1b]1337;FilePart=${"A".repeat(180)}\x07`;
		const wrapped = wrapITerm2RecordForTmux(record);
		expect(wrapped).toBe(`\x1bPtmux;${record.replaceAll("\x1b", "\x1b\x1b")}\x1b\\`);
		expect(Buffer.byteLength(wrapped)).toBeLessThanOrEqual(256);
		expect(() => wrapITerm2RecordForTmux("x".repeat(257))).toThrow("iTerm2 record exceeds tmux limit");
		expect(() => wrapITerm2RecordForTmux(`${"x".repeat(249)}\x1b`)).toThrow("iTerm2 record exceeds tmux limit");
	});
});

describe("iTerm2 capability parser", () => {
	it("coalesces incremental BEL and ST records, including Uint8Array fragments", () => {
		const parser = new Iterm2CapabilitiesParser();
		expect(parser.push("noise\x1b]1337;Capabilities=foo=bar;baz=qux")).toEqual([]);
		expect(parser.push("\x07\x1b]1337;Capabilities=one=1")).toEqual([
			{ key: "foo", value: "bar" },
			{ key: "baz", value: "qux" },
		]);
		expect(parser.push(new TextEncoder().encode("\x1b\\\x1b]1337;Capabilities=two=2\x07"))).toEqual([
			{ key: "one", value: "1" },
			{ key: "two", value: "2" },
		]);
	});

	it("preserves standalone capability codes across fragmented records", () => {
		const parser = new Iterm2CapabilitiesParser();
		expect(parser.push("\x1b]1337;Capabilities=fi")).toEqual([]);
		expect(parser.push("le=1;F")).toEqual([]);
		expect(parser.push("\x07")).toEqual([
			{ key: "file", value: "1" },
			{ key: "F", value: "" },
		]);
	});

	it("ignores malformed pairs and recovers from oversize records", () => {
		const parser = new Iterm2CapabilitiesParser();
		expect(parser.push("\x1b]1337;Capabilities=bad;=empty;ok=yes\x07")).toEqual([
			{ key: "bad", value: "" },
			{ key: "ok", value: "yes" },
		]);
		expect(parser.push(`\x1b]1337;Capabilities=${"x".repeat(4098)}\x07\x1b]1337;Capabilities=valid=yes\x07`)).toEqual(
			[{ key: "valid", value: "yes" }],
		);
	});

	it("does not treat standalone ESC as an ST terminator", () => {
		const parser = new Iterm2CapabilitiesParser();
		expect(parser.push("\x1b]1337;Capabilities=a=1\x1b")).toEqual([]);
		expect(parser.push("\\")).toEqual([{ key: "a", value: "1" }]);
	});
});
