import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { getTerminalId } from "@gajae-code/tui/ttyid";

describe("getTerminalId tmux ordering", () => {
	const TMUX_KEYS = ["TMUX", "TMUX_PANE", "KITTY_WINDOW_ID", "TERM_SESSION_ID", "WT_SESSION"];
	let saved: Record<string, string | undefined>;
	let savedIsTTY: boolean | undefined;

	beforeEach(() => {
		saved = {};
		for (const key of TMUX_KEYS) {
			saved[key] = process.env[key];
			delete process.env[key];
		}
		savedIsTTY = process.stdin.isTTY;
	});

	afterEach(() => {
		for (const key of TMUX_KEYS) {
			if (saved[key] === undefined) delete process.env[key];
			else process.env[key] = saved[key];
		}
		Object.defineProperty(process.stdin, "isTTY", { value: savedIsTTY, configurable: true });
	});

	it("prefers stable TMUX_PANE over the TTY path inside tmux", () => {
		// Simulate an attached tmux session with a live stdin TTY.
		Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
		process.env.TMUX = "/tmp/tmux-1000/default,123,0";
		process.env.TMUX_PANE = "%7";

		expect(getTerminalId()).toBe("tmux-%7");
	});

	it("does not use the tmux pane when TMUX is unset", () => {
		Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
		process.env.TMUX_PANE = "%7";

		// Outside tmux, the lone TMUX_PANE fallback still applies (unchanged behavior).
		expect(getTerminalId()).toBe("tmux-%7");
	});

	it("returns null when no terminal can be identified", () => {
		Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });

		expect(getTerminalId()).toBeNull();
	});
});
