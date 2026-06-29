import { describe, expect, it } from "bun:test";
import { scrollTmuxToPreviousUserInput, TMUX_PREVIOUS_USER_INPUT_SEARCH_PATTERN } from "../../src/modes/tmux-scroll";

describe("scrollTmuxToPreviousUserInput", () => {
	it("reports unavailable outside tmux", () => {
		const calls: string[][] = [];
		const result = scrollTmuxToPreviousUserInput({}, (command, args) => {
			calls.push([command, ...args]);
			return { exitCode: 0 };
		});

		expect(result).toEqual({ ok: false, reason: "not_inside_tmux" });
		expect(calls).toEqual([]);
	});

	it("keeps the search pattern scoped to a standalone user label", () => {
		const pattern = new RegExp(TMUX_PREVIOUS_USER_INPUT_SEARCH_PATTERN);

		expect(" user                                                                            ").toMatch(pattern);
		expect(" user story body").not.toMatch(pattern);
		expect(" user input").not.toMatch(pattern);
	});

	it("enters copy mode and searches backward for the user-message label in the current pane", () => {
		const calls: string[][] = [];
		const env: NodeJS.ProcessEnv = {
			GJC_TMUX_COMMAND: "tmux-test",
			TMUX: "/tmp/tmux-501/default,123,0",
			TMUX_PANE: "%7",
		};
		const result = scrollTmuxToPreviousUserInput(env, (command, args) => {
			calls.push([command, ...args]);
			return { exitCode: 0 };
		});

		expect(result).toEqual({ ok: true });
		expect(calls).toEqual([
			["tmux-test", "copy-mode", "-t", "%7"],
			["tmux-test", "send-keys", "-t", "%7", "-X", "history-bottom"],
			["tmux-test", "send-keys", "-t", "%7", "-X", "search-backward", TMUX_PREVIOUS_USER_INPUT_SEARCH_PATTERN],
		]);
	});

	it("falls back to tmux's current pane when TMUX_PANE is absent", () => {
		const calls: string[][] = [];
		const env: NodeJS.ProcessEnv = {
			GJC_TMUX_COMMAND: "tmux-test",
			TMUX: "/tmp/tmux-501/default,123,0",
		};
		const result = scrollTmuxToPreviousUserInput(env, (command, args) => {
			calls.push([command, ...args]);
			return { exitCode: 0 };
		});

		expect(result).toEqual({ ok: true });
		expect(calls).toEqual([
			["tmux-test", "copy-mode"],
			["tmux-test", "send-keys", "-X", "history-bottom"],
			["tmux-test", "send-keys", "-X", "search-backward", TMUX_PREVIOUS_USER_INPUT_SEARCH_PATTERN],
		]);
	});

	it("returns the tmux stderr from the failing step", () => {
		const env: NodeJS.ProcessEnv = {
			GJC_TMUX_COMMAND: "tmux-test",
			TMUX: "/tmp/tmux-501/default,123,0",
			TMUX_PANE: "%7",
		};
		const result = scrollTmuxToPreviousUserInput(env, () => ({
			exitCode: 1,
			stderr: { toString: () => "no current pane\n" },
		}));

		expect(result).toEqual({ ok: false, reason: "copy_mode_failed", error: "no current pane" });
	});
});
