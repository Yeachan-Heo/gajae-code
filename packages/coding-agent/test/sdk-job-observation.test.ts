import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@gajae-code/utils";
import { AsyncJobManager, type SubagentRecord, type SubagentRunOutcome } from "../src/async/job-manager";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { offBackend } from "../src/memory-backend/off-backend";
import type { MemoryBackendStartOptions } from "../src/memory-backend/types";
import { AgentRegistry } from "../src/registry/agent-registry";
import { createLazyService } from "../src/runtime/lazy-service";
import {
	JobObservation,
	type JobObservationError,
	type JobObservationTarget,
	type TaskObservationTarget,
} from "../src/sdk/job-observation";
import { type CreateAgentSessionOptions, createAgentSession } from "../src/sdk/session";
import { CURRENT_SESSION_VERSION } from "../src/sdk/session-readonly/format";
import type { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { type OwnerMembership, revalidateOwnerMembershipSync } from "../src/session/owner-group";
import { setPrimaryControlSurface } from "../src/session/primary-control-surface";
import { type FileEntry, SessionManager } from "../src/session/session-manager";
import { CronTool, resetCronRegistryForTests } from "../src/tools/cron";
import type { ToolSession } from "../src/tools/index";

const OWNER = "test-owner";
const managers: AsyncJobManager[] = [];
const observations: JobObservation[] = [];

function manager(retentionMs?: number, maxRunningJobs?: number): AsyncJobManager {
	const value = new AsyncJobManager({ onJobComplete: () => {}, retentionMs, maxRunningJobs });
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

function taskRecord(value: AsyncJobManager, id: string, ownerId = OWNER): SubagentRecord {
	const record: SubagentRecord = {
		subagentId: id,
		ownerId,
		status: "paused",
		currentJobId: null,
		historicalJobIds: [],
		sessionFile: "/private/task.jsonl",
		resumable: true,
	};
	value.registerSubagentRecord(record);
	return record;
}

function taskTarget(observation: JobObservation, id: string): TaskObservationTarget {
	return observation.getSnapshot().tasks.find(task => task.id === id)!.target;
}

function runningTask(value: AsyncJobManager, id: string, ownerId = OWNER) {
	const gate = Promise.withResolvers<SubagentRunOutcome>();
	const jobId = value.register(
		"task",
		id,
		({ signal }) => {
			signal.addEventListener("abort", () => gate.resolve({ kind: "completed", text: "aborted" }), { once: true });
			return gate.promise;
		},
		{ ownerId },
	);
	const record = taskRecord(value, id, ownerId);
	record.status = "running";
	record.currentJobId = jobId;
	value.registerSubagentRecord(record);
	return { gate, job: value.getJob(jobId)!, record };
}

async function observationFactory(persisted = false, parentTaskPrefix?: string) {
	const temp = TempDir.createSync("@sdk-job-observation-factory-");
	const priorManager = AsyncJobManager.instance();
	const auth = await AuthStorage.create(path.join(temp.path(), "auth.db"));
	const ownerId = `factory-owner-${crypto.randomUUID()}`;
	const sessionManager = persisted
		? SessionManager.create(
				temp.path(),
				SessionManager.explicitDestination(path.join(temp.path(), "sessions"), temp.path()),
			)
		: SessionManager.inMemory(temp.path());
	if (persisted) {
		sessionManager.appendMessage({ role: "user", content: "persisted seed", timestamp: Date.now() });
		await sessionManager.ensureOnDisk();
		await sessionManager.flush();
	}
	try {
		const result = await createAgentSession({
			cwd: temp.path(),
			agentDir: temp.path(),
			authStorage: auth,
			modelRegistry: new ModelRegistry(auth, path.join(temp.path(), "models.yml")),
			settings: Settings.isolated({ "bash.autoBackground.enabled": false }),
			agentId: ownerId,
			parentTaskPrefix,
			agentRegistry: new AgentRegistry(),
			sessionManager,
			disableExtensionDiscovery: true,
			extensions: [],
			toolNames: [],
			skills: [],
			rules: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			workspaceTree: { rootPath: temp.path(), rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			deferOptionalModelRefresh: true,
		});
		return {
			result,
			ownerId,
			dispose: async () => {
				try {
					await result.session.dispose();
				} finally {
					AsyncJobManager.setInstance(priorManager);
					auth.close();
					await temp.remove();
				}
			},
		};
	} catch (error) {
		AsyncJobManager.setInstance(priorManager);
		auth.close();
		await temp.remove();
		throw error;
	}
}

function expectCode(action: () => unknown, code: JobObservationError["code"]): void {
	expect(action).toThrow(expect.objectContaining({ name: "JobObservationError", code }));
}

async function createCron(value: AsyncJobManager, ownerId = OWNER): Promise<{ id: string; createdAt: number }> {
	const session = {
		cwd: process.cwd(),
		hasUI: false,
		getSessionId: () => "isolated-test-session",
		getAgentId: () => ownerId,
		getAsyncJobManager: () => value,
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
	const observation = observe(value, ownerId);
	return observation.getSnapshot().crons.find(cron => cron.id === id)!;
}

afterEach(async () => {
	for (const observation of observations.splice(0)) observation.dispose();
	resetCronRegistryForTests();
	for (const value of managers.splice(0)) await value.dispose();
	AsyncJobManager.setInstance(undefined);
});

describe("owner-scoped SDK job observation", () => {
	test("generic folded-job cancel joins the actual abort-ignoring runner, not acceptance", async () => {
		const value = manager();
		const observation = observe(value);
		const release = Promise.withResolvers<string>();
		const id = value.register("bash", "folded local runner", () => release.promise, { ownerId: OWNER });
		const target = { id, generation: value.getJob(id)!.generation };
		value.markBackgrounded(id, target.generation, "sdk_control");
		try {
			const pending = await observation.cancelJobAndWait(target, 0);
			expect(pending).toMatchObject({ accepted: true, status: "pending", runner: "pending" });
			expect(value.getJob(id)?.status).toBe("cancelled");
			expect(observation.getSnapshot().unsettledJobs).toContainEqual(target);
			release.resolve("actual unwind");
			await value.getJobPromise(id, target.generation);
			expect(await observation.cancelJobAndWait(target, 100)).toMatchObject({
				accepted: false,
				status: "settled",
				runner: "settled",
			});
		} finally {
			release.resolve("cleanup");
		}
	});

	test("generic joins retain pending delivery after the execution has really settled", async () => {
		const delivery = Promise.withResolvers<void>();
		const started = Promise.withResolvers<void>();
		const value = new AsyncJobManager({
			onJobComplete: async () => {
				started.resolve();
				await delivery.promise;
			},
		});
		managers.push(value);
		const observation = observe(value);
		const id = value.register("bash", "local completion", async () => "done", { ownerId: OWNER });
		const target = { id, generation: value.getJob(id)!.generation };
		observation.getSnapshot();
		try {
			await value.getJobPromise(id, target.generation);
			await started.promise;
			expect(await observation.cancelJobAndWait(target, 0)).toMatchObject({
				status: "pending",
				runner: "settled",
				delivery: "pending",
			});
			delivery.resolve();
			expect(await observation.cancelJobAndWait(target, 100)).toMatchObject({
				status: "settled",
				delivery: "settled",
			});
		} finally {
			delivery.resolve();
		}
	});

	test("an admitted join retains physical delivery across manager and observer disposal", async () => {
		const delivery = Promise.withResolvers<void>();
		const started = Promise.withResolvers<void>();
		const value = new AsyncJobManager({
			onJobComplete: async () => {
				started.resolve();
				await delivery.promise;
			},
		});
		managers.push(value);
		const observation = observe(value);
		const id = value.register("bash", "delivery outlives disposal", async () => "done", { ownerId: OWNER });
		const target = { id, generation: value.getJob(id)!.generation };
		observation.getSnapshot();
		try {
			await value.getJobPromise(id, target.generation);
			await started.promise;
			const joining = observation.cancelJobAndWait(target, 20);
			expect(await value.dispose({ timeoutMs: 0 })).toBe(false);
			observation.dispose();
			expect(value.getJob(id)).toBeUndefined();
			expect(await joining).toMatchObject({
				accepted: false,
				status: "pending",
				runner: "settled",
				delivery: "pending",
			});
		} finally {
			delivery.resolve();
			await value.awaitRetainedDisposalCompletion();
		}
	});

	test("generic cancel refuses foreign generations and cannot abort an ID-reused successor", async () => {
		const value = manager(0);
		const observation = observe(value);
		const foreign = monitor(value, "another-owner");
		await expect(observation.cancelJobAndWait(foreign, 0)).rejects.toMatchObject({ code: "not_found" });
		const first = monitor(value, OWNER, "generic-reused");
		expect((await observation.cancelJobAndWait(first, 100)).status).toBe("settled");
		const successor = monitor(value, OWNER, first.id);
		await expect(observation.cancelJobAndWait(first, 0)).rejects.toMatchObject({ code: "stale_generation" });
		expect(value.getJob(successor.id)?.status).toBe("running");
		expect(value.getJob(foreign.id)?.status).toBe("running");
	});

	test("task cancel-and-join removes paused and queued admissions without launching them", async () => {
		const value = manager(undefined, 1);
		const observation = observe(value);
		const busy = runningTask(value, "join-capacity");
		taskRecord(value, "join-paused");
		expect(await observation.cancelTaskAndWait(taskTarget(observation, "join-paused"), 0)).toMatchObject({
			accepted: true,
			status: "settled",
		});
		taskRecord(value, "join-queued");
		let launches = 0;
		value.registerResumeDescriptor({ subagentId: "join-queued", ownerId: OWNER, data: {} }, () => {
			launches++;
			return undefined;
		});
		observation.resumeTask(taskTarget(observation, "join-queued"));
		expect(await observation.cancelTaskAndWait(taskTarget(observation, "join-queued"), 0)).toMatchObject({
			accepted: true,
			status: "settled",
		});
		busy.gate.resolve({ kind: "completed", text: "release capacity" });
		await busy.job.promise;
		expect(launches).toBe(0);
		expect(value.getSubagentRecord("join-queued")?.status).toBe("cancelled");
	});

	test("task cancel-and-join does not mistake a canonical terminal transition for physical unwind", async () => {
		const value = manager();
		const observation = observe(value);
		const release = Promise.withResolvers<SubagentRunOutcome>();
		const id = value.register("task", "ignores abort", () => release.promise, { ownerId: OWNER });
		const record = taskRecord(value, "join-ignoring");
		record.status = "running";
		record.currentJobId = id;
		value.registerSubagentRecord(record);
		try {
			expect(await observation.cancelTaskAndWait(taskTarget(observation, record.subagentId), 0)).toMatchObject({
				status: "pending",
				runner: "pending",
			});
			expect(value.getSubagentRecord(record.subagentId)?.status).toBe("cancelled");
			expect(observation.getSnapshot().unsettledJobs.some(job => job.id === id)).toBe(true);
		} finally {
			release.resolve({ kind: "completed", text: "unwound" });
			await value.getJob(id)!.promise;
		}
	});

	test("unavailable execution proof returns unknown while retaining exact pending delivery", async () => {
		const delivery = Promise.withResolvers<void>();
		const started = Promise.withResolvers<void>();
		const value = new AsyncJobManager({
			retentionMs: 0,
			onJobComplete: async () => {
				started.resolve();
				await delivery.promise;
			},
		});
		managers.push(value);
		const id = value.register("bash", "evicted runner", async () => "done", { ownerId: OWNER });
		const target = { id, generation: value.getJob(id)!.generation };
		const completion = value.getJobPromise(id, target.generation)!;
		try {
			await completion;
			await started.promise;
			const observation = observe(value);
			expect(value.getJob(id)).toBeUndefined();
			expect(await observation.cancelJobAndWait(target, 0)).toMatchObject({
				accepted: false,
				status: "unknown",
				runner: "unknown",
				delivery: "pending",
			});
			expect(observation.getSnapshot().unsettledJobs).toContainEqual(target);
		} finally {
			delivery.resolve();
		}
	});

	test("invalid join deadlines and target getter disposal cannot trigger cancellation", async () => {
		const value = manager();
		const observation = observe(value);
		const target = monitor(value);
		for (const timeout of [-1, Number.NaN, Number.POSITIVE_INFINITY])
			await expect(observation.cancelJobAndWait(target, timeout)).rejects.toBeInstanceOf(RangeError);
		await expect(
			observation.cancelJobAndWait(
				{
					get id() {
						observation.dispose();
						return target.id;
					},
					generation: target.generation,
				},
				0,
			),
		).rejects.toMatchObject({ code: "disposed" });
		expect(value.getJob(target.id)?.status).toBe("running");
	});

	test("named schedule join checks createdAt and deletes only the selected owner schedule", async () => {
		const value = manager();
		const observation = observe(value);
		const first = await createCron(value);
		const second = await createCron(value);
		const foreign = await createCron(value, "foreign-owner");
		await expect(observation.deleteCronAndWait(foreign, 0)).rejects.toMatchObject({ code: "not_found" });
		await expect(
			observation.deleteCronAndWait({ id: first.id, createdAt: first.createdAt - 1 }, 0),
		).rejects.toMatchObject({ code: "stale_generation" });
		expect(await observation.deleteCronAndWait(first, 0)).toMatchObject({ accepted: true, status: "settled" });
		expect(observation.getSnapshot().crons.map(cron => cron.id)).toEqual([second.id]);
		expect(
			observe(value, "foreign-owner")
				.getSnapshot()
				.crons.map(cron => cron.id),
		).toEqual([foreign.id]);
	});
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
		const observation = observe(value);
		const owned = await createCron(value);
		const foreign = await createCron(value, "foreign-owner");
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

	test("owned task controls exclude foreign, legacy, guessed IDs and caller authority", () => {
		const value = manager();
		const observation = observe(value);
		taskRecord(value, "owned");
		taskRecord(value, "foreign", "foreign-owner");
		value.registerSubagentRecord({ ...taskRecord(value, "legacy"), ownerId: undefined });
		const owned = taskTarget(observation, "owned");
		expect(observation.getSnapshot().tasks.map(task => task.id)).toEqual(["owned"]);
		for (const id of ["foreign", "legacy", "guessed"]) {
			for (const action of ["cancelTask", "pauseTask", "resumeTask"] as const) {
				expectCode(() => observation[action]({ id, generation: owned.generation }), "not_found");
			}
		}
		expectCode(() => observation.cancelTask({ ...owned, generation: "guessed" }), "stale_generation");
		const snapshot = observation.getSnapshot();
		snapshot.tasks[0]!.target.generation = "tampered";
		snapshot.tasks[0]!.capabilities.cancel = false;
		expect(taskTarget(observation, "owned")).toEqual(owned);
		expect(observation.getSnapshot().tasks[0]?.capabilities.cancel).toBe(true);
		let idReads = 0;
		let generationReads = 0;
		const spoofed = {
			get id() {
				return idReads++ === 0 ? owned.id : "foreign";
			},
			get generation() {
				generationReads++;
				return owned.generation;
			},
			ownerId: "foreign-owner",
		};
		expect(observation.cancelTask(spoofed)).toBe(true);
		expect(idReads).toBe(1);
		expect(generationReads).toBe(1);
		expect(value.getSubagentRecord("foreign")?.status).toBe("paused");
		expect(value.getSubagentRecord("legacy")?.status).toBe("paused");
	});

	test("task pause is graceful, resume uses captured runner, and stop aborts the actual run", async () => {
		const value = manager();
		const observation = observe(value);
		const run = runningTask(value, "lifecycle");
		let pauseRequested = false;
		value.registerLiveHandle("lifecycle", {
			requestPause: () => {
				pauseRequested = true;
			},
			injectMessage: async () => {},
		});
		const descriptor = { subagentId: "lifecycle", ownerId: OWNER, data: { secret: "private payload" } };
		const messages: (string | undefined)[] = [];
		value.registerResumeDescriptor(descriptor, (id, message, received) => {
			expect(received).toBe(descriptor);
			messages.push(message);
			return value.register(
				"task",
				id,
				({ signal }) => {
					const gate = Promise.withResolvers<string>();
					signal.addEventListener("abort", () => gate.resolve("stopped"), { once: true });
					return gate.promise;
				},
				{ ownerId: OWNER },
			);
		});
		value.setResumeRunner(() => {
			throw new Error("global runner must not execute");
		});
		const running = observation.getSnapshot().tasks[0]!;
		expect(running.capabilities).toEqual({ cancel: true, pause: true, resume: false });
		expect(observation.pauseTask(running.target)).toEqual({ status: "running" });
		expect(pauseRequested).toBe(true);
		expect(run.job.abortController.signal.aborted).toBe(false);
		expect(run.record.status).toBe("running");
		run.gate.resolve({ kind: "paused", note: "safe boundary" });
		await run.job.promise;
		const paused = observation.getSnapshot().tasks[0]!;
		expect(paused.capabilities).toEqual({ cancel: true, pause: false, resume: true });
		expectCode(() => observation.pauseTask(paused.target), "not_running");
		const resumed = observation.resumeTask(paused.target, "continue carefully");
		expect(resumed).toEqual({ status: "running", jobId: expect.any(String), queued: false });
		expect(messages).toEqual(["continue carefully"]);
		expectCode(() => observation.cancelTask(paused.target), "stale_generation");
		const active = taskTarget(observation, "lifecycle");
		expectCode(() => observation.resumeTask(active), "already_running");
		expect(observation.cancelTask(active)).toBe(true);
		expect(value.getJob(resumed.jobId!)?.abortController.signal.aborted).toBe(true);
		await value.getJob(resumed.jobId!)!.promise;
		expect(value.getSubagentRecord("lifecycle")?.status).toBe("cancelled");
		expect(JSON.stringify(observation.getSnapshot().tasks)).not.toContain("private");
	});

	test("task generations reject replacement records and real paused-running-paused ABA", async () => {
		const value = manager();
		const observation = observe(value);
		const original = taskRecord(value, "aba");
		const initial = taskTarget(observation, "aba");
		taskRecord(value, "aba");
		expectCode(() => observation.cancelTask(initial), "stale_generation");
		value.registerSubagentRecord(original);
		expectCode(() => observation.cancelTask(initial), "stale_generation");
		const paused = taskTarget(observation, "aba");
		const gate = Promise.withResolvers<SubagentRunOutcome>();
		value.registerResumeDescriptor({ subagentId: "aba", ownerId: OWNER, data: {} }, id =>
			value.register("task", id, () => gate.promise, { ownerId: OWNER }),
		);
		const beforeResume = taskTarget(observation, "aba");
		const resumed = observation.resumeTask(beforeResume);
		gate.resolve({ kind: "paused" });
		await value.getJob(resumed.jobId!)!.promise;
		expect(observation.getSnapshot().tasks[0]?.status).toBe("paused");
		for (const old of [initial, paused, beforeResume]) {
			expectCode(() => observation.cancelTask(old), "stale_generation");
		}
		expect(observation.cancelTask(taskTarget(observation, "aba"))).toBe(true);
	});

	test("target and live-handle getters cannot cross the final task CAS or disposal", () => {
		const value = manager();
		const observation = observe(value);
		taskRecord(value, "target-getter");
		const old = taskTarget(observation, "target-getter");
		expectCode(
			() =>
				observation.cancelTask({
					get id() {
						taskRecord(value, old.id);
						return old.id;
					},
					generation: old.generation,
				}),
			"stale_generation",
		);
		const run = runningTask(value, "handle-getter");
		let calls = 0;
		value.registerLiveHandle("handle-getter", {
			get requestPause() {
				taskRecord(value, "handle-getter");
				return () => {
					calls++;
				};
			},
			injectMessage: async () => {},
		});
		expectCode(() => observation.pauseTask(taskTarget(observation, "handle-getter")), "stale_generation");
		expect(calls).toBe(0);
		expect(run.job.abortController.signal.aborted).toBe(false);
		const fresh = taskTarget(observation, old.id);
		expectCode(
			() =>
				observation.cancelTask({
					id: fresh.id,
					get generation() {
						observation.dispose();
						return fresh.generation;
					},
				}),
			"disposed",
		);
		expect(value.getSubagentRecord(old.id)?.status).toBe("paused");
	});

	test("resume distinguishes missing context and runner, refuses global fallback and propagates admission errors", () => {
		const value = manager();
		const observation = observe(value);
		const record = taskRecord(value, "resume-errors");
		record.resumable = false;
		expectCode(() => observation.resumeTask(taskTarget(observation, record.subagentId)), "context_unavailable");
		record.resumable = true;
		value.setResumeRunner(() => {
			throw new Error("global runner must not execute");
		});
		expectCode(() => observation.resumeTask(taskTarget(observation, record.subagentId)), "no_runner");
		value.registerResumeDescriptor(
			{ subagentId: record.subagentId, ownerId: "foreign", data: {} },
			() => "foreign-job",
		);
		expectCode(() => observation.resumeTask(taskTarget(observation, record.subagentId)), "no_runner");
		value.registerResumeDescriptor({ subagentId: record.subagentId, ownerId: OWNER, data: {} }, () => undefined);
		expectCode(() => observation.resumeTask(taskTarget(observation, record.subagentId)), "resume_failed");
		// A new descriptor registration without its own captured runner cannot borrow the old one.
		value.registerResumeDescriptor({ subagentId: record.subagentId, ownerId: OWNER, data: {} });
		expectCode(() => observation.resumeTask(taskTarget(observation, record.subagentId)), "no_runner");
		const failure = new Error("actual admission denied");
		value.registerResumeDescriptor({ subagentId: record.subagentId, ownerId: OWNER, data: {} }, () => {
			throw failure;
		});
		expect(() => observation.resumeTask(taskTarget(observation, record.subagentId))).toThrow(failure);
		expect(record.status).toBe("paused");
	});

	test("task pause reports missing handles and callback failures without aborting work", () => {
		const value = manager();
		const observation = observe(value);
		const run = runningTask(value, "pause-errors");
		expect(observation.getSnapshot().tasks[0]?.capabilities.pause).toBe(false);
		expectCode(() => observation.pauseTask(taskTarget(observation, "pause-errors")), "no_live_handle");
		const failure = new Error("pause request failed");
		value.registerLiveHandle("pause-errors", {
			requestPause: () => {
				throw failure;
			},
			injectMessage: async () => {},
		});
		const old = taskTarget(observation, "pause-errors");
		expect(() => observation.pauseTask(old)).toThrow(failure);
		expectCode(() => observation.cancelTask(old), "stale_generation");
		expect(run.job.abortController.signal.aborted).toBe(false);
		expect(run.record.status).toBe("running");
		expect(observation.cancelTask(taskTarget(observation, "pause-errors"))).toBe(true);
	});

	test("queued task controls cancel admission without launching a run", async () => {
		const value = manager(undefined, 1);
		const observation = observe(value);
		const busy = runningTask(value, "busy");
		taskRecord(value, "queued");
		let launches = 0;
		value.registerResumeDescriptor({ subagentId: "queued", ownerId: OWNER, data: {} }, () => {
			launches++;
			return undefined;
		});
		const old = taskTarget(observation, "queued");
		expect(observation.resumeTask(old)).toEqual({ status: "queued", jobId: undefined, queued: true });
		const queued = observation.getSnapshot().tasks.find(task => task.id === "queued")!;
		expect(queued.capabilities).toEqual({ cancel: true, pause: false, resume: false });
		expectCode(() => observation.cancelTask(old), "stale_generation");
		expectCode(() => observation.pauseTask(queued.target), "not_running");
		expectCode(() => observation.resumeTask(queued.target, "update"), "already_queued");
		expect(observation.cancelTask(queued.target)).toBe(true);
		busy.gate.resolve({ kind: "completed", text: "done" });
		await busy.job.promise;
		expect(launches).toBe(0);
		expect(value.getSubagentRecord("queued")?.status).toBe("cancelled");
	});

	test("terminal tasks refuse stop; disposed facades and managers refuse all task controls", async () => {
		const value = manager();
		const observation = observe(value);
		const run = runningTask(value, "finished");
		run.gate.resolve({ kind: "completed", text: "done" });
		await run.job.promise;
		const terminal = observation.getSnapshot().tasks[0]!;
		expect(terminal.capabilities).toEqual({ cancel: false, pause: false, resume: false });
		expectCode(() => observation.cancelTask(terminal.target), "already_terminal");
		expectCode(() => observation.pauseTask(terminal.target), "not_running");
		observation.dispose();
		for (const action of ["cancelTask", "pauseTask", "resumeTask"] as const) {
			expectCode(() => observation[action](terminal.target), "disposed");
		}
		const other = observe(value);
		const target = taskTarget(other, "finished");
		await value.dispose();
		expectCode(() => other.getSnapshot(), "disposed");
		for (const action of ["cancelTask", "pauseTask", "resumeTask"] as const) {
			expectCode(() => other[action](target), "disposed");
		}
	});

	test("session endpoint A-B-A rebind and fresh manager identity never reuse task targets", async () => {
		const value = manager();
		expect(AsyncJobManager.registerForEndpoint("task-scope-A", value)).toBe(true);
		const observation = observe(value);
		taskRecord(value, "bound");
		const target = taskTarget(observation, "bound");
		expect(AsyncJobManager.rekeyForEndpoint("task-scope-A", "task-scope-B", value)).toBe(true);
		expect(AsyncJobManager.rekeyForEndpoint("task-scope-B", "task-scope-A", value)).toBe(true);
		expectCode(() => observation.getSnapshot(), "stale_generation");
		expectCode(() => observation.cancelTask(target), "stale_generation");
		const rebound = observe(value);
		expect(rebound.cancelTask(taskTarget(rebound, "bound"))).toBe(true);
		const restarted = manager();
		taskRecord(restarted, "bound");
		expectCode(() => observe(restarted).cancelTask(target), "stale_generation");
		await value.dispose();
	});

	for (const initialView of [false, true]) {
		test(`real factory maintenance observation recovers after a transition read ${initialView ? "with a retained view" : "before initial admission"}`, async () => {
			const fixture = await observationFactory();
			const { result, ownerId } = fixture;
			const { session } = result;
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			let maintenance: Promise<void> | undefined;
			try {
				const generation = session.sessionLifecycle.generation;
				const sessionManager = session.sessionManager;
				const sessionId = session.sessionId;
				const capturedManager = AsyncJobManager.forEndpoint(sessionId)!;
				const scope = capturedManager.getSubagentControlScope();
				const target = monitor(capturedManager, ownerId);
				taskRecord(capturedManager, "maintenance-owned", ownerId);
				taskRecord(capturedManager, "maintenance-foreign", "foreign-owner");
				const predecessor = initialView ? result.jobObservation! : undefined;
				const oldTask = predecessor && taskTarget(predecessor, "maintenance-owned");
				maintenance = session.withMcpControlAdmission(generation, async () => {
					entered.resolve();
					await release.promise;
				});
				await entered.promise;
				expect(session.sessionLifecycle.transitioning).toBe(true);
				expect(session.sessionLifecycle.generation).toBe(generation);
				expect(result.jobObservation).toBe(predecessor);
				if (predecessor && oldTask) {
					expectCode(() => predecessor.getSnapshot(), "disposed");
					expectCode(() => predecessor.cancelMonitor(target), "disposed");
					for (const action of ["cancelTask", "pauseTask", "resumeTask"] as const) {
						expectCode(() => predecessor[action](oldTask), "disposed");
					}
				}
				expect(capturedManager.getJob(target.id)?.status).toBe("running");
				expect(capturedManager.getSubagentRecord("maintenance-owned")?.status).toBe("paused");
				await session.notifySessionIdentityChanged();
				expect(result.jobObservation).toBe(predecessor);
				release.resolve();
				await maintenance;
				expect(session.sessionLifecycle.transitioning).toBe(false);
				expect(session.sessionLifecycle.generation).toBe(generation);
				expect(session.sessionManager).toBe(sessionManager);
				expect(session.sessionId).toBe(sessionId);
				expect(capturedManager.getSubagentControlScope()).toBe(scope);
				const settled = result.jobObservation;
				expect(settled).toBeDefined();
				if (!settled) throw new Error("Expected settled same-owner observation");
				expect(settled).not.toBe(predecessor);
				expect(result.jobObservation).toBe(settled);
				expect(settled.getSnapshot().tasks.map(task => task.id)).toEqual(["maintenance-owned"]);
				expect(settled.cancelMonitor(target)).toBe(true);
				expect(settled.cancelTask(taskTarget(settled, "maintenance-owned"))).toBe(true);
				if (predecessor && oldTask) {
					expectCode(() => predecessor.cancelTask(oldTask), "disposed");
					predecessor.dispose();
					expect(result.jobObservation).toBe(settled);
					expect(settled.getSnapshot().tasks[0]?.status).toBe("cancelled");
				}
				await session.dispose();
				expect(result.jobObservation).toBe(settled);
				expectCode(() => settled.getSnapshot(), "disposed");
			} finally {
				release.resolve();
				await maintenance;
				await fixture.dispose();
			}
		});
	}

	for (const disposeDuringTransition of [false, true]) {
		test(`real factory maintenance observation never recreates a host-disposed view ${disposeDuringTransition ? "during transition" : "before transition"}`, async () => {
			const fixture = await observationFactory();
			const { result } = fixture;
			const { session } = result;
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			let maintenance: Promise<void> | undefined;
			try {
				const generation = session.sessionLifecycle.generation;
				const predecessor = result.jobObservation!;
				if (!disposeDuringTransition) predecessor.dispose();
				maintenance = session.withMcpControlAdmission(generation, async () => {
					entered.resolve();
					await release.promise;
				});
				await entered.promise;
				expect(result.jobObservation).toBe(predecessor);
				if (disposeDuringTransition) predecessor.dispose();
				release.resolve();
				await maintenance;
				expect(session.sessionLifecycle.generation).toBe(generation);
				await session.notifySessionIdentityChanged();
				expect(result.jobObservation).toBe(predecessor);
				expectCode(() => predecessor.getSnapshot(), "disposed");
				expect(await session.newSession()).toBe(true);
				const successor = result.jobObservation!;
				expect(successor).not.toBe(predecessor);
				predecessor.dispose();
				expect(result.jobObservation).toBe(successor);
				expect(successor.getSnapshot().tasks).toEqual([]);
			} finally {
				release.resolve();
				await maintenance;
				await fixture.dispose();
			}
		});
	}

	for (const [mismatch, duringMaintenance] of [
		["manager", false],
		["session ID", false],
		["scope", false],
		["manager", true],
		["session ID", true],
		["scope", true],
	] as const) {
		test(`real factory maintenance observation keeps ${duringMaintenance ? "transitioning" : "settled"} ${mismatch} mismatch permanently invalidated`, async () => {
			const fixture = await observationFactory();
			const { result } = fixture;
			const { session } = result;
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			let maintenance: Promise<void> | undefined;
			let transition: Promise<boolean> | undefined;
			const committed = Promise.withResolvers<void>();
			const releaseCommitted = Promise.withResolvers<void>();
			let restoreOwner: (() => void) | undefined;
			try {
				const generation = session.sessionLifecycle.generation;
				const originalManager = session.sessionManager;
				const sessionId = session.sessionId;
				const capturedManager = AsyncJobManager.forEndpoint(sessionId)!;
				const predecessor = result.jobObservation!;
				maintenance = session.withMcpControlAdmission(generation, async () => {
					entered.resolve();
					await release.promise;
				});
				await entered.promise;
				expect(result.jobObservation).toBe(predecessor);
				if (!duringMaintenance) {
					release.resolve();
					await maintenance;
				}
				if (mismatch === "manager") {
					session.sessionManager = SessionManager.inMemory(originalManager.getCwd());
					restoreOwner = () => {
						session.sessionManager = originalManager;
					};
				} else if (mismatch === "session ID") {
					const sessionIdSpy = spyOn(originalManager, "getSessionId").mockReturnValue(`${sessionId}-uncommitted`);
					restoreOwner = () => sessionIdSpy.mockRestore();
				} else if (duringMaintenance) {
					const scopeSpy = spyOn(capturedManager, "getSubagentControlScope").mockReturnValue(
						`${capturedManager.getSubagentControlScope()}-uncommitted`,
					);
					restoreOwner = () => scopeSpy.mockRestore();
				} else {
					const endpoint = AsyncJobManager.endpointIdOf(capturedManager)!;
					expect(AsyncJobManager.rekeyForEndpoint(endpoint, `${endpoint}-uncommitted`, capturedManager)).toBe(
						true,
					);
					restoreOwner = () => {
						expect(AsyncJobManager.rekeyForEndpoint(`${endpoint}-uncommitted`, endpoint, capturedManager)).toBe(
							true,
						);
					};
				}
				expect(result.jobObservation).toBe(predecessor);
				expectCode(() => predecessor.getSnapshot(), "disposed");
				restoreOwner();
				restoreOwner = undefined;
				await session.notifySessionIdentityChanged();
				expect(session.sessionLifecycle.generation).toBe(generation);
				expect(result.jobObservation).toBe(predecessor);
				expectCode(() => predecessor.getSnapshot(), "disposed");
				release.resolve();
				await maintenance;
				expect(session.sessionLifecycle.transitioning).toBe(false);
				expect(session.sessionLifecycle.generation).toBe(generation);
				expect(result.jobObservation).toBe(predecessor);
				expectCode(() => predecessor.getSnapshot(), "disposed");
				session.registerToolSessionTransitionCleanup(() => {
					committed.resolve();
					return releaseCommitted.promise;
				});
				transition = session.newSession();
				await committed.promise;
				expect(session.sessionLifecycle.generation).toBeGreaterThan(generation);
				expect(session.sessionLifecycle.transitioning).toBe(true);
				expect(result.jobObservation).toBe(predecessor);
				expectCode(() => predecessor.getSnapshot(), "disposed");
				releaseCommitted.resolve();
				expect(await transition).toBe(true);
				const successor = result.jobObservation!;
				expect(successor).not.toBe(predecessor);
				expect(successor.getSnapshot().tasks).toEqual([]);
			} finally {
				restoreOwner?.();
				release.resolve();
				releaseCommitted.resolve();
				await maintenance;
				await transition;
				await fixture.dispose();
			}
		});
	}

	for (const admission of ["factory-minted", "preexisting", "before-manager"] as const) {
		test(`interactive factory constructor cleanup preserves ${admission} ownership`, async () => {
			const temp = TempDir.createSync("@sdk-factory-constructor-admission-");
			const priorManager = AsyncJobManager.instance();
			const auth = await AuthStorage.create(path.join(temp.path(), "auth.db"));
			const modelRegistry = new ModelRegistry(auth, path.join(temp.path(), "models.yml"));
			modelRegistry.registerProvider("admission-fixture", {
				baseUrl: "http://127.0.0.1:9/v1",
				apiKey: "ADMISSION_FIXTURE_KEY",
				api: "openai-completions",
				models: [
					{
						id: "initial-model",
						name: "Admission Fixture Model",
						reasoning: false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 128_000,
						maxTokens: 8_192,
					},
				],
			});
			const sessionManager = SessionManager.create(
				temp.path(),
				SessionManager.explicitDestination(path.join(temp.path(), "sessions"), temp.path()),
			);
			if (admission === "preexisting") await sessionManager.ensureOnDisk();
			const initialMembership = sessionManager.getOwnerMembership();
			if (admission === "preexisting") expect(initialMembership).toBeDefined();
			const failure = new Error(`constructor failure with ${admission} admission`);
			let constructorMembership: OwnerMembership | undefined;
			const memoryMode = spyOn(sessionManager, "setSessionMemoryMode").mockImplementationOnce(() => {
				constructorMembership = sessionManager.getOwnerMembership();
				expect(constructorMembership).toBeDefined();
				expect(sessionManager.getSessionOwnerEvidence()?.policy.kind).toBe("cooperative");
				expect(() => revalidateOwnerMembershipSync(constructorMembership!)).not.toThrow();
				expect(sessionManager.getBranch()).toEqual(
					expect.arrayContaining([
						expect.objectContaining({ type: "model_change", model: "admission-fixture/initial-model" }),
						expect.objectContaining({ type: "thinking_level_change" }),
					]),
				);
				throw failure;
			});
			const beforeManager = spyOn(modelRegistry, "applyConfiguredModelBindings");
			if (admission === "before-manager")
				beforeManager.mockImplementationOnce(() => {
					throw failure;
				});
			const flush = spyOn(sessionManager, "flush");
			const ensureOnDisk = spyOn(sessionManager, "ensureOnDisk");
			const close = spyOn(sessionManager, "closeStrict");
			const retire = spyOn(sessionManager, "retireFactoryCooperativeOwnerAfterClose");
			const settings = Settings.isolated({
				"bash.autoBackground.enabled": false,
				"memory.backend": "off",
				"notifications.enabled": false,
				modelRoles: { default: "admission-fixture/initial-model" },
			});
			const options: CreateAgentSessionOptions = {
				cwd: temp.path(),
				agentDir: temp.path(),
				authStorage: auth,
				modelRegistry,
				settings,
				agentRegistry: new AgentRegistry(),
				sessionManager,
				hasUI: true,
				disableExtensionDiscovery: true,
				extensions: [],
				toolNames: [],
				skills: [],
				rules: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				workspaceTree: {
					rootPath: temp.path(),
					rendered: "",
					truncated: false,
					totalLines: 0,
					agentsMdFiles: [],
				},
				enableMCP: false,
				enableLsp: false,
				skipPythonPreflight: true,
				deferOptionalModelRefresh: true,
			};
			setPrimaryControlSurface(options, "cli");
			try {
				await expect(createAgentSession(options)).rejects.toBe(failure);
				expect(memoryMode).toHaveBeenCalledTimes(admission === "before-manager" ? 0 : 1);
				if (admission === "factory-minted") {
					expect(initialMembership).toBeUndefined();
					expect(ensureOnDisk).toHaveBeenCalledTimes(1);
					expect(flush).toHaveBeenCalledTimes(1);
					expect(close).toHaveBeenCalledTimes(1);
					expect(sessionManager.getStrictCloseState()).toEqual({ kind: "closed" });
					expect(retire).toHaveBeenCalledTimes(1);
					expect(retire).toHaveBeenCalledWith(constructorMembership);
					expect(retire.mock.results[0]!.value).toBe(true);
					expect(sessionManager.getOwnerMembership()).toBeUndefined();
					expect(() => revalidateOwnerMembershipSync(constructorMembership!)).toThrow("participation_lost");
					const entries = (await Bun.file(sessionManager.getSessionFile()!).text())
						.trimEnd()
						.split("\n")
						.map(line => JSON.parse(line) as FileEntry);
					expect(entries).toContainEqual(
						expect.objectContaining({ type: "model_change", model: "admission-fixture/initial-model" }),
					);
				} else {
					expect(ensureOnDisk).not.toHaveBeenCalled();
					expect(flush).not.toHaveBeenCalled();
					expect(close).not.toHaveBeenCalled();
					expect(retire).not.toHaveBeenCalled();
					expect(sessionManager.getStrictCloseState()).toEqual({ kind: "none_started" });
					expect(sessionManager.getOwnerMembership()).toBe(initialMembership);
					if (admission === "preexisting") {
						expect(constructorMembership).toBe(initialMembership);
						expect(() => revalidateOwnerMembershipSync(initialMembership!)).not.toThrow();
					}
				}
				expect(AsyncJobManager.forEndpoint(sessionManager.getSessionId())).toBeUndefined();
				expect(AsyncJobManager.instance()).toBe(priorManager);
				const endpointFile = path.join(
					temp.path(),
					".gjc",
					"state",
					"sdk",
					`${sessionManager.getSessionId()}.json`,
				);
				expect(await Bun.file(endpointFile).exists()).toBe(false);
			} finally {
				memoryMode.mockRestore();
				beforeManager.mockRestore();
				flush.mockRestore();
				ensureOnDisk.mockRestore();
				close.mockRestore();
				retire.mockRestore();
				if (sessionManager.getStrictCloseState().kind === "none_started") {
					await sessionManager.ensureOnDisk();
					await sessionManager.flushAndCloseStrict();
				}
				const membership = sessionManager.getOwnerMembership();
				if (membership) sessionManager.retireFactoryCooperativeOwnerAfterClose(membership);
				AsyncJobManager.setInstance(priorManager);
				await modelRegistry.dispose();
				await settings.close();
				auth.close();
				await temp.remove();
			}
		});
	}

	for (const notifications of [false, true]) {
		for (const failurePhase of ["factory", "session", "supplied-session"] as const) {
			test(`interactive factory ${failurePhase} failure ${notifications ? "with notifications" : "with default SDK hosting"} never strands cooperative admission`, async () => {
				const temp = TempDir.createSync("@sdk-factory-admission-");
				const priorManager = AsyncJobManager.instance();
				const auth = await AuthStorage.create(path.join(temp.path(), "auth.db"));
				const file = path.join(temp.path(), "sessions", "seed.jsonl");
				const timestamp = new Date().toISOString();
				await Bun.write(
					file,
					[
						{
							type: "session",
							version: CURRENT_SESSION_VERSION,
							id: crypto.randomUUID(),
							timestamp,
							cwd: temp.path(),
						},
						{
							type: "message",
							id: "seed-message",
							parentId: null,
							timestamp,
							message: { role: "user", content: "persisted seed", timestamp: Date.now() },
						},
					]
						.map(entry => JSON.stringify(entry))
						.join("\n") + "\n",
				);
				const sessionManager = await SessionManager.open(
					file,
					SessionManager.explicitDestination(path.dirname(file), temp.path()),
				);
				if (failurePhase === "supplied-session") await sessionManager.ensureOnDisk();
				const initialMembership = sessionManager.getOwnerMembership();
				if (failurePhase === "supplied-session") expect(initialMembership).toBeDefined();
				const flush = spyOn(sessionManager, "flush");
				const ensureOnDisk = spyOn(sessionManager, "ensureOnDisk");
				const close = spyOn(sessionManager, "closeStrict");
				const entered = Promise.withResolvers<void>();
				const release = Promise.withResolvers<void>();
				const failure = new Error(`held ${failurePhase} startup failure`);
				let capturedSession: AgentSession | undefined;
				let startupMembership: OwnerMembership | undefined;
				let disposeCalls = (): number => 0;
				let restoreDispose: (() => void) | undefined;
				const options: CreateAgentSessionOptions = {
					cwd: temp.path(),
					agentDir: temp.path(),
					authStorage: auth,
					modelRegistry: new ModelRegistry(auth, path.join(temp.path(), "models.yml")),
					settings: Settings.isolated({
						"bash.autoBackground.enabled": false,
						"memory.backend": "off",
						"notifications.enabled": notifications,
						"notifications.telegram.enabled": notifications,
						"notifications.telegram.botToken": "123456:admission-test-token",
						"notifications.telegram.chatId": "42",
					}),
					agentRegistry: new AgentRegistry(),
					sessionManager,
					hasUI: true,
					disableExtensionDiscovery: true,
					extensions: [
						async () => {
							expect(flush).not.toHaveBeenCalled();
							expect(ensureOnDisk).not.toHaveBeenCalled();
							expect(sessionManager.getOwnerMembership()).toBe(initialMembership);
							if (failurePhase === "factory") {
								entered.resolve();
								await release.promise;
								throw failure;
							}
						},
					],
					runtimeServices: {
						memoryBackend: createLazyService({
							id: "memory.backend",
							initialize: async () => ({
								value: {
									...offBackend,
									async start({ session }: MemoryBackendStartOptions) {
										capturedSession = session;
										const dispose = spyOn(session, "dispose");
										disposeCalls = () => dispose.mock.calls.length;
										restoreDispose = () => dispose.mockRestore();
										expect(ensureOnDisk).toHaveBeenCalledTimes(failurePhase === "supplied-session" ? 0 : 1);
										expect(flush).toHaveBeenCalledTimes(failurePhase === "supplied-session" ? 1 : 0);
										const membership = sessionManager.getOwnerMembership()!;
										startupMembership = membership;
										expect(membership).toBeDefined();
										if (failurePhase === "supplied-session") {
											if (!initialMembership)
												throw new Error("Expected the supplied session's admitted membership");
											expect(membership).toBe(initialMembership);
										} else expect(initialMembership).toBeUndefined();
										expect(sessionManager.getSessionOwnerEvidence()?.policy.kind).toBe("cooperative");
										const header = JSON.parse((await Bun.file(file).text()).split("\n")[0]!) as FileEntry;
										expect(header).toMatchObject({ type: "session", id: sessionManager.getSessionId() });
										expect(sessionManager.retireFactoryCooperativeOwnerAfterClose(membership)).toBe(false);
										expect(sessionManager.getOwnerMembership()).toBe(membership);
										expect(() => revalidateOwnerMembershipSync(membership)).not.toThrow();
										// Default endpoint hooks remain registered, but no host starts
										// until the caller initializes session_start after factory return.
										expect(session.extensionRunner?.hasHandlers("session_start")).toBe(true);
										expect(session.extensionRunner?.getCommand("notify")).toBeDefined();
										const appended = sessionManager.appendCustomEntry("startup-writer", {});
										await sessionManager.flush();
										const records = (await Bun.file(file).text()).trimEnd().split("\n");
										expect(records.map(line => JSON.parse(line) as FileEntry)).toContainEqual(
											expect.objectContaining({
												type: "custom",
												id: appended,
												customType: "startup-writer",
											}),
										);
										entered.resolve();
										await release.promise;
										throw failure;
									},
								},
							}),
						}),
					},
					toolNames: [],
					skills: [],
					rules: [],
					contextFiles: [],
					promptTemplates: [],
					slashCommands: [],
					workspaceTree: {
						rootPath: temp.path(),
						rendered: "",
						truncated: false,
						totalLines: 0,
						agentsMdFiles: [],
					},
					enableMCP: false,
					enableLsp: false,
					skipPythonPreflight: true,
					deferOptionalModelRefresh: true,
				};
				setPrimaryControlSurface(options, "cli");
				const creation = createAgentSession(options);
				void creation.catch(() => {});
				try {
					await Promise.race([
						entered.promise,
						creation.then(() => {
							throw new Error("Factory returned before the held startup boundary");
						}),
					]);
					const membership = sessionManager.getOwnerMembership();
					if (failurePhase !== "factory") expect(membership).toBe(startupMembership);
					expect(close).not.toHaveBeenCalled();
					const endpointFile = path.join(
						temp.path(),
						".gjc",
						"state",
						"sdk",
						`${sessionManager.getSessionId()}.json`,
					);
					expect(await Bun.file(endpointFile).exists()).toBe(false);
					release.resolve();
					await expect(creation).rejects.toBe(failure);
					if (failurePhase === "factory") {
						expect(flush).not.toHaveBeenCalled();
						expect(ensureOnDisk).not.toHaveBeenCalled();
						expect(close).not.toHaveBeenCalled();
						expect(sessionManager.getOwnerMembership()).toBeUndefined();
					} else {
						expect(disposeCalls()).toBe(1);
						expect(capturedSession?.isDisposed).toBe(true);
						expect(close).toHaveBeenCalledTimes(1);
						await expect(close.mock.results[0]!.value).resolves.toMatchObject({ kind: "closed" });
						if (failurePhase === "supplied-session") {
							expect(membership).toBe(initialMembership);
							expect(() => revalidateOwnerMembershipSync(membership!)).not.toThrow();
						} else {
							expect(() => revalidateOwnerMembershipSync(membership!)).toThrow("participation_lost");
						}
					}
				} finally {
					release.resolve();
					await creation.catch(() => {});
					await capturedSession?.dispose();
					restoreDispose?.();
					flush.mockRestore();
					ensureOnDisk.mockRestore();
					close.mockRestore();
					await sessionManager.closeStrict();
					if (initialMembership) sessionManager.retireFactoryCooperativeOwnerAfterClose(initialMembership);
					AsyncJobManager.setInstance(priorManager);
					auth.close();
					await temp.remove();
				}
			});
		}
	}

	test("real SDK factory renews only after completed committed transitions and retires predecessor cleanup", async () => {
		const fixture = await observationFactory(true);
		const { result, ownerId } = fixture;
		const { session } = result;
		const release = Promise.withResolvers<void>();
		let transition: Promise<boolean> | undefined;
		try {
			const originalId = session.sessionId;
			const originalFile = session.sessionManager.getSessionFile();
			if (!originalFile) throw new Error("Expected persisted factory session");
			const originalGeneration = session.sessionLifecycle.generation;
			const originalMembership = session.sessionManager.getOwnerMembership();
			expect(originalMembership).toBeDefined();
			const capturedManager = AsyncJobManager.forEndpoint(originalId)!;
			expect(capturedManager).toBeDefined();
			const predecessor = result.jobObservation!;
			expect(result.jobObservation).toBe(predecessor);
			await session.notifySessionIdentityChanged();
			expect(session.sessionLifecycle.generation).toBe(originalGeneration);
			expect(result.jobObservation).toBe(predecessor);
			const entered = Promise.withResolvers<void>();
			session.registerToolSessionTransitionCleanup(() => {
				entered.resolve();
				return release.promise;
			});
			const predecessorDispose = spyOn(predecessor, "dispose");
			try {
				transition = session.newSession();
				await entered.promise;
				expect(session.sessionLifecycle.generation).toBeGreaterThan(originalGeneration);
				expect(session.sessionLifecycle.transitioning).toBe(true);
				expect(result.jobObservation).toBe(predecessor);
				expectCode(() => predecessor.getSnapshot(), "disposed");
				await session.notifySessionIdentityChanged();
				expect(result.jobObservation).toBe(predecessor);
				release.resolve();
				expect(await transition).toBe(true);
				expect(session.sessionLifecycle.transitioning).toBe(false);
				expect(() => revalidateOwnerMembershipSync(originalMembership!)).toThrow("participation_lost");
				const intermediateMembership = session.sessionManager.getOwnerMembership();
				expect(intermediateMembership).toBeDefined();
				const intermediateId = session.sessionId;
				const intermediateFile = session.sessionManager.getSessionFile()!;
				const intermediate = result.jobObservation!;
				expect(intermediate).not.toBe(predecessor);
				expect(result.jobObservation).toBe(intermediate);
				expect(AsyncJobManager.forEndpoint(session.sessionId)).toBe(capturedManager);
				taskRecord(capturedManager, "new-owned", ownerId);
				taskRecord(capturedManager, "new-foreign", "foreign-owner");
				expect(intermediate.getSnapshot().tasks.map(task => task.id)).toEqual(["new-owned"]);
				expect(intermediate.cancelTask(taskTarget(intermediate, "new-owned"))).toBe(true);
				const predecessorCalls = predecessorDispose.mock.calls.length;
				const intermediateDispose = spyOn(intermediate, "dispose");
				try {
					expect(await session.switchSession(originalFile)).toBe(true);
					expect(session.sessionId).toBe(originalId);
					expect(session.sessionManager.getSessionFile()).toBe(originalFile);
					expect(() => revalidateOwnerMembershipSync(intermediateMembership!)).toThrow("participation_lost");
					const appended = session.sessionManager.appendCustomEntry("switched-owner", {});
					await session.sessionManager.flush();
					const switchedOwner = session.sessionManager.getSessionOwnerEvidence()!;
					expect(switchedOwner).toBeDefined();
					expect(session.sessionManager.getOwnerMembership()).not.toBe(originalMembership);
					expect(session.sessionManager.getOwnerMembership()).not.toBe(intermediateMembership);
					const records = (await Bun.file(originalFile).text())
						.trimEnd()
						.split("\n")
						.map(line => JSON.parse(line) as FileEntry);
					expect(records[0]).toMatchObject({ type: "session", id: originalId });
					expect(records.filter(entry => entry.id === appended)).toHaveLength(1);
					expect(
						records.filter(entry => entry.type === "custom" && entry.customType === "gjc.owner_enroll"),
					).toContainEqual(
						expect.objectContaining({
							data: expect.objectContaining({ bind: originalId, member: switchedOwner.memberId }),
						}),
					);
					expect(
						records.filter(
							entry =>
								entry.type === "custom" &&
								entry.customType === "gjc.owner_enroll" &&
								(entry.data as { bind: string }).bind === intermediateId,
						),
					).toEqual([]);
					const intermediateRecords = (await Bun.file(intermediateFile).text())
						.trimEnd()
						.split("\n")
						.map(line => JSON.parse(line) as FileEntry);
					expect(intermediateRecords[0]).toMatchObject({ type: "session", id: intermediateId });
					expect(intermediateRecords.some(entry => entry.id === appended)).toBe(false);
					const successor = result.jobObservation!;
					expect(successor).not.toBe(predecessor);
					expect(successor).not.toBe(intermediate);
					expect(successor.getSnapshot().tasks).toEqual([]);
					expectCode(() => predecessor.getSnapshot(), "disposed");
					expectCode(() => intermediate.getSnapshot(), "disposed");
					expect(predecessorDispose.mock.calls).toHaveLength(predecessorCalls);
					const intermediateCalls = intermediateDispose.mock.calls.length;
					await session.dispose();
					expect(result.jobObservation).toBe(successor);
					expectCode(() => successor.getSnapshot(), "disposed");
					expect(predecessorDispose.mock.calls).toHaveLength(predecessorCalls);
					expect(intermediateDispose.mock.calls).toHaveLength(intermediateCalls);
				} finally {
					intermediateDispose.mockRestore();
				}
			} finally {
				predecessorDispose.mockRestore();
			}
		} finally {
			release.resolve();
			await transition;
			await fixture.dispose();
		}
	});

	test("real factory never renews on session-manager ABA or uncommitted manager endpoint ABA", async () => {
		const fixture = await observationFactory();
		const { session } = fixture.result;
		try {
			const originalManager = session.sessionManager;
			const generation = session.sessionLifecycle.generation;
			const predecessor = fixture.result.jobObservation!;
			session.sessionManager = SessionManager.inMemory(originalManager.getCwd());
			expect(fixture.result.jobObservation).toBe(predecessor);
			expectCode(() => predecessor.getSnapshot(), "disposed");
			session.sessionManager = originalManager;
			await session.notifySessionIdentityChanged();
			expect(session.sessionLifecycle.generation).toBe(generation);
			expect(fixture.result.jobObservation).toBe(predecessor);
			expectCode(() => predecessor.getSnapshot(), "disposed");
			expect(await session.newSession()).toBe(true);
			const successor = fixture.result.jobObservation!;
			expect(successor).not.toBe(predecessor);
			const manager = AsyncJobManager.forEndpoint(session.sessionId)!;
			const endpoint = AsyncJobManager.endpointIdOf(manager)!;
			expect(AsyncJobManager.rekeyForEndpoint(endpoint, `${endpoint}-uncommitted`, manager)).toBe(true);
			expect(fixture.result.jobObservation).toBe(successor);
			expectCode(() => successor.getSnapshot(), "disposed");
			expect(AsyncJobManager.rekeyForEndpoint(`${endpoint}-uncommitted`, endpoint, manager)).toBe(true);
			expect(fixture.result.jobObservation).toBe(successor);
			expectCode(() => successor.getSnapshot(), "disposed");
		} finally {
			await fixture.dispose();
		}
	});

	test("real factory stays lazy without a manager and after disposal across committed generations", async () => {
		const child = await observationFactory(false, "observation-child");
		try {
			const globalManager = manager();
			AsyncJobManager.setInstance(globalManager);
			expect(child.result.jobObservation).toBeUndefined();
			expect(await child.result.session.newSession()).toBe(true);
			expect(child.result.jobObservation).toBeUndefined();
			await child.result.session.dispose();
			expect(child.result.jobObservation).toBeUndefined();
		} finally {
			await child.dispose();
		}
		const root = await observationFactory();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let transition: Promise<boolean> | undefined;
		try {
			root.result.session.registerToolSessionTransitionCleanup(() => {
				entered.resolve();
				return release.promise;
			});
			transition = root.result.session.newSession();
			await entered.promise;
			expect(root.result.session.sessionLifecycle.transitioning).toBe(true);
			expect(root.result.jobObservation).toBeUndefined();
			release.resolve();
			expect(await transition).toBe(true);
			await root.result.session.dispose();
			expect(root.result.jobObservation).toBeUndefined();
		} finally {
			release.resolve();
			await transition;
			await root.dispose();
		}
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
