import { describe, expect, it } from "bun:test";
import { createWatchdog, iterateWithIdleTimeout } from "../src/utils/idle-iterator";

// One past the 32-bit setTimeout limit (about 24.9 days); setTimeout would treat it as 1 ms.
const BEYOND_TIMER_LIMIT_MS = 2 ** 31;

describe("idle watchdogs beyond the setTimeout limit", () => {
	it("does not abort a slow stream when the idle and first-item timeouts are very long", async () => {
		// Given a stream that pauses 50 ms between items.
		async function* slow(): AsyncGenerator<number> {
			yield 1;
			await Bun.sleep(50);
			yield 2;
		}

		// When it is read with idle and first-item timeouts past the timer limit.
		const items: number[] = [];
		for await (const item of iterateWithIdleTimeout(slow(), {
			idleTimeoutMs: BEYOND_TIMER_LIMIT_MS,
			firstItemTimeoutMs: BEYOND_TIMER_LIMIT_MS,
			errorMessage: "idle timeout",
		})) {
			items.push(item);
		}

		// Then every item arrives instead of an immediate idle timeout.
		expect(items).toEqual([1, 2]);
	});

	it("does not fire a first-event watchdog with a very long timeout right away", async () => {
		let fired = false;
		const watchdog = createWatchdog(BEYOND_TIMER_LIMIT_MS, () => {
			fired = true;
		});
		try {
			await Bun.sleep(30);
		} finally {
			if (watchdog) clearTimeout(watchdog);
		}
		expect(fired).toBe(false);
	});
});
