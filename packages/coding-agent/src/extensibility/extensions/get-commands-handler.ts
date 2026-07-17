/**
 * Helper for wiring the `getCommands` action of {@link ExtensionAPI}.
 *
 * Centralizes the union over the three slash-command sources the runtime
 * exposes so the interactive UI, ACP, SDK, print, and child task executor wiring
 * sites cannot drift:
 *   - extension-registered hook commands (`source: "extension"`)
 *   - prompt commands loaded as `LoadedCustomCommand` — user/project/bundled
 *     custom commands and MCP prompts (`source: "prompt"`)
 *   - skill commands derived from `session.skills`, gated on
 *     `skillsSettings.enableSkillCommands` (`source: "skill"`)
 *
 * Built-in slash commands are intentionally excluded; `getCommands()` is the
 * surface extensions use to discover dynamic commands they did not register
 * themselves. Each frontend (interactive-mode, ACP) prepends its own builtins.
 */
import type { SkillsSettings } from "../../config/settings";
import type { CustomCommandSource, LoadedCustomCommand } from "../custom-commands";
import { getSkillSlashCommandNames, type Skill } from "../skills";
import type { SlashCommandInfo, SlashCommandLocation } from "../slash-commands";
import type { ExtensionRunner } from "./runner";

interface CommandsCapableSession {
	readonly extensionRunner?: ExtensionRunner;
	readonly customCommands: ReadonlyArray<LoadedCustomCommand>;
	readonly skills: ReadonlyArray<Skill>;
	readonly skillsSettings?: SkillsSettings;
}

export function getSessionSlashCommands(session: CommandsCapableSession): SlashCommandInfo[] {
	const out: SlashCommandInfo[] = [];

	const runner = session.extensionRunner;
	if (runner) {
		for (const cmd of runner.getRegisteredCommands()) {
			out.push({
				name: cmd.name,
				description: cmd.description,
				source: "extension",
			});
		}
	}

	for (const cmd of session.customCommands) {
		out.push({
			name: cmd.command.name,
			description: cmd.command.description,
			source: "prompt",
			location: customCommandLocation(cmd.source),
			path: cmd.resolvedPath,
		});
	}

	if (session.skillsSettings?.enableSkillCommands) {
		for (const skill of session.skills) {
			if (skill.hide === true) continue;
			for (const name of getSkillSlashCommandNames(skill)) {
				out.push({
					name,
					description: skill.description || undefined,
					source: "skill",
					path: skill.filePath,
				});
			}
		}
	}

	return out;
}

function customCommandLocation(source: CustomCommandSource): SlashCommandLocation | undefined {
	switch (source) {
		case "user":
			return "user";
		case "project":
			return "project";
		case "bundled":
			return undefined;
	}
}
