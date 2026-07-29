export const DEEP_INTERVIEW_MAX_SCORED_ROUNDS = 100;

export type DeepInterviewNextAction = "continue_interview" | "confirm_continuation" | "begin_closure";

export type DeepInterviewNextActionReason =
	| "minimum_context"
	| "tiered_confirmation"
	| "diminishing_returns"
	| "ambiguity_threshold_reached"
	| "hard_cap_reached";

export interface DeepInterviewContinuationDecision {
	next_action: DeepInterviewNextAction;
	reason: DeepInterviewNextActionReason;
}

export interface DeepInterviewContinuationInput {
	scoredRoundOrdinal: number;
	effectiveAmbiguityUnits: number;
	thresholdUnits: number;
}

export class DeepInterviewRoundLimitError extends Error {
	constructor() {
		super("DI_INTERVIEW_ROUND_LIMIT_REACHED");
		this.name = "DeepInterviewRoundLimitError";
	}
}

export function decideDeepInterviewContinuation(
	input: DeepInterviewContinuationInput,
): DeepInterviewContinuationDecision {
	if (input.scoredRoundOrdinal > DEEP_INTERVIEW_MAX_SCORED_ROUNDS) throw new DeepInterviewRoundLimitError();
	if (input.scoredRoundOrdinal === DEEP_INTERVIEW_MAX_SCORED_ROUNDS)
		return { next_action: "begin_closure", reason: "hard_cap_reached" };
	if (input.effectiveAmbiguityUnits <= input.thresholdUnits)
		return { next_action: "begin_closure", reason: "ambiguity_threshold_reached" };
	if (input.scoredRoundOrdinal <= 3) return { next_action: "continue_interview", reason: "minimum_context" };
	if (input.scoredRoundOrdinal <= 15) return { next_action: "confirm_continuation", reason: "tiered_confirmation" };
	return { next_action: "confirm_continuation", reason: "diminishing_returns" };
}
