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

	it("should enforce limits on all tasks including nested (taskDepth > 0)", async () => {
		// All tasks now acquire from the same pool, regardless of depth
		// This ensures the session-wide maxConcurrency is honored
		// Top-level task acquires
		const slot0 = await pool.acquire(0);
		expect(slot0.acquiredSlot).toBe(true);

		// Nested task also acquires from pool
		const slot1 = await pool.acquire(1);
		expect(slot1.acquiredSlot).toBe(true);

		// At limit now (2), so next acquire should block
		let slot2Acquired = false;
		const slot2Promise = pool.acquire(2).then(() => {
			slot2Acquired = true;
		});

		await new Promise(resolve => setTimeout(resolve, 50));
		expect(slot2Acquired).toBe(false);

		// Release nested task's slot
		pool.release(slot1);
		await slot2Promise;
		expect(slot2Acquired).toBe(true);

		// Cleanup
		pool.release(slot0);
		pool.release(await pool.acquire(2));
	});

	it("should handle nested tasks while respecting pool limits", async () => {
		// Parent task acquires
		const parentSlot = await pool.acquire(0);
		expect(parentSlot.acquiredSlot).toBe(true);

		// Try to acquire 3 nested tasks (only 1 slot available since parent holds 1)
		const child1 = await pool.acquire(1);
		expect(child1.acquiredSlot).toBe(true);
		// Now at limit (2), so more children block

		let child2Acquired = false;
		const child2Promise = pool.acquire(1).then(slot => {
			child2Acquired = true;
			return slot;
		});

		let child3Acquired = false;
		const child3Promise = pool.acquire(1).then(slot => {
			child3Acquired = true;
			return slot;
		});

		await new Promise(resolve => setTimeout(resolve, 50));
		expect(child2Acquired).toBe(false);
		expect(child3Acquired).toBe(false);

		// Release child1
		pool.release(child1);
		const child2 = await child2Promise;
		expect(child2Acquired).toBe(true);

		// Cleanup
		pool.release(parentSlot);
		pool.release(child2);
		const child3 = await child3Promise;
		pool.release(child3);
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
		// All tasks now acquire slots; test validates release tracking
		const topLevelSlot = await pool.acquire(0);
		expect(topLevelSlot.acquiredSlot).toBe(true);

		const nestedSlot = await pool.acquire(1);
		expect(nestedSlot.acquiredSlot).toBe(true);

		// Both slots are in use (at limit of 2)
		// Try to acquire third
		let thirdAcquired = false;
		const thirdPromise = pool.acquire(0).then(() => {
			thirdAcquired = true;
		});

		await new Promise(resolve => setTimeout(resolve, 50));
		expect(thirdAcquired).toBe(false);

		// Release nested slot
		pool.release(nestedSlot);
		// Now third should acquire
		await thirdPromise;
		expect(thirdAcquired).toBe(true);

		// Cleanup
		pool.release(topLevelSlot);
		pool.release(await pool.acquire(0));
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

describe("SessionTaskPool resizing with active permits and waiters", () => {
	let pool: SessionTaskPool;
	let settings: MockSettings;

	beforeEach(() => {
		settings = new MockSettings({ "task.maxConcurrency": 2 });
		pool = new SessionTaskPool(settings as never, 2);
	});

	it("should preserve permits and waiters when resizing with live holders", async () => {
		// Acquire 2 slots (at limit)
		const slot1 = await pool.acquire(0);
		const slot2 = await pool.acquire(0);
		expect(slot1.acquiredSlot).toBe(true);
		expect(slot2.acquiredSlot).toBe(true);

		// Queue a waiter
		let waiter3Acquired = false;
		const waiter3Promise = pool.acquire(0).then(() => {
			waiter3Acquired = true;
		});

		await new Promise(resolve => setTimeout(resolve, 50));
		expect(waiter3Acquired).toBe(false);

		// Resize: increase limit to 3
		settings.set("task.maxConcurrency", 3);

		// Try to acquire - this will trigger resizeIfNeeded and wake the waiter
		let slot3Acquired = false;
		const slot3Promise = pool.acquire(0).then(() => {
			slot3Acquired = true;
			return true;
		});

		// The waiter should be woken by the resize
		await waiter3Promise;
		expect(waiter3Acquired).toBe(true);

		// slot3 should still be blocked (at capacity: 2 original + waiter3 = 3)
		await new Promise(resolve => setTimeout(resolve, 50));
		expect(slot3Acquired).toBe(false);

		// Release slot1 to make room for slot3
		pool.release(slot1);
		await slot3Promise;
		expect(slot3Acquired).toBe(true);

		// Cleanup
		pool.release(slot2);
		pool.release({ acquiredSlot: true });
	});

	it("should correctly shrink limit while preserving existing holders", async () => {
		// Acquire 2 slots with limit 2
		const slot1 = await pool.acquire(0);
		const slot2 = await pool.acquire(0);
		expect(slot1.acquiredSlot).toBe(true);
		expect(slot2.acquiredSlot).toBe(true);

		// Shrink limit to 1
		settings.set("task.maxConcurrency", 1);

		// Existing holders should still be valid
		pool.release(slot1);
		pool.release(slot2);

		// New acquires should respect new limit
		const newSlot1 = await pool.acquire(0);
		expect(newSlot1.acquiredSlot).toBe(true);

		let newSlot2Acquired = false;
		const newSlot2Promise = pool.acquire(0).then(slot => {
			newSlot2Acquired = true;
			return slot;
		});

		await new Promise(resolve => setTimeout(resolve, 50));
		expect(newSlot2Acquired).toBe(false);

		pool.release(newSlot1);
		const newSlot2 = await newSlot2Promise;
		expect(newSlot2Acquired).toBe(true);
		pool.release(newSlot2);
	});
});

describe("SessionTaskPool unlimited setting", () => {
	let pool: SessionTaskPool;
	let settings: MockSettings;

	beforeEach(() => {
		settings = new MockSettings({ "task.maxConcurrency": 0 });
		pool = new SessionTaskPool(settings as never, 0);
	});

	it("should allow unlimited tasks when maxConcurrency is 0", async () => {
		// Acquire many slots without blocking
		const slots: Array<{ acquiredSlot: boolean }> = [];
		for (let i = 0; i < 100; i++) {
			const slot = await pool.acquire(0);
			slots.push(slot);
			expect(slot.acquiredSlot).toBe(true);
		}

		// All should acquire immediately without blocking
		expect(slots).toHaveLength(100);
		for (const slot of slots) {
			pool.release(slot);
		}
	});

	it("should switch to unlimited when resized from limited", async () => {
		const limitedSettings = new MockSettings({ "task.maxConcurrency": 2 });
		const limitedPool = new SessionTaskPool(limitedSettings as never, 2);

		// Acquire 2 slots (at limit)
		const slot1 = await limitedPool.acquire(0);
		const slot2 = await limitedPool.acquire(0);
		expect(slot1.acquiredSlot).toBe(true);
		expect(slot2.acquiredSlot).toBe(true);

		// Try third - should block
		let slot3Acquired = false;
		const slot3Promise = limitedPool.acquire(0).then(() => {
			slot3Acquired = true;
		});

		await new Promise(resolve => setTimeout(resolve, 50));
		expect(slot3Acquired).toBe(false);

		// Switch to unlimited
		limitedSettings.set("task.maxConcurrency", 0);

		// Try another acquire - should trigger resize and wake waiting slot3
		const slot4 = await limitedPool.acquire(0);
		expect(slot4.acquiredSlot).toBe(true);

		// Waiter should be woken by resize
		await slot3Promise;
		expect(slot3Acquired).toBe(true);

		limitedPool.release(slot1);
		limitedPool.release(slot2);
		limitedPool.release(slot4);
	});
});

describe("SessionTaskPool nested tasks acquire from same pool", () => {
	let pool: SessionTaskPool;
	let settings: MockSettings;

	beforeEach(() => {
		settings = new MockSettings({ "task.maxConcurrency": 2 });
		pool = new SessionTaskPool(settings as never, 2);
	});

	it("should enforce concurrency limit for nested tasks at depth > 0", async () => {
		// Top-level task acquires
		const slot0 = await pool.acquire(0);
		expect(slot0.acquiredSlot).toBe(true);

		// Nested task also acquires (now they can with removed depth check)
		const slot1 = await pool.acquire(1);
		expect(slot1.acquiredSlot).toBe(true);

		// Limit reached (2), third task should block
		let slot2Acquired = false;
		const slot2Promise = pool.acquire(0).then(() => {
			slot2Acquired = true;
		});

		await new Promise(resolve => setTimeout(resolve, 50));
		expect(slot2Acquired).toBe(false);

		// Release nested task's slot
		pool.release(slot1);

		// Now third should acquire
		await slot2Promise;
		expect(slot2Acquired).toBe(true);

		pool.release(slot0);
		pool.release(await pool.acquire(0));
	});

	it("should stay within limit for nested batch execution", async () => {
		const acquiredCount: number[] = [];
		let maxConcurrent = 0;
		let currentlyRunning = 0;

		const runTaskSimulation = async (depth: number, _id: string): Promise<void> => {
			const slot = await pool.acquire(depth);
			currentlyRunning++;
			acquiredCount.push(currentlyRunning);
			maxConcurrent = Math.max(maxConcurrent, currentlyRunning);

			// Simulate work
			await new Promise(resolve => setTimeout(resolve, 10));

			currentlyRunning--;
			pool.release(slot);
		};

		// Run 4 tasks concurrently: mix of depth 0 and 1
		await Promise.all([
			runTaskSimulation(0, "task0"),
			runTaskSimulation(1, "task1"),
			runTaskSimulation(0, "task2"),
			runTaskSimulation(1, "task3"),
		]);

		// Max concurrent should not exceed 2 (the pool limit)
		expect(maxConcurrent).toBeLessThanOrEqual(2);
	});
});
