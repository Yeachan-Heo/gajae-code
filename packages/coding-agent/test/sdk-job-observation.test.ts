import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@gajae-code/utils";
import { AsyncJobManager, type SubagentRecord, type SubagentRunOutcome } from "../src/async/job-manager";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { AgentRegistry } from "../src/registry/agent-registry";
import {
	JobObservation,
	type JobObservationError,
	type JobObservationTarget,
	type TaskObservationTarget,
} from "../src/sdk/job-observation";
import { createAgentSession } from "../src/sdk/session";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";
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
		? SessionManager.create(temp.path(), SessionManager.explicitDestination(path.join(temp.path(), "sessions")))
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
