import { describe, expect, it } from "bun:test";
import { extractPrintableText, matchesKey, parseKey, setKittyProtocolActive } from "@gajae-code/tui/keys";

describe("matchesKey", () => {
	it("matches ctrl+letter sequences", () => {
		setKittyProtocolActive(false);
		const ctrlC = String.fromCharCode(3);
		expect(matchesKey(ctrlC, "ctrl+c")).toBe(true);
	});

	it("matches legacy Alt+LF as Alt+Enter", () => {
		setKittyProtocolActive(false);
		expect(matchesKey("\x1b\n", "alt+enter")).toBe(true);
		expect(matchesKey("\x1b\n", "ctrl+alt+j")).toBe(false);
	});

	it("matches shifted tab", () => {
		setKittyProtocolActive(false);
		expect(matchesKey("\x1b[Z", "shift+tab")).toBe(true);
	});

	it("matches pageUp legacy sequence with mixed case keyId", () => {
		setKittyProtocolActive(false);
		expect(matchesKey("\x1b[5~", "pageUp")).toBe(true);
	});

	it("should prefer codepoint for Latin letters even when base layout differs", () => {
		setKittyProtocolActive(true);
		// Dvorak Ctrl+K reports codepoint 'k' (107) and base layout 'v' (118)
		const dvorakCtrlK = "\x1b[107::118;5u";
		expect(matchesKey(dvorakCtrlK, "ctrl+k")).toBe(true);
		expect(matchesKey(dvorakCtrlK, "ctrl+v")).toBe(false);
		setKittyProtocolActive(false);
	});

	it("should prefer codepoint for symbol keys even when base layout differs", () => {
		setKittyProtocolActive(true);
		// Dvorak Ctrl+/ reports codepoint '/' (47) and base layout '[' (91)
		const dvorakCtrlSlash = "\x1b[47::91;5u";
		expect(matchesKey(dvorakCtrlSlash, "ctrl+/")).toBe(true);
		expect(matchesKey(dvorakCtrlSlash, "ctrl+[")).toBe(false);
		setKittyProtocolActive(false);
	});
	it("ignores Kitty release events while still matching repeats", () => {
		setKittyProtocolActive(true);
		expect(matchesKey("\x1b[127u", "backspace")).toBe(true);
		expect(matchesKey("\x1b[127;1:2u", "backspace")).toBe(true);
		expect(matchesKey("\x1b[127;1:3u", "backspace")).toBe(false);
		setKittyProtocolActive(false);
	});

	it("keeps NumLock keypad digits as text instead of navigation keys", () => {
		setKittyProtocolActive(true);
		expect(matchesKey("\x1b[57400;129u", "1")).toBe(true);
		expect(matchesKey("\x1b[57400;129u", "end")).toBe(false);
		setKittyProtocolActive(false);
	});

	it("matches keypad operators as their printable symbols", () => {
		setKittyProtocolActive(true);
		expect(matchesKey("\x1b[57410u", "/")).toBe(true);
		expect(matchesKey("\x1b[57413;5u", "ctrl++")).toBe(true);
		setKittyProtocolActive(false);
	});

	it("matches Ctrl+Shift+Enter terminal protocol variants", () => {
		setKittyProtocolActive(true);
		expect(matchesKey("\x1b[13;6u", "ctrl+shift+enter")).toBe(true);
		expect(matchesKey("\x1b[27;6;13~", "ctrl+shift+enter")).toBe(true);
		expect(matchesKey("\x1b[13;6~", "ctrl+shift+enter")).toBe(true);
		expect(matchesKey("\x1b[13;2~", "shift+enter")).toBe(true);
		expect(matchesKey("\x1b[13;2u", "shift+enter")).toBe(true);
		expect(matchesKey("\x1b[13;3~", "alt+enter")).toBe(false);
		setKittyProtocolActive(false);
	});

	it("preserves keypad navigation matches when NumLock is on but modifiers are held", () => {
		setKittyProtocolActive(true);
		expect(matchesKey("\x1b[57400;133u", "ctrl+end")).toBe(true);
		expect(matchesKey("\x1b[57400;133u", "1")).toBe(false);
		setKittyProtocolActive(false);
	});
});

describe("parseKey", () => {
	it("should prefer codepoint for Latin letters when base layout differs", () => {
		setKittyProtocolActive(true);
		const dvorakCtrlK = "\x1b[107::118;5u";
		expect(parseKey(dvorakCtrlK)).toBe("ctrl+k");
		setKittyProtocolActive(false);
	});

	it("parses legacy Alt+LF as Alt+Enter", () => {
		setKittyProtocolActive(false);
		expect(parseKey("\x1b\n")).toBe("alt+enter");
	});

	it("ignores Kitty release events while still parsing repeats", () => {
		setKittyProtocolActive(true);
		expect(parseKey("\x1b[127u")).toBe("backspace");
		expect(parseKey("\x1b[127;1:2u")).toBe("backspace");
		expect(parseKey("\x1b[127;1:3u")).toBeUndefined();
		setKittyProtocolActive(false);
	});

	it("should prefer codepoint for symbol keys when base layout differs", () => {
		setKittyProtocolActive(true);
		const dvorakCtrlSlash = "\x1b[47::91;5u";
		expect(parseKey(dvorakCtrlSlash)).toBe("ctrl+/");
		setKittyProtocolActive(false);
	});

	it("parses NumLock keypad digits as digits", () => {
		setKittyProtocolActive(true);
		expect(parseKey("\x1b[57400;129u")).toBe("1");
		setKittyProtocolActive(false);
	});

	it("parses keypad operators as printable keys", () => {
		setKittyProtocolActive(true);
		expect(parseKey("\x1b[57410u")).toBe("/");
		expect(parseKey("\x1b[57413;5u")).toBe("ctrl++");
		setKittyProtocolActive(false);
	});

	it("parses Ctrl+Shift+Enter terminal protocol variants", () => {
		setKittyProtocolActive(true);
		expect(parseKey("\x1b[13;6u")).toBe("shift+ctrl+enter");
		expect(parseKey("\x1b[27;6;13~")).toBe("shift+ctrl+enter");
		expect(parseKey("\x1b[13;6~")).toBe("shift+ctrl+enter");
		expect(parseKey("\x1b[13;2~")).toBe("shift+enter");
		expect(parseKey("\x1b[13;2u")).toBe("shift+enter");
		expect(parseKey("\x1b[13;3~")).toBe("alt+f3");
		setKittyProtocolActive(false);
	});

	it("parses modified NumLock keypad navigation keys consistently", () => {
		setKittyProtocolActive(true);
		expect(parseKey("\x1b[57400;133u")).toBe("ctrl+end");
		setKittyProtocolActive(false);
	});

	it("ignores Kitty sequences with unsupported modifiers", () => {
		setKittyProtocolActive(true);
		expect(parseKey("\x1b[99;9u")).toBeUndefined();
		setKittyProtocolActive(false);
	});
});

describe("extractPrintableText", () => {
	it("extracts NumLock keypad digits from Kitty CSI-u sequences", () => {
		expect(extractPrintableText("\x1b[57407;129u")).toBe("8");
	});

	it("extracts keypad operators from Kitty CSI-u sequences", () => {
		expect(extractPrintableText("\x1b[57410u")).toBe("/");
		expect(extractPrintableText("\x1b[57413u")).toBe("+");
	});

	it("does not treat modified NumLock keypad navigation keys as text", () => {
		expect(extractPrintableText("\x1b[57400;133u")).toBeUndefined();
	});

	it("ignores unsupported modifiers on Kitty CSI-u text", () => {
		expect(extractPrintableText("\x1b[99;9u")).toBeUndefined();
		expect(extractPrintableText("\x1b[97;9;229u")).toBeUndefined();
	});

	it("preserves Kitty CSI-u text-field decoding for supported modifiers", () => {
		expect(extractPrintableText("\x1b[97;1;229u")).toBe("å");
	});
});
