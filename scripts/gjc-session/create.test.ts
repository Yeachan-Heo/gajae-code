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
			env: {
				...process.env,
				GJC_BIN: fakeGjc,
				GJC_SESSION_MONITOR_DISABLE: "1",
				GJC_SESSION_SKIP_ROUTER: "1",
				GJC_SESSION_STATE_DIR: stateDir,
			},
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
			env: {
				...process.env,
				GJC_BIN: fakeGjc,
				GJC_SESSION_MONITOR_INTERVAL: "1",
				GJC_SESSION_ROUTER: fakeRouter,
				GJC_SESSION_SKIP_ROUTER: "1",
				GJC_SESSION_STATE_DIR: stateDir,
			},
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
			reason: "tmux_session_missing",
			severity: "failure",
		});
		expect(vanished.runtimeState).toBe(path.join(stateDir, "runtime-state.json"));
		expect(await Bun.file(routerLog).text()).toContain("tmux stale --session");
	});
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

		const result = Bun.spawnSync(["bash", "scripts/gjc-session/prompt.sh", session, "do work"], {
			env: {
				...process.env,
				GJC_SESSION_TURN_EVIDENCE_PATTERN: "__NO_TURN_EVIDENCE__",
				GJC_SESSION_STATE_DIR: stateDir,
				GJC_SESSION_PROMPT_EVIDENCE_ATTEMPTS: "1",
			},
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

		const result = Bun.spawnSync(["bash", "scripts/gjc-session/prompt.sh", session, "new prompt that sleeping process will not accept"], {
			env: {
				...process.env,
				GJC_SESSION_STATE_DIR: stateDir,
				GJC_SESSION_PROMPT_EVIDENCE_ATTEMPTS: "1",
			},
			stderr: "pipe",
			stdout: "pipe",
		});

		expect(result.exitCode).toBe(1);
		expect(result.stderr.toString()).toContain("prompt acceptance failed: no durable turn evidence appeared");
		expect(result.stdout.toString()).not.toContain("sent to");
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

		const result = Bun.spawnSync(
			["bash", "scripts/gjc-session/prompt.sh", session, "new prompt sleeping process should not accept"],
			{
				env: {
					...process.env,
					GJC_SESSION_STATE_DIR: stateDir,
					GJC_SESSION_PROMPT_EVIDENCE_ATTEMPTS: "1",
				},
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

		const result = Bun.spawnSync(["bash", "scripts/gjc-session/prompt.sh", session, "do accepted work"], {
			env: {
				...process.env,
				GJC_SESSION_STATE_DIR: stateDir,
				GJC_SESSION_PROMPT_EVIDENCE_ATTEMPTS: "1",
			},
			stderr: "pipe",
			stdout: "pipe",
		});

		expect(result.exitCode).toBe(0);
		expect(result.stdout.toString()).toContain("sent to");
	}, 20000);
});
