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
});
