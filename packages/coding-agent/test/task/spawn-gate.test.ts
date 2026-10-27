import { describe, expect, it } from "bun:test";
import { toolWireSchema } from "@gajae-code/ai/utils/schema";
import { DEFAULT_SPAWN_THRESHOLD, evaluateSpawnGate, type SpawnPlanReceipt } from "../../src/task/spawn-gate";
import { getTaskSchema } from "../../src/task/types";

const completePlan: SpawnPlanReceipt = {
	whyParallel: "Independent file slices can run together.",
	whyNotLocal: "Local execution would serialize unrelated investigation.",
	independence: "Each task owns disjoint files and can report independently.",
	expectedReceiptShape: "Each child returns changed files and evidence.",
	maxInlineTokens: 1200,
};

describe("task spawn gate", () => {
	it("allows batches at or below the hard threshold without a plan", () => {
		expect(DEFAULT_SPAWN_THRESHOLD).toBe(4);
		expect(evaluateSpawnGate({ childCount: 4 }).outcome).toBe("allowed");
	});

	it("rejects a batch above the threshold without a plan", () => {
		const decision = evaluateSpawnGate({ childCount: 5 });
		expect(decision.outcome).toBe("rejected");
		expect(decision.planRequired).toBe(true);
		expect(decision.missingFields).toEqual([
			"whyParallel",
			"whyNotLocal",
			"independence",
			"expectedReceiptShape",
			"maxInlineTokens",
		]);
	});

	it("allows a batch above the threshold with a complete plan", () => {
		const decision = evaluateSpawnGate({ childCount: 5, plan: completePlan });
		expect(decision.outcome).toBe("allowed");
		expect(decision.planRequired).toBe(true);
		expect(decision.missingFields).toEqual([]);
	});

	it.each([
		"whyParallel",
		"whyNotLocal",
		"independence",
		"expectedReceiptShape",
		"maxInlineTokens",
	] as const)("rejects a batch above the threshold when %s is missing", field => {
		const plan = { ...completePlan };
		if (field === "maxInlineTokens") {
			plan.maxInlineTokens = 0;
		} else {
			plan[field] = "";
		}

		const decision = evaluateSpawnGate({ childCount: 5, plan });
		expect(decision.outcome).toBe("rejected");
		expect(decision.missingFields).toContain(field);
	});

	it("validates childCount", () => {
		expect(() => evaluateSpawnGate({ childCount: -1 })).toThrow("childCount must be a non-negative integer");
		expect(() => evaluateSpawnGate({ childCount: 1.5 })).toThrow("childCount must be a non-negative integer");
	});
});
describe("task schema spawnPlan", () => {
	it.each([
		{ isolationEnabled: true, simpleMode: "default" },
		{ isolationEnabled: false, simpleMode: "default" },
		{ isolationEnabled: true, simpleMode: "schema-free" },
		{ isolationEnabled: false, simpleMode: "schema-free" },
		{ isolationEnabled: true, simpleMode: "independent" },
		{ isolationEnabled: false, simpleMode: "independent" },
	] as const)("accepts spawnPlan in %#", options => {
		const schema = toolWireSchema({ name: "task", description: "Task", parameters: getTaskSchema(options) });
		expect((schema.properties as Record<string, unknown> | undefined)?.spawnPlan).toBeDefined();
	});
});
