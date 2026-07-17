import * as path from "node:path";
import { getAgentDir, isEnoent, parseFrontmatter } from "@gajae-code/utils";
import autoAnswerUncertainFragment from "./gjc/skills/deep-interview/auto-answer-uncertain.md" with { type: "text" };
import autoResearchGreenfieldFragment from "./gjc/skills/deep-interview/auto-research-greenfield.md" with {
	type: "text",
};
import lateralReviewPanelFragment from "./gjc/skills/deep-interview/lateral-review-panel.md" with { type: "text" };
import deepInterviewSkill from "./gjc/skills/deep-interview/SKILL.md" with { type: "text" };
import ralplanSkill from "./gjc/skills/ralplan/SKILL.md" with { type: "text" };
import teamSkill from "./gjc/skills/team/SKILL.md" with { type: "text" };
import aiSlopCleanerFragment from "./gjc/skills/ultragoal/ai-slop-cleaner.md" with { type: "text" };
import pipelineValidationContractsFragment from "./gjc/skills/ultragoal/pipeline-validation-contracts.md" with {
	type: "text",
};
import ultragoalSkill from "./gjc/skills/ultragoal/SKILL.md" with { type: "text" };

export const DEFAULT_GJC_DEFINITION_NAMES = ["deep-interview", "ralplan", "team", "ultragoal"] as const;
export type DefaultGjcDefinitionName = (typeof DEFAULT_GJC_DEFINITION_NAMES)[number];
export type DefaultGjcDefinitionKind = "skill" | "skill-fragment";
export type EmbeddedDefaultGjcSkill = {
	name: DefaultGjcDefinitionName;
	description: string;
	filePath: string;
	baseDir: string;
	source: "bundled:default";
	hide?: boolean;
	content: string;
};
export type DefaultGjcInstallStatus = "different" | "matching" | "missing" | "skipped" | "written";

export interface DefaultGjcSkillDefinition {
	kind: "skill";
	name: DefaultGjcDefinitionName;
	relativePath: string;
	content: string;
}

export interface DefaultGjcSkillFragmentDefinition {
	kind: "skill-fragment";
	parentSkillName: DefaultGjcDefinitionName;
	relativePath: string;
	content: string;
}

export type DefaultGjcDefinition = DefaultGjcSkillDefinition | DefaultGjcSkillFragmentDefinition;

export interface InstallDefaultGjcDefinitionsOptions {
	check?: boolean;
	force?: boolean;
	/**
	 * Only rewrite default definition files that already exist on disk but whose
	 * content differs from the embedded defaults. Files that are absent are left
	 * absent (status "missing"). Used by `gjc update` to refresh opted-in copies
	 * without materializing new on-disk copies for users who never installed them.
	 */
	refreshOnly?: boolean;
	targetRoot?: string;
}

export type DefaultGjcDefinitionInstallFile =
	| {
			kind: "skill";
			name: DefaultGjcDefinitionName;
			path: string;
			status: DefaultGjcInstallStatus;
	  }
	| {
			kind: "skill-fragment";
			parentSkillName: DefaultGjcDefinitionName;
			path: string;
			status: DefaultGjcInstallStatus;
	  };

export interface DefaultGjcDefinitionInstallResult {
	targetRoot: string;
	total: number;
	written: number;
	skipped: number;
	matching: number;
	missing: number;
	different: number;
	files: DefaultGjcDefinitionInstallFile[];
}

const DEFAULT_GJC_DEFINITIONS: readonly DefaultGjcDefinition[] = [
	{
		kind: "skill",
		name: "deep-interview",
		relativePath: "skills/deep-interview/SKILL.md",
		content: deepInterviewSkill,
	},
	{ kind: "skill", name: "ralplan", relativePath: "skills/ralplan/SKILL.md", content: ralplanSkill },
	{ kind: "skill", name: "team", relativePath: "skills/team/SKILL.md", content: teamSkill },
	{ kind: "skill", name: "ultragoal", relativePath: "skills/ultragoal/SKILL.md", content: ultragoalSkill },
	{
		kind: "skill-fragment",
		parentSkillName: "deep-interview",
		relativePath: "skill-fragments/deep-interview/auto-research-greenfield.md",
		content: autoResearchGreenfieldFragment,
	},
	{
		kind: "skill-fragment",
		parentSkillName: "deep-interview",
		relativePath: "skill-fragments/deep-interview/auto-answer-uncertain.md",
		content: autoAnswerUncertainFragment,
	},
	{
		kind: "skill-fragment",
		parentSkillName: "deep-interview",
		relativePath: "skill-fragments/deep-interview/lateral-review-panel.md",
		content: lateralReviewPanelFragment,
	},
	{
		kind: "skill-fragment",
		parentSkillName: "ultragoal",
		relativePath: "skill-fragments/ultragoal/ai-slop-cleaner.md",
		content: aiSlopCleanerFragment,
	},
	{
		kind: "skill-fragment",
		parentSkillName: "ultragoal",
		relativePath: "skill-fragments/ultragoal/pipeline-validation-contracts.md",
		content: pipelineValidationContractsFragment,
	},
];

export function getDefaultGjcDefinitions(): readonly DefaultGjcDefinition[] {
	return DEFAULT_GJC_DEFINITIONS;
}

export function getDefaultGjcAgentDefinitions(): readonly DefaultGjcDefinition[] {
	return [];
}

export function getEmbeddedDefaultGjcSkillFragments(
	parentSkillName: DefaultGjcDefinitionName,
): DefaultGjcSkillFragmentDefinition[] {
	return DEFAULT_GJC_DEFINITIONS.filter(
		(definition): definition is DefaultGjcSkillFragmentDefinition =>
			definition.kind === "skill-fragment" && definition.parentSkillName === parentSkillName,
	);
}

export function getEmbeddedDefaultGjcSkills(): EmbeddedDefaultGjcSkill[] {
	return DEFAULT_GJC_DEFINITIONS.filter(
		(definition): definition is DefaultGjcSkillDefinition => definition.kind === "skill",
	).map(definition => {
		const { frontmatter } = parseFrontmatter(definition.content, {
			source: `embedded:gjc/${definition.relativePath}`,
			level: "warn",
		});
		const description =
			typeof frontmatter.description === "string" ? frontmatter.description : `GJC ${definition.name} workflow`;
		return {
			name: definition.name,
			description,
			filePath: `embedded:gjc/${definition.relativePath}`,
			baseDir: `embedded:gjc/skills/${definition.name}`,
			source: "bundled:default",
			hide: frontmatter.hide === true,
			content: definition.content,
		};
	});
}

export async function installDefaultGjcDefinitions(
	options: InstallDefaultGjcDefinitionsOptions = {},
): Promise<DefaultGjcDefinitionInstallResult> {
	const targetRoot = options.targetRoot ?? getAgentDir();
	const files: DefaultGjcDefinitionInstallFile[] = [];

	for (const definition of DEFAULT_GJC_DEFINITIONS) {
		const destination = path.join(targetRoot, definition.relativePath);
		const existing = await readExistingText(destination);
		let status: DefaultGjcInstallStatus;

		if (options.check) {
			status = existing === undefined ? "missing" : existing === definition.content ? "matching" : "different";
		} else if (options.refreshOnly) {
			if (existing === undefined) {
				status = "missing";
			} else if (existing === definition.content) {
				status = "matching";
			} else {
				await Bun.write(destination, definition.content);
				status = "written";
			}
		} else if (existing !== undefined && !options.force) {
			status = "skipped";
		} else {
			await Bun.write(destination, definition.content);
			status = "written";
		}

		if (definition.kind === "skill") {
			files.push({
				kind: definition.kind,
				name: definition.name,
				path: destination,
				status,
			});
		} else {
			files.push({
				kind: definition.kind,
				parentSkillName: definition.parentSkillName,
				path: destination,
				status,
			});
		}
	}

	return summarizeInstallResult(targetRoot, files);
}

async function readExistingText(filePath: string): Promise<string | undefined> {
	try {
		return await Bun.file(filePath).text();
	} catch (error) {
		if (isEnoent(error)) return undefined;
		throw error;
	}
}

function summarizeInstallResult(
	targetRoot: string,
	files: DefaultGjcDefinitionInstallFile[],
): DefaultGjcDefinitionInstallResult {
	return {
		targetRoot,
		total: files.length,
		written: countStatus(files, "written"),
		skipped: countStatus(files, "skipped"),
		matching: countStatus(files, "matching"),
		missing: countStatus(files, "missing"),
		different: countStatus(files, "different"),
		files,
	};
}

function countStatus(files: readonly DefaultGjcDefinitionInstallFile[], status: DefaultGjcInstallStatus): number {
	return files.filter(file => file.status === status).length;
}
