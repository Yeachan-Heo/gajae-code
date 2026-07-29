import { describe, expect, test } from "bun:test";
import { isWorkflowContinuationInert } from "@gajae-code/coding-agent/skill-state/active-state";

/**
 * Continuation-inertness policy for compaction auto-continue: manifest-terminal
 * and explicitly integration-inert phases are inert; unknown skills and phases
 * fail closed. Generic Ultragoal blockers remain active, while verified human
 * waits are represented by a paused inline goal.
 */
describe("isWorkflowContinuationInert", () => {
	test("manifest-terminal phases are inert", () => {
		expect(isWorkflowContinuationInert("ralplan", "final")).toBe(true);
		expect(isWorkflowContinuationInert("ralplan", "handoff")).toBe(true);
		expect(isWorkflowContinuationInert("deep-interview", "complete")).toBe(true);
		expect(isWorkflowContinuationInert("team", "complete")).toBe(true);
		expect(isWorkflowContinuationInert("team", "failed")).toBe(true);
		expect(isWorkflowContinuationInert("ultragoal", "complete")).toBe(true);
		expect(isWorkflowContinuationInert("ultragoal", "failed")).toBe(true);
	});

	test("explicit nonterminal integration phases are inert", () => {
		expect(isWorkflowContinuationInert("team", "awaiting_integration")).toBe(true);
	});

	test("known active nonterminal phases are not inert", () => {
		expect(isWorkflowContinuationInert("ultragoal", "active")).toBe(false);
		expect(isWorkflowContinuationInert("ultragoal", "blocked")).toBe(false);
		expect(isWorkflowContinuationInert("deep-interview", "interviewing")).toBe(false);
		expect(isWorkflowContinuationInert("ralplan", "planner")).toBe(false);
		expect(isWorkflowContinuationInert("team", "running")).toBe(false);
	});

	test("phase matching is case-insensitive", () => {
		expect(isWorkflowContinuationInert("ralplan", "Final")).toBe(true);
		expect(isWorkflowContinuationInert("ultragoal", "Active")).toBe(false);
	});

	test("unknown skills fail closed", () => {
		expect(isWorkflowContinuationInert("not-a-workflow", "active")).toBe(true);
	});

	test("unknown phases on a canonical skill fail closed", () => {
		expect(isWorkflowContinuationInert("ultragoal", "unknown")).toBe(true);
		expect(isWorkflowContinuationInert("ultragoal", "executing")).toBe(true);
	});
});
