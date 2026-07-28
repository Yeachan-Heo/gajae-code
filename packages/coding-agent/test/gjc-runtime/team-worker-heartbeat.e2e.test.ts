/**
 * Cross-process regression guard for the runtime-owned worker heartbeat.
 *
 * A worker pane is a separate GJC process, and the leader decides from files on
 * disk whether that worker has gone quiet. In-process tests cannot reproduce that,
 * so both cases spawn a real worker process and let the real monitor path decide.
 *
 * Together they pin the fix and its blast radius: a worker that publishes keeps its
 * claim through a turn far longer than the stale window, and a worker that publishes
 * nothing is still recovered exactly as before.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { teamStateRoot } from "../../src/gjc-runtime/session-layout";
import { claimGjcTeamTask, monitorGjcTeam, startGjcTeam } from "../../src/gjc-runtime/team-runtime";

const TEST_SESSION_ID = "test-session";
/** Comfortably above the reporter cadence so freshness is unambiguous. */
const STALE_MS = 6_000;
const WORKER_FIXTURE = path.resolve(import.meta.dir, "../fixtures/team-worker-heartbeat-worker.ts");

let cleanupRoot: string | undefined;
const workers: Bun.Subprocess[] = [];
let previousGjcSessionId: string | undefined;

beforeAll(() => {
	previousGjcSessionId = process.env.GJC_SESSION_ID;
	process.env.GJC_SESSION_ID = TEST_SESSION_ID;
});

afterAll(() => {
	if (previousGjcSessionId === undefined) delete process.env.GJC_SESSION_ID;
	else process.env.GJC_SESSION_ID = previousGjcSessionId;
});

afterEach(async () => {
	for (const worker of workers.splice(0)) {
		worker.kill("SIGKILL");
		await worker.exited;
	}
	if (cleanupRoot) await fs.rm(cleanupRoot, { recursive: true, force: true });
	cleanupRoot = undefined;
});

const monitorEnv = (root: string) => ({
	PATH: process.env.PATH ?? "",
	GJC_SESSION_ID: TEST_SESSION_ID,
	GJC_TEAM_HEARTBEAT_STALE_MS: String(STALE_MS),
	GJC_TEAM_STATE_ROOT: teamStateRoot(root, TEST_SESSION_ID),
});

async function startClaimedTeam(teamName: string): Promise<{ root: string; claimPath: string }> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-worker-heartbeat-"));
	cleanupRoot = root;
	await startGjcTeam({
		workerCount: 1,
		agentType: "executor",
		task: "A long tool call must not cost the worker its claim",
		teamName,
		cwd: root,
		dryRun: true,
		env: { GJC_SESSION_ID: TEST_SESSION_ID, PATH: "" },
	});
	const claim = await claimGjcTeamTask(teamName, "worker-1", root, { PATH: "", GJC_SESSION_ID: TEST_SESSION_ID });
	expect(claim.ok).toBe(true);
	return { root, claimPath: path.join(teamStateRoot(root, TEST_SESSION_ID), teamName, "claims", "task-1.json") };
}

/** A real worker process, either publishing its own liveness or staying silent. */
function spawnWorker(root: string, teamName: string, publishes: boolean): Bun.Subprocess {
	const worker = Bun.spawn([process.execPath, WORKER_FIXTURE], {
		env: {
			...process.env,
			TEST_HEARTBEAT_MODE: publishes ? "publish" : "silent",
			WORK_CWD: root,
			GJC_SESSION_ID: TEST_SESSION_ID,
			GJC_TEAM_NAME: teamName,
			GJC_TEAM_WORKER_ID: "worker-1",
			GJC_TEAM_HEARTBEAT_STALE_MS: String(STALE_MS),
		},
		stdout: "ignore",
		stderr: "ignore",
	});
	workers.push(worker);
	return worker;
}

async function heartbeatOf(root: string, teamName: string): Promise<Record<string, unknown>> {
	const file = path.join(teamStateRoot(root, TEST_SESSION_ID), teamName, "workers", "worker-1", "heartbeat.json");
	return (await Bun.file(file).json()) as Record<string, unknown>;
}

async function heartbeatAgeMs(root: string, teamName: string): Promise<number> {
	return Date.now() - Date.parse(String((await heartbeatOf(root, teamName)).last_turn_at));
}

async function waitForPublishedPid(root: string, teamName: string, pid: number, timeoutMs = 15_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while ((await heartbeatOf(root, teamName).catch(() => ({}) as Record<string, unknown>)).pid !== pid) {
		if (Date.now() > deadline) throw new Error("worker never published its heartbeat");
		await Bun.sleep(50);
	}
}

describe("runtime-owned worker heartbeat across processes", () => {
	it(
		"keeps a worker's claim through a turn that outlives the stale window",
		async () => {
			const teamName = "publishing-worker-e2e";
			const { root, claimPath } = await startClaimedTeam(teamName);
			const worker = spawnWorker(root, teamName, true);
			await waitForPublishedPid(root, teamName, worker.pid);
			expect((await heartbeatOf(root, teamName)).pid).toBe(worker.pid);

			// One long tool call: no model turn boundary for well over the window.
			await Bun.sleep(STALE_MS * 1.5);
			expect(await heartbeatAgeMs(root, teamName)).toBeLessThan(STALE_MS);
			const snapshot = await monitorGjcTeam(teamName, root, monitorEnv(root));

			expect(snapshot.task_counts.in_progress).toBe(1);
			expect(snapshot.task_counts.pending).toBe(0);
			expect(await Bun.file(claimPath).exists()).toBe(true);
		},
		{ timeout: 60_000 },
	);

	it(
		"still recovers the claim of a worker that publishes nothing",
		async () => {
			const teamName = "silent-worker-e2e";
			const { root, claimPath } = await startClaimedTeam(teamName);
			spawnWorker(root, teamName, false);

			await Bun.sleep(STALE_MS * 1.5);
			expect(await heartbeatAgeMs(root, teamName)).toBeGreaterThan(STALE_MS);
			const snapshot = await monitorGjcTeam(teamName, root, monitorEnv(root));

			expect(snapshot.task_counts.pending).toBe(1);
			expect(await Bun.file(claimPath).exists()).toBe(false);
		},
		{ timeout: 60_000 },
	);
});
