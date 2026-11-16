import { describe, expect, it, spyOn } from "bun:test";
import { AsyncJobManager } from "../src/async/job-manager";
import { Settings } from "../src/config/settings";
import { CronTool, clearOwnerSchedules, deleteCronJobAndCaptureDelivery, listCronSnapshots } from "../src/tools/cron";
import type { ToolSession } from "../src/tools/index";

async function schedule(ownerId: string, manager: AsyncJobManager, deliver: () => Promise<void>) {
	const session = {
		cwd: process.cwd(),
		hasUI: false,
		settings: Settings.isolated({}),
		getAgentId: () => ownerId,
		getAsyncJobManager: () => manager,
		sendCustomMessage: deliver,
	} as unknown as ToolSession;
	await new CronTool(session).execute("schedule", {
		op: "create",
		cron_expression: "*/5 * * * *",
		prompt: "controlled local delivery",
		recurring: true,
	});
	const snapshot = listCronSnapshots(ownerId)[0];
	if (!snapshot) throw new Error("Expected the actual schedule to be registered");
	return snapshot;
}

// Keep the regression in a separate process: the old owner-filtered drain
// starves timers with a microtask spin, so an in-process timeout cannot stop it.
async function checkRetainedDeliveryDrain(retention: "parked" | "claim"): Promise<void> {
	const source = `
		import { strict as assert } from "node:assert";
		import { AsyncJobManager } from ${JSON.stringify(new URL("../src/async/job-manager.ts", import.meta.url).pathname)};
		const retention = ${JSON.stringify(retention)};
		let deliveries = 0;
		const manager = new AsyncJobManager({ onJobComplete: async () => { deliveries += 1; } });
		const ownerId = "retained-owner";
		const foreignOwnerId = "foreign-owner";
		const retain = job => retention === "parked"
			? manager.retainParkedDelivery(job, "parked completion")
			: manager.retainDeliveryClaim(job);
		const release = generation => retention === "parked"
			? manager.clearParkedDelivery(generation)
			: manager.releaseDeliveryClaim(generation);
		async function createClaim(ownerId) {
			const id = manager.register("task", "retained completion", async () => ({ kind: "paused" }), { ownerId });
			const job = manager.getJob(id);
			assert.ok(job);
			await job.promise;
			retain(job);
			return job;
		}
		const own = await createClaim(ownerId);
		const foreign = await createClaim(foreignOwnerId);
		const filter = { ownerId };
		const pending = manager.getDeliveryState(filter);
		const foreignPending = manager.getDeliveryState({ ownerId: foreignOwnerId });
		const snapshot = manager.getJobsSnapshot(filter);
		assert.equal(pending.queued, 1);
		assert.equal(pending.delivering, true);
		assert.deepEqual(pending.pendingJobIds, [own.id]);
		assert.equal(snapshot.jobs[0].generation, own.generation);
		assert.equal(snapshot.jobs[0].deliveryState, "pending");
		try {
			release(own.generation + ":stale");
			assert.equal(await manager.drainDeliveries({ timeoutMs: 0, filter }), false);
			assert.deepEqual(manager.getDeliveryState(filter), pending);
			assert.deepEqual(manager.getJobsSnapshot(filter), snapshot);
			assert.equal(deliveries, 0);

			let timerRan = false;
			const timer = setTimeout(() => { timerRan = true; }, 0);
			try {
				assert.equal(await manager.drainDeliveries({ timeoutMs: 25, filter }), false);
				assert.equal(timerRan, true);
			} finally {
				clearTimeout(timer);
			}
			assert.deepEqual(manager.getDeliveryState(filter), pending);
			assert.deepEqual(manager.getJobsSnapshot(filter), snapshot);
			assert.deepEqual(manager.getDeliveryState({ ownerId: foreignOwnerId }), foreignPending);
			assert.equal(deliveries, 0);
			assert.equal(await manager.drainDeliveries({ timeoutMs: 0 }), false);
			assert.equal(await manager.drainDeliveries({ timeoutMs: 25 }), false);
			assert.deepEqual(manager.getDeliveryState(filter), pending);

			for (const timeoutMs of [500, undefined]) {
				let completed = false;
				const draining = manager.drainDeliveries({ timeoutMs, filter }).then(result => {
					completed = true;
					return result;
				});
				try {
					await Bun.sleep(10);
					assert.equal(completed, false);
					assert.deepEqual(manager.getDeliveryState(filter), pending);
				} finally {
					release(own.generation);
				}
				assert.equal(await draining, true);
				assert.equal(manager.getDeliveryState(filter).queued, 0);
				assert.deepEqual(manager.getDeliveryState({ ownerId: foreignOwnerId }), foreignPending);
				assert.equal(deliveries, 0);
				if (timeoutMs !== undefined) retain(own);
			}
			assert.equal(await manager.drainDeliveries({ timeoutMs: 0, filter }), true);
			let allCompleted = false;
			const allDraining = manager.drainDeliveries({ timeoutMs: 500 }).then(result => {
				allCompleted = true;
				return result;
			});
			try {
				await Bun.sleep(10);
				assert.equal(allCompleted, false);
				assert.deepEqual(manager.getDeliveryState({ ownerId: foreignOwnerId }), foreignPending);
			} finally {
				release(foreign.generation);
			}
			assert.equal(await allDraining, true);
			assert.equal(await manager.drainDeliveries({ timeoutMs: 0 }), true);
		} finally {
			release(own.generation);
			release(foreign.generation);
			assert.equal(await manager.dispose({ timeoutMs: 100 }), true);
		}
	`;
	const child = Bun.spawn([process.execPath, "--eval", source], { stdout: "pipe", stderr: "pipe" });
	let timedOut = false;
	const watchdog = setTimeout(() => {
		timedOut = true;
		child.kill("SIGKILL");
	}, 5_000);
	try {
		const [exitCode, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		expect({ timedOut, exitCode, stdout, stderr }).toEqual({ timedOut: false, exitCode: 0, stdout: "", stderr: "" });
	} finally {
		clearTimeout(watchdog);
		if (child.exitCode === null) child.kill("SIGKILL");
		await child.exited;
	}
}

for (const retention of ["parked", "claim"] as const) {
	it(`bounds ${retention} delivery drains without releasing owner authority`, async () => {
		await checkRetainedDeliveryDrain(retention);
	}, 10_000);
}

describe("exact cron delivery settlement", () => {
	it("keeps foreign and stale schedules untouched and settles a non-firing deletion", async () => {
		const ownerId = crypto.randomUUID();
		const manager = new AsyncJobManager({ onJobComplete: async () => {} });
		try {
			const entry = await schedule(ownerId, manager, async () => {});
			expect(deleteCronJobAndCaptureDelivery("foreign", entry)).toEqual({ kind: "not_found" });
			expect(deleteCronJobAndCaptureDelivery(ownerId, { ...entry, createdAt: entry.createdAt + 1 })).toEqual({
				kind: "stale_generation",
			});
			expect(listCronSnapshots(ownerId).map(item => item.id)).toEqual([entry.id]);
			const deleted = deleteCronJobAndCaptureDelivery(ownerId, entry);
			if (deleted.kind !== "deleted") throw new Error("Expected exact schedule deletion");
			expect(deleted.isSettled()).toBe(true);
			await deleted.completion;
			expect(listCronSnapshots(ownerId)).toEqual([]);
			expect(deleteCronJobAndCaptureDelivery(ownerId, entry)).toEqual({ kind: "not_found" });
		} finally {
			clearOwnerSchedules(ownerId);
			await manager.dispose({ timeoutMs: 100 });
		}
	});

	for (const disposition of ["resolve", "reject"] as const) {
		it(`joins an already firing delivery after deletion, including ${disposition}`, async () => {
			const ownerId = crypto.randomUUID();
			const manager = new AsyncJobManager({ onJobComplete: async () => {} });
			const delivery = Promise.withResolvers<void>();
			const timerSpy = spyOn(globalThis, "setTimeout");
			let deliveries = 0;
			try {
				const entry = await schedule(ownerId, manager, () => {
					deliveries += 1;
					return delivery.promise;
				});
				const timerIndex = timerSpy.mock.calls.findIndex(([, delay]) => Number(delay) < 10 * 60 * 1000);
				if (timerIndex < 0) throw new Error("Expected the actual cron firing timer");
				const callback = timerSpy.mock.calls[timerIndex]![0];
				const handle = timerSpy.mock.results[timerIndex]!.value as NodeJS.Timeout;
				clearTimeout(handle);
				callback();
				expect(deliveries).toBe(1);
				expect(entry.firing).toBe(true);
				const deleted = deleteCronJobAndCaptureDelivery(ownerId, entry);
				if (deleted.kind !== "deleted") throw new Error("Expected exact firing schedule deletion");
				expect(listCronSnapshots(ownerId)).toEqual([]);
				expect(deleted.isSettled()).toBe(false);
				let joined = false;
				void deleted.completion.then(() => {
					joined = true;
				});
				await Promise.resolve();
				expect(joined).toBe(false);
				callback();
				expect(deliveries).toBe(1);
				if (disposition === "resolve") delivery.resolve();
				else delivery.reject(new Error("synthetic delivery failure"));
				await deleted.completion;
				expect(joined).toBe(true);
				expect(deleted.isSettled()).toBe(true);
				expect(entry.firing).toBe(false);
				expect(listCronSnapshots(ownerId)).toEqual([]);
			} finally {
				delivery.resolve();
				clearOwnerSchedules(ownerId);
				timerSpy.mockRestore();
				await manager.dispose({ timeoutMs: 100 });
			}
		});
	}
});
