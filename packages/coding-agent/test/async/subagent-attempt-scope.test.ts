import { afterEach, describe, expect, it } from "bun:test";
import { AsyncJobManager, type SubagentLiveHandle, type SubagentRecord } from "../../src/async";

function createManager(): AsyncJobManager {
	return new AsyncJobManager({ onJobComplete: async () => {}, retentionMs: 10_000 });
}

function runningJob(manager: AsyncJobManager, id: string): string {
	return manager.register(
		"task",
		id,
		async ({ signal }) => {
			await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
			throw new Error("cancelled");
		},
		{ id },
	);
}

function record(subagentId: string, jobId: string, status: SubagentRecord["status"] = "running"): SubagentRecord {
	return {
		subagentId,
		currentJobId: jobId,
		historicalJobIds: [],
		status,
		sessionFile: "/tmp/subagent.jsonl",
		resumable: true,
	};
}

function handle(requestPause = () => {}): SubagentLiveHandle {
	return { requestPause, async injectMessage() {} };
}

describe("subagent attempt-scoped live state", () => {
	afterEach(() => AsyncJobManager.resetForTests());

	it("rejects stale handle/progress writers and retains only the current attempt", () => {
		const manager = createManager();
		const oldJobId = runningJob(manager, "old");
		const newJobId = runningJob(manager, "new");
		manager.registerSubagentRecord(record("0-Child", oldJobId, "paused"));
		manager.setResumeRunner(() => newJobId);
		expect(manager.resumeSubagent("0-Child").jobId).toBe(newJobId);

		const current = handle();
		expect(manager.registerLiveHandle("0-Child", newJobId, current)).toBe(true);
		expect(manager.hasLiveSubagent("0-Child")).toBe(true);
		expect(manager.registerLiveHandle("0-Child", oldJobId, handle())).toBe(false);
		manager.removeLiveHandle("0-Child", oldJobId);
		expect(manager.getLiveHandle("0-Child")).toBe(current);

		manager.recordSubagentProgress("0-Child", oldJobId, { currentTool: "stale" } as never);
		expect(manager.getSubagentProgress("0-Child")).toBeUndefined();
		manager.recordSubagentProgress("0-Child", newJobId, { currentTool: "current" } as never);
		expect(manager.getSubagentProgress("0-Child")?.currentTool).toBe("current");
	});

	it("rejects late handle registration after cancellation and does not infer liveness from a job", () => {
		const manager = createManager();
		const jobId = runningJob(manager, "cancelled");
		manager.registerSubagentRecord(record("0-Child", jobId));
		expect(manager.hasLiveSubagent("0-Child")).toBe(false);
		expect(manager.cancel(jobId)).toBe(true);
		expect(manager.registerLiveHandle("0-Child", jobId, handle())).toBe(false);
		expect(manager.hasLiveSubagent("0-Child")).toBe(false);
	});

	it("does not pause a superseding attempt after steering the captured attempt", async () => {
		const manager = createManager();
		const oldJobId = runningJob(manager, "steer-old");
		const newJobId = runningJob(manager, "steer-new");
		let newAttemptPaused = false;
		manager.registerSubagentRecord(record("0-Child", oldJobId));
		manager.setResumeRunner(() => newJobId);
		manager.registerLiveHandle("0-Child", oldJobId, {
			requestPause() {},
			async injectMessage() {
				manager.cancel(oldJobId);
				manager.resumeSubagent("0-Child");
				manager.registerLiveHandle(
					"0-Child",
					newJobId,
					handle(() => {
						newAttemptPaused = true;
					}),
				);
			},
		});

		expect(await manager.steerSubagent("0-Child", "keep going", { pause: true })).toBe("superseded");
		expect(newAttemptPaused).toBe(false);
		expect(manager.getSubagentRecord("0-Child")?.currentJobId).toBe(newJobId);
	});
});
