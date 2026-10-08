import { describe, expect, test, vi } from "bun:test";
import { AsyncJobManager } from "@gajae-code/coding-agent/async/job-manager";
import {
	lookupOwnedRegistration,
	registerOwnedRegistration,
	resetTerminalAbortRegistriesForTests,
} from "@gajae-code/coding-agent/session/terminal-abort";
import { logger } from "@gajae-code/utils";
import { JobsObserver } from "../../src/modes/jobs-observer";

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await Bun.sleep(10);
	}
	throw new Error("waitFor timed out");
}

describe("AsyncJobManager delivery reliability", () => {
	test("reentrant drains wait for the enrolled delivery callback", async () => {
		const heldDeliveryStarted = Promise.withResolvers<void>();
		const releaseHeldDelivery = Promise.withResolvers<void>();
		const healthyRun = Promise.withResolvers<string>();
		const delivered: string[] = [];
		let heldJobId = "";
		const drains: {
			unbounded?: Promise<boolean>;
			unboundedOutcome: "pending" | "fulfilled" | "rejected";
			bounded?: Promise<boolean>;
			boundedOutcome: "pending" | "fulfilled" | "timed-out" | "rejected";
		} = { unboundedOutcome: "pending", boundedOutcome: "pending" };
		const manager = new AsyncJobManager({
			onJobComplete: async jobId => {
				if (jobId === heldJobId) {
					heldDeliveryStarted.resolve();
					await releaseHeldDelivery.promise;
				}
				delivered.push(jobId);
			},
		});
		const unsubscribe = manager.onChange(() => {
			const state = manager.getDeliveryState();
			if (drains.unbounded || !state.delivering || !state.pendingJobIds.includes(heldJobId)) return;
			const unbounded = manager.drainDeliveries();
			drains.unbounded = unbounded;
			void unbounded.then(
				() => {
					drains.unboundedOutcome = "fulfilled";
				},
				() => {
					drains.unboundedOutcome = "rejected";
				},
			);
			const bounded = manager.drainDeliveries({ timeoutMs: 0 });
			drains.bounded = bounded;
			void bounded.then(
				completed => {
					drains.boundedOutcome = completed ? "fulfilled" : "timed-out";
				},
				() => {
					drains.boundedOutcome = "rejected";
				},
			);
		});

		let heldProducer: Promise<void> | undefined;
		let healthyProducer: Promise<void> | undefined;
		let primaryFailure: unknown;
		let hasPrimaryFailure = false;
		const cleanupFailures: unknown[] = [];
		try {
			heldJobId = manager.register("bash", "held delivery", async () => "held", { id: "held-delivery" });
			const heldJob = manager.getJob(heldJobId);
			if (!heldJob) throw new Error("expected held delivery job");
			heldProducer = heldJob.promise;
			const healthyJobId = manager.register("bash", "independent healthy job", () => healthyRun.promise);
			const healthyJob = manager.getJob(healthyJobId);
			if (!healthyJob) throw new Error("expected independent healthy job");
			healthyProducer = healthyJob.promise;

			await heldDeliveryStarted.promise;
			healthyRun.resolve("healthy");
			await healthyProducer;
			expect(healthyJob.status).toBe("completed");
			const boundedDrain = drains.bounded;
			if (!boundedDrain) throw new Error("change listener did not start the bounded drain");
			const boundedDrainResult = await boundedDrain;
			expect(boundedDrainResult).toBe(false);
			expect(drains.boundedOutcome).toBe("timed-out");
			expect(drains.unbounded).toBeDefined();
			expect(drains.unboundedOutcome).toBe("pending");

			releaseHeldDelivery.resolve();
			const unboundedDrain = drains.unbounded;
			if (!unboundedDrain) throw new Error("change listener did not start the unbounded drain");
			expect(await unboundedDrain).toBe(true);
			expect(drains.unboundedOutcome).toBe("fulfilled");
			expect(delivered).toEqual([heldJobId, healthyJobId]);
		} catch (error) {
			hasPrimaryFailure = true;
			primaryFailure = error;
		} finally {
			releaseHeldDelivery.resolve();
			healthyRun.resolve("cleanup");
			const join = async (operation: Promise<unknown>): Promise<void> => {
				try {
					await operation;
				} catch (error) {
					cleanupFailures.push(error);
				}
			};
			try {
				unsubscribe();
			} catch (error) {
				cleanupFailures.push(error);
			}
			if (heldProducer) await join(heldProducer);
			if (healthyProducer) await join(healthyProducer);
			await join(manager.waitForAll());
			if (drains.unbounded) await join(drains.unbounded);
			if (drains.bounded) await join(drains.bounded);
			await join(
				manager.drainDeliveries({ timeoutMs: 250 }).then(drained => {
					if (!drained) throw new Error("delivery drain did not settle during fixture cleanup");
				}),
			);
			await join(
				manager.dispose({ timeoutMs: 250 }).then(disposed => {
					if (!disposed) throw new Error("manager disposal did not settle during fixture cleanup");
				}),
			);
			await join(manager.awaitRetainedDisposalCompletion());
		}
		if (hasPrimaryFailure) throw primaryFailure;
		if (cleanupFailures.length > 0)
			throw new AggregateError(cleanupFailures, "Failed to settle drain fixture resources.");
	});

	test("bounded disposal retains an unsettled delivery future", async () => {
		const deliveryStarted = Promise.withResolvers<void>();
		const releaseDelivery = Promise.withResolvers<void>();
		const manager = new AsyncJobManager({
			onJobComplete: async () => {
				deliveryStarted.resolve();
				await releaseDelivery.promise;
			},
		});
		let disposePromise: Promise<boolean> | undefined;
		let producerCompletion: Promise<void> | undefined;
		const retainedState: { outcome: "pending" | "fulfilled" | "rejected" } = { outcome: "pending" };
		let retainedCompletion: Promise<void> | undefined;
		let primaryFailure: unknown;
		let hasPrimaryFailure = false;
		const cleanupFailures: unknown[] = [];

		try {
			const jobId = manager.register("bash", "held disposal delivery", async () => "payload");
			const job = manager.getJob(jobId);
			if (!job) throw new Error("expected held delivery job");
			producerCompletion = job.promise;
			await deliveryStarted.promise;
			await producerCompletion;

			disposePromise = manager.dispose({ timeoutMs: 25 });
			expect(await disposePromise).toBe(false);

			retainedCompletion = manager.awaitRetainedDisposalCompletion().then(
				() => {
					retainedState.outcome = "fulfilled";
				},
				() => {
					retainedState.outcome = "rejected";
				},
			);
			expect(retainedState.outcome).toBe("pending");
			releaseDelivery.resolve();
			await retainedCompletion;
			expect(retainedState.outcome).toBe("fulfilled");
		} catch (error) {
			hasPrimaryFailure = true;
			primaryFailure = error;
		} finally {
			releaseDelivery.resolve();
			const join = async (operation: Promise<unknown>): Promise<void> => {
				try {
					await operation;
				} catch (error) {
					cleanupFailures.push(error);
				}
			};
			if (producerCompletion) await join(producerCompletion);
			await join(manager.waitForAll());
			if (disposePromise) await join(disposePromise);
			else
				await join(
					manager.dispose({ timeoutMs: 25 }).then(disposed => {
						if (!disposed) throw new Error("manager disposal did not settle during fixture cleanup");
					}),
				);
			if (!retainedCompletion) {
				retainedCompletion = manager.awaitRetainedDisposalCompletion().then(
					() => {
						retainedState.outcome = "fulfilled";
					},
					() => {
						retainedState.outcome = "rejected";
					},
				);
			}
			await join(retainedCompletion);
		}
		if (hasPrimaryFailure) throw primaryFailure;
		if (cleanupFailures.length > 0)
			throw new AggregateError(cleanupFailures, "Failed to settle disposal fixture resources.");
	});

	// T-R4. `#resolveJobId` auto-allocation used to key only on live-map
	// membership, so a zero-retention eviction let the next job take the same
	// `bg_1`. The recycled record then gave the still-pending old delivery a
	// mismatched generation and it was discarded before `onJobComplete` ran.
	test("does not recycle a job id while one of its deliveries is still pending", async () => {
		const deliveryStarted = Promise.withResolvers<void>();
		const releaseDelivery = Promise.withResolvers<void>();
		const manager = new AsyncJobManager({
			retentionMs: 0,
			onJobComplete: async () => {
				deliveryStarted.resolve();
				await releaseDelivery.promise;
			},
		});

		try {
			const first = manager.register("bash", "first", async () => "first-output");
			await deliveryStarted.promise;

			// Zero retention already evicted the record while its delivery is in flight.
			expect(manager.getJob(first)).toBeUndefined();
			expect(manager.getDeliveryState().queued).toBeGreaterThan(0);

			const second = manager.register("bash", "second", async () => "second-output");
			expect(second).not.toBe(first);

			releaseDelivery.resolve();
			await manager.waitForAll();
		} finally {
			releaseDelivery.resolve();
			await manager.dispose({ timeoutMs: 250 });
		}
	});

	// An explicit preferred id follows the same deterministic suffix policy as a
	// live-id collision, but must also avoid a prior generation whose completion
	// callback is still in flight after zero-retention eviction.
	test("renames a preferred id while its prior delivery is still in flight", async () => {
		const deliveryStarted = Promise.withResolvers<void>();
		const releaseDelivery = Promise.withResolvers<void>();
		const delivered: string[] = [];
		let first = "";
		const manager = new AsyncJobManager({
			retentionMs: 0,
			onJobComplete: async jobId => {
				delivered.push(jobId);
				if (jobId === first) {
					deliveryStarted.resolve();
					await releaseDelivery.promise;
				}
			},
		});

		try {
			first = manager.register("bash", "first", async () => "first-output", { id: "preferred-delivery" });
			await deliveryStarted.promise;

			// The first record is gone, but its completion delivery still owns the id.
			expect(manager.getJob(first)).toBeUndefined();
			expect(manager.getDeliveryState().pendingJobIds).toContain(first);

			const second = manager.register("bash", "second", async () => "second-output", { id: first });
			expect(second).toBe(`${first}-2`);

			releaseDelivery.resolve();
			await manager.waitForAll();
			await waitFor(() => delivered.length === 2);
			expect(delivered).toEqual([first, second]);
		} finally {
			releaseDelivery.resolve();
			await manager.dispose({ timeoutMs: 250 });
		}
	});

	test("does not reuse a suppressed job id after its terminal event expires", async () => {
		const manager = new AsyncJobManager({ retentionMs: 0, onJobComplete: async () => {} });
		const originalNow = Date.now;
		try {
			const originalId = manager.register("task", "suppressed", async () => "done", {
				id: "expired-terminal",
			});
			const target = manager.resolveSubagentWaitTarget(originalId);
			if (!target) throw new Error("expected terminal wait target");
			const wait = manager.subscribeTerminalWait([target], "all_terminal");
			await manager.getJob(originalId)?.promise;
			expect((await wait.result).outcome).toBe("completed");
			expect(wait.acknowledge()).toEqual({ acknowledged: true, jobIds: [originalId] });

			const expiredNow = originalNow() + 300_001;
			vi.spyOn(Date, "now").mockReturnValue(expiredNow);
			// This prunes the terminal event and the retired suppression projection,
			// so the original id is available again.
			manager.getJobsSnapshot();
			const replacementId = manager.register("task", "replacement", async () => "replacement", {
				id: originalId,
			});
			expect(manager.isDeliverySuppressed(originalId)).toBe(false);
			expect(replacementId).toBe(originalId);
		} finally {
			vi.restoreAllMocks();
			await manager.dispose({ timeoutMs: 250 });
		}
	});

	// T-R4, unfolded counterpart: this is the plain `async: true` bash shape (a
	// job whose result is delivered through `onJobComplete`), proving the fix is
	// not specific to folded work.
	test("a pending delivery from an evicted record still arrives after a new job registers", async () => {
		const delivered: string[] = [];
		const deliveryStarted = Promise.withResolvers<void>();
		const releaseDelivery = Promise.withResolvers<void>();
		let first = "";
		const manager = new AsyncJobManager({
			retentionMs: 0,
			onJobComplete: async (jobId, text) => {
				if (jobId === first) {
					deliveryStarted.resolve();
					await releaseDelivery.promise;
				}
				delivered.push(`${jobId}:${text}`);
			},
		});

		try {
			first = manager.register("bash", "first", async () => "first-output");
			await deliveryStarted.promise;

			const second = manager.register("bash", "second", async () => "second-output");
			releaseDelivery.resolve();

			await waitFor(() => delivered.length === 2);
			expect(delivered).toContain(`${first}:first-output`);
			expect(delivered).toContain(`${second}:second-output`);
		} finally {
			releaseDelivery.resolve();
			await manager.dispose({ timeoutMs: 250 });
		}
	});

	// T-R5. The requeue branch used to require a live record with a matching
	// generation, so after a zero-retention eviction a failed callback was never
	// retried and the result vanished with no dead letter.
	test("post-eviction delivery failure retries and delivers the receipt exactly once", async () => {
		const delivered: string[] = [];
		let attempts = 0;
		const manager = new AsyncJobManager({
			retentionMs: 0,
			onJobComplete: async (_jobId, text) => {
				attempts += 1;
				if (attempts === 1) throw new Error("delivery failed once");
				delivered.push(text);
			},
		});

		try {
			const jobId = manager.register("bash", "retried", async () => "receipt-payload");
			await waitFor(() => attempts >= 1);
			expect(manager.getJob(jobId)).toBeUndefined();

			await waitFor(() => delivered.length === 1);
			expect(delivered).toEqual(["receipt-payload"]);

			// Exactly once: no duplicate redelivery after the successful retry.
			await Bun.sleep(150);
			expect(delivered).toEqual(["receipt-payload"]);
		} finally {
			await manager.dispose({ timeoutMs: 250 });
		}
	});

	// T-R5. At the retry cap in that same window the failure must become visible
	// rather than silent, and it must retire the exact owned tuple because this
	// terminal route never injects a message and has no later settlement point.
	test("post-eviction retry-cap failure becomes visible and retires the owned tuple", async () => {
		resetTerminalAbortRegistriesForTests();
		let attempts = 0;
		const manager = new AsyncJobManager({
			retentionMs: 0,
			onJobComplete: async () => {
				attempts += 1;
				throw new Error("delivery always fails");
			},
		});

		try {
			const endpointId = AsyncJobManager.endpointIdOf(manager);
			const jobId = manager.register("bash", "dead-lettered", async () => "lost-payload");
			const generation = manager.getJob(jobId)?.generation ?? jobId;
			registerOwnedRegistration({
				endpointId,
				lineageIdHash: "lineage-hash",
				promptAttemptEpoch: 1,
				endpointGeneration: 1,
				jobId,
				jobGeneration: generation,
			});
			expect(lookupOwnedRegistration(jobId, generation, endpointId)).toBeDefined();

			// Three attempts: ~500ms then ~1000ms of backoff before the cap.
			await waitFor(() => attempts >= 3, 8_000);
			await waitFor(() => manager.getDeliveryState().deadLettered > 0, 2_000);

			expect(manager.getDeliveryState().deadLettered).toBe(1);
			expect(manager.getDeliveryState().queued).toBe(0);
			expect(lookupOwnedRegistration(jobId, generation, endpointId)).toBeUndefined();
		} finally {
			await manager.dispose({ timeoutMs: 250 });
			resetTerminalAbortRegistriesForTests();
		}
	});

	test("live retry-cap dead letter survives terminal job eviction", async () => {
		let attempts = 0;
		const manager = new AsyncJobManager({
			retentionMs: 2_000,
			onJobComplete: async () => {
				attempts += 1;
				throw new Error("delivery always fails while retained");
			},
		});

		try {
			const jobId = manager.register("bash", "retained dead-letter", async () => "lost-payload", {
				metadata: { backgrounded: true },
			});
			const generation = manager.getJob(jobId)?.generation ?? jobId;
			await waitFor(() => attempts >= 3, 8_000);
			await waitFor(() => manager.getJobsSnapshot().deadLettered.length === 1, 2_000);

			const liveDeadLetter = manager.getJobsSnapshot().deadLettered[0];
			const recordedAt = liveDeadLetter.recordedAt;
			expect(liveDeadLetter).toMatchObject({
				jobId,
				generation,
				backgrounded: true,
				attempt: 3,
				lastError: "delivery always fails while retained",
			});
			await Bun.sleep(20);
			expect(manager.getJobsSnapshot().deadLettered[0]?.recordedAt).toBe(recordedAt);

			await waitFor(() => manager.getJob(jobId) === undefined, 4_000);
			const evictedDeadLetter = manager.getJobsSnapshot().deadLettered[0];
			expect(evictedDeadLetter).toMatchObject({
				jobId,
				generation,
				backgrounded: true,
				attempt: 3,
				lastError: "delivery always fails while retained",
			});
		} finally {
			await manager.dispose({ timeoutMs: 250 });
		}
	});

	test("queue-overflow delivery drop preserves evicted dead-letter evidence", async () => {
		const deliveryGate = Promise.withResolvers<void>();
		let deliveryAttempts = 0;
		const manager = new AsyncJobManager({
			maxRunningJobs: 150,
			retentionMs: 0,
			onJobComplete: async () => {
				deliveryAttempts += 1;
				if (deliveryAttempts === 1) await deliveryGate.promise;
			},
		});

		try {
			for (let index = 0; index < 110; index += 1) {
				manager.register("bash", `overflow ${index}`, async () => `payload-${index}`, {
					ownerId: "owner-overflow",
					metadata: { backgrounded: true },
				});
			}
			await waitFor(() => manager.getDeliveryState().deadLettered > 0, 4_000);
			const snapshot = manager.getJobsSnapshot({ ownerId: "owner-overflow" });
			expect(snapshot.deadLettered.length).toBeGreaterThan(0);
			expect(snapshot.deadLettered.every(entry => entry.backgrounded)).toBe(true);
			expect(snapshot.deadLettered.every(entry => entry.ownerId === "owner-overflow")).toBe(true);
			deliveryGate.resolve();
			await manager.waitForAll();
		} finally {
			deliveryGate.resolve();
			await manager.dispose({ timeoutMs: 250 });
		}
	});

	test("dead-letter overflow snapshots keep a stable bucket timestamp", async () => {
		const manager = new AsyncJobManager({
			maxRunningJobs: 150,
			retentionMs: 0,
			onJobComplete: async () => {
				throw new Error("delivery always fails");
			},
		});

		try {
			for (let index = 0; index < 110; index += 1) {
				manager.register("bash", `overflow timestamp ${index}`, async () => `payload-${index}`, {
					ownerId: "owner-overflow-timestamp",
					metadata: { backgrounded: true },
				});
			}
			await waitFor(
				() =>
					manager
						.getJobsSnapshot({ ownerId: "owner-overflow-timestamp" })
						.deadLettered.some(entry => entry.jobId.startsWith("dead-letter-overflow:")),
				8_000,
			);
			const first = manager
				.getJobsSnapshot({ ownerId: "owner-overflow-timestamp" })
				.deadLettered.find(entry => entry.jobId.startsWith("dead-letter-overflow:"));
			const second = manager
				.getJobsSnapshot({ ownerId: "owner-overflow-timestamp" })
				.deadLettered.find(entry => entry.jobId.startsWith("dead-letter-overflow:"));
			expect(first?.recordedAt).toBeDefined();
			expect(second?.recordedAt).toBe(first?.recordedAt);
		} finally {
			await manager.dispose({ timeoutMs: 5_000 });
		}
	});

	test("keeps the newest overflow owner visible after the owner bucket bound", async () => {
		let now = 1_000_000;
		const realNow = Date.now;
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});
		Date.now = () => {
			now += 1_000;
			return now;
		};
		const ownerCount = 3;
		const manager = new AsyncJobManager({
			maxRunningJobs: 70,
			retentionMs: 0,
			maxDeadLetterOverflowOwners: 2,
			onJobComplete: async () => {
				throw new Error("overflow owner delivery failed");
			},
		});

		try {
			for (let ownerIndex = 0; ownerIndex < ownerCount; ownerIndex += 1) {
				const ownerId = `overflow-owner-${ownerIndex}`;
				for (let jobIndex = 0; jobIndex < 65; jobIndex += 1) {
					manager.register("bash", `${ownerId}-${jobIndex}`, async () => "payload", {
						ownerId,
						metadata: { backgrounded: true },
					});
				}
				await Bun.sleep(1_000);
			}
			const latest = manager.getJobsSnapshot({ ownerId: "overflow-owner-2" }).deadLettered;
			expect(latest.some(entry => entry.jobId === "dead-letter-overflow:overflow-owner-2")).toBe(true);
			const observer = new JobsObserver(manager, "overflow-owner-2");
			try {
				expect(observer.getSnapshot().worstState).toBe("failed");
				expect(observer.getSnapshot().failedUnacknowledged).toBe(true);
			} finally {
				observer.dispose();
			}
		} finally {
			await manager.dispose({ timeoutMs: 5_000 });
			Date.now = realNow;
			warnSpy.mockRestore();
			errorSpy.mockRestore();
		}
	});

	test("does not overflow-account retained failures still projected on live jobs", async () => {
		let now = 1_000_000;
		const realNow = Date.now;
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});
		Date.now = () => {
			now += 1_000;
			return now;
		};
		const manager = new AsyncJobManager({
			maxRunningJobs: 60,
			retentionMs: 60_000,
			onJobComplete: async () => {
				throw new Error("retained delivery failed");
			},
		});

		try {
			for (let index = 0; index < 51; index += 1) {
				manager.register("bash", `retained-failure-${index}`, async () => "payload", {
					ownerId: "retained-failure-owner",
					metadata: { backgrounded: true },
				});
			}
			await Bun.sleep(1_000);
			const snapshot = manager.getJobsSnapshot({ ownerId: "retained-failure-owner" });
			expect(snapshot.deadLettered.some(entry => entry.jobId.startsWith("dead-letter-overflow:"))).toBe(false);
			expect(snapshot.jobs.filter(job => job.deliveryState === "failed-visible")).toHaveLength(51);
			const observer = new JobsObserver(manager, "retained-failure-owner");
			try {
				expect(observer.getSnapshot().foldedJobs).toHaveLength(51);
			} finally {
				observer.dispose();
			}
		} finally {
			await manager.dispose({ timeoutMs: 5_000 });
			Date.now = realNow;
			warnSpy.mockRestore();
			errorSpy.mockRestore();
		}
	});

	test("zero-retention snapshot keeps an in-flight evicted delivery visible", async () => {
		const deliveryStarted = Promise.withResolvers<void>();
		const releaseDelivery = Promise.withResolvers<void>();
		const manager = new AsyncJobManager({
			retentionMs: 0,
			onJobComplete: async () => {
				deliveryStarted.resolve();
				await releaseDelivery.promise;
			},
		});

		try {
			const jobId = manager.register("bash", "folded pending delivery", async () => "folded payload", {
				ownerId: "owner-folded",
				metadata: { backgrounded: true },
			});
			const generation = manager.getJob(jobId)?.generation ?? "";
			await deliveryStarted.promise;

			expect(manager.getJob(jobId)).toBeUndefined();
			expect(manager.getJobsSnapshot({ ownerId: "other-owner" }).jobs).toEqual([]);
			expect(manager.getJobsSnapshot({ ownerId: "owner-folded" }).jobs).toContainEqual({
				id: jobId,
				kind: "bash",
				label: "folded pending delivery",
				status: "completed",
				generation,
				backgrounded: true,
				deliveryState: "pending",
			});
		} finally {
			releaseDelivery.resolve();
			await manager.dispose({ timeoutMs: 250 });
		}
	});

	test("late delivery rejection during disposal reaches the retry cap", async () => {
		const deliveryStarted = Promise.withResolvers<void>();
		const releaseDelivery = Promise.withResolvers<void>();
		let attempts = 0;
		const manager = new AsyncJobManager({
			retentionMs: 0,
			onJobComplete: async () => {
				attempts += 1;
				deliveryStarted.resolve();
				await releaseDelivery.promise;
				throw new Error("late delivery rejection");
			},
		});

		let disposePromise: Promise<boolean> | undefined;
		try {
			manager.register("bash", "late rejection", async () => "payload");
			await deliveryStarted.promise;
			disposePromise = manager.dispose({ timeoutMs: 3_000 });
			releaseDelivery.resolve();

			expect(await disposePromise).toBe(true);
			expect(attempts).toBe(3);
			expect(manager.getDeliveryState()).toMatchObject({ queued: 0, deadLettered: 0 });
		} finally {
			releaseDelivery.resolve();
			if (disposePromise) await disposePromise;
			else await manager.dispose({ timeoutMs: 3_000 });
		}
	});

	test("parked fold delivery remains visible until receipt replay", async () => {
		const manager = new AsyncJobManager({ onJobComplete: () => {}, retentionMs: 0 });
		const parkedJob = Promise.withResolvers<string>();
		const jobId = manager.register("bash", "parked fold", () => parkedJob.promise, {
			id: "parked-fold",
			metadata: { backgrounded: true },
		});
		const job = manager.getJob(jobId);
		if (!job) throw new Error("expected parked job");
		manager.retainParkedDelivery(job, "parked output");
		const replacementId = manager.register("bash", "replacement", async () => "replacement", { id: jobId });
		expect(replacementId).not.toBe(jobId);
		expect(manager.getJobsSnapshot().jobs).toContainEqual({
			id: jobId,
			kind: "bash",
			label: "parked fold",
			status: "running",
			generation: job.generation,
			backgrounded: true,
			deliveryState: "pending",
		});
		manager.clearParkedDelivery(job.generation);
		expect(manager.getJobsSnapshot().jobs).toContainEqual(
			expect.objectContaining({ id: jobId, deliveryState: "pending" }),
		);
		parkedJob.resolve("done");
		await manager.waitForAll();
		await manager.dispose({ timeoutMs: 250 });
	});

	test("retains a parked fold delivery after its job record is evicted", async () => {
		const manager = new AsyncJobManager({ onJobComplete: () => {}, retentionMs: 0 });
		try {
			const jobId = manager.register("bash", "evicted parked fold", async () => "done", {
				id: "evicted-parked-fold",
				metadata: { backgrounded: true },
			});
			const job = manager.getJob(jobId);
			if (!job) throw new Error("expected evicted parked job");
			manager.retainParkedDelivery(job, "parked output");

			await manager.waitForAll();

			expect(manager.getJob(jobId)).toBeUndefined();
			expect(manager.getJobsSnapshot().jobs).toContainEqual(
				expect.objectContaining({
					id: jobId,
					generation: job.generation,
					status: "running",
					deliveryState: "pending",
				}),
			);
		} finally {
			await manager.dispose({ timeoutMs: 250 });
		}
	});

	test("receipt claims prevent job-id reuse until wake consumption", async () => {
		const manager = new AsyncJobManager({ onJobComplete: () => {}, retentionMs: 0 });
		const originalId = manager.register("bash", "claimed", async () => "done", { id: "claimed-job" });
		const original = manager.getJob(originalId);
		if (!original) throw new Error("expected claimed job");
		manager.retainDeliveryClaim(original);
		const replacement = manager.register("bash", "replacement", async () => "replacement", { id: originalId });
		expect(replacement).not.toBe(originalId);
		manager.releaseDeliveryClaim(original.generation);
		await manager.waitForAll();
		await manager.dispose({ timeoutMs: 250 });

		const automaticManager = new AsyncJobManager({ onJobComplete: () => {}, retentionMs: 0 });
		const automaticId = automaticManager.register("bash", "automatic claimed", async () => "done");
		const automaticJob = automaticManager.getJob(automaticId);
		if (!automaticJob) throw new Error("expected automatic claimed job");
		automaticManager.retainDeliveryClaim(automaticJob);
		expect(automaticManager.register("bash", "automatic replacement", async () => "replacement")).toBe("bg_2");
		await automaticManager.dispose({ timeoutMs: 250 });
	});

	test("terminal parked and claimed deliveries remain pending in snapshots", async () => {
		const manager = new AsyncJobManager({ onJobComplete: () => {}, retentionMs: 0 });
		try {
			const parkedId = manager.register("bash", "parked terminal", async () => "parked", { id: "parked-terminal" });
			const parked = manager.getJob(parkedId);
			if (!parked) throw new Error("expected parked terminal job");
			await parked.promise;
			manager.retainParkedDelivery(parked, "parked output");

			const claimedId = manager.register("bash", "claimed terminal", async () => "claimed", {
				id: "claimed-terminal",
			});
			const claimed = manager.getJob(claimedId);
			if (!claimed) throw new Error("expected claimed terminal job");
			await claimed.promise;
			manager.retainDeliveryClaim(claimed);

			expect(manager.getJobsSnapshot().jobs).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ id: parkedId, status: "completed", deliveryState: "pending" }),
					expect.objectContaining({ id: claimedId, status: "completed", deliveryState: "pending" }),
				]),
			);
		} finally {
			await manager.dispose({ timeoutMs: 250 });
		}
	});
});
