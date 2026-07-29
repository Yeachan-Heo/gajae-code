import { describe, expect, it } from "bun:test";
import {
	extractPrintableText,
	isKeyId,
	matchesKey,
	parseKey,
	parseKeyId,
	setKittyProtocolActive,
} from "@gajae-code/tui/keys";

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

	it("keeps Super chords distinct from their plain keys", () => {
		setKittyProtocolActive(true);
		const superP = "\x1b[112;9u";
		expect(matchesKey(superP, "super+p")).toBe(true);
		expect(matchesKey(superP, "p")).toBe(false);
		expect(matchesKey("p", "super+p")).toBe(false);
		setKittyProtocolActive(false);
	});
});
describe.each([
	{ data: "\x1bq", kitty: false, key: "alt+q", expected: "alt+q" },
	{ data: "\x1bC", kitty: true, key: "alt+shift+c", expected: "alt+shift+c" },
	{ data: "\x1b[113;3u", kitty: true, key: "alt+q", expected: "alt+q" },
	{ data: "\x1b[99;4u", kitty: true, key: "alt+shift+c", expected: "alt+shift+c" },
	{ data: "\x1b[27;3;105~", kitty: false, key: "alt+i", expected: "alt+i" },
] as const)("normalizes Option input $expected", ({ data, kitty, key, expected }) => {
	it("matches and parses one canonical KeyId", () => {
		setKittyProtocolActive(kitty);
		expect(matchesKey(data, key)).toBe(true);
		expect(parseKey(data)).toBe(expected);
		setKittyProtocolActive(false);
	});
});
describe("Alt+I protocol symmetry", () => {
	it.each([
		{ data: "\x1bi", kitty: true, expected: "alt+i" },
		{ data: "\x1b[105;3u", kitty: true, expected: "alt+i" },
		{ data: "\x1b[27;3;105~", kitty: true, expected: "alt+i" },
	])("matches and parses $expected", ({ data, kitty, expected }) => {
		setKittyProtocolActive(kitty);
		expect(matchesKey(data, expected)).toBe(true);
		expect(parseKey(data)).toBe(expected);
		setKittyProtocolActive(false);
	});

	it("does not parse or match gated legacy space and control forms while Kitty is active", () => {
		setKittyProtocolActive(true);
		expect(matchesKey("\x1b ", "alt+space")).toBe(false);
		expect(parseKey("\x1b ")).toBeUndefined();
		expect(matchesKey("\x1b\x01", "ctrl+alt+a")).toBe(false);
		expect(parseKey("\x1b\x01")).toBeUndefined();
		setKittyProtocolActive(false);
	});

	it.each([
		{ data: "\x1bb", navigation: "alt+left", literal: "alt+b" },
		{ data: "\x1bf", navigation: "alt+right", literal: "alt+f" },
	])("keeps $data as exclusive $navigation navigation under Kitty on and off", ({ data, navigation, literal }) => {
		for (const kitty of [false, true]) {
			setKittyProtocolActive(kitty);
			expect(parseKey(data)).toBe(navigation);
			expect(matchesKey(data, navigation)).toBe(true);
			expect(matchesKey(data, literal)).toBe(false);
			for (const otherNavigation of ["alt+left", "alt+right", "alt+up", "alt+down"] as const) {
				expect(matchesKey(data, otherNavigation)).toBe(otherNavigation === navigation);
			}
		}
		setKittyProtocolActive(false);
	});

	it.each([
		{ data: "\x1bp", literal: "alt+p" },
		{ data: "\x1bn", literal: "alt+n" },
	])("preserves $data as literal $literal under Kitty on and off", ({ data, literal }) => {
		for (const kitty of [false, true]) {
			setKittyProtocolActive(kitty);
			expect(parseKey(data)).toBe(literal);
			expect(matchesKey(data, literal)).toBe(true);
		}
		setKittyProtocolActive(false);
	});
	it.each([
		{ data: "\x1bB", literal: "alt+shift+b" },
		{ data: "\x1bF", literal: "alt+shift+f" },
		{ data: "\x1bP", literal: "alt+shift+p" },
		{ data: "\x1bN", literal: "alt+shift+n" },
	])("preserves $data as literal $literal under Kitty on and off", ({ data, literal }) => {
		for (const kitty of [false, true]) {
			setKittyProtocolActive(kitty);
			expect(parseKey(data)).toBe(literal);
			expect(matchesKey(data, literal)).toBe(true);
		}
		setKittyProtocolActive(false);
	});

	it.each([
		{ data: "\x1b[98;3u", expected: "alt+b" },
		{ data: "\x1b[98;4u", expected: "alt+shift+b" },
		{ data: "\x1b[27;3;102~", expected: "alt+f" },
		{ data: "\x1b[27;4;70~", expected: "alt+shift+f" },
		{ data: "\x1b[112;3u", expected: "alt+p" },
		{ data: "\x1b[27;4;78~", expected: "alt+shift+n" },
	])("uses enhanced encoding for literal $expected", ({ data, expected }) => {
		setKittyProtocolActive(true);
		expect(parseKey(data)).toBe(expected);
		expect(matchesKey(data, expected)).toBe(true);
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

	it("parses Kitty Super chords", () => {
		setKittyProtocolActive(true);
		expect(parseKey("\x1b[112;9u")).toBe("super+p");
		setKittyProtocolActive(false);
	});

	it("ignores Kitty sequences with unsupported modifiers", () => {
		setKittyProtocolActive(true);
		expect(parseKey("\x1b[99;17u")).toBeUndefined();
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
		expect(extractPrintableText("\x1b[99;17u")).toBeUndefined();
		expect(extractPrintableText("\x1b[97;17;229u")).toBeUndefined();
	});

	it("preserves Kitty CSI-u text-field decoding for supported modifiers", () => {
		expect(extractPrintableText("\x1b[97;1;229u")).toBe("å");
	});
});
describe("KeyId grammar", () => {
	it("parses canonical keys case-insensitively", () => {
		expect(parseKeyId("CTRL+Shift+C")?.keyId).toBe("ctrl+shift+c");
		expect(isKeyId("super+p")).toBe(true);
		expect(parseKeyId(" Ctrl + C ")?.keyId).toBe("ctrl+c");
		expect(isKeyId("ctrl+c")).toBe(true);
		expect(isKeyId("CTRL+C")).toBe(false);
		expect(isKeyId("ctrl+plus")).toBe(false);
		expect(isKeyId(" Ctrl + C ")).toBe(false);
		expect(isKeyId("pageUp")).toBe(true);
		expect(isKeyId("pageDown")).toBe(true);
		expect(isKeyId("pageup")).toBe(false);
		expect(isKeyId("pagedown")).toBe(false);
	});

	it("accepts literal plus keys and rejects malformed plus chains", () => {
		expect(parseKeyId("+")).toMatchObject({ keyId: "+", baseKey: "+" });
		expect(parseKeyId("ctrl++")).toMatchObject({ keyId: "ctrl++", baseKey: "+" });
		expect(parseKeyId("plus")).toMatchObject({ keyId: "+", baseKey: "+" });
		expect(parseKeyId("ctrl+plus")).toMatchObject({ keyId: "ctrl++", baseKey: "+" });
		expect(parseKeyId("++")).toBeUndefined();
		expect(parseKeyId("ctrl+")).toBeUndefined();
		expect(parseKeyId("ctrl+++")).toBeUndefined();
	});

	it("rejects aliases, duplicates, malformed chains, unknown keys, and controls", () => {
		for (const key of [
			"cmd+p",
			"command+p",
			"meta+p",
			"option+p",
			"ctrl+ctrl+c",
			"ctrl++x",
			"ctrl+unknown",
			"ctrl+\u001b",
			"ctrl+c\n",
		]) {
			expect(parseKeyId(key)).toBeUndefined();
			expect(isKeyId(key)).toBe(false);
		}
	});
});
