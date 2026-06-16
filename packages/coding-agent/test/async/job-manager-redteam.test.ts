import { describe, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import {
	AsyncJobManager,
	type ResumeDescriptor,
	type SubagentRecord,
	type SubagentRunOutcome,
} from "@gajae-code/coding-agent/async/job-manager";

setDefaultTimeout(10_000);

function record(subagentId: string, jobId: string, status: SubagentRecord["status"]): SubagentRecord {
	return {
		subagentId,
		currentJobId: jobId,
		historicalJobIds: [],
		status,
		sessionFile: `/tmp/${subagentId}.jsonl`,
		resumable: true,
	};
}

function descriptor(subagentId: string): ResumeDescriptor {
	return { subagentId, data: { sessionFile: `/tmp/${subagentId}.jsonl` } };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1_000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return true;
		await Bun.sleep(10);
	}
	return predicate();
}

describe("AsyncJobManager red-team invariants", () => {
	test("dispose({ timeoutMs }) on a never-settling job returns by deadline and reports the stuck job id", async () => {
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		manager.register("task", "never settles", () => new Promise<string>(() => {}), { id: "redteam-stuck" });

		const started = performance.now();
		const disposed = await manager.dispose({ timeoutMs: 30 });
		const elapsedMs = performance.now() - started;

		expect(disposed).toBe(false);
		expect(elapsedMs).toBeLessThan(250);
		expect(manager.getLastDisposeDiagnostics()).toEqual({
			stuckJobIds: ["redteam-stuck"],
			deliveriesDrained: false,
		});
		expect(manager.getAllJobs()).toHaveLength(0);
	});

	test("late failure after dispose timeout runs terminal lifecycle and does not restart timers", async () => {
		let rejectJob!: (error: Error) => void;
		let terminalCalls = 0;
		let changeCalls = 0;
		const manager = new AsyncJobManager({ onJobComplete: () => {}, retentionMs: 60_000 });
		manager.onChange(() => {
			changeCalls += 1;
		});
		manager.register(
			"task",
			"late rejecter",
			() =>
				new Promise<string>((_resolve, reject) => {
					rejectJob = reject;
				}),
			{
				id: "late-rejecter",
				lifecycle: {
					onTerminal: () => {
						terminalCalls += 1;
					},
				},
			},
		);

		const disposed = await manager.dispose({ timeoutMs: 25 });
		const changesAfterDispose = changeCalls;
		rejectJob(new Error("late boom"));
		await Bun.sleep(25);

		expect(disposed).toBe(false);
		expect(terminalCalls).toBe(1);
		expect(manager.getDeliveryState().queued).toBe(0);
		expect(changeCalls).toBe(changesAfterDispose);
	});

	test("permanent onJobComplete failures keep delivery queue bounded, stop at retry cap, and dead-letter", async () => {
		const randomSpy = spyOn(Math, "random").mockImplementation(() => 0);
		let attempts = 0;
		const manager = new AsyncJobManager({
			onJobComplete: () => {
				attempts += 1;
				throw new Error("redteam persistent delivery failure");
			},
			maxRunningJobs: 1,
			retentionMs: 10_000,
		});

		try {
			manager.register("task", "poison delivery", async () => "cannot deliver", { id: "poison-job" });
			await manager.waitForAll();

			const drained = await manager.drainDeliveries({ timeoutMs: 1_800 });
			const state = manager.getDeliveryState();

			expect(drained).toBe(true);
			expect(state.queued).toBe(0);
			expect(state.pendingJobIds).toEqual([]);
			expect(state.deadLettered).toBe(1);
			expect(attempts).toBe(3);
		} finally {
			randomSpy.mockRestore();
			await manager.dispose({ timeoutMs: 200 });
		}
	});

	test("completion flood above the delivery bound caps the queue and counts overflow as dead-lettered", async () => {
		const manager = new AsyncJobManager({
			onJobComplete: () => new Promise<void>(() => {}),
			maxRunningJobs: 150,
			retentionMs: 10_000,
		});

		try {
			for (let i = 0; i < 150; i += 1) {
				manager.register("task", `flood ${i}`, async () => `done ${i}`, { id: `flood-${i}` });
			}
			await manager.waitForAll();

			const captured = await waitUntil(() => {
				const state = manager.getDeliveryState();
				return state.queued <= 101 && state.deadLettered >= 49;
			}, 5_000);
			const state = manager.getDeliveryState();

			expect(captured).toBe(true);
			expect(state.queued).toBeLessThanOrEqual(101);
			expect(state.deadLettered).toBeGreaterThanOrEqual(49);
			expect(state.pendingJobIds).not.toContain("flood-1");
			expect(state.pendingJobIds).toContain("flood-149");
		} finally {
			await manager.dispose({ timeoutMs: 50 });
		}
	});

	test("terminal eviction purges live terminal state while preserving durable resume descriptors", async () => {
		const manager = new AsyncJobManager({ onJobComplete: () => {}, retentionMs: 0, maxRunningJobs: 2 });

		const terminalJobId = manager.register(
			"task",
			"terminal subagent",
			async (): Promise<SubagentRunOutcome> => ({ kind: "completed", text: "terminal" }),
			{ id: "terminal-job" },
		);
		manager.registerSubagentRecord(record("terminal-sub", terminalJobId, "running"));
		manager.registerResumeDescriptor(descriptor("terminal-sub"));
		manager.registerLiveHandle("terminal-sub", { requestPause() {}, async injectMessage() {} });
		manager.recordSubagentProgress("terminal-sub", { currentTool: "terminal" } as never);

		await manager.waitForAll();
		expect(manager.getJob(terminalJobId)).toBeUndefined();
		expect(manager.getSubagentRecord("terminal-sub")?.resumable).toBe(true);
		expect(manager.getResumeDescriptor("terminal-sub")).toEqual(descriptor("terminal-sub"));
		expect(manager.getLiveHandle("terminal-sub")).toBeUndefined();
		expect(manager.getSubagentProgress("terminal-sub")).toBeUndefined();

		const pausedJobId = manager.register(
			"task",
			"paused subagent",
			async (): Promise<SubagentRunOutcome> => ({ kind: "paused", note: "safe boundary" }),
			{ id: "paused-job" },
		);
		manager.registerSubagentRecord(record("paused-sub", pausedJobId, "running"));
		manager.registerResumeDescriptor(descriptor("paused-sub"));
		manager.registerLiveHandle("paused-sub", { requestPause() {}, async injectMessage() {} });
		manager.recordSubagentProgress("paused-sub", { currentTool: "paused" } as never);

		await manager.waitForAll();
		expect(manager.getJob(pausedJobId)?.status).toBe("paused");
		expect(manager.getSubagentRecord("paused-sub")?.status).toBe("paused");
		expect(manager.getResumeDescriptor("paused-sub")).toEqual(descriptor("paused-sub"));
		expect(manager.getLiveHandle("paused-sub")).toBeUndefined();
		expect(manager.getSubagentProgress("paused-sub")).toBeUndefined();

		await manager.dispose({ timeoutMs: 200 });
	});
});
