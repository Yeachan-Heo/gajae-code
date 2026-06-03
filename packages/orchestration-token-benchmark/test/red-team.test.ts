import { describe, expect, it } from "bun:test";
import {
	assertTokenLogShape,
	cacheHitRate,
	checkPrefixStability,
	computeTokenMetrics,
	evaluateSpawnGate,
	evaluateSpawnGateAtThreshold,
	type PrefixTurn,
	runOrchestrationTokenBenchmark,
	type SpawnPlanReceipt,
	type TokenLogEntry,
} from "../src";

const COMPLETE_PLAN: SpawnPlanReceipt = {
	whyParallel: "independent slices",
	whyNotLocal: "cannot be done locally without context loss",
	independence: "no shared mutable state",
	expectedReceiptShape: "files + decisions + evidence",
	maxInlineTokens: 1000,
};

function walkJson(value: unknown, visit: (value: unknown, path: string) => void, path = "$."): void {
	visit(value, path);
	if (Array.isArray(value)) {
		for (const [index, entry] of value.entries()) {
			walkJson(entry, visit, `${path}[${index}]`);
		}
		return;
	}
	if (value !== null && typeof value === "object") {
		for (const [key, entry] of Object.entries(value)) {
			walkJson(entry, visit, `${path}${key}.`);
		}
	}
}

function finiteNumber(value: number): void {
	expect(Number.isFinite(value)).toBe(true);
	expect(Number.isNaN(value)).toBe(false);
}

function tokenLog(overrides: Partial<TokenLogEntry> = {}): TokenLogEntry {
	const input = overrides.input ?? 0;
	const output = overrides.output ?? 0;
	const cacheRead = overrides.cacheRead ?? 0;
	const cacheWrite = overrides.cacheWrite ?? 0;
	return {
		subagentId: "red-team",
		turn: 1,
		at: "2026-06-03T00:00:00.000Z",
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: input + output + cacheRead + cacheWrite,
		...overrides,
	};
}

describe("red-team deterministic benchmark invariants", () => {
	it("runOrchestrationTokenBenchmark is repeatable and contains no NaN", () => {
		const first = runOrchestrationTokenBenchmark();
		const second = runOrchestrationTokenBenchmark();
		const third = runOrchestrationTokenBenchmark();

		expect(second).toEqual(first);
		expect(third).toEqual(first);
		walkJson(first, (value, path) => {
			if (typeof value === "number") {
				expect(Number.isNaN(value), `${path} must not be NaN`).toBe(false);
				expect(Number.isFinite(value), `${path} must be finite`).toBe(true);
			}
		});
	});
});

describe("red-team token metric numeric safety", () => {
	it("cacheHitRate never emits NaN or Infinity and stays within [0, 1]", () => {
		const cases: Array<[number, number]> = [
			[0, 0],
			[0, 1e15],
			[1e15, 0],
			[1e15, 1e15],
			[1, 1e15],
			[1e15, 1],
			[123_456_789, 987_654_321],
		];

		for (const [input, cacheRead] of cases) {
			const rate = cacheHitRate(input, cacheRead);
			finiteNumber(rate);
			expect(rate).toBeGreaterThanOrEqual(0);
			expect(rate).toBeLessThanOrEqual(1);
		}
	});

	it("computeTokenMetrics never emits NaN or Infinity for zero, large, and mixed inputs", () => {
		const logs: TokenLogEntry[] = [
			tokenLog(),
			tokenLog({ turn: 2, input: 1e15, output: 1e15, cacheRead: 0, cacheWrite: 1e15, totalTokens: 3e15 }),
			tokenLog({ turn: 3, input: 1, output: 2, cacheRead: 1e15, cacheWrite: 3, totalTokens: 1e15 + 6 }),
		];

		for (const metrics of [computeTokenMetrics([]), computeTokenMetrics(logs)]) {
			for (const value of Object.values(metrics)) {
				finiteNumber(value);
			}
			expect(metrics.cacheHitRate).toBeGreaterThanOrEqual(0);
			expect(metrics.cacheHitRate).toBeLessThanOrEqual(1);
		}
	});
});

describe("red-team prefix stability adversarial sequences", () => {
	it("reports multiple violation kinds on the same turn", () => {
		const result = checkPrefixStability([
			{ turn: 1, prefix: "base", model: "model-a", cacheKey: "cache-a" },
			{ turn: 2, prefix: "mutated", model: "model-b", cacheKey: "cache-b" },
		]);

		expect(result.stable).toBe(false);
		expect(result.epochs).toBe(1);
		expect(result.violations.map(violation => violation.kind)).toEqual([
			"prefix-mutation",
			"model-switch",
			"cache-key-change",
		]);
	});

	it("treats multiple reset epochs in a row as sanctioned new anchors", () => {
		const turns: PrefixTurn[] = [
			{ turn: 1, prefix: "epoch-1", model: "model-a", cacheKey: "cache-a" },
			{ turn: 2, prefix: "epoch-2", model: "model-b", cacheKey: "cache-b", resetMarker: { reason: "compaction" } },
			{
				turn: 3,
				prefix: "epoch-3",
				model: "model-c",
				cacheKey: "cache-c",
				resetMarker: { reason: "session-reset" },
			},
			{ turn: 4, prefix: "epoch-3", model: "model-c", cacheKey: "cache-c" },
		];
		const result = checkPrefixStability(turns);

		expect(result.stable).toBe(true);
		expect(result.epochs).toBe(3);
		expect(result.violations).toHaveLength(0);
	});

	it("allows a reset marker on turn 1 without creating a phantom violation", () => {
		const result = checkPrefixStability([
			{
				turn: 1,
				prefix: "initial",
				model: "model-a",
				cacheKey: "cache-a",
				resetMarker: { reason: "deliberate-reset" },
			},
			{ turn: 2, prefix: "initial", model: "model-a", cacheKey: "cache-a" },
		]);

		expect(result.stable).toBe(true);
		expect(result.epochs).toBe(1);
		expect(result.violations).toHaveLength(0);
	});
});

describe("red-team spawn gate boundaries", () => {
	it("allows childCount equal to threshold and requires a plan at threshold + 1", () => {
		expect(evaluateSpawnGate({ childCount: 4 }).outcome).toBe("allowed");
		expect(evaluateSpawnGate({ childCount: 5 }).outcome).toBe("rejected");
		expect(evaluateSpawnGate({ childCount: 5, plan: COMPLETE_PLAN }).outcome).toBe("allowed");
	});

	it("honors custom thresholds at exact boundaries (benchmark-only sweep)", () => {
		expect(evaluateSpawnGateAtThreshold(2, 2).outcome).toBe("allowed");
		expect(evaluateSpawnGateAtThreshold(3, 2).outcome).toBe("rejected");
		expect(evaluateSpawnGateAtThreshold(3, 2, COMPLETE_PLAN).outcome).toBe("allowed");
	});

	it("rejects whitespace-only plan fields", () => {
		const decision = evaluateSpawnGate({
			childCount: 5,
			plan: {
				whyParallel: " \t ",
				whyNotLocal: "\n",
				independence: "\r\n",
				expectedReceiptShape: "  ",
				maxInlineTokens: 1,
			},
		});

		expect(decision.outcome).toBe("rejected");
		expect(decision.missingFields).toEqual(["whyParallel", "whyNotLocal", "independence", "expectedReceiptShape"]);
	});

	it("throws on non-integer and negative request inputs", () => {
		expect(() => evaluateSpawnGate({ childCount: 1.5 })).toThrow(RangeError);
		expect(() => evaluateSpawnGate({ childCount: -1 })).toThrow(RangeError);
		expect(() => evaluateSpawnGateAtThreshold(2, 1.5)).toThrow(RangeError);
		expect(() => evaluateSpawnGateAtThreshold(2, -1)).toThrow(RangeError);
	});
});

describe("red-team token log shape rejection", () => {
	it("rejects NaN and Infinity numeric fields", () => {
		for (const field of ["turn", "input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) {
			expect(() => assertTokenLogShape({ ...tokenLog(), [field]: Number.NaN })).toThrow(TypeError);
			expect(() => assertTokenLogShape({ ...tokenLog(), [field]: Number.POSITIVE_INFINITY })).toThrow(TypeError);
			expect(() => assertTokenLogShape({ ...tokenLog(), [field]: Number.NEGATIVE_INFINITY })).toThrow(TypeError);
		}
	});

	it("rejects missing required fields", () => {
		for (const field of [
			"subagentId",
			"at",
			"turn",
			"input",
			"output",
			"cacheRead",
			"cacheWrite",
			"totalTokens",
		] as const) {
			const log: Record<string, unknown> = { ...tokenLog() };
			delete log[field];
			expect(() => assertTokenLogShape(log), `${field} should be required`).toThrow(TypeError);
		}
	});
});
