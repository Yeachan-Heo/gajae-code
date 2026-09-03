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
import { replaceOwnerGeneration } from "@gajae-code/coding-agent/gjc-runtime/tmux-owner-isolation";
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
			if (isLinux) {
				const stat = fsSync.readFileSync(`/proc/${pid}/stat`, "utf8");
				const state = stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3);
				if (state === "Z") return;
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
			throw error;
		}
		await new Promise(resolve => setTimeout(resolve, 20));
	}
	throw new Error(`owner process did not terminate: ${pid}`);
}

function processGoneOrZombie(pid: number): boolean {
	try {
		process.kill(pid, 0);
		if (!isLinux) return false;
		const stat = fsSync.readFileSync(`/proc/${pid}/stat`, "utf8");
		return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) === "Z";
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ESRCH";
	}
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
		const runId = crypto.randomUUID();
		const incarnation = crypto.randomUUID();
		await fs.mkdir(tmuxTmpDir);
		const stateFile = path.join(stateDir, "marker");
		const childScript = path.join(stateDir, "managed-child.ts");
		const supervisorScript = path.join(stateDir, "managed-supervisor.ts");
		const childReadyFile = path.join(stateDir, "managed-child-ready");
		await fs.writeFile(
			stateFile,
			JSON.stringify({
				schema_version: 1,
				session_id: sessionId,
				state: "completed",
				cwd: stateDir,
				workdir: stateDir,
				session_file: null,
				final_response: { source: "agent_end", text: "terminal evidence" },
			}),
		);
		await fs.writeFile(
			childScript,
			`import { writeFile } from "node:fs/promises";
import { registerCoordinatorRuntimeStateFinalizer } from ${JSON.stringify(path.resolve(import.meta.dir, "../../src/gjc-runtime/session-state-sidecar.ts"))};
registerCoordinatorRuntimeStateFinalizer({ sessionId: ${JSON.stringify(sessionId)}, cwd: ${JSON.stringify(stateDir)}, sessionFile: null });
await writeFile(${JSON.stringify(childReadyFile)}, JSON.stringify({ launched: process.env.GJC_TMUX_LAUNCHED, generation: process.env.GJC_TMUX_OWNER_GENERATION, stateDir: process.env.GJC_TMUX_OWNER_STATE_DIR, socketKey: process.env.GJC_TMUX_OWNER_SERVER_KEY }));
setInterval(() => {}, 1_000);
`,
		);
		await fs.writeFile(
			supervisorScript,
			`import { writeFile } from "node:fs/promises";
import { runManagedOwnerSupervisor } from ${JSON.stringify(path.resolve(import.meta.dir, "../../src/gjc-runtime/managed-owner-supervisor.ts"))};
try {
	await runManagedOwnerSupervisor();
} catch (error) {
	await writeFile(${JSON.stringify(path.join(stateDir, "supervisor-error"))}, String(error));
	throw error;
}`,
		);
		await fs.writeFile(tmuxWrapper, `#!/usr/bin/env sh\nexec ${tmux} -L "$GJC_TEST_TMUX_SOCKET" "$@"\n`, {
			mode: 0o700,
		});
		const env = {
			...process.env,
			GJC_TMUX_COMMAND: tmuxWrapper,
			GJC_TEST_TMUX_SOCKET: socketName,
			TMUX_TMPDIR: tmuxTmpDir,
			GJC_TMUX_LAUNCHED: "1",
			GJC_TMUX_OWNER_GENERATION: generation,
			GJC_TMUX_OWNER_STATE_DIR: stateDir,
			GJC_TMUX_OWNER_SERVER_KEY: sessionName,
			GJC_COORDINATOR_SESSION_STATE_FILE: stateFile,
			GJC_COORDINATOR_SESSION_ID: sessionId,
			GJC_MANAGED_OWNER_RUN_ID: runId,
			GJC_MANAGED_OWNER_INCARNATION: incarnation,
			GJC_MANAGED_OWNER_SUPERVISED: "1",
			GJC_MANAGED_OWNER_COMMAND_JSON: JSON.stringify([process.execPath, childScript]),
		};
		isolatedServers.push({ env, stateDir, scopeName });
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
				`exec "${process.execPath}" "${supervisorScript}" 2>"${path.join(stateDir, "supervisor-stderr")}"`,
			],
			{ stdout: "pipe", stderr: "pipe", env },
		);
		if (created.exitCode !== 0) throw new Error(created.stderr.toString());
		for (let attempt = 0; attempt < 150 && !fsSync.existsSync(childReadyFile); attempt += 1) await Bun.sleep(20);
		if (!fsSync.existsSync(childReadyFile)) {
			const errorFile = path.join(stateDir, "supervisor-error");
			throw new Error(
				`managed owner child did not become ready: ${
					fsSync.existsSync(errorFile)
						? fsSync.readFileSync(errorFile, "utf8")
						: fsSync.existsSync(path.join(stateDir, "supervisor-stderr"))
							? fsSync.readFileSync(path.join(stateDir, "supervisor-stderr"), "utf8")
							: `files=${fsSync.readdirSync(stateDir).join(",")}`
				}`,
			);
		}
		expect(JSON.parse(await fs.readFile(childReadyFile, "utf8"))).toEqual({
			launched: "1",
			generation,
			stateDir,
			socketKey: sessionName,
		});
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
		expect(fsSync.readFileSync(`/proc/${panePid}/cmdline`, "utf8")).toContain(supervisorScript);
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
		});
		await waitForProcessExit(panePid);
		expect(processGoneOrZombie(panePid)).toBe(true);
		expect(hasSession(sessionName).exitCode).not.toBe(0);
		expect(hasSession(siblingSessionName).exitCode).toBe(0);
		const verdict = JSON.parse(
			await fs.readFile(path.join(stateDir, sessionId, "owner-lifecycle", `verdict-${generation}.json`), "utf8"),
		);
		expect(verdict).toMatchObject({
			classification: "expected_operator_shutdown",
			signal: "SIGTERM",
		});
		expect(["sidecar", "raw_monitor"]).toContain(verdict.observer);
		expect(JSON.parse(await fs.readFile(stateFile, "utf8"))).toMatchObject({
			state: "completed",
			final_response: { source: "agent_end", text: "terminal evidence" },
		});
	}, 25_000);
});
