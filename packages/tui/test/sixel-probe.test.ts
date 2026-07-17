import { afterEach, describe, expect, it } from "bun:test";
import {
	ImageProtocol,
	isUnderTerminalMultiplexer,
	onImageProtocolChanged,
	setTerminalImageProtocol,
	shouldProbeSixelCapability,
	TERMINAL,
	TUI,
} from "@gajae-code/tui";
import { VirtualTerminal } from "./virtual-terminal";

type MutableTerminalInfo = {
	imageProtocol: ImageProtocol | null;
};

const terminalInfo = TERMINAL as unknown as MutableTerminalInfo;
const originalProtocol = TERMINAL.imageProtocol;
const originalWtSession = Bun.env.WT_SESSION;
const originalTmux = Bun.env.TMUX;
const originalTerm = Bun.env.TERM;
const originalForceProtocol = Bun.env.PI_FORCE_IMAGE_PROTOCOL;
const stdinIsTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
const stdoutIsTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");

function restoreIsTty(
	stream: NodeJS.ReadStream | NodeJS.WriteStream,
	descriptor: PropertyDescriptor | undefined,
): void {
	if (descriptor) {
		Object.defineProperty(stream, "isTTY", descriptor);
		return;
	}
	delete (stream as unknown as { isTTY?: boolean }).isTTY;
}

function restoreEnv(key: string, value: string | undefined): void {
	if (value === undefined) delete Bun.env[key];
	else Bun.env[key] = value;
}

function probeSetup(): void {
	setTerminalImageProtocol(null);
	terminalInfo.imageProtocol = null;
	delete Bun.env.PI_FORCE_IMAGE_PROTOCOL;
	Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
	Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
}

describe("TUI SIXEL capability probe", () => {
	afterEach(() => {
		setTerminalImageProtocol(originalProtocol);
		terminalInfo.imageProtocol = originalProtocol;
		restoreEnv("WT_SESSION", originalWtSession);
		restoreEnv("TMUX", originalTmux);
		restoreEnv("TERM", originalTerm);
		restoreEnv("PI_FORCE_IMAGE_PROTOCOL", originalForceProtocol);
		restoreIsTty(process.stdin, stdinIsTtyDescriptor);
		restoreIsTty(process.stdout, stdoutIsTtyDescriptor);
	});

	it("enables SIXEL only after positive terminal capability response", () => {
		if (process.platform !== "win32") return;
		probeSetup();
		Bun.env.WT_SESSION = "test-wt-session";
		delete Bun.env.TMUX;

		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		tui.start();
		terminal.sendInput("\x1b[?1;2;4c");

		expect(TERMINAL.imageProtocol).toBe(ImageProtocol.Sixel);
		tui.stop();
	});

	it("enables SIXEL when DA and graphics replies are coalesced in one chunk", () => {
		if (process.platform !== "win32") return;
		probeSetup();
		Bun.env.WT_SESSION = "test-wt-session";
		delete Bun.env.TMUX;

		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		tui.start();
		terminal.sendInput("\x1b[?1;2;4c\x1b[?2;0;800;480S");

		expect(TERMINAL.imageProtocol).toBe(ImageProtocol.Sixel);
		tui.stop();
	});

	it("enables SIXEL when DA reply arrives split across chunks", () => {
		if (process.platform !== "win32") return;
		probeSetup();
		Bun.env.WT_SESSION = "test-wt-session";
		delete Bun.env.TMUX;

		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		tui.start();
		terminal.sendInput("\x1b[?1;2;");
		terminal.sendInput("4c");

		expect(TERMINAL.imageProtocol).toBe(ImageProtocol.Sixel);
		tui.stop();
	});

	it("enables SIXEL on an XTSMGRAPHICS success reply (Ps=0)", () => {
		if (process.platform !== "win32") return;
		probeSetup();
		Bun.env.WT_SESSION = "test-wt-session";
		delete Bun.env.TMUX;

		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		tui.start();
		terminal.sendInput("\x1b[?1;2c");
		terminal.sendInput("\x1b[?2;0;800;480S");

		expect(TERMINAL.imageProtocol).toBe(ImageProtocol.Sixel);
		tui.stop();
	});

	it("keeps SIXEL disabled when capability responses are negative", () => {
		if (process.platform !== "win32") return;
		probeSetup();
		Bun.env.WT_SESSION = "test-wt-session";
		delete Bun.env.TMUX;

		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		tui.start();
		// Real error replies: DA1 without the sixel attribute, then an
		// XTSMGRAPHICS failure (Ps=3, tmux's answer to an unsupported read).
		terminal.sendInput("\x1b[?1;2c");
		terminal.sendInput("\x1b[?2;3;0S");

		expect(TERMINAL.imageProtocol).toBeNull();
		tui.stop();
	});

	it("does not read a DA1 device class of 4 as the sixel attribute", () => {
		if (process.platform !== "win32") return;
		probeSetup();
		Bun.env.WT_SESSION = "test-wt-session";
		delete Bun.env.TMUX;

		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		tui.start();
		// `CSI ?4;6c` identifies a VT132 (leading device class 4); it does not
		// advertise the VT2xx+ sixel extension attribute.
		terminal.sendInput("\x1b[?4;6c");
		terminal.sendInput("\x1b[?2;3;0S");

		expect(TERMINAL.imageProtocol).toBeNull();
		tui.stop();
	});

	it("does not probe under tmux even when DA1 advertises sixel", () => {
		probeSetup();
		delete Bun.env.WT_SESSION;
		Bun.env.TMUX = "/tmp/tmux-1000/default,1234,0";

		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		tui.start();
		// tmux emits DA1 ";4" whenever compiled with sixel support, regardless
		// of the attached client's capabilities — not end-to-end evidence.
		terminal.sendInput("\x1b[?1;2;4c");

		expect(TERMINAL.imageProtocol).toBeNull();
		tui.stop();
	});

	it("does not probe when PI_FORCE_IMAGE_PROTOCOL is explicitly off", () => {
		probeSetup();
		Bun.env.WT_SESSION = "test-wt-session";
		delete Bun.env.TMUX;
		Bun.env.PI_FORCE_IMAGE_PROTOCOL = "off";

		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		tui.start();
		terminal.sendInput("\x1b[?1;2;4c");
		terminal.sendInput("\x1b[?2;0;800;480S");

		expect(TERMINAL.imageProtocol).toBeNull();
		tui.stop();
	});

	it("times out without enabling SIXEL when a reply stays fragmented", async () => {
		if (process.platform !== "win32") return;
		probeSetup();
		Bun.env.WT_SESSION = "test-wt-session";
		delete Bun.env.TMUX;

		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		tui.start();
		// The DA1 terminator never arrives; the 250ms one-shot probe must give
		// up without enabling sixel.
		terminal.sendInput("\x1b[?62");
		await new Promise(resolve => setTimeout(resolve, 300));

		expect(TERMINAL.imageProtocol).toBeNull();
		tui.stop();
	});
});

describe("shouldProbeSixelCapability", () => {
	afterEach(() => {
		restoreEnv("PI_FORCE_IMAGE_PROTOCOL", originalForceProtocol);
	});

	it("probes only Windows Terminal on win32", () => {
		delete Bun.env.PI_FORCE_IMAGE_PROTOCOL;
		expect(shouldProbeSixelCapability({ WT_SESSION: "s", TERM: "xterm-256color" }, "win32")).toBe(true);
		expect(shouldProbeSixelCapability({ TERM: "xterm-256color" }, "win32")).toBe(false);
		expect(shouldProbeSixelCapability({ WT_SESSION: "s", TERM: "xterm-256color" }, "darwin")).toBe(false);
		expect(shouldProbeSixelCapability({ TERM: "xterm-256color" }, "linux")).toBe(false);
	});

	it("never probes inside a terminal multiplexer", () => {
		delete Bun.env.PI_FORCE_IMAGE_PROTOCOL;
		expect(shouldProbeSixelCapability({ WT_SESSION: "s", TMUX: "/tmp/t,1,0" }, "win32")).toBe(false);
		expect(shouldProbeSixelCapability({ WT_SESSION: "s", TERM: "tmux-256color" }, "win32")).toBe(false);
		expect(shouldProbeSixelCapability({ WT_SESSION: "s", GJC_TMUX_LAUNCHED: "1" }, "win32")).toBe(false);
	});

	it("treats an explicit PI_FORCE_IMAGE_PROTOCOL as authoritative", () => {
		Bun.env.PI_FORCE_IMAGE_PROTOCOL = "off";
		expect(shouldProbeSixelCapability({ WT_SESSION: "s", TERM: "xterm-256color" }, "win32")).toBe(false);
		Bun.env.PI_FORCE_IMAGE_PROTOCOL = "sixel";
		expect(shouldProbeSixelCapability({ WT_SESSION: "s", TERM: "xterm-256color" }, "win32")).toBe(false);
	});
});

describe("isUnderTerminalMultiplexer", () => {
	it("detects tmux, screen, zellij, and GJC-launched panes", () => {
		expect(isUnderTerminalMultiplexer({ TMUX: "/tmp/tmux-1000/default,1,0" })).toBe(true);
		expect(isUnderTerminalMultiplexer({ TMUX_PANE: "%3" })).toBe(true);
		expect(isUnderTerminalMultiplexer({ STY: "1234.pts-0.host" })).toBe(true);
		expect(isUnderTerminalMultiplexer({ ZELLIJ: "0" })).toBe(false);
		expect(isUnderTerminalMultiplexer({ ZELLIJ: "session" })).toBe(true);
		expect(isUnderTerminalMultiplexer({ GJC_TMUX_LAUNCHED: "1" })).toBe(true);
		expect(isUnderTerminalMultiplexer({ GJC_TMUX_LAUNCHED: "0" })).toBe(false);
		expect(isUnderTerminalMultiplexer({ TERM: "tmux-256color" })).toBe(true);
		expect(isUnderTerminalMultiplexer({ TERM: "screen-256color" })).toBe(true);
	});

	it("stays false for plain terminals", () => {
		expect(isUnderTerminalMultiplexer({ TERM: "xterm-256color" })).toBe(false);
		expect(isUnderTerminalMultiplexer({ TERM: "xterm-kitty" })).toBe(false);
		expect(isUnderTerminalMultiplexer({})).toBe(false);
	});
});

describe("onImageProtocolChanged", () => {
	afterEach(() => {
		setTerminalImageProtocol(originalProtocol);
		terminalInfo.imageProtocol = originalProtocol;
	});

	it("fires on actual changes, dedupes same-value sets, and unsubscribes", () => {
		terminalInfo.imageProtocol = null;
		const seen: Array<ImageProtocol | null> = [];
		const unsubscribe = onImageProtocolChanged(protocol => {
			seen.push(protocol);
		});

		setTerminalImageProtocol(ImageProtocol.Sixel);
		setTerminalImageProtocol(ImageProtocol.Sixel);
		expect(seen).toEqual([ImageProtocol.Sixel]);

		setTerminalImageProtocol(null);
		expect(seen).toEqual([ImageProtocol.Sixel, null]);

		unsubscribe();
		setTerminalImageProtocol(ImageProtocol.Kitty);
		expect(seen).toEqual([ImageProtocol.Sixel, null]);
	});
});
