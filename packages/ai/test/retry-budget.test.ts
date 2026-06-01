import { describe, expect, it } from "bun:test";
import { resolveRetryBudget } from "../src/utils/retry-budget";

describe("resolveRetryBudget", () => {
	it("keeps provider defaults when unset", () => {
		expect(resolveRetryBudget(undefined, 5)).toBe(5);
	});

	it("clamps configured retry budgets to non-negative integers", () => {
		expect(resolveRetryBudget(0, 5)).toBe(0);
		expect(resolveRetryBudget(4.8, 5)).toBe(4);
		expect(resolveRetryBudget(-1, 5)).toBe(0);
		expect(resolveRetryBudget(Number.NaN, 5)).toBe(5);
	});
});
