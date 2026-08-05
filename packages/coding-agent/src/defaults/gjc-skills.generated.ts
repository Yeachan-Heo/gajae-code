/**
 * Generated bundled GJC workflow skill catalog.
 *
 * Keep this module metadata-only: skill bodies are loaded through literal
 * dynamic imports only when a caller asks for their content.
 */
export type BundledGjcSkillName = "deep-interview" | "ralplan" | "team" | "ultragoal";

export interface BundledGjcSkillCatalogEntry {
	readonly kind: "skill" | "skill-fragment";
	readonly name?: BundledGjcSkillName;
	readonly parentSkillName?: BundledGjcSkillName;
	readonly relativePath: string;
	readonly description?: string;
	readonly loadContent: () => Promise<string>;
}

const deepInterview = () =>
	import("./gjc/skills/deep-interview/SKILL.md", { with: { type: "text" } }).then(module => module.default);
const ralplan = () => import("./gjc/skills/ralplan/SKILL.md", { with: { type: "text" } }).then(module => module.default);
const team = () => import("./gjc/skills/team/SKILL.md", { with: { type: "text" } }).then(module => module.default);
const ultragoal = () =>
	import("./gjc/skills/ultragoal/SKILL.md", { with: { type: "text" } }).then(module => module.default);
const autoAnswerUncertain = () =>
	import("./gjc/skills/deep-interview/auto-answer-uncertain.md", { with: { type: "text" } }).then(module => module.default);
const autoResearchGreenfield = () =>
	import("./gjc/skills/deep-interview/auto-research-greenfield.md", { with: { type: "text" } }).then(module => module.default);
const lateralReviewPanel = () =>
	import("./gjc/skills/deep-interview/lateral-review-panel.md", { with: { type: "text" } }).then(module => module.default);
const aiSlopCleaner = () =>
	import("./gjc/skills/ultragoal/ai-slop-cleaner.md", { with: { type: "text" } }).then(module => module.default);
const validationBatchContracts = () =>
	import("./gjc/skills/ultragoal/validation-batch-contracts.md", { with: { type: "text" } }).then(module => module.default);

export const BUNDLED_GJC_SKILL_CATALOG: readonly BundledGjcSkillCatalogEntry[] = [
	{
		kind: "skill",
		name: "deep-interview",
		relativePath: "skills/deep-interview/SKILL.md",
		description: "Socratic deep interview with mathematical ambiguity gating before explicit execution approval",
		loadContent: deepInterview,
	},
	{
		kind: "skill",
		name: "ralplan",
		relativePath: "skills/ralplan/SKILL.md",
		description: "Consensus planning entrypoint that auto-gates vague team/ultragoal requests before execution",
		loadContent: ralplan,
	},
	{
		kind: "skill",
		name: "team",
		relativePath: "skills/team/SKILL.md",
		description: "Multi-worker GJC tmux team orchestration",
		loadContent: team,
	},
	{
		kind: "skill",
		name: "ultragoal",
		relativePath: "skills/ultragoal/SKILL.md",
		description: "Create and execute durable repo-native multi-goal plans over GJC goal mode artifacts.",
		loadContent: ultragoal,
	},
	{
		kind: "skill-fragment",
		parentSkillName: "deep-interview",
		relativePath: "skill-fragments/deep-interview/auto-research-greenfield.md",
		loadContent: autoResearchGreenfield,
	},
	{
		kind: "skill-fragment",
		parentSkillName: "deep-interview",
		relativePath: "skill-fragments/deep-interview/auto-answer-uncertain.md",
		loadContent: autoAnswerUncertain,
	},
	{
		kind: "skill-fragment",
		parentSkillName: "deep-interview",
		relativePath: "skill-fragments/deep-interview/lateral-review-panel.md",
		loadContent: lateralReviewPanel,
	},
	{
		kind: "skill-fragment",
		parentSkillName: "ultragoal",
		relativePath: "skill-fragments/ultragoal/ai-slop-cleaner.md",
		loadContent: aiSlopCleaner,
	},
	{
		kind: "skill-fragment",
		parentSkillName: "ultragoal",
		relativePath: "skill-fragments/ultragoal/validation-batch-contracts.md",
		loadContent: validationBatchContracts,
	},
];
