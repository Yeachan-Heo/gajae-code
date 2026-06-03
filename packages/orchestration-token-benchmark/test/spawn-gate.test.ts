import { describe, expect, it } from "bun:test";
import { FANOUT_4_OK, FANOUT_5_PLAN_OK, FANOUT_5_REJECT } from "../src/fixtures";
import {
	DEFAULT_SPAWN_THRESHOLD,
	evaluateSpawnGate,
	evaluateSpawnGateAtThreshold,
	type SpawnPlanReceipt,
} from "../src/spawn-gate";

const COMPLETE_PLAN: SpawnPlanReceipt = {
	whyParallel: "independent slices",
	whyNotLocal: "cross-file edits",
	independence: "no shared files",
	expectedReceiptShape: "status + files",
	maxInlineTokens: 1500,
};

describe("evaluateSpawnGate (hard runtime gate)", () => {
	it("locks the hard threshold at 4", () => {
		expect(DEFAULT_SPAWN_THRESHOLD).toBe(4);
	});

	it("allows a batch at the threshold without a plan", () => {
		const decision = evaluateSpawnGate(FANOUT_4_OK);
		expect(decision.outcome).toBe("allowed");
		expect(decision.planRequired).toBe(false);
	});

	it("rejects a batch above the threshold with no plan", () => {
		const decision = evaluateSpawnGate(FANOUT_5_REJECT);
		expect(decision.outcome).toBe("rejected");
		expect(decision.planRequired).toBe(true);
		expect(decision.missingFields.length).toBeGreaterThan(0);
	});

	it("allows a batch above the threshold with a complete plan", () => {
		const decision = evaluateSpawnGate(FANOUT_5_PLAN_OK);
		expect(decision.outcome).toBe("allowed");
		expect(decision.missingFields).toHaveLength(0);
	});

	it("rejects an incomplete plan and names the missing fields", () => {
		const decision = evaluateSpawnGate({
			childCount: 8,
			plan: { ...COMPLETE_PLAN, whyParallel: "  ", maxInlineTokens: 0 },
		});
		expect(decision.outcome).toBe("rejected");
		expect(decision.missingFields).toContain("whyParallel");
		expect(decision.missingFields).toContain("maxInlineTokens");
	});

	it("exposes no threshold override that could bypass the receipt for fanout > 4", () => {
		// A large batch always requires a plan, regardless of how the request is shaped.
		for (const childCount of [5, 6, 9, 32]) {
			expect(evaluateSpawnGate({ childCount }).outcome).toBe("rejected");
			expect(evaluateSpawnGate({ childCount, plan: COMPLETE_PLAN }).outcome).toBe("allowed");
		}
	});

	it("rejects invalid inputs", () => {
		expect(() => evaluateSpawnGate({ childCount: -1 })).toThrow();
		expect(() => evaluateSpawnGate({ childCount: 1.5 })).toThrow();
	});
});

describe("evaluateSpawnGateAtThreshold (benchmark-only sweep)", () => {
	it("honors a custom threshold at exact boundaries", () => {
		expect(evaluateSpawnGateAtThreshold(2, 2).outcome).toBe("allowed");
		expect(evaluateSpawnGateAtThreshold(3, 2).outcome).toBe("rejected");
		expect(evaluateSpawnGateAtThreshold(3, 2, COMPLETE_PLAN).outcome).toBe("allowed");
	});

	it("rejects invalid threshold inputs", () => {
		expect(() => evaluateSpawnGateAtThreshold(2, 0)).toThrow();
		expect(() => evaluateSpawnGateAtThreshold(2, 1.5)).toThrow();
	});
});
