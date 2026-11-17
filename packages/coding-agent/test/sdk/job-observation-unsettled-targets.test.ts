import { expect, it } from "bun:test";
import { AsyncJobManager } from "../../src/async/job-manager";
import { JobObservation } from "../../src/sdk/job-observation";

it("retains only exact job addresses for unsettled canonical task executions", async () => {
	const manager = new AsyncJobManager({ onJobComplete: async () => {}, retentionMs: 60_000 });
	const ownerId = "unsettled-task-owner";
	const observation = new JobObservation(manager, ownerId);
	const started = Promise.withResolvers<void>();
	const finish = Promise.withResolvers<string>();
	try {
		const jobId = manager.register(
			"task",
			"canonical detached task",
			() => {
				started.resolve();
				return finish.promise;
			},
			{ ownerId },
		);
		manager.registerSubagentRecord({
			subagentId: "canonical-task",
			ownerId,
			status: "running",
			currentJobId: jobId,
			historicalJobIds: [jobId],
			sessionFile: null,
			resumable: false,
		});
		await started.promise;
		const snapshot = observation.getSnapshot();
		expect(snapshot.unsettledJobs).toHaveLength(1);
		for (const address of snapshot.unsettledJobs) {
			expect(Object.keys(address).sort()).toEqual(["generation", "id"]);
			// This is the same spread used by owned-work consent prevalidation.
			const target = { kind: "job", ...address };
			expect(target.kind).toBe("job");
			const task = snapshot.tasks.find(
				entry => entry.currentJobId === target.id && entry.currentJobGeneration === target.generation,
			);
			expect(task?.id).toBe("canonical-task");
			expect(task?.capabilities.cancel).toBe(true);
			expect(manager.getJob(target.id)?.generation).toBe(target.generation);
		}
		finish.resolve("finished");
		await manager.getJobPromise(jobId, snapshot.unsettledJobs[0]!.generation);
		expect(observation.getSnapshot().unsettledJobs).toEqual([]);
	} finally {
		finish.resolve("cleanup");
		observation.dispose();
		await manager.dispose();
	}
});
