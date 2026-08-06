import { describe, expect, spyOn, test } from "bun:test";
import { AsyncJobManager } from "@gajae-code/coding-agent/async/job-manager";

describe("AsyncJobManager", () => {
	test("forwards progress updates and delivers completion", async () => {
		const progressEvents: Array<{ text: string; details?: Record<string, unknown> }> = [];
		const completions: Array<{ jobId: string; text: string }> = [];
		const manager = new AsyncJobManager({
			onJobComplete: async (jobId, text) => {
				completions.push({ jobId, text });
			},
		});

		const jobId = manager.register(
			"bash",
			"echo hi",
			async ({ reportProgress }) => {
				await reportProgress("running step", { async: { state: "running" } });
				return "final output";
			},
			{
				onProgress: async (text, details) => {
					progressEvents.push({ text, details });
				},
			},
		);

		await manager.waitForAll();
		await manager.drainDeliveries({ timeoutMs: 2_000 });

		expect(progressEvents).toEqual([{ text: "running step", details: { async: { state: "running" } } }]);
		expect(completions).toEqual([{ jobId, text: "final output" }]);
		expect(manager.getJob(jobId)?.status).toBe("completed");
	});

	test("swallows progress callback errors without failing the job", async () => {
		const completions: Array<{ jobId: string; text: string }> = [];
		const manager = new AsyncJobManager({
			onJobComplete: async (jobId, text) => {
				completions.push({ jobId, text });
			},
		});

		const jobId = manager.register(
			"task",
			"agent task",
			async ({ reportProgress }) => {
				await reportProgress("subagent started");
				return "task done";
			},
			{
				onProgress: async () => {
					throw new Error("progress renderer exploded");
				},
			},
		);

		await manager.waitForAll();
		await manager.drainDeliveries({ timeoutMs: 2_000 });

		expect(completions).toEqual([{ jobId, text: "task done" }]);
		expect(manager.getJob(jobId)?.status).toBe("completed");
	});

	test("delivers error text when run fails", async () => {
		const completions: Array<{ jobId: string; text: string }> = [];
		const manager = new AsyncJobManager({
			onJobComplete: async (jobId, text) => {
				completions.push({ jobId, text });
			},
		});

		const jobId = manager.register("bash", "bad command", async () => {
			throw new Error("command failed");
		});

		await manager.waitForAll();
		await manager.drainDeliveries({ timeoutMs: 2_000 });

		expect(completions).toEqual([{ jobId, text: "command failed" }]);
		expect(manager.getJob(jobId)?.status).toBe("failed");
		expect(manager.getJob(jobId)?.errorText).toBe("command failed");
	});

	test("cancels a running job by id", async () => {
		const completions: Array<{ jobId: string; text: string }> = [];
		const manager = new AsyncJobManager({
			onJobComplete: async (jobId, text) => {
				completions.push({ jobId, text });
			},
		});

		const jobId = manager.register("bash", "sleep", async ({ signal }) => {
			await new Promise<never>((_resolve, reject) => {
				signal.addEventListener(
					"abort",
					() => {
						reject(new Error("aborted"));
					},
					{ once: true },
				);
			});
			throw new Error("unreachable");
		});

		expect(manager.cancel(jobId)).toBe(true);
		expect(manager.cancel(jobId)).toBe(false);

		await manager.waitForAll();
		await manager.drainDeliveries({ timeoutMs: 2_000 });

		expect(manager.getJob(jobId)?.status).toBe("cancelled");
		expect(completions).toHaveLength(0);
	});

	test("enforces maxRunningJobs cap", () => {
		const manager = new AsyncJobManager({
			maxRunningJobs: 1,
			onJobComplete: async () => {},
		});

		const firstJobId = manager.register("bash", "first", async ({ signal }) => {
			await new Promise<void>(resolve => {
				signal.addEventListener("abort", () => resolve(), { once: true });
			});
			return "done";
		});

		expect(() =>
			manager.register("bash", "second", async () => {
				return "second";
			}),
		).toThrow(/Background job limit reached/);

		manager.cancel(firstJobId);
	});

	test("evicts completed jobs after retention period", async () => {
		const manager = new AsyncJobManager({
			retentionMs: 25,
			onJobComplete: async () => {},
		});

		const jobId = manager.register("task", "short", async () => "done");
		await manager.waitForAll();
		await manager.drainDeliveries({ timeoutMs: 2_000 });

		expect(manager.getJob(jobId)?.status).toBe("completed");
		await Bun.sleep(60);
		expect(manager.getJob(jobId)).toBeUndefined();
	});

	test("cancelAll does not clear retention timers for already completed jobs", async () => {
		const manager = new AsyncJobManager({
			retentionMs: 30,
			onJobComplete: async () => {},
		});

		const completedJobId = manager.register("task", "completed", async () => "done");
		const runningJobId = manager.register("bash", "running", async ({ signal }) => {
			await new Promise<void>(resolve => {
				signal.addEventListener("abort", () => resolve(), { once: true });
			});
			throw new Error("aborted");
		});

		const completedDeadline = Date.now() + 2_000;
		while (manager.getJob(completedJobId)?.status === "running") {
			if (Date.now() >= completedDeadline) throw new Error("Timed out waiting for completed job");
			await Bun.sleep(5);
		}
		manager.cancelAll();
		await manager.waitForAll();
		await manager.drainDeliveries({ timeoutMs: 2_000 });

		expect(manager.getJob(completedJobId)?.status).toBe("completed");
		expect(manager.getJob(runningJobId)?.status).toBe("cancelled");

		await Bun.sleep(80);
		expect(manager.getJob(completedJobId)).toBeUndefined();
		expect(manager.getJob(runningJobId)).toBeUndefined();
	});

	test("acknowledgeDeliveries suppresses pending retries for completed jobs", async () => {
		let attempts = 0;
		const manager = new AsyncJobManager({
			onJobComplete: async () => {
				attempts += 1;
				throw new Error("delivery failed");
			},
		});

		const jobId = manager.register("task", "awaited-job", async () => "done");
		await manager.waitForAll();

		const firstAttemptDeadline = Date.now() + 2_000;
		while (attempts === 0) {
			if (Date.now() >= firstAttemptDeadline) throw new Error("Timed out waiting for first delivery attempt");
			await Bun.sleep(5);
		}

		expect(manager.hasPendingDeliveries()).toBe(true);
		const removed = manager.acknowledgeDeliveries([jobId]);
		expect(removed).toBeGreaterThanOrEqual(1);

		const drained = await manager.drainDeliveries({ timeoutMs: 200 });
		expect(drained).toBe(true);
		expect(manager.hasPendingDeliveries()).toBe(false);

		const attemptsAfterAck = attempts;
		await Bun.sleep(700);
		expect(attempts).toBe(attemptsAfterAck);
	});

	test("dispose clears jobs and pending deliveries", async () => {
		const manager = new AsyncJobManager({
			onJobComplete: async () => {
				throw new Error("delivery failed");
			},
		});

		manager.register("bash", "will-complete", async () => "output");
		await manager.waitForAll();
		expect(manager.hasPendingDeliveries()).toBe(true);

		const drained = await manager.dispose({ timeoutMs: 25 });
		expect(drained).toBe(false);
		expect(manager.getAllJobs()).toHaveLength(0);
		expect(manager.hasPendingDeliveries()).toBe(false);
	});

	test("scoped delivery drain returns once matching owner deliveries finish", async () => {
		let mainJobId = "";
		let releaseMainDelivery = (): void => {};
		let notifyMainDeliveryStarted = (): void => {};
		const mainDeliveryStarted = new Promise<void>(resolve => {
			notifyMainDeliveryStarted = resolve;
		});
		const mainDeliveryReleased = new Promise<void>(resolve => {
			releaseMainDelivery = resolve;
		});
		const subagentCompletions: Array<{ jobId: string; text: string }> = [];
		const manager = new AsyncJobManager({
			retentionMs: 0,
			onJobComplete: async (jobId, text) => {
				if (jobId === mainJobId) {
					notifyMainDeliveryStarted();
					await mainDeliveryReleased;
					return;
				}
				subagentCompletions.push({ jobId, text });
			},
		});

		mainJobId = manager.register("task", "main job", async () => "main result", { ownerId: "0-Main" });
		const targetJobId = manager.register("task", "subagent job", async () => "subagent result", {
			ownerId: "3-AuthLoader",
		});
		await manager.waitForAll();
		await mainDeliveryStarted;

		expect(manager.hasPendingDeliveries({ ownerId: "0-Main" })).toBe(true);
		const drained = await manager.drainDeliveries({ timeoutMs: 50, filter: { ownerId: "3-AuthLoader" } });

		expect(drained).toBe(true);
		expect(subagentCompletions).toEqual([{ jobId: targetJobId, text: "subagent result" }]);
		expect(manager.hasPendingDeliveries({ ownerId: "3-AuthLoader" })).toBe(false);

		expect(manager.acknowledgeDeliveries([mainJobId])).toBe(0);
		expect(manager.hasPendingDeliveries({ ownerId: "0-Main" })).toBe(false);
		releaseMainDelivery();
		await Bun.sleep(0);
	});

	test("scoped delivery drain times out while a matching delivery callback is in flight", async () => {
		let mainJobId = "";
		let targetJobId = "";
		let releaseMainDelivery = (): void => {};
		let notifyMainDeliveryStarted = (): void => {};
		let releaseTargetDelivery = (): void => {};
		let notifyTargetDeliveryStarted = (): void => {};
		const mainDeliveryStarted = new Promise<void>(resolve => {
			notifyMainDeliveryStarted = resolve;
		});
		const mainDeliveryReleased = new Promise<void>(resolve => {
			releaseMainDelivery = resolve;
		});
		const targetDeliveryStarted = new Promise<void>(resolve => {
			notifyTargetDeliveryStarted = resolve;
		});
		const targetDeliveryReleased = new Promise<void>(resolve => {
			releaseTargetDelivery = resolve;
		});
		const completions: string[] = [];
		const manager = new AsyncJobManager({
			onJobComplete: async jobId => {
				if (jobId === mainJobId) {
					notifyMainDeliveryStarted();
					await mainDeliveryReleased;
					return;
				}
				if (jobId === targetJobId) {
					notifyTargetDeliveryStarted();
					await targetDeliveryReleased;
					completions.push(jobId);
				}
			},
		});

		mainJobId = manager.register("task", "main job", async () => "main result", { ownerId: "0-Main" });
		targetJobId = manager.register("task", "subagent job", async () => "subagent result", {
			ownerId: "3-AuthLoader",
		});
		await manager.waitForAll();
		await mainDeliveryStarted;

		const timedOut = await manager.drainDeliveries({ timeoutMs: 10, filter: { ownerId: "3-AuthLoader" } });
		await targetDeliveryStarted;

		expect(timedOut).toBe(false);
		expect(manager.hasPendingDeliveries({ ownerId: "3-AuthLoader" })).toBe(true);
		expect(completions).toEqual([]);

		releaseTargetDelivery();
		const drained = await manager.drainDeliveries({ timeoutMs: 200, filter: { ownerId: "3-AuthLoader" } });
		expect(drained).toBe(true);
		expect(completions).toEqual([targetJobId]);

		releaseMainDelivery();
		expect(await manager.drainDeliveries({ timeoutMs: 200 })).toBe(true);
	});

	test("cancelAll with ownerId only cancels matching jobs", async () => {
		const manager = new AsyncJobManager({
			onJobComplete: async () => {},
		});

		const hold = (signal: AbortSignal) =>
			new Promise<void>(resolve => {
				signal.addEventListener("abort", () => resolve(), { once: true });
			});

		const parentJobId = manager.register(
			"bash",
			"parent-job",
			async ({ signal }) => {
				await hold(signal);
				return "parent-cancelled";
			},
			{ ownerId: "0-Main" },
		);
		const subagentJobId = manager.register(
			"bash",
			"subagent-job",
			async ({ signal }) => {
				await hold(signal);
				return "subagent-cancelled";
			},
			{ ownerId: "3-AuthLoader" },
		);
		manager.registerSubagentRecord({
			subagentId: "3-AuthLoader",
			ownerId: "3-AuthLoader",
			currentJobId: subagentJobId,
			historicalJobIds: [],
			status: "running",
			sessionFile: null,
			resumable: false,
		});

		manager.cancelAll({ ownerId: "3-AuthLoader" });

		expect(manager.getJob(parentJobId)?.status).toBe("running");
		expect(manager.getJob(subagentJobId)?.status).toBe("cancelled");
		expect(manager.getSubagentRecord("3-AuthLoader")?.status).toBe("cancelled");

		// Filtered query mirrors filtered cancel.
		expect(manager.getRunningJobs({ ownerId: "0-Main" }).map(j => j.id)).toEqual([parentJobId]);
		expect(manager.getRunningJobs({ ownerId: "3-AuthLoader" })).toEqual([]);
		expect(manager.getAllJobs({ ownerId: "0-Main" }).map(j => j.id)).toEqual([parentJobId]);

		// Unscoped cancelAll still cleans up everything.
		manager.cancelAll();
		await manager.waitForAll();
		expect(manager.getJob(parentJobId)?.status).toBe("cancelled");
	});
	test("updateSubagentModel preserves fields omitted from a partial patch", () => {
		const manager = new AsyncJobManager({ onJobComplete: async () => {} });
		const jobId = manager.register("task", "fast subagent", async () => "done", { ownerId: "0-Main" });
		manager.registerSubagentRecord({
			subagentId: "0-Fast",
			ownerId: "0-Main",
			currentJobId: jobId,
			historicalJobIds: [],
			status: "running",
			sessionFile: null,
			resumable: false,
		});

		manager.updateSubagentModel("0-Fast", {
			requestedModel: "anthropic/claude-opus-4-5",
			effectiveModel: "anthropic/claude-sonnet-4-5",
			modelFellBack: true,
			fastMode: true,
		});
		expect(manager.getSubagentRecord("0-Fast")).toMatchObject({
			requestedModel: "anthropic/claude-opus-4-5",
			effectiveModel: "anthropic/claude-sonnet-4-5",
			modelFellBack: true,
			fastMode: true,
		});

		// A narrow fast-mode patch must not erase the model identity recorded above;
		// unconditional assignment used to blank all three of the omitted fields.
		manager.updateSubagentModel("0-Fast", { fastMode: false });
		expect(manager.getSubagentRecord("0-Fast")).toMatchObject({
			requestedModel: "anthropic/claude-opus-4-5",
			effectiveModel: "anthropic/claude-sonnet-4-5",
			modelFellBack: true,
			fastMode: false,
		});

		manager.cancelAll();
	});
	test("retention-zero eviction runs onEvict and records a monitor tombstone", async () => {
		let evictCount = 0;
		const manager = new AsyncJobManager({ retentionMs: 0, onJobComplete: async () => {} });
		const jobId = manager.register("bash", "monitor", async () => "done", {
			ownerId: "0-Test",
			metadata: { monitor: true },
			lifecycle: {
				onEvict: () => {
					evictCount += 1;
				},
			},
		});

		await manager.waitForAll();

		expect(manager.getJob(jobId)).toBeUndefined();
		expect(evictCount).toBe(1);
		expect(manager.getMonitorTombstone(jobId, { ownerId: "0-Test" })?.jobId).toBe(jobId);
		expect(manager.getMonitorTombstone(jobId, { ownerId: "other" })).toBeUndefined();
	});

	test("eviction sweeps expired monitor tombstones", async () => {
		const clock = spyOn(Date, "now").mockReturnValue(0);
		const manager = new AsyncJobManager({ retentionMs: 0, onJobComplete: async () => {} });
		try {
			const expiredJobId = manager.register("bash", "expired monitor", async () => "done", {
				metadata: { monitor: true },
			});
			await manager.waitForAll();
			expect(manager.getMonitorTombstone(expiredJobId)?.expiresAt).toBe(5 * 60_000);

			clock.mockReturnValue(5 * 60_000 + 1);
			manager.register("bash", "new monitor", async () => "done", {
				id: "new-monitor",
				metadata: { monitor: true },
			});
			await manager.waitForAll();

			expect(manager.getMonitorTombstone(expiredJobId)).toBeUndefined();
		} finally {
			clock.mockRestore();
			await manager.dispose();
		}
	});

	test("purgeMonitorTombstone after eviction returns found and runs purge once", async () => {
		let evictCount = 0;
		const manager = new AsyncJobManager({ retentionMs: 0, onJobComplete: async () => {} });
		const jobId = manager.register("bash", "monitor", async () => "done", {
			ownerId: "0-Test",
			metadata: { monitor: true },
			lifecycle: {
				onEvict: () => {
					evictCount += 1;
				},
			},
		});

		await manager.waitForAll();
		expect(evictCount).toBe(1);
		expect(manager.purgeMonitorTombstone(jobId, { ownerId: "0-Test" })).toEqual({ found: true, status: "completed" });
		expect(evictCount).toBe(2);
		expect(manager.purgeMonitorTombstone(jobId, { ownerId: "0-Test" })).toEqual({ found: false });
		expect(evictCount).toBe(2);
	});

	test("tombstone purge uses the dedicated onTombstonePurge hook, not the evict phase", async () => {
		let evictCount = 0;
		let tombstonePurgeCount = 0;
		const manager = new AsyncJobManager({ retentionMs: 0, onJobComplete: async () => {} });
		const jobId = manager.register("bash", "monitor", async () => "done", {
			ownerId: "0-Test",
			metadata: { monitor: true },
			lifecycle: {
				onEvict: () => {
					evictCount += 1;
				},
				onTombstonePurge: () => {
					tombstonePurgeCount += 1;
				},
			},
		});

		await manager.waitForAll();
		expect(evictCount).toBe(1);
		expect(tombstonePurgeCount).toBe(0);
		expect(manager.purgeMonitorTombstone(jobId, { ownerId: "0-Test" })).toEqual({ found: true, status: "completed" });
		// Tombstone purge runs the dedicated idempotent hook and does NOT re-run the evict phase.
		expect(tombstonePurgeCount).toBe(1);
		expect(evictCount).toBe(1);
	});

	test("lifecycle hooks fire at most once per phase", async () => {
		const phases: string[] = [];
		const manager = new AsyncJobManager({ retentionMs: 0, onJobComplete: async () => {} });
		const jobId = manager.register(
			"bash",
			"monitor",
			async ({ signal }) => {
				await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
				return "cancelled";
			},
			{
				metadata: { monitor: true },
				lifecycle: {
					onCancel: () => phases.push("cancel"),
					onTerminal: () => phases.push("terminal"),
					onEvict: () => phases.push("evict"),
				},
			},
		);

		expect(manager.cancel(jobId)).toBe(true);
		expect(manager.cancel(jobId)).toBe(false);
		await manager.waitForAll();
		manager.purgeMonitorTombstone(jobId);

		expect(phases.filter(p => p === "cancel")).toHaveLength(1);
		expect(phases.filter(p => p === "terminal")).toHaveLength(1);
		expect(phases.filter(p => p === "evict")).toHaveLength(2);
	});

	test("terminal waits support all/any predicates and idempotent acknowledgement", async () => {
		const manager = new AsyncJobManager({ onJobComplete: async () => {} });
		const first = manager.register("task", "first", async () => "one", { id: "wait-first" });
		const secondGate = Promise.withResolvers<string>();
		const second = manager.register("task", "second", async () => secondGate.promise, { id: "wait-second" });
		await manager.getJob(first)?.promise;

		const targets = [manager.resolveSubagentWaitTarget(first)!, manager.resolveSubagentWaitTarget(second)!];
		const all = manager.subscribeTerminalWait(targets, "all_terminal");
		const any = manager.subscribeTerminalWait(targets, "any_terminal");
		expect(await any.result).toMatchObject({
			outcome: "completed",
			condition: "any_terminal",
			terminalJobIds: [first],
		});
		expect(any.acknowledge()).toEqual({ acknowledged: true, jobIds: [first] });
		expect(any.acknowledge()).toEqual({ acknowledged: false, jobIds: [] });

		secondGate.resolve("two");
		await manager.getJob(second)?.promise;
		expect(await all.result).toMatchObject({
			outcome: "completed",
			condition: "all_terminal",
			terminalJobIds: [first, second],
			pendingJobIds: [],
		});
		expect(all.acknowledge()).toEqual({ acknowledged: true, jobIds: [first, second] });
		await manager.dispose({ timeoutMs: 100 });
	});

	test("closing a terminal wait interrupts observation without mutating child status", async () => {
		const manager = new AsyncJobManager({ onJobComplete: async () => {} });
		const gate = Promise.withResolvers<string>();
		const jobId = manager.register("task", "held", async () => gate.promise, { id: "wait-held" });
		const handle = manager.subscribeTerminalWait([manager.resolveSubagentWaitTarget(jobId)!]);
		handle.close();
		expect(await handle.result).toMatchObject({ outcome: "interrupted", pendingJobIds: [jobId] });
		expect(manager.getJob(jobId)?.status).toBe("running");
		gate.resolve("finished");
		await manager.getJob(jobId)?.promise;
		await manager.dispose({ timeoutMs: 100 });
	});

	test("paused and queued cancellation publish terminal wait evidence", async () => {
		const pausedManager = new AsyncJobManager({ onJobComplete: async () => {} });
		const pausedJobId = pausedManager.register(
			"task",
			"pause",
			async () => ({ kind: "paused", note: "safe boundary" }),
			{ id: "paused-job" },
		);
		pausedManager.registerSubagentRecord({
			subagentId: "paused-subagent",
			ownerId: "0-Main",
			currentJobId: pausedJobId,
			historicalJobIds: [],
			status: "running",
			sessionFile: "/tmp/paused.jsonl",
			resumable: true,
		});
		await pausedManager.getJob(pausedJobId)?.promise;
		const pausedWait = pausedManager.subscribeTerminalWait([
			pausedManager.resolveSubagentWaitTarget("paused-subagent")!,
		]);
		expect(pausedManager.cancelSubagent("paused-subagent", { ownerId: "0-Main" })).toBe(true);
		expect(await pausedWait.result).toMatchObject({ outcome: "completed", terminalJobIds: ["paused-subagent"] });
		await pausedManager.dispose({ timeoutMs: 100 });

		const queuedManager = new AsyncJobManager({ maxRunningJobs: 1, onJobComplete: async () => {} });
		const blockerGate = Promise.withResolvers<void>();
		const blocker = queuedManager.register(
			"task",
			"blocker",
			async () => {
				await blockerGate.promise;
				return "released";
			},
			{ id: "queue-blocker", ownerId: "0-Main" },
		);
		queuedManager.registerSubagentRecord({
			subagentId: "queued-subagent",
			ownerId: "0-Main",
			currentJobId: null,
			historicalJobIds: [],
			status: "completed",
			sessionFile: "/tmp/queued.jsonl",
			resumable: true,
		});
		queuedManager.setResumeRunner(() =>
			queuedManager.register("task", "queued resume", async () => "resumed", { ownerId: "0-Main" }),
		);
		expect(queuedManager.resumeSubagent("queued-subagent", { ownerId: "0-Main" }).queued).toBe(true);
		const queuedWait = queuedManager.subscribeTerminalWait([
			queuedManager.resolveSubagentWaitTarget("queued-subagent")!,
		]);
		expect(queuedManager.cancelSubagent("queued-subagent", { ownerId: "0-Main" })).toBe(true);
		expect(await queuedWait.result).toMatchObject({ outcome: "completed", terminalJobIds: ["queued-subagent"] });
		blockerGate.resolve();
		await queuedManager.getJob(blocker)?.promise;
		await queuedManager.dispose({ timeoutMs: 100 });
	});

	test("rekeyForEndpoint moves the registration across committed session-identity transitions", () => {
		const manager = new AsyncJobManager({ onJobComplete: async () => {} });
		const foreign = new AsyncJobManager({ onJobComplete: async () => {} });
		try {
			AsyncJobManager.registerForEndpoint("session-a", manager);
			expect(AsyncJobManager.endpointIdOf(manager)).toBe("session-a");

			// newSession/switchSession/fork/handoff/branch commit a successor
			// endpoint identity: the manager registration must follow so
			// post-transition lineage bindings resolve (review thread P1).
			expect(
				AsyncJobManager.rekeyForEndpoint("session-a", "session-b", AsyncJobManager.forEndpoint("session-a")),
			).toBe(true);
			expect(AsyncJobManager.endpointIdOf(manager)).toBe("session-b");
			expect(AsyncJobManager.forEndpoint("session-a")).toBeUndefined();
			expect(AsyncJobManager.forEndpoint("session-b")).toBe(manager);

			// A foreign registration under the successor is never clobbered; the
			// rekey reports FAILURE (review thread P1) so the transitioning
			// session aborts/rolls back before retiring predecessor state —
			// leaving this manager under the predecessor while tools resolve
			// the successor to the foreign manager would send jobs to the
			// wrong session and strip owned aborts of their causal set.
			AsyncJobManager.registerForEndpoint("session-c", foreign);
			expect(AsyncJobManager.rekeyForEndpoint("session-b", "session-c", manager)).toBe(false);
			expect(AsyncJobManager.endpointIdOf(manager)).toBe("session-b");
			expect(AsyncJobManager.forEndpoint("session-b")).toBe(manager);
			expect(AsyncJobManager.forEndpoint("session-c")).toBe(foreign);

			// Same-id and unknown-predecessor rekeys are successful no-ops.
			expect(AsyncJobManager.rekeyForEndpoint("session-b", "session-b", manager)).toBe(true);
			expect(AsyncJobManager.endpointIdOf(manager)).toBe("session-b");
			expect(AsyncJobManager.rekeyForEndpoint("unknown", "session-b", manager)).toBe(true);
			expect(AsyncJobManager.endpointIdOf(manager)).toBe("session-b");

			// Disposal: unregisterManager drops every key owned by the manager,
			// including rekeyed successor keys that no longer match the session id.
			AsyncJobManager.unregisterManager(manager);
			expect(AsyncJobManager.forEndpoint("session-b")).toBeUndefined();
			expect(AsyncJobManager.forEndpoint("session-c")).toBe(foreign);
		} finally {
			AsyncJobManager.unregisterManager(manager);
			AsyncJobManager.unregisterManager(foreign);
		}
	});

	test("registerForEndpoint rejects a foreign holder instead of silently replacing it", () => {
		const manager = new AsyncJobManager({ onJobComplete: async () => {} });
		const foreign = new AsyncJobManager({ onJobComplete: async () => {} });
		try {
			expect(AsyncJobManager.registerForEndpoint("session-a", manager)).toBe(true);
			expect(AsyncJobManager.forEndpoint("session-a")).toBe(manager);

			// A second top-level session constructed or resumed under an
			// endpoint id already held by a FOREIGN live manager must not
			// clobber it: the first session's tools would resolve the second
			// manager, letting same-id jobs be queried, registered, or
			// cancelled across sessions and stripping an owned abort of its
			// causal work set (review thread P1).
			expect(AsyncJobManager.registerForEndpoint("session-a", foreign)).toBe(false);
			expect(AsyncJobManager.forEndpoint("session-a")).toBe(manager);
			expect(AsyncJobManager.endpointIdOf(foreign)).toBeUndefined();

			// Same-manager re-registration is a successful no-op.
			expect(AsyncJobManager.registerForEndpoint("session-a", manager)).toBe(true);
			expect(AsyncJobManager.forEndpoint("session-a")).toBe(manager);

			// After the holder is disposed, the endpoint id is free again.
			AsyncJobManager.unregisterManager(manager);
			expect(AsyncJobManager.forEndpoint("session-a")).toBeUndefined();
			expect(AsyncJobManager.registerForEndpoint("session-a", foreign)).toBe(true);
			expect(AsyncJobManager.forEndpoint("session-a")).toBe(foreign);
		} finally {
			AsyncJobManager.unregisterManager(manager);
			AsyncJobManager.unregisterManager(foreign);
		}
	});

	test("resetForTests clears endpoint registrations with the global instance", () => {
		const manager = new AsyncJobManager({ onJobComplete: async () => {} });
		AsyncJobManager.setInstance(manager);
		expect(AsyncJobManager.registerForEndpoint("test-session", manager)).toBe(true);
		expect(AsyncJobManager.forEndpoint("test-session")).toBe(manager);

		AsyncJobManager.resetForTests();

		expect(AsyncJobManager.instance()).toBeUndefined();
		expect(AsyncJobManager.forEndpoint("test-session")).toBeUndefined();
	});
});
