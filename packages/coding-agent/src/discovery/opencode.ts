/**
 * OpenCode Discovery Provider
 *
 * Loads configuration from OpenCode's config directories:
 * - User: ~/.config/opencode/
 * - Project: .opencode/ (cwd) and opencode.json (project root)
 *
 * Capabilities:
 * - context-files: AGENTS.md (user-level only at ~/.config/opencode/AGENTS.md)
 * - settings: From opencode.json
 * - skills: From skills/ subdirectories
 * - slash-commands: From commands/ subdirectories
 * - extension-modules: From plugins/ subdirectories
 *
 * MCP servers are intentionally NOT inherited live from OpenCode config: GJC
 * owns MCP runtime execution. Use `gjc mcp import opencode` to copy definitions
 * into GJC's own mcp.json instead.
 *
 * Priority: 55 (tool-specific provider)
 */
import * as path from "node:path";
import { parseFrontmatter, tryParseJson } from "@gajae-code/utils";
import { registerProvider } from "../capability";
import { type ContextFile, contextFileCapability } from "../capability/context-file";
import { type ExtensionModule, extensionModuleCapability } from "../capability/extension-module";
import { readFile } from "../capability/fs";
import { type Settings, settingsCapability } from "../capability/settings";
import { type Skill, skillCapability } from "../capability/skill";
import { type SlashCommand, slashCommandCapability } from "../capability/slash-command";
import type { LoadContext, LoadResult, SourceMeta } from "../capability/types";
import { settings } from "../config/settings";

import {
	buildExtensionModuleItems,
	createSourceMeta,
	discoverExtensionModulePaths,
	getProjectPath,
	getUserPath,
	loadFilesFromDir,
	scanSkillsFromDir,
} from "./helpers";

const PROVIDER_ID = "opencode";
const DISPLAY_NAME = "OpenCode";
const PRIORITY = 55;

// =============================================================================
// Context Files (AGENTS.md)
// =============================================================================

async function loadContextFiles(ctx: LoadContext): Promise<LoadResult<ContextFile>> {
	const items: ContextFile[] = [];
	const warnings: string[] = [];

	// User-level only: ~/.config/opencode/AGENTS.md
	const userAgentsMd = getUserPath(ctx, "opencode", "AGENTS.md");
	if (userAgentsMd) {
		const content = await readFile(userAgentsMd);
		if (content) {
			items.push({
				path: userAgentsMd,
				content,
				level: "user",
				_source: createSourceMeta(PROVIDER_ID, userAgentsMd, "user"),
			});
		}
	}

	return { items, warnings };
}

// =============================================================================
// Skills (skills/)
// =============================================================================

async function loadSkills(ctx: LoadContext): Promise<LoadResult<Skill>> {
	const userSkillsDir = getUserPath(ctx, "opencode", "skills");
	const projectSkillsDir = getProjectPath(ctx, "opencode", "skills");

	const promises: Promise<LoadResult<Skill>>[] = [];

	if (userSkillsDir) {
		promises.push(
			scanSkillsFromDir(ctx, {
				dir: userSkillsDir,
				providerId: PROVIDER_ID,
				level: "user",
			}),
		);
	}

	if (projectSkillsDir) {
		promises.push(
			scanSkillsFromDir(ctx, {
				dir: projectSkillsDir,
				providerId: PROVIDER_ID,
				level: "project",
			}),
		);
	}

	const results = await Promise.all(promises);
	const items = results.flatMap(r => r.items);
	const warnings = results.flatMap(r => r.warnings || []);

	return { items, warnings };
}

// =============================================================================
// Extension Modules (plugins/)
// =============================================================================

async function loadExtensionModules(ctx: LoadContext): Promise<LoadResult<ExtensionModule>> {
	const userPluginsDir = getUserPath(ctx, "opencode", "plugins");
	const projectPluginsDir = getProjectPath(ctx, "opencode", "plugins");

	const [userPaths, projectPaths] = await Promise.all([
		userPluginsDir ? discoverExtensionModulePaths(ctx, userPluginsDir) : Promise.resolve([]),
		projectPluginsDir ? discoverExtensionModulePaths(ctx, projectPluginsDir) : Promise.resolve([]),
	]);

	const items = buildExtensionModuleItems(PROVIDER_ID, userPaths, projectPaths);

	return { items, warnings: [] };
}

// =============================================================================
// Slash Commands (commands/)
// =============================================================================

/**
 * Read the OpenCode command-loading toggles from settings.
 * Falls back to true (current behavior) when settings are not initialized,
 * e.g. inside discovery unit tests that run without Settings.init().
 */
function readOpencodeCommandToggles(): { enableUser: boolean; enableProject: boolean } {
	try {
		return {
			enableUser: settings.get("commands.enableOpencodeUser") ?? true,
			enableProject: settings.get("commands.enableOpencodeProject") ?? true,
		};
	} catch {
		return { enableUser: true, enableProject: true };
	}
}

async function loadSlashCommands(ctx: LoadContext): Promise<LoadResult<SlashCommand>> {
	const { enableUser, enableProject } = readOpencodeCommandToggles();
	const userCommandsDir = enableUser ? getUserPath(ctx, "opencode", "commands") : null;
	const projectCommandsDir = enableProject ? getProjectPath(ctx, "opencode", "commands") : null;

	const transformCommand =
		(level: "user" | "project") => (name: string, content: string, filePath: string, source: SourceMeta) => {
			const { frontmatter, body } = parseFrontmatter(content, { source: filePath });
			const commandName = frontmatter.name || name.replace(/\.md$/, "");
			return {
				name: String(commandName),
				path: filePath,
				content: body,
				level,
				_source: source,
			};
		};

	const promises: Promise<LoadResult<SlashCommand>>[] = [];

	if (userCommandsDir) {
		promises.push(
			loadFilesFromDir(ctx, userCommandsDir, PROVIDER_ID, "user", {
				extensions: ["md"],
				transform: transformCommand("user"),
			}),
		);
	}

	if (projectCommandsDir) {
		promises.push(
			loadFilesFromDir(ctx, projectCommandsDir, PROVIDER_ID, "project", {
				extensions: ["md"],
				transform: transformCommand("project"),
			}),
		);
	}

	const results = await Promise.all(promises);
	const items = results.flatMap(r => r.items);
	const warnings = results.flatMap(r => r.warnings || []);

	return { items, warnings };
}

// =============================================================================
// Settings (opencode.json)
// =============================================================================

async function loadSettings(ctx: LoadContext): Promise<LoadResult<Settings>> {
	const items: Settings[] = [];
	const warnings: string[] = [];

	// User-level: ~/.config/opencode/opencode.json
	const userConfigPath = getUserPath(ctx, "opencode", "opencode.json");
	if (userConfigPath) {
		const content = await readFile(userConfigPath);
		if (content) {
			const parsed = tryParseJson<Record<string, unknown>>(content);
			if (parsed) {
				items.push({
					path: userConfigPath,
					data: parsed,
					level: "user",
					_source: createSourceMeta(PROVIDER_ID, userConfigPath, "user"),
				});
			} else {
				warnings.push(`Invalid JSON in ${userConfigPath}`);
			}
		}
	}

	// Project-level: opencode.json in project root
	const projectConfigPath = path.join(ctx.cwd, "opencode.json");
	const content = await readFile(projectConfigPath);
	if (content) {
		const parsed = tryParseJson<Record<string, unknown>>(content);
		if (parsed) {
			items.push({
				path: projectConfigPath,
				data: parsed,
				level: "project",
				_source: createSourceMeta(PROVIDER_ID, projectConfigPath, "project"),
			});
		} else {
			warnings.push(`Invalid JSON in ${projectConfigPath}`);
		}
	}

	return { items, warnings };
}

// =============================================================================
// Provider Registration
// =============================================================================

registerProvider(contextFileCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Load AGENTS.md from ~/.config/opencode/",
	priority: PRIORITY,
	load: loadContextFiles,
});

registerProvider(skillCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Load skills from ~/.config/opencode/skills/ and .opencode/skills/",
	priority: PRIORITY,
	load: loadSkills,
});

registerProvider(extensionModuleCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Load extension modules from ~/.config/opencode/plugins/ and .opencode/plugins/",
	priority: PRIORITY,
	load: loadExtensionModules,
});

registerProvider(slashCommandCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Load slash commands from ~/.config/opencode/commands/ and .opencode/commands/",
	priority: PRIORITY,
	load: loadSlashCommands,
});

registerProvider(settingsCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Load settings from opencode.json",
	priority: PRIORITY,
	load: loadSettings,
});
