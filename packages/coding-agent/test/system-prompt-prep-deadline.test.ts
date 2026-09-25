import { describe, expect, it } from "bun:test";
import { waitForResponsiveBudget } from "@gajae-code/coding-agent/system-prompt";

describe("waitForResponsiveBudget", () => {
	it("does not let a starved event loop consume the budget", async () => {
		// Regression for #5949: concurrent in-process sessions block the loop with
		// synchronous startup work, and a wall-clock deadline then fires before
		// already-finished prompt-file I/O is observed.
		const started = performance.now();
		let expired = false;
		const deadline = waitForResponsiveBudget(200, 20).then(() => {
			expired = true;
		});
		await Bun.sleep(1);
		Bun.sleepSync(500);
		await Bun.sleep(0);
		expect(expired).toBe(false);
		await deadline;
		expect(performance.now() - started).toBeGreaterThanOrEqual(500);
	});

	it("expires after the budget when the loop stays responsive", async () => {
		const started = performance.now();
		await waitForResponsiveBudget(100, 20);
		const elapsed = performance.now() - started;
		expect(elapsed).toBeGreaterThanOrEqual(95);
		expect(elapsed).toBeLessThan(1_000);
	});
});
