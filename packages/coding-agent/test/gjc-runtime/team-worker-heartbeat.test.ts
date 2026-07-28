import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { teamStateRoot } from "../../src/gjc-runtime/session-layout";
import {
	buildWorkerCommand,
	type GjcTeamConfig,
	parseHeartbeatStaleMs,
	startGjcTeam,
	type WorkerHeartbeatFile,
} from "../../src/gjc-runtime/team-runtime";
import {
	GjcTeamWorkerHeartbeatReporter,
	resolveGjcTeamWorkerHeartbeatIntervalMs,
	resolveGjcTeamWorkerIdentity,
	writeGjcTeamWorkerRuntimeHeartbeat,
} from "../../src/gjc-runtime/team-worker-heartbeat";

const TEST_SESSION_ID = "test-session";
let cleanupRoot: string | undefined;
let previousGjcSessionId: string | undefined;

const teamStateDir = (root: string, teamName: string) => path.join(teamStateRoot(root, TEST_SESSION_ID), teamName);
const heartbeatFile = (root: string, teamName: string, worker: string) =>
	path.join(teamStateDir(root, teamName), "workers", worker, "heartbeat.json");

beforeAll(() => {
	previousGjcSessionId = process.env.GJC_SESSION_ID;
	process.env.GJC_SESSION_ID = TEST_SESSION_ID;
});

afterAll(() => {
	if (previousGjcSessionId === undefined) delete process.env.GJC_SESSION_ID;
	else process.env.GJC_SESSION_ID = previousGjcSessionId;
});

afterEach(async () => {
	if (cleanupRoot) await fs.rm(cleanupRoot, { recursive: true, force: true });
	cleanupRoot = undefined;
});

async function startDryRunTeam(teamName: string): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-team-heartbeat-"));
	cleanupRoot = root;
	await startGjcTeam({
		workerCount: 1,
		agentType: "executor",
		task: `Runtime heartbeat ${teamName}`,
		teamName,
		cwd: root,
		dryRun: true,
		env: { GJC_SESSION_ID: TEST_SESSION_ID, PATH: "" },
	});
	return root;
}

async function writeHeartbeat(root: string, teamName: string, heartbeat: WorkerHeartbeatFile): Promise<void> {
	await Bun.write(heartbeatFile(root, teamName, "worker-1"), `${JSON.stringify(heartbeat, null, 2)}\n`);
}

async function readHeartbeat(root: string, teamName: string): Promise<WorkerHeartbeatFile> {
	return (await Bun.file(heartbeatFile(root, teamName, "worker-1")).json()) as WorkerHeartbeatFile;
}

async function until(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error("condition not reached before timeout");
		await Bun.sleep(1);
	}
}

describe("team worker identity and heartbeat cadence", () => {
	it("resolves worker identity only when both team and worker are known", () => {
		expect(resolveGjcTeamWorkerIdentity({})).toBeUndefined();
		expect(resolveGjcTeamWorkerIdentity({ GJC_TEAM_NAME: "alpha" })).toBeUndefined();
		expect(resolveGjcTeamWorkerIdentity({ GJC_TEAM_WORKER_ID: "worker-2" })).toBeUndefined();
		expect(resolveGjcTeamWorkerIdentity({ GJC_TEAM_NAME: "alpha", GJC_TEAM_WORKER_ID: "worker-2" })).toEqual({
			teamName: "alpha",
			workerId: "worker-2",
		});
		expect(
			resolveGjcTeamWorkerIdentity({ GJC_TEAM_NAME: "alpha", GJC_TEAM_INTERNAL_WORKER: "alpha/worker-3" }),
		).toEqual({ teamName: "alpha", workerId: "worker-3" });
	});

	it("publishes several times per stale window and stays inside the clamp", () => {
		// Default 120s stale window: the 40s third would exceed the 30s ceiling.
		expect(resolveGjcTeamWorkerHeartbeatIntervalMs({})).toBe(30_000);
		expect(resolveGjcTeamWorkerHeartbeatIntervalMs({ GJC_TEAM_HEARTBEAT_STALE_MS: "30000" })).toBe(10_000);
		expect(resolveGjcTeamWorkerHeartbeatIntervalMs({ GJC_TEAM_HEARTBEAT_STALE_MS: "1500" })).toBe(500);
		expect(resolveGjcTeamWorkerHeartbeatIntervalMs({ GJC_TEAM_HEARTBEAT_STALE_MS: "500" })).toBe(166);
		// The leader and reporter both clamp pathological positive windows to 3ms,
		// leaving a 1ms publish cadence strictly below the effective threshold.
		expect(parseHeartbeatStaleMs({ GJC_TEAM_HEARTBEAT_STALE_MS: "1" })).toBe(3);
		expect(resolveGjcTeamWorkerHeartbeatIntervalMs({ GJC_TEAM_HEARTBEAT_STALE_MS: "1" })).toBe(1);
		expect(resolveGjcTeamWorkerHeartbeatIntervalMs({ GJC_TEAM_HEARTBEAT_STALE_MS: "not-a-number" })).toBe(30_000);
	});

	it("disables publishing when the leader disabled the stale window", () => {
		expect(resolveGjcTeamWorkerHeartbeatIntervalMs({ GJC_TEAM_HEARTBEAT_STALE_MS: "0" })).toBe(0);
		expect(resolveGjcTeamWorkerHeartbeatIntervalMs({ GJC_TEAM_HEARTBEAT_STALE_MS: "-5" })).toBe(0);
		expect(
			GjcTeamWorkerHeartbeatReporter.forProcess(() => ".", {
				GJC_TEAM_NAME: "alpha",
				GJC_TEAM_WORKER_ID: "worker-1",
				GJC_TEAM_HEARTBEAT_STALE_MS: "0",
			}),
		).toBeUndefined();
	});

	it("creates no reporter outside a team worker pane", () => {
		expect(GjcTeamWorkerHeartbeatReporter.forProcess(() => ".", { PATH: "" })).toBeUndefined();
	});
});

describe("GjcTeamWorkerHeartbeatReporter", () => {
	it("publishes on start, on each tick, and once more on stop", async () => {
		let writes = 0;
		const reporter = new GjcTeamWorkerHeartbeatReporter({
			intervalMs: 5,
			write: async () => {
				writes++;
			},
		});

		reporter.start();
		expect(reporter.isRunning).toBe(true);
		await until(() => writes >= 3);
		const duringTurn = writes;
		reporter.stop();
		await reporter.flush();

		expect(reporter.isRunning).toBe(false);
		expect(writes).toBe(duringTurn + 1);
		await Bun.sleep(20);
		expect(writes).toBe(duringTurn + 1);
	});

	it("never overlaps writes: a tick during a slow write is dropped, not queued", async () => {
		let started = 0;
		const gate = Promise.withResolvers<void>();
		const reporter = new GjcTeamWorkerHeartbeatReporter({
			intervalMs: 1,
			write: async () => {
				started++;
				await gate.promise;
			},
		});

		reporter.start();
		await Bun.sleep(25);
		expect(started).toBe(1);

		gate.resolve();
		await reporter.flush();
		reporter.dispose();
	});

	it("stops publishing permanently after dispose", async () => {
		let writes = 0;
		const reporter = new GjcTeamWorkerHeartbeatReporter({
			intervalMs: 1,
			write: async () => {
				writes++;
			},
		});

		reporter.start();
		await until(() => writes >= 1);
		reporter.dispose();
		await reporter.flush();
		const afterDispose = writes;

		reporter.start();
		await Bun.sleep(15);
		expect(reporter.isRunning).toBe(false);
		expect(writes).toBe(afterDispose);
	});

	it("keeps publishing after a failed write", async () => {
		let attempts = 0;
		const reporter = new GjcTeamWorkerHeartbeatReporter({
			intervalMs: 1,
			write: async () => {
				attempts++;
				throw new Error("heartbeat write failed");
			},
		});

		reporter.start();
		await until(() => attempts >= 3);
		reporter.dispose();
		await reporter.flush();
		expect(attempts).toBeGreaterThanOrEqual(3);
	});
});

describe("runtime-owned heartbeat records", () => {
	it("publishes the writer's real pid and process incarnation and carries turn_count over", async () => {
		const root = await startDryRunTeam("runtime-heartbeat-team");
		const env = {
			PATH: "",
			GJC_SESSION_ID: TEST_SESSION_ID,
			GJC_TEAM_NAME: "runtime-heartbeat-team",
			GJC_TEAM_WORKER_ID: "worker-1",
		};
		await writeHeartbeat(root, "runtime-heartbeat-team", {
			pid: process.pid,
			last_turn_at: new Date(Date.now() - 90_000).toISOString(),
			turn_count: 7,
			alive: true,
			process_start_time: "existing-incarnation",
		});

		const before = Date.now();
		const written = await writeGjcTeamWorkerRuntimeHeartbeat(root, env);
		const persisted = await readHeartbeat(root, "runtime-heartbeat-team");

		expect(written).toEqual(persisted);
		expect(persisted.pid).toBe(process.pid);
		expect(persisted.alive).toBe(true);
		// The model owns turn counting; the runtime writer must not inflate it.
		expect(persisted.turn_count).toBe(7);
		expect(persisted.process_start_time).toBeTruthy();
		expect(Date.parse(persisted.last_turn_at)).toBeGreaterThanOrEqual(before);
	});

	it("is a no-op outside a team worker pane", async () => {
		const root = await startDryRunTeam("non-worker-team");
		expect(
			await writeGjcTeamWorkerRuntimeHeartbeat(root, { PATH: "", GJC_SESSION_ID: TEST_SESSION_ID }),
		).toBeUndefined();
	});
});

describe("gjc team launch to reporter contract", () => {
	it("exports exactly the worker env the reporter resolves its identity from", async () => {
		const root = await startDryRunTeam("launch-contract-team");
		const config = (await Bun.file(
			path.join(teamStateDir(root, "launch-contract-team"), "config.json"),
		).json()) as GjcTeamConfig;
		const worker = config.workers[0];
		if (!worker) throw new Error("expected a launched worker");

		const command = buildWorkerCommand(config, worker, "darwin");
		// Reconstruct the pane env from the launch command instead of trusting a
		// hand-written fixture: if launch ever stops exporting one of these, the
		// worker silently publishes no heartbeat and the old defect returns.
		const paneEnv: NodeJS.ProcessEnv = {};
		for (const [, key, value] of command.matchAll(/(GJC_[A-Z_]+)='([^']*)'/g)) paneEnv[key] = value;

		expect(paneEnv.GJC_TEAM_NAME).toBe("launch-contract-team");
		expect(paneEnv.GJC_TEAM_WORKER_ID).toBe(worker.id);
		expect(resolveGjcTeamWorkerIdentity(paneEnv)).toEqual({
			teamName: "launch-contract-team",
			workerId: worker.id,
		});
		expect(resolveGjcTeamWorkerHeartbeatIntervalMs(paneEnv)).toBe(30_000);
		expect(GjcTeamWorkerHeartbeatReporter.forProcess(() => root, paneEnv)).toBeDefined();
	});

	it("propagates a tightened stale window into the worker pane so cadence matches leader policy", async () => {
		const root = await startDryRunTeam("stale-window-propagation-team");
		const config = (await Bun.file(
			path.join(teamStateDir(root, "stale-window-propagation-team"), "config.json"),
		).json()) as GjcTeamConfig;
		const worker = config.workers[0];
		if (!worker) throw new Error("expected a launched worker");

		// tmux panes do not inherit the launching shell's environment. If the leader's
		// window is not exported, it polices at 15s while the worker still publishes on
		// the 120s default cadence — reported stale while working.
		const command = buildWorkerCommand(config, worker, "darwin", undefined, {
			GJC_TEAM_HEARTBEAT_STALE_MS: "15000",
		});
		const paneEnv: NodeJS.ProcessEnv = {};
		for (const [, key, value] of command.matchAll(/(GJC_[A-Z_]+)='([^']*)'/g)) paneEnv[key] = value;

		expect(paneEnv.GJC_TEAM_HEARTBEAT_STALE_MS).toBe("15000");
		expect(resolveGjcTeamWorkerHeartbeatIntervalMs(paneEnv)).toBe(5_000);
		// Unset stays unset: the default cadence is implicit on both sides.
		expect(buildWorkerCommand(config, worker, "darwin", undefined, {})).not.toContain("GJC_TEAM_HEARTBEAT_STALE_MS");
	});
});
