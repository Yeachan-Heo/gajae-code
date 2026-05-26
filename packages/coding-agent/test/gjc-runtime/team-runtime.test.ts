import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	claimGjcTeamTask,
	listGjcTeams,
	readGjcTeamSnapshot,
	resolveGjcWorkerCommand,
	shutdownGjcTeam,
	startGjcTeam,
	transitionGjcTeamTask,
} from "../../src/gjc-runtime/team-runtime";

let cleanupRoot: string | undefined;

afterEach(async () => {
	if (cleanupRoot) {
		await fs.rm(cleanupRoot, { recursive: true, force: true });
		cleanupRoot = undefined;
	}
});

describe("native gjc team runtime", () => {
	it("creates GJC-scoped team state, task mailboxes, and telemetry without delegating to omx", async () => {
		cleanupRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-team-runtime-"));
		const snapshot = await startGjcTeam({
			workerCount: 2,
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
		expect(snapshot.workers).toHaveLength(2);

		const telemetry = await Bun.file(path.join(snapshot.state_dir, "telemetry.jsonl")).text();
		expect(telemetry).toContain("Native gjc team runtime initialized");
		await expect(
			Bun.file(path.join(cleanupRoot, ".omx", "state", "team", "demo-team", "config.json")).exists(),
		).resolves.toBe(false);
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

		const claim = await claimGjcTeamTask("life-team", "worker-01", cleanupRoot, { PATH: "" });
		expect(claim.ok).toBe(true);
		expect(claim.task?.status).toBe("in_progress");
		const task = await transitionGjcTeamTask("life-team", "task-001", "complete", cleanupRoot, { PATH: "" });
		expect(task.status).toBe("complete");

		const status = await readGjcTeamSnapshot("life-team", cleanupRoot, { PATH: "" });
		expect(status.task_counts.complete).toBe(1);
		expect(await listGjcTeams(cleanupRoot, { PATH: "" })).toHaveLength(1);

		const stopped = await shutdownGjcTeam("life-team", cleanupRoot, { PATH: "" });
		expect(stopped.phase).toBe("complete");
		expect(stopped.workers[0]?.status).toBe("stopped");
	});
});
