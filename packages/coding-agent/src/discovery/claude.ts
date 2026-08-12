/**
 * Anthropic Code project provider.
 *
 * Supports project-local `.Anthropic model/` compatibility only. User-home Anthropic model
 * directories are intentionally ignored so `~/.Anthropic model` content is never injected
 * into GJC sessions.
 */
import * as path from "node:path";
import { hasFsCode, tryParseJson } from "@gajae-code/utils";
import { registerProvider } from "../capability";
import { type ContextFile, contextFileCapability } from "../capability/context-file";
import { type ExtensionModule, extensionModuleCapability } from "../capability/extension-module";
import { readFile } from "../capability/fs";
import { type Hook, hookCapability } from "../capability/hook";
import { type MCPServer, mcpCapability } from "../capability/mcp";
import { type Settings, settingsCapability } from "../capability/settings";
import { type Skill, skillCapability } from "../capability/skill";
import { type SlashCommand, slashCommandCapability } from "../capability/slash-command";
import { type SystemPrompt, systemPromptCapability } from "../capability/system-prompt";
import { type CustomTool, toolCapability } from "../capability/tool";
import type { LoadContext, LoadResult } from "../capability/types";
import {
	calculateDepth,
	createSourceMeta,
	discoverExtensionModulePaths,
	expandEnvVarsDeep,
	getExtensionNameFromPath,
	loadFilesFromDir,
	scanSkillsFromDir,
} from "./helpers";

const PROVIDER_ID = "claude";
const DISPLAY_NAME = "Claude Code";
const PRIORITY = 80;
const CONFIG_DIR = ".claude";

function getProjectClaude(ctx: LoadContext): string {
	return path.join(ctx.cwd, CONFIG_DIR);
}

function isMissingDirectoryError(error: unknown): boolean {
	return hasFsCode(error, "ENOENT") || hasFsCode(error, "ENOTDIR");
}

async function loadMCPServers(ctx: LoadContext): Promise<LoadResult<MCPServer>> {
	const items: MCPServer[] = [];
	const projectBase = getProjectClaude(ctx);
	const projectPaths = [path.join(projectBase, ".mcp.json"), path.join(projectBase, "mcp.json")];
	const contents = await Promise.all(projectPaths.map(filePath => readFile(filePath)));

	const parseMcpServers = (content: string | null, filePath: string): MCPServer[] => {
		if (!content) return [];
		const json = tryParseJson<{ mcpServers?: Record<string, unknown> }>(content);
		if (!json?.mcpServers) return [];

		const mcpServers = expandEnvVarsDeep(json.mcpServers);
		return Object.entries(mcpServers).map(([name, config]) => {
			const serverConfig = config as Record<string, unknown>;
			return {
				name,
				timeout: typeof serverConfig.timeout === "number" ? serverConfig.timeout : undefined,
				command: serverConfig.command as string | undefined,
				args: serverConfig.args as string[] | undefined,
				env: serverConfig.env as Record<string, string> | undefined,
				url: serverConfig.url as string | undefined,
				headers: serverConfig.headers as Record<string, string> | undefined,
				transport: serverConfig.type as "stdio" | "sse" | "http" | undefined,
				_source: createSourceMeta(PROVIDER_ID, filePath, "project"),
			};
		});
	};

	for (let i = 0; i < projectPaths.length; i++) {
		const servers = parseMcpServers(contents[i], projectPaths[i]);
		if (servers.length > 0) {
			items.push(...servers);
			break;
		}
	}

	return { items, warnings: [] };
}

async function loadContextFiles(ctx: LoadContext): Promise<LoadResult<ContextFile>> {
	const items: ContextFile[] = [];
	const projectBase = getProjectClaude(ctx);
	const projectClaudeMd = path.join(projectBase, "CLAUDE.md");
	const projectContent = await readFile(projectClaudeMd);
	if (projectContent !== null) {
		const depth = calculateDepth(ctx.cwd, path.dirname(projectBase), path.sep);
		items.push({
			path: projectClaudeMd,
			content: projectContent,
			level: "project",
			depth,
			_source: createSourceMeta(PROVIDER_ID, projectClaudeMd, "project"),
		});
	}
	return { items, warnings: [] };
}

async function loadSkills(ctx: LoadContext): Promise<LoadResult<Skill>> {
	const projectScans: Promise<LoadResult<Skill>>[] = [];
	let current = ctx.cwd;
	while (true) {
		projectScans.push(
			scanSkillsFromDir(ctx, {
				dir: path.join(current, CONFIG_DIR, "skills"),
				providerId: PROVIDER_ID,
				level: "project",
			}),
		);
		if (current === (ctx.repoRoot ?? ctx.home)) break;
		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}

	const results = await Promise.allSettled(projectScans);
	const items: Skill[] = [];
	const warnings: string[] = [];
	for (const result of results) {
		if (result.status === "fulfilled") {
			items.push(...result.value.items);
			warnings.push(...(result.value.warnings ?? []));
		} else if (!isMissingDirectoryError(result.reason)) {
			warnings.push(`Failed to scan Claude project skills: ${String(result.reason)}`);
		}
	}
	return { items, warnings };
}

async function loadExtensionModules(ctx: LoadContext): Promise<LoadResult<ExtensionModule>> {
	const projectExtensionsDir = path.join(getProjectClaude(ctx), "extensions");
	const paths = await discoverExtensionModulePaths(ctx, projectExtensionsDir);
	return {
		items: paths.map(extPath => ({
			name: getExtensionNameFromPath(extPath),
			path: extPath,
			level: "project" as const,
			_source: createSourceMeta(PROVIDER_ID, extPath, "project"),
		})),
		warnings: [],
	};
}

async function loadSlashCommands(ctx: LoadContext): Promise<LoadResult<SlashCommand>> {
	const projectCommandsDir = path.join(getProjectClaude(ctx), "commands");
	return await loadFilesFromDir<SlashCommand>(ctx, projectCommandsDir, PROVIDER_ID, "project", {
		extensions: ["md"],
		transform: (name, content, filePath, source) => ({
			name: name.replace(/\.md$/, ""),
			path: filePath,
			content,
			level: "project",
			_source: source,
		}),
	});
}

async function loadHooks(ctx: LoadContext): Promise<LoadResult<Hook>> {
	const items: Hook[] = [];
	const warnings: string[] = [];
	const projectHooksDir = path.join(getProjectClaude(ctx), "hooks");
	const hookTypes = ["pre", "post"] as const;
	const results = await Promise.all(
		hookTypes.map(hookType =>
			loadFilesFromDir<Hook>(ctx, path.join(projectHooksDir, hookType), PROVIDER_ID, "project", {
				transform: (name, _content, filePath, source) => ({
					name,
					path: filePath,
					type: hookType,
					tool: name.replace(/\.(sh|bash|zsh|fish)$/, ""),
					level: "project",
					_source: source,
				}),
			}),
		),
	);
	for (const result of results) {
		items.push(...result.items);
		warnings.push(...(result.warnings ?? []));
	}
	return { items, warnings };
}

async function loadTools(ctx: LoadContext): Promise<LoadResult<CustomTool>> {
	const projectToolsDir = path.join(getProjectClaude(ctx), "tools");
	return await loadFilesFromDir<CustomTool>(ctx, projectToolsDir, PROVIDER_ID, "project", {
		transform: (name, _content, filePath, source) => {
			const toolName = name.replace(/\.(ts|js|sh|bash|py)$/, "");
			return {
				name: toolName,
				path: filePath,
				description: `${toolName} custom tool`,
				level: "project",
				_source: source,
			};
		},
	});
}

async function loadSystemPrompts(ctx: LoadContext): Promise<LoadResult<SystemPrompt>> {
	const projectSystemMd = path.join(getProjectClaude(ctx), "SYSTEM.md");
	const content = await readFile(projectSystemMd);
	return {
		items:
			content === null
				? []
				: [
						{
							path: projectSystemMd,
							content,
							level: "project",
							_source: createSourceMeta(PROVIDER_ID, projectSystemMd, "project"),
						},
					],
		warnings: [],
	};
}

async function loadSettings(ctx: LoadContext): Promise<LoadResult<Settings>> {
	const items: Settings[] = [];
	const warnings: string[] = [];
	const projectSettingsJson = path.join(getProjectClaude(ctx), "settings.json");
	const projectContent = await readFile(projectSettingsJson);
	if (projectContent) {
		const data = tryParseJson<Record<string, unknown>>(projectContent);
		if (data) {
			items.push({
				path: projectSettingsJson,
				data,
				level: "project",
				_source: createSourceMeta(PROVIDER_ID, projectSettingsJson, "project"),
			} as Settings);
		} else {
			warnings.push(`Failed to parse JSON in ${projectSettingsJson}`);
		}
	}
	return { items, warnings };
}

export interface ClaudeConventionInspection {
	mcps: LoadResult<MCPServer>;
	skills: LoadResult<Skill>;
	hooks: LoadResult<Hook>;
	tools: LoadResult<CustomTool>;
	extensions: LoadResult<ExtensionModule>;
	commands: LoadResult<SlashCommand>;
}

/**
 * Inspect what the Claude Code project convention (.claude/) would surface.
 *
 * Reuses the canonical provider load functions without registering the provider,
 * so diagnostics can report the convention's files while keeping the runtime
 * load path exactly as configured (this provider is not registered by default).
 */
export async function inspectClaudeConvention(ctx: LoadContext): Promise<ClaudeConventionInspection> {
	const [mcps, skills, hooks, tools, extensions, commands] = await Promise.all([
		loadMCPServers(ctx),
		loadSkills(ctx),
		loadHooks(ctx),
		loadTools(ctx),
		loadExtensionModules(ctx),
		loadSlashCommands(ctx),
	]);
	return { mcps, skills, hooks, tools, extensions, commands };
}

/**
 * Opt back into Claude Code convention discovery. Not called by default:
 * importing this module is side-effect free, and sessions only load the
 * conventions registered in discovery/index.ts.
 */
export function registerClaudeProviders(): void {
	registerProvider<MCPServer>(mcpCapability.id, {
		id: PROVIDER_ID,
		displayName: DISPLAY_NAME,
		description: "Load MCP servers from project .claude/mcp.json",
		priority: PRIORITY,
		load: loadMCPServers,
	});

	registerProvider<ContextFile>(contextFileCapability.id, {
		id: PROVIDER_ID,
		displayName: DISPLAY_NAME,
		description: "Load CLAUDE.md files from project .claude/ directories",
		priority: PRIORITY,
		load: loadContextFiles,
	});

	registerProvider<Skill>(skillCapability.id, {
		id: PROVIDER_ID,
		displayName: DISPLAY_NAME,
		description: "Load skills from project .claude/skills/",
		priority: PRIORITY,
		load: loadSkills,
	});

	registerProvider<ExtensionModule>(extensionModuleCapability.id, {
		id: PROVIDER_ID,
		displayName: DISPLAY_NAME,
		description: "Load extension modules from project .claude/extensions",
		priority: PRIORITY,
		load: loadExtensionModules,
	});

	registerProvider<SlashCommand>(slashCommandCapability.id, {
		id: PROVIDER_ID,
		displayName: DISPLAY_NAME,
		description: "Load slash commands from project .claude/commands/*.md",
		priority: PRIORITY,
		load: loadSlashCommands,
	});

	registerProvider<Hook>(hookCapability.id, {
		id: PROVIDER_ID,
		displayName: DISPLAY_NAME,
		description: "Load hooks from project .claude/hooks/pre/ and .claude/hooks/post/",
		priority: PRIORITY,
		load: loadHooks,
	});

	registerProvider<CustomTool>(toolCapability.id, {
		id: PROVIDER_ID,
		displayName: DISPLAY_NAME,
		description: "Load custom tools from project .claude/tools/",
		priority: PRIORITY,
		load: loadTools,
	});

	registerProvider<Settings>(settingsCapability.id, {
		id: PROVIDER_ID,
		displayName: DISPLAY_NAME,
		description: "Load settings from project .claude/settings.json",
		priority: PRIORITY,
		load: loadSettings,
	});

	registerProvider<SystemPrompt>(systemPromptCapability.id, {
		id: PROVIDER_ID,
		displayName: DISPLAY_NAME,
		description: "Load system prompt from project .claude/SYSTEM.md",
		priority: PRIORITY,
		load: loadSystemPrompts,
	});
}
