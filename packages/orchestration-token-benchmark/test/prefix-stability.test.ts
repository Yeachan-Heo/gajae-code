import { describe, expect, it } from "bun:test";
import { MODEL_SWITCH_FAIL, MODEL_SWITCH_RESET, PREFIX_MUTATION_FAIL, PREFIX_STABLE } from "../src/fixtures";
import { checkPrefixStability, hashPrefix } from "../src/prefix-stability";

describe("hashPrefix", () => {
	it("is stable for identical input", () => {
		expect(hashPrefix("SYSTEM+TOOLS")).toBe(hashPrefix("SYSTEM+TOOLS"));
	});

	it("differs for different input", () => {
		expect(hashPrefix("SYSTEM+TOOLS")).not.toBe(hashPrefix("SYSTEM+TOOLS+EXTRA"));
	});
});

describe("checkPrefixStability", () => {
	it("passes a stable single epoch", () => {
		const result = checkPrefixStability(PREFIX_STABLE);
		expect(result.stable).toBe(true);
		expect(result.epochs).toBe(1);
		expect(result.violations).toHaveLength(0);
	});

	it("flags a mid-epoch prefix mutation", () => {
		const result = checkPrefixStability(PREFIX_MUTATION_FAIL);
		expect(result.stable).toBe(false);
		expect(result.violations).toHaveLength(1);
		expect(result.violations[0]?.kind).toBe("prefix-mutation");
		expect(result.violations[0]?.turn).toBe(2);
	});

	it("flags a mid-epoch model switch without a reset marker", () => {
		const result = checkPrefixStability(MODEL_SWITCH_FAIL);
		expect(result.stable).toBe(false);
		expect(result.violations.some(v => v.kind === "model-switch")).toBe(true);
	});

	it("allows a model switch that carries a deliberate reset marker", () => {
		const result = checkPrefixStability(MODEL_SWITCH_RESET);
		expect(result.stable).toBe(true);
		expect(result.epochs).toBe(2);
		expect(result.violations).toHaveLength(0);
	});

	it("treats an empty sequence as stable with zero epochs", () => {
		expect(checkPrefixStability([])).toEqual({ stable: true, epochs: 0, violations: [] });
	});

	it("flags a cache-key change within an epoch", () => {
		const result = checkPrefixStability([
			{ turn: 1, prefix: "P", model: "m", cacheKey: "k1" },
			{ turn: 2, prefix: "P", model: "m", cacheKey: "k2" },
		]);
		expect(result.stable).toBe(false);
		expect(result.violations[0]?.kind).toBe("cache-key-change");
	});
});
