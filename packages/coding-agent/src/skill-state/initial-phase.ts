import type { CanonicalGjcWorkflowSkill } from "./active-state";

/**
 * Canonical initial phase for each GJC workflow skill. Used by both
 * `recordSkillActivation` (UserPromptSubmit hook seeding initial mode-state)
 * and the `gjc state <caller> handoff --to <callee>` runtime when promoting
 * the callee.
 *
 * Keeping this mapping in a neutral skill-state module avoids cycles between
 * `gjc-runtime/state-runtime.ts` and `hooks/skill-state.ts` (which pulls in
 * session-manager and ultragoal verification code).
 */
export function initialPhaseForSkill(skill: CanonicalGjcWorkflowSkill | string): string {
	if (skill === "deep-interview") return "interviewing";
	if (skill === "ultragoal") return "goal-planning";
	return "planning";
}
