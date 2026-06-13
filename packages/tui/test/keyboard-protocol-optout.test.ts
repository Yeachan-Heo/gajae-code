import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { keyboardEnhancementEnabled, ProcessTerminal } from "@gajae-code/tui/terminal";

const stdinIsTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
const stdoutIsTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
const stdinSetRawModeDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "setRawMode");
const originalKeyboardProtocolEnv = Bun.env.GJC_TUI_KEYBOARD_PROTOCOL;

// Kitty keyboard protocol query and the xterm modifyOtherKeys level-2 fallback.
const KITTY_QUERY = "\x1b[?u";
const MODIFY_OTHER_KEYS = "\x1b[>4;2m";

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

describe("ProcessTerminal keyboard-protocol opt-out (GJC_TUI_KEYBOARD_PROTOCOL)", () => {
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
		restoreEnv("GJC_TUI_KEYBOARD_PROTOCOL", originalKeyboardProtocolEnv);
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

		return { terminal, writes, received };
	}

	it("enables the keyboard protocol by default (query + modifyOtherKeys fallback)", () => {
		vi.useFakeTimers();
		delete Bun.env.GJC_TUI_KEYBOARD_PROTOCOL;
		expect(keyboardEnhancementEnabled()).toBe(true);

		const { terminal, writes } = setupTerminal();

		expect(writes).toContain(KITTY_QUERY);

		// No Kitty response arrives → modifyOtherKeys fallback fires after 150ms.
		vi.advanceTimersByTime(150);
		expect(writes).toContain(MODIFY_OTHER_KEYS);

		terminal.stop();
	});

	it("skips the query and modifyOtherKeys fallback when disabled", () => {
		vi.useFakeTimers();
		Bun.env.GJC_TUI_KEYBOARD_PROTOCOL = "0";
		expect(keyboardEnhancementEnabled()).toBe(false);

		const { terminal, writes } = setupTerminal();

		expect(writes).not.toContain(KITTY_QUERY);

		vi.advanceTimersByTime(150);
		expect(writes).not.toContain(MODIFY_OTHER_KEYS);

		terminal.stop();
	});

	it("still delivers keyboard input to the handler when disabled", () => {
		Bun.env.GJC_TUI_KEYBOARD_PROTOCOL = "0";

		const { terminal, received } = setupTerminal();

		// Typed Hangul must still reach the input handler in default keyboard mode.
		process.stdin.emit("data", Buffer.from("안", "utf8"));

		expect(received).toContain("안");

		terminal.stop();
	});
});
