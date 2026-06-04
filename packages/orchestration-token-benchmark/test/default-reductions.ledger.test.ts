import { describe, expect, test } from "bun:test";
import { evaluateDefaultReduction } from "../src/default-reduction-gate";
import { APPLIED_DEFAULT_REDUCTIONS, HELD_DEFAULT_REDUCTIONS } from "../src/default-reductions.ledger";

const CURRENT_TASK_MAX_CONCURRENCY_DEFAULT = 8;
const CURRENT_FULL_FORK_CONTEXT_FALLBACK_TOKENS = 15_000;
const CURRENT_FULL_FORK_CONTEXT_FRACTION = 0.15;

describe("default reduction evidence ledger", () => {
	test("allows every applied default reduction", () => {
		for (const entry of APPLIED_DEFAULT_REDUCTIONS) {
			expect(evaluateDefaultReduction(entry.evidence), entry.evidence.name).toEqual({
				outcome: "allowed",
				reasons: [],
			});
		}
	});

	test("mechanically records the current task concurrency default", () => {
		const entry = APPLIED_DEFAULT_REDUCTIONS.find(
			candidate => candidate.evidence.name === "task.maxConcurrency.default.32-to-8",
		);

		expect(entry).toBeDefined();
		expect(entry!.evidence.before).toBe(32);
		expect(entry!.evidence.after).toBe(CURRENT_TASK_MAX_CONCURRENCY_DEFAULT);
	});

	test("mechanically records the current full fork-context fallback and fraction defaults", () => {
		const fallbackEntry = APPLIED_DEFAULT_REDUCTIONS.find(
			candidate => candidate.evidence.name === "task.forkContext.fullFallback.maxTokens.25000-to-15000",
		);
		const fractionEntry = APPLIED_DEFAULT_REDUCTIONS.find(
			candidate => candidate.evidence.name === "task.forkContext.fullFraction.0.25-to-0.15",
		);

		expect(fallbackEntry).toBeDefined();
		expect(fallbackEntry!.evidence.before).toBe(25_000);
		expect(fallbackEntry!.evidence.after).toBe(CURRENT_FULL_FORK_CONTEXT_FALLBACK_TOKENS);
		expect(fractionEntry).toBeDefined();
		expect(fractionEntry!.evidence.before).toBe(0.25);
		expect(fractionEntry!.evidence.after).toBe(CURRENT_FULL_FORK_CONTEXT_FRACTION);
	});

	test("blocks every held default reduction until PR9 live evidence exists", () => {
		for (const entry of HELD_DEFAULT_REDUCTIONS) {
			expect(evaluateDefaultReduction(entry.candidate).outcome, entry.candidate.name).toBe("blocked");
			expect(entry.requiresLiveEvidenceVia).toBe("pr9-live-runner");
			expect(entry.reason).toContain("HELD/BLOCKED");
			expect(entry.reason).toContain("PR9 live before/after runner evidence is required");
		}
	});
});
