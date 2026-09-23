import { describe, expect, test } from "bun:test";
import { type DecisionTier, truncateUtf8, validateDecisionResult } from "../src/task/decision-model";

describe("task decision model", () => {
	test("caps assignment by UTF-8 bytes and preserves marker", () => {
		const value = truncateUtf8("😀한字".repeat(2000));
		expect(new TextEncoder().encode(value).byteLength).toBeLessThanOrEqual(4096);
		expect(value.endsWith("…[truncated]")).toBe(true);
	});

	test("accepts only finite probabilities for known candidates", () => {
		const candidates: Record<DecisionTier, string> = { fast: "small", balanced: "medium", strong: "large" };
		expect(
			validateDecisionResult(
				{ choice: "balanced", probabilities: { fast: 0.2, balanced: 0.5, strong: 0.3 }, confidence: 0.8 },
				candidates,
			)?.choice,
		).toBe("balanced");
		expect(
			validateDecisionResult(
				{ choice: "balanced", probabilities: { fast: 0.2, balanced: Number.NaN, strong: 0.8 }, confidence: 0.8 },
				candidates,
			),
		).toBeUndefined();
	});
});
