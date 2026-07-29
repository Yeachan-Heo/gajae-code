import { describe, expect, it } from "bun:test";
import {
	DeepInterviewRoundLimitError,
	decideDeepInterviewContinuation,
} from "@gajae-code/coding-agent/gjc-runtime/deep-interview-continuation";
import {
	applyDeepInterviewRoundResultV1,
	DeepInterviewInvariantError,
} from "@gajae-code/coding-agent/gjc-runtime/deep-interview-state";

describe("deep-interview continuation policy", () => {
	it.each([
		[1, "continue_interview", "minimum_context"],
		[3, "continue_interview", "minimum_context"],
		[4, "confirm_continuation", "tiered_confirmation"],
		[15, "confirm_continuation", "tiered_confirmation"],
		[16, "confirm_continuation", "diminishing_returns"],
		[99, "confirm_continuation", "diminishing_returns"],
		[100, "begin_closure", "hard_cap_reached"],
	] as const)("maps scored ordinal %d to %s", (scoredRoundOrdinal, nextAction, reason) => {
		expect(
			decideDeepInterviewContinuation({
				scoredRoundOrdinal,
				effectiveAmbiguityUnits: 8_000,
				thresholdUnits: 500,
			}),
		).toEqual({ next_action: nextAction, reason });
	});

	it("begins closure when ambiguity reaches the threshold before the hard cap", () => {
		expect(
			decideDeepInterviewContinuation({
				scoredRoundOrdinal: 12,
				effectiveAmbiguityUnits: 500,
				thresholdUnits: 500,
			}),
		).toEqual({ next_action: "begin_closure", reason: "ambiguity_threshold_reached" });
	});

	it("gives the hard cap precedence over ambiguity and rejects a 101st scoring transaction", () => {
		expect(
			decideDeepInterviewContinuation({
				scoredRoundOrdinal: 100,
				effectiveAmbiguityUnits: 100,
				thresholdUnits: 500,
			}),
		).toEqual({ next_action: "begin_closure", reason: "hard_cap_reached" });
		expect(() =>
			decideDeepInterviewContinuation({
				scoredRoundOrdinal: 101,
				effectiveAmbiguityUnits: 8_000,
				thresholdUnits: 500,
			}),
		).toThrow(DeepInterviewRoundLimitError);
	});

	it("counts committed scores instead of caller-supplied round numbers at the runtime boundary", () => {
		const scoredRounds = Array.from({ length: 99 }, (_, index) => ({
			round_key: `scored-${index + 1}`,
			round: index + 1,
			question_id: `q-${index + 1}`,
			question_hash: "question",
			answer_hash: "answer",
			lifecycle: "scored" as const,
			answered_at: "2026-01-01T00:00:00.000Z",
			scored_at: "2026-01-01T00:01:00.000Z",
			scores: { goal: 0.2, constraints: 0.2, criteria: 0.2 },
			ambiguity: 0.8,
			round_result_digest: `digest-${index + 1}`,
		}));
		const hundredth = {
			round_key: "score-100",
			round: 10_000,
			question_id: "q-100",
			question_hash: "question",
			answer_hash: "answer",
			lifecycle: "answered" as const,
			answered_at: "2026-01-01T00:02:00.000Z",
		};
		const result = {
			global_scores: { goal: 0.2, constraints: 0.2, criteria: 0.2, context: 0.2 },
			ontology: [],
		};
		const capped = applyDeepInterviewRoundResultV1(
			{
				skill: "deep-interview",
				schema_version: 1,
				state: {
					type: "greenfield",
					threshold: 0.05,
					threshold_units: 500,
					rounds: [...scoredRounds, hundredth],
					established_facts: [],
				},
			},
			hundredth.round_key,
			result,
			"2026-01-01T00:03:00.000Z",
		);
		expect(capped.kind).toBe("write");
		if (capped.kind !== "write") throw new Error("expected write");
		expect(capped.projection).toMatchObject({
			next_action: "begin_closure",
			next_action_reason: "hard_cap_reached",
		});

		const overCap = structuredClone(capped.envelope);
		(overCap.state?.rounds as Record<string, unknown>[]).push({
			round_key: "score-101",
			round: 10_001,
			question_id: "q-101",
			question_hash: "question",
			answer_hash: "answer",
			lifecycle: "answered",
			answered_at: "2026-01-01T00:04:00.000Z",
		});
		try {
			applyDeepInterviewRoundResultV1(overCap, "score-101", result, "2026-01-01T00:05:00.000Z");
			throw new Error("expected the hard cap to reject the 101st scoring transaction");
		} catch (error) {
			expect(error).toBeInstanceOf(DeepInterviewInvariantError);
			if (!(error instanceof DeepInterviewInvariantError)) throw error;
			expect(error.invariant).toBe("scored_round_count_must_not_exceed_hard_cap");
		}
	});
});
