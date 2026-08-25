import { describe, expect, test } from "bun:test";
import { AsyncJobManager } from "@gajae-code/coding-agent/async/job-manager";
import {
	lookupOwnedRegistration,
	registerOwnedRegistration,
	resetTerminalAbortRegistriesForTests,
} from "@gajae-code/coding-agent/session/terminal-abort";

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await Bun.sleep(10);
	}
	throw new Error("waitFor timed out");
}

describe("AsyncJobManager delivery reliability", () => {
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
});
