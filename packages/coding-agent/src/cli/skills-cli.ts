/**
 * Handles `gjc skills` for inspecting bundled workflow skill definitions.
 */
import {
	DEFAULT_GJC_DEFINITION_NAMES,
	type EmbeddedDefaultGjcSkill,
	getEmbeddedDefaultGjcSkills,
} from "../defaults/gjc-defaults";

export type SkillsAction = "list" | "read";

export interface SkillsCommandArgs {
	action: SkillsAction;
	name?: string;
	flags?: {
		json?: boolean;
	};
}

interface SkillsListEntry {
	name: string;
	description: string;
	path: string;
	source: string;
}

interface SkillsReadEntry extends SkillsListEntry {
	content: string;
}

function getEmbeddedSkill(name: string): EmbeddedDefaultGjcSkill | undefined {
	return getEmbeddedDefaultGjcSkills().find(skill => skill.name === name);
}

function listEmbeddedSkills(): SkillsListEntry[] {
	return getEmbeddedDefaultGjcSkills().map(skill => ({
		name: skill.name,
		description: skill.description,
		path: skill.filePath,
		source: skill.source,
	}));
}

function writeJson(value: unknown): void {
	process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export async function runSkillsCommand(cmd: SkillsCommandArgs): Promise<void> {
	if (cmd.action === "list") {
		const skills = listEmbeddedSkills();
		if (cmd.flags?.json) {
			writeJson({ skills });
			return;
		}
		for (const skill of skills) {
			process.stdout.write(`${skill.name}\t${skill.description}\t${skill.path}\n`);
		}
		return;
	}

	const name = cmd.name?.trim();
	if (!name) {
		process.stderr.write(`error: skill name is required for read (${DEFAULT_GJC_DEFINITION_NAMES.join(", ")})\n`);
		process.exitCode = 1;
		return;
	}

	const skill = getEmbeddedSkill(name);
	if (!skill) {
		process.stderr.write(`error: unknown embedded skill "${name}" (${DEFAULT_GJC_DEFINITION_NAMES.join(", ")})\n`);
		process.exitCode = 1;
		return;
	}

	const content = skill.loadContent ? await skill.loadContent() : skill.content;
	const entry: SkillsReadEntry = {
		name: skill.name,
		description: skill.description,
		path: skill.filePath,
		source: skill.source,
		content,
	};
	if (cmd.flags?.json) {
		writeJson(entry);
		return;
	}
	process.stdout.write(content);
	if (!content.endsWith("\n")) process.stdout.write("\n");
}
