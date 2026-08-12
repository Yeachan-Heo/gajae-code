/**
 * OpenAI code provider project provider.
 *
 * Supports project-local `.OpenAI code backend/` compatibility only. User-home OpenAI code backend
 * directories are intentionally ignored so `~/.OpenAI code backend` content is never injected
 * into GJC sessions.
 */
import * as path from "node:path";
import { logger, parseFrontmatter } from "@gajae-code/utils";
import { registerProvider } from "../capability";
import type { ContextFile } from "../capability/context-file";
import { contextFileCapability } from "../capability/context-file";
import { type ExtensionModule, extensionModuleCapability } from "../capability/extension-module";
import { readFile } from "../capability/fs";
import type { Hook } from "../capability/hook";
import { hookCapability } from "../capability/hook";
import type { MCPServer } from "../capability/mcp";
import { mcpCapability } from "../capability/mcp";
import type { Prompt } from "../capability/prompt";
import { promptCapability } from "../capability/prompt";
import type { Settings } from "../capability/settings";
import { settingsCapability } from "../capability/settings";
import type { Skill } from "../capability/skill";
import { skillCapability } from "../capability/skill";
import type { SlashCommand } from "../capability/slash-command";
import { slashCommandCapability } from "../capability/slash-command";
import type { CustomTool } from "../capability/tool";
import { toolCapability } from "../capability/tool";
import type { LoadContext, LoadResult, SourceMeta } from "../capability/types";
import {
	buildExtensionModuleItems,
	createSourceMeta,
	discoverExtensionModulePaths,
	loadFilesFromDir,
	scanSkillsFromDir,
} from "./helpers";

const PROVIDER_ID = "codex";
const DISPLAY_NAME = "OpenAI Codex";
const PRIORITY = 70;

function getProjectCodexDir(ctx: LoadContext): string {
	return path.join(ctx.cwd, ".codex");
}

async function loadContextFiles(ctx: LoadContext): Promise<LoadResult<ContextFile>> {
	const items: ContextFile[] = [];
	const agentsMd = path.join(getProjectCodexDir(ctx), "AGENTS.md");
	const agentsContent = await readFile(agentsMd);
	if (agentsContent) {
		items.push({
			path: agentsMd,
			content: agentsContent,
			level: "project",
			depth: 0,
			_source: createSourceMeta(PROVIDER_ID, agentsMd, "project"),
		});
	}
	return { items, warnings: [] };
}

async function loadMCPServers(ctx: LoadContext): Promise<LoadResult<MCPServer>> {
	const warnings: string[] = [];
	const projectConfigPath = path.join(getProjectCodexDir(ctx), "config.toml");
	const projectConfig = await loadTomlConfig(projectConfigPath);
	const items: MCPServer[] = [];
	if (projectConfig) {
		const servers = extractMCPServersFromToml(projectConfig);
		for (const [name, config] of Object.entries(servers)) {
			items.push({
				name,
				...config,
				_source: createSourceMeta(PROVIDER_ID, projectConfigPath, "project"),
			});
		}
	}
	return { items, warnings };
}

async function loadTomlConfig(filePath: string): Promise<Record<string, unknown> | null> {
	const content = await readFile(filePath);
	if (!content) return null;
	try {
		return Bun.TOML.parse(content) as Record<string, unknown>;
	} catch (error) {
		logger.warn("Failed to parse TOML config", { path: filePath, error: String(error) });
		return null;
	}
}

interface CodexMCPConfig {
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	env_vars?: string[];
	url?: string;
	http_headers?: Record<string, string>;
	env_http_headers?: Record<string, string>;
	bearer_token_env_var?: string;
	cwd?: string;
	startup_timeout_sec?: number;
	tool_timeout_sec?: number;
	enabled_tools?: string[];
	disabled_tools?: string[];
}

function extractMCPServersFromToml(toml: Record<string, unknown>): Record<string, Partial<MCPServer>> {
	if (!toml.mcp_servers || typeof toml.mcp_servers !== "object") {
		return {};
	}

	const codexServers = toml.mcp_servers as Record<string, CodexMCPConfig>;
	const result: Record<string, Partial<MCPServer>> = {};
	for (const [name, config] of Object.entries(codexServers)) {
		const server: Partial<MCPServer> = {
			command: config.command,
			args: config.args,
			url: config.url,
		};

		const env: Record<string, string> = { ...config.env };
		if (config.env_vars) {
			for (const varName of config.env_vars) {
				const value = Bun.env[varName];
				if (value !== undefined) env[varName] = value;
			}
		}
		if (Object.keys(env).length > 0) server.env = env;

		const headers: Record<string, string> = { ...config.http_headers };
		if (config.env_http_headers) {
			for (const [headerName, envVarName] of Object.entries(config.env_http_headers)) {
				const value = Bun.env[envVarName];
				if (value !== undefined) headers[headerName] = value;
			}
		}
		if (config.bearer_token_env_var) {
			const token = Bun.env[config.bearer_token_env_var];
			if (token) headers.Authorization = `Bearer ${token}`;
		}
		if (Object.keys(headers).length > 0) server.headers = headers;

		if (config.url) {
			server.transport = "http";
		} else if (config.command) {
			server.transport = "stdio";
		}
		if (typeof config.tool_timeout_sec === "number" && config.tool_timeout_sec > 0) {
			server.timeout = config.tool_timeout_sec * 1000;
		}
		result[name] = server;
	}
	return result;
}

async function loadSkills(ctx: LoadContext): Promise<LoadResult<Skill>> {
	return await scanSkillsFromDir(ctx, {
		dir: path.join(getProjectCodexDir(ctx), "skills"),
		providerId: PROVIDER_ID,
		level: "project",
	});
}

async function loadExtensionModules(ctx: LoadContext): Promise<LoadResult<ExtensionModule>> {
	const projectExtensionsDir = path.join(getProjectCodexDir(ctx), "extensions");
	const projectPaths = await discoverExtensionModulePaths(ctx, projectExtensionsDir);
	return { items: buildExtensionModuleItems(PROVIDER_ID, [], projectPaths), warnings: [] };
}

async function loadSlashCommands(ctx: LoadContext): Promise<LoadResult<SlashCommand>> {
	const projectCommandsDir = path.join(getProjectCodexDir(ctx), "commands");
	const transformCommand = (name: string, content: string, filePath: string, source: SourceMeta) => {
		const { frontmatter, body } = parseFrontmatter(content, { source: filePath });
		const commandName = frontmatter.name || name.replace(/\.md$/, "");
		return {
			name: String(commandName),
			path: filePath,
			content: body,
			level: "project" as const,
			_source: source,
		};
	};
	return await loadFilesFromDir(ctx, projectCommandsDir, PROVIDER_ID, "project", {
		extensions: ["md"],
		transform: transformCommand,
	});
}

async function loadPrompts(ctx: LoadContext): Promise<LoadResult<Prompt>> {
	const projectPromptsDir = path.join(getProjectCodexDir(ctx), "prompts");
	const transformPrompt = (name: string, content: string, filePath: string, source: SourceMeta) => {
		const { frontmatter, body } = parseFrontmatter(content, { source: filePath });
		const promptName = frontmatter.name || name.replace(/\.md$/, "");
		return {
			name: String(promptName),
			path: filePath,
			content: body,
			description: frontmatter.description ? String(frontmatter.description) : undefined,
			_source: source,
		};
	};
	return await loadFilesFromDir(ctx, projectPromptsDir, PROVIDER_ID, "project", {
		extensions: ["md"],
		transform: transformPrompt,
	});
}

async function loadHooks(ctx: LoadContext): Promise<LoadResult<Hook>> {
	const projectHooksDir = path.join(getProjectCodexDir(ctx), "hooks");
	const transformHook = (name: string, _content: string, filePath: string, source: SourceMeta) => {
		const baseName = name.replace(/\.(ts|js)$/, "");
		const match = baseName.match(/^(pre|post)-(.+)$/);
		const hookType = (match?.[1] as "pre" | "post") || "pre";
		return {
			name,
			path: filePath,
			type: hookType,
			tool: match?.[2] || baseName,
			level: "project" as const,
			_source: source,
		};
	};
	return await loadFilesFromDir(ctx, projectHooksDir, PROVIDER_ID, "project", {
		extensions: ["ts", "js"],
		transform: transformHook,
	});
}

async function loadTools(ctx: LoadContext): Promise<LoadResult<CustomTool>> {
	const projectToolsDir = path.join(getProjectCodexDir(ctx), "tools");
	const transformTool = (name: string, _content: string, filePath: string, source: SourceMeta) =>
		({
			name: name.replace(/\.(ts|js)$/, ""),
			path: filePath,
			level: "project" as const,
			_source: source,
		}) as CustomTool;
	return await loadFilesFromDir(ctx, projectToolsDir, PROVIDER_ID, "project", {
		extensions: ["ts", "js"],
		transform: transformTool,
	});
}

async function loadSettings(ctx: LoadContext): Promise<LoadResult<Settings>> {
	const projectConfigPath = path.join(getProjectCodexDir(ctx), "config.toml");
	const projectConfig = await loadTomlConfig(projectConfigPath);
	return {
		items: projectConfig
			? [
					{
						...projectConfig,
						_source: createSourceMeta(PROVIDER_ID, projectConfigPath, "project"),
					} as Settings,
				]
			: [],
		warnings: [],
	};
}

export interface CodexConventionInspection {
	mcps: LoadResult<MCPServer>;
	skills: LoadResult<Skill>;
	hooks: LoadResult<Hook>;
	tools: LoadResult<CustomTool>;
	extensions: LoadResult<ExtensionModule>;
	commands: LoadResult<SlashCommand>;
}

/**
 * Inspect what the Codex project convention (.codex/) would surface.
 *
 * Reuses the canonical provider load functions without registering the provider,
 * so diagnostics can report the convention's files while keeping the runtime
 * load path exactly as configured (this provider is not registered by default).
 */
export async function inspectCodexConvention(ctx: LoadContext): Promise<CodexConventionInspection> {
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
 * Opt back into Codex convention discovery. Not called by default: importing
 * this module is side-effect free, and sessions only load the conventions
 * registered in discovery/index.ts.
 */
export function registerCodexProviders(): void {
	registerProvider<ContextFile>(contextFileCapability.id, {
		id: PROVIDER_ID,
		displayName: DISPLAY_NAME,
		description: "Load context files from project .codex/AGENTS.md",
		priority: PRIORITY,
		load: loadContextFiles,
	});

	registerProvider<MCPServer>(mcpCapability.id, {
		id: PROVIDER_ID,
		displayName: DISPLAY_NAME,
		description: "Load MCP servers from project .codex/config.toml [mcp_servers.*] sections",
		priority: PRIORITY,
		load: loadMCPServers,
	});

	registerProvider<Skill>(skillCapability.id, {
		id: PROVIDER_ID,
		displayName: DISPLAY_NAME,
		description: "Load skills from project .codex/skills/",
		priority: PRIORITY,
		load: loadSkills,
	});

	registerProvider<ExtensionModule>(extensionModuleCapability.id, {
		id: PROVIDER_ID,
		displayName: DISPLAY_NAME,
		description: "Load extension modules from project .codex/extensions/",
		priority: PRIORITY,
		load: loadExtensionModules,
	});

	registerProvider<SlashCommand>(slashCommandCapability.id, {
		id: PROVIDER_ID,
		displayName: DISPLAY_NAME,
		description: "Load slash commands from project .codex/commands/",
		priority: PRIORITY,
		load: loadSlashCommands,
	});

	registerProvider<Prompt>(promptCapability.id, {
		id: PROVIDER_ID,
		displayName: DISPLAY_NAME,
		description: "Load prompts from project .codex/prompts/",
		priority: PRIORITY,
		load: loadPrompts,
	});

	registerProvider<Hook>(hookCapability.id, {
		id: PROVIDER_ID,
		displayName: DISPLAY_NAME,
		description: "Load hooks from project .codex/hooks/",
		priority: PRIORITY,
		load: loadHooks,
	});

	registerProvider<CustomTool>(toolCapability.id, {
		id: PROVIDER_ID,
		displayName: DISPLAY_NAME,
		description: "Load custom tools from project .codex/tools/",
		priority: PRIORITY,
		load: loadTools,
	});

	registerProvider<Settings>(settingsCapability.id, {
		id: PROVIDER_ID,
		displayName: DISPLAY_NAME,
		description: "Load settings from project .codex/config.toml",
		priority: PRIORITY,
		load: loadSettings,
	});
}
