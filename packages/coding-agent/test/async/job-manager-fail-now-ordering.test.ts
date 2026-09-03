import { describe, expect, test } from "bun:test";
import { AsyncJobManager } from "@gajae-code/coding-agent/async/job-manager";

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await Bun.sleep(5);
	}
	throw new Error("waitFor timed out");
}

describe("AsyncJobManager.failNow", () => {
	// An externally owned wait can fail while its owner tears down. cancel() marks
	// the job cancelled and the cancelled path enqueues NO delivery, so the failure
	// would never become visible. failNow both fails and delivers, synchronously.
	test("fails a running job and delivers that failure", async () => {
		const delivered: Array<{ jobId: string; text: string }> = [];
		const manager = new AsyncJobManager({
			retentionMs: 60_000,
			onJobComplete: async (jobId, text) => {
				delivered.push({ jobId, text });
			},
		});
		try {
			const gate = Promise.withResolvers<string>();
			const jobId = manager.register("bash", "remote", async () => gate.promise, { id: "bridge-1" });
			const generation = manager.getJob(jobId)?.generation ?? "";

			expect(manager.failNow(jobId, generation, "client terminal disconnected")).toBe(true);
			// Synchronous: the state flip is already observable.
			expect(manager.getJob(jobId)?.status).toBe("failed");
			expect(manager.getJob(jobId)?.errorText).toBe("client terminal disconnected");

			await waitFor(() => delivered.length === 1);
			expect(delivered[0]).toEqual({ jobId, text: "client terminal disconnected" });

			// The runner settling later must not publish or deliver a second time.
			gate.resolve("late runner result");
			await manager.waitForAll();
			await Bun.sleep(50);
			expect(delivered).toHaveLength(1);
			expect(manager.getJob(jobId)?.status).toBe("failed");
		} finally {
			await manager.dispose({ timeoutMs: 250 });
		}
	});

	test("is idempotent and refuses a non-running or mismatched job", async () => {
		const delivered: string[] = [];
		const manager = new AsyncJobManager({
			retentionMs: 60_000,
			onJobComplete: async (_jobId, text) => {
				delivered.push(text);
			},
		});
		try {
			const gate = Promise.withResolvers<string>();
			const jobId = manager.register("bash", "remote", async () => gate.promise, { id: "bridge-2" });
			const generation = manager.getJob(jobId)?.generation ?? "";

			expect(manager.failNow(jobId, generation, "first")).toBe(true);
			expect(manager.failNow(jobId, generation, "second")).toBe(false);
			expect(manager.failNow(jobId, "other-generation", "third")).toBe(false);
			expect(manager.failNow("no-such-job", generation, "fourth")).toBe(false);

			await waitFor(() => delivered.length === 1);
			expect(delivered).toEqual(["first"]);

			// A failed job is no longer cancellable, so teardown cannot rewrite the
			// visible failure into a cancellation that delivers nothing.
			expect(manager.cancel(jobId)).toBe(false);
			expect(manager.getJob(jobId)?.status).toBe("failed");

			gate.resolve("late");
			await manager.waitForAll();
		} finally {
			await manager.dispose({ timeoutMs: 250 });
		}
	});

	// The reorder's payoff: dispose used to mark itself disposed BEFORE running
	// owner cleanups, which made the delivery loop a no-op, so a failure a cleanup
	// settled through failNow sat in the queue and vanished.
	test("delivers a failure settled by an owner cleanup during dispose", async () => {
		const delivered: string[] = [];
		const manager = new AsyncJobManager({
			retentionMs: 60_000,
			onJobComplete: async (_jobId, text) => {
				delivered.push(text);
			},
		});
		const gate = Promise.withResolvers<string>();
		const jobId = manager.register("bash", "remote", async () => gate.promise, {
			id: "bridge-3",
			ownerId: "0-Main",
		});
		const generation = manager.getJob(jobId)?.generation ?? "";
		manager.registerOwnerCleanup("0-Main", () => {
			manager.failNow(jobId, generation, "owner teardown killed the terminal");
		});

		gate.resolve("unused");
		await manager.dispose({ timeoutMs: 2_000 });

		expect(delivered).toEqual(["owner teardown killed the terminal"]);
	});

	test("drains cleanup-triggered failure before clearing delivery state", async () => {
		const deliveryStarted = Promise.withResolvers<void>();
		const releaseDelivery = Promise.withResolvers<void>();
		const delivered: string[] = [];
		const manager = new AsyncJobManager({
			retentionMs: 60_000,
			onJobComplete: async (_jobId, text) => {
				deliveryStarted.resolve();
				await releaseDelivery.promise;
				delivered.push(text);
			},
		});
		const gate = Promise.withResolvers<string>();
		const jobId = manager.register("bash", "remote", async () => gate.promise, {
			id: "bridge-4",
			ownerId: "0-Main",
		});
		const generation = manager.getJob(jobId)?.generation ?? "";
		manager.registerOwnerCleanup("0-Main", () => {
			manager.failNow(jobId, generation, "cleanup failure");
		});

		const disposal = manager.dispose({ timeoutMs: 2_000 });
		await deliveryStarted.promise;
		releaseDelivery.resolve();
		gate.resolve("late runner result");

		expect(await disposal).toBe(true);
		expect(delivered).toEqual(["cleanup failure"]);
	});

	test("retains a failNow runner that outlives the disposal deadline", async () => {
		const releaseRunner = Promise.withResolvers<void>();
		let runnerEffects = 0;
		const manager = new AsyncJobManager({ onJobComplete: async () => {} });
		const jobId = manager.register(
			"bash",
			"held remote",
			async () => {
				await releaseRunner.promise;
				runnerEffects += 1;
				return "late runner result";
			},
			{ id: "bridge-held-runner", ownerId: "0-Main" },
		);
		const generation = manager.getJob(jobId)?.generation ?? "";
		manager.registerOwnerCleanup("0-Main", () => {
			manager.failNow(jobId, generation, "cleanup failure");
		});

		expect(await manager.dispose({ timeoutMs: 30 })).toBe(false);
		expect(runnerEffects).toBe(0);
		releaseRunner.resolve();
		await manager.awaitRetainedDisposalCompletion();
		expect(runnerEffects).toBe(1);
	});

	test("retains an in-flight delivery callback that outlives the disposal deadline", async () => {
		const deliveryStarted = Promise.withResolvers<void>();
		const releaseDelivery = Promise.withResolvers<void>();
		let deliveryEffects = 0;
		const manager = new AsyncJobManager({
			onJobComplete: async () => {
				deliveryStarted.resolve();
				await releaseDelivery.promise;
				deliveryEffects += 1;
			},
		});
		manager.register("bash", "held delivery", async () => "done", { id: "bridge-held-delivery" });
		await deliveryStarted.promise;

		expect(await manager.dispose({ timeoutMs: 30 })).toBe(false);
		expect(deliveryEffects).toBe(0);
		releaseDelivery.resolve();
		await manager.awaitRetainedDisposalCompletion();
		expect(deliveryEffects).toBe(1);
	});

	test("retries cleanup-triggered delivery failures before dead-lettering", async () => {
		let attempts = 0;
		const manager = new AsyncJobManager({
			retentionMs: 60_000,
			onJobComplete: async () => {
				attempts += 1;
				throw new Error("delivery unavailable");
			},
		});
		const gate = Promise.withResolvers<string>();
		const jobId = manager.register("bash", "remote", async () => gate.promise, {
			id: "bridge-retry",
			ownerId: "0-Main",
		});
		const generation = manager.getJob(jobId)?.generation ?? "";
		manager.registerOwnerCleanup("0-Main", () => {
			manager.failNow(jobId, generation, "cleanup failure");
		});

		const disposal = manager.dispose({ timeoutMs: 3_000 });
		gate.resolve("late runner result");

		expect(await disposal).toBe(true);
		expect(attempts).toBe(3);
		expect(manager.getLastDisposeDiagnostics().deliveriesDrained).toBe(true);
	});

	test("retries a pre-disposal delivery failure while disposal drains", async () => {
		const deliveryStarted = Promise.withResolvers<void>();
		const releaseDelivery = Promise.withResolvers<void>();
		let attempts = 0;
		const delivered: string[] = [];
		const manager = new AsyncJobManager({
			retentionMs: 60_000,
			onJobComplete: async (_jobId, text) => {
				attempts += 1;
				if (attempts === 1) {
					deliveryStarted.resolve();
					await releaseDelivery.promise;
					throw new Error("pre-disposal delivery unavailable");
				}
				delivered.push(text);
			},
		});
		manager.register("bash", "remote", async () => "completion", { id: "pre-disposal" });

		await deliveryStarted.promise;
		const disposal = manager.dispose({ timeoutMs: 3_000 });
		releaseDelivery.resolve();

		expect(await disposal).toBe(true);
		expect(attempts).toBe(2);
		expect(delivered).toEqual(["completion"]);
		expect(manager.getLastDisposeDiagnostics().deliveriesDrained).toBe(true);
	});

	test("drains a cleanup failure while a final retry overlaps disposal", async () => {
		const firstAttemptStarted = Promise.withResolvers<void>();
		const releaseFirstAttempt = Promise.withResolvers<void>();
		const secondAttemptStarted = Promise.withResolvers<void>();
		let attempts = 0;
		const delivered: string[] = [];
		const manager = new AsyncJobManager({
			retentionMs: 60_000,
			onJobComplete: async (_jobId, text) => {
				attempts += 1;
				if (attempts === 1) {
					firstAttemptStarted.resolve();
					await releaseFirstAttempt.promise;
					throw new Error("first cleanup receipt attempt failed");
				}
				secondAttemptStarted.resolve();
				delivered.push(text);
			},
		});
		const gate = Promise.withResolvers<string>();
		const jobId = manager.register("bash", "remote", () => gate.promise, {
			id: "bridge-final-retry",
			ownerId: "0-Main",
		});
		const generation = manager.getJob(jobId)?.generation ?? "";
		manager.registerOwnerCleanup("0-Main", () => {
			manager.failNow(jobId, generation, "cleanup failure");
		});

		const disposal = manager.dispose({ timeoutMs: 3_000 });
		await firstAttemptStarted.promise;
		releaseFirstAttempt.resolve();
		await secondAttemptStarted.promise;
		gate.resolve("late runner result");

		expect(await disposal).toBe(true);
		expect(attempts).toBe(2);
		expect(delivered).toEqual(["cleanup failure"]);
	});

	test("closes registration while owner cleanups run during dispose", async () => {
		const manager = new AsyncJobManager({ retentionMs: 60_000, onJobComplete: async () => {} });
		let registerDuringCleanup: string | undefined;
		manager.registerOwnerCleanup("0-Main", () => {
			try {
				manager.register("bash", "late", async () => "nope", { id: "late-job", ownerId: "0-Main" });
				registerDuringCleanup = "allowed";
			} catch (error) {
				registerDuringCleanup = error instanceof Error ? error.message : String(error);
			}
		});

		await manager.dispose({ timeoutMs: 500 });

		// Registration is refused, which is the protection the old ordering got from
		// setting #disposed first -- kept here without disabling delivery.
		expect(registerDuringCleanup).toContain("shutting down");
	});
});
