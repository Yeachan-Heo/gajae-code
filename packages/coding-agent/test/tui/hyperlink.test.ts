import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings, settings } from "@gajae-code/coding-agent/config/settings";
import { LocalProtocolHandler } from "@gajae-code/coding-agent/internal-urls";
import { AgentRegistry } from "@gajae-code/coding-agent/registry/agent-registry";
import { fileHyperlink, isHyperlinkEnabled, tryResolveInternalUrlSync } from "@gajae-code/coding-agent/tui/hyperlink";
import * as terminalCaps from "@gajae-code/tui";

// OSC 8 sequence markers
const OSC = "\x1b]";
const ST = "\x1b\\";
const LINK_END = `${OSC}8;;${ST}`;
const ORIGINAL_NO_COLOR = Bun.env.NO_COLOR;

/** Extract the hyperlink URI from a wrapped string. Returns undefined if not wrapped. */
function extractLinkUri(text: string): string | undefined {
	const match = text.match(/\x1b\]8;[^;]*;([^\x1b]+)\x1b\\/);
	return match?.[1];
}

/** Returns true if the string contains an OSC 8 hyperlink wrapping a given display text. */
function isHyperlinked(text: string): boolean {
	return text.includes(`${OSC}8;`) && text.includes(LINK_END);
}

/** Set the `tui.hyperlinks` mode via a non-persistent runtime override. */
function setHyperlinkMode(mode: "off" | "auto" | "always"): void {
	settings.override("tui.hyperlinks", mode);
}

beforeAll(async () => {
	resetSettingsForTest();
	LocalProtocolHandler.resetOverrideForTests();
	AgentRegistry.resetGlobalForTests();
	await Settings.init({ inMemory: true });
});

afterAll(() => {
	resetSettingsForTest();
	LocalProtocolHandler.resetOverrideForTests();
	AgentRegistry.resetGlobalForTests();
});

afterEach(() => {
	settings.clearOverride("tui.hyperlinks");
	LocalProtocolHandler.resetOverrideForTests();
	AgentRegistry.resetGlobalForTests();
	if (ORIGINAL_NO_COLOR === undefined) {
		delete Bun.env.NO_COLOR;
	} else {
		Bun.env.NO_COLOR = ORIGINAL_NO_COLOR;
	}
});

describe("isHyperlinkEnabled", () => {
	it('returns false when mode is "off"', () => {
		setHyperlinkMode("off");
		expect(isHyperlinkEnabled()).toBe(false);
	});

	it('returns true when mode is "always" regardless of TTY', () => {
		setHyperlinkMode("always");
		expect(isHyperlinkEnabled()).toBe(true);
	});

	it("returns false in auto mode when NO_COLOR is set", () => {
		setHyperlinkMode("auto");
		Bun.env.NO_COLOR = "1";
		expect(isHyperlinkEnabled()).toBe(false);
	});

	it("returns false in auto mode when stdout is not a TTY", () => {
		setHyperlinkMode("auto");
		const origTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
		try {
			Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
			expect(isHyperlinkEnabled()).toBe(false);
		} finally {
			if (origTTY) {
				Object.defineProperty(process.stdout, "isTTY", origTTY);
			} else {
				Reflect.deleteProperty(process.stdout, "isTTY");
			}
		}
	});

	it("returns TERMINAL.hyperlinks value in auto mode when conditions are met", () => {
		setHyperlinkMode("auto");
		delete Bun.env.NO_COLOR;
		const origTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
		try {
			Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
			// TERMINAL.hyperlinks may be true or false depending on the test runner env;
			// what matters is that isHyperlinkEnabled mirrors it.
			const expected = terminalCaps.TERMINAL.hyperlinks;
			expect(isHyperlinkEnabled()).toBe(expected);
		} finally {
			if (origTTY) {
				Object.defineProperty(process.stdout, "isTTY", origTTY);
			} else {
				Reflect.deleteProperty(process.stdout, "isTTY");
			}
		}
	});
});

describe("fileHyperlink", () => {
	it("returns plain text when hyperlinks are disabled (mode=off)", () => {
		setHyperlinkMode("off");
		const result = fileHyperlink("/Users/foo/bar.ts", "bar.ts");
		expect(result).toBe("bar.ts");
	});

	it("wraps text in OSC 8 when hyperlinks are enabled (mode=always)", () => {
		setHyperlinkMode("always");
		const result = fileHyperlink("/Users/foo/bar.ts", "bar.ts");
		expect(isHyperlinked(result)).toBe(true);
		expect(result).toContain("bar.ts");
	});

	it("builds a valid file:// URI with the absolute path", () => {
		setHyperlinkMode("always");
		const result = fileHyperlink("/Users/foo/bar.ts", "bar.ts");
		const uri = extractLinkUri(result);
		expect(uri).toMatch(/^file:\/\//);
		expect(uri).toContain("bar.ts");
	});

	it("encodes spaces in the path", () => {
		setHyperlinkMode("always");
		const result = fileHyperlink("/Users/foo/my file.ts", "my file.ts");
		const uri = extractLinkUri(result);
		expect(uri).toContain("%20");
		expect(uri).not.toContain(" ");
	});

	it("appends line and col as query params when provided", () => {
		setHyperlinkMode("always");
		const result = fileHyperlink("/Users/foo/bar.ts", "bar.ts", { line: 42, col: 7 });
		const uri = extractLinkUri(result);
		expect(uri).toContain("line=42");
		expect(uri).toContain("col=7");
	});

	it("omits query params when line/col are not provided", () => {
		setHyperlinkMode("always");
		const result = fileHyperlink("/Users/foo/bar.ts", "bar.ts");
		const uri = extractLinkUri(result);
		expect(uri).not.toContain("?");
	});

	it("produces a stable id for the same path", () => {
		setHyperlinkMode("always");
		const r1 = fileHyperlink("/Users/foo/bar.ts", "bar.ts");
		const r2 = fileHyperlink("/Users/foo/bar.ts", "different display text");
		// Extract id= from params (between "id=" and next ";")
		const id1 = r1.match(/id=([^;]+)/)?.[1];
		const id2 = r2.match(/id=([^;]+)/)?.[1];
		expect(id1).toBeDefined();
		expect(id1).toBe(id2);
	});

	it("does not double-wrap text that already contains an OSC 8 sequence", () => {
		setHyperlinkMode("always");
		const alreadyWrapped = `${OSC}8;id=abc123;file:///foo/bar.ts${ST}bar.ts${LINK_END}`;
		const result = fileHyperlink("/Users/foo/other.ts", alreadyWrapped);
		// Should return the already-wrapped text unchanged
		expect(result).toBe(alreadyWrapped);
	});

	it("preserves ANSI color codes inside the hyperlink", () => {
		setHyperlinkMode("always");
		const colored = "\x1b[32mbar.ts\x1b[0m";
		const result = fileHyperlink("/Users/foo/bar.ts", colored);
		expect(result).toContain(colored);
		expect(isHyperlinked(result)).toBe(true);
	});
});

describe("tryResolveInternalUrlSync", () => {
	it("returns undefined for non-internal URLs", () => {
		expect(tryResolveInternalUrlSync("/abs/path/file.ts")).toBeUndefined();
		expect(tryResolveInternalUrlSync("relative/path.ts")).toBeUndefined();
		expect(tryResolveInternalUrlSync("https://example.com/foo")).toBeUndefined();
	});

	it("returns undefined for unsupported internal URL schemes", () => {
		// Async-resolved schemes are intentionally not handled here.
		expect(tryResolveInternalUrlSync("artifact://123")).toBeUndefined();
		expect(tryResolveInternalUrlSync("agent://abc")).toBeUndefined();
		expect(tryResolveInternalUrlSync("skill://foo")).toBeUndefined();
		expect(tryResolveInternalUrlSync("gjc://docs.md")).toBeUndefined();
	});

	it("returns undefined when local:// resolution has no session options", () => {
		// No AgentRegistry main session in this unit test, no override installed.
		expect(tryResolveInternalUrlSync("local://foo.md")).toBeUndefined();
	});

	it("swallows errors from malformed URLs", () => {
		// Malformed input should not throw, just return undefined.
		expect(tryResolveInternalUrlSync("local://%ZZ")).toBeUndefined();
	});
});
