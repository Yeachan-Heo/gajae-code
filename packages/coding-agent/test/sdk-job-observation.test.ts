import { afterEach, describe, expect, test } from "bun:test";
import { AsyncJobManager } from "../src/async/job-manager";
import { JobObservation, type JobObservationError, type JobObservationTarget } from "../src/sdk/job-observation";
import { CronTool, resetCronRegistryForTests } from "../src/tools/cron";
import type { ToolSession } from "../src/tools/index";

const OWNER = "test-owner";
const managers: AsyncJobManager[] = [];
const observations: JobObservation[] = [];

function manager(retentionMs?: number): AsyncJobManager {
	const value = new AsyncJobManager({ onJobComplete: () => {}, retentionMs });
	managers.push(value);
	return value;
}

function observe(value: AsyncJobManager, owner = OWNER): JobObservation {
	const observation = new JobObservation(value, owner);
	observations.push(observation);
	return observation;
}

function monitor(value: AsyncJobManager, ownerId = OWNER, id?: string): JobObservationTarget {
	const jobId = value.register(
		"bash",
		"monitor",
		({ signal }) => {
			const gate = Promise.withResolvers<string>();
			if (signal.aborted) gate.resolve("aborted");
			else signal.addEventListener("abort", () => gate.resolve("aborted"), { once: true });
			return gate.promise;
		},
		{ ownerId, id, metadata: { monitor: true } },
	);
	return { id: jobId, generation: value.getJob(jobId)!.generation };
}

function expectCode(action: () => unknown, code: JobObservationError["code"]): void {
	expect(action).toThrow(expect.objectContaining({ name: "JobObservationError", code }));
}

async function createCron(ownerId = OWNER): Promise<{ id: string; createdAt: number }> {
	const session = {
		cwd: process.cwd(),
		hasUI: false,
		getSessionId: () => "isolated-test-session",
		getAgentId: () => ownerId,
		sendCustomMessage: async () => {},
		allocateOutputArtifact: async () => ({}),
	} as unknown as ToolSession;
	const result = await new CronTool(session).execute("cron-test", {
		op: "create",
		cron_expression: "*/5 * * * *",
		prompt: "isolated test reminder",
		recurring: true,
	});
	const id = result.details!.id!;
	// Query through the same public facade a client uses, not the schedule store.
	const observation = observe(managers[0]!, ownerId);
	return observation.getSnapshot().crons.find(cron => cron.id === id)!;
}

afterEach(async () => {
	for (const observation of observations.splice(0)) observation.dispose();
	resetCronRegistryForTests();
	for (const value of managers.splice(0)) await value.dispose();
	AsyncJobManager.setInstance(undefined);
});

describe("owner-scoped SDK job observation", () => {
	test("rejects absent/blank owners rather than falling back to unscoped queries", () => {
		const value = manager();
		for (const owner of ["", " ", " owner", "owner ", "__legacy__"]) {
			expectCode(() => new JobObservation(value, owner), "invalid_owner");
		}
	});

	test("snapshots and monitor output/control never expose foreign or legacy owners", () => {
		const value = manager();
		const observation = observe(value);
		const owned = monitor(value);
		const foreign = monitor(value, "foreign-owner");
		const legacyId = value.register("bash", "legacy", async () => "legacy", { metadata: { monitor: true } });
		value.appendOutput(owned.id, "owned output\n");
		value.appendOutput(foreign.id, "private foreign output\n");
		expect(observation.getSnapshot().jobs.map(job => job.id)).toEqual([owned.id]);
		expect(observation.getSnapshot().monitors.map(job => job.id)).toEqual([owned.id]);
		expect(observation.getMonitorOutput(owned)).toBe("owned output\n");
		for (const target of [foreign, { id: legacyId, generation: value.getJob(legacyId)!.generation }]) {
			expectCode(() => observation.getMonitorOutput(target), "not_found");
			expectCode(() => observation.cancelMonitor(target), "not_found");
			expectCode(() => observation.cancelMonitor({ ...target, generation: "wrong" }), "not_found");
		}
		expect(value.getJob(foreign.id)?.status).toBe("running");
	});

	test("folded monitors and ordinary bash/task jobs remain read-only", () => {
		const value = manager();
		const observation = observe(value);
		const folded = monitor(value);
		value.markBackgrounded(folded.id, folded.generation, "sdk_control");
		const plain = value.register("bash", "ordinary", () => Promise.resolve("done"), { ownerId: OWNER });
		const task = value.register("task", "task", () => Promise.resolve("done"), { ownerId: OWNER });
		for (const target of [folded, ...[plain, task].map(id => ({ id, generation: value.getJob(id)!.generation }))]) {
			expectCode(() => observation.cancelMonitor(target), "read_only");
			expectCode(() => observation.getMonitorOutput(target), "read_only");
			expect(value.getJob(target.id)?.status).toBe("running");
		}
	});

	test("rejects stale generations after actual job ID reuse", async () => {
		const value = manager(0);
		const observation = observe(value);
		const old = monitor(value, OWNER, "reused-monitor");
		expect(observation.cancelMonitor(old)).toBe(true);
		await value.getJob(old.id)!.promise;
		const successor = monitor(value, OWNER, old.id);
		expect(successor.id).toBe(old.id);
		expect(successor.generation).not.toBe(old.generation);
		value.appendOutput(successor.id, "successor output");
		expectCode(() => observation.cancelMonitor(old), "stale_generation");
		expectCode(() => observation.getMonitorOutput(old), "stale_generation");
		expect(value.getJob(successor.id)?.status).toBe("running");
		expect(observation.getMonitorOutput(successor)).toBe("successor output");
	});

	test("completed monitor output remains readable and cancellation explicitly refuses", async () => {
		const value = manager();
		const observation = observe(value);
		const id = value.register("bash", "finished", async () => "done", {
			ownerId: OWNER,
			metadata: { monitor: true },
		});
		const target = { id, generation: value.getJob(id)!.generation };
		value.appendOutput(id, "final output");
		await value.getJob(id)!.promise;
		await value.drainDeliveries({ timeoutMs: 1_000 });
		expectCode(() => observation.cancelMonitor(target), "already_terminal");
		expect(observation.getMonitorOutput(target)).toBe("final output");
		expect(value.getJob(id)?.status).toBe("completed");
	});

	test("evicted monitor records refuse output and cancellation", async () => {
		const value = manager(0);
		const observation = observe(value);
		const target = monitor(value);
		const completion = value.getJob(target.id)!.promise;
		observation.cancelMonitor(target);
		await completion;
		expect(value.getJob(target.id)).toBeUndefined();
		expectCode(() => observation.getMonitorOutput(target), "not_found");
		expectCode(() => observation.cancelMonitor(target), "not_found");
	});

	test("request getters cannot switch the target after validation", () => {
		const value = manager();
		const observation = observe(value);
		const owned = monitor(value);
		const foreign = monitor(value, "foreign-owner");
		value.appendOutput(owned.id, "owned");
		value.appendOutput(foreign.id, "private");
		let reads = 0;
		const target = {
			get id() {
				return reads++ === 0 ? owned.id : foreign.id;
			},
			generation: owned.generation,
		};
		expect(observation.getMonitorOutput(target)).toBe("owned");
		expect(reads).toBe(1);
		reads = 0;
		expect(observation.cancelMonitor(target)).toBe(true);
		expect(value.getJob(foreign.id)?.status).toBe("running");
	});

	test("request extraction cannot bypass disposal", () => {
		const value = manager();
		const observation = observe(value);
		const target = monitor(value);
		expectCode(
			() =>
				observation.cancelMonitor({
					get id() {
						observation.dispose();
						return target.id;
					},
					generation: target.generation,
				}),
			"disposed",
		);
		expect(value.getJob(target.id)?.status).toBe("running");
	});

	test("failure acknowledgment is scoped to the observer and never consumes deliveries", async () => {
		const value = manager();
		const observation = observe(value);
		const secondView = observe(value);
		const foreignView = observe(value, "foreign-owner");
		const id = value.register(
			"bash",
			"failed monitor",
			async () => {
				throw new Error("test failure");
			},
			{
				ownerId: OWNER,
				metadata: { monitor: true },
			},
		);
		await value.getJob(id)!.promise;
		await value.drainDeliveries({ timeoutMs: 1_000 });
		expect(observation.getSnapshot().failedUnacknowledged).toBe(true);
		expect(foreignView.getSnapshot().failedUnacknowledged).toBe(false);
		const deliveryState = value.getJobsSnapshot({ ownerId: OWNER });
		observation.acknowledgeFailures();
		expect(observation.getSnapshot().failedUnacknowledged).toBe(false);
		expect(secondView.getSnapshot().failedUnacknowledged).toBe(true);
		expect(value.getJobsSnapshot({ ownerId: OWNER })).toEqual(deliveryState);
	});

	test("cron deletion checks owner and schedule identity; repeated deletion is not-found", async () => {
		const value = manager();
		AsyncJobManager.setInstance(value);
		const observation = observe(value);
		const owned = await createCron();
		const foreign = await createCron("foreign-owner");
		expect(observation.getSnapshot().crons.map(cron => cron.id)).toEqual([owned.id]);
		expectCode(() => observation.deleteCron(foreign), "not_found");
		expectCode(() => observation.deleteCron({ ...owned, createdAt: owned.createdAt - 1 }), "stale_generation");
		expect(observation.getSnapshot().crons.map(cron => cron.id)).toEqual([owned.id]);
		let reads = 0;
		expect(
			observation.deleteCron({
				get id() {
					return reads++ === 0 ? owned.id : foreign.id;
				},
				createdAt: owned.createdAt,
			}),
		).toBe(true);
		expect(reads).toBe(1);
		expectCode(() => observation.deleteCron(owned), "not_found");
		expect(
			observe(value, "foreign-owner")
				.getSnapshot()
				.crons.map(cron => cron.id),
		).toEqual([foreign.id]);
	});

	test("task snapshots use scoped canonical lifecycle, not foreign session metadata", async () => {
		const value = manager();
		const observation = observe(value);
		for (const [id, ownerId, status] of [
			["owned-paused", OWNER, "paused"],
			["owned-queued", OWNER, "queued"],
			["foreign-task", "foreign-owner", "running"],
		] as const) {
			value.registerSubagentRecord({
				subagentId: id,
				ownerId,
				status,
				currentJobId: null,
				historicalJobIds: ["history"],
				sessionFile: "/private/session.jsonl",
				resumable: true,
				currentJobGeneration: "job:retained",
				terminalGeneration: "job:previous",
				queued:
					status === "queued" ? { ownerId, seq: 1, message: "private resume input", createdAt: 1 } : undefined,
			});
		}
		const tasks = observation.getSnapshot().tasks;
		expect(tasks.map(task => [task.id, task.status])).toEqual([
			["owned-paused", "paused"],
			["owned-queued", "queued"],
		]);
		expect(tasks[0]?.currentJobGeneration).toBe("job:retained");
		expect(tasks[0]?.terminalGeneration).toBe("job:previous");
		expect(JSON.stringify(tasks)).not.toContain("private");
		expect(JSON.stringify(tasks)).not.toContain("history");
		tasks[0]!.status = "failed";
		expect(observation.getSnapshot().tasks[0]?.status).toBe("paused");
		value.cancelSubagent("owned-queued", { ownerId: OWNER });
		await Bun.sleep(0);
		expect(observation.getSnapshot().tasks.find(task => task.id === "owned-queued")?.status).toBe("cancelled");
	});

	test("canonical task identity and generation survive actual job eviction", async () => {
		const value = manager(0);
		const observation = observe(value);
		const gate = Promise.withResolvers<string>();
		const id = value.register("task", "retained task", () => gate.promise, { ownerId: OWNER });
		const job = value.getJob(id)!;
		value.registerSubagentRecord({
			subagentId: "stable-task",
			sessionFile: null,
			ownerId: OWNER,
			status: "running",
			currentJobId: id,
			historicalJobIds: [id],
			resumable: false,
		});
		expect(observation.getSnapshot().tasks[0]?.currentJobGeneration).toBe(job.generation);
		gate.resolve("done");
		await job.promise;
		await value.drainDeliveries({ timeoutMs: 1_000 });
		expect(value.getJob(id)).toBeUndefined();
		expect(observation.getSnapshot().tasks).toEqual([
			expect.objectContaining({ id: "stable-task", status: "completed", currentJobGeneration: job.generation }),
		]);
	});

	test("snapshot mutations do not corrupt cached jobs or backend state", () => {
		const value = manager();
		const observation = observe(value);
		const target = monitor(value);
		const snapshot = observation.getSnapshot();
		snapshot.monitors[0]!.label = "tampered";
		snapshot.jobs[0]!.status = "failed";
		snapshot.monitors.length = 0;
		expect(observation.getSnapshot().monitors[0]?.label).toBe("monitor");
		expect(observation.getSnapshot().jobs[0]?.status).toBe("running");
		expect(value.getJob(target.id)?.status).toBe("running");
	});

	test("events expose owner-scoped state, isolate listeners, and unsubscribe on dispose", async () => {
		const value = manager();
		const observation = observe(value);
		const seen: string[][] = [];
		observation.onChange(() => {
			throw new Error("bad listener");
		});
		const unsubscribe = observation.onChange(() => seen.push(observation.getSnapshot().jobs.map(job => job.id)));
		const target = monitor(value);
		monitor(value, "foreign-owner");
		await Bun.sleep(0);
		expect(seen).toEqual([[target.id]]);
		expect(observation.cancelMonitor(target)).toBe(true);
		await Bun.sleep(0);
		expect(seen.length).toBeGreaterThan(1);
		unsubscribe();
		const count = seen.length;
		monitor(value);
		await Bun.sleep(0);
		expect(seen).toHaveLength(count);
		let calls = 0;
		observation.onChange(() => calls++);
		monitor(value);
		observation.dispose();
		await Bun.sleep(0);
		expect(calls).toBe(0);
		expectCode(() => observation.getSnapshot(), "disposed");
		expectCode(() => observation.cancelMonitor(target), "disposed");
		expectCode(() => observation.getMonitorOutput(target), "disposed");
		expectCode(() => observation.deleteCron({ id: "anything", createdAt: 0 }), "disposed");
		expectCode(() => observation.acknowledgeFailures(), "disposed");
		expectCode(() => observation.onChange(() => {}), "disposed");
	});
});
