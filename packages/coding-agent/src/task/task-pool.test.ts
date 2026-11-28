import { describe, expect, it } from "bun:test";
import type { Settings } from "../config/settings";
import { SessionTaskPool } from "./task-pool";

function createMockSettings(initialValues: Record<string, unknown> = {}): Settings {
	const values = initialValues;
	return {
		get: (key: string) => values[key],
		set: (key: string, value: unknown) => {
			values[key] = value;
		},
	} as unknown as Settings;
}

describe("SessionTaskPool", () => {
	it("handles positive limits correctly", async () => {
		const settings = createMockSettings();
		const pool = new SessionTaskPool(settings, 2);

		const slot1 = await pool.acquire(0);
		expect(slot1.acquiredSlot).toBe(true);

		const slot2 = await pool.acquire(0);
		expect(slot2.acquiredSlot).toBe(true);

		pool.release(slot1);
		pool.release(slot2);
	});

	it("rejects or clamps negative limits (not unlimited)", async () => {
		const settings = createMockSettings({ "task.maxConcurrency": -5 });
		const pool = new SessionTaskPool(settings, 1);

		// A negative limit should NOT be treated as unlimited
		// It should be clamped to a finite value (1)
		const slot1 = await pool.acquire(0);
		expect(slot1.acquiredSlot).toBe(true);

		// Try to acquire a second - this should block because limit is 1
		// But if negative is still treated as unlimited (the bug), it would succeed
		let secondAcquired = false;
		const secondPromise = (async () => {
			await pool.acquire(0);
			secondAcquired = true;
		})();

		// Give it a moment to try to acquire
		await new Promise(resolve => setTimeout(resolve, 50));

		// The second acquire should have blocked (limit is 1, not unlimited)
		// This test fails if negative values are treated as unlimited
		expect(secondAcquired).toBe(false);

		pool.release(slot1);
		// Now the waiter can acquire the slot
		await secondPromise;
		expect(secondAcquired).toBe(true);
	});

	it("treats 0 as unlimited", async () => {
		const settings = createMockSettings({ "task.maxConcurrency": 0 });
		const pool = new SessionTaskPool(settings, 1);

		// 0 should mean unlimited
		for (let i = 0; i < 100; i++) {
			const slot = await pool.acquire(0);
			expect(slot.acquiredSlot).toBe(true);
			pool.release(slot);
		}
	});

	it("handles dynamic limit changes", async () => {
		const values: Record<string, unknown> = { "task.maxConcurrency": 2 };
		const settings = {
			get: (key: string) => values[key],
		} as unknown as Settings;
		const pool = new SessionTaskPool(settings, 2);

		const slot1 = await pool.acquire(0);
		const slot2 = await pool.acquire(0);

		// Change to unlimited
		values["task.maxConcurrency"] = 0;
		const slot3 = await pool.acquire(0);
		expect(slot3.acquiredSlot).toBe(true);

		// Change back to limited
		values["task.maxConcurrency"] = 2;
		pool.release(slot1);
		pool.release(slot2);
		pool.release(slot3);
	});

	it("nested tasks do not acquire slots to prevent deadlock", async () => {
		const settings = createMockSettings({ "task.maxConcurrency": 1 });
		const pool = new SessionTaskPool(settings, 1);

		// Parent task at depth 0 acquires the slot
		const parentSlot = await pool.acquire(0);
		expect(parentSlot.acquiredSlot).toBe(true);

		// Nested task at depth 1 should not need to acquire (depth > 0 is exempt)
		const nestedSlot = await pool.acquire(1);
		expect(nestedSlot.acquiredSlot).toBe(false);

		// Another nested task should also not acquire
		const nestedSlot2 = await pool.acquire(2);
		expect(nestedSlot2.acquiredSlot).toBe(false);

		// Release the parent slot
		pool.release(parentSlot);
		pool.release(nestedSlot);
		pool.release(nestedSlot2);
	});
});
