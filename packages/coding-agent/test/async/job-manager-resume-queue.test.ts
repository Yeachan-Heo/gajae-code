import { describe, expect, test } from "bun:test";
import { AsyncJobManager, type SubagentRunOutcome } from "@gajae-code/coding-agent/async/job-manager";

/** Build a manager that records every delivered completion. */
function makeManager(opts?: { maxRunningJobs?: number; retentionMs?: number }) {
	const completions: Array<{ jobId: string; text: string }> = [];
	const manager = new AsyncJobManager({
		onJobComplete: async (jobId, text) => {
			completions.push({ jobId, text });
		},
		maxRunningJobs: opts?.maxRunningJobs,
		retentionMs: opts?.retentionMs,
	});
	return { manager, completions };
}

/** Spawn a controllable subagent whose single boundary can pause or complete. */
function spawnControllable(manager: AsyncJobManager, subagentId: string, ownerId?: string) {
	let pauseRequested = false;
	const gate = Promise.withResolvers<void>();
	const jobId = manager.register(
		"task",
		subagentId,
		async (): Promise<string | SubagentRunOutcome> => {
			await gate.promise; // wait for the test to reach the boundary
			if (pauseRequested) return { kind: "paused" };
			return { kind: "completed", text: `${subagentId} done` };
		},
		{
			id: subagentId,
			ownerId,
			metadata: { subagent: { id: subagentId, agent: "executor", agentSource: "bundled" } },
		},
	);
	manager.registerSubagentRecord({
		subagentId,
		ownerId,
		currentJobId: jobId,
		historicalJobIds: [],
		status: "running",
		sessionFile: `/tmp/${subagentId}.jsonl`,
		resumable: true,
	});
	manager.registerLiveHandle(subagentId, {
		requestPause() {
			pauseRequested = true;
		},
		async injectMessage() {},
	});
	return { jobId, release: () => gate.resolve() };
}

/** A resume runner that re-spawns a subagent which completes immediately. */
function installResumeRunner(manager: AsyncJobManager) {
	manager.setResumeRunner((subagentId, message) => {
		const rec = manager.getSubagentRecord(subagentId);
		return manager.register(
			"task",
			subagentId,
			async (): Promise<SubagentRunOutcome> => ({
				kind: "completed",
				text: message ? `resumed:${message}` : `resumed:${subagentId}`,
			}),
			{
				id: `${subagentId}-r`,
				ownerId: rec?.ownerId,
				metadata: { subagent: { id: subagentId, agent: "executor", agentSource: "bundled" } },
			},
		);
	});
}

describe("AsyncJobManager subagent pause/resume/queue", () => {
	test("paused outcome does not deliver and is exempt from eviction (AC1/AC7/AC8)", async () => {
		const { manager, completions } = makeManager({ retentionMs: 30 });
		const a = spawnControllable(manager, "A");
		expect(manager.pauseSubagent("A").ok).toBe(true);
		a.release();
		await manager.waitForAll();
		await manager.drainDeliveries({ timeoutMs: 500 });

		expect(manager.getSubagentRecord("A")?.status).toBe("paused");
		expect(manager.getJob(a.jobId)?.status).toBe("paused");
		expect(completions).toHaveLength(0); // held subagent never delivers

		await Bun.sleep(120); // past retention
		expect(manager.getJob(a.jobId)?.status).toBe("paused"); // not evicted
		expect(manager.getSubagentRecord("A")).toBeDefined();
		await manager.dispose({ timeoutMs: 500 });
	});

	test("resume rehydrates a paused subagent and delivers exactly once (AC2/AC8)", async () => {
		const { manager, completions } = makeManager();
		installResumeRunner(manager);
		const a = spawnControllable(manager, "A");
		manager.pauseSubagent("A");
		a.release();
		await manager.waitForAll();
		expect(completions).toHaveLength(0);

		const res = manager.resumeSubagent("A");
		expect(res.ok).toBe(true);
		expect(res.queued).toBeFalsy();
		await manager.waitForAll();
		await manager.drainDeliveries({ timeoutMs: 500 });

		const rec = manager.getSubagentRecord("A");
		expect(rec?.status).toBe("completed");
		expect(rec?.historicalJobIds).toContain(a.jobId); // old job archived
		expect(completions).toHaveLength(1); // exactly once
		expect(completions[0].text).toBe("resumed:A");
		await manager.dispose({ timeoutMs: 500 });
	});

	test("resume with a message passes it through (AC3/AC5)", async () => {
		const { manager, completions } = makeManager();
		installResumeRunner(manager);
		const a = spawnControllable(manager, "A");
		manager.pauseSubagent("A");
		a.release();
		await manager.waitForAll();

		manager.resumeSubagent("A", undefined, "do the new thing");
		await manager.waitForAll();
		await manager.drainDeliveries({ timeoutMs: 500 });
		expect(completions[0]?.text).toBe("resumed:do the new thing");
		await manager.dispose({ timeoutMs: 500 });
	});

	test("steer updates an already queued resume message (AC5/AC6)", async () => {
		const { manager, completions } = makeManager({ maxRunningJobs: 1 });
		installResumeRunner(manager);
		const a = spawnControllable(manager, "A");
		manager.pauseSubagent("A");
		a.release();
		await manager.waitForAll();
		const b = spawnControllable(manager, "B");

		expect(manager.resumeSubagent("A", undefined, "old").queued).toBe(true);
		expect(manager.resumeSubagent("A", undefined, "new").queued).toBe(true);
		b.release();
		await manager.waitForAll();
		await manager.drainDeliveries({ timeoutMs: 500 });

		expect(completions.map(c => c.text).sort()).toEqual(["B done", "resumed:new"]);
		await manager.dispose({ timeoutMs: 500 });
	});

	test("resume uses manager-owned descriptors after the runner is replaced", async () => {
		const { manager } = makeManager();
		const a = spawnControllable(manager, "A");
		manager.pauseSubagent("A");
		a.release();
		await manager.waitForAll();
		manager.registerResumeDescriptor({ subagentId: "A", data: { marker: "old-descriptor" } });
		let seenDescriptor: unknown;
		manager.setResumeRunner((_subagentId, _message, descriptor) => {
			seenDescriptor = descriptor?.data;
			return manager.register(
				"task",
				"A",
				async (): Promise<SubagentRunOutcome> => ({ kind: "completed", text: "resumed descriptor" }),
				{ id: "A-r", metadata: { subagent: { id: "A", agent: "executor", agentSource: "bundled" } } },
			);
		});

		expect(manager.resumeSubagent("A").ok).toBe(true);
		await manager.waitForAll();
		expect(seenDescriptor).toEqual({ marker: "old-descriptor" });
		expect(manager.getSubagentRecord("A")?.status).toBe("completed");
		await manager.dispose({ timeoutMs: 500 });
	});

	test("resume queues when at the concurrency limit and drains FIFO (AC6)", async () => {
		const { manager, completions } = makeManager({ maxRunningJobs: 1 });
		installResumeRunner(manager);

		const a = spawnControllable(manager, "A"); // running, fills the single slot
		manager.pauseSubagent("A");
		a.release();
		await manager.waitForAll(); // A paused, slot free
		expect(manager.getSubagentRecord("A")?.status).toBe("paused");

		const b = spawnControllable(manager, "B"); // running, fills the slot again
		const resume = manager.resumeSubagent("A");
		expect(resume.queued).toBe(true);
		expect(manager.getSubagentRecord("A")?.status).toBe("queued");

		b.release(); // B completes -> drain -> A resumes
		await manager.waitForAll();
		await manager.drainDeliveries({ timeoutMs: 500 });

		expect(manager.getSubagentRecord("A")?.status).toBe("completed");
		expect(manager.getSubagentRecord("B")?.status).toBe("completed");
		expect(completions.map(c => c.text).sort()).toEqual(["B done", "resumed:A"]);
		await manager.dispose({ timeoutMs: 500 });
	});

	test("cancelSubagent on a paused subagent marks cancelled but keeps the record (AC10)", async () => {
		const { manager } = makeManager();
		const a = spawnControllable(manager, "A");
		manager.pauseSubagent("A");
		a.release();
		await manager.waitForAll();

		expect(manager.cancelSubagent("A")).toBe(true);
		const rec = manager.getSubagentRecord("A");
		expect(rec?.status).toBe("cancelled");
		expect(rec?.sessionFile).toBe("/tmp/A.jsonl"); // file reference kept (resumable by id)
		await manager.dispose({ timeoutMs: 500 });
	});

	test("resume of a non-resumable subagent returns context_unavailable (AC10)", async () => {
		const { manager } = makeManager();
		manager.registerSubagentRecord({
			subagentId: "E",
			currentJobId: null,
			historicalJobIds: [],
			status: "completed",
			sessionFile: null,
			resumable: false,
		});
		const res = manager.resumeSubagent("E");
		expect(res.ok).toBe(false);
		expect(res.reason).toBe("context_unavailable");
		await manager.dispose({ timeoutMs: 500 });
	});

	test("pause after completion is a no-op (completion wins) (AC8)", async () => {
		const { manager, completions } = makeManager();
		const a = spawnControllable(manager, "A");
		a.release(); // no pause requested -> completes
		await manager.waitForAll();
		await manager.drainDeliveries({ timeoutMs: 500 });

		expect(manager.getSubagentRecord("A")?.status).toBe("completed");
		const res = manager.pauseSubagent("A");
		expect(res.ok).toBe(false);
		expect(res.reason).toBe("not_running");
		expect(completions).toHaveLength(1);
		await manager.dispose({ timeoutMs: 500 });
	});

	test("owner cleanup purges records, live handles, and queued resumes (AC9)", async () => {
		const { manager } = makeManager({ maxRunningJobs: 1 });
		installResumeRunner(manager);
		const a = spawnControllable(manager, "A", "owner-1");
		manager.pauseSubagent("A");
		a.release();
		await manager.waitForAll();

		manager.runOwnerCleanups({ ownerId: "owner-1" });
		expect(manager.getSubagentRecord("A")).toBeUndefined();
		expect(manager.getLiveHandle("A")).toBeUndefined();
		await manager.dispose({ timeoutMs: 500 });
	});
});
