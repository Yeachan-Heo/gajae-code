import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { SessionTaskPool } from "../../src/task/task-pool";

/** Mock settings object for testing. */
class MockSettings {
	private values = new Map<string, unknown>();

	constructor(initialValues?: Record<string, unknown>) {
		if (initialValues) {
			Object.entries(initialValues).forEach(([k, v]) => {
				this.values.set(k, v);
			});
		}
		// Set default for task.maxConcurrency
		if (!this.values.has("task.maxConcurrency")) {
			this.values.set("task.maxConcurrency", 2);
		}
	}

	get(key: string): unknown {
		return this.values.get(key);
	}

	set(key: string, value: unknown): void {
		this.values.set(key, value);
	}

	onChanged(_callback: (key: string) => void, _mode?: string): () => void {
		// Return a no-op unsubscribe function for testing
		return () => {};
	}
}

describe("SessionTaskPool concurrency enforcement", () => {
	let pool: SessionTaskPool;
	let settings: MockSettings;

	beforeEach(() => {
		settings = new MockSettings({ "task.maxConcurrency": 2 });
		pool = new SessionTaskPool(settings as never, 2);
	});

	it("should allow up to maxConcurrency top-level tasks to hold slots concurrently", async () => {
		const acquireOrder: number[] = [];
		const releaseOrder: number[] = [];

		// First top-level task
		const task1Slot = await pool.acquire(0);
		expect(task1Slot.acquiredSlot).toBe(true);
		acquireOrder.push(1);

		// Second top-level task
		const task2Slot = await pool.acquire(0);
		expect(task2Slot.acquiredSlot).toBe(true);
		acquireOrder.push(2);

		// Try third top-level task - should block until a slot is available
		let task3Acquired = false;
		const task3Promise = pool.acquire(0).then(slot => {
			task3Acquired = true;
			acquireOrder.push(3);
			return slot;
		});

		// Give task3 a moment to try acquiring
		await new Promise(resolve => setTimeout(resolve, 50));
		expect(task3Acquired).toBe(false); // Should still be blocked

		// Release first task
		pool.release(task1Slot);
		releaseOrder.push(1);

		// Now task3 should be able to acquire
		const task3Slot = await task3Promise;
		expect(task3Acquired).toBe(true);
		expect(task3Slot.acquiredSlot).toBe(true);

		// Cleanup
		pool.release(task2Slot);
		pool.release(task3Slot);
	});

	it("should not enforce limits on nested tasks (taskDepth > 0)", async () => {
		// Top-level task acquires
		const slot0 = await pool.acquire(0);
		expect(slot0.acquiredSlot).toBe(true);

		// Nested task should bypass acquire and return immediately
		const slot1 = await pool.acquire(1);
		expect(slot1.acquiredSlot).toBe(false);

		// Deeply nested task should also bypass
		const slot2 = await pool.acquire(2);
		expect(slot2.acquiredSlot).toBe(false);

		// Cleanup
		pool.release(slot0);
		pool.release(slot1);
		pool.release(slot2);
	});

	it("should handle nested tasks without deadlock", async () => {
		// Simulate a parent task that spawns nested child tasks
		const parentSlot = await pool.acquire(0);
		expect(parentSlot.acquiredSlot).toBe(true);

		// Parent should be able to spawn nested children without blocking
		const childSlots = await Promise.all([pool.acquire(1), pool.acquire(1), pool.acquire(1)]);

		// All children should have been able to proceed
		for (const slot of childSlots) {
			expect(slot.acquiredSlot).toBe(false); // Nested, so no slot acquired
		}

		// Cleanup
		pool.release(parentSlot);
		for (const slot of childSlots) {
			pool.release(slot);
		}
	});

	it("should respect runtime changes to maxConcurrency on new acquires", async () => {
		// Initial limit is 2
		const slot1 = await pool.acquire(0);
		const slot2 = await pool.acquire(0);

		// Release both slots
		pool.release(slot1);
		pool.release(slot2);

		// Change limit to 3
		settings.set("task.maxConcurrency", 3);

		// Now should be able to acquire 3 slots
		const newSlot1 = await pool.acquire(0);
		const newSlot2 = await pool.acquire(0);
		const newSlot3 = await pool.acquire(0);

		expect(newSlot1.acquiredSlot).toBe(true);
		expect(newSlot2.acquiredSlot).toBe(true);
		expect(newSlot3.acquiredSlot).toBe(true);

		// Cleanup
		pool.release(newSlot1);
		pool.release(newSlot2);
		pool.release(newSlot3);
	});

	it("should strictly enforce maxConcurrency with blocking on third acquire", async () => {
		// Acquire 2 slots (up to the limit)
		const slot1 = await pool.acquire(0);
		expect(slot1.acquiredSlot).toBe(true);

		const slot2 = await pool.acquire(0);
		expect(slot2.acquiredSlot).toBe(true);

		// Try to acquire third - should block
		let slot3Acquired = false;
		const slot3Promise = pool.acquire(0).then(slot => {
			slot3Acquired = true;
			return slot;
		});

		// Give it a moment to try
		await new Promise(resolve => setTimeout(resolve, 50));
		expect(slot3Acquired).toBe(false);

		// Release first slot
		pool.release(slot1);

		// Wait for third to acquire
		const slot3 = await slot3Promise;
		expect(slot3Acquired).toBe(true);
		expect(slot3.acquiredSlot).toBe(true);

		// Cleanup
		pool.release(slot2);
		pool.release(slot3);
	});

	it("should release only slots that were actually acquired", async () => {
		// Top-level acquires a slot
		const topLevelSlot = await pool.acquire(0);
		expect(topLevelSlot.acquiredSlot).toBe(true);

		// Nested doesn't acquire
		const nestedSlot = await pool.acquire(1);
		expect(nestedSlot.acquiredSlot).toBe(false);

		// Releasing nested should be a no-op
		pool.release(nestedSlot);

		// We should still be able to acquire one more top-level slot
		const anotherSlot = await pool.acquire(0);
		expect(anotherSlot.acquiredSlot).toBe(true);

		// Cleanup
		pool.release(topLevelSlot);
		pool.release(anotherSlot);
	});

	it("should maintain separate acquire/release tracking for different tasks", async () => {
		// Acquire 2 slots for different tasks
		const slot1 = await pool.acquire(0);
		const slot2 = await pool.acquire(0);

		expect(slot1.acquiredSlot).toBe(true);
		expect(slot2.acquiredSlot).toBe(true);

		// Release them in any order
		pool.release(slot2); // Release in reverse order
		pool.release(slot1);

		// Should be able to acquire 2 new slots
		const newSlot1 = await pool.acquire(0);
		const newSlot2 = await pool.acquire(0);

		expect(newSlot1.acquiredSlot).toBe(true);
		expect(newSlot2.acquiredSlot).toBe(true);

		// Cleanup
		pool.release(newSlot1);
		pool.release(newSlot2);
	});

	afterEach(() => {
		// No explicit cleanup needed for the pool
	});
});
