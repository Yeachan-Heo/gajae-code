import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { ProcessTerminal } from "@gajae-code/tui/terminal";

const stdinIsTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
const stdoutIsTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
const processPlatformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
const stdinSetRawModeDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "setRawMode");
const originalWslDistroName = Bun.env.WSL_DISTRO_NAME;
const originalWslInterop = Bun.env.WSL_INTEROP;

function restoreProperty(target: object, key: string, descriptor: PropertyDescriptor | undefined): void {
	if (descriptor) {
		Object.defineProperty(target, key, descriptor);
		return;
	}
	delete (target as Record<string, unknown>)[key];
}

function restoreEnv(key: string, original: string | undefined): void {
	if (original === undefined) {
		delete Bun.env[key];
		return;
	}
	Bun.env[key] = original;
}

describe("ProcessTerminal OSC 11 appearance detection", () => {
	beforeEach(() => {
		Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
		Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
		Object.defineProperty(process.stdin, "setRawMode", { value: vi.fn(), configurable: true });
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		restoreProperty(process.stdin, "isTTY", stdinIsTtyDescriptor);
		restoreProperty(process.stdout, "isTTY", stdoutIsTtyDescriptor);
		restoreProperty(process.stdin, "setRawMode", stdinSetRawModeDescriptor);
		restoreProperty(process, "platform", processPlatformDescriptor);
		restoreEnv("WSL_INTEROP", originalWslInterop);
		restoreEnv("WSL_DISTRO_NAME", originalWslDistroName);
	});

	function setupTerminal() {
		const writes: string[] = [];
		const received: string[] = [];
		vi.spyOn(process, "kill").mockReturnValue(true);
		vi.spyOn(process.stdin, "resume").mockImplementation(() => process.stdin);
		vi.spyOn(process.stdin, "pause").mockImplementation(() => process.stdin);
		vi.spyOn(process.stdin, "setEncoding").mockImplementation(() => process.stdin);
		vi.spyOn(process.stdout, "write").mockImplementation(chunk => {
			writes.push(typeof chunk === "string" ? chunk : chunk.toString());
			return true;
		});

		const terminal = new ProcessTerminal();
		terminal.start(
			data => received.push(data),
			() => {},
		);

		const queryCount = () => writes.filter(w => w === "\x1b]11;?\x07").length;
		const sentinelCount = () => writes.filter(w => w === "\x1b[c").length;

		return { terminal, writes, received, queryCount, sentinelCount };
	}

	it("swallows the DA1 sentinel even when the OSC 11 reply arrives first", () => {
		const { terminal, writes, received } = setupTerminal();

		process.stdin.emit("data", "\x1b]11;rgb:ffff/ffff/ffff\x07");
		process.stdin.emit("data", "\x1b[?1;2c");

		expect(received).toEqual([]);
		expect(writes).toContain("\x1b]11;?\x07");
		expect(writes).toContain("\x1b[c");

		terminal.stop();
	});

	it("queues overlapping OSC 11 queries until the in-flight DA1 sentinel is consumed", () => {
		vi.useFakeTimers();
		const { terminal, queryCount, sentinelCount } = setupTerminal();

		expect(queryCount()).toBe(1);
		expect(sentinelCount()).toBe(1);

		process.stdin.emit("data", "\x1b[?997;1n");
		vi.advanceTimersByTime(100);

		expect(queryCount()).toBe(1);
		expect(sentinelCount()).toBe(1);

		process.stdin.emit("data", "\x1b[?1;2c");

		expect(queryCount()).toBe(2);
		expect(sentinelCount()).toBe(2);

		terminal.stop();
	});

	it("OSC 11 updates terminal.appearance and fires callbacks with dedup", () => {
		const { terminal } = setupTerminal();
		const appearances: string[] = [];
		terminal.onAppearanceChange(a => appearances.push(a));

		// Send dark background response + DA1
		process.stdin.emit("data", "\x1b]11;rgb:0000/0000/0000\x07");
		process.stdin.emit("data", "\x1b[?1;2c");

		expect(terminal.appearance).toBe("dark");
		expect(appearances).toEqual(["dark"]);

		// Send same color again — callback should NOT fire again
		process.stdin.emit("data", "\x1b]11;rgb:0000/0000/0000\x07");
		process.stdin.emit("data", "\x1b[?1;2c");

		expect(appearances).toEqual(["dark"]);

		terminal.stop();
	});

	it("2-digit hex OSC 11 response is correctly normalized", () => {
		const { terminal } = setupTerminal();

		// Send dark 2-digit response + DA1
		process.stdin.emit("data", "\x1b]11;rgb:1a/1a/1a\x07");
		process.stdin.emit("data", "\x1b[?1;2c");
		expect(terminal.appearance).toBe("dark");

		terminal.stop();
	});

	it("2-digit hex light background is detected correctly", () => {
		const { terminal } = setupTerminal();

		process.stdin.emit("data", "\x1b]11;rgb:ff/ff/ff\x07");
		process.stdin.emit("data", "\x1b[?1;2c");
		expect(terminal.appearance).toBe("light");

		terminal.stop();
	});

	it("Mode 2031 debounce: multiple notifications coalesce into one re-query", () => {
		vi.useFakeTimers();
		const { terminal, queryCount } = setupTerminal();

		// Complete the initial OSC 11 + DA1 cycle
		process.stdin.emit("data", "\x1b]11;rgb:ffff/ffff/ffff\x07");
		process.stdin.emit("data", "\x1b[?1;2c");

		const baseline = queryCount();

		// Send 3 rapid Mode 2031 notifications
		process.stdin.emit("data", "\x1b[?997;1n");
		process.stdin.emit("data", "\x1b[?997;1n");
		process.stdin.emit("data", "\x1b[?997;1n");

		// Advance past debounce
		vi.advanceTimersByTime(100);

		// Only one additional query should have been sent (debounced)
		expect(queryCount()).toBe(baseline + 1);

		terminal.stop();
	});

	it("poll timer self-disables when Mode 2031 fires outside WSL", () => {
		vi.useFakeTimers();
		const { terminal, queryCount } = setupTerminal();

		// Complete initial OSC 11 + DA1 cycle
		process.stdin.emit("data", "\x1b]11;rgb:ffff/ffff/ffff\x07");
		process.stdin.emit("data", "\x1b[?1;2c");

		const afterInitial = queryCount();

		// Advance 2s — poll should fire and send another query
		vi.advanceTimersByTime(2000);
		expect(queryCount()).toBe(afterInitial + 1);

		// Complete poll's OSC 11 + DA1
		process.stdin.emit("data", "\x1b]11;rgb:ffff/ffff/ffff\x07");
		process.stdin.emit("data", "\x1b[?1;2c");
		// Send Mode 2031 notification — this activates push mode and stops polling
		process.stdin.emit("data", "\x1b[?997;1n");
		vi.advanceTimersByTime(100);

		// Complete Mode 2031's re-query
		process.stdin.emit("data", "\x1b]11;rgb:0000/0000/0000\x07");
		process.stdin.emit("data", "\x1b[?1;2c");

		const afterMode2031 = queryCount();

		// Advance 4s — no additional poll queries should fire
		vi.advanceTimersByTime(4000);
		expect(queryCount()).toBe(afterMode2031);

		terminal.stop();
	});

	it("does not start the OSC 11 poll timer under WSL", () => {
		vi.useFakeTimers();
		Object.defineProperty(process, "platform", { value: "linux", configurable: true });
		Bun.env.WSL_INTEROP = "/run/WSL/1_interop";
		const { terminal, queryCount } = setupTerminal();

		process.stdin.emit("data", "\x1b]11;rgb:ffff/ffff/ffff\x07");
		process.stdin.emit("data", "\x1b[?1;2c");
		const afterInitial = queryCount();

		vi.advanceTimersByTime(4000);

		expect(queryCount()).toBe(afterInitial);

		terminal.stop();
	});

	it("partial OSC 11 buffer does not swallow unrelated input", () => {
		vi.useFakeTimers();
		const { terminal, received } = setupTerminal();

		// Send a partial OSC 11 start (no terminator)
		process.stdin.emit("data", "\x1b]11;rgb:ff");
		// Flush StdinBuffer timeout so the partial sequence is emitted
		vi.advanceTimersByTime(50);

		// Send an unrelated escape sequence (up arrow)
		process.stdin.emit("data", "\x1b[A");
		vi.advanceTimersByTime(50);

		// The up arrow must be forwarded to the input handler
		expect(received).toContain("\x1b[A");

		terminal.stop();
	});

	it("DA1 from old query does not cancel new queued query", () => {
		vi.useFakeTimers();
		const { terminal, queryCount, sentinelCount } = setupTerminal();
		const appearances: string[] = [];
		terminal.onAppearanceChange(a => appearances.push(a));

		// Step 1: initial query was sent on start
		expect(queryCount()).toBe(1);
		expect(sentinelCount()).toBe(1);

		// Step 2: Mode 2031 notification arrives — queues re-query since initial is pending
		process.stdin.emit("data", "\x1b[?997;1n");

		// Step 3: Complete initial OSC 11 response (light)
		process.stdin.emit("data", "\x1b]11;rgb:ffff/ffff/ffff\x07");

		// Advance past debounce timer
		vi.advanceTimersByTime(100);

		// Step 4: Complete initial DA1 — should start queued query
		process.stdin.emit("data", "\x1b[?1;2c");

		expect(queryCount()).toBe(2);
		expect(sentinelCount()).toBe(2);

		// Step 5: Complete 2nd OSC 11 response with a different color (dark)
		process.stdin.emit("data", "\x1b]11;rgb:0000/0000/0000\x07");

		// Step 6: Complete 2nd DA1
		process.stdin.emit("data", "\x1b[?1;2c");

		// Step 7: Verify appearance changed and callback fired
		expect(terminal.appearance).toBe("dark");
		expect(appearances).toContain("light");
		expect(appearances).toContain("dark");
		expect(appearances.length).toBe(2);

		terminal.stop();
	});

	it("reassembles a DA1 response split across stdin reads without leaking to input (#1238)", () => {
		vi.useFakeTimers();
		const { terminal, received } = setupTerminal();

		// OSC 11 completes normally.
		process.stdin.emit("data", "\x1b]11;rgb:1c1c/1c1c/1c1c\x07");

		// DA1 reply arrives split: the prefix appears as one event and then the StdinBuffer
		// flush timeout (10ms) elapses before the rest of the response is delivered.
		// xterm-style "VT420 with extensions" response: \x1b[?62;6;7;14;...;52c
		process.stdin.emit("data", "\x1b[?62");
		vi.advanceTimersByTime(50);
		process.stdin.emit("data", ";6;7;14;21;22;23;24;28;32;42;52c");

		expect(received).toEqual([]);
		expect(terminal.appearance).toBe("dark");

		terminal.stop();
	});

	it("reassembles a DA1 response delivered byte-by-byte", () => {
		vi.useFakeTimers();
		const { terminal, received } = setupTerminal();

		process.stdin.emit("data", "\x1b]11;rgb:1c1c/1c1c/1c1c\x07");
		process.stdin.emit("data", "\x1b[?62");
		vi.advanceTimersByTime(50);
		for (const ch of ";6;7;14;21;22;23;24;28;32;42;52c") {
			process.stdin.emit("data", ch);
		}

		expect(received).toEqual([]);
		expect(terminal.appearance).toBe("dark");

		terminal.stop();
	});

	it("abandons private CSI reassembly when a new escape arrives mid-stream", () => {
		vi.useFakeTimers();
		const { terminal, received } = setupTerminal();

		// Start a partial DA1, then a fresh CSI (up arrow) interrupts before the terminator.
		process.stdin.emit("data", "\x1b[?62");
		vi.advanceTimersByTime(50);
		process.stdin.emit("data", "\x1b[A");
		vi.advanceTimersByTime(50);

		// Up arrow must reach the input handler; probe noise must not.
		expect(received).toContain("\x1b[A");
		expect(received.some(seq => seq.includes("?62"))).toBe(false);

		terminal.stop();
	});
});

describe("ProcessTerminal raw-Buffer stdin (issue #454)", () => {
	beforeEach(() => {
		Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
		Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
		Object.defineProperty(process.stdin, "setRawMode", { value: vi.fn(), configurable: true });
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		restoreProperty(process.stdin, "isTTY", stdinIsTtyDescriptor);
		restoreProperty(process.stdout, "isTTY", stdoutIsTtyDescriptor);
		restoreProperty(process.stdin, "setRawMode", stdinSetRawModeDescriptor);
		restoreProperty(process, "platform", processPlatformDescriptor);
		restoreEnv("WSL_INTEROP", originalWslInterop);
		restoreEnv("WSL_DISTRO_NAME", originalWslDistroName);
	});

	function setupTerminal() {
		const received: string[] = [];
		vi.spyOn(process, "kill").mockReturnValue(true);
		vi.spyOn(process.stdin, "resume").mockImplementation(() => process.stdin);
		vi.spyOn(process.stdin, "pause").mockImplementation(() => process.stdin);
		const setEncodingSpy = vi.spyOn(process.stdin, "setEncoding").mockImplementation(() => process.stdin);
		vi.spyOn(process.stdout, "write").mockImplementation(() => true);

		const terminal = new ProcessTerminal();
		terminal.start(
			data => received.push(data),
			() => {},
		);

		return { terminal, received, setEncodingSpy };
	}

	it("does not call setEncoding('utf8') on start", () => {
		const { terminal, setEncodingSpy } = setupTerminal();
		expect(setEncodingSpy).not.toHaveBeenCalled();
		terminal.stop();
	});

	it("delivers a Korean bracketed paste split mid-syllable from raw Buffers unchanged", () => {
		const { terminal, received } = setupTerminal();

		const content = "화면 기록";
		const full = Buffer.from(`\x1b[200~${content}\x1b[201~`, "utf8");
		const markerStart = Buffer.byteLength("\x1b[200~", "utf8");
		// Split inside the first Korean syllable and inside the end marker.
		process.stdin.emit("data", full.subarray(0, markerStart + 2));
		process.stdin.emit("data", full.subarray(markerStart + 2, full.length - 3));
		process.stdin.emit("data", full.subarray(full.length - 3));

		// Terminal re-wraps decoded paste content in bracketed markers.
		expect(received).toContain(`\x1b[200~${content}\x1b[201~`);
		expect(received.join("")).not.toContain("\uFFFD");

		terminal.stop();
	});

	it("decodes Buffer-emitted OSC 11 + DA1 protocol responses without leaking to input", () => {
		const { terminal, received } = setupTerminal();

		process.stdin.emit("data", Buffer.from("\x1b]11;rgb:0000/0000/0000\x07", "utf8"));
		process.stdin.emit("data", Buffer.from("\x1b[?1;2c", "utf8"));

		expect(terminal.appearance).toBe("dark");
		expect(received).toEqual([]);

		terminal.stop();
	});
});
