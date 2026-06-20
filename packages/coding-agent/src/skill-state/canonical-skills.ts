/** Native-free canonical GJC workflow skill identifiers. */
export const CANONICAL_GJC_WORKFLOW_SKILLS = ["deep-interview", "ralplan", "ultragoal", "team"] as const;

export type CanonicalGjcWorkflowSkill = (typeof CANONICAL_GJC_WORKFLOW_SKILLS)[number];
