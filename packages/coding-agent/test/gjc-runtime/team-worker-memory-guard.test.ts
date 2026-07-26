import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type GjcTeamTask, selectCurrentClaimedTaskForWorker } from "@gajae-code/coding-agent/gjc-runtime/team-store";
import {
	advisoryReasonForTeamWorkerMemoryGuard,
	appendTeamWorkerMemoryGuardLedgerEntry,
	canMutateTeamWorkerMemoryGuard,
	nextTeamWorkerMemoryGuardAttempt,
	readTeamWorkerMemoryGuardLedger,
	teamWorkerMemoryGuardLedgerPath,
} from "@gajae-code/coding-agent/gjc-runtime/team-worker-memory-guard";

const tempRoots: string[] = [];

afterEach(async () => {
	for (const root of tempRoots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function makeWorkerDir(): Promise<string> {
	const gjcRoot = path.join(process.cwd(), ".gjc");
	await fs.mkdir(gjcRoot, { recursive: true });
	const root = await fs.mkdtemp(path.join(gjcRoot, "tmp-team-worker-memory-guard-"));
	tempRoots.push(root);
	const workerDir = path.join(root, "workers", "worker-1");
	await fs.mkdir(workerDir, { recursive: true });
	return workerDir;
}

describe("team worker memory guard ledger", () => {
	it("appends canonical entries and computes the next per-incident attempt", async () => {
		const workerDir = await makeWorkerDir();
		await appendTeamWorkerMemoryGuardLedgerEntry(workerDir, {
			schema_version: 1,
			recorded_at: "2026-07-23T00:00:00.000Z",
			incident_id: "incident-a",
			team_name: "demo",
			worker_id: "worker-1",
			task_id: "task-1",
			claim_token: "claim-1",
			attempt: 1,
			platform: "linux",
			action: "replace",
			result: "scheduled",
			reason: "memory_guard_threshold_exceeded",
		});
		await appendTeamWorkerMemoryGuardLedgerEntry(workerDir, {
			schema_version: 1,
			recorded_at: "2026-07-23T00:01:00.000Z",
			incident_id: "incident-a",
			team_name: "demo",
			worker_id: "worker-1",
			task_id: "task-1",
			claim_token: "claim-1",
			attempt: 2,
			platform: "linux",
			action: "replace",
			result: "failed",
			reason: "successor_not_ready",
		});
		await appendTeamWorkerMemoryGuardLedgerEntry(workerDir, {
			schema_version: 1,
			recorded_at: "2026-07-23T00:02:00.000Z",
			incident_id: "incident-b",
			team_name: "demo",
			worker_id: "worker-1",
			task_id: "task-1",
			claim_token: "claim-1",
			attempt: 1,
			platform: "linux",
			action: "blocked",
			result: "blocked",
			reason: "replacement_retry_budget_exhausted",
		});

		const entries = await readTeamWorkerMemoryGuardLedger(workerDir);
		expect(entries).toHaveLength(3);
		expect(entries.map(entry => entry.attempt)).toEqual([1, 2, 1]);
		expect(nextTeamWorkerMemoryGuardAttempt(entries, "incident-a")).toBe(3);
		expect(nextTeamWorkerMemoryGuardAttempt(entries, "incident-b")).toBe(2);
		expect(nextTeamWorkerMemoryGuardAttempt(entries, "incident-c")).toBe(1);
	});

	it("rejects malformed persisted ledger entries", async () => {
		const workerDir = await makeWorkerDir();
		await Bun.write(
			teamWorkerMemoryGuardLedgerPath(workerDir),
			'{"schema_version":1,"recorded_at":"2026-07-23T00:00:00.000Z"}\n',
		);
		await expect(readTeamWorkerMemoryGuardLedger(workerDir)).rejects.toThrow(
			"invalid_team_worker_memory_guard_ledger",
		);
	});

	it("keeps non-linux workers advisory-only", async () => {
		expect(canMutateTeamWorkerMemoryGuard("linux")).toBe(true);
		expect(canMutateTeamWorkerMemoryGuard("darwin")).toBe(false);
		expect(canMutateTeamWorkerMemoryGuard("win32")).toBe(false);
		expect(advisoryReasonForTeamWorkerMemoryGuard("linux")).toBeUndefined();
		expect(advisoryReasonForTeamWorkerMemoryGuard("darwin")).toBe("unsupported_platform:darwin");
		expect(advisoryReasonForTeamWorkerMemoryGuard("win32")).toBe("unsupported_platform:win32");
	});
});

describe("selectCurrentClaimedTaskForWorker", () => {
	const baseTask = {
		subject: "subject",
		description: "description",
		title: "title",
		objective: "objective",
		version: 1,
		created_at: "2026-07-23T00:00:00.000Z",
		updated_at: "2026-07-23T00:00:00.000Z",
	} satisfies Pick<
		GjcTeamTask,
		"subject" | "description" | "title" | "objective" | "version" | "created_at" | "updated_at"
	>;

	it("returns the exact active claim for a worker", () => {
		const tasks: GjcTeamTask[] = [
			{
				...baseTask,
				id: "task-1",
				status: "in_progress",
				owner: "worker-1",
				assignee: "worker-1",
				claim: { owner: "worker-1", token: "claim-1", leased_until: "2026-07-23T01:00:00.000Z" },
			},
			{
				...baseTask,
				id: "task-2",
				status: "pending",
				owner: "worker-2",
			},
		];
		const selected = selectCurrentClaimedTaskForWorker(tasks, "worker-1");
		expect(selected.kind).toBe("exact");
		if (selected.kind !== "exact") throw new Error("expected exact claim");
		expect(selected.task.id).toBe("task-1");
		expect(selected.claim.token).toBe("claim-1");
	});

	it("reports ambiguous active claims instead of guessing", () => {
		const tasks: GjcTeamTask[] = [
			{
				...baseTask,
				id: "task-1",
				status: "in_progress",
				owner: "worker-1",
				assignee: "worker-1",
				claim: { owner: "worker-1", token: "claim-1", leased_until: "2026-07-23T01:00:00.000Z" },
			},
			{
				...baseTask,
				id: "task-2",
				status: "in_progress",
				owner: "worker-1",
				assignee: "worker-1",
				claim: { owner: "worker-1", token: "claim-2", leased_until: "2026-07-23T01:05:00.000Z" },
			},
		];
		const selected = selectCurrentClaimedTaskForWorker(tasks, "worker-1");
		expect(selected.kind).toBe("ambiguous");
		if (selected.kind !== "ambiguous") throw new Error("expected ambiguous claim selection");
		expect(selected.tasks.map(task => task.id)).toEqual(["task-1", "task-2"]);
	});
});
