import { describe, expect, test } from "bun:test";
import {
	AsyncJobManager,
	OWNER_SUBAGENT_SHUTDOWN_TIMEOUT_MS,
	OwnerSubagentShutdownError,
	type SubagentRunOutcome,
} from "@gajae-code/coding-agent/async/job-manager";

function makeManager(maxRunningJobs = 4): AsyncJobManager {
	return new AsyncJobManager({ onJobComplete: async () => {}, maxRunningJobs, retentionMs: 60_000 });
}

function registerCooperativeSubagent(manager: AsyncJobManager, subagentId: string, ownerId: string): string {
	const jobId = manager.register(
		"task",
		subagentId,
		async ({ signal }): Promise<string> => {
			await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
			return "cancelled cooperatively";
		},
		{
			id: `${subagentId}-job`,
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
	return jobId;
}

describe("owner subagent shutdown leases", () => {
	test("exports the fixed timeout and fences only the leased owner", async () => {
		expect(OWNER_SUBAGENT_SHUTDOWN_TIMEOUT_MS).toBe(5_000);
		const manager = makeManager();
		const lease = manager.beginOwnerSubagentShutdown("owner-a");
		expect(lease).toBeDefined();
		expect(manager.beginOwnerSubagentShutdown("owner-a")).toBeUndefined();
		expect(() =>
			manager.register("task", "blocked", async () => "no", {
				ownerId: "owner-a",
				metadata: { subagent: { id: "blocked", agent: "executor", agentSource: "bundled" } },
			}),
		).toThrow(OwnerSubagentShutdownError);
		try {
			manager.register("task", "blocked", async () => "no", {
				ownerId: "owner-a",
				metadata: { subagent: { id: "blocked", agent: "executor", agentSource: "bundled" } },
			});
		} catch (error) {
			expect(error).toMatchObject({
				code: "owner_shutdown_in_progress",
				message: "Cannot start subagent while owner shutdown is in progress.",
			});
		}
		const foreignJobId = manager.register(
			"task",
			"foreign",
			async (): Promise<SubagentRunOutcome> => ({ kind: "completed", text: "ok" }),
			{
				ownerId: "owner-b",
				metadata: { subagent: { id: "foreign", agent: "executor", agentSource: "bundled" } },
			},
		);
		expect(foreignJobId).toMatch(/^bg_/);
		manager.finishOwnerSubagentShutdown(lease!, "release");
		await manager.dispose();
	});

	test("proves a captured running record by stable id and commit purges only its owner", async () => {
		const manager = makeManager();
		registerCooperativeSubagent(manager, "running", "owner-a");
		registerCooperativeSubagent(manager, "foreign", "owner-b");
		const lease = manager.beginOwnerSubagentShutdown("owner-a")!;
		expect(lease.targets).toEqual([{ subagentId: "running", jobId: "running-job", source: "record" }]);
		const proof = await manager.cancelAndProveOwnerSubagents(lease, { timeoutMs: 100 });
		expect(proof).toMatchObject({
			confirmed: true,
			reason: "confirmed",
			terminalIds: ["running"],
			unresolvedIds: [],
		});
		manager.finishOwnerSubagentShutdown(lease, "commit");
		expect(manager.getSubagentRecord("running")).toBeUndefined();
		expect(manager.getSubagentRecord("foreign")?.status).toBe("running");
		await manager.dispose();
	});

	test("proves a paused backing job and terminalizes its canonical record", async () => {
		const manager = makeManager();
		const jobId = manager.register("task", "paused", async (): Promise<SubagentRunOutcome> => ({ kind: "paused" }), {
			ownerId: "owner-a",
			metadata: { subagent: { id: "paused", agent: "executor", agentSource: "bundled" } },
		});
		await manager.waitForAll();
		manager.registerSubagentRecord({
			subagentId: "paused",
			ownerId: "owner-a",
			currentJobId: jobId,
			historicalJobIds: [],
			status: "paused",
			sessionFile: "/tmp/paused.jsonl",
			resumable: true,
		});
		const lease = manager.beginOwnerSubagentShutdown("owner-a")!;
		const proof = await manager.cancelAndProveOwnerSubagents(lease, { timeoutMs: 50 });
		expect(proof).toMatchObject({ confirmed: true, terminalIds: ["paused"] });
		expect(manager.getSubagentRecord("paused")?.status).toBe("cancelled");
		manager.finishOwnerSubagentShutdown(lease, "release");
		await manager.dispose();
	});

	test("proves a paused backing job with immediate retention eviction", async () => {
		const manager = new AsyncJobManager({ onJobComplete: async () => {}, retentionMs: 0 });
		const jobId = manager.register(
			"task",
			"paused evicted",
			async (): Promise<SubagentRunOutcome> => ({ kind: "paused" }),
			{
				ownerId: "owner-a",
				metadata: { subagent: { id: "paused-evicted", agent: "executor", agentSource: "bundled" } },
			},
		);
		await manager.waitForAll();
		manager.registerSubagentRecord({
			subagentId: "paused-evicted",
			ownerId: "owner-a",
			currentJobId: jobId,
			historicalJobIds: [],
			status: "paused",
			sessionFile: "/tmp/paused-evicted.jsonl",
			resumable: true,
		});
		const lease = manager.beginOwnerSubagentShutdown("owner-a")!;
		const proof = await manager.cancelAndProveOwnerSubagents(lease, { timeoutMs: 50 });

		expect(proof).toMatchObject({ confirmed: true, terminalIds: ["paused-evicted"], unresolvedIds: [] });
		expect(manager.getSubagentRecord("paused-evicted")?.status).toBe("cancelled");
		manager.finishOwnerSubagentShutdown(lease, "release");
		await manager.dispose();
	});

	test("captures metadata jobs registered before their canonical record and fails closed at the deadline", async () => {
		const manager = makeManager();
		const gate = Promise.withResolvers<void>();
		const earlyJobId = manager.register(
			"task",
			"early",
			async (): Promise<string> => {
				await gate.promise;
				return "late";
			},
			{
				ownerId: "owner-a",
				metadata: { subagent: { id: "early", agent: "executor", agentSource: "bundled" } },
			},
		);
		const lease = manager.beginOwnerSubagentShutdown("owner-a")!;
		expect(lease.targets).toEqual([{ subagentId: "early", jobId: earlyJobId, source: "metadata_job" }]);
		const proof = await manager.cancelAndProveOwnerSubagents(lease, { timeoutMs: 0 });
		expect(proof).toMatchObject({ confirmed: false, reason: "deadline_exceeded", unresolvedIds: ["early"] });
		manager.finishOwnerSubagentShutdown(lease, "release");
		gate.resolve();
		await manager.waitForAll();
		await manager.dispose();
	});

	test("producer cleanup retains records while legacy cleanup remains destructive", async () => {
		const manager = makeManager();
		let cleaned = 0;
		manager.registerSubagentRecord({
			subagentId: "paused",
			ownerId: "owner-a",
			currentJobId: null,
			historicalJobIds: [],
			status: "paused",
			sessionFile: "/tmp/paused.jsonl",
			resumable: true,
		});
		manager.registerOwnerCleanup("owner-a", () => {
			cleaned += 1;
		});
		manager.runOwnerProducerCleanups({ ownerId: "owner-a" });
		expect(cleaned).toBe(1);
		expect(manager.getSubagentRecord("paused")).toBeDefined();
		manager.runOwnerCleanups({ ownerId: "owner-a" });
		expect(manager.getSubagentRecord("paused")).toBeUndefined();
		await manager.dispose();
	});

	test("retains a failed strict producer cleanup for a later retry", () => {
		const manager = makeManager();
		let attempts = 0;
		manager.registerOwnerCleanup("owner-a", () => {
			attempts += 1;
			if (attempts === 1) throw new Error("cleanup failed");
		});

		expect(() => manager.runOwnerProducerCleanupsStrict({ ownerId: "owner-a" })).toThrow(
			"Async job owner cleanup failed",
		);
		expect(() => manager.runOwnerProducerCleanupsStrict({ ownerId: "owner-a" })).not.toThrow();
		expect(attempts).toBe(2);
	});

	test("holds owner deliveries during a lease, resumes on release, and suppresses on commit", async () => {
		const delivered: string[] = [];
		const manager = new AsyncJobManager({
			onJobComplete: async jobId => {
				delivered.push(jobId);
			},
			retentionMs: 60_000,
		});
		const releaseGate = Promise.withResolvers<string>();
		const releaseJobId = manager.register("bash", "release delivery", async () => releaseGate.promise, {
			ownerId: "owner-a",
		});
		const releaseLease = manager.beginOwnerSubagentShutdown("owner-a")!;
		releaseGate.resolve("release");
		await manager.getJob(releaseJobId)?.promise;
		await Bun.sleep(10);
		expect(delivered).toEqual([]);
		expect(manager.getDeliveryState({ ownerId: "owner-a" }).queued).toBe(1);
		expect(await manager.drainDeliveries({ filter: { ownerId: "owner-a" }, timeoutMs: 5 })).toBe(false);
		manager.finishOwnerSubagentShutdown(releaseLease, "release");
		await manager.drainDeliveries({ filter: { ownerId: "owner-a" }, timeoutMs: 100 });
		expect(delivered).toEqual([releaseJobId]);

		const commitGate = Promise.withResolvers<string>();
		const commitJobId = manager.register("bash", "commit delivery", async () => commitGate.promise, {
			ownerId: "owner-a",
		});
		const commitLease = manager.beginOwnerSubagentShutdown("owner-a")!;
		const proof = await manager.cancelAndProveOwnerSubagents(commitLease, { timeoutMs: 100 });
		expect(proof.confirmed).toBe(true);
		commitGate.resolve("commit");
		await manager.getJob(commitJobId)?.promise;
		await Bun.sleep(10);
		expect(manager.getDeliveryState({ ownerId: "owner-a" }).queued).toBe(1);
		manager.finishOwnerSubagentShutdown(commitLease, "commit");
		await Bun.sleep(10);
		expect(delivered).toEqual([releaseJobId]);
		expect(manager.getDeliveryState({ ownerId: "owner-a" }).queued).toBe(0);
		await manager.dispose();
	});

	test("resumes owner delivery after settlement fails and the lease releases", async () => {
		const delivered: string[] = [];
		const manager = new AsyncJobManager({
			onJobComplete: async jobId => {
				delivered.push(jobId);
			},
			retentionMs: 60_000,
		});
		const deliveryGate = Promise.withResolvers<string>();
		const deliveryJobId = manager.register("bash", "held delivery", async () => deliveryGate.promise, {
			ownerId: "owner-a",
		});
		const stuckGate = Promise.withResolvers<string>();
		const stuckJobId = manager.register("bash", "stuck settlement", async () => stuckGate.promise, {
			ownerId: "owner-a",
		});
		const lease = manager.beginOwnerSubagentShutdown("owner-a")!;
		const proof = await manager.cancelAndProveOwnerSubagents(lease, { timeoutMs: 100 });
		expect(proof.confirmed).toBe(true);
		deliveryGate.resolve("held completion");
		await manager.getJob(deliveryJobId)?.promise;
		await Bun.sleep(10);
		expect(manager.getDeliveryState({ ownerId: "owner-a" }).queued).toBe(1);
		expect(await manager.cancelAndSettleOwnerJobs("owner-a", { timeoutMs: 0 })).toBe(false);
		manager.finishOwnerSubagentShutdown(lease, "release");
		await manager.drainDeliveries({ filter: { ownerId: "owner-a" }, timeoutMs: 100 });
		expect(delivered).toEqual([deliveryJobId]);
		stuckGate.resolve("late completion");
		await manager.getJob(stuckJobId)?.promise;
		await manager.dispose();
	});

	test("waits for an owner delivery that was already in flight when the lease began", async () => {
		const deliveryStarted = Promise.withResolvers<void>();
		const deliveryGate = Promise.withResolvers<void>();
		const manager = new AsyncJobManager({
			onJobComplete: async () => {
				deliveryStarted.resolve();
				await deliveryGate.promise;
			},
			retentionMs: 60_000,
		});
		const jobId = manager.register("bash", "in-flight delivery", async () => "done", { ownerId: "owner-a" });
		await manager.getJob(jobId)?.promise;
		await deliveryStarted.promise;
		const lease = manager.beginOwnerSubagentShutdown("owner-a")!;

		expect(await manager.waitForOwnerInFlightDeliveries("owner-a", { timeoutMs: 0 })).toBe(false);
		deliveryGate.resolve();
		expect(await manager.waitForOwnerInFlightDeliveries("owner-a", { timeoutMs: 100 })).toBe(true);
		manager.finishOwnerSubagentShutdown(lease, "release");
		await manager.dispose();
	});

	test("proves a queued record after its prior run was evicted", async () => {
		const manager = makeManager();
		manager.registerSubagentRecord({
			subagentId: "queued-evicted",
			ownerId: "owner-a",
			currentJobId: "evicted-prior-run",
			historicalJobIds: [],
			status: "queued",
			sessionFile: "/tmp/queued-evicted.jsonl",
			resumable: true,
		});
		const lease = manager.beginOwnerSubagentShutdown("owner-a")!;
		expect(lease.targets).toEqual([{ subagentId: "queued-evicted", jobId: null, source: "record" }]);
		const proof = await manager.cancelAndProveOwnerSubagents(lease, { timeoutMs: 100 });
		expect(proof).toMatchObject({ confirmed: true, terminalIds: ["queued-evicted"], unresolvedIds: [] });
		manager.finishOwnerSubagentShutdown(lease, "release");
		await manager.dispose();
	});

	test("queues a watched completion and delivers it after unwatch", async () => {
		const delivered: string[] = [];
		const manager = new AsyncJobManager({
			onJobComplete: async jobId => {
				delivered.push(jobId);
			},
			retentionMs: 60_000,
		});
		const gate = Promise.withResolvers<string>();
		const jobId = manager.register("task", "watched completion", async () => gate.promise, {
			ownerId: "owner-a",
			metadata: { subagent: { id: "watched", agent: "executor", agentSource: "bundled" } },
		});
		manager.watchJobs([jobId]);
		gate.resolve("done while watched");
		await manager.getJob(jobId)?.promise;
		await Bun.sleep(10);
		expect(delivered).toEqual([]);
		manager.unwatchJobs([jobId]);
		await manager.drainDeliveries({ filter: { ownerId: "owner-a" }, timeoutMs: 100 });
		expect(delivered).toEqual([jobId]);
		await manager.dispose();
	});

	test("acknowledging another job preserves a watched completion", async () => {
		const delivered: string[] = [];
		const manager = new AsyncJobManager({
			onJobComplete: async jobId => {
				delivered.push(jobId);
			},
			retentionMs: 60_000,
		});
		const watchedGate = Promise.withResolvers<string>();
		const watchedJobId = manager.register("task", "watched A", async () => watchedGate.promise, {
			id: "watched-a-job",
			ownerId: "owner-a",
			metadata: { subagent: { id: "watched-a", agent: "executor", agentSource: "bundled" } },
		});
		manager.watchJobs([watchedJobId]);
		watchedGate.resolve("A complete");
		await manager.getJob(watchedJobId)?.promise;

		const acknowledgedJobId = manager.register("task", "acknowledged B", async () => "B complete", {
			id: "acknowledged-b-job",
			ownerId: "owner-a",
			metadata: { subagent: { id: "acknowledged-b", agent: "executor", agentSource: "bundled" } },
		});
		await manager.getJob(acknowledgedJobId)?.promise;
		manager.acknowledgeDeliveries([acknowledgedJobId]);
		manager.unwatchJobs([watchedJobId]);
		await manager.drainDeliveries({ filter: { ownerId: "owner-a" }, timeoutMs: 100 });

		expect(delivered).toContain(watchedJobId);
		await manager.dispose();
	});

	test("accepts settled captured work after immediate retention eviction", async () => {
		const manager = new AsyncJobManager({ onJobComplete: async () => {}, retentionMs: 0 });
		registerCooperativeSubagent(manager, "evicted-running", "owner-a");
		const lease = manager.beginOwnerSubagentShutdown("owner-a")!;
		const proof = await manager.cancelAndProveOwnerSubagents(lease, { timeoutMs: 100 });

		expect(proof).toMatchObject({ confirmed: true, terminalIds: ["evicted-running"], unresolvedIds: [] });
		manager.finishOwnerSubagentShutdown(lease, "release");
		await manager.dispose();
	});

	test("captures a cancelled but unsettled metadata job and requires its canonical record", async () => {
		const manager = makeManager();
		const gate = Promise.withResolvers<void>();
		const jobId = manager.register(
			"task",
			"cancelling",
			async (): Promise<string> => {
				await gate.promise;
				return "late";
			},
			{
				ownerId: "owner-a",
				metadata: { subagent: { id: "cancelling", agent: "executor", agentSource: "bundled" } },
			},
		);
		manager.cancel(jobId, { ownerId: "owner-a" });
		const lease = manager.beginOwnerSubagentShutdown("owner-a")!;
		expect(lease.targets).toEqual([{ subagentId: "cancelling", jobId, source: "metadata_job" }]);
		const proof = await manager.cancelAndProveOwnerSubagents(lease, { timeoutMs: 0 });
		expect(proof).toMatchObject({ confirmed: false, unresolvedIds: ["cancelling"] });
		manager.finishOwnerSubagentShutdown(lease, "release");
		gate.resolve();
		await manager.waitForAll();
		await manager.dispose();
	});

	test("fails missing terminal evidence when a metadata job settles without a canonical record", async () => {
		const manager = makeManager();
		const jobId = manager.register(
			"task",
			"unrecorded",
			async ({ signal }): Promise<string> => {
				await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
				return "cancelled";
			},
			{
				ownerId: "owner-a",
				metadata: { subagent: { id: "unrecorded", agent: "executor", agentSource: "bundled" } },
			},
		);
		const lease = manager.beginOwnerSubagentShutdown("owner-a")!;
		expect(lease.targets[0]?.jobId).toBe(jobId);
		const proof = await manager.cancelAndProveOwnerSubagents(lease, { timeoutMs: 100 });
		expect(proof).toMatchObject({
			confirmed: false,
			reason: "missing_terminal_evidence",
			unresolvedIds: ["unrecorded"],
		});
		manager.finishOwnerSubagentShutdown(lease, "release");
		await manager.dispose();
	});

	test("treats every captured target as unresolved after lease loss", async () => {
		const manager = makeManager();
		registerCooperativeSubagent(manager, "owned", "owner-a");
		const lease = manager.beginOwnerSubagentShutdown("owner-a")!;
		manager.finishOwnerSubagentShutdown(lease, "release");
		await expect(manager.cancelAndProveOwnerSubagents(lease)).resolves.toMatchObject({
			confirmed: false,
			reason: "lease_lost",
			unresolvedIds: ["owned"],
		});
		await manager.dispose();
	});
	test("fails closed for mixed cooperative and noncooperative children", async () => {
		const manager = makeManager();
		registerCooperativeSubagent(manager, "cooperative", "owner-a");
		const gate = Promise.withResolvers<void>();
		const stuckJobId = manager.register(
			"task",
			"stuck",
			async (): Promise<string> => {
				await gate.promise;
				return "late";
			},
			{
				ownerId: "owner-a",
				metadata: { subagent: { id: "stuck", agent: "executor", agentSource: "bundled" } },
			},
		);
		manager.registerSubagentRecord({
			subagentId: "stuck",
			ownerId: "owner-a",
			currentJobId: stuckJobId,
			historicalJobIds: [],
			status: "running",
			sessionFile: "/tmp/stuck.jsonl",
			resumable: true,
		});
		const lease = manager.beginOwnerSubagentShutdown("owner-a")!;
		const proof = await manager.cancelAndProveOwnerSubagents(lease, { timeoutMs: 50 });
		expect(proof).toMatchObject({ confirmed: false, unresolvedIds: ["stuck"] });
		expect(proof.terminalIds).toEqual(["cooperative"]);
		manager.finishOwnerSubagentShutdown(lease, "release");
		gate.resolve();
		await manager.waitForAll();
		await manager.dispose();
	});
});
