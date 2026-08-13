/**
 * OpenAI Codex project/global skill layout adapter (import source).
 *
 * The `.codex/skills` layout is an explicit import source into the canonical
 * `.gjc` skill locations — it is never loaded as an ordinary runtime authority.
 * These helpers enumerate the layout for import/inspection consumers (#4291
 * import UI, #4288 provenance diagnostics) and are deliberately NOT registered
 * as capability providers: activating Codex's other surfaces (MCP servers,
 * hooks, commands, tools, prompts, settings) is owned by sibling issues.
 *
 * User-home `~/.codex/skills` is enumerated as an explicit import candidate
 * only; it is never loaded into sessions without an explicit import action.
 */
import * as path from "node:path";
import { logger, parseFrontmatter } from "@gajae-code/utils";
import type { ExtensionModule } from "../capability/extension-module";
import { readFile } from "../capability/fs";
import type { Hook } from "../capability/hook";
import type { MCPServer } from "../capability/mcp";
import type { Skill } from "../capability/skill";
import type { SlashCommand } from "../capability/slash-command";
import type { CustomTool } from "../capability/tool";
import type { LoadContext, LoadResult, SourceMeta } from "../capability/types";
import {
	buildExtensionModuleItems,
	createSourceMeta,
	discoverExtensionModulePaths,
	loadFilesFromDir,
	scanSkillsFromDir,
} from "./helpers";

export const CODEX_PROVIDER_ID = "codex";
export const CODEX_DISPLAY_NAME = "OpenAI Codex";
export const CODEX_CONFIG_DIR = ".codex";

/**
 * Enumerate the project-local `.codex/skills` layout (cwd only), mirroring the
 * OpenAI Codex project convention.
 */
export async function scanCodexProjectSkills(ctx: LoadContext): Promise<LoadResult<Skill>> {
	return await scanSkillsFromDir(ctx, {
		dir: path.join(ctx.cwd, CODEX_CONFIG_DIR, "skills"),
		providerId: CODEX_PROVIDER_ID,
		level: "project",
		requireDescription: true,
	});
}

/**
 * Enumerate the user-global `~/.codex/skills` layout. This is an explicit
 * import candidate only; GJC never loads it without an explicit import action.
 */
export async function scanCodexUserSkills(ctx: LoadContext): Promise<LoadResult<Skill>> {
	return await scanSkillsFromDir(ctx, {
		dir: path.join(ctx.home, CODEX_CONFIG_DIR, "skills"),
		providerId: CODEX_PROVIDER_ID,
		level: "user",
		requireDescription: true,
	});
}

export function codexSkillSourceMeta(filePath: string, level: "user" | "project") {
	return createSourceMeta(CODEX_PROVIDER_ID, filePath, level);
}

// =============================================================================
// Provenance inspection (#4288)
//
// The scans below enumerate the remaining `.codex/` project surfaces (MCP
// servers, hooks, tools, extensions, commands) for the `gjc customize doctor`
// provenance report. They reuse the shared discovery helpers but are
// deliberately NOT registered as capability providers: none of these surfaces
// are part of the session load path, and inspection must not change runtime
// behavior.
// =============================================================================

function getProjectCodexDir(ctx: LoadContext): string {
	return path.join(ctx.cwd, CODEX_CONFIG_DIR);
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

async function inspectMCPServers(ctx: LoadContext): Promise<LoadResult<MCPServer>> {
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
				_source: createSourceMeta(CODEX_PROVIDER_ID, projectConfigPath, "project"),
			});
		}
	}
	return { items, warnings };
}

async function inspectHooks(ctx: LoadContext): Promise<LoadResult<Hook>> {
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
	return await loadFilesFromDir(ctx, projectHooksDir, CODEX_PROVIDER_ID, "project", {
		extensions: ["ts", "js"],
		transform: transformHook,
	});
}

async function inspectTools(ctx: LoadContext): Promise<LoadResult<CustomTool>> {
	const projectToolsDir = path.join(getProjectCodexDir(ctx), "tools");
	const transformTool = (name: string, _content: string, filePath: string, source: SourceMeta) =>
		({
			name: name.replace(/\.(ts|js)$/, ""),
			path: filePath,
			level: "project" as const,
			_source: source,
		}) as CustomTool;
	return await loadFilesFromDir(ctx, projectToolsDir, CODEX_PROVIDER_ID, "project", {
		extensions: ["ts", "js"],
		transform: transformTool,
	});
}

async function inspectExtensionModules(ctx: LoadContext): Promise<LoadResult<ExtensionModule>> {
	const projectExtensionsDir = path.join(getProjectCodexDir(ctx), "extensions");
	const projectPaths = await discoverExtensionModulePaths(ctx, projectExtensionsDir);
	return { items: buildExtensionModuleItems(CODEX_PROVIDER_ID, [], projectPaths), warnings: [] };
}

async function inspectSlashCommands(ctx: LoadContext): Promise<LoadResult<SlashCommand>> {
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
	return await loadFilesFromDir(ctx, projectCommandsDir, CODEX_PROVIDER_ID, "project", {
		extensions: ["md"],
		transform: transformCommand,
	});
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
 * Reuses the shared discovery scan helpers without registering any provider,
 * so diagnostics can report the convention's files while keeping the runtime
 * load path exactly as configured (none of these surfaces are registered for
 * session loading; hooks are covered by the separate registered codex-hooks
 * provider).
 */
export async function inspectCodexConvention(ctx: LoadContext): Promise<CodexConventionInspection> {
	const [mcps, skills, hooks, tools, extensions, commands] = await Promise.all([
		inspectMCPServers(ctx),
		scanCodexProjectSkills(ctx),
		inspectHooks(ctx),
		inspectTools(ctx),
		inspectExtensionModules(ctx),
		inspectSlashCommands(ctx),
	]);
	return { mcps, skills, hooks, tools, extensions, commands };
}
