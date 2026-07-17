import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import SessionCommand from "../src/commands/session";
import * as tmuxSessions from "../src/gjc-runtime/tmux-sessions";

type SpawnSyncMock = {
	mockImplementation: (implementation: (cmd: string[]) => unknown) => void;
	mockRestore?: () => void;
};

const ORIGINAL_STDOUT_WRITE = process.stdout.write.bind(process.stdout);
const REAL_TMUX_SESSIONS = { ...tmuxSessions };

function spawnResult(exitCode: number, stdout = "", stderr = "") {
	return {
		exitCode,
		stdout: Buffer.from(stdout),
		stderr: Buffer.from(stderr),
		signalCode: null,
	};
}

function mockSpawnSync(implementation: (cmd: string[]) => unknown): SpawnSyncMock {
	const spy = spyOn(Bun, "spawnSync") as unknown as SpawnSyncMock;
	spy.mockImplementation(implementation);
	return spy;
}

const READ_ONLY_TMUX_SUBCOMMANDS = new Set([
	"display-message",
	"has-session",
	"list-clients",
	"list-panes",
	"list-sessions",
	"list-windows",
	"show-options",
	"show-window-options",
	"-V",
]);

function tmuxSubcommand(argv: readonly string[]): string | undefined {
	if (argv[0] !== "tmux") return undefined;
	if (argv[1] === "-V") return "-V";

	let index = 1;
	while (argv[index]?.startsWith("-")) {
		const option = argv[index++];
		if (option === "-L" || option === "-S" || option === "-f") index += 1;
	}
	return argv[index];
}

function expectNoTmuxMutation(calls: readonly string[][]): void {
	for (const call of calls) {
		expect(call[0]).toBe("tmux");
		expect(READ_ONLY_TMUX_SUBCOMMANDS.has(tmuxSubcommand(call) ?? "")).toBe(true);
	}
}

function sessionLine(name = "gajae_code_test", branch = ""): string {
	return `${name}\t1\t0\t1770000000\t1\troot\t2\t${branch}\tfeature-demo\n`;
}

function injectSafeAbsentToSafeOwnerProof(plannedExecutions: string[][]): string[] {
	let probeCount = 0;
	const probedSockets: string[] = [];
	tmuxSessions.__setMutationServerProofForTests(() => ({ pid: 1, startTime: "test" }));
	tmuxSessions.__setCreateOwnerIsolationForTests({
		probe: {
			readCallerCgroup: () => "0::/gjc-owner-test.scope\n",
			probeServer: socketKey => {
				probedSockets.push(socketKey);
				expect(socketKey).toBe("tmux");
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
		execute: (plan, deps) => {
			if (!plan.ok) return plan;
			plannedExecutions.push(plan.execution.argv);
			const launched = deps.spawn(plan.execution.argv);
			if (launched.exitCode !== 0)
				return { ok: false, code: "scope_bootstrap_failed", diagnostic: "planned_spawn_failed" };
			const server = deps.probeServer(deps.socketKey);
			return {
				ok: true,
				code: "executed",
				execution: plan.execution,
				server,
				server_key: deps.socketKey,
				server_pid: 1,
				server_start_time: "test",
				server_session: plan.execution.attempt_session,
				native_session_id: "$0",
			};
		},
	});
	return probedSockets;
}

async function runSessionCommand(argv: string[]): Promise<string> {
	let output = "";
	const writeSpy = spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
		output += chunk.toString();
		return true;
	});
	try {
		const command = new SessionCommand(argv, { bin: "gjc", version: "0.0.0-test", commands: new Map() });
		await command.run();
		return output;
	} finally {
		writeSpy.mockRestore();
	}
}

afterEach(() => {
	process.stdout.write = ORIGINAL_STDOUT_WRITE;
	(Bun.spawnSync as unknown as SpawnSyncMock).mockRestore?.();
	mock.module("../src/gjc-runtime/tmux-sessions", () => REAL_TMUX_SESSIONS);
	mock.restore();
	tmuxSessions.__setCreateOwnerIsolationForTests(null);
	tmuxSessions.__setMutationServerProofForTests(null);
});

describe("gjc session command", () => {
	it("emits exact list JSON DTOs with flags before action", async () => {
		mockSpawnSync(() =>
			spawnResult(0, `${sessionLine("gajae_code_test", "feature/demo")}untagged\t1\t0\t1770000001\t\troot\t1\t\t\n`),
		);

		const output = await runSessionCommand(["--json", "list"]);
		const payload = JSON.parse(output);

		expect(payload).toEqual({
			ok: true,
			sessions: [
				{
					name: "gajae_code_test",
					attached: false,
					windows: 1,
					panes: 2,
					bindings: "root",
					createdAt: "2026-02-02T02:40:00.000Z",
				},
			],
		});
	});

	it("emits JSON failure wrappers", async () => {
		mockSpawnSync(() => spawnResult(0, ""));

		const output = await runSessionCommand(["status", "missing", "--json"]);
		const payload = JSON.parse(output);

		expect(payload).toEqual({ ok: false, reason: "gjc_tmux_session_not_found" });
	});

	it("creates and reports a detached managed session as exact JSON DTO", async () => {
		const calls: string[][] = [];
		const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-session-command-"));
		const previousSession = process.env.GJC_TMUX_SESSION;
		const previousStateFile = process.env.GJC_COORDINATOR_SESSION_STATE_FILE;
		process.env.GJC_TMUX_SESSION = "custom_session";
		process.env.GJC_COORDINATOR_SESSION_STATE_FILE = path.join(stateRoot, "state.json");
		const plannedExecutions: string[][] = [];
		const probedSockets = injectSafeAbsentToSafeOwnerProof(plannedExecutions);
		mockSpawnSync((cmd: string[]) => {
			calls.push(cmd);
			const [tmuxCommand] = cmd;
			expect(tmuxCommand).toBe("tmux");
			if (cmd.includes("if-shell")) return spawnResult(0, "__gjc_tmux_guarded_mutation_ok__\n");
			if (cmd.includes("list-sessions")) return spawnResult(0, sessionLine("custom_session"));
			if (cmd.includes("display-message") && cmd.includes("#{session_id}\t#{session_name}"))
				return spawnResult(0, "$0\tcustom_session\n");
			if (cmd.includes("display-message") && cmd.includes("#{session_name}"))
				return spawnResult(0, "custom_session\n");
			if (cmd.includes("display-message") && cmd.includes("#{session_id}")) return spawnResult(0, "$0\n");
			return spawnResult(0, "");
		});
		let output = "";
		try {
			output = await runSessionCommand(["create", "--json"]);
		} finally {
			if (previousSession === undefined) delete process.env.GJC_TMUX_SESSION;
			else process.env.GJC_TMUX_SESSION = previousSession;
			if (previousStateFile === undefined) delete process.env.GJC_COORDINATOR_SESSION_STATE_FILE;
			else process.env.GJC_COORDINATOR_SESSION_STATE_FILE = previousStateFile;
			await fs.rm(stateRoot, { recursive: true, force: true });
		}
		const payload = JSON.parse(output);

		const socket = probedSockets[0];
		expect(probedSockets.length).toBeGreaterThan(0);
		expect(probedSockets.every(probed => probed === socket)).toBe(true);
		expect(plannedExecutions).toHaveLength(1);
		expect(plannedExecutions[0]?.[0]).toBe(socket);
		expect(plannedExecutions[0]).toContain("new-session");
		expect(calls.every(call => call[0] === socket)).toBe(true);
		expect(payload).toEqual({
			ok: true,
			session: {
				name: "custom_session",
				attached: false,
				windows: 1,
				panes: 2,
				bindings: "root",
				createdAt: "2026-02-02T02:40:00.000Z",
			},
		});
	});

	it("refuses unsafe or unverifiable owner servers before any tmux mutation", async () => {
		const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-session-command-preflight-"));
		const previousSession = process.env.GJC_TMUX_SESSION;
		const previousStateFile = process.env.GJC_COORDINATOR_SESSION_STATE_FILE;
		process.env.GJC_TMUX_SESSION = "preflight_session";
		process.env.GJC_COORDINATOR_SESSION_STATE_FILE = path.join(stateRoot, "state.json");
		try {
			for (const state of ["unsafe", "unverifiable"] as const) {
				const calls: string[][] = [];
				const probedServerKeys: string[] = [];
				tmuxSessions.__setCreateOwnerIsolationForTests({
					probe: {
						readCallerCgroup: () => "0::/\n",
						probeServer: socketKey => {
							probedServerKeys.push(socketKey);
							return { state };
						},
					},
				});
				mockSpawnSync((cmd: string[]) => {
					calls.push(cmd);
					return spawnResult(0, "");
				});

				const payload = JSON.parse(await runSessionCommand(["create", "--json"]));
				expect(payload.ok).toBe(false);
				expect(probedServerKeys).toEqual(["tmux"]);
				expectNoTmuxMutation(calls);
				(Bun.spawnSync as unknown as SpawnSyncMock).mockRestore?.();
			}
		} finally {
			if (previousSession === undefined) delete process.env.GJC_TMUX_SESSION;
			else process.env.GJC_TMUX_SESSION = previousSession;
			if (previousStateFile === undefined) delete process.env.GJC_COORDINATOR_SESSION_STATE_FILE;
			else process.env.GJC_COORDINATOR_SESSION_STATE_FILE = previousStateFile;
			await fs.rm(stateRoot, { recursive: true, force: true });
		}
	});

	it("surfaces an untagged-session diagnostic with a detail hint in JSON failures", async () => {
		mockSpawnSync((cmd: string[]) => {
			if (cmd.includes("list-sessions")) {
				const format = cmd[cmd.indexOf("-F") + 1] ?? "";
				if (format === "#{session_name}") return spawnResult(0, "winsess\n");
				return spawnResult(0, "winsess\t1\t0\t1770000000\t\troot\t0\t\t\t\n");
			}
			return spawnResult(0, "");
		});

		const output = await runSessionCommand(["status", "winsess", "--json"]);
		const payload = JSON.parse(output);

		expect(payload.ok).toBe(false);
		expect(payload.reason).toBe("gjc_tmux_session_untagged");
		expect(typeof payload.detail).toBe("string");
		expect(payload.detail).toContain("not fully supported");
		expect(payload.detail).not.toContain(" — ");
	});
	it("awaits force-close before reporting JSON success", async () => {
		const closed = Promise.withResolvers<{
			name: string;
			attached: boolean;
			windows: number;
			panes: number;
			bindings: string;
			createdAt: string;
		}>();
		const received = { args: null as unknown[] | null };
		mock.module("../src/gjc-runtime/tmux-sessions", () => ({
			...REAL_TMUX_SESSIONS,
			forceCloseGjcTmuxSession: (...args: unknown[]) => {
				received.args = args;
				return closed.promise;
			},
		}));

		const result = runSessionCommand([
			"force-close",
			"managed",
			"--session-id",
			"managed-id",
			"--state-file",
			"/state/managed.json",
			"--json",
		]);
		await Bun.sleep(0);
		closed.resolve({
			name: "managed",
			attached: false,
			windows: 1,
			panes: 1,
			bindings: "root",
			createdAt: "2026-02-02T02:40:00.000Z",
		});

		expect(JSON.parse(await result)).toEqual({
			ok: true,
			session: {
				name: "managed",
				attached: false,
				windows: 1,
				panes: 1,
				bindings: "root",
				createdAt: "2026-02-02T02:40:00.000Z",
			},
		});
		expect(received.args).toEqual(["managed", process.env, "managed-id", "/state/managed.json"]);
	});

	it("preserves an asynchronous force-close error instead of reporting success", async () => {
		mock.module("../src/gjc-runtime/tmux-sessions", () => ({
			...REAL_TMUX_SESSIONS,
			forceCloseGjcTmuxSession: async () => {
				throw new Error("owner_term_verdict_timeout");
			},
		}));

		const output = await runSessionCommand(["force-close", "managed", "--json"]);

		expect(JSON.parse(output)).toEqual({ ok: false, reason: "owner_term_verdict_timeout" });
	});
	it("returns exact JSON failures for owner identity and generation mismatches", async () => {
		for (const reason of ["owner_pid_identity_mismatch", "owner_generation_mismatch"]) {
			mock.module("../src/gjc-runtime/tmux-sessions", () => ({
				...REAL_TMUX_SESSIONS,
				forceCloseGjcTmuxSession: async () => {
					throw new Error(reason);
				},
			}));
			const output = await runSessionCommand([
				"force-close",
				"gjc_lc_private",
				"--session-id",
				"private-id",
				"--state-file",
				"/private/state.json",
				"--json",
			]);
			expect(JSON.parse(output)).toEqual({ ok: false, reason });
			mock.restore();
		}
	});
});
