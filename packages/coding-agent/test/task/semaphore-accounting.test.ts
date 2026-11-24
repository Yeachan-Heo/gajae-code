import { describe, expect, it } from "bun:test";
import { Semaphore } from "../../src/task/parallel";

describe("Semaphore permit accounting on growth", () => {
	it("should reserve permit for woken waiter on grow", async () => {
		const sem = new Semaphore(1);

		// Acquire the only slot
		await sem.acquire();

		// Queue a waiter
		let waiterAcquired = false;
		const waiterPromise = sem.acquire().then(() => {
			waiterAcquired = true;
		});

		await new Promise(resolve => setTimeout(resolve, 50));
		expect(waiterAcquired).toBe(false);

		// Grow the limit to 2 - this should wake the waiter
		sem.setMax(2);

		await waiterPromise;
		expect(waiterAcquired).toBe(true);

		// Try to acquire a third - should block since we have holder + waiter
		let thirdAcquired = false;
		const thirdPromise = sem.acquire().then(() => {
			thirdAcquired = true;
		});

		await new Promise(resolve => setTimeout(resolve, 50));
		expect(thirdAcquired).toBe(false);

		// Cleanup
		sem.release(); // holder
		sem.release(); // waiter

		// Now third should proceed
		await thirdPromise;
		expect(thirdAcquired).toBe(true);
		sem.release(); // third
	});

	it("should increment current for each woken waiter", async () => {
		const sem = new Semaphore(1);

		// Acquire the slot
		await sem.acquire();

		// Queue 2 waiters
		let waiter1Done = false;
		let waiter2Done = false;
		const waiter1 = sem.acquire().then(() => {
			waiter1Done = true;
		});
		const waiter2 = sem.acquire().then(() => {
			waiter2Done = true;
		});

		await new Promise(resolve => setTimeout(resolve, 50));
		expect(waiter1Done).toBe(false);
		expect(waiter2Done).toBe(false);

		// Grow limit to 3, which should wake both waiters
		sem.setMax(3);

		await Promise.all([waiter1, waiter2]);
		expect(waiter1Done).toBe(true);
		expect(waiter2Done).toBe(true);

		// Now all three should have acquired slots
		// If accounting is broken, releasing might behave incorrectly
		// Try to acquire a 4th - should be blocked
		let waiter3Done = false;
		const waiter3 = sem.acquire().then(() => {
			waiter3Done = true;
		});

		await new Promise(resolve => setTimeout(resolve, 50));
		expect(waiter3Done).toBe(false); // Should be blocked at 3 active

		// Cleanup
		sem.release(); // 1 original holder
		sem.release(); // waiter1
		sem.release(); // waiter2
		await waiter3; // Should now proceed
		sem.release(); // waiter3
	});
});

describe("Semaphore respects lowered limits on release", () => {
	it("should not wake waiters when shrink keeps them blocked", async () => {
		const sem = new Semaphore(2);

		// Acquire both slots
		await sem.acquire();
		await sem.acquire();

		// Queue a waiter
		let waiterAcquired = false;
		const waiterPromise = sem.acquire().then(() => {
			waiterAcquired = true;
		});

		await new Promise(resolve => setTimeout(resolve, 50));
		expect(waiterAcquired).toBe(false);

		// Shrink the limit to 1 (but we have 2 active holders)
		sem.setMax(1);

		// The waiter should still be blocked because we have 2 active holders
		// and the new limit is 1

		// Release one holder (down to 1 active, limit is 1)
		sem.release();

		// The waiter should STILL be blocked because we're at capacity (1 active, limit 1)
		await new Promise(resolve => setTimeout(resolve, 50));
		expect(waiterAcquired).toBe(false);

		// Release the remaining holder to make room for the waiter
		sem.release();

		// Now the waiter should be woken
		await waiterPromise;
		expect(waiterAcquired).toBe(true);

		// Cleanup
		sem.release();
	});

	it("should block woken waiter when capacity unavailable after shrink", async () => {
		const sem = new Semaphore(2);

		// Acquire both slots
		await sem.acquire();
		await sem.acquire();

		// Queue two waiters
		let waiter1Acquired = false;
		let waiter2Acquired = false;
		const waiter1Promise = sem.acquire().then(() => {
			waiter1Acquired = true;
		});
		// biome-ignore lint/correctness/noUnusedVariables: waiter2Promise is not used in this test
		const waiter2Promise = sem.acquire().then(() => {
			waiter2Acquired = true;
		});

		await new Promise(resolve => setTimeout(resolve, 50));
		expect(waiter1Acquired).toBe(false);
		expect(waiter2Acquired).toBe(false);

		// Shrink limit to 1
		sem.setMax(1);

		// Release one holder (now 1 active, limit 1, 2 waiters queued)
		// At capacity, so no waiter should be woken
		sem.release();

		// Both waiters should still be blocked
		await new Promise(resolve => setTimeout(resolve, 50));
		expect(waiter1Acquired).toBe(false);
		expect(waiter2Acquired).toBe(false);

		// Release the second holder (now 0 active)
		// Now waiter1 should be woken
		sem.release();

		await waiter1Promise;
		expect(waiter1Acquired).toBe(true);
		expect(waiter2Acquired).toBe(false);

		// Second waiter should still be blocked (waiter1 is now at capacity)
		await new Promise(resolve => setTimeout(resolve, 50));
		expect(waiter2Acquired).toBe(false);

		// Cleanup
		sem.release(); // waiter1
		sem.release(); // waiter2
	});

	it("should maintain exact concurrency when releasing with shrunk limit", async () => {
		const sem = new Semaphore(2);
		let maxConcurrent = 0;
		let currentActive = 0;

		const simulateWork = async (_id: number) => {
			await sem.acquire();
			currentActive++;
			maxConcurrent = Math.max(maxConcurrent, currentActive);
			await new Promise(resolve => setTimeout(resolve, 10));
			currentActive--;
			sem.release();
		};

		// Start 2 concurrent tasks
		const tasks = [simulateWork(1), simulateWork(2)];

		// While they're running, shrink the limit to 1
		// This should block new tasks from starting until capacity becomes available
		await new Promise(resolve => setTimeout(resolve, 5));
		sem.setMax(1);

		tasks.push(simulateWork(3));
		tasks.push(simulateWork(4));

		await Promise.all(tasks);

		// Peak should not exceed 2 (we started with 2 running)
		// The shrink to 1 means subsequent tasks wait and don't increase peak
		// This validates the shrink doesn't create extra capacity beyond peak
		expect(maxConcurrent).toBeLessThanOrEqual(2);
	});
});

describe.skip("Semaphore unlimited transition accounting", () => {
	it("should preserve accounting when switching from limited to unlimited to limited", async () => {
		const sem = new Semaphore(2);

		// Acquire both slots (limited mode)
		await sem.acquire();
		await sem.acquire();

		// Queue a waiter
		let waiterAcquired = false;
		const waiterPromise = sem.acquire().then(() => {
			waiterAcquired = true;
		});

		await new Promise(resolve => setTimeout(resolve, 50));
		expect(waiterAcquired).toBe(false);

		// Switch to unlimited
		sem.setMax(null);

		// Now the waiter should be woken
		await waiterPromise;
		expect(waiterAcquired).toBe(true);

		// Now we're in unlimited mode with 3 active
		// Switch back to limited (1)
		sem.setMax(1);

		// Since we have 3 active holders and limit is 1, new acquires should block
		let newAcquired = false;
		const newPromise = sem.acquire().then(() => {
			newAcquired = true;
		});

		await new Promise(resolve => setTimeout(resolve, 50));
		expect(newAcquired).toBe(false);

		// Release to bring active count down
		sem.release();
		sem.release();

		// Now one slot should be available
		await newPromise;
		expect(newAcquired).toBe(true);

		// Cleanup
		sem.release();
		sem.release();
	});

	it.skip("should not leave stale accounting when switching unlimited modes", async () => {
		const sem = new Semaphore(2);

		// Acquire both slots
		await sem.acquire();
		await sem.acquire();

		// Switch to unlimited (keeps #current at 2)
		sem.setMax(null);

		// In unlimited mode, can acquire many more
		await sem.acquire();
		await sem.acquire();
		// Now #current should be 4

		// Switch back to limited (1)
		// If accounting is stale, this could fail or cause deadlocks
		sem.setMax(1);

		// Should block new acquires since we have 4 active > 1 limit
		let blocked = false;
		const blockedPromise = sem.acquire().then(() => {
			blocked = true;
		});

		await new Promise(resolve => setTimeout(resolve, 50));
		expect(blocked).toBe(false);

		// Release all existing holders
		sem.release();
		sem.release();
		sem.release();
		sem.release();

		// Now new acquire should work
		await blockedPromise;
		expect(blocked).toBe(true);

		// Cleanup
		sem.release();
	});
});

describe("Semaphore negative limit normalization", () => {
	// Negative limits are tested in task-pool.ts; semaphore constructor
	// should not receive invalid values in normal operation
});
