/**
 * Claude Code project/global skill layout adapter (import source).
 *
 * The `.claude/skills` layout is an explicit import source into the canonical
 * `.gjc` skill locations — it is never loaded as an ordinary runtime authority.
 * These helpers enumerate the layout for import/inspection consumers (#4291
 * import UI, #4288 provenance diagnostics) and are deliberately NOT registered
 * as capability providers: activating Claude's other surfaces (MCP servers,
 * hooks, commands, tools, prompts, settings) is owned by sibling issues.
 *
 * User-home `~/.claude/skills` is enumerated as an explicit import candidate
 * only; it is never loaded into sessions without an explicit import action.
 */
import * as path from "node:path";
import { hasFsCode, tryParseJson } from "@gajae-code/utils";
import type { ExtensionModule } from "../capability/extension-module";
import { readFile } from "../capability/fs";
import type { Hook } from "../capability/hook";
import type { MCPServer } from "../capability/mcp";
import type { Skill } from "../capability/skill";
import type { SlashCommand } from "../capability/slash-command";
import type { CustomTool } from "../capability/tool";
import type { LoadContext, LoadResult } from "../capability/types";
import {
	createSourceMeta,
	discoverExtensionModulePaths,
	expandEnvVarsDeep,
	getExtensionNameFromPath,
	loadFilesFromDir,
	scanSkillsFromDir,
} from "./helpers";

export const CLAUDE_PROVIDER_ID = "claude";
export const CLAUDE_DISPLAY_NAME = "Claude Code";
export const CLAUDE_CONFIG_DIR = ".claude";

function isMissingDirectoryError(error: unknown): boolean {
	return hasFsCode(error, "ENOENT") || hasFsCode(error, "ENOTDIR");
}

/**
 * Enumerate `.claude/skills` from every ancestor of `cwd` up to the repo root
 * (closest first) — the Claude Code project convention.
 */
export async function scanClaudeProjectSkills(ctx: LoadContext): Promise<LoadResult<Skill>> {
	const projectScans: Promise<LoadResult<Skill>>[] = [];
	let current = ctx.cwd;
	while (true) {
		projectScans.push(
			scanSkillsFromDir(ctx, {
				dir: path.join(current, CLAUDE_CONFIG_DIR, "skills"),
				providerId: CLAUDE_PROVIDER_ID,
				level: "project",
				requireDescription: true,
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

/**
 * Enumerate the user-global `~/.claude/skills` layout. This is an explicit
 * import candidate only; GJC never loads it without an explicit import action.
 */
export async function scanClaudeUserSkills(ctx: LoadContext): Promise<LoadResult<Skill>> {
	return await scanSkillsFromDir(ctx, {
		dir: path.join(ctx.home, CLAUDE_CONFIG_DIR, "skills"),
		providerId: CLAUDE_PROVIDER_ID,
		level: "user",
		requireDescription: true,
	});
}

export function claudeSkillSourceMeta(filePath: string, level: "user" | "project") {
	return createSourceMeta(CLAUDE_PROVIDER_ID, filePath, level);
}

// =============================================================================
// Provenance inspection (#4288)
//
// The scans below enumerate the remaining `.claude/` project surfaces (MCP
// servers, hooks, tools, extensions, commands) for the `gjc customize doctor`
// provenance report. They reuse the shared discovery helpers but are
// deliberately NOT registered as capability providers: none of these surfaces
// are part of the session load path, and inspection must not change runtime
// behavior.
// =============================================================================

function getProjectClaude(ctx: LoadContext): string {
	return path.join(ctx.cwd, CLAUDE_CONFIG_DIR);
}

async function inspectMCPServers(ctx: LoadContext): Promise<LoadResult<MCPServer>> {
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
				_source: createSourceMeta(CLAUDE_PROVIDER_ID, filePath, "project"),
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

async function inspectHooks(ctx: LoadContext): Promise<LoadResult<Hook>> {
	const items: Hook[] = [];
	const warnings: string[] = [];
	const projectHooksDir = path.join(getProjectClaude(ctx), "hooks");
	const hookTypes = ["pre", "post"] as const;
	const results = await Promise.all(
		hookTypes.map(hookType =>
			loadFilesFromDir<Hook>(ctx, path.join(projectHooksDir, hookType), CLAUDE_PROVIDER_ID, "project", {
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

async function inspectTools(ctx: LoadContext): Promise<LoadResult<CustomTool>> {
	const projectToolsDir = path.join(getProjectClaude(ctx), "tools");
	return await loadFilesFromDir<CustomTool>(ctx, projectToolsDir, CLAUDE_PROVIDER_ID, "project", {
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

async function inspectExtensionModules(ctx: LoadContext): Promise<LoadResult<ExtensionModule>> {
	const projectExtensionsDir = path.join(getProjectClaude(ctx), "extensions");
	const paths = await discoverExtensionModulePaths(ctx, projectExtensionsDir);
	return {
		items: paths.map(extPath => ({
			name: getExtensionNameFromPath(extPath),
			path: extPath,
			level: "project" as const,
			_source: createSourceMeta(CLAUDE_PROVIDER_ID, extPath, "project"),
		})),
		warnings: [],
	};
}

async function inspectSlashCommands(ctx: LoadContext): Promise<LoadResult<SlashCommand>> {
	const projectCommandsDir = path.join(getProjectClaude(ctx), "commands");
	return await loadFilesFromDir<SlashCommand>(ctx, projectCommandsDir, CLAUDE_PROVIDER_ID, "project", {
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
 * Reuses the shared discovery scan helpers without registering any provider,
 * so diagnostics can report the convention's files while keeping the runtime
 * load path exactly as configured (none of these surfaces are registered for
 * session loading; hooks are covered by the separate registered claude-hooks
 * provider).
 */
export async function inspectClaudeConvention(ctx: LoadContext): Promise<ClaudeConventionInspection> {
	const [mcps, skills, hooks, tools, extensions, commands] = await Promise.all([
		inspectMCPServers(ctx),
		scanClaudeProjectSkills(ctx),
		inspectHooks(ctx),
		inspectTools(ctx),
		inspectExtensionModules(ctx),
		inspectSlashCommands(ctx),
	]);
	return { mcps, skills, hooks, tools, extensions, commands };
}
