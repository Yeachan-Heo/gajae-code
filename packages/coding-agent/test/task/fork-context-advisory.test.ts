import { describe, expect, it } from "bun:test";
import { adviseForkContextMode } from "../../src/task/fork-context-advisory";
import type { ForkContextMode } from "../../src/task/types";

const FORK_CONTEXT_MODES: ForkContextMode[] = ["none", "receipt", "last-turn", "bounded", "full"];

describe("fork context advisory", () => {
	it("defaults to no inherited context (zero parent clones zero in every mode)", () => {
		const advisory = adviseForkContextMode({ assignment: "Implement the scoped helper." });

		expect(advisory).toEqual({
			recommendedMode: "none",
			reasons: [],
			estimatedClonedTokens: {
				none: 0,
				receipt: 0,
				"last-turn": 0,
				bounded: 0,
				full: 0,
			},
			callerModeRespected: true,
		});
	});

	it("caps cloned-token estimates by the parent context and by per-mode budgets", () => {
		// Parent smaller than the receipt budget: every non-none mode clones the whole parent.
		expect(adviseForkContextMode({ assignment: "x", parentContextTokens: 1500 }).estimatedClonedTokens).toEqual({
			none: 0,
			receipt: 1500,
			"last-turn": 1500,
			bounded: 1500,
			full: 1500,
		});
		// Parent between adjacent budgets: capped per mode.
		expect(adviseForkContextMode({ assignment: "x", parentContextTokens: 5000 }).estimatedClonedTokens).toEqual({
			none: 0,
			receipt: 2000,
			"last-turn": 4000,
			bounded: 5000,
			full: 5000,
		});
		// Huge parent: budget ceilings apply.
		expect(adviseForkContextMode({ assignment: "x", parentContextTokens: 1_000_000 }).estimatedClonedTokens).toEqual({
			none: 0,
			receipt: 2000,
			"last-turn": 4000,
			bounded: 8000,
			full: 15_000,
		});
	});

	it.each([
		["as discussed", "prior-session-reference:as-discussed"],
		["as decided", "prior-session-reference:as-decided"],
		["earlier in this session", "prior-session-reference:earlier-in-this-session"],
		["per the plan above", "prior-session-reference:per-the-plan-above"],
		["the previous review", "prior-session-reference:the-previous-review"],
		[".gjc/plans/fork-context.md", "prior-session-reference:gjc-plans-path"],
		[".gjc/specs/fork-context.md", "prior-session-reference:gjc-specs-path"],
	])("recommends receipt for prior-session trigger %s", (phrase, reason) => {
		const advisory = adviseForkContextMode({ assignment: `Continue ${phrase} and update the module.` });

		expect(advisory.recommendedMode).toBe("receipt");
		expect(advisory.reasons).toContain(reason);
	});

	it.each([
		["the last message", "last-turn-reference:the-last-message"],
		["the previous turn", "last-turn-reference:the-previous-turn"],
		["see above", "last-turn-reference:see-above"],
	])("recommends last-turn for adjacent-turn trigger %s", (phrase, reason) => {
		const advisory = adviseForkContextMode({ assignment: "Implement the scoped helper.", context: `Use ${phrase}.` });

		expect(advisory.recommendedMode).toBe("last-turn");
		expect(advisory.reasons).toContain(reason);
	});

	it("does not recommend bounded or full from heuristic triggers", () => {
		const advisory = adviseForkContextMode({
			assignment: "As discussed, see above and use .gjc/plans/context.md from the previous review.",
		});

		expect(advisory.recommendedMode).toBe("last-turn");
		expect(advisory.recommendedMode).not.toBe("bounded");
		expect(advisory.recommendedMode).not.toBe("full");
	});

	it.each(FORK_CONTEXT_MODES)("respects explicit caller mode %s", explicitMode => {
		const advisory = adviseForkContextMode({
			assignment: "As discussed, see above.",
			explicitMode,
			parentContextTokens: 25_000,
		});

		expect(advisory.recommendedMode).toBe(explicitMode);
		expect(advisory.reasons).toContain("explicit-caller-mode");
		expect(advisory.callerModeRespected).toBe(true);
	});

	it("estimates cloned token cost monotonically for a large parent context", () => {
		const advisory = adviseForkContextMode({ assignment: "Do the task.", parentContextTokens: 40_000 });
		const estimates = advisory.estimatedClonedTokens;

		expect(estimates.none).toBe(0);
		expect(estimates.receipt).toBe(2000);
		expect(estimates["last-turn"]).toBe(4000);
		expect(estimates.bounded).toBe(8000);
		expect(estimates.full).toBe(15000);
		expect(estimates.none).toBeLessThanOrEqual(estimates.receipt);
		expect(estimates.receipt).toBeLessThanOrEqual(estimates["last-turn"]);
		expect(estimates["last-turn"]).toBeLessThanOrEqual(estimates.bounded);
		expect(estimates.bounded).toBeLessThanOrEqual(estimates.full);
	});

	it("is deterministic for the same input", () => {
		const input = {
			assignment: "Continue as decided in the previous review.",
			context: "See above for the exact constraint.",
			parentContextTokens: 12_345,
		};

		expect(adviseForkContextMode(input)).toEqual(adviseForkContextMode(input));
	});

	it("does not mutate the input object", () => {
		const input = {
			assignment: "Continue as discussed.",
			context: "Use .gjc/specs/context.md.",
			explicitMode: "receipt" as const,
			parentContextTokens: 10_000,
		};
		const before = structuredClone(input);

		adviseForkContextMode(input);

		expect(input).toEqual(before);
	});
});
