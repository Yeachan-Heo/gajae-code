import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import {
	__setBinaryResolverForTests,
	clearPsmuxDetectionCache,
} from "@gajae-code/coding-agent/gjc-runtime/psmux-detect";
import { buildGjcTmuxExactOptionTarget } from "@gajae-code/coding-agent/gjc-runtime/tmux-common";
import {
	createGjcTmuxSession,
	listGjcTmuxSessions,
	removeGjcTmuxSession,
	statusGjcTmuxSession,
} from "@gajae-code/coding-agent/gjc-runtime/tmux-sessions";

type SpawnSyncResult = Bun.SyncSubprocess<"pipe", "pipe">;
type SpawnSyncSpy = { mockImplementation(implementation: (command: string[]) => SpawnSyncResult): void };

function spawnResult(exitCode: number, stdout: string, stderr = ""): SpawnSyncResult {
	return {
		exitCode,
		stdout: Buffer.from(stdout),
		stderr: Buffer.from(stderr),
	} as SpawnSyncResult;
}

describe("GJC tmux session management", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("lists only GJC-managed tmux sessions", () => {
		spyOn(Bun, "spawnSync").mockReturnValue(
			spawnResult(
				0,
				[
					"gajae_code_abc	1	0	1770000000	1	root	2	12345	feature/demo	feature-demo	/repo-a",
					"unrelated	2	1	1770000060		root	3	23456		",
					"gajae_code	1	1	1770000120		root	1	34567		",
				].join("\n"),
			),
		);

		clearPsmuxDetectionCache();
		const sessions = listGjcTmuxSessions({ GJC_TMUX_COMMAND: "tmux-test" });

		expect(sessions.map(session => session.name)).toEqual(["gajae_code_abc"]);
		expect(sessions[0].attached).toBe(false);
		expect(sessions[0].panes).toBe(2);
		expect(sessions[0].panePids).toEqual([12345]);
		expect(sessions[0].bindings).toBe("root");
		expect(sessions[0].createdAt).toBe("2026-02-02T02:40:00.000Z");
		expect(sessions[0].branch).toBe("feature/demo");
		expect(sessions[0].project).toBe("/repo-a");
		expect(Bun.spawnSync).toHaveBeenCalledWith(
			[
				"tmux-test",
				"list-sessions",
				"-F",
				"#{session_name}	#{session_windows}	#{session_attached}	#{session_created}	#{@gjc-profile}	#{session_key_table}	#{session_panes}	#{pane_pid}	#{@gjc-branch}	#{@gjc-branch-slug}	#{@gjc-project}	#{@gjc-session-id}	#{@gjc-session-state-file}	#{@gjc-version}",
			],
			expect.any(Object),
		);
	});

	it("returns an empty list when tmux has no server", () => {
		spyOn(Bun, "spawnSync").mockReturnValue(spawnResult(1, "", "no server running on /tmp/tmux"));

		expect(listGjcTmuxSessions()).toEqual([]);
	});

	it("guards status and remove to GJC-managed sessions", () => {
		// Pin the resolved command to tmux so the assertions are agnostic to
		// whether the host has psmux / pmux / tmux on PATH. The shared
		// resolveGjcTmuxCommand now picks the first available multiplexer on
		// Windows; we explicitly opt into literal tmux for this guard test.
		const env = { GJC_TMUX_COMMAND: "tmux" };
		const calls: string[][] = [];
		const spawnSyncSpy = spyOn(Bun, "spawnSync") as unknown as SpawnSyncSpy;
		spawnSyncSpy.mockImplementation((cmd: string[]) => {
			calls.push(cmd);
			if (cmd.includes("list-sessions")) {
				return spawnResult(0, "gajae_code_work	1	0	1770000000	1	root	1			\n");
			}
			if (cmd.includes("show-options")) return spawnResult(0, "1\n");
			return spawnResult(0, "");
		});

		expect(statusGjcTmuxSession("gajae_code_work", env).name).toBe("gajae_code_work");
		expect(() => statusGjcTmuxSession("unrelated", env)).toThrow("gjc_tmux_session_not_found:unrelated");
		expect(removeGjcTmuxSession("gajae_code_work", env).name).toBe("gajae_code_work");
		expect(calls.at(-1)).toEqual(["tmux", "kill-session", "-t", "=gajae_code_work"]);
	});

	it("does not kill when final live profile check fails", () => {
		const calls: string[][] = [];
		const spawnSyncSpy = spyOn(Bun, "spawnSync") as unknown as SpawnSyncSpy;
		spawnSyncSpy.mockImplementation((cmd: string[]) => {
			calls.push(cmd);
			if (cmd.includes("list-sessions")) {
				return spawnResult(0, "gajae_code_work	1	0	1770000000	1	root	1			\n");
			}
			if (cmd.includes("show-options")) return spawnResult(0, "\n");
			return spawnResult(0, "");
		});

		expect(() => removeGjcTmuxSession("gajae_code_work")).toThrow("gjc_tmux_session_not_managed:gajae_code_work");
		expect(calls.some(call => call.includes("kill-session"))).toBe(false);
	});

	it("diagnoses sessions the multiplexer lists but did not tag with the GJC profile", () => {
		const spawnSyncSpy = spyOn(Bun, "spawnSync") as unknown as SpawnSyncSpy;
		spawnSyncSpy.mockImplementation((cmd: string[]) => {
			if (cmd.includes("list-sessions")) {
				const format = cmd[cmd.indexOf("-F") + 1] ?? "";
				// The bare `#{session_name}` probe sees the session (psmux ls shows it)...
				if (format === "#{session_name}") return spawnResult(0, "psmux_session\n");
				// ...but the full format does not round-trip @gjc-profile, so the profile column is empty.
				return spawnResult(0, "psmux_session	1	0	1770000000		root	0				\n");
			}
			return spawnResult(0, "");
		});

		expect(() => statusGjcTmuxSession("psmux_session", { GJC_TMUX_COMMAND: "psmux" })).toThrow(
			"gjc_tmux_session_untagged:psmux_session",
		);
		expect(() => statusGjcTmuxSession("psmux_session", { GJC_TMUX_COMMAND: "psmux" })).toThrow(
			/cwd\/start-directory flags such as `-c` do not isolate the server namespace/,
		);
		expect(() => statusGjcTmuxSession("psmux_session", { GJC_TMUX_COMMAND: "psmux" })).toThrow(
			/GJC_TMUX_COMMAND and GJC_TEAM_TMUX_COMMAND are binary overrides, not shell command lines/,
		);
		expect(() => statusGjcTmuxSession("psmux_session", { GJC_TMUX_COMMAND: "psmux" })).toThrow(/not fully supported/);
	});

	it("hydrates native Windows tmux sessions from exact option reads when list-sessions omits user options", () => {
		const calls: string[][] = [];
		const spawnSyncSpy = spyOn(Bun, "spawnSync") as unknown as SpawnSyncSpy;
		spawnSyncSpy.mockImplementation((cmd: string[]) => {
			calls.push(cmd);
			if (cmd.includes("list-sessions")) {
				return spawnResult(0, "win_session	1	0	1770000000		root	1	12345					\n");
			}
			if (cmd.includes("show-options")) {
				const option = cmd.at(-1);
				if (option === "@gjc-profile") return spawnResult(0, "1\n");
				if (option === "@gjc-branch") return spawnResult(0, "issue-882-windows-tmux\n");
				return spawnResult(0, "\n");
			}
			return spawnResult(0, "");
		});

		const session = statusGjcTmuxSession("win_session", { GJC_TMUX_COMMAND: "tmux" });

		expect(session.name).toBe("win_session");
		expect(session.profile).toBe("1");
		expect(session.branch).toBe("issue-882-windows-tmux");
		expect(calls).toContainEqual(["tmux", "show-options", "-qv", "-t", "=win_session:", "@gjc-profile"]);
	});

	it("still reports plain not-found when the multiplexer does not list the session", () => {
		spyOn(Bun, "spawnSync").mockReturnValue(spawnResult(0, ""));

		expect(() => statusGjcTmuxSession("ghost")).toThrow("gjc_tmux_session_not_found:ghost");
	});

	it("builds a window-qualified exact target for tmux option commands", () => {
		// tmux 3.6a only resolves the exact session for option commands when the
		// target is window-qualified (`=NAME:`); a bare `=NAME` does not (#580).
		expect(buildGjcTmuxExactOptionTarget("gajae_code_work")).toBe("=gajae_code_work:");
	});

	it("queries the profile option with a window-qualified exact target", () => {
		// Pin the resolved command to tmux so this test is platform-agnostic.
		const env = { GJC_TMUX_COMMAND: "tmux" };
		const calls: string[][] = [];
		const spawnSyncSpy = spyOn(Bun, "spawnSync") as unknown as SpawnSyncSpy;
		spawnSyncSpy.mockImplementation((cmd: string[]) => {
			calls.push(cmd);
			if (cmd.includes("list-sessions")) {
				return spawnResult(0, "gajae_code_work	1	0	1770000000	1	root	1			\n");
			}
			if (cmd.includes("show-options")) return spawnResult(0, "1\n");
			return spawnResult(0, "");
		});

		removeGjcTmuxSession("gajae_code_work", env);

		const showOptions = calls.find(call => call.includes("show-options"));
		expect(showOptions).toEqual(["tmux", "show-options", "-qv", "-t", "=gajae_code_work:", "@gjc-profile"]);
		// Session-scoped commands keep the bare exact target, which tmux resolves.
		expect(calls.at(-1)).toEqual(["tmux", "kill-session", "-t", "=gajae_code_work"]);
	});

	it("drops the tmux `=NAME` exact-session prefix on psmux for option commands", () => {
		// psmux 3.3.0 rejects the tmux `=NAME` exact-session prefix on
		// set-option / show-options with "no server running on session '=NAME'",
		// but tmux 3.6a needs the window-qualified `=NAME:` to resolve the
		// session for option/display commands. The shared resolver should
		// pick the right shape for the active multiplexer. Use the
		// BinaryResolver test seam + GJC_PSMUX_COMMAND override so the
		// detection layer agrees on the multiplexer identity without
		// needing a real psmux binary on PATH.
		__setBinaryResolverForTests(candidate =>
			candidate === "psmux" || candidate === "pmux" ? `/fake/${candidate}` : null,
		);
		try {
			expect(buildGjcTmuxExactOptionTarget("work", { env: { GJC_TMUX_COMMAND: "tmux" } })).toBe("=work:");
			expect(
				buildGjcTmuxExactOptionTarget("work", { env: { GJC_TMUX_COMMAND: "psmux", GJC_PSMUX_COMMAND: "psmux" } }),
			).toBe("work");
			expect(
				buildGjcTmuxExactOptionTarget("work", { env: { GJC_TMUX_COMMAND: "pmux", GJC_PSMUX_COMMAND: "pmux" } }),
			).toBe("work");
		} finally {
			__setBinaryResolverForTests(null);
		}
	});

	it("hydrates native psmux sessions even when -F is silently ignored", () => {
		// Make the resolver recognize psmux so the list-sessions fallback engages.
		__setBinaryResolverForTests(candidate => (candidate === "psmux" ? "/fake/psmux" : null));
		try {
			// psmux 3.3.0 silently ignores the tmux -F format flag and returns its
			// default `name: N windows (created ...)` shape. The list-sessions
			// fallback should detect that, synthesize a tab-separated row, and
			// recover the @gjc-profile tag via follow-up show-options calls.
			//
			// psmux show-options returns `key value` (not just `value` like tmux),
			// so the parser must also strip the leading key on psmux.
			const calls: string[][] = [];
			const spawnSyncSpy = spyOn(Bun, "spawnSync") as unknown as SpawnSyncSpy;
			spawnSyncSpy.mockImplementation((cmd: string[]) => {
				calls.push(cmd);
				if (cmd.includes("list-sessions")) {
					return spawnResult(0, "psmux_session: 1 windows (created Sat Jun 27 17:00:00 2026)\n");
				}
				if (cmd.includes("show-options")) {
					const option = cmd.at(-1);
					if (option === "@gjc-profile") return spawnResult(0, "@gjc-profile 1");
					return spawnResult(0, "");
				}
				return spawnResult(0, "");
			});

			const sessions = listGjcTmuxSessions({
				GJC_TMUX_COMMAND: "psmux",
				GJC_PSMUX_COMMAND: "psmux",
			});

			expect(sessions).toHaveLength(1);
			expect(sessions[0].name).toBe("psmux_session");
			expect(sessions[0].profile).toBe("1");
			expect(sessions[0].windows).toBe(1);
			// follow-up show-options hit the bare `NAME` target (no `=` prefix).
			expect(calls).toContainEqual(["psmux", "show-options", "-qv", "-t", "psmux_session", "@gjc-profile"]);
		} finally {
			__setBinaryResolverForTests(null);
		}
	});

	it("createGjcTmuxSession drops the psmux UX profile commands", () => {
		__setBinaryResolverForTests(candidate => (candidate === "psmux" ? "/fake/psmux" : null));
		try {
			// psmux does not implement set-window-option (it reports "unknown
			// command: set-window-option") and historically drops mouse /
			// set-clipboard / mode-style on set-option. createGjcTmuxSession must
			// apply the same UX filter that applyGjcTmuxProfile already applies
			// for `gjc --tmux` planning, otherwise the create flow throws and
			// the new session gets killed by tryKillSession.
			const calls: string[][] = [];
			const spawnSyncSpy = spyOn(Bun, "spawnSync") as unknown as SpawnSyncSpy;
			spawnSyncSpy.mockImplementation((cmd: string[]) => {
				calls.push(cmd);
				if (cmd[0] === "psmux" && cmd[1] === "new-session") return spawnResult(0, "");
				if (cmd.includes("list-sessions")) {
					return spawnResult(0, "psmux_session: 1 windows (created Sat Jun 27 17:00:00 2026)\n");
				}
				if (cmd.includes("show-options")) return spawnResult(0, "@gjc-profile 1");
				return spawnResult(0, "");
			});

			try {
				createGjcTmuxSession({
					GJC_TMUX_COMMAND: "psmux",
					GJC_PSMUX_COMMAND: "psmux",
				} as NodeJS.ProcessEnv);
			} catch {
				// Some CI environments stub the tmux binary; we only assert on the
				// profile command list, not the overall result.
			}

			const setWindowOptionCalls = calls.filter(cmd => cmd[0] === "psmux" && cmd[1] === "set-window-option");
			const setOptionCalls = calls.filter(cmd => cmd[0] === "psmux" && cmd[1] === "set-option");
			// set-window-option must never run on psmux.
			expect(setWindowOptionCalls).toEqual([]);
			// Every psmux set-option call must carry an @gjc-* ownership tag, never
			// mouse / set-clipboard / mode-style. The UX profile commands get
			// filtered out by buildGjcTmuxProfileCommands when the active binary
			// is psmux.
			for (const cmd of setOptionCalls) {
				const key = cmd[cmd.length - 2];
				expect([
					"@gjc-profile",
					"@gjc-branch",
					"@gjc-branch-slug",
					"@gjc-project",
					"@gjc-session-id",
					"@gjc-session-state-file",
					"@gjc-version",
				]).toContain(key);
			}
		} finally {
			__setBinaryResolverForTests(null);
		}
	});
});
