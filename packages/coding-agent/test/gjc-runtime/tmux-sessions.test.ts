import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildWindowsPowerShellInnerCommand } from "@gajae-code/coding-agent/gjc-runtime/launch-tmux";
import {
	__setBinaryResolverForTests,
	clearPsmuxDetectionCache,
} from "@gajae-code/coding-agent/gjc-runtime/psmux-detect";
import {
	buildGjcTmuxExactOptionTarget,
	buildGjcTmuxExactSessionTarget,
} from "@gajae-code/coding-agent/gjc-runtime/tmux-common";
import { lifecyclePaths, observeOwnerTerminal } from "@gajae-code/coding-agent/gjc-runtime/tmux-owner-isolation";
import {
	__setCreateOwnerIsolationForTests,
	__setMutationServerProofForTests,
	attachGjcTmuxSession,
	createGjcTmuxSession,
	forceCloseGjcTmuxSession,
	listGjcTmuxSessions,
	removeGjcTmuxSession,
	statusGjcTmuxSession,
} from "@gajae-code/coding-agent/gjc-runtime/tmux-sessions";

type SpawnSyncResult = Bun.SyncSubprocess<"pipe", "pipe">;
type SpawnSyncCommandMock = (command: string[]) => SpawnSyncResult;
type SpawnSyncSpy = {
	mockImplementation(implementation: SpawnSyncCommandMock): void;
};
const fixtureDirectories: string[] = [];

function spawnResult(exitCode: number, stdout: string, stderr = ""): SpawnSyncResult {
	return {
		exitCode,
		stdout: Buffer.from(stdout),
		stderr: Buffer.from(stderr),
	} as SpawnSyncResult;
}

function injectSafeAbsentToSafeOwnerProof(): void {
	let probeCount = 0;
	__setCreateOwnerIsolationForTests({
		probe: {
			readCallerCgroup: () => "0::/user.slice/user-1000.slice/user@1000.service/gjc-owner-test.scope\n",
			probeServer: () => {
				probeCount += 1;
				return probeCount === 1
					? { state: "absent" }
					: {
							state: "safe",
							pid: 1,
							startTime: "test",
							cgroup: { classification: "safe" },
						};
			},
		},
	});
}

function injectSafeMutationProof(): void {
	__setMutationServerProofForTests(() => undefined);
}

describe("GJC tmux session management", () => {
	afterEach(async () => {
		vi.restoreAllMocks();
		__setCreateOwnerIsolationForTests(null);
		__setMutationServerProofForTests(null);
		await Promise.all(
			fixtureDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })),
		);
	});

	it("lists only GJC-managed tmux sessions", () => {
		spyOn(Bun, "spawnSync").mockReturnValue(
			spawnResult(
				0,
				[
					"gajae_code_abc\t1\t0\t1770000000\t1\troot\t2\t12345\tfeature/demo\tfeature-demo\t/repo-a\t\t\t\t\t$1",
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
		expect(sessions[0].nativeSessionId).toBe("$1");
		expect(Bun.spawnSync).toHaveBeenCalledWith(
			[
				"tmux-test",
				"list-sessions",
				"-F",
				"#{session_name}\t#{session_windows}\t#{session_attached}\t#{session_created}\t#{@gjc-profile}\t#{session_key_table}\t#{session_panes}\t#{pane_pid}\t#{@gjc-branch}\t#{@gjc-branch-slug}\t#{@gjc-project}\t#{@gjc-session-id}\t#{@gjc-session-state-file}\t#{@gjc-owner-generation}\t#{@gjc-version}\t#{session_id}",
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
			if (cmd.includes("if-shell")) return spawnResult(0, "__gjc_tmux_guarded_mutation_ok__\n");
			if (cmd.includes("display-message")) return spawnResult(0, "$0\n");
			return spawnResult(0, "");
		});

		expect(statusGjcTmuxSession("gajae_code_work", env).name).toBe("gajae_code_work");
		expect(() => statusGjcTmuxSession("unrelated", env)).toThrow("gjc_tmux_session_not_found:unrelated");
		injectSafeMutationProof();
		expect(removeGjcTmuxSession("gajae_code_work", env).name).toBe("gajae_code_work");
		expect(calls.at(-1)?.[1]).toBe("if-shell");
	});

	it("refuses a same-name replacement before the final guarded remove", () => {
		const env = { GJC_TMUX_COMMAND: "tmux" };
		const calls: string[][] = [];
		(spyOn(Bun, "spawnSync") as unknown as SpawnSyncSpy).mockImplementation(command => {
			calls.push(command);
			if (command.includes("list-sessions")) {
				return spawnResult(
					0,
					"gajae_code_work\t1\t0\t1770000000\t1\troot\t0\t\tmain\tmain\t/repo\tsession-1\t/tmp/runtime-state.json\tgeneration-one\t\t$1\n",
				);
			}
			if (command.includes("display-message")) return spawnResult(0, "$2\n");
			if (command.includes("show-options")) {
				return spawnResult(0, command.at(-1) === "@gjc-owner-generation" ? "generation-one\n" : "1\n");
			}
			return spawnResult(0, "");
		});

		expect(() =>
			removeGjcTmuxSession("gajae_code_work", env, {
				nativeSessionId: "$1",
				ownerGeneration: "generation-one",
				sessionId: "session-1",
				sessionStateFile: "/tmp/runtime-state.json",
				project: "/repo",
				createdAt: "2026-02-02T02:40:00.000Z",
			}),
		).toThrow("gjc_tmux_owner_changed:gajae_code_work");
		expect(calls.some(command => command.includes("if-shell") || command.includes("kill-session"))).toBe(false);
	});

	it("refuses unsafe or unverifiable server proof before any remove, attach, or force-close mutation", async () => {
		for (const proofError of [
			"gjc_tmux_owner_isolation_server_unsafe",
			"gjc_tmux_owner_isolation_server_unverifiable",
		]) {
			const calls: string[][] = [];
			const signalTerm = vi.fn();
			const cleanupSession = vi.fn();
			(spyOn(Bun, "spawnSync") as unknown as SpawnSyncSpy).mockImplementation((command: string[]) => {
				calls.push(command);
				if (command.includes("display-message")) return spawnResult(0, "$0\n");
				if (command.includes("list-sessions"))
					return spawnResult(
						0,
						"gajae_code_work\t1\t0\t1770000000\t1\troot\t0\t\t\t\tsession\t/state/marker\tgeneration\tgajae_code_work\n",
					);
				if (command.includes("list-panes")) return spawnResult(0, "321\n");
				if (command.includes("show-options")) {
					const option = command.at(-1);
					return spawnResult(
						0,
						option === "@gjc-profile"
							? "1\n"
							: option === "@gjc-session-id"
								? "session\n"
								: option === "@gjc-owner-generation"
									? "generation\n"
									: option === "@gjc-owner-server-key"
										? "gajae_code_work\n"
										: "/state/marker\n",
					);
				}
				return spawnResult(0, "");
			});
			__setMutationServerProofForTests(() => {
				throw new Error(proofError);
			});

			expect(() => removeGjcTmuxSession("gajae_code_work", { GJC_TMUX_COMMAND: "tmux" })).toThrow(proofError);
			expect(() => attachGjcTmuxSession("gajae_code_work", { GJC_TMUX_COMMAND: "tmux" })).toThrow(proofError);
			await expect(
				forceCloseGjcTmuxSession("gajae_code_work", { GJC_TMUX_COMMAND: "tmux" }, undefined, undefined, {
					resolveOwner: async () => ({
						sessionId: "session",
						stateDir: "/state",
						socketKey: "gajae_code_work",
						generation: "generation",
						pid: 321,
						startTime: "10",
					}),
					readProcessStartTime: async () => "10",
					signalTerm,
					cleanupSession,
				}),
			).rejects.toThrow(proofError);
			expect(signalTerm).not.toHaveBeenCalled();
			expect(cleanupSession).not.toHaveBeenCalled();
			expect(
				calls.some(command => ["kill-session", "attach-session"].some(mutation => command.includes(mutation))),
			).toBe(false);
			vi.restoreAllMocks();
		}
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

		const session = statusGjcTmuxSession("win_session", {
			GJC_TMUX_COMMAND: "tmux",
		});

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
			if (cmd.includes("if-shell")) return spawnResult(0, "__gjc_tmux_guarded_mutation_ok__\n");
			if (cmd.includes("display-message")) return spawnResult(0, "$0\n");
			return spawnResult(0, "");
		});

		injectSafeMutationProof();
		removeGjcTmuxSession("gajae_code_work", env);

		const showOptions = calls.find(call => call.includes("show-options"));
		expect(showOptions).toEqual(["tmux", "show-options", "-qv", "-t", "=gajae_code_work:", "@gjc-profile"]);
		// Destructive removal targets the re-proven immutable native session ID.
		expect(calls.at(-1)?.[1]).toBe("if-shell");
	});

	it("builds psmux-aware targets for session-scoped commands", () => {
		__setBinaryResolverForTests(candidate =>
			candidate === "psmux" || candidate === "pmux" ? `/fake/${candidate}` : null,
		);
		try {
			expect(
				buildGjcTmuxExactSessionTarget("work", {
					env: { GJC_TMUX_COMMAND: "tmux" },
				}),
			).toBe("=work");
			expect(
				buildGjcTmuxExactSessionTarget("work", {
					env: { GJC_TMUX_COMMAND: "psmux", GJC_PSMUX_COMMAND: "psmux" },
				}),
			).toBe("work");
			expect(
				buildGjcTmuxExactSessionTarget("work", {
					env: { GJC_TMUX_COMMAND: "pmux", GJC_PSMUX_COMMAND: "pmux" },
				}),
			).toBe("work");
		} finally {
			__setBinaryResolverForTests(null);
		}
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
			expect(
				buildGjcTmuxExactOptionTarget("work", {
					env: { GJC_TMUX_COMMAND: "tmux" },
				}),
			).toBe("=work:");
			expect(
				buildGjcTmuxExactOptionTarget("work", {
					env: { GJC_TMUX_COMMAND: "psmux", GJC_PSMUX_COMMAND: "psmux" },
				}),
			).toBe("work");
			expect(
				buildGjcTmuxExactOptionTarget("work", {
					env: { GJC_TMUX_COMMAND: "pmux", GJC_PSMUX_COMMAND: "pmux" },
				}),
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

	it("fails closed before tagging when native session identity is unavailable", () => {
		const calls: string[][] = [];
		injectSafeAbsentToSafeOwnerProof();
		const spawnSyncSpy = spyOn(Bun, "spawnSync") as unknown as SpawnSyncSpy;
		spawnSyncSpy.mockImplementation((cmd: string[]) => {
			calls.push(cmd);
			if (cmd.includes("display-message")) return spawnResult(0, "");
			return spawnResult(0, "");
		});

		expect(() => createGjcTmuxSession({ GJC_TMUX_COMMAND: "tmux" })).toThrow(
			"gjc_tmux_owner_isolation_native_session_identity_unavailable",
		);
		expect(calls.some(cmd => cmd.includes("new-session"))).toBe(true);
		expect(calls.some(cmd => cmd.includes("set-option") || cmd.includes("set-window-option"))).toBe(false);
	});
	it("rejects psmux before creating or tagging a managed session", async () => {
		const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-tmux-sessions-test-"));
		fixtureDirectories.push(stateDir);
		__setBinaryResolverForTests(candidate => (candidate === "psmux" ? "/fake/psmux" : null));
		try {
			const calls: string[][] = [];
			injectSafeAbsentToSafeOwnerProof();
			const spawnSyncSpy = spyOn(Bun, "spawnSync") as unknown as SpawnSyncSpy;
			spawnSyncSpy.mockImplementation((cmd: string[]) => {
				calls.push(cmd);
				return spawnResult(0, "");
			});
			expect(() =>
				createGjcTmuxSession({
					GJC_TMUX_COMMAND: "psmux",
					GJC_PSMUX_COMMAND: "psmux",
					GJC_TMUX_SESSION: "psmux_session",
					GJC_COORDINATOR_SESSION_STATE_FILE: path.join(stateDir, "runtime-state.json"),
				} as NodeJS.ProcessEnv),
			).toThrow("gjc_tmux_owner_isolation_native_session_identity_unavailable");
			expect(calls.filter(cmd => cmd[1] === "new-session")).toHaveLength(0);
			expect(calls.some(cmd => cmd[1] === "set-option" || cmd[1] === "set-window-option")).toBe(false);
			expect(calls.some(cmd => cmd[1] === "kill-session")).toBe(false);
		} finally {
			__setBinaryResolverForTests(null);
		}
	});
	it("builds a BOM-free encoded command for psmux with literal PowerShell values and arguments", () => {
		const encoded = buildWindowsPowerShellInnerCommand({
			command: ["C:\\Program Files\\GJC\\O'Brien\\gjc.exe"],
			args: ["--resume", "operator's session", "--label=O'Brien"],
			environment: {
				GJC_PSMUX_COMMAND: "C:\\Program Files\\O'Brien\\psmux.exe",
				GJC_TEST_VALUE: "operator's value",
			},
		});
		const encodedMatch = encoded.match(/-EncodedCommand\s+(\S+)/);
		expect(encodedMatch).not.toBeNull();
		if (!encodedMatch) throw new Error("expected PowerShell encoded command");

		const decoded = Buffer.from(encodedMatch[1], "base64");
		expect(decoded[0]).not.toBe(0xff);
		expect(decoded[1]).not.toBe(0xfe);
		const script = decoded.toString("utf16le");
		expect(script[0]).toBe("$");
		expect(script).toContain("$env:GJC_PSMUX_COMMAND = 'C:\\Program Files\\O''Brien\\psmux.exe'");
		expect(script).toContain("$env:GJC_TEST_VALUE = 'operator''s value'");
		expect(script).toContain(
			"& 'C:\\Program Files\\GJC\\O''Brien\\gjc.exe' '--resume' 'operator''s session' '--label=O''Brien'",
		);
	});

	it("passes the shared encoded command to injected win32 session creation", () => {
		let plannedArgv: string[] | undefined;
		__setCreateOwnerIsolationForTests({
			execute: plan => {
				if (!plan.ok) throw new Error("expected owner-isolation plan");
				plannedArgv = plan.execution.argv;
				return { ok: false, code: "scope_bootstrap_failed", diagnostic: "test-stop" };
			},
		});
		const stateFile = "C:\\Users\\O'Brien\\runtime-state.json";
		expect(() =>
			createGjcTmuxSession(
				{
					GJC_PSMUX_DETECTION: "off",
					GJC_TMUX_COMMAND: "tmux",
					GJC_TMUX_SESSION: "psmux-session",
					GJC_COORDINATOR_SESSION_ID: "operator's session",
					GJC_COORDINATOR_SESSION_STATE_FILE: stateFile,
				},
				{ platform: "win32" },
			),
		).toThrow("gjc_tmux_owner_isolation_scope_bootstrap_failed:test-stop");
		expect(plannedArgv?.slice(0, -1)).toEqual(["tmux", "new-session", "-d", "-s", "psmux-session"]);

		const innerCommand = plannedArgv?.at(-1);
		const encodedMatch = innerCommand?.match(/-EncodedCommand\s+(\S+)/);
		expect(encodedMatch).not.toBeNull();
		if (!encodedMatch) throw new Error("expected session new-command encoded command");
		const script = Buffer.from(encodedMatch[1], "base64").toString("utf16le");
		const generation = script.match(/\$env:GJC_TMUX_OWNER_GENERATION = '([^']+)'/)?.[1];
		expect(generation).toBeDefined();
		if (!generation) throw new Error("expected generated owner identity");
		expect(innerCommand).toBe(
			buildWindowsPowerShellInnerCommand({
				command: ["gjc"],
				environment: {
					GJC_TMUX_LAUNCHED: "1",
					GJC_TMUX_OWNER_GENERATION: generation,
					GJC_TMUX_OWNER_STATE_DIR: "C:\\Users\\O'Brien",
					GJC_TMUX_OWNER_SERVER_KEY: "tmux",
					GJC_COORDINATOR_SESSION_ID: "operator's session",
					GJC_COORDINATOR_SESSION_STATE_FILE: stateFile,
				},
			}),
		);
	});
	it("refuses psmux before attach-session mutation", () => {
		__setBinaryResolverForTests(candidate => (candidate === "psmux" ? "/fake/psmux" : null));
		try {
			const calls: string[][] = [];
			const spawnSyncSpy = spyOn(Bun, "spawnSync") as unknown as SpawnSyncSpy;
			spawnSyncSpy.mockImplementation((cmd: string[]) => {
				calls.push(cmd);
				return spawnResult(0, "");
			});
			expect(() =>
				attachGjcTmuxSession("managed", {
					GJC_TMUX_COMMAND: "psmux",
					GJC_PSMUX_COMMAND: "psmux",
				}),
			).toThrow("gjc_tmux_owner_unverifiable:managed");
			expect(calls.some(cmd => cmd.includes("attach-session"))).toBe(false);
		} finally {
			__setBinaryResolverForTests(null);
		}
	});

	it("refuses an unbound native creation receipt before tagging or cleanup", () => {
		injectSafeMutationProof();
		let probeCount = 0;
		__setCreateOwnerIsolationForTests({
			probe: {
				readCallerCgroup: () => "0::/user.slice/user-1000.slice/user@1000.service/gjc-owner-test.scope\n",
				probeServer: () => {
					probeCount += 1;
					return probeCount === 1
						? { state: "absent" }
						: {
								state: "safe",
								pid: 1,
								startTime: "test",
								cgroup: { classification: "safe" },
							};
				},
			},
			execute: plan => ({
				ok: true,
				code: "executed",
				execution: plan.ok ? plan.execution : (undefined as never),
				server: {
					state: "safe",
					pid: 1,
					startTime: "test",
					cgroup: { classification: "safe" },
				},
				server_key: "tmux",
				server_pid: 1,
				server_start_time: "test",
				server_session: "managed",
				native_session_id: "$wrong",
			}),
		});
		const calls: string[][] = [];
		const spawnSyncSpy = spyOn(Bun, "spawnSync") as unknown as SpawnSyncSpy;
		spawnSyncSpy.mockImplementation((cmd: string[]) => {
			calls.push(cmd);
			if (cmd.includes("display-message")) return spawnResult(0, "$intended\n");
			return spawnResult(0, "");
		});
		expect(() =>
			createGjcTmuxSession({
				GJC_TMUX_COMMAND: "tmux",
				GJC_TMUX_SESSION: "managed",
				GJC_COORDINATOR_SESSION_STATE_FILE: path.join(os.tmpdir(), `gjc-unbound-${crypto.randomUUID()}.json`),
			}),
		).toThrow("gjc_tmux_owner_changed_after_create");
		expect(calls.some(cmd => cmd.includes("set-option") || cmd.includes("set-window-option"))).toBe(false);
		expect(calls.some(cmd => cmd.includes("kill-session"))).toBe(false);
		expect(calls).toContainEqual([
			"tmux",
			"display-message",
			"-p",
			"-t",
			"=managed:",
			"#{session_id}\t#{session_name}",
		]);
	});

	it("refuses CAS-failure cleanup when a replacement server appears before the guarded kill", async () => {
		const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-tmux-generation-cas-"));
		fixtureDirectories.push(stateDir);
		const calls: string[][] = [];
		let generationRepublished = false;
		let guardedMutationCount = 0;
		__setCreateOwnerIsolationForTests({
			probe: {
				readCallerCgroup: () => "0::/\n",
				probeServer: () => ({ state: "safe", pid: 1, startTime: "test", cgroup: { classification: "safe" } }),
			},
			execute: plan => ({
				ok: true,
				code: "executed",
				execution: plan.ok ? plan.execution : (undefined as never),
				server: { state: "safe", pid: 1, startTime: "test", cgroup: { classification: "safe" } },
				server_key: "tmux",
				server_pid: 1,
				server_start_time: "test",
				server_session: "managed",
				native_session_id: "$1",
			}),
		});
		__setMutationServerProofForTests(() => ({ pid: 1, startTime: "test" }));
		(spyOn(Bun, "spawnSync") as unknown as SpawnSyncSpy).mockImplementation((command: string[]) => {
			calls.push(command);
			if (command.includes("list-sessions")) {
				if (!generationRepublished) {
					generationRepublished = true;
					fsSync.mkdirSync(path.dirname(lifecyclePaths(stateDir, "managed", "racing").generationFile), {
						recursive: true,
					});
					fsSync.writeFileSync(
						lifecyclePaths(stateDir, "managed", "racing").generationFile,
						'{"schema_version":1,"generation":"racing","session_id":"managed","published_at":"2026-01-01T00:00:00.000Z"}',
					);
				}
				return spawnResult(0, "managed\t1\t0\t1770000000\t1\troot\t1\t123\n");
			}
			if (command.includes("if-shell")) {
				guardedMutationCount += 1;
				return spawnResult(
					0,
					guardedMutationCount === 1
						? "__gjc_tmux_guarded_mutation_ok__\n"
						: "__gjc_tmux_guarded_mutation_refused__\n",
				);
			}
			if (command.includes("display-message")) {
				if (command.includes("#{session_id}\t#{session_name}")) return spawnResult(0, "$1\tmanaged\n");
				return spawnResult(0, command.includes("#{session_name}") ? "managed\n" : "$1\n");
			}
			return spawnResult(0, "");
		});
		expect(() =>
			createGjcTmuxSession({
				GJC_TMUX_COMMAND: "tmux",
				GJC_TMUX_SESSION: "managed",
				GJC_COORDINATOR_SESSION_ID: "managed",
				GJC_COORDINATOR_SESSION_STATE_FILE: path.join(stateDir, "runtime-state.json"),
			}),
		).toThrow("gjc_tmux_owner_generation_publish_failed_cleanup_failed");
		expect(calls).toContainEqual([
			"tmux",
			"if-shell",
			"-t",
			"$1",
			"-F",
			expect.stringContaining("#{pid},1"),
			expect.stringContaining('kill-session -t "\\$1"'),
			"display-message -p __gjc_tmux_guarded_mutation_refused__",
		]);
		expect(calls.filter(command => command[1] === "kill-session")).toEqual([]);
	});

	it("refuses profile tagging when a replacement server appears at the receipt-to-tag boundary", () => {
		injectSafeMutationProof();
		__setCreateOwnerIsolationForTests({
			probe: {
				readCallerCgroup: () => "0::/\n",
				probeServer: () => ({ state: "safe", pid: 1, startTime: "test", cgroup: { classification: "safe" } }),
			},
			execute: plan => ({
				ok: true,
				code: "executed",
				execution: plan.ok ? plan.execution : (undefined as never),
				server: { state: "safe", pid: 1, startTime: "test", cgroup: { classification: "safe" } },
				server_key: "tmux",
				server_pid: 1,
				server_start_time: "test",
				server_session: "managed",
				native_session_id: "$1",
			}),
		});
		const calls: string[][] = [];
		(spyOn(Bun, "spawnSync") as unknown as SpawnSyncSpy).mockImplementation(command => {
			calls.push(command);
			if (command.includes("if-shell")) return spawnResult(0, "__gjc_tmux_guarded_mutation_refused__\n");
			if (command.includes("display-message")) {
				if (command.includes("#{session_id}\t#{session_name}")) return spawnResult(0, "$1\tmanaged\n");
				return spawnResult(0, command.includes("#{session_name}") ? "managed\n" : "$1\n");
			}
			return spawnResult(0, "");
		});
		expect(() =>
			createGjcTmuxSession({
				GJC_TMUX_COMMAND: "tmux",
				GJC_TMUX_SESSION: "managed",
				GJC_COORDINATOR_SESSION_STATE_FILE: path.join(os.tmpdir(), `gjc-replacement-${crypto.randomUUID()}.json`),
			}),
		).toThrow("gjc_tmux_profile_tag_failed_cleanup_failed");
		expect(calls.filter(command => command[1] === "set-option" || command[1] === "kill-session")).toEqual([]);
		expect(calls[1]?.slice(0, 6)).toEqual(["tmux", "if-shell", "-t", "$1", "-F", expect.any(String)]);
		expect(calls[1]?.[5]).toContain("#{pid},1");
		expect(calls[1]?.[5]).toContain("#{session_id},$1");
		expect(calls[1]?.[5]).toContain("#{session_name},managed");
		expect(calls[1]?.[6]).toContain('"@gjc-profile" "1"');
		expect(calls[1]?.[7]).toBe("display-message -p __gjc_tmux_guarded_mutation_refused__");
	});

	it("rejects psmux force-close before signal or cleanup", async () => {
		__setBinaryResolverForTests(candidate => (candidate === "psmux" ? "/fake/psmux" : null));
		const signalTerm = vi.fn();
		const cleanupSession = vi.fn();
		try {
			await expect(
				forceCloseGjcTmuxSession(
					"managed",
					{ GJC_TMUX_COMMAND: "psmux", GJC_PSMUX_COMMAND: "psmux" },
					undefined,
					undefined,
					{
						signalTerm,
						cleanupSession,
					},
				),
			).rejects.toThrow("gjc_tmux_owner_unverifiable:managed");
			expect(signalTerm).not.toHaveBeenCalled();
			expect(cleanupSession).not.toHaveBeenCalled();
		} finally {
			__setBinaryResolverForTests(null);
		}
	});
	it("requires a matching SIGTERM verdict before compatibility cleanup", async () => {
		const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-tmux-close-"));
		const sessionId = "session";
		const generation = "generation";
		await fs.mkdir(path.join(stateDir, sessionId, "owner-lifecycle"), {
			recursive: true,
		});
		await fs.writeFile(
			path.join(stateDir, sessionId, "owner-lifecycle", "generation.json"),
			JSON.stringify({
				schema_version: 1,
				session_id: sessionId,
				generation,
				published_at: new Date().toISOString(),
			}),
		);
		const calls: string[][] = [];
		spyOn(Bun, "spawnSync").mockImplementation(((cmd: string[]) => {
			calls.push(cmd);
			if (cmd.includes("if-shell")) return spawnResult(0, "__gjc_tmux_guarded_mutation_ok__\n");
			if (cmd.includes("display-message")) return spawnResult(0, "$0\n");
			if (cmd.includes("list-sessions"))
				return spawnResult(
					0,
					`managed\t1\t0\t1770000000\t1\troot\t1\t321\t\t\t\tsession\t${path.join(stateDir, "marker")}\t${generation}\t\n`,
				);
			if (cmd.includes("list-panes")) return spawnResult(0, "321\n");
			if (cmd.includes("show-options")) {
				const option = cmd.at(-1);
				return spawnResult(
					0,
					option === "@gjc-profile"
						? "1\n"
						: option === "@gjc-session-id"
							? "session\n"
							: option === "@gjc-owner-generation"
								? `${generation}\n`
								: option === "@gjc-owner-server-key"
									? "managed\n"
									: `${path.join(stateDir, "marker")}\n`,
				);
			}
			return spawnResult(0, "");
		}) as unknown as typeof Bun.spawnSync);
		injectSafeMutationProof();
		let signaled = false;
		await forceCloseGjcTmuxSession(
			"managed",
			{ GJC_TMUX_COMMAND: "tmux" },
			sessionId,
			path.join(stateDir, "marker"),
			{
				resolveOwner: async () => ({
					sessionId,
					stateDir,
					socketKey: "managed",
					generation,
					pid: 321,
					startTime: "10",
				}),
				readProcessStartTime: async () => "10",
				signalTerm: () => {
					signaled = true;
				},
				sleep: async () => {
					const intent = JSON.parse(
						await fs.readFile(
							path.join(stateDir, sessionId, "owner-lifecycle", `intent-${generation}.json`),
							"utf8",
						),
					);
					await observeOwnerTerminal({
						schema_version: 1,
						op: "observe_terminal",
						session_id: sessionId,
						owner_generation: generation,
						state_dir: stateDir,
						socket_key: "managed",
						observer: "sidecar",
						observed_at: new Date().toISOString(),
						signal: "SIGTERM",
						exit_code: null,
						exit_kind: "exit",
						reason: "test",
						operator_dispatch_id: intent.dispatch_id,
					});
				},
			},
		);
		expect(signaled).toBe(true);
		expect(
			JSON.parse(await fs.readFile(path.join(stateDir, sessionId, "owner-lifecycle", "verdict.json"), "utf8")),
		).toMatchObject({ owner_generation: generation, generation });
		expect(calls).toEqual(
			expect.arrayContaining([
				["tmux", "list-panes", "-s", "-t", "$0", "-F", "#{pane_pid}"],
				["tmux", "display-message", "-p", "-t", "$0", "#{session_id}"],
				["tmux", "show-options", "-qv", "-t", "$0", "@gjc-profile"],
				[
					"tmux",
					"if-shell",
					"-t",
					"$0",
					"-F",
					expect.any(String),
					expect.stringContaining("kill-session -t '$0'"),
					"display-message -p __gjc_tmux_guarded_mutation_refused__",
				],
			]),
		);
		await fs.rm(stateDir, { recursive: true, force: true });
	});

	it("surfaces an exact compatibility cleanup failure after a matching SIGTERM verdict", async () => {
		const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-tmux-close-cleanup-failure-"));
		const sessionId = "session";
		const generation = "generation";
		const marker = path.join(stateDir, "marker");
		await fs.mkdir(path.join(stateDir, sessionId, "owner-lifecycle"), {
			recursive: true,
		});
		await fs.writeFile(
			path.join(stateDir, sessionId, "owner-lifecycle", "generation.json"),
			JSON.stringify({
				schema_version: 1,
				session_id: sessionId,
				generation,
				published_at: new Date().toISOString(),
			}),
		);
		spyOn(Bun, "spawnSync").mockImplementation(((command: string[]) => {
			if (command.includes("display-message")) return spawnResult(0, "$0\n");
			if (command.includes("list-sessions"))
				return spawnResult(
					0,
					`managed\t1\t0\t1770000000\t1\troot\t1\t321\t\t\t\t${sessionId}\t${marker}\t${generation}\tmanaged\n`,
				);
			if (command.includes("list-panes")) return spawnResult(0, "321\n");
			if (command.includes("show-options")) {
				const option = command.at(-1);
				return spawnResult(
					0,
					option === "@gjc-profile"
						? "1\n"
						: option === "@gjc-session-id"
							? `${sessionId}\n`
							: option === "@gjc-owner-generation"
								? `${generation}\n`
								: option === "@gjc-owner-server-key"
									? "managed\n"
									: `${marker}\n`,
				);
			}
			return spawnResult(0, "");
		}) as unknown as typeof Bun.spawnSync);
		injectSafeMutationProof();
		await expect(
			forceCloseGjcTmuxSession("managed", { GJC_TMUX_COMMAND: "tmux" }, sessionId, marker, {
				resolveOwner: async () => ({
					sessionId,
					stateDir,
					socketKey: "managed",
					generation,
					pid: 321,
					startTime: "10",
				}),
				readProcessStartTime: async () => "10",
				signalTerm: () => {},
				sleep: async () => {
					const intent = JSON.parse(
						await fs.readFile(
							path.join(stateDir, sessionId, "owner-lifecycle", `intent-${generation}.json`),
							"utf8",
						),
					);
					await observeOwnerTerminal({
						schema_version: 1,
						op: "observe_terminal",
						session_id: sessionId,
						owner_generation: generation,
						state_dir: stateDir,
						socket_key: "managed",
						observer: "sidecar",
						observed_at: new Date().toISOString(),
						signal: "SIGTERM",
						exit_code: null,
						exit_kind: "exit",
						reason: "test",
						operator_dispatch_id: intent.dispatch_id,
					});
				},
				cleanupSession: () => {
					throw new Error("no server running");
				},
			}),
		).rejects.toThrow("no server running");
		await fs.rm(stateDir, { recursive: true, force: true });
	});

	it("does not kill a same-name replacement when the original native session ID disappears during verdict observation", async () => {
		const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-tmux-close-replacement-"));
		const sessionId = "session";
		const generation = "generation";
		const marker = path.join(stateDir, "marker");
		await fs.mkdir(path.join(stateDir, sessionId, "owner-lifecycle"), {
			recursive: true,
		});
		await fs.writeFile(
			path.join(stateDir, sessionId, "owner-lifecycle", "generation.json"),
			JSON.stringify({
				schema_version: 1,
				session_id: sessionId,
				generation,
				published_at: new Date().toISOString(),
			}),
		);
		let replacementPublished = false;
		const cleanupSession = vi.fn();
		const originalNativeSessionId = "$0";
		const replacementNativeSessionId = "$1";
		spyOn(Bun, "spawnSync").mockImplementation(((command: string[]) => {
			if (command.includes("display-message")) {
				const target = command[command.indexOf("-t") + 1];
				if (target === originalNativeSessionId && replacementPublished)
					return spawnResult(1, "", "can't find session");
				return spawnResult(
					0,
					target === "=managed:"
						? `${replacementPublished ? replacementNativeSessionId : originalNativeSessionId}\n`
						: "",
				);
			}
			if (command.includes("list-sessions"))
				return spawnResult(
					0,
					`managed\t1\t0\t1770000000\t1\troot\t1\t321\t\t\t\t${sessionId}\t${marker}\t${generation}\tmanaged\n`,
				);
			if (command.includes("list-panes")) return spawnResult(0, "321\n");
			if (command.includes("show-options")) {
				const option = command.at(-1);
				return spawnResult(
					0,
					option === "@gjc-profile"
						? "1\n"
						: option === "@gjc-session-id"
							? `${sessionId}\n`
							: option === "@gjc-owner-generation"
								? `${generation}\n`
								: option === "@gjc-owner-server-key"
									? "managed\n"
									: `${marker}\n`,
				);
			}
			return spawnResult(0, "");
		}) as unknown as typeof Bun.spawnSync);
		injectSafeMutationProof();
		await expect(
			forceCloseGjcTmuxSession("managed", { GJC_TMUX_COMMAND: "tmux" }, sessionId, marker, {
				resolveOwner: async () => ({
					sessionId,
					stateDir,
					socketKey: "managed",
					generation,
					pid: 321,
					startTime: "10",
				}),
				readProcessStartTime: async () => "10",
				signalTerm: () => {},
				sleep: async () => {
					const intent = JSON.parse(
						await fs.readFile(
							path.join(stateDir, sessionId, "owner-lifecycle", `intent-${generation}.json`),
							"utf8",
						),
					);
					await observeOwnerTerminal({
						schema_version: 1,
						op: "observe_terminal",
						session_id: sessionId,
						owner_generation: generation,
						state_dir: stateDir,
						socket_key: "managed",
						observer: "sidecar",
						observed_at: new Date().toISOString(),
						signal: "SIGTERM",
						exit_code: null,
						exit_kind: "exit",
						reason: "test",
						operator_dispatch_id: intent.dispatch_id,
					});
					replacementPublished = true;
				},
				cleanupSession,
			}),
		).rejects.toThrow("gjc_tmux_owner_changed:managed");
		expect(cleanupSession).not.toHaveBeenCalled();
		expect(Bun.spawnSync).toHaveBeenCalledWith(
			["tmux", "display-message", "-p", "-t", originalNativeSessionId, "#{session_id}"],
			expect.any(Object),
		);
		await fs.rm(stateDir, { recursive: true, force: true });
	});

	it("rejects a missing native session ID before SIGTERM or cleanup", async () => {
		const signalTerm = vi.fn();
		const cleanupSession = vi.fn();
		(spyOn(Bun, "spawnSync") as unknown as SpawnSyncSpy).mockImplementation((command: string[]) => {
			if (command.includes("display-message")) return spawnResult(0, "");
			if (command.includes("list-sessions"))
				return spawnResult(
					0,
					"managed\t1\t0\t1770000000\t1\troot\t1\t321\t\t\t\tsession\t/state/marker\tgeneration\t\n",
				);
			if (command.includes("list-panes")) return spawnResult(0, "321\n");
			if (command.includes("show-options")) {
				const option = command.at(-1);
				return spawnResult(
					0,
					option === "@gjc-profile"
						? "1\n"
						: option === "@gjc-session-id"
							? "session\n"
							: option === "@gjc-owner-generation"
								? "generation\n"
								: option === "@gjc-owner-server-key"
									? "managed\n"
									: "/state/marker\n",
				);
			}
			return spawnResult(0, "");
		});
		await expect(
			forceCloseGjcTmuxSession("managed", { GJC_TMUX_COMMAND: "tmux" }, undefined, undefined, {
				resolveOwner: async () => ({
					sessionId: "session",
					stateDir: "/state",
					socketKey: "managed",
					generation: "generation",
					pid: 321,
					startTime: "10",
				}),
				readProcessStartTime: async () => "10",
				signalTerm,
				cleanupSession,
			}),
		).rejects.toThrow("gjc_tmux_owner_unverifiable:managed");
		expect(signalTerm).not.toHaveBeenCalled();
		expect(cleanupSession).not.toHaveBeenCalled();
	});

	it("rejects PID start-time mismatch before creating an intent or cleanup", async () => {
		const cleanupSession = vi.fn();
		spyOn(Bun, "spawnSync").mockImplementation(((cmd: string[]) => {
			if (cmd.includes("display-message")) return spawnResult(0, "$0\n");
			if (cmd.includes("list-sessions"))
				return spawnResult(
					0,
					"managed\t1\t0\t1770000000\t1\troot\t1\t321\t\t\t\tsession\t/missing/marker\tgeneration\t\n",
				);

			if (cmd.includes("list-panes")) return spawnResult(0, "321\n");
			if (cmd.includes("show-options")) {
				const option = cmd.at(-1);
				return spawnResult(
					0,
					option === "@gjc-profile"
						? "1\n"
						: option === "@gjc-session-id"
							? "session\n"
							: option === "@gjc-owner-generation"
								? "generation\n"
								: option === "@gjc-owner-server-key"
									? "managed\n"
									: "/missing/marker\n",
				);
			}
			return spawnResult(0, "");
		}) as unknown as typeof Bun.spawnSync);
		injectSafeMutationProof();
		await expect(
			forceCloseGjcTmuxSession("managed", { GJC_TMUX_COMMAND: "tmux" }, undefined, undefined, {
				resolveOwner: async () => ({
					sessionId: "session",
					stateDir: "/missing",
					socketKey: "managed",
					generation: "generation",
					pid: 321,
					startTime: "10",
				}),
				readProcessStartTime: async () => "11",
				cleanupSession,
			}),
		).rejects.toThrow("owner_pid_identity_mismatch");
		expect(cleanupSession).not.toHaveBeenCalled();
	});
	it("cancels an intent when the owner PID changes after the initial start-time proof", async () => {
		const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-tmux-close-race-"));
		const sessionId = "session";
		const generation = "generation";
		const marker = path.join(stateDir, "marker");
		await fs.mkdir(path.join(stateDir, sessionId, "owner-lifecycle"), {
			recursive: true,
		});
		await fs.writeFile(
			path.join(stateDir, sessionId, "owner-lifecycle", "generation.json"),
			JSON.stringify({
				schema_version: 1,
				session_id: sessionId,
				generation,
				published_at: new Date().toISOString(),
			}),
		);
		const signalTerm = vi.fn();
		const cleanupSession = vi.fn();
		spyOn(Bun, "spawnSync").mockImplementation(((cmd: string[]) => {
			if (cmd.includes("display-message")) return spawnResult(0, "$0\n");
			if (cmd.includes("list-sessions"))
				return spawnResult(
					0,
					`managed\t1\t0\t1770000000\t1\troot\t1\t321\t\t\t\t${sessionId}\t${marker}\t${generation}\tmanaged\n`,
				);
			if (cmd.includes("list-panes")) return spawnResult(0, "321\n");
			if (cmd.includes("show-options")) {
				const option = cmd.at(-1);
				return spawnResult(
					0,
					option === "@gjc-profile"
						? "1\n"
						: option === "@gjc-session-id"
							? `${sessionId}\n`
							: option === "@gjc-owner-generation"
								? `${generation}\n`
								: option === "@gjc-owner-server-key"
									? "managed\n"
									: `${marker}\n`,
				);
			}
			return spawnResult(0, "");
		}) as unknown as typeof Bun.spawnSync);
		injectSafeMutationProof();
		let startTimeRead = 0;
		await expect(
			forceCloseGjcTmuxSession("managed", { GJC_TMUX_COMMAND: "tmux" }, sessionId, marker, {
				resolveOwner: async () => ({
					sessionId,
					stateDir,
					socketKey: "managed",
					generation,
					pid: 321,
					startTime: "10",
				}),
				readProcessStartTime: async () => (startTimeRead++ < 2 ? "10" : "11"),
				signalTerm,
				cleanupSession,
			}),
		).rejects.toThrow("owner_pid_identity_mismatch");
		expect(signalTerm).not.toHaveBeenCalled();
		expect(cleanupSession).not.toHaveBeenCalled();
		await expect(
			fs.access(path.join(stateDir, sessionId, "owner-lifecycle", `intent-${generation}.json.cancelled`)),
		).resolves.toBeNull();
		await fs.rm(stateDir, { recursive: true, force: true });
	});
});
