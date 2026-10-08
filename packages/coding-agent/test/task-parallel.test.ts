import { describe, expect, test } from "bun:test";
import { mapWithConcurrencyLimit } from "@gajae-code/coding-agent/task/parallel";

describe("mapWithConcurrencyLimit worker ownership", () => {
	test("aborts and joins in-flight siblings before rejecting the batch", async () => {
		const siblingStarted = Promise.withResolvers<void>();
		const scheduled: string[] = [];
		let siblingObservedAbort = false;
		let siblingSettled = false;

		const result = mapWithConcurrencyLimit(
			["failure", "sibling", "must-not-start"],
			2,
			async (item, _index, signal) => {
				scheduled.push(item);
				if (item === "failure") {
					await siblingStarted.promise;
					throw new Error("cleanupIsolation failed");
				}
				if (item === "sibling") {
					siblingStarted.resolve();
					await new Promise<void>(resolve => {
						signal.addEventListener(
							"abort",
							() => {
								siblingObservedAbort = true;
								setTimeout(resolve, 25);
							},
							{ once: true },
						);
					});
					siblingSettled = true;
					return "cancelled";
				}
				return item;
			},
		);

		await expect(result).rejects.toThrow("cleanupIsolation failed");
		expect(siblingObservedAbort).toBe(true);
		expect(siblingSettled).toBe(true);
		expect(scheduled).toEqual(["failure", "sibling"]);
	});

	test("propagates external cancellation and waits for worker cleanup", async () => {
		const controller = new AbortController();
		let workerSettled = false;
		const running = mapWithConcurrencyLimit(
			["done", "cancelled", "not-started"],
			1,
			async (item, _index, signal) => {
				if (item === "cancelled") {
					await new Promise<void>(resolve =>
						signal.addEventListener("abort", () => setTimeout(resolve, 20), { once: true }),
					);
					workerSettled = true;
				}
				return item;
			},
			controller.signal,
		);
		await Bun.sleep(10);
		controller.abort();

		const result = await running;
		expect(result.aborted).toBe(true);
		expect(workerSettled).toBe(true);
		expect(result.results).toEqual(["done", "cancelled", undefined]);
	});

	test("does not hide a cleanup failure that races with external cancellation", async () => {
		const controller = new AbortController();
		const running = mapWithConcurrencyLimit(
			["cleanup"],
			1,
			async (_item, _index, signal) => {
				await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
				throw new Error("cleanup failed while cancelled");
			},
			controller.signal,
		);
		await Bun.sleep(10);
		controller.abort();

		await expect(running).rejects.toThrow("cleanup failed while cancelled");
	});
});
