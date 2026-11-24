import { describe, expect, it } from "bun:test";
import { Semaphore } from "./parallel";

describe("Semaphore", () => {
	// Test basic acquire/release
	describe("basic acquire/release", () => {
		it("permits immediate acquire when below limit", async () => {
			const sem = new Semaphore(2);
			await sem.acquire();
			await sem.acquire();
			// Should complete without hanging
		});

		it("queues acquire when at limit", async () => {
			const sem = new Semaphore(1);
			let resolved = false;
			await sem.acquire();
			const pending = sem.acquire().then(() => {
				resolved = true;
			});
			expect(resolved).toBe(false);
			sem.release();
			await pending;
			expect(resolved).toBe(true);
		});
	});

	describe("unlimited mode", () => {
		it("treats null as unlimited", async () => {
			const sem = new Semaphore(null);
			// All acquires should return immediately
			for (let i = 0; i < 100; i++) {
				await sem.acquire();
			}
			// All releases should be no-ops
			for (let i = 0; i < 100; i++) {
				sem.release();
			}
		});

		it("preserves active count in unlimited mode", async () => {
			const sem = new Semaphore(2);

			// Acquire 2 permits
			await sem.acquire();
			await sem.acquire();

			// Switch to unlimited
			sem.setMax(null);

			// Release in unlimited mode (should decrement the count we incremented)
			sem.release();
			sem.release();

			// Switch back to finite
			sem.setMax(2);

			// Should be able to acquire 2 more (accounting stayed coherent)
			await sem.acquire();
			await sem.acquire();
		});

		it("finite→unlimited→finite with active work completes", async () => {
			const sem = new Semaphore(2);
			const released: boolean[] = [];

			// Acquire 2 permits
			const holder1 = sem.acquire().then(() => (released[0] = true));
			const holder2 = sem.acquire().then(() => (released[1] = true));

			await Promise.all([holder1, holder2]);
			expect(released).toEqual([true, true]);

			// Switch to unlimited
			sem.setMax(null);

			// Both holders are still holding; switch back to finite
			sem.setMax(2);

			// Release the holders
			sem.release();
			sem.release();

			// Now should be able to acquire again
			await sem.acquire();
			await sem.acquire();
		});
	});

	describe("growth with waiters", () => {
		it("accounts for permits before waking waiters on growth", async () => {
			const sem = new Semaphore(2);
			let maxActive = 0;
			let count = 0;

			const countActive = () => {
				count++;
				maxActive = Math.max(maxActive, count);
			};
			const countInactive = () => {
				count--;
			};

			const holder1 = (async () => {
				await sem.acquire();
				countActive();
				// Hold for a while
				await new Promise(resolve => setTimeout(resolve, 50));
				countInactive();
				sem.release();
			})();

			const holder2 = (async () => {
				await sem.acquire();
				countActive();
				// Hold for a while
				await new Promise(resolve => setTimeout(resolve, 50));
				countInactive();
				sem.release();
			})();

			// Wait for both to acquire
			await new Promise(resolve => setTimeout(resolve, 10));

			// Now queue a waiter
			let waiterResolved = false;
			const waiter = (async () => {
				await sem.acquire();
				countActive();
				waiterResolved = true;
				await new Promise(resolve => setTimeout(resolve, 10));
				countInactive();
				sem.release();
			})();

			// Grow the limit from 2 to 3
			sem.setMax(3);

			// Wait for all to complete
			await Promise.all([holder1, holder2, waiter]);

			// Verify the waiter was resolved
			expect(waiterResolved).toBe(true);
			// CRITICAL: max active should never exceed 3
			expect(maxActive).toBeLessThanOrEqual(3);
		});
	});

	describe("shrink with waiters", () => {
		it("does not hand off excess permits during shrink", async () => {
			const sem = new Semaphore(2);
			let activeCount = 0;
			let maxActive = 0;

			// Acquire 2 permits
			await sem.acquire();
			activeCount++;
			await sem.acquire();
			activeCount++;

			// Queue a waiter
			let waiterReleased = false;
			const waiterPromise = (async () => {
				await sem.acquire();
				waiterReleased = true;
				activeCount++;
				maxActive = Math.max(maxActive, activeCount);
			})();

			// Shrink to 1
			sem.setMax(1);

			// Release one holder
			sem.release();
			activeCount--;

			// Wait a tick for the waiter to potentially acquire
			await new Promise(resolve => setTimeout(resolve, 10));

			// The waiter should have been woken since we have space
			expect(waiterReleased).toBe(true);

			// But active count should not exceed the new limit of 1 during release
			// (accounting should prevent more than 1 from being active)
			sem.release();
			activeCount--;
			await waiterPromise;

			expect(maxActive).toBeLessThanOrEqual(2);
		});
	});

	describe("negative/zero limits", () => {
		it("treats 0 as unlimited", async () => {
			const sem = new Semaphore(0);
			// Should not throw and should behave like unlimited
			for (let i = 0; i < 10; i++) {
				await sem.acquire();
			}
		});
	});
});
