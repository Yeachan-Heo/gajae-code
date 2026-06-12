import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	claimGjcTeamTask,
	classifyGjcTeamCheckpointFiles,
	executeGjcTeamApiOperation,
	type GjcTeamConfig,
	listGjcTeams,
	monitorGjcTeam,
	monitorGjcTeamSnapshot,
	parseTeamLaunchArgs,
	readGjcTeamSnapshot,
	readGjcTeamTask,
	requestGjcWorkerIntegrationAttempt,
	resolveGjcTeamWorkerCli,
	resolveGjcTeamWorkerCliPlan,
	resolveGjcWorkerCommand,
	sendGjcTeamMessage,
	shutdownGjcTeam,
	startGjcTeam,
	transitionGjcTeamTask,
	translateGjcWorkerLaunchArgsForCli,
} from "../../src/gjc-runtime/team-runtime";

let cleanupRoot: string | undefined;
function runGit(cwd: string, args: string[]): string {
	const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	if (result.exitCode !== 0) throw new Error(result.stderr.toString() || `git ${args.join(" ")} failed`);
	return result.stdout.toString().trim();
}

async function createFakeTmuxBin(
	root: string,
	options: { failDisplay?: boolean; failSplit?: boolean; gjcProfile?: boolean } = {},
): Promise<string> {
	const binDir = path.join(root, ".test-bin");
	await fs.mkdir(binDir, { recursive: true });
	const logPath = path.join(root, "tmux.log");
	const script = `#!/usr/bin/env bash
echo "$@" >> ${JSON.stringify(logPath)}
case "$1" in
  display-message)
    ${
			options.failDisplay
				? "echo no current tmux >&2; exit 1"
				: `
    target=""
    for ((i=1; i<=$#; i++)); do
      if [ "\${!i}" = "-t" ]; then
        next=$((i + 1))
        target="\${!next}"
      fi
    done
    case "$target" in
      %2) echo "test-session:0 %2" ;;
      %9) echo "other-session:0 %9" ;;
      %1) echo "test-session:0 %1" ;;
      *) echo "test-session:0 %1" ;;
    esac
    `
}
    ;;
  show-options)
    if [ "${options.gjcProfile === false ? "0" : "1"}" = "1" ]; then echo "1"; exit 0; fi
    exit 1
    ;;
  split-window)
    ${options.failSplit ? "echo split failed >&2; exit 1" : ""}
    count_file=${JSON.stringify(path.join(root, "tmux-split-count"))}
    count=0
    if [ -f "$count_file" ]; then count=$(cat "$count_file"); fi
    count=$((count + 1))
    echo "$count" > "$count_file"
    echo "%$((count + 1))"
    ;;
  select-layout|kill-pane)
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`;
	await Bun.write(path.join(binDir, "tmux"), script);
	await fs.chmod(path.join(binDir, "tmux"), 0o755);
	return path.join(binDir, "tmux");
}

async function createGitRepo(): Promise<string> {
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-team-runtime-git-"));
	runGit(repo, ["init"]);
	runGit(repo, ["config", "user.email", "gjc@example.test"]);
	runGit(repo, ["config", "user.name", "GJC Test"]);
	await Bun.write(path.join(repo, "README.md"), "# test\n");
	runGit(repo, ["add", "README.md"]);
	runGit(repo, ["commit", "-m", "initial"]);
	return repo;
}

async function readTeamConfig(stateDir: string): Promise<GjcTeamConfig> {
	return Bun.file(path.join(stateDir, "config.json")).json() as Promise<GjcTeamConfig>;
}

async function commitFile(cwd: string, relativePath: string, content: string, message: string): Promise<string> {
	await Bun.write(path.join(cwd, relativePath), content);
	runGit(cwd, ["add", relativePath]);
	runGit(cwd, ["commit", "-m", message]);
	return runGit(cwd, ["rev-parse", "HEAD"]);
}

async function writeWorkerStatus(
	stateDir: string,
	worker: string,
	state: "idle" | "working" | "blocked" | "done" | "failed" | "draining" | "unknown",
): Promise<void> {
	await Bun.write(
		path.join(stateDir, "workers", worker, "status.json"),
		`${JSON.stringify({ state, updated_at: new Date().toISOString() }, null, 2)}\n`,
	);
}

async function readEvents(stateDir: string): Promise<string> {
	return Bun.file(path.join(stateDir, "events.jsonl")).text();
}

async function readMailbox(stateDir: string, worker: string): Promise<string> {
	return Bun.file(path.join(stateDir, "mailbox", `${worker}.json`)).text();
}

function commandCompletionEvidence(summary = "Completed with focused verification") {
	return {
		summary,
		items: [
			{
				kind: "command",
				status: "passed",
				summary: "Focused TeamMode runtime test passed",
				command:
					"bun test packages/coding-agent/test/gjc-runtime/team-runtime.test.ts --test-name-pattern completion evidence",
				output: "passed",
			},
		],
		files: ["packages/coding-agent/src/gjc-runtime/team-runtime.ts"],
		notes: "Focused completion evidence fixture",
	};
}

function inspectionCompletionEvidence(summary = "Completed by inspection") {
	return {
		summary,
		items: [
			{
				kind: "inspection",
				status: "verified",
				summary: "Leader-verifiable inspection evidence recorded",
				location: "agent://team-evidence-inspection",
			},
		],
		files: ["packages/coding-agent/test/gjc-runtime/team-runtime.test.ts"],
	};
}

function artifactCompletionEvidence(summary = "Completed by artifact review") {
	return {
		summary,
		items: [
			{
				kind: "artifact",
				status: "verified",
				summary: "Artifact was reviewed",
				artifact: ".gjc/state/team/demo/report.md",
			},
		],
	};
}

afterEach(async () => {
	if (cleanupRoot) {
		for (const session of [
			"gjc-worktree-team",
			"gjc-fail-team",
			"gjc-split-fail-team",
			"gjc-named-team",
			"gjc-cleanup-team",
			"gjc-dirty-cleanup-team",
		]) {
			Bun.spawnSync(["tmux", "kill-session", "-t", session], { stdout: "ignore", stderr: "ignore" });
		}
		await fs.rm(cleanupRoot, { recursive: true, force: true });
		cleanupRoot = undefined;
	}
});

describe("native gjc team runtime", () => {
	it("creates GJC-scoped team state, task mailboxes, and telemetry without delegating to legacy runtimes", async () => {
		cleanupRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-team-runtime-"));
		const snapshot = await startGjcTeam({
			workerCount: 1,
			agentType: "executor",
			task: "Implement the approved plan",
			teamName: "demo-team",
			cwd: cleanupRoot,
			dryRun: true,
			env: { PATH: "" },
		});

		expect(snapshot.team_name).toBe("demo-team");
		expect(snapshot.phase).toBe("running");
		expect(snapshot.state_dir).toContain(path.join(".gjc", "state", "team", "demo-team"));
		expect(snapshot.task_counts.pending).toBe(1);
		expect(snapshot.workers).toHaveLength(1);
		expect(snapshot.tmux_target).toBe("dry-run:0");
		expect(snapshot.workers[0]?.pane_id).toBe("%dry-run-worker-1");
		expect(snapshot.worker_lifecycle_by_id["worker-1"]?.lifecycle_state).toBe("starting");
		expect(snapshot.worker_lifecycle_by_id["worker-1"]?.worker_status_state).toBe("idle");
		expect(snapshot.worker_lifecycle_by_id["worker-1"]?.pane_id).toBe("%dry-run-worker-1");

		const config = await readTeamConfig(snapshot.state_dir);
		const manifest = await Bun.file(path.join(snapshot.state_dir, "manifest.v2.json")).json();
		expect(config.dry_run).toBe(true);
		expect(manifest.dry_run).toBe(true);

		const telemetry = await Bun.file(path.join(snapshot.state_dir, "telemetry.jsonl")).text();
		expect(telemetry).toContain("Native gjc team dry-run state initialized");
		expect(telemetry).toContain('"dry_run":true');
	});

	it("separates managed worker lifecycle from worker-reported status", async () => {
		cleanupRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-team-runtime-"));
		await startGjcTeam({
			workerCount: 1,
			agentType: "executor",
			task: "Report lifecycle separately",
			teamName: "worker-lifecycle-team",
			cwd: cleanupRoot,
			dryRun: true,
			env: { PATH: "" },
		});

		const initialStatus = (await executeGjcTeamApiOperation(
			"read-worker-status",
			{ team_name: "worker-lifecycle-team", worker_id: "worker-1" },
			cleanupRoot,
			{ PATH: "" },
		)) as { state: string };
		expect(initialStatus.state).toBe("idle");

		const startupAck = (await executeGjcTeamApiOperation(
			"worker-startup-ack",
			{ team_name: "worker-lifecycle-team", worker_id: "worker-1", pid: 1234, protocol_version: "1" },
			cleanupRoot,
			{ PATH: "" },
		)) as { pid?: number };
		expect(startupAck.pid).toBe(1234);

		let snapshot = await readGjcTeamSnapshot("worker-lifecycle-team", cleanupRoot, { PATH: "" });
		expect(snapshot.worker_lifecycle_by_id["worker-1"]?.lifecycle_state).toBe("ready");
		expect(snapshot.worker_lifecycle_by_id["worker-1"]?.worker_status_state).toBe("idle");
		expect(snapshot.worker_lifecycle_by_id["worker-1"]?.pid).toBe(1234);

		const workingStatus = (await executeGjcTeamApiOperation(
			"update-worker-status",
			{ team_name: "worker-lifecycle-team", worker_id: "worker-1", status: "working", current_task_id: "task-1" },
			cleanupRoot,
			{ PATH: "" },
		)) as { state: string; current_task_id?: string };
		expect(workingStatus.state).toBe("working");
		expect(workingStatus.current_task_id).toBe("task-1");

		snapshot = await readGjcTeamSnapshot("worker-lifecycle-team", cleanupRoot, { PATH: "" });
		expect(snapshot.worker_lifecycle_by_id["worker-1"]?.lifecycle_state).toBe("working");
		expect(snapshot.worker_lifecycle_by_id["worker-1"]?.worker_status_state).toBe("working");

		await executeGjcTeamApiOperation(
			"update-worker-status",
			{ team_name: "worker-lifecycle-team", worker_id: "worker-1", status: "blocked", reason: "waiting" },
			cleanupRoot,
			{ PATH: "" },
		);

		snapshot = await readGjcTeamSnapshot("worker-lifecycle-team", cleanupRoot, { PATH: "" });
		expect(snapshot.worker_lifecycle_by_id["worker-1"]?.lifecycle_state).toBe("ready");
		expect(snapshot.worker_lifecycle_by_id["worker-1"]?.worker_status_state).toBe("blocked");
		const forceRequest = (await executeGjcTeamApiOperation(
			"write-shutdown-request",
			{
				team_name: "worker-lifecycle-team",
				worker_id: "worker-1",
				requested_by: "leader-fixed",
				request_id: "manual-force-stop",
				mode: "force",
			},
			cleanupRoot,
			{ PATH: "" },
		)) as { mode?: string; request_id?: string };
		expect(forceRequest.mode).toBe("force");
		expect(forceRequest.request_id).toBe("manual-force-stop");

		snapshot = await readGjcTeamSnapshot("worker-lifecycle-team", cleanupRoot, { PATH: "" });
		expect(snapshot.worker_lifecycle_by_id["worker-1"]?.lifecycle_state).toBe("draining");
		expect(snapshot.worker_lifecycle_by_id["worker-1"]?.shutdown_mode).toBe("force");
		expect(snapshot.worker_lifecycle_by_id["worker-1"]?.worker_status_state).toBe("blocked");
	});

	it("persists the active worker command so tmux workers use the same gjc entrypoint", async () => {
		cleanupRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-team-runtime-"));
		const snapshot = await startGjcTeam({
			workerCount: 1,
			agentType: "executor",
			task: "Use local entrypoint",
			teamName: "entrypoint-team",
			cwd: cleanupRoot,
			dryRun: true,
			env: { PATH: "", GJC_TEAM_WORKER_COMMAND: "bun ./packages/coding-agent/src/cli.ts" },
		});

		const config = await Bun.file(path.join(snapshot.state_dir, "config.json")).json();
		const manifest = await Bun.file(path.join(snapshot.state_dir, "manifest.v2.json")).json();
		const telemetry = await Bun.file(path.join(snapshot.state_dir, "telemetry.jsonl")).text();

		expect(config.worker_command).toBe("bun ./packages/coding-agent/src/cli.ts");
		expect(manifest.worker_command).toBe("bun ./packages/coding-agent/src/cli.ts");
		expect(telemetry).toContain("bun ./packages/coding-agent/src/cli.ts");
		expect(resolveGjcWorkerCommand(cleanupRoot, { GJC_TEAM_WORKER_COMMAND: "gjc-dev" })).toBe("gjc-dev");
	});

	it("keeps worker CLI selection limited to GJC teammate sessions", async () => {
		expect(resolveGjcTeamWorkerCli({})).toBe("gjc");
		expect(resolveGjcTeamWorkerCli({ GJC_TEAM_WORKER_CLI: "auto" })).toBe("gjc");
		expect(resolveGjcTeamWorkerCli({ GJC_TEAM_WORKER_CLI: "gjc" })).toBe("gjc");
		expect(resolveGjcTeamWorkerCliPlan(3, { GJC_TEAM_WORKER_CLI_MAP: "auto" })).toEqual(["gjc", "gjc", "gjc"]);
		expect(resolveGjcTeamWorkerCliPlan(2, { GJC_TEAM_WORKER_CLI_MAP: "gjc,auto" })).toEqual(["gjc", "gjc"]);
		expect(translateGjcWorkerLaunchArgsForCli("gjc", ["--model", "frontier"])).toEqual(["--model", "frontier"]);
		cleanupRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-team-runtime-"));
		const snapshot = await startGjcTeam({
			workerCount: 2,
			agentType: "executor",
			task: "Launch GJC teammate sessions",
			teamName: "gjc-worker-cli-team",
			cwd: cleanupRoot,
			dryRun: true,
			env: { PATH: "", GJC_TEAM_WORKER_CLI_MAP: "gjc,auto" },
		});
		const config = await Bun.file(path.join(snapshot.state_dir, "config.json")).json();
		const manifest = await Bun.file(path.join(snapshot.state_dir, "manifest.v2.json")).json();
		const telemetry = await Bun.file(path.join(snapshot.state_dir, "telemetry.jsonl")).text();
		expect(config.worker_cli_plan).toEqual(["gjc", "gjc"]);
		expect(manifest.worker_cli_plan).toEqual(["gjc", "gjc"]);
		expect(telemetry).toContain('"worker_cli_plan":["gjc","gjc"]');

		for (const provider of ["codex", "claude", "gemini"]) {
			expect(() => resolveGjcTeamWorkerCli({ GJC_TEAM_WORKER_CLI: provider })).toThrow(
				/GJC team launches GJC teammate sessions only/,
			);
			expect(() => resolveGjcTeamWorkerCliPlan(1, { GJC_TEAM_WORKER_CLI_MAP: provider })).toThrow(
				/GJC team launches GJC teammate sessions only/,
			);
			expect(() =>
				resolveGjcTeamWorkerCliPlan(1, { GJC_TEAM_WORKER_CLI: provider, GJC_TEAM_WORKER_CLI_MAP: "gjc" }),
			).toThrow(/GJC team launches GJC teammate sessions only/);
			if (!cleanupRoot) cleanupRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-team-runtime-"));
			await expect(
				startGjcTeam({
					workerCount: 1,
					agentType: "executor",
					task: "Do not launch external teammate providers",
					teamName: `unsupported-${provider}`,
					cwd: cleanupRoot,
					dryRun: true,
					env: { PATH: "", GJC_TEAM_WORKER_CLI: provider },
				}),
			).rejects.toThrow(/GJC team launches GJC teammate sessions only/);
		}
	});

	it("parses team starts with automatic detached worktrees and legacy --worktree stripping", () => {
		const defaultStart = parseTeamLaunchArgs(["executor", "build", "feature"]);
		expect(defaultStart.worktreeMode).toEqual({ enabled: true, detached: true, name: null });
		expect(defaultStart.workerCount).toBe(3);
		expect(defaultStart.task).toBe("build feature");

		const multi = parseTeamLaunchArgs(["2:executor", "build", "feature"]);
		expect(multi.workerCount).toBe(2);
		expect(multi.agentType).toBe("executor");
		const worktreeMulti = parseTeamLaunchArgs(["--worktree", "3:debugger", "fix", "bug"]);
		expect(worktreeMulti.workerCount).toBe(3);

		const explicitDetached = parseTeamLaunchArgs(["--worktree", "1:debugger", "fix", "bug"]);
		expect(explicitDetached.worktreeMode).toEqual({ enabled: true, detached: true, name: null });
		expect(explicitDetached.workerCount).toBe(1);
		expect(explicitDetached.agentType).toBe("debugger");
		expect(explicitDetached.task).toBe("fix bug");

		const named = parseTeamLaunchArgs(["--worktree=feature/demo", "1:executor", "ship", "it"]);
		expect(named.worktreeMode).toEqual({ enabled: true, detached: false, name: "feature/demo" });
		expect(named.task).toBe("ship it");

		const separatedLong = parseTeamLaunchArgs(["--worktree", "feature/demo", "1:executor", "ship", "it"]);
		expect(separatedLong.worktreeMode).toEqual({ enabled: true, detached: false, name: "feature/demo" });
		expect(separatedLong.task).toBe("ship it");

		const separatedShort = parseTeamLaunchArgs(["-w", "feature/demo", "1:executor", "ship", "it"]);
		expect(separatedShort.worktreeMode).toEqual({ enabled: true, detached: false, name: "feature/demo" });
		expect(separatedShort.task).toBe("ship it");
	});

	it("creates worker worktrees by default for the tmux launch path", async () => {
		cleanupRoot = await createGitRepo();
		const fakeTmux = await createFakeTmuxBin(cleanupRoot);
		const snapshot = await startGjcTeam({
			workerCount: 1,
			agentType: "executor",
			task: "Use worker worktrees",
			teamName: "worktree-team",
			cwd: cleanupRoot,
			env: { PATH: process.env.PATH ?? "", GJC_TEAM_WORKER_COMMAND: "true", GJC_TEAM_TMUX_COMMAND: fakeTmux },
		});

		const config = await Bun.file(path.join(snapshot.state_dir, "config.json")).json();
		const manifest = await Bun.file(path.join(snapshot.state_dir, "manifest.v2.json")).json();

		expect(config.workspace_mode).toBe("worktree");
		expect(config.tmux_target).toBe("test-session:0");
		expect(config.tmux_session_name).toBe("test-session");
		expect(config.tmux_session).toBe("test-session");
		expect(config.leader.pane_id).toBe("%1");
		expect(manifest.workspace_mode).toBe("worktree");
		expect(manifest.tmux_target).toBe("test-session:0");
		expect(snapshot.tmux_target).toBe("test-session:0");
		expect(snapshot.workers).toHaveLength(1);
		for (const worker of snapshot.workers) {
			expect(worker.pane_id?.startsWith("%")).toBe(true);
			expect(worker.worktree_detached).toBe(true);
			expect(worker.worktree_base_ref).toBeTruthy();
			expect(worker.worktree_path).toContain(path.join(".gjc", "state", "team", "worktree-team", "worktrees"));
			const gitFile = await Bun.file(path.join(worker.worktree_path ?? "", ".git")).text();
			expect(gitFile).toContain("gitdir:");
		}
		const tmuxLog = await Bun.file(path.join(cleanupRoot, "tmux.log")).text();
		expect(tmuxLog).toContain("display-message -p #S:#I #{pane_id}");
		expect(tmuxLog).toContain("split-window -h -t %1 -d -P -F #{pane_id}");
		expect(tmuxLog).toContain("worker-startup-ack");
		expect(tmuxLog).toContain("protocol_version");
		expect(tmuxLog).toContain("claim-task/transition-task-status");
		expect(tmuxLog).toContain("select-layout -t test-session:0 main-vertical");
		expect(tmuxLog).toContain("set-option -t test-session:0 mouse on");
		expect(tmuxLog).toContain("set-option -t test-session:0 set-clipboard on");
		expect(tmuxLog).toContain("set-window-option -t test-session:0 mode-style fg=colour231,bg=colour60");
		expect(tmuxLog).not.toContain("set-option -g");
		expect(tmuxLog).not.toContain("new-session");
		expect(tmuxLog).not.toContain("kill-session");
	});

	it("resolves the team tmux leader from GJC_TMUX_COMMAND, not only GJC_TEAM_TMUX_COMMAND", async () => {
		cleanupRoot = await createGitRepo();
		const fakeTmux = await createFakeTmuxBin(cleanupRoot);
		const snapshot = await startGjcTeam({
			workerCount: 1,
			agentType: "executor",
			task: "Resolve tmux command from the general override",
			teamName: "tmux-command-override-team",
			cwd: cleanupRoot,
			env: { PATH: process.env.PATH ?? "", GJC_TEAM_WORKER_COMMAND: "true", GJC_TMUX_COMMAND: fakeTmux },
		});

		const config = await Bun.file(path.join(snapshot.state_dir, "config.json")).json();
		expect(config.tmux_command).toBe(fakeTmux);
		expect(config.tmux_target).toBe("test-session:0");
		const tmuxLog = await Bun.file(path.join(cleanupRoot, "tmux.log")).text();
		expect(tmuxLog).toContain("display-message -p #S:#I #{pane_id}");
	});

	it("starts multiple runtime workers before tmux state mutation", async () => {
		cleanupRoot = await createGitRepo();
		const fakeTmux = await createFakeTmuxBin(cleanupRoot);

		const snapshot = await startGjcTeam({
			workerCount: 2,
			agentType: "executor",
			task: "Start multi worker",
			teamName: "multi-team",
			cwd: cleanupRoot,
			env: { PATH: process.env.PATH ?? "", GJC_TEAM_WORKER_COMMAND: "true", GJC_TEAM_TMUX_COMMAND: fakeTmux },
		});

		expect(snapshot.workers).toHaveLength(2);
		expect(snapshot.workers.map(worker => worker.id)).toEqual(["worker-1", "worker-2"]);
		const tmuxLog = await Bun.file(path.join(cleanupRoot, "tmux.log")).text();
		expect(tmuxLog).toContain("split-window -h -t %1");
		expect(tmuxLog).toContain("split-window -v -t %2");
		expect(tmuxLog).not.toContain("new-session");
	});
	it("distributes explicit markdown lane sections into worker-owned initial tasks", async () => {
		cleanupRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-team-runtime-"));
		const snapshot = await startGjcTeam({
			workerCount: 2,
			agentType: "executor",
			task: [
				"Shared context for the coordinated run.",
				"",
				"### Lane A — Schema contract",
				"Define the durable schema and ID checks.",
				"",
				"### Lane B — Verification",
				"Add focused regression coverage.",
			].join("\n"),
			teamName: "lane-distribution-team",
			cwd: cleanupRoot,
			dryRun: true,
			env: { PATH: "" },
		});

		const task1 = await readGjcTeamTask("lane-distribution-team", "task-1", cleanupRoot, { PATH: "" });
		const task2 = await readGjcTeamTask("lane-distribution-team", "task-2", cleanupRoot, { PATH: "" });

		expect(snapshot.task_counts.pending).toBe(2);
		expect(task1.subject).toBe("Lane A — Schema contract");
		expect(task1.owner).toBe("worker-1");
		expect(task1.lane).toBe("lane-a");
		expect(task1.required_role).toBe("executor");
		expect(task1.description).toContain("Define the durable schema");
		expect(task1.description).not.toContain("Add focused regression coverage");
		expect(task2.subject).toBe("Lane B — Verification");
		expect(task2.owner).toBe("worker-2");
		expect(task2.lane).toBe("lane-b");
		expect(task2.description).toContain("Add focused regression coverage");
		expect(task2.description).not.toContain("Define the durable schema");
	});

	it("rejects ambiguous inline lane splits before duplicating broad multi-worker work", async () => {
		cleanupRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-team-runtime-"));
		await expect(
			startGjcTeam({
				workerCount: 4,
				agentType: "executor",
				task: "Implement turn orchestration. Split lanes: A schema, B delivery, C read_turn, D docs/tests.",
				teamName: "ambiguous-lane-team",
				cwd: cleanupRoot,
				dryRun: true,
				env: { PATH: "" },
			}),
		).rejects.toThrow("ambiguous_team_lane_split");
		expect(await Bun.file(path.join(cleanupRoot, ".gjc", "state", "team", "ambiguous-lane-team")).exists()).toBe(
			false,
		);
	});

	it("rejects ambiguous lane splits before non-dry-run state, worktree, or pane mutation", async () => {
		cleanupRoot = await createGitRepo();
		const fakeTmux = await createFakeTmuxBin(cleanupRoot);

		await expect(
			startGjcTeam({
				workerCount: 2,
				agentType: "executor",
				task: "Implement approved plan. Split lanes: A runtime, B tests.",
				teamName: "ambiguous-lane-worktree-team",
				cwd: cleanupRoot,
				env: { PATH: process.env.PATH ?? "", GJC_TEAM_WORKER_COMMAND: "true", GJC_TEAM_TMUX_COMMAND: fakeTmux },
			}),
		).rejects.toThrow("ambiguous_team_lane_split");

		expect(
			await Bun.file(path.join(cleanupRoot, ".gjc", "state", "team", "ambiguous-lane-worktree-team")).exists(),
		).toBe(false);
		expect(await Bun.file(path.join(cleanupRoot, "tmux-split-count")).exists()).toBe(false);
		const tmuxLog = await Bun.file(path.join(cleanupRoot, "tmux.log")).text();
		expect(tmuxLog).toContain("display-message -p #S:#I #{pane_id}");
		expect(tmuxLog).not.toContain("split-window");
	});

	it("fails outside current tmux before creating team state or worktrees", async () => {
		cleanupRoot = await createGitRepo();
		const fakeTmux = await createFakeTmuxBin(cleanupRoot, { failDisplay: true });

		await expect(
			startGjcTeam({
				workerCount: 1,
				agentType: "executor",
				task: "Fail loudly",
				teamName: "fail-team",
				cwd: cleanupRoot,
				env: { PATH: process.env.PATH ?? "", GJC_TEAM_WORKER_COMMAND: "true", GJC_TEAM_TMUX_COMMAND: fakeTmux },
			}),
		).rejects.toThrow(/gjc_team_requires_tmux_leader: run `gjc --tmux` first/);

		expect(await Bun.file(path.join(cleanupRoot, ".gjc", "state", "team", "fail-team", "phase.json")).exists()).toBe(
			false,
		);
		expect(
			await Bun.file(
				path.join(cleanupRoot, ".gjc", "state", "team", "fail-team", "worktrees", "worker-1", ".git"),
			).exists(),
		).toBe(false);
	});

	it("rejects unmanaged tmux sessions before state, worktree, split, or profile mutation", async () => {
		cleanupRoot = await createGitRepo();
		const fakeTmux = await createFakeTmuxBin(cleanupRoot, { gjcProfile: false });

		await expect(
			startGjcTeam({
				workerCount: 1,
				agentType: "executor",
				task: "Do not hijack tmux",
				teamName: "unmanaged-team",
				cwd: cleanupRoot,
				env: { PATH: process.env.PATH ?? "", GJC_TEAM_WORKER_COMMAND: "true", GJC_TEAM_TMUX_COMMAND: fakeTmux },
			}),
		).rejects.toThrow(/unmanaged_tmux_session:test-session/);

		expect(
			await Bun.file(path.join(cleanupRoot, ".gjc", "state", "team", "unmanaged-team", "phase.json")).exists(),
		).toBe(false);
		expect(
			await Bun.file(
				path.join(cleanupRoot, ".gjc", "state", "team", "unmanaged-team", "worktrees", "worker-1", ".git"),
			).exists(),
		).toBe(false);
		const tmuxLog = await Bun.file(path.join(cleanupRoot, "tmux.log")).text();
		expect(tmuxLog).toContain("display-message -p #S:#I #{pane_id}");
		expect(tmuxLog).toContain("show-options -qv -t =test-session @gjc-profile");
		expect(tmuxLog).not.toContain("split-window");
		expect(tmuxLog).not.toContain("set-option -t test-session:0");
	});

	it("cleans partial worker worktrees without killing the leader session when pane startup fails", async () => {
		cleanupRoot = await createGitRepo();
		const fakeTmux = await createFakeTmuxBin(cleanupRoot, { failSplit: true });

		await expect(
			startGjcTeam({
				workerCount: 1,
				agentType: "executor",
				task: "Fail split",
				teamName: "split-fail-team",
				cwd: cleanupRoot,
				env: { PATH: process.env.PATH ?? "", GJC_TEAM_WORKER_COMMAND: "true", GJC_TEAM_TMUX_COMMAND: fakeTmux },
			}),
		).rejects.toThrow(/split failed|tmux_split_failed/);

		const tmuxLog = await Bun.file(path.join(cleanupRoot, "tmux.log")).text();
		expect(tmuxLog).not.toContain("new-session");
		expect(tmuxLog).toContain("split-window");
		expect(tmuxLog).not.toContain("kill-session");
		await expect(
			Bun.file(
				path.join(cleanupRoot, ".gjc", "state", "team", "split-fail-team", "worktrees", "worker-1", ".git"),
			).text(),
		).rejects.toThrow();
	});

	it("creates named worker branches for legacy --worktree=<name> mode", async () => {
		cleanupRoot = await createGitRepo();
		const fakeTmux = await createFakeTmuxBin(cleanupRoot);
		const snapshot = await startGjcTeam({
			workerCount: 1,
			agentType: "executor",
			task: "Named worktree",
			teamName: "named-team",
			worktreeMode: { enabled: true, detached: false, name: "feature/demo" },
			cwd: cleanupRoot,
			env: { PATH: process.env.PATH ?? "", GJC_TEAM_WORKER_COMMAND: "true", GJC_TEAM_TMUX_COMMAND: fakeTmux },
		});

		expect(snapshot.workers[0]?.worktree_branch).toBe("feature/demo/named-team/worker-1");
		expect(snapshot.workers[0]?.worktree_detached).toBe(false);
		expect(
			Bun.spawnSync(["git", "branch", "--show-current"], { cwd: snapshot.workers[0]?.worktree_path, stdout: "pipe" })
				.stdout.toString()
				.trim(),
		).toBe("feature/demo/named-team/worker-1");
	});

	it("removes clean created worker worktrees on normal shutdown", async () => {
		cleanupRoot = await createGitRepo();
		const fakeTmux = await createFakeTmuxBin(cleanupRoot);
		const snapshot = await startGjcTeam({
			workerCount: 1,
			agentType: "executor",
			task: "Clean shutdown",
			teamName: "cleanup-team",
			cwd: cleanupRoot,
			env: { PATH: process.env.PATH ?? "", GJC_TEAM_WORKER_COMMAND: "true", GJC_TEAM_TMUX_COMMAND: fakeTmux },
		});
		const worktreePath = snapshot.workers[0]?.worktree_path ?? "";
		expect(await Bun.file(path.join(worktreePath, ".git")).exists()).toBe(true);

		const stopped = await shutdownGjcTeam("cleanup-team", cleanupRoot, { PATH: process.env.PATH ?? "" });

		expect(stopped.phase).toBe("cancelled");
		expect(await Bun.file(path.join(worktreePath, ".git")).exists()).toBe(false);
		const tmuxLog = await Bun.file(path.join(cleanupRoot, "tmux.log")).text();
		expect(tmuxLog).toContain("display-message -p -t %2 #S:#I #{pane_id}");
		expect(tmuxLog).toContain("kill-pane -t %2");
		expect(tmuxLog).not.toContain("kill-session");
	});

	it("does not kill stale or leader pane ids during shutdown", async () => {
		cleanupRoot = await createGitRepo();
		const fakeTmux = await createFakeTmuxBin(cleanupRoot);
		const snapshot = await startGjcTeam({
			workerCount: 1,
			agentType: "executor",
			task: "Stale pane shutdown",
			teamName: "stale-pane-team",
			cwd: cleanupRoot,
			env: { PATH: process.env.PATH ?? "", GJC_TEAM_WORKER_COMMAND: "true", GJC_TEAM_TMUX_COMMAND: fakeTmux },
		});
		const configPath = path.join(snapshot.state_dir, "config.json");
		const config = await Bun.file(configPath).json();
		await Bun.write(
			configPath,
			`${JSON.stringify({ ...config, workers: [{ ...config.workers[0], pane_id: "%9" }] }, null, 2)}\n`,
		);

		await shutdownGjcTeam("stale-pane-team", cleanupRoot, {
			PATH: process.env.PATH ?? "",
			GJC_TEAM_TMUX_COMMAND: fakeTmux,
		});

		const tmuxLog = await Bun.file(path.join(cleanupRoot, "tmux.log")).text();
		expect(tmuxLog).toContain("display-message -p -t %9 #S:#I #{pane_id}");
		expect(tmuxLog).not.toContain("kill-pane -t %9");
	});

	it("preserves dirty worker worktrees on normal shutdown", async () => {
		cleanupRoot = await createGitRepo();
		const fakeTmux = await createFakeTmuxBin(cleanupRoot);
		const snapshot = await startGjcTeam({
			workerCount: 1,
			agentType: "executor",
			task: "Preserve dirty shutdown",
			teamName: "dirty-cleanup-team",
			cwd: cleanupRoot,
			env: { PATH: process.env.PATH ?? "", GJC_TEAM_WORKER_COMMAND: "true", GJC_TEAM_TMUX_COMMAND: fakeTmux },
		});
		const worktreePath = snapshot.workers[0]?.worktree_path ?? "";
		await Bun.write(path.join(worktreePath, "worker-change.txt"), "keep me\n");

		const stopped = await shutdownGjcTeam("dirty-cleanup-team", cleanupRoot, { PATH: process.env.PATH ?? "" });

		expect(stopped.phase).toBe("cancelled");
		expect(await Bun.file(path.join(worktreePath, "worker-change.txt")).text()).toBe("keep me\n");
	});

	it("supports task claim, transition, list, status, and shutdown lifecycle operations", async () => {
		cleanupRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-team-runtime-"));
		await startGjcTeam({
			workerCount: 1,
			agentType: "executor",
			task: "Ship lifecycle",
			teamName: "life-team",
			cwd: cleanupRoot,
			dryRun: true,
			env: { PATH: "" },
		});

		await expect(
			transitionGjcTeamTask("life-team", "task-1", "completed", cleanupRoot, { PATH: "" }),
		).rejects.toThrow("claim_token_required:task-1");

		const claim = await claimGjcTeamTask("life-team", "worker-1", cleanupRoot, { PATH: "" });
		expect(claim.ok).toBe(true);
		await expect(
			transitionGjcTeamTask("life-team", "task-1", "completed", cleanupRoot, { PATH: "" }),
		).rejects.toThrow("claim_token_required:task-1");
		await expect(
			transitionGjcTeamTask("life-team", "task-1", "pending", cleanupRoot, { PATH: "" }, claim.claim_token),
		).rejects.toThrow("invalid_task_transition:task-1:pending_requires_release");
		expect(claim.task?.status).toBe("in_progress");
		const task = await transitionGjcTeamTask(
			"life-team",
			"task-1",
			"completed",
			cleanupRoot,
			{ PATH: "" },
			claim.claim_token,
			commandCompletionEvidence(),
		);
		expect(task.status).toBe("completed");
		expect(task.completion_evidence?.items[0]?.kind).toBe("command");
		expect(task.completion_evidence?.recorded_by).toBe("worker-1");
		expect(task.claim).toBeUndefined();
		expect(
			await Bun.file(path.join(cleanupRoot, ".gjc", "state", "team", "life-team", "claims", "task-1.json")).exists(),
		).toBe(false);
		await expect(
			executeGjcTeamApiOperation(
				"release-task-claim",
				{ team_name: "life-team", task_id: "task-1", worker: "worker-1", claim_token: claim.claim_token },
				cleanupRoot,
				{ PATH: "" },
			),
		).rejects.toThrow(/task_terminal|claim_token_mismatch/);
		await expect(
			executeGjcTeamApiOperation(
				"transition-task-status",
				{ team_name: "life-team", task_id: "task-1", to: "pending" },
				cleanupRoot,
				{ PATH: "" },
			),
		).rejects.toThrow("invalid_task_transition:task-1:pending_requires_release");
		const reclaim = await claimGjcTeamTask("life-team", "worker-1", cleanupRoot, { PATH: "" }, "task-1");
		expect(reclaim.ok).toBe(false);
		expect(reclaim.reason).toBe("task_not_pending:task-1");

		const status = await readGjcTeamSnapshot("life-team", cleanupRoot, { PATH: "" });
		expect(status.task_counts.completed).toBe(1);
		expect(await listGjcTeams(cleanupRoot, { PATH: "" })).toHaveLength(1);

		const stopped = await shutdownGjcTeam("life-team", cleanupRoot, { PATH: "" });
		expect(stopped.phase).toBe("complete");
		expect(stopped.workers[0]?.status).toBe("stopped");
		expect(stopped.worker_lifecycle_by_id["worker-1"]?.lifecycle_state).toBe("stopped");
		expect(stopped.worker_lifecycle_by_id["worker-1"]?.shutdown_mode).toBe("graceful");
		expect(stopped.worker_lifecycle_by_id["worker-1"]?.shutdown_request_id?.startsWith("shutdown-")).toBe(true);
		const shutdownRequest = (await Bun.file(
			path.join(cleanupRoot, ".gjc", "state", "team", "life-team", "workers", "worker-1", "shutdown-request.json"),
		).json()) as { mode?: string; request_id?: string };
		expect(shutdownRequest.mode).toBe("graceful");
		expect(shutdownRequest.request_id).toBe(stopped.worker_lifecycle_by_id["worker-1"]?.shutdown_request_id);
	});

	it("chains claim, transition, and release using receipt-only task fields", async () => {
		cleanupRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-team-runtime-"));
		await startGjcTeam({
			workerCount: 1,
			agentType: "executor",
			task: "Receipt lifecycle",
			teamName: "receipt-team",
			cwd: cleanupRoot,
			dryRun: true,
			env: { PATH: "" },
		});

		const claimReceipt = (await executeGjcTeamApiOperation(
			"claim-task",
			{ team_name: "receipt-team", worker_id: "worker-1" },
			cleanupRoot,
			{ PATH: "" },
		)) as {
			ok: boolean;
			team_name: string;
			worker_id: string;
			task_id: string;
			status: string;
			claim_token: string;
			task?: unknown;
		};
		expect(claimReceipt).toMatchObject({
			ok: true,
			team_name: "receipt-team",
			worker_id: "worker-1",
			task_id: "task-1",
			status: "in_progress",
		});
		expect(claimReceipt.claim_token).toBeTruthy();
		expect(claimReceipt.task).toBeUndefined();

		const releaseReceipt = (await executeGjcTeamApiOperation(
			"release-task-claim",
			{
				team_name: claimReceipt.team_name,
				worker_id: claimReceipt.worker_id,
				task_id: claimReceipt.task_id,
				claim_token: claimReceipt.claim_token,
			},
			cleanupRoot,
			{ PATH: "" },
		)) as { ok: boolean; worker_id: string; task_id: string; status: string; task?: unknown };
		expect(releaseReceipt).toMatchObject({ ok: true, worker_id: "worker-1", task_id: "task-1", status: "pending" });
		expect(releaseReceipt.task).toBeUndefined();

		const secondClaimReceipt = (await executeGjcTeamApiOperation(
			"claim-task",
			{ team_name: "receipt-team", worker_id: releaseReceipt.worker_id, task_id: releaseReceipt.task_id },
			cleanupRoot,
			{ PATH: "" },
		)) as { ok: boolean; worker_id: string; task_id: string; status: string; claim_token: string; task?: unknown };
		expect(secondClaimReceipt).toMatchObject({
			ok: true,
			worker_id: "worker-1",
			task_id: "task-1",
			status: "in_progress",
		});
		expect(secondClaimReceipt.claim_token).toBeTruthy();
		expect(secondClaimReceipt.task).toBeUndefined();

		const transitionReceipt = (await executeGjcTeamApiOperation(
			"transition-task-status",
			{
				team_name: "receipt-team",
				worker_id: secondClaimReceipt.worker_id,
				task_id: secondClaimReceipt.task_id,
				to: "blocked",
				claim_token: secondClaimReceipt.claim_token,
			},
			cleanupRoot,
			{ PATH: "" },
		)) as {
			ok: boolean;
			worker_id: string;
			task_id: string;
			status: string;
			task?: unknown;
			completion_evidence?: unknown;
		};
		expect(transitionReceipt).toMatchObject({
			ok: true,
			worker_id: "worker-1",
			task_id: "task-1",
			status: "blocked",
		});
		expect(transitionReceipt.task).toBeUndefined();
		expect(transitionReceipt.completion_evidence).toBeUndefined();
	});

	it("writes versioned structured traces linked to legacy events", async () => {
		cleanupRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-team-runtime-"));
		const snapshot = await startGjcTeam({
			workerCount: 1,
			agentType: "executor",
			task: "Trace runtime events",
			teamName: "trace-team",
			cwd: cleanupRoot,
			dryRun: true,
			env: { PATH: "" },
		});
		const stateDir = snapshot.state_dir;
		const firstEvent = JSON.parse((await readEvents(stateDir)).trim().split(/\r?\n/)[0] ?? "") as {
			event_id: string;
			type: string;
		};
		const firstTrace = JSON.parse(
			(await Bun.file(path.join(stateDir, "trace.jsonl")).text()).trim().split(/\r?\n/)[0] ?? "",
		) as {
			schema_version: number;
			trace_id: string;
			span_id: string;
			source_event_id: string;
			event_type: string;
		};
		expect(firstTrace.schema_version).toBe(1);
		expect(firstTrace.trace_id.startsWith("trace-")).toBe(true);
		expect(firstTrace.span_id.startsWith("span-")).toBe(true);
		expect(firstTrace.source_event_id).toBe(firstEvent.event_id);
		expect(firstTrace.event_type).toBe(firstEvent.type);

		const claim = await claimGjcTeamTask("trace-team", "worker-1", cleanupRoot, { PATH: "" });
		expect(claim.ok).toBe(true);
		await transitionGjcTeamTask(
			"trace-team",
			"task-1",
			"completed",
			cleanupRoot,
			{ PATH: "" },
			claim.claim_token,
			commandCompletionEvidence("trace-backed completion"),
		);

		const traceRead = (await executeGjcTeamApiOperation("read-traces", { team_name: "trace-team" }, cleanupRoot, {
			PATH: "",
		})) as {
			traces: Array<{ event_type: string; source_event_id: string; evidence_refs?: string[] }>;
		};
		const completionTrace = traceRead.traces.find(trace => trace.event_type === "task_transitioned");
		expect(completionTrace?.source_event_id).toBeTruthy();
		expect(completionTrace?.evidence_refs).toContain("task:task-1:completion_evidence");
		expect(await Bun.file(path.join(stateDir, "trace-errors.jsonl")).exists()).toBe(false);
	});

	it("sanitizes mailbox bodies from structured traces", async () => {
		cleanupRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-team-runtime-"));
		const snapshot = await startGjcTeam({
			workerCount: 1,
			agentType: "executor",
			task: "Trace sanitizer runtime events",
			teamName: "trace-sanitized-team",
			cwd: cleanupRoot,
			dryRun: true,
			env: { PATH: "" },
		});
		const secretBody = "SECRET_TOKEN=abc123";
		const message = await sendGjcTeamMessage(
			"trace-sanitized-team",
			"worker-1",
			"leader-fixed",
			secretBody,
			cleanupRoot,
			{ PATH: "" },
		);
		const traceJsonl = await Bun.file(path.join(snapshot.state_dir, "trace.jsonl")).text();
		expect(traceJsonl).not.toContain(secretBody);
		expect(traceJsonl).not.toContain("SECRET_TOKEN");

		const traceRead = (await executeGjcTeamApiOperation(
			"read-traces",
			{ team_name: "trace-sanitized-team" },
			cleanupRoot,
			{ PATH: "" },
		)) as { traces: Array<{ event_type: string; message?: string; data?: Record<string, unknown> }> };
		const serializedTraces = JSON.stringify(traceRead);
		expect(serializedTraces).not.toContain(secretBody);
		expect(serializedTraces).not.toContain("SECRET_TOKEN");
		const sentTrace = traceRead.traces.find(trace => trace.event_type === "message_sent");
		expect(sentTrace?.message).toBeUndefined();
		expect(sentTrace?.data?.to_worker).toBe("leader-fixed");
		expect(sentTrace?.data?.message_id).toBe(message.message_id);
		expect(sentTrace?.data?.body_byte_length).toBe(Buffer.byteLength(secretBody, "utf8"));
		expect(typeof sentTrace?.data?.body_sha256).toBe("string");
		expect(String(sentTrace?.data?.body_sha256)).toHaveLength(64);
		expect(sentTrace?.data?.body).toBeUndefined();
	});

	it("stores structured completion evidence in task listings and honors claim tokens without implicit worker defaults", async () => {
		cleanupRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-team-runtime-"));
		await startGjcTeam({
			workerCount: 2,
			agentType: "executor",
			task: "Complete with evidence",
			teamName: "evidence-team",
			cwd: cleanupRoot,
			dryRun: true,
			env: { PATH: "" },
		});
		const stateDir = path.join(cleanupRoot, ".gjc", "state", "team", "evidence-team");

		const workerTwoClaim = await claimGjcTeamTask("evidence-team", "worker-2", cleanupRoot, { PATH: "" }, "task-2");
		expect(workerTwoClaim.ok).toBe(true);
		await executeGjcTeamApiOperation(
			"transition-task-status",
			{
				team_name: "evidence-team",
				task_id: "task-2",
				to: "completed",
				claim_token: workerTwoClaim.claim_token,
				completion_evidence: inspectionCompletionEvidence("worker-2 completed by inspection"),
			},
			cleanupRoot,
			{ PATH: "" },
		);

		const completedTask = await readGjcTeamTask("evidence-team", "task-2", cleanupRoot, { PATH: "" });
		expect(completedTask.completion_evidence?.items[0]?.kind).toBe("inspection");
		expect(await Bun.file(path.join(stateDir, "evidence", "tasks", "task-2.json")).exists()).toBe(false);
		expect(await Bun.file(path.join(stateDir, "tasks", "task-2.evidence.json")).exists()).toBe(false);
		await Bun.write(
			path.join(stateDir, "tasks", "task-2.evidence.json"),
			`${JSON.stringify({ task_id: "task-2", evidence: "legacy colocated evidence" }, null, 2)}\n`,
		);
		const listed = (await executeGjcTeamApiOperation("list-tasks", { team_name: "evidence-team" }, cleanupRoot, {
			PATH: "",
		})) as { tasks: Array<{ id: string; status: string }> };
		expect(listed.tasks.map(task => task.id)).toEqual(["task-1", "task-2"]);
		expect(listed.tasks.find(task => task.id === "task-2")?.status).toBe("completed");

		const workerOneClaim = await claimGjcTeamTask("evidence-team", "worker-1", cleanupRoot, { PATH: "" }, "task-1");
		expect(workerOneClaim.ok).toBe(true);
		await expect(
			executeGjcTeamApiOperation(
				"transition-task-status",
				{
					team_name: "evidence-team",
					task_id: "task-1",
					to: "failed",
					claim_token: workerOneClaim.claim_token,
					worker_id: "worker-2",
				},
				cleanupRoot,
				{ PATH: "" },
			),
		).rejects.toThrow("claim_owner_mismatch:task-1");
	});

	it("rejects completed transitions without valid evidence and leaves task state unchanged", async () => {
		cleanupRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-team-runtime-"));
		await startGjcTeam({
			workerCount: 1,
			agentType: "executor",
			task: "Reject invalid completion evidence",
			teamName: "invalid-evidence-team",
			cwd: cleanupRoot,
			dryRun: true,
			env: { PATH: "" },
		});
		const stateDir = path.join(cleanupRoot, ".gjc", "state", "team", "invalid-evidence-team");
		const claim = await claimGjcTeamTask("invalid-evidence-team", "worker-1", cleanupRoot, { PATH: "" });
		expect(claim.ok).toBe(true);
		const taskBefore = await readGjcTeamTask("invalid-evidence-team", "task-1", cleanupRoot, { PATH: "" });
		const eventsBefore = await readEvents(stateDir);
		const claimPath = path.join(stateDir, "claims", "task-1.json");

		await expect(
			transitionGjcTeamTask(
				"invalid-evidence-team",
				"task-1",
				"completed",
				cleanupRoot,
				{ PATH: "" },
				claim.claim_token,
			),
		).rejects.toThrow("completion_evidence_required:task-1");

		for (const invalid of [
			{
				evidence: { summary: "", items: [commandCompletionEvidence().items[0]] },
				error: "invalid_completion_evidence:task-1:summary",
			},
			{
				evidence: { summary: "No items", items: [] },
				error: "invalid_completion_evidence:task-1:items",
			},
			{
				evidence: { summary: "Bad kind", items: [{ kind: "note", status: "verified", summary: "bad" }] },
				error: "invalid_completion_evidence:task-1:items.kind",
			},
			{
				evidence: {
					summary: "No verified item",
					items: [{ kind: "command", status: "failed", summary: "failed check", command: "bun test" }],
				},
				error: "completion_evidence_no_verified_item:task-1",
			},
		]) {
			await expect(
				transitionGjcTeamTask(
					"invalid-evidence-team",
					"task-1",
					"completed",
					cleanupRoot,
					{ PATH: "" },
					claim.claim_token,
					invalid.evidence,
				),
			).rejects.toThrow(invalid.error);
		}

		const taskAfter = await readGjcTeamTask("invalid-evidence-team", "task-1", cleanupRoot, { PATH: "" });
		expect(taskAfter.status).toBe(taskBefore.status);
		expect(taskAfter.version).toBe(taskBefore.version);
		expect(taskAfter.completed_at).toBeUndefined();
		expect(taskAfter.completion_evidence).toBeUndefined();
		expect(await Bun.file(claimPath).exists()).toBe(true);
		expect(await readEvents(stateDir)).toBe(eventsBefore);
	});

	it("allows non-command completion evidence and requires evidence-backed shutdown completion", async () => {
		cleanupRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-team-runtime-"));
		await startGjcTeam({
			workerCount: 2,
			agentType: "executor",
			task: "Complete with review evidence",
			teamName: "review-evidence-team",
			cwd: cleanupRoot,
			dryRun: true,
			env: { PATH: "" },
		});

		const firstClaim = await claimGjcTeamTask(
			"review-evidence-team",
			"worker-1",
			cleanupRoot,
			{ PATH: "" },
			"task-1",
		);
		expect(firstClaim.ok).toBe(true);
		const first = await transitionGjcTeamTask(
			"review-evidence-team",
			"task-1",
			"completed",
			cleanupRoot,
			{ PATH: "" },
			firstClaim.claim_token,
			inspectionCompletionEvidence("inspection-only task completed"),
		);
		expect(first.completion_evidence?.items[0]?.kind).toBe("inspection");

		const secondClaim = await claimGjcTeamTask(
			"review-evidence-team",
			"worker-2",
			cleanupRoot,
			{ PATH: "" },
			"task-2",
		);
		expect(secondClaim.ok).toBe(true);
		await executeGjcTeamApiOperation(
			"transition-task-status",
			{
				team_name: "review-evidence-team",
				task_id: "task-2",
				to: "completed",
				claim_token: secondClaim.claim_token,
				completion_evidence: artifactCompletionEvidence("artifact-backed task completed"),
			},
			cleanupRoot,
			{ PATH: "" },
		);

		const stopped = await shutdownGjcTeam("review-evidence-team", cleanupRoot, { PATH: "" });
		expect(stopped.phase).toBe("complete");
	});

	it("treats legacy evidence-free completed tasks as failed on shutdown", async () => {
		cleanupRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-team-runtime-"));
		await startGjcTeam({
			workerCount: 1,
			agentType: "executor",
			task: "Legacy completed task",
			teamName: "legacy-completed-team",
			cwd: cleanupRoot,
			dryRun: true,
			env: { PATH: "" },
		});
		const stateDir = path.join(cleanupRoot, ".gjc", "state", "team", "legacy-completed-team");
		const task = await readGjcTeamTask("legacy-completed-team", "task-1", cleanupRoot, { PATH: "" });
		await Bun.write(
			path.join(stateDir, "tasks", "task-1.json"),
			`${JSON.stringify({ ...task, status: "completed", completed_at: new Date().toISOString() }, null, 2)}\n`,
		);

		const stopped = await shutdownGjcTeam("legacy-completed-team", cleanupRoot, { PATH: "" });
		expect(stopped.phase).toBe("failed");
		expect(await readEvents(stateDir)).toContain("completion_evidence_required:task-1");
	});

	it("recovers expired task claims before new claim attempts", async () => {
		cleanupRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-team-runtime-"));
		await startGjcTeam({
			workerCount: 1,
			agentType: "executor",
			task: "Recover expired claim",
			teamName: "expired-claim-team",
			cwd: cleanupRoot,
			dryRun: true,
			env: { PATH: "" },
		});
		const stateDir = path.join(cleanupRoot, ".gjc", "state", "team", "expired-claim-team");
		const claim = await claimGjcTeamTask("expired-claim-team", "worker-1", cleanupRoot, { PATH: "" });
		expect(claim.ok).toBe(true);
		const claimedTask = await readGjcTeamTask("expired-claim-team", "task-1", cleanupRoot, { PATH: "" });
		if (!claimedTask.claim) throw new Error("expected claimed task");
		const expiredClaim = { ...claimedTask.claim, leased_until: new Date(Date.now() - 60_000).toISOString() };
		await Bun.write(
			path.join(stateDir, "tasks", "task-1.json"),
			`${JSON.stringify({ ...claimedTask, claim: expiredClaim }, null, 2)}\n`,
		);
		await Bun.write(path.join(stateDir, "claims", "task-1.json"), `${JSON.stringify(expiredClaim, null, 2)}\n`);

		const recoveredClaim = await claimGjcTeamTask("expired-claim-team", "worker-1", cleanupRoot, { PATH: "" });
		expect(recoveredClaim.ok).toBe(true);
		expect(recoveredClaim.claim_token).not.toBe(claim.claim_token);
		expect(recoveredClaim.task?.status).toBe("in_progress");
		expect(recoveredClaim.task?.claim?.leased_until).not.toBe(expiredClaim.leased_until);
		expect(await readEvents(stateDir)).toContain("claim_expired");
	});

	it("recovers stale heartbeat claims during monitor and blocks stale workers from reclaiming", async () => {
		cleanupRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-team-runtime-"));
		await startGjcTeam({
			workerCount: 1,
			agentType: "executor",
			task: "Recover stale heartbeat",
			teamName: "stale-heartbeat-team",
			cwd: cleanupRoot,
			dryRun: true,
			env: { PATH: "" },
		});
		const stateDir = path.join(cleanupRoot, ".gjc", "state", "team", "stale-heartbeat-team");
		const claim = await claimGjcTeamTask("stale-heartbeat-team", "worker-1", cleanupRoot, { PATH: "" });
		expect(claim.ok).toBe(true);
		await Bun.write(
			path.join(stateDir, "workers", "worker-1", "heartbeat.json"),
			`${JSON.stringify(
				{ pid: 0, last_turn_at: new Date(Date.now() - 60_000).toISOString(), turn_count: 1, alive: true },
				null,
				2,
			)}\n`,
		);

		const snapshot = await monitorGjcTeam("stale-heartbeat-team", cleanupRoot, {
			PATH: "",
			GJC_TEAM_HEARTBEAT_STALE_MS: "1",
		});
		expect(snapshot.task_counts.pending).toBe(1);
		expect(await Bun.file(path.join(stateDir, "claims", "task-1.json")).exists()).toBe(false);
		expect(await readEvents(stateDir)).toContain("stale_heartbeat");

		const retry = await claimGjcTeamTask("stale-heartbeat-team", "worker-1", cleanupRoot, {
			PATH: "",
			GJC_TEAM_HEARTBEAT_STALE_MS: "1",
		});
		expect(retry.ok).toBe(false);
		expect(retry.reason).toContain("worker_not_live:worker-1:stale_heartbeat");
	});

	it("keeps read-only status separate from mutating monitor recovery", async () => {
		cleanupRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-team-runtime-"));
		await startGjcTeam({
			workerCount: 1,
			agentType: "executor",
			task: "Separate status and monitor",
			teamName: "status-semantics-team",
			cwd: cleanupRoot,
			dryRun: true,
			env: { PATH: "" },
		});
		const stateDir = path.join(cleanupRoot, ".gjc", "state", "team", "status-semantics-team");
		const claim = await claimGjcTeamTask("status-semantics-team", "worker-1", cleanupRoot, { PATH: "" });
		expect(claim.ok).toBe(true);
		await Bun.write(
			path.join(stateDir, "workers", "worker-1", "heartbeat.json"),
			`${JSON.stringify(
				{ pid: 0, last_turn_at: new Date(Date.now() - 60_000).toISOString(), turn_count: 1, alive: true },
				null,
				2,
			)}\n`,
		);

		const statusSnapshot = await readGjcTeamSnapshot("status-semantics-team", cleanupRoot, {
			PATH: "",
			GJC_TEAM_HEARTBEAT_STALE_MS: "1",
		});
		expect(statusSnapshot.task_counts.in_progress).toBe(1);
		expect(await Bun.file(path.join(stateDir, "claims", "task-1.json")).exists()).toBe(true);
		expect(await readEvents(stateDir)).not.toContain("stale_heartbeat");

		const monitorSnapshot = await monitorGjcTeamSnapshot("status-semantics-team", cleanupRoot, {
			PATH: "",
			GJC_TEAM_HEARTBEAT_STALE_MS: "1",
		});
		expect(monitorSnapshot.task_counts.pending).toBe(1);
		expect(await Bun.file(path.join(stateDir, "claims", "task-1.json")).exists()).toBe(false);
		expect(await readEvents(stateDir)).toContain("stale_heartbeat");
	});

	it("recovers missing-pane claims and marks the worker lifecycle failed", async () => {
		cleanupRoot = await createGitRepo();
		const fakeTmux = await createFakeTmuxBin(cleanupRoot);
		const snapshot = await startGjcTeam({
			workerCount: 1,
			agentType: "executor",
			task: "Recover missing pane",
			teamName: "missing-pane-team",
			cwd: cleanupRoot,
			env: { PATH: process.env.PATH ?? "", GJC_TEAM_WORKER_COMMAND: "true", GJC_TEAM_TMUX_COMMAND: fakeTmux },
		});
		const stateDir = snapshot.state_dir;
		const claim = await claimGjcTeamTask("missing-pane-team", "worker-1", cleanupRoot, {
			PATH: process.env.PATH ?? "",
			GJC_TEAM_TMUX_COMMAND: fakeTmux,
		});
		expect(claim.ok).toBe(true);
		const config = await readTeamConfig(stateDir);
		await Bun.write(
			path.join(stateDir, "config.json"),
			`${JSON.stringify({ ...config, workers: [{ ...config.workers[0], pane_id: "%9" }] }, null, 2)}\n`,
		);

		const recovered = await monitorGjcTeam("missing-pane-team", cleanupRoot, {
			PATH: process.env.PATH ?? "",
			GJC_TEAM_TMUX_COMMAND: fakeTmux,
		});

		expect(recovered.task_counts.pending).toBe(1);
		expect(recovered.worker_lifecycle_by_id["worker-1"]?.lifecycle_state).toBe("failed");
		expect(recovered.worker_lifecycle_by_id["worker-1"]?.stop_reason).toBe("pane_missing");
		expect(await readEvents(stateDir)).toContain("missing_pane");
	});

	it("enforces typed lane claim eligibility before leases are granted", async () => {
		cleanupRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-team-runtime-"));
		await startGjcTeam({
			workerCount: 2,
			agentType: "executor",
			task: "Route work by lane",
			teamName: "lane-team",
			cwd: cleanupRoot,
			dryRun: true,
			env: { PATH: "" },
		});

		const wrongOwner = await claimGjcTeamTask("lane-team", "worker-1", cleanupRoot, { PATH: "" }, "task-2");
		expect(wrongOwner.ok).toBe(false);
		expect(wrongOwner.reason).toBe("task_owner_mismatch:task-2:worker-2");

		const dependentTask = (await executeGjcTeamApiOperation(
			"create-task",
			{
				team_name: "lane-team",
				subject: "Verify delivery",
				description: "Run verification after implementation",
				owner: "worker-1",
				lane: "verification",
				required_role: "executor",
				depends_on: ["task-1"],
			},
			cleanupRoot,
			{ PATH: "" },
		)) as { task_id: string; status: string; owner?: string; task?: unknown };
		expect(dependentTask).toMatchObject({ task_id: "task-3", status: "pending", owner: "worker-1" });
		expect(dependentTask.task).toBeUndefined();

		const blockedByDependency = await claimGjcTeamTask("lane-team", "worker-1", cleanupRoot, { PATH: "" }, "task-3");
		expect(blockedByDependency.ok).toBe(false);
		expect(blockedByDependency.reason).toBe("task_dependency_incomplete:task-3:task-1");

		await executeGjcTeamApiOperation(
			"create-task",
			{
				team_name: "lane-team",
				subject: "Architecture review",
				description: "Review architecture lane",
				owner: "worker-1",
				lane: "architecture",
				required_role: "architect",
			},
			cleanupRoot,
			{ PATH: "" },
		);
		const wrongRole = await claimGjcTeamTask("lane-team", "worker-1", cleanupRoot, { PATH: "" }, "task-4");
		expect(wrongRole.ok).toBe(false);
		expect(wrongRole.reason).toBe("task_role_mismatch:task-4:architect");

		const implementationClaim = await claimGjcTeamTask("lane-team", "worker-1", cleanupRoot, { PATH: "" }, "task-1");
		expect(implementationClaim.ok).toBe(true);
		await transitionGjcTeamTask(
			"lane-team",
			"task-1",
			"completed",
			cleanupRoot,
			{ PATH: "" },
			implementationClaim.claim_token,
			commandCompletionEvidence("dependency completed"),
		);

		const verificationClaim = await claimGjcTeamTask("lane-team", "worker-1", cleanupRoot, { PATH: "" }, "task-3");
		expect(verificationClaim.ok).toBe(true);
		expect(verificationClaim.task?.lane).toBe("verification");
		expect(verificationClaim.task?.required_role).toBe("executor");
	});
	it("allows only one worker to claim a task under concurrent claim attempts", async () => {
		cleanupRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-team-runtime-"));
		await startGjcTeam({
			workerCount: 2,
			agentType: "executor",
			task: "Claim once",
			teamName: "claim-race-team",
			cwd: cleanupRoot,
			dryRun: true,
			env: { PATH: "" },
		});

		const claims = await Promise.all([
			claimGjcTeamTask("claim-race-team", "worker-1", cleanupRoot, { PATH: "" }, "task-1"),
			claimGjcTeamTask("claim-race-team", "worker-2", cleanupRoot, { PATH: "" }, "task-1"),
		]);

		expect(claims.filter(claim => claim.ok)).toHaveLength(1);
		expect(claims.filter(claim => !claim.ok)).toHaveLength(1);
		expect(claims.find(claim => !claim.ok)?.reason).toMatch(
			/task_already_claimed:task-1|task_not_pending:task-1|task_owner_mismatch:task-1:worker-1/,
		);
		const status = await readGjcTeamSnapshot("claim-race-team", cleanupRoot, { PATH: "" });
		expect(status.task_counts.in_progress).toBe(1);
	});

	it("supports GJC team parity behavioral API operations", async () => {
		cleanupRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-team-runtime-"));
		await startGjcTeam({
			workerCount: 2,
			agentType: "executor",
			task: "API parity",
			teamName: "api-team",
			cwd: cleanupRoot,
			dryRun: true,
			env: { PATH: "" },
		});

		const created = (await executeGjcTeamApiOperation(
			"create-task",
			{ team_name: "api-team", subject: "Extra", description: "Extra work" },
			cleanupRoot,
			{ PATH: "" },
		)) as { task_id: string; task?: unknown };
		expect(created.task).toBeUndefined();
		const read = (await executeGjcTeamApiOperation(
			"read-task",
			{ team_name: "api-team", task_id: created.task_id },
			cleanupRoot,
			{ PATH: "" },
		)) as { task: { subject: string } };
		expect(read.task.subject).toBe("Extra");
		const updated = (await executeGjcTeamApiOperation(
			"update-task",
			{ team_name: "api-team", task_id: created.task_id, subject: "Updated" },
			cleanupRoot,
			{ PATH: "" },
		)) as { task_id: string; task?: unknown };
		expect(updated.task).toBeUndefined();
		const claim = (await executeGjcTeamApiOperation(
			"claim-task",
			{ team_name: "api-team", task_id: created.task_id, worker: "worker-1" },
			cleanupRoot,
			{ PATH: "" },
		)) as { claim_token: string };
		await executeGjcTeamApiOperation(
			"release-task-claim",
			{ team_name: "api-team", task_id: created.task_id, worker: "worker-1", claim_token: claim.claim_token },
			cleanupRoot,
			{ PATH: "" },
		);
		const claimed = (await executeGjcTeamApiOperation(
			"claim-task",
			{ team_name: "api-team", task_id: created.task_id, worker: "worker-1" },
			cleanupRoot,
			{ PATH: "" },
		)) as { claim_token: string };
		await executeGjcTeamApiOperation(
			"transition-task-status",
			{
				team_name: "api-team",
				task_id: created.task_id,
				to: "completed",
				claim_token: claimed.claim_token,
				completionEvidence: artifactCompletionEvidence("API parity task completed by artifact"),
			},
			cleanupRoot,
			{ PATH: "" },
		);

		const message = (await executeGjcTeamApiOperation(
			"send-message",
			{ team_name: "api-team", from_worker: "worker-1", to_worker: "worker-2", body: "hello" },
			cleanupRoot,
			{ PATH: "" },
		)) as { message_id: string; body?: string };
		expect(message.body).toBeUndefined();
		await executeGjcTeamApiOperation(
			"mailbox-mark-delivered",
			{ team_name: "api-team", worker: "worker-2", message_id: message.message_id },
			cleanupRoot,
			{ PATH: "" },
		);
		await executeGjcTeamApiOperation(
			"mailbox-mark-notified",
			{ team_name: "api-team", worker: "worker-2", message_id: message.message_id },
			cleanupRoot,
			{ PATH: "" },
		);
		const mailbox = (await executeGjcTeamApiOperation(
			"mailbox-list",
			{ team_name: "api-team", worker: "worker-2" },
			cleanupRoot,
			{ PATH: "" },
		)) as { messages: Array<{ delivered_at?: string; notified_at?: string }> };
		expect(mailbox.messages[0]?.delivered_at).toBeTruthy();
		expect(mailbox.messages[0]?.notified_at).toBeTruthy();

		await executeGjcTeamApiOperation(
			"write-worker-inbox",
			{ team_name: "api-team", worker: "worker-1", content: "# Inbox" },
			cleanupRoot,
			{ PATH: "" },
		);
		await executeGjcTeamApiOperation(
			"write-worker-identity",
			{ team_name: "api-team", worker: "worker-1", index: 1, role: "executor" },
			cleanupRoot,
			{ PATH: "" },
		);
		await executeGjcTeamApiOperation(
			"update-worker-heartbeat",
			{ team_name: "api-team", worker: "worker-1", pid: 123, turn_count: 2, alive: true },
			cleanupRoot,
			{ PATH: "" },
		);
		const heartbeat = (await executeGjcTeamApiOperation(
			"read-worker-heartbeat",
			{ team_name: "api-team", worker: "worker-1" },
			cleanupRoot,
			{ PATH: "" },
		)) as { pid: number };
		expect(heartbeat.pid).toBe(123);

		await executeGjcTeamApiOperation(
			"append-event",
			{ team_name: "api-team", type: "custom", worker: "worker-1" },
			cleanupRoot,
			{ PATH: "" },
		);
		const awaited = (await executeGjcTeamApiOperation("await-event", { team_name: "api-team" }, cleanupRoot, {
			PATH: "",
		})) as { status: string };
		expect(awaited.status).toBe("event");
		await executeGjcTeamApiOperation(
			"write-monitor-snapshot",
			{ team_name: "api-team", snapshot: { ok: true } },
			cleanupRoot,
			{ PATH: "" },
		);
		const monitor = (await executeGjcTeamApiOperation(
			"read-monitor-snapshot",
			{ team_name: "api-team" },
			cleanupRoot,
			{ PATH: "" },
		)) as { ok: boolean };
		expect(monitor.ok).toBe(true);
		await executeGjcTeamApiOperation(
			"write-task-approval",
			{ team_name: "api-team", task_id: created.task_id, status: "approved", reviewer: "leader" },
			cleanupRoot,
			{ PATH: "" },
		);
		const approval = (await executeGjcTeamApiOperation(
			"read-task-approval",
			{ team_name: "api-team", task_id: created.task_id },
			cleanupRoot,
			{ PATH: "" },
		)) as { status: string };
		expect(approval.status).toBe("approved");
		await executeGjcTeamApiOperation(
			"write-shutdown-request",
			{ team_name: "api-team", worker: "worker-1", requested_by: "leader-fixed" },
			cleanupRoot,
			{ PATH: "" },
		);
	});

	it("stores mailbox messages per recipient and maintains native notification transitions", async () => {
		cleanupRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-team-runtime-"));
		await startGjcTeam({
			workerCount: 2,
			agentType: "executor",
			task: "Notification contract",
			teamName: "notification-team",
			cwd: cleanupRoot,
			dryRun: true,
			env: { PATH: "" },
		});

		const first = (await executeGjcTeamApiOperation(
			"send-message",
			{
				team_name: "notification-team",
				from_worker: "worker-1",
				to_worker: "worker-2",
				body: "hello stable delivery",
				idempotency_key: "stable-key",
			},
			cleanupRoot,
			{ PATH: "" },
		)) as { message_id: string; body?: string };
		const second = (await executeGjcTeamApiOperation(
			"send-message",
			{
				team_name: "notification-team",
				from_worker: "worker-1",
				to_worker: "worker-2",
				body: "hello stable delivery",
				idempotency_key: "stable-key",
			},
			cleanupRoot,
			{ PATH: "" },
		)) as { message_id: string; body?: string };
		expect(first.body).toBeUndefined();
		expect(second.body).toBeUndefined();
		expect(second.message_id).toBe(first.message_id);
		expect(
			await Bun.file(
				path.join(
					cleanupRoot,
					".gjc",
					"state",
					"team",
					"notification-team",
					"mailbox",
					"worker-2",
					`${first.message_id}.json`,
				),
			).exists(),
		).toBe(true);

		let notifications = (await executeGjcTeamApiOperation(
			"notification-list",
			{ team_name: "notification-team" },
			cleanupRoot,
			{ PATH: "" },
		)) as {
			notification_ids: string[];
			delivery_states: string[];
			summary: { total: number };
		};
		expect(notifications.summary.total).toBe(1);
		expect(notifications.delivery_states[0]).toBe("sent");

		await executeGjcTeamApiOperation(
			"mailbox-mark-notified",
			{ team_name: "notification-team", worker: "worker-2", message_id: first.message_id },
			cleanupRoot,
			{ PATH: "" },
		);
		notifications = (await executeGjcTeamApiOperation(
			"notification-list",
			{ team_name: "notification-team" },
			cleanupRoot,
			{ PATH: "" },
		)) as { notification_ids: string[]; delivery_states: string[]; summary: { total: number } };
		expect(notifications.delivery_states[0]).toBe("delivered");

		await executeGjcTeamApiOperation(
			"mailbox-mark-delivered",
			{ team_name: "notification-team", worker: "worker-2", message_id: first.message_id },
			cleanupRoot,
			{ PATH: "" },
		);
		notifications = (await executeGjcTeamApiOperation(
			"notification-list",
			{ team_name: "notification-team" },
			cleanupRoot,
			{ PATH: "" },
		)) as { notification_ids: string[]; delivery_states: string[]; summary: { total: number } };
		expect(notifications.delivery_states[0]).toBe("acknowledged");
	});

	it("rejects path-like worker ids and reports lifecycle nudges without automatic worker action", async () => {
		cleanupRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-team-runtime-"));
		await startGjcTeam({
			workerCount: 1,
			agentType: "executor",
			task: "Guard invalid workers",
			teamName: "guard-team",
			cwd: cleanupRoot,
			dryRun: true,
			env: { PATH: "" },
		});

		await expect(
			executeGjcTeamApiOperation(
				"send-message",
				{ team_name: "guard-team", from_worker: "worker-1", to_worker: "../bad", body: "bad" },
				cleanupRoot,
				{ PATH: "" },
			),
		).rejects.toThrow(/invalid_worker_id/);
		await expect(
			executeGjcTeamApiOperation(
				"update-worker-heartbeat",
				{ team_name: "guard-team", worker: "../escaped", pid: 9, alive: true },
				cleanupRoot,
				{ PATH: "" },
			),
		).rejects.toThrow(/invalid_worker_id/);
		expect(
			await Bun.file(
				path.join(cleanupRoot, ".gjc", "state", "team", "guard-team", "escaped", "heartbeat.json"),
			).exists(),
		).toBe(false);

		const monitored = await monitorGjcTeam("guard-team", cleanupRoot, {
			PATH: "",
			GJC_TEAM_STARTUP_GRACE_MS: "0",
			GJC_TEAM_HEARTBEAT_STALE_MS: "0",
			GJC_TEAM_NUDGE_COOLDOWN_MS: "60000",
		});
		expect(monitored.workers[0]?.status).toBe("idle");
		const nudgeDir = path.join(cleanupRoot, ".gjc", "state", "team", "guard-team", "workers", "worker-1", "nudges");
		const nudges = await fs.readdir(nudgeDir);
		expect(nudges.length).toBeGreaterThan(0);
		const events = await readEvents(path.join(cleanupRoot, ".gjc", "state", "team", "guard-team"));
		expect(events).toContain("worker_lifecycle_nudge");
		expect(events).toContain("auto_action_taken");
	});

	it("monitor integrates dirty detached worker worktrees and records GJC-scoped hygiene artifacts", async () => {
		cleanupRoot = await createGitRepo();
		const fakeTmux = await createFakeTmuxBin(cleanupRoot);
		const snapshot = await startGjcTeam({
			workerCount: 1,
			agentType: "executor",
			task: "Integrate dirty worker",
			teamName: "integrate-dirty-team",
			cwd: cleanupRoot,
			env: { PATH: process.env.PATH ?? "", GJC_TEAM_WORKER_COMMAND: "true", GJC_TEAM_TMUX_COMMAND: fakeTmux },
		});
		const config = await readTeamConfig(snapshot.state_dir);
		const worker = config.workers[0];
		if (!worker?.worktree_path) throw new Error("missing worker worktree");
		await Bun.write(path.join(worker.worktree_path, "worker-output.txt"), "from worker\n");

		const monitored = await monitorGjcTeam("integrate-dirty-team", cleanupRoot, {
			PATH: process.env.PATH ?? "",
			GJC_TEAM_TMUX_COMMAND: fakeTmux,
		});

		expect(await Bun.file(path.join(cleanupRoot, "worker-output.txt")).text()).toBe("from worker\n");
		const workerState = monitored.integration_by_worker?.["worker-1"];
		expect(workerState?.status).toBe("idle");
		expect(workerState?.last_integrated_head).toBeTruthy();
		const events = await readEvents(snapshot.state_dir);
		expect(events).toContain("worker_auto_commit");
		expect(events).toContain("worker_merge_applied");
		const leaderMailbox = await readMailbox(snapshot.state_dir, "leader-fixed");
		expect(leaderMailbox).toContain("INTEGRATED: merged worker-1");
		const ledger = await Bun.file(
			path.join(cleanupRoot, ".gjc", "reports", "team-commit-hygiene", "integrate-dirty-team.ledger.json"),
		).json();
		expect(JSON.stringify(ledger)).toContain("auto_checkpoint");
		expect(JSON.stringify(ledger)).toContain("integration_merge");
		expect(await Bun.file(path.join(cleanupRoot, ".omx", "reports", "team-commit-hygiene")).exists()).toBe(false);
	});

	it("checkpoint classification excludes GJC runtime paths from worker auto-commits", async () => {
		expect(
			classifyGjcTeamCheckpointFiles([
				"src/feature.ts",
				".gjc/state/team/demo/worker.json",
				".gjc/reports/team-commit-hygiene/demo.ledger.json",
			]),
		).toEqual({
			eligible: ["src/feature.ts"],
			protected: [".gjc/state/team/demo/worker.json", ".gjc/reports/team-commit-hygiene/demo.ledger.json"],
		});

		cleanupRoot = await createGitRepo();
		const fakeTmux = await createFakeTmuxBin(cleanupRoot);
		const snapshot = await startGjcTeam({
			workerCount: 1,
			agentType: "executor",
			task: "Classify protected worker files",
			teamName: "protected-checkpoint-team",
			cwd: cleanupRoot,
			env: { PATH: process.env.PATH ?? "", GJC_TEAM_WORKER_COMMAND: "true", GJC_TEAM_TMUX_COMMAND: fakeTmux },
		});
		const config = await readTeamConfig(snapshot.state_dir);
		const worker = config.workers[0];
		if (!worker?.worktree_path) throw new Error("missing worker worktree");
		await Bun.write(path.join(worker.worktree_path, "semantic.txt"), "semantic\n");
		await Bun.write(path.join(worker.worktree_path, ".gjc", "state", "team", "runtime.json"), "{}\n");

		await monitorGjcTeam("protected-checkpoint-team", cleanupRoot, {
			PATH: process.env.PATH ?? "",
			GJC_TEAM_TMUX_COMMAND: fakeTmux,
		});

		expect(await Bun.file(path.join(cleanupRoot, "semantic.txt")).text()).toBe("semantic\n");
		expect(await Bun.file(path.join(cleanupRoot, ".gjc", "state", "team", "runtime.json")).exists()).toBe(false);
	});

	it("worker turn-end integration requests notify the leader once per fingerprint", async () => {
		cleanupRoot = await createGitRepo();
		const fakeTmux = await createFakeTmuxBin(cleanupRoot);
		const snapshot = await startGjcTeam({
			workerCount: 1,
			agentType: "executor",
			task: "Request integration",
			teamName: "turn-end-request-team",
			cwd: cleanupRoot,
			env: { PATH: process.env.PATH ?? "", GJC_TEAM_WORKER_COMMAND: "true", GJC_TEAM_TMUX_COMMAND: fakeTmux },
		});
		const config = await readTeamConfig(snapshot.state_dir);
		const worker = config.workers[0];
		if (!worker?.worktree_path) throw new Error("missing worker worktree");
		await Bun.write(path.join(worker.worktree_path, "turn-end-output.txt"), "pending\n");
		const env = {
			PATH: process.env.PATH ?? "",
			GJC_TEAM_NAME: "turn-end-request-team",
			GJC_TEAM_WORKER_ID: "worker-1",
			GJC_TEAM_STATE_ROOT: config.state_root,
			GJC_TEAM_WORKTREE_PATH: worker.worktree_path,
		};

		const first = await requestGjcWorkerIntegrationAttempt(worker.worktree_path, env);
		const second = await requestGjcWorkerIntegrationAttempt(worker.worktree_path, env);

		expect(first.requested).toBe(true);
		expect(first.reason).toBe("requested");
		expect(second.requested).toBe(false);
		expect(second.reason).toBe("deduped");
		expect(await readEvents(snapshot.state_dir)).toContain("worker_integration_attempt_requested");
		expect(await readMailbox(snapshot.state_dir, "leader-fixed")).toContain("INTEGRATION REQUESTED: worker-1");
		const ledger = await Bun.file(
			path.join(cleanupRoot, ".gjc", "reports", "team-commit-hygiene", "turn-end-request-team.ledger.json"),
		).json();
		expect(JSON.stringify(ledger)).toContain("leader_integration_attempt");
	});

	it("reports awaiting integration when all worker tasks completed after an integration request", async () => {
		cleanupRoot = await createGitRepo();
		const fakeTmux = await createFakeTmuxBin(cleanupRoot);
		const snapshot = await startGjcTeam({
			workerCount: 1,
			agentType: "executor",
			task: "Complete then integrate",
			teamName: "awaiting-request-team",
			cwd: cleanupRoot,
			env: { PATH: process.env.PATH ?? "", GJC_TEAM_WORKER_COMMAND: "true", GJC_TEAM_TMUX_COMMAND: fakeTmux },
		});
		const config = await readTeamConfig(snapshot.state_dir);
		const worker = config.workers[0];
		if (!worker?.worktree_path) throw new Error("missing worker worktree");
		await Bun.write(path.join(worker.worktree_path, "requested-output.txt"), "pending integration\n");
		const requestEnv = {
			PATH: process.env.PATH ?? "",
			GJC_TEAM_NAME: "awaiting-request-team",
			GJC_TEAM_WORKER_ID: "worker-1",
			GJC_TEAM_STATE_ROOT: config.state_root,
			GJC_TEAM_WORKTREE_PATH: worker.worktree_path,
		};
		const requested = await requestGjcWorkerIntegrationAttempt(worker.worktree_path, requestEnv);
		expect(requested.requested).toBe(true);

		const claim = await claimGjcTeamTask("awaiting-request-team", "worker-1", cleanupRoot, {
			PATH: process.env.PATH ?? "",
		});
		await transitionGjcTeamTask(
			"awaiting-request-team",
			"task-1",
			"completed",
			cleanupRoot,
			{
				PATH: process.env.PATH ?? "",
			},
			claim.claim_token,
			commandCompletionEvidence("integration request task completed"),
		);

		const status = await readGjcTeamSnapshot("awaiting-request-team", cleanupRoot, { PATH: process.env.PATH ?? "" });
		expect(status.task_counts.completed).toBe(1);
		expect(status.phase).toBe("awaiting_integration");
		expect(status.phase).not.toBe("running");

		const stopped = await shutdownGjcTeam("awaiting-request-team", cleanupRoot, { PATH: process.env.PATH ?? "" });
		expect(stopped.task_counts.completed).toBe(1);
		expect(stopped.phase).toBe("awaiting_integration");
		expect(stopped.phase).not.toBe("complete");
	});

	it("monitor cherry-picks diverged worker commits and stays idempotent on repeated status checks", async () => {
		cleanupRoot = await createGitRepo();
		const fakeTmux = await createFakeTmuxBin(cleanupRoot);
		const snapshot = await startGjcTeam({
			workerCount: 1,
			agentType: "executor",
			task: "Integrate diverged worker",
			teamName: "diverged-team",
			cwd: cleanupRoot,
			env: { PATH: process.env.PATH ?? "", GJC_TEAM_WORKER_COMMAND: "true", GJC_TEAM_TMUX_COMMAND: fakeTmux },
		});
		const config = await readTeamConfig(snapshot.state_dir);
		const workerPath = config.workers[0]?.worktree_path;
		if (!workerPath) throw new Error("missing worker worktree");
		await commitFile(cleanupRoot, "leader.txt", "leader\n", "leader advances");
		const workerHead = await commitFile(workerPath, "worker.txt", "worker\n", "worker diverges");

		const first = await monitorGjcTeam("diverged-team", cleanupRoot, {
			PATH: process.env.PATH ?? "",
			GJC_TEAM_TMUX_COMMAND: fakeTmux,
		});
		const leaderAfterFirst = runGit(cleanupRoot, ["rev-parse", "HEAD"]);
		const second = await monitorGjcTeam("diverged-team", cleanupRoot, {
			PATH: process.env.PATH ?? "",
			GJC_TEAM_TMUX_COMMAND: fakeTmux,
		});

		expect(await Bun.file(path.join(cleanupRoot, "worker.txt")).text()).toBe("worker\n");
		expect(first.integration_by_worker?.["worker-1"]?.last_integrated_head).toBe(workerHead);
		expect(second.integration_by_worker?.["worker-1"]?.last_integrated_head).toBeTruthy();
		expect(runGit(cleanupRoot, ["rev-parse", "HEAD"])).toBe(leaderAfterFirst);
		const events = await readEvents(snapshot.state_dir);
		expect(events).toContain("worker_cherry_pick_applied");
		const ledger = await Bun.file(
			path.join(cleanupRoot, ".gjc", "reports", "team-commit-hygiene", "diverged-team.ledger.json"),
		).json();
		expect(JSON.stringify(ledger)).toContain("integration_cherry_pick");
	});

	it("monitor reports merge conflicts without falsely advancing last integrated head", async () => {
		cleanupRoot = await createGitRepo();
		const fakeTmux = await createFakeTmuxBin(cleanupRoot);
		const snapshot = await startGjcTeam({
			workerCount: 1,
			agentType: "executor",
			task: "Conflict worker",
			teamName: "merge-conflict-team",
			worktreeMode: { enabled: true, detached: false, name: "feature/conflict" },
			cwd: cleanupRoot,
			env: { PATH: process.env.PATH ?? "", GJC_TEAM_WORKER_COMMAND: "true", GJC_TEAM_TMUX_COMMAND: fakeTmux },
		});
		const config = await readTeamConfig(snapshot.state_dir);
		const workerPath = config.workers[0]?.worktree_path;
		if (!workerPath) throw new Error("missing worker worktree");
		await commitFile(workerPath, "README.md", "# worker\n", "worker readme");
		await Bun.write(path.join(cleanupRoot, "README.md"), "# leader dirty\n");

		const monitored = await monitorGjcTeam("merge-conflict-team", cleanupRoot, {
			PATH: process.env.PATH ?? "",
			GJC_TEAM_TMUX_COMMAND: fakeTmux,
		});

		const workerState = monitored.integration_by_worker?.["worker-1"];
		expect(workerState?.status).toBe("merge_conflict");
		expect(workerState?.last_integrated_head).toBeUndefined();
		expect(runGit(cleanupRoot, ["status", "--porcelain", "--untracked-files=no"])).toBe("M README.md");
		expect(await readEvents(snapshot.state_dir)).toContain("worker_merge_conflict");
		expect(await Bun.file(path.join(snapshot.state_dir, "integration-report.md")).text()).toContain("merge");
		expect(await readMailbox(snapshot.state_dir, "leader-fixed")).toContain("CONFLICT: merge failed");
		expect(await readMailbox(snapshot.state_dir, "worker-1")).toContain("Manual resolution required");
		const ledger = await Bun.file(
			path.join(cleanupRoot, ".gjc", "reports", "team-commit-hygiene", "merge-conflict-team.ledger.json"),
		).json();
		expect(JSON.stringify(ledger)).toContain('"status":"conflict"');
		expect(JSON.stringify(ledger)).toContain("integration_merge");
	});

	it("keeps completed conflicting teams in awaiting integration instead of plain running", async () => {
		cleanupRoot = await createGitRepo();
		const fakeTmux = await createFakeTmuxBin(cleanupRoot);
		const snapshot = await startGjcTeam({
			workerCount: 1,
			agentType: "executor",
			task: "Conflict after completion",
			teamName: "awaiting-conflict-team",
			worktreeMode: { enabled: true, detached: false, name: "feature/awaiting-conflict" },
			cwd: cleanupRoot,
			env: { PATH: process.env.PATH ?? "", GJC_TEAM_WORKER_COMMAND: "true", GJC_TEAM_TMUX_COMMAND: fakeTmux },
		});
		const config = await readTeamConfig(snapshot.state_dir);
		const workerPath = config.workers[0]?.worktree_path;
		if (!workerPath) throw new Error("missing worker worktree");
		await commitFile(workerPath, "README.md", "# worker\n", "worker readme");
		await Bun.write(path.join(cleanupRoot, "README.md"), "# leader dirty\n");
		const claim = await claimGjcTeamTask("awaiting-conflict-team", "worker-1", cleanupRoot, {
			PATH: process.env.PATH ?? "",
		});
		await transitionGjcTeamTask(
			"awaiting-conflict-team",
			"task-1",
			"completed",
			cleanupRoot,
			{
				PATH: process.env.PATH ?? "",
			},
			claim.claim_token,
			commandCompletionEvidence("conflicting task completed before integration"),
		);

		const monitored = await monitorGjcTeam("awaiting-conflict-team", cleanupRoot, {
			PATH: process.env.PATH ?? "",
			GJC_TEAM_TMUX_COMMAND: fakeTmux,
		});

		expect(monitored.task_counts.completed).toBe(1);
		expect(monitored.integration_by_worker?.["worker-1"]?.status).toBe("merge_conflict");
		expect(monitored.phase).toBe("awaiting_integration");
		expect(monitored.phase).not.toBe("running");

		const stopped = await shutdownGjcTeam("awaiting-conflict-team", cleanupRoot, { PATH: process.env.PATH ?? "" });
		expect(stopped.task_counts.completed).toBe(1);
		expect(stopped.phase).toBe("awaiting_integration");
		expect(stopped.phase).not.toBe("complete");
	});

	it("monitor reports cherry-pick conflicts and aborts cleanly", async () => {
		cleanupRoot = await createGitRepo();
		const fakeTmux = await createFakeTmuxBin(cleanupRoot);
		const snapshot = await startGjcTeam({
			workerCount: 1,
			agentType: "executor",
			task: "Cherry pick conflict worker",
			teamName: "pick-conflict-team",
			cwd: cleanupRoot,
			env: { PATH: process.env.PATH ?? "", GJC_TEAM_WORKER_COMMAND: "true", GJC_TEAM_TMUX_COMMAND: fakeTmux },
		});
		const config = await readTeamConfig(snapshot.state_dir);
		const workerPath = config.workers[0]?.worktree_path;
		if (!workerPath) throw new Error("missing worker worktree");
		await commitFile(workerPath, "README.md", "# worker\n", "worker readme");
		await fs.rm(path.join(cleanupRoot, "README.md"));
		runGit(cleanupRoot, ["add", "README.md"]);
		runGit(cleanupRoot, ["commit", "-m", "leader deletes readme"]);

		const monitored = await monitorGjcTeam("pick-conflict-team", cleanupRoot, {
			PATH: process.env.PATH ?? "",
			GJC_TEAM_TMUX_COMMAND: fakeTmux,
		});

		const workerState = monitored.integration_by_worker?.["worker-1"];
		expect(workerState?.status).toBe("cherry_pick_conflict");
		expect(workerState?.last_integrated_head).toBeUndefined();
		expect(runGit(cleanupRoot, ["status", "--porcelain", "--untracked-files=no"])).toBe("");
		expect(await readEvents(snapshot.state_dir)).toContain("worker_cherry_pick_conflict");
		expect(await Bun.file(path.join(snapshot.state_dir, "integration-report.md")).text()).toContain("cherry-pick");
		expect(await readMailbox(snapshot.state_dir, "leader-fixed")).toContain("CONFLICT: cherry-pick failed");
		expect(await readMailbox(snapshot.state_dir, "worker-1")).toContain("Manual resolution required");
		const ledger = await Bun.file(
			path.join(cleanupRoot, ".gjc", "reports", "team-commit-hygiene", "pick-conflict-team.ledger.json"),
		).json();
		expect(JSON.stringify(ledger)).toContain('"status":"conflict"');
		expect(JSON.stringify(ledger)).toContain("integration_cherry_pick");
	});

	it("cross-rebases idle, done, and failed workers while skipping working workers", async () => {
		cleanupRoot = await createGitRepo();
		const fakeTmux = await createFakeTmuxBin(cleanupRoot);
		const snapshot = await startGjcTeam({
			workerCount: 4,
			agentType: "executor",
			task: "Cross rebase workers",
			teamName: "cross-rebase-team",
			cwd: cleanupRoot,
			env: { PATH: process.env.PATH ?? "", GJC_TEAM_WORKER_COMMAND: "true", GJC_TEAM_TMUX_COMMAND: fakeTmux },
		});
		await writeWorkerStatus(snapshot.state_dir, "worker-1", "idle");
		await writeWorkerStatus(snapshot.state_dir, "worker-2", "done");
		await writeWorkerStatus(snapshot.state_dir, "worker-3", "failed");
		await writeWorkerStatus(snapshot.state_dir, "worker-4", "working");
		await Bun.write(path.join(snapshot.workers[0]?.worktree_path ?? "", "worker-output.txt"), "integrate\n");

		const monitored = await monitorGjcTeam("cross-rebase-team", cleanupRoot, {
			PATH: process.env.PATH ?? "",
			GJC_TEAM_TMUX_COMMAND: fakeTmux,
		});
		const leaderHead = runGit(cleanupRoot, ["rev-parse", "HEAD"]);

		expect(monitored.integration_by_worker?.["worker-1"]?.last_rebased_leader_head).toBe(leaderHead);
		expect(monitored.integration_by_worker?.["worker-2"]?.last_rebased_leader_head).toBe(leaderHead);
		expect(monitored.integration_by_worker?.["worker-3"]?.last_rebased_leader_head).toBe(leaderHead);
		expect(monitored.integration_by_worker?.["worker-4"]?.last_rebased_leader_head).toBeUndefined();
		const events = await readEvents(snapshot.state_dir);
		expect(events).toContain("worker_cross_rebase_applied");
		expect(events).toContain("worker_cross_rebase_skipped");
		const ledger = await Bun.file(
			path.join(cleanupRoot, ".gjc", "reports", "team-commit-hygiene", "cross-rebase-team.ledger.json"),
		).json();
		expect(JSON.stringify(ledger)).toContain("cross_rebase");
	});

	it("pure team reads, status, and list operations stay read-only while monitor and resume can mutate", async () => {
		cleanupRoot = await createGitRepo();
		const fakeTmux = await createFakeTmuxBin(cleanupRoot);
		const snapshot = await startGjcTeam({
			workerCount: 1,
			agentType: "executor",
			task: "Pure reads stay pure",
			teamName: "pure-read-team",
			cwd: cleanupRoot,
			env: { PATH: process.env.PATH ?? "", GJC_TEAM_WORKER_COMMAND: "true", GJC_TEAM_TMUX_COMMAND: fakeTmux },
		});
		const config = await readTeamConfig(snapshot.state_dir);
		const workerPath = config.workers[0]?.worktree_path;
		if (!workerPath) throw new Error("missing worker worktree");
		await Bun.write(path.join(workerPath, "unintegrated.txt"), "pending\n");

		const listed = await listGjcTeams(cleanupRoot, { PATH: process.env.PATH ?? "" });
		const read = await readGjcTeamSnapshot("pure-read-team", cleanupRoot, { PATH: process.env.PATH ?? "" });

		expect(listed).toHaveLength(1);
		expect(read.integration_by_worker).toBeUndefined();
		expect(await Bun.file(path.join(cleanupRoot, "unintegrated.txt")).exists()).toBe(false);
		expect(await Bun.file(path.join(snapshot.state_dir, "monitor-snapshot.json")).exists()).toBe(false);
		const commandSource = await Bun.file(path.join(import.meta.dir, "../../src/commands/team.ts")).text();
		expect(commandSource).toContain('action === "status"');
		expect(commandSource).toContain("readGjcTeamSnapshot(teamName)");
		expect(commandSource).toContain('action === "monitor" || action === "resume"');
		expect(commandSource).toContain("monitorGjcTeamSnapshot(teamName)");
		expect(commandSource).toContain("listGjcTeams()");
		expect(commandSource).toContain("formatTaskCounts(snapshot.task_counts)");
		expect(commandSource).toContain("renderTeamStatusMarkdown(snapshot)");

		const runtimeSource = await Bun.file(path.join(import.meta.dir, "../../src/gjc-runtime/team-runtime.ts")).text();
		for (const disallowedGitStrategy of ['"-X"', '"--strategy-option"', "-X theirs", "-X ours"]) {
			expect(runtimeSource).not.toContain(disallowedGitStrategy);
		}
	});
});
