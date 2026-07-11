import { afterEach, describe, expect, it } from "bun:test";
import * as crypto from "node:crypto";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	buildGjcTmuxExactOptionTarget,
	buildGjcTmuxProfileCommands,
} from "@gajae-code/coding-agent/gjc-runtime/tmux-common";
import {
	observeOwnerTerminal,
	replaceOwnerGeneration,
} from "@gajae-code/coding-agent/gjc-runtime/tmux-owner-isolation";
import { forceCloseGjcTmuxSession } from "@gajae-code/coding-agent/gjc-runtime/tmux-sessions";
import { createCoordinatorMcpServer } from "../../src/coordinator-mcp/server";

// BLOCKER 1 (#2044): prove the reaper terminates a *genuine* GJC-managed owned session by driving
// the reaper's real path through the coordinator's stop_session tool. The reaper's injectable
// services.forceCloseSession forwards to the *real* forceCloseGjcTmuxSession with the same
// owner-lifecycle deps the accepted tmux-sessions.integration.test.ts harness uses (a real TERM to
// the real pane + the sidecar verdict observation) — this is the real destructive path, not a
// trivial always-success double. An unrelated GJC session (no coordinator record) must survive.
//
// Owner isolation requires Linux + a systemd user scope, so — like the harness — this only runs
// there and is skipped on hosts without tmux/systemd (e.g. the macOS dev host).
const tmux = Bun.which("tmux");
const systemdRun = Bun.which("systemd-run");
const isLinux = process.platform === "linux";
const userScopeAvailable =
	isLinux &&
	Boolean(systemdRun) &&
	Bun.spawnSync([systemdRun!, "--user", "--scope", "--quiet", "true"], { stdout: "pipe", stderr: "pipe" }).exitCode ===
		0;

const cleanups: Array<{ env: NodeJS.ProcessEnv; stateDir: string; scopeName: string }> = [];

function run(args: string[], env: NodeJS.ProcessEnv): void {
	const result = Bun.spawnSync([env.GJC_TMUX_COMMAND!, ...args], { stdout: "pipe", stderr: "pipe", env });
	if (result.exitCode !== 0) throw new Error(result.stderr.toString());
}

function procStartTime(pid: number): string {
	const stat = fsSync.readFileSync(`/proc/${pid}/stat`, "utf8");
	return stat
		.slice(stat.lastIndexOf(")") + 2)
		.trim()
		.split(/\s+/)[19]!;
}

async function waitForProcessExit(pid: number): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		try {
			process.kill(pid, 0);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
			throw error;
		}
		await new Promise(resolve => setTimeout(resolve, 20));
	}
	throw new Error(`owner process did not terminate: ${pid}`);
}

describe.skipIf(!isLinux || !tmux || !userScopeAvailable)("reaper owner-proof termination integration", () => {
	afterEach(async () => {
		for (const c of cleanups.splice(0)) {
			Bun.spawnSync([c.env.GJC_TMUX_COMMAND!, "kill-server"], { stdout: "pipe", stderr: "pipe", env: c.env });
			Bun.spawnSync(["systemctl", "--user", "stop", c.scopeName], { stdout: "pipe", stderr: "pipe" });
			await fs.rm(c.stateDir, { recursive: true, force: true });
		}
	});

	it("stop_session drives the real forceClose to terminate a genuine owned session and purge it; an unrelated GJC session survives", async () => {
		const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-reaper-owner-"));
		const tmuxTmpDir = path.join(stateDir, "tmux");
		const socketName = `gjc-reap-${crypto.randomUUID().slice(0, 8)}`;
		const scopeName = `gjc-reaper-test-${crypto.randomUUID().slice(0, 8)}.scope`;
		const tmuxWrapper = path.join(stateDir, "isolated-tmux");
		const sessionName = `gjc_reap_${crypto.randomUUID().slice(0, 8)}`;
		const siblingSessionName = `gjc_sibling_${crypto.randomUUID().slice(0, 8)}`;
		const sessionId = crypto.randomUUID();
		const generation = crypto.randomUUID();
		const stateFile = path.join(stateDir, "marker");
		await fs.mkdir(tmuxTmpDir);
		await fs.writeFile(tmuxWrapper, `#!/usr/bin/env sh\nexec ${tmux} -L "$GJC_TEST_TMUX_SOCKET" "$@"\n`, {
			mode: 0o700,
		});
		const env: NodeJS.ProcessEnv = {
			...process.env,
			GJC_TMUX_COMMAND: tmuxWrapper,
			GJC_TEST_TMUX_SOCKET: socketName,
			TMUX_TMPDIR: tmuxTmpDir,
		};
		cleanups.push({ env, stateDir, scopeName });

		const created = Bun.spawnSync(
			[
				systemdRun!,
				"--user",
				"--scope",
				"--quiet",
				"--unit",
				scopeName,
				env.GJC_TMUX_COMMAND!,
				"new-session",
				"-d",
				"-s",
				sessionName,
				"sh",
				"-c",
				"trap 'exit 0' TERM; while :; do sleep 1; done",
			],
			{ stdout: "pipe", stderr: "pipe", env },
		);
		if (created.exitCode !== 0) throw new Error(created.stderr.toString());

		const target = buildGjcTmuxExactOptionTarget(sessionName, { env });
		await replaceOwnerGeneration(stateDir, sessionId, generation);
		for (const command of buildGjcTmuxProfileCommands(
			target,
			env,
			{ sessionId, sessionStateFile: stateFile, ownerGeneration: generation, ownerServerKey: sessionName },
			{ tmuxCommand: env.GJC_TMUX_COMMAND },
		))
			run(command.args, env);
		// Keep the pane after its process dies so we prove forceClose does the explicit exact
		// cleanup (not just the process dying on its own).
		run(["set-option", "-t", target, "remain-on-exit", "on"], env);
		// An unrelated GJC session with no coordinator record — must be left untouched.
		run(
			["new-session", "-d", "-s", siblingSessionName, "sh", "-c", "trap 'exit 0' TERM; while :; do sleep 1; done"],
			env,
		);

		const hasSession = (name: string) =>
			Bun.spawnSync([env.GJC_TMUX_COMMAND!, "has-session", "-t", `=${name}`], {
				stdout: "pipe",
				stderr: "pipe",
				env,
			}).exitCode === 0;
		expect(hasSession(sessionName)).toBe(true);
		expect(hasSession(siblingSessionName)).toBe(true);

		const panePid = Number(
			Bun.spawnSync([env.GJC_TMUX_COMMAND!, "display-message", "-p", "-t", target, "#{pane_pid}"], {
				stdout: "pipe",
				stderr: "pipe",
				env,
			})
				.stdout.toString()
				.trim(),
		);

		// The reaper forwards through services.forceCloseSession to the REAL forceCloseGjcTmuxSession
		// with the same owner-lifecycle deps the accepted harness uses. termSent proves a real TERM
		// was dispatched to the real pane; the sidecar sleep publishes the terminal verdict so the
		// verified close path can finish its exact cleanup.
		let termSent = false;
		const server = createCoordinatorMcpServer({
			env: {
				...env,
				GJC_COORDINATOR_MCP_WORKDIR_ROOTS: stateDir,
				GJC_COORDINATOR_MCP_MUTATIONS: "sessions,questions,reports",
				GJC_COORDINATOR_MCP_STATE_ROOT: path.join(stateDir, ".coord"),
				GJC_COORDINATOR_MCP_PROFILE: "reaper-owner",
				GJC_COORDINATOR_MCP_REPO: "repo-owner",
			},
			services: {
				forceCloseSession: async (name, closeEnv, _sid, expectedStateFile) => {
					// The reaper must forward the recorded state-file identity.
					expect(expectedStateFile).toBe(stateFile);
					return await forceCloseGjcTmuxSession(name, closeEnv, sessionId, expectedStateFile, {
						resolveOwner: async () => ({
							sessionId,
							stateDir,
							socketKey: sessionName,
							generation,
							pid: panePid,
							startTime: procStartTime(panePid),
						}),
						readProcessStartTime: async pid => procStartTime(pid),
						signalTerm: pid => {
							termSent = true;
							process.kill(pid, "SIGTERM");
						},
						sleep: async () => {
							await waitForProcessExit(panePid);
							const intent = JSON.parse(
								await fs.readFile(
									path.join(stateDir, sessionId, "owner-lifecycle", `intent-${generation}.json`),
									"utf8",
								),
							);
							const verdict = await observeOwnerTerminal({
								schema_version: 1,
								op: "observe_terminal",
								session_id: sessionId,
								owner_generation: generation,
								state_dir: stateDir,
								socket_key: sessionName,
								observer: "sidecar",
								observed_at: new Date().toISOString(),
								signal: "SIGTERM",
								exit_code: null,
								exit_kind: "exit",
								reason: "integration",
								operator_dispatch_id: intent.dispatch_id,
							});
							await fs.writeFile(
								path.join(stateDir, "verdict.json"),
								JSON.stringify({ ...verdict, owner_generation: generation }),
							);
						},
					});
				},
			},
		});

		const ns = path.join(stateDir, ".coord", "reaper-owner", "repo-owner");
		await fs.mkdir(path.join(ns, "sessions"), { recursive: true });
		await fs.writeFile(
			path.join(ns, "sessions", "owned-eph.json"),
			JSON.stringify({
				session_id: "owned-eph",
				ephemeral: true,
				tmux_session: sessionName,
				runtimeStateFile: stateFile,
				created_at: new Date().toISOString(),
			}),
		);

		const reaped = await server.callTool("gjc_coordinator_stop_session", {
			session_id: "owned-eph",
			allow_mutation: true,
		});
		expect(reaped).toMatchObject({ ok: true, killed: true });

		expect(termSent).toBe(true); // a real TERM was dispatched to the real owned pane
		expect(hasSession(sessionName)).toBe(false); // genuine owned session terminated via the real path
		expect(hasSession(siblingSessionName)).toBe(true); // unrelated GJC session survives
		const status = await server.callTool("gjc_coordinator_read_status", { session_id: "owned-eph" });
		expect(status.session ?? null).toBeNull(); // record purged
	}, 30_000);
});
