import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const tempRoots: string[] = [];
const tmuxSessions: string[] = [];

async function makeExecutable(file: string, content: string): Promise<void> {
	await fs.mkdir(path.dirname(file), { recursive: true });
	await Bun.write(file, content);
	await fs.chmod(file, 0o755);
}

async function makeGitWorktree(root: string): Promise<string> {
	const worktree = path.join(root, "worktree");
	await fs.mkdir(worktree, { recursive: true });
	expect(Bun.spawnSync(["git", "init"], { cwd: worktree }).exitCode).toBe(0);
	await Bun.write(path.join(worktree, "README.md"), "fixture\n");
	expect(Bun.spawnSync(["git", "add", "README.md"], { cwd: worktree }).exitCode).toBe(0);
	expect(
		Bun.spawnSync(["git", "-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-m", "fixture"], {
			cwd: worktree,
		}).exitCode,
	).toBe(0);
	expect(Bun.spawnSync(["git", "checkout", "-b", "issue-1385-test"], { cwd: worktree }).exitCode).toBe(0);
	return worktree;
}

async function waitForFile(file: string, timeoutMs = 7000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const stat = await fs.stat(file);
			if (stat.size > 0) return;
		} catch {
			// keep polling
		}
		await Bun.sleep(100);
	}
	throw new Error(`timed out waiting for ${file}`);
}
async function waitForFileContaining(file: string, text: string, timeoutMs = 7000): Promise<string> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const content = await Bun.file(file).text();
			if (content.includes(text)) return content;
		} catch {
			// keep polling
		}
		await Bun.sleep(100);
	}
	throw new Error(`timed out waiting for ${file} to contain ${text}`);
}

function startPaneLog(session: string, stateDir: string): void {
	const paneLog = path.join(stateDir, "pane.log");
	expect(Bun.spawnSync(["tmux", "pipe-pane", "-t", `${session}:0.0`, `cat >> '${paneLog}'`]).exitCode).toBe(0);
}

function isolatedEnv(overrides: Record<string, string | undefined>): Record<string, string | undefined> {
	const env = { ...process.env };
	delete env.GJC_SESSION_WORKDIR;
	delete env.GJC_SESSION_STATE_DIR;
	return { ...env, ...overrides };
}

afterEach(async () => {
	for (const session of tmuxSessions.splice(0)) {
		Bun.spawnSync(["tmux", "kill-session", "-t", session], { stderr: "pipe", stdout: "pipe" });
	}
	await Promise.all(tempRoots.splice(0).map(root => fs.rm(root, { force: true, recursive: true })));
});

describe("gjc-session create", () => {
	test("fails closed when the owner exits before durable turn evidence", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-session-owner-exit-"));
		tempRoots.push(root);
		const session = `gjc_issue_1385_exit_${process.pid}_${Date.now()}`;
		tmuxSessions.push(session);
		const worktree = await makeGitWorktree(root);
		const stateDir = path.join(root, "state");
		const fakeGjc = path.join(root, "bin", "gjc");
		await makeExecutable(
			fakeGjc,
			`#!/usr/bin/env bash
python3 - <<'PY'
import json
import os
with open(os.path.join(os.environ["GJC_SESSION_STATE_DIR"], "env.json"), "w", encoding="utf-8") as handle:
    json.dump({
        "sessionId": os.environ.get("GJC_COORDINATOR_SESSION_ID"),
        "stateFile": os.environ.get("GJC_COORDINATOR_SESSION_STATE_FILE"),
        "branch": os.environ.get("GJC_COORDINATOR_SESSION_BRANCH"),
    }, handle)
PY
echo 'booted without accepting work'
exit 0
`,
		);

		const result = Bun.spawnSync(["bash", "scripts/gjc-session/create.sh", session, worktree], {
			env: isolatedEnv({
				GJC_BIN: fakeGjc,
				GJC_SESSION_MONITOR_DISABLE: "1",
				GJC_SESSION_SKIP_ROUTER: "1",
				GJC_SESSION_STATE_DIR: stateDir,
			}),
			stderr: "pipe",
			stdout: "pipe",
		});

		expect(result.exitCode).toBe(1);
		expect(result.stderr.toString()).toContain("GJC owner exited before durable turn evidence");
		expect(result.stderr.toString()).toContain(`durable runtime state: ${path.join(stateDir, "runtime-state.json")}`);
		const metadata = (await Bun.file(path.join(stateDir, "metadata.json")).json()) as { runtimeState: string };
		expect(metadata.runtimeState).toBe(path.join(stateDir, "runtime-state.json"));
		const envDump = (await Bun.file(path.join(stateDir, "env.json")).json()) as {
			sessionId: string;
			stateFile: string;
			branch: string;
		};
		expect(envDump).toEqual({
			sessionId: session,
			stateFile: path.join(stateDir, "runtime-state.json"),
			branch: "issue-1385-test",
		});
		const finalStatus = (await Bun.file(path.join(stateDir, "final.json")).json()) as {
			ownerExitReason: string;
			severity: string;
			turnEvidencePresent: boolean;
			runtimeState: string;
		};
		expect(finalStatus).toMatchObject({
			ownerExitReason: "owner_exited_before_turn_evidence",
			severity: "failure",
			turnEvidencePresent: false,
			runtimeState: path.join(stateDir, "runtime-state.json"),
		});
	});

	test("runner treats completed runtime state as normal terminal cleanup", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-session-runtime-completed-"));
		tempRoots.push(root);
		const session = `gjc_issue_1496_runtime_completed_${process.pid}_${Date.now()}`;
		tmuxSessions.push(session);
		const worktree = await makeGitWorktree(root);
		const stateDir = path.join(root, "state");
		const fakeGjc = path.join(root, "bin", "gjc");
		await makeExecutable(
			fakeGjc,
			`#!/usr/bin/env bash
python3 - <<'PY'
import json
import os
with open(os.environ["GJC_COORDINATOR_SESSION_STATE_FILE"], "w", encoding="utf-8") as handle:
    json.dump({"session_id": os.environ["GJC_COORDINATOR_SESSION_ID"], "state": "completed", "final_response": {"source": "agent_end"}}, handle)
PY
exit 0
`,
		);

		const result = Bun.spawnSync(["bash", "scripts/gjc-session/create.sh", session, worktree], {
			env: isolatedEnv({
				GJC_BIN: fakeGjc,
				GJC_SESSION_MONITOR_DISABLE: "1",
				GJC_SESSION_SKIP_ROUTER: "1",
				GJC_SESSION_STATE_DIR: stateDir,
			}),
			stderr: "pipe",
			stdout: "pipe",
		});

		expect(result.exitCode).toBe(0);
		const finalStatus = (await Bun.file(path.join(stateDir, "final.json")).json()) as Record<string, unknown>;
		expect(finalStatus).toMatchObject({
			ownerExitReason: "terminal_runtime_cleanup",
			severity: "normal",
			runtimeTerminal: true,
			runtimeTerminalState: "completed",
			runtimeTerminalSource: "agent_end",
		});
	});

	test("runner treats launch_error runtime state as normal terminal cleanup", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-session-runtime-errored-"));
		tempRoots.push(root);
		const session = `gjc_issue_1496_runtime_errored_${process.pid}_${Date.now()}`;
		tmuxSessions.push(session);
		const worktree = await makeGitWorktree(root);
		const stateDir = path.join(root, "state");
		const fakeGjc = path.join(root, "bin", "gjc");
		await makeExecutable(
			fakeGjc,
			`#!/usr/bin/env bash
python3 - <<'PY'
import json
import os
with open(os.environ["GJC_COORDINATOR_SESSION_STATE_FILE"], "w", encoding="utf-8") as handle:
    json.dump({"session_id": os.environ["GJC_COORDINATOR_SESSION_ID"], "state": "errored", "final_response": {"source": "launch_error"}}, handle)
PY
exit 1
`,
		);

		const result = Bun.spawnSync(["bash", "scripts/gjc-session/create.sh", session, worktree], {
			env: isolatedEnv({
				GJC_BIN: fakeGjc,
				GJC_SESSION_MONITOR_DISABLE: "1",
				GJC_SESSION_SKIP_ROUTER: "1",
				GJC_SESSION_STATE_DIR: stateDir,
			}),
			stderr: "pipe",
			stdout: "pipe",
		});

		expect(result.exitCode).toBe(0);
		const finalStatus = (await Bun.file(path.join(stateDir, "final.json")).json()) as Record<string, unknown>;
		expect(finalStatus).toMatchObject({
			ownerExitReason: "terminal_runtime_cleanup",
			severity: "normal",
			runtimeTerminal: true,
			runtimeTerminalState: "errored",
			runtimeTerminalSource: "launch_error",
		});
	});

	test("runner treats process_postmortem errored runtime state as recoverable failure", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-session-runtime-postmortem-"));
		tempRoots.push(root);
		const session = `gjc_issue_1496_runtime_postmortem_${process.pid}_${Date.now()}`;
		tmuxSessions.push(session);
		const worktree = await makeGitWorktree(root);
		const stateDir = path.join(root, "state");
		const fakeGjc = path.join(root, "bin", "gjc");
		await makeExecutable(
			fakeGjc,
			`#!/usr/bin/env bash
printf 'Gajae forge\\nWorking before postmortem exit\\n'
python3 - <<'PY'
import json
import os

with open(os.environ["GJC_COORDINATOR_SESSION_STATE_FILE"], "w", encoding="utf-8") as handle:
    json.dump(
        {
            "schema_version": 1,
            "session_id": os.environ["GJC_COORDINATOR_SESSION_ID"],
            "state": "errored",
            "ready_for_input": False,
            "source": "process_postmortem",
            "event": "process_exit",
            "reason": "process_exit_before_prompt_acceptance",
            "previous_runtime_state": "running",
            "error": {"code": "process_exit_before_prompt_acceptance", "recoverable": True},
        },
        handle,
        indent=2,
    )
    handle.write("\\n")
PY
exit 0
`,
		);

		const result = Bun.spawnSync(["bash", "scripts/gjc-session/create.sh", session, worktree], {
			env: isolatedEnv({
				GJC_BIN: fakeGjc,
				GJC_SESSION_MONITOR_DISABLE: "1",
				GJC_SESSION_SKIP_ROUTER: "1",
				GJC_SESSION_STATE_DIR: stateDir,
			}),
			stderr: "pipe",
			stdout: "pipe",
		});

		expect(result.exitCode).toBe(0);
		await waitForFile(path.join(stateDir, "final.json"));
		const finalStatus = (await Bun.file(path.join(stateDir, "final.json")).json()) as Record<string, unknown>;
		expect(finalStatus).toMatchObject({
			ownerExitReason: "process_exit_before_prompt_acceptance",
			severity: "failure",
			runtimeTerminal: true,
			runtimeTerminalState: "errored",
			runtimeTerminalSource: "process_postmortem",
			runtimeStateSummary: {
				source: "process_postmortem",
				event: "process_exit",
				reason: "process_exit_before_prompt_acceptance",
				previousRuntimeState: "running",
			},
		});
	}, 20000);

	test("runner rejects terminal runtime state for a mismatched session id", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-session-runtime-mismatch-"));
		tempRoots.push(root);
		const session = `gjc_issue_1496_runtime_mismatch_${process.pid}_${Date.now()}`;
		tmuxSessions.push(session);
		const worktree = await makeGitWorktree(root);
		const stateDir = path.join(root, "state");
		const fakeGjc = path.join(root, "bin", "gjc");
		await makeExecutable(
			fakeGjc,
			`#!/usr/bin/env bash
python3 - <<'PY'
import json
import os
with open(os.environ["GJC_COORDINATOR_SESSION_STATE_FILE"], "w", encoding="utf-8") as handle:
    json.dump({"session_id": "unrelated-session", "state": "completed", "final_response": {"source": "agent_end"}}, handle)
PY
printf 'Gajae forge\nWorking before prompt but no accepted marker\n'
exit 0
`,
		);

		const result = Bun.spawnSync(["bash", "scripts/gjc-session/create.sh", session, worktree], {
			env: isolatedEnv({
				GJC_BIN: fakeGjc,
				GJC_SESSION_MONITOR_DISABLE: "1",
				GJC_SESSION_SKIP_ROUTER: "1",
				GJC_SESSION_STATE_DIR: stateDir,
			}),
			stderr: "pipe",
			stdout: "pipe",
		});

		expect(result.exitCode).toBe(0);
		await waitForFile(path.join(stateDir, "final.json"));
		const finalStatus = (await Bun.file(path.join(stateDir, "final.json")).json()) as Record<string, unknown>;
		expect(finalStatus).toMatchObject({
			ownerExitReason: "owner_exited_before_prompt_acceptance",
			severity: "failure",
			runtimeTerminal: false,
		});
	});

	test("runner treats pre-acceptance pane evidence exit as failure, not normal", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-session-preaccept-evidence-"));
		tempRoots.push(root);
		const session = `gjc_issue_1496_preaccept_evidence_${process.pid}_${Date.now()}`;
		tmuxSessions.push(session);
		const worktree = await makeGitWorktree(root);
		const stateDir = path.join(root, "state");
		const fakeGjc = path.join(root, "bin", "gjc");
		await makeExecutable(fakeGjc, "#!/usr/bin/env bash\nprintf 'Gajae forge\\nWorking before prompt acceptance\\n'\nexit 0\n");

		const result = Bun.spawnSync(["bash", "scripts/gjc-session/create.sh", session, worktree], {
			env: isolatedEnv({
				GJC_BIN: fakeGjc,
				GJC_SESSION_MONITOR_DISABLE: "1",
				GJC_SESSION_SKIP_ROUTER: "1",
				GJC_SESSION_STATE_DIR: stateDir,
			}),
			stderr: "pipe",
			stdout: "pipe",
		});

		expect(result.exitCode).toBe(0);
		await waitForFile(path.join(stateDir, "final.json"));
		const finalStatus = (await Bun.file(path.join(stateDir, "final.json")).json()) as Record<string, unknown>;
		expect(finalStatus).toMatchObject({
			turnEvidencePresent: true,
			promptAccepted: false,
			ownerExitReason: "owner_exited_before_prompt_acceptance",
			severity: "failure",
		});
	});

	test("runner treats non-terminal runtime state as failed even without prompt marker", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-session-runtime-running-"));
		tempRoots.push(root);
		const session = `gjc_issue_1496_runtime_running_${process.pid}_${Date.now()}`;
		tmuxSessions.push(session);
		const worktree = await makeGitWorktree(root);
		const stateDir = path.join(root, "state");
		const fakeGjc = path.join(root, "bin", "gjc");
		await makeExecutable(
			fakeGjc,
			`#!/usr/bin/env bash
printf 'Gajae forge\\n> Type your message\\nWorking on accepted prompt\\n'
python3 - <<'PY'
import json
import os

with open(os.environ["GJC_COORDINATOR_SESSION_STATE_FILE"], "w", encoding="utf-8") as handle:
    json.dump(
        {
            "schema_version": 1,
            "session_id": os.environ["GJC_COORDINATOR_SESSION_ID"],
            "state": "running",
            "ready_for_input": False,
            "source": "agent_session_event",
            "event": "turn_start",
            "reason": None,
        },
        handle,
        indent=2,
    )
    handle.write("\\n")
PY
exit 0
`,
		);

		const result = Bun.spawnSync(["bash", "scripts/gjc-session/create.sh", session, worktree], {
			env: isolatedEnv({
				GJC_BIN: fakeGjc,
				GJC_SESSION_MONITOR_DISABLE: "1",
				GJC_SESSION_SKIP_ROUTER: "1",
				GJC_SESSION_STATE_DIR: stateDir,
			}),
			stderr: "pipe",
			stdout: "pipe",
		});

		expect(result.exitCode).toBe(0);
		await waitForFile(path.join(stateDir, "final.json"));
		const finalStatus = (await Bun.file(path.join(stateDir, "final.json")).json()) as {
			ownerExitReason: string;
			promptAccepted: boolean;
			runtimeStateSummary: { present: boolean; valid: boolean; state: string; terminal: boolean };
			severity: string;
			turnEvidencePresent: boolean;
		};
		expect(finalStatus).toMatchObject({
			ownerExitReason: "owner_exited_after_runtime_acknowledgement_before_terminal_status",
			promptAccepted: false,
			severity: "failure",
			turnEvidencePresent: true,
			runtimeStateSummary: {
				present: true,
				valid: true,
				state: "running",
				terminal: false,
			},
		});
	}, 20000);

	test("external monitor records vanished tmux sessions and alerts the router", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-session-vanish-"));
		tempRoots.push(root);
		const session = `gjc_issue_1385_vanish_${process.pid}_${Date.now()}`;
		tmuxSessions.push(session);
		const worktree = await makeGitWorktree(root);
		const stateDir = path.join(root, "state");
		const fakeGjc = path.join(root, "bin", "gjc");
		const routerLog = path.join(root, "router.log");
		const fakeRouter = path.join(root, "bin", "clawhip");
		await makeExecutable(fakeGjc, "#!/usr/bin/env bash\necho 'Gajae forge'\nsleep 60\n");
		await makeExecutable(fakeRouter, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> '${routerLog}'\nexit 0\n`);

		const created = Bun.spawnSync(["bash", "scripts/gjc-session/create.sh", session, worktree, "C-test"], {
			env: isolatedEnv({
				GJC_BIN: fakeGjc,
				GJC_SESSION_MONITOR_INTERVAL: "1",
				GJC_SESSION_ROUTER: fakeRouter,
				GJC_SESSION_SKIP_ROUTER: "1",
				GJC_SESSION_STATE_DIR: stateDir,
			}),
			stderr: "pipe",
			stdout: "pipe",
		});
		expect(created.exitCode).toBe(0);

		Bun.spawnSync(["tmux", "kill-session", "-t", session], { stderr: "pipe", stdout: "pipe" });
		await waitForFile(path.join(stateDir, "vanished.json"));

		const vanished = (await Bun.file(path.join(stateDir, "vanished.json")).json()) as {
			finalPresent: boolean;
			reason: string;
			severity: string;
			runtimeState: string;
		};
		expect(vanished).toMatchObject({
			finalPresent: false,
			reason: vanished.tuiReadyObserved
				? "tmux_session_missing_before_prompt_acceptance"
				: "tmux_session_missing_before_tui_readiness",
			phase: vanished.tuiReadyObserved ? "before_prompt_acceptance" : "before_tui_readiness",
			severity: "failure",
			tuiReadyObserved: vanished.tuiReadyObserved,
		});
		expect(vanished.runtimeState).toBe(path.relative(worktree, path.join(stateDir, "runtime-state.json")));
		await waitForFile(routerLog);
		expect(await Bun.file(routerLog).text()).toContain("tmux stale --session");
	}, 20000);
	test("external monitor treats process_postmortem runtime state as recoverable failure", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-session-monitor-postmortem-"));
		tempRoots.push(root);
		const session = `gjc_issue_1496_monitor_postmortem_${process.pid}_${Date.now()}`;
		tmuxSessions.push(session);
		const worktree = await makeGitWorktree(root);
		const stateDir = path.join(root, "state");
		const fakeGjc = path.join(root, "bin", "gjc");
		await makeExecutable(fakeGjc, "#!/usr/bin/env bash\nprintf 'Gajae forge\\nWorking before postmortem exit\\n'\nsleep 60\n");

		const created = Bun.spawnSync(["bash", "scripts/gjc-session/create.sh", session, worktree], {
			env: isolatedEnv({
				GJC_BIN: fakeGjc,
				GJC_SESSION_MONITOR_INTERVAL: "1",
				GJC_SESSION_SKIP_ROUTER: "1",
				GJC_SESSION_STATE_DIR: stateDir,
			}),
			stderr: "pipe",
			stdout: "pipe",
		});
		expect(created.exitCode).toBe(0);

		await Bun.write(
			path.join(stateDir, "runtime-state.json"),
			JSON.stringify(
				{
					schema_version: 1,
					session_id: session,
					state: "errored",
					ready_for_input: false,
					source: "process_postmortem",
					event: "process_exit",
					reason: "process_exit_before_prompt_acceptance",
					previous_runtime_state: "running",
					error: { code: "process_exit_before_prompt_acceptance", recoverable: true },
				},
				null,
				2,
			),
		);
		Bun.spawnSync(["tmux", "kill-session", "-t", session], { stderr: "pipe", stdout: "pipe" });
		await waitForFile(path.join(stateDir, "vanished.json"));

		const vanished = (await Bun.file(path.join(stateDir, "vanished.json")).json()) as Record<string, unknown>;
		expect(vanished).toMatchObject({
			finalPresent: false,
			phase: "process_postmortem",
			reason: "process_exit_before_prompt_acceptance",
			runtimeTerminal: true,
			runtimeTerminalState: "errored",
			runtimeTerminalSource: "process_postmortem",
			severity: "failure",
		});
		expect(await Bun.file(path.join(stateDir, "final.json")).exists()).toBe(false);
		const events = await Bun.file(path.join(stateDir, "events.log")).text();
		expect(events).toContain("tmux session vanished");
		expect(events).not.toContain("no vanished failure marker written");
	}, 20000);

	test("external monitor preserves terminal cleanup for agent_end and launch_error runtime states", async () => {
		for (const [source, state] of [
			["agent_end", "completed"],
			["launch_error", "errored"],
		] as const) {
			const root = await fs.mkdtemp(path.join(os.tmpdir(), `gjc-session-monitor-${source}-`));
			tempRoots.push(root);
			const session = `gjc_issue_1496_monitor_${source}_${process.pid}_${Date.now()}`;
			tmuxSessions.push(session);
			const worktree = await makeGitWorktree(root);
			const stateDir = path.join(root, "state");
			const fakeGjc = path.join(root, "bin", "gjc");
			await makeExecutable(fakeGjc, "#!/usr/bin/env bash\nprintf 'Gajae forge\\n'\nsleep 60\n");

			const created = Bun.spawnSync(["bash", "scripts/gjc-session/create.sh", session, worktree], {
				env: isolatedEnv({
					GJC_BIN: fakeGjc,
					GJC_SESSION_MONITOR_INTERVAL: "1",
					GJC_SESSION_SKIP_ROUTER: "1",
					GJC_SESSION_STATE_DIR: stateDir,
				}),
				stderr: "pipe",
				stdout: "pipe",
			});
			expect(created.exitCode).toBe(0);

			await Bun.write(
				path.join(stateDir, "runtime-state.json"),
				JSON.stringify({ session_id: session, state, final_response: { source } }, null, 2),
			);
			Bun.spawnSync(["tmux", "kill-session", "-t", session], { stderr: "pipe", stdout: "pipe" });
			const events = await waitForFileContaining(path.join(stateDir, "events.log"), "no vanished failure marker written");
			expect(events).toContain(`state=${state} source=${source}`);
			expect(await Bun.file(path.join(stateDir, "vanished.json")).exists()).toBe(false);
			expect(await Bun.file(path.join(stateDir, "final.json")).exists()).toBe(false);
		}
	}, 30000);
	test("external monitor records vanished sessions after prompt acceptance", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-session-post-accept-vanish-"));
		tempRoots.push(root);
		const session = `gjc_issue_1496_post_accept_${process.pid}_${Date.now()}`;
		tmuxSessions.push(session);
		const worktree = await makeGitWorktree(root);
		const stateDir = path.join(root, "state");
		const fakeGjc = path.join(root, "bin", "gjc");
		await makeExecutable(
			fakeGjc,
			`#!/usr/bin/env bash
printf 'Gajae forge\\n> Type your message\\n'
IFS= read -r line
printf '\\nWorking on accepted prompt\\n'
sleep 60
`,
		);

		const created = Bun.spawnSync(["bash", "scripts/gjc-session/create.sh", session, worktree], {
			env: isolatedEnv({
				GJC_BIN: fakeGjc,
				GJC_SESSION_MONITOR_INTERVAL: "1",
				GJC_SESSION_SKIP_ROUTER: "1",
				GJC_SESSION_STATE_DIR: stateDir,
			}),
			stderr: "pipe",
			stdout: "pipe",
		});
		expect(created.exitCode).toBe(0);

		const prompted = Bun.spawnSync(["bash", "scripts/gjc-session/prompt.sh", session, "do accepted work"], {
			env: isolatedEnv({
				GJC_SESSION_STATE_DIR: stateDir,
				GJC_SESSION_PROMPT_EVIDENCE_ATTEMPTS: "1",
			}),
			stderr: "pipe",
			stdout: "pipe",
		});
		expect(prompted.exitCode).toBe(0);

		Bun.spawnSync(["tmux", "kill-session", "-t", session], { stderr: "pipe", stdout: "pipe" });
		await waitForFile(path.join(stateDir, "vanished.json"));

		const vanished = (await Bun.file(path.join(stateDir, "vanished.json")).json()) as {
			promptAccepted: boolean;
			reason: string;
			severity: string;
		};
		expect(vanished).toMatchObject({
			promptAccepted: true,
			reason: "tmux_session_missing_after_prompt_acceptance",
			severity: "failure",
		});
	}, 20000);

	test("prompt records vanished status and refuses to paste when tmux session is missing", async () => {
		const session = `gjc_issue_1496_prompt_missing_${process.pid}_${Date.now()}`;
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-session-prompt-missing-"));
		tempRoots.push(root);
		const worktree = await makeGitWorktree(root);
		const stateDir = path.join(root, "state");
		await fs.mkdir(stateDir, { recursive: true });
		await Bun.write(path.join(stateDir, "pane.log"), "Gajae forge\n> Type your message\n");
		await Bun.write(path.join(stateDir, "metadata.json"), JSON.stringify({ session, workdir: worktree }, null, 2));
		const unrelatedWorkdir = path.join(root, "unrelated-workdir");


		const result = Bun.spawnSync(["bash", "scripts/gjc-session/prompt.sh", session, "do not paste this prompt"], {
			env: isolatedEnv({
				GJC_SESSION_STATE_DIR: stateDir,
				GJC_SESSION_WORKDIR: unrelatedWorkdir,
			}),
			stderr: "pipe",
			stdout: "pipe",
		});

		expect(result.exitCode).toBe(1);
		expect(result.stderr.toString()).toContain("refusing to paste prompt: tmux session");
		expect(result.stderr.toString()).not.toContain("do not paste this prompt");
		const vanished = (await Bun.file(path.join(stateDir, "vanished.json")).json()) as {
			phase: string;
			reason: string;
			promptAccepted: boolean;
			finalPresent: boolean;
			runtimeState: string;
		};
		expect(vanished).toMatchObject({
			phase: "before_prompt_injection",
			reason: "tmux_session_missing_before_prompt_injection",
			promptAccepted: false,
			finalPresent: false,
		});
		expect(vanished.runtimeState).toBe(path.relative(worktree, path.join(stateDir, "runtime-state.json")));
	}, 20000);

	test("prompt refuses success without durable turn evidence", async () => {
		const session = `gjc_issue_1385_prompt_${process.pid}_${Date.now()}`;
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-session-prompt-"));
		tempRoots.push(root);
		const stateDir = path.join(root, "state");
		await fs.mkdir(stateDir, { recursive: true });
		await Bun.write(path.join(stateDir, "pane.log"), "");
		tmuxSessions.push(session);
		expect(
			Bun.spawnSync([
				"tmux",
				"new-session",
				"-d",
				"-s",
				session,
				"printf 'Gajae forge\\n> Type your message\\n'; sleep 20",
			]).exitCode,
		).toBe(0);
		await Bun.sleep(500);
		startPaneLog(session, stateDir);

		const result = Bun.spawnSync(["bash", "scripts/gjc-session/prompt.sh", session, "do work"], {
			env: isolatedEnv({
				GJC_SESSION_TURN_EVIDENCE_PATTERN: "__NO_TURN_EVIDENCE__",
				GJC_SESSION_STATE_DIR: stateDir,
				GJC_SESSION_PROMPT_EVIDENCE_ATTEMPTS: "1",
			}),
			stderr: "pipe",
			stdout: "pipe",
		});

		expect(result.exitCode).toBe(1);
		expect(result.stderr.toString()).toContain("prompt acceptance failed: no durable turn evidence appeared");
	}, 20000);
	test("prompt ignores stale pre-existing turn evidence", async () => {
		const session = `gjc_issue_1385_prompt_stale_${process.pid}_${Date.now()}`;
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-session-prompt-stale-"));
		tempRoots.push(root);
		const stateDir = path.join(root, "state");
		await fs.mkdir(stateDir, { recursive: true });
		await Bun.write(path.join(stateDir, "pane.log"), "Tool output from previous turn\nWorking on previous prompt\n");
		tmuxSessions.push(session);
		expect(
			Bun.spawnSync([
				"tmux",
				"new-session",
				"-d",
				"-s",
				session,
				"printf 'Gajae forge\\nWorking on previous prompt\\n> Type your message\\n'; sleep 20",
			]).exitCode,
		).toBe(0);
		await Bun.sleep(500);
		startPaneLog(session, stateDir);

		const result = Bun.spawnSync(["bash", "scripts/gjc-session/prompt.sh", session, "new prompt that sleeping process will not accept"], {
			env: isolatedEnv({
				GJC_SESSION_STATE_DIR: stateDir,
				GJC_SESSION_PROMPT_EVIDENCE_ATTEMPTS: "1",
			}),
			stderr: "pipe",
			stdout: "pipe",
		});

		expect(result.exitCode).toBe(1);
		expect(result.stderr.toString()).toContain("prompt acceptance failed: no durable turn evidence appeared");
		expect(result.stdout.toString()).not.toContain("sent to");
	}, 20000);
	test("prompt echo cannot satisfy durable turn evidence", async () => {
		const session = `gjc_issue_1496_prompt_echo_${process.pid}_${Date.now()}`;
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-session-prompt-echo-"));
		tempRoots.push(root);
		const stateDir = path.join(root, "state");
		await fs.mkdir(stateDir, { recursive: true });
		await Bun.write(path.join(stateDir, "pane.log"), "");
		tmuxSessions.push(session);
		expect(
			Bun.spawnSync([
				"tmux",
				"new-session",
				"-d",
				"-s",
				session,
				"printf 'Gajae forge\\n> Type your message\\n'; sleep 20",
			]).exitCode,
		).toBe(0);
		await Bun.sleep(500);
		startPaneLog(session, stateDir);

		const rawPrompt = "Working Tool prompt echo must not count";
		const result = Bun.spawnSync(["bash", "scripts/gjc-session/prompt.sh", session, rawPrompt], {
			env: isolatedEnv({
				GJC_SESSION_STATE_DIR: stateDir,
				GJC_SESSION_PROMPT_EVIDENCE_ATTEMPTS: "1",
			}),
			stderr: "pipe",
			stdout: "pipe",
		});

		expect(result.exitCode).toBe(1);
		expect(result.stderr.toString()).toContain("prompt acceptance failed: no durable turn evidence appeared");
		expect(result.stdout.toString()).not.toContain("sent to");
		expect(result.stdout.toString()).not.toContain(rawPrompt);
		expect(result.stderr.toString()).not.toContain(rawPrompt);
		expect(await Bun.file(path.join(stateDir, "prompt-accepted.json")).exists()).toBe(false);
	}, 20000);


	test("prompt ignores stale evidence when capture window shifts after send", async () => {
		const session = `gjc_issue_1385_prompt_window_${process.pid}_${Date.now()}`;
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-session-prompt-window-"));
		tempRoots.push(root);
		const stateDir = path.join(root, "state");
		await fs.mkdir(stateDir, { recursive: true });
		await Bun.write(path.join(stateDir, "pane.log"), "");
		tmuxSessions.push(session);
		const script = `for i in $(seq 1 150); do if [ "$i" = 120 ]; then printf 'Working on previous prompt\n'; else printf 'filler %03d\n' "$i"; fi; done; printf '> Type your message\n'; sleep 20`;
		expect(Bun.spawnSync(["tmux", "new-session", "-d", "-s", session, "bash", "-lc", script]).exitCode).toBe(0);
		await Bun.sleep(500);
		startPaneLog(session, stateDir);

		const result = Bun.spawnSync(
			["bash", "scripts/gjc-session/prompt.sh", session, "new prompt sleeping process should not accept"],
			{
				env: isolatedEnv({
					GJC_SESSION_STATE_DIR: stateDir,
					GJC_SESSION_PROMPT_EVIDENCE_ATTEMPTS: "1",
				}),
				stderr: "pipe",
				stdout: "pipe",
			},
		);

		expect(result.exitCode).toBe(1);
		expect(result.stderr.toString()).toContain("prompt acceptance failed: no durable turn evidence appeared");
		expect(result.stdout.toString()).not.toContain("sent to");
	}, 20000);

	test("prompt accepts turn evidence produced after send", async () => {
		const session = `gjc_issue_1385_prompt_fresh_${process.pid}_${Date.now()}`;
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-session-prompt-fresh-"));
		tempRoots.push(root);
		const stateDir = path.join(root, "state");
		await fs.mkdir(stateDir, { recursive: true });
		await Bun.write(path.join(stateDir, "pane.log"), "");
		tmuxSessions.push(session);
		expect(
			Bun.spawnSync([
				"tmux",
				"new-session",
				"-d",
				"-s",
				session,
				"bash -lc \"printf 'Gajae forge\\n> Type your message\\n'; IFS= read -r line; printf '\\nWorking on accepted prompt\\n'; sleep 20\"",
			]).exitCode,
		).toBe(0);
		await Bun.sleep(500);
		startPaneLog(session, stateDir);

		const rawPrompt = "Working Tool accepted prompt still needs owner output";
		const result = Bun.spawnSync(["bash", "scripts/gjc-session/prompt.sh", session, rawPrompt], {
			env: isolatedEnv({
				GJC_SESSION_STATE_DIR: stateDir,
				GJC_SESSION_PROMPT_EVIDENCE_ATTEMPTS: "1",
			}),
			stderr: "pipe",
			stdout: "pipe",
		});

		expect(result.exitCode).toBe(0);
		expect(result.stdout.toString()).toContain("sent to");
		expect(result.stdout.toString()).not.toContain(rawPrompt);
		expect(await Bun.file(path.join(stateDir, "prompt-accepted.json")).exists()).toBe(true);
	}, 20000);
	test("runner marks owner exit after prompt acceptance as failure final", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-session-owner-exit-post-accept-"));
		tempRoots.push(root);
		const session = `gjc_issue_1496_owner_exit_post_accept_${process.pid}_${Date.now()}`;
		tmuxSessions.push(session);
		const worktree = await makeGitWorktree(root);
		const stateDir = path.join(root, "state");
		const fakeGjc = path.join(root, "bin", "gjc");
		await makeExecutable(
			fakeGjc,
			`#!/usr/bin/env bash
printf 'Gajae forge\n> Type your message\n'
IFS= read -r line
printf '\nWorking then owner exits before terminal status\n'
exit 0
`,
		);

		const created = Bun.spawnSync(["bash", "scripts/gjc-session/create.sh", session, worktree], {
			env: isolatedEnv({
				GJC_BIN: fakeGjc,
				GJC_SESSION_MONITOR_DISABLE: "1",
				GJC_SESSION_SKIP_ROUTER: "1",
				GJC_SESSION_STATE_DIR: stateDir,
			}),
			stderr: "pipe",
			stdout: "pipe",
		});
		expect(created.exitCode).toBe(0);

		const prompted = Bun.spawnSync(["bash", "scripts/gjc-session/prompt.sh", session, "accepted then exit"], {
			env: isolatedEnv({
				GJC_SESSION_STATE_DIR: stateDir,
				GJC_SESSION_PROMPT_EVIDENCE_ATTEMPTS: "2",
			}),
			stderr: "pipe",
			stdout: "pipe",
		});
		expect(prompted.exitCode).toBe(0);
		await waitForFile(path.join(stateDir, "final.json"));

		const finalStatus = (await Bun.file(path.join(stateDir, "final.json")).json()) as {
			promptAccepted: boolean;
			ownerExitReason: string;
			severity: string;
			turnEvidencePresent: boolean;
		};
		expect(finalStatus).toMatchObject({
			promptAccepted: true,
			turnEvidencePresent: true,
			ownerExitReason: "accepted_prompt_no_useful_output",
			severity: "failure",
			observedRecoverableWorktreeChanges: false,
			worktreeChangedSinceBaseline: false,
		});
	}, 20000);
	test("runner reports new recoverable worktree changes after prompt acceptance", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-session-owner-exit-dirty-"));
		tempRoots.push(root);
		const session = `gjc_issue_1496_owner_exit_dirty_${process.pid}_${Date.now()}`;
		tmuxSessions.push(session);
		const worktree = await makeGitWorktree(root);
		const stateDir = path.join(root, "state");
		const fakeGjc = path.join(root, "bin", "gjc");
		await makeExecutable(
			fakeGjc,
			`#!/usr/bin/env bash
printf 'Gajae forge\n> Type your message\n'
IFS= read -r line
printf '\nWorking then writing recoverable work\n'
printf 'fixture\nrecoverable private diff text\n' > README.md
exit 0
`,
		);

		const created = Bun.spawnSync(["bash", "scripts/gjc-session/create.sh", session, worktree], {
			env: isolatedEnv({
				GJC_BIN: fakeGjc,
				GJC_SESSION_MONITOR_DISABLE: "1",
				GJC_SESSION_SKIP_ROUTER: "1",
				GJC_SESSION_STATE_DIR: stateDir,
			}),
			stderr: "pipe",
			stdout: "pipe",
		});
		expect(created.exitCode).toBe(0);

		const prompted = Bun.spawnSync(["bash", "scripts/gjc-session/prompt.sh", session, "accepted then dirty"], {
			env: isolatedEnv({
				GJC_SESSION_STATE_DIR: stateDir,
				GJC_SESSION_PROMPT_EVIDENCE_ATTEMPTS: "2",
			}),
			stderr: "pipe",
			stdout: "pipe",
		});
		expect(prompted.exitCode).toBe(0);
		await waitForFile(path.join(stateDir, "final.json"));

		const finalStatus = (await Bun.file(path.join(stateDir, "final.json")).json()) as Record<string, unknown>;
		expect(finalStatus).toMatchObject({
			promptAccepted: true,
			ownerExitReason: "accepted_prompt_observed_recoverable_worktree_changes",
			severity: "failure",
			worktreeBaselineDirty: false,
			observedRecoverableWorktreeChanges: true,
			worktreeChangedSinceBaseline: true,
		});
		expect(JSON.stringify(finalStatus)).not.toContain("recoverable private diff text");
	}, 20000);

	test("runner does not overclaim pre-existing dirty worktree as new work", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-session-owner-exit-preexisting-dirty-"));
		tempRoots.push(root);
		const session = `gjc_issue_1496_owner_exit_preexisting_dirty_${process.pid}_${Date.now()}`;
		tmuxSessions.push(session);
		const worktree = await makeGitWorktree(root);
		await Bun.write(path.join(worktree, "README.md"), "fixture\npreexisting dirty text\n");
		const stateDir = path.join(root, "state");
		const fakeGjc = path.join(root, "bin", "gjc");
		await makeExecutable(
			fakeGjc,
			`#!/usr/bin/env bash
printf 'Gajae forge\n> Type your message\n'
IFS= read -r line
printf '\nWorking without new worktree changes\n'
exit 0
`,
		);

		const created = Bun.spawnSync(["bash", "scripts/gjc-session/create.sh", session, worktree], {
			env: isolatedEnv({
				GJC_BIN: fakeGjc,
				GJC_SESSION_MONITOR_DISABLE: "1",
				GJC_SESSION_SKIP_ROUTER: "1",
				GJC_SESSION_STATE_DIR: stateDir,
			}),
			stderr: "pipe",
			stdout: "pipe",
		});
		expect(created.exitCode).toBe(0);

		const prompted = Bun.spawnSync(["bash", "scripts/gjc-session/prompt.sh", session, "accepted preexisting dirty"], {
			env: isolatedEnv({
				GJC_SESSION_STATE_DIR: stateDir,
				GJC_SESSION_PROMPT_EVIDENCE_ATTEMPTS: "2",
			}),
			stderr: "pipe",
			stdout: "pipe",
		});
		expect(prompted.exitCode).toBe(0);
		await waitForFile(path.join(stateDir, "final.json"));

		const finalStatus = (await Bun.file(path.join(stateDir, "final.json")).json()) as Record<string, unknown>;
		expect(finalStatus).toMatchObject({
			promptAccepted: true,
			ownerExitReason: "accepted_prompt_dirty_worktree_observed_without_new_change_proof",
			severity: "failure",
			worktreeBaselineDirty: true,
			observedRecoverableWorktreeChanges: true,
			worktreeChangedSinceBaseline: false,
		});
		expect(String(finalStatus.ownerExitReason)).not.toContain("partial");
		expect(JSON.stringify(finalStatus)).not.toContain("preexisting dirty text");
	}, 20000);

	test("monitor preserves vanished marker when failure-final hold disappears after prompt acceptance", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-session-failure-final-vanish-"));
		tempRoots.push(root);
		const session = `gjc_issue_1496_failure_final_vanish_${process.pid}_${Date.now()}`;
		tmuxSessions.push(session);
		const worktree = await makeGitWorktree(root);
		const stateDir = path.join(root, "state");
		const fakeGjc = path.join(root, "bin", "gjc");
		await makeExecutable(
			fakeGjc,
			`#!/usr/bin/env bash
printf 'Gajae forge\n> Type your message\n'
IFS= read -r line
printf '\nWorking then owner exits before terminal status\n'
exit 0
`,
		);

		const created = Bun.spawnSync(["bash", "scripts/gjc-session/create.sh", session, worktree], {
			env: isolatedEnv({
				GJC_BIN: fakeGjc,
				GJC_SESSION_MONITOR_INTERVAL: "1",
				GJC_SESSION_SKIP_ROUTER: "1",
				GJC_SESSION_STATE_DIR: stateDir,
			}),
			stderr: "pipe",
			stdout: "pipe",
		});
		expect(created.exitCode).toBe(0);

		const prompted = Bun.spawnSync(["bash", "scripts/gjc-session/prompt.sh", session, "accepted then failure final"], {
			env: isolatedEnv({
				GJC_SESSION_STATE_DIR: stateDir,
				GJC_SESSION_PROMPT_EVIDENCE_ATTEMPTS: "2",
			}),
			stderr: "pipe",
			stdout: "pipe",
		});
		expect(prompted.exitCode).toBe(0);
		await waitForFile(path.join(stateDir, "final.json"));

		Bun.spawnSync(["tmux", "kill-session", "-t", session], { stderr: "pipe", stdout: "pipe" });
		await waitForFile(path.join(stateDir, "vanished.json"));

		const vanished = (await Bun.file(path.join(stateDir, "vanished.json")).json()) as {
			finalPresent: boolean;
			promptAccepted: boolean;
			reason: string;
			severity: string;
		};
		expect(vanished).toMatchObject({
			finalPresent: true,
			promptAccepted: true,
			reason: "tmux_session_missing_after_prompt_acceptance_failure_final",
			severity: "failure",
		});
	}, 20000);

	test("prompt accepts durable evidence when owner exits immediately after output", async () => {
		const session = `gjc_issue_1496_prompt_exit_after_evidence_${process.pid}_${Date.now()}`;
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-session-prompt-exit-after-evidence-"));
		tempRoots.push(root);
		const stateDir = path.join(root, "state");
		await fs.mkdir(stateDir, { recursive: true });
		await Bun.write(path.join(stateDir, "pane.log"), "");
		tmuxSessions.push(session);
		expect(
			Bun.spawnSync([
				"tmux",
				"new-session",
				"-d",
				"-s",
				session,
				"bash -lc \"printf 'Gajae forge\\n> Type your message\\n'; IFS= read -r line; printf '\\nWorking then exiting\\n'\"",
			]).exitCode,
		).toBe(0);
		await Bun.sleep(500);
		startPaneLog(session, stateDir);

		const result = Bun.spawnSync(["bash", "scripts/gjc-session/prompt.sh", session, "exit after evidence"], {
			env: isolatedEnv({
				GJC_SESSION_STATE_DIR: stateDir,
				GJC_SESSION_PROMPT_EVIDENCE_ATTEMPTS: "2",
			}),
			stderr: "pipe",
			stdout: "pipe",
		});

		expect(result.exitCode).toBe(0);
		expect(result.stdout.toString()).toContain("sent to");
		expect(await Bun.file(path.join(stateDir, "prompt-accepted.json")).exists()).toBe(true);
		expect(await Bun.file(path.join(stateDir, "pane.log")).text()).toContain("Working then exiting");
	}, 20000);
	test("prompt echo after submit cannot satisfy durable turn evidence", async () => {
		const session = `gjc_issue_1496_prompt_post_submit_echo_${process.pid}_${Date.now()}`;
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-session-prompt-post-submit-echo-"));
		tempRoots.push(root);
		const stateDir = path.join(root, "state");
		await fs.mkdir(stateDir, { recursive: true });
		await Bun.write(path.join(stateDir, "pane.log"), "");
		tmuxSessions.push(session);
		expect(
			Bun.spawnSync([
				"tmux",
				"new-session",
				"-d",
				"-s",
				session,
				"bash -lc \"printf 'Gajae forge\\n> Type your message\\n'; IFS= read -r line; printf '%s\\n' \\\"$line\\\"; sleep 20\"",
			]).exitCode,
		).toBe(0);
		await Bun.sleep(500);
		startPaneLog(session, stateDir);

		const rawPrompt = "Working Tool post submit echo only";
		const result = Bun.spawnSync(["bash", "scripts/gjc-session/prompt.sh", session, rawPrompt], {
			env: isolatedEnv({
				GJC_SESSION_STATE_DIR: stateDir,
				GJC_SESSION_PROMPT_EVIDENCE_ATTEMPTS: "1",
			}),
			stderr: "pipe",
			stdout: "pipe",
		});

		expect(result.exitCode).toBe(1);
		expect(result.stderr.toString()).toContain("prompt acceptance failed: no durable turn evidence appeared");
		expect(result.stdout.toString()).not.toContain("sent to");
		expect(result.stdout.toString()).not.toContain(rawPrompt);
		expect(result.stderr.toString()).not.toContain(rawPrompt);
		expect(await Bun.file(path.join(stateDir, "prompt-accepted.json")).exists()).toBe(false);
	}, 20000);
	test("prompt uses discovered durable pane log without state dir", async () => {
		const session = `gjc_issue_1496_prompt_discovery_${process.pid}_${Date.now()}`;
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-session-prompt-discovery-"));
		tempRoots.push(root);
		const stateDir = path.join(root, ".gjc-session-state", session);
		await fs.mkdir(stateDir, { recursive: true });
		await Bun.write(path.join(stateDir, "pane.log"), "");
		const unrelatedStateDir = path.join(root, "unrelated-state");
		await fs.mkdir(unrelatedStateDir, { recursive: true });
		await Bun.write(path.join(unrelatedStateDir, "pane.log"), "Working from unrelated ambient session\n");

		tmuxSessions.push(session);
		expect(
			Bun.spawnSync([
				"tmux",
				"new-session",
				"-d",
				"-s",
				session,
				"bash -lc \"printf 'Gajae forge\\n> Type your message\\n'; IFS= read -r line; printf '\\nWorking from discovered durable log\\n'; sleep 20\"",
			]).exitCode,
		).toBe(0);
		await Bun.sleep(500);
		startPaneLog(session, stateDir);

		const result = Bun.spawnSync(["bash", "scripts/gjc-session/prompt.sh", session, "discovery prompt"], {
			env: isolatedEnv({
				GJC_SESSION_LOG_SEARCH_ROOT: root,
				GJC_SESSION_STATE_DIR: unrelatedStateDir,
				GJC_SESSION_PROMPT_EVIDENCE_ATTEMPTS: "1",
			}),
			stderr: "pipe",
			stdout: "pipe",
		});

		expect(result.exitCode).toBe(0);
		expect(result.stdout.toString()).toContain("sent to");
		expect(await Bun.file(path.join(stateDir, "prompt-accepted.json")).exists()).toBe(true);
		expect(await Bun.file(path.join(stateDir, "pane.log")).text()).toContain("Working from discovered durable log");
	}, 20000);
});
