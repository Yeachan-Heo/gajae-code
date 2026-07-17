import { describe, expect, it } from "bun:test";
import { SlidingWindowBudget } from "../src/providers/anthropic-fallback-budget";

// Unit contract for the keyed sliding budget behind the Anthropic
// fallback-capacity downgrade (#2464 third review): keyed isolation,
// injectable monotonic clock (window expiry / non-advancing clock), and
// lifecycle pruning -- all without any test-reset hook on the provider.
describe("SlidingWindowBudget", () => {
	const makeClock = (start = 0) => {
		let now = start;
		return {
			now: () => now,
			advance: (ms: number) => {
				now += ms;
			},
		};
	};

	it("caps each key independently -- one identity cannot starve another", () => {
		const clock = makeClock();
		const budget = new SlidingWindowBudget(2, 60_000, clock.now);
		expect(budget.take("origin-a#cred-1")).toBe(true);
		expect(budget.take("origin-a#cred-1")).toBe(true);
		expect(budget.take("origin-a#cred-1")).toBe(false);
		// Different credential, same origin: untouched allowance.
		expect(budget.take("origin-a#cred-2")).toBe(true);
		// Different origin, same credential: untouched allowance.
		expect(budget.take("origin-b#cred-1")).toBe(true);
	});

	it("refills after the window elapses on a monotonic clock", () => {
		const clock = makeClock();
		const budget = new SlidingWindowBudget(2, 60_000, clock.now);
		expect(budget.take("k")).toBe(true);
		expect(budget.take("k")).toBe(true);
		expect(budget.take("k")).toBe(false);
		clock.advance(59_999);
		expect(budget.take("k")).toBe(false);
		clock.advance(2);
		expect(budget.take("k")).toBe(true);
	});

	it("stays conservative under a non-advancing clock", () => {
		const budget = new SlidingWindowBudget(2, 60_000, () => 1_000);
		expect(budget.take("k")).toBe(true);
		expect(budget.take("k")).toBe(true);
		// The window can never elapse if time does not advance -- the budget
		// stays spent (fail-closed) rather than refilling spuriously.
		expect(budget.take("k")).toBe(false);
		expect(budget.take("k")).toBe(false);
	});

	it("prunes expired identities so the store stays bounded", () => {
		const clock = makeClock();
		const budget = new SlidingWindowBudget(1, 60_000, clock.now);
		for (let i = 0; i < 50; i++) budget.take(`key-${i}`);
		expect(budget.activeKeyCount).toBe(50);
		clock.advance(60_001);
		budget.take("fresh");
		expect(budget.activeKeyCount).toBe(1);
	});
});
