/**
 * Handles `gjc skills` for inspecting bundled workflow skills and
 * filesystem-discovered custom skills.
 */
import { Settings } from "../config/settings";
import {
	DEFAULT_GJC_DEFINITION_NAMES,
	type EmbeddedDefaultGjcSkill,
	getEmbeddedDefaultGjcSkills,
} from "../defaults/gjc-defaults";
import {
	discoverRuntimeSkills,
	type RuntimeSkillDiscoveryCandidate,
	SKILL_DISCOVERY_MAX_LIMIT,
} from "../extensibility/runtime-skill-discovery";

export type SkillsAction = "list" | "read" | "discover";

export interface SkillsCommandArgs {
	action: SkillsAction;
	name?: string;
	flags?: {
		json?: boolean;
		source?: "all" | "project" | "user";
		/** Max discover results; clamped to [1, SKILL_DISCOVERY_MAX_LIMIT] by the library. */
		limit?: number;
		query?: string;
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

function formatCandidate(candidate: RuntimeSkillDiscoveryCandidate): string {
	const useWhen = candidate.useWhen && candidate.useWhen.length > 0 ? ` [when: ${candidate.useWhen.join(", ")}]` : "";
	return `${candidate.name}\t${candidate.source}\t${candidate.description}\t${candidate.path}${useWhen}`;
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

	if (cmd.action === "discover") {
		const source = cmd.flags?.source ?? "all";
		const settings = await Settings.loadForScope({ cwd: process.cwd() });
		try {
			const result = await discoverRuntimeSkills({
				cwd: process.cwd(),
				source,
				query: cmd.flags?.query,
				// A human paging the catalog defaults to the widest page the library
				// serves; the library default stays sized for the agent tool's context.
				limit: cmd.flags?.limit ?? SKILL_DISCOVERY_MAX_LIMIT,
				policy: {
					...settings.getGroup("skills"),
					disabledExtensions: settings.get("disabledExtensions"),
				},
			});
			if (cmd.flags?.json) {
				writeJson({
					candidates: result.candidates,
					scanned: result.scanned,
					diagnostics: result.diagnostics.messages,
				});
				return;
			}
			for (const candidate of result.candidates) {
				process.stdout.write(`${formatCandidate(candidate)}\n`);
			}
			if (result.diagnostics.messages.length > 0) {
				process.stdout.write("\nDiagnostics:\n");
				for (const message of result.diagnostics.messages) {
					process.stdout.write(`- ${message}\n`);
				}
			}
		} finally {
			await settings.close();
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
