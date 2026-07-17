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
import {
	forceCloseGjcTmuxSession,
	listGjcTmuxSessions,
	readTmuxSessionTagsForGc,
	statusGjcTmuxSession,
} from "@gajae-code/coding-agent/gjc-runtime/tmux-sessions";

const tmux = Bun.which("tmux");
const systemdRun = Bun.which("systemd-run");
const isLinux = process.platform === "linux";
const isolatedServers: Array<{ env: NodeJS.ProcessEnv; stateDir: string; scopeName: string }> = [];
const userScopeAvailable =
	isLinux &&
	Boolean(systemdRun) &&
	Bun.spawnSync([systemdRun!, "--user", "--scope", "--quiet", "true"], { stdout: "pipe", stderr: "pipe" }).exitCode ===
		0;

async function waitForProcessExit(pid: number): Promise<void> {
	for (let attempt = 0; attempt < 50; attempt += 1) {
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

describe.skipIf(!isLinux || !tmux || !userScopeAvailable)("tmux exact owner close integration", () => {
	afterEach(async () => {
		for (const server of isolatedServers.splice(0)) {
			Bun.spawnSync([server.env.GJC_TMUX_COMMAND!, "kill-server"], {
				stdout: "pipe",
				stderr: "pipe",
				env: server.env,
			});
			Bun.spawnSync(["systemctl", "--user", "stop", server.scopeName], {
				stdout: "pipe",
				stderr: "pipe",
			});
			await fs.rm(server.stateDir, { recursive: true, force: true });
		}
	});

	it("uses TERM, publishes the expected verdict, then cleans up the real tmux session", async () => {
		const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-tmux-close-integration-"));
		const tmuxTmpDir = path.join(stateDir, "tmux");
		const socketName = `gjc-close-${crypto.randomUUID().slice(0, 8)}`;
		const scopeName = `gjc-owner-test-${crypto.randomUUID().slice(0, 8)}.scope`;
		const tmuxWrapper = path.join(stateDir, "isolated-tmux");
		const sessionName = `gjc_close_${crypto.randomUUID().slice(0, 8)}`;
		const siblingSessionName = `gjc_sibling_${crypto.randomUUID().slice(0, 8)}`;
		const sessionId = crypto.randomUUID();
		const generation = crypto.randomUUID();
		await fs.mkdir(tmuxTmpDir);
		await fs.writeFile(tmuxWrapper, `#!/usr/bin/env sh\nexec ${tmux} -L "$GJC_TEST_TMUX_SOCKET" "$@"\n`, {
			mode: 0o700,
		});
		const env = {
			...process.env,
			GJC_TMUX_COMMAND: tmuxWrapper,
			GJC_TEST_TMUX_SOCKET: socketName,
			TMUX_TMPDIR: tmuxTmpDir,
		};
		isolatedServers.push({ env, stateDir, scopeName });
		const stateFile = path.join(stateDir, "marker");
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
		run(["set-option", "-t", target, "remain-on-exit", "on"], env);
		run(
			["new-session", "-d", "-s", siblingSessionName, "sh", "-c", "trap 'exit 0' TERM; while :; do sleep 1; done"],
			env,
		);
		const hasSession = (name: string) =>
			Bun.spawnSync([env.GJC_TMUX_COMMAND!, "has-session", "-t", `=${name}`], {
				stdout: "pipe",
				stderr: "pipe",
				env,
			});
		expect(hasSession(sessionName).exitCode).toBe(0);
		expect(hasSession(siblingSessionName).exitCode).toBe(0);
		expect(statusGjcTmuxSession(sessionName, env)).toMatchObject({
			profile: "1",
			sessionId,
			sessionStateFile: stateFile,
		});
		expect(readTmuxSessionTagsForGc(sessionName, env)).toMatchObject({
			profile: "1",
			sessionId,
			sessionStateFile: stateFile,
		});
		expect(listGjcTmuxSessions(env).find(session => session.name === sessionName)).toMatchObject({
			profile: "1",
			sessionId,
			sessionStateFile: stateFile,
		});
		const panePid = Number(
			Bun.spawnSync([env.GJC_TMUX_COMMAND!, "display-message", "-p", "-t", target, "#{pane_pid}"], {
				stdout: "pipe",
				stderr: "pipe",
				env,
			})
				.stdout.toString()
				.trim(),
		);
		let termSent = false;
		await forceCloseGjcTmuxSession(sessionName, env, sessionId, stateFile, {
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
				expect(() => process.kill(panePid, 0)).toThrow(/ESRCH/);
				// The target remains until the verified close path cleans it up; the
				// sibling proves cleanup is exact rather than server-wide.
				expect(hasSession(sessionName).exitCode).toBe(0);
				expect(hasSession(siblingSessionName).exitCode).toBe(0);
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
		expect(termSent).toBe(true);
		expect(hasSession(sessionName).exitCode).not.toBe(0);
		expect(hasSession(siblingSessionName).exitCode).toBe(0);
	});
});
