/** Native-free canonical GJC workflow skill identifiers. */
export const CANONICAL_GJC_WORKFLOW_SKILLS = ["deep-interview", "ralplan", "ultragoal", "autoresearch"] as const;

export type CanonicalGjcWorkflowSkill = (typeof CANONICAL_GJC_WORKFLOW_SKILLS)[number];

const CANONICAL_GJC_WORKFLOW_SKILL_SET = new Set<string>(CANONICAL_GJC_WORKFLOW_SKILLS);

/** Case-insensitive, Win32-path-equivalent key used for skill collision checks. */
export function getSkillFilesystemIdentity(name: string): string {
	return name.replace(/[. ]+$/u, "").toLowerCase();
}

/** Whether a name resolves to a bundled workflow under portable filesystem semantics. */
export function isCanonicalGjcWorkflowSkillFilesystemAlias(name: string): boolean {
	return CANONICAL_GJC_WORKFLOW_SKILL_SET.has(getSkillFilesystemIdentity(name));
}
