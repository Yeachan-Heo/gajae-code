import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isUnsolicitedProbeReply, PROBE_REPLY_PATTERNS, ProcessTerminal } from "@gajae-code/tui/terminal";

// Regression coverage for the otty input-freeze: unsolicited capability-probe
// replies (OSC 11 / DA1 / Mode 2031 DSR / Kitty flags) that arrive outside their
// pending-query window must be dropped instead of leaking into the input handler,
// while real keystrokes and pasted content are preserved.

const stdinIsTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
const stdoutIsTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
const stdinSetRawModeDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "setRawMode");

function restoreProperty(target: object, key: string, descriptor: PropertyDescriptor | undefined): void {
	if (descriptor) {
		Object.defineProperty(target, key, descriptor);
		return;
	}
	delete (target as Record<string, unknown>)[key];
}

describe("ProcessTerminal unsolicited probe-reply strip", () => {
	beforeEach(() => {
		Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
		Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
		Object.defineProperty(process.stdin, "setRawMode", { value: vi.fn(), configurable: true });
	});

	afterEach(() => {
		vi.restoreAllMocks();
		restoreProperty(process.stdin, "isTTY", stdinIsTtyDescriptor);
		restoreProperty(process.stdout, "isTTY", stdoutIsTtyDescriptor);
		restoreProperty(process.stdin, "setRawMode", stdinSetRawModeDescriptor);
	});

	function setupTerminal() {
		const writes: string[] = [];
		const received: string[] = [];
		const appearances: Array<"dark" | "light"> = [];
		vi.spyOn(process, "kill").mockReturnValue(true);
		vi.spyOn(process.stdin, "resume").mockImplementation(() => process.stdin);
		vi.spyOn(process.stdin, "pause").mockImplementation(() => process.stdin);
		vi.spyOn(process.stdin, "setEncoding").mockImplementation(() => process.stdin);
		vi.spyOn(process.stdout, "write").mockImplementation(chunk => {
			writes.push(typeof chunk === "string" ? chunk : chunk.toString());
			return true;
		});

		const terminal = new ProcessTerminal();
		terminal.onAppearanceChange(mode => appearances.push(mode));
		terminal.start(
			data => received.push(data),
			() => {},
		);

		// Drain the initial startup OSC 11 + DA1 probe so the pending counters
		// return to 0 and subsequent replies count as unsolicited.
		const feed = (data: string) => process.stdin.emit("data", data);
		return { terminal, writes, received, appearances, feed };
	}

	function drainInitialProbe(feed: (data: string) => void, received: string[]): void {
		feed("\x1b]11;rgb:ffff/ffff/ffff\x07"); // solicited OSC 11 reply (consumed)
		feed("\x1b[?1;2c"); // solicited DA1 sentinel (consumed, counter -> 0)
		expect(received).toEqual([]); // nothing leaked while draining
	}

	it("case 1: drops an unsolicited OSC 11 reply split across chunk boundaries", () => {
		const { received, feed } = setupTerminal();
		drainInitialProbe(feed, received);
		// Split mid-sequence; StdinBuffer reassembles the complete OSC before the strip.
		feed("\x1b]11;rgb:0a0a/0e0e/");
		feed("1414\x07");
		expect(received).toEqual([]);
	});

	it("case 2: drops an unsolicited DA1 reply", () => {
		const { received, feed } = setupTerminal();
		drainInitialProbe(feed, received);
		feed("\x1b[?62;22c");
		expect(received).toEqual([]);
	});

	it("case 3: drops interleaved unsolicited OSC 11 + DA1 but forwards a real keystroke", () => {
		const { received, feed } = setupTerminal();
		drainInitialProbe(feed, received);
		feed("\x1b]11;rgb:0a0a/0e0e/1414\x07");
		feed("\x1b[?62;22c");
		feed("a"); // real keystroke
		expect(received).toEqual(["a"]);
	});

	it("case 4: preserves bracketed-paste content even when it contains reply-shaped bytes", () => {
		const { received, feed } = setupTerminal();
		drainInitialProbe(feed, received);
		const payload = "before\x1b]11;rgb:0a0a/0e0e/1414\x07after";
		feed(`\x1b[200~${payload}\x1b[201~`);
		// Paste is re-wrapped by terminal.ts and forwarded intact via the paste path.
		expect(received).toHaveLength(1);
		expect(received[0]).toBe(`\x1b[200~${payload}\x1b[201~`);
	});

	it("case 5: still consumes a solicited in-window reply and fires the appearance callback", () => {
		const { received, appearances, feed } = setupTerminal();
		// Initial startup probe is still pending; a dark reply must be consumed
		// (not forwarded) and must drive the dark/light callback.
		feed("\x1b]11;rgb:0000/0000/0000\x07");
		expect(received).toEqual([]);
		expect(appearances).toEqual(["dark"]);
	});

	it("case 6: distinguishes Kitty flags report (stripped) from Kitty key input (forwarded)", () => {
		// Unit-level guard on the disambiguation: the `?` private marker separates
		// the flags REPORT from CSI-u key INPUT.
		expect(isUnsolicitedProbeReply("\x1b[?7u")).toBe(true); // flags report
		expect(isUnsolicitedProbeReply("\x1b[97;5u")).toBe(false); // key input (no `?`)
		expect(isUnsolicitedProbeReply("\x1b[97u")).toBe(false); // key input (no `?`)

		// Integration: once the Kitty protocol is already active, a further flags
		// report is unsolicited and must be dropped rather than forwarded.
		const { received, feed } = setupTerminal();
		drainInitialProbe(feed, received);
		feed("\x1b[?1u"); // first report enables the protocol (consumed by enable path)
		feed("\x1b[?1u"); // second report is now unsolicited -> stripped
		expect(received).toEqual([]);
	});

	it("case 7: self-checking probe coverage - every issued probe has a strip entry", () => {
		const sourcePath = fileURLToPath(new URL("../src/terminal.ts", import.meta.url));
		const source = readFileSync(sourcePath, "utf8");

		// Every registry entry must correspond to a probe query the TUI actually
		// issues. Render control bytes in the same `\xHH` form the TS source uses.
		const toSourceEscaped = (s: string): string =>
			[...s]
				.map(ch => {
					const code = ch.charCodeAt(0);
					return code < 0x20 || code === 0x7f ? `\\x${code.toString(16).padStart(2, "0")}` : ch;
				})
				.join("");
		for (const entry of PROBE_REPLY_PATTERNS) {
			expect(source.includes(toSourceEscaped(entry.issuedProbe))).toBe(true);
		}

		// Drift guard: the known reply-bearing probe query markers the TUI issues.
		// If a new capability probe is added to terminal.ts, add it here AND to
		// PROBE_REPLY_PATTERNS; this pinned set makes the omission fail loudly.
		const KNOWN_PROBE_QUERY_MARKERS = [
			"\\x1b]11;?\\x07", // OSC 11 background color
			"\\x1b[c", // DA1 sentinel
			"\\x1b[?2031h", // Mode 2031 appearance notifications
			"\\x1b[?u", // Kitty keyboard flags query
		];
		expect(PROBE_REPLY_PATTERNS.map(p => p.issuedProbe).sort()).toEqual(
			KNOWN_PROBE_QUERY_MARKERS.map(m => m.replace(/\\x1b/g, "\x1b").replace(/\\x07/g, "\x07")).sort(),
		);

		// Each registry pattern must reject plainly non-reply input.
		for (const nonReply of ["a", "\x1b[200~", "\x1b[201~", "\x1b[97;5u"]) {
			expect(isUnsolicitedProbeReply(nonReply)).toBe(false);
		}
	});
});
