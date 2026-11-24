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

	it("should exempt nested tasks (taskDepth > 0) from acquiring slots", async () => {
		// Top-level task acquires
		const slot0 = await pool.acquire(0);
		expect(slot0.acquiredSlot).toBe(true);

		// Nested task does NOT acquire from pool (exempted)
		const slot1 = await pool.acquire(1);
		expect(slot1.acquiredSlot).toBe(false);

		// Another nested task also doesn't acquire
		const slot2 = await pool.acquire(2);
		expect(slot2.acquiredSlot).toBe(false);

		// Can still acquire top-level tasks (up to limit)
		const slot0b = await pool.acquire(0);
		expect(slot0b.acquiredSlot).toBe(true);

		// Third top-level would block (limit is 2)
		let slot0cAcquired = false;
		const slot0cPromise = pool.acquire(0).then(() => {
			slot0cAcquired = true;
		});

		await new Promise(resolve => setTimeout(resolve, 50));
		expect(slot0cAcquired).toBe(false);

		// Release first top-level
		pool.release(slot0);
		await slot0cPromise;
		expect(slot0cAcquired).toBe(true);

		// Cleanup
		pool.release(slot1);
		pool.release(slot2);
		pool.release(slot0b);
		pool.release(await pool.acquire(0));
	});

	it("should allow parent to await nested tasks without deadlock", async () => {
		// Parent task acquires the only available slot
		const parentSlot = await pool.acquire(0);
		expect(parentSlot.acquiredSlot).toBe(true);

		// Nested tasks don't acquire, so they can proceed while parent holds the slot
		const child1 = await pool.acquire(1);
		expect(child1.acquiredSlot).toBe(false);

		const child2 = await pool.acquire(1);
		expect(child2.acquiredSlot).toBe(false);

		const child3 = await pool.acquire(2);
		expect(child3.acquiredSlot).toBe(false);

		// Parent can safely wait for nested tasks to complete without blocking them
		// This prevents the deadlock that would occur if nested tasks had to acquire slots

		// Cleanup
		pool.release(parentSlot);
		pool.release(child1);
		pool.release(child2);
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
		// Top-level tasks acquire; nested tasks don't
		const topLevelSlot = await pool.acquire(0);
		expect(topLevelSlot.acquiredSlot).toBe(true);

		const nestedSlot = await pool.acquire(1);
		expect(nestedSlot.acquiredSlot).toBe(false);

		// Second top-level acquires (at limit of 2 now)
		const topLevel2Slot = await pool.acquire(0);
		expect(topLevel2Slot.acquiredSlot).toBe(true);

		// Try to acquire third top-level
		let thirdAcquired = false;
		const thirdPromise = pool.acquire(0).then(() => {
			thirdAcquired = true;
		});

		await new Promise(resolve => setTimeout(resolve, 50));
		expect(thirdAcquired).toBe(false);

		// Release nested slot (doesn't change anything since it wasn't acquired)
		pool.release(nestedSlot);
		// Third should still be blocked (topLevelSlot still held)
		await new Promise(resolve => setTimeout(resolve, 50));
		expect(thirdAcquired).toBe(false);

		// Release first top-level
		pool.release(topLevelSlot);
		await thirdPromise;
		expect(thirdAcquired).toBe(true);

		// Cleanup
		pool.release(topLevel2Slot);
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

describe("SessionTaskPool nested tasks exemption", () => {
	let pool: SessionTaskPool;
	let settings: MockSettings;

	beforeEach(() => {
		settings = new MockSettings({ "task.maxConcurrency": 2 });
		pool = new SessionTaskPool(settings as never, 2);
	});

	it("should exempt nested tasks at depth > 0 from acquiring slots", async () => {
		// Top-level task acquires
		const slot0 = await pool.acquire(0);
		expect(slot0.acquiredSlot).toBe(true);

		// Nested tasks don't acquire slots
		const slot1 = await pool.acquire(1);
		expect(slot1.acquiredSlot).toBe(false);

		const slot2 = await pool.acquire(2);
		expect(slot2.acquiredSlot).toBe(false);

		// Second top-level can still acquire (pool limit is 2)
		const slot0b = await pool.acquire(0);
		expect(slot0b.acquiredSlot).toBe(true);

		// Third top-level would block (at limit)
		let slot0cAcquired = false;
		const slot0cPromise = pool.acquire(0).then(() => {
			slot0cAcquired = true;
		});

		await new Promise(resolve => setTimeout(resolve, 50));
		expect(slot0cAcquired).toBe(false);

		pool.release(slot0);
		pool.release(slot1);
		pool.release(slot2);
		pool.release(slot0b);
		await slot0cPromise;
	});

	it("top-level tasks stay within limit while nested tasks are exempt", async () => {
		const topLevelRuns: number[] = [];
		let maxTopLevel = 0;
		let currentTopLevel = 0;

		const runTaskSimulation = async (depth: number, _id: string): Promise<void> => {
			const slot = await pool.acquire(depth);
			if (depth === 0) {
				currentTopLevel++;
				topLevelRuns.push(currentTopLevel);
				maxTopLevel = Math.max(maxTopLevel, currentTopLevel);
			}

			// Simulate work
			await new Promise(resolve => setTimeout(resolve, 10));

			if (depth === 0) {
				currentTopLevel--;
			}
			pool.release(slot);
		};

		// Run 4 tasks concurrently: mix of depth 0 and 1
		// Depth 0 tasks should respect limit, depth 1 tasks should not
		await Promise.all([
			runTaskSimulation(0, "task0"),
			runTaskSimulation(1, "task1"),
			runTaskSimulation(0, "task2"),
			runTaskSimulation(1, "task3"),
		]);

		// Max concurrent top-level should not exceed 2 (the pool limit)
		expect(maxTopLevel).toBeLessThanOrEqual(2);
	});
});
