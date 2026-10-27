/**
 * Generated bundled GJC workflow skill catalog.
 *
 * Keep this module metadata-only: skill bodies are read from their embedded
 * `type: "file"` paths only when a caller asks for their content. Do not also
 * import a body with `type: "text"`: Bun caches a module per specifier, so the
 * second import of the same file would return the first one's value.
 */
import { readFile } from "node:fs/promises";
import autoresearchAutoCriticPath from "./gjc/skills/autoresearch/auto-critic.md" with { type: "file" };
import autoresearchAutoIteratePath from "./gjc/skills/autoresearch/auto-iterate.md" with { type: "file" };
import autoresearchSkillPath from "./gjc/skills/autoresearch/SKILL.md" with { type: "file" };
import deepInterviewAutoAnswerUncertainPath from "./gjc/skills/deep-interview/auto-answer-uncertain.md" with {
	type: "file",
};
import deepInterviewLateralReviewPanelPath from "./gjc/skills/deep-interview/lateral-review-panel.md" with {
	type: "file",
};
import deepInterviewSkillPath from "./gjc/skills/deep-interview/SKILL.md" with { type: "file" };
import ralplanSkillPath from "./gjc/skills/ralplan/SKILL.md" with { type: "file" };
import ultragoalAiSlopCleanerPath from "./gjc/skills/ultragoal/ai-slop-cleaner.md" with { type: "file" };
import ultragoalBoundaryCohortGatePath from "./gjc/skills/ultragoal/boundary-cohort-gate.md" with { type: "file" };
import ultragoalCrossRepositorySuccessionPath from "./gjc/skills/ultragoal/cross-repository-succession.md" with {
	type: "file",
};
import ultragoalSkillPath from "./gjc/skills/ultragoal/SKILL.md" with { type: "file" };
import ultragoalTerminalCriticGatePath from "./gjc/skills/ultragoal/terminal-critic-gate.md" with { type: "file" };
import ultragoalValidationBatchContractsPath from "./gjc/skills/ultragoal/validation-batch-contracts.md" with {
	type: "file",
};

export type BundledGjcSkillName = "autoresearch" | "deep-interview" | "ralplan" | "ultragoal";

export interface BundledGjcSkillCatalogEntry {
	readonly kind: "skill" | "skill-fragment";
	readonly name?: BundledGjcSkillName;
	readonly parentSkillName?: BundledGjcSkillName;
	readonly relativePath: string;
	readonly description?: string;
	/**
	 * Path of the bundled body. A `type: "file"` import, so `bun build --compile`
	 * embeds the file and this resolves inside `/$bunfs` in compiled binaries.
	 */
	readonly sourcePath?: string;
	readonly loadContent: () => Promise<string>;
}

const deepInterview = () => readFile(deepInterviewSkillPath, "utf8");
const ralplan = () => readFile(ralplanSkillPath, "utf8");
const autoresearch = () => readFile(autoresearchSkillPath, "utf8");
const ultragoal = () => readFile(ultragoalSkillPath, "utf8");
const autoAnswerUncertain = () => readFile(deepInterviewAutoAnswerUncertainPath, "utf8");
const lateralReviewPanel = () => readFile(deepInterviewLateralReviewPanelPath, "utf8");
const aiSlopCleaner = () => readFile(ultragoalAiSlopCleanerPath, "utf8");
const validationBatchContracts = () => readFile(ultragoalValidationBatchContractsPath, "utf8");
const boundaryCohortGate = () => readFile(ultragoalBoundaryCohortGatePath, "utf8");
const terminalCriticGate = () => readFile(ultragoalTerminalCriticGatePath, "utf8");
const crossRepositorySuccession = () => readFile(ultragoalCrossRepositorySuccessionPath, "utf8");
const autoresearchIterate = () => readFile(autoresearchAutoIteratePath, "utf8");
const autoresearchCritic = () => readFile(autoresearchAutoCriticPath, "utf8");

export const BUNDLED_GJC_SKILL_CATALOG: readonly BundledGjcSkillCatalogEntry[] = [
	{
		kind: "skill",
		name: "deep-interview",
		relativePath: "skills/deep-interview/SKILL.md",
		sourcePath: deepInterviewSkillPath,
		description: "Socratic deep interview with mathematical ambiguity gating before explicit execution approval",
		loadContent: deepInterview,
	},
	{
		kind: "skill",
		name: "ralplan",
		relativePath: "skills/ralplan/SKILL.md",
		sourcePath: ralplanSkillPath,
		description: "Consensus planning entrypoint that auto-gates vague ultragoal requests before execution",
		loadContent: ralplan,
	},
	{
		kind: "skill",
		name: "autoresearch",
		relativePath: "skills/autoresearch/SKILL.md",
		sourcePath: autoresearchSkillPath,
		description: "Goal-directed research missions interleaving web and data evidence into a structured verdict",
		loadContent: autoresearch,
	},
	{
		kind: "skill",
		name: "ultragoal",
		relativePath: "skills/ultragoal/SKILL.md",
		sourcePath: ultragoalSkillPath,
		description: "Create and execute durable repo-native multi-goal plans over GJC goal mode artifacts.",
		loadContent: ultragoal,
	},
	{
		kind: "skill-fragment",
		parentSkillName: "deep-interview",
		relativePath: "skill-fragments/deep-interview/auto-answer-uncertain.md",
		sourcePath: deepInterviewAutoAnswerUncertainPath,
		loadContent: autoAnswerUncertain,
	},
	{
		kind: "skill-fragment",
		parentSkillName: "deep-interview",
		relativePath: "skill-fragments/deep-interview/lateral-review-panel.md",
		sourcePath: deepInterviewLateralReviewPanelPath,
		loadContent: lateralReviewPanel,
	},
	{
		kind: "skill-fragment",
		parentSkillName: "ultragoal",
		relativePath: "skill-fragments/ultragoal/ai-slop-cleaner.md",
		sourcePath: ultragoalAiSlopCleanerPath,
		loadContent: aiSlopCleaner,
	},
	{
		kind: "skill-fragment",
		parentSkillName: "ultragoal",
		relativePath: "skill-fragments/ultragoal/validation-batch-contracts.md",
		sourcePath: ultragoalValidationBatchContractsPath,
		loadContent: validationBatchContracts,
	},
	{
		kind: "skill-fragment",
		parentSkillName: "ultragoal",
		relativePath: "skill-fragments/ultragoal/boundary-cohort-gate.md",
		sourcePath: ultragoalBoundaryCohortGatePath,
		loadContent: boundaryCohortGate,
	},
	{
		kind: "skill-fragment",
		parentSkillName: "ultragoal",
		relativePath: "skill-fragments/ultragoal/terminal-critic-gate.md",
		sourcePath: ultragoalTerminalCriticGatePath,
		loadContent: terminalCriticGate,
	},
	{
		kind: "skill-fragment",
		parentSkillName: "ultragoal",
		relativePath: "skill-fragments/ultragoal/cross-repository-succession.md",
		sourcePath: ultragoalCrossRepositorySuccessionPath,
		loadContent: crossRepositorySuccession,
	},
	{
		kind: "skill-fragment",
		parentSkillName: "autoresearch",
		relativePath: "skill-fragments/autoresearch/auto-iterate.md",
		sourcePath: autoresearchAutoIteratePath,
		loadContent: autoresearchIterate,
	},
	{
		kind: "skill-fragment",
		parentSkillName: "autoresearch",
		relativePath: "skill-fragments/autoresearch/auto-critic.md",
		sourcePath: autoresearchAutoCriticPath,
		loadContent: autoresearchCritic,
	},
];
