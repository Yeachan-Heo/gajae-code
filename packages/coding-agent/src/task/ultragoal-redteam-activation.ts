/**
 * Decide whether an executor assignment should inject the ultragoal red-team
 * prompt fragment. Activation must be explicit — bare mentions of `executorQa`
 * (docs, quality-gate field names, negative instructions) must not flip the mode.
 *
 * Mirrors `executor.md`:
 * "activates only when the assignment explicitly labels Executor as Ultragoal
 * completion QA/red-team or asks for `executorQa` red-team evidence."
 */

const ULTRAGOAL_COMPLETION_QA = /\bultragoal\s+completion\s+(?:qa|red[-\s]?team)\b/i;

/** `executorQa` within a short window of red-team / matrix / evidence framing. */
const EXECUTOR_QA_EVIDENCE =
	/\bexecutorQa\b[\s\S]{0,120}\b(?:red[-\s]?team|matrix|evidence)\b|\b(?:red[-\s]?team|matrix|evidence)\b[\s\S]{0,120}\bexecutorQa\b/i;

/** Common Ultragoal skill spawn phrasing: "executor QA/red-team lane". */
const EXECUTOR_QA_LANE = /\bexecutor\b[\s\S]{0,48}\b(?:qa|red[-\s]?team)\s+lane\b/i;

export function assignmentRequestsUltragoalRedTeam(assignment: string | undefined): boolean {
	const text = assignment?.trim() ?? "";
	if (text.length === 0) return false;
	return ULTRAGOAL_COMPLETION_QA.test(text) || EXECUTOR_QA_EVIDENCE.test(text) || EXECUTOR_QA_LANE.test(text);
}
