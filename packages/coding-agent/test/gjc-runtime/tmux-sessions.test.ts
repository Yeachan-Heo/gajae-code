import { afterEach, beforeEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildWindowsPowerShellInnerCommand } from "@gajae-code/coding-agent/gjc-runtime/launch-tmux";
import { isManagedOwnerBinding } from "@gajae-code/coding-agent/gjc-runtime/managed-owner-binding";
import {
	__setBinaryResolverForTests,
	__setExecutableIdentityResolverForTests,
	clearPsmuxDetectionCache,
} from "@gajae-code/coding-agent/gjc-runtime/psmux-detect";
import { tmuxRuntimeSessionPath } from "@gajae-code/coding-agent/gjc-runtime/session-layout";
import {
	buildGjcTmuxExactOptionTarget,
	buildGjcTmuxExactSessionTarget,
	buildGjcTmuxSessionSlug,
	buildGjcTmuxUntaggedSessionHint,
} from "@gajae-code/coding-agent/gjc-runtime/tmux-common";
import {
	captureOwnerGenerationBaselineSync,
	isValidOwnerIntent,
	isValidOwnerVerdict,
	lifecyclePaths,
	observeOwnerTerminal,
	readSecureOwnerJson,
	replaceOwnerGenerationSync,
} from "@gajae-code/coding-agent/gjc-runtime/tmux-owner-isolation";
import {
	__setTmuxProviderAuthorityPlatformForTests,
	bindGjcTmuxProviderAuthority,
	persistGjcTmuxProviderAuthoritySync,
	resolveGjcTmuxProviderContext,
} from "@gajae-code/coding-agent/gjc-runtime/tmux-provider-context";
import {
	__setCreateOwnerIsolationForTests,
	__setMutationServerProofForTests,
	attachGjcTmuxSession,
	createGjcTmuxSession,
	createManagedGjcTmuxSession,
	forceCloseGjcTmuxSession,
	listGjcTmuxSessions,
	removeGjcTmuxSession,
	statusGjcTmuxSession,
} from "@gajae-code/coding-agent/gjc-runtime/tmux-sessions";
import type { Process } from "@gajae-code/natives";
import { nativeProcessBindings } from "@gajae-code/utils/native-process";
import { createSpawnSubstrateProvider } from "../../src/sdk/broker/spawn-substrate";
import { prepareManagedDirectoryRoot } from "../../src/session/internal/managed-session-storage";

// `Bun.spawnSync` is called in two shapes in production: the array form
// (`spawnSync([cmd, ...args], opts)`) and the object form
// (`spawnSync({ cmd: [...], ... })`, used by the psmux probe in psmux-detect).
// Mocks here record argv, so they must accept both or they capture a non-array.
function normalizeSpawnSyncCommand(raw: unknown): string[] {
	if (Array.isArray(raw)) return raw as string[];
	if (raw && typeof raw === "object" && Array.isArray((raw as { cmd?: unknown }).cmd))
		return (raw as { cmd: string[] }).cmd;
	return [];
}

type SpawnSyncResult = Bun.SyncSubprocess<"pipe", "pipe">;
type SpawnSyncCommandMock = (command: string[]) => SpawnSyncResult;
type SpawnSyncSpy = {
	mockImplementation(implementation: SpawnSyncCommandMock): void;
};
// `Bun.spawnSync` has two call forms and production uses both: `runTmux` passes an
// argv array, while `psmux-detect`'s probe runner passes `{ cmd: [...] }`. A mock that
// assumes only the array form yields a non-array here and fails with
// `call.includes is not a function`, which is reachable on POSIX where the probe runs.
const spawnArgv = (value: unknown): string[] => {
	if (Array.isArray(value)) return value as string[];
	const cmd = (value as { cmd?: unknown } | null | undefined)?.cmd;
	return Array.isArray(cmd) ? (cmd as string[]) : [];
};
const fixtureDirectories: string[] = [];
function argv(command: string[] | { cmd: string[] }): string[] {
	return Array.isArray(command) ? command : command.cmd;
}
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
function installPsmuxAuthorityFixture(
	stateDir: string,
	identity: { sessionId?: string; generation?: string } = {},
): void {
	prepareManagedDirectoryRoot(stateDir);
	__setTmuxProviderAuthorityPlatformForTests("win32");
	const context = resolveGjcTmuxProviderContext({
		env: { GJC_TMUX_COMMAND: "psmux", GJC_PSMUX_COMMAND: "psmux" },
		platform: "win32",
	});
	const sessionId = identity.sessionId ?? "psmux-session";
	const generation = identity.generation ?? "psmux-generation";
	const baseline = captureOwnerGenerationBaselineSync(stateDir, sessionId);
	persistGjcTmuxProviderAuthoritySync(
		bindGjcTmuxProviderAuthority(context, {
			stateDir,
			sessionId,
			generation,
		}),
	);
	replaceOwnerGenerationSync(stateDir, sessionId, generation, baseline);
}

describe("GJC tmux session management", () => {
	beforeEach(() => {
		__setBinaryResolverForTests(candidate => (candidate === "tmux" ? "C:\\tools\\tmux.exe" : null));
		__setExecutableIdentityResolverForTests(executablePath => `identity:${executablePath}`);
		spyOn(Bun, "which").mockReturnValue("C:\\tools\\tmux.exe");
	});
	afterEach(async () => {
		vi.restoreAllMocks();
		__setCreateOwnerIsolationForTests(null);
		__setMutationServerProofForTests(null);
		__setBinaryResolverForTests(null);
		__setExecutableIdentityResolverForTests(null);
		__setTmuxProviderAuthorityPlatformForTests(null);
		clearPsmuxDetectionCache();
		await Promise.all(
			fixtureDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })),
		);
	});

	it("lists only GJC-managed tmux sessions", () => {
		spyOn(Bun, "spawnSync").mockReturnValue(
			spawnResult(
				0,
				[
					"gajae_code_abc\t1\t0\t1770000000\t1\troot\t2\t12345\tfeature/demo\tfeature-demo\t/repo-a\t\t\t\t\t\t$1",
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
				"#{session_name}\t#{session_windows}\t#{session_attached}\t#{session_created}\t#{@gjc-profile}\t#{session_key_table}\t#{session_panes}\t#{pane_pid}\t#{@gjc-branch}\t#{@gjc-branch-slug}\t#{@gjc-project}\t#{@gjc-session-id}\t#{@gjc-session-state-file}\t#{@gjc-owner-generation}\t#{@gjc-version}\t#{@gjc-psmux-incarnation}\t#{session_id}",
			],
			expect.any(Object),
		);
	});

	it("returns an empty list when tmux has no server", () => {
		spyOn(Bun, "spawnSync").mockReturnValue(spawnResult(1, "", "no server running on /tmp/tmux"));
		clearPsmuxDetectionCache();

		expect(listGjcTmuxSessions()).toEqual([]);
	});

	it("returns an empty list when the default socket reports an ENOENT connection error", () => {
		spyOn(Bun, "spawnSync").mockReturnValue(
			spawnResult(1, "", "error connecting to /tmp/tmux-501/default (No such file or directory)"),
		);
		clearPsmuxDetectionCache();

		expect(listGjcTmuxSessions({ GJC_TMUX_COMMAND: "tmux-test" })).toEqual([]);
	});

	it("propagates permission and transport failures that use failed-connect diagnostics", () => {
		let stderr = "failed to connect to server: Permission denied";
		spyOn(Bun, "spawnSync").mockImplementation(((command: unknown) => {
			if (!spawnArgv(command).includes("list-sessions")) return spawnResult(0, "");
			return spawnResult(1, "", stderr);
		}) as never);
		clearPsmuxDetectionCache();

		expect(() => listGjcTmuxSessions({ GJC_TMUX_COMMAND: "tmux-test" })).toThrow(stderr);

		stderr = "failed to connect to server: Connection refused";
		clearPsmuxDetectionCache();
		expect(() => listGjcTmuxSessions({ GJC_TMUX_COMMAND: "tmux-test" })).toThrow(stderr);
	});

	// A terminal host that emulates tmux for its own agents can export a `$TMUX`
	// naming a socket it never created. tmux then fails with `error connecting
	// to <socket>`, which shares its shape with a legitimate "no server" miss —
	// so gjc used to report zero sessions while sessions were live on the
	// default socket.
	it("retries on the default socket when the inherited $TMUX socket is unreachable", () => {
		const inheritedSocket = "/tmp/host-emulated/agent-team";
		const sessionRow =
			"gajae_code_abc\t1\t0\t1770000000\t1\troot\t2\t12345\tfeature/demo\tfeature-demo\t/repo-a\t\t\t\t\t\t$1";
		const observedTmux: (string | undefined)[] = [];
		spyOn(Bun, "spawnSync").mockImplementation(((command: unknown, options: unknown) => {
			if (!spawnArgv(command).includes("list-sessions")) return spawnResult(0, "");
			const inherited = (options as { env?: NodeJS.ProcessEnv } | undefined)?.env?.TMUX;
			observedTmux.push(inherited);
			if (inherited) return spawnResult(1, "", `error connecting to ${inheritedSocket} (No such file or directory)`);
			return spawnResult(0, sessionRow);
		}) as never);
		clearPsmuxDetectionCache();

		const sessions = listGjcTmuxSessions({ GJC_TMUX_COMMAND: "tmux-test", TMUX: `${inheritedSocket},0,1` });

		expect(sessions.map(session => session.name)).toEqual(["gajae_code_abc"]);
		expect(observedTmux[0]).toBe(`${inheritedSocket},0,1`);
		expect(observedTmux).toContain(undefined);
	});

	it("retries when an inherited socket uses the alternate failed-connect ENOENT diagnostic", () => {
		const inheritedSocket = "/tmp/host-emulated/agent-team";
		const observedTmux: (string | undefined)[] = [];
		spyOn(Bun, "spawnSync").mockImplementation(((command: unknown, options: unknown) => {
			if (!spawnArgv(command).includes("list-sessions")) return spawnResult(0, "");
			const inherited = (options as { env?: NodeJS.ProcessEnv } | undefined)?.env?.TMUX;
			observedTmux.push(inherited);
			if (inherited)
				return spawnResult(1, "", `failed to connect to server: ${inheritedSocket} (No such file or directory)`);
			return spawnResult(0, "gajae_code_alt\t1\t0\t1770000000\t1\troot\t1\t12345\t\t\t\t\t\t\t\t$2");
		}) as never);
		clearPsmuxDetectionCache();

		expect(listGjcTmuxSessions({ GJC_TMUX_COMMAND: "tmux-test", TMUX: `${inheritedSocket},0,1` })).toHaveLength(1);
		expect(observedTmux).toEqual([`${inheritedSocket},0,1`, undefined]);
	});

	it("does not retry a case-mismatched socket path on case-sensitive hosts", () => {
		let listCalls = 0;
		spyOn(Bun, "spawnSync").mockImplementation(((command: unknown) => {
			if (!spawnArgv(command).includes("list-sessions")) return spawnResult(0, "");
			listCalls += 1;
			return spawnResult(1, "", "error connecting to /TMP/host-emulated/agent-team (No such file or directory)");
		}) as never);
		clearPsmuxDetectionCache();

		if (process.platform === "win32") return;
		expect(listGjcTmuxSessions({ GJC_TMUX_COMMAND: "tmux-test", TMUX: "/tmp/host-emulated/agent-team,0,1" })).toEqual(
			[],
		);
		expect(listCalls).toBe(1);
	});

	it("still reports an empty list when the default socket has no server either", () => {
		const inheritedSocket = "/tmp/host-emulated/agent-team";
		spyOn(Bun, "spawnSync").mockImplementation(((command: unknown, options: unknown) => {
			if (!spawnArgv(command).includes("list-sessions")) return spawnResult(0, "");
			return (options as { env?: NodeJS.ProcessEnv } | undefined)?.env?.TMUX
				? spawnResult(1, "", `error connecting to ${inheritedSocket} (No such file or directory)`)
				: spawnResult(1, "", "no server running on /tmp/tmux-501/default");
		}) as never);
		clearPsmuxDetectionCache();

		expect(listGjcTmuxSessions({ GJC_TMUX_COMMAND: "tmux-test", TMUX: `${inheritedSocket},0,1` })).toEqual([]);
	});

	it("does not retry when the failure does not name the inherited socket", () => {
		let listCalls = 0;
		spyOn(Bun, "spawnSync").mockImplementation(((command: unknown) => {
			if (!spawnArgv(command).includes("list-sessions")) return spawnResult(0, "");
			listCalls += 1;
			return spawnResult(1, "", "no server running on /tmp/tmux-501/default");
		}) as never);
		clearPsmuxDetectionCache();

		expect(listGjcTmuxSessions({ GJC_TMUX_COMMAND: "tmux-test" })).toEqual([]);
		expect(listCalls).toBe(1);
	});

	it("does not retry when the error names a longer socket path with the inherited path as a prefix", () => {
		let listCalls = 0;
		spyOn(Bun, "spawnSync").mockImplementation(((command: unknown) => {
			if (!spawnArgv(command).includes("list-sessions")) return spawnResult(0, "");
			listCalls += 1;
			return spawnResult(
				1,
				"",
				"error connecting to /tmp/host-emulated/agent-team-stale (No such file or directory)",
			);
		}) as never);
		clearPsmuxDetectionCache();

		expect(listGjcTmuxSessions({ GJC_TMUX_COMMAND: "tmux-test", TMUX: "/tmp/host-emulated/agent-team,0,1" })).toEqual(
			[],
		);
		expect(listCalls).toBe(1);
	});

	it("denies mutations for sessions discovered through an automatic socket fallback", () => {
		const inheritedSocket = "/tmp/host-emulated/agent-team";
		spyOn(Bun, "spawnSync").mockImplementation(((command: unknown, options: unknown) => {
			if (!spawnArgv(command).includes("list-sessions")) return spawnResult(0, "");
			const inherited = (options as { env?: NodeJS.ProcessEnv } | undefined)?.env?.TMUX;
			if (inherited) return spawnResult(1, "", `error connecting to ${inheritedSocket} (No such file or directory)`);
			return spawnResult(0, "gajae_code_fallback\t1\t0\t1770000000\t1\troot\t0\t\t\t\t\t\t\t\t$3");
		}) as never);
		clearPsmuxDetectionCache();

		expect(() =>
			removeGjcTmuxSession("gajae_code_fallback", {
				GJC_TMUX_COMMAND: "tmux-test",
				TMUX: `${inheritedSocket},0,1`,
			}),
		).toThrow("gjc_tmux_fallback_authority_unconfirmed");
	});

	it("reports provider-aware diagnostics before spawning when Windows has no multiplexer", async () => {
		const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-tmux-sessions-test-"));
		fixtureDirectories.push(stateDir);
		__setTmuxProviderAuthorityPlatformForTests("win32");
		__setBinaryResolverForTests(() => null);
		spyOn(Bun, "which").mockReturnValue(null);
		const spawnSyncSpy = spyOn(Bun, "spawnSync");

		expect(() => listGjcTmuxSessions({ GJC_TMUX_OWNER_STATE_DIR: stateDir })).toThrow(
			"gjc_tmux_provider_unavailable — GJC searched for psmux, pmux, and tmux on PATH.",
		);
		expect(spawnSyncSpy).not.toHaveBeenCalled();
	});

	it("guards status and remove to GJC-managed sessions", () => {
		// Pin the resolved command to tmux so the assertions are agnostic to
		// whether the host has psmux / pmux / tmux on PATH. The shared
		// resolveGjcTmuxCommand now picks the first available multiplexer on
		// Windows; we explicitly opt into literal tmux for this guard test.
		const env = { GJC_TMUX_COMMAND: "tmux" };
		const calls: string[][] = [];
		const spawnSyncSpy = spyOn(Bun, "spawnSync") as unknown as SpawnSyncSpy;
		spawnSyncSpy.mockImplementation(command => {
			const cmd = argv(command);
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
	}, 15_000);

	it("refuses a same-name replacement before the final guarded remove", () => {
		const env = { GJC_TMUX_COMMAND: "tmux" };
		const calls: string[][] = [];
		(spyOn(Bun, "spawnSync") as unknown as SpawnSyncSpy).mockImplementation(command => {
			const commandArgv = argv(command);
			calls.push(commandArgv);
			if (commandArgv.includes("list-sessions")) {
				return spawnResult(
					0,
					"gajae_code_work\t1\t0\t1770000000\t1\troot\t0\t\tmain\tmain\t/repo\tsession-1\t/tmp/runtime-state.json\tgeneration-one\t\t$1\n",
				);
			}
			if (commandArgv.includes("display-message")) return spawnResult(0, "$2\n");
			if (commandArgv.includes("show-options")) {
				return spawnResult(0, commandArgv.at(-1) === "@gjc-owner-generation" ? "generation-one\n" : "1\n");
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
			(spyOn(Bun, "spawnSync") as unknown as SpawnSyncSpy).mockImplementation((rawSpawn: unknown) => {
				const command = spawnArgv(rawSpawn);
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
		spawnSyncSpy.mockImplementation((rawSpawn: unknown) => {
			const cmd = spawnArgv(rawSpawn);
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

	it("explains ProviderAuthority recovery for an untagged multiplexer session", () => {
		const hint = buildGjcTmuxUntaggedSessionHint("psmux");
		expect(hint).toContain(
			"persists a ProviderAuthority that binds the exact executable identity and an isolated `-L <namespace>` server namespace",
		);
		expect(hint).toContain(
			"Recover through GJC so it reuses that persisted authority; do not retry against ambient tmux/psmux or a raw `-L` namespace",
		);
		expect(hint).toContain("GJC_TMUX_COMMAND is a binary override, not a shell command line");
	});

	it("hydrates native Windows tmux sessions from exact option reads when list-sessions omits user options", () => {
		const calls: string[][] = [];
		const spawnSyncSpy = spyOn(Bun, "spawnSync") as unknown as SpawnSyncSpy;
		spawnSyncSpy.mockImplementation((rawSpawn: unknown) => {
			const cmd = spawnArgv(rawSpawn);
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
		spawnSyncSpy.mockImplementation((rawSpawn: unknown) => {
			const cmd = spawnArgv(rawSpawn);
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

		const showOptions = calls.find(call => call.includes("show-options") && call.includes("@gjc-profile"));
		expect(showOptions).toEqual(["tmux", "show-options", "-qv", "-t", "=gajae_code_work:", "@gjc-profile"]);
		// Destructive removal targets the re-proven immutable native session ID.
		expect(calls.at(-1)?.[1]).toBe("if-shell");
	});

	it("builds psmux-aware targets for session-scoped commands", () => {
		__setBinaryResolverForTests(candidate =>
			candidate === "tmux" ? "/fake/tmux" : candidate === "psmux" || candidate === "pmux" ? "/fake/psmux" : null,
		);
		__setExecutableIdentityResolverForTests(executablePath => `identity:${executablePath}`);
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
			__setExecutableIdentityResolverForTests(null);
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
			candidate === "tmux" ? "/fake/tmux" : candidate === "psmux" || candidate === "pmux" ? "/fake/psmux" : null,
		);
		__setExecutableIdentityResolverForTests(executablePath => `identity:${executablePath}`);
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
			__setExecutableIdentityResolverForTests(null);
		}
	});

	it("hydrates native psmux sessions even when -F is silently ignored", async () => {
		// Make the resolver recognize psmux and provide a durable namespace authority.
		__setBinaryResolverForTests(candidate => (candidate === "psmux" ? "/fake/psmux" : null));
		__setExecutableIdentityResolverForTests(executablePath => `identity:${executablePath}`);
		const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-tmux-sessions-test-"));
		fixtureDirectories.push(stateDir);
		installPsmuxAuthorityFixture(stateDir);
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
			spawnSyncSpy.mockImplementation((rawSpawn: unknown) => {
				const cmd = spawnArgv(rawSpawn);
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
				GJC_COORDINATOR_SESSION_STATE_FILE: path.join(stateDir, "runtime-state.json"),
			});

			expect(sessions).toHaveLength(1);
			expect(sessions[0].name).toBe("psmux_session");
			expect(sessions[0].profile).toBe("1");
			expect(sessions[0].windows).toBe(1);
			expect(sessions[0].providerAuthority?.command).toBe("/fake/psmux");
			expect(sessions[0].providerAuthority?.namespace).toMatch(/^gjc-[a-f0-9]{32}$/);
			// Follow-up reads use the durable authority's psmux executable and namespace.
			expect(calls).toContainEqual([
				"/fake/psmux",
				"-L",
				expect.stringMatching(/^gjc-[a-f0-9]{32}$/),
				"show-options",
				"-qv",
				"-t",
				"psmux_session",
				"@gjc-profile",
			]);
		} finally {
			__setBinaryResolverForTests(null);
			__setExecutableIdentityResolverForTests(null);
		}
	});
	it("rejects same-name psmux sessions discovered through distinct provider authorities", async () => {
		__setBinaryResolverForTests(candidate => (candidate === "psmux" ? "/fake/psmux" : null));
		__setExecutableIdentityResolverForTests(executablePath => `identity:${executablePath}`);
		const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-tmux-sessions-test-"));
		fixtureDirectories.push(stateDir);
		installPsmuxAuthorityFixture(stateDir);
		installPsmuxAuthorityFixture(stateDir, {
			sessionId: "psmux-session-decoy",
			generation: "psmux-generation-decoy",
		});
		try {
			const spawnSyncSpy = spyOn(Bun, "spawnSync") as unknown as SpawnSyncSpy;
			spawnSyncSpy.mockImplementation((rawSpawn: unknown) => {
				const cmd = spawnArgv(rawSpawn);
				if (cmd.includes("list-sessions"))
					return spawnResult(0, "psmux_session: 1 windows (created Sat Jun 27 17:00:00 2026)\n");
				if (cmd.includes("show-options") && cmd.at(-1) === "@gjc-profile") return spawnResult(0, "@gjc-profile 1");
				return spawnResult(0, "");
			});
			expect(() =>
				listGjcTmuxSessions({
					GJC_TMUX_COMMAND: "psmux",
					GJC_PSMUX_COMMAND: "psmux",
					GJC_COORDINATOR_SESSION_STATE_FILE: path.join(stateDir, "runtime-state.json"),
				}),
			).toThrow("gjc_tmux_provider_authority_ambiguous:psmux_session");
		} finally {
			__setBinaryResolverForTests(null);
			__setExecutableIdentityResolverForTests(null);
		}
	});

	it("fails closed before tagging when native session identity is unavailable", () => {
		const calls: string[][] = [];
		injectSafeAbsentToSafeOwnerProof();
		const spawnSyncSpy = spyOn(Bun, "spawnSync") as unknown as SpawnSyncSpy;
		spawnSyncSpy.mockImplementation((rawSpawn: unknown) => {
			const cmd = spawnArgv(rawSpawn);
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
		// Asserts a Windows-only guard (executable identity). Without the pin an
		// earlier platform guard fires first on POSIX.
		__setTmuxProviderAuthorityPlatformForTests("win32");
		const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-tmux-sessions-test-"));
		fixtureDirectories.push(stateDir);
		__setBinaryResolverForTests(candidate => (candidate === "psmux" ? "/fake/psmux" : null));
		__setExecutableIdentityResolverForTests(() => null);
		try {
			const calls: string[][] = [];
			injectSafeAbsentToSafeOwnerProof();
			const spawnSyncSpy = spyOn(Bun, "spawnSync") as unknown as SpawnSyncSpy;
			spawnSyncSpy.mockImplementation((rawSpawn: unknown) => {
				const cmd = spawnArgv(rawSpawn);
				calls.push(cmd);
				return spawnResult(0, "");
			});
			expect(() =>
				createGjcTmuxSession(
					{
						GJC_TMUX_COMMAND: "psmux",
						GJC_PSMUX_COMMAND: "psmux",
						GJC_TMUX_SESSION: "psmux_session",
						GJC_COORDINATOR_SESSION_STATE_FILE: path.join(stateDir, "runtime-state.json"),
					} as NodeJS.ProcessEnv,
					{ platform: "win32" },
				),
			).toThrow("gjc_tmux_provider_ambiguous: selected Windows psmux executable identity is unavailable");
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

	it("preserves the shared encoded command for unmanaged win32 session creation", () => {
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
					GJC_COORDINATOR_SESSION_ID: "operators-session",
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
					GJC_COORDINATOR_SESSION_ID: "operators-session",
					GJC_COORDINATOR_SESSION_STATE_FILE: stateFile,
				},
			}),
		);
	});
	for (const entry of ["direct", "managed", "broker"] as const) {
		it(`rejects Windows managed launch through ${entry} before probes, allocation, or state writes`, async () => {
			const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-windows-managed-rejected-"));
			fixtureDirectories.push(cwd);
			const launch = {
				childSessionId: "windows-child",
				cwd: path.win32.resolve(cwd),
				argv: ["secret-command", "secret-task"],
				env: { GJC_MANAGED_OWNER_CHILD_TOKEN: "secret-token" },
			};
			const env = { GJC_TMUX_COMMAND: "psmux", GJC_PSMUX_COMMAND: "psmux" };
			const spawn = spyOn(Bun, "spawn").mockImplementation(() => {
				throw new Error("unexpected spawn");
			});
			const spawnSync = spyOn(Bun, "spawnSync").mockImplementation(() => {
				throw new Error("unexpected spawnSync");
			});
			const mkdir = spyOn(fsSync, "mkdirSync");
			const write = spyOn(fsSync, "writeFileSync");
			const open = spyOn(fsSync, "openSync");
			const bunWrite = spyOn(Bun, "write");
			const allocateIdentity = spyOn(crypto, "randomUUID");
			const execute = vi.fn(() => {
				throw new Error("unexpected allocation");
			});
			__setCreateOwnerIsolationForTests({ execute });
			const reason = "gjc_tmux_managed_launch_platform_unsupported:win32";
			if (entry === "broker") {
				const startHeadless = vi.fn(() => {
					throw new Error("unexpected headless fallback");
				});
				const provider = createSpawnSubstrateProvider({
					platform: "win32",
					env,
					selectMultiplexer: () => "psmux",
					startHeadless,
				});
				expect(await provider.launch(launch)).toEqual({
					ok: false,
					code: "substrate_proof_failed",
					message: `psmux substrate launch failed: ${reason}; psmux substrate cleanup could not be verified`,
				});
				expect(startHeadless).not.toHaveBeenCalled();
			} else {
				const create = () =>
					entry === "direct"
						? createGjcTmuxSession(env, { platform: "win32", launch })
						: createManagedGjcTmuxSession(launch, env, { platform: "win32" });
				expect(create).toThrow(new Error(reason));
			}
			expect(spawn).not.toHaveBeenCalled();
			expect(spawnSync).not.toHaveBeenCalled();
			expect(execute).not.toHaveBeenCalled();
			expect(mkdir).not.toHaveBeenCalled();
			expect(write).not.toHaveBeenCalled();
			expect(open).not.toHaveBeenCalled();
			expect(bunWrite).not.toHaveBeenCalled();
			expect(allocateIdentity).not.toHaveBeenCalled();
			expect(await fs.readdir(cwd)).toEqual([]);
		});
	}

	it("passes a structured Broker launch through managed tmux without inheriting the parent session identity", () => {
		let plannedArgv: string[] | undefined;
		__setCreateOwnerIsolationForTests({
			execute: plan => {
				if (!plan.ok) throw new Error("expected owner-isolation plan");
				plannedArgv = plan.execution.argv;
				return { ok: false, code: "scope_bootstrap_failed", diagnostic: "test-stop" };
			},
		});
		const cwd = path.join(os.tmpdir(), `gjc-broker-launch-${crypto.randomUUID()}`);
		expect(() =>
			createGjcTmuxSession(
				{
					GJC_TMUX_COMMAND: "tmux",
					GJC_COORDINATOR_SESSION_ID: "parent-session",
					GJC_COORDINATOR_SESSION_STATE_FILE: path.join(os.tmpdir(), "parent-state.json"),
				},
				{
					platform: "darwin",
					launch: {
						childSessionId: "broker-child",
						cwd,
						argv: ["child-command", "--safe"],
						env: {
							BROKER_CHILD_ENV: "enabled",
							GJC_COORDINATOR_SESSION_ID: "untrusted-parent",
							GJC_MANAGED_OWNER_REDACT_COMMAND: "0",
						},
					},
				},
			),
		).toThrow("gjc_tmux_owner_isolation_scope_bootstrap_failed:test-stop");
		expect(plannedArgv?.slice(0, -1)).toEqual([
			"tmux",
			"new-session",
			"-d",
			"-s",
			"broker-child",
			"-c",
			cwd,
			"-P",
			"-F",
			"#{session_id}",
		]);
		const innerCommand = plannedArgv?.at(-1);
		expect(innerCommand).toContain("GJC_COORDINATOR_SESSION_ID='broker-child'");
		expect(innerCommand).not.toContain("parent-session");
		expect(innerCommand).not.toContain("untrusted-parent");
		expect(innerCommand).toContain("BROKER_CHILD_ENV='enabled'");
		expect(innerCommand).toContain('GJC_MANAGED_OWNER_COMMAND_JSON=\'["child-command","--safe"]\'');
		expect(innerCommand).toContain("GJC_MANAGED_OWNER_REDACT_COMMAND='1'");
	});

	it("cleans the exact created session when managed proof rejects multiple pane PIDs", () => {
		const cwd = path.join(os.tmpdir(), `gjc-managed-proof-cleanup-${crypto.randomUUID()}`);
		const sessionName = "broker-child";
		const stateFile = tmuxRuntimeSessionPath(cwd, sessionName, buildGjcTmuxSessionSlug(sessionName));
		let generation = "";
		__setMutationServerProofForTests(() => ({ pid: 1, startTime: "test" }));
		__setCreateOwnerIsolationForTests({
			execute: plan => ({
				ok: true,
				code: "executed",
				execution: plan.ok ? plan.execution : (undefined as never),
				server: { state: "safe", pid: 1, startTime: "test", cgroup: { classification: "safe" } },
				server_key: "tmux",
				server_pid: 1,
				server_start_time: "test",
				server_session: sessionName,
				native_session_id: "$1",
			}),
		});
		const calls: string[][] = [];
		(spyOn(Bun, "spawnSync") as unknown as SpawnSyncSpy).mockImplementation((rawCommand: unknown) => {
			const command = normalizeSpawnSyncCommand(rawCommand);
			calls.push(command);
			if (command.includes("if-shell")) {
				generation = command.join(" ").match(/@gjc-owner-generation" "([^"]+)"/)?.[1] ?? generation;
				return spawnResult(0, "__gjc_tmux_guarded_mutation_ok__\n");
			}
			if (command.includes("list-sessions"))
				return spawnResult(
					0,
					`${[
						sessionName,
						"1",
						"0",
						"1770000000",
						"1",
						"root",
						"1",
						"101,102",
						"",
						"",
						"",
						sessionName,
						stateFile,
						generation,
						"",
						"",
						"$1",
					].join("\t")}\n`,
				);
			if (command.includes("display-message")) {
				if (command.includes("#{session_id}\t#{session_name}")) return spawnResult(0, `$1\t${sessionName}\n`);
				return spawnResult(0, command.includes("#{session_name}") ? `${sessionName}\n` : "$1\n");
			}
			if (command.includes("show-options")) {
				const option = command.at(-1);
				const value =
					option === "@gjc-profile"
						? "1"
						: option === "@gjc-session-id"
							? sessionName
							: option === "@gjc-session-state-file"
								? stateFile
								: option === "@gjc-owner-generation"
									? generation
									: option === "@gjc-owner-server-key"
										? "tmux"
										: "";
				return spawnResult(0, `${value}\n`);
			}
			return spawnResult(0, "");
		});

		expect(() =>
			createManagedGjcTmuxSession(
				{ childSessionId: sessionName, cwd, argv: ["child-command"] },
				{ GJC_TMUX_COMMAND: "tmux" },
				{ platform: "darwin" },
			),
		).toThrow("gjc_tmux_managed_launch_proof_unavailable");
		const cleanup = calls.find(
			command => command[1] === "if-shell" && command.some(argument => argument.includes("kill-session")),
		);
		expect(cleanup?.[3]).toBe("$1");
		expect(cleanup?.[5]).toContain("#{session_id},$1");
		expect(cleanup?.[5]).toContain(`#{session_name},${sessionName}`);
	});
	it("refuses psmux before attach-session mutation", () => {
		__setBinaryResolverForTests(candidate => (candidate === "psmux" ? "/fake/psmux" : null));
		try {
			const calls: string[][] = [];
			const spawnSyncSpy = spyOn(Bun, "spawnSync") as unknown as SpawnSyncSpy;
			spawnSyncSpy.mockImplementation((rawSpawn: unknown) => {
				const cmd = spawnArgv(rawSpawn);
				calls.push(cmd);
				return spawnResult(0, "");
			});
			expect(() =>
				attachGjcTmuxSession("managed", {
					GJC_TMUX_COMMAND: "psmux",
					GJC_PSMUX_COMMAND: "psmux",
				}),
			).toThrow("gjc_tmux_provider_authority_unavailable");
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
		spawnSyncSpy.mockImplementation((rawSpawn: unknown) => {
			const cmd = spawnArgv(rawSpawn);
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

	it("preserves a created session without publishing when metadata readback drops a required value", async () => {
		const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-tmux-metadata-readback-"));
		fixtureDirectories.push(stateDir);
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
		let generation = "";
		const calls: string[][] = [];
		(spyOn(Bun, "spawnSync") as unknown as SpawnSyncSpy).mockImplementation((rawCommand: unknown) => {
			const command = normalizeSpawnSyncCommand(rawCommand);
			calls.push(command);
			if (command.includes("if-shell")) {
				const match = command.join(" ").match(/@gjc-owner-generation" "([^"]+)"/);
				if (match) generation = match[1] ?? "";
				return spawnResult(0, "__gjc_tmux_guarded_mutation_ok__\n");
			}
			if (command.includes("display-message"))
				return spawnResult(0, command.includes("#{session_id}\t#{session_name}") ? "$1\tmanaged\n" : "$1\n");
			if (command.includes("show-options")) {
				const option = command.at(-1);
				return spawnResult(
					0,
					option === "@gjc-profile"
						? "1\n"
						: option === "@gjc-session-id"
							? ""
							: option === "@gjc-session-state-file"
								? `${path.join(stateDir, "runtime-state.json")}\n`
								: option === "@gjc-owner-generation"
									? `${generation}\n`
									: "tmux\n",
				);
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
		).toThrow("gjc_tmux_created_metadata_mismatch");
		expect(calls.flat().includes("kill-session")).toBe(false);
		expect(fsSync.existsSync(lifecyclePaths(stateDir, "managed", generation).generationFile)).toBe(false);
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
		(spyOn(Bun, "spawnSync") as unknown as SpawnSyncSpy).mockImplementation((rawSpawn: unknown) => {
			const command = spawnArgv(rawSpawn);
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
		let failure: unknown;
		try {
			createGjcTmuxSession({
				GJC_TMUX_COMMAND: "tmux",
				GJC_TMUX_SESSION: "managed",
				GJC_COORDINATOR_SESSION_ID: "managed",
				GJC_COORDINATOR_SESSION_STATE_FILE: path.join(stateDir, "runtime-state.json"),
			});
		} catch (error) {
			failure = error;
		}
		expect(failure).toBeInstanceOf(AggregateError);
		expect((failure as AggregateError).message).toBe("gjc_tmux_precommit_failed_cleanup_failed");
		expect((failure as AggregateError).errors.map(String)).toEqual([
			expect.stringContaining("gjc_tmux_created_metadata_mismatch"),
			expect.stringContaining("gjc_tmux_cleanup_target_changed"),
		]);
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

	it("preserves a created session without publishing when metadata readback changes a required value", async () => {
		const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-tmux-metadata-readback-change-"));
		fixtureDirectories.push(stateDir);
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
		(spyOn(Bun, "spawnSync") as unknown as SpawnSyncSpy).mockImplementation((rawCommand: unknown) => {
			const command = normalizeSpawnSyncCommand(rawCommand);
			calls.push(command);
			if (command.includes("if-shell")) return spawnResult(0, "__gjc_tmux_guarded_mutation_ok__\n");
			if (command.includes("display-message"))
				return spawnResult(0, command.includes("#{session_id}\t#{session_name}") ? "$1\tmanaged\n" : "$1\n");
			if (command.includes("show-options"))
				return spawnResult(0, command.at(-1) === "@gjc-profile" ? "1\n" : "changed\n");
			return spawnResult(0, "");
		});
		expect(() =>
			createGjcTmuxSession({
				GJC_TMUX_COMMAND: "tmux",
				GJC_TMUX_SESSION: "managed",
				GJC_COORDINATOR_SESSION_ID: "managed",
				GJC_COORDINATOR_SESSION_STATE_FILE: path.join(stateDir, "runtime-state.json"),
			}),
		).toThrow("gjc_tmux_created_metadata_mismatch");
		expect(calls.flat().includes("kill-session")).toBe(false);
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
		(spyOn(Bun, "spawnSync") as unknown as SpawnSyncSpy).mockImplementation((rawCommand: unknown) => {
			const command = normalizeSpawnSyncCommand(rawCommand);
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
		).toThrow("gjc_tmux_precommit_failed_cleanup_failed");
		expect(calls.filter(command => command[1] === "set-option" || command[1] === "kill-session")).toEqual([]);
		// Select the guarded-mutation if-shell by content, not by a fixed index: the
		// psmux detection probe issues `-V`/`--version` spawns first on POSIX, so any
		// positional index here is host-dependent.
		const guardedTag = calls.find(command => command[1] === "if-shell");
		expect(guardedTag?.slice(0, 6)).toEqual(["tmux", "if-shell", "-t", "$1", "-F", expect.any(String)]);
		expect(guardedTag?.[5]).toContain("#{pid},1");
		expect(guardedTag?.[5]).toContain("#{session_id},$1");
		expect(guardedTag?.[5]).toContain("#{session_name},managed");
		expect(guardedTag?.[6]).toContain('"@gjc-profile" "1"');
		expect(guardedTag?.[7]).toBe("display-message -p __gjc_tmux_guarded_mutation_refused__");
	});

	it("omits the server PID guard clause when the platform cannot prove a tmux server PID", () => {
		// Non-Linux probes report a placeholder PID. Pinning `#{pid}` to it builds a
		// predicate no live tmux server can satisfy, which used to refuse profile
		// tagging (and its cleanup) on every non-Linux host.
		// Force `platform: "darwin"` so planTmuxOwnerIsolationSync accepts the
		// not_applicable cgroup proof (isSafeServerProof rejects that shape on linux)
		// and the create path reaches the guarded tag/cleanup contract under test.
		__setMutationServerProofForTests(() => ({ pid: 1, startTime: "not-applicable", pidProven: false }));
		__setCreateOwnerIsolationForTests({
			probe: {
				readCallerCgroup: () => null,
				probeServer: () => ({
					state: "safe",
					pid: 1,
					startTime: "not-applicable",
					cgroup: { classification: "not_applicable" },
					pidProven: false,
				}),
			},
			execute: plan => ({
				ok: true,
				code: "executed",
				execution: plan.ok ? plan.execution : (undefined as never),
				server: {
					state: "safe",
					pid: 1,
					startTime: "not-applicable",
					cgroup: { classification: "not_applicable" },
					pidProven: false,
				},
				server_key: "tmux",
				server_pid: 1,
				server_start_time: "not-applicable",
				server_session: "managed",
				native_session_id: "$1",
			}),
		});
		const calls: string[][] = [];
		(spyOn(Bun, "spawnSync") as unknown as SpawnSyncSpy).mockImplementation((rawCommand: unknown) => {
			const command = normalizeSpawnSyncCommand(rawCommand);
			calls.push(command);
			if (command.includes("if-shell")) return spawnResult(0, "__gjc_tmux_guarded_mutation_refused__\n");
			if (command.includes("display-message")) {
				if (command.includes("#{session_id}\t#{session_name}")) return spawnResult(0, "$1\tmanaged\n");
				return spawnResult(0, command.includes("#{session_name}") ? "managed\n" : "$1\n");
			}
			return spawnResult(0, "");
		});
		expect(() =>
			createGjcTmuxSession(
				{
					GJC_TMUX_COMMAND: "tmux",
					GJC_TMUX_SESSION: "managed",
					GJC_COORDINATOR_SESSION_STATE_FILE: path.join(os.tmpdir(), `gjc-unproven-${crypto.randomUUID()}.json`),
				},
				{ platform: "darwin" },
			),
		).toThrow("gjc_tmux_precommit_failed_cleanup_failed");
		const guarded = calls.find(command => command[1] === "if-shell");
		expect(guarded?.slice(0, 5)).toEqual(["tmux", "if-shell", "-t", "$1", "-F"]);
		expect(guarded?.[5]).not.toContain("#{pid}");
		expect(guarded?.[5]).toContain("#{session_id},$1");
		expect(guarded?.[5]).toContain("#{session_name},managed");
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
			).rejects.toThrow("gjc_tmux_provider_authority_unavailable");
			expect(signalTerm).not.toHaveBeenCalled();
			expect(cleanupSession).not.toHaveBeenCalled();
		} finally {
			__setBinaryResolverForTests(null);
		}
	});
	it("refuses a psmux replacement that differs only by incarnation before cleanup", async () => {
		const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-psmux-close-incarnation-"));
		fixtureDirectories.push(stateDir);
		const sessionId = "psmux-session";
		const generation = "psmux-generation";
		const marker = path.join(stateDir, "marker");
		const initialIncarnation = "psmux-incarnation-a";
		let currentIncarnation = initialIncarnation;
		const cleanupSession = vi.fn();
		__setBinaryResolverForTests(candidate => (candidate === "psmux" ? "C:\\psmux\\psmux.exe" : null));
		__setExecutableIdentityResolverForTests(() => "volume:42");
		installPsmuxAuthorityFixture(stateDir, { sessionId, generation });
		spyOn(Bun, "spawnSync").mockImplementation(((command: string[]) => {
			if (command.includes("display-message")) return spawnResult(0, "$0\n");
			if (command.includes("list-sessions"))
				return spawnResult(
					0,
					`managed\t1\t0\t1770000000\t1\troot\t1\t321\t\t\t\t${sessionId}\t${marker}\t${generation}\t\t${initialIncarnation}\t$0\n`,
				);
			if (command.includes("list-panes")) return spawnResult(0, "321\n");
			if (command.includes("show-options")) {
				const option = command.at(-1);
				const value =
					option === "@gjc-profile"
						? "1"
						: option === "@gjc-session-id"
							? sessionId
							: option === "@gjc-owner-generation"
								? generation
								: option === "@gjc-owner-server-key"
									? "managed"
									: option === "@gjc-psmux-incarnation"
										? currentIncarnation
										: marker;
				return spawnResult(0, `${option} ${value}\n`);
			}
			return spawnResult(0, "");
		}) as unknown as typeof Bun.spawnSync);
		injectSafeMutationProof();
		await expect(
			forceCloseGjcTmuxSession(
				"managed",
				{
					GJC_TMUX_COMMAND: "psmux",
					GJC_PSMUX_COMMAND: "psmux",
					GJC_TMUX_OWNER_STATE_DIR: stateDir,
					GJC_COORDINATOR_SESSION_ID: sessionId,
					GJC_TMUX_OWNER_GENERATION: generation,
				},
				sessionId,
				marker,
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
					shutdownModeForTest: "kernel_signal",
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
						currentIncarnation = "psmux-incarnation-b";
					},
					cleanupSession,
				},
			),
		).rejects.toThrow("gjc_tmux_owner_changed:managed");
		expect(cleanupSession).not.toHaveBeenCalled();
	});
	it("recovers a matching durable SIGTERM verdict when the owner-exit observer fails", async () => {
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
		const failedOwnerExitVerdict = Promise.reject(new Error("injected owner-exit observer failure"));
		void failedOwnerExitVerdict.catch(() => {});
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
				shutdownModeForTest: "kernel_signal",
				waitForOwnerExitVerdict: () => failedOwnerExitVerdict,
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
	it("does not extend durable verdict polling beyond the original intent expiry", async () => {
		const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-tmux-close-expiry-"));
		const sessionId = "session";
		const generation = "generation";
		const marker = path.join(stateDir, "marker");
		await fs.mkdir(path.join(stateDir, sessionId, "owner-lifecycle"), { recursive: true });
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
			if (command.includes("if-shell")) return spawnResult(0, "__gjc_tmux_guarded_mutation_ok__\n");
			if (command.includes("display-message")) return spawnResult(0, "$0\n");
			if (command.includes("list-sessions"))
				return spawnResult(
					0,
					`managed\t1\t0\t1770000000\t1\troot\t1\t321\t\t\t\t${sessionId}\t${marker}\t${generation}\t\n`,
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
		const initialNow = Date.now();
		let nowMs = initialNow;
		let sleepCalls = 0;
		let cleaned = false;
		const hangingOwnerExitVerdict = Promise.withResolvers<never>();
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
				shutdownModeForTest: "kernel_signal",
				now: () => new Date(nowMs),
				waitForOwnerExitVerdict: () => hangingOwnerExitVerdict.promise,
				signalTerm: () => {
					nowMs = initialNow + 15_001;
				},
				sleep: async () => {
					sleepCalls++;
				},
				cleanupSession: () => {
					cleaned = true;
				},
			}),
		).rejects.toThrow("owner_term_verdict_timeout");
		expect(sleepCalls).toBe(0);
		expect(cleaned).toBe(false);
		await fs.rm(stateDir, { recursive: true, force: true });
	});

	// The conjunction is the Darwin cooperative contract. Linux deliberately
	// retains the kernel-path exit observer/fallback, tested separately above.
	for (const scenario of [
		"complete",
		...(process.platform === "darwin" ? ["exit_without_verdict", "verdict_without_exit"] : []),
	]) {
		const testName =
			scenario === "complete"
				? "terminates a genuine managed supervisor only after child cleanup and a matching durable verdict"
				: scenario === "exit_without_verdict"
					? "refuses cooperative cleanup when the genuine supervisor exits without publishing a verdict"
					: "refuses cooperative cleanup when the genuine verdict exists but the supervisor remains alive";
		it(testName, async () => {
			// Only tmux metadata/mutation is isolated. Admission, private binding,
			// process provenance, dispatch, child relay and terminal publication are real.
			// Darwin uses cooperative intent; Linux uses the native pinned signal route.
			const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-tmux-close-default-deps-"));
			// Do not register this directory with unconditional afterEach deletion:
			// failed teardown must retain evidence while either process may be alive.
			const sessionId = "session";
			const generation = "generation";
			const marker = path.join(stateDir, "marker");
			const paths = lifecyclePaths(stateDir, sessionId, generation);
			const repoRoot = path.resolve(import.meta.dir, "../../../..");
			const cli = path.join(repoRoot, "packages/coding-agent/src/cli.ts");
			const admissionModule = path.join(
				repoRoot,
				"packages/coding-agent/src/gjc-runtime/managed-owner-admission.ts",
			);
			const readyFile = path.join(stateDir, "child-ready.json");
			const handlerFile = path.join(stateDir, "child-sigterm.json");
			const cleanupFile = path.join(stateDir, "child-cleanup.json");
			const expiredFile = path.join(stateDir, "child-self-expired");
			const childScript = path.join(stateDir, "owned-child.ts");
			const preloadFile = path.join(stateDir, "terminal-fault-preload.ts");
			const faultReachedFile = path.join(stateDir, "terminal-fault-reached");
			const releaseFile = path.join(stateDir, "release-supervisor");
			const holdExpiredFile = path.join(stateDir, "supervisor-hold-expired");
			await fs.mkdir(paths.root, { recursive: true, mode: 0o700 });
			replaceOwnerGenerationSync(stateDir, sessionId, generation, { state: "absent" });
			await fs.writeFile(
				childScript,
				`
import * as fs from "node:fs";
import { admitManagedOwnerBeforeCli } from ${JSON.stringify(admissionModule)};
const admission = await admitManagedOwnerBeforeCli();
if (admission.kind !== "supervised") process.exit(75);
// This fixture owns its shutdown lifecycle; the admission import also loads
// the utility default signal-exit hook, which would preempt delayed cleanup.
process.removeAllListeners("SIGTERM");
let handlerCount = 0;
const expiry = setTimeout(() => {
  fs.writeFileSync(${JSON.stringify(expiredFile)}, "containment-only\\n");
  process.exit(91);
}, 30_000);
process.on("SIGTERM", () => {
  handlerCount++;
  fs.writeFileSync(${JSON.stringify(handlerFile)}, JSON.stringify({ pid: process.pid, parentPid: process.ppid, handlerCount }));
  if (handlerCount !== 1) process.exit(92);
  // Keep the handler installed while cleanup is pending to expose duplicate relay.
  setTimeout(() => {
    fs.writeFileSync(${JSON.stringify(cleanupFile)}, JSON.stringify({ pid: process.pid, parentPid: process.ppid, handlerCount, completed: true }));
    clearTimeout(expiry);
    process.exit(0);
  }, 150);
});
fs.writeFileSync(${JSON.stringify(readyFile)}, JSON.stringify({ pid: process.pid, parentPid: process.ppid, admission: admission.kind, token: process.env.GJC_MANAGED_OWNER_CHILD_TOKEN }));
`,
				{ mode: 0o600 },
			);
			if (scenario !== "complete") {
				// Scoped to the actual supervisor process, before CLI module loading.
				// Do not spoof argv or replace admission, child relay, or terminal data.
				await fs.writeFile(
					preloadFile,
					`
import * as fs from "node:fs";
import { spyOn } from "bun:test";
import * as isolation from ${JSON.stringify(path.join(repoRoot, "packages/coding-agent/src/gjc-runtime/tmux-owner-isolation.ts"))};
const original = isolation.observeOwnerTerminal;
spyOn(isolation, "observeOwnerTerminal").mockImplementation(async request => {
  if (${JSON.stringify(scenario)} === "exit_without_verdict") {
    fs.writeFileSync(${JSON.stringify(faultReachedFile)}, "observer-refused-before-publication\\n");
    throw new Error("fixture_terminal_publication_refused");
  }
  const verdict = await original(request);
  fs.writeFileSync(${JSON.stringify(faultReachedFile)}, "real-verdict-published-supervisor-held\\n");
  const deadline = Date.now() + 30_000;
  while (!fs.existsSync(${JSON.stringify(releaseFile)})) {
    if (Date.now() >= deadline) {
      fs.writeFileSync(${JSON.stringify(holdExpiredFile)}, "containment-only\\n");
      throw new Error("fixture_supervisor_hold_expired");
    }
    await Bun.sleep(20);
  }
  return verdict;
});
`,
					{ mode: 0o600 },
				);
			}
			const childEnv = { ...process.env };
			for (const key of Object.keys(childEnv)) {
				if (
					key.startsWith("GJC_MANAGED_OWNER_") ||
					key.startsWith("GJC_TMUX_OWNER_") ||
					key.includes("CAPABILITY") ||
					key === "GJC_COORDINATOR_SESSION_ID"
				)
					delete childEnv[key];
			}
			// Avoid a CLI malloc-guard re-exec changing the pinned supervisor identity.
			delete childEnv.MallocStackLogging;
			delete childEnv.MallocStackLoggingNoCompact;
			const owner = Bun.spawn(
				[
					process.execPath,
					...(scenario === "complete" ? [] : ["--preload", preloadFile]),
					cli,
					"--internal-managed-owner-supervisor",
				],
				{
					cwd: repoRoot,
					stdin: "ignore",
					stdout: "ignore",
					stderr: "pipe",
					env: {
						...childEnv,
						GJC_COORDINATOR_SESSION_ID: sessionId,
						GJC_TMUX_OWNER_GENERATION: generation,
						GJC_TMUX_OWNER_STATE_DIR: stateDir,
						GJC_TMUX_OWNER_SERVER_KEY: "managed",
						GJC_MANAGED_OWNER_RUN_ID: "close-run",
						GJC_MANAGED_OWNER_INCARNATION: "close-incarnation",
						GJC_MANAGED_OWNER_REDACT_COMMAND: "1",
						GJC_MANAGED_OWNER_COMMAND_JSON: JSON.stringify([process.execPath, childScript]),
					},
				},
			);
			const ownerPid = owner.pid;
			const stderr = new Response(owner.stderr).text();
			let childProcess: Process | null = null;
			let cleanupAtOwnerExit: unknown;
			const ownerExit = owner.exited.then(code => {
				if (fsSync.existsSync(cleanupFile))
					cleanupAtOwnerExit = JSON.parse(fsSync.readFileSync(cleanupFile, "utf8"));
				return code;
			});
			const waitForOwnerExit = async (timeoutMs: number): Promise<boolean> => {
				const timeout = Promise.withResolvers<boolean>();
				const timer = setTimeout(() => timeout.resolve(false), timeoutMs);
				try {
					return await Promise.race([ownerExit.then(() => true), timeout.promise]);
				} finally {
					clearTimeout(timer);
				}
			};
			const calls: string[][] = [];
			const rawPidSignal = spyOn(process, "kill");
			(spyOn(Bun, "spawnSync") as unknown as SpawnSyncSpy).mockImplementation((rawSpawn: unknown) => {
				const cmd = spawnArgv(rawSpawn);
				calls.push(cmd);
				if (cmd.includes("if-shell")) {
					expect(scenario, "incomplete cooperative shutdown must never reach guarded cleanup").toBe("complete");
					// Compatibility cleanup must be last, never the cause of owner exit.
					expect(owner.exitCode).toBe(0);
					expect(childProcess?.status()).toBe(nativeProcessBindings().ProcessStatus.Exited);
					expect(JSON.parse(fsSync.readFileSync(cleanupFile, "utf8"))).toMatchObject({
						completed: true,
						handlerCount: 1,
						parentPid: ownerPid,
					});
					const intent = readSecureOwnerJson(`${paths.intentFile}.consumed`);
					const verdict = readSecureOwnerJson(paths.verdictFile);
					expect(isValidOwnerIntent(intent)).toBe(true);
					expect(isValidOwnerVerdict(verdict)).toBe(true);
					if (!isValidOwnerIntent(intent) || !isValidOwnerVerdict(verdict))
						throw new Error("invalid_real_terminal_evidence");
					expect(verdict.intent_id).toBe(intent.intent_id);
					expect(cmd[cmd.indexOf("-t") + 1]).toBe("$0");
					expect(cmd).toEqual(expect.arrayContaining([expect.stringContaining("kill-session -t '$0'")]));
					return spawnResult(0, "__gjc_tmux_guarded_mutation_ok__\n");
				}
				if (cmd.includes("list-sessions"))
					return spawnResult(
						0,
						`managed\t1\t0\t1770000000\t1\troot\t1\t${ownerPid}\t\t\t\t${sessionId}\t${marker}\t${generation}\t\n`,
					);
				if (cmd.includes("list-panes")) return spawnResult(0, `${ownerPid}\n`);
				if (cmd.includes("display-message")) return spawnResult(0, "$0\n");
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
			});
			injectSafeMutationProof();
			const failures: unknown[] = [];
			try {
				const readyDeadline = Date.now() + 10_000;
				while (!fsSync.existsSync(readyFile) && owner.exitCode === null && Date.now() < readyDeadline)
					await Bun.sleep(20);
				expect(fsSync.existsSync(readyFile), `managed child did not become ready; evidence: ${stateDir}`).toBe(
					true,
				);
				const ready = JSON.parse(await fs.readFile(readyFile, "utf8"));
				expect(ready).toMatchObject({ admission: "supervised", parentPid: ownerPid });
				childProcess = nativeProcessBindings().Process.fromPid(ready.pid);
				if (!childProcess) throw new Error("managed_child_reference_unavailable");
				expect(childProcess?.ppid).toBe(ownerPid);
				const bindingFile = path.join(paths.root, `child-${ready.token}.binding.json`);
				const binding = readSecureOwnerJson(bindingFile);
				expect(isManagedOwnerBinding(binding)).toBe(true);
				expect(binding).toMatchObject({
					schema_version: 3,
					binding_kind: "opaque",
					session_id: sessionId,
					generation,
					run_id: "close-run",
					endpoint_incarnation: "close-incarnation",
					supervisor_pid: ownerPid,
					child_token: ready.token,
				});
				expect(binding).not.toHaveProperty("command");
				expect(binding).not.toHaveProperty("command_sha256");
				expect((await fs.stat(bindingFile)).mode & 0o777).toBe(0o600);
				expect((await fs.stat(paths.root)).mode & 0o777).toBe(0o700);
				if (scenario !== "complete") {
					// Use the original real close deadline: no forged clock, verdict or
					// injected completion callback can turn one half into conjunction.
					await expect(
						forceCloseGjcTmuxSession("managed", { GJC_TMUX_COMMAND: "tmux" }, sessionId, marker),
					).rejects.toThrow("owner_term_verdict_timeout");
					expect(fsSync.existsSync(faultReachedFile)).toBe(true);
					expect(await childProcess.waitForExit({ timeoutMs: 1_000 })).toBe(true);
					expect(JSON.parse(await fs.readFile(cleanupFile, "utf8"))).toEqual({
						pid: ready.pid,
						parentPid: ownerPid,
						handlerCount: 1,
						completed: true,
					});
					expect(JSON.parse(await fs.readFile(handlerFile, "utf8"))).toEqual({
						pid: ready.pid,
						parentPid: ownerPid,
						handlerCount: 1,
					});
					expect(fsSync.existsSync(expiredFile)).toBe(false);
					expect(fsSync.existsSync(holdExpiredFile)).toBe(false);
					expect(calls.filter(cmd => cmd.includes("if-shell"))).toEqual([]);
					expect(
						calls.some(cmd => cmd.some(arg => arg.includes("kill-session") || arg.includes("kill-server"))),
					).toBe(false);
					expect(rawPidSignal).not.toHaveBeenCalled();
					if (scenario === "exit_without_verdict") {
						expect(await fs.readFile(faultReachedFile, "utf8")).toBe("observer-refused-before-publication\n");
						expect(await waitForOwnerExit(1_000)).toBe(true);
						expect(await ownerExit).not.toBe(0);
						expect(cleanupAtOwnerExit).toMatchObject({ completed: true, handlerCount: 1 });
						expect(fsSync.existsSync(paths.verdictFile)).toBe(false);
						expect(fsSync.existsSync(paths.verdictAliasFile)).toBe(false);
						expect(isValidOwnerIntent(readSecureOwnerJson(paths.intentFile))).toBe(true);
					} else {
						expect(await fs.readFile(faultReachedFile, "utf8")).toBe("real-verdict-published-supervisor-held\n");
						expect(owner.exitCode).toBeNull();
						expect(await waitForOwnerExit(100)).toBe(false);
						const intent = readSecureOwnerJson(`${paths.intentFile}.consumed`);
						const verdict = readSecureOwnerJson(paths.verdictFile);
						expect(isValidOwnerIntent(intent)).toBe(true);
						expect(isValidOwnerVerdict(verdict)).toBe(true);
						if (!isValidOwnerIntent(intent) || !isValidOwnerVerdict(verdict))
							throw new Error("missing_real_held_terminal_evidence");
						expect(verdict).toMatchObject({
							intent_id: intent.intent_id,
							session_id: sessionId,
							generation,
							server_key: "managed",
							signal: "SIGTERM",
							classification: "expected_operator_shutdown",
							result: "owner_term_then_session_cleanup",
							exit_code: 0,
							reason: "terminal_observation",
						});
						expect(readSecureOwnerJson(paths.verdictAliasFile)).toEqual({
							...verdict,
							owner_generation: generation,
						});
						await fs.writeFile(releaseFile, "release\n", { mode: 0o600 });
						expect(await waitForOwnerExit(2_000)).toBe(true);
						expect(await ownerExit, await stderr).toBe(0);
						expect(cleanupAtOwnerExit).toMatchObject({ completed: true, handlerCount: 1 });
						expect(fsSync.existsSync(holdExpiredFile)).toBe(false);
					}
				} else {
					await forceCloseGjcTmuxSession("managed", { GJC_TMUX_COMMAND: "tmux" }, sessionId, marker);
					expect(await waitForOwnerExit(1_000)).toBe(true);
					expect(await ownerExit, await stderr).toBe(0);
					expect(owner.signalCode).toBeNull();
					expect(await childProcess.waitForExit({ timeoutMs: 1_000 })).toBe(true);
					expect(cleanupAtOwnerExit).toEqual({
						pid: ready.pid,
						parentPid: ownerPid,
						handlerCount: 1,
						completed: true,
					});
					expect(JSON.parse(await fs.readFile(handlerFile, "utf8"))).toEqual({
						pid: ready.pid,
						parentPid: ownerPid,
						handlerCount: 1,
					});
					expect(fsSync.existsSync(expiredFile)).toBe(false);
					const intent = readSecureOwnerJson(`${paths.intentFile}.consumed`);
					expect(isValidOwnerIntent(intent)).toBe(true);
					if (!isValidOwnerIntent(intent)) throw new Error("missing_real_consumed_intent");
					expect(intent.dispatch_id).not.toBe("");
					expect(readSecureOwnerJson(paths.verdictFile)).toMatchObject({
						intent_id: intent.intent_id,
						session_id: sessionId,
						generation,
						server_key: "managed",
						signal: "SIGTERM",
						result: "owner_term_then_session_cleanup",
						classification: "expected_operator_shutdown",
						exit_code: 0,
						reason: "terminal_observation",
					});
					expect(readSecureOwnerJson(paths.verdictAliasFile)).toEqual({
						...(readSecureOwnerJson(paths.verdictFile) as object),
						owner_generation: generation,
					});
					expect(rawPidSignal).not.toHaveBeenCalled();
					expect(calls.filter(cmd => cmd.includes("if-shell"))).toHaveLength(1);
					expect(calls.some(cmd => cmd.includes("kill-server") || cmd.includes("kill-session"))).toBe(false);
				}
			} catch (error) {
				failures.push(error);
			} finally {
				try {
					try {
						if (scenario === "verdict_without_exit")
							await fs.writeFile(releaseFile, "release\n", { mode: 0o600 });
					} catch {
						// Still perform bounded retained-handle teardown if release fails.
					}
					// Teardown cannot rescue a failed close assertion. The retained spawn
					// handle may request shutdown; never signal a freshly looked-up PID.
					try {
						if (owner.exitCode === null) owner.kill("SIGTERM");
					} catch {
						// A raced exit is settled below, not treated as termination proof.
					}
					const ownerStopped = await waitForOwnerExit(35_000);
					const childStopped = childProcess ? await childProcess.waitForExit({ timeoutMs: 1_000 }) : false;
					if (ownerStopped && childStopped) await fs.rm(stateDir, { recursive: true, force: true });
					else failures.push(new Error(`managed_close_teardown_uncertain:evidence_retained:${stateDir}`));
				} catch (error) {
					failures.push(error);
				}
			}
			if (failures.length > 0) throw new AggregateError(failures, "Managed close verification or teardown failed");
		}, 65_000);
	}

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
				shutdownModeForTest: "kernel_signal",
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
				shutdownModeForTest: "kernel_signal",
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
		(spyOn(Bun, "spawnSync") as unknown as SpawnSyncSpy).mockImplementation((rawSpawn: unknown) => {
			const command = spawnArgv(rawSpawn);
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
				shutdownModeForTest: "kernel_signal",
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
